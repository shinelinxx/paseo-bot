import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type {
  BotSnapshot,
  BotSummary,
  ChatMessage,
  ChatMessageImage,
  FeedFeedback,
  FeedItem,
  KnownWorkspace,
  RoutingTelemetry,
  TierModels,
} from "../shared/contracts";

export const MAX_DRAFT_IMAGES = 6;

export interface DraftImageAttachment {
  id: string;
  data: string;
  mimeType: string;
  previewUri: string;
  name?: string;
  sizeBytes?: number;
}

export type BotConsoleTab = "inbox" | "approvals" | "missions" | "workers";
export type BotInboxFilterMode = "all" | "unread" | "running" | "attention";
export type ManagementDrawerSection =
  | "rules"
  | "approvals"
  | "memory"
  | "workers"
  | "routing";

const DEFAULT_ROUTING_TELEMETRY: RoutingTelemetry = {
  l0Hits: 0,
  l1Hits: 0,
  l2Hits: 0,
  l3Hits: 0,
  fallbackCount: 0,
};

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
  knownWorkspaces: [],
  memoryContent: "",
  memoryPath: "",
  butlerName: "Paseo Bot",
  userName: "",
  messages: [],
  routingTelemetry: DEFAULT_ROUTING_TELEMETRY,
};

let currentSnapshot: BotSnapshot = EMPTY_SNAPSHOT;
let requestedTab: BotConsoleTab | null = null;
let requestedInboxFilter: BotInboxFilterMode | null = null;
let requestedDrawerSection: ManagementDrawerSection | null = null;
let selectedConsoleProvider: string | null = null;
let deepThinkEnabled = false;
let pendingChatSends = 0;
let wishDraftText = "";
let wishDraftImages: DraftImageAttachment[] = [];

interface PendingOptimisticWish {
  item: FeedItem;
  createdAtMs: number;
  confirmedFeedId?: string;
}

interface PendingOptimisticChatMessage {
  item: ChatMessage;
  createdAtMs: number;
  confirmedMessageId?: string;
}

const OPTIMISTIC_WISH_TTL_MS = 30_000;
const OPTIMISTIC_CHAT_TTL_MS = 45_000;
const MAX_LOCAL_IMAGE_PREVIEW_CACHE = 32;

let optimisticWishSeq = 0;
let optimisticChatSeq = 0;
const pendingOptimisticWishes = new Map<string, PendingOptimisticWish>();
const pendingOptimisticChatMessages = new Map<string, PendingOptimisticChatMessage>();
const localMessageImagePreviews = new Map<string, ChatMessageImage[]>();

function rememberLocalMessagePreviews(
  messageId: string,
  images: readonly ChatMessageImage[],
): void {
  if (!messageId || images.length === 0) return;
  if (!images.some((img) => Boolean(img.previewUri))) return;
  localMessageImagePreviews.delete(messageId);
  localMessageImagePreviews.set(messageId, [...images]);
  while (localMessageImagePreviews.size > MAX_LOCAL_IMAGE_PREVIEW_CACHE) {
    const oldestKey = localMessageImagePreviews.keys().next().value;
    if (!oldestKey) break;
    localMessageImagePreviews.delete(oldestKey);
  }
}

function hydrateLocalMessageImages(messages: ChatMessage[]): ChatMessage[] {
  if (localMessageImagePreviews.size === 0 || messages.length === 0) return messages;
  let mutated = false;
  const next = messages.map((msg) => {
    const cached = localMessageImagePreviews.get(msg.id);
    if (!cached || cached.length === 0) return msg;
    const alreadyHasPreview = msg.images.some((img) => Boolean(img.previewUri));
    if (alreadyHasPreview) return msg;
    mutated = true;
    return {
      ...msg,
      images: cached,
    };
  });
  return mutated ? next : messages;
}

function mergePendingOptimisticFeed(serverFeed: FeedItem[]): FeedItem[] {
  if (pendingOptimisticWishes.size === 0) return serverFeed;
  const now = Date.now();
  const stillPending: FeedItem[] = [];
  for (const [optId, entry] of pendingOptimisticWishes) {
    const matchedById =
      Boolean(entry.confirmedFeedId) &&
      serverFeed.some((f) => f.id === entry.confirmedFeedId);
    const matchedByContent =
      !matchedById &&
      serverFeed.some((f) => {
        if (!f.inProgress || f.summary !== entry.item.summary) return false;
        const ts = Date.parse(f.createdAt);
        return Number.isFinite(ts) && ts >= entry.createdAtMs - 10_000;
      });
    const expired = now - entry.createdAtMs > OPTIMISTIC_WISH_TTL_MS;
    if (matchedById || matchedByContent || expired) {
      pendingOptimisticWishes.delete(optId);
    } else {
      stillPending.push(entry.item);
    }
  }
  if (stillPending.length === 0) return serverFeed;
  // Newest optimistic items first
  stillPending.reverse();
  return [...stillPending, ...serverFeed];
}

function mergePendingOptimisticChatMessages(serverMessages: ChatMessage[]): ChatMessage[] {
  const hydrated = hydrateLocalMessageImages(serverMessages);
  if (pendingOptimisticChatMessages.size === 0) return hydrated;
  const now = Date.now();
  const stillPending: ChatMessage[] = [];

  for (const [optId, entry] of pendingOptimisticChatMessages) {
    const matchedServerMsg = hydrated.find((m) => {
      if (entry.confirmedMessageId && m.id === entry.confirmedMessageId) {
        return true;
      }
      if (!entry.confirmedMessageId && m.role === "user" && m.text === entry.item.text) {
        const ts = Date.parse(m.createdAt);
        return Number.isFinite(ts) && ts >= entry.createdAtMs - 10_000;
      }
      return false;
    });

    const expired = now - entry.createdAtMs > OPTIMISTIC_CHAT_TTL_MS;
    if (matchedServerMsg) {
      if (entry.item.images.length > 0) {
        rememberLocalMessagePreviews(matchedServerMsg.id, entry.item.images);
      }
      pendingOptimisticChatMessages.delete(optId);
    } else if (expired) {
      pendingOptimisticChatMessages.delete(optId);
    } else {
      stillPending.push(entry.item);
    }
  }

  const rehydrated = hydrateLocalMessageImages(hydrated);
  if (stillPending.length === 0) return rehydrated;
  return [...rehydrated, ...stillPending];
}

const listeners = new Set<() => void>();
const providerListeners = new Set<() => void>();
const deepThinkListeners = new Set<() => void>();
const chatSendListeners = new Set<() => void>();
const wishDraftListeners = new Set<() => void>();
const wishDraftImagesListeners = new Set<() => void>();

let cachedSidebarKey = "0:0:0:0";
let cachedSidebarCounts = {
  pendingApprovalCount: 0,
  unreadCount: 0,
  runningWorkerCount: 0,
  globalPaused: false,
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

function shallowEqualSelectorResult(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    return shallowEqualPlainObject(
      a as Record<string, unknown>,
      b as Record<string, unknown>,
    );
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }
  return false;
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

function reconcileWorkspaces(prev: KnownWorkspace[], next: KnownWorkspace[]): KnownWorkspace[] {
  if (prev === next) return prev;
  if (prev.length === 0 && next.length === 0) return prev;
  if (prev.length === next.length) {
    let same = true;
    for (let i = 0; i < prev.length; i += 1) {
      if (prev[i].cwd !== next[i].cwd || prev[i].label !== next[i].label) {
        same = false;
        break;
      }
    }
    if (same) return prev;
  }
  return next;
}

function reconcileOptionalRecord<T extends Record<string, unknown> | undefined>(
  prev: T,
  next: T,
): T {
  if (Object.is(prev, next)) return prev;
  if (!prev || !next) return next;
  return shallowEqualPlainObject(prev, next) ? prev : next;
}

function updateSidebarCacheAndEmit(): void {
  const nextKey = `${currentSnapshot.pendingApprovalCount}:${currentSnapshot.unreadCount}:${currentSnapshot.runningWorkerCount}:${currentSnapshot.globalPaused ? 1 : 0}`;
  if (nextKey !== cachedSidebarKey) {
    cachedSidebarKey = nextKey;
    cachedSidebarCounts = {
      pendingApprovalCount: currentSnapshot.pendingApprovalCount,
      unreadCount: currentSnapshot.unreadCount,
      runningWorkerCount: currentSnapshot.runningWorkerCount,
      globalPaused: currentSnapshot.globalPaused,
    };
  }
  for (const listener of listeners) {
    listener();
  }
}

export function setLiveBotSummary(summary: BotSummary): void {
  const prev = currentSnapshot;
  if (
    prev.globalPaused === summary.globalPaused &&
    prev.unreadCount === summary.unreadCount &&
    prev.pendingApprovalCount === summary.pendingApprovalCount &&
    prev.runningWorkerCount === summary.runningWorkerCount
  ) {
    return;
  }
  currentSnapshot = {
    ...prev,
    globalPaused: summary.globalPaused,
    unreadCount: summary.unreadCount,
    pendingApprovalCount: summary.pendingApprovalCount,
    runningWorkerCount: summary.runningWorkerCount,
  };
  updateSidebarCacheAndEmit();
}

let fullSyncActivator: (() => () => void) | null = null;
let fullSyncRefs = 0;
let fullSyncCleanup: (() => void) | null = null;

export function registerBotFullSync(activator: (() => () => void) | null): void {
  if (fullSyncCleanup) {
    fullSyncCleanup();
    fullSyncCleanup = null;
  }
  fullSyncActivator = activator;
  if (fullSyncRefs > 0 && fullSyncActivator) {
    fullSyncCleanup = fullSyncActivator();
  }
}

export function useFullBotSync(): void {
  useEffect(() => {
    fullSyncRefs += 1;
    if (fullSyncRefs === 1 && fullSyncActivator && !fullSyncCleanup) {
      fullSyncCleanup = fullSyncActivator();
    }
    return () => {
      fullSyncRefs = Math.max(0, fullSyncRefs - 1);
      if (fullSyncRefs === 0 && fullSyncCleanup) {
        const cleanup = fullSyncCleanup;
        fullSyncCleanup = null;
        cleanup();
      }
    };
  }, []);
}

export function setLiveBotSnapshot(next: BotSnapshot): void {
  const prev = currentSnapshot;
  const triggers = reconcileById(prev.triggers, next.triggers);
  const nativeSchedules = reconcileById(
    prev.nativeSchedules ?? [],
    next.nativeSchedules ?? [],
  );
  const feed = reconcileById(prev.feed, mergePendingOptimisticFeed(next.feed));
  const approvals = reconcileById(prev.approvals, next.approvals);
  const workers = reconcileById(prev.workers, next.workers);
  const routineSuggestions = reconcileById(
    prev.routineSuggestions,
    next.routineSuggestions ?? [],
  );
  const knownWorkspaces = reconcileWorkspaces(
    prev.knownWorkspaces ?? [],
    next.knownWorkspaces ?? [],
  );
  const messages = reconcileById(
    prev.messages ?? [],
    mergePendingOptimisticChatMessages(next.messages ?? []),
  );
  const nextButlerName = next.butlerName ?? prev.butlerName ?? "Paseo Bot";
  const nextUserName = next.userName ?? prev.userName ?? "";
  const routingTelemetry = reconcileOptionalRecord(
    (prev.routingTelemetry ?? DEFAULT_ROUTING_TELEMETRY) as unknown as Record<string, unknown>,
    (next.routingTelemetry ??
      prev.routingTelemetry ??
      DEFAULT_ROUTING_TELEMETRY) as unknown as Record<string, unknown>,
  ) as unknown as RoutingTelemetry;
  const tierModels = reconcileOptionalRecord(
    prev.tierModels as unknown as Record<string, unknown> | undefined,
    next.tierModels as unknown as Record<string, unknown> | undefined,
  ) as unknown as TierModels | undefined;

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
    prev.butlerName === nextButlerName &&
    prev.userName === nextUserName &&
    triggers === prev.triggers &&
    nativeSchedules === prev.nativeSchedules &&
    feed === prev.feed &&
    approvals === prev.approvals &&
    workers === prev.workers &&
    routineSuggestions === prev.routineSuggestions &&
    knownWorkspaces === prev.knownWorkspaces &&
    messages === (prev.messages ?? []) &&
    routingTelemetry === prev.routingTelemetry &&
    tierModels === prev.tierModels;

  if (unchanged) return;

  currentSnapshot = {
    ...next,
    butlerName: nextButlerName,
    userName: nextUserName,
    triggers,
    nativeSchedules,
    feed,
    approvals,
    workers,
    routineSuggestions,
    knownWorkspaces,
    messages,
    routingTelemetry,
    tierModels,
  };
  updateSidebarCacheAndEmit();
}

export function isFeedItemNeedsAttention(
  item: FeedItem,
  opts?: { resolvedApprovalIds?: ReadonlySet<string>; nowMs?: number },
): boolean {
  if (item.level === "silent") return false;
  if (item.inProgress) return false;
  if (item.feedback === "down") return false;
  if (item.snoozedUntil) {
    const snoozeTs = Date.parse(item.snoozedUntil);
    const nowMs = opts?.nowMs ?? Date.now();
    if (Number.isFinite(snoozeTs) && snoozeTs > nowMs) {
      return false;
    }
  }
  if (item.level === "approval_required") {
    if (item.approvalId && opts?.resolvedApprovalIds?.has(item.approvalId)) {
      return false;
    }
    return true;
  }
  if (item.level === "error") {
    return Boolean(item.unread);
  }
  const actions = item.actions ?? [];
  if (actions.length > 0) {
    return !actions.some((a) => Boolean(a.executedAt));
  }
  return false;
}

function recomputeDerivedSnapshot(next: BotSnapshot): BotSnapshot {
  const msgs = next.messages ?? [];
  let unreadCount = 0;
  if (msgs.length > 0) {
    for (const m of msgs) {
      if (m.unread && m.role !== "user") unreadCount += 1;
    }
  } else {
    for (const f of next.feed) {
      if (f.unread && f.level !== "silent") unreadCount += 1;
    }
  }
  let pendingApprovalCount = 0;
  for (const a of next.approvals) {
    if (a.status === "pending") pendingApprovalCount += 1;
  }
  let runningWorkerCount = 0;
  for (const w of next.workers) {
    if (w.status === "running" || w.status === "permission") runningWorkerCount += 1;
  }
  return {
    ...next,
    unreadCount,
    pendingApprovalCount,
    runningWorkerCount,
  };
}

export function optimisticAddChatMessage(
  text: string,
  images: ReadonlyArray<ChatMessageImage> = [],
  replyToMessageId?: string,
): string {
  const clean = text.trim();
  const fallbackLabel =
    images.length <= 0
      ? ""
      : images.length === 1
        ? "[附 1 张图片]"
        : `[附 ${images.length} 张图片]`;
  const nowMs = Date.now();
  optimisticChatSeq += 1;
  const id = `opt_chat_${nowMs}_${optimisticChatSeq}`;
  const item: ChatMessage = {
    id,
    createdAt: new Date(nowMs).toISOString(),
    role: "user",
    kind: "chat",
    text: clean || fallbackLabel,
    images: [...images],
    links: [],
    quickActions: [],
    status: "sending",
    replyToMessageId,
    unread: false,
  };
  pendingOptimisticChatMessages.set(id, { item, createdAtMs: nowMs });
  const prev = currentSnapshot;
  const prevMessages = prev.messages ?? [];
  currentSnapshot = {
    ...prev,
    messages: [...prevMessages, item],
  };
  updateSidebarCacheAndEmit();
  return id;
}

export function confirmOptimisticChatMessage(
  optimisticId: string,
  serverUserMessageId?: string,
): void {
  const entry = pendingOptimisticChatMessages.get(optimisticId);
  if (!entry) return;
  if (serverUserMessageId) {
    entry.confirmedMessageId = serverUserMessageId;
    if (entry.item.images.length > 0) {
      rememberLocalMessagePreviews(serverUserMessageId, entry.item.images);
    }
    const currMsgs = currentSnapshot.messages ?? [];
    if (currMsgs.some((m) => m.id === serverUserMessageId)) {
      pendingOptimisticChatMessages.delete(optimisticId);
      const filtered = hydrateLocalMessageImages(
        currMsgs.filter((m) => m.id !== optimisticId),
      );
      currentSnapshot = recomputeDerivedSnapshot({
        ...currentSnapshot,
        messages: filtered,
      });
      updateSidebarCacheAndEmit();
      return;
    }
  }
  // Server snapshot not yet pushed over subscription: mark optimistic bubble sent cleanly
  if (entry.item.status !== "done") {
    const updatedItem: ChatMessage = { ...entry.item, status: "done" };
    entry.item = updatedItem;
    const currMsgs = currentSnapshot.messages ?? [];
    if (currMsgs.some((m) => m.id === optimisticId)) {
      currentSnapshot = {
        ...currentSnapshot,
        messages: currMsgs.map((m) => (m.id === optimisticId ? updatedItem : m)),
      };
      updateSidebarCacheAndEmit();
    }
  }
}

export function rollbackOptimisticChatMessage(optimisticId: string): void {
  pendingOptimisticChatMessages.delete(optimisticId);
  const prev = currentSnapshot;
  const currMsgs = prev.messages ?? [];
  if (!currMsgs.some((m) => m.id === optimisticId)) return;
  const nextMessages = currMsgs.filter((m) => m.id !== optimisticId);
  currentSnapshot = recomputeDerivedSnapshot({
    ...prev,
    messages: nextMessages,
  });
  updateSidebarCacheAndEmit();
}

export function optimisticMarkMessagesRead(upToMessageId?: string): void {
  const prev = currentSnapshot;
  const currMsgs = prev.messages ?? [];
  if (currMsgs.length === 0 && prev.unreadCount === 0) return;

  const cleanUpTo = upToMessageId?.trim();
  let changed = false;
  let stopReached = false;
  const nextMessages = currMsgs.map((m) => {
    if (stopReached) return m;
    const next = m.unread ? ((changed = true), { ...m, unread: false }) : m;
    if (cleanUpTo && m.id === cleanUpTo) {
      stopReached = true;
    }
    return next;
  });

  if (!changed && prev.unreadCount === 0) return;
  const nextFeed = !cleanUpTo
    ? prev.feed.map((f) => (f.unread ? { ...f, unread: false } : f))
    : prev.feed;

  currentSnapshot = recomputeDerivedSnapshot({
    ...prev,
    messages: changed ? nextMessages : currMsgs,
    feed: nextFeed,
  });
  updateSidebarCacheAndEmit();
}

export function optimisticUpdateButlerProfile(input: {
  butlerName?: string;
  userName?: string;
}): void {
  const prev = currentSnapshot;
  const nextButler =
    input.butlerName !== undefined
      ? input.butlerName.trim() || "Paseo Bot"
      : (prev.butlerName ?? "Paseo Bot");
  const nextUser =
    input.userName !== undefined ? input.userName.trim() : (prev.userName ?? "");
  if (prev.butlerName === nextButler && prev.userName === nextUser) return;
  currentSnapshot = {
    ...prev,
    butlerName: nextButler,
    userName: nextUser,
  };
  updateSidebarCacheAndEmit();
}

export function optimisticAddWishFeed(wishText: string, imageCount = 0): string {
  const clean = wishText.trim();
  const compact = clean.replace(/\s+/g, " ");
  const imageTag =
    imageCount <= 0 ? "" : imageCount === 1 ? "[附 1 张图片]" : `[附 ${imageCount} 张图片]`;
  const previewTitle = compact
    ? compact.slice(0, 26) + (compact.length > 26 ? "…" : "")
    : imageCount === 1
      ? "图片任务"
      : `${imageCount} 张图片任务`;
  const summary = clean ? (imageTag ? `${clean}\n\n${imageTag}` : clean) : imageTag;
  const nowMs = Date.now();
  optimisticWishSeq += 1;
  const id = `opt_wish_${nowMs}_${optimisticWishSeq}`;
  const item: FeedItem = {
    id,
    createdAt: new Date(nowMs).toISOString(),
    level: "wish",
    title: `正在处理：${previewTitle}`,
    summary,
    actions: [],
    inProgress: true,
    unread: false,
  };
  pendingOptimisticWishes.set(id, { item, createdAtMs: nowMs });
  const prev = currentSnapshot;
  currentSnapshot = {
    ...prev,
    feed: [item, ...prev.feed],
  };
  updateSidebarCacheAndEmit();
  return id;
}

export function confirmOptimisticWishFeed(optimisticId: string, serverFeedId?: string): void {
  const entry = pendingOptimisticWishes.get(optimisticId);
  if (!entry) return;
  if (serverFeedId) {
    entry.confirmedFeedId = serverFeedId;
    if (currentSnapshot.feed.some((f) => f.id === serverFeedId)) {
      pendingOptimisticWishes.delete(optimisticId);
      const nextFeed = currentSnapshot.feed.filter((f) => f.id !== optimisticId);
      currentSnapshot = recomputeDerivedSnapshot({ ...currentSnapshot, feed: nextFeed });
      updateSidebarCacheAndEmit();
    }
  }
}

export function rollbackOptimisticWishFeed(optimisticId: string): void {
  pendingOptimisticWishes.delete(optimisticId);
  const prev = currentSnapshot;
  if (!prev.feed.some((f) => f.id === optimisticId)) return;
  const nextFeed = prev.feed.filter((f) => f.id !== optimisticId);
  currentSnapshot = recomputeDerivedSnapshot({ ...prev, feed: nextFeed });
  updateSidebarCacheAndEmit();
}

export function optimisticExecuteFeedAction(
  feedId: string,
  opts?: { actionId?: string; markInProgress?: boolean },
): () => void {
  const prev = currentSnapshot;
  const target = prev.feed.find((f) => f.id === feedId);
  if (!target) return () => {};

  const prevUnread = target.unread;
  const prevInProgress = target.inProgress;
  const prevCreatedAt = target.createdAt;
  const actionId = opts?.actionId;
  const prevActionExecutedAt = actionId
    ? target.actions.find((a) => a.id === actionId)?.executedAt
    : undefined;

  const nowIso = new Date().toISOString();
  const nextFeed = prev.feed.map((f) => {
    if (f.id !== feedId) return f;
    const nextActions = actionId
      ? f.actions.map((a) => (a.id === actionId ? { ...a, executedAt: nowIso } : a))
      : f.actions;
    return {
      ...f,
      unread: false,
      inProgress: opts?.markInProgress ? true : f.inProgress,
      createdAt: opts?.markInProgress ? nowIso : f.createdAt,
      actions: nextActions,
    };
  });

  currentSnapshot = recomputeDerivedSnapshot({ ...prev, feed: nextFeed });
  updateSidebarCacheAndEmit();

  let rolledBack = false;
  return () => {
    if (rolledBack) return;
    rolledBack = true;
    const curr = currentSnapshot;
    if (!curr.feed.some((f) => f.id === feedId)) return;
    const restoredFeed = curr.feed.map((f) => {
      if (f.id !== feedId) return f;
      const restoredActions = actionId
        ? f.actions.map((a) =>
            a.id === actionId ? { ...a, executedAt: prevActionExecutedAt } : a,
          )
        : f.actions;
      return {
        ...f,
        unread: prevUnread,
        inProgress: prevInProgress,
        createdAt: prevCreatedAt,
        actions: restoredActions,
      };
    });
    currentSnapshot = recomputeDerivedSnapshot({ ...curr, feed: restoredFeed });
    updateSidebarCacheAndEmit();
  };
}

export function optimisticSnoozeFeed(feedId: string, delayMinutes: number): () => void {
  const prev = currentSnapshot;
  const target = prev.feed.find((f) => f.id === feedId);
  if (!target) return () => {};

  const prevUnread = target.unread;
  const prevSnoozedUntil = target.snoozedUntil;
  const nextSnoozedUntil = new Date(Date.now() + Math.round(delayMinutes * 60_000)).toISOString();

  const nextFeed = prev.feed.map((f) =>
    f.id === feedId ? { ...f, unread: false, snoozedUntil: nextSnoozedUntil } : f,
  );
  currentSnapshot = recomputeDerivedSnapshot({ ...prev, feed: nextFeed });
  updateSidebarCacheAndEmit();

  let rolledBack = false;
  return () => {
    if (rolledBack) return;
    rolledBack = true;
    const curr = currentSnapshot;
    if (!curr.feed.some((f) => f.id === feedId)) return;
    const restoredFeed = curr.feed.map((f) =>
      f.id === feedId
        ? { ...f, unread: prevUnread, snoozedUntil: prevSnoozedUntil }
        : f,
    );
    currentSnapshot = recomputeDerivedSnapshot({ ...curr, feed: restoredFeed });
    updateSidebarCacheAndEmit();
  };
}

export function optimisticMarkFeedRead(opts: {
  id?: string;
  dismissId?: string;
  clearRead?: boolean;
  clearSilent?: boolean;
}): void {
  const prev = currentSnapshot;
  let nextFeed = prev.feed;
  if (opts.dismissId) {
    nextFeed = prev.feed.filter((f) => f.id !== opts.dismissId);
  } else if (opts.clearRead) {
    nextFeed = prev.feed.filter(
      (f) => f.unread || f.inProgress || f.level === "approval_required",
    );
  } else {
    if (opts.clearSilent) {
      nextFeed = nextFeed.filter((f) => f.level !== "silent");
    }
    nextFeed = nextFeed.map((f) =>
      (!opts.id || f.id === opts.id) && f.unread ? { ...f, unread: false } : f,
    );
  }
  currentSnapshot = recomputeDerivedSnapshot({ ...prev, feed: nextFeed });
  updateSidebarCacheAndEmit();
}

export function optimisticCurateFeed(
  feedId: string,
  feedback: FeedFeedback,
  muteTriggerId?: string,
): void {
  const prev = currentSnapshot;
  const nextFeed = prev.feed.map((f) =>
    f.id === feedId
      ? { ...f, feedback, unread: feedback === "down" ? false : f.unread }
      : f,
  );
  const nextTriggers = muteTriggerId
    ? prev.triggers.map((t) => (t.id === muteTriggerId ? { ...t, enabled: false } : t))
    : prev.triggers;
  currentSnapshot = recomputeDerivedSnapshot({
    ...prev,
    feed: nextFeed,
    triggers: nextTriggers,
  });
  updateSidebarCacheAndEmit();
}

export function optimisticToggleTrigger(id: string, enabled: boolean): void {
  const prev = currentSnapshot;
  const nextTriggers = prev.triggers.map((t) =>
    t.id === id ? { ...t, enabled } : t,
  );
  currentSnapshot = { ...prev, triggers: nextTriggers };
  updateSidebarCacheAndEmit();
}

export function optimisticDeleteTrigger(opts: {
  id?: string;
  clearFinishedReminders?: boolean;
}): void {
  const prev = currentSnapshot;
  const nextTriggers = opts.clearFinishedReminders
    ? prev.triggers.filter((t) => !(t.kind === "self_wake" && !t.enabled))
    : prev.triggers.filter((t) => t.id !== opts.id);
  currentSnapshot = { ...prev, triggers: nextTriggers };
  updateSidebarCacheAndEmit();
}

export function optimisticManageNativeSchedule(
  id: string,
  action: "pause" | "resume" | "delete",
): void {
  const prev = currentSnapshot;
  const list = prev.nativeSchedules ?? [];
  const nextSchedules =
    action === "delete"
      ? list.filter((s) => s.id !== id)
      : list.map((s) =>
          s.id === id
            ? { ...s, status: action === "resume" ? "active" : "paused" }
            : s,
        );
  currentSnapshot = { ...prev, nativeSchedules: nextSchedules };
  updateSidebarCacheAndEmit();
}

export function optimisticSetGlobalPaused(paused: boolean): void {
  if (currentSnapshot.globalPaused === paused) return;
  currentSnapshot = { ...currentSnapshot, globalPaused: paused };
  updateSidebarCacheAndEmit();
}

export function optimisticDismissSuggestion(suggestionId: string): void {
  const prev = currentSnapshot;
  currentSnapshot = {
    ...prev,
    routineSuggestions: prev.routineSuggestions.filter((s) => s.id !== suggestionId),
  };
  updateSidebarCacheAndEmit();
}

export function optimisticRemoveWorker(opts: {
  workerId?: string;
  clearFinished?: boolean;
}): void {
  const prev = currentSnapshot;
  const nextWorkers = opts.clearFinished
    ? prev.workers.filter((w) => w.status === "running" || w.status === "permission")
    : prev.workers.filter((w) => w.id !== opts.workerId);
  currentSnapshot = recomputeDerivedSnapshot({ ...prev, workers: nextWorkers });
  updateSidebarCacheAndEmit();
}

export function optimisticResolveApproval(
  id: string,
  decision: "approved" | "rejected",
): void {
  const prev = currentSnapshot;
  const resolvedAt = new Date().toISOString();
  const target = prev.approvals.find((a) => a.id === id);
  const nextApprovals = prev.approvals.map((a) =>
    a.id === id ? { ...a, status: decision, resolvedAt } : a,
  );
  const nextFeed = target
    ? prev.feed.map((f) =>
        f.approvalId === id ||
        (f.level === "approval_required" && f.title === `待确认：${target.title}`)
          ? {
              ...f,
              unread: false,
              level: "notify" as const,
              title: `${decision === "approved" ? "已确认" : "已拒绝"}：${target.title}`,
            }
          : f,
      )
    : prev.feed;
  const currMsgs = prev.messages ?? [];
  const nextMessages =
    currMsgs.length > 0
      ? currMsgs.map((m) =>
          m.approvalId === id && m.unread ? { ...m, unread: false } : m,
        )
      : currMsgs;
  currentSnapshot = recomputeDerivedSnapshot({
    ...prev,
    approvals: nextApprovals,
    feed: nextFeed,
    messages: nextMessages,
  });
  updateSidebarCacheAndEmit();
}

export function getLiveBotSnapshot(): BotSnapshot {
  return currentSnapshot;
}

export function setRequestedDrawerSection(section: ManagementDrawerSection | null): void {
  requestedDrawerSection = section;
}

export function consumeRequestedDrawerSection(): ManagementDrawerSection | null {
  const section = requestedDrawerSection;
  requestedDrawerSection = null;
  return section;
}

export function setRequestedConsoleTab(tab: BotConsoleTab | null): void {
  if (tab === "approvals") {
    requestedTab = "inbox";
    requestedInboxFilter = "attention";
    requestedDrawerSection = "approvals";
    return;
  }
  if (tab === "missions") {
    requestedDrawerSection = "rules";
  } else if (tab === "workers") {
    requestedDrawerSection = "workers";
  } else if (tab === "inbox") {
    requestedDrawerSection = null;
  }
  requestedTab = tab;
}

export function consumeRequestedConsoleTab(): BotConsoleTab | null {
  const tab = requestedTab;
  requestedTab = null;
  return tab;
}

export function setRequestedInboxFilter(filter: BotInboxFilterMode | null): void {
  requestedInboxFilter = filter;
}

export function consumeRequestedInboxFilter(): BotInboxFilterMode | null {
  const filter = requestedInboxFilter;
  requestedInboxFilter = null;
  return filter;
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

export function useBotSelector<T>(selector: (snap: BotSnapshot) => T): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cacheRef = useRef<{ hasValue: boolean; value: T }>({
    hasValue: false,
    value: undefined as unknown as T,
  });

  const getSelection = useCallback((): T => {
    const next = selectorRef.current(currentSnapshot);
    if (cacheRef.current.hasValue && shallowEqualSelectorResult(cacheRef.current.value, next)) {
      return cacheRef.current.value;
    }
    cacheRef.current = { hasValue: true, value: next };
    return next;
  }, []);

  return useSyncExternalStore(subscribeBotStore, getSelection, getSelection);
}

function getSidebarCountsSnapshot() {
  return cachedSidebarCounts;
}

export function useBotSidebarCounts(): {
  pendingApprovalCount: number;
  unreadCount: number;
  runningWorkerCount: number;
  globalPaused: boolean;
} {
  return useSyncExternalStore(
    subscribeBotStore,
    getSidebarCountsSnapshot,
    getSidebarCountsSnapshot,
  );
}

export function getSelectedConsoleProvider(): string | null {
  return selectedConsoleProvider;
}

export function setSelectedConsoleProvider(next: string | null): void {
  const normalized = next && next.trim() ? next.trim() : null;
  if (selectedConsoleProvider === normalized) return;
  selectedConsoleProvider = normalized;
  for (const listener of providerListeners) {
    listener();
  }
}

export function subscribeSelectedConsoleProvider(listener: () => void): () => void {
  providerListeners.add(listener);
  return () => {
    providerListeners.delete(listener);
  };
}

export function useSelectedConsoleProvider(): string | null {
  return useSyncExternalStore(
    subscribeSelectedConsoleProvider,
    getSelectedConsoleProvider,
    getSelectedConsoleProvider,
  );
}

export function getDeepThinkEnabled(): boolean {
  return deepThinkEnabled;
}

export function setDeepThinkEnabled(next: boolean): void {
  if (deepThinkEnabled === next) return;
  deepThinkEnabled = next;
  for (const listener of deepThinkListeners) {
    listener();
  }
}

function subscribeDeepThink(listener: () => void): () => void {
  deepThinkListeners.add(listener);
  return () => {
    deepThinkListeners.delete(listener);
  };
}

export function useDeepThinkEnabled(): boolean {
  return useSyncExternalStore(
    subscribeDeepThink,
    getDeepThinkEnabled,
    getDeepThinkEnabled,
  );
}

export function beginPendingChatSend(): () => void {
  pendingChatSends += 1;
  for (const listener of chatSendListeners) {
    listener();
  }
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    pendingChatSends = Math.max(0, pendingChatSends - 1);
    for (const listener of chatSendListeners) {
      listener();
    }
  };
}

function getPendingChatSending(): boolean {
  return pendingChatSends > 0;
}

function subscribePendingChatSending(listener: () => void): () => void {
  chatSendListeners.add(listener);
  return () => {
    chatSendListeners.delete(listener);
  };
}

export function useIsChatSending(): boolean {
  return useSyncExternalStore(
    subscribePendingChatSending,
    getPendingChatSending,
    getPendingChatSending,
  );
}

export function getWishDraft(): string {
  return wishDraftText;
}

export function setWishDraft(next: string): void {
  if (wishDraftText === next) return;
  wishDraftText = next;
  for (const listener of wishDraftListeners) {
    listener();
  }
}

function subscribeWishDraft(listener: () => void): () => void {
  wishDraftListeners.add(listener);
  return () => {
    wishDraftListeners.delete(listener);
  };
}

export function useWishDraft(): string {
  return useSyncExternalStore(subscribeWishDraft, getWishDraft, getWishDraft);
}

function emitWishDraftImages(): void {
  for (const listener of wishDraftImagesListeners) {
    listener();
  }
}

export function getWishDraftImages(): DraftImageAttachment[] {
  return wishDraftImages;
}

export function setWishDraftImages(next: DraftImageAttachment[]): void {
  wishDraftImages = next.slice(0, MAX_DRAFT_IMAGES);
  emitWishDraftImages();
}

export function appendWishDraftImages(
  incoming: readonly DraftImageAttachment[],
  maxImages = MAX_DRAFT_IMAGES,
): { added: number; truncated: boolean } {
  if (incoming.length === 0) return { added: 0, truncated: false };
  const remaining = Math.max(0, maxImages - wishDraftImages.length);
  const toAdd = incoming.slice(0, remaining);
  const truncated = incoming.length > remaining;
  if (toAdd.length > 0) {
    wishDraftImages = [...wishDraftImages, ...toAdd];
    emitWishDraftImages();
  }
  return { added: toAdd.length, truncated };
}

export function removeWishDraftImage(id: string): void {
  const next = wishDraftImages.filter((img) => img.id !== id);
  if (next.length === wishDraftImages.length) return;
  wishDraftImages = next;
  emitWishDraftImages();
}

export function clearWishDraftImages(): void {
  if (wishDraftImages.length === 0) return;
  wishDraftImages = [];
  emitWishDraftImages();
}

function subscribeWishDraftImages(listener: () => void): () => void {
  wishDraftImagesListeners.add(listener);
  return () => {
    wishDraftImagesListeners.delete(listener);
  };
}

export function useWishDraftImages(): DraftImageAttachment[] {
  return useSyncExternalStore(
    subscribeWishDraftImages,
    getWishDraftImages,
    getWishDraftImages,
  );
}

export function clearBotStore(): void {
  if (fullSyncCleanup) {
    fullSyncCleanup();
    fullSyncCleanup = null;
  }
  fullSyncActivator = null;
  fullSyncRefs = 0;
  currentSnapshot = EMPTY_SNAPSHOT;
  requestedTab = null;
  requestedInboxFilter = null;
  requestedDrawerSection = null;
  selectedConsoleProvider = null;
  deepThinkEnabled = false;
  pendingChatSends = 0;
  wishDraftText = "";
  wishDraftImages = [];
  optimisticWishSeq = 0;
  optimisticChatSeq = 0;
  pendingOptimisticWishes.clear();
  pendingOptimisticChatMessages.clear();
  localMessageImagePreviews.clear();
  cachedSidebarKey = "0:0:0:0";
  cachedSidebarCounts = {
    pendingApprovalCount: 0,
    unreadCount: 0,
    runningWorkerCount: 0,
    globalPaused: false,
  };
  listeners.clear();
  providerListeners.clear();
  deepThinkListeners.clear();
  chatSendListeners.clear();
  wishDraftListeners.clear();
  wishDraftImagesListeners.clear();
}
