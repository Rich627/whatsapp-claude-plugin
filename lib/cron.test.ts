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

  // The base was parsed, validated, and then thrown away: "9/2" ran as "*/2".
  // Unreachable while every schedule came from prose; reachable the moment the
  // explicit (cron: "expr") form was accepted.
  test("a step BASE is honoured, not discarded", () => {
    expect(parseCronField("9/2", 9, 23)).toBe(true);
    expect(parseCronField("9/2", 11, 23)).toBe(true);
    expect(parseCronField("9/2", 0, 23)).toBe(false);
    expect(parseCronField("9/2", 10, 23)).toBe(false);
    // "*" still means "from zero", so the common form is unchanged.
    expect(parseCronField("*/2", 0, 23)).toBe(true);
    expect(parseCronField("*/2", 2, 23)).toBe(true);
  });

  // `*` starts at the field's MINIMUM: day-of-month and month start at 1, so
  // "*/2" there is 1,3,5… - not the even days a zero base produced.
  test("a wildcard step starts at the field minimum", () => {
    expect(parseCronField("*/2", 1, 31, 1)).toBe(true);
    expect(parseCronField("*/2", 2, 31, 1)).toBe(false);
    expect(parseCronField("*/3", 1, 12, 1)).toBe(true); // Jan, Apr, Jul, Oct
    expect(parseCronField("*/3", 3, 12, 1)).toBe(false);
  });

  test("a range base bounds both ends of a step", () => {
    expect(parseCronField("9-17/2", 9, 23)).toBe(true);
    expect(parseCronField("9-17/2", 17, 23)).toBe(true);
    expect(parseCronField("9-17/2", 19, 23)).toBe(false);
    expect(parseCronField("9-17/2", 10, 23)).toBe(false);
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

  // The base was checked for being numeric and never range-checked, so this
  // validated clean and then behaved as "*/2" because the base was discarded.
  test("rejects a step base outside the field range", () => {
    expect(validateCronExpr("0 99/2 * * *")).toMatch(/hour 99 is outside/);
    expect(validateCronExpr("0 9/2 * * *")).toBeNull();
  });

  // The standard crontab spellings the banner invites: a range with a step,
  // and Sunday as 7.
  test("accepts range-with-step and day-of-week 7", () => {
    expect(validateCronExpr("0 9-17/2 * * 1-5")).toBeNull();
    expect(validateCronExpr("0 9 * * 7")).toBeNull();
    expect(validateCronExpr("0 9 * * 8")).toMatch(/day-of-week 8/);
    expect(validateCronExpr("0 9-25/2 * * *")).toMatch(/hour range/);
  });
});

describe("cronMatches with crontab spellings", () => {
  // 2026-09-06 is a Sunday; 2026-09-01 is a Tuesday.
  const sunday = new Date(2026, 8, 6, 9, 0);
  test("Sunday matches both 0 and 7", () => {
    expect(cronMatches("0 9 * * 0", sunday)).toBe(true);
    expect(cronMatches("0 9 * * 7", sunday)).toBe(true);
    expect(cronMatches("0 9 * * 5-7", sunday)).toBe(true);
    expect(cronMatches("0 9 * * 1-6", sunday)).toBe(false);
  });
  test("a day-of-month step counts from the 1st", () => {
    expect(cronMatches("0 9 */2 * *", new Date(2026, 8, 1, 9, 0))).toBe(true);
    expect(cronMatches("0 9 */2 * *", new Date(2026, 8, 2, 9, 0))).toBe(false);
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

  // The explicit form the header has always documented, and which no branch
  // parsed until now - it was silently dropped, then loudly rejected.
  test('the documented (cron: "expr") form is parsed, and the clause is not part of the prompt', () => {
    const { jobs, errors } = parseCronSection(
      wrap('- **Digest**: post the daily digest (cron: "30 9 * * 1-5")'),
    );
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].cron).toBe("30 9 * * 1-5");
    expect(jobs[0].prompt).toBe("post the daily digest");
  });

  test("an explicit cron expression is still validated", () => {
    const { jobs, errors } = parseCronSection(
      wrap('- **Bad**: do a thing (cron: "99 9 * * *")'),
    );
    expect(jobs).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  test("an explicit expression wins over prose that looks like a schedule", () => {
    const { jobs } = parseCronSection(
      wrap('- **Both**: remind me daily 9am (cron: "0 17 * * *")'),
    );
    expect(jobs.map((j) => j.cron)).toEqual(["0 17 * * *"]);
  });

  // A bullet that matched NO schedule used to produce no job and no error -
  // the exact silent drop the errors channel exists to end. The user writes a
  // job, the file looks right, and nothing ever runs.
  test("a bullet with no recognisable schedule is reported, not dropped", () => {
    for (const line of [
      "- **Digest**: daily at 9am", // "at" breaks the daily pattern
      "- **Standup**: every morning",
      "- **Thing**: just some prose",
    ]) {
      const { jobs, errors } = parseCronSection(wrap(line));
      expect(jobs).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("no schedule recognised");
    }
  });

  // The description IS the prompt, and it is everything after "**Name**:" -
  // so "- **Digest**: daily 9:00" has the prompt "daily 9:00" and is a valid
  // job. The prompt is only empty when the schedule sits INSIDE the name and
  // nothing follows the colon. Checked once for all three branches now:
  // `daily`/`every` used to drop such a line silently while the two-times
  // branch built a job with an empty prompt.
  test("a schedule with nothing to run is reported, in every branch", () => {
    for (const line of [
      "- **daily 9:00**:",
      "- **every 30 min**:",
      "- **daily 9:00 & 18:00**:",
    ]) {
      const { jobs, errors } = parseCronSection(wrap(line));
      expect(jobs).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("nothing to run");
    }
  });
});
