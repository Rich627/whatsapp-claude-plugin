import { describe, expect, test } from "bun:test";
import { contactName, mergeContact, type ContactsMap } from "./contacts";

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
