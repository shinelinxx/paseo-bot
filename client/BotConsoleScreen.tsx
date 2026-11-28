import {
  useRpc,
  useSettings,
  useTranslation,
  type PluginScreenProps,
} from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type KeyboardEvent,
} from "react-native";
import {
  listModelsRpc,
  type CatalogProvider,
  type NativeScheduleItem,
  type TriggerSpec,
} from "../shared/contracts";
import { DEFAULT_BOT_SETTINGS, paseoBotSettings } from "../shared/settings";
import { ButlerAvatar } from "./ButlerAvatar";
import { ChatComposer } from "./ChatComposer";
import { ChatStream } from "./ChatStream";
import {
  CreateOrEditMissionModal,
  MemoryEditorModal,
  ModelPickerModal,
  type TranslateFn,
} from "./ConsoleModals";
import type { RelativeTimeLabels } from "./helpers";
import { messages } from "./i18n";
import { ManagementDrawer } from "./ManagementDrawer";
import {
  consumeRequestedConsoleTab,
  consumeRequestedDrawerSection,
  setSelectedConsoleProvider,
  useBotSelector,
  useFullBotSync,
  useIsChatSending,
  useSelectedConsoleProvider,
  type ManagementDrawerSection,
} from "./store";

type PluginTheme = PluginScreenProps["theme"];

interface MeasurableView {
  measureInWindow?(
    callback: (x: number, y: number, width: number, height: number) => void,
  ): void;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    position: "relative",
  },
  headerOuter: {
    flexShrink: 0,
    zIndex: 10,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerInner: {
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  circleBtn: {
    width: 38,
    height: 38,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  headerSpacer: {
    width: 38,
    height: 38,
  },
  linesBox: { width: 16, height: 12, justifyContent: "center", gap: 4 },
  topBarRow: { flexDirection: "row", alignItems: "center", gap: 2.5 },
  barShort: { width: 8, height: 2, borderRadius: 999 },
  barWide: { width: 13, height: 2, borderRadius: 999 },
  barBottom: { width: 9, height: 2, borderRadius: 999 },
  quietDot: { width: 5.5, height: 5.5, borderRadius: 999 },
  centerIdentity: { alignItems: "center", marginTop: -2 },
  namePill: {
    marginTop: -6,
    paddingHorizontal: 12,
    paddingVertical: 2.5,
    borderRadius: 999,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  namePillText: { fontSize: 12.5, fontWeight: "700" },
});

function mapParamToSection(drawer?: string, tab?: string): ManagementDrawerSection | null {
  const c = (drawer || tab || "").trim().toLowerCase();
  if (!c || c === "inbox" || c === "chat") return null;
  if (c === "rules" || c === "missions" || c === "schedules") return "rules";
  if (c === "approvals") return "approvals";
  if (c === "memory") return "memory";
  if (c === "workers") return "workers";
  if (c === "routing" || c === "status") return "routing";
  return null;
}

const TopFloatingHeader = memo(function TopFloatingHeader({
  theme,
  butlerName,
  globalPaused,
  pendingApprovalCount,
  runningWorkerCount,
  unreadCount,
  activeRuleCount,
  thinking,
  t,
  onOpenDrawer,
}: {
  theme: PluginTheme;
  butlerName: string;
  globalPaused: boolean;
  pendingApprovalCount: number;
  runningWorkerCount: number;
  unreadCount: number;
  activeRuleCount: number;
  thinking: boolean;
  t: TranslateFn;
  onOpenDrawer: () => void;
}) {
  const toast = useToast();
  const dotColor =
    pendingApprovalCount > 0
      ? theme.colors.statusWarning
      : runningWorkerCount > 0 || unreadCount > 0
        ? theme.colors.accent
        : globalPaused
          ? theme.colors.foregroundMuted
          : null;

  const handlePressCenter = useCallback(() => {
    if (globalPaused) {
      toast.show(t("headerStatusPaused"), { variant: "info" });
    } else if (pendingApprovalCount > 0) {
      toast.show(t("headerStatusPending", { count: pendingApprovalCount }), {
        variant: "warning",
      });
      onOpenDrawer();
    } else if (activeRuleCount > 0) {
      toast.show(t("headerStatusActive", { count: activeRuleCount }), { variant: "info" });
    } else {
      toast.show(t("headerStatusCalm"), { variant: "info" });
    }
  }, [activeRuleCount, globalPaused, onOpenDrawer, pendingApprovalCount, t, toast]);

  const btnSurface = {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  };

  return (
    <View
      style={[
        styles.headerOuter,
        {
          backgroundColor: theme.colors.surface0,
          borderBottomColor: theme.colors.border,
        },
      ]}
    >
      <View style={styles.headerInner}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("headerOpenDrawerA11y")}
          onPress={onOpenDrawer}
          style={[styles.circleBtn, btnSurface]}
        >
          <View style={styles.linesBox}>
            {dotColor ? (
              <View style={styles.topBarRow}>
                <View style={[styles.barShort, { backgroundColor: theme.colors.foreground }]} />
                <View style={[styles.quietDot, { backgroundColor: dotColor }]} />
              </View>
            ) : (
              <View style={[styles.barWide, { backgroundColor: theme.colors.foreground }]} />
            )}
            <View style={[styles.barBottom, { backgroundColor: theme.colors.foreground }]} />
          </View>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          onPress={handlePressCenter}
          style={styles.centerIdentity}
        >
          <ButlerAvatar theme={theme} size={42} thinking={thinking} paused={globalPaused} />
          <View style={[styles.namePill, btnSurface]}>
            <Text numberOfLines={1} style={[styles.namePillText, { color: theme.colors.foreground }]}>
              {butlerName}
            </Text>
          </View>
        </Pressable>

        <View pointerEvents="none" style={styles.headerSpacer} />
      </View>
    </View>
  );
});

export function BotConsoleScreen({ theme, layout, params, navigation }: PluginScreenProps) {
  const { t } = useTranslation(messages);
  useFullBotSync();
  const settings = useSettings(paseoBotSettings);
  const toast = useToast();
  const listModels = useRpc(listModelsRpc);
  const selectedProvider = useSelectedConsoleProvider();
  const isChatSending = useIsChatSending();

  const rootViewRef = useRef<View>(null);
  const keyboardScreenYRef = useRef<number | null>(null);
  const keyboardFallbackHeightRef = useRef<number>(0);

  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const [keyboardScrollSignal, setKeyboardScrollSignal] = useState(0);

  const recomputeKeyboardOverlap = useCallback(() => {
    const screenY = keyboardScreenYRef.current;
    if (screenY === null) {
      setKeyboardOverlap(0);
      return;
    }
    const target = rootViewRef.current as unknown as MeasurableView | null;
    if (target && typeof target.measureInWindow === "function") {
      target.measureInWindow((_x, y, _w, h) => {
        if (h > 0 && Number.isFinite(y) && keyboardScreenYRef.current !== null) {
          const overlap = Math.max(
            0,
            Math.round(y + h - keyboardScreenYRef.current),
          );
          setKeyboardOverlap(overlap);
        } else {
          setKeyboardOverlap(Math.max(0, Math.round(keyboardFallbackHeightRef.current)));
        }
      });
    } else {
      setKeyboardOverlap(Math.max(0, Math.round(keyboardFallbackHeightRef.current)));
    }
  }, []);

  // Pixel-accurate iOS/Android keyboard avoidance (zero overlap when host doesn't resize;
  // zero double-padding when host does resize).
  useEffect(() => {
    if (Platform.OS === "web") return;
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const onShow = (event: KeyboardEvent) => {
      keyboardScreenYRef.current = event.endCoordinates?.screenY ?? null;
      keyboardFallbackHeightRef.current = event.endCoordinates?.height ?? 0;
      recomputeKeyboardOverlap();
      setKeyboardScrollSignal((n) => n + 1);
    };

    const onHide = () => {
      keyboardScreenYRef.current = null;
      keyboardFallbackHeightRef.current = 0;
      setKeyboardOverlap(0);
    };

    const subShow = Keyboard.addListener(showEvent, onShow);
    const subHide = Keyboard.addListener(hideEvent, onHide);
    const subFrame =
      Platform.OS === "ios"
        ? Keyboard.addListener("keyboardWillChangeFrame", onShow)
        : null;

    return () => {
      subShow.remove();
      subHide.remove();
      subFrame?.remove();
    };
  }, [recomputeKeyboardOverlap]);

  const timeLabels = useMemo<RelativeTimeLabels>(
    () => ({
      justNow: t("timeJustNow"),
      minsAgo: (count: number) => t("timeMinsAgo", { count }),
      todayAt: (time: string) => t("timeTodayAt", { time }),
      yesterdayAt: (time: string) => t("timeYesterdayAt", { time }),
    }),
    [t],
  );

  const slice = useBotSelector((s) => {
    let activeRuleCount = 0;
    for (const trg of s.triggers) if (trg.enabled) activeRuleCount += 1;
    for (const ns of s.nativeSchedules ?? []) if (ns.status === "active") activeRuleCount += 1;
    const msgs = s.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];
    return {
      butlerName: s.butlerName ?? "Paseo Bot",
      globalPaused: s.globalPaused,
      pendingApprovalCount: s.pendingApprovalCount,
      runningWorkerCount: s.runningWorkerCount,
      unreadCount: s.unreadCount,
      activeRuleCount,
      lastIsThinking: Boolean(
        lastMsg &&
          lastMsg.role === "assistant" &&
          lastMsg.status === "thinking",
      ),
      triggers: s.triggers,
      nativeSchedules: s.nativeSchedules ?? [],
      memoryContent: s.memoryContent,
      knownWorkspaces: s.knownWorkspaces ?? [],
    };
  });

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMounted, setDrawerMounted] = useState(false);
  const [drawerSection, setDrawerSection] = useState<ManagementDrawerSection>("rules");
  const [missionModal, setMissionModal] = useState<{
    open: boolean;
    editingTrigger: TriggerSpec | null;
    editingSchedule: NativeScheduleItem | null;
  }>({ open: false, editingTrigger: null, editingSchedule: null });
  const [memoryModalOpen, setMemoryModalOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<{
    defaultProvider: string;
    providers: CatalogProvider[];
  }>({ defaultProvider: DEFAULT_BOT_SETTINGS.execProvider, providers: [] });
  const [loadingModels, setLoadingModels] = useState(false);
  const requestedModelsOnceRef = useRef(false);

  const fetchModelCatalog = useCallback(
    async (refresh = false) => {
      requestedModelsOnceRef.current = true;
      setLoadingModels(true);
      try {
        setModelCatalog(await listModels({ refresh }));
      } catch {
        // Keep configured defaults
      } finally {
        setLoadingModels(false);
      }
    },
    [listModels],
  );

  // Lazy-mount ManagementDrawer only when opened, and unmount after its slide-out transition
  useEffect(() => {
    if (drawerOpen) {
      setDrawerMounted(true);
      return;
    }
    if (!drawerMounted) return;
    const timer = setTimeout(() => {
      setDrawerMounted(false);
    }, 220);
    return () => clearTimeout(timer);
  }, [drawerMounted, drawerOpen]);

  // Lazy-load model catalog only when user opens Routing drawer section or ModelPickerModal
  useEffect(() => {
    if (
      drawerOpen &&
      drawerSection === "routing" &&
      !requestedModelsOnceRef.current &&
      modelCatalog.providers.length === 0
    ) {
      void fetchModelCatalog(false);
    }
  }, [drawerOpen, drawerSection, fetchModelCatalog, modelCatalog.providers.length]);

  useEffect(() => {
    const reqSection = consumeRequestedDrawerSection();
    const reqTab = consumeRequestedConsoleTab();
    const resolved = reqSection ?? mapParamToSection(params.drawer, reqTab ?? params.tab);
    if (resolved) {
      setDrawerSection(resolved);
      setDrawerMounted(true);
      setDrawerOpen(true);
    }
  }, [params.drawer, params.tab]);

  const openAgentSession = useCallback(
    (agentId: string) => {
      if (navigation?.openAgent) {
        navigation.openAgent(
          navigation.supportsFocusHost ? { agentId, focusHost: true } : { agentId },
        );
      } else {
        toast.show(`Agent ID: ${agentId}`);
      }
    },
    [navigation, toast],
  );

  const handleOpenModelPicker = useCallback(() => {
    setModelPickerOpen(true);
    if (modelCatalog.providers.length === 0) void fetchModelCatalog(false);
  }, [fetchModelCatalog, modelCatalog.providers.length]);

  const butlerName =
    slice.butlerName ||
    (settings.status === "ready" ? settings.values.butlerName : DEFAULT_BOT_SETTINGS.butlerName);
  const anyOverlayOpen =
    drawerOpen || missionModal.open || memoryModalOpen || modelPickerOpen;

  return (
    <View
      ref={rootViewRef}
      onLayout={() => {
        if (keyboardScreenYRef.current !== null) {
          recomputeKeyboardOverlap();
        }
      }}
      style={[
        styles.root,
        {
          backgroundColor: theme.colors.surface0,
          paddingBottom: keyboardOverlap,
        },
      ]}
    >
      <TopFloatingHeader
        theme={theme}
        butlerName={butlerName}
        globalPaused={slice.globalPaused}
        pendingApprovalCount={slice.pendingApprovalCount}
        runningWorkerCount={slice.runningWorkerCount}
        unreadCount={slice.unreadCount}
        activeRuleCount={slice.activeRuleCount}
        thinking={isChatSending || slice.lastIsThinking}
        t={t}
        onOpenDrawer={() => {
          if (slice.pendingApprovalCount > 0) setDrawerSection("approvals");
          setDrawerMounted(true);
          setDrawerOpen(true);
        }}
      />

      <ChatStream
        theme={theme}
        compact={layout.compact}
        keyboardScrollSignal={keyboardScrollSignal}
        timeLabels={timeLabels}
        t={t}
        onOpenAgent={openAgentSession}
      />

      <ChatComposer
        theme={theme}
        butlerName={butlerName}
        modelProviders={modelCatalog.providers}
        captureGlobalPaste={!anyOverlayOpen}
        t={t}
        onOpenModelPicker={handleOpenModelPicker}
      />

      {drawerMounted ? (
        <ManagementDrawer
          open={drawerOpen}
          activeSection={drawerSection}
          onSelectSection={setDrawerSection}
          onClose={() => setDrawerOpen(false)}
          theme={theme}
          compact={layout.compact}
          modelProviders={modelCatalog.providers}
          timeLabels={timeLabels}
          t={t}
          onOpenNewMission={() =>
            setMissionModal({ open: true, editingTrigger: null, editingSchedule: null })
          }
          onOpenEditMission={(trg) =>
            setMissionModal({ open: true, editingTrigger: trg, editingSchedule: null })
          }
          onOpenEditSchedule={(sched) =>
            setMissionModal({ open: true, editingTrigger: null, editingSchedule: sched })
          }
          onOpenMemoryModal={() => setMemoryModalOpen(true)}
          onOpenModelPicker={handleOpenModelPicker}
          onOpenAgent={openAgentSession}
        />
      ) : null}

      {missionModal.open ? (
        <CreateOrEditMissionModal
          editingTrigger={missionModal.editingTrigger}
          editingSchedule={missionModal.editingSchedule}
          existingTriggers={slice.triggers}
          existingNativeSchedules={slice.nativeSchedules}
          knownWorkspaces={slice.knownWorkspaces}
          theme={theme}
          t={t}
          onClose={() =>
            setMissionModal({ open: false, editingTrigger: null, editingSchedule: null })
          }
        />
      ) : null}

      {memoryModalOpen ? (
        <MemoryEditorModal
          initialContent={slice.memoryContent}
          theme={theme}
          t={t}
          onClose={() => setMemoryModalOpen(false)}
        />
      ) : null}

      {modelPickerOpen ? (
        <ModelPickerModal
          selectedProvider={selectedProvider}
          defaultProvider={
            settings.status === "ready"
              ? settings.values.execProvider
              : modelCatalog.defaultProvider
          }
          tierDefaults={
            settings.status === "ready"
              ? [
                  settings.values.fastProvider,
                  settings.values.execProvider,
                  settings.values.deepProvider,
                ]
              : undefined
          }
          providers={modelCatalog.providers}
          loading={loadingModels}
          theme={theme}
          t={t}
          onSelect={setSelectedConsoleProvider}
          onRefresh={() => void fetchModelCatalog(true)}
          onClose={() => setModelPickerOpen(false)}
        />
      ) : null}
    </View>
  );
}
