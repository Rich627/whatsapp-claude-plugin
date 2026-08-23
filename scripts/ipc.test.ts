import { describe, expect, test } from "bun:test";
import {
  encode,
  IPC_HELLO_ID,
  ipcSocketPath,
  isStaleSocket,
  LineBuffer,
  PendingCalls,
  type IpcMessage,
} from "./ipc";

describe("ipcSocketPath", () => {
  test("windows branch returns the exact pipe path", () => {
    // Pinned on purpose: `bun -e "import {createHash} from 'node:crypto';
    // console.log(createHash('sha256').update('/tmp/wa-ipc').digest('hex').slice(0,16))"`
    // -> 04ea0cf9d059adcf. Re-hashing here would assert the implementation
    // against itself and miss the algorithm changing.
    expect(ipcSocketPath("/tmp/wa-ipc", "win32")).toBe(
      "\\\\.\\pipe\\whatsapp-channel-04ea0cf9d059adcf",
    );
  });

  test("windows name is deterministic for the same stateDir", () => {
    expect(ipcSocketPath("/tmp/wa-ipc", "win32")).toBe(
      ipcSocketPath("/tmp/wa-ipc", "win32"),
    );
  });

  test("a different stateDir gives a different pipe name", () => {
    expect(ipcSocketPath("/tmp/wa-ipc-a", "win32")).not.toBe(
      ipcSocketPath("/tmp/wa-ipc-b", "win32"),
    );
  });

  test("windows name shape has no leaked path separators", () => {
    const path = ipcSocketPath("C:\\Users\\a b\\.whatsapp-channel", "win32");
    expect(path).toMatch(/^\\\\\.\\pipe\\whatsapp-channel-[0-9a-f]{16}$/);
  });

  test("unix branch returns <stateDir>/.server.sock exactly", () => {
    expect(ipcSocketPath("/home/u/.whatsapp-channel", "linux")).toBe(
      "/home/u/.whatsapp-channel/.server.sock",
    );
  });

  test("darwin takes the same branch as linux", () => {
    expect(ipcSocketPath("/home/u/.whatsapp-channel", "darwin")).toBe(
      "/home/u/.whatsapp-channel/.server.sock",
    );
  });

  test("a trailing separator in stateDir does not double up", () => {
    expect(ipcSocketPath("/home/u/dir/", "linux")).toBe(
      "/home/u/dir/.server.sock",
    );
  });
});

describe("encode", () => {
  const hello: IpcMessage = { type: "hello", token: "deadbeef" };
  const call: IpcMessage = {
    type: "call",
    id: "1",
    name: "sendMessage",
    args: { chatId: "abc" },
  };
  const result: IpcMessage = { type: "result", id: "1", result: { ok: true } };
  const notify: IpcMessage = {
    type: "notify",
    method: "status",
    params: { connected: true },
  };

  test("round-trips for each of the four message types", () => {
    for (const msg of [hello, call, result, notify]) {
      expect(JSON.parse(encode(msg))).toEqual(msg);
    }
  });

  test("ends with exactly one newline", () => {
    const encoded = encode(call);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.slice(0, -1).includes("\n")).toBe(false);
  });

  test("a newline inside a payload does not break framing", () => {
    const msg: IpcMessage = {
      type: "notify",
      method: "status",
      params: { text: "line1\nline2 caf\u00e9 \uD83D\uDE00" },
    };
    const buf = new LineBuffer();
    const out = buf.push(encode(msg));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(msg);
  });
});

describe("LineBuffer", () => {
  const msg: IpcMessage = { type: "notify", method: "ping", params: null };
  const a: IpcMessage = { type: "notify", method: "a", params: null };
  const b: IpcMessage = { type: "notify", method: "b", params: null };

  test("one full line in one push yields one message", () => {
    const buf = new LineBuffer();
    expect(buf.push(encode(msg))).toEqual([msg]);
  });

  test("a message split across two pushes yields nothing then the message", () => {
    const buf = new LineBuffer();
    const encoded = encode(msg);
    const k = Math.floor(encoded.indexOf("\n") / 2);
    expect(buf.push(encoded.slice(0, k))).toHaveLength(0);
    expect(buf.push(encoded.slice(k))).toEqual([msg]);
  });

  test("two messages in one chunk are returned in order", () => {
    const buf = new LineBuffer();
    expect(buf.push(encode(a) + encode(b))).toEqual([a, b]);
  });

  test("a malformed line is skipped and does not poison what follows", () => {
    const buf = new LineBuffer();
    expect(buf.push("{not json\n" + encode(msg))).toEqual([msg]);
    expect(buf.push(encode(a))).toEqual([a]);
  });

  test("empty and whitespace-only lines are skipped silently", () => {
    const buf = new LineBuffer();
    expect(buf.push("\n   \n\t\n" + encode(msg))).toEqual([msg]);
  });

  test("valid JSON that is not an IpcMessage is skipped", () => {
    const buf = new LineBuffer();
    expect(buf.push('null\n42\n"hi"\n{"foo":1}\n' + encode(msg))).toEqual([
      msg,
    ]);
  });

  test("partial trailing data is retained, not emitted", () => {
    const buf = new LineBuffer();
    const encodedB = encode(b);
    const k = Math.floor(encodedB.indexOf("\n") / 2);
    expect(buf.push(encode(a) + encodedB.slice(0, k))).toEqual([a]);
    expect(buf.push(encodedB.slice(k))).toEqual([b]);
  });

  test("a hello line is recognized and returned", () => {
    const buf = new LineBuffer();
    const hello: IpcMessage = { type: "hello", token: "deadbeef" };
    expect(buf.push(encode(hello))).toEqual([hello]);
  });
});

describe("isStaleSocket", () => {
  test("connected -> false", () => {
    expect(isStaleSocket({ connected: true })).toBe(false);
  });

  test("ECONNREFUSED -> true", () => {
    expect(isStaleSocket({ connected: false, code: "ECONNREFUSED" })).toBe(
      true,
    );
  });

  test("ENOENT -> true", () => {
    expect(isStaleSocket({ connected: false, code: "ENOENT" })).toBe(true);
  });

  test("EACCES -> false (fail closed)", () => {
    expect(isStaleSocket({ connected: false, code: "EACCES" })).toBe(false);
  });

  test("ETIMEDOUT -> false (fail closed)", () => {
    expect(isStaleSocket({ connected: false, code: "ETIMEDOUT" })).toBe(false);
  });

  test("no code -> false (fail closed)", () => {
    expect(isStaleSocket({ connected: false })).toBe(false);
  });
});

describe("PendingCalls", () => {
  test("settle with the matching id resolves that call's promise with the exact value", async () => {
    const pc = new PendingCalls();
    const { id, result } = pc.create();
    expect(pc.settle(id, { ok: true, n: 42 })).toBe(true);
    expect(await result).toEqual({ ok: true, n: 42 });
  });

  test("two concurrent calls get different ids; settling the second resolves only the second", async () => {
    const pc = new PendingCalls();
    const first = pc.create();
    const second = pc.create();
    expect(first.id).not.toBe(second.id);
    expect(pc.settle(second.id, "second")).toBe(true);
    expect(await second.result).toBe("second");
    expect(pc.size).toBe(1);
    first.result.catch(() => {}); // still pending; observed to avoid an unhandled rejection at test end
  });

  test("settle with an id that was never issued returns false and throws nothing", () => {
    const pc = new PendingCalls();
    expect(pc.settle("999", "whatever")).toBe(false);
  });

  test("a second settle for an already-settled id returns false and does not double-resolve", async () => {
    const pc = new PendingCalls();
    const { id, result } = pc.create();
    expect(pc.settle(id, "first")).toBe(true);
    expect(await result).toBe("first");
    expect(pc.settle(id, "second")).toBe(false);
    expect(await result).toBe("first");
  });

  test("failAll rejects an in-flight call with the given error and leaves size 0", async () => {
    const pc = new PendingCalls();
    const { id, result } = pc.create();
    // Reject before attaching the matcher, not after: bun:test 1.3.14 hangs
    // when `expect(pendingPromise).rejects` is attached to a promise that is
    // still pending and only settles afterward (confirmed in isolation,
    // unrelated to PendingCalls itself - a bare captured-resolver Promise
    // reproduces it too). Rejecting first sidesteps it with no change in
    // what's asserted.
    pc.failAll(new Error("connection closed"));
    await expect(result).rejects.toThrow("connection closed");
    expect(pc.size).toBe(0);
    void id;
  });

  test("settle after failAll for that same id returns false", () => {
    const pc = new PendingCalls();
    const { id, result } = pc.create();
    result.catch(() => {});
    pc.failAll(new Error("gone"));
    expect(pc.settle(id, "too late")).toBe(false);
  });

  test("ids never collide with IPC_HELLO_ID", () => {
    const pc = new PendingCalls();
    for (let i = 0; i < 5; i++) {
      const { id, result } = pc.create();
      result.catch(() => {});
      expect(id).not.toBe(IPC_HELLO_ID);
    }
  });
});
