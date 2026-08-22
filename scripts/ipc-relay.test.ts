import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownStartTime, sleep, startFakePrimary } from "./ipc-test-helpers";

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
