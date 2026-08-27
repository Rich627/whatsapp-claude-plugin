// Pure parse/format for sent.jsonl (no I/O), which holds only ids this
// process sent - no contact-controlled string - so the parser is strict, not
// spoof-hardened like logContainsId.

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
    let id: unknown, ts: unknown;
    try {
      // Destructuring `null` throws like bad JSON does; an array or a
      // primitive yields undefined and fails the shape checks below.
      ({ id, ts } = JSON.parse(line));
    } catch {
      continue;
    }
    if (typeof id !== "string" || !id) continue;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (ts <= cutoffMs) continue;
    ids.add(id);
    lines.push(line);
  }
  return { ids, lines };
}
