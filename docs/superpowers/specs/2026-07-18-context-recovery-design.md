# Context Recovery After Agent Restart — Design

**Date:** 2026-07-18
**Status:** Approved by Rich (2026-07-18 session)
**Problem:** When the agent session restarts (crash, watchdog hard-restart, redeploy),
the new session has no idea what the conversation was about or what tasks were
in flight. Rich replies "好去處理" and the agent doesn't know what "好" refers to.
The 2026-07-18 outage made this acute: 4 messages went unanswered and the restarted
agent had no context for any of them.

## Decisions already made (with Rich)

1. **Conversation context: server-side mechanical logging** — not agent-written
   summaries. Summaries die with the crash; mechanical logging cannot be skipped.
2. **In-flight task state: lightweight task file** — same instruction-driven
   pattern as the existing per-group `memory.md`, not a detailed action journal.

## Design

### 1. Bidirectional message log (server.ts)

- Extend `MessageLogEntry` with `direction?: 'in' | 'out'`. Entries without the
  field (legacy lines) are treated as `'in'`.
- In the `reply` tool handler, after a successful send, `persistMessage()` the
  agent's own reply with `direction: 'out'`, `replied: true`. When the reply is
  chunked (4096-char chunking), log the full original text once, not per chunk.
- The existing 24h `pruneMessageLog()` naturally bounds the replay window.

### 2. New MCP tool `catch_up`

Returns, in one call:

- For each chat with activity in the last 24h: the most recent ~15 messages in
  **both** directions, chronological, labeled (`Rich:` / `You:`), plus the
  chat's unreplied count.
- The unchecked items from `tasks.md` (see below) appended at the end.

The `unreplied` tool stays unchanged (backward compatibility). The server's
session-start instruction (the `instructions` string near the top of the MCP
server setup, currently "call status, then unreplied") changes to:
`status` → `catch_up` → resume open tasks and reply to unreplied messages.

### 3. Task file `~/.whatsapp-channel/tasks.md`

Instruction-driven (tool description text, same mechanism that drives
`memory.md`):

- When the agent accepts a multi-step task, append
  `- [ ] [YYYY-MM-DD HH:MM] [group] task — progress note`.
- Update the line's progress note as it works; flip to `- [x]` when done.
- `catch_up` returns unchecked items so a restarted agent immediately sees
  "what I was in the middle of".

### 4. Deployment

- Minor version bump (new feature): both `.claude-plugin/marketplace.json`
  `plugins[0].version` AND `.claude-plugin/plugin.json` (Hard Rule 1).
- After push: on mini, `claude plugin update whatsapp-claude-channel@whatsapp-claude-plugin`,
  then restart via `~/start-whatsapp-agent.sh`.

## Explicitly out of scope

- The orphaned-server.ts / singleton-lock bug — fixed separately in v0.10.4
  (server.ts parent-death poll + watchdog `kill_orphaned_server`).
- Media/reaction logging in the outbound direction (text replies only for now).
- Any change to the access-control engine or connection lifecycle.

## Testing

No test suite in this repo. Verify on mini: restart the agent mid-conversation,
confirm the new session's `catch_up` shows both directions and the open task,
and that the agent's next reply is on-topic.
