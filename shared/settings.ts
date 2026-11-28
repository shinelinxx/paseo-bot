import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const BotSettingsSchema = z.object({
  globalPaused: z.boolean().default(false),
  wishSessionMode: z.enum(["per_wish", "shared_chief"]).default("per_wish"),
  butlerName: z.string().default("Paseo Bot"),
  userName: z.string().default(""),
  fastProvider: z.string().default("antigravity/gemini-3.8-flash"),
  fastFallbackProvider: z.string().default("antigravity/gemini-4-hydrogen"),
  fastThinking: z.string().default("low"),
  execProvider: z.string().default("antigravity/gemini-4-carbon"),
  execThinking: z.string().default("medium"),
  deepProvider: z.string().default("antigravity/gemini-4-neon"),
  deepThinking: z.string().default("high"),
  chiefProvider: z.string().default("antigravity/gemini-4-carbon"),
  chiefModeId: z.string().default("auto"),
  scoutProvider: z.string().default("antigravity/gemini-4-carbon"),
  scoutModeId: z.string().default("full-access"),
  defaultWorkerProvider: z.string().default("antigravity/gemini-4-carbon"),
  defaultWorkerModeId: z.string().default("auto"),
  homeCwd: z.string().default("~/Documents/KnowledgeBase"),
  memoryFilePath: z
    .string()
    .default("~/Documents/KnowledgeBase/10-Projects/Paseo-Bot/MEMORY.md"),
  webhookEnabled: z.boolean().default(true),
  webhookPort: z.number().int().min(1024).max(65535).default(16789),
  webhookSecret: z.string().default(""),
  desktopNotify: z.boolean().default(true),
  hourlyWakeLimit: z.number().int().min(1).max(200).default(24),
  injectToolsGlobally: z.boolean().default(true),
  autoRenameOnFirstTurn: z.boolean().default(true),
  duplicateSessionHintOnCreate: z.boolean().default(true),
  tidyIdleArchiveHours: z.number().int().min(1).max(720).default(24),
  tidyWriteObsidianDigest: z.boolean().default(true),
  hidePinnedEmptyProjects: z.boolean().default(true),
});

export type BotSettings = z.output<typeof BotSettingsSchema>;

export const DEFAULT_BOT_SETTINGS: BotSettings = BotSettingsSchema.parse({});

export const paseoBotSettings = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: BotSettingsSchema,
});
