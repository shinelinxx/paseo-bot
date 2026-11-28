import type {
  CatalogModel,
  ChatInlineLink,
  ChatMessage,
  FeedItem,
  RoutingTier,
  WishImageAttachment,
} from "../shared/contracts";
import { DEFAULT_BOT_SETTINGS, type BotSettings } from "../shared/settings.ts";
import {
  cleanTaskTitle,
  extractMemoryWorkspaceHints,
  hasDirectSessionReferenceHint,
  routeDirectWishToSession,
  type FollowUpRouteDecision,
  type RoutableAgentCandidate,
} from "./intent.ts";

export type RoutingReason =
  | "explicit_override"
  | "direct_session_route"
  | "local_control_command"
  | "image_attachment"
  | "memory_or_mute_reply"
  | "casual_chat_or_qa"
  | "tool_or_workspace_action"
  | "deep_analysis_request";

export interface RoutingDecision {
  tier: RoutingTier;
  reason: RoutingReason;
  immediateAckText?: string;
  localCommand?: "pause" | "resume" | "tidy_preview" | "tidy_apply";
  matchedTriggerId?: string;
  matchedTriggerName?: string;
  directSessionRoute?: FollowUpRouteDecision;
}

export interface ClassifyMessageInput {
  text: string;
  images?:
    | readonly Pick<WishImageAttachment, "mimeType" | "name">[]
    | readonly WishImageAttachment[];
  forceTier?: "L1" | "L2" | "L3";
  providerOverride?: string;
  settings?: Partial<
    Pick<
      BotSettings,
      | "fastProvider"
      | "fastFallbackProvider"
      | "execProvider"
      | "deepProvider"
      | "homeCwd"
    >
  >;
  routableCandidates?: readonly RoutableAgentCandidate[];
  knownWorkspaces?: readonly { cwd: string; label: string }[];
  memoryContent?: string;
  recentMessages?: readonly Pick<
    ChatMessage,
    "id" | "role" | "kind" | "text" | "triggerId" | "triggerName" | "createdAt"
  >[];
  replyToMessageId?: string;
}

export interface CatalogProviderAvailability {
  id: string;
  available?: boolean;
  defaultModel?: string | null;
  models: readonly Pick<CatalogModel, "id" | "isDefault">[];
}

export interface TierProviderResolution {
  tier: "L1" | "L2" | "L3";
  primaryProvider: string;
  chosenProvider: string;
  candidateChain: string[];
  thinkingOptionId: string;
  preferredModeId: string;
  degraded: boolean;
}

const LOCAL_PAUSE_RE =
  /^(?:\/pause|暂停全部后台规则|暂停后台规则|暂停自动规则|暂停所有规则)$/iu;
const LOCAL_RESUME_RE =
  /^(?:\/resume|恢复后台规则|恢复全部后台规则|恢复自动规则|开启后台规则)$/iu;
const LOCAL_TIDY_RE = /^\/tidy(?:\s+(preview|apply|now))?$/iu;

const MEMORY_OR_MUTE_SIGNAL_RE =
  /(?:停用了|不用赎回|不用提醒|别再提醒|不再提醒|换[成成了]|我换\s*[A-Za-z0-9_.-]+\s*了|改用|以后按|记住|帮我记一下|忽略.*提醒|静音)/iu;
const PROFILE_RENAME_SIGNAL_RE =
  /(?:叫你|给你取名|给你起名|你以后叫|以后你就叫|以后叫我|平时叫我|称呼我)/iu;

const DEEP_ANALYSIS_EXPLICIT_RE =
  /(?:深度分析|详细规划|架构设计|重构方案|全面审计|对比评估多个方案|多方案权衡|写一份完整.*报告|系统性排查|deep\s*dive|architecture\s*design|\brfc\b)/iu;
const DEEP_ANALYSIS_LONG_INTENT_RE =
  /(?:分析|对比|方案|规划|设计|评估|架构|重构|权衡|推演|audit|analyze|compare|design|architecture|plan|trade-?off)/iu;

const EXPLICIT_PATH_URL_CMD_RE = /(?:~\/|\/Users\/|\/home\/|https?:\/\/|`[^`]{3,}`)/iu;
const TOOL_OR_ACTION_SIGNAL_RE =
  /(?:查一下|帮我查|查一查|核实|检查.*邮箱|看下.*邮件|查.*邮件|cloudflare|tunnel|\bssh\b|服务器|部署|更新.*代码|修复.*bug|跑一下测试|运行测试|整理收件箱|00-inbox|创建.*定时|新建.*规则|每天.*点|每隔?\s*\d+\s*(?:分钟|小时)|监听.*目录|webhook|子任务|工作区进度|汇总.*进度|生成今日汇总|整理工作区|整理会话|\bgithub\b|\bpr\b|\bcommit\b|git\s+(?:status|diff|log))/iu;
const WORKSPACE_EXEC_VERB_RE =
  /(?:检查|查看|看下|看看|整理|归档|修复|修改|更新|跑|运行|执行|同步|汇总|核对|排查|优化|清理|统计|报单|订单|草稿|派给|交给|委派|转交|派发|交由|分派|安排|推进|开发|实现|新增|增加|支持|加上|插个|处理|跟进|接入|重构|改造|调研|盘点|分析|评估|check|inspect|fix|update|run|sync|delegate|dispatch|assign|handoff|implement|add|build)/iu;

const EXPLICIT_COMPANY_HANDOFF_RE =
  /(?:派给|交给|委派|转交|派发|交由|分派给?|(?:让|请|叫|找)\s*[^\n，,。]{1,24}?(?:总控|总舵|公司|工作室))/iu;

const PERSONAL_BUTLER_CHANNEL_SIGNAL_RE =
  /(?:查.*邮件|看下.*邮件|检查.*邮箱|gmail|qq\s*邮箱|(?:创建|新建|设置|设个|添加|修改|暂停|恢复|删除|停用)[^\n，,。]{0,16}(?:定时|计划|规则|监听|webhook|trigger))/iu;

/**
 * Decide whether an actionable workspace message should be handed directly to the
 * target project's resident Company Coordinator (`总控`) instead of running Paseo Bot's
 * own personal-channel L2 executor first.
 */
export function shouldPreferDirectCoordinatorHandoff(text: string): boolean {
  const clean = (text ?? "").trim();
  if (!clean) return false;
  if (EXPLICIT_COMPANY_HANDOFF_RE.test(clean)) {
    return true;
  }
  if (PERSONAL_BUTLER_CHANNEL_SIGNAL_RE.test(clean)) {
    return false;
  }
  return true;
}

export function isDeepAnalysisSignal(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  if (DEEP_ANALYSIS_EXPLICIT_RE.test(clean)) return true;
  if (clean.length >= 600 && DEEP_ANALYSIS_LONG_INTENT_RE.test(clean)) return true;
  return false;
}

export function buildImmediateAckText(
  tier: "L2" | "L3",
  text: string,
  hasImages = false,
): string {
  const clean = text.trim();
  if (tier === "L3") {
    return "我先开启深度思考仔细梳理一下，理清方案后马上发你。";
  }
  if (hasImages && !clean) {
    return "我先仔细看一下你发来的图片，稍等片刻。";
  }
  if (hasImages) {
    return "我先结合图片帮你核对一下，稍等片刻。";
  }
  if (/cloudflare|tunnel/i.test(clean)) {
    return "我先帮你查一下 Cloudflare Tunnel 的当前状态与本机配置，稍等片刻。";
  }
  if (/邮箱|邮件|gmail|email/i.test(clean)) {
    return "我先帮你查一下相关邮件记录，核实后马上告诉你。";
  }
  if (/00-inbox|收件箱草稿|知识库/i.test(clean)) {
    return "我先去检查一下知识库收件箱的最新内容，稍等片刻。";
  }
  if (/今日汇总|工作区进度|子任务/i.test(clean)) {
    return "我先帮你盘点一下当前各工作区与后台任务的进展，马上汇总给你。";
  }
  if (/(?:性能优化|优化|重构|修改|修复|开发|实现|升级|清理|排查)/u.test(clean)) {
    return "收到，我已经在后台开始排查处理了，处理完第一时间向你汇报。";
  }
  return "我先帮你核查一下，确认清楚后马上回复你。";
}

function findRecentTriggerContext(
  recentMessages?: ClassifyMessageInput["recentMessages"],
  replyToMessageId?: string,
): { triggerId?: string; triggerName?: string } {
  if (!recentMessages || recentMessages.length === 0) return {};
  if (replyToMessageId) {
    const direct = recentMessages.find((m) => m.id === replyToMessageId);
    if (direct?.triggerId || direct?.triggerName) {
      return { triggerId: direct.triggerId, triggerName: direct.triggerName };
    }
  }
  for (let i = recentMessages.length - 1; i >= 0; i -= 1) {
    const msg = recentMessages[i];
    if (msg.triggerId || msg.triggerName) {
      return { triggerId: msg.triggerId, triggerName: msg.triggerName };
    }
  }
  return {};
}

function matchesWorkspaceWithActionIntent(
  cleanText: string,
  knownWorkspaces: readonly { cwd: string; label: string }[] = [],
  memoryContent = "",
): boolean {
  if (!WORKSPACE_EXEC_VERB_RE.test(cleanText)) return false;
  const lower = cleanText.toLowerCase();

  for (const ws of knownWorkspaces) {
    const label = ws.label.trim().toLowerCase();
    const base = ws.cwd.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    if (
      label.length >= 3 &&
      label !== "knowledgebase" &&
      label !== "general" &&
      lower.includes(label)
    ) {
      return true;
    }
    if (
      base.length >= 3 &&
      base !== "knowledgebase" &&
      base !== "general" &&
      lower.includes(base)
    ) {
      return true;
    }
  }

  if (memoryContent.trim()) {
    const hints = extractMemoryWorkspaceHints(memoryContent);
    for (const hint of hints) {
      if (hint.label.length >= 2 && lower.includes(hint.label.toLowerCase())) {
        return true;
      }
      for (const kw of hint.keywords) {
        if (kw.length >= 2 && lower.includes(kw.toLowerCase())) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Deterministic L0 8-priority message classifier (0 tokens, < 1ms).
 */
export function classifyMessageTier(input: ClassifyMessageInput): RoutingDecision {
  const cleanText = (input.text ?? "").trim();
  const hasImages = Boolean(input.images && input.images.length > 0);
  const fastProvider = input.settings?.fastProvider ?? DEFAULT_BOT_SETTINGS.fastProvider;
  const fastFallbackProvider =
    input.settings?.fastFallbackProvider ?? DEFAULT_BOT_SETTINGS.fastFallbackProvider;
  const deepProvider = input.settings?.deepProvider ?? DEFAULT_BOT_SETTINGS.deepProvider;

  // 1. Explicit override (forceTier or providerOverride)
  if (input.forceTier) {
    const tier = input.forceTier;
    return {
      tier,
      reason: "explicit_override",
      immediateAckText:
        tier === "L1" ? undefined : buildImmediateAckText(tier, cleanText, hasImages),
    };
  }
  const cleanOverride = input.providerOverride?.trim();
  if (cleanOverride) {
    const lowerOverride = cleanOverride.toLowerCase();
    let tier: "L1" | "L2" | "L3" = "L2";
    if (lowerOverride === deepProvider.trim().toLowerCase()) {
      tier = "L3";
    } else if (
      lowerOverride === fastProvider.trim().toLowerCase() ||
      lowerOverride === fastFallbackProvider.trim().toLowerCase() ||
      lowerOverride === DEFAULT_BOT_SETTINGS.fastProvider.toLowerCase()
    ) {
      tier = "L1";
    }
    return {
      tier,
      reason: "explicit_override",
      immediateAckText:
        tier === "L1" ? undefined : buildImmediateAckText(tier, cleanText, hasImages),
    };
  }

  // 2. Pure local control commands (L0, 0 Token)
  if (!hasImages && cleanText) {
    if (LOCAL_PAUSE_RE.test(cleanText)) {
      return {
        tier: "L0",
        reason: "local_control_command",
        localCommand: "pause",
      };
    }
    if (LOCAL_RESUME_RE.test(cleanText)) {
      return {
        tier: "L0",
        reason: "local_control_command",
        localCommand: "resume",
      };
    }
    const tidyMatch = LOCAL_TIDY_RE.exec(cleanText);
    if (tidyMatch) {
      const modeArg = (tidyMatch[1] ?? "").toLowerCase();
      return {
        tier: "L0",
        reason: "local_control_command",
        localCommand: modeArg === "apply" || modeArg === "now" ? "tidy_apply" : "tidy_preview",
      };
    }
  }

  // 3. Explicit existing session continuation (direct_session_route)
  if (cleanText && hasDirectSessionReferenceHint(cleanText)) {
    const directRoute = routeDirectWishToSession({
      wish: cleanText,
      candidates: input.routableCandidates ?? [],
    });
    if (directRoute) {
      return {
        tier: "L0",
        reason: "direct_session_route",
        directSessionRoute: directRoute,
      };
    }
  }

  // 4. Image attachments -> at least L2 (or L3 when combined with deep analysis request)
  if (hasImages) {
    const tier: "L2" | "L3" = isDeepAnalysisSignal(cleanText) ? "L3" : "L2";
    return {
      tier,
      reason: "image_attachment",
      immediateAckText: buildImmediateAckText(tier, cleanText, true),
    };
  }

  // 5. One-sentence memory update / mute old reminder / rename butler or user -> L1
  if (
    cleanText &&
    !isDeepAnalysisSignal(cleanText) &&
    (MEMORY_OR_MUTE_SIGNAL_RE.test(cleanText) || PROFILE_RENAME_SIGNAL_RE.test(cleanText))
  ) {
    const triggerCtx = findRecentTriggerContext(
      input.recentMessages,
      input.replyToMessageId,
    );
    return {
      tier: "L1",
      reason: "memory_or_mute_reply",
      matchedTriggerId: triggerCtx.triggerId,
      matchedTriggerName: triggerCtx.triggerName,
    };
  }

  // 6. Deep complex analysis & architectural planning -> L3
  if (isDeepAnalysisSignal(cleanText)) {
    return {
      tier: "L3",
      reason: "deep_analysis_request",
      immediateAckText: buildImmediateAckText("L3", cleanText),
    };
  }

  // 7. Tool verification / workspace action / delegation -> L2
  if (
    cleanText &&
    (EXPLICIT_PATH_URL_CMD_RE.test(cleanText) ||
      TOOL_OR_ACTION_SIGNAL_RE.test(cleanText) ||
      matchesWorkspaceWithActionIntent(
        cleanText,
        input.knownWorkspaces,
        input.memoryContent,
      ))
  ) {
    return {
      tier: "L2",
      reason: "tool_or_workspace_action",
      immediateAckText: buildImmediateAckText("L2", cleanText),
    };
  }

  // 8. Default fallback: greetings, short Q&A, casual chat, ambiguous short intents -> L1
  return {
    tier: "L1",
    reason: "casual_chat_or_qa",
  };
}

function dedupeNonEmpty(items: readonly (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const clean = (raw ?? "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function resolveCandidateAgainstCatalog(
  candidate: string,
  catalog: readonly CatalogProviderAvailability[],
): string | null {
  const [provId, modelId] = candidate.includes("/")
    ? candidate.split("/", 2)
    : [candidate, ""];
  const matchedProv = catalog.find(
    (p) => p.id === provId && p.available !== false && p.models.length > 0,
  );
  if (!matchedProv) return null;
  if (modelId) {
    const hasExact = matchedProv.models.some((m) => m.id === modelId);
    return hasExact ? `${matchedProv.id}/${modelId}` : null;
  }
  const fallbackModel =
    matchedProv.defaultModel ??
    matchedProv.models.find((m) => m.isDefault)?.id ??
    matchedProv.models[0]?.id;
  return fallbackModel ? `${matchedProv.id}/${fallbackModel}` : null;
}

/**
 * Resolve tier provider candidate chain, fallback selection, and thinkingOptionId.
 */
export function resolveTierProviderChain(
  tier: "L1" | "L2" | "L3",
  settings: Partial<BotSettings> = {},
  catalogProviders: readonly CatalogProviderAvailability[] = [],
  opts?: { isDelegatedWorker?: boolean; providerOverride?: string },
): TierProviderResolution {
  const merged: BotSettings = { ...DEFAULT_BOT_SETTINGS, ...settings };
  const availableCatalog = catalogProviders.filter(
    (p) => p.available !== false && p.models.length > 0,
  );
  const firstCatalogPair = (() => {
    const first = availableCatalog[0];
    if (!first) return undefined;
    const model =
      first.defaultModel ??
      first.models.find((m) => m.isDefault)?.id ??
      first.models[0]?.id;
    return model ? `${first.id}/${model}` : undefined;
  })();

  const override = opts?.providerOverride?.trim();
  let primaryProvider: string;
  let rawChain: Array<string | undefined>;
  let thinkingOptionId: string;
  let preferredModeId: string;

  if (tier === "L1") {
    primaryProvider = override || merged.fastProvider;
    rawChain = [
      override,
      merged.fastProvider,
      merged.fastFallbackProvider,
      merged.execProvider,
      firstCatalogPair,
    ];
    thinkingOptionId = merged.fastThinking || "low";
    preferredModeId = "auto";
  } else if (tier === "L2") {
    primaryProvider = override || merged.execProvider;
    rawChain = [
      override,
      merged.execProvider,
      merged.deepProvider,
      merged.fastFallbackProvider,
      firstCatalogPair,
    ];
    thinkingOptionId = opts?.isDelegatedWorker
      ? "high"
      : merged.execThinking || "medium";
    preferredModeId = merged.chiefModeId || "auto";
  } else {
    primaryProvider = override || merged.deepProvider;
    rawChain = [
      override,
      merged.deepProvider,
      merged.execProvider,
      merged.fastFallbackProvider,
      firstCatalogPair,
    ];
    thinkingOptionId = merged.deepThinking || "high";
    preferredModeId = merged.chiefModeId || "auto";
  }

  const candidateChain = dedupeNonEmpty(rawChain);
  if (availableCatalog.length === 0) {
    const chosen = candidateChain[0] ?? primaryProvider;
    return {
      tier,
      primaryProvider,
      chosenProvider: chosen,
      candidateChain,
      thinkingOptionId,
      preferredModeId,
      degraded: chosen !== primaryProvider,
    };
  }

  let chosenProvider: string | null = null;
  for (const cand of candidateChain) {
    const resolved = resolveCandidateAgainstCatalog(cand, availableCatalog);
    if (resolved) {
      chosenProvider = resolved;
      break;
    }
  }

  const finalProvider = chosenProvider ?? firstCatalogPair ?? primaryProvider;
  const degraded = finalProvider !== primaryProvider;
  // Per spec §5: when L3 degrades to execProvider, keep thinkingOptionId = "high"
  const finalThinking =
    tier === "L3" && degraded ? "high" : thinkingOptionId;

  return {
    tier,
    primaryProvider,
    chosenProvider: finalProvider,
    candidateChain,
    thinkingOptionId: finalThinking,
    preferredModeId,
    degraded,
  };
}

export function extractAgentModelPair(agent: unknown): string | undefined {
  if (!agent || typeof agent !== "object") return undefined;
  const rec = agent as Record<string, unknown>;
  const runtime =
    rec.runtimeInfo && typeof rec.runtimeInfo === "object"
      ? (rec.runtimeInfo as Record<string, unknown>)
      : undefined;
  const prov =
    (typeof rec.provider === "string" && rec.provider.trim()) ||
    (typeof runtime?.provider === "string" && runtime.provider.trim()) ||
    "";
  const model =
    (typeof rec.model === "string" && rec.model.trim()) ||
    (typeof runtime?.model === "string" && runtime.model.trim()) ||
    "";
  if (prov && model) return `${prov}/${model}`;
  return prov || model || undefined;
}

function extractAgentThinkingOptionId(agent: unknown): string | undefined {
  if (!agent || typeof agent !== "object") return undefined;
  const rec = agent as Record<string, unknown>;
  const runtime =
    rec.runtimeInfo && typeof rec.runtimeInfo === "object"
      ? (rec.runtimeInfo as Record<string, unknown>)
      : undefined;
  const raw =
    (typeof rec.thinkingOptionId === "string" && rec.thinkingOptionId.trim()) ||
    (typeof rec.effectiveThinkingOptionId === "string" &&
      rec.effectiveThinkingOptionId.trim()) ||
    (typeof runtime?.thinkingOptionId === "string" && runtime.thinkingOptionId.trim()) ||
    "";
  return raw || undefined;
}

function normalizeComparableCwd(raw: string): string {
  const clean = raw.trim().replace(/\\/g, "/");
  return clean.length > 1 ? clean.replace(/\/+$/, "") : clean;
}

export interface ExpectedAgentConfigMatch {
  providerModel: string;
  allowedFallbackModel?: string;
  thinkingOptionId?: string;
  cwd?: string;
}

/**
 * Verify whether an existing reusable session (e.g. warm L1 or shared Chief)
 * still matches the latest configured provider/model, thinking level, and cwd.
 */
export function doesAgentMatchExpectedConfig(
  agent: unknown,
  expected: ExpectedAgentConfigMatch,
): boolean {
  const expectedPair = (expected.providerModel ?? "").trim();
  if (!expectedPair) return true;

  const actualPair = extractAgentModelPair(agent);
  if (!actualPair) return false;
  const actualPairLower = actualPair.toLowerCase();

  const matchesPair = (target: string): boolean => {
    const cleanTarget = target.trim().toLowerCase();
    if (!cleanTarget) return false;
    if (cleanTarget.includes("/")) {
      return actualPairLower === cleanTarget;
    }
    const actualProv = actualPairLower.includes("/")
      ? actualPairLower.split("/", 2)[0]
      : actualPairLower;
    return actualProv === cleanTarget;
  };

  const modelMatches =
    matchesPair(expectedPair) ||
    Boolean(expected.allowedFallbackModel && matchesPair(expected.allowedFallbackModel));
  if (!modelMatches) return false;

  const expectedThinking = expected.thinkingOptionId?.trim().toLowerCase();
  const actualThinking = extractAgentThinkingOptionId(agent)?.toLowerCase();
  if (expectedThinking && actualThinking && actualThinking !== expectedThinking) {
    return false;
  }

  const expectedCwd = expected.cwd?.trim();
  const rec = agent && typeof agent === "object" ? (agent as Record<string, unknown>) : undefined;
  const actualCwd = typeof rec?.cwd === "string" ? rec.cwd.trim() : "";
  if (
    expectedCwd &&
    actualCwd &&
    normalizeComparableCwd(actualCwd) !== normalizeComparableCwd(expectedCwd)
  ) {
    return false;
  }

  return true;
}

export function extractInlineLinksFromMarkdown(markdown: string): ChatInlineLink[] {
  if (!markdown) return [];
  const out: ChatInlineLink[] = [];
  const seen = new Set<string>();
  const re = /\[([^\]\n]{1,80})\]\(((?:https?:\/\/|paseo:\/\/agent\/|file:\/\/)[^\s)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const label = match[1].trim();
    const url = match[2].trim();
    if (!label || !url || seen.has(url)) continue;
    seen.add(url);
    const kind: ChatInlineLink["kind"] = url.startsWith("paseo://agent/")
      ? "agent"
      : url.startsWith("file://")
        ? "file"
        : "external";
    out.push({ label, url, kind });
    if (out.length >= 6) break;
  }
  return out;
}

const PLACEHOLDER_REPLY_RE =
  /^(?:处理完成|已完成|已为你处理完毕|完成|好的|收到|done|ok|completed|（无文本记录）|\(no\s+text\))[。！!.\s]*$/iu;

const STANDBY_ACK_NOISE_RE = /已就位[，,\s]*静默待命[。！!.\s]*$/u;

const RELEASE_OR_MILESTONE_SIGNAL_RE =
  /(?:\bRELEASED\b|已发版|发版完成|正式发版|完成发版|版本发布|已发布|正式发布|已上线|正式上线|里程碑[^\n。]{0,18}(?:闭环|达成|收官|完成|交付)|已推送[^\n。]{0,24}\bmain\b|pushed\s+to\s+(?:origin\/)?main|(?:发布|上线|发版|release|shipped)\s*[：:·\s]*v\d+\.\d+(?:\.\d+)?|\bv\d+\.\d+(?:\.\d+)?(?![-\w]*baseline)\s*(?:版本)?\s*(?:已发版|已发布|已上线|正式发布|正式上线|发版|发布|上线|released|shipped))/iu;

const COMPANY_TITLE_OR_ROLE_RE =
  /(?:管家总舵|分流引擎部|气泡前端部|拟人调优部|质检验收部|(?:研发|前端|后端|测试|产品|设计|量化|风控|运维|总控|架构|调优|验收)部|总办|\bCEO\b|\bCTO\b|\bQA\b)/u;

const COMPANY_INTERMEDIATE_CONTENT_RE =
  /(?:\[(?:DISPATCH|HANDOFF|GATE|HEARTBEAT|ESCALATE|BOARD DIRECTIVE)\]|READY_FOR_GATE|原子工单派发|工单交付|质量与风控门禁|正在(?:派工|自测|排查|审阅|修复)|(?:派工|自测|排查|审阅)中)/iu;

const COORDINATOR_DISPATCH_ACK_ONLY_RE =
  /(?:\[(?:DISPATCH|HANDOFF|GATE|HEARTBEAT|BOARD DIRECTIVE)\]|READY_FOR_GATE|原子工单派发|工单交付|质量与风控门禁|正在(?:派工|自测|排查|审阅|修复)|(?:派工|自测|排查|审阅)中|已(?:立项|拆单|拆解|派单|派发|指派)[^\n。]{0,36}(?:部|组|岗|操作员|执行|跟进|处理)|正在等待[^\n。]{0,24}(?:部|组|岗)|待[^\n。]{0,24}(?:门禁|验收|质控|红队)[^\n。]{0,16}汇报)/iu;

const GENERIC_SECTION_HEADING_RE =
  /^(?:总结|小结|概述|核心结论|结论|执行结果|处理结果|发版说明|发布说明|更新内容|变更摘要|summary|overview|conclusion|result|release\s+notes?)[：:\s]*$/iu;

export function isPlaceholderWorkerReply(rawText: string | undefined | null): boolean {
  const clean = (rawText ?? "")
    .replace(/[*`~_>#]/g, "")
    .trim();
  if (!clean) return true;
  if (PLACEHOLDER_REPLY_RE.test(clean)) return true;
  if (clean.length <= 48 && STANDBY_ACK_NOISE_RE.test(clean)) return true;
  return false;
}

export function hasReleaseOrMilestoneSignal(text: string, title = ""): boolean {
  const combined = `${title}\n${text}`;
  return RELEASE_OR_MILESTONE_SIGNAL_RE.test(combined);
}

export interface WorkerTurnStreamInput {
  text: string;
  title?: string;
  outcomeKind: "completed" | "failed";
  labels?: Record<string, string>;
  isRepeatInteractiveTurn?: boolean;
  workerId?: string;
  pendingCoordinatorReport?: boolean;
}

export interface WorkerTurnStreamEvaluation {
  shouldSync: boolean;
  reason:
    | "failed_outcome"
    | "empty_or_placeholder"
    | "release_or_milestone"
    | "coordinator_completion"
    | "company_intermediate_turn"
    | "repeat_interactive_turn"
    | "delegated_first_completion"
    | "first_wish_completion";
}

/**
 * ADR-004 noise gate for `agent.turn.after` & historical feed projection:
 * - Drops empty/placeholder completions ("处理完成。"), AI company intermediate choreography,
 *   and repeat chat turns inside interactive sessions.
 * - Passes through release/ship/milestone conclusions, failures, explicit coordinator
 *   handoff completions (skipping Turn-1 dispatch acks), and first-time delegated worker completions.
 */
export function evaluateWorkerTurnForStream(
  input: WorkerTurnStreamInput,
): WorkerTurnStreamEvaluation {
  if (input.outcomeKind === "failed") {
    return { shouldSync: true, reason: "failed_outcome" };
  }

  const rawText = (input.text ?? "").trim();
  if (isPlaceholderWorkerReply(rawText)) {
    return { shouldSync: false, reason: "empty_or_placeholder" };
  }

  const title = (input.title ?? "").trim();
  const isRelease = hasReleaseOrMilestoneSignal(rawText, title);

  if (input.pendingCoordinatorReport) {
    if (isRelease) {
      return { shouldSync: true, reason: "release_or_milestone" };
    }
    if (COORDINATOR_DISPATCH_ACK_ONLY_RE.test(rawText)) {
      return { shouldSync: false, reason: "company_intermediate_turn" };
    }
    return { shouldSync: true, reason: "coordinator_completion" };
  }

  const labels = input.labels ?? {};
  const hasCompanyLabel = Boolean(
    labels.company ||
      labels.dept ||
      labels["company.role"] ||
      labels["paseo-company/dept"] ||
      labels["paseo-company/role"],
  );
  const isCompanyOrIntermediate =
    hasCompanyLabel ||
    COMPANY_TITLE_OR_ROLE_RE.test(title) ||
    COMPANY_INTERMEDIATE_CONTENT_RE.test(rawText) ||
    COMPANY_INTERMEDIATE_CONTENT_RE.test(title);

  if (isCompanyOrIntermediate) {
    if (isRelease) {
      return { shouldSync: true, reason: "release_or_milestone" };
    }
    return { shouldSync: false, reason: "company_intermediate_turn" };
  }

  if (input.isRepeatInteractiveTurn) {
    if (isRelease) {
      return { shouldSync: true, reason: "release_or_milestone" };
    }
    return { shouldSync: false, reason: "repeat_interactive_turn" };
  }

  if (isRelease) {
    return { shouldSync: true, reason: "release_or_milestone" };
  }

  if (input.workerId?.startsWith("wrk_")) {
    return { shouldSync: true, reason: "delegated_first_completion" };
  }

  return { shouldSync: true, reason: "first_wish_completion" };
}

function truncateSafeMarkdown(text: string, maxChars: number): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  // Avoid slicing inside an inline Markdown link `[label](url)`
  const linkRe = /\[[^\]\n]+\]\([^\s)]+\)/g;
  let safeCut = maxChars - 1;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(clean)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (start < safeCut && end > safeCut) {
      safeCut = start > 24 ? start : safeCut;
      break;
    }
  }
  return `${clean.slice(0, Math.max(1, safeCut)).trimEnd()}…`;
}

/**
 * Condense verbose multi-section dev/release reports into a 1–3 sentence conclusion-first
 * short bubble (`<= maxChars`), preserving the full original markdown in `details`.
 */
export function buildConclusionSummary(
  rawText: string,
  title?: string,
  maxChars = 220,
): { text: string; details?: string } {
  const full = (rawText ?? "").trim().slice(0, 12_000);
  const cleanHeadingTitle = cleanTaskTitle(title ?? "");
  if (!full) {
    return { text: cleanHeadingTitle || "已处理完毕。" };
  }

  const hadCodeOrTable = /```|\n\|[^\n]+\|\n\|[-:\s|]+\|/m.test(full);

  // Strip code blocks, markdown tables, horizontal rules, and mechanical prefixes
  const stripped = full
    .replace(/```[\s\S]*?```/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^---+$|^\*\*\*+$/.test(line)) return false;
      if (line.startsWith("|") && line.endsWith("|")) return false;
      if (/^#\s*PASEO_BOT_TIDY_PLAN:/i.test(line)) return false;
      return true;
    })
    .map((line) => {
      const noHeading = line.replace(/^#{1,6}\s+/, "").trim();
      if (GENERIC_SECTION_HEADING_RE.test(noHeading)) return "";
      return noHeading
        .replace(/^(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, "")
        .replace(
          /^(?:【(?:告警|提醒|系统通知|发版通知)】\s*|(?:已完成|子任务已完成|正在处理)\s*[：:·]\s*(?:任务\s*[·：:]\s*)?)/u,
          "",
        )
        .trim();
    })
    .filter(Boolean);

  if (stripped.length === 0) {
    const fallback = truncateSafeMarkdown(cleanHeadingTitle || full, maxChars);
    return {
      text: fallback,
      details: full.length > fallback.length ? full : undefined,
    };
  }

  // Prioritize a release/conclusion line first if line 0 is just metadata, while keeping natural flow
  const releaseLineIdx = stripped.findIndex((l) => RELEASE_OR_MILESTONE_SIGNAL_RE.test(l));
  const orderedLines =
    releaseLineIdx > 0 && releaseLineIdx <= 3
      ? [stripped[releaseLineIdx], ...stripped.filter((_, i) => i !== releaseLineIdx)]
      : stripped;

  const sentences: string[] = [];
  for (const line of orderedLines) {
    const parts = line
      .split(/(?<=[。！？!?；;])\s+/u)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const part of parts) {
      sentences.push(part);
      if (sentences.length >= 4) break;
    }
    if (sentences.length >= 4) break;
  }

  let acc = "";
  let count = 0;
  for (const seg of sentences) {
    const normalizedSeg = /[。！？!?…`*_)\]]$/u.test(seg) ? seg : `${seg}。`;
    const candidate = acc ? `${acc} ${normalizedSeg}` : normalizedSeg;
    if (count === 0) {
      acc = truncateSafeMarkdown(candidate, maxChars);
      count = 1;
      if (acc.length >= maxChars - 12) break;
    } else if (candidate.length <= maxChars && count < 3) {
      acc = candidate;
      count += 1;
    } else {
      break;
    }
  }

  const finalSummary = truncateSafeMarkdown(acc || orderedLines[0], maxChars);
  const needsDetails =
    hadCodeOrTable ||
    stripped.length > count ||
    full.length > finalSummary.length + 24;

  return {
    text: finalSummary,
    ...(needsDetails ? { details: full } : {}),
  };
}

export function buildAgentJumpLink(agentId: string, title?: string): ChatInlineLink {
  const shortTitle = cleanTaskTitle(title ?? "")
    .replace(/^\[[^\]]+\]\s*/u, "")
    .trim()
    .slice(0, 16);
  return {
    label: shortTitle ? `查看原会话 · ${shortTitle}` : "查看原会话",
    url: `paseo://agent/${agentId}`,
    kind: "agent",
  };
}

export function ensureAgentJumpLink(
  links: readonly ChatInlineLink[],
  agentId: string | undefined,
  title?: string,
): ChatInlineLink[] {
  const out = [...links];
  if (!agentId || !agentId.trim()) return out;
  const targetUrl = `paseo://agent/${agentId.trim()}`;
  if (!out.some((l) => l.url === targetUrl)) {
    out.push(buildAgentJumpLink(agentId.trim(), title));
  }
  return out.slice(0, 6);
}

/**
 * Losslessly project up to `limit` most recent non-silent, non-noise legacy FeedItems
 * into ascending ChatMessages with conclusion-first summaries and origin session links.
 */
export function projectLegacyFeedToMessages(
  feed: readonly FeedItem[],
  limit = 20,
): ChatMessage[] {
  if (!Array.isArray(feed) || feed.length === 0 || limit <= 0) return [];

  const meaningful = feed
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => {
      if (!item || item.level === "silent") return false;
      if (
        item.level === "approval_required" ||
        item.level === "error" ||
        (item.level === "wish" && item.inProgress)
      ) {
        return true;
      }
      if (isPlaceholderWorkerReply(item.summary)) {
        return false;
      }
      if (
        item.level === "worker_update" ||
        COMPANY_INTERMEDIATE_CONTENT_RE.test(item.summary ?? "") ||
        COMPANY_TITLE_OR_ROLE_RE.test(item.title ?? "")
      ) {
        const evalRes = evaluateWorkerTurnForStream({
          text: item.summary ?? "",
          title: item.title,
          outcomeKind: "completed",
        });
        return evalRes.shouldSync;
      }
      return true;
    });
  if (meaningful.length === 0) return [];

  // Sort chronologically ascending (oldest first, newest last)
  meaningful.sort((a, b) => {
    const tsA = Date.parse(a.item.createdAt);
    const tsB = Date.parse(b.item.createdAt);
    const validA = Number.isFinite(tsA);
    const validB = Number.isFinite(tsB);
    if (validA && validB && tsA !== tsB) return tsA - tsB;
    // In legacy `feed`, index 0 was newest (`unshift`), so higher idx is older
    return b.idx - a.idx;
  });

  const recentSlice = meaningful.slice(-limit);
  return recentSlice.map(({ item }) => {
    const summaryText = (item.summary ?? "").trim();
    const cleanHeadline = cleanTaskTitle(item.title || "");
    const rawLinks = extractInlineLinksFromMarkdown(
      `${summaryText}\n${item.details ?? ""}`,
    );

    if (item.level === "approval_required" || (item.approvalId && item.title.startsWith("待确认"))) {
      return {
        id: `msg_legacy_${item.id}`,
        createdAt: item.createdAt,
        role: "assistant",
        kind: "approval",
        text: summaryText || cleanHeadline || "待确认操作",
        details: item.details,
        images: [],
        links: ensureAgentJumpLink(rawLinks, item.agentId, cleanHeadline),
        quickActions: [],
        status: "done",
        approvalId: item.approvalId,
        triggerId: item.triggerId,
        triggerName: item.triggerName,
        agentId: item.agentId,
        workspaceId: item.workspaceId,
        unread: Boolean(item.unread),
      };
    }

    if (item.level === "wish" && item.inProgress) {
      return {
        id: `msg_legacy_${item.id}`,
        createdAt: item.createdAt,
        role: "user",
        kind: "chat",
        text: summaryText || cleanHeadline || "历史请求",
        images: [],
        links: [],
        quickActions: [],
        status: "done",
        agentId: item.agentId,
        workspaceId: item.workspaceId,
        unread: false,
      };
    }

    const condensed: { text: string; details?: string } =
      summaryText.length > 220 || /```|\n\|[^\n]+\|/.test(summaryText)
        ? buildConclusionSummary(summaryText, cleanHeadline, 220)
        : { text: summaryText || cleanHeadline || "历史记录" };
    const mergedDetails = item.details || condensed.details;
    const links = ensureAgentJumpLink(
      rawLinks,
      item.agentId,
      item.agentId ? undefined : cleanHeadline,
    );

    return {
      id: `msg_legacy_${item.id}`,
      createdAt: item.createdAt,
      role: "assistant",
      kind: "proactive",
      text: condensed.text,
      details: mergedDetails,
      images: [],
      links,
      quickActions: (item.actions ?? []).slice(0, 2),
      status: item.level === "error" ? "error" : item.inProgress ? "thinking" : "done",
      approvalId: item.approvalId,
      triggerId: item.triggerId,
      triggerName: item.triggerName,
      agentId: item.agentId,
      workspaceId: item.workspaceId,
      unread: Boolean(item.unread),
    };
  });
}

/**
 * Build Dot-style 3-bubble onboarding welcome sequence for cold start.
 */
export function buildOnboardingMessages(opts?: {
  butlerName?: string;
  userName?: string;
  baseTimeMs?: number;
}): ChatMessage[] {
  const cleanUser = (opts?.userName ?? "").trim();
  const baseMs = opts?.baseTimeMs ?? Date.now();
  const greeting = cleanUser
    ? `嗨，${cleanUser}！我是你的个人管家，可以帮你分担手头的事务。`
    : "嗨！我是你的个人管家，可以帮你分担手头的事务。";

  const texts = [
    greeting,
    "想给我取个名字吗？直接告诉我就可以。",
    "我平时会帮你盯着日程、文件和后台任务，没变化时不打扰你。现在有什么特别想处理的吗？",
  ];

  return texts.map((text, i) => ({
    id: `msg_welcome_${i + 1}`,
    createdAt: new Date(baseMs + i).toISOString(),
    role: "assistant",
    kind: "chat",
    text,
    images: [],
    links: [],
    quickActions: [],
    tier: "L0",
    status: "done",
    unread: false,
  }));
}

function sanitizeExtractedName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .trim()
    .replace(/^[「『“"'`(\[【]+|[」』”"'`)\]】]+$/gu, "")
    .replace(/(?:吧|就行|就好|即可|就可以|啦|哦|呀|哈|呢)+$/u, "")
    .replace(/[。，,；;！!？?]+$/gu, "")
    .trim();
  if (!cleaned || cleaned.length > 32) return undefined;
  if (/^(?:未设置|空|默认|none|null|undefined)$/iu.test(cleaned)) return undefined;
  return cleaned;
}

/**
 * Extract butlerName / userName preferences from `[称呼偏好]` memory notes, full MEMORY.md edits,
 * or conversational rename statements (closing ISS-001).
 */
export function parseProfilePreferenceFromMemoryNote(content: string): {
  butlerName?: string;
  userName?: string;
} {
  if (!content || !content.trim()) return {};
  const text = content.trim();

  let butlerName: string | undefined;
  let userName: string | undefined;

  // 1. Structured memory note patterns (e.g. `[称呼偏好] 管家名称设为「小点」；称呼用户为「辉」。`)
  const butlerPatterns = [
    /管家(?:名称|名字|昵称|称呼)?\s*(?:设为|改为|定为|是|叫|为|[：:])\s*[「『“"']?([^「』”"'；;，,。\n]{1,28})[」』”"']?/u,
    /\bbutler\s*name\s*(?:set\s*to|is|[=:：])\s*["'「]?([^"'」；;,\n.]{1,28})["'」]?/iu,
    /(?:以后|平时)?(?:叫你|给你取名(?:叫|为)?|给你起名(?:叫|为)?|你就叫)\s*[「『“"']?([^「』”"'；;，,。\n]{1,20})[」』”"']?/u,
  ];
  for (const re of butlerPatterns) {
    const m = re.exec(text);
    const cand = sanitizeExtractedName(m?.[1]);
    if (cand) {
      butlerName = cand;
      break;
    }
  }

  const userPatterns = [
    /(?:称呼用户(?:为)?|用户(?:名称|名字|昵称|称呼)(?:设为|改为|是|为)?)\s*[：:]?\s*[「『“"']?([^「』”"'；;，,。\n]{1,28})[」』”"']?/u,
    /\b(?:call\s+user|user\s*name(?:\s*set\s*to|\s*is)?)\s*[=:：]?\s*["'「]?([^"'」；;,\n.]{1,28})["'」]?/iu,
    /(?:以后|平时)?(?:叫我|称呼我(?:为)?)\s*[「『“"']?([^「』”"'；;，,。\n]{1,20})[」』”"']?/u,
  ];
  for (const re of userPatterns) {
    const m = re.exec(text);
    const cand = sanitizeExtractedName(m?.[1]);
    if (cand) {
      userName = cand;
      break;
    }
  }

  const out: { butlerName?: string; userName?: string } = {};
  if (butlerName) out.butlerName = butlerName;
  if (userName) out.userName = userName;
  return out;
}
