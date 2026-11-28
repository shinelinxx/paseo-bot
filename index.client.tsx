import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BotConsoleScreen } from "./client/BotConsoleScreen";
import { messages } from "./client/i18n";
import { BotSettingsScreen } from "./client/SettingsScreen";
import { PaseoBotSidebarItem } from "./client/SidebarItem";
import {
  clearBotStore,
  getLiveBotSnapshot,
  optimisticSetGlobalPaused,
  registerBotFullSync,
  setLiveBotSnapshot,
  setLiveBotSummary,
  setRequestedConsoleTab,
  setRequestedDrawerSection,
  type ManagementDrawerSection,
} from "./client/store";
import {
  BotAlertTimelineCard,
  BotApprovalTimelineCard,
} from "./client/TimelineCards";
import {
  BOT_ALERT_TIMELINE_KIND,
  BOT_APPROVAL_TIMELINE_KIND,
  botAlertTimelineSchema,
  botApprovalTimelineSchema,
  getBotSnapshotRpc,
  SCREEN_ID,
  SETTINGS_SCREEN_ID,
  SIDEBAR_ITEM_ID,
  setGlobalPauseRpc,
  submitWishRpc,
  tidySessionsRpc,
  watchBotStateSubscription,
  watchBotSummarySubscription,
} from "./shared/contracts";

function resolveDrawerArg(rawArg: string): ManagementDrawerSection | "chat" | null {
  const clean = rawArg.trim().toLowerCase();
  if (!clean || clean === "inbox" || clean === "chat") return "chat";
  if (
    clean === "missions" ||
    clean === "rules" ||
    clean === "schedules" ||
    clean === "schedule" ||
    clean === "plans" ||
    clean === "plan"
  ) {
    return "rules";
  }
  if (clean === "approvals" || clean === "approval" || clean === "confirm") {
    return "approvals";
  }
  if (clean === "memory" || clean === "mem") {
    return "memory";
  }
  if (clean === "workers" || clean === "tasks" || clean === "subtasks") {
    return "workers";
  }
  if (clean === "routing" || clean === "status" || clean === "models") {
    return "routing";
  }
  return null;
}

export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController();
  let summaryStartupTimer: ReturnType<typeof setTimeout> | null = null;

  // Lazy full-state sync: only active while BotConsoleScreen is mounted
  registerBotFullSync(() => {
    const ctrl = new AbortController();
    const onLifetimeAbort = () => ctrl.abort();
    lifetime.signal.addEventListener("abort", onLifetimeAbort, { once: true });
    const sub = client.subscribe(
      watchBotStateSubscription,
      {},
      (snapshot) => {
        if (!ctrl.signal.aborted && !lifetime.signal.aborted) {
          setLiveBotSnapshot(snapshot);
        }
      },
      { signal: ctrl.signal },
    );
    void sub.ready.catch(() => {
      if (ctrl.signal.aborted || lifetime.signal.aborted) return;
      void client
        .rpc(getBotSnapshotRpc, {})
        .then((snap) => {
          if (!ctrl.signal.aborted && !lifetime.signal.aborted) {
            setLiveBotSnapshot(snap);
          }
        })
        .catch(() => undefined);
    });
    return () => {
      lifetime.signal.removeEventListener("abort", onLifetimeAbort);
      ctrl.abort();
      sub();
    };
  });

  // Yield first paint, then subscribe to lightweight sidebar badge counts only (~100B vs ~37KB)
  summaryStartupTimer = setTimeout(() => {
    summaryStartupTimer = null;
    if (lifetime.signal.aborted) return;
    const summarySub = client.subscribe(
      watchBotSummarySubscription,
      {},
      (summary) => {
        if (!lifetime.signal.aborted) {
          setLiveBotSummary(summary);
        }
      },
      { signal: lifetime.signal },
    );
    void summarySub.ready.catch(() => undefined);
  }, 1000);

  const cleanups = [
    client.addScreen({
      id: SCREEN_ID,
      title: messages.message("pluginTitle"),
      Component: BotConsoleScreen,
    }),

    client.addSidebarHeaderItem({
      id: SIDEBAR_ITEM_ID,
      title: messages.message("sidebarLabel"),
      Component: PaseoBotSidebarItem,
    }),

    client.addSettingsScreen({
      id: SETTINGS_SCREEN_ID,
      title: messages.message("settingsTitle"),
      icon: "Bot",
      Component: BotSettingsScreen,
    }),

    client.addTimelineRenderer({
      kind: BOT_ALERT_TIMELINE_KIND,
      version: 1,
      schema: botAlertTimelineSchema,
      Component: BotAlertTimelineCard,
    }),

    client.addTimelineRenderer({
      kind: BOT_APPROVAL_TIMELINE_KIND,
      version: 1,
      schema: botApprovalTimelineSchema,
      Component: BotApprovalTimelineCard,
    }),

    client.addSlashCommand({
      name: "wish",
      context: "workspace",
      description: messages.message("slashWishDesc"),
      argumentHint: messages.message("slashWishHint"),
      async onSubmit({ args, workspace, rpc, openScreen, composers }) {
        const wish = args.trim();
        if (!wish) {
          openScreen({ screenId: SCREEN_ID });
          return;
        }
        const res = await rpc(submitWishRpc, {
          wish,
          cwd: workspace.directory,
        });
        const chiefComposers = res.agentId ? composers({ agentId: res.agentId }) : [];
        if (chiefComposers[0]) {
          await chiefComposers[0].focus().catch(() => {
            openScreen({ screenId: SCREEN_ID });
          });
        } else {
          openScreen({ screenId: SCREEN_ID });
        }
      },
    }),

    client.addSlashCommand({
      name: "bot",
      context: "workspace",
      description: messages.message("slashBotDesc"),
      argumentHint: messages.message("slashBotHint"),
      onSubmit({ args, openScreen }) {
        const target = resolveDrawerArg(args);
        if (target && target !== "chat") {
          setRequestedDrawerSection(target);
          openScreen({ screenId: SCREEN_ID, params: { drawer: target } });
          return;
        }
        setRequestedConsoleTab("inbox");
        openScreen({ screenId: SCREEN_ID });
      },
    }),

    client.addSlashCommand({
      name: "tidy",
      context: "workspace",
      description: messages.message("slashTidyDesc"),
      argumentHint: messages.message("slashTidyHint"),
      async onSubmit({ args, rpc, openScreen }) {
        const arg = args.trim().toLowerCase();
        const mode = arg === "apply" || arg === "now" ? "apply" : "preview";
        await rpc(tidySessionsRpc, { mode });
        setRequestedDrawerSection(null);
        openScreen({ screenId: SCREEN_ID });
      },
    }),

    client.addCommandCenterItem({
      id: "paseo-bot-tidy",
      title: messages.message("cmdTidySessions"),
      icon: "Layers",
      keywords: ["tidy", "rename", "merge", "archive", "整理", "重命名", "合并", "归档", "会话"],
      context: "global",
      async onSelect({ rpc, openScreen }) {
        await rpc(tidySessionsRpc, { mode: "preview" });
        setRequestedDrawerSection(null);
        openScreen({ screenId: SCREEN_ID });
      },
    }),

    client.addCommandCenterItem({
      id: "paseo-bot-open",
      title: messages.message("cmdOpenConsole"),
      icon: "Bot",
      keywords: ["bot", "butler", "wish", "chat", "管家", "自动规则", "后台", "定时"],
      context: "global",
      onSelect({ openScreen }) {
        setRequestedDrawerSection(null);
        openScreen({ screenId: SCREEN_ID });
      },
    }),

    client.addCommandCenterItem({
      id: "paseo-bot-schedules",
      title: messages.message("cmdOpenSchedules"),
      icon: "CalendarClock",
      keywords: ["schedule", "schedules", "plan", "cron", "trigger", "rule", "计划", "定时", "自动规则"],
      context: "global",
      onSelect({ openScreen }) {
        setRequestedDrawerSection("rules");
        openScreen({ screenId: SCREEN_ID, params: { drawer: "rules" } });
      },
    }),

    client.addCommandCenterItem({
      id: "paseo-bot-chat",
      title: messages.message("cmdOpenChat"),
      icon: "Sparkles",
      keywords: ["bot", "chat", "butler", "对话", "助手", "管家"],
      context: "global",
      onSelect({ openScreen }) {
        setRequestedDrawerSection(null);
        openScreen({ screenId: SCREEN_ID });
      },
    }),

    client.addCommandCenterItem({
      id: "paseo-bot-toggle-pause",
      title: messages.message("cmdTogglePause"),
      icon: "Pause",
      keywords: ["pause", "resume", "trigger", "暂停", "触发"],
      context: "global",
      async onSelect({ rpc }) {
        const next = !getLiveBotSnapshot().globalPaused;
        optimisticSetGlobalPaused(next);
        await rpc(setGlobalPauseRpc, { paused: next });
      },
    }),
  ];

  return () => {
    lifetime.abort();
    if (summaryStartupTimer) {
      clearTimeout(summaryStartupTimer);
      summaryStartupTimer = null;
    }
    for (const remove of cleanups) {
      remove();
    }
    clearBotStore();
  };
}
