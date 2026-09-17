# AGENTS.md

Guidance for AI coding agents working in this repository. Read this file fully, then use the
routing table at the bottom before starting any non-trivial task.

## Project Overview

WhatsApp MCP Server plugin for Claude Code — connects WhatsApp as a messaging channel
via the linked-device protocol (Baileys). Bidirectional messaging, media, voice
transcription, access control, per-group AI personalities, cron tasks. Published on
claude.com/plugins.

## Tech Stack & Commands

- **Runtime:** Bun — TypeScript runs directly. No build step.
- **Deps (only 3 — no new dependencies without the user's explicit approval):**
  `@modelcontextprotocol/sdk`, `@whiskeysockets/baileys@7.0.0-rc.9`,
  `@inquirer/prompts`
  (4 known rc.9 bugs are patched by `patch-baileys.mjs` via postinstall).
- **Tests:** there IS a test suite — 22 `*.test.ts` files under `lib/` and
  `scripts/`, run with `bun test`. There is no `test` script in `package.json`;
  `bun test` finds them itself.
- **Linting:** Trunk (prettier, markdownlint, shellcheck, shfmt, checkov, trufflehog).
  Trunk is not installed on every machine — check before assuming `trunk check` runs.

```bash
bun install     # install deps (postinstall runs patch-baileys.mjs)
bun server.ts   # run the MCP server
bun test        # ~130s, spawns real servers — see the warning below
trunk check     # lint
trunk fmt       # format
```

**Type checking — `bun build` is NOT a type check.** `bun build` is a bundler: it
resolves and emits, it does not check types, so an out-of-scope or misspelled
identifier bundles happily and tells you nothing. Use `tsc` directly. This repo
has no `tsconfig.json` and no local `typescript` dependency, so pass the options
on the command line (verified 2026-09-08: exit 0, no errors):

```bash
bunx --bun typescript@5 --noEmit --skipLibCheck \
  --target esnext --module preserve --moduleResolution bundler \
  --strict server.ts
```

`--strict` is load-bearing, not decoration: without it you get two phantom
TS2339s in `lib/mentions.ts` that do not exist under strict mode. Note the
invocation is `bunx typescript@5 <options>` — `bunx typescript@5 tsc ...` fails,
because bunx already resolves the package's `tsc` binary and the extra `tsc`
is then read as a filename to compile.

**Never run `bun test` concurrently with another `bun test` or with a forked
review agent.** The IPC tests spawn real servers and contend on the singleton
lock. Run it to a log and grep the summary — piping to `tail` hides failures.

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
                            ├─ messages.jsonl   (inbound + owner/Claude context lines, pruned
                            │                    hourly to WHATSAPP_MESSAGE_TTL_DAYS, default 7)
                            ├─ sent.jsonl       (id + ts of the plugin's own sends, 24h)
                            ├─ .aged-out-chats.json  (hashed chat_id -> when a WAITING line
                            │                    was pruned; 30 days; never written in static mode)
                            └─ inbox/     (attachments, pruned to the same horizon as messages.jsonl)
```

- **`server.ts`** — the entire MCP server in one file (~5400 lines; re-check with
  `wc -l` rather than trusting this number). MCP tools exposed to Claude: `reply`,
  `react`, `download_attachment`, `edit_message`, `status`, `unreplied`, `catch_up`,
  `list_groups`.
  Also contains: access-control engine (DM policies `pairing`/`allowlist`/`disabled`,
  group policies, pairing codes with 1-hour TTL, LID↔phone mapping), message pipeline
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
   **Same ritual, third step: write the banner notes.** Add or extend the entry for
   that version in `scripts/update-notice.ts`'s `CHANGELOG`. The note text is
   hand-written per release — nothing derives it — so a bump without it ships a
   release the banner never mentions, or worse, leaves an older note standing that
   the new release just made false (that is how the 0.23.0 permissions note ended up
   telling users a still-broken block was fixed). **One short line per change, under
   ~100 characters.** A note that will not fit is two notes, never a wrapped
   paragraph: they are joined with a blank line between bullets and read at session
   start, and 0.22.0 once stacked thirteen paragraphs there.
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
