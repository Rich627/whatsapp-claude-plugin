#!/usr/bin/env bun
// Only safe onboarding context is emitted; credential values never leave this process.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCloudApiConfig } from "../lib/cloud-api";
import { channelProvider, stateEnvironment } from "../lib/provider";

const stateDir =
  process.env.WHATSAPP_STATE_DIR ?? join(homedir(), ".whatsapp-channel");
let message = "";
try {
  const env = stateEnvironment(join(stateDir, ".env"));
  if (channelProvider(env) === "baileys") process.exit(0);
  let configured = false;
  try {
    readCloudApiConfig(env);
    configured = true;
  } catch {}
  let hasOwner = false;
  let hasContacts = false;
  try {
    const access = JSON.parse(
      readFileSync(join(stateDir, "access.json"), "utf8"),
    );
    hasContacts =
      Array.isArray(access.allowFrom) && access.allowFrom.length > 0;
    hasOwner =
      hasContacts &&
      typeof access.owner === "string" &&
      /^\d{5,20}@s\.whatsapp\.net$/.test(access.owner) &&
      access.allowFrom?.includes(access.owner);
  } catch {}
  message = configured
    ? "Official WhatsApp Cloud API configuration is present. This does not verify inbound webhook delivery. Confirm the public HTTPS callback, verify token, app-secret signature validation and WABA messages subscription, then test an approved personal DM."
    : "Official WhatsApp Cloud API is selected but its configuration is incomplete or invalid. Run /whatsapp-channel:configure provider cloud-api in your own terminal to enter credentials privately; never paste access tokens, app secrets or verify tokens into chat. No phone pairing or QR scan is needed.";
  if (!hasContacts)
    message +=
      " No contacts are allowlisted yet. Add your personal number with /whatsapp-channel:access allow <digits>@s.whatsapp.net. Cloud API has no address-book import.";
  if (!hasOwner)
    message +=
      " Set an explicitly allowlisted personal owner with /whatsapp-channel:access set owner <digits>@s.whatsapp.net; the business number is never auto-added as owner.";
  else
    message +=
      " Runtime status must confirm the configured owner differs from the business number.";
  message +=
    " This provider supports DMs only in this plugin. Ordinary replies need the 24-hour service window; outside it use an approved send_template. Configuration changes are terminal-only.";
  if (configured && hasContacts && hasOwner) {
    try {
      const notice = execFileSync(
        "bun",
        [join(import.meta.dir, "update-notice.ts"), message],
        {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      if (notice) {
        console.log(notice);
        process.exit(0);
      }
    } catch {}
  }
} catch {
  message =
    "WhatsApp provider configuration is invalid. Use /whatsapp-channel:configure provider to choose baileys or cloud-api from your own terminal. Do not paste credentials into chat.";
}
console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: message,
    },
  }),
);
