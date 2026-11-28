import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  resolveApprovalRpc,
  type ApprovalItem,
  type ApprovalRisk,
} from "../shared/contracts";
import type { TranslateFn } from "./ConsoleModals";
import { formatSmartTime, shortenPathForDisplay, type RelativeTimeLabels } from "./helpers";
import { optimisticResolveApproval, useBotSelector } from "./store";

type PluginTheme = PluginScreenProps["theme"];

const RISK_LABEL_KEYS: Record<ApprovalRisk, "risk_low" | "risk_medium" | "risk_high"> = {
  low: "risk_low",
  medium: "risk_medium",
  high: "risk_high",
};

const styles = StyleSheet.create({
  streamWrap: {
    alignSelf: "flex-start",
    width: "100%",
    maxWidth: 540,
  },
  drawerWrap: {
    width: "100%",
  },
  resolvedBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 14,
    borderWidth: 1,
  },
  resolvedLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
  },
  resolvedText: {
    fontSize: 12,
    flexShrink: 1,
  },
  resolvedLink: {
    fontSize: 12,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 15,
    paddingVertical: 13,
    gap: 10,
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
  titleText: {
    fontSize: 14,
    fontWeight: "700",
    flexShrink: 1,
  },
  riskBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  riskText: {
    fontSize: 11,
    fontWeight: "600",
  },
  summaryText: {
    fontSize: 13.5,
    lineHeight: 20,
  },
  metaText: {
    fontSize: 11,
  },
  previewSection: {
    gap: 6,
  },
  previewHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  inlineLinkBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 2,
  },
  previewBox: {
    borderRadius: 11,
    borderWidth: 1,
    padding: 10,
    gap: 7,
  },
  previewCodeText: {
    fontSize: 12,
    lineHeight: 18,
  },
  previewTextarea: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    minHeight: 84,
    fontSize: 12,
    lineHeight: 18,
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 2,
  },
  checkboxLabel: {
    fontSize: 12,
    flex: 1,
  },
  optionsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  noteInput: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 8,
    fontSize: 12,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 2,
  },
  confirmBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  confirmBtnText: {
    fontSize: 13,
    fontWeight: "700",
  },
  skipBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
  },
  skipBtnText: {
    fontSize: 13,
    fontWeight: "500",
  },
  text11: {
    fontSize: 11,
  },
  text12Semi: {
    fontSize: 12,
    fontWeight: "600",
  },
});

export interface InlineApprovalCardProps {
  approvalId?: string;
  approval?: ApprovalItem;
  fallbackText?: string;
  inDrawer?: boolean;
  timeLabels: RelativeTimeLabels;
  theme: PluginTheme;
  t: TranslateFn;
  onOpenAgent: (agentId: string) => void;
}

export const InlineApprovalCard = memo(function InlineApprovalCard({
  approvalId,
  approval: explicitApproval,
  fallbackText,
  inDrawer = false,
  timeLabels,
  theme,
  t,
  onOpenAgent,
}: InlineApprovalCardProps) {
  const toast = useToast();
  const resolveApproval = useRpc(resolveApprovalRpc);

  const storeData = useBotSelector((s) => {
    const found = explicitApproval
      ? explicitApproval
      : approvalId
        ? s.approvals.find((a) => a.id === approvalId)
        : undefined;
    const triggerApprovedCount =
      found?.triggerId
        ? (s.triggers.find((trg) => trg.id === found.triggerId)?.approvedCount ?? 0)
        : 0;
    return {
      apr: found ?? null,
      triggerApprovedCount,
    };
  });

  const apr = explicitApproval ?? storeData.apr;
  const initialPreview = apr ? apr.payloadPreview || apr.followUpPrompt : "";
  const [previewOpen, setPreviewOpen] = useState(() => Boolean(apr?.payloadPreview));
  const [editingDraft, setEditingDraft] = useState(false);
  const [draftText, setDraftText] = useState(initialPreview);
  const [trustChecked, setTrustChecked] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const parsedChecklist = useMemo(() => {
    if (!draftText) return null;
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
      if (!apr || busy) return;
      const isHighRisk = apr.riskLevel === "high";
      const isEdited = draftText.trim() !== initialPreview.trim();
      setBusy(true);
      optimisticResolveApproval(apr.id, decision);
      try {
        const res = await resolveApproval({
          id: apr.id,
          decision,
          note: note.trim() || undefined,
          editedFollowUpPrompt:
            decision === "approved" && isEdited ? draftText.trim() : undefined,
          promoteTrust:
            decision === "approved" && !isHighRisk && trustChecked ? true : undefined,
        });
        if (decision === "approved") {
          toast.show(
            res.promotedTriggerName
              ? t("promotedToast", { name: res.promotedTriggerName })
              : t("approvedToast"),
            { variant: "success" },
          );
        } else {
          toast.show(t("rejectedToast"), { variant: "info" });
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [apr, busy, draftText, initialPreview, note, resolveApproval, t, toast, trustChecked],
  );

  // Graceful fallback if an old message referenced a pruned approval item
  if (!apr) {
    if (!fallbackText) return null;
    return (
      <View style={inDrawer ? styles.drawerWrap : styles.streamWrap}>
        <View
          style={[
            styles.resolvedBar,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            },
          ]}
        >
          <View style={styles.resolvedLeft}>
            <Icon name="Check" size={13} color={theme.colors.foregroundMuted} />
            <Text
              numberOfLines={2}
              style={[styles.resolvedText, { color: theme.colors.foregroundMuted }]}
            >
              {fallbackText}
            </Text>
          </View>
        </View>
      </View>
    );
  }

  // Resolved state converges into a single quiet status bar in the conversation stream
  if (apr.status !== "pending") {
    const approved = apr.status === "approved";
    const statusText = approved
      ? t("inlineApprovalResolvedApproved", { title: apr.title })
      : t("inlineApprovalResolvedRejected", { title: apr.title });
    return (
      <View style={inDrawer ? styles.drawerWrap : styles.streamWrap}>
        <View
          style={[
            styles.resolvedBar,
            {
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            },
          ]}
        >
          <View style={styles.resolvedLeft}>
            <Icon
              name={approved ? "ShieldCheck" : "X"}
              size={13}
              color={approved ? theme.colors.statusSuccess : theme.colors.foregroundMuted}
            />
            <Text
              numberOfLines={2}
              style={[styles.resolvedText, { color: theme.colors.foregroundMuted }]}
            >
              {statusText}
              {apr.promotedTrust ? ` · ${t("promotedBadge")}` : ""}
            </Text>
          </View>
          {apr.executionAgentId ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => onOpenAgent(apr.executionAgentId!)}
            >
              <Text style={[styles.resolvedLink, { color: theme.colors.accent }]}>
                {t("inlineApprovalViewSession")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  const isHighRisk = apr.riskLevel === "high";
  const riskTone = isHighRisk ? theme.colors.statusDanger : theme.colors.statusWarning;
  const isEdited = draftText.trim() !== initialPreview.trim();

  return (
    <View style={inDrawer ? styles.drawerWrap : styles.streamWrap}>
      <View
        style={[
          styles.card,
          {
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          },
        ]}
      >
        <View style={styles.headerRow}>
          <View style={styles.titleGroup}>
            <Icon name="ShieldAlert" size={15} color={riskTone} />
            <Text style={[styles.titleText, { color: theme.colors.foreground }]}>
              {apr.title}
            </Text>
          </View>
          <View style={[styles.riskBadge, { backgroundColor: theme.colors.surface2 }]}>
            <Text style={[styles.riskText, { color: riskTone }]}>
              {t(RISK_LABEL_KEYS[apr.riskLevel])}
            </Text>
          </View>
        </View>

        <Text style={[styles.summaryText, { color: theme.colors.foreground }]}>
          {apr.actionSummary}
        </Text>

        <Text style={[styles.metaText, { color: theme.colors.foregroundMuted }]}>
          {apr.triggerName ? `${apr.triggerName} · ` : ""}
          {shortenPathForDisplay(apr.cwd)} · {formatSmartTime(apr.createdAt, timeLabels)}
        </Text>

        {initialPreview ? (
          <View style={styles.previewSection}>
            <View style={styles.previewHeaderRow}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setPreviewOpen((v) => !v)}
                style={styles.inlineLinkBtn}
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
                  style={styles.inlineLinkBtn}
                >
                  <Icon name="Pencil" size={11} color={theme.colors.foregroundMuted} />
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
                    styles.previewTextarea,
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
                    styles.previewBox,
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
                        color={
                          chk.checked ? theme.colors.accent : theme.colors.foregroundMuted
                        }
                      />
                      <Text
                        style={[
                          styles.checkboxLabel,
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
                    styles.previewBox,
                    {
                      borderColor: theme.colors.border,
                      backgroundColor: theme.colors.surface2,
                    },
                  ]}
                >
                  <Text
                    selectable
                    style={[styles.previewCodeText, { color: theme.colors.foreground }]}
                  >
                    {draftText}
                  </Text>
                </View>
              )
            ) : null}
          </View>
        ) : null}

        <View style={styles.optionsRow}>
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
              <Text style={{ fontSize: 12, color: theme.colors.foreground }}>
                {t("trustCheckboxLabel")}
                {storeData.triggerApprovedCount >= 1 ? (
                  <Text style={{ color: theme.colors.foregroundMuted }}>
                    {t("trustCountSuffix", { count: storeData.triggerApprovedCount })}
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
            style={styles.inlineLinkBtn}
          >
            <Icon
              name={noteOpen ? "ChevronUp" : "Plus"}
              size={11}
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
              styles.noteInput,
              {
                borderColor: theme.colors.border,
                color: theme.colors.foreground,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          />
        ) : null}

        <View style={styles.actionsRow}>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void handleDecide("approved")}
            style={[
              styles.confirmBtn,
              {
                backgroundColor: theme.colors.accent,
                opacity: busy ? 0.6 : 1,
              },
            ]}
          >
            <Icon name="Check" size={14} color={theme.colors.accentForeground} />
            <Text
              style={[styles.confirmBtnText, { color: theme.colors.accentForeground }]}
            >
              {isEdited ? t("approveEdited") : t("approve")}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void handleDecide("rejected")}
            style={[
              styles.skipBtn,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
                opacity: busy ? 0.6 : 1,
              },
            ]}
          >
            <Text style={[styles.skipBtnText, { color: theme.colors.foreground }]}>
              {t("reject")}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
});
