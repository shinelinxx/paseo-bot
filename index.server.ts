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
  markFeedReadRpc,
  resolveApprovalRpc,
  runTriggerNowRpc,
  saveMemoryRpc,
  setGlobalPauseRpc,
  submitWishRpc,
  toggleTriggerRpc,
  upsertTriggerRpc,
  watchBotStateSubscription,
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

  server.handle(ensureChiefBotRpc, async ({ reset }, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.ensureChiefBot({ reset });
  });

  server.handle(submitWishRpc, async (input, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return engine.submitWish(input);
  });

  server.handle(draftMissionRpc, async ({ intent, cwd }, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    return { draft: engine.draftMission(intent, cwd) };
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

  server.handle(deleteTriggerRpc, async ({ id }, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    const ok = await engine.deleteTrigger(id);
    return { ok };
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

  server.handle(markFeedReadRpc, async ({ id, clearSilent }, { paseo }) => {
    engine.attachPaseo(paseo);
    await ready;
    await engine.store.mutate((draft) => {
      if (clearSilent) {
        draft.feed = draft.feed.filter((f) => f.level !== "silent");
      }
      for (const f of draft.feed) {
        if (!id || f.id === id) {
          f.unread = false;
        }
      }
    });
    await engine.broadcastSnapshot();
    return { ok: true };
  });

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

  return async () => {
    removeToolsHook();
    await engine.stop();
  };
}
