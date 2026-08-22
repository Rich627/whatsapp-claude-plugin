import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ipcSocketPath } from "./ipc";
import { ownStartTime, sleep, startFakePrimary } from "./ipc-test-helpers";

// Exercises a secondary's auto-promotion and degradation when its primary
// disappears, against a real server.ts child process the same way
// scripts/ipc-relay.test.ts does — a fake primary built from this module's
// own encode/LineBuffer/IPC_HELLO_ID, driven over stdio as a real MCP
// client, lock planted via ownStartTime() to force the secondary path.

const SERVER = join(import.meta.dir, "..", "server.ts");

// Same poll-until-timeout pattern used for every multi-step assertion in this
// file: repeatedly re-checks `check()` until it's truthy or the budget runs
// out, instead of a single synchronous read taken right after some unrelated
// log line appears. A prior version of this file used exactly one immediate
// readFileSync() for the token-change assertion (no poll) and flaked ~33% of
// isolated runs, because startIpcListener()'s token rewrite happens inside
// server.listen()'s async success callback — the "won the singleton lock"
// stderr line (written before becomePrimary() is even called) gives that
// callback no guaranteed head start. Fixed here by polling instead.
async function waitFor(
  check: () => boolean,
  attempts: number,
  intervalMs: number,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (check()) return true;
    await sleep(intervalMs);
  }
  return check();
}

type Rig = {
  dir: string;
  token: string;
  primary: Awaited<ReturnType<typeof startFakePrimary>>;
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
};

// Spawns a real server.ts child in secondary mode against a fake primary,
// waits for the initial "ipc: connected to primary" and a completed MCP
// initialize. WHATSAPP_PHONE_NUMBER/WHATSAPP_ACCOUNT_NAME are overridden to
// "" — becomePrimary() (test 3) calls connectWhatsApp(), and inheriting a
// real number here would fire a real pairing-code request against the
// developer's own WhatsApp account. The temp WHATSAPP_STATE_DIR has no
// Baileys auth state, so it can only sit unpaired.
async function startSecondaryRig(dirPrefix: string): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), dirPrefix));
  const token = "a".repeat(64);
  writeFileSync(join(dir, ".ipc-token"), token + "\n", { mode: 0o600 });
  writeFileSync(
    join(dir, ".server.lock"),
    `${process.pid}\n${ownStartTime()}\n\n`,
  );

  const primary = await startFakePrimary(dir, token);
  const child = spawn("bun", [SERVER], {
    env: {
      ...process.env,
      WHATSAPP_STATE_DIR: dir,
      WHATSAPP_PHONE_NUMBER: "",
      WHATSAPP_ACCOUNT_NAME: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (stderr += d));

  const rig: Rig = {
    dir,
    token,
    primary,
    child,
    stdout: () => stdout,
    stderr: () => stderr,
  };

  await waitFor(() => stderr.includes("ipc: connected to primary"), 120, 500);
  expect(stderr).toContain("ipc: connected to primary");

  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    }) + "\n",
  );
  await waitFor(() => stdout.includes('"id":1'), 40, 250);
  expect(stdout).toContain('"id":1');
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }) + "\n",
  );

  return rig;
}

let toolCallId = 1;
function callTool(rig: Rig, name: string): number {
  const id = ++toolCallId;
  rig.child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: {} },
    }) + "\n",
  );
  return id;
}

function listTools(rig: Rig): number {
  const id = ++toolCallId;
  rig.child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/list",
      params: {},
    }) + "\n",
  );
  return id;
}

describe("ipc promotion/degradation (secondary)", () => {
  test("degrades when the primary vanishes and the lock is unwinnable", async () => {
    const rig = await startSecondaryRig("wa-promo-degrade-");
    try {
      const before = rig.stdout().length;

      // Close the fake primary's listener and destroy its accepted socket —
      // the same shape as a hard-killed primary process dropping the connection.
      const degradedSince = Date.now();
      rig.primary.close();

      expect(
        await waitFor(
          () => rig.stderr().includes("lost the primary connection"),
          40,
          250,
        ),
      ).toBe(true);
      expect(
        await waitFor(
          () => rig.stderr().includes("no primary reachable; retrying"),
          40,
          250,
        ),
      ).toBe(true);

      // Lock names this test process, which is alive for the whole test — the
      // child can never win it, so it stays degraded (no promotion).
      const callId = callTool(rig, "unreplied");
      expect(
        await waitFor(() => rig.stdout().includes(`"id":${callId}`), 20, 250),
      ).toBe(true); // proves no hang on the dead socket (returns within ~5s)
      const stdoutAfterCall = rig.stdout().slice(before);
      expect(stdoutAfterCall).toContain(
        "WhatsApp allows one connection per account",
      );

      const listId = listTools(rig);
      await waitFor(() => rig.stdout().includes(`"id":${listId}`), 20, 250);
      const stdoutAfterList = rig.stdout().slice(before);
      expect(stdoutAfterList).toContain("whatsapp_unavailable");
      expect(stdoutAfterList).not.toContain('"name":"reply"');

      // Regression (review issue 1): "lost the primary connection" is only
      // true for the one connection that actually completed its handshake —
      // every failed reconnect tick after that (every 2s) must NOT re-log it.
      // Wait out to ~6s degraded, then count.
      const remainingFor6s = 6_000 - (Date.now() - degradedSince);
      if (remainingFor6s > 0) await sleep(remainingFor6s);
      expect(rig.stderr().split("lost the primary connection").length - 1).toBe(
        1,
      );

      // Regression (review issue 2): the singleton-lock refusal line is
      // correct once (the startup call), but must NOT repeat from the ~3s
      // lock-retry tick — this rig's lock names the live test process, so
      // the child can never win it and stays degraded the whole test. Wait
      // out to ~10s degraded, then count.
      const remainingFor10s = 10_000 - (Date.now() - degradedSince);
      if (remainingFor10s > 0) await sleep(remainingFor10s);
      expect(
        rig.stderr().split("another whatsapp server is already running")
          .length - 1,
      ).toBe(1);
    } finally {
      rig.child.kill();
      try {
        rig.primary.close();
      } catch {}
    }
  }, 60_000);

  test("reconnects to a restarted primary (2s tier)", async () => {
    const rig = await startSecondaryRig("wa-promo-reconnect-");
    try {
      rig.primary.close();
      await waitFor(
        () => rig.stderr().includes("no primary reachable; retrying"),
        40,
        250,
      );

      // A restarted primary writes a fresh token and rebinds the socket path
      // (unlink first on non-win32, matching startIpcListener()'s own
      // stale-socket handling).
      const newToken = "b".repeat(64);
      writeFileSync(join(rig.dir, ".ipc-token"), newToken + "\n", {
        mode: 0o600,
      });
      if (process.platform !== "win32") {
        rmSync(ipcSocketPath(resolve(rig.dir)), { force: true });
      }
      const primary2 = await startFakePrimary(rig.dir, newToken);
      try {
        expect(
          await waitFor(
            () => {
              const matches = rig
                .stderr()
                .split("ipc: connected to primary").length;
              return matches - 1 >= 2; // second occurrence = the reconnect
            },
            20,
            250,
          ),
        ).toBe(true);

        const before = rig.stdout().length;
        const callId = callTool(rig, "unreplied");
        await waitFor(() => rig.stdout().includes(`"id":${callId}`), 20, 250);
        expect(rig.stdout().slice(before)).toContain("relayed:unreplied");
      } finally {
        primary2.close();
      }
    } finally {
      rig.child.kill();
      try {
        rig.primary.close();
      } catch {}
    }
  }, 60_000);

  test("reconnect then an immediate second flap does not duplicate the retry chain (regression)", async () => {
    // Review issue: `retrying` (a boolean) is the only guard on either timer
    // chain. A successful reconnect resets it to false but does NOT cancel
    // the lock-retry setTimeout that startRetryLoop() already armed for the
    // FIRST degrade — that timer is still pending, with 0-3s left to run. If
    // the relay dies again inside that window, the second startRetryLoop()
    // sets `retrying` back to true and arms a second chain while the first
    // chain's stale lock timer is still alive; when that stale timer fires
    // it sees `retrying === true` and re-arms ITSELF instead of finding its
    // generation stale — two live lock-retry chains now poll the lock
    // independently forever (the winning-becomePrimary() path is still
    // serialized by `retrying`, so this does NOT show up as a double
    // promotion; it shows up as roughly double the lock-probe rate).
    //
    // acquireSingletonLock()'s probe is a synchronous subprocess spawn
    // (server.ts:184-185/224 — PowerShell CIM on Windows, ~1s+ wall time per
    // the review's own measurement on this same platform) that blocks the
    // event loop, so extra concurrent chains are observable as degraded
    // tools/call responsiveness: this rig's lock (owned by this live test
    // process) is permanently unwinnable, so every probe is wasted work that
    // can only ever add latency, never resolve. Force a flap inside the
    // first chain's stale lock-retry window (close the second primary
    // immediately after the reconnect is observed, no interleaving work),
    // then hammer tools/call round trips over a fixed window and sum the
    // round-trip times: one live chain blocks the loop for ~1 probe per 3s;
    // two concurrent chains roughly double that.
    const rig = await startSecondaryRig("wa-promo-flap-");
    try {
      rig.primary.close();
      await waitFor(
        () => rig.stderr().includes("no primary reachable; retrying"),
        40,
        250,
      );

      const newToken = "b".repeat(64);
      writeFileSync(join(rig.dir, ".ipc-token"), newToken + "\n", {
        mode: 0o600,
      });
      if (process.platform !== "win32") {
        rmSync(ipcSocketPath(resolve(rig.dir)), { force: true });
      }
      const primary2 = await startFakePrimary(rig.dir, newToken);
      try {
        await waitFor(
          () => {
            const matches = rig
              .stderr()
              .split("ipc: connected to primary").length;
            return matches - 1 >= 2;
          },
          20,
          250,
        );

        // Second flap, as close behind the reconnect as this process can
        // manage — well inside the first chain's stale lock-retry window
        // (up to 3s remaining at the moment of reconnect).
        primary2.close();
      } finally {
        try {
          primary2.close();
        } catch {}
      }

      await waitFor(
        () =>
          rig.stderr().split("no primary reachable; retrying").length - 1 >= 2,
        40,
        250,
      );

      // Hammer tools/call round trips for ~9s (three nominal 3s lock-retry
      // ticks) and sum the round-trip latencies. The lock stays unwinnable
      // the whole time (this test process never releases it), so every
      // response is the instant degraded-stub path (server.ts's
      // `if (degraded()) return {...}` — no socket I/O) UNLESS the event
      // loop is busy inside a synchronous acquireSingletonLock() probe.
      const roundTrips: number[] = [];
      const windowEnd = Date.now() + 9_000;
      while (Date.now() < windowEnd) {
        const sentAt = Date.now();
        const callId = callTool(rig, "unreplied");
        const marker = `"id":${callId}`;
        await waitFor(() => rig.stdout().includes(marker), 40, 100);
        roundTrips.push(Date.now() - sentAt);
        await sleep(150);
      }
      const totalWaitMs = roundTrips.reduce((a, b) => a + b, 0);

      // One live chain: ~3 probes in 9s, each ~1-1.5s on this platform, so
      // total blocked time is roughly 3-4.5s. Two concurrent chains fire
      // roughly twice as often, pushing this well past 6s. 5.5s sits
      // between the two and gives the single-chain case real margin.
      expect(totalWaitMs).toBeLessThan(5_500);
    } finally {
      rig.child.kill();
      try {
        rig.primary.close();
      } catch {}
    }
  }, 60_000);

  test("promotes when the lock frees (3s tier)", async () => {
    const rig = await startSecondaryRig("wa-promo-promote-");
    try {
      const tokenBefore = readFileSync(join(rig.dir, ".ipc-token"), "utf8");

      rig.primary.close();
      // What releaseSingletonLock() does on a clean exit — frees the lock
      // this test process is holding, so the child's queueLockRetry() tick
      // (every 3s) can win it.
      rmSync(join(rig.dir, ".server.lock"), { force: true });

      expect(
        await waitFor(
          () =>
            rig
              .stderr()
              .includes("won the singleton lock; promoting to primary"),
          60,
          250,
        ),
      ).toBe(true);

      // .server.lock existing again with the child's pid proves promotion
      // ran acquireSingletonLock() and won.
      expect(
        await waitFor(
          () => {
            try {
              const content = readFileSync(
                join(rig.dir, ".server.lock"),
                "utf8",
              );
              return content.split("\n")[0].trim() === String(rig.child.pid);
            } catch {
              return false;
            }
          },
          40,
          250,
        ),
      ).toBe(true);
      const lockContent = readFileSync(join(rig.dir, ".server.lock"), "utf8");
      expect(lockContent.split("\n")[0].trim()).toBe(String(rig.child.pid));

      // .ipc-token changing proves startIpcListener() actually ran as the new
      // primary (its token rewrite lands inside server.listen()'s async
      // success callback, which can trail the "won the singleton lock" log
      // line by more than one synchronous tick — poll instead of a single
      // immediate read). Nothing asserted about Baileys, per spec §7.
      expect(
        await waitFor(
          () => {
            try {
              return (
                readFileSync(join(rig.dir, ".ipc-token"), "utf8") !==
                tokenBefore
              );
            } catch {
              return false;
            }
          },
          40,
          250,
        ),
      ).toBe(true);
      const tokenAfter = readFileSync(join(rig.dir, ".ipc-token"), "utf8");
      expect(tokenAfter).not.toBe(tokenBefore);
    } finally {
      rig.child.kill();
      try {
        rig.primary.close();
      } catch {}
    }
  }, 60_000);
});
