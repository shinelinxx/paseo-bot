import {
  useRpc,
  useSettings,
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
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  deleteTriggerRpc,
  dismissSuggestionRpc,
  installPresetRpc,
  manageNativeScheduleRpc,
  manageWorkerRpc,
  runTriggerNowRpc,
  sendChatMessageRpc,
  setGlobalPauseRpc,
  tidySessionsRpc,
  toggleTriggerRpc,
  updateButlerProfileRpc,
  upsertNativeScheduleRpc,
  upsertTriggerRpc,
  type ApprovalItem,
  type CatalogProvider,
  type DelegatedWorker,
  type GovernanceLevel,
  type NativeScheduleItem,
  type PresetId,
  type RoutineSuggestion,
  type TriggerKind,
  type TriggerSpec,
  type WorkerStatus,
} from "../shared/contracts";
import { DEFAULT_BOT_SETTINGS, paseoBotSettings } from "../shared/settings";
import {
  isPresetAlreadyEnabled,
  PRESET_DEFINITIONS,
  resolveModelLabel,
  type TranslateFn,
} from "./ConsoleModals";
import {
  formatElapsedDuration,
  formatShortTime,
  formatSmartTime,
  shortenPathForDisplay,
  type RelativeTimeLabels,
} from "./helpers";
import { InlineApprovalCard } from "./InlineApprovalCard";
import {
  optimisticDeleteTrigger,
  optimisticDismissSuggestion,
  optimisticManageNativeSchedule,
  optimisticRemoveWorker,
  optimisticSetGlobalPaused,
  optimisticToggleTrigger,
  optimisticUpdateButlerProfile,
  setSelectedConsoleProvider,
  useBotSelector,
  useSelectedConsoleProvider,
  type ManagementDrawerSection,
} from "./store";

type PluginTheme = PluginScreenProps["theme"];

interface WebDocumentKeyTarget {
  addEventListener?(type: string, cb: (ev: { key?: string }) => void): void;
  removeEventListener?(type: string, cb: (ev: { key?: string }) => void): void;
}

const GOV_LABEL_KEYS: Record<
  GovernanceLevel,
  "gov_autonomous" | "gov_notify" | "gov_require_approval"
> = {
  autonomous: "gov_autonomous",
  notify: "gov_notify",
  require_approval: "gov_require_approval",
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
  overlayRoot: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    zIndex: 50,
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.36)",
  },
  drawerPanel: {
    height: "100%",
    borderRightWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 6, height: 0 },
    elevation: 8,
  },
  topBar: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  rowCenterGap6: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  rowCenterGap8: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  rowWrapGap6: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
  },
  flex1: { flex: 1 },
  flex1Gap2: { flex: 1, gap: 2 },
  butlerTitle: {
    fontSize: 15,
    fontWeight: "700",
  },
  pausePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 3.5,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  tabStripWrap: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
  },
  tabStripContent: {
    paddingHorizontal: 12,
    gap: 6,
  },
  sectionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  sectionChipBadge: {
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  bodyScroll: {
    flex: 1,
  },
  bodyContent: {
    padding: 14,
    paddingBottom: 28,
    gap: 12,
  },
  card: {
    padding: 13,
    borderRadius: 14,
    borderWidth: 1,
    gap: 8,
  },
  insetCard: {
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    gap: 6,
  },
  emptyBox: {
    padding: 20,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center",
  },
  ruleSwitchTrack: {
    width: 34,
    height: 19,
    borderRadius: 999,
    paddingHorizontal: 2,
    justifyContent: "center",
    borderWidth: 1,
  },
  ruleSwitchThumb: {
    width: 13,
    height: 13,
    borderRadius: 999,
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  smallBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5.5,
    borderRadius: 8,
    borderWidth: 1,
  },
  pillBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  searchInput: {
    flex: 1,
    fontSize: 12,
    paddingVertical: 2,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  sectionLabel: {
    fontSize: 11.5,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  title14: { fontSize: 13.5, fontWeight: "700" },
  text12: { fontSize: 12, lineHeight: 17 },
  text12Semi: { fontSize: 12, fontWeight: "600" },
  text12Bold: { fontSize: 12, fontWeight: "700" },
  text11: { fontSize: 11, lineHeight: 15 },
  text11Bold: { fontSize: 11, fontWeight: "700" },
});

const DrawerSwitch = memo(function DrawerSwitch({
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

const LiveWorkerStatus = memo(function LiveWorkerStatus({
  startIso,
  prefix,
  color,
}: {
  startIso: string;
  prefix: string;
  color: string;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startIso]);
  const elapsed = formatElapsedDuration(startIso, nowMs);
  return (
    <Text style={[styles.text11Bold, { color }]}>
      {prefix}
      {elapsed ? ` · ${elapsed}` : ""}
    </Text>
  );
});

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
  const cronMatch =
    /^cron:([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)(?:\s*\(([^)]+)\))?/.exec(
      trimmed,
    );
  if (!cronMatch) return raw;
  const [, min, hour, dom, mon, dow] = cronMatch;
  if (dom === "*" && mon === "*" && dow === "*") {
    if (/^\d+$/.test(min) && /^\*\/(\d+)$/.test(hour)) {
      const step = hour.slice(2);
      return min === "0"
        ? `每 ${step} 小时`
        : `每 ${step} 小时（:${min.padStart(2, "0")}）`;
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

function describeTriggerCadence(trg: TriggerSpec, t: TranslateFn): string {
  const kindMap: Record<
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
  if (trg.kind === "file_watch") {
    return `${t("kind_file_watch")} · ${shortenPathForDisplay(trg.watchPath || trg.cwd)}`;
  }
  if (trg.kind === "webhook") return t("kind_webhook");
  if (trg.kind === "poll_command") {
    return `${t("kind_poll_command")} (${trg.pollIntervalSec}s)`;
  }
  if (trg.onceAt) {
    return `${t("kind_self_wake")} · ${formatShortTime(trg.onceAt)}`;
  }
  if (trg.dailyTime) return `${trg.dailyTime} · ${t("kind_schedule")}`;
  return `${Math.max(1, Math.round(trg.pollIntervalSec / 60))}m · ${t(kindMap[trg.kind])}`;
}

const RulesDrawerSection = memo(function RulesDrawerSection({
  theme,
  t,
  onOpenNewMission,
  onOpenEditMission,
  onOpenEditSchedule,
  onOpenAgent,
}: {
  theme: PluginTheme;
  t: TranslateFn;
  onOpenNewMission: () => void;
  onOpenEditMission: (trg: TriggerSpec) => void;
  onOpenEditSchedule: (sched: NativeScheduleItem) => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const toast = useToast();
  const installPreset = useRpc(installPresetRpc);
  const toggleTrigger = useRpc(toggleTriggerRpc);
  const deleteTrigger = useRpc(deleteTriggerRpc);
  const runTriggerNow = useRpc(runTriggerNowRpc);
  const manageNativeSchedule = useRpc(manageNativeScheduleRpc);
  const upsertNativeSchedule = useRpc(upsertNativeScheduleRpc);
  const upsertTrigger = useRpc(upsertTriggerRpc);
  const dismissSuggestion = useRpc(dismissSuggestionRpc);

  const slice = useBotSelector((s) => ({
    triggers: s.triggers,
    nativeSchedules: s.nativeSchedules ?? [],
    suggestions: s.routineSuggestions ?? [],
    webhookBaseUrl: s.webhookBaseUrl,
  }));

  const [ruleFilter, setRuleFilter] = useState<"all" | "schedules" | "events">("all");
  const [search, setSearch] = useState("");
  const [presetsExpanded, setPresetsExpanded] = useState(false);

  const { activeRules, finishedReminders, activeCount, totalCount } = useMemo(() => {
    const rules: TriggerSpec[] = [];
    const reminders: TriggerSpec[] = [];
    let running = 0;
    for (const trg of slice.triggers) {
      if (trg.kind === "self_wake" && !trg.enabled) {
        reminders.push(trg);
      } else {
        rules.push(trg);
        if (trg.enabled) running += 1;
      }
    }
    for (const ns of slice.nativeSchedules) {
      if (ns.status === "active") running += 1;
    }
    return {
      activeRules: rules,
      finishedReminders: reminders,
      activeCount: running,
      totalCount: rules.length + slice.nativeSchedules.length,
    };
  }, [slice.nativeSchedules, slice.triggers]);

  const { filteredSchedules, filteredRules } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const scheds =
      ruleFilter === "events"
        ? []
        : slice.nativeSchedules.filter(
            (s) =>
              !q ||
              `${s.name}\n${s.prompt}\n${s.cwd}\n${s.cadence}`.toLowerCase().includes(q),
          );
    const rules =
      ruleFilter === "schedules"
        ? []
        : activeRules.filter(
            (r) =>
              !q ||
              `${r.name}\n${r.description}\n${r.prompt}\n${r.cwd}\n${r.watchPath ?? ""}\n${r.pollCommand ?? ""}`
                .toLowerCase()
                .includes(q),
          );
    return { filteredSchedules: scheds, filteredRules: rules };
  }, [activeRules, ruleFilter, search, slice.nativeSchedules]);

  const handleInstallPreset = useCallback(
    async (presetId: PresetId) => {
      try {
        const created = await installPreset({ presetId });
        toast.show(t("presetEnabledToast", { name: created.name }), {
          variant: "success",
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [installPreset, t, toast],
  );

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

  const showPresets = totalCount === 0 || presetsExpanded;

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.rowBetween}>
        <View style={styles.flex1Gap2}>
          <Text style={[styles.text12Semi, { color: theme.colors.foreground }]}>
            {t("rulesSummaryHeader", { active: activeCount, total: totalCount })}
          </Text>
          <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
            {t("schedulesSyncHint")}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onOpenNewMission}
          style={[styles.primaryBtn, { backgroundColor: theme.colors.accent }]}
        >
          <Icon name="Plus" size={13} color={theme.colors.accentForeground} />
          <Text style={[styles.text12Bold, { color: theme.colors.accentForeground }]}>
            {t("newMission")}
          </Text>
        </Pressable>
      </View>

      {slice.suggestions.map((sug) => (
        <View
          key={sug.id}
          style={[
            styles.card,
            {
              borderColor: theme.colors.accent,
              backgroundColor: theme.colors.surface1,
            },
          ]}
        >
          <View style={styles.rowBetween}>
            <View style={styles.rowCenterGap6}>
              <Icon name="Sparkles" size={13} color={theme.colors.accent} />
              <Text style={[styles.text11Bold, { color: theme.colors.accent }]}>
                {t("routineSuggestBadge")}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                optimisticDismissSuggestion(sug.id);
                void dismissSuggestion({ suggestionId: sug.id });
              }}
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
          <Pressable
            accessibilityRole="button"
            onPress={() => void handleAcceptSuggestion(sug)}
            style={[
              styles.smallBtn,
              {
                alignSelf: "flex-start",
                borderColor: theme.colors.accent,
                backgroundColor: theme.colors.accent,
              },
            ]}
          >
            <Icon name="Check" size={12} color={theme.colors.accentForeground} />
            <Text style={[styles.text12Bold, { color: theme.colors.accentForeground }]}>
              {t("routineAccept")}
            </Text>
          </Pressable>
        </View>
      ))}

      {totalCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setPresetsExpanded((v) => !v)}
          style={styles.rowCenterGap6}
        >
          <Icon
            name={presetsExpanded ? "ChevronUp" : "Sparkles"}
            size={12}
            color={theme.colors.accent}
          />
          <Text style={[styles.text12Semi, { color: theme.colors.accent }]}>
            {presetsExpanded
              ? t("drawerPresetsToggleHide")
              : t("drawerPresetsToggleShow")}
          </Text>
        </Pressable>
      ) : null}

      {showPresets ? (
        <View
          style={[
            styles.card,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            },
          ]}
        >
          <Text style={[styles.sectionLabel, { color: theme.colors.foregroundMuted }]}>
            {t("presetsTitle")}
          </Text>
          {PRESET_DEFINITIONS.map((preset) => {
            const added = isPresetAlreadyEnabled(
              preset.id,
              slice.triggers,
              slice.nativeSchedules,
            );
            return (
              <View
                key={preset.id}
                style={[
                  styles.insetCard,
                  {
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surface2,
                  },
                ]}
              >
                <View style={styles.rowBetween}>
                  <Text
                    style={[
                      styles.text12Semi,
                      styles.flex1,
                      { color: theme.colors.foreground },
                    ]}
                  >
                    {t(preset.titleKey)}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    disabled={added}
                    onPress={() => void handleInstallPreset(preset.id)}
                    style={[
                      styles.smallBtn,
                      {
                        borderColor: added
                          ? theme.colors.statusSuccess
                          : theme.colors.border,
                        backgroundColor: theme.colors.surface1,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.text11Bold,
                        {
                          color: added
                            ? theme.colors.statusSuccess
                            : theme.colors.foreground,
                        },
                      ]}
                    >
                      {added ? t("presetAdded") : t("addPreset")}
                    </Text>
                  </Pressable>
                </View>
                <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
                  {t(preset.descKey)}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}

      {totalCount > 0 ? (
        <View style={{ gap: 8 }}>
          <View style={styles.rowWrapGap6}>
            {(
              [
                { id: "all", label: t("rulesFilterAll"), count: totalCount },
                {
                  id: "schedules",
                  label: t("rulesFilterSchedules"),
                  count: slice.nativeSchedules.length,
                },
                {
                  id: "events",
                  label: t("rulesFilterEvents"),
                  count: activeRules.length,
                },
              ] as const
            ).map((opt) => {
              const active = ruleFilter === opt.id;
              return (
                <Pressable
                  key={opt.id}
                  accessibilityRole="button"
                  onPress={() => setRuleFilter(opt.id)}
                  style={[
                    styles.sectionChip,
                    {
                      borderColor: active ? theme.colors.accent : theme.colors.border,
                      backgroundColor: active
                        ? theme.colors.accent
                        : theme.colors.surface1,
                    },
                  ]}
                >
                  <Text
                    style={{
                      fontSize: 11.5,
                      fontWeight: active ? "700" : "500",
                      color: active
                        ? theme.colors.accentForeground
                        : theme.colors.foreground,
                    }}
                  >
                    {opt.label} ({opt.count})
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View
            style={[
              styles.searchBox,
              {
                borderColor: search ? theme.colors.accent : theme.colors.border,
                backgroundColor: theme.colors.surface1,
              },
            ]}
          >
            <Icon name="Search" size={12} color={theme.colors.foregroundMuted} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder={t("searchPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={[styles.searchInput, { color: theme.colors.foreground }]}
            />
            {search ? (
              <Pressable accessibilityRole="button" onPress={() => setSearch("")}>
                <Icon name="X" size={12} color={theme.colors.foregroundMuted} />
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      {filteredSchedules.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={[styles.sectionLabel, { color: theme.colors.foregroundMuted }]}>
            {t("nativeSchedulesTitle", { count: filteredSchedules.length })}
          </Text>
          {filteredSchedules.map((sched) => {
            const isActive = sched.status === "active";
            return (
              <View
                key={sched.id}
                style={[
                  styles.card,
                  {
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surface1,
                    opacity: isActive ? 1 : 0.72,
                  },
                ]}
              >
                <View style={styles.rowBetween}>
                  <View style={styles.flex1Gap2}>
                    <Text style={[styles.title14, { color: theme.colors.foreground }]}>
                      {sched.name}
                    </Text>
                    <Text
                      style={[styles.text11, { color: theme.colors.foregroundMuted }]}
                    >
                      {formatNativeCadence(sched.cadence)}
                      {sched.cwd ? ` · ${shortenPathForDisplay(sched.cwd)}` : ""}
                    </Text>
                  </View>
                  <DrawerSwitch
                    enabled={isActive}
                    theme={theme}
                    onToggle={() => {
                      const act = isActive ? "pause" : "resume";
                      optimisticManageNativeSchedule(sched.id, act);
                      void manageNativeSchedule({ id: sched.id, action: act }).catch(
                        (err) =>
                          toast.error(err instanceof Error ? err.message : String(err)),
                      );
                    }}
                  />
                </View>

                {sched.nextRunAt || sched.lastRunAt ? (
                  <View style={styles.rowWrapGap6}>
                    {sched.nextRunAt ? (
                      <View
                        style={[
                          styles.pillBadge,
                          { backgroundColor: theme.colors.surface2 },
                        ]}
                      >
                        <Text
                          style={[
                            styles.text11,
                            { color: theme.colors.foregroundMuted },
                          ]}
                        >
                          {t("nextRunLabel", { time: formatShortTime(sched.nextRunAt) })}
                        </Text>
                      </View>
                    ) : null}
                    {sched.lastRunStatus ? (
                      <View
                        style={[
                          styles.pillBadge,
                          { backgroundColor: theme.colors.surface2 },
                        ]}
                      >
                        <Text
                          style={[
                            styles.text11Bold,
                            {
                              color:
                                sched.lastRunStatus === "succeeded"
                                  ? theme.colors.statusSuccess
                                  : sched.lastRunStatus === "failed"
                                    ? theme.colors.statusDanger
                                    : theme.colors.accent,
                            },
                          ]}
                        >
                          {sched.lastRunStatus === "succeeded"
                            ? t("lastRunSucceeded")
                            : sched.lastRunStatus === "failed"
                              ? t("lastRunFailed")
                              : t("lastRunRunning")}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}

                {sched.prompt ? (
                  <Text
                    numberOfLines={2}
                    style={[styles.text12, { color: theme.colors.foreground }]}
                  >
                    {sched.prompt}
                  </Text>
                ) : null}

                <View style={styles.rowWrapGap6}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      void manageNativeSchedule({ id: sched.id, action: "run_once" })
                        .then((res) =>
                          toast.show(res.message, {
                            variant: res.ok ? "success" : "warning",
                          }),
                        )
                        .catch((err) =>
                          toast.error(err instanceof Error ? err.message : String(err)),
                        );
                    }}
                    style={[
                      styles.smallBtn,
                      {
                        borderColor: theme.colors.border,
                        backgroundColor: theme.colors.surface2,
                      },
                    ]}
                  >
                    <Icon name="Play" size={11} color={theme.colors.foreground} />
                    <Text style={[styles.text11, { color: theme.colors.foreground }]}>
                      {t("runNow")}
                    </Text>
                  </Pressable>

                  {sched.lastRunAgentId ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => onOpenAgent(sched.lastRunAgentId!)}
                      style={[
                        styles.smallBtn,
                        {
                          borderColor: theme.colors.border,
                          backgroundColor: theme.colors.surface2,
                        },
                      ]}
                    >
                      <Icon
                        name="ArrowUpRight"
                        size={11}
                        color={theme.colors.foregroundMuted}
                      />
                      <Text style={[styles.text11, { color: theme.colors.foreground }]}>
                        {t("openLastRunAgent")}
                      </Text>
                    </Pressable>
                  ) : null}

                  <Pressable
                    accessibilityRole="button"
                    onPress={() => onOpenEditSchedule(sched)}
                    style={[
                      styles.smallBtn,
                      {
                        borderColor: theme.colors.border,
                        backgroundColor: theme.colors.surface2,
                      },
                    ]}
                  >
                    <Icon name="Pencil" size={11} color={theme.colors.foreground} />
                    <Text style={[styles.text11, { color: theme.colors.foreground }]}>
                      {t("editMission")}
                    </Text>
                  </Pressable>

                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      optimisticManageNativeSchedule(sched.id, "delete");
                      void manageNativeSchedule({ id: sched.id, action: "delete" }).catch(
                        (err) =>
                          toast.error(err instanceof Error ? err.message : String(err)),
                      );
                    }}
                    style={[
                      styles.smallBtn,
                      {
                        borderColor: theme.colors.border,
                        backgroundColor: theme.colors.surface2,
                      },
                    ]}
                  >
                    <Icon name="Trash2" size={11} color={theme.colors.statusDanger} />
                    <Text style={[styles.text11, { color: theme.colors.statusDanger }]}>
                      {t("delete")}
                    </Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      {filteredRules.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={[styles.sectionLabel, { color: theme.colors.foregroundMuted }]}>
            {t("pluginRulesTitle", { count: filteredRules.length })}
          </Text>
          {filteredRules.map((trg) => {
            const webhookUrl =
              trg.kind === "webhook" && trg.webhookKey && slice.webhookBaseUrl
                ? `${slice.webhookBaseUrl}/hook/${trg.webhookKey}`
                : null;
            return (
              <View
                key={trg.id}
                style={[
                  styles.card,
                  {
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surface1,
                    opacity: trg.enabled ? 1 : 0.72,
                  },
                ]}
              >
                <View style={styles.rowBetween}>
                  <View style={styles.flex1Gap2}>
                    <Text style={[styles.title14, { color: theme.colors.foreground }]}>
                      {trg.name}
                    </Text>
                    <Text
                      style={[styles.text11, { color: theme.colors.foregroundMuted }]}
                    >
                      {describeTriggerCadence(trg, t)} · {t(GOV_LABEL_KEYS[trg.governance])}
                    </Text>
                  </View>
                  <DrawerSwitch
                    enabled={trg.enabled}
                    theme={theme}
                    onToggle={() => {
                      optimisticToggleTrigger(trg.id, !trg.enabled);
                      void toggleTrigger({ id: trg.id, enabled: !trg.enabled });
                    }}
                  />
                </View>

                <View style={styles.rowWrapGap6}>
                  <View
                    style={[
                      styles.pillBadge,
                      { backgroundColor: theme.colors.surface2 },
                    ]}
                  >
                    <Text
                      style={[styles.text11, { color: theme.colors.foregroundMuted }]}
                    >
                      {t("missionStats", {
                        silent: trg.silentCount,
                        notify: trg.notifyCount,
                      })}
                    </Text>
                  </View>
                  {(trg.noiseRules?.length ?? 0) > 0 ? (
                    <View
                      style={[
                        styles.pillBadge,
                        { backgroundColor: theme.colors.surface2 },
                      ]}
                    >
                      <Text style={[styles.text11, { color: theme.colors.accent }]}>
                        {t("missionNoiseCount", { count: trg.noiseRules.length })}
                      </Text>
                    </View>
                  ) : null}
                </View>

                {webhookUrl ? (
                  <Text
                    selectable
                    style={[styles.text11, { color: theme.colors.foregroundMuted }]}
                  >
                    POST {webhookUrl}
                  </Text>
                ) : null}

                <Text
                  numberOfLines={2}
                  style={[styles.text12, { color: theme.colors.foreground }]}
                >
                  {trg.description || trg.prompt}
                </Text>

                {trg.lastError ? (
                  <Text style={[styles.text11, { color: theme.colors.statusDanger }]}>
                    {trg.lastError}
                  </Text>
                ) : null}

                <View style={styles.rowWrapGap6}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      void runTriggerNow({ id: trg.id })
                        .then((res) =>
                          toast.show(res.message, {
                            variant: res.ok ? "success" : "warning",
                          }),
                        )
                        .catch((err) =>
                          toast.error(err instanceof Error ? err.message : String(err)),
                        );
                    }}
                    style={[
                      styles.smallBtn,
                      {
                        borderColor: theme.colors.border,
                        backgroundColor: theme.colors.surface2,
                      },
                    ]}
                  >
                    <Icon name="Play" size={11} color={theme.colors.foreground} />
                    <Text style={[styles.text11, { color: theme.colors.foreground }]}>
                      {t("runNow")}
                    </Text>
                  </Pressable>

                  <Pressable
                    accessibilityRole="button"
                    onPress={() => onOpenEditMission(trg)}
                    style={[
                      styles.smallBtn,
                      {
                        borderColor: theme.colors.border,
                        backgroundColor: theme.colors.surface2,
                      },
                    ]}
                  >
                    <Icon name="Pencil" size={11} color={theme.colors.foreground} />
                    <Text style={[styles.text11, { color: theme.colors.foreground }]}>
                      {t("editMission")}
                    </Text>
                  </Pressable>

                  {webhookUrl ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        void copyText(webhookUrl).then(() =>
                          toast.show(t("copiedToast"), { variant: "success" }),
                        );
                      }}
                      style={[
                        styles.smallBtn,
                        {
                          borderColor: theme.colors.border,
                          backgroundColor: theme.colors.surface2,
                        },
                      ]}
                    >
                      <Icon name="Copy" size={11} color={theme.colors.foreground} />
                      <Text style={[styles.text11, { color: theme.colors.foreground }]}>
                        {t("copyWebhook")}
                      </Text>
                    </Pressable>
                  ) : null}

                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      optimisticDeleteTrigger({ id: trg.id });
                      void deleteTrigger({ id: trg.id });
                    }}
                    style={[
                      styles.smallBtn,
                      {
                        borderColor: theme.colors.border,
                        backgroundColor: theme.colors.surface2,
                      },
                    ]}
                  >
                    <Icon name="Trash2" size={11} color={theme.colors.statusDanger} />
                    <Text style={[styles.text11, { color: theme.colors.statusDanger }]}>
                      {t("delete")}
                    </Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      {finishedReminders.length > 0 ? (
        <View style={{ gap: 8 }}>
          <View style={styles.rowBetween}>
            <Text style={[styles.sectionLabel, { color: theme.colors.foregroundMuted }]}>
              {t("finishedRemindersTitle", { count: finishedReminders.length })}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                optimisticDeleteTrigger({ clearFinishedReminders: true });
                void deleteTrigger({ clearFinishedReminders: true }).then((res) => {
                  if ((res.removedCount ?? 0) > 0) {
                    toast.show(
                      t("remindersClearedToast", { count: res.removedCount ?? 0 }),
                      { variant: "info" },
                    );
                  }
                });
              }}
              style={[
                styles.smallBtn,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                },
              ]}
            >
              <Icon name="Trash2" size={11} color={theme.colors.foregroundMuted} />
              <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
                {t("clearFinishedRemindersBtn")}
              </Text>
            </Pressable>
          </View>

          {finishedReminders.map((rem) => (
            <View
              key={rem.id}
              style={[
                styles.insetCard,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                },
              ]}
            >
              <View style={styles.rowBetween}>
                <Text
                  style={[
                    styles.text12Semi,
                    styles.flex1,
                    { color: theme.colors.foregroundMuted },
                  ]}
                >
                  {rem.name}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    optimisticDeleteTrigger({ id: rem.id });
                    void deleteTrigger({ id: rem.id });
                  }}
                >
                  <Icon name="X" size={13} color={theme.colors.foregroundMuted} />
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
});

const ApprovalsDrawerSection = memo(function ApprovalsDrawerSection({
  theme,
  timeLabels,
  t,
  onOpenAgent,
}: {
  theme: PluginTheme;
  timeLabels: RelativeTimeLabels;
  t: TranslateFn;
  onOpenAgent: (agentId: string) => void;
}) {
  const approvals = useBotSelector((s) => s.approvals);

  const { pending, resolved } = useMemo(() => {
    const pend: ApprovalItem[] = [];
    const res: ApprovalItem[] = [];
    for (const a of approvals) {
      if (a.status === "pending") pend.push(a);
      else if (res.length < 15) res.push(a);
    }
    return { pending: pend, resolved: res };
  }, [approvals]);

  return (
    <View style={{ gap: 12 }}>
      {pending.length === 0 ? (
        <View
          style={[
            styles.emptyBox,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            },
          ]}
        >
          <Text
            style={[
              styles.text12,
              { color: theme.colors.foregroundMuted, textAlign: "center" },
            ]}
          >
            {t("emptyApprovals")}
          </Text>
        </View>
      ) : (
        pending.map((apr) => (
          <InlineApprovalCard
            key={apr.id}
            approval={apr}
            inDrawer
            timeLabels={timeLabels}
            theme={theme}
            t={t}
            onOpenAgent={onOpenAgent}
          />
        ))
      )}

      {resolved.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={[styles.sectionLabel, { color: theme.colors.foregroundMuted }]}>
            {t("resolvedApprovalsTitle")}
          </Text>
          {resolved.map((apr) => (
            <InlineApprovalCard
              key={apr.id}
              approval={apr}
              inDrawer
              timeLabels={timeLabels}
              theme={theme}
              t={t}
              onOpenAgent={onOpenAgent}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const MemoryDrawerSection = memo(function MemoryDrawerSection({
  theme,
  t,
  onOpenMemoryModal,
}: {
  theme: PluginTheme;
  t: TranslateFn;
  onOpenMemoryModal: () => void;
}) {
  const slice = useBotSelector((s) => ({
    memoryContent: s.memoryContent,
    memoryPath: s.memoryPath,
  }));
  const [expanded, setExpanded] = useState(false);

  const { previewMd, totalLines, isTruncated } = useMemo(() => {
    const raw = slice.memoryContent.trim();
    if (!raw) {
      return {
        previewMd: "*Memory is currently empty.*",
        totalLines: 0,
        isTruncated: false,
      };
    }
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim() || raw;
    const lines = body.split("\n");
    if (lines.length <= 20) {
      return { previewMd: body, totalLines: lines.length, isTruncated: false };
    }
    return {
      previewMd: lines.slice(0, 18).join("\n"),
      totalLines: lines.length,
      isTruncated: true,
    };
  }, [slice.memoryContent]);

  return (
    <View
      style={[
        styles.card,
        {
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          gap: 10,
        },
      ]}
    >
      <View style={styles.rowBetween}>
        <View style={styles.flex1Gap2}>
          <Text style={[styles.title14, { color: theme.colors.foreground }]}>
            {t("memorySectionTitle")}
          </Text>
          <Text
            selectable
            style={[styles.text11, { color: theme.colors.foregroundMuted }]}
          >
            {shortenPathForDisplay(slice.memoryPath)}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onOpenMemoryModal}
          style={[
            styles.primaryBtn,
            { backgroundColor: theme.colors.accent },
          ]}
        >
          <Icon name="Pencil" size={12} color={theme.colors.accentForeground} />
          <Text style={[styles.text12Bold, { color: theme.colors.accentForeground }]}>
            {t("editMemory")}
          </Text>
        </Pressable>
      </View>

      <Markdown>
        {expanded || !isTruncated ? slice.memoryContent || previewMd : previewMd}
      </Markdown>

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

const WorkersDrawerSection = memo(function WorkersDrawerSection({
  theme,
  timeLabels,
  t,
  onOpenAgent,
  onCloseDrawer,
}: {
  theme: PluginTheme;
  timeLabels: RelativeTimeLabels;
  t: TranslateFn;
  onOpenAgent: (agentId: string) => void;
  onCloseDrawer: () => void;
}) {
  const toast = useToast();
  const manageWorker = useRpc(manageWorkerRpc);
  const sendChatMessage = useRpc(sendChatMessageRpc);
  const tidySessions = useRpc(tidySessionsRpc);

  const workers = useBotSelector((s) => s.workers);
  const [tidying, setTidying] = useState(false);

  const hasFinished = useMemo(
    () => workers.some((w) => w.status !== "running" && w.status !== "permission"),
    [workers],
  );

  const handleTidy = useCallback(async () => {
    if (tidying) return;
    setTidying(true);
    toast.show(t("tidyRunningToast"), { variant: "info" });
    try {
      const res = await tidySessions({ mode: "preview" });
      if (res.actionCount > 0) {
        toast.show(t("tidyStagedToast", { count: res.actionCount }), {
          variant: "success",
        });
        onCloseDrawer();
      } else {
        toast.show(t("tidyCleanToast"), { variant: "info" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setTidying(false);
    }
  }, [onCloseDrawer, t, tidySessions, tidying, toast]);

  const handleRetry = useCallback(
    async (wrk: DelegatedWorker) => {
      try {
        await sendChatMessage({
          text: wrk.goal,
          cwd: wrk.cwd,
          providerOverride: wrk.provider || undefined,
          forceTier: "L2",
        });
        toast.show(t("wishSentToast"), { variant: "success" });
        onCloseDrawer();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [onCloseDrawer, sendChatMessage, t, toast],
  );

  return (
    <View style={{ gap: 12 }}>
      <View
        style={[
          styles.card,
          {
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          },
        ]}
      >
        <View style={styles.rowBetween}>
          <View style={styles.flex1Gap2}>
            <Text style={[styles.title14, { color: theme.colors.foreground }]}>
              {t("drawerTidyCardTitle")}
            </Text>
            <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
              {t("drawerTidyCardDesc")}
            </Text>
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          disabled={tidying}
          onPress={() => void handleTidy()}
          style={[
            styles.primaryBtn,
            {
              alignSelf: "flex-start",
              backgroundColor: theme.colors.accent,
              opacity: tidying ? 0.6 : 1,
            },
          ]}
        >
          <Icon name="Layers" size={13} color={theme.colors.accentForeground} />
          <Text style={[styles.text12Bold, { color: theme.colors.accentForeground }]}>
            {t("drawerTidyBtn")}
          </Text>
        </Pressable>
      </View>

      {hasFinished ? (
        <View style={styles.rowBetween}>
          <View />
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              optimisticRemoveWorker({ clearFinished: true });
              void manageWorker({ action: "clear_finished" }).then((res) => {
                if (res.ok) {
                  toast.show(
                    t("workersClearedToast", { count: res.removedCount ?? 0 }),
                    { variant: "info" },
                  );
                }
              });
            }}
            style={[
              styles.smallBtn,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
              },
            ]}
          >
            <Icon name="Trash2" size={11} color={theme.colors.foregroundMuted} />
            <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
              {t("clearFinishedWorkers")}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {workers.length === 0 ? (
        <View
          style={[
            styles.emptyBox,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            },
          ]}
        >
          <Text
            style={[
              styles.text12,
              { color: theme.colors.foregroundMuted, textAlign: "center" },
            ]}
          >
            {t("emptyWorkers")}
          </Text>
        </View>
      ) : (
        workers.map((wrk) => {
          const isRunning = wrk.status === "running" || wrk.status === "permission";
          const tone =
            wrk.status === "completed"
              ? theme.colors.statusSuccess
              : wrk.status === "failed"
                ? theme.colors.statusDanger
                : wrk.status === "permission"
                  ? theme.colors.statusWarning
                  : theme.colors.accent;
          return (
            <View
              key={wrk.id}
              style={[
                styles.card,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                },
              ]}
            >
              <View style={styles.rowBetween}>
                <Text
                  style={[
                    styles.title14,
                    styles.flex1,
                    { color: theme.colors.foreground },
                  ]}
                >
                  {wrk.title}
                </Text>
                {isRunning ? (
                  <LiveWorkerStatus
                    startIso={wrk.createdAt}
                    prefix={t(WORKER_LABEL_KEYS[wrk.status])}
                    color={tone}
                  />
                ) : (
                  <Text style={[styles.text11Bold, { color: tone }]}>
                    {t(WORKER_LABEL_KEYS[wrk.status])}
                  </Text>
                )}
              </View>

              <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
                {shortenPathForDisplay(wrk.cwd)} ({wrk.isolation}) ·{" "}
                {formatSmartTime(wrk.updatedAt, timeLabels)}
              </Text>

              {wrk.summary ? (
                <Text
                  numberOfLines={3}
                  style={[styles.text12, { color: theme.colors.foreground }]}
                >
                  {wrk.summary}
                </Text>
              ) : null}

              <View style={styles.rowWrapGap6}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onOpenAgent(wrk.agentId)}
                  style={[
                    styles.smallBtn,
                    {
                      borderColor: theme.colors.border,
                      backgroundColor: theme.colors.surface2,
                    },
                  ]}
                >
                  <Icon
                    name="ArrowUpRight"
                    size={11}
                    color={theme.colors.foregroundMuted}
                  />
                  <Text style={[styles.text11, { color: theme.colors.foreground }]}>
                    {t("openAgent")}
                  </Text>
                </Pressable>

                {wrk.status === "failed" ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void handleRetry(wrk)}
                    style={[
                      styles.smallBtn,
                      {
                        borderColor: theme.colors.border,
                        backgroundColor: theme.colors.surface2,
                      },
                    ]}
                  >
                    <Icon name="RotateCcw" size={11} color={theme.colors.accent} />
                    <Text style={[styles.text11Bold, { color: theme.colors.accent }]}>
                      {t("retryWorker")}
                    </Text>
                  </Pressable>
                ) : null}

                {isRunning ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      void manageWorker({ action: "stop", workerId: wrk.id }).then(
                        (res) => {
                          if (res.ok) {
                            toast.show(t("workerStoppedToast"), { variant: "info" });
                          }
                        },
                      );
                    }}
                    style={[
                      styles.smallBtn,
                      {
                        borderColor: theme.colors.border,
                        backgroundColor: theme.colors.surface2,
                      },
                    ]}
                  >
                    <Text style={[styles.text11, { color: theme.colors.statusWarning }]}>
                      {t("stopWorker")}
                    </Text>
                  </Pressable>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      optimisticRemoveWorker({ workerId: wrk.id });
                      void manageWorker({ action: "remove", workerId: wrk.id });
                    }}
                    style={[
                      styles.smallBtn,
                      {
                        borderColor: theme.colors.border,
                        backgroundColor: theme.colors.surface2,
                      },
                    ]}
                  >
                    <Text
                      style={[styles.text11, { color: theme.colors.foregroundMuted }]}
                    >
                      {t("removeWorker")}
                    </Text>
                  </Pressable>
                )}
              </View>
            </View>
          );
        })
      )}
    </View>
  );
});

const RoutingDrawerSection = memo(function RoutingDrawerSection({
  theme,
  modelProviders,
  t,
  onOpenModelPicker,
}: {
  theme: PluginTheme;
  modelProviders: readonly CatalogProvider[];
  t: TranslateFn;
  onOpenModelPicker: () => void;
}) {
  const toast = useToast();
  const updateProfile = useRpc(updateButlerProfileRpc);
  const settings = useSettings(paseoBotSettings);
  const selectedProvider = useSelectedConsoleProvider();

  const slice = useBotSelector((s) => ({
    butlerName: s.butlerName ?? "Paseo Bot",
    userName: s.userName ?? "",
    telemetry: s.routingTelemetry,
    tierModels: s.tierModels,
  }));

  const [butlerDraft, setButlerDraft] = useState(slice.butlerName);
  const [userDraft, setUserDraft] = useState(slice.userName);
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    setButlerDraft(slice.butlerName);
    setUserDraft(slice.userName);
  }, [slice.butlerName, slice.userName]);

  const handleSaveProfile = useCallback(async () => {
    if (savingProfile) return;
    setSavingProfile(true);
    const nextButler = butlerDraft.trim() || "Paseo Bot";
    const nextUser = userDraft.trim();
    optimisticUpdateButlerProfile({ butlerName: nextButler, userName: nextUser });
    try {
      await updateProfile({ butlerName: nextButler, userName: nextUser });
      toast.show(t("drawerProfileSavedToast"), { variant: "success" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingProfile(false);
    }
  }, [butlerDraft, savingProfile, t, toast, updateProfile, userDraft]);

  const cfg = settings.status === "ready" ? settings.values : DEFAULT_BOT_SETTINGS;
  const l1Model = slice.tierModels?.l1 || cfg.fastProvider;
  const l2Model = slice.tierModels?.l2 || cfg.execProvider;
  const l3Model = slice.tierModels?.l3 || cfg.deepProvider;
  const tel = slice.telemetry;

  const tiers = [
    {
      key: "L0",
      title: t("drawerTierL0Title"),
      modelText: t("drawerTierL0Desc"),
      hits: tel?.l0Hits ?? 0,
    },
    {
      key: "L1",
      title: t("drawerTierL1Title"),
      modelText: `${resolveModelLabel(l1Model, modelProviders)} (${l1Model})`,
      hits: tel?.l1Hits ?? 0,
    },
    {
      key: "L2",
      title: t("drawerTierL2Title"),
      modelText: `${resolveModelLabel(l2Model, modelProviders)} (${l2Model})`,
      hits: tel?.l2Hits ?? 0,
    },
    {
      key: "L3",
      title: t("drawerTierL3Title"),
      modelText: `${resolveModelLabel(l3Model, modelProviders)} (${l3Model})`,
      hits: tel?.l3Hits ?? 0,
    },
  ];

  return (
    <View style={{ gap: 12 }}>
      <View
        style={[
          styles.card,
          {
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          },
        ]}
      >
        <Text style={[styles.title14, { color: theme.colors.foreground }]}>
          {t("drawerProfileTitle")}
        </Text>
        <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
          {t("drawerProfileHint")}
        </Text>

        <View style={{ gap: 6 }}>
          <Text style={[styles.text11Bold, { color: theme.colors.foregroundMuted }]}>
            {t("drawerButlerNameLabel")}
          </Text>
          <TextInput
            value={butlerDraft}
            onChangeText={setButlerDraft}
            placeholder={t("drawerButlerNamePlaceholder")}
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
        </View>

        <View style={{ gap: 6 }}>
          <Text style={[styles.text11Bold, { color: theme.colors.foregroundMuted }]}>
            {t("drawerUserNameLabel")}
          </Text>
          <TextInput
            value={userDraft}
            onChangeText={setUserDraft}
            placeholder={t("drawerUserNamePlaceholder")}
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
        </View>

        <Pressable
          accessibilityRole="button"
          disabled={savingProfile}
          onPress={() => void handleSaveProfile()}
          style={[
            styles.primaryBtn,
            {
              alignSelf: "flex-start",
              backgroundColor: theme.colors.accent,
              opacity: savingProfile ? 0.6 : 1,
            },
          ]}
        >
          <Icon name="Check" size={13} color={theme.colors.accentForeground} />
          <Text style={[styles.text12Bold, { color: theme.colors.accentForeground }]}>
            {t("drawerSaveProfileBtn")}
          </Text>
        </Pressable>
      </View>

      <View
        style={[
          styles.card,
          {
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          },
        ]}
      >
        <Text style={[styles.title14, { color: theme.colors.foreground }]}>
          {t("drawerRoutingTitle")}
        </Text>

        {tiers.map((tier) => (
          <View
            key={tier.key}
            style={[
              styles.insetCard,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <View style={styles.rowBetween}>
              <Text
                style={[
                  styles.text12Semi,
                  styles.flex1,
                  { color: theme.colors.foreground },
                ]}
              >
                {tier.title}
              </Text>
              <View
                style={[styles.pillBadge, { backgroundColor: theme.colors.surface1 }]}
              >
                <Text style={[styles.text11Bold, { color: theme.colors.accent }]}>
                  {t("drawerHitsBadge", { count: tier.hits })}
                </Text>
              </View>
            </View>
            <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
              {tier.modelText}
            </Text>
          </View>
        ))}

        {(tel?.fallbackCount ?? 0) > 0 || tel?.lastTier ? (
          <View style={{ gap: 2 }}>
            {tel?.lastTier ? (
              <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
                {t("drawerLastRouteLine", {
                  tier: tel.lastTier,
                  model: tel.lastModelUsed || "local",
                })}
                {tel.lastLatencyMs !== undefined ? ` (${tel.lastLatencyMs}ms)` : ""}
              </Text>
            ) : null}
            {(tel?.fallbackCount ?? 0) > 0 ? (
              <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
                {t("drawerFallbackLine", { count: tel?.fallbackCount ?? 0 })}
              </Text>
            ) : null}
          </View>
        ) : null}

        <View style={styles.rowWrapGap6}>
          <Pressable
            accessibilityRole="button"
            onPress={onOpenModelPicker}
            style={[
              styles.smallBtn,
              {
                borderColor: selectedProvider
                  ? theme.colors.accent
                  : theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <Icon name="Cpu" size={12} color={theme.colors.accent} />
            <Text style={[styles.text12Semi, { color: theme.colors.foreground }]}>
              {t("drawerOpenModelPickerBtn")}
            </Text>
          </Pressable>

          {selectedProvider ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setSelectedConsoleProvider(null)}
              style={[
                styles.smallBtn,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface2,
                },
              ]}
            >
              <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
                {t("drawerClearModelOverrideBtn")}
              </Text>
            </Pressable>
          ) : null}
        </View>

        <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
          {t("drawerOpenSettingsHint")}
        </Text>
      </View>
    </View>
  );
});

export interface ManagementDrawerProps {
  open: boolean;
  activeSection: ManagementDrawerSection;
  onSelectSection: (section: ManagementDrawerSection) => void;
  onClose: () => void;
  theme: PluginTheme;
  compact: boolean;
  modelProviders: readonly CatalogProvider[];
  timeLabels: RelativeTimeLabels;
  t: TranslateFn;
  onOpenNewMission: () => void;
  onOpenEditMission: (trg: TriggerSpec) => void;
  onOpenEditSchedule: (sched: NativeScheduleItem) => void;
  onOpenMemoryModal: () => void;
  onOpenModelPicker: () => void;
  onOpenAgent: (agentId: string) => void;
}

export const ManagementDrawer = memo(function ManagementDrawer({
  open,
  activeSection,
  onSelectSection,
  onClose,
  theme,
  compact,
  modelProviders,
  timeLabels,
  t,
  onOpenNewMission,
  onOpenEditMission,
  onOpenEditSchedule,
  onOpenMemoryModal,
  onOpenModelPicker,
  onOpenAgent,
}: ManagementDrawerProps) {
  const setGlobalPause = useRpc(setGlobalPauseRpc);
  const { width: winWidth } = useWindowDimensions();

  const drawerWidth = useMemo(() => {
    const target = compact ? 360 : 380;
    const bounded = winWidth > 0 ? Math.floor(winWidth * 0.88) : target;
    return Math.max(280, Math.min(target, bounded));
  }, [compact, winWidth]);

  const [mounted, setMounted] = useState(open);
  const anim = useRef(new Animated.Value(open ? 1 : 0)).current;

  useEffect(() => {
    const useNative = Platform.OS !== "web";
    if (open) {
      setMounted(true);
      Animated.timing(anim, {
        toValue: 1,
        duration: 210,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: useNative,
      }).start();
    } else if (mounted) {
      Animated.timing(anim, {
        toValue: 0,
        duration: 170,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: useNative,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [anim, mounted, open]);

  // Support Escape key to dismiss drawer on Web/Electron
  useEffect(() => {
    if (!open || Platform.OS !== "web") return;
    const doc = (globalThis as unknown as { document?: WebDocumentKeyTarget }).document;
    if (!doc || typeof doc.addEventListener !== "function") return;
    const onKeyDown = (ev: { key?: string }) => {
      if (ev.key === "Escape") onClose();
    };
    doc.addEventListener("keydown", onKeyDown);
    return () => doc.removeEventListener?.("keydown", onKeyDown);
  }, [onClose, open]);

  const headerSlice = useBotSelector((s) => {
    let activeRulesCount = 0;
    for (const trg of s.triggers) if (trg.enabled) activeRulesCount += 1;
    for (const ns of s.nativeSchedules ?? []) if (ns.status === "active") activeRulesCount += 1;
    return {
      butlerName: s.butlerName ?? "Paseo Bot",
      globalPaused: s.globalPaused,
      hourlyWakesUsed: s.hourlyWakesUsed,
      hourlyWakeLimit: s.hourlyWakeLimit,
      totalSilentChecks: s.totalSilentChecks ?? 0,
      pendingApprovalCount: s.pendingApprovalCount,
      runningWorkerCount: s.runningWorkerCount,
      activeRulesCount,
    };
  });

  const handleTogglePause = useCallback(() => {
    const next = !headerSlice.globalPaused;
    optimisticSetGlobalPaused(next);
    void setGlobalPause({ paused: next });
  }, [headerSlice.globalPaused, setGlobalPause]);

  if (!mounted) return null;

  const translateX = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [-drawerWidth - 16, 0],
  });

  const sections: Array<{
    id: ManagementDrawerSection;
    label: string;
    icon: string;
    badge?: number;
    warning?: boolean;
  }> = [
    {
      id: "rules",
      label: t("drawerTabRules"),
      icon: "CalendarClock",
      badge: headerSlice.activeRulesCount || undefined,
    },
    {
      id: "approvals",
      label: t("drawerTabApprovals"),
      icon: "ShieldAlert",
      badge: headerSlice.pendingApprovalCount || undefined,
      warning: headerSlice.pendingApprovalCount > 0,
    },
    {
      id: "memory",
      label: t("drawerTabMemory"),
      icon: "BookOpen",
    },
    {
      id: "workers",
      label: t("drawerTabWorkers"),
      icon: "Layers",
      badge: headerSlice.runningWorkerCount || undefined,
    },
    {
      id: "routing",
      label: t("drawerTabRouting"),
      icon: "Cpu",
    },
  ];

  return (
    <View style={styles.overlayRoot} pointerEvents="box-none">
      <Animated.View style={[styles.backdrop, { opacity: anim }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("drawerCloseA11y")}
          onPress={onClose}
          style={{ flex: 1 }}
        />
      </Animated.View>

      <Animated.View
        style={[
          styles.drawerPanel,
          {
            width: drawerWidth,
            borderRightColor: theme.colors.border,
            backgroundColor: theme.colors.surface0,
            transform: [{ translateX }],
          },
        ]}
      >
        <View
          style={[
            styles.topBar,
            {
              borderBottomColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            },
          ]}
        >
          <View style={styles.rowBetween}>
            <View style={[styles.rowCenterGap8, styles.flex1]}>
              <Text
                numberOfLines={1}
                style={[styles.butlerTitle, { color: theme.colors.foreground }]}
              >
                {headerSlice.butlerName}
              </Text>

              <Pressable
                accessibilityRole="switch"
                accessibilityState={{ checked: !headerSlice.globalPaused }}
                onPress={handleTogglePause}
                style={[
                  styles.pausePill,
                  {
                    borderColor: headerSlice.globalPaused
                      ? theme.colors.border
                      : theme.colors.statusSuccess,
                    backgroundColor: theme.colors.surface2,
                  },
                ]}
              >
                <View
                  style={[
                    styles.statusDot,
                    {
                      backgroundColor: headerSlice.globalPaused
                        ? theme.colors.foregroundMuted
                        : theme.colors.statusSuccess,
                    },
                  ]}
                />
                <Text
                  style={[
                    styles.text11Bold,
                    {
                      color: headerSlice.globalPaused
                        ? theme.colors.foregroundMuted
                        : theme.colors.statusSuccess,
                    },
                  ]}
                >
                  {headerSlice.globalPaused ? t("statusPaused") : t("statusActive")}
                </Text>
              </Pressable>
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("drawerCloseA11y")}
              onPress={onClose}
              style={[styles.closeBtn, { backgroundColor: theme.colors.surface2 }]}
            >
              <Icon name="X" size={15} color={theme.colors.foreground} />
            </Pressable>
          </View>

          <Text style={[styles.text11, { color: theme.colors.foregroundMuted }]}>
            {t("drawerSummaryLine", {
              used: headerSlice.hourlyWakesUsed,
              limit: headerSlice.hourlyWakeLimit,
              silent: headerSlice.totalSilentChecks,
            })}
          </Text>
        </View>

        <View
          style={[
            styles.tabStripWrap,
            {
              borderBottomColor: theme.colors.border,
              backgroundColor: theme.colors.surface0,
            },
          ]}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.tabStripContent}
          >
            {sections.map((sec) => {
              const selected = activeSection === sec.id;
              return (
                <Pressable
                  key={sec.id}
                  accessibilityRole="button"
                  onPress={() => onSelectSection(sec.id)}
                  style={[
                    styles.sectionChip,
                    {
                      borderColor: selected ? theme.colors.accent : theme.colors.border,
                      backgroundColor: selected
                        ? theme.colors.accent
                        : theme.colors.surface1,
                    },
                  ]}
                >
                  <Icon
                    name={sec.icon}
                    size={12}
                    color={
                      selected
                        ? theme.colors.accentForeground
                        : sec.warning
                          ? theme.colors.statusWarning
                          : theme.colors.foregroundMuted
                    }
                  />
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: selected ? "700" : "600",
                      color: selected
                        ? theme.colors.accentForeground
                        : theme.colors.foreground,
                    }}
                  >
                    {sec.label}
                  </Text>
                  {sec.badge ? (
                    <View
                      style={[
                        styles.sectionChipBadge,
                        {
                          backgroundColor: selected
                            ? theme.colors.surface0
                            : sec.warning
                              ? theme.colors.statusWarning
                              : theme.colors.surface2,
                        },
                      ]}
                    >
                      <Text
                        style={{
                          fontSize: 10,
                          fontWeight: "700",
                          color: selected
                            ? theme.colors.foreground
                            : sec.warning
                              ? theme.colors.surface0
                              : theme.colors.foregroundMuted,
                        }}
                      >
                        {sec.badge}
                      </Text>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        <ScrollView
          style={styles.bodyScroll}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.bodyContent}
        >
          {activeSection === "rules" ? (
            <RulesDrawerSection
              theme={theme}
              t={t}
              onOpenNewMission={onOpenNewMission}
              onOpenEditMission={onOpenEditMission}
              onOpenEditSchedule={onOpenEditSchedule}
              onOpenAgent={onOpenAgent}
            />
          ) : null}

          {activeSection === "approvals" ? (
            <ApprovalsDrawerSection
              theme={theme}
              timeLabels={timeLabels}
              t={t}
              onOpenAgent={onOpenAgent}
            />
          ) : null}

          {activeSection === "memory" ? (
            <MemoryDrawerSection
              theme={theme}
              t={t}
              onOpenMemoryModal={onOpenMemoryModal}
            />
          ) : null}

          {activeSection === "workers" ? (
            <WorkersDrawerSection
              theme={theme}
              timeLabels={timeLabels}
              t={t}
              onOpenAgent={onOpenAgent}
              onCloseDrawer={onClose}
            />
          ) : null}

          {activeSection === "routing" ? (
            <RoutingDrawerSection
              theme={theme}
              modelProviders={modelProviders}
              t={t}
              onOpenModelPicker={onOpenModelPicker}
            />
          ) : null}
        </ScrollView>
      </Animated.View>
    </View>
  );
});
