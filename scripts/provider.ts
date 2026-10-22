#!/usr/bin/env bun
import { input, password, select } from "@inquirer/prompts";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCloudApiConfig } from "../lib/cloud-api";
import {
  type ChannelProvider,
  channelProvider,
  configuredValue,
  parseStateEnv,
  stateEnvironment,
  updateStateEnv,
} from "../lib/provider";

const stateDir =
  process.env.WHATSAPP_STATE_DIR ?? join(homedir(), ".whatsapp-channel");
const envFile = join(stateDir, ".env");

// Status and the picker must still render when the saved value is a typo;
// only `set` is strict, because it is the way out.
function savedProvider(
  env: Record<string, string | undefined>,
): ChannelProvider | null {
  try {
    return channelProvider(env);
  } catch {
    return null;
  }
}

// Atomic replace of the state .env: 0600 from the first byte, and a
// crashed write never leaves a half-written file behind the real one.
function writeStateEnv(next: string): void {
  parseStateEnv(next);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${envFile}.${process.pid}.tmp`;
  // A stale temp from a reused pid would make `wx` fail; a failed rename
  // must not leave a second copy of the credentials behind.
  rmSync(temporary, { force: true });
  writeFileSync(temporary, next, { mode: 0o600, flag: "wx" });
  try {
    renameSync(temporary, envFile);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readStateEnvRaw(): string {
  try {
    return readFileSync(envFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "";
  }
}

async function main(): Promise<void> {
  const [command = "choose", requested] = process.argv.slice(2);
  const env = stateEnvironment(envFile);
  // `phone <digits>` / `phone clear` is how the configure skill sets the
  // linked-device number. It exists so the skill never needs Read/Edit on
  // .env, which may now hold Cloud credentials that must not reach model
  // context. No TTY requirement: the value is not a secret.
  if (command === "phone") {
    const digits = requested?.trim();
    if (digits === "clear") {
      const kept = readStateEnvRaw()
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .filter((line) => !/^WHATSAPP_PHONE_NUMBER=/.test(line));
      while (kept.at(-1) === "") kept.pop();
      writeStateEnv(kept.length ? kept.join("\n") + "\n" : "");
      console.log("Cleared WHATSAPP_PHONE_NUMBER; other settings kept.");
      return;
    }
    if (!digits || !/^\d{5,20}$/.test(digits))
      throw new Error(
        "Usage: bun scripts/provider.ts phone <5-20 digits, no leading +> | clear",
      );
    writeStateEnv(
      updateStateEnv(readStateEnvRaw(), { WHATSAPP_PHONE_NUMBER: digits }),
    );
    console.log(
      `Saved WHATSAPP_PHONE_NUMBER (…${digits.slice(-4)}). Restart every Claude session using this state directory.`,
    );
    return;
  }
  if (command === "status") {
    const phone = configuredValue(env.WHATSAPP_PHONE_NUMBER);
    console.log(
      `Phone number: ${phone ? `set (…${phone.slice(-4)})` : "not set"}`,
    );
    const provider = savedProvider(env);
    if (!provider) {
      console.log(
        `Connection: invalid (${env.WHATSAPP_PROVIDER?.trim()}) — run: bun scripts/provider.ts set baileys|cloud-api`,
      );
      return;
    }
    console.log(
      `Connection: ${provider === "baileys" ? "Linked device (Baileys)" : "Official WhatsApp Cloud API"}`,
    );
    if (provider === "baileys") {
      let auth = "not paired";
      try {
        const credentials = JSON.parse(
          readFileSync(join(stateDir, ".baileys_auth", "creds.json"), "utf8"),
        );
        if (credentials?.registered === true) auth = "paired";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          auth = "unavailable (invalid or unreadable)";
      }
      console.log(`Linked-device auth: ${auth}`);
    }
    if (provider === "cloud-api") {
      try {
        readCloudApiConfig(env);
        console.log(
          "Cloud API configuration: complete (not a connection test)",
        );
      } catch (error) {
        console.log(
          `Cloud API configuration: ${error instanceof Error ? error.message : "incomplete"}`,
        );
      }
    }
    return;
  }
  if (command !== "choose" && command !== "set")
    throw new Error(
      "Usage: bun scripts/provider.ts [choose | status | set baileys | set cloud-api | phone <digits>|clear]",
    );
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Run the provider setup in your own interactive terminal. Credentials must not be sent through chat.",
    );
  const provider =
    command === "set"
      ? channelProvider({ WHATSAPP_PROVIDER: requested ?? "invalid" })
      : await select({
          message: "Choose your WhatsApp connection",
          default: savedProvider(env) ?? "baileys",
          choices: [
            {
              value: "baileys",
              name: "Linked device (Baileys) — personal account and existing groups; unofficial",
            },
            {
              value: "cloud-api",
              name: "Official Cloud API — business DMs; Meta setup, messaging rules and fees apply",
            },
          ],
        });
  const updates: Record<string, string> = { WHATSAPP_PROVIDER: provider };
  if (provider === "cloud-api") {
    console.log(
      "This mode supports business DMs. Groups, message editing, phone history and address-book sync are unavailable.",
    );
    console.log(
      "Free-form replies require an open 24-hour service window; otherwise use an approved template. Meta fees and AI-provider restrictions apply.",
    );
    for (const [key, label, secret] of [
      [
        "WHATSAPP_CLOUD_PHONE_NUMBER_ID",
        "Meta phone number ID (not the phone number)",
        false,
      ],
      ["WHATSAPP_CLOUD_ACCESS_TOKEN", "Cloud API access token", true],
      [
        "WHATSAPP_CLOUD_APP_SECRET",
        "Meta app secret (webhook signature validation)",
        true,
      ],
      [
        "WHATSAPP_CLOUD_VERIFY_TOKEN",
        "Webhook verify token (choose your own)",
        true,
      ],
    ] as const) {
      const present = !!configuredValue(env[key]);
      const message = `${label}${present ? " (leave blank to keep existing)" : ""}`;
      const value = (
        secret
          ? await password({ message, mask: true })
          : await input({ message })
      ).trim();
      if (value) updates[key] = value;
      else if (!present)
        throw new Error(`${key} is required; configuration was not changed`);
    }
    readCloudApiConfig({ ...env, ...updates });
  }
  // Preserve every unrelated key, including credentials for the other provider.
  writeStateEnv(updateStateEnv(readStateEnvRaw(), updates));
  console.log(
    `Saved connection: ${provider}. Restart every Claude session using this state directory.`,
  );
  console.log(
    `Values saved in ${envFile} take precedence over plugin /config settings for the keys it contains. To return a setting to plugin management, remove its key from that file.`,
  );
  if (provider === "cloud-api") {
    console.log(
      "Expose the local /webhook endpoint through HTTPS, configure Meta's callback/verify token and subscribe this WABA to messages.",
    );
    console.log(
      "Add your personal contact using /whatsapp-channel:access, then set it as owner. Cloud API does not auto-allowlist the business number.",
    );
    console.log(
      "See docs/cloud-api.md for setup, supported features and policy requirements.",
    );
  }
}

if (import.meta.main)
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Provider setup failed",
    );
    process.exitCode = 1;
  });
