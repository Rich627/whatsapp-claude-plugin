import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "access.ts");

function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), "wa-access-"));
}

/** Returns stdout+stderr and the exit code, since failures are part of the contract. */
function run(dir: string, ...args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync("bun", [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, WHATSAPP_STATE_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 };
  }
}

/** Like run(), but feeds `stdin` to the process - for the wizard's prompts. */
function runWithInput(
  dir: string,
  stdin: string,
  ...args: string[]
): { out: string; code: number } {
  try {
    const out = execFileSync("bun", [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, WHATSAPP_STATE_DIR: dir },
      input: stdin,
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 };
  }
}

function writeContacts(
  dir: string,
  contacts: Record<string, { name?: string; notify?: string }>,
): void {
  writeFileSync(join(dir, "contacts.json"), JSON.stringify(contacts, null, 2));
}

function readContacts(
  dir: string,
): Record<string, { name?: string; notify?: string }> {
  return JSON.parse(readFileSync(join(dir, "contacts.json"), "utf8"));
}

function writeLidMap(dir: string, map: Record<string, string>): void {
  writeFileSync(join(dir, "lid-map.json"), JSON.stringify(map, null, 2));
}

function writeGroupsMeta(
  dir: string,
  meta: Record<
    string,
    {
      name: string;
      memberCount: number;
      archived: boolean;
      lastActivityAt?: number;
      updatedAt: number;
    }
  >,
): void {
  writeFileSync(join(dir, "groups-meta.json"), JSON.stringify(meta, null, 2));
}

function writeDmActivity(dir: string, activity: Record<string, number>): void {
  writeFileSync(
    join(dir, "dm-activity.json"),
    JSON.stringify(activity, null, 2),
  );
}

const access = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "access.json"), "utf8"));

function seedPending(dir: string, code: string, expiresAt: number): void {
  const current = existsSync(join(dir, "access.json"))
    ? access(dir)
    : { dmPolicy: "pairing", allowFrom: [], groups: {}, pending: {} };
  current.pending[code] = {
    senderId: "999@s.whatsapp.net",
    chatId: "999@s.whatsapp.net",
    createdAt: 0,
    expiresAt,
  };
  writeFileSync(join(dir, "access.json"), JSON.stringify(current, null, 2));
}

describe("allowlist", () => {
  test("allow adds, is idempotent, and remove takes it back out", () => {
    const dir = freshStateDir();
    expect(run(dir, "allow", "1@s.whatsapp.net").code).toBe(0);
    expect(run(dir, "allow", "1@s.whatsapp.net").out).toContain(
      "already allowed",
    );
    expect(access(dir).allowFrom).toEqual(["1@s.whatsapp.net"]);
    run(dir, "remove", "1@s.whatsapp.net");
    expect(access(dir).allowFrom).toEqual([]);
  });

  test("removing someone who is not listed fails loudly", () => {
    const dir = freshStateDir();
    expect(run(dir, "remove", "nobody@s.whatsapp.net").code).toBe(1);
  });

  test("removing a contact also forgets their cached name, not just the allowlist entry", () => {
    const dir = freshStateDir();
    run(dir, "allow", "1@s.whatsapp.net");
    writeContacts(dir, { "1@s.whatsapp.net": { name: "Akash" } });
    const res = run(dir, "remove", "1@s.whatsapp.net");
    expect(res.code).toBe(0);
    expect(res.out).toContain("Forgot their cached name too.");
    expect(readContacts(dir)["1@s.whatsapp.net"]).toBeUndefined();
  });

  test("removing a contact with no cached name still succeeds, no false claim of forgetting", () => {
    const dir = freshStateDir();
    run(dir, "allow", "1@s.whatsapp.net");
    const res = run(dir, "remove", "1@s.whatsapp.net");
    expect(res.code).toBe(0);
    expect(res.out).not.toContain("Forgot");
  });

  test("removing via a LID resolves through lid-map.json to forget the right contacts.json key", () => {
    const dir = freshStateDir();
    run(dir, "allow", "184710990000999@lid");
    writeLidMap(dir, { "184710990000999@lid": "61403911675@s.whatsapp.net" });
    writeContacts(dir, { "61403911675@s.whatsapp.net": { name: "Rohan" } });
    const res = run(dir, "remove", "184710990000999@lid");
    expect(res.code).toBe(0);
    expect(res.out).toContain("Forgot their cached name too.");
    expect(readContacts(dir)["61403911675@s.whatsapp.net"]).toBeUndefined();
  });

  test("removal never touches lid-map.json itself", () => {
    const dir = freshStateDir();
    run(dir, "allow", "184710990000999@lid");
    writeLidMap(dir, { "184710990000999@lid": "61403911675@s.whatsapp.net" });
    writeContacts(dir, { "61403911675@s.whatsapp.net": { name: "Rohan" } });
    run(dir, "remove", "184710990000999@lid");
    const lidMap = JSON.parse(readFileSync(join(dir, "lid-map.json"), "utf8"));
    expect(lidMap["184710990000999@lid"]).toBe("61403911675@s.whatsapp.net");
  });

  test("removing a contact also purges their entry in the wizard's recency cache", () => {
    const dir = freshStateDir();
    run(dir, "allow", "1@s.whatsapp.net");
    writeDmActivity(dir, {
      "1@s.whatsapp.net": 5000,
      "2@s.whatsapp.net": 3000,
    });
    const res = run(dir, "remove", "1@s.whatsapp.net");
    expect(res.code).toBe(0);
    expect(res.out).toContain("Forgot their cached name too.");
    const activity = JSON.parse(
      readFileSync(join(dir, "dm-activity.json"), "utf8"),
    );
    expect(activity["1@s.whatsapp.net"]).toBeUndefined();
    // Only the removed contact's own entry goes - everyone else's stays.
    expect(activity["2@s.whatsapp.net"]).toBe(3000);
  });

  test("removing a contact with no recency entry cached still succeeds cleanly", () => {
    const dir = freshStateDir();
    run(dir, "allow", "1@s.whatsapp.net");
    const res = run(dir, "remove", "1@s.whatsapp.net");
    expect(res.code).toBe(0);
    expect(res.out).not.toContain("Forgot");
  });
});

describe("forget", () => {
  test("purges a cached name for a JID that was NEVER allowlisted - remove refuses this, forget doesn't", () => {
    const dir = freshStateDir();
    writeContacts(dir, { "1@s.whatsapp.net": { name: "Akash" } });
    expect(run(dir, "remove", "1@s.whatsapp.net").code).toBe(1);
    const res = run(dir, "forget", "1@s.whatsapp.net");
    expect(res.code).toBe(0);
    expect(readContacts(dir)["1@s.whatsapp.net"]).toBeUndefined();
  });

  test("purges the recency cache entry too", () => {
    const dir = freshStateDir();
    writeDmActivity(dir, {
      "1@s.whatsapp.net": 5000,
      "2@s.whatsapp.net": 3000,
    });
    const res = run(dir, "forget", "1@s.whatsapp.net");
    expect(res.code).toBe(0);
    const activity = JSON.parse(
      readFileSync(join(dir, "dm-activity.json"), "utf8"),
    );
    expect(activity["1@s.whatsapp.net"]).toBeUndefined();
    expect(activity["2@s.whatsapp.net"]).toBe(3000);
  });

  test("resolves through lid-map.json, same as remove", () => {
    const dir = freshStateDir();
    writeLidMap(dir, { "184710990000999@lid": "61403911675@s.whatsapp.net" });
    writeContacts(dir, { "61403911675@s.whatsapp.net": { name: "Rohan" } });
    const res = run(dir, "forget", "184710990000999@lid");
    expect(res.code).toBe(0);
    expect(readContacts(dir)["61403911675@s.whatsapp.net"]).toBeUndefined();
  });

  test("nothing cached for the JID fails loudly, not a silent no-op", () => {
    const dir = freshStateDir();
    expect(run(dir, "forget", "nobody@s.whatsapp.net").code).toBe(1);
  });

  test("never touches access.json, even for a JID that happens to be allowlisted", () => {
    const dir = freshStateDir();
    run(dir, "allow", "1@s.whatsapp.net");
    writeContacts(dir, { "1@s.whatsapp.net": { name: "Akash" } });
    const res = run(dir, "forget", "1@s.whatsapp.net");
    expect(res.code).toBe(0);
    expect(access(dir).allowFrom).toEqual(["1@s.whatsapp.net"]);
  });
});

describe("policy", () => {
  test("a valid mode is written; an invalid one is refused", () => {
    const dir = freshStateDir();
    run(dir, "policy", "disabled");
    expect(access(dir).dmPolicy).toBe("disabled");
    const bad = run(dir, "policy", "wide-open");
    expect(bad.code).toBe(1);
    expect(access(dir).dmPolicy).toBe("disabled"); // unchanged
  });
});

describe("pairing", () => {
  test("a wrong code approves nobody", () => {
    const dir = freshStateDir();
    seedPending(dir, "abcde", Date.now() + 60_000);
    const res = run(dir, "pair", "zzzzz");
    expect(res.code).toBe(1);
    expect(access(dir).allowFrom).toEqual([]);
    expect(access(dir).pending.abcde).toBeDefined();
  });

  test("an expired code approves nobody and is dropped", () => {
    const dir = freshStateDir();
    seedPending(dir, "abcde", Date.now() - 1);
    expect(run(dir, "pair", "abcde").code).toBe(1);
    expect(access(dir).allowFrom).toEqual([]);
    expect(access(dir).pending.abcde).toBeUndefined();
  });

  test("a valid code allows the sender, locks the policy, and signals the server", () => {
    const dir = freshStateDir();
    seedPending(dir, "abcde", Date.now() + 60_000);
    expect(run(dir, "pair", "abcde").code).toBe(0);
    const a = access(dir);
    expect(a.allowFrom).toEqual(["999@s.whatsapp.net"]);
    expect(a.pending).toEqual({});
    expect(a.dmPolicy).toBe("allowlist");
    // The server polls approved/<senderId> to send the "you're in" message.
    expect(
      readFileSync(join(dir, "approved", "999@s.whatsapp.net"), "utf8"),
    ).toBe("999@s.whatsapp.net");
  });

  test("the policy stays open while another pairing is still waiting", () => {
    const dir = freshStateDir();
    seedPending(dir, "aaaaa", Date.now() + 60_000);
    seedPending(dir, "bbbbb", Date.now() + 60_000);
    run(dir, "pair", "aaaaa");
    expect(access(dir).dmPolicy).toBe("pairing");
  });
});

describe("groups", () => {
  test("add writes the policy and seeds editable files; rm keeps them", () => {
    const dir = freshStateDir();
    run(dir, "group", "add", "1@g.us", "--mention", "--allow", "x@s,y@s");
    expect(access(dir).groups["1@g.us"]).toEqual({
      requireMention: true,
      allowFrom: ["x@s", "y@s"],
      roster: false,
    });
    const config = join(dir, "groups", "1@g.us", "config.md");
    expect(existsSync(config)).toBe(true);
    expect(existsSync(join(dir, "groups", "1@g.us", "memory.md"))).toBe(true);
    writeFileSync(config, "# edited by hand\n");
    run(dir, "group", "rm", "1@g.us");
    expect(access(dir).groups["1@g.us"]).toBeUndefined();
    expect(readFileSync(config, "utf8")).toBe("# edited by hand\n");
  });

  test("re-adding a group does not clobber an edited config", () => {
    const dir = freshStateDir();
    run(dir, "group", "add", "1@g.us");
    const config = join(dir, "groups", "1@g.us", "config.md");
    writeFileSync(config, "# mine\n");
    run(dir, "group", "add", "1@g.us");
    expect(readFileSync(config, "utf8")).toBe("# mine\n");
  });

  test("flags may precede the JID; unknown or valueless flags are refused", () => {
    const dir = freshStateDir();
    run(dir, "group", "add", "--mention", "1@g.us");
    expect(access(dir).groups["1@g.us"].requireMention).toBe(true);
    expect(existsSync(join(dir, "groups", "--mention"))).toBe(false);
    expect(run(dir, "group", "add", "2@g.us", "--bogus").code).toBe(1);
    expect(run(dir, "group", "add", "2@g.us", "--allow").code).toBe(1);
    expect(access(dir).groups["2@g.us"]).toBeUndefined();
  });

  test("--roster grants roster access; omitting it defaults to false", () => {
    const dir = freshStateDir();
    run(dir, "group", "add", "1@g.us", "--roster");
    expect(access(dir).groups["1@g.us"].roster).toBe(true);
    run(dir, "group", "add", "2@g.us");
    expect(access(dir).groups["2@g.us"].roster).toBe(false);
  });

  test("--no-roster explicitly revokes roster on an already-granted group", () => {
    const dir = freshStateDir();
    run(dir, "group", "add", "1@g.us", "--roster");
    const res = run(dir, "group", "add", "1@g.us", "--no-roster");
    expect(res.code).toBe(0);
    expect(access(dir).groups["1@g.us"].roster).toBe(false);
  });

  test("--no-mention explicitly turns off requireMention on an already-set group", () => {
    const dir = freshStateDir();
    run(dir, "group", "add", "1@g.us", "--mention");
    run(dir, "group", "add", "1@g.us", "--no-mention");
    expect(access(dir).groups["1@g.us"].requireMention).toBe(false);
  });

  test("passing both --roster and --no-roster together is refused, never silently resolved", () => {
    const dir = freshStateDir();
    const res = run(dir, "group", "add", "1@g.us", "--roster", "--no-roster");
    expect(res.code).toBe(1);
    // Refused before load()/save() ever ran - nothing written at all.
    expect(existsSync(join(dir, "access.json"))).toBe(false);
  });

  test("passing both --mention and --no-mention together is refused", () => {
    const dir = freshStateDir();
    const res = run(dir, "group", "add", "1@g.us", "--mention", "--no-mention");
    expect(res.code).toBe(1);
  });

  test("re-adding an already-configured group MERGES, not overwrites: omitted flags are kept", () => {
    const dir = freshStateDir();
    run(dir, "group", "add", "1@g.us", "--mention", "--allow", "x@s,y@s");
    // Only --roster passed this time - --mention and --allow are omitted,
    // not explicitly turned off, so they must survive untouched.
    const res = run(dir, "group", "add", "1@g.us", "--roster");
    expect(res.code).toBe(0);
    expect(res.out).toContain("Updated 1@g.us");
    expect(access(dir).groups["1@g.us"]).toEqual({
      requireMention: true,
      allowFrom: ["x@s", "y@s"],
      roster: true,
    });
  });

  test('a genuinely new group still reports "Added", not "Updated"', () => {
    const dir = freshStateDir();
    const res = run(dir, "group", "add", "1@g.us");
    expect(res.out).toContain("Added 1@g.us");
  });

  test('--allow "" (passed, empty) explicitly clears the allowlist on re-add', () => {
    const dir = freshStateDir();
    run(dir, "group", "add", "1@g.us", "--allow", "x@s,y@s");
    run(dir, "group", "add", "1@g.us", "--allow", "");
    expect(access(dir).groups["1@g.us"].allowFrom).toEqual([]);
  });

  test("passing --mention or --roster again on an already-true flag is a harmless no-op", () => {
    const dir = freshStateDir();
    run(dir, "group", "add", "1@g.us", "--mention", "--roster");
    run(dir, "group", "add", "1@g.us", "--mention", "--roster");
    expect(access(dir).groups["1@g.us"]).toEqual({
      requireMention: true,
      allowFrom: [],
      roster: true,
    });
  });
});

// The wizard's checkbox prompts are driven by @inquirer/prompts, which
// takes raw keystrokes: " " (space) toggles the highlighted item, "\n"
// submits, "\x03" is Ctrl-C. A chain of MULTIPLE checkbox() calls in one
// process is unreliable over piped/non-TTY stdin - a known Inquirer/Node
// issue (stream ownership gets lost between prompts when piping; it works
// fine interactively, which is the only place this glue actually runs -
// see SBoudrias/Inquirer.js#767 and #414). So every test here is
// constructed to trigger AT MOST ONE checkbox() call: either there's only
// one category of candidate (groups xor DMs), or the group selection is
// left empty (which skips the second, roster, checkbox entirely - see
// wizard()'s own `if (actGroups.length > 0)` guard). Ordering, filtering
// and masking logic itself is covered exhaustively and reliably in
// ranking.test.ts instead, since none of that needs a live prompt.
describe("wizard", () => {
  test("no group or DM activity cached at all: refuses with a clear message", () => {
    const dir = freshStateDir();
    const res = run(dir, "wizard");
    expect(res.code).toBe(1);
    expect(res.out).toContain("Nothing to review");
  });

  test("archived groups skipped by default; already-configured groups skipped too: nothing left", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": {
        name: "Active",
        memberCount: 3,
        archived: false,
        updatedAt: 0,
      },
      "2@g.us": {
        name: "Archived",
        memberCount: 2,
        archived: true,
        updatedAt: 0,
      },
    });
    run(dir, "group", "add", "1@g.us"); // already configured
    const res = run(dir, "wizard");
    expect(res.code).toBe(1);
    expect(res.out).toContain("Nothing to review");
    expect(access(dir).groups["2@g.us"]).toBeUndefined();
  });

  test("groups only, select none: nothing configured, access.json never created", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": {
        name: "Family",
        memberCount: 4,
        archived: false,
        updatedAt: 0,
      },
    });
    const res = runWithInput(dir, "\n", "wizard"); // enter immediately, 0 selected
    expect(res.code).toBe(0);
    expect(res.out).toContain("0 group(s), 0 contact(s) configured.");
    expect(existsSync(join(dir, "access.json"))).toBe(false);
  });

  test("--include-archived surfaces an archived group as a candidate", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": {
        name: "Old Chat",
        memberCount: 2,
        archived: true,
        updatedAt: 0,
      },
    });
    // Without the flag there'd be nothing to review at all (see the test
    // above this one) - with it, the group is offered, even though this
    // run selects none of it.
    const res = runWithInput(dir, "\n", "wizard", "--include-archived");
    expect(res.code).toBe(0);
    expect(res.out).toContain("Old Chat");
    // Nothing was selected, so nothing was written at all.
    expect(existsSync(join(dir, "access.json"))).toBe(false);
  });

  test("DMs only, select none: nothing configured, access.json never created", () => {
    const dir = freshStateDir();
    writeDmActivity(dir, { "1@s.whatsapp.net": 1000 });
    const res = runWithInput(dir, "\n", "wizard");
    expect(res.code).toBe(0);
    expect(res.out).toContain("0 group(s), 0 contact(s) configured.");
    expect(existsSync(join(dir, "access.json"))).toBe(false);
  });

  test("DMs only, select the one candidate: added to the allowlist", () => {
    const dir = freshStateDir();
    writeDmActivity(dir, { "61403911675@s.whatsapp.net": 1000 });
    writeContacts(dir, { "61403911675@s.whatsapp.net": { name: "Rohan" } });
    const res = runWithInput(dir, " \n", "wizard"); // space selects, enter submits
    expect(res.code).toBe(0);
    expect(res.out).toContain("0 group(s), 1 contact(s) configured.");
    expect(access(dir).allowFrom).toEqual(["61403911675@s.whatsapp.net"]);
  });

  test("DM candidate label shows the saved name, never the raw number", () => {
    const dir = freshStateDir();
    writeDmActivity(dir, { "61403911675@s.whatsapp.net": 1000 });
    writeContacts(dir, { "61403911675@s.whatsapp.net": { name: "Rohan" } });
    const res = runWithInput(dir, "\n", "wizard");
    expect(res.out).toContain("Rohan");
    expect(res.out).not.toContain("61403911675");
  });

  test("Ctrl-C cancels cleanly: nothing written, no raw stack trace", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": {
        name: "Family",
        memberCount: 4,
        archived: false,
        updatedAt: 0,
      },
    });
    const res = runWithInput(dir, "\x03", "wizard");
    expect(res.code).toBe(0);
    expect(res.out).toContain("Cancelled - nothing was changed.");
    expect(res.out).not.toContain("ExitPromptError");
    expect(existsSync(join(dir, "access.json"))).toBe(false);
  });

  test("the closing privacy line is always printed, in plain text (not the amber highlight) when not a TTY", () => {
    const dir = freshStateDir();
    writeDmActivity(dir, { "1@s.whatsapp.net": 1000 });
    const res = runWithInput(dir, "\n", "wizard");
    expect(res.out).toContain(
      "No group or contact data was sent to any AI model during this setup",
    );
    // execFileSync's pipes are never a TTY, so highlight() must not wrap
    // the disclosure line in the bold-amber escape - inquirer's OWN prompt
    // rendering does use ANSI regardless of TTY, so this checks the specific
    // color code highlight() would add, not "no ANSI anywhere in the output".
    expect(res.out).not.toContain("\x1b[1;38;5;208m");
  });
});

describe("set", () => {
  test("typed values are coerced and bad ones refused", () => {
    const dir = freshStateDir();
    run(dir, "set", "textChunkLimit", "900");
    expect(access(dir).textChunkLimit).toBe(900);
    run(dir, "set", "mentionPatterns", '["claude"]');
    expect(access(dir).mentionPatterns).toEqual(["claude"]);
    expect(run(dir, "set", "textChunkLimit", "lots").code).toBe(1);
    expect(run(dir, "set", "replyToMode", "sometimes").code).toBe(1);
    expect(run(dir, "set", "nonsenseKey", "1").code).toBe(1);
  });
});

describe("robustness", () => {
  test("a corrupt access.json is reported, not silently replaced", () => {
    const dir = freshStateDir();
    writeFileSync(join(dir, "access.json"), "][");
    const res = run(dir, "status");
    expect(res.code).toBe(1);
    expect(res.out).toContain("not valid JSON");
    expect(readFileSync(join(dir, "access.json"), "utf8")).toBe("][");
  });

  test("status works before the server has ever run", () => {
    const dir = freshStateDir();
    const res = run(dir, "status");
    expect(res.code).toBe(0);
    expect(res.out).toContain("dmPolicy:   pairing");
  });
});
