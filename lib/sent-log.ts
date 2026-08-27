// Pulled out of server.ts so trackSent's durable half is testable without its
// connect-on-import side effects (same reason message-view.ts/message-log-
// probe.ts were split out). Pure parse/format, no I/O.
//
// sent.jsonl records only ids this process produced (see trackSent's only
// callers: sendTracked and the direct sock.sendMessage sites, every one of
// which passes the key of a message this server just sent). No
// contact-controlled string ever reaches this file, which is why the parser
// below can be strict about shape rather than spoof-hardened the way
// logContainsId had to be.
//
// The tests pin: `id` first in the serialised line (matching
// MessageLogEntry's convention), the strict `ts > cutoffMs` comparison
// pruneMessageLog also uses, and that a malformed line is dropped without
// throwing and without disturbing its neighbours.

/** Serialise one entry. No trailing newline — the caller appends "\n",
 *  the same way persistMessage does (server.ts:2010). */
export function formatSentLine(id: string, ts: number): string {
  return JSON.stringify({ id, ts });
}

/** Parse the whole file.
 *  @param text     raw file contents ("" for a missing file)
 *  @param cutoffMs epoch ms; an entry is KEPT when `entry.ts > cutoffMs`
 *                  (strictly greater — same comparison pruneMessageLog uses at
 *                  server.ts:2144)
 *  @returns ids   — the ids of the kept entries
 *           lines — the kept lines VERBATIM, in file order, for the prune
 *                   rewrite (no re-serialisation, so nothing can drift)
 */
export function parseSentLog(
  text: string,
  cutoffMs: number,
): { ids: Set<string>; lines: string[] } {
  const ids = new Set<string>();
  const lines: string[] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      continue;
    const { id, ts } = parsed as Record<string, unknown>;
    if (typeof id !== "string" || !id) continue;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (ts <= cutoffMs) continue;
    ids.add(id);
    lines.push(line);
  }
  return { ids, lines };
}
