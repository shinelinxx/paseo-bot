import os from "node:os";
import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  ApprovalRiskSchema,
  GovernanceLevelSchema,
  TriggerKindSchema,
  type FeedAction,
} from "../shared/contracts";
import { createShortId } from "./storage";
import type { ProactiveEngine } from "./engine";

const ToolActionInputSchema = z.object({
  label: z.string().min(1).describe("Short button label, e.g. '一键归档' or '2小时后再提醒'"),
  kind: z
    .enum(["delegate", "wish", "self_wake"])
    .describe("delegate = background worker, wish = continue in session, self_wake = scheduled check"),
  prompt: z.string().min(1).describe("Actionable instructions executed when the user taps this button"),
  cwd: z.string().optional().describe("Optional target workspace directory"),
  targetAgentId: z
    .string()
    .optional()
    .describe("Optional specific session/agent ID (or prefix) to route this follow-up action directly into"),
  delayMinutes: z
    .number()
    .min(1)
    .max(60 * 24 * 14)
    .optional()
    .describe("Delay in minutes when kind='self_wake'"),
});

export function registerBotAgentTools(
  server: PluginServerContext,
  engine: ProactiveEngine,
): () => void {
  const createTriggerTool = defineAgentTool({
    name: "paseo_bot_create_trigger",
    description:
      "Create or update a persistent Paseo Bot trigger (file_watch, webhook, poll_command, or schedule).",
    input: z.object({
      id: z.string().optional().describe("Existing trigger ID when updating"),
      name: z.string().min(1).describe("Mission name"),
      kind: TriggerKindSchema.describe("file_watch | webhook | poll_command | schedule | self_wake"),
      governance: GovernanceLevelSchema.optional().describe("autonomous | notify | require_approval"),
      cwd: z.string().optional().describe("Workspace directory"),
      prompt: z.string().min(1).describe("Instructions when triggered"),
      watchPath: z.string().optional().describe("Target path for file_watch"),
      pollCommand: z.string().optional().describe("Shell command or URL for poll_command"),
      pollIntervalSec: z.number().int().min(10).max(604800).optional().describe("Seconds interval"),
      dailyTime: z.string().optional().describe("Daily local HH:mm for schedule, e.g. 09:00"),
      matchRegex: z.string().optional().describe("Optional regex filter"),
    }),
    async execute(input, { agent, paseo }) {
      engine.attachPaseo(paseo);
      const saved = await engine.upsertTrigger({
        ...input,
        cwd: input.cwd || agent.cwd || engine.getSettings().homeCwd,
      });
      const webhookBaseUrl = engine.getWebhookBaseUrl();
      const webhookUrl =
        saved.kind === "webhook" && saved.webhookKey && webhookBaseUrl
          ? `${webhookBaseUrl}/hook/${saved.webhookKey}`
          : undefined;
      return {
        text: [
          `Saved proactive trigger '${saved.name}' (id: ${saved.id}, kind: ${saved.kind}, enabled: ${saved.enabled}).`,
          webhookUrl ? `Webhook endpoint: POST ${webhookUrl}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        structuredContent: { trigger: saved, webhookUrl },
      };
    },
  });

  const listTriggersTool = defineAgentTool({
    name: "paseo_bot_list_triggers",
    description:
      "List all Paseo Bot proactive triggers, delegated workers, pending Sentinel approvals, and wake budget status.",
    input: z.object({}),
    async execute(_input, { paseo }) {
      engine.attachPaseo(paseo);
      const snap = await engine.getSnapshot({ includeMemory: false });
      return {
        text: JSON.stringify(
          {
            globalPaused: snap.globalPaused,
            hourlyWakes: `${snap.hourlyWakesUsed}/${snap.hourlyWakeLimit}`,
            webhookBaseUrl: snap.webhookBaseUrl,
            triggers: snap.triggers.map((t) => ({
              id: t.id,
              name: t.name,
              kind: t.kind,
              enabled: t.enabled,
              governance: t.governance,
              runCount: t.runCount,
              silentCount: t.silentCount,
              notifyCount: t.notifyCount,
              approvedCount: t.approvedCount,
              noiseRules: t.noiseRules,
              lastOutcome: t.lastOutcome,
              lastTriggeredAt: t.lastTriggeredAt,
              webhookKey: t.webhookKey,
            })),
            runningWorkers: snap.workers.filter((w) => w.status === "running"),
            pendingApprovals: snap.approvals.filter((a) => a.status === "pending"),
          },
          null,
          2,
        ),
      };
    },
  });

  const updateTriggerTool = defineAgentTool({
    name: "paseo_bot_update_trigger",
    description: "Enable, pause, or run a Paseo Bot trigger immediately by ID.",
    input: z.object({
      id: z.string().describe("Trigger ID"),
      enabled: z.boolean().optional().describe("Set true to enable, false to pause"),
      runNow: z.boolean().optional().describe("Set true to trigger an immediate evaluation run"),
    }),
    async execute({ id, enabled, runNow }, { paseo }) {
      engine.attachPaseo(paseo);
      if (enabled !== undefined) {
        const ok = await engine.toggleTrigger(id, enabled);
        if (!ok) return { isError: true, text: `Trigger ${id} not found.` };
      }
      if (runNow) {
        const res = await engine.dispatchTrigger(id, {
          reason: "agent_manual_run",
          detail: "Triggered manually from conversation.",
          manual: true,
        });
        return { text: res.message, isError: !res.ok };
      }
      return { text: `Updated trigger ${id} (enabled=${enabled}).` };
    },
  });

  const deleteTriggerTool = defineAgentTool({
    name: "paseo_bot_delete_trigger",
    description: "Permanently delete a Paseo Bot trigger by ID.",
    input: z.object({
      id: z.string().describe("Trigger ID to remove"),
    }),
    async execute({ id }, { paseo }) {
      engine.attachPaseo(paseo);
      const ok = await engine.deleteTrigger(id);
      if (!ok) return { isError: true, text: `Trigger ${id} not found.` };
      return { text: `Deleted trigger ${id}.` };
    },
  });

  const selfWakeTool = defineAgentTool({
    name: "paseo_bot_self_wake",
    description:
      "Schedule a self-wake check in N minutes to follow up on an ongoing multi-step goal (e.g. waiting for a reply, build, or status change). Automatically disables after firing once.",
    input: z.object({
      delayMinutes: z.number().min(1).max(60 * 24 * 14).describe("Minutes from now to wake up"),
      name: z.string().min(1).describe("Short label for this follow-up check"),
      followUpPrompt: z
        .string()
        .min(1)
        .describe("Context and instructions for your future self when waking up"),
      cwd: z.string().optional().describe("Workspace directory to wake up in"),
      governance: GovernanceLevelSchema.optional(),
    }),
    async execute({ delayMinutes, name, followUpPrompt, cwd, governance }, { agent, paseo }) {
      engine.attachPaseo(paseo);
      const onceAt = new Date(Date.now() + Math.round(delayMinutes * 60_000)).toISOString();
      const created = await engine.upsertTrigger({
        name: `Self-Wake · ${name}`,
        description: `Scheduled self-wake at ${onceAt}`,
        kind: "self_wake",
        governance: governance ?? "notify",
        executionTarget: "scout_helper",
        cwd: cwd || agent.cwd || engine.getSettings().homeCwd,
        prompt: followUpPrompt,
        onceAt,
        maxRuns: 1,
        cooldownSec: 0,
      });
      return {
        text: `Scheduled self-wake '${created.name}' (id: ${created.id}) for ${onceAt}.`,
        structuredContent: { triggerId: created.id, onceAt },
      };
    },
  });

  const delegateTaskTool = defineAgentTool({
    name: "paseo_bot_delegate_task",
    description:
      "Delegate a coding, research, or operational task asynchronously to a worker agent in a target workspace (local directory or isolated git worktree). Paseo Bot automatically monitors completion and collects results.",
    input: z.object({
      title: z.string().min(1).describe("Short title for the delegated task"),
      cwd: z.string().min(1).describe("Absolute path of the target project/workspace directory"),
      prompt: z.string().min(1).describe("Complete actionable brief for the worker agent"),
      provider: z
        .string()
        .optional()
        .describe("Optional provider/model override, e.g. codex/gpt-6.2-sol or antigravity/gemini-4-neon"),
      isolation: z
        .enum(["local", "worktree"])
        .optional()
        .describe("Use 'worktree' for isolated git branch work, or 'local' (default)"),
      notifyChiefOnFinish: z.boolean().optional(),
    }),
    async execute(input, { paseo }) {
      engine.attachPaseo(paseo);
      const worker = await engine.delegateTask(input);
      return {
        text: `Delegated '${worker.title}' to worker agent ${worker.agentId} in ${worker.cwd} (${worker.isolation}, model: ${worker.provider}). Paseo Bot will automatically report when it finishes or needs permission.`,
        structuredContent: worker,
      };
    },
  });

  const reportOutcomeTool = defineAgentTool({
    name: "paseo_bot_report_outcome",
    description:
      "Report the outcome of a proactive evaluation. Use level='silent' when nothing requires user attention (zero noise), or level='notify' to push an actionable card (with optional Layer-2 details and 1-tap Poke micro-actions) to Paseo Bot.",
    input: z.object({
      level: z.enum(["silent", "notify"]),
      title: z.string().optional().describe("Short headline (required when level='notify')"),
      summary: z
        .string()
        .min(1)
        .describe("Concise conclusion-first markdown summary (keep brief; put deep logs in details)"),
      details: z
        .string()
        .optional()
        .describe("Optional Layer-2 reasoning, evidence, or step breakdown (collapsed by default in UI)"),
      actions: z
        .array(ToolActionInputSchema)
        .max(3)
        .optional()
        .describe("Optional 1-3 one-tap follow-up buttons rendered directly on the card"),
    }),
    async execute({ level, title, summary, details, actions }, { agent, paseo }) {
      engine.attachPaseo(paseo);
      const normalizedActions: FeedAction[] = (actions ?? []).map((act) => ({
        id: createShortId("act"),
        label: act.label,
        kind: act.kind,
        prompt: act.prompt,
        cwd: act.cwd || agent.cwd || undefined,
        targetAgentId: act.targetAgentId?.trim() || undefined,
        delayMinutes: act.delayMinutes,
      }));

      if (agent.background) {
        engine.recordScoutOutcome(agent.id, {
          level,
          title,
          summary,
          details,
          actions: normalizedActions,
        });
        return {
          text:
            level === "silent"
              ? "Recorded silent exit. You may finish your turn now."
              : "Recorded proactive briefing card for Paseo Bot Inbox.",
        };
      }

      engine.markTurnReported(agent.id);
      await engine.upsertAgentFeedCard({
        agentId: agent.id,
        workspaceId: agent.workspaceId ?? undefined,
        level,
        title: title || agent.title || "Paseo Bot 动态",
        summary,
        details,
        actions: normalizedActions,
        notifyDesktop: level === "notify",
        appendChiefTimeline: level === "notify",
      });
      return { text: `Published ${level} outcome to Paseo Bot.` };
    },
  });

  const requestApprovalTool = defineAgentTool({
    name: "paseo_bot_request_approval",
    description:
      "Sentinel safety gate: pause before executing a sensitive, external, financial, or irreversible action and place an interactive staging approval card (with draft/command/diff preview) in Paseo Bot.",
    input: z.object({
      title: z.string().min(1).describe("Short title of the action needing approval"),
      actionSummary: z
        .string()
        .min(1)
        .describe("Clear explanation of what will happen, target recipients/files, and why"),
      payloadPreview: z
        .string()
        .optional()
        .describe("Exact staged draft (email To/Subject/Body, shell command, or diff) for user inspection"),
      payloadLanguage: z
        .string()
        .optional()
        .describe("Optional preview format hint, e.g. markdown, bash, json, diff"),
      riskLevel: ApprovalRiskSchema.optional().describe("low, medium, or high"),
      followUpPrompt: z
        .string()
        .min(1)
        .describe("Exact self-contained instructions to execute once the user clicks Approve"),
      cwd: z.string().optional().describe("Workspace directory where approved execution should run"),
    }),
    async execute(
      { title, actionSummary, payloadPreview, payloadLanguage, riskLevel, followUpPrompt, cwd },
      { agent, paseo },
    ) {
      engine.attachPaseo(paseo);
      const scoutMeta = engine.getScoutTriggerMeta(agent.id);
      const item = await engine.createApproval({
        title,
        actionSummary,
        payloadPreview,
        payloadLanguage,
        riskLevel: riskLevel ?? "medium",
        followUpPrompt,
        cwd: cwd || agent.cwd || os.homedir(),
        sourceAgentId: agent.id,
        triggerId: scoutMeta?.triggerId,
        triggerName: scoutMeta?.triggerName,
      });
      return {
        text: `Queued Sentinel approval '${item.title}' (id: ${item.id}). Stop here and wait for the user's decision.`,
        structuredContent: item,
      };
    },
  });

  const memoryReadTool = defineAgentTool({
    name: "paseo_bot_memory_read",
    description:
      "Read Paseo Bot's persistent Markdown memory (MEMORY.md) containing user preferences, goals, and workspace map.",
    input: z.object({}),
    async execute(_input, { paseo }) {
      engine.attachPaseo(paseo);
      const path = engine.getSettings().memoryFilePath;
      const content = await engine.store.readMemory(path);
      return {
        text: content || `(Memory file at ${path} is currently empty)`,
        structuredContent: { path, length: content.length },
      };
    },
  });

  const memoryWriteTool = defineAgentTool({
    name: "paseo_bot_memory_write",
    description:
      "Update Paseo Bot's persistent Markdown memory (MEMORY.md). Supports either appending a note to a section or replacing the full document while preserving YAML frontmatter.",
    input: z.object({
      mode: z.enum(["append_goal", "replace_all"]).default("append_goal"),
      content: z
        .string()
        .min(1)
        .describe("Bullet note to append, or full Markdown when mode='replace_all'"),
    }),
    async execute({ mode, content }, { paseo }) {
      engine.attachPaseo(paseo);
      const memPath = engine.getSettings().memoryFilePath;
      if (mode === "replace_all") {
        await engine.store.writeMemory(memPath, content);
      } else {
        await engine.store.appendMemoryNote(memPath, content);
      }
      await engine.broadcastSnapshot();
      return {
        text: `Updated Paseo Bot persistent memory at ${memPath}.`,
        structuredContent: { path: memPath },
      };
    },
  });

  const scoutTools = [
    reportOutcomeTool,
    requestApprovalTool,
    selfWakeTool,
    memoryReadTool,
    memoryWriteTool,
  ];

  const fullTools = [
    createTriggerTool,
    listTriggersTool,
    updateTriggerTool,
    deleteTriggerTool,
    selfWakeTool,
    delegateTaskTool,
    reportOutcomeTool,
    requestApprovalTool,
    memoryReadTool,
    memoryWriteTool,
  ];

  return server.addHook("agent.open.before", async ({ request }, { paseo }) => {
    engine.attachPaseo(paseo);
    if (request.purpose === "history") return;

    const role = request.labels["paseo-bot/role"];
    if (role === "scout") {
      return {
        ...request,
        tools: [...request.tools, ...scoutTools],
      };
    }

    if (role === "chief") {
      const memPath = engine.getSettings().memoryFilePath;
      const memory = await engine.store.readMemory(memPath);
      const state = engine.store.get();
      let activeTriggers = 0;
      for (const t of state.triggers) if (t.enabled) activeTriggers += 1;
      let runningWorkers = 0;
      for (const w of state.workers) if (w.status === "running") runningWorkers += 1;
      let pendingApprovals = 0;
      for (const a of state.approvals) if (a.status === "pending") pendingApprovals += 1;
      const activeSummary = [
        `Active Paseo Bot Triggers: ${activeTriggers}`,
        `Running Delegated Workers: ${runningWorkers}`,
        `Pending Sentinel Approvals: ${pendingApprovals}`,
      ].join(" | ");

      return {
        ...request,
        tools: [...request.tools, ...fullTools],
        appendSystemPrompt: [
          ...(request.appendSystemPrompt ?? []),
          [
            `[Paseo Bot Live State] ${activeSummary}`,
            `Note: All \`paseo_bot_*\` tools belong to the \`paseo\` MCP server (if a tool such as \`paseo_bot_create_trigger\` is lazy-loaded in your harness, call it via \`call_mcp_tool\` with ServerName="paseo" — no need to inspect plugin source files). Default model preference: \`antigravity/gemini-4-neon\`.`,
            `[Persistent Memory (${memPath})]\n${memory.slice(0, 6000)}`,
          ].join("\n\n"),
        ],
      };
    }

    if (!request.background && engine.getSettings().injectToolsGlobally) {
      return {
        ...request,
        tools: [...request.tools, ...fullTools],
        appendSystemPrompt: [
          ...(request.appendSystemPrompt ?? []),
          "Paseo Bot tools (`paseo_bot_*`) are available: if the user asks to set up a proactive monitor/trigger, schedule a self-wake check, delegate background work, or save long-term preferences, use the `paseo_bot_*` tools directly.",
        ],
      };
    }

    return;
  });
}
