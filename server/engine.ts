import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { PaseoAgentProvider, PaseoApi } from "@getpaseo/client";
import {
  execCommand,
  type PluginServerContext,
  type PluginSettings,
} from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import {
  BOT_ALERT_TIMELINE_KIND,
  type ApprovalItem,
  type ApprovalRisk,
  type BotSummary,
  type CatalogModel,
  type CatalogProvider,
  type ChatMessage,
  type DelegatedWorker,
  type FeedAction,
  type FeedActionKind,
  type FeedFeedback,
  type FeedItem,
  type FeedLevel,
  type KnownWorkspace,
  type MissionDraft,
  type NativeScheduleItem,
  type NativeScheduleUpsertInput,
  type PresetId,
  type PresetInstallResult,
  type ResolvedBotSnapshot,
  type RoutineSuggestion,
  type RoutingTier,
  type SendChatMessageInput,
  type SendChatMessageOutput,
  type TriggerSpec,
  type TriggerUpsertInput,
  type WishImageAttachment,
} from "../shared/contracts.ts";
import {
  DEFAULT_BOT_SETTINGS,
  type BotSettings,
  type BotSettingsSchema,
} from "../shared/settings.ts";
import {
  applyApprovalResolutionMutation,
  applyFeedCurationMutation,
  cleanTaskTitle,
  computeRoutineSuggestions,
  draftMissionFromIntent,
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
} from "./intent.ts";
import {
  parseInvalidModeError,
  pickCompatibleModeId,
} from "./launch-mode.ts";
import {
  appendChiefAlertCard,
  sendDesktopNotification,
  upsertChiefApprovalCard,
} from "./notify.ts";
import {
  buildButlerExecSystemPrompt,
  buildButlerL1SystemPrompt,
  buildProactiveScoutPromptGuidance,
} from "./prompts.ts";
import {
  buildConclusionSummary,
  buildImmediateAckText,
  buildOnboardingMessages,
  classifyMessageTier,
  ensureAgentJumpLink,
  evaluateWorkerTurnForStream,
  extractInlineLinksFromMarkdown,
  parseProfilePreferenceFromMemoryNote,
  resolveTierProviderChain,
} from "./router.ts";
import {
  BotStateStore,
  computeNormalizedHash,
  createShortId,
  expandHomePath,
  shouldIgnoreWatchPath,
} from "./storage.ts";
import {
  buildNativeSchedulePromptWithGovernance,
  getPaseoSchedulesDir,
  parseNativeScheduleRecord,
  readNativeSchedulesFromDisk,
  resolveScheduleCadenceArgs,
} from "./schedules.ts";
import {
  analyzeSessionsForTidy,
  countTidyPlanActions,
  executeTidyPlan,
  extractTidyPlanIdFromPrompt,
  isInternalBotTitle,
  loadTidyPlan,
  needsSessionAutoRename,
  normalizeSessionTitleFast,
  parseApprovedItemKeysFromMarkdown,
  provisionalPromptTitle,
  renamePaseoAgentViaCli,
  renderTidyPlanMarkdown,
  saveTidyPlan,
  scoreSessionTopicSimilarity,
} from "./tidy.ts";

export interface RecordedL1Escalation {
  targetTier: "L2" | "L3";
  ackBubble: string;
  handoffBrief: string;
  cwd?: string;
}

export interface ProactiveEngineOptions {
  store?: BotStateStore;
  l1TimeoutMs?: number;
  promptsDir?: string;
}

function stripWorkOrderPrefix(raw: string): string {
  return raw
    .replace(
      /^(?:【(?:告警|提醒|系统通知|高危告警)】\s*|⚠️\s*【[^】]+】\s*|(?:待确认|已完成|正在处理|子任务已完成|子任务出错)\s*[：:·]\s*(?:任务\s*[·：:]\s*)?)/u,
      "",
    )
    .trim();
}

function isHeavySelfWakePrompt(prompt: string): boolean {
  return /(?:ssh|git\s+|npm\s+|pnpm\s+|代码|仓库|重构|部署|cloudflare|服务器|修改文件|delegate)/iu.test(
    prompt,
  );
}

interface ActiveFileWatcher {
  watchPath: string;
  debounceMs: number;
  ignoreKey: string;
  matchRegex: string;
  compiledRegex: RegExp | null;
  watcher: fsSync.FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  pendingFiles: Set<string>;
  lastStatSignature: string;
}

const MAX_PENDING_WATCH_FILES = 30;
const MAX_PENDING_DISPATCHES = 50;
const MAX_POLL_HTTP_BYTES = 24 * 1024;
const MAX_REGEX_CACHE_ENTRIES = 64;
const PROVIDER_CATALOG_TTL_MS = 5 * 60_000;

async function pathExists(targetPath: string): Promise<boolean> {
  if (!targetPath) return false;
  try {
    await fs.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

interface RecordedScoutOutcome {
  level: "silent" | "notify" | "approval_required";
  title?: string;
  summary?: string;
  details?: string;
  actions?: FeedAction[];
}

interface PendingDispatch {
  triggerId: string;
  reason: string;
  detail: string;
  manual?: boolean;
}

function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatLocalHHMM(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatAgentModelPair(agent: unknown): string | undefined {
  if (!agent || typeof agent !== "object") return undefined;
  const rec = agent as Record<string, unknown>;
  const prov = typeof rec.provider === "string" ? rec.provider.trim() : "";
  const model = typeof rec.model === "string" ? rec.model.trim() : "";
  if (prov && model) return `${prov}/${model}`;
  return prov || model || undefined;
}

function extractAssistantText(items: readonly AgentTimelineItem[]): string {
  const chunks: string[] = [];
  for (const item of items) {
    if (item.type === "assistant_message" && typeof item.text === "string") {
      chunks.push(item.text.trim());
    }
  }
  return chunks.filter(Boolean).join("\n\n").trim();
}

export class ProactiveEngine {
  readonly store: BotStateStore;
  private readonly l1TimeoutMs: number;
  private readonly promptsDir?: string;
  private paseo: PaseoApi | null = null;
  private settings: BotSettings = DEFAULT_BOT_SETTINGS;
  private settingsCleanup: (() => void) | null = null;
  private hookCleanups: Array<() => void> = [];

  private readonly subscribers = new Set<(snapshot: ResolvedBotSnapshot) => void>();
  private readonly summarySubscribers = new Set<(summary: BotSummary) => void>();
  private readonly fileWatchers = new Map<string, ActiveFileWatcher>();
  private readonly inFlightTriggers = new Set<string>();
  private readonly pollingTriggers = new Set<string>();
  private readonly scoutOutcomes = new Map<string, RecordedScoutOutcome>();
  private readonly scoutTriggerMap = new Map<
    string,
    { triggerId: string; triggerName: string }
  >();
  private readonly l1Escalations = new Map<string, RecordedL1Escalation>();
  private readonly chatManagedAgentRuns = new Set<string>();
  private readonly activeChatExecPromises = new Set<Promise<void>>();
  private ensureL1InFlight: Promise<{
    handle: ReturnType<PaseoApi["agents"]["ref"]>;
    modelUsed: string;
  }> | null = null;

  constructor(opts?: ProactiveEngineOptions) {
    this.store = opts?.store ?? new BotStateStore();
    this.l1TimeoutMs = opts?.l1TimeoutMs ?? 18_000;
    this.promptsDir = opts?.promptsDir;
  }
  private readonly reportedTurnAgents = new Set<string>();
  private readonly repeatInteractiveTurnAgents = new Set<string>();
  private readonly autoRenamedAgents = new Set<string>();
  private readonly duplicateHintedAgents = new Set<string>();
  private readonly pendingDispatches: PendingDispatch[] = [];
  private readonly regexCache = new Map<string, RegExp | null>();
  private readonly launchingWishWorkerIds = new Set<string>();
  private readonly launchingWishFeedIds = new Map<string, string>();
  private readonly cancelledLaunchingWorkers = new Set<string>();

  private lastWorkerReconcileAt = 0;
  private workerReconcileInFlight: Promise<void> | null = null;

  private cachedNativeSchedules: NativeScheduleItem[] = [];
  private cachedNativeSchedulesAt = 0;
  private nativeSchedulesInFlight: Promise<NativeScheduleItem[]> | null = null;
  private schedulesDirWatcher: fsSync.FSWatcher | null = null;
  private schedulesDirDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  private cachedWorkspaceDirs: KnownWorkspace[] = [];
  private cachedWorkspaceDirsAt = 0;
  private workspaceDirsInFlight: Promise<void> | null = null;

  private cachedRoutableCandidates: RoutableAgentCandidate[] = [];
  private cachedRoutableAt = 0;

  private suggestionsCacheKey = "";
  private cachedSuggestions: RoutineSuggestion[] = [];

  private webhookServer: http.Server | null = null;
  private activeWebhookPort: number | null = null;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private schedulerTickInFlight = false;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private ensureChiefInFlight: Promise<{
    agentId: string;
    workspaceId: string | null;
    created: boolean;
    modelUsed?: string;
  }> | null = null;
  private stopped = false;

  private cachedLoginPath: string | null = null;
  private loginPathInFlight: Promise<string> | null = null;

  private cachedProviderCatalogAt = 0;
  private providerCatalogInFlight: Promise<void> | null = null;
  private readonly cachedProviderModesByCwd = new Map<
    string,
    { modes: string[]; fetchedAt: number }
  >();
  private cachedProviders: Array<{
    id: string;
    label: string;
    available: boolean;
    defaultModel: string | null;
    models: CatalogModel[];
    modes: string[];
  }> = [];

  private compileRegex(pattern?: string): RegExp | null {
    if (!pattern) return null;
    if (this.regexCache.has(pattern)) {
      return this.regexCache.get(pattern) ?? null;
    }
    let compiled: RegExp | null = null;
    try {
      compiled = new RegExp(pattern);
    } catch {
      compiled = null;
    }
    if (this.regexCache.size >= MAX_REGEX_CACHE_ENTRIES) {
      const oldest = this.regexCache.keys().next().value;
      if (oldest !== undefined) this.regexCache.delete(oldest);
    }
    this.regexCache.set(pattern, compiled);
    return compiled;
  }

  private async getLoginPath(): Promise<string> {
    if (this.cachedLoginPath !== null) return this.cachedLoginPath;
    if (this.loginPathInFlight) return this.loginPathInFlight;
    const fallback = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    const task = (async () => {
      try {
        const { stdout } = await execCommand("/bin/zsh", ["-lc", 'printf %s "$PATH"'], {
          timeout: 5_000,
          maxBuffer: 32 * 1024,
        });
        const resolved = stdout.trim();
        this.cachedLoginPath = resolved || fallback;
      } catch {
        this.cachedLoginPath = fallback;
      }
      return this.cachedLoginPath;
    })();
    this.loginPathInFlight = task;
    try {
      return await task;
    } finally {
      if (this.loginPathInFlight === task) this.loginPathInFlight = null;
    }
  }

  async start(
    server: PluginServerContext,
    settingsHandle: PluginSettings<typeof BotSettingsSchema>,
  ): Promise<void> {
    this.stopped = false;
    const persisted = await this.store.load();
    await this.reconcileOrphanThinkingAcks();
    await this.reloadSettings(settingsHandle);
    if (typeof persisted.runtimePaused === "boolean") {
      this.settings = { ...this.settings, globalPaused: persisted.runtimePaused };
    }

    const subCleanup = settingsHandle.subscribe(async (next) => {
      if (next.status === "ready") {
        if (this.store.get().runtimePaused !== null) {
          await this.store.mutate((draft) => {
            draft.runtimePaused = null;
          });
        }
        this.settings = { ...DEFAULT_BOT_SETTINGS, ...next.values };
        await this.reconcileRuntime();
        await this.broadcastSnapshot();
      }
    });
    this.settingsCleanup = () => void subCleanup();

    this.attachLifecycleHooks(server);
    await this.reconcileRuntime();
    await this.fetchNativeSchedules(true);
    this.syncSchedulesDirWatcher();

    this.schedulerTimer = setInterval(() => {
      void this.tickScheduler().catch((err) => {
        console.error("[paseo-bot] scheduler tick error:", err);
      });
    }, 10_000);
    this.schedulerTimer.unref?.();

    // Warm up shell PATH and migrate any legacy Bot-only recurring schedules into Paseo native schedules
    void this.getLoginPath().then(async () => {
      await this.migrateLegacyScheduleTriggers();
      await this.refreshNativeSchedulesInBackground(true);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    if (this.schedulesDirDebounceTimer) {
      clearTimeout(this.schedulesDirDebounceTimer);
      this.schedulesDirDebounceTimer = null;
    }
    if (this.schedulesDirWatcher) {
      try {
        this.schedulesDirWatcher.close();
      } catch {
        // Ignore
      }
      this.schedulesDirWatcher = null;
    }
    this.settingsCleanup?.();
    this.settingsCleanup = null;
    for (const remove of this.hookCleanups) remove();
    this.hookCleanups = [];
    this.closeAllWatchers();
    await this.closeWebhookServer();
    if (this.activeChatExecPromises.size > 0) {
      await Promise.allSettled([...this.activeChatExecPromises]);
    }
    await this.store.flush().catch(() => undefined);
    this.subscribers.clear();
    this.summarySubscribers.clear();
  }

  async waitForBackgroundChatTasks(): Promise<void> {
    while (this.activeChatExecPromises.size > 0) {
      await Promise.allSettled([...this.activeChatExecPromises]);
    }
  }

  getSettings(): BotSettings {
    return this.settings;
  }

  getWebhookBaseUrl(): string | null {
    return this.settings.webhookEnabled && this.activeWebhookPort
      ? `http://127.0.0.1:${this.activeWebhookPort}`
      : null;
  }

  async setGlobalPaused(paused: boolean): Promise<boolean> {
    this.settings = { ...this.settings, globalPaused: paused };
    await this.store.mutate((draft) => {
      draft.runtimePaused = paused;
    });
    await this.reconcileRuntime();
    await this.broadcastSnapshot();
    return paused;
  }

  attachPaseo(paseo: PaseoApi): void {
    const wasEmpty = this.paseo === null;
    this.paseo = paseo;
    if (wasEmpty) {
      void this.reconcileWorkersWithPaseo(true);
      void this.refreshWorkspaceDirsInBackground(true);
      if (this.pendingDispatches.length > 0) {
        const queued = this.pendingDispatches.splice(0, this.pendingDispatches.length);
        for (const item of queued) {
          void this.dispatchTrigger(item.triggerId, {
            reason: item.reason,
            detail: item.detail,
            manual: item.manual,
          });
        }
      }
    }
  }

  markTurnReported(agentId: string): void {
    this.reportedTurnAgents.add(agentId);
  }

  private async reconcileWorkersWithPaseo(force = false): Promise<void> {
    if (!this.paseo || this.stopped) return;
    const now = Date.now();
    if (!force && now - this.lastWorkerReconcileAt < 10_000) return;
    if (this.workerReconcileInFlight) return this.workerReconcileInFlight;

    const task = (async () => {
      this.lastWorkerReconcileAt = Date.now();
      const state = await this.store.load();
      const activeWorkers = state.workers.filter(
        (w) => w.status === "running" || w.status === "permission",
      );
      if (activeWorkers.length === 0) return;

      const checks = await Promise.all(
        activeWorkers.map(async (w) => {
          try {
            const refreshed = await this.paseo!.agents.ref(w.agentId).refresh();
            return { workerId: w.id, agentId: w.agentId, refreshed };
          } catch {
            return { workerId: w.id, agentId: w.agentId, refreshed: null };
          }
        }),
      );

      let mutated = false;
      const nowIso = new Date().toISOString();
      await this.store.mutate((draft) => {
        for (const { workerId, agentId, refreshed } of checks) {
          const target = draft.workers.find((w) => w.id === workerId);
          if (!target || (target.status !== "running" && target.status !== "permission")) {
            continue;
          }
          let resolvedStatus: DelegatedWorker["status"] | null = null;
          if (!refreshed || refreshed.agent.archivedAt) {
            resolvedStatus = "archived";
          } else if (
            refreshed.agent.status === "idle" ||
            refreshed.agent.status === "closed"
          ) {
            resolvedStatus = "completed";
          } else if (refreshed.agent.status === "error") {
            resolvedStatus = "failed";
          }

          if (resolvedStatus) {
            target.status = resolvedStatus;
            target.updatedAt = nowIso;
            mutated = true;
            for (const f of draft.feed) {
              if (f.agentId === agentId && f.inProgress) {
                f.inProgress = false;
              }
            }
          }
        }
      });

      if (mutated) {
        await this.broadcastSnapshot();
      }
    })();

    this.workerReconcileInFlight = task;
    try {
      await task;
    } finally {
      if (this.workerReconcileInFlight === task) {
        this.workerReconcileInFlight = null;
      }
    }
  }

  private syncSchedulesDirWatcher(): void {
    if (this.stopped || this.schedulesDirWatcher) return;
    const schedulesDir = getPaseoSchedulesDir();
    try {
      fsSync.mkdirSync(schedulesDir, { recursive: true });
      const watcher = fsSync.watch(schedulesDir, () => {
        if (this.stopped) return;
        if (this.schedulesDirDebounceTimer) {
          clearTimeout(this.schedulesDirDebounceTimer);
        }
        this.schedulesDirDebounceTimer = setTimeout(() => {
          this.schedulesDirDebounceTimer = null;
          void this.refreshNativeSchedulesInBackground(true);
        }, 80);
        this.schedulesDirDebounceTimer.unref?.();
      });
      watcher.on("error", () => {
        // Non-fatal
      });
      this.schedulesDirWatcher = watcher;
    } catch {
      // Directory may not be watchable on remote setups; fallback polling still works
    }
  }

  private async fetchNativeSchedules(force = false): Promise<NativeScheduleItem[]> {
    const now = Date.now();
    if (
      !force &&
      this.cachedNativeSchedulesAt > 0 &&
      now - this.cachedNativeSchedulesAt < 15_000
    ) {
      return this.cachedNativeSchedules;
    }
    if (this.nativeSchedulesInFlight) return this.nativeSchedulesInFlight;

    const task = (async () => {
      try {
        const diskItems = await readNativeSchedulesFromDisk();
        if (diskItems !== null) {
          this.cachedNativeSchedules = diskItems;
          this.cachedNativeSchedulesAt = Date.now();
          return this.cachedNativeSchedules;
        }

        const loginPath = await this.getLoginPath();
        const { stdout } = await execCommand("paseo", ["schedule", "ls", "--json"], {
          env: { ...process.env, PATH: loginPath },
          timeout: 6_000,
          maxBuffer: 256 * 1024,
        });
        const parsed = JSON.parse(stdout.trim() || "[]");
        if (Array.isArray(parsed)) {
          this.cachedNativeSchedules = parsed
            .map((item) => parseNativeScheduleRecord(item))
            .filter(
              (item): item is NativeScheduleItem & { createdAtMs: number } => item !== null,
            )
            .map(({ createdAtMs: _ignored, ...rest }) => rest);
        }
      } catch {
        // Keep previous cached list if CLI is temporarily unavailable
      }
      this.cachedNativeSchedulesAt = Date.now();
      return this.cachedNativeSchedules;
    })();

    this.nativeSchedulesInFlight = task;
    try {
      return await task;
    } finally {
      if (this.nativeSchedulesInFlight === task) {
        this.nativeSchedulesInFlight = null;
      }
    }
  }

  private async refreshNativeSchedulesInBackground(force = false): Promise<void> {
    if (this.stopped) return;
    const prevJson = JSON.stringify(this.cachedNativeSchedules);
    const next = await this.fetchNativeSchedules(force);
    if (!this.stopped && JSON.stringify(next) !== prevJson) {
      await this.broadcastSnapshot();
    }
  }

  private async refreshWorkspaceDirsInBackground(force = false): Promise<void> {
    if (!this.paseo || this.stopped) return;
    const now = Date.now();
    if (!force && this.cachedWorkspaceDirsAt > 0 && now - this.cachedWorkspaceDirsAt < 30_000) {
      return;
    }
    if (this.workspaceDirsInFlight) return this.workspaceDirsInFlight;
    const paseo = this.paseo;
    const task = (async () => {
      try {
        const res = await paseo.workspaces.list();
        const dirs: KnownWorkspace[] = [];
        const seen = new Set<string>();
        for (const ws of res.entries ?? []) {
          const rawDir = ws.projectRootPath || ws.workspaceDirectory;
          if (ws.archivingAt || ws.background || ws.internal || !rawDir) continue;
          const norm = path.resolve(expandHomePath(rawDir));
          if (seen.has(norm)) continue;
          seen.add(norm);
          const label =
            (ws.projectCustomName && ws.projectCustomName.trim()) ||
            (ws.projectDisplayName && ws.projectDisplayName.trim()) ||
            path.basename(norm) ||
            norm;
          dirs.push({ cwd: norm, label });
          if (dirs.length >= 10) break;
        }
        const prevJson = JSON.stringify(this.cachedWorkspaceDirs);
        this.cachedWorkspaceDirs = dirs;
        this.cachedWorkspaceDirsAt = Date.now();
        if (!this.stopped && JSON.stringify(dirs) !== prevJson) {
          await this.broadcastSnapshot();
        }
      } catch {
        this.cachedWorkspaceDirsAt = Date.now();
      }
    })();
    this.workspaceDirsInFlight = task;
    try {
      await task;
    } finally {
      if (this.workspaceDirsInFlight === task) {
        this.workspaceDirsInFlight = null;
      }
    }
  }

  private buildKnownWorkspaces(state: import("./storage").PersistedBotState): KnownWorkspace[] {
    const out: KnownWorkspace[] = [];
    const seen = new Set<string>();
    const add = (rawCwd?: string, customLabel?: string) => {
      if (!rawCwd?.trim()) return;
      const norm = path.resolve(expandHomePath(rawCwd));
      if (seen.has(norm)) return;
      seen.add(norm);
      const label = customLabel?.trim() || path.basename(norm) || norm;
      out.push({ cwd: norm, label });
    };

    add(this.settings.homeCwd);
    for (const ws of this.cachedWorkspaceDirs) {
      add(ws.cwd, ws.label);
    }
    for (const t of state.triggers) {
      add(t.cwd);
    }
    for (const w of state.workers) {
      add(w.cwd);
    }
    return out.slice(0, 8);
  }

  private getMemoizedSuggestions(
    state: import("./storage").PersistedBotState,
  ): RoutineSuggestion[] {
    const activeMask = state.triggers
      .filter((t) => t.enabled)
      .map((t) => `${t.id}:${t.cwd}`)
      .join(",");
    const key = `${this.settings.homeCwd}|${state.workers.length}:${state.workers[0]?.id ?? ""}|${state.triggers.length}:${activeMask}|${state.dismissedSuggestionIds.join(",")}`;
    if (key === this.suggestionsCacheKey) {
      return this.cachedSuggestions;
    }
    this.suggestionsCacheKey = key;
    this.cachedSuggestions = computeRoutineSuggestions(state, this.settings.homeCwd);
    return this.cachedSuggestions;
  }

  async upsertNativeSchedule(input: NativeScheduleUpsertInput): Promise<NativeScheduleItem> {
    const cleanName = input.name.trim();
    if (!cleanName) {
      throw new Error("计划名称不能为空");
    }
    const rawPrompt = input.prompt.trim();
    if (!rawPrompt) {
      throw new Error("计划执行说明不能为空");
    }

    const expandedInputCwd = input.cwd?.trim() ? expandHomePath(input.cwd.trim()) : "";
    const expandedHome = expandHomePath(this.settings.homeCwd);
    const targetCwd =
      expandedInputCwd && (await pathExists(expandedInputCwd))
        ? expandedInputCwd
        : (await pathExists(expandedHome))
          ? expandedHome
          : os.homedir();

    const cadenceSpec = resolveScheduleCadenceArgs({
      cron: input.cron,
      dailyTime: input.dailyTime,
      everySec: input.everySec,
      timezone: input.timezone,
    });
    const cadenceFlags =
      cadenceSpec.mode === "cron"
        ? ["--cron", cadenceSpec.cron, "--timezone", cadenceSpec.timezone]
        : ["--every", cadenceSpec.every];

    const loginPath = await this.getLoginPath();
    const env = { ...process.env, PATH: loginPath };
    const cleanEditId = input.id?.trim();

    if (cleanEditId) {
      if (!/^[A-Za-z0-9_-]+$/.test(cleanEditId)) {
        throw new Error("无效的定时计划 ID");
      }
      const updateArgs = [
        "schedule",
        "update",
        cleanEditId,
        "--name",
        cleanName,
        "--prompt",
        rawPrompt,
        "--cwd",
        targetCwd,
        ...cadenceFlags,
      ];
      if (input.provider?.trim()) {
        updateArgs.push("--provider", input.provider.trim());
      }
      updateArgs.push("--json");

      await execCommand("paseo", updateArgs, {
        env,
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      });

      if (input.enabled !== undefined) {
        const currentList = await this.fetchNativeSchedules(true);
        const existing = currentList.find((s) => s.id === cleanEditId);
        const currentlyActive = existing ? existing.status === "active" : true;
        if (input.enabled && !currentlyActive) {
          await execCommand("paseo", ["schedule", "resume", cleanEditId], {
            env,
            timeout: 8_000,
          });
        } else if (!input.enabled && currentlyActive) {
          await execCommand("paseo", ["schedule", "pause", cleanEditId], {
            env,
            timeout: 8_000,
          });
        }
      }

      const refreshed = await this.fetchNativeSchedules(true);
      await this.broadcastSnapshot();
      const updated = refreshed.find((s) => s.id === cleanEditId);
      if (!updated) {
        throw new Error(`未找到已更新的定时计划 ${cleanEditId}`);
      }
      return updated;
    }

    const launch = await this.resolveLaunchConfig(
      input.provider?.trim() || this.settings.scoutProvider,
      this.settings.scoutModeId,
      targetCwd,
    );
    const finalPrompt = buildNativeSchedulePromptWithGovernance(
      rawPrompt,
      input.governance,
      input.noiseRules,
    );
    const cliSafePrompt = finalPrompt.startsWith("-") ? `\n${finalPrompt}` : finalPrompt;

    const createArgs = [
      "schedule",
      "create",
      "--name",
      cleanName,
      ...cadenceFlags,
      "--provider",
      launch.provider,
      ...(launch.modeId ? ["--mode", launch.modeId] : []),
      "--cwd",
      targetCwd,
      "--json",
      cliSafePrompt,
    ];

    const { stdout } = await execCommand("paseo", createArgs, {
      env,
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });

    let createdId = "";
    try {
      const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
      createdId = String(parsed.id ?? "").trim();
    } catch {
      createdId = "";
    }

    if (createdId && input.enabled === false) {
      await execCommand("paseo", ["schedule", "pause", createdId], {
        env,
        timeout: 8_000,
      }).catch(() => undefined);
    }

    const refreshed = await this.fetchNativeSchedules(true);
    await this.broadcastSnapshot();
    const createdItem =
      (createdId ? refreshed.find((s) => s.id === createdId) : undefined) ??
      refreshed.find((s) => s.name === cleanName);
    if (!createdItem) {
      throw new Error("创建定时计划成功，但读取最新状态失败");
    }
    return createdItem;
  }

  private async migrateLegacyScheduleTriggers(): Promise<void> {
    if (this.stopped) return;
    const state = await this.store.load();
    const legacySchedules = state.triggers.filter(
      (t) => t.kind === "schedule" && !t.onceAt,
    );
    if (legacySchedules.length === 0) return;

    const existingNative = await this.fetchNativeSchedules(true);
    const migratedTriggerIds = new Set<string>();

    for (const trg of legacySchedules) {
      try {
        const cleanName = trg.name.trim();
        const duplicate = existingNative.find(
          (ns) => ns.name.trim().toLowerCase() === cleanName.toLowerCase(),
        );
        if (!duplicate) {
          await this.upsertNativeSchedule({
            name: cleanName,
            prompt: trg.prompt,
            cwd: trg.cwd,
            dailyTime: trg.dailyTime,
            everySec: trg.pollIntervalSec,
            governance: trg.governance,
            noiseRules: trg.noiseRules,
            provider: trg.providerOverride,
            enabled: trg.enabled,
          });
        }
        migratedTriggerIds.add(trg.id);
      } catch (err) {
        console.error(`[paseo-bot] failed to migrate schedule trigger '${trg.name}':`, err);
      }
    }

    if (migratedTriggerIds.size > 0) {
      await this.store.mutate((draft) => {
        draft.triggers = draft.triggers.filter((t) => !migratedTriggerIds.has(t.id));
      });
      await this.fetchNativeSchedules(true);
      await this.broadcastSnapshot();
    }
  }

  async manageNativeSchedule(input: {
    id: string;
    action: "run_once" | "pause" | "resume" | "delete";
  }): Promise<{ ok: boolean; message: string }> {
    const cleanId = input.id.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(cleanId)) {
      return { ok: false, message: "无效的定时任务 ID" };
    }
    const subcmd =
      input.action === "run_once"
        ? "run-once"
        : input.action === "pause"
          ? "pause"
          : input.action === "resume"
            ? "resume"
            : "delete";
    try {
      const loginPath = await this.getLoginPath();
      await execCommand("paseo", ["schedule", subcmd, cleanId], {
        env: { ...process.env, PATH: loginPath },
        timeout: 8_000,
        maxBuffer: 128 * 1024,
      });
      await this.fetchNativeSchedules(true);
      await this.broadcastSnapshot();
      const label =
        input.action === "run_once"
          ? "已触发立即运行"
          : input.action === "pause"
            ? "已暂停定时计划"
            : input.action === "resume"
              ? "已恢复定时计划"
              : "已删除定时计划";
      return { ok: true, message: label };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async manageWorker(input: {
    action: "stop" | "remove" | "clear_finished";
    workerId?: string;
  }): Promise<{ ok: boolean; removedCount?: number }> {
    if (input.action === "clear_finished") {
      let removedCount = 0;
      await this.store.mutate((draft) => {
        const before = draft.workers.length;
        draft.workers = draft.workers.filter(
          (w) => w.status === "running" || w.status === "permission",
        );
        removedCount = before - draft.workers.length;
      });
      await this.broadcastSnapshot();
      return { ok: true, removedCount };
    }

    const targetId = input.workerId?.trim();
    if (!targetId) return { ok: false };

    if (input.action === "remove") {
      let removed = false;
      await this.store.mutate((draft) => {
        const before = draft.workers.length;
        draft.workers = draft.workers.filter((w) => w.id !== targetId);
        removed = draft.workers.length < before;
      });
      if (removed) await this.broadcastSnapshot();
      return { ok: removed, removedCount: removed ? 1 : 0 };
    }

    // stop running worker
    const state = await this.store.load();
    const foundWorker = state.workers.find((w) => w.id === targetId);
    if (!foundWorker) return { ok: false };

    if (this.paseo) {
      await this.paseo.agents.ref(foundWorker.agentId).archive().catch(() => undefined);
    }

    const nowIso = new Date().toISOString();
    await this.store.mutate((draft) => {
      const w = draft.workers.find((item) => item.id === targetId);
      if (w) {
        w.status = "archived";
        w.updatedAt = nowIso;
      }
      for (const f of draft.feed) {
        if (f.agentId === foundWorker.agentId && f.inProgress) {
          f.inProgress = false;
        }
      }
    });
    await this.broadcastSnapshot();
    return { ok: true };
  }

  subscribeSnapshots(listener: (snapshot: ResolvedBotSnapshot) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  subscribeSummary(listener: (summary: BotSummary) => void): () => void {
    this.summarySubscribers.add(listener);
    return () => {
      this.summarySubscribers.delete(listener);
    };
  }

  getEffectiveButlerName(state = this.store.get()): string {
    return (
      state.butlerNameOverride?.trim() ||
      this.settings.butlerName?.trim() ||
      "Paseo Bot"
    );
  }

  getEffectiveUserName(state = this.store.get()): string {
    return state.userNameOverride?.trim() || this.settings.userName?.trim() || "";
  }

  recordL1Escalation(agentId: string, escalation: RecordedL1Escalation): void {
    this.l1Escalations.set(agentId, escalation);
  }

  async syncProfilePreferencesFromMemoryText(content: string): Promise<{
    changed: boolean;
    butlerName: string;
    userName: string;
  }> {
    const parsed = parseProfilePreferenceFromMemoryNote(content);
    if (!parsed.butlerName && !parsed.userName) {
      const state = await this.store.load();
      return {
        changed: false,
        butlerName: this.getEffectiveButlerName(state),
        userName: this.getEffectiveUserName(state),
      };
    }

    let changed = false;
    const nextState = await this.store.mutate((draft) => {
      if (parsed.butlerName && draft.butlerNameOverride !== parsed.butlerName) {
        draft.butlerNameOverride = parsed.butlerName;
        changed = true;
      }
      if (parsed.userName && draft.userNameOverride !== parsed.userName) {
        draft.userNameOverride = parsed.userName;
        changed = true;
      }
    });

    if (changed) {
      await this.broadcastSnapshot();
    }
    return {
      changed,
      butlerName: this.getEffectiveButlerName(nextState),
      userName: this.getEffectiveUserName(nextState),
    };
  }

  async updateButlerProfile(input: {
    butlerName?: string;
    userName?: string;
  }): Promise<{ ok: boolean; butlerName: string; userName: string }> {
    const nextState = await this.store.mutate((draft) => {
      if (input.butlerName !== undefined) {
        const clean = input.butlerName.trim();
        draft.butlerNameOverride = clean.length > 0 ? clean : null;
      }
      if (input.userName !== undefined) {
        const clean = input.userName.trim();
        draft.userNameOverride = clean.length > 0 ? clean : null;
      }
    });
    await this.broadcastSnapshot();
    return {
      ok: true,
      butlerName: this.getEffectiveButlerName(nextState),
      userName: this.getEffectiveUserName(nextState),
    };
  }

  async markMessagesRead(upToMessageId?: string): Promise<{
    ok: boolean;
    markedCount: number;
  }> {
    let markedCount = 0;
    const cleanUpTo = upToMessageId?.trim();
    await this.store.mutate((draft) => {
      let stopReached = false;
      for (const m of draft.messages) {
        if (!stopReached && m.unread) {
          m.unread = false;
          markedCount += 1;
        }
        if (cleanUpTo && m.id === cleanUpTo) {
          stopReached = true;
        }
      }
      if (!cleanUpTo) {
        for (const f of draft.feed) {
          if (f.unread) f.unread = false;
        }
      }
    });
    if (markedCount > 0 || !cleanUpTo) {
      await this.broadcastSnapshot();
    }
    return { ok: true, markedCount };
  }

  private countUnreadItems(state: import("./storage.ts").PersistedBotState): number {
    if (state.messages.length > 0) {
      let count = 0;
      for (const m of state.messages) {
        if (m.unread && m.role !== "user") count += 1;
      }
      return count;
    }
    let count = 0;
    for (const f of state.feed) {
      if (f.unread && f.level !== "silent") count += 1;
    }
    return count;
  }

  async getSummary(): Promise<BotSummary> {
    const state = await this.store.load();
    const unreadCount = this.countUnreadItems(state);
    let pendingApprovalCount = 0;
    for (const a of state.approvals) {
      if (a.status === "pending") pendingApprovalCount += 1;
    }
    let runningWorkerCount = 0;
    for (const w of state.workers) {
      if (w.status === "running" || w.status === "permission") runningWorkerCount += 1;
    }
    return {
      globalPaused: this.settings.globalPaused,
      unreadCount,
      pendingApprovalCount,
      runningWorkerCount,
    };
  }

  private async reloadSettings(
    settingsHandle: PluginSettings<typeof BotSettingsSchema>,
  ): Promise<void> {
    try {
      const current = await settingsHandle.read();
      if (current.status === "ready") {
        this.settings = { ...DEFAULT_BOT_SETTINGS, ...current.values };
      }
    } catch {
      this.settings = DEFAULT_BOT_SETTINGS;
    }
  }

  async getSnapshot(opts?: { includeMemory?: boolean }): Promise<ResolvedBotSnapshot> {
    const now = Date.now();
    const [state, memoryContent] = await Promise.all([
      this.store.load(),
      opts?.includeMemory === false
        ? Promise.resolve("")
        : this.store.readMemory(this.settings.memoryFilePath),
    ]);

    const unreadCount = this.countUnreadItems(state);
    let pendingApprovalCount = 0;
    for (const a of state.approvals) {
      if (a.status === "pending") pendingApprovalCount += 1;
    }
    let runningWorkerCount = 0;
    for (const w of state.workers) {
      if (w.status === "running" || w.status === "permission") runningWorkerCount += 1;
    }
    let totalSilentChecks = 0;
    for (const t of state.triggers) {
      totalSilentChecks += t.silentCount || 0;
    }

    // Stale-while-revalidate: never block UI snapshot reads on CLI subprocesses or agent RPCs
    if (runningWorkerCount > 0 && now - this.lastWorkerReconcileAt >= 10_000) {
      void this.reconcileWorkersWithPaseo(false);
    }
    if (this.cachedNativeSchedulesAt === 0 || now - this.cachedNativeSchedulesAt >= 30_000) {
      void this.refreshNativeSchedulesInBackground(false);
    }
    if (
      this.paseo &&
      (this.cachedWorkspaceDirsAt === 0 || now - this.cachedWorkspaceDirsAt >= 30_000)
    ) {
      void this.refreshWorkspaceDirsInBackground(false);
    }

    const butlerName = this.getEffectiveButlerName(state);
    const userName = this.getEffectiveUserName(state);
    const l1Plan = resolveTierProviderChain("L1", this.settings, this.cachedProviders);
    const l2Plan = resolveTierProviderChain("L2", this.settings, this.cachedProviders);
    const l3Plan = resolveTierProviderChain("L3", this.settings, this.cachedProviders);

    const rawSlice =
      state.messages.length > 0
        ? state.messages.slice(-40)
        : buildOnboardingMessages({ butlerName, userName });
    const untrimmedTailStart = Math.max(0, rawSlice.length - 12);
    const visibleMessages = rawSlice.map((m, idx) => {
      if (idx < untrimmedTailStart && m.details && m.details.length > 2500) {
        return {
          ...m,
          details: `${m.details.slice(0, 2500)}\n\n…（历史长明细已折叠省略）`,
        };
      }
      return m;
    });

    const pendingApprovals = state.approvals.filter((a) => a.status === "pending");
    const resolvedApprovals = state.approvals.filter((a) => a.status !== "pending");
    const keptApprovalIds = new Set<string>([
      ...pendingApprovals.map((a) => a.id),
      ...resolvedApprovals
        .slice(0, Math.max(0, 15 - pendingApprovals.length))
        .map((a) => a.id),
    ]);
    const snapshotApprovals = state.approvals.filter((a) => keptApprovalIds.has(a.id));

    const activeWorkers = state.workers.filter(
      (w) => w.status === "running" || w.status === "permission",
    );
    const finishedWorkers = state.workers.filter(
      (w) => w.status !== "running" && w.status !== "permission",
    );
    const keptWorkerIds = new Set<string>([
      ...activeWorkers.map((w) => w.id),
      ...finishedWorkers
        .slice(0, Math.max(0, 15 - activeWorkers.length))
        .map((w) => w.id),
    ]);
    const snapshotWorkers = state.workers.filter((w) => keptWorkerIds.has(w.id));

    return {
      chiefAgentId: state.chiefAgentId,
      chiefWorkspaceId: state.chiefWorkspaceId,
      webhookBaseUrl: this.getWebhookBaseUrl(),
      hourlyWakesUsed: this.store.countRecentWakes(now),
      hourlyWakeLimit: this.settings.hourlyWakeLimit,
      globalPaused: this.settings.globalPaused,
      unreadCount,
      pendingApprovalCount,
      runningWorkerCount,
      totalSilentChecks,
      triggers: state.triggers,
      nativeSchedules: this.cachedNativeSchedules,
      feed: [],
      approvals: snapshotApprovals,
      workers: snapshotWorkers,
      routineSuggestions: this.getMemoizedSuggestions(state),
      knownWorkspaces: this.buildKnownWorkspaces(state),
      memoryContent,
      memoryPath: this.settings.memoryFilePath,
      butlerName,
      userName,
      messages: visibleMessages,
      routingTelemetry: state.routingTelemetry,
      tierModels: {
        l1: l1Plan.chosenProvider,
        l2: l2Plan.chosenProvider,
        l3: l3Plan.chosenProvider,
      },
    };
  }

  async broadcastSnapshot(): Promise<void> {
    if ((this.subscribers.size === 0 && this.summarySubscribers.size === 0) || this.stopped) return;
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      if ((this.subscribers.size === 0 && this.summarySubscribers.size === 0) || this.stopped) return;
      if (this.subscribers.size > 0) {
        void this.getSnapshot()
          .then((snapshot) => {
            for (const listener of this.subscribers) {
              try {
                listener(snapshot);
              } catch {
                // Ignore broken listener
              }
            }
            if (this.summarySubscribers.size > 0) {
              const summary: BotSummary = {
                globalPaused: snapshot.globalPaused,
                unreadCount: snapshot.unreadCount,
                pendingApprovalCount: snapshot.pendingApprovalCount,
                runningWorkerCount: snapshot.runningWorkerCount,
              };
              for (const listener of this.summarySubscribers) {
                try {
                  listener(summary);
                } catch {
                  // Ignore broken listener
                }
              }
            }
          })
          .catch(() => undefined);
      } else {
        void this.getSummary()
          .then((summary) => {
            for (const listener of this.summarySubscribers) {
              try {
                listener(summary);
              } catch {
                // Ignore broken listener
              }
            }
          })
          .catch(() => undefined);
      }
    }, 120);
    this.broadcastTimer.unref?.();
  }

  async reconcileRuntime(): Promise<void> {
    await this.syncFileWatchers();
    await this.syncWebhookServer();
  }

  private closeAllWatchers(): void {
    for (const active of this.fileWatchers.values()) {
      if (active.timer) clearTimeout(active.timer);
      try {
        active.watcher.close();
      } catch {
        // Ignore
      }
    }
    this.fileWatchers.clear();
  }

  private async syncFileWatchers(): Promise<void> {
    if (this.stopped || this.settings.globalPaused) {
      this.closeAllWatchers();
      return;
    }

    const state = this.store.get();
    const desired = new Map<string, TriggerSpec>();
    for (const t of state.triggers) {
      if (t.enabled && t.kind === "file_watch" && t.watchPath?.trim()) {
        desired.set(t.id, t);
      }
    }

    for (const [id, active] of this.fileWatchers.entries()) {
      const spec = desired.get(id);
      const ignoreKey = spec ? spec.ignorePatterns.join("|") : "";
      if (
        !spec ||
        path.resolve(expandHomePath(spec.watchPath ?? "")) !== active.watchPath ||
        spec.debounceMs !== active.debounceMs ||
        ignoreKey !== active.ignoreKey ||
        (spec.matchRegex ?? "") !== active.matchRegex
      ) {
        if (active.timer) clearTimeout(active.timer);
        try {
          active.watcher.close();
        } catch {
          // Ignore
        }
        this.fileWatchers.delete(id);
      }
    }

    for (const [id, spec] of desired.entries()) {
      if (this.fileWatchers.has(id)) continue;
      const resolvedPath = path.resolve(expandHomePath(spec.watchPath!));
      if (!(await pathExists(resolvedPath))) continue;
      if (this.stopped || this.fileWatchers.has(id)) continue;

      try {
        const compiledRegex = this.compileRegex(spec.matchRegex);
        const pendingFiles = new Set<string>();
        const watcher = fsSync.watch(
          resolvedPath,
          { recursive: process.platform === "darwin" || process.platform === "win32" },
          (_eventType, filename) => {
            const rel = filename ? String(filename) : path.basename(resolvedPath);
            if (shouldIgnoreWatchPath(rel, spec.ignorePatterns)) return;
            const fullTarget = path.resolve(resolvedPath, rel);
            if (this.store.isSelfWritten(fullTarget)) return;
            if (compiledRegex && !compiledRegex.test(rel) && !compiledRegex.test(fullTarget)) {
              return;
            }
            if (pendingFiles.size < MAX_PENDING_WATCH_FILES) {
              pendingFiles.add(rel);
            }
            const entry = this.fileWatchers.get(id);
            if (!entry) return;
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = setTimeout(() => {
              void this.flushFileWatcher(id);
            }, spec.debounceMs);
          },
        );
        watcher.on("error", (err) => {
          console.error(`[paseo-bot] file watcher error (${spec.name}):`, err);
        });
        this.fileWatchers.set(id, {
          watchPath: resolvedPath,
          debounceMs: spec.debounceMs,
          ignoreKey: spec.ignorePatterns.join("|"),
          matchRegex: spec.matchRegex ?? "",
          compiledRegex,
          watcher,
          timer: null,
          pendingFiles,
          lastStatSignature: "",
        });
      } catch (err) {
        console.error(`[paseo-bot] failed to watch ${resolvedPath}:`, err);
      }
    }
  }

  private async flushFileWatcher(triggerId: string): Promise<void> {
    const entry = this.fileWatchers.get(triggerId);
    if (!entry || entry.pendingFiles.size === 0) return;
    const files = [...entry.pendingFiles].slice(0, MAX_PENDING_WATCH_FILES);
    entry.pendingFiles.clear();
    entry.timer = null;

    // Build a stat signature in parallel to deduplicate duplicate OS watcher notifications
    const sigParts = await Promise.all(
      files.map(async (rel) => {
        const full = path.resolve(entry.watchPath, rel);
        try {
          const st = await fs.stat(full);
          return `${rel}:${st.size}:${Math.floor(st.mtimeMs)}`;
        } catch {
          return `${rel}:deleted`;
        }
      }),
    );
    const signature = sigParts.sort().join("|");
    if (signature && signature === entry.lastStatSignature) {
      await this.store.mutateDeferred((draft) => {
        draft.routingTelemetry.l0Hits += 1;
      }, 15_000);
      return;
    }
    entry.lastStatSignature = signature;

    await this.dispatchTrigger(triggerId, {
      reason: "file_watch",
      detail: `Changed files under ${entry.watchPath}:\n${files.map((f) => `- ${f}`).join("\n")}`,
    });
  }

  private async closeWebhookServer(): Promise<void> {
    if (!this.webhookServer) return;
    const srv = this.webhookServer;
    this.webhookServer = null;
    this.activeWebhookPort = null;
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
      srv.closeIdleConnections?.();
      srv.closeAllConnections?.();
    });
  }

  private async syncWebhookServer(): Promise<void> {
    if (this.stopped || !this.settings.webhookEnabled) {
      await this.closeWebhookServer();
      return;
    }
    if (this.webhookServer && this.activeWebhookPort === this.settings.webhookPort) {
      return;
    }
    await this.closeWebhookServer();

    const port = this.settings.webhookPort;
    const server = http.createServer((req, res) => {
      void this.handleWebhookHttp(req, res).catch((err) => {
        console.error("[paseo-bot] webhook request error:", err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: false, error: "Internal webhook error" }));
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    });
    server.keepAliveTimeout = 5_000;
    server.headersTimeout = 10_000;

    await new Promise<void>((resolve) => {
      server.once("error", (err) => {
        console.error(`[paseo-bot] webhook server port ${port} failed:`, err);
        this.webhookServer = null;
        this.activeWebhookPort = null;
        resolve();
      });
      server.listen(port, "127.0.0.1", () => {
        this.webhookServer = server;
        this.activeWebhookPort = port;
        resolve();
      });
    });
  }

  private async handleWebhookHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const sendJson = (code: number, payload: unknown) => {
      if (res.headersSent) return;
      res.statusCode = code;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
    };

    const rawUrl = req.url ?? "/";
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl, "http://127.0.0.1");
    } catch {
      sendJson(400, { ok: false, error: "Invalid request URL" });
      return;
    }
    if (parsedUrl.pathname === "/health") {
      sendJson(200, { ok: true, plugin: "paseo-bot", paused: this.settings.globalPaused });
      return;
    }

    if (parsedUrl.pathname === "/tidy" && (req.method ?? "POST").toUpperCase() === "POST") {
      const secret = this.settings.webhookSecret.trim();
      if (secret) {
        const headerSecret =
          String(req.headers["x-paseo-bot-secret"] ?? "").trim() ||
          String(req.headers.authorization ?? "")
            .replace(/^Bearer\s+/i, "")
            .trim();
        const expectedBuf = Buffer.from(secret, "utf8");
        const actualBuf = Buffer.from(headerSecret, "utf8");
        if (
          expectedBuf.length !== actualBuf.length ||
          !crypto.timingSafeEqual(expectedBuf, actualBuf)
        ) {
          sendJson(401, { ok: false, error: "Invalid webhook secret" });
          return;
        }
      }
      const modeParam = parsedUrl.searchParams.get("mode") === "apply" ? "apply" : "preview";
      const result = await this.tidySessions({ mode: modeParam });
      sendJson(result.ok ? 200 : 503, result);
      return;
    }

    const match = /^\/hook\/([A-Za-z0-9_-]+)$/.exec(parsedUrl.pathname);
    if (!match) {
      sendJson(404, { ok: false, error: "Route not found. Use POST /hook/<webhookKey>" });
      return;
    }
    const webhookKey = match[1];

    const secret = this.settings.webhookSecret.trim();
    if (secret) {
      const headerSecret =
        String(req.headers["x-paseo-bot-secret"] ?? "").trim() ||
        String(req.headers.authorization ?? "")
          .replace(/^Bearer\s+/i, "")
          .trim();
      const expectedBuf = Buffer.from(secret, "utf8");
      const actualBuf = Buffer.from(headerSecret, "utf8");
      if (
        expectedBuf.length !== actualBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, actualBuf)
      ) {
        sendJson(401, { ok: false, error: "Invalid webhook secret" });
        return;
      }
    }

    if (this.settings.globalPaused) {
      sendJson(503, { ok: false, error: "Paseo Bot triggers are currently paused" });
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > 256 * 1024) {
        res.setHeader("connection", "close");
        sendJson(413, { ok: false, error: "Payload exceeds 256 KiB limit" });
        req.resume();
        return;
      }
      chunks.push(buf);
    }
    const bodyText = Buffer.concat(chunks).toString("utf8").trim();
    const querySummary = parsedUrl.search ? `Query: ${parsedUrl.search}` : "";
    const detail = [bodyText, querySummary].filter(Boolean).join("\n") || "(empty webhook ping)";

    const trigger = this.store
      .get()
      .triggers.find(
        (t) => t.enabled && t.kind === "webhook" && t.webhookKey === webhookKey,
      );
    if (!trigger) {
      sendJson(404, { ok: false, error: `No active webhook trigger for key '${webhookKey}'` });
      return;
    }

    const matchRe = this.compileRegex(trigger.matchRegex);
    if (matchRe && !matchRe.test(detail)) {
      await this.store.mutateDeferred((draft) => {
        draft.routingTelemetry.l0Hits += 1;
      }, 15_000);
      sendJson(200, { ok: true, filtered: true, reason: "Did not match regex" });
      return;
    }

    void this.dispatchTrigger(trigger.id, {
      reason: "webhook",
      detail: `Inbound HTTP ${req.method ?? "POST"} /hook/${webhookKey}:\n${detail.slice(0, 6000)}`,
    });

    sendJson(202, { ok: true, queued: true, triggerId: trigger.id, name: trigger.name });
  }

  private async tickScheduler(): Promise<void> {
    if (this.stopped || this.settings.globalPaused || this.schedulerTickInFlight) return;
    this.schedulerTickInFlight = true;
    try {
      const rawTriggers = this.store.get().triggers;
      if (rawTriggers.length === 0) return;
      const now = Date.now();
      const nowDate = new Date(now);
      const triggers = [...rawTriggers];

      for (const trigger of triggers) {
        if (
          !trigger.enabled ||
          this.inFlightTriggers.has(trigger.id) ||
          this.pollingTriggers.has(trigger.id)
        ) {
          continue;
        }

        if (trigger.kind === "poll_command" && trigger.pollCommand?.trim()) {
          const lastCheck = trigger.lastCheckedAt ? Date.parse(trigger.lastCheckedAt) : 0;
          if (!lastCheck || now - lastCheck >= trigger.pollIntervalSec * 1000) {
            void this.evaluatePollTrigger(trigger).catch((err) => {
              console.error(`[paseo-bot] poll trigger error (${trigger.name}):`, err);
            });
          }
          continue;
        }

        if (trigger.kind === "schedule" || trigger.kind === "self_wake") {
          if (trigger.onceAt) {
            const dueAt = Date.parse(trigger.onceAt);
            if (Number.isFinite(dueAt) && now >= dueAt) {
              await this.store.mutate((draft) => {
                const target = draft.triggers.find((t) => t.id === trigger.id);
                if (target) target.enabled = false;
              });
              await this.broadcastSnapshot();
              void this.dispatchTrigger(trigger.id, {
                reason: trigger.kind,
                detail: `One-shot ${trigger.kind} reached scheduled time ${trigger.onceAt}.`,
                manual: true,
              });
            }
            continue;
          }

          if (trigger.dailyTime?.trim()) {
            const hhmm = formatLocalHHMM(nowDate);
            const today = formatLocalDate(nowDate);
            if (hhmm >= trigger.dailyTime.trim() && trigger.lastDailyRunDate !== today) {
              await this.store.mutate((draft) => {
                const target = draft.triggers.find((t) => t.id === trigger.id);
                if (target) target.lastDailyRunDate = today;
              });
              void this.dispatchTrigger(trigger.id, {
                reason: "daily_schedule",
                detail: `Scheduled daily run for ${trigger.dailyTime} (${today}, current local time ${hhmm}).`,
              });
            }
            continue;
          }

          const lastRun = trigger.lastTriggeredAt ? Date.parse(trigger.lastTriggeredAt) : 0;
          if (!lastRun || now - lastRun >= trigger.pollIntervalSec * 1000) {
            void this.dispatchTrigger(trigger.id, {
              reason: trigger.kind,
              detail: `Periodic ${trigger.kind} interval (${trigger.pollIntervalSec}s) elapsed.`,
            });
          }
        }
      }
    } finally {
      this.schedulerTickInFlight = false;
    }
  }

  private async executePollTarget(target: string, cwd: string): Promise<string> {
    const trimmed = target.trim();
    const makeTimeout = (ms: number) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      timer.unref?.();
      return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
    };

    if (/^https?:\/\//i.test(trimmed)) {
      const t = makeTimeout(15_000);
      try {
        const response = await fetch(trimmed, { signal: t.signal });
        let text = "";
        if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let bytesRead = 0;
          try {
            while (bytesRead < MAX_POLL_HTTP_BYTES) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value && value.byteLength > 0) {
                const remaining = MAX_POLL_HTTP_BYTES - bytesRead;
                const slice =
                  value.byteLength > remaining ? value.subarray(0, remaining) : value;
                text += decoder.decode(slice, { stream: true });
                bytesRead += slice.byteLength;
              }
            }
            text += decoder.decode();
          } finally {
            void reader.cancel().catch(() => undefined);
          }
        } else {
          text = await response.text();
        }
        return `HTTP ${response.status}\n${text.slice(0, 12_000)}`;
      } finally {
        t.clear();
      }
    }
    const t = makeTimeout(20_000);
    try {
      const [validCwd, loginPath] = await Promise.all([
        pathExists(cwd),
        this.getLoginPath(),
      ]);
      const { stdout, stderr } = await execCommand("/bin/zsh", ["-fc", trimmed], {
        cwd: validCwd ? cwd : os.homedir(),
        env: { ...process.env, PATH: loginPath },
        maxBuffer: 256 * 1024,
        signal: t.signal,
      });
      return [stdout.trim(), stderr.trim() ? `[stderr]\n${stderr.trim()}` : ""]
        .filter(Boolean)
        .join("\n")
        .slice(0, 12_000);
    } finally {
      t.clear();
    }
  }

  private async evaluatePollTrigger(trigger: TriggerSpec): Promise<void> {
    if (this.pollingTriggers.has(trigger.id) || this.inFlightTriggers.has(trigger.id)) return;
    this.pollingTriggers.add(trigger.id);
    const checkedIso = new Date().toISOString();
    try {
      const output = await this.executePollTarget(trigger.pollCommand!, trigger.cwd);
      const nextHash = computeNormalizedHash(output);

      const matchRe = this.compileRegex(trigger.matchRegex);
      if (matchRe && !matchRe.test(output)) {
        await this.store.mutateDeferred((draft) => {
          draft.routingTelemetry.l0Hits += 1;
          const t = draft.triggers.find((item) => item.id === trigger.id);
          if (t) {
            t.lastCheckedAt = checkedIso;
            t.lastDiffHash = nextHash;
            t.lastSample = output.slice(0, 1200);
            t.silentCount += 1;
          }
        }, 15_000);
        return;
      }

      // First baseline capture: record hash silently so creating a poller doesn't burn tokens immediately
      if (!trigger.lastDiffHash) {
        await this.store.mutate((draft) => {
          draft.routingTelemetry.l0Hits += 1;
          const t = draft.triggers.find((item) => item.id === trigger.id);
          if (t) {
            t.lastCheckedAt = checkedIso;
            t.lastDiffHash = nextHash;
            t.lastSample = output.slice(0, 1200);
          }
        });
        await this.broadcastSnapshot();
        return;
      }

      if (trigger.lastDiffHash === nextHash) {
        await this.store.mutateDeferred((draft) => {
          draft.routingTelemetry.l0Hits += 1;
          const t = draft.triggers.find((item) => item.id === trigger.id);
          if (t) {
            t.lastCheckedAt = checkedIso;
            t.silentCount += 1;
          }
        }, 15_000);
        return;
      }

      const previousSample = trigger.lastSample ?? "(none)";
      await this.store.mutate((draft) => {
        const t = draft.triggers.find((item) => item.id === trigger.id);
        if (t) {
          t.lastCheckedAt = checkedIso;
          t.lastDiffHash = nextHash;
          t.lastSample = output.slice(0, 1200);
        }
      });
      await this.broadcastSnapshot();

      await this.dispatchTrigger(trigger.id, {
        reason: "poll_diff_changed",
        detail: [
          `Poll target changed: ${trigger.pollCommand}`,
          `--- Previous snapshot ---`,
          previousSample,
          `--- Current snapshot ---`,
          output.slice(0, 4000),
        ].join("\n"),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.store.mutate((draft) => {
        const t = draft.triggers.find((item) => item.id === trigger.id);
        if (t) {
          t.lastCheckedAt = checkedIso;
          t.lastError = msg;
        }
      });
      await this.broadcastSnapshot();
    } finally {
      this.pollingTriggers.delete(trigger.id);
    }
  }

  private startProviderCatalogRefresh(): Promise<void> {
    if (!this.paseo) return Promise.resolve();
    if (this.providerCatalogInFlight) return this.providerCatalogInFlight;
    const paseo = this.paseo;
    const task = (async () => {
      try {
        const snap = await paseo.providers.snapshot();
        const entries = Array.isArray(snap.entries) ? snap.entries : [];
        const resolved = await Promise.all(
          entries.map(async (entry) => {
            const available =
              Boolean(entry.enabled) &&
              (entry.status === "ready" || entry.status === "loading");
            if (!available) return null;

            const [rawModels, rawModes] = await Promise.all([
              (entry.models?.length ?? 0) > 0 || entry.status !== "ready"
                ? Promise.resolve(entry.models ?? [])
                : paseo.providers
                    .listModels(entry.provider)
                    .then((r) => r.models ?? [])
                    .catch(() => []),
              (entry.modes?.length ?? 0) > 0 || entry.status !== "ready"
                ? Promise.resolve(entry.modes ?? [])
                : paseo.providers
                    .listModes(entry.provider)
                    .then((r) => r.modes ?? [])
                    .catch(() => []),
            ]);

            const models: CatalogModel[] = rawModels
              .filter((m) => m.isSelectable !== false)
              .map((m) => ({
                id: m.id,
                label: m.label || m.id,
                description: m.description ?? undefined,
                isDefault: m.isDefault || undefined,
              }));

            const defaultModel =
              models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? null;

            const modes = rawModes
              .map((mode) => (typeof mode.id === "string" ? mode.id : ""))
              .filter(Boolean);

            return {
              id: String(entry.provider),
              label: entry.label || String(entry.provider),
              available: true,
              defaultModel,
              models,
              modes,
            };
          }),
        );

        const nextProviders = resolved.filter(
          (p): p is NonNullable<typeof p> => p !== null && p.models.length > 0,
        );
        nextProviders.sort((a, b) => a.label.localeCompare(b.label));
        if (nextProviders.length > 0) {
          this.cachedProviders = nextProviders;
          this.cachedProviderCatalogAt = Date.now();
        }
      } catch {
        // Keep previous cache as fallback
      }
    })();
    this.providerCatalogInFlight = task;
    task.finally(() => {
      if (this.providerCatalogInFlight === task) {
        this.providerCatalogInFlight = null;
      }
    });
    return task;
  }

  private async ensureProviderCatalog(force = false): Promise<void> {
    if (!this.paseo) return;
    const now = Date.now();
    const ttlMs = 5 * 60_000;
    const hasCache = this.cachedProviders.length > 0;
    if (!force && hasCache) {
      if (now - this.cachedProviderCatalogAt >= ttlMs) {
        // SWR: return cached catalog immediately and refresh in background
        void this.startProviderCatalogRefresh();
      }
      return;
    }
    await this.startProviderCatalogRefresh();
  }

  async listAvailableModels(force = false): Promise<{
    defaultProvider: string;
    providers: CatalogProvider[];
  }> {
    await this.ensureProviderCatalog(force);
    return {
      defaultProvider: this.settings.chiefProvider,
      providers: this.cachedProviders.map((p) => ({
        id: p.id,
        label: p.label,
        models: p.models,
      })),
    };
  }

  private providerModesCacheKey(providerId: string, cwd: string): string {
    return `${providerId}\0${path.resolve(expandHomePath(cwd))}`;
  }

  private setCachedProviderModesForCwd(
    providerId: string,
    cwd: string,
    modes: readonly string[],
  ): void {
    const key = this.providerModesCacheKey(providerId, cwd);
    if (this.cachedProviderModesByCwd.size >= 64 && !this.cachedProviderModesByCwd.has(key)) {
      const oldest = this.cachedProviderModesByCwd.keys().next().value;
      if (oldest !== undefined) this.cachedProviderModesByCwd.delete(oldest);
    }
    this.cachedProviderModesByCwd.set(key, {
      modes: [...modes],
      fetchedAt: Date.now(),
    });
  }

  private async getProviderModesForCwd(
    providerId: string,
    cwd?: string,
    fallbackModes?: readonly string[],
  ): Promise<string[]> {
    const fallback = [...(fallbackModes ?? [])];
    if (!this.paseo || !providerId || !cwd) return fallback;

    const normCwd = path.resolve(expandHomePath(cwd));
    const key = `${providerId}\0${normCwd}`;
    const ttlMs = 5 * 60_000;
    const cached = this.cachedProviderModesByCwd.get(key);
    if (cached && Date.now() - cached.fetchedAt < ttlMs) {
      return cached.modes;
    }

    try {
      const res = await this.paseo.providers.listModes(providerId as PaseoAgentProvider, {
        cwd: normCwd,
      });
      const modes = (res.modes ?? [])
        .map((mode) => (typeof mode.id === "string" ? mode.id : ""))
        .filter(Boolean);
      if (modes.length > 0) {
        this.setCachedProviderModesForCwd(providerId, normCwd, modes);
        return modes;
      }
    } catch {
      // Fall back to global catalog modes (and createAgentWithModeFallback protects launch)
    }

    return fallback;
  }

  private resolveLaunchConfigFromCache(
    preferredProviderModel: string,
    preferredModeId: string,
    cwd?: string,
  ): { provider: string; modeId?: string } {
    const [reqProv, reqModel] = preferredProviderModel.includes("/")
      ? preferredProviderModel.split("/", 2)
      : [preferredProviderModel, ""];

    const matched = this.cachedProviders.find((p) => p.id === reqProv && p.available);
    const chosen = matched ?? this.cachedProviders.find((p) => p.available);
    if (!chosen) {
      const cachedModes =
        reqProv && cwd
          ? this.cachedProviderModesByCwd.get(this.providerModesCacheKey(reqProv, cwd))?.modes
          : undefined;
      return {
        provider: preferredProviderModel,
        modeId: cachedModes
          ? pickCompatibleModeId(preferredModeId, cachedModes)
          : preferredModeId || undefined,
      };
    }

    const finalModel = matched && reqModel ? reqModel : chosen.defaultModel;
    const providerPair = finalModel ? `${chosen.id}/${finalModel}` : preferredProviderModel;

    const cwdCachedModes = cwd
      ? this.cachedProviderModesByCwd.get(this.providerModesCacheKey(chosen.id, cwd))?.modes
      : undefined;
    const modeId = pickCompatibleModeId(preferredModeId, cwdCachedModes ?? chosen.modes);
    return { provider: providerPair, modeId };
  }

  private async resolveLaunchConfig(
    preferredProviderModel: string,
    preferredModeId: string,
    cwd?: string,
  ): Promise<{ provider: string; modeId?: string }> {
    if (!this.paseo) {
      return { provider: preferredProviderModel, modeId: preferredModeId || undefined };
    }

    await this.ensureProviderCatalog(false);
    const [reqProv, reqModel] = preferredProviderModel.includes("/")
      ? preferredProviderModel.split("/", 2)
      : [preferredProviderModel, ""];

    const matched = this.cachedProviders.find((p) => p.id === reqProv && p.available);
    const chosen = matched ?? this.cachedProviders.find((p) => p.available);
    const providerId = chosen?.id ?? reqProv;
    const finalModel = chosen
      ? matched && reqModel
        ? reqModel
        : chosen.defaultModel
      : reqModel || null;
    const providerPair =
      chosen && finalModel ? `${chosen.id}/${finalModel}` : preferredProviderModel;

    const modes = await this.getProviderModesForCwd(providerId, cwd, chosen?.modes);
    const modeId =
      modes.length > 0
        ? pickCompatibleModeId(preferredModeId, modes)
        : preferredModeId || undefined;
    return { provider: providerPair, modeId };
  }

  private async createAgentWithModeFallback(
    workspace: Awaited<ReturnType<PaseoApi["workspaces"]["open"]>>,
    input: Parameters<Awaited<ReturnType<PaseoApi["workspaces"]["open"]>>["agents"]["create"]>[0],
    meta: { preferredModeId: string; cwd?: string },
  ) {
    try {
      return await workspace.agents.create(input);
    } catch (err) {
      const parsed = parseInvalidModeError(err);
      if (!parsed) throw err;

      const rawProvider = input.config.provider;
      const providerId = rawProvider.includes("/") ? rawProvider.split("/", 2)[0] : rawProvider;
      if (meta.cwd && parsed.availableModes.length > 0) {
        this.setCachedProviderModesForCwd(providerId, meta.cwd, parsed.availableModes);
      }

      const rejected = new Set(
        [parsed.rejectedMode, input.config.modeId].filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        ),
      );
      const remainingModes = parsed.availableModes.filter((m) => !rejected.has(m));
      const fallbackModeId =
        remainingModes.length > 0
          ? pickCompatibleModeId(meta.preferredModeId, remainingModes)
          : undefined;

      if (fallbackModeId === input.config.modeId) {
        throw err;
      }

      const nextConfig = { ...input.config };
      if (fallbackModeId) {
        nextConfig.modeId = fallbackModeId;
      } else {
        delete nextConfig.modeId;
      }
      return await workspace.agents.create({
        ...input,
        config: nextConfig,
      });
    }
  }

  recordScoutOutcome(agentId: string, outcome: RecordedScoutOutcome): void {
    this.scoutOutcomes.set(agentId, outcome);
  }

  getScoutTriggerMeta(
    agentId: string,
  ): { triggerId: string; triggerName: string } | undefined {
    return this.scoutTriggerMap.get(agentId);
  }

  async draftMission(intent: string, cwd?: string): Promise<MissionDraft> {
    const memoryContent = await this.store
      .readMemory(this.settings.memoryFilePath)
      .catch(() => "");
    return draftMissionFromIntent(
      intent,
      cwd?.trim() || this.settings.homeCwd,
      this.buildKnownWorkspaces(this.store.get()),
      memoryContent,
    );
  }

  async dismissSuggestion(suggestionId: string): Promise<{ ok: boolean }> {
    const clean = suggestionId.trim();
    if (!clean) return { ok: false };
    await this.store.mutate((draft) => {
      if (!draft.dismissedSuggestionIds.includes(clean)) {
        draft.dismissedSuggestionIds.push(clean);
      }
    });
    await this.broadcastSnapshot();
    return { ok: true };
  }

  async curateFeed(input: {
    feedId: string;
    feedback: FeedFeedback;
    ruleNote?: string;
    muteTrigger?: boolean;
  }): Promise<{ ok: boolean; updatedTriggerName?: string }> {
    let targetFeed: FeedItem | undefined;
    let updatedTriggerName: string | undefined;
    let chiefId: string | null = null;
    const cleanNote = input.ruleNote?.trim();

    await this.store.mutate((draft) => {
      chiefId = draft.chiefAgentId;
      const mutated = applyFeedCurationMutation(draft, input);
      targetFeed = mutated.targetFeed;
      updatedTriggerName = mutated.updatedTriggerName;
    });

    if (!targetFeed) return { ok: false };

    if (input.muteTrigger) {
      await this.reconcileRuntime();
    }

    const memPath = this.settings.memoryFilePath;
    if (input.feedback === "up") {
      await this.store.appendMemoryNote(
        memPath,
        `[偏好记录] 用户认为「${targetFeed.title}」这类提醒有用${cleanNote ? `（备注：${cleanNote}）` : ""}，后续继续保留同类通知。`,
      );
    } else {
      await this.store.appendMemoryNote(
        memPath,
        `[过滤规则] 针对「${targetFeed.title}」减少此类提醒${cleanNote ? `：${cleanNote}` : "（同类常规变化直接静默跳过）"}。`,
      );
    }

    await appendChiefAlertCard(this.paseo, chiefId, targetFeed);
    await this.broadcastSnapshot();
    return { ok: true, updatedTriggerName };
  }

  private async listRoutableAgentCandidates(): Promise<RoutableAgentCandidate[]> {
    if (!this.paseo) return [];
    const now = Date.now();
    if (now - this.cachedRoutableAt < 3_000 && this.cachedRoutableCandidates.length > 0) {
      return this.cachedRoutableCandidates;
    }
    const [agentRes, wsRes] = await Promise.all([
      this.paseo.agents.list().catch(() => null),
      this.paseo.workspaces.list().catch(() => null),
    ]);
    if (!agentRes) return [];

    const wsMap = new Map<string, { title: string; projectName: string }>();
    const freshWsDirs: KnownWorkspace[] = [];
    const seenWsDirs = new Set<string>();
    for (const ws of wsRes?.entries ?? []) {
      const wsTitle = (ws.title && ws.title.trim()) || ws.name || "";
      const projectName =
        (ws.projectCustomName && ws.projectCustomName.trim()) ||
        ws.projectDisplayName ||
        "";
      wsMap.set(ws.id, { title: wsTitle, projectName });
      const rawDir = ws.projectRootPath || ws.workspaceDirectory;
      if (!ws.archivingAt && !ws.background && !ws.internal && rawDir) {
        const norm = path.resolve(expandHomePath(rawDir));
        if (!seenWsDirs.has(norm) && freshWsDirs.length < 10) {
          seenWsDirs.add(norm);
          freshWsDirs.push({ cwd: norm, label: projectName || path.basename(norm) || norm });
        }
      }
    }
    if (freshWsDirs.length > 0) {
      this.cachedWorkspaceDirs = freshWsDirs;
      this.cachedWorkspaceDirsAt = now;
    }

    const results: RoutableAgentCandidate[] = [];
    for (const entry of agentRes.entries) {
      const a = entry.agent as unknown as Record<string, unknown>;
      if (!a || typeof a.id !== "string" || a.archivedAt) continue;
      const isBg = Boolean(a.background);
      const labels =
        a.labels && typeof a.labels === "object"
          ? (a.labels as Record<string, unknown>)
          : undefined;
      if (
        isBg ||
        labels?.["paseo-bot/role"] === "scout" ||
        labels?.["paseo-bot/role"] === "butler-l1" ||
        labels?.["paseo-bot/role"] === "butler-exec"
      ) {
        continue;
      }

      const wsId = typeof a.workspaceId === "string" ? a.workspaceId : undefined;
      const wsMeta = wsId ? wsMap.get(wsId) : undefined;
      const rawUpdated = typeof a.updatedAt === "string" ? Date.parse(a.updatedAt) : 0;

      results.push({
        id: a.id,
        title: typeof a.title === "string" ? a.title : "",
        cwd: typeof a.cwd === "string" ? a.cwd : "",
        workspaceId: wsId,
        workspaceTitle: wsMeta?.title,
        projectName: wsMeta?.projectName,
        updatedAtMs: Number.isFinite(rawUpdated) ? rawUpdated : 0,
        isBackground: isBg,
      });
    }
    this.cachedRoutableCandidates = results;
    this.cachedRoutableAt = now;
    return results;
  }

  async executeFeedAction(input: {
    feedId: string;
    actionId?: string;
    customKind?: FeedActionKind;
    customPrompt?: string;
    images?: WishImageAttachment[];
    delayMinutes?: number;
    fallbackProvider?: string;
  }): Promise<{ ok: boolean; message: string; agentId?: string }> {
    const state = await this.store.load();
    const feedItem = state.feed.find((f) => f.id === input.feedId);
    if (!feedItem) {
      return { ok: false, message: "未找到对应的汇报卡片" };
    }

    const matchedAction = input.actionId
      ? feedItem.actions.find((a) => a.id === input.actionId)
      : undefined;

    const kind: FeedActionKind =
      matchedAction?.kind ?? input.customKind ?? (input.delayMinutes ? "snooze" : "wish");
    const targetCwd = expandHomePath(matchedAction?.cwd || this.settings.homeCwd);
    const nowIso = new Date().toISOString();
    const attachedImages = normalizeAgentImages(input.images);

    if (kind === "snooze" || kind === "self_wake") {
      const delay = matchedAction?.delayMinutes ?? input.delayMinutes ?? 120;
      const onceAt = new Date(Date.now() + Math.round(delay * 60_000)).toISOString();
      const followUp =
        matchedAction?.prompt ||
        input.customPrompt?.trim() ||
        `再次检查此前暂缓事项「${feedItem.title}」：\n${feedItem.summary}\n若仍需处理请提醒用户，若已解决则无需提醒。`;

      await this.upsertTrigger({
        name: `稍后提醒 · ${feedItem.title.slice(0, 18)}`,
        description: `Snoozed follow-up from feed ${feedItem.id}`,
        kind: "self_wake",
        governance: "notify",
        executionTarget: "scout_helper",
        cwd: targetCwd,
        prompt: followUp,
        onceAt,
        maxRuns: 1,
        cooldownSec: 0,
      });

      let updatedFeed: FeedItem | undefined;
      await this.store.mutate((draft) => {
        const found = draft.feed.find((f) => f.id === input.feedId);
        if (!found) return;
        found.snoozedUntil = onceAt;
        found.unread = false;
        if (matchedAction) {
          const act = found.actions.find((a) => a.id === matchedAction.id);
          if (act) act.executedAt = nowIso;
        }
        updatedFeed = { ...found };
      });
      if (updatedFeed) {
        void appendChiefAlertCard(this.paseo, state.chiefAgentId, updatedFeed).catch(
          () => undefined,
        );
      }
      await this.broadcastSnapshot();
      const hrs = delay >= 60 && delay % 60 === 0 ? `${delay / 60} 小时` : `${delay} 分钟`;
      return { ok: true, message: `已设置 ${hrs} 后再提醒` };
    }

    const fullReference = feedItem.details || feedItem.summary;
    const rawCustomPrompt = input.customPrompt?.trim() || "";
    const promptText =
      matchedAction?.prompt ||
      rawCustomPrompt ||
      (attachedImages.length > 0
        ? `请结合附带的图片继续跟进这项内容：「${feedItem.title}」`
        : `请继续跟进这项内容：「${feedItem.title}」`);
    const summaryWithImages =
      attachedImages.length > 0
        ? `${rawCustomPrompt || promptText}\n\n${formatImageSummaryTag(attachedImages.length)}`
        : promptText;

    let launchedAgentId: string | undefined;
    let continuedSameOriginSession = false;
    let inheritedModel: string | undefined;
    let routedExternalTarget:
      | { agentId: string; title: string; cwd: string; workspaceId?: string; provider?: string }
      | undefined;

    if (kind === "delegate") {
      const worker = await this.delegateTask({
        title: matchedAction?.label || `跟进 · ${cleanTaskTitle(feedItem.title).slice(0, 18)}`,
        cwd: targetCwd,
        prompt: `${promptText}\n\n--- 背景参考 ---\n${fullReference.slice(0, 6000)}`,
        images: attachedImages.length > 0 ? attachedImages : undefined,
        provider: input.fallbackProvider,
        isolation: "local",
        notifyChiefOnFinish: true,
      });
      launchedAgentId = worker.agentId;
    } else if (this.paseo) {
      const candidates = await this.listRoutableAgentCandidates();
      const route = routeFollowUpCandidate({
        followUpPrompt: promptText,
        cardMarkdown: fullReference,
        fallbackAgentId: feedItem.agentId,
        explicitTargetAgentHint: matchedAction?.targetAgentId,
        candidates,
      });

      const targetId = route?.agentId || feedItem.agentId;
      if (targetId) {
        const handle = this.paseo.agents.ref(targetId);
        const refreshed = await handle.refresh().catch(() => null);
        if (refreshed && !refreshed.agent.archivedAt) {
          const routedAway = Boolean(
            route?.routedAwayFromOrigin ||
              (feedItem.agentId && targetId !== feedItem.agentId) ||
              (!feedItem.agentId && route),
          );
          const payload = routedAway
            ? `[来自 Paseo Bot 汇总卡片的跟进指令]\n${promptText}`
            : promptText;
          // Preserve the located session's original model — do not override it
          await handle.send(
            payload,
            attachedImages.length > 0 ? { images: attachedImages } : undefined,
          );
          launchedAgentId = targetId;
          inheritedModel = formatAgentModelPair(refreshed.agent);
          if (routedAway) {
            routedExternalTarget = {
              agentId: targetId,
              title:
                route?.title ||
                (typeof (refreshed.agent as { title?: unknown }).title === "string"
                  ? ((refreshed.agent as { title: string }).title || targetId.slice(0, 8))
                  : targetId.slice(0, 8)),
              cwd: route?.cwd || refreshed.agent.cwd || targetCwd,
              workspaceId: route?.workspaceId ?? refreshed.agent.workspaceId,
              provider: inheritedModel,
            };
          } else {
            continuedSameOriginSession = true;
          }
        }
      }
    }

    if (!launchedAgentId) {
      const baseTitle = cleanTaskTitle(feedItem.title).slice(0, 22);
      const res = await this.submitWish({
        wish: rawCustomPrompt || promptText,
        images: input.images,
        cwd: targetCwd,
        provider: input.fallbackProvider,
        titleOverride: matchedAction?.label || `跟进 · ${baseTitle}`,
        extraContext: fullReference.slice(0, 6000),
        skipDirectSessionRouting: true,
        asyncLaunch: true,
      });
      launchedAgentId = res.agentId;
    }

    let updatedFeed: FeedItem | undefined;
    await this.store.mutate((draft) => {
      const idx = draft.feed.findIndex((f) => f.id === input.feedId);
      if (idx === -1) return;
      const found = draft.feed[idx];
      found.unread = false;
      if (matchedAction) {
        const act = found.actions.find((a) => a.id === matchedAction.id);
        if (act) act.executedAt = nowIso;
      }

      if (routedExternalTarget) {
        // Preserve the multi-session summary card intact while tracking the routed session separately!
        const cleanRoutedTitle = cleanTaskTitle(routedExternalTarget.title).slice(0, 28);
        found.routedAgentId = routedExternalTarget.agentId;
        found.routedAgentTitle = cleanRoutedTitle;

        const existingTargetCardIdx = draft.feed.findIndex(
          (f) => f.id !== found.id && f.agentId === routedExternalTarget!.agentId && f.inProgress,
        );
        if (existingTargetCardIdx === -1) {
          draft.feed.unshift({
            id: createShortId("feed"),
            createdAt: nowIso,
            level: "worker_update",
            title: `正在续接：${cleanRoutedTitle}`,
            summary: summaryWithImages,
            actions: [],
            inProgress: true,
            agentId: routedExternalTarget.agentId,
            workspaceId: routedExternalTarget.workspaceId,
            unread: false,
          });
        }

        const existingWorker = draft.workers.find(
          (w) => w.agentId === routedExternalTarget!.agentId,
        );
        if (existingWorker) {
          existingWorker.status = "running";
          existingWorker.updatedAt = nowIso;
        } else {
          draft.workers.unshift({
            id: createShortId("wish"),
            agentId: routedExternalTarget.agentId,
            workspaceId: routedExternalTarget.workspaceId,
            title: cleanRoutedTitle || "续接会话",
            cwd: routedExternalTarget.cwd,
            provider: routedExternalTarget.provider || this.settings.chiefProvider,
            isolation: "local",
            status: "running",
            goal: promptText.slice(0, 1000),
            notifyChiefOnFinish: false,
            createdAt: nowIso,
            updatedAt: nowIso,
          });
        }
      } else if (continuedSameOriginSession && launchedAgentId) {
        found.inProgress = true;
        found.createdAt = nowIso;
        draft.feed.splice(idx, 1);
        draft.feed.unshift(found);

        const existingWorker = draft.workers.find((w) => w.agentId === launchedAgentId);
        if (existingWorker) {
          existingWorker.status = "running";
          existingWorker.updatedAt = nowIso;
        } else {
          draft.workers.unshift({
            id: createShortId("wish"),
            agentId: launchedAgentId,
            workspaceId: found.workspaceId,
            title: cleanTaskTitle(found.title).slice(0, 28) || "继续追问",
            cwd: targetCwd,
            provider: inheritedModel || this.settings.chiefProvider,
            isolation: "local",
            status: "running",
            goal: promptText.slice(0, 1000),
            notifyChiefOnFinish: false,
            createdAt: nowIso,
            updatedAt: nowIso,
          });
        }
      }
      updatedFeed = { ...found };
    });
    if (updatedFeed) {
      void appendChiefAlertCard(this.paseo, state.chiefAgentId, updatedFeed).catch(
        () => undefined,
      );
    }
    await this.broadcastSnapshot();
    const modelSuffix = inheritedModel ? `（沿用原模型 ${inheritedModel}）` : "";
    return {
      ok: true,
      message: routedExternalTarget
        ? `已路由至会话「${cleanTaskTitle(routedExternalTarget.title).slice(0, 22)}」${modelSuffix}`
        : continuedSameOriginSession
          ? `已在原会话继续跟进${modelSuffix}`
          : `已开始跟进：${matchedAction?.label || "继续处理"}`,
      agentId: launchedAgentId,
    };
  }

  async pushFeed(input: {
    level: FeedLevel;
    title: string;
    summary: string;
    details?: string;
    actions?: FeedAction[];
    inProgress?: boolean;
    unread?: boolean;
    triggerId?: string;
    triggerName?: string;
    approvalId?: string;
    agentId?: string;
    workspaceId?: string;
    notifyDesktop?: boolean;
    appendChiefTimeline?: boolean;
    skipStreamMessage?: boolean;
    beforeMutate?: (draft: import("./storage.ts").PersistedBotState) => void;
  }): Promise<FeedItem> {
    const item: FeedItem = {
      id: createShortId("feed"),
      createdAt: new Date().toISOString(),
      level: input.level,
      title: input.title,
      summary: input.summary,
      details: input.details,
      actions: input.actions ?? [],
      inProgress: input.inProgress ?? false,
      triggerId: input.triggerId,
      triggerName: input.triggerName,
      approvalId: input.approvalId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      unread: input.unread ?? (input.level !== "silent" && !input.inProgress),
    };

    let chiefId: string | null = null;
    let butlerNameForNotify = "Paseo Bot";
    await this.store.mutate((draft) => {
      input.beforeMutate?.(draft);
      draft.feed.unshift(item);
      chiefId = draft.chiefAgentId;
      butlerNameForNotify = this.getEffectiveButlerName(draft);

      if (input.level === "silent") {
        // Silent checks NEVER pollute single-stream messages
        draft.routingTelemetry.l0Hits += 1;
        return;
      }

      if (input.skipStreamMessage || input.inProgress) {
        return;
      }
      if (input.agentId && this.chatManagedAgentRuns.has(input.agentId)) {
        return;
      }

      const cleanText = stripWorkOrderPrefix(item.summary) || cleanTaskTitle(item.title);
      const inlineLinks = extractInlineLinksFromMarkdown(
        `${item.summary}\n${item.details ?? ""}`,
      );
      if (input.level === "approval_required") {
        draft.messages.push({
          id: createShortId("msg"),
          createdAt: item.createdAt,
          role: "assistant",
          kind: "approval",
          text: cleanText,
          details: item.details,
          images: [],
          links: inlineLinks,
          quickActions: [],
          status: "done",
          approvalId: item.approvalId,
          triggerId: item.triggerId,
          triggerName: item.triggerName,
          agentId: item.agentId,
          workspaceId: item.workspaceId,
          unread: Boolean(item.unread),
        });
      } else {
        draft.messages.push({
          id: createShortId("msg"),
          createdAt: item.createdAt,
          role: "assistant",
          kind: "proactive",
          text: cleanText,
          details: item.details,
          images: [],
          links: inlineLinks,
          quickActions: (item.actions ?? []).slice(0, 2),
          status: input.level === "error" ? "error" : "done",
          approvalId: item.approvalId,
          triggerId: item.triggerId,
          triggerName: item.triggerName,
          agentId: item.agentId,
          workspaceId: item.workspaceId,
          unread: Boolean(item.unread),
        });
      }
    });
    await this.broadcastSnapshot();

    if (input.notifyDesktop && input.level !== "silent") {
      void sendDesktopNotification({
        enabled: this.settings.desktopNotify,
        title: `${butlerNameForNotify} · ${cleanTaskTitle(item.title)}`,
        subtitle: item.triggerName,
        body: stripWorkOrderPrefix(item.summary),
      });
    }
    if (input.appendChiefTimeline !== false && input.level !== "silent") {
      await appendChiefAlertCard(this.paseo, chiefId, item);
    }
    return item;
  }

  async upsertAgentFeedCard(input: {
    agentId: string;
    workspaceId?: string;
    level: FeedLevel;
    title: string;
    summary: string;
    details?: string;
    actions?: FeedAction[];
    notifyDesktop?: boolean;
    appendChiefTimeline?: boolean;
    skipStreamMessage?: boolean;
    beforeMutate?: (draft: import("./storage.ts").PersistedBotState) => void;
  }): Promise<FeedItem> {
    const nowIso = new Date().toISOString();
    let finalItem!: FeedItem;
    let chiefId: string | null = null;
    let butlerNameForNotify = "Paseo Bot";

    await this.store.mutate((draft) => {
      input.beforeMutate?.(draft);
      chiefId = draft.chiefAgentId;
      butlerNameForNotify = this.getEffectiveButlerName(draft);

      // Find an in-progress or initial 'wish' card for this same agentId to update in place
      const existingIdx = draft.feed.findIndex(
        (f) => f.agentId === input.agentId && (f.inProgress || f.level === "wish"),
      );

      if (existingIdx >= 0) {
        const target = draft.feed[existingIdx];
        target.createdAt = nowIso;
        target.level = input.level;
        target.title = input.title;
        target.summary = input.summary;
        target.details = input.details;
        if (input.actions !== undefined) {
          target.actions = input.actions;
        }
        target.snoozedUntil = undefined;
        target.inProgress = false;
        target.unread = input.level !== "silent";
        if (input.workspaceId) target.workspaceId = input.workspaceId;
        draft.feed.splice(existingIdx, 1);
        draft.feed.unshift(target);
        finalItem = { ...target };
      } else {
        const created: FeedItem = {
          id: createShortId("feed"),
          createdAt: nowIso,
          level: input.level,
          title: input.title,
          summary: input.summary,
          details: input.details,
          actions: input.actions ?? [],
          inProgress: false,
          agentId: input.agentId,
          workspaceId: input.workspaceId,
          unread: input.level !== "silent",
        };
        draft.feed.unshift(created);
        finalItem = { ...created };
      }

      if (input.level === "silent") {
        draft.routingTelemetry.l0Hits += 1;
        return;
      }

      if (input.skipStreamMessage || this.chatManagedAgentRuns.has(input.agentId)) {
        return;
      }

      const cleanShortTitle = cleanTaskTitle(finalItem.title);
      const cleanText = stripWorkOrderPrefix(finalItem.summary) || cleanShortTitle;
      const rawLinks = extractInlineLinksFromMarkdown(
        `${finalItem.summary}\n${finalItem.details ?? ""}`,
      );
      const inlineLinks = ensureAgentJumpLink(
        rawLinks,
        input.agentId,
        cleanShortTitle,
      );
      draft.messages.push({
        id: createShortId("msg"),
        createdAt: nowIso,
        role: "assistant",
        kind: input.level === "approval_required" ? "approval" : "proactive",
        text: cleanText,
        details: finalItem.details,
        images: [],
        links: inlineLinks,
        quickActions: (finalItem.actions ?? []).slice(0, 2),
        status: input.level === "error" ? "error" : "done",
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        unread: Boolean(finalItem.unread),
      });
    });

    await this.broadcastSnapshot();

    if (input.notifyDesktop && input.level !== "silent") {
      void sendDesktopNotification({
        enabled: this.settings.desktopNotify,
        title: `${butlerNameForNotify} · ${cleanTaskTitle(finalItem.title)}`,
        subtitle: finalItem.triggerName,
        body: stripWorkOrderPrefix(finalItem.summary),
      });
    }
    if (input.appendChiefTimeline !== false && input.level !== "silent") {
      await appendChiefAlertCard(this.paseo, chiefId, finalItem);
    }
    return finalItem;
  }

  async createApproval(input: {
    title: string;
    actionSummary: string;
    payloadPreview?: string;
    payloadLanguage?: string;
    riskLevel: ApprovalRisk;
    followUpPrompt: string;
    cwd: string;
    sourceAgentId?: string;
    triggerId?: string;
    triggerName?: string;
  }): Promise<ApprovalItem> {
    const approval: ApprovalItem = {
      id: createShortId("apr"),
      createdAt: new Date().toISOString(),
      status: "pending",
      title: input.title,
      actionSummary: input.actionSummary,
      payloadPreview: input.payloadPreview,
      payloadLanguage: input.payloadLanguage,
      riskLevel: input.riskLevel,
      followUpPrompt: input.followUpPrompt,
      cwd: expandHomePath(input.cwd || this.settings.homeCwd),
      sourceAgentId: input.sourceAgentId,
      triggerId: input.triggerId,
      triggerName: input.triggerName,
    };

    if (input.sourceAgentId) {
      this.recordScoutOutcome(input.sourceAgentId, {
        level: "approval_required",
        title: input.title,
        summary: input.actionSummary,
      });
    }

    let chiefId: string | null = null;
    await this.pushFeed({
      level: "approval_required",
      title: `待确认：${approval.title}`,
      summary: approval.actionSummary,
      details: approval.payloadPreview,
      triggerId: input.triggerId,
      triggerName: input.triggerName,
      approvalId: approval.id,
      notifyDesktop: true,
      appendChiefTimeline: false,
      beforeMutate: (draft) => {
        draft.approvals.unshift(approval);
        chiefId = draft.chiefAgentId;
      },
    });

    await upsertChiefApprovalCard(this.paseo, chiefId, approval);
    return approval;
  }

  async resolveApproval(input: {
    id: string;
    decision: "approved" | "rejected";
    note?: string;
    editedFollowUpPrompt?: string;
    promoteTrust?: boolean;
  }): Promise<{
    ok: boolean;
    executionAgentId?: string;
    promotedTriggerName?: string;
  }> {
    let target: ApprovalItem | undefined;
    let chiefId: string | null = null;
    let promotedTriggerName: string | undefined;
    const resolvedAt = new Date().toISOString();

    await this.store.mutate((draft) => {
      const mutated = applyApprovalResolutionMutation(draft, input, resolvedAt);
      target = mutated.target;
      promotedTriggerName = mutated.promotedTriggerName;
      chiefId = draft.chiefAgentId;
    });

    if (!target) return { ok: false };

    if (input.decision === "approved" && input.promoteTrust) {
      await this.store.appendMemoryNote(
        this.settings.memoryFilePath,
        `[自动执行授权] 用户已确认「${promotedTriggerName || target.title}」，并将该规则设为后续自动执行、完成后发送提醒。`,
      );
    } else if (input.decision === "rejected" && target.decisionNote) {
      await this.store.appendMemoryNote(
        this.settings.memoryFilePath,
        `[拒绝原因记录] 用户拒绝了「${target.title}」，备注：${target.decisionNote}`,
      );
    }

    let executionAgentId: string | undefined;
    if (input.decision === "approved" && this.paseo) {
      const tidyPlanId =
        extractTidyPlanIdFromPrompt(target.followUpPrompt) ??
        extractTidyPlanIdFromPrompt(target.payloadPreview);

      if (tidyPlanId) {
        const plan = await loadTidyPlan(tidyPlanId);
        if (plan) {
          const approvedKeys = parseApprovedItemKeysFromMarkdown(target.followUpPrompt, plan);
          const loginPath = await this.getLoginPath();
          const execRes = await executeTidyPlan({
            paseo: this.paseo,
            plan,
            approvedKeys,
            loginPath,
            markSelfWrite: (filePath) => this.store.markSelfWrite(filePath),
          });
          this.cachedRoutableAt = 0;
          this.cachedWorkspaceDirsAt = 0;

          const resultSummaryParts = [
            execRes.pinnedHubs > 0 ? `置顶 ${execRes.pinnedHubs} 个常驻主工作区` : "",
            execRes.renamedCount > 0 ? `规范重命名 ${execRes.renamedCount} 项` : "",
            execRes.mergedClusters > 0 ? `合并 ${execRes.mergedClusters} 组同主题会话` : "",
            execRes.archivedWorkspaces > 0 || execRes.archivedAgents > 0
              ? `归档 ${execRes.archivedWorkspaces} 个工作区 / ${execRes.archivedAgents} 个旧会话`
              : "",
            execRes.obsidianNotesPaths.length > 0
              ? `生成 ${execRes.obsidianNotesPaths.length} 篇知识库合并摘要`
              : "",
          ].filter(Boolean);
          const summaryLine =
            resultSummaryParts.length > 0
              ? `已完成整理：${resultSummaryParts.join(" · ")}。`
              : "未勾选任何待执行整理项。";
          const detailLines =
            execRes.errors.length > 0
              ? `${summaryLine}\n\n部分跳过或异常：\n${execRes.errors.map((e) => `- ${e}`).join("\n")}`
              : undefined;

          await this.store.mutate((draft) => {
            for (const f of draft.feed) {
              if (f.approvalId === input.id) {
                f.title = `已完成：${target!.title}`;
                f.summary = summaryLine;
                if (detailLines) f.details = detailLines;
                f.unread = false;
              }
            }
            for (const m of draft.messages) {
              if (m.approvalId === input.id) {
                m.unread = false;
                m.status = "done";
              }
            }
            draft.messages.push({
              id: createShortId("msg"),
              createdAt: new Date().toISOString(),
              role: "assistant",
              kind: "chat",
              text: summaryLine,
              details: detailLines,
              images: [],
              links: [],
              quickActions: [],
              tier: "L0",
              status: "done",
              unread: false,
            });
          });
          await upsertChiefApprovalCard(this.paseo, chiefId, target);
          await this.broadcastSnapshot();
          return { ok: true, promotedTriggerName };
        }
      }

      const worker = await this.delegateTask({
        title: `Approved: ${target.title}`,
        cwd: target.cwd,
        prompt: [
          `The user APPROVED the following guarded action in Paseo Bot Sentinel:`,
          `Title: ${target.title}`,
          `Approved Action Summary: ${target.actionSummary}`,
          target.decisionNote ? `User Note / Constraints: ${target.decisionNote}` : "",
          ``,
          `Execute the approved instructions now:`,
          target.followUpPrompt,
        ]
          .filter(Boolean)
          .join("\n"),
        isolation: "local",
        notifyChiefOnFinish: true,
      });
      executionAgentId = worker.agentId;
      await this.store.mutate((draft) => {
        const found = draft.approvals.find((a) => a.id === input.id);
        if (found) found.executionAgentId = executionAgentId;
        if (found) target = { ...found };
      });
    }

    await upsertChiefApprovalCard(this.paseo, chiefId, target);
    await this.broadcastSnapshot();
    return { ok: true, executionAgentId, promotedTriggerName };
  }

  async ensureChiefBot(opts?: {
    reset?: boolean;
    provider?: string;
  }): Promise<{
    agentId: string;
    workspaceId: string | null;
    created: boolean;
    modelUsed?: string;
  }> {
    if (this.ensureChiefInFlight && !opts?.reset) {
      return this.ensureChiefInFlight;
    }
    const task = this.ensureChiefBotInternal(opts);
    this.ensureChiefInFlight = task;
    try {
      return await task;
    } finally {
      if (this.ensureChiefInFlight === task) {
        this.ensureChiefInFlight = null;
      }
    }
  }

  private async ensureChiefBotInternal(opts?: {
    reset?: boolean;
    provider?: string;
  }): Promise<{
    agentId: string;
    workspaceId: string | null;
    created: boolean;
    modelUsed?: string;
  }> {
    if (!this.paseo) {
      throw new Error("Paseo daemon connection is not initialized yet");
    }

    const state = await this.store.load();
    if (!opts?.reset && state.chiefAgentId) {
      const handle = this.paseo.agents.ref(state.chiefAgentId);
      const refreshed = await handle.refresh().catch(() => null);
      if (refreshed && !refreshed.agent.archivedAt) {
        if (refreshed.agent.workspaceId !== state.chiefWorkspaceId) {
          await this.store.mutate((draft) => {
            draft.chiefWorkspaceId = refreshed.agent.workspaceId ?? null;
          });
          await this.broadcastSnapshot();
        }
        return {
          agentId: refreshed.agent.id,
          workspaceId: refreshed.agent.workspaceId ?? null,
          created: false,
          modelUsed: formatAgentModelPair(refreshed.agent),
        };
      }
    }

    const expandedHome = expandHomePath(this.settings.homeCwd);
    const homeCwd = (await pathExists(expandedHome)) ? expandedHome : os.homedir();
    const workspace = await this.paseo.workspaces.open(homeCwd);
    const launch = await this.resolveLaunchConfig(
      opts?.provider?.trim() || this.settings.chiefProvider,
      this.settings.chiefModeId,
      homeCwd,
    );

    const chief = await this.createAgentWithModeFallback(
      workspace,
      {
        config: {
          provider: launch.provider,
          modeId: launch.modeId,
          systemPrompt: [
            "You are Paseo Bot, the user's high-EQ Chief-of-Staff coordinator inside Paseo (synthesizing Poke's zero-admin conversational brevity, ChatGPT Pulse's curated briefings, Meta Muse's 3-layer status clarity, OpenAI Dots' staging gates, and Grok Bot's proactive routines).",
            "Core Principles:",
            "1. Zero-Admin Intent: The user speaks in high-level wishes and natural feedback. You translate them into persistent triggers (`paseo_bot_create_trigger`), scheduled self-wakes (`paseo_bot_self_wake`), or asynchronous worker delegations (`paseo_bot_delegate_task`) without asking the user to configure raw parameters.",
            "2. Actionable Pokes over Logs: When calling `paseo_bot_report_outcome` with `level: 'notify'`, lead with a sharp conclusion in `summary`, put deeper evidence in `details`, and attach 1-2 helpful one-tap follow-up buttons in `actions`.",
            "3. Living Memory & Calibration: Keep user preferences, noise boundaries, and active goals updated in `MEMORY.md` using `paseo_bot_memory_read` and `paseo_bot_memory_write`.",
            "4. Zero-Token Efficiency: Prefer `poll_command` (SHA-256 diff gate) or `file_watch` triggers so unchanged routine checks consume zero tokens.",
            "5. Sentinel Staging Gate: Never send external emails/messages, spend money, or make destructive changes directly — call `paseo_bot_request_approval` with `payloadPreview` (exact draft/command/diff) so the user can inspect, tweak, or promote trust.",
          ].join("\n"),
        },
        title: "Paseo Bot",
        labels: {
          "paseo-bot/role": "chief",
        },
      },
      { preferredModeId: this.settings.chiefModeId, cwd: homeCwd },
    );

    const workspaceId = chief.workspaceId ?? workspace.id;
    await this.store.mutate((draft) => {
      draft.chiefAgentId = chief.id;
      draft.chiefWorkspaceId = workspaceId;
    });
    await this.broadcastSnapshot();

    return { agentId: chief.id, workspaceId, created: true, modelUsed: launch.provider };
  }

  async submitWish(input: {
    wish: string;
    images?: WishImageAttachment[];
    cwd?: string;
    provider?: string;
    titleOverride?: string;
    extraContext?: string;
    skipDirectSessionRouting?: boolean;
    skipStreamMessage?: boolean;
    asyncLaunch?: boolean;
  }): Promise<{
    agentId: string;
    workspaceId: string | null;
    feedId?: string;
    pendingLaunch?: boolean;
    reusedSession?: boolean;
    sessionTitle?: string;
    modelUsed?: string;
  }> {
    if (!this.paseo) {
      throw new Error("Paseo daemon connection is not initialized yet");
    }

    const paseo = this.paseo;
    const {
      cleanWish,
      attachedImages,
      effectiveWishText,
      feedSummaryText,
      baseLabel,
    } = resolveWishSubmissionContent({
      wish: input.wish,
      images: input.images,
      titleOverride: input.titleOverride,
    });
    if (!cleanWish && attachedImages.length === 0) {
      throw new Error("Wish text or at least one image is required");
    }

    if (!input.skipStreamMessage) {
      const safeImages = (input.images ?? []).map((img) => ({
        mimeType: img.mimeType,
        ...(img.name ? { name: img.name } : {}),
      }));
      await this.store.mutate((draft) => {
        draft.messages.push({
          id: createShortId("msg"),
          createdAt: new Date().toISOString(),
          role: "user",
          kind: "chat",
          text: cleanWish || formatImageSummaryTag(attachedImages.length),
          images: safeImages,
          links: [],
          quickActions: [],
          status: "done",
          unread: false,
        });
      });
    }

    // If the wish explicitly locates an existing session (by session ID / conversation:// / quoted workspace),
    // continue directly in that session and preserve its original model.
    // Fast regex pre-check skips expensive agents.list() + workspaces.list() IPCs on normal wishes.
    if (!input.skipDirectSessionRouting && cleanWish && hasDirectSessionReferenceHint(cleanWish)) {
      const candidates = await this.listRoutableAgentCandidates();
      const directRoute = routeDirectWishToSession({ wish: cleanWish, candidates });
      if (directRoute) {
        const handle = paseo.agents.ref(directRoute.agentId);
        const refreshed = await handle.refresh().catch(() => null);
        if (refreshed && !refreshed.agent.archivedAt) {
          const actualModel = formatAgentModelPair(refreshed.agent);
          const sessionTitle = cleanTaskTitle(directRoute.title).slice(0, 28) || directRoute.agentId.slice(0, 8);
          await handle.send(
            `[来自 Paseo Bot 对话框的续接指令]\n${effectiveWishText}`,
            attachedImages.length > 0 ? { images: attachedImages } : undefined,
          );
          const nowIso = new Date().toISOString();
          const wsId = directRoute.workspaceId ?? refreshed.agent.workspaceId ?? null;
          const feedItem = await this.pushFeed({
            level: "worker_update",
            title: `正在续接：${sessionTitle}`,
            summary: feedSummaryText,
            inProgress: true,
            unread: false,
            agentId: directRoute.agentId,
            workspaceId: wsId ?? undefined,
            notifyDesktop: false,
            appendChiefTimeline: false,
            beforeMutate: (draft) => {
              const existingWorker = draft.workers.find((w) => w.agentId === directRoute.agentId);
              if (existingWorker) {
                existingWorker.status = "running";
                existingWorker.updatedAt = nowIso;
                if (actualModel) existingWorker.provider = actualModel;
              } else {
                draft.workers.unshift({
                  id: createShortId("wish"),
                  agentId: directRoute.agentId,
                  workspaceId: wsId ?? undefined,
                  title: sessionTitle,
                  cwd: directRoute.cwd || refreshed.agent.cwd || expandHomePath(this.settings.homeCwd),
                  provider: actualModel || this.settings.chiefProvider,
                  isolation: "local",
                  status: "running",
                  goal: feedSummaryText.slice(0, 1000),
                  notifyChiefOnFinish: false,
                  createdAt: nowIso,
                  updatedAt: nowIso,
                });
              }
            },
          });
          return {
            agentId: directRoute.agentId,
            workspaceId: wsId,
            feedId: feedItem.id,
            reusedSession: true,
            sessionTitle,
            modelUsed: actualModel,
          };
        }
      }
    }

    const contextNote = input.cwd ? `\n(Submitted from workspace directory: ${input.cwd})` : "";
    const refBlock = input.extraContext
      ? `\n\n--- Reference Context ---\n${input.extraContext}`
      : "";
    const wishPrompt = [
      `[User Task / Goal]`,
      effectiveWishText + contextNote + refBlock,
      ``,
      `Execution Guidelines:`,
      `- If this requires ongoing monitoring or scheduled checks, configure or update a rule via \`paseo_bot_create_trigger\` or \`paseo_bot_self_wake\`.`,
      `- If it requires work in another workspace/worktree, handle it directly or delegate via \`paseo_bot_delegate_task\`.`,
      `- If it establishes a long-term preference or filter, save it in \`MEMORY.md\` via \`paseo_bot_memory_write\`.`,
      `- When presenting findings that include 1-3 concrete follow-up decisions or optional actions for the user, call \`paseo_bot_report_outcome\` (\`level: "notify"\`) with a concise \`summary\`, full \`details\` (if long), and 1-3 one-tap \`actions\` buttons so the user can click instead of typing.`,
    ].join("\n");

    if (this.settings.wishSessionMode === "shared_chief") {
      const ensured = await this.ensureChiefBot({ provider: input.provider });
      const feedItem = await this.pushFeed({
        level: "wish",
        title: `正在处理：${baseLabel}`,
        summary: feedSummaryText,
        inProgress: true,
        unread: false,
        agentId: ensured.agentId,
        workspaceId: ensured.workspaceId ?? undefined,
        notifyDesktop: false,
        appendChiefTimeline: false,
      });
      await paseo.agents
        .ref(ensured.agentId)
        .send(wishPrompt, attachedImages.length > 0 ? { images: attachedImages } : undefined);
      return {
        agentId: ensured.agentId,
        workspaceId: ensured.workspaceId,
        feedId: feedItem.id,
        reusedSession: !ensured.created,
        sessionTitle: "Paseo Bot",
        modelUsed: ensured.modelUsed,
      };
    }

    // Default ("per_wish"): spawn a clean, parallel dedicated session per wish while sharing global memory & triggers
    const expandedInputCwd = input.cwd ? expandHomePath(input.cwd) : "";
    const memoryContent = !expandedInputCwd
      ? await this.store.readMemory(this.settings.memoryFilePath).catch(() => "")
      : "";
    const inferredCwd = !expandedInputCwd
      ? inferWorkspaceAndWatchPath(
          effectiveWishText,
          this.settings.homeCwd,
          this.buildKnownWorkspaces(this.store.get()),
          memoryContent,
        ).cwd
      : "";
    const expandedHomeCwd = expandHomePath(this.settings.homeCwd);
    const targetCwd =
      expandedInputCwd && (await pathExists(expandedInputCwd))
        ? expandedInputCwd
        : inferredCwd && (await pathExists(inferredCwd))
          ? inferredCwd
          : (await pathExists(expandedHomeCwd))
            ? expandedHomeCwd
            : os.homedir();

    const preferredProvider = input.provider?.trim() || this.settings.chiefProvider;
    const wishWorkerId = createShortId("wish");
    const systemPrompt = [
      "You are Paseo Bot handling a dedicated background task thread.",
      "You share persistent memory (`MEMORY.md`) and automatic rules (`paseo_bot_*`) across all threads.",
      "Never send external emails/messages, spend money, or make destructive changes without calling `paseo_bot_request_approval` with `payloadPreview`.",
    ].join("\n");

    if (input.asyncLaunch) {
      const optimisticModel = this.resolveLaunchConfigFromCache(
        preferredProvider,
        this.settings.chiefModeId,
        targetCwd,
      ).provider;
      const feedItem = await this.pushFeed({
        level: "wish",
        title: `正在处理：${baseLabel}`,
        summary: feedSummaryText,
        inProgress: true,
        unread: false,
        notifyDesktop: false,
        appendChiefTimeline: false,
      });

      // Spawn the workspace & agent asynchronously so the UI submit RPC returns immediately.
      void (async () => {
        try {
          const [workspace, launch] = await Promise.all([
            paseo.workspaces.open(targetCwd),
            this.resolveLaunchConfig(preferredProvider, this.settings.chiefModeId, targetCwd),
          ]);
          if (this.stopped) return;

          const wishAgent = await this.createAgentWithModeFallback(
            workspace,
            {
              config: {
                provider: launch.provider,
                modeId: launch.modeId,
                systemPrompt,
              },
              title: baseLabel,
              prompt: wishPrompt,
              ...(attachedImages.length > 0 ? { images: attachedImages } : {}),
              labels: {
                "paseo-bot/role": "chief",
                "paseo-bot/wish-id": wishWorkerId,
              },
            },
            { preferredModeId: this.settings.chiefModeId, cwd: targetCwd },
          );

          const workspaceId = wishAgent.workspaceId ?? workspace.id;
          const nowIso = new Date().toISOString();
          const record: DelegatedWorker = {
            id: wishWorkerId,
            agentId: wishAgent.id,
            workspaceId,
            title: baseLabel,
            cwd: targetCwd,
            provider: launch.provider,
            isolation: "local",
            status: "running",
            goal: feedSummaryText.slice(0, 1000),
            notifyChiefOnFinish: false,
            createdAt: nowIso,
            updatedAt: nowIso,
          };

          await this.store.mutate((draft) => {
            if (!draft.workers.some((w) => w.id === wishWorkerId || w.agentId === wishAgent.id)) {
              draft.workers.unshift(record);
            }
            const card = draft.feed.find((f) => f.id === feedItem.id);
            if (card) {
              card.agentId = wishAgent.id;
              card.workspaceId = workspaceId;
            }
          });
          await this.broadcastSnapshot();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.store.mutate((draft) => {
            const card = draft.feed.find((f) => f.id === feedItem.id);
            if (card) {
              card.level = "error";
              card.title = `启动失败：${baseLabel}`;
              card.summary = `${feedSummaryText}\n\n启动失败：${msg}`;
              card.inProgress = false;
              card.unread = true;
            }
          });
          await this.broadcastSnapshot();
        }
      })();

      return {
        agentId: "",
        workspaceId: null,
        feedId: feedItem.id,
        pendingLaunch: true,
        reusedSession: false,
        sessionTitle: baseLabel,
        modelUsed: optimisticModel,
      };
    }

    const [workspace, launch] = await Promise.all([
      paseo.workspaces.open(targetCwd),
      this.resolveLaunchConfig(preferredProvider, this.settings.chiefModeId, targetCwd),
    ]);

    const wishAgent = await this.createAgentWithModeFallback(
      workspace,
      {
        config: {
          provider: launch.provider,
          modeId: launch.modeId,
          systemPrompt,
        },
        title: baseLabel,
        prompt: wishPrompt,
        ...(attachedImages.length > 0 ? { images: attachedImages } : {}),
        labels: {
          "paseo-bot/role": "chief",
          "paseo-bot/wish-id": wishWorkerId,
        },
      },
      { preferredModeId: this.settings.chiefModeId, cwd: targetCwd },
    );

    const workspaceId = wishAgent.workspaceId ?? workspace.id;
    const nowIso = new Date().toISOString();
    const record: DelegatedWorker = {
      id: wishWorkerId,
      agentId: wishAgent.id,
      workspaceId,
      title: baseLabel,
      cwd: targetCwd,
      provider: launch.provider,
      isolation: "local",
      status: "running",
      goal: feedSummaryText.slice(0, 1000),
      notifyChiefOnFinish: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const feedItem = await this.pushFeed({
      level: "wish",
      title: `正在处理：${baseLabel}`,
      summary: feedSummaryText,
      inProgress: true,
      unread: false,
      agentId: wishAgent.id,
      workspaceId,
      notifyDesktop: false,
      appendChiefTimeline: false,
      beforeMutate: (draft) => {
        draft.workers.unshift(record);
      },
    });

    return {
      agentId: wishAgent.id,
      workspaceId,
      feedId: feedItem.id,
      reusedSession: false,
      sessionTitle: baseLabel,
      modelUsed: launch.provider,
    };
  }

  private async launchTieredAgentWithFallback(params: {
    tier: "L1" | "L2" | "L3";
    cwd: string;
    title: string;
    systemPrompt?: string;
    prompt?: string;
    images?: Array<{ data: string; mimeType: string }>;
    background?: boolean;
    labels: Record<string, string>;
    providerOverride?: string;
    preferredModeIdOverride?: string;
    isDelegatedWorker?: boolean;
    useWorktree?: boolean;
  }): Promise<{
    handle: Awaited<
      ReturnType<Awaited<ReturnType<PaseoApi["workspaces"]["open"]>>["agents"]["create"]>
    >;
    workspaceId: string | null;
    modelUsed: string;
    degraded: boolean;
  }> {
    if (!this.paseo) {
      throw new Error("Paseo daemon connection is not initialized yet");
    }
    const paseo = this.paseo;
    await this.ensureProviderCatalog(false);
    const plan = resolveTierProviderChain(params.tier, this.settings, this.cachedProviders, {
      providerOverride: params.providerOverride,
      isDelegatedWorker: params.isDelegatedWorker,
    });

    const preferredModeId = params.preferredModeIdOverride || plan.preferredModeId;
    const workspace = params.useWorktree
      ? await paseo.workspaces.create({
          title: params.title,
          source: {
            kind: "worktree",
            cwd: params.cwd,
            action: "branch-off",
          },
        })
      : await paseo.workspaces.open(params.cwd);

    const orderedCandidates = [
      plan.chosenProvider,
      ...plan.candidateChain.filter((c) => c !== plan.chosenProvider),
    ];

    let lastErr: unknown;
    let runtimeFallbackOccurred = plan.degraded;

    for (let idx = 0; idx < orderedCandidates.length; idx += 1) {
      const candidateProvider = orderedCandidates[idx];
      if (idx > 0) {
        runtimeFallbackOccurred = true;
      }
      const provId = candidateProvider.includes("/")
        ? candidateProvider.split("/", 2)[0]
        : candidateProvider;
      const matchedCatalogProv = this.cachedProviders.find((p) => p.id === provId);
      const modes = await this.getProviderModesForCwd(
        provId,
        params.cwd,
        matchedCatalogProv?.modes,
      );
      const modeId =
        modes.length > 0
          ? pickCompatibleModeId(preferredModeId, modes)
          : preferredModeId || undefined;
      // Preserve high thinking when L3 degrades to L2 provider
      const thinkingOptionId =
        params.tier === "L3" && runtimeFallbackOccurred ? "high" : plan.thinkingOptionId;

      try {
        const created = await this.createAgentWithModeFallback(
          workspace,
          {
            config: {
              provider: candidateProvider,
              ...(modeId ? { modeId } : {}),
              ...(thinkingOptionId ? { thinkingOptionId } : {}),
              ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
            },
            title: params.title,
            ...(params.prompt ? { prompt: params.prompt } : {}),
            ...(params.images && params.images.length > 0 ? { images: params.images } : {}),
            ...(params.background !== undefined ? { background: params.background } : {}),
            labels: params.labels,
          },
          { preferredModeId, cwd: params.cwd },
        );

        if (runtimeFallbackOccurred) {
          await this.store.mutate((draft) => {
            draft.routingTelemetry.fallbackCount += 1;
          });
        }

        return {
          handle: created,
          workspaceId: created.workspaceId ?? workspace.id ?? null,
          modelUsed: candidateProvider,
          degraded: runtimeFallbackOccurred,
        };
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(String(lastErr ?? "Failed to launch tiered agent"));
  }

  private async ensureWarmL1Agent(opts?: {
    reset?: boolean;
    providerOverride?: string;
  }): Promise<{
    handle: ReturnType<PaseoApi["agents"]["ref"]>;
    modelUsed: string;
  }> {
    if (this.ensureL1InFlight && !opts?.reset && !opts?.providerOverride) {
      return this.ensureL1InFlight;
    }
    const task = this.ensureWarmL1AgentInternal(opts);
    if (!opts?.reset && !opts?.providerOverride) {
      this.ensureL1InFlight = task;
    }
    try {
      return await task;
    } finally {
      if (this.ensureL1InFlight === task) {
        this.ensureL1InFlight = null;
      }
    }
  }

  private async ensureWarmL1AgentInternal(opts?: {
    reset?: boolean;
    providerOverride?: string;
  }): Promise<{
    handle: ReturnType<PaseoApi["agents"]["ref"]>;
    modelUsed: string;
  }> {
    if (!this.paseo) {
      throw new Error("Paseo daemon connection is not initialized yet");
    }

    const state = await this.store.load();
    if (!opts?.reset && !opts?.providerOverride && state.l1AgentId) {
      const existingHandle = this.paseo.agents.ref(state.l1AgentId);
      const refreshed = await existingHandle.refresh().catch(() => null);
      if (
        refreshed &&
        !refreshed.agent.archivedAt &&
        refreshed.agent.status !== "error"
      ) {
        const modelUsed =
          formatAgentModelPair(refreshed.agent) ||
          resolveTierProviderChain("L1", this.settings, this.cachedProviders).chosenProvider;
        return { handle: existingHandle, modelUsed };
      }
      // Self-heal stale or archived L1 session transparently
      await this.store.mutate((draft) => {
        if (draft.l1AgentId === state.l1AgentId) {
          draft.l1AgentId = null;
        }
      });
    }

    const expandedHome = expandHomePath(this.settings.homeCwd);
    const homeCwd = (await pathExists(expandedHome)) ? expandedHome : os.homedir();
    const memoryContent = await this.store
      .readMemory(this.settings.memoryFilePath)
      .catch(() => "");
    const butlerName = this.getEffectiveButlerName(state);
    const userName = this.getEffectiveUserName(state);
    const systemPrompt = await buildButlerL1SystemPrompt(
      {
        butlerName,
        userName,
        memoryContent,
        memoryPath: this.settings.memoryFilePath,
      },
      { promptsDir: this.promptsDir },
    );

    const launched = await this.launchTieredAgentWithFallback({
      tier: "L1",
      cwd: homeCwd,
      title: `${butlerName} · L1`,
      systemPrompt,
      background: true,
      labels: {
        "paseo-bot/role": "butler-l1",
      },
      providerOverride: opts?.providerOverride,
    });

    if (!opts?.providerOverride) {
      await this.store.mutate((draft) => {
        draft.l1AgentId = launched.handle.id;
      });
    }

    return {
      handle: launched.handle,
      modelUsed: launched.modelUsed,
    };
  }

  private async resolveTargetExecutionCwd(
    explicitCwd: string | undefined,
    intentText: string,
    memoryContent: string,
  ): Promise<string> {
    const expandedExplicit = explicitCwd?.trim() ? expandHomePath(explicitCwd.trim()) : "";
    if (expandedExplicit && (await pathExists(expandedExplicit))) {
      return expandedExplicit;
    }
    const inferred = intentText
      ? inferWorkspaceAndWatchPath(
          intentText,
          this.settings.homeCwd,
          this.buildKnownWorkspaces(this.store.get()),
          memoryContent,
        ).cwd
      : "";
    if (inferred && (await pathExists(inferred))) {
      return inferred;
    }
    const expandedHome = expandHomePath(this.settings.homeCwd);
    if (await pathExists(expandedHome)) {
      return expandedHome;
    }
    return os.homedir();
  }

  async reconcileOrphanThinkingAcks(): Promise<number> {
    const state = await this.store.load();
    const activeWorkerIds = new Set<string>();
    for (const w of state.workers) {
      if (w.status === "running" || w.status === "permission") {
        if (w.agentId) activeWorkerIds.add(w.agentId);
        if (w.id) activeWorkerIds.add(w.id);
      }
    }

    const orphanAckIds = new Set<string>();
    for (let i = 0; i < state.messages.length; i += 1) {
      const msg = state.messages[i];
      if (msg.kind !== "ack" || msg.status !== "thinking") continue;

      const linkedToActiveWorker = Boolean(
        (msg.agentId && activeWorkerIds.has(msg.agentId)) ||
          msg.links?.some((l) => {
            const match = l.url.match(/^paseo:\/\/agent\/(.+)$/);
            return Boolean(match?.[1] && activeWorkerIds.has(match[1]));
          }),
      );
      if (linkedToActiveWorker) continue;

      let hasSubsequentReply = false;
      let passedNextUserTurn = false;
      for (let j = i + 1; j < state.messages.length; j += 1) {
        const later = state.messages[j];
        if (later.role === "user") {
          passedNextUserTurn = true;
          continue;
        }
        if (later.role === "assistant" && later.kind !== "ack") {
          if (
            later.replyToMessageId === msg.id ||
            (msg.replyToMessageId && later.replyToMessageId === msg.replyToMessageId) ||
            !passedNextUserTurn
          ) {
            hasSubsequentReply = true;
            break;
          }
        }
      }
      if (hasSubsequentReply) continue;

      orphanAckIds.add(msg.id);
    }

    if (orphanAckIds.size === 0) return 0;

    await this.store.mutate((draft) => {
      for (const m of draft.messages) {
        if (orphanAckIds.has(m.id) && m.kind === "ack" && m.status === "thinking") {
          m.status = "error";
          m.text = "刚才插件正好重启中断了，你可以直接重发这条消息。";
          m.unread = false;
        }
      }
    });
    return orphanAckIds.size;
  }

  private dispatchTwoBeatExecution(params: {
    targetTier: "L2" | "L3";
    ackMessageId: string;
    brief: string;
    cwd?: string;
    providerOverride?: string;
    attachedImages?: Array<{ data: string; mimeType: string }>;
  }): void {
    if (this.stopped) {
      const abortPromise: Promise<void> = this.store
        .mutate((draft) => {
          const ack = draft.messages.find((m) => m.id === params.ackMessageId);
          if (ack) {
            ack.status = "error";
            ack.text = "刚才插件正好重启中断了，你可以直接重发这条消息。";
            ack.unread = false;
          }
        })
        .then(
          () => undefined,
          () => undefined,
        );
      this.activeChatExecPromises.add(abortPromise);
      void abortPromise.finally(() => {
        this.activeChatExecPromises.delete(abortPromise);
      });
      return;
    }

    const bgPromise = (async () => {
      const startMs = Date.now();
      let execHandleId: string | undefined;
      try {
        const state = await this.store.load();
        if (this.stopped) {
          throw new Error("Plugin stopped before launching background execution");
        }
        const memoryContent = await this.store
          .readMemory(this.settings.memoryFilePath)
          .catch(() => "");
        const targetCwd = await this.resolveTargetExecutionCwd(
          params.cwd,
          params.brief,
          memoryContent,
        );
        const butlerName = this.getEffectiveButlerName(state);
        const userName = this.getEffectiveUserName(state);
        const systemPrompt = await buildButlerExecSystemPrompt(
          {
            tier: params.targetTier,
            butlerName,
            userName,
            memoryContent,
            memoryPath: this.settings.memoryFilePath,
          },
          { promptsDir: this.promptsDir },
        );

        const recentContext = state.messages
          .filter((m) => m.id !== params.ackMessageId)
          .slice(-4)
          .map(
            (m) =>
              `- [${m.role}${m.triggerId ? ` trigger=${m.triggerId}` : ""}]: ${m.text.slice(0, 300)}`,
          )
          .join("\n");

        const composedPrompt = [
          `[Butler ${params.targetTier} Execution Brief]`,
          params.brief,
          recentContext ? `\n[Recent Conversation Context]\n${recentContext}` : "",
          ``,
          `Execution & Safety Constraints:`,
          `- Verify facts with available tools/MCP before stating conclusions; explicitly distinguish verified facts from unverified/permission-blocked boundaries.`,
          `- For multi-repository or multi-minute coding/optimization tasks, do a quick initial check (~30-60s), delegate heavy per-workspace edits in parallel via \`paseo_bot_delegate_task\`, and reply promptly with your findings instead of blocking this chat turn for many minutes.`,
          `- Never ask the user to paste plaintext passwords, SSH private keys, or API keys in chat.`,
          `- Any external email/message, payment/purchase, destructive deletion, or irreversible change MUST pause and call \`paseo_bot_request_approval\` with \`payloadPreview\`.`,
          `- Reply directly in warm, concise butler prose (1-3 short paragraphs, bold 1-3 key dates/amounts, inline Markdown links, zero work-order prefixes).`,
        ]
          .filter(Boolean)
          .join("\n");

        const shortTitle =
          cleanTaskTitle(params.brief).replace(/\s+/g, " ").slice(0, 26) || "管家核查";

        if (this.stopped) {
          throw new Error("Plugin stopped before launching background execution");
        }

        const launched = await this.launchTieredAgentWithFallback({
          tier: params.targetTier,
          cwd: targetCwd,
          title: `${butlerName} · ${shortTitle}`,
          systemPrompt,
          prompt: composedPrompt,
          images: params.attachedImages,
          background: true,
          labels: {
            "paseo-bot/role": "butler-exec",
            "paseo-bot/tier": params.targetTier,
          },
          providerOverride: params.providerOverride,
        });

        execHandleId = launched.handle.id;
        const execWorkerId = `exec_${params.ackMessageId}`;
        this.chatManagedAgentRuns.add(execHandleId);
        const launchNowIso = new Date().toISOString();
        await this.store
          .mutate((draft) => {
            const ack = draft.messages.find((m) => m.id === params.ackMessageId);
            if (ack) {
              ack.agentId = execHandleId;
              ack.links = [
                {
                  label: "查看实时进度",
                  url: `paseo://agent/${execHandleId}`,
                  kind: "agent",
                },
              ];
            }
            if (!draft.workers.some((w) => w.id === execWorkerId)) {
              draft.workers.unshift({
                id: execWorkerId,
                agentId: execHandleId!,
                workspaceId: launched.workspaceId ?? undefined,
                title: shortTitle,
                cwd: targetCwd,
                provider: launched.modelUsed,
                isolation: "local",
                status: "running",
                goal: params.brief.slice(0, 240),
                notifyChiefOnFinish: false,
                createdAt: launchNowIso,
                updatedAt: launchNowIso,
              });
            }
          })
          .catch(() => undefined);
        await this.broadcastSnapshot();

        const execTimeoutMs = 15 * 60_000;
        let hardTimer: ReturnType<typeof setTimeout> | null = null;
        const runRes = await Promise.race([
          launched.handle.waitForFinish(execTimeoutMs),
          new Promise<never>((_, reject) => {
            hardTimer = setTimeout(() => {
              reject(new Error(`${params.targetTier} execution timed out after ${execTimeoutMs}ms`));
            }, execTimeoutMs + 1_000);
            hardTimer.unref?.();
          }),
        ]).finally(() => {
          if (hardTimer) clearTimeout(hardTimer);
        });
        const recorded = this.scoutOutcomes.get(execHandleId);
        this.scoutOutcomes.delete(execHandleId);

        if (runRes.status === "error" || runRes.status === "timeout") {
          throw new Error(runRes.error || `${params.targetTier} execution ended with ${runRes.status}`);
        }

        let rawReply = (recorded?.summary || runRes.lastMessage || "").trim();
        if (!rawReply && this.paseo) {
          const tail = await this.paseo.agents
            .ref(execHandleId)
            .timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true })
            .catch(() => null);
          rawReply = extractAssistantText((tail?.entries ?? []).map((e) => e.item));
        }

        const latencyMs = Math.max(1, Date.now() - startMs);
        const nowIso = new Date().toISOString();

        // If Sentinel approval was already emitted during this turn, mark Beat 1 ack done
        // and only append an extra chat bubble if there is distinct explanatory text.
        const hasInlineApproval = this.store
          .get()
          .approvals.some((a) => a.sourceAgentId === execHandleId && a.status === "pending");

        const split = rawReply
          ? splitReplyIntoPreviewAndDetails(stripWorkOrderPrefix(rawReply))
          : { summary: "已为你处理完毕。", details: undefined };
        const finalDetails = recorded?.details || split.details;
        const quickActions = (
          recorded?.actions ?? extractSuggestedActionsFromMarkdown(rawReply)
        ).slice(0, 2);
        const links = extractInlineLinksFromMarkdown(`${split.summary}\n${finalDetails ?? ""}`);

        await this.store.mutate((draft) => {
          const ack = draft.messages.find((m) => m.id === params.ackMessageId);
          if (ack) {
            ack.status = "done";
            ack.links = [];
          }
          const execW = draft.workers.find((w) => w.id === execWorkerId);
          if (execW) {
            execW.status = "completed";
            execW.updatedAt = nowIso;
            execW.summary = split.summary.slice(0, 180);
          }
          if (params.targetTier === "L3") {
            draft.routingTelemetry.l3Hits += 1;
          } else {
            draft.routingTelemetry.l2Hits += 1;
          }
          draft.routingTelemetry.lastTier = params.targetTier;
          draft.routingTelemetry.lastModelUsed = launched.modelUsed;
          draft.routingTelemetry.lastLatencyMs = latencyMs;

          if (!hasInlineApproval || (rawReply && recorded?.level !== "approval_required")) {
            draft.messages.push({
              id: createShortId("msg"),
              createdAt: nowIso,
              role: "assistant",
              kind: "chat",
              text: split.summary,
              details: finalDetails,
              images: [],
              links,
              quickActions,
              tier: params.targetTier,
              modelUsed: launched.modelUsed,
              latencyMs,
              status: "done",
              replyToMessageId: params.ackMessageId,
              agentId: execHandleId,
              workspaceId: launched.workspaceId ?? undefined,
              unread: true,
            });
          }
        });
        await this.broadcastSnapshot();
      } catch (err) {
        const execWorkerId = `exec_${params.ackMessageId}`;
        if (this.stopped) {
          await this.store
            .mutate((draft) => {
              const ack = draft.messages.find((m) => m.id === params.ackMessageId);
              if (ack) {
                ack.status = "error";
                ack.text = "刚才插件正好重启中断了，你可以直接重发这条消息。";
                ack.links = [];
                ack.unread = false;
              }
              const execW = draft.workers.find((w) => w.id === execWorkerId);
              if (execW && execW.status === "running") {
                execW.status = "failed";
                execW.updatedAt = new Date().toISOString();
              }
            })
            .catch(() => undefined);
          return;
        }
        const reason = err instanceof Error ? err.message : String(err);
        const shortReason = reason.slice(0, 140);
        const errorText = `刚才查询时出了点小状况（${shortReason}），你稍后可以再让我试一次。`;
        const errNowIso = new Date().toISOString();
        await this.store
          .mutate((draft) => {
            const ack = draft.messages.find((m) => m.id === params.ackMessageId);
            if (ack) {
              ack.status = "error";
              ack.links = [];
              ack.unread = false;
            }
            const execW = draft.workers.find((w) => w.id === execWorkerId);
            if (execW) {
              execW.status = "failed";
              execW.updatedAt = errNowIso;
              execW.summary = shortReason;
            }
            draft.messages.push({
              id: createShortId("msg"),
              createdAt: errNowIso,
              role: "assistant",
              kind: "chat",
              text: errorText,
              images: [],
              links: [],
              quickActions: [],
              tier: params.targetTier,
              status: "error",
              replyToMessageId: params.ackMessageId,
              agentId: execHandleId,
              unread: true,
            });
          })
          .catch(() => undefined);
        await this.broadcastSnapshot();
      } finally {
        if (execHandleId) {
          this.chatManagedAgentRuns.delete(execHandleId);
        }
      }
    })();

    this.activeChatExecPromises.add(bgPromise);
    void bgPromise.finally(() => {
      this.activeChatExecPromises.delete(bgPromise);
    });
  }

  async sendChatMessage(input: SendChatMessageInput): Promise<SendChatMessageOutput> {
    if (this.stopped) {
      throw new Error("刚才插件正好重启中断了，你可以直接重发这条消息。");
    }
    const startMs = Date.now();
    const cleanText = (input.text ?? "").trim();
    const attachedImages = normalizeAgentImages(input.images);
    if (!cleanText && attachedImages.length === 0) {
      throw new Error("Chat text or at least one image is required");
    }

    const state = await this.store.load();
    const memoryContent = await this.store
      .readMemory(this.settings.memoryFilePath)
      .catch(() => "");
    const routableCandidates =
      cleanText && hasDirectSessionReferenceHint(cleanText) && this.paseo
        ? await this.listRoutableAgentCandidates()
        : [];

    const decision = classifyMessageTier({
      text: cleanText,
      images: input.images,
      forceTier: input.forceTier,
      providerOverride: input.providerOverride,
      settings: this.settings,
      routableCandidates,
      knownWorkspaces: this.buildKnownWorkspaces(state),
      memoryContent,
      recentMessages: state.messages.slice(-6),
      replyToMessageId: input.replyToMessageId,
    });

    const safeStoredImages = (input.images ?? []).map((img) => ({
      mimeType: img.mimeType,
      ...(img.name ? { name: img.name } : {}),
    }));
    const userMsg: ChatMessage = {
      id: createShortId("msg"),
      createdAt: new Date().toISOString(),
      role: "user",
      kind: "chat",
      text: cleanText || formatImageSummaryTag(attachedImages.length),
      images: safeStoredImages,
      links: [],
      quickActions: [],
      status: "done",
      replyToMessageId: input.replyToMessageId,
      unread: false,
    };

    // Branch 1: L0 Zero-Token Local Control Commands
    if (decision.tier === "L0" && decision.reason === "local_control_command") {
      await this.store.mutate((draft) => {
        draft.messages.push(userMsg);
        draft.routingTelemetry.l0Hits += 1;
        draft.routingTelemetry.lastTier = "L0";
        draft.routingTelemetry.lastLatencyMs = Math.max(0, Date.now() - startMs);
      });

      if (decision.localCommand === "pause") {
        await this.setGlobalPaused(true);
        const noteId = createShortId("msg");
        await this.store.mutate((draft) => {
          draft.messages.push({
            id: noteId,
            createdAt: new Date().toISOString(),
            role: "assistant",
            kind: "status_note",
            text: "好的，已暂停全部后台自动规则；需要恢复时随时跟我说。",
            images: [],
            links: [],
            quickActions: [],
            tier: "L0",
            latencyMs: Math.max(0, Date.now() - startMs),
            status: "done",
            replyToMessageId: userMsg.id,
            unread: false,
          });
        });
        await this.broadcastSnapshot();
        return { userMessageId: userMsg.id, assistantMessageId: noteId, tier: "L0" };
      }

      if (decision.localCommand === "resume") {
        await this.setGlobalPaused(false);
        const noteId = createShortId("msg");
        await this.store.mutate((draft) => {
          draft.messages.push({
            id: noteId,
            createdAt: new Date().toISOString(),
            role: "assistant",
            kind: "status_note",
            text: "已恢复后台自动规则，有实质变化时我会第一时间提醒你。",
            images: [],
            links: [],
            quickActions: [],
            tier: "L0",
            latencyMs: Math.max(0, Date.now() - startMs),
            status: "done",
            replyToMessageId: userMsg.id,
            unread: false,
          });
        });
        await this.broadcastSnapshot();
        return { userMessageId: userMsg.id, assistantMessageId: noteId, tier: "L0" };
      }

      const mode = decision.localCommand === "tidy_apply" ? "apply" : "preview";
      const tidyRes = await this.tidySessions({ mode });
      let assistantMessageId: string | undefined;
      if (tidyRes.approvalId) {
        const latest = this.store
          .get()
          .messages.find((m) => m.approvalId === tidyRes.approvalId);
        assistantMessageId = latest?.id;
      } else {
        assistantMessageId = createShortId("msg");
        await this.store.mutate((draft) => {
          draft.messages.push({
            id: assistantMessageId!,
            createdAt: new Date().toISOString(),
            role: "assistant",
            kind: "chat",
            text: tidyRes.summary,
            images: [],
            links: [],
            quickActions: [],
            tier: "L0",
            latencyMs: Math.max(0, Date.now() - startMs),
            status: tidyRes.ok ? "done" : "error",
            replyToMessageId: userMsg.id,
            unread: false,
          });
        });
      }
      await this.broadcastSnapshot();
      return { userMessageId: userMsg.id, assistantMessageId, tier: "L0" };
    }

    if (!this.paseo) {
      throw new Error("Paseo daemon connection is not initialized yet");
    }

    // Branch 2: L0 Direct Session Continuation (preserving original session model)
    if (
      decision.tier === "L0" &&
      decision.reason === "direct_session_route" &&
      decision.directSessionRoute
    ) {
      const route = decision.directSessionRoute;
      const handle = this.paseo.agents.ref(route.agentId);
      const refreshed = await handle.refresh().catch(() => null);
      if (refreshed && !refreshed.agent.archivedAt) {
        const actualModel = formatAgentModelPair(refreshed.agent);
        const sessionTitle =
          cleanTaskTitle(route.title).slice(0, 28) || route.agentId.slice(0, 8);
        await handle.send(
          `[来自 Paseo Bot 对话流的续接消息]\n${cleanText}`,
          attachedImages.length > 0 ? { images: attachedImages } : undefined,
        );
        const wsId = route.workspaceId ?? refreshed.agent.workspaceId ?? undefined;
        const replyMsgId = createShortId("msg");
        const nowIso = new Date().toISOString();
        await this.store.mutate((draft) => {
          draft.messages.push(userMsg);
          draft.messages.push({
            id: replyMsgId,
            createdAt: nowIso,
            role: "assistant",
            kind: "chat",
            text: `已帮你续接到会话「**${sessionTitle}**」继续处理（[查看目标会话](paseo://agent/${route.agentId})），完成后我会同步告诉你。`,
            images: [],
            links: [
              {
                label: "查看目标会话",
                url: `paseo://agent/${route.agentId}`,
                kind: "agent",
              },
            ],
            quickActions: [],
            tier: "L0",
            modelUsed: actualModel,
            latencyMs: Math.max(0, Date.now() - startMs),
            status: "done",
            replyToMessageId: userMsg.id,
            agentId: route.agentId,
            workspaceId: wsId,
            unread: false,
          });
          draft.routingTelemetry.l0Hits += 1;
          draft.routingTelemetry.lastTier = "L0";
          draft.routingTelemetry.lastModelUsed = actualModel;
          draft.routingTelemetry.lastLatencyMs = Math.max(0, Date.now() - startMs);

          const existingWorker = draft.workers.find((w) => w.agentId === route.agentId);
          if (existingWorker) {
            existingWorker.status = "running";
            existingWorker.updatedAt = nowIso;
          } else {
            draft.workers.unshift({
              id: createShortId("wish"),
              agentId: route.agentId,
              workspaceId: wsId,
              title: sessionTitle,
              cwd: route.cwd || refreshed.agent.cwd || expandHomePath(this.settings.homeCwd),
              provider: actualModel || this.settings.execProvider,
              isolation: "local",
              status: "running",
              goal: cleanText.slice(0, 1000),
              notifyChiefOnFinish: false,
              createdAt: nowIso,
              updatedAt: nowIso,
            });
          }
        });
        await this.broadcastSnapshot();
        return {
          userMessageId: userMsg.id,
          assistantMessageId: replyMsgId,
          tier: "L0",
          modelUsed: actualModel,
          agentId: route.agentId,
          routedSessionTitle: sessionTitle,
        };
      }
    }

    // Branch 3: L0 Direct Escalation to L2 / L3 (Two-Beat Handoff)
    if (decision.tier === "L2" || decision.tier === "L3") {
      const targetTier = decision.tier;
      const plan = resolveTierProviderChain(
        targetTier,
        this.settings,
        this.cachedProviders,
        { providerOverride: input.providerOverride },
      );
      const ackMsg: ChatMessage = {
        id: createShortId("msg"),
        createdAt: new Date().toISOString(),
        role: "assistant",
        kind: "ack",
        text:
          decision.immediateAckText ||
          buildImmediateAckText(targetTier, cleanText, attachedImages.length > 0),
        images: [],
        links: [],
        quickActions: [],
        tier: targetTier,
        modelUsed: plan.chosenProvider,
        latencyMs: Math.max(0, Date.now() - startMs),
        status: "thinking",
        replyToMessageId: userMsg.id,
        unread: false,
      };

      await this.store.mutate((draft) => {
        draft.messages.push(userMsg);
        draft.messages.push(ackMsg);
      });
      await this.broadcastSnapshot();

      const effectiveBrief =
        cleanText ||
        (attachedImages.length === 1
          ? "请仔细查看用户发来的图片并给出清晰结论或处理结果。"
          : `请仔细查看用户发来的 ${attachedImages.length} 张图片并给出清晰结论或处理结果。`);

      this.dispatchTwoBeatExecution({
        targetTier,
        ackMessageId: ackMsg.id,
        brief: effectiveBrief,
        cwd: input.cwd,
        providerOverride: input.providerOverride,
        attachedImages: attachedImages.length > 0 ? attachedImages : undefined,
      });

      return {
        userMessageId: userMsg.id,
        ackMessageId: ackMsg.id,
        tier: targetTier,
        modelUsed: plan.chosenProvider,
      };
    }

    // Branch 4: L1 Warm Fast Concierge (with 18s timeout -> L2 fallback & Two-Beat Escalation)
    await this.store.mutate((draft) => {
      draft.messages.push(userMsg);
    });
    await this.broadcastSnapshot();

    const recentSlice = this.store
      .get()
      .messages.filter((m) => m.id !== userMsg.id)
      .slice(-3);
    const contextLines = recentSlice.map(
      (m) =>
        `- [${m.role}${m.triggerId ? ` triggerId="${m.triggerId}"` : ""}${m.triggerName ? ` (${m.triggerName})` : ""}]: ${m.text.slice(0, 260)}`,
    );
    const triggerHint = decision.matchedTriggerId
      ? `\n[Context Hint] User is likely replying to proactive reminder triggerId="${decision.matchedTriggerId}"${decision.matchedTriggerName ? ` ("${decision.matchedTriggerName}")` : ""}.`
      : "";
    const l1TurnPrompt = [
      contextLines.length > 0
        ? `[Recent 3 Bubbles]\n${contextLines.join("\n")}${triggerHint}`
        : "",
      `[User Message]\n${cleanText}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    let l1AgentIdForCleanup: string | null = null;
    try {
      const { handle: l1Handle, modelUsed: l1ModelUsed } = await this.ensureWarmL1Agent({
        providerOverride: input.providerOverride,
      });
      l1AgentIdForCleanup = l1Handle.id;
      this.l1Escalations.delete(l1Handle.id);

      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      const runRes = await Promise.race([
        l1Handle.run(l1TurnPrompt, { timeoutMs: this.l1TimeoutMs }),
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            reject(new Error(`L1 response exceeded ${this.l1TimeoutMs}ms timeout`));
          }, this.l1TimeoutMs);
          timeoutTimer.unref?.();
        }),
      ]).finally(() => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
      });

      if (runRes.status === "error" || runRes.status === "timeout") {
        throw new Error(runRes.error || `L1 ended in status '${runRes.status}'`);
      }

      if (this.stopped) {
        throw new Error("Plugin stopped during L1 turn");
      }

      const l1LatencyMs = Math.max(1, Date.now() - startMs);
      const escalation = this.l1Escalations.get(l1Handle.id);
      this.l1Escalations.delete(l1Handle.id);

      if (escalation) {
        const ackMsg: ChatMessage = {
          id: createShortId("msg"),
          createdAt: new Date().toISOString(),
          role: "assistant",
          kind: "ack",
          text: stripWorkOrderPrefix(escalation.ackBubble),
          images: [],
          links: [],
          quickActions: [],
          tier: "L1",
          modelUsed: l1ModelUsed,
          latencyMs: l1LatencyMs,
          status: "thinking",
          replyToMessageId: userMsg.id,
          unread: false,
        };

        await this.store.mutate((draft) => {
          draft.messages.push(ackMsg);
          draft.routingTelemetry.l1Hits += 1;
          draft.routingTelemetry.lastTier = "L1";
          draft.routingTelemetry.lastModelUsed = l1ModelUsed;
          draft.routingTelemetry.lastLatencyMs = l1LatencyMs;
        });
        await this.broadcastSnapshot();

        this.dispatchTwoBeatExecution({
          targetTier: escalation.targetTier,
          ackMessageId: ackMsg.id,
          brief: escalation.handoffBrief || cleanText,
          cwd: escalation.cwd || input.cwd,
          providerOverride: input.providerOverride,
        });

        return {
          userMessageId: userMsg.id,
          ackMessageId: ackMsg.id,
          tier: "L1",
          modelUsed: l1ModelUsed,
          escalatedTo: escalation.targetTier,
          agentId: l1Handle.id,
        };
      }

      let replyText = (runRes.lastMessage ?? "").trim();
      if (!replyText) {
        const tail = await l1Handle.timeline
          .refetch({ direction: "tail", limit: 1, wholeTurns: true })
          .catch(() => null);
        replyText = extractAssistantText((tail?.entries ?? []).map((e) => e.item));
      }
      replyText = stripWorkOrderPrefix(replyText) || "好的，我已经记下了。";

      // ISS-001 safety net: if user explicitly requested a rename in this L1 turn, ensure profile state stays synced
      if (decision.reason === "memory_or_mute_reply") {
        await this.syncProfilePreferencesFromMemoryText(cleanText);
      }

      const replyMsg: ChatMessage = {
        id: createShortId("msg"),
        createdAt: new Date().toISOString(),
        role: "assistant",
        kind: "chat",
        text: replyText,
        images: [],
        links: extractInlineLinksFromMarkdown(replyText),
        quickActions: [],
        tier: "L1",
        modelUsed: l1ModelUsed,
        latencyMs: l1LatencyMs,
        status: "done",
        replyToMessageId: userMsg.id,
        agentId: l1Handle.id,
        unread: false,
      };

      await this.store.mutate((draft) => {
        draft.messages.push(replyMsg);
        draft.routingTelemetry.l1Hits += 1;
        draft.routingTelemetry.lastTier = "L1";
        draft.routingTelemetry.lastModelUsed = l1ModelUsed;
        draft.routingTelemetry.lastLatencyMs = l1LatencyMs;
      });
      await this.broadcastSnapshot();

      return {
        userMessageId: userMsg.id,
        assistantMessageId: replyMsg.id,
        tier: "L1",
        modelUsed: l1ModelUsed,
        agentId: l1Handle.id,
      };
    } catch {
      if (this.stopped) {
        const interruptedMsg: ChatMessage = {
          id: createShortId("msg"),
          createdAt: new Date().toISOString(),
          role: "assistant",
          kind: "chat",
          text: "刚才插件正好重启中断了，你可以直接重发这条消息。",
          images: [],
          links: [],
          quickActions: [],
          tier: "L1",
          status: "error",
          replyToMessageId: userMsg.id,
          unread: false,
        };
        await this.store
          .mutate((draft) => {
            draft.messages.push(interruptedMsg);
          })
          .catch(() => undefined);
        return {
          userMessageId: userMsg.id,
          assistantMessageId: interruptedMsg.id,
          tier: "L1",
        };
      }

      // L1 timeout (>18s) or provider failure -> reset l1AgentId and seamlessly fall back to L2
      if (l1AgentIdForCleanup && this.paseo) {
        void this.paseo.agents.ref(l1AgentIdForCleanup).archive().catch(() => undefined);
      }
      const fallbackPlan = resolveTierProviderChain(
        "L2",
        this.settings,
        this.cachedProviders,
      );
      const ackMsg: ChatMessage = {
        id: createShortId("msg"),
        createdAt: new Date().toISOString(),
        role: "assistant",
        kind: "ack",
        text: buildImmediateAckText("L2", cleanText, false),
        images: [],
        links: [],
        quickActions: [],
        tier: "L2",
        modelUsed: fallbackPlan.chosenProvider,
        status: "thinking",
        replyToMessageId: userMsg.id,
        unread: false,
      };

      await this.store.mutate((draft) => {
        if (l1AgentIdForCleanup && draft.l1AgentId === l1AgentIdForCleanup) {
          draft.l1AgentId = null;
        } else if (!l1AgentIdForCleanup) {
          draft.l1AgentId = null;
        }
        draft.routingTelemetry.fallbackCount += 1;
        draft.messages.push(ackMsg);
      });
      await this.broadcastSnapshot();

      this.dispatchTwoBeatExecution({
        targetTier: "L2",
        ackMessageId: ackMsg.id,
        brief: cleanText,
        cwd: input.cwd,
      });

      return {
        userMessageId: userMsg.id,
        ackMessageId: ackMsg.id,
        tier: "L2",
        escalatedTo: "L2",
        modelUsed: fallbackPlan.chosenProvider,
      };
    }
  }

  async delegateTask(input: {
    title: string;
    cwd: string;
    prompt: string;
    images?: Array<{ data: string; mimeType: string }>;
    provider?: string;
    modeId?: string;
    isolation?: "local" | "worktree";
    notifyChiefOnFinish?: boolean;
  }): Promise<DelegatedWorker> {
    if (!this.paseo) {
      throw new Error("Paseo daemon connection is not initialized yet");
    }

    const expandedInput = expandHomePath(input.cwd);
    const expandedHome = expandHomePath(this.settings.homeCwd);
    const targetCwd = (await pathExists(expandedInput))
      ? expandedInput
      : (await pathExists(expandedHome))
        ? expandedHome
        : os.homedir();
    const isolation = input.isolation ?? "local";
    const workerId = createShortId("wrk");
    const preferredWorkerModeId = input.modeId?.trim() || this.settings.defaultWorkerModeId;
    const launched = await this.launchTieredAgentWithFallback({
      tier: "L2",
      cwd: targetCwd,
      title: `Bot Worker · ${input.title}`,
      prompt: input.prompt,
      images: input.images,
      labels: {
        "paseo-bot/role": "worker",
        "paseo-bot/worker-id": workerId,
      },
      providerOverride: input.provider?.trim() || this.settings.defaultWorkerProvider,
      preferredModeIdOverride: preferredWorkerModeId,
      isDelegatedWorker: true,
      useWorktree: isolation === "worktree",
    });

    const nowIso = new Date().toISOString();
    const record: DelegatedWorker = {
      id: workerId,
      agentId: launched.handle.id,
      workspaceId: launched.workspaceId ?? undefined,
      title: input.title,
      cwd: targetCwd,
      provider: launched.modelUsed,
      isolation,
      status: "running",
      goal: input.prompt.slice(0, 1000),
      notifyChiefOnFinish: input.notifyChiefOnFinish ?? true,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await this.pushFeed({
      level: "worker_update",
      title: `正在执行：${cleanTaskTitle(record.title)}`,
      summary: `工作目录：${record.cwd} (${record.isolation})\n模型：${record.provider}`,
      inProgress: true,
      unread: false,
      agentId: record.agentId,
      workspaceId: record.workspaceId,
      notifyDesktop: false,
      appendChiefTimeline: false,
      beforeMutate: (draft) => {
        draft.workers.unshift(record);
      },
    });
    return record;
  }

  async upsertTrigger(input: TriggerUpsertInput): Promise<TriggerSpec> {
    const nowIso = new Date().toISOString();
    let saved!: TriggerSpec;

    await this.store.mutate((draft) => {
      const existing = input.id ? draft.triggers.find((t) => t.id === input.id) : undefined;
      const kind = input.kind;
      const webhookKey =
        kind === "webhook"
          ? (input.webhookKey?.trim() ||
              existing?.webhookKey ||
              `hook_${crypto.randomBytes(4).toString("hex")}`)
          : undefined;

      if (existing) {
        existing.name = input.name.trim();
        existing.description = input.description?.trim() ?? existing.description;
        existing.kind = kind;
        if (input.enabled !== undefined) existing.enabled = input.enabled;
        if (input.governance) existing.governance = input.governance;
        if (input.executionTarget) existing.executionTarget = input.executionTarget;
        if (input.cwd?.trim()) existing.cwd = expandHomePath(input.cwd.trim());
        existing.prompt = input.prompt.trim();
        existing.providerOverride = input.providerOverride?.trim() || undefined;
        existing.watchPath = input.watchPath?.trim()
          ? expandHomePath(input.watchPath.trim())
          : existing.watchPath;
        if (input.ignorePatterns) existing.ignorePatterns = input.ignorePatterns;
        if (input.noiseRules !== undefined) existing.noiseRules = input.noiseRules;
        if (input.debounceMs !== undefined) existing.debounceMs = input.debounceMs;
        existing.webhookKey = webhookKey;
        if (input.pollCommand !== undefined) {
          const nextCmd = input.pollCommand.trim() || undefined;
          if (nextCmd !== existing.pollCommand) {
            existing.lastDiffHash = undefined;
            existing.lastSample = undefined;
          }
          existing.pollCommand = nextCmd;
        }
        if (input.pollIntervalSec !== undefined) existing.pollIntervalSec = input.pollIntervalSec;
        if (input.matchRegex !== undefined) existing.matchRegex = input.matchRegex.trim() || undefined;
        if (input.dailyTime !== undefined) existing.dailyTime = input.dailyTime.trim() || undefined;
        if (input.onceAt !== undefined) existing.onceAt = input.onceAt.trim() || undefined;
        if (input.cooldownSec !== undefined) existing.cooldownSec = input.cooldownSec;
        if (input.maxRuns !== undefined) existing.maxRuns = input.maxRuns;
        existing.updatedAt = nowIso;
        saved = { ...existing };
      } else {
        const createdDate = new Date();
        const createdHHMM = formatLocalHHMM(createdDate);
        const dailyTarget = input.dailyTime?.trim() || undefined;
        const initialLastDaily =
          dailyTarget && createdHHMM >= dailyTarget
            ? formatLocalDate(createdDate)
            : undefined;

        const created: TriggerSpec = {
          id: input.id?.trim() || createShortId("trg"),
          name: input.name.trim(),
          description: input.description?.trim() ?? "",
          kind,
          enabled: input.enabled ?? true,
          governance: input.governance ?? "notify",
          executionTarget: input.executionTarget ?? "scout_helper",
          cwd: expandHomePath(input.cwd?.trim() || this.settings.homeCwd),
          prompt: input.prompt.trim(),
          providerOverride: input.providerOverride?.trim() || undefined,
          watchPath: input.watchPath?.trim()
            ? expandHomePath(input.watchPath.trim())
            : undefined,
          ignorePatterns: input.ignorePatterns ?? [],
          debounceMs: input.debounceMs ?? 4000,
          webhookKey,
          pollCommand: input.pollCommand?.trim() || undefined,
          pollIntervalSec: input.pollIntervalSec ?? 300,
          matchRegex: input.matchRegex?.trim() || undefined,
          dailyTime: dailyTarget,
          onceAt: input.onceAt?.trim() || undefined,
          cooldownSec: input.cooldownSec ?? 45,
          maxRuns: input.maxRuns,
          createdAt: nowIso,
          updatedAt: nowIso,
          runCount: 0,
          silentCount: 0,
          notifyCount: 0,
          approvedCount: 0,
          noiseRules: [],
          lastDailyRunDate: initialLastDaily,
        };
        draft.triggers.unshift(created);
        saved = { ...created };
      }
    });

    await this.reconcileRuntime();
    await this.broadcastSnapshot();
    return saved;
  }

  async installPreset(presetId: PresetId): Promise<PresetInstallResult> {
    const kbRoot = expandHomePath(this.settings.homeCwd);
    if (presetId === "kb_inbox") {
      const saved = await this.upsertTrigger({
        name: "00-Inbox 新草稿自动整理",
        description: "监听 00-Inbox 新增草稿，按 AGENTS.md 规范自动归类、补全元数据并更新 INDEX.md",
        kind: "file_watch",
        governance: "autonomous",
        executionTarget: "scout_helper",
        cwd: kbRoot,
        watchPath: path.join(kbRoot, "00-Inbox"),
        debounceMs: 6000,
        cooldownSec: 60,
        prompt: [
          "检测到知识库 `00-Inbox/` 目录有文件变动。",
          "1. 先检查 `00-Inbox/` 下是否有实质性的未整理笔记（忽略空文件、纯占位 README 或 `.gitkeep`）。如果没有需要消化的草稿，立即调用 `paseo_bot_report_outcome` 传入 `level: 'silent'` 静默退出。",
          "2. 若有新草稿或资料，严格按照仓库根目录 `AGENTS.md` 规范消化归档至 `10-Projects/`、`20-Raw/` 或 `30-Wiki/`，补全 YAML Frontmatter 与 `[[双向链接]]`，并同步更新 `INDEX.md`。",
          "3. 整理完成后调用 `paseo_bot_report_outcome`（`level: 'notify'`）汇报整理了哪些笔记。",
        ].join("\n"),
      });
      return { id: saved.id, name: saved.name, isNativeSchedule: false };
    }

    if (presetId === "universal_webhook") {
      const saved = await this.upsertTrigger({
        name: "本地 Webhook 外部事件回调",
        description: "接收快捷指令、脚本或外部告警推送并按优先级处理",
        kind: "webhook",
        governance: "require_approval",
        executionTarget: "scout_helper",
        cwd: kbRoot,
        cooldownSec: 5,
        prompt: [
          "收到一条外部 Webhook 事件推送。",
          "请评估事件内容：",
          "- 若只是心跳测试或无需关注的噪音，调用 `paseo_bot_report_outcome` (`level: 'silent'`)。",
          "- 若需要提醒用户关注或已完成安全的只读调研，调用 `paseo_bot_report_outcome` (`level: 'notify'`) 给出精炼结论。",
          "- 若事件要求执行外发消息、修改关键业务数据等敏感操作，请调用 `paseo_bot_request_approval` 提交执行方案等待用户批准。",
        ].join("\n"),
      });
      return { id: saved.id, name: saved.name, isNativeSchedule: false };
    }

    const currentSchedules = await this.fetchNativeSchedules(true);

    if (presetId === "session_tidy") {
      const existing = currentSchedules.find(
        (s) => s.name.includes("会话自动整理") || s.cronExpression === "30 22 * * *",
      );
      if (existing) {
        if (existing.status !== "active") {
          await this.manageNativeSchedule({ id: existing.id, action: "resume" });
        }
        return { id: existing.id, name: existing.name, isNativeSchedule: true };
      }
      const created = await this.upsertNativeSchedule({
        name: "每日 22:30 会话自动整理",
        dailyTime: "22:30",
        governance: "require_approval",
        cwd: kbRoot,
        prompt: [
          "现在是每日工作区与会话整理时间。",
          "1. 直接调用 `paseo_bot_tidy_sessions`（传入 `mode: 'preview'`）。",
          "2. 若返回的 `actionCount` 为 0，说明当前工作区已经非常整洁，立即调用 `paseo_bot_report_outcome` (`level: 'silent'`) 静默退出。",
          "3. 若已生成待确认整理预览卡片，直接结束本轮即可（无需重复发送额外卡片）。",
        ].join("\n"),
      });
      return { id: created.id, name: created.name, isNativeSchedule: true };
    }

    const existingMorning = currentSchedules.find(
      (s) =>
        s.name.includes("早间汇总") ||
        s.name.includes("晨间") ||
        s.cronExpression === "30 8 * * *",
    );
    if (existingMorning) {
      if (existingMorning.status !== "active") {
        await this.manageNativeSchedule({ id: existingMorning.id, action: "resume" });
      }
      return { id: existingMorning.id, name: existingMorning.name, isNativeSchedule: true };
    }

    const createdMorning = await this.upsertNativeSchedule({
      name: "每日 08:30 早间汇总",
      dailyTime: "08:30",
      governance: "notify",
      cwd: kbRoot,
      prompt: [
        "现在是每日晨间巡检时间。",
        "1. 调用 `paseo_bot_memory_read` 查看用户当前长期关注事项，并检查 `00-Inbox/` 及 `10-Projects/` 最新状态。",
        "2. 如果没有任何待办事项或值得提醒的新动态，可调用 `paseo_bot_report_outcome` (`level: 'silent'`) 不打扰用户。",
        "3. 如果有待推进事项或收件箱积压，整理一份不超过 6 行的清爽晨间简报，通过 `paseo_bot_report_outcome` (`level: 'notify'`) 推送给用户。",
      ].join("\n"),
    });
    return {
      id: createdMorning.id,
      name: createdMorning.name,
      isNativeSchedule: true,
    };
  }

  async toggleTrigger(id: string, enabled: boolean): Promise<boolean> {
    let found = false;
    await this.store.mutate((draft) => {
      const target = draft.triggers.find((t) => t.id === id);
      if (target) {
        target.enabled = enabled;
        target.updatedAt = new Date().toISOString();
        found = true;
      }
    });
    if (found) {
      await this.reconcileRuntime();
      await this.broadcastSnapshot();
    }
    return found;
  }

  async deleteTrigger(id: string): Promise<boolean> {
    let removed = false;
    await this.store.mutate((draft) => {
      const prevLen = draft.triggers.length;
      draft.triggers = draft.triggers.filter((t) => t.id !== id);
      removed = draft.triggers.length < prevLen;
    });
    if (removed) {
      await this.reconcileRuntime();
      await this.broadcastSnapshot();
    }
    return removed;
  }

  async clearFinishedReminders(): Promise<number> {
    let removedCount = 0;
    await this.store.mutate((draft) => {
      const before = draft.triggers.length;
      draft.triggers = draft.triggers.filter(
        (t) => !(t.kind === "self_wake" && !t.enabled),
      );
      removedCount = before - draft.triggers.length;
    });
    if (removedCount > 0) {
      await this.broadcastSnapshot();
    }
    return removedCount;
  }

  async dispatchTrigger(
    triggerId: string,
    event: { reason: string; detail: string; manual?: boolean },
  ): Promise<{ ok: boolean; message: string }> {
    const state = await this.store.load();
    const trigger = state.triggers.find((t) => t.id === triggerId);
    if (!trigger) {
      return { ok: false, message: `Trigger ${triggerId} not found` };
    }
    if (!event.manual && (!trigger.enabled || this.settings.globalPaused)) {
      return { ok: false, message: "Trigger is disabled or globally paused" };
    }
    if (this.inFlightTriggers.has(triggerId)) {
      return { ok: false, message: "Trigger already has an evaluation in progress" };
    }

    if (!event.manual && trigger.lastTriggeredAt && trigger.cooldownSec > 0) {
      const elapsedSec = (Date.now() - Date.parse(trigger.lastTriggeredAt)) / 1000;
      if (elapsedSec < trigger.cooldownSec) {
        await this.store.mutateDeferred((draft) => {
          draft.routingTelemetry.l0Hits += 1;
        }, 15_000);
        return { ok: false, message: `In cooldown (${Math.ceil(trigger.cooldownSec - elapsedSec)}s left)` };
      }
    }

    if (!this.paseo) {
      const existingIdx = this.pendingDispatches.findIndex((p) => p.triggerId === triggerId);
      const nextPending: PendingDispatch = {
        triggerId,
        reason: event.reason,
        detail: event.detail,
        manual: event.manual,
      };
      if (existingIdx >= 0) {
        this.pendingDispatches[existingIdx] = nextPending;
      } else {
        if (this.pendingDispatches.length >= MAX_PENDING_DISPATCHES) {
          this.pendingDispatches.shift();
        }
        this.pendingDispatches.push(nextPending);
      }
      return { ok: true, message: "Queued until Paseo session attaches" };
    }

    const wakesUsed = this.store.countRecentWakes();
    if (!event.manual && wakesUsed >= this.settings.hourlyWakeLimit) {
      await this.pushFeed({
        level: "error",
        title: "已触发每小时唤醒熔断上限",
        summary: `过去 1 小时已唤醒模型 ${wakesUsed}/${this.settings.hourlyWakeLimit} 次，跳过「${trigger.name}」以保护额度。`,
        triggerId: trigger.id,
        triggerName: trigger.name,
        notifyDesktop: false,
        beforeMutate: (draft) => {
          draft.routingTelemetry.l0Hits += 1;
        },
      });
      return { ok: false, message: "Hourly wake budget exceeded" };
    }

    this.inFlightTriggers.add(triggerId);
    const nowIso = new Date().toISOString();
    let disabledByMaxRuns = false;

    await this.store.mutate((draft) => {
      draft.wakeTimestamps.push(Date.now());
      const t = draft.triggers.find((item) => item.id === triggerId);
      if (t) {
        t.lastTriggeredAt = nowIso;
        t.lastCheckedAt = nowIso;
        t.runCount += 1;
        t.lastError = undefined;
        if (t.maxRuns && t.runCount >= t.maxRuns) {
          t.enabled = false;
          disabledByMaxRuns = true;
        }
      }
    });
    await this.broadcastSnapshot();

    void this.runTriggerTurn(trigger, event).finally(() => {
      this.inFlightTriggers.delete(triggerId);
      if (disabledByMaxRuns) {
        void this.reconcileRuntime();
      }
    });

    return { ok: true, message: `Dispatched '${trigger.name}'` };
  }

  private async runTriggerTurn(
    trigger: TriggerSpec,
    event: { reason: string; detail: string; manual?: boolean },
  ): Promise<void> {
    if (!this.paseo) return;

    const currentState = this.store.get();
    const butlerName = this.getEffectiveButlerName(currentState);
    const userName = this.getEffectiveUserName(currentState);
    const bubbleStyleGuide = await buildProactiveScoutPromptGuidance(
      { butlerName, userName },
      { promptsDir: this.promptsDir },
    );

    const noiseSection =
      trigger.noiseRules && trigger.noiseRules.length > 0
        ? [
            ``,
            `--- User Taste & Noise Boundaries (STRICT) ---`,
            ...trigger.noiseRules.map((r, idx) => `${idx + 1}. ${r}`),
          ].join("\n")
        : "";

    const composedPrompt = [
      `[Paseo Bot Proactive Trigger Event]`,
      `Mission Name: ${trigger.name}`,
      `Trigger Kind: ${trigger.kind} (${event.reason}${event.manual ? ", manual test run" : ""})`,
      `Governance Policy: ${trigger.governance}`,
      `Working Directory: ${trigger.cwd}`,
      ``,
      `--- Event Context ---`,
      event.detail,
      ``,
      `--- Mission Instructions ---`,
      trigger.prompt,
      noiseSection,
      ``,
      `--- Output & Safety Protocol ---`,
      trigger.governance === "require_approval"
        ? `1. GOVERNANCE = require_approval: You may inspect/read freely, retrieve facts, and prepare drafts, but DO NOT execute external messages, emails, purchases, or destructive edits directly. Instead, call \`paseo_bot_request_approval\` with \`payloadPreview\` (exact draft/command/diff) and \`followUpPrompt\`.`
        : `1. Respect the mission's governance (${trigger.governance}). For sensitive irreversible external actions, call \`paseo_bot_request_approval\` and attach \`payloadPreview\`.`,
      `2. If nothing meaningful requires the user's attention, call \`paseo_bot_report_outcome\` with \`level: "silent"\` and stop immediately.`,
      `3. If there is a meaningful result or alert, call \`paseo_bot_report_outcome\` with \`level: "notify"\` following the short-bubble butler style guide below.`,
      ``,
      bubbleStyleGuide,
    ].join("\n");

    try {
      if (trigger.executionTarget === "chief_bot") {
        const chief = await this.ensureChiefBot();
        await this.paseo.agents.ref(chief.agentId).send(composedPrompt);
        await this.store.mutate((draft) => {
          const t = draft.triggers.find((item) => item.id === trigger.id);
          if (t) {
            t.lastOutcome = "notify";
            t.notifyCount += 1;
          }
        });
        await this.broadcastSnapshot();
        return;
      }

      const expandedTriggerCwd = expandHomePath(trigger.cwd);
      const expandedHome = expandHomePath(this.settings.homeCwd);
      const targetCwd = (await pathExists(expandedTriggerCwd))
        ? expandedTriggerCwd
        : (await pathExists(expandedHome))
          ? expandedHome
          : os.homedir();

      const useLightL1 =
        trigger.kind === "self_wake" &&
        !trigger.providerOverride &&
        !isHeavySelfWakePrompt(trigger.prompt);
      const scoutTier: "L1" | "L2" = useLightL1 ? "L1" : "L2";

      const launched = await this.launchTieredAgentWithFallback({
        tier: scoutTier,
        cwd: targetCwd,
        title: `Scout · ${trigger.name}`,
        systemPrompt: bubbleStyleGuide,
        prompt: composedPrompt,
        background: true,
        labels: {
          "paseo-bot/role": "scout",
          "paseo-bot/trigger-id": trigger.id,
          "paseo-bot/tier": scoutTier,
        },
        providerOverride: useLightL1
          ? undefined
          : trigger.providerOverride || this.settings.scoutProvider,
        preferredModeIdOverride: this.settings.scoutModeId,
      });
      const helper = launched.handle;
      await this.store.mutateDeferred((draft) => {
        if (scoutTier === "L1") draft.routingTelemetry.l1Hits += 1;
        else draft.routingTelemetry.l2Hits += 1;
        draft.routingTelemetry.lastTier = scoutTier;
        draft.routingTelemetry.lastModelUsed = launched.modelUsed;
      }, 10_000);
      this.scoutTriggerMap.set(helper.id, {
        triggerId: trigger.id,
        triggerName: trigger.name,
      });

      try {
        const runRes = await helper.waitForFinish(5 * 60_000);
        const recorded = this.scoutOutcomes.get(helper.id);

        if (recorded) {
          const updateTriggerOutcome = (draft: import("./storage").PersistedBotState) => {
            const t = draft.triggers.find((item) => item.id === trigger.id);
            if (t) {
              t.lastOutcome = recorded.level;
              if (recorded.level === "silent") t.silentCount += 1;
              else t.notifyCount += 1;
            }
          };
          if (recorded.level === "silent") {
            await this.pushFeed({
              level: "silent",
              title: `无变化跳过：${trigger.name}`,
              summary: recorded.summary || "检查完成，无新增事项或变化。",
              triggerId: trigger.id,
              triggerName: trigger.name,
              notifyDesktop: false,
              appendChiefTimeline: false,
              beforeMutate: updateTriggerOutcome,
            });
          } else if (recorded.level === "notify") {
            await this.pushFeed({
              level: "notify",
              title: recorded.title || trigger.name,
              summary: recorded.summary || runRes.lastMessage || "任务已触发并处理。",
              details: recorded.details,
              actions: recorded.actions,
              triggerId: trigger.id,
              triggerName: trigger.name,
              notifyDesktop: true,
              appendChiefTimeline: true,
              beforeMutate: updateTriggerOutcome,
            });
          } else {
            await this.store.mutate(updateTriggerOutcome);
            await this.broadcastSnapshot();
          }
        } else {
          const text = (runRes.lastMessage ?? "").trim();
          const isSilentText = !text || /\b(NO_REPLY|\[SILENT\])\b/i.test(text);
          if (isSilentText && runRes.status === "idle") {
            await this.pushFeed({
              level: "silent",
              title: `无变化跳过：${trigger.name}`,
              summary: "检查完成，无新动态。",
              triggerId: trigger.id,
              triggerName: trigger.name,
              notifyDesktop: false,
              appendChiefTimeline: false,
              beforeMutate: (draft) => {
                const t = draft.triggers.find((item) => item.id === trigger.id);
                if (t) {
                  t.lastOutcome = "silent";
                  t.silentCount += 1;
                }
              },
            });
          } else if (runRes.status === "error") {
            throw new Error(runRes.error || "Scout helper ended with error");
          } else {
            const split = splitReplyIntoPreviewAndDetails(text);
            const autoActions = extractSuggestedActionsFromMarkdown(text);
            await this.pushFeed({
              level: "notify",
              title: trigger.name,
              summary: split.summary,
              details: split.details,
              actions: autoActions,
              triggerId: trigger.id,
              triggerName: trigger.name,
              notifyDesktop: true,
              appendChiefTimeline: true,
              beforeMutate: (draft) => {
                const t = draft.triggers.find((item) => item.id === trigger.id);
                if (t) {
                  t.lastOutcome = "notify";
                  t.notifyCount += 1;
                }
              },
            });
          }
        }
      } finally {
        this.scoutOutcomes.delete(helper.id);
        this.scoutTriggerMap.delete(helper.id);
        await helper.archive().catch(() => undefined);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.pushFeed({
        level: "error",
        title: `触发执行异常：${trigger.name}`,
        summary: msg,
        triggerId: trigger.id,
        triggerName: trigger.name,
        notifyDesktop: false,
        beforeMutate: (draft) => {
          const t = draft.triggers.find((item) => item.id === trigger.id);
          if (t) {
            t.lastOutcome = "error";
            t.lastError = msg;
          }
        },
      });
    }
  }

  private async maybeHintDuplicateSessionOnStart(
    agent: { id: string; cwd: string; title: string | null; background: boolean },
    turnId: string | null,
    paseo: PaseoApi,
  ): Promise<void> {
    if (
      !this.settings.duplicateSessionHintOnCreate ||
      agent.background ||
      this.duplicateHintedAgents.has(agent.id) ||
      isInternalBotTitle(agent.title)
    ) {
      return;
    }
    try {
      const ref = paseo.agents.ref(agent.id);
      const snap = await ref.refresh().catch(() => null);
      if (!snap || snap.agent.archivedAt) return;
      const rec = snap.agent as unknown as Record<string, unknown>;
      const labels = (rec.labels && typeof rec.labels === "object"
        ? (rec.labels as Record<string, string>)
        : {}) as Record<string, string>;
      if (labels["paseo-bot/role"] || labels["paseo.parent-agent-id"] || rec.parentAgentId) {
        this.duplicateHintedAgents.add(agent.id);
        return;
      }

      const page = await ref.timeline
        .refetch({ direction: "after", projection: "projected", limit: 6 })
        .catch(() => null);
      const userEntries = (page?.entries ?? []).filter((e) => e.item.type === "user_message");
      if (userEntries.length !== 1) {
        if (userEntries.length > 1) this.duplicateHintedAgents.add(agent.id);
        return;
      }
      if (turnId && userEntries[0].turnId && userEntries[0].turnId !== turnId) {
        this.duplicateHintedAgents.add(agent.id);
        return;
      }

      const firstPrompt =
        userEntries[0].item.type === "user_message" ? userEntries[0].item.text.trim() : "";
      if (!firstPrompt) return;
      this.duplicateHintedAgents.add(agent.id);

      const norm = normalizeSessionTitleFast({
        currentTitle: snap.agent.title,
        firstPrompt,
        cwd: agent.cwd,
      });

      const candidates = await this.listRoutableAgentCandidates();
      const sevenDaysAgo = Date.now() - 7 * 24 * 3_600_000;
      let bestMatch: { candidate: (typeof candidates)[number]; score: number } | null = null;

      for (const c of candidates) {
        if (c.id === agent.id || c.updatedAtMs < sevenDaysAgo) continue;
        if (isInternalBotTitle(c.title)) continue;
        const candNorm = normalizeSessionTitleFast({ currentTitle: c.title, cwd: c.cwd });
        const score = scoreSessionTopicSimilarity(
          { title: norm.title, firstPrompt, category: norm.category, cwd: agent.cwd },
          { title: c.title || candNorm.title, category: candNorm.category, cwd: c.cwd },
        );
        if (score >= 42 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { candidate: c, score };
        }
      }

      if (!bestMatch) return;
      const matched = bestMatch.candidate;
      await ref.timeline
        .append({
          type: "plugin",
          id: `dup-hint-${agent.id.slice(0, 8)}`,
          kind: BOT_ALERT_TIMELINE_KIND,
          version: 1,
          data: {
            feedId: `dup_${agent.id.slice(0, 8)}`,
            level: "notify",
            title: `检测到近期同主题会话：「${matched.title || matched.id.slice(0, 7)}」`,
            summary: `同一目录下已有相关会话（\`${matched.id.slice(0, 7)}\`）。你可以直接切回原会话续接，或继续当前对话后用 \`/tidy\` 自动合并归档。`,
            routedAgentId: matched.id,
            routedAgentTitle: matched.title || matched.id.slice(0, 7),
            actions: [],
            createdAt: new Date().toISOString(),
          },
        })
        .catch(() => undefined);
    } catch {
      // Non-blocking hint
    }
  }

  private async maybeAutoRenameSessionAfterTurn(
    agent: { id: string; cwd: string; title: string | null; background: boolean },
    turnId: string | null,
    paseo: PaseoApi,
  ): Promise<void> {
    if (
      !this.settings.autoRenameOnFirstTurn ||
      agent.background ||
      this.autoRenamedAgents.has(agent.id) ||
      isInternalBotTitle(agent.title)
    ) {
      return;
    }
    try {
      const ref = paseo.agents.ref(agent.id);
      const snap = await ref.refresh().catch(() => null);
      if (!snap || snap.agent.archivedAt) return;
      const rec = snap.agent as unknown as Record<string, unknown>;
      const labels = (rec.labels && typeof rec.labels === "object"
        ? (rec.labels as Record<string, string>)
        : {}) as Record<string, string>;
      if (labels["paseo-bot/role"] || labels["paseo.parent-agent-id"] || rec.parentAgentId) {
        this.autoRenamedAgents.add(agent.id);
        return;
      }

      const currentTitle = typeof snap.agent.title === "string" ? snap.agent.title.trim() : "";
      const headPage = await ref.timeline
        .refetch({ direction: "after", projection: "projected", limit: 8 })
        .catch(() => null);
      const userMsgs = (headPage?.entries ?? []).filter((e) => e.item.type === "user_message");
      if (userMsgs.length === 0) return;

      const firstPrompt =
        userMsgs[0].item.type === "user_message" ? userMsgs[0].item.text.trim() : "";
      if (!needsSessionAutoRename(currentTitle, firstPrompt)) {
        this.autoRenamedAgents.add(agent.id);
        return;
      }

      let assistantReply = "";
      const tailPage = await ref.timeline
        .refetch({ direction: "tail", limit: 1, wholeTurns: true })
        .catch(() => null);
      const matching = turnId
        ? (tailPage?.entries ?? []).filter((e) => e.turnId === turnId)
        : (tailPage?.entries ?? []);
      assistantReply = extractAssistantText(matching.map((e) => e.item));

      const norm = normalizeSessionTitleFast({
        currentTitle,
        firstPrompt,
        assistantReply,
        cwd: snap.agent.cwd || agent.cwd,
      });
      this.autoRenamedAgents.add(agent.id);
      if (!norm.title || norm.title === currentTitle) return;

      const loginPath = await this.getLoginPath();
      await renamePaseoAgentViaCli({
        agentId: agent.id,
        title: norm.title,
        labels: { "tidy.category": norm.category },
        loginPath,
      });

      const wsId = snap.agent.workspaceId;
      if (wsId) {
        const wsHandle = paseo.workspaces.ref(wsId);
        const wsSnap = await wsHandle.refresh().catch(() => null);
        const wsTitle = (wsSnap?.title ?? "").trim();
        const prov = provisionalPromptTitle(firstPrompt);
        if (
          wsSnap &&
          wsSnap.workspaceKind !== "worktree" &&
          !wsSnap.pinnedAt &&
          (!wsTitle || wsTitle === currentTitle || (prov && wsTitle === prov))
        ) {
          await wsHandle.setTitle(norm.title).catch(() => undefined);
        }
      }
      this.cachedRoutableAt = 0;
    } catch {
      // Non-blocking auto-rename
    }
  }

  async tidySessions(input?: {
    mode?: "preview" | "apply";
    idleHours?: number;
    closedHours?: number;
    ensurePinnedHubs?: boolean;
    callerAgentId?: string;
  }): Promise<{
    ok: boolean;
    actionCount: number;
    approvalId?: string;
    summary: string;
  }> {
    if (!this.paseo) {
      return {
        ok: false,
        actionCount: 0,
        summary: "Paseo daemon 尚未连接，请稍后重试。",
      };
    }

    const mode = input?.mode ?? "preview";
    const state = await this.store.load();
    const plan = await analyzeSessionsForTidy({
      paseo: this.paseo,
      chiefAgentId: state.chiefAgentId,
      chiefWorkspaceId: state.chiefWorkspaceId,
      callerAgentId: input?.callerAgentId,
      idleArchiveHours: input?.idleHours ?? this.settings.tidyIdleArchiveHours,
      closedArchiveHours: input?.closedHours,
      ensurePinnedHubs: input?.ensurePinnedHubs ?? true,
      writeObsidianDigest: this.settings.tidyWriteObsidianDigest,
      homeCwd: this.settings.homeCwd,
    });

    const actionCount = countTidyPlanActions(plan);
    if (actionCount === 0) {
      return {
        ok: true,
        actionCount: 0,
        summary: `已扫描 ${plan.scannedWorkspaces} 个工作区与 ${plan.scannedAgents} 个会话，当前均已规范整洁，无需整理。`,
      };
    }

    await saveTidyPlan(plan);
    const markdown = renderTidyPlanMarkdown(plan);
    const parts = [
      plan.hubs.length > 0 ? `置顶 ${plan.hubs.length} 个常驻主工作区` : "",
      plan.renames.length > 0 ? `规范重命名 ${plan.renames.length} 项` : "",
      plan.merges.length > 0 ? `合并归档 ${plan.merges.length} 组同主题会话` : "",
      plan.archives.length > 0 ? `清理 ${plan.archives.length} 项空壳/完结会话` : "",
    ].filter(Boolean);
    const headlineSummary = `扫描 ${plan.scannedWorkspaces} 个工作区 · 拟${parts.join("、")}。`;

    if (mode === "apply") {
      const loginPath = await this.getLoginPath();
      const execRes = await executeTidyPlan({
        paseo: this.paseo,
        plan,
        loginPath,
        markSelfWrite: (filePath) => this.store.markSelfWrite(filePath),
      });
      this.cachedRoutableAt = 0;
      this.cachedWorkspaceDirsAt = 0;
      const doneText = [
        execRes.pinnedHubs > 0 ? `置顶 ${execRes.pinnedHubs} 个常驻主工作区` : "",
        execRes.renamedCount > 0 ? `重命名 ${execRes.renamedCount} 项` : "",
        execRes.mergedClusters > 0 ? `合并 ${execRes.mergedClusters} 组同主题会话` : "",
        execRes.archivedWorkspaces > 0 || execRes.archivedAgents > 0
          ? `归档 ${execRes.archivedWorkspaces} 个工作区 / ${execRes.archivedAgents} 个会话`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const summary = `已完成会话整理：${doneText || "无变更"}。`;
      await this.pushFeed({
        level: "notify",
        title: "已完成工作区与会话整理",
        summary,
        details: markdown,
        notifyDesktop: false,
        appendChiefTimeline: true,
      });
      return { ok: true, actionCount, summary };
    }

    // Deduplicate any older pending tidy approval cards so the Approvals tab stays clean
    await this.store.mutate((draft) => {
      for (const a of draft.approvals) {
        if (
          a.status === "pending" &&
          extractTidyPlanIdFromPrompt(a.followUpPrompt)
        ) {
          a.status = "rejected";
          a.resolvedAt = new Date().toISOString();
          a.decisionNote = "已被最新生成的整理预览覆盖";
        }
      }
      draft.feed = draft.feed.filter(
        (f) => !(f.level === "approval_required" && f.title.includes("工作区与会话整理预览")),
      );
    });

    const approval = await this.createApproval({
      title: "工作区与会话整理预览",
      actionSummary: headlineSummary,
      payloadPreview: markdown,
      payloadLanguage: "markdown",
      riskLevel: "low",
      followUpPrompt: markdown,
      cwd: this.settings.homeCwd,
      sourceAgentId: input?.callerAgentId,
    });

    return {
      ok: true,
      actionCount,
      approvalId: approval.id,
      summary: headlineSummary,
    };
  }

  private attachLifecycleHooks(server: PluginServerContext): void {
    const rmTurnBefore = server.addHook("agent.turn.before", async ({ agent, turnId }, { paseo }) => {
      this.attachPaseo(paseo);
      this.reportedTurnAgents.delete(agent.id);
      if (agent.background) return;
      void this.maybeHintDuplicateSessionOnStart(agent, turnId, paseo);
      const worker = this.store
        .get()
        .workers.find((w) => w.agentId === agent.id && w.status !== "archived");
      if (!worker || worker.status === "running") return;
      if (worker.status === "completed") {
        this.repeatInteractiveTurnAgents.add(agent.id);
      }
      await this.store.mutate((draft) => {
        const found = draft.workers.find((w) => w.id === worker.id);
        if (found) {
          found.status = "running";
          found.updatedAt = new Date().toISOString();
        }
      });
      await this.broadcastSnapshot();
    });

    const rmTurnAfter = server.addHook(
      "agent.turn.after",
      async ({ agent, turnId, outcome }, { paseo }) => {
        this.attachPaseo(paseo);
        const alreadyReportedViaTool = this.reportedTurnAgents.has(agent.id);
        this.reportedTurnAgents.delete(agent.id);
        const wasRepeatTurnInMemory = this.repeatInteractiveTurnAgents.has(agent.id);
        this.repeatInteractiveTurnAgents.delete(agent.id);
        if (agent.background) return;
        if (outcome.kind === "completed") {
          void this.maybeAutoRenameSessionAfterTurn(agent, turnId, paseo);
        }

        const worker = this.store
          .get()
          .workers.find((w) => w.agentId === agent.id && w.status !== "archived");
        if (!worker) return;

        const refHandle = paseo.agents.ref(agent.id);
        let latestReply = "";
        try {
          const page = await refHandle.timeline.refetch({
            direction: "tail",
            limit: 1,
            wholeTurns: true,
          });
          const matching = turnId
            ? page.entries.filter((e) => e.turnId === turnId)
            : page.entries;
          latestReply = extractAssistantText(matching.map((e) => e.item));
        } catch {
          // Ignore timeline read error
        }

        const extractLabels = (obj: unknown): Record<string, string> | undefined => {
          if (!obj || typeof obj !== "object") return undefined;
          const raw = (obj as Record<string, unknown>).labels;
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
          return raw as Record<string, string>;
        };
        let agentLabels =
          extractLabels(agent) ?? extractLabels(refHandle.current?.());
        if (!agentLabels) {
          const refreshed = await refHandle.refresh().catch(() => null);
          agentLabels = extractLabels(refreshed?.agent);
        }

        const nextStatus: DelegatedWorker["status"] =
          outcome.kind === "failed" ? "failed" : "completed";
        const effectiveTitle =
          (typeof agent.title === "string" && agent.title.trim()) || worker.title;
        const cleanTitle = cleanTaskTitle(effectiveTitle);
        const isRepeatInteractiveTurn =
          wasRepeatTurnInMemory ||
          (worker.id.startsWith("wish_") && Boolean(worker.summary));

        let chiefId: string | null = null;

        if (alreadyReportedViaTool && outcome.kind !== "failed") {
          // Tool already published a rich outcome card; only finalize worker status
          const shortSummary =
            buildConclusionSummary(latestReply || worker.summary || cleanTitle, cleanTitle)
              .text;
          await this.store.mutate((draft) => {
            const found = draft.workers.find((w) => w.id === worker.id);
            if (found) {
              found.status = nextStatus;
              found.updatedAt = new Date().toISOString();
              found.summary = shortSummary;
            }
            chiefId = draft.chiefAgentId;
          });
          await this.broadcastSnapshot();
        } else {
          const streamDecision = evaluateWorkerTurnForStream({
            text: latestReply,
            title: effectiveTitle,
            outcomeKind: outcome.kind === "failed" ? "failed" : "completed",
            labels: agentLabels,
            isRepeatInteractiveTurn,
            workerId: worker.id,
          });

          if (!streamDecision.shouldSync) {
            // ADR-004: silently finalize worker status without polluting feed, messages, or desktop notifications
            const nowIso = new Date().toISOString();
            await this.store.mutate((draft) => {
              draft.routingTelemetry.l0Hits += 1;
              const found = draft.workers.find((w) => w.id === worker.id);
              if (found) {
                found.status = nextStatus;
                found.updatedAt = nowIso;
                found.summary =
                  found.summary ||
                  (latestReply.trim().slice(0, 160) || cleanTitle || "completed");
              }
              for (const f of draft.feed) {
                if (f.agentId === worker.agentId && f.inProgress) {
                  f.inProgress = false;
                }
              }
            });
            await this.broadcastSnapshot();
            return;
          }

          const condensed =
            outcome.kind === "failed"
              ? { text: `执行出错：${outcome.error.message}` }
              : buildConclusionSummary(latestReply, cleanTitle, 220);
          const autoActions =
            outcome.kind === "completed"
              ? extractSuggestedActionsFromMarkdown(latestReply)
              : [];

          await this.upsertAgentFeedCard({
            agentId: worker.agentId,
            workspaceId: worker.workspaceId,
            level: outcome.kind === "failed" ? "error" : "worker_update",
            title:
              outcome.kind === "failed"
                ? `执行出错：${cleanTitle}`
                : cleanTitle || "任务进展",
            summary: condensed.text,
            details: condensed.details,
            actions: autoActions,
            notifyDesktop: true,
            appendChiefTimeline: true,
            beforeMutate: (draft) => {
              const found = draft.workers.find((w) => w.id === worker.id);
              if (found) {
                found.status = nextStatus;
                found.updatedAt = new Date().toISOString();
                found.summary = condensed.text;
              }
              chiefId = draft.chiefAgentId;
            },
          });
        }

        if (worker.notifyChiefOnFinish && chiefId && chiefId !== agent.id) {
          try {
            await paseo.agents.ref(chiefId).send(
              [
                `[Delegated Worker Update]`,
                `Worker: ${cleanTitle} (${worker.agentId})`,
                `Workspace: ${worker.cwd}`,
                `Status: ${nextStatus}`,
                `Result Summary:`,
                (latestReply || cleanTitle).slice(0, 4000),
                ``,
                `Review whether the user's goal is now satisfied or if another step is needed.`,
              ].join("\n"),
            );
          } catch {
            // Chief may not be open
          }
        }
      },
    );

    const rmPermBefore = server.addHook(
      "agent.permission.before",
      async ({ agent, request }, { paseo }) => {
        this.attachPaseo(paseo);
        const worker = this.store
          .get()
          .workers.find((w) => w.agentId === agent.id && w.status !== "archived");
        if (!worker) return;

        await this.pushFeed({
          level: "approval_required",
          title: `子任务等待权限：${worker.title}`,
          summary: `子任务请求 ${request.kind} 权限，请点击「查看对话」进行确认。`,
          agentId: worker.agentId,
          workspaceId: worker.workspaceId,
          notifyDesktop: true,
          beforeMutate: (draft) => {
            const found = draft.workers.find((w) => w.id === worker.id);
            if (found) {
              found.status = "permission";
              found.updatedAt = new Date().toISOString();
            }
          },
        });
      },
    );

    const rmPermAfter = server.addHook(
      "agent.permission.after",
      async ({ agent }, { paseo }) => {
        this.attachPaseo(paseo);
        const worker = this.store
          .get()
          .workers.find((w) => w.agentId === agent.id && w.status === "permission");
        if (!worker) return;
        const nowIso = new Date().toISOString();
        await this.store.mutate((draft) => {
          const found = draft.workers.find((w) => w.id === worker.id);
          if (found && found.status === "permission") {
            found.status = "running";
            found.updatedAt = nowIso;
          }
          for (const f of draft.feed) {
            if (f.agentId === agent.id && f.level === "approval_required" && f.unread) {
              f.unread = false;
            }
          }
        });
        await this.broadcastSnapshot();
      },
    );

    const rmClose = server.addHook("agent.close.after", async ({ agent }, { paseo }) => {
      this.attachPaseo(paseo);
      this.cachedRoutableAt = 0;
      const worker = this.store
        .get()
        .workers.find(
          (w) =>
            w.agentId === agent.id &&
            (w.status === "running" || w.status === "permission"),
        );
      if (!worker) return;
      const nowIso = new Date().toISOString();
      await this.store.mutate((draft) => {
        const found = draft.workers.find((w) => w.id === worker.id);
        if (found && (found.status === "running" || found.status === "permission")) {
          found.status = "completed";
          found.updatedAt = nowIso;
        }
        for (const f of draft.feed) {
          if (f.agentId === agent.id && f.inProgress) {
            f.inProgress = false;
          }
        }
      });
      await this.broadcastSnapshot();
    });

    const rmArchive = server.addHook("agent.archive.after", async ({ agent }, { paseo }) => {
      this.attachPaseo(paseo);
      this.cachedRoutableAt = 0;
      const current = this.store.get();
      const matchesChief = current.chiefAgentId === agent.id;
      const matchesL1 = current.l1AgentId === agent.id;
      const matchesWorker = current.workers.some(
        (w) => w.agentId === agent.id && w.status !== "archived",
      );
      if (!matchesChief && !matchesL1 && !matchesWorker) return;

      let changed = false;
      const nowIso = new Date().toISOString();
      await this.store.mutate((draft) => {
        if (draft.chiefAgentId === agent.id) {
          draft.chiefAgentId = null;
          draft.chiefWorkspaceId = null;
          changed = true;
        }
        if (draft.l1AgentId === agent.id) {
          draft.l1AgentId = null;
          changed = true;
        }
        const worker = draft.workers.find((w) => w.agentId === agent.id);
        if (worker && worker.status !== "archived") {
          worker.status = "archived";
          worker.updatedAt = nowIso;
          changed = true;
        }
        for (const f of draft.feed) {
          if (f.agentId === agent.id && f.inProgress) {
            f.inProgress = false;
            changed = true;
          }
        }
      });
      if (changed) await this.broadcastSnapshot();
    });

    this.hookCleanups.push(
      rmTurnBefore,
      rmTurnAfter,
      rmPermBefore,
      rmPermAfter,
      rmClose,
      rmArchive,
    );
  }
}
