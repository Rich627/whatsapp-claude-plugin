import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { encryptedStream, type WAMessage } from "@whiskeysockets/baileys";
import { downloadInboundMedia, mediaUrl } from "./inbound-media";

const CONTENT = Buffer.from("synthetic attachment");
async function fixture(type = "image") {
  // Exercise the upstream encoder, independently of the downloader's crypto.
  const encoded = await encryptedStream(CONTENT, type as "image", {});
  let bytes: Buffer;
  try {
    bytes = readFileSync(encoded.encFilePath);
  } finally {
    rmSync(encoded.encFilePath, { force: true });
  }
  const message = {
    key: { remoteJid: "15550000001@s.whatsapp.net", id: "fixture" },
    message: {
      [type + "Message"]: {
        url: "https://mmg.whatsapp.net/media",
        mediaKey: encoded.mediaKey,
      },
    },
  } as WAMessage;
  return { bytes, message };
}

describe("inbound media boundary", () => {
  for (const url of [
    "http://mmg.whatsapp.net/media",
    "http://127.0.0.1/admin",
    "https://127.0.0.1/admin",
    "file:///etc/passwd",
    "https://mmg.whatsapp.net.evil.example/media",
    "https://evilwhatsapp.net/media",
    "https://user:pass@mmg.whatsapp.net/media",
    "https://mmg.whatsapp.net:8443/media",
    "data:text/plain,fixture",
  ])
    test(`refuses ${url} before fetching`, async () => {
      const { message } = await fixture();
      message.message!.imageMessage!.url = url;
      let fetched = false;
      await expect(
        downloadInboundMedia(message, {
          fetch: async () => {
            fetched = true;
            return new Response();
          },
        }),
      ).rejects.toThrow();
      expect(fetched).toBe(false);
    });

  test("validates the host even with directPath, and rejects host-changing paths", () => {
    expect(() => mediaUrl("https://evil.example/a", "/b")).toThrow();
    for (const path of [
      "//evil.example/a",
      "/\\evil.example/a",
      "https://evil.example",
      "/a\nb",
    ])
      expect(() => mediaUrl(undefined, path)).toThrow();
    expect(mediaUrl(undefined, "/v/file?token=fixture").href).toBe(
      "https://mmg.whatsapp.net/v/file?token=fixture",
    );
    expect(mediaUrl("https://media.xx.fbcdn.net/old", "/new").href).toBe(
      "https://media.xx.fbcdn.net/new",
    );
  });

  for (const type of ["image", "audio", "video", "document", "sticker"])
    test(`authenticates and decrypts ${type}`, async () => {
      const { message, bytes } = await fixture(type);
      const result = await downloadInboundMedia(message, {
        fetch: async (_url, init) => {
          expect(init?.redirect).toBe("error");
          expect(new Headers(init?.headers).get("Origin")).toBe(
            "https://web.whatsapp.com",
          );
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return new Response(bytes);
        },
      });
      expect(result).toEqual(CONTENT);
    });

  test("supports wrapped documents", async () => {
    const { message, bytes } = await fixture("document");
    message.message = {
      documentWithCaptionMessage: { message: message.message },
    };
    expect(
      await downloadInboundMedia(message, {
        fetch: async () => new Response(bytes),
      }),
    ).toEqual(CONTENT);
  });

  test("does not follow redirects", async () => {
    const { message } = await fixture();
    await expect(
      downloadInboundMedia(message, {
        fetch: async (_url, init) => {
          expect(init?.redirect).toBe("error");
          return new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/admin" },
          });
        },
      }),
    ).rejects.toThrow("HTTP 302");
  });

  test("rejects tampering before returning plaintext", async () => {
    const { message, bytes } = await fixture();
    bytes[0] ^= 1;
    await expect(
      downloadInboundMedia(message, { fetch: async () => new Response(bytes) }),
    ).rejects.toThrow("authentication failed");
  });

  test("bounds both advertised and streamed sizes and cancels rejected streams", async () => {
    const { message } = await fixture();
    for (const advertised of [true, false]) {
      let cancelled = false;
      const body = new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(100));
        },
        cancel() {
          cancelled = true;
        },
      });
      await expect(
        downloadInboundMedia(message, {
          maxBytes: 32,
          fetch: async () =>
            new Response(body, {
              headers: advertised ? { "content-length": "100" } : {},
            }),
        }),
      ).rejects.toThrow("exceeds");
      expect(cancelled).toBe(true);
    }
  });

  test("timeout remains armed while a response body stalls", async () => {
    const { message } = await fixture();
    const before = Date.now();
    await expect(
      downloadInboundMedia(message, {
        timeoutMs: 25,
        fetch: async (_url, init) => {
          return new Response(
            new ReadableStream({
              start(controller) {
                init!.signal!.addEventListener(
                  "abort",
                  () => controller.error(new Error("aborted")),
                  { once: true },
                );
              },
            }),
          );
        },
      }),
    ).rejects.toThrow("aborted");
    expect(Date.now() - before).toBeLessThan(1000);
  });
});
