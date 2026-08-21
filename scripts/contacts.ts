// A linked device gets the phone's real contact list synced to it, the same
// way WhatsApp Web does - Baileys exposes this as `contacts.upsert` /
// `contacts.update` events (see server.ts). This module only holds the pure
// merge/read logic so it's unit-testable without server.ts's connect-on-import
// side effects; server.ts owns the actual persisted map and event wiring.
export type ContactEntry = { name?: string; notify?: string };
export type ContactsMap = Record<string, ContactEntry>;

// `.name` is what the account owner saved on their own WhatsApp - trusted,
// only they can set it. `.notify` is the display name the contact chose for
// themself - self-reported, so it must never silently override or collide
// with `.name`. Kept as two separate fields all the way through so a reader
// can enforce that priority instead of one field quietly picking a winner.
export function mergeContact(
  map: ContactsMap,
  jid: string,
  update: ContactEntry,
): boolean {
  const existing = map[jid] ?? {};
  // `||`, not `??`: an explicit empty string in an update means "nothing
  // provided" here, same as absent - never a real name, so it must not
  // erase an existing trusted one (WhatsApp signals "not saved" by
  // omitting the field, not by sending "").
  const merged: ContactEntry = {
    name: update.name || existing.name,
    notify: update.notify || existing.notify,
  };
  if (merged.name === existing.name && merged.notify === existing.notify) {
    return false;
  }
  map[jid] = merged;
  return true;
}

// Saved name wins outright over a self-reported one; only falls back to
// `.notify` for someone never saved. Never a bare number - callers with no
// entry get undefined and decide their own fallback.
export function contactName(map: ContactsMap, jid: string): string | undefined {
  const entry = map[jid];
  return entry?.name || entry?.notify;
}

// A contact cached under its raw @lid key (before Baileys' lid-mapping.update
// told us the matching phone number) would otherwise be permanently
// unfindable once server.ts's contactKey() starts resolving that LID to its
// phone number instead - move the entry to the key contactKey() will
// actually compute from now on. Whatever's already at the new key wins over
// the migrating (old-key) entry on any real conflict - there's no reliable
// way to know which of the two is fresher, so the migrated entry only fills
// gaps the new key doesn't already have; it never overwrites a value that's
// already there. Not mergeContact() (its `update` argument always wins),
// since that's the exact opposite priority this needs.
export function migrateContactKey(
  map: ContactsMap,
  oldKey: string,
  newKey: string,
): boolean {
  if (oldKey === newKey) return false;
  const stale = map[oldKey];
  if (!stale) return false;
  delete map[oldKey];
  const current = map[newKey] ?? {};
  map[newKey] = {
    name: current.name || stale.name,
    notify: current.notify || stale.notify,
  };
  return true;
}

// Removes a contact's cached name entirely - used when access is
// explicitly REVOKED, never when someone is simply never granted it in
// the first place (declining to select someone during onboarding was
// never a decision to forget them - their name just stays passively
// cached, the same as anything else WhatsApp's own sync already sent).
//
// Deliberately does NOT touch lid-map.json. That file is pure routing
// (LID <-> phone correlation), never shown to a human or an AI anywhere in
// this codebase, and needed for correct message/mention matching if this
// person is still an active participant in a group the account can still
// see. Only the display-relevant name is what "forgetting" someone means -
// blocking them or removing them from a shared group isn't something this
// plugin does, so their WhatsApp-side presence there is unaffected either
// way; this only controls what gets shown for them going forward (a
// masked number instead of a name, same as any other unknown participant).
export function forgetContact(map: ContactsMap, jid: string): boolean {
  if (!(jid in map)) return false;
  delete map[jid];
  return true;
}

export type NameResolution =
  | { ok: true; jid: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "ambiguous"; candidates: string[] };

// NOT the inverse of contactName(): this only matches `.name`, deliberately
// stricter than contactName()'s name-or-notify display fallback. `.notify`
// is self-reported by anyone who's ever messaged the account - untrusted -
// so matching it here would let an attacker set their own display name to a
// real person's phone number and silently hijack any attempt to mention
// that number to their own jid instead (no error, since it's a unique
// match). Display can afford to be permissive; resolving WHO a message
// actually goes to cannot. Case-insensitive, exact match only, no
// fuzzy/partial matching - two contacts sharing a saved name is a hard
// "ambiguous", never a coin-flip pick between them.
export function resolveByName(map: ContactsMap, name: string): NameResolution {
  const needle = name.trim().toLowerCase();
  if (!needle) return { ok: false, reason: "not_found" };
  const matches: string[] = [];
  for (const [jid, entry] of Object.entries(map)) {
    const candidate = (entry.name || "").trim().toLowerCase();
    if (candidate && candidate === needle) matches.push(jid);
  }
  if (matches.length === 0) return { ok: false, reason: "not_found" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", candidates: matches };
  return { ok: true, jid: matches[0] };
}
