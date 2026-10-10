import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!check() && Date.now() < deadline) await pause(50);
  expect(check()).toBe(true);
}

test("real Cloud MCP server preserves access, permission identity and singleton relay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-cloud-server-"));
  const graphLog = join(dir, "graph-fixture.jsonl");
  const preload = join(dir, "graph-fixture.ts");
  const personal = "886900000001@s.whatsapp.net";
  const stranger = "886900000002@s.whatsapp.net";
  const accessPath = join(dir, "access.json");
  const access = {
    dmPolicy: "allowlist",
    allowFrom: [personal],
    owner: personal,
    groups: {},
    pending: {},
  };
  writeFileSync(accessPath, JSON.stringify(access));
  // Isolate Graph in the child process; no real Meta connection or message send.
  writeFileSync(
    preload,
    `
    import { appendFileSync } from "node:fs";
    let nextId = 0;
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith("https://graph.facebook.com/")) throw new Error("Unexpected fixture URL");
      if (init?.body instanceof FormData) {
        const file = init.body.get("file");
        appendFileSync(${JSON.stringify(graphLog)}, JSON.stringify({ uploadMime: file.type, filename: file.name }) + "\\n");
        return Response.json({ id: "55555" });
      }
      const payload = init?.body ? JSON.parse(init.body) : null;
      appendFileSync(${JSON.stringify(graphLog)}, JSON.stringify({ payload }) + "\\n");
      return Response.json(payload ? { messages: [{ id: "sent-" + (++nextId) }] } : { display_phone_number: "+886 900000000", verified_name: "Test Business" });
    };
  `,
  );
  const reserve = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("fixture"),
  });
  const port = reserve.port;
  reserve.stop(true);
  const environment = {
    ...process.env,
    WHATSAPP_STATE_DIR: dir,
    WHATSAPP_PROVIDER: "cloud-api",
    WHATSAPP_CLOUD_PHONE_NUMBER_ID: "12345",
    WHATSAPP_CLOUD_ACCESS_TOKEN: "test-access-token",
    WHATSAPP_CLOUD_APP_SECRET: "test-app-secret",
    WHATSAPP_CLOUD_VERIFY_TOKEN: "test-verify-token",
    WHATSAPP_CLOUD_WEBHOOK_PORT: String(port),
    WHATSAPP_QUIET: "1",
  };
  const child = spawn(
    "bun",
    ["--preload", preload, join(import.meta.dir, "..", "server.ts")],
    { env: environment, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  let partial = "";
  const replies = new Map<number, any>();
  const notifications: any[] = [];
  child.stdout.on("data", (data) => {
    partial += data.toString();
    const lines = partial.split("\n");
    partial = lines.pop()!;
    for (const line of lines) {
      const value = JSON.parse(line);
      if (typeof value.id === "number") replies.set(value.id, value);
      else notifications.push(value);
    }
  });
  let nextCall = 10;
  const send = (value: unknown) =>
    child.stdin.write(JSON.stringify(value) + "\n");
  async function tool(name: string, args: unknown = {}): Promise<any> {
    const id = ++nextCall;
    send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    await until(() => replies.has(id));
    return replies.get(id).result;
  }
  const text = (result: any): string =>
    result.content.map((item: any) => item.text ?? "").join("\n");
  const graphSends = () =>
    readFileSync(graphLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).payload)
      .filter(Boolean);
  let secondary: ReturnType<typeof spawn> | undefined;
  async function deliver(
    from: string,
    id: string,
    body: string,
    reactionId?: string,
  ): Promise<Response> {
    const message = {
      from,
      id,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: reactionId ? "reaction" : "text",
      ...(reactionId
        ? { reaction: { message_id: reactionId, emoji: body } }
        : { text: { body } }),
    };
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "12345" },
                messages: [message],
              },
            },
          ],
        },
      ],
    });
    return fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      body: raw,
      headers: {
        "X-Hub-Signature-256":
          "sha256=" +
          createHmac("sha256", "test-app-secret").update(raw).digest("hex"),
      },
    });
  }
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "cloud-fixture", version: "1" },
      },
    });
    await until(
      () =>
        replies.has(1) && stderr.includes("Official Cloud API listener ready"),
    );
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await until(() => replies.has(2));
    const names = replies.get(2).result.tools.map((entry: any) => entry.name);
    expect(names).toContain("send_template");
    expect(names).toContain("reply");
    expect(names).not.toContain("list_groups");
    expect(names).not.toContain("edit_message");
    const replyTool = replies
      .get(2)
      .result.tools.find((entry: any) => entry.name === "reply");
    expect(replyTool.inputSchema.properties).not.toHaveProperty("mentions");
    expect(
      replies.get(2).result.tools.find((entry: any) => entry.name === "status")
        .description,
    ).not.toContain("pairing code");
    expect(text(await tool("status"))).toContain(
      "Listener readiness does not verify",
    );
    expect(JSON.parse(readFileSync(accessPath, "utf8"))).toEqual(access);
    expect(existsSync(join(dir, ".baileys_auth"))).toBe(false);

    expect(
      (await deliver("886900000002", "stranger-msg", "untrusted")).status,
    ).toBe(200);
    expect((await deliver("886900000001", "owner-msg", "hello")).status).toBe(
      200,
    );
    await until(() =>
      notifications.some(
        (entry) => entry.params?.meta?.message_id === "owner-msg",
      ),
    );
    expect(
      notifications.some(
        (entry) => entry.params?.meta?.message_id === "stranger-msg",
      ),
    ).toBe(false);
    expect(text(await tool("unreplied"))).toContain("hello");
    expect(text(await tool("unreplied"))).not.toContain("untrusted");
    expect(
      (await tool("reply", { chat_id: stranger, text: "must refuse" })).isError,
    ).toBe(true);
    expect(
      (
        await tool("send_template", {
          chat_id: stranger,
          name: "hello_world",
          language: "en_US",
        })
      ).isError,
    ).toBe(true);
    expect(graphSends()).toHaveLength(0);
    expect(
      (
        await tool("reply", {
          chat_id: personal,
          text: "reply",
          reply_to: "owner-msg",
        })
      ).isError,
    ).not.toBe(true);
    expect(graphSends()[0].context).toEqual({ message_id: "owner-msg" });
    expect(
      (
        await tool("send_template", {
          chat_id: personal,
          name: "hello_world",
          language: "en_US",
        })
      ).isError,
    ).not.toBe(true);
    expect(graphSends()[1].type).toBe("template");

    send({
      jsonrpc: "2.0",
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "request-one",
        tool_name: "Bash",
        description: "Fixture approval",
        input_preview: '{"command":"echo fixture"}',
      },
    });
    await until(() => graphSends().length === 3);
    expect(graphSends()[2].to).toBe("886900000001");
    await deliver("886900000002", "forged-reaction", "👍", "sent-3");
    await pause(100);
    expect(
      notifications.some(
        (entry) => entry.method === "notifications/claude/channel/permission",
      ),
    ).toBe(false);
    await deliver("886900000001", "owner-reaction", "👍", "sent-3");
    await until(() =>
      notifications.some(
        (entry) =>
          entry.method === "notifications/claude/channel/permission" &&
          entry.params.request_id === "request-one",
      ),
    );
    writeFileSync(accessPath, JSON.stringify({ ...access, allowFrom: [] }));
    send({
      jsonrpc: "2.0",
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "request-two",
        tool_name: "Bash",
        description: "Revoked approval",
        input_preview: '{"command":"echo revoked"}',
      },
    });
    await until(() =>
      stderr.includes("permission_request request-two not sent"),
    );
    expect(graphSends()).toHaveLength(3);

    const business = "886900000000@s.whatsapp.net";
    writeFileSync(
      accessPath,
      JSON.stringify({
        ...access,
        allowFrom: [personal, business],
        owner: business,
      }),
    );
    expect(text(await tool("status"))).toContain("missing or revoked");
    send({
      jsonrpc: "2.0",
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "request-self",
        tool_name: "Bash",
        description: "Self-chat must refuse",
        input_preview: "fixture",
      },
    });
    await until(() =>
      stderr.includes("permission_request request-self not sent"),
    );
    expect(graphSends()).toHaveLength(3);

    writeFileSync(
      accessPath,
      JSON.stringify({ ...access, docModeThreshold: 6 }),
    );
    expect(
      (await tool("reply", { chat_id: personal, text: "# Markdown reply" }))
        .isError,
    ).not.toBe(true);
    const uploads = () =>
      readFileSync(graphLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.uploadMime);
    expect(uploads().at(-1).uploadMime.split(";")[0]).toBe("text/plain");
    expect(graphSends().at(-1).type).toBe("document");
    const video = join(dir, "inbox", "clip.mp4");
    writeFileSync(video, Buffer.from("fixture-video"));
    expect(
      (await tool("reply", { chat_id: personal, text: "", files: [video] }))
        .isError,
    ).not.toBe(true);
    expect(uploads().at(-1).uploadMime).toBe("video/mp4");
    expect(graphSends().at(-1).type).toBe("video");
    const audio = join(dir, "inbox", "voice.mp3");
    writeFileSync(audio, Buffer.from("fixture-audio"));
    expect(
      (await tool("reply", { chat_id: personal, text: "", files: [audio] }))
        .isError,
    ).not.toBe(true);
    expect(uploads().at(-1).uploadMime).toBe("audio/mpeg");
    expect(graphSends().at(-1).type).toBe("audio");

    secondary = spawn(
      "bun",
      ["--preload", preload, join(import.meta.dir, "..", "server.ts")],
      { env: environment, stdio: ["pipe", "pipe", "pipe"] },
    );
    let secondaryError = "";
    secondary.stderr?.on("data", (data) => {
      secondaryError += data;
    });
    await until(() => secondaryError.includes("ipc: connected to primary"));
    expect(secondaryError).not.toContain("Official Cloud API listener ready");
    expect(secondaryError).not.toContain("webhook listener could not start");
    expect(stderr).not.toContain("test-access-token");
    expect(stderr).not.toContain("test-app-secret");
  } finally {
    const stop = async (process: ReturnType<typeof spawn>) => {
      if (process.exitCode !== null) return;
      process.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => process.once("exit", resolve)),
        pause(3000),
      ]);
      if (process.exitCode === null) process.kill("SIGKILL");
    };
    if (secondary) await stop(secondary);
    await stop(child);
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
