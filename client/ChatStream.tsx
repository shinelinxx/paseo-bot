import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView as NativeScrollView,
} from "react-native";
import {
  markMessagesReadRpc,
  type ApprovalItem,
  type ChatMessage,
} from "../shared/contracts";
import { ChatBubble, ThinkingDots } from "./ChatBubble";
import type { TranslateFn } from "./ConsoleModals";
import {
  formatStreamDividerTime,
  isDarkSurfaceColor,
  shouldInsertTimeDivider,
  type RelativeTimeLabels,
} from "./helpers";
import { InlineApprovalCard } from "./InlineApprovalCard";
import {
  optimisticMarkMessagesRead,
  useBotSelector,
  useIsChatSending,
} from "./store";

type PluginTheme = PluginScreenProps["theme"];

const INITIAL_VISIBLE_MESSAGES = 14;
const LOAD_MORE_STEP = 20;

interface StreamDisplayEntry {
  key: string;
  message?: ChatMessage;
  orphanApproval?: ApprovalItem;
  dividerLabel: string | null;
  isLastInGroup: boolean;
  isPendingAck: boolean;
  topSpacing: number;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  scroll: {
    flex: 1,
  },
  contentContainer: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    flexGrow: 1,
    paddingTop: 12,
    paddingBottom: 14,
  },
  loadEarlierWrap: {
    alignSelf: "center",
    marginBottom: 8,
  },
  loadEarlierBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 13,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  loadEarlierText: {
    fontSize: 12,
    fontWeight: "500",
  },
  dividerWrap: {
    alignSelf: "center",
    marginTop: 14,
    marginBottom: 10,
  },
  dividerText: {
    fontSize: 11,
    fontWeight: "500",
  },
  thinkingBubbleWrap: {
    alignSelf: "flex-start",
    marginTop: 10,
  },
  thinkingBubble: {
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderRadius: 20,
    borderBottomLeftRadius: 6,
  },
  scrollToBottomWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 10,
    alignItems: "center",
  },
  scrollToBottomBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
});

function buildFallbackWelcomeMessages(userName: string, t: TranslateFn): ChatMessage[] {
  const cleanUser = userName.trim();
  const baseMs = Date.now();
  const iso = new Date(baseMs).toISOString();
  return [
    {
      id: "welcome_local_1",
      createdAt: iso,
      role: "assistant",
      kind: "chat",
      text: cleanUser
        ? t("welcomeBubble1WithName", { name: cleanUser })
        : t("welcomeBubble1NoName"),
      images: [],
      links: [],
      quickActions: [],
      status: "done",
      unread: false,
    },
    {
      id: "welcome_local_2",
      createdAt: iso,
      role: "assistant",
      kind: "chat",
      text: t("welcomeBubble2"),
      images: [],
      links: [],
      quickActions: [],
      status: "done",
      unread: false,
    },
    {
      id: "welcome_local_3",
      createdAt: iso,
      role: "assistant",
      kind: "chat",
      text: t("welcomeBubble3"),
      images: [],
      links: [],
      quickActions: [],
      status: "done",
      unread: false,
    },
  ];
}

function isGroupableBubble(msg: ChatMessage): boolean {
  if (msg.kind === "approval" || msg.kind === "memory_update" || msg.kind === "status_note") {
    return false;
  }
  return msg.role === "user" || msg.role === "assistant";
}

export interface ChatStreamProps {
  theme: PluginTheme;
  compact: boolean;
  keyboardScrollSignal?: number;
  timeLabels: RelativeTimeLabels;
  t: TranslateFn;
  onOpenAgent: (agentId: string) => void;
}

export const ChatStream = memo(function ChatStream({
  theme,
  compact,
  keyboardScrollSignal = 0,
  timeLabels,
  t,
  onOpenAgent,
}: ChatStreamProps) {
  const markMessagesRead = useRpc(markMessagesReadRpc);
  const isChatSending = useIsChatSending();
  const isDark = useMemo(
    () => isDarkSurfaceColor(theme.colors.surface0),
    [theme.colors.surface0],
  );

  const slice = useBotSelector((s) => ({
    messages: s.messages ?? [],
    approvals: s.approvals,
    unreadCount: s.unreadCount,
    userName: s.userName ?? "",
  }));

  const scrollRef = useRef<NativeScrollView>(null);
  const nearBottomRef = useRef(true);
  const initialScrolledRef = useRef(false);
  const loadingEarlierRef = useRef(false);
  const prevTailKeyRef = useRef<string>("");
  const lastMarkedReadSigRef = useRef<string>("");
  const scrollMetricsRef = useRef({
    contentHeight: 0,
    layoutHeight: 0,
    offsetY: 0,
  });

  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [showScrollDown, setShowScrollDown] = useState(false);

  const effectiveMessages = useMemo(() => {
    if (slice.messages.length > 0) return slice.messages;
    return buildFallbackWelcomeMessages(slice.userName, t);
  }, [slice.messages, slice.userName, t]);

  const { windowedMessages, hiddenCount, allApprovalRefs, allAnsweredAckReplyIds } =
    useMemo(() => {
      const approvalRefs = new Set<string>();
      const answeredAckIds = new Set<string>();
      for (let i = 0; i < effectiveMessages.length; i += 1) {
        const m = effectiveMessages[i];
        if (m.approvalId) approvalRefs.add(m.approvalId);
        if (m.kind !== "ack" && m.replyToMessageId) {
          answeredAckIds.add(m.replyToMessageId);
        }
      }
      const total = effectiveMessages.length;
      const start = Math.max(0, total - visibleCount);
      return {
        windowedMessages: start > 0 ? effectiveMessages.slice(start) : effectiveMessages,
        hiddenCount: start,
        allApprovalRefs: approvalRefs,
        allAnsweredAckReplyIds: answeredAckIds,
      };
    }, [effectiveMessages, visibleCount]);

  const entries = useMemo<StreamDisplayEntry[]>(() => {
    const nowMs = Date.now();
    const result: StreamDisplayEntry[] = [];

    for (let i = 0; i < windowedMessages.length; i += 1) {
      const curr = windowedMessages[i];
      const prev = i > 0 ? windowedMessages[i - 1] : undefined;
      const next = i + 1 < windowedMessages.length ? windowedMessages[i + 1] : undefined;

      const showDivider = shouldInsertTimeDivider(prev?.createdAt, curr.createdAt);
      const dividerLabel = showDivider
        ? formatStreamDividerTime(curr.createdAt, timeLabels, nowMs)
        : null;

      const nextStartsDivider = next
        ? shouldInsertTimeDivider(curr.createdAt, next.createdAt)
        : false;
      const sameNextGroup = Boolean(
        next &&
          !nextStartsDivider &&
          isGroupableBubble(curr) &&
          isGroupableBubble(next) &&
          curr.role === next.role,
      );
      const samePrevGroup = Boolean(
        prev &&
          !showDivider &&
          isGroupableBubble(prev) &&
          isGroupableBubble(curr) &&
          prev.role === curr.role,
      );

      let isPendingAck = false;
      if (curr.kind === "ack" && curr.status === "thinking") {
        const hasLaterAssistantReply = windowedMessages
          .slice(i + 1)
          .some((later) => later.role === "assistant" && later.kind !== "ack");
        const matchedReplyId = Boolean(
          curr.replyToMessageId && allAnsweredAckReplyIds.has(curr.replyToMessageId),
        );
        isPendingAck = !hasLaterAssistantReply && !matchedReplyId;
      }

      result.push({
        key: curr.id,
        message: curr,
        dividerLabel,
        isLastInGroup: !sameNextGroup,
        isPendingAck,
        topSpacing: i === 0 ? 2 : showDivider ? 4 : samePrevGroup ? 6 : 14,
      });
    }

    // Ensure any pending Sentinel approval not yet linked by a message is surfaced inline
    for (const apr of slice.approvals) {
      if (apr.status === "pending" && !allApprovalRefs.has(apr.id)) {
        result.push({
          key: `orphan_apr_${apr.id}`,
          orphanApproval: apr,
          dividerLabel: null,
          isLastInGroup: true,
          isPendingAck: false,
          topSpacing: 14,
        });
      }
    }

    return result;
  }, [allAnsweredAckReplyIds, allApprovalRefs, slice.approvals, timeLabels, windowedMessages]);

  const showBottomThinkingBubble = useMemo(() => {
    if (!isChatSending) return false;
    const last = effectiveMessages[effectiveMessages.length - 1];
    if (!last) return true;
    if (last.role === "assistant" && last.status === "thinking") {
      return false;
    }
    return true;
  }, [effectiveMessages, isChatSending]);

  const scrollToBottom = useCallback((animated: boolean) => {
    nearBottomRef.current = true;
    setShowScrollDown(false);
    scrollRef.current?.scrollToEnd({ animated });
  }, []);

  const handleLoadEarlier = useCallback(() => {
    loadingEarlierRef.current = true;
    setVisibleCount((prev) => prev + LOAD_MORE_STEP);
  }, []);

  const maybeMarkRead = useCallback(() => {
    if (!nearBottomRef.current) return;
    const hasUnreadMsg = slice.messages.some((m) => m.unread && m.role !== "user");
    if (!hasUnreadMsg && slice.unreadCount === 0) return;
    const lastId = slice.messages[slice.messages.length - 1]?.id ?? "none";
    const sig = `${lastId}:${slice.unreadCount}`;
    if (lastMarkedReadSigRef.current === sig) return;
    lastMarkedReadSigRef.current = sig;

    optimisticMarkMessagesRead();
    void markMessagesRead({}).catch(() => undefined);
  }, [markMessagesRead, slice.messages, slice.unreadCount]);

  useEffect(() => {
    maybeMarkRead();
  }, [maybeMarkRead]);

  // Keep latest message visible right above composer when mobile keyboard opens
  useEffect(() => {
    if (keyboardScrollSignal <= 0 || !nearBottomRef.current) return;
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 40);
    return () => clearTimeout(timer);
  }, [keyboardScrollSignal]);

  // Auto-scroll when tail changes while near bottom or when user sends a message
  useEffect(() => {
    const lastEntry = entries[entries.length - 1];
    const tailKey = `${lastEntry?.key ?? ""}:${effectiveMessages.length}:${showBottomThinkingBubble ? 1 : 0}`;
    if (tailKey === prevTailKeyRef.current) return;
    const wasInitial = !initialScrolledRef.current;
    prevTailKeyRef.current = tailKey;

    const lastIsUser = lastEntry?.message?.role === "user";
    if (wasInitial || nearBottomRef.current || lastIsUser) {
      initialScrolledRef.current = true;
      const timer = setTimeout(() => {
        scrollRef.current?.scrollToEnd({ animated: !wasInitial });
      }, 24);
      return () => clearTimeout(timer);
    }
  }, [effectiveMessages.length, entries, showBottomThinkingBubble]);

  const updateScrollDistance = useCallback(() => {
    const { contentHeight, layoutHeight, offsetY } = scrollMetricsRef.current;
    if (layoutHeight <= 0 || contentHeight <= 0) return;
    const distance = contentHeight - (offsetY + layoutHeight);
    const isFarUp = distance > 120;
    nearBottomRef.current = !isFarUp;
    setShowScrollDown((prev) => (prev === isFarUp ? prev : isFarUp));
    if (!isFarUp) {
      maybeMarkRead();
    }
  }, [maybeMarkRead]);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const ne = e.nativeEvent;
      scrollMetricsRef.current = {
        contentHeight: ne.contentSize.height,
        layoutHeight: ne.layoutMeasurement.height,
        offsetY: ne.contentOffset.y,
      };
      updateScrollDistance();
    },
    [updateScrollDistance],
  );

  const handleContentSizeChange = useCallback(
    (_w: number, h: number) => {
      const prevH = scrollMetricsRef.current.contentHeight;
      scrollMetricsRef.current.contentHeight = h;
      if (loadingEarlierRef.current) {
        loadingEarlierRef.current = false;
        updateScrollDistance();
        return;
      }
      if (!initialScrolledRef.current || (nearBottomRef.current && h > prevH)) {
        initialScrolledRef.current = true;
        scrollRef.current?.scrollToEnd({ animated: false });
      } else {
        updateScrollDistance();
      }
    },
    [updateScrollDistance],
  );

  const horizontalPad = compact ? 14 : 20;

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        scrollEventThrottle={48}
        keyboardShouldPersistTaps="handled"
        onScroll={handleScroll}
        onContentSizeChange={handleContentSizeChange}
        onLayout={(e) => {
          const nextH = e.nativeEvent.layout.height;
          const prevH = scrollMetricsRef.current.layoutHeight;
          scrollMetricsRef.current.layoutHeight = nextH;
          if (prevH > 0 && nextH < prevH - 20 && nearBottomRef.current) {
            scrollRef.current?.scrollToEnd({ animated: true });
          } else {
            updateScrollDistance();
          }
        }}
        contentContainerStyle={[
          styles.contentContainer,
          { paddingHorizontal: horizontalPad },
        ]}
      >
        {hiddenCount > 0 ? (
          <View style={styles.loadEarlierWrap}>
            <Pressable
              accessibilityRole="button"
              onPress={handleLoadEarlier}
              style={({ pressed }) => [
                styles.loadEarlierBtn,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: pressed
                    ? theme.colors.surface2
                    : theme.colors.surface1,
                },
              ]}
            >
              <Icon name="ChevronUp" size={13} color={theme.colors.foregroundMuted} />
              <Text
                style={[styles.loadEarlierText, { color: theme.colors.foregroundMuted }]}
              >
                {t("streamLoadEarlier", { count: hiddenCount })}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {entries.map((entry) => (
          <View key={entry.key} style={{ marginTop: entry.topSpacing }}>
            {entry.dividerLabel ? (
              <View style={styles.dividerWrap}>
                <Text
                  style={[styles.dividerText, { color: theme.colors.foregroundMuted }]}
                >
                  {entry.dividerLabel}
                </Text>
              </View>
            ) : null}

            {entry.orphanApproval ? (
              <InlineApprovalCard
                approval={entry.orphanApproval}
                timeLabels={timeLabels}
                theme={theme}
                t={t}
                onOpenAgent={onOpenAgent}
              />
            ) : entry.message?.kind === "approval" ? (
              <InlineApprovalCard
                approvalId={entry.message.approvalId}
                fallbackText={entry.message.text}
                timeLabels={timeLabels}
                theme={theme}
                t={t}
                onOpenAgent={onOpenAgent}
              />
            ) : entry.message ? (
              <ChatBubble
                message={entry.message}
                isLastInGroup={entry.isLastInGroup}
                isPendingAck={entry.isPendingAck}
                theme={theme}
                t={t}
                onOpenAgent={onOpenAgent}
              />
            ) : null}
          </View>
        ))}

        {showBottomThinkingBubble ? (
          <View style={styles.thinkingBubbleWrap}>
            <View
              style={[
                styles.thinkingBubble,
                {
                  backgroundColor: isDark
                    ? theme.colors.surface2
                    : theme.colors.surface1,
                },
              ]}
            >
              <ThinkingDots color={theme.colors.foregroundMuted} />
            </View>
          </View>
        ) : null}
      </ScrollView>

      {showScrollDown ? (
        <View pointerEvents="box-none" style={styles.scrollToBottomWrap}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("scrollToBottomA11y")}
            onPress={() => scrollToBottom(true)}
            style={[
              styles.scrollToBottomBtn,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
              },
            ]}
          >
            <Icon name="ArrowDown" size={16} color={theme.colors.foreground} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});
