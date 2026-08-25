#!/usr/bin/env bun
/**
 * Prints the SessionStart hook's one-time "what's new" notice to stdout as
 * a complete, ready-to-emit JSON object, or nothing at all if there's
 * nothing new. Also advances .last-seen-version when it prints one.
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
import { join } from "node:path";
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

  const PLUGIN_VERSION: string = JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", ".claude-plugin", "plugin.json"),
      "utf8",
    ),
  ).version;

  let lastSeen = "";
  try {
    lastSeen = readFileSync(LAST_SEEN_VERSION_FILE, "utf8").trim();
  } catch {}

  if (lastSeen !== PLUGIN_VERSION) {
    // "0.18.0" > "0.9.0" needs numeric collation, not a plain string
    // compare (which gets any double-digit segment backwards). A state
    // directory that has never recorded a version (a first-ever run, or an
    // existing user updating past the point this file started being
    // written) only sees the latest entry, not the whole history.
    const newEntries = lastSeen
      ? CHANGELOG.filter(
          (e) =>
            e.version.localeCompare(lastSeen, undefined, { numeric: true }) > 0,
        )
      : CHANGELOG.slice(-1);
    const notes = newEntries.flatMap((e) => e.notes);
    const content =
      `WhatsApp plugin updated to v${PLUGIN_VERSION}` +
      (lastSeen ? ` (from v${lastSeen})` : "") +
      `.\n\nWhat's new:\n` +
      notes.map((n) => `- ${n}`).join("\n");
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: content,
        },
      }),
    );
    // Written unconditionally whenever the version changed, even if this
    // particular bump turned up no CHANGELOG entry (an odd but possible
    // state, e.g. a downgrade) - otherwise the marker never advances and
    // every future session start re-runs this same check forever.
    try {
      writeFileSync(LAST_SEEN_VERSION_FILE, PLUGIN_VERSION);
    } catch {}
  }
}
