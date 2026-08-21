import { describe, expect, test } from "bun:test";
import { jidDecode, jidNormalizedUser } from "@whiskeysockets/baileys";
import {
  expandAllMention,
  isReservedAllToken,
  mentionsForChunk,
  normalizeMentionJids,
} from "./mentions";

describe("normalizeMentionJids", () => {
  test("bare number with no cached LID resolves to the phone JID", () => {
    const [pair] = normalizeMentionJids(
      ["61434505973"],
      {},
      jidNormalizedUser,
      jidDecode,
    );
    expect(pair).toEqual({
      input: "61434505973",
      jid: "61434505973@s.whatsapp.net",
    });
  });

  test("bare number with a cached LID resolves to the LID JID", () => {
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    const [pair] = normalizeMentionJids(
      ["61403911675"],
      lidMap,
      jidNormalizedUser,
      jidDecode,
    );
    expect(pair).toEqual({
      input: "61403911675",
      jid: "184710990000999@lid",
    });
  });

  test("full JID input matches on its own local part, not the full string", () => {
    const [pair] = normalizeMentionJids(
      ["61434505973@s.whatsapp.net"],
      {},
      jidNormalizedUser,
      jidDecode,
    );
    expect(pair).toEqual({
      input: "61434505973",
      jid: "61434505973@s.whatsapp.net",
    });
  });

  test("a device-suffixed full JID matches on the bare number, not the device id", () => {
    // reply_to_sender surfaces contextInfo.participant verbatim, which can
    // carry a device suffix ("<num>:12@s.whatsapp.net"). Nobody types
    // "@<num>:12" in reply text, so the match key must strip it the same
    // way jidDecode().user does.
    const [pair] = normalizeMentionJids(
      ["61434505973:12@s.whatsapp.net"],
      {},
      jidNormalizedUser,
      jidDecode,
    );
    expect(pair).toEqual({
      input: "61434505973",
      jid: "61434505973@s.whatsapp.net",
    });
  });

  test("full JID with a device suffix: the suffix doesn't end up in the match key", () => {
    // jidNormalizedUser strips ":5" for `jid`; if `input` kept it, the text
    // match would look for "@61434505973:5" while the caller wrote plain
    // "@61434505973" - silently unmatchable.
    const [pair] = normalizeMentionJids(
      ["61434505973:5@s.whatsapp.net"],
      {},
      jidNormalizedUser,
    );
    expect(pair).toEqual({
      input: "61434505973",
      jid: "61434505973@s.whatsapp.net",
    });
  });

  test("a doubled leading @ doesn't produce an empty match key", () => {
    // A single-@ strip left "@61434505973" -> split("@")[0] === "" -> the
    // regex built from that empty input matched almost any "@" in the text.
    const [pair] = normalizeMentionJids(
      ["@@61434505973"],
      {},
      jidNormalizedUser,
      jidDecode,
    );
    expect(pair.input).toBe("61434505973");
  });

  test("two input spellings resolving to the same jid both survive", () => {
    // A LID and its phone number for the same person, passed as two
    // separate mentions entries: neither input should be silently dropped,
    // since the reply text might use either spelling.
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    const pairs = normalizeMentionJids(
      ["184710990000999", "61403911675"],
      lidMap,
      jidNormalizedUser,
      jidDecode,
    );
    expect(pairs).toEqual([
      { input: "184710990000999", jid: "184710990000999@lid" },
      { input: "61403911675", jid: "184710990000999@lid" },
    ]);
  });

  test("a known contact's name resolves to their jid, input stays the name", () => {
    const contactsMap = { "x@s.whatsapp.net": { name: "Akash" } };
    const [pair] = normalizeMentionJids(
      ["Akash"],
      {},
      jidNormalizedUser,
      contactsMap,
    );
    expect(pair).toEqual({ input: "Akash", jid: "x@s.whatsapp.net" });
  });

  test("name resolution wins over treating the same string as a numeric id", () => {
    // Nobody has a contact literally named after a phone number, but if
    // they did, the name lookup must win - that's the whole point of
    // preferring names over raw digits.
    const contactsMap = { "x@s.whatsapp.net": { name: "61434505973" } };
    const [pair] = normalizeMentionJids(
      ["61434505973"],
      {},
      jidNormalizedUser,
      contactsMap,
    );
    expect(pair.jid).toBe("x@s.whatsapp.net");
  });

  test("a name not in the contacts cache falls through to the old id-based path", () => {
    const [pair] = normalizeMentionJids(
      ["61434505973"],
      {},
      jidNormalizedUser,
      { "y@s.whatsapp.net": { name: "SomeoneElse" } },
    );
    expect(pair).toEqual({
      input: "61434505973",
      jid: "61434505973@s.whatsapp.net",
    });
  });

  test("no contactsMap passed at all: still works, old behaviour unchanged", () => {
    const [pair] = normalizeMentionJids(["61434505973"], {}, jidNormalizedUser);
    expect(pair.jid).toBe("61434505973@s.whatsapp.net");
  });

  test("two contacts sharing a name: throws instead of guessing", () => {
    const contactsMap = {
      "a@s.whatsapp.net": { name: "Neha" },
      "b@s.whatsapp.net": { name: "Neha" },
    };
    expect(() =>
      normalizeMentionJids(["Neha"], {}, jidNormalizedUser, contactsMap),
    ).toThrow(/matches more than one contact/);
  });

  test("the ambiguous-name error shows masked numbers, not raw ones", () => {
    const contactsMap = {
      "918419935122@s.whatsapp.net": { name: "Neha" },
      "61405070760@s.whatsapp.net": { name: "Neha" },
    };
    try {
      normalizeMentionJids(["Neha"], {}, jidNormalizedUser, contactsMap);
      throw new Error("expected normalizeMentionJids to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("•••••5122");
      expect(msg).toContain("•••••0760");
      expect(msg).not.toContain("918419935122");
      expect(msg).not.toContain("61405070760");
    }
  });
});

describe("isReservedAllToken", () => {
  test("\"all\" with no saved contact of that name is the reserved token", () => {
    expect(isReservedAllToken("all", {})).toBe(true);
  });

  test("case-insensitive and @-stripped, same as any other mention entry", () => {
    expect(isReservedAllToken("@ALL", {})).toBe(true);
    expect(isReservedAllToken(" All ", {})).toBe(true);
  });

  test("a real contact literally named \"All\" wins over the reserved token", () => {
    const contactsMap = { "x@s.whatsapp.net": { name: "All" } };
    expect(isReservedAllToken("all", contactsMap)).toBe(false);
  });

  test("any other entry is never the reserved token", () => {
    expect(isReservedAllToken("Akash", {})).toBe(false);
    expect(isReservedAllToken("61434505973", {})).toBe(false);
  });
});

describe("expandAllMention", () => {
  test("every participant gets a pair, all sharing input \"all\"", () => {
    const pairs = expandAllMention(
      ["61434505973@s.whatsapp.net", "184710990000999@lid"],
      jidNormalizedUser,
    );
    expect(pairs).toEqual([
      { input: "all", jid: "61434505973@s.whatsapp.net" },
      { input: "all", jid: "184710990000999@lid" },
    ]);
  });

  test("a device suffix is normalized away, same as any other jid input", () => {
    const pairs = expandAllMention(
      ["61434505973:5@s.whatsapp.net"],
      jidNormalizedUser,
    );
    expect(pairs).toEqual([{ input: "all", jid: "61434505973@s.whatsapp.net" }]);
  });

  test("no participants: empty array, not an error", () => {
    expect(expandAllMention([], jidNormalizedUser)).toEqual([]);
  });

  test("mentionsForChunk attaches every expanded pair when the text says @all", () => {
    const pairs = expandAllMention(
      ["a@s.whatsapp.net", "b@s.whatsapp.net", "c@lid"],
      jidNormalizedUser,
    );
    const result = mentionsForChunk("hey @all, meeting moved up", pairs);
    expect(result).toEqual(["a@s.whatsapp.net", "b@s.whatsapp.net", "c@lid"]);
  });

  test("mentionsForChunk does not false-match \"@all\" inside a longer word", () => {
    const pairs = expandAllMention(["a@s.whatsapp.net"], jidNormalizedUser);
    const result = mentionsForChunk("please allocate more time", pairs);
    expect(result).toBeUndefined();
  });

  test("a chunk that doesn't mention @all attaches nothing", () => {
    const pairs = expandAllMention(["a@s.whatsapp.net"], jidNormalizedUser);
    expect(mentionsForChunk("no group mention in here", pairs)).toBeUndefined();
  });
});

describe("mentionsForChunk", () => {
  test("matches on the original input id, not the resolved JID's local part", () => {
    // Regression for the bug where a number with a cached LID mapping
    // silently dropped out of the mentions array: normalizeMentionJids
    // resolves it to a different local part (the LID), but the caller
    // was told to (and did) type "@<phone-number>" in the text.
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    const pairs = normalizeMentionJids(
      ["61403911675"],
      lidMap,
      jidNormalizedUser,
      jidDecode,
    );
    const result = mentionsForChunk("hey @61403911675 you're up", pairs);
    expect(result).toEqual(["184710990000999@lid"]);
  });

  test("four mixed entries: only the ones referenced in this chunk's text are attached", () => {
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    const raw = ["61434505973", "23058185377", "61405070760", "61403911675"];
    const pairs = normalizeMentionJids(
      raw,
      lidMap,
      jidNormalizedUser,
      jidDecode,
    );
    const text =
      "@61434505973 @23058185377 @61405070760 @61403911675 all four, please";
    const result = mentionsForChunk(text, pairs);
    expect(result).toEqual([
      "61434505973@s.whatsapp.net",
      "23058185377@s.whatsapp.net",
      "61405070760@s.whatsapp.net",
      "184710990000999@lid",
    ]);
  });

  test("no match in this chunk's text returns undefined", () => {
    const pairs = normalizeMentionJids(
      ["61434505973"],
      {},
      jidNormalizedUser,
      jidDecode,
    );
    expect(mentionsForChunk("no mentions in here", pairs)).toBeUndefined();
  });

  test("a shorter mentioned id that prefixes a longer one doesn't false-match", () => {
    const pairs = normalizeMentionJids(
      ["6123", "61234567"],
      {},
      jidNormalizedUser,
      jidDecode,
    );
    const result = mentionsForChunk("hey @61234567 nice work", pairs);
    expect(result).toEqual(["61234567@s.whatsapp.net"]);
  });

  test("two input spellings for the same person produce one jid, not two", () => {
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    const pairs = normalizeMentionJids(
      ["184710990000999", "61403911675"],
      lidMap,
      jidNormalizedUser,
      jidDecode,
    );
    const result = mentionsForChunk(
      "@184710990000999 and @61403911675 are the same person",
      pairs,
    );
    expect(result).toEqual(["184710990000999@lid"]);
  });

  test("a name-based mention matches its @<Name> in text", () => {
    const contactsMap = { "x@s.whatsapp.net": { name: "Akash" } };
    const pairs = normalizeMentionJids(
      ["Akash"],
      {},
      jidNormalizedUser,
      contactsMap,
    );
    const result = mentionsForChunk("Hey @Akash, can you check?", pairs);
    expect(result).toEqual(["x@s.whatsapp.net"]);
  });

  test("a name that's a text-prefix of a longer word doesn't false-match", () => {
    // Same class of bug as the numeric-prefix case, now for names: "Akash"
    // must not match inside "Akashi".
    const contactsMap = { "x@s.whatsapp.net": { name: "Akash" } };
    const pairs = normalizeMentionJids(
      ["Akash"],
      {},
      jidNormalizedUser,
      contactsMap,
    );
    const result = mentionsForChunk("Have you met @Akashi?", pairs);
    expect(result).toBeUndefined();
  });

  test("casing drift between the resolved name and the text still matches", () => {
    // resolveByName matches "Akash"/"akash"/"AKASH" identically, so the
    // text match must not silently require the exact casing the caller
    // happened to resolve with.
    const contactsMap = { "x@s.whatsapp.net": { name: "Akash" } };
    const pairs = normalizeMentionJids(
      ["Akash"],
      {},
      jidNormalizedUser,
      contactsMap,
    );
    const result = mentionsForChunk("cc @akash for visibility", pairs);
    expect(result).toEqual(["x@s.whatsapp.net"]);
  });
});
