import { describe, expect, test } from "bun:test";
import { looksLikeNumber, maskNumber } from "./mask";

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
});
