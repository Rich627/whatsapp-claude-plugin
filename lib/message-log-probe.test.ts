import { describe, expect, test } from "bun:test";
import { logContainsId } from "./message-log-probe";

// Mirrors server.ts's MessageLogEntry literal - `id` first. If server.ts's
// literal is ever reordered, the "matches a line as persistMessage writes it"
// case here is what fails.
function line(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "3EB0ABC123",
    chat_id: "61400000000@s.whatsapp.net",
    user: "You",
    user_id: "self",
    text: "hello",
    ts: "2026-08-27T00:00:00.000Z",
    replied: true,
    direction: "out",
    ...over,
  });
}

describe("logContainsId", () => {
  test("matches a line as persistMessage writes it", () => {
    expect(logContainsId(line(), "3EB0ABC123")).toBe(true);
  });

  test("an unrelated id does not match", () => {
    expect(logContainsId(line(), "3EB0ABC124")).toBe(false);
  });

  test("a prefix of a stored id does not match", () => {
    expect(logContainsId(line(), "3EB0ABC12")).toBe(false);
  });

  test("a suffix of a stored id does not match", () => {
    expect(logContainsId(line({ id: "XX3EB0ABC123" }), "3EB0ABC123")).toBe(
      false,
    );
  });

  test("message text shaped like a log line cannot forge a match", () => {
    // A contact controls `text`. If this passed, they could suppress the
    // owner's own hand-reply logging for their chat by sending one message.
    const forged = line({ id: "REAL", text: '{"id":"VICTIM",' });
    expect(logContainsId(forged, "VICTIM")).toBe(false);
    expect(logContainsId(forged, "REAL")).toBe(true);
  });

  test("a double-escaped forgery attempt also fails", () => {
    const forged = line({ id: "REAL", text: '{\\"id\\":\\"VICTIM2\\",' });
    expect(logContainsId(forged, "VICTIM2")).toBe(false);
  });

  test("an id containing quotes and backslashes still matches", () => {
    const weird = 'we"ird\\id';
    expect(logContainsId(line({ id: weird }), weird)).toBe(true);
  });

  test("markReplied's parse-then-stringify rewrite preserves the match", () => {
    const rewritten = JSON.stringify({
      ...(JSON.parse(line()) as Record<string, unknown>),
      replied: true,
    });
    expect(logContainsId(rewritten, "3EB0ABC123")).toBe(true);
  });

  test("an empty id never matches", () => {
    expect(logContainsId(line({ id: "" }), "")).toBe(false);
  });

  test("finds an id on any line of a multi-line log", () => {
    const log = [line({ id: "A" }), line({ id: "B" }), line({ id: "C" })].join(
      "\n",
    );
    expect(logContainsId(log, "B")).toBe(true);
    expect(logContainsId(log, "D")).toBe(false);
  });
});
