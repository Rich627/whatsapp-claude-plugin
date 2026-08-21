// Pure ranking/resolution logic for the access wizard, pulled out of
// access.ts so it's unit-testable without spawning a real subprocess for
// every case - access.ts's top-level switch executes immediately on any
// import (same class of problem server.ts has, see its own comments on
// why mentions.ts/contacts.ts/mask.ts were extracted the same way).
import { contactName, type ContactsMap } from "./contacts";
import { looksLikeNumber, maskNumber } from "./mask";

export type GroupMeta = {
  name: string;
  memberCount: number;
  archived: boolean;
  lastActivityAt?: number;
  updatedAt: number;
};

export type Candidate = { jid: string; label: string };

// No live WhatsApp connection here (see access.ts's file header) and
// deliberately no Baileys import just for its JID string utilities -
// mirrors Baileys' own jidNormalizedUser exactly (see
// node_modules/@whiskeysockets/baileys/lib/WABinary/jid-utils.js): drops
// BOTH the ":device" and "_agent" parts of the user segment, and maps the
// legacy "@c.us" domain to "@s.whatsapp.net" - not just the device-suffix
// strip this used to do, which silently diverged from the real thing for
// any JID carrying an agent suffix or the c.us domain. Reading the same
// lid-map.json server.ts writes, so a key computed here always matches the
// one contacts.json/dm-activity.json are actually keyed under. Idempotent,
// so it's safe to apply before AND after a lidMap lookup.
export function normalizeJid(jid: string): string {
  const at = jid.indexOf("@");
  if (at < 0) return jid;
  const server = jid.slice(at + 1);
  const user = jid.slice(0, at).split(":")[0].split("_")[0];
  return `${user}@${server === "c.us" ? "s.whatsapp.net" : server}`;
}

export function contactKeyFor(
  lidMap: Record<string, string>,
  jid: string,
): string {
  const normalized = normalizeJid(jid);
  if (!normalized.endsWith("@lid")) return normalized;
  return normalizeJid(lidMap[normalized] ?? normalized);
}

// Same recency signal WhatsApp's own app sorts its chat list by
// (conversationTimestamp, tracked into groupsMeta by server.ts - see
// applyChatActivity there). Undefined/never-seen activity sorts last,
// tie-broken alphabetically so the order is still deterministic rather
// than depending on object key iteration order.
export function rankGroups(
  meta: Record<string, GroupMeta>,
  alreadyConfigured: ReadonlySet<string>,
  includeArchived: boolean,
  limit: number,
): Candidate[] {
  return Object.entries(meta)
    .filter(([jid]) => !alreadyConfigured.has(jid))
    .filter(([, g]) => includeArchived || !g.archived)
    .sort(([, x], [, y]) => {
      const diff = (y.lastActivityAt ?? 0) - (x.lastActivityAt ?? 0);
      return diff !== 0 ? diff : x.name.localeCompare(y.name);
    })
    .slice(0, limit)
    .map(([jid, g]) => ({
      jid,
      label: `${g.name}  (${g.memberCount} member(s))${g.archived ? "  [archived]" : ""}`,
    }));
}

// A candidate is only ever a chat with real activity (dmActivity is only
// ever written for a chat that's actually exchanged a message) - never the
// whole phone contact list, which is exactly what keeps this from ever
// asking about hundreds of never-messaged contacts. Name shown when known
// and not number-shaped (same guarantee group_roster already gives - see
// scripts/mask.ts's looksLikeNumber), a masked number otherwise, never raw.
export function rankDms(
  activity: Record<string, number>,
  contacts: ContactsMap,
  allowFrom: readonly string[],
  lidMap: Record<string, string>,
  limit: number,
): Candidate[] {
  const alreadyAllowed = new Set(
    allowFrom.map((jid) => contactKeyFor(lidMap, jid)),
  );
  return Object.entries(activity)
    .filter(([jid]) => !alreadyAllowed.has(jid))
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([jid]) => {
      const name = contactName(contacts, jid);
      const label = name && !looksLikeNumber(name) ? name : maskNumber(jid);
      return { jid, label };
    });
}
