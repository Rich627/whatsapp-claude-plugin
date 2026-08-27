// Pure ranking/resolution logic for the access wizard, pulled out of
// access.ts so it's unit-testable without spawning a real subprocess for
// every case - access.ts's top-level switch executes immediately on any
// import (same class of problem server.ts has, see its own comments on
// why mentions.ts/contacts.ts/mask.ts were extracted the same way).
import { createHash } from "node:crypto";
import { type ContactsMap } from "./contacts";
import { groupAnchor, looksLikeNumber, maskNumber } from "./mask";

export type GroupMeta = {
  name: string;
  memberCount: number;
  archived: boolean;
  lastActivityAt?: number;
  updatedAt: number;
  // Participant JIDs of a group the owner granted roster access to, written by
  // the server (never by this script) - phone-resolved and normalised, names
  // resolved here at read time through the contacts cache. Absent for every
  // group without roster access.
  members?: string[];
};

// `description` is the identity anchor rendered under the label on the
// in-session review/manage screens: the raw JID for a group (a g.us id is
// not personal data), the MASKED number for a contact (a raw one is
// exactly what mask.ts exists to keep out of a transcript). Built here,
// next to the label, so no caller has to re-derive the rule and get it
// wrong - the old prose spec in skills/access/SKILL.md did.
export type Candidate = {
  jid: string;
  ref: string;
  label: string;
  description: string;
};

// What a JSON-emitting subcommand prints. `jid` is deliberately absent: for a
// DM it is the full phone number, and for a LEGACY `<phone>-<ts>@g.us` group
// it contains one, so "the model sees a name and a masked number only" is only
// literally true if the raw JID never leaves the process. A modern group's JID
// is still visible - as `description`, which is groupAnchor()'s output and is
// masked for the legacy form.
export type PublicCandidate = {
  ref: string;
  label: string;
  description: string;
};

export function publicCandidates(
  list: readonly Candidate[],
): PublicCandidate[] {
  return list.map(({ ref, label, description }) => ({
    ref,
    label,
    description,
  }));
}

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

// A short, stable, opaque handle for one JID - the ONLY identifier the
// in-session review/manage screens (a model, and a transcript) ever see for a
// contact. `description` masks the number for a human; `ref` is what the skill
// passes back to `allow --ref` / `remove --ref` / `group add --ref` /
// `group rm --ref`, so no code path needs the raw JID in the model's context
// at all. Content-derived, not positional: a ref stays valid across writes, so
// the refs collected before an Apply still resolve after the first command has
// changed which pool an entry sits in.
//
// ponytail: a pseudonym, not a secret. Anyone who already knows the number can
// recompute the same hash; the job is keeping the number out of the
// transcript, not being unguessable. Salting it would break stability across
// runs, which the flow depends on.
const REF_LENGTH = 12;
export function refFor(jid: string): string {
  return createHash("sha256")
    .update(normalizeJid(jid))
    .digest("hex")
    .slice(0, REF_LENGTH);
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

// AskUserQuestion - the checkbox UI behind the in-session `review`/`manage`
// screens - returns a selection BY ITS LABEL, so two candidates that render
// identically cannot be told apart once ticked: the wrong one gets revoked,
// or both do. Three real ways they collide: two contacts saved under the
// same name, two groups sharing a name and member count, and the @lid and
// phone forms of ONE contact in allowFrom (both resolve to the same key, so
// dmLabel returns the same string by construction - see listConfiguredDms).
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
      ref: refFor(jid),
      label: groupLabel(g),
      description: groupAnchor(jid),
    }));
  return disambiguate(ranked);
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
  const listed = Object.keys(groups)
    .map((jid) => ({
      jid,
      ref: refFor(jid),
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
  memberPool: readonly string[] = [],
): Candidate[] {
  const alreadyAllowed = new Set(
    allowFrom.map((jid) => contactKeyFor(lidMap, jid)),
  );
  const entries = Object.entries(activity);
  const seen = new Set(entries.map(([k]) => k));
  for (const raw of memberPool) {
    const key = contactKeyFor(lidMap, raw);
    if (seen.has(key)) continue;
    seen.add(key);
    // 0, not Date.now(): a member with no DM on record has no activity, and the
    // existing comparator sorts it after every chat that does, tie-broken by
    // JID. Ordering is explicitly out of scope for this change - search is how
    // you reach a specific member, exactly as it is for a group.
    entries.push([key, 0]);
  }
  const ranked = entries
    .filter(([jid]) => !alreadyAllowed.has(jid))
    .sort(([aj, a], [bj, b]) => b - a || aj.localeCompare(bj))
    .slice(0, limit)
    .map(([jid]) => ({
      jid,
      ref: refFor(jid),
      label: dmLabel(contacts, jid),
      description: maskNumber(jid),
    }));
  return disambiguate(ranked);
}

// The search prompt's source (access.ts's wizard). Case-insensitive substring
// over the two strings already on screen: the label, and the description -
// a group's description IS its JID, the identity anchor, and a contact's is
// the masked number, so typing either finds the row. Plain `includes`, never
// a RegExp built from the term: the term and the labels are both
// attacker-influenced text, and a term like `.*` or `(a+)+` has to stay a
// literal search rather than become a pattern. Returns the SAME candidate
// objects in the SAME (ranked) order - this never builds a candidate, so
// nothing here can invent or alter a JID.
export function filterCandidates(
  pool: readonly Candidate[],
  term: string | undefined,
): Candidate[] {
  const needle = (term ?? "").trim().toLowerCase();
  if (!needle) return [...pool];
  return pool.filter(
    (c) =>
      c.label.toLowerCase().includes(needle) ||
      c.description.toLowerCase().includes(needle),
  );
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
        ref: refFor(jid),
        label: dmLabel(contacts, key),
        description: maskNumber(key),
      };
    })
    .sort(
      (a, b) => a.label.localeCompare(b.label) || a.jid.localeCompare(b.jid),
    );
  return disambiguate(listed);
}

// The wizard's one screen per kind (#14, terminal half): what is already
// configured comes first and ticked - so the screen SHOWS current state, and
// unticking IS the revoke - then the ranked candidates that fit, unticked.
// Configured entries never count against `cap` and are never sliced away: an
// entry the screen hid could not be unticked, and a revoke you cannot reach is
// exactly the bug a cap over the merged list would introduce. `cap` therefore
// applies to `candidates` alone - the same number capLine() discloses.
// Pure: no I/O, no ranking, no relabelling. Every string here is whatever
// rankGroups/listConfiguredGroups (or the DM pair) already produced, so a
// label rule still lives in exactly one place.
export type WizardChoice = {
  value: string;
  name: string;
  description: string;
  checked: boolean;
};

export function mergePools(
  candidates: readonly Candidate[],
  configured: readonly Candidate[],
  cap: number,
): WizardChoice[] {
  const choice = (c: Candidate, checked: boolean): WizardChoice => ({
    value: c.jid,
    name: c.label,
    description: c.description,
    checked,
  });
  const taken = new Set(configured.map((c) => c.jid));
  return [
    ...configured.map((c) => choice(c, true)),
    // Filtered BEFORE the slice: a duplicate must not eat a cap slot. The same
    // jid in both pools should be impossible (rankGroups/rankDms each exclude
    // what is configured) - filtered anyway, because two checkbox rows sharing
    // a `value` cannot be told apart once ticked.
    ...candidates
      .filter((c) => !taken.has(c.jid))
      .slice(0, cap)
      .map((c) => choice(c, false)),
  ];
}

// The +/- delta the in-session review shows before it writes anything, and the
// body of `undo --dry-run`. Pure: takes two access.json snapshots, returns the
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

// The member half of the DM candidate pool (#12): everyone in a group the
// owner granted `roster: true`, as JIDs the server already resolved and wrote
// into groups-meta.json (see server.ts's refreshGroupsMeta). Gated on the
// CURRENT access.json, not just on the presence of the key, so a `members`
// array left behind by a revoked grant can never widen the pool.
export function rosterMemberPool(
  meta: Record<string, GroupMeta>,
  groups: Readonly<Record<string, { roster?: boolean }>>,
): string[] {
  const pool: string[] = [];
  const seen = new Set<string>();
  for (const jid of Object.keys(groups)) {
    if (groups[jid]?.roster !== true) continue;
    for (const member of meta[jid]?.members ?? []) {
      if (seen.has(member)) continue;
      seen.add(member);
      pool.push(member);
    }
  }
  return pool;
}
