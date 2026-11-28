import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendWishDraftImages,
  clearBotStore,
  clearWishDraftImages,
  confirmOptimisticWishFeed,
  getLiveBotSnapshot,
  getWishDraftImages,
  isFeedItemNeedsAttention,
  optimisticAddWishFeed,
  optimisticExecuteFeedAction,
  optimisticManageNativeSchedule,
  optimisticSnoozeFeed,
  removeWishDraftImage,
  rollbackOptimisticWishFeed,
  setLiveBotSnapshot,
} from "../client/store.ts";
import {
  MAX_ATTACHED_IMAGES,
  executeFeedActionRpc,
  submitWishRpc,
} from "../shared/contracts.ts";
import {
  applyApprovalResolutionMutation,
  applyFeedCurationMutation,
  cleanTaskTitle,
  computeRoutineSuggestions,
  draftMissionFromIntent,
  extractDailyTime,
  extractIntervalSec,
  extractSuggestedActionsFromMarkdown,
  formatImageSummaryTag,
  hasDirectSessionReferenceHint,
  inferWorkspaceAndWatchPath,
  normalizeAgentImages,
  resolveWishSubmissionContent,
  routeDirectWishToSession,
  routeFollowUpCandidate,
  splitReplyIntoPreviewAndDetails,
  type RoutableAgentCandidate,
} from "../server/intent.ts";
import {
  parseInvalidModeError,
  pickCompatibleModeId,
} from "../server/launch-mode.ts";
import {
  BotStateStore,
  computeNormalizedHash,
  expandHomePath,
  shouldIgnoreWatchPath,
} from "../server/storage.ts";
import {
  buildNativeSchedulePromptWithGovernance,
  extractSimpleDailyTimeFromCron,
  parseNativeScheduleRecord,
  readNativeSchedulesFromDisk,
  resolveScheduleCadenceArgs,
} from "../server/schedules.ts";
import {
  extractTidyPlanIdFromPrompt,
  inferSessionCategory,
  needsSessionAutoRename,
  normalizeSessionTitleFast,
  parseApprovedItemKeysFromMarkdown,
  renderTidyPlanMarkdown,
  scoreSessionTopicSimilarity,
  type SessionTidyPlan,
} from "../server/tidy.ts";

test("computeNormalizedHash ignores line-ending and trailing-space noise", () => {
  const h1 = computeNormalizedHash("line1  \r\nline2\n\n");
  const h2 = computeNormalizedHash("line1\nline2");
  const h3 = computeNormalizedHash("line1\nline3");
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test("expandHomePath expands tilde prefixes cleanly", () => {
  assert.equal(expandHomePath("~"), os.homedir());
  assert.equal(
    expandHomePath("~/Documents/KnowledgeBase"),
    path.join(os.homedir(), "Documents", "KnowledgeBase"),
  );
  assert.equal(expandHomePath("/tmp/demo"), "/tmp/demo");
});

test("shouldIgnoreWatchPath filters git, obsidian, node_modules, and temp swap files", () => {
  assert.equal(shouldIgnoreWatchPath(".git/HEAD"), true);
  assert.equal(shouldIgnoreWatchPath(".obsidian/workspace.json"), true);
  assert.equal(shouldIgnoreWatchPath("node_modules/pkg/index.js"), true);
  assert.equal(shouldIgnoreWatchPath("00-Inbox/.#draft.md"), true);
  assert.equal(shouldIgnoreWatchPath("00-Inbox/note.md.tmp"), true);
  assert.equal(shouldIgnoreWatchPath("00-Inbox/idea.md"), false);
  assert.equal(shouldIgnoreWatchPath("00-Inbox/secret-draft.md", ["secret"]), true);
});

test("BotStateStore persists state atomically, guards self-writes, and appends memory notes", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-bot-test-"));
  try {
    const store = new BotStateStore(tmpDir);
    await store.mutate((draft) => {
      draft.chiefAgentId = "agt_123";
      draft.wakeTimestamps.push(Date.now());
    });

    const reloaded = new BotStateStore(tmpDir);
    const loaded = await reloaded.load();
    assert.equal(loaded.chiefAgentId, "agt_123");
    assert.equal(reloaded.countRecentWakes(), 1);

    const memFile = path.join(tmpDir, "MEMORY.md");
    await store.writeMemory(memFile, "---\nupdated: 2026-01-01\n---\n\n# Memory\n- Hello");
    assert.equal(store.isSelfWritten(memFile), true);
    await store.appendMemoryNote(memFile, "低于 $50 的账单不用提醒");
    const content = await store.readMemory(memFile);
    assert.match(content, /低于 \$50 的账单不用提醒/);
    assert.doesNotMatch(content, /updated: 2026-01-01/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("draftMissionFromIntent parses natural Chinese schedules, file watches, URLs, and confirmation modes", () => {
  const defaultCwd = "~/Documents/KnowledgeBase";

  assert.equal(extractDailyTime("每天早上8点半汇总收件箱"), "08:30");
  assert.equal(extractDailyTime("每天晚上 9:15 检查日志"), "21:15");
  assert.equal(extractIntervalSec("每 15 分钟检查一次"), 900);

  const scheduleDraft = draftMissionFromIntent(
    "每天早上 09:00 检查 OrderHub 待办异常并发送邮件提醒",
    defaultCwd,
  );
  assert.equal(scheduleDraft.kind, "schedule");
  assert.equal(scheduleDraft.dailyTime, "09:00");
  assert.equal(scheduleDraft.governance, "require_approval");
  assert.match(scheduleDraft.cwd ?? "", /OrderHub$/);

  const watchDraft = draftMissionFromIntent(
    "监听 00-Inbox 有新笔记就自动整理进 Wiki",
    defaultCwd,
  );
  assert.equal(watchDraft.kind, "file_watch");
  assert.equal(watchDraft.governance, "autonomous");
  assert.match(watchDraft.watchPath ?? "", /00-Inbox$/);

  const pollDraft = draftMissionFromIntent(
    "每 10 分钟检查 https://status.example.com/health 是否正常",
    defaultCwd,
  );
  assert.equal(pollDraft.kind, "poll_command");
  assert.equal(pollDraft.pollCommand, "https://status.example.com/health");
  assert.equal(pollDraft.pollIntervalSec, 600);
});

test("computeRoutineSuggestions surfaces rule suggestions for repeated workspace activity", () => {
  const homeCwd = "~/Documents/KnowledgeBase";
  const demoProject = path.join(os.homedir(), "Documents", "DemoService");
  const nowIso = new Date().toISOString();
  const suggestions = computeRoutineSuggestions(
    {
      chiefAgentId: null,
      chiefWorkspaceId: null,
      runtimePaused: null,
      wakeTimestamps: [],
      dismissedSuggestionIds: [],
      triggers: [],
      feed: [],
      approvals: [],
      workers: [
        {
          id: "w1",
          agentId: "a1",
          title: "检查接口日志",
          cwd: demoProject,
          provider: "antigravity/gemini-4-neon",
          isolation: "local",
          status: "completed",
          goal: "check logs",
          notifyChiefOnFinish: true,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        {
          id: "w2",
          agentId: "a2",
          title: "核对异常请求",
          cwd: demoProject,
          provider: "antigravity/gemini-4-neon",
          isolation: "local",
          status: "completed",
          goal: "verify requests",
          notifyChiefOnFinish: true,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
    },
    homeCwd,
  );

  assert.equal(suggestions.length, 1);
  assert.match(suggestions[0].title, /DemoService/);
});

test("Feed filter feedback and approval auto-run promotion update persisted state cleanly", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-curation-test-"));
  try {
    const store = new BotStateStore(tmpDir);
    const nowIso = new Date().toISOString();

    await store.mutate((draft) => {
      draft.triggers.push({
        id: "trg_1",
        name: "账单检查",
        description: "",
        kind: "schedule",
        enabled: true,
        governance: "require_approval",
        executionTarget: "scout_helper",
        cwd: tmpDir,
        prompt: "检查每日账单",
        ignorePatterns: [],
        debounceMs: 4000,
        pollIntervalSec: 3600,
        dailyTime: "08:30",
        cooldownSec: 60,
        createdAt: nowIso,
        updatedAt: nowIso,
        runCount: 1,
        silentCount: 0,
        notifyCount: 1,
        approvedCount: 0,
        noiseRules: [],
      });
      draft.feed.push({
        id: "feed_1",
        createdAt: nowIso,
        level: "notify",
        title: "小额订阅扣款 $4.99",
        summary: "iCloud 扣费 $4.99",
        actions: [],
        inProgress: false,
        triggerId: "trg_1",
        triggerName: "账单检查",
        unread: true,
      });
      draft.approvals.push({
        id: "apr_1",
        createdAt: nowIso,
        status: "pending",
        title: "发送月度对账单邮件",
        actionSummary: "向财务邮箱发送对账单",
        payloadPreview: "To: finance@example.com\nSubject: 月度对账",
        riskLevel: "medium",
        followUpPrompt: "Send draft v1",
        cwd: tmpDir,
        triggerId: "trg_1",
        triggerName: "账单检查",
      });
    });

    await store.mutate((draft) => {
      const c = applyFeedCurationMutation(draft, {
        feedId: "feed_1",
        feedback: "down",
        ruleNote: "低于 $50 的固定订阅不用提醒",
      });
      assert.equal(c.updatedTriggerName, "账单检查");

      const r = applyApprovalResolutionMutation(draft, {
        id: "apr_1",
        decision: "approved",
        editedFollowUpPrompt: "Send draft v2 (edited)",
        promoteTrust: true,
      });
      assert.equal(r.promotedTriggerName, "账单检查");
    });

    const reloaded = await new BotStateStore(tmpDir).load();
    assert.equal(reloaded.feed[0].feedback, "down");
    assert.equal(reloaded.feed[0].unread, false);
    assert.deepEqual(reloaded.triggers[0].noiseRules, ["低于 $50 的固定订阅不用提醒"]);
    assert.equal(reloaded.triggers[0].governance, "notify");
    assert.equal(reloaded.triggers[0].approvedCount, 1);
    assert.equal(reloaded.approvals[0].followUpPrompt, "Send draft v2 (edited)");
    assert.equal(reloaded.approvals[0].promotedTrust, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("splitReplyIntoPreviewAndDetails preserves full long reports while extracting clean preview", () => {
  const short = "一切正常，共检查 3 个目录，无待办。";
  const shortRes = splitReplyIntoPreviewAndDetails(short);
  assert.equal(shortRes.summary, short);
  assert.equal(shortRes.details, undefined);

  const longReport = [
    "### 今日总览",
    "1. 第一项重点结论说明",
    "2. 第二项重点结论说明",
    "3. 第三项重点结论说明",
    "4. 第四项重点结论说明",
    "5. 第五项重点结论说明",
    "6. 第六项重点结论说明",
    ...Array.from({ length: 40 }, (_, i) => `- 详细附录条目 #${i + 1}：完整保留不被 1200 字截断`),
  ].join("\n");

  const longRes = splitReplyIntoPreviewAndDetails(longReport);
  assert.ok(longRes.details);
  assert.equal(longRes.details, longReport);
  assert.ok(longRes.summary.length < longReport.length);
  assert.ok(longRes.details.startsWith(longRes.summary));
});

test("cleanTaskTitle strips redundant nested prefixes and extractSuggestedActionsFromMarkdown builds buttons", () => {
  assert.equal(
    cleanTaskTitle("子任务已完成：任务 · 检查当前所有工作区进度"),
    "检查当前所有工作区进度",
  );

  const report = [
    "### 待处理事项",
    "1. **完成 Google 人机验证（需手动点击）**",
    "2. **核对今日 4 笔限购订单记录**",
    "3. **确认是否给 `voice-clean` 增加实时语音自动切快模型功能**",
  ].join("\n");

  const actions = extractSuggestedActionsFromMarkdown(report);
  assert.equal(actions.length, 2);
  assert.match(actions[0].label, /核对今日 4 笔限购订单记录/);
  assert.match(actions[1].prompt ?? "", /voice-clean/);

  // Completed / retrospective summaries must NOT generate bogus follow-up buttons
  const completedSummary = [
    "### 已完成的 6 项界面合并与减负明细",
    "1. **单张动态卡片（11+ 个按钮 → 2～3 个）**",
    "5. **待确认审批卡（防误触单确认按钮）**",
    "   - [BotConsoleScreen.tsx](file:///Users/shinelin/Documents/paseo/paseo-bot/client/BotConsoleScreen.tsx)",
    "- **已归档 10 个碎片工作区**",
    "- **6 个未置顶工作区归档记录**",
  ].join("\n");
  assert.equal(extractSuggestedActionsFromMarkdown(completedSummary).length, 0);
});

test("routeFollowUpCandidate routes multi-session summary follow-ups to the matching source session", () => {
  const candidates: RoutableAgentCandidate[] = [
    {
      id: "211b31ae-b40f-4833-a2d4-256cbf2953ab",
      title: "检查当前所有工作区进度",
      cwd: "/tmp/KnowledgeBase",
      workspaceId: "wks_kb",
      workspaceTitle: "KnowledgeBase",
      updatedAtMs: 1000,
    },
    {
      id: "529a6b80-1111-2222-3333-444444444444",
      title: "启动账号日常任务",
      cwd: "/tmp/DemoWarmup",
      workspaceId: "wks_warmup",
      workspaceTitle: "启动测试账号日常流程",
      updatedAtMs: 2000,
    },
    {
      id: "787df7e4-aaaa-bbbb-cccc-dddddddddddd",
      title: "修复插件麦克风延迟",
      cwd: "/tmp/plugins/voice-clean",
      workspaceId: "wks_voice",
      workspaceTitle: "排查软件语音转文字失败问题",
      updatedAtMs: 3000,
    },
  ];

  const multiSessionCard = [
    "已排查全部工作区，目前待确认事项如下：",
    "",
    "1. **完成测试账号登录流程**",
    "   - 来源：工作区「启动测试账号日常流程」➔ 子会话 `529a6b8`",
    "",
    "2. **确认是否给 `voice-clean` 增加实时语音自动切快模型功能**",
    "   - 来源：工作区「排查软件语音转文字失败问题」（会话 `787df7e`）",
  ].join("\n");

  // 1. Follow-up about voice-clean routes to 787df7e4-... (and extracted action also carries targetAgentId)
  const actions = extractSuggestedActionsFromMarkdown(multiSessionCard);
  const voiceAction = actions.find((a) => a.prompt?.includes("voice-clean"));
  assert.equal(voiceAction?.targetAgentId, "787df7e");

  const routeVoice = routeFollowUpCandidate({
    followUpPrompt: "确认给 voice-clean 增加实时语音自动切快模型功能",
    cardMarkdown: multiSessionCard,
    fallbackAgentId: "211b31ae-b40f-4833-a2d4-256cbf2953ab",
    candidates,
  });
  assert.equal(routeVoice?.agentId, "787df7e4-aaaa-bbbb-cccc-dddddddddddd");
  assert.equal(routeVoice?.routedAwayFromOrigin, true);

  // 2. Follow-up even without hex ID in card still routes via workspace title & project slug
  const cardWithoutIds = [
    "1. **检查测试账号登录状态** — 来源：工作区「启动测试账号日常流程」",
    "2. **给语音插件加上快模型切换** — 来源：工作区「排查软件语音转文字失败问题」",
  ].join("\n");
  const routeByWorkspace = routeFollowUpCandidate({
    followUpPrompt: "语音转文字那个插件直接按方案改吧",
    cardMarkdown: cardWithoutIds,
    fallbackAgentId: "211b31ae-b40f-4833-a2d4-256cbf2953ab",
    candidates,
  });
  assert.equal(routeByWorkspace?.agentId, "787df7e4-aaaa-bbbb-cccc-dddddddddddd");
  assert.equal(routeByWorkspace?.routedAwayFromOrigin, true);

  // 3. Generic meta follow-up about the summary itself stays safely on fallbackAgentId
  const routeGeneric = routeFollowUpCandidate({
    followUpPrompt: "把上面这几条按优先级重新排个表格",
    cardMarkdown: multiSessionCard,
    fallbackAgentId: "211b31ae-b40f-4833-a2d4-256cbf2953ab",
    candidates,
  });
  assert.equal(routeGeneric?.agentId, "211b31ae-b40f-4833-a2d4-256cbf2953ab");
  assert.equal(routeGeneric?.routedAwayFromOrigin, false);
});

test("routeDirectWishToSession locates explicitly referenced sessions and leaves fresh wishes untouched", () => {
  const candidates: RoutableAgentCandidate[] = [
    {
      id: "787df7e4-aaaa-bbbb-cccc-dddddddddddd",
      title: "修复插件麦克风延迟",
      cwd: "/tmp/plugins/voice-clean",
      workspaceId: "wks_voice",
      workspaceTitle: "排查软件语音转文字失败问题",
      updatedAtMs: 3000,
    },
    {
      id: "529a6b80-1111-2222-3333-444444444444",
      title: "启动账号日常任务",
      cwd: "/tmp/DemoWarmup",
      workspaceId: "wks_warmup",
      workspaceTitle: "启动测试账号日常流程",
      updatedAtMs: 2000,
    },
  ];

  // 1. Explicit session prefix routes to existing session (so its original model is preserved)
  const byId = routeDirectWishToSession({
    wish: "继续在会话 787df7e 里把测试补完",
    candidates,
  });
  assert.equal(byId?.agentId, "787df7e4-aaaa-bbbb-cccc-dddddddddddd");

  // 2. Explicit quoted workspace title routes to existing session
  const byWorkspace = routeDirectWishToSession({
    wish: "帮我在工作区「启动测试账号日常流程」继续检查一下状态",
    candidates,
  });
  assert.equal(byWorkspace?.agentId, "529a6b80-1111-2222-3333-444444444444");

  // 3. Fresh general wish returns null so it spawns a new session with the console-selected model
  const fresh = routeDirectWishToSession({
    wish: "帮我整理今天知识库 00-Inbox 里的新草稿并生成总结",
    candidates,
  });
  assert.equal(fresh, null);
});

test("inferWorkspaceAndWatchPath matches paseo-bot, known workspaces, and MEMORY.md workspace map", () => {
  const defaultCwd = "~/Documents/KnowledgeBase";
  const known = [
    { cwd: "/Users/demo/Documents/KnowledgeBase", label: "KnowledgeBase" },
    { cwd: "/Users/demo/Documents/MoneyPrinter", label: "MoneyPrinter" },
    { cwd: "/Users/demo/Documents/paseo/paseo-bot", label: "paseo-bot" },
  ];
  const memoryMap = [
    "## 2. 常用工作区地图",
    "- **个人知识库**：`/Users/demo/Documents/KnowledgeBase`",
    "- **Amazon / 业务自动化**：`/Users/demo/Documents/MoneyPrinter`",
    "- **Paseo 插件源码**：`/Users/demo/Documents/paseo/paseo-bot`",
  ].join("\n");

  const bySpacedName = inferWorkspaceAndWatchPath(
    "帮我优化一下 paseo bot 的交互与性能",
    defaultCwd,
    known,
    memoryMap,
  );
  assert.equal(bySpacedName.cwd, "/Users/demo/Documents/paseo/paseo-bot");

  const byProjectName = inferWorkspaceAndWatchPath(
    "检查 MoneyPrinter 今日未报单记录",
    defaultCwd,
    known,
    memoryMap,
  );
  assert.equal(byProjectName.cwd, "/Users/demo/Documents/MoneyPrinter");

  const byMemoryKeyword = inferWorkspaceAndWatchPath(
    "帮我核对一下今天 Amazon 订单发货和报单情况",
    defaultCwd,
    [],
    memoryMap,
  );
  assert.equal(byMemoryKeyword.cwd, "/Users/demo/Documents/MoneyPrinter");

  const byMemoryChineseLabel = inferWorkspaceAndWatchPath(
    "看一下 Paseo 插件源码 里的菜单按钮",
    defaultCwd,
    [],
    memoryMap,
  );
  assert.equal(byMemoryChineseLabel.cwd, "/Users/demo/Documents/paseo/paseo-bot");
});

test("applyApprovalResolutionMutation marks linked Inbox approval feed card read and resolved", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-apr-sync-"));
  try {
    const store = new BotStateStore(tmpDir);
    const nowIso = new Date().toISOString();
    await store.mutate((draft) => {
      draft.approvals.push({
        id: "apr_sync_1",
        createdAt: nowIso,
        status: "pending",
        title: "回复客户确认邮件",
        actionSummary: "发送确认邮件给 client@example.com",
        riskLevel: "medium",
        followUpPrompt: "Send mail",
        cwd: tmpDir,
      });
      draft.feed.push({
        id: "feed_apr_1",
        createdAt: nowIso,
        level: "approval_required",
        title: "待确认：回复客户确认邮件",
        summary: "发送确认邮件给 client@example.com",
        approvalId: "apr_sync_1",
        actions: [],
        inProgress: false,
        unread: true,
      });
    });

    await store.mutate((draft) => {
      applyApprovalResolutionMutation(draft, {
        id: "apr_sync_1",
        decision: "approved",
      });
    });

    const state = store.get();
    assert.equal(state.feed[0].unread, false);
    assert.equal(state.feed[0].level, "notify");
    assert.equal(state.feed[0].title, "已确认：回复客户确认邮件");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("BotStateStore auto-prunes stale completed self_wake triggers beyond retention window", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-prune-test-"));
  try {
    const store = new BotStateStore(tmpDir);
    const oldIso = new Date(Date.now() - 48 * 3600_000).toISOString();
    const nowIso = new Date().toISOString();

    await store.mutate((draft) => {
      draft.triggers.push({
        id: "trg_perm",
        name: "每日汇总",
        description: "",
        kind: "schedule",
        enabled: true,
        governance: "notify",
        executionTarget: "scout_helper",
        cwd: tmpDir,
        prompt: "Summary",
        ignorePatterns: [],
        debounceMs: 4000,
        pollIntervalSec: 3600,
        cooldownSec: 60,
        createdAt: nowIso,
        updatedAt: nowIso,
        runCount: 5,
        silentCount: 0,
        notifyCount: 5,
        approvedCount: 0,
        noiseRules: [],
      });
      for (let i = 0; i < 15; i += 1) {
        draft.triggers.push({
          id: `trg_sw_${i}`,
          name: `稍后提醒 ${i}`,
          description: "",
          kind: "self_wake",
          enabled: false,
          governance: "notify",
          executionTarget: "scout_helper",
          cwd: tmpDir,
          prompt: "Wake",
          ignorePatterns: [],
          debounceMs: 4000,
          pollIntervalSec: 300,
          cooldownSec: 0,
          createdAt: oldIso,
          updatedAt: oldIso,
          lastTriggeredAt: oldIso,
          runCount: 1,
          silentCount: 0,
          notifyCount: 1,
          approvedCount: 0,
          noiseRules: [],
        });
      }
    });

    const state = store.get();
    assert.equal(state.triggers.length, 1);
    assert.equal(state.triggers[0].id, "trg_perm");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("hasDirectSessionReferenceHint quickly detects explicit session/workspace references and skips normal wishes", () => {
  // Positive cases
  assert.equal(hasDirectSessionReferenceHint("继续在会话 787df7e 里把测试补完"), true);
  assert.equal(hasDirectSessionReferenceHint("查看子会话 `529a6b8` 的进度"), true);
  assert.equal(hasDirectSessionReferenceHint("打开 conversation://787df7e4-aaaa-bbbb 继续"), true);
  assert.equal(
    hasDirectSessionReferenceHint("检查 787df7e4-aaaa-bbbb-cccc-dddddddddddd 的输出"),
    true,
  );
  assert.equal(hasDirectSessionReferenceHint("在 session abc1234 中继续"), true);
  assert.equal(hasDirectSessionReferenceHint("帮我在工作区「启动测试账号日常流程」继续检查"), true);
  assert.equal(hasDirectSessionReferenceHint('Continue in workspace "voice-clean"'), true);

  // Negative cases (normal wishes should skip agents.list + workspaces.list)
  assert.equal(hasDirectSessionReferenceHint(""), false);
  assert.equal(hasDirectSessionReferenceHint("帮我整理今天知识库 00-Inbox 里的新草稿并生成总结"), false);
  assert.equal(hasDirectSessionReferenceHint("检查 MoneyPrinter 今日未报单记录"), false);
  assert.equal(hasDirectSessionReferenceHint("检查当前所有工作区与近期后台子任务的最新进度"), false);
  assert.equal(hasDirectSessionReferenceHint("工作区「   」"), false);
});

test("optimistic wish feed lifecycle preserves card across intermediate snapshots, deduplicates on server confirmation, and rolls back cleanly", () => {
  clearBotStore();
  try {
    const baseSnapshot = {
      ...getLiveBotSnapshot(),
      feed: [
        {
          id: "feed_old_1",
          createdAt: "2026-11-26T10:00:00.000Z",
          level: "notify" as const,
          title: "历史汇报",
          summary: "旧内容",
          actions: [],
          inProgress: false,
          unread: false,
        },
      ],
    };
    setLiveBotSnapshot(baseSnapshot);
    const oldCardRef = getLiveBotSnapshot().feed[0];

    // 1. Optimistic insert appears immediately at top of feed
    const optId = optimisticAddWishFeed("帮我检查今天所有未完成的待办事项");
    assert.equal(getLiveBotSnapshot().feed.length, 2);
    assert.equal(getLiveBotSnapshot().feed[0].id, optId);
    assert.equal(getLiveBotSnapshot().feed[0].inProgress, true);
    assert.equal(getLiveBotSnapshot().feed[1], oldCardRef);

    // 2. Unrelated server snapshot before RPC finishes does NOT wipe out optimistic card
    setLiveBotSnapshot({ ...baseSnapshot, hourlyWakesUsed: 1 });
    assert.equal(getLiveBotSnapshot().feed.length, 2);
    assert.equal(getLiveBotSnapshot().feed[0].id, optId);
    assert.equal(getLiveBotSnapshot().feed[1], oldCardRef);

    // 3. Server RPC returns feedId, then snapshot broadcast arrives -> seamless replacement with zero duplicates
    confirmOptimisticWishFeed(optId, "feed_srv_1");
    setLiveBotSnapshot({
      ...baseSnapshot,
      feed: [
        {
          id: "feed_srv_1",
          createdAt: new Date().toISOString(),
          level: "wish",
          title: "正在处理：帮我检查今天所有未完成的待办事项",
          summary: "帮我检查今天所有未完成的待办事项",
          actions: [],
          inProgress: true,
          unread: false,
        },
        ...baseSnapshot.feed,
      ],
    });
    assert.equal(getLiveBotSnapshot().feed.length, 2);
    assert.equal(getLiveBotSnapshot().feed[0].id, "feed_srv_1");
    assert.equal(getLiveBotSnapshot().feed[1], oldCardRef);

    // 4. Failed submission rolls back optimistic card cleanly
    const failedOptId = optimisticAddWishFeed("一个会失败的任务");
    assert.equal(getLiveBotSnapshot().feed.length, 3);
    assert.equal(getLiveBotSnapshot().feed[0].id, failedOptId);
    rollbackOptimisticWishFeed(failedOptId);
    assert.equal(getLiveBotSnapshot().feed.length, 2);
    assert.equal(getLiveBotSnapshot().feed[0].id, "feed_srv_1");
  } finally {
    clearBotStore();
  }
});

test("normalizeSessionTitleFast rewrites colloquial prompts into [Category] concise titles and preserves structured titles", () => {
  assert.equal(
    needsSessionAutoRename(
      "需要一个会话整理工具，自动重命名，自动合并归档，现在的痛点是每次起个任务我都会起个会话，不知道有没有什么好的方式。",
    ),
    true,
  );
  const r1 = normalizeSessionTitleFast({
    currentTitle:
      "需要一个会话整理工具，自动重命名，自动合并归档，现在的痛点是每次起个任务我都会起个会话，不知道有没有什么好的方式。",
    cwd: "/Users/demo/Documents/General",
  });
  assert.equal(r1.category, "Paseo");
  assert.equal(r1.title, "[Paseo] 会话自动重命名与合并归档");
  assert.equal(needsSessionAutoRename(r1.title), false);

  const r2 = normalizeSessionTitleFast({
    currentTitle: "4/k1fimixy登陆了bringingchichi@gmail.com，可以继续养号了。",
    cwd: "/Users/demo/Documents/General",
  });
  assert.equal(r2.category, "养号");
  assert.match(r2.title, /^\[养号\] k1fimixy 登录 bringingchichi 续跑养号/);

  const r3 = normalizeSessionTitleFast({
    currentTitle: "multigravity-ux的主题功能不要了吧，太杂了",
    cwd: "/Users/demo/Documents/General",
  });
  assert.equal(r3.title, "[插件] 精简 multigravity-ux 移除主题功能");
  assert.equal(inferSessionCategory("筛选美亚大号发往 BuyingGroup 订单", "/tmp"), "撸货");

  // Vague short prompt ("怎么办") falls back to assistantReply topic
  const r4 = normalizeSessionTitleFast({
    currentTitle: "怎么办",
    firstPrompt: "怎么办",
    assistantReply: "### 解决 BuyingGroup 登录验证码超时问题\n你可以先刷新会话缓存…",
    cwd: "/Users/demo/Documents/General",
  });
  assert.equal(r4.title, "[撸货] 解决 BuyingGroup 登录验证码超时问题");

  // Company department tabs and Paseo Bot internal threads are preserved as-is
  assert.equal(needsSessionAutoRename("研发部"), false);
  assert.equal(needsSessionAutoRename("Paseo Bot · 首席幕僚"), false);
});

test("scoreSessionTopicSimilarity clusters same-topic threads while keeping distinct tasks separate", () => {
  const cwd = "/Users/demo/Documents/General";
  const warmupMorning = {
    title: "AdsPower 启动 bringingchichi@gmail.com 养号",
    category: "养号",
    cwd,
  };
  const warmupEvening = {
    title: "4/k1fimixy登陆了bringingchichi@gmail.com，可以继续养号了。",
    category: "养号",
    cwd,
  };
  const unrelatedPlugin = {
    title: "排查 Paseo 手机端启动卡顿是由插件还是文件引起",
    category: "Paseo",
    cwd,
  };
  const anotherPlugin = {
    title: "评估 Paseo 跨 Provider 通用 MCP 配置插件设计",
    category: "插件",
    cwd,
  };

  assert.ok(scoreSessionTopicSimilarity(warmupMorning, warmupEvening) >= 38);
  assert.ok(scoreSessionTopicSimilarity(warmupMorning, unrelatedPlugin) < 20);
  assert.ok(scoreSessionTopicSimilarity(unrelatedPlugin, anotherPlugin) < 38);
});

test("renderTidyPlanMarkdown and parseApprovedItemKeysFromMarkdown respect unchecked or deleted checklist items", () => {
  const plan: SessionTidyPlan = {
    id: "tidy_demo_123",
    createdAt: "2026-11-26T16:00:00.000Z",
    scannedWorkspaces: 10,
    scannedAgents: 8,
    writeObsidianDigest: true,
    obsidianInboxDir: "/tmp/00-Inbox",
    hubs: [
      {
        itemKey: "hub_1",
        cwd: "/Users/demo/Documents/General",
        projectLabel: "General",
        hubTitle: "📌 日常总控 · General",
        duplicateLocalCount: 6,
      },
    ],
    renames: [
      {
        itemKey: "ren_1",
        agentId: "agt_1",
        shortAgentId: "agt_1",
        cwd: "/Users/demo/Documents/General",
        category: "养号",
        previousTitle: "4/k1fimixy登陆了...",
        nextTitle: "[养号] k1fimixy 登录续跑",
      },
      {
        itemKey: "ren_2",
        agentId: "agt_2",
        shortAgentId: "agt_2",
        cwd: "/Users/demo/Documents/General",
        category: "插件",
        previousTitle: "multigravity-ux的主题功能不要了吧",
        nextTitle: "[插件] 精简 multigravity-ux",
      },
    ],
    merges: [],
    archives: [],
  };

  const md = renderTidyPlanMarkdown(plan);
  assert.equal(extractTidyPlanIdFromPrompt(md), "tidy_demo_123");
  assert.deepEqual(
    [...parseApprovedItemKeysFromMarkdown(md, plan)].sort(),
    ["hub_1", "ren_1", "ren_2"],
  );

  const editedMd = md.replace("- [x] `[@ren_1]`", "- [ ] `[@ren_1]`");
  assert.deepEqual(
    [...parseApprovedItemKeysFromMarkdown(md, plan)].sort(),
    ["hub_1", "ren_1", "ren_2"],
  );
  assert.deepEqual(
    [...parseApprovedItemKeysFromMarkdown(editedMd, plan)].sort(),
    ["hub_1", "ren_2"],
  );
});

test("pickCompatibleModeId falls back cleanly when cwd lacks 'auto' mode", () => {
  const knowledgeBaseModes = ["default", "accept-edits", "plan", "full-access"];
  const generalModes = ["default", "accept-edits", "auto", "plan", "full-access"];

  assert.equal(pickCompatibleModeId("auto", knowledgeBaseModes), "accept-edits");
  assert.equal(pickCompatibleModeId("auto", generalModes), "auto");
  assert.equal(pickCompatibleModeId("full-access", knowledgeBaseModes), "full-access");
  assert.equal(pickCompatibleModeId("auto", ["default", "plan"]), "default");
  assert.equal(pickCompatibleModeId("auto", ["build", "plan"]), "build");
  assert.equal(pickCompatibleModeId("auto", []), undefined);
});

test("parseInvalidModeError extracts rejected mode and available modes from Paseo errors", () => {
  const err = new Error(
    "Invalid mode 'auto' for provider 'antigravity'. Available modes: default, accept-edits, plan, full-access",
  );
  const parsed = parseInvalidModeError(err);
  assert.deepEqual(parsed, {
    rejectedMode: "auto",
    availableModes: ["default", "accept-edits", "plan", "full-access"],
  });

  const claudeErr = new Error(
    "Invalid mode 'auto' for Claude provider. Valid modes: default, acceptEdits, plan",
  );
  assert.deepEqual(parseInvalidModeError(claudeErr), {
    rejectedMode: "auto",
    availableModes: ["default", "acceptEdits", "plan"],
  });

  assert.equal(parseInvalidModeError(new Error("Network timeout")), null);
});

test("optimisticExecuteFeedAction and optimisticSnoozeFeed apply instant UI state and roll back cleanly", () => {
  clearBotStore();
  try {
    setLiveBotSnapshot({
      chiefAgentId: null,
      chiefWorkspaceId: null,
      webhookBaseUrl: null,
      hourlyWakesUsed: 0,
      hourlyWakeLimit: 24,
      globalPaused: false,
      unreadCount: 1,
      pendingApprovalCount: 0,
      runningWorkerCount: 0,
      totalSilentChecks: 0,
      triggers: [],
      nativeSchedules: [],
      feed: [
        {
          id: "feed_inline_1",
          createdAt: "2026-11-27T00:00:00.000Z",
          level: "notify",
          title: "巡检报告",
          summary: "发现 1 项待办",
          actions: [
            {
              id: "act_1",
              label: "立即跟进",
              kind: "wish",
              prompt: "请跟进",
            },
          ],
          inProgress: false,
          agentId: "agt_origin",
          unread: true,
        },
      ],
      approvals: [],
      workers: [],
      routineSuggestions: [],
      knownWorkspaces: [],
      memoryContent: "",
      memoryPath: "",
    });

    const rollbackAction = optimisticExecuteFeedAction("feed_inline_1", {
      actionId: "act_1",
      markInProgress: true,
    });
    const afterAction = getLiveBotSnapshot();
    assert.equal(afterAction.unreadCount, 0);
    assert.equal(afterAction.feed[0].unread, false);
    assert.equal(afterAction.feed[0].inProgress, true);
    assert.ok(afterAction.feed[0].actions[0].executedAt);

    rollbackAction();
    const afterRollback = getLiveBotSnapshot();
    assert.equal(afterRollback.unreadCount, 1);
    assert.equal(afterRollback.feed[0].unread, true);
    assert.equal(afterRollback.feed[0].inProgress, false);
    assert.equal(afterRollback.feed[0].actions[0].executedAt, undefined);

    const rollbackSnooze = optimisticSnoozeFeed("feed_inline_1", 60);
    const afterSnooze = getLiveBotSnapshot();
    assert.equal(afterSnooze.unreadCount, 0);
    assert.ok(afterSnooze.feed[0].snoozedUntil);

    rollbackSnooze();
    const afterSnoozeRollback = getLiveBotSnapshot();
    assert.equal(afterSnoozeRollback.unreadCount, 1);
    assert.equal(afterSnoozeRollback.feed[0].snoozedUntil, undefined);
  } finally {
    clearBotStore();
  }
});

test("isFeedItemNeedsAttention excludes cards whose actions were executed, snoozed, in-progress, or read errors", () => {
  const nowMs = Date.parse("2026-11-27T10:45:00.000Z");
  const baseCard = {
    id: "feed_1",
    createdAt: "2026-11-27T01:00:00.000Z",
    level: "worker_update" as const,
    title: "已完成：测试卡片",
    summary: "摘要",
    inProgress: false,
    unread: false,
  };

  // Unacted action button -> still needs attention (even if read)
  assert.equal(
    isFeedItemNeedsAttention(
      {
        ...baseCard,
        actions: [{ id: "a1", label: "一键落地", kind: "delegate" }],
      },
      { nowMs },
    ),
    true,
  );

  // Single action already executed -> leaves attention
  assert.equal(
    isFeedItemNeedsAttention(
      {
        ...baseCard,
        actions: [
          {
            id: "a1",
            label: "待确认审批卡",
            kind: "wish",
            executedAt: "2026-11-27T01:16:27.587Z",
          },
        ],
      },
      { nowMs },
    ),
    false,
  );

  // Mutually exclusive options where one was already executed -> leaves attention
  assert.equal(
    isFeedItemNeedsAttention(
      {
        ...baseCard,
        level: "notify",
        actions: [
          {
            id: "a1",
            label: "方案 A（推荐）",
            kind: "delegate",
            executedAt: "2026-11-26T15:27:07.701Z",
          },
          {
            id: "a2",
            label: "方案 B",
            kind: "delegate",
          },
        ],
      },
      { nowMs },
    ),
    false,
  );

  // Snoozed into the future -> leaves attention; expired snooze -> back in attention
  assert.equal(
    isFeedItemNeedsAttention(
      {
        ...baseCard,
        snoozedUntil: "2026-11-27T12:00:00.000Z",
        actions: [{ id: "a1", label: "稍后处理", kind: "wish" }],
      },
      { nowMs },
    ),
    false,
  );
  assert.equal(
    isFeedItemNeedsAttention(
      {
        ...baseCard,
        snoozedUntil: "2026-11-27T09:00:00.000Z",
        actions: [{ id: "a1", label: "稍后处理", kind: "wish" }],
      },
      { nowMs },
    ),
    true,
  );

  // In-progress or downvoted -> excluded
  assert.equal(
    isFeedItemNeedsAttention(
      {
        ...baseCard,
        inProgress: true,
        actions: [{ id: "a1", label: "继续", kind: "wish" }],
      },
      { nowMs },
    ),
    false,
  );
  assert.equal(
    isFeedItemNeedsAttention(
      {
        ...baseCard,
        feedback: "down",
        actions: [{ id: "a1", label: "继续", kind: "wish" }],
      },
      { nowMs },
    ),
    false,
  );

  // Error cards: unread needs attention, read does not
  assert.equal(
    isFeedItemNeedsAttention(
      { ...baseCard, level: "error", unread: true, actions: [] },
      { nowMs },
    ),
    true,
  );
  assert.equal(
    isFeedItemNeedsAttention(
      { ...baseCard, level: "error", unread: false, actions: [] },
      { nowMs },
    ),
    false,
  );

  // Approval required: resolved ID excluded, unresolved included
  assert.equal(
    isFeedItemNeedsAttention(
      {
        ...baseCard,
        level: "approval_required",
        approvalId: "apr_done",
        actions: [],
      },
      { resolvedApprovalIds: new Set(["apr_done"]), nowMs },
    ),
    false,
  );
  assert.equal(
    isFeedItemNeedsAttention(
      {
        ...baseCard,
        level: "approval_required",
        approvalId: "apr_open",
        actions: [],
      },
      { resolvedApprovalIds: new Set(["apr_done"]), nowMs },
    ),
    true,
  );

  // Completed card with no actions -> excluded
  assert.equal(
    isFeedItemNeedsAttention({ ...baseCard, actions: [] }, { nowMs }),
    false,
  );
});

test("submitWishRpc and executeFeedActionRpc validate pasted image attachments", () => {
  const sampleImage = {
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    mimeType: "image/png",
    name: "screenshot.png",
  };

  // Image-only wish is allowed
  const imageOnly = submitWishRpc.input.safeParse({
    wish: "",
    images: [sampleImage],
  });
  assert.equal(imageOnly.success, true);

  // Text + image wish is allowed
  const textAndImage = submitWishRpc.input.safeParse({
    wish: "帮我看看这张截图的报错",
    images: [sampleImage],
  });
  assert.equal(textAndImage.success, true);

  // Empty wish without images is rejected
  const empty = submitWishRpc.input.safeParse({ wish: "   " });
  assert.equal(empty.success, false);

  // Non-image mimeType is rejected
  const badMime = submitWishRpc.input.safeParse({
    wish: "test",
    images: [{ data: "abc", mimeType: "application/pdf" }],
  });
  assert.equal(badMime.success, false);

  // Exceeding MAX_ATTACHED_IMAGES is rejected
  const tooMany = submitWishRpc.input.safeParse({
    wish: "test",
    images: Array.from({ length: MAX_ATTACHED_IMAGES + 1 }, () => sampleImage),
  });
  assert.equal(tooMany.success, false);

  // Inline feed follow-up accepts images
  const followUp = executeFeedActionRpc.input.safeParse({
    feedId: "feed_1",
    customKind: "wish",
    images: [sampleImage],
  });
  assert.equal(followUp.success, true);
});

test("wish draft image store enforces max limit, removal, and optimistic image-only cards", () => {
  clearBotStore();
  try {
    const makeImg = (n: number) => ({
      id: `img_${n}`,
      data: "AAAA",
      mimeType: "image/png",
      previewUri: "data:image/png;base64,AAAA",
      name: `shot-${n}.png`,
    });

    const firstBatch = appendWishDraftImages([makeImg(1), makeImg(2)]);
    assert.equal(firstBatch.added, 2);
    assert.equal(firstBatch.truncated, false);
    assert.equal(getWishDraftImages().length, 2);

    const overflowBatch = appendWishDraftImages(
      Array.from({ length: MAX_ATTACHED_IMAGES }, (_, idx) => makeImg(idx + 10)),
    );
    assert.equal(overflowBatch.added, MAX_ATTACHED_IMAGES - 2);
    assert.equal(overflowBatch.truncated, true);
    assert.equal(getWishDraftImages().length, MAX_ATTACHED_IMAGES);

    removeWishDraftImage("img_1");
    assert.equal(getWishDraftImages().length, MAX_ATTACHED_IMAGES - 1);

    const optId = optimisticAddWishFeed("", 2);
    const snap = getLiveBotSnapshot();
    const card = snap.feed.find((f) => f.id === optId);
    assert.ok(card);
    assert.equal(card.title, "正在处理：2 张图片任务");
    assert.equal(card.summary, "[附 2 张图片]");

    clearWishDraftImages();
    assert.equal(getWishDraftImages().length, 0);
  } finally {
    clearBotStore();
  }
});

test("normalizeAgentImages and resolveWishSubmissionContent handle data URLs, raw base64, and image-only wishes", () => {
  const sampleB64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  assert.deepEqual(
    normalizeAgentImages([
      { data: `data:image/jpeg;base64,${sampleB64}`, mimeType: "image/png" },
      { data: `  ${sampleB64}\n`, mimeType: "image/webp" },
      { data: "   ", mimeType: "image/png" },
      { data: sampleB64, mimeType: "application/pdf" },
    ]),
    [
      { data: sampleB64, mimeType: "image/jpeg" },
      { data: sampleB64, mimeType: "image/webp" },
    ],
  );

  assert.equal(formatImageSummaryTag(0), "");
  assert.equal(formatImageSummaryTag(1), "[附 1 张图片]");
  assert.equal(formatImageSummaryTag(3), "[附 3 张图片]");

  const imageOnly = resolveWishSubmissionContent({
    wish: "  ",
    images: [{ data: `data:image/png;base64,${sampleB64}`, mimeType: "image/png" }],
  });
  assert.equal(imageOnly.cleanWish, "");
  assert.equal(imageOnly.baseLabel, "图片任务");
  assert.equal(imageOnly.feedSummaryText, "[附 1 张图片]");
  assert.match(imageOnly.effectiveWishText, /附带的图片/);
  assert.deepEqual(imageOnly.attachedImages, [{ data: sampleB64, mimeType: "image/png" }]);

  const textWithImages = resolveWishSubmissionContent({
    wish: "帮我看下这两个报错截图",
    images: [
      { data: sampleB64, mimeType: "image/png" },
      { data: sampleB64, mimeType: "image/jpeg" },
    ],
  });
  assert.equal(textWithImages.baseLabel, "帮我看下这两个报错截图");
  assert.equal(textWithImages.feedSummaryText, "帮我看下这两个报错截图\n\n[附 2 张图片]");
  assert.equal(textWithImages.effectiveWishText, "帮我看下这两个报错截图");
  assert.equal(textWithImages.attachedImages.length, 2);
});

test("unified native schedules helpers parse disk JSON, convert cadence, and update store optimistically", async () => {
  assert.equal(extractSimpleDailyTimeFromCron("15 9 * * *"), "09:15");
  assert.equal(extractSimpleDailyTimeFromCron("30 22 * * *"), "22:30");
  assert.equal(extractSimpleDailyTimeFromCron("30 9,21 * * *"), undefined);

  assert.deepEqual(
    resolveScheduleCadenceArgs({ dailyTime: "08:30", timezone: "Asia/Shanghai" }),
    { mode: "cron", cron: "30 8 * * *", timezone: "Asia/Shanghai" },
  );
  assert.deepEqual(
    resolveScheduleCadenceArgs({
      cron: "30  9,21  * * *",
      dailyTime: "08:30",
      timezone: "Asia/Shanghai",
    }),
    { mode: "cron", cron: "30 9,21 * * *", timezone: "Asia/Shanghai" },
  );
  assert.deepEqual(resolveScheduleCadenceArgs({ everySec: 1800 }), {
    mode: "every",
    every: "30m",
  });
  assert.deepEqual(resolveScheduleCadenceArgs({ everySec: 7200 }), {
    mode: "every",
    every: "2h",
  });

  const wrapped = buildNativeSchedulePromptWithGovernance("检查每日待办", "notify", [
    "低于 $50 不提醒",
  ]);
  assert.match(wrapped, /低于 \$50 不提醒/);
  assert.match(wrapped, /paseo_bot_report_outcome/);
  // Already-instrumented prompt should not duplicate linkage block
  assert.equal(
    buildNativeSchedulePromptWithGovernance(wrapped, "notify"),
    wrapped,
  );

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-sched-test-"));
  try {
    await fs.writeFile(
      path.join(tmpDir, "sched_1.json"),
      JSON.stringify({
        id: "sched_1",
        name: "每日 22:30 会话自动整理",
        prompt: "整理工作区与会话",
        cadence: {
          type: "cron",
          expression: "30 22 * * *",
          timezone: "Asia/Shanghai",
        },
        target: {
          type: "new-agent",
          config: {
            provider: "antigravity",
            model: "gemini-4-neon",
            modeId: "full-access",
            cwd: "/Users/demo/KnowledgeBase",
          },
        },
        status: "active",
        createdAt: "2026-11-27T01:00:00.000Z",
        nextRunAt: "2026-11-27T14:30:00.000Z",
        lastRunAt: "2026-11-26T14:31:00.000Z",
        runs: [
          {
            id: "r1",
            status: "succeeded",
            agentId: "agt_run_1",
            error: null,
          },
        ],
      }),
      "utf8",
    );

    const list = await readNativeSchedulesFromDisk(tmpDir);
    assert.ok(list);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "sched_1");
    assert.equal(list[0].cronExpression, "30 22 * * *");
    assert.equal(list[0].timezone, "Asia/Shanghai");
    assert.equal(list[0].provider, "antigravity/gemini-4-neon");
    assert.equal(list[0].cwd, "/Users/demo/KnowledgeBase");
    assert.equal(list[0].lastRunStatus, "succeeded");
    assert.equal(list[0].lastRunAgentId, "agt_run_1");
    assert.equal(list[0].runCount, 1);

    const parsedSummary = parseNativeScheduleRecord({
      id: "sched_2",
      name: "Summary Row",
      cadence: "cron:30 9,21 * * * (Asia/Shanghai)",
      target: "new-agent:antigravity/gemini-4-neon",
      status: "paused",
    });
    assert.ok(parsedSummary);
    assert.equal(parsedSummary.cronExpression, "30 9,21 * * *");
    assert.equal(parsedSummary.provider, "antigravity/gemini-4-neon");

    clearBotStore();
    setLiveBotSnapshot({
      ...getLiveBotSnapshot(),
      nativeSchedules: list,
    });
    optimisticManageNativeSchedule("sched_1", "pause");
    assert.equal(getLiveBotSnapshot().nativeSchedules[0].status, "paused");
    optimisticManageNativeSchedule("sched_1", "resume");
    assert.equal(getLiveBotSnapshot().nativeSchedules[0].status, "active");
    optimisticManageNativeSchedule("sched_1", "delete");
    assert.equal(getLiveBotSnapshot().nativeSchedules.length, 0);
  } finally {
    clearBotStore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
