// Any phone number shown to a human (a name-collision error, a
// disambiguation prompt) renders masked, built masked at the point the
// string is created - never as a filter applied after the fact, since a
// scrubber someone forgets to call is a real number sitting in a transcript.
//
// Fixed-length mask (5 bullets, not one per hidden digit): a variable-length
// mask still leaks the number's digit count, which narrows down country code
// and format. A fixed length reveals only the last 4 digits, nothing else.
export function maskNumber(input: string): string {
  const digits = String(input ?? "")
    .split("@")[0]
    .replace(/\D/g, "");
  if (digits.length <= 4) return "•".repeat(5);
  return "•".repeat(5) + digits.slice(-4);
}
