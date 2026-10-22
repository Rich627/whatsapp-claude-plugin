import { createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";
import {
  getMediaKeys,
  normalizeMessageContent,
  type WAMessage,
} from "@whiskeysockets/baileys";

const MAX_MEDIA = 16 * 1024 * 1024;
// CBC padding plus WhatsApp's ten-byte authentication tag.
const OVERHEAD = 26;

export function mediaUrl(url?: string | null, directPath?: string | null): URL {
  const trusted = (value: string): URL => {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      (parsed.port && parsed.port !== "443") ||
      !["whatsapp.net", "fbcdn.net"].some(
        (domain) =>
          parsed.hostname === domain || parsed.hostname.endsWith("." + domain),
      )
    )
      throw new Error("Untrusted WhatsApp media URL");
    return parsed;
  };
  const base = url ? trusted(url) : new URL("https://mmg.whatsapp.net");
  if (directPath) {
    if (
      !directPath.startsWith("/") ||
      directPath.startsWith("//") ||
      /[\\\x00-\x20]/.test(directPath)
    )
      throw new Error("Invalid WhatsApp media path");
    return trusted(base.origin + directPath);
  }
  if (!url) throw new Error("Missing WhatsApp media URL");
  return base;
}

export class MediaHttpError extends Error {
  constructor(readonly status: number) {
    super(`WhatsApp media download failed (HTTP ${status})`);
  }
}

/** Fetch only Meta CDN bytes, with no redirects, then authenticate before decrypting. */
export async function downloadInboundMedia(
  message: WAMessage,
  options: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<Buffer> {
  const content = normalizeMessageContent(message.message);
  const media =
    content?.imageMessage ??
    content?.audioMessage ??
    content?.videoMessage ??
    content?.documentMessage ??
    content?.stickerMessage;
  const type = content?.imageMessage
    ? "image"
    : content?.audioMessage
      ? "audio"
      : content?.videoMessage
        ? "video"
        : content?.documentMessage
          ? "document"
          : "sticker";
  if (!media || !media.mediaKey || media.mediaKey.length !== 32)
    throw new Error("Invalid WhatsApp media key");
  const url = mediaUrl(media.url, media.directPath);
  const limit = Math.min(options.maxBytes ?? MAX_MEDIA, MAX_MEDIA);
  if (Number(media.fileLength ?? 0) > limit)
    throw new Error("WhatsApp attachment exceeds 16 MB");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15_000,
  );
  try {
    const response = await (options.fetch ?? fetch)(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { Origin: "https://web.whatsapp.com" },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new MediaHttpError(response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty WhatsApp media response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (Number(response.headers.get("content-length")) > limit + OVERHEAD)
        throw new Error("WhatsApp attachment exceeds 16 MB");
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit + OVERHEAD)
          throw new Error("WhatsApp attachment exceeds 16 MB");
        chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const encrypted = Buffer.concat(chunks);
    if (encrypted.length < 26 || (encrypted.length - 10) % 16 !== 0)
      throw new Error("Invalid WhatsApp media ciphertext");
    const keys = await getMediaKeys(media.mediaKey, type);
    if (!keys.macKey)
      throw new Error("Missing WhatsApp media authentication key");
    const ciphertext = encrypted.subarray(0, -10);
    const mac = createHmac("sha256", keys.macKey)
      .update(keys.iv)
      .update(ciphertext)
      .digest()
      .subarray(0, 10);
    if (!timingSafeEqual(mac, encrypted.subarray(-10)))
      throw new Error("WhatsApp media authentication failed");
    const decipher = createDecipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
    const plain = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    if (!plain.length || plain.length > limit)
      throw new Error("Invalid WhatsApp media size");
    return plain;
  } finally {
    clearTimeout(timer);
  }
}
