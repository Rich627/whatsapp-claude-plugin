import { describe, expect, test } from "bun:test";
import { encode, ipcSocketPath, LineBuffer, type IpcMessage } from "./ipc";

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

  test("round-trips for each of the three message types", () => {
    for (const msg of [call, result, notify]) {
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
});
