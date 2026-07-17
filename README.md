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
claude plugin install whatsapp-claude-channel@whatsapp-claude-plugin
claude
```

Inside the session, set your number and pair:

```text
/whatsapp-claude-channel:configure <phone>   # country code + number, no +
```

A pairing code is printed on first launch. On your phone: WhatsApp → Settings → Linked Devices → Link a Device → **Link with phone number instead** → enter the code. No WhatsApp Business API, Meta developer account, or API key is involved — it links to your regular account.

## Features

- **Bidirectional messaging.** Send and receive from the session; long replies are chunked to WhatsApp's limits or sent as a document attachment past a configurable threshold.
- **@-mentions.** `reply` can tag people so they actually get notified — ids are accepted as phone, LID, or full JID, and mentions attach only to the chunk that names them.
- **Full media support.** Photos, voice notes, video, documents, and stickers, in both directions.
- **Voice transcription.** Incoming voice notes are transcribed locally via mlx-whisper (see [setup](#voice-transcription-optional)); without the script they arrive as plain attachments.
- **Access control.** Pairing codes, allowlists, and per-group policies gate every inbound message — strangers never reach your session. Managed via `/whatsapp-claude-channel:access`.
- **Per-group personalities.** Each group gets its own `config.md` with a custom personality and conversation memory.
- **Permission relay.** Approve or deny Claude's tool requests from WhatsApp with an emoji reaction (👍 / 👎).
- **Cron tasks.** A `## Cron Jobs` section in a group's `config.md` schedules recurring server-side tasks.
- **Context recovery.** After a restart, the `catch_up` tool replays recent two-way conversation per chat, unreplied counts, and open tasks from `tasks.md`, so a fresh session resumes mid-flight work.
- **Dual accounts.** Run personal and business numbers side by side with separate state and behaviors.

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

| Issue | Solution |
| --- | --- |
| Pairing code not showing | Run `/whatsapp-claude-channel:configure <phone>` first, then relaunch |
| 440 disconnect error | Only one connection per auth state allowed. Kill stale processes: `pkill -f "whatsapp.*server"` |
| Messages not arriving | Known Claude Code client bug ([#37933](https://github.com/anthropics/claude-code/issues/37933)). Server-side is correct, awaiting client fix. |
| Auth expired | Run `/whatsapp-claude-channel:configure reset-auth` and re-pair |

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
