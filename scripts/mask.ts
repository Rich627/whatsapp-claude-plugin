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

// A "name" that's actually just a phone number in disguise defeats any
// caller that must never show a raw number: WhatsApp's own self-reported
// `.notify` commonly defaults to exactly this for anyone who hasn't set a
// custom display name, so contactName()'s permissive name-or-notify
// fallback (fine for convenience labeling elsewhere) can hand back a real
// number to a caller that thought it was getting a name. A caller with
// that guarantee to keep should treat a number-shaped result as no name
// at all and mask it instead.
export function looksLikeNumber(s: string): boolean {
  return /^\+?[\d\s()-]{4,}$/.test(s.trim());
}
