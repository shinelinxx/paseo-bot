import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type PromptTemplateName =
  | "butler-persona"
  | "l1-router-prompt"
  | "proactive-bubble-style";

declare const __dirname: string | undefined;

export interface PromptTemplateVars {
  butlerName?: string;
  userName?: string;
}

export interface PromptDirEnvHints {
  metaUrl?: unknown;
  cjsDirname?: unknown;
  cwd?: string;
}

/**
 * Safely resolve candidate `prompts/` directories across ESM (`import.meta.url`),
 * Paseo's CJS plugin bundle (`import.meta.url === undefined`, `__dirname`), and `process.cwd()`.
 * Never throws during module initialization or bundled runtime evaluation (ISS-003).
 */
export function resolveDefaultPromptsDirs(hints?: PromptDirEnvHints): string[] {
  const seen = new Set<string>();
  const add = (candidate: string | undefined) => {
    if (!candidate) return;
    try {
      const resolved = path.resolve(candidate);
      if (!seen.has(resolved)) {
        seen.add(resolved);
      }
    } catch {
      // Ignore invalid path candidate
    }
  };

  const rawMetaUrl =
    hints && "metaUrl" in hints
      ? hints.metaUrl
      : typeof import.meta !== "undefined"
        ? (import.meta as { url?: unknown }).url
        : undefined;

  if (typeof rawMetaUrl === "string" && rawMetaUrl.startsWith("file:")) {
    try {
      const moduleDir = path.dirname(fileURLToPath(rawMetaUrl));
      add(path.resolve(moduleDir, "..", "prompts"));
      add(path.resolve(moduleDir, "prompts"));
    } catch {
      // Ignore malformed file URL
    }
  }

  const rawDirname =
    hints && "cjsDirname" in hints
      ? hints.cjsDirname
      : typeof __dirname === "string"
        ? __dirname
        : undefined;

  if (typeof rawDirname === "string" && rawDirname.trim().length > 0) {
    add(path.resolve(rawDirname, "prompts"));
    add(path.resolve(rawDirname, "..", "prompts"));
  }

  try {
    const cwd =
      hints?.cwd ??
      (typeof process !== "undefined" && typeof process.cwd === "function"
        ? process.cwd()
        : "");
    if (cwd) {
      add(path.resolve(cwd, "prompts"));
    }
  } catch {
    // Ignore process.cwd() failures
  }

  return [...seen];
}

const TEMPLATE_FILENAMES: Record<PromptTemplateName, string> = {
  "butler-persona": "butler-persona.md",
  "l1-router-prompt": "l1-router-prompt.md",
  "proactive-bubble-style": "proactive-bubble-style.md",
};

export const FALLBACK_PROMPT_TEMPLATES: Record<PromptTemplateName, string> = {
  "butler-persona": [
    "# Butler Core Persona (`butler-persona`)",
    "你是 `{{butlerName}}`，`{{userName}}` 在 Paseo 中的专属私人管家。你在同一条连续对话流中帮用户分担日常事务、核查状态并维护长期记忆。",
    "- 语气平和、温暖、结论先行，控制在 1–3 个短自然段，重点日期/金额用加粗，跳转入口写成 Markdown 内联链接；严禁输出 `【告警】`、`待确认：`、`子任务已完成：` 等工单腔。",
    "- 严格区分已核实事实与未触达边界，不猜测未核实状态；严禁在聊天中索要密码、SSH 私钥或 API Key。",
    "- 涉及任何外发邮件/消息、资金支付/下单、破坏性删除或不可逆修改前，必须调用 `paseo_bot_request_approval`（附带 `payloadPreview` 与 `followUpPrompt`）等待确认，绝不绕过。",
    "- 长期偏好与过滤规则通过 `paseo_bot_memory_read` / `paseo_bot_memory_write` 同步至 `MEMORY.md`；无实质变化的巡检一律调用 `paseo_bot_report_outcome({ level: \"silent\" })` 零打扰退出。",
    "- 主对话非阻塞：重排查/编码/跨工作区长任务优先用 `paseo_bot_delegate_task` 异步派发（或多步闭环拉专职监工 Subagent 跟进下游）并立刻交还对话权；在途接新活只增量派发不合并重跑，写操作须串行或 worktree 隔离，高危操作统一走 `paseo_bot_request_approval` 收口。",
  ].join("\n"),

  "l1-router-prompt": [
    "# L1 Fast Concierge & Router Prompt (`l1-router`)",
    "当前你运行在 `{{butlerName}}` 的 **L1 极速前台层**（服务对象：`{{userName}}`），目标是在 1–3 秒内完成自然短回复、一句话记忆/提醒校准，或向 L2/L3 发起两拍交棒。",
    "- 可用最小权限工具：`paseo_bot_memory_read`、`paseo_bot_memory_write`、`paseo_bot_list_triggers`、`paseo_bot_update_trigger`、`paseo_bot_self_wake`、`paseo_bot_escalate_task`。",
    "- 日常寒暄、起名改称呼（写入 `[称呼偏好]`）、一句话停用旧提醒/设过滤门槛（调用 `paseo_bot_memory_write` + 必要时 `paseo_bot_update_trigger({ enabled: false })`）或稍后提醒（`paseo_bot_self_wake`）直接在 L1 简短闭环。",
    "- 凡需查外部系统/MCP、读写仓库代码、跨目录派活或发起 Sentinel 审批（`paseo_bot_request_approval`），严禁凭空猜测，立即调用 `paseo_bot_escalate_task({ targetTier: \"L2\" | \"L3\", ackBubble, handoffBrief, cwd? })` 交棒并结束本轮。`ackBubble` 须为真人管家口吻的具体查证预告，禁绝系统术语。",
  ].join("\n"),

  "proactive-bubble-style": [
    "# Proactive Short Bubble Style Guide (`proactive-bubble-style`)",
    "当前你作为 `{{butlerName}}` 执行后台巡检、事件评估或子任务收尾汇报（服务对象：`{{userName}}`）。",
    "1. 无实质变化或命中 `MEMORY.md` / `noiseRules` 豁免条件时，立即调用 `paseo_bot_report_outcome({ level: \"silent\", summary: \"检查完成，无实质新增事项\" })` 静默结束。",
    "2. 涉及外发邮件/消息、资金交易、破坏性删除或不可逆变更时，必须调用 `paseo_bot_request_approval` 提交 `payloadPreview` 等待内联确认。",
    "3. 有值得关注的进展时调用 `paseo_bot_report_outcome({ level: \"notify\" })`：`summary` 直呼用户名字（若已知）、首句亮结论、加粗 1–3 个关键时间/金额、将入口织入 Markdown 内联链接并给出明确建议，长明细放进 `details`，严禁工单标题前缀。",
  ].join("\n"),
};

const rawPromptCache = new Map<string, string>();

export function renderPromptTemplate(raw: string, vars: PromptTemplateVars = {}): string {
  const butlerName = (vars.butlerName ?? "").trim() || "Paseo Bot";
  const userName = (vars.userName ?? "").trim();
  return raw
    .replace(/\{\{\s*butlerName\s*\}\}/g, butlerName)
    .replace(/\{\{\s*userName\s*\}\}/g, userName);
}

export async function loadRawPromptTemplate(
  name: PromptTemplateName,
  opts?: { promptsDir?: string; bypassCache?: boolean },
): Promise<{ content: string; usedFallback: boolean }> {
  const candidateDirs = opts?.promptsDir
    ? [path.resolve(opts.promptsDir)]
    : resolveDefaultPromptsDirs();
  const filename = TEMPLATE_FILENAMES[name];

  for (const dir of candidateDirs) {
    const filePath = path.join(dir, filename);
    if (!opts?.bypassCache && rawPromptCache.has(filePath)) {
      return { content: rawPromptCache.get(filePath)!, usedFallback: false };
    }
    try {
      const diskText = (await fs.readFile(filePath, "utf8")).trim();
      if (diskText.length > 0) {
        rawPromptCache.set(filePath, diskText);
        return { content: diskText, usedFallback: false };
      }
    } catch {
      // Try next candidate directory
    }
  }

  return {
    content: FALLBACK_PROMPT_TEMPLATES[name],
    usedFallback: true,
  };
}

export async function loadPromptTemplate(
  name: PromptTemplateName,
  vars: PromptTemplateVars = {},
  opts?: { promptsDir?: string; bypassCache?: boolean },
): Promise<string> {
  const { content } = await loadRawPromptTemplate(name, opts);
  return renderPromptTemplate(content, vars);
}

export async function buildButlerL1SystemPrompt(
  vars: PromptTemplateVars & { memoryContent?: string; memoryPath?: string },
  opts?: { promptsDir?: string },
): Promise<string> {
  const [persona, l1Guide] = await Promise.all([
    loadPromptTemplate("butler-persona", vars, opts),
    loadPromptTemplate("l1-router-prompt", vars, opts),
  ]);
  const memExcerpt = (vars.memoryContent ?? "").trim().slice(0, 4500);
  const memBlock = memExcerpt
    ? `[Persistent Memory (${vars.memoryPath || "MEMORY.md"})]\n${memExcerpt}`
    : `[Persistent Memory (${vars.memoryPath || "MEMORY.md"})]\n(当前为空，若用户告知长期偏好、称呼或停用提醒边界，请通过 paseo_bot_memory_write 记录)`;
  return [persona, l1Guide, memBlock].join("\n\n---\n\n");
}

export async function buildButlerExecSystemPrompt(
  vars: PromptTemplateVars & {
    tier: "L2" | "L3";
    memoryContent?: string;
    memoryPath?: string;
  },
  opts?: { promptsDir?: string },
): Promise<string> {
  const persona = await loadPromptTemplate("butler-persona", vars, opts);
  const tierInstruction =
    vars.tier === "L3"
      ? "当前运行在 **L3 深度思考升舱层**：请对用户的复杂架构、方案对比或长文分析诉求进行严谨推演，给出结论清晰、权衡透明、可直接落地的建议；最终回复仍保持管家自然沟通口吻（核心结论在前，长推演可结构化分段）。"
      : "当前运行在 **L2 主力核查与执行层**：请优先使用可用工具/MCP 如实核查事实或推进任务；区分「已核实事实」与「未触达权限边界」，绝不编造状态；涉及外发、资金或破坏性变更必走 `paseo_bot_request_approval`（Sentinel）。";
  const memExcerpt = (vars.memoryContent ?? "").trim().slice(0, 6000);
  const memBlock = memExcerpt
    ? `[Persistent Memory (${vars.memoryPath || "MEMORY.md"})]\n${memExcerpt}`
    : "";
  return [persona, tierInstruction, memBlock].filter(Boolean).join("\n\n---\n\n");
}

export async function buildProactiveScoutPromptGuidance(
  vars: PromptTemplateVars,
  opts?: { promptsDir?: string },
): Promise<string> {
  return loadPromptTemplate("proactive-bubble-style", vars, opts);
}
