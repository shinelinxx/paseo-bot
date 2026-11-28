import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GovernanceLevel, NativeScheduleItem } from "../shared/contracts";

export function getPaseoSchedulesDir(): string {
  const paseoHome = process.env.PASEO_HOME?.trim() || path.join(os.homedir(), ".paseo");
  return path.join(paseoHome, "schedules");
}

export function getDefaultLocalTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
    if (tz) return tz;
  } catch {
    // Ignore
  }
  return "Asia/Shanghai";
}

export function extractSimpleDailyTimeFromCron(cronExpr?: string): string | undefined {
  if (!cronExpr) return undefined;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [minStr, hourStr, dom, mon, dow] = parts;
  if (dom !== "*" || mon !== "*" || dow !== "*") return undefined;
  if (!/^\d{1,2}$/.test(minStr) || !/^\d{1,2}$/.test(hourStr)) return undefined;
  const min = Number.parseInt(minStr, 10);
  const hour = Number.parseInt(hourStr, 10);
  if (min < 0 || min > 59 || hour < 0 || hour > 23) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function resolveScheduleCadenceArgs(input: {
  cron?: string;
  dailyTime?: string;
  everySec?: number;
  timezone?: string;
}):
  | { mode: "cron"; cron: string; timezone: string }
  | { mode: "every"; every: string } {
  const timezone = input.timezone?.trim() || getDefaultLocalTimezone();
  const cleanCron = input.cron?.trim().replace(/\s+/g, " ");
  if (cleanCron) {
    const parts = cleanCron.split(" ");
    if (parts.length === 5) {
      return { mode: "cron", cron: cleanCron, timezone };
    }
  }

  const cleanDaily = input.dailyTime?.trim();
  if (cleanDaily) {
    const match = /^([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)$/.exec(cleanDaily);
    if (match) {
      const hour = Number.parseInt(match[1], 10);
      const min = Number.parseInt(match[2], 10);
      return {
        mode: "cron",
        cron: `${min} ${hour} * * *`,
        timezone,
      };
    }
  }

  const sec = Math.max(60, Math.round(input.everySec ?? 3600));
  if (sec % 3600 === 0) {
    return { mode: "every", every: `${sec / 3600}h` };
  }
  return { mode: "every", every: `${Math.max(1, Math.round(sec / 60))}m` };
}

export function buildNativeSchedulePromptWithGovernance(
  rawPrompt: string,
  governance?: GovernanceLevel,
  noiseRules?: readonly string[],
): string {
  const base = rawPrompt.trim();
  if (!base) return base;

  const extraBlocks: string[] = [];
  if (noiseRules && noiseRules.length > 0 && !base.includes("过滤条件")) {
    extraBlocks.push(
      ["### 过滤条件（命中以下情况直接静默跳过）", ...noiseRules.map((r, i) => `${i + 1}. ${r}`)].join(
        "\n",
      ),
    );
  }

  const mentionsBotTools =
    base.includes("paseo_bot_report_outcome") || base.includes("paseo_bot_request_approval");
  if (!mentionsBotTools && governance) {
    if (governance === "require_approval") {
      extraBlocks.push(
        "[Paseo Bot 联动准则] 如需执行外发消息、资金操作或不可逆修改，必须先调用 `paseo_bot_request_approval`（附带 `payloadPreview`）等待确认；如无变化或无需关注，调用 `paseo_bot_report_outcome`（`level: \"silent\"`）静默结束；如有结果需提醒，调用 `paseo_bot_report_outcome`（`level: \"notify\"`）同步卡片。",
      );
    } else if (governance === "notify") {
      extraBlocks.push(
        "[Paseo Bot 联动准则] 如检查无实质变化，调用 `paseo_bot_report_outcome`（`level: \"silent\"`）静默结束；如有值得关注的进展或异常，调用 `paseo_bot_report_outcome`（`level: \"notify\"`）推送精炼摘要卡片。",
      );
    }
  }

  return extraBlocks.length > 0 ? `${base}\n\n${extraBlocks.join("\n\n")}` : base;
}

export function parseNativeScheduleRecord(
  raw: unknown,
): (NativeScheduleItem & { createdAtMs: number }) | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const id = String(rec.id ?? "").trim();
  if (!id) return null;

  const name = String(rec.name ?? id).trim() || id;
  const prompt = typeof rec.prompt === "string" ? rec.prompt : "";

  let cadence = "";
  let cronExpression: string | undefined;
  let timezone: string | undefined;
  let every: string | undefined;

  if (typeof rec.cadence === "string") {
    cadence = rec.cadence.trim();
    const cronMatch = /^cron:([^\s]+\s+[^\s]+\s+[^\s]+\s+[^\s]+\s+[^\s]+)(?:\s*\(([^)]+)\))?/.exec(
      cadence,
    );
    if (cronMatch) {
      cronExpression = cronMatch[1].trim();
      timezone = cronMatch[2]?.trim() || undefined;
    } else if (cadence.startsWith("every:")) {
      every = cadence.slice("every:".length).trim() || undefined;
    }
  } else if (rec.cadence && typeof rec.cadence === "object") {
    const cadObj = rec.cadence as Record<string, unknown>;
    if (cadObj.type === "cron" && typeof cadObj.expression === "string") {
      cronExpression = cadObj.expression.trim();
      timezone =
        typeof cadObj.timezone === "string" && cadObj.timezone.trim()
          ? cadObj.timezone.trim()
          : undefined;
      cadence = timezone
        ? `cron:${cronExpression} (${timezone})`
        : `cron:${cronExpression}`;
    } else if (typeof cadObj.every === "string" && cadObj.every.trim()) {
      every = cadObj.every.trim();
      cadence = `every:${every}`;
    } else if (typeof cadObj.expression === "string" && cadObj.expression.trim()) {
      every = cadObj.expression.trim();
      cadence = `every:${every}`;
    } else if (typeof cadObj.intervalMs === "number" && Number.isFinite(cadObj.intervalMs)) {
      const mins = Math.max(1, Math.round(cadObj.intervalMs / 60_000));
      every = mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
      cadence = `every:${every}`;
    }
  }

  let target = "";
  let provider = "";
  let cwd = "";
  let modeId: string | undefined;

  if (typeof rec.target === "string") {
    target = rec.target.trim();
    provider = target.replace(/^new-agent:/, "").trim();
  } else if (rec.target && typeof rec.target === "object") {
    const tObj = rec.target as Record<string, unknown>;
    const cfg = (
      tObj.config && typeof tObj.config === "object" ? tObj.config : {}
    ) as Record<string, unknown>;
    const rawProv = typeof cfg.provider === "string" ? cfg.provider.trim() : "";
    const rawModel = typeof cfg.model === "string" ? cfg.model.trim() : "";
    provider =
      rawProv && rawModel && !rawProv.includes("/")
        ? `${rawProv}/${rawModel}`
        : rawProv || rawModel;
    cwd = typeof cfg.cwd === "string" ? cfg.cwd.trim() : "";
    modeId = typeof cfg.modeId === "string" && cfg.modeId.trim() ? cfg.modeId.trim() : undefined;
    const tType = typeof tObj.type === "string" && tObj.type.trim() ? tObj.type.trim() : "new-agent";
    target = provider ? `${tType}:${provider}` : tType;
  }

  let runCount = 0;
  let lastRunStatus: string | undefined;
  let lastRunAgentId: string | undefined;
  let lastRunError: string | undefined;

  if (Array.isArray(rec.runs) && rec.runs.length > 0) {
    runCount = rec.runs.length;
    const latest = rec.runs[rec.runs.length - 1] as Record<string, unknown> | undefined;
    if (latest && typeof latest === "object") {
      if (typeof latest.status === "string" && latest.status.trim()) {
        lastRunStatus = latest.status.trim();
      }
      if (typeof latest.agentId === "string" && latest.agentId.trim()) {
        lastRunAgentId = latest.agentId.trim();
      }
      if (typeof latest.error === "string" && latest.error.trim()) {
        lastRunError = latest.error.trim();
      }
    }
  }

  const createdAtRaw = typeof rec.createdAt === "string" ? Date.parse(rec.createdAt) : 0;
  const createdAtMs = Number.isFinite(createdAtRaw) ? createdAtRaw : 0;

  return {
    id,
    name,
    prompt,
    cadence,
    cronExpression,
    timezone,
    every,
    cwd,
    target,
    provider,
    modeId,
    status: String(rec.status ?? "active"),
    nextRunAt: typeof rec.nextRunAt === "string" ? rec.nextRunAt : null,
    lastRunAt: typeof rec.lastRunAt === "string" ? rec.lastRunAt : null,
    lastRunStatus,
    lastRunAgentId,
    lastRunError,
    runCount,
    createdAtMs,
  };
}

export async function readNativeSchedulesFromDisk(
  schedulesDir = getPaseoSchedulesDir(),
): Promise<NativeScheduleItem[] | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(schedulesDir);
  } catch {
    return null;
  }

  const jsonFiles = entries.filter(
    (name) => name.endsWith(".json") && !name.startsWith(".") && !name.endsWith(".tmp"),
  );
  if (jsonFiles.length === 0) return [];

  const parsed = await Promise.all(
    jsonFiles.map(async (file) => {
      try {
        const raw = await fs.readFile(path.join(schedulesDir, file), "utf8");
        return parseNativeScheduleRecord(JSON.parse(raw));
      } catch {
        return null;
      }
    }),
  );

  const valid = parsed.filter(
    (item): item is NativeScheduleItem & { createdAtMs: number } => item !== null,
  );
  valid.sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));

  return valid.map(({ createdAtMs: _ignored, ...rest }) => rest);
}
