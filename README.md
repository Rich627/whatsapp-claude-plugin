# WhatsApp Channel for Claude Code

Drive your Claude Code session from WhatsApp. Choose a **linked device** for a
personal account or the **official WhatsApp Cloud API** for business DMs.

The default Baileys provider connects like WhatsApp Web: pair your phone, then
Claude replies from your own number. Existing installations keep this provider.
The optional Cloud API provider uses Meta's business API and a public HTTPS
webhook, with its own credentials, messaging policies and applicable fees.
Both providers feed the same MCP channel and access gate.

[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-blue)](https://code.claude.com/docs/en/plugins)
[![MCP Server](https://img.shields.io/badge/MCP-Server-green)](https://modelcontextprotocol.io)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

> **Community project.** This plugin is not made or endorsed by Anthropic or Meta.
> Its Baileys provider uses an unofficial linked-device protocol, which may
> conflict with WhatsApp's terms and put the number at risk. The optional Cloud
> provider uses official API transport; confirm your use is permitted under
> Meta's business and AI-provider rules before enabling it.

## Installation

```sh
claude plugin marketplace add Rich627/whatsapp-claude-plugin
claude plugin install whatsapp-channel@whatsapp-claude-plugin
claude --dangerously-load-development-channels plugin:whatsapp-channel@whatsapp-claude-plugin
```

The `--dangerously-load-development-channels` flag matters: it registers the plugin as a **channel**, so an inbound WhatsApp message wakes your session immediately. Without it the tools still load, but nothing wakes the session when messages arrive — they sit unanswered until you (or a [watchdog](./scripts/watchdog.sh)) prompt Claude to check. `--channels` does not accept this plugin yet (it is not on the research-preview allowlist), so the development flag is currently the only way.

> **Know what this flag does.** Claude Code warns against loading downloaded channels this way: a loaded channel can put text from other people straight into your session. Read this plugin's code before you use it, keep the [allowlist](./ACCESS.md) to people you trust, and keep permission prompts on. Never combine it with `--dangerously-skip-permissions`: with prompts off, anyone in an allowlisted chat could get Claude to run commands on your computer.

Inside the session, choose your connection:

```text
/whatsapp-channel:setup
/whatsapp-channel:configure provider
```

The wizard runs in your own terminal so Cloud credentials never pass through
chat. Or run `bun scripts/provider.ts choose` from the plugin directory.

| Connection                         | Setup                                                                       | Main limits                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Linked device (`baileys`, default) | Pair your phone; no Meta API credentials                                    | Unofficial protocol; existing personal/group behavior                                  |
| Official (`cloud-api`)             | Meta business number, token, app secret, verify token, public HTTPS webhook | DMs only in this implementation; service window/templates and Meta fees/policies apply |

For linked-device pairing, save your number with
`/whatsapp-channel:configure <phone>` (country code + number, no `+`). Enter the
printed pairing code in WhatsApp → Settings → Linked Devices → Link a Device →
**Link with phone number instead**, or scan the QR.

For official business DMs, follow [Cloud API setup](./docs/cloud-api.md). This
provider does not yet support groups, message editing, phone history/address-book
import or coexistence synchronization. Add an explicitly allowed personal owner;
the business number is never auto-added. Configuration readiness is not proof
that the public webhook works. Rates vary; consult
[Meta pricing](https://business.whatsapp.com/products/platform-pricing) and
[FAQ](https://whatsappbusiness.com/resources/faq/).

## Other MCP clients (Codex CLI, Gemini CLI, Cursor)

The server is a plain stdio MCP server, so any MCP client can run it. Two things are Claude Code specific and worth knowing before you start:

- **Inbound messages are not pushed.** Waking a session on an incoming message uses `notifications/claude/channel`, a Claude Code extension. MCP has no standard equivalent that reaches the model, and other clients drop unknown notifications silently. Elsewhere the plugin is poll-based: call `wait_for_messages` (parks up to 40s; the first call on a connection returns whatever is already unreplied, later calls only what arrived since) or `catch_up` / `unreplied`. Most tool results also carry a count of unreplied messages, so a client finds out there is traffic on its next call. Three do not: `unreplied` and `wait_for_messages`, which just returned those very messages, and `catch_up` with no arguments, which is that count already.
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
      "args": ["run", "--cwd", "/absolute/path/to/whatsapp-channel", "start"],
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
      "args": ["run", "--cwd", "/absolute/path/to/whatsapp-channel", "start"]
    }
  }
}
```

Only one client at a time can hold a state directory’s singleton lock. With Baileys, two connections using the same linked-device auth would kick each other off. Use separate state directories for separate numbers. A second server does not fail silently — it stays up and serves a single `whatsapp_unavailable` tool naming the process that holds the connection.

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

The list below describes the default linked-device provider. See the
[provider capability comparison](./docs/cloud-api.md#capabilities-in-this-plugins-first-cloud-provider)
for the initial Cloud API scope. Shared DM access, attachment processing,
transcription and context recovery also work with Cloud API.

- **Bidirectional messaging.** Send and receive from the session; long replies are chunked to WhatsApp's limits or sent as a document attachment past a configurable threshold.
- **@-mentions.** `reply` can tag people so they actually get notified — ids are accepted as phone, LID, or full JID, and mentions attach only to the chunk that names them.
- **Full media support.** Photos, voice notes, video, documents, and stickers, in both directions.
- **Voice transcription.** Incoming voice notes are transcribed locally via mlx-whisper (see [setup](#voice-transcription-optional)); without the script they arrive as plain attachments.
- **Access control.** Pairing codes, allowlists, and per-group policies gate every inbound message — strangers never reach your session. Managed via `/whatsapp-channel:access` in Claude Code, or `bun scripts/access.ts` anywhere.
- **Per-group personalities.** Each group gets its own `config.md` with a custom personality and conversation memory.
- **Permission relay.** Approve or deny Claude's tool requests from WhatsApp with an emoji reaction (👍 / 👎).
- **Cron tasks.** A `## Cron Jobs` section in a group's `config.md` schedules recurring server-side tasks.
- **Context recovery.** After a restart, `catch_up` with no arguments says how many messages are waiting per chat - counts only, no message text - plus open tasks from `tasks.md`. Name a chat and it replays that room's recent two-way conversation, so a fresh session resumes mid-flight work without reading every chat it has.
- **Dual accounts.** Run personal and business numbers side by side with separate state and behaviors.
- **Self-diagnosis.** `/whatsapp-channel:doctor` checks the server process, device link, singleton lock, and config, then walks you through the fixes — no more guessing why replies stopped.

## How it works

```text
WhatsApp linked device <──Baileys────────> MCP Server <──stdio──> Claude Code
WhatsApp business DMs   <──Cloud API/HTTPS─> MCP Server
```

The server (a single Bun process) holds either the linked-device connection or the Cloud API webhook listener and forwards inbound messages after they pass the access gate. Claude acts through shared MCP tools such as `reply`, `react`, `download_attachment`, `status`, `unreplied` and `catch_up`. Provider-specific tools include linked-device group/edit operations and Cloud `send_template`. Runtime state lives in `~/.whatsapp-channel/` (or `WHATSAPP_STATE_DIR`), never in the repo.

Messages sent by Claude appear from your linked personal number or configured business number. Use a dedicated number if you want a distinct assistant identity.

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

**Cloud alternative.** To skip the local setup, open `/plugin`, pick this plugin, and set **Voice transcription provider** to `groq` or `openai` along with that provider's API key. Keys are kept in your OS keychain, not in `settings.json`. Voice notes are then uploaded to `api.groq.com` or `api.openai.com` for transcription. The older `TRANSCRIPTION_PROVIDER`, `GROQ_API_KEY` and `OPENAI_API_KEY` environment variables still work.

## Troubleshooting

| Issue                               | Solution                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pairing code not showing            | Run `/whatsapp-channel:configure <phone>` first, then relaunch                                                                                                                                                                                                                                                                                                                                      |
| 440 disconnect error                | Only one connection per auth state allowed. Kill stale processes: `pkill -f "whatsapp.*server"`                                                                                                                                                                                                                                                                                                     |
| Session not waking on new messages  | Most common cause: launched without `--dangerously-load-development-channels plugin:whatsapp-channel@whatsapp-claude-plugin`. Tools work but inbound pushes are dropped (`Channel notifications skipped` in the MCP debug log) — relaunch with the flag.                                                                                                                                            |
| Messages not arriving               | Known Claude Code client bug ([#37933](https://github.com/anthropics/claude-code/issues/37933)). Server-side is correct, awaiting client fix.                                                                                                                                                                                                                                                       |
| Replies still send, nothing arrives | Send a **DM** to the connected number as well as a group message — a DM that lands while groups stay silent means the group sender-key path, not the connection. `~/.whatsapp-channel/diag.log` records an `inbound upsert` line for every batch WhatsApp delivers, so it distinguishes "never arrived" from "arrived and was dropped". Set `WHATSAPP_DIAG_DEBUG=1` for Baileys' full debug stream. |
| Auth expired                        | Run `/whatsapp-channel:configure reset-auth` and re-pair                                                                                                                                                                                                                                                                                                                                            |

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
