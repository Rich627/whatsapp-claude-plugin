// Read receipts (blue ticks). server.ts connects to WhatsApp on import, so
// which message gets a receipt, and the key it is sent with, are decided
// here, where that is testable on its own; server.ts only hands the key to
// Baileys' sock.readMessages.

import type { WAMessageKey } from "@whiskeysockets/baileys";
import type { ChannelProvider } from "./provider";

// Off unless WHATSAPP_READ_RECEIPTS=1. A blue tick tells the sender their
// message was read, and turning that on for every delivered message is the
// owner's call, not a default an update should flip for them.
export function readReceiptsEnabled(raw: string | undefined): boolean {
  return raw?.trim() === "1";
}

function isGroup(jid: string): boolean {
  return jid.endsWith("@g.us");
}

// The key readMessages needs, or undefined when there is nothing to send.
// Baileys addresses a receipt by remoteJid + participant: a group message's
// receipt has to name its sender, or it goes to the group itself and the
// sender's ticks never turn blue. A DM receipt names nobody. Our own
// messages, status updates and channels never get one.
function receiptKey(key: WAMessageKey): WAMessageKey | undefined {
  const { remoteJid, id, participant } = key;
  if (!remoteJid || !id || key.fromMe) return undefined;
  if (remoteJid.endsWith("@broadcast") || remoteJid.endsWith("@newsletter"))
    return undefined;
  if (!isGroup(remoteJid)) return { remoteJid, id, fromMe: false };
  if (!participant) return undefined;
  return { remoteJid, id, fromMe: false, participant };
}

export interface DeliveredMessage {
  enabled: boolean;
  provider: ChannelProvider;
  /** gate()'s verdict. Only "deliver" means a chat on the allowlist. */
  gate: "deliver" | "drop" | "pair";
  /** Replayed from while we were offline: logged for catch_up, never pushed. */
  backlog: boolean;
  key: WAMessageKey;
}

/** The receipt to send for an inbound message, or undefined for none. */
export function autoReadKey(m: DeliveredMessage): WAMessageKey | undefined {
  // Cloud API: CloudApiSocket has no read-status call.
  if (!m.enabled || m.provider !== "baileys") return undefined;
  // A dropped sender, a pairing request or an unaddressed group message is
  // never marked read, and neither is backlog the agent has not been shown.
  if (m.gate !== "deliver" || m.backlog) return undefined;
  return receiptKey(m.key);
}

// The sender messages.jsonl recorded for an inbound message, found by the
// `{"id":<id>,` line prefix logContainsId relies on. It is what a group
// receipt needs once the in-memory key store has forgotten the message (a
// restart empties it). Lines we or the owner sent have no sender to name.
export function loggedSender(
  logText: string,
  chatId: string,
  messageId: string,
): string | undefined {
  if (!messageId) return undefined;
  const prefix = `{"id":${JSON.stringify(messageId)},`;
  for (const line of logText.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (
        entry.chat_id === chatId &&
        entry.direction !== "out" &&
        typeof entry.user_id === "string" &&
        entry.user_id
      )
        return entry.user_id;
    } catch {}
  }
  return undefined;
}

/**
 * The key mark_read sends. `stored` is the key this process kept for that id
 * (lost on restart); `sender` is the fallback from loggedSender; `sentByUs`
 * is whether the durable sent-id log has the id (an outbound DM id is never
 * in `stored`, so without it the synthesized key would pass as inbound).
 * Throws with
 * the reason when no receipt can be built.
 */
export function manualReadKey(
  chatId: string,
  messageId: string,
  stored?: WAMessageKey,
  sender?: string,
  sentByUs = false,
): WAMessageKey {
  if (!chatId || !messageId)
    throw new Error("mark_read needs chat_id and message_id");
  if (stored && stored.remoteJid !== chatId && stored.remoteJidAlt !== chatId)
    throw new Error(`message ${messageId} is not in chat ${chatId}`);
  if (stored?.fromMe || sentByUs)
    throw new Error(
      `message ${messageId} was sent by this account; only received messages can be marked read`,
    );
  const base = stored ?? { remoteJid: chatId, id: messageId, fromMe: false };
  const key = receiptKey({
    ...base,
    participant: base.participant || sender,
  });
  if (key) return key;
  if (isGroup(chatId))
    throw new Error(
      `can't mark ${messageId} read: a group receipt needs the sender, and none is on record for it (not in the recent store or the message log)`,
    );
  throw new Error(`chat ${chatId} does not take read receipts`);
}
