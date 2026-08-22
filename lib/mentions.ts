// Writing "@12345" in the text is not enough: WhatsApp only renders a mention —
// and only notifies the person — when the message also carries a `mentions`
// array of JIDs. Without it the @ is inert text. The tool's contract (see the
// `reply` schema in server.ts) tells the caller to write "@<id>" using the
// exact id it passed in the `mentions` array, so that literal id — not
// whatever JID we resolve it to internally — is what a later text match must
// look for.
export type MentionPair = { input: string; jid: string };

// Accept ids in whatever shape the caller has (bare, @-prefixed, LID or
// phone, full JID) and normalise to a JID, while keeping the original input
// id next to it so mentionsForChunk can still find "@<id>" as written.
export function normalizeMentionJids(
  raw: string[],
  lidMap: Record<string, string>,
  jidNormalizedUser: (jid: string) => string,
  jidDecode: (jid: string) => { user: string } | undefined,
): MentionPair[] {
  const out: MentionPair[] = [];
  for (const entry of raw) {
    const s = String(entry ?? "")
      .trim()
      .replace(/^@+/, "");
    if (!s) continue;
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A long reply is split into chunks; only attach a mention to the chunk whose
// text actually references it, so nobody gets pinged once per chunk. Matches
// against the original input id the caller typed, not the resolved JID —
// resolution can silently swap a bare number for a cached LID with a
// different local part, and matching on that instead used to drop the
// mention from every chunk whenever a mapping happened to be cached. The
// match requires a digit boundary after the id so a shorter mentioned id
// that's a text-prefix of a longer one in the same message ("6123" vs
// "61234567") doesn't falsely attach to the longer one's chunk.
export function mentionsForChunk(
  text: string,
  all: MentionPair[],
): string[] | undefined {
  if (!all.length) return undefined;
  const hits = all.filter((m) =>
    new RegExp(`@${escapeRegExp(m.input)}(?!\\d)`).test(text),
  );
  return hits.length ? [...new Set(hits.map((m) => m.jid))] : undefined;
}
