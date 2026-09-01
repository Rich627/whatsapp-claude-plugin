// `access.owner` is the single chat a permission request is delivered to and
// therefore the only chat allowed to answer it. Both halves of that live here
// — which jid gets stamped, and what counts as a typed approval — so they are
// testable without server.ts's connect-on-import side effects.

/** Which jid to store in `access.owner`, given what is already stored, the
 *  allowlist as it stood BEFORE this connect's owner auto-add, and the account
 *  this device is linked to. Returns the value to persist, or `current`
 *  unchanged when nothing should be written.
 *
 *  Two rules, both deliberate:
 *
 *  1. An existing value is never overwritten. A dedicated-bot-number setup (a
 *     second SIM running the agent, the human's own number in allowFrom) has
 *     to be able to point approvals at the human, and re-stamping on every
 *     connect made that impossible — the value came back on the next reconnect
 *     and permission requests went to the bot's own note-to-self, which nobody
 *     reads. `/whatsapp-channel:access set owner <jid>` is the way to set it.
 *
 *  2. On an install that already had an allowlist, the first stamp preserves
 *     allowFrom[0] — the target that install has been using all along — rather
 *     than silently redirecting it to the linked account. Only a fresh install
 *     (nothing allowlisted yet) stamps the linked account, which is where
 *     insertion order was never ownership in the first place. The migration
 *     therefore changes nobody's delivery chat; `access status` prints the
 *     target so a wrong one is visible instead of silent. */
export function ownerStamp(
  current: string | undefined,
  priorAllowFrom: readonly string[],
  linkedJid: string,
): string | undefined {
  // Empty string counts as absent: it is what a hand-edit that meant "clear
  // this" leaves behind, and permissionTarget's `??` would step over it into
  // the allowFrom[0] fallback anyway.
  if (current) return current;
  if (!linkedJid) return current;
  return priorAllowFrom[0] ?? linkedJid;
}

/** Permission-reply spec — 5 lowercase letters a-z minus 'l'. Case-insensitive. */
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

export type PermissionReply = {
  requestId: string;
  behavior: "allow" | "deny";
};

/** Null for anything that is not exactly a permission answer. The pattern is
 *  reachable by ordinary chat, so a match here is only a candidate — the
 *  caller still has to find that request id outstanding in that same chat
 *  before treating the message as an approval rather than as text. */
export function parsePermissionReply(text: string): PermissionReply | null {
  const m = PERMISSION_REPLY_RE.exec(text);
  if (!m) return null;
  return {
    requestId: m[2]!.toLowerCase(),
    behavior: m[1]!.toLowerCase().startsWith("y") ? "allow" : "deny",
  };
}
