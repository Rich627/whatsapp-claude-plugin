// Pulled out of server.ts so the probe is testable without its
// connect-on-import side effects (same reason message-view.ts/mentions.ts were
// split out). Pure string decision, no I/O.
//
// WHY A SUBSTRING AND NOT A PARSE: markReplied already reads and re-serialises
// the whole log on the path that follows this check, so a second full parse
// buys nothing. The probe is exact rather than fuzzy because every writer of
// this file builds the entry literal with `id` FIRST, so JSON.stringify emits
// `{"id":<id>,` at byte 0 of every line.
//
// It cannot be spoofed by message text. JSON.stringify never emits an
// unescaped `"` inside a string value, so the byte sequence `{"id":"` can only
// occur at a structural position, and a MessageLogEntry has no nested objects -
// the only structural position is the start of the line. A contact sending the
// literal text `{"id":"someid",` is stored as `"text":"{\"id\":\"someid\",..."`
// and does not match. Prefix and suffix collisions are impossible too: the
// probe is anchored by `{"id":` on the left and the quoted id plus `,` on the
// right.
//
// If anyone ever reorders MessageLogEntry's object literal so `id` is not
// first, this silently returns false for everything and the caller's guard
// stops working with no other symptom. That is what the tests pin.
export function logContainsId(logText: string, id: string): boolean {
  if (!id) return false;
  return logText.includes(`{"id":${JSON.stringify(id)},`);
}
