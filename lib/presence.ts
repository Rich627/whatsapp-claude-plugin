// "typing…" and "recording audio…" in a chat while the agent works on it.
//
// WhatsApp clears a chat-state (composing / recording) by itself about 10
// seconds after the last one it received, so a single update at pickup shows
// "typing…" for a moment and then nothing while the agent spends minutes on
// the answer. TypingIndicator re-sends the state on an interval until the
// agent replies to that chat, or until a cap runs out so a message the agent
// never answers does not leave "typing…" up forever. Timers and the send are
// injected, so the rules are testable without server.ts's connect-on-import
// side effects.

export type PresenceState = "composing" | "recording" | "paused";

// Under WhatsApp's ~10s expiry, so the state never lapses between refreshes.
export const TYPING_REFRESH_MS = 8_000;
export const DEFAULT_TYPING_MAX_MINUTES = 10;
export const MAX_TYPING_MAX_MINUTES = 60;

/** WHATSAPP_TYPING_MAX_MINUTES: how long "typing…" may stay up for one chat.
 *  Unset or not a number -> the 10-minute default; 0 (or less) -> 0, which
 *  turns the kept-up indicator off; above 60 -> 60. `note` says what was done
 *  with a value that was not used as given, for diag.log. */
export function parseTypingMaxMinutes(raw: string | undefined): {
  ms: number;
  note?: string;
} {
  const fallback = DEFAULT_TYPING_MAX_MINUTES * 60_000;
  if (raw === undefined || raw.trim() === "") return { ms: fallback };
  const minutes = Number(raw.trim());
  if (!Number.isFinite(minutes))
    return {
      ms: fallback,
      note: `WHATSAPP_TYPING_MAX_MINUTES=${JSON.stringify(raw)} is not a number; using ${DEFAULT_TYPING_MAX_MINUTES}`,
    };
  if (minutes <= 0) return { ms: 0 };
  if (minutes > MAX_TYPING_MAX_MINUTES)
    return {
      ms: MAX_TYPING_MAX_MINUTES * 60_000,
      note: `WHATSAPP_TYPING_MAX_MINUTES=${raw.trim()} is above ${MAX_TYPING_MAX_MINUTES}; using ${MAX_TYPING_MAX_MINUTES}`,
    };
  return { ms: Math.round(minutes * 60_000) };
}

export interface PresenceDeps {
  /** Fire-and-forget: a failed presence update must never fail anything. */
  send(chat: string, state: PresenceState): void;
  now(): number;
  /** Runs fn every ms; returns the function that stops it. */
  every(fn: () => void, ms: number): () => void;
  /** Two spellings of one chat (a DM's @lid and phone forms) map to one key,
   *  so the reply that ends "typing…" finds the loop the inbound started. */
  keyOf?(chat: string): string;
}

type Active = {
  /** The key it is stored under: fixed when the loop starts, moved only by
   *  find() when the chat's identity mapping changes. */
  key: string;
  jid: string;
  state: "composing" | "recording";
  since: number;
  /** Which start()/set() call last (re)started it; see generation(). */
  gen: number;
  cancel: () => void;
};

export class TypingIndicator {
  private readonly active = new Map<string, Active>();
  private readonly keyOf: (chat: string) => string;
  private seq = 0;

  constructor(
    private readonly deps: PresenceDeps,
    private readonly opts: { refreshMs: number; maxMs: number },
  ) {
    this.keyOf = deps.keyOf ?? ((chat) => chat);
  }

  /** A counter that grows with every start()/set(). Take it before a reply
   *  goes out and pass it to stop(), so only the indicator that reply
   *  answers is taken down, not one an inbound message started meanwhile. */
  generation(): number {
    return this.seq;
  }

  /** An inbound message from this chat was handed to the agent. */
  start(chat: string): number {
    return this.set(chat, "composing");
  }

  /** Shows `state` in the chat and keeps it up until stop() or the cap. A
   *  repeat call switches the state and restarts the cap. With the cap at 0
   *  the state is sent once and WhatsApp clears it by itself. Returns this
   *  call's generation. */
  set(chat: string, state: PresenceState): number {
    if (state === "paused") {
      this.stop(chat, true);
      return this.seq;
    }
    const gen = ++this.seq;
    this.deps.send(chat, state);
    if (this.opts.maxMs <= 0) return gen;
    const now = this.deps.now();
    const existing = this.find(chat);
    if (existing) {
      existing.jid = chat;
      existing.state = state;
      existing.since = now;
      existing.gen = gen;
      return gen;
    }
    const key = this.keyOf(chat);
    const entry: Active = {
      key,
      jid: chat,
      state,
      since: now,
      gen,
      cancel: () => {},
    };
    entry.cancel = this.deps.every(() => this.tick(entry), this.opts.refreshMs);
    this.active.set(key, entry);
    return gen;
  }

  /** The agent answered this chat (or gave up): clear the indicator. Sends
   *  "paused" only when one was up, unless `force` (a manual request).
   *  With `upTo` (a generation()/set() value taken before the answer), an
   *  indicator restarted after that point is left up: it belongs to a newer
   *  inbound message this answer does not cover. */
  stop(chat: string, force = false, upTo?: number): void {
    const entry = this.find(chat);
    if (entry) {
      if (upTo !== undefined && entry.gen > upTo) return;
      this.remove(entry);
      this.deps.send(entry.jid, "paused");
    } else if (force) {
      this.deps.send(chat, "paused");
    }
  }

  isActive(chat: string): boolean {
    return this.find(chat) !== undefined;
  }

  /** The entry for this chat. keyOf can change for a chat that is already
   *  up (an @lid learns its phone number), so a miss under the current key
   *  also looks for an entry stored under the earlier one and moves it. */
  private find(chat: string): Active | undefined {
    const key = this.keyOf(chat);
    const hit = this.active.get(key);
    if (hit) return hit;
    for (const entry of this.active.values()) {
      if (entry.jid === chat || this.keyOf(entry.jid) === key) {
        this.active.delete(entry.key);
        entry.key = key;
        this.active.set(key, entry);
        return entry;
      }
    }
    return undefined;
  }

  private remove(entry: Active): void {
    entry.cancel();
    if (this.active.get(entry.key) === entry) this.active.delete(entry.key);
  }

  private tick(entry: Active): void {
    if (this.active.get(entry.key) !== entry) return;
    if (this.deps.now() - entry.since >= this.opts.maxMs) {
      this.remove(entry);
      this.deps.send(entry.jid, "paused");
      return;
    }
    this.deps.send(entry.jid, entry.state);
  }
}
