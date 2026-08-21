import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encode, IPC_HELLO_ID, ipcSocketPath, LineBuffer } from "./ipc";

// Reviewer finding (.pipeline/review.md): connectToPrimary() calling
// s.unref() on the relay socket wedges startup dead on this runtime, because
// nothing else in the event loop is ref'd until the MCP stdio transport
// connects hundreds of lines later. bun test's existing coverage never opens
// a real socket (scripts/server-conflict.test.ts's fixture has no
// .ipc-token, so readIpcToken() returns null before connect() is ever
// called), so that regression shipped green. This spawns a REAL secondary
// (the actual server.ts, as its own process) against a fake primary that
// speaks the real wire protocol via scripts/ipc.ts's own encode/LineBuffer -
// not a mock of server.ts's logic - and drives the secondary over stdio as a
// real MCP client, the same way scripts/server-conflict.test.ts drives a
// real conflicting server.

const SERVER = join(import.meta.dir, "..", "server.ts");

// Same probe server.ts's acquireSingletonLock() uses, duplicated here exactly
// as scripts/server-conflict.test.ts and scripts/doctor.test.ts already do -
// this repo's established way of naming a live process (this test) as the
// lock holder a spawned server.ts must treat as a real, unbeatable primary.
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

// A fake primary that speaks the real protocol: acks a matching hello, then
// answers every `call` with a recognizable CallToolResult so the test can
// prove the reply actually crossed the socket, round trip. `notifyAfterHello`
// (T04) additionally pushes one unprompted `notify` frame right after the
// hello ack, the same way a real primary broadcasts an inbound message to an
// already-connected secondary - proves the re-emit path without needing a
// second connection or reshaping this fixture for every caller.
function startFakePrimary(
  dir: string,
  token: string,
  notifyAfterHello?: { method: string; params: unknown },
) {
  const path = ipcSocketPath(resolve(dir));
  const srv = createServer((s) => {
    s.setEncoding("utf8");
    const buf = new LineBuffer();
    let authed = false;
    s.on("error", () => s.destroy());
    s.on("data", (chunk: string) => {
      for (const msg of buf.push(chunk)) {
        if (!authed) {
          if (msg.type !== "hello" || msg.token !== token) {
            s.destroy();
            return;
          }
          authed = true;
          s.write(encode({ type: "result", id: IPC_HELLO_ID, result: "ok" }));
          if (notifyAfterHello)
            s.write(encode({ type: "notify", ...notifyAfterHello }));
          continue;
        }
        if (msg.type === "call") {
          s.write(
            encode({
              type: "result",
              id: msg.id,
              result: {
                content: [{ type: "text", text: `relayed:${msg.name}` }],
              },
            }),
          );
        }
      }
    });
  });
  return new Promise<typeof srv>((res) => srv.listen(path, () => res(srv)));
}

describe("ipc relay (secondary)", () => {
  test("a real secondary connects, completes MCP initialize, and relays a tool call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-relay-"));
    const token = "a".repeat(64);
    writeFileSync(join(dir, ".ipc-token"), token + "\n", { mode: 0o600 });
    // Names this test process as the live lock holder - the same trick
    // scripts/server-conflict.test.ts uses - so the spawned server.ts's
    // acquireSingletonLock() finds a genuinely alive "primary" and takes the
    // CONFLICT/secondary path instead of becoming a primary itself.
    writeFileSync(
      join(dir, ".server.lock"),
      `${process.pid}\n${ownStartTime()}\n\n`,
    );

    const primary = await startFakePrimary(dir, token);
    const child = spawn("bun", [SERVER], {
      env: { ...process.env, WHATSAPP_STATE_DIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (stderr += d));

    try {
      // Module load (Baileys import) can take several seconds, same as
      // scripts/server-conflict.test.ts's budget.
      for (
        let i = 0;
        i < 60 && !stderr.includes("ipc: connected to primary");
        i++
      ) {
        await sleep(500);
      }
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
      for (let i = 0; i < 40 && !stdout.includes('"id":1'); i++) {
        await sleep(250);
      }
      expect(stdout).toContain('"id":1');
      // FR1: a relaying secondary must not still advertise the stub warning
      // in its MCP `instructions` (spec §4.5/§0.2).
      expect(stdout).not.toContain("WHATSAPP UNAVAILABLE");

      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }) + "\n",
      );
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "unreplied", arguments: {} },
        }) + "\n",
      );
      for (let i = 0; i < 40 && !stdout.includes('"id":2'); i++) {
        await sleep(250);
      }
      expect(stdout).toContain('"id":2');
      // Proves the call actually crossed the socket to the fake primary and
      // its result came back through handleToolCall's relay branch - not a
      // local stub answer.
      expect(stdout).toContain("relayed:unreplied");
    } finally {
      child.kill();
      primary.close();
    }
  }, 60_000);

  test("a real secondary re-emits a broadcast notify as its own MCP notification (PRD FR2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-relay-notify-"));
    const token = "b".repeat(64);
    writeFileSync(join(dir, ".ipc-token"), token + "\n", { mode: 0o600 });
    writeFileSync(
      join(dir, ".server.lock"),
      `${process.pid}\n${ownStartTime()}\n\n`,
    );

    const notifyParams = {
      content: "hello from primary",
      meta: { chat_id: "1234@s.whatsapp.net", message_id: "abc" },
    };
    const primary = await startFakePrimary(dir, token, {
      method: "notifications/claude/channel",
      params: notifyParams,
    });
    const child = spawn("bun", [SERVER], {
      env: { ...process.env, WHATSAPP_STATE_DIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (stderr += d));

    try {
      for (
        let i = 0;
        i < 60 && !stderr.includes("ipc: connected to primary");
        i++
      ) {
        await sleep(500);
      }
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
      for (let i = 0; i < 40 && !stdout.includes('"id":1'); i++) {
        await sleep(250);
      }
      expect(stdout).toContain('"id":1');

      // The fake primary pushed its `notify` frame right after the hello ack
      // (before `initialize` even completes), so by the time the secondary
      // has surfaced the initialize response it must already have re-emitted
      // the notification as a real JSON-RPC message on its own stdout.
      for (
        let i = 0;
        i < 40 && !stdout.includes("notifications/claude/channel");
        i++
      ) {
        await sleep(250);
      }
      expect(stdout).toContain("notifications/claude/channel");
      expect(stdout).toContain("hello from primary");
      expect(stdout).toContain("1234@s.whatsapp.net");
    } finally {
      child.kill();
      primary.close();
    }
  }, 60_000);
});
