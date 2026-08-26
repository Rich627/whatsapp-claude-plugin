import { describe, expect, test } from "bun:test";
import { looksLikeNumber, maskJid, maskNumber } from "./mask";

describe("maskNumber", () => {
  test("bare phone number shows only the last 4 digits", () => {
    expect(maskNumber("918419935122")).toBe("•••••5122");
  });

  test("full JID: domain suffix is stripped before masking", () => {
    expect(maskNumber("61403911675@s.whatsapp.net")).toBe("•••••1675");
  });

  test("LID JID: same treatment, no @lid leaking through", () => {
    expect(maskNumber("184710990000999@lid")).toBe("•••••0999");
  });

  test("mask length is fixed regardless of the number's own length", () => {
    // A 15-digit and an 11-digit number produce masks of the same length -
    // digit count itself is information (country code, format) and must
    // not leak through the mask's length.
    const short = maskNumber("61403911675");
    const long = maskNumber("447123456789012");
    expect(short.length).toBe(long.length);
  });

  test("4 or fewer digits: fully masked, nothing revealed", () => {
    expect(maskNumber("123")).toBe("•••••");
    expect(maskNumber("")).toBe("•••••");
  });

  test("non-digit punctuation (+, spaces, dashes) is stripped first", () => {
    expect(maskNumber("+61 403 911 675")).toBe("•••••1675");
  });
});

describe("looksLikeNumber", () => {
  test("a bare digit string looks like a number", () => {
    expect(looksLikeNumber("61403911675")).toBe(true);
  });

  test("with +, spaces, dashes, parens still counts as number-shaped", () => {
    expect(looksLikeNumber("+61 (403) 911-675")).toBe(true);
  });

  test("a real name does not look like a number", () => {
    expect(looksLikeNumber("Akash")).toBe(false);
  });

  test("a name containing digits (not purely numeric) is not number-shaped", () => {
    expect(looksLikeNumber("Room 42")).toBe(false);
  });

  test("very short digit runs (under 4 chars) are not treated as a number", () => {
    // Avoids flagging a short numeric-ish nickname like "007" as a leak -
    // maskNumber's own "4 or fewer digits" case already fully masks these
    // anyway, so nothing is lost by not treating them as number-shaped here.
    expect(looksLikeNumber("42")).toBe(false);
  });

  test("empty/blank string is not number-shaped", () => {
    expect(looksLikeNumber("")).toBe(false);
    expect(looksLikeNumber("   ")).toBe(false);
  });

  test("a number embedded in other text is still caught, not just a pure number", () => {
    // A .notify like "call 0403911675" is not ITSELF just a number, but it
    // still leaks the embedded one - the whole point of this check.
    expect(looksLikeNumber("call 0403911675")).toBe(true);
    expect(looksLikeNumber("WhatsApp: 0403 911 675")).toBe(true);
  });

  test("a short embedded digit run (under 6 digits) is not flagged", () => {
    expect(looksLikeNumber("Room 42, 3rd floor")).toBe(false);
    expect(looksLikeNumber("Agent 007")).toBe(false);
  });
});

describe("maskJid", () => {
  test("a user JID is masked", () => {
    expect(maskJid("61403911675@s.whatsapp.net")).toBe("•••••1675");
  });

  test("a LID is masked too - it carries real digits", () => {
    expect(maskJid("184710990000999@lid")).toBe("•••••0999");
  });

  test("a modern group JID passes through whole: it is the debug handle", () => {
    expect(maskJid("120363427665348138@g.us")).toBe("120363427665348138@g.us");
  });

  test("a LEGACY group JID has its creator's number masked, timestamp kept", () => {
    // The case the first version of maskJid got wrong: a bare @g.us
    // passthrough writes <creator-phone>-<created-at> to the diag log intact.
    expect(maskJid("61403911675-1443627404@g.us")).toBe(
      "•••••1675-1443627404@g.us",
    );
  });

  test("a device suffix does not shift the masked window", () => {
    // Off the wire a jid can be <number>:<device>@…; unstripped, the ":12"
    // is absorbed into the digit run and the same person renders two ways
    // depending on which call site normalized first.
    expect(maskJid("61403911675:12@s.whatsapp.net")).toBe(
      maskJid("61403911675@s.whatsapp.net"),
    );
  });

  test("undefined/empty does not throw or leak", () => {
    expect(maskJid("")).toBe("•••••");
    expect(maskJid(undefined as unknown as string)).toBe("•••••");
  });
  test("a broadcast/newsletter JID keeps its form - it names a channel", () => {
    expect(maskJid("status@broadcast")).toBe("status@broadcast");
    expect(maskJid("120363111111111111@newsletter")).toBe(
      "120363111111111111@newsletter",
    );
  });

  test("a LEGACY broadcast list still has its creator's number masked", () => {
    expect(maskJid("61403911675-1443627404@broadcast")).toBe(
      "•••••1675-1443627404@broadcast",
    );
  });
});
