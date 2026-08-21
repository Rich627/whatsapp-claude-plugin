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

  test("full JID input passes through normalized, unchanged as the match key", () => {
    const [pair] = normalizeMentionJids(
      ["61434505973@s.whatsapp.net"],
      {},
      jidNormalizedUser,
    );
    expect(pair).toEqual({
      input: "61434505973@s.whatsapp.net",
      jid: "61434505973@s.whatsapp.net",
    });
  });

  test("dedupes by resolved JID", () => {
    const pairs = normalizeMentionJids(
      ["61434505973", "@61434505973"],
      {},
      jidNormalizedUser,
    );
    expect(pairs).toHaveLength(1);
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
});
