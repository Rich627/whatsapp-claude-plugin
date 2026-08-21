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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";

const STATE_DIR =
  process.env.WHATSAPP_STATE_DIR ?? join(homedir(), ".whatsapp-channel");
const ACCESS_FILE = join(STATE_DIR, "access.json");
const APPROVED_DIR = join(STATE_DIR, "approved");
const GROUPS_DIR = join(STATE_DIR, "groups");
const GROUPS_META_FILE = join(STATE_DIR, "groups-meta.json");

const POLICIES = ["pairing", "allowlist", "disabled"];
const SET_KEYS = [
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
};
type GroupMeta = {
  name: string;
  memberCount: number;
  archived: boolean;
  updatedAt: number;
};
type PendingEntry = { senderId: string; chatId: string; expiresAt: number };
type Access = {
  dmPolicy: string;
  allowFrom: string[];
  groups: Record<string, GroupPolicy>;
  pending: Record<string, PendingEntry>;
  [key: string]: unknown;
};

function load(): Access {
  const empty: Access = {
    dmPolicy: "pairing",
    allowFrom: [],
    groups: {},
    pending: {},
  };
  if (!existsSync(ACCESS_FILE)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, "utf8")) as
      Partial<Access> | undefined;
    return {
      ...empty,
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
function save(access: Access): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = ACCESS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(access, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, ACCESS_FILE);
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
  policy <${POLICIES.join("|")}>   set the DM policy
  group add <groupJid> [--mention] [--allow a,b] [--roster]
  group rm <groupJid>             stop responding in a group (files kept)
  wizard [--include-archived]     guided group setup: can-act / can-see-roster,
                                   per group, from names cached by list_groups
  set <key> <value>               ${SET_KEYS.join(", ")}

JIDs look like 886912345678@s.whatsapp.net or 1203634244@g.us.`;

function loadGroupsMeta(): Record<string, GroupMeta> {
  if (!existsSync(GROUPS_META_FILE)) return {};
  try {
    return JSON.parse(readFileSync(GROUPS_META_FILE, "utf8"));
  } catch {
    return {};
  }
}

function status(): void {
  const a = load();
  const meta = loadGroupsMeta();
  const now = Date.now();
  const lines = [
    `state dir:  ${STATE_DIR}`,
    `dmPolicy:   ${a.dmPolicy}`,
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
      `  - ${name ? `${name}  ` : ""}${jid}  mention=${g.requireMention}  roster=${!!g.roster}`,
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
        allow: { type: "string" },
        roster: { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    die(`${(err as Error).message}\n\n${USAGE}`);
  }
  const [sub, jidArg] = parsed.positionals;
  const jid = requireArg(jidArg, "group JID");
  const { mention = false, allow, roster = false } = parsed.values;
  const a = load();
  if (sub === "rm") {
    if (!a.groups[jid]) die(`Group ${jid} is not configured.`);
    delete a.groups[jid];
    save(a);
    process.stdout.write(
      `Removed ${jid}. Its config.md and memory.md are kept in case you re-add it.\n`,
    );
    return;
  }
  if (sub !== "add") die(`Unknown group command "${sub}".\n\n${USAGE}`);

  a.groups[jid] = {
    requireMention: mention,
    allowFrom: allow?.split(",").map((s) => s.trim()) ?? [],
    roster,
  };
  save(a);

  const config = provisionGroupFiles(jid);
  process.stdout.write(
    `Added ${jid} (mention required: ${a.groups[jid].requireMention}, roster: ${a.groups[jid].roster}).\nEdit its personality at ${config}\n`,
  );
}

const PRIVACY_DISCLOSURE =
  "No group or contact data was sent to any AI model during this setup — this ran entirely in your terminal.";

// Bold amber, not red/green: a disclosure, not an error or a success state.
// Plain text when the terminal can't render color, or NO_COLOR is set.
function highlight(text: string): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  return `\x1b[1;38;5;208m${text}\x1b[0m`;
}

// Guided setup for groups the account has joined but never decided about.
// Terminal, not chat: this is what makes "no data went to an AI" literally
// true (no model runs during the decision), and it works for any client
// driving this plugin, not just Claude Code - see HANDOFF.md for why this
// was the deliberate choice over a conversational flow.
//
// Reads names from groups-meta.json, which THIS script never writes - only
// the connected server (server.ts, via the list_groups tool) can see real
// group names, since only it holds the live WhatsApp connection.
async function wizard(args: string[]): Promise<void> {
  const includeArchived = args.includes("--include-archived");
  const meta = loadGroupsMeta();
  if (Object.keys(meta).length === 0) {
    die(
      "No group data cached yet. Call the list_groups tool from a connected session first (it warms this cache), then re-run the wizard.",
    );
  }
  const a = load();
  const candidates = Object.entries(meta)
    .filter(([jid]) => !(jid in a.groups))
    .filter(([, g]) => includeArchived || !g.archived)
    .sort(([, x], [, y]) => x.name.localeCompare(y.name));

  if (candidates.length === 0) {
    process.stdout.write(
      "Every known group is already configured, or archived and skipped by default.\n" +
        "Use 'group add'/'group rm' to change an existing group, or pass --include-archived.\n",
    );
    return;
  }

  process.stdout.write(
    `${candidates.length} group(s) to review. Answer y/n; anything else skips a group for now.\n`,
  );
  // Not rl.question() (readline/promises): repeated calls on it hang on
  // piped/non-TTY stdin under Bun (confirmed - the second call never
  // resolves even with more input waiting to be read). The async iterator
  // form doesn't have that problem and works the same interactively.
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  async function ask(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    const { value, done } = await lines.next();
    return done ? "" : value;
  }
  let configured = 0;
  try {
    for (const [jid, g] of candidates) {
      process.stdout.write(`\n${g.name}  (${g.memberCount} member(s))\n  ${jid}\n`);
      const canAct = (await ask("  Can Claude reply here? [y/N] "))
        .trim()
        .toLowerCase();
      if (canAct !== "y" && canAct !== "yes") {
        process.stdout.write("  Skipped.\n");
        continue;
      }
      const wantsRoster = (
        await ask("  Also let Claude see member names, for @all mentions? [y/N] ")
      )
        .trim()
        .toLowerCase();
      // requireMention defaults to true here (unlike `group add`'s CLI
      // default of false): a group reached through the guided consent flow
      // gets the more cautious default of only responding when addressed,
      // not to every message. Change it later with `group add --mention`.
      a.groups[jid] = {
        requireMention: true,
        allowFrom: [],
        roster: wantsRoster === "y" || wantsRoster === "yes",
      };
      provisionGroupFiles(jid);
      // Saved after EVERY group, not once at the end: this loop can run for
      // a while (a real answer per group), and a mid-session Ctrl-C used to
      // silently discard every already-"Added" answer since nothing had
      // been written yet. One extra disk write per group is cheap next to
      // losing the owner's answers.
      save(a);
      configured++;
      process.stdout.write(`  Added (roster: ${a.groups[jid].roster}).\n`);
    }
  } finally {
    rl.close();
  }

  process.stdout.write(
    configured > 0
      ? `\n${configured} group(s) configured.\n`
      : "\nNo groups configured.\n",
  );
  process.stdout.write(`\n${highlight(PRIVACY_DISCLOSURE)}\n`);
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
    const jid = requireArg(rest[0], "JID");
    const a = load();
    if (a.allowFrom.includes(jid)) {
      process.stdout.write(`${jid} was already allowed.\n`);
      break;
    }
    a.allowFrom.push(jid);
    save(a);
    process.stdout.write(`Allowed ${jid}.\n`);
    break;
  }
  case "remove": {
    const jid = requireArg(rest[0], "JID");
    const a = load();
    if (!a.allowFrom.includes(jid)) die(`${jid} is not on the allowlist.`);
    a.allowFrom = a.allowFrom.filter((j) => j !== jid);
    save(a);
    process.stdout.write(`Removed ${jid}.\n`);
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
  case "wizard":
    await wizard(rest);
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
