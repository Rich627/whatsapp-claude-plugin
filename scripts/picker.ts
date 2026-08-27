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
const SEGMENTER =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function graphemes(s: string): string[] {
  if (SEGMENTER) return [...SEGMENTER.segment(s)].map((seg) => seg.segment);
  return [...s];
}

// East-Asian Wide/Fullwidth ranges, decided on the grapheme's first code
// point.
const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];
const ZERO_WIDTH = /\p{M}/u;
function cellWidth(g: string): number {
  const cp = g.codePointAt(0)!;
  if (
    ZERO_WIDTH.test(String.fromCodePoint(cp)) ||
    (cp >= 0x200b && cp <= 0x200d) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    return 0;
  }
  if (WIDE.some(([lo, hi]) => cp >= lo && cp <= hi)) return 2;
  return 1;
}

// The number of terminal cells `s` occupies - graphemes via Intl.Segmenter
// (Bun has it), falling back to Array.from (code points) when it does not.
// ponytail: first-code-point width table; flags/regional indicators count 1,
// add 1F1E6-1F1FF if a real terminal ever overlaps on one.
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
  if (w === 1) return "…";
  return takeWidth(s, w - 1) + "…";
}

// Split on spaces, never mid-word unless a single word is longer than `w`
// (in which case it's broken, cell-width safe).
function wrap(text: string, w: number): string[] {
  if (w <= 0) return [text];
  const words = text.split(" ").filter((w2) => w2.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if (displayWidth(word) > w) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      let rest = word;
      while (rest.length > 0) {
        let piece = takeWidth(rest, w);
        if (piece === "") piece = graphemes(rest)[0]; // wide grapheme, narrow column
        lines.push(piece);
        rest = rest.slice(piece.length);
      }
      continue;
    }
    const candidate = cur ? `${cur} ${word}` : word;
    if (displayWidth(candidate) > w) {
      lines.push(cur);
      cur = word;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
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
function toggleTick(state: PickerState, jid: string): PickerState {
  const item = findItem(state.model, jid);
  const ticked = new Set(state.ticked);
  if (ticked.has(jid)) ticked.delete(jid);
  else ticked.add(jid);
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
  const column = enterTarget(state) ?? focusedColumn(state);
  const visible = visibleItems(state, column);
  const idx = state.cursor[column];
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
        const roster = new Set(state.roster);
        if (roster.has(item.jid)) roster.delete(item.jid);
        else roster.add(item.jid);
        return {
          ...state,
          roster,
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
      const item = highlighted(state);
      if (!item) return state;
      return toggleTick(state, item.jid);
    }

    case "enter": {
      if (state.search !== "") {
        if (state.focus === "search") {
          const target = enterTarget(state);
          const next = target
            ? forceTick(state, visibleItems(state, target)[0].jid)
            : state;
          return resetSearch(next, "");
        }
        const item = highlighted(state);
        const next = item ? forceTick(state, item.jid) : state;
        return resetSearch(next, "");
      }
      return { ...state, done: "submit" };
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
        const roster = new Set(state.roster);
        if (roster.has(entry.jid)) roster.delete(entry.jid);
        else roster.add(entry.jid);
        return { ...state, roster, undo };
      }
      const item = findItem(state.model, entry.jid);
      const ticked = new Set(state.ticked);
      if (ticked.has(entry.jid)) ticked.delete(entry.jid);
      else ticked.add(entry.jid);
      let chips = state.chips;
      const differs = ticked.has(entry.jid) !== item.granted;
      const inChips = chips.includes(entry.jid);
      if (differs && !inChips) chips = [...chips, entry.jid];
      else if (!differs && inChips) {
        chips = chips.filter((j) => j !== entry.jid);
      }
      return { ...state, ticked, chips, undo };
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

    default:
      return state;
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
export function decodeInput(chunk: string): PickerEvent[] {
  const events: PickerEvent[] = [];
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i];
    if (ch === "\x03") {
      events.push({ type: "cancel" });
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      events.push({ type: "enter" });
      i++;
      continue;
    }
    if (ch === "\t") {
      events.push({ type: "tab" });
      i++;
      continue;
    }
    if (ch === "\x7f" || ch === "\x08") {
      events.push({ type: "backspace" });
      i++;
      continue;
    }
    if (ch === " ") {
      events.push({ type: "space" });
      i++;
      continue;
    }
    if (ch === "\x1a") {
      events.push({ type: "undo" });
      i++;
      continue;
    }
    if (ch === "\x12") {
      events.push({ type: "restore" });
      i++;
      continue;
    }
    if (ch === "\x1b") {
      if (i + 1 >= chunk.length) {
        events.push({ type: "esc" });
        i++;
        continue;
      }
      if (chunk[i + 1] === "O") {
        if (i + 2 >= chunk.length) {
          // Incomplete SS3 sequence at the end of the chunk - skipped, same
          // known limitation as an incomplete CSI sequence above.
          i = chunk.length;
          continue;
        }
        const c3 = chunk[i + 2];
        if (c3 === "A") events.push({ type: "up" });
        else if (c3 === "B") events.push({ type: "down" });
        else if (c3 === "C" || c3 === "D") events.push({ type: "tab" });
        // any other SS3 final byte -> nothing (skipped)
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
      const seq = chunk.slice(i, j + 1);
      const final = chunk[j];
      const body = chunk.slice(i + 2, j);
      if (seq === "\x1b[A") events.push({ type: "up" });
      else if (seq === "\x1b[B") events.push({ type: "down" });
      else if (seq === "\x1b[C" || seq === "\x1b[D" || seq === "\x1b[Z") {
        events.push({ type: "tab" });
      } else if (body.startsWith("<") && (final === "M" || final === "m")) {
        if (final === "M") {
          const [b, x, y] = body
            .slice(1)
            .split(";")
            .map((n) => Number(n));
          if (b === 0) events.push({ type: "click", row: y - 1, col: x - 1 });
          // b >= 64 (wheel) -> nothing
        }
        // release ("m") -> nothing
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

const STRIP_ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
function stripAnsi(s: string): string {
  return s.replace(STRIP_ANSI, "");
}

function dim(s: string, color: boolean): string {
  return color ? `\x1b[2m${s}\x1b[0m` : s;
}
function strike(s: string, color: boolean): string {
  return color ? `\x1b[9m${s}\x1b[0m` : s;
}
function green(s: string, color: boolean): string {
  return color ? `\x1b[32m${s}\x1b[0m` : s;
}
function accent(s: string, color: boolean): string {
  return color ? `\x1b[1;32m${s}\x1b[0m` : s;
}

function padVisible(s: string, width: number): string {
  const visLen = displayWidth(stripAnsi(s));
  return visLen >= width ? s : s + " ".repeat(width - visLen);
}

// Caps a single line to `cols` VISIBLE columns, dropping colour rather than
// risk cutting an escape sequence in half. Applied once, at the very end of
// render(), as the hard backstop for the "never wider than cols" guarantee -
// every section above is already built to fit, this only catches a miss.
// No ellipsis - it is the backstop, not a truncation.
function capLine(line: string, cols: number): string {
  const plain = stripAnsi(line);
  if (displayWidth(plain) <= cols) return line;
  return takeWidth(plain, Math.max(0, cols));
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
    const wrapped = wrap(note.trim() ? note : "(none)", Math.max(1, w));
    for (let i = 0; i < bodyRows; i++) {
      lines.push(dim(wrapped[i] ?? "", color));
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
  const itemSlots = slots;
  for (let i = 0; i < itemSlots && offset + i < visible.length; i++) {
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
  while (lines.length < itemSlots) {
    lines.push("");
    rowIndex.push(null);
  }
  // The more-line only when a row was actually reserved for it.
  if (overflow && slots < bodyRows) {
    const shown = offset + itemSlots;
    const more = visible.length - shown;
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
  const all: Piece[] = chips.map((c) => {
    const sign = c.struck ? "-" : "+";
    const labelCap = Math.max(1, Math.min(CHIP_LABEL_CAP, maxWidth - 6));
    const label = truncate(c.label, labelCap);
    const plain = `[${sign} ${label} ×]`;
    return {
      jid: c.jid,
      plain,
      colored: c.struck ? strike(plain, color) : plain,
      width: displayWidth(plain),
      xCol: displayWidth(plain.slice(0, plain.indexOf("×"))),
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
  const prefixPlain = droppedCount > 0 ? `+${droppedCount} more ` : "";
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
  const coloredFooter = footer.colored;
  const footerWordRanges = footer.ranges;

  let lineArr: string[];
  if (!stacked) {
    const leftW = Math.floor((cols - 2) / 2);
    const rightX = leftW + 2;
    const rightW = cols - rightX;
    const bodyRows = Math.max(1, rows - 6);
    const mandatory = 4 + bodyRows;
    const available = Math.max(0, rows - mandatory);
    let blankBudget = Math.min(2, available);
    const pushBlank = () => {
      if (blankBudget > 0) {
        lines.push("");
        blankBudget--;
      }
    };

    pushBlank();
    lines.push(`${padVisible("CONTACTS", leftW)}  GROUPS`);

    const left = renderColumn(
      dmsVisible,
      dmsCursorIdx,
      dmsFocused,
      state.ticked,
      state.roster,
      state.model.dmNote,
      leftW,
      bodyRows,
      color,
    );
    const right = renderColumn(
      groupsVisible,
      groupsCursorIdx,
      groupsFocused,
      state.ticked,
      state.roster,
      state.model.groupNote,
      rightW,
      bodyRows,
      color,
    );
    for (let i = 0; i < bodyRows; i++) {
      const row = lines.length;
      lines.push(
        `${padVisible(left.lines[i] ?? "", leftW)}  ${right.lines[i] ?? ""}`,
      );
      if (left.rowIndex[i] !== null) {
        itemRows.push({
          row,
          column: "dms",
          index: left.rowIndex[i]!,
          startCol: 0,
          endCol: leftW,
        });
      }
      if (right.rowIndex[i] !== null) {
        itemRows.push({
          row,
          column: "groups",
          index: right.rowIndex[i]!,
          startCol: rightX,
          endCol: cols,
        });
      }
    }
    pushBlank();
    const footerRow = lines.length;
    lines.push(coloredFooter);
    for (const r of footerWordRanges) {
      footerRanges.push({
        row: footerRow,
        action: r.action,
        start: r.start,
        end: r.end,
      });
    }
    lineArr = lines;
  } else {
    const w = cols;
    const bodyRows = Math.max(2, rows - 9);
    const dmsRows = Math.max(1, Math.floor(bodyRows / 2));
    const groupsRows = Math.max(1, bodyRows - dmsRows);
    const mandatory = 5 + dmsRows + groupsRows;
    const available = Math.max(0, rows - mandatory);
    let blankBudget = Math.min(3, available);
    const pushBlank = () => {
      if (blankBudget > 0) {
        lines.push("");
        blankBudget--;
      }
    };

    pushBlank();
    lines.push("CONTACTS");
    const left = renderColumn(
      dmsVisible,
      dmsCursorIdx,
      dmsFocused,
      state.ticked,
      state.roster,
      state.model.dmNote,
      w,
      dmsRows,
      color,
    );
    for (let i = 0; i < dmsRows; i++) {
      const row = lines.length;
      lines.push(left.lines[i] ?? "");
      if (left.rowIndex[i] !== null) {
        itemRows.push({
          row,
          column: "dms",
          index: left.rowIndex[i]!,
          startCol: 0,
          endCol: w,
        });
      }
    }
    pushBlank();
    lines.push("GROUPS");
    const right = renderColumn(
      groupsVisible,
      groupsCursorIdx,
      groupsFocused,
      state.ticked,
      state.roster,
      state.model.groupNote,
      w,
      groupsRows,
      color,
    );
    for (let i = 0; i < groupsRows; i++) {
      const row = lines.length;
      lines.push(right.lines[i] ?? "");
      if (right.rowIndex[i] !== null) {
        itemRows.push({
          row,
          column: "groups",
          index: right.rowIndex[i]!,
          startCol: 0,
          endCol: w,
        });
      }
    }
    pushBlank();
    const footerRow = lines.length;
    lines.push(coloredFooter);
    for (const r of footerWordRanges) {
      footerRanges.push({
        row: footerRow,
        action: r.action,
        start: r.start,
        end: r.end,
      });
    }
    lineArr = lines;
  }

  const capped = lineArr.map((l) => capLine(l, cols)).slice(0, rows);
  return {
    lines: capped,
    geometry: { itemRows, chipRanges, footerRanges, searchRow },
  };
}

export function layout(
  state: PickerState,
  cols: number,
  rows: number,
): string[] {
  return render(state, cols, rows).lines;
}

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
  const resizable = output === process.stdout && !!output.isTTY;

  let onData: ((chunk: string) => void) | undefined;
  let onResize: (() => void) | undefined;

  try {
    const result = await new Promise<PickerResult>((resolve, reject) => {
      onData = (chunk: string) => {
        try {
          for (const ev of decodeInput(chunk)) {
            state = reducePicker(state, ev);
            if (state.done) {
              const done = state.done;
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
      onResize = () => {
        state = reducePicker(state, {
          type: "resize",
          cols: output.columns ?? state.cols,
          rows: output.rows ?? state.rows,
        });
        redraw();
      };

      input.setEncoding("utf8");
      if (input.isTTY) input.setRawMode(true);
      input.resume();
      // Alt screen, hide cursor, mouse press reporting (SGR).
      output.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
      process.once("exit", restore);
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      input.on("data", onData);
      if (resizable) output.on("resize", onResize);
      redraw();
    });
    return result;
  } finally {
    // Reverse order of setup, always - including on throw.
    output.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
    if (onData) input.removeListener("data", onData);
    if (resizable && onResize) output.removeListener("resize", onResize);
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    process.off("exit", restore);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
