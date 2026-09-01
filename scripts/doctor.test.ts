import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Creates a sparse file of an exact byte size without writing real data, so
// boundary tests at hundreds of MB run instantly and cost near-zero disk.
function writeSized(path: string, bytes: number): void {
  closeSync(openSync(path, "w"));
  truncateSync(path, bytes);
}

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
  // Same probe doctor uses. `ps -o lstart=` does not exist on Windows, so this
  // helper has to branch too or every live-lock test is red there.
  const [cmd, args] =
    process.platform === "win32"
      ? [
          `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop | ForEach-Object { $_.CreationDate.ToFileTimeUtc() })`,
          ],
        ]
      : ["ps", ["-p", String(pid), "-o", "lstart="]];
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
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
      JSON.stringify({
        dmPolicy: "open",
        allowFrom: [],
        groups: {},
        pending: {},
      }),
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
        JSON.stringify({
          ts: oldTs,
          chat_id: "c",
          direction: "out",
          replied: true,
        }) +
        "\n",
    );
    const out = runDoctor(dir);
    expect(out).toContain("[PASS] activity: no stale unreplied messages");
  });
});

describe("group-configs", () => {
  function withGroup(configMd: string): string {
    const dir = freshStateDir();
    writeFileSync(
      join(dir, "access.json"),
      JSON.stringify({
        dmPolicy: "pairing",
        allowFrom: [],
        groups: { "123@g.us": {} },
        pending: {},
      }),
    );
    mkdirSync(join(dir, "groups", "123@g.us"), { recursive: true });
    writeFileSync(join(dir, "groups", "123@g.us", "config.md"), configMd);
    return dir;
  }
  test("near-miss cron heading → WARN (server silently ignores it)", () => {
    const out = runDoctor(
      withGroup("# P\n\n## Cron jobs\n\n- daily 9am standup\n"),
    );
    expect(out).toContain("[WARN] group-configs: 123@g.us");
    expect(out).toContain('not exactly "## Cron Jobs"');
  });
  test("exact heading → INFO with entry count", () => {
    const out = runDoctor(
      withGroup(
        "# P\n\n## Cron Jobs\n\n- daily 9am standup\n- every 30 min check\n",
      ),
    );
    expect(out).toContain(
      "[INFO] group-configs: 123@g.us: ## Cron Jobs section with 2 entries",
    );
  });
  test("config without cron → PASS", () => {
    const out = runDoctor(withGroup("# Personality\n\nBe helpful.\n"));
    expect(out).toContain("[PASS] group-configs: 123@g.us: config.md present");
  });
});

describe("optional features", () => {
  test("no whisper script and no watchdog → INFO only, never ERROR", () => {
    // Empty state dir: transcription/watchdog absence must not add errors
    // beyond the core-chain ones (auth+server = exactly 2 errors here).
    const out = runDoctor(freshStateDir());
    expect(out).toMatch(/\[INFO\] (transcription|watchdog)/);
    expect(out).toMatch(/SUMMARY: 2 error/);
  });
  test("watchdog absent → message points at setup for install", () => {
    const out = runDoctor(freshStateDir());
    expect(out).toContain(
      "run /whatsapp-channel:setup to install auto-recovery",
    );
  });
});

describe("notify hook", () => {
  function withWatchdog(dir: string): void {
    writeFileSync(join(dir, "watchdog.sh"), "#!/bin/bash\n");
    execFileSync("chmod", ["+x", join(dir, "watchdog.sh")]);
  }
  test("watchdog installed, no notify hook → INFO, falls back to local", () => {
    const dir = freshStateDir();
    withWatchdog(dir);
    const out = runDoctor(dir);
    expect(out).toContain("[INFO] watchdog: no notify hook at");
    expect(out).toContain(
      "alerts fall back to a local macOS notification only",
    );
  });
  test("notify hook present but not executable → WARN with chmod fix", () => {
    const dir = freshStateDir();
    withWatchdog(dir);
    writeFileSync(join(dir, "notify-hook.sh"), "#!/bin/bash\necho hi\n");
    const out = runDoctor(dir);
    expect(out).toContain("[WARN] watchdog: notify hook");
    expect(out).toContain("not executable");
    expect(out).toContain("fix[safe]: chmod +x");
  });
  test("notify hook present and executable → PASS", () => {
    const dir = freshStateDir();
    withWatchdog(dir);
    const hook = join(dir, "notify-hook.sh");
    writeFileSync(hook, "#!/bin/bash\necho hi\n");
    execFileSync("chmod", ["+x", hook]);
    const out = runDoctor(dir);
    expect(out).toContain("[PASS] watchdog: notify hook");
    expect(out).toContain("present and executable");
  });
  test("no watchdog installed → notify hook is not checked at all", () => {
    const dir = freshStateDir();
    writeFileSync(join(dir, "notify-hook.sh"), "#!/bin/bash\n");
    const out = runDoctor(dir);
    expect(out).not.toContain("notify hook");
  });
});

describe("disk-usage", () => {
  test("all three files absent → INFO only", () => {
    const out = runDoctor(freshStateDir());
    expect(out).toContain("[INFO] disk-usage: inbox/ does not exist yet");
    expect(out).toContain("[INFO] disk-usage: diag.log does not exist yet");
    expect(out).toContain("[INFO] disk-usage: lid-map.json does not exist yet");
  });

  test("inbox just at the WARN threshold → PASS", () => {
    const dir = freshStateDir();
    mkdirSync(join(dir, "inbox"), { recursive: true });
    writeSized(join(dir, "inbox", "a.jpg"), 500_000_000); // == threshold, not over
    const out = runDoctor(dir);
    expect(out).toContain("[PASS] disk-usage: inbox/: 1 file(s), 500.0 MB");
  });
  test("inbox one byte over the WARN threshold → WARN", () => {
    const dir = freshStateDir();
    mkdirSync(join(dir, "inbox"), { recursive: true });
    writeSized(join(dir, "inbox", "a.jpg"), 500_000_001);
    const out = runDoctor(dir);
    expect(out).toContain("[WARN] disk-usage: inbox/ holds 1 file(s)");
    expect(out).toContain("never been automatically pruned");
  });

  test("diag.log just at the WARN threshold → PASS", () => {
    const dir = freshStateDir();
    writeSized(join(dir, "diag.log"), 10_000_000);
    const out = runDoctor(dir);
    expect(out).toContain("[PASS] disk-usage: diag.log: 10.0 MB");
  });
  test("diag.log one byte over the WARN threshold → WARN", () => {
    const dir = freshStateDir();
    writeSized(join(dir, "diag.log"), 10_000_001);
    const out = runDoctor(dir);
    expect(out).toContain("[WARN] disk-usage: diag.log is 10.0 MB");
    expect(out).toContain("self-truncation cap");
  });

  test("lid-map.json just at the WARN threshold → PASS", () => {
    const dir = freshStateDir();
    writeSized(join(dir, "lid-map.json"), 2_000_000);
    const out = runDoctor(dir);
    expect(out).toContain("[PASS] disk-usage: lid-map.json: 2.0 MB");
  });
  test("lid-map.json one byte over the WARN threshold → WARN", () => {
    const dir = freshStateDir();
    writeSized(join(dir, "lid-map.json"), 2_000_001);
    const out = runDoctor(dir);
    expect(out).toContain("[WARN] disk-usage: lid-map.json is 2.0 MB");
    expect(out).toContain("larger than a normal contact list");
  });
});
