import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  curateFeedRpc,
  deleteTriggerRpc,
  dismissSuggestionRpc,
  draftMissionRpc,
  ensureChiefBotRpc,
  executeFeedActionRpc,
  getBotSnapshotRpc,
  installPresetRpc,
  listModelsRpc,
  manageNativeScheduleRpc,
  manageWorkerRpc,
  markFeedReadRpc,
  resolveApprovalRpc,
  runTriggerNowRpc,
  saveMemoryRpc,
  setGlobalPauseRpc,
  submitWishRpc,
  tidySessionsRpc,
  toggleTriggerRpc,
  upsertNativeScheduleRpc,
  upsertTriggerRpc,
  watchBotStateSubscription,
  watchBotSummarySubscription,
} from "./shared/contracts";
import { paseoBotSettings } from "./shared/settings";
import { ProactiveEngine } from "./server/engine";
import { registerBotAgentTools } from "./server/tools";

export default function contribute(server: PluginServerContext) {
  const settingsHandle = server.registerSettings(paseoBotSettings);
  const engine = new ProactiveEngine();
  const ready = engine.start(server, settingsHandle);
  const removeToolsHook = registerBotAgentTools(server, engine);

  server.handle(getBotSnapshotRpc, async (_input, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.getSnapshot();
  });

  server.handle(watchBotSummarySubscription, (_input, { paseo, push, signal }) => {
    if (signal.aborted) return;
    engine.attachPaseo(paseo);
    void ready
      .then(async () => {
        if (signal.aborted) return;
        await push(await engine.getSummary());
      })
      .catch(() => undefined);

    const unsub = engine.subscribeSummary((summary) => {
      if (signal.aborted) return;
      void push(summary).catch(() => undefined);
    });
    signal.addEventListener("abort", () => unsub(), { once: true });
  });

  server.handle(watchBotStateSubscription, (_input, { paseo, push, signal }) => {
    if (signal.aborted) return;
    engine.attachPaseo(paseo);
    void ready
      .then(async () => {
        if (signal.aborted) return;
        await push(await engine.getSnapshot());
      })
      .catch(() => undefined);

    const unsub = engine.subscribeSnapshots((snapshot) => {
      if (signal.aborted) return;
      void push(snapshot).catch(() => undefined);
    });
    signal.addEventListener("abort", () => unsub(), { once: true });
  });

  server.handle(listModelsRpc, async ({ refresh }, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.listAvailableModels(Boolean(refresh));
  });

  server.handle(ensureChiefBotRpc, async ({ reset, provider }, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.ensureChiefBot({ reset, provider });
  });

  server.handle(submitWishRpc, async (input, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.submitWish(input);
  });

  server.handle(draftMissionRpc, async ({ intent, cwd }, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return { draft: await engine.draftMission(intent, cwd) };
  });

  server.handle(upsertTriggerRpc, async (input, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.upsertTrigger(input);
  });

  server.handle(toggleTriggerRpc, async ({ id, enabled }, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    const ok = await engine.toggleTrigger(id, enabled);
    return { ok };
  });

  server.handle(deleteTriggerRpc, async ({ id, clearFinishedReminders }, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    if (clearFinishedReminders) {
      const removedCount = await engine.clearFinishedReminders();
      return { ok: true, removedCount };
    }
    if (!id) return { ok: false, removedCount: 0 };
    const ok = await engine.deleteTrigger(id);
    return { ok, removedCount: ok ? 1 : 0 };
  });

  server.handle(runTriggerNowRpc, async ({ id }, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.dispatchTrigger(id, {
      reason: "manual_ui_run",
      detail: "Triggered manually from Paseo Bot console.",
      manual: true,
    });
  });

  server.handle(installPresetRpc, async ({ presetId }, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.installPreset(presetId);
  });

  server.handle(resolveApprovalRpc, async (input, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.resolveApproval(input);
  });

  server.handle(curateFeedRpc, async (input, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.curateFeed(input);
  });

  server.handle(executeFeedActionRpc, async (input, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.executeFeedAction(input);
  });

  server.handle(dismissSuggestionRpc, async ({ suggestionId }, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.dismissSuggestion(suggestionId);
  });

  server.handle(manageWorkerRpc, async (input, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.manageWorker(input);
  });

  server.handle(upsertNativeScheduleRpc, async (input, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.upsertNativeSchedule(input);
  });

  server.handle(manageNativeScheduleRpc, async (input, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.manageNativeSchedule(input);
  });

  server.handle(
    markFeedReadRpc,
    async ({ id, clearSilent, dismissId, clearRead }, { paseo }) => {
      engine.attachPaseo(paseo);
      await ready;
      let removedCount = 0;
      await engine.store.mutate((draft) => {
        if (dismissId) {
          const before = draft.feed.length;
          draft.feed = draft.feed.filter((f) => f.id !== dismissId);
          removedCount += before - draft.feed.length;
          return;
        }
        if (clearSilent) {
          const before = draft.feed.length;
          draft.feed = draft.feed.filter((f) => f.level !== "silent");
          removedCount += before - draft.feed.length;
        }
        if (clearRead) {
          const before = draft.feed.length;
          draft.feed = draft.feed.filter(
            (f) => f.unread || f.inProgress || f.level === "approval_required",
          );
          removedCount += before - draft.feed.length;
          return;
        }
        for (const f of draft.feed) {
          if (!id || f.id === id) {
            f.unread = false;
          }
        }
      });
      await engine.broadcastSnapshot();
      return { ok: true, removedCount };
    },
  );

  server.handle(saveMemoryRpc, async ({ content }, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    const path = engine.getSettings().memoryFilePath;
    await engine.store.writeMemory(path, content);
    await engine.broadcastSnapshot();
    return { ok: true, path };
  });

  server.handle(setGlobalPauseRpc, async ({ paused }, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    const next = await engine.setGlobalPaused(paused);
    return { paused: next };
  });

  server.handle(tidySessionsRpc, async (input, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.tidySessions(input);
  });

  return async () => {
    removeToolsHook();
    await engine.stop();
  };
}
