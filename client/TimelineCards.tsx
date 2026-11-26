import {
  useRpc,
  useTranslation,
  type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { Icon, Markdown, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useState } from "react";
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
import { messages } from "./i18n";

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
  microBtnText: {
    fontSize: 12,
    fontWeight: "600",
  },
  actionsBlock: {
    gap: 8,
    marginTop: 2,
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
  trustBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
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
  const [calibrateOpen, setCalibrateOpen] = useState(false);
  const [ruleNote, setRuleNote] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const handleSnooze = useCallback(async () => {
    if (busyId) return;
    setBusyId("snooze");
    try {
      const res = await runAction({
        feedId: data.feedId,
        customKind: "snooze",
        delayMinutes: 120,
      });
      toast.show(res.message, { variant: "info" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }, [busyId, data.feedId, runAction, toast]);

  const handleFeedbackUp = useCallback(async () => {
    if (busyId) return;
    setBusyId("up");
    try {
      await curateFeed({ feedId: data.feedId, feedback: "up" });
      setCalibrateOpen(false);
      toast.show(t("tasteUpSaved"), { variant: "success" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }, [busyId, curateFeed, data.feedId, t, toast]);

  const handleSubmitDown = useCallback(
    async (presetNote?: string) => {
      if (busyId) return;
      setBusyId("down");
      try {
        const finalNote = (presetNote ?? ruleNote).trim() || undefined;
        await curateFeed({
          feedId: data.feedId,
          feedback: "down",
          ruleNote: finalNote,
        });
        setCalibrateOpen(false);
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
        {data.triggerName ? (
          <Text style={[baseStyles.mutedSmall, { color: theme.colors.foregroundMuted }]}>
            {data.triggerName}
          </Text>
        ) : null}
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

        <Pressable
          accessibilityRole="button"
          disabled={busyId !== null}
          onPress={() => void handleSnooze()}
          style={[
            baseStyles.microBtn,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
            },
          ]}
        >
          <Icon name="Clock" size={12} color={theme.colors.foregroundMuted} />
          <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
            {t("snooze2h")}
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={busyId !== null}
          onPress={() => void handleFeedbackUp()}
          style={[
            baseStyles.microBtn,
            {
              borderColor:
                data.feedback === "up" ? theme.colors.statusSuccess : theme.colors.border,
              backgroundColor: theme.colors.surface2,
            },
          ]}
        >
          <Icon
            name="ThumbsUp"
            size={12}
            color={
              data.feedback === "up"
                ? theme.colors.statusSuccess
                : theme.colors.foregroundMuted
            }
          />
          <Text
            style={{
              fontSize: 11,
              color:
                data.feedback === "up"
                  ? theme.colors.statusSuccess
                  : theme.colors.foregroundMuted,
            }}
          >
            {t("tasteUp")}
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={busyId !== null}
          onPress={() => setCalibrateOpen((v) => !v)}
          style={[
            baseStyles.microBtn,
            {
              borderColor:
                data.feedback === "down" ? theme.colors.statusWarning : theme.colors.border,
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
                  : theme.colors.foregroundMuted,
            }}
          >
            {t("tasteDown")}
          </Text>
        </Pressable>
      </View>

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
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const isPending = data.status === "pending";
  const isEdited = editingDraft && draftText.trim() !== initialPreview.trim();

  const borderTone =
    data.status === "approved"
      ? theme.colors.statusSuccess
      : data.status === "rejected"
        ? theme.colors.foregroundMuted
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
    async (decision: "approved" | "rejected", promoteTrust = false) => {
      if (busy) return;
      setBusy(true);
      try {
        const res = await resolveApproval({
          id: data.approvalId,
          decision,
          note: note.trim() || undefined,
          editedFollowUpPrompt:
            decision === "approved" && isEdited ? draftText.trim() : undefined,
          promoteTrust: decision === "approved" && promoteTrust ? true : undefined,
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
    [busy, data.approvalId, draftText, isEdited, note, resolveApproval, t, toast],
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
          <View style={baseStyles.buttonRow}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void onDecide("approved", false)}
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

            {data.triggerId ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void onDecide("approved", true)}
                style={[
                  baseStyles.trustBtn,
                  {
                    borderColor: theme.colors.accent,
                    backgroundColor: theme.colors.surface2,
                    opacity: busy ? 0.6 : 1,
                  },
                ]}
              >
                <Icon name="Zap" size={13} color={theme.colors.accent} />
                <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.accent }}>
                  {t("approveAndTrust")}
                </Text>
              </Pressable>
            ) : null}

            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void onDecide("rejected", false)}
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
