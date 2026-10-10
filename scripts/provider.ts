#!/usr/bin/env bun
import { input, password, select } from "@inquirer/prompts";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCloudApiConfig } from "../lib/cloud-api";
import {
  channelProvider,
  configuredValue,
  parseStateEnv,
  stateEnvironment,
  updateStateEnv,
} from "../lib/provider";

const stateDir =
  process.env.WHATSAPP_STATE_DIR ?? join(homedir(), ".whatsapp-channel");
const envFile = join(stateDir, ".env");

async function main(): Promise<void> {
  const [command = "choose", requested] = process.argv.slice(2);
  const env = stateEnvironment(envFile);
  if (command === "status") {
    const provider = channelProvider(env);
    console.log(
      `Connection: ${provider === "baileys" ? "Linked device (Baileys)" : "Official WhatsApp Cloud API"}`,
    );
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
      "Usage: bun scripts/provider.ts [choose | status | set baileys | set cloud-api]",
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
          default: channelProvider(env),
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
  let raw = "";
  try {
    raw = readFileSync(envFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Preserve every unrelated key, including credentials for the other provider.
  const next = updateStateEnv(raw, updates);
  parseStateEnv(next);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${envFile}.${process.pid}.tmp`;
  writeFileSync(temporary, next, { mode: 0o600, flag: "wx" });
  renameSync(temporary, envFile);
  console.log(
    `Saved connection: ${provider}. Restart every Claude session using this state directory.`,
  );
  if (configuredValue(process.env.WHATSAPP_PROVIDER))
    console.log(
      "A process/plugin WHATSAPP_PROVIDER override is active; change it too for this selection to take effect.",
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
