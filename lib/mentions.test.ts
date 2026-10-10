import { describe, expect, test } from "bun:test";
import { generateWAMessageContent } from "@whiskeysockets/baileys";
import {
  isReservedAllToken,
  mentionContent,
  mentionsForChunk,
  mentionsInChat,
  normalizeMentionJids,
  type MentionPair,
} from "./mentions";
// Reused, not hand-rolled again: this is what scripts/ranking.ts mirrors
// Baileys' real jidNormalizedUser with (strips both the ":device" and
// "_agent" parts of the user segment, maps "@c.us" to "@s.whatsapp.net",
// does NOT lowercase). An earlier version of this mock only stripped the
// device suffix, which a code review caught as a divergence from the real
// export - importing the single already-correct implementation instead of
// maintaining a second hand-rolled mirror means it can't drift again.
import { normalizeJid as jidNormalizedUser } from "../scripts/ranking";

describe("normalizeMentionJids", () => {
  test("bare number with no cached LID resolves to the phone JID", () => {
    const [pair] = normalizeMentionJids(["61400045973"], {}, jidNormalizedUser);
    expect(pair).toEqual({
      input: "61400045973",
      jid: "61400045973@s.whatsapp.net",
    });
  });

  test("bare number with a cached LID resolves to the LID JID", () => {
    const lidMap = { "184710990000999@lid": "61400011675@s.whatsapp.net" };
    const [pair] = normalizeMentionJids(
      ["61400011675"],
      lidMap,
      jidNormalizedUser,
    );
    expect(pair).toEqual({
      input: "61400011675",
      jid: "184710990000999@lid",
    });
  });

  test("full JID input matches on its own local part, not the full string", () => {
    const [pair] = normalizeMentionJids(
      ["61400045973@s.whatsapp.net"],
      {},
      jidNormalizedUser,
    );
    expect(pair).toEqual({
      input: "61400045973",
      jid: "61400045973@s.whatsapp.net",
    });
  });

  test("a device-suffixed full JID matches on the bare number, not the device id", () => {
    // reply_to_sender surfaces contextInfo.participant verbatim, which can
    // carry a device suffix ("<num>:12@s.whatsapp.net"). Nobody types
    // "@<num>:12" in reply text, so the match key must strip it the same
    // way jidNormalizedUser does before deriving input from the result.
    const [pair] = normalizeMentionJids(
      ["61400045973:12@s.whatsapp.net"],
      {},
      jidNormalizedUser,
    );
    expect(pair).toEqual({
      input: "61400045973",
      jid: "61400045973@s.whatsapp.net",
    });
  });

  test("full JID with a device suffix: the suffix doesn't end up in the match key", () => {
    // jidNormalizedUser strips ":5" for `jid`; if `input` kept it, the text
    // match would look for "@61400045973:5" while the caller wrote plain
    // "@61400045973" - silently unmatchable.
    const [pair] = normalizeMentionJids(
      ["61400045973:5@s.whatsapp.net"],
      {},
      jidNormalizedUser,
    );
    expect(pair).toEqual({
      input: "61400045973",
      jid: "61400045973@s.whatsapp.net",
    });
  });

  test("full JID with an _agent suffix: input is derived from the normalized jid, not re-parsed from the raw string", () => {
    // Regression: input used to come from a second, less complete regex
    // applied directly to the raw input, which only stripped a device
    // suffix - an _agent-suffixed JID kept "_5" in the match key even
    // though jidNormalizedUser (and so `jid`) correctly strips it, so the
    // text match for plain "@61400045973" would have silently missed.
    const [pair] = normalizeMentionJids(
      ["61400045973_5@s.whatsapp.net"],
      {},
      jidNormalizedUser,
    );
    expect(pair).toEqual({
      input: "61400045973",
      jid: "61400045973@s.whatsapp.net",
    });
  });

  test("full JID with both an _agent and a device suffix: both are stripped from the match key", () => {
    const [pair] = normalizeMentionJids(
      ["61400045973_5:9@s.whatsapp.net"],
      {},
      jidNormalizedUser,
    );
    expect(pair).toEqual({
      input: "61400045973",
      jid: "61400045973@s.whatsapp.net",
    });
  });

  test("a doubled leading @ doesn't produce an empty match key", () => {
    // A single-@ strip left "@61400045973" -> split("@")[0] === "" -> the
    // regex built from that empty input matched almost any "@" in the text.
    const [pair] = normalizeMentionJids(
      ["@@61400045973"],
      {},
      jidNormalizedUser,
    );
    expect(pair.input).toBe("61400045973");
  });

  test("two input spellings resolving to the same jid both survive", () => {
    // A LID and its phone number for the same person, passed as two
    // separate mentions entries: neither input should be silently dropped,
    // since the reply text might use either spelling.
    const lidMap = { "184710990000999@lid": "61400011675@s.whatsapp.net" };
    const pairs = normalizeMentionJids(
      ["184710990000999", "61400011675"],
      lidMap,
      jidNormalizedUser,
    );
    expect(pairs).toEqual([
      { input: "184710990000999", jid: "184710990000999@lid" },
      { input: "61400011675", jid: "184710990000999@lid" },
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
    const contactsMap = { "x@s.whatsapp.net": { name: "61400045973" } };
    const [pair] = normalizeMentionJids(
      ["61400045973"],
      {},
      jidNormalizedUser,
      contactsMap,
    );
    expect(pair.jid).toBe("x@s.whatsapp.net");
  });

  test("a resolved name prefers the LID form when known, same as the numeric path", () => {
    // Group participants are LID-addressed; a name resolved straight from
    // contacts.json used to ship the phone-form jid verbatim, which
    // silently fails to attach/notify in a LID-addressed group.
    const contactsMap = { "61400011675@s.whatsapp.net": { name: "Akash" } };
    const lidMap = { "184710990000999@lid": "61400011675@s.whatsapp.net" };
    const [pair] = normalizeMentionJids(
      ["Akash"],
      lidMap,
      jidNormalizedUser,
      contactsMap,
    );
    expect(pair).toEqual({ input: "Akash", jid: "184710990000999@lid" });
  });

  test("a name-shaped id that matches no contact throws, rather than shipping a nonsense jid", () => {
    // Previously fell through to the numeric/LID path and shipped
    // '"Someone Else"@s.whatsapp.net' - not a real jid, so WhatsApp
    // silently fails to notify while the tool call still reports success.
    expect(() =>
      normalizeMentionJids(["Someone Else"], {}, jidNormalizedUser, {}),
    ).toThrow(/doesn't match any saved contact/);
  });

  test("a name not in the contacts cache falls through to the old id-based path", () => {
    const [pair] = normalizeMentionJids(
      ["61400045973"],
      {},
      jidNormalizedUser,
      { "y@s.whatsapp.net": { name: "SomeoneElse" } },
    );
    expect(pair).toEqual({
      input: "61400045973",
      jid: "61400045973@s.whatsapp.net",
    });
  });

  test("no contactsMap passed at all: still works, old behaviour unchanged", () => {
    const [pair] = normalizeMentionJids(["61400045973"], {}, jidNormalizedUser);
    expect(pair.jid).toBe("61400045973@s.whatsapp.net");
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
      "918000005122@s.whatsapp.net": { name: "Neha" },
      "61400020760@s.whatsapp.net": { name: "Neha" },
    };
    try {
      normalizeMentionJids(["Neha"], {}, jidNormalizedUser, contactsMap);
      throw new Error("expected normalizeMentionJids to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("•••••5122");
      expect(msg).toContain("•••••0760");
      expect(msg).not.toContain("918000005122");
      expect(msg).not.toContain("61400020760");
    }
  });
});

describe("isReservedAllToken", () => {
  test('"all" with no saved contact of that name is the reserved token', () => {
    expect(isReservedAllToken("all", {})).toBe(true);
  });

  test("case-insensitive and @-stripped, same as any other mention entry", () => {
    expect(isReservedAllToken("@ALL", {})).toBe(true);
    expect(isReservedAllToken(" All ", {})).toBe(true);
  });

  test('a real contact literally named "All" wins over the reserved token', () => {
    const contactsMap = { "x@s.whatsapp.net": { name: "All" } };
    expect(isReservedAllToken("all", contactsMap)).toBe(false);
  });

  test("any other entry is never the reserved token", () => {
    expect(isReservedAllToken("Akash", {})).toBe(false);
    expect(isReservedAllToken("61400045973", {})).toBe(false);
  });

  // Regression: a `mentions` array survives JSON parsing before any element
  // is checked, so a non-string entry (a JSON number, or null) reaches here
  // raw - reported by review as `entry.trim is not a function` when this
  // called .trim() directly instead of coercing first, the same way
  // normalizeMentionJids already does.
  test("a non-string entry does not throw, coerced the same way normalizeMentionJids does", () => {
    expect(() => isReservedAllToken(42, {})).not.toThrow();
    expect(isReservedAllToken(42, {})).toBe(false);
    expect(() => isReservedAllToken(null, {})).not.toThrow();
    expect(isReservedAllToken(null, {})).toBe(false);
  });
});

describe("mentionsInChat", () => {
  const PN = "61400000001@s.whatsapp.net";
  const LID = "184710990000999@lid";
  const group = [{ id: LID, phoneNumber: PN }];

  test("a member resolved to a phone jid is moved onto the group's own id", () => {
    expect(
      mentionsInChat([{ input: "Akash", jid: PN }], group, jidNormalizedUser),
    ).toEqual([{ input: "Akash", jid: LID, inChat: true }]);
  });

  test("someone who is not in the chat is returned untouched", () => {
    const outsider = { input: "Zed", jid: "61400000009@s.whatsapp.net" };
    expect(mentionsInChat([outsider], group, jidNormalizedUser)).toEqual([
      outsider,
    ]);
    // A DM has no participants at all.
    expect(
      mentionsInChat([{ input: "Akash", jid: PN }], [], jidNormalizedUser),
    ).toEqual([{ input: "Akash", jid: PN }]);
  });
});

describe("mentionContent", () => {
  const PN = "61400000001@s.whatsapp.net";
  const LID = "184710990000999@lid";
  const lidMap = { [LID]: PN };
  const group = [{ id: LID, phoneNumber: PN }];
  const inGroup = (raw: string[], contacts = {}, map = lidMap) =>
    mentionsInChat(
      normalizeMentionJids(raw, map, jidNormalizedUser, contacts),
      group,
      jidNormalizedUser,
    );

  test("@all keeps its literal text and asks Baileys for the everyone-tag", () => {
    expect(mentionContent("hey @All, meeting moved up", [], true)).toEqual({
      text: "hey @all, meeting moved up",
      mentionAll: true,
    });
  });

  test('"all" requested but not written, or only inside a longer word: plain text', () => {
    expect(mentionContent("please @allocate time", [], true)).toEqual({
      text: "please @allocate time",
    });
    // "all" not requested: a literal "@all" someone typed is left alone.
    expect(mentionContent("hey @all", [], false)).toEqual({ text: "hey @all" });
  });

  test("a typed number becomes the attached jid's own id, so it renders as a tag", () => {
    expect(
      mentionContent("hey @61400000001 you're up", inGroup(["61400000001"])),
    ).toEqual({
      text: "hey @184710990000999 you're up",
      mentions: [LID],
    });
  });

  // No LID mapping is cached, so the name resolves to the phone jid. The
  // group lists this member by LID: the tag must use that, never the number.
  test("a saved name with no cached LID is tagged by the group's id, not the number", () => {
    const contacts = { [PN]: { name: "Akash" } };
    expect(
      mentionContent(
        "thanks @akash and @all",
        inGroup(["Akash"], contacts, {}),
        true,
      ),
    ).toEqual({
      text: "thanks @184710990000999 and @all",
      mentions: [LID],
      mentionAll: true,
    });
  });

  // The same call without the membership step: this is a DM, or a group the
  // person is not in. Nothing can render as a tag there, so the text must
  // stay exactly as typed - the alternative prints their number in the chat.
  test("someone not in the chat keeps the typed text; no number is written", () => {
    const contacts = { [PN]: { name: "Akash" } };
    const pairs = normalizeMentionJids(
      ["Akash"],
      {},
      jidNormalizedUser,
      contacts,
    );
    const out = mentionContent("ask @Akash about it", pairs);
    expect(out.text).toBe("ask @Akash about it");
    expect(out.text).not.toContain("61400000001");
    // Positive control: the same pair, once a member, IS rewritten.
    expect(
      mentionContent("ask @Akash about it", inGroup(["Akash"], contacts, {}))
        .text,
    ).toBe("ask @184710990000999 about it");
  });

  test("a name that starts another name does not steal its tag", () => {
    const pairs: MentionPair[] = [
      { input: "Sam", jid: "111@lid", inChat: true },
      { input: "Sam Smith", jid: "222@lid", inChat: true },
    ];
    expect(mentionContent("@Sam and @Sam Smith", pairs).text).toBe(
      "@111 and @222",
    );
  });

  // The mirror case: Sam is in the group, Sam Smith is not. The longer name
  // still owns its own text, so Sam's id is never written into it.
  test("a member's short name does not claim a longer non-member's name", () => {
    const pairs: MentionPair[] = [
      { input: "Sam", jid: "111@lid", inChat: true },
      { input: "Sam Smith", jid: "61400000002@s.whatsapp.net" },
    ];
    expect(mentionContent("@Sam Smith please review", pairs)).toEqual({
      text: "@Sam Smith please review",
      mentions: ["61400000002@s.whatsapp.net"],
    });
    // Positive control: named on his own, Sam is tagged.
    expect(mentionContent("@Sam, and @Sam Smith", pairs).text).toBe(
      "@111, and @Sam Smith",
    );
  });

  test("a name directly followed by a letter of a script written without spaces", () => {
    const pairs: MentionPair[] = [
      { input: "田中", jid: "111@lid", inChat: true },
    ];
    expect(mentionContent("@田中さん、確認お願いします", pairs)).toEqual({
      text: "@111さん、確認お願いします",
      mentions: ["111@lid"],
    });
    expect(mentionContent("@all你好", [], true)).toEqual({
      text: "@all你好",
      mentionAll: true,
    });
    // Control: an ASCII word that merely starts with the name is not a tag.
    expect(
      mentionContent("@Akashi is someone else", [
        { input: "Akash", jid: "111@lid", inChat: true },
      ]),
    ).toEqual({ text: "@Akashi is someone else" });
  });

  test("a chunk naming nobody carries no mention fields", () => {
    expect(
      mentionContent("nothing here", inGroup(["61400000001"]), true),
    ).toEqual({
      text: "nothing here",
    });
  });

  // What actually goes on the wire. The phone's own @all, measured
  // 2026-10-10, is nonJidMentions: 1 with NO member list.
  test("Baileys turns the result into nonJidMentions: 1, with a person tag beside it", async () => {
    const contacts = { [PN]: { name: "Akash" } };
    const wire = async (content: ReturnType<typeof mentionContent>) => {
      const m: any = await generateWAMessageContent(content, {} as any);
      return (m.extendedTextMessage ?? m).contextInfo;
    };
    expect(
      (await wire(mentionContent("hi @all", [], true))).nonJidMentions,
    ).toBe(1);
    const both = await wire(
      mentionContent("@Akash and @all", inGroup(["Akash"], contacts, {}), true),
    );
    expect(both.nonJidMentions).toBe(1);
    expect(both.mentionedJid).toEqual([LID]);
    // Control: without "all" requested, the everyone-tag is not set.
    const none = await wire(
      mentionContent("@Akash and @all", inGroup(["Akash"], contacts, {})),
    );
    expect(none.nonJidMentions).toBeFalsy();
  });
});

describe("mentionsForChunk", () => {
  test("matches on the original input id, not the resolved JID's local part", () => {
    // Regression for the bug where a number with a cached LID mapping
    // silently dropped out of the mentions array: normalizeMentionJids
    // resolves it to a different local part (the LID), but the caller
    // was told to (and did) type "@<phone-number>" in the text.
    const lidMap = { "184710990000999@lid": "61400011675@s.whatsapp.net" };
    const pairs = normalizeMentionJids(
      ["61400011675"],
      lidMap,
      jidNormalizedUser,
    );
    const result = mentionsForChunk("hey @61400011675 you're up", pairs);
    expect(result).toEqual(["184710990000999@lid"]);
  });

  test("four mixed entries: only the ones referenced in this chunk's text are attached", () => {
    const lidMap = { "184710990000999@lid": "61400011675@s.whatsapp.net" };
    const raw = ["61400045973", "23050005377", "61400020760", "61400011675"];
    const pairs = normalizeMentionJids(raw, lidMap, jidNormalizedUser);
    const text =
      "@61400045973 @23050005377 @61400020760 @61400011675 all four, please";
    const result = mentionsForChunk(text, pairs);
    expect(result).toEqual([
      "61400045973@s.whatsapp.net",
      "23050005377@s.whatsapp.net",
      "61400020760@s.whatsapp.net",
      "184710990000999@lid",
    ]);
  });

  test("no match in this chunk's text returns undefined", () => {
    const pairs = normalizeMentionJids(["61400045973"], {}, jidNormalizedUser);
    expect(mentionsForChunk("no mentions in here", pairs)).toBeUndefined();
  });

  test("a shorter mentioned id that prefixes a longer one doesn't false-match", () => {
    const pairs = normalizeMentionJids(
      ["6123", "61234567"],
      {},
      jidNormalizedUser,
    );
    const result = mentionsForChunk("hey @61234567 nice work", pairs);
    expect(result).toEqual(["61234567@s.whatsapp.net"]);
  });

  test("two input spellings for the same person produce one jid, not two", () => {
    const lidMap = { "184710990000999@lid": "61400011675@s.whatsapp.net" };
    const pairs = normalizeMentionJids(
      ["184710990000999", "61400011675"],
      lidMap,
      jidNormalizedUser,
    );
    const result = mentionsForChunk(
      "@184710990000999 and @61400011675 are the same person",
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
