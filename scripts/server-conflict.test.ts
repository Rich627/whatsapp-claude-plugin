import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "..", "server.ts");

// Same probe as server.ts, so the lock we plant names this test process as a
// live holder the server cannot tell apart from a real one.
function ownStartTime(): string {
  const [cmd, args] =
    process.platform === "win32"
      ? [
          `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}" -ErrorAction Stop | ForEach-Object { $_.CreationDate.ToFileTimeUtc() })`,
          ],
        ]
      : ["ps", ["-p", String(process.pid), "-o", "lstart="]];
  return execFileSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("conflict mode", () => {
  test("a refused server leaves the pairing handoff files alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-conflict-"));
    writeFileSync(
      join(dir, ".server.lock"),
      `${process.pid}\n${ownStartTime()}\n\n`,
    );
    mkdirSync(join(dir, "approved"));
    const handoff = join(dir, "approved", "886900000000@s.whatsapp.net");
    writeFileSync(handoff, "886900000000@s.whatsapp.net");

    const child = spawn("bun", [SERVER], {
      env: { ...process.env, WHATSAPP_STATE_DIR: dir },
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    try {
      // Module load (Baileys import) can take several seconds; wait for the
      // server to say it refused, then give the 5 s checkApprovals tick a
      // chance to fire.
      for (let i = 0; i < 60 && !stderr.includes("already running"); i++) {
        await sleep(500);
      }
      expect(stderr).toContain("another whatsapp server is already running");
      await sleep(7000);
      expect(existsSync(handoff)).toBe(true);
    } finally {
      child.kill();
    }
  }, 60_000);
});

// Issue #4: shutdown() only removes the role file on a graceful exit, so a
// killed or crashed server leaves one behind forever. The sweep runs before
// the singleton lock is taken, which is what lets this test see it: the
// server planted against a live lock refuses and exits, and must STILL have
// tidied up on its way through.
describe("stale role file sweep", () => {
  test("removes role files of dead pids and keeps live ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-rolesweep-"));
    const dead = join(dir, ".role-999999");
    const live = join(dir, `.role-${process.pid}`);
    const notOurs = join(dir, ".role-not-a-pid");
    writeFileSync(dead, "primary\n999999\n");
    writeFileSync(live, "secondary\n1\n");
    writeFileSync(notOurs, "primary");

    const child = spawn("bun", [SERVER], {
      env: { ...process.env, WHATSAPP_STATE_DIR: dir },
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    try {
      for (let i = 0; i < 60 && existsSync(dead); i++) await sleep(500);
      expect(existsSync(dead)).toBe(false);
      // A live pid's file belongs to a running server - never ours to remove.
      expect(existsSync(live)).toBe(true);
      // Not .role-<number>, so not this sweep's business.
      expect(existsSync(notOurs)).toBe(true);
    } finally {
      child.kill();
    }
  }, 60_000);
});
