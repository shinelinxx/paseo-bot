import {
  useRpc,
  useTranslation,
  type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import {
  copyText,
  Icon,
  Markdown,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  curateFeedRpc,
  executeFeedActionRpc,
  resolveApprovalRpc,
  type ApprovalRisk,
  type BotAlertTimelineData,
  type BotApprovalTimelineData,
  type FeedAction,
} from "../shared/contracts";
import { formatSmartTime, minutesUntilTomorrowMorning } from "./helpers";
import { messages } from "./i18n";
import { optimisticCurateFeed, optimisticResolveApproval } from "./store";

const baseStyles = StyleSheet.create({
  alertCard: {
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: 12,
    gap: 9,
    marginVertical: 4,
  },
  approvalCard: {
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: 12,
    gap: 10,
    marginVertical: 4,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  titleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
  },
  alertTitle: {
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
  },
  approvalTitle: {
    fontSize: 14,
    fontWeight: "700",
    flexShrink: 1,
  },
  mutedSmall: {
    fontSize: 11,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700",
  },
  bodyText: {
    fontSize: 13,
  },
  layer2Box: {
    borderWidth: 1,
    borderRadius: 9,
    padding: 10,
    gap: 6,
  },
  stagingBox: {
    borderWidth: 1,
    borderRadius: 9,
    padding: 10,
    gap: 8,
  },
  stagingCodeText: {
    fontSize: 12,
    lineHeight: 18,
  },
  stagingEditor: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    minHeight: 84,
    fontSize: 12,
  },
  actionFooterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 6,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
  },
  microBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  moreIconBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  microBtnText: {
    fontSize: 12,
    fontWeight: "600",
  },
  actionsBlock: {
    gap: 8,
    marginTop: 2,
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 2,
  },
  noteInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
  },
  buttonRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  approveBtn: {
    flex: 1,
    minWidth: 110,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  approveBtnText: {
    fontSize: 13,
    fontWeight: "600",
  },
  rejectBtn: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  noteText: {
    fontSize: 12,
  },
});

const RISK_KEY_MAP: Record<ApprovalRisk, "risk_low" | "risk_medium" | "risk_high"> = {
  low: "risk_low",
  medium: "risk_medium",
  high: "risk_high",
};

const BotAlertTimelineCardInner = memo(function BotAlertTimelineCardInner({
  item,
  theme,
  layout,
}: PluginTimelineItemProps<BotAlertTimelineData>) {
  const { data } = item;
  const { t } = useTranslation(messages);
  const toast = useToast();
  const runAction = useRpc(executeFeedActionRpc);
  const curateFeed = useRpc(curateFeedRpc);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [calibrateOpen, setCalibrateOpen] = useState(false);
  const [ruleNote, setRuleNote] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const timeLabels = useMemo(
    () => ({
      justNow: t("timeJustNow"),
      minsAgo: (count: number) => t("timeMinsAgo", { count }),
      todayAt: (time: string) => t("timeTodayAt", { time }),
      yesterdayAt: (time: string) => t("timeYesterdayAt", { time }),
    }),
    [t],
  );

  const accentColor =
    data.level === "error"
      ? theme.colors.statusDanger
      : data.level === "approval_required"
        ? theme.colors.statusWarning
        : data.level === "worker_update"
          ? theme.colors.statusSuccess
          : theme.colors.accent;

  const handleAction = useCallback(
    async (act: FeedAction) => {
      if (busyId || act.executedAt) return;
      setBusyId(act.id);
      try {
        const res = await runAction({ feedId: data.feedId, actionId: act.id });
        toast.show(res.message, { variant: res.ok ? "success" : "warning" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, data.feedId, runAction, toast],
  );

  const handleSnooze = useCallback(
    async (delayMinutes: number) => {
      if (busyId) return;
      setBusyId("snooze");
      try {
        const res = await runAction({
          feedId: data.feedId,
          customKind: "snooze",
          delayMinutes,
        });
        setSnoozeOpen(false);
        setMoreOpen(false);
        toast.show(res.message, { variant: "info" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, data.feedId, runAction, toast],
  );

  const handleCopy = useCallback(() => {
    void copyText(data.details || data.summary)
      .then(() => {
        setMoreOpen(false);
        toast.show(t("copiedToast"), { variant: "success" });
      })
      .catch(() => toast.error("Copy failed"));
  }, [data.details, data.summary, t, toast]);

  const handleSubmitDown = useCallback(
    async (presetNote?: string) => {
      if (busyId) return;
      setBusyId("down");
      optimisticCurateFeed(data.feedId, "down");
      try {
        const finalNote = (presetNote ?? ruleNote).trim() || undefined;
        await curateFeed({
          feedId: data.feedId,
          feedback: "down",
          ruleNote: finalNote,
        });
        setCalibrateOpen(false);
        setMoreOpen(false);
        setRuleNote("");
        toast.show(t("tasteDownSaved"), { variant: "info" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, curateFeed, data.feedId, ruleNote, t, toast],
  );

  const actions = data.actions ?? [];

  return (
    <View
      style={[
        baseStyles.alertCard,
        {
          borderColor: theme.colors.border,
          borderLeftColor: accentColor,
          backgroundColor: theme.colors.surface1,
          padding: layout.compact ? 12 : 14,
        },
      ]}
    >
      <View style={baseStyles.headerRow}>
        <View style={baseStyles.titleGroup}>
          <Icon name="Bot" size={16} color={accentColor} />
          <Text style={[baseStyles.alertTitle, { color: theme.colors.foreground }]}>
            {data.title}
          </Text>
        </View>
        <View style={baseStyles.chipRow}>
          <Text style={[baseStyles.mutedSmall, { color: theme.colors.foregroundMuted }]}>
            {data.triggerName ? `${data.triggerName} · ` : ""}
            {formatSmartTime(data.createdAt, timeLabels)}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("moreActions")}
            onPress={() => {
              setMoreOpen((v) => {
                const next = !v;
                if (!next) {
                  setSnoozeOpen(false);
                  setCalibrateOpen(false);
                }
                return next;
              });
            }}
            style={[
              baseStyles.moreIconBtn,
              {
                borderColor: moreOpen ? theme.colors.accent : theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <Icon name="MoreHorizontal" size={13} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      </View>

      {data.details && data.details.startsWith(data.summary.slice(0, 48)) ? (
        <View style={{ gap: 6 }}>
          <Markdown>{detailsOpen ? data.details : data.summary}</Markdown>
          <Pressable
            accessibilityRole="button"
            onPress={() => setDetailsOpen((v) => !v)}
            style={baseStyles.titleGroup}
          >
            <Icon
              name={detailsOpen ? "ChevronUp" : "ChevronDown"}
              size={13}
              color={theme.colors.accent}
            />
            <Text style={[baseStyles.mutedSmall, { color: theme.colors.accent, fontWeight: "600" }]}>
              {detailsOpen ? t("fullReportHide") : t("fullReportShow")}
            </Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Markdown>{data.summary}</Markdown>
          {data.details ? (
            <View style={{ gap: 6 }}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setDetailsOpen((v) => !v)}
                style={baseStyles.titleGroup}
              >
                <Icon
                  name={detailsOpen ? "ChevronUp" : "ChevronDown"}
                  size={13}
                  color={theme.colors.foregroundMuted}
                />
                <Text style={[baseStyles.mutedSmall, { color: theme.colors.foregroundMuted }]}>
                  {detailsOpen ? t("layer2Hide") : t("layer2Show")}
                </Text>
              </Pressable>
              {detailsOpen ? (
                <View
                  style={[
                    baseStyles.layer2Box,
                    {
                      borderColor: theme.colors.border,
                      backgroundColor: theme.colors.surface2,
                    },
                  ]}
                >
                  <Markdown>{data.details}</Markdown>
                </View>
              ) : null}
            </View>
          ) : null}
        </>
      )}

      {actions.length > 0 ? (
        <View style={baseStyles.chipRow}>
          {actions.map((act) => {
            const done = Boolean(act.executedAt);
            return (
              <Pressable
                key={act.id}
                accessibilityRole="button"
                disabled={done || busyId !== null}
                onPress={() => void handleAction(act)}
                style={[
                  baseStyles.microBtn,
                  {
                    borderColor: done ? theme.colors.border : theme.colors.accent,
                    backgroundColor: done ? theme.colors.surface2 : theme.colors.surface1,
                    opacity: busyId === act.id ? 0.6 : 1,
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
                    baseStyles.microBtnText,
                    { color: done ? theme.colors.foregroundMuted : theme.colors.foreground },
                  ]}
                >
                  {done ? t("doneActionPrefix", { label: act.label }) : act.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {moreOpen ? (
        <View style={baseStyles.chipRow}>
          <Pressable
            accessibilityRole="button"
            disabled={busyId !== null}
            onPress={() => {
              setSnoozeOpen((v) => !v);
              setCalibrateOpen(false);
            }}
            style={[
              baseStyles.microBtn,
              {
                borderColor: snoozeOpen ? theme.colors.accent : theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <Icon name="Clock" size={12} color={theme.colors.foregroundMuted} />
            <Text style={{ fontSize: 11, color: theme.colors.foreground }}>
              {t("snoozeMenuBtn")}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={busyId !== null}
            onPress={() => {
              setCalibrateOpen((v) => !v);
              setSnoozeOpen(false);
            }}
            style={[
              baseStyles.microBtn,
              {
                borderColor:
                  calibrateOpen || data.feedback === "down"
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
                data.feedback === "down"
                  ? theme.colors.statusWarning
                  : theme.colors.foregroundMuted
              }
            />
            <Text
              style={{
                fontSize: 11,
                color:
                  data.feedback === "down"
                    ? theme.colors.statusWarning
                    : theme.colors.foreground,
              }}
            >
              {t("tasteDown")}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={handleCopy}
            style={[
              baseStyles.microBtn,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <Icon name="Copy" size={11} color={theme.colors.foregroundMuted} />
            <Text style={{ fontSize: 11, color: theme.colors.foreground }}>
              {t("copyCard")}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {snoozeOpen ? (
        <View style={baseStyles.chipRow}>
          {[
            { label: t("snooze1h"), mins: 60 },
            { label: t("snooze3h"), mins: 180 },
            { label: t("snoozeTomorrowMorning"), mins: minutesUntilTomorrowMorning(9, 0) },
          ].map((opt) => (
            <Pressable
              key={opt.label}
              accessibilityRole="button"
              disabled={busyId !== null}
              onPress={() => void handleSnooze(opt.mins)}
              style={[
                baseStyles.microBtn,
                {
                  borderColor: theme.colors.accent,
                  backgroundColor: theme.colors.surface2,
                },
              ]}
            >
              <Icon name="Clock" size={11} color={theme.colors.accent} />
              <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.foreground }}>
                {opt.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {calibrateOpen ? (
        <View
          style={[
            baseStyles.layer2Box,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
              gap: 8,
            },
          ]}
        >
          <View style={baseStyles.chipRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => void handleSubmitDown(t("tastePresetMinor"))}
              style={[
                baseStyles.microBtn,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                },
              ]}
            >
              <Text style={{ fontSize: 11, color: theme.colors.foreground }}>
                {t("tastePresetMinor")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => void handleSubmitDown(t("tastePresetDigest"))}
              style={[
                baseStyles.microBtn,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                },
              ]}
            >
              <Text style={{ fontSize: 11, color: theme.colors.foreground }}>
                {t("tastePresetDigest")}
              </Text>
            </Pressable>
          </View>
          <View style={baseStyles.headerRow}>
            <TextInput
              value={ruleNote}
              onChangeText={setRuleNote}
              onSubmitEditing={() => void handleSubmitDown()}
              placeholder={t("tasteRulePlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={[
                baseStyles.noteInput,
                {
                  flex: 1,
                  borderColor: theme.colors.border,
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface1,
                },
              ]}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => void handleSubmitDown()}
              style={[
                baseStyles.microBtn,
                {
                  borderColor: theme.colors.accent,
                  backgroundColor: theme.colors.accent,
                  paddingVertical: 7,
                },
              ]}
            >
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: "600",
                  color: theme.colors.accentForeground,
                }}
              >
                {t("tasteApplyBtn")}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
});

export function BotAlertTimelineCard(props: PluginTimelineItemProps<BotAlertTimelineData>) {
  return <BotAlertTimelineCardInner {...props} />;
}

const BotApprovalTimelineCardInner = memo(function BotApprovalTimelineCardInner({
  item,
  theme,
  layout,
}: PluginTimelineItemProps<BotApprovalTimelineData>) {
  const { data } = item;
  const { t } = useTranslation(messages);
  const resolveApproval = useRpc(resolveApprovalRpc);
  const toast = useToast();

  const initialPreview = data.payloadPreview || data.followUpPrompt || "";
  const [previewOpen, setPreviewOpen] = useState(Boolean(data.payloadPreview));
  const [editingDraft, setEditingDraft] = useState(false);
  const [draftText, setDraftText] = useState(initialPreview);
  const [trustChecked, setTrustChecked] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const isPending = data.status === "pending";
  const isHighRisk = data.riskLevel === "high";
  const isEdited = draftText.trim() !== initialPreview.trim();

  const borderTone =
    data.status === "approved"
      ? theme.colors.statusSuccess
      : data.status === "rejected"
        ? theme.colors.foregroundMuted
        : isHighRisk
          ? theme.colors.statusDanger
          : theme.colors.statusWarning;

  const badgeLabel =
    data.status === "pending"
      ? t(RISK_KEY_MAP[data.riskLevel])
      : data.status === "approved"
        ? data.promotedTrust
          ? `${t("statusApproved")} · ${t("promotedBadge")}`
          : t("statusApproved")
        : t("statusRejected");

  const onDecide = useCallback(
    async (decision: "approved" | "rejected") => {
      if (busy) return;
      setBusy(true);
      optimisticResolveApproval(data.approvalId, decision);
      try {
        const res = await resolveApproval({
          id: data.approvalId,
          decision,
          note: note.trim() || undefined,
          editedFollowUpPrompt:
            decision === "approved" && isEdited ? draftText.trim() : undefined,
          promoteTrust:
            decision === "approved" && !isHighRisk && trustChecked ? true : undefined,
        });
        toast.show(
          decision === "approved"
            ? res.promotedTriggerName
              ? t("promotedToast", { name: res.promotedTriggerName })
              : t("approvedToast")
            : t("rejectedToast"),
          { variant: decision === "approved" ? "success" : "info" },
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [
      busy,
      data.approvalId,
      draftText,
      isEdited,
      isHighRisk,
      note,
      resolveApproval,
      t,
      toast,
      trustChecked,
    ],
  );

  return (
    <View
      style={[
        baseStyles.approvalCard,
        {
          borderColor: theme.colors.border,
          borderLeftColor: borderTone,
          backgroundColor: theme.colors.surface1,
          padding: layout.compact ? 12 : 16,
        },
      ]}
    >
      <View style={baseStyles.headerRow}>
        <View style={baseStyles.titleGroup}>
          <Icon
            name={data.status === "approved" ? "ShieldCheck" : "ShieldAlert"}
            size={16}
            color={borderTone}
          />
          <Text style={[baseStyles.approvalTitle, { color: theme.colors.foreground }]}>
            {data.title}
          </Text>
        </View>
        <View style={[baseStyles.badge, { backgroundColor: theme.colors.surface2 }]}>
          <Text style={[baseStyles.badgeText, { color: borderTone }]}>{badgeLabel}</Text>
        </View>
      </View>

      <Text style={[baseStyles.bodyText, { color: theme.colors.foreground }]}>
        {data.actionSummary}
      </Text>
      <Text style={[baseStyles.mutedSmall, { color: theme.colors.foregroundMuted }]}>
        {data.triggerName ? `${data.triggerName}  ·  ` : ""}
        {data.cwd}
      </Text>

      {initialPreview ? (
        <View style={{ gap: 6 }}>
          <View style={baseStyles.headerRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPreviewOpen((v) => !v)}
              style={baseStyles.titleGroup}
            >
              <Icon
                name={previewOpen ? "ChevronUp" : "Eye"}
                size={13}
                color={theme.colors.accent}
              />
              <Text
                style={[
                  baseStyles.mutedSmall,
                  { color: theme.colors.accent, fontWeight: "600" },
                ]}
              >
                {previewOpen ? t("stagingHide") : t("stagingShow")}
              </Text>
            </Pressable>

            {isPending && previewOpen ? (
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
              >
                <Text style={[baseStyles.mutedSmall, { color: theme.colors.foregroundMuted }]}>
                  {editingDraft ? t("stagingCancelEdit") : t("stagingEdit")}
                </Text>
              </Pressable>
            ) : null}
          </View>

          {previewOpen ? (
            editingDraft && isPending ? (
              <TextInput
                value={draftText}
                onChangeText={setDraftText}
                multiline
                style={[
                  baseStyles.stagingEditor,
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
                  baseStyles.stagingBox,
                  {
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surface2,
                  },
                ]}
              >
                <Text
                  selectable
                  style={[baseStyles.stagingCodeText, { color: theme.colors.foreground }]}
                >
                  {draftText}
                </Text>
              </View>
            )
          ) : null}
        </View>
      ) : null}

      {isPending ? (
        <View style={baseStyles.actionsBlock}>
          <View style={baseStyles.actionFooterRow}>
            {data.triggerId && !isHighRisk ? (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: trustChecked }}
                onPress={() => setTrustChecked((v) => !v)}
                style={baseStyles.checkboxRow}
              >
                <Icon
                  name={trustChecked ? "CheckSquare" : "Square"}
                  size={14}
                  color={trustChecked ? theme.colors.accent : theme.colors.foregroundMuted}
                />
                <Text style={{ fontSize: 12, color: theme.colors.foreground }}>
                  {t("trustCheckboxLabel")}
                </Text>
              </Pressable>
            ) : (
              <View />
            )}

            <Pressable
              accessibilityRole="button"
              onPress={() => setNoteOpen((v) => !v)}
              style={baseStyles.checkboxRow}
            >
              <Icon
                name={noteOpen ? "ChevronUp" : "Plus"}
                size={12}
                color={theme.colors.foregroundMuted}
              />
              <Text style={[baseStyles.mutedSmall, { color: theme.colors.foregroundMuted }]}>
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
                baseStyles.noteInput,
                {
                  borderColor: theme.colors.border,
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface2,
                },
              ]}
            />
          ) : null}

          <View style={baseStyles.buttonRow}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void onDecide("approved")}
              style={[
                baseStyles.approveBtn,
                {
                  backgroundColor: theme.colors.accent,
                  opacity: busy ? 0.6 : 1,
                },
              ]}
            >
              <Text
                style={[
                  baseStyles.approveBtnText,
                  { color: theme.colors.accentForeground },
                ]}
              >
                {isEdited ? t("approveEdited") : t("approve")}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void onDecide("rejected")}
              style={[
                baseStyles.rejectBtn,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface2,
                  opacity: busy ? 0.6 : 1,
                },
              ]}
            >
              <Text style={[baseStyles.bodyText, { color: theme.colors.foreground }]}>
                {t("reject")}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : data.decisionNote ? (
        <Text style={[baseStyles.noteText, { color: theme.colors.foregroundMuted }]}>
          {t("notePrefix", { note: data.decisionNote })}
        </Text>
      ) : null}
    </View>
  );
});

export function BotApprovalTimelineCard(
  props: PluginTimelineItemProps<BotApprovalTimelineData>,
) {
  return <BotApprovalTimelineCardInner {...props} />;
}
