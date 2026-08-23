import { describe, expect, test } from "bun:test";
import {
  contactKeyFor,
  normalizeJid,
  rankDms,
  rankGroups,
  type GroupMeta,
} from "./ranking";
import type { ContactsMap } from "./contacts";

describe("contactKeyFor", () => {
  test("a bare phone JID is returned as-is", () => {
    expect(contactKeyFor({}, "61403911675@s.whatsapp.net")).toBe(
      "61403911675@s.whatsapp.net",
    );
  });

  test("a LID with a known mapping resolves to the mapped phone JID", () => {
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    expect(contactKeyFor(lidMap, "184710990000999@lid")).toBe(
      "61403911675@s.whatsapp.net",
    );
  });

  test("a LID with no known mapping falls back to its own (normalized) form", () => {
    expect(contactKeyFor({}, "184710990000999@lid")).toBe(
      "184710990000999@lid",
    );
  });

  test("a device suffix is stripped, on a phone JID and a resolved LID alike", () => {
    expect(contactKeyFor({}, "61403911675:5@s.whatsapp.net")).toBe(
      "61403911675@s.whatsapp.net",
    );
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    expect(contactKeyFor(lidMap, "184710990000999:9@lid")).toBe(
      "61403911675@s.whatsapp.net",
    );
  });
});

describe("normalizeJid", () => {
  test("strips a device suffix, leaves a bare JID untouched", () => {
    expect(normalizeJid("61403911675:5@s.whatsapp.net")).toBe(
      "61403911675@s.whatsapp.net",
    );
    expect(normalizeJid("61403911675@s.whatsapp.net")).toBe(
      "61403911675@s.whatsapp.net",
    );
  });

  // Mirrors Baileys' own jidNormalizedUser (jid-utils.js) exactly - these
  // two cases were missing from the original mirror (it only stripped the
  // device suffix), a real silent divergence a code review caught: an
  // agent-suffixed or @c.us-domain JID would have computed a DIFFERENT key
  // than server.ts's real jidNormalizedUser does for the same identity.
  test("strips an _agent suffix, same as a real jidNormalizedUser", () => {
    expect(normalizeJid("61403911675_5@s.whatsapp.net")).toBe(
      "61403911675@s.whatsapp.net",
    );
  });

  test("normalizes the legacy @c.us domain to @s.whatsapp.net", () => {
    expect(normalizeJid("61403911675@c.us")).toBe("61403911675@s.whatsapp.net");
  });

  test("agent suffix and device suffix together both get stripped", () => {
    expect(normalizeJid("61403911675_5:9@s.whatsapp.net")).toBe(
      "61403911675@s.whatsapp.net",
    );
  });

  test("a @lid or @g.us domain is left alone (only @c.us is remapped)", () => {
    expect(normalizeJid("184710990000999@lid")).toBe("184710990000999@lid");
    expect(normalizeJid("120363424405607157@g.us")).toBe(
      "120363424405607157@g.us",
    );
  });
});

function group(over: Partial<GroupMeta> = {}): GroupMeta {
  return {
    name: "Group",
    memberCount: 1,
    archived: false,
    updatedAt: 0,
    ...over,
  };
}

describe("rankGroups", () => {
  test("orders by most recent activity first", () => {
    const meta = {
      "old@g.us": group({ name: "Old", lastActivityAt: 100 }),
      "new@g.us": group({ name: "New", lastActivityAt: 200 }),
    };
    const result = rankGroups(meta, new Set(), false, 5);
    expect(result.map((c) => c.jid)).toEqual(["new@g.us", "old@g.us"]);
  });

  test("no activity recorded sorts last, alphabetical tie-break otherwise", () => {
    const meta = {
      "b@g.us": group({ name: "Bravo" }),
      "a@g.us": group({ name: "Alpha" }),
      "recent@g.us": group({ name: "Recent", lastActivityAt: 50 }),
    };
    const result = rankGroups(meta, new Set(), false, 5);
    expect(result.map((c) => c.jid)).toEqual([
      "recent@g.us",
      "a@g.us",
      "b@g.us",
    ]);
  });

  test("already-configured groups are excluded", () => {
    const meta = {
      "a@g.us": group({ name: "Alpha" }),
      "b@g.us": group({ name: "Bravo" }),
    };
    const result = rankGroups(meta, new Set(["a@g.us"]), false, 5);
    expect(result.map((c) => c.jid)).toEqual(["b@g.us"]);
  });

  test("archived groups are excluded by default, included when asked", () => {
    const meta = {
      "a@g.us": group({ name: "Alpha", archived: true }),
      "b@g.us": group({ name: "Bravo" }),
    };
    expect(rankGroups(meta, new Set(), false, 5).map((c) => c.jid)).toEqual([
      "b@g.us",
    ]);
    // Both tie on recency (neither has activity recorded), so this falls
    // through to the alphabetical tie-break - "Alpha" before "Bravo".
    expect(rankGroups(meta, new Set(), true, 5).map((c) => c.jid)).toEqual([
      "a@g.us",
      "b@g.us",
    ]);
  });

  test("respects the limit", () => {
    const meta = {
      "a@g.us": group({ name: "Alpha" }),
      "b@g.us": group({ name: "Bravo" }),
      "c@g.us": group({ name: "Charlie" }),
    };
    expect(rankGroups(meta, new Set(), false, 2)).toHaveLength(2);
  });

  test("label includes member count and an [archived] tag when relevant", () => {
    const meta = {
      "a@g.us": group({ name: "Alpha", memberCount: 6 }),
      "b@g.us": group({ name: "Bravo", memberCount: 3, archived: true }),
    };
    const result = rankGroups(meta, new Set(), true, 5);
    expect(result.find((c) => c.jid === "a@g.us")?.label).toBe(
      "Alpha  (6 member(s))",
    );
    expect(result.find((c) => c.jid === "b@g.us")?.label).toBe(
      "Bravo  (3 member(s))  [archived]",
    );
  });
});

describe("rankDms", () => {
  test("orders by most recent activity first", () => {
    const activity = { "old@s.whatsapp.net": 100, "new@s.whatsapp.net": 200 };
    const result = rankDms(activity, {}, [], {}, 10);
    expect(result.map((c) => c.jid)).toEqual([
      "new@s.whatsapp.net",
      "old@s.whatsapp.net",
    ]);
  });

  test("already-allowed contacts are excluded, resolved through a LID mapping", () => {
    const activity = { "61403911675@s.whatsapp.net": 100 };
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    // Allowed via the LID form - must still exclude the phone-keyed activity entry.
    const result = rankDms(activity, {}, ["184710990000999@lid"], lidMap, 10);
    expect(result).toEqual([]);
  });

  test("shows a saved name when known", () => {
    const activity = { "x@s.whatsapp.net": 100 };
    const contacts: ContactsMap = { "x@s.whatsapp.net": { name: "Akash" } };
    const result = rankDms(activity, contacts, [], {}, 10);
    expect(result).toEqual([{ jid: "x@s.whatsapp.net", label: "Akash" }]);
  });

  test("shows a masked number when no name is known", () => {
    const activity = { "61403911675@s.whatsapp.net": 100 };
    const result = rankDms(activity, {}, [], {}, 10);
    expect(result).toEqual([
      { jid: "61403911675@s.whatsapp.net", label: "•••••1675" },
    ]);
  });

  test("a number-shaped notify is masked, not shown as if it were a name", () => {
    const activity = { "61403911675@s.whatsapp.net": 100 };
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { notify: "61403911675" },
    };
    const result = rankDms(activity, contacts, [], {}, 10);
    expect(result).toEqual([
      { jid: "61403911675@s.whatsapp.net", label: "•••••1675" },
    ]);
  });

  test("a notify-only label is marked unverified and paired with the masked number, not shown plain like a saved name", () => {
    // .notify is self-reported by anyone who's ever messaged the account -
    // an attacker naming themselves "Mum" must not read identically to a
    // contact the owner actually saved (see ranking.ts's rankDms comment).
    const activity = { "61403911675@s.whatsapp.net": 100 };
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { notify: "Mum" },
    };
    const result = rankDms(activity, contacts, [], {}, 10);
    expect(result).toEqual([
      {
        jid: "61403911675@s.whatsapp.net",
        label: "Mum (unverified) - •••••1675",
      },
    ]);
  });

  test("a saved .name always wins over .notify and is shown plain", () => {
    const activity = { "x@s.whatsapp.net": 100 };
    const contacts: ContactsMap = {
      "x@s.whatsapp.net": { name: "Akash", notify: "some other name" },
    };
    const result = rankDms(activity, contacts, [], {}, 10);
    expect(result).toEqual([{ jid: "x@s.whatsapp.net", label: "Akash" }]);
  });

  test("respects the limit", () => {
    const activity = {
      "a@s.whatsapp.net": 1,
      "b@s.whatsapp.net": 2,
      "c@s.whatsapp.net": 3,
    };
    expect(rankDms(activity, {}, [], {}, 2)).toHaveLength(2);
  });
});
