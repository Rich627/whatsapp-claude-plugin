import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DOCTOR = join(import.meta.dir, "doctor.ts");

// Runs doctor against a fixture state dir. execFileSync throws on nonzero
// exit, so every passing test also proves the exit-0 contract.
function runDoctor(stateDir: string): string {
  return execFileSync("bun", [DOCTOR], {
    encoding: "utf8",
    env: { ...process.env, WHATSAPP_STATE_DIR: stateDir },
  });
}

function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), "doctor-fixture-"));
}

// lstart of a live pid, exactly as doctor computes it
function lstart(pid: number): string {
  return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
  }).trim();
}

describe("state-dir", () => {
  test("missing dir is an ERROR pointing at setup", () => {
    const out = runDoctor(join(tmpdir(), "doctor-definitely-absent-xyz"));
    expect(out).toContain("[ERROR] state-dir:");
    expect(out).toContain("fix[manual]:");
    expect(out).toMatch(/SUMMARY: [1-9]\d* error/);
  });
});

describe("auth", () => {
  test("empty state dir → never linked", () => {
    const out = runDoctor(freshStateDir());
    expect(out).toContain("[ERROR] auth: no Baileys credentials");
  });
  test("corrupt creds.json → ERROR with manual re-link fix", () => {
    const dir = freshStateDir();
    mkdirSync(join(dir, ".baileys_auth"), { recursive: true });
    writeFileSync(join(dir, ".baileys_auth", "creds.json"), "{not json");
    const out = runDoctor(dir);
    expect(out).toContain("[ERROR] auth: creds.json is corrupt");
    expect(out).toContain("fix[manual]:");
  });
  test("paired creds → PASS with jid", () => {
    const dir = freshStateDir();
    mkdirSync(join(dir, ".baileys_auth"), { recursive: true });
    writeFileSync(
      join(dir, ".baileys_auth", "creds.json"),
      JSON.stringify({ me: { id: "123@s.whatsapp.net" } }),
    );
    const out = runDoctor(dir);
    expect(out).toContain("[PASS] auth: linked as 123@s.whatsapp.net");
  });
});

describe("server lock", () => {
  test("no lock file → ERROR server not running", () => {
    const out = runDoctor(freshStateDir());
    expect(out).toContain("[ERROR] server: no lock file");
  });
  test("lock with lstart mismatch → stale WARN with safe rm fix", () => {
    const dir = freshStateDir();
    // Live PID (this test process) but a lockedStart that can't match:
    // doctor must treat it as PID reuse, i.e. stale.
    writeFileSync(
      join(dir, ".server.lock"),
      `${process.pid}\nThu Jan  1 00:00:00 1970\n`,
    );
    const out = runDoctor(dir);
    expect(out).toContain("[WARN] server: stale lock");
    expect(out).toContain("fix[safe]: rm ");
  });
  test("live lock (pid alive, lstart matches, parent alive) → PASS", () => {
    const dir = freshStateDir();
    writeFileSync(
      join(dir, ".server.lock"),
      `${process.pid}\n${lstart(process.pid)}\n`,
    );
    const out = runDoctor(dir);
    expect(out).toContain("[PASS] server: server running (pid " + process.pid);
  });
});

describe("access-config", () => {
  test("corrupt access.json → ERROR", () => {
    const dir = freshStateDir();
    writeFileSync(join(dir, "access.json"), "][");
    const out = runDoctor(dir);
    expect(out).toContain("[ERROR] access-config: access.json is corrupt");
  });
  test("invalid dmPolicy → ERROR naming the field", () => {
    const dir = freshStateDir();
    writeFileSync(
      join(dir, "access.json"),
      JSON.stringify({ dmPolicy: "open", allowFrom: [], groups: {}, pending: {} }),
    );
    const out = runDoctor(dir);
    expect(out).toContain('dmPolicy "open" invalid');
  });
  test("valid config → PASS with summary", () => {
    const dir = freshStateDir();
    writeFileSync(
      join(dir, "access.json"),
      JSON.stringify({
        dmPolicy: "allowlist",
        allowFrom: ["111", "222"],
        groups: {},
        pending: {},
      }),
    );
    const out = runDoctor(dir);
    expect(out).toContain(
      "[PASS] access-config: dmPolicy: allowlist, 2 allowed contact(s), 0 group(s)",
    );
  });
});

describe("activity", () => {
  const oldTs = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  test("stale unreplied inbound → WARN", () => {
    const dir = freshStateDir();
    writeFileSync(
      join(dir, "messages.jsonl"),
      JSON.stringify({ ts: oldTs, chat_id: "c", replied: false }) + "\n",
    );
    const out = runDoctor(dir);
    expect(out).toMatch(/\[WARN\] activity: 1 inbound message/);
  });
  test("replied messages → PASS", () => {
    const dir = freshStateDir();
    writeFileSync(
      join(dir, "messages.jsonl"),
      JSON.stringify({ ts: oldTs, chat_id: "c", replied: true }) +
        "\n" +
        JSON.stringify({ ts: oldTs, chat_id: "c", direction: "out", replied: true }) +
        "\n",
    );
    const out = runDoctor(dir);
    expect(out).toContain("[PASS] activity: no stale unreplied messages");
  });
});
