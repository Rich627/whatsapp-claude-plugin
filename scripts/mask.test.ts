import { describe, expect, test } from "bun:test";
import { maskNumber } from "./mask";

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
