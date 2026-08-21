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

function writeGroupsMeta(
  dir: string,
  meta: Record<
    string,
    { name: string; memberCount: number; archived: boolean; updatedAt: number }
  >,
): void {
  writeFileSync(join(dir, "groups-meta.json"), JSON.stringify(meta, null, 2));
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
});

describe("wizard", () => {
  test("no groups-meta.json cached yet: refuses with a clear message", () => {
    const dir = freshStateDir();
    const res = run(dir, "wizard");
    expect(res.code).toBe(1);
    expect(res.out).toContain("No group data cached yet");
  });

  test("archived groups are skipped by default; already-configured groups are skipped too", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": { name: "Active", memberCount: 3, archived: false, updatedAt: 0 },
      "2@g.us": { name: "Archived", memberCount: 2, archived: true, updatedAt: 0 },
    });
    run(dir, "group", "add", "1@g.us"); // already configured
    const res = run(dir, "wizard");
    expect(res.code).toBe(0);
    expect(res.out).toContain("Every known group is already configured");
    expect(access(dir).groups["2@g.us"]).toBeUndefined();
  });

  test("y then n grants act-only access (roster stays false)", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": { name: "Family", memberCount: 4, archived: false, updatedAt: 0 },
    });
    const res = runWithInput(dir, "y\nn\n", "wizard");
    expect(res.code).toBe(0);
    expect(access(dir).groups["1@g.us"]).toEqual({
      requireMention: true,
      allowFrom: [],
      roster: false,
    });
    expect(existsSync(join(dir, "groups", "1@g.us", "config.md"))).toBe(true);
  });

  test("y then y grants both act and roster access", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": { name: "Family", memberCount: 4, archived: false, updatedAt: 0 },
    });
    const res = runWithInput(dir, "y\ny\n", "wizard");
    expect(res.code).toBe(0);
    expect(access(dir).groups["1@g.us"].roster).toBe(true);
  });

  test("n (or anything else) skips a group with no roster prompt asked, and writes nothing", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": { name: "Family", memberCount: 4, archived: false, updatedAt: 0 },
    });
    const res = runWithInput(dir, "n\n", "wizard");
    expect(res.code).toBe(0);
    expect(res.out).toContain("Skipped.");
    expect(res.out).toContain("No groups configured.");
    // Nothing changed, so access.json is never even created.
    expect(existsSync(join(dir, "access.json"))).toBe(false);
  });

  test("two live candidates in one run: skip the first, configure the second", () => {
    // Regression coverage for the loop actually iterating more than once -
    // the earlier "already configured" test filters both candidates out
    // before the loop runs at all, so it never exercised this.
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": { name: "Alpha", memberCount: 2, archived: false, updatedAt: 0 },
      "2@g.us": { name: "Beta", memberCount: 5, archived: false, updatedAt: 0 },
    });
    // Sorted by name: Alpha first (skip with "n"), then Beta (y, y).
    const res = runWithInput(dir, "n\ny\ny\n", "wizard");
    expect(res.code).toBe(0);
    const a = access(dir);
    expect(a.groups["1@g.us"]).toBeUndefined();
    expect(a.groups["2@g.us"]).toEqual({
      requireMention: true,
      allowFrom: [],
      roster: true,
    });
    expect(res.out).toContain("1 group(s) configured.");
  });

  test("--include-archived reviews archived groups too", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": { name: "Old Chat", memberCount: 2, archived: true, updatedAt: 0 },
    });
    const res = runWithInput(dir, "y\nn\n", "wizard", "--include-archived");
    expect(res.code).toBe(0);
    expect(access(dir).groups["1@g.us"]).toBeDefined();
  });

  test("the closing privacy line is always printed, in plain text when not a TTY", () => {
    const dir = freshStateDir();
    writeGroupsMeta(dir, {
      "1@g.us": { name: "Family", memberCount: 4, archived: false, updatedAt: 0 },
    });
    const res = runWithInput(dir, "n\n", "wizard");
    expect(res.out).toContain(
      "No group or contact data was sent to any AI model during this setup",
    );
    // execFileSync's pipes are never a TTY, so no ANSI escape should appear.
    expect(res.out).not.toContain("\x1b[");
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
