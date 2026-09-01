import { describe, expect, test } from "bun:test";
import {
  cronMatches,
  parseCronField,
  parseCronSection,
  to24Hour,
  validateCronExpr,
} from "./cron";

describe("parseCronField", () => {
  test("wildcard and literals", () => {
    expect(parseCronField("*", 37, 59)).toBe(true);
    expect(parseCronField("37", 37, 59)).toBe(true);
    expect(parseCronField("38", 37, 59)).toBe(false);
  });

  test("lists and ranges", () => {
    expect(parseCronField("5,37,50", 37, 59)).toBe(true);
    expect(parseCronField("30-40", 37, 59)).toBe(true);
    expect(parseCronField("30-40", 41, 59)).toBe(false);
  });

  test("steps", () => {
    expect(parseCronField("*/5", 35, 59)).toBe(true);
    expect(parseCronField("*/5", 36, 59)).toBe(false);
  });

  // max is what makes an impossible field impossible instead of accidental.
  test("a step wider than the field never matches", () => {
    expect(parseCronField("*/90", 0, 59)).toBe(false);
    expect(parseCronField("*/90", 90, 59)).toBe(false);
  });

  test("a zero step is not a schedule", () => {
    expect(parseCronField("*/0", 0, 59)).toBe(false);
  });

  test("an out-of-range literal never matches", () => {
    expect(parseCronField("70", 70, 59)).toBe(false);
    expect(parseCronField("25", 25, 23)).toBe(false);
  });
});

describe("cronMatches", () => {
  const at = (h: number, m: number) => new Date(2026, 8, 1, h, m, 0);

  test("daily expression fires on its minute only", () => {
    expect(cronMatches("30 9 * * *", at(9, 30))).toBe(true);
    expect(cronMatches("30 9 * * *", at(9, 31))).toBe(false);
    expect(cronMatches("30 9 * * *", at(10, 30))).toBe(false);
  });

  test("a malformed expression is false, not a throw", () => {
    expect(cronMatches("30 9", at(9, 30))).toBe(false);
    expect(cronMatches("", at(9, 30))).toBe(false);
  });
});

describe("validateCronExpr", () => {
  test("accepts schedules that can fire", () => {
    expect(validateCronExpr("0 9 * * *")).toBeNull();
    expect(validateCronExpr("*/15 * * * *")).toBeNull();
    expect(validateCronExpr("0,30 9-17 * * 1-5")).toBeNull();
  });

  test("rejects out-of-range values", () => {
    expect(validateCronExpr("0 25 * * *")).toMatch(/hour 25/);
    expect(validateCronExpr("70 9 * * *")).toMatch(/minute 70/);
    expect(validateCronExpr("0 9 0 * *")).toMatch(/day-of-month 0/);
  });

  test("rejects steps that never repeat, and zero steps", () => {
    expect(validateCronExpr("*/90 * * * *")).toMatch(/never repeats/);
    expect(validateCronExpr("*/0 * * * *")).toMatch(/at least 1/);
  });

  test("rejects the wrong number of fields", () => {
    expect(validateCronExpr("0 9 * *")).toMatch(/5 cron fields/);
  });
});

describe("to24Hour", () => {
  test("am/pm conversion", () => {
    expect(to24Hour(1, "pm")).toBe(13);
    expect(to24Hour(12, "pm")).toBe(12);
    expect(to24Hour(12, "am")).toBe(0);
    expect(to24Hour(6, undefined)).toBe(6);
  });
});

describe("parseCronSection", () => {
  const wrap = (body: string, eol = "\n") =>
    ["# Group", "", "## Cron Jobs", body, "", "## Notes", "nothing"].join(eol);

  test("reads a daily job", () => {
    const { jobs, errors } = parseCronSection(
      wrap("- **Standup**: daily 9:15 post the standup prompt"),
    );
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].cron).toBe("15 9 * * *");
    expect(jobs[0].prompt).toBe("daily 9:15 post the standup prompt");
  });

  test("reads an interval job", () => {
    const { jobs } = parseCronSection(wrap("- **Poll**: every 15 min check"));
    expect(jobs[0].cron).toBe("*/15 * * * *");
  });

  test("two times on one line become two jobs with their own am/pm", () => {
    const { jobs } = parseCronSection(wrap("- **Digest**: daily 1pm & 6am go"));
    expect(jobs.map((j) => j.cron)).toEqual(["0 13 * * *", "0 6 * * *"]);
  });

  // The whole point of FIX 2: these used to load as jobs that never fired.
  test("unschedulable lines are rejected loudly, not accepted", () => {
    for (const line of [
      "- **Bad**: daily 25:00 do a thing",
      "- **Bad**: daily 3:70 do a thing",
      "- **Bad**: every 90 min do a thing",
      "- **Bad**: every 0 min do a thing",
    ]) {
      const { jobs, errors } = parseCronSection(wrap(line));
      expect(jobs).toEqual([]);
      expect(errors).toHaveLength(1);
    }
  });

  test("one bad line does not take the good ones down with it", () => {
    const { jobs, errors } = parseCronSection(
      wrap(
        [
          "- **Good**: daily 9:00 morning",
          "- **Bad**: every 90 min broken",
          "- **AlsoGood**: every 30 min poll",
        ].join("\n"),
      ),
    );
    expect(jobs.map((j) => j.cron)).toEqual(["0 9 * * *", "*/30 * * * *"]);
    expect(errors).toHaveLength(1);
  });

  test("CRLF config.md still yields crons", () => {
    const { jobs } = parseCronSection(
      wrap("- **Standup**: daily 9:15 post the standup prompt", "\r\n"),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].cron).toBe("15 9 * * *");
    expect(jobs[0].prompt).toBe("daily 9:15 post the standup prompt");
  });

  test("no section at all is not an error", () => {
    expect(parseCronSection("# Group\n\njust a personality\n")).toEqual({
      jobs: [],
      errors: [],
    });
  });
});
