import { useSyncExternalStore } from "react";
import type { BotSnapshot } from "../shared/contracts";

export type BotConsoleTab = "inbox" | "approvals" | "missions" | "workers";

const EMPTY_SNAPSHOT: BotSnapshot = {
  chiefAgentId: null,
  chiefWorkspaceId: null,
  webhookBaseUrl: null,
  hourlyWakesUsed: 0,
  hourlyWakeLimit: 24,
  globalPaused: false,
  unreadCount: 0,
  pendingApprovalCount: 0,
  runningWorkerCount: 0,
  totalSilentChecks: 0,
  triggers: [],
  nativeSchedules: [],
  feed: [],
  approvals: [],
  workers: [],
  routineSuggestions: [],
  memoryContent: "",
  memoryPath: "",
};

let currentSnapshot: BotSnapshot = EMPTY_SNAPSHOT;
let requestedTab: BotConsoleTab | null = null;
const listeners = new Set<() => void>();

let cachedSidebarKey = "0:0:0";
let cachedSidebarCounts = {
  pendingApprovalCount: 0,
  unreadCount: 0,
  runningWorkerCount: 0,
};

function shallowEqualPlainObject(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

function shallowEqualValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      const itemA = a[i];
      const itemB = b[i];
      if (Object.is(itemA, itemB)) continue;
      if (
        itemA &&
        itemB &&
        typeof itemA === "object" &&
        typeof itemB === "object" &&
        !Array.isArray(itemA) &&
        !Array.isArray(itemB)
      ) {
        if (
          !shallowEqualPlainObject(
            itemA as Record<string, unknown>,
            itemB as Record<string, unknown>,
          )
        ) {
          return false;
        }
        continue;
      }
      return false;
    }
    return true;
  }
  return false;
}

function shallowEqualRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!shallowEqualValue(a[key], b[key])) return false;
  }
  return true;
}

function reconcileById<T extends { id: string }>(prev: T[], next: T[]): T[] {
  if (prev === next) return prev;
  if (prev.length === 0 && next.length === 0) return prev;
  const prevMap = new Map<string, T>();
  for (const item of prev) prevMap.set(item.id, item);

  let allSame = prev.length === next.length;
  const result: T[] = new Array(next.length);
  for (let i = 0; i < next.length; i += 1) {
    const nextItem = next[i];
    const prevItem = prevMap.get(nextItem.id);
    if (
      prevItem &&
      shallowEqualRecord(
        prevItem as unknown as Record<string, unknown>,
        nextItem as unknown as Record<string, unknown>,
      )
    ) {
      result[i] = prevItem;
      if (prev[i] !== prevItem) allSame = false;
    } else {
      result[i] = nextItem;
      allSame = false;
    }
  }
  return allSame ? prev : result;
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function setLiveBotSnapshot(next: BotSnapshot): void {
  const prev = currentSnapshot;
  const triggers = reconcileById(prev.triggers, next.triggers);
  const nativeSchedules = reconcileById(
    prev.nativeSchedules ?? [],
    next.nativeSchedules ?? [],
  );
  const feed = reconcileById(prev.feed, next.feed);
  const approvals = reconcileById(prev.approvals, next.approvals);
  const workers = reconcileById(prev.workers, next.workers);
  const routineSuggestions = reconcileById(
    prev.routineSuggestions,
    next.routineSuggestions ?? [],
  );

  const unchanged =
    prev.chiefAgentId === next.chiefAgentId &&
    prev.chiefWorkspaceId === next.chiefWorkspaceId &&
    prev.webhookBaseUrl === next.webhookBaseUrl &&
    prev.hourlyWakesUsed === next.hourlyWakesUsed &&
    prev.hourlyWakeLimit === next.hourlyWakeLimit &&
    prev.globalPaused === next.globalPaused &&
    prev.unreadCount === next.unreadCount &&
    prev.pendingApprovalCount === next.pendingApprovalCount &&
    prev.runningWorkerCount === next.runningWorkerCount &&
    prev.totalSilentChecks === next.totalSilentChecks &&
    prev.memoryContent === next.memoryContent &&
    prev.memoryPath === next.memoryPath &&
    triggers === prev.triggers &&
    nativeSchedules === prev.nativeSchedules &&
    feed === prev.feed &&
    approvals === prev.approvals &&
    workers === prev.workers &&
    routineSuggestions === prev.routineSuggestions;

  if (unchanged) return;

  currentSnapshot = {
    ...next,
    triggers,
    nativeSchedules,
    feed,
    approvals,
    workers,
    routineSuggestions,
  };
  const nextKey = `${currentSnapshot.pendingApprovalCount}:${currentSnapshot.unreadCount}:${currentSnapshot.runningWorkerCount}`;
  if (nextKey !== cachedSidebarKey) {
    cachedSidebarKey = nextKey;
    cachedSidebarCounts = {
      pendingApprovalCount: currentSnapshot.pendingApprovalCount,
      unreadCount: currentSnapshot.unreadCount,
      runningWorkerCount: currentSnapshot.runningWorkerCount,
    };
  }
  emit();
}

export function getLiveBotSnapshot(): BotSnapshot {
  return currentSnapshot;
}

export function setRequestedConsoleTab(tab: BotConsoleTab | null): void {
  requestedTab = tab;
}

export function consumeRequestedConsoleTab(): BotConsoleTab | null {
  const tab = requestedTab;
  requestedTab = null;
  return tab;
}

export function subscribeBotStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBotSnapshot(): BotSnapshot {
  return useSyncExternalStore(subscribeBotStore, getLiveBotSnapshot, getLiveBotSnapshot);
}

function getSidebarCountsSnapshot() {
  return cachedSidebarCounts;
}

export function useBotSidebarCounts(): {
  pendingApprovalCount: number;
  unreadCount: number;
  runningWorkerCount: number;
} {
  return useSyncExternalStore(
    subscribeBotStore,
    getSidebarCountsSnapshot,
    getSidebarCountsSnapshot,
  );
}

export function clearBotStore(): void {
  currentSnapshot = EMPTY_SNAPSHOT;
  requestedTab = null;
  cachedSidebarKey = "0:0:0";
  cachedSidebarCounts = {
    pendingApprovalCount: 0,
    unreadCount: 0,
    runningWorkerCount: 0,
  };
  listeners.clear();
}
