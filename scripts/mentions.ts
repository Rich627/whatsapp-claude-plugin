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
): MentionPair[] {
  const out: MentionPair[] = [];
  const seenJids = new Set<string>();
  for (const entry of raw) {
    const s = String(entry ?? "")
      .trim()
      .replace(/^@/, "");
    if (!s) continue;
    let jid: string;
    if (s.includes("@")) {
      jid = jidNormalizedUser(s);
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
    if (seenJids.has(jid)) continue;
    seenJids.add(jid);
    out.push({ input: s, jid });
  }
  return out;
}

// A long reply is split into chunks; only attach a mention to the chunk whose
// text actually references it, so nobody gets pinged once per chunk. Matches
// against the original input id the caller typed, not the resolved JID —
// resolution can silently swap a bare number for a cached LID with a
// different local part, and matching on that instead used to drop the
// mention from every chunk whenever a mapping happened to be cached.
export function mentionsForChunk(
  text: string,
  all: MentionPair[],
): string[] | undefined {
  if (!all.length) return undefined;
  const hits = all.filter((m) => text.includes(`@${m.input}`));
  return hits.length ? hits.map((m) => m.jid) : undefined;
}
