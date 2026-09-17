// Reading a group's "## Cron Jobs" section and matching the expressions it
// yields against the clock. Pure and file-system free so it is unit testable
// without server.ts's connect-on-import side effects — same reason
// lib/mentions.ts exists. server.ts keeps the parts that need the world:
// which groups to read, where their config.md lives, and how to log.

export type ParsedCron = { cron: string; prompt: string };

/** Jobs that parsed AND validated, plus one human-readable line per job that
 *  did not. A rejected line never aborts the rest of the file: one bad
 *  schedule must not silently take the group's other crons down with it. */
export type CronParseResult = { jobs: ParsedCron[]; errors: string[] };

type FieldSpec = { name: string; min: number; max: number };

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  // 7 is Sunday too, as in every crontab; cronMatches maps it.
  { name: "day-of-week", min: 0, max: 7 },
];

// `max` is not decoration: an out-of-range literal, a step wider than the
// field, and a step of zero (`now % 0` is NaN) all produce an expression that
// can never match. They used to be accepted in silence, so a user who wrote
// "every 90 min" got a job that simply never ran and no way to find out why.
// Bounds are re-checked here, not only at load time, so a hand-edited or
// future-generated expression cannot slip past either.
export function parseCronField(
  field: string,
  now: number,
  max: number,
  min = 0,
): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      // THE BASE IS HONOURED, not discarded. `a/b` means "every b starting at
      // a", and this read only the step - so "9/2" fired at 00,02,04… instead
      // of 09,11,13…. That was unreachable while the only schedules came from
      // prose (which never produces a base), and became reachable the moment
      // the explicit (cron: "expr") form was accepted: a standard expression
      // validated clean, was reported as one healthy job, and then ran at the
      // wrong times with nothing to say so.
      // `*` starts at the FIELD's minimum, not 0: day-of-month and month
      // start at 1, so `*/2` there means 1,3,5… A range base (`9-17/2`)
      // bounds both ends, the way crontab reads it.
      const [rawBase, rawStep] = part.split("/");
      const step = parseInt(rawStep);
      if (!Number.isFinite(step) || step < 1 || step > max) continue;
      const [lo, hi] =
        rawBase === "*"
          ? [min, max]
          : rawBase.includes("-")
            ? rawBase.split("-").map(Number)
            : [parseInt(rawBase), max];
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
      if (lo < min || hi > max || lo > hi) continue;
      if (now >= lo && now <= hi && (now - lo) % step === 0) return true;
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi > max) continue;
      if (now >= lo && now <= hi) return true;
    } else {
      const v = parseInt(part);
      if (!Number.isFinite(v) || v > max) continue;
      if (now === v) return true;
    }
  }
  return false;
}

export function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  // Guarded rather than destructured blind: a short expression used to throw
  // a TypeError out of the interval callback, taking the whole tick with it.
  if (parts.length !== FIELDS.length) return false;
  const [min, hr, dom, mon, dow] = parts;
  const day = date.getDay();
  return (
    parseCronField(min, date.getMinutes(), 59) &&
    parseCronField(hr, date.getHours(), 23) &&
    parseCronField(dom, date.getDate(), 31, 1) &&
    parseCronField(mon, date.getMonth() + 1, 12, 1) &&
    // Sunday is 0 AND 7, as in crontab: a Sunday matches either spelling.
    (parseCronField(dow, day, 7) || (day === 0 && parseCronField(dow, 7, 7)))
  );
}

function validateField(part: string, spec: FieldSpec): string | null {
  const { name, min, max } = spec;
  if (part === "*") return null;
  if (part.includes("/")) {
    const [base, rawStep] = part.split("/");
    // The base is a value or a range and is RANGE-CHECKED like one. It was
    // accepted as "a number" and never bounded, so "99/2" in an hour field
    // passed validation and then behaved as "*/2" because parseCronField
    // discarded the base entirely - valid-looking, reported healthy, firing
    // at times nobody asked for.
    if (base !== "*") {
      const err = validateField(base, spec);
      if (err) return err;
    }
    if (!/^\d+$/.test(rawStep))
      return `${name} step "${rawStep}" is not a number`;
    const step = Number(rawStep);
    if (step < 1) return `${name} step must be at least 1, got ${step}`;
    if (step > max)
      return `${name} step ${step} never repeats inside ${min}-${max}`;
    return null;
  }
  if (part.includes("-")) {
    const [lo, hi] = part.split("-");
    if (!/^\d+$/.test(lo) || !/^\d+$/.test(hi))
      return `${name} range "${part}" is not numeric`;
    if (Number(lo) > Number(hi) || Number(lo) < min || Number(hi) > max)
      return `${name} range "${part}" is outside ${min}-${max}`;
    return null;
  }
  if (!/^\d+$/.test(part)) return `${name} "${part}" is not a number`;
  const v = Number(part);
  if (v < min || v > max) return `${name} ${v} is outside ${min}-${max}`;
  return null;
}

/** null when the expression can match; otherwise why it never will. */
export function validateCronExpr(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== FIELDS.length)
    return `expected ${FIELDS.length} cron fields, got ${parts.length}`;
  for (let i = 0; i < FIELDS.length; i++) {
    for (const part of parts[i].split(",")) {
      const err = validateField(part, FIELDS[i]);
      if (err) return err;
    }
  }
  return null;
}

export function to24Hour(hr: number, ampm: string | undefined): number {
  const p = (ampm ?? "").toLowerCase();
  if (p === "pm" && hr < 12) return hr + 12;
  if (p === "am" && hr === 12) return 0;
  return hr;
}

// \r?\n throughout, not \n: a config.md saved by a Windows editor (or any
// tool that writes CRLF) matched nothing here, so the user's crons vanished
// with no error at all. The .env loader near the top of server.ts already
// tolerates CRLF for exactly this reason.
export const CRON_SECTION_RE =
  /## Cron Jobs\r?\n([\s\S]*?)(?=\r?\n## |\r?\n# |$)/;

export function parseCronSection(content: string): CronParseResult {
  const jobs: ParsedCron[] = [];
  const errors: string[] = [];
  const section = content.match(CRON_SECTION_RE);
  if (!section) return { jobs, errors };

  // Lines like: - **Name**: description (cron: "expr")
  // Or:         - **Name**: cron expr — description
  const lines = section[1].split(/\r?\n/).filter((l) => l.startsWith("- "));
  for (const line of lines) {
    // The EXPLICIT form this function's own header has always documented -
    // `(cron: "expr")` - and which no branch actually parsed. It was silently
    // dropped, and once the silent drop became a reported error, following the
    // documented format earned the user a doctor WARN telling them to fix a
    // line written the way the file advertises. It is also the most precise of
    // the three forms, and validateCronExpr below already exists to check it,
    // so parsing it is better than deleting the promise.
    const explicitMatch = line.match(/\(\s*cron:\s*["']([^"']+)["']\s*\)/i);
    const cronMatch = line.match(/(?:每|every)\s*(\d+)\s*(?:分鐘|分|min)/i);
    const dailyMatch = line.match(
      /(?:每天|daily)\s*(\d{1,2}):?(\d{2})?\s*(am|pm)?/i,
    );
    const twiceMatch = line.match(
      /(?:每天|daily)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:&|和|,)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
    );

    // The `(cron: "...")` clause is a schedule, not part of what to run, so it
    // comes out of the prompt - otherwise every explicit job would ask the
    // agent to do its own crontab entry.
    const desc = line
      .replace(/^-\s*\*\*[^*]+\*\*:?\s*/, "")
      .replace(/\(\s*cron:\s*["'][^"']+["']\s*\)/i, "")
      .trim();
    const candidates: ParsedCron[] = [];

    // FIRST, because it is the only form the user stated exactly. The others
    // infer a schedule from prose; if someone wrote the expression out, that
    // is what they meant, and validateCronExpr below still has to agree.
    if (explicitMatch) {
      candidates.push({ cron: explicitMatch[1].trim(), prompt: desc });
    } else if (twiceMatch) {
      // Two times per day — two entries. Each time's am/pm marker is captured
      // next to that time, not inferred from the whole line (a line like
      // "daily 1pm & 6am" previously mis-parsed both times off a single
      // line-wide "includes pm" check).
      const h1 = to24Hour(parseInt(twiceMatch[1]), twiceMatch[3]);
      const m1 = parseInt(twiceMatch[2] || "0");
      const h2 = to24Hour(parseInt(twiceMatch[4]), twiceMatch[6]);
      const m2 = parseInt(twiceMatch[5] || "0");
      candidates.push({ cron: `${m1} ${h1} * * *`, prompt: desc });
      candidates.push({ cron: `${m2} ${h2} * * *`, prompt: desc });
    } else if (dailyMatch) {
      const hr = to24Hour(parseInt(dailyMatch[1]), dailyMatch[3]);
      const min = parseInt(dailyMatch[2] || "0");
      candidates.push({ cron: `${min} ${hr} * * *`, prompt: desc });
    } else if (cronMatch) {
      candidates.push({ cron: `*/${cronMatch[1]} * * * *`, prompt: desc });
    }

    // A BULLET THAT PRODUCES NOTHING IS REPORTED, NOT DROPPED. Silently
    // ignoring it is the exact failure the errors channel and the 0.23.0 note
    // were added to end: the user wrote a job, the file looks right, and
    // nothing ever runs. Two ways it happened, and they need different
    // wording because the user has to fix different halves of the line.
    if (candidates.length === 0) {
      errors.push(
        `${line.trim()} → no schedule recognised; use "every N min", "daily 9am", "daily 09:00", two times joined by "&", or (cron: "m h dom mon dow")`,
      );
      continue;
    }
    // The description IS the prompt, so a bullet without one schedules an
    // empty task. Checked here rather than per-branch: the two-times branch
    // never checked, and happily built a job with an empty prompt.
    if (!desc) {
      errors.push(
        `${line.trim()} → a schedule but nothing to run; the text after "**Name**:" is the prompt`,
      );
      continue;
    }

    for (const candidate of candidates) {
      const err = validateCronExpr(candidate.cron);
      if (err) errors.push(`${line.trim()} → "${candidate.cron}": ${err}`);
      else jobs.push(candidate);
    }
  }
  return { jobs, errors };
}
