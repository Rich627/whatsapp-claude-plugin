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
/plugin install whatsapp@whatsapp-claude-plugin
/exit
```

Restart to activate the plugin:

```sh
claude
```

**2. Configure your phone number.**

```
/whatsapp:configure 886912345678
/exit
```

Use your WhatsApp phone number with country code, no leading `+`.

**3. Launch with the channel flag.**

```sh
claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:whatsapp@whatsapp-claude-plugin
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
/whatsapp:access policy pairing
```

They'll receive a 6-character code. Approve in your Claude Code session:

```
/whatsapp:access pair <code>
```

After pairing, the policy auto-locks back to `allowlist`.

**5. Add groups (optional).**

```
/whatsapp:access group add <groupJid>
```

Each group gets its own personality config at `~/.claude/channels/whatsapp/groups/<groupJid>/config.md`. Edit that file to customize how Claude behaves in each group. Conversation memory is auto-saved to `memory.md` in the same directory.

See [ACCESS.md](./ACCESS.md) for group options (`--mention`, `--allow`).

## Daily use

After initial setup, just run:

```sh
claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:whatsapp@whatsapp-claude-plugin
```

- `--dangerously-skip-permissions` — auto-approve all tool calls (no permission prompts)
- `--dangerously-load-development-channels` — load third-party channel plugin

Auth is saved in `~/.claude/channels/whatsapp/.baileys_auth/`. The session must stay open to receive messages — closing the session disconnects WhatsApp.

### Fine-grained permissions

If you prefer to auto-allow only WhatsApp tools (instead of all tools), add to your `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_whatsapp_whatsapp__reply",
      "mcp__plugin_whatsapp_whatsapp__react",
      "mcp__plugin_whatsapp_whatsapp__status",
      "mcp__plugin_whatsapp_whatsapp__download_attachment",
      "mcp__plugin_whatsapp_whatsapp__edit_message"
    ]
  }
}
```

### Permission relay

When Claude needs to run a tool that requires approval and no one is at the terminal, the request is forwarded to all allowlisted WhatsApp contacts. Reply `yes <code>` or `no <code>` from WhatsApp to approve or deny.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for quote-reply and `files` (absolute paths) for attachments. |
| `react` | Add an emoji reaction to a message by ID. Any emoji is supported. |
| `download_attachment` | Download media from a received message. Returns the local file path. |
| `edit_message` | Edit a message the account previously sent. |
| `status` | Check connection state and get the pairing code if not yet paired. |

## Photos & Media

Inbound **photos** are downloaded eagerly to `~/.claude/channels/whatsapp/inbox/` and the local path is included in the notification so the assistant can read it.

Other media types (**voice notes, audio, video, documents, stickers**) are lazy — the notification includes an `attachment_file_id`. The assistant calls `download_attachment` to fetch the file on demand.

## Dual-account setup

You can run two WhatsApp accounts simultaneously — for example, your personal number and a dedicated bot number (WhatsApp Business or a second SIM). Each account runs as a separate MCP server with its own auth, allowlist, and state directory.

**1. Set environment variables for each account.**

Create separate `.env` files:

```sh
# ~/.claude/channels/whatsapp/personal/.env
WHATSAPP_PHONE_NUMBER=886912345678

# ~/.claude/channels/whatsapp/business/.env
WHATSAPP_PHONE_NUMBER=886987654321
```

**2. Add both servers to your MCP config.**

In your project or user `.mcp.json`:

```json
{
  "mcpServers": {
    "whatsapp-personal": {
      "command": "bun",
      "args": ["run", "--cwd", "<plugin-path>", "--shell=bun", "--silent", "start"],
      "env": {
        "WHATSAPP_STATE_DIR": "~/.claude/channels/whatsapp/personal",
        "WHATSAPP_ACCOUNT_NAME": "personal"
      }
    },
    "whatsapp-bot": {
      "command": "bun",
      "args": ["run", "--cwd", "<plugin-path>", "--shell=bun", "--silent", "start"],
      "env": {
        "WHATSAPP_STATE_DIR": "~/.claude/channels/whatsapp/business",
        "WHATSAPP_ACCOUNT_NAME": "bot"
      }
    }
  }
}
```

Each account gets fully isolated state (auth, allowlist, groups, inbox). Claude sees tools from both accounts with different namespaces (e.g. `mcp__whatsapp-personal__reply` vs `mcp__whatsapp-bot__reply`) and inbound messages include an `account` field in the meta so Claude knows which account received the message.

**3. Pair each account separately.** Launch and follow the normal pairing flow for each.

## Session conflicts

WhatsApp allows only **one connection per auth state**. Running two instances causes a 440 disconnect. Check for stale processes:

```sh
pkill -f "whatsapp.*server"
```

## Known limitations

**Inbound message delivery may not work.** Claude Code's channel notification system (`notifications/claude/channel`) has a confirmed client-side bug where inbound messages sent by the MCP server are silently dropped and never appear in the conversation. This affects all channel plugins (WhatsApp, Telegram, etc.) and is tracked across multiple issues ([#37933](https://github.com/anthropics/claude-code/issues/37933), [#36477](https://github.com/anthropics/claude-code/issues/36477), [#37633](https://github.com/anthropics/claude-code/issues/37633)). The server-side implementation is correct — the fix must come from the Claude Code client. No reliable workaround exists as of v2.1.83.

## Resetting auth

```
/whatsapp:configure reset-auth
```

Then relaunch to re-pair.
