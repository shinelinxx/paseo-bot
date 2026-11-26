import {
  useRpc,
  useTranslation,
  type PluginScreenProps,
} from "@getpaseo/plugin/client";
import {
  copyText,
  Icon,
  Markdown,
  Modal,
  ScrollView,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  curateFeedRpc,
  deleteTriggerRpc,
  dismissSuggestionRpc,
  draftMissionRpc,
  ensureChiefBotRpc,
  executeFeedActionRpc,
  installPresetRpc,
  manageNativeScheduleRpc,
  manageWorkerRpc,
  markFeedReadRpc,
  resolveApprovalRpc,
  runTriggerNowRpc,
  saveMemoryRpc,
  setGlobalPauseRpc,
  submitWishRpc,
  toggleTriggerRpc,
  upsertTriggerRpc,
  type ApprovalItem,
  type ApprovalRisk,
  type DelegatedWorker,
  type FeedAction,
  type FeedItem,
  type GovernanceLevel,
  type MissionDraft,
  type NativeScheduleItem,
  type PresetId,
  type RoutineSuggestion,
  type TriggerKind,
  type TriggerSpec,
  type WorkerStatus,
} from "../shared/contracts";
import { messages } from "./i18n";
import {
  consumeRequestedConsoleTab,
  useBotSnapshot,
  type BotConsoleTab,
} from "./store";

const TRIGGER_KIND_OPTIONS: readonly TriggerKind[] = [
  "file_watch",
  "poll_command",
  "webhook",
  "schedule",
];

const GOVERNANCE_OPTIONS: readonly GovernanceLevel[] = [
  "autonomous",
  "notify",
  "require_approval",
];

const PRESET_DEFINITIONS = [
  { id: "kb_inbox" as const, titleKey: "presetKbTitle", descKey: "presetKbDesc" },
  {
    id: "universal_webhook" as const,
    titleKey: "presetWebhookTitle",
    descKey: "presetWebhookDesc",
  },
  {
    id: "morning_briefing" as const,
    titleKey: "presetMorningTitle",
    descKey: "presetMorningDesc",
  },
] as const;

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
  emptyBoxSm: { padding: 22, borderRadius: 14, borderWidth: 1, alignItems: "center" },
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
  rowGap10: { flexDirection: "row", gap: 10 },
  colGap2: { gap: 2 },
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
  unreadDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  pillBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  pillBadgePad3: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
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
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  wishInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  wishSubmitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
  },
  tabScroll: { flexGrow: 0 },
  tabChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
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
  modalInput: { borderWidth: 1, borderRadius: 8, padding: 10 },
  modalTextarea: { borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 88 },
  memoryTextarea: { borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 240, fontSize: 13 },
  primaryFullBtn: { paddingVertical: 11, borderRadius: 9, alignItems: "center" },
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
  trustPromoteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderRadius: 9,
    borderWidth: 1,
  },
  rejectBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 15,
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
  urgentBanner: {
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderLeftWidth: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  progressTrack: {
    height: 6,
    borderRadius: 999,
    overflow: "hidden",
    width: 96,
  },
  progressFill: {
    height: 6,
    borderRadius: 999,
  },
  presetRow: { justifyContent: "space-between", gap: 8, padding: 10, borderRadius: 10 },
  presetBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  newMissionBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  optionChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
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
  text14Bold: { fontSize: 14, fontWeight: "700" },
});

function formatShortTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

function isSameLocalDay(iso: string, refDate: Date): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === refDate.getFullYear() &&
    d.getMonth() === refDate.getMonth() &&
    d.getDate() === refDate.getDate()
  );
}

function formatNativeCadence(raw: string): string {
  // e.g. "cron:30 8 * * * (Asia/Shanghai)" or "cron:0 */6 * * * (Asia/Shanghai)"
  const cronMatch = /^cron:([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)(?:\s*\(([^)]+)\))?/.exec(
    raw.trim(),
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

type PluginTheme = PluginScreenProps["theme"];

function useBotTranslation() {
  return useTranslation(messages);
}
type TranslateFn = ReturnType<typeof useBotTranslation>["t"];

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

function describeMissionCadence(trg: TriggerSpec, t: TranslateFn): string {
  if (trg.kind === "file_watch") {
    return `${t("kind_file_watch")} · ${trg.watchPath || trg.cwd}`;
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

const WishHeroBar = memo(function WishHeroBar({
  theme,
  compact,
  globalPaused,
  activeMissionCount,
  pendingApprovalCount,
  totalSilentChecks,
  runningWorkerCount,
  hourlyWakesUsed,
  hourlyWakeLimit,
  webhookBaseUrl,
  t,
  onOpenAgent,
  onTaskQueued,
  onJumpApprovals,
  onCopyText,
}: {
  theme: PluginTheme;
  compact: boolean;
  globalPaused: boolean;
  activeMissionCount: number;
  pendingApprovalCount: number;
  totalSilentChecks: number;
  runningWorkerCount: number;
  hourlyWakesUsed: number;
  hourlyWakeLimit: number;
  webhookBaseUrl: string | null;
  t: TranslateFn;
  onOpenAgent: (agentId: string) => void;
  onTaskQueued: () => void;
  onJumpApprovals: () => void;
  onCopyText: (value: string) => void;
}) {
  const toast = useToast();
  const submitWish = useRpc(submitWishRpc);
  const ensureChief = useRpc(ensureChiefBotRpc);
  const setGlobalPause = useRpc(setGlobalPauseRpc);

  const [wishText, setWishText] = useState("");
  const [submittingWish, setSubmittingWish] = useState(false);
  const [openingChief, setOpeningChief] = useState(false);
  const [telemetryOpen, setTelemetryOpen] = useState(false);

  const dispatchWishText = useCallback(
    async (rawText: string) => {
      const trimmed = rawText.trim();
      if (!trimmed || submittingWish) return;
      setSubmittingWish(true);
      try {
        await submitWish({ wish: trimmed });
        setWishText("");
        toast.show(t("wishSentToast"), { variant: "success" });
        onTaskQueued();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmittingWish(false);
      }
    },
    [onTaskQueued, submitWish, submittingWish, t, toast],
  );

  const handleSendWish = useCallback(async () => {
    await dispatchWishText(wishText);
  }, [dispatchWishText, wishText]);

  const handleOpenChief = useCallback(async () => {
    if (openingChief) return;
    setOpeningChief(true);
    try {
      const res = await ensureChief({});
      onOpenAgent(res.agentId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningChief(false);
    }
  }, [ensureChief, onOpenAgent, openingChief, toast]);

  const handleToggleGlobalPause = useCallback(async () => {
    try {
      await setGlobalPause({ paused: !globalPaused });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [globalPaused, setGlobalPause, toast]);

  // Meta Muse Layer-1 Ambient Status Line
  const ambientStatus = useMemo(() => {
    if (globalPaused) return t("ambientPaused");
    if (pendingApprovalCount > 0) {
      return t("ambientPending", {
        active: activeMissionCount,
        pending: pendingApprovalCount,
      });
    }
    if (activeMissionCount > 0) {
      return t("ambientCalm", {
        active: activeMissionCount,
        silent: totalSilentChecks,
      });
    }
    return t("ambientIdle");
  }, [activeMissionCount, globalPaused, pendingApprovalCount, t, totalSilentChecks]);

  const wakeRatio = Math.min(1, hourlyWakesUsed / Math.max(1, hourlyWakeLimit));
  const canSubmit = wishText.trim().length > 0 && !submittingWish;

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
      <View
        style={{
          flexDirection: compact ? "column" : "row",
          alignItems: compact ? "flex-start" : "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <View style={[styles.rowCenterGap10, styles.flex1]}>
          <View style={[styles.heroIconBox, { backgroundColor: theme.colors.accent }]}>
            <Icon name="Bot" size={18} color={theme.colors.accentForeground} />
          </View>
          <View style={styles.flex1Gap2}>
            <View style={styles.rowCenterGap8}>
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: compact ? 17 : 19,
                  fontWeight: "700",
                }}
              >
                Paseo Bot
              </Text>
              <View style={[styles.pillBadge, { backgroundColor: theme.colors.surface2 }]}>
                <Text
                  style={[
                    styles.pillBadgeText,
                    {
                      color: globalPaused
                        ? theme.colors.statusWarning
                        : theme.colors.statusSuccess,
                    },
                  ]}
                >
                  {globalPaused ? t("statusPaused") : t("statusActive")}
                </Text>
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={
                pendingApprovalCount > 0
                  ? onJumpApprovals
                  : () => setTelemetryOpen((v) => !v)
              }
            >
              <Text
                style={[
                  styles.text12,
                  {
                    color:
                      pendingApprovalCount > 0
                        ? theme.colors.statusWarning
                        : theme.colors.foregroundMuted,
                  },
                ]}
              >
                {ambientStatus}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.rowWrapGap8}>
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

          <Pressable
            accessibilityRole="button"
            onPress={() => void handleToggleGlobalPause()}
            style={[
              styles.actionBtn,
              {
                backgroundColor: theme.colors.surface2,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <Icon
              name={globalPaused ? "Play" : "Pause"}
              size={14}
              color={theme.colors.foreground}
            />
            <Text style={[styles.text12, { color: theme.colors.foreground }]}>
              {globalPaused ? t("resumeAll") : t("pauseAll")}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => setTelemetryOpen((v) => !v)}
            style={[
              styles.actionBtn,
              {
                backgroundColor: telemetryOpen ? theme.colors.surface0 : theme.colors.surface2,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <Icon
              name="SlidersHorizontal"
              size={13}
              color={theme.colors.foregroundMuted}
            />
            <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
              {t("telemetryToggle")}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Meta Muse Layer-2 Collapsible System Telemetry Drawer */}
      {telemetryOpen ? (
        <View
          style={[
            styles.insetBox,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
            },
          ]}
        >
          <View style={styles.rowWrapGap8}>
            <View style={styles.rowCenterGap8}>
              <Text style={[styles.text12, { color: theme.colors.foreground }]}>
                {t("wakeBudget", { used: hourlyWakesUsed, limit: hourlyWakeLimit })}
              </Text>
              <View
                style={[
                  styles.progressTrack,
                  { backgroundColor: theme.colors.surface0 },
                ]}
              >
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${Math.round(wakeRatio * 100)}%`,
                      backgroundColor:
                        wakeRatio > 0.85
                          ? theme.colors.statusWarning
                          : theme.colors.accent,
                    },
                  ]}
                />
              </View>
            </View>

            <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
              ·  {t("runningWorkersStat", { count: runningWorkerCount })}
            </Text>

            {webhookBaseUrl ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => onCopyText(webhookBaseUrl)}
                style={styles.rowCenterGap6}
              >
                <Icon name="Copy" size={12} color={theme.colors.accent} />
                <Text style={[styles.text12, { color: theme.colors.accent }]}>
                  {webhookBaseUrl}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      <View style={{ flexDirection: compact ? "column" : "row", gap: 8 }}>
        <TextInput
          value={wishText}
          onChangeText={setWishText}
          onSubmitEditing={() => void handleSendWish()}
          placeholder={t("wishPlaceholder")}
          placeholderTextColor={theme.colors.foregroundMuted}
          style={[
            styles.wishInput,
            {
              borderColor: theme.colors.border,
              color: theme.colors.foreground,
              backgroundColor: theme.colors.surface2,
            },
          ]}
        />
        <Pressable
          accessibilityRole="button"
          disabled={!canSubmit}
          onPress={() => void handleSendWish()}
          style={[
            styles.wishSubmitBtn,
            {
              backgroundColor: theme.colors.accent,
              opacity: canSubmit ? 1 : 0.5,
            },
          ]}
        >
          <Icon name="Sparkles" size={15} color={theme.colors.accentForeground} />
          <Text style={[styles.text13Bold, { color: theme.colors.accentForeground }]}>
            {submittingWish ? t("wishSubmitting") : t("wishSubmit")}
          </Text>
        </Pressable>
      </View>

      {/* Poke Contextual Quick-Intent Chips */}
      <View style={styles.rowWrapGap6}>
        <Pressable
          accessibilityRole="button"
          disabled={submittingWish}
          onPress={() => void dispatchWishText(t("quickPokeMorningWish"))}
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
          disabled={submittingWish}
          onPress={() => void dispatchWishText(t("quickPokeInboxWish"))}
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
          disabled={submittingWish}
          onPress={() => void dispatchWishText(t("quickPokeAuditWish"))}
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

const FeedItemCard = memo(function FeedItemCard({
  item,
  theme,
  t,
  openAgentLabel,
  onOpenAgent,
  onMarkRead,
}: {
  item: FeedItem;
  theme: PluginTheme;
  t: TranslateFn;
  openAgentLabel: string;
  onOpenAgent: (agentId: string) => void;
  onMarkRead: (id: string) => void;
}) {
  const toast = useToast();
  const runAction = useRpc(executeFeedActionRpc);
  const curateFeed = useRpc(curateFeedRpc);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [calibrateOpen, setCalibrateOpen] = useState(false);
  const [ruleNote, setRuleNote] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

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
      try {
        const res = await runAction({ feedId: item.id, actionId: act.id });
        toast.show(res.message, { variant: res.ok ? "success" : "warning" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, item.id, runAction, toast],
  );

  const handleSnooze = useCallback(async () => {
    if (busyKey) return;
    setBusyKey("snooze");
    try {
      const res = await runAction({
        feedId: item.id,
        customKind: "snooze",
        delayMinutes: 120,
      });
      toast.show(res.message, { variant: "info" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [busyKey, item.id, runAction, toast]);

  const handleSendInlineReply = useCallback(async () => {
    const clean = replyText.trim();
    if (!clean || busyKey) return;
    setBusyKey("reply");
    try {
      const res = await runAction({
        feedId: item.id,
        customKind: "wish",
        customPrompt: clean,
      });
      setReplyText("");
      setReplyOpen(false);
      toast.show(res.message, { variant: "success" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [busyKey, item.id, replyText, runAction, toast]);

  const handleTasteUp = useCallback(async () => {
    if (busyKey) return;
    setBusyKey("up");
    try {
      await curateFeed({ feedId: item.id, feedback: "up" });
      setCalibrateOpen(false);
      toast.show(t("tasteUpSaved"), { variant: "success" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [busyKey, curateFeed, item.id, t, toast]);

  const handleTasteDown = useCallback(
    async (opts?: { presetNote?: string; muteTrigger?: boolean }) => {
      if (busyKey) return;
      setBusyKey("down");
      try {
        const finalNote = (opts?.presetNote ?? ruleNote).trim() || undefined;
        await curateFeed({
          feedId: item.id,
          feedback: "down",
          ruleNote: finalNote,
          muteTrigger: opts?.muteTrigger,
        });
        setCalibrateOpen(false);
        setRuleNote("");
        toast.show(t("tasteDownSaved"), { variant: "info" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, curateFeed, item.id, ruleNote, t, toast],
  );

  const actions = item.actions ?? [];
  const showInteractiveBar = item.level !== "silent";

  return (
    <View
      style={[
        styles.card12,
        {
          borderColor: item.unread ? badgeColor : theme.colors.border,
          backgroundColor: theme.colors.surface1,
        },
      ]}
    >
      <View style={styles.rowCenterBetween}>
        <View style={[styles.rowCenterGap8, styles.flex1]}>
          {item.unread ? (
            <View style={[styles.unreadDot, { backgroundColor: badgeColor }]} />
          ) : null}
          <Text style={[styles.title14, styles.flex1, { color: theme.colors.foreground }]}>
            {item.title}
          </Text>
        </View>
        <View style={styles.rowCenterGap8}>
          {item.inProgress ? (
            <View style={[styles.pillBadge, { backgroundColor: theme.colors.surface2 }]}>
              <Text style={[styles.text11Bold, { color: theme.colors.accent }]}>
                {t("inProgressBadge")}
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
            {formatShortTime(item.createdAt)}
          </Text>
        </View>
      </View>

      {item.details && item.details.startsWith(item.summary.slice(0, 48)) ? (
        <View style={styles.colGap6}>
          <Markdown>{detailsOpen ? item.details : item.summary}</Markdown>
          <Pressable
            accessibilityRole="button"
            onPress={() => setDetailsOpen((v) => !v)}
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
                onPress={() => setDetailsOpen((v) => !v)}
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

      {/* Poke Rich Micro-Actions + ChatGPT Pulse Taste Curation */}
      {showInteractiveBar ? (
        <View style={styles.rowWrapGap6}>
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
              setCalibrateOpen(false);
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

          <Pressable
            accessibilityRole="button"
            disabled={busyKey !== null || Boolean(item.snoozedUntil)}
            onPress={() => void handleSnooze()}
            style={[
              styles.microActionBtn,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <Icon name="Clock" size={12} color={theme.colors.foregroundMuted} />
            <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
              {item.snoozedUntil
                ? `${t("snoozedBadge")} ${formatShortTime(item.snoozedUntil)}`
                : t("snooze2h")}
            </Text>
          </Pressable>

          {item.routedAgentId && item.routedAgentId !== item.agentId ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => onOpenAgent(item.routedAgentId!)}
              style={[
                styles.microActionBtn,
                {
                  borderColor: theme.colors.accent,
                  backgroundColor: theme.colors.surface2,
                },
              ]}
            >
              <Icon name="ArrowUpRight" size={12} color={theme.colors.accent} />
              <Text style={[styles.text12Semi, { color: theme.colors.accent }]}>
                {t("routedSessionBtn", {
                  title: item.routedAgentTitle || item.routedAgentId.slice(0, 8),
                })}
              </Text>
            </Pressable>
          ) : null}

          {item.agentId ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => onOpenAgent(item.agentId!)}
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

          <Pressable
            accessibilityRole="button"
            disabled={busyKey !== null}
            onPress={() => void handleTasteUp()}
            style={[
              styles.microActionBtn,
              {
                borderColor:
                  item.feedback === "up" ? theme.colors.statusSuccess : theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <Icon
              name="ThumbsUp"
              size={12}
              color={
                item.feedback === "up"
                  ? theme.colors.statusSuccess
                  : theme.colors.foregroundMuted
              }
            />
            <Text
              style={[
                styles.text11,
                {
                  color:
                    item.feedback === "up"
                      ? theme.colors.statusSuccess
                      : theme.colors.foregroundMuted,
                },
              ]}
            >
              {t("tasteUp")}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={busyKey !== null}
            onPress={() => {
              setCalibrateOpen((v) => !v);
              setReplyOpen(false);
            }}
            style={[
              styles.microActionBtn,
              {
                borderColor:
                  item.feedback === "down" ? theme.colors.statusWarning : theme.colors.border,
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
                      : theme.colors.foregroundMuted,
                },
              ]}
            >
              {t("tasteDown")}
            </Text>
          </Pressable>

          {item.unread ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => onMarkRead(item.id)}
              style={[styles.smallBtn, { backgroundColor: theme.colors.surface2 }]}
            >
              <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
                {t("markRead")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Inline Poke Quick Follow-Up Input */}
      {replyOpen ? (
        <View style={styles.rowGap8}>
          <TextInput
            value={replyText}
            onChangeText={setReplyText}
            onSubmitEditing={() => void handleSendInlineReply()}
            placeholder={t("inlineReplyPlaceholder")}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[
              styles.textInput,
              styles.flex1,
              {
                borderColor: theme.colors.accent,
                color: theme.colors.foreground,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          />
          <Pressable
            accessibilityRole="button"
            disabled={!replyText.trim() || busyKey !== null}
            onPress={() => void handleSendInlineReply()}
            style={[
              styles.microActionBtn,
              {
                borderColor: theme.colors.accent,
                backgroundColor: theme.colors.accent,
                opacity: replyText.trim() ? 1 : 0.5,
              },
            ]}
          >
            <Icon name="Send" size={12} color={theme.colors.accentForeground} />
            <Text style={[styles.text12Bold, { color: theme.colors.accentForeground }]}>
              {t("inlineReplySend")}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* ChatGPT Pulse + Poke Conversational Boundary Calibration */}
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

const PendingApprovalCard = memo(function PendingApprovalCard({
  apr,
  linkedTriggerApprovedCount,
  theme,
  t,
  onResolve,
}: {
  apr: ApprovalItem;
  linkedTriggerApprovedCount: number;
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
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const isEdited = editingDraft && draftText.trim() !== initialPreview.trim();

  const handleDecide = useCallback(
    async (decision: "approved" | "rejected", promoteTrust = false) => {
      if (busy) return;
      setBusy(true);
      try {
        await onResolve(
          apr.id,
          decision,
          note,
          decision === "approved" && isEdited ? draftText.trim() : undefined,
          decision === "approved" && promoteTrust ? true : undefined,
        );
      } finally {
        setBusy(false);
      }
    },
    [apr.id, busy, draftText, isEdited, note, onResolve],
  );

  return (
    <View
      style={[
        styles.card14Padded,
        {
          borderColor: theme.colors.statusWarning,
          backgroundColor: theme.colors.surface1,
        },
      ]}
    >
      <View style={styles.rowCenterBetween}>
        <Text style={[styles.title15, styles.flex1, { color: theme.colors.foreground }]}>
          {apr.title}
        </Text>
        <View style={[styles.pillBadge, { backgroundColor: theme.colors.surface2 }]}>
          <Text style={[styles.text11Bold, { color: theme.colors.statusWarning }]}>
            {t(RISK_LABEL_KEYS[apr.riskLevel])}
          </Text>
        </View>
      </View>

      <Text style={[styles.text13, { color: theme.colors.foreground }]}>
        {apr.actionSummary}
      </Text>
      <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
        {apr.triggerName ? `${apr.triggerName}  ·  ` : ""}
        {apr.cwd}  ·  {formatShortTime(apr.createdAt)}
      </Text>

      {/* OpenAI Dots Staging Preview & Inline Draft Tweak */}
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

      {/* Dots Dynamic Trust Calibration Hint */}
      {apr.triggerId && linkedTriggerApprovedCount >= 1 ? (
        <View
          style={[
            styles.insetBox,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
              paddingVertical: 8,
            },
          ]}
        >
          <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
            {t("trustHint", { count: linkedTriggerApprovedCount })}
          </Text>
        </View>
      ) : null}

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

      <View style={styles.rowWrapGap8}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void handleDecide("approved", false)}
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

        {apr.triggerId ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void handleDecide("approved", true)}
            style={[
              styles.trustPromoteBtn,
              {
                borderColor: theme.colors.accent,
                backgroundColor: theme.colors.surface2,
                opacity: busy ? 0.6 : 1,
              },
            ]}
          >
            <Icon name="Zap" size={14} color={theme.colors.accent} />
            <Text style={[styles.text12Bold, { color: theme.colors.accent }]}>
              {t("approveAndTrust")}
            </Text>
          </Pressable>
        ) : null}

        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void handleDecide("rejected", false)}
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

const ResolvedApprovalRow = memo(function ResolvedApprovalRow({
  apr,
  theme,
  t,
  openAgentLabel,
  onOpenAgent,
}: {
  apr: ApprovalItem;
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
          {formatShortTime(apr.resolvedAt)}
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
        <View style={[styles.pillBadgePad3, { backgroundColor: theme.colors.surface2 }]}>
          <Text
            style={[
              styles.text11Bold,
              {
                color: trg.enabled
                  ? theme.colors.statusSuccess
                  : theme.colors.foregroundMuted,
              },
            ]}
          >
            {trg.enabled ? t("statusActive") : t("statusPaused")}
          </Text>
        </View>
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

      <View style={[styles.rowWrapGap8, { marginTop: 2 }]}>
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
          onPress={() => onEdit(trg)}
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
            onPress={() => onCopyWebhook(webhookUrl)}
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
          onPress={() => onToggle(trg.id, !trg.enabled)}
          style={[styles.smallBtnPad6, { backgroundColor: theme.colors.surface2 }]}
        >
          <Text style={[styles.text12, { color: theme.colors.foreground }]}>
            {trg.enabled ? t("pause") : t("enable")}
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          onPress={() => onDelete(trg.id)}
          style={[styles.smallBtnPad6, { backgroundColor: theme.colors.surface2 }]}
        >
          <Text style={[styles.text12, { color: theme.colors.statusDanger }]}>
            {t("delete")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
});

const NativeScheduleCard = memo(function NativeScheduleCard({
  sched,
  theme,
  t,
  onManage,
}: {
  sched: NativeScheduleItem;
  theme: PluginTheme;
  t: TranslateFn;
  onManage: (id: string, action: "run_once" | "pause" | "resume") => void;
}) {
  const isActive = sched.status === "active";
  const modelLabel = sched.target.replace(/^new-agent:/, "");

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
            {formatNativeCadence(sched.cadence)}
            {modelLabel ? `  ·  ${modelLabel}` : ""}
          </Text>
        </View>
        <View style={[styles.pillBadgePad3, { backgroundColor: theme.colors.surface2 }]}>
          <Text
            style={[
              styles.text11Bold,
              {
                color: isActive
                  ? theme.colors.statusSuccess
                  : theme.colors.foregroundMuted,
              },
            ]}
          >
            {isActive ? t("statusActive") : t("statusPaused")}
          </Text>
        </View>
      </View>

      <View style={styles.rowWrapGap8}>
        {sched.nextRunAt ? (
          <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
            {t("nextRunLabel", { time: formatShortTime(sched.nextRunAt) })}
          </Text>
        ) : null}
        {sched.lastRunAt ? (
          <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
            {t("lastRunLabel", { time: formatShortTime(sched.lastRunAt) })}
          </Text>
        ) : null}
      </View>

      <View style={[styles.rowWrapGap8, { marginTop: 2 }]}>
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

        <Pressable
          accessibilityRole="button"
          onPress={() => onManage(sched.id, isActive ? "pause" : "resume")}
          style={[styles.smallBtnPad6, { backgroundColor: theme.colors.surface2 }]}
        >
          <Text style={[styles.text12, { color: theme.colors.foreground }]}>
            {isActive ? t("pause") : t("enable")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
});

const WorkerCard = memo(function WorkerCard({
  wrk,
  theme,
  t,
  openAgentLabel,
  onOpenAgent,
  onStopWorker,
  onRemoveWorker,
}: {
  wrk: DelegatedWorker;
  theme: PluginTheme;
  t: TranslateFn;
  openAgentLabel: string;
  onOpenAgent: (agentId: string) => void;
  onStopWorker: (id: string) => void;
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
        <Text style={[styles.text11Bold, { color: statusTone }]}>
          {t(WORKER_LABEL_KEYS[wrk.status])}
        </Text>
      </View>
      <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
        {wrk.cwd} ({wrk.isolation})  ·  {wrk.provider}  ·  {formatShortTime(wrk.updatedAt)}
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
  title,
  editLabel,
  onEdit,
}: {
  memoryPath: string;
  memoryContent: string;
  theme: PluginTheme;
  title: string;
  editLabel: string;
  onEdit: () => void;
}) {
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
          <Text style={[styles.title14, { color: theme.colors.foreground }]}>{title}</Text>
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
          <Text style={[styles.text12, { color: theme.colors.foreground }]}>{editLabel}</Text>
        </Pressable>
      </View>
      <Markdown>{memoryContent || "*Memory is currently empty.*"}</Markdown>
    </View>
  );
});

const CreateOrEditMissionModal = memo(function CreateOrEditMissionModal({
  editingTrigger,
  theme,
  t,
  onClose,
}: {
  editingTrigger: TriggerSpec | null;
  theme: PluginTheme;
  t: TranslateFn;
  onClose: () => void;
}) {
  const toast = useToast();
  const draftMission = useRpc(draftMissionRpc);
  const upsertTrigger = useRpc(upsertTriggerRpc);

  const isEdit = Boolean(editingTrigger);
  const [intentText, setIntentText] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [proposedDraft, setProposedDraft] = useState<MissionDraft | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(isEdit);

  const [newName, setNewName] = useState(editingTrigger?.name ?? "");
  const [newKind, setNewKind] = useState<TriggerKind>(
    editingTrigger?.kind ?? "file_watch",
  );
  const [newGovernance, setNewGovernance] = useState<GovernanceLevel>(
    editingTrigger?.governance ?? "notify",
  );
  const [newWatchPath, setNewWatchPath] = useState(
    editingTrigger?.watchPath ?? "~/Documents/KnowledgeBase/00-Inbox",
  );
  const [newPollCmd, setNewPollCmd] = useState(editingTrigger?.pollCommand ?? "");
  const [newInterval, setNewInterval] = useState(
    String(editingTrigger?.pollIntervalSec ?? 300),
  );
  const [newDailyTime, setNewDailyTime] = useState(editingTrigger?.dailyTime ?? "");
  const [newCwd, setNewCwd] = useState(
    editingTrigger?.cwd ?? "~/Documents/KnowledgeBase",
  );
  const [newPrompt, setNewPrompt] = useState(editingTrigger?.prompt ?? "");
  const [noiseRules, setNoiseRules] = useState<string[]>(
    editingTrigger?.noiseRules ?? [],
  );

  const inputThemeStyle = useMemo(
    () => ({
      borderColor: theme.colors.border,
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
    }),
    [theme.colors.border, theme.colors.foreground, theme.colors.surface2],
  );

  const applyDraftFields = useCallback((d: MissionDraft) => {
    setProposedDraft(d);
    setNewName(d.name);
    setNewKind(d.kind);
    setNewGovernance(d.governance ?? "notify");
    if (d.watchPath) setNewWatchPath(d.watchPath);
    setNewPollCmd(d.pollCommand ?? "");
    setNewInterval(String(d.pollIntervalSec ?? 300));
    setNewDailyTime(d.dailyTime ?? "");
    if (d.cwd) setNewCwd(d.cwd);
    setNewPrompt(d.prompt);
  }, []);

  const handleGenerateDraft = useCallback(
    async (overrideIntent?: string) => {
      const clean = (overrideIntent ?? intentText).trim();
      if (!clean || drafting) return;
      if (overrideIntent) setIntentText(overrideIntent);
      setDrafting(true);
      try {
        const res = await draftMission({ intent: clean });
        applyDraftFields(res.draft);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setDrafting(false);
      }
    },
    [applyDraftFields, draftMission, drafting, intentText, toast],
  );

  const handleSave = useCallback(async () => {
    if (!newName.trim() || !newPrompt.trim()) {
      toast.error(t("missionMissingFields"));
      return;
    }
    const intervalNum = Number.parseInt(newInterval, 10);
    try {
      await upsertTrigger({
        id: editingTrigger?.id,
        name: newName.trim(),
        description: proposedDraft?.description ?? editingTrigger?.description,
        kind: newKind,
        governance: newGovernance,
        cwd: newCwd.trim() || undefined,
        prompt: newPrompt.trim(),
        watchPath: newKind === "file_watch" ? newWatchPath.trim() : undefined,
        pollCommand: newKind === "poll_command" ? newPollCmd.trim() : undefined,
        pollIntervalSec:
          Number.isFinite(intervalNum) && intervalNum >= 10 ? intervalNum : 300,
        dailyTime:
          newKind === "schedule" && newDailyTime.trim() ? newDailyTime.trim() : undefined,
        noiseRules: isEdit ? noiseRules : undefined,
      });
      onClose();
      toast.show(isEdit ? t("missionUpdatedToast") : t("missionSavedToast"), {
        variant: "success",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [
    editingTrigger?.description,
    editingTrigger?.id,
    isEdit,
    newCwd,
    newDailyTime,
    newGovernance,
    newInterval,
    newKind,
    newName,
    newPollCmd,
    newPrompt,
    newWatchPath,
    noiseRules,
    onClose,
    proposedDraft?.description,
    t,
    toast,
    upsertTrigger,
  ]);

  return (
    <Modal
      title={isEdit ? t("modalEditTitle") : t("modalNewTitle")}
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content>
        <View style={styles.colGap12}>
          {/* Poke Conversational Intent-First Builder (Create Mode) */}
          {!isEdit ? (
            <View style={styles.colGap8}>
              <Text style={[styles.text12Semi, { color: theme.colors.foreground }]}>
                {t("intentPromptLabel")}
              </Text>
              <TextInput
                value={intentText}
                onChangeText={setIntentText}
                onSubmitEditing={() => void handleGenerateDraft()}
                placeholder={t("intentInputPlaceholder")}
                placeholderTextColor={theme.colors.foregroundMuted}
                style={[styles.modalInput, inputThemeStyle]}
              />

              <View style={styles.rowWrapGap6}>
                {(["intentExample1", "intentExample2", "intentExample3"] as const).map(
                  (key) => {
                    const label = t(key);
                    return (
                      <Pressable
                        key={key}
                        accessibilityRole="button"
                        onPress={() => void handleGenerateDraft(label)}
                        style={[
                          styles.quickPokeChip,
                          {
                            borderColor: theme.colors.border,
                            backgroundColor: theme.colors.surface2,
                          },
                        ]}
                      >
                        <Text style={[styles.text11, { color: theme.colors.foreground }]}>
                          {label}
                        </Text>
                      </Pressable>
                    );
                  },
                )}
              </View>

              <Pressable
                accessibilityRole="button"
                disabled={!intentText.trim() || drafting}
                onPress={() => void handleGenerateDraft()}
                style={[
                  styles.primaryFullBtn,
                  {
                    backgroundColor: proposedDraft
                      ? theme.colors.surface2
                      : theme.colors.accent,
                    borderWidth: proposedDraft ? 1 : 0,
                    borderColor: theme.colors.border,
                    opacity: intentText.trim() ? 1 : 0.5,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.text13Bold,
                    {
                      color: proposedDraft
                        ? theme.colors.foreground
                        : theme.colors.accentForeground,
                    },
                  ]}
                >
                  {drafting ? t("intentDrafting") : t("intentDraftBtn")}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {/* Proposed Smart Plan Card */}
          {proposedDraft ? (
            <View
              style={[
                styles.insetBox,
                {
                  borderColor: theme.colors.accent,
                  backgroundColor: theme.colors.surface2,
                },
              ]}
            >
              <Text style={[styles.text11Bold, { color: theme.colors.accent }]}>
                {t("draftPreviewTitle")}
              </Text>
              <Text style={[styles.title14, { color: theme.colors.foreground }]}>
                {newName}
              </Text>
              <Text style={[styles.text12, { color: theme.colors.foreground }]}>
                {proposedDraft.humanSummary}
              </Text>
              <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
                {proposedDraft.rationale}
              </Text>
            </View>
          ) : null}

          {/* Toggle Advanced Engineering Controls */}
          {!isEdit ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setAdvancedOpen((v) => !v)}
              style={styles.rowCenterGap6}
            >
              <Icon
                name={advancedOpen ? "ChevronUp" : "ChevronDown"}
                size={14}
                color={theme.colors.foregroundMuted}
              />
              <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                {advancedOpen ? t("advancedHide") : t("advancedShow")}
              </Text>
            </Pressable>
          ) : null}

          {advancedOpen ? (
            <View style={styles.colGap10}>
              <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                {t("fieldName")}
              </Text>
              <TextInput
                value={newName}
                onChangeText={setNewName}
                placeholder="例如：每日早间汇总"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={[styles.modalInput, inputThemeStyle]}
              />

              <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                {t("fieldKind")}
              </Text>
              <View style={styles.rowWrapGap6}>
                {TRIGGER_KIND_OPTIONS.map((k) => (
                  <Pressable
                    key={k}
                    accessibilityRole="button"
                    onPress={() => setNewKind(k)}
                    style={[
                      styles.optionChip,
                      {
                        backgroundColor:
                          newKind === k ? theme.colors.accent : theme.colors.surface2,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.text12Semi,
                        {
                          color:
                            newKind === k
                              ? theme.colors.accentForeground
                              : theme.colors.foreground,
                        },
                      ]}
                    >
                      {t(KIND_LABEL_KEYS[k])}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {newKind === "file_watch" ? (
                <>
                  <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                    {t("fieldTargetPath")}
                  </Text>
                  <TextInput
                    value={newWatchPath}
                    onChangeText={setNewWatchPath}
                    style={[styles.modalInput, inputThemeStyle]}
                  />
                </>
              ) : null}

              {newKind === "poll_command" ? (
                <>
                  <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                    {t("fieldPollCmd")}
                  </Text>
                  <TextInput
                    value={newPollCmd}
                    onChangeText={setNewPollCmd}
                    placeholder="ls -la 00-Inbox 或 https://api.example.com/status"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={[styles.modalInput, inputThemeStyle]}
                  />
                </>
              ) : null}

              {newKind === "poll_command" || newKind === "schedule" ? (
                <>
                  <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                    {t("fieldInterval")}
                  </Text>
                  <TextInput
                    value={newInterval}
                    onChangeText={setNewInterval}
                    style={[styles.modalInput, inputThemeStyle]}
                  />
                </>
              ) : null}

              {newKind === "schedule" ? (
                <>
                  <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                    {t("fieldDailyTime")}
                  </Text>
                  <TextInput
                    value={newDailyTime}
                    onChangeText={setNewDailyTime}
                    placeholder="08:30"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={[styles.modalInput, inputThemeStyle]}
                  />
                </>
              ) : null}

              <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                {t("fieldGovernance")}
              </Text>
              <View style={styles.rowWrapGap6}>
                {GOVERNANCE_OPTIONS.map((g) => (
                  <Pressable
                    key={g}
                    accessibilityRole="button"
                    onPress={() => setNewGovernance(g)}
                    style={[
                      styles.optionChip,
                      {
                        backgroundColor:
                          newGovernance === g ? theme.colors.accent : theme.colors.surface2,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.text12,
                        {
                          color:
                            newGovernance === g
                              ? theme.colors.accentForeground
                              : theme.colors.foreground,
                        },
                      ]}
                    >
                      {t(GOV_LABEL_KEYS[g])}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                {t("fieldCwd")}
              </Text>
              <TextInput
                value={newCwd}
                onChangeText={setNewCwd}
                style={[styles.modalInput, inputThemeStyle]}
              />

              <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                {t("fieldPrompt")}
              </Text>
              <TextInput
                value={newPrompt}
                onChangeText={setNewPrompt}
                multiline
                placeholder="说明触发后需要检查什么、遇到什么情况发送提醒…"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={[styles.modalTextarea, inputThemeStyle]}
              />

              {isEdit && noiseRules.length > 0 ? (
                <View style={styles.colGap6}>
                  <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                    {t("noiseRulesLabel")}
                  </Text>
                  <View style={styles.rowWrapGap6}>
                    {noiseRules.map((rule, idx) => (
                      <Pressable
                        key={`${idx}-${rule}`}
                        accessibilityRole="button"
                        onPress={() =>
                          setNoiseRules((prev) => prev.filter((_, i) => i !== idx))
                        }
                        style={[
                          styles.microActionBtn,
                          {
                            borderColor: theme.colors.border,
                            backgroundColor: theme.colors.surface2,
                          },
                        ]}
                      >
                        <Text style={[styles.text11, { color: theme.colors.foreground }]}>
                          {rule}
                        </Text>
                        <Icon name="X" size={11} color={theme.colors.foregroundMuted} />
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : null}
            </View>
          ) : null}

          {isEdit || proposedDraft || advancedOpen ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void handleSave()}
              style={[styles.primaryFullBtn, { backgroundColor: theme.colors.accent }]}
            >
              <Text style={[styles.text14Bold, { color: theme.colors.accentForeground }]}>
                {isEdit ? t("saveChangesBtn") : t("createBtn")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
});

const MemoryEditorModal = memo(function MemoryEditorModal({
  initialContent,
  theme,
  t,
  onClose,
}: {
  initialContent: string;
  theme: PluginTheme;
  t: TranslateFn;
  onClose: () => void;
}) {
  const toast = useToast();
  const saveMemory = useRpc(saveMemoryRpc);
  const [memoryDraft, setMemoryDraft] = useState(initialContent);

  const handleSave = useCallback(async () => {
    try {
      await saveMemory({ content: memoryDraft });
      onClose();
      toast.show(t("memorySavedToast"), { variant: "success" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [memoryDraft, onClose, saveMemory, t, toast]);

  return (
    <Modal
      title={t("memorySectionTitle")}
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content>
        <View style={styles.colGap12}>
          <TextInput
            value={memoryDraft}
            onChangeText={setMemoryDraft}
            multiline
            style={[
              styles.memoryTextarea,
              {
                borderColor: theme.colors.border,
                color: theme.colors.foreground,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => void handleSave()}
            style={[styles.primaryFullBtn, { backgroundColor: theme.colors.accent }]}
          >
            <Text style={[styles.text14Bold, { color: theme.colors.accentForeground }]}>
              {t("saveMemory")}
            </Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
});

export function BotConsoleScreen({
  theme,
  layout,
  params,
  navigation,
}: PluginScreenProps) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const snap = useBotSnapshot();

  const installPreset = useRpc(installPresetRpc);
  const upsertTrigger = useRpc(upsertTriggerRpc);
  const toggleTrigger = useRpc(toggleTriggerRpc);
  const deleteTrigger = useRpc(deleteTriggerRpc);
  const runTriggerNow = useRpc(runTriggerNowRpc);
  const resolveApproval = useRpc(resolveApprovalRpc);
  const markFeedRead = useRpc(markFeedReadRpc);
  const dismissSuggestion = useRpc(dismissSuggestionRpc);
  const manageWorker = useRpc(manageWorkerRpc);
  const manageNativeSchedule = useRpc(manageNativeScheduleRpc);

  const [activeTab, setActiveTab] = useState<BotConsoleTab>("inbox");
  const [showSilent, setShowSilent] = useState(false);
  const [missionModalState, setMissionModalState] = useState<{
    open: boolean;
    editing: TriggerSpec | null;
  }>({ open: false, editing: null });
  const [memoryModalOpen, setMemoryModalOpen] = useState(false);

  useEffect(() => {
    const reqTab = consumeRequestedConsoleTab();
    if (reqTab) {
      setActiveTab(reqTab);
      return;
    }
    const paramTab = params.tab;
    if (
      paramTab === "inbox" ||
      paramTab === "approvals" ||
      paramTab === "missions" ||
      paramTab === "workers"
    ) {
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

  const handleAcceptSuggestion = useCallback(
    async (sug: RoutineSuggestion) => {
      try {
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
        await dismissSuggestion({ suggestionId: sug.id });
        toast.show(t("routineAcceptedToast"), { variant: "success" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [dismissSuggestion, t, toast, upsertTrigger],
  );

  const handleDismissSuggestion = useCallback(
    (id: string) => {
      void dismissSuggestion({ suggestionId: id });
    },
    [dismissSuggestion],
  );

  const handleMarkFeedRead = useCallback(
    (id: string) => {
      void markFeedRead({ id });
    },
    [markFeedRead],
  );

  const handleResolveApproval = useCallback(
    async (
      id: string,
      decision: "approved" | "rejected",
      note: string,
      editedFollowUpPrompt?: string,
      promoteTrust?: boolean,
    ) => {
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

  const handleToggleTrigger = useCallback(
    (id: string, enabled: boolean) => {
      void toggleTrigger({ id, enabled });
    },
    [toggleTrigger],
  );

  const handleDeleteTrigger = useCallback(
    (id: string) => {
      void deleteTrigger({ id });
    },
    [deleteTrigger],
  );

  const handleOpenNewMission = useCallback(() => {
    setMissionModalState({ open: true, editing: null });
  }, []);

  const handleOpenEditMission = useCallback((trg: TriggerSpec) => {
    setMissionModalState({ open: true, editing: trg });
  }, []);

  const handleCloseMissionModal = useCallback(() => {
    setMissionModalState({ open: false, editing: null });
  }, []);

  const handleOpenMemoryModal = useCallback(() => {
    setMemoryModalOpen(true);
  }, []);

  const handleCloseMemoryModal = useCallback(() => {
    setMemoryModalOpen(false);
  }, []);

  const handleJumpApprovals = useCallback(() => {
    setActiveTab("approvals");
  }, []);

  const handleTaskQueued = useCallback(() => {
    setActiveTab("inbox");
  }, []);

  const handleManageNativeSchedule = useCallback(
    (id: string, action: "run_once" | "pause" | "resume") => {
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

  const handleRemoveWorker = useCallback(
    (workerId: string) => {
      void manageWorker({ action: "remove", workerId });
    },
    [manageWorker],
  );

  const handleClearFinishedWorkers = useCallback(() => {
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
  }, [manageWorker, t, toast]);

  const { todayFeed, earlierFeed } = useMemo(() => {
    const filtered = showSilent
      ? snap.feed
      : snap.feed.filter((item) => item.level !== "silent");
    const now = new Date();
    const today: FeedItem[] = [];
    const earlier: FeedItem[] = [];
    for (const f of filtered) {
      if (isSameLocalDay(f.createdAt, now)) today.push(f);
      else earlier.push(f);
    }
    return { todayFeed: today, earlierFeed: earlier };
  }, [showSilent, snap.feed]);

  const { pendingApprovals, resolvedApprovals } = useMemo(() => {
    const pending: ApprovalItem[] = [];
    const resolved: ApprovalItem[] = [];
    for (const a of snap.approvals) {
      if (a.status === "pending") pending.push(a);
      else if (resolved.length < 10) resolved.push(a);
    }
    return { pendingApprovals: pending, resolvedApprovals: resolved };
  }, [snap.approvals]);

  const triggerApprovedMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const trg of snap.triggers) {
      map.set(trg.id, trg.approvedCount || 0);
    }
    return map;
  }, [snap.triggers]);

  const nativeSchedules = snap.nativeSchedules ?? [];

  const activeMissionCount = useMemo(() => {
    let count = 0;
    for (const m of snap.triggers) if (m.enabled) count += 1;
    for (const s of nativeSchedules) if (s.status === "active") count += 1;
    return count;
  }, [nativeSchedules, snap.triggers]);

  const hasFinishedWorkers = useMemo(
    () =>
      snap.workers.some(
        (w) => w.status !== "running" && w.status !== "permission",
      ),
    [snap.workers],
  );

  const pad = layout.compact ? 14 : 22;
  const openAgentLabel = t("openAgent");

  const tabs = useMemo<
    Array<{ id: BotConsoleTab; label: string; icon: string; badge?: number }>
  >(
    () => [
      {
        id: "inbox",
        label: t("tabInbox", { count: snap.unreadCount }),
        icon: "Bell",
        badge: snap.unreadCount,
      },
      {
        id: "approvals",
        label: t("tabApprovals", { count: pendingApprovals.length }),
        icon: "ShieldAlert",
        badge: pendingApprovals.length,
      },
      {
        id: "missions",
        label: t("tabMissions", { count: activeMissionCount }),
        icon: "Radar",
      },
      {
        id: "workers",
        label: t("tabWorkers", { count: snap.runningWorkerCount }),
        icon: "Cpu",
        badge: snap.runningWorkerCount,
      },
    ],
    [
      activeMissionCount,
      pendingApprovals.length,
      snap.runningWorkerCount,
      snap.unreadCount,
      t,
    ],
  );

  const suggestions = snap.routineSuggestions ?? [];
  const totalVisibleFeed = todayFeed.length + earlierFeed.length;

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
          globalPaused={snap.globalPaused}
          activeMissionCount={activeMissionCount}
          pendingApprovalCount={pendingApprovals.length}
          totalSilentChecks={snap.totalSilentChecks ?? 0}
          runningWorkerCount={snap.runningWorkerCount}
          hourlyWakesUsed={snap.hourlyWakesUsed}
          hourlyWakeLimit={snap.hourlyWakeLimit}
          webhookBaseUrl={snap.webhookBaseUrl}
          t={t}
          onOpenAgent={openAgentSession}
          onTaskQueued={handleTaskQueued}
          onJumpApprovals={handleJumpApprovals}
          onCopyText={handleCopyText}
        />

        {/* Horizontal Tab Bar */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabScroll}>
          <View style={styles.rowGap8}>
            {tabs.map((tab) => {
              const selected = activeTab === tab.id;
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
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        {/* TAB 1: PULSE BRIEFING DECK */}
        {activeTab === "inbox" ? (
          <View style={styles.colGap12}>
            {/* Urgent Inline Approval Strip (Zero Tab Hunting) */}
            {pendingApprovals.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                onPress={handleJumpApprovals}
                style={[
                  styles.urgentBanner,
                  {
                    borderColor: theme.colors.border,
                    borderLeftColor: theme.colors.statusWarning,
                    backgroundColor: theme.colors.surface1,
                  },
                ]}
              >
                <View style={[styles.rowCenterGap8, styles.flex1]}>
                  <Icon name="ShieldAlert" size={16} color={theme.colors.statusWarning} />
                  <Text style={[styles.text13Semi, styles.flex1, { color: theme.colors.foreground }]}>
                    {t("urgentApprovalBanner", { count: pendingApprovals.length })}
                  </Text>
                </View>
                <View style={[styles.pillBadgePad3, { backgroundColor: theme.colors.statusWarning }]}>
                  <Text style={[styles.text11Bold, { color: theme.colors.surface0 }]}>
                    {t("urgentApprovalAction")}
                  </Text>
                </View>
              </Pressable>
            ) : null}

            {/* xAI Grok Bot Watch & Learn Routine Suggestions */}
            {suggestions.map((sug) => (
              <RoutineSuggestionCard
                key={sug.id}
                sug={sug}
                theme={theme}
                t={t}
                onAccept={handleAcceptSuggestion}
                onDismiss={handleDismissSuggestion}
              />
            ))}

            <View style={[styles.rowCenterBetween, { flexWrap: "wrap" }]}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setShowSilent((prev) => !prev)}
                style={[
                  styles.smallBorderBtn,
                  {
                    backgroundColor: theme.colors.surface1,
                    borderColor: theme.colors.border,
                  },
                ]}
              >
                <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                  {showSilent ? t("hideSilent") : t("showSilent")}
                </Text>
              </Pressable>

              {snap.unreadCount > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void markFeedRead({})}
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
              ) : null}
            </View>

            {totalVisibleFeed === 0 ? (
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
                  {t("emptyInbox")}
                </Text>
              </View>
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
                        theme={theme}
                        t={t}
                        openAgentLabel={openAgentLabel}
                        onOpenAgent={openAgentSession}
                        onMarkRead={handleMarkFeedRead}
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
                        theme={theme}
                        t={t}
                        openAgentLabel={openAgentLabel}
                        onOpenAgent={openAgentSession}
                        onMarkRead={handleMarkFeedRead}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            )}
          </View>
        ) : null}

        {/* TAB 2: SENTINEL STAGING & PROGRESSIVE TRUST */}
        {activeTab === "approvals" ? (
          <View style={styles.colGap12}>
            {pendingApprovals.length === 0 ? (
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
                  {t("emptyApprovals")}
                </Text>
              </View>
            ) : (
              pendingApprovals.map((apr) => (
                <PendingApprovalCard
                  key={apr.id}
                  apr={apr}
                  linkedTriggerApprovedCount={
                    apr.triggerId ? (triggerApprovedMap.get(apr.triggerId) ?? 0) : 0
                  }
                  theme={theme}
                  t={t}
                  onResolve={handleResolveApproval}
                />
              ))
            )}

            {resolvedApprovals.map((apr) => (
              <ResolvedApprovalRow
                key={apr.id}
                apr={apr}
                theme={theme}
                t={t}
                openAgentLabel={openAgentLabel}
                onOpenAgent={openAgentSession}
              />
            ))}
          </View>
        ) : null}

        {/* TAB 3: ROUTINES / MISSIONS */}
        {activeTab === "missions" ? (
          <View style={styles.colGap14}>
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
              <View style={styles.rowCenterBetween}>
                <Text style={[styles.title14, { color: theme.colors.foreground }]}>
                  {t("presetsTitle")}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={handleOpenNewMission}
                  style={[styles.newMissionBtn, { backgroundColor: theme.colors.accent }]}
                >
                  <Text style={[styles.text12Bold, { color: theme.colors.accentForeground }]}>
                    {t("newMission")}
                  </Text>
                </Pressable>
              </View>

              {PRESET_DEFINITIONS.map((preset) => (
                <View
                  key={preset.id}
                  style={[
                    styles.presetRow,
                    {
                      flexDirection: layout.compact ? "column" : "row",
                      alignItems: layout.compact ? "flex-start" : "center",
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
                    onPress={() => void handleInstallPreset(preset.id)}
                    style={[
                      styles.presetBtn,
                      {
                        borderColor: theme.colors.border,
                        backgroundColor: theme.colors.surface1,
                      },
                    ]}
                  >
                    <Text style={[styles.text12Semi, { color: theme.colors.foreground }]}>
                      {t("addPreset")}
                    </Text>
                  </Pressable>
                </View>
              ))}
            </View>

            {nativeSchedules.length > 0 ? (
              <View style={styles.colGap10}>
                <Text style={[styles.sectionHeader, { color: theme.colors.foregroundMuted }]}>
                  {t("nativeSchedulesTitle", { count: nativeSchedules.length })}
                </Text>
                {nativeSchedules.map((sched) => (
                  <NativeScheduleCard
                    key={sched.id}
                    sched={sched}
                    theme={theme}
                    t={t}
                    onManage={handleManageNativeSchedule}
                  />
                ))}
              </View>
            ) : null}

            {snap.triggers.length > 0 && nativeSchedules.length > 0 ? (
              <Text style={[styles.sectionHeader, { color: theme.colors.foregroundMuted }]}>
                {t("pluginRulesTitle", { count: snap.triggers.length })}
              </Text>
            ) : null}

            {snap.triggers.length === 0 && nativeSchedules.length === 0 ? (
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
                  {t("emptyMissions")}
                </Text>
              </View>
            ) : (
              snap.triggers.map((trg) => (
                <MissionCard
                  key={trg.id}
                  trg={trg}
                  webhookBaseUrl={snap.webhookBaseUrl}
                  theme={theme}
                  t={t}
                  onRunNow={handleRunTriggerNow}
                  onEdit={handleOpenEditMission}
                  onCopyWebhook={handleCopyText}
                  onToggle={handleToggleTrigger}
                  onDelete={handleDeleteTrigger}
                />
              ))
            )}
          </View>
        ) : null}

        {/* TAB 4: WORKERS & PERSISTENT MEMORY */}
        {activeTab === "workers" ? (
          <View style={styles.colGap16}>
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
                    <Text style={[styles.text12, { color: theme.colors.foregroundMuted }]}>
                      {t("clearFinishedWorkers")}
                    </Text>
                  </Pressable>
                </View>
              ) : null}

              {snap.workers.length === 0 ? (
                <View
                  style={[
                    styles.emptyBoxSm,
                    {
                      borderColor: theme.colors.border,
                      backgroundColor: theme.colors.surface1,
                    },
                  ]}
                >
                  <Text style={[styles.text13Center, { color: theme.colors.foregroundMuted }]}>
                    {t("emptyWorkers")}
                  </Text>
                </View>
              ) : (
                snap.workers.map((wrk) => (
                  <WorkerCard
                    key={wrk.id}
                    wrk={wrk}
                    theme={theme}
                    t={t}
                    openAgentLabel={openAgentLabel}
                    onOpenAgent={openAgentSession}
                    onStopWorker={handleStopWorker}
                    onRemoveWorker={handleRemoveWorker}
                  />
                ))
              )}
            </View>

            <MemoryPreviewCard
              memoryPath={snap.memoryPath}
              memoryContent={snap.memoryContent}
              theme={theme}
              title={t("memorySectionTitle")}
              editLabel={t("editMemory")}
              onEdit={handleOpenMemoryModal}
            />
          </View>
        ) : null}
      </ScrollView>

      {missionModalState.open ? (
        <CreateOrEditMissionModal
          editingTrigger={missionModalState.editing}
          theme={theme}
          t={t}
          onClose={handleCloseMissionModal}
        />
      ) : null}

      {memoryModalOpen ? (
        <MemoryEditorModal
          initialContent={snap.memoryContent}
          theme={theme}
          t={t}
          onClose={handleCloseMemoryModal}
        />
      ) : null}
    </View>
  );
}
