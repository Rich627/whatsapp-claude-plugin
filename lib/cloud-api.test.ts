import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "crypto";
import type { WAMessage } from "@whiskeysockets/baileys";
import {
  CloudApiSocket,
  readCloudApiConfig,
  type CloudApiConfig,
  type CloudReaction,
} from "./cloud-api";

const config: CloudApiConfig = {
  phoneNumberId: "123456789",
  accessToken: "fixture-access-token",
  appSecret: "fixture-app-secret",
  verifyToken: "fixture-verification-token",
  apiVersion: "v26.0",
  webhookHost: "127.0.0.1",
  webhookPort: 0,
  webhookPath: "/webhook",
};
const jid = "886900000001@s.whatsapp.net";
const otherJid = "886900000002@s.whatsapp.net";
const active: CloudApiSocket[] = [];
afterEach(() => {
  for (const socket of active.splice(0)) socket.end();
});

function fixtureMessage(
  id = "fixture-message",
  fields: Record<string, unknown> = {},
) {
  return {
    id,
    from: "886900000001",
    timestamp: "1791561600",
    type: "text",
    text: { body: "hello" },
    ...fields,
  };
}
function envelope(messages: unknown[], phoneNumberId = config.phoneNumberId) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "fixture-waba",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phoneNumberId },
              contacts: [
                { wa_id: "886900000001", profile: { name: "Fixture sender" } },
              ],
              messages,
            },
          },
        ],
      },
    ],
  };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const identity = () =>
  json({
    display_phone_number: "+886 900 000 099",
    verified_name: "Fixture business",
  });

async function start(
  options: {
    fetch?: Fetch;
    onMessage?: (message: WAMessage) => Promise<void>;
    onReaction?: (reaction: CloudReaction) => Promise<void>;
    onError?: (safeMessage: string) => void;
    maxMediaEntries?: number;
  } = {},
) {
  const received: WAMessage[] = [];
  const socket = new CloudApiSocket(config, {
    fetch: options.fetch ?? (async () => identity()),
    onMessage:
      options.onMessage ??
      (async (message) => {
        received.push(message);
      }),
    onReaction: options.onReaction,
    onError: options.onError,
    maxMediaEntries: options.maxMediaEntries,
  });
  active.push(socket);
  await socket.start();
  const endpoint = `http://127.0.0.1:${socket.status().webhookPort}/webhook`;
  const post = async (payload: unknown, secret = config.appSecret) => {
    const body = JSON.stringify(payload);
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    return fetch(endpoint, {
      method: "POST",
      body,
      headers: { "X-Hub-Signature-256": `sha256=${signature}` },
    });
  };
  return { socket, endpoint, post, received };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Fixture callback did not finish");
}

describe("Cloud API configuration", () => {
  const env = {
    WHATSAPP_CLOUD_PHONE_NUMBER_ID: config.phoneNumberId,
    WHATSAPP_CLOUD_ACCESS_TOKEN: config.accessToken,
    WHATSAPP_CLOUD_APP_SECRET: config.appSecret,
    WHATSAPP_CLOUD_VERIFY_TOKEN: config.verifyToken,
  };
  test("requires all credentials and validates listener settings without exposing values", () => {
    expect(readCloudApiConfig(env).webhookHost).toBe("127.0.0.1");
    expect(readCloudApiConfig(env).apiVersion).toBe("v26.0");
    expect(() =>
      readCloudApiConfig({ ...env, WHATSAPP_CLOUD_APP_SECRET: "" }),
    ).toThrow("WHATSAPP_CLOUD_APP_SECRET");
    expect(() =>
      readCloudApiConfig({
        ...env,
        WHATSAPP_CLOUD_PHONE_NUMBER_ID: "../private",
      }),
    ).toThrow("Invalid Cloud API phone number ID");
    for (const port of ["0", "-1", "65536", "1.5", "invalid"]) {
      expect(() =>
        readCloudApiConfig({ ...env, WHATSAPP_CLOUD_WEBHOOK_PORT: port }),
      ).toThrow("Invalid Cloud API webhook port");
    }
    expect(() =>
      readCloudApiConfig({
        ...env,
        WHATSAPP_CLOUD_API_VERSION: "v26.0/../private",
      }),
    ).toThrow("Invalid Cloud API version");
    expect(() =>
      readCloudApiConfig({
        ...env,
        WHATSAPP_CLOUD_WEBHOOK_PATH: "https://example.invalid",
      }),
    ).toThrow("Invalid Cloud API webhook path");
  });

  test("identity validation precedes listener readiness and failed start is safe", async () => {
    const socket = new CloudApiSocket(config, {
      fetch: async () =>
        json({ error: { code: 190, message: config.accessToken } }, 401),
      onMessage: async () => {},
    });
    active.push(socket);
    await expect(socket.start()).rejects.toThrow(
      "Cloud API request failed (HTTP 401, code 190)",
    );
    expect(socket.status().listenerReady).toBe(false);
    expect(socket.user).toBeUndefined();
    const valid = await start();
    expect(valid.socket.user?.id).toBe("886900000099@s.whatsapp.net");
    expect(valid.socket.status().inboundVerified).toBe(false);
    expect(JSON.stringify(valid.socket.status())).not.toContain(
      config.accessToken,
    );
  });
});

describe("Cloud API webhook trust boundary", () => {
  test("GET challenge requires exact verification token and subscription mode", async () => {
    const { endpoint, received } = await start();
    const url = `${endpoint}?hub.mode=subscribe&hub.verify_token=${config.verifyToken}&hub.challenge=98765`;
    expect(await (await fetch(url)).text()).toBe("98765");
    expect((await fetch(url.replace(config.verifyToken, "wrong"))).status).toBe(
      403,
    );
    expect((await fetch(url.replace("subscribe", "unsubscribe"))).status).toBe(
      403,
    );
    expect((await fetch(url.replace("98765", "bad"))).status).toBe(400);
    expect(received).toHaveLength(0);
  });

  test("POST requires the raw-body app-secret signature before inspecting input", async () => {
    const { endpoint, post, received } = await start();
    const data = envelope([fixtureMessage()]);
    expect(
      (await fetch(endpoint, { method: "POST", body: JSON.stringify(data) }))
        .status,
    ).toBe(403);
    expect((await post(data, "wrong-secret")).status).toBe(403);
    const body = JSON.stringify(data);
    const signature = createHmac("sha256", config.appSecret)
      .update(body)
      .digest("hex");
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          body: `${body} `,
          headers: { "X-Hub-Signature-256": `sha256=${signature}` },
        })
      ).status,
    ).toBe(403);
    expect(received).toHaveLength(0);
    expect((await post(data)).status).toBe(200);
    await until(() => received.length === 1);
    expect(received[0].key).toEqual({
      remoteJid: jid,
      id: "fixture-message",
      fromMe: false,
    });
    expect(received[0].pushName).toBe("Fixture sender");
  });

  test("signed events for another phone, another object, statuses or malformed senders do not route", async () => {
    const { post, received } = await start();
    await post(envelope([fixtureMessage()], "999999"));
    await post({ ...envelope([fixtureMessage()]), object: "page" });
    await post(envelope([fixtureMessage("bad-sender", { from: "123@g.us" })]));
    await post(
      envelope([fixtureMessage("bad-time", { timestamp: "not-a-date" })]),
    );
    await post({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: config.phoneNumberId },
                statuses: [{ id: "status" }],
              },
            },
          ],
        },
      ],
    });
    expect(received).toHaveLength(0);
  });

  test("retries and duplicate entries deliver once; quoted messages retain context", async () => {
    const { post, received } = await start();
    const data = envelope([
      fixtureMessage("duplicate", {
        context: { id: "prior-message", from: "886900000099" },
      }),
      fixtureMessage("duplicate"),
    ]);
    await post(data);
    await post(data);
    await until(() => received.length === 1);
    expect(
      received[0].message?.extendedTextMessage?.contextInfo?.stanzaId,
    ).toBe("prior-message");
    expect(
      received[0].message?.extendedTextMessage?.contextInfo?.participant,
    ).toBe("886900000099@s.whatsapp.net");
  });

  test("reaction actor comes from authenticated message sender, never the referenced message", async () => {
    const reactions: CloudReaction[] = [];
    const { post, received } = await start({
      onReaction: async (reaction) => {
        reactions.push(reaction);
      },
    });
    await post(
      envelope([
        fixtureMessage("reaction-own-id", {
          type: "reaction",
          reaction: {
            emoji: "👍",
            message_id: "requested-permission",
            from: "attacker-chosen",
          },
        }),
      ]),
    );
    await until(() => reactions.length === 1);
    expect(reactions[0].key.id).toBe("requested-permission");
    expect(reactions[0].reaction.key).toEqual({
      id: "reaction-own-id",
      remoteJid: jid,
      fromMe: false,
    });
    expect(received).toHaveLength(0);
  });

  test("callback queue is serial, acknowledges promptly, and rejects overflow without marking it seen", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const { post } = await start({
      onMessage: async (message) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        if (!delivered.length) await gate;
        delivered.push(message.key.id!);
        running--;
      },
    });
    try {
      const response = await post(
        envelope(
          Array.from({ length: 1000 }, (_, i) => fixtureMessage(`queue-${i}`)),
        ),
      );
      expect(response.status).toBe(200);
      expect(delivered).toHaveLength(0);
      expect((await post(envelope([fixtureMessage("overflow")]))).status).toBe(
        503,
      );
      release();
      await until(() => delivered.length === 1000);
      expect((await post(envelope([fixtureMessage("overflow")]))).status).toBe(
        200,
      );
      await until(() => delivered.length === 1001);
      expect(maxRunning).toBe(1);
      expect(delivered[1000]).toBe("overflow");
    } finally {
      release();
    }
  });

  test("callback failures expose no private input and do not wedge later callbacks", async () => {
    const errors: string[] = [];
    const delivered: string[] = [];
    const { post } = await start({
      onMessage: async (message) => {
        if (message.key.id === "broken")
          throw new Error(`private-body ${config.accessToken}`);
        delivered.push(message.key.id!);
      },
      onError: (message) => {
        errors.push(message);
      },
    });
    await post(
      envelope([fixtureMessage("broken"), fixtureMessage("following")]),
    );
    await until(() => delivered.length === 1);
    expect(errors).toEqual(["Cloud API inbound handler failed"]);
    expect(delivered).toEqual(["following"]);
  });

  test("large signed body is rejected", async () => {
    const { post, received } = await start();
    expect(
      (
        await post(
          envelope([
            fixtureMessage("oversized", {
              text: { body: "x".repeat(1024 * 1024) },
            }),
          ]),
        )
      ).status,
    ).toBe(413);
    expect(received).toHaveLength(0);
  });
});

describe("Cloud API outgoing messages and media", () => {
  test("sends text, quote context and explicit approved template payloads; redirects are disabled", async () => {
    const sent: Record<string, unknown>[] = [];
    const { socket } = await start({
      fetch: async (url, init) => {
        expect(url.startsWith("https://graph.facebook.com/v26.0/")).toBe(true);
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${config.accessToken}`,
        );
        if (url.endsWith("/messages")) {
          sent.push(JSON.parse(init?.body as string));
          return json({ messages: [{ id: `sent-${sent.length}` }] });
        }
        return identity();
      },
    });
    const result = await socket.sendMessage(
      jid,
      { text: "reply" },
      { quoted: { key: { remoteJid: jid, id: "quoted" } } },
    );
    expect(result?.key).toEqual({ remoteJid: jid, id: "sent-1", fromMe: true });
    expect(sent[0]).toMatchObject({
      to: "886900000001",
      text: { body: "reply", preview_url: false },
      context: { message_id: "quoted" },
    });
    await socket.sendTemplate(jid, {
      name: "order_update",
      language: "en_US",
      components: [
        { type: "body", parameters: [{ type: "text", text: "ABC" }] },
      ],
    });
    expect(sent[1]).toMatchObject({
      type: "template",
      template: { name: "order_update", language: { code: "en_US" } },
    });
    await expect(
      socket.sendTemplate(jid, { name: "bad name", language: "en" }),
    ).rejects.toThrow("Invalid Cloud API template");
  });

  test("fails unsupported and cross-chat operations before network sends", async () => {
    let calls = 0;
    const { socket } = await start({
      fetch: async () => {
        calls++;
        return identity();
      },
    });
    await expect(
      socket.sendMessage("123@g.us", { text: "no" }),
    ).rejects.toThrow("DMs only");
    await expect(
      socket.sendMessage(jid, { text: "no", mentions: [otherJid] }),
    ).rejects.toThrow("mentions");
    await expect(
      socket.sendMessage(jid, { text: "no", edit: { id: "old" } }),
    ).rejects.toThrow("editing");
    await expect(
      socket.sendMessage(
        jid,
        { text: "no" },
        { quoted: { key: { id: "other", remoteJid: otherJid } } },
      ),
    ).rejects.toThrow("another chat");
    await expect(
      socket.sendMessage(jid, {
        react: { text: "👍", key: { id: "other", remoteJid: otherJid } },
      }),
    ).rejects.toThrow("another chat");
    await expect(socket.groupMetadata("123@g.us")).rejects.toThrow(
      "Groups are unavailable",
    );
    expect(calls).toBe(1);
  });

  test("uploads PNG bytes with their true MIME and sends the returned media ID", async () => {
    let upload: FormData | undefined;
    let sent: Record<string, unknown> | undefined;
    const { socket } = await start({
      fetch: async (url, init) => {
        if (url.endsWith("/media")) {
          upload = init?.body as FormData;
          return json({ id: "876543" });
        }
        if (url.endsWith("/messages")) {
          sent = JSON.parse(init?.body as string);
          return json({ messages: [{ id: "sent-image" }] });
        }
        return identity();
      },
    });
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    await socket.sendMessage(jid, { image: png });
    expect((upload?.get("file") as File).type).toBe("image/png");
    expect(sent).toMatchObject({ type: "image", image: { id: "876543" } });
  });

  test("media belongs to its admitted message and recipient and is downloaded only via Graph", async () => {
    const urls: string[] = [];
    const { socket, post, received } = await start({
      fetch: async (url, init) => {
        urls.push(url);
        expect(init?.redirect).toBe("error");
        if (url.includes("/987654?"))
          return json({
            id: "987654",
            url: "https://lookaside.fbsbx.com/fixture-media",
            file_size: 3,
          });
        if (url === "https://lookaside.fbsbx.com/fixture-media") {
          expect(new Headers(init?.headers).get("Authorization")).toBe(
            `Bearer ${config.accessToken}`,
          );
          return new Response(Buffer.from([1, 2, 3]));
        }
        return identity();
      },
    });
    await post(
      envelope([
        fixtureMessage("photo", {
          type: "image",
          image: {
            id: "987654",
            mime_type: "image/png",
            url: "https://attacker.invalid",
            caption: "photo",
          },
        }),
      ]),
    );
    await until(() => received.length === 1);
    const message = received[0];
    expect(message.message?.imageMessage?.caption).toBe("photo");
    await expect(
      socket.downloadMedia({
        ...message,
        key: { ...message.key, remoteJid: otherJid },
      }),
    ).rejects.toThrow("another chat");
    expect(urls).toHaveLength(1);
    expect(await socket.downloadMedia(message)).toEqual(Buffer.from([1, 2, 3]));
    expect(urls[1]).toContain(`phone_number_id=${config.phoneNumberId}`);
    expect(urls.some((url) => url.includes("attacker"))).toBe(false);
  });

  test("untrusted download URLs, oversized media and redirects fail without leaking credentials", async () => {
    let mediaUrl = "https://attacker.invalid/file";
    let fileSize = 3;
    const requests: string[] = [];
    const { socket, post, received } = await start({
      fetch: async (url) => {
        requests.push(url);
        if (url.includes("/987654?"))
          return json({ id: "987654", url: mediaUrl, file_size: fileSize });
        if (url === "https://lookaside.facebook.com/file")
          return new Response(null, {
            status: 302,
            headers: { Location: "https://attacker.invalid" },
          });
        return identity();
      },
    });
    await post(
      envelope([
        fixtureMessage("photo", { type: "image", image: { id: "987654" } }),
      ]),
    );
    await until(() => received.length === 1);
    for (const url of [
      "https://attacker.invalid/file",
      "http://lookaside.facebook.com/file",
      "https://lookaside.facebook.com.attacker.invalid/file",
      "https://lookaside.fbsbx.com.attacker.invalid/file",
      "https://attacker.fbsbx.com/file",
      "https://user@lookaside.facebook.com/file",
      "https://lookaside.facebook.com:444/file",
    ]) {
      mediaUrl = url;
      await expect(socket.downloadMedia(received[0])).rejects.toThrow(
        "untrusted media URL",
      );
    }
    expect(requests.some((url) => url.includes("attacker"))).toBe(false);
    mediaUrl = "https://lookaside.facebook.com/file";
    fileSize = 17 * 1024 * 1024;
    await expect(socket.downloadMedia(received[0])).rejects.toThrow(
      "exceeds 16 MB",
    );
    fileSize = 3;
    await expect(socket.downloadMedia(received[0])).rejects.toThrow("HTTP 302");
  });

  test("media metadata cache is bounded and never permits lookup by caller-supplied media ID", async () => {
    const { socket, post, received } = await start({ maxMediaEntries: 1 });
    await post(
      envelope([
        fixtureMessage("older", {
          type: "document",
          document: { id: "111111" },
        }),
        fixtureMessage("newer", {
          type: "document",
          document: { id: "222222" },
        }),
      ]),
    );
    await until(() => received.length === 2);
    await expect(socket.downloadMedia(received[0])).rejects.toThrow(
      "unavailable",
    );
    await expect(
      socket.downloadMedia({ key: { id: "222222", remoteJid: jid } }),
    ).rejects.toThrow("unavailable");
  });
});
