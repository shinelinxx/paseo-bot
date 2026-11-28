import os from "node:os";
import path from "node:path";
import type {
  ApprovalItem,
  FeedAction,
  FeedFeedback,
  FeedItem,
  GovernanceLevel,
  MissionDraft,
  RoutineSuggestion,
  TriggerKind,
  WishImageAttachment,
} from "../shared/contracts";
import { createShortId, expandHomePath, type PersistedBotState } from "./storage.ts";

export function normalizeAgentImages(
  images?: readonly WishImageAttachment[],
): Array<{ data: string; mimeType: string }> {
  if (!images || images.length === 0) return [];
  const out: Array<{ data: string; mimeType: string }> = [];
  for (const img of images) {
    const rawData = img.data.trim();
    if (!rawData) continue;
    const dataUrlMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(rawData);
    const mimeType = (dataUrlMatch?.[1] || img.mimeType || "image/png").trim().toLowerCase();
    const base64 = (dataUrlMatch?.[2] || rawData).replace(/\s+/g, "");
    if (!base64 || !mimeType.startsWith("image/")) continue;
    out.push({ data: base64, mimeType });
  }
  return out;
}

export function formatImageSummaryTag(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "[附 1 张图片]" : `[附 ${count} 张图片]`;
}

export function resolveWishSubmissionContent(input: {
  wish: string;
  images?: readonly WishImageAttachment[];
  titleOverride?: string;
}): {
  cleanWish: string;
  attachedImages: Array<{ data: string; mimeType: string }>;
  effectiveWishText: string;
  feedSummaryText: string;
  baseLabel: string;
} {
  const cleanWish = input.wish.trim();
  const attachedImages = normalizeAgentImages(input.images);
  const imageTag = formatImageSummaryTag(attachedImages.length);
  const effectiveWishText =
    cleanWish ||
    (attachedImages.length === 1
      ? "请查看附带的图片并按需分析或处理。"
      : `请查看附带的 ${attachedImages.length} 张图片并按需分析或处理。`);
  const feedSummaryText = cleanWish
    ? imageTag
      ? `${cleanWish}\n\n${imageTag}`
      : cleanWish
    : imageTag;
  const baseLabel =
    input.titleOverride?.trim() ||
    (cleanWish
      ? cleanTaskTitle(cleanWish).replace(/\s+/g, " ").slice(0, 26) +
        (cleanWish.length > 26 ? "…" : "")
      : attachedImages.length === 1
        ? "图片任务"
        : `${attachedImages.length} 张图片任务`);
  return {
    cleanWish,
    attachedImages,
    effectiveWishText,
    feedSummaryText,
    baseLabel,
  };
}

const CHINESE_NUMERALS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
};

function parseChineseOrArabicHour(raw: string): number | null {
  const trimmed = raw.trim();
  const num = Number.parseInt(trimmed, 10);
  if (Number.isFinite(num) && num >= 0 && num <= 23) return num;
  if (trimmed in CHINESE_NUMERALS) return CHINESE_NUMERALS[trimmed];
  return null;
}

export function extractDailyTime(intent: string): string | undefined {
  const hhmmMatch = /(?:^|[^\d])([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)(?:[^\d]|$)/.exec(intent);
  if (hhmmMatch) {
    let hour = Number.parseInt(hhmmMatch[1], 10);
    const min = Number.parseInt(hhmmMatch[2], 10);
    if (/(下午|晚上|傍晚|夜间|pm)/i.test(intent) && hour < 12) {
      hour += 12;
    }
    return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }

  const cnTimeMatch =
    /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜间)?\s*([0-9]{1,2}|[一二两三四五六七八九十]{1,2})\s*(?:点|时)(?:(半)|([0-5]?\d)\s*分?)?/.exec(
      intent,
    );
  if (cnTimeMatch) {
    const period = cnTimeMatch[1] ?? "";
    const parsedHour = parseChineseOrArabicHour(cnTimeMatch[2]);
    if (parsedHour !== null) {
      let hour = parsedHour;
      if (
        (period === "下午" || period === "傍晚" || period === "晚上" || period === "夜间") &&
        hour < 12
      ) {
        hour += 12;
      } else if (period === "中午" && hour < 11) {
        hour += 12;
      }
      const minute = cnTimeMatch[3]
        ? 30
        : cnTimeMatch[4]
          ? Number.parseInt(cnTimeMatch[4], 10)
          : 0;
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      }
    }
  }

  if (/(晨报|早报|每天早上|每日晨间|morning)/i.test(intent)) {
    return "08:30";
  }
  if (/(晚报|日报总结|每天晚上|睡前|evening)/i.test(intent)) {
    return "21:30";
  }
  return undefined;
}

export function extractIntervalSec(intent: string): number | undefined {
  const intervalMatch =
    /(?:每|每隔|every)\s*(\d+)\s*(秒|分钟|分|小时|钟头|(?:sec|second|seconds|s|min|minute|minutes|m|hr|hour|hours|h)\b)/i.exec(
      intent,
    );
  if (intervalMatch) {
    const val = Number.parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2].toLowerCase();
    if (Number.isFinite(val) && val > 0) {
      if (unit === "秒" || unit.startsWith("s")) return Math.max(10, val);
      if (unit === "分钟" || unit === "分" || unit.startsWith("m")) return val * 60;
      if (unit === "小时" || unit === "钟头" || unit.startsWith("h")) return val * 3600;
    }
  }
  if (/(每半小时|半小时一次)/.test(intent)) return 1800;
  if (/(每小时|一小时一次|hourly)/i.test(intent)) return 3600;
  return undefined;
}

const GENERIC_WORKSPACE_KEYWORDS = new Set([
  "日常",
  "通用",
  "日常通用任务",
  "通用任务",
  "任务",
  "工作区",
  "目录",
  "项目",
  "个人",
  "默认",
  "源码",
  "插件",
  "自动化",
  "公司",
  "工作室",
  "专项",
  "架构",
  "成立",
  "迁移",
  "服务",
  "workspace",
  "project",
  "general",
  "default",
  "documents",
  "users",
  "company",
  "agent",
]);

function extractWorkspaceKeywordsFromLabel(label: string): string[] {
  const clean = label
    .replace(/\[\d{4}-\d{2}-\d{2}\]/g, " ")
    .replace(/[*`'"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];
  const results = new Set<string>();
  const addCjkVariants = (rawSeg: string) => {
    const trimmed = rawSeg.trim();
    if (!trimmed) return;
    const stripped = trimmed
      .replace(/\s*(?:自主意识)?\s*(?:ai\s*)?(?:软件)?(?:公司|工作室)(?:成立.*)?$/iu, "")
      .replace(/(?:成立与.*|服务迁移.*)$/u, "")
      .trim();
    for (const form of [trimmed, stripped]) {
      const lowerForm = form.toLowerCase();
      if (!form || GENERIC_WORKSPACE_KEYWORDS.has(lowerForm)) continue;
      const hasCjk = /[\u4e00-\u9fa5]/.test(form);
      if ((hasCjk && form.length >= 2) || (!hasCjk && form.length >= 3)) {
        results.add(lowerForm);
      }
      // Extract concise CJK core aliases like "美亚撸货" from "美亚自动化撸货", "卡旅" from "卡旅私享管家"
      if (hasCjk && form.includes("私享管家")) {
        const prefix = form.split("私享管家")[0]?.trim();
        if (prefix && prefix.length >= 2 && !GENERIC_WORKSPACE_KEYWORDS.has(prefix)) {
          results.add(prefix.toLowerCase());
        }
      }
      if (hasCjk && form.includes("自动化") && form.length >= 4) {
        const compact = form.replace("自动化", "").trim();
        if (compact.length >= 2 && !GENERIC_WORKSPACE_KEYWORDS.has(compact)) {
          results.add(compact.toLowerCase());
        }
      }
    }
  };

  const segments = clean
    .split(/[/／、，,|｜·：:;；()（）「」《》[\]]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const seg of segments) {
    addCjkVariants(seg);
    const asciiMatches = seg.match(/[A-Za-z][A-Za-z0-9_-]{2,32}/g) ?? [];
    for (const token of asciiMatches) {
      const lowerTok = token.toLowerCase();
      if (
        !GENERIC_WORKSPACE_KEYWORDS.has(lowerTok) &&
        lowerTok !== "paseo" &&
        lowerTok !== "agent-company"
      ) {
        results.add(lowerTok);
      }
    }
  }
  return [...results];
}

export function extractMemoryWorkspaceHints(
  memoryContent: string,
): Array<{ cwd: string; label: string; keywords: string[] }> {
  if (!memoryContent.trim()) return [];
  const merged = new Map<string, { cwd: string; label: string; keywords: Set<string> }>();

  const upsertHint = (rawLabel: string, rawPath: string) => {
    const cleanPath = rawPath.trim().replace(/[.,;:]+$/, "");
    if (!cleanPath) return;
    const resolved = path.resolve(expandHomePath(cleanPath));
    const cleanLabel = rawLabel
      .replace(/^(?:-\s*)?(?:\[\d{4}-\d{2}-\d{2}\]\s*-?\s*)+/g, "")
      .replace(/\*+/g, "")
      .trim();
    if (!cleanLabel) return;
    const kws = extractWorkspaceKeywordsFromLabel(cleanLabel);
    const existing = merged.get(resolved);
    if (existing) {
      for (const kw of kws) existing.keywords.add(kw);
      return;
    }
    merged.set(resolved, {
      cwd: resolved,
      label: cleanLabel,
      keywords: new Set(kws),
    });
  };

  // 1. Direct map lines: `- **Label**：~/path` or `- Label: /Users/...`
  const lineRe =
    /^\s*[-*]\s+\*{0,2}([^：:\n`]{2,64}?)\*{0,2}\s*[：:]\s*`?((?:~\/|\/Users\/|\/home\/|\/opt\/)[^`\s（()）,，。；;]+)`?/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(memoryContent)) !== null) {
    upsertHint(match[1], match[2]);
  }

  // 2. Active Goals / AI Company bullets mentioning a project/company heading and its workspace path
  const bulletLines = memoryContent.split(/\r?\n/);
  for (const line of bulletLines) {
    if (!/^\s*[-*]\s+/.test(line)) continue;
    const headingMatch =
      /^\s*[-*]\s+(?:\[\d{4}-\d{2}-\d{2}\]\s*-?\s*)*\*\*([^*]{2,80})\*\*\s*[：:]/.exec(line);
    if (!headingMatch) continue;
    const heading = headingMatch[1].trim();
    const anchoredMatch =
      /(?:在|本地路径|工作区|目录)\s*[：:]?\s*`((?:~\/|\/Users\/|\/home\/|\/opt\/)[^`\s（()）,，。；;]+)`/.exec(
        line,
      );
    if (anchoredMatch) {
      upsertHint(heading, anchoredMatch[1]);
      continue;
    }
    const pathMatches = [
      ...line.matchAll(/`((?:~\/|\/Users\/|\/home\/|\/opt\/)[^`\s（()）,，。；;]+)`/g),
    ];
    if (pathMatches.length === 1) {
      upsertHint(heading, pathMatches[0][1]);
    }
  }

  return [...merged.values()].map((item) => ({
    cwd: item.cwd,
    label: item.label,
    keywords: [...item.keywords],
  }));
}

const PASEO_BOT_REPO_INTENT_RE =
  /(?:插件|源码|代码|仓库|逻辑|修复|bug|重构|前端|后端|气泡|抽屉|模型切换|单测|测试|typecheck|engine\.ts|router\.ts|intent\.ts|tools\.ts|总舵|总控|派给|交给)/iu;

export function inferWorkspaceAndWatchPath(
  intent: string,
  defaultCwd: string,
  knownWorkspaces: readonly { cwd: string; label: string }[] = [],
  memoryContent = "",
): { cwd: string; watchPath?: string } {
  const resolvedDefault = path.resolve(expandHomePath(defaultCwd));

  const pathMatch = /(?:^|\s)((?:~\/|\/Users\/|\/home\/|\/tmp\/|\/var\/|\/opt\/)[^\s,，。；;'"`]+)/.exec(
    intent,
  );
  if (pathMatch) {
    const resolved = expandHomePath(pathMatch[1]);
    return { cwd: resolved, watchPath: resolved };
  }

  const homeDocs = path.join(os.homedir(), "Documents");
  if (
    /\bpaseo[-_]bot\b/i.test(intent) ||
    (/\bpaseo\s+bot\b/i.test(intent) && PASEO_BOT_REPO_INTENT_RE.test(intent))
  ) {
    return { cwd: path.join(homeDocs, "paseo", "paseo-bot") };
  }

  // Merge known workspaces and MEMORY.md workspace map hints into unified candidates
  const candidateMap = new Map<
    string,
    { cwd: string; labels: Set<string>; keywords: Set<string> }
  >();
  const addCandidate = (cwdRaw: string, label?: string, extraKeywords: readonly string[] = []) => {
    const norm = path.resolve(expandHomePath(cwdRaw));
    const entry = candidateMap.get(norm) ?? {
      cwd: norm,
      labels: new Set<string>(),
      keywords: new Set<string>(),
    };
    if (label?.trim()) entry.labels.add(label.trim());
    for (const kw of extraKeywords) entry.keywords.add(kw);
    candidateMap.set(norm, entry);
  };

  for (const ws of knownWorkspaces) {
    addCandidate(ws.cwd, ws.label, extractWorkspaceKeywordsFromLabel(ws.label));
  }
  for (const hint of extractMemoryWorkspaceHints(memoryContent)) {
    addCandidate(hint.cwd, hint.label, hint.keywords);
  }

  const lowerIntent = intent
    .toLowerCase()
    .replace(/\bpaseo\s+bot\b/gi, " ");
  let bestCwd: string | null = null;
  let bestScore = 0;

  for (const cand of candidateMap.values()) {
    let score = 0;
    const base = path.basename(cand.cwd).toLowerCase();
    const spacedBase = base.replace(/[-_]+/g, " ");
    if (base.length >= 3 && !GENERIC_WORKSPACE_KEYWORDS.has(base)) {
      if (lowerIntent.includes(base)) {
        score = Math.max(score, 100 + base.length);
      } else if (
        spacedBase !== base &&
        spacedBase.length >= 5 &&
        lowerIntent.includes(spacedBase)
      ) {
        score = Math.max(score, 95 + spacedBase.length);
      }
    }

    for (const label of cand.labels) {
      const lowerLabel = label.toLowerCase();
      if (
        lowerLabel.length >= 2 &&
        !GENERIC_WORKSPACE_KEYWORDS.has(lowerLabel) &&
        lowerIntent.includes(lowerLabel)
      ) {
        score = Math.max(score, 85 + lowerLabel.length);
      }
    }

    for (const kw of cand.keywords) {
      if (lowerIntent.includes(kw)) {
        const isAscii = /^[a-z0-9_-]+$/i.test(kw);
        const matched = isAscii
          ? new RegExp(`(?:^|[^a-z0-9_-])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9_-])`, "i").test(
              lowerIntent,
            )
          : true;
        if (matched) {
          score = Math.max(score, 70 + kw.length);
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestCwd = cand.cwd;
    }
  }

  if (bestCwd && bestScore > 0) {
    if (/00-inbox|收件箱草稿|收件箱笔记/i.test(intent) && bestCwd === resolvedDefault) {
      return { cwd: bestCwd, watchPath: path.join(bestCwd, "00-Inbox") };
    }
    return { cwd: bestCwd };
  }

  // Match ~/Documents/<ProjectName> when an explicit CamelCase/hyphenated project name is mentioned
  const docProjMatch = /\b([A-Z][A-Za-z0-9_-]{2,30})\b/.exec(intent);
  if (docProjMatch && !/^(HTTP|HTTPS|JSON|HTML|YAML|UTF|SHA|API|URL|PDF|CSV|Paseo)$/i.test(docProjMatch[1])) {
    const candidate = docProjMatch[1];
    if (/00-inbox/i.test(intent)) {
      const kb = resolvedDefault.includes("KnowledgeBase")
        ? resolvedDefault
        : path.join(homeDocs, "KnowledgeBase");
      return { cwd: kb, watchPath: path.join(kb, "00-Inbox") };
    }
    if (!/^(Wiki|Inbox|Downloads|Obsidian)$/i.test(candidate)) {
      return { cwd: path.join(homeDocs, candidate) };
    }
  }

  if (/00-inbox|收件箱草稿|收件箱笔记/i.test(intent)) {
    return { cwd: resolvedDefault, watchPath: path.join(resolvedDefault, "00-Inbox") };
  }
  if (/downloads|下载目录|下载文件夹/i.test(intent)) {
    const dl = path.join(os.homedir(), "Downloads");
    return { cwd: resolvedDefault, watchPath: dl };
  }
  return { cwd: resolvedDefault };
}

export function inferGovernance(intent: string): GovernanceLevel {
  if (
    /(发(?:送)?邮件|回复邮件|外发|下单|购买|支付|转账|删除|清空|推送到远端|git\s+push|deploy|send\s+email|purchase|delete)/i.test(
      intent,
    )
  ) {
    return "require_approval";
  }
  if (/(自动归档|自动整理|自动归类|直接整理进|autonomous)/i.test(intent)) {
    return "autonomous";
  }
  return "notify";
}

function buildShortMissionName(intent: string, kind: TriggerKind, dailyTime?: string): string {
  const cleaned = intent
    .replace(/^(请|帮我|替我|麻烦|我希望|我想|设定|创建一个|新建)\s*/u, "")
    .replace(/[。！!？?\s]+$/u, "")
    .trim();
  if (cleaned.length <= 22) {
    return cleaned || "自动规则";
  }
  if (dailyTime && kind === "schedule") {
    return `${dailyTime} · ${cleaned.slice(0, 16)}…`;
  }
  return `${cleaned.slice(0, 20)}…`;
}

export function draftMissionFromIntent(
  intent: string,
  defaultCwd: string,
  knownWorkspaces: readonly { cwd: string; label: string }[] = [],
  memoryContent = "",
): MissionDraft {
  const cleanIntent = intent.trim();
  const { cwd, watchPath: inferredWatchPath } = inferWorkspaceAndWatchPath(
    cleanIntent,
    defaultCwd,
    knownWorkspaces,
    memoryContent,
  );
  const governance = inferGovernance(cleanIntent);
  const dailyTime = extractDailyTime(cleanIntent);
  const intervalSec = extractIntervalSec(cleanIntent);

  const urlMatch = /(https?:\/\/[^\s,，。；;'"`]+)/i.exec(cleanIntent);
  const backtickCmd = /`([^`]{3,160})`/.exec(cleanIntent);

  let kind: TriggerKind = "schedule";
  let watchPath: string | undefined;
  let pollCommand: string | undefined;
  let pollIntervalSec = intervalSec ?? 300;
  let finalDailyTime: string | undefined;
  let rationale = "";

  if (/webhook|快捷指令|回调地址|外部推送|飞书机器人/i.test(cleanIntent)) {
    kind = "webhook";
    rationale = "识别为外部回调触发，将生成本机专属 Webhook 接收地址。";
  } else if (urlMatch) {
    kind = "poll_command";
    pollCommand = urlMatch[1];
    rationale = "识别到目标网址，先对比页面指纹，内容有变化时才调用模型处理。";
  } else if (backtickCmd && !inferredWatchPath) {
    kind = "poll_command";
    pollCommand = backtickCmd[1].trim();
    rationale = "识别到检测命令，输出无变化时不会消耗模型额度。";
  } else if (
    inferredWatchPath ||
    /(监听|盯住.*目录|盯住.*文件夹|有新文件|有新笔记|新增文件|file\s*watch)/i.test(cleanIntent)
  ) {
    kind = "file_watch";
    watchPath = inferredWatchPath ?? cwd;
    rationale = "识别为目录监听，文件发生变动后自动防抖触发。";
  } else if (dailyTime) {
    kind = "schedule";
    finalDailyTime = dailyTime;
    pollIntervalSec = 3600;
    rationale = `将在每天 ${dailyTime} 定时运行检查。`;
  } else {
    kind = "schedule";
    if (!intervalSec) {
      finalDailyTime = "09:00";
      pollIntervalSec = 3600;
      rationale = "未指定具体时间，默认安排在每天 09:00 运行（可在下方修改）。";
    } else {
      rationale = `每 ${Math.round(pollIntervalSec / 60) || 1} 分钟检查一次，无变化时不打扰。`;
    }
  }

  const name = buildShortMissionName(cleanIntent, kind, finalDailyTime);

  const composedPrompt = [
    `任务目标：${cleanIntent}`,
    ``,
    `执行要求：`,
    `1. 如果没有任何新增内容、异常或需要关注的进展，立即调用 \`paseo_bot_report_outcome\`（\`level: "silent"\`）退出，不要发送无意义提醒。`,
    `2. 如果有实质变化或待处理事项，先用简短几句话给出结论，再通过 \`paseo_bot_report_outcome\`（\`level: "notify"\`）附上 1~2 个常用后续操作按钮（\`actions\`）。`,
    governance === "require_approval"
      ? `3. 涉及外发邮件/消息、资金或不可逆修改时，不要直接执行，必须调用 \`paseo_bot_request_approval\` 并提供完整的待执行内容预览（\`payloadPreview\`）等待用户确认。`
      : `3. 涉及外发或高风险修改时，请调用 \`paseo_bot_request_approval\` 先交由用户确认。`,
  ].join("\n");

  const triggerLabel =
    kind === "file_watch"
      ? `监听目录 ${watchPath}`
      : kind === "webhook"
        ? "本地 Webhook 回调触发"
        : kind === "poll_command"
          ? `每 ${pollIntervalSec} 秒检测 ${pollCommand}`
          : finalDailyTime
            ? `每天 ${finalDailyTime} 定时运行`
            : `每 ${Math.round(pollIntervalSec / 60)} 分钟运行`;

  const govLabel =
    governance === "require_approval"
      ? "执行前需确认"
      : governance === "autonomous"
        ? "自动执行并汇总结果"
        : "有变化时发送提醒";

  return {
    name,
    description: cleanIntent,
    kind,
    governance,
    executionTarget: "scout_helper",
    cwd,
    watchPath,
    pollCommand,
    pollIntervalSec,
    dailyTime: finalDailyTime,
    debounceMs: 4500,
    cooldownSec: kind === "webhook" ? 10 : 60,
    prompt: composedPrompt,
    humanSummary: `${triggerLabel} · ${govLabel}`,
    rationale,
  };
}

export function computeRoutineSuggestions(
  state: Pick<PersistedBotState, "dismissedSuggestionIds" | "workers" | "triggers"> &
    Partial<PersistedBotState>,
  homeCwd: string,
): RoutineSuggestion[] {
  const resolvedHome = expandHomePath(homeCwd);
  const dismissed = new Set(state.dismissedSuggestionIds ?? []);
  const suggestions: RoutineSuggestion[] = [];

  const cwdCounts = new Map<string, { count: number; samples: string[] }>();
  for (const w of state.workers) {
    if (!w.cwd) continue;
    const norm = path.resolve(expandHomePath(w.cwd));
    const entry = cwdCounts.get(norm) ?? { count: 0, samples: [] };
    entry.count += 1;
    if (entry.samples.length < 3) entry.samples.push(w.title);
    cwdCounts.set(norm, entry);
  }

  for (const [cwd, info] of cwdCounts.entries()) {
    if (info.count < 2) continue;
    const hasActiveTrigger = state.triggers.some(
      (t) => t.enabled && path.resolve(expandHomePath(t.cwd)) === cwd,
    );
    if (hasActiveTrigger) continue;

    const baseName = path.basename(cwd) || cwd;
    const sugId = `sug_cwd_${baseName.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`;
    if (dismissed.has(sugId)) continue;

    const draft = draftMissionFromIntent(
      `每天 09:00 检查 ${cwd} 目录近期状态与待办事项（参考近期任务：${info.samples[0] ?? baseName}）`,
      resolvedHome,
    );
    suggestions.push({
      id: sugId,
      title: `为「${baseName}」添加每日自动检查`,
      reason: `近期你在 ${baseName} 多次手动运行了任务（如“${info.samples[0]}”），可以设为每日定时自动跟进。`,
      cwd,
      suggestedKind: draft.kind,
      dailyTime: draft.dailyTime,
      watchPath: draft.watchPath,
      pollCommand: draft.pollCommand,
      pollIntervalSec: draft.pollIntervalSec,
      governance: draft.governance ?? "notify",
      prompt: draft.prompt,
    });
    if (suggestions.length >= 2) return suggestions;
  }

  if (state.triggers.length === 0 && suggestions.length === 0) {
    const sugId = "sug_starter_kb_inbox";
    if (!dismissed.has(sugId)) {
      const watchTarget = path.join(resolvedHome, "00-Inbox");
      suggestions.push({
        id: sugId,
        title: "自动整理 00-Inbox 新笔记",
        reason: "监听 00-Inbox 目录下的新增草稿，自动归类整理并更新索引，平时无新文件时不打扰。",
        cwd: resolvedHome,
        suggestedKind: "file_watch",
        watchPath: watchTarget,
        governance: "autonomous",
        prompt: [
          "检测到知识库 `00-Inbox/` 目录有文件变动。",
          "1. 若无实质新草稿，调用 `paseo_bot_report_outcome` (`level: 'silent'`) 直接退出。",
          "2. 若有新草稿，按仓库 `AGENTS.md` 规范整理归档并更新索引，完成后发送简短结果提醒。",
        ].join("\n"),
      });
    }
  }

  return suggestions.slice(0, 2);
}

export function applyFeedCurationMutation(
  draft: PersistedBotState,
  input: {
    feedId: string;
    feedback: FeedFeedback;
    ruleNote?: string;
    muteTrigger?: boolean;
  },
  nowIso = new Date().toISOString(),
): { targetFeed?: FeedItem; updatedTriggerName?: string } {
  const cleanNote = input.ruleNote?.trim();
  const found = draft.feed.find((f) => f.id === input.feedId);
  if (!found) return {};

  found.feedback = input.feedback;
  if (cleanNote) found.feedbackNote = cleanNote;
  if (input.feedback === "down") {
    found.unread = false;
  }
  const targetFeed: FeedItem = { ...found };
  let updatedTriggerName: string | undefined;

  if (input.feedback === "down" && found.triggerId) {
    const trg = draft.triggers.find((t) => t.id === found.triggerId);
    if (trg) {
      if (input.muteTrigger) {
        trg.enabled = false;
      } else {
        const nextRule =
          cleanNote ||
          `减少与「${found.title.slice(0, 32)}」类似的低优先级提醒，仅在有明确待处理事项时通知`;
        if (!trg.noiseRules.includes(nextRule)) {
          trg.noiseRules = [...trg.noiseRules.slice(-9), nextRule];
        }
      }
      trg.updatedAt = nowIso;
      updatedTriggerName = trg.name;
    }
  }

  return { targetFeed, updatedTriggerName };
}

export function applyApprovalResolutionMutation(
  draft: PersistedBotState,
  input: {
    id: string;
    decision: "approved" | "rejected";
    note?: string;
    editedFollowUpPrompt?: string;
    promoteTrust?: boolean;
  },
  resolvedAt = new Date().toISOString(),
): { target?: ApprovalItem; promotedTriggerName?: string } {
  const found = draft.approvals.find((a) => a.id === input.id);
  if (!found || found.status !== "pending") return {};

  found.status = input.decision;
  found.resolvedAt = resolvedAt;
  found.decisionNote = input.note?.trim() || undefined;
  if (input.editedFollowUpPrompt?.trim()) {
    found.followUpPrompt = input.editedFollowUpPrompt.trim();
  }
  if (input.decision === "approved" && input.promoteTrust) {
    found.promotedTrust = true;
  }
  const target: ApprovalItem = { ...found };
  let promotedTriggerName: string | undefined;

  // Sync any corresponding Inbox feed card so "待确认：..." doesn't stay unread/stale after decision
  for (const f of draft.feed) {
    if (
      f.approvalId === found.id ||
      (f.level === "approval_required" && f.title === `待确认：${found.title}`)
    ) {
      f.unread = false;
      f.level = "notify";
      f.title =
        input.decision === "approved"
          ? `已确认：${found.title}`
          : `已拒绝：${found.title}`;
    }
  }

  // Sync inline approval message in single-stream messages
  for (const m of draft.messages ?? []) {
    if (m.approvalId === found.id) {
      m.unread = false;
      m.status = "done";
    }
  }

  if (found.triggerId) {
    const trg = draft.triggers.find((t) => t.id === found.triggerId);
    if (trg) {
      if (input.decision === "approved") {
        trg.approvedCount = (trg.approvedCount || 0) + 1;
        if (input.promoteTrust && trg.governance === "require_approval") {
          trg.governance = "notify";
          trg.updatedAt = resolvedAt;
          promotedTriggerName = trg.name;
        }
      } else if (input.decision === "rejected" && input.note?.trim()) {
        const rejectRule = `此前拒绝「${found.title.slice(0, 28)}」原因：${input.note.trim()}`;
        if (!trg.noiseRules.includes(rejectRule)) {
          trg.noiseRules = [...trg.noiseRules.slice(-9), rejectRule];
        }
      }
    }
  }

  return { target, promotedTriggerName };
}

export function cleanTaskTitle(raw: string): string {
  return raw
    .replace(/^(?:子任务已完成|子任务出错|已开始处理|已完成|任务|许愿|Bot Worker)\s*[：:·]\s*/gu, "")
    .replace(/^(?:任务|许愿|Bot Worker)\s*[：:·]\s*/gu, "")
    .trim();
}

export function splitReplyIntoPreviewAndDetails(
  rawText: string,
  maxPreviewChars = 360,
  maxPreviewLines = 6,
): { summary: string; details?: string } {
  const full = rawText.trim().slice(0, 12_000);
  if (!full) {
    return { summary: "处理完成。" };
  }

  const allLines = full.split("\n");
  const nonEmptyCount = allLines.filter((l) => l.trim().length > 0).length;
  if (full.length <= maxPreviewChars && nonEmptyCount <= maxPreviewLines) {
    return { summary: full };
  }

  const previewLines: string[] = [];
  let charTotal = 0;
  let nonEmptyPicked = 0;
  let inCodeFence = false;

  for (const line of allLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
    }
    previewLines.push(line);
    charTotal += line.length + 1;
    if (trimmed.length > 0 && !/^---+$/.test(trimmed)) {
      nonEmptyPicked += 1;
    }
    if (
      !inCodeFence &&
      (nonEmptyPicked >= maxPreviewLines || charTotal >= maxPreviewChars)
    ) {
      break;
    }
  }

  const preview = previewLines.join("\n").trim();
  if (!preview || preview.length >= full.length - 30) {
    return { summary: full };
  }
  return {
    summary: preview,
    details: full,
  };
}

const RETROSPECTIVE_HEADING_RE =
  /(已完成|已修改|已执行|已修复|已归档|已清理|改动明细|修改明细|变更明细|精简明细|优化明细|执行结果|处理结果|根因|原因分析|核心症结|问题分析|汇总对比|方案对比|completed|changes made|summary of changes|root cause)/i;

const ACTIONABLE_CONTEXT_RE =
  /(待处理|待办|待确认|需处理|需确认|需要你|需人工|下一步|后续建议|可选操作|建议跟进|todo|to-do|action items?|next steps?|pending|follow[- ]?ups?)/i;

function normalizeDirectoryHint(rawPath: string | undefined): string | undefined {
  if (!rawPath) return undefined;
  const base = path.basename(rawPath);
  if (/\.[a-z0-9]{1,8}$/i.test(base)) {
    return path.dirname(rawPath);
  }
  return rawPath;
}

export function extractSuggestedActionsFromMarkdown(markdown: string): FeedAction[] {
  if (!markdown || markdown.length < 30) return [];
  const actions: FeedAction[] = [];
  const seenLabels = new Set<string>();

  // Match numbered/bullet bold items (with optional Markdown task checkbox)
  const itemHeaderRegex =
    /(?:^|\n)[ \t]*(?:\d+\.|[-*])[ \t]+(?:\[([ xX])\][ \t]+)?\*\*([^*]{4,72})\*\*/g;
  const matches: Array<{
    checkboxState?: string;
    headline: string;
    startIdx: number;
    bodyStartIdx: number;
  }> = [];
  let match: RegExpExecArray | null;
  while ((match = itemHeaderRegex.exec(markdown)) !== null) {
    matches.push({
      checkboxState: match[1],
      headline: match[2].trim(),
      startIdx: match.index,
      bodyStartIdx: match.index + match[0].length,
    });
  }

  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    // Skip explicitly checked-off items: - [x] **...**
    if (current.checkboxState && current.checkboxState.toLowerCase() === "x") {
      continue;
    }

    // Inspect nearest preceding section heading and lead-in text before this list
    const beforeText = markdown.slice(0, current.startIdx);
    const headingMatches = [...beforeText.matchAll(/(?:^|\n)#{1,4}[ \t]+([^\n]+)/g)];
    const nearestHeading =
      headingMatches.length > 0 ? headingMatches[headingMatches.length - 1][1].trim() : "";
    const recentLeadIn = beforeText.slice(Math.max(0, beforeText.length - 220));

    if (
      nearestHeading &&
      RETROSPECTIVE_HEADING_RE.test(nearestHeading) &&
      !ACTIONABLE_CONTEXT_RE.test(nearestHeading)
    ) {
      continue;
    }

    const isUncheckedTask = current.checkboxState === " ";
    const hasExplicitActionContext =
      isUncheckedTask ||
      ACTIONABLE_CONTEXT_RE.test(nearestHeading) ||
      ACTIONABLE_CONTEXT_RE.test(recentLeadIn) ||
      /^(?:待确认|待处理|请确认|需确认|建议跟进|下一步)[：:\s]/u.test(current.headline);

    if (!hasExplicitActionContext) {
      continue;
    }

    const nextStart = i + 1 < matches.length ? matches[i + 1].startIdx : markdown.length;
    const itemBlock = markdown.slice(current.bodyStartIdx, Math.min(nextStart, current.bodyStartIdx + 800));

    const rawHeadline = current.headline
      .replace(/`+/g, "")
      .replace(/（[^）]*）/g, "")
      .replace(/\([^)]*\)/g, "")
      .trim();
    if (!rawHeadline) continue;
    if (/(人机验证|CAPTCHA|扫码登录|手动登录)/i.test(rawHeadline)) continue;

    // Reject completed / past-tense headlines or static UI/log nouns
    if (
      /^(?:已|完成：|已完成|无需|不用)/u.test(rawHeadline) ||
      /(已完成|已归档|已修复|已更新|已合并|已移除|已清理|已解决|已生效)/u.test(rawHeadline) ||
      /(审批卡|动态卡|面板|明细|对比|架构|原理)$/u.test(rawHeadline)
    ) {
      continue;
    }

    if (
      !isUncheckedTask &&
      !/(确认|核对|归档|整理|修复|更新|同步|删除|清理|增加|添加|开启|关闭|检查|处理|发送|生成|升级)/u.test(
        rawHeadline,
      )
    ) {
      continue;
    }

    const shortLabel =
      rawHeadline.length > 18 ? `${rawHeadline.slice(0, 17)}…` : rawHeadline;
    if (seenLabels.has(shortLabel)) continue;
    seenLabels.add(shortLabel);

    const sessionHints = extractSessionIdHints(`${current.headline}\n${itemBlock}`);
    const pathHints = extractPathHints(`${current.headline}\n${itemBlock}`);

    actions.push({
      id: createShortId("act"),
      label: shortLabel,
      kind: "wish",
      prompt: `请直接跟进并处理这项待办：「${current.headline}」`,
      targetAgentId: sessionHints[0],
      cwd: normalizeDirectoryHint(pathHints[0]),
    });
    if (actions.length >= 3) break;
  }

  return actions;
}

export interface RoutableAgentCandidate {
  id: string;
  title: string;
  cwd: string;
  workspaceId?: string;
  workspaceTitle?: string;
  projectName?: string;
  updatedAtMs: number;
  isBackground?: boolean;
  status?: string;
  labels?: Record<string, string>;
  providerModel?: string;
}

export interface ParsedRosterCoordinator {
  agentId: string;
  roleTitle: string;
  companyName?: string;
}

function normalizeCoordinatorCwd(raw: string): string {
  if (!raw?.trim()) return "";
  return path.resolve(expandHomePath(raw.trim()));
}

function cleanRosterRoleTitle(raw: string): string {
  const stripped = raw
    .replace(/\*+/g, "")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const dedupedSuffix = stripped.replace(/(总控[^（()）]*)[（(]\s*总控\s*[)）]$/u, "$1").trim();
  return dedupedSuffix.replace(/(总舵)[（(]\s*总控\s*[)）]$/u, "$1").trim() || stripped;
}

/**
 * Parse the canonical Company Coordinator (`总控` / `Lead`) entry from an `agent-company`
 * `.company/roster.md` Markdown file.
 */
export function parseCompanyCoordinatorFromRoster(
  rosterMarkdown: string,
): ParsedRosterCoordinator | null {
  if (!rosterMarkdown || !rosterMarkdown.trim()) return null;

  const headerLeadMatch = />\s*由(?:总控中枢)?\s*\*\*([^*]+)\*\*\s*统管/u.exec(rosterMarkdown);
  const headerLeadName = headerLeadMatch ? cleanRosterRoleTitle(headerLeadMatch[1]) : "";

  let best: { agentId: string; roleTitle: string; score: number } | null = null;
  const lines = rosterMarkdown.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const rawCells = trimmed
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (rawCells.length < 3) continue;

    // Skip separator or table header rows
    if (rawCells.every((c) => /^[-:\s]+$/.test(c))) continue;
    const firstClean = rawCells[0].replace(/[*`]/g, "").trim();
    if (/^(?:岗位|部门|角色|role|department)/iu.test(firstClean)) continue;

    const statusCell = rawCells[rawCells.length - 1]?.replace(/[*`]/g, "").trim() ?? "";
    if (/^(?:已归档|archived|retired|deprecated)/iu.test(statusCell)) continue;

    // Find UUID or 8..36 hex Agent ID cell
    let matchedAgentId = "";
    for (const cell of rawCells) {
      const uuidMatch =
        /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(cell);
      if (uuidMatch) {
        matchedAgentId = uuidMatch[1].toLowerCase();
        break;
      }
    }
    if (!matchedAgentId) {
      for (const cell of rawCells) {
        const cleanCell = cell.replace(/`/g, "").trim();
        if (/^[0-9a-f]{8,36}$/i.test(cleanCell)) {
          matchedAgentId = cleanCell.toLowerCase();
          break;
        }
      }
    }
    if (!matchedAgentId) continue;

    let score = 0;
    const rolePlain = rawCells[0].replace(/[*`]/g, "").trim();
    const rowPlain = rawCells.join(" ").replace(/[*`]/g, "");

    if (/(?:总控|总舵|首席管家|\bcoordinator\b|\borchestrator\b|\blead\b)/iu.test(rolePlain)) {
      score += 100;
    }
    if (headerLeadName && (rolePlain.includes(headerLeadName) || headerLeadName.includes(rolePlain))) {
      score += 80;
    }
    if (/\.company\/roles\/(?:[a-z0-9_-]*lead|coordinator|pm)\.md\b/i.test(rowPlain)) {
      score += 60;
    }

    if (score >= 60 && (!best || score > best.score)) {
      best = {
        agentId: matchedAgentId,
        roleTitle: cleanRosterRoleTitle(rawCells[0]) || "总控",
        score,
      };
    }
  }

  return best ? { agentId: best.agentId, roleTitle: best.roleTitle } : null;
}

/**
 * Check whether a live Paseo agent candidate represents an AI Company Coordinator (`总控` / `lead`).
 * Requires explicit lead labels OR a coordinator title within a verified company workspace
 * (preventing false positives on generic hub titles like `📌 日常总控 · General`).
 */
export function isCompanyCoordinatorCandidate(
  cand: RoutableAgentCandidate,
  opts?: { hasCompanyDir?: boolean },
): boolean {
  if (cand.isBackground || cand.status === "error") return false;
  const labels = cand.labels ?? {};
  if (labels["paseo-bot/role"]) return false;

  const role = (
    labels.role ||
    labels["company.role"] ||
    labels["paseo-company/role"] ||
    ""
  )
    .trim()
    .toLowerCase();
  if (role === "lead" || role === "coordinator") {
    return true;
  }

  const hasCompanyMeta = Boolean(
    labels.company || labels["paseo-company/name"] || opts?.hasCompanyDir,
  );
  const dept = (labels.dept || labels["paseo-company/dept"] || "").trim().toLowerCase();
  if (hasCompanyMeta && (dept === "lead" || dept.endsWith("-lead") || dept === "coordinator")) {
    return true;
  }

  if (
    hasCompanyMeta &&
    /(?:总控|总舵|\bcompany\s+coordinator\b|\blead\s+orchestrator\b)/iu.test(cand.title)
  ) {
    return true;
  }

  return false;
}

export function pickBestCompanyCoordinatorCandidate(input: {
  targetCwd: string;
  candidates: readonly RoutableAgentCandidate[];
  rosterCoordinator?: ParsedRosterCoordinator | null;
  hasCompanyDir?: boolean;
  excludeAgentId?: string;
}): RoutableAgentCandidate | null {
  const normTarget = normalizeCoordinatorCwd(input.targetCwd);
  if (!normTarget) return null;

  const inTargetCwd = input.candidates.filter((c) => {
    if (c.isBackground || c.status === "error") return false;
    if (input.excludeAgentId && c.id === input.excludeAgentId) return false;
    if (c.labels?.["paseo-bot/role"]) return false;
    return Boolean(c.cwd) && normalizeCoordinatorCwd(c.cwd) === normTarget;
  });

  if (input.rosterCoordinator?.agentId) {
    const targetId = input.rosterCoordinator.agentId.toLowerCase();
    const byRoster =
      inTargetCwd.find((c) => c.id.toLowerCase() === targetId) ??
      inTargetCwd.find((c) => c.id.toLowerCase().startsWith(targetId));
    if (byRoster) return byRoster;
  }

  const leadMatches = inTargetCwd
    .filter((c) => isCompanyCoordinatorCandidate(c, { hasCompanyDir: input.hasCompanyDir }))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return leadMatches[0] ?? null;
}

export interface FollowUpRouteDecision {
  agentId: string;
  title: string;
  cwd: string;
  workspaceId?: string;
  routedAwayFromOrigin: boolean;
  reason: string;
}

const FOLLOW_UP_STOPWORDS = new Set([
  "确认",
  "是否",
  "请直接",
  "跟进",
  "处理",
  "这项",
  "待办",
  "继续",
  "帮我",
  "一下",
  "这个",
  "那个",
  "问题",
  "功能",
  "工作区",
  "会话",
  "子会话",
  "任务",
  "可以",
  "好的",
  "麻烦",
]);

export function extractSessionIdHints(text: string): string[] {
  const results: string[] = [];
  const add = (id: string) => {
    const clean = id.trim();
    if (clean && !results.includes(clean)) results.push(clean);
  };

  // 1. conversation://<uuid-or-prefix>
  const convRe = /conversation:\/\/([0-9a-fA-F]{7,36}(?:-[0-9a-fA-F]{4,12})*)/g;
  let m: RegExpExecArray | null;
  while ((m = convRe.exec(text)) !== null) add(m[1]);

  // 2. Explicit Chinese/English label: 会话 `787df7e`, 子会话 529a6b8, session `abc1234`
  const labeledRe =
    /(?:子?会话|session|agent)\s*[：:（(\s`'"「]*([0-9a-fA-F]{7,36}(?:-[0-9a-fA-F]{4,12})*)/gi;
  while ((m = labeledRe.exec(text)) !== null) add(m[1]);

  // 3. Full UUID anywhere in text
  const uuidRe =
    /\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/g;
  while ((m = uuidRe.exec(text)) !== null) add(m[1]);

  return results;
}

function extractWorkspaceTitleHints(text: string): string[] {
  const results: string[] = [];
  const re = /(?:工作区|workspace)\s*[「“"'《]([^」”"'》\n]{2,80})[」”"'》]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const clean = m[1].trim();
    if (clean && !results.includes(clean)) results.push(clean);
  }
  return results;
}

function extractPathHints(text: string): string[] {
  const results: string[] = [];
  const fileUriRe = /file:\/\/(\/[^\s)#"'`>\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = fileUriRe.exec(text)) !== null) {
    const clean = decodeURIComponent(m[1]).trim();
    if (clean && !results.includes(clean)) results.push(clean);
  }
  const absRe = /(?:^|[\s`'"(（])((?:~\/|\/Users\/|\/home\/)[^\s`'")）>,，。；;\]]+)/g;
  while ((m = absRe.exec(text)) !== null) {
    const clean = expandHomePath(m[1].trim());
    if (clean && !results.includes(clean)) results.push(clean);
  }
  return results;
}

function extractSearchTokens(text: string): {
  asciiTerms: string[];
  cjkBigrams: string[];
} {
  const cleaned = text
    .replace(/file:\/\/[^\s)]+/g, " ")
    .replace(/请直接跟进并处理这项待办/g, " ")
    .toLowerCase();

  const asciiSet = new Set<string>();
  const asciiRe = /[a-z0-9][a-z0-9._@-]{2,40}/g;
  let m: RegExpExecArray | null;
  while ((m = asciiRe.exec(cleaned)) !== null) {
    const tok = m[0];
    if (!/^(http|https|file|json|html|true|false|null|users|documents)$/.test(tok)) {
      asciiSet.add(tok);
    }
  }

  const cjkSet = new Set<string>();
  const cjkChunks = cleaned.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const chunk of cjkChunks) {
    if (FOLLOW_UP_STOPWORDS.has(chunk)) continue;
    if (chunk.length <= 4) {
      cjkSet.add(chunk);
    }
    for (let i = 0; i <= chunk.length - 2; i += 1) {
      const bg = chunk.slice(i, i + 2);
      if (!FOLLOW_UP_STOPWORDS.has(bg)) {
        cjkSet.add(bg);
      }
    }
  }

  return {
    asciiTerms: [...asciiSet],
    cjkBigrams: [...cjkSet],
  };
}

function scoreTextOverlap(
  tokens: { asciiTerms: string[]; cjkBigrams: string[] },
  haystack: string,
): number {
  if (!haystack) return 0;
  const lower = haystack.toLowerCase();
  let score = 0;
  for (const term of tokens.asciiTerms) {
    if (lower.includes(term)) {
      score += term.includes("-") || term.includes("@") ? 18 : 12;
    }
  }
  for (const bg of tokens.cjkBigrams) {
    if (lower.includes(bg)) {
      score += bg.length >= 3 ? 6 : 3;
    }
  }
  return score;
}

function splitMarkdownIntoBlocks(markdown: string): string[] {
  if (!markdown) return [];
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const isBoundary =
      /^[ \t]*(?:\d+\.[ \t]+\*\*|###?[ \t]+)/.test(line) && current.length > 0;
    if (isBoundary) {
      blocks.push(current.join("\n").trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push(current.join("\n").trim());
  }
  return blocks.filter((b) => b.length > 0);
}

function findAgentByIdOrPrefix(
  hint: string,
  candidates: readonly RoutableAgentCandidate[],
): RoutableAgentCandidate | undefined {
  const lower = hint.trim().toLowerCase();
  if (!lower) return undefined;
  return (
    candidates.find((c) => c.id.toLowerCase() === lower) ??
    candidates.find((c) => c.id.toLowerCase().startsWith(lower))
  );
}

export function routeFollowUpCandidate(input: {
  followUpPrompt: string;
  cardMarkdown: string;
  fallbackAgentId?: string;
  explicitTargetAgentHint?: string;
  candidates: readonly RoutableAgentCandidate[];
}): FollowUpRouteDecision | null {
  const usable = input.candidates.filter((c) => !c.isBackground);
  if (usable.length === 0) return null;

  const fallback = input.fallbackAgentId
    ? usable.find((c) => c.id === input.fallbackAgentId)
    : undefined;

  const makeDecision = (
    chosen: RoutableAgentCandidate,
    reason: string,
  ): FollowUpRouteDecision => ({
    agentId: chosen.id,
    title: chosen.workspaceTitle || chosen.title || chosen.projectName || chosen.id.slice(0, 8),
    cwd: chosen.cwd,
    workspaceId: chosen.workspaceId,
    routedAwayFromOrigin: Boolean(input.fallbackAgentId && chosen.id !== input.fallbackAgentId),
    reason,
  });

  // 1. Explicit target hint from action button or user prompt
  if (input.explicitTargetAgentHint) {
    const matched = findAgentByIdOrPrefix(input.explicitTargetAgentHint, usable);
    if (matched) {
      return makeDecision(matched, `explicit_action_target:${input.explicitTargetAgentHint}`);
    }
  }

  const promptSessionHints = extractSessionIdHints(input.followUpPrompt);
  for (const hint of promptSessionHints) {
    const matched = findAgentByIdOrPrefix(hint, usable);
    if (matched) {
      return makeDecision(matched, `prompt_session_id:${hint}`);
    }
  }

  // 2. Match user follow-up against individual sections/items of the summary card
  const queryTokens = extractSearchTokens(input.followUpPrompt);
  const blocks = splitMarkdownIntoBlocks(input.cardMarkdown);

  let bestBlock = "";
  let bestBlockScore = 0;
  for (const blk of blocks) {
    const sc = scoreTextOverlap(queryTokens, blk);
    if (sc > bestBlockScore) {
      bestBlockScore = sc;
      bestBlock = blk;
    }
  }

  // Only extract block-level hints when the user's follow-up clearly targets a specific block
  if (bestBlock && bestBlockScore >= 9) {
    // 2a. Explicit session ID cited inside the matched summary block (e.g. 会话 `787df7e`)
    const blockSessionHints = extractSessionIdHints(bestBlock);
    for (const hint of blockSessionHints) {
      const matched = findAgentByIdOrPrefix(hint, usable);
      if (matched) {
        return makeDecision(matched, `matched_block_session:${hint}`);
      }
    }

    // 2b. Explicit workspace title cited inside the matched summary block (e.g. 工作区「排查软件语音转文字失败问题」)
    const wsHints = extractWorkspaceTitleHints(bestBlock);
    for (const wsTitle of wsHints) {
      const lowerWs = wsTitle.toLowerCase();
      const wsMatches = usable
        .filter(
          (c) =>
            c.id !== input.fallbackAgentId &&
            (c.workspaceTitle?.toLowerCase() === lowerWs ||
              c.title.toLowerCase() === lowerWs ||
              c.workspaceTitle?.toLowerCase().includes(lowerWs)),
        )
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      if (wsMatches[0]) {
        return makeDecision(wsMatches[0], `matched_block_workspace:${wsTitle}`);
      }
    }
  }

  // 3. Score non-origin candidates directly by path hints + title/workspace/cwd keyword overlap
  const combinedPathHints = [
    ...extractPathHints(input.followUpPrompt),
    ...(bestBlockScore >= 9 ? extractPathHints(bestBlock) : []),
  ];
  const blockTokens = bestBlockScore >= 9 ? extractSearchTokens(bestBlock) : { asciiTerms: [], cjkBigrams: [] };

  let bestCandidate: RoutableAgentCandidate | undefined;
  let bestCandidateScore = 0;

  for (const cand of usable) {
    if (cand.id === input.fallbackAgentId) continue;
    const metaHaystack = [
      cand.title,
      cand.workspaceTitle ?? "",
      cand.projectName ?? "",
      path.basename(cand.cwd),
    ].join(" ");

    let score = scoreTextOverlap(queryTokens, metaHaystack) * 1.5;
    if (bestBlockScore >= 9) {
      score += scoreTextOverlap(blockTokens, metaHaystack) * 0.5;
    }

    const normCandCwd = path.resolve(cand.cwd);
    for (const pHint of combinedPathHints) {
      const normHint = path.resolve(pHint);
      if (
        normHint === normCandCwd ||
        normHint.startsWith(`${normCandCwd}${path.sep}`) ||
        normCandCwd.startsWith(`${normHint}${path.sep}`)
      ) {
        // Avoid boosting generic homeCwd matches unless specific project folder matches
        if (!/\/KnowledgeBase$/i.test(normCandCwd)) {
          score += 28;
        }
      }
      const baseSlug = path.basename(normHint).toLowerCase();
      if (baseSlug.length >= 4 && metaHaystack.toLowerCase().includes(baseSlug)) {
        score += 22;
      }
    }

    if (
      score > bestCandidateScore ||
      (score === bestCandidateScore &&
        score > 0 &&
        bestCandidate &&
        cand.updatedAtMs > bestCandidate.updatedAtMs)
    ) {
      bestCandidateScore = score;
      bestCandidate = cand;
    }
  }

  // Require strong confidence (>= 20) to route away from the origin session
  if (bestCandidate && bestCandidateScore >= 20) {
    return makeDecision(bestCandidate, `semantic_session_match:${Math.round(bestCandidateScore)}`);
  }

  // 4. Fallback to the origin session that produced the card
  if (fallback) {
    return makeDecision(fallback, "origin_card_session");
  }

  return null;
}

const DIRECT_CONV_HINT_RE = /conversation:\/\/[0-9a-fA-F]{7,36}(?:-[0-9a-fA-F]{4,12})*/;
const DIRECT_LABELED_SESSION_RE =
  /(?:子?会话|session|agent)\s*[：:（(\s`'"「]*[0-9a-fA-F]{7,36}(?:-[0-9a-fA-F]{4,12})*/i;
const DIRECT_UUID_RE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;
const DIRECT_WORKSPACE_TITLE_RE =
  /(?:工作区|workspace)\s*[「“"'《](?=[^」”"'》\n]*[^」”"'》\n\s])[^」”"'》\n]{2,80}[」”"'》]/i;

/**
 * Fast regex pre-check for whether a top-level wish explicitly references a session ID,
 * `conversation://` link, UUID, or quoted workspace title (e.g. `工作区「xxx」`).
 * Used to skip expensive `agents.list()` + `workspaces.list()` IPC calls on normal wishes.
 */
export function hasDirectSessionReferenceHint(text: string): boolean {
  if (!text) return false;
  return (
    DIRECT_CONV_HINT_RE.test(text) ||
    DIRECT_LABELED_SESSION_RE.test(text) ||
    DIRECT_UUID_RE.test(text) ||
    DIRECT_WORKSPACE_TITLE_RE.test(text)
  );
}

/**
 * Fast regex pre-check for whether a wish explicitly references an existing session
 * (conversation://, session/agent ID prefix, UUID, or quoted workspace title).
 * Used to skip expensive agents.list + workspaces.list IPC calls for ordinary wishes.
 */
export function hasDirectSessionReference(text: string): boolean {
  if (!text) return false;
  return (
    extractSessionIdHints(text).length > 0 ||
    extractWorkspaceTitleHints(text).length > 0
  );
}

/**
 * Locate an existing session explicitly referenced in a top-level wish
 * (via conversation://<id>, session/agent ID prefix, UUID, or quoted workspace title).
 * Intentionally avoids loose fuzzy routing so fresh wishes start clean new sessions.
 */
export function routeDirectWishToSession(input: {
  wish: string;
  candidates: readonly RoutableAgentCandidate[];
}): FollowUpRouteDecision | null {
  const usable = input.candidates.filter((c) => !c.isBackground);
  if (usable.length === 0) return null;

  const makeDecision = (
    chosen: RoutableAgentCandidate,
    reason: string,
  ): FollowUpRouteDecision => ({
    agentId: chosen.id,
    title: chosen.workspaceTitle || chosen.title || chosen.projectName || chosen.id.slice(0, 8),
    cwd: chosen.cwd,
    workspaceId: chosen.workspaceId,
    routedAwayFromOrigin: true,
    reason,
  });

  const sessionHints = extractSessionIdHints(input.wish);
  for (const hint of sessionHints) {
    const matched = findAgentByIdOrPrefix(hint, usable);
    if (matched) {
      return makeDecision(matched, `direct_wish_session_id:${hint}`);
    }
  }

  const wsHints = extractWorkspaceTitleHints(input.wish);
  for (const wsTitle of wsHints) {
    const lowerWs = wsTitle.toLowerCase();
    const wsMatches = usable
      .filter(
        (c) =>
          c.workspaceTitle?.toLowerCase() === lowerWs ||
          c.title.toLowerCase() === lowerWs ||
          c.workspaceTitle?.toLowerCase().includes(lowerWs),
      )
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    if (wsMatches[0]) {
      return makeDecision(wsMatches[0], `direct_wish_workspace:${wsTitle}`);
    }
  }

  return null;
}
