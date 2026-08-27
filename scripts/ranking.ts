// Pure ranking/resolution logic for the access wizard, pulled out of
// access.ts so it's unit-testable without spawning a real subprocess for
// every case - access.ts's top-level switch executes immediately on any
// import (same class of problem server.ts has, see its own comments on
// why mentions.ts/contacts.ts/mask.ts were extracted the same way).
import { type ContactsMap } from "./contacts";
import { groupAnchor, looksLikeNumber, maskNumber } from "./mask";

export type GroupMeta = {
  name: string;
  memberCount: number;
  archived: boolean;
  lastActivityAt?: number;
  updatedAt: number;
};

// `description` is the identity anchor rendered under the label on the
// picker screen: the raw JID for a group (a g.us id is not personal data),
// the MASKED number for a contact (a raw one is exactly what mask.ts exists
// to keep out of a transcript). Built here, next to the label, so no caller
// has to re-derive the rule and get it wrong - the old prose spec in
// skills/access/SKILL.md did.
export type Candidate = {
  jid: string;
  label: string;
  description: string;
};

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

// A group name and a self-reported contact name are both attacker-chosen
// and unbounded, and a label too long for its option used to be the
// caller's problem to truncate - which broke the one thing the label has to
// guarantee, since disambiguate() APPENDS its suffix and truncating the end
// removes it. Clipping the name here instead keeps every label inside a
// predictable bound (name + count + tags + suffix stays under ~90 chars),
// runs BEFORE disambiguate() so two names that clip to the same string are
// still separated, and leaves no truncation rule for a caller to get wrong.
const NAME_LIMIT = 40;
function clip(name: string): string {
  return name.length <= NAME_LIMIT ? name : name.slice(0, NAME_LIMIT - 1) + "…";
}

// Shared by rankGroups and listConfiguredGroups so the label format can
// never drift between "what's new" and "what's already on".
function groupLabel(g: GroupMeta): string {
  return `${clip(g.name)}  (${g.memberCount} member(s))${g.archived ? "  [archived]" : ""}`;
}

// The picker screen (scripts/picker.ts) selects by jid, not by label, but a
// human still has to be able to tell two rows apart on screen to know which
// one they are ticking or unticking - two candidates that render identically
// read as one option to look at, even though the tick underneath is correct.
// Three real ways they collide: two contacts saved under the same name, two
// groups sharing a name and member count, and the @lid and phone forms of ONE
// contact in allowFrom (both resolve to the same key, so dmLabel returns the
// same string by construction - see listConfiguredDms).
// Appends the masked JID, so a human can see which row is which, plus an
// ordinal, so the label is unique even when two JIDs share their last four
// digits. Never the raw JID - that is the whole point of mask.ts. Applied
// to every list this module returns rather than at the call site, so a new
// caller cannot forget it.
function disambiguate(candidates: Candidate[]): Candidate[] {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return candidates.map((c) => {
    if ((counts.get(c.label) ?? 0) < 2) return c;
    const n = (seen.get(c.label) ?? 0) + 1;
    seen.set(c.label, n);
    return { ...c, label: `${c.label}  [${n}: ${maskNumber(c.jid)}]` };
  });
}

// Same recency signal WhatsApp's own app sorts its chat list by
// (conversationTimestamp, tracked into groupsMeta by server.ts - see
// applyChatActivity there). Undefined/never-seen activity sorts last,
// tie-broken alphabetically so the order is still deterministic rather
// than depending on object key iteration order.
//
// `limit` defaults to uncapped - the wizard ranks the whole pool so it can
// say how many did not fit, then slices for the screen.
export function rankGroups(
  meta: Record<string, GroupMeta>,
  alreadyConfigured: ReadonlySet<string>,
  includeArchived: boolean,
  limit: number = Infinity,
): Candidate[] {
  const ranked = Object.entries(meta)
    .filter(([jid]) => !alreadyConfigured.has(jid))
    .filter(([, g]) => includeArchived || !g.archived)
    .sort(([xj, x], [yj, y]) => {
      const diff = (y.lastActivityAt ?? 0) - (x.lastActivityAt ?? 0);
      // JID last: two groups can share a name as well as a timestamp, and
      // an order that then falls back to object key iteration is not
      // deterministic - which matters here, because disambiguate() numbers
      // colliding labels by position.
      return diff !== 0
        ? diff
        : x.name.localeCompare(y.name) || xj.localeCompare(yj);
    })
    .slice(0, limit)
    .map(([jid, g]) => ({
      jid,
      label: groupLabel(g),
      description: groupAnchor(jid),
    }));
  return disambiguate(ranked);
}

// Every group already in access.json's groups map, not just the top N new
// ones - this is "what's already on" for a revoke screen, so no recency
// sort, no archive filter and no limit (the picker's pre-ticked column). A
// configured group with no meta.json entry still
// has to appear (falls back to the raw JID) or it becomes unrevokable.
export function listConfiguredGroups(
  groups: Readonly<Record<string, unknown>>,
  meta: Record<string, GroupMeta>,
): Candidate[] {
  const listed = Object.keys(groups)
    .map((jid) => ({
      jid,
      // The no-meta fallback shows the anchor too, not the raw JID: a
      // configured legacy group with nothing cached about it would
      // otherwise print its creator's phone number as its label.
      label: meta[jid] ? groupLabel(meta[jid]) : groupAnchor(jid),
      description: groupAnchor(jid),
    }))
    .sort(
      (a, b) => a.label.localeCompare(b.label) || a.jid.localeCompare(b.jid),
    );
  return disambiguate(listed);
}

// The pool is DM activity PLUS the saved names WhatsApp's contact sync
// delivered (contacts.json `.name` only). That is the owner's own address
// book, synced by the server, never sent anywhere - so a contact who has
// never DM'd this number is still findable by name (fork #17: `Search:
// Thilian` -> `(none)`).
//
// A `.notify`-only entry is still OUT of the pool. `.notify` is
// self-reported by anyone who has ever messaged the account, so admitting
// it would let a stranger put themselves on a grant screen just by
// choosing a display name. Saved names cannot be set by the contact.
//
// Order: activity first (recency, the signal WhatsApp's own chat list
// uses), then the address book alphabetically - a never-messaged contact
// is a search target, not a ranked suggestion.
//
// LID collapsing: one person under @lid and phone forms is one row.
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
  if (entry?.name && !looksLikeNumber(entry.name)) return clip(entry.name);
  if (entry?.notify && !looksLikeNumber(entry.notify)) {
    return `${clip(entry.notify)} (unverified) - ${masked}`;
  }
  return masked;
}

// See dmLabel above for why a `.notify`-only label is marked unverified
// rather than shown like a saved name.
//
// `limit` defaults to uncapped - the wizard ranks the whole pool so it can
// say how many did not fit, then slices for the screen.
export function rankDms(
  activity: Record<string, number>,
  contacts: ContactsMap,
  allowFrom: readonly string[],
  lidMap: Record<string, string>,
  limit: number = Infinity,
): Candidate[] {
  const alreadyAllowed = new Set(
    allowFrom.map((jid) => contactKeyFor(lidMap, jid)),
  );
  const seen = new Set<string>();
  const activityRows = Object.entries(activity)
    .filter(([jid]) => !alreadyAllowed.has(jid))
    .sort(([aj, a], [bj, b]) => b - a || aj.localeCompare(bj))
    .map(([jid]) => {
      seen.add(jid);
      return {
        jid,
        label: dmLabel(contacts, jid),
        description: maskNumber(jid),
      };
    });
  const addressBookRows: Candidate[] = [];
  for (const [raw, entry] of Object.entries(contacts)) {
    if (!entry?.name) continue;
    const resolved = contactKeyFor(lidMap, raw);
    if (alreadyAllowed.has(resolved) || seen.has(resolved)) continue;
    seen.add(resolved);
    addressBookRows.push({
      jid: resolved,
      label: dmLabel(contacts, contacts[resolved] ? resolved : raw),
      description: maskNumber(resolved),
    });
  }
  addressBookRows.sort(
    (a, b) => a.label.localeCompare(b.label) || a.jid.localeCompare(b.jid),
  );
  return disambiguate([...activityRows, ...addressBookRows].slice(0, limit));
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
  const listed = allowFrom
    .map((jid) => {
      const key = contactKeyFor(lidMap, jid);
      // Candidate.jid stays the original, unresolved allowFrom string
      // (not the LID-resolved key used for the label lookup): revoke
      // filters allowFrom by exact string match, so returning the
      // resolved key here would silently fail to remove a @lid-form
      // entry. The description masks the RESOLVED key, since that is the
      // identity being revoked; disambiguate() masks the raw entry, which
      // is what tells the @lid row apart from the phone one.
      return {
        jid,
        label: dmLabel(contacts, key),
        description: maskNumber(key),
      };
    })
    .sort(
      (a, b) => a.label.localeCompare(b.label) || a.jid.localeCompare(b.jid),
    );
  return disambiguate(listed);
}

// The +/- delta the picker shows before it writes anything, and what `review`
// and `undo` report afterwards. Also the body of `undo --dry-run`. Pure: takes two access.json snapshots, returns the
// JIDs that differ. A group whose `roster` flag changed is neither added nor
// removed and is deliberately NOT reported - review only offers roster for
// groups it is granting in the same run, so a roster-only change cannot arise
// here; add a `changed` bucket the day it can.
export type AccessSnapshot = {
  allowFrom?: readonly string[];
  groups?: Readonly<Record<string, unknown>>;
};
export type AccessDiff = {
  added: { groups: string[]; dms: string[] };
  removed: { groups: string[]; dms: string[] };
};
export function diffAccess(
  prev: AccessSnapshot,
  next: AccessSnapshot,
): AccessDiff {
  const prevGroups = new Set(Object.keys(prev.groups ?? {}));
  const nextGroups = new Set(Object.keys(next.groups ?? {}));
  const prevDms = new Set(prev.allowFrom ?? []);
  const nextDms = new Set(next.allowFrom ?? []);
  return {
    added: {
      groups: [...nextGroups].filter((g) => !prevGroups.has(g)).sort(),
      dms: [...nextDms].filter((d) => !prevDms.has(d)).sort(),
    },
    removed: {
      groups: [...prevGroups].filter((g) => !nextGroups.has(g)).sort(),
      dms: [...prevDms].filter((d) => !nextDms.has(d)).sort(),
    },
  };
}
