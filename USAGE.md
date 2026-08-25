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

See [ACCESS.md](./ACCESS.md) for group options (`--mention`, `--allow`, `--roster`). Setting up several groups or contacts at once? Run `bun scripts/access.ts wizard` in your own terminal for a checkbox pass over your most recently active ones, or `wizard --revoke` to tick off access you want taken away — see [Guided bulk setup](./ACCESS.md#guided-bulk-setup-wizard).

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
      "mcp__plugin_whatsapp_claude_channel_whatsapp__reply",
      "mcp__plugin_whatsapp_claude_channel_whatsapp__react",
      "mcp__plugin_whatsapp_claude_channel_whatsapp__status",
      "mcp__plugin_whatsapp_claude_channel_whatsapp__download_attachment",
      "mcp__plugin_whatsapp_claude_channel_whatsapp__edit_message"
    ]
  }
}
```

### Permission relay

When Claude needs to run a tool that requires approval and no one is at the terminal, the request is forwarded to all allowlisted WhatsApp contacts. Reply `yes <code>` or `no <code>` from WhatsApp to approve or deny.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

## Tools exposed to the assistant

| Tool                  | Purpose                                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reply`               | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (quote-reply), `files` (attachments), and `mentions` (names over raw numbers; `"all"` needs [roster access](./ACCESS.md#group-roster--all-mentions)). |
| `react`               | Add an emoji reaction to a message by ID. Any emoji is supported.                                                                                                                                                     |
| `download_attachment` | Download media from a received message. Returns the local file path.                                                                                                                                                  |
| `edit_message`        | Edit a message the account previously sent.                                                                                                                                                                           |
| `status`              | Check connection state and get the pairing code if not yet paired.                                                                                                                                                    |
| `unreplied`           | List received messages not yet replied to.                                                                                                                                                                            |
| `catch_up`            | Post-restart context recovery: recent two-way conversation per chat (last 24h), unreplied counts, and open items from `~/.whatsapp-channel/tasks.md`.                                                                 |
| `list_groups`         | List every group the account is in, with JID, allowlist state, and roster-grant state. Also refreshes the local group name cache the access wizard reads.                                                             |
| `group_roster`        | List a group's members by saved name, or a masked number — never raw. Requires [roster access](./ACCESS.md#group-roster--all-mentions).                                                                               |

## Photos & Media

Inbound **photos** are downloaded eagerly to `~/.whatsapp-channel/inbox/` and the local path is included in the notification so the assistant can read it.

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
`WA:reconnecting` (colored, empty string otherwise) for whichever terminal
it's run in. Append it to a Claude Code `statusLine` command to see at a
glance which terminal holds the real connection:

```json
{
  "statusLine": {
    "type": "command",
    "command": "your-existing-statusline-command && bun <plugin-dir>/scripts/statusline-role.ts"
  }
}
```

It finds the server by walking down from the Claude Code CLI process:
first the plugin's own wrapper process, then `server.ts` among that
wrapper's children. Same-machine, read-only, never throws - a miss just
means no segment, not a broken statusline.

## Known limitations

**Inbound message delivery is Claude Code only.** Messages are pushed into a session with `notifications/claude/channel`, which is a Claude Code extension, not part of MCP. Other MCP clients (Codex CLI, Gemini CLI, Cursor) drop unknown notifications silently, so there the plugin is poll-only: call `wait_for_messages`, `catch_up` or `unreplied` to see what arrived. Delivery inside Claude Code was broken by client bugs ([#37933](https://github.com/anthropics/claude-code/issues/37933), [#36477](https://github.com/anthropics/claude-code/issues/36477), [#37633](https://github.com/anthropics/claude-code/issues/37633)) and worked again when last checked on v2.1.235; if messages stop appearing, check those issues before suspecting this plugin.

## Resetting auth

```
/whatsapp-channel:configure reset-auth
```

Then relaunch to re-pair.
