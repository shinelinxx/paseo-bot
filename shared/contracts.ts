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
  cadence: z.string(),
  target: z.string(),
  status: z.string(),
  nextRunAt: z.string().nullable().optional(),
  lastRunAt: z.string().nullable().optional(),
});
export type NativeScheduleItem = z.output<typeof NativeScheduleSchema>;

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
  memoryContent: z.string(),
  memoryPath: z.string(),
});
export type BotSnapshot = z.output<typeof BotSnapshotSchema>;

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

export const watchBotStateSubscription = defineSubscription({
  name: "bot.watch",
  input: z.object({}),
  event: BotSnapshotSchema,
});

export const ensureChiefBotRpc = defineRpc({
  name: "bot.ensure_chief",
  input: z.object({ reset: z.boolean().optional() }),
  output: z.object({
    agentId: z.string(),
    workspaceId: z.string().nullable(),
    created: z.boolean(),
  }),
});

export const submitWishRpc = defineRpc({
  name: "bot.submit_wish",
  input: z.object({
    wish: z.string().min(1),
    cwd: z.string().optional(),
  }),
  output: z.object({
    agentId: z.string(),
    workspaceId: z.string().nullable(),
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
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
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
]);
export type PresetId = z.output<typeof PresetIdSchema>;

export const installPresetRpc = defineRpc({
  name: "bot.trigger.install_preset",
  input: z.object({ presetId: PresetIdSchema }),
  output: TriggerSpecSchema,
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
  }),
  output: z.object({ ok: z.boolean() }),
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
    delayMinutes: z.number().min(1).max(60 * 24 * 14).optional(),
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

export const manageNativeScheduleRpc = defineRpc({
  name: "bot.native_schedule.manage",
  input: z.object({
    id: z.string().min(1),
    action: z.enum(["run_once", "pause", "resume"]),
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
