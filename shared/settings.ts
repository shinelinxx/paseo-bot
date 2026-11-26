import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const BotSettingsSchema = z.object({
  globalPaused: z.boolean().default(false),
  wishSessionMode: z.enum(["per_wish", "shared_chief"]).default("per_wish"),
  chiefProvider: z.string().default("antigravity/gemini-4-neon"),
  chiefModeId: z.string().default("auto"),
  scoutProvider: z.string().default("antigravity/gemini-4-neon"),
  scoutModeId: z.string().default("full-access"),
  defaultWorkerProvider: z.string().default("antigravity/gemini-4-neon"),
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
});

export type BotSettings = z.output<typeof BotSettingsSchema>;

export const DEFAULT_BOT_SETTINGS: BotSettings = BotSettingsSchema.parse({});

export const paseoBotSettings = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: BotSettingsSchema,
});
