import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  BotSnapshotSchema,
  sendChatMessageRpc,
  markMessagesReadRpc,
  updateButlerProfileRpc,
} from "../shared/contracts.ts";
import { BotSettingsSchema, DEFAULT_BOT_SETTINGS } from "../shared/settings.ts";
import { ProactiveEngine } from "../server/engine.ts";
import {
  buildButlerL1SystemPrompt,
  loadPromptTemplate,
  loadRawPromptTemplate,
  resolveDefaultPromptsDirs,
} from "../server/prompts.ts";
import {
  buildConclusionSummary,
  buildOnboardingMessages,
  classifyMessageTier,
  doesAgentMatchExpectedConfig,
  evaluateWorkerTurnForStream,
  extractAgentModelPair,
  parseProfilePreferenceFromMemoryNote,
  projectLegacyFeedToMessages,
  resolveTierProviderChain,
  type CatalogProviderAvailability,
} from "../server/router.ts";
import { BotStateStore } from "../server/storage.ts";
import { registerBotAgentTools } from "../server/tools.ts";

test("L0 classifyMessageTier covers all 8 deterministic priority branches cleanly", () => {
  // 1. Explicit override (forceTier & providerOverride)
  const forceL3 = classifyMessageTier({
    text: "你好",
    forceTier: "L3",
  });
  assert.equal(forceL3.tier, "L3");
  assert.equal(forceL3.reason, "explicit_override");
  assert.ok(forceL3.immediateAckText);

  const overrideFast = classifyMessageTier({
    text: "帮我查一下服务器",
    providerOverride: "antigravity/gemini-3.8-flash",
  });
  assert.equal(overrideFast.tier, "L1");
  assert.equal(overrideFast.reason, "explicit_override");

  const overrideDeep = classifyMessageTier({
    text: "简短问题",
    providerOverride: "antigravity/gemini-4-neon",
  });
  assert.equal(overrideDeep.tier, "L3");
  assert.equal(overrideDeep.reason, "explicit_override");

  // 2. Pure local control commands (0 Token L0)
  const pauseCmd = classifyMessageTier({ text: "/pause" });
  assert.equal(pauseCmd.tier, "L0");
  assert.equal(pauseCmd.reason, "local_control_command");
  assert.equal(pauseCmd.localCommand, "pause");

  const pauseCn = classifyMessageTier({ text: "暂停全部后台规则" });
  assert.equal(pauseCn.tier, "L0");
  assert.equal(pauseCn.localCommand, "pause");

  const resumeCn = classifyMessageTier({ text: "恢复后台规则" });
  assert.equal(resumeCn.tier, "L0");
  assert.equal(resumeCn.localCommand, "resume");

  const tidyCmd = classifyMessageTier({ text: "/tidy" });
  assert.equal(tidyCmd.tier, "L0");
  assert.equal(tidyCmd.localCommand, "tidy_preview");

  // 3. Explicit existing session continuation (direct_session_route)
  const directSession = classifyMessageTier({
    text: "继续在会话 787df7e 里把测试补完",
    routableCandidates: [
      {
        id: "787df7e4-aaaa-bbbb-cccc-dddddddddddd",
        title: "修复插件麦克风延迟",
        cwd: "/tmp/voice-clean",
        workspaceId: "wks_voice",
        updatedAtMs: 5000,
      },
    ],
  });
  assert.equal(directSession.tier, "L0");
  assert.equal(directSession.reason, "direct_session_route");
  assert.equal(
    directSession.directSessionRoute?.agentId,
    "787df7e4-aaaa-bbbb-cccc-dddddddddddd",
  );

  // 4. Image attachments -> at least L2 (or L3 with deep analysis)
  const imageL2 = classifyMessageTier({
    text: "看看这张图",
    images: [{ mimeType: "image/png", name: "shot.png" }],
  });
  assert.equal(imageL2.tier, "L2");
  assert.equal(imageL2.reason, "image_attachment");

  const imageL3 = classifyMessageTier({
    text: "请对这张架构图做全面深度分析并给出重构方案",
    images: [{ mimeType: "image/png", name: "arch.png" }],
  });
  assert.equal(imageL3.tier, "L3");
  assert.equal(imageL3.reason, "image_attachment");

  // 5. One-sentence memory update / mute old reminder / rename -> L1 with matchedTriggerId
  const muteReply = classifyMessageTier({
    text: "停用了，我换 example.net 了",
    recentMessages: [
      {
        id: "msg_proactive_1",
        role: "assistant",
        kind: "proactive",
        text: "辉，我看到配置里还有指向 api.legacy-api.io/v1 的接口地址……",
        triggerId: "trg_legacy_domain",
        triggerName: "域名到期检查",
        createdAt: "2026-11-28T02:00:00.000Z",
      },
    ],
  });
  assert.equal(muteReply.tier, "L1");
  assert.equal(muteReply.reason, "memory_or_mute_reply");
  assert.equal(muteReply.matchedTriggerId, "trg_legacy_domain");
  assert.equal(muteReply.matchedTriggerName, "域名到期检查");

  const renameReply = classifyMessageTier({
    text: "以后叫你小点吧，平时叫我辉就行",
  });
  assert.equal(renameReply.tier, "L1");
  assert.equal(renameReply.reason, "memory_or_mute_reply");

  // 6. Deep analysis & architectural planning -> L3
  const deepExplicit = classifyMessageTier({
    text: "请给我做一份跨工作区插件状态同步的架构设计与对比评估多个方案",
  });
  assert.equal(deepExplicit.tier, "L3");
  assert.equal(deepExplicit.reason, "deep_analysis_request");

  const longAnalytical = classifyMessageTier({
    text: `我们需要系统评估并对比两种长期状态架构方案的权衡：${"详细设计约束与多阶段重构评估说明。".repeat(40)}`,
  });
  assert.equal(longAnalytical.tier, "L3");
  assert.equal(longAnalytical.reason, "deep_analysis_request");

  // 7. Tool verification / workspace action / URL / path -> L2
  const tunnelCheck = classifyMessageTier({
    text: "帮我查一下 Cloudflare Tunnel 能不能直接升级",
  });
  assert.equal(tunnelCheck.tier, "L2");
  assert.equal(tunnelCheck.reason, "tool_or_workspace_action");
  assert.ok(tunnelCheck.immediateAckText);

  const wsAction = classifyMessageTier({
    text: "检查 MoneyPrinter 今天的未发货订单",
    knownWorkspaces: [{ cwd: "/Users/demo/Documents/MoneyPrinter", label: "MoneyPrinter" }],
  });
  assert.equal(wsAction.tier, "L2");
  assert.equal(wsAction.reason, "tool_or_workspace_action");

  // 8. Default fallback: casual chat, greetings, short Q&A -> L1
  for (const casual of ["嗨", "谢谢！", "早上好", "什么是 SHA-256 差量指纹？"]) {
    const res = classifyMessageTier({ text: casual });
    assert.equal(res.tier, "L1", `Expected L1 for "${casual}"`);
    assert.equal(res.reason, "casual_chat_or_qa");
  }
});

test("BotSettingsSchema tiered defaults and resolveTierProviderChain fallback & thinking levels", () => {
  assert.equal(DEFAULT_BOT_SETTINGS.butlerName, "Paseo Bot");
  assert.equal(DEFAULT_BOT_SETTINGS.userName, "");
  assert.equal(DEFAULT_BOT_SETTINGS.fastProvider, "antigravity/gemini-3.8-flash");
  assert.equal(DEFAULT_BOT_SETTINGS.fastFallbackProvider, "antigravity/gemini-4-hydrogen");
  assert.equal(DEFAULT_BOT_SETTINGS.fastThinking, "low");
  assert.equal(DEFAULT_BOT_SETTINGS.execProvider, "antigravity/gemini-4-carbon");
  assert.equal(DEFAULT_BOT_SETTINGS.execThinking, "medium");
  assert.equal(DEFAULT_BOT_SETTINGS.deepProvider, "antigravity/gemini-4-neon");
  assert.equal(DEFAULT_BOT_SETTINGS.deepThinking, "high");
  // Legacy defaults lowered from neon to carbon while preserving custom user overrides
  assert.equal(DEFAULT_BOT_SETTINGS.chiefProvider, "antigravity/gemini-4-carbon");
  assert.equal(DEFAULT_BOT_SETTINGS.scoutProvider, "antigravity/gemini-4-carbon");
  assert.equal(DEFAULT_BOT_SETTINGS.defaultWorkerProvider, "antigravity/gemini-4-carbon");

  const customLegacy = BotSettingsSchema.parse({
    chiefProvider: "codex/gpt-5.4",
  });
  assert.equal(customLegacy.chiefProvider, "codex/gpt-5.4");
  assert.equal(customLegacy.fastProvider, "antigravity/gemini-3.8-flash");

  const fullCatalog: CatalogProviderAvailability[] = [
    {
      id: "antigravity",
      available: true,
      defaultModel: "gemini-4-carbon",
      models: [
        { id: "gemini-3.8-flash" },
        { id: "gemini-4-hydrogen" },
        { id: "gemini-4-carbon", isDefault: true },
        { id: "gemini-4-neon" },
      ],
    },
  ];

  // Primary available for all 3 tiers
  const l1Primary = resolveTierProviderChain("L1", {}, fullCatalog);
  assert.equal(l1Primary.chosenProvider, "antigravity/gemini-3.8-flash");
  assert.equal(l1Primary.thinkingOptionId, "low");
  assert.equal(l1Primary.degraded, false);

  const l2Primary = resolveTierProviderChain("L2", {}, fullCatalog);
  assert.equal(l2Primary.chosenProvider, "antigravity/gemini-4-carbon");
  assert.equal(l2Primary.thinkingOptionId, "medium");
  assert.equal(
    resolveTierProviderChain("L2", {}, fullCatalog, { isDelegatedWorker: true })
      .thinkingOptionId,
    "high",
  );

  const l3Primary = resolveTierProviderChain("L3", {}, fullCatalog);
  assert.equal(l3Primary.chosenProvider, "antigravity/gemini-4-neon");
  assert.equal(l3Primary.thinkingOptionId, "high");

  // L1 fallback: flash unavailable -> hydrogen -> carbon -> catalog[0]
  const noFlashCatalog: CatalogProviderAvailability[] = [
    {
      id: "antigravity",
      available: true,
      models: [{ id: "gemini-4-hydrogen" }, { id: "gemini-4-carbon" }],
    },
  ];
  const l1ToHydrogen = resolveTierProviderChain("L1", {}, noFlashCatalog);
  assert.equal(l1ToHydrogen.chosenProvider, "antigravity/gemini-4-hydrogen");
  assert.equal(l1ToHydrogen.degraded, true);

  const onlyClaudeCatalog: CatalogProviderAvailability[] = [
    {
      id: "claude",
      available: true,
      defaultModel: "claude-sonnet-4-5",
      models: [{ id: "claude-sonnet-4-5", isDefault: true }],
    },
  ];
  const l1ToCatalogFirst = resolveTierProviderChain("L1", {}, onlyClaudeCatalog);
  assert.equal(l1ToCatalogFirst.chosenProvider, "claude/claude-sonnet-4-5");
  assert.equal(l1ToCatalogFirst.degraded, true);

  // L3 fallback: neon unavailable -> degrades to execProvider (carbon) keeping thinkingOptionId="high"
  const noNeonCatalog: CatalogProviderAvailability[] = [
    {
      id: "antigravity",
      available: true,
      models: [{ id: "gemini-4-carbon" }],
    },
  ];
  const l3Degraded = resolveTierProviderChain("L3", {}, noNeonCatalog);
  assert.equal(l3Degraded.chosenProvider, "antigravity/gemini-4-carbon");
  assert.equal(l3Degraded.thinkingOptionId, "high");
  assert.equal(l3Degraded.degraded, true);
});

test("Legacy state.json loads with zero crash, migrates non-silent feed ascending, strips base64, and builds Dot onboarding", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-v03-migrate-"));
  try {
    const legacyState = {
      chiefAgentId: "agt_chief_old",
      chiefWorkspaceId: "wks_chief_old",
      runtimePaused: false,
      wakeTimestamps: [],
      dismissedSuggestionIds: ["sug_1"],
      triggers: [
        {
          id: "trg_old_1",
          name: "域名监控",
          kind: "poll_command",
          enabled: true,
          governance: "notify",
          executionTarget: "scout_helper",
          cwd: tmpDir,
          prompt: "Check domain",
          createdAt: "2026-11-27T01:00:00.000Z",
          updatedAt: "2026-11-27T01:00:00.000Z",
          runCount: 4,
          silentCount: 3,
          notifyCount: 1,
        },
      ],
      // Stored newest-first in legacy v0.3.0 state.json
      feed: [
        {
          id: "feed_apr",
          createdAt: "2026-11-28T02:00:00.000Z",
          level: "approval_required",
          title: "待确认：发送月度对账单",
          summary: "将向 finance@example.com 发送月度账单",
          approvalId: "apr_old_1",
          unread: true,
        },
        {
          id: "feed_silent_noise",
          createdAt: "2026-11-28T01:30:00.000Z",
          level: "silent",
          title: "无变化跳过：域名监控",
          summary: "检查完成，无新动态",
          unread: false,
        },
        {
          id: "feed_notify_old",
          createdAt: "2026-11-28T01:00:00.000Z",
          level: "notify",
          title: "ChatGPT 备用额度重置",
          summary:
            "辉，你的 ChatGPT Business 有一次备用额度重置，**12 月 1 日到期**。[查看邮件](https://mail.google.com/mail/u/0/#inbox/1)",
          triggerId: "trg_old_1",
          triggerName: "域名监控",
          unread: true,
        },
      ],
      approvals: [
        {
          id: "apr_old_1",
          createdAt: "2026-11-28T02:00:00.000Z",
          status: "pending",
          title: "发送月度对账单",
          actionSummary: "将向 finance@example.com 发送月度账单",
          riskLevel: "medium",
          followUpPrompt: "Send email",
          cwd: tmpDir,
        },
      ],
      workers: [],
    };

    await fs.writeFile(
      path.join(tmpDir, "state.json"),
      JSON.stringify(legacyState),
      "utf8",
    );

    const store = new BotStateStore(tmpDir);
    const loaded = await store.load();

    assert.equal(loaded.chiefAgentId, "agt_chief_old");
    assert.equal(loaded.l1AgentId, null);
    assert.equal(loaded.triggers.length, 1);
    assert.equal(loaded.feed.length, 3); // Legacy feed preserved intact
    assert.equal(loaded.approvals.length, 1);
    assert.equal(loaded.routingTelemetry.l0Hits, 0);

    // Silent feed item MUST NOT enter messages; remaining 2 projected in ascending order
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[0].id, "msg_legacy_feed_notify_old");
    assert.equal(loaded.messages[0].kind, "proactive");
    assert.equal(loaded.messages[0].triggerId, "trg_old_1");
    assert.equal(loaded.messages[0].links[0]?.url, "https://mail.google.com/mail/u/0/#inbox/1");
    assert.equal(loaded.messages[1].id, "msg_legacy_feed_apr");
    assert.equal(loaded.messages[1].kind, "approval");
    assert.equal(loaded.messages[1].approvalId, "apr_old_1");

    // Verify large data: base64 previewUri is stripped before hitting disk
    await store.mutate((draft) => {
      draft.messages.push({
        id: "msg_img_test",
        createdAt: new Date().toISOString(),
        role: "user",
        kind: "chat",
        text: "请看图",
        images: [
          {
            mimeType: "image/png",
            name: "big.png",
            previewUri: `data:image/png;base64,${"A".repeat(50_000)}`,
          },
        ],
        links: [],
        quickActions: [],
        status: "done",
        unread: false,
      });
    });

    const rawSaved = await fs.readFile(path.join(tmpDir, "state.json"), "utf8");
    assert.ok(rawSaved.length < 10_000, "state.json must not persist raw base64 images");
    const reparsed = JSON.parse(rawSaved);
    const savedImgMsg = reparsed.messages.find((m: { id: string }) => m.id === "msg_img_test");
    assert.deepEqual(savedImgMsg.images, [{ mimeType: "image/png", name: "big.png" }]);

    // Cold-start onboarding bubbles & legacy BotSnapshotSchema parse defaults
    const onboarding = buildOnboardingMessages({ userName: "辉", baseTimeMs: 1_700_000_000_000 });
    assert.equal(onboarding.length, 3);
    assert.match(onboarding[0].text, /^嗨，辉！/);
    assert.match(onboarding[1].text, /取个名字/);

    const parsedSnap = BotSnapshotSchema.parse({
      chiefAgentId: null,
      chiefWorkspaceId: null,
      webhookBaseUrl: null,
      hourlyWakesUsed: 0,
      hourlyWakeLimit: 24,
      globalPaused: false,
      unreadCount: 0,
      pendingApprovalCount: 0,
      runningWorkerCount: 0,
      triggers: [],
      feed: [],
      approvals: [],
      workers: [],
      memoryContent: "",
      memoryPath: "",
    });
    assert.equal(parsedSnap.butlerName, "Paseo Bot");
    assert.deepEqual(parsedSnap.messages, []);
    assert.equal(parsedSnap.routingTelemetry.l0Hits, 0);

    // Direct test of 20-item cap on projectLegacyFeedToMessages
    const manyFeeds = Array.from({ length: 30 }, (_, idx) => ({
      id: `f_${idx}`,
      createdAt: new Date(1_700_000_000_000 + idx * 1000).toISOString(),
      level: "notify" as const,
      title: `提醒 ${idx}`,
      summary: `内容 ${idx}`,
      actions: [],
      inProgress: false,
      unread: false,
    }));
    const projected20 = projectLegacyFeedToMessages(manyFeeds, 20);
    assert.equal(projected20.length, 20);
    assert.equal(projected20[0].id, "msg_legacy_f_10");
    assert.equal(projected20[19].id, "msg_legacy_f_29");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ISS-002 prompts loader interpolates variables, falls back cleanly when missing, and package.json includes prompts/", async () => {
  const pkgRaw = await fs.readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8",
  );
  const pkg = JSON.parse(pkgRaw) as { files?: string[] };
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.includes("prompts/"),
    'package.json#files must include "prompts/" (ISS-002)',
  );

  // Real disk prompt loading + variable substitution
  const realPersona = await loadPromptTemplate("butler-persona", {
    butlerName: "小点",
    userName: "辉",
  });
  assert.match(realPersona, /你是 `小点`，`辉` 在 Paseo 中的专属私人管家/);
  assert.doesNotMatch(realPersona, /\{\{butlerName\}\}/);
  assert.doesNotMatch(realPersona, /\{\{userName\}\}/);

  const l1Sys = await buildButlerL1SystemPrompt({
    butlerName: "Dot",
    userName: "Shine",
    memoryContent: "- 关注 Cloudflare Tunnel",
  });
  assert.match(l1Sys, /paseo_bot_escalate_task/);
  assert.match(l1Sys, /关注 Cloudflare Tunnel/);

  // Built-in fallback when prompts directory is unavailable
  const missingDir = path.join(os.tmpdir(), `missing-prompts-${Date.now()}`);
  for (const name of [
    "butler-persona",
    "l1-router-prompt",
    "proactive-bubble-style",
  ] as const) {
    const rawFallback = await loadRawPromptTemplate(name, {
      promptsDir: missingDir,
      bypassCache: true,
    });
    assert.equal(rawFallback.usedFallback, true);
    const rendered = await loadPromptTemplate(
      name,
      { butlerName: "阿福", userName: "辉" },
      { promptsDir: missingDir, bypassCache: true },
    );
    assert.match(rendered, /阿福/);
    assert.doesNotMatch(rendered, /\{\{butlerName\}\}/);
  }
});

test("ISS-003 resolveDefaultPromptsDirs handles undefined import.meta.url in CJS bundles without throwing", async () => {
  // Simulate Paseo CJS bundle runtime where import.meta.url is undefined and __dirname is present
  const cjsDirs = resolveDefaultPromptsDirs({
    metaUrl: undefined,
    cjsDirname: "/tmp/paseo-bundle/dist",
    cwd: "/tmp/paseo-workdir",
  });
  assert.deepEqual(cjsDirs, [
    path.resolve("/tmp/paseo-bundle/dist", "prompts"),
    path.resolve("/tmp/paseo-bundle", "prompts"),
    path.resolve("/tmp/paseo-workdir", "prompts"),
  ]);

  // Simulate completely stripped/malformed URL & missing __dirname -> still safe, zero throw
  const minimalDirs = resolveDefaultPromptsDirs({
    metaUrl: "not-a-valid-file-url",
    cjsDirname: undefined,
    cwd: "/tmp/only-cwd",
  });
  assert.deepEqual(minimalDirs, [path.resolve("/tmp/only-cwd", "prompts")]);

  // Simulate ESM file:// URL resolution
  const esmDirs = resolveDefaultPromptsDirs({
    metaUrl: "file:///Users/demo/paseo-bot/server/prompts.ts",
    cjsDirname: undefined,
    cwd: "/Users/demo/paseo-bot",
  });
  assert.equal(esmDirs[0], path.resolve("/Users/demo/paseo-bot/prompts"));
  assert.equal(esmDirs[1], path.resolve("/Users/demo/paseo-bot/server/prompts"));

  // Non-existent directory still gracefully returns built-in fallback template
  const missingRes = await loadRawPromptTemplate("butler-persona", {
    promptsDir: "/tmp/paseo-nonexistent-prompts-iss003",
    bypassCache: true,
  });
  assert.equal(missingRes.usedFallback, true);
  assert.match(missingRes.content, /\{\{butlerName\}\}/);
});

test("ISS-001 parseProfilePreferenceFromMemoryNote and paseo_bot_memory_write sync butlerName/userName live", async () => {
  assert.deepEqual(
    parseProfilePreferenceFromMemoryNote(
      "[称呼偏好] 管家名称设为「小点」；称呼用户为「辉」。",
    ),
    { butlerName: "小点", userName: "辉" },
  );
  assert.deepEqual(
    parseProfilePreferenceFromMemoryNote(
      "[称呼偏好] Butler name: \"Dot\"; call user \"Shine\".",
    ),
    { butlerName: "Dot", userName: "Shine" },
  );
  assert.deepEqual(
    parseProfilePreferenceFromMemoryNote("以后叫你阿福吧，平时叫我老板就行"),
    { butlerName: "阿福", userName: "老板" },
  );
  assert.deepEqual(
    parseProfilePreferenceFromMemoryNote(
      "[资产变更与过滤规则] legacy-api.io 已主动停用，切换至 example.net。",
    ),
    {},
  );

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-iss001-"));
  try {
    const store = new BotStateStore(tmpDir);
    const engine = new ProactiveEngine({ store });
    (engine as unknown as { settings: typeof DEFAULT_BOT_SETTINGS }).settings = {
      ...DEFAULT_BOT_SETTINGS,
      homeCwd: tmpDir,
      memoryFilePath: path.join(tmpDir, "MEMORY.md"),
    };

    let openBeforeHook:
      | ((
          arg: { request: { purpose?: string; background?: boolean; labels: Record<string, string>; tools: Array<{ name: string }>; appendSystemPrompt?: string[]; metadata?: Record<string, unknown> } },
          ctx: { paseo: PaseoApi },
        ) => Promise<{ tools: Array<{ name: string; execute: (input: unknown, ctx: unknown) => Promise<unknown> }> } | undefined>)
      | undefined;

    const fakeServer = {
      addHook(name: string, fn: unknown) {
        if (name === "agent.open.before") {
          openBeforeHook = fn as typeof openBeforeHook;
        }
        return () => undefined;
      },
    } as unknown as PluginServerContext;

    registerBotAgentTools(fakeServer, engine);
    assert.ok(openBeforeHook);

    const fakePaseo = {
      workspaces: { list: async () => ({ entries: [] }) },
      agents: { list: async () => ({ entries: [] }) },
      providers: { snapshot: async () => ({ entries: [] }) },
    } as unknown as PaseoApi;

    // Verify butler-l1 gets strict minimal-privilege tool whitelist (NO delegate_task!)
    const l1HookRes = await openBeforeHook(
      {
        request: {
          background: true,
          labels: { "paseo-bot/role": "butler-l1" },
          tools: [],
        },
      },
      { paseo: fakePaseo },
    );
    assert.ok(l1HookRes);
    const l1ToolNames = l1HookRes.tools.map((t) => t.name).sort();
    assert.deepEqual(l1ToolNames, [
      "paseo_bot_escalate_task",
      "paseo_bot_list_triggers",
      "paseo_bot_memory_read",
      "paseo_bot_memory_write",
      "paseo_bot_self_wake",
      "paseo_bot_update_trigger",
    ]);
    assert.equal(l1ToolNames.includes("paseo_bot_delegate_task"), false);

    // Execute paseo_bot_memory_write with [称呼偏好] -> top-bar butlerName & userName update immediately!
    const broadcasted: Array<{ butlerName: string; userName: string }> = [];
    engine.subscribeSnapshots((snap) => {
      broadcasted.push({ butlerName: snap.butlerName, userName: snap.userName });
    });

    const memWriteTool = l1HookRes.tools.find((t) => t.name === "paseo_bot_memory_write")!;
    await memWriteTool.execute(
      {
        mode: "append_goal",
        content: "[称呼偏好] 管家名称设为「小点」；称呼用户为「辉」。",
      },
      { agent: { id: "agt_l1", cwd: tmpDir, background: true }, paseo: fakePaseo },
    );

    const snapAfterMem = await engine.getSnapshot();
    assert.equal(snapAfterMem.butlerName, "小点");
    assert.equal(snapAfterMem.userName, "辉");

    // Explicit updateButlerProfileRpc contract & engine method
    const validInput = updateButlerProfileRpc.input.parse({
      butlerName: "Dot",
      userName: "Shine",
    });
    const updated = await engine.updateButlerProfile(validInput);
    assert.deepEqual(updated, { ok: true, butlerName: "Dot", userName: "Shine" });
    await new Promise((r) => setTimeout(r, 160));
    assert.ok(broadcasted.some((b) => b.butlerName === "Dot" && b.userName === "Shine"));

    await engine.stop();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ProactiveEngine single-stream sendChatMessage: L0 commands, warm L1 self-healing, Two-Beat escalation, L1 timeout->L2 fallback, Sentinel sync, and silent isolation", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-engine-e2e-"));
  try {
    const store = new BotStateStore(tmpDir);
    const engine = new ProactiveEngine({ store, l1TimeoutMs: 50 });
    (engine as unknown as { settings: typeof DEFAULT_BOT_SETTINGS }).settings = {
      ...DEFAULT_BOT_SETTINGS,
      homeCwd: tmpDir,
      memoryFilePath: path.join(tmpDir, "MEMORY.md"),
      desktopNotify: false,
      webhookEnabled: false,
    };

    interface MockAgentRecord {
      id: string;
      provider: string;
      thinkingOptionId?: string;
      role?: string;
      archivedAt: string | null;
      status: string;
      lastPrompt?: string;
    }

    const createdAgents = new Map<string, MockAgentRecord>();
    let agentSeq = 0;
    let nextL1Mode: "reply" | "escalate_l2" | "timeout" = "reply";

    const makeAgentHandle = (rec: MockAgentRecord) => ({
      id: rec.id,
      workspaceId: "wks_home",
      cwd: tmpDir,
      refresh: async () => ({
        agent: {
          id: rec.id,
          workspaceId: "wks_home",
          cwd: tmpDir,
          provider: rec.provider.split("/")[0],
          model: rec.provider.split("/")[1],
          status: rec.status,
          archivedAt: rec.archivedAt,
        },
        project: null,
      }),
      run: async (prompt: string) => {
        rec.lastPrompt = prompt;
        if (rec.role === "butler-l1") {
          if (nextL1Mode === "timeout") {
            await new Promise((r) => setTimeout(r, 150));
            return { status: "idle", lastMessage: "too late" };
          }
          if (nextL1Mode === "escalate_l2") {
            engine.recordL1Escalation(rec.id, {
              targetTier: "L2",
              ackBubble: "我先查这 4 条 Tunnel 对应的主机与登录权限，不会同时重启。",
              handoffBrief: "核查 Cloudflare Tunnel 状态与本机 SSH 权限",
            });
            return { status: "idle", lastMessage: "" };
          }
          return {
            status: "idle",
            lastMessage: "嗨！今天手头有什么需要我先盯着的事吗？",
          };
        }
        return { status: "idle", lastMessage: "已完成。" };
      },
      waitForFinish: async () => ({
        status: "idle",
        lastMessage:
          "我在 Cloudflare 控制台核实了：**4 条 Tunnel 当前在线**，本机还没有对应主机 SSH 登录权限，所以暂未重启任何服务。[查看控制台](https://one.dash.cloudflare.com/)",
      }),
      send: async () => undefined,
      archive: async () => {
        rec.archivedAt = new Date().toISOString();
      },
      timeline: {
        refetch: async () => ({ entries: [] }),
        append: async () => ({ seq: 1, epoch: "e1" }),
      },
    });

    const mockPaseo = {
      providers: {
        snapshot: async () => ({
          entries: [
            {
              provider: "antigravity",
              label: "Antigravity",
              enabled: true,
              status: "ready",
              models: [
                { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
                { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" },
                { id: "gemini-4-carbon", label: "Gemini 4 Carbon", isDefault: true },
                { id: "gemini-4-neon", label: "Gemini 4 Neon" },
              ],
              modes: [{ id: "auto" }, { id: "full-access" }],
            },
          ],
        }),
        listModes: async () => ({ modes: [{ id: "auto" }, { id: "full-access" }] }),
      },
      workspaces: {
        list: async () => ({ entries: [] }),
        open: async () => ({
          id: "wks_home",
          agents: {
            create: async (opts: {
              config: { provider: string; thinkingOptionId?: string };
              labels?: Record<string, string>;
              prompt?: string;
            }) => {
              agentSeq += 1;
              const rec: MockAgentRecord = {
                id: `agt_mock_${agentSeq}`,
                provider: opts.config.provider,
                thinkingOptionId: opts.config.thinkingOptionId,
                role: opts.labels?.["paseo-bot/role"],
                archivedAt: null,
                status: "idle",
                lastPrompt: opts.prompt,
              };
              createdAgents.set(rec.id, rec);
              return makeAgentHandle(rec);
            },
          },
        }),
      },
      agents: {
        list: async () => ({ entries: [] }),
        ref: (id: string) => {
          const found = createdAgents.get(id);
          if (!found) {
            return {
              id,
              refresh: async () => null,
              archive: async () => undefined,
              timeline: { append: async () => ({ seq: 1, epoch: "e1" }) },
            };
          }
          return makeAgentHandle(found);
        },
      },
    } as unknown as PaseoApi;

    engine.attachPaseo(mockPaseo);

    // 1. Validate RPC schemas
    assert.equal(sendChatMessageRpc.input.safeParse({ text: "   " }).success, false);
    assert.equal(sendChatMessageRpc.input.safeParse({ text: "嗨" }).success, true);
    assert.equal(markMessagesReadRpc.input.safeParse({}).success, true);

    // 2. L0 zero-token /pause & /resume
    const pauseRes = await engine.sendChatMessage({ text: "/pause" });
    assert.equal(pauseRes.tier, "L0");
    assert.equal(engine.getSettings().globalPaused, true);
    assert.equal(createdAgents.size, 0); // Zero model calls!

    const resumeRes = await engine.sendChatMessage({ text: "/resume" });
    assert.equal(resumeRes.tier, "L0");
    assert.equal(engine.getSettings().globalPaused, false);
    assert.equal(store.get().routingTelemetry.l0Hits, 2);

    // 3. L1 fast warm session + archived self-healing
    const chat1 = await engine.sendChatMessage({ text: "嗨" });
    assert.equal(chat1.tier, "L1");
    assert.equal(chat1.modelUsed, "antigravity/gemini-3.8-flash");
    const firstL1Id = store.get().l1AgentId!;
    assert.ok(firstL1Id);
    assert.equal(createdAgents.get(firstL1Id)?.thinkingOptionId, "low");

    // Archive L1 behind the scenes -> next L1 turn self-heals transparently with a new L1 session
    createdAgents.get(firstL1Id)!.archivedAt = new Date().toISOString();
    const chat2 = await engine.sendChatMessage({ text: "谢谢" });
    assert.equal(chat2.tier, "L1");
    const healedL1Id = store.get().l1AgentId!;
    assert.notEqual(healedL1Id, firstL1Id);

    // 4. L1 -> L2 Two-Beat Handoff via paseo_bot_escalate_task
    nextL1Mode = "escalate_l2";
    const handoffRes = await engine.sendChatMessage({
      text: "那个连接器你可以帮我升级一下吗",
    });
    assert.equal(handoffRes.tier, "L1");
    assert.equal(handoffRes.escalatedTo, "L2");
    assert.ok(handoffRes.ackMessageId);

    // Beat 1 ack bubble is immediately in "thinking" state before Beat 2 finishes
    const ackBefore = store.get().messages.find((m) => m.id === handoffRes.ackMessageId)!;
    assert.equal(ackBefore.kind, "ack");
    assert.match(ackBefore.text, /不会同时重启/);

    await engine.waitForBackgroundChatTasks();

    const ackAfter = store.get().messages.find((m) => m.id === handoffRes.ackMessageId)!;
    assert.equal(ackAfter.status, "done");
    const beat2Msg = store
      .get()
      .messages.find((m) => m.replyToMessageId === handoffRes.ackMessageId)!;
    assert.ok(beat2Msg);
    assert.equal(beat2Msg.kind, "chat");
    assert.equal(beat2Msg.tier, "L2");
    assert.equal(beat2Msg.modelUsed, "antigravity/gemini-4-carbon");
    assert.equal(beat2Msg.links[0]?.url, "https://one.dash.cloudflare.com/");

    // 5. L1 >18s timeout -> resets l1AgentId, increments fallbackCount, seamlessly falls back to L2
    nextL1Mode = "timeout";
    const beforeFallbacks = store.get().routingTelemetry.fallbackCount;
    const timeoutRes = await engine.sendChatMessage({ text: "还在吗？" });
    assert.equal(timeoutRes.tier, "L2");
    assert.equal(timeoutRes.escalatedTo, "L2");
    assert.equal(store.get().l1AgentId, null);
    assert.equal(store.get().routingTelemetry.fallbackCount, beforeFallbacks + 1);
    await engine.waitForBackgroundChatTasks();

    // 6. Silent outcome NEVER pollutes single-stream messages
    const msgCountBeforeSilent = store.get().messages.length;
    const l0BeforeSilent = store.get().routingTelemetry.l0Hits;
    await engine.pushFeed({
      level: "silent",
      title: "无变化跳过：巡检",
      summary: "无实质变化",
    });
    assert.equal(store.get().messages.length, msgCountBeforeSilent);
    assert.equal(store.get().routingTelemetry.l0Hits, l0BeforeSilent + 1);

    // 7. Sentinel approval creation & resolution syncs inline approval message + markMessagesRead
    const apr = await engine.createApproval({
      title: "外发确认邮件",
      actionSummary: "向 partner@example.com 发送确认函",
      payloadPreview: "To: partner@example.com\nSubject: Confirm",
      riskLevel: "high",
      followUpPrompt: "Send confirmed email",
      cwd: tmpDir,
    });
    const inlineAprMsg = store.get().messages.find((m) => m.approvalId === apr.id);
    assert.ok(inlineAprMsg);
    assert.equal(inlineAprMsg.kind, "approval");
    assert.equal(inlineAprMsg.unread, true);

    await engine.resolveApproval({ id: apr.id, decision: "rejected", note: "暂不发送" });
    const syncedAprMsg = store.get().messages.find((m) => m.approvalId === apr.id)!;
    assert.equal(syncedAprMsg.unread, false);
    assert.equal(syncedAprMsg.status, "done");
    assert.equal(store.get().approvals[0].status, "rejected");

    const readRes = await engine.markMessagesRead();
    assert.equal(readRes.ok, true);
    const finalSnap = await engine.getSnapshot();
    assert.equal(finalSnap.unreadCount, 0);

    await engine.stop();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("T-004A ADR-004 dev noise gate: skips placeholders/company intermediate/repeat turns, syncs releases with <=220 conclusion + details + origin session link", async () => {
  // 1. Pure unit assertions on evaluateWorkerTurnForStream
  assert.deepEqual(
    evaluateWorkerTurnForStream({
      text: "   ",
      title: "检查日志",
      outcomeKind: "completed",
      workerId: "wrk_1",
    }),
    { shouldSync: false, reason: "empty_or_placeholder" },
  );
  assert.deepEqual(
    evaluateWorkerTurnForStream({
      text: "处理完成。",
      title: "日常任务",
      outcomeKind: "completed",
      workerId: "wish_1",
    }),
    { shouldSync: false, reason: "empty_or_placeholder" },
  );
  assert.deepEqual(
    evaluateWorkerTurnForStream({
      text: "Done.",
      outcomeKind: "completed",
      workerId: "wrk_1",
    }),
    { shouldSync: false, reason: "empty_or_placeholder" },
  );

  // AI company intermediate choreography (labels or [HANDOFF]/[DISPATCH]/[GATE] or dept title) -> skipped!
  assert.equal(
    evaluateWorkerTurnForStream({
      text: "[HANDOFF] 工单交付 · T-002\n- 当前状态：READY_FOR_GATE\n- 基线：v0.3.0-baseline",
      title: "[插件] 分流引擎部",
      labels: { company: "paseo-bot-studio", dept: "routing-engine" },
      outcomeKind: "completed",
      workerId: "wish_company_1",
    }).shouldSync,
    false,
  );
  assert.equal(
    evaluateWorkerTurnForStream({
      text: "正在排查组件样式对齐问题，自测中。",
      title: "气泡前端部",
      outcomeKind: "completed",
      workerId: "wish_company_2",
    }).shouldSync,
    false,
  );

  // Repeat interactive turn without release signal -> skipped!
  assert.deepEqual(
    evaluateWorkerTurnForStream({
      text: "我已经把按钮圆角从 12px 调整到了 20px，你可以再看下效果。",
      title: "[插件] 优化输入框细节",
      outcomeKind: "completed",
      isRepeatInteractiveTurn: true,
      workerId: "wish_ui_chat",
    }),
    { shouldSync: false, reason: "repeat_interactive_turn" },
  );

  // Release / Ship / Milestone signals -> ALWAYS synced (even inside company or repeat session)!
  const releaseReport = [
    "### 发版说明",
    "**Paseo Bot v0.4.0 已正式发布上线**，完成 Dot 风单流对话与 L0–L3 分层路由全量闭环，并已推送 main 分支。",
    "",
    "| 模块 | 变更详情 | 状态 |",
    "|---|---|---|",
    "| 气泡前端 | 单流对话 + 胶囊输入框 + 左上角抽屉 | 已完成 |",
    "| 分流引擎 | L0 零消耗 + L1 秒回 + L2/L3 两拍交棒 | 已完成 |",
    "",
    "```bash",
    "git tag v0.4.0 && git push origin main --tags",
    "```",
    ...Array.from({ length: 12 }, (_, i) => `- 详细验收记录条目 #${i + 1}：全量 36 项自动化单测绿灯通过`),
  ].join("\n");

  const releaseEval = evaluateWorkerTurnForStream({
    text: releaseReport,
    title: "[插件] 管家总舵",
    labels: { company: "paseo-bot-studio" },
    isRepeatInteractiveTurn: true,
    outcomeKind: "completed",
    workerId: "wish_lead",
  });
  assert.deepEqual(releaseEval, { shouldSync: true, reason: "release_or_milestone" });

  // First-time background delegated worker & failed outcomes -> synced!
  assert.equal(
    evaluateWorkerTurnForStream({
      text: "00-Inbox 两篇新笔记已归档至 30-Wiki 并更新索引。",
      title: "整理收件箱",
      outcomeKind: "completed",
      workerId: "wrk_inbox_1",
    }).shouldSync,
    true,
  );
  assert.equal(
    evaluateWorkerTurnForStream({
      text: "",
      title: "部署脚本",
      outcomeKind: "failed",
      labels: { company: "paseo-bot-studio" },
      workerId: "wish_lead",
    }).shouldSync,
    true,
  );

  // 2. buildConclusionSummary condenses verbose markdown/code/tables into <=220 chars + details
  const condensed = buildConclusionSummary(releaseReport, "[插件] Paseo Bot 发版", 220);
  assert.ok(condensed.text.length <= 220, `Expected <=220 chars, got ${condensed.text.length}`);
  assert.match(condensed.text, /v0\.4\.0.*已正式发布上线/);
  assert.doesNotMatch(condensed.text, /```|\|---/);
  assert.equal(condensed.details, releaseReport);

  // 3. projectLegacyFeedToMessages & BotStateStore.load purge "处理完成。" and attach paseo://agent/<id>
  const projected = projectLegacyFeedToMessages([
    {
      id: "f_placeholder",
      createdAt: "2026-11-28T03:00:00.000Z",
      level: "worker_update",
      title: "已完成：测试",
      summary: "处理完成。",
      agentId: "agt_noise",
      actions: [],
      inProgress: false,
      unread: true,
    },
    {
      id: "f_company_mid",
      createdAt: "2026-11-28T03:05:00.000Z",
      level: "worker_update",
      title: "已完成：气泡前端部",
      summary: "[HANDOFF] 工单交付 · T-003 待门禁审查",
      agentId: "agt_ui",
      actions: [],
      inProgress: false,
      unread: true,
    },
    {
      id: "f_release",
      createdAt: "2026-11-28T03:10:00.000Z",
      level: "worker_update",
      title: "已完成：Paseo Bot v0.4.0 发版",
      summary: releaseReport,
      agentId: "agt_rel_040",
      actions: [],
      inProgress: false,
      unread: true,
    },
  ]);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].id, "msg_legacy_f_release");
  assert.ok(projected[0].text.length <= 220);
  assert.equal(projected[0].details, releaseReport);
  assert.ok(
    projected[0].links.some(
      (l) => l.url === "paseo://agent/agt_rel_040" && l.kind === "agent",
    ),
  );

  // 4. End-to-end engine agent.turn.before / agent.turn.after lifecycle + storage load cleanup
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-t004a-"));
  try {
    // Seed state.json with a stale "处理完成。" message & an agent-backed proactive message missing jump link
    await fs.writeFile(
      path.join(tmpDir, "state.json"),
      JSON.stringify({
        messages: [
          {
            id: "msg_stale_done",
            createdAt: "2026-11-28T01:00:00.000Z",
            role: "assistant",
            kind: "proactive",
            text: "处理完成。",
            status: "done",
            unread: true,
          },
          {
            id: "msg_real_hist",
            createdAt: "2026-11-28T01:05:00.000Z",
            role: "assistant",
            kind: "proactive",
            text: "v0.3.2 已上线，修复了热重载问题。",
            agentId: "agt_hist_1",
            links: [],
            status: "done",
            unread: false,
          },
        ],
        workers: [
          {
            id: "wish_dev_session",
            agentId: "agt_dev_1",
            workspaceId: "wks_dev",
            title: "重构单流输入框",
            cwd: tmpDir,
            provider: "antigravity/gemini-4-carbon",
            isolation: "local",
            status: "running",
            goal: "refactor composer",
            notifyChiefOnFinish: false,
            createdAt: "2026-11-28T02:00:00.000Z",
            updatedAt: "2026-11-28T02:00:00.000Z",
          },
          {
            id: "wish_company_lead",
            agentId: "agt_company_lead",
            workspaceId: "wks_company",
            title: "管家总舵",
            cwd: tmpDir,
            provider: "antigravity/gemini-4-neon",
            isolation: "local",
            status: "running",
            goal: "coordinate release",
            notifyChiefOnFinish: false,
            createdAt: "2026-11-28T02:00:00.000Z",
            updatedAt: "2026-11-28T02:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const store = new BotStateStore(tmpDir);
    const loaded = await store.load();
    // Stale "处理完成。" was purged on load, while real message got paseo://agent/agt_hist_1 jump link
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0].id, "msg_real_hist");
    assert.equal(loaded.messages[0].links[0]?.url, "paseo://agent/agt_hist_1");

    const hooks = new Map<string, (event: unknown, ctx: { paseo: PaseoApi }) => Promise<void>>();
    const fakeServer = {
      addHook(name: string, fn: (event: unknown, ctx: { paseo: PaseoApi }) => Promise<void>) {
        hooks.set(name, fn);
        return () => undefined;
      },
    } as unknown as PluginServerContext;

    const fakeSettings = {
      read: async () => ({
        status: "ready" as const,
        values: {
          ...DEFAULT_BOT_SETTINGS,
          homeCwd: tmpDir,
          memoryFilePath: path.join(tmpDir, "MEMORY.md"),
          desktopNotify: false,
          webhookEnabled: false,
        },
      }),
      subscribe: () => () => undefined,
    };

    let timelineReplyByAgent: Record<string, string> = {};
    let labelsByAgent: Record<string, Record<string, string>> = {
      agt_company_lead: { company: "paseo-bot-studio", dept: "butler-lead" },
    };

    const fakePaseo = {
      workspaces: { list: async () => ({ entries: [] }) },
      agents: {
        list: async () => ({ entries: [] }),
        ref: (id: string) => ({
          id,
          current: () => ({ id, labels: labelsByAgent[id] ?? {} }),
          refresh: async () => ({
            agent: { id, labels: labelsByAgent[id] ?? {}, archivedAt: null, status: "idle" },
            project: null,
          }),
          timeline: {
            refetch: async () => ({
              entries: timelineReplyByAgent[id]
                ? [
                    {
                      turnId: "t1",
                      item: { type: "assistant_message", text: timelineReplyByAgent[id] },
                    },
                  ]
                : [],
            }),
            append: async () => ({ seq: 1, epoch: "e1" }),
          },
        }),
      },
    } as unknown as PaseoApi;

    const engine = new ProactiveEngine({ store });
    await engine.start(fakeServer, fakeSettings as never);
    engine.attachPaseo(fakePaseo);

    const turnBefore = hooks.get("agent.turn.before")!;
    const turnAfter = hooks.get("agent.turn.after")!;

    // Case A: Empty turn reply ("处理完成。" fallback previously) -> MUST NOT enter messages!
    timelineReplyByAgent.agt_dev_1 = "";
    await turnAfter(
      {
        agent: { id: "agt_dev_1", cwd: tmpDir, title: "重构单流输入框", background: false },
        turnId: "t1",
        outcome: { kind: "completed" },
      },
      { paseo: fakePaseo },
    );
    assert.equal(store.get().messages.length, 1); // unchanged!

    // Case B: Second interactive chat turn in agt_dev_1 (normal dev reply) -> MUST NOT spam messages!
    await turnBefore(
      {
        agent: { id: "agt_dev_1", cwd: tmpDir, title: "重构单流输入框", background: false },
        turnId: "t2",
      },
      { paseo: fakePaseo },
    );
    timelineReplyByAgent.agt_dev_1 = "已把胶囊输入框阴影调柔和了一些，请再预览下。";
    await turnAfter(
      {
        agent: { id: "agt_dev_1", cwd: tmpDir, title: "重构单流输入框", background: false },
        turnId: "t1",
        outcome: { kind: "completed" },
      },
      { paseo: fakePaseo },
    );
    assert.equal(store.get().messages.length, 1); // still zero spam!

    // Case C: Company session intermediate dispatch/gate -> MUST NOT enter messages!
    timelineReplyByAgent.agt_company_lead =
      "[DISPATCH] 原子工单派发 · T-004B 请气泡前端部调整内联链接跳转。";
    await turnAfter(
      {
        agent: { id: "agt_company_lead", cwd: tmpDir, title: "管家总舵", background: false },
        turnId: "t1",
        outcome: { kind: "completed" },
      },
      { paseo: fakePaseo },
    );
    assert.equal(store.get().messages.length, 1);

    // Case D: Company session ships RELEASED v0.4.0 -> Synced as concise conclusion + details + paseo://agent/agt_company_lead!
    await turnBefore(
      {
        agent: { id: "agt_company_lead", cwd: tmpDir, title: "管家总舵", background: false },
        turnId: "t3",
      },
      { paseo: fakePaseo },
    );
    timelineReplyByAgent.agt_company_lead = releaseReport;
    await turnAfter(
      {
        agent: { id: "agt_company_lead", cwd: tmpDir, title: "Paseo Bot v0.4.0 发版", background: false },
        turnId: "t1",
        outcome: { kind: "completed" },
      },
      { paseo: fakePaseo },
    );

    assert.equal(store.get().messages.length, 2);
    const releaseBubble = store.get().messages[1];
    assert.equal(releaseBubble.kind, "proactive");
    assert.ok(releaseBubble.text.length <= 220);
    assert.match(releaseBubble.text, /v0\.4\.0.*已正式发布上线/);
    assert.equal(releaseBubble.details, releaseReport);
    assert.ok(
      releaseBubble.links.some(
        (l) => l.url === "paseo://agent/agt_company_lead" && l.kind === "agent",
      ),
    );

    await engine.stop();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("T-008A: stopped reload guard, reconcileOrphanThinkingAcks self-healing, L2 failure closure, and getSnapshot 80%+ slimming", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-t008a-"));
  try {
    // 1. Stopped state during in-flight L1 IPC failure does NOT write orphan ack or increment fallbackCount
    const store1 = new BotStateStore(tmpDir);
    await store1.load();
    const engine1 = new ProactiveEngine({ store: store1, l1TimeoutMs: 500 });
    (engine1 as unknown as { settings: typeof DEFAULT_BOT_SETTINGS }).settings = {
      ...DEFAULT_BOT_SETTINGS,
      homeCwd: tmpDir,
      memoryFilePath: path.join(tmpDir, "MEMORY.md"),
      desktopNotify: false,
      webhookEnabled: false,
    };

    let spawnedL2Count = 0;
    const reloadPaseoMock = {
      providers: {
        snapshot: async () => ({
          entries: [
            {
              provider: "antigravity",
              label: "Antigravity",
              enabled: true,
              status: "ready",
              models: [
                { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
                { id: "gemini-4-carbon", label: "Gemini 4 Carbon", isDefault: true },
              ],
              modes: [{ id: "auto" }],
            },
          ],
        }),
        listModes: async () => ({ modes: [{ id: "auto" }] }),
      },
      workspaces: {
        list: async () => ({ entries: [] }),
        open: async () => ({
          id: "ws_1",
          agents: {
            create: async (opts: { labels?: Record<string, string> }) => {
              const role = opts.labels?.["paseo-bot/role"];
              if (role === "butler-exec") {
                spawnedL2Count += 1;
              }
              return {
                id: role === "butler-l1" ? "agt_l1_reload" : "agt_l2_should_not_run",
                workspaceId: "ws_1",
                run: async () => {
                  // Simulate `paseo plugin reload` interrupting in-flight L1 IPC
                  await engine1.stop();
                  throw new Error("IPC channel closed during plugin reload");
                },
                waitForFinish: async () => ({ status: "idle" as const, lastMessage: "ok" }),
                timeline: { refetch: async () => ({ entries: [] }) },
                archive: async () => undefined,
              };
            },
          },
        }),
      },
      agents: {
        list: async () => ({ entries: [] }),
        ref: (id: string) => ({
          id,
          refresh: async () => ({
            agent: { id, status: "idle", provider: "antigravity", model: "gemini-3.8-flash" },
          }),
          run: async () => {
            await engine1.stop();
            throw new Error("IPC channel closed during plugin reload");
          },
          waitForFinish: async () => ({ status: "idle" as const, lastMessage: "ok" }),
          timeline: { refetch: async () => ({ entries: [] }) },
          archive: async () => undefined,
        }),
      },
    };
    (engine1 as unknown as { paseo: unknown }).paseo = reloadPaseoMock;

    const resReload = await engine1.sendChatMessage({ text: "还在吗？" });
    assert.equal(resReload.ackMessageId, undefined);
    assert.ok(resReload.assistantMessageId);
    assert.equal(spawnedL2Count, 0);
    assert.equal(store1.get().routingTelemetry.fallbackCount, 0);
    assert.equal(
      store1.get().messages.some((m) => m.kind === "ack" || m.status === "thinking"),
      false,
    );
    const interruptedBubble = store1
      .get()
      .messages.find((m) => m.id === resReload.assistantMessageId)!;
    assert.equal(interruptedBubble.status, "error");
    assert.match(interruptedBubble.text, /重启中断.*重发/);

    // 2. Startup reconcileOrphanThinkingAcks() heals stuck orphan thinking acks without harming replied or active-worker acks
    const store2Dir = path.join(tmpDir, "restart-heal");
    const store2 = new BotStateStore(store2Dir);
    await store2.load();
    await store2.mutate((draft) => {
      draft.workers.push({
        id: "wrk_running_1",
        agentId: "agt_active_worker",
        title: "核查账单",
        cwd: store2Dir,
        provider: "antigravity/gemini-4-carbon",
        isolation: "local",
        status: "running",
        goal: "Check billing",
        notifyChiefOnFinish: true,
        createdAt: "2026-11-28T08:00:00.000Z",
        updatedAt: "2026-11-28T08:00:00.000Z",
      });
      draft.messages = [
        // Case A: Stuck orphan ack followed later by a new user turn & reply -> MUST heal!
        {
          id: "u_orphan",
          createdAt: "2026-11-28T07:50:00.000Z",
          role: "user",
          kind: "chat",
          text: "帮我查一下快递",
          images: [],
          links: [],
          quickActions: [],
          status: "done",
          unread: false,
        },
        {
          id: "ack_orphan",
          createdAt: "2026-11-28T07:50:01.000Z",
          role: "assistant",
          kind: "ack",
          text: "我先帮你核查一下，确认清楚后马上回复你。",
          images: [],
          links: [],
          quickActions: [],
          tier: "L2",
          status: "thinking",
          replyToMessageId: "u_orphan",
          unread: false,
        },
        // Case B: Ack that already has an assistant chat reply -> MUST NOT touch!
        {
          id: "u_answered",
          createdAt: "2026-11-28T07:55:00.000Z",
          role: "user",
          kind: "chat",
          text: "查一下域名到期日",
          images: [],
          links: [],
          quickActions: [],
          status: "done",
          unread: false,
        },
        {
          id: "ack_answered",
          createdAt: "2026-11-28T07:55:01.000Z",
          role: "assistant",
          kind: "ack",
          text: "正在查域名注册信息…",
          images: [],
          links: [],
          quickActions: [],
          tier: "L2",
          status: "thinking",
          replyToMessageId: "u_answered",
          unread: false,
        },
        {
          id: "chat_answer",
          createdAt: "2026-11-28T07:55:05.000Z",
          role: "assistant",
          kind: "chat",
          text: "域名将于 **2027-05-01** 到期。",
          images: [],
          links: [],
          quickActions: [],
          tier: "L2",
          status: "done",
          replyToMessageId: "ack_answered",
          unread: true,
        },
        // Case C: Ack linked to an active running worker -> MUST NOT touch!
        {
          id: "ack_active_worker",
          createdAt: "2026-11-28T08:00:01.000Z",
          role: "assistant",
          kind: "ack",
          text: "正在后台核查账单…",
          images: [],
          links: [],
          quickActions: [],
          tier: "L2",
          status: "thinking",
          agentId: "agt_active_worker",
          unread: false,
        },
      ];
    });

    const engine2 = new ProactiveEngine({ store: store2 });
    const memPath2 = path.join(store2Dir, "MEMORY.md");
    await fs.writeFile(memPath2, "# 管家记忆\n- 偏好简洁结论\n", "utf8");
    (engine2 as unknown as { settings: typeof DEFAULT_BOT_SETTINGS }).settings = {
      ...DEFAULT_BOT_SETTINGS,
      homeCwd: store2Dir,
      memoryFilePath: memPath2,
      desktopNotify: false,
      webhookEnabled: false,
    };

    const healedCount = await engine2.reconcileOrphanThinkingAcks();
    assert.equal(healedCount, 1);

    const msgsAfterHeal = store2.get().messages;
    const healedOrphan = msgsAfterHeal.find((m) => m.id === "ack_orphan")!;
    assert.equal(healedOrphan.status, "error");
    assert.equal(healedOrphan.text, "刚才插件正好重启中断了，你可以直接重发这条消息。");
    assert.equal(healedOrphan.unread, false);

    const sparedAnswered = msgsAfterHeal.find((m) => m.id === "ack_answered")!;
    assert.equal(sparedAnswered.status, "thinking");
    assert.equal(sparedAnswered.text, "正在查域名注册信息…");

    const sparedWorkerAck = msgsAfterHeal.find((m) => m.id === "ack_active_worker")!;
    assert.equal(sparedWorkerAck.status, "thinking");
    assert.equal(sparedWorkerAck.text, "正在后台核查账单…");

    // 2b. dispatchTwoBeatExecution exception flips ack from "thinking" -> "error" and appends readable error bubble
    const failingL2Mock = {
      providers: {
        snapshot: async () => ({
          entries: [
            {
              provider: "antigravity",
              label: "Antigravity",
              enabled: true,
              status: "ready",
              models: [{ id: "gemini-4-carbon", label: "Gemini 4 Carbon", isDefault: true }],
              modes: [{ id: "auto" }],
            },
          ],
        }),
        listModes: async () => ({ modes: [{ id: "auto" }] }),
      },
      workspaces: {
        list: async () => ({ entries: [] }),
        open: async () => ({
          id: "ws_boom",
          agents: {
            create: async () => ({
              id: "agt_l2_boom",
              workspaceId: "ws_boom",
              run: async () => ({ status: "error" as const, error: "upstream quota exhausted" }),
              waitForFinish: async () => ({
                status: "error" as const,
                error: "upstream quota exhausted",
              }),
              timeline: { refetch: async () => ({ entries: [] }) },
              archive: async () => undefined,
            }),
          },
        }),
      },
      agents: {
        list: async () => ({ entries: [] }),
      },
    };
    (engine2 as unknown as { paseo: unknown }).paseo = failingL2Mock;
    const l2FailRes = await engine2.sendChatMessage({
      text: "帮我查一下收件箱最新账单邮件",
    });
    assert.ok(l2FailRes.ackMessageId);
    await engine2.waitForBackgroundChatTasks();
    const ackAfterBoom = store2.get().messages.find((m) => m.id === l2FailRes.ackMessageId)!;
    assert.equal(ackAfterBoom.status, "error");
    const errBubbleAfterBoom = store2
      .get()
      .messages.find((m) => m.replyToMessageId === l2FailRes.ackMessageId && m.kind === "chat")!;
    assert.ok(errBubbleAfterBoom);
    assert.equal(errBubbleAfterBoom.status, "error");
    assert.match(errBubbleAfterBoom.text, /出了点小状况.*upstream quota exhausted/);

    // 3. getSnapshot() payload slimming (80%+ reduction) & BotSnapshotSchema compatibility + disk preservation
    const hugeDetails = "明细行内容 ABCDEFGHIJ 1234567890\n".repeat(220); // ~6000 chars
    await store2.mutate((draft) => {
      draft.feed = Array.from({ length: 50 }, (_, idx) => ({
        id: `f_${idx}`,
        createdAt: new Date(Date.now() - idx * 1000).toISOString(),
        level: "notify" as const,
        title: `历史推送 ${idx}`,
        summary: `摘要 ${idx}`,
        details: hugeDetails,
        actions: [],
        unread: false,
        inProgress: false,
      }));
      draft.messages = Array.from({ length: 65 }, (_, idx) => ({
        id: `m_${idx}`,
        createdAt: new Date(Date.now() - (65 - idx) * 1000).toISOString(),
        role: idx % 2 === 0 ? ("user" as const) : ("assistant" as const),
        kind: "chat" as const,
        text: `对话消息 #${idx}`,
        details: idx % 2 === 1 ? hugeDetails : undefined,
        images: [],
        links: [],
        quickActions: [],
        status: "done" as const,
        unread: false,
      }));
      draft.workers = Array.from({ length: 24 }, (_, idx) => ({
        id: `w_${idx}`,
        agentId: `agt_w_${idx}`,
        title: `任务 ${idx}`,
        cwd: store2Dir,
        provider: "antigravity/gemini-4-carbon",
        isolation: "local" as const,
        status: idx === 20 || idx === 22 ? ("running" as const) : ("completed" as const),
        goal: `Goal ${idx}`,
        notifyChiefOnFinish: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      draft.approvals = Array.from({ length: 24 }, (_, idx) => ({
        id: `apr_${idx}`,
        createdAt: new Date().toISOString(),
        title: `审批 ${idx}`,
        actionSummary: `Summary ${idx}`,
        riskLevel: "medium" as const,
        status: idx === 19 || idx === 23 ? ("pending" as const) : ("approved" as const),
        followUpPrompt: "go",
        cwd: store2Dir,
      }));
    });

    const snap = await engine2.getSnapshot();
    const parsed = BotSnapshotSchema.parse(snap);
    assert.deepEqual(parsed.feed, []);
    assert.equal(store2.get().feed.length, 50); // Disk state.feed untouched!

    assert.equal(parsed.messages.length, 40);
    assert.equal(parsed.messages[0]?.id, "m_25");
    assert.equal(parsed.messages[39]?.id, "m_64");

    // Older message outside latest 12 has details lightly trimmed in snapshot view, while disk retains full details
    const oldAssistantInSnap = parsed.messages.find((m) => m.id === "m_27")!;
    assert.ok(oldAssistantInSnap.details && oldAssistantInSnap.details.length < 2600);
    assert.match(oldAssistantInSnap.details!, /历史长明细已折叠省略/);
    assert.equal(
      store2.get().messages.find((m) => m.id === "m_27")!.details?.length,
      hugeDetails.length,
    );

    // Latest 12 messages preserve full details untouched
    const recentAssistantInSnap = parsed.messages.find((m) => m.id === "m_63")!;
    assert.equal(recentAssistantInSnap.details?.length, hugeDetails.length);

    // Workers & approvals capped at 15 while preserving 100% of running/permission & pending items
    assert.equal(parsed.workers.length, 15);
    assert.ok(parsed.workers.some((w) => w.id === "w_20" && w.status === "running"));
    assert.ok(parsed.workers.some((w) => w.id === "w_22" && w.status === "running"));

    assert.equal(parsed.approvals.length, 15);
    assert.ok(parsed.approvals.some((a) => a.id === "apr_19" && a.status === "pending"));
    assert.ok(parsed.approvals.some((a) => a.id === "apr_23" && a.status === "pending"));

    // Payload size reduction verification (>80% smaller than raw persisted state)
    const rawStateBytes = Buffer.byteLength(JSON.stringify(store2.get()), "utf8");
    const snapBytes = Buffer.byteLength(JSON.stringify(snap), "utf8");
    assert.ok(
      snapBytes < rawStateBytes * 0.25,
      `Expected snapshot (${snapBytes}B) to be <25% of raw state (${rawStateBytes}B)`,
    );

    // MEMORY.md mtimeMs cache hit avoids redundant fs.readFile calls
    let readFileCalls = 0;
    const origReadFile = fs.readFile.bind(fs);
    (fs as unknown as { readFile: typeof fs.readFile }).readFile = (async (
      ...args: Parameters<typeof fs.readFile>
    ) => {
      if (String(args[0]) === path.resolve(memPath2)) {
        readFileCalls += 1;
      }
      return origReadFile(...args);
    }) as typeof fs.readFile;
    try {
      const m1 = await store2.readMemory(memPath2);
      const m2 = await store2.readMemory(memPath2);
      const m3 = await store2.readMemory(memPath2);
      assert.equal(m1, m2);
      assert.equal(m2, m3);
      assert.equal(readFileCalls, 0); // Already cached from getSnapshot() above!
    } finally {
      (fs as unknown as { readFile: typeof fs.readFile }).readFile = origReadFile;
    }

    await engine2.stop();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Warm L1 & Chief session reuse validates latest provider/model/thinking config and auto-rebuilds on change", async () => {
  // 1. Unit assertions for extractAgentModelPair & doesAgentMatchExpectedConfig
  const flashAgent = {
    provider: "antigravity",
    model: "gemini-3.8-flash",
    thinkingOptionId: "low",
    cwd: "/Users/demo/KnowledgeBase/",
  };
  assert.equal(extractAgentModelPair(flashAgent), "antigravity/gemini-3.8-flash");
  assert.equal(
    doesAgentMatchExpectedConfig(flashAgent, {
      providerModel: "antigravity/gemini-3.8-flash",
      thinkingOptionId: "low",
      cwd: "/Users/demo/KnowledgeBase",
    }),
    true,
  );
  // Model changed within same provider (e.g. gemini-3.8-flash -> gemini-4-neon) -> mismatch!
  assert.equal(
    doesAgentMatchExpectedConfig(flashAgent, {
      providerModel: "antigravity/gemini-4-neon",
      thinkingOptionId: "low",
    }),
    false,
  );
  // Provider changed -> mismatch!
  assert.equal(
    doesAgentMatchExpectedConfig(flashAgent, {
      providerModel: "codex/gpt-5.4",
    }),
    false,
  );
  // Thinking level changed -> mismatch!
  assert.equal(
    doesAgentMatchExpectedConfig(flashAgent, {
      providerModel: "antigravity/gemini-3.8-flash",
      thinkingOptionId: "high",
    }),
    false,
  );
  // Home cwd changed -> mismatch!
  assert.equal(
    doesAgentMatchExpectedConfig(flashAgent, {
      providerModel: "antigravity/gemini-3.8-flash",
      cwd: "/Users/demo/OtherWorkspace",
    }),
    false,
  );
  // runtimeInfo fallback extraction works when top-level model is null
  assert.equal(
    extractAgentModelPair({
      provider: "antigravity",
      model: null,
      runtimeInfo: { provider: "antigravity", model: "gemini-4-neon" },
    }),
    "antigravity/gemini-4-neon",
  );

  // 2. End-to-end engine test: switching fastProvider / fastThinking / chiefProvider takes effect on very next turn
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-l1-model-switch-"));
  try {
    const store = new BotStateStore(tmpDir);
    const engine = new ProactiveEngine({ store });

    let currentSettings = {
      ...DEFAULT_BOT_SETTINGS,
      homeCwd: tmpDir,
      memoryFilePath: path.join(tmpDir, "MEMORY.md"),
      desktopNotify: false,
      webhookEnabled: false,
    };
    let settingsListener:
      | ((next: { status: "ready"; values: typeof currentSettings }) => Promise<void> | void)
      | null = null;

    const fakeServer = {
      addHook() {
        return () => undefined;
      },
    } as unknown as PluginServerContext;

    const fakeSettingsHandle = {
      read: async () => ({ status: "ready" as const, values: currentSettings }),
      subscribe: (
        fn: (next: { status: "ready"; values: typeof currentSettings }) => Promise<void> | void,
      ) => {
        settingsListener = fn;
        return () => {
          settingsListener = null;
        };
      },
    };

    interface SpawnedRec {
      id: string;
      providerPair: string;
      thinkingOptionId?: string;
      role?: string;
      archivedAt: string | null;
      status: string;
    }

    const spawned = new Map<string, SpawnedRec>();
    let seq = 0;

    const makeHandle = (rec: SpawnedRec) => ({
      id: rec.id,
      workspaceId: "wks_home",
      cwd: tmpDir,
      refresh: async () => ({
        agent: {
          id: rec.id,
          workspaceId: "wks_home",
          cwd: tmpDir,
          provider: rec.providerPair.split("/")[0],
          model: rec.providerPair.split("/")[1],
          thinkingOptionId: rec.thinkingOptionId ?? null,
          status: rec.status,
          archivedAt: rec.archivedAt,
        },
        project: null,
      }),
      run: async () => ({
        status: "idle" as const,
        lastMessage: `Replied via ${rec.providerPair}`,
      }),
      send: async () => undefined,
      archive: async () => {
        rec.archivedAt = new Date().toISOString();
      },
      timeline: {
        refetch: async () => ({ entries: [] }),
        append: async () => ({ seq: 1, epoch: "e1" }),
      },
    });

    const mockPaseo = {
      providers: {
        snapshot: async () => ({
          entries: [
            {
              provider: "antigravity",
              label: "Antigravity",
              enabled: true,
              status: "ready",
              models: [
                { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
                { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" },
                { id: "gemini-4-carbon", label: "Gemini 4 Carbon", isDefault: true },
                { id: "gemini-4-neon", label: "Gemini 4 Neon" },
              ],
              modes: [{ id: "auto" }],
            },
          ],
        }),
        listModes: async () => ({ modes: [{ id: "auto" }] }),
      },
      workspaces: {
        list: async () => ({ entries: [] }),
        open: async () => ({
          id: "wks_home",
          agents: {
            create: async (opts: {
              config: { provider: string; thinkingOptionId?: string };
              labels?: Record<string, string>;
            }) => {
              seq += 1;
              const rec: SpawnedRec = {
                id: `agt_${seq}`,
                providerPair: opts.config.provider,
                thinkingOptionId: opts.config.thinkingOptionId,
                role: opts.labels?.["paseo-bot/role"],
                archivedAt: null,
                status: "idle",
              };
              spawned.set(rec.id, rec);
              return makeHandle(rec);
            },
          },
        }),
      },
      agents: {
        list: async () => ({ entries: [] }),
        ref: (id: string) => {
          const rec = spawned.get(id);
          if (!rec) {
            return {
              id,
              refresh: async () => null,
              archive: async () => undefined,
              timeline: { append: async () => ({ seq: 1, epoch: "e1" }) },
            };
          }
          return makeHandle(rec);
        },
      },
    } as unknown as PaseoApi;

    await engine.start(fakeServer, fakeSettingsHandle as never);
    engine.attachPaseo(mockPaseo);

    // Turn 1: creates warm L1 with default gemini-3.8-flash
    const turn1 = await engine.sendChatMessage({ text: "嗨" });
    assert.equal(turn1.tier, "L1");
    assert.equal(turn1.modelUsed, "antigravity/gemini-3.8-flash");
    const firstL1Id = store.get().l1AgentId!;
    assert.equal(firstL1Id, "agt_1");

    // Turn 2: unchanged config reuses agt_1
    const turn2 = await engine.sendChatMessage({ text: "早上好" });
    assert.equal(turn2.agentId, "agt_1");
    assert.equal(turn2.modelUsed, "antigravity/gemini-3.8-flash");

    // Case A: Settings updated via live settingsHandle subscription (fastProvider -> gemini-4-neon)
    currentSettings = {
      ...currentSettings,
      fastProvider: "antigravity/gemini-4-neon",
    };
    await settingsListener!({ status: "ready", values: currentSettings });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.get().l1AgentId, null);
    assert.ok(spawned.get("agt_1")?.archivedAt, "Old L1 background session should be archived");

    const turn3 = await engine.sendChatMessage({ text: "现在是什么模型？" });
    assert.equal(turn3.tier, "L1");
    assert.equal(turn3.modelUsed, "antigravity/gemini-4-neon");
    assert.equal(turn3.agentId, "agt_2");
    assert.equal(store.get().l1AgentId, "agt_2");
    const msg3 = store.get().messages.find((m) => m.id === turn3.assistantMessageId)!;
    assert.match(msg3.text, /antigravity\/gemini-4-neon/);

    // Case B: Persisted state.l1AgentId ("agt_2", gemini-4-neon) mismatches in-memory settings (e.g. config.json edited before reload -> gemini-4-hydrogen)
    (engine as unknown as { settings: typeof currentSettings }).settings = {
      ...currentSettings,
      fastProvider: "antigravity/gemini-4-hydrogen",
    };
    const turn4 = await engine.sendChatMessage({ text: "再测一次" });
    assert.equal(turn4.tier, "L1");
    assert.equal(turn4.modelUsed, "antigravity/gemini-4-hydrogen");
    assert.equal(turn4.agentId, "agt_3");
    assert.equal(store.get().l1AgentId, "agt_3");
    assert.ok(spawned.get("agt_2")?.archivedAt, "Mismatched persisted L1 session should be archived");

    // Subsequent turn with matching gemini-4-hydrogen reuses agt_3 without churning
    const turn5 = await engine.sendChatMessage({ text: "继续保持" });
    assert.equal(turn5.agentId, "agt_3");
    assert.equal(turn5.modelUsed, "antigravity/gemini-4-hydrogen");

    // Case C: Shared Chief session also rebuilds when chiefProvider changes
    const chief1 = await engine.ensureChiefBot();
    assert.equal(chief1.created, true);
    assert.equal(chief1.modelUsed, "antigravity/gemini-4-carbon");
    const chief1Reuse = await engine.ensureChiefBot();
    assert.equal(chief1Reuse.created, false);
    assert.equal(chief1Reuse.agentId, chief1.agentId);

    (engine as unknown as { settings: typeof currentSettings }).settings = {
      ...currentSettings,
      fastProvider: "antigravity/gemini-4-hydrogen",
      chiefProvider: "antigravity/gemini-4-neon",
    };
    const chief2 = await engine.ensureChiefBot();
    assert.equal(chief2.created, true);
    assert.notEqual(chief2.agentId, chief1.agentId);
    assert.equal(chief2.modelUsed, "antigravity/gemini-4-neon");

    await engine.stop();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
