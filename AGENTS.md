# AGENTS.md

Guidance for AI coding agents working in this repository. Read this file fully, then use the
routing table at the bottom before starting any non-trivial task.

## Project Overview

WhatsApp MCP Server plugin for Claude Code — connects WhatsApp as a messaging channel
via the linked-device protocol (Baileys). Bidirectional messaging, media, voice
transcription, access control, per-group AI personalities, cron tasks. Published on
claude.com/plugins.

## Tech Stack & Commands

- **Runtime:** Bun — TypeScript runs directly. No build step. No test suite.
- **Deps (only 2 — no new dependencies without the user's explicit approval):**
  `@modelcontextprotocol/sdk`, `@whiskeysockets/baileys@7.0.0-rc.9`
  (4 known rc.9 bugs are patched by `patch-baileys.mjs` via postinstall).
- **Linting:** Trunk (prettier, markdownlint, shellcheck, shfmt, checkov, trufflehog).

```bash
bun install     # install deps (postinstall runs patch-baileys.mjs)
bun server.ts   # run the MCP server
trunk check     # lint
trunk fmt       # format
```

## Architecture

```
WhatsApp (phone) ←─ Baileys ─→ MCP Server (server.ts) ←─ stdio ─→ Claude Code
                                      ↓
                       ~/.whatsapp-channel/ (runtime state, never in repo)
                            ├─ access.json
                            ├─ .baileys_auth/
                            ├─ groups/<groupJid>/   (config.md = personality + cron,
                            │                        memory.md = conversation memory)
                            ├─ tasks.md   (agent-maintained open-task list, read by catch_up)
                            └─ inbox/
```

- **`server.ts`** — the entire MCP server in one file (~1900 lines; re-check with
  `wc -l` rather than trusting this number). MCP tools exposed to Claude: `reply`,
  `react`, `download_attachment`, `edit_message`, `status`, `unreplied`, `catch_up`,
  `list_groups`.
  Also contains: access-control engine (DM policies `pairing`/`allowlist`/`disabled`,
  group policies, pairing codes with 5-min TTL, LID↔phone mapping), message pipeline
  (access gate → routing → mention detection → text/media extraction → optional
  transcription → 4096-char chunking in `length` or `newline` mode per
  `access.json`'s `chunkMode`), per-group personality loading, cron parser (reads the
  `## Cron Jobs` section — exactly that heading — in each group's `config.md`).
- **`skills/`** — user-facing commands: `/whatsapp-channel:setup`,
  `:configure`, `:access`.
- **`hooks/hooks.json`** → `hooks-handlers/session-start.sh` — onboarding detection at
  session start.
- **`scripts/watchdog.sh`, `scripts/whisper-transcribe.sh`** — reference scripts users
  copy out of the repo (watchdog to `~/.whatsapp-channel/watchdog.sh`; the whisper
  script to `~/whisper-transcribe.sh` — server.ts hardcodes that home-dir path).
  Editing them in the repo does NOT affect running deployments until re-copied.

## Hard Rules (each one exists because it was violated before — evidence in docs/governance/A-diagnosis.md)

1. **Version bump on every push.** Bump BOTH `.claude-plugin/marketplace.json` (the
   inner `plugins[0].version`) AND `.claude-plugin/plugin.json`. Before committing,
   verify: `grep -n '"version"' .claude-plugin/marketplace.json .claude-plugin/plugin.json`
   — this prints THREE version lines; IGNORE marketplace's top-level `version` (that's
   the marketplace's own). Compare marketplace's `plugins[0].version` with plugin.json's
   `version`: they must match each other and be newer than before. Skipping one makes
   `plugin update` silently no-op for users. Semver: patch for fixes, minor for
   features.
2. **Danger zones in `server.ts`:** connection lifecycle, the singleton lock, and
   allowlist/access gating have each regressed before. Before editing them, grep the
   whole file for every symbol you touch (`grep -n <symbol> server.ts` — module-level
   state crosses the whole file). After editing, name in your summary the invariant you
   preserved (e.g. "lock survives PID reuse"). Can't name one → stop and re-read.
3. **Remote commands to `mini` (or any unattended host):** anything beyond a quick
   status check must use `timeout <seconds>` or run backgrounded with output redirected
   to a log you then read. Never a bare blocking long-running command over ssh. Check
   current state (tmux session? process? lockfile?) before restarting anything there.
4. **State lives in `~/.whatsapp-channel/`**, created at runtime — never write runtime
   state into the repo.

## Routing — read the matching governance file BEFORE starting the task

All in `docs/governance/`:

| Situation                                                                      | Read                                                  |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Delegating work to subagents, or choosing model/effort for one                 | `C-model-dispatch.md`                                 |
| Deciding: am I done? escalate? ask the user? is my approach wrong?             | `D-judgment-rubric.md`                                |
| Writing a subagent prompt (search / implement / refactor / research / review)  | `E-dispatch-templates.md`                             |
| You learned a lesson, hit a new failure mode, or want to edit governance files | `F-maintenance-protocol.md`                           |
| Session start on substantial work, or when disoriented                         | `G-letter-to-future-sessions.md` and `A-diagnosis.md` |

These files are the operating system for this environment, written deliberately on
2026-07-03 to make future sessions reliable. Don't casually override them; change them
only per `F-maintenance-protocol.md`.
