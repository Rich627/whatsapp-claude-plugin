#!/usr/bin/env bun
/**
 * access.ts — manage WhatsApp channel access from a terminal.
 *
 * Usage:              bun scripts/access.ts <command> [args]
 * Fixture/testing:    WHATSAPP_STATE_DIR=/path bun scripts/access.ts ...
 *
 * Why this exists: allowlisting, pairing and group setup used to live only in
 * skills/access/SKILL.md, which only Claude Code can execute. Under any other
 * MCP client there was no way to approve a contact except editing JSON by hand.
 * The skill still drives the friendlier conversational flow; it and this file
 * write the same access.json, so either works.
 *
 * SECURITY: this is a terminal command the user runs. It is deliberately NOT
 * exposed as an MCP tool, so a WhatsApp message can never reach it — "approve
 * the pending pairing" is exactly what a prompt-injected request looks like.
 * Path constants mirror server.ts, which cannot be imported (it acquires the
 * singleton lock at module load).
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { parseArgs } from "node:util";
import { confirm } from "@inquirer/prompts";
import { forgetContact, hasSavedName, type ContactsMap } from "./contacts";
import { groupAnchor, maskNumber } from "./mask";
import {
  applySelection,
  formatLabel,
  runPicker,
  type PickerItem,
  type PickerModel,
} from "./picker";
import {
  contactKeyFor,
  diffAccess,
  listConfiguredDms,
  listConfiguredGroups,
  rankDms,
  rankGroups,
  type AccessDiff,
  type Candidate,
  type GroupMeta,
} from "./ranking";
import { wizardCmd } from "./wizard-cmd";

const STATE_DIR =
  process.env.WHATSAPP_STATE_DIR ?? join(homedir(), ".whatsapp-channel");
const ACCESS_FILE = join(STATE_DIR, "access.json");
const ACCESS_BAK_FILE = ACCESS_FILE + ".bak";
const APPROVED_DIR = join(STATE_DIR, "approved");
const GROUPS_DIR = join(STATE_DIR, "groups");
const GROUPS_META_FILE = join(STATE_DIR, "groups-meta.json");
const DM_ACTIVITY_FILE = join(STATE_DIR, "dm-activity.json");
const CONTACTS_FILE = join(STATE_DIR, "contacts.json");
const LID_MAP_FILE = join(STATE_DIR, "lid-map.json");
// `review`'s wait signal: the wizard's window returns instantly (`start`,
// `osascript`), so `review` cannot wait on the child process exiting - it
// polls for this file instead. Written by touchPickerDone from a
// process.on("exit") handler registered at the top of the wizard branch (see
// there for why exactly there and not inside wizard()/runPicker()).
const PICKER_DONE_FILE = join(STATE_DIR, ".picker-done");

const POLICIES = ["pairing", "allowlist", "disabled"];
const SET_KEYS = [
  "owner",
  "ackReaction",
  "replyToMode",
  "textChunkLimit",
  "chunkMode",
  "mentionPatterns",
];

type GroupPolicy = {
  requireMention: boolean;
  allowFrom: string[];
  roster?: boolean;
  // false = a no-mention message stores nothing (server.ts is the reader).
  // Absent = kept for catch_up context, the 0.22.0 default.
  context?: boolean;
};
type PendingEntry = { senderId: string; chatId: string; expiresAt: number };
type Access = {
  dmPolicy: string;
  allowFrom: string[];
  groups: Record<string, GroupPolicy>;
  pending: Record<string, PendingEntry>;
  [key: string]: unknown;
};

const EMPTY_ACCESS: Access = {
  dmPolicy: "pairing",
  allowFrom: [],
  groups: {},
  pending: {},
};

function load(): Access {
  // A copy: callers mutate what load() hands back.
  if (!existsSync(ACCESS_FILE)) return structuredClone(EMPTY_ACCESS);
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, "utf8")) as
      Partial<Access> | undefined;
    return {
      ...EMPTY_ACCESS,
      ...parsed,
      allowFrom: parsed?.allowFrom ?? [],
      groups: parsed?.groups ?? {},
      pending: parsed?.pending ?? {},
    };
  } catch {
    die(`${ACCESS_FILE} is not valid JSON. Fix or delete it, then retry.`);
  }
}

// load → mutate → save with no lock: a pending entry the server adds in that
// few-ms window is lost. Accepted — the sender just messages again for a new
// code. Atomic (tmp + rename) like server.ts, so it never reads a torn file.
//
// `backup: true` copies the CURRENT access.json to access.json.bak before
// overwriting it - the one-step undo behind `undo` / `wizard --undo` (#14).
// Opt-in so the wizard and every other caller behave exactly as before: the
// in-session review passes it on the FIRST write of a run and on no other, so
// one `undo` reverses the whole run rather than only its last command.
function save(access: Access, opts: { backup?: boolean } = {}): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  if (opts.backup && existsSync(ACCESS_FILE)) {
    // tmp + rename like every other write here, and written fresh with mode
    // 0o600 rather than copied: writeFileSync's `mode` is ignored when the
    // destination already exists, so a plain copy over an older .bak could
    // leave whatever permissions that file had.
    const bakTmp = ACCESS_BAK_FILE + ".tmp";
    writeFileSync(bakTmp, readFileSync(ACCESS_FILE), { mode: 0o600 });
    renameSync(bakTmp, ACCESS_BAK_FILE);
    process.stdout.write(
      `Saved the previous access.json to ${ACCESS_BAK_FILE} - "undo" restores it.\n`,
    );
  }
  const tmp = ACCESS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(access, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, ACCESS_FILE);
}

// `review` polls for this file rather than the child process, since every
// launcher (`start`, `osascript`) returns the instant the new window exists.
// Swallows its own error: this runs from a process.on("exit") handler, where
// a throw would replace the wizard's own last message with a stack trace,
// and review's 30-minute cap already covers "the marker never appeared".
function touchPickerDone(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(PICKER_DONE_FILE, String(Date.now()), { mode: 0o600 });
  } catch {}
}

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function requireArg(value: string | undefined, what: string): string {
  if (!value) die(`Missing ${what}.\n\n${USAGE}`);
  return value;
}

const USAGE = `Usage: bun scripts/access.ts <command>

  status                          show policy, allowlist, pending, groups
  pair <code>                     approve a pending pairing by its code
  deny <code>                     drop a pending pairing
  allow <jid>                     add a JID to the allowlist
  remove <jid>                    remove a JID from the allowlist
  forget <jid>                    purge a cached name/activity entry, even
                                   for a JID never allowlisted (see remove)
  policy <${POLICIES.join("|")}>   set the DM policy
  group add <groupJid> [--mention|--no-mention] [--allow a,b] [--roster|--no-roster] [--context|--no-context]
  group rm <groupJid>             stop responding in a group (files kept)
  review                          open the access screen in a NEW terminal
                                   window, wait for it, then print what
                                   changed. Takes no arguments.
  wizard [--include-archived]     the access screen itself: contacts and groups
                                   side by side, what Claude can reach today
                                   PRE-TICKED. Type to filter, space/enter to
                                   tick, Submit shows the +/- list before
                                   anything is written. Needs a real terminal.
  wizard --revoke                 accepted, same screen (revoking is unticking)
  wizard --undo                   put back the access.json from before the
                                   last wizard run (same as "undo")
  undo [--dry-run]                put back the access.json saved by the last
                                   --backup write (wizard --undo does the same)
  set <key> <value>               ${SET_KEYS.join(", ")}

JIDs look like 886912345678@s.whatsapp.net or 1203634244@g.us.
Any writing command takes --backup to save the current access.json to access.json.bak first.`;

function loadGroupsMeta(): Record<string, GroupMeta> {
  if (!existsSync(GROUPS_META_FILE)) return {};
  try {
    return JSON.parse(readFileSync(GROUPS_META_FILE, "utf8"));
  } catch {
    return {};
  }
}

function loadDmActivity(): Record<string, number> {
  if (!existsSync(DM_ACTIVITY_FILE)) return {};
  try {
    return JSON.parse(readFileSync(DM_ACTIVITY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveDmActivity(activity: Record<string, number>): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = DM_ACTIVITY_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(activity, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(tmp, DM_ACTIVITY_FILE);
}

function loadContacts(): ContactsMap {
  if (!existsSync(CONTACTS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONTACTS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveContacts(map: ContactsMap): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = CONTACTS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, CONTACTS_FILE);
}

// This script has no live WhatsApp connection (see the file header) and
// deliberately doesn't import Baileys just for its JID string utilities -
// mirrors server.ts's resolveToPhone/contactKey exactly (same
// resolve-then-normalize order), reading the same lid-map.json server.ts
// writes, so a key computed here always matches the one contacts.json is
// actually keyed under.
function loadLidMap(): Record<string, string> {
  if (!existsSync(LID_MAP_FILE)) return {};
  try {
    return JSON.parse(readFileSync(LID_MAP_FILE, "utf8"));
  } catch {
    return {};
  }
}

function status(): void {
  const a = load();
  const meta = loadGroupsMeta();
  const now = Date.now();
  // owner is printed with what it MEANS, not as a bare field: it is the one
  // chat that receives command previews and can approve them, and a wrong one
  // is otherwise invisible - the agent just waits on approvals nobody sees.
  const owner = typeof a.owner === "string" ? a.owner : "";
  const lines = [
    `state dir:  ${STATE_DIR}`,
    `dmPolicy:   ${a.dmPolicy}`,
    `owner:      ${owner || a.allowFrom[0] || "(none)"}${owner ? "" : "  (unstamped — falling back to allowFrom[0])"}`,
    `            permission requests go here; change with "set owner <jid>"`,
    `allowFrom:  ${a.allowFrom.length} contact(s)`,
    ...a.allowFrom.map((jid) => `  - ${jid}`),
  ];
  const pending = Object.entries(a.pending);
  lines.push(`pending:    ${pending.length}`);
  for (const [code, p] of pending) {
    const state = p.expiresAt < now ? "EXPIRED" : "waiting";
    lines.push(`  - ${code}  ${p.senderId}  (${state})`);
  }
  const groups = Object.entries(a.groups);
  lines.push(`groups:     ${groups.length}`);
  for (const [jid, g] of groups) {
    const name = meta[jid]?.name;
    lines.push(
      `  - ${name ? `${name}  ` : ""}${jid}  mention=${g.requireMention}  roster=${!!g.roster}${g.context === false ? "  context=false" : ""}`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
}

function pair(code: string): void {
  const a = load();
  const entry = a.pending[code];
  // Never approve without a code, even when only one is pending: an attacker
  // can seed a single pending entry just by messaging the account.
  if (!entry) {
    die(
      `No pending pairing with code "${code}".\nRun "status" to see the codes that are waiting.`,
    );
  }
  if (entry.expiresAt < Date.now()) {
    delete a.pending[code];
    save(a);
    die(`Pairing code "${code}" has expired. Ask them to message again.`);
  }
  if (!a.allowFrom.includes(entry.senderId)) a.allowFrom.push(entry.senderId);
  delete a.pending[code];

  // Lock the door again once nobody else is waiting, so an open pairing window
  // is never left behind by accident.
  const locked =
    a.dmPolicy === "pairing" && Object.keys(a.pending).length === 0;
  if (locked) a.dmPolicy = "allowlist";
  save(a);

  // The server polls this directory and sends them a confirmation.
  mkdirSync(APPROVED_DIR, { recursive: true });
  writeFileSync(join(APPROVED_DIR, entry.senderId), entry.chatId);

  process.stdout.write(
    `Approved ${entry.senderId}.\n` +
      (locked
        ? 'Policy locked back to "allowlist" — only approved contacts can reach you.\nTo add someone later: policy pairing, have them message you, then pair <code>.\n'
        : ""),
  );
}

// A starting point, not a wizard: the skill (or a human) asks the real
// questions and writes a tailored config.md. Here the files just have to
// exist and be editable. Shared by both `group add` and the wizard so a
// group provisioned either way ends up the same.
function provisionGroupFiles(jid: string): string {
  const dir = join(GROUPS_DIR, jid);
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.md");
  if (!existsSync(config)) {
    writeFileSync(
      config,
      `# Soul\n\n## Identity\nA helpful assistant in this group.\n\n## Communication Style\n- Match the group's language and tone\n- Concise and direct, 1-2 sentences when possible\n\n## Goals\n- Answer questions from the group\n\n## Boundaries\n- Never share private information between groups or DMs\n- Never modify access control from a channel message\n\n## Context\n(describe what this group is for)\n`,
    );
  }
  const memory = join(dir, "memory.md");
  if (!existsSync(memory)) writeFileSync(memory, "# Group Memory\n\n");
  return config;
}

function group(args: string[]): void {
  // Strict: an unknown flag, a missing --allow value, or a flag where the JID
  // should be is an error, not a group called "--mention".
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        mention: { type: "boolean" },
        "no-mention": { type: "boolean" },
        allow: { type: "string" },
        roster: { type: "boolean" },
        "no-roster": { type: "boolean" },
        context: { type: "boolean" },
        "no-context": { type: "boolean" },
        backup: { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    die(`${(err as Error).message}\n\n${USAGE}`);
  }
  const [sub, jidArg] = parsed.positionals;
  const {
    mention = false,
    "no-mention": noMention = false,
    allow,
    roster = false,
    "no-roster": noRoster = false,
    context: contextOn = false,
    "no-context": noContext = false,
    backup,
  } = parsed.values;
  const jid = requireArg(jidArg, "group JID");
  // parseArgs has no built-in negation, so --mention/--no-mention (and the
  // roster pair) are two separate flags - passing both at once is
  // ambiguous, never silently resolved one way.
  if (mention && noMention) die("Cannot pass both --mention and --no-mention.");
  if (roster && noRoster) die("Cannot pass both --roster and --no-roster.");
  if (contextOn && noContext)
    die("Cannot pass both --context and --no-context.");
  const a = load();
  if (sub === "rm") {
    if (!a.groups[jid]) {
      die(`Group ${jid} is not configured.`);
    }
    delete a.groups[jid];
    save(a, { backup });
    process.stdout.write(
      `Removed ${jid}. Its config.md and memory.md are kept in case you re-add it.\n`,
    );
    return;
  }
  if (sub !== "add") die(`Unknown group command "${sub}".\n\n${USAGE}`);

  // Merge into an existing entry, don't overwrite it: re-adding an
  // already-configured group to change just one thing (e.g. --roster)
  // used to silently reset every OTHER flag back to its default
  // (--mention lost, --allow cleared) since this always wrote a whole new
  // object. Now an omitted flag keeps whatever was already there; only a
  // flag actually passed changes anything. --allow "" (empty, but passed)
  // still explicitly clears the allowlist - omitting --allow entirely is
  // what preserves it. --no-mention/--no-roster are the explicit way to
  // turn a flag back off - without them there was no way to revoke roster
  // access short of `group rm` + a fresh `add` (losing allowFrom too).
  const existing = a.groups[jid];
  a.groups[jid] = {
    requireMention: mention
      ? true
      : noMention
        ? false
        : (existing?.requireMention ?? false),
    allowFrom:
      allow !== undefined
        ? allow
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : (existing?.allowFrom ?? []),
    roster: roster ? true : noRoster ? false : (existing?.roster ?? false),
  };
  // Unlike roster, absent means ON here (0.22.0 shipped context kept), so
  // the key is only materialised once someone has actually set it - a
  // policy that never mentioned context stays byte-identical.
  const contextVal = contextOn ? true : noContext ? false : existing?.context;
  if (contextVal !== undefined) a.groups[jid].context = contextVal;
  save(a, { backup });

  const config = provisionGroupFiles(jid);
  process.stdout.write(
    `${existing ? "Updated" : "Added"} ${jid} (mention required: ${a.groups[jid].requireMention}, roster: ${a.groups[jid].roster}, context kept: ${a.groups[jid].context !== false}).\nEdit its personality at ${config}\n`,
  );
}

const PRIVACY_DISCLOSURE =
  "No group or contact data was sent to any AI model during this setup — this ran entirely in your terminal.";

// The exact command, absolute-pathed the same way every other user-facing
// wizard mention is (see scripts/wizard-cmd.ts) - a marketplace install is not
// run from a repo checkout, so "bun scripts/access.ts" resolves to nothing
// there. Printed only after a write, and it is the same one-step undo the
// in-session `review` launcher points at (skills/access/SKILL.md, `undo`).
const WIZARD_CMD = wizardCmd(join(import.meta.dir, ".."));
const UNDO_HINT = `Changed your mind? Run \`${WIZARD_CMD} --undo --dry-run\` to see what would come back, then the same command without --dry-run.`;

const isEmpty = (d: AccessDiff): boolean =>
  !d.added.groups.length &&
  !d.added.dms.length &&
  !d.removed.groups.length &&
  !d.removed.dms.length;

const NOTHING_TO_REVIEW =
  "Nothing to review - no group or contact activity is cached yet and nothing is " +
  "configured. Pair the account and let it connect at least once first.";

// Bold amber, not red/green: a disclosure, not an error or a success state.
// Plain text when the terminal can't render color, or NO_COLOR is set.
function highlight(text: string): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  return `\x1b[1;38;5;208m${text}\x1b[0m`;
}

const CACHE_OFF_NOTE =
  'No contacts to review - no DM activity is on record yet. The server records it by default, so let it run and the record builds (never in static mode, and not if you set WHATSAPP_CACHE_CONTACTS=0 - see "Names and privacy" in ACCESS.md).';

const NO_DM_CANDIDATES_NOTE =
  "No contacts to review - nothing new in the cached DM activity: everyone who has messaged recently is already on the allowlist, or nobody has messaged yet.";

const NO_GROUPS_NOTE =
  "No groups on record yet - the server caches group names when it connects, so let it connect at least once.";

const NO_SAVED_NAMES_NOTE =
  "No saved contact names have arrived from WhatsApp yet either - the server asks for your address book once on connect, so they fill in by themselves.";

const NEEDS_TERMINAL =
  "The access screen needs a real terminal - stdin here is not one.\n" +
  "Run it directly in your own terminal window (not through a pipe, a script or an AI session), " +
  'or change one entry at a time with "allow", "remove", "group add" or "group rm".';

// One screen: a search line, a `Picked:` chip line, then CONTACTS left and
// GROUPS right, everything Claude can already reach pre-ticked. Untick to
// take access away, tick to grant, in the same pass. What Claude can already
// reach comes pre-ticked - so the screen shows current state, and unticking
// IS the revoke. Nothing is written until the whole +/- list is shown and
// answered.
//
// Terminal, not chat: this is what makes "no data went to an AI" literally
// true (no model runs during the decision), and it works for any client
// driving this plugin, not just Claude Code. Reads from groups-meta.json,
// dm-activity.json and contacts.json, none of which this script ever
// writes to on its own - only the connected server (server.ts) populates
// them, since only it holds the live WhatsApp connection.
async function wizard(args: string[]): Promise<void> {
  const includeArchived = args.includes("--include-archived");
  // `--revoke` is accepted and does nothing: one screen already grants and
  // revokes, so the old name only has to keep working (USAGE + skills still
  // name it).
  const disclose = () =>
    process.stdout.write(`\n${highlight(PRIVACY_DISCLOSURE)}\n`);

  for (;;) {
    // Model build, from disk every pass - identical data calls to before,
    // ranking arguments unchanged.
    const a = load();
    const lidMap = loadLidMap();
    const meta = loadGroupsMeta();
    const contacts = loadContacts();
    const configuredGroupJids = new Set(Object.keys(a.groups));
    const groupCandidates = rankGroups(
      meta,
      configuredGroupJids,
      includeArchived,
    );
    const configuredGroups = listConfiguredGroups(a.groups, meta);
    const dmCandidates = rankDms(
      loadDmActivity(),
      contacts,
      a.allowFrom,
      lidMap,
    );
    const configuredDms = listConfiguredDms(a.allowFrom, contacts, lidMap);
    const configuredDmJids = new Set(configuredDms.map((c) => c.jid));

    // Eligible-but-archived: the uncapped pool minus what is being shown,
    // so a configured group is never counted (rankGroups drops it either
    // way) and --include-archived makes this 0 by construction.
    const hiddenArchived =
      rankGroups(meta, configuredGroupJids, true).length -
      groupCandidates.length;

    // Order of these three exits is load-bearing (see access.test.ts): (1)
    // truly nothing to review, whether or not there is a terminal - the
    // cheaper truth; (2) the archived-hidden note, printed before the screen
    // so it survives a piped/redirected run; (3) only then the terminal
    // guard, since the screen itself needs raw mode.
    if (
      groupCandidates.length === 0 &&
      configuredGroups.length === 0 &&
      dmCandidates.length === 0 &&
      configuredDms.length === 0
    ) {
      die(NOTHING_TO_REVIEW);
    }

    if (hiddenArchived > 0) {
      process.stdout.write(
        `${hiddenArchived} archived group(s) are hidden - re-run with --include-archived to include them.\n`,
      );
    }

    if (!process.stdin.isTTY) die(NEEDS_TERMINAL);

    const dmsEmpty = dmCandidates.length === 0 && configuredDms.length === 0;
    const groupsEmpty =
      groupCandidates.length === 0 && configuredGroups.length === 0;

    const buildItem = (
      c: Candidate,
      kind: "group" | "dm",
      granted: boolean,
    ): PickerItem => ({
      jid: c.jid,
      label: formatLabel(c.label),
      kind,
      granted,
      roster: kind === "group" && granted ? !!a.groups[c.jid]?.roster : false,
    });
    // `hasSavedName` (T16) is what makes the empty-contacts message honest
    // when the address-book sync has not delivered yet - a cache full of
    // .notify-only entries is indistinguishable from a healthy one by size.
    const model: PickerModel = {
      dms: [
        // Named grants first; an allowed number nobody saved sinks to the
        // bottom (still shown - it must stay revocable).
        ...[...configuredDms]
          .sort(
            // Unnamed = the label is nothing but the masked number, or a
            // self-reported name that ends in it: every shape dmLabel makes.
            (x, y) =>
              Number(x.label.endsWith(x.description)) -
              Number(y.label.endsWith(y.description)),
          )
          .map((c) => buildItem(c, "dm", true)),
        ...dmCandidates.map((c) => buildItem(c, "dm", false)),
      ],
      groups: [
        ...configuredGroups.map((c) => buildItem(c, "group", true)),
        ...groupCandidates.map((c) => buildItem(c, "group", false)),
      ],
      dmNote: dmsEmpty
        ? (existsSync(DM_ACTIVITY_FILE)
            ? NO_DM_CANDIDATES_NOTE
            : CACHE_OFF_NOTE) +
          (hasSavedName(contacts) ? "" : " " + NO_SAVED_NAMES_NOTE)
        : "",
      groupNote: groupsEmpty ? NO_GROUPS_NOTE : "",
      hasBackup: existsSync(ACCESS_BAK_FILE),
      color: !!process.stdout.isTTY && !process.env.NO_COLOR,
    };

    const res = await runPicker(model);
    if (res === null) {
      // No disclosure line: nothing was decided.
      process.stdout.write("\nCancelled - nothing was changed.\n");
      return;
    }

    try {
      if (res.action === "restore") {
        if (
          await confirm({
            message: "Put back the access.json from before the last run?",
            default: false,
          })
        ) {
          undo([]); // existing function, existing semantics, prints its own +/- lines
        }
        continue; // rebuild the model from disk and redraw
      }

      const shown = { groups: configuredGroupJids, dms: configuredDmJids };
      const before = load();
      const proposed = applySelection(before, res, shown);
      const d = diffAccess(before, proposed);
      if (isEmpty(d)) {
        process.stdout.write(
          "\nNothing changed - your ticks match what was already set up.\n",
        );
        disclose();
        return;
      }

      // Same +/- lines `undo` and `review` print (deltaLines: formatLabel'd,
      // masked fallback) - this is the consent list the operator reads right
      // above "Apply these changes?", so it must never read differently.
      const lines = [
        ...deltaLines(d, before, proposed),
        "(+ = access this grants, - = access this takes away)",
      ];
      process.stdout.write(`\n${lines.join("\n")}\n`);

      if (
        !(await confirm({ message: "Apply these changes?", default: true }))
      ) {
        process.stdout.write("\nCancelled - nothing was changed.\n");
        disclose();
        return;
      }

      // Re-load AFTER the confirm, for the reason the old code re-loaded after
      // the checkboxes: every prompt blocks on the user for an unbounded time
      // and the server can write access.json in that window (a pairing
      // approval appended to allowFrom, a pending code created or pruned).
      // Writing back a pre-prompt snapshot would silently revert that.
      const fresh = load();
      const next = applySelection(fresh, res, shown);
      // What the owner just confirmed was computed against `before`. If the
      // server changed access.json while the screen was open (a pairing
      // approval, a removal from another terminal), the delta that would be
      // written is not the one on screen - refuse rather than guess.
      const dFresh = diffAccess(fresh, next);
      if (JSON.stringify(dFresh) !== JSON.stringify(d)) {
        process.stdout.write(
          "\nAccess changed while this screen was open - nothing was written. Run it again to see the current state.\n",
        );
        return;
      }
      for (const jid of d.added.groups) provisionGroupFiles(jid);
      // Read before save() overwrites it: whether this run actually took a
      // .bak, so a first-ever run doesn't point UNDO_HINT at a command that
      // only answers "no previous access file - nothing to undo".
      const tookBackup = existsSync(ACCESS_FILE);
      // backup: true on the one and only write of the run, so a single
      // `undo` reverses the whole run.
      save(next, { backup: true });

      process.stdout.write(
        `\nApplied: ${d.added.groups.length} group(s) and ${d.added.dms.length} contact(s) granted, ` +
          `${d.removed.groups.length} group(s) and ${d.removed.dms.length} contact(s) revoked.\n`,
      );
      if (d.removed.groups.length > 0) {
        process.stdout.write(
          "Revoked groups keep their config.md and memory.md, in case you add them back.\n",
        );
      }
      // Owner decision (artifact Q2): revoking DM access here keeps the
      // cached name - nothing that forgets it is called. `forget <jid>`
      // stays the deliberate way to clear one.
      if (d.removed.dms.length > 0) {
        process.stdout.write(
          'Revoked contacts keep their cached name - "forget <jid>" clears one.\n',
        );
      }
      if (tookBackup) process.stdout.write(`${UNDO_HINT}\n`);
      disclose();
      return;
    } catch (err) {
      // @inquirer/prompts throws this on Ctrl-C/Ctrl-D from `confirm` - still
      // used here for "Apply these changes?" and the Restore prompt. Every
      // confirm() in this function runs before save(), so there is still
      // nothing to roll back - just a clean message instead of a raw stack
      // trace. `runPicker` returning null is the picker's own cancel path
      // and never reaches this catch.
      if (err instanceof Error && err.name === "ExitPromptError") {
        process.stdout.write("\nCancelled - nothing was changed.\n");
        return;
      }
      throw err;
    }
  }
}

const PICKER_OPENING =
  "Opening the access screen in a new terminal window. Pick there; I only see what changed.";

const PICKER_NO_CHANGE =
  "Nothing changed - the access screen was closed without applying anything.\n" +
  `If the window closed by itself, run ${WIZARD_CMD} in your own terminal to see why.`;

const PICKER_STILL_OPEN =
  "The access screen is still open after 30 minutes - nothing has been reported back. " +
  "Finish in that window, then run review again.";

// D2. WIZARD_CMD is the resolved absolute command - a marketplace install is
// not a repo checkout.
const PICKER_NO_LAUNCHER =
  "Could not open a terminal window from here.\n" +
  `Run this in your own terminal, then come back:\n  ${WIZARD_CMD}\n` +
  "Nothing was changed.";

const PICKER_ONLY_DELTA =
  "Only this list came back to the session - the picking happened in the other window.";

type Launch = { cmd: string; args: string[] };

// No `which` binary is guaranteed; PATH + existsSync is stdlib and
// synchronous.
function firstOnPath(names: readonly string[]): string | null {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of names) {
    if (dirs.some((d) => existsSync(join(d, name)))) return name;
  }
  return null;
}

function pickerLaunch(): Launch | null {
  const accessPath = join(import.meta.dir, "access.ts");
  // What every launcher ends up running. "bun", not process.execPath: it
  // matches wizardCmd()'s printed command, and anything running this plugin
  // already has bun on PATH.
  // ponytail: if a report ever shows bun missing from PATH in the new
  // window, process.execPath is the upgrade path.
  const argv = ["bun", accessPath, "wizard"];

  // Test hook, not a user-facing knob: names the launcher command. A .ts/.js
  // value is run with this same bun, so a fixture script can stand in for a
  // terminal without any shell-style splitting (this repo's own install
  // path contains a space).
  const override = process.env.WHATSAPP_PICKER_LAUNCH?.trim();
  if (override) {
    return /\.(ts|js|mjs)$/.test(override)
      ? { cmd: process.execPath, args: [override, ...argv] }
      : { cmd: override, args: argv };
  }

  if (process.platform === "win32") {
    // The empty title argument is load-bearing: `start` reads the FIRST
    // quoted token as the window title, and an install path with a space
    // arrives quoted.
    return { cmd: "cmd", args: ["/c", "start", "", ...argv] };
  }
  if (process.platform === "darwin") {
    // WIZARD_CMD is already `bun "<abs>" wizard` with the path quoted;
    // JSON.stringify then escapes " and \ exactly the way an AppleScript
    // string literal does.
    return {
      cmd: "osascript",
      args: [
        "-e",
        `tell application "Terminal" to do script ${JSON.stringify(WIZARD_CMD)}`,
      ],
    };
  }
  const term = firstOnPath(["x-terminal-emulator", "gnome-terminal", "xterm"]);
  if (!term) return null;
  return {
    cmd: term,
    args: [term === "gnome-terminal" ? "--" : "-e", ...argv],
  };
}

// Opens the access screen in a NEW terminal window, waits for it, and
// reports back only the +/- delta by name - the model never sees a
// candidate list (brief, "Security surface"). Takes no arguments: nothing
// that could come from a WhatsApp message reaches the launched command line.
async function review(args: string[]): Promise<void> {
  if (args.length) die(`review takes no arguments.\n\n${USAGE}`);

  // Before anything is launched, so a marker left by an earlier run can
  // never short-circuit this one.
  rmSync(PICKER_DONE_FILE, { force: true });

  const before = load();
  const launch = pickerLaunch();
  if (!launch) {
    process.stdout.write(PICKER_NO_LAUNCHER + "\n");
    process.exit(2);
  }

  process.stdout.write(PICKER_OPENING + "\n");
  // spawnSync, not async spawn: stdlib, matches the house style
  // (execFileSync elsewhere), needs no detached/unref bookkeeping, and
  // every default launcher returns immediately (start, osascript) or blocks
  // until the terminal closes (Linux) - correct either way, since the
  // marker is already there by then. stdio: "inherit" so the launcher's own
  // error text (and, in tests, the fake launcher's argv echo) reaches the
  // caller. No hand-built env: WHATSAPP_STATE_DIR must reach the child via
  // the default inherited env, or a custom state dir (and the tests) point
  // the child at ~/.whatsapp-channel instead.
  const res = spawnSync(launch.cmd, launch.args, { stdio: "inherit" });
  if (res.error || res.status !== 0) {
    process.stdout.write(PICKER_NO_LAUNCHER + "\n");
    process.exit(2);
  }

  const POLL_MS = 250;
  const PICKER_WAIT_MS = 30 * 60_000;
  let waited = 0;
  while (!existsSync(PICKER_DONE_FILE)) {
    if (waited >= PICKER_WAIT_MS) die(PICKER_STILL_OPEN);
    await new Promise((r) => setTimeout(r, POLL_MS));
    waited += POLL_MS;
  }
  rmSync(PICKER_DONE_FILE, { force: true });

  const after = load();
  const d = diffAccess(before, after);
  if (isEmpty(d)) {
    process.stdout.write(PICKER_NO_CHANGE + "\n");
    return;
  }

  const lines = [
    ...deltaLines(d, before, after),
    "(+ = access this grants, - = access this takes away)",
    PICKER_ONLY_DELTA,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

// One step back (#14). Restores access.json from the .bak that a `--backup`
// write left behind, and leaves the state it replaced in the .bak - so `undo`
// is its own inverse (a second one is a redo) without any multi-level history.
// Restores access.json and NOTHING else: contacts.json / dm-activity.json
// entries a `remove` purged are gone, and this says so rather than implying a
// full rewind.
// The +/- lines for a diff between two access.json snapshots, labelled from
// the MERGED snapshots so an entry present in only one of them still
// resolves to a name, and masked (groupAnchor / maskNumber) when nothing is
// cached for it. Shared by `undo` and `review` so the two can never disagree
// about how an entry reads. Legend line left to the caller - `undo` and
// `review` word it differently.
function deltaLines(d: AccessDiff, a: Access, b: Access): string[] {
  const mergedGroups = { ...b.groups, ...a.groups };
  const mergedMeta = loadGroupsMeta();
  const groupLabels = new Map(
    listConfiguredGroups(mergedGroups, mergedMeta).map((c) => [c.jid, c]),
  );
  const mergedAllowFrom = [
    ...new Set([...(b.allowFrom ?? []), ...(a.allowFrom ?? [])]),
  ];
  const dmLabels = new Map(
    listConfiguredDms(mergedAllowFrom, loadContacts(), loadLidMap()).map(
      (c) => [c.jid, c],
    ),
  );
  // One line builder for both kinds: a candidate map plus its masked
  // fallback (groupAnchor for a group, maskNumber for a DM) when the JID
  // has no entry in either merged snapshot's candidate list. formatLabel,
  // not the raw label: a self-reported group/contact name is
  // attacker-chosen, and this line is read by a terminal AND, via `review`,
  // a model (review finding 3).
  const line = (
    jid: string,
    labels: Map<string, Candidate>,
    fallback: (jid: string) => string,
  ): string => {
    const c = labels.get(jid);
    const label = c ? formatLabel(c.label) : fallback(jid);
    const description = c?.description ?? fallback(jid);
    return `${label}  [${description}]`;
  };
  return (
    [
      ["+", d.added.groups, groupLabels, groupAnchor],
      ["+", d.added.dms, dmLabels, maskNumber],
      ["-", d.removed.groups, groupLabels, groupAnchor],
      ["-", d.removed.dms, dmLabels, maskNumber],
    ] as const
  ).flatMap(([sign, jids, labels, fallback]) =>
    jids.map((jid) => `${sign} ${line(jid, labels, fallback)}`),
  );
}

function undo(args: string[]): void {
  // Strict: a typo'd flag on the one destructive subcommand must not run it.
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: { "dry-run": { type: "boolean" } },
      allowPositionals: false,
    }));
  } catch (err) {
    die(`${(err as Error).message}\n\n${USAGE}`);
  }
  const dryRun = values["dry-run"] === true;
  if (!existsSync(ACCESS_BAK_FILE)) {
    process.stdout.write("No previous access file - nothing to undo\n");
    return;
  }
  // access.json itself can be missing here - the exact state load()'s own
  // "Fix or delete it, then retry" advice leaves a corrupt file in, which is
  // also the moment undo is most useful. Treat it as an empty snapshot rather
  // than crash: the diff still renders (everything in .bak looks "added")
  // and the restore still works.
  const currentBytes = existsSync(ACCESS_FILE)
    ? readFileSync(ACCESS_FILE)
    : Buffer.from(JSON.stringify(EMPTY_ACCESS, null, 2) + "\n");
  const bakBytes = readFileSync(ACCESS_BAK_FILE);
  let current: Access;
  let bak: Access;
  try {
    current = JSON.parse(currentBytes.toString("utf8"));
  } catch {
    die(`${ACCESS_FILE} is not valid JSON. Fix or delete it, then retry.`);
  }
  try {
    bak = JSON.parse(bakBytes.toString("utf8"));
  } catch {
    die(
      "access.json.bak is not valid JSON. Delete it to clear the undo point.",
    );
  }
  const d = diffAccess(current, bak);
  if (isEmpty(d)) {
    process.stdout.write(
      "The previous access.json is identical to the current one - undo would change nothing.\n",
    );
    return;
  }
  const lines = [
    ...deltaLines(d, current, bak),
    "(+ = access this brings back, - = access this takes away)",
  ];

  if (dryRun) {
    process.stdout.write(
      `Undo would restore the previous access.json:\n${lines.join("\n")}\n`,
    );
    return;
  }

  writeFileSync(ACCESS_FILE + ".tmp", bakBytes, { mode: 0o600 });
  renameSync(ACCESS_FILE + ".tmp", ACCESS_FILE);
  writeFileSync(ACCESS_BAK_FILE + ".tmp", currentBytes, { mode: 0o600 });
  renameSync(ACCESS_BAK_FILE + ".tmp", ACCESS_BAK_FILE);
  process.stdout.write(
    `Restored the previous access.json.\n${lines.join("\n")}\n` +
      "Cached names and recency are not restored. access.json.bak now holds the state from before this undo, so running undo again puts it back.\n",
  );
}

// Shared by `remove` (which also drops the allowlist entry) and `forget`
// (which purges the cache alone, for someone never allowlisted in the
// first place). Never touches lid-map.json - see forgetContact's own
// comment for why. If they're still in a shared group with roster access,
// they'll show up there as a masked number from now on - not a bug, the
// honest consequence of choosing to forget someone this plugin was never
// going to remove from a group or block on WhatsApp.
function forgetCachedIdentity(jid: string): boolean {
  const key = contactKeyFor(loadLidMap(), jid);
  const contacts = loadContacts();
  const forgot = forgetContact(contacts, key);
  if (forgot) saveContacts(contacts);
  const activity = loadDmActivity();
  const forgotActivity = key in activity;
  if (forgotActivity) {
    delete activity[key];
    saveDmActivity(activity);
  }
  return forgot || forgotActivity;
}

// What revoking ONE allowlist entry should do to that contact's cached
// name and recency. Shared by `remove` and the wizard's revoke screen so
// the rule cannot drift between them - it has two edges that are easy to
// get wrong separately:
//
//  - One person can sit in allowFrom TWICE, under both their @lid and their
//    phone form, and both resolve to the same cache key. Revoking one form
//    while the other still grants access must keep the cache, or the
//    surviving grant goes on working while the contact silently degrades to
//    a bare masked number everywhere.
//  - Claiming to have forgotten (or kept) a cached name that never existed
//    is a false statement to the user either way, so "nothing" is a distinct
//    answer from both.
//
// `remaining` is allowFrom AFTER the entry has been taken out.
type CacheOutcome = "forgot" | "kept" | "nothing";
const CACHE_NOTE: Record<CacheOutcome, string> = {
  forgot: " Forgot their cached name too.",
  kept: " Kept their cached name - another allowlist entry still resolves to the same contact.",
  nothing: "",
};
function revokeCachedIdentity(
  remaining: readonly string[],
  jid: string,
): CacheOutcome {
  const lidMap = loadLidMap();
  const key = contactKeyFor(lidMap, jid);
  const stillAllowed = remaining.some((j) => contactKeyFor(lidMap, j) === key);
  if (!stillAllowed) return forgetCachedIdentity(jid) ? "forgot" : "nothing";
  const cached = key in loadContacts() || key in loadDmActivity();
  return cached ? "kept" : "nothing";
}

function set(key: string, rawValue: string): void {
  if (!SET_KEYS.includes(key)) {
    die(`Unknown key "${key}". Supported: ${SET_KEYS.join(", ")}`);
  }
  const a = load();
  let value: unknown = rawValue;
  if (key === "textChunkLimit") {
    const n = Number(rawValue);
    if (!Number.isFinite(n) || n <= 0) die("textChunkLimit must be a number.");
    value = n;
  } else if (key === "mentionPatterns") {
    try {
      value = JSON.parse(rawValue);
    } catch {
      die('mentionPatterns must be a JSON array, e.g. \'["claude","bot"]\'');
    }
    if (!Array.isArray(value)) die("mentionPatterns must be a JSON array.");
  } else if (
    key === "replyToMode" &&
    !["off", "first", "all"].includes(rawValue)
  ) {
    die("replyToMode must be off, first or all.");
  } else if (key === "chunkMode" && !["length", "newline"].includes(rawValue)) {
    die("chunkMode must be length or newline.");
  } else if (key === "owner" && !rawValue.includes("@")) {
    // A jid, not a bare number: this is the send target for every permission
    // request, and a value WhatsApp cannot address silently sends approvals
    // nowhere at all.
    die(
      "owner must be a JID, e.g. 886912345678@s.whatsapp.net.\nRun status to see the current one.",
    );
  }
  a[key] = value;
  save(a);
  process.stdout.write(`${key} = ${JSON.stringify(value)}\n`);
}

const [command = "status", ...rest] = process.argv.slice(2);
switch (command) {
  case "status":
    status();
    break;
  case "pair":
    pair(requireArg(rest[0], "pairing code"));
    break;
  case "deny": {
    const code = requireArg(rest[0], "pairing code");
    const a = load();
    if (!a.pending[code]) die(`No pending pairing with code "${code}".`);
    delete a.pending[code];
    save(a);
    process.stdout.write(`Denied ${code}.\n`);
    break;
  }
  case "allow": {
    let values, positionals;
    try {
      ({ values, positionals } = parseArgs({
        args: rest,
        options: { backup: { type: "boolean" } },
        allowPositionals: true,
      }));
    } catch (err) {
      die(`${(err as Error).message}\n\n${USAGE}`);
    }
    const jid = requireArg(positionals[0], "JID");
    const a = load();
    if (a.allowFrom.includes(jid)) {
      process.stdout.write(`${jid} was already allowed.\n`);
      break;
    }
    a.allowFrom.push(jid);
    save(a, { backup: values.backup });
    process.stdout.write(`Allowed ${jid}.\n`);
    break;
  }
  case "remove": {
    let values, positionals;
    try {
      ({ values, positionals } = parseArgs({
        args: rest,
        options: { backup: { type: "boolean" } },
        allowPositionals: true,
      }));
    } catch (err) {
      die(`${(err as Error).message}\n\n${USAGE}`);
    }
    const jid = requireArg(positionals[0], "JID");
    const a = load();
    if (!a.allowFrom.includes(jid)) {
      die(`${jid} is not on the allowlist.`);
    }
    a.allowFrom = a.allowFrom.filter((j) => j !== jid);
    save(a, { backup: values.backup });
    const outcome = revokeCachedIdentity(a.allowFrom, jid);
    process.stdout.write(`Removed ${jid}.` + CACHE_NOTE[outcome] + "\n");
    break;
  }
  case "forget": {
    // A stranger's name/activity gets cached the moment they DM once -
    // contacts.upsert/chats.upsert fire from Baileys before any allowlist
    // check runs (see server.ts) - so someone who was NEVER allowlisted has
    // no access.json entry for `remove` to find, and `remove` refuses to
    // run at all for them (see the allowFrom check above). This purges the
    // cache directly with no allowlist requirement, so a stranger's cached
    // name/activity can always be cleared even though they were never
    // granted (or denied) anything to remove.
    const jid = requireArg(rest[0], "JID");
    const forgot = forgetCachedIdentity(jid);
    if (!forgot) die(`Nothing cached for ${jid}.`);
    process.stdout.write(`Forgot ${jid}'s cached name and activity.\n`);
    break;
  }
  case "policy": {
    const mode = requireArg(rest[0], "policy");
    if (!POLICIES.includes(mode)) {
      die(`Policy must be one of: ${POLICIES.join(", ")}`);
    }
    const a = load();
    a.dmPolicy = mode;
    save(a);
    process.stdout.write(`dmPolicy = ${mode}\n`);
    break;
  }
  case "group":
    group(rest);
    break;
  case "wizard": {
    // `review` waits on this file, not on the child process: `cmd /c start`
    // and `osascript` both return the instant the new window exists. 'exit'
    // fires for a normal return, for an uncaught throw, for every die()
    // (process.exit), and for runPicker's SIGINT/SIGTERM handler
    // (picker.ts:1056-1059, which calls process.exit(1) and therefore skips
    // the try/finally) - so every way this screen can end writes the marker
    // exactly once. Registered for `wizard --help`/`--undo` too - harmless,
    // since `review` never launches those and the marker is removed before
    // every launch.
    process.on("exit", touchPickerDone);
    // --help first: it must never open a prompt, whatever else was passed.
    // --undo before everything else for the same reason it was added in T14 -
    // it is exactly `undo`, and must not open a screen for someone who asked
    // to undo. `--revoke` is now an ALIAS: the one screen already does both,
    // so it needs no branch of its own, only a name that keeps working.
    if (rest.includes("--help")) process.stdout.write(USAGE + "\n");
    else if (rest.includes("--undo")) undo(rest.filter((f) => f !== "--undo"));
    else await wizard(rest);
    break;
  }
  case "review":
    await review(rest);
    break;
  case "undo":
    undo(rest);
    break;
  case "set":
    set(requireArg(rest[0], "key"), requireArg(rest[1], "value"));
    break;
  case "--help":
  case "-h":
  case "help":
    process.stdout.write(USAGE + "\n");
    break;
  default:
    die(`Unknown command "${command}".\n\n${USAGE}`);
}
