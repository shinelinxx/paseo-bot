import {
  useRpc,
  useSettings,
  useTranslation,
  type PluginScreenProps,
} from "@getpaseo/plugin/client";
import {
  copyText,
  Icon,
  Markdown,
  ScrollView,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import {
  MAX_ATTACHED_IMAGES,
  curateFeedRpc,
  deleteTriggerRpc,
  dismissSuggestionRpc,
  ensureChiefBotRpc,
  executeFeedActionRpc,
  installPresetRpc,
  listModelsRpc,
  manageNativeScheduleRpc,
  manageWorkerRpc,
  markFeedReadRpc,
  resolveApprovalRpc,
  runTriggerNowRpc,
  setGlobalPauseRpc,
  submitWishRpc,
  tidySessionsRpc,
  toggleTriggerRpc,
  upsertNativeScheduleRpc,
  upsertTriggerRpc,
  type ApprovalItem,
  type ApprovalRisk,
  type CatalogProvider,
  type DelegatedWorker,
  type FeedAction,
  type FeedItem,
  type GovernanceLevel,
  type NativeScheduleItem,
  type PresetId,
  type RoutineSuggestion,
  type TriggerKind,
  type TriggerSpec,
  type WorkerStatus,
} from "../shared/contracts";
import { paseoBotSettings } from "../shared/settings";
import {
  CreateOrEditMissionModal,
  isPresetAlreadyEnabled,
  MemoryEditorModal,
  ModelPickerModal,
  PRESET_DEFINITIONS,
  resolveModelLabel,
  type TranslateFn,
} from "./ConsoleModals";
import {
  formatElapsedDuration,
  formatShortTime,
  formatSmartTime,
  isModifierSubmitKey,
  isSameLocalDay,
  minutesUntilTomorrowMorning,
  shortenPathForDisplay,
  type RelativeTimeLabels,
} from "./helpers";
import { messages } from "./i18n";
import {
  appendWishDraftImages,
  clearWishDraftImages,
  confirmOptimisticWishFeed,
  consumeRequestedConsoleTab,
  consumeRequestedInboxFilter,
  getSelectedConsoleProvider,
  getWishDraft,
  getWishDraftImages,
  isFeedItemNeedsAttention,
  optimisticAddWishFeed,
  optimisticCurateFeed,
  optimisticDeleteTrigger,
  optimisticDismissSuggestion,
  optimisticExecuteFeedAction,
  optimisticManageNativeSchedule,
  optimisticMarkFeedRead,
  optimisticRemoveWorker,
  optimisticResolveApproval,
  optimisticSetGlobalPaused,
  optimisticSnoozeFeed,
  optimisticToggleTrigger,
  removeWishDraftImage,
  rollbackOptimisticWishFeed,
  setSelectedConsoleProvider,
  setWishDraft,
  setWishDraftImages,
  useBotSelector,
  useFullBotSync,
  useSelectedConsoleProvider,
  useWishDraft,
  useWishDraftImages,
  type BotConsoleTab,
  type BotInboxFilterMode,
  type DraftImageAttachment,
} from "./store";
import {
  isWebImageInputSupported,
  mountWebImagePasteTarget,
  pickWebImages,
  type ImageInputErrorReason,
  type PastedImageItem,
} from "./web";

type PluginTheme = PluginScreenProps["theme"];

const KIND_LABEL_KEYS: Record<
  TriggerKind,
  | "kind_file_watch"
  | "kind_poll_command"
  | "kind_webhook"
  | "kind_schedule"
  | "kind_self_wake"
> = {
  file_watch: "kind_file_watch",
  poll_command: "kind_poll_command",
  webhook: "kind_webhook",
  schedule: "kind_schedule",
  self_wake: "kind_self_wake",
};

const GOV_LABEL_KEYS: Record<
  GovernanceLevel,
  "gov_autonomous" | "gov_notify" | "gov_require_approval"
> = {
  autonomous: "gov_autonomous",
  notify: "gov_notify",
  require_approval: "gov_require_approval",
};

const RISK_LABEL_KEYS: Record<ApprovalRisk, "risk_low" | "risk_medium" | "risk_high"> = {
  low: "risk_low",
  medium: "risk_medium",
  high: "risk_high",
};

const WORKER_LABEL_KEYS: Record<
  WorkerStatus,
  | "worker_running"
  | "worker_completed"
  | "worker_permission"
  | "worker_failed"
  | "worker_archived"
> = {
  running: "worker_running",
  completed: "worker_completed",
  permission: "worker_permission",
  failed: "worker_failed",
  archived: "worker_archived",
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { maxWidth: 1080, width: "100%", alignSelf: "center" },
  card16: { borderRadius: 16, borderWidth: 1, gap: 12 },
  card14: { padding: 14, borderRadius: 14, borderWidth: 1, gap: 9 },
  card14Padded: { padding: 16, borderRadius: 14, borderWidth: 1, gap: 10 },
  card12: { padding: 14, borderRadius: 12, borderWidth: 1, gap: 9 },
  cardWorker: { padding: 14, borderRadius: 12, borderWidth: 1, gap: 6 },
  insetBox: { padding: 11, borderRadius: 10, borderWidth: 1, gap: 8 },
  emptyBox: { padding: 28, borderRadius: 14, borderWidth: 1, alignItems: "center" },
  emptyBoxCompact: { paddingVertical: 14, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1 },
  rowCenterBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  rowCenterGap6: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowCenterGap8: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowCenterGap10: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowWrapGap8: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  rowWrapGap6: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  rowGap8: { flexDirection: "row", gap: 8 },
  colGap6: { gap: 6 },
  colGap8: { gap: 8 },
  colGap10: { gap: 10 },
  colGap12: { gap: 12 },
  colGap14: { gap: 14 },
  colGap16: { gap: 16 },
  flex1: { flex: 1 },
  flex1Gap2: { flex: 1, gap: 2 },
  heroIconBox: {
    width: 36,
    height: 36,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  unreadDotBtn: {
    padding: 3,
    marginLeft: -3,
  },
  unreadDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  statusSwitchPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  pillBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  pillBadgeText: { fontSize: 11, fontWeight: "700" },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 9,
    borderWidth: 1,
  },
  quickPokeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  composerBox: {
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
  },
  imageStripRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 9,
    paddingTop: 4,
  },
  imageThumbWrap: {
    position: "relative",
    width: 56,
    height: 56,
  },
  imageThumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    borderWidth: 1,
  },
  imageThumbRemoveBtn: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 18,
    height: 18,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  dropHintBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  attachImageBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  wishMultilineInput: {
    paddingHorizontal: 13,
    paddingTop: 11,
    paddingBottom: 8,
    fontSize: 14,
    lineHeight: 20,
  },
  composerToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  modelPickerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: 240,
  },
  wishSubmitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 15,
    paddingVertical: 7,
    borderRadius: 8,
  },
  inlineComposerBox: {
    borderWidth: 1,
    borderRadius: 10,
    overflow: "hidden",
  },
  inlineMultilineInput: {
    paddingHorizontal: 11,
    paddingTop: 9,
    paddingBottom: 6,
    fontSize: 13,
    lineHeight: 19,
  },
  inlineComposerFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cardFooterDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  tabScroll: { flexGrow: 0 },
  tabChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  tabBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 4,
    minWidth: 180,
    flex: 1,
    maxWidth: 280,
  },
  searchInput: {
    flex: 1,
    fontSize: 12,
    paddingVertical: 2,
  },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  loadMoreBtn: {
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  smallBorderBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  moreIconBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  smallBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 7 },
  smallBtnPad6: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  smallIconBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  microActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  stagingTextarea: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    minHeight: 88,
    fontSize: 12,
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 2,
  },
  approveBtn: {
    flex: 1,
    minWidth: 120,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 9,
  },
  rejectBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 9,
    borderWidth: 1,
  },
  resolvedRow: {
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  ruleSwitchTrack: {
    width: 36,
    height: 20,
    borderRadius: 999,
    paddingHorizontal: 2,
    justifyContent: "center",
    borderWidth: 1,
  },
  ruleSwitchThumb: {
    width: 14,
    height: 14,
    borderRadius: 999,
  },
  presetRow: { justifyContent: "space-between", gap: 8, padding: 10, borderRadius: 10 },
  presetBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  newMissionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  sectionHeader: { fontSize: 12, fontWeight: "700", letterSpacing: 0.3 },
  title14: { fontSize: 14, fontWeight: "700" },
  title15: { fontSize: 15, fontWeight: "700" },
  text13: { fontSize: 13 },
  text13Center: { fontSize: 13, textAlign: "center" },
  text12: { fontSize: 12 },
  text12Semi: { fontSize: 12, fontWeight: "600" },
  text12Bold: { fontSize: 12, fontWeight: "700" },
  text11: { fontSize: 11 },
  text11Bold: { fontSize: 11, fontWeight: "700" },
  text13Semi: { fontSize: 13, fontWeight: "600" },
  text13Bold: { fontSize: 13, fontWeight: "700" },
});

const RuleSwitch = memo(function RuleSwitch({
  enabled,
  theme,
  onToggle,
}: {
  enabled: boolean;
  theme: PluginTheme;
  onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: enabled }}
      onPress={onToggle}
      style={[
        styles.ruleSwitchTrack,
        {
          backgroundColor: enabled ? theme.colors.accent : theme.colors.surface2,
          borderColor: enabled ? theme.colors.accent : theme.colors.border,
          alignItems: enabled ? "flex-end" : "flex-start",
        },
      ]}
    >
      <View
        style={[
          styles.ruleSwitchThumb,
          {
            backgroundColor: enabled
              ? theme.colors.accentForeground
              : theme.colors.foregroundMuted,
          },
        ]}
      />
    </Pressable>
  );
});

const LiveElapsedBadge = memo(function LiveElapsedBadge({
  startIso,
  variant,
  t,
  prefix,
  color,
  backgroundColor,
}: {
  startIso: string;
  variant: "pill" | "inline";
  t?: TranslateFn;
  prefix?: string;
  color: string;
  backgroundColor?: string;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => clearInterval(timer);
  }, [startIso]);

  const elapsed = formatElapsedDuration(startIso, nowMs);

  if (variant === "pill") {
    return (
      <View style={[styles.pillBadge, { backgroundColor }]}>
        <Text style={[styles.text11Bold, { color }]}>
          {elapsed && t
            ? t("inProgressElapsed", { elapsed })
            : t
              ? t("inProgressBadge")
              : elapsed}
        </Text>
      </View>
    );
  }

  return (
    <Text style={[styles.text11Bold, { color }]}>
      {prefix}
      {elapsed ? ` · ${elapsed}` : ""}
    </Text>
  );
});

function useRelativeTimeLabels(t: TranslateFn): RelativeTimeLabels {
  return useMemo(
    () => ({
      justNow: t("timeJustNow"),
      minsAgo: (count: number) => t("timeMinsAgo", { count }),
      todayAt: (time: string) => t("timeTodayAt", { time }),
      yesterdayAt: (time: string) => t("timeYesterdayAt", { time }),
    }),
    [t],
  );
}

function formatNativeCadence(raw: string): string {
  const trimmed = raw.trim();
  const everyMatch = /^every:(\d+)\s*([smhd])$/i.exec(trimmed);
  if (everyMatch) {
    const val = everyMatch[1];
    const unit = everyMatch[2].toLowerCase();
    if (unit === "h") return `每 ${val} 小时`;
    if (unit === "m") return `每 ${val} 分钟`;
    if (unit === "d") return `每 ${val} 天`;
    return `每 ${val} 秒`;
  }
  const cronMatch = /^cron:([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)(?:\s*\(([^)]+)\))?/.exec(
    trimmed,
  );
  if (!cronMatch) return raw;
  const [, min, hour, dom, mon, dow] = cronMatch;
  if (dom === "*" && mon === "*" && dow === "*") {
    if (/^\d+$/.test(min) && /^\*\/(\d+)$/.test(hour)) {
      const step = hour.slice(2);
      return min === "0" ? `每 ${step} 小时` : `每 ${step} 小时（:${min.padStart(2, "0")}）`;
    }
    if (/^\d+$/.test(min) && /^\d+(?:,\d+)*$/.test(hour)) {
      const times = hour
        .split(",")
        .map((h) => `${h.padStart(2, "0")}:${min.padStart(2, "0")}`)
        .join("、");
      return `每天 ${times}`;
    }
  }
  return raw.replace(/^cron:/, "Cron ");
}

function describeMissionCadence(trg: TriggerSpec, t: TranslateFn): string {
  if (trg.kind === "file_watch") {
    return `${t("kind_file_watch")} · ${shortenPathForDisplay(trg.watchPath || trg.cwd)}`;
  }
  if (trg.kind === "webhook") {
    return t("kind_webhook");
  }
  if (trg.kind === "poll_command") {
    return `${t("kind_poll_command")} (${trg.pollIntervalSec}s) · ${trg.pollCommand || ""}`;
  }
  if (trg.onceAt) {
    return `${t("kind_self_wake")} · ${formatShortTime(trg.onceAt)}`;
  }
  if (trg.dailyTime) {
    return `${trg.dailyTime} · ${t("kind_schedule")}`;
  }
  const mins = Math.max(1, Math.round(trg.pollIntervalSec / 60));
  return `${mins} min · ${t("kind_schedule")}`;
}

const ComposerImageStrip = memo(function ComposerImageStrip({
  images,
  theme,
  t,
  onRemove,
}: {
  images: readonly DraftImageAttachment[];
  theme: PluginTheme;
  t: TranslateFn;
  onRemove: (id: string) => void;
}) {
  if (images.length === 0) return null;
  return (
    <View style={styles.imageStripRow}>
      {images.map((img) => (
        <View key={img.id} style={styles.imageThumbWrap}>
          <Image
            source={{ uri: img.previewUri }}
            accessibilityLabel={img.name || t("attachImage")}
            style={[
              styles.imageThumb,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
            resizeMode="cover"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("removeImageA11y")}
            onPress={() => onRemove(img.id)}
            style={[
              styles.imageThumbRemoveBtn,
              {
                backgroundColor: theme.colors.surface1,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <Icon name="X" size={10} color={theme.colors.foreground} />
          </Pressable>
        </View>
      ))}
    </View>
  );
});

function formatImageErrorToast(reason: ImageInputErrorReason, t: TranslateFn): string {
  if (reason === "too_large") return t("imageTooLargeToast");
  if (reason === "unsupported") return t("imageUnsupportedToast");
  return t("imageReadFailedToast");
}

const WishHeroBar = memo(function WishHeroBar({
  theme,
  compact,
  defaultProvider,
  modelProviders,
  showChiefChatBtn,
  t,
  onOpenAgent,
  onOpenModelPicker,
  onTaskQueued,
  onJumpApprovals,
}: {
  theme: PluginTheme;
  compact: boolean;
  defaultProvider: string;
  modelProviders: readonly CatalogProvider[];
  showChiefChatBtn: boolean;
  t: TranslateFn;
  onOpenAgent: (agentId: string) => void;
  onOpenModelPicker: () => void;
  onTaskQueued: () => void;
  onJumpApprovals: () => void;
}) {
  const toast = useToast();
  const submitWish = useRpc(submitWishRpc);
  const ensureChief = useRpc(ensureChiefBotRpc);
  const setGlobalPause = useRpc(setGlobalPauseRpc);
  const tidySessions = useRpc(tidySessionsRpc);

  const selectedProvider = useSelectedConsoleProvider();
  const wishText = useWishDraft();
  const wishImages = useWishDraftImages();
  const webImageInputSupported = useMemo(() => isWebImageInputSupported(), []);

  const hero = useBotSelector((s) => {
    let activeMissionCount = 0;
    for (const m of s.triggers) if (m.enabled) activeMissionCount += 1;
    for (const ns of s.nativeSchedules ?? []) if (ns.status === "active") activeMissionCount += 1;
    let hasVisibleFeed = false;
    for (const f of s.feed) {
      if (f.level !== "silent") {
        hasVisibleFeed = true;
        break;
      }
    }
    return {
      globalPaused: s.globalPaused,
      activeMissionCount,
      pendingApprovalCount: s.pendingApprovalCount,
      totalSilentChecks: s.totalSilentChecks ?? 0,
      runningWorkerCount: s.runningWorkerCount,
      hourlyWakesUsed: s.hourlyWakesUsed,
      hourlyWakeLimit: s.hourlyWakeLimit,
      isInboxEmpty: !hasVisibleFeed && s.pendingApprovalCount === 0,
    };
  });

  const minComposerHeight = compact ? 64 : 74;
  const maxComposerHeight = 200;

  const [composerHeight, setComposerHeight] = useState(minComposerHeight);
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerDragging, setComposerDragging] = useState(false);
  const [openingChief, setOpeningChief] = useState(false);
  const [tidyingSessions, setTidyingSessions] = useState(false);
  const composerBoxRef = useRef<View>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleAddWishImages = useCallback(
    (incoming: PastedImageItem[]) => {
      if (incoming.length === 0) return;
      const { truncated } = appendWishDraftImages(incoming);
      if (truncated) {
        toast.show(t("imageLimitToast", { max: MAX_ATTACHED_IMAGES }), {
          variant: "warning",
        });
      }
    },
    [t, toast],
  );

  const handleImageInputError = useCallback(
    (reason: ImageInputErrorReason) => {
      toast.show(formatImageErrorToast(reason, t), { variant: "warning" });
    },
    [t, toast],
  );

  const handlePickWishImages = useCallback(async () => {
    const picked = await pickWebImages(handleImageInputError);
    handleAddWishImages(picked);
  }, [handleAddWishImages, handleImageInputError]);

  useEffect(() => {
    if (!webImageInputSupported) return;
    return mountWebImagePasteTarget({
      container: composerBoxRef.current,
      captureWindowPaste: true,
      onImages: handleAddWishImages,
      onError: handleImageInputError,
      onDragActiveChange: setComposerDragging,
    });
  }, [handleAddWishImages, handleImageInputError, webImageInputSupported]);

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current);
      }
    };
  }, []);

  const handleComposerFocus = useCallback(() => {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
    setComposerFocused(true);
  }, []);

  const handleComposerBlur = useCallback(() => {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
    }
    blurTimerRef.current = setTimeout(() => {
      blurTimerRef.current = null;
      setComposerFocused(false);
    }, 180);
  }, []);

  const activeModelLabel = useMemo(() => {
    const effective = selectedProvider || defaultProvider;
    const readable = resolveModelLabel(effective, modelProviders);
    if (!selectedProvider) {
      return readable ? `${t("modelPickerDefault")} · ${readable}` : t("modelPickerDefault");
    }
    return readable || selectedProvider;
  }, [defaultProvider, modelProviders, selectedProvider, t]);

  const dispatchWishText = useCallback(
    async (
      rawText: string,
      clearDraftImmediately: boolean,
      attachedImages: readonly DraftImageAttachment[] = [],
    ) => {
      const trimmed = rawText.trim();
      const imagesSnapshot = [...attachedImages];
      if (!trimmed && imagesSnapshot.length === 0) return;
      if (clearDraftImmediately) {
        setWishDraft("");
        clearWishDraftImages();
        setComposerHeight(minComposerHeight);
      }
      setComposerFocused(false);
      const optimisticId = optimisticAddWishFeed(trimmed, imagesSnapshot.length);
      onTaskQueued();
      try {
        const res = await submitWish({
          wish: trimmed,
          images:
            imagesSnapshot.length > 0
              ? imagesSnapshot.map(({ data, mimeType, name }) => ({
                  data,
                  mimeType,
                  ...(name ? { name } : {}),
                }))
              : undefined,
          provider: selectedProvider || undefined,
          asyncLaunch: true,
        });
        confirmOptimisticWishFeed(optimisticId, res.feedId);
        const usedModelLabel = resolveModelLabel(res.modelUsed, modelProviders);
        if (res.reusedSession && res.sessionTitle) {
          toast.show(
            usedModelLabel
              ? t("wishReusedSessionWithModelToast", {
                  title: res.sessionTitle,
                  model: usedModelLabel,
                })
              : t("wishReusedSessionToast", { title: res.sessionTitle }),
            { variant: "success" },
          );
        } else if (usedModelLabel) {
          toast.show(t("wishSentWithModelToast", { model: usedModelLabel }), {
            variant: "success",
          });
        } else {
          toast.show(t("wishSentToast"), { variant: "success" });
        }
      } catch (err) {
        rollbackOptimisticWishFeed(optimisticId);
        if (clearDraftImmediately) {
          if (trimmed && !getWishDraft().trim()) {
            setWishDraft(trimmed);
          }
          if (imagesSnapshot.length > 0 && getWishDraftImages().length === 0) {
            setWishDraftImages(imagesSnapshot);
          }
        }
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [
      minComposerHeight,
      modelProviders,
      onTaskQueued,
      selectedProvider,
      submitWish,
      t,
      toast,
    ],
  );

  const handleSendWish = useCallback(async () => {
    await dispatchWishText(wishText, true, wishImages);
  }, [dispatchWishText, wishImages, wishText]);

  const handleOpenChief = useCallback(async () => {
    if (openingChief) return;
    setOpeningChief(true);
    try {
      const res = await ensureChief({ provider: selectedProvider || undefined });
      onOpenAgent(res.agentId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningChief(false);
    }
  }, [ensureChief, onOpenAgent, openingChief, selectedProvider, toast]);

  const handleQuickTidy = useCallback(async () => {
    if (tidyingSessions) return;
    setTidyingSessions(true);
    setComposerFocused(false);
    try {
      const res = await tidySessions({ mode: "preview" });
      if (res.actionCount === 0) {
        toast.show(t("tidyCleanToast"), { variant: "info" });
      } else {
        toast.show(t("tidyStagedToast", { count: res.actionCount }), {
          variant: "success",
        });
        if (res.approvalId) {
          onJumpApprovals();
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setTidyingSessions(false);
    }
  }, [onJumpApprovals, t, tidySessions, tidyingSessions, toast]);

  const handleToggleGlobalPause = useCallback(async () => {
    const next = !hero.globalPaused;
    optimisticSetGlobalPaused(next);
    try {
      await setGlobalPause({ paused: next });
    } catch (err) {
      optimisticSetGlobalPaused(!next);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [hero.globalPaused, setGlobalPause, toast]);

  const wakeRatio = Math.min(1, hero.hourlyWakesUsed / Math.max(1, hero.hourlyWakeLimit));

  const ambientStatus = useMemo(() => {
    let base: string;
    if (hero.globalPaused) {
      base = t("ambientPaused");
    } else if (hero.pendingApprovalCount > 0) {
      base = t("ambientPending", {
        active: hero.activeMissionCount,
        pending: hero.pendingApprovalCount,
      });
    } else if (hero.activeMissionCount > 0) {
      base = t("ambientCalm", {
        active: hero.activeMissionCount,
        silent: hero.totalSilentChecks,
      });
    } else {
      base = t("ambientIdle");
    }

    if (hero.runningWorkerCount > 0) {
      base += t("runningWorkersSuffix", { count: hero.runningWorkerCount });
    }
    if (wakeRatio >= 0.7) {
      base += t("wakeQuotaSuffix", {
        used: hero.hourlyWakesUsed,
        limit: hero.hourlyWakeLimit,
      });
    }
    return base;
  }, [
    hero.activeMissionCount,
    hero.globalPaused,
    hero.hourlyWakeLimit,
    hero.hourlyWakesUsed,
    hero.pendingApprovalCount,
    hero.runningWorkerCount,
    hero.totalSilentChecks,
    t,
    wakeRatio,
  ]);

  const canSubmit = wishText.trim().length > 0 || wishImages.length > 0;
  const showQuickPokes = composerFocused || canSubmit || hero.isInboxEmpty;

  return (
    <View
      style={[
        styles.card16,
        {
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          padding: compact ? 14 : 18,
        },
      ]}
    >
      <View style={styles.rowCenterBetween}>
        <View style={[styles.rowCenterGap10, styles.flex1]}>
          <View style={[styles.heroIconBox, { backgroundColor: theme.colors.accent }]}>
            <Icon name="Bot" size={18} color={theme.colors.accentForeground} />
          </View>
          <View style={styles.flex1Gap2}>
            <View style={styles.rowWrapGap8}>
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: compact ? 17 : 19,
                  fontWeight: "700",
                }}
              >
                Paseo Bot
              </Text>
              <Pressable
                accessibilityRole="switch"
                accessibilityState={{ checked: !hero.globalPaused }}
                accessibilityLabel={t("statusToggleHint")}
                onPress={() => void handleToggleGlobalPause()}
                style={[
                  styles.statusSwitchPill,
                  {
                    backgroundColor: theme.colors.surface2,
                    borderColor: hero.globalPaused
                      ? theme.colors.statusWarning
                      : theme.colors.border,
                  },
                ]}
              >
                {hero.globalPaused ? (
                  <Icon name="Play" size={10} color={theme.colors.statusWarning} />
                ) : (
                  <View
                    style={[
                      styles.statusDot,
                      { backgroundColor: theme.colors.statusSuccess },
                    ]}
                  />
                )}
                <Text
                  style={[
                    styles.pillBadgeText,
                    {
                      color: hero.globalPaused
                        ? theme.colors.statusWarning
                        : theme.colors.statusSuccess,
                    },
                  ]}
                >
                  {hero.globalPaused ? t("statusPaused") : t("statusActive")}
                </Text>
              </Pressable>
            </View>
            {hero.pendingApprovalCount > 0 ? (
              <Pressable accessibilityRole="button" onPress={onJumpApprovals}>
                <Text style={[styles.text12, { color: theme.colors.statusWarning }]}>
                  {ambientStatus}
                </Text>
              </Pressable>
            ) : (
              <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                {ambientStatus}
              </Text>
            )}
          </View>
        </View>

        {showChiefChatBtn ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void handleOpenChief()}
            style={[
              styles.actionBtn,
              {
                backgroundColor: theme.colors.surface2,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <Icon name="MessageSquare" size={14} color={theme.colors.foreground} />
            <Text style={[styles.text12Semi, { color: theme.colors.foreground }]}>
              {t("openChiefChat")}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View
        ref={composerBoxRef}
        style={[
          styles.composerBox,
          {
            borderColor:
              composerFocused || composerDragging ? theme.colors.accent : theme.colors.border,
            backgroundColor: theme.colors.surface0,
          },
        ]}
      >
        <TextInput
          value={wishText}
          onChangeText={(txt) => {
            setWishDraft(txt);
            if (!txt) setComposerHeight(minComposerHeight);
          }}
          onFocus={handleComposerFocus}
          onBlur={handleComposerBlur}
          onKeyPress={(e) => {
            if (isModifierSubmitKey(e)) {
              void handleSendWish();
            }
          }}
          onContentSizeChange={(e) => {
            const nextH = e.nativeEvent?.contentSize?.height;
            if (typeof nextH === "number" && Number.isFinite(nextH)) {
              setComposerHeight(
                Math.max(minComposerHeight, Math.min(maxComposerHeight, Math.ceil(nextH + 14))),
              );
            }
          }}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
          placeholder={t("wishPlaceholder")}
          placeholderTextColor={theme.colors.foregroundMuted}
          style={[
            styles.wishMultilineInput,
            {
              minHeight: minComposerHeight,
              height: composerHeight,
              maxHeight: maxComposerHeight,
              color: theme.colors.foreground,
            },
          ]}
        />

        <ComposerImageStrip
          images={wishImages}
          theme={theme}
          t={t}
          onRemove={removeWishDraftImage}
        />

        {composerDragging ? (
          <View
            style={[
              styles.dropHintBanner,
              {
                borderTopColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <Icon name="Image" size={13} color={theme.colors.accent} />
            <Text style={[styles.text11Bold, { color: theme.colors.accent }]}>
              {t("dropImagesHint")}
            </Text>
          </View>
        ) : null}

        <View
          style={[
            styles.composerToolbar,
            {
              borderTopColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
            },
          ]}
        >
          <View style={styles.rowWrapGap6}>
            <Pressable
              accessibilityRole="button"
              onPress={onOpenModelPicker}
              style={[
                styles.modelPickerBtn,
                {
                  borderColor: selectedProvider ? theme.colors.accent : theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                },
              ]}
            >
              <Icon
                name="Cpu"
                size={13}
                color={selectedProvider ? theme.colors.accent : theme.colors.foregroundMuted}
              />
              <Text
                numberOfLines={1}
                style={[
                  styles.text12Semi,
                  {
                    color: selectedProvider ? theme.colors.foreground : theme.colors.foregroundMuted,
                    flexShrink: 1,
                  },
                ]}
              >
                {activeModelLabel}
              </Text>
              <Icon name="ChevronDown" size={12} color={theme.colors.foregroundMuted} />
            </Pressable>

            {webImageInputSupported ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("attachImageA11y")}
                onPress={() => void handlePickWishImages()}
                style={[
                  styles.attachImageBtn,
                  {
                    borderColor: wishImages.length > 0 ? theme.colors.accent : theme.colors.border,
                    backgroundColor: theme.colors.surface1,
                  },
                ]}
              >
                <Icon
                  name="Image"
                  size={13}
                  color={wishImages.length > 0 ? theme.colors.accent : theme.colors.foregroundMuted}
                />
                <Text
                  style={[
                    styles.text12Semi,
                    {
                      color:
                        wishImages.length > 0
                          ? theme.colors.foreground
                          : theme.colors.foregroundMuted,
                    },
                  ]}
                >
                  {wishImages.length > 0
                    ? `${t("attachImage")} (${wishImages.length})`
                    : t("attachImage")}
                </Text>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.rowCenterGap8}>
            {wishText.length > 0 || wishImages.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setWishDraft("");
                  clearWishDraftImages();
                  setComposerHeight(minComposerHeight);
                }}
                style={[styles.smallBtn, { backgroundColor: theme.colors.surface1 }]}
              >
                <Icon name="X" size={12} color={theme.colors.foregroundMuted} />
              </Pressable>
            ) : null}

            {!compact && Platform.OS === "web" ? (
              <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
                {t("composerShortcutHint")}
              </Text>
            ) : null}

            <Pressable
              accessibilityRole="button"
              disabled={!canSubmit}
              onPress={() => void handleSendWish()}
              style={[
                styles.wishSubmitBtn,
                {
                  backgroundColor: theme.colors.accent,
                  opacity: canSubmit ? 1 : 0.45,
                },
              ]}
            >
              <Icon name="Sparkles" size={14} color={theme.colors.accentForeground} />
              <Text style={[styles.text12Bold, { color: theme.colors.accentForeground }]}>
                {t("wishSubmit")}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>

      {showQuickPokes ? (
        <View style={styles.rowWrapGap6}>
          <Text style={[styles.text11, { color: theme.colors.foregroundMuted, marginRight: 2 }]}>
            {t("quickPokeSectionLabel")}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void dispatchWishText(t("quickPokeMorningWish"), false)}
            style={[
              styles.quickPokeChip,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <Icon name="Sparkles" size={12} color={theme.colors.accent} />
            <Text style={[styles.text11, { color: theme.colors.foreground }]}>
              {t("quickPokeMorning")}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => void dispatchWishText(t("quickPokeInboxWish"), false)}
            style={[
              styles.quickPokeChip,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <Icon name="Layers" size={12} color={theme.colors.foregroundMuted} />
            <Text style={[styles.text11, { color: theme.colors.foreground }]}>
              {t("quickPokeInbox")}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={tidyingSessions}
            onPress={() => void handleQuickTidy()}
            style={[
              styles.quickPokeChip,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
                opacity: tidyingSessions ? 0.6 : 1,
              },
            ]}
          >
            <Icon name="Layers" size={12} color={theme.colors.accent} />
            <Text style={[styles.text11, { color: theme.colors.foreground }]}>
              {t("quickPokeTidy")}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => void dispatchWishText(t("quickPokeAuditWish"), false)}
            style={[
              styles.quickPokeChip,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <Icon name="Radar" size={12} color={theme.colors.foregroundMuted} />
            <Text style={[styles.text11, { color: theme.colors.foreground }]}>
              {t("quickPokeAudit")}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});

const RoutineSuggestionCard = memo(function RoutineSuggestionCard({
  sug,
  theme,
  t,
  onAccept,
  onDismiss,
}: {
  sug: RoutineSuggestion;
  theme: PluginTheme;
  t: TranslateFn;
  onAccept: (sug: RoutineSuggestion) => Promise<void>;
  onDismiss: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const handleAccept = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onAccept(sug);
    } finally {
      setBusy(false);
    }
  }, [busy, onAccept, sug]);

  return (
    <View
      style={[
        styles.card12,
        {
          borderColor: theme.colors.accent,
          backgroundColor: theme.colors.surface1,
        },
      ]}
    >
      <View style={styles.rowCenterBetween}>
        <View style={styles.rowCenterGap6}>
          <Icon name="Sparkles" size={14} color={theme.colors.accent} />
          <Text style={[styles.text11Bold, { color: theme.colors.accent }]}>
            {t("routineSuggestBadge")}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => onDismiss(sug.id)}
        >
          <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
            {t("routineDismiss")}
          </Text>
        </Pressable>
      </View>

      <Text style={[styles.title14, { color: theme.colors.foreground }]}>
        {sug.title}
      </Text>
      <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
        {sug.reason}
      </Text>

      <View style={styles.rowWrapGap8}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void handleAccept()}
          style={[
            styles.microActionBtn,
            {
              borderColor: theme.colors.accent,
              backgroundColor: theme.colors.accent,
              opacity: busy ? 0.6 : 1,
            },
          ]}
        >
          <Icon name="Check" size={13} color={theme.colors.accentForeground} />
          <Text style={[styles.text12Bold, { color: theme.colors.accentForeground }]}>
            {t("routineAccept")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
});

const PendingApprovalCard = memo(function PendingApprovalCard({
  apr,
  linkedTriggerApprovedCount,
  timeLabels,
  theme,
  t,
  onResolve,
}: {
  apr: ApprovalItem;
  linkedTriggerApprovedCount: number;
  timeLabels: RelativeTimeLabels;
  theme: PluginTheme;
  t: TranslateFn;
  onResolve: (
    id: string,
    decision: "approved" | "rejected",
    note: string,
    editedFollowUpPrompt?: string,
    promoteTrust?: boolean,
  ) => Promise<void>;
}) {
  const initialPreview = apr.payloadPreview || apr.followUpPrompt;
  const [previewOpen, setPreviewOpen] = useState(Boolean(apr.payloadPreview));
  const [editingDraft, setEditingDraft] = useState(false);
  const [draftText, setDraftText] = useState(initialPreview);
  const [trustChecked, setTrustChecked] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const isHighRisk = apr.riskLevel === "high";
  const riskTone = isHighRisk ? theme.colors.statusDanger : theme.colors.statusWarning;
  const isEdited = draftText.trim() !== initialPreview.trim();

  const parsedChecklist = useMemo(() => {
    const lines = draftText.split("\n");
    const items: Array<{ lineIndex: number; checked: boolean; text: string }> = [];
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^(\s*[-*]\s+\[)([ xX])(\]\s+)(.+)$/.exec(lines[i]);
      if (m) {
        items.push({
          lineIndex: i,
          checked: m[2].toLowerCase() === "x",
          text: m[4].trim(),
        });
      }
    }
    return items.length >= 2 ? items : null;
  }, [draftText]);

  const toggleChecklistLine = useCallback((lineIndex: number) => {
    setDraftText((prev) => {
      const lines = prev.split("\n");
      const target = lines[lineIndex];
      if (!target) return prev;
      lines[lineIndex] = target.replace(
        /^(\s*[-*]\s+\[)([ xX])(\]\s+)/,
        (_, pre: string, mark: string, post: string) =>
          `${pre}${mark.toLowerCase() === "x" ? " " : "x"}${post}`,
      );
      return lines.join("\n");
    });
  }, []);

  const handleDecide = useCallback(
    async (decision: "approved" | "rejected") => {
      if (busy) return;
      setBusy(true);
      try {
        await onResolve(
          apr.id,
          decision,
          note,
          decision === "approved" && isEdited ? draftText.trim() : undefined,
          decision === "approved" && !isHighRisk && trustChecked ? true : undefined,
        );
      } finally {
        setBusy(false);
      }
    },
    [apr.id, busy, draftText, isEdited, isHighRisk, note, onResolve, trustChecked],
  );

  return (
    <View
      style={[
        styles.card14Padded,
        {
          borderColor: riskTone,
          borderLeftWidth: 3,
          backgroundColor: theme.colors.surface1,
        },
      ]}
    >
      <View style={styles.rowCenterBetween}>
        <View style={[styles.rowCenterGap8, styles.flex1]}>
          <Icon name="ShieldAlert" size={16} color={riskTone} />
          <Text style={[styles.title15, styles.flex1, { color: theme.colors.foreground }]}>
            {apr.title}
          </Text>
        </View>
        <View style={[styles.pillBadge, { backgroundColor: theme.colors.surface2 }]}>
          <Text style={[styles.text11Bold, { color: riskTone }]}>
            {t(RISK_LABEL_KEYS[apr.riskLevel])}
          </Text>
        </View>
      </View>

      <Text style={[styles.text13, { color: theme.colors.foreground }]}>
        {apr.actionSummary}
      </Text>
      <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
        {apr.triggerName ? `${apr.triggerName}  ·  ` : ""}
        {shortenPathForDisplay(apr.cwd)}  ·  {formatSmartTime(apr.createdAt, timeLabels)}
      </Text>

      <View style={styles.colGap6}>
        <View style={styles.rowCenterBetween}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setPreviewOpen((v) => !v)}
            style={styles.rowCenterGap6}
          >
            <Icon
              name={previewOpen ? "ChevronUp" : "Eye"}
              size={13}
              color={theme.colors.accent}
            />
            <Text style={[styles.text12Semi, { color: theme.colors.accent }]}>
              {previewOpen ? t("stagingHide") : t("stagingShow")}
            </Text>
          </Pressable>

          {previewOpen ? (
            <View style={styles.rowCenterGap8}>
              {isEdited && !editingDraft ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setDraftText(initialPreview)}
                  style={styles.rowCenterGap6}
                >
                  <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
                    {t("stagingCancelEdit")}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  if (editingDraft) {
                    setDraftText(initialPreview);
                    setEditingDraft(false);
                  } else {
                    setEditingDraft(true);
                  }
                }}
                style={styles.rowCenterGap6}
              >
                <Icon name="Pencil" size={12} color={theme.colors.foregroundMuted} />
                <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
                  {editingDraft ? t("stagingCancelEdit") : t("stagingEdit")}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        {previewOpen ? (
          editingDraft ? (
            <TextInput
              value={draftText}
              onChangeText={setDraftText}
              multiline
              style={[
                styles.stagingTextarea,
                {
                  borderColor: theme.colors.accent,
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface2,
                },
              ]}
            />
          ) : parsedChecklist ? (
            <View
              style={[
                styles.insetBox,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface2,
                },
              ]}
            >
              {parsedChecklist.map((chk) => (
                <Pressable
                  key={chk.lineIndex}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: chk.checked }}
                  onPress={() => toggleChecklistLine(chk.lineIndex)}
                  style={styles.checkboxRow}
                >
                  <Icon
                    name={chk.checked ? "CheckSquare" : "Square"}
                    size={14}
                    color={chk.checked ? theme.colors.accent : theme.colors.foregroundMuted}
                  />
                  <Text
                    style={[
                      styles.text12,
                      styles.flex1,
                      {
                        color: chk.checked
                          ? theme.colors.foreground
                          : theme.colors.foregroundMuted,
                      },
                    ]}
                  >
                    {chk.text}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <View
              style={[
                styles.insetBox,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface2,
                },
              ]}
            >
              <Text selectable style={[styles.text12, { color: theme.colors.foreground }]}>
                {draftText}
              </Text>
            </View>
          )
        ) : null}
      </View>

      <View style={[styles.rowCenterBetween, { flexWrap: "wrap" }]}>
        {apr.triggerId && !isHighRisk ? (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: trustChecked }}
            onPress={() => setTrustChecked((v) => !v)}
            style={styles.checkboxRow}
          >
            <Icon
              name={trustChecked ? "CheckSquare" : "Square"}
              size={14}
              color={trustChecked ? theme.colors.accent : theme.colors.foregroundMuted}
            />
            <Text style={[styles.text12, { color: theme.colors.foreground }]}>
              {t("trustCheckboxLabel")}
              {linkedTriggerApprovedCount >= 1 ? (
                <Text style={{ color: theme.colors.foregroundMuted }}>
                  {t("trustCountSuffix", { count: linkedTriggerApprovedCount })}
                </Text>
              ) : null}
            </Text>
          </Pressable>
        ) : (
          <View />
        )}

        <Pressable
          accessibilityRole="button"
          onPress={() => setNoteOpen((v) => !v)}
          style={styles.checkboxRow}
        >
          <Icon
            name={noteOpen ? "ChevronUp" : "Plus"}
            size={12}
            color={theme.colors.foregroundMuted}
          />
          <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
            {noteOpen ? t("hideApprovalNoteBtn") : t("addApprovalNoteBtn")}
          </Text>
        </Pressable>
      </View>

      {noteOpen ? (
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder={t("approvalNotePlaceholder")}
          placeholderTextColor={theme.colors.foregroundMuted}
          style={[
            styles.textInput,
            {
              borderColor: theme.colors.border,
              color: theme.colors.foreground,
              backgroundColor: theme.colors.surface2,
            },
          ]}
        />
      ) : null}

      <View style={styles.rowWrapGap8}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void handleDecide("approved")}
          style={[
            styles.approveBtn,
            { backgroundColor: theme.colors.accent, opacity: busy ? 0.6 : 1 },
          ]}
        >
          <Icon name="Check" size={15} color={theme.colors.accentForeground} />
          <Text style={[styles.text13Bold, { color: theme.colors.accentForeground }]}>
            {isEdited ? t("approveEdited") : t("approve")}
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void handleDecide("rejected")}
          style={[
            styles.rejectBtn,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
              opacity: busy ? 0.6 : 1,
            },
          ]}
        >
          <Icon name="X" size={15} color={theme.colors.foreground} />
          <Text style={[styles.text13, { color: theme.colors.foreground }]}>
            {t("reject")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
});

const FeedItemCard = memo(function FeedItemCard({
  item,
  timeLabels,
  theme,
  t,
  openAgentLabel,
  onOpenAgent,
  onMarkRead,
  onDismissCard,
  onCopyText,
}: {
  item: FeedItem;
  timeLabels: RelativeTimeLabels;
  theme: PluginTheme;
  t: TranslateFn;
  openAgentLabel: string;
  onOpenAgent: (agentId: string) => void;
  onMarkRead: (id: string) => void;
  onDismissCard: (id: string) => void;
  onCopyText: (val: string) => void;
}) {
  const toast = useToast();
  const runAction = useRpc(executeFeedActionRpc);
  const curateFeed = useRpc(curateFeedRpc);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replyImages, setReplyImages] = useState<DraftImageAttachment[]>([]);
  const [replyDragging, setReplyDragging] = useState(false);
  const [replyHeight, setReplyHeight] = useState(58);
  const [moreOpen, setMoreOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [calibrateOpen, setCalibrateOpen] = useState(false);
  const [ruleNote, setRuleNote] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const replyBoxRef = useRef<View>(null);
  const webImageInputSupported = useMemo(() => isWebImageInputSupported(), []);

  const handleAddReplyImages = useCallback(
    (incoming: PastedImageItem[]) => {
      if (incoming.length === 0) return;
      let truncated = false;
      setReplyImages((prev) => {
        const remaining = Math.max(0, MAX_ATTACHED_IMAGES - prev.length);
        if (incoming.length > remaining) truncated = true;
        const toAdd = incoming.slice(0, remaining);
        return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
      });
      if (truncated) {
        toast.show(t("imageLimitToast", { max: MAX_ATTACHED_IMAGES }), {
          variant: "warning",
        });
      }
    },
    [t, toast],
  );

  const handleReplyImageError = useCallback(
    (reason: ImageInputErrorReason) => {
      toast.show(formatImageErrorToast(reason, t), { variant: "warning" });
    },
    [t, toast],
  );

  const handlePickReplyImages = useCallback(async () => {
    const picked = await pickWebImages(handleReplyImageError);
    handleAddReplyImages(picked);
  }, [handleAddReplyImages, handleReplyImageError]);

  const handleRemoveReplyImage = useCallback((id: string) => {
    setReplyImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  useEffect(() => {
    if (!replyOpen || !webImageInputSupported) return;
    return mountWebImagePasteTarget({
      container: replyBoxRef.current,
      captureWindowPaste: false,
      onImages: handleAddReplyImages,
      onError: handleReplyImageError,
      onDragActiveChange: setReplyDragging,
    });
  }, [handleAddReplyImages, handleReplyImageError, replyOpen, webImageInputSupported]);

  const badgeColor =
    item.level === "error"
      ? theme.colors.statusDanger
      : item.level === "approval_required"
        ? theme.colors.statusWarning
        : item.level === "silent"
          ? theme.colors.foregroundMuted
          : theme.colors.accent;

  const handleRunAction = useCallback(
    async (act: FeedAction) => {
      if (busyKey || act.executedAt) return;
      setBusyKey(act.id);
      const rollback = optimisticExecuteFeedAction(item.id, {
        actionId: act.id,
        markInProgress:
          act.kind === "wish" && Boolean(item.agentId && !act.targetAgentId),
      });
      try {
        const res = await runAction({
          feedId: item.id,
          actionId: act.id,
          fallbackProvider: getSelectedConsoleProvider() || undefined,
        });
        if (!res.ok) rollback();
        toast.show(res.message, { variant: res.ok ? "success" : "warning" });
      } catch (err) {
        rollback();
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, item.agentId, item.id, runAction, toast],
  );

  const handleSnooze = useCallback(
    async (delayMinutes: number) => {
      if (busyKey) return;
      setBusyKey("snooze");
      setSnoozeOpen(false);
      setMoreOpen(false);
      const rollback = optimisticSnoozeFeed(item.id, delayMinutes);
      try {
        const res = await runAction({
          feedId: item.id,
          customKind: "snooze",
          delayMinutes,
        });
        if (!res.ok) rollback();
        toast.show(res.message, { variant: res.ok ? "info" : "warning" });
      } catch (err) {
        rollback();
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, item.id, runAction, toast],
  );

  const handleSendInlineReply = useCallback(async () => {
    const clean = replyText.trim();
    const imagesSnapshot = [...replyImages];
    if ((!clean && imagesSnapshot.length === 0) || busyKey) return;
    setBusyKey("reply");
    setReplyText("");
    setReplyImages([]);
    setReplyHeight(58);
    setReplyOpen(false);
    const rollback = optimisticExecuteFeedAction(item.id, {
      markInProgress: Boolean(item.agentId),
    });
    try {
      const res = await runAction({
        feedId: item.id,
        customKind: "wish",
        customPrompt: clean || undefined,
        images:
          imagesSnapshot.length > 0
            ? imagesSnapshot.map(({ data, mimeType, name }) => ({
                data,
                mimeType,
                ...(name ? { name } : {}),
              }))
            : undefined,
        fallbackProvider: getSelectedConsoleProvider() || undefined,
      });
      if (!res.ok) {
        rollback();
        setReplyOpen(true);
        if (clean) setReplyText((curr) => (curr.trim() ? curr : clean));
        if (imagesSnapshot.length > 0) {
          setReplyImages((curr) => (curr.length > 0 ? curr : imagesSnapshot));
        }
      }
      toast.show(res.message, { variant: res.ok ? "success" : "warning" });
    } catch (err) {
      rollback();
      setReplyOpen(true);
      if (clean) setReplyText((curr) => (curr.trim() ? curr : clean));
      if (imagesSnapshot.length > 0) {
        setReplyImages((curr) => (curr.length > 0 ? curr : imagesSnapshot));
      }
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [busyKey, item.agentId, item.id, replyImages, replyText, runAction, toast]);

  const handleTasteDown = useCallback(
    async (opts?: { presetNote?: string; muteTrigger?: boolean }) => {
      if (busyKey) return;
      setBusyKey("down");
      optimisticCurateFeed(
        item.id,
        "down",
        opts?.muteTrigger ? item.triggerId : undefined,
      );
      try {
        const finalNote = (opts?.presetNote ?? ruleNote).trim() || undefined;
        await curateFeed({
          feedId: item.id,
          feedback: "down",
          ruleNote: finalNote,
          muteTrigger: opts?.muteTrigger,
        });
        setCalibrateOpen(false);
        setMoreOpen(false);
        setRuleNote("");
        toast.show(t("tasteDownSaved"), { variant: "info" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, curateFeed, item.id, item.triggerId, ruleNote, t, toast],
  );

  const handleToggleDetails = useCallback(() => {
    setDetailsOpen((prev) => {
      const next = !prev;
      if (next && item.unread) {
        onMarkRead(item.id);
      }
      return next;
    });
  }, [item.id, item.unread, onMarkRead]);

  const targetSessionId = item.routedAgentId || item.agentId;

  const handleOpenSession = useCallback(() => {
    if (item.unread) {
      onMarkRead(item.id);
    }
    if (targetSessionId) {
      onOpenAgent(targetSessionId);
    }
  }, [item.id, item.unread, onMarkRead, onOpenAgent, targetSessionId]);

  const actions = item.actions ?? [];
  const isOptimistic = item.id.startsWith("opt_wish_");
  const showInteractiveBar = item.level !== "silent" && !isOptimistic;
  const hasLeftAccent =
    item.unread ||
    item.inProgress ||
    item.level === "error" ||
    item.level === "approval_required";

  return (
    <View
      style={[
        styles.card12,
        {
          borderColor: theme.colors.border,
          borderLeftWidth: hasLeftAccent ? 3 : 1,
          borderLeftColor: hasLeftAccent ? badgeColor : theme.colors.border,
          backgroundColor: theme.colors.surface1,
        },
      ]}
    >
      <View style={[styles.rowCenterBetween, { flexWrap: "wrap" }]}>
        <View style={[styles.rowCenterGap8, { flex: 1, minWidth: 160 }]}>
          {item.unread ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("markRead")}
              onPress={() => onMarkRead(item.id)}
              style={styles.unreadDotBtn}
            >
              <View style={[styles.unreadDot, { backgroundColor: badgeColor }]} />
            </Pressable>
          ) : null}
          <Text
            style={[
              styles.title14,
              { color: theme.colors.foreground, flexShrink: 1 },
            ]}
          >
            {item.title}
          </Text>
        </View>
        <View style={styles.rowWrapGap6}>
          {item.inProgress ? (
            <LiveElapsedBadge
              startIso={item.createdAt}
              variant="pill"
              t={t}
              color={theme.colors.accent}
              backgroundColor={theme.colors.surface2}
            />
          ) : null}
          {item.snoozedUntil ? (
            <View style={[styles.pillBadge, { backgroundColor: theme.colors.surface2 }]}>
              <Text style={[styles.text11, { color: theme.colors.accent }]}>
                {t("snoozedBadge")} {formatShortTime(item.snoozedUntil)}
              </Text>
            </View>
          ) : null}
          {item.triggerName ? (
            <View style={[styles.pillBadge, { backgroundColor: theme.colors.surface2 }]}>
              <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
                {item.triggerName}
              </Text>
            </View>
          ) : null}
          <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
            {formatSmartTime(item.createdAt, timeLabels)}
          </Text>
          {!showInteractiveBar && !item.inProgress ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("dismissCard")}
              onPress={() => onDismissCard(item.id)}
              style={{ paddingHorizontal: 3, paddingVertical: 2 }}
            >
              <Icon name="X" size={13} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {item.details && item.details.startsWith(item.summary.slice(0, 48)) ? (
        <View style={styles.colGap6}>
          <Markdown>{detailsOpen ? item.details : item.summary}</Markdown>
          <Pressable
            accessibilityRole="button"
            onPress={handleToggleDetails}
            style={styles.rowCenterGap6}
          >
            <Icon
              name={detailsOpen ? "ChevronUp" : "ChevronDown"}
              size={13}
              color={theme.colors.accent}
            />
            <Text style={[styles.text11Bold, { color: theme.colors.accent }]}>
              {detailsOpen ? t("fullReportHide") : t("fullReportShow")}
            </Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Markdown>{item.summary}</Markdown>
          {item.details ? (
            <View style={styles.colGap6}>
              <Pressable
                accessibilityRole="button"
                onPress={handleToggleDetails}
                style={styles.rowCenterGap6}
              >
                <Icon
                  name={detailsOpen ? "ChevronUp" : "ChevronDown"}
                  size={13}
                  color={theme.colors.foregroundMuted}
                />
                <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
                  {detailsOpen ? t("layer2Hide") : t("layer2Show")}
                </Text>
              </Pressable>
              {detailsOpen ? (
                <View
                  style={[
                    styles.insetBox,
                    {
                      borderColor: theme.colors.border,
                      backgroundColor: theme.colors.surface2,
                    },
                  ]}
                >
                  <Markdown>{item.details}</Markdown>
                </View>
              ) : null}
            </View>
          ) : null}
        </>
      )}

      {showInteractiveBar ? (
        <View style={[styles.cardFooterDivider, { borderTopColor: theme.colors.border }]}>
          <View style={[styles.rowWrapGap6, styles.flex1]}>
            {actions.map((act) => {
              const done = Boolean(act.executedAt);
              return (
                <Pressable
                  key={act.id}
                  accessibilityRole="button"
                  disabled={done || busyKey !== null}
                  onPress={() => void handleRunAction(act)}
                  style={[
                    styles.microActionBtn,
                    {
                      borderColor: done ? theme.colors.border : theme.colors.accent,
                      backgroundColor: done ? theme.colors.surface2 : theme.colors.surface1,
                      opacity: busyKey === act.id ? 0.6 : 1,
                    },
                  ]}
                >
                  <Icon
                    name={done ? "Check" : "Zap"}
                    size={12}
                    color={done ? theme.colors.statusSuccess : theme.colors.accent}
                  />
                  <Text
                    style={[
                      styles.text12Semi,
                      { color: done ? theme.colors.foregroundMuted : theme.colors.foreground },
                    ]}
                  >
                    {done ? t("doneActionPrefix", { label: act.label }) : act.label}
                  </Text>
                </Pressable>
              );
            })}

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setReplyOpen((v) => !v);
                setMoreOpen(false);
                setCalibrateOpen(false);
                setSnoozeOpen(false);
              }}
              style={[
                styles.microActionBtn,
                {
                  borderColor: replyOpen ? theme.colors.accent : theme.colors.border,
                  backgroundColor: theme.colors.surface2,
                },
              ]}
            >
              <Icon name="MessageSquare" size={12} color={theme.colors.foreground} />
              <Text style={[styles.text12, { color: theme.colors.foreground }]}>
                {t("inlineReplyBtn")}
              </Text>
            </Pressable>

            {targetSessionId ? (
              <Pressable
                accessibilityRole="button"
                onPress={handleOpenSession}
                style={[
                  styles.microActionBtn,
                  {
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surface2,
                  },
                ]}
              >
                <Icon name="ArrowUpRight" size={12} color={theme.colors.foregroundMuted} />
                <Text style={[styles.text12, { color: theme.colors.foreground }]}>
                  {openAgentLabel}
                </Text>
              </Pressable>
            ) : null}
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("moreActions")}
            onPress={() => {
              setMoreOpen((v) => {
                const next = !v;
                if (next) {
                  setReplyOpen(false);
                } else {
                  setSnoozeOpen(false);
                  setCalibrateOpen(false);
                }
                return next;
              });
            }}
            style={[
              styles.moreIconBtn,
              {
                borderColor: moreOpen ? theme.colors.accent : theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <Icon name="MoreHorizontal" size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      ) : null}

      {moreOpen ? (
        <View style={styles.rowWrapGap6}>
          <Pressable
            accessibilityRole="button"
            disabled={busyKey !== null || Boolean(item.snoozedUntil)}
            onPress={() => {
              setSnoozeOpen((v) => !v);
              setCalibrateOpen(false);
            }}
            style={[
              styles.microActionBtn,
              {
                borderColor: snoozeOpen ? theme.colors.accent : theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <Icon name="Clock" size={12} color={theme.colors.foregroundMuted} />
            <Text style={[styles.text11, { color: theme.colors.foreground }]}>
              {t("snoozeMenuBtn")}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={busyKey !== null}
            onPress={() => {
              setCalibrateOpen((v) => !v);
              setSnoozeOpen(false);
            }}
            style={[
              styles.microActionBtn,
              {
                borderColor:
                  calibrateOpen || item.feedback === "down"
                    ? theme.colors.statusWarning
                    : theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <Icon
              name="BellOff"
              size={12}
              color={
                item.feedback === "down"
                  ? theme.colors.statusWarning
                  : theme.colors.foregroundMuted
              }
            />
            <Text
              style={[
                styles.text11,
                {
                  color:
                    item.feedback === "down"
                      ? theme.colors.statusWarning
                      : theme.colors.foreground,
                },
              ]}
            >
              {t("tasteDown")}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => {
              onCopyText(item.details || item.summary);
              setMoreOpen(false);
            }}
            style={[
              styles.microActionBtn,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <Icon name="Copy" size={11} color={theme.colors.foregroundMuted} />
            <Text style={[styles.text11, { color: theme.colors.foreground }]}>
              {t("copyCard")}
            </Text>
          </Pressable>

          {item.unread ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                onMarkRead(item.id);
                setMoreOpen(false);
              }}
              style={[
                styles.microActionBtn,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface2,
                },
              ]}
            >
              <Icon name="Check" size={11} color={theme.colors.foregroundMuted} />
              <Text style={[styles.text11, { color: theme.colors.foreground }]}>
                {t("markRead")}
              </Text>
            </Pressable>
          ) : null}

          {!item.inProgress ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => onDismissCard(item.id)}
              style={[
                styles.microActionBtn,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface2,
                },
              ]}
            >
              <Icon name="Trash2" size={11} color={theme.colors.statusDanger} />
              <Text style={[styles.text11, { color: theme.colors.statusDanger }]}>
                {t("dismissCard")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {snoozeOpen ? (
        <View style={styles.rowWrapGap6}>
          {[
            { label: t("snooze1h"), mins: 60 },
            { label: t("snooze3h"), mins: 180 },
            { label: t("snoozeTomorrowMorning"), mins: minutesUntilTomorrowMorning(9, 0) },
          ].map((opt) => (
            <Pressable
              key={opt.label}
              accessibilityRole="button"
              disabled={busyKey !== null}
              onPress={() => void handleSnooze(opt.mins)}
              style={[
                styles.microActionBtn,
                {
                  borderColor: theme.colors.accent,
                  backgroundColor: theme.colors.surface2,
                },
              ]}
            >
              <Icon name="Clock" size={11} color={theme.colors.accent} />
              <Text style={[styles.text11Bold, { color: theme.colors.foreground }]}>
                {opt.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {replyOpen ? (
        <View
          ref={replyBoxRef}
          style={[
            styles.inlineComposerBox,
            {
              borderColor: replyDragging ? theme.colors.accent : theme.colors.accent,
              backgroundColor: theme.colors.surface0,
            },
          ]}
        >
          <TextInput
            value={replyText}
            onChangeText={(txt) => {
              setReplyText(txt);
              if (!txt) setReplyHeight(58);
            }}
            onKeyPress={(e) => {
              if (isModifierSubmitKey(e)) {
                void handleSendInlineReply();
              }
            }}
            onContentSizeChange={(e) => {
              const nextH = e.nativeEvent?.contentSize?.height;
              if (typeof nextH === "number" && Number.isFinite(nextH)) {
                setReplyHeight(Math.max(58, Math.min(150, Math.ceil(nextH + 12))));
              }
            }}
            multiline
            numberOfLines={2}
            textAlignVertical="top"
            placeholder={t("inlineReplyPlaceholder")}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[
              styles.inlineMultilineInput,
              {
                minHeight: 58,
                height: replyHeight,
                maxHeight: 150,
                color: theme.colors.foreground,
              },
            ]}
          />
          <ComposerImageStrip
            images={replyImages}
            theme={theme}
            t={t}
            onRemove={handleRemoveReplyImage}
          />
          {replyDragging ? (
            <View
              style={[
                styles.dropHintBanner,
                {
                  borderTopColor: theme.colors.border,
                  backgroundColor: theme.colors.surface2,
                },
              ]}
            >
              <Icon name="Image" size={12} color={theme.colors.accent} />
              <Text style={[styles.text11Bold, { color: theme.colors.accent }]}>
                {t("dropImagesHint")}
              </Text>
            </View>
          ) : null}
          <View
            style={[
              styles.inlineComposerFooter,
              {
                borderTopColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <View style={[styles.rowCenterGap6, { flexShrink: 1 }]}>
              {webImageInputSupported ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("attachImageA11y")}
                  onPress={() => void handlePickReplyImages()}
                  style={[
                    styles.attachImageBtn,
                    {
                      borderColor: replyImages.length > 0 ? theme.colors.accent : theme.colors.border,
                      backgroundColor: theme.colors.surface1,
                    },
                  ]}
                >
                  <Icon
                    name="Image"
                    size={12}
                    color={replyImages.length > 0 ? theme.colors.accent : theme.colors.foregroundMuted}
                  />
                  {replyImages.length > 0 ? (
                    <Text style={[styles.text11Bold, { color: theme.colors.foreground }]}>
                      {replyImages.length}
                    </Text>
                  ) : null}
                </Pressable>
              ) : null}
              <Icon name="GitBranch" size={11} color={theme.colors.foregroundMuted} />
              <Text
                numberOfLines={1}
                style={[styles.text11, { color: theme.colors.foregroundMuted, flexShrink: 1 }]}
              >
                {t("inlineReplyInheritHint")}
              </Text>
            </View>
            <View style={styles.rowCenterGap6}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setReplyOpen(false)}
                style={[styles.smallBtnPad6, { backgroundColor: theme.colors.surface1 }]}
              >
                <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
                  {t("cancel")}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={(!replyText.trim() && replyImages.length === 0) || busyKey !== null}
                onPress={() => void handleSendInlineReply()}
                style={[
                  styles.microActionBtn,
                  {
                    borderColor: theme.colors.accent,
                    backgroundColor: theme.colors.accent,
                    opacity: replyText.trim() || replyImages.length > 0 ? 1 : 0.45,
                  },
                ]}
              >
                <Icon name="Send" size={12} color={theme.colors.accentForeground} />
                <Text style={[styles.text12Bold, { color: theme.colors.accentForeground }]}>
                  {t("inlineReplySend")}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {calibrateOpen ? (
        <View
          style={[
            styles.insetBox,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
            },
          ]}
        >
          <View style={styles.rowWrapGap6}>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                void handleTasteDown({
                  presetNote: t("tastePresetMinor"),
                })
              }
              style={[
                styles.microActionBtn,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                },
              ]}
            >
              <Text style={[styles.text11, { color: theme.colors.foreground }]}>
                {t("tastePresetMinor")}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() =>
                void handleTasteDown({
                  presetNote: t("tastePresetDigest"),
                })
              }
              style={[
                styles.microActionBtn,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                },
              ]}
            >
              <Text style={[styles.text11, { color: theme.colors.foreground }]}>
                {t("tastePresetDigest")}
              </Text>
            </Pressable>

            {item.triggerId ? (
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  void handleTasteDown({
                    presetNote: t("tastePresetMute"),
                    muteTrigger: true,
                  })
                }
                style={[
                  styles.microActionBtn,
                  {
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surface1,
                  },
                ]}
              >
                <Text style={[styles.text11, { color: theme.colors.statusWarning }]}>
                  {t("tastePresetMute")}
                </Text>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.rowGap8}>
            <TextInput
              value={ruleNote}
              onChangeText={setRuleNote}
              onSubmitEditing={() => void handleTasteDown()}
              placeholder={t("tasteRulePlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={[
                styles.textInput,
                styles.flex1,
                {
                  borderColor: theme.colors.border,
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface1,
                },
              ]}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => void handleTasteDown()}
              style={[
                styles.microActionBtn,
                {
                  borderColor: theme.colors.accent,
                  backgroundColor: theme.colors.accent,
                },
              ]}
            >
              <Text style={[styles.text12Bold, { color: theme.colors.accentForeground }]}>
                {t("tasteApplyBtn")}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
});

const ResolvedApprovalRow = memo(function ResolvedApprovalRow({
  apr,
  timeLabels,
  theme,
  t,
  openAgentLabel,
  onOpenAgent,
}: {
  apr: ApprovalItem;
  timeLabels: RelativeTimeLabels;
  theme: PluginTheme;
  t: TranslateFn;
  openAgentLabel: string;
  onOpenAgent: (agentId: string) => void;
}) {
  return (
    <View
      style={[
        styles.resolvedRow,
        {
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        },
      ]}
    >
      <View style={styles.flex1Gap2}>
        <Text style={[styles.text13, { color: theme.colors.foreground }]}>{apr.title}</Text>
        <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
          {apr.status === "approved" ? t("statusApproved") : t("statusRejected")}
          {apr.promotedTrust ? ` · ${t("promotedBadge")}` : ""}
          {" · "}
          {formatSmartTime(apr.resolvedAt, timeLabels)}
        </Text>
      </View>
      {apr.executionAgentId ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onOpenAgent(apr.executionAgentId!)}
          style={[styles.smallBtn, { backgroundColor: theme.colors.surface2 }]}
        >
          <Text style={[styles.text12, { color: theme.colors.foreground }]}>
            {openAgentLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const MissionCard = memo(function MissionCard({
  trg,
  webhookBaseUrl,
  theme,
  t,
  onRunNow,
  onEdit,
  onCopyWebhook,
  onToggle,
  onDelete,
}: {
  trg: TriggerSpec;
  webhookBaseUrl: string | null;
  theme: PluginTheme;
  t: TranslateFn;
  onRunNow: (id: string) => void;
  onEdit: (trg: TriggerSpec) => void;
  onCopyWebhook: (url: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);

  const webhookUrl =
    trg.kind === "webhook" && trg.webhookKey && webhookBaseUrl
      ? `${webhookBaseUrl}/hook/${trg.webhookKey}`
      : null;

  const noiseRuleCount = trg.noiseRules?.length ?? 0;

  return (
    <View
      style={[
        styles.card14,
        {
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          opacity: trg.enabled ? 1 : 0.68,
        },
      ]}
    >
      <View style={styles.rowCenterBetween}>
        <View style={styles.flex1Gap2}>
          <Text style={[styles.title15, { color: theme.colors.foreground }]}>{trg.name}</Text>
          <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
            {describeMissionCadence(trg, t)}  ·  {t(GOV_LABEL_KEYS[trg.governance])}
          </Text>
        </View>
        <RuleSwitch
          enabled={trg.enabled}
          theme={theme}
          onToggle={() => onToggle(trg.id, !trg.enabled)}
        />
      </View>

      <View style={styles.rowWrapGap6}>
        <View style={[styles.pillBadge, { backgroundColor: theme.colors.surface2 }]}>
          <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
            {t("missionStats", { silent: trg.silentCount, notify: trg.notifyCount })}
          </Text>
        </View>
        {noiseRuleCount > 0 ? (
          <View style={[styles.pillBadge, { backgroundColor: theme.colors.surface2 }]}>
            <Text style={[styles.text11, { color: theme.colors.accent }]}>
              {t("missionNoiseCount", { count: noiseRuleCount })}
            </Text>
          </View>
        ) : null}
        {trg.approvedCount > 0 ? (
          <View style={[styles.pillBadge, { backgroundColor: theme.colors.surface2 }]}>
            <Text style={[styles.text11, { color: theme.colors.statusSuccess }]}>
              {t("missionApprovedCount", { count: trg.approvedCount })}
            </Text>
          </View>
        ) : null}
      </View>

      {webhookUrl ? (
        <Text selectable style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
          POST {webhookUrl}
        </Text>
      ) : null}

      <Text numberOfLines={2} style={[styles.text12, { color: theme.colors.foreground }]}>
        {trg.description || trg.prompt}
      </Text>

      {trg.lastError ? (
        <Text style={[styles.text11, { color: theme.colors.statusDanger }]}>
          Error: {trg.lastError}
        </Text>
      ) : null}

      <View style={[styles.rowCenterBetween, { marginTop: 2 }]}>
        <Pressable
          accessibilityRole="button"
          onPress={() => onRunNow(trg.id)}
          style={[styles.smallIconBtn, { backgroundColor: theme.colors.surface2 }]}
        >
          <Icon name="Play" size={13} color={theme.colors.foreground} />
          <Text style={[styles.text12, { color: theme.colors.foreground }]}>{t("runNow")}</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("moreActions")}
          onPress={() => setMoreOpen((v) => !v)}
          style={[
            styles.moreIconBtn,
            {
              borderColor: moreOpen ? theme.colors.accent : theme.colors.border,
              backgroundColor: theme.colors.surface2,
            },
          ]}
        >
          <Icon name="MoreHorizontal" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>

      {moreOpen ? (
        <View style={styles.rowWrapGap8}>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setMoreOpen(false);
              onEdit(trg);
            }}
            style={[styles.smallIconBtn, { backgroundColor: theme.colors.surface2 }]}
          >
            <Icon name="Pencil" size={12} color={theme.colors.foreground} />
            <Text style={[styles.text12, { color: theme.colors.foreground }]}>
              {t("editMission")}
            </Text>
          </Pressable>

          {webhookUrl ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                onCopyWebhook(webhookUrl);
                setMoreOpen(false);
              }}
              style={[styles.smallIconBtn, { backgroundColor: theme.colors.surface2 }]}
            >
              <Icon name="Copy" size={13} color={theme.colors.foreground} />
              <Text style={[styles.text12, { color: theme.colors.foreground }]}>
                {t("copyWebhook")}
              </Text>
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="button"
            onPress={() => onDelete(trg.id)}
            style={[styles.smallIconBtn, { backgroundColor: theme.colors.surface2 }]}
          >
            <Icon name="Trash2" size={12} color={theme.colors.statusDanger} />
            <Text style={[styles.text12, { color: theme.colors.statusDanger }]}>
              {t("delete")}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});

const NativeScheduleCard = memo(function NativeScheduleCard({
  sched,
  theme,
  t,
  onManage,
  onEdit,
  onOpenAgent,
}: {
  sched: NativeScheduleItem;
  theme: PluginTheme;
  t: TranslateFn;
  onManage: (id: string, action: "run_once" | "pause" | "resume" | "delete") => void;
  onEdit: (sched: NativeScheduleItem) => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const isActive = sched.status === "active";
  const rawModel = (sched.provider || sched.target.replace(/^new-agent:/, "")).trim();
  const shortModel = rawModel.includes("/") ? rawModel.split("/", 2)[1] : rawModel;
  const promptPreview = sched.prompt?.trim() ?? "";

  const runStatusBadge = useMemo(() => {
    if (!sched.lastRunStatus) return null;
    if (sched.lastRunStatus === "succeeded") {
      return {
        label: t("lastRunSucceeded"),
        color: theme.colors.statusSuccess,
      };
    }
    if (sched.lastRunStatus === "failed") {
      return {
        label: t("lastRunFailed"),
        color: theme.colors.statusDanger,
      };
    }
    return {
      label: t("lastRunRunning"),
      color: theme.colors.accent,
    };
  }, [
    sched.lastRunStatus,
    t,
    theme.colors.accent,
    theme.colors.statusDanger,
    theme.colors.statusSuccess,
  ]);

  return (
    <View
      style={[
        styles.card14,
        {
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          opacity: isActive ? 1 : 0.68,
        },
      ]}
    >
      <View style={styles.rowCenterBetween}>
        <View style={styles.flex1Gap2}>
          <Text style={[styles.title15, { color: theme.colors.foreground }]}>
            {sched.name}
          </Text>
          <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
            {t("nativeScheduleTag")}  ·  {formatNativeCadence(sched.cadence)}
            {sched.cwd ? `  ·  ${shortenPathForDisplay(sched.cwd)}` : ""}
            {shortModel ? `  ·  ${shortModel}` : ""}
          </Text>
        </View>
        <RuleSwitch
          enabled={isActive}
          theme={theme}
          onToggle={() => onManage(sched.id, isActive ? "pause" : "resume")}
        />
      </View>

      <View style={styles.rowWrapGap8}>
        {sched.nextRunAt ? (
          <View style={[styles.pillBadge, { backgroundColor: theme.colors.surface2 }]}>
            <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
              {t("nextRunLabel", { time: formatShortTime(sched.nextRunAt) })}
            </Text>
          </View>
        ) : null}
        {sched.lastRunAt ? (
          <View style={[styles.pillBadge, { backgroundColor: theme.colors.surface2 }]}>
            <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
              {t("lastRunLabel", { time: formatShortTime(sched.lastRunAt) })}
            </Text>
          </View>
        ) : null}
        {runStatusBadge ? (
          <View style={[styles.pillBadge, { backgroundColor: theme.colors.surface2 }]}>
            <Text style={[styles.text11Bold, { color: runStatusBadge.color }]}>
              {runStatusBadge.label}
            </Text>
          </View>
        ) : null}
      </View>

      {promptPreview ? (
        <Text numberOfLines={2} style={[styles.text12, { color: theme.colors.foreground }]}>
          {promptPreview}
        </Text>
      ) : null}

      {sched.lastRunError ? (
        <Text numberOfLines={2} style={[styles.text11, { color: theme.colors.statusDanger }]}>
          Error: {sched.lastRunError}
        </Text>
      ) : null}

      <View style={[styles.rowCenterBetween, { marginTop: 2 }]}>
        <View style={styles.rowWrapGap8}>
          <Pressable
            accessibilityRole="button"
            onPress={() => onManage(sched.id, "run_once")}
            style={[styles.smallIconBtn, { backgroundColor: theme.colors.surface2 }]}
          >
            <Icon name="Play" size={13} color={theme.colors.foreground} />
            <Text style={[styles.text12, { color: theme.colors.foreground }]}>
              {t("runNow")}
            </Text>
          </Pressable>

          {sched.lastRunAgentId ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => onOpenAgent(sched.lastRunAgentId!)}
              style={[styles.smallIconBtn, { backgroundColor: theme.colors.surface2 }]}
            >
              <Icon name="MessageSquare" size={12} color={theme.colors.foregroundMuted} />
              <Text style={[styles.text12, { color: theme.colors.foreground }]}>
                {t("openLastRunAgent")}
              </Text>
            </Pressable>
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("moreActions")}
          onPress={() => setMoreOpen((v) => !v)}
          style={[
            styles.moreIconBtn,
            {
              borderColor: moreOpen ? theme.colors.accent : theme.colors.border,
              backgroundColor: theme.colors.surface2,
            },
          ]}
        >
          <Icon name="MoreHorizontal" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>

      {moreOpen ? (
        <View style={styles.rowWrapGap8}>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setMoreOpen(false);
              onEdit(sched);
            }}
            style={[styles.smallIconBtn, { backgroundColor: theme.colors.surface2 }]}
          >
            <Icon name="Pencil" size={12} color={theme.colors.foreground} />
            <Text style={[styles.text12, { color: theme.colors.foreground }]}>
              {t("editMission")}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setMoreOpen(false);
              onManage(sched.id, "delete");
            }}
            style={[styles.smallIconBtn, { backgroundColor: theme.colors.surface2 }]}
          >
            <Icon name="Trash2" size={12} color={theme.colors.statusDanger} />
            <Text style={[styles.text12, { color: theme.colors.statusDanger }]}>
              {t("delete")}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});

const WorkerCard = memo(function WorkerCard({
  wrk,
  timeLabels,
  theme,
  t,
  openAgentLabel,
  onOpenAgent,
  onStopWorker,
  onRetryWorker,
  onRemoveWorker,
}: {
  wrk: DelegatedWorker;
  timeLabels: RelativeTimeLabels;
  theme: PluginTheme;
  t: TranslateFn;
  openAgentLabel: string;
  onOpenAgent: (agentId: string) => void;
  onStopWorker: (id: string) => void;
  onRetryWorker: (wrk: DelegatedWorker) => void;
  onRemoveWorker: (id: string) => void;
}) {
  const isRunning = wrk.status === "running" || wrk.status === "permission";
  const statusTone =
    wrk.status === "completed"
      ? theme.colors.statusSuccess
      : wrk.status === "failed"
        ? theme.colors.statusDanger
        : wrk.status === "permission"
          ? theme.colors.statusWarning
          : theme.colors.accent;

  return (
    <View
      style={[
        styles.cardWorker,
        {
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        },
      ]}
    >
      <View style={styles.rowCenterBetween}>
        <Text style={[styles.title14, styles.flex1, { color: theme.colors.foreground }]}>
          {wrk.title}
        </Text>
        {isRunning ? (
          <LiveElapsedBadge
            startIso={wrk.createdAt}
            variant="inline"
            prefix={t(WORKER_LABEL_KEYS[wrk.status])}
            color={statusTone}
          />
        ) : (
          <Text style={[styles.text11Bold, { color: statusTone }]}>
            {t(WORKER_LABEL_KEYS[wrk.status])}
          </Text>
        )}
      </View>
      <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
        {shortenPathForDisplay(wrk.cwd)} ({wrk.isolation})  ·  {wrk.provider}  ·  {formatSmartTime(wrk.updatedAt, timeLabels)}
      </Text>
      {wrk.summary ? (
        <Text numberOfLines={4} style={[styles.text12, { color: theme.colors.foreground }]}>
          {wrk.summary}
        </Text>
      ) : null}
      <View style={styles.rowWrapGap8}>
        <Pressable
          accessibilityRole="button"
          onPress={() => onOpenAgent(wrk.agentId)}
          style={[
            styles.smallBtnPad6,
            { paddingHorizontal: 12, backgroundColor: theme.colors.surface2 },
          ]}
        >
          <Text style={[styles.text12, { color: theme.colors.foreground }]}>
            {openAgentLabel}
          </Text>
        </Pressable>

        {wrk.status === "failed" ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => onRetryWorker(wrk)}
            style={[
              styles.smallIconBtn,
              { paddingHorizontal: 11, backgroundColor: theme.colors.surface2 },
            ]}
          >
            <Icon name="RotateCcw" size={12} color={theme.colors.accent} />
            <Text style={[styles.text12Semi, { color: theme.colors.accent }]}>
              {t("retryWorker")}
            </Text>
          </Pressable>
        ) : null}

        {isRunning ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => onStopWorker(wrk.id)}
            style={[
              styles.smallBtnPad6,
              { paddingHorizontal: 12, backgroundColor: theme.colors.surface2 },
            ]}
          >
            <Text style={[styles.text12, { color: theme.colors.statusWarning }]}>
              {t("stopWorker")}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => onRemoveWorker(wrk.id)}
            style={[
              styles.smallBtnPad6,
              { paddingHorizontal: 12, backgroundColor: theme.colors.surface2 },
            ]}
          >
            <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
              {t("removeWorker")}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
});

const MemoryPreviewCard = memo(function MemoryPreviewCard({
  memoryPath,
  memoryContent,
  theme,
  t,
  onEdit,
}: {
  memoryPath: string;
  memoryContent: string;
  theme: PluginTheme;
  t: TranslateFn;
  onEdit: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const { previewMd, totalLines, isTruncated } = useMemo(() => {
    const raw = memoryContent.trim();
    if (!raw) return { previewMd: "*Memory is currently empty.*", totalLines: 0, isTruncated: false };
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim() || raw;
    const lines = body.split("\n");
    if (lines.length <= 16) {
      return { previewMd: body, totalLines: lines.length, isTruncated: false };
    }
    return {
      previewMd: lines.slice(0, 14).join("\n"),
      totalLines: lines.length,
      isTruncated: true,
    };
  }, [memoryContent]);

  return (
    <View
      style={[
        styles.card14Padded,
        {
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          gap: 12,
        },
      ]}
    >
      <View style={styles.rowCenterBetween}>
        <View style={styles.flex1Gap2}>
          <Text style={[styles.title14, { color: theme.colors.foreground }]}>
            {t("memorySectionTitle")}
          </Text>
          <Text selectable style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
            {memoryPath}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onEdit}
          style={[
            styles.presetBtn,
            {
              backgroundColor: theme.colors.surface2,
              borderColor: theme.colors.border,
            },
          ]}
        >
          <Text style={[styles.text12, { color: theme.colors.foreground }]}>
            {t("editMemory")}
          </Text>
        </Pressable>
      </View>

      <Markdown>{expanded || !isTruncated ? memoryContent || previewMd : previewMd}</Markdown>

      {isTruncated ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded((v) => !v)}
          style={styles.rowCenterGap6}
        >
          <Icon
            name={expanded ? "ChevronUp" : "ChevronDown"}
            size={13}
            color={theme.colors.accent}
          />
          <Text style={[styles.text12Semi, { color: theme.colors.accent }]}>
            {expanded
              ? t("memoryCollapse")
              : t("memoryExpandAll", { lines: totalLines })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const InboxTabSection = memo(function InboxTabSection({
  theme,
  t,
  timeLabels,
  openAgentLabel,
  filterOverrideSignal,
  onOpenAgent,
  onResolveApproval,
  onCopyText,
}: {
  theme: PluginTheme;
  t: TranslateFn;
  timeLabels: RelativeTimeLabels;
  openAgentLabel: string;
  filterOverrideSignal: number;
  onOpenAgent: (agentId: string) => void;
  onResolveApproval: (
    id: string,
    decision: "approved" | "rejected",
    note: string,
    editedFollowUpPrompt?: string,
    promoteTrust?: boolean,
  ) => Promise<void>;
  onCopyText: (val: string) => void;
}) {
  const toast = useToast();
  const markFeedRead = useRpc(markFeedReadRpc);
  const upsertTrigger = useRpc(upsertTriggerRpc);
  const upsertNativeSchedule = useRpc(upsertNativeScheduleRpc);
  const dismissSuggestion = useRpc(dismissSuggestionRpc);

  const slice = useBotSelector((s) => ({
    feed: s.feed,
    approvals: s.approvals,
    suggestions: s.routineSuggestions,
    triggers: s.triggers,
    unreadCount: s.unreadCount,
  }));

  const [filterMode, setFilterMode] = useState<BotInboxFilterMode>(
    () => consumeRequestedInboxFilter() ?? "all",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [showSilent, setShowSilent] = useState(false);
  const [toolbarMoreOpen, setToolbarMoreOpen] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(15);

  useEffect(() => {
    const reqFilter = consumeRequestedInboxFilter();
    if (reqFilter) {
      setFilterMode(reqFilter);
    }
  }, [filterOverrideSignal]);

  const { pendingApprovals, resolvedApprovals, resolvedApprovalIds } = useMemo(() => {
    const pending: ApprovalItem[] = [];
    const resolved: ApprovalItem[] = [];
    const resolvedIds = new Set<string>();
    for (const a of slice.approvals) {
      if (a.status === "pending") {
        pending.push(a);
      } else {
        resolvedIds.add(a.id);
        if (resolved.length < 10) resolved.push(a);
      }
    }
    return {
      pendingApprovals: pending,
      resolvedApprovals: resolved,
      resolvedApprovalIds: resolvedIds,
    };
  }, [slice.approvals]);

  const triggerApprovedMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const trg of slice.triggers) {
      map.set(trg.id, trg.approvedCount || 0);
    }
    return map;
  }, [slice.triggers]);

  const handleMarkFeedRead = useCallback(
    (id: string) => {
      optimisticMarkFeedRead({ id });
      void markFeedRead({ id });
    },
    [markFeedRead],
  );

  const handleMarkAllRead = useCallback(() => {
    optimisticMarkFeedRead({});
    void markFeedRead({});
  }, [markFeedRead]);

  const handleDismissCard = useCallback(
    (id: string) => {
      optimisticMarkFeedRead({ dismissId: id });
      void markFeedRead({ dismissId: id });
    },
    [markFeedRead],
  );

  const handleClearReadCards = useCallback(() => {
    setToolbarMoreOpen(false);
    optimisticMarkFeedRead({ clearRead: true });
    void markFeedRead({ clearRead: true })
      .then((res) => {
        if ((res.removedCount ?? 0) > 0) {
          toast.show(t("feedClearedToast", { count: res.removedCount ?? 0 }), {
            variant: "info",
          });
        }
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [markFeedRead, t, toast]);

  const handleAcceptSuggestion = useCallback(
    async (sug: RoutineSuggestion) => {
      try {
        if (sug.suggestedKind === "schedule") {
          await upsertNativeSchedule({
            name: sug.title,
            prompt: sug.prompt,
            cwd: sug.cwd,
            dailyTime: sug.dailyTime,
            everySec: sug.pollIntervalSec,
            governance: sug.governance,
          });
        } else {
          await upsertTrigger({
            name: sug.title,
            description: sug.reason,
            kind: sug.suggestedKind,
            governance: sug.governance,
            cwd: sug.cwd,
            watchPath: sug.watchPath,
            pollCommand: sug.pollCommand,
            pollIntervalSec: sug.pollIntervalSec,
            dailyTime: sug.dailyTime,
            prompt: sug.prompt,
          });
        }
        optimisticDismissSuggestion(sug.id);
        await dismissSuggestion({ suggestionId: sug.id });
        toast.show(t("routineAcceptedToast"), { variant: "success" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [dismissSuggestion, t, toast, upsertNativeSchedule, upsertTrigger],
  );

  const handleDismissSuggestion = useCallback(
    (id: string) => {
      optimisticDismissSuggestion(id);
      void dismissSuggestion({ suggestionId: id });
    },
    [dismissSuggestion],
  );

  const {
    todayFeed,
    earlierFeed,
    remainingCount,
    totalMatched,
    hasClearableRead,
    actionableFeedCount,
  } = useMemo(() => {
    const pendingIds = new Set(pendingApprovals.map((a) => a.id));
    const pendingTitles = new Set(pendingApprovals.map((a) => `待确认：${a.title}`));
    const q = searchQuery.trim().toLowerCase();
    const now = new Date();
    const nowMs = now.getTime();

    let clearableRead = false;
    let actionableCount = 0;
    const matched: FeedItem[] = [];

    for (const item of slice.feed) {
      if (!showSilent && item.level === "silent") continue;
      if (
        item.level === "approval_required" &&
        ((item.approvalId && pendingIds.has(item.approvalId)) ||
          pendingTitles.has(item.title))
      ) {
        continue;
      }
      if (!item.unread && !item.inProgress && item.level !== "approval_required") {
        clearableRead = true;
      }
      const needsAttention = isFeedItemNeedsAttention(item, {
        resolvedApprovalIds,
        nowMs,
      });
      if (needsAttention) {
        actionableCount += 1;
      }
      if (filterMode === "unread" && !item.unread) continue;
      if (filterMode === "running" && !item.inProgress) continue;
      if (filterMode === "attention" && !needsAttention) {
        continue;
      }
      if (q) {
        const hay = `${item.title}\n${item.summary}\n${item.triggerName ?? ""}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      matched.push(item);
    }

    const windowed = matched.slice(0, visibleLimit);
    const today: FeedItem[] = [];
    const earlier: FeedItem[] = [];
    for (const f of windowed) {
      if (isSameLocalDay(f.createdAt, now)) today.push(f);
      else earlier.push(f);
    }

    return {
      todayFeed: today,
      earlierFeed: earlier,
      remainingCount: Math.max(0, matched.length - windowed.length),
      totalMatched: matched.length,
      hasClearableRead: clearableRead,
      actionableFeedCount: actionableCount,
    };
  }, [
    filterMode,
    pendingApprovals,
    resolvedApprovalIds,
    searchQuery,
    showSilent,
    slice.feed,
    visibleLimit,
  ]);

  const totalAttentionCount = pendingApprovals.length + actionableFeedCount;

  const filterChips: Array<{ id: BotInboxFilterMode; label: string; count?: number }> =
    useMemo(
      () => [
        { id: "all", label: t("filterAll") },
        { id: "unread", label: t("filterUnread") },
        { id: "running", label: t("filterRunning") },
        {
          id: "attention",
          label: t("filterAttention"),
          count: totalAttentionCount > 0 ? totalAttentionCount : undefined,
        },
      ],
      [t, totalAttentionCount],
    );

  const isFiltered = filterMode !== "all" || searchQuery.trim().length > 0;
  const showResolvedApprovals =
    filterMode === "attention" && resolvedApprovals.length > 0 && !searchQuery.trim();

  return (
    <View style={styles.colGap12}>
      {pendingApprovals.map((apr) => (
        <PendingApprovalCard
          key={apr.id}
          apr={apr}
          linkedTriggerApprovedCount={
            apr.triggerId ? (triggerApprovedMap.get(apr.triggerId) ?? 0) : 0
          }
          timeLabels={timeLabels}
          theme={theme}
          t={t}
          onResolve={onResolveApproval}
        />
      ))}

      {(slice.suggestions ?? []).map((sug) => (
        <RoutineSuggestionCard
          key={sug.id}
          sug={sug}
          theme={theme}
          t={t}
          onAccept={handleAcceptSuggestion}
          onDismiss={handleDismissSuggestion}
        />
      ))}

      <View style={[styles.rowCenterBetween, { flexWrap: "wrap", gap: 8 }]}>
        <View style={styles.rowWrapGap6}>
          {filterChips.map((chip) => {
            const active = filterMode === chip.id;
            return (
              <Pressable
                key={chip.id}
                accessibilityRole="button"
                onPress={() => {
                  setFilterMode(chip.id);
                  setVisibleLimit(15);
                }}
                style={[
                  styles.filterChip,
                  {
                    borderColor: active ? theme.colors.accent : theme.colors.border,
                    backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
                  },
                ]}
              >
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: active ? "700" : "500",
                    color: active
                      ? theme.colors.accentForeground
                      : theme.colors.foreground,
                  }}
                >
                  {chip.label}
                  {chip.count ? ` (${chip.count})` : ""}
                </Text>
              </Pressable>
            );
          })}

          <View
            style={[
              styles.searchBox,
              {
                borderColor: searchQuery ? theme.colors.accent : theme.colors.border,
                backgroundColor: theme.colors.surface1,
              },
            ]}
          >
            <Icon name="Search" size={12} color={theme.colors.foregroundMuted} />
            <TextInput
              value={searchQuery}
              onChangeText={(txt) => {
                setSearchQuery(txt);
                setVisibleLimit(15);
              }}
              placeholder={t("searchPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={[styles.searchInput, { color: theme.colors.foreground }]}
            />
            {searchQuery.length > 0 ? (
              <Pressable accessibilityRole="button" onPress={() => setSearchQuery("")}>
                <Icon name="X" size={12} color={theme.colors.foregroundMuted} />
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={styles.rowWrapGap6}>
          {slice.unreadCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={handleMarkAllRead}
              style={[
                styles.smallBorderBtn,
                {
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <Icon name="Check" size={12} color={theme.colors.foreground} />
              <Text style={[styles.text12, { color: theme.colors.foreground }]}>
                {t("markAllRead")}
              </Text>
            </Pressable>
          ) : hasClearableRead ? (
            <Pressable
              accessibilityRole="button"
              onPress={handleClearReadCards}
              style={[
                styles.smallBorderBtn,
                {
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <Icon name="Trash2" size={12} color={theme.colors.foregroundMuted} />
              <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                {t("clearReadBtn")}
              </Text>
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("moreActions")}
            onPress={() => setToolbarMoreOpen((v) => !v)}
            style={[
              styles.moreIconBtn,
              {
                backgroundColor: theme.colors.surface1,
                borderColor:
                  toolbarMoreOpen || showSilent
                    ? theme.colors.accent
                    : theme.colors.border,
              },
            ]}
          >
            <Icon
              name="MoreHorizontal"
              size={14}
              color={showSilent ? theme.colors.accent : theme.colors.foregroundMuted}
            />
          </Pressable>
        </View>
      </View>

      {toolbarMoreOpen ? (
        <View style={styles.rowWrapGap6}>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setShowSilent((prev) => !prev);
              setToolbarMoreOpen(false);
            }}
            style={[
              styles.smallBorderBtn,
              {
                backgroundColor: theme.colors.surface1,
                borderColor: showSilent ? theme.colors.accent : theme.colors.border,
              },
            ]}
          >
            <Text style={[styles.text12, { color: theme.colors.foreground }]}>
              {showSilent ? t("hideSilent") : t("showSilent")}
            </Text>
          </Pressable>

          {slice.unreadCount > 0 && hasClearableRead ? (
            <Pressable
              accessibilityRole="button"
              onPress={handleClearReadCards}
              style={[
                styles.smallBorderBtn,
                {
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <Icon name="Trash2" size={12} color={theme.colors.foregroundMuted} />
              <Text style={[styles.text12, { color: theme.colors.foreground }]}>
                {t("clearReadBtn")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {totalMatched === 0 ? (
        pendingApprovals.length === 0 ? (
          <View
            style={[
              styles.emptyBox,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
              },
            ]}
          >
            <Text style={[styles.text13Center, { color: theme.colors.foregroundMuted }]}>
              {filterMode === "attention" && !searchQuery.trim()
                ? t("emptyAttentionInbox")
                : isFiltered
                  ? t("emptyFilteredInbox")
                  : t("emptyInbox")}
            </Text>
          </View>
        ) : null
      ) : (
        <View style={styles.colGap14}>
          {todayFeed.length > 0 ? (
            <View style={styles.colGap10}>
              <Text style={[styles.sectionHeader, { color: theme.colors.foregroundMuted }]}>
                {t("sectionTodayPulse")}
              </Text>
              {todayFeed.map((item) => (
                <FeedItemCard
                  key={item.id}
                  item={item}
                  timeLabels={timeLabels}
                  theme={theme}
                  t={t}
                  openAgentLabel={openAgentLabel}
                  onOpenAgent={onOpenAgent}
                  onMarkRead={handleMarkFeedRead}
                  onDismissCard={handleDismissCard}
                  onCopyText={onCopyText}
                />
              ))}
            </View>
          ) : null}

          {earlierFeed.length > 0 ? (
            <View style={styles.colGap10}>
              <Text style={[styles.sectionHeader, { color: theme.colors.foregroundMuted }]}>
                {t("sectionEarlierPulse")}
              </Text>
              {earlierFeed.map((item) => (
                <FeedItemCard
                  key={item.id}
                  item={item}
                  timeLabels={timeLabels}
                  theme={theme}
                  t={t}
                  openAgentLabel={openAgentLabel}
                  onOpenAgent={onOpenAgent}
                  onMarkRead={handleMarkFeedRead}
                  onDismissCard={handleDismissCard}
                  onCopyText={onCopyText}
                />
              ))}
            </View>
          ) : null}

          {remainingCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setVisibleLimit((prev) => prev + 20)}
              style={[
                styles.loadMoreBtn,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                },
              ]}
            >
              <Text style={[styles.text12Semi, { color: theme.colors.accent }]}>
                {t("loadMoreFeed", { count: remainingCount })}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {showResolvedApprovals ? (
        <View style={styles.colGap8}>
          <Text style={[styles.sectionHeader, { color: theme.colors.foregroundMuted }]}>
            {t("resolvedApprovalsTitle")}
          </Text>
          {resolvedApprovals.map((apr) => (
            <ResolvedApprovalRow
              key={apr.id}
              apr={apr}
              timeLabels={timeLabels}
              theme={theme}
              t={t}
              openAgentLabel={openAgentLabel}
              onOpenAgent={onOpenAgent}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const MissionsTabSection = memo(function MissionsTabSection({
  theme,
  compact,
  t,
  onOpenNewMission,
  onOpenEditMission,
  onOpenEditSchedule,
  onOpenAgent,
  onCopyText,
}: {
  theme: PluginTheme;
  compact: boolean;
  t: TranslateFn;
  onOpenNewMission: () => void;
  onOpenEditMission: (trg: TriggerSpec) => void;
  onOpenEditSchedule: (sched: NativeScheduleItem) => void;
  onOpenAgent: (agentId: string) => void;
  onCopyText: (val: string) => void;
}) {
  const toast = useToast();
  const installPreset = useRpc(installPresetRpc);
  const toggleTrigger = useRpc(toggleTriggerRpc);
  const deleteTrigger = useRpc(deleteTriggerRpc);
  const runTriggerNow = useRpc(runTriggerNowRpc);
  const manageNativeSchedule = useRpc(manageNativeScheduleRpc);

  const [ruleFilter, setRuleFilter] = useState<"all" | "schedules" | "events">("all");
  const [ruleSearch, setRuleSearch] = useState("");

  const slice = useBotSelector((s) => ({
    triggers: s.triggers,
    nativeSchedules: s.nativeSchedules ?? [],
    webhookBaseUrl: s.webhookBaseUrl,
  }));

  const { activeRules, finishedReminders, activeCount, totalCount } = useMemo(() => {
    const rules: TriggerSpec[] = [];
    const reminders: TriggerSpec[] = [];
    let runningCount = 0;
    for (const trg of slice.triggers) {
      if (trg.kind === "self_wake" && !trg.enabled) {
        reminders.push(trg);
      } else {
        rules.push(trg);
        if (trg.enabled) runningCount += 1;
      }
    }
    for (const ns of slice.nativeSchedules) {
      if (ns.status === "active") runningCount += 1;
    }
    return {
      activeRules: rules,
      finishedReminders: reminders,
      activeCount: runningCount,
      totalCount: rules.length + slice.nativeSchedules.length,
    };
  }, [slice.nativeSchedules, slice.triggers]);

  const { filteredSchedules, filteredRules } = useMemo(() => {
    const q = ruleSearch.trim().toLowerCase();
    const nextSchedules =
      ruleFilter === "events"
        ? []
        : slice.nativeSchedules.filter((s) => {
            if (!q) return true;
            const hay = `${s.name}\n${s.prompt}\n${s.cwd}\n${s.cadence}`.toLowerCase();
            return hay.includes(q);
          });
    const nextRules =
      ruleFilter === "schedules"
        ? []
        : activeRules.filter((r) => {
            if (!q) return true;
            const hay = `${r.name}\n${r.description}\n${r.prompt}\n${r.cwd}\n${r.watchPath ?? ""}\n${r.pollCommand ?? ""}`.toLowerCase();
            return hay.includes(q);
          });
    return { filteredSchedules: nextSchedules, filteredRules: nextRules };
  }, [activeRules, ruleFilter, ruleSearch, slice.nativeSchedules]);

  const handleInstallPreset = useCallback(
    async (presetId: PresetId) => {
      try {
        const created = await installPreset({ presetId });
        toast.show(t("presetEnabledToast", { name: created.name }), { variant: "success" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [installPreset, t, toast],
  );

  const handleRunTriggerNow = useCallback(
    (id: string) => {
      void runTriggerNow({ id })
        .then((res) => {
          toast.show(res.message, { variant: res.ok ? "success" : "warning" });
        })
        .catch((err) => {
          toast.error(err instanceof Error ? err.message : String(err));
        });
    },
    [runTriggerNow, toast],
  );

  const handleToggleTrigger = useCallback(
    (id: string, enabled: boolean) => {
      optimisticToggleTrigger(id, enabled);
      void toggleTrigger({ id, enabled });
    },
    [toggleTrigger],
  );

  const handleDeleteTrigger = useCallback(
    (id: string) => {
      optimisticDeleteTrigger({ id });
      void deleteTrigger({ id });
    },
    [deleteTrigger],
  );

  const handleClearFinishedReminders = useCallback(() => {
    optimisticDeleteTrigger({ clearFinishedReminders: true });
    void deleteTrigger({ clearFinishedReminders: true })
      .then((res) => {
        if ((res.removedCount ?? 0) > 0) {
          toast.show(t("remindersClearedToast", { count: res.removedCount ?? 0 }), {
            variant: "info",
          });
        }
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [deleteTrigger, t, toast]);

  const handleManageNativeSchedule = useCallback(
    (id: string, action: "run_once" | "pause" | "resume" | "delete") => {
      if (action === "pause" || action === "resume" || action === "delete") {
        optimisticManageNativeSchedule(id, action);
      }
      void manageNativeSchedule({ id, action })
        .then((res) => {
          toast.show(res.message, { variant: res.ok ? "success" : "warning" });
        })
        .catch((err) => {
          toast.error(err instanceof Error ? err.message : String(err));
        });
    },
    [manageNativeSchedule, toast],
  );

  const hasAnyRule = totalCount > 0;
  const filterOptions: Array<{
    id: "all" | "schedules" | "events";
    label: string;
    count: number;
  }> = [
    { id: "all", label: t("rulesFilterAll"), count: totalCount },
    {
      id: "schedules",
      label: t("rulesFilterSchedules"),
      count: slice.nativeSchedules.length,
    },
    { id: "events", label: t("rulesFilterEvents"), count: activeRules.length },
  ];

  return (
    <View style={styles.colGap14}>
      <View style={[styles.rowCenterBetween, { flexWrap: "wrap", gap: 8 }]}>
        <View style={styles.flex1Gap2}>
          <Text style={[styles.text12Semi, { color: theme.colors.foreground }]}>
            {t("rulesSummaryHeader", { active: activeCount, total: totalCount })}
          </Text>
          <View style={styles.rowCenterGap6}>
            <Icon name="RefreshCw" size={11} color={theme.colors.foregroundMuted} />
            <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
              {t("schedulesSyncHint")}
            </Text>
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onOpenNewMission}
          style={[styles.newMissionBtn, { backgroundColor: theme.colors.accent }]}
        >
          <Icon name="Plus" size={13} color={theme.colors.accentForeground} />
          <Text style={[styles.text12Bold, { color: theme.colors.accentForeground }]}>
            {t("newMission")}
          </Text>
        </Pressable>
      </View>

      {hasAnyRule ? (
        <View style={styles.rowWrapGap6}>
          {filterOptions.map((opt) => {
            const selected = ruleFilter === opt.id;
            return (
              <Pressable
                key={opt.id}
                accessibilityRole="button"
                onPress={() => setRuleFilter(opt.id)}
                style={[
                  styles.filterChip,
                  {
                    borderColor: selected ? theme.colors.accent : theme.colors.border,
                    backgroundColor: selected ? theme.colors.accent : theme.colors.surface1,
                  },
                ]}
              >
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: selected ? "700" : "500",
                    color: selected
                      ? theme.colors.accentForeground
                      : theme.colors.foreground,
                  }}
                >
                  {opt.label} ({opt.count})
                </Text>
              </Pressable>
            );
          })}

          <View
            style={[
              styles.searchBox,
              {
                borderColor: ruleSearch ? theme.colors.accent : theme.colors.border,
                backgroundColor: theme.colors.surface1,
              },
            ]}
          >
            <Icon name="Search" size={12} color={theme.colors.foregroundMuted} />
            <TextInput
              value={ruleSearch}
              onChangeText={setRuleSearch}
              placeholder={t("searchPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={[styles.searchInput, { color: theme.colors.foreground }]}
            />
            {ruleSearch.length > 0 ? (
              <Pressable accessibilityRole="button" onPress={() => setRuleSearch("")}>
                <Icon name="X" size={12} color={theme.colors.foregroundMuted} />
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      {!hasAnyRule ? (
        <View
          style={[
            styles.card14,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
              gap: 10,
            },
          ]}
        >
          <Text style={[styles.title14, { color: theme.colors.foreground }]}>
            {t("presetsTitle")}
          </Text>

          {PRESET_DEFINITIONS.map((preset) => {
            const alreadyEnabled = isPresetAlreadyEnabled(
              preset.id,
              slice.triggers,
              slice.nativeSchedules,
            );
            return (
              <View
                key={preset.id}
                style={[
                  styles.presetRow,
                  {
                    flexDirection: compact ? "column" : "row",
                    alignItems: compact ? "flex-start" : "center",
                    backgroundColor: theme.colors.surface2,
                  },
                ]}
              >
                <View style={styles.flex1Gap2}>
                  <Text style={[styles.text13Semi, { color: theme.colors.foreground }]}>
                    {t(preset.titleKey)}
                  </Text>
                  <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                    {t(preset.descKey)}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  disabled={alreadyEnabled}
                  onPress={() => void handleInstallPreset(preset.id)}
                  style={[
                    styles.presetBtn,
                    {
                      borderColor: alreadyEnabled
                        ? theme.colors.statusSuccess
                        : theme.colors.border,
                      backgroundColor: theme.colors.surface1,
                      opacity: alreadyEnabled ? 0.75 : 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.text12Semi,
                      {
                        color: alreadyEnabled
                          ? theme.colors.statusSuccess
                          : theme.colors.foreground,
                      },
                    ]}
                  >
                    {alreadyEnabled ? t("presetAdded") : t("addPreset")}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : filteredSchedules.length === 0 && filteredRules.length === 0 ? (
        <View
          style={[
            styles.emptyBox,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            },
          ]}
        >
          <Text style={[styles.text13Center, { color: theme.colors.foregroundMuted }]}>
            {t("emptyFilteredInbox")}
          </Text>
        </View>
      ) : (
        <View style={styles.colGap14}>
          {filteredSchedules.length > 0 ? (
            <View style={styles.colGap10}>
              <Text style={[styles.sectionHeader, { color: theme.colors.foregroundMuted }]}>
                {t("nativeSchedulesTitle", { count: filteredSchedules.length })}
              </Text>
              {filteredSchedules.map((sched) => (
                <NativeScheduleCard
                  key={sched.id}
                  sched={sched}
                  theme={theme}
                  t={t}
                  onManage={handleManageNativeSchedule}
                  onEdit={onOpenEditSchedule}
                  onOpenAgent={onOpenAgent}
                />
              ))}
            </View>
          ) : null}

          {filteredRules.length > 0 ? (
            <View style={styles.colGap10}>
              <Text style={[styles.sectionHeader, { color: theme.colors.foregroundMuted }]}>
                {t("pluginRulesTitle", { count: filteredRules.length })}
              </Text>
              {filteredRules.map((trg) => (
                <MissionCard
                  key={trg.id}
                  trg={trg}
                  webhookBaseUrl={slice.webhookBaseUrl}
                  theme={theme}
                  t={t}
                  onRunNow={handleRunTriggerNow}
                  onEdit={onOpenEditMission}
                  onCopyWebhook={onCopyText}
                  onToggle={handleToggleTrigger}
                  onDelete={handleDeleteTrigger}
                />
              ))}
            </View>
          ) : null}
        </View>
      )}

      {finishedReminders.length > 0 ? (
        <View style={styles.colGap10}>
          <View style={styles.rowCenterBetween}>
            <Text style={[styles.sectionHeader, { color: theme.colors.foregroundMuted }]}>
              {t("finishedRemindersTitle", { count: finishedReminders.length })}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={handleClearFinishedReminders}
              style={[
                styles.smallBorderBtn,
                {
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <Icon name="Trash2" size={12} color={theme.colors.foregroundMuted} />
              <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                {t("clearFinishedRemindersBtn")}
              </Text>
            </Pressable>
          </View>
          {finishedReminders.map((trg) => (
            <MissionCard
              key={trg.id}
              trg={trg}
              webhookBaseUrl={slice.webhookBaseUrl}
              theme={theme}
              t={t}
              onRunNow={handleRunTriggerNow}
              onEdit={onOpenEditMission}
              onCopyWebhook={onCopyText}
              onToggle={handleToggleTrigger}
              onDelete={handleDeleteTrigger}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const WorkersTabSection = memo(function WorkersTabSection({
  theme,
  t,
  timeLabels,
  openAgentLabel,
  onOpenAgent,
  onOpenMemoryModal,
}: {
  theme: PluginTheme;
  t: TranslateFn;
  timeLabels: RelativeTimeLabels;
  openAgentLabel: string;
  onOpenAgent: (agentId: string) => void;
  onOpenMemoryModal: () => void;
}) {
  const toast = useToast();
  const manageWorker = useRpc(manageWorkerRpc);
  const submitWish = useRpc(submitWishRpc);

  const slice = useBotSelector((s) => ({
    workers: s.workers,
    memoryPath: s.memoryPath,
    memoryContent: s.memoryContent,
  }));

  const hasFinishedWorkers = useMemo(
    () =>
      slice.workers.some(
        (w) => w.status !== "running" && w.status !== "permission",
      ),
    [slice.workers],
  );

  const handleStopWorker = useCallback(
    (workerId: string) => {
      void manageWorker({ action: "stop", workerId })
        .then((res) => {
          if (res.ok) toast.show(t("workerStoppedToast"), { variant: "info" });
        })
        .catch((err) => {
          toast.error(err instanceof Error ? err.message : String(err));
        });
    },
    [manageWorker, t, toast],
  );

  const handleRetryWorker = useCallback(
    (wrk: DelegatedWorker) => {
      const optimisticId = optimisticAddWishFeed(wrk.goal);
      void submitWish({
        wish: wrk.goal,
        cwd: wrk.cwd,
        provider: wrk.provider || getSelectedConsoleProvider() || undefined,
        asyncLaunch: true,
      })
        .then((res) => {
          confirmOptimisticWishFeed(optimisticId, res.feedId);
          toast.show(t("wishSentToast"), { variant: "success" });
        })
        .catch((err) => {
          rollbackOptimisticWishFeed(optimisticId);
          toast.error(err instanceof Error ? err.message : String(err));
        });
    },
    [submitWish, t, toast],
  );

  const handleRemoveWorker = useCallback(
    (workerId: string) => {
      optimisticRemoveWorker({ workerId });
      void manageWorker({ action: "remove", workerId });
    },
    [manageWorker],
  );

  const handleClearFinishedWorkers = useCallback(
    () => {
      optimisticRemoveWorker({ clearFinished: true });
      void manageWorker({ action: "clear_finished" })
        .then((res) => {
          if (res.ok) {
            toast.show(t("workersClearedToast", { count: res.removedCount ?? 0 }), {
              variant: "info",
            });
          }
        })
        .catch((err) => {
          toast.error(err instanceof Error ? err.message : String(err));
        });
    },
    [manageWorker, t, toast],
  );

  return (
    <View style={styles.colGap16}>
      {slice.workers.length > 0 ? (
        <View style={styles.colGap10}>
          {hasFinishedWorkers ? (
            <View style={styles.rowCenterBetween}>
              <View />
              <Pressable
                accessibilityRole="button"
                onPress={handleClearFinishedWorkers}
                style={[
                  styles.smallBorderBtn,
                  {
                    backgroundColor: theme.colors.surface1,
                    borderColor: theme.colors.border,
                  },
                ]}
              >
                <Icon name="Trash2" size={12} color={theme.colors.foregroundMuted} />
                <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                  {t("clearFinishedWorkers")}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {slice.workers.map((wrk) => (
            <WorkerCard
              key={wrk.id}
              wrk={wrk}
              timeLabels={timeLabels}
              theme={theme}
              t={t}
              openAgentLabel={openAgentLabel}
              onOpenAgent={onOpenAgent}
              onStopWorker={handleStopWorker}
              onRetryWorker={handleRetryWorker}
              onRemoveWorker={handleRemoveWorker}
            />
          ))}
        </View>
      ) : null}

      <MemoryPreviewCard
        memoryPath={slice.memoryPath}
        memoryContent={slice.memoryContent}
        theme={theme}
        t={t}
        onEdit={onOpenMemoryModal}
      />

      {slice.workers.length === 0 ? (
        <View
          style={[
            styles.emptyBoxCompact,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            },
          ]}
        >
          <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
            {t("emptyWorkers")}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

export function BotConsoleScreen({
  theme,
  layout,
  params,
  navigation,
}: PluginScreenProps) {
  const { t } = useTranslation(messages);
  useFullBotSync();
  const settings = useSettings(paseoBotSettings);
  const timeLabels = useRelativeTimeLabels(t);
  const toast = useToast();

  const selectedProvider = useSelectedConsoleProvider();

  const showChiefChatBtn =
    settings.status === "ready" && settings.values.wishSessionMode === "shared_chief";

  const tabCounts = useBotSelector((s) => {
    let activeMissionCount = 0;
    for (const m of s.triggers) if (m.enabled) activeMissionCount += 1;
    for (const ns of s.nativeSchedules ?? []) if (ns.status === "active") activeMissionCount += 1;
    return {
      unreadCount: s.unreadCount,
      pendingApprovalCount: s.pendingApprovalCount,
      activeMissionCount,
      runningWorkerCount: s.runningWorkerCount,
      triggers: s.triggers,
      nativeSchedules: s.nativeSchedules ?? [],
      memoryContent: s.memoryContent,
      knownWorkspaces: s.knownWorkspaces,
    };
  });

  const resolveApproval = useRpc(resolveApprovalRpc);
  const listModels = useRpc(listModelsRpc);

  const [activeTab, setActiveTab] = useState<Exclude<BotConsoleTab, "approvals">>("inbox");
  const [filterOverrideSignal, setFilterOverrideSignal] = useState(0);
  const [missionModalState, setMissionModalState] = useState<{
    open: boolean;
    editingTrigger: TriggerSpec | null;
    editingSchedule: NativeScheduleItem | null;
  }>({ open: false, editingTrigger: null, editingSchedule: null });
  const [memoryModalOpen, setMemoryModalOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<{
    defaultProvider: string;
    providers: CatalogProvider[];
  }>({
    defaultProvider: "antigravity/gemini-4-neon",
    providers: [],
  });
  const [loadingModels, setLoadingModels] = useState(false);

  const fetchModelCatalog = useCallback(
    async (refresh = false) => {
      setLoadingModels(true);
      try {
        const res = await listModels({ refresh });
        setModelCatalog(res);
      } catch {
        // Keep fallback catalog
      } finally {
        setLoadingModels(false);
      }
    },
    [listModels],
  );

  useEffect(() => {
    void fetchModelCatalog(false);
  }, [fetchModelCatalog]);

  useEffect(() => {
    const reqTab = consumeRequestedConsoleTab();
    if (reqTab) {
      if (reqTab === "approvals") {
        setActiveTab("inbox");
        setFilterOverrideSignal((n) => n + 1);
      } else {
        setActiveTab(reqTab);
        setFilterOverrideSignal((n) => n + 1);
      }
      return;
    }
    const paramTab = params.tab;
    if (paramTab === "approvals") {
      setActiveTab("inbox");
      return;
    }
    if (paramTab === "inbox" || paramTab === "missions" || paramTab === "workers") {
      setActiveTab(paramTab);
    }
  }, [params.tab]);

  const openAgentSession = useCallback(
    (agentId: string) => {
      if (navigation?.openAgent) {
        if (navigation.supportsFocusHost) {
          navigation.openAgent({ agentId, focusHost: true });
        } else {
          navigation.openAgent({ agentId });
        }
      } else {
        toast.show(`Agent ID: ${agentId}`);
      }
    },
    [navigation, toast],
  );

  const handleResolveApproval = useCallback(
    async (
      id: string,
      decision: "approved" | "rejected",
      note: string,
      editedFollowUpPrompt?: string,
      promoteTrust?: boolean,
    ) => {
      optimisticResolveApproval(id, decision);
      try {
        const res = await resolveApproval({
          id,
          decision,
          note: note.trim() || undefined,
          editedFollowUpPrompt,
          promoteTrust,
        });
        if (decision === "approved") {
          toast.show(
            res.promotedTriggerName
              ? t("promotedToast", { name: res.promotedTriggerName })
              : t("approvedToast"),
            { variant: "success" },
          );
          if (res.executionAgentId) {
            openAgentSession(res.executionAgentId);
          }
        } else {
          toast.show(t("rejectedToast"));
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [openAgentSession, resolveApproval, t, toast],
  );

  const handleCopyText = useCallback(
    (val: string) => {
      void copyText(val)
        .then(() => {
          toast.show(t("copiedToast"), { variant: "success" });
        })
        .catch(() => {
          toast.error("Copy failed");
        });
    },
    [t, toast],
  );

  const handleOpenNewMission = useCallback(() => {
    setMissionModalState({ open: true, editingTrigger: null, editingSchedule: null });
  }, []);

  const handleOpenEditMission = useCallback((trg: TriggerSpec) => {
    setMissionModalState({ open: true, editingTrigger: trg, editingSchedule: null });
  }, []);

  const handleOpenEditSchedule = useCallback((sched: NativeScheduleItem) => {
    setMissionModalState({ open: true, editingTrigger: null, editingSchedule: sched });
  }, []);

  const handleCloseMissionModal = useCallback(() => {
    setMissionModalState({ open: false, editingTrigger: null, editingSchedule: null });
  }, []);

  const handleOpenMemoryModal = useCallback(() => {
    setMemoryModalOpen(true);
  }, []);

  const handleCloseMemoryModal = useCallback(() => {
    setMemoryModalOpen(false);
  }, []);

  const handleJumpApprovals = useCallback(() => {
    setActiveTab("inbox");
  }, []);

  const handleTaskQueued = useCallback(() => {
    setActiveTab("inbox");
  }, []);

  const handleOpenModelPicker = useCallback(() => {
    setModelPickerOpen(true);
    if (modelCatalog.providers.length === 0) {
      void fetchModelCatalog(false);
    }
  }, [fetchModelCatalog, modelCatalog.providers.length]);

  const handleCloseModelPicker = useCallback(() => {
    setModelPickerOpen(false);
  }, []);

  const handleRefreshModelCatalog = useCallback(() => {
    void fetchModelCatalog(true);
  }, [fetchModelCatalog]);

  const pad = layout.compact ? 14 : 22;
  const openAgentLabel = t("openAgent");

  const inboxBadgeCount = tabCounts.pendingApprovalCount + tabCounts.unreadCount;

  const tabs = useMemo<
    Array<{
      id: Exclude<BotConsoleTab, "approvals">;
      label: string;
      icon: string;
      badge?: number;
      tone?: "warning" | "accent" | "muted";
    }>
  >(
    () => [
      {
        id: "inbox",
        label: t("tabInboxLabel"),
        icon: tabCounts.pendingApprovalCount > 0 ? "ShieldAlert" : "Bell",
        badge: inboxBadgeCount,
        tone: tabCounts.pendingApprovalCount > 0 ? "warning" : "accent",
      },
      {
        id: "missions",
        label: t("tabMissionsLabel"),
        icon: "Radar",
        badge: tabCounts.activeMissionCount,
        tone: "muted",
      },
      {
        id: "workers",
        label: t("tabWorkersLabel"),
        icon: "Cpu",
        badge: tabCounts.runningWorkerCount,
        tone: "accent",
      },
    ],
    [
      inboxBadgeCount,
      t,
      tabCounts.activeMissionCount,
      tabCounts.pendingApprovalCount,
      tabCounts.runningWorkerCount,
    ],
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.surface0 }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { padding: pad, gap: layout.compact ? 14 : 18 },
        ]}
      >
        <WishHeroBar
          theme={theme}
          compact={layout.compact}
          defaultProvider={modelCatalog.defaultProvider}
          modelProviders={modelCatalog.providers}
          showChiefChatBtn={showChiefChatBtn}
          t={t}
          onOpenAgent={openAgentSession}
          onOpenModelPicker={handleOpenModelPicker}
          onTaskQueued={handleTaskQueued}
          onJumpApprovals={handleJumpApprovals}
        />

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabScroll}>
          <View style={styles.rowGap8}>
            {tabs.map((tab) => {
              const selected = activeTab === tab.id;
              const badgeCount = tab.badge ?? 0;
              const badgeBg = selected
                ? theme.colors.surface0
                : tab.tone === "warning"
                  ? theme.colors.statusWarning
                  : tab.tone === "accent"
                    ? theme.colors.accent
                    : theme.colors.surface2;
              const badgeFg = selected
                ? theme.colors.foreground
                : tab.tone === "warning"
                  ? theme.colors.surface0
                  : tab.tone === "accent"
                    ? theme.colors.accentForeground
                    : theme.colors.foregroundMuted;

              return (
                <Pressable
                  key={tab.id}
                  accessibilityRole="button"
                  onPress={() => setActiveTab(tab.id)}
                  style={[
                    styles.tabChip,
                    {
                      borderColor: selected ? theme.colors.accent : theme.colors.border,
                      backgroundColor: selected ? theme.colors.accent : theme.colors.surface1,
                    },
                  ]}
                >
                  <Icon
                    name={tab.icon}
                    size={14}
                    color={
                      selected ? theme.colors.accentForeground : theme.colors.foregroundMuted
                    }
                  />
                  <Text
                    style={{
                      color: selected
                        ? theme.colors.accentForeground
                        : theme.colors.foreground,
                      fontSize: 13,
                      fontWeight: selected ? "700" : "500",
                    }}
                  >
                    {tab.label}
                  </Text>
                  {badgeCount > 0 ? (
                    <View style={[styles.tabBadge, { backgroundColor: badgeBg }]}>
                      <Text style={[styles.text11Bold, { color: badgeFg }]}>{badgeCount}</Text>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        {activeTab === "inbox" ? (
          <InboxTabSection
            theme={theme}
            t={t}
            timeLabels={timeLabels}
            openAgentLabel={openAgentLabel}
            filterOverrideSignal={filterOverrideSignal}
            onOpenAgent={openAgentSession}
            onResolveApproval={handleResolveApproval}
            onCopyText={handleCopyText}
          />
        ) : null}

        {activeTab === "missions" ? (
          <MissionsTabSection
            theme={theme}
            compact={layout.compact}
            t={t}
            onOpenNewMission={handleOpenNewMission}
            onOpenEditMission={handleOpenEditMission}
            onOpenEditSchedule={handleOpenEditSchedule}
            onOpenAgent={openAgentSession}
            onCopyText={handleCopyText}
          />
        ) : null}

        {activeTab === "workers" ? (
          <WorkersTabSection
            theme={theme}
            t={t}
            timeLabels={timeLabels}
            openAgentLabel={openAgentLabel}
            onOpenAgent={openAgentSession}
            onOpenMemoryModal={handleOpenMemoryModal}
          />
        ) : null}
      </ScrollView>

      {missionModalState.open ? (
        <CreateOrEditMissionModal
          editingTrigger={missionModalState.editingTrigger}
          editingSchedule={missionModalState.editingSchedule}
          existingTriggers={tabCounts.triggers}
          existingNativeSchedules={tabCounts.nativeSchedules}
          knownWorkspaces={tabCounts.knownWorkspaces ?? []}
          theme={theme}
          t={t}
          onClose={handleCloseMissionModal}
        />
      ) : null}

      {memoryModalOpen ? (
        <MemoryEditorModal
          initialContent={tabCounts.memoryContent}
          theme={theme}
          t={t}
          onClose={handleCloseMemoryModal}
        />
      ) : null}

      {modelPickerOpen ? (
        <ModelPickerModal
          selectedProvider={selectedProvider}
          defaultProvider={modelCatalog.defaultProvider}
          providers={modelCatalog.providers}
          loading={loadingModels}
          theme={theme}
          t={t}
          onSelect={setSelectedConsoleProvider}
          onRefresh={handleRefreshModelCatalog}
          onClose={handleCloseModelPicker}
        />
      ) : null}
    </View>
  );
}
