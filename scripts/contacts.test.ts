import { describe, expect, test } from "bun:test";
import {
  contactName,
  forgetContact,
  mergeContact,
  migrateContactKey,
  resolveByName,
  type ContactsMap,
} from "./contacts";

describe("mergeContact", () => {
  test("first sighting of a contact is stored", () => {
    const map: ContactsMap = {};
    const changed = mergeContact(map, "61434505973@s.whatsapp.net", {
      name: "Akash",
    });
    expect(changed).toBe(true);
    expect(map["61434505973@s.whatsapp.net"]).toEqual({ name: "Akash" });
  });

  test("an update with only notify doesn't erase an existing saved name", () => {
    const map: ContactsMap = {
      "61434505973@s.whatsapp.net": { name: "Akash" },
    };
    mergeContact(map, "61434505973@s.whatsapp.net", { notify: "aki_98" });
    expect(map["61434505973@s.whatsapp.net"]).toEqual({
      name: "Akash",
      notify: "aki_98",
    });
  });

  test("a name change (contact renamed later) overwrites the old one", () => {
    const map: ContactsMap = {
      "61434505973@s.whatsapp.net": { name: "Neha" },
    };
    mergeContact(map, "61434505973@s.whatsapp.net", { name: "Nehaaaa" });
    expect(contactName(map, "61434505973@s.whatsapp.net")).toBe("Nehaaaa");
  });

  test("an explicit empty-string name doesn't erase an existing saved name", () => {
    // WhatsApp signals "not saved" by omitting the field, never by sending
    // "" - so an empty string must be treated the same as absent, not as a
    // real update that wipes the trusted name.
    const map: ContactsMap = {
      "61434505973@s.whatsapp.net": { name: "Akash" },
    };
    mergeContact(map, "61434505973@s.whatsapp.net", {
      name: "",
      notify: "aki_98",
    });
    expect(map["61434505973@s.whatsapp.net"]).toEqual({
      name: "Akash",
      notify: "aki_98",
    });
  });

  test("no actual change reports false, doesn't churn the caller's save", () => {
    const map: ContactsMap = {
      "61434505973@s.whatsapp.net": { name: "Akash" },
    };
    const changed = mergeContact(map, "61434505973@s.whatsapp.net", {
      name: "Akash",
    });
    expect(changed).toBe(false);
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
      "61403911675@s.whatsapp.net",
    );
    expect(changed).toBe(true);
    expect(map["184710990000999@lid"]).toBeUndefined();
    expect(contactName(map, "61403911675@s.whatsapp.net")).toBe("Rohan");
  });

  test("merges into an existing entry at the new key instead of overwriting it", () => {
    // The phone-keyed form already has a notify from an earlier message;
    // the migrated (trusted) name must not be lost, and the notify must
    // not be lost either.
    const map: ContactsMap = {
      "184710990000999@lid": { name: "Rohan" },
      "61403911675@s.whatsapp.net": { notify: "rohan_98" },
    };
    migrateContactKey(
      map,
      "184710990000999@lid",
      "61403911675@s.whatsapp.net",
    );
    expect(map["61403911675@s.whatsapp.net"]).toEqual({
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
      "61403911675@s.whatsapp.net": { name: "Rohan K (current)" },
    };
    migrateContactKey(
      map,
      "184710990000999@lid",
      "61403911675@s.whatsapp.net",
    );
    expect(map["61403911675@s.whatsapp.net"]).toEqual({
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
      "attacker@s.whatsapp.net": { notify: "61434505973" },
    };
    expect(resolveByName(map, "61434505973")).toEqual({
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
