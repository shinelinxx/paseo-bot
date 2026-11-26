# Paseo Bot

English | [简体中文](README.zh-CN.md)

A proactive background automation plugin for [Paseo](https://paseo.sh) with plain-language rule creation, zero-token diff checks, actionable update cards, staged confirmations, persistent Markdown memory (`MEMORY.md`), and cross-workspace subtask delegation.

## Features

- **Actionable Update Cards (No Log Walls)**
  - Unchanged routine checks exit silently in background scout sessions without cluttering your chat list.
  - Updates group cleanly into **Today** and **Earlier**, with expandable details, one-tap follow-up actions, inline follow-up replies, **Remind in 2h**, and **Useful / Fewer like this** filter controls that automatically update `MEMORY.md` and rule constraints.
- **Staged Confirmations & Progressive Auto-Run**
  - Outbound messages, financial actions, or irreversible changes pause in a confirmation card where you can view and edit the exact draft or instructions before running.
  - Confirm once, or choose **Confirm & Auto-Run Next Time** to promote trusted rules to run automatically.
- **One-Sentence Rule Builder & Five Trigger Engines**
  - Describe what to watch in plain language to auto-detect schedules, file watchers, webhooks, or zero-token command/URL diff checks (advanced parameters stay tucked away until needed).
  - Built-in engines: recursive file watching (with self-write loop protection), `127.0.0.1` HTTP webhooks, SHA-256 zero-token command/URL polling, daily/interval schedules, and agent-scheduled `self_wake` reminders.
- **Cross-Workspace Subtasks & Obsidian-Friendly Memory**
  - Delegate background subtasks to local directories or isolated Git worktrees via `paseo_bot_*` agent tools, `/wish <goal>`, or `/bot`.
  - Syncs preferences, active goals, and noise filters directly with a plain Markdown `MEMORY.md` file.

## Install

Requires Paseo `>= 0.17.4` with plugins enabled:

```bash
paseo plugin install github:shinelinxx/paseo-bot
```

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin install /absolute/path/to/paseo-bot
paseo plugin reload paseo-bot
```

## License

MIT
