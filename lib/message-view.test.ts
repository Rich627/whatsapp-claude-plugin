import { describe, expect, test } from "bun:test";
import {
  awaitingReply,
  keepLogLine,
  NOT_ADDRESSED,
  recentBothSides,
  recentWindow,
  renderLogEntry,
  type ViewableEntry,
} from "./message-view";

const now = Date.parse("2026-08-27T09:00:00.000Z");
const minutesAgo = (m: number) => new Date(now - m * 60 * 1000).toISOString();
const hoursAgo = (h: number) =>
  new Date(now - h * 60 * 60 * 1000).toISOString();

// An owner hand-reply as persistMessage logs it; `over` varies one field.
const owner = (over: Partial<ViewableEntry> = {}): ViewableEntry => ({
  user: "self",
  text: "see you at six",
  ts: minutesAgo(30),
  direction: "out",
  by: "owner",
  ...over,
});

describe("renderLogEntry", () => {
  test("owner entry, 30 minutes old: text intact", () => {
    expect(renderLogEntry(owner(), "Kaushik", now)).toEqual({
      who: "Kaushik",
      text: "see you at six",
    });
  });

  test("owner entry, 61 minutes old: expired", () => {
    expect(
      renderLogEntry(owner({ ts: minutesAgo(61) }), "Kaushik", now),
    ).toEqual({ who: "Kaushik", text: "replied (text expired)" });
  });

  test("owner entry, exactly 60 minutes old: boundary is strict >, not expired", () => {
    expect(
      renderLogEntry(owner({ ts: minutesAgo(60) }), "Kaushik", now),
    ).toEqual({ who: "Kaushik", text: "see you at six" });
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
    const entry = owner({ user: "Kaushik N", text: "ok", routed: false });
    expect(renderLogEntry(entry, "Kaushik", now).who).toBe("Kaushik");
  });

  test("owner entry with an unparseable ts: fails closed (expired)", () => {
    expect(renderLogEntry(owner({ ts: "not-a-date" }), "Kaushik", now)).toEqual(
      { who: "Kaushik", text: "replied (text expired)" },
    );
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

describe("recentBothSides", () => {
  test("4 own texts no longer crowd out the one thing the room said", () => {
    const entries = [
      { ts: hoursAgo(9), direction: "in" as const, n: "them-old" },
      { ts: hoursAgo(8), direction: "out" as const, n: "me1" },
      { ts: hoursAgo(7), direction: "out" as const, n: "me2" },
      { ts: hoursAgo(6), direction: "out" as const, n: "me3" },
      { ts: hoursAgo(5), direction: "out" as const, n: "me4" },
      { ts: hoursAgo(4), direction: "out" as const, n: "me5" },
    ];
    // Plain window of 5 would drop "them-old"; both-sides keeps it.
    expect(recentWindow(entries, 5).map((e) => e.n)).not.toContain("them-old");
    expect(recentBothSides(entries, 5).map((e) => e.n)).toEqual([
      "them-old",
      "me1",
      "me2",
      "me3",
      "me4",
      "me5",
    ]);
  });

  test("each side is capped at limit, merged oldest-first, legacy lines count as theirs", () => {
    const entries: { ts: string; direction?: "in" | "out"; n: number }[] = [];
    for (let i = 1; i <= 8; i++) entries.push({ ts: hoursAgo(20 - i), n: i }); // theirs
    for (let i = 1; i <= 8; i++)
      entries.push({ ts: hoursAgo(10 - i), direction: "out", n: 100 + i });
    const got = recentBothSides(entries, 5).map((e) => e.n);
    expect(got).toEqual([4, 5, 6, 7, 8, 104, 105, 106, 107, 108]);
  });
});

describe("keepLogLine", () => {
  test("an UNANSWERED routed inbound lives 24h; an answered one is context and lives 7 days", () => {
    expect(keepLogLine({ ts: hoursAgo(23), direction: "in" }, now)).toBe(true);
    expect(keepLogLine({ ts: hoursAgo(25), direction: "in" }, now)).toBe(false);
    expect(
      keepLogLine({ ts: hoursAgo(25), direction: "in", replied: true }, now),
    ).toBe(true);
    expect(
      keepLogLine(
        { ts: hoursAgo(8 * 24), direction: "in", replied: true },
        now,
      ),
    ).toBe(false);
  });
  test("context lines live 7 days: unaddressed group chatter, own replies, owner hand replies", () => {
    const sixDays = hoursAgo(6 * 24);
    const eightDays = hoursAgo(8 * 24);
    expect(
      keepLogLine({ ts: sixDays, direction: "in", routed: false }, now),
    ).toBe(true);
    expect(
      keepLogLine({ ts: eightDays, direction: "in", routed: false }, now),
    ).toBe(false);
    expect(keepLogLine({ ts: sixDays, direction: "out" }, now)).toBe(true);
    expect(
      keepLogLine({ ts: sixDays, direction: "out", by: "owner" }, now),
    ).toBe(true);
  });
  test("a legacy line with no direction is treated as routed inbound; an unparseable ts is dropped", () => {
    expect(keepLogLine({ ts: hoursAgo(25) }, now)).toBe(false);
    expect(keepLogLine({ ts: "nope" }, now)).toBe(false);
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
});
