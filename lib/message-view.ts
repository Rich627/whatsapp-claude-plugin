// Pure render/retention rules for stored log lines (no I/O); split out of
// server.ts so they are testable without its connect-on-import side effects.
import { createHash } from "node:crypto";

import { groupAnchor, looksLikeNumber, maskNumber } from "../scripts/mask";

export type ViewableEntry = {
  user: string;
  text: string;
  ts: string;
  direction?: "in" | "out";
  by?: "owner";
  /** false = kept for context only, was never addressed to the agent. */
  routed?: false;
  /** Media evidence, for the caption-less placeholder (see renderLogEntry).
   *  `image_path` implies an image and is set only when the eager download
   *  SUCCEEDED. `attachment_kind` may be present for an image too - on the
   *  no-mention context path, on a backlog line, and when that eager download
   *  failed - so both are consulted and mediaPlaceholder prefers image_path.
   *  (This said "an image NEVER sets attachment_kind" until three paths were
   *  added that do; an absolute in a comment outlives whatever made it true.) */
  image_path?: string;
  attachment_kind?: string;
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

/** Is this parsed JSON line usable at all? THE ONE COPY of that rule.
 *
 *  It lived inline at three parse boundaries (getRecentByChat, getUnreplied,
 *  pruneMessageLog) and had ALREADY DRIFTED - one copy was missing the
 *  `typeof entry !== "object"` arm. That drift is not hypothetical damage: the
 *  guard was absent from getUnreplied entirely, so a line with a missing `ts`
 *  was skipped by the other two views and still COUNTED by the unreplied
 *  suffix, reporting a message every other view denied existed.
 *
 *  Both fields matter and for different reasons. `chat_id` becomes a Map key
 *  and is hashed by agedOutKey, which throws on undefined and abandons a whole
 *  prune. `ts` feeds localeCompare when the window is sorted, and a non-string
 *  there throws mid-loop, leaving every chat AFTER it unwindowed - so catch_up
 *  dumps their entire retained log with no limit and no error. */
export function isUsableLogEntry(
  entry: unknown,
): entry is { chat_id: string; ts: string } {
  return (
    !!entry &&
    typeof entry === "object" &&
    typeof (entry as { chat_id?: unknown }).chat_id === "string" &&
    typeof (entry as { ts?: unknown }).ts === "string"
  );
}

/** How long a log line lives - ONE lifetime for every line, whatever it is.
 *  An unanswered inbound used to go stale in a day while context lived a
 *  week, so the very message you had not got to yet was the first thing to
 *  disappear, and a chat you opened on day two showed replies to a question
 *  that was no longer there. A single horizon means what is in the log is
 *  what catch_up shows, both sides alike (owner, 2026-09-02).
 *  The caller may pass its own `ttlMs` (server.ts reads
 *  WHATSAPP_MESSAGE_TTL_DAYS); this stays the default so the lib is pure. */
export const DAY_MS = 24 * 60 * 60 * 1000;
export const MESSAGE_TTL_MS = 7 * DAY_MS;

/** The bounds on WHATSAPP_MESSAGE_TTL_DAYS. Neither end is arbitrary, and the
 *  LOW end is the destructive one.
 *
 *  Ceiling: the same horizon is pruneInbox's cutoff, and pruneInbox is the only
 *  thing stopping inbox/ from filling the disk one photo at a time. An
 *  unbounded value silently disables that guard.
 *
 *  Floor: the unit is DAYS, but Number() happily accepts 0.01 - about fourteen
 *  minutes. On the next hourly tick that deletes every attachment in inbox/
 *  older than fourteen minutes, including a photo whose path catch_up just
 *  handed the agent and which it is about to read, and empties messages.jsonl
 *  with it. Rejecting <= 0 is not enough; a small positive is the same
 *  accident with a friendlier-looking value. */
export const MIN_TTL_DAYS = 1;
export const MAX_TTL_DAYS = 30;

/** Resolve WHATSAPP_MESSAGE_TTL_DAYS to a horizon plus the diagnostic its
 *  caller should log. `note` is "" when there is nothing to say - the variable
 *  was unset, or its value was accepted as given. Pure so the lib stays pure:
 *  server.ts reads the environment and passes the string in. */
export function resolveTtlMs(raw: string | undefined): {
  ms: number;
  note: string;
} {
  if (raw === undefined || raw.trim() === "")
    return { ms: MESSAGE_TTL_MS, note: "" };
  // The note goes to diag.log, a newline-delimited file read back as records,
  // so the value is quoted and truncated rather than interpolated raw - a
  // value containing a newline would otherwise forge extra log lines. Same
  // standard as maskJid/neutralizeChannelTag elsewhere; owner-controlled
  // input, but this file does not make exceptions for that.
  // Truncate FIRST, then quote. Quoting first and slicing after would cut the
  // closing quote off a long value and emit an unterminated string into the
  // very records file the quoting exists to keep parseable.
  const shown = JSON.stringify(raw.slice(0, 38));
  const days = Number(raw);
  // NaN and non-positive are the only genuinely unusable values. Infinity is
  // NOT one of them: `Number.isFinite` used to reject it, so "1e999" silently
  // kept the 7-day default while diag.log said "not a positive number" about a
  // positive number - and USAGE.md, changed in this same PR, promises the
  // value is clamped. Letting Infinity through reaches the Math.min below and
  // clamps to MAX_TTL_DAYS, which is what was promised. -Infinity still fails,
  // on the `days <= 0` test right here.
  if (Number.isNaN(days) || days <= 0)
    return {
      ms: MESSAGE_TTL_MS,
      note: `WHATSAPP_MESSAGE_TTL_DAYS=${shown} ignored (not a positive number); keeping ${MESSAGE_TTL_MS / DAY_MS} days`,
    };
  const clamped = Math.min(Math.max(days, MIN_TTL_DAYS), MAX_TTL_DAYS);
  if (clamped !== days)
    return {
      ms: clamped * DAY_MS,
      note: `WHATSAPP_MESSAGE_TTL_DAYS=${shown} clamped to ${clamped} days (allowed ${MIN_TTL_DAYS}-${MAX_TTL_DAYS}); inbox/ pruning uses the same horizon`,
    };
  return { ms: days * DAY_MS, note: "" };
}

export function keepLogLine(
  entry: { ts: string },
  now: number = Date.now(),
  ttlMs: number = MESSAGE_TTL_MS,
): boolean {
  const t = Date.parse(entry.ts);
  if (!Number.isFinite(t)) return false;
  return now - t < ttlMs;
}

/** Suffix on the sender of an entry that was never addressed to the agent. */
export const NOT_ADDRESSED = " (not addressed to Claude)";

/** The name a chat is shown under, anywhere. Order matters and each step is
 *  there for a reason:
 *
 *  1. A group's own subject - the first one in the window that is not just the
 *     chat id wearing a subject's clothing. resolveGroupName falls back to the
 *     raw jid when the metadata lookup times out or its failure cooldown is
 *     active, and lines persisted during that window carry it as `group_name`.
 *     For a legacy `<creator-number>-<timestamp>@g.us` group that is the
 *     creator's full phone number. Falling through to step 3 puts it through
 *     groupAnchor instead. The persist paths are guarded too, but only from now
 *     on - this covers what is already on disk. Deliberately NOT also filtered
 *     by looksLikeNumber: that rejects any run of six digits, so real subjects
 *     like "Sprint 2026-09-05" would lose their name, and the only bad value
 *     resolveGroupName can produce is the chat id, which is already excluded.
 *  2. For a DM ONLY, the name of someone who wrote in the chat - and only if it
 *     does not look like a phone number. `user` is displaySenderName's output,
 *     and that falls back to the jid's user part when the sender has no
 *     WhatsApp profile name, so an unsaved contact would otherwise be printed
 *     as a full raw number.
 *
 *     A GROUP never takes this step. Labelling a group with whichever member
 *     happens to be first in the window makes it indistinguishable from a DM
 *     with that person, and the label then CHANGES between sessions as the
 *     window slides to a different speaker. That is not hypothetical: when a
 *     metadata lookup times out its cooldown is five minutes, so a whole run of
 *     messages carries no subject at all.
 *  3. A masked form of the chat id. groupAnchor leaves a modern
 *     `120363...@g.us` intact and masks only the phone segment of a legacy
 *     one; maskNumber keeps the last four digits of a DM.
 *
 *  There is no fourth step and no branch that returns a bare number. */
/** A name reaches the counts list as one row, whatever the log holds.
 *  resolveGroupName and displaySenderName strip CR/LF now, but lines written
 *  before 0.23.0 were never sanitised and stay on disk for the horizon after
 *  an upgrade - and formatChatCounts emits one row per line, so a newline in
 *  a stored subject forges an entire fake chat with a fake waiting count in
 *  the one view a session is told to trust at start-up. */
export function oneLine(s: string): string {
  // ALL whitespace, not just CR/LF. safeName strips only < > [ ] ; CR LF,
  // so U+2028, U+2029, U+0085 and tabs survive it - on CURRENT lines, not
  // only pre-0.23.0 ones. U+2028 is a line terminator to many renderers and
  // a tab silently breaks the padEnd column alignment, so either one lets a
  // peer-set group subject forge a row in the counts list.
  //
  // U+0085 (NEL) is listed EXPLICITLY because JavaScript's \s does not
  // match it - measured, not assumed: /\s/ is false for U+0085 and true for
  // U+2028, U+2029, U+00A0 and tab.
  return s.replace(/[\s\u0085]+/g, " ").trim();
}

/** wait_for_messages: which of `pending` has THIS CALLER not been handed yet.
 *
 *  `seen` belongs to one caller - one connection - and is the whole of the
 *  design, settled after two failed shapes: a per-CALL snapshot hid a
 *  message that landed between two calls forever, and a per-PROCESS set let
 *  one terminal's poll starve another's. A per-connection set is the level
 *  between them. First call: `seen` is empty, everything pending is returned
 *  (a fresh terminal is never starved). Later calls: only what arrived since.
 *
 *  At most `limit` are handed per call - the NEWEST `limit` - and only what
 *  is handed is marked seen, so a backlog wider than the renderer's cap is
 *  served across calls rather than consumed unseen. The set is pruned to
 *  what is still pending, so a connection that lives for weeks holds no more
 *  keys than there are unreplied messages; an EMPTY pending list prunes
 *  nothing, because the reader returns [] on a failed read too, and one bad
 *  tick must not re-serve the whole backlog. A key is chat_id + id: message
 *  ids alone are not unique across chats.
 *
 *  NOT a high-water timestamp - WhatsApp stamps whole seconds, so two
 *  messages in one second share one, and `>` drops the second while `>=`
 *  re-serves the first forever. */
export function takeUnseen<
  T extends { chat_id: string; id: string; ts: string },
>(seen: Set<string>, pending: T[], limit = Infinity): T[] {
  if (pending.length === 0) return [];
  const key = (m: T) => `${m.chat_id}\n${m.id}`;
  const ordered = [...pending].sort(byTs);
  const keys = ordered.map(key);
  const live = new Set(keys);
  for (const k of seen) if (!live.has(k)) seen.delete(k);
  const fresh = ordered.filter((_, i) => !seen.has(keys[i]));
  const handed = fresh.length > limit ? fresh.slice(-limit) : fresh;
  for (const m of handed) seen.add(key(m));
  return handed;
}

export function chatDisplayName(
  entries: { group_name?: string; direction?: "in" | "out"; user?: string }[],
  chatId: string,
): string {
  // First USABLE subject, not merely the first. A group whose metadata
  // lookup timed out on the oldest line in the window but succeeded later
  // has its real name sitting in a later entry.
  // First subject that is usable AFTER normalising, not merely the first
  // present. A whitespace-or-CRLF-only stored subject - the unsanitised
  // pre-0.23.0 case oneLine exists for - is truthy raw and empty normalised,
  // and committing to it would both render a blank row that no `chat`
  // argument can match AND skip a later entry carrying the real subject.
  // NEWEST-FIRST, and that direction is the fix, not an accident. The window
  // arrives oldest-first, so scanning forwards returned the OLDEST usable
  // subject: a renamed group stayed listed under its former name, and could
  // not be opened by its current one. groupNameCache has no TTL, so the rename
  // only lands on restart and both names then coexist in the log. Scanning
  // backwards still covers the case the original comment was written for - a
  // metadata lookup that timed out on one line and succeeded on another - and
  // now prefers the most recent truth rather than the first one recorded.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e.group_name || e.group_name === chatId) continue;
    const usable = oneLine(e.group_name);
    if (usable) return usable;
  }
  if (chatId.endsWith("@g.us")) return groupAnchor(chatId);
  // Same rule as the group loop above, for the same reason: commit to the
  // NORMALISED value, never the raw one. A whitespace-only pushName on a
  // pre-0.23.0 line is truthy raw and empty normalised, and returning "" makes
  // a nameless counts row that no `chat` argument can match - so the chat, and
  // its waiting messages, become unreachable until the line ages out.
  // Newest-first for the same reason as the group loop: a contact who changed
  // their pushName was otherwise pinned to the oldest spelling in the window.
  //
  // A LOOP, not `.find`, and that is the fix rather than a style choice. `.find`
  // committed to the single newest inbound line and gave up if its `user` was
  // absent, whitespace-only or number-shaped - so a chat whose real display name
  // sat two lines back was shown as `•••••1234` and could not be opened by name.
  // The group loop above always kept scanning; this comment used to claim the
  // two behaved identically while this branch did not.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if ((e.direction ?? "in") !== "in" || !e.user) continue;
    const usable = oneLine(e.user);
    if (usable && !looksLikeNumber(usable)) return usable;
  }
  return maskNumber(chatId);
}

/** True when `name` is not a real name at all, but the masked/anchored form
 *  chatDisplayName falls back to. Those are id-shaped - groupAnchor returns a
 *  modern group jid unchanged, maskNumber returns a digit tail - so matching
 *  them by SUBSTRING re-opens exactly the over-match the id branch guards
 *  against: "120363" would hit every group whose subject has not resolved.
 *  A real name still matches by substring, because "mum" must work. */
export function isFallbackName(name: string, chatId: string): boolean {
  return (
    name ===
    (chatId.endsWith("@g.us") ? groupAnchor(chatId) : maskNumber(chatId))
  );
}

/** Does `want` name this chat, given `name` may be a masked fallback?
 *
 *  A real name matches by SUBSTRING, because "mum" has to work. A fallback is
 *  id-shaped, so substring-matching it re-opens the over-match the id-prefix
 *  floor guards against - but requiring an EXACT match made those chats
 *  unreachable: the counts view shows `•••••1234`, carries no chat_id, and the
 *  trailing digits are the only real text on the row, so asking for them
 *  matched neither branch and the waiting messages could not be opened at all.
 *
 *  So a fallback matches its whole self, or its trailing digits. maskNumber
 *  keeps four, which is specific enough not to be a wildcard, and it restores
 *  the only handle the row offers. Two contacts sharing those digits still
 *  collide - that is the ambiguity rule, and resolveChat owns it. */
export function nameMatches(
  name: string,
  chatId: string,
  want: string,
): boolean {
  const n = name.toLowerCase();
  if (!isFallbackName(name, chatId)) return n.includes(want);
  // DIGITS only. An unresolved group's fallback is the raw jid, so any
  // 3-char suffix - `chat="@g.us"` - matched every group whose subject had
  // not resolved and returned all of their text. This branch exists solely
  // for the masked DM tail, which is digits.
  return n === want || (/^[0-9]{3,}$/.test(want) && n.endsWith(want));
}

export type ChatRef = { chatId: string; name: string };

/** How many candidate chats an ambiguity message lists before it just counts
 *  the rest. Each row carries a raw jid, so this bounds number exposure as
 *  well as bulk - see ambiguousChatMessage. */
export const AMBIGUOUS_LIST_LIMIT = 8;

/** Resolve a `chat` argument to exactly one chat, or report the ambiguity.
 *
 *  This is the owner's own Q5 answer (2026-09-05): "ambiguous `chat` lists
 *  matches and asks". NEVER print several chat sections - that is the dump the
 *  counts view exists to prevent, and it is how a private reply ends up in a
 *  group an admin named after one of your contacts.
 *
 *  An EXACT chat_id match wins outright even when it is also a prefix of
 *  another id, because a caller passing a full jid has already been unambiguous
 *  and must not be asked to disambiguate what they fully specified.
 *
 *  A CANDIDATE is a name match or a chat_id PREFIX. There is deliberately no
 *  length floor on the prefix: the old `want.length >= 8` was justified
 *  in-comment by "every modern group id starts 120363" - which is SIX
 *  characters, so `12036342` still matched many groups and returned all of
 *  their text. No length can work, because a prefix shared by two chats is
 *  ambiguous at any length. Uniqueness is the only instrument, and it is
 *  applied right here. */
/** The counts view clips a long name and ends it with an ellipsis, and that row
 *  is the only handle a session gets - so the clipped form has to be accepted
 *  back. Used by BOTH resolveChat (to match on it) and ambiguousChatMessage (to
 *  echo the same string the matching actually used); a caller who pasted a
 *  clipped row was otherwise told `"Long Name Trunc…" matches 3 chats` about a
 *  value that was never what got matched. `|| want` is the guard, not a
 *  tidy-up: a bare "…" strips to "" and the candidate filter asks
 *  chatId.startsWith(asked), which is true for EVERY chat. */
function deEllipsised(want: string): string {
  const stripped = want.endsWith("…") ? want.slice(0, -1).trim() : want;
  return stripped || want;
}

export function resolveChat(
  candidates: ChatRef[],
  want: string,
): { ok: true; chat: ChatRef } | { ok: false; matches: ChatRef[] } {
  // THE MASKED HANDLE MUST BE ACCEPTED BACK, or masking makes the chat
  // unreachable. ambiguousChatMessage prints a DM as `•••••1234`, and that
  // string was accepted by nothing: not by name (the DM has a real name), not
  // by id prefix, and not by nameMatches' digit-tail branch, which only fires
  // when the DISPLAY NAME is itself the masked fallback. So the one handle the
  // caller was shown was the one handle that did not work - and when the DM's
  // name is a substring of the group's, no narrower name exists either, and
  // the chat could not be opened at all. Matching the masked form closes that
  // without ever printing the number.
  const maskedOf = (chatId: string) =>
    (chatId.endsWith("@g.us")
      ? groupAnchor(chatId)
      : maskNumber(chatId)
    ).toLowerCase();
  // THE CLIPPED NAME MUST BE ACCEPTED BACK, for the same reason the masked
  // handle must. formatChatCounts clips a long name to `NAME_WIDTH` and ends
  // it with an ellipsis, and the counts view is the ONLY handle a session
  // gets - it deliberately carries no chat_id. So the row a caller was shown
  // for a 35-character group subject matched nothing here and came back "no
  // chat on record", about a chat that is on record with messages waiting.
  // Dropping the ellipsis is enough: what remains is a genuine prefix of the
  // full name, which nameMatches' substring arm already accepts. (The
  // contrast with ranking.ts's clip() is real - those labels are safe to
  // truncate because the picker selects by jid, not by label.)
  // `|| want` IS THE GUARD, not a tidy-up. `chat="…"` strips to the empty
  // string, and the candidate filter below asks `chatId.startsWith(asked)` -
  // which is TRUE FOR EVERY CHAT when asked is "". On a log holding one chat
  // that resolves to it and prints the whole thing, which is exactly the
  // "never guess a chat" rule this function exists to hold. Falling back to
  // the original leaves "…" matching nothing, and the caller says so.
  const asked = deEllipsised(want);
  const hits = candidates.filter(
    (c) =>
      nameMatches(c.name, c.chatId, asked) ||
      c.chatId.toLowerCase().startsWith(asked) ||
      maskedOf(c.chatId) === asked,
  );
  // A full jid wins outright: it is unique, so a caller who passed one has
  // already been unambiguous.
  const exactJid = hits.find((c) => c.chatId.toLowerCase() === asked);
  if (exactJid) return { ok: true, chat: exactJid };
  // A NAME THAT REALLY ENDS IN AN ELLIPSIS wins when it is typed exactly.
  // deEllipsised turns "Loading…" into "loading", and substring matching
  // then also hits "Loading Screen Design" - so a chat whose real subject
  // ends in "…" could never be named, not even by the exact row the counts
  // view printed. ONLY the stripped case, and only the raw spelling: "mum"
  // against "Mum" and "Mum's Group" stays ambiguous, as the tests below pin
  // (ask, do not guess). Two chats sharing the exact name still fall through.
  if (asked !== want) {
    const raw = want.toLowerCase();
    const exactName = hits.filter((c) => c.name.toLowerCase() === raw);
    if (exactName.length === 1) return { ok: true, chat: exactName[0] };
  }
  // A MASKED HANDLE IS NOT UNIQUE, so it only wins when exactly one chat
  // produces it. maskNumber keeps the last FOUR digits, and nameMatches says
  // so two functions up: "two contacts sharing those digits still collide -
  // that is the ambiguity rule". Taking the first hit bypassed that rule at
  // the one point it was meant to apply, and the cost is the whole reason
  // this file resolves chats at all: catch_up would render Alice's messages
  // under Alice's chat_id, and the reply meant for Bob goes to her. Falling
  // through re-asks instead, and the rows still differ by name.
  const maskedHits = hits.filter((c) => maskedOf(c.chatId) === asked);
  if (maskedHits.length === 1) return { ok: true, chat: maskedHits[0] };
  if (hits.length === 1) return { ok: true, chat: hits[0] };
  return { ok: false, matches: hits };
}

/** What to say when `chat` matched more than one. Carries the chat_id, which
 *  the counts view deliberately omits - at the point the caller has to choose,
 *  the id is the only thing that actually distinguishes two identically-named
 *  chats, and it is what `reply` needs anyway. The group/DM marker is here
 *  because a group can be NAMED after a contact, so the name alone does
 *  not tell them apart. */
export function ambiguousChatMessage(raw: string, matches: ChatRef[]): string {
  // Echo what was MATCHED ON, not what was typed - see deEllipsised.
  const want = deEllipsised(raw);
  // CAPPED. Every row carries a raw jid - a phone number for a DM - and the
  // candidate rule is "any name substring or any id prefix", with no length
  // floor. So `chat="a"` is a perfectly plausible call (the counts view shows
  // names only, and the tool description invites "part of a name") and it
  // would otherwise print one unmasked number per matching chat, in the very
  // session-start flow this work exists to stop dumping. Showing a handful is
  // enough to disambiguate or to prove the argument was too vague; the rest
  // are counted, not listed.
  // NEVER A RAW NUMBER (owner, 2026-09-08, and scripts/mask.ts's own header,
  // which names "a disambiguation prompt" as a case that must render masked).
  // A group jid is not a phone number, so groupAnchor leaves it intact and it
  // stays directly callable; a DM's jid IS the number, so it is masked to its
  // last four digits. Built masked at the point the string is created, not
  // scrubbed afterwards - a filter someone forgets to call is a real number
  // sitting in a transcript.
  const rowList = matches.slice(0, AMBIGUOUS_LIST_LIMIT).map((m) => {
    const isGroup = m.chatId.endsWith("@g.us");
    const shown = isGroup ? groupAnchor(m.chatId) : maskNumber(m.chatId);
    return `  - ${m.name} [${isGroup ? "group" : "DM"}] ${shown}`;
  });
  const rows = rowList.join("\n");
  const more = matches.length - AMBIGUOUS_LIST_LIMIT;
  const tail = more > 0 ? `\n  ...and ${more} more - narrow the name.` : "";
  // TWO ROWS CAN RENDER IDENTICALLY, and then this is a dead end rather than a
  // question. Two unsaved contacts whose numbers end in the same four digits
  // share BOTH the masked fallback name and the masked handle, so every
  // argument the caller could pass - the name, the handle, any id prefix they
  // share - lands back here forever. resolveChat is right to refuse (guessing
  // is how a private reply reaches the wrong person), so the way out has to be
  // the full jid: it is unique and resolveChat accepts it. This message must
  // not print it, because a DM's jid IS the number - `unreplied` is where it
  // already appears, so that is where the caller is sent.
  const indistinguishable =
    rowList.length !== new Set(rowList).size
      ? "\n  Two of these render identically and no argument here can separate them. Ask the user whose number it is and pass the full jid as `chat` (<countrycode+number>@s.whatsapp.net), which is unique and accepted verbatim. unreplied prints the full chat_id too, but ONLY for a chat with something waiting - a quiet one will not be there."
      : "";
  // ASK, do not guess. A group id above is callable as-is; a DM's is masked, so
  // the way through is the owner saying which - "the group" or "the person" -
  // which is exactly how he said he would answer it.
  return `"${want}" matches ${matches.length} chats. Ask which one is meant - name the group or the person - and use their answer to narrow the chat argument:\n${rows}${tail}${indistinguishable}`;
}

export type ChatCount = {
  name: string;
  unreplied: number;
  /** Whether to mark this chat with a WhatsApp-style `@`. TRUE ONLY FOR A
   *  MENTION-GATED GROUP (owner, 2026-09-05). In an ungated group every
   *  message routes to us, so an always-on `@` would be technically true and
   *  carry no information at all - the marker is worth having precisely
   *  because it is selective. Never set for a DM. */
  mentionGated: boolean;
};

/** Session start: how many are waiting, per chat, and nothing else. No message
 *  text appears here at all - that is what naming one chat is for. A chat with
 *  recent traffic but nothing unreplied is omitted entirely rather than listed
 *  as 0, so the list is only ever things that want the owner.
 *
 *  Sorted most-unreplied first, then alphabetically, so the loudest room is at
 *  the top and the order is stable between sessions.
 *
 *  Returns "" when nothing is waiting; the caller decides what to say instead,
 *  because it also knows whether there are open tasks to show.
 *
 *  Known ceiling: aligns on `name.length`, i.e. UTF-16 code units, so a chat name
 *  with emoji or CJK drifts by a column or two. displayWidth() in
 *  scripts/picker.ts does this properly, but importing it here would drag a
 *  raw-mode TUI into a pure module. Move displayWidth into lib/ and use it if
 *  the misalignment ever actually bothers anyone. */
export function formatChatCounts(chats: ChatCount[]): string {
  const listed = chats
    .filter((c) => c.unreplied > 0)
    .sort((a, b) => b.unreplied - a.unreplied || a.name.localeCompare(b.name));
  if (listed.length === 0) return "";
  // BOUNDED, because a group subject is peer-controlled and unbounded. safeName
  // substitutes characters and oneLine collapses whitespace; neither clips, and
  // ranking.ts's clip() is only wired to wizard labels. So one admin setting a
  // 500-character subject padded EVERY row of this list to 500 columns - the
  // one view a session is told to read at start-up, and the same abuse surface
  // the row-forging guards next to it already defend. The name itself is
  // clipped too, or the long row survives the cap it is meant to be under.
  const NAME_WIDTH = 32;
  // Clipped by CODE POINT, not by code unit. `slice` cuts a surrogate pair in
  // half when the 32nd unit is one, and the row a session is told to read at
  // start-up then carries a lone surrogate that renders as U+FFFD. Same class
  // of bug this branch fixed in chunk(); cosmetic here rather than corrupting,
  // because the truncated handle still matches back through resolveChat, but
  // an emoji in a group subject is not exotic. Alignment is still by code
  // unit - see the ponytail note above; this fixes the mangling, not the
  // arithmetic.
  const clipName = (n: string) => {
    const cps = Array.from(n);
    return cps.length > NAME_WIDTH
      ? cps.slice(0, NAME_WIDTH - 1).join("") + "…"
      : n;
  };
  const width = Math.min(
    NAME_WIDTH,
    Math.max(...listed.map((c) => c.name.length)),
  );
  return listed
    .map(
      (c) =>
        // The marker is GLUED to the count ("@12", not "@  12"). Chat names
        // are peer-controlled and safeName does not strip "@", so a group
        // innocently called "Standup @ 9" would otherwise carry an @ in a
        // column no reader can tell from the marker. Adjacent to the trailing
        // number it is unambiguous: the marker is the character immediately
        // before the count, and nothing else on the line can be.
        `${clipName(c.name).padEnd(width)}   ${c.mentionGated ? "@" : " "}${c.unreplied}`,
    )
    .join("\n");
}

/** How long a chat is remembered as having aged out. Long enough that coming
 *  back from a month away still says so, short enough that the file cannot
 *  grow forever. */
export const AGED_OUT_TTL_MS = 30 * DAY_MS;

/** hashed chat_id -> when a waiting line of that chat was pruned. */
export type AgedOut = Record<string, number>;

/** The key a chat is recorded under. NOT the chat_id.
 *
 *  This record outlives the log lines it describes - that is its whole job -
 *  so storing raw jids would leave real phone numbers on disk for thirty days
 *  after the messages containing them were deleted. Nothing ever needs the id
 *  back: the value is only ever counted, and compared against the same hash of
 *  the chats currently in the log.
 *
 *  A truncated SHA-256, not a security boundary. Phone numbers are
 *  low-entropy and this is unsalted, so it is a dedupe key that does not
 *  casually spill numbers - not protection against someone who already has
 *  the state directory, where access.json holds the allowlist in the clear. */
export function agedOutKey(chatId: string): string {
  return createHash("sha256").update(chatId).digest("hex").slice(0, 16);
}

/** Record that a chat lost something that was still WAITING.
 *
 *  Recording and COUNTING are deliberately separate, because the two facts
 *  arrive at different times. A prune tick that drops an unanswered mention
 *  may still leave later chatter behind; the tick that finally empties the
 *  chat drops nothing unanswered. Requiring both in one tick means the room
 *  is never recorded at all - which is precisely the "you were away and
 *  something was waiting" case this exists for. So the miss is remembered
 *  here, and `countAgedOut` decides later whether the chat is still readable.
 *
 *  A chat you FULLY HANDLED never gets here: nothing it lost was unreplied.
 *
 *  NOTHING CLEARS A KEY EARLY, and that is deliberate after two attempts that
 *  each lost a real miss:
 *
 *  - Clearing when the chat is "readable again" erases the record on the very
 *    next tick, because a chat almost always still holds lines for the hour
 *    after one of its unanswered lines is pruned. The miss is then gone from
 *    the counts AND from this record - the feature failing at its one job.
 *  - Distinguishing "came back and was handled" from "still holds older
 *    lines" needs a per-chat newest-surviving-timestamp compared against the
 *    recorded time. That is a correct rule and it is more machinery than the
 *    imprecision it removes.
 *
 *  So a chat that was missed, then talked to and fully answered, can still be
 *  counted once more when its lines finally age out. That over-reports by one
 *  line of text, bounded by the 30-day expiry. Losing a genuine miss is the
 *  worse failure of the two, and this direction cannot do it.
 *
 *  Ids are stored hashed - see `agedOutKey`.  */
export function updateAgedOut(
  previous: AgedOut,
  missedKeys: Iterable<string>,
  now: number = Date.now(),
  handled: ReadonlyMap<string, number> = new Map(),
): AgedOut {
  const next: AgedOut = {};
  for (const [key, at] of Object.entries(previous)) {
    if (!Number.isFinite(at) || now - at >= AGED_OUT_TTL_MS) continue;
    // HANDLED SINCE THE MISS -> forget it. `handled` maps a chat key to the
    // newest surviving line in a chat that currently has NOTHING waiting.
    //
    // This is the rule an earlier review named as correct and deferred as
    // "more machinery than the imprecision it removes". That trade no longer
    // holds: without it
    // the key survives the full 30 days, so a chat whose miss aged out on day 8
    // and which the owner fully answered on day 9 announced "1 chat had
    // activity older than 7 days" at EVERY session start until day 38 - about a
    // chat that is completely read and completely answered.
    //
    // The comparison is against `at`, the moment the miss was RECORDED, and
    // that is what makes this safe where the first attempt was not. That one
    // cleared on "readable again", which is true almost immediately because a chat still
    // holds older lines - so the record died on the very next tick and a real
    // miss was lost. Requiring a line NEWER THAN THE MISS means something
    // actually happened after it, and requiring nothing waiting means that
    // something was dealt with. The scenario that broke the first attempt stays recorded: its
    // surviving day-1 line is older than the day-7 record, so it clears
    // nothing.
    const newest = handled.get(key);
    if (newest !== undefined && newest > at) continue;
    next[key] = at;
  }
  for (const key of missedKeys) next[key] ??= now;
  return next;
}

/** How many recorded chats are actually unreachable right now.
 *
 *  A chat still holding lines is not missing - it is in the counts list, or it
 *  has nothing waiting - so it must not also be reported as aged out. Without
 *  this the same chat appears in both halves of one session-start output for
 *  up to an hour, until the next prune tick corrects the record. */
export function countAgedOut(
  record: AgedOut,
  visibleKeys: ReadonlySet<string>,
): number {
  return Object.keys(record).filter((key) => !visibleKeys.has(key)).length;
}

/** The trailing session-start line, or "" when there is nothing to say.
 *  `days` comes from the live horizon so the sentence stays true when
 *  WHATSAPP_MESSAGE_TTL_DAYS changes it (owner 2026-09-05: the concrete
 *  number, not "the retention window"). Not rounded: the knob accepts
 *  fractions, and "older than 2 days" when the horizon is 1.5 is exactly the
 *  untruth the concrete number was asked for to avoid. */
export function agedOutLine(count: number, days: number): string {
  if (count <= 0) return "";
  const chats = count === 1 ? "chat" : "chats";
  const d = Number.isFinite(days) && days > 0 ? days : 7;
  const shown = Number.isInteger(d) ? String(d) : String(Number(d.toFixed(2)));
  // The model reads this line aloud at session start, so the day noun agrees
  // with the number the same way the chat noun already does - at the minimum
  // horizon it used to say "older than 1 days". Keyed off `shown`, not `d`,
  // so a fractional horizon that formats to "1" agrees too.
  const dayNoun = shown === "1" ? "day" : "days";
  return `${count} ${chats} had activity older than ${shown} ${dayNoun}.`;
}

/** How many messages per chat catch_up replays. */
export const RECENT_LIMIT = 5;

export const byTs = <T extends { ts: string }>(a: T, b: T) =>
  a.ts.localeCompare(b.ts);

/** THE catch_up window: the last `limit` lines from each side, exactly as
 *  USAGE.md has always promised - but the INBOUND half is filled by the
 *  messages that COUNT before the ones that do not.
 *
 *  THE BUG THIS EXISTS FOR. Two different rules were being applied to one
 *  chat. The badge counts only lines `awaitingReply` calls waiting - in a
 *  mention-gated group, only messages that actually @-mentioned the owner.
 *  The view showed the last `limit` INBOUND lines of any kind. So:
 *
 *      WIL Group HUDINI @1        <- one message addressed you
 *      ...open it, and five lines of unrelated group chatter had pushed that
 *      message out of the window entirely.
 *
 *  The badge pointed at a message the view was structurally unable to show.
 *  Worse, `reply` then marks every unreplied line answered (owner, 2026-09-08:
 *  the sender sees their own full thread, so one reply addresses everything
 *  before it) - so answering the chatter silently retired a question nobody
 *  ever read, and it left the counts, the list, and every future session.
 *
 *  THE FIX IS NOT A BIGGER WINDOW. An earlier attempt showed every unanswered
 *  line, which broke the documented "last 5 each side" contract and let one
 *  busy group render thousands of lines into a single tool result. The window
 *  stays the size it always was; only the PRIORITY inside the inbound half
 *  changes. Waiting messages take those slots first, newest first; ordinary
 *  chatter fills whatever is left, so context is still there when there is
 *  room for it. The caller's `hidden` count reports any waiting lines that did
 *  not fit, which is what turns a silent drop into "+N more waiting".
 *
 *  In a DM or an ungated group every inbound line is awaiting, so this
 *  degrades to exactly the old behaviour - there is nothing to prioritise.
 *
 *  This is a window builder over ONE chat's entries, not a general merge: it
 *  assumes each line appears once in `entries`. */
export function catchUpWindow<
  T extends {
    ts: string;
    direction?: "in" | "out";
    replied?: boolean;
    routed?: false;
  },
>(entries: T[], limit: number = RECENT_LIMIT): T[] {
  // Sorted before slicing: `entries` arrives in log order, which is usually
  // chronological but is not guaranteed to be, and "the last N" has to mean
  // newest by timestamp, not last in the file.
  const sorted = [...entries].sort(byTs);
  const isIn = (e: T) => (e.direction ?? "in") === "in";
  const inbound = sorted.filter(isIn);
  const waiting = inbound.filter((e) => awaitingReply(e)).slice(-limit);
  // Chatter only gets the slots waiting messages did not take, so the inbound
  // half is still exactly `limit` lines - the documented size.
  const room = limit - waiting.length;
  const chatter =
    room > 0 ? inbound.filter((e) => !awaitingReply(e)).slice(-room) : [];
  // No dedupe needed: the three halves are provably disjoint - `waiting` is
  // inbound and awaiting, `chatter` is inbound and not awaiting, `outbound` is
  // not inbound. The old design unioned two OVERLAPPING sets and needed a Set;
  // this one cannot produce a duplicate.
  const outbound = sorted.filter((e) => !isIn(e)).slice(-limit);
  return [...waiting, ...chatter, ...outbound].sort(byTs);
}

/** What a caption-less media message says instead of the raw "(voice)" marker
 *  the persist boundary wrote. Only these two kinds get their own word here
 *  ([photo] is handled from image_path, which an image sets instead of a
 *  kind); ANYTHING ELSE IS `[file]`, including a kind a later Baileys
 *  invents - an unknown kind must still name itself as a file. */
const MEDIA_PLACEHOLDER: Record<string, string> = {
  voice: "[voice]",
  video: "[video]",
};

/** How one entry renders. The ONLY place the owner label exists. Text is
 *  shown verbatim for every line the log still holds: an owner hand reply
 *  used to fade to "replied (text expired)" after an hour, which left every
 *  chat older than that reading one-sided - their half in full, the owner's
 *  half blanked - exactly when catch_up is wanted (owner, 2026-08-28).
 *  keepLogLine is now the whole retention story.
 *
 *  A MEDIA MESSAGE WITH NO CAPTION IS STILL A MESSAGE. Without a
 *  placeholder it rendered as an empty line, so the count said one was waiting
 *  and the view appeared to show nothing - the count and the view have to
 *  agree. Both renderers take their text from here, so this is the one place
 *  it belongs; the caller's own `(image: ...)` / `(voice attachment)` suffix
 *  still follows, because a placeholder says WHAT arrived and the suffix says
 *  how to open it. */
export function renderLogEntry(
  entry: ViewableEntry,
  ownerName: string,
): { who: string; text: string } {
  return {
    who:
      entry.by === "owner"
        ? ownerName
        : entry.routed === false
          ? `${entry.user}${NOT_ADDRESSED}`
          : entry.user,
    text: mediaPlaceholder(entry) || entry.text,
  };
}

/** "" unless this entry IS caption-less media, in which case the placeholder.
 *
 *  A CAPTION-LESS MEDIA MESSAGE NEVER REACHES HERE AS AN EMPTY STRING, and
 *  assuming it did made the first version of this dead code. server.ts's
 *  persist boundary computes `text || (media ? "(" + media.kind + ")" : "")`
 *  (contentText, and the same rule on the routed:false context path), so what
 *  is on disk for a caption-less photo is the literal "(image)" - and that
 *  marker is load-bearing elsewhere: the live notification carries the same
 *  bytes, so it cannot simply be dropped at the source.
 *
 *  The marker is therefore recognised rather than parsed: it is rebuilt from
 *  the entry's OWN fields and compared, so a real caption that merely looks
 *  like a marker for a different kind is untouched, and a caption that is
 *  byte-identical to this entry's own marker is indistinguishable from the
 *  marker by construction. An image sets image_path and never a kind. */
function mediaPlaceholder(entry: ViewableEntry): string {
  const kind = entry.image_path ? "image" : entry.attachment_kind;
  if (!kind) return "";
  // A real caption wins; "" is included because a hand-written or legacy line
  // can still be empty, and that is the case this was always meant to cover.
  if (entry.text && entry.text !== `(${kind})`) return "";
  return kind === "image" ? "[photo]" : (MEDIA_PLACEHOLDER[kind] ?? "[file]");
}
