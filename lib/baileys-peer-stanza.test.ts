import { describe, expect, test } from "bun:test";
// Deep import on purpose: this pins the behaviour of the Baileys version in
// package.json, not anything this plugin wraps.
import { decodeMessageNode } from "@whiskeysockets/baileys/lib/Utils/decode-wa-message.js";

// Why the pin is rc14 and not rc12. On a fresh link the phone sends this
// device its history-sync notification and its app-state sync keys as peer
// stanzas: `from` is our own account and there is NO `recipient` attribute.
// rc12 left fromMe false for that shape, and its own self-only guard in
// process-message.js then dropped every one as "spoofed" - so no app-state
// keys, no contact sync, and contacts.json never got a saved name. rc14
// marks them fromMe. Downgrade the pin and this goes red.
const ME = "15550001111:7@s.whatsapp.net";
const ME_LID = "99990000111122:7@lid";

const stanza = (attrs: Record<string, string>) =>
  ({ tag: "message", attrs: { id: "ABC123", t: "1", ...attrs } }) as any;

describe("Baileys marks the phone's own peer stanzas as fromMe", () => {
  test("from our own number, no recipient", () => {
    const { fullMessage } = decodeMessageNode(
      stanza({ from: "15550001111@s.whatsapp.net" }),
      ME,
      ME_LID,
    );
    expect(fullMessage.key.fromMe).toBe(true);
  });

  test("from our own LID, no recipient", () => {
    const { fullMessage } = decodeMessageNode(
      stanza({ from: "99990000111122@lid" }),
      ME,
      ME_LID,
    );
    expect(fullMessage.key.fromMe).toBe(true);
  });

  // Positive control: the same shape from anyone else must stay not-fromMe,
  // or the self-only guard this depends on would wave a stranger through.
  test("from someone else, no recipient", () => {
    const { fullMessage } = decodeMessageNode(
      stanza({ from: "15552223333@s.whatsapp.net" }),
      ME,
      ME_LID,
    );
    expect(fullMessage.key.fromMe).toBe(false);
  });
});
