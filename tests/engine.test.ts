import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyApprovalResolutionMutation,
  applyFeedCurationMutation,
  cleanTaskTitle,
  computeRoutineSuggestions,
  draftMissionFromIntent,
  extractDailyTime,
  extractIntervalSec,
  extractSuggestedActionsFromMarkdown,
  routeFollowUpCandidate,
  splitReplyIntoPreviewAndDetails,
  type RoutableAgentCandidate,
} from "../server/intent.ts";
import {
  BotStateStore,
  computeNormalizedHash,
  expandHomePath,
  shouldIgnoreWatchPath,
} from "../server/storage.ts";

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
