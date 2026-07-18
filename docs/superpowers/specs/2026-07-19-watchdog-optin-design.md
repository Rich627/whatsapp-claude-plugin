# Watchdog Opt-in Design (v0.14.0)

Date: 2026-07-19
Status: approved (design confirmed with maintainer in session)

## Problem

`scripts/watchdog.sh` gives always-on deployments auto-recovery (nudge stuck
sessions, hard-restart dead ones, alert on auth failure), but installing it is a
manual copy + chmod + crontab edit buried in the script's header comment. Almost
no community user does it, so the plugin's most operationally valuable feature is
effectively unused.

## Goal

Setup asks one question — "want auto-recovery installed?" — and on yes performs
the install (copy + chmod + crontab entry) deterministically, with per-step
confirmation. Doctor's watchdog check points users at this flow.

## Decisions (confirmed by maintainer)

1. Everyone running setup gets asked (the target audience runs 24hr agents).
2. Claude performs the crontab edit itself — show the exact line first, confirm,
   append-only, verify after. Not instructions-for-the-user-to-paste.
3. Architecture: deterministic bun script + thin skill phase (doctor's proven
   pattern). Rejected: pure SKILL.md (every session would improvise the crontab
   mutation — the one step that must never be improvised); doctor-fix-item
   (wrong entry point; setup is where new users are).
4. Release as v0.14.0; commit locally, maintainer reviews before push.

## Component 1: `scripts/install-watchdog.ts`

Bun script, no new dependencies, no imports from `server.ts`. Honors
`WHATSAPP_STATE_DIR` (default `~/.whatsapp-channel`) for testability, same as
`doctor.ts`. Output uses doctor's line contract:
`[PASS|INFO|WARN|ERROR] <check-id>: <message>`, always exit 0.

Subcommands:

- **`status`** (default) — reports: watchdog.sh present at
  `$STATE_DIR/watchdog.sh`? executable? crontab has a line referencing that
  path? Logic mirrors doctor's `checkWatchdog` (scripts/doctor.ts:443).
- **`install`** —
  1. Copy repo `scripts/watchdog.sh` (script-relative path) →
     `$STATE_DIR/watchdog.sh`, `chmod +x`.
     **Exception:** if the target exists with content differing from the repo
     copy, do NOT overwrite — WARN that the file was customized (deployments
     like mini carry local edits) and leave it; continue to the crontab step.
     Identical content → PASS (idempotent re-run).
  2. Crontab: read `crontab -l` (absent crontab == empty). If any line already
     references `$STATE_DIR/watchdog.sh` → PASS, skip. Otherwise append
     `*/2 * * * * $HOME/.whatsapp-channel/watchdog.sh >> $HOME/.whatsapp-channel/watchdog.log 2>&1`
     (with `$STATE_DIR` substituted when overridden) and write back via
     `crontab -`. Never touches existing lines; append-only.
  3. Print resulting status.
- **`uninstall`** — removes only the crontab line(s) referencing
  `$STATE_DIR/watchdog.sh`; leaves the file in place (cron-less script is
  inert). For regretful users and test cleanup.

### Testability

`scripts/install-watchdog.test.ts` (bun test). The script invokes `crontab` via
PATH lookup; tests prepend a fixture dir containing a stub `crontab` script that
records reads/writes to files, plus a fixture `WHATSAPP_STATE_DIR`. No test
touches the real crontab or real state dir. Cases:

- fresh install (no file, empty crontab) → file copied, executable, line added
- re-run install → idempotent, no duplicate crontab line, no rewrite
- customized existing watchdog.sh → not overwritten, WARN emitted, crontab
  still handled
- pre-existing unrelated crontab lines → preserved byte-for-byte, new line
  appended
- uninstall → only the watchdog line removed, file left behind
- status on each of the above states

## Component 2: `skills/setup/SKILL.md` — new Phase 5

Current Phase 5 (Done) renumbers to Phase 6. New Phase 5 "Auto-recovery
(watchdog)":

1. Plain-language pitch: a cron job every 2 minutes that detects a stuck or
   dead agent and nudges/restarts it, and alerts if API auth breaks. Note the
   prerequisite: the nudge/restart mechanics act on a tmux session named
   `whatsapp-agent` — if the agent runs some other way, the watchdog can detect
   but not revive it. Ask: install it?
2. If yes: run `status` and show current state → show the exact crontab line
   that will be appended → on confirmation run `install` → show `status`
   output as verification. If the current session appears not to be inside
   tmux, add a one-line reminder of the tmux invocation
   (`tmux new-session -s whatsapp-agent claude`).
3. If no: one sentence — re-run setup later to install. Mention notify-hook as
   an advanced option documented in the watchdog.sh header; don't elaborate.

## Component 3: doctor linkage

`doctor.ts` watchdog-absent INFO message changes from pointing at the repo
script to: "run `/whatsapp-claude-channel:setup` to install auto-recovery".
Matching assertion update in `doctor.test.ts`. `server.ts` untouched.

## Out of scope

- Scaffolding the always-on deployment itself (tmux + start script) — v0.15.0
  headless guide territory.
- systemd/Linux variants of the watchdog (v0.15.0).
- notify-hook setup flow (header docs only).
- Any change to watchdog.sh behavior.

## Release & verification

- Version bump 0.13.1 → 0.14.0 in BOTH `.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json` `plugins[0].version`; verify with the
  three-line grep per CLAUDE.md Hard Rule 1.
- `bun test` green (existing doctor tests + new install-watchdog tests).
- Live verification on this machine: `status` only — no real install here
  (this Mac is not an always-on deployment), and mini is not touched at all.
- Lint the full diff (all changed files, docs included) with
  `~/.cache/trunk/launcher/trunk check` before push.
- Commit locally on main; maintainer reviews before push.
