#!/usr/bin/env bun
/**
 * Prints the SessionStart hook's notice to stdout as a complete,
 * ready-to-emit JSON object, or nothing at all if there's nothing to say.
 *
 * Two different notices, and the difference matters:
 *   - "what's new"  — this install just changed version. One-time, gated on
 *                     .last-seen-version, which this script advances.
 *   - "update available" — a NEWER version exists that the user has not
 *                     installed. Not gated on anything: it repeats every
 *                     session until they actually update, and stops by
 *                     itself when they do.
 *
 * The second one is issue #2. The first can only ever announce a version the
 * user ALREADY has (it reads this plugin's own plugin.json), so on its own
 * the plugin could never tell anyone an update was waiting.
 *
 * Invoked by hooks-handlers/session-start.sh once setup is fully
 * configured — a version bump is a session-start-shaped file check,
 * unrelated to the WhatsApp connection a role change comes from, so it
 * doesn't live in server.ts (moved here per PR #22 review). A real script
 * rather than more hand-rolled bash so version comparison and JSON output
 * reuse localeCompare/JSON.stringify instead of reimplementing both.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { wizardCmd } from "./wizard-cmd";

const STATE_DIR =
  process.env.WHATSAPP_STATE_DIR ?? join(homedir(), ".whatsapp-channel");
const ENV_FILE = join(STATE_DIR, ".env");
const LAST_SEEN_VERSION_FILE = join(STATE_DIR, ".last-seen-version");

// Mirrors server.ts's own .env check (real env wins, surrounding quotes
// stripped) so static mode reads the same regardless of which process asks.
function isStaticMode(): boolean {
  if (process.env.WHATSAPP_ACCESS_MODE === "static") return true;
  try {
    const raw = readFileSync(ENV_FILE, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^WHATSAPP_ACCESS_MODE=(.*)$/);
      if (!m) continue;
      const value = m[1].replace(/\r$/, "").replace(/^(['"])(.*)\1$/, "$2");
      if (value === "static") return true;
    }
  } catch {}
  return false;
}

if (!isStaticMode()) {
  const WIZARD_CMD = wizardCmd(join(import.meta.dir, ".."));
  // Hand-maintained: one entry per version worth telling a returning
  // terminal about (moved here from server.ts's old CHANGELOG). Shows every
  // entry newer than the state directory's last-seen version concatenated,
  // so skipping several updates still surfaces all of them, not just the
  // latest.
  const CHANGELOG: { version: string; notes: string[] }[] = [
    {
      version: "0.25.0",
      notes: [
        "If you copied the permissions block from USAGE.md, copy it again - its ids were wrong until now.",
        "That includes if you re-copied it after the 0.23.0 note, which pointed at the same wrong block.",
        "Session start no longer reads out every chat. catch_up now says how many are waiting, per chat.",
        "An @ there marks a group where someone actually addressed you. Name a chat to read it.",
        "Replies you typed on your phone no longer fade after an hour - both halves of a chat read in full.",
        "An unanswered message no longer expires a day before everything else. Every line now lives 7 days.",
        "Set WHATSAPP_MESSAGE_TTL_DAYS to any value from 1 to 30 to change that. It bounds inbox/ too.",
        "A photo or voice note with no caption now reads as [photo] or [voice], not a raw (image) marker.",
        "When two contacts' numbers end in the same four digits, catch_up asks which one you meant.",
        "It used to pick whichever came first, so a reply could go to the wrong person.",
        "`access set owner` now only accepts a contact you have allowlisted.",
        "A mistyped digit used to send every permission request, command text and all, to a stranger.",
        "`unreplied` and `wait_for_messages` now show the newest 100 and say how many more are waiting.",
        "Remove the owner from the allowlist and permission requests go to your own chat, not to a stranger.",
        "The CLI and the server now agree on what your jid looks like, so `access set owner` sticks.",
        'Cron: the documented (cron: "expr") form now works, and 9/2 fires at 9, 11, 13 - not 0, 2, 4.',
        "wait_for_messages now waits for what arrives AFTER the call, instead of returning the same backlog.",
        "The first call on a connection still returns whatever is already waiting, so nothing is missed.",
        "A markdown heading in a reply now arrives bold, not italic, and `a * b * c` stays plain.",
      ],
    },
    {
      version: "0.24.1",
      notes: [
        "**Bold** in a reply was arriving as italic: the italic rule re-matched what the bold rule made.",
        "Bold now renders as bold.",
      ],
    },
    {
      version: "0.24.0",
      notes: [
        "The in-memory message store (500 entries, shared across chats) is now sized by WHATSAPP_MAX_STORE.",
        'Raise it if download_attachment says "Message not found in store" on a busy account.',
        "Anything that is not a positive whole number falls back to 500.",
      ],
    },
    {
      version: "0.23.2",
      notes: [
        "`unreplied` now prints message_id on voice notes, documents and audio, for download_attachment.",
      ],
    },
    {
      version: "0.23.1",
      notes: [
        "Documents you send (PDFs, markdown, spreadsheets, audio) now arrive with their real file type.",
        "Android WhatsApp used to show them as an unopenable BIN file.",
      ],
    },
    {
      version: "0.23.0",
      notes: [
        "If you copied the permissions block from USAGE.md, replace it - its tool ids matched nothing.",
        "A message arriving in the same instant as a reply was filed as old backlog and never notified.",
        "No ack, and any photo or voice note in it was never downloaded. Likeliest right after a long reply.",
        "A group could go quiet while DMs kept working: one unanswered metadata request hung it for good.",
        "Metadata lookups are now bounded, and a group whose name cannot be fetched shows its id.",
        "A voice note no longer freezes replies, cron jobs and the connection while it is transcribed.",
        "Approving a tool permission is now tied to the chat the request was actually sent to.",
        "`access status` shows that chat and `access set owner <jid>` changes it.",
        "Existing setups keep the chat they already used.",
        "Both approval routes now work from your own note-to-self, which previously accepted neither.",
        "An @-mention in a photo, video or document caption now counts as addressing Claude.",
        "Replying no longer marks messages that arrived while the reply was still uploading as answered.",
        "A cron schedule that can never match (`daily 25:00`, `every 90 min`) is now reported, not ignored.",
        "A config.md saved with Windows line endings no longer yields zero jobs.",
        "The scheduler no longer drifts far enough to skip a minute entirely.",
        "You are now told when the phone unlinks the device, instead of only a line in the diagnostic log.",
        "`inbox/` and the id-mapping cache are now aged out. Nothing pruned the inbox before.",
        "`doctor` reports their size, and checks that a configured watchdog notification hook exists.",
        "Display names and group subjects can no longer use characters that impersonate another speaker.",
      ],
    },
    {
      version: "0.22.1",
      notes: [
        "Mention-gated groups can opt out of context with `group add <jid> --no-context`.",
        "Nothing members say is then stored unless Claude was addressed. Existing groups keep context.",
        "Someone who messaged you and was never approved no longer sits in the contact caches forever.",
        "Their entry ages out after 90 days. Names saved on your own phone never age out this way.",
        "An account with no saved contacts now asks WhatsApp for them once a day, not on every reconnect.",
      ],
    },
    {
      version: "0.22.0",
      notes: [
        "Replies you type on your phone are no longer invisible to Claude, for chats on your allowlist.",
        "The unreplied list clears and catch_up shows both sides instead of only Claude's half.",
        "catch_up keeps the last 5 messages from each side of a chat rather than 15 in total.",
        "A message that did not mention Claude in a mention-gated group is now kept as context, text only.",
        "It is never routed, never notified and never counted as unreplied.",
        "Context lines are kept for 7 days. (0.25.0 made that one horizon for every line.)",
        "The backlog WhatsApp delivers when the plugin reconnects is now logged too, and never acted on.",
        "catch_up takes an optional `chat`, so a session can pull one room instead of dumping every chat.",
        "Your saved contact names now fill in by themselves, and survive a restart.",
        "WhatsApp only hands them to a linked device once, so a plugin linked earlier had names for nobody.",
        "The setup wizard and `/whatsapp-channel:access review` finally have your recent contacts to show.",
        "Set WHATSAPP_CACHE_CONTACTS=0 if you would rather nothing about a sender were written to disk.",
        "`/whatsapp-channel:access review` now opens the access screen in a new terminal window.",
        "Contacts and groups on one screen, everything approved pre-ticked, type to search.",
        "It reports back just the additions and removals, by name.",
        "`/whatsapp-channel:access undo` puts back the access list from before the last run of that screen.",
        "Run it with `--dry-run` first to see exactly what would come back. Cached names are not restored.",
        "Revoking a contact's DM access in that screen no longer forgets their saved name.",
        "Clear a name deliberately with `forget <jid>`, which is unchanged.",
        "Fixed: restarting the plugin could mark a chat's unanswered messages as already replied to.",
        "Fixed: a message you sent to yourself (the Me chat) was silently dropped.",
        "Fixed: the diagnostic log recorded full phone numbers, including for a message it then refused.",
        "Every number this plugin writes to that log is now masked to its last four digits.",
        "Baileys' own logging is deliberately left alone, so the log is still not a place to keep secrets.",
        "Fixed: session start failed when the install path contained a space, so this notice never ran.",
        "Fixed: the WA:<role> statusline segment was blank for the first seconds of a session.",
        'Add `"refreshInterval": 5` to your statusLine setting and the label updates on its own.',
      ],
    },
    {
      version: "0.21.2",
      notes: [
        "Fixed: the WA:<role> statusline could show a role for a killed server whose pid was reused.",
        "It now checks the process really is a running server before believing the file.",
      ],
    },
    {
      version: "0.21.1",
      notes: [
        "Fixed: the WA:<role> statusline could keep showing a role after its server had been killed.",
        "The file it reads is only removed on a clean shutdown, so it now checks the server is alive.",
      ],
    },
    {
      version: "0.21.0",
      notes: [
        `The setup wizard can now take access back: \`${WIZARD_CMD} --revoke\` lists what is configured.`,
        "Tick what should lose access. Leaving everything unticked removes nothing.",
        "You are now told when a newer version is available, not only after you have already installed it.",
        "Notices like this one print straight to your terminal instead of being passed to the assistant.",
        "`/whatsapp-channel:access` with no arguments now ends by telling you how to add and remove access.",
        "Fixed: the WA:<role> statusline never appeared - it looked in the wrong part of the process tree.",
        "Each server now records which session it belongs to, so every terminal shows its own role.",
        "Fixed: leftover `.role-<pid>` files from killed sessions are now cleared at startup.",
      ],
    },
    {
      version: "0.20.0",
      notes: [
        "The plugin was renamed from `whatsapp-claude-channel` to `whatsapp-channel`.",
        "Its commands are now `/whatsapp-channel:access`, `/whatsapp-channel:configure` and so on.",
        "An install under the old name keeps working but stops receiving updates.",
        "Reinstall with `/plugin install whatsapp-channel@whatsapp-claude-plugin` to keep getting them.",
      ],
    },
    {
      version: "0.19.0",
      notes: [
        "`/whatsapp-channel:access review` now approves groups and contacts from a checkbox list in the chat.",
        "`manage` shows what is already approved, so you can take it back.",
        "The terminal wizard is still there when you want a decision made with no AI model in the room.",
      ],
    },
    {
      version: "0.18.0",
      notes: [
        "Claude now tells you about an inbound message, a role change or a pairing code right away.",
        "It used to wait for its next natural reply. Set WHATSAPP_QUIET=1 on a terminal to turn that off.",
        `There is a guided setup wizard (\`${WIZARD_CMD}\`) showing your most active groups and contacts.`,
        "Bulk-approve the chats you already have instead of pairing them one at a time.",
      ],
    },
  ];

  const PLUGIN_DIR = join(import.meta.dir, "..");
  const MANIFEST = JSON.parse(
    readFileSync(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8"),
  );
  const PLUGIN_VERSION: string = MANIFEST.version;
  const PLUGIN_NAME: string = MANIFEST.name;

  // Numeric collation, so "0.18.0" > "0.9.0" instead of the plain string
  // compare that gets any double-digit segment backwards. Shared by both
  // notices below.
  const newer = (a: string, b: string): boolean =>
    a.localeCompare(b, undefined, { numeric: true }) > 0;

  // What the marketplace this plugin came from currently advertises, versus
  // what is actually running here. Both halves are already on disk and
  // Claude Code refreshes the marketplace clone itself, so no network call:
  //
  //   <plugins>/cache/<marketplace>/<plugin>/<version>/   <- PLUGIN_DIR
  //   <plugins>/marketplaces/<marketplace>/.claude-plugin/marketplace.json
  //
  // Derived from this script's own location rather than hardcoded, so it
  // holds for every profile and install path. A repo checkout has neither
  // path, and an install laid out some other way simply misses - in both
  // cases this returns null and says nothing, which is the right failure for
  // something that runs on every session start.
  function availableVersion(): string | null {
    try {
      const marketplaceName = basename(join(PLUGIN_DIR, "..", ".."));
      const parsed = JSON.parse(
        readFileSync(
          join(
            PLUGIN_DIR,
            "../../../..",
            "marketplaces",
            marketplaceName,
            ".claude-plugin",
            "marketplace.json",
          ),
          "utf8",
        ),
      );
      const entries: { name?: string; version?: string }[] =
        parsed.plugins ?? [];
      // By name, not entries[0]: a marketplace is free to list several
      // plugins, and the first one is not necessarily this one.
      const mine = entries.find((e) => e.name === PLUGIN_NAME);
      return mine?.version ?? null;
    } catch {
      return null;
    }
  }

  let lastSeen = "";
  try {
    lastSeen = readFileSync(LAST_SEEN_VERSION_FILE, "utf8").trim();
  } catch {}

  const sections: string[] = [];

  const changedVersion = lastSeen !== PLUGIN_VERSION;
  if (changedVersion) {
    // A state directory that has never recorded a version (a first-ever run,
    // or an existing user updating past the point this file started being
    // written) only sees the latest entry, not the whole history.
    // slice(0, 1), NOT slice(-1): CHANGELOG is newest-first, so the tail is
    // the OLDEST entry. That mismatch shipped a first-run notice headed
    // "updated to v0.20.0" with v0.18.0's bullets under it.
    const newEntries = lastSeen
      ? CHANGELOG.filter((e) => newer(e.version, lastSeen))
      : CHANGELOG.slice(0, 1);
    const notes = newEntries.flatMap((e) => e.notes);
    // No entries means nothing truthful to say. A downgrade lands here -
    // lastSeen is NEWER than what is running, so the filter matches nothing -
    // and the header would claim an update that did not happen, over an empty
    // list, with the model told to relay it. The marker write below stays
    // unconditional so the downgrade is still recorded.
    if (notes.length > 0) {
      sections.push(
        `WhatsApp plugin updated to v${PLUGIN_VERSION}` +
          (lastSeen ? ` (from v${lastSeen})` : "") +
          `.\n\nWhat's new:\n` +
          // A blank line between bullets; the one-line-per-note
          // rule that makes it readable is in AGENTS.md's version-bump ritual.
          notes.map((n) => `- ${n}`).join("\n\n"),
      );
    }
  }

  // Deliberately NOT gated on the marker. The "what's new" notice above gets
  // exactly one session to land, because the marker advances right after it;
  // this one repeats every session until the user actually updates, and goes
  // quiet on its own the moment they do. A missed delivery is therefore
  // retried instead of lost, which is the other half of issue #2.
  const available = availableVersion();
  if (available && newer(available, PLUGIN_VERSION)) {
    sections.push(
      `A newer WhatsApp plugin is available: v${available} (this session is running v${PLUGIN_VERSION}).\n` +
        `To get it: \`claude plugin update ${PLUGIN_NAME}\`, then restart the session - the running one keeps the old copy until then.`,
    );
  }

  if (sections.length > 0) {
    // systemMessage, NOT hookSpecificOutput.additionalContext (issue #5).
    // additionalContext is the channel for things the MODEL needs to know: it
    // is folded into the session context, costs input tokens every time it
    // fires, and reaches the human only if the model chooses to mention it.
    // This is a notice FOR the human and of no use to the model, so it goes
    // on the channel that shows it to them - which also means no "please
    // relay this" preamble, the workaround that channel forced.
    //
    // The caller passes its own model-facing message through as argv[2],
    // because printing this notice REPLACES the handler's whole JSON output.
    // Carrying it here rather than restating it means the session that sees a
    // notice still briefs the model exactly like every other session, and the
    // wording lives in one place (hooks-handlers/session-start.sh).
    const modelContext = process.argv[2];
    process.stdout.write(
      JSON.stringify({
        systemMessage: sections.join("\n\n"),
        ...(modelContext
          ? {
              hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext: modelContext,
              },
            }
          : {}),
      }),
    );
  }

  if (changedVersion) {
    // Written unconditionally whenever the version changed, even if this
    // particular bump turned up no CHANGELOG entry (an odd but possible
    // state, e.g. a downgrade) - otherwise the marker never advances and
    // every future session start re-runs this same check forever.
    try {
      writeFileSync(LAST_SEEN_VERSION_FILE, PLUGIN_VERSION);
    } catch {}
  }
}
