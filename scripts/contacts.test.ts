import { describe, expect, test } from "bun:test";
import {
  contactName,
  forgetContact,
  hasSavedName,
  mergeContact,
  migrateContactKey,
  pruneStrangers,
  resolveByName,
  SEEN_REFRESH_MS,
  STRANGER_TTL_MS,
  type ContactsMap,
} from "./contacts";

describe("mergeContact", () => {
  test("first sighting of a contact is stored", () => {
    const map: ContactsMap = {};
    const changed = mergeContact(map, "61400045973@s.whatsapp.net", {
      name: "Akash",
    });
    expect(changed).toBe(true);
    expect(map["61400045973@s.whatsapp.net"]).toEqual({ name: "Akash" });
  });

  test("an update with only notify doesn't erase an existing saved name", () => {
    const map: ContactsMap = {
      "61400045973@s.whatsapp.net": { name: "Akash" },
    };
    mergeContact(map, "61400045973@s.whatsapp.net", { notify: "aki_98" });
    expect(map["61400045973@s.whatsapp.net"]).toEqual({
      name: "Akash",
      notify: "aki_98",
    });
  });

  test("a name change (contact renamed later) overwrites the old one", () => {
    const map: ContactsMap = {
      "61400045973@s.whatsapp.net": { name: "Neha" },
    };
    mergeContact(map, "61400045973@s.whatsapp.net", { name: "Nehaaaa" });
    expect(contactName(map, "61400045973@s.whatsapp.net")).toBe("Nehaaaa");
  });

  test("an explicit empty-string name doesn't erase an existing saved name", () => {
    // WhatsApp signals "not saved" by omitting the field, never by sending
    // "" - so an empty string must be treated the same as absent, not as a
    // real update that wipes the trusted name.
    const map: ContactsMap = {
      "61400045973@s.whatsapp.net": { name: "Akash" },
    };
    mergeContact(map, "61400045973@s.whatsapp.net", {
      name: "",
      notify: "aki_98",
    });
    expect(map["61400045973@s.whatsapp.net"]).toEqual({
      name: "Akash",
      notify: "aki_98",
    });
  });

  test("no actual change reports false, doesn't churn the caller's save", () => {
    const map: ContactsMap = {
      "61400045973@s.whatsapp.net": { name: "Akash" },
    };
    const changed = mergeContact(map, "61400045973@s.whatsapp.net", {
      name: "Akash",
    });
    expect(changed).toBe(false);
  });
});

describe("mergeContact: the last-seen stamp", () => {
  const T = 1_756_000_000_000;
  const J = "61400000001@s.whatsapp.net";

  test("a nameless contact is stamped with when it was seen", () => {
    const map: ContactsMap = {};
    expect(mergeContact(map, J, { notify: "aki_98" }, T)).toBe(true);
    expect(map[J]).toEqual({ notify: "aki_98", seen: T });
  });

  test("a saved contact never carries a stamp, and gaining a name drops it", () => {
    const map: ContactsMap = {};
    mergeContact(map, J, { name: "Akash" }, T);
    expect(map[J].seen).toBeUndefined();
    const other = "61400000002@s.whatsapp.net";
    mergeContact(map, other, { notify: "roh" }, T);
    expect(map[other].seen).toBe(T);
    mergeContact(map, other, { name: "Rohan" }, T + 1);
    expect(map[other].seen).toBeUndefined();
  });

  test("the same sighting again inside a day is no change; a day later it refreshes", () => {
    const map: ContactsMap = {};
    mergeContact(map, J, { notify: "aki_98" }, T);
    expect(mergeContact(map, J, { notify: "aki_98" }, T + 1)).toBe(false);
    expect(map[J].seen).toBe(T);
    expect(
      mergeContact(map, J, { notify: "aki_98" }, T + SEEN_REFRESH_MS),
    ).toBe(true);
    expect(map[J].seen).toBe(T + SEEN_REFRESH_MS);
  });

  test("a changed display name is still a change inside the day", () => {
    const map: ContactsMap = {};
    mergeContact(map, J, { notify: "aki_98" }, T);
    expect(mergeContact(map, J, { notify: "aki_99" }, T + 1)).toBe(true);
    expect(map[J]).toEqual({ notify: "aki_99", seen: T + 1 });
  });
});

describe("contactName", () => {
  test("saved name wins over self-reported notify", () => {
    const map: ContactsMap = {
      x: { name: "Akash", notify: "aki_98" },
    };
    expect(contactName(map, "x")).toBe("Akash");
  });

  test("falls back to notify when there's no saved name", () => {
    const map: ContactsMap = { x: { notify: "aki_98" } };
    expect(contactName(map, "x")).toBe("aki_98");
  });

  test("unknown jid resolves to undefined, not a fabricated fallback", () => {
    expect(contactName({}, "unknown@s.whatsapp.net")).toBeUndefined();
  });
});

describe("migrateContactKey", () => {
  test("moves an entry from its old (lid) key to the new (phone) key", () => {
    const map: ContactsMap = {
      "184710990000999@lid": { name: "Rohan" },
    };
    const changed = migrateContactKey(
      map,
      "184710990000999@lid",
      "61400011675@s.whatsapp.net",
    );
    expect(changed).toBe(true);
    expect(map["184710990000999@lid"]).toBeUndefined();
    expect(contactName(map, "61400011675@s.whatsapp.net")).toBe("Rohan");
  });

  test("merges into an existing entry at the new key instead of overwriting it", () => {
    // The phone-keyed form already has a notify from an earlier message;
    // the migrated (trusted) name must not be lost, and the notify must
    // not be lost either.
    const map: ContactsMap = {
      "184710990000999@lid": { name: "Rohan" },
      "61400011675@s.whatsapp.net": { notify: "rohan_98" },
    };
    migrateContactKey(map, "184710990000999@lid", "61400011675@s.whatsapp.net");
    expect(map["61400011675@s.whatsapp.net"]).toEqual({
      name: "Rohan",
      notify: "rohan_98",
    });
  });

  test("on a real conflict, the existing entry at the new key wins over the stale migrating one", () => {
    // Both sides have a .name - there's no reliable way to know which is
    // fresher, so the entry already at the resolved key must win rather
    // than getting silently clobbered by data migrating in from the old key.
    const map: ContactsMap = {
      "184710990000999@lid": { name: "Old Nickname" },
      "61400011675@s.whatsapp.net": { name: "Rohan K (current)" },
    };
    migrateContactKey(map, "184710990000999@lid", "61400011675@s.whatsapp.net");
    expect(map["61400011675@s.whatsapp.net"]).toEqual({
      name: "Rohan K (current)",
    });
  });

  test("no entry at the old key: no-op, reports false", () => {
    const map: ContactsMap = {};
    expect(migrateContactKey(map, "a@lid", "b@s.whatsapp.net")).toBe(false);
  });

  test("old and new key are already the same: no-op", () => {
    const map: ContactsMap = { x: { name: "Akash" } };
    expect(migrateContactKey(map, "x", "x")).toBe(false);
    expect(map.x).toEqual({ name: "Akash" });
  });
});

describe("migrateContactKey: the last-seen stamp", () => {
  const LID = "184710990000999@lid";
  const PN = "61400000003@s.whatsapp.net";

  test("two nameless entries keep the newer stamp", () => {
    const map: ContactsMap = {
      [LID]: { notify: "roh", seen: 100 },
      [PN]: { notify: "roh", seen: 50 },
    };
    migrateContactKey(map, LID, PN);
    expect(map[PN]).toEqual({ notify: "roh", seen: 100 });
  });

  test("a saved name at either key means no stamp survives", () => {
    const map: ContactsMap = {
      [LID]: { notify: "roh", seen: 100 },
      [PN]: { name: "Rohan" },
    };
    migrateContactKey(map, LID, PN);
    expect(map[PN].name).toBe("Rohan");
    expect(map[PN].seen).toBeUndefined();
  });
});

describe("forgetContact", () => {
  test("deletes an existing entry and reports true", () => {
    const map: ContactsMap = { "x@s.whatsapp.net": { name: "Akash" } };
    expect(forgetContact(map, "x@s.whatsapp.net")).toBe(true);
    expect(map["x@s.whatsapp.net"]).toBeUndefined();
  });

  test("no entry at that key: no-op, reports false", () => {
    const map: ContactsMap = { "x@s.whatsapp.net": { name: "Akash" } };
    expect(forgetContact(map, "y@s.whatsapp.net")).toBe(false);
    expect(map["x@s.whatsapp.net"]).toEqual({ name: "Akash" });
  });

  test("only removes the targeted key, leaves the rest of the map alone", () => {
    const map: ContactsMap = {
      "x@s.whatsapp.net": { name: "Akash" },
      "y@s.whatsapp.net": { name: "Neha" },
    };
    forgetContact(map, "x@s.whatsapp.net");
    expect(map).toEqual({ "y@s.whatsapp.net": { name: "Neha" } });
  });
});

describe("resolveByName", () => {
  test("unique name resolves to its jid", () => {
    const map: ContactsMap = { "x@s.whatsapp.net": { name: "Akash" } };
    expect(resolveByName(map, "Akash")).toEqual({
      ok: true,
      jid: "x@s.whatsapp.net",
    });
  });

  test("matches case-insensitively and trims whitespace", () => {
    const map: ContactsMap = { "x@s.whatsapp.net": { name: "Akash" } };
    expect(resolveByName(map, "  akash  ")).toEqual({
      ok: true,
      jid: "x@s.whatsapp.net",
    });
  });

  test("security: never matches notify, unlike contactName's display fallback", () => {
    // .notify is self-reported by anyone who's ever messaged the account -
    // untrusted. If this matched notify, an attacker could set their own
    // display name to a real person's phone number string and hijack any
    // attempt to mention that number to their own jid instead, silently
    // (a unique match produces no error). Resolution must stay stricter
    // than display.
    const map: ContactsMap = {
      "attacker@s.whatsapp.net": { notify: "61400045973" },
    };
    expect(resolveByName(map, "61400045973")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("no match: not_found, not a fabricated guess", () => {
    const map: ContactsMap = { "x@s.whatsapp.net": { name: "Akash" } };
    expect(resolveByName(map, "Divesh")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("empty/blank name: not_found", () => {
    expect(resolveByName({}, "   ")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("two contacts sharing a display name: ambiguous, never a coin flip", () => {
    const map: ContactsMap = {
      "a@s.whatsapp.net": { name: "Neha" },
      "b@s.whatsapp.net": { name: "Neha" },
    };
    const result = resolveByName(map, "Neha");
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "ambiguous") {
      expect(result.candidates.sort()).toEqual([
        "a@s.whatsapp.net",
        "b@s.whatsapp.net",
      ]);
    } else {
      throw new Error("expected an ambiguous result");
    }
  });

  test("a partial/substring match does not resolve - exact only", () => {
    const map: ContactsMap = { "x@s.whatsapp.net": { name: "Neha Pitale" } };
    expect(resolveByName(map, "Neha")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("hasSavedName", () => {
  test("only a non-empty .name counts; notify-only, empty-string and an empty cache do not", () => {
    expect(hasSavedName({})).toBe(false);
    // The exact state this check exists for: entries exist (everyone who has
    // ever messaged the account), but not one of them is a name the owner
    // saved, so nothing can be resolved by name yet.
    expect(
      hasSavedName({
        "a@s.whatsapp.net": { notify: "aki_98" },
        "b@s.whatsapp.net": { notify: "neha" },
      }),
    ).toBe(false);
    // Same rule mergeContact enforces: "" means "not provided", never a name.
    expect(hasSavedName({ "a@s.whatsapp.net": { name: "" } })).toBe(false);
    expect(
      hasSavedName({
        "a@s.whatsapp.net": { notify: "aki_98" },
        "b@s.whatsapp.net": { name: "Akash", notify: "aki_98" },
      }),
    ).toBe(true);
  });
});

describe("pruneStrangers", () => {
  const NOW = 1_756_000_000_000;
  const OLD = NOW - STRANGER_TTL_MS - 1;
  const FRESH = NOW - 1000;
  const J = (n: string) => `${n}@s.whatsapp.net`;

  test("a gate-rejected stranger ages out of both maps", () => {
    // No stamp: the shape every entry had before `seen` existed. Its
    // dm-activity row was its only clock, and that row ages out on this call,
    // so the contact goes with it rather than getting a fresh TTL.
    const contacts: ContactsMap = { [J("1")]: { notify: "spam bot" } };
    const dm = { [J("1")]: OLD };
    const changed = pruneStrangers(contacts, dm, new Set(), NOW);
    expect(changed).toEqual({ contacts: true, dms: true });
    expect(contacts).toEqual({});
    expect(dm).toEqual({});
  });

  test("a saved name never ages out, even with stale activity", () => {
    // `seen: OLD` cannot be written by mergeContact for a saved entry; it is
    // here so the name, not a missing stamp, is what keeps the entry.
    const contacts: ContactsMap = { [J("2")]: { name: "Mum", seen: OLD } };
    const dm = { [J("2")]: OLD };
    pruneStrangers(contacts, dm, new Set(), NOW);
    expect(contacts[J("2")]).toEqual({ name: "Mum", seen: OLD });
    // ...but the stale activity timestamp itself still goes: it only ranks
    // the wizard, and a saved name earns its row without it.
    expect(dm[J("2")]).toBeUndefined();
  });

  test("an allowlisted key is kept in both maps whatever its age", () => {
    const contacts: ContactsMap = { [J("3")]: { notify: "aki_98", seen: OLD } };
    const dm = { [J("3")]: OLD };
    const changed = pruneStrangers(contacts, dm, new Set([J("3")]), NOW);
    expect(changed).toEqual({ contacts: false, dms: false });
    expect(contacts[J("3")]).toBeDefined();
    expect(dm[J("3")]).toBe(OLD);
  });

  test("fresh activity keeps a notify-only contact", () => {
    // Last SEEN long ago, but DM activity is fresh: the activity row keeps it.
    const contacts: ContactsMap = {
      [J("4")]: { notify: "new friend", seen: OLD },
    };
    const dm = { [J("4")]: FRESH };
    const changed = pruneStrangers(contacts, dm, new Set(), NOW);
    expect(changed).toEqual({ contacts: false, dms: false });
    expect(contacts[J("4")]).toBeDefined();
  });

  // A group member never gets a dm-activity row, so `seen` is their only
  // clock. Before it existed they were deleted on every tick.
  test("a group member last seen past the TTL is dropped", () => {
    const contacts: ContactsMap = {
      [J("5")]: { notify: "group lurker", seen: OLD },
    };
    const changed = pruneStrangers(contacts, {}, new Set(), NOW);
    expect(changed).toEqual({ contacts: true, dms: false });
    expect(contacts).toEqual({});
  });

  test("a group member seen inside the TTL is kept, with no activity row", () => {
    const contacts: ContactsMap = {
      [J("5")]: { notify: "group regular", seen: FRESH },
    };
    const changed = pruneStrangers(contacts, {}, new Set(), NOW);
    expect(changed).toEqual({ contacts: false, dms: false });
    expect(contacts[J("5")]).toEqual({ notify: "group regular", seen: FRESH });
  });

  test("an entry from before the stamp existed gets the TTL from now, not forever", () => {
    const contacts: ContactsMap = { [J("7")]: { notify: "legacy" } };
    const first = pruneStrangers(contacts, {}, new Set(), NOW);
    expect(first).toEqual({ contacts: true, dms: false });
    expect(contacts[J("7")]).toEqual({ notify: "legacy", seen: NOW });
    pruneStrangers(contacts, {}, new Set(), NOW + STRANGER_TTL_MS - 1);
    expect(contacts[J("7")]).toBeDefined();
    pruneStrangers(contacts, {}, new Set(), NOW + STRANGER_TTL_MS);
    expect(contacts[J("7")]).toBeUndefined();
  });

  test("a malformed stamp restarts the clock instead of deleting or sticking", () => {
    const contacts: ContactsMap = {
      [J("8")]: { notify: "hand edited", seen: "yesterday" as any },
      [J("9")]: { notify: "nan", seen: Number.NaN },
    };
    const changed = pruneStrangers(contacts, {}, new Set(), NOW);
    expect(changed.contacts).toBe(true);
    expect(contacts[J("8")].seen).toBe(NOW);
    expect(contacts[J("9")].seen).toBe(NOW);
  });

  test("a malformed activity timestamp is kept, not treated as old", () => {
    const dm = { [J("6")]: Number.NaN };
    const changed = pruneStrangers({}, dm, new Set(), NOW);
    expect(changed.dms).toBe(false);
    expect(J("6") in dm).toBe(true);
  });

  test("empty maps report no change", () => {
    expect(pruneStrangers({}, {}, new Set(), NOW)).toEqual({
      contacts: false,
      dms: false,
    });
  });
});
