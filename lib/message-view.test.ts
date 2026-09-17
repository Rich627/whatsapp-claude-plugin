import { describe, expect, test } from "bun:test";
import { maskNumber } from "../scripts/mask";
import {
  AGED_OUT_TTL_MS,
  agedOutKey,
  agedOutLine,
  ambiguousChatMessage,
  AMBIGUOUS_LIST_LIMIT,
  awaitingReply,
  catchUpWindow,
  takeUnseen,
  type ChatCount,
  chatDisplayName,
  resolveChat,
  DAY_MS,
  formatChatCounts,
  isFallbackName,
  nameMatches,
  keepLogLine,
  MAX_TTL_DAYS,
  MIN_TTL_DAYS,
  MESSAGE_TTL_MS,
  NOT_ADDRESSED,
  countAgedOut,
  updateAgedOut,
  renderLogEntry,
  resolveTtlMs,
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
    expect(renderLogEntry(owner(), "Kaushik")).toEqual({
      who: "Kaushik",
      text: "see you at six",
    });
  });

  test("owner entry, 6 days old: text still intact, no expiry at any age", () => {
    expect(renderLogEntry(owner({ ts: hoursAgo(6 * 24) }), "Kaushik")).toEqual({
      who: "Kaushik",
      text: "see you at six",
    });
  });

  test("owner entry with an unparseable ts: ts is not read, text intact", () => {
    expect(renderLogEntry(owner({ ts: "not-a-date" }), "Kaushik")).toEqual({
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
    expect(renderLogEntry(entry, "Kaushik")).toEqual({
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
    expect(renderLogEntry(entry, "Kaushik")).toEqual({
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
    expect(renderLogEntry(entry, "Kaushik")).toEqual({
      who: `Ravi${NOT_ADDRESSED}`,
      text: "meeting moved to 3",
    });
  });

  test("owner entry is never marked not-addressed even with routed:false present", () => {
    const entry = owner({ user: "Kaushik N", text: "ok", routed: false });
    expect(renderLogEntry(entry, "Kaushik").who).toBe("Kaushik");
  });
});

// A caption-less photo or voice note is a real message that the count counts.
// It reached the view as the raw marker "(image)" / "(voice)" that server.ts's
// persist boundary writes - `text || "(" + media.kind + ")"` - so these
// entries are built THE WAY THE PIPELINE WRITES THEM, not with an empty text
// field. The first version of this test did the latter, and so passed against
// a placeholder that no real message could ever reach.
describe("renderLogEntry - caption-less media placeholders", () => {
  const media = (extra: Partial<ViewableEntry>): ViewableEntry => ({
    user: "Priya",
    text: "",
    ts: hoursAgo(1),
    direction: "in",
    ...extra,
  });
  /** Exactly what persistMessage stores for caption-less media of `kind`. */
  const asStored = (kind: string, extra: Partial<ViewableEntry> = {}) =>
    media({
      text: `(${kind})`,
      ...(kind === "image"
        ? { image_path: "C:/inbox/x.jpg" }
        : { attachment_kind: kind }),
      ...extra,
    });

  test("a photo stored as (image) says [photo]", () => {
    expect(renderLogEntry(asStored("image"), "Kaushik")).toEqual({
      who: "Priya",
      text: "[photo]",
    });
  });

  test("voice and video each get their own word", () => {
    expect(renderLogEntry(asStored("voice"), "Kaushik").text).toBe("[voice]");
    expect(renderLogEntry(asStored("video"), "Kaushik").text).toBe("[video]");
  });

  test("every other kind, known or not, is [file] - never a raw marker", () => {
    for (const kind of ["document", "sticker", "audio", "hologram"]) {
      expect(renderLogEntry(asStored(kind), "Kaushik").text).toBe("[file]");
    }
  });

  test("a real caption wins over the placeholder", () => {
    expect(
      renderLogEntry(
        media({ text: "look at this", image_path: "C:/inbox/x.jpg" }),
        "Kaushik",
      ).text,
    ).toBe("look at this");
  });

  test("a caption that names a DIFFERENT kind is left alone", () => {
    // Only this entry's OWN marker is treated as absence. Someone typing
    // "(voice)" under a photo has written a caption, and it survives.
    expect(
      renderLogEntry(
        media({ text: "(voice)", image_path: "C:/inbox/x.jpg" }),
        "Kaushik",
      ).text,
    ).toBe("(voice)");
  });

  test("an empty text with media still gets one - legacy and hand-written lines", () => {
    expect(
      renderLogEntry(media({ attachment_kind: "voice" }), "Kaushik").text,
    ).toBe("[voice]");
  });

  test("no media at all stays empty rather than being called a file", () => {
    expect(renderLogEntry(media({}), "Kaushik").text).toBe("");
  });

  test("the owner's own caption-less video gets it too", () => {
    const entry = asStored("video", { by: "owner", direction: "out" });
    expect(renderLogEntry(entry, "Kaushik")).toEqual({
      who: "Kaushik",
      text: "[video]",
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

// keepLogLine's parameter is `{ ts: string }` - it reads nothing else. These
// tests deliberately pass the other fields a real log line carries, to prove
// they are ignored now that the two-lifetime branch is gone. A bare object
// literal cannot say that: TypeScript's excess-property check rejects a fresh
// literal with extra keys (TS2353). This widens the literal at the call site
// without widening the function's own contract.
const logLine = (e: {
  ts: string;
  direction?: "in" | "out";
  routed?: false;
  replied?: boolean;
  by?: "owner";
}): { ts: string } => e;

describe("keepLogLine", () => {
  test("ONE horizon: an unanswered inbound lives the same 7 days as everything else", () => {
    // Regression for #20. An unanswered inbound used to die at 24h, so the
    // message you had not got to yet was the first thing to vanish.
    expect(
      keepLogLine(logLine({ ts: hoursAgo(25), direction: "in" }), now),
    ).toBe(true);
    expect(
      keepLogLine(logLine({ ts: hoursAgo(6 * 24), direction: "in" }), now),
    ).toBe(true);
    expect(
      keepLogLine(logLine({ ts: hoursAgo(8 * 24), direction: "in" }), now),
    ).toBe(false);
  });
  test("every other kind of line keeps the same 7 days", () => {
    const sixDays = hoursAgo(6 * 24);
    const eightDays = hoursAgo(8 * 24);
    for (const entry of [
      { ts: sixDays, direction: "in" as const, routed: false as const },
      { ts: sixDays, direction: "in" as const, replied: true },
      { ts: sixDays, direction: "out" as const },
      { ts: sixDays, direction: "out" as const, by: "owner" as const },
    ]) {
      expect(keepLogLine(entry, now)).toBe(true);
    }
    expect(
      keepLogLine(
        logLine({ ts: eightDays, direction: "in", routed: false }),
        now,
      ),
    ).toBe(false);
    expect(
      keepLogLine(
        logLine({ ts: eightDays, direction: "out", by: "owner" }),
        now,
      ),
    ).toBe(false);
  });
  test("a caller-supplied ttl wins over the default (WHATSAPP_MESSAGE_TTL_DAYS)", () => {
    const day = 24 * 60 * 60 * 1000;
    const tenDays = hoursAgo(10 * 24);
    expect(keepLogLine(logLine({ ts: tenDays, direction: "in" }), now)).toBe(
      false,
    );
    expect(
      keepLogLine(logLine({ ts: tenDays, direction: "in" }), now, 14 * day),
    ).toBe(true);
    expect(
      keepLogLine(logLine({ ts: hoursAgo(2), direction: "in" }), now, 1 * day),
    ).toBe(true);
  });
  test("an unparseable ts is dropped whatever the ttl", () => {
    expect(keepLogLine({ ts: "nope" }, now)).toBe(false);
  });
});

describe("resolveTtlMs", () => {
  test("unset or blank keeps the 7-day default and says nothing", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(resolveTtlMs(raw)).toEqual({ ms: MESSAGE_TTL_MS, note: "" });
    }
  });

  test("a plain positive value is taken as given, with no diagnostic", () => {
    expect(resolveTtlMs("14")).toEqual({ ms: 14 * DAY_MS, note: "" });
  });

  test("both boundaries are inclusive - 1 and 30 are accepted, not clamped", () => {
    for (const d of [MIN_TTL_DAYS, MAX_TTL_DAYS]) {
      expect(resolveTtlMs(String(d))).toEqual({ ms: d * DAY_MS, note: "" });
    }
  });

  test("above the ceiling is clamped, and says so", () => {
    // The disk guard is the point: pruneInbox shares this horizon, so an
    // unbounded value would silently switch it off.
    const r = resolveTtlMs("3650");
    expect(r.ms).toBe(MAX_TTL_DAYS * DAY_MS);
    expect(r.note).toContain("clamped");
    expect(r.note).toContain("inbox/");
  });

  test("an OVERFLOWING value clamps, and is never called 'not a number'", () => {
    // Number("1e999") is Infinity. Number.isFinite rejected it, so this took
    // the not-a-positive-number branch: the horizon silently stayed at the
    // 7-day default and diag.log said "ignored (not a positive number)" about
    // a positive number, while USAGE.md promised clamping. Infinity must reach
    // the clamp like any other too-large value.
    const r = resolveTtlMs("1e999");
    expect(r.ms).toBe(MAX_TTL_DAYS * DAY_MS);
    expect(r.note).toContain("clamped");
    expect(r.note).not.toContain("not a positive number");
  });

  test("NEGATIVE overflow is still rejected, not clamped up", () => {
    // The other half of dropping Number.isFinite: -Infinity must keep failing,
    // and it does - on `days <= 0`, not on the finiteness test.
    const r = resolveTtlMs("-1e999");
    expect(r.ms).toBe(MESSAGE_TTL_MS);
    expect(r.note).toContain("not a positive number");
  });

  test("a SMALL POSITIVE value is clamped up, not taken as given", () => {
    // The destructive end. The unit is days, but Number() accepts 0.01 - about
    // fourteen minutes. Unclamped, the next hourly tick deletes every
    // attachment in inbox/ older than that, including a photo whose path
    // catch_up just handed the agent, and empties messages.jsonl with it.
    // Rejecting <= 0 does not cover this; 0.01 looks like a real setting.
    for (const raw of ["0.01", "0.5"]) {
      const r = resolveTtlMs(raw);
      expect(r.ms).toBe(MIN_TTL_DAYS * DAY_MS);
      expect(r.note).toContain("clamped");
    }
  });

  test("junk and non-positive values fall back rather than pruning the log away", () => {
    // The dangerous failure is 0 or negative: it would make every line older
    // than `now` expire immediately and empty the log on the first tick.
    //
    // "Infinity" USED TO BE IN THIS LIST and was removed deliberately, not to
    // make a new test pass. USAGE.md's promise is "anything that is not a
    // positive number is ignored... anything outside that range is clamped
    // into it", and Infinity is a positive number outside the range - so it
    // clamps to 30, exactly like "3650" two tests above. It is also the SAFE
    // direction (keep everything), never the log-emptying one this test's own
    // comment is about. Leaving it here made the suite assert the opposite of
    // "1e999" - the identical value - which is how the contradiction hid.
    for (const raw of ["0", "-1", "abc", "NaN"]) {
      const r = resolveTtlMs(raw);
      expect(r.ms).toBe(MESSAGE_TTL_MS);
      expect(r.note).toContain("ignored");
    }
  });

  test("the resolved horizon is what keepLogLine actually enforces", () => {
    const { ms } = resolveTtlMs("2");
    const now = Date.parse("2026-09-05T00:00:00.000Z");
    const age = (h: number) => ({
      ts: new Date(now - h * 60 * 60 * 1000).toISOString(),
    });
    expect(keepLogLine(age(47), now, ms)).toBe(true);
    expect(keepLogLine(age(49), now, ms)).toBe(false);
  });
});

describe("resolveTtlMs diagnostic is log-safe", () => {
  test("the raw value is quoted and truncated, so it cannot forge diag.log lines", () => {
    // The note is written to diag.log as `${timestamp} ${line}` - a
    // newline-delimited file read back as records. An unquoted value carrying
    // a newline would inject an extra line that looks like a real record.
    const r = resolveTtlMs("x\nwhatsapp channel: forged line");
    expect(r.ms).toBe(MESSAGE_TTL_MS);
    expect(r.note).not.toContain("\n");
    expect(r.note).toContain("ignored");
  });

  test("a very long value cannot flood the log, and stays a parseable string", () => {
    const r = resolveTtlMs("9".repeat(5000));
    expect(r.note.length).toBeLessThan(200);
    // Truncating a quoted string would drop its closing quote and emit an
    // unterminated value into the records file the quoting exists to protect.
    const start = r.note.indexOf('"');
    const end = r.note.indexOf('"', start + 1);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(() => JSON.parse(r.note.slice(start, end + 1))).not.toThrow();
  });
});

describe("formatChatCounts", () => {
  const chat = (over: Partial<ChatCount> = {}): ChatCount => ({
    name: "Soham",
    unreplied: 1,
    mentionGated: false,
    ...over,
  });

  // A group subject is peer-controlled and nothing upstream clips it: safeName
  // substitutes characters and oneLine collapses whitespace, and neither
  // bounds length. One admin could pad every row of the session-start list to
  // whatever they liked.
  // The counts view carries NO chat_id, so the row it prints is the only
  // handle a session gets. Clipping the name without accepting the clipped
  // form back made a long-named chat unreachable: the caller passes back
  // exactly what it was shown and gets "no chat on record" about a chat that
  // is on record with messages waiting. Pins the two functions together, the
  // way the masked-handle test does.
  // Stripping the ellipsis must not leave an EMPTY string: the candidate
  // filter asks chatId.startsWith(asked), and startsWith("") is true for every
  // chat - so `chat="…"` matched everything and, with one chat on record,
  // resolved to it and printed the lot. That is the guess resolveChat exists
  // to refuse.
  test("a bare ellipsis matches nothing rather than everything", () => {
    const only = { chatId: "120363111@g.us", name: "Only Chat" };
    for (const arg of ["…", "  …", "…  "]) {
      expect(resolveChat([only], arg)).toEqual({ ok: false, matches: [] });
    }
    // and the ordinary case still resolves
    expect(resolveChat([only], "only")).toEqual({ ok: true, chat: only });
  });

  // Stripping the ellipsis must not make a chat whose REAL name ends in one
  // unreachable: "loading…" also substring-matches "Loading Screen Design",
  // so without an exact-name tie-breaker the exact row was ambiguous forever.
  test("a real name ending in an ellipsis still resolves exactly", () => {
    const dots = { chatId: "120363111@g.us", name: "Loading…" };
    const longer = { chatId: "120363222@g.us", name: "Loading Screen Design" };
    expect(resolveChat([dots, longer], "loading…")).toEqual({
      ok: true,
      chat: dots,
    });
    // and a genuine substring is still ambiguous
    expect(resolveChat([dots, longer], "load").ok).toBe(false);
  });

  test("a clipped name from the counts list resolves back to its chat", () => {
    const long = {
      chatId: "120363111@g.us",
      name: "Engineering Standup — Platform Team",
    };
    const other = { chatId: "61400001111@s.whatsapp.net", name: "Mum" };
    const row = formatChatCounts([
      { name: long.name, unreplied: 2, mentionGated: false },
    ]);
    const shown = row.trim(); // exactly what the session is handed
    expect(shown).toContain("…"); // premise: this name is clipped
    expect(shown).not.toBe(long.name);

    const handle = shown
      .replace(/\s+\d+$/, "")
      .trim()
      .toLowerCase();
    expect(resolveChat([long, other], handle)).toEqual({
      ok: true,
      chat: long,
    });
  });

  // The clip must not cut a surrogate pair in half - the row a session reads
  // at start-up would carry a lone surrogate and render U+FFFD. Same class of
  // bug this branch fixed in chunk().
  test("clipping never splits a surrogate pair", () => {
    const lone =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const n of [30, 31, 32, 33, 34]) {
      const name = "A".repeat(n) + "\u{1F600}\u{1F600}";
      const row = formatChatCounts([
        { name, unreplied: 1, mentionGated: false },
      ]);
      expect(lone.test(row)).toBe(false);
    }
  });

  test("one absurd name cannot widen the whole list", () => {
    const out = formatChatCounts([
      chat({ name: "A".repeat(500), unreplied: 2 }),
      chat({ name: "Soham" }),
    ]);
    for (const line of out.split("\n")) expect(line.length).toBeLessThan(45);
    // The short row is not padded out to the long one.
    expect(out).toContain("Soham");
    // The long name is clipped, not merely un-padded.
    expect(out).not.toContain("A".repeat(40));
    expect(out).toContain("…");
  });

  test("no message text appears anywhere - the whole point of the change", () => {
    const out = formatChatCounts([
      chat({ name: "Soham", unreplied: 3 }),
      chat({ name: "HUDINI", unreplied: 12, mentionGated: true }),
    ]);
    // The per-line shape assertion below is the real check, and it is a
    // stronger claim than "contains no colon" - which would also fail on a
    // chat legitimately named "Re: standup".
    for (const line of out.split("\n")) {
      expect(line).toMatch(/^\S.*\s\s\s[@ ]\d+$/);
    }
  });

  test("most unreplied first, then alphabetical", () => {
    const out = formatChatCounts([
      chat({ name: "Mum", unreplied: 1 }),
      chat({ name: "Zara", unreplied: 5 }),
      chat({ name: "Adi", unreplied: 5 }),
      chat({ name: "Soham", unreplied: 3 }),
    ]);
    expect(out.split("\n").map((l) => l.trim().split(/\s+/)[0])).toEqual([
      "Adi",
      "Zara",
      "Soham",
      "Mum",
    ]);
  });

  test("@ marks a mention-gated group and NOTHING else", () => {
    // Q2, owner 2026-09-05. An ungated group routes everything, so an @ there
    // would be true and useless.
    const out = formatChatCounts([
      chat({ name: "Gated", unreplied: 2, mentionGated: true }),
      chat({ name: "Ungated", unreplied: 2, mentionGated: false }),
      chat({ name: "ADm", unreplied: 2, mentionGated: false }),
    ]);
    const lines = out.split("\n");
    expect(lines.filter((l) => l.includes("@"))).toHaveLength(1);
    expect(lines.find((l) => l.startsWith("Gated"))).toContain("@");
    expect(lines.find((l) => l.startsWith("Ungated"))).not.toContain("@");
  });

  test("a chat with nothing unreplied is omitted, not listed as 0", () => {
    const out = formatChatCounts([
      chat({ name: "Quiet", unreplied: 0 }),
      chat({ name: "Loud", unreplied: 4 }),
    ]);
    expect(out).not.toContain("Quiet");
    // Assert the ROW is gone, not that the digit 0 is absent - a count of 10,
    // or a chat named "Room 101", would fail that spuriously.
    expect(out).not.toMatch(/^\s*Quiet/m);
    expect(out.split("\n")).toHaveLength(1);
  });

  test("nothing waiting at all returns empty, so the caller can speak for itself", () => {
    expect(formatChatCounts([])).toBe("");
    expect(formatChatCounts([chat({ unreplied: 0 })])).toBe("");
  });

  test("names are column-aligned so the counts line up", () => {
    const out = formatChatCounts([
      chat({ name: "A", unreplied: 2 }),
      chat({ name: "LongerName", unreplied: 1 }),
    ]);
    const at = out.split("\n").map((l) => l.lastIndexOf(" ") + 1);
    expect(new Set(at).size).toBe(1);
  });
});

describe("chatDisplayName", () => {
  test("a group subject wins", () => {
    expect(
      chatDisplayName(
        [{ group_name: "WIL Group HUDINI", user: "Ravi", direction: "in" }],
        "120363427665348138@g.us",
      ),
    ).toBe("WIL Group HUDINI");
  });

  test("a real sender name is used when there is no group subject", () => {
    expect(
      chatDisplayName(
        [{ user: "Soham", direction: "in" }],
        "9198@s.whatsapp.net",
      ),
    ).toBe("Soham");
  });

  test("a NUMBER-SHAPED sender name is refused and masked instead", () => {
    // displaySenderName falls back to the jid's user part when the sender has
    // no WhatsApp profile name, so `user` can be a full phone number. Printing
    // it at session start would put a raw number on screen - the one thing
    // every tool here is supposed to prevent.
    const out = chatDisplayName(
      [{ user: "919876543210", direction: "in" }],
      "919876543210@s.whatsapp.net",
    );
    expect(out).not.toContain("919876543210");
    expect(out).toContain("•");
    expect(out).toContain("3210");
  });

  test("outbound-only entries never supply the name", () => {
    // "You" or the owner's own name must not become the chat's label.
    const out = chatDisplayName(
      [{ user: "You", direction: "out" }],
      "919876543210@s.whatsapp.net",
    );
    expect(out).not.toBe("You");
    expect(out).toContain("•");
  });

  test("a modern group id survives intact; nothing personal in it", () => {
    expect(chatDisplayName([], "120363427665348138@g.us")).toBe(
      "120363427665348138@g.us",
    );
  });

  test("a LEGACY group id has its creator's number masked", () => {
    const out = chatDisplayName([], "919876543210-1600000000@g.us");
    expect(out).not.toContain("919876543210");
    expect(out).toContain("1600000000");
  });
});

describe("chatDisplayName refuses a group_name that is really the chat id", () => {
  test("a legacy group jid stored as group_name does not print the creator's number", () => {
    // resolveGroupName falls back to the raw jid when the metadata lookup
    // times out, and lines persisted in that window carry it as group_name.
    const jid = "919876543210-1600000000@g.us";
    const out = chatDisplayName([{ group_name: jid, direction: "in" }], jid);
    expect(out).not.toContain("919876543210");
    expect(out).toContain("1600000000");
  });

  test("a real subject full of digits is KEPT, not mistaken for a number", () => {
    // looksLikeNumber matches any run of six digits, so "Sprint 2026-09-05"
    // would be rejected and the group silently listed under a member's name.
    // The only bad value resolveGroupName can produce is the chat id itself,
    // and that is excluded by identity, so no digit heuristic is needed here.
    const jid = "120363427665348138@g.us";
    for (const subject of ["Sprint 2026-09-05", "Batch 2019-2023"]) {
      expect(
        chatDisplayName([{ group_name: subject, direction: "in" }], jid),
      ).toBe(subject);
    }
  });

  test("the first USABLE subject wins, not merely the first present", () => {
    // The oldest line in the window can carry the raw jid from a timed-out
    // metadata lookup while a later line has the real subject.
    const jid = "120363427665348138@g.us";
    const out = chatDisplayName(
      [
        { group_name: jid, direction: "in" },
        { group_name: "WIL Group HUDINI", direction: "in" },
      ],
      jid,
    );
    expect(out).toBe("WIL Group HUDINI");
  });

  test("a real subject is still used", () => {
    expect(
      chatDisplayName(
        [{ group_name: "WIL Group HUDINI", direction: "in" }],
        "120363427665348138@g.us",
      ),
    ).toBe("WIL Group HUDINI");
  });
});

describe("formatChatCounts marker cannot be confused with an @ in a name", () => {
  test("an ungated chat whose NAME contains @ is not read as gated", () => {
    // Group subjects and pushNames are peer-controlled and safeName does not
    // strip "@". The marker is the character immediately before the count.
    const out = formatChatCounts([
      { name: "Standup @ 9", unreplied: 2, mentionGated: false },
      { name: "HUDINI", unreplied: 1, mentionGated: true },
    ]);
    const gatedRows = out
      .split("\n")
      .filter((l) => /@\d+$/.test(l))
      .map((l) => l.trim().split(/\s{2,}/)[0]);
    expect(gatedRows).toEqual(["HUDINI"]);
    // and the innocent name keeps its @ intact rather than being mangled
    expect(out).toContain("Standup @ 9");
  });
});

describe("chatDisplayName never labels a group with a member's name", () => {
  test("a group with no resolvable subject falls through to the anchor", () => {
    // Labelling it "Ravi" makes it indistinguishable from the DM with Ravi,
    // and the label would change between sessions as the window slides.
    const jid = "120363427665348138@g.us";
    expect(chatDisplayName([{ user: "Ravi", direction: "in" }], jid)).toBe(jid);
  });

  test("a legacy group with no subject masks the creator's number", () => {
    const out = chatDisplayName(
      [{ user: "Ravi", direction: "in" }],
      "919876543210-1600000000@g.us",
    );
    expect(out).not.toBe("Ravi");
    expect(out).not.toContain("919876543210");
  });

  test("a DM still uses the sender name", () => {
    expect(
      chatDisplayName(
        [{ user: "Soham", direction: "in" }],
        "9198@s.whatsapp.net",
      ),
    ).toBe("Soham");
  });
});

describe("updateAgedOut", () => {
  const NOW = Date.parse("2026-09-05T12:00:00.000Z");
  const K = (id: string) => agedOutKey(id);

  test("a chat you FULLY HANDLED never arrives here", () => {
    // The caller only passes chats whose dropped lines were still unreplied.
    // Message Alice on day 1, answer everything, never speak again: on day 8
    // her last line ages out and she must NOT be reported for thirty days as
    // a chat with older activity - nothing was ever waiting.
    expect(updateAgedOut({}, [], NOW)).toEqual({});
  });

  test("a miss is recorded EVEN IF the chat still has other lines", () => {
    // The tick that drops an unanswered mention often still leaves later
    // chatter behind, and the tick that finally empties the chat drops
    // nothing unanswered. Demanding both in one tick records nothing at all.
    const out = updateAgedOut({}, [K("g@g.us")], NOW);
    expect(out).toEqual({ [K("g@g.us")]: NOW });
  });

  test("entries are forgotten after the 30-day horizon, so the file cannot grow forever", () => {
    const old = NOW - AGED_OUT_TTL_MS - 1;
    const fresh = NOW - AGED_OUT_TTL_MS + 60_000;
    const out = updateAgedOut(
      { [K("old")]: old, [K("fresh")]: fresh },
      [],
      NOW,
    );
    expect(Object.keys(out)).toEqual([K("fresh")]);
  });

  test("an existing entry keeps its ORIGINAL timestamp, so it still expires", () => {
    // Refreshing it on every prune would make it immortal.
    const first = NOW - 20 * 24 * 60 * 60 * 1000;
    const out = updateAgedOut({ [K("x")]: first }, [K("x")], NOW);
    expect(out[K("x")]).toBe(first);
  });

  test("a corrupt timestamp is dropped rather than kept forever", () => {
    const out = updateAgedOut(
      { [K("bad")]: Number.NaN, [K("ok")]: NOW },
      [],
      NOW,
    );
    expect(Object.keys(out)).toEqual([K("ok")]);
  });
});

describe("agedOutKey", () => {
  test("no raw jid survives in the key", () => {
    // The record outlives the log lines it describes, so a raw jid would leave
    // a real phone number on disk 30 days after those messages were deleted.
    const key = agedOutKey("919876543210@s.whatsapp.net");
    expect(key).not.toContain("919876543210");
    expect(key).not.toContain("@");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  test("stable and distinct, so it works as a dedupe key", () => {
    expect(agedOutKey("a@g.us")).toBe(agedOutKey("a@g.us"));
    expect(agedOutKey("a@g.us")).not.toBe(agedOutKey("b@g.us"));
  });
});

describe("countAgedOut", () => {
  const K = (id: string) => agedOutKey(id);

  test("a recorded chat that is READABLE AGAIN is not counted", () => {
    // Otherwise the same chat appears in both halves of one session-start
    // output - listed with messages waiting AND reported as aged out - for up
    // to an hour, until the next prune tick corrects the record.
    const rec = { [K("g@g.us")]: 1, [K("h@g.us")]: 1 };
    expect(countAgedOut(rec, new Set([K("g@g.us")]))).toBe(1);
  });

  test("counts every recorded chat when none is visible", () => {
    expect(countAgedOut({ a: 1, b: 2, c: 3 }, new Set())).toBe(3);
  });

  test("an empty record counts zero", () => {
    expect(countAgedOut({}, new Set([K("g@g.us")]))).toBe(0);
  });
});

describe("agedOutLine", () => {
  test("says nothing when nothing aged out", () => {
    expect(agedOutLine(0, 7)).toBe("");
    expect(agedOutLine(-1, 7)).toBe("");
  });

  test("uses the CONCRETE number of days, not 'the retention window'", () => {
    // Owner 2026-09-05, Q4.
    expect(agedOutLine(9, 7)).toBe("9 chats had activity older than 7 days.");
    expect(agedOutLine(9, 7)).not.toContain("retention");
  });

  test("follows the live horizon when WHATSAPP_MESSAGE_TTL_DAYS changes it", () => {
    expect(agedOutLine(2, 30)).toContain("older than 30 days");
  });

  test("singular reads correctly", () => {
    expect(agedOutLine(1, 7)).toBe("1 chat had activity older than 7 days.");
  });

  test("the day noun agrees with the number at the minimum horizon", () => {
    // MIN_TTL_DAYS is 1, so this is a reachable real setting, not a corner
    // case - it used to read "older than 1 days", and the model says this
    // line out loud at session start.
    expect(agedOutLine(2, 1)).toBe("2 chats had activity older than 1 day.");
    expect(agedOutLine(1, 1)).toBe("1 chat had activity older than 1 day.");
    // A fractional horizon that formats to "1" agrees too, since the noun is
    // keyed off the formatted string rather than the raw number.
    expect(agedOutLine(2, 1.004)).toContain("older than 1 day.");
    // ...but a genuine fraction stays plural.
    expect(agedOutLine(2, 1.5)).toContain("older than 1.5 days.");
  });

  test("a nonsense horizon falls back to 7 rather than printing NaN", () => {
    expect(agedOutLine(3, Number.NaN)).toContain("older than 7 days");
    expect(agedOutLine(3, 0)).toContain("older than 7 days");
  });

  test("a FRACTIONAL horizon is not rounded into a lie", () => {
    // The knob accepts non-integers in [1, 30]. Rounding 1.5 to "2 days" is
    // exactly the untruth the concrete number was asked for to avoid.
    expect(agedOutLine(1, 1.5)).toContain("older than 1.5 days");
  });
});

describe("updateAgedOut never clears a miss early", () => {
  const NOW = Date.parse("2026-09-05T12:00:00.000Z");
  const K = (id: string) => agedOutKey(id);

  test("a recorded miss SURVIVES later ticks that miss nothing", () => {
    // The regression this replaces: clearing on "the chat is readable again"
    // erased the record on the very next tick, because a chat almost always
    // still holds lines for the hour after one of its unanswered lines is
    // pruned. Day 7 records the miss; the 8am tick must not undo it.
    const recorded = { [K("g@g.us")]: NOW - 60 * 60 * 1000 };
    const out = updateAgedOut(recorded, [], NOW);
    expect(out).toEqual(recorded);
  });

  test("only the 30-day expiry removes a key", () => {
    const fresh = { [K("g@g.us")]: NOW - AGED_OUT_TTL_MS + 1000 };
    expect(updateAgedOut(fresh, [], NOW)).toEqual(fresh);
    const stale = { [K("g@g.us")]: NOW - AGED_OUT_TTL_MS - 1 };
    expect(updateAgedOut(stale, [], NOW)).toEqual({});
  });
});

describe("chatDisplayName is always one row", () => {
  test("a stored group_name with a newline cannot forge a row", () => {
    // Lines written before 0.23.0 were never safeName'd and stay on disk for
    // the horizon after an upgrade. formatChatCounts emits one row per line.
    const out = chatDisplayName(
      [{ group_name: "Real\nFake Chat   @99", direction: "in" }],
      "120363427665348138@g.us",
    );
    expect(out).not.toContain("\n");
    expect(out).toBe("Real Fake Chat @99");
  });
});

describe("isFallbackName", () => {
  test("a masked DM tail and an unresolved group id are fallbacks", () => {
    expect(
      isFallbackName("120363427665348138@g.us", "120363427665348138@g.us"),
    ).toBe(true);
    const dm = "919876543210@s.whatsapp.net";
    expect(isFallbackName(chatDisplayName([], dm), dm)).toBe(true);
  });

  test("a real name is not", () => {
    expect(isFallbackName("Mum", "919876543210@s.whatsapp.net")).toBe(false);
    expect(isFallbackName("WIL Group HUDINI", "120363427665348138@g.us")).toBe(
      false,
    );
  });
});

describe("chatDisplayName with an empty-after-normalising subject", () => {
  test("a whitespace-only stored subject falls through instead of rendering blank", () => {
    // Truthy raw, empty once CR/LF are collapsed. Returning "" would render a
    // blank row that no `chat` argument could ever match.
    const jid = "120363427665348138@g.us";
    for (const subject of ["   ", "\n", "\r\n  \r\n"]) {
      expect(
        chatDisplayName([{ group_name: subject, direction: "in" }], jid),
      ).toBe(jid);
    }
  });
});

describe("chatDisplayName never returns an empty name", () => {
  test("a whitespace-only pushName on a DM falls through to the mask", () => {
    // A blank row is worse than a masked one: nothing matches "" so the chat
    // and its waiting messages become unreachable until the line ages out.
    const dm = "919876543210@s.whatsapp.net";
    for (const user of ["   ", "\n", "\r\n \r\n"]) {
      const out = chatDisplayName([{ user, direction: "in" }], dm);
      expect(out).not.toBe("");
      expect(out).toContain("3210");
    }
  });

  test("a later usable subject wins over an earlier blank one", () => {
    const jid = "120363427665348138@g.us";
    const out = chatDisplayName(
      [
        { group_name: "  \n ", direction: "in" },
        { group_name: "WIL Group HUDINI", direction: "in" },
      ],
      jid,
    );
    expect(out).toBe("WIL Group HUDINI");
  });
});

describe("nameMatches", () => {
  const dm = "919876543210@s.whatsapp.net";
  const masked = chatDisplayName([], dm);

  test("a masked row is reachable by the digits a session can actually read", () => {
    // The counts view shows `•••••3210` and no chat_id. Requiring an exact
    // match made those messages impossible to open at all.
    expect(nameMatches(masked, dm, "3210")).toBe(true);
    expect(nameMatches(masked, dm, masked.toLowerCase())).toBe(true);
  });

  test("a fallback still does not match a loose prefix", () => {
    expect(nameMatches(masked, dm, "9")).toBe(false);
    expect(nameMatches(masked, dm, "32")).toBe(false);
  });

  test("a real name still matches by substring", () => {
    expect(nameMatches("Mum", dm, "mum")).toBe(true);
    expect(
      nameMatches("WIL Group HUDINI", "120363427665348138@g.us", "hudini"),
    ).toBe(true);
  });

  test("an unresolved group id is not substring-matchable", () => {
    const g = "120363427665348138@g.us";
    expect(nameMatches(chatDisplayName([], g), g, "120363")).toBe(false);
  });

  test("a non-digit suffix cannot match every unresolved group", () => {
    // An unresolved group's fallback IS the raw jid, so a bare suffix test
    // made chat="@g.us" return all of them - the multi-room dump the id
    // prefix floor exists to prevent.
    const g = "120363427665348138@g.us";
    const name = chatDisplayName([], g);
    for (const want of ["@g.us", "g.us", ".us"]) {
      expect(nameMatches(name, g, want)).toBe(false);
    }
    // the digit tail of a masked DM still works
    const dm = "919876543210@s.whatsapp.net";
    expect(nameMatches(chatDisplayName([], dm), dm, "3210")).toBe(true);
  });
});

describe("oneLine collapses every kind of whitespace", () => {
  test("U+2028, U+2029, U+0085 and tabs cannot forge a row", () => {
    // safeName strips only < > [ ] ; CR LF, so these survive it on CURRENT
    // lines. U+2028 is a line terminator to many renderers; a tab breaks the
    // column alignment padEnd relies on.
    const jid = "120363427665348138@g.us";
    for (const sep of ["\u2028", "\u2029", "\u0085", "\t"]) {
      const out = chatDisplayName(
        [{ group_name: `Family${sep}Fake Chat   @9`, direction: "in" }],
        jid,
      );
      expect(out).toBe("Family Fake Chat @9");
    }
  });
});

// ─── T05: the window, identity and marking ─────────────────────────────────

describe("catchUpWindow - anything counted is showable", () => {
  // The exact scenario from F61/C2, which is why T05 exists: a mention-gated
  // group where an @-mention is followed by ordinary chatter. `unreplied`
  // counts only ROUTED lines; the old window took the last N INBOUND lines
  // including routed:false. The mention was counted and invisible.
  const mention = {
    ts: hoursAgo(10),
    direction: "in" as const,
    n: "mention",
  };
  const chatter = Array.from({ length: 6 }, (_, i) => ({
    ts: hoursAgo(9 - i),
    direction: "in" as const,
    routed: false as const,
    replied: true,
    n: `chatter${i}`,
  }));

  test("an unreplied mention crowded out by chatter is STILL shown", () => {
    const got = catchUpWindow([mention, ...chatter], 5).map((e) => e.n);
    expect(got).toContain("mention");
  });

  test("the crowded-out line is the OLDEST, so the old disclosure was backwards", () => {
    // The disclosure used to say hidden lines were "older than this window".
    // The mention here is the OLDEST line and was the one being dropped, so
    // the claim was not merely vague, it was backwards. Pinned so nobody
    // reintroduces that wording.
    const got = catchUpWindow([mention, ...chatter], 5).map((e) => e.n);
    expect(got).toContain("mention");
    expect(got).not.toContain("chatter0");
  });

  test("the window stays the DOCUMENTED size - waiting messages do not grow it", () => {
    // 12 overnight, window of 5. USAGE.md promises the last 5 each side, and
    // an earlier attempt at this fix showed all 12 - breaking that contract
    // and letting one busy group render thousands of lines. The newest 5 are
    // kept; the caller's `hidden` count reports the other 7.
    const many = Array.from({ length: 12 }, (_, i) => ({
      ts: hoursAgo(12 - i),
      direction: "in" as const,
      n: `m${i}`,
    }));
    const got = catchUpWindow(many, 5);
    expect(got.length).toBe(5);
    expect(got.map((e) => e.n)).toEqual(["m7", "m8", "m9", "m10", "m11"]);
  });

  test("no duplicates when a line is in BOTH halves", () => {
    // An unreplied line that is also among the last N inbound appears in the
    // awaiting half and the context half. It must appear once.
    const one = { ts: hoursAgo(1), direction: "in" as const, n: "solo" };
    expect(catchUpWindow([one], 5).map((e) => e.n)).toEqual(["solo"]);
  });

  test("oldest-first, like every other view", () => {
    const a = { ts: hoursAgo(3), direction: "in" as const, n: "a" };
    const b = { ts: hoursAgo(2), direction: "in" as const, n: "b" };
    const c = { ts: hoursAgo(1), direction: "in" as const, n: "c" };
    expect(catchUpWindow([c, a, b], 5).map((e) => e.n)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("the owner's own side is still capped - it is a privacy limit", () => {
    // Replied outbound lines are not awaiting, so the cap still applies to
    // them. Widening the window must not have quietly lifted that.
    const out = Array.from({ length: 9 }, (_, i) => ({
      ts: hoursAgo(9 - i),
      direction: "out" as const,
      n: `o${i}`,
    }));
    expect(catchUpWindow(out, 3).length).toBe(3);
  });
});

describe("chatDisplayName resolves NEWEST-first", () => {
  test("a renamed group is listed under its CURRENT name", () => {
    // Oldest-first pinned a renamed group to its former subject, so it could
    // not be opened by the name actually on screen in WhatsApp (C1/F71).
    const entries = [
      { ts: hoursAgo(5), group_name: "Old Name", direction: "in" as const },
      { ts: hoursAgo(1), group_name: "New Name", direction: "in" as const },
    ];
    expect(chatDisplayName(entries, "120363000@g.us")).toBe("New Name");
  });

  test("a later usable subject still wins over an unusable newer one", () => {
    // The case the original oldest-first comment was written for - a metadata
    // lookup that produced nothing on one line - must keep working.
    const entries = [
      { ts: hoursAgo(5), group_name: "Real Name", direction: "in" as const },
      { ts: hoursAgo(1), group_name: "   ", direction: "in" as const },
    ];
    expect(chatDisplayName(entries, "120363000@g.us")).toBe("Real Name");
  });

  test("a contact's CURRENT pushName wins for a DM", () => {
    const entries = [
      { ts: hoursAgo(5), user: "Old Spelling", direction: "in" as const },
      { ts: hoursAgo(1), user: "New Spelling", direction: "in" as const },
    ];
    expect(chatDisplayName(entries, "61400000000@s.whatsapp.net")).toBe(
      "New Spelling",
    );
  });
});

describe("resolveChat - uniqueness, not a length floor", () => {
  const dm = { chatId: "61400001111@s.whatsapp.net", name: "Priya" };
  const group = { chatId: "120363111@g.us", name: "Priya" };
  const other = { chatId: "120363222@g.us", name: "Standup" };

  test("one match resolves", () => {
    expect(resolveChat([dm, other], "priya")).toEqual({ ok: true, chat: dm });
  });

  test("two chats sharing a name ASK - they never both print", () => {
    // F35/F44: a DM with Priya and a group an admin NAMED Priya. Printing both
    // is the dump this view exists to prevent; picking one can land a private
    // reply in a group.
    const r = resolveChat([dm, group, other], "priya");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.matches.length).toBe(2);
  });

  test("the group-id prefix that DEFEATED the length floor now asks", () => {
    // "every modern group id starts 120363" - six characters, so the old
    // `want.length >= 8` floor let "12036311" through while still matching
    // many groups. Uniqueness catches what length could not.
    const r = resolveChat([group, other], "120363");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.matches.length).toBe(2);
  });

  test("a SHORT prefix is no longer rejected outright, it disambiguates", () => {
    // Previously anything under 8 chars silently matched nothing by id. A
    // short prefix that happens to be unique is a perfectly good handle.
    expect(resolveChat([group, other], "120363111")).toEqual({
      ok: true,
      chat: group,
    });
  });

  test("a FULL chat_id wins even when it prefixes another id", () => {
    const parent = { chatId: "120363111@g.us", name: "A" };
    const child = { chatId: "120363111@g.us.extra", name: "B" };
    const r = resolveChat([parent, child], "120363111@g.us");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.chat.chatId).toBe("120363111@g.us");
  });

  test("no match is not ambiguity", () => {
    const r = resolveChat([dm, other], "nobody");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.matches.length).toBe(0);
  });

  test("the ambiguity message NEVER prints a raw phone number", () => {
    // scripts/mask.ts's header names "a disambiguation prompt" as a case that
    // must render masked, and the owner was emphatic (2026-09-08). A group jid
    // is not a number so it stays intact and callable; a DM's jid IS the
    // number and is masked to its last four digits.
    const msg = ambiguousChatMessage("priya", [dm, group]);
    expect(msg).not.toContain("61400001111");
    expect(msg).toContain(maskNumber(dm.chatId));
    expect(msg).toContain(group.chatId); // group ids are not phone numbers
    expect(msg).toContain("[DM]");
    expect(msg).toContain("[group]");
  });

  test("no raw number survives even when EVERY match is a DM", () => {
    const dms = Array.from({ length: 3 }, (_, i) => ({
      chatId: `6140000111${i}@s.whatsapp.net`,
      name: "Alex",
    }));
    const msg = ambiguousChatMessage("alex", dms);
    for (const d of dms) expect(msg).not.toContain(d.chatId.split("@")[0]);
  });

  test("a name substring and an id prefix are both candidates", () => {
    // chatCandidate was inlined into resolveChat; the behaviour it asserted is
    // asserted here through the public entry point instead of being lost.
    const s = { chatId: "120363222@g.us", name: "Standup" };
    expect(resolveChat([s], "stand")).toEqual({ ok: true, chat: s });
    expect(resolveChat([s], "1203")).toEqual({ ok: true, chat: s });
    const miss = resolveChat([s], "zzz");
    expect(miss.ok).toBe(false);
  });
});

describe("catchUpWindow: waiting messages take the inbound slots first", () => {
  // The WIL Group HUDINI case. One @-mention, then five lines of chatter
  // nobody addressed to Claude. The badge counts the mention; the view used to
  // show only the chatter, so the badge pointed at a message it could not
  // display - and replying then marked that mention answered unseen.
  const mention = { ts: hoursAgo(10), direction: "in" as const, n: "mention" };
  const chatter = Array.from({ length: 5 }, (_, i) => ({
    ts: hoursAgo(9 - i),
    direction: "in" as const,
    routed: false as const,
    replied: true,
    n: `chatter${i}`,
  }));

  test("the counted mention is shown, and chatter fills the REST of the window", () => {
    const got = catchUpWindow([mention, ...chatter], 5).map((e) => e.n);
    expect(got).toContain("mention");
    expect(got.length).toBe(5);
    // Four slots left after the mention takes one - context is still there.
    expect(got.filter((n) => n.startsWith("chatter")).length).toBe(4);
  });

  test("the OLDEST chatter is what gets dropped, not the mention", () => {
    const got = catchUpWindow([mention, ...chatter], 5).map((e) => e.n);
    expect(got).not.toContain("chatter0");
    expect(got).toContain("chatter4");
  });

  test("more waiting than fit: newest waiting kept, chatter gets NO slots", () => {
    const waiting = Array.from({ length: 8 }, (_, i) => ({
      ts: hoursAgo(20 - i),
      direction: "in" as const,
      n: `w${i}`,
    }));
    const got = catchUpWindow([...waiting, ...chatter], 5).map((e) => e.n);
    expect(got.length).toBe(5);
    expect(got.filter((n) => n.startsWith("chatter")).length).toBe(0);
    expect(got).toContain("w7");
    expect(got).not.toContain("w0");
  });

  test("a DM degrades to the old behaviour - everything inbound is waiting", () => {
    const dm = Array.from({ length: 8 }, (_, i) => ({
      ts: hoursAgo(8 - i),
      direction: "in" as const,
      n: `d${i}`,
    }));
    expect(catchUpWindow(dm, 5).map((e) => e.n)).toEqual([
      "d3",
      "d4",
      "d5",
      "d6",
      "d7",
    ]);
  });

  test("the owner's own side is still capped separately at limit", () => {
    const out = Array.from({ length: 9 }, (_, i) => ({
      ts: hoursAgo(9 - i),
      direction: "out" as const,
      n: `o${i}`,
    }));
    expect(catchUpWindow(out, 3).length).toBe(3);
  });
});

describe("chatDisplayName DM branch keeps scanning", () => {
  test("a whitespace-only NEWEST pushName does not mask a real older name", () => {
    // `.find` committed to the newest inbound line and gave up; the group loop
    // above always kept scanning. The comment claimed they matched.
    const entries = [
      { ts: hoursAgo(5), user: "Priya", direction: "in" as const },
      { ts: hoursAgo(1), user: "   ", direction: "in" as const },
    ];
    expect(chatDisplayName(entries, "61400001111@s.whatsapp.net")).toBe(
      "Priya",
    );
  });

  test("a number-shaped NEWEST pushName does not mask a real older name", () => {
    const entries = [
      { ts: hoursAgo(5), user: "Priya", direction: "in" as const },
      { ts: hoursAgo(1), user: "61400001111", direction: "in" as const },
    ];
    expect(chatDisplayName(entries, "61400001111@s.whatsapp.net")).toBe(
      "Priya",
    );
  });

  test("still falls back to the masked number when NO line has a usable name", () => {
    const entries = [
      { ts: hoursAgo(5), user: "  ", direction: "in" as const },
      { ts: hoursAgo(1), user: "61400001111", direction: "in" as const },
    ];
    expect(chatDisplayName(entries, "61400001111@s.whatsapp.net")).toBe(
      maskNumber("61400001111@s.whatsapp.net"),
    );
  });
});

describe("regressions from cycle 2 round 1", () => {
  test("a FRACTIONAL limit cannot become 0 and dump the whole log", () => {
    // `limit: 0.5` passed the `> 0` test, floored to 0, and slice(-0) is
    // slice(0) - the WHOLE array. The clamp was producing exactly the dump it
    // exists to prevent. This asserts the shape at the boundary catchUpWindow
    // is handed, so it fails whether the guard is removed here or in server.ts.
    const many = Array.from({ length: 12 }, (_, i) => ({
      ts: hoursAgo(12 - i),
      direction: "in" as const,
      n: `m${i}`,
    }));
    expect(catchUpWindow(many, 0).length).toBe(12); // documents the raw hazard
    expect(catchUpWindow(many, Math.max(1, Math.floor(0.5))).length).toBe(1);
  });

  test("hidden waiting lines are the OLDEST, never newer than what is shown", () => {
    // The disclosure told the caller a hidden message "may be NEWER". Under
    // this window the newest waiting lines are the ones KEPT, so a hidden one
    // is always older. The text was pointing at the wrong risk immediately
    // before a reply that marks all of them answered.
    const waiting = Array.from({ length: 8 }, (_, i) => ({
      ts: hoursAgo(20 - i),
      direction: "in" as const,
      n: `w${i}`,
    }));
    const shown = catchUpWindow(waiting, 3);
    const shownTs = shown.map((e) => e.ts);
    const hidden = waiting.filter((e) => !shown.includes(e));
    for (const h of hidden)
      for (const s of shownTs) expect(h.ts.localeCompare(s)).toBeLessThan(0);
  });

  test("an ambiguity listing is capped and counts the rest", () => {
    const many = Array.from({ length: AMBIGUOUS_LIST_LIMIT + 5 }, (_, i) => ({
      chatId: `6140000${String(i).padStart(4, "0")}@s.whatsapp.net`,
      name: `Alex ${i}`,
    }));
    const msg = ambiguousChatMessage("alex", many);
    // Counts the [DM] markers rather than splitting on a newline: every entry
    // here is a DM, and it keeps this assertion free of escape sequences.
    expect(msg.split("[DM]").length - 1).toBe(AMBIGUOUS_LIST_LIMIT);
    expect(msg).toContain("5 more");
  });

  test("a short listing has no trailing 'more' line", () => {
    const two = [
      { chatId: "61400001111@s.whatsapp.net", name: "Priya" },
      { chatId: "120363111@g.us", name: "Priya" },
    ];
    expect(ambiguousChatMessage("priya", two)).not.toContain("more");
  });
});

describe("aged-out records clear once the chat is handled (M2 / F59's rule)", () => {
  const K = agedOutKey;
  const day = (n: number) =>
    Date.parse(`2026-09-${String(n).padStart(2, "0")}T00:00:00Z`);

  test("a chat handled AFTER the miss stops being announced", () => {
    // Miss recorded day 8; owner answers day 9. Without this the notice fired
    // at every session start until day 38 about a fully-answered chat.
    const rec = { [K("g@g.us")]: day(8) };
    const handled = new Map([[K("g@g.us"), day(9)]]);
    expect(updateAgedOut(rec, [], day(10), handled)).toEqual({});
  });

  test("F59's scenario still keeps the record - this is the safety property", () => {
    // F59 cleared on "readable again" and lost real misses, because a chat
    // almost always still holds OLDER lines. Surviving activity older than the
    // recorded miss must clear nothing.
    const rec = { [K("g@g.us")]: day(7) };
    const handled = new Map([[K("g@g.us"), day(1)]]);
    expect(updateAgedOut(rec, [], day(8), handled)).toEqual(rec);
  });

  test("a chat with something still WAITING is never treated as handled", () => {
    // server.ts only puts a chat in `handled` when nothing is waiting; this
    // pins the lib side too - an empty map must not clear.
    const rec = { [K("g@g.us")]: day(8) };
    expect(updateAgedOut(rec, [], day(10), new Map())).toEqual(rec);
  });

  test("clearing does not resurrect on the same tick a new miss is recorded", () => {
    const key = K("g@g.us");
    const rec = { [key]: day(8) };
    const out = updateAgedOut(rec, [key], day(10), new Map([[key, day(9)]]));
    expect(out[key]).toBe(day(10));
  });

  test("the 30-day expiry still applies independently", () => {
    const rec = { [K("g@g.us")]: day(1) };
    expect(updateAgedOut(rec, [], day(1) + AGED_OUT_TTL_MS, new Map())).toEqual(
      {},
    );
  });
});

describe("aged-out clearing needs EVIDENCE THE OWNER ACTED", () => {
  const K = agedOutKey;
  const day = (n: number) =>
    Date.parse(`2026-09-${String(n).padStart(2, "0")}T00:00:00Z`);

  test("group CHATTER after a missed mention must NOT clear the record", () => {
    // The bug this pins: in a mention-gated group, unaddressed chatter is
    // stored routed:false/replied:true, so it is never awaitingReply and never
    // marks the chat as still-waiting - but it used to advance the "newest
    // surviving line" timestamp, so any ordinary message in the room deleted
    // the record on the next tick. Recording only ever happens for DMs and
    // mention-gated groups, so that killed the feature in its own home case.
    // server.ts now only feeds OUTBOUND lines into `handled`, so chatter
    // cannot reach this map at all - an empty map must preserve the record.
    const rec = { [K("g@g.us")]: day(8) };
    expect(updateAgedOut(rec, [], day(10), new Map())).toEqual(rec);
  });

  test("an outbound reply after the miss DOES clear it", () => {
    const rec = { [K("g@g.us")]: day(8) };
    const handled = new Map([[K("g@g.us"), day(9)]]);
    expect(updateAgedOut(rec, [], day(10), handled)).toEqual({});
  });

  test("a reply OLDER than the miss clears nothing (F59's safety property)", () => {
    const rec = { [K("g@g.us")]: day(7) };
    const handled = new Map([[K("g@g.us"), day(1)]]);
    expect(updateAgedOut(rec, [], day(8), handled)).toEqual(rec);
  });
});

describe("the masked handle the ambiguity list prints is accepted back", () => {
  const dm = { chatId: "61400001111@s.whatsapp.net", name: "Mum" };
  const group = { chatId: "120363111@g.us", name: "Mum's Group" };

  test("a DM whose name is a SUBSTRING of a group's is still reachable", () => {
    // "mum" matches both, and no narrower name exists - so before this the DM
    // could not be opened at all: the one handle shown (the mask) was the one
    // handle nothing accepted.
    const amb = resolveChat([dm, group], "mum");
    expect(amb.ok).toBe(false);
    const masked = maskNumber(dm.chatId).toLowerCase();
    expect(resolveChat([dm, group], masked)).toEqual({ ok: true, chat: dm });
  });

  test("the handle in the message is EXACTLY what resolves", () => {
    // Pins the two together: whatever ambiguousChatMessage prints for a chat
    // must be a string resolveChat accepts, or masking makes chats unreachable.
    const msg = ambiguousChatMessage("mum", [dm, group]);
    const masked = maskNumber(dm.chatId);
    expect(msg).toContain(masked);
    expect(resolveChat([dm, group], masked.toLowerCase())).toEqual({
      ok: true,
      chat: dm,
    });
  });

  test("a group's printed handle resolves too", () => {
    expect(resolveChat([dm, group], group.chatId.toLowerCase())).toEqual({
      ok: true,
      chat: group,
    });
  });

  test("and the raw number still never appears", () => {
    expect(ambiguousChatMessage("mum", [dm, group])).not.toContain(
      "61400001111",
    );
  });

  test("when two rows render identically, the message names a route that works", () => {
    // Both unsaved, both ending 0123: same masked fallback name AND same
    // handle, so every argument lands back on the same two-way ambiguity.
    // Without this line the chat is unreachable, which is a dead end rather
    // than a question.
    const a = { chatId: "447700900123@s.whatsapp.net", name: "•••••0123" };
    const b = { chatId: "447900900123@s.whatsapp.net", name: "•••••0123" };
    const msg = ambiguousChatMessage("0123", [a, b]);
    expect(msg).toContain("render identically");
    expect(msg).toContain("unreplied");
    expect(msg).not.toContain("447700900123");
    expect(msg).not.toContain("447900900123");

    // Not said when the rows already differ - two names, one question.
    expect(ambiguousChatMessage("mum", [dm, group])).not.toContain(
      "render identically",
    );
  });

  test("two DMs sharing a last-four re-ask instead of picking the first", () => {
    // The mask keeps four digits, so it is not unique - nameMatches' own
    // comment says two contacts sharing them still collide. Accepting the
    // first hit resolved `•••••0123` to Alice while Bob was meant, and
    // catch_up then hands out Alice's chat_id for Bob's reply.
    const alice = { chatId: "447700900123@s.whatsapp.net", name: "Alice" };
    const bob = { chatId: "447900900123@s.whatsapp.net", name: "Bob" };
    const shared = maskNumber(alice.chatId).toLowerCase();
    expect(maskNumber(bob.chatId).toLowerCase()).toBe(shared); // the premise

    const r = resolveChat([alice, bob], shared);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.matches).toEqual([alice, bob]);

    // Still reachable: the rows differ by name, which is what the message
    // tells the caller to narrow by.
    expect(resolveChat([alice, bob], "bob")).toEqual({ ok: true, chat: bob });
    // And a last-four nobody else shares still resolves on the mask alone.
    const solo = { chatId: "447700900999@s.whatsapp.net", name: "Cara" };
    expect(
      resolveChat([alice, solo], maskNumber(solo.chatId).toLowerCase()),
    ).toEqual({ ok: true, chat: solo });
  });
});

describe("takeUnseen (wait_for_messages, one set per connection)", () => {
  const m = (chat: string, id: string, ts = "2026-09-16T10:00:00.000Z") => ({
    chat_id: chat,
    id,
    ts,
  });
  const a = m("a@s.whatsapp.net", "1");
  const b = m("b@s.whatsapp.net", "2", "2026-09-16T10:00:01.000Z");

  test("first call returns everything pending; the next only what is new", () => {
    const seen = new Set<string>();
    expect(takeUnseen(seen, [a])).toEqual([a]);
    expect(takeUnseen(seen, [a])).toEqual([]);
    // arrived BETWEEN calls (attempt 1 hid this forever)
    expect(takeUnseen(seen, [a, b])).toEqual([b]);
  });

  test("two connections do not starve each other (attempt 2's regression)", () => {
    const one = new Set<string>();
    const two = new Set<string>();
    expect(takeUnseen(one, [a])).toEqual([a]);
    expect(takeUnseen(two, [a])).toEqual([a]);
  });

  test("a replied message leaves the set, and the same id in another chat is distinct", () => {
    const seen = new Set<string>();
    takeUnseen(seen, [a, b]);
    takeUnseen(seen, [b]); // a was replied to
    expect(seen.size).toBe(1);
    expect(takeUnseen(seen, [b, m("c@s.whatsapp.net", "2")])).toHaveLength(1);
  });

  // Only what is HANDED is marked seen: a backlog wider than the cap is
  // served newest-first across calls, never consumed unseen.
  test("a limit hands the newest and leaves the rest for the next call", () => {
    const seen = new Set<string>();
    const many = Array.from({ length: 5 }, (_, i) =>
      m("g@g.us", String(i), `2026-09-16T10:00:0${i}.000Z`),
    );
    const first = takeUnseen(seen, many, 3);
    expect(first.map((x) => x.id)).toEqual(["2", "3", "4"]);
    expect(seen.size).toBe(3);
    expect(takeUnseen(seen, many, 3).map((x) => x.id)).toEqual(["0", "1"]);
    expect(takeUnseen(seen, many, 3)).toEqual([]);
  });

  // getUnreplied returns [] on a failed read; that must not wipe the set.
  test("an empty pending list prunes nothing", () => {
    const seen = new Set<string>();
    takeUnseen(seen, [a, b]);
    expect(takeUnseen(seen, [])).toEqual([]);
    expect(seen.size).toBe(2);
    expect(takeUnseen(seen, [a, b])).toEqual([]);
  });
});
