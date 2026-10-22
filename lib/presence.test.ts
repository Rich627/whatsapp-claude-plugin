import { describe, expect, test } from "bun:test";
import {
  parseTypingMaxMinutes,
  TypingIndicator,
  type PresenceState,
} from "./presence";

// A clock that only moves when the test says so, with interval timers that
// fire as it passes them.
function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { fn: () => void; ms: number; at: number }>();
  return {
    now: () => now,
    every(fn: () => void, ms: number) {
      const id = nextId++;
      timers.set(id, { fn, ms, at: now + ms });
      return () => void timers.delete(id);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        t.at += t.ms;
        if (timers.has(id)) t.fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

function harness(maxMs = 60_000, keyOf?: (chat: string) => string) {
  const clock = fakeClock();
  const sent: Array<[string, PresenceState]> = [];
  const typing = new TypingIndicator(
    {
      send: (chat, state) => sent.push([chat, state]),
      now: clock.now,
      every: clock.every,
      keyOf,
    },
    { refreshMs: 8_000, maxMs },
  );
  return { clock, sent, typing };
}

const CHAT = "15550000002@s.whatsapp.net";

describe("TypingIndicator", () => {
  test("start shows typing at once and keeps it up on every refresh", () => {
    const { clock, sent, typing } = harness();
    typing.start(CHAT);
    expect(sent).toEqual([[CHAT, "composing"]]);
    clock.advance(24_000);
    expect(sent).toEqual([
      [CHAT, "composing"],
      [CHAT, "composing"],
      [CHAT, "composing"],
      [CHAT, "composing"],
    ]);
    expect(typing.isActive(CHAT)).toBe(true);
  });

  test("stop clears it with paused and ends the refreshes", () => {
    const { clock, sent, typing } = harness();
    typing.start(CHAT);
    typing.stop(CHAT);
    expect(sent).toEqual([
      [CHAT, "composing"],
      [CHAT, "paused"],
    ]);
    expect(clock.pending()).toBe(0);
    clock.advance(60_000);
    expect(sent).toHaveLength(2);
    expect(typing.isActive(CHAT)).toBe(false);
  });

  test("the cap ends it with paused when nobody replies", () => {
    const { clock, sent, typing } = harness(20_000);
    typing.start(CHAT);
    clock.advance(30_000);
    expect(sent.at(-1)).toEqual([CHAT, "paused"]);
    expect(sent.filter(([, s]) => s === "composing")).toHaveLength(3);
    expect(typing.isActive(CHAT)).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  test("a second message restarts the cap instead of adding a second loop", () => {
    const { clock, sent, typing } = harness(20_000);
    typing.start(CHAT);
    clock.advance(16_000);
    typing.start(CHAT);
    expect(clock.pending()).toBe(1);
    clock.advance(16_000);
    expect(typing.isActive(CHAT)).toBe(true);
    clock.advance(8_000);
    expect(typing.isActive(CHAT)).toBe(false);
    expect(sent.at(-1)).toEqual([CHAT, "paused"]);
  });

  test("set switches to recording and the refreshes follow the new state", () => {
    const { clock, sent, typing } = harness();
    typing.start(CHAT);
    typing.set(CHAT, "recording");
    clock.advance(8_000);
    expect(sent).toEqual([
      [CHAT, "composing"],
      [CHAT, "recording"],
      [CHAT, "recording"],
    ]);
  });

  test("stop with nothing up sends nothing, unless forced", () => {
    const { sent, typing } = harness();
    typing.stop(CHAT);
    expect(sent).toEqual([]);
    typing.stop(CHAT, true);
    expect(sent).toEqual([[CHAT, "paused"]]);
  });

  test("set paused is a forced stop", () => {
    const { sent, typing } = harness();
    typing.set(CHAT, "paused");
    expect(sent).toEqual([[CHAT, "paused"]]);
  });

  test("chats are independent", () => {
    const other = "15550000003@s.whatsapp.net";
    const { clock, sent, typing } = harness();
    typing.start(CHAT);
    typing.start(other);
    typing.stop(CHAT);
    clock.advance(8_000);
    expect(sent.slice(-1)).toEqual([[other, "composing"]]);
    expect(typing.isActive(other)).toBe(true);
  });

  test("a reply to another spelling of the same chat still stops it", () => {
    const lid = "222222222222222@lid";
    const { sent, typing } = harness(60_000, (chat) =>
      chat === lid ? CHAT : chat,
    );
    typing.start(lid);
    typing.stop(CHAT);
    expect(typing.isActive(lid)).toBe(false);
    // Paused goes to the jid the indicator was shown on.
    expect(sent).toEqual([
      [lid, "composing"],
      [lid, "paused"],
    ]);
  });

  test("stop with a generation leaves an indicator a newer message started", () => {
    const { clock, sent, typing } = harness();
    typing.start(CHAT);
    const mark = typing.generation();
    // A new inbound lands while the older reply is still sending.
    typing.start(CHAT);
    typing.stop(CHAT, false, mark);
    expect(typing.isActive(CHAT)).toBe(true);
    clock.advance(8_000);
    expect(sent.at(-1)).toEqual([CHAT, "composing"]);
    // The reply to the newer message is not held back.
    typing.stop(CHAT, false, typing.generation());
    expect(typing.isActive(CHAT)).toBe(false);
  });

  test("stop with a generation still clears an indicator nothing restarted", () => {
    const { sent, typing } = harness();
    typing.start(CHAT);
    typing.stop(CHAT, false, typing.generation());
    expect(sent.at(-1)).toEqual([CHAT, "paused"]);
  });

  test("a voice note's recording stop leaves a newer inbound's typing up", () => {
    const { sent, typing } = harness();
    const rec = typing.set(CHAT, "recording");
    typing.start(CHAT);
    typing.stop(CHAT, true, rec);
    expect(typing.isActive(CHAT)).toBe(true);
    expect(sent).toEqual([
      [CHAT, "recording"],
      [CHAT, "composing"],
    ]);
  });

  test("a LID mapping learned after start does not strand the loop", () => {
    const lid = "222222222222222@lid";
    const mapped = new Set<string>();
    const { clock, sent, typing } = harness(30_000, (chat) =>
      chat === lid && mapped.has(lid) ? CHAT : chat,
    );
    typing.start(lid);
    mapped.add(lid);
    // A reply addressed by the phone form finds the loop and cancels it.
    typing.stop(CHAT);
    expect(typing.isActive(lid)).toBe(false);
    expect(clock.pending()).toBe(0);
    clock.advance(60_000);
    expect(sent).toEqual([
      [lid, "composing"],
      [lid, "paused"],
    ]);
  });

  test("a LID mapping learned after start: the cap still ends the loop", () => {
    const lid = "222222222222222@lid";
    const mapped = new Set<string>();
    const { clock, sent, typing } = harness(20_000, (chat) =>
      chat === lid && mapped.has(lid) ? CHAT : chat,
    );
    typing.start(lid);
    mapped.add(lid);
    clock.advance(30_000);
    expect(clock.pending()).toBe(0);
    expect(sent.at(-1)).toEqual([lid, "paused"]);
    expect(typing.isActive(lid)).toBe(false);
  });

  test("a message after the mapping joins the loop instead of adding one", () => {
    const lid = "222222222222222@lid";
    const mapped = new Set<string>();
    const { clock, typing } = harness(60_000, (chat) =>
      chat === lid && mapped.has(lid) ? CHAT : chat,
    );
    typing.start(lid);
    mapped.add(lid);
    typing.start(CHAT);
    expect(clock.pending()).toBe(1);
    typing.stop(lid);
    expect(clock.pending()).toBe(0);
  });

  test("with the cap at 0 a state is sent once and never refreshed", () => {
    const { clock, sent, typing } = harness(0);
    typing.start(CHAT);
    clock.advance(60_000);
    expect(sent).toEqual([[CHAT, "composing"]]);
    expect(clock.pending()).toBe(0);
    expect(typing.isActive(CHAT)).toBe(false);
  });

  test("with the cap at 0 no timer is scheduled for any chat (Cloud API)", () => {
    const { clock, typing } = harness(0);
    for (let i = 0; i < 20; i++) typing.start(`1555000${i}@s.whatsapp.net`);
    expect(clock.pending()).toBe(0);
  });
});

describe("parseTypingMaxMinutes", () => {
  test("unset or blank is the 10-minute default", () => {
    expect(parseTypingMaxMinutes(undefined)).toEqual({ ms: 600_000 });
    expect(parseTypingMaxMinutes("  ")).toEqual({ ms: 600_000 });
  });

  test("a number of minutes is used as given, fractions included", () => {
    expect(parseTypingMaxMinutes("3")).toEqual({ ms: 180_000 });
    expect(parseTypingMaxMinutes("0.5")).toEqual({ ms: 30_000 });
  });

  test("0 or less turns it off", () => {
    expect(parseTypingMaxMinutes("0")).toEqual({ ms: 0 });
    expect(parseTypingMaxMinutes("-1")).toEqual({ ms: 0 });
  });

  test("above 60 is clamped, with a note", () => {
    const out = parseTypingMaxMinutes("90");
    expect(out.ms).toBe(3_600_000);
    expect(out.note).toContain("using 60");
  });

  test("not a number falls back to the default, with a note", () => {
    const out = parseTypingMaxMinutes("ten");
    expect(out.ms).toBe(600_000);
    expect(out.note).toContain("not a number");
  });
});
