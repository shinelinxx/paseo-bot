import {
  useRpc,
  useSettings,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import {
  Loading,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  listModelsRpc,
  updateButlerProfileRpc,
  type CatalogProvider,
} from "../shared/contracts";
import { paseoBotSettings, type BotSettings } from "../shared/settings";
import { optimisticUpdateButlerProfile } from "./store";

const WISH_MODE_OPTIONS = [
  { label: "每次重任务单开会话（推荐）", value: "per_wish" as const },
  { label: "所有任务共用同一个主对话", value: "shared_chief" as const },
];

const styles = StyleSheet.create({
  errorWrap: { padding: 16, gap: 12 },
  container: { gap: 20 },
});

function buildModelSelectOptions(
  providers: readonly CatalogProvider[],
  currentVal: string,
): Array<{ label: string; value: string }> {
  const options: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();
  for (const prov of providers) {
    for (const m of prov.models) {
      const pair = `${prov.id}/${m.id}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      options.push({
        label: `${prov.label} · ${m.label}`,
        value: pair,
      });
    }
  }
  if (currentVal && !seen.has(currentVal)) {
    options.unshift({
      label: currentVal,
      value: currentVal,
    });
  }
  return options;
}

export function BotSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(paseoBotSettings);
  const listModels = useRpc(listModelsRpc);
  const updateButlerProfile = useRpc(updateButlerProfileRpc);
  const toast = useToast();
  const [draft, setDraft] = useState<BotSettings | null>(null);
  const [catalogProviders, setCatalogProviders] = useState<CatalogProvider[]>([]);
  const lastRevisionRef = useRef<string | null>(null);

  const readyValues = settings.status === "ready" ? settings.values : null;
  const readyRevision = settings.status === "ready" ? settings.revision : null;

  useEffect(() => {
    if (readyValues && readyRevision && readyRevision !== lastRevisionRef.current) {
      lastRevisionRef.current = readyRevision;
      setDraft(readyValues);
    }
  }, [readyRevision, readyValues]);

  useEffect(() => {
    void listModels({ refresh: false })
      .then((res) => setCatalogProviders(res.providers))
      .catch(() => undefined);
  }, [listModels]);

  const patchImmediate = useCallback(
    async (patch: Partial<BotSettings>) => {
      if (settings.status !== "ready") return;
      const base = draft ?? settings.values;
      const next = { ...base, ...patch };
      setDraft(next);
      const ok = await settings.save(next, settings.revision);
      if (!ok && settings.saveError) {
        toast.error(settings.saveError);
      }
    },
    [draft, settings, toast],
  );

  const saveDraftFields = useCallback(async () => {
    if (settings.status !== "ready" || !draft) return;
    const normalized: BotSettings = {
      ...draft,
      butlerName: draft.butlerName.trim() || "Paseo Bot",
      userName: draft.userName.trim(),
    };
    setDraft(normalized);
    const ok = await settings.save(normalized, settings.revision);
    if (ok) {
      optimisticUpdateButlerProfile({
        butlerName: normalized.butlerName,
        userName: normalized.userName,
      });
      await updateButlerProfile({
        butlerName: normalized.butlerName,
        userName: normalized.userName,
      }).catch(() => undefined);
      toast.show("设置已保存", { variant: "success" });
    } else if (settings.saveError) {
      toast.error(settings.saveError);
    }
  }, [draft, settings, toast, updateButlerProfile]);

  const current = draft ?? (settings.status === "ready" ? settings.values : null);

  const fastOptions = useMemo(
    () =>
      current ? buildModelSelectOptions(catalogProviders, current.fastProvider) : [],
    [catalogProviders, current?.fastProvider],
  );
  const fastFallbackOptions = useMemo(
    () =>
      current
        ? buildModelSelectOptions(catalogProviders, current.fastFallbackProvider)
        : [],
    [catalogProviders, current?.fastFallbackProvider],
  );
  const execOptions = useMemo(
    () =>
      current ? buildModelSelectOptions(catalogProviders, current.execProvider) : [],
    [catalogProviders, current?.execProvider],
  );
  const deepOptions = useMemo(
    () =>
      current ? buildModelSelectOptions(catalogProviders, current.deepProvider) : [],
    [catalogProviders, current?.deepProvider],
  );
  const chiefOptions = useMemo(
    () =>
      current ? buildModelSelectOptions(catalogProviders, current.chiefProvider) : [],
    [catalogProviders, current?.chiefProvider],
  );
  const scoutOptions = useMemo(
    () =>
      current ? buildModelSelectOptions(catalogProviders, current.scoutProvider) : [],
    [catalogProviders, current?.scoutProvider],
  );
  const workerOptions = useMemo(
    () =>
      current
        ? buildModelSelectOptions(catalogProviders, current.defaultWorkerProvider)
        : [],
    [catalogProviders, current?.defaultWorkerProvider],
  );

  if (settings.status === "loading") {
    return <Loading />;
  }

  if (settings.status === "error" || settings.status === "invalid" || !current) {
    return (
      <View style={styles.errorWrap}>
        <Text style={{ color: theme.colors.statusDanger }}>
          Failed to load Paseo Bot settings:{" "}
          {settings.status === "error" || settings.status === "invalid"
            ? settings.error
            : ""}
        </Text>
        <SettingsCard>
          <SettingsAction
            label="Reset settings to defaults"
            actionLabel="Reset"
            onPress={() => void settings.reset()}
          />
        </SettingsCard>
      </View>
    );
  }

  const hasCatalog = catalogProviders.length > 0;

  return (
    <View style={styles.container}>
      <SettingsSection title="个人管家与称呼">
        <SettingsCard>
          <SettingsInput
            label="管家称呼"
            hint="显示在单流对话顶栏与输入框占位符，也可在对话中直接说「以后叫你小点」即时更改。"
            placeholder="Paseo Bot"
            initialValue={current.butlerName}
            onChangeText={(txt) =>
              setDraft((prev) => ({
                ...(prev ?? settings.values),
                butlerName: txt,
              }))
            }
          />
          <SettingsInput
            label="你的称呼（选填）"
            hint="管家在主动提醒与问候中如何自然称呼你（例如：辉）。"
            placeholder="例如：辉"
            initialValue={current.userName}
            onChangeText={(txt) =>
              setDraft((prev) => ({
                ...(prev ?? settings.values),
                userName: txt,
              }))
            }
          />
          <SettingsAction
            label="保存管家与用户称呼"
            actionLabel={settings.saving ? "保存中…" : "保存称呼"}
            disabled={settings.saving}
            onPress={() => void saveDraftFields()}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="L1–L3 分层模型分流">
        <SettingsCard>
          {hasCatalog ? (
            <>
              <SettingsSelect
                label="L1 极速秒回模型"
                hint="用于日常寒暄、轻量问答、一句话改记忆与停提醒，追求毫秒级响应。"
                value={current.fastProvider}
                options={fastOptions}
                onValueChange={(v) => void patchImmediate({ fastProvider: v })}
              />
              <SettingsSelect
                label="L1 极速备选模型"
                hint="当 L1 主选模型限流或不可用时自动无缝切换。"
                value={current.fastFallbackProvider}
                options={fastFallbackOptions}
                onValueChange={(v) => void patchImmediate({ fastFallbackProvider: v })}
              />
              <SettingsSelect
                label="L2 主力查证模型"
                hint="用于调用工具/MCP 核查（邮箱、Cloudflare、工作区状态）与跨目录派活。"
                value={current.execProvider}
                options={execOptions}
                onValueChange={(v) => void patchImmediate({ execProvider: v })}
              />
              <SettingsSelect
                label="L3 深度思考模型"
                hint="仅在开启「深度思考 · L3」或复杂规划、架构决策与长文深析时按需调用。"
                value={current.deepProvider}
                options={deepOptions}
                onValueChange={(v) => void patchImmediate({ deepProvider: v })}
              />
            </>
          ) : (
            <>
              <SettingsInput
                label="L1 极速秒回模型"
                hint="默认 antigravity/gemini-3.8-flash"
                initialValue={current.fastProvider}
                onChangeText={(txt) =>
                  setDraft((prev) => ({
                    ...(prev ?? settings.values),
                    fastProvider: txt.trim(),
                  }))
                }
              />
              <SettingsInput
                label="L1 极速备选模型"
                hint="默认 antigravity/gemini-4-hydrogen"
                initialValue={current.fastFallbackProvider}
                onChangeText={(txt) =>
                  setDraft((prev) => ({
                    ...(prev ?? settings.values),
                    fastFallbackProvider: txt.trim(),
                  }))
                }
              />
              <SettingsInput
                label="L2 主力查证模型"
                hint="默认 antigravity/gemini-4-carbon"
                initialValue={current.execProvider}
                onChangeText={(txt) =>
                  setDraft((prev) => ({
                    ...(prev ?? settings.values),
                    execProvider: txt.trim(),
                  }))
                }
              />
              <SettingsInput
                label="L3 深度思考模型"
                hint="默认 antigravity/gemini-4-neon"
                initialValue={current.deepProvider}
                onChangeText={(txt) =>
                  setDraft((prev) => ({
                    ...(prev ?? settings.values),
                    deepProvider: txt.trim(),
                  }))
                }
              />
            </>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="自动运行与通知">
        <SettingsCard>
          <SettingsSelect
            label="新任务会话方式"
            hint="独立会话（推荐）：每次派发重任务单独开一个会话，共享记忆与自动规则，互不阻塞。"
            value={current.wishSessionMode}
            options={WISH_MODE_OPTIONS}
            onValueChange={(v) => void patchImmediate({ wishSessionMode: v })}
          />
          <SettingsSwitch
            label="暂停全部后台自动规则"
            hint="开启后暂停文件监听、Webhook 与定时检查，不影响手动对话。"
            value={current.globalPaused}
            onValueChange={(v) => void patchImmediate({ globalPaused: v })}
          />
          <SettingsSwitch
            label="macOS 桌面通知"
            hint="有重要更新或操作需要确认时发送系统通知。"
            value={current.desktopNotify}
            onValueChange={(v) => void patchImmediate({ desktopNotify: v })}
          />
          <SettingsSwitch
            label="在普通对话中启用自动规则工具"
            hint="允许在任意工作区对话中直接用自然语言添加或修改自动规则。"
            value={current.injectToolsGlobally}
            onValueChange={(v) => void patchImmediate({ injectToolsGlobally: v })}
          />
          <SettingsInput
            label="每小时最大触发上限"
            hint="防止频繁事件连续消耗模型额度（1 - 200）。"
            initialValue={String(current.hourlyWakeLimit)}
            onChangeText={(txt) => {
              const parsed = Number.parseInt(txt, 10);
              if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 200) {
                setDraft((prev) => ({
                  ...(prev ?? settings.values),
                  hourlyWakeLimit: parsed,
                }));
              }
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="会话与工作区整理">
        <SettingsCard>
          <SettingsSwitch
            label="隐藏下方已置顶的空项目文件夹"
            hint="当某个项目文件夹下所有活跃工作区都已置顶到顶部「Pinned」区时，自动隐藏下方「Workspaces」里的空文件夹；新建未置顶工作区或取消置顶后自动恢复显示。"
            value={current.hidePinnedEmptyProjects}
            onValueChange={(v) => void patchImmediate({ hidePinnedEmptyProjects: v })}
          />
          <SettingsSwitch
            label="首轮对话完成后自动规范重命名"
            hint="自动将口语化长标题改写为「[分类] 简洁结论」，同步更新单会话本地工作区标题。"
            value={current.autoRenameOnFirstTurn}
            onValueChange={(v) => void patchImmediate({ autoRenameOnFirstTurn: v })}
          />
          <SettingsSwitch
            label="新建相似会话时提示历史同主题对话"
            hint="当在同一目录新起高度重合的话题时，在时间线顶部提示可续接的原会话。"
            value={current.duplicateSessionHintOnCreate}
            onValueChange={(v) =>
              void patchImmediate({ duplicateSessionHintOnCreate: v })
            }
          />
          <SettingsSwitch
            label="合并会话时沉淀摘要至知识库 00-Inbox"
            hint="合并归档多段同主题会话时，同时输出一份 Markdown 摘要笔记供 Obsidian 检索。"
            value={current.tidyWriteObsidianDigest}
            onValueChange={(v) => void patchImmediate({ tidyWriteObsidianDigest: v })}
          />
          <SettingsInput
            label="未置顶闲置会话归档阈值（小时）"
            hint="扫描整理时，闲置超过该时长的普通单次会话将列入待归档清单（1 - 720）。"
            initialValue={String(current.tidyIdleArchiveHours)}
            onChangeText={(txt) => {
              const parsed = Number.parseInt(txt, 10);
              if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 720) {
                setDraft((prev) => ({
                  ...(prev ?? settings.values),
                  tidyIdleArchiveHours: parsed,
                }));
              }
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="后台巡检与子任务默认模型">
        <SettingsCard>
          {hasCatalog ? (
            <>
              <SettingsSelect
                label="斜杠 /wish 主会话默认模型"
                hint="用于 /wish 命令直派新会话；追问已有会话时会自动沿用原会话模型。"
                value={current.chiefProvider}
                options={chiefOptions}
                onValueChange={(v) => void patchImmediate({ chiefProvider: v })}
              />
              <SettingsSelect
                label="后台规则巡检模型"
                hint="用于运行定时检查与目录差量监听。"
                value={current.scoutProvider}
                options={scoutOptions}
                onValueChange={(v) => void patchImmediate({ scoutProvider: v })}
              />
              <SettingsSelect
                label="跨工作区子任务默认模型"
                hint="用于后台子任务委托（delegate_task）。"
                value={current.defaultWorkerProvider}
                options={workerOptions}
                onValueChange={(v) => void patchImmediate({ defaultWorkerProvider: v })}
              />
            </>
          ) : (
            <>
              <SettingsInput
                label="斜杠 /wish 主会话默认模型"
                hint="格式 provider/model，默认 antigravity/gemini-4-carbon"
                initialValue={current.chiefProvider}
                onChangeText={(txt) =>
                  setDraft((prev) => ({
                    ...(prev ?? settings.values),
                    chiefProvider: txt.trim(),
                  }))
                }
              />
              <SettingsInput
                label="后台规则巡检模型"
                hint="用于运行定时检查与目录监听，默认 antigravity/gemini-4-carbon"
                initialValue={current.scoutProvider}
                onChangeText={(txt) =>
                  setDraft((prev) => ({
                    ...(prev ?? settings.values),
                    scoutProvider: txt.trim(),
                  }))
                }
              />
              <SettingsInput
                label="跨工作区子任务默认模型"
                hint="用于跨工作区后台子任务，默认 antigravity/gemini-4-carbon"
                initialValue={current.defaultWorkerProvider}
                onChangeText={(txt) =>
                  setDraft((prev) => ({
                    ...(prev ?? settings.values),
                    defaultWorkerProvider: txt.trim(),
                  }))
                }
              />
            </>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="目录与本地 Webhook">
        <SettingsCard>
          <SettingsInput
            label="默认工作目录"
            initialValue={current.homeCwd}
            onChangeText={(txt) =>
              setDraft((prev) => ({ ...(prev ?? settings.values), homeCwd: txt.trim() }))
            }
          />
          <SettingsInput
            label="长期记忆文件路径（MEMORY.md）"
            hint="可指向本地 Obsidian 笔记文件，支持直接读写同步。"
            initialValue={current.memoryFilePath}
            onChangeText={(txt) =>
              setDraft((prev) => ({
                ...(prev ?? settings.values),
                memoryFilePath: txt.trim(),
              }))
            }
          />
          <SettingsSwitch
            label="开启本地 HTTP Webhook 接收"
            hint="仅监听本机 127.0.0.1，用于接收快捷指令或本地脚本回调。"
            value={current.webhookEnabled}
            onValueChange={(v) => void patchImmediate({ webhookEnabled: v })}
          />
          <SettingsInput
            label="本地 Webhook 端口"
            initialValue={String(current.webhookPort)}
            onChangeText={(txt) => {
              const parsed = Number.parseInt(txt, 10);
              if (Number.isFinite(parsed) && parsed >= 1024 && parsed <= 65535) {
                setDraft((prev) => ({
                  ...(prev ?? settings.values),
                  webhookPort: parsed,
                }));
              }
            }}
          />
          <SettingsInput
            label="Webhook 密钥（选填）"
            hint="填写后需在请求头携带 x-paseo-bot-secret 或 Authorization: Bearer"
            initialValue={current.webhookSecret}
            secureTextEntry
            onChangeText={(txt) =>
              setDraft((prev) => ({ ...(prev ?? settings.values), webhookSecret: txt }))
            }
          />
          <SettingsAction
            label="保存全部输入项设置"
            actionLabel={settings.saving ? "保存中…" : "保存设置"}
            disabled={settings.saving}
            onPress={() => void saveDraftFields()}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
