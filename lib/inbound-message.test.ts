import { describe, expect, test } from "bun:test";
import { extractMentions, extractText } from "./inbound-message";

const CLAUDE = "61434505973@s.whatsapp.net";
const OTHER = "61403911675@s.whatsapp.net";

describe("extractText", () => {
  test("plain conversation", () => {
    expect(extractText({ conversation: "hi" })).toBe("hi");
  });

  test("captions on each media variant", () => {
    expect(extractText({ imageMessage: { caption: "photo" } })).toBe("photo");
    expect(extractText({ videoMessage: { caption: "clip" } })).toBe("clip");
    expect(extractText({ documentMessage: { caption: "doc" } })).toBe("doc");
  });

  test("no body at all", () => {
    expect(extractText(null)).toBe("");
    expect(extractText({})).toBe("");
    expect(extractText({ imageMessage: {} })).toBe("");
  });
});

describe("extractMentions", () => {
  test("extendedTextMessage, the only variant that ever worked", () => {
    expect(
      extractMentions({
        extendedTextMessage: {
          text: `@${CLAUDE} hi`,
          contextInfo: { mentionedJid: [CLAUDE] },
        },
      }),
    ).toEqual([CLAUDE]);
  });

  // The regression this file exists for: in a requireMention group these were
  // silently dropped, because the caption was read as the body but the mention
  // that authorized it was not.
  test("captioned image, video and document carry mentions", () => {
    for (const variant of [
      "imageMessage",
      "videoMessage",
      "documentMessage",
    ] as const) {
      expect(
        extractMentions({
          [variant]: {
            caption: "look at this",
            contextInfo: { mentionedJid: [CLAUDE] },
          },
        }),
      ).toEqual([CLAUDE]);
    }
  });

  test("deduped across carriers, order preserved", () => {
    expect(
      extractMentions({
        extendedTextMessage: { contextInfo: { mentionedJid: [CLAUDE] } },
        imageMessage: { contextInfo: { mentionedJid: [OTHER, CLAUDE] } },
      }),
    ).toEqual([CLAUDE, OTHER]);
  });

  test("missing, null and empty entries yield an empty array", () => {
    expect(extractMentions(null)).toEqual([]);
    expect(extractMentions({ conversation: "no mentions here" })).toEqual([]);
    expect(
      extractMentions({
        imageMessage: { contextInfo: { mentionedJid: null } },
      }),
    ).toEqual([]);
    expect(
      extractMentions({
        imageMessage: { contextInfo: { mentionedJid: [null, ""] } },
      }),
    ).toEqual([]);
  });
});
