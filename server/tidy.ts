import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PaseoAgent, PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import { execCommand } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { BOT_ALERT_TIMELINE_KIND } from "../shared/contracts.ts";
import { createShortId, expandHomePath, getPluginDataDir } from "./storage.ts";

export const TIDY_PLAN_HEADER_PREFIX = "# PASEO_BOT_TIDY_PLAN:";

export interface TidyRenameAction {
  itemKey: string;
  agentId?: string;
  shortAgentId?: string;
  workspaceId?: string;
  cwd: string;
  category: string;
  previousTitle: string;
  nextTitle: string;
}

export interface TidyHubAction {
  itemKey: string;
  cwd: string;
  projectLabel: string;
  existingWorkspaceId?: string;
  currentTitle?: string;
  hubTitle: string;
  duplicateLocalCount: number;
}

export interface TidyMergeSecondaryItem {
  agentId: string;
  shortId: string;
  workspaceId?: string;
  archiveWorkspace: boolean;
  title: string;
  updatedAt: string;
  firstGoal: string;
  conclusion: string;
}

export interface TidyMergeAction {
  itemKey: string;
  topicTitle: string;
  category: string;
  cwd: string;
  keeperAgentId: string;
  keeperShortId: string;
  keeperWorkspaceId?: string;
  keeperNextTitle: string;
  secondaries: TidyMergeSecondaryItem[];
  mergedDigestMarkdown: string;
}

export interface TidyArchiveAction {
  itemKey: string;
  kind: "empty_workspace" | "stale_session";
  agentId?: string;
  shortAgentId?: string;
  workspaceId?: string;
  archiveWorkspace: boolean;
  cwd: string;
  title: string;
  reason: string;
}

export interface SessionTidyPlan {
  id: string;
  createdAt: string;
  scannedWorkspaces: number;
  scannedAgents: number;
  writeObsidianDigest: boolean;
  obsidianInboxDir: string;
  hubs: TidyHubAction[];
  renames: TidyRenameAction[];
  merges: TidyMergeAction[];
  archives: TidyArchiveAction[];
}

export interface TidyExecutionSummary {
  planId: string;
  pinnedHubs: number;
  renamedCount: number;
  mergedClusters: number;
  archivedAgents: number;
  archivedWorkspaces: number;
  obsidianNotesPaths: string[];
  errors: string[];
}

const GENERIC_TOPIC_STOPWORDS = new Set([
  "paseo",
  "agent",
  "agents",
  "plugin",
  "plugins",
  "skill",
  "skills",
  "provider",
  "workspace",
  "session",
  "general",
  "moneymaker",
  "moneyprinter",
  "knowledgebase",
  "antigravity",
  "amazon",
  "claude",
  "codex",
  "gemini",
  "google",
  "github",
  "导入",
  "插件",
  "功能",
  "问题",
  "排查",
  "修复",
  "优化",
  "设计",
  "评估",
  "方案",
  "实现",
  "询问",
  "查询",
  "配置",
  "设置",
  "增加",
  "新增",
  "修改",
  "调整",
  "处理",
  "检查",
  "查看",
  "使用",
  "工具",
  "方式",
  "支持",
  "需要",
  "一个",
  "自动",
  "现在",
  "目前",
  "日常",
  "软件",
  "系统",
  "任务",
  "会话",
  "工作区",
  "怎么",
  "如何",
  "是否",
  "可以",
  "继续",
]);

export function provisionalPromptTitle(prompt: string): string {
  const line = prompt
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ? line.replace(/\s+/g, " ").trim().slice(0, 60).trim() : "";
}

export function isInternalBotTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const trimmed = title.trim();
  return (
    trimmed.startsWith("Paseo Bot") ||
    trimmed === "Title generator" ||
    trimmed === "Title generation" ||
    trimmed.startsWith("Bot Worker ·") ||
    trimmed.startsWith("Scout ·") ||
    trimmed.startsWith("Approved:") ||
    trimmed.startsWith("任务 ·") ||
    trimmed.startsWith("许愿 ·") ||
    /^(?:[\u4e00-\u9fa5]{2,4}部|产品运营|量化策略|风控合规|总办|CEO|CTO)$/u.test(trimmed)
  );
}

export function hasStructuredPrefix(title: string | null | undefined): boolean {
  if (!title) return false;
  const trimmed = title.trim();
  return /^(\[[^\]]{1,8}\]|📌\s*)/u.test(trimmed);
}

export function needsSessionAutoRename(
  currentTitle: string | null | undefined,
  firstPrompt?: string,
): boolean {
  const trimmed = (currentTitle ?? "").trim();
  if (!trimmed) return true;
  if (isInternalBotTitle(trimmed) || hasStructuredPrefix(trimmed)) return false;
  if (/^(untitled|new chat|new session|未命名|新对话|新会话)$/i.test(trimmed)) return true;

  if (firstPrompt) {
    const prov = provisionalPromptTitle(firstPrompt);
    if (prov && trimmed === prov) return true;
  }

  if (trimmed.length > 22) return true;
  if (/[。？！?!]/u.test(trimmed)) return true;
  if (/，.*，/u.test(trimmed)) return true;
  if (
    /^(需要一个|我需要|帮我|请帮我|麻烦|请问|我想|咨询|查询是否有|\d+\/[a-z0-9_-]+登[陆录]了)/iu.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (/(不要了吧|太杂了|可以继续.*了|不知道有没有|现在的痛点是)/u.test(trimmed)) {
    return true;
  }
  // Even clean short raw titles benefit from unified [分类] prefix during tidy!
  return !hasStructuredPrefix(trimmed);
}

export function inferSessionCategory(text: string, cwd = ""): string {
  const combined = `${text}\n${cwd}`;
  if (/养号|adspower|k1fi[a-z0-9]*|bringingchichi|指纹浏览器/iu.test(combined)) {
    return "养号";
  }
  if (
    /bfmr|buyinggroup|美亚|撸货|上车|报单|order\.shinelin|未发货订单|commit\s*链接/iu.test(
      combined,
    )
  ) {
    return "撸货";
  }
  if (
    /multigravity|voice-clean|mcp-hub|paseo-mcp-hub|model-switch|antigravity-console|antigravity-accounts|paseo-bot|自研插件|插件设计|插件/iu.test(
      text,
    ) ||
    cwd.includes("/paseo-bot")
  ) {
    return "插件";
  }
  if (/路由器|代理|子域名|shinelin\.net|dns|cloudflare|openwrt|miwifi/iu.test(text)) {
    return "网络";
  }
  if (/ibkr|trader|量化|期权|回测|交易策略/iu.test(combined)) {
    return "量化";
  }
  if (/00-inbox|obsidian|wiki|知识库|笔记整理/iu.test(text)) {
    return "知识库";
  }
  if (/paseo|provider|会话整理|工作区|手机端|语音转文字/iu.test(text)) {
    return "Paseo";
  }
  if (cwd.includes("MoneyPrinter") || cwd.includes("MoneyMaker")) return "撸货";
  if (cwd.includes("KnowledgeBase") && /搭建|架构|规范|目录/u.test(text)) return "知识库";
  return "日常";
}

function visualWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    w += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  }
  return w;
}

function sliceByVisualWidth(str: string, maxWidth: number): string {
  if (visualWidth(str) <= maxWidth) return str;
  let w = 0;
  let out = "";
  for (const ch of str) {
    const cw = ch.charCodeAt(0) > 0x7f ? 2 : 1;
    if (w + cw > maxWidth - 1) break;
    out += ch;
    w += cw;
  }
  return `${out.trim()}…`;
}

function cleanCorePhrase(raw: string): string {
  let s = raw
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Pattern-specific colloquial rewrites
  const loginContinue =
    /^(\d+\/[a-z0-9_-]+|[a-z0-9_-]+)\s*登[陆录]了\s*([^\s，,。]+)[，,\s]*可以继续(.+?)[了。！!]*$/iu.exec(
      s,
    );
  if (loginContinue) {
    const profile = loginContinue[1].replace(/^\d+\//, "");
    const account = loginContinue[2].replace(/@gmail\.com$/i, "");
    const action = loginContinue[3].trim();
    return sliceByVisualWidth(`${profile} 登录 ${account} 续跑${action}`, 44);
  }

  const dropFeature = /^([a-z0-9_.-]+)\s*的(.+?)不要了吧[，,\s]*(?:太杂了.*)?$/iu.exec(s);
  if (dropFeature) {
    return sliceByVisualWidth(`精简 ${dropFeature[1]} 移除${dropFeature[2].trim()}`, 44);
  }

  if (/会话整理工具/u.test(s) && /重命名/u.test(s) && /合并归档/u.test(s)) {
    return "会话自动重命名与合并归档";
  }

  const selectAllDeal = /^需要一个外层的勾选(.+)$/iu.exec(s);
  if (selectAllDeal) {
    return sliceByVisualWidth(`增加外层勾选${selectAllDeal[1].trim()}`, 44);
  }

  const routerProxy = /^配置路由器[，,\s]*([^\s，,]+)的所有子域名都走(.+?)[。！!]*$/iu.exec(s);
  if (routerProxy) {
    return sliceByVisualWidth(`配置 ${routerProxy[1]} 子域名走${routerProxy[2].trim()}`, 44);
  }

  // Strip conversational openings
  s = s
    .replace(
      /^(?:请帮我|帮我|麻烦帮我|麻烦|请问一下|请问|我想问一下|我想|我需要一个|需要一个|希望有一个|帮我看下|看下)\s*/u,
      "",
    )
    .replace(/[，,]\s*(?:现在的痛点是|目前的痛点是|不知道有没有|你看看|麻烦|谢谢).*$/u, "")
    .replace(/[。？！?!；;，,\s]+$/u, "")
    .trim();

  if (visualWidth(s) > 44) {
    const clauseParts = s.split(/[，,；;。]/u).map((p) => p.trim()).filter(Boolean);
    if (clauseParts.length >= 2) {
      let acc = clauseParts[0];
      for (let i = 1; i < clauseParts.length; i += 1) {
        if (visualWidth(`${acc}·${clauseParts[i]}`) <= 44) {
          acc = `${acc}·${clauseParts[i]}`;
        } else {
          break;
        }
      }
      s = acc;
    }
  }

  return sliceByVisualWidth(s, 44) || "未命名会话";
}

function isVagueShortPhrase(core: string): boolean {
  const clean = core.trim();
  if (!clean) return true;
  if (
    /^(?:怎么办|怎么弄|怎么搞|怎么修|怎么解决|看看|看下|帮我看下|这是什么|什么原因|什么情况|报错了|出错了|为什么|继续|在吗)$/iu.test(
      clean,
    )
  ) {
    return true;
  }
  return visualWidth(clean) <= 6;
}

function extractTopicFromAssistantReply(reply: string): string {
  if (!reply.trim()) return "";
  const headingMatch = /(?:^|\n)#{1,4}\s+([^\n#]{4,60})/u.exec(reply);
  if (headingMatch) {
    return cleanCorePhrase(headingMatch[1].replace(/\*\*/g, ""));
  }
  const boldMatch = /\*\*([^*\n]{4,48})\*\*/u.exec(reply);
  if (boldMatch) {
    return cleanCorePhrase(boldMatch[1]);
  }
  const firstLine = reply
    .split(/\r?\n/)
    .map((l) => l.replace(/^[>*-\d.\s]+/, "").trim())
    .find((l) => l.length >= 6);
  return firstLine ? cleanCorePhrase(firstLine) : "";
}

export function normalizeSessionTitleFast(input: {
  currentTitle?: string | null;
  firstPrompt?: string;
  assistantReply?: string;
  cwd?: string;
}): { title: string; category: string } {
  const existing = (input.currentTitle ?? "").trim();
  if (existing && (isInternalBotTitle(existing) || hasStructuredPrefix(existing))) {
    const catMatch = /^\[([^\]]{1,8})\]/u.exec(existing);
    return {
      title: existing,
      category: catMatch ? catMatch[1] : inferSessionCategory(existing, input.cwd),
    };
  }

  const sourceBasis = existing || (input.firstPrompt ?? "").trim();
  const category = inferSessionCategory(
    `${sourceBasis}\n${(input.firstPrompt ?? "").slice(0, 300)}\n${(input.assistantReply ?? "").slice(0, 300)}`,
    input.cwd ?? "",
  );
  let core = cleanCorePhrase(sourceBasis || "快速问答");
  if (isVagueShortPhrase(core) && input.assistantReply) {
    const fromReply = extractTopicFromAssistantReply(input.assistantReply);
    if (fromReply && !isVagueShortPhrase(fromReply)) {
      core = fromReply;
    }
  }
  return {
    title: `[${category}] ${core}`,
    category,
  };
}

interface TopicFingerprint {
  specificEntities: string[];
  specificCjk: string[];
}

export function extractTopicFingerprint(text: string): TopicFingerprint {
  const cleaned = text
    .replace(/^\[[^\]]{1,8}\]\s*/u, "")
    .replace(/file:\/\/[^\s)]+/g, " ")
    .toLowerCase();

  const entities = new Set<string>();
  const entityRe = /[a-z0-9][a-z0-9._@-]{2,45}/g;
  let m: RegExpExecArray | null;
  while ((m = entityRe.exec(cleaned)) !== null) {
    const raw = m[0].replace(/^\d+\//, "");
    if (GENERIC_TOPIC_STOPWORDS.has(raw)) continue;
    if (/^(http|https|json|html|true|false|null|users|shinelin|documents|gmail|com)$/.test(raw)) {
      continue;
    }
    if (raw.includes("@")) {
      entities.add(raw.split("@")[0]);
    }
    entities.add(raw);
  }

  const cjk = new Set<string>();
  const chunks = cleaned.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const chunk of chunks) {
    if (GENERIC_TOPIC_STOPWORDS.has(chunk)) continue;
    if (chunk.length <= 5 && !GENERIC_TOPIC_STOPWORDS.has(chunk)) {
      cjk.add(chunk);
    }
    for (let i = 0; i <= chunk.length - 2; i += 1) {
      const bg = chunk.slice(i, i + 2);
      if (!GENERIC_TOPIC_STOPWORDS.has(bg)) {
        cjk.add(bg);
      }
    }
  }

  return {
    specificEntities: [...entities],
    specificCjk: [...cjk],
  };
}

export function scoreSessionTopicSimilarity(
  a: { title: string; firstPrompt?: string; category: string; cwd: string },
  b: { title: string; firstPrompt?: string; category: string; cwd: string },
): number {
  if (a.cwd && b.cwd && path.resolve(a.cwd) !== path.resolve(b.cwd)) {
    return 0;
  }

  const fpA = extractTopicFingerprint(`${a.title} ${(a.firstPrompt ?? "").slice(0, 240)}`);
  const fpB = extractTopicFingerprint(`${b.title} ${(b.firstPrompt ?? "").slice(0, 240)}`);

  let score = 0;
  const setEntityB = new Set(fpB.specificEntities);
  let sharedStrongEntities = 0;
  for (const ent of fpA.specificEntities) {
    if (setEntityB.has(ent)) {
      sharedStrongEntities += 1;
      score += ent.length >= 6 || ent.includes("-") || ent.includes(".") ? 32 : 20;
    }
  }

  const setCjkB = new Set(fpB.specificCjk);
  let sharedCjkCount = 0;
  for (const tok of fpA.specificCjk) {
    if (setCjkB.has(tok)) {
      sharedCjkCount += 1;
      score += tok.length >= 3 ? 10 : 5;
    }
  }

  if (a.category === b.category && a.category !== "日常" && a.category !== "Paseo" && a.category !== "插件") {
    score += 8;
  }

  // Require either at least 1 strong specific entity + topic context, or high CJK phrase overlap
  if (sharedStrongEntities === 0 && sharedCjkCount < 4) {
    return 0;
  }
  return score;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function readAgentTurnExcerpts(
  paseo: PaseoApi,
  agentId: string,
  timeoutMs = 2_500,
): Promise<{ firstUser: string; lastAssistant: string; turnCountEstimate: number }> {
  const empty = { firstUser: "", lastAssistant: "", turnCountEstimate: 0 };
  return withTimeout(
    (async () => {
      const timeline = paseo.agents.ref(agentId).timeline;
      const [headPage, tailPage] = await Promise.all([
        withTimeout(
          timeline.refetch({ direction: "after", projection: "projected", limit: 6 }),
          timeoutMs,
          null,
        ),
        withTimeout(
          timeline.refetch({ direction: "tail", projection: "projected", limit: 8 }),
          timeoutMs,
          null,
        ),
      ]);

      let firstUser = "";
      let turnCountEstimate = 0;
      for (const entry of headPage?.entries ?? []) {
        const item = entry.item as AgentTimelineItem;
        if (item.type === "user_message" && typeof item.text === "string") {
          if (!firstUser) firstUser = item.text.trim();
          turnCountEstimate += 1;
        }
      }

      let lastAssistant = "";
      const tailEntries = [...(tailPage?.entries ?? [])].reverse();
      for (const entry of tailEntries) {
        const item = entry.item as AgentTimelineItem;
        if (
          !lastAssistant &&
          item.type === "assistant_message" &&
          typeof item.text === "string" &&
          item.text.trim()
        ) {
          lastAssistant = item.text.trim();
        }
        if (
          !firstUser &&
          item.type === "user_message" &&
          typeof item.text === "string" &&
          item.text.trim()
        ) {
          firstUser = item.text.trim();
        }
      }

      return {
        firstUser: firstUser.slice(0, 600),
        lastAssistant: lastAssistant.slice(0, 800),
        turnCountEstimate,
      };
    })(),
    timeoutMs + 300,
    empty,
  );
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function renamePaseoAgentViaCli(input: {
  agentId: string;
  title?: string;
  labels?: Record<string, string>;
  loginPath: string;
}): Promise<{ ok: boolean; error?: string }> {
  const cleanId = input.agentId.trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(cleanId)) {
    return { ok: false, error: "Invalid agent ID" };
  }
  const args = ["agent", "update"];
  if (input.title?.trim()) {
    args.push("--name", input.title.trim());
  }
  if (input.labels) {
    for (const [k, v] of Object.entries(input.labels)) {
      if (k.trim() && v.trim()) {
        args.push("--label", `${k.trim()}=${v.trim()}`);
      }
    }
  }
  args.push("--json", cleanId);

  try {
    await execCommand("paseo", args, {
      env: { ...process.env, PATH: input.loginPath },
      timeout: 8_000,
      maxBuffer: 128 * 1024,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function defaultHubTitleForDirectory(cwd: string, projectLabel: string): string {
  const base = path.basename(cwd);
  if (base === "MoneyPrinter" || base === "MoneyMaker") return `📌 美亚撸货 · ${base}`;
  if (base === "KnowledgeBase") return "📌 知识库中枢 · KnowledgeBase";
  if (base === "paseo") return "📌 插件与工具 · paseo";
  return `📌 常驻主控 · ${projectLabel || base}`;
}

function summarizeSingleLine(text: string, maxLen = 110): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, "[代码块]")
    .replace(/[#>*`]/g, "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "（无文本记录）";
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

export async function analyzeSessionsForTidy(input: {
  paseo: PaseoApi;
  chiefAgentId?: string | null;
  chiefWorkspaceId?: string | null;
  callerAgentId?: string;
  idleArchiveHours: number;
  closedArchiveHours?: number;
  ensurePinnedHubs?: boolean;
  writeObsidianDigest: boolean;
  homeCwd: string;
}): Promise<SessionTidyPlan> {
  const { paseo } = input;
  const now = Date.now();
  const idleHours = Math.max(1, input.idleArchiveHours);
  const closedHours = input.closedArchiveHours ?? Math.min(8, idleHours);

  const [wsRes, agtRes, termRes] = await Promise.all([
    paseo.workspaces.list(),
    paseo.agents.list(),
    paseo.terminals.list().catch(() => ({ entries: [] })),
  ]);

  const activeWorkspaces = (wsRes.entries ?? []).filter(
    (ws) => !ws.archivingAt && !ws.background && !ws.internal,
  );

  const activeTerminalWsIds = new Set<string>();
  for (const t of termRes.entries ?? []) {
    if (t.workspaceId) activeTerminalWsIds.add(t.workspaceId);
  }

  const wsById = new Map<string, PaseoWorkspace>();
  for (const ws of activeWorkspaces) {
    wsById.set(ws.id, ws);
  }

  interface EnrichedAgent {
    raw: PaseoAgent;
    id: string;
    shortId: string;
    workspaceId: string | undefined;
    workspace: PaseoWorkspace | undefined;
    cwd: string;
    currentTitle: string;
    status: string;
    lastUserAtMs: number;
    updatedAtMs: number;
    updatedAtIso: string;
    isProtected: boolean;
    firstUser: string;
    lastAssistant: string;
    normalizedTitle: string;
    category: string;
  }

  const candidateAgents: PaseoAgent[] = [];
  for (const entry of agtRes.entries ?? []) {
    const a = entry.agent;
    if (!a || a.archivedAt) continue;
    const rec = a as unknown as Record<string, unknown>;
    if (rec.background) continue;
    const labels = (rec.labels && typeof rec.labels === "object"
      ? (rec.labels as Record<string, string>)
      : {}) as Record<string, string>;
    if (labels["paseo-bot/role"] === "scout" || labels["paseo-bot/role"] === "worker") continue;
    if (labels["paseo.parent-agent-id"] || rec.parentAgentId) continue;
    candidateAgents.push(a);
  }

  const agentsByWorkspace = new Map<string, PaseoAgent[]>();
  for (const a of candidateAgents) {
    if (!a.workspaceId) continue;
    const arr = agentsByWorkspace.get(a.workspaceId) ?? [];
    arr.push(a);
    agentsByWorkspace.set(a.workspaceId, arr);
  }

  const enriched = await mapWithConcurrency(candidateAgents, 6, async (a): Promise<EnrichedAgent> => {
    const rec = a as unknown as Record<string, unknown>;
    const ws = a.workspaceId ? wsById.get(a.workspaceId) : undefined;
    const rawCwd =
      (typeof a.cwd === "string" && a.cwd) ||
      ws?.projectRootPath ||
      ws?.workspaceDirectory ||
      "";
    const cwd = rawCwd ? path.resolve(expandHomePath(rawCwd)) : "";
    const currentTitle = typeof a.title === "string" ? a.title.trim() : "";
    const status = typeof a.status === "string" ? a.status : "idle";
    const updatedStr =
      (typeof a.updatedAt === "string" && a.updatedAt) ||
      (typeof a.createdAt === "string" && a.createdAt) ||
      new Date(now).toISOString();
    const updatedAtMs = Number.isFinite(Date.parse(updatedStr)) ? Date.parse(updatedStr) : now;
    const rawLastUser = typeof rec.lastUserMessageAt === "string" ? rec.lastUserMessageAt : "";
    const lastUserAtMs =
      rawLastUser && Number.isFinite(Date.parse(rawLastUser)) ? Date.parse(rawLastUser) : 0;

    const bgCount =
      rec.backgroundWork &&
      typeof rec.backgroundWork === "object" &&
      typeof (rec.backgroundWork as { count?: unknown }).count === "number"
        ? ((rec.backgroundWork as { count: number }).count ?? 0)
        : 0;

    const isProtected =
      a.id === input.chiefAgentId ||
      a.id === input.callerAgentId ||
      status === "running" ||
      status === "initializing" ||
      Boolean(rec.requiresAttention) ||
      bgCount > 0 ||
      Boolean(ws?.pinnedAt) ||
      isInternalBotTitle(currentTitle);

    // Avoid opening cold provider history sessions on closed/idle agents during bulk scan!
    // Only fetch timeline excerpts when an open session has a completely blank title.
    const excerpts =
      !currentTitle && status !== "closed"
        ? await readAgentTurnExcerpts(paseo, a.id, 2_000)
        : { firstUser: "", lastAssistant: "", turnCountEstimate: 0 };
    const norm = normalizeSessionTitleFast({
      currentTitle,
      firstPrompt: excerpts.firstUser,
      assistantReply: excerpts.lastAssistant,
      cwd,
    });

    return {
      raw: a,
      id: a.id,
      shortId: a.id.slice(0, 7),
      workspaceId: a.workspaceId ?? undefined,
      workspace: ws,
      cwd,
      currentTitle,
      status,
      lastUserAtMs,
      updatedAtMs,
      updatedAtIso: updatedStr,
      isProtected,
      firstUser: excerpts.firstUser,
      lastAssistant: excerpts.lastAssistant,
      normalizedTitle: norm.title,
      category: norm.category,
    };
  });

  // 1. Pinned Canonical Hub Workspaces for fragmented local directories
  const hubs: TidyHubAction[] = [];
  const designatedHubWorkspaceIds = new Set<string>();
  if (input.ensurePinnedHubs !== false) {
    const localWsByCwd = new Map<string, PaseoWorkspace[]>();
    for (const ws of activeWorkspaces) {
      if (ws.workspaceKind === "worktree") continue;
      const rawDir = ws.projectRootPath || ws.workspaceDirectory;
      if (!rawDir) continue;
      const normCwd = path.resolve(expandHomePath(rawDir));
      const list = localWsByCwd.get(normCwd) ?? [];
      list.push(ws);
      localWsByCwd.set(normCwd, list);
    }

    let hubIdx = 1;
    for (const [cwd, list] of localWsByCwd.entries()) {
      if (list.length < 3) continue;
      const alreadyPinned = list.find((w) => Boolean(w.pinnedAt));
      if (alreadyPinned) {
        designatedHubWorkspaceIds.add(alreadyPinned.id);
        continue;
      }

      const projectLabel =
        (list[0].projectCustomName && list[0].projectCustomName.trim()) ||
        list[0].projectDisplayName ||
        path.basename(cwd);
      const hubTitle = defaultHubTitleForDirectory(cwd, projectLabel);

      // Prefer an existing clean general-named workspace (like "知识库搭建" or "Amazon撸货") or an empty workspace we can repurpose!
      const reusable =
        list.find((w) => {
          const t = (w.title ?? "").trim();
          return /^(知识库搭建|Amazon撸货|日常总控|主工作区)$/iu.test(t);
        }) ??
        list.find((w) => !(w.title ?? "").trim() && (agentsByWorkspace.get(w.id)?.length ?? 0) === 0);

      if (reusable) {
        designatedHubWorkspaceIds.add(reusable.id);
      }

      hubs.push({
        itemKey: `hub_${hubIdx++}`,
        cwd,
        projectLabel,
        existingWorkspaceId: reusable?.id,
        currentTitle: reusable ? (reusable.title ?? "") : undefined,
        hubTitle,
        duplicateLocalCount: list.length,
      });
    }
  }

  // 2. Topic Clustering for Merge & Archive (within same cwd)
  const merges: TidyMergeAction[] = [];
  const mergedSecondaryAgentIds = new Set<string>();
  const mergedWorkspaceArchiveIds = new Set<string>();
  const keeperTitleMap = new Map<string, string>();

  const clusterCandidates = enriched.filter((e) => !isInternalBotTitle(e.currentTitle) && e.cwd);
  const visited = new Set<string>();
  let mrgIdx = 1;

  for (let i = 0; i < clusterCandidates.length; i += 1) {
    const seed = clusterCandidates[i];
    if (visited.has(seed.id)) continue;

    const group: EnrichedAgent[] = [seed];
    for (let j = i + 1; j < clusterCandidates.length; j += 1) {
      const other = clusterCandidates[j];
      if (visited.has(other.id)) continue;
      const sim = scoreSessionTopicSimilarity(
        {
          title: seed.currentTitle || seed.normalizedTitle,
          firstPrompt: seed.firstUser,
          category: seed.category,
          cwd: seed.cwd,
        },
        {
          title: other.currentTitle || other.normalizedTitle,
          firstPrompt: other.firstUser,
          category: other.category,
          cwd: other.cwd,
        },
      );
      if (sim >= 38) {
        group.push(other);
      }
    }

    if (group.length < 2) continue;

    // Sort: active/running first, then sessions with real user messages (newest lastUserAtMs), then updatedAtMs
    group.sort((a, b) => {
      const aRun = a.status === "running" ? 1 : 0;
      const bRun = b.status === "running" ? 1 : 0;
      if (aRun !== bRun) return bRun - aRun;
      const aHasMsg = a.lastUserAtMs > 0 ? 1 : 0;
      const bHasMsg = b.lastUserAtMs > 0 ? 1 : 0;
      if (aHasMsg !== bHasMsg) return bHasMsg - aHasMsg;
      if (a.lastUserAtMs !== b.lastUserAtMs) return b.lastUserAtMs - a.lastUserAtMs;
      return b.updatedAtMs - a.updatedAtMs;
    });

    const keeper = group[0];
    const archivableSecondaries = group.slice(1).filter((s) => !s.isProtected);
    if (archivableSecondaries.length === 0) continue;

    for (const member of group) visited.add(member.id);

    const secondaryExcerpts = await mapWithConcurrency(
      archivableSecondaries,
      3,
      async (sec) =>
        sec.status !== "closed"
          ? readAgentTurnExcerpts(paseo, sec.id, 2_000)
          : { firstUser: sec.currentTitle, lastAssistant: "", turnCountEstimate: 1 },
    );

    const secondaryItems: TidyMergeSecondaryItem[] = archivableSecondaries.map((sec, sIdx) => {
      const secEx = secondaryExcerpts[sIdx];
      mergedSecondaryAgentIds.add(sec.id);
      const ws = sec.workspace;
      const wsAgents = sec.workspaceId ? (agentsByWorkspace.get(sec.workspaceId) ?? []) : [];
      const remainingInWs = wsAgents.filter(
        (a) => a.id !== sec.id && !mergedSecondaryAgentIds.has(a.id),
      );
      const canArchiveWs = Boolean(
        ws &&
          ws.workspaceKind !== "worktree" &&
          !ws.pinnedAt &&
          !designatedHubWorkspaceIds.has(ws.id) &&
          ws.id !== keeper.workspaceId &&
          ws.id !== input.chiefWorkspaceId &&
          !activeTerminalWsIds.has(ws.id) &&
          remainingInWs.length === 0,
      );
      if (canArchiveWs && sec.workspaceId) {
        mergedWorkspaceArchiveIds.add(sec.workspaceId);
      }

      return {
        agentId: sec.id,
        shortId: sec.shortId,
        workspaceId: sec.workspaceId,
        archiveWorkspace: canArchiveWs,
        title: sec.currentTitle || sec.normalizedTitle,
        updatedAt: sec.updatedAtIso,
        firstGoal: summarizeSingleLine(secEx.firstUser || sec.currentTitle, 140),
        conclusion: summarizeSingleLine(
          secEx.lastAssistant || `原会话「${sec.currentTitle || sec.normalizedTitle}」已归入本主线`,
          180,
        ),
      };
    });

    const digestLines = [
      `### 同主题历史会话合并摘要（${keeper.normalizedTitle}）`,
      `保留主会话：\`${keeper.shortId}\`（${keeper.currentTitle || keeper.normalizedTitle}）`,
      ``,
      ...secondaryItems.map(
        (s, idx) =>
          `${idx + 1}. **${s.title}** (\`${s.shortId}\` · ${s.updatedAt.slice(0, 16).replace("T", " ")})\n   - 诉求：${s.firstGoal}\n   - 结论：${s.conclusion}`,
      ),
    ];

    keeperTitleMap.set(keeper.id, keeper.normalizedTitle);
    merges.push({
      itemKey: `mrg_${mrgIdx++}`,
      topicTitle: keeper.normalizedTitle,
      category: keeper.category,
      cwd: keeper.cwd,
      keeperAgentId: keeper.id,
      keeperShortId: keeper.shortId,
      keeperWorkspaceId: keeper.workspaceId,
      keeperNextTitle: keeper.normalizedTitle,
      secondaries: secondaryItems,
      mergedDigestMarkdown: digestLines.join("\n"),
    });
  }

  // 3. Stale One-off Sessions & Empty Shell Workspaces
  const archives: TidyArchiveAction[] = [];
  const archivedAgentIds = new Set<string>(mergedSecondaryAgentIds);
  const archivedWorkspaceIds = new Set<string>(mergedWorkspaceArchiveIds);
  let arcIdx = 1;

  for (const e of enriched) {
    if (archivedAgentIds.has(e.id) || e.isProtected) continue;
    // Also don't archive the keeper of a merge cluster!
    if (keeperTitleMap.has(e.id)) continue;

    const ageHours = Math.max(0, (now - e.updatedAtMs) / 3_600_000);
    const isStaleClosed = e.status === "closed" && ageHours >= closedHours;
    const isStaleIdle = e.status === "idle" && ageHours >= idleHours;
    if (!isStaleClosed && !isStaleIdle) continue;

    archivedAgentIds.add(e.id);
    const ws = e.workspace;
    const wsAgents = e.workspaceId ? (agentsByWorkspace.get(e.workspaceId) ?? []) : [];
    const remainingInWs = wsAgents.filter((a) => !archivedAgentIds.has(a.id));
    const canArchiveWs = Boolean(
      ws &&
        ws.workspaceKind !== "worktree" &&
        !ws.pinnedAt &&
        !designatedHubWorkspaceIds.has(ws.id) &&
        ws.id !== input.chiefWorkspaceId &&
        !activeTerminalWsIds.has(ws.id) &&
        remainingInWs.length === 0,
    );
    if (canArchiveWs && e.workspaceId) {
      archivedWorkspaceIds.add(e.workspaceId);
    }

    const hrsLabel = ageHours >= 24 ? `${Math.round(ageHours / 24)}天` : `${Math.round(ageHours)}h`;
    archives.push({
      itemKey: `arc_${arcIdx++}`,
      kind: "stale_session",
      agentId: e.id,
      shortAgentId: e.shortId,
      workspaceId: e.workspaceId,
      archiveWorkspace: canArchiveWs,
      cwd: e.cwd,
      title: e.normalizedTitle,
      reason: e.status === "closed" ? `已关闭 ${hrsLabel}` : `闲置 ${hrsLabel}`,
    });
  }

  // Empty shell workspaces (0 active agents, 0 terminals, not pinned, not repurposed as hub)
  for (const ws of activeWorkspaces) {
    if (archivedWorkspaceIds.has(ws.id) || designatedHubWorkspaceIds.has(ws.id)) continue;
    if (ws.pinnedAt || ws.workspaceKind === "worktree" || ws.id === input.chiefWorkspaceId) continue;
    if (activeTerminalWsIds.has(ws.id)) continue;
    const wsAgents = agentsByWorkspace.get(ws.id) ?? [];
    if (wsAgents.length > 0) continue;

    const createdMs = ws.createdAt ? Date.parse(ws.createdAt) : 0;
    if (createdMs && now - createdMs < 5 * 60_000) continue;

    const rawDir = ws.projectRootPath || ws.workspaceDirectory || "";
    archivedWorkspaceIds.add(ws.id);
    archives.push({
      itemKey: `arc_${arcIdx++}`,
      kind: "empty_workspace",
      workspaceId: ws.id,
      archiveWorkspace: true,
      cwd: rawDir ? path.resolve(expandHomePath(rawDir)) : "",
      title: (ws.title && ws.title.trim()) || `无标题空壳工作区 (${ws.id})`,
      reason: "无活跃会话与终端",
    });
  }

  // 4. Smart Renames for remaining active sessions & untitled single-agent workspaces
  const renames: TidyRenameAction[] = [];
  let renIdx = 1;
  for (const e of enriched) {
    if (archivedAgentIds.has(e.id)) continue;
    if (isInternalBotTitle(e.currentTitle)) continue;

    const ws = e.workspace;
    const wsTitle = (ws?.title ?? "").trim();
    const shouldRenameAgent =
      needsSessionAutoRename(e.currentTitle, e.firstUser) && e.normalizedTitle !== e.currentTitle;
    const shouldSyncWorkspace = Boolean(
      ws &&
        !designatedHubWorkspaceIds.has(ws.id) &&
        !archivedWorkspaceIds.has(ws.id) &&
        ws.workspaceKind !== "worktree" &&
        (agentsByWorkspace.get(ws.id)?.length ?? 0) === 1 &&
        (!wsTitle || wsTitle === e.currentTitle || needsSessionAutoRename(wsTitle, e.firstUser)) &&
        wsTitle !== e.normalizedTitle,
    );

    if (!shouldRenameAgent && !shouldSyncWorkspace) continue;

    renames.push({
      itemKey: `ren_${renIdx++}`,
      agentId: shouldRenameAgent ? e.id : undefined,
      shortAgentId: e.shortId,
      workspaceId: shouldSyncWorkspace ? ws?.id : undefined,
      cwd: e.cwd,
      category: e.category,
      previousTitle: shouldRenameAgent
        ? e.currentTitle || wsTitle || "（无标题）"
        : wsTitle || "（无标题）",
      nextTitle: e.normalizedTitle,
    });
  }

  const kbRoot = expandHomePath(input.homeCwd || "~/Documents/KnowledgeBase");
  return {
    id: createShortId("tidy"),
    createdAt: new Date(now).toISOString(),
    scannedWorkspaces: activeWorkspaces.length,
    scannedAgents: enriched.length,
    writeObsidianDigest: input.writeObsidianDigest,
    obsidianInboxDir: path.join(kbRoot, "00-Inbox"),
    hubs,
    renames,
    merges,
    archives,
  };
}

export function countTidyPlanActions(plan: SessionTidyPlan): number {
  return plan.hubs.length + plan.renames.length + plan.merges.length + plan.archives.length;
}

export function renderTidyPlanMarkdown(plan: SessionTidyPlan): string {
  const lines: string[] = [
    `${TIDY_PLAN_HEADER_PREFIX}${plan.id}`,
    `> 共扫描 **${plan.scannedWorkspaces}** 个工作区、**${plan.scannedAgents}** 个会话 · 如需跳过某项，点击「修改内容」把 \`[x]\` 改为 \`[ ]\` 或删掉该行即可`,
  ];

  if (plan.hubs.length > 0) {
    lines.push("", "### 1. 收敛常驻置顶主工作区（治本防碎片）");
    for (const h of plan.hubs) {
      const targetDesc = h.existingWorkspaceId
        ? `复用并置顶 \`${h.existingWorkspaceId}\`${h.currentTitle ? `（原名「${h.currentTitle}」）` : "（原空壳工作区）"}`
        : "新建并置顶常驻入口";
      lines.push(
        `- [x] \`[@${h.itemKey}]\` **${h.hubTitle}** — ${targetDesc}（当前该目录散落 ${h.duplicateLocalCount} 个本地工作区）`,
      );
    }
  }

  if (plan.renames.length > 0) {
    lines.push("", `### 2. 规范化重命名（共 ${plan.renames.length} 项）`);
    for (const r of plan.renames) {
      const scope =
        r.agentId && r.workspaceId
          ? `会话 \`${r.shortAgentId}\` + 工作区`
          : r.agentId
            ? `会话 \`${r.shortAgentId}\``
            : `工作区 \`${r.workspaceId}\``;
      lines.push(
        `- [x] \`[@${r.itemKey}]\` **${r.nextTitle}** ⬅ 原：「${r.previousTitle.slice(0, 42)}${r.previousTitle.length > 42 ? "…" : ""}」（${scope}）`,
      );
    }
  }

  if (plan.merges.length > 0) {
    lines.push("", `### 3. 同主题合并归档（共 ${plan.merges.length} 组）`);
    for (const m of plan.merges) {
      const secList = m.secondaries.map((s) => `\`${s.shortId}\``).join(", ");
      const wsCount = m.secondaries.filter((s) => s.archiveWorkspace).length;
      lines.push(
        `- [x] \`[@${m.itemKey}]\` **${m.topicTitle}** — 保留最新 \`${m.keeperShortId}\` 并注入前序摘要${plan.writeObsidianDigest ? " + 写入知识库" : ""}；归档旧会话 ${secList}${wsCount > 0 ? ` 及 ${wsCount} 个重复工作区` : ""}`,
      );
      for (const s of m.secondaries) {
        lines.push(`  - 合并项 \`${s.shortId}\`「${s.title}」：${s.conclusion.slice(0, 80)}`);
      }
    }
  }

  if (plan.archives.length > 0) {
    lines.push("", `### 4. 空壳与已完结闲置归档（共 ${plan.archives.length} 项）`);
    for (const a of plan.archives) {
      if (a.kind === "empty_workspace") {
        lines.push(
          `- [x] \`[@${a.itemKey}]\` 空壳工作区 \`${a.workspaceId}\`（${path.basename(a.cwd) || a.cwd} · ${a.reason}）`,
        );
      } else {
        lines.push(
          `- [x] \`[@${a.itemKey}]\` **${a.title}**（会话 \`${a.shortAgentId}\` · ${a.reason}${a.archiveWorkspace ? " · 连同单会话壳工作区归档" : ""}）`,
        );
      }
    }
  }

  return lines.join("\n");
}

export function parseApprovedItemKeysFromMarkdown(
  markdown: string,
  plan: SessionTidyPlan,
): Set<string> {
  const allKeys = [
    ...plan.hubs.map((i) => i.itemKey),
    ...plan.renames.map((i) => i.itemKey),
    ...plan.merges.map((i) => i.itemKey),
    ...plan.archives.map((i) => i.itemKey),
  ];

  // If markdown doesn't contain any [@...] markers at all, fall back to all keys
  if (!markdown.includes("[@")) {
    return new Set(allKeys);
  }

  const approved = new Set<string>();
  const checkedLineRe = /^[ \t]*[-*][ \t]+\[[xX]\][^\n]*?\[@([a-z]+_\d+)\]/gm;
  let m: RegExpExecArray | null;
  while ((m = checkedLineRe.exec(markdown)) !== null) {
    approved.add(m[1]);
  }
  return approved;
}

export function extractTidyPlanIdFromPrompt(text: string | undefined): string | null {
  if (!text) return null;
  const m = /# PASEO_BOT_TIDY_PLAN:(tidy_[A-Za-z0-9_]+)/.exec(text);
  return m ? m[1] : null;
}

function getTidyPlansDir(): string {
  return path.join(getPluginDataDir(), "tidy-plans");
}

export async function saveTidyPlan(plan: SessionTidyPlan): Promise<void> {
  const dir = getTidyPlansDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${plan.id}.json`);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(plan, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);

  // Prune old plan files beyond 30
  try {
    const entries = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
    if (entries.length > 30) {
      const toDelete = entries.slice(0, entries.length - 30);
      await Promise.all(toDelete.map((f) => fs.unlink(path.join(dir, f)).catch(() => undefined)));
    }
  } catch {
    // Ignore cleanup errors
  }
}

export async function loadTidyPlan(planId: string): Promise<SessionTidyPlan | null> {
  if (!/^tidy_[A-Za-z0-9_]+$/.test(planId)) return null;
  try {
    const raw = await fs.readFile(path.join(getTidyPlansDir(), `${planId}.json`), "utf8");
    return JSON.parse(raw) as SessionTidyPlan;
  } catch {
    return null;
  }
}

export async function executeTidyPlan(input: {
  paseo: PaseoApi;
  plan: SessionTidyPlan;
  approvedKeys?: Set<string>;
  loginPath: string;
  markSelfWrite?: (filePath: string) => void;
}): Promise<TidyExecutionSummary> {
  const { paseo, plan, loginPath } = input;
  const approved =
    input.approvedKeys ??
    new Set([
      ...plan.hubs.map((i) => i.itemKey),
      ...plan.renames.map((i) => i.itemKey),
      ...plan.merges.map((i) => i.itemKey),
      ...plan.archives.map((i) => i.itemKey),
    ]);

  const summary: TidyExecutionSummary = {
    planId: plan.id,
    pinnedHubs: 0,
    renamedCount: 0,
    mergedClusters: 0,
    archivedAgents: 0,
    archivedWorkspaces: 0,
    obsidianNotesPaths: [],
    errors: [],
  };

  // 1. Pinned Hubs
  for (const h of plan.hubs) {
    if (!approved.has(h.itemKey)) continue;
    try {
      const handle = h.existingWorkspaceId
        ? paseo.workspaces.ref(h.existingWorkspaceId)
        : await paseo.workspaces.create({
            title: h.hubTitle,
            source: { kind: "directory", path: h.cwd },
          });
      await handle.setTitle(h.hubTitle);
      await handle.setPinned(true);
      summary.pinnedHubs += 1;
    } catch (err) {
      summary.errors.push(`置顶主工作区 ${h.hubTitle} 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Renames
  await mapWithConcurrency(
    plan.renames.filter((r) => approved.has(r.itemKey)),
    4,
    async (r) => {
      let okAny = false;
      if (r.agentId) {
        const res = await renamePaseoAgentViaCli({
          agentId: r.agentId,
          title: r.nextTitle,
          labels: { "tidy.category": r.category },
          loginPath,
        });
        if (res.ok) okAny = true;
        else summary.errors.push(`重命名会话 ${r.shortAgentId} 失败: ${res.error}`);
      }
      if (r.workspaceId) {
        try {
          await paseo.workspaces.ref(r.workspaceId).setTitle(r.nextTitle);
          okAny = true;
        } catch (err) {
          summary.errors.push(
            `重命名工作区 ${r.workspaceId} 失败: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (okAny) summary.renamedCount += 1;
    },
  );

  // 3. Merges
  for (const m of plan.merges) {
    if (!approved.has(m.itemKey)) continue;
    try {
      const keeperRef = paseo.agents.ref(m.keeperAgentId);
      // Save merged context into keeper metadata so future session opens inject it automatically
      await keeperRef
        .setMetadata({
          "paseo-bot.mergedDigest": m.mergedDigestMarkdown.slice(0, 6000),
          "paseo-bot.mergedAt": new Date().toISOString(),
        })
        .catch(() => undefined);

      // Append visual timeline summary card in keeper session
      await keeperRef.timeline
        .append({
          type: "plugin",
          id: `tidy-merge-${plan.id}-${m.itemKey}`,
          kind: BOT_ALERT_TIMELINE_KIND,
          version: 1,
          data: {
            feedId: `tidy_${plan.id}_${m.itemKey}`,
            level: "notify",
            title: `已合并 ${m.secondaries.length} 条同主题历史会话`,
            summary: `前序会话结论已汇总至此（后续对话将自动携带前情背景），原重复会话已归档。`,
            details: m.mergedDigestMarkdown,
            actions: [],
            createdAt: new Date().toISOString(),
          },
        })
        .catch(() => undefined);

      // Optional Obsidian 00-Inbox digest note
      if (plan.writeObsidianDigest && plan.obsidianInboxDir) {
        try {
          await fs.mkdir(plan.obsidianInboxDir, { recursive: true });
          const dateStr = new Date().toISOString().slice(0, 10);
          const safeSlug = m.topicTitle
            .replace(/^\[[^\]]+\]\s*/u, "")
            .replace(/[\\/:*?"<>|\s]+/g, "-")
            .slice(0, 28);
          const notePath = path.join(
            plan.obsidianInboxDir,
            `会话合并-${dateStr}-${safeSlug || m.keeperShortId}.md`,
          );
          const frontmatter = [
            "---",
            `title: "${m.topicTitle.replace(/"/g, "'")} · 会话合并归档"`,
            `created: ${dateStr}`,
            `updated: ${dateStr}`,
            "type: session-digest",
            "tags:",
            "  - 会话归档",
            `  - ${m.category}`,
            `keeper_session: "${m.keeperAgentId}"`,
            "---",
            "",
            m.mergedDigestMarkdown,
            "",
          ].join("\n");
          input.markSelfWrite?.(notePath);
          await fs.writeFile(notePath, frontmatter, "utf8");
          summary.obsidianNotesPaths.push(notePath);
        } catch {
          // Non-fatal if KnowledgeBase folder does not exist
        }
      }

      // Archive secondary sessions & redundant shell workspaces
      for (const sec of m.secondaries) {
        if (sec.archiveWorkspace && sec.workspaceId) {
          const wsArc = await paseo.workspaces.ref(sec.workspaceId).archive().catch(() => null);
          if (wsArc && !wsArc.error) {
            summary.archivedWorkspaces += 1;
            summary.archivedAgents += 1;
            continue;
          }
        }
        await paseo.agents.ref(sec.agentId).archive().catch(() => undefined);
        summary.archivedAgents += 1;
      }

      summary.mergedClusters += 1;
    } catch (err) {
      summary.errors.push(
        `合并主题 ${m.topicTitle} 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 4. Stale & Empty Archives
  await mapWithConcurrency(
    plan.archives.filter((a) => approved.has(a.itemKey)),
    4,
    async (a) => {
      try {
        if (a.kind === "empty_workspace" && a.workspaceId) {
          const res = await paseo.workspaces.ref(a.workspaceId).archive();
          if (!res.error) summary.archivedWorkspaces += 1;
          else summary.errors.push(`归档空工作区 ${a.workspaceId} 失败: ${res.error}`);
          return;
        }
        if (a.archiveWorkspace && a.workspaceId) {
          const res = await paseo.workspaces.ref(a.workspaceId).archive();
          if (!res.error) {
            summary.archivedWorkspaces += 1;
            if (a.agentId) summary.archivedAgents += 1;
            return;
          }
        }
        if (a.agentId) {
          await paseo.agents.ref(a.agentId).archive();
          summary.archivedAgents += 1;
        }
      } catch (err) {
        summary.errors.push(
          `归档 ${a.title} 失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  return summary;
}
