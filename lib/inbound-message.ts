// Reading an inbound message's body and its @-mentions. These two live in one
// file, next to each other, because they must cover the SAME set of message
// variants: extractMentions used to read only extendedTextMessage, so in a
// requireMention group a photo captioned "@claude look" had its body read and
// its mention ignored, and the message was dropped with no trace. Fails
// closed, silently — the worst shape a bug can take here.
//
// Typed structurally rather than against proto.IMessage so this is unit
// testable without pulling in Baileys (and, through server.ts, its
// connect-on-import side effects) — same reason lib/mentions.ts exists.

type MentionContext = {
  mentionedJid?: (string | null)[] | null;
} | null;

type CaptionedPart = {
  caption?: string | null;
  contextInfo?: MentionContext;
} | null;

type ExtendedTextPart = {
  text?: string | null;
  contextInfo?: MentionContext;
} | null;

export type InboundMessage =
  | {
      conversation?: string | null;
      extendedTextMessage?: ExtendedTextPart;
      imageMessage?: CaptionedPart;
      videoMessage?: CaptionedPart;
      documentMessage?: CaptionedPart;
    }
  | null
  | undefined;

export function extractText(msg: InboundMessage): string {
  if (!msg) return "";
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    msg.documentMessage?.caption ??
    ""
  );
}

// Deduped: the same jid can appear on more than one carrier in a forwarded or
// re-uploaded message, and every caller treats this as a set.
export function extractMentions(msg: InboundMessage): string[] {
  if (!msg) return [];
  const out: string[] = [];
  // Keep this list in step with extractText's above. `conversation` is a bare
  // string with no contextInfo, so it has nothing to contribute.
  const carriers = [
    msg.extendedTextMessage,
    msg.imageMessage,
    msg.videoMessage,
    msg.documentMessage,
  ];
  for (const carrier of carriers) {
    for (const jid of carrier?.contextInfo?.mentionedJid ?? []) {
      if (typeof jid === "string" && jid) out.push(jid);
    }
  }
  return [...new Set(out)];
}
