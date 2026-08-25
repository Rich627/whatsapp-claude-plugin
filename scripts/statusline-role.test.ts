import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ancestorChain,
  findServerPid,
  findServerPidForTerminal,
  formatSegment,
  roleFromOwnerStamp,
  type ProcRow,
} from "./statusline-role";

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

  // The stamped path, end to end through the real script: no wrapper and no
  // server process exist here at all, so this can only pass by reading the
  // owner pid out of the file. The decoy is a second terminal's server, which
  // the process tree alone would have no way to rule out.
  test("reads the stamped owner instead of hunting the process tree", () => {
    const dir = freshStateDir();
    writeFileSync(join(dir, ".role-4242"), `secondary\n${process.pid}\n`);
    writeFileSync(join(dir, ".role-4243"), "primary\n999999\n");
    const out = runStatusline(
      dir,
      process.pid,
      "no-such-wrapper",
      "no-such-server",
    );
    expect(out).toContain("WA:secondary");
    expect(out).not.toContain("primary");
  });

  // Same fixture minus the stamp: nothing matches, and with no wrapper or
  // server process to fall back to the script stays silent rather than
  // picking the only file it can see.
  test("stays silent when the only files belong to someone else", () => {
    const dir = freshStateDir();
    writeFileSync(join(dir, ".role-4243"), "primary\n999999\n");
    expect(
      runStatusline(dir, process.pid, "no-such-wrapper", "no-such-server"),
    ).toBe("");
  });

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

// Issue #3. Every fixture above hands findServerPid the CLI pid directly,
// which is why they all passed while the segment never rendered on a real
// machine: a statusLine setting is a compound command, so the script runs
// under a shell that is the wrapper's SIBLING, and a downward search from
// there can never reach it.
describe("findServerPidForTerminal", () => {
  // claude.exe(100) ├── wrapper(200) ── server(300)
  //                 └── statusline shell(400)   <- process.ppid
  const siblingShell: ProcRow[] = [
    { pid: 100, ppid: 1, command: "claude.exe" },
    {
      pid: 200,
      ppid: 100,
      command: "bun run --cwd plugin/whatsapp-claude-channel/0.1 start",
    },
    { pid: 300, ppid: 200, command: "bun.exe server.ts" },
    { pid: 400, ppid: 100, command: "sh -c statusline-command.sh && bun ..." },
  ];

  test("finds the server when it starts at a SIBLING of the wrapper", () => {
    // The regression: searching down from 400 alone returns null.
    expect(
      findServerPid(siblingShell, 400, "whatsapp-claude-channel", "server.ts"),
    ).toBeNull();
    expect(
      findServerPidForTerminal(
        siblingShell,
        400,
        "whatsapp-claude-channel",
        "server.ts",
      ),
    ).toBe(300);
  });

  // Regression: the documented statusLine command is
  // `... && bun <plugin-dir>/scripts/statusline-role.ts`, and <plugin-dir>
  // ends in the plugin name — so the shell's OWN command line contains the
  // wrapper pattern, at the same BFS depth as the real wrapper. A
  // first-match-wins search picks whichever row the OS listed first, and
  // Win32_Process rows are not pid-ordered, so the segment blanked out
  // unpredictably. Both orderings must resolve to the real server.
  //
  // The fixture above dodges this by giving its shell a command with no
  // plugin path in it, which is why 295 passing tests never caught it.
  const realWiring = (shellFirst: boolean): ProcRow[] => {
    const plugin = "plugins/cache/wa/whatsapp-channel/0.21.0";
    const cli: ProcRow = { pid: 100, ppid: 1, command: "claude.exe" };
    const shell: ProcRow = {
      pid: 400,
      ppid: 100,
      command: `sh -c "statusline.sh && bun ${plugin}/scripts/statusline-role.ts"`,
    };
    const wrapper: ProcRow = {
      pid: 200,
      ppid: 100,
      command: `bun run --cwd ${plugin} start`,
    };
    const server: ProcRow = { pid: 300, ppid: 200, command: "bun server.ts" };
    return shellFirst
      ? [cli, shell, wrapper, server]
      : [cli, wrapper, server, shell];
  };

  test("ignores a decoy carrying the plugin name, whichever order it is listed in", () => {
    for (const shellFirst of [true, false]) {
      expect(
        findServerPidForTerminal(
          realWiring(shellFirst),
          400,
          "whatsapp-channel",
          "server.ts",
        ),
      ).toBe(300);
    }
  });

  test("still works when started at the CLI itself, no climb needed", () => {
    expect(
      findServerPidForTerminal(
        siblingShell,
        100,
        "whatsapp-claude-channel",
        "server.ts",
      ),
    ).toBe(300);
  });

  test("climbs through an extra shell hop", () => {
    const nested: ProcRow[] = [
      ...siblingShell,
      { pid: 500, ppid: 400, command: "bun statusline-role.ts" },
    ];
    expect(
      findServerPidForTerminal(
        nested,
        500,
        "whatsapp-claude-channel",
        "server.ts",
      ),
    ).toBe(300);
  });

  // The climb is bounded on purpose: with two terminals there are two CLIs,
  // each with its own wrapper, and climbing far enough to reach a shared
  // host would show the OTHER terminal's role.
  test("stops climbing at the hop limit rather than reaching further up", () => {
    const deep: ProcRow[] = [
      { pid: 1, ppid: 0, command: "host" },
      {
        pid: 2,
        ppid: 1,
        command: "bun run --cwd plugin/whatsapp-claude-channel/0.1 start",
      },
      { pid: 3, ppid: 2, command: "bun.exe server.ts" },
      { pid: 10, ppid: 1, command: "a" },
      { pid: 11, ppid: 10, command: "b" },
      { pid: 12, ppid: 11, command: "c" },
      { pid: 13, ppid: 12, command: "d" },
      { pid: 14, ppid: 13, command: "statusline" },
    ];
    expect(
      findServerPidForTerminal(
        deep,
        14,
        "whatsapp-claude-channel",
        "server.ts",
        1,
      ),
    ).toBeNull();
  });

  test("nearest ancestor wins, so a sibling terminal's server is not picked", () => {
    const twoTerminals: ProcRow[] = [
      { pid: 1, ppid: 0, command: "terminal host" },
      // Terminal A, further up.
      { pid: 10, ppid: 1, command: "claude.exe A" },
      {
        pid: 11,
        ppid: 10,
        command: "bun run --cwd plugin/whatsapp-claude-channel/0.1 start",
      },
      { pid: 12, ppid: 11, command: "bun.exe server.ts" },
      // Terminal B, ours.
      { pid: 20, ppid: 1, command: "claude.exe B" },
      {
        pid: 21,
        ppid: 20,
        command: "bun run --cwd plugin/whatsapp-claude-channel/0.1 start",
      },
      { pid: 22, ppid: 21, command: "bun.exe server.ts" },
      { pid: 23, ppid: 20, command: "sh -c statusline" },
    ];
    expect(
      findServerPidForTerminal(
        twoTerminals,
        23,
        "whatsapp-claude-channel",
        "server.ts",
      ),
    ).toBe(22);
  });

  test("a self-parenting row or a pid 0 parent terminates instead of spinning", () => {
    // Both shapes turn up in real Win32_Process output.
    const loop: ProcRow[] = [
      { pid: 7, ppid: 7, command: "self-parenting" },
      { pid: 8, ppid: 0, command: "orphan" },
    ];
    expect(
      findServerPidForTerminal(loop, 7, "whatsapp-claude-channel", "server.ts"),
    ).toBeNull();
    expect(
      findServerPidForTerminal(loop, 8, "whatsapp-claude-channel", "server.ts"),
    ).toBeNull();
  });

  test("returns null when nothing in the chain owns a wrapper", () => {
    const none: ProcRow[] = [
      { pid: 100, ppid: 1, command: "claude.exe" },
      { pid: 400, ppid: 100, command: "sh -c statusline" },
    ];
    expect(
      findServerPidForTerminal(
        none,
        400,
        "whatsapp-claude-channel",
        "server.ts",
      ),
    ).toBeNull();
  });
});

describe("roleFromOwnerStamp", () => {
  // The whole point: two terminals, two servers, and the only thing telling
  // them apart is which session each server says it belongs to. The process
  // tree cannot decide this once a shared ancestor is in range.
  const files = ["primary\n100\n", "secondary\n200\n"];

  test("takes the file stamped with one of our own ancestors", () => {
    expect(roleFromOwnerStamp(files, [400, 300, 200])).toBe("secondary");
    expect(roleFromOwnerStamp(files, [900, 100])).toBe("primary");
  });

  test("a sibling terminal's server is never ours", () => {
    expect(roleFromOwnerStamp(files, [700, 800])).toBeNull();
  });

  test("nearest ancestor wins when a session runs inside another", () => {
    expect(roleFromOwnerStamp(files, [200, 100])).toBe("secondary");
  });

  // A dead pid is nobody's ancestor, so a leftover file from a crashed
  // session drops out with no liveness check of its own.
  test("stale files from dead sessions cannot match", () => {
    expect(roleFromOwnerStamp(["primary\n999999\n"], [1, 2])).toBeNull();
  });

  // Pre-stamp servers write the bare role with no line 2. Unusable here on
  // purpose - main() falls back to the tree search for exactly this case.
  test("ignores an unstamped file rather than guessing it is ours", () => {
    expect(roleFromOwnerStamp(["primary"], [100])).toBeNull();
    expect(roleFromOwnerStamp(["primary\nnot-a-pid\n"], [100])).toBeNull();
    expect(roleFromOwnerStamp([""], [100])).toBeNull();
  });
});

describe("ancestorChain", () => {
  const rows: ProcRow[] = [
    { pid: 10, ppid: 1, command: "host" },
    { pid: 20, ppid: 10, command: "claude" },
    { pid: 30, ppid: 20, command: "shell" },
  ];

  test("lists self then parents, nearest first", () => {
    expect(ancestorChain(rows, 30)).toEqual([30, 20, 10, 1]);
  });

  test("stops at the hop bound", () => {
    expect(ancestorChain(rows, 30, 1)).toEqual([30, 20]);
  });

  test("stops at a pid that is not in the table", () => {
    expect(ancestorChain(rows, 999)).toEqual([999]);
  });
});
