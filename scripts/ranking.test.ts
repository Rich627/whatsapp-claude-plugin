import { describe, expect, test } from "bun:test";
import { groupAnchor } from "./mask";
import {
  contactKeyFor,
  diffAccess,
  listConfiguredDms,
  listConfiguredGroups,
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

describe("diffAccess", () => {
  test("additions and removals in both pools", () => {
    const prev = { allowFrom: ["a@s.whatsapp.net"], groups: { "g1@g.us": {} } };
    const next = {
      allowFrom: ["b@s.whatsapp.net"],
      groups: { "g2@g.us": {} },
    };
    expect(diffAccess(prev, next)).toEqual({
      added: { groups: ["g2@g.us"], dms: ["b@s.whatsapp.net"] },
      removed: { groups: ["g1@g.us"], dms: ["a@s.whatsapp.net"] },
    });
  });

  test("identical snapshots produce four empty arrays", () => {
    const snap = { allowFrom: ["a@s.whatsapp.net"], groups: { "g1@g.us": {} } };
    expect(diffAccess(snap, snap)).toEqual({
      added: { groups: [], dms: [] },
      removed: { groups: [], dms: [] },
    });
  });

  test("two snapshots with neither allowFrom nor groups present produce four empty arrays", () => {
    expect(diffAccess({}, {})).toEqual({
      added: { groups: [], dms: [] },
      removed: { groups: [], dms: [] },
    });
  });

  test("returned arrays are sorted", () => {
    const prev = { allowFrom: [], groups: {} };
    const next = {
      allowFrom: ["z@s.whatsapp.net", "a@s.whatsapp.net"],
      groups: { "z@g.us": {}, "a@g.us": {} },
    };
    const result = diffAccess(prev, next);
    expect(result.added.dms).toEqual(["a@s.whatsapp.net", "z@s.whatsapp.net"]);
    expect(result.added.groups).toEqual(["a@g.us", "z@g.us"]);
  });

  test("a group whose roster flag flipped but whose key is present in both is in neither bucket", () => {
    const prev = { allowFrom: [], groups: { "g1@g.us": { roster: false } } };
    const next = { allowFrom: [], groups: { "g1@g.us": { roster: true } } };
    expect(diffAccess(prev, next)).toEqual({
      added: { groups: [], dms: [] },
      removed: { groups: [], dms: [] },
    });
  });

  test("duplicate allowFrom entries do not produce a phantom add", () => {
    const prev = { allowFrom: ["a@s.whatsapp.net"], groups: {} };
    const next = {
      allowFrom: ["a@s.whatsapp.net", "a@s.whatsapp.net"],
      groups: {},
    };
    expect(diffAccess(prev, next)).toEqual({
      added: { groups: [], dms: [] },
      removed: { groups: [], dms: [] },
    });
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

  test("omitting the limit returns the whole pool - the total the wizard discloses", () => {
    const meta: Record<string, GroupMeta> = {};
    for (let i = 1; i <= 7; i++) {
      meta[`${i}@g.us`] = group({ name: `Group ${i}` });
    }
    expect(rankGroups(meta, new Set(), false)).toHaveLength(7);
    expect(rankGroups(meta, new Set(), false, 2)).toHaveLength(2);
  });

  test("labels are disambiguated across the WHOLE pool when uncapped", () => {
    // A cap of 1 would only ever see one of these two, so its label would
    // never need the disambiguation suffix - uncapped, both are visible to
    // disambiguate() and both must come back distinct.
    const meta = {
      "111999@g.us": group({ name: "Team", memberCount: 4 }),
      "222888@g.us": group({ name: "Team", memberCount: 4 }),
    };
    const result = rankGroups(meta, new Set(), false);
    expect(new Set(result.map((c) => c.label)).size).toBe(2);
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
    expect(result).toEqual([
      {
        jid: "x@s.whatsapp.net",
        label: "Akash",
        description: "•••••",
      },
    ]);
  });

  test("shows a masked number when no name is known", () => {
    const activity = { "61403911675@s.whatsapp.net": 100 };
    const result = rankDms(activity, {}, [], {}, 10);
    expect(result).toEqual([
      {
        jid: "61403911675@s.whatsapp.net",
        label: "•••••1675",
        description: "•••••1675",
      },
    ]);
  });

  test("a number-shaped notify is masked, not shown as if it were a name", () => {
    const activity = { "61403911675@s.whatsapp.net": 100 };
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { notify: "61403911675" },
    };
    const result = rankDms(activity, contacts, [], {}, 10);
    expect(result).toEqual([
      {
        jid: "61403911675@s.whatsapp.net",
        label: "•••••1675",
        description: "•••••1675",
      },
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
        description: "•••••1675",
      },
    ]);
  });

  test("a saved .name always wins over .notify and is shown plain", () => {
    const activity = { "x@s.whatsapp.net": 100 };
    const contacts: ContactsMap = {
      "x@s.whatsapp.net": { name: "Akash", notify: "some other name" },
    };
    const result = rankDms(activity, contacts, [], {}, 10);
    expect(result).toEqual([
      {
        jid: "x@s.whatsapp.net",
        label: "Akash",
        description: "•••••",
      },
    ]);
  });

  test("respects the limit", () => {
    const activity = {
      "a@s.whatsapp.net": 1,
      "b@s.whatsapp.net": 2,
      "c@s.whatsapp.net": 3,
    };
    expect(rankDms(activity, {}, [], {}, 2)).toHaveLength(2);
  });

  test("omitting the limit returns the whole pool - the total the wizard discloses", () => {
    const activity: Record<string, number> = {};
    for (let i = 1; i <= 12; i++) {
      activity[`${i}@s.whatsapp.net`] = i;
    }
    expect(rankDms(activity, {}, [], {})).toHaveLength(12);
    expect(rankDms(activity, {}, [], {}, 2)).toHaveLength(2);
  });

  test("labels are disambiguated across the WHOLE pool when uncapped", () => {
    // A cap of 1 would only ever see one of these two Alex's - uncapped,
    // both are visible to disambiguate() and both must come back distinct.
    const activity = {
      "61403911675@s.whatsapp.net": 200,
      "61432609386@s.whatsapp.net": 100,
    };
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { name: "Alex" },
      "61432609386@s.whatsapp.net": { name: "Alex" },
    };
    const result = rankDms(activity, contacts, [], {});
    expect(new Set(result.map((c) => c.label)).size).toBe(2);
  });

  test("a saved contact with no DM activity is in the pool", () => {
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { name: "Thilian" },
    };
    const result = rankDms({}, contacts, [], {}, 10);
    expect(result).toEqual([
      {
        jid: "61403911675@s.whatsapp.net",
        label: "Thilian",
        description: "•••••1675",
      },
    ]);
  });

  test("a notify-only contact with no activity is not in the pool", () => {
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { notify: "Mum" },
    };
    const result = rankDms({}, contacts, [], {}, 10);
    expect(result).toEqual([]);
  });

  test("activity ranks first, then saved-name-only contacts alphabetically", () => {
    const activity = { "61403911675@s.whatsapp.net": 100 };
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { name: "Zach" },
      "a@s.whatsapp.net": { name: "Bella" },
      "b@s.whatsapp.net": { name: "Alex" },
    };
    const result = rankDms(activity, contacts, [], {}, 10);
    expect(result.map((c) => c.jid)).toEqual([
      "61403911675@s.whatsapp.net",
      "b@s.whatsapp.net",
      "a@s.whatsapp.net",
    ]);
  });

  test("a saved contact already on the allowlist is excluded, through its LID form too", () => {
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { name: "Thilian" },
    };
    const result = rankDms({}, contacts, ["184710990000999@lid"], lidMap, 10);
    expect(result).toEqual([]);
  });

  test("a saved contact who also has activity appears exactly once", () => {
    const activity = { "61403911675@s.whatsapp.net": 100 };
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { name: "Thilian" },
    };
    const result = rankDms(activity, contacts, [], {}, 10);
    expect(result).toHaveLength(1);
    expect(result[0].jid).toBe("61403911675@s.whatsapp.net");
  });

  test("the limit slices the combined pool, activity first", () => {
    const activity = { "61403911675@s.whatsapp.net": 100 };
    const contacts: ContactsMap = {
      "a@s.whatsapp.net": { name: "Alex" },
      "b@s.whatsapp.net": { name: "Bella" },
    };
    const result = rankDms(activity, contacts, [], {}, 2);
    expect(result.map((c) => c.jid)).toEqual([
      "61403911675@s.whatsapp.net",
      "a@s.whatsapp.net",
    ]);
  });

  test("labels are disambiguated across the combined pool", () => {
    const activity = { "61403911675@s.whatsapp.net": 100 };
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { name: "Alex" },
      "a@s.whatsapp.net": { name: "Alex" },
    };
    const result = rankDms(activity, contacts, [], {}, 10);
    expect(new Set(result.map((c) => c.label)).size).toBe(2);
  });
});

describe("listConfiguredGroups", () => {
  test("empty state: no configured groups", () => {
    expect(listConfiguredGroups({}, {})).toEqual([]);
  });

  test("empty state: meta alone is not configuration", () => {
    const meta = { "a@g.us": group() };
    expect(listConfiguredGroups({}, meta)).toEqual([]);
  });

  test("normal case: label matches rankGroups' exact format", () => {
    const groups = { "a@g.us": {}, "b@g.us": {} };
    const meta = {
      "a@g.us": group({ name: "Alpha", memberCount: 6 }),
      "b@g.us": group({ name: "Bravo", memberCount: 3 }),
    };
    const result = listConfiguredGroups(groups, meta);
    expect(result.find((c) => c.jid === "a@g.us")?.label).toBe(
      "Alpha  (6 member(s))",
    );
    expect(result.find((c) => c.jid === "b@g.us")?.label).toBe(
      "Bravo  (3 member(s))",
    );
  });

  test("sorted alphabetically regardless of insertion order", () => {
    const groups = { "b@g.us": {}, "a@g.us": {} };
    const meta = {
      "b@g.us": group({ name: "Bravo" }),
      "a@g.us": group({ name: "Alpha" }),
    };
    const result = listConfiguredGroups(groups, meta);
    expect(result.map((c) => c.label)).toEqual([
      "Alpha  (1 member(s))",
      "Bravo  (1 member(s))",
    ]);
  });

  test("an archived configured group is still listed, with the [archived] tag", () => {
    const groups = { "a@g.us": {} };
    const meta = { "a@g.us": group({ name: "Alpha", archived: true }) };
    const result = listConfiguredGroups(groups, meta);
    expect(result).toEqual([
      {
        jid: "a@g.us",
        label: "Alpha  (1 member(s))  [archived]",
        description: "a@g.us",
      },
    ]);
  });

  test("a configured JID with no meta entry is listed with the raw JID as its label", () => {
    const groups = { "unknown@g.us": {} };
    const result = listConfiguredGroups(groups, {});
    expect(result).toEqual([
      {
        jid: "unknown@g.us",
        label: "unknown@g.us",
        description: "unknown@g.us",
      },
    ]);
  });

  test("a meta entry that is not configured is absent from the result", () => {
    const groups = { "a@g.us": {} };
    const meta = {
      "a@g.us": group({ name: "Alpha" }),
      "b@g.us": group({ name: "Bravo" }),
    };
    const result = listConfiguredGroups(groups, meta);
    expect(result.map((c) => c.jid)).toEqual(["a@g.us"]);
  });
});

describe("listConfiguredDms", () => {
  test("empty state", () => {
    expect(listConfiguredDms([], {}, {})).toEqual([]);
  });

  test("saved .name shown plain", () => {
    const contacts: ContactsMap = { "x@s.whatsapp.net": { name: "Akash" } };
    const result = listConfiguredDms(["x@s.whatsapp.net"], contacts, {});
    expect(result).toEqual([
      {
        jid: "x@s.whatsapp.net",
        label: "Akash",
        description: "•••••",
      },
    ]);
  });

  test(".notify-only shows unverified paired with the masked number", () => {
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { notify: "Mum" },
    };
    const result = listConfiguredDms(
      ["61403911675@s.whatsapp.net"],
      contacts,
      {},
    );
    expect(result).toEqual([
      {
        jid: "61403911675@s.whatsapp.net",
        label: "Mum (unverified) - •••••1675",
        description: "•••••1675",
      },
    ]);
  });

  test("number-shaped .notify is masked only", () => {
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { notify: "61403911675" },
    };
    const result = listConfiguredDms(
      ["61403911675@s.whatsapp.net"],
      contacts,
      {},
    );
    expect(result).toEqual([
      {
        jid: "61403911675@s.whatsapp.net",
        label: "•••••1675",
        description: "•••••1675",
      },
    ]);
  });

  test("no contact entry at all is masked only", () => {
    const result = listConfiguredDms(["61403911675@s.whatsapp.net"], {}, {});
    expect(result).toEqual([
      {
        jid: "61403911675@s.whatsapp.net",
        label: "•••••1675",
        description: "•••••1675",
      },
    ]);
  });

  test("LID handling: label comes from the phone-keyed contact, jid stays the original @lid string", () => {
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { name: "Akash" },
    };
    const result = listConfiguredDms(["184710990000999@lid"], contacts, lidMap);
    expect(result).toEqual([
      {
        jid: "184710990000999@lid",
        label: "Akash",
        description: "•••••1675",
      },
    ]);
  });

  test("sorted alphabetically by label regardless of allowFrom order", () => {
    const contacts: ContactsMap = {
      "b@s.whatsapp.net": { name: "Bravo" },
      "a@s.whatsapp.net": { name: "Alpha" },
    };
    const result = listConfiguredDms(
      ["b@s.whatsapp.net", "a@s.whatsapp.net"],
      contacts,
      {},
    );
    expect(result.map((c) => c.label)).toEqual(["Alpha", "Bravo"]);
  });
});

// The picker (and any screen that hands a selection back BY ITS LABEL)
// cannot map a label shared by two candidates
// to one JID - the wrong grant gets revoked, or both do. These cover every
// way two rows can render identically.
describe("label disambiguation", () => {
  test("the @lid and phone forms of ONE allowlisted contact get distinct labels", () => {
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { name: "Akash" },
    };
    const result = listConfiguredDms(
      ["184710990000999@lid", "61403911675@s.whatsapp.net"],
      contacts,
      lidMap,
    );
    expect(new Set(result.map((c) => c.label)).size).toBe(2);
    // Both rows still name the same person and both stay revokable under
    // the exact string that is in allowFrom.
    expect(result.every((c) => c.label.startsWith("Akash"))).toBe(true);
    expect(result.map((c) => c.jid).sort()).toEqual([
      "184710990000999@lid",
      "61403911675@s.whatsapp.net",
    ]);
  });

  test("two groups sharing a name and member count get distinct labels", () => {
    const groups = { "111999@g.us": {}, "222888@g.us": {} };
    const meta = {
      "111999@g.us": group({ name: "Team", memberCount: 4 }),
      "222888@g.us": group({ name: "Team", memberCount: 4 }),
    };
    const result = listConfiguredGroups(groups, meta);
    expect(new Set(result.map((c) => c.label)).size).toBe(2);
  });

  test("two contacts saved under the same name get distinct labels", () => {
    const activity = {
      "61403911675@s.whatsapp.net": 200,
      "61432609386@s.whatsapp.net": 100,
    };
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { name: "Alex" },
      "61432609386@s.whatsapp.net": { name: "Alex" },
    };
    const result = rankDms(activity, contacts, [], {}, 10);
    expect(new Set(result.map((c) => c.label)).size).toBe(2);
  });

  test("JIDs sharing their last four digits are still told apart, by ordinal", () => {
    // The masked suffix alone collides here - only the ordinal saves it.
    const contacts: ContactsMap = {
      "6111111675@s.whatsapp.net": { name: "Akash" },
      "6122221675@s.whatsapp.net": { name: "Akash" },
    };
    const result = listConfiguredDms(
      ["6111111675@s.whatsapp.net", "6122221675@s.whatsapp.net"],
      contacts,
      {},
    );
    expect(result.map((c) => c.label)).toEqual([
      "Akash  [1: •••••1675]",
      "Akash  [2: •••••1675]",
    ]);
  });

  test("a raw number never leaks into a disambiguated label", () => {
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { name: "Akash" },
      "61432609386@s.whatsapp.net": { name: "Akash" },
    };
    const result = listConfiguredDms(
      ["61403911675@s.whatsapp.net", "61432609386@s.whatsapp.net"],
      contacts,
      {},
    );
    for (const c of result) {
      expect(c.label).not.toContain("61403911675");
      expect(c.label).not.toContain("61432609386");
    }
  });

  test("labels that do not collide are left exactly as they were", () => {
    const contacts: ContactsMap = {
      "a@s.whatsapp.net": { name: "Alpha" },
      "b@s.whatsapp.net": { name: "Bravo" },
    };
    const result = listConfiguredDms(
      ["a@s.whatsapp.net", "b@s.whatsapp.net"],
      contacts,
      {},
    );
    expect(result.map((c) => c.label)).toEqual(["Alpha", "Bravo"]);
  });

  test("colliding rows are ordered deterministically, not by insertion order", () => {
    const contacts: ContactsMap = {
      "6111111675@s.whatsapp.net": { name: "Akash" },
      "6122221675@s.whatsapp.net": { name: "Akash" },
    };
    const forward = listConfiguredDms(
      ["6111111675@s.whatsapp.net", "6122221675@s.whatsapp.net"],
      contacts,
      {},
    );
    const reversed = listConfiguredDms(
      ["6122221675@s.whatsapp.net", "6111111675@s.whatsapp.net"],
      contacts,
      {},
    );
    expect(reversed).toEqual(forward);
  });

  test("group candidates tying on name and recency are ordered deterministically", () => {
    const meta = {
      "222888@g.us": group({ name: "Team", memberCount: 4 }),
      "111999@g.us": group({ name: "Team", memberCount: 4 }),
    };
    const result = rankGroups(meta, new Set(), false, 5);
    expect(result.map((c) => c.jid)).toEqual(["111999@g.us", "222888@g.us"]);
  });
});

// The identity anchor the in-session screens render under each label. Built
// in this module so no caller has to re-derive it - the rule the skill's
// prose used to carry got this wrong twice (see PR #24 review).
describe("candidate descriptions", () => {
  test("a group's description is its raw JID - a g.us id is not personal data", () => {
    const meta = { "120363424405607157@g.us": group({ name: "Team" }) };
    const result = rankGroups(meta, new Set(), false, 5);
    expect(result[0].description).toBe("120363424405607157@g.us");
  });

  test("a contact's description is the MASKED number, never the raw one", () => {
    const activity = { "61403911675@s.whatsapp.net": 100 };
    const result = rankDms(activity, {}, [], {}, 10);
    expect(result[0].description).toBe("•••••1675");
    expect(result[0].description).not.toContain("61403911675");
  });

  test("a @lid allowFrom entry describes the resolved contact, still masked", () => {
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    const result = listConfiguredDms(["184710990000999@lid"], {}, lidMap);
    expect(result[0].description).toBe("•••••1675");
  });
});

// A group name and a self-reported contact name are attacker-chosen and
// unbounded. Clipping them here is what lets the option rule be "use the
// label as given" - a caller truncating a label itself would cut off the
// disambiguate() suffix, which is appended, and hand back two identical
// options for two different JIDs.
describe("long names", () => {
  const long = "W".repeat(80);

  test("a long group name is clipped, so the label stays inside a known bound", () => {
    const meta = { "a@g.us": group({ name: long, memberCount: 3 }) };
    const result = rankGroups(meta, new Set(), false, 5);
    expect(result[0].label.length).toBeLessThan(70);
    expect(result[0].label).toContain("…");
    expect(result[0].label).toContain("(3 member(s))");
  });

  test("a long .notify is clipped but keeps its unverified marker and mask", () => {
    const activity = { "61403911675@s.whatsapp.net": 100 };
    const contacts: ContactsMap = {
      "61403911675@s.whatsapp.net": { notify: long },
    };
    const result = rankDms(activity, contacts, [], {}, 10);
    expect(result[0].label).toContain("(unverified) - •••••1675");
    expect(result[0].label.length).toBeLessThan(80);
  });

  test("two names that clip to the SAME string are still told apart", () => {
    // Clipping runs before disambiguation for exactly this case.
    const contacts: ContactsMap = {
      "6111111675@s.whatsapp.net": { name: long + "-one" },
      "6122221675@s.whatsapp.net": { name: long + "-two" },
    };
    const result = listConfiguredDms(
      ["6111111675@s.whatsapp.net", "6122221675@s.whatsapp.net"],
      contacts,
      {},
    );
    expect(new Set(result.map((c) => c.label)).size).toBe(2);
    // The suffix that separates them is at the END, which is why nothing
    // downstream may truncate there.
    expect(result[0].label.endsWith("]")).toBe(true);
  });
});

// A modern group JID is a random id; a LEGACY one is
// `<creator-phone>-<created-at>@g.us`, so showing it raw would put a real
// phone number on screen - the thing mask.ts exists to stop.
describe("groupAnchor", () => {
  test("a modern group JID is shown in full - it carries nothing personal", () => {
    expect(groupAnchor("120363424405607157@g.us")).toBe(
      "120363424405607157@g.us",
    );
  });

  test("a domain-less legacy id does not get its last character duplicated", () => {
    // jid.slice(at) with at === -1 is slice(-1): the LAST char, re-appended.
    expect(groupAnchor("61403911675-1443627404")).toBe("•••••1675-1443627404");
  });

  test("a legacy group JID has its creator's number masked, timestamp kept", () => {
    expect(groupAnchor("61403911675-1443627404@g.us")).toBe(
      "•••••1675-1443627404@g.us",
    );
  });

  test("a legacy group's description never carries the raw creator number", () => {
    const meta = {
      "61403911675-1443627404@g.us": group({ name: "Old Crew" }),
    };
    const result = rankGroups(meta, new Set(), false, 5);
    expect(result[0].description).not.toContain("61403911675");
    // The JID itself is untouched - it is what group add/rm act on.
    expect(result[0].jid).toBe("61403911675-1443627404@g.us");
  });

  test("the no-meta label fallback masks it too, not just the description", () => {
    const result = listConfiguredGroups(
      { "61403911675-1443627404@g.us": {} },
      {},
    );
    expect(result[0].label).toBe("•••••1675-1443627404@g.us");
    expect(result[0].jid).toBe("61403911675-1443627404@g.us");
  });
});
