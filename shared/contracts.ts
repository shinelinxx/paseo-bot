import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const SCREEN_ID = "paseo-bot";
export const SETTINGS_SCREEN_ID = "paseo-bot-settings";
export const SIDEBAR_ITEM_ID = "paseo-bot";

export const BOT_ALERT_TIMELINE_KIND = "paseo-bot-alert";
export const BOT_APPROVAL_TIMELINE_KIND = "paseo-bot-approval";

export const TriggerKindSchema = z.enum([
  "file_watch",
  "webhook",
  "poll_command",
  "schedule",
  "self_wake",
]);
export type TriggerKind = z.output<typeof TriggerKindSchema>;

export const GovernanceLevelSchema = z.enum([
  "autonomous",
  "notify",
  "require_approval",
]);
export type GovernanceLevel = z.output<typeof GovernanceLevelSchema>;

export const ExecutionTargetSchema = z.enum(["scout_helper", "chief_bot"]);
export type ExecutionTarget = z.output<typeof ExecutionTargetSchema>;

export const TriggerOutcomeSchema = z.enum([
  "silent",
  "notify",
  "approval_required",
  "error",
]);
export type TriggerOutcome = z.output<typeof TriggerOutcomeSchema>;

export const FeedActionKindSchema = z.enum([
  "delegate",
  "wish",
  "self_wake",
  "snooze",
]);
export type FeedActionKind = z.output<typeof FeedActionKindSchema>;

export const FeedActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: FeedActionKindSchema,
  prompt: z.string().optional(),
  cwd: z.string().optional(),
  targetAgentId: z.string().optional(),
  delayMinutes: z.number().min(1).max(60 * 24 * 14).optional(),
  executedAt: z.string().optional(),
});
export type FeedAction = z.output<typeof FeedActionSchema>;

export const FeedFeedbackSchema = z.enum(["up", "down"]);
export type FeedFeedback = z.output<typeof FeedFeedbackSchema>;

export const TriggerSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  kind: TriggerKindSchema,
  enabled: z.boolean().default(true),
  governance: GovernanceLevelSchema.default("notify"),
  executionTarget: ExecutionTargetSchema.default("scout_helper"),
  cwd: z.string(),
  prompt: z.string(),
  providerOverride: z.string().optional(),
  watchPath: z.string().optional(),
  ignorePatterns: z.array(z.string()).default([]),
  debounceMs: z.number().int().min(500).max(300_000).default(4000),
  webhookKey: z.string().optional(),
  pollCommand: z.string().optional(),
  pollIntervalSec: z.number().int().min(10).max(86_400 * 7).default(300),
  matchRegex: z.string().optional(),
  dailyTime: z.string().optional(),
  onceAt: z.string().optional(),
  cooldownSec: z.number().int().min(0).max(86_400).default(45),
  maxRuns: z.number().int().positive().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastCheckedAt: z.string().optional(),
  lastTriggeredAt: z.string().optional(),
  lastOutcome: TriggerOutcomeSchema.optional(),
  runCount: z.number().int().nonnegative().default(0),
  silentCount: z.number().int().nonnegative().default(0),
  notifyCount: z.number().int().nonnegative().default(0),
  approvedCount: z.number().int().nonnegative().default(0),
  noiseRules: z.array(z.string()).default([]),
  lastDiffHash: z.string().optional(),
  lastSample: z.string().optional(),
  lastError: z.string().optional(),
  lastDailyRunDate: z.string().optional(),
});
export type TriggerSpec = z.output<typeof TriggerSpecSchema>;

export const FeedLevelSchema = z.enum([
  "silent",
  "notify",
  "approval_required",
  "worker_update",
  "wish",
  "error",
]);
export type FeedLevel = z.output<typeof FeedLevelSchema>;

export const FeedItemSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  level: FeedLevelSchema,
  title: z.string(),
  summary: z.string(),
  details: z.string().optional(),
  actions: z.array(FeedActionSchema).default([]),
  inProgress: z.boolean().default(false),
  feedback: FeedFeedbackSchema.optional(),
  feedbackNote: z.string().optional(),
  snoozedUntil: z.string().optional(),
  triggerId: z.string().optional(),
  triggerName: z.string().optional(),
  approvalId: z.string().optional(),
  agentId: z.string().optional(),
  workspaceId: z.string().optional(),
  routedAgentId: z.string().optional(),
  routedAgentTitle: z.string().optional(),
  unread: z.boolean().default(true),
});
export type FeedItem = z.output<typeof FeedItemSchema>;

export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type ApprovalStatus = z.output<typeof ApprovalStatusSchema>;

export const ApprovalRiskSchema = z.enum(["low", "medium", "high"]);
export type ApprovalRisk = z.output<typeof ApprovalRiskSchema>;

export const ApprovalItemSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().optional(),
  status: ApprovalStatusSchema,
  title: z.string(),
  actionSummary: z.string(),
  riskLevel: ApprovalRiskSchema.default("medium"),
  followUpPrompt: z.string(),
  payloadPreview: z.string().optional(),
  payloadLanguage: z.string().optional(),
  cwd: z.string(),
  sourceAgentId: z.string().optional(),
  triggerId: z.string().optional(),
  triggerName: z.string().optional(),
  decisionNote: z.string().optional(),
  promotedTrust: z.boolean().optional(),
  executionAgentId: z.string().optional(),
});
export type ApprovalItem = z.output<typeof ApprovalItemSchema>;

export const WorkerStatusSchema = z.enum([
  "running",
  "completed",
  "permission",
  "failed",
  "archived",
]);
export type WorkerStatus = z.output<typeof WorkerStatusSchema>;

export const DelegatedWorkerSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  workspaceId: z.string().optional(),
  title: z.string(),
  cwd: z.string(),
  provider: z.string(),
  isolation: z.enum(["local", "worktree"]).default("local"),
  status: WorkerStatusSchema,
  goal: z.string(),
  notifyChiefOnFinish: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
  summary: z.string().optional(),
});
export type DelegatedWorker = z.output<typeof DelegatedWorkerSchema>;

export const RoutineSuggestionSchema = z.object({
  id: z.string(),
  title: z.string(),
  reason: z.string(),
  cwd: z.string(),
  suggestedKind: TriggerKindSchema,
  dailyTime: z.string().optional(),
  watchPath: z.string().optional(),
  pollCommand: z.string().optional(),
  pollIntervalSec: z.number().int().positive().optional(),
  governance: GovernanceLevelSchema,
  prompt: z.string(),
});
export type RoutineSuggestion = z.output<typeof RoutineSuggestionSchema>;

export const NativeScheduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string().default(""),
  cadence: z.string(),
  cronExpression: z.string().optional(),
  timezone: z.string().optional(),
  every: z.string().optional(),
  cwd: z.string().default(""),
  target: z.string(),
  provider: z.string().default(""),
  modeId: z.string().optional(),
  status: z.string(),
  nextRunAt: z.string().nullable().optional(),
  lastRunAt: z.string().nullable().optional(),
  lastRunStatus: z.string().optional(),
  lastRunAgentId: z.string().optional(),
  lastRunError: z.string().optional(),
  runCount: z.number().int().nonnegative().default(0),
});
export type NativeScheduleItem = z.output<typeof NativeScheduleSchema>;

export const KnownWorkspaceSchema = z.object({
  cwd: z.string(),
  label: z.string(),
});
export type KnownWorkspace = z.output<typeof KnownWorkspaceSchema>;

export const RoutingTierSchema = z.enum(["L0", "L1", "L2", "L3"]);
export type RoutingTier = z.output<typeof RoutingTierSchema>;

export const ChatRoleSchema = z.enum(["user", "assistant", "system"]);
export type ChatRole = z.output<typeof ChatRoleSchema>;

export const ChatMessageKindSchema = z.enum([
  "chat",
  "proactive",
  "ack",
  "approval",
  "memory_update",
  "status_note",
]);
export type ChatMessageKind = z.output<typeof ChatMessageKindSchema>;

export const ChatMessageStatusSchema = z.enum([
  "sending",
  "thinking",
  "done",
  "error",
]);
export type ChatMessageStatus = z.output<typeof ChatMessageStatusSchema>;

export const ChatMessageImageSchema = z.object({
  mimeType: z.string(),
  name: z.string().optional(),
  previewUri: z.string().optional(),
});
export type ChatMessageImage = z.output<typeof ChatMessageImageSchema>;

export const ChatInlineLinkSchema = z.object({
  label: z.string(),
  url: z.string(),
  kind: z.enum(["external", "agent", "file"]).default("external"),
});
export type ChatInlineLink = z.output<typeof ChatInlineLinkSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  role: ChatRoleSchema,
  kind: ChatMessageKindSchema.default("chat"),
  text: z.string(),
  details: z.string().optional(),
  images: z.array(ChatMessageImageSchema).default([]),
  links: z.array(ChatInlineLinkSchema).default([]),
  quickActions: z.array(FeedActionSchema).default([]),
  tier: RoutingTierSchema.optional(),
  modelUsed: z.string().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  status: ChatMessageStatusSchema.default("done"),
  replyToMessageId: z.string().optional(),
  approvalId: z.string().optional(),
  triggerId: z.string().optional(),
  triggerName: z.string().optional(),
  agentId: z.string().optional(),
  workspaceId: z.string().optional(),
  unread: z.boolean().default(false),
});
export type ChatMessage = z.output<typeof ChatMessageSchema>;

export const RoutingTelemetrySchema = z.object({
  l0Hits: z.number().int().nonnegative().default(0),
  l1Hits: z.number().int().nonnegative().default(0),
  l2Hits: z.number().int().nonnegative().default(0),
  l3Hits: z.number().int().nonnegative().default(0),
  fallbackCount: z.number().int().nonnegative().default(0),
  lastTier: RoutingTierSchema.optional(),
  lastModelUsed: z.string().optional(),
  lastLatencyMs: z.number().int().nonnegative().optional(),
});
export type RoutingTelemetry = z.output<typeof RoutingTelemetrySchema>;

export const TierModelsSchema = z.object({
  l1: z.string(),
  l2: z.string(),
  l3: z.string(),
});
export type TierModels = z.output<typeof TierModelsSchema>;

export const BotSnapshotSchema = z.object({
  chiefAgentId: z.string().nullable(),
  chiefWorkspaceId: z.string().nullable(),
  webhookBaseUrl: z.string().nullable(),
  hourlyWakesUsed: z.number().int().nonnegative(),
  hourlyWakeLimit: z.number().int().positive(),
  globalPaused: z.boolean(),
  unreadCount: z.number().int().nonnegative(),
  pendingApprovalCount: z.number().int().nonnegative(),
  runningWorkerCount: z.number().int().nonnegative(),
  totalSilentChecks: z.number().int().nonnegative().default(0),
  triggers: z.array(TriggerSpecSchema),
  nativeSchedules: z.array(NativeScheduleSchema).default([]),
  feed: z.array(FeedItemSchema),
  approvals: z.array(ApprovalItemSchema),
  workers: z.array(DelegatedWorkerSchema),
  routineSuggestions: z.array(RoutineSuggestionSchema).default([]),
  knownWorkspaces: z.array(KnownWorkspaceSchema).default([]),
  memoryContent: z.string(),
  memoryPath: z.string(),
  butlerName: z.string().default("Paseo Bot"),
  userName: z.string().default(""),
  messages: z.array(ChatMessageSchema).default([]),
  routingTelemetry: RoutingTelemetrySchema.default({
    l0Hits: 0,
    l1Hits: 0,
    l2Hits: 0,
    l3Hits: 0,
    fallbackCount: 0,
  }),
  tierModels: TierModelsSchema.optional(),
});
export type ResolvedBotSnapshot = z.output<typeof BotSnapshotSchema>;
export type BotSnapshot = Omit<
  ResolvedBotSnapshot,
  "butlerName" | "userName" | "messages" | "routingTelemetry" | "tierModels"
> & {
  butlerName?: string;
  userName?: string;
  messages?: ChatMessage[];
  routingTelemetry?: RoutingTelemetry;
  tierModels?: TierModels;
};

// Timeline card schemas
export const botAlertTimelineSchema = z.object({
  feedId: z.string(),
  level: FeedLevelSchema,
  title: z.string(),
  summary: z.string(),
  details: z.string().optional(),
  actions: z.array(FeedActionSchema).default([]),
  feedback: FeedFeedbackSchema.optional(),
  triggerId: z.string().optional(),
  triggerName: z.string().optional(),
  workerAgentId: z.string().optional(),
  routedAgentId: z.string().optional(),
  routedAgentTitle: z.string().optional(),
  createdAt: z.string(),
});
export type BotAlertTimelineData = z.output<typeof botAlertTimelineSchema>;

export const botApprovalTimelineSchema = z.object({
  approvalId: z.string(),
  status: ApprovalStatusSchema,
  title: z.string(),
  actionSummary: z.string(),
  riskLevel: ApprovalRiskSchema,
  cwd: z.string(),
  payloadPreview: z.string().optional(),
  payloadLanguage: z.string().optional(),
  followUpPrompt: z.string().optional(),
  triggerId: z.string().optional(),
  triggerName: z.string().optional(),
  decisionNote: z.string().optional(),
  promotedTrust: z.boolean().optional(),
  createdAt: z.string(),
  resolvedAt: z.string().optional(),
});
export type BotApprovalTimelineData = z.output<typeof botApprovalTimelineSchema>;

// RPC & Subscription Contracts
export const getBotSnapshotRpc = defineRpc({
  name: "bot.snapshot",
  input: z.object({}),
  output: BotSnapshotSchema,
});

export const BotSummarySchema = z.object({
  globalPaused: z.boolean(),
  unreadCount: z.number().int().nonnegative(),
  pendingApprovalCount: z.number().int().nonnegative(),
  runningWorkerCount: z.number().int().nonnegative(),
});
export type BotSummary = z.output<typeof BotSummarySchema>;

export const watchBotStateSubscription = defineSubscription({
  name: "bot.watch",
  input: z.object({}),
  event: BotSnapshotSchema,
});

export const watchBotSummarySubscription = defineSubscription({
  name: "bot.watch_summary",
  input: z.object({}),
  event: BotSummarySchema,
});

export const CatalogModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
});
export type CatalogModel = z.output<typeof CatalogModelSchema>;

export const CatalogProviderSchema = z.object({
  id: z.string(),
  label: z.string(),
  models: z.array(CatalogModelSchema),
});
export type CatalogProvider = z.output<typeof CatalogProviderSchema>;

export const listModelsRpc = defineRpc({
  name: "bot.models.list",
  input: z.object({
    refresh: z.boolean().optional(),
  }),
  output: z.object({
    defaultProvider: z.string(),
    providers: z.array(CatalogProviderSchema),
  }),
});

export const ensureChiefBotRpc = defineRpc({
  name: "bot.ensure_chief",
  input: z.object({
    reset: z.boolean().optional(),
    provider: z.string().optional(),
  }),
  output: z.object({
    agentId: z.string(),
    workspaceId: z.string().nullable(),
    created: z.boolean(),
    modelUsed: z.string().optional(),
  }),
});

export const MAX_ATTACHED_IMAGES = 6;
export const MAX_SINGLE_IMAGE_BASE64_CHARS = 12 * 1024 * 1024;

export const WishImageAttachmentSchema = z.object({
  data: z.string().min(1).max(MAX_SINGLE_IMAGE_BASE64_CHARS),
  mimeType: z.string().regex(/^image\/[a-zA-Z0-9.+-]+$/),
  name: z.string().max(120).optional(),
});
export type WishImageAttachment = z.output<typeof WishImageAttachmentSchema>;

export const submitWishRpc = defineRpc({
  name: "bot.submit_wish",
  input: z
    .object({
      wish: z.string().default(""),
      images: z.array(WishImageAttachmentSchema).max(MAX_ATTACHED_IMAGES).optional(),
      cwd: z.string().optional(),
      provider: z.string().optional(),
      asyncLaunch: z.boolean().optional(),
    })
    .refine(
      (val) => val.wish.trim().length > 0 || (val.images !== undefined && val.images.length > 0),
      { message: "Wish text or at least one image is required" },
    ),
  output: z.object({
    agentId: z.string(),
    workspaceId: z.string().nullable(),
    feedId: z.string().optional(),
    pendingLaunch: z.boolean().optional(),
    reusedSession: z.boolean().optional(),
    sessionTitle: z.string().optional(),
    modelUsed: z.string().optional(),
  }),
});

export const TriggerUpsertInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  kind: TriggerKindSchema,
  enabled: z.boolean().optional(),
  governance: GovernanceLevelSchema.optional(),
  executionTarget: ExecutionTargetSchema.optional(),
  cwd: z.string().optional(),
  prompt: z.string().min(1),
  providerOverride: z.string().optional(),
  watchPath: z.string().optional(),
  ignorePatterns: z.array(z.string()).optional(),
  noiseRules: z.array(z.string()).optional(),
  debounceMs: z.number().int().min(500).max(300_000).optional(),
  webhookKey: z.string().optional(),
  pollCommand: z.string().optional(),
  pollIntervalSec: z.number().int().min(10).max(86_400 * 7).optional(),
  matchRegex: z.string().optional(),
  dailyTime: z.string().optional(),
  onceAt: z.string().optional(),
  cooldownSec: z.number().int().min(0).max(86_400).optional(),
  maxRuns: z.number().int().positive().optional(),
});
export type TriggerUpsertInput = z.output<typeof TriggerUpsertInputSchema>;

export const MissionDraftSchema = TriggerUpsertInputSchema.extend({
  humanSummary: z.string(),
  rationale: z.string(),
});
export type MissionDraft = z.output<typeof MissionDraftSchema>;

export const draftMissionRpc = defineRpc({
  name: "bot.trigger.draft_from_intent",
  input: z.object({
    intent: z.string().min(1),
    cwd: z.string().optional(),
  }),
  output: z.object({
    draft: MissionDraftSchema,
  }),
});

export const upsertTriggerRpc = defineRpc({
  name: "bot.trigger.upsert",
  input: TriggerUpsertInputSchema,
  output: TriggerSpecSchema,
});

export const toggleTriggerRpc = defineRpc({
  name: "bot.trigger.toggle",
  input: z.object({ id: z.string(), enabled: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
});

export const deleteTriggerRpc = defineRpc({
  name: "bot.trigger.delete",
  input: z.object({
    id: z.string().optional(),
    clearFinishedReminders: z.boolean().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    removedCount: z.number().int().nonnegative().optional(),
  }),
});

export const runTriggerNowRpc = defineRpc({
  name: "bot.trigger.run_now",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const PresetIdSchema = z.enum([
  "kb_inbox",
  "universal_webhook",
  "morning_briefing",
  "session_tidy",
]);
export type PresetId = z.output<typeof PresetIdSchema>;

export const PresetInstallResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  isNativeSchedule: z.boolean().optional(),
});
export type PresetInstallResult = z.output<typeof PresetInstallResultSchema>;

export const installPresetRpc = defineRpc({
  name: "bot.trigger.install_preset",
  input: z.object({ presetId: PresetIdSchema }),
  output: PresetInstallResultSchema,
});

export const resolveApprovalRpc = defineRpc({
  name: "bot.approval.resolve",
  input: z.object({
    id: z.string(),
    decision: z.enum(["approved", "rejected"]),
    note: z.string().optional(),
    editedFollowUpPrompt: z.string().optional(),
    promoteTrust: z.boolean().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    executionAgentId: z.string().optional(),
    promotedTriggerName: z.string().optional(),
  }),
});

export const markFeedReadRpc = defineRpc({
  name: "bot.feed.mark_read",
  input: z.object({
    id: z.string().optional(),
    clearSilent: z.boolean().optional(),
    dismissId: z.string().optional(),
    clearRead: z.boolean().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    removedCount: z.number().int().nonnegative().optional(),
  }),
});

export const curateFeedRpc = defineRpc({
  name: "bot.feed.curate",
  input: z.object({
    feedId: z.string(),
    feedback: FeedFeedbackSchema,
    ruleNote: z.string().optional(),
    muteTrigger: z.boolean().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    updatedTriggerName: z.string().optional(),
  }),
});

export const executeFeedActionRpc = defineRpc({
  name: "bot.feed.action",
  input: z.object({
    feedId: z.string(),
    actionId: z.string().optional(),
    customKind: FeedActionKindSchema.optional(),
    customPrompt: z.string().optional(),
    images: z.array(WishImageAttachmentSchema).max(MAX_ATTACHED_IMAGES).optional(),
    delayMinutes: z.number().min(1).max(60 * 24 * 14).optional(),
    fallbackProvider: z.string().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
    agentId: z.string().optional(),
  }),
});

export const dismissSuggestionRpc = defineRpc({
  name: "bot.suggestion.dismiss",
  input: z.object({
    suggestionId: z.string().min(1),
  }),
  output: z.object({ ok: z.boolean() }),
});

export const manageWorkerRpc = defineRpc({
  name: "bot.worker.manage",
  input: z.object({
    action: z.enum(["stop", "remove", "clear_finished"]),
    workerId: z.string().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    removedCount: z.number().int().nonnegative().optional(),
  }),
});

export const NativeScheduleUpsertInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  prompt: z.string().min(1),
  cwd: z.string().optional(),
  dailyTime: z.string().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  everySec: z.number().int().min(60).max(86_400 * 7).optional(),
  governance: GovernanceLevelSchema.optional(),
  noiseRules: z.array(z.string()).optional(),
  provider: z.string().optional(),
  enabled: z.boolean().optional(),
});
export type NativeScheduleUpsertInput = z.output<typeof NativeScheduleUpsertInputSchema>;

export const upsertNativeScheduleRpc = defineRpc({
  name: "bot.native_schedule.upsert",
  input: NativeScheduleUpsertInputSchema,
  output: NativeScheduleSchema,
});

export const manageNativeScheduleRpc = defineRpc({
  name: "bot.native_schedule.manage",
  input: z.object({
    id: z.string().min(1),
    action: z.enum(["run_once", "pause", "resume", "delete"]),
  }),
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
  }),
});

export const saveMemoryRpc = defineRpc({
  name: "bot.memory.save",
  input: z.object({ content: z.string() }),
  output: z.object({ ok: z.boolean(), path: z.string() }),
});

export const setGlobalPauseRpc = defineRpc({
  name: "bot.set_pause",
  input: z.object({ paused: z.boolean() }),
  output: z.object({ paused: z.boolean() }),
});

export const tidySessionsRpc = defineRpc({
  name: "bot.sessions.tidy",
  input: z.object({
    mode: z.enum(["preview", "apply"]).default("preview"),
    idleHours: z.number().int().min(0).max(720).optional(),
    closedHours: z.number().int().min(0).max(720).optional(),
    ensurePinnedHubs: z.boolean().optional(),
    callerAgentId: z.string().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    actionCount: z.number().int().nonnegative(),
    approvalId: z.string().optional(),
    summary: z.string(),
  }),
});

export const SendChatMessageInputSchema = z
  .object({
    text: z.string().default(""),
    images: z.array(WishImageAttachmentSchema).max(MAX_ATTACHED_IMAGES).optional(),
    replyToMessageId: z.string().optional(),
    forceTier: z.enum(["L1", "L2", "L3"]).optional(),
    providerOverride: z.string().optional(),
    cwd: z.string().optional(),
  })
  .refine(
    (val) =>
      val.text.trim().length > 0 || (val.images !== undefined && val.images.length > 0),
    { message: "Chat text or at least one image is required" },
  );
export type SendChatMessageInput = z.output<typeof SendChatMessageInputSchema>;

export const SendChatMessageOutputSchema = z.object({
  userMessageId: z.string(),
  assistantMessageId: z.string().optional(),
  ackMessageId: z.string().optional(),
  tier: RoutingTierSchema,
  modelUsed: z.string().optional(),
  escalatedTo: z.enum(["L2", "L3"]).optional(),
  agentId: z.string().optional(),
  routedSessionTitle: z.string().optional(),
});
export type SendChatMessageOutput = z.output<typeof SendChatMessageOutputSchema>;

export const sendChatMessageRpc = defineRpc({
  name: "bot.chat.send",
  input: SendChatMessageInputSchema,
  output: SendChatMessageOutputSchema,
});

export const markMessagesReadRpc = defineRpc({
  name: "bot.chat.mark_read",
  input: z.object({
    upToMessageId: z.string().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    markedCount: z.number().int().nonnegative().optional(),
  }),
});

export const updateButlerProfileRpc = defineRpc({
  name: "bot.profile.update",
  input: z.object({
    butlerName: z.string().max(48).optional(),
    userName: z.string().max(48).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    butlerName: z.string(),
    userName: z.string(),
  }),
});
