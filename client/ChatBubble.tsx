import {
  openExternalUrl,
  useRpc,
  type PluginScreenProps,
} from "@getpaseo/plugin/client";
import { copyText, Icon, Markdown, useToast } from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  executeFeedActionRpc,
  type ChatInlineLink,
  type ChatMessage,
  type FeedAction,
} from "../shared/contracts";
import type { TranslateFn } from "./ConsoleModals";
import { isDarkSurfaceColor } from "./helpers";
import { getSelectedConsoleProvider } from "./store";

type PluginTheme = PluginScreenProps["theme"];

interface WebAnchorLike {
  href?: string;
  getAttribute?(name: string): string | null;
  closest?(selector: string): WebAnchorLike | null;
}

interface WebClickEventLike {
  target?: WebAnchorLike | null;
  preventDefault?(): void;
  stopPropagation?(): void;
}

interface WebContainerLike {
  addEventListener?(
    type: string,
    listener: (ev: WebClickEventLike) => void,
    capture?: boolean,
  ): void;
  removeEventListener?(
    type: string,
    listener: (ev: WebClickEventLike) => void,
    capture?: boolean,
  ): void;
}

const MARKDOWN_SYNTAX_RE =
  /(\*\*|__|`|\]\(|https?:\/\/|paseo:\/\/|^\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s)|\|.+\|)/m;
const INLINE_LINK_SIGNAL_RE = /https?:\/\/|paseo:\/\/|\]\(/i;

function hasMarkdownSyntax(text: string): boolean {
  return MARKDOWN_SYNTAX_RE.test(text);
}

const styles = StyleSheet.create({
  statusRowWrap: {
    alignSelf: "center",
    maxWidth: "88%",
    paddingVertical: 3,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 4,
    borderRadius: 999,
  },
  statusText: {
    fontSize: 12,
    lineHeight: 17,
    textAlign: "center",
    flexShrink: 1,
  },
  userRow: {
    alignSelf: "flex-end",
    alignItems: "flex-end",
    maxWidth: "78%",
    gap: 4,
  },
  userBubbleMax: {
    maxWidth: 520,
  },
  userBubble: {
    paddingVertical: 10,
    paddingHorizontal: 15,
    borderRadius: 20,
    gap: 8,
  },
  userText: {
    fontSize: 14.5,
    lineHeight: 21,
  },
  assistantPlainText: {
    fontSize: 14.5,
    lineHeight: 22,
  },
  userImagesGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  userImageThumbSingle: {
    width: 176,
    height: 124,
    borderRadius: 12,
  },
  userImageThumbMulti: {
    width: 78,
    height: 78,
    borderRadius: 10,
  },
  userImageFallbackChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 10,
  },
  userImageFallbackText: {
    fontSize: 11,
    fontWeight: "600",
  },
  userMetaCaption: {
    fontSize: 11,
    paddingRight: 4,
  },
  assistantOuter: {
    alignSelf: "flex-start",
    maxWidth: "82%",
    gap: 6,
  },
  assistantBubbleMax: {
    maxWidth: 560,
  },
  assistantBubbleRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
  },
  assistantBubble: {
    flexShrink: 1,
    paddingVertical: 11,
    paddingHorizontal: 15,
    borderRadius: 20,
    gap: 8,
  },
  linksWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 12,
    paddingTop: 2,
  },
  inlineLinkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingVertical: 2,
  },
  inlineLinkText: {
    fontSize: 13,
    lineHeight: 19,
    textDecorationLine: "underline",
  },
  sessionJumpText: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "500",
    textDecorationLine: "underline",
  },
  footerMetaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 14,
    paddingTop: 2,
  },
  detailsToggleBtn: {
    paddingVertical: 2,
  },
  detailsToggleText: {
    fontSize: 12,
    fontWeight: "500",
  },
  detailsExpandedBox: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  copyIconBtn: {
    width: 26,
    height: 26,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  quickActionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    paddingLeft: 2,
  },
  quickActionPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  quickActionText: {
    fontSize: 12,
    fontWeight: "600",
  },
  dotsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 999,
  },
});

const WebThinkingDots = memo(function WebThinkingDots({
  color,
}: {
  color: string;
}) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setStep((s) => (s + 1) % 3);
    }, 360);
    return () => clearInterval(timer);
  }, []);

  return (
    <View style={styles.dotsRow}>
      <View
        style={[
          styles.dot,
          { backgroundColor: color, opacity: step === 0 ? 0.9 : 0.32 },
        ]}
      />
      <View
        style={[
          styles.dot,
          { backgroundColor: color, opacity: step === 1 ? 0.9 : 0.32 },
        ]}
      />
      <View
        style={[
          styles.dot,
          { backgroundColor: color, opacity: step === 2 ? 0.9 : 0.32 },
        ]}
      />
    </View>
  );
});

const NativeThinkingDots = memo(function NativeThinkingDots({
  color,
}: {
  color: string;
}) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(anim, {
        toValue: 3,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);

  const op1 = anim.interpolate({
    inputRange: [0, 0.5, 1.5, 3],
    outputRange: [0.3, 0.95, 0.35, 0.3],
  });
  const op2 = anim.interpolate({
    inputRange: [0, 1, 1.5, 2.5, 3],
    outputRange: [0.3, 0.35, 0.95, 0.35, 0.3],
  });
  const op3 = anim.interpolate({
    inputRange: [0, 1.8, 2.4, 3],
    outputRange: [0.3, 0.35, 0.95, 0.3],
  });

  return (
    <View style={styles.dotsRow}>
      <Animated.View style={[styles.dot, { backgroundColor: color, opacity: op1 }]} />
      <Animated.View style={[styles.dot, { backgroundColor: color, opacity: op2 }]} />
      <Animated.View style={[styles.dot, { backgroundColor: color, opacity: op3 }]} />
    </View>
  );
});

export const ThinkingDots = memo(function ThinkingDots({
  color,
}: {
  color: string;
}) {
  if (Platform.OS === "web") {
    return <WebThinkingDots color={color} />;
  }
  return <NativeThinkingDots color={color} />;
});

const BubbleQuickActions = memo(function BubbleQuickActions({
  messageId,
  actions,
  theme,
  t,
  onOpenAgent,
}: {
  messageId: string;
  actions: readonly FeedAction[];
  theme: PluginTheme;
  t: TranslateFn;
  onOpenAgent: (agentId: string) => void;
}) {
  const toast = useToast();
  const executeFeedAction = useRpc(executeFeedActionRpc);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);

  const handleQuickAction = useCallback(
    async (act: FeedAction) => {
      if (act.targetAgentId) {
        onOpenAgent(act.targetAgentId);
        return;
      }
      if (busyActionId || act.executedAt || !messageId) return;
      setBusyActionId(act.id);
      try {
        const res = await executeFeedAction({
          feedId: messageId,
          actionId: act.id,
          fallbackProvider: getSelectedConsoleProvider() || undefined,
        });
        toast.show(res.message, { variant: res.ok ? "success" : "info" });
        if (res.agentId) {
          onOpenAgent(res.agentId);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyActionId(null);
      }
    },
    [busyActionId, executeFeedAction, messageId, onOpenAgent, toast],
  );

  return (
    <View style={styles.quickActionsRow}>
      {actions.map((act) => {
        const done = Boolean(act.executedAt);
        return (
          <Pressable
            key={act.id}
            accessibilityRole="button"
            disabled={done || busyActionId !== null}
            onPress={() => void handleQuickAction(act)}
            style={[
              styles.quickActionPill,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
                opacity: busyActionId === act.id ? 0.6 : 1,
              },
            ]}
          >
            <Icon
              name={
                done
                  ? "Check"
                  : act.targetAgentId
                    ? "ArrowUpRight"
                    : "Sparkles"
              }
              size={11}
              color={done ? theme.colors.statusSuccess : theme.colors.accent}
            />
            <Text
              style={[
                styles.quickActionText,
                {
                  color: done
                    ? theme.colors.foregroundMuted
                    : theme.colors.foreground,
                },
              ]}
            >
              {done ? t("doneActionPrefix", { label: act.label }) : act.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
});

function extractSupplementalLinks(
  text: string,
  explicitLinks: readonly ChatInlineLink[],
): ChatInlineLink[] {
  const extras: ChatInlineLink[] = [];
  const seenUrls = new Set<string>();

  if (Platform.OS !== "web" && INLINE_LINK_SIGNAL_RE.test(text)) {
    const mdRegex = /\[([^\]]+)\]\((paseo:\/\/agent\/[^)\s]+|https?:\/\/[^)\s]+)\)/g;
    let match: RegExpExecArray | null = null;
    while ((match = mdRegex.exec(text)) !== null) {
      const label = match[1].trim();
      const url = match[2].trim();
      if (url && !seenUrls.has(url)) {
        seenUrls.add(url);
        extras.push({
          label,
          url,
          kind: url.startsWith("paseo://agent/") ? "agent" : "external",
        });
      }
    }
  }

  for (const lnk of explicitLinks) {
    const url = lnk.url.trim();
    if (!url || seenUrls.has(url)) continue;
    if (Platform.OS === "web" && text.includes(`(${url})`)) {
      continue;
    }
    seenUrls.add(url);
    extras.push(lnk);
  }

  return extras;
}

export interface ChatBubbleProps {
  message: ChatMessage;
  isLastInGroup: boolean;
  isPendingAck: boolean;
  theme: PluginTheme;
  t: TranslateFn;
  onOpenAgent: (agentId: string) => void;
}

export const ChatBubble = memo(function ChatBubble({
  message,
  isLastInGroup,
  isPendingAck,
  theme,
  t,
  onOpenAgent,
}: ChatBubbleProps) {
  const toast = useToast();
  const bubbleContainerRef = useRef<View>(null);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [tappedCopyVisible, setTappedCopyVisible] = useState(false);

  const isDark = useMemo(
    () => isDarkSurfaceColor(theme.colors.surface0),
    [theme.colors.surface0],
  );

  const hasDistinctDetails = Boolean(
    message.details &&
      message.details.trim().length > 0 &&
      message.details.trim() !== message.text.trim(),
  );
  const fullDetailsReplacesPreview = Boolean(
    hasDistinctDetails &&
      message.details!.trim().startsWith(message.text.trim().slice(0, 42)),
  );
  const visibleMarkdownText =
    detailsOpen && fullDetailsReplacesPreview
      ? message.details!
      : detailsOpen && hasDistinctDetails
        ? `${message.text}\n${message.details!}`
        : message.text;

  const shouldBindWebAnchorCapture = useMemo(
    () =>
      Platform.OS === "web" &&
      message.role === "assistant" &&
      INLINE_LINK_SIGNAL_RE.test(visibleMarkdownText),
    [message.role, visibleMarkdownText],
  );

  const handleNavigateUrl = useCallback(
    (rawUrl: string, kind?: ChatInlineLink["kind"]) => {
      const url = rawUrl.trim();
      if (!url) return;
      if (url.startsWith("paseo://agent/")) {
        const rawId = url.slice("paseo://agent/".length).trim();
        const agentId = rawId ? decodeURIComponent(rawId) : "";
        if (agentId) onOpenAgent(agentId);
        return;
      }
      if (kind === "agent" && !url.includes("://")) {
        onOpenAgent(url);
        return;
      }
      if (/^https?:\/\//i.test(url)) {
        void openExternalUrl(url).catch((err) => {
          toast.error(err instanceof Error ? err.message : String(err));
        });
      }
    },
    [onOpenAgent, toast],
  );

  // Only bind Web DOM click capture when the bubble actually contains link syntax
  useEffect(() => {
    if (!shouldBindWebAnchorCapture) return;
    const el = bubbleContainerRef.current as unknown as WebContainerLike | null;
    if (!el || typeof el.addEventListener !== "function") return;

    const onClickCapture = (ev: WebClickEventLike) => {
      const anchor = ev.target?.closest?.("a");
      if (!anchor) return;
      const href = (anchor.getAttribute?.("href") ?? anchor.href ?? "").trim();
      if (!href) return;
      if (href.startsWith("paseo://agent/") || /^https?:\/\//i.test(href)) {
        ev.preventDefault?.();
        ev.stopPropagation?.();
        handleNavigateUrl(href);
      }
    };

    el.addEventListener("click", onClickCapture, true);
    return () => {
      el.removeEventListener?.("click", onClickCapture, true);
    };
  }, [handleNavigateUrl, shouldBindWebAnchorCapture]);

  const handleCopy = useCallback(() => {
    const fullText =
      message.details && detailsOpen
        ? `${message.text}\n\n${message.details}`
        : message.text;
    void copyText(fullText)
      .then(() => {
        setTappedCopyVisible(false);
        toast.show(t("copiedToast"), { variant: "success" });
      })
      .catch(() => undefined);
  }, [detailsOpen, message.details, message.text, t, toast]);

  const supplementalLinks = useMemo(
    () =>
      message.role === "assistant"
        ? extractSupplementalLinks(message.text, message.links ?? [])
        : [],
    [message.links, message.role, message.text],
  );

  const cleanAgentId =
    message.role === "assistant" ? (message.agentId?.trim() ?? "") : "";
  const isAckOrThinking =
    message.kind === "ack" || message.status === "thinking";
  const targetAgentUri = cleanAgentId ? `paseo://agent/${cleanAgentId}` : "";
  const alreadyLinkedInSupplemental = Boolean(
    cleanAgentId &&
      supplementalLinks.some((lnk) => {
        const u = lnk.url.trim();
        return u === targetAgentUri || (lnk.kind === "agent" && u === cleanAgentId);
      }),
  );
  const alreadyLinkedInlineOnWeb = Boolean(
    Platform.OS === "web" &&
      targetAgentUri &&
      visibleMarkdownText.includes(`(${targetAgentUri})`),
  );
  const needsSessionJumpFallback =
    message.kind === "proactive" || hasDistinctDetails;
  const showDirectSessionLink = Boolean(
    cleanAgentId &&
      !isAckOrThinking &&
      needsSessionJumpFallback &&
      !alreadyLinkedInSupplemental &&
      !alreadyLinkedInlineOnWeb,
  );
  const hasAnyRenderedAgentLink =
    showDirectSessionLink || alreadyLinkedInSupplemental || alreadyLinkedInlineOnWeb;

  const restrainedQuickActions = useMemo(() => {
    if (message.role !== "assistant") return [];
    const raw = message.quickActions ?? [];
    if (raw.length === 0) return [];
    return raw
      .filter((a) => {
        if (a.kind === "snooze") return false;
        if (
          hasAnyRenderedAgentLink &&
          cleanAgentId &&
          a.targetAgentId?.trim() === cleanAgentId
        ) {
          return false;
        }
        return true;
      })
      .slice(0, 2);
  }, [cleanAgentId, hasAnyRenderedAgentLink, message.quickActions, message.role]);

  const useMarkdownForPrimaryText = useMemo(
    () =>
      message.role === "assistant" &&
      ((detailsOpen && fullDetailsReplacesPreview) || hasMarkdownSyntax(message.text)),
    [detailsOpen, fullDetailsReplacesPreview, message.role, message.text],
  );

  // 1. Quiet system / memory update / status note row
  if (
    message.role === "system" ||
    message.kind === "memory_update" ||
    message.kind === "status_note"
  ) {
    const iconName = message.kind === "memory_update" ? "Sparkles" : "Check";
    return (
      <View style={styles.statusRowWrap}>
        <View style={[styles.statusPill, { backgroundColor: theme.colors.surface1 }]}>
          <Icon name={iconName} size={11} color={theme.colors.foregroundMuted} />
          <Text style={[styles.statusText, { color: theme.colors.foregroundMuted }]}>
            {message.text}
          </Text>
        </View>
      </View>
    );
  }

  // 2. Right-aligned User Bubble (Dot vibrant blue capsule)
  if (message.role === "user") {
    const images = message.images ?? [];
    const hideFallbackImageText =
      images.length > 0 && /^\[附\s*\d+\s*张图片\]$/.test(message.text.trim());

    return (
      <View style={[styles.userRow, styles.userBubbleMax]}>
        <View
          style={[
            styles.userBubble,
            {
              backgroundColor: theme.colors.accent,
              borderBottomRightRadius: isLastInGroup ? 6 : 20,
            },
          ]}
        >
          {images.length > 0 ? (
            <View style={styles.userImagesGrid}>
              {images.map((img, idx) =>
                img.previewUri ? (
                  <Image
                    key={`${message.id}_img_${idx}`}
                    source={{ uri: img.previewUri }}
                    accessibilityLabel={img.name || t("bubbleImageLabel", { index: idx + 1 })}
                    style={
                      images.length === 1
                        ? styles.userImageThumbSingle
                        : styles.userImageThumbMulti
                    }
                    resizeMode="cover"
                  />
                ) : (
                  <View
                    key={`${message.id}_img_${idx}`}
                    style={[
                      styles.userImageFallbackChip,
                      { backgroundColor: theme.colors.surface0 },
                    ]}
                  >
                    <Icon name="Image" size={12} color={theme.colors.accent} />
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.userImageFallbackText,
                        { color: theme.colors.foreground },
                      ]}
                    >
                      {img.name || t("bubbleImageLabel", { index: idx + 1 })}
                    </Text>
                  </View>
                ),
              )}
            </View>
          ) : null}

          {!hideFallbackImageText && message.text.trim().length > 0 ? (
            <Text
              selectable
              style={[styles.userText, { color: theme.colors.accentForeground }]}
            >
              {message.text}
            </Text>
          ) : null}
        </View>

        {message.status === "sending" ? (
          <Text style={[styles.userMetaCaption, { color: theme.colors.foregroundMuted }]}>
            {t("bubbleSending")}
          </Text>
        ) : message.status === "error" ? (
          <Text style={[styles.userMetaCaption, { color: theme.colors.statusDanger }]}>
            {t("bubbleSendError")}
          </Text>
        ) : null}
      </View>
    );
  }

  // 3. Left-aligned Butler Bubble (fast plain-text path when no Markdown syntax)
  const bubbleBg = isDark ? theme.colors.surface2 : theme.colors.surface1;
  const needsSubtleBorder = bubbleBg === theme.colors.surface0;
  const showThinkingDots =
    message.status === "thinking" && (message.kind !== "ack" || isPendingAck);
  const showCopyAffordance = hovered || tappedCopyVisible;
  const trimmedText = message.text.trim();

  return (
    <View
      style={[styles.assistantOuter, styles.assistantBubbleMax]}
      // @ts-expect-error React Native Web supports pointer hover events on View/Pressable
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <View style={styles.assistantBubbleRow}>
        <Pressable
          ref={bubbleContainerRef}
          onLongPress={handleCopy}
          onPress={() => {
            if (Platform.OS !== "web") {
              setTappedCopyVisible((v) => !v);
            }
          }}
          style={[
            styles.assistantBubble,
            {
              backgroundColor: bubbleBg,
              borderBottomLeftRadius: isLastInGroup ? 6 : 20,
              borderWidth: needsSubtleBorder ? 1 : 0,
              borderColor: theme.colors.border,
            },
          ]}
        >
          {trimmedText.length > 0 ? (
            useMarkdownForPrimaryText ? (
              <Markdown>
                {detailsOpen && fullDetailsReplacesPreview
                  ? message.details!
                  : message.text}
              </Markdown>
            ) : (
              <Text
                selectable
                style={[
                  styles.assistantPlainText,
                  { color: theme.colors.foreground },
                ]}
              >
                {message.text}
              </Text>
            )
          ) : null}

          {detailsOpen && hasDistinctDetails && !fullDetailsReplacesPreview ? (
            <View
              style={[
                styles.detailsExpandedBox,
                { borderTopColor: theme.colors.border },
              ]}
            >
              <Markdown>{message.details!}</Markdown>
            </View>
          ) : null}

          {supplementalLinks.length > 0 ? (
            <View style={styles.linksWrap}>
              {supplementalLinks.map((lnk) => {
                const isAgentLink =
                  lnk.kind === "agent" || lnk.url.trim().startsWith("paseo://agent/");
                const linkColor = isAgentLink
                  ? theme.colors.accent
                  : theme.colors.foreground;
                return (
                  <Pressable
                    key={`${lnk.url}_${lnk.label}`}
                    accessibilityRole="link"
                    onPress={() => handleNavigateUrl(lnk.url, lnk.kind)}
                    style={styles.inlineLinkRow}
                  >
                    <Text
                      style={[
                        isAgentLink ? styles.sessionJumpText : styles.inlineLinkText,
                        { color: linkColor },
                      ]}
                    >
                      {lnk.label}
                    </Text>
                    {isAgentLink ? (
                      <Icon name="ArrowUpRight" size={12} color={linkColor} />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          {hasDistinctDetails || showDirectSessionLink ? (
            <View style={styles.footerMetaRow}>
              {hasDistinctDetails ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setDetailsOpen((v) => !v)}
                  style={styles.detailsToggleBtn}
                >
                  <Text
                    style={[
                      styles.detailsToggleText,
                      { color: theme.colors.foregroundMuted },
                    ]}
                  >
                    {detailsOpen
                      ? t("bubbleCollapseDetails")
                      : t("bubbleExpandDetails")}
                  </Text>
                </Pressable>
              ) : null}

              {showDirectSessionLink ? (
                <Pressable
                  accessibilityRole="link"
                  onPress={() => onOpenAgent(cleanAgentId)}
                  style={styles.inlineLinkRow}
                >
                  <Text
                    style={[styles.sessionJumpText, { color: theme.colors.accent }]}
                  >
                    {t("bubbleOpenSession")}
                  </Text>
                  <Icon name="ArrowUpRight" size={12} color={theme.colors.accent} />
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {showThinkingDots ? (
            <ThinkingDots color={theme.colors.foregroundMuted} />
          ) : null}
        </Pressable>

        {showCopyAffordance && trimmedText.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("bubbleCopyA11y")}
            onPress={handleCopy}
            style={[styles.copyIconBtn, { backgroundColor: theme.colors.surface1 }]}
          >
            <Icon name="Copy" size={12} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>

      {restrainedQuickActions.length > 0 ? (
        <BubbleQuickActions
          messageId={message.id}
          actions={restrainedQuickActions}
          theme={theme}
          t={t}
          onOpenAgent={onOpenAgent}
        />
      ) : null}
    </View>
  );
});
