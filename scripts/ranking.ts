// Pure ranking/resolution logic for the access wizard, pulled out of
// access.ts so it's unit-testable without spawning a real subprocess for
// every case - access.ts's top-level switch executes immediately on any
// import (same class of problem server.ts has, see its own comments on
// why mentions.ts/contacts.ts/mask.ts were extracted the same way).
import { type ContactsMap } from "./contacts";
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

// Shared by rankGroups and listConfiguredGroups so the label format can
// never drift between "what's new" and "what's already on".
function groupLabel(g: GroupMeta): string {
  return `${g.name}  (${g.memberCount} member(s))${g.archived ? "  [archived]" : ""}`;
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
    .map(([jid, g]) => ({ jid, label: groupLabel(g) }));
}

// Every group already in access.json's groups map, not just the top N new
// ones - this is "what's already on" for a revoke screen, so no recency
// sort, no archive filter and no limit (see listConfiguredGroups/manage in
// skills/access/SKILL.md). A configured group with no meta.json entry still
// has to appear (falls back to the raw JID) or it becomes unrevokable.
export function listConfiguredGroups(
  groups: Readonly<Record<string, unknown>>,
  meta: Record<string, GroupMeta>,
): Candidate[] {
  return Object.keys(groups)
    .map((jid) => ({ jid, label: meta[jid] ? groupLabel(meta[jid]) : jid }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// A candidate is only ever a chat with real activity (dmActivity is only
// ever written for a chat that's actually exchanged a message) - never the
// whole phone contact list, which is exactly what keeps this from ever
// asking about hundreds of never-messaged contacts.
//
// Deliberately does NOT use contacts.ts's contactName() (its name-or-notify
// fallback is fine for passive display elsewhere, see mask.ts's own
// comment) - here the label decides who gets DM access under a banner that
// says the decision is AI-free, so a `.notify` label needs to look
// different from a `.name` one, not just fall back silently. `.notify` is
// self-reported by anyone who's ever messaged the account (see contacts.ts)
// - dm-activity.json/contacts.json get populated by ungated Baileys events
// even for senders the access gate already rejected, so an unknown number
// that DMs once with push name "Mum" would otherwise rank and read
// identically to an actually-saved contact. A `.name` entry only exists
// because the account owner saved it themselves, so it's shown plain; a
// `.notify`-only entry is marked unverified and paired with the masked
// number, so approving it is a visibly different decision. Shared by
// rankDms and listConfiguredDms below via dmLabel.
function dmLabel(contacts: ContactsMap, key: string): string {
  const entry = contacts[key];
  const masked = maskNumber(key);
  if (entry?.name && !looksLikeNumber(entry.name)) return entry.name;
  if (entry?.notify && !looksLikeNumber(entry.notify)) {
    return `${entry.notify} (unverified) - ${masked}`;
  }
  return masked;
}

// See dmLabel above for why a `.notify`-only label is marked unverified
// rather than shown like a saved name.
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
    .map(([jid]) => ({ jid, label: dmLabel(contacts, jid) }));
}

// Every DM contact already in allowFrom, not just the top N new ones - the
// revoke-screen counterpart to listConfiguredGroups. One candidate per
// allowFrom entry, no filtering, no dedupe: if both a @lid and a phone form
// of the same contact are allowlisted, they are two separate revokable
// strings and both must appear.
export function listConfiguredDms(
  allowFrom: readonly string[],
  contacts: ContactsMap,
  lidMap: Record<string, string>,
): Candidate[] {
  return allowFrom
    .map((jid) => {
      const key = contactKeyFor(lidMap, jid);
      // Candidate.jid stays the original, unresolved allowFrom string
      // (not the LID-resolved key used for the label lookup): revoke
      // filters allowFrom by exact string match, so returning the
      // resolved key here would silently fail to remove a @lid-form
      // entry.
      return { jid, label: dmLabel(contacts, key) };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
