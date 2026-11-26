Paseo Bot adds persistent background rules, long-term Markdown memory, staged confirmations, and cross-workspace subtask delegation to Paseo.

## How it works

You submit tasks or plain-language rules in the Paseo Bot screen, with `/wish`, or in conversation with any agent. Paseo Bot turns ongoing goals into background rules or delegates subtasks to workspace agents while storing preferences and filter rules in a Markdown memory file.

Key interaction capabilities:

1. Clean status header that shows a concise summary by default and folds hourly run quotas and webhook URLs into an expandable status drawer.
2. Actionable update cards grouped into Today and Earlier, with one-tap follow-up buttons, inline replies, two-hour reminders, and feedback controls (`Useful` / `Fewer like this`) that save filter rules back to `MEMORY.md` and the originating rule.
3. Staged confirmation cards that let you view and edit execution content before running, confirm once, or switch the rule to run automatically next time.
4. One-sentence rule generator and rule suggestions for directories with repeated manual tasks.

Five event sources run in the daemon subprocess:

1. Recursive file watching with debounce and self-write loop protection.
2. Local HTTP webhooks bound to `127.0.0.1` with optional shared-secret verification.
3. Zero-token diff polling for shell commands or HTTP URLs that invokes a model only when the SHA-256 output fingerprint changes.
4. Interval, daily, and one-shot schedules.
5. Agent-scheduled one-time reminders for multi-step follow-ups.

## Setup and permissions

Requires Paseo 0.17.4 or later on a host with at least one configured agent provider. Plugin state is stored under `$PASEO_HOME/plugin-data/paseo-bot/state.json`. Long-term memory reads and writes the configured Markdown file path. When enabled, the webhook listener binds only to `127.0.0.1` on the configured port.
