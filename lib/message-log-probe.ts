// Exact substring probe for messages.jsonl (no I/O): every writer puts `id`
// FIRST so each line starts `{"id":<id>,`, and JSON.stringify never emits an
// unescaped `"` inside a value, so message text cannot spoof it; reorder the
// literal and this silently returns false - the tests pin that.
export function logContainsId(logText: string, id: string): boolean {
  if (!id) return false;
  return logText.includes(`{"id":${JSON.stringify(id)},`);
}
