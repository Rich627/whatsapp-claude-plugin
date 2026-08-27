import { describe, expect, test } from "bun:test";
import { formatSentLine, parseSentLog } from "./sent-log";

// Mirrors sent.jsonl's entry shape - `id` first. If formatSentLine's literal
// is ever reordered, the "id first, valid JSON" case here is what fails.
function line(id: string, ts: number): string {
  return JSON.stringify({ id, ts });
}

describe("formatSentLine", () => {
  test("produces id first, valid JSON", () => {
    const out = formatSentLine("3EB0ABC123", 1234);
    expect(out).toBe('{"id":"3EB0ABC123","ts":1234}');
    expect(JSON.parse(out)).toEqual({ id: "3EB0ABC123", ts: 1234 });
  });

  test("round-trips through parseSentLog", () => {
    const out = formatSentLine("3EB0ABC123", 1234);
    const { ids, lines } = parseSentLog(out + "\n", 1233);
    expect(ids.has("3EB0ABC123")).toBe(true);
    expect(lines).toEqual([out]);
  });

  test("an id containing quotes and backslashes round-trips intact", () => {
    const weird = 'we"ird\\id';
    const out = formatSentLine(weird, 1234);
    const { ids, lines } = parseSentLog(out + "\n", 1233);
    expect(ids.has(weird)).toBe(true);
    expect(lines).toEqual([out]);
  });
});

describe("parseSentLog", () => {
  test("keeps a fresh entry and drops an old one", () => {
    const now = Date.now();
    const fresh = line("FRESH", now);
    const old = line("OLD", now - 48 * 60 * 60 * 1000);
    const { ids, lines } = parseSentLog([fresh, old].join("\n"), now - 1000);
    expect(ids.has("FRESH")).toBe(true);
    expect(ids.has("OLD")).toBe(false);
    expect(lines).toEqual([fresh]);
  });

  test("exactly at the cutoff is dropped, one millisecond over is kept", () => {
    const atCutoff = line("AT", 1000);
    const overCutoff = line("OVER", 1001);
    const { ids, lines } = parseSentLog(
      [atCutoff, overCutoff].join("\n"),
      1000,
    );
    expect(ids.has("AT")).toBe(false);
    expect(ids.has("OVER")).toBe(true);
    expect(lines).toEqual([overCutoff]);
  });

  test("a malformed line is ignored, valid lines around it still parse", () => {
    const a = line("A", 2000);
    const b = line("B", 2000);
    const { ids, lines } = parseSentLog([a, "not json", b].join("\n"), 1000);
    expect(ids).toEqual(new Set(["A", "B"]));
    expect(lines).toEqual([a, b]);
  });

  test("drops entries with an invalid shape", () => {
    const cutoff = 1000;
    const cases = [
      JSON.stringify({ ts: 2000 }), // missing id
      JSON.stringify({ id: "", ts: 2000 }), // empty id
      JSON.stringify({ id: 5, ts: 2000 }), // non-string id
      JSON.stringify({ id: "X" }), // missing ts
      JSON.stringify({ id: "X", ts: "123" }), // non-number ts
      JSON.stringify({ id: "X", ts: NaN }), // NaN ts (serialises to null)
      "null", // JSON null
      "[]", // JSON array
    ];
    for (const bad of cases) {
      const { ids, lines } = parseSentLog(bad, cutoff);
      expect(ids.size).toBe(0);
      expect(lines).toEqual([]);
    }
  });

  test("blank lines and a trailing newline produce no entries", () => {
    const a = line("A", 2000);
    const { ids, lines } = parseSentLog(`\n${a}\n\n`, 1000);
    expect(ids).toEqual(new Set(["A"]));
    expect(lines).toEqual([a]);
  });

  test("empty text returns an empty set and array", () => {
    const { ids, lines } = parseSentLog("", 1000);
    expect(ids.size).toBe(0);
    expect(lines).toEqual([]);
  });

  test("lines preserves file order and is byte-identical to the input", () => {
    const a = line("A", 3000);
    const b = line("B", 3000);
    const c = line("C", 3000);
    const { lines } = parseSentLog([a, b, c].join("\n"), 1000);
    expect(lines).toEqual([a, b, c]);
    expect(lines[0]).toBe(a);
    expect(lines[1]).toBe(b);
    expect(lines[2]).toBe(c);
  });

  test("a duplicate id appearing twice yields one entry in ids, both in lines", () => {
    const first = line("DUPE", 3000);
    const second = line("DUPE", 3001);
    const { ids, lines } = parseSentLog([first, second].join("\n"), 1000);
    expect(ids).toEqual(new Set(["DUPE"]));
    expect(lines).toEqual([first, second]);
  });

  test("a ts in the future is kept - no upper bound check", () => {
    const now = Date.now();
    const future = line("FUTURE", now + 24 * 60 * 60 * 1000);
    const { ids, lines } = parseSentLog(future, now);
    expect(ids.has("FUTURE")).toBe(true);
    expect(lines).toEqual([future]);
  });
});
