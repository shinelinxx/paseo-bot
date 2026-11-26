import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import {
  execCommand,
  type PluginServerContext,
  type PluginSettings,
} from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import {
  type ApprovalItem,
  type ApprovalRisk,
  type BotSnapshot,
  type DelegatedWorker,
  type FeedAction,
  type FeedActionKind,
  type FeedFeedback,
  type FeedItem,
  type FeedLevel,
  type MissionDraft,
  type NativeScheduleItem,
  type PresetId,
  type TriggerSpec,
  type TriggerUpsertInput,
} from "../shared/contracts";
import {
  DEFAULT_BOT_SETTINGS,
  type BotSettings,
  type BotSettingsSchema,
} from "../shared/settings";
import {
  applyApprovalResolutionMutation,
  applyFeedCurationMutation,
  cleanTaskTitle,
  computeRoutineSuggestions,
  draftMissionFromIntent,
  extractSuggestedActionsFromMarkdown,
  routeFollowUpCandidate,
  splitReplyIntoPreviewAndDetails,
  type RoutableAgentCandidate,
} from "./intent";
import {
  appendChiefAlertCard,
  sendDesktopNotification,
  upsertChiefApprovalCard,
} from "./notify";
import {
  BotStateStore,
  computeNormalizedHash,
  createShortId,
  expandHomePath,
  shouldIgnoreWatchPath,
} from "./storage";

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
  readonly store = new BotStateStore();
  private paseo: PaseoApi | null = null;
  private settings: BotSettings = DEFAULT_BOT_SETTINGS;
  private settingsCleanup: (() => void) | null = null;
  private hookCleanups: Array<() => void> = [];

  private readonly subscribers = new Set<(snapshot: BotSnapshot) => void>();
  private readonly fileWatchers = new Map<string, ActiveFileWatcher>();
  private readonly inFlightTriggers = new Set<string>();
  private readonly pollingTriggers = new Set<string>();
  private readonly scoutOutcomes = new Map<string, RecordedScoutOutcome>();
  private readonly scoutTriggerMap = new Map<
    string,
    { triggerId: string; triggerName: string }
  >();
  private readonly reportedTurnAgents = new Set<string>();
  private readonly pendingDispatches: PendingDispatch[] = [];
  private readonly regexCache = new Map<string, RegExp | null>();

  private lastWorkerReconcileAt = 0;
  private workerReconcileInFlight: Promise<void> | null = null;

  private cachedNativeSchedules: NativeScheduleItem[] = [];
  private cachedNativeSchedulesAt = 0;
  private nativeSchedulesInFlight: Promise<NativeScheduleItem[]> | null = null;

  private webhookServer: http.Server | null = null;
  private activeWebhookPort: number | null = null;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private schedulerTickInFlight = false;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private ensureChiefInFlight: Promise<{
    agentId: string;
    workspaceId: string | null;
    created: boolean;
  }> | null = null;
  private stopped = false;

  private cachedLoginPath: string | null = null;
  private loginPathInFlight: Promise<string> | null = null;

  private cachedProviderCatalogAt = 0;
  private providerCatalogInFlight: Promise<void> | null = null;
  private cachedProviders: Array<{
    id: string;
    available: boolean;
    defaultModel: string | null;
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
    const persisted = await this.store.load();
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

    this.schedulerTimer = setInterval(() => {
      void this.tickScheduler().catch((err) => {
        console.error("[paseo-bot] scheduler tick error:", err);
      });
    }, 10_000);
    this.schedulerTimer.unref?.();
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
    this.settingsCleanup?.();
    this.settingsCleanup = null;
    for (const remove of this.hookCleanups) remove();
    this.hookCleanups = [];
    this.closeAllWatchers();
    await this.closeWebhookServer();
    await this.store.flush().catch(() => undefined);
    this.subscribers.clear();
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
        const loginPath = await this.getLoginPath();
        const { stdout } = await execCommand("paseo", ["schedule", "ls", "--json"], {
          env: { ...process.env, PATH: loginPath },
          timeout: 6_000,
          maxBuffer: 256 * 1024,
        });
        const parsed = JSON.parse(stdout.trim() || "[]");
        if (Array.isArray(parsed)) {
          this.cachedNativeSchedules = parsed
            .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
            .map((item) => ({
              id: String(item.id ?? ""),
              name: String(item.name ?? item.id ?? "定时任务"),
              cadence: String(item.cadence ?? ""),
              target: String(item.target ?? ""),
              status: String(item.status ?? "active"),
              nextRunAt: typeof item.nextRunAt === "string" ? item.nextRunAt : null,
              lastRunAt: typeof item.lastRunAt === "string" ? item.lastRunAt : null,
            }))
            .filter((item) => item.id.length > 0);
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

  async manageNativeSchedule(input: {
    id: string;
    action: "run_once" | "pause" | "resume";
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
          : "resume";
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
            ? "已暂停定时任务"
            : "已恢复定时任务";
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

  subscribeSnapshots(listener: (snapshot: BotSnapshot) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
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

  async getSnapshot(opts?: { includeMemory?: boolean }): Promise<BotSnapshot> {
    await this.reconcileWorkersWithPaseo(false);
    const [state, nativeSchedules, memoryContent] = await Promise.all([
      this.store.load(),
      this.fetchNativeSchedules(false),
      opts?.includeMemory === false
        ? Promise.resolve("")
        : this.store.readMemory(this.settings.memoryFilePath),
    ]);
    let unreadCount = 0;
    for (const f of state.feed) {
      if (f.unread && f.level !== "silent") unreadCount += 1;
    }
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

    return {
      chiefAgentId: state.chiefAgentId,
      chiefWorkspaceId: state.chiefWorkspaceId,
      webhookBaseUrl: this.getWebhookBaseUrl(),
      hourlyWakesUsed: this.store.countRecentWakes(),
      hourlyWakeLimit: this.settings.hourlyWakeLimit,
      globalPaused: this.settings.globalPaused,
      unreadCount,
      pendingApprovalCount,
      runningWorkerCount,
      totalSilentChecks,
      triggers: state.triggers,
      nativeSchedules,
      feed: state.feed.slice(0, 40),
      approvals: state.approvals.slice(0, 25),
      workers: state.workers.slice(0, 25),
      routineSuggestions: computeRoutineSuggestions(state, this.settings.homeCwd),
      memoryContent,
      memoryPath: this.settings.memoryFilePath,
    };
  }

  async broadcastSnapshot(): Promise<void> {
    if (this.subscribers.size === 0 || this.stopped) return;
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      if (this.subscribers.size === 0 || this.stopped) return;
      void this.getSnapshot()
        .then((snapshot) => {
          for (const listener of this.subscribers) {
            try {
              listener(snapshot);
            } catch {
              // Ignore broken listener
            }
          }
        })
        .catch(() => undefined);
    }, 180);
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
      if (headerSecret !== secret) {
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

  private async resolveLaunchConfig(
    preferredProviderModel: string,
    preferredModeId: string,
  ): Promise<{ provider: string; modeId?: string }> {
    if (!this.paseo) {
      return { provider: preferredProviderModel, modeId: preferredModeId || undefined };
    }

    const now = Date.now();
    if (now - this.cachedProviderCatalogAt > 5 * 60_000 || this.cachedProviders.length === 0) {
      if (!this.providerCatalogInFlight) {
        const paseo = this.paseo;
        const task = (async () => {
          try {
            const snap = await paseo.providers.snapshot();
            const rawProviders =
              (snap as { payload?: { providers?: unknown[] }; providers?: unknown[] }).payload
                ?.providers ??
              (snap as { providers?: unknown[] }).providers ??
              [];
            const nextProviders: typeof this.cachedProviders = [];
            for (const item of rawProviders) {
              if (!item || typeof item !== "object") continue;
              const rec = item as Record<string, unknown>;
              const id = typeof rec.id === "string" ? rec.id : "";
              const available = rec.status === "available" || rec.available === true;
              const models = Array.isArray(rec.models) ? rec.models : [];
              let defaultModel: string | null = null;
              for (const m of models) {
                if (m && typeof m === "object") {
                  const mRec = m as Record<string, unknown>;
                  if (mRec.isDefault && typeof mRec.id === "string") {
                    defaultModel = mRec.id;
                    break;
                  }
                  if (!defaultModel && typeof mRec.id === "string") {
                    defaultModel = mRec.id;
                  }
                }
              }
              const modes = Array.isArray(rec.modes)
                ? rec.modes
                    .map((mode) =>
                      mode &&
                      typeof mode === "object" &&
                      typeof (mode as { id?: unknown }).id === "string"
                        ? (mode as { id: string }).id
                        : "",
                    )
                    .filter(Boolean)
                : [];
              if (id) {
                nextProviders.push({ id, available, defaultModel, modes });
              }
            }
            this.cachedProviders = nextProviders;
            this.cachedProviderCatalogAt = Date.now();
          } catch {
            // Keep fallback
          }
        })();
        this.providerCatalogInFlight = task;
        task.finally(() => {
          if (this.providerCatalogInFlight === task) {
            this.providerCatalogInFlight = null;
          }
        });
      }
      await this.providerCatalogInFlight;
    }

    const [reqProv, reqModel] = preferredProviderModel.includes("/")
      ? preferredProviderModel.split("/", 2)
      : [preferredProviderModel, ""];

    const matched = this.cachedProviders.find((p) => p.id === reqProv && p.available);
    const chosen = matched ?? this.cachedProviders.find((p) => p.available);
    if (!chosen) {
      return { provider: preferredProviderModel, modeId: preferredModeId || undefined };
    }

    const finalModel = matched && reqModel ? reqModel : chosen.defaultModel;
    const providerPair = finalModel ? `${chosen.id}/${finalModel}` : preferredProviderModel;

    let modeId: string | undefined;
    if (preferredModeId && chosen.modes.includes(preferredModeId)) {
      modeId = preferredModeId;
    } else if (chosen.modes.includes("auto")) {
      modeId = "auto";
    } else if (chosen.modes.includes("build")) {
      modeId = "build";
    }
    return { provider: providerPair, modeId };
  }

  recordScoutOutcome(agentId: string, outcome: RecordedScoutOutcome): void {
    this.scoutOutcomes.set(agentId, outcome);
  }

  getScoutTriggerMeta(
    agentId: string,
  ): { triggerId: string; triggerName: string } | undefined {
    return this.scoutTriggerMap.get(agentId);
  }

  draftMission(intent: string, cwd?: string): MissionDraft {
    return draftMissionFromIntent(intent, cwd?.trim() || this.settings.homeCwd);
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
    const [agentRes, wsRes] = await Promise.all([
      this.paseo.agents.list().catch(() => null),
      this.paseo.workspaces.list().catch(() => null),
    ]);
    if (!agentRes) return [];

    const wsMap = new Map<string, { title: string; projectName: string }>();
    for (const ws of wsRes?.entries ?? []) {
      const wsTitle = (ws.title && ws.title.trim()) || ws.name || "";
      const projectName =
        (ws.projectCustomName && ws.projectCustomName.trim()) ||
        ws.projectDisplayName ||
        "";
      wsMap.set(ws.id, { title: wsTitle, projectName });
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
      if (isBg || labels?.["paseo-bot/role"] === "scout") continue;

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
    return results;
  }

  async executeFeedAction(input: {
    feedId: string;
    actionId?: string;
    customKind?: FeedActionKind;
    customPrompt?: string;
    delayMinutes?: number;
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
        await appendChiefAlertCard(this.paseo, state.chiefAgentId, updatedFeed);
      }
      await this.broadcastSnapshot();
      const hrs = delay >= 60 && delay % 60 === 0 ? `${delay / 60} 小时` : `${delay} 分钟`;
      return { ok: true, message: `已设置 ${hrs} 后再提醒` };
    }

    const fullReference = feedItem.details || feedItem.summary;
    const promptText =
      matchedAction?.prompt ||
      input.customPrompt?.trim() ||
      `请继续跟进这项内容：「${feedItem.title}」`;

    let launchedAgentId: string | undefined;
    let continuedSameOriginSession = false;
    let routedExternalTarget:
      | { agentId: string; title: string; cwd: string; workspaceId?: string }
      | undefined;

    if (kind === "delegate") {
      const worker = await this.delegateTask({
        title: matchedAction?.label || `跟进 · ${cleanTaskTitle(feedItem.title).slice(0, 18)}`,
        cwd: targetCwd,
        prompt: `${promptText}\n\n--- 背景参考 ---\n${fullReference.slice(0, 6000)}`,
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
          await handle.send(payload);
          launchedAgentId = targetId;
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
        wish: promptText,
        cwd: targetCwd,
        titleOverride: matchedAction?.label || `跟进 · ${baseTitle}`,
        extraContext: fullReference.slice(0, 6000),
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
            summary: promptText,
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
            provider: this.settings.chiefProvider,
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
            provider: this.settings.chiefProvider,
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
      await appendChiefAlertCard(this.paseo, state.chiefAgentId, updatedFeed);
    }
    await this.broadcastSnapshot();
    return {
      ok: true,
      message: routedExternalTarget
        ? `已路由至会话「${cleanTaskTitle(routedExternalTarget.title).slice(0, 22)}」继续处理`
        : continuedSameOriginSession
          ? "已在原会话继续跟进，完成后将自动更新卡片"
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
    agentId?: string;
    workspaceId?: string;
    notifyDesktop?: boolean;
    appendChiefTimeline?: boolean;
    beforeMutate?: (draft: import("./storage").PersistedBotState) => void;
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
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      unread: input.unread ?? (input.level !== "silent" && !input.inProgress),
    };

    let chiefId: string | null = null;
    await this.store.mutate((draft) => {
      input.beforeMutate?.(draft);
      draft.feed.unshift(item);
      chiefId = draft.chiefAgentId;
    });
    await this.broadcastSnapshot();

    if (input.notifyDesktop && input.level !== "silent") {
      void sendDesktopNotification({
        enabled: this.settings.desktopNotify,
        title: `Paseo Bot · ${item.title}`,
        subtitle: item.triggerName,
        body: item.summary,
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
    beforeMutate?: (draft: import("./storage").PersistedBotState) => void;
  }): Promise<FeedItem> {
    const nowIso = new Date().toISOString();
    let finalItem!: FeedItem;
    let chiefId: string | null = null;

    await this.store.mutate((draft) => {
      input.beforeMutate?.(draft);
      chiefId = draft.chiefAgentId;

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
        if (input.actions && input.actions.length > 0) {
          target.actions = input.actions;
        }
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
    });

    await this.broadcastSnapshot();

    if (input.notifyDesktop && input.level !== "silent") {
      void sendDesktopNotification({
        enabled: this.settings.desktopNotify,
        title: `Paseo Bot · ${finalItem.title}`,
        subtitle: finalItem.triggerName,
        body: finalItem.summary,
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
  }): Promise<{ agentId: string; workspaceId: string | null; created: boolean }> {
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
  }): Promise<{ agentId: string; workspaceId: string | null; created: boolean }> {
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
        };
      }
    }

    const expandedHome = expandHomePath(this.settings.homeCwd);
    const homeCwd = (await pathExists(expandedHome)) ? expandedHome : os.homedir();
    const workspace = await this.paseo.workspaces.open(homeCwd);
    const launch = await this.resolveLaunchConfig(
      this.settings.chiefProvider,
      this.settings.chiefModeId,
    );

    const chief = await workspace.agents.create({
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
    });

    const workspaceId = chief.workspaceId ?? workspace.id;
    await this.store.mutate((draft) => {
      draft.chiefAgentId = chief.id;
      draft.chiefWorkspaceId = workspaceId;
    });
    await this.broadcastSnapshot();

    return { agentId: chief.id, workspaceId, created: true };
  }

  async submitWish(input: {
    wish: string;
    cwd?: string;
    titleOverride?: string;
    extraContext?: string;
  }): Promise<{ agentId: string; workspaceId: string | null }> {
    if (!this.paseo) {
      throw new Error("Paseo daemon connection is not initialized yet");
    }

    const cleanWish = input.wish.trim();
    const contextNote = input.cwd ? `\n(Submitted from workspace directory: ${input.cwd})` : "";
    const refBlock = input.extraContext
      ? `\n\n--- Reference Context ---\n${input.extraContext}`
      : "";
    const wishPrompt = [
      `[User Task / Goal]`,
      cleanWish + contextNote + refBlock,
      ``,
      `Execution Guidelines:`,
      `- If this requires ongoing monitoring or scheduled checks, configure or update a rule via \`paseo_bot_create_trigger\` or \`paseo_bot_self_wake\`.`,
      `- If it requires work in another workspace/worktree, handle it directly or delegate via \`paseo_bot_delegate_task\`.`,
      `- If it establishes a long-term preference or filter, save it in \`MEMORY.md\` via \`paseo_bot_memory_write\`.`,
      `- When presenting findings that include 1-3 concrete follow-up decisions or optional actions for the user, call \`paseo_bot_report_outcome\` (\`level: "notify"\`) with a concise \`summary\`, full \`details\` (if long), and 1-3 one-tap \`actions\` buttons so the user can click instead of typing.`,
    ].join("\n");

    const baseLabel =
      input.titleOverride?.trim() ||
      cleanTaskTitle(cleanWish).replace(/\s+/g, " ").slice(0, 26) +
        (cleanWish.length > 26 ? "…" : "");

    if (this.settings.wishSessionMode === "shared_chief") {
      const ensured = await this.ensureChiefBot();
      await this.pushFeed({
        level: "wish",
        title: `正在处理：${baseLabel}`,
        summary: cleanWish,
        inProgress: true,
        unread: false,
        agentId: ensured.agentId,
        workspaceId: ensured.workspaceId ?? undefined,
        notifyDesktop: false,
        appendChiefTimeline: false,
      });
      await this.paseo.agents.ref(ensured.agentId).send(wishPrompt);
      return { agentId: ensured.agentId, workspaceId: ensured.workspaceId };
    }

    // Default ("per_wish"): spawn a clean, parallel dedicated session per wish while sharing global memory & triggers
    const expandedInputCwd = input.cwd ? expandHomePath(input.cwd) : "";
    const expandedHomeCwd = expandHomePath(this.settings.homeCwd);
    const targetCwd =
      expandedInputCwd && (await pathExists(expandedInputCwd))
        ? expandedInputCwd
        : (await pathExists(expandedHomeCwd))
          ? expandedHomeCwd
          : os.homedir();
    const workspace = await this.paseo.workspaces.open(targetCwd);
    const launch = await this.resolveLaunchConfig(
      this.settings.chiefProvider,
      this.settings.chiefModeId,
    );

    const wishWorkerId = createShortId("wish");

    const wishAgent = await workspace.agents.create({
      config: {
        provider: launch.provider,
        modeId: launch.modeId,
        systemPrompt: [
          "You are Paseo Bot handling a dedicated background task thread.",
          "You share persistent memory (`MEMORY.md`) and automatic rules (`paseo_bot_*`) across all threads.",
          "Never send external emails/messages, spend money, or make destructive changes without calling `paseo_bot_request_approval` with `payloadPreview`.",
        ].join("\n"),
      },
      title: baseLabel,
      prompt: wishPrompt,
      labels: {
        "paseo-bot/role": "chief",
        "paseo-bot/wish-id": wishWorkerId,
      },
    });

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
      goal: cleanWish.slice(0, 1000),
      notifyChiefOnFinish: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await this.pushFeed({
      level: "wish",
      title: `正在处理：${baseLabel}`,
      summary: cleanWish,
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

    return { agentId: wishAgent.id, workspaceId };
  }

  async delegateTask(input: {
    title: string;
    cwd: string;
    prompt: string;
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
    const launch = await this.resolveLaunchConfig(
      input.provider?.trim() || this.settings.defaultWorkerProvider,
      input.modeId?.trim() || this.settings.defaultWorkerModeId,
    );

    const workerId = createShortId("wrk");
    let workspaceHandle;
    if (isolation === "worktree") {
      workspaceHandle = await this.paseo.workspaces.create({
        title: input.title,
        source: {
          kind: "worktree",
          cwd: targetCwd,
          action: "branch-off",
        },
      });
    } else {
      workspaceHandle = await this.paseo.workspaces.open(targetCwd);
    }

    const agentHandle = await workspaceHandle.agents.create({
      config: {
        provider: launch.provider,
        modeId: launch.modeId,
      },
      title: `Bot Worker · ${input.title}`,
      prompt: input.prompt,
      labels: {
        "paseo-bot/role": "worker",
        "paseo-bot/worker-id": workerId,
      },
    });

    const nowIso = new Date().toISOString();
    const record: DelegatedWorker = {
      id: workerId,
      agentId: agentHandle.id,
      workspaceId: agentHandle.workspaceId ?? workspaceHandle.id,
      title: input.title,
      cwd: targetCwd,
      provider: launch.provider,
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

  async installPreset(presetId: PresetId): Promise<TriggerSpec> {
    const kbRoot = expandHomePath(this.settings.homeCwd);
    if (presetId === "kb_inbox") {
      return this.upsertTrigger({
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
    }

    if (presetId === "universal_webhook") {
      return this.upsertTrigger({
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
    }

    return this.upsertTrigger({
      name: "每日 08:30 早间汇总",
      description: "每天早上检查长期关注事项、收件箱与待办进展",
      kind: "schedule",
      dailyTime: "08:30",
      pollIntervalSec: 3600,
      governance: "notify",
      executionTarget: "scout_helper",
      cwd: kbRoot,
      cooldownSec: 300,
      prompt: [
        "现在是每日晨间巡检时间。",
        "1. 调用 `paseo_bot_memory_read` 查看用户当前长期关注事项，并检查 `00-Inbox/` 及 `10-Projects/` 最新状态。",
        "2. 如果没有任何待办事项或值得提醒的新动态，可调用 `paseo_bot_report_outcome` (`level: 'silent'`) 不打扰用户。",
        "3. 如果有待推进事项或收件箱积压，整理一份不超过 6 行的清爽晨间简报，通过 `paseo_bot_report_outcome` (`level: 'notify'`) 推送给用户。",
      ].join("\n"),
    });
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
      `3. If there is a meaningful result or alert, call \`paseo_bot_report_outcome\` with \`level: "notify"\`, a crisp conclusion-first \`summary\`, optional \`details\` (deeper Layer-2 evidence), and 1-2 helpful \`actions\` (one-tap Poke follow-up buttons).`,
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
      const workspace = await this.paseo.workspaces.open(targetCwd);
      const launch = await this.resolveLaunchConfig(
        trigger.providerOverride || this.settings.scoutProvider,
        this.settings.scoutModeId,
      );

      const helper = await workspace.agents.create({
        config: {
          provider: launch.provider,
          modeId: launch.modeId,
        },
        title: `Scout · ${trigger.name}`,
        prompt: composedPrompt,
        background: true,
        labels: {
          "paseo-bot/role": "scout",
          "paseo-bot/trigger-id": trigger.id,
        },
      });
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

  private attachLifecycleHooks(server: PluginServerContext): void {
    const rmTurnBefore = server.addHook("agent.turn.before", async ({ agent }, { paseo }) => {
      this.attachPaseo(paseo);
      this.reportedTurnAgents.delete(agent.id);
      if (agent.background) return;
      const worker = this.store
        .get()
        .workers.find((w) => w.agentId === agent.id && w.status !== "archived");
      if (!worker || worker.status === "running") return;
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
        if (agent.background) return;

        const worker = this.store
          .get()
          .workers.find((w) => w.agentId === agent.id && w.status !== "archived");
        if (!worker) return;

        let latestReply = "";
        try {
          const page = await paseo.agents
            .ref(agent.id)
            .timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true });
          const matching = turnId
            ? page.entries.filter((e) => e.turnId === turnId)
            : page.entries;
          latestReply = extractAssistantText(matching.map((e) => e.item));
        } catch {
          // Ignore timeline read error
        }

        const nextStatus: DelegatedWorker["status"] =
          outcome.kind === "failed" ? "failed" : "completed";

        const split =
          outcome.kind === "failed"
            ? { summary: `执行出错：${outcome.error.message}` }
            : splitReplyIntoPreviewAndDetails(latestReply || "处理完成。");

        const cleanTitle = cleanTaskTitle(worker.title);
        let chiefId: string | null = null;

        if (alreadyReportedViaTool && outcome.kind !== "failed") {
          // Tool already published a rich outcome card; only finalize worker status
          await this.store.mutate((draft) => {
            const found = draft.workers.find((w) => w.id === worker.id);
            if (found) {
              found.status = nextStatus;
              found.updatedAt = new Date().toISOString();
              found.summary = split.summary;
            }
            chiefId = draft.chiefAgentId;
          });
          await this.broadcastSnapshot();
        } else {
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
                : `已完成：${cleanTitle}`,
            summary: split.summary,
            details: split.details,
            actions: autoActions,
            notifyDesktop: true,
            appendChiefTimeline: true,
            beforeMutate: (draft) => {
              const found = draft.workers.find((w) => w.id === worker.id);
              if (found) {
                found.status = nextStatus;
                found.updatedAt = new Date().toISOString();
                found.summary = split.summary;
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
                (split.details || split.summary).slice(0, 4000),
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

    const rmArchive = server.addHook("agent.archive.after", async ({ agent }, { paseo }) => {
      this.attachPaseo(paseo);
      const current = this.store.get();
      const matchesChief = current.chiefAgentId === agent.id;
      const matchesWorker = current.workers.some(
        (w) => w.agentId === agent.id && w.status !== "archived",
      );
      if (!matchesChief && !matchesWorker) return;

      let changed = false;
      await this.store.mutate((draft) => {
        if (draft.chiefAgentId === agent.id) {
          draft.chiefAgentId = null;
          draft.chiefWorkspaceId = null;
          changed = true;
        }
        const worker = draft.workers.find((w) => w.agentId === agent.id);
        if (worker && worker.status !== "archived") {
          worker.status = "archived";
          worker.updatedAt = new Date().toISOString();
          changed = true;
        }
      });
      if (changed) await this.broadcastSnapshot();
    });

    this.hookCleanups.push(rmTurnBefore, rmTurnAfter, rmPermBefore, rmArchive);
  }
}
