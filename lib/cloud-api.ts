import { createHmac, timingSafeEqual } from "crypto";
import type {
  WASocket,
  WAMessage,
  WAMessageKey,
} from "@whiskeysockets/baileys";

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

export interface CloudApiConfig {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  apiVersion: string;
  webhookHost: string;
  webhookPort: number;
  webhookPath: string;
}

export function readCloudApiConfig(
  env: Record<string, string | undefined>,
): CloudApiConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (
      !value ||
      value === "undefined" ||
      value === "null" ||
      value.startsWith("${")
    ) {
      throw new Error(`Cloud API requires ${name}`);
    }
    return value;
  };
  const phoneNumberId = required("WHATSAPP_CLOUD_PHONE_NUMBER_ID");
  if (!/^\d+$/.test(phoneNumberId))
    throw new Error("Invalid Cloud API phone number ID");
  const apiVersion = env.WHATSAPP_CLOUD_API_VERSION?.trim() || "v26.0";
  if (!/^v\d+\.\d+$/.test(apiVersion))
    throw new Error("Invalid Cloud API version");
  const webhookPort = Number(env.WHATSAPP_CLOUD_WEBHOOK_PORT ?? "8787");
  if (
    !Number.isInteger(webhookPort) ||
    webhookPort < 1 ||
    webhookPort > 65535
  ) {
    throw new Error("Invalid Cloud API webhook port");
  }
  const webhookHost = env.WHATSAPP_CLOUD_WEBHOOK_HOST?.trim() || "127.0.0.1";
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(webhookHost))
    throw new Error("Invalid Cloud API webhook host");
  const webhookPath = env.WHATSAPP_CLOUD_WEBHOOK_PATH?.trim() || "/webhook";
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(webhookPath))
    throw new Error("Invalid Cloud API webhook path");
  return {
    phoneNumberId,
    accessToken: required("WHATSAPP_CLOUD_ACCESS_TOKEN"),
    appSecret: required("WHATSAPP_CLOUD_APP_SECRET"),
    verifyToken: required("WHATSAPP_CLOUD_VERIFY_TOKEN"),
    apiVersion,
    webhookHost,
    webhookPort,
    webhookPath,
  };
}

export interface CloudReaction {
  key: WAMessageKey;
  reaction: { text: string; key: WAMessageKey };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
interface CloudApiOptions {
  onMessage: (message: WAMessage) => Promise<void>;
  onReaction?: (reaction: CloudReaction) => Promise<void>;
  onError?: (safeMessage: string) => void;
  fetch?: Fetch;
  maxMediaEntries?: number;
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const MAX_BODY = 1024 * 1024;
const MAX_MEDIA = 16 * 1024 * 1024;
const MAX_QUEUE = 1000;
const TIMEOUT_MS = 15_000;

function isJson(value: unknown, depth = 0): value is Json {
  if (depth > 20) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((entry) => isJson(entry, depth + 1));
  const record = object(value);
  return (
    !!record && Object.values(record).every((entry) => isJson(entry, depth + 1))
  );
}

function phoneJid(phone: unknown): string | undefined {
  return typeof phone === "string" && /^\d{5,20}$/.test(phone)
    ? `${phone}@s.whatsapp.net`
    : undefined;
}

function recipient(jid: string): string {
  const match = jid.match(/^(\d{5,20})@s\.whatsapp\.net$/);
  if (!match)
    throw new Error(
      "Cloud API supports phone-number DMs only; groups and LIDs are unavailable",
    );
  return match[1];
}

function imageMime(bytes: Buffer): string {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
    bytes.subarray(0, 6).toString("ascii") === "GIF89a"
  )
    return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  throw new Error(
    "Cloud API image format could not be identified; provide a MIME type",
  );
}

async function readBounded(
  response: Response | Request,
  limit: number,
): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit)
    throw new Error("Payload too large");
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) throw new Error("Payload too large");
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

interface PendingInbound {
  message: WAMessage;
  media?: { id: string; jid: string };
  reaction?: CloudReaction;
}

/** DM transport sharing the existing message/access pipeline, without linked-device auth. */
export class CloudApiSocket {
  user: { id: string; name?: string } | undefined;
  private listener: ReturnType<typeof Bun.serve> | undefined;
  private readonly request: Fetch;
  private readonly seen = new Set<string>();
  private readonly media = new Map<string, { id: string; jid: string }>();
  private readonly queue: PendingInbound[] = [];
  private draining = false;
  private stopped = false;
  private readonly mediaLimit: number;

  constructor(
    private readonly config: CloudApiConfig,
    private readonly options: CloudApiOptions,
  ) {
    this.request = options.fetch ?? ((url, init) => fetch(url, init));
    const limit = options.maxMediaEntries;
    this.mediaLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.min(10000, Math.floor(limit)))
        : 1000;
  }

  private async graph(path: string, init?: RequestInit): Promise<ObjectValue> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${this.config.accessToken}`);
      const response = await this.request(
        `https://graph.facebook.com/${this.config.apiVersion}/${path}`,
        { ...init, headers, redirect: "error", signal: controller.signal },
      );
      const raw = await readBounded(response, MAX_BODY);
      let data: ObjectValue | undefined;
      try {
        data = object(JSON.parse(raw.toString("utf8")));
      } catch {}
      if (!response.ok || !data || data.error) {
        const code = object(data?.error)?.code;
        const detail =
          typeof code === "number" && Number.isFinite(code)
            ? `, code ${code}`
            : "";
        throw new Error(
          `Cloud API request failed (HTTP ${response.status}${detail})`,
        );
      }
      return data;
    } catch (error) {
      if (
        error instanceof Error &&
        /^Cloud API request failed \(HTTP \d+(, code -?\d+)?\)$/.test(
          error.message,
        )
      )
        throw error;
      throw new Error(
        "Cloud API request failed (network, timeout, or invalid response)",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async start(): Promise<void> {
    if (this.listener) return;
    if (this.stopped) throw new Error("Cloud API transport has stopped");
    const identity = await this.graph(
      `${this.config.phoneNumberId}?fields=display_phone_number,verified_name`,
    );
    const displayPhone = string(identity.display_phone_number);
    const id =
      displayPhone && /^[+\d\s().-]+$/.test(displayPhone)
        ? phoneJid(displayPhone.replace(/\D/g, ""))
        : undefined;
    if (!id)
      throw new Error("Cloud API returned no valid business phone number");
    if (this.stopped) throw new Error("Cloud API transport has stopped");
    try {
      this.listener = Bun.serve({
        hostname: this.config.webhookHost,
        port: this.config.webhookPort,
        maxRequestBodySize: MAX_BODY,
        fetch: (request) => this.handleWebhook(request),
        error: () => new Response("Webhook unavailable", { status: 500 }),
      });
    } catch {
      throw new Error("Cloud API webhook listener could not start");
    }
    this.user = {
      id,
      ...(typeof identity.verified_name === "string"
        ? { name: identity.verified_name }
        : {}),
    };
  }

  status() {
    return {
      provider: "cloud-api" as const,
      configured: true,
      listenerReady: !!this.listener,
      webhookHost: this.config.webhookHost,
      webhookPort: this.listener?.port ?? this.config.webhookPort,
      webhookPath: this.config.webhookPath,
      inboundVerified: false,
      capabilities: {
        groups: false,
        mentions: false,
        editMessages: false,
        presence: false,
        templates: true,
      },
    };
  }

  end(_error?: Error): void {
    this.stopped = true;
    this.listener?.stop(true);
    this.listener = undefined;
    this.queue.length = 0;
    this.media.clear();
    this.seen.clear();
    this.user = undefined;
  }

  private async handleWebhook(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== this.config.webhookPath)
      return new Response("Not found", { status: 404 });
    if (request.method === "GET") {
      const token = url.searchParams.get("hub.verify_token") ?? "";
      const supplied = Buffer.from(token);
      const expected = Buffer.from(this.config.verifyToken);
      if (
        url.searchParams.get("hub.mode") !== "subscribe" ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      const challenge = url.searchParams.get("hub.challenge");
      if (!challenge || !/^\d{1,100}$/.test(challenge))
        return new Response("Invalid challenge", { status: 400 });
      return new Response(challenge);
    }
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    const signature = request.headers.get("x-hub-signature-256") ?? "";
    if (!/^sha256=[a-fA-F0-9]{64}$/.test(signature))
      return new Response("Forbidden", { status: 403 });
    let raw: Buffer;
    try {
      raw = await readBounded(request, MAX_BODY);
    } catch {
      return new Response("Payload too large", { status: 413 });
    }
    const expected = createHmac("sha256", this.config.appSecret)
      .update(raw)
      .digest();
    if (!timingSafeEqual(Buffer.from(signature.slice(7), "hex"), expected))
      return new Response("Forbidden", { status: 403 });
    let data: unknown;
    try {
      data = JSON.parse(raw.toString("utf8"));
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const payload = object(data);
    if (payload?.object !== "whatsapp_business_account")
      return new Response("Ignored");
    const pending = this.parseInbound(payload);
    const fresh: PendingInbound[] = [];
    const batchIds = new Set<string>();
    for (const entry of pending) {
      const id = entry.message.key.id!;
      if (this.seen.has(id) || batchIds.has(id)) continue;
      batchIds.add(id);
      fresh.push(entry);
    }
    if (this.stopped)
      return new Response("Webhook unavailable", { status: 503 });
    if (this.queue.length + fresh.length + (this.draining ? 1 : 0) > MAX_QUEUE)
      return new Response("Webhook queue full", { status: 503 });
    for (const entry of fresh) {
      this.seen.add(entry.message.key.id!);
      while (this.seen.size > 1000)
        this.seen.delete(this.seen.values().next().value!);
      if (entry.media) {
        this.media.set(entry.message.key.id!, entry.media);
        while (this.media.size > this.mediaLimit)
          this.media.delete(this.media.keys().next().value!);
      }
      this.queue.push(entry);
    }
    void this.drain();
    return new Response("OK");
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.queue.length) {
        const entry = this.queue.shift()!;
        try {
          if (entry.reaction && this.options.onReaction)
            await this.options.onReaction(entry.reaction);
          else await this.options.onMessage(entry.message);
        } catch {
          try {
            this.options.onError?.("Cloud API inbound handler failed");
          } catch {}
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private parseInbound(payload: ObjectValue): PendingInbound[] {
    const pending: PendingInbound[] = [];
    if (!Array.isArray(payload.entry)) return pending;
    for (const entry of payload.entry) {
      const changes = object(entry)?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        if (object(change)?.field !== "messages") continue;
        const value = object(object(change)?.value);
        if (
          object(value?.metadata)?.phone_number_id !==
            this.config.phoneNumberId ||
          value?.messaging_product !== "whatsapp" ||
          !Array.isArray(value.messages)
        )
          continue;
        for (const raw of value.messages) {
          const message = object(raw);
          const id = string(message?.id);
          const jid = phoneJid(message?.from);
          const stamp = string(message?.timestamp);
          const timestamp =
            stamp && /^\d{1,12}$/.test(stamp) ? Number(stamp) : 0;
          if (!message || !id || id.length > 512 || !jid || timestamp <= 0)
            continue;
          const key: WAMessageKey = { remoteJid: jid, id, fromMe: false };
          const normalized: WAMessage = {
            key,
            messageTimestamp: timestamp,
            message: {},
          };
          if (Array.isArray(value.contacts)) {
            const contact = value.contacts.find(
              (contact) => object(contact)?.wa_id === message.from,
            );
            const name = string(object(object(contact)?.profile)?.name);
            if (name) normalized.pushName = name;
          }
          const contextId = string(object(message.context)?.id);
          const contextInfo = contextId
            ? {
                stanzaId: contextId,
                participant: phoneJid(object(message.context)?.from),
              }
            : undefined;
          const type = string(message.type);
          if (type === "text") {
            const text = string(object(message.text)?.body);
            if (text === undefined) continue;
            normalized.message = {
              extendedTextMessage: {
                text,
                ...(contextInfo ? { contextInfo } : {}),
              },
            };
          } else if (type === "reaction") {
            const reaction = object(message.reaction);
            const targetId = string(reaction?.message_id);
            const text = string(reaction?.emoji);
            if (!targetId || text === undefined) continue;
            const targetKey = { remoteJid: jid, id: targetId, fromMe: true };
            normalized.message = { reactionMessage: { text, key: targetKey } };
            pending.push({
              message: normalized,
              reaction: { key: targetKey, reaction: { text, key } },
            });
            continue;
          } else if (
            type &&
            ["image", "audio", "video", "document", "sticker"].includes(type)
          ) {
            const media = object(message[type]);
            const mediaId = string(media?.id);
            if (!mediaId || !/^\d+$/.test(mediaId)) continue;
            const content = {
              mimetype: string(media?.mime_type),
              caption: string(media?.caption),
              ...(contextInfo ? { contextInfo } : {}),
            };
            if (type === "image")
              normalized.message = { imageMessage: content };
            if (type === "video")
              normalized.message = { videoMessage: content };
            if (type === "document")
              normalized.message = {
                documentMessage: {
                  ...content,
                  fileName: string(media?.filename),
                },
              };
            if (type === "sticker")
              normalized.message = { stickerMessage: content };
            if (type === "audio")
              normalized.message = {
                audioMessage: { ...content, ptt: media?.voice === true },
              };
            pending.push({ message: normalized, media: { id: mediaId, jid } });
            continue;
          } else continue;
          pending.push({ message: normalized });
        }
      }
    }
    return pending;
  }

  async sendMessage(
    jid: Parameters<WASocket["sendMessage"]>[0],
    content: Parameters<WASocket["sendMessage"]>[1],
    options?: Parameters<WASocket["sendMessage"]>[2],
  ): Promise<WAMessage | undefined> {
    if (this.stopped || !this.user)
      throw new Error("Cloud API is not connected");
    const to = recipient(jid);
    if ("edit" in content)
      throw new Error("Cloud API does not support editing messages");
    if ("mentions" in content && content.mentions?.length)
      throw new Error("Cloud API does not support mentions");
    if (options?.quoted?.key?.remoteJid && options.quoted.key.remoteJid !== jid)
      throw new Error("Quote target belongs to another chat");
    let payload: ObjectValue;
    if ("text" in content)
      payload = {
        type: "text",
        text: { body: content.text, preview_url: false },
      };
    else if ("react" in content) {
      const key = content.react.key;
      if (key?.remoteJid && key.remoteJid !== jid)
        throw new Error("Reaction target belongs to another chat");
      if (!key?.id) throw new Error("Reaction requires a message ID");
      payload = {
        type: "reaction",
        reaction: { message_id: key.id, emoji: content.react.text ?? "" },
      };
    } else {
      const type =
        "image" in content
          ? "image"
          : "video" in content
            ? "video"
            : "document" in content
              ? "document"
              : "audio" in content
                ? "audio"
                : "sticker" in content
                  ? "sticker"
                  : undefined;
      if (!type) throw new Error("Message type is unavailable with Cloud API");
      const media = (content as unknown as ObjectValue)[type];
      if (!Buffer.isBuffer(media))
        throw new Error("Cloud API media sends require a buffer");
      const values = content as unknown as ObjectValue;
      const mime =
        string(values.mimetype) ??
        (type === "image"
          ? imageMime(media)
          : {
              video: "video/mp4",
              audio: "audio/ogg",
              sticker: "image/webp",
              document: "application/octet-stream",
            }[type]);
      const id = await this.uploadMedia(media, mime, string(values.fileName));
      payload = {
        type,
        [type]: {
          id,
          ...(type === "document" && typeof values.fileName === "string"
            ? { filename: values.fileName }
            : {}),
          ...(typeof values.caption === "string" &&
          type !== "audio" &&
          type !== "sticker"
            ? { caption: values.caption }
            : {}),
        },
      };
    }
    if (options?.quoted?.key?.id) {
      payload.context = { message_id: options.quoted.key.id };
    }
    return this.sendPayload(jid, to, payload);
  }

  private async sendPayload(
    jid: string,
    to: string,
    payload: ObjectValue,
  ): Promise<WAMessage> {
    if (this.stopped || !this.user)
      throw new Error("Cloud API is not connected");
    const result = await this.graph(`${this.config.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        ...payload,
      }),
    });
    const id = Array.isArray(result.messages)
      ? string(object(result.messages[0])?.id)
      : undefined;
    if (!id) throw new Error("Cloud API returned no sent message ID");
    return {
      key: { remoteJid: jid, id, fromMe: true },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };
  }

  async sendTemplate(
    jid: string,
    template: { name: string; language: string; components?: Json[] },
  ): Promise<WAMessage> {
    if (this.stopped || !this.user)
      throw new Error("Cloud API is not connected");
    if (
      Object.keys(template).some(
        (key) => !["name", "language", "components"].includes(key),
      )
    )
      throw new Error("Unsupported Cloud API template option");
    if (
      !/^[a-z0-9_]{1,512}$/.test(template.name) ||
      !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(template.language)
    ) {
      throw new Error("Invalid Cloud API template name or language");
    }
    if (
      template.components !== undefined &&
      (!Array.isArray(template.components) || !isJson(template.components))
    )
      throw new Error("Invalid Cloud API template components");
    return this.sendPayload(jid, recipient(jid), {
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        ...(template.components ? { components: template.components } : {}),
      },
    });
  }

  private async uploadMedia(
    bytes: Buffer,
    mime: string,
    filename?: string,
  ): Promise<string> {
    if (bytes.length === 0 || bytes.length > MAX_MEDIA)
      throw new Error("Cloud API media must be between 1 byte and 16 MB");
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set(
      "file",
      new Blob([new Uint8Array(bytes)], { type: mime }),
      filename ?? "attachment",
    );
    const result = await this.graph(`${this.config.phoneNumberId}/media`, {
      method: "POST",
      body: form,
    });
    const id = string(result.id);
    if (!id || !/^\d+$/.test(id))
      throw new Error("Cloud API returned no uploaded media ID");
    return id;
  }

  async downloadMedia(message: WAMessage): Promise<Buffer> {
    const entry = message.key.id ? this.media.get(message.key.id) : undefined;
    if (!entry || entry.jid !== message.key.remoteJid)
      throw new Error(
        "Cloud API attachment is unavailable or belongs to another chat",
      );
    const metadata = await this.graph(
      `${entry.id}?phone_number_id=${this.config.phoneNumberId}`,
    );
    if (metadata.id !== entry.id)
      throw new Error("Cloud API media identity mismatch");
    if (
      typeof metadata.file_size === "number" &&
      metadata.file_size > MAX_MEDIA
    )
      throw new Error("Cloud API attachment exceeds 16 MB");
    let url: URL;
    try {
      url = new URL(string(metadata.url) ?? "");
    } catch {
      throw new Error("Cloud API returned an invalid media URL");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !(
        url.hostname === "lookaside.facebook.com" ||
        url.hostname === "lookaside.fbsbx.com" ||
        url.hostname === "fbcdn.net" ||
        url.hostname.endsWith(".fbcdn.net")
      )
    ) {
      throw new Error("Cloud API returned an untrusted media URL");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.request(url.toString(), {
        headers: { Authorization: `Bearer ${this.config.accessToken}` },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          `Cloud API media download failed (HTTP ${response.status})`,
        );
      const bytes = await readBounded(response, MAX_MEDIA);
      if (!bytes.length)
        throw new Error("Cloud API media download returned no bytes");
      return bytes;
    } catch (error) {
      if (
        error instanceof Error &&
        /^Cloud API media download (failed \(HTTP \d+\)|returned no bytes)$/.test(
          error.message,
        )
      )
        throw error;
      throw new Error(
        "Cloud API media download failed (network, timeout, or size limit)",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async sendPresenceUpdate(
    ..._args: Parameters<WASocket["sendPresenceUpdate"]>
  ): Promise<void> {}

  async groupMetadata(
    ..._args: Parameters<WASocket["groupMetadata"]>
  ): ReturnType<WASocket["groupMetadata"]> {
    throw new Error("Groups are unavailable with Cloud API");
  }

  async groupFetchAllParticipating(): ReturnType<
    WASocket["groupFetchAllParticipating"]
  > {
    throw new Error("Groups are unavailable with Cloud API");
  }
}
