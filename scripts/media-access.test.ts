import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNER = "15550000001@s.whatsapp.net";
const ALLOWED = "15550000002@s.whatsapp.net";
const STRANGER = "15550000003@s.whatsapp.net";
const GROUP = "123456789@g.us";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startFixture(extraDirs = "") {
  const root = join(import.meta.dir, "..");
  const dir = mkdtempSync(join(tmpdir(), "wa-sec-"));
  const external = mkdtempSync(join(tmpdir(), "wa-export-"));
  const access = {
    dmPolicy: "allowlist",
    allowFrom: [ALLOWED],
    mentionPatterns: ["bot"],
    groups: {
      [GROUP]: { requireMention: true, allowFrom: [ALLOWED], context: true },
    },
    pending: {},
  };
  const saveAccess = () =>
    writeFileSync(join(dir, "access.json"), JSON.stringify(access));
  saveAccess();
  const preload = join(dir, "fixture.ts");
  const packagePath = join(
    root,
    "node_modules/@whiskeysockets/baileys/lib/index.js",
  );
  // The socket and CDN are fixtures; message generation, encryption and decryption
  // use the pinned Baileys implementation. No account or external network is used.
  writeFileSync(
    preload,
    `
    import { mock } from "bun:test";
    import { createCipheriv, createHmac } from "node:crypto";
    import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync, symlinkSync } from "node:fs";
    const real = await import(${JSON.stringify(packagePath)});
    const key = Buffer.alloc(32, 7);
    const keys = await real.getMediaKeys(key, "document");
    const cipher = createCipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from("SYNTHETIC_FILE")), cipher.final()]);
    const mac = createHmac("sha256", keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10);
    globalThis.fetch = async (url, init) => {
      appendFileSync(${JSON.stringify(join(dir, "fetches.jsonl"))}, JSON.stringify({url: String(url), redirect: init?.redirect}) + "\\n");
      if (String(url) === "https://mmg.whatsapp.net/revoke-image") {
        const path = ${JSON.stringify(join(dir, "access.json"))};
        const access = JSON.parse(readFileSync(path, "utf8")); access.allowFrom = []; writeFileSync(path, JSON.stringify(access));
        const imageKeys = await real.getMediaKeys(key, "image");
        const c = createCipheriv("aes-256-cbc", imageKeys.cipherKey, imageKeys.iv);
        const encrypted = Buffer.concat([c.update(Buffer.from("SYNTHETIC_IMAGE")), c.final()]);
        const tag = createHmac("sha256", imageKeys.macKey).update(imageKeys.iv).update(encrypted).digest().subarray(0, 10);
        return new Response(Buffer.concat([encrypted, tag]));
      }
      if (String(url) !== "https://mmg.whatsapp.net/document" || init?.redirect !== "error") throw new Error("Unexpected fixture request");
      return new Response(Buffer.concat([ciphertext, mac]));
    };
    const handlers = new Map();
    const ev = { on(name, fn) { handlers.set(name, fn); } };
    let next = 0;
    const sock = { ev, user: { id: ${JSON.stringify(OWNER)}, name: "Fixture" },
      signalRepository: { lidMapping: { getPNForLID: async () => null } },
      readMessages: async keys => { appendFileSync(${JSON.stringify(join(dir, "reads.jsonl"))}, JSON.stringify({ keys }) + "\\n"); },
      sendPresenceUpdate: async () => {}, end() {}, updateMediaMessage: async m => m,
      sendMessage: async (jid, content, options) => {
        if (content.text === "swap-file") {
          const swap = JSON.parse(readFileSync(${JSON.stringify(join(dir, "swap.json"))}, "utf8"));
          unlinkSync(swap.path); symlinkSync(swap.target, swap.path);
        }
        const encoded = real.generateWAMessageFromContent(jid, { extendedTextMessage: { text: content.text || "attachment" } }, { userJid: ${JSON.stringify(OWNER)}, ...options });
        appendFileSync(${JSON.stringify(join(dir, "sends.jsonl"))}, JSON.stringify({jid, content, encoded}) + "\\n");
        return { key: { remoteJid: jid, id: "sent-" + (++next), fromMe: true } };
      }
    };
    mock.module(${JSON.stringify(packagePath)}, () => ({ ...real, default: () => sock,
      fetchLatestBaileysVersion: async () => ({version: [2, 3000, 1], isLatest: true}),
      useMultiFileAuthState: async () => ({state: {creds: {registered: true}, keys: {get: async () => ({}), set: async () => {}}}, saveCreds: async () => {}})
    }));
    let processed = 0, busy = false;
    setInterval(async () => {
      if (busy || !handlers.has("messages.upsert") || !existsSync(${JSON.stringify(join(dir, "inbound.json"))})) return;
      const commands = JSON.parse(readFileSync(${JSON.stringify(join(dir, "inbound.json"))}, "utf8"));
      busy = true;
      try {
        while (processed < commands.length) {
          const message = commands[processed];
          for (const value of Object.values(message.message)) if (value && value.mediaKey) value.mediaKey = key;
          await handlers.get("messages.upsert")({type: "notify", messages: [message]});
          writeFileSync(${JSON.stringify(join(dir, "processed"))}, String(++processed));
        }
      } finally { busy = false; }
    }, 20);
  `,
  );
  const env = {
    ...process.env,
    WHATSAPP_STATE_DIR: dir,
    WHATSAPP_PROVIDER: "baileys",
    WHATSAPP_QUIET: "1",
    WHATSAPP_READ_RECEIPTS: "1",
    WHATSAPP_ATTACH_DIRS: extraDirs === "external" ? external : extraDirs,
  };
  const child = spawn("bun", ["--preload", preload, join(root, "server.ts")], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "",
    partial = "",
    sequence = 1;
  const responses = new Map<number, any>();
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => {
    partial += d.toString();
    const lines = partial.split("\n");
    partial = lines.pop()!;
    for (const line of lines) {
      const message = JSON.parse(line);
      if (message.id) responses.set(message.id, message);
    }
  });
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 15000;
    while (!check() && Date.now() < deadline) await pause(25);
    if (!check()) throw new Error("Fixture timeout: " + stderr);
  };
  const send = (value: unknown) =>
    child.stdin.write(JSON.stringify(value) + "\n");
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "security-fixture", version: "1" },
    },
  });
  await until(() => responses.has(1));
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const commands: unknown[] = [];
  return {
    dir,
    external,
    access,
    saveAccess,
    records(name: string): any[] {
      const path = join(dir, name + ".jsonl");
      return existsSync(path)
        ? readFileSync(path, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    },
    async deliver(
      chat: string,
      id: string,
      content: unknown,
      participant?: string,
    ) {
      commands.push({
        key: { remoteJid: chat, id, fromMe: false, participant },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: content,
      });
      writeFileSync(join(dir, "inbound.json"), JSON.stringify(commands));
      await until(
        () =>
          existsSync(join(dir, "processed")) &&
          Number(readFileSync(join(dir, "processed"), "utf8")) ===
            commands.length,
      );
    },
    async tool(name: string, args: unknown) {
      const id = ++sequence;
      send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      });
      await until(() => responses.has(id));
      return responses.get(id).result;
    },
    async stop() {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        pause(1500),
      ]);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    },
  };
}

const document = {
  documentMessage: {
    url: "https://mmg.whatsapp.net/document",
    mediaKey: true,
    mimetype: "text/plain",
    fileName: "fixture.txt",
  },
};

test("real server enforces media access, chat binding and default export directories", async () => {
  const f = await startFixture();
  try {
    await f.deliver(ALLOWED, "private", {
      conversation: "PRIVATE_SYNTHETIC_SECRET",
    });
    const quote = await f.tool("reply", {
      chat_id: GROUP,
      text: "public",
      reply_to: "private",
    });
    expect(quote.isError).toBe(true);
    expect(JSON.stringify(quote)).toContain("another chat");
    expect(f.records("sends")).toHaveLength(0);
    expect(
      (await f.tool("mark_read", { chat_id: GROUP, message_id: "private" }))
        .isError,
    ).toBe(true);
    expect(
      (
        await f.tool("react", {
          chat_id: GROUP,
          message_id: "private",
          emoji: "👍",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await f.tool("reply", {
          chat_id: ALLOWED,
          text: "same room",
          reply_to: "private",
        })
      ).isError,
    ).not.toBe(true);
    expect(JSON.stringify(f.records("sends")[0].encoded)).toContain(
      "PRIVATE_SYNTHETIC_SECRET",
    );

    await f.deliver(STRANGER, "blocked", document);
    expect(
      (await f.tool("download_attachment", { file_id: "blocked" })).isError,
    ).toBe(true);
    await f.deliver(ALLOWED, "local-url", {
      imageMessage: {
        url: "http://127.0.0.1/admin",
        mediaKey: true,
        mimetype: "image/jpeg",
      },
    });
    expect(f.records("fetches")).toHaveLength(0);
    await f.deliver(ALLOWED, "allowed-doc", document);
    const downloaded = await f.tool("download_attachment", {
      file_id: "allowed-doc",
    });
    expect(downloaded.isError).not.toBe(true);
    expect(
      readFileSync(downloaded.content[0].text.split("\n")[0], "utf8"),
    ).toBe("SYNTHETIC_FILE");
    f.access.allowFrom = [];
    f.saveAccess();
    expect(
      (await f.tool("download_attachment", { file_id: "allowed-doc" })).isError,
    ).toBe(true);
    f.access.allowFrom = [ALLOWED];
    f.saveAccess();

    await f.deliver(GROUP, "context-doc", document, ALLOWED);
    expect(
      (await f.tool("download_attachment", { file_id: "context-doc" })).isError,
    ).not.toBe(true);
    await f.deliver(GROUP, "group-stranger", document, STRANGER);
    expect(
      (await f.tool("download_attachment", { file_id: "group-stranger" }))
        .isError,
    ).toBe(true);
    f.access.groups[GROUP].context = false;
    f.saveAccess();
    expect(
      (await f.tool("download_attachment", { file_id: "context-doc" })).isError,
    ).toBe(true);
    f.access.groups[GROUP].context = true;
    f.saveAccess();
    // A rejected sender cannot replace another chat's stored message by reusing its id.
    await f.deliver(STRANGER, "private", { conversation: "FORGED" });
    await f.tool("reply", {
      chat_id: ALLOWED,
      text: "still private",
      reply_to: "private",
    });
    expect(JSON.stringify(f.records("sends").at(-1).encoded)).toContain(
      "PRIVATE_SYNTHETIC_SECRET",
    );

    const outside = join(f.external, "private.txt");
    writeFileSync(outside, "SYNTHETIC_PRIVATE_FILE");
    expect(
      (await f.tool("reply", { chat_id: ALLOWED, text: "", files: [outside] }))
        .isError,
    ).toBe(true);
    for (const directory of ["inbox", "outbox"]) {
      mkdirSync(join(f.dir, directory), { recursive: true });
      const file = join(f.dir, directory, "share.txt");
      writeFileSync(file, "share");
      expect(
        (await f.tool("reply", { chat_id: ALLOWED, text: "", files: [file] }))
          .isError,
      ).not.toBe(true);
    }
    if (process.platform !== "win32") {
      const escape = join(f.dir, "outbox", "escape.txt");
      symlinkSync(outside, escape);
      expect(
        (await f.tool("reply", { chat_id: ALLOWED, text: "", files: [escape] }))
          .isError,
      ).toBe(true);
      const swap = join(f.dir, "outbox", "swap.txt");
      symlinkSync(join(f.dir, "outbox", "share.txt"), swap);
      writeFileSync(
        join(f.dir, "swap.json"),
        JSON.stringify({ path: swap, target: outside }),
      );
      expect(
        (
          await f.tool("reply", {
            chat_id: ALLOWED,
            text: "swap-file",
            files: [swap],
          })
        ).isError,
      ).not.toBe(true);
      const sentFile = f.records("sends").at(-1).content.document;
      expect(Buffer.from(sentFile.data).toString()).toBe("share");
    }
    const inboxBefore = f.records("messages").length;
    await f.deliver(ALLOWED, "revoked-during-fetch", {
      imageMessage: {
        url: "https://mmg.whatsapp.net/revoke-image",
        mediaKey: true,
        mimetype: "image/jpeg",
      },
    });
    expect(
      f
        .records("messages")
        .slice(inboxBefore)
        .some((m) => m.id === "revoked-during-fetch"),
    ).toBe(false);
    expect(
      (await f.tool("download_attachment", { file_id: "revoked-during-fetch" }))
        .isError,
    ).toBe(true);
    const readIds = f
      .records("reads")
      .flatMap((record) => record.keys.map((key: { id: string }) => key.id));
    expect(readIds).toContain("private");
    expect(readIds).not.toContain("blocked");
    expect(readIds).not.toContain("revoked-during-fetch");
  } finally {
    await f.stop();
  }
}, 60000);

test("explicit export directory grants files while keeping credentials blocked", async () => {
  const f = await startFixture("external");
  try {
    const file = join(f.external, "share.txt");
    writeFileSync(file, "share");
    expect(
      (await f.tool("reply", { chat_id: ALLOWED, text: "", files: [file] }))
        .isError,
    ).not.toBe(true);
    const secret = join(f.external, ".env");
    writeFileSync(secret, "SYNTHETIC_SECRET");
    expect(
      (await f.tool("reply", { chat_id: ALLOWED, text: "", files: [secret] }))
        .isError,
    ).toBe(true);
  } finally {
    await f.stop();
  }
}, 60000);
