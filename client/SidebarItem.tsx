import {
  useTranslation,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SCREEN_ID } from "../shared/contracts";
import { messages } from "./i18n";
import { setRequestedConsoleTab, useBotSidebarCounts } from "./store";

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    minWidth: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700",
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

  const trailing = useMemo(() => {
    let badgeBg: string | null = null;
    let badgeFg: string = theme.colors.foreground;
    let badgeText = "";

    if (hasApprovals) {
      badgeBg = theme.colors.statusWarning;
      badgeFg = theme.colors.surface0;
      badgeText = `${counts.pendingApprovalCount}`;
    } else if (hasUnread) {
      badgeBg = theme.colors.accent;
      badgeFg = theme.colors.accentForeground;
      badgeText = `${counts.unreadCount}`;
    } else if (hasRunning) {
      badgeBg = theme.colors.surface2;
      badgeFg = theme.colors.foregroundMuted;
      badgeText = `${counts.runningWorkerCount}`;
    }

    if (!badgeText) return undefined;
    return (
      <View
        style={[
          styles.badge,
          { backgroundColor: badgeBg ?? theme.colors.surface2 },
        ]}
      >
        <Text style={[styles.badgeText, { color: badgeFg }]}>{badgeText}</Text>
      </View>
    );
  }, [
    hasApprovals,
    hasUnread,
    hasRunning,
    counts.pendingApprovalCount,
    counts.unreadCount,
    counts.runningWorkerCount,
    theme.colors.foreground,
    theme.colors.statusWarning,
    theme.colors.surface0,
    theme.colors.accent,
    theme.colors.accentForeground,
    theme.colors.surface2,
    theme.colors.foregroundMuted,
  ]);

  const handlePress = useCallback(() => {
    if (hasApprovals) {
      setRequestedConsoleTab("approvals");
    }
    openScreen({ screenId: SCREEN_ID });
  }, [hasApprovals, openScreen]);

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
