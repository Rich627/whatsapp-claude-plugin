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
        // Type-tag check only, not a per-shape validator. A
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

// A Unix-socket FILE outlives the process that bound it, so its mere
// existence proves nothing. server.ts probes it with a real connect and
// passes the outcome here; this decides whether the path is safe to unlink
// and rebind. Pure, so the decision table is unit-testable without a socket.
export type SocketProbe = { connected: boolean; code?: string };

export function isStaleSocket(probe: SocketProbe): boolean {
  if (probe.connected) return false; // someone is listening — never unlink
  // ECONNREFUSED: the file exists, nobody is accepting — a crashed-primary
  // leftover. ENOENT: it vanished between our existsSync and
  // the connect; binding is fine.
  return probe.code === "ECONNREFUSED" || probe.code === "ENOENT";
}

// The primary answers a valid hello with {"type":"result","id":IPC_HELLO_ID}
// before any relayed call is answered. Without it a secondary cannot tell
// "accepted" from "about to be destroyed for a bad token": server.ts's drop()
// destroys the socket asynchronously, so a call written immediately after a
// rejected hello is silently lost. Reusing `result` keeps the protocol at
// four shapes; echoing the hello back instead would put the shared secret on
// the wire a second time for no gain. Call ids are decimal counters
// (PendingCalls), so none of them can ever collide with this.
export const IPC_HELLO_ID = "hello";

// Correlates a relayed call with the primary's eventual result. Pure: the
// caller owns the socket and hands the id/result pairs in as they arrive.
// No per-call timeout - close/error is the liveness signal. Add
// one only if a real hang shows up.
export class PendingCalls {
  private seq = 0;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  // A call id only has to be unique for the life of one connection - it never
  // leaves the local socket and is never used for anything security-relevant,
  // so a counter beats randomBytes here (unlike the token in server.ts).
  create(): { id: string; result: Promise<unknown> } {
    const id = String(++this.seq);
    let entry!: { resolve: (v: unknown) => void; reject: (e: Error) => void };
    const result = new Promise<unknown>((resolve, reject) => {
      entry = { resolve, reject };
    });
    this.pending.set(id, entry);
    return { id, result };
  }

  // Returns false for an id that was never issued or was already settled -
  // a duplicate or bogus result must be ignorable, never a throw and never a
  // double-resolve.
  settle(id: string, result: unknown): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.resolve(result);
    return true;
  }

  // The connection died: every in-flight call rejects with the same reason,
  // and the tracker is left empty.
  failAll(err: Error): void {
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}
