import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findServerPid, formatSegment, type ProcRow } from "./statusline-role";

describe("findServerPid", () => {
  test("matches the real CLI -> plugin wrapper -> server.ts chain", () => {
    const chain: ProcRow[] = [
      { pid: 100, ppid: 1, command: "unrelated" },
      {
        pid: 200,
        ppid: 100,
        command: "bun run --cwd plugin/whatsapp-channel/0.1 start",
      }, // wrapper
      { pid: 300, ppid: 200, command: "bun.exe server.ts" }, // real server
    ];
    expect(findServerPid(chain, 100, "whatsapp-channel", "server.ts")).toBe(
      300,
    );
  });

  test("returns null when no wrapper matches", () => {
    const chain: ProcRow[] = [
      { pid: 200, ppid: 100, command: "some other plugin start" },
      { pid: 300, ppid: 200, command: "bun.exe server.ts" },
    ];
    expect(
      findServerPid(chain, 100, "whatsapp-channel", "server.ts"),
    ).toBeNull();
  });

  test("returns null when the wrapper has no server.ts child", () => {
    const chain: ProcRow[] = [
      { pid: 200, ppid: 100, command: "whatsapp-channel wrapper" },
      { pid: 300, ppid: 200, command: "unrelated child" },
    ];
    expect(
      findServerPid(chain, 100, "whatsapp-channel", "server.ts"),
    ).toBeNull();
  });

  // Regression test for the real bug this design replaced: matching
  // "server.ts" against the whole process tree picks whichever process
  // happens first, even one from a completely different plugin's chain.
  // Scoping the server search to the already-identified wrapper's own
  // children is what makes this deterministic.
  test("does not pick a server.ts process from an unrelated wrapper", () => {
    const rows: ProcRow[] = [
      { pid: 900, ppid: 1, command: "some-other-plugin wrapper" },
      { pid: 901, ppid: 900, command: "bun.exe server.ts" }, // decoy, found first
      { pid: 200, ppid: 100, command: "whatsapp-channel wrapper" },
      { pid: 300, ppid: 200, command: "bun.exe server.ts" }, // the real one
    ];
    expect(findServerPid(rows, 100, "whatsapp-channel", "server.ts")).toBe(300);
  });
});

describe("formatSegment", () => {
  test("known roles get their ANSI color", () => {
    expect(formatSegment("primary")).toBe("\x1b[32mWA:primary\x1b[0m");
    expect(formatSegment("secondary")).toBe("\x1b[36mWA:secondary\x1b[0m");
    expect(formatSegment("reconnecting")).toBe(
      "\x1b[33mWA:reconnecting\x1b[0m",
    );
  });

  test("an unknown or empty role renders nothing", () => {
    expect(formatSegment("")).toBe("");
    expect(formatSegment("garbage")).toBe("");
  });
});

describe("end-to-end (real processes)", () => {
  const SCRIPT = join(import.meta.dir, "statusline-role.ts");

  function freshStateDir(): string {
    return mkdtempSync(join(tmpdir(), "statusline-fixture-"));
  }

  function runStatusline(
    stateDir: string,
    parentPid: number,
    wrapperMarker: string,
    serverMarker: string,
  ): string {
    return execFileSync("bun", [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        WHATSAPP_STATE_DIR: stateDir,
        WA_STATUSLINE_PARENT_PID: String(parentPid),
        WA_STATUSLINE_WRAPPER_MATCH: wrapperMarker,
        WA_STATUSLINE_MATCH: serverMarker,
      },
    });
  }

  // Spawns a real two-hop process chain (this test -> "wrapper" -> "server")
  // mirroring the real CLI -> plugin wrapper -> server.ts topology, and
  // proves the script walks both real hops, not just a direct child.
  test("walks a real two-hop wrapper -> server chain", async () => {
    const wrapperMarker = `WA_WRAPPER_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const serverMarker = `WA_SERVER_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const wrapper = spawn(
      "bun",
      [
        "-e",
        `/*${wrapperMarker}*/
        const c = require("node:child_process").spawn("bun", ["-e", "/*${serverMarker}*/ setTimeout(() => {}, 30000)"], { stdio: "ignore" });
        console.log("CHILD_PID=" + c.pid);
        setTimeout(() => {}, 30000);`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let serverPid = -1;
    try {
      serverPid = await new Promise<number>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(
          () => reject(new Error("wrapper never reported its child pid")),
          10000,
        );
        wrapper.stdout!.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const m = buf.match(/CHILD_PID=(\d+)/);
          if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          }
        });
      });

      const stateDir = freshStateDir();
      writeFileSync(join(stateDir, `.role-${serverPid}`), "secondary");

      // The wrapper's real parent is this test process.
      const out = runStatusline(
        stateDir,
        process.pid,
        wrapperMarker,
        serverMarker,
      );
      expect(out).toBe(formatSegment("secondary"));
    } finally {
      wrapper.kill();
      if (serverPid > 0) {
        try {
          process.kill(serverPid);
        } catch {}
      }
    }
  });

  test("prints nothing when no matching wrapper exists", () => {
    const stateDir = freshStateDir();
    const out = runStatusline(
      stateDir,
      process.pid,
      "no-such-wrapper-marker",
      "server.ts",
    );
    expect(out).toBe("");
  });
});
