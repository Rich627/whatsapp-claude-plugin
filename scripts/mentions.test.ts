import { describe, expect, test } from "bun:test";
import { mentionsForChunk, normalizeMentionJids } from "./mentions";

// Minimal stand-in for Baileys' jidNormalizedUser: lowercases and strips the
// device suffix, which is all these functions rely on.
const jidNormalizedUser = (jid: string): string =>
  jid.toLowerCase().replace(/:\d+(?=@)/, "");

describe("normalizeMentionJids", () => {
  test("bare number with no cached LID resolves to the phone JID", () => {
    const [pair] = normalizeMentionJids(["61434505973"], {}, jidNormalizedUser);
    expect(pair).toEqual({
      input: "61434505973",
      jid: "61434505973@s.whatsapp.net",
    });
  });

  test("bare number with a cached LID resolves to the LID JID", () => {
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    const [pair] = normalizeMentionJids(["61403911675"], lidMap, jidNormalizedUser);
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
    );
    expect(pairs).toEqual([
      { input: "184710990000999", jid: "184710990000999@lid" },
      { input: "61403911675", jid: "184710990000999@lid" },
    ]);
  });
});

describe("mentionsForChunk", () => {
  test("matches on the original input id, not the resolved JID's local part", () => {
    // Regression for the bug where a number with a cached LID mapping
    // silently dropped out of the mentions array: normalizeMentionJids
    // resolves it to a different local part (the LID), but the caller
    // was told to (and did) type "@<phone-number>" in the text.
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    const pairs = normalizeMentionJids(["61403911675"], lidMap, jidNormalizedUser);
    const result = mentionsForChunk("hey @61403911675 you're up", pairs);
    expect(result).toEqual(["184710990000999@lid"]);
  });

  test("four mixed entries: only the ones referenced in this chunk's text are attached", () => {
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    const raw = [
      "61434505973",
      "23058185377",
      "61405070760",
      "61403911675",
    ];
    const pairs = normalizeMentionJids(raw, lidMap, jidNormalizedUser);
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
    const pairs = normalizeMentionJids(["61434505973"], {}, jidNormalizedUser);
    expect(mentionsForChunk("no mentions in here", pairs)).toBeUndefined();
  });

  test("a shorter mentioned id that prefixes a longer one doesn't false-match", () => {
    const pairs = normalizeMentionJids(["6123", "61234567"], {}, jidNormalizedUser);
    const result = mentionsForChunk("hey @61234567 nice work", pairs);
    expect(result).toEqual(["61234567@s.whatsapp.net"]);
  });

  test("two input spellings for the same person produce one jid, not two", () => {
    const lidMap = { "184710990000999@lid": "61403911675@s.whatsapp.net" };
    const pairs = normalizeMentionJids(
      ["184710990000999", "61403911675"],
      lidMap,
      jidNormalizedUser,
    );
    const result = mentionsForChunk(
      "@184710990000999 and @61403911675 are the same person",
      pairs,
    );
    expect(result).toEqual(["184710990000999@lid"]);
  });
});
