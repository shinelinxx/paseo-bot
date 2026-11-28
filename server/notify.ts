import type { PaseoApi } from "@getpaseo/client";
import { execCommand } from "@getpaseo/plugin/server";
import {
  BOT_ALERT_TIMELINE_KIND,
  BOT_APPROVAL_TIMELINE_KIND,
  type ApprovalItem,
  type BotAlertTimelineData,
  type BotApprovalTimelineData,
  type FeedItem,
} from "../shared/contracts.ts";

export async function sendDesktopNotification(opts: {
  enabled: boolean;
  title: string;
  subtitle?: string;
  body: string;
}): Promise<void> {
  if (!opts.enabled || process.platform !== "darwin") return;
  const cleanBody = opts.body.replace(/\s+/g, " ").trim().slice(0, 220);
  const cleanTitle = opts.title.trim().slice(0, 80);
  const cleanSubtitle = opts.subtitle?.trim().slice(0, 80);
  const jxa = [
    "const app = Application.currentApplication();",
    "app.includeStandardAdditions = true;",
    `app.displayNotification(${JSON.stringify(cleanBody)}, {`,
    `  withTitle: ${JSON.stringify(cleanTitle)},`,
    ...(cleanSubtitle ? [`  subtitle: ${JSON.stringify(cleanSubtitle)},`] : []),
    "});",
  ].join("\n");

  try {
    await execCommand("osascript", ["-l", "JavaScript", "-e", jxa], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
  } catch (err) {
    console.error("[paseo-bot] desktop notification failed:", err);
  }
}

export async function appendChiefAlertCard(
  paseo: PaseoApi | null,
  chiefAgentId: string | null,
  feed: FeedItem,
): Promise<void> {
  if (!paseo || !chiefAgentId) return;
  const data: BotAlertTimelineData = {
    feedId: feed.id,
    level: feed.level,
    title: feed.title,
    summary: feed.summary.slice(0, 2000),
    details: feed.details?.slice(0, 3000),
    actions: feed.actions ?? [],
    feedback: feed.feedback,
    triggerId: feed.triggerId,
    triggerName: feed.triggerName,
    workerAgentId: feed.agentId,
    routedAgentId: feed.routedAgentId,
    routedAgentTitle: feed.routedAgentTitle,
    createdAt: feed.createdAt,
  };
  try {
    await paseo.agents.ref(chiefAgentId).timeline.append({
      type: "plugin",
      id: `feed-${feed.id}`,
      kind: BOT_ALERT_TIMELINE_KIND,
      version: 1,
      data,
    });
  } catch {
    // Host may not support pluginTimelineItems or Chief agent may be closed/archived.
  }
}

export async function upsertChiefApprovalCard(
  paseo: PaseoApi | null,
  chiefAgentId: string | null,
  approval: ApprovalItem,
): Promise<void> {
  if (!paseo || !chiefAgentId) return;
  const data: BotApprovalTimelineData = {
    approvalId: approval.id,
    status: approval.status,
    title: approval.title,
    actionSummary: approval.actionSummary.slice(0, 2000),
    riskLevel: approval.riskLevel,
    cwd: approval.cwd,
    payloadPreview: approval.payloadPreview?.slice(0, 6000),
    payloadLanguage: approval.payloadLanguage,
    followUpPrompt: approval.followUpPrompt.slice(0, 4000),
    triggerId: approval.triggerId,
    triggerName: approval.triggerName,
    decisionNote: approval.decisionNote,
    promotedTrust: approval.promotedTrust,
    createdAt: approval.createdAt,
    resolvedAt: approval.resolvedAt,
  };
  try {
    await paseo.agents.ref(chiefAgentId).timeline.append({
      type: "plugin",
      id: `approval-${approval.id}`,
      kind: BOT_APPROVAL_TIMELINE_KIND,
      version: 1,
      data,
    });
  } catch {
    // Ignore when unavailable.
  }
}
