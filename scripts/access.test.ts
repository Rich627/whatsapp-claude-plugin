import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refFor } from "./ranking";

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
      members?: string[];
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

  // One contact can be allowlisted twice, under its @lid form AND its phone
  // form, and both resolve to the same contacts.json / dm-activity.json key.
  // Revoking one form must not wipe the cache the surviving grant still
  // relies on (PR #24 review, #3).
  test("revoking one form of a doubly-allowlisted contact keeps the shared cache", () => {
    const dir = freshStateDir();
    writeLidMap(dir, { "184710990000999@lid": "61403911675@s.whatsapp.net" });
    writeContacts(dir, { "61403911675@s.whatsapp.net": { name: "Akash" } });
    writeDmActivity(dir, { "61403911675@s.whatsapp.net": 1000 });
    run(dir, "allow", "184710990000999@lid");
    run(dir, "allow", "61403911675@s.whatsapp.net");

    const { out } = run(dir, "remove", "184710990000999@lid");
    expect(out).toContain("Kept their cached name");
    expect(out).not.toContain("Forgot their cached name");
    // The surviving grant still works, so the name behind it must survive too.
    expect(readContacts(dir)["61403911675@s.whatsapp.net"]).toEqual({
      name: "Akash",
    });
    expect(access(dir).allowFrom).toEqual(["61403911675@s.whatsapp.net"]);
  });

  test("nothing cached: the surviving grant is kept quietly, no invented name claim", () => {
    // Allowlisted by JID, never DMed - so there is no cached name to keep,
    // and saying one was kept is as wrong as saying one was forgotten.
    const dir = freshStateDir();
    writeLidMap(dir, { "184710990000999@lid": "61403911675@s.whatsapp.net" });
    run(dir, "allow", "184710990000999@lid");
    run(dir, "allow", "61403911675@s.whatsapp.net");

    const { out } = run(dir, "remove", "184710990000999@lid");
    expect(out).toContain("Removed 184710990000999@lid.");
    expect(out).not.toContain("cached name");
  });

  test("revoking the LAST form of that contact does forget them", () => {
    const dir = freshStateDir();
    writeLidMap(dir, { "184710990000999@lid": "61403911675@s.whatsapp.net" });
    writeContacts(dir, { "61403911675@s.whatsapp.net": { name: "Akash" } });
    run(dir, "allow", "184710990000999@lid");
    run(dir, "allow", "61403911675@s.whatsapp.net");
    run(dir, "remove", "184710990000999@lid");

    const { out } = run(dir, "remove", "61403911675@s.whatsapp.net");
    expect(out).toContain("Forgot their cached name");
    expect(readContacts(dir)["61403911675@s.whatsapp.net"]).toBeUndefined();
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

// The one-screen picker (scripts/picker.ts) is a raw-mode TUI, so it cannot
// be driven from a piped stdin the way the old checkbox prompts could - the
// tests below assert the CLI-level guard (a non-TTY stdin refuses, cleanly)
// and the output printed BEFORE the screen would open (the archived-hidden
// disclosure, the USAGE text). The screen's own keystroke/layout behaviour
// is covered in picker.test.ts instead.
describe("wizard", () => {
  test("no group or DM activity cached at all: refuses with a clear message", () => {
    const dir = freshStateDir();
    const res = run(dir, "wizard");
    expect(res.code).toBe(1);
    expect(res.out).toContain("Nothing to review");
  });

  test("wizard --help prints USAGE and opens no prompt", () => {
    const dir = freshStateDir();
    // Empty stdin: a prompt here would hang/fail the test, which is the point.
    const res = run(dir, "wizard", "--help");
    expect(res.code).toBe(0);
    expect(res.out).toContain("PRE-TICKED");
    expect(res.out).toContain("--revoke");
    expect(res.out).toContain("--undo");
  });

  test("wizard needs a real terminal: a non-TTY stdin exits 1, writes nothing", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": {
        name: "Family",
        memberCount: 4,
        archived: false,
        updatedAt: 0,
      },
    });
    const res = run(dir, "wizard");
    expect(res.code).toBe(1);
    expect(res.out.toLowerCase()).toContain("needs a real terminal");
    expect(res.out).not.toContain("ExitPromptError");
    expect(existsSync(join(dir, "access.json"))).toBe(false);
  });

  test("--revoke opens the same screen as plain wizard", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": {
        name: "Family",
        memberCount: 4,
        archived: false,
        updatedAt: 0,
      },
    });
    run(dir, "group", "add", "1@g.us");
    const plain = run(dir, "wizard");
    const revoke = run(dir, "wizard", "--revoke");
    expect(revoke.code).toBe(plain.code);
    expect(revoke.out).toBe(plain.out);
  });

  test("an already-configured group is offered instead of leaving nothing to review", () => {
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
    expect(res.out.toLowerCase()).toContain("needs a real terminal");
    expect(res.out).not.toContain("Nothing to review");
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
    // Without the flag there'd be nothing to review at all - with it, the
    // group enters the pool and the run gets as far as the terminal guard
    // instead of dying earlier with "Nothing to review".
    const plain = run(dir, "wizard");
    expect(plain.code).toBe(1);
    expect(plain.out).toContain("Nothing to review");
    const withFlag = run(dir, "wizard", "--include-archived");
    expect(withFlag.code).toBe(1);
    expect(withFlag.out.toLowerCase()).toContain("needs a real terminal");
  });

  // The disclosure lines below are written before the terminal guard fires,
  // so a plain non-TTY run() is enough to observe them.
  test("archived groups hidden are disclosed with the --include-archived hint", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": {
        name: "Active",
        memberCount: 2,
        archived: false,
        updatedAt: 0,
      },
      "2@g.us": {
        name: "Old",
        memberCount: 2,
        archived: true,
        updatedAt: 0,
      },
      "3@g.us": {
        name: "Older",
        memberCount: 2,
        archived: true,
        updatedAt: 0,
      },
    });
    const res = run(dir, "wizard");
    expect(res.out).toContain("2 archived group(s) are hidden");
    expect(res.out).toContain("--include-archived");
    const withFlag = run(dir, "wizard", "--include-archived");
    expect(withFlag.out).not.toContain("are hidden");
  });

  test("an archived group that is already configured does not count toward hiddenArchived", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": {
        name: "Active",
        memberCount: 2,
        archived: false,
        updatedAt: 0,
      },
      "2@g.us": {
        name: "Old",
        memberCount: 2,
        archived: true,
        updatedAt: 0,
      },
      "3@g.us": {
        name: "AlreadyConfigured",
        memberCount: 2,
        archived: true,
        updatedAt: 0,
      },
    });
    run(dir, "group", "add", "3@g.us");
    const res = run(dir, "wizard");
    expect(res.out).toContain("1 archived group(s) are hidden");
    expect(res.out).not.toContain("2 archived group(s) are hidden");
  });
});

// Issue #1: until this existed the wizard could only ever GRANT, so an
// existing user pointed at it by the update notice found no way to take
// access back short of editing access.json by hand. `--revoke` is now an
// alias for the same one-screen picker (see the "wizard" describe block
// above) - the rest of what this used to cover (select-none, select-one,
// the doubly-allowlisted cache-keep rule, the disclosure line) now lives in
// picker.test.ts's reducer/e2e tests and applySelection's unit tests; the
// cache-keep rule itself stays covered for `remove` at line 260 above, and
// config.md surviving a revoke is covered by the `group rm` test at line 407.
describe("wizard --revoke", () => {
  test("nothing configured: refuses with a clear message, writes nothing", () => {
    const dir = freshStateDir();
    const res = run(dir, "wizard", "--revoke");
    expect(res.code).toBe(1);
    expect(res.out).toContain("Nothing to review");
    expect(existsSync(join(dir, "access.json"))).toBe(false);
  });
});

// #12/#14: the in-session review's opening screen (state) and the ref
// handshake (--ref) that lets a model act on a candidate without ever
// seeing a raw JID.
describe("state (JSON for the in-session review's opening screen)", () => {
  test("prints the four { items, total } blocks, no jid key, no raw number", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "120363424405607157@g.us": {
        name: "Team",
        memberCount: 4,
        archived: false,
        updatedAt: 0,
      },
    });
    writeDmActivity(dir, { "61403911675@s.whatsapp.net": 100 });
    run(dir, "allow", "61432609386@s.whatsapp.net");
    const { out, code } = run(dir, "state");
    expect(code).toBe(0);
    expect(out).not.toContain('"jid"');
    expect(out).not.toContain("61403911675");
    expect(out).not.toContain("61432609386");
    const parsed = JSON.parse(out);
    expect(parsed.groups.candidates.total).toBe(1);
    expect(parsed.groups.configured.total).toBe(0);
    expect(parsed.dms.candidates.total).toBe(1);
    expect(parsed.dms.configured.total).toBe(1);
    expect(parsed.groups.candidates.items[0]).toEqual({
      ref: refFor("120363424405607157@g.us"),
      label: "Team  (4 member(s))",
      description: "120363424405607157@g.us",
    });
  });
});

describe("state flag parsing", () => {
  test("an unknown flag exits 1, same strictness as candidates", () => {
    const dir = freshStateDir();
    expect(run(dir, "state", "--bogus").code).toBe(1);
  });
});

describe("candidates --search", () => {
  test("returns only label/description matches, still ranked", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "a@g.us": {
        name: "Family",
        memberCount: 3,
        archived: false,
        updatedAt: 0,
      },
      "b@g.us": { name: "Work", memberCount: 2, archived: false, updatedAt: 0 },
    });
    const parsed = JSON.parse(run(dir, "candidates", "--search", "family").out);
    expect(parsed.groups.items).toHaveLength(1);
    expect(parsed.groups.items[0].label).toBe("Family  (3 member(s))");
    expect(parsed.groups.total).toBe(1);
  });

  test("is case-insensitive", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "a@g.us": {
        name: "Family",
        memberCount: 3,
        archived: false,
        updatedAt: 0,
      },
    });
    const parsed = JSON.parse(run(dir, "candidates", "--search", "FAMILY").out);
    expect(parsed.groups.items).toHaveLength(1);
    expect(parsed.groups.items[0].label).toBe("Family  (3 member(s))");
  });

  test("a term matching nothing returns empty items, total 0, exit 0", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "a@g.us": {
        name: "Family",
        memberCount: 3,
        archived: false,
        updatedAt: 0,
      },
    });
    const { out, code } = run(dir, "candidates", "--search", "nonexistent");
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.groups.items).toEqual([]);
    expect(parsed.groups.total).toBe(0);
  });

  test("--search composes with --include-archived", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "a@g.us": {
        name: "Family",
        memberCount: 3,
        archived: true,
        updatedAt: 0,
      },
    });
    expect(
      JSON.parse(run(dir, "candidates", "--search", "family").out).groups.total,
    ).toBe(0);
    expect(
      JSON.parse(
        run(dir, "candidates", "--search", "family", "--include-archived").out,
      ).groups.total,
    ).toBe(1);
  });

  test("an unknown flag still exits 1", () => {
    const dir = freshStateDir();
    expect(run(dir, "candidates", "--bogus").code).toBe(1);
  });
});

describe("configured --search", () => {
  test("filters the configured pool the same way candidates --search does", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "a@g.us": {
        name: "Family",
        memberCount: 3,
        archived: false,
        updatedAt: 0,
      },
      "b@g.us": { name: "Work", memberCount: 2, archived: false, updatedAt: 0 },
    });
    run(dir, "group", "add", "a@g.us");
    run(dir, "group", "add", "b@g.us");
    const parsed = JSON.parse(run(dir, "configured", "--search", "family").out);
    expect(parsed.groups.items).toHaveLength(1);
    expect(parsed.groups.items[0].label).toBe("Family  (3 member(s))");
    expect(parsed.groups.total).toBe(1);
  });

  test("a term matching nothing returns empty items, total 0, exit 0", () => {
    const dir = freshStateDir();
    run(dir, "allow", "1@s.whatsapp.net");
    const { out, code } = run(dir, "configured", "--search", "nonexistent");
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.dms.items).toEqual([]);
    expect(parsed.dms.total).toBe(0);
  });

  test("an unknown flag still exits 1", () => {
    const dir = freshStateDir();
    expect(run(dir, "configured", "--bogus").code).toBe(1);
  });
});

describe("--ref resolution", () => {
  test("a ref taken from state resolves back to the right JID via allow --ref", () => {
    const dir = freshStateDir();
    writeDmActivity(dir, { "61403911675@s.whatsapp.net": 100 });
    const parsed = JSON.parse(run(dir, "state").out);
    const ref = parsed.dms.candidates.items[0].ref;
    expect(run(dir, "allow", "--ref", ref).code).toBe(0);
    expect(access(dir).allowFrom).toEqual(["61403911675@s.whatsapp.net"]);
  });

  test("the same ref is stable across a second state run", () => {
    const dir = freshStateDir();
    writeDmActivity(dir, { "61403911675@s.whatsapp.net": 100 });
    const first = JSON.parse(run(dir, "state").out).dms.candidates.items[0].ref;
    const second = JSON.parse(run(dir, "state").out).dms.candidates.items[0]
      .ref;
    expect(second).toBe(first);
  });

  test("remove --ref on a contact allowlisted under their @lid form removes that exact string, not the phone form", () => {
    const dir = freshStateDir();
    writeLidMap(dir, { "184710990000999@lid": "61403911675@s.whatsapp.net" });
    run(dir, "allow", "184710990000999@lid");
    run(dir, "allow", "61403911675@s.whatsapp.net");
    const items = JSON.parse(run(dir, "configured").out).dms.items;
    const lidItem = items.find(
      (c: { ref: string }) => c.ref === refFor("184710990000999@lid"),
    );
    expect(run(dir, "remove", "--ref", lidItem.ref).code).toBe(0);
    expect(access(dir).allowFrom).toEqual(["61403911675@s.whatsapp.net"]);
  });

  test("group add --ref and group rm --ref act on the right group", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "a@g.us": { name: "Team", memberCount: 2, archived: false, updatedAt: 0 },
    });
    const ref = JSON.parse(run(dir, "state").out).groups.candidates.items[0]
      .ref;
    expect(run(dir, "group", "add", "--ref", ref).code).toBe(0);
    expect(access(dir).groups["a@g.us"]).toBeDefined();
    expect(run(dir, "group", "rm", "--ref", ref).code).toBe(0);
    expect(access(dir).groups["a@g.us"]).toBeUndefined();
  });

  test("allow --ref on a group ref exits 1 and writes nothing", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "a@g.us": { name: "Team", memberCount: 2, archived: false, updatedAt: 0 },
    });
    const ref = JSON.parse(run(dir, "state").out).groups.candidates.items[0]
      .ref;
    const res = run(dir, "allow", "--ref", ref);
    expect(res.code).toBe(1);
    expect(res.out).toContain("is a group, not a contact");
    expect(existsSync(join(dir, "access.json"))).toBe(false);
  });

  test("remove --ref on an unknown ref exits 1", () => {
    const dir = freshStateDir();
    expect(run(dir, "remove", "--ref", "deadbeef0000").code).toBe(1);
  });

  test("a ref matching more than one allowlisted entry dies as ambiguous and writes nothing", () => {
    // Two distinct allowFrom strings that normalizeJid collapses to the same
    // JID (bare vs. device-suffixed) hash to the SAME ref, since refFor
    // normalizes internally - the one realistic way two different pool
    // entries can share a ref without forging a hash collision.
    const dir = freshStateDir();
    run(dir, "allow", "61403911675@s.whatsapp.net");
    run(dir, "allow", "61403911675:5@s.whatsapp.net");
    const ref = refFor("61403911675@s.whatsapp.net");
    const before = access(dir);
    const res = run(dir, "remove", "--ref", ref);
    expect(res.code).toBe(1);
    expect(res.out).toContain("ambiguous");
    expect(access(dir)).toEqual(before);
  });

  test("passing both a positional JID and --ref exits 1", () => {
    const dir = freshStateDir();
    writeDmActivity(dir, { "61403911675@s.whatsapp.net": 100 });
    const ref = JSON.parse(run(dir, "state").out).dms.candidates.items[0].ref;
    expect(run(dir, "allow", "1@s.whatsapp.net", "--ref", ref).code).toBe(1);
  });
});

// A ref exists so a raw JID never has to reach the model - the confirmation
// line of the command it drives must hold to that too, not just the JSON.
describe("--ref confirmations never print a raw number", () => {
  test("allow --ref prints the masked form, not the raw JID", () => {
    const dir = freshStateDir();
    writeDmActivity(dir, { "61403911675@s.whatsapp.net": 100 });
    const ref = JSON.parse(run(dir, "state").out).dms.candidates.items[0].ref;
    const res = run(dir, "allow", "--ref", ref);
    expect(res.code).toBe(0);
    expect(res.out).not.toContain("@s.whatsapp.net");
    expect(res.out).not.toContain("61403911675");
  });

  test("remove --ref prints the masked form, not the raw JID", () => {
    const dir = freshStateDir();
    run(dir, "allow", "61403911675@s.whatsapp.net");
    const ref = JSON.parse(run(dir, "configured").out).dms.items[0].ref;
    const res = run(dir, "remove", "--ref", ref);
    expect(res.code).toBe(0);
    expect(res.out).not.toContain("@s.whatsapp.net");
    expect(res.out).not.toContain("61403911675");
  });

  test("a positional JID (typed by a human) still prints unmasked, as before", () => {
    const dir = freshStateDir();
    const res = run(dir, "allow", "61403911675@s.whatsapp.net");
    expect(res.out).toContain("Allowed 61403911675@s.whatsapp.net.");
  });

  test("group add --ref / group rm --ref print the group JID (not personal for a modern group), never a raw contact number", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "a@g.us": { name: "Team", memberCount: 2, archived: false, updatedAt: 0 },
    });
    const ref = JSON.parse(run(dir, "state").out).groups.candidates.items[0]
      .ref;
    const added = run(dir, "group", "add", "--ref", ref);
    expect(added.code).toBe(0);
    const removed = run(dir, "group", "rm", "--ref", ref);
    expect(removed.code).toBe(0);
    expect(added.out).not.toContain("@s.whatsapp.net");
    expect(removed.out).not.toContain("@s.whatsapp.net");
  });
});

describe("--backup", () => {
  test("allow <jid> --backup creates access.json.bak holding the pre-write content", () => {
    const dir = freshStateDir();
    run(dir, "allow", "1@s.whatsapp.net");
    const before = readFileSync(join(dir, "access.json"), "utf8");
    run(dir, "allow", "2@s.whatsapp.net", "--backup");
    expect(readFileSync(join(dir, "access.json.bak"), "utf8")).toBe(before);
  });

  test("without --backup no .bak file exists", () => {
    const dir = freshStateDir();
    run(dir, "allow", "1@s.whatsapp.net");
    expect(existsSync(join(dir, "access.json.bak"))).toBe(false);
  });

  test("a second --backup overwrites it (documented behaviour)", () => {
    const dir = freshStateDir();
    run(dir, "allow", "1@s.whatsapp.net");
    run(dir, "allow", "2@s.whatsapp.net", "--backup");
    const afterFirstBackup = readFileSync(join(dir, "access.json"), "utf8");
    run(dir, "allow", "3@s.whatsapp.net", "--backup");
    expect(readFileSync(join(dir, "access.json.bak"), "utf8")).toBe(
      afterFirstBackup,
    );
  });
});

describe("undo", () => {
  test("no .bak: prints the nothing-to-undo line, exit 0, access.json byte-identical", () => {
    const dir = freshStateDir();
    run(dir, "allow", "1@s.whatsapp.net");
    const before = readFileSync(join(dir, "access.json"), "utf8");
    const res = run(dir, "undo", "--dry-run");
    expect(res.code).toBe(0);
    expect(res.out).toContain("No previous access file - nothing to undo");
    expect(readFileSync(join(dir, "access.json"), "utf8")).toBe(before);
  });

  test("a misspelled --dry-run flag is refused instead of performing a real undo", () => {
    const dir = freshStateDir();
    run(dir, "allow", "1@s.whatsapp.net");
    run(dir, "allow", "--backup", "2@s.whatsapp.net");
    const before = readFileSync(join(dir, "access.json"), "utf8");
    const res = run(dir, "undo", "--dryrun");
    expect(res.code).not.toBe(0);
    expect(readFileSync(join(dir, "access.json"), "utf8")).toBe(before);
  });

  test("group add --ref on a legacy <phone>-<ts>@g.us group masks the number in the config path line too", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "61403911675-1610000000@g.us": {
        name: "Legacy",
        memberCount: 3,
        archived: false,
        updatedAt: 1,
      },
    });
    const cand = JSON.parse(run(dir, "candidates").out);
    const ref = cand.groups.items[0].ref;
    const res = run(dir, "group", "add", "--ref", ref, "--mention");
    expect(res.code).toBe(0);
    expect(res.out).not.toContain("61403911675");
    expect(res.out).toContain("config.md");
  });

  test("--dry-run after a backed-up change prints a +/- line per changed entry, no raw number, modifies neither file", () => {
    const dir = freshStateDir();
    run(dir, "allow", "61403911675@s.whatsapp.net");
    run(dir, "allow", "61432609386@s.whatsapp.net", "--backup");
    const accessBefore = readFileSync(join(dir, "access.json"), "utf8");
    const bakBefore = readFileSync(join(dir, "access.json.bak"), "utf8");
    const res = run(dir, "undo", "--dry-run");
    expect(res.code).toBe(0);
    expect(res.out).toContain("+");
    expect(res.out).toContain("-");
    expect(res.out).not.toContain("61403911675");
    expect(res.out).not.toContain("61432609386");
    expect(readFileSync(join(dir, "access.json"), "utf8")).toBe(accessBefore);
    expect(readFileSync(join(dir, "access.json.bak"), "utf8")).toBe(bakBefore);
  });

  test("restores the previous access.json; a second undo puts the change back (swap semantics)", () => {
    const dir = freshStateDir();
    run(dir, "allow", "1@s.whatsapp.net");
    const beforeChange = readFileSync(join(dir, "access.json"), "utf8");
    run(dir, "allow", "2@s.whatsapp.net", "--backup");
    const afterChange = readFileSync(join(dir, "access.json"), "utf8");

    expect(run(dir, "undo").code).toBe(0);
    expect(readFileSync(join(dir, "access.json"), "utf8")).toBe(beforeChange);

    expect(run(dir, "undo").code).toBe(0);
    expect(readFileSync(join(dir, "access.json"), "utf8")).toBe(afterChange);
  });

  test("access.json missing but .bak present (a corrupt file deleted per load()'s own advice): restores instead of crashing", () => {
    const dir = freshStateDir();
    run(dir, "allow", "1@s.whatsapp.net");
    run(dir, "allow", "2@s.whatsapp.net", "--backup");
    const bak = readFileSync(join(dir, "access.json.bak"), "utf8");
    rmSync(join(dir, "access.json"));

    const dry = run(dir, "undo", "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("+");
    expect(existsSync(join(dir, "access.json"))).toBe(false);

    const res = run(dir, "undo");
    expect(res.code).toBe(0);
    expect(readFileSync(join(dir, "access.json"), "utf8")).toBe(bak);
  });

  test("wizard --undo produces the same output as undo and never blocks on a prompt", () => {
    const dir = freshStateDir();
    run(dir, "allow", "1@s.whatsapp.net");
    run(dir, "allow", "2@s.whatsapp.net", "--backup");
    const dir2 = freshStateDir();
    run(dir2, "allow", "1@s.whatsapp.net");
    run(dir2, "allow", "2@s.whatsapp.net", "--backup");

    const viaUndo = run(dir, "undo", "--dry-run");
    const viaWizard = run(dir2, "wizard", "--undo", "--dry-run");
    expect(viaWizard.code).toBe(0);
    expect(viaWizard.out).toBe(viaUndo.out);
  });
});
