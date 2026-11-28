import { useRpc, useTranslation, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  deleteTriggerRpc,
  draftMissionRpc,
  installPresetRpc,
  saveMemoryRpc,
  upsertNativeScheduleRpc,
  upsertTriggerRpc,
  type CatalogProvider,
  type GovernanceLevel,
  type KnownWorkspace,
  type MissionDraft,
  type NativeScheduleItem,
  type PresetId,
  type TriggerKind,
  type TriggerSpec,
} from "../shared/contracts";
import { isModifierSubmitKey } from "./helpers";
import { messages } from "./i18n";

type PluginTheme = PluginScreenProps["theme"];
function useBotTranslation() {
  return useTranslation(messages);
}
export type TranslateFn = ReturnType<typeof useBotTranslation>["t"];

export const PRESET_DEFINITIONS = [
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
  {
    id: "session_tidy" as const,
    titleKey: "presetTidyTitle",
    descKey: "presetTidyDesc",
  },
] as const;

export function extractSimpleDailyTimeFromCronClient(cronExpr?: string): string | undefined {
  if (!cronExpr) return undefined;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [minStr, hourStr, dom, mon, dow] = parts;
  if (dom !== "*" || mon !== "*" || dow !== "*") return undefined;
  if (!/^\d{1,2}$/.test(minStr) || !/^\d{1,2}$/.test(hourStr)) return undefined;
  const min = Number.parseInt(minStr, 10);
  const hour = Number.parseInt(hourStr, 10);
  if (min < 0 || min > 59 || hour < 0 || hour > 23) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function isPresetAlreadyEnabled(
  presetId: PresetId,
  triggers: readonly TriggerSpec[],
  nativeSchedules: readonly NativeScheduleItem[] = [],
): boolean {
  for (const t of triggers) {
    if (!t.enabled) continue;
    if (presetId === "kb_inbox" && t.kind === "file_watch" && /00-Inbox/i.test(t.watchPath ?? "")) {
      return true;
    }
    if (presetId === "universal_webhook" && t.kind === "webhook") {
      return true;
    }
    if (presetId === "morning_briefing" && t.kind === "schedule" && t.dailyTime === "08:30") {
      return true;
    }
    if (presetId === "session_tidy" && t.kind === "schedule" && t.dailyTime === "22:30") {
      return true;
    }
  }
  for (const ns of nativeSchedules) {
    if (ns.status !== "active") continue;
    if (
      presetId === "morning_briefing" &&
      (ns.cronExpression === "30 8 * * *" || /早间汇总|晨间邮件/.test(ns.name))
    ) {
      return true;
    }
    if (
      presetId === "session_tidy" &&
      (ns.cronExpression === "30 22 * * *" || /会话自动整理/.test(ns.name))
    ) {
      return true;
    }
  }
  return false;
}

const TRIGGER_KIND_OPTIONS: readonly TriggerKind[] = [
  "schedule",
  "file_watch",
  "poll_command",
  "webhook",
];

const GOVERNANCE_OPTIONS: readonly GovernanceLevel[] = [
  "autonomous",
  "notify",
  "require_approval",
];

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

export function resolveModelLabel(
  providerModel: string | null | undefined,
  providers: readonly CatalogProvider[],
): string {
  const clean = providerModel?.trim();
  if (!clean) return "";
  const [provId, modelId] = clean.includes("/") ? clean.split("/", 2) : [clean, ""];
  const prov = providers.find((p) => p.id === provId);
  if (prov && modelId) {
    const model = prov.models.find((m) => m.id === modelId);
    if (model) return model.label;
  }
  return modelId || clean;
}

const modalStyles = StyleSheet.create({
  colGap6: { gap: 6 },
  colGap8: { gap: 8 },
  colGap10: { gap: 10 },
  colGap12: { gap: 12 },
  rowCenterBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  rowCenterGap6: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowWrapGap6: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  flex1: { flex: 1 },
  flex1Gap2: { flex: 1, gap: 2 },
  insetBox: { padding: 11, borderRadius: 10, borderWidth: 1, gap: 8 },
  presetRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: 10,
    borderRadius: 9,
  },
  presetBtn: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: 7, borderWidth: 1 },
  modalInput: { borderWidth: 1, borderRadius: 8, padding: 10 },
  modalTextarea: { borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 88 },
  memoryTextarea: { borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 240, fontSize: 13 },
  primaryFullBtn: { paddingVertical: 11, borderRadius: 9, alignItems: "center" },
  optionChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  quickChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
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
  smallBorderBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  modelOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  pillBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  sectionHeader: { fontSize: 12, fontWeight: "700", letterSpacing: 0.3 },
  title14: { fontSize: 14, fontWeight: "700" },
  text11: { fontSize: 11 },
  text11Bold: { fontSize: 11, fontWeight: "700" },
  text12: { fontSize: 12 },
  text12Semi: { fontSize: 12, fontWeight: "600" },
  text13Semi: { fontSize: 13, fontWeight: "600" },
  text13Bold: { fontSize: 13, fontWeight: "700" },
  text14Bold: { fontSize: 14, fontWeight: "700" },
});

export const CreateOrEditMissionModal = memo(function CreateOrEditMissionModal({
  editingTrigger,
  editingSchedule = null,
  existingTriggers = [],
  existingNativeSchedules = [],
  knownWorkspaces,
  theme,
  t,
  onClose,
}: {
  editingTrigger: TriggerSpec | null;
  editingSchedule?: NativeScheduleItem | null;
  existingTriggers?: readonly TriggerSpec[];
  existingNativeSchedules?: readonly NativeScheduleItem[];
  knownWorkspaces: readonly KnownWorkspace[];
  theme: PluginTheme;
  t: TranslateFn;
  onClose: () => void;
}) {
  const toast = useToast();
  const draftMission = useRpc(draftMissionRpc);
  const upsertTrigger = useRpc(upsertTriggerRpc);
  const upsertNativeSchedule = useRpc(upsertNativeScheduleRpc);
  const deleteTrigger = useRpc(deleteTriggerRpc);
  const installPreset = useRpc(installPresetRpc);

  const isEdit = Boolean(editingTrigger || editingSchedule);
  const simpleSchedDaily = extractSimpleDailyTimeFromCronClient(
    editingSchedule?.cronExpression,
  );
  const [intentText, setIntentText] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [proposedDraft, setProposedDraft] = useState<MissionDraft | null>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(isEdit);

  const [newName, setNewName] = useState(
    editingSchedule?.name ?? editingTrigger?.name ?? "",
  );
  const [newKind, setNewKind] = useState<TriggerKind>(
    editingSchedule ? "schedule" : (editingTrigger?.kind ?? "schedule"),
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
  const [newDailyTime, setNewDailyTime] = useState(
    editingSchedule ? (simpleSchedDaily ?? "") : (editingTrigger?.dailyTime ?? ""),
  );
  const [newCron, setNewCron] = useState(
    editingSchedule && !simpleSchedDaily ? (editingSchedule.cronExpression ?? "") : "",
  );
  const [newCwd, setNewCwd] = useState(
    editingSchedule?.cwd || editingTrigger?.cwd || "~/Documents/KnowledgeBase",
  );
  const [newPrompt, setNewPrompt] = useState(
    editingSchedule?.prompt ?? editingTrigger?.prompt ?? "",
  );
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

  const handleInstallPreset = useCallback(
    async (presetId: PresetId) => {
      try {
        const created = await installPreset({ presetId });
        toast.show(t("presetEnabledToast", { name: created.name }), { variant: "success" });
        onClose();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [installPreset, onClose, t, toast],
  );

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
      if (editingSchedule || newKind === "schedule") {
        await upsertNativeSchedule({
          id: editingSchedule?.id,
          name: newName.trim(),
          prompt: newPrompt.trim(),
          cwd: newCwd.trim() || undefined,
          cron: newCron.trim() || undefined,
          dailyTime: !newCron.trim() && newDailyTime.trim() ? newDailyTime.trim() : undefined,
          everySec:
            !newCron.trim() &&
            !newDailyTime.trim() &&
            Number.isFinite(intervalNum) &&
            intervalNum >= 60
              ? intervalNum
              : undefined,
          governance: editingSchedule ? undefined : newGovernance,
          noiseRules: editingTrigger ? noiseRules : undefined,
        });
        if (editingTrigger?.id) {
          await deleteTrigger({ id: editingTrigger.id }).catch(() => undefined);
        }
      } else {
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
          noiseRules: isEdit ? noiseRules : undefined,
        });
      }
      onClose();
      toast.show(isEdit ? t("missionUpdatedToast") : t("missionSavedToast"), {
        variant: "success",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [
    deleteTrigger,
    editingSchedule,
    editingTrigger,
    isEdit,
    newCron,
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
    upsertNativeSchedule,
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
        <View style={modalStyles.colGap12}>
          {!isEdit ? (
            <View style={modalStyles.colGap8}>
              <Text style={[modalStyles.text12Semi, { color: theme.colors.foreground }]}>
                {t("intentPromptLabel")}
              </Text>
              <TextInput
                value={intentText}
                onChangeText={setIntentText}
                onSubmitEditing={() => void handleGenerateDraft()}
                placeholder={t("intentInputPlaceholder")}
                placeholderTextColor={theme.colors.foregroundMuted}
                style={[modalStyles.modalInput, inputThemeStyle]}
              />

              <View style={modalStyles.rowWrapGap6}>
                {(["intentExample1", "intentExample2", "intentExample3"] as const).map(
                  (key) => {
                    const label = t(key);
                    return (
                      <Pressable
                        key={key}
                        accessibilityRole="button"
                        onPress={() => void handleGenerateDraft(label)}
                        style={[
                          modalStyles.quickChip,
                          {
                            borderColor: theme.colors.border,
                            backgroundColor: theme.colors.surface2,
                          },
                        ]}
                      >
                        <Text style={[modalStyles.text11, { color: theme.colors.foreground }]}>
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
                  modalStyles.primaryFullBtn,
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
                    modalStyles.text13Bold,
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

          {proposedDraft ? (
            <View
              style={[
                modalStyles.insetBox,
                {
                  borderColor: theme.colors.accent,
                  backgroundColor: theme.colors.surface2,
                },
              ]}
            >
              <Text style={[modalStyles.text11Bold, { color: theme.colors.accent }]}>
                {t("draftPreviewTitle")}
              </Text>
              <Text style={[modalStyles.title14, { color: theme.colors.foreground }]}>
                {newName}
              </Text>
              <Text style={[modalStyles.text12, { color: theme.colors.foreground }]}>
                {proposedDraft.humanSummary}
              </Text>
              <Text style={[modalStyles.text11, { color: theme.colors.foregroundMuted }]}>
                {proposedDraft.rationale}
              </Text>
            </View>
          ) : null}

          {!isEdit ? (
            <View style={modalStyles.rowWrapGap6}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setPresetsOpen((v) => !v)}
                style={modalStyles.rowCenterGap6}
              >
                <Icon
                  name={presetsOpen ? "ChevronUp" : "Sparkles"}
                  size={13}
                  color={theme.colors.accent}
                />
                <Text style={[modalStyles.text12Semi, { color: theme.colors.accent }]}>
                  {presetsOpen ? t("presetsModalToggleHide") : t("presetsModalToggleShow")}
                </Text>
              </Pressable>

              <Text style={[modalStyles.text12, { color: theme.colors.foregroundMuted }]}>
                ·
              </Text>

              <Pressable
                accessibilityRole="button"
                onPress={() => setAdvancedOpen((v) => !v)}
                style={modalStyles.rowCenterGap6}
              >
                <Icon
                  name={advancedOpen ? "ChevronUp" : "ChevronDown"}
                  size={14}
                  color={theme.colors.foregroundMuted}
                />
                <Text style={[modalStyles.text12, { color: theme.colors.foregroundMuted }]}>
                  {advancedOpen ? t("advancedHide") : t("advancedShow")}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {!isEdit && presetsOpen ? (
            <View style={modalStyles.colGap6}>
              {PRESET_DEFINITIONS.map((preset) => {
                const alreadyEnabled = isPresetAlreadyEnabled(
                  preset.id,
                  existingTriggers,
                  existingNativeSchedules,
                );
                return (
                  <View
                    key={preset.id}
                    style={[
                      modalStyles.presetRow,
                      { backgroundColor: theme.colors.surface2 },
                    ]}
                  >
                    <View style={modalStyles.flex1Gap2}>
                      <Text style={[modalStyles.text12Semi, { color: theme.colors.foreground }]}>
                        {t(preset.titleKey)}
                      </Text>
                      <Text style={[modalStyles.text11, { color: theme.colors.foregroundMuted }]}>
                        {t(preset.descKey)}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      disabled={alreadyEnabled}
                      onPress={() => void handleInstallPreset(preset.id)}
                      style={[
                        modalStyles.presetBtn,
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
                          modalStyles.text11Bold,
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
          ) : null}

          {advancedOpen ? (
            <View style={modalStyles.colGap10}>
              <Text style={[modalStyles.text12, { color: theme.colors.foregroundMuted }]}>
                {t("fieldName")}
              </Text>
              <TextInput
                value={newName}
                onChangeText={setNewName}
                placeholder="例如：每日早间汇总"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={[modalStyles.modalInput, inputThemeStyle]}
              />

              {!editingSchedule ? (
                <>
                  <Text style={[modalStyles.text12, { color: theme.colors.foregroundMuted }]}>
                    {t("fieldKind")}
                  </Text>
                  <View style={modalStyles.rowWrapGap6}>
                    {TRIGGER_KIND_OPTIONS.map((k) => (
                      <Pressable
                        key={k}
                        accessibilityRole="button"
                        onPress={() => setNewKind(k)}
                        style={[
                          modalStyles.optionChip,
                          {
                            backgroundColor:
                              newKind === k ? theme.colors.accent : theme.colors.surface2,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            modalStyles.text12Semi,
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
                </>
              ) : null}

              {newKind === "schedule" ? (
                <View style={modalStyles.rowCenterGap6}>
                  <Icon name="RefreshCw" size={12} color={theme.colors.accent} />
                  <Text style={[modalStyles.text11, { color: theme.colors.accent }]}>
                    {t("modalScheduleSyncHint")}
                  </Text>
                </View>
              ) : null}

              {newKind === "file_watch" ? (
                <>
                  <Text style={[modalStyles.text12, { color: theme.colors.foregroundMuted }]}>
                    {t("fieldTargetPath")}
                  </Text>
                  <TextInput
                    value={newWatchPath}
                    onChangeText={setNewWatchPath}
                    style={[modalStyles.modalInput, inputThemeStyle]}
                  />
                </>
              ) : null}

              {newKind === "poll_command" ? (
                <>
                  <Text style={[modalStyles.text12, { color: theme.colors.foregroundMuted }]}>
                    {t("fieldPollCmd")}
                  </Text>
                  <TextInput
                    value={newPollCmd}
                    onChangeText={setNewPollCmd}
                    placeholder="ls -la 00-Inbox 或 https://api.example.com/status"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={[modalStyles.modalInput, inputThemeStyle]}
                  />
                </>
              ) : null}

              {newKind === "schedule" ? (
                <>
                  <Text style={[modalStyles.text12, { color: theme.colors.foregroundMuted }]}>
                    {t("fieldDailyTime")}
                  </Text>
                  <TextInput
                    value={newDailyTime}
                    onChangeText={setNewDailyTime}
                    placeholder="08:30"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={[modalStyles.modalInput, inputThemeStyle]}
                  />
                  <Text style={[modalStyles.text12, { color: theme.colors.foregroundMuted }]}>
                    {t("fieldCronExpr")}
                  </Text>
                  <TextInput
                    value={newCron}
                    onChangeText={setNewCron}
                    placeholder="例如：30 9,21 * * *"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={[modalStyles.modalInput, inputThemeStyle]}
                  />
                </>
              ) : null}

              {newKind === "poll_command" ||
              (newKind === "schedule" && !newDailyTime.trim() && !newCron.trim()) ? (
                <>
                  <Text style={[modalStyles.text12, { color: theme.colors.foregroundMuted }]}>
                    {t("fieldInterval")}
                  </Text>
                  <TextInput
                    value={newInterval}
                    onChangeText={setNewInterval}
                    style={[modalStyles.modalInput, inputThemeStyle]}
                  />
                </>
              ) : null}

              {!editingSchedule ? (
                <>
                  <Text style={[modalStyles.text12, { color: theme.colors.foregroundMuted }]}>
                    {t("fieldGovernance")}
                  </Text>
                  <View style={modalStyles.rowWrapGap6}>
                    {GOVERNANCE_OPTIONS.map((g) => (
                      <Pressable
                        key={g}
                        accessibilityRole="button"
                        onPress={() => setNewGovernance(g)}
                        style={[
                          modalStyles.optionChip,
                          {
                            backgroundColor:
                              newGovernance === g ? theme.colors.accent : theme.colors.surface2,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            modalStyles.text12,
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
                </>
              ) : null}

              <Text style={[modalStyles.text12, { color: theme.colors.foregroundMuted }]}>
                {t("fieldCwd")}
              </Text>
              {knownWorkspaces.length > 0 ? (
                <View style={modalStyles.rowWrapGap6}>
                  {knownWorkspaces.slice(0, 5).map((ws) => (
                    <Pressable
                      key={ws.cwd}
                      accessibilityRole="button"
                      onPress={() => setNewCwd(ws.cwd)}
                      style={[
                        modalStyles.quickChip,
                        {
                          borderColor:
                            newCwd === ws.cwd ? theme.colors.accent : theme.colors.border,
                          backgroundColor: theme.colors.surface2,
                        },
                      ]}
                    >
                      <Icon name="Folder" size={11} color={theme.colors.foregroundMuted} />
                      <Text style={[modalStyles.text11, { color: theme.colors.foreground }]}>
                        {ws.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              <TextInput
                value={newCwd}
                onChangeText={setNewCwd}
                style={[modalStyles.modalInput, inputThemeStyle]}
              />

              <Text style={[modalStyles.text12, { color: theme.colors.foregroundMuted }]}>
                {t("fieldPrompt")}
              </Text>
              <TextInput
                value={newPrompt}
                onChangeText={setNewPrompt}
                multiline
                placeholder="说明触发后需要检查什么、遇到什么情况发送提醒…"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={[modalStyles.modalTextarea, inputThemeStyle]}
              />

              {isEdit && noiseRules.length > 0 ? (
                <View style={modalStyles.colGap6}>
                  <Text style={[modalStyles.text12, { color: theme.colors.foregroundMuted }]}>
                    {t("noiseRulesLabel")}
                  </Text>
                  <View style={modalStyles.rowWrapGap6}>
                    {noiseRules.map((rule, idx) => (
                      <Pressable
                        key={`${idx}-${rule}`}
                        accessibilityRole="button"
                        onPress={() =>
                          setNoiseRules((prev) => prev.filter((_, i) => i !== idx))
                        }
                        style={[
                          modalStyles.microActionBtn,
                          {
                            borderColor: theme.colors.border,
                            backgroundColor: theme.colors.surface2,
                          },
                        ]}
                      >
                        <Text style={[modalStyles.text11, { color: theme.colors.foreground }]}>
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
              style={[modalStyles.primaryFullBtn, { backgroundColor: theme.colors.accent }]}
            >
              <Text style={[modalStyles.text14Bold, { color: theme.colors.accentForeground }]}>
                {isEdit ? t("saveChangesBtn") : t("createBtn")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
});

export const MemoryEditorModal = memo(function MemoryEditorModal({
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
        <View style={modalStyles.colGap12}>
          <TextInput
            value={memoryDraft}
            onChangeText={setMemoryDraft}
            onKeyPress={(e) => {
              if (isModifierSubmitKey(e)) void handleSave();
            }}
            multiline
            style={[
              modalStyles.memoryTextarea,
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
            style={[modalStyles.primaryFullBtn, { backgroundColor: theme.colors.accent }]}
          >
            <Text style={[modalStyles.text14Bold, { color: theme.colors.accentForeground }]}>
              {t("saveMemory")}
            </Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
});

export const ModelPickerModal = memo(function ModelPickerModal({
  selectedProvider,
  defaultProvider,
  providers,
  loading,
  theme,
  t,
  onSelect,
  onRefresh,
  onClose,
}: {
  selectedProvider: string | null;
  defaultProvider: string;
  providers: readonly CatalogProvider[];
  loading: boolean;
  theme: PluginTheme;
  t: TranslateFn;
  onSelect: (providerModel: string | null) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const defaultReadable = resolveModelLabel(defaultProvider, providers);

  return (
    <Modal
      title={t("modelPickerTitle")}
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content>
        <View style={modalStyles.colGap12}>
          <View
            style={[
              modalStyles.insetBox,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <View style={modalStyles.rowCenterBetween}>
              <View style={[modalStyles.rowCenterGap6, modalStyles.flex1]}>
                <Icon name="GitBranch" size={13} color={theme.colors.accent} />
                <Text
                  style={[
                    modalStyles.text12,
                    { color: theme.colors.foregroundMuted, flexShrink: 1 },
                  ]}
                >
                  {t("modelPickerInheritHint")}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                disabled={loading}
                onPress={onRefresh}
                style={[
                  modalStyles.smallBorderBtn,
                  {
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surface1,
                    opacity: loading ? 0.6 : 1,
                  },
                ]}
              >
                <Icon name="RefreshCw" size={11} color={theme.colors.foregroundMuted} />
                <Text style={[modalStyles.text11, { color: theme.colors.foreground }]}>
                  {t("modelPickerRefresh")}
                </Text>
              </Pressable>
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={() => {
              onSelect(null);
              onClose();
            }}
            style={[
              modalStyles.modelOptionRow,
              {
                borderColor: !selectedProvider ? theme.colors.accent : theme.colors.border,
                backgroundColor: !selectedProvider ? theme.colors.surface2 : theme.colors.surface1,
              },
            ]}
          >
            <View style={modalStyles.flex1Gap2}>
              <Text style={[modalStyles.text13Semi, { color: theme.colors.foreground }]}>
                {t("modelPickerDefaultLabel")}
              </Text>
              <Text style={[modalStyles.text11, { color: theme.colors.foregroundMuted }]}>
                {defaultReadable && defaultReadable !== defaultProvider
                  ? `${defaultReadable} · ${defaultProvider}`
                  : defaultProvider}
              </Text>
            </View>
            {!selectedProvider ? (
              <Icon name="Check" size={15} color={theme.colors.accent} />
            ) : null}
          </Pressable>

          {loading && providers.length === 0 ? (
            <Text style={[modalStyles.text12, { color: theme.colors.foregroundMuted }]}>
              {t("modelPickerLoading")}
            </Text>
          ) : providers.length === 0 ? (
            <Text style={[modalStyles.text12, { color: theme.colors.foregroundMuted }]}>
              {t("modelPickerEmpty")}
            </Text>
          ) : (
            providers.map((prov) => (
              <View key={prov.id} style={modalStyles.colGap6}>
                <Text style={[modalStyles.sectionHeader, { color: theme.colors.foregroundMuted }]}>
                  {prov.label}
                </Text>
                {prov.models.map((m) => {
                  const pair = `${prov.id}/${m.id}`;
                  const active = selectedProvider === pair;
                  return (
                    <Pressable
                      key={pair}
                      accessibilityRole="button"
                      onPress={() => {
                        onSelect(pair);
                        onClose();
                      }}
                      style={[
                        modalStyles.modelOptionRow,
                        {
                          borderColor: active ? theme.colors.accent : theme.colors.border,
                          backgroundColor: active ? theme.colors.surface2 : theme.colors.surface1,
                        },
                      ]}
                    >
                      <View style={modalStyles.flex1Gap2}>
                        <View style={modalStyles.rowCenterGap6}>
                          <Text style={[modalStyles.text13Semi, { color: theme.colors.foreground }]}>
                            {m.label}
                          </Text>
                          {m.isDefault ? (
                            <View
                              style={[
                                modalStyles.pillBadge,
                                { backgroundColor: theme.colors.surface0 },
                              ]}
                            >
                              <Text
                                style={[
                                  modalStyles.text11,
                                  { color: theme.colors.foregroundMuted },
                                ]}
                              >
                                {t("modelPickerDefault")}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                        <Text
                          numberOfLines={1}
                          style={[modalStyles.text11, { color: theme.colors.foregroundMuted }]}
                        >
                          {m.description ? `${pair} · ${m.description}` : pair}
                        </Text>
                      </View>
                      {active ? <Icon name="Check" size={15} color={theme.colors.accent} /> : null}
                    </Pressable>
                  );
                })}
              </View>
            ))
          )}
        </View>
      </Modal.Content>
    </Modal>
  );
});
