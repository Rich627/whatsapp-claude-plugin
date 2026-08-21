# WhatsApp — Access & Delivery

WhatsApp has no bot API — this channel connects as a **linked device** (like WhatsApp Web). Any contact who can message the linked phone number can reach the server. The access model described here decides who gets through.

By default, a DM from an unknown sender triggers **pairing**: the server replies with a 6-character code and drops the message. You run `/whatsapp-claude-channel:access pair <code>` from your Claude Code session to approve them. Once approved, their messages pass through.

All state lives in `~/.whatsapp-channel/access.json`. The `/whatsapp-claude-channel:access` skill commands edit this file; the server re-reads it on every inbound message, so changes take effect without a restart. Set `WHATSAPP_ACCESS_MODE=static` to pin config to what was on disk at boot (pairing is unavailable in static mode since it requires runtime writes).

## At a glance

|                     |                                                   |
| ------------------- | ------------------------------------------------- |
| Default policy      | `pairing`                                         |
| Sender ID           | WhatsApp JID (e.g. `886912345678@s.whatsapp.net`) |
| Group key           | Group JID (e.g. `120363424405607157@g.us`)        |
| `ackReaction` quirk | Any emoji — WhatsApp has no fixed whitelist       |
| Config file         | `~/.whatsapp-channel/access.json`                 |

## DM policies

`dmPolicy` controls how DMs from senders not on the allowlist are handled.

| Policy              | Behavior                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `pairing` (default) | Reply with a pairing code, drop the message. Approve with `/whatsapp-claude-channel:access pair <code>`. |
| `allowlist`         | Drop silently. No reply. Prevents strangers from knowing the linked device is active.                    |
| `disabled`          | Drop everything, including allowlisted users and groups.                                                 |

```
/whatsapp-claude-channel:access policy allowlist
```

## User IDs (JIDs)

WhatsApp identifies users by **JIDs** — phone number + `@s.whatsapp.net`, e.g. `886912345678@s.whatsapp.net`. The allowlist stores JIDs.

Pairing captures the JID automatically. To add one manually, use the phone number with country code, no leading `+`, followed by `@s.whatsapp.net`.

```
/whatsapp-claude-channel:access allow 886912345678@s.whatsapp.net
/whatsapp-claude-channel:access remove 886912345678@s.whatsapp.net
```

## Groups

Groups are off by default. Opt each one in individually.

```
/whatsapp-claude-channel:access group add 120363424405607157@g.us
```

Group JIDs end in `@g.us`. To find one, add the linked device to the group — the server logs the group JID when it receives a message from an unenabled group.

With the default `requireMention: false`, the server responds to every message. Pass `--mention` to require @mention, or `--allow jid1,jid2` to restrict which members can trigger it. Pass `--roster` to also grant roster access (see below) — off by default, same as everything else.

Running `group add` again on an already-configured group **merges**, it doesn't start over: any flag you don't pass this time keeps whatever was already set. Adding `--roster` to a group that already has `--mention` on doesn't reset `--mention` back off — only the flags you actually pass change anything. To explicitly turn `--mention` or `--roster` back off (rather than just never setting them), pass `--no-mention` / `--no-roster` — passing both a flag and its negation at once is refused, not silently resolved one way.

```
/whatsapp-claude-channel:access group add 120363424405607157@g.us
/whatsapp-claude-channel:access group add 120363424405607157@g.us --mention
/whatsapp-claude-channel:access group add 120363424405607157@g.us --allow 886912345678@s.whatsapp.net
/whatsapp-claude-channel:access group add 120363424405607157@g.us --roster
/whatsapp-claude-channel:access group add 120363424405607157@g.us --no-roster
/whatsapp-claude-channel:access group rm 120363424405607157@g.us
```

### Per-group personality & memory

Each enabled group gets a config directory at `~/.whatsapp-channel/groups/<groupJid>/`:

| File        | Purpose                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| `config.md` | Personality, goals, and instructions for Claude in this group. User edits this.    |
| `memory.md` | Conversation summaries appended by Claude automatically. Persists across sessions. |

Created automatically when a group is added. Edit `config.md` to customize Claude's behavior per group. View or clear with `/whatsapp-claude-channel:access group config <jid>` and `/whatsapp-claude-channel:access group memory <jid>`.

### LID identifiers

Baileys 7 uses LID (Local Identifier) format alongside phone JIDs. The same person may appear as both `16024101202@s.whatsapp.net` and `21737517412478@lid`. The server maintains a mapping at `~/.whatsapp-channel/lid-map.json` and resolves both formats automatically. Both work in allowlists.

## Names and privacy

The server caches saved contact names from WhatsApp's own contact sync (the same list your phone already has) at `~/.whatsapp-channel/contacts.json` — never the `contacts.md` some people keep for their own DM habits, which this plugin never reads. Only a contact's **name** is cached this way, and only a name — self-reported "About"/display text (`.notify`) is kept separately and never trusted for anything security-relevant, since anyone messaging the account can set that to whatever they want, including someone else's real name or number.

**Names may reach the AI model; raw phone numbers should not.** When you ask Claude to reply and mention someone, it can use a saved name (`"Akash"`) instead of a number — that name is what appears in Claude's context. Anywhere a number would otherwise be shown to a human (an ambiguous-name error, `group_roster` for someone with no saved name) it's masked to the last 4 digits (`•••••5122`) before it's built into any string, not filtered afterward.

This is a **best-effort mitigation, not a hard guarantee**: it depends on a saved contact actually being a name and not, say, a phone number typed into the name field, and on `.notify` not being trusted in place of it (checked explicitly for group rosters — see below). If you'd rather no name data ever reaches an AI model at all, don't grant any group `roster` access and use raw JIDs/numbers in `mentions` instead of names.

## Group roster & @all mentions

`group_roster` (an MCP tool) and `"all"` (a reserved value in the `reply` tool's `mentions` array) both require a group's `roster` flag — separate from whether Claude can act in the group at all, so you can let Claude reply in a large group without ever handing it the member list.

- **`group_roster`** lists a group's current members by saved contact name, or a masked number when no name is known. It never shows a raw number, even when a contact's self-reported name happens to look like one.
- **`"all"` in `mentions`** expands server-side to every current participant, fetched live from WhatsApp group metadata — so it mentions everyone even for members with no saved contact name, and however many there are. A saved contact literally named "All" is unaffected: name resolution always wins over the reserved value.

Both fail with a clear error if the group's `roster` flag isn't granted.

## Guided bulk setup (wizard)

`bun scripts/access.ts wizard` shows a checkbox screen of your **5 most recently active groups** and a second one for your **10 most recently active DM contacts** — the same recency signal the WhatsApp app itself sorts its own chat list by — so review stays to one screen each instead of scaling with how many groups or contacts you actually have. Navigate with the arrow keys, toggle with space, submit with enter.

- **Groups**: pick which ones Claude can reply in, then (only for the ones you just picked) a second checkbox for which also get roster access.
- **Contacts**: pick which ones can message Claude — added straight to the allowlist, no second question.
- Archived groups are skipped by default (pass `--include-archived` to include them). Anything already configured, or outside the top 5/10, isn't shown here — add it individually later with `group add`/`allow`, or just ask Claude (it already knows the name from context).
- Ctrl-C cancels cleanly at any point; nothing is written until every question on screen has been answered.
- A group the wizard adds gets `requireMention: true` (only reply when addressed) — a more cautious default than `group add`'s own CLI default of `false` (reply to everything), deliberately: the wizard is the guided path for a less technical setup, the CLI is for someone already comfortable with explicit flags. Change it after the fact with `group add --mention` or `--no-mention`.

Group/contact names and recency come from caches (`~/.whatsapp-channel/groups-meta.json`, `dm-activity.json`) that only the running server writes — automatically, as WhatsApp reports chat activity, no manual step needed once the account has connected at least once. If it's never connected yet, the wizard has nothing to show; pair it first.

It's a terminal command, deliberately not a Claude Code skill: running it yourself, outside any chat, is what makes this true —

> No group or contact data was sent to any AI model during this setup — this ran entirely in your terminal.

The `/whatsapp-claude-channel:access` skill will point you at it if you ask for guided setup there, but will never run it on your behalf.

### Removing someone already granted access

`/whatsapp-claude-channel:access remove <jid>` (or the equivalent CLI command) also forgets their cached name from `contacts.json`, not just their allowlist entry — it does **not** touch `lid-map.json` (needed for correct message/mention matching if they're still an active participant in a group you can see) and it does **not** remove them from any shared group or block them on WhatsApp, neither of which this plugin does. If they're still in a group with roster access, they'll show up there as a masked number from then on instead of by name — the honest consequence of choosing to forget someone this plugin was never going to remove from a group.

## Mention detection

In groups with `requireMention: true`, any of the following triggers the server:

- A structured @mention of the linked account's JID
- A match against any regex in `mentionPatterns`

```
/whatsapp-claude-channel:access set mentionPatterns '["claude", "assistant"]'
```

## Delivery

Configure outbound behavior with `/whatsapp-claude-channel:access set <key> <value>`.

**`ackReaction`** reacts to inbound messages on receipt. WhatsApp supports **any emoji** — there's no fixed whitelist like Telegram.

```
/whatsapp-claude-channel:access set ackReaction 👀
/whatsapp-claude-channel:access set ackReaction ""
```

**`replyToMode`** controls threading on chunked replies. When a long response is split, `first` (default) threads only the first chunk under the inbound message; `all` threads every chunk; `off` sends all chunks standalone.

**`textChunkLimit`** sets the split threshold. Default is 4096.

**`chunkMode`** chooses the split strategy: `length` cuts exactly at the limit; `newline` prefers paragraph boundaries.

## Skill reference

| Command                                                              | Effect                                                                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `/whatsapp-claude-channel:access`                                    | Print current state: policy, allowlist, pending pairings, enabled groups.                                                         |
| `/whatsapp-claude-channel:access pair a4f91c`                        | Approve pairing code `a4f91c`. Adds the sender to `allowFrom` and sends a confirmation on WhatsApp.                               |
| `/whatsapp-claude-channel:access deny a4f91c`                        | Discard a pending code. The sender is not notified.                                                                               |
| `/whatsapp-claude-channel:access allow 886912345678@s.whatsapp.net`  | Add a JID directly.                                                                                                               |
| `/whatsapp-claude-channel:access remove 886912345678@s.whatsapp.net` | Remove from the allowlist.                                                                                                        |
| `/whatsapp-claude-channel:access policy allowlist`                   | Set `dmPolicy`. Values: `pairing`, `allowlist`, `disabled`.                                                                       |
| `/whatsapp-claude-channel:access group add 120363424405607157@g.us`  | Enable a group (merges into an existing entry). Flags: `--mention`/`--no-mention`, `--allow jid1,jid2`, `--roster`/`--no-roster`. |
| `/whatsapp-claude-channel:access group rm 120363424405607157@g.us`   | Disable a group.                                                                                                                  |
| `/whatsapp-claude-channel:access set ackReaction 👀`                 | Set a config key: `ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`, `mentionPatterns`.                                 |

## Config file

`~/.whatsapp-channel/access.json`. Absent file is equivalent to `pairing` policy with empty lists, so the first DM triggers pairing.

```jsonc
{
  // Handling for DMs from senders not in allowFrom.
  "dmPolicy": "pairing",

  // WhatsApp JIDs allowed to DM.
  "allowFrom": ["886912345678@s.whatsapp.net"],

  // Groups the channel is active in. Empty object = DM-only.
  "groups": {
    "120363424405607157@g.us": {
      // true: respond only to @mentions.
      "requireMention": true,
      // Restrict triggers to these senders. Empty = any member (subject to requireMention).
      "allowFrom": [],
      // Grants group_roster and "all" mentions. Separate from acting in the
      // group at all - see "Group roster & @all mentions" above.
      "roster": false,
    },
  },

  // Case-insensitive regexes that count as a mention.
  "mentionPatterns": ["claude"],

  // Any emoji. Empty string disables.
  "ackReaction": "👀",

  // Threading on chunked replies: first | all | off
  "replyToMode": "first",

  // Split threshold.
  "textChunkLimit": 4096,

  // length = cut at limit. newline = prefer paragraph boundaries.
  "chunkMode": "newline",
}
```
