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
