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
      version: "0.20.0",
      notes: [
        `The guided setup wizard can now take access back, not just hand it out: \`${WIZARD_CMD} --revoke\` lists everything currently configured and you tick what should lose access. Leaving everything unticked removes nothing.`,
        "You will now be told when a newer version of this plugin is available, instead of only hearing about one after you had already installed it.",
        "Fixed: the WA:<role> statusline segment never appeared. It was looking for the server in the wrong branch of the process tree, and failing silently when it did not find it.",
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
    // SessionStart output reaches the MODEL, not the user's screen, so a
    // notice that is not relayed is a notice nobody read. Say so explicitly
    // rather than hoping it gets mentioned.
    const content =
      "Tell the user the following in your next message - it is a notice for them, not background context for you:\n\n" +
      sections.join("\n\n");
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: content,
        },
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
