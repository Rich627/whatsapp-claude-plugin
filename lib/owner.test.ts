import { describe, expect, test } from "bun:test";
import { ownerStamp, parsePermissionReply } from "./owner";

const BOT = "1555000000@s.whatsapp.net";
const HUMAN = "886912345678@s.whatsapp.net";

describe("ownerStamp", () => {
  test("a fresh install stamps the linked account", () => {
    expect(ownerStamp(undefined, [], BOT)).toBe(BOT);
  });

  // The regression this exists for: a dedicated bot number with the human in
  // allowFrom kept its delivery chat before the owner field existed.
  test("an existing allowlist keeps allowFrom[0], not the linked account", () => {
    expect(ownerStamp(undefined, [HUMAN], BOT)).toBe(HUMAN);
  });

  test("a hand-set owner survives every later connect", () => {
    expect(ownerStamp(HUMAN, [BOT], BOT)).toBe(HUMAN);
    expect(ownerStamp(BOT, [HUMAN], BOT)).toBe(BOT);
  });

  test("an emptied owner is treated as absent and re-stamped", () => {
    expect(ownerStamp("", [], BOT)).toBe(BOT);
  });

  test("nothing is stamped before the linked account is known", () => {
    expect(ownerStamp(undefined, [HUMAN], "")).toBeUndefined();
  });
});

describe("parsePermissionReply", () => {
  test("accepts both words and both cases", () => {
    expect(parsePermissionReply("yes abcde")).toEqual({
      requestId: "abcde",
      behavior: "allow",
    });
    expect(parsePermissionReply("  N  ABCDE ")).toEqual({
      requestId: "abcde",
      behavior: "deny",
    });
    expect(parsePermissionReply("no abcde")).toEqual({
      requestId: "abcde",
      behavior: "deny",
    });
  });

  // Swallowing a real message - sender sees a tick, agent never sees the text
  // - is worse than missing an approval, so the shape is deliberately narrow.
  test("rejects anything that is not exactly an answer", () => {
    expect(parsePermissionReply("yes abcde please")).toBeNull();
    expect(parsePermissionReply("yes abcd")).toBeNull();
    expect(parsePermissionReply("yes abcdel")).toBeNull();
    expect(parsePermissionReply("yes ablde")).toBeNull(); // 'l' is not in the id alphabet
    expect(parsePermissionReply("yeah abcde")).toBeNull();
    expect(parsePermissionReply("")).toBeNull();
  });
});
