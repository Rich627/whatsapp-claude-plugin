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
  { name: "day-of-week", min: 0, max: 6 },
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
): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const step = parseInt(part.split("/")[1]);
      if (!Number.isFinite(step) || step < 1 || step > max) continue;
      if (now % step === 0) return true;
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
  return (
    parseCronField(min, date.getMinutes(), 59) &&
    parseCronField(hr, date.getHours(), 23) &&
    parseCronField(dom, date.getDate(), 31) &&
    parseCronField(mon, date.getMonth() + 1, 12) &&
    parseCronField(dow, date.getDay(), 6)
  );
}

function validateField(part: string, spec: FieldSpec): string | null {
  const { name, min, max } = spec;
  if (part === "*") return null;
  if (part.includes("/")) {
    const [base, rawStep] = part.split("/");
    if (base !== "*" && !/^\d+$/.test(base))
      return `${name} step base "${base}" is not a number or "*"`;
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
const CRON_SECTION_RE = /## Cron Jobs\r?\n([\s\S]*?)(?=\r?\n## |\r?\n# |$)/;

export function parseCronSection(content: string): CronParseResult {
  const jobs: ParsedCron[] = [];
  const errors: string[] = [];
  const section = content.match(CRON_SECTION_RE);
  if (!section) return { jobs, errors };

  // Lines like: - **Name**: description (cron: "expr")
  // Or:         - **Name**: cron expr — description
  const lines = section[1].split(/\r?\n/).filter((l) => l.startsWith("- "));
  for (const line of lines) {
    const cronMatch = line.match(/(?:每|every)\s*(\d+)\s*(?:分鐘|分|min)/i);
    const dailyMatch = line.match(
      /(?:每天|daily)\s*(\d{1,2}):?(\d{2})?\s*(am|pm)?/i,
    );
    const twiceMatch = line.match(
      /(?:每天|daily)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:&|和|,)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
    );

    const desc = line.replace(/^-\s*\*\*[^*]+\*\*:?\s*/, "").trim();
    const candidates: ParsedCron[] = [];

    if (twiceMatch) {
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
      if (desc) candidates.push({ cron: `${min} ${hr} * * *`, prompt: desc });
    } else if (cronMatch) {
      if (desc)
        candidates.push({ cron: `*/${cronMatch[1]} * * * *`, prompt: desc });
    }

    for (const candidate of candidates) {
      const err = validateCronExpr(candidate.cron);
      if (err) errors.push(`${line.trim()} → "${candidate.cron}": ${err}`);
      else jobs.push(candidate);
    }
  }
  return { jobs, errors };
}
