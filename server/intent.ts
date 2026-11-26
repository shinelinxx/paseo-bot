import os from "node:os";
import path from "node:path";
import type {
  ApprovalItem,
  FeedFeedback,
  FeedItem,
  GovernanceLevel,
  MissionDraft,
  RoutineSuggestion,
  TriggerKind,
} from "../shared/contracts";
import { expandHomePath, type PersistedBotState } from "./storage.ts";

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

export function inferWorkspaceAndWatchPath(
  intent: string,
  defaultCwd: string,
): { cwd: string; watchPath?: string } {
  const resolvedDefault = expandHomePath(defaultCwd);

  const pathMatch = /(?:^|\s)((?:~\/|\/Users\/|\/home\/|\/tmp\/|\/var\/|\/opt\/)[^\s,，。；;'"`]+)/.exec(
    intent,
  );
  if (pathMatch) {
    const resolved = expandHomePath(pathMatch[1]);
    return { cwd: resolved, watchPath: resolved };
  }

  const homeDocs = path.join(os.homedir(), "Documents");
  // Match ~/Documents/<ProjectName> when an explicit CamelCase/hyphenated project name is mentioned
  const docProjMatch = /\b([A-Z][A-Za-z0-9_-]{2,30})\b/.exec(intent);
  if (docProjMatch && !/^(HTTP|HTTPS|JSON|HTML|YAML|UTF|SHA|API|URL|PDF|CSV)$/i.test(docProjMatch[1])) {
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

export function draftMissionFromIntent(intent: string, defaultCwd: string): MissionDraft {
  const cleanIntent = intent.trim();
  const { cwd, watchPath: inferredWatchPath } = inferWorkspaceAndWatchPath(
    cleanIntent,
    defaultCwd,
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
  state: PersistedBotState,
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
