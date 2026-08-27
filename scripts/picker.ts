// The one-screen access picker (T17): a raw-mode terminal UI that replaces
// the wizard's old prompt-per-kind sequence. Pure core (state machine +
// layout) plus one thin IO wrapper (runPicker) - the pure half has no file,
// network or process.env access (the `color` decision is made by the caller
// and passed in on the model), so every keystroke and every drawn frame is
// testable without a terminal.
//
// Must never import "./access" - access.ts's top-level switch executes on
// import (see its own file header), so picker.ts only depends on plain
// types/values, never on access.ts. Dependency direction is one-way:
// access.ts -> picker.ts.

import { stripVTControlCharacters } from "node:util";

export type PickerItem = {
  jid: string; // never drawn - only returned in the result
  label: string; // ranking.ts's label, already through formatLabel()
  kind: "group" | "dm";
  granted: boolean; // on access.json BEFORE this run -> starts ticked
  roster: boolean; // groups: current roster flag (display + result)
};

export type PickerModel = {
  dms: PickerItem[]; // CONTACTS column, configured first then ranked candidates
  groups: PickerItem[]; // GROUPS column, same order rule
  dmNote: string; // drawn only when the dms column is empty ("" = draw "(none)")
  groupNote: string;
  hasBackup: boolean; // access.json.bak exists -> Restore is live, else greyed
  color: boolean; // caller's decision: stdout.isTTY && !NO_COLOR
};

export type UndoEntry = { kind: "tick" | "roster"; jid: string };

export type PickerState = {
  model: PickerModel;
  search: string;
  focus: "dms" | "groups" | "search";
  lastColumn: "dms" | "groups"; // where ↓ from the search line returns
  cursor: { dms: number; groups: number }; // index into the FILTERED list of that column
  ticked: Set<string>; // jids ticked right now
  roster: Set<string>; // group jids flagged [r] (this run's NEW flags only)
  chips: string[]; // jids whose tick differs from `granted`, oldest first
  undo: UndoEntry[]; // every reversible action, newest last
  cols: number;
  rows: number;
  done: null | "submit" | "cancel" | "restore";
};

export type PickerEvent =
  | { type: "char"; ch: string }
  | { type: "backspace" }
  | { type: "up" }
  | { type: "down" }
  | { type: "tab" }
  | { type: "space" }
  | { type: "enter" }
  | { type: "esc" }
  | { type: "undo" }
  | { type: "restore" }
  | { type: "submit" }
  | { type: "cancel" }
  | { type: "focus"; column: "dms" | "groups"; index: number } // mouse: move cursor to an exact row
  | { type: "focusSearch" } // mouse only: a click on the search line
  | { type: "unchip"; jid: string } // mouse: click a chip's ×
  | { type: "click"; row: number; col: number } // 0-based, screen coords
  | { type: "resize"; cols: number; rows: number };

export type Selection = {
  groups: Set<string>;
  dms: Set<string>;
  roster: Set<string>;
};

export type PickerResult =
  ({ action: "submit" } & Selection) | { action: "restore" } | null; // esc / ctrl-c: nothing was decided

// -----------------------------------------------------------------------
// 2.3 formatLabel - the security-surface function
// -----------------------------------------------------------------------

// Self-reported names are attacker-chosen. A raw ESC in a group name would
// move the cursor, repaint the footer or forge a tick; a bidi override
// reverses the visible order of a name. Strip both before anything reaches
// the draw path. Applied at model build time AND again when a chip/row is
// rendered, so no future caller can forget it.
const UNSAFE =
  /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
export function formatLabel(raw: string): string {
  return raw.replace(UNSAFE, "").replace(/\s+/g, " ").trim();
}

// Module level - constructing a Segmenter per call is the slow path.
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(s: string): string[] {
  return [...SEGMENTER.segment(s)].map((seg) => seg.segment);
}

// Cell width decided on the grapheme's first code point: marks and format
// characters (ZWJ, variation selectors) take no cell, CJK/Hangul/kana and
// presentation emoji take two, everything else one.
// ponytail: unicode-property heuristic, not East_Asian_Width (JS has no
// \p{EAW}); fullwidth ASCII (FF01-FF60) counts 1 and regional-indicator
// flags count 1 - swap in a real EAW table if a terminal ever overlaps.
const ZERO_WIDTH = /^[\p{M}\p{Cf}]/u;
const WIDE =
  /^(?!\p{Regional_Indicator})[\p{Ideographic}\p{sc=Hangul}\p{sc=Hiragana}\p{sc=Katakana}\p{Emoji_Presentation}]/u;
function cellWidth(g: string): number {
  if (ZERO_WIDTH.test(g)) return 0;
  return WIDE.test(g) ? 2 : 1;
}

// The number of terminal cells `s` occupies.
export function displayWidth(s: string): number {
  return graphemes(s).reduce((sum, g) => sum + cellWidth(g), 0);
}

// Longest grapheme prefix of `s` whose total cell width is <= w. Stops
// BEFORE a grapheme that would straddle the budget, so it can return a
// string one cell short of `w`; returns "" when the first grapheme alone is
// wider than `w`.
function takeWidth(s: string, w: number): string {
  let used = 0;
  let out = "";
  for (const g of graphemes(s)) {
    const cw = cellWidth(g);
    if (used + cw > w) break;
    out += g;
    used += cw;
  }
  return out;
}

// Truncation everywhere in this file measures display cells, never
// `.length`, so a wide grapheme (CJK, emoji) is never split and never
// overflows its column. Ellipsis is "…", matching ranking.ts's clip().
export function truncate(s: string, w: number): string {
  if (w <= 0) return "";
  if (displayWidth(s) <= w) return s;
  return takeWidth(s, w - 1) + "…";
}

// Greedy word wrap on spaces. A single word wider than `w` gets its own
// line and is truncated where it is drawn (renderColumn).
function wrap(text: string, w: number): string[] {
  const words = text.split(" ").filter((w2) => w2.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (cur && displayWidth(candidate) > w) {
      lines.push(cur);
      cur = word;
    } else {
      cur = candidate;
    }
  }
  lines.push(cur);
  return lines;
}

// -----------------------------------------------------------------------
// 2.4 Filtering
// -----------------------------------------------------------------------

// Label only, case-insensitive, plain `includes`, never a RegExp built from
// the term (same rule as ranking.ts's filterCandidates, and the same
// reason). NOT filterCandidates itself: it also matches `description`,
// which is the group JID and the masked number - filtering by number is
// explicitly out of scope for T17 and a JID must not be reachable from this
// screen at all.
export function visibleItems(
  state: PickerState,
  column: "dms" | "groups",
): PickerItem[] {
  const needle = state.search.trim().toLowerCase();
  const items = state.model[column];
  if (!needle) return [...items];
  return items.filter((i) => i.label.toLowerCase().includes(needle));
}

function findItem(model: PickerModel, jid: string): PickerItem {
  return (
    model.dms.find((i) => i.jid === jid) ??
    model.groups.find((i) => i.jid === jid)!
  );
}

export function initPicker(
  model: PickerModel,
  cols: number,
  rows: number,
): PickerState {
  const ticked = new Set<string>();
  for (const item of model.dms) if (item.granted) ticked.add(item.jid);
  for (const item of model.groups) if (item.granted) ticked.add(item.jid);
  return {
    model,
    search: "",
    focus: "dms",
    lastColumn: "dms",
    cursor: { dms: 0, groups: 0 },
    ticked,
    roster: new Set(),
    chips: [],
    undo: [],
    cols,
    rows,
    done: null,
  };
}

export function chipsOf(
  state: PickerState,
): { jid: string; label: string; struck: boolean }[] {
  return state.chips.map((jid) => {
    const item = findItem(state.model, jid);
    return {
      jid,
      label: formatLabel(item.label),
      struck: !state.ticked.has(jid),
    };
  });
}

export function selectionOf(state: PickerState): Selection {
  const groups = new Set<string>();
  const dms = new Set<string>();
  for (const jid of state.ticked) {
    const item = findItem(state.model, jid);
    if (item.kind === "group") groups.add(jid);
    else dms.add(jid);
  }
  const roster = new Set([...state.roster].filter((jid) => groups.has(jid)));
  return { groups, dms, roster };
}

// -----------------------------------------------------------------------
// 2.5 reducePicker - the state machine
// -----------------------------------------------------------------------

// Flip `ticked`, then reconcile chips: if the new tick state differs from
// `granted` and jid is not already in chips, append it; if it now equals
// `granted`, remove it from chips. Pushes a "tick" undo entry. Shared by
// space/enter/backspace-pop/unchip so the chip bookkeeping cannot drift.
function toggled(set: Set<string>, v: string): Set<string> {
  const out = new Set(set);
  if (!out.delete(v)) out.add(v);
  return out;
}

function toggleTick(state: PickerState, jid: string): PickerState {
  const item = findItem(state.model, jid);
  const ticked = toggled(state.ticked, jid);
  let chips = state.chips;
  const differs = ticked.has(jid) !== item.granted;
  const inChips = chips.includes(jid);
  if (differs && !inChips) chips = [...chips, jid];
  else if (!differs && inChips) chips = chips.filter((j) => j !== jid);
  return {
    ...state,
    ticked,
    chips,
    undo: [...state.undo, { kind: "tick", jid }],
  };
}

// Enter-with-search: force ON, never toggles an already-ticked row off, and
// pushes no chip/undo entry when it was already ticked.
function forceTick(state: PickerState, jid: string): PickerState {
  if (state.ticked.has(jid)) return state;
  return toggleTick(state, jid);
}

// The column the cursor lives in. While the caret is on the search line the
// cursor still belongs to the column ↓ will return to.
function focusedColumn(state: PickerState): "dms" | "groups" {
  return state.focus === "search" ? state.lastColumn : state.focus;
}

// The row Enter ticks while the caret is on the search line: the first
// visible Contacts row, else the first visible Groups row, else nothing.
// Null unless the caret is on the search line with a non-empty filter (an
// empty search submits). One function feeds BOTH the reducer and the marker
// in render(), so the screen can never promise one row and tick another.
function enterTarget(state: PickerState): "dms" | "groups" | null {
  if (state.focus !== "search" || state.search === "") return null;
  if (visibleItems(state, "dms").length > 0) return "dms";
  if (visibleItems(state, "groups").length > 0) return "groups";
  return null;
}

function highlighted(state: PickerState): PickerItem | null {
  // The SAME target the marker is drawn on: with the caret in the search
  // line and a filter typed, that is enterTarget's column, not the column
  // that was focused before typing - otherwise Space could tick a row the
  // screen never marked (review finding on aab1036).
  const target = enterTarget(state);
  const column = target ?? focusedColumn(state);
  const visible = visibleItems(state, column);
  // ...and the same ROW: the marker sits on row 0 of the target column
  // while the caret is in the search line, whatever the column's cursor is.
  const idx = target ? 0 : state.cursor[column];
  return visible[idx] ?? null;
}

function clampCursor(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function resetSearch(state: PickerState, search: string): PickerState {
  return {
    ...state,
    search,
    cursor: { dms: 0, groups: 0 },
  };
}

export function reducePicker(
  state: PickerState,
  event: PickerEvent,
): PickerState {
  switch (event.type) {
    case "char": {
      if (event.ch === "r" && state.search === "" && state.focus !== "search") {
        const item = highlighted(state);
        if (
          !item ||
          item.kind !== "group" ||
          !state.ticked.has(item.jid) ||
          item.granted
        ) {
          return state; // [D2]: not a ticked, not-yet-granted group -> no-op
        }
        return {
          ...state,
          roster: toggled(state.roster, item.jid),
          undo: [...state.undo, { kind: "roster", jid: item.jid }],
        };
      }
      // Typing always snaps the caret to the search line, whether it
      // started there or on a column - the roster shortcut above is the
      // only case where a column-focused keystroke isn't a filter char.
      return {
        ...resetSearch(state, state.search + event.ch),
        focus: "search",
      };
    }

    case "backspace": {
      if (state.search !== "") {
        const chars = [...state.search];
        return resetSearch(state, chars.slice(0, -1).join(""));
      }
      const last = state.chips.at(-1);
      if (last === undefined) return state;
      return toggleTick(state, last);
    }

    case "up": {
      if (state.focus === "search") return state;
      const column = state.focus;
      const visible = visibleItems(state, column);
      const c = state.cursor[column];
      if (visible.length === 0 || c === 0) {
        return { ...state, focus: "search", lastColumn: column };
      }
      return { ...state, cursor: { ...state.cursor, [column]: c - 1 } };
    }

    case "down": {
      if (state.focus === "search") {
        return {
          ...state,
          focus: state.lastColumn,
          cursor: { ...state.cursor, [state.lastColumn]: 0 },
        };
      }
      const column = state.focus;
      const visible = visibleItems(state, column);
      if (visible.length === 0) return state;
      const next = clampCursor(state.cursor[column] + 1, visible.length);
      if (next === state.cursor[column]) return state;
      return { ...state, cursor: { ...state.cursor, [column]: next } };
    }

    case "tab": {
      if (state.focus === "search") {
        return { ...state, focus: "dms", lastColumn: "dms" };
      }
      if (state.focus === "dms") {
        return { ...state, focus: "groups", lastColumn: "groups" };
      }
      return { ...state, focus: "search" }; // lastColumn stays "groups"
    }

    case "space": {
      // Mid-search, a space is part of the name being typed ("John Smith"),
      // never a tick - a tick from the search line is Enter.
      if (state.focus === "search" && state.search.length > 0) {
        return reducePicker(state, { type: "char", ch: " " });
      }
      const item = highlighted(state);
      if (!item) return state;
      return toggleTick(state, item.jid);
    }

    case "enter": {
      if (state.search === "") return { ...state, done: "submit" };
      // highlighted() already resolves the search-line case to enterTarget's
      // row 0, so one path covers both the caret-in-search and column cases.
      const item = highlighted(state);
      return resetSearch(item ? forceTick(state, item.jid) : state, "");
    }

    case "esc": {
      if (state.search !== "") return resetSearch(state, "");
      return { ...state, done: "cancel" };
    }

    case "cancel":
      return { ...state, done: "cancel" };

    case "submit":
      return { ...state, done: "submit" };

    case "undo": {
      const entry = state.undo.at(-1);
      if (!entry) return state;
      const undo = state.undo.slice(0, -1);
      if (entry.kind === "roster") {
        return { ...state, roster: toggled(state.roster, entry.jid), undo };
      }
      // A tick undo is the same flip as a tick, minus the undo push.
      return { ...toggleTick(state, entry.jid), undo };
    }

    case "restore":
      if (!state.model.hasBackup) return state; // greyed = literally inert
      return { ...state, done: "restore" };

    case "focus": {
      const visible = visibleItems(state, event.column);
      const index = clampCursor(event.index, visible.length);
      return {
        ...state,
        focus: event.column,
        lastColumn: event.column,
        cursor: { ...state.cursor, [event.column]: index },
      };
    }

    case "focusSearch":
      return { ...state, focus: "search" };

    case "unchip": {
      if (!state.chips.includes(event.jid)) return state;
      return toggleTick(state, event.jid);
    }

    case "click": {
      const hit = hitTest(state, state.cols, state.rows, event.row, event.col);
      if (!hit) return state;
      let next = reducePicker(state, hit);
      // "click a row = that row toggles and becomes the cursor": one click
      // both moves focus/cursor (via the `focus` event hitTest returned)
      // and toggles the tick, in that order.
      if (hit.type === "focus") next = reducePicker(next, { type: "space" });
      return next;
    }

    case "resize":
      return { ...state, cols: event.cols, rows: event.rows };
  }
}

// -----------------------------------------------------------------------
// 2.7 decodeInput - pure byte -> event decoder
// -----------------------------------------------------------------------

// [D4] Deviation from the brief's "node:readline emitKeypressEvents": mouse
// SGR sequences and keypresses arrive on the SAME stream, and emitKeys has
// no notion of `\x1b[<...M`, so decoding in one pure function keeps a single
// code path instead of two data listeners fighting over ordering. See the
// spec (.pipeline/spec.md section 2.7) for the full rationale.
//
// Known limitation, not fixed here: a lone `\x1b` (or an incomplete `\x1b[`
// sequence) that arrives at the END of a chunk is resolved immediately
// rather than waiting for the rest of the sequence in the next chunk, so a
// terminal that splits an arrow key across two reads could see a spurious
// `esc` (or nothing, for a split mouse sequence). `ponytail:` chunk-local
// decode; add a carry buffer in runPicker if a real terminal splits
// sequences.
const KEYS: Record<string, PickerEvent> = {
  "\x03": { type: "cancel" },
  "\r": { type: "enter" },
  "\n": { type: "enter" },
  "\t": { type: "tab" },
  "\x7f": { type: "backspace" },
  "\x08": { type: "backspace" },
  " ": { type: "space" },
  "\x1a": { type: "undo" },
  "\x12": { type: "restore" },
};
// Final byte of a bare CSI (ESC [ X) or SS3 (ESC O X) arrow sequence.
const SEQ: Record<string, PickerEvent> = {
  A: { type: "up" },
  B: { type: "down" },
  C: { type: "tab" },
  D: { type: "tab" },
  Z: { type: "tab" },
};

export function decodeInput(chunk: string): PickerEvent[] {
  const events: PickerEvent[] = [];
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i];
    const key = KEYS[ch];
    if (key) {
      events.push(key);
      i++;
      continue;
    }
    if (ch === "\x1b") {
      if (chunk[i + 1] === "O") {
        // An incomplete SS3 at the end of the chunk is skipped (same known
        // limitation as an incomplete CSI below); any other final byte too.
        const ev = SEQ[chunk[i + 2] ?? ""];
        if (ev) events.push(ev);
        i += 3;
        continue;
      }
      if (chunk[i + 1] !== "[") {
        events.push({ type: "esc" });
        i++;
        continue;
      }
      let j = i + 2;
      while (j < chunk.length && !/[\x40-\x7e]/.test(chunk[j])) j++;
      if (j >= chunk.length) {
        // Incomplete escape sequence at the end of the chunk - see the
        // known-limitation comment above. Skipped, not misfired.
        i = chunk.length;
        continue;
      }
      const final = chunk[j];
      const body = chunk.slice(i + 2, j);
      const ev = body === "" ? SEQ[final] : undefined;
      if (ev) events.push(ev);
      else if (body.startsWith("<") && final === "M") {
        // SGR mouse press; release ("m") and wheel (b >= 64) -> nothing.
        const [b, x, y] = body.slice(1).split(";").map(Number);
        if (b === 0) events.push({ type: "click", row: y - 1, col: x - 1 });
      }
      // any other \x1b[... -> nothing (skipped)
      i = j + 1;
      continue;
    }
    const code = chunk.codePointAt(i)!;
    if (code >= 0x20 && !(code >= 0x7f && code <= 0x9f)) {
      const char = String.fromCodePoint(code);
      events.push({ type: "char", ch: char });
      i += char.length;
      continue;
    }
    // any other control byte -> nothing
    i++;
  }
  return events;
}

// -----------------------------------------------------------------------
// 2.6 layout / hitTest - shared rendering geometry
// -----------------------------------------------------------------------

const sgr = (code: string) => (s: string, color: boolean) =>
  color ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = sgr("2");
const strike = sgr("9");
const green = sgr("32");
const accent = sgr("1;32");

function padVisible(s: string, width: number): string {
  const visLen = displayWidth(stripVTControlCharacters(s));
  return visLen >= width ? s : s + " ".repeat(width - visLen);
}

// startCol/endCol carry the column's screen x-range so hitTest can tell
// which column a click landed in - both columns share every body row in
// the two-column form, so row alone is ambiguous (review finding 2).
type ItemRow = {
  row: number;
  column: "dms" | "groups";
  index: number;
  startCol: number;
  endCol: number;
};
type ChipRange = { row: number; col: number; jid: string };
type FooterRange = {
  row: number;
  action: "submit" | "undo" | "restore";
  start: number;
  end: number;
};

type Geometry = {
  itemRows: ItemRow[];
  chipRanges: ChipRange[];
  footerRanges: FooterRange[];
  searchRow: number;
};

function renderColumn(
  visible: PickerItem[],
  cursorIdx: number,
  focused: boolean,
  ticked: Set<string>,
  rosterSet: Set<string>,
  note: string,
  w: number,
  bodyRows: number,
  color: boolean,
): { lines: string[]; rowIndex: (number | null)[] } {
  const lines: string[] = [];
  const rowIndex: (number | null)[] = [];
  if (visible.length === 0) {
    const wrapped = wrap(note.trim() ? note : "(none)", w);
    for (let i = 0; i < bodyRows; i++) {
      lines.push(dim(truncate(wrapped[i] ?? "", w), color));
      rowIndex.push(null);
    }
    return { lines, rowIndex };
  }
  // Decide the slot count FIRST (does the whole list fit, or does a
  // trailing "... +N more" line have to eat one row?), then derive the
  // scroll offset from THAT slot count - deriving offset from bodyRows and
  // only then shrinking to itemSlots left the cursor's window position
  // computed against a row count one bigger than what actually gets drawn,
  // so the cursor sat permanently one row below the last drawn row for
  // almost the whole scroll range (review finding 1).
  // A one-row body keeps its one item row: a "+N more" line that replaces
  // the only item would draw a column with nothing in it (review finding 11).
  const slots =
    visible.length > bodyRows && bodyRows > 1 ? bodyRows - 1 : bodyRows;
  const offset = cursorIdx < slots ? 0 : cursorIdx - slots + 1;
  const overflow = visible.length > offset + slots;
  for (let i = 0; i < slots && offset + i < visible.length; i++) {
    const idx = offset + i;
    const item = visible[idx];
    const marker = focused && idx === cursorIdx ? ">" : " ";
    const isTicked = ticked.has(item.jid);
    const box = isTicked ? "[x]" : "[ ]";
    const coloredBox = isTicked ? green(box, color) : box;
    let plainTag = "";
    if (item.kind === "group" && isTicked) {
      const flagged = item.granted ? item.roster : rosterSet.has(item.jid);
      if (flagged) plainTag = "  [r]";
    }
    const displayedTag =
      plainTag && item.granted ? dim(plainTag, color) : plainTag;
    const labelW = Math.max(0, w - 5 - displayWidth(plainTag));
    const label = truncate(formatLabel(item.label), labelW);
    lines.push(`${marker}${coloredBox} ${label}${displayedTag}`);
    rowIndex.push(idx);
  }
  while (lines.length < slots) {
    lines.push("");
    rowIndex.push(null);
  }
  // The more-line only when a row was actually reserved for it.
  if (overflow && slots < bodyRows) {
    const more = visible.length - (offset + slots);
    lines.push(dim(`… +${more} more`, color));
    rowIndex.push(null);
  }
  while (lines.length < bodyRows) {
    lines.push("");
    rowIndex.push(null);
  }
  return { lines, rowIndex };
}

// Newest-first until the line is full, then reversed; dropped older chips
// become a leading dim "+N more". A single chip's label is capped so one
// long name can never alone blow the whole picked line past its budget.
const CHIP_LABEL_CAP = 24;
function renderChips(
  state: PickerState,
  maxWidth: number,
): { text: string; ranges: { col: number; jid: string }[] } {
  const chips = chipsOf(state);
  const color = state.model.color;
  if (chips.length === 0) {
    return { text: dim("nothing picked yet", color), ranges: [] };
  }
  type Piece = {
    jid: string;
    plain: string;
    colored: string;
    width: number;
    xCol: number;
  };
  const labelCap = Math.max(1, Math.min(CHIP_LABEL_CAP, maxWidth - 6));
  const all: Piece[] = chips.map((c) => {
    const sign = c.struck ? "-" : "+";
    const plain = `[${sign} ${truncate(c.label, labelCap)} ×]`;
    return {
      jid: c.jid,
      plain,
      colored: c.struck ? strike(plain, color) : plain,
      width: displayWidth(plain),
      // lastIndexOf: a self-reported name may itself contain "×".
      xCol: displayWidth(plain.slice(0, plain.lastIndexOf("×"))),
    };
  });
  const chosen: Piece[] = [];
  let used = 0;
  let droppedCount = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const p = all[i];
    const addWidth = p.width + (chosen.length > 0 ? 1 : 0);
    if (used + addWidth > maxWidth && chosen.length > 0) {
      droppedCount = i + 1;
      break;
    }
    chosen.unshift(p);
    used += addWidth;
  }
  // The "+N more" prefix has to fit in the same budget - the loop above did
  // not reserve for it, so drop leading chips until it does.
  let prefixPlain = droppedCount > 0 ? `+${droppedCount} more ` : "";
  while (
    droppedCount > 0 &&
    chosen.length > 1 &&
    used + displayWidth(prefixPlain) > maxWidth
  ) {
    used -= chosen.shift()!.width + 1;
    droppedCount++;
    prefixPlain = `+${droppedCount} more `;
  }
  const prefixColored = droppedCount > 0 ? dim(prefixPlain, color) : "";
  let col = displayWidth(prefixPlain);
  const ranges: { col: number; jid: string }[] = [];
  const coloredParts: string[] = [];
  for (let i = 0; i < chosen.length; i++) {
    if (i > 0) col += 1;
    const p = chosen[i];
    ranges.push({ col: col + p.xCol, jid: p.jid });
    coloredParts.push(p.colored);
    col += p.width;
  }
  return { text: prefixColored + coloredParts.join(" "), ranges };
}

type FooterAction = "submit" | "undo" | "restore";
const FOOTER_SPEC: {
  action: FooterAction | "quit";
  verb: string;
  key: string;
}[] = [
  { action: "submit", verb: "Submit", key: "enter" },
  { action: "undo", verb: "Undo", key: "ctrl-z" },
  { action: "restore", verb: "Restore", key: "ctrl-r" },
  { action: "quit", verb: "Quit", key: "esc" },
];

// Builds the footer's plain and coloured forms in parallel, the renderChips
// pattern - so a FooterRange (measured on `plain`) always lands inside the
// segment a click is meant to fire. `full` picks the "verb: key" form and its
// 3-space separator; the short form is verb-only with a 2-space separator.
// Quit is drawn but never gets a FooterRange - `esc quit` was never
// clickable.
function buildFooter(
  full: boolean,
  color: boolean,
  hasBackup: boolean,
): {
  plain: string;
  colored: string;
  ranges: { action: FooterAction; start: number; end: number }[];
} {
  const sep = full ? "   " : "  ";
  let plain = "";
  let colored = "";
  const ranges: { action: FooterAction; start: number; end: number }[] = [];
  for (const part of FOOTER_SPEC) {
    if (plain) {
      plain += sep;
      colored += sep;
    }
    const start = plain.length;
    const segmentPlain = full ? `${part.verb}: ${part.key}` : part.verb;
    const segmentColored =
      part.action === "restore" && !hasBackup
        ? dim(segmentPlain, color)
        : full
          ? `${accent(part.verb, color)}: ${dim(part.key, color)}`
          : accent(part.verb, color);
    plain += segmentPlain;
    colored += segmentColored;
    if (part.action !== "quit") {
      ranges.push({ action: part.action, start, end: plain.length });
    }
  }
  return { plain, colored, ranges };
}

// Width, not layout, decides the form: the full footer is 58 cells and would
// be chopped mid-word in a narrow stacked screen, and its FooterRanges would
// then point at columns no longer drawn - a click firing an action whose
// word is invisible. So a 60-column stacked screen gets the full footer and
// only a genuinely narrow one falls back to the short form.
const FULL_FOOTER_PLAIN = buildFooter(true, false, true).plain;

function render(
  state: PickerState,
  cols: number,
  rows: number,
): { lines: string[]; geometry: Geometry } {
  const color = state.model.color;
  const stacked = cols < 70;
  const lines: string[] = [];
  const itemRows: ItemRow[] = [];
  const chipRanges: ChipRange[] = [];
  const footerRanges: FooterRange[] = [];

  // --- search line ---
  const searchRow = lines.length;
  const searchCap = Math.max(0, cols - 9);
  const searchLine =
    state.focus === "search"
      ? `Search: ${truncate(state.search, searchCap)}▏`
      : state.search !== ""
        ? `Search: ${truncate(state.search, searchCap)}`
        : `Search: ${dim("type to filter", color)}`;
  lines.push(searchLine);

  // --- picked line ---
  const pickedRow = lines.length;
  const pickedMaxWidth = Math.max(1, cols - "Picked: ".length);
  const chips = renderChips(state, pickedMaxWidth);
  lines.push(`Picked: ${chips.text}`);
  for (const r of chips.ranges) {
    chipRanges.push({
      row: pickedRow,
      col: "Picked: ".length + r.col,
      jid: r.jid,
    });
  }

  const dmsVisible = visibleItems(state, "dms");
  const groupsVisible = visibleItems(state, "groups");

  // Which column draws the `>` marker: the focused column, or the row
  // Enter would tick while the caret is on the search line. Computed once,
  // shared by both layout branches, so the screen can never promise one row
  // and tick another (see enterTarget's own comment).
  const target = enterTarget(state);
  const dmsFocused = state.focus === "dms" || target === "dms";
  const groupsFocused = state.focus === "groups" || target === "groups";
  const dmsCursorIdx = target === "dms" ? 0 : state.cursor.dms;
  const groupsCursorIdx = target === "groups" ? 0 : state.cursor.groups;

  // --- footer (built once, appended last, but its width is fixed and
  //     independent of body geometry so we can compute it up front) ---
  const full = cols >= displayWidth(FULL_FOOTER_PLAIN);
  const footer = buildFooter(full, color, state.model.hasBackup);

  // Blank separator lines are optional: only as many as the height leaves
  // over once every mandatory line has its row.
  let blankBudget = 0;
  const pushBlank = () => {
    if (blankBudget > 0) {
      lines.push("");
      blankBudget--;
    }
  };
  type Cell = {
    col: ReturnType<typeof renderColumn>;
    column: "dms" | "groups";
    startCol: number;
    endCol: number;
  };
  // Pushes `n` body rows and records, per row, which item each cell holds.
  const pushRows = (
    n: number,
    lineOf: (i: number) => string,
    cells: Cell[],
  ) => {
    for (let i = 0; i < n; i++) {
      const row = lines.length;
      lines.push(lineOf(i));
      for (const { col, ...cell } of cells) {
        const index = col.rowIndex[i];
        if (index !== null) itemRows.push({ row, index, ...cell });
      }
    }
  };
  const column = (
    which: "dms" | "groups",
    w: number,
    n: number,
  ): ReturnType<typeof renderColumn> =>
    renderColumn(
      which === "dms" ? dmsVisible : groupsVisible,
      which === "dms" ? dmsCursorIdx : groupsCursorIdx,
      which === "dms" ? dmsFocused : groupsFocused,
      state.ticked,
      state.roster,
      which === "dms" ? state.model.dmNote : state.model.groupNote,
      w,
      n,
      color,
    );

  if (!stacked) {
    const leftW = Math.floor((cols - 2) / 2);
    const rightX = leftW + 2;
    const bodyRows = Math.max(1, rows - 6);
    blankBudget = Math.min(2, Math.max(0, rows - (4 + bodyRows)));
    pushBlank();
    lines.push(`${padVisible("CONTACTS", leftW)}  GROUPS`);
    const left = column("dms", leftW, bodyRows);
    const right = column("groups", cols - rightX, bodyRows);
    pushRows(
      bodyRows,
      (i) => `${padVisible(left.lines[i], leftW)}  ${right.lines[i]}`,
      [
        { col: left, column: "dms", startCol: 0, endCol: leftW },
        { col: right, column: "groups", startCol: rightX, endCol: cols },
      ],
    );
  } else {
    const bodyRows = Math.max(2, rows - 9);
    const dmsRows = Math.max(1, Math.floor(bodyRows / 2));
    const groupsRows = Math.max(1, bodyRows - dmsRows);
    blankBudget = Math.min(3, Math.max(0, rows - (5 + dmsRows + groupsRows)));
    pushBlank();
    lines.push("CONTACTS");
    const left = column("dms", cols, dmsRows);
    pushRows(dmsRows, (i) => left.lines[i], [
      { col: left, column: "dms", startCol: 0, endCol: cols },
    ]);
    pushBlank();
    lines.push("GROUPS");
    const right = column("groups", cols, groupsRows);
    pushRows(groupsRows, (i) => right.lines[i], [
      { col: right, column: "groups", startCol: 0, endCol: cols },
    ]);
  }
  pushBlank();
  const footerRow = lines.length;
  lines.push(footer.colored);
  for (const r of footer.ranges) footerRanges.push({ row: footerRow, ...r });

  return { lines, geometry: { itemRows, chipRanges, footerRanges, searchRow } };
}

export const layout = (state: PickerState, cols: number, rows: number) =>
  render(state, cols, rows).lines;

export function hitTest(
  state: PickerState,
  cols: number,
  rows: number,
  row: number,
  col: number,
): PickerEvent | null {
  const { geometry } = render(state, cols, rows);
  if (row === geometry.searchRow) return { type: "focusSearch" };
  for (const r of geometry.itemRows) {
    if (r.row === row && col >= r.startCol && col < r.endCol) {
      return { type: "focus", column: r.column, index: r.index };
    }
  }
  for (const c of geometry.chipRanges) {
    if (c.row === row && c.col === col) return { type: "unchip", jid: c.jid };
  }
  for (const f of geometry.footerRanges) {
    if (f.row === row && col >= f.start && col < f.end) {
      if (f.action === "restore" && !state.model.hasBackup) return null;
      return { type: f.action };
    }
  }
  return null;
}

// -----------------------------------------------------------------------
// 2.9 applySelection - the write rule, lifted out of wizard() unchanged
// -----------------------------------------------------------------------

export type AccessLike = {
  allowFrom: string[];
  groups: Record<
    string,
    { requireMention: boolean; allowFrom: string[]; roster?: boolean }
  >;
  [key: string]: unknown;
};
export type Shown = { groups: ReadonlySet<string>; dms: ReadonlySet<string> };

export function applySelection<T extends AccessLike>(
  base: T,
  sel: Selection,
  shown: Shown,
): T {
  const groups = { ...base.groups };
  // 1. A group in shown.groups that is not in sel.groups is deleted.
  for (const jid of shown.groups) {
    if (!sel.groups.has(jid)) delete groups[jid];
  }
  for (const jid of sel.groups) {
    // 2. A group already in base.groups is kept byte-identical.
    if (groups[jid]) continue;
    // 3. A new group gets these defaults.
    groups[jid] = {
      requireMention: true,
      allowFrom: [],
      roster: sel.roster.has(jid),
    };
  }
  // 4. allowFrom drops ONLY an entry this screen showed and the user
  // unticked - an entry the server appended while the screen was open is
  // kept.
  const allowFrom = base.allowFrom.filter(
    (j) => !shown.dms.has(j) || sel.dms.has(j),
  );
  for (const jid of sel.dms) {
    if (!allowFrom.includes(jid)) allowFrom.push(jid);
  }
  // 5. base is never mutated (groups/allowFrom above are both copies).
  return { ...base, groups, allowFrom };
}

// -----------------------------------------------------------------------
// 2.8 runPicker - the only impure function
// -----------------------------------------------------------------------

export async function runPicker(
  model: PickerModel,
  io: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream } = {},
): Promise<PickerResult> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  let state = initPicker(model, output.columns ?? 80, output.rows ?? 24);

  const restore = () => {
    output.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
    // process.once("exit", ...) never fires for an externally delivered
    // signal (kill -INT terminates the process before the exit event runs) -
    // this also runs from the SIGINT/SIGTERM handlers below, so the raw-mode
    // guard has to live here too, not just in the promise's finally.
    if (input.isTTY) input.setRawMode(false);
  };
  // An external Ctrl-C (SIGINT) or SIGTERM bypasses the normal cancel path
  // entirely - Node's default handler would otherwise terminate the process
  // mid-render, leaving mouse reporting and raw mode on for the shell that
  // gets control back.
  const onSignal = () => {
    restore();
    process.exit(1);
  };
  const redraw = () => {
    output.write(
      "\x1b[H\x1b[2J" + layout(state, state.cols, state.rows).join("\n"),
    );
  };
  const { promise, resolve, reject } = Promise.withResolvers<PickerResult>();
  const onData = (chunk: string) => {
    try {
      for (const ev of decodeInput(chunk)) {
        state = reducePicker(state, ev);
        const done = state.done;
        if (done) {
          if (done === "cancel") resolve(null);
          else if (done === "restore") resolve({ action: "restore" });
          else resolve({ action: "submit", ...selectionOf(state) });
          return;
        }
      }
      redraw();
    } catch (err) {
      reject(err);
    }
  };
  const onResize = () => {
    state = reducePicker(state, {
      type: "resize",
      cols: output.columns ?? state.cols,
      rows: output.rows ?? state.rows,
    });
    redraw();
  };

  try {
    input.setEncoding("utf8");
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    // Alt screen, hide cursor, mouse press reporting (SGR).
    output.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
    process.once("exit", restore);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    input.on("data", onData);
    output.on("resize", onResize);
    redraw();
    return await promise;
  } finally {
    // Always - including on throw.
    restore();
    input.removeListener("data", onData);
    output.removeListener("resize", onResize);
    input.pause();
    process.off("exit", restore);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
