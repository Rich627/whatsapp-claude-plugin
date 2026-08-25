# WhatsApp Channel for Claude Code

Drive your Claude Code session from WhatsApp — your personal number, no bots, no API keys.

The plugin connects to WhatsApp as a **linked device** (the same protocol as WhatsApp Web, via Baileys) and exposes it to Claude Code as an MCP channel. Incoming messages reach your session in real time; Claude replies from your own number, so recipients see a normal chat. Everything runs locally on your machine — messages travel directly between WhatsApp and your session, with no third-party servers in between. Once paired, it keeps working while your phone is off; only the Claude Code session needs to stay open, and reconnects never require re-pairing.

[![Anthropic Published](https://img.shields.io/badge/Anthropic-Official%20Published-ff6b35?logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMTIgMkw0IDIwaDQuNUwxMiA4bDMuNSAxMkgyMEwxMiAyeiIgZmlsbD0id2hpdGUiLz48L3N2Zz4=)](https://claude.com/plugins)
[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-blue)](https://claude.com/plugins)
[![MCP Server](https://img.shields.io/badge/MCP-Server-green)](https://modelcontextprotocol.io)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

> Published on the [Anthropic Official Plugin Marketplace](https://claude.com/plugins) — the first community-built WhatsApp channel plugin reviewed and published by Anthropic.

![Anthropic Published Status](assets/published-screenshot.png)

## Installation

```sh
claude plugin marketplace add Rich627/whatsapp-claude-plugin
claude plugin install whatsapp-channel@whatsapp-claude-plugin
claude --dangerously-load-development-channels plugin:whatsapp-channel@whatsapp-claude-plugin
```

The `--dangerously-load-development-channels` flag matters: it registers the plugin as a **channel**, so an inbound WhatsApp message wakes your session immediately. Without it the tools still load, but nothing wakes the session when messages arrive — they sit unanswered until you (or a [watchdog](./scripts/watchdog.sh)) prompt Claude to check. `--channels` does not accept this plugin yet (it is not on the research-preview allowlist), so the development flag is currently the only way.

Inside the session, set your number and pair:

```text
/whatsapp-channel:configure <phone>   # country code + number, no +
```

A pairing code is printed on first launch. On your phone: WhatsApp → Settings → Linked Devices → Link a Device → **Link with phone number instead** → enter the code. No WhatsApp Business API, Meta developer account, or API key is involved — it links to your regular account.

## Other MCP clients (Codex CLI, Gemini CLI, Cursor)

The server is a plain stdio MCP server, so any MCP client can run it. Two things are Claude Code specific and worth knowing before you start:

- **Inbound messages are not pushed.** Waking a session on an incoming message uses `notifications/claude/channel`, a Claude Code extension. MCP has no standard equivalent that reaches the model, and other clients drop unknown notifications silently. Elsewhere the plugin is poll-based: call `wait_for_messages` (waits up to 40s for the next message) or `catch_up` / `unreplied`. Every tool result also carries a count of unreplied messages, so a client finds out there is traffic on its next call whatever that call was.
- **Setup is done from a terminal, not a slash command.** `/whatsapp-channel:access` and friends are Claude Code skills. Use `bun scripts/access.ts` instead (see [Access control from a terminal](#access-control-from-a-terminal)).

Register the server with an absolute path — `${CLAUDE_PLUGIN_ROOT}` is substituted by Claude Code only:

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.whatsapp]
command = "bun"
args = ["run", "--cwd", "/absolute/path/to/whatsapp-channel", "start"]
startup_timeout_sec = 30   # default 10 is tight for a first Baileys connect
tool_timeout_sec = 120     # default 60; wait_for_messages parks for up to 40s
```

**Gemini CLI** (`~/.gemini/settings.json`)

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "bun",
      "args": [
        "run",
        "--cwd",
        "/absolute/path/to/whatsapp-channel",
        "start"
      ],
      "timeout": 600000
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json` for all projects, `.cursor/mcp.json` for one)

```json
{
  "mcpServers": {
    "whatsapp": {
      "type": "stdio",
      "command": "bun",
      "args": [
        "run",
        "--cwd",
        "/absolute/path/to/whatsapp-channel",
        "start"
      ]
    }
  }
}
```

Only one client at a time can hold the WhatsApp connection: WhatsApp allows one linked-device session per account, and two servers would kick each other off. A second server does not fail silently — it stays up and serves a single `whatsapp_unavailable` tool naming the process that holds the connection.

## Access control from a terminal

Everything the access skill does, without Claude Code:

```sh
bun scripts/access.ts status                 # policy, allowlist, pending codes, groups
bun scripts/access.ts policy pairing         # open the door
bun scripts/access.ts pair <code>            # approve someone who messaged you
bun scripts/access.ts allow <jid>            # add directly
bun scripts/access.ts remove <jid>
bun scripts/access.ts group add <groupJid> [--mention] [--allow jid1,jid2]
bun scripts/access.ts set replyToMode first  # ackReaction, textChunkLimit, chunkMode, mentionPatterns
```

Approving always needs the specific code, even when only one pairing is waiting: anyone can create a pending entry just by messaging the account, so "approve the pending one" is exactly what a prompt-injected request looks like. For the same reason this is a terminal command and deliberately **not** an MCP tool, so nothing arriving over WhatsApp can reach it.

## Features

- **Bidirectional messaging.** Send and receive from the session; long replies are chunked to WhatsApp's limits or sent as a document attachment past a configurable threshold.
- **@-mentions.** `reply` can tag people so they actually get notified — ids are accepted as phone, LID, or full JID, and mentions attach only to the chunk that names them.
- **Full media support.** Photos, voice notes, video, documents, and stickers, in both directions.
- **Voice transcription.** Incoming voice notes are transcribed locally via mlx-whisper (see [setup](#voice-transcription-optional)); without the script they arrive as plain attachments.
- **Access control.** Pairing codes, allowlists, and per-group policies gate every inbound message — strangers never reach your session. Managed via `/whatsapp-channel:access` in Claude Code, or `bun scripts/access.ts` anywhere.
- **Per-group personalities.** Each group gets its own `config.md` with a custom personality and conversation memory.
- **Permission relay.** Approve or deny Claude's tool requests from WhatsApp with an emoji reaction (👍 / 👎).
- **Cron tasks.** A `## Cron Jobs` section in a group's `config.md` schedules recurring server-side tasks.
- **Context recovery.** After a restart, the `catch_up` tool replays recent two-way conversation per chat, unreplied counts, and open tasks from `tasks.md`, so a fresh session resumes mid-flight work.
- **Dual accounts.** Run personal and business numbers side by side with separate state and behaviors.
- **Self-diagnosis.** `/whatsapp-channel:doctor` checks the server process, device link, singleton lock, and config, then walks you through the fixes — no more guessing why replies stopped.

## How it works

```text
WhatsApp (phone) <──Baileys──> MCP Server <──stdio──> Claude Code
```

The server (a single Bun process) holds the linked-device connection and forwards inbound messages to the session as channel notifications after they pass the access gate. Claude acts through MCP tools — `reply`, `react`, `edit_message`, `download_attachment`, `status`, `unreplied`, `catch_up`, `list_groups`. Runtime state (auth, allowlists, group configs, inbox) lives in `~/.whatsapp-channel/`, never in the repo.

Messages sent by Claude appear as coming from your phone number. Use a dedicated number if you want a distinct bot identity.

## Voice transcription (optional)

One-time setup (Apple Silicon, mlx-whisper):

```bash
brew install ffmpeg                      # mlx-whisper uses it to decode audio
python3 -m venv ~/whisper-env
source ~/whisper-env/bin/activate
pip install mlx-whisper
cp scripts/whisper-transcribe.sh ~/whisper-transcribe.sh
chmod +x ~/whisper-transcribe.sh
~/whisper-transcribe.sh path/to/sample.ogg   # optional: test
```

The reference script uses `mlx-community/whisper-large-v3-turbo` — accurate, fast, multilingual. Swap the model in the script if you prefer a smaller one.

## Troubleshooting

| Issue                               | Solution                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pairing code not showing            | Run `/whatsapp-channel:configure <phone>` first, then relaunch                                                                                                                                                                                                                                                                                                                               |
| 440 disconnect error                | Only one connection per auth state allowed. Kill stale processes: `pkill -f "whatsapp.*server"`                                                                                                                                                                                                                                                                                                     |
| Session not waking on new messages  | Most common cause: launched without `--dangerously-load-development-channels plugin:whatsapp-channel@whatsapp-claude-plugin`. Tools work but inbound pushes are dropped (`Channel notifications skipped` in the MCP debug log) — relaunch with the flag.                                                                                                                                     |
| Messages not arriving               | Known Claude Code client bug ([#37933](https://github.com/anthropics/claude-code/issues/37933)). Server-side is correct, awaiting client fix.                                                                                                                                                                                                                                                       |
| Replies still send, nothing arrives | Send a **DM** to the connected number as well as a group message — a DM that lands while groups stay silent means the group sender-key path, not the connection. `~/.whatsapp-channel/diag.log` records an `inbound upsert` line for every batch WhatsApp delivers, so it distinguishes "never arrived" from "arrived and was dropped". Set `WHATSAPP_DIAG_DEBUG=1` for Baileys' full debug stream. |
| Auth expired                        | Run `/whatsapp-channel:configure reset-auth` and re-pair                                                                                                                                                                                                                                                                                                                                     |

## Documentation

Full documentation lives in [USAGE.md](./USAGE.md): [access control](./USAGE.md#access-control), the [tools exposed to the assistant](./USAGE.md#tools-exposed-to-the-assistant), [dual-account setup](./USAGE.md#dual-account-setup), [session conflicts](./USAGE.md#session-conflicts), and [resetting auth](./USAGE.md#resetting-auth).

## Contributing

Issues and pull requests are welcome — read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening one. Report security issues privately per [SECURITY.md](./SECURITY.md).

## Star History

<a href="https://www.star-history.com/?type=date&repos=Rich627%2Fwhatsapp-claude-plugin">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Rich627/whatsapp-claude-plugin&type=date&theme=dark&legend=top-left&sealed_token=NrfP1Fv0z7ipQM961lFZJbXE76GS7paukclIhr6km37t0lJAzivyX0JUNQTkRaxa5lSpRCYmef3xvHaiUKCgBS0KbwpeIohfMOqur0ULPiTt2h2DWcUui1YJ2nux4W9Ug8u8D6CNl91ZYInSZCrrdNi5hydWjSLy89XtzYYM83F-mhgJI44lLZoxj7Na" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Rich627/whatsapp-claude-plugin&type=date&legend=top-left&sealed_token=NrfP1Fv0z7ipQM961lFZJbXE76GS7paukclIhr6km37t0lJAzivyX0JUNQTkRaxa5lSpRCYmef3xvHaiUKCgBS0KbwpeIohfMOqur0ULPiTt2h2DWcUui1YJ2nux4W9Ug8u8D6CNl91ZYInSZCrrdNi5hydWjSLy89XtzYYM83F-mhgJI44lLZoxj7Na" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Rich627/whatsapp-claude-plugin&type=date&legend=top-left&sealed_token=NrfP1Fv0z7ipQM961lFZJbXE76GS7paukclIhr6km37t0lJAzivyX0JUNQTkRaxa5lSpRCYmef3xvHaiUKCgBS0KbwpeIohfMOqur0ULPiTt2h2DWcUui1YJ2nux4W9Ug8u8D6CNl91ZYInSZCrrdNi5hydWjSLy89XtzYYM83F-mhgJI44lLZoxj7Na" />
 </picture>
</a>

## License

[Apache 2.0](./LICENSE) — Copyright 2025 Richie Liu
