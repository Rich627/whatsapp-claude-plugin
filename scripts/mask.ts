// Any phone number shown to a human (a name-collision error, a
// disambiguation prompt) renders masked, built masked at the point the
// string is created - never as a filter applied after the fact, since a
// scrubber someone forgets to call is a real number sitting in a transcript.
//
// Fixed-length mask (5 bullets, not one per hidden digit): a variable-length
// mask still leaks the number's digit count, which narrows down country code
// and format. A fixed length reveals only the last 4 digits, nothing else.
// The device suffix is stripped as well as the domain: a JID off the wire can
// be `<number>:<device>@…`, and since this keeps the LAST four digits, an
// unstripped `:12` would silently shift the window and render the same person
// two different ways depending on which call site normalized the JID first.
export function maskNumber(input: string): string {
  const digits = String(input ?? "")
    .split("@")[0]
    .split(":")[0]
    .replace(/\D/g, "");
  if (digits.length <= 4) return "•".repeat(5);
  return "•".repeat(5) + digits.slice(-4);
}

// A MODERN group JID is a random `120363…@g.us` and carries nothing personal,
// which is why a group's anchor shows it in full. A LEGACY one is
// `<creator-phone>-<created-at>@g.us`, so the same field would put a real
// phone number on screen and into the transcript - exactly what this file
// exists to stop. The hyphen is what tells the two apart: mask only the
// segment before it, leaving the timestamp (and the whole modern form)
// intact, so the anchor still identifies one group unambiguously.
export function groupAnchor(jid: string): string {
  const at = jid.indexOf("@");
  const user = at < 0 ? jid : jid.slice(0, at);
  const dash = user.indexOf("-");
  if (dash < 0) return jid;
  // `jid.slice(at)` with at === -1 is slice(-1) - the LAST character, silently
  // duplicated onto the end. Only re-attach a domain that exists.
  return (
    maskNumber(user.slice(0, dash)) +
    user.slice(dash) +
    (at < 0 ? "" : jid.slice(at))
  );
}

// Same rule for anything written to the diagnostic log, which is a file on
// disk that outlives the session and is read long after the fact.
//
// A group, broadcast list or newsletter JID names a CHANNEL, not a person:
// the id is not a phone number, and it is the handle that makes an outage
// diagnosable at all (a group going silent was undiagnosable for 20h - see
// server.ts's own note). Those keep their identifying form, but through
// groupAnchor, because the LEGACY `<creator-number>-<created-at>` form is
// used by both @g.us and @broadcast and does carry a real number.
// @s.whatsapp.net and @lid are a person by definition and are masked outright.
export function maskJid(jid: string): string {
  const s = String(jid ?? "");
  return /@(g\.us|broadcast|newsletter)$/.test(s)
    ? groupAnchor(s)
    : maskNumber(s);
}

// A "name" that's actually just a phone number in disguise defeats any
// caller that must never show a raw number: WhatsApp's own self-reported
// `.notify` commonly defaults to exactly this for anyone who hasn't set a
// custom display name, so contactName()'s permissive name-or-notify
// fallback (fine for convenience labeling elsewhere) can hand back a real
// number to a caller that thought it was getting a name. A caller with
// that guarantee to keep should treat a number-shaped result as no name
// at all and mask it instead.
//
// Checks for a number-shaped run ANYWHERE in the string, not just when the
// whole thing is one - a `.notify` like "call 0403911675" or "WhatsApp:
// 0403 911 675" still leaks the embedded number if only a whole-string
// match were checked. A run needs at least 6 real digits to count: long
// enough to be a phone-number fragment, short enough that "Room 42" or
// "Team7" don't false-positive.
export function looksLikeNumber(s: string): boolean {
  const runs = s.match(/\d[\d\s()-]{3,}\d/g) ?? [];
  return runs.some((run) => (run.match(/\d/g)?.length ?? 0) >= 6);
}
