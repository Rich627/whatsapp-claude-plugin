import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
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

// Like runWithInput, but drives a checkbox()-then-confirm() prompt chain.
// runWithInput's execFileSync writes the WHOLE keystroke blob before the
// process even starts reading and closes stdin the moment it's written - the
// checkbox prompt lands fine on that, but the confirm() prompt right after it
// never sees its own trailing "\n" and hangs forever (reproduced directly,
// independent of this suite, on this exact machine - Windows, not just CI).
// Spawning instead and writing one prompt's keystrokes at a time, a beat
// apart, lets each prompt's own readline actually attach before the next
// byte arrives, and the process then exits BY ITSELF once it's done - no
// forced kill on the happy path. `keystrokes` is one string per prompt, e.g.
// [" \n", "\n"] for "toggle the row, submit the checkbox" then "accept the
// confirm default". Still gated by the SAME checkbox-toggle-on-Linux gap the
// rest of this file documents (see the block comment above `describe("wizard"
// ...)`), so callers still skip it under CI.
// `between`, when given, runs once - right before the LAST keystroke is
// written (the confirm) - so a test can mutate access.json on disk while the
// process is blocked waiting on that prompt, the same window a concurrent
// server write (a pairing approval) lands in for real.
function runWizardWrite(
  dir: string,
  keystrokes: string[],
  args: string[],
  opts?: { between?: () => void },
): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("bun", [CLI, ...args], {
      env: { ...process.env, WHATSAPP_STATE_DIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    (async () => {
      for (let i = 0; i < keystrokes.length; i++) {
        await new Promise((r) => setTimeout(r, 400));
        if (i === keystrokes.length - 1) opts?.between?.();
        child.stdin.write(keystrokes[i]);
      }
    })();
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        out: out + "\n[runWizardWrite gave up waiting for the process to exit]",
        code: -1,
      });
    }, 10_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ out, code: code ?? 1 });
    });
  });
}

// @inquirer/prompts hard-wraps a long `message` to the terminal width it sees
// from a piped, non-TTY stdout (no word-boundary awareness - it can and does
// split mid-word, re-opening the bold ANSI code on the far side of the
// break). Stripping ANSI codes and newlines turns that back into the
// original sentence for a substring check, without weakening what's being
// checked - only where the literal bytes place a line break.
function flatten(out: string): string {
  return out.replace(/\x1b\[[0-9;]*m/g, "").replace(/\n/g, "");
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
//
// skipIf(CI): 6 of the tests below navigate the checkbox with " "/"\n"
// (toggle/submit keystrokes) and hang for the full 5s timeout on GitHub's
// Linux runners, every time - confirmed not a bun-version issue (reproduced
// locally against the exact bun version CI uses, still passes on Windows).
// @inquirer/prompts' checkbox() needs real keypress events to register a
// toggle, and how a piped, non-TTY stdin's raw bytes turn into keypress
// events differs enough between Windows and Linux that Linux never sees the
// toggle. The Ctrl-C test below is unaffected and NOT skipped - "\x03"
// resolves as an interrupt without needing that same keypress-by-keypress
// handling. Every affected test runs fine locally on either platform; only
// CI (Linux) skips them.
//
// T15 chains a checkbox() with a SECOND prompt, confirm() - a different pair
// from the checkbox-then-checkbox case above, and runWithInput's one-shot
// execFileSync `input` hangs on it everywhere, Windows included (reproduced
// directly: the checkbox's own toggle/submit lands fine, "Apply these
// changes? (Y/n)" renders, then the process never reads the trailing "\n").
// The four write-path tests below use `runWizardWrite` instead (see its own
// comment) - spawning and pacing the keystrokes a beat apart, rather than
// writing them all before the process starts reading, is enough for the
// confirm() prompt to see its own input. They are still `skipIf(CI)`: the
// checkbox toggle itself is the OTHER, unrelated gap this file documents
// above (Linux never sees the piped " " keypress), and `runWizardWrite`
// does nothing to fix that one.
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

  test("a configured group is shown pre-ticked, not skipped", () => {
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
    const before = readFileSync(join(dir, "access.json"), "utf8");
    const res = runWithInput(dir, "\x03", "wizard");
    expect(res.code).toBe(0);
    expect(res.out).toContain("Family");
    expect(flatten(res.out)).toContain("untick to take that away");
    expect(res.out).toContain("Cancelled");
    expect(readFileSync(join(dir, "access.json"), "utf8")).toBe(before);
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
    const plain = runWithInput(dir, "\x03", "wizard");
    const revoke = runWithInput(dir, "\x03", "wizard", "--revoke");
    expect(revoke.out).toContain("Family");
    expect(flatten(revoke.out)).toContain("untick to take that away");
    expect(revoke.code).toBe(plain.code);
  });

  test("an already-configured group is offered pre-ticked instead of leaving nothing to review", () => {
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
    const res = runWithInput(dir, "\x03", "wizard");
    expect(res.code).toBe(0);
    expect(res.out).toContain("Active");
    expect(access(dir).groups["2@g.us"]).toBeUndefined();
  });

  test.skipIf(!!process.env.CI)(
    "groups only, select none: nothing configured, access.json never created",
    () => {
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
      expect(res.out).toContain(
        "Nothing changed - your ticks match what was already set up.",
      );
      expect(existsSync(join(dir, "access.json"))).toBe(false);
    },
  );

  test.skipIf(!!process.env.CI)(
    "--include-archived surfaces an archived group as a candidate",
    () => {
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
    },
  );

  test.skipIf(!!process.env.CI)(
    "DMs only, select none: nothing configured, access.json never created",
    () => {
      const dir = freshStateDir();
      writeDmActivity(dir, { "1@s.whatsapp.net": 1000 });
      const res = runWithInput(dir, "\n", "wizard");
      expect(res.code).toBe(0);
      expect(res.out).toContain(
        "Nothing changed - your ticks match what was already set up.",
      );
      expect(existsSync(join(dir, "access.json"))).toBe(false);
    },
  );

  // Two prompts: checkbox (space ticks, enter submits) then confirm (enter
  // accepts the Y/n default) - see runWizardWrite's own comment for why this
  // needs it instead of runWithInput.
  test.skipIf(!!process.env.CI)(
    "DMs only, select the one candidate: added to the allowlist",
    async () => {
      const dir = freshStateDir();
      writeDmActivity(dir, { "61403911675@s.whatsapp.net": 1000 });
      writeContacts(dir, { "61403911675@s.whatsapp.net": { name: "Rohan" } });
      const res = await runWizardWrite(dir, [" \n", "\n"], ["wizard"]);
      expect(res.code).toBe(0);
      expect(res.out).toContain("Applied:");
      expect(access(dir).allowFrom).toEqual(["61403911675@s.whatsapp.net"]);
      // First-ever run: save() takes no .bak (there was no access.json to
      // copy), so the undo hint would point at a command that only answers
      // "no previous access file - nothing to undo".
      expect(res.out).not.toContain("Changed your mind?");
    },
  );

  test.skipIf(!!process.env.CI)(
    "a run against an already-existing access.json prints the undo hint",
    async () => {
      const dir = freshStateDir();
      run(dir, "allow", "61403911675@s.whatsapp.net"); // access.json now exists
      writeDmActivity(dir, { "61499999999@s.whatsapp.net": 1000 });
      writeContacts(dir, { "61499999999@s.whatsapp.net": { name: "Priya" } });
      const res = await runWizardWrite(dir, [" \n", "\n"], ["wizard"]);
      expect(res.code).toBe(0);
      expect(res.out).toContain("Applied:");
      expect(res.out).toContain("Changed your mind?");
    },
  );

  test.skipIf(!!process.env.CI)(
    "DM candidate label shows the saved name, never the raw number",
    () => {
      const dir = freshStateDir();
      writeDmActivity(dir, { "61403911675@s.whatsapp.net": 1000 });
      writeContacts(dir, { "61403911675@s.whatsapp.net": { name: "Rohan" } });
      const res = runWithInput(dir, "\n", "wizard");
      expect(res.out).toContain("Rohan");
      expect(res.out).not.toContain("61403911675");
    },
  );

  // Three prompts this time: the group checkbox (already-configured, no
  // candidates - just submit), the DM checkbox (tick the one candidate),
  // then confirm. Proves access.ts:636's "kept, not re-granted" comment for
  // real: a group with a per-group allowFrom and roster:true must come out
  // of a run that only touches the DM screen byte-identical to how it went
  // in - not merely requireMention/roster, which every other group test
  // already covers via `group add`.
  test.skipIf(!!process.env.CI)(
    "a kept group's requireMention/roster/allowFrom survive a run that only changes a DM",
    async () => {
      const dir = freshStateDir();
      run(
        dir,
        "group",
        "add",
        "1@g.us",
        "--roster",
        "--allow",
        "119@s.whatsapp.net",
      );
      const groupBefore = access(dir).groups["1@g.us"];
      writeDmActivity(dir, { "61403911675@s.whatsapp.net": 1000 });
      writeContacts(dir, { "61403911675@s.whatsapp.net": { name: "Rohan" } });
      const res = await runWizardWrite(dir, ["\n", " \n", "\n"], ["wizard"]);
      expect(res.code).toBe(0);
      expect(res.out).toContain("Applied:");
      expect(access(dir).allowFrom).toEqual(["61403911675@s.whatsapp.net"]);
      expect(access(dir).groups["1@g.us"]).toEqual(groupBefore);
    },
  );

  // Simulates the server appending a pairing approval to allowFrom while the
  // wizard is sitting on its confirm prompt - the exact window access.ts:643's
  // comment says survives because the write reloads AFTER confirm.
  test.skipIf(!!process.env.CI)(
    "an allowFrom entry the server adds while the confirm prompt is open is not dropped",
    async () => {
      const dir = freshStateDir();
      writeDmActivity(dir, { "61403911675@s.whatsapp.net": 1000 });
      writeContacts(dir, { "61403911675@s.whatsapp.net": { name: "Rohan" } });
      const res = await runWizardWrite(dir, [" \n", "\n"], ["wizard"], {
        between: () => {
          writeFileSync(
            join(dir, "access.json"),
            JSON.stringify({
              dmPolicy: "pairing",
              allowFrom: ["61499999999@s.whatsapp.net"],
              groups: {},
              pending: {},
            }),
          );
        },
      });
      expect(res.code).toBe(0);
      expect(res.out).toContain("Applied:");
      expect([...access(dir).allowFrom].sort()).toEqual(
        ["61403911675@s.whatsapp.net", "61499999999@s.whatsapp.net"].sort(),
      );
    },
  );

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

  test.skipIf(!!process.env.CI)(
    "the closing privacy line is always printed, in plain text (not the amber highlight) when not a TTY",
    () => {
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
    },
  );

  // The disclosure lines below are written before the checkbox renders, so
  // Ctrl-C alone is enough to observe them - no toggle/submit keystroke
  // needed, so these are NOT skipIf(CI).
  test("the cap line discloses the total when there are more than fit", () => {
    const dir = freshStateDir();
    const meta: Record<string, any> = {};
    for (let i = 1; i <= 7; i++) {
      meta[`${i}@g.us`] = {
        name: `Group ${i}`,
        memberCount: 2,
        archived: false,
        updatedAt: 0,
      };
    }
    writeGroupsMeta(dir, meta);
    const res = runWithInput(dir, "\x03", "wizard");
    expect(res.out).toContain("showing 5 of 7");
    expect(res.out).toContain("Cancelled - nothing was changed.");
    expect(existsSync(join(dir, "access.json"))).toBe(false);
  });

  test("no cap line when the whole pool fits on screen", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": { name: "A", memberCount: 2, archived: false, updatedAt: 0 },
      "2@g.us": { name: "B", memberCount: 2, archived: false, updatedAt: 0 },
    });
    const res = runWithInput(dir, "\x03", "wizard");
    expect(res.out).not.toContain("Only showing");
  });

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
    const res = runWithInput(dir, "\x03", "wizard");
    expect(res.out).toContain("2 archived group(s) are hidden");
    expect(res.out).toContain("--include-archived");
    const withFlag = runWithInput(dir, "\x03", "wizard", "--include-archived");
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
    const res = runWithInput(dir, "\x03", "wizard");
    expect(res.out).toContain("1 archived group(s) are hidden");
    expect(res.out).not.toContain("2 archived group(s) are hidden");
  });

  test.skipIf(!!process.env.CI)(
    "no DM activity on record: says so and names the opt-out flag, not silently",
    () => {
      const dir = freshStateDir();
      writeGroupsMeta(dir, {
        "1@g.us": {
          name: "Family",
          memberCount: 4,
          archived: false,
          updatedAt: 0,
        },
      });
      const res = runWithInput(dir, "\n", "wizard");
      expect(res.out).toContain("no DM activity is on record");
      expect(res.out).toContain("WHATSAPP_CACHE_CONTACTS=0");
      expect(existsSync(join(dir, "access.json"))).toBe(false);
    },
  );

  test.skipIf(!!process.env.CI)(
    "cache on but nothing new: says that instead of the caching-off line",
    () => {
      const dir = freshStateDir();
      writeGroupsMeta(dir, {
        "1@g.us": {
          name: "Family",
          memberCount: 4,
          archived: false,
          updatedAt: 0,
        },
      });
      writeDmActivity(dir, {});
      const res = runWithInput(dir, "\n", "wizard");
      expect(res.out).toContain("nothing new in the cached DM activity");
      expect(res.out).not.toContain("caching is off");
    },
  );
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

// The read-only JSON pair the in-session review/manage screens execute
// (skills/access/SKILL.md) instead of restating the ranking and labelling
// rules in prose. What matters here is the CONTRACT the skill depends on -
// the label/description rules themselves are ranking.test.ts's job.
describe("candidates (JSON for the in-session review screen)", () => {
  test("empty state: valid JSON with empty lists, not a failure", () => {
    const dir = freshStateDir();
    const { out, code } = run(dir, "candidates");
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      groups: { items: [], total: 0 },
      dms: { items: [], total: 0 },
    });
  });

  // Uncapped on purpose: a caller that showed the first four and then
  // re-asked for a fresh page would offer the same four forever, so a
  // candidate the user declines once could never be reached again.
  test("returns the WHOLE pool, most recently active first, not just a first page", () => {
    const dir = freshStateDir();
    const meta: Record<string, never> | Record<string, any> = {};
    for (let i = 1; i <= 6; i++) {
      meta[`${i}@g.us`] = {
        name: `Group ${i}`,
        memberCount: 3,
        archived: false,
        lastActivityAt: i,
        updatedAt: 0,
      };
    }
    writeGroupsMeta(dir, meta);
    writeDmActivity(dir, {
      "1@s.whatsapp.net": 1,
      "2@s.whatsapp.net": 2,
      "3@s.whatsapp.net": 3,
      "4@s.whatsapp.net": 4,
      "5@s.whatsapp.net": 5,
    });
    const parsed = JSON.parse(run(dir, "candidates").out);
    expect(parsed.groups.items).toHaveLength(6);
    expect(parsed.groups.total).toBe(6);
    expect(parsed.dms.items).toHaveLength(5);
    expect(parsed.dms.total).toBe(5);
    // Ranked, so a caller showing four at a time still shows the four that
    // matter first.
    expect(parsed.groups.items[0].ref).toBe(refFor("6@g.us"));
    expect(parsed.dms.items[0].ref).toBe(refFor("5@s.whatsapp.net"));
  });

  test("every option carries the ref, label and description the screen needs - never a jid", () => {
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
    writeContacts(dir, { "61403911675@s.whatsapp.net": { name: "Akash" } });
    const parsed = JSON.parse(run(dir, "candidates").out);
    expect(parsed.groups.items[0]).toEqual({
      ref: refFor("120363424405607157@g.us"),
      label: "Team  (4 member(s))",
      description: "120363424405607157@g.us",
    });
    expect(parsed.dms.items[0]).toEqual({
      ref: refFor("61403911675@s.whatsapp.net"),
      label: "Akash",
      // Masked, never the raw number - a full one in an option payload is
      // a real phone number written into the session transcript.
      description: "•••••1675",
    });
  });

  test("archived groups are excluded unless --include-archived is passed", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "a@g.us": {
        name: "Old",
        memberCount: 2,
        archived: true,
        updatedAt: 0,
      },
    });
    expect(JSON.parse(run(dir, "candidates").out).groups.total).toBe(0);
    expect(
      JSON.parse(run(dir, "candidates", "--include-archived").out).groups.total,
    ).toBe(1);
  });

  test("already-configured groups and already-allowed contacts are not offered again", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "a@g.us": { name: "Team", memberCount: 2, archived: false, updatedAt: 0 },
    });
    writeDmActivity(dir, { "61403911675@s.whatsapp.net": 100 });
    run(dir, "group", "add", "a@g.us");
    run(dir, "allow", "61403911675@s.whatsapp.net");
    const parsed = JSON.parse(run(dir, "candidates").out);
    expect(parsed.groups.total).toBe(0);
    expect(parsed.dms.total).toBe(0);
  });

  test("reads only - access.json is untouched", () => {
    const dir = freshStateDir();
    run(dir, "allow", "x@s.whatsapp.net");
    const before = readFileSync(join(dir, "access.json"), "utf8");
    run(dir, "candidates");
    expect(readFileSync(join(dir, "access.json"), "utf8")).toBe(before);
  });
});

describe("configured (JSON for the in-session manage/revoke screen)", () => {
  test("empty state: valid JSON with empty lists, not a failure", () => {
    const dir = freshStateDir();
    const { out, code } = run(dir, "configured");
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      groups: { items: [], total: 0 },
      dms: { items: [], total: 0 },
    });
  });

  // The revoke screen must never truncate: `manage` only ever removes, so
  // an entry that never appears can never be revoked (PR #24 review, #2).
  test("lists EVERY allowlisted contact, well past the 4 an option list shows", () => {
    const dir = freshStateDir();
    for (let i = 1; i <= 7; i++) run(dir, "allow", `${i}@s.whatsapp.net`);
    const parsed = JSON.parse(run(dir, "configured").out);
    expect(parsed.dms.total).toBe(7);
    expect(parsed.dms.items).toHaveLength(7);
  });

  test("both forms of a contact allowlisted twice stay separately revokable", () => {
    const dir = freshStateDir();
    writeLidMap(dir, {
      "184710990000999@lid": "61403911675@s.whatsapp.net",
    });
    writeContacts(dir, { "61403911675@s.whatsapp.net": { name: "Akash" } });
    run(dir, "allow", "184710990000999@lid");
    run(dir, "allow", "61403911675@s.whatsapp.net");
    const items = JSON.parse(run(dir, "configured").out).dms.items;
    expect(items).toHaveLength(2);
    // Distinct labels: AskUserQuestion returns a selection by its label, so
    // two identical ones cannot be mapped back to one JID.
    expect(new Set(items.map((c: { label: string }) => c.label)).size).toBe(2);
  });

  test("a configured group with no cached meta still appears, so it stays revokable", () => {
    const dir = freshStateDir();
    run(dir, "group", "add", "ghost@g.us");
    const items = JSON.parse(run(dir, "configured").out).groups.items;
    expect(items).toEqual([
      {
        ref: refFor("ghost@g.us"),
        label: "ghost@g.us",
        description: "ghost@g.us",
      },
    ]);
  });

  test("reads only - access.json is untouched", () => {
    const dir = freshStateDir();
    run(dir, "allow", "x@s.whatsapp.net");
    const before = readFileSync(join(dir, "access.json"), "utf8");
    run(dir, "configured");
    expect(readFileSync(join(dir, "access.json"), "utf8")).toBe(before);
  });
});

// Issue #1: until this existed the wizard could only ever GRANT, so an
// existing user pointed at it by the update notice found no way to take
// access back short of editing access.json by hand.
describe("wizard --revoke", () => {
  test("nothing configured: refuses with a clear message, writes nothing", () => {
    const dir = freshStateDir();
    const res = run(dir, "wizard", "--revoke");
    expect(res.code).toBe(1);
    expect(res.out).toContain("Nothing to review");
    expect(existsSync(join(dir, "access.json"))).toBe(false);
  });

  test.skipIf(!!process.env.CI)(
    "select none: an untouched screen removes NOTHING, never everything",
    () => {
      const dir = freshStateDir();
      run(dir, "allow", "61403911675@s.whatsapp.net");
      const before = readFileSync(join(dir, "access.json"), "utf8");
      const res = runWithInput(dir, "\n", "wizard", "--revoke");
      expect(res.code).toBe(0);
      expect(res.out).toContain(
        "Nothing changed - your ticks match what was already set up.",
      );
      expect(readFileSync(join(dir, "access.json"), "utf8")).toBe(before);
    },
  );

  // Two prompts: checkbox then confirm. The row is pre-ticked, so space now
  // UNticks it - see runWizardWrite's own comment for why this needs it
  // instead of runWithInput.
  test.skipIf(!!process.env.CI)(
    "select the one contact: dropped from the allowlist and forgotten",
    async () => {
      const dir = freshStateDir();
      writeContacts(dir, { "61403911675@s.whatsapp.net": { name: "Rohan" } });
      writeDmActivity(dir, { "61403911675@s.whatsapp.net": 1000 });
      run(dir, "allow", "61403911675@s.whatsapp.net");
      const res = await runWizardWrite(
        dir,
        [" \n", "\n"],
        ["wizard", "--revoke"],
      );
      expect(res.code).toBe(0);
      // Labelled, not raw-numbered.
      expect(res.out).toContain("Rohan");
      expect(res.out).toContain("Forgot their cached name");
      expect(access(dir).allowFrom).toEqual([]);
      expect(readContacts(dir)["61403911675@s.whatsapp.net"]).toBeUndefined();
    },
  );

  // Same checkbox-then-confirm pair as above.
  test.skipIf(!!process.env.CI)(
    "select the one group: dropped, but its config.md and memory.md are kept",
    async () => {
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
      const config = join(dir, "groups", "1@g.us", "config.md");
      expect(existsSync(config)).toBe(true);
      const res = await runWizardWrite(
        dir,
        [" \n", "\n"],
        ["wizard", "--revoke"],
      );
      expect(res.code).toBe(0);
      expect(res.out).toContain("Family");
      expect(access(dir).groups["1@g.us"]).toBeUndefined();
      expect(existsSync(config)).toBe(true);
    },
  );

  // Same checkbox-then-confirm pair as above.
  test.skipIf(!!process.env.CI)(
    "revoking one form of a doubly-allowlisted contact keeps the shared cache",
    async () => {
      // Same guard `remove` applies - shared through revokeCachedIdentity so
      // the two screens cannot drift apart on it.
      const dir = freshStateDir();
      writeLidMap(dir, {
        "228896205193224@lid": "61432609386@s.whatsapp.net",
      });
      writeContacts(dir, { "61432609386@s.whatsapp.net": { name: "Soham" } });
      run(dir, "allow", "228896205193224@lid");
      run(dir, "allow", "61432609386@s.whatsapp.net");
      // Rows sort by label then JID, so the @lid form is first; space ticks
      // it, enter submits, enter confirms.
      const res = await runWizardWrite(
        dir,
        [" \n", "\n"],
        ["wizard", "--revoke"],
      );
      expect(res.code).toBe(0);
      expect(res.out).toContain("Kept their cached name");
      expect(access(dir).allowFrom).toEqual(["61432609386@s.whatsapp.net"]);
      expect(readContacts(dir)["61432609386@s.whatsapp.net"]).toEqual({
        name: "Soham",
      });
    },
  );

  test.skipIf(!!process.env.CI)(
    "still prints the no-AI disclosure - a revoke is as terminal-only as a grant",
    () => {
      const dir = freshStateDir();
      run(dir, "allow", "1@s.whatsapp.net");
      const res = runWithInput(dir, "\n", "wizard", "--revoke");
      expect(res.out).toContain("No group or contact data was sent to any AI");
    },
  );
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
