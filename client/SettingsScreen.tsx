import {
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
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { paseoBotSettings, type BotSettings } from "../shared/settings";

const WISH_MODE_OPTIONS = [
  { label: "每次新任务单开会话（推荐）", value: "per_wish" as const },
  { label: "所有任务共用同一个主对话", value: "shared_chief" as const },
];

const styles = StyleSheet.create({
  errorWrap: { padding: 16, gap: 12 },
  container: { gap: 20 },
});

export function BotSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(paseoBotSettings);
  const toast = useToast();
  const [draft, setDraft] = useState<BotSettings | null>(null);

  const readyValues = settings.status === "ready" ? settings.values : null;

  useEffect(() => {
    if (readyValues && !draft) {
      setDraft(readyValues);
    }
  }, [readyValues, draft]);

  const patchImmediate = useCallback(
    async (patch: Partial<BotSettings>) => {
      if (settings.status !== "ready") return;
      const next = { ...settings.values, ...patch };
      setDraft(next);
      const ok = await settings.save(next, settings.revision);
      if (!ok && settings.saveError) {
        toast.error(settings.saveError);
      }
    },
    [settings, toast],
  );

  const saveDraftFields = useCallback(async () => {
    if (settings.status !== "ready" || !draft) return;
    const ok = await settings.save(draft, settings.revision);
    if (ok) {
      toast.show("设置已保存", { variant: "success" });
    } else if (settings.saveError) {
      toast.error(settings.saveError);
    }
  }, [draft, settings, toast]);

  if (settings.status === "loading") {
    return <Loading />;
  }

  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <View style={styles.errorWrap}>
        <Text style={{ color: theme.colors.statusDanger }}>
          Failed to load Paseo Bot settings: {settings.error}
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

  const current = draft ?? settings.values;

  return (
    <View style={styles.container}>
      <SettingsSection title="自动运行与通知">
        <SettingsCard>
          <SettingsSelect
            label="新任务会话方式"
            hint="独立会话（推荐）：每次发送新任务单独开一个会话，共享记忆与自动规则，互不阻塞。"
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
                setDraft((prev) => ({ ...(prev ?? settings.values), hourlyWakeLimit: parsed }));
              }
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="默认模型设置">
        <SettingsCard>
          <SettingsInput
            label="主对话模型"
            hint="格式 provider/model，默认 antigravity/gemini-4-neon"
            initialValue={current.chiefProvider}
            onChangeText={(txt) =>
              setDraft((prev) => ({ ...(prev ?? settings.values), chiefProvider: txt.trim() }))
            }
          />
          <SettingsInput
            label="后台规则检查模型"
            hint="用于运行定时检查与目录监听，默认 antigravity/gemini-4-neon"
            initialValue={current.scoutProvider}
            onChangeText={(txt) =>
              setDraft((prev) => ({ ...(prev ?? settings.values), scoutProvider: txt.trim() }))
            }
          />
          <SettingsInput
            label="子任务默认模型"
            hint="用于跨工作区后台子任务，默认 antigravity/gemini-4-neon"
            initialValue={current.defaultWorkerProvider}
            onChangeText={(txt) =>
              setDraft((prev) => ({
                ...(prev ?? settings.values),
                defaultWorkerProvider: txt.trim(),
              }))
            }
          />
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
              setDraft((prev) => ({ ...(prev ?? settings.values), memoryFilePath: txt.trim() }))
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
                setDraft((prev) => ({ ...(prev ?? settings.values), webhookPort: parsed }));
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
            label="保存目录与模型设置"
            actionLabel={settings.saving ? "保存中…" : "保存设置"}
            disabled={settings.saving}
            onPress={() => void saveDraftFields()}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
