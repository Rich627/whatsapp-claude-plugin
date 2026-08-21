// Local primary<->secondary IPC for multi-terminal sync: only one process
// can ever hold the real WhatsApp connection (Baileys allows one connection
// per auth state - see USAGE.md's "Session conflicts"), so a second
// process ("secondary") relays its tool calls through the one that does
// ("primary") over a local socket/named pipe instead of connecting itself.
//
// This module is pure protocol/framing and connection decisions - no socket
// I/O - so it's unit-testable without a real connection. server.ts owns the
// actual net.Server/net.Socket wiring.

import { createHash } from "node:crypto";
import { posix } from "node:path";

export type IpcMessage =
  | { type: "hello"; token: string }
  | { type: "call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "result"; id: string; result: unknown }
  | { type: "notify"; method: string; params: unknown };

// Windows named pipes live in a fixed, flat namespace (\\.\pipe\<name>), not
// an arbitrary filesystem path - unlike Unix domain sockets, which can just
// be a file inside STATE_DIR the same way LOCK_FILE/ACCESS_FILE already are.
// A short hash of STATE_DIR keeps the pipe name unique per account
// (multi-account setups use a different WHATSAPP_STATE_DIR each) without
// leaking the real path into a global namespace every process on the
// machine can see the name of.
// platform is injectable (defaults to process.platform) so the non-win32
// branch can be asserted on any host the tests happen to run on - this
// repo's CI runs trunk, not bun test, on a fixed OS, and mutating the real
// process.platform is riskier than a plain parameter.
export function ipcSocketPath(
  stateDir: string,
  platform: string = process.platform,
): string {
  if (platform === "win32") {
    const id = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\whatsapp-channel-${id}`;
  }
  // The non-win32 branch is a POSIX path by definition, so don't let the
  // host's separator leak into it.
  return posix.join(stateDir, ".server.sock");
}

export function encode(msg: IpcMessage): string {
  return JSON.stringify(msg) + "\n";
}

const IPC_TYPES = new Set(["hello", "call", "result", "notify"]);

function isIpcMessage(v: unknown): v is IpcMessage {
  return (
    typeof v === "object" &&
    v !== null &&
    IPC_TYPES.has((v as { type?: unknown }).type as string)
  );
}

// A single socket "data" event can deliver a partial message, several
// messages, or both at once - TCP/pipes have no message boundaries of
// their own. This buffers across calls until a full newline-terminated
// line is available, the standard shape for newline-delimited JSON.
export class LineBuffer {
  private buf = "";

  // Malformed lines are skipped, not thrown - one corrupted frame (a
  // truncated write, a version mismatch mid-rollout) must not take the
  // whole connection down for every message after it.
  //
  // Callers must socket.setEncoding("utf8") before piping data in here: a
  // raw Buffer chunk can split a multi-byte character, and per-chunk
  // toString() would mangle it. setEncoding's StringDecoder holds the
  // partial bytes.
  push(chunk: string): IpcMessage[] {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    const out: IpcMessage[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        // ponytail: type-tag check only, not a per-shape validator. A
        // well-formed {"type":"call"} with a missing id/args still gets
        // through; tighten here if a relayed call ever comes from
        // something other than this same module.
        if (isIpcMessage(parsed)) out.push(parsed);
      } catch {
        // Skip - see above.
      }
    }
    return out;
  }
}

// FR4: a Unix-socket FILE outlives the process that bound it, so its mere
// existence proves nothing. server.ts probes it with a real connect and
// passes the outcome here; this decides whether the path is safe to unlink
// and rebind. Pure, so the decision table is unit-testable without a socket.
export type SocketProbe = { connected: boolean; code?: string };

export function isStaleSocket(probe: SocketProbe): boolean {
  if (probe.connected) return false; // someone is listening — never unlink
  // ECONNREFUSED: the file exists, nobody is accepting — the crashed-primary
  // leftover FR4 is about. ENOENT: it vanished between our existsSync and
  // the connect; binding is fine.
  return probe.code === "ECONNREFUSED" || probe.code === "ENOENT";
}
