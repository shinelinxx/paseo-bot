import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BotConsoleScreen } from "./client/BotConsoleScreen";
import { messages } from "./client/i18n";
import { BotSettingsScreen } from "./client/SettingsScreen";
import { PaseoBotSidebarItem } from "./client/SidebarItem";
import {
  clearBotStore,
  getLiveBotSnapshot,
  setLiveBotSnapshot,
  setRequestedConsoleTab,
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
  ensureChiefBotRpc,
  getBotSnapshotRpc,
  SCREEN_ID,
  SETTINGS_SCREEN_ID,
  SIDEBAR_ITEM_ID,
  setGlobalPauseRpc,
  submitWishRpc,
  watchBotStateSubscription,
} from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController();

  const sub = client.subscribe(
    watchBotStateSubscription,
    {},
    (snapshot) => {
      setLiveBotSnapshot(snapshot);
    },
    { signal: lifetime.signal },
  );
  void sub.ready.catch(() => {
    void client
      .rpc(getBotSnapshotRpc, {})
      .then((snap) => setLiveBotSnapshot(snap))
      .catch(() => undefined);
  });

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
        const chiefComposers = composers({ agentId: res.agentId });
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
        const tabArg = args.trim().toLowerCase();
        if (
          tabArg === "inbox" ||
          tabArg === "approvals" ||
          tabArg === "missions" ||
          tabArg === "workers"
        ) {
          setRequestedConsoleTab(tabArg);
          openScreen({ screenId: SCREEN_ID, params: { tab: tabArg } });
          return;
        }
        openScreen({ screenId: SCREEN_ID });
      },
    }),

    client.addCommandCenterItem({
      id: "paseo-bot-open",
      title: messages.message("cmdOpenConsole"),
      icon: "Bot",
      keywords: ["bot", "wish", "trigger", "rule", "自动规则", "后台", "定时"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: SCREEN_ID });
      },
    }),

    client.addCommandCenterItem({
      id: "paseo-bot-chat",
      title: messages.message("cmdOpenChat"),
      icon: "Sparkles",
      keywords: ["bot", "chat", "对话", "助手"],
      context: "global",
      async onSelect({ rpc, composers, openScreen }) {
        const res = await rpc(ensureChiefBotRpc, {});
        const target = composers({ agentId: res.agentId })[0];
        if (target) {
          await target.focus().catch(() => openScreen({ screenId: SCREEN_ID }));
        } else {
          openScreen({ screenId: SCREEN_ID });
        }
      },
    }),

    client.addCommandCenterItem({
      id: "paseo-bot-toggle-pause",
      title: messages.message("cmdTogglePause"),
      icon: "Pause",
      keywords: ["pause", "resume", "trigger", "暂停", "触发"],
      context: "global",
      async onSelect({ rpc }) {
        const current = getLiveBotSnapshot();
        await rpc(setGlobalPauseRpc, { paused: !current.globalPaused });
      },
    }),
  ];

  return () => {
    lifetime.abort();
    for (const remove of cleanups) {
      remove();
    }
    clearBotStore();
  };
}
