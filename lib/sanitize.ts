// Everything the model reads from WhatsApp arrives inside a
// `<channel source="whatsapp" user="…" …>` envelope, and three of the fields
// that envelope is built from are set by whoever is on the other end: a
// sender's pushName, a contact's self-reported `.notify`, and a group
// admin's subject. Split out of server.ts so the rules are testable without
// its connect-on-import side effects; every rendered surface in that file
// routes through one of these.

/** Strips the characters that would break the `<channel …>` envelope out of
 *  a display string. Undefined in, undefined out, so a caller can keep its
 *  own "no name" fallback. */
export function safeName(s: string | undefined | null): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, "_");
}

// pushName is profile text the SENDER sets, and it lands in the `user=`
// attribute of the <channel …> envelope and in the message log. Unsanitized it
// can close that attribute or the tag itself. Whitespace-only or absent is no
// name at all — fall back to the phone-part, which is what server.ts already
// uses when pushName is missing. A name made only of stripped characters comes
// back as underscores and does NOT reach that fallback: safeName substitutes
// "_", never "".
export function displaySenderName(
  pushName: string | undefined | null,
  senderJid: string,
): string {
  return safeName(pushName)?.trim() || senderJid.split("@")[0];
}

// Envelope integrity, NOT general escaping. Message bodies reach the model
// inside <channel source="whatsapp" …>, so a body containing the literal
// "</channel" could close that tag early — everything after it would then read
// as the session's own text instead of as quoted, untrusted chat. Only those
// two sequences are neutralized; `<` and `>` everywhere else are left exactly
// as typed, because people legitimately send code and the body is already
// understood to be untrusted input. The zero-width space renders identically
// to the sender's original while making the tag inert; the replacement is a
// literal, so a tag the sender typed in caps also comes back lowercased, which
// is the one visible difference.
export function neutralizeChannelTag(s: string): string {
  return s.replace(/<(\/?)channel/gi, "<\u200B$1channel");
}
