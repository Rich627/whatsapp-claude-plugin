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
