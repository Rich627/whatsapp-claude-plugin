// Writing "@12345" in the text is not enough: WhatsApp only renders a mention —
// and only notifies the person — when the message also carries a `mentions`
// array of JIDs. Without it the @ is inert text. The tool's contract (see the
// `reply` schema in server.ts) tells the caller to write "@<id>" using the
// exact id it passed in the `mentions` array, so that literal id — not
// whatever JID we resolve it to internally — is what a later text match must
// look for.
import { maskNumber } from "./mask";
import { resolveByName, type ContactsMap } from "./contacts";

// The array normalizeMentionJids returns can hold the same jid twice under
// two different `input` spellings (a LID and its phone number for one
// person, see the test for that case) - deliberately not deduped here,
// since both spellings must stay independently matchable against text.
// Any caller building an actual outgoing mentions list from this needs to
// dedupe at the jid level itself; mentionsForChunk's own [...new Set()]
// does this at output time, and so does server.ts's document-mode preview
// path. A future caller that skips that step will get duplicate/aliased
// jids - this was a real, working guarantee of the pre-refactor API that
// moving to pairs deliberately traded away for the input-matching fix.
export type MentionPair = { input: string; jid: string };

// Two saved contacts sharing a display name is not something to guess a
// winner for — the caller must fall back to the real id for that name.
// Message is built with masked numbers so the ambiguity is resolvable by a
// human without a raw number ever needing to reach whatever surfaces this
// error (this is a plain Error, not a special type, because server.ts's
// tool-call handler already formats any thrown Error into a clean tool
// failure — no special-casing needed at the call site).
function ambiguousNameError(name: string, candidates: string[]): Error {
  const masked = candidates.map((c) => maskNumber(c)).join(", ");
  return new Error(
    `"${name}" matches more than one contact (${masked}) — use the number directly, or rename one in your phone.`,
  );
}

// Accept ids in whatever shape the caller has (a known contact's name, bare
// number, @-prefixed, LID or phone, full JID) and normalise to a JID, while
// keeping the original input next to it so mentionsForChunk can still find
// "@<input>" as written. Name resolution is tried first: a saved contact's
// name always wins over treating the same string as a numeric id, since
// nobody is expected to have a contact named after a valid phone number.
export function normalizeMentionJids(
  raw: string[],
  lidMap: Record<string, string>,
  jidNormalizedUser: (jid: string) => string,
  jidDecode: (jid: string) => { user: string } | undefined,
  contactsMap: ContactsMap = {},
): MentionPair[] {
  const out: MentionPair[] = [];
  for (const entry of raw) {
    const s = String(entry ?? "")
      .trim()
      .replace(/^@+/, "");
    if (!s) continue;

    const byName = resolveByName(contactsMap, s);
    if (byName.ok) {
      out.push({ input: s, jid: byName.jid });
      continue;
    }
    if (byName.reason === "ambiguous") {
      throw ambiguousNameError(s, byName.candidates);
    }

    let jid: string;
    // A full-JID input's local part can carry a device suffix
    // ("<num>:12@s.whatsapp.net") - reply_to_sender surfaces
    // contextInfo.participant verbatim, which is exactly this shape. Nobody
    // types "@<num>:12" in reply text, so the match key strips it the same
    // way jidDecode().user does, rather than the raw split("@")[0] below.
    let inputKey: string | undefined;
    if (s.includes("@")) {
      jid = jidNormalizedUser(s);
      inputKey = jidDecode(s)?.user;
    } else {
      // Group participants are LID-addressed, so prefer the LID form
      // whenever we know it — but the caller was told to type "@<s>" (the
      // input id), not "@<jid>", so mentionsForChunk must match on `s`.
      const asLid = `${s}@lid`;
      if (lidMap[asLid]) {
        jid = asLid;
      } else {
        const lidForPhone = Object.keys(lidMap).find(
          (k) => lidMap[k] === `${s}@s.whatsapp.net`,
        );
        jid = lidForPhone ?? `${s}@s.whatsapp.net`;
      }
    }
    // The match key is always the input's own local part — a full JID
    // input ("<num>@s.whatsapp.net") still matches "@<num>" in text, the
    // same as a bare number does, since nobody writes "@<num>@domain" in a
    // chat message. Not deduped here: two different input spellings that
    // happen to resolve to the same jid (a LID and its phone number) must
    // both stay matchable, since the text might use either spelling.
    out.push({ input: inputKey ?? s.split("@")[0], jid });
  }
  return out;
}

// server.ts's `reply` handler treats a mentions-array entry of "all" as the
// reserved every-participant token (see expandAllMention below) UNLESS a
// real saved contact is literally named "All" - name resolution always
// wins over a reserved keyword, the same precedence normalizeMentionJids
// already gives a saved name over treating it as a numeric id.
export function isReservedAllToken(
  entry: string,
  contactsMap: ContactsMap,
): boolean {
  const s = entry.trim().replace(/^@+/, "");
  if (s.toLowerCase() !== "all") return false;
  return !resolveByName(contactsMap, s).ok;
}

// "@all" expands to every group participant's own jid, all sharing the
// same input ("all") so mentionsForChunk's ordinary text-match handles it
// like any other mention: one "@all" in the text attaches every expanded
// pair to that chunk. Building the pairs here (not inline in server.ts)
// keeps this step unit-testable without a live Baileys socket - the
// sock.groupMetadata() fetch and the roster-access permission check stay
// in server.ts, the only place that can make either of them.
export function expandAllMention(
  participantIds: string[],
  jidNormalizedUser: (jid: string) => string,
): MentionPair[] {
  return participantIds.map((id) => ({ input: "all", jid: jidNormalizedUser(id) }));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A long reply is split into chunks; only attach a mention to the chunk whose
// text actually references it, so nobody gets pinged once per chunk. Matches
// against the original input the caller typed, not the resolved JID —
// resolution can silently swap a bare number for a cached LID with a
// different local part, and matching on that instead used to drop the
// mention from every chunk whenever a mapping happened to be cached. The
// match requires a word-character boundary after the input, not just a
// digit one: that covers a shorter numeric id that's a text-prefix of a
// longer one ("6123" vs "61234567") *and* a name that's a text-prefix of a
// longer word ("Akash" vs "Akashi") now that names go through this path too.
// Case-insensitive: resolveByName() matches a name regardless of casing, so
// the caller can resolve via "Akash" but write "@akash" mid-sentence
// without the mismatch silently dropping the mention - a gap that didn't
// exist before names, since digits have no case.
export function mentionsForChunk(
  text: string,
  all: MentionPair[],
): string[] | undefined {
  if (!all.length) return undefined;
  const hits = all.filter((m) =>
    new RegExp(`@${escapeRegExp(m.input)}(?!\\w)`, "i").test(text),
  );
  return hits.length ? [...new Set(hits.map((m) => m.jid))] : undefined;
}
