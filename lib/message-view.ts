// Pulled out of server.ts so the render rule is testable without its
// connect-on-import side effects (same reason mask.ts/mentions.ts were
// split out, see scripts/ranking.ts's own header). The window slice and the
// owner-text expiry are pure decisions about how a stored log line renders
// at a given moment - no I/O, nothing here mutates or re-derives the stored
// entry. Expiry is a RENDER-TIME rule only: the log line keeps the owner's
// original text forever, so no other code path may hide or reveal it again.
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

/** The ONE drop the log keeps for context: a configured group's message
 *  that simply did not mention the agent. Every other drop stores nothing. */
export function keepDroppedForContext(
  isGroup: boolean,
  reason: string | undefined,
): boolean {
  return isGroup && reason === "no-mention";
}

/** Suffix on the sender of an entry that was never addressed to the agent. */
export const NOT_ADDRESSED = " (not addressed to Claude)";

/** Owner-authored text is visible this long, then collapses. */
export const OWNER_TEXT_TTL_MS = 60 * 60 * 1000;

/** What an owner entry's text becomes once it expires. */
export const EXPIRED_TEXT = "replied (text expired)";

/** How many messages per chat catch_up replays. */
export const RECENT_LIMIT = 5;

/** Last `limit` entries, oldest-first. Non-mutating. */
export function recentWindow<T extends { ts: string }>(
  entries: T[],
  limit: number = RECENT_LIMIT,
): T[] {
  return [...entries].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-limit);
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
