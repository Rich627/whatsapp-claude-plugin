import { execFileSync } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { encode, IPC_HELLO_ID, ipcSocketPath, LineBuffer } from "./ipc";

// Same probe server.ts's acquireSingletonLock() uses, duplicated here exactly
// as scripts/server-conflict.test.ts and scripts/doctor.test.ts already do -
// this repo's established way of naming a live process (this test) as the
// lock holder a spawned server.ts must treat as a real, unbeatable primary.
export function ownStartTime(): string {
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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A fake primary that speaks the real protocol: acks a matching hello, then
// answers every `call` with a recognizable CallToolResult so a test can prove
// the reply actually crossed the socket, round trip. `notifyAfterHello` (T04)
// optionally pushes one unprompted `notify` frame right after the hello ack,
// the same way a real primary broadcasts an inbound message to an
// already-connected secondary. Unlike a plain srv.close() (which only stops
// accepting NEW connections - the existing one to the child stays open until
// something ends it), the returned `close()` also destroys every socket this
// fixture has accepted, so a test can simulate a hard-killed primary dropping
// the child's live connection.
export function startFakePrimary(
  dir: string,
  token: string,
  notifyAfterHello?: { method: string; params: unknown },
): Promise<{ close(): void }> {
  const path = ipcSocketPath(resolve(dir));
  const sockets = new Set<Socket>();
  const srv = createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
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
  return new Promise((res) =>
    srv.listen(path, () =>
      res({
        close() {
          srv.close();
          for (const s of sockets) s.destroy();
        },
      }),
    ),
  );
}
