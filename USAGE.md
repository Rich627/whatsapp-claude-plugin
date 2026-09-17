# WhatsApp

Connect WhatsApp to your Claude Code session via linked-device protocol.

The MCP server connects to WhatsApp as a linked device (like WhatsApp Web) and provides tools to Claude to reply, react, edit messages, and handle media. When someone messages the linked number, the server forwards the message to your Claude Code session.

> **Identity notice:** This plugin connects as a linked device to your existing WhatsApp account. Messages sent by Claude will appear as coming from your phone number — recipients cannot distinguish them from messages you send personally. If you need a separate bot identity, use a dedicated number (e.g. a second SIM or WhatsApp Business account) with the [dual-account setup](#dual-account-setup).

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.
- A WhatsApp account with an active phone number.

## Quick Setup

**1. Install the plugin.**

```
/plugin marketplace add Rich627/whatsapp-claude-plugin
/plugin install whatsapp-channel@whatsapp-claude-plugin
/exit
```

Restart to activate the plugin:

```sh
claude
```

**2. Configure your phone number.**

```
/whatsapp-channel:configure 886912345678
/exit
```

Use your WhatsApp phone number with country code, no leading `+`.

**3. Launch with the channel flag.**

```sh
claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:whatsapp-channel@whatsapp-claude-plugin
```

The pairing code appears automatically in your session. On your phone:

1. Open WhatsApp > **Settings** > **Linked Devices** > **Link a Device**
2. Tap **Link with phone number instead**
3. Enter the pairing code

Once paired, your own number is **auto-added to the allowlist** and the policy is **auto-locked to allowlist mode**.

> `--dangerously-load-development-channels` is required for third-party plugins during the research preview. Once submitted and approved by Anthropic, use `--channels` instead.

**4. Add other contacts (optional).**

Have someone DM the linked number. Briefly flip to pairing mode:

```
/whatsapp-channel:access policy pairing
```

They'll receive a 6-character code. Approve in your Claude Code session:

```
/whatsapp-channel:access pair <code>
```

After pairing, the policy auto-locks back to `allowlist`.

**5. Add groups (optional).**

```
/whatsapp-channel:access group add <groupJid>
```

Each group gets its own personality config at `~/.whatsapp-channel/groups/<groupJid>/config.md`. Edit that file to customize how Claude behaves in each group. Conversation memory is auto-saved to `memory.md` in the same directory.

See [ACCESS.md](./ACCESS.md) for group options (`--mention`, `--allow`, `--roster`). Setting up several groups or contacts at once? Ask for `/whatsapp-channel:access review`, or run `bun scripts/access.ts wizard` yourself - see [Guided bulk setup](./ACCESS.md#guided-bulk-setup-wizard).

## Daily use

After initial setup, just run:

```sh
claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:whatsapp-channel@whatsapp-claude-plugin
```

- `--dangerously-skip-permissions` — auto-approve all tool calls (no permission prompts)
- `--dangerously-load-development-channels` — load third-party channel plugin

Auth is saved in `~/.whatsapp-channel/.baileys_auth/`. The session must stay open to receive messages — closing the session disconnects WhatsApp.

### Fine-grained permissions

If you prefer to auto-allow only WhatsApp tools (instead of all tools), add to your `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_whatsapp-channel_whatsapp__reply",
      "mcp__plugin_whatsapp-channel_whatsapp__react",
      "mcp__plugin_whatsapp-channel_whatsapp__status",
      "mcp__plugin_whatsapp-channel_whatsapp__download_attachment",
      "mcp__plugin_whatsapp-channel_whatsapp__edit_message"
    ]
  }
}
```

### Permission relay

When Claude needs to run a tool that requires approval and no one is at the terminal, the request is forwarded to all allowlisted WhatsApp contacts. Reply `yes <code>` or `no <code>` from WhatsApp to approve or deny.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

## Tools exposed to the assistant

| Tool                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reply`               | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (quote-reply), `files` (attachments), and `mentions` (names over raw numbers; `"all"` needs [roster access](./ACCESS.md#group-roster--all-mentions)).                                                                                                                                                                                                                |
| `react`               | Add an emoji reaction to a message by ID. Any emoji is supported.                                                                                                                                                                                                                                                                                                                                                                    |
| `download_attachment` | Download media from a received message. Returns the local file path.                                                                                                                                                                                                                                                                                                                                                                 |
| `edit_message`        | Edit a message the account previously sent.                                                                                                                                                                                                                                                                                                                                                                                          |
| `status`              | Check connection state and get the pairing code if not yet paired.                                                                                                                                                                                                                                                                                                                                                                   |
| `unreplied`           | List received messages not yet replied to, with their chat_ids. Pass `chat_id` for one chat. Shows at most 100 per call (the newest), after that filter; `wait_for_messages` has the same ceiling.                                                                                                                                                                                                                                   |
| `wait_for_messages`   | Park up to 40s for messages this connection has not been handed yet. The first call returns whatever is already unreplied; later calls only what arrived since. Mainly for MCP clients other than Claude Code, which pushes messages into the session itself.                                                                                                                                                                        |
| `catch_up`            | Without `chat`: **counts only** - one line per chat that has something waiting, with an `@` where a mention-gated group addressed you, plus open items from `~/.whatsapp-channel/tasks.md`. No message text, no chat_id. Pass `chat` (a chat_id or part of a group/contact name) to read one chat: its recent two-way conversation, waiting messages first (retention: see "Your own replies" below), and the chat_id `reply` needs. |
| `list_groups`         | List every group the account is in, with JID, allowlist state, and roster-grant state. Also refreshes the local group name cache the access wizard reads.                                                                                                                                                                                                                                                                            |
| `group_roster`        | List a group's members by saved name, or a masked number — never raw. Requires [roster access](./ACCESS.md#group-roster--all-mentions).                                                                                                                                                                                                                                                                                              |

### Your own replies

When you answer a chat from your phone instead of asking Claude to, the server logs that message
too — but only for chats already on the allowlist (a DM from someone in `allowFrom`, or a group
you have enabled). Anything you send to any other chat is discarded before its text is read: the text is never
read, logged or stored, and the drop itself is not recorded either — the drop path writes no
diagnostic line and no log line. The one diagnostic line per inbound batch that precedes it masks every number to its last four digits (a group keeps its identifying form; a legacy `<number>-<timestamp>@g.us` group has its creator's number masked) and carries no message id or text; Baileys' own logging (`info`+, or `debug` under `WHATSAPP_DIAG_DEBUG=1`) is not masked by us.

`catch_up` **with a `chat` argument** replays the last **5** messages from the other side and the last **5** of your own for that chat, merged in time order, so your own texts never crowd out what the room said. Messages still waiting for a reply take those inbound slots first, so whatever the counts list flagged is what you see - in a mention-gated group the @-mention that raised the count can no longer be pushed out of the window by ordinary chatter. If more are waiting than fit, the header says how many. Pass `limit` to widen both sides together (min 5, max 100) - it is deliberately symmetric, so a run of your own texts never leaves you without the same amount of context behind it, and it widens how many of your own hand-typed messages are replayed as well as theirs. If the name you pass matches more than one chat, you get the matching chats instead of any message text, so nothing is guessed for you - up to 8 of them, a group by its id and a DM by its number masked to the last four digits (a masked handle is accepted back as `chat`; if two rows render identically, the full jid is the way through). Session start (no `chat`) shows none of this - only how many are waiting per chat. In a mention-gated group it also shows what members said without addressing Claude (tagged "not addressed to Claude") - kept for context only, never routed or counted as unreplied; opt a group out of that with `group add <jid> --no-context` ([ACCESS.md](./ACCESS.md#mention-detection)) and nothing unaddressed is stored for it at all. Your own hand-typed text reads in
full for as long as the line is kept, the same as theirs, so a chat never comes back half-blank.
How long that is, is the one retention rule for message text: the line stays in
`~/.whatsapp-channel/messages.jsonl` for **7 days**, the same as every other
context line there (replies Claude sent for you, and a mention-gated group's unaddressed chatter).
An **unanswered** message addressed to Claude is kept exactly as long as everything else. It used to expire after 24 hours, which meant the one message you had not got to yet was the first thing to disappear. Set `WHATSAPP_MESSAGE_TTL_DAYS` to keep lines for a different number of days. It accepts **1 to 30**: anything that is not a positive number is ignored and the 7-day default stands, and anything outside that range is clamped into it — so `90` gives you 30, not 90. Either way the server says what it did in `diag.log`.
The ceiling is not red tape. The same horizon prunes `~/.whatsapp-channel/inbox/`, and that prune is the only thing stopping every photo and voice note you have ever received from staying on disk forever; the floor is there because the unit is days and a value like `0.05` would delete an attachment about an hour after it arrived — possibly one Claude was still reading.
The setting belongs to whichever terminal holds the singleton lock, because only that process prunes. With two terminals open and different values set, the lock holder's value wins, and it changes if that process exits and another is promoted.
Backfill goes exactly as far as WhatsApp's own offline queue: whatever was sent while no server
was connected is delivered on the next reconnect and logged then; anything older than that queue
is gone for good.

Separately, `~/.whatsapp-channel/sent.jsonl` (owner-only, pruned to 24 hours) records only the **id and timestamp** of the plugin's own sends — never text, number or chat — so a send WhatsApp re-delivers after a restart is not mistaken for a reply you typed.

One record outlives the horizon on purpose: `~/.whatsapp-channel/.aged-out-chats.json`. When the prune drops a message that was still waiting for a reply, the chat is noted there - as a truncated hash of the chat_id and a timestamp, never the id itself - so the session-start counts can say "N chats had something waiting that has since aged out" after you have been away longer than the horizon. Entries expire after a fixed **30 days**; deleting `messages.jsonl` to clear history does not clear them. Static mode (`WHATSAPP_ACCESS_MODE=static`) never writes the file.

## Photos & Media

Inbound **photos** are downloaded eagerly to `~/.whatsapp-channel/inbox/` and the local path is included in the notification so the assistant can read it. A media message with no caption is shown in `catch_up` and `unreplied` as `[photo]`, `[voice]`, `[video]` or `[file]` rather than as an empty line.

Other media types (**voice notes, audio, video, documents, stickers**) are lazy — the notification includes an `attachment_file_id`. The assistant calls `download_attachment` to fetch the file on demand.

## Dual-account setup

You can run two WhatsApp accounts simultaneously — for example, your personal number and a dedicated bot number (WhatsApp Business or a second SIM). Each account runs as a separate MCP server with its own auth, allowlist, and state directory.

**1. Set environment variables for each account.**

Create separate `.env` files:

```sh
# ~/.whatsapp-channel/personal/.env
WHATSAPP_PHONE_NUMBER=886912345678

# ~/.whatsapp-channel/business/.env
WHATSAPP_PHONE_NUMBER=886987654321
```

**2. Add both servers to your MCP config.**

In your project or user `.mcp.json`:

```json
{
  "mcpServers": {
    "whatsapp-personal": {
      "command": "bun",
      "args": [
        "run",
        "--cwd",
        "<plugin-path>",
        "--shell=bun",
        "--silent",
        "start"
      ],
      "env": {
        "WHATSAPP_STATE_DIR": "~/.whatsapp-channel/personal",
        "WHATSAPP_ACCOUNT_NAME": "personal"
      }
    },
    "whatsapp-bot": {
      "command": "bun",
      "args": [
        "run",
        "--cwd",
        "<plugin-path>",
        "--shell=bun",
        "--silent",
        "start"
      ],
      "env": {
        "WHATSAPP_STATE_DIR": "~/.whatsapp-channel/business",
        "WHATSAPP_ACCOUNT_NAME": "bot"
      }
    }
  }
}
```

Each account gets fully isolated state (auth, allowlist, groups, inbox). Claude sees tools from both accounts with different namespaces (e.g. `mcp__whatsapp-personal__reply` vs `mcp__whatsapp-bot__reply`) and inbound messages include an `account` field in the meta so Claude knows which account received the message.

**3. Pair each account separately.** Launch and follow the normal pairing flow for each.

## Session conflicts

WhatsApp allows only **one real connection per auth state** - a protocol limit, not something this plugin works around. What changed is what happens when a second `server.ts` process starts (a second Claude Code terminal, most commonly) while another is already connected.

**Both terminals stay usable.** The first process to start becomes the primary and holds the real WhatsApp connection. Every later process becomes a secondary: it relays its tool calls (`reply`, `react`, etc.) to the primary over a local, same-machine, token-authenticated channel, and re-emits the primary's inbound-message notifications as its own. From inside Claude Code both terminals behave the same - send, react, and receive all work in either one.

**Every inbound message reaches every terminal, and each one can reply independently.** An inbound message is delivered to the primary's own Claude Code session AND broadcast to every connected secondary's session - each is a live Claude instance that may act on it. This means one WhatsApp message can produce two (or more, with more terminals) independent replies if more than one session decides to respond. This is a deliberate tradeoff for keeping every terminal fully usable rather than picking one "active" terminal; if you only want one terminal actually replying, treat the others as read-only for that purpose.

**If the primary closes, the other one takes over automatically.** A clean exit (`/exit`, Ctrl+C, the terminal closing normally) hands off within a few seconds. A hard-killed process (crash, force-quit) is only caught by the existing 15-second parent-liveness check, so that takeover can take up to ~30-40 seconds. No manual restart needed either way - the secondary keeps retrying in the background and promotes itself the moment it wins.

**While neither the original connection nor a takeover has succeeded**, a secondary falls back to a `whatsapp_unavailable` stub tool instead of a call that hangs or fails silently - if a tool call reports WhatsApp unavailable right after a crash or restart, wait a few seconds and retry.

**Limits:** same machine only, no cross-machine relay; tested with two terminals, three or more is unsupported.

If something still seems stuck (most likely after killing a terminal outside Claude Code's normal exit path), clear stale processes directly:

```sh
pkill -f "whatsapp.*server"
```

## Statusline (optional)

`scripts/statusline-role.ts` prints `WA:primary`, `WA:secondary` or
`WA:reconnecting` (colored) for whichever terminal it's run in, a dim
`WA:…` while a terminal that asked for the channel is still bringing a
server up, and an empty string when there is no server here at all. Append
it to a Claude Code `statusLine` command to see at a glance which terminal
holds the real connection:

```json
{
  "statusLine": {
    "type": "command",
    "refreshInterval": 5,
    "command": "your-existing-statusline-command && bun <plugin-dir>/scripts/statusline-role.ts"
  }
}
```

`refreshInterval` matters: without it Claude Code only re-runs the command
when you type, so the segment can sit on the dim `WA:…` marker (or a stale
role) until your next message.

Each server records which Claude Code session owns it, so the segment reads
ownership rather than guessing at it: the script climbs its own parent chain
a few hops and takes the role file stamped with one of those pids. Another
terminal's server can never match, and a leftover file from a dead session
cannot either, since a dead process is nobody's parent.

A server started before this shipped, or one whose client does not identify
itself, has no stamp. For those the script falls back to the process tree:
climb to the CLI that owns this terminal (a statusLine setting is a compound
command, so the script runs under a shell that is the plugin's sibling, not
its parent), find the plugin's wrapper among that CLI's descendants, then
`server.ts` under the wrapper. Several processes can carry the plugin dir
name - the statusline shell itself does - so every candidate is tried and
the one with a `server.ts` under it wins. Restarting the session upgrades it
to the stamped path.

Same-machine, read-only, never throws: a miss just means no segment, not a
broken statusline.

## Known limitations

**The message key/proto store is capped and FIFO, shared across every chat.** `download_attachment`, replies and lookups by `message_id` only work for messages still in this in-memory store. The default cap is 500 entries total — on a high-volume account (several active groups, hundreds of unread messages) that can churn through in minutes, so `download_attachment` can fail with `Message not found in store` well before the underlying media has actually expired on WhatsApp's side. Raise it with `WHATSAPP_MAX_STORE=5000` (or whatever fits your traffic) in the server's `.env` — each entry is just a message key plus a small proto, so a much larger cap costs negligible memory. Must be a positive integer; anything else (unset, non-numeric, fractional, zero, negative, `Infinity`) falls back to the 500 default.

**Inbound message delivery is Claude Code only.** Messages are pushed into a session with `notifications/claude/channel`, which is a Claude Code extension, not part of MCP. Other MCP clients (Codex CLI, Gemini CLI, Cursor) drop unknown notifications silently, so there the plugin is poll-only: call `wait_for_messages`, `catch_up` or `unreplied` to see what arrived. Delivery inside Claude Code was broken by client bugs ([#37933](https://github.com/anthropics/claude-code/issues/37933), [#36477](https://github.com/anthropics/claude-code/issues/36477), [#37633](https://github.com/anthropics/claude-code/issues/37633)) and worked again when last checked on v2.1.235; if messages stop appearing, check those issues before suspecting this plugin.

## Resetting auth

```
/whatsapp-channel:configure reset-auth
```

Then relaunch to re-pair.
