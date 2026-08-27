import { describe, expect, test } from "bun:test";
import {
  awaitingReply,
  keepDroppedForContext,
  NOT_ADDRESSED,
  recentWindow,
  renderLogEntry,
  type ViewableEntry,
} from "./message-view";

const now = Date.parse("2026-08-27T09:00:00.000Z");
const minutesAgo = (m: number) => new Date(now - m * 60 * 1000).toISOString();
const hoursAgo = (h: number) =>
  new Date(now - h * 60 * 60 * 1000).toISOString();

describe("renderLogEntry", () => {
  test("owner entry, 30 minutes old: text intact", () => {
    const entry: ViewableEntry = {
      user: "self",
      text: "see you at six",
      ts: minutesAgo(30),
      direction: "out",
      by: "owner",
    };
    expect(renderLogEntry(entry, "Kaushik", now)).toEqual({
      who: "Kaushik",
      text: "see you at six",
    });
  });

  test("owner entry, 61 minutes old: expired", () => {
    const entry: ViewableEntry = {
      user: "self",
      text: "see you at six",
      ts: minutesAgo(61),
      direction: "out",
      by: "owner",
    };
    expect(renderLogEntry(entry, "Kaushik", now)).toEqual({
      who: "Kaushik",
      text: "replied (text expired)",
    });
  });

  test("owner entry, exactly 60 minutes old: boundary is strict >, not expired", () => {
    const entry: ViewableEntry = {
      user: "self",
      text: "see you at six",
      ts: minutesAgo(60),
      direction: "out",
      by: "owner",
    };
    expect(renderLogEntry(entry, "Kaushik", now)).toEqual({
      who: "Kaushik",
      text: "see you at six",
    });
  });

  test("bot out entry, 25 hours old: never expires, who stays You", () => {
    const entry: ViewableEntry = {
      user: "You",
      text: "on my way",
      ts: hoursAgo(25),
      direction: "out",
    };
    expect(renderLogEntry(entry, "Kaushik", now)).toEqual({
      who: "You",
      text: "on my way",
    });
  });

  test("contact in entry, 25 hours old: never expires, who is the contact", () => {
    const entry: ViewableEntry = {
      user: "Ravi",
      text: "sounds good",
      ts: hoursAgo(25),
      direction: "in",
    };
    expect(renderLogEntry(entry, "Kaushik", now)).toEqual({
      who: "Ravi",
      text: "sounds good",
    });
  });

  test("routed:false group entry: who carries the not-addressed suffix, text intact, never expires", () => {
    const entry: ViewableEntry = {
      user: "Ravi",
      text: "meeting moved to 3",
      ts: hoursAgo(25),
      direction: "in",
      routed: false,
    };
    expect(renderLogEntry(entry, "Kaushik", now)).toEqual({
      who: `Ravi${NOT_ADDRESSED}`,
      text: "meeting moved to 3",
    });
  });

  test("owner entry is never marked not-addressed even with routed:false present", () => {
    const entry: ViewableEntry = {
      user: "Kaushik N",
      text: "ok",
      ts: minutesAgo(5),
      direction: "out",
      by: "owner",
      routed: false,
    };
    expect(renderLogEntry(entry, "Kaushik", now).who).toBe("Kaushik");
  });

  test("owner entry with an unparseable ts: fails closed (expired)", () => {
    const entry: ViewableEntry = {
      user: "self",
      text: "see you at six",
      ts: "not-a-date",
      direction: "out",
      by: "owner",
    };
    expect(renderLogEntry(entry, "Kaushik", now)).toEqual({
      who: "Kaushik",
      text: "replied (text expired)",
    });
  });

  test("owner entry, ownerName fallback: pass-through, no number anywhere", () => {
    const entry: ViewableEntry = {
      user: "self",
      text: "see you at six",
      ts: minutesAgo(30),
      direction: "out",
      by: "owner",
    };
    expect(renderLogEntry(entry, "You (by hand)", now)).toEqual({
      who: "You (by hand)",
      text: "see you at six",
    });
  });
});

describe("awaitingReply", () => {
  test("inbound, unreplied: waiting", () => {
    expect(awaitingReply({ replied: false, direction: "in" })).toBe(true);
  });
  test("legacy line with no direction: treated as inbound", () => {
    expect(awaitingReply({ replied: false })).toBe(true);
  });
  test("routed:false: never waiting, even unreplied", () => {
    expect(
      awaitingReply({ replied: false, direction: "in", routed: false }),
    ).toBe(false);
  });
  test("outbound or replied: not waiting", () => {
    expect(awaitingReply({ replied: false, direction: "out" })).toBe(false);
    expect(awaitingReply({ replied: true, direction: "in" })).toBe(false);
  });
});

describe("keepDroppedForContext", () => {
  test("only a group's no-mention drop is kept", () => {
    expect(keepDroppedForContext(true, "no-mention")).toBe(true);
    expect(keepDroppedForContext(false, "no-mention")).toBe(false);
    expect(keepDroppedForContext(true, undefined)).toBe(false);
    expect(keepDroppedForContext(true, "not-allowed")).toBe(false);
  });
});

describe("recentWindow", () => {
  test("8 entries in shuffled ts order, limit 5: returns the 5 newest, ascending ts", () => {
    const entries = [3, 7, 1, 8, 2, 6, 4, 5].map((n) => ({
      ts: hoursAgo(n),
      n,
    }));
    const input = [...entries];
    const result = recentWindow(entries, 5);
    expect(result.map((e) => e.n)).toEqual([5, 4, 3, 2, 1]);
    // ascending ts (oldest of the kept window first)
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].ts.localeCompare(result[i].ts)).toBeLessThan(0);
    }
    // input array unmodified
    expect(entries).toEqual(input);
  });

  test("3 entries, default limit: returns all 3, ascending ts", () => {
    const entries = [3, 1, 2].map((n) => ({ ts: hoursAgo(n), n }));
    const result = recentWindow(entries);
    expect(result.map((e) => e.n)).toEqual([3, 2, 1]);
  });
});
