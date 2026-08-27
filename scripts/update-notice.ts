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
      version: "0.22.0",
      notes: [
        "Asking Claude to add a contact or a group now opens the access screen for you in a new terminal window: you pick there, and the session is told only what changed - never the list of who you talk to. Running it yourself is still the same screen.",
        'Fixed: the WA:<role> statusline segment was blank for the first few seconds of a session, and because Claude Code only redraws the statusline when you type, it often stayed blank until your first message. A terminal that asked for the WhatsApp channel now shows a dim WA:… straight away, and the server writes its role file earlier, so the real primary/secondary label arrives sooner. Add `"refreshInterval": 5` to your statusLine setting (see USAGE.md) and the label updates on its own instead of waiting for your next keystroke.',
        "The server now keeps its contact-name and recent-DM caches by default, so the setup wizard and `/whatsapp-channel:access review` finally have your recent contacts to show instead of an empty list, and saved names survive a restart. Both files stay on your own machine, readable only by you - set WHATSAPP_CACHE_CONTACTS=0 if you would rather nothing about a sender were written to disk, and static mode never writes them at all.",
        'Replies you type on your phone are no longer invisible to Claude. For chats already on your allowlist, the message is logged the moment you send it, so the unreplied list clears and `catch_up` shows both sides of the conversation instead of only Claude\'s half. Your own words stay readable for an hour and then collapse to a "replied (text expired)" line, and `catch_up` now replays the last 5 messages per chat rather than 15.',
        "Fixed: restarting the plugin could mark a chat's unanswered messages as already replied to. WhatsApp re-delivers recent messages when the plugin reconnects, and it no longer mistakes its own earlier replies for ones you typed on your phone.",
        'Fixed: a message you sent to yourself (the "Me" chat) was silently dropped. WhatsApp delivers your own self-chat under your own @lid and never tells the linked device how that @lid maps to your number, so the allowlist match failed. The server now records that mapping itself the moment it connects.',
        "Fixed: the connection's diagnostic log recorded full phone numbers - including for a message it then refused, whose sender was never on your allowlist. Every number this plugin writes to that log is now masked to its last four digits, and a group keeps its identifying form so an outage is still diagnosable. Baileys' own library logging is deliberately left alone and still carries full JIDs at its default level, so the log is not a place to keep secrets.",
        "Fixed: the session-start hook failed with `No such file or directory` when the plugin's install path contained a space (a home folder like `C:\Users\Jane Doe`), so the onboarding check and this notice never ran. The path is now quoted.",
        "`/whatsapp-channel:access review` is no longer a list you page through in the chat. It opens the access screen in a new terminal window - contacts and groups on one screen, everything already approved pre-ticked, type to search - and when you are done it reports back just the additions and removals, by name.",
        "Changed your mind: `/whatsapp-channel:access undo` puts back the access list from just before the last run of the access screen - run it with `--dry-run` first to see exactly what would come back and what would go. Cached names are not restored, only the access list itself.",
        "The terminal wizard is now a single screen: your contacts on the left, your groups on the right, everything Claude can already reach pre-ticked. Type to filter both lists, space or enter to tick, and what you have picked shows as chips along the top - an access grant you took away shows struck through. Undo steps back one tick, Restore puts back the access list from before the last run, and nothing is written until you have seen the whole +/- list and answered Apply. `wizard --revoke` still works and opens that same screen. It needs a real terminal window - run through a pipe and it now says so instead of hanging.",
        "Taking a contact's DM access away in that screen no longer forgets their saved name - only the allowlist entry goes. Clear a cached name deliberately with `forget <jid>`, which is unchanged.",
        "Saved contact names now fill in by themselves. WhatsApp only hands the names you saved on your phone to a linked device once, when it is first linked, so a plugin linked before this cache existed had names for nobody. It now asks WhatsApp for that list again on connect if it is holding no saved names yet, and stops asking once it has them.",
      ],
    },
    {
      version: "0.21.2",
      notes: [
        "Fixed: the WA:<role> statusline segment could still show a role for a server that had been killed, if the operating system had since handed that process id to something else. It now checks that the process really is a running server before believing the file.",
      ],
    },
    {
      version: "0.21.1",
      notes: [
        "Fixed: the WA:<role> statusline segment could keep showing a role after its server had been killed, because the file it reads is only removed on a clean shutdown. It now checks the server is still running before believing the file.",
      ],
    },
    {
      version: "0.21.0",
      notes: [
        `The guided setup wizard can now take access back, not just hand it out: \`${WIZARD_CMD} --revoke\` lists everything currently configured and you tick what should lose access. Leaving everything unticked removes nothing.`,
        "You will now be told when a newer version of this plugin is available, instead of only hearing about one after you had already installed it. Notices like this one now print straight to your terminal rather than being passed to the assistant and hoping it mentions them.",
        "`/whatsapp-channel:access` with no arguments now ends by telling you how to add groups and contacts, how to take access back, and how to do either with no AI model involved.",
        "Fixed: the WA:<role> statusline segment never appeared. It was looking for the server in the wrong branch of the process tree, and failing silently when it did not find it. Each server now records which session it belongs to, so with several sessions open every terminal shows its own role rather than possibly a neighbour's.",
        "Fixed: leftover `.role-<pid>` files from crashed or killed sessions are now cleared at startup instead of piling up in `~/.whatsapp-channel/` forever.",
      ],
    },
    {
      version: "0.20.0",
      notes: [
        "The plugin was renamed from `whatsapp-claude-channel` to `whatsapp-channel`, so its commands are now `/whatsapp-channel:access`, `/whatsapp-channel:configure` and so on. An install under the old name keeps working but stops receiving updates - reinstall with `/plugin install whatsapp-channel@whatsapp-claude-plugin` to keep getting them.",
      ],
    },
    {
      version: "0.19.0",
      notes: [
        "Access review now works without leaving the chat: `/whatsapp-channel:access review` shows a checkbox list of your most recently active groups and contacts to approve, and `manage` shows what is already approved so you can take it back. The terminal wizard is still there when you want a decision made with no AI model in the room.",
      ],
    },
    {
      version: "0.18.0",
      notes: [
        "Proactive notifications: Claude now tells you about an inbound message, a role change, a pairing code, or this notice right away instead of waiting for its next natural reply. Set WHATSAPP_QUIET=1 on a terminal to turn that off.",
        `There's a guided setup wizard (\`${WIZARD_CMD}\`) that shows a checkbox screen of your most recently active WhatsApp groups and DM contacts, so you can bulk-approve chats you already have instead of pairing them one at a time.`,
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
          notes.map((n) => `- ${n}`).join("\n"),
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
