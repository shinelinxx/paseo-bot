import {
  useTranslation,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SCREEN_ID } from "../shared/contracts";
import { messages } from "./i18n";
import { useBotSidebarCounts } from "./store";

const styles = StyleSheet.create({
  trailingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 2,
  },
  approvalPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 999,
    borderWidth: 1,
  },
  approvalDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
  },
  approvalCountText: {
    fontSize: 10,
    fontWeight: "700",
  },
  quietDotWrap: {
    padding: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  quietDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
});

const PaseoBotSidebarItemInner = memo(function PaseoBotSidebarItemInner({
  theme,
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  const { t } = useTranslation(messages);
  const counts = useBotSidebarCounts();

  const hasApprovals = counts.pendingApprovalCount > 0;
  const hasUnread = counts.unreadCount > 0;
  const hasRunning = counts.runningWorkerCount > 0;

  const handlePress = useCallback(() => {
    openScreen({ screenId: SCREEN_ID });
  }, [openScreen]);

  const trailing = useMemo(() => {
    if (hasApprovals) {
      return (
        <View style={styles.trailingRow}>
          <Pressable
            accessibilityRole="button"
            onPress={handlePress}
            style={[
              styles.approvalPill,
              {
                borderColor: theme.colors.statusWarning,
                backgroundColor: theme.colors.surface2,
              },
            ]}
          >
            <View
              style={[
                styles.approvalDot,
                { backgroundColor: theme.colors.statusWarning },
              ]}
            />
            <Text
              style={[
                styles.approvalCountText,
                { color: theme.colors.statusWarning },
              ]}
            >
              {counts.pendingApprovalCount}
            </Text>
          </Pressable>
        </View>
      );
    }

    if (hasUnread || hasRunning) {
      const dotColor = hasUnread
        ? theme.colors.accent
        : theme.colors.foregroundMuted;
      return (
        <View style={styles.trailingRow}>
          <Pressable
            accessibilityRole="button"
            onPress={handlePress}
            style={styles.quietDotWrap}
          >
            <View style={[styles.quietDot, { backgroundColor: dotColor }]} />
          </Pressable>
        </View>
      );
    }

    return undefined;
  }, [
    counts.pendingApprovalCount,
    handlePress,
    hasApprovals,
    hasRunning,
    hasUnread,
    theme.colors.accent,
    theme.colors.foregroundMuted,
    theme.colors.statusWarning,
    theme.colors.surface2,
  ]);

  return (
    <SidebarRow
      icon="Bot"
      label={t("sidebarLabel")}
      active={currentScreen?.screenId === SCREEN_ID}
      trailing={trailing}
      onPress={handlePress}
    />
  );
});

export function PaseoBotSidebarItem(props: PluginSidebarItemProps) {
  return <PaseoBotSidebarItemInner {...props} />;
}
