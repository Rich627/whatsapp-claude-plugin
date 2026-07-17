# Context Recovery After Agent Restart — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After an agent restart, one `catch_up` MCP call restores two-way conversation context (last 24h, both directions) plus in-flight task state, so the new session can resume mid-conversation.

**Architecture:** Extend the existing `messages.jsonl` mechanical log (already pruned to 24h) with a `direction` field and log outbound replies from the `reply` tool handler. A new `catch_up` tool replays recent two-way conversation per chat and appends unchecked items from a new instruction-driven `~/.whatsapp-channel/tasks.md`. No new subsystems, no new dependencies.

**Tech Stack:** Bun + TypeScript, single-file MCP server (`server.ts`, ~1972 lines). No build step, **no test suite** — verification is a syntax/transpile check plus a stdio JSON-RPC smoke test against a scratch state dir.

**Spec:** `docs/superpowers/specs/2026-07-18-context-recovery-design.md` (approved 2026-07-18, commit 5fb2e43 — local only, pushes with this work).

## Global Constraints

- **Hard Rule 1 (version pairing):** minor bump `0.10.4` → `0.11.0` in BOTH `.claude-plugin/marketplace.json` `plugins[0].version` AND `.claude-plugin/plugin.json` `version`. Ignore marketplace's top-level `"version": "1.5.0"` (that's the marketplace's own).
- **Hard Rule 2 (danger zones):** every task that edits `server.ts` starts with `grep -n <symbol> server.ts` for each touched symbol, and its commit summary must name the invariant preserved. This change must NOT touch connection lifecycle, singleton lock, or access gating (spec: explicitly out of scope).
- **Hard Rule 3 (remote commands to mini):** every ssh command uses `timeout <n>` or backgrounds with a log redirect.
- **Hard Rule 4:** runtime state stays in `~/.whatsapp-channel/`; `tasks.md` is created by the _agent_ at runtime, never by this repo.
- **No new dependencies.** Only existing imports (`readFileSync`, `writeFileSync`, `existsSync`, `join` — all already imported in server.ts).
- Line numbers below are from the pre-edit file (1972 lines). After Task 1's edits, later tasks' line numbers shift by roughly +15 — anchor by grep/string match, not raw line number.

## Key invariants to preserve (name these in commit messages)

1. **`getUnreplied()` returns only inbound unanswered messages.** Outbound entries are written with `replied: true`, so they never appear in `unreplied` — the tool's output is unchanged for existing users.
2. **`markReplied()` is a no-op on outbound entries** (they're already `replied: true`), so the rewrite loop doesn't churn them.
3. **Legacy log lines (no `direction` field) are inbound.** Every consumer must use `(entry.direction ?? 'in')`.
4. **A chunked or doc-mode reply logs the full original text exactly once**, not per chunk/part.
5. **`persistMessage` failures never break sending** — it already try/catches internally; the outbound log call goes AFTER the sends and `markReplied`, so a log failure can't lose a sent message's replied-marking.

---

### Task 1: `direction` field + outbound reply logging

**Files:**

- Modify: `server.ts:722-733` (`MessageLogEntry` interface)
- Modify: `server.ts:1650-1661` (inbound `persistMessage` call — tag `direction: 'in'`)
- Modify: `server.ts:1118` (reply handler, after `markReplied(chat_id)` — log outbound)

**Interfaces:**

- Consumes: existing `persistMessage(entry: MessageLogEntry): void`, `resolveGroupName(groupJid: string): Promise<string>` (never throws; falls back to the JID), `markReplied(chat_id: string)`, `sentIds: string[]` (in-scope in the reply handler).
- Produces: `MessageLogEntry.direction?: 'in' | 'out'` — Task 2's `getRecentByChat()` relies on `(entry.direction ?? 'in')` semantics and on outbound entries having `user: 'You'` is NOT assumed (Task 2 labels by `direction`, not by `user`).

- [ ] **Step 1: Hard Rule 2 pre-edit grep**

Run:

```bash
grep -n 'MessageLogEntry\|persistMessage\|markReplied\|getUnreplied\|resolveGroupName' server.ts
```

Expected: `MessageLogEntry` at 722 (interface), 750, 764/768, 771, 787 (parse casts); `persistMessage` at 735 (def), 1650 (inbound call); `markReplied` at 743 (def), 1118 (reply handler); `getUnreplied` at 764 (def), 1210 (unreplied handler); `resolveGroupName` at 312 (def), 1647 (inbound call). Read each call site (~10 surrounding lines) and confirm: no consumer will break when a `direction` field appears and `replied: true` outbound rows are added (see invariants 1–3 above).

- [ ] **Step 2: Extend the interface**

In `server.ts`, change:

```ts
interface MessageLogEntry {
  id: string;
  chat_id: string;
  user: string;
  user_id: string;
  text: string;
  ts: string;
  replied: boolean;
  image_path?: string;
  attachment_kind?: string;
  group_name?: string;
}
```

to:

```ts
interface MessageLogEntry {
  id: string;
  chat_id: string;
  user: string;
  user_id: string;
  text: string;
  ts: string;
  replied: boolean;
  /** Absent on legacy lines — treat missing as 'in'. */
  direction?: "in" | "out";
  image_path?: string;
  attachment_kind?: string;
  group_name?: string;
}
```

- [ ] **Step 3: Tag new inbound entries explicitly**

In the inbound pipeline (`persistMessage({ ... })` call at ~1650, the one with `replied: false`), add one line after `replied: false,`:

```ts
    replied: false,
    direction: 'in',
```

- [ ] **Step 4: Log the outbound reply in the `reply` handler**

In `case 'reply':`, immediately AFTER the existing `markReplied(chat_id)` line and BEFORE the `const result =` block, insert:

```ts
// Log the outbound reply for catch_up — full original text once, not per chunk
const outText = text || (files.length ? `(sent ${files.length} file(s))` : "");
if (outText) {
  const outGroupName = chat_id.endsWith("@g.us")
    ? await resolveGroupName(chat_id)
    : undefined;
  persistMessage({
    id: sentIds[0] ?? `out-${Date.now()}`,
    chat_id,
    user: "You",
    user_id: sock.user?.id ?? "self",
    text: outText,
    ts: new Date().toISOString(),
    replied: true,
    direction: "out",
    ...(outGroupName && outGroupName !== chat_id
      ? { group_name: outGroupName }
      : {}),
  });
}
```

Notes for the implementer:

- This single call covers both the chunked branch and the doc-mode branch — both fall through to `markReplied` (invariant 4).
- `replied: true` keeps outbound rows out of `getUnreplied()` (invariant 1).
- `resolveGroupName` returns the JID itself on failure — the `!== chat_id` guard avoids storing a useless `group_name`.
- `sock` is non-null here (the handler throws `'WhatsApp not connected'` at its top if not).

- [ ] **Step 5: Transpile check**

```bash
bun build server.ts --target=bun --outfile=/private/tmp/claude-501/-Users-rich-Desktop-whatsapp-claude-plugin/911acb66-077b-4425-b898-5864583eadde/scratchpad/server-check.js && echo BUILD_OK
```

Expected: `BUILD_OK` (bundle warnings are fine; errors are not).

- [ ] **Step 6: Commit**

```bash
git add server.ts
git commit -m "feat(server): log outbound replies with direction field

Outbound entries are written replied:true so getUnreplied() output is
unchanged; legacy lines without direction still read as inbound."
```

---

### Task 2: `catch_up` tool + `tasks.md` + session-start instructions

**Files:**

- Modify: `server.ts:51` area (path constants — add `TASKS_FILE`)
- Modify: `server.ts:779` area (after `getUnreplied`, before `pruneMessageLog` — add `getRecentByChat`)
- Modify: `server.ts:1007-1019` area (ListTools — add `catch_up` entry after `unreplied`)
- Modify: `server.ts:1208-1224` area (CallTool — add `case 'catch_up'` after `case 'unreplied'`)
- Modify: `server.ts:838` (session-start instruction) and `server.ts:851` area (add tasks.md maintenance paragraph)

**Interfaces:**

- Consumes: `MessageLogEntry` with `direction?: 'in' | 'out'` (Task 1), `MESSAGE_LOG`, `STATE_DIR`, `existsSync`/`readFileSync`/`join` (already imported).
- Produces: `getRecentByChat(limit?: number): Map<string, { entries: MessageLogEntry[]; unreplied: number }>` and MCP tool `catch_up` (no arguments). `unreplied` tool untouched.

- [ ] **Step 1: Hard Rule 2 pre-edit grep**

```bash
grep -n "MESSAGE_LOG\|TASKS_FILE\|'unreplied'\|case 'status'\|instructions" server.ts
```

Expected: `MESSAGE_LOG` def at 51 and uses only inside the persistence section; no existing `TASKS_FILE`; `unreplied` in ListTools (~1008) and CallTool (~1208); instructions array at ~828. Confirm the new tool name `catch_up` doesn't already exist: `grep -n catch_up server.ts` → no matches.

- [ ] **Step 2: Add the tasks-file constant**

After the line `const MESSAGE_LOG = join(STATE_DIR, 'messages.jsonl')`, add:

```ts
const TASKS_FILE = join(STATE_DIR, "tasks.md");
```

- [ ] **Step 3: Add `getRecentByChat`**

Immediately after the closing brace of `getUnreplied()` (before the `pruneMessageLog` comment), insert:

```ts
/** Last ~N messages per chat, both directions, chronological — for catch_up.
 *  The 24h window is enforced by pruneMessageLog, not here. */
function getRecentByChat(
  limit = 15,
): Map<string, { entries: MessageLogEntry[]; unreplied: number }> {
  const byChat = new Map<
    string,
    { entries: MessageLogEntry[]; unreplied: number }
  >();
  try {
    if (!existsSync(MESSAGE_LOG)) return byChat;
    const lines = readFileSync(MESSAGE_LOG, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as MessageLogEntry;
        let bucket = byChat.get(entry.chat_id);
        if (!bucket) {
          bucket = { entries: [], unreplied: 0 };
          byChat.set(entry.chat_id, bucket);
        }
        bucket.entries.push(entry);
        if ((entry.direction ?? "in") === "in" && !entry.replied)
          bucket.unreplied++;
      } catch {}
    }
    for (const bucket of byChat.values()) {
      bucket.entries.sort((a, b) => a.ts.localeCompare(b.ts));
      bucket.entries = bucket.entries.slice(-limit);
    }
  } catch {}
  return byChat;
}
```

(ISO-8601 `ts` strings sort correctly with `localeCompare`; same assumption `pruneMessageLog` already makes by parsing them with `new Date`.)

- [ ] **Step 4: Register the tool in ListTools**

In the `ListToolsRequestSchema` handler's `tools` array, insert this entry between the `unreplied` entry and the `list_groups` entry:

```ts
    {
      name: 'catch_up',
      description:
        'Recover conversation context after a restart. For every chat active in the last 24h, returns the recent messages in BOTH directions (sender name for incoming, "You" for replies this agent sent), each chat\'s unreplied count, and the open (unchecked) items from ~/.whatsapp-channel/tasks.md. Call this on session start, right after status. When you take on a multi-step task from a chat, append a line to tasks.md ("- [ ] [YYYY-MM-DD HH:MM] [chat] task — progress note"), keep the progress note updated as you work, and flip it to "- [x]" when done, so a future session can resume it after a crash.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
```

- [ ] **Step 5: Add the CallTool case**

Insert after the closing brace of `case 'unreplied': { ... }`:

```ts
      case 'catch_up': {
        const byChat = getRecentByChat()
        const sections: string[] = []
        for (const [chatId, { entries, unreplied }] of byChat) {
          const name =
            entries.find(e => e.group_name)?.group_name ??
            entries.find(e => (e.direction ?? 'in') === 'in')?.user ??
            chatId
          const header = `=== ${name} (chat_id=${chatId})${unreplied ? ` — ${unreplied} unreplied` : ''} ===`
          const lines = entries.map(e => {
            const who = e.direction === 'out' ? 'You' : e.user
            const extras =
              (e.image_path ? ` (image: ${e.image_path})` : '') +
              (e.attachment_kind ? ` (${e.attachment_kind} attachment)` : '')
            return `[${e.ts}] ${who}: ${e.text}${extras}`
          })
          sections.push([header, ...lines].join('\n'))
        }
        let text = sections.length ? sections.join('\n\n') : 'No chat activity in the last 24h.'
        try {
          if (existsSync(TASKS_FILE)) {
            const open = readFileSync(TASKS_FILE, 'utf8')
              .split('\n')
              .filter(l => l.trimStart().startsWith('- [ ]'))
            if (open.length) {
              text += `\n\nOpen tasks (~/.whatsapp-channel/tasks.md):\n${open.join('\n')}`
            }
          }
        } catch {}
        return { content: [{ type: 'text', text }] }
      }
```

- [ ] **Step 6: Update the session-start instruction**

In the `instructions` array (~line 838), replace the string:

```
'On session start, call the status tool immediately to check connection state and show the pairing code if the device is not yet paired. Then call the unreplied tool to catch up on any messages that arrived before this session or were missed due to a restart.',
```

with:

```
'On session start, call the status tool immediately to check connection state and show the pairing code if the device is not yet paired. Then call the catch_up tool: it returns the recent two-way conversation for every active chat, unreplied counts, and open tasks from tasks.md. Resume any open tasks and reply to unreplied messages. (The unreplied tool still exists if you only want the plain unreplied list.)',
```

- [ ] **Step 7: Add the tasks.md maintenance instruction**

In the same `instructions` array, after the memory.md paragraph (the string starting `'After a meaningful conversation in a group...'`) and its following `''` separator, insert two new elements:

```ts
      'When you take on a multi-step task from WhatsApp (anything you cannot finish within the current reply), append a line to ~/.whatsapp-channel/tasks.md: "- [ ] [YYYY-MM-DD HH:MM] [group or contact] task — progress note". Update the progress note as you work and change "- [ ]" to "- [x]" when done. The catch_up tool surfaces unchecked items after a restart so a fresh session can resume mid-flight work. Create the file if it does not exist.',
      '',
```

- [ ] **Step 8: Transpile check**

```bash
bun build server.ts --target=bun --outfile=/private/tmp/claude-501/-Users-rich-Desktop-whatsapp-claude-plugin/911acb66-077b-4425-b898-5864583eadde/scratchpad/server-check.js && echo BUILD_OK
```

Expected: `BUILD_OK`.

- [ ] **Step 9: Functional smoke test (scratch state dir, no real WhatsApp)**

Write `/private/tmp/claude-501/-Users-rich-Desktop-whatsapp-claude-plugin/911acb66-077b-4425-b898-5864583eadde/scratchpad/smoke-catchup.sh`:

```bash
#!/bin/bash
# Smoke-test catch_up over MCP stdio with a seeded scratch state dir.
set -u
SCRATCH="$(dirname "$0")/wa-state"
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
cat > "$SCRATCH/messages.jsonl" <<EOF
{"id":"m1","chat_id":"111@s.whatsapp.net","user":"Rich","user_id":"111@s.whatsapp.net","text":"幫我查一下報表","ts":"$NOW","replied":true,"direction":"in"}
{"id":"m2","chat_id":"111@s.whatsapp.net","user":"You","user_id":"self","text":"好，我看一下","ts":"$NOW","replied":true,"direction":"out"}
{"id":"m3","chat_id":"111@s.whatsapp.net","user":"Rich","user_id":"111@s.whatsapp.net","text":"好去處理","ts":"$NOW","replied":false,"direction":"in"}
{"id":"m4","chat_id":"222@g.us","user":"Alice","user_id":"333@s.whatsapp.net","text":"legacy line no direction","ts":"$NOW","replied":false,"group_name":"Test Group"}
EOF
printf -- '- [ ] [2026-07-18 10:00] [Rich DM] 查報表 — 已開始\n- [x] [2026-07-17 09:00] [Test Group] done thing\n' > "$SCRATCH/tasks.md"

REQS='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"catch_up","arguments":{}}}'

OUT=$( (printf '%s\n' "$REQS"; sleep 5) | WHATSAPP_STATE_DIR="$SCRATCH" timeout 20 bun server.ts 2>"$SCRATCH/stderr.log" )
echo "$OUT" | grep -q '"id":2' || { echo "FAIL: no catch_up response"; echo "$OUT"; tail -20 "$SCRATCH/stderr.log"; exit 1; }
for want in 'You: 好，我看一下' 'Rich: 好去處理' '1 unreplied' 'Alice: legacy line no direction' 'Open tasks' '查報表'; do
  echo "$OUT" | grep -qF "$want" || { echo "FAIL: missing [$want]"; echo "$OUT"; exit 1; }
done
echo "$OUT" | grep -qF 'done thing' && { echo "FAIL: checked task leaked into output"; exit 1; }
echo SMOKE_OK
```

Run:

```bash
bash /private/tmp/claude-501/-Users-rich-Desktop-whatsapp-claude-plugin/911acb66-077b-4425-b898-5864583eadde/scratchpad/smoke-catchup.sh
```

Expected: `SMOKE_OK`. The JSON-RPC response embeds the text with `\n` escapes and possibly `\u` escapes for CJK — if the CJK greps fail while ASCII ones pass, that's an encoding artifact of the transport, not a bug: re-check with `grep -q 'unreplied'` style ASCII probes and by eyeballing the raw `$OUT`. If the server exits before answering (pairing/network preconditions in a bare state dir), read `$SCRATCH/stderr.log`; MCP stdio serving starts before the WhatsApp connection, so `catch_up` (pure file reads) should answer regardless — a failure here is a real bug, not environment noise. Assert-check: this test also proves invariant 3 (the legacy `m4` line, no `direction`, is labeled with the sender name and counted unreplied).

- [ ] **Step 10: Verify `unreplied` is untouched**

```bash
git diff server.ts | grep -n "case 'unreplied'" ; git diff server.ts | grep -c '^-'
```

Expected: no hunk modifies the `unreplied` case body (additions only around it). Also confirm the diff has no changes in connection lifecycle / lock / access-gate regions: `git diff server.ts | grep -in 'lock\|allowlist\|connection'` → no matches (or only incidental context lines).

- [ ] **Step 11: Commit**

```bash
git add server.ts
git commit -m "feat(server): catch_up tool + tasks.md for post-restart context recovery

unreplied tool and its output format are unchanged; catch_up reads the
same messages.jsonl (24h-pruned) plus ~/.whatsapp-channel/tasks.md.
Legacy log lines without direction are treated as inbound."
```

---

### Task 3: Version bump + push

**Files:**

- Modify: `.claude-plugin/marketplace.json` (`plugins[0].version`: `0.10.4` → `0.11.0`)
- Modify: `.claude-plugin/plugin.json` (`version`: `0.10.4` → `0.11.0`)

- [ ] **Step 1: Bump both files**

In `.claude-plugin/plugin.json` change `"version": "0.10.4"` → `"version": "0.11.0"`. In `.claude-plugin/marketplace.json` change the `"version": "0.10.4"` line inside `plugins[0]` (NOT the top-level `"version": "1.5.0"`) → `"version": "0.11.0"`.

- [ ] **Step 2: Verify the pairing (Hard Rule 1 evidence artifact)**

```bash
grep -n '"version"' .claude-plugin/marketplace.json .claude-plugin/plugin.json
```

Expected output — three lines; the last two must both read `0.11.0`:

```
.claude-plugin/marketplace.json:4:  "version": "1.5.0",
.claude-plugin/marketplace.json:13:      "version": "0.11.0",
.claude-plugin/plugin.json:5:  "version": "0.11.0",
```

- [ ] **Step 3: Lint**

```bash
trunk check --filter=prettier,markdownlint .claude-plugin/ docs/superpowers/ server.ts
```

Expected: no new failures (fix formatting if prettier complains).

- [ ] **Step 4: Commit and push (carries spec commit 5fb2e43 too)**

```bash
git add .claude-plugin/marketplace.json .claude-plugin/plugin.json docs/superpowers/plans/2026-07-18-context-recovery.md
git commit -m "chore: bump version to 0.11.0 (catch_up context recovery)"
git log --oneline origin/main..HEAD   # expect: this bump, Task 2, Task 1, and 5fb2e43 spec commit
git push
```

Expected: push succeeds; `git log --oneline origin/main..HEAD` afterwards is empty.

---

### Task 4: Deploy to mini and verify

Pre-existing context: mini runs the live agent via tmux + LaunchAgent `com.claude.whatsapp-agent`; `~/start-whatsapp-agent.sh` is the restart entry point and auto-clears the trust prompt. Hard Rule 3 applies to every command here.

- [ ] **Step 1: Confirm the agent is idle before restarting**

```bash
ssh mini 'timeout 10 tmux capture-pane -t whatsapp-agent -p | tail -30'
```

Read the output: if the agent is mid-task (tool calls in flight, streaming a reply), WAIT and re-check rather than restarting under it. Only proceed when it's idle at a prompt. If the tmux session doesn't exist, note that and proceed (nothing to interrupt).

- [ ] **Step 2: Update the plugin on mini**

```bash
ssh mini 'timeout 120 ~/.local/bin/claude plugin update whatsapp-claude-channel@whatsapp-claude-plugin'
```

Expected: output showing an update to 0.11.0. If it says "already at latest", Hard Rule 1 was violated somewhere — stop and re-check Task 3 before touching anything else.

- [ ] **Step 3: Restart the agent**

```bash
ssh mini 'timeout 60 ~/start-whatsapp-agent.sh > /tmp/wa-restart.log 2>&1; tail -20 /tmp/wa-restart.log'
```

Expected: script's normal startup output, no errors. Then confirm the session is up:

```bash
ssh mini 'timeout 10 tmux list-sessions; timeout 10 pgrep -fl "bun.*server.ts" | head -5'
```

Expected: the agent tmux session listed and exactly ONE `bun … server.ts` process (singleton invariant — two would mean the orphan bug regressed).

- [ ] **Step 4: End-to-end verification (spec's test plan)**

1. Rich sends a WhatsApp message and lets the agent reply (creates an outbound log entry on mini).
2. Restart the agent again (Steps 1 & 3 above).
3. In the new session's startup, confirm via the tmux pane (`ssh mini 'timeout 10 tmux capture-pane -t whatsapp-agent -p | tail -60'`) that `catch_up` was called and its output shows BOTH directions for the test chat, and the reply the agent then sends is on-topic.
4. Honest-limit note for the summary: the tasks.md half can only be fully verified once the agent organically records a task; seeding one by hand on mini (`echo '- [ ] [2026-07-18 21:00] [test] smoke task' >> ~/.whatsapp-channel/tasks.md`) before the restart is an acceptable stand-in — remove it after (`ssh mini` with timeout).

This step needs Rich to send a live message — if he's not available, report Tasks 1–3 + deploy as done, with E2E verification explicitly listed as pending.

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** §1 direction+outbound logging → Task 1. §2 catch_up + unchanged unreplied + instructions change → Task 2 (Steps 4–7, 10). §3 tasks.md → Task 2 (Steps 2, 4, 5, 7). §4 deployment → Tasks 3–4. Out-of-scope list respected (no lifecycle/lock/access edits; Task 2 Step 10 checks this mechanically).
- **Type consistency:** `direction?: 'in' | 'out'` defined once (Task 1 Step 2), consumed with `?? 'in'` in Task 2 Steps 3/5. `getRecentByChat(limit = 15)` name/signature consistent between Interfaces block and Step 3. `TASKS_FILE` defined Step 2, used Step 5.
- **Known judgment calls baked in:** outbound `user: 'You'` is display-only (labeling keys off `direction`); files-only replies log a `(sent N file(s))` placeholder (spec says text-only logging — this is the minimal honest record, not media logging); `group_name !== chat_id` guard avoids caching the resolveGroupName failure sentinel.
