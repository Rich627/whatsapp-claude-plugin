// Pure render/retention rules for stored log lines (no I/O); split out of
// server.ts so they are testable without its connect-on-import side effects.
export type ViewableEntry = {
  user: string;
  text: string;
  ts: string;
  direction?: "in" | "out";
  by?: "owner";
  /** false = kept for context only, was never addressed to the agent. */
  routed?: false;
};

/** An inbound line still waiting for an answer. A `routed: false` line was
 *  never addressed to the agent, so it can never be waiting. The ONLY place
 *  this rule exists - getUnreplied and the catch_up counter both call it. */
export function awaitingReply(entry: {
  replied?: boolean;
  direction?: "in" | "out";
  routed?: false;
}): boolean {
  return (
    (entry.direction ?? "in") === "in" &&
    !entry.replied &&
    entry.routed !== false
  );
}

/** How long a log line lives. A ROUTED inbound - something addressed to
 *  the agent, possibly still unanswered - is a to-do and goes stale in a day.
 *  Everything that is context rather than a to-do (the owner's own lines,
 *  the agent's replies, and a group's unaddressed chatter) is what "what
 *  was this chat about" is read from, and a day is far too short for that
 *  (owner, 2026-08-27). The owner's-text expiry (OWNER_TEXT_TTL_MS) is a
 *  render rule and is untouched by this. */
export const INBOUND_TTL_MS = 24 * 60 * 60 * 1000;
export const CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function keepLogLine(
  entry: {
    ts: string;
    direction?: "in" | "out";
    by?: "owner";
    routed?: false;
    replied?: boolean;
  },
  now: number = Date.now(),
): boolean {
  const t = Date.parse(entry.ts);
  if (!Number.isFinite(t)) return false;
  // An answered inbound is no longer a to-do - it is the other half of a
  // conversation whose reply we keep a week, so it stays a week too.
  const openInbound = entry.by !== "owner" && awaitingReply(entry);
  return now - t < (openInbound ? INBOUND_TTL_MS : CONTEXT_TTL_MS);
}

/** Suffix on the sender of an entry that was never addressed to the agent. */
export const NOT_ADDRESSED = " (not addressed to Claude)";

/** Owner-authored text is visible this long, then collapses. */
export const OWNER_TEXT_TTL_MS = 60 * 60 * 1000;

/** What an owner entry's text becomes once it expires. */
export const EXPIRED_TEXT = "replied (text expired)";

/** How many messages per chat catch_up replays. */
export const RECENT_LIMIT = 5;

const byTs = <T extends { ts: string }>(a: T, b: T) => a.ts.localeCompare(b.ts);

/** Last `limit` entries, oldest-first. Non-mutating. */
export function recentWindow<T extends { ts: string }>(
  entries: T[],
  limit: number = RECENT_LIMIT,
): T[] {
  return [...entries].sort(byTs).slice(-limit);
}

/** The catch_up window per chat: the last `limit` lines from OTHERS and the
 *  last `limit` of the owner's/agent's own, merged oldest-first, so the
 *  owner's own texts cannot crowd out what the room said (owner, 2026-08-27). */
export function recentBothSides<
  T extends { ts: string; direction?: "in" | "out" },
>(entries: T[], limit: number = RECENT_LIMIT): T[] {
  const sorted = [...entries].sort(byTs);
  const isIn = (e: T) => (e.direction ?? "in") === "in";
  return [
    ...sorted.filter(isIn).slice(-limit),
    ...sorted.filter((e) => !isIn(e)).slice(-limit),
  ].sort(byTs);
}

/** How one entry renders at time `now`. The ONLY place the expiry rule and
 *  the owner label exist. */
export function renderLogEntry(
  entry: ViewableEntry,
  ownerName: string,
  now: number = Date.now(),
): { who: string; text: string } {
  const who =
    entry.by === "owner"
      ? ownerName
      : entry.routed === false
        ? `${entry.user}${NOT_ADDRESSED}`
        : entry.user;
  if (entry.by !== "owner") return { who, text: entry.text };

  const age = now - Date.parse(entry.ts);
  const expired = !Number.isFinite(age) || age > OWNER_TEXT_TTL_MS;
  return { who, text: expired ? EXPIRED_TEXT : entry.text };
}
