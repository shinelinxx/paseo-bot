import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ApprovalItem,
  DelegatedWorker,
  FeedItem,
  TriggerSpec,
} from "../shared/contracts";

export interface PersistedBotState {
  chiefAgentId: string | null;
  chiefWorkspaceId: string | null;
  runtimePaused: boolean | null;
  wakeTimestamps: number[];
  dismissedSuggestionIds: string[];
  triggers: TriggerSpec[];
  feed: FeedItem[];
  approvals: ApprovalItem[];
  workers: DelegatedWorker[];
}

const DEFAULT_PERSISTED_STATE: PersistedBotState = {
  chiefAgentId: null,
  chiefWorkspaceId: null,
  runtimePaused: null,
  wakeTimestamps: [],
  dismissedSuggestionIds: [],
  triggers: [],
  feed: [],
  approvals: [],
  workers: [],
};

const BUILTIN_IGNORE_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".obsidian",
  ".DS_Store",
  ".Trash",
  "dist",
  "build",
  ".next",
  "__pycache__",
]);

export function getPluginDataDir(): string {
  const paseoHome = process.env.PASEO_HOME?.trim() || path.join(os.homedir(), ".paseo");
  return path.join(paseoHome, "plugin-data", "paseo-bot");
}

export function expandHomePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function computeNormalizedHash(raw: string): string {
  const normalized = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function shouldIgnoreWatchPath(
  relativeOrFullPath: string,
  extraPatterns: readonly string[] = [],
): boolean {
  const normalized = relativeOrFullPath.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  if (!base) return true;
  if (
    base.startsWith(".#") ||
    base.endsWith(".tmp") ||
    base.endsWith(".swp") ||
    base.endsWith(".swo") ||
    base.endsWith("~")
  ) {
    return true;
  }
  const parts = normalized.split("/").filter(Boolean);
  for (const part of parts) {
    if (BUILTIN_IGNORE_SEGMENTS.has(part)) return true;
  }
  for (const pattern of extraPatterns) {
    const clean = pattern.trim();
    if (!clean) continue;
    if (normalized.includes(clean)) return true;
  }
  return false;
}

export function createShortId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

function normalizeTrigger(raw: TriggerSpec): TriggerSpec {
  return {
    ...raw,
    ignorePatterns: Array.isArray(raw.ignorePatterns) ? raw.ignorePatterns : [],
    approvedCount: typeof raw.approvedCount === "number" ? raw.approvedCount : 0,
    noiseRules: Array.isArray(raw.noiseRules) ? raw.noiseRules : [],
    runCount: typeof raw.runCount === "number" ? raw.runCount : 0,
    silentCount: typeof raw.silentCount === "number" ? raw.silentCount : 0,
    notifyCount: typeof raw.notifyCount === "number" ? raw.notifyCount : 0,
  };
}

function normalizeFeedItem(raw: FeedItem): FeedItem {
  return {
    ...raw,
    actions: Array.isArray(raw.actions) ? raw.actions : [],
    inProgress: typeof raw.inProgress === "boolean" ? raw.inProgress : false,
  };
}

export class BotStateStore {
  private state: PersistedBotState = structuredClone(DEFAULT_PERSISTED_STATE);
  private loaded = false;
  private dirEnsured = false;
  private writing = false;
  private writePending = false;
  private deferredDirty = false;
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWaiters: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
  private readonly selfWriteGuard = new Map<string, number>();
  private memoryCache: {
    resolved: string;
    mtimeMs: number;
    size: number;
    content: string;
  } | null = null;

  readonly stateFilePath: string;

  constructor(dataDir = getPluginDataDir()) {
    this.stateFilePath = path.join(dataDir, "state.json");
  }

  async load(): Promise<PersistedBotState> {
    if (this.loaded) return this.state;
    try {
      const raw = await fs.readFile(this.stateFilePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedBotState>;
      this.state = {
        chiefAgentId: typeof parsed.chiefAgentId === "string" ? parsed.chiefAgentId : null,
        chiefWorkspaceId:
          typeof parsed.chiefWorkspaceId === "string" ? parsed.chiefWorkspaceId : null,
        runtimePaused:
          typeof parsed.runtimePaused === "boolean" ? parsed.runtimePaused : null,
        wakeTimestamps: Array.isArray(parsed.wakeTimestamps)
          ? parsed.wakeTimestamps.filter((n): n is number => typeof n === "number")
          : [],
        dismissedSuggestionIds: Array.isArray(parsed.dismissedSuggestionIds)
          ? parsed.dismissedSuggestionIds.filter((s): s is string => typeof s === "string")
          : [],
        triggers: Array.isArray(parsed.triggers) ? parsed.triggers.map(normalizeTrigger) : [],
        feed: Array.isArray(parsed.feed)
          ? parsed.feed.slice(0, 200).map(normalizeFeedItem)
          : [],
        approvals: Array.isArray(parsed.approvals) ? parsed.approvals.slice(0, 100) : [],
        workers: Array.isArray(parsed.workers) ? parsed.workers.slice(0, 100) : [],
      };
    } catch {
      this.state = structuredClone(DEFAULT_PERSISTED_STATE);
    }
    this.loaded = true;
    return this.state;
  }

  get(): PersistedBotState {
    return this.state;
  }

  private applyMutation(mutator: (draft: PersistedBotState) => void): void {
    mutator(this.state);
    if (this.state.feed.length > 200) {
      this.state.feed.length = 200;
    }
    if (this.state.approvals.length > 100) {
      this.state.approvals.length = 100;
    }
    if (this.state.workers.length > 100) {
      this.state.workers.length = 100;
    }
    if (this.state.dismissedSuggestionIds.length > 100) {
      this.state.dismissedSuggestionIds = this.state.dismissedSuggestionIds.slice(-100);
    }
    const cutoff = Date.now() - 3600_000;
    if (this.state.wakeTimestamps.length > 0 && this.state.wakeTimestamps[0] <= cutoff) {
      this.state.wakeTimestamps = this.state.wakeTimestamps.filter((ts) => ts > cutoff);
    }
  }

  async mutate(mutator: (draft: PersistedBotState) => void): Promise<PersistedBotState> {
    await this.load();
    this.applyMutation(mutator);
    if (this.deferredTimer) {
      clearTimeout(this.deferredTimer);
      this.deferredTimer = null;
    }
    this.deferredDirty = false;
    await this.persist();
    return this.state;
  }

  async mutateDeferred(
    mutator: (draft: PersistedBotState) => void,
    delayMs = 5_000,
  ): Promise<PersistedBotState> {
    await this.load();
    this.applyMutation(mutator);
    this.deferredDirty = true;
    if (!this.deferredTimer) {
      this.deferredTimer = setTimeout(() => {
        this.deferredTimer = null;
        if (this.deferredDirty) {
          this.deferredDirty = false;
          void this.persist().catch((err) => {
            console.error("[paseo-bot] deferred state persist failed:", err);
          });
        }
      }, delayMs);
      this.deferredTimer.unref?.();
    }
    return this.state;
  }

  async flush(): Promise<void> {
    if (this.deferredTimer) {
      clearTimeout(this.deferredTimer);
      this.deferredTimer = null;
    }
    if (this.deferredDirty || this.writing || this.writePending) {
      this.deferredDirty = false;
      await this.persist();
    }
  }

  countRecentWakes(now = Date.now()): number {
    const cutoff = now - 3600_000;
    let count = 0;
    for (const ts of this.state.wakeTimestamps) {
      if (ts > cutoff) count += 1;
    }
    return count;
  }

  private persist(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingWaiters.push({ resolve, reject });
      if (this.writing) {
        this.writePending = true;
        return;
      }
      this.writing = true;
      void this.drainWrites();
    });
  }

  private async drainWrites(): Promise<void> {
    const dir = path.dirname(this.stateFilePath);
    const tmp = `${this.stateFilePath}.${process.pid}.tmp`;
    while (true) {
      this.writePending = false;
      const batchWaiters = this.pendingWaiters;
      this.pendingWaiters = [];
      const snapshot = JSON.stringify(this.state);
      try {
        if (!this.dirEnsured) {
          await fs.mkdir(dir, { recursive: true });
          this.dirEnsured = true;
        }
        this.markSelfWrite(this.stateFilePath);
        await fs.writeFile(tmp, snapshot, "utf8");
        await fs.rename(tmp, this.stateFilePath);
        for (const w of batchWaiters) w.resolve();
      } catch (err) {
        this.dirEnsured = false;
        for (const w of batchWaiters) w.reject(err);
      }
      if (!this.writePending && this.pendingWaiters.length === 0) {
        this.writing = false;
        return;
      }
    }
  }

  markSelfWrite(targetPath: string, ttlMs = 12_000): void {
    const now = Date.now();
    if (this.selfWriteGuard.size > 16) {
      for (const [k, exp] of this.selfWriteGuard.entries()) {
        if (now > exp) this.selfWriteGuard.delete(k);
      }
    }
    const resolved = path.resolve(targetPath);
    this.selfWriteGuard.set(resolved, now + ttlMs);
  }

  isSelfWritten(targetPath: string): boolean {
    const resolved = path.resolve(targetPath);
    const expiresAt = this.selfWriteGuard.get(resolved);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      this.selfWriteGuard.delete(resolved);
      return false;
    }
    return true;
  }

  async readMemory(memoryFilePath: string): Promise<string> {
    const resolved = path.resolve(expandHomePath(memoryFilePath));
    try {
      const st = await fs.stat(resolved);
      if (
        this.memoryCache &&
        this.memoryCache.resolved === resolved &&
        this.memoryCache.mtimeMs === st.mtimeMs &&
        this.memoryCache.size === st.size
      ) {
        return this.memoryCache.content;
      }
      const content = await fs.readFile(resolved, "utf8");
      this.memoryCache = {
        resolved,
        mtimeMs: st.mtimeMs,
        size: st.size,
        content,
      };
      return content;
    } catch {
      if (this.memoryCache?.resolved === resolved) {
        this.memoryCache = null;
      }
      return "";
    }
  }

  async writeMemory(memoryFilePath: string, content: string): Promise<void> {
    const resolved = path.resolve(expandHomePath(memoryFilePath));
    this.markSelfWrite(resolved);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf8");
    try {
      const st = await fs.stat(resolved);
      this.memoryCache = {
        resolved,
        mtimeMs: st.mtimeMs,
        size: st.size,
        content,
      };
    } catch {
      this.memoryCache = null;
    }
  }

  async appendMemoryNote(memoryFilePath: string, note: string): Promise<void> {
    const existing = await this.readMemory(memoryFilePath);
    const today = new Date().toISOString().slice(0, 10);
    const cleanNote = note.trim();
    if (!cleanNote) return;

    let nextContent: string;
    if (!existing.trim()) {
      nextContent = `# Paseo Bot 长期记忆（MEMORY.md）\n\n- [${today}] ${cleanNote}\n`;
    } else {
      const updatedHeader = existing.replace(/^updated:\s*.*$/m, `updated: ${today}`);
      nextContent = `${updatedHeader.trimEnd()}\n- [${today}] ${cleanNote}\n`;
    }
    await this.writeMemory(memoryFilePath, nextContent);
  }
}
