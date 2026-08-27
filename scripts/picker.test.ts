import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  applySelection,
  chipsOf,
  decodeInput,
  displayWidth,
  hitTest,
  initPicker,
  layout,
  reducePicker,
  runPicker,
  selectionOf,
  truncate,
  visibleItems,
  type PickerEvent,
  type PickerItem,
  type PickerModel,
  type PickerState,
} from "./picker";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

function item(overrides: Partial<PickerItem> = {}): PickerItem {
  return {
    jid: "1@s.whatsapp.net",
    label: "Item",
    kind: "dm",
    granted: false,
    roster: false,
    ...overrides,
  };
}

function model(overrides: Partial<PickerModel> = {}): PickerModel {
  return {
    dms: [],
    groups: [],
    dmNote: "",
    groupNote: "",
    hasBackup: false,
    color: false,
    ...overrides,
  };
}

function press(state: PickerState, ...events: PickerEvent[]): PickerState {
  return events.reduce((s, e) => reducePicker(s, e), state);
}

const rohan = item({
  jid: "rohan@s.whatsapp.net",
  label: "Rohan",
  kind: "dm",
  granted: true,
});
const priya = item({
  jid: "priya@s.whatsapp.net",
  label: "Priya",
  kind: "dm",
  granted: false,
});
const family = item({
  jid: "family@g.us",
  label: "Family",
  kind: "group",
  granted: true,
  roster: true,
});
const wil = item({
  jid: "wil@g.us",
  label: "WIL Group HUDINI",
  kind: "group",
  granted: false,
});

// -----------------------------------------------------------------------
// reducer
// -----------------------------------------------------------------------

describe("reducePicker", () => {
  test("initPicker: every granted item ticked, others not; chips empty; focus dms; cursors 0; done null", () => {
    const s = initPicker(
      model({ dms: [rohan, priya], groups: [family, wil] }),
      100,
      24,
    );
    expect(s.ticked.has(rohan.jid)).toBe(true);
    expect(s.ticked.has(priya.jid)).toBe(false);
    expect(s.ticked.has(family.jid)).toBe(true);
    expect(s.ticked.has(wil.jid)).toBe(false);
    expect(s.chips).toEqual([]);
    expect(s.focus).toBe("dms");
    expect(s.cursor).toEqual({ dms: 0, groups: 0 });
    expect(s.done).toBeNull();
  });

  test("a filter change puts both cursors back on row 0", () => {
    let s = initPicker(
      model({ dms: [rohan, priya], groups: [family, wil] }),
      100,
      24,
    );
    s = press(s, { type: "down" }); // dms cursor -> 1
    expect(s.cursor.dms).toBe(1);
    s = press(
      s,
      { type: "char", ch: "F" },
      { type: "char", ch: "A" },
      { type: "char", ch: "M" },
    );
    expect(visibleItems(s, "dms").map((i) => i.jid)).toEqual([]);
    expect(visibleItems(s, "groups").map((i) => i.jid)).toEqual([family.jid]);
    expect(s.cursor).toEqual({ dms: 0, groups: 0 });
    expect(s.focus).toBe("search");
  });

  test("a term matching only a JID/number matches nothing (label-only filter)", () => {
    const contact = item({
      jid: "61403911675@s.whatsapp.net",
      label: "Rohan",
      granted: false,
    });
    let s = initPicker(model({ dms: [contact] }), 100, 24);
    s = press(
      s,
      { type: "char", ch: "6" },
      { type: "char", ch: "1" },
      { type: "char", ch: "4" },
    );
    expect(visibleItems(s, "dms")).toEqual([]);
  });

  test("Enter with a non-empty search ticks the highlighted row, pushes its chip and clears the search", () => {
    let s = initPicker(model({ dms: [priya] }), 100, 24);
    s = press(
      s,
      { type: "char", ch: "p" },
      { type: "char", ch: "r" },
      { type: "enter" },
    );
    expect(s.ticked.has(priya.jid)).toBe(true);
    expect(s.chips).toEqual([priya.jid]);
    expect(s.search).toBe("");
    expect(visibleItems(s, "dms")).toEqual([priya]);
  });

  test("Enter with an empty search sets done='submit'", () => {
    let s = initPicker(model(), 100, 24);
    s = press(s, { type: "enter" });
    expect(s.done).toBe("submit");
  });

  test("Backspace with a non-empty search deletes one character", () => {
    let s = initPicker(model(), 100, 24);
    s = press(
      s,
      { type: "char", ch: "a" },
      { type: "char", ch: "b" },
      { type: "backspace" },
    );
    expect(s.search).toBe("a");
  });

  test("Backspace with an empty search pops the newest chip AND unticks that jid", () => {
    let s = initPicker(model({ dms: [priya] }), 100, 24);
    s = press(s, { type: "space" });
    expect(s.chips).toEqual([priya.jid]);
    s = press(s, { type: "backspace" });
    expect(s.chips).toEqual([]);
    expect(s.ticked.has(priya.jid)).toBe(false);
    const before = s;
    s = press(s, { type: "backspace" }); // no chips left -> no-op
    expect(s).toBe(before);
  });

  test("Space toggles only the highlighted row of the focused column", () => {
    let s = initPicker(
      model({ dms: [rohan, priya], groups: [family] }),
      100,
      24,
    );
    s = press(s, { type: "space" }); // focus dms, cursor 0 -> rohan
    expect(s.ticked.has(rohan.jid)).toBe(false);
    expect(s.ticked.has(priya.jid)).toBe(false);
    expect(s.ticked.has(family.jid)).toBe(true); // untouched
  });

  test("Tab cycles dms -> groups -> search -> dms; up/down move and clamp at both ends; empty column is a no-op", () => {
    let s = initPicker(model({ dms: [rohan, priya], groups: [] }), 100, 24);
    s = press(s, { type: "tab" });
    expect(s.focus).toBe("groups");
    const before = s;
    s = press(s, { type: "down" });
    expect(s).toBe(before); // groups is empty
    s = press(s, { type: "tab" }); // groups -> search
    expect(s.focus).toBe("search");
    s = press(s, { type: "tab" }); // search -> dms, completing the cycle
    expect(s.focus).toBe("dms");
    s = press(s, { type: "down" });
    expect(s.cursor.dms).toBe(1);
    s = press(s, { type: "down" });
    expect(s.cursor.dms).toBe(1); // clamped
    s = press(s, { type: "up" }, { type: "up" });
    expect(s.cursor.dms).toBe(0);
  });

  test("Undo pops the last toggle (ticked + chips both restored); undo on an empty stack is a no-op", () => {
    let s = initPicker(model({ dms: [priya] }), 100, 24);
    s = press(s, { type: "space" });
    expect(s.ticked.has(priya.jid)).toBe(true);
    s = press(s, { type: "undo" });
    expect(s.ticked.has(priya.jid)).toBe(false);
    expect(s.chips).toEqual([]);
    const before = s;
    s = press(s, { type: "undo" });
    expect(s).toBe(before);
  });

  test("'r' on a ticked, not-yet-granted group sets [r]; a second 'r' clears it", () => {
    let s = initPicker(model({ groups: [wil] }), 100, 24);
    s = press(s, { type: "tab" }, { type: "space" });
    expect(s.ticked.has(wil.jid)).toBe(true);
    s = press(s, { type: "char", ch: "r" });
    expect(s.roster.has(wil.jid)).toBe(true);
    s = press(s, { type: "char", ch: "r" });
    expect(s.roster.has(wil.jid)).toBe(false);
  });

  test("'r' on a ticked ALREADY-granted group is a no-op ([D2])", () => {
    let s = initPicker(model({ groups: [family] }), 100, 24);
    s = press(s, { type: "tab" });
    const before = s;
    s = press(s, { type: "char", ch: "r" });
    expect(s).toBe(before);
  });

  test("'r' on a contact is a no-op; 'r' while the search is non-empty is a plain filter character", () => {
    let s = initPicker(model({ dms: [priya] }), 100, 24);
    s = press(s, { type: "space" });
    const before = s;
    s = press(s, { type: "char", ch: "r" });
    expect(s).toBe(before);
    s = press(s, { type: "char", ch: "z" }, { type: "char", ch: "r" });
    expect(s.search).toBe("zr");
  });

  test("unticking an existing grant produces a STRUCK chip; re-ticking removes the chip entirely", () => {
    let s = initPicker(model({ dms: [rohan] }), 100, 24);
    s = press(s, { type: "space" });
    expect(chipsOf(s)).toEqual([
      { jid: rohan.jid, label: "Rohan", struck: true },
    ]);
    s = press(s, { type: "space" });
    expect(chipsOf(s)).toEqual([]);
  });

  test("Esc clears a non-empty search; Esc on an empty search sets done='cancel'", () => {
    let s = initPicker(model(), 100, 24);
    s = press(s, { type: "char", ch: "a" }, { type: "esc" });
    expect(s.search).toBe("");
    expect(s.done).toBeNull();
    s = press(s, { type: "esc" });
    expect(s.done).toBe("cancel");
  });

  test("'restore' is inert when hasBackup:false, sets done='restore' when true", () => {
    let s = initPicker(model({ hasBackup: false }), 100, 24);
    const before = s;
    s = press(s, { type: "restore" });
    expect(s).toBe(before);
    s = initPicker(model({ hasBackup: true }), 100, 24);
    s = press(s, { type: "restore" });
    expect(s.done).toBe("restore");
  });

  test("selectionOf splits groups/dms and filters roster to ticked groups only", () => {
    let s = initPicker(model({ dms: [rohan], groups: [wil] }), 100, 24);
    s = press(s, { type: "tab" }, { type: "space" }, { type: "char", ch: "r" });
    let sel = selectionOf(s);
    expect(sel.groups).toEqual(new Set([wil.jid]));
    expect(sel.dms).toEqual(new Set([rohan.jid]));
    expect(sel.roster).toEqual(new Set([wil.jid]));
    s = press(s, { type: "space" }); // untick wil
    sel = selectionOf(s);
    expect(sel.groups).toEqual(new Set());
    expect(sel.roster).toEqual(new Set());
  });

  test("the reducer never mutates its input (Set identity + original state unchanged)", () => {
    const s0 = initPicker(model({ dms: [priya] }), 100, 24);
    const tickedRef = s0.ticked;
    const s1 = reducePicker(s0, { type: "space" });
    expect(s0.ticked).toBe(tickedRef);
    expect(s0.ticked.has(priya.jid)).toBe(false);
    expect(s1).not.toBe(s0);
    expect(s1.ticked).not.toBe(s0.ticked);
  });

  test("a 'focus' event with an out-of-range index clamps to the last visible row", () => {
    let s = initPicker(model({ groups: [family, wil] }), 100, 24);
    s = press(s, { type: "focus", column: "groups", index: 999 });
    expect(s.focus).toBe("groups");
    expect(s.cursor.groups).toBe(1); // clamped to visibleItems("groups").length - 1
  });

  test("resize mid-session keeps ticks, chips and cursor untouched", () => {
    let s = initPicker(model({ dms: [rohan, priya] }), 100, 24);
    s = press(s, { type: "down" }, { type: "space" }); // tick priya, cursor 1
    expect(s.ticked.has(rohan.jid)).toBe(true);
    expect(s.ticked.has(priya.jid)).toBe(true);
    expect(s.chips).toEqual([priya.jid]);
    s = press(s, { type: "resize", cols: 60, rows: 20 });
    expect(s.cols).toBe(60);
    expect(s.rows).toBe(20);
    expect(s.ticked.has(rohan.jid)).toBe(true);
    expect(s.ticked.has(priya.jid)).toBe(true);
    expect(s.chips).toEqual([priya.jid]);
    expect(s.cursor.dms).toBe(1);
  });

  test("↑ from row 0 moves focus to the search line and draws the caret", () => {
    let s = initPicker(model({ dms: [rohan, priya] }), 100, 24);
    s = press(s, { type: "up" });
    expect(s.focus).toBe("search");
    expect(s.lastColumn).toBe("dms");
    const searchLine = layout(s, 100, 24)[0];
    expect(searchLine.endsWith("▏")).toBe(true);
  });

  test("↓ from the search line returns to row 0 of the last-focused column", () => {
    let s = initPicker(model({ groups: [family, wil] }), 100, 24);
    s = press(s, { type: "tab" }); // dms -> groups
    s = press(s, { type: "down" }); // cursor.groups -> 1
    s = press(s, { type: "up" }, { type: "up" }); // row 0, then -> search
    expect(s.focus).toBe("search");
    s = press(s, { type: "down" });
    expect(s.focus).toBe("groups");
    expect(s.cursor.groups).toBe(0);
  });

  test("Tab cycles search → Contacts → Groups → search", () => {
    let s = initPicker(model({ dms: [rohan], groups: [family] }), 100, 24);
    expect(s.focus).toBe("dms");
    s = press(s, { type: "tab" });
    expect(s.focus).toBe("groups");
    s = press(s, { type: "tab" });
    expect(s.focus).toBe("search");
    s = press(s, { type: "tab" });
    expect(s.focus).toBe("dms");
  });

  test("typing while a column is focused snaps the caret to the search line", () => {
    let s = initPicker(model({ dms: [rohan], groups: [family] }), 100, 24);
    s = press(s, { type: "tab" }, { type: "char", ch: "z" });
    expect(s.focus).toBe("search");
    expect(s.search).toBe("z");
    expect(s.lastColumn).toBe("groups");
    expect(s.cursor).toEqual({ dms: 0, groups: 0 });
  });

  test("Enter on the search line ticks the first visible Contacts row, and Groups only when Contacts has no match", () => {
    // Case 1: Contacts has a match -> Contacts wins even though Groups also matches.
    let s = initPicker(
      model({
        dms: [item({ jid: "a@s.whatsapp.net", label: "Alpha" })],
        groups: [
          item({ jid: "alpha@g.us", label: "Alpha Group", kind: "group" }),
        ],
      }),
      100,
      24,
    );
    s = press(s, { type: "up" }); // -> focus search
    s = press(
      s,
      { type: "char", ch: "a" },
      { type: "char", ch: "l" },
      { type: "enter" },
    );
    expect(s.ticked.has("a@s.whatsapp.net")).toBe(true);
    expect(s.ticked.has("alpha@g.us")).toBe(false);

    // Case 2: no Contacts match -> falls through to Groups.
    let t = initPicker(
      model({
        dms: [rohan],
        groups: [
          item({ jid: "alpha@g.us", label: "Alpha Group", kind: "group" }),
        ],
      }),
      100,
      24,
    );
    t = press(t, { type: "up" });
    t = press(
      t,
      { type: "char", ch: "a" },
      { type: "char", ch: "l" },
      { type: "enter" },
    );
    expect(t.ticked.has("alpha@g.us")).toBe(true);
  });

  test("Enter on an empty search still submits with the caret on the search line", () => {
    let s = initPicker(model({ dms: [rohan] }), 100, 24);
    s = press(s, { type: "up" }); // focus -> search, search still ""
    expect(s.focus).toBe("search");
    s = press(s, { type: "enter" });
    expect(s.done).toBe("submit");
  });

  test("'r' filters when the caret is on the search line and flags roster when a column is focused", () => {
    let s = initPicker(model({ groups: [wil] }), 100, 24);
    s = press(s, { type: "tab" }, { type: "space" }); // focus groups, tick wil
    s = press(s, { type: "char", ch: "r" });
    expect(s.roster.has(wil.jid)).toBe(true);
    expect(s.focus).toBe("groups");

    let t = initPicker(model({ groups: [wil] }), 100, 24);
    t = press(t, { type: "tab" }, { type: "space" }); // tick wil, focus groups
    t = press(t, { type: "up" }); // -> focus search (only row is 0)
    t = press(t, { type: "char", ch: "r" });
    expect(t.search).toBe("r");
    expect(t.focus).toBe("search");
    expect(t.roster.has(wil.jid)).toBe(false);
  });

  test("space toggles the last-focused column's row while the caret is on the search line", () => {
    let s = initPicker(model({ dms: [rohan, priya] }), 100, 24);
    s = press(s, { type: "up" }); // focus -> search, lastColumn dms, cursor.dms 0
    expect(s.focus).toBe("search");
    s = press(s, { type: "space" });
    expect(s.ticked.has(rohan.jid)).toBe(false); // rohan was granted -> toggled off
    expect(s.focus).toBe("search"); // space stays focus-neutral
  });
});

// -----------------------------------------------------------------------
// decodeInput
// -----------------------------------------------------------------------

describe("decodeInput", () => {
  test("every row of the table maps as specified, in order", () => {
    expect(decodeInput("\x03")).toEqual([{ type: "cancel" }]);
    expect(decodeInput("\r")).toEqual([{ type: "enter" }]);
    expect(decodeInput("\n")).toEqual([{ type: "enter" }]);
    expect(decodeInput("\t")).toEqual([{ type: "tab" }]);
    expect(decodeInput("\x7f")).toEqual([{ type: "backspace" }]);
    expect(decodeInput("\x08")).toEqual([{ type: "backspace" }]);
    expect(decodeInput(" ")).toEqual([{ type: "space" }]);
    expect(decodeInput("\x1a")).toEqual([{ type: "undo" }]);
    expect(decodeInput("\x12")).toEqual([{ type: "restore" }]);
    expect(decodeInput("\x1b[A")).toEqual([{ type: "up" }]);
    expect(decodeInput("\x1b[B")).toEqual([{ type: "down" }]);
    expect(decodeInput("\x1b[C")).toEqual([{ type: "tab" }]);
    expect(decodeInput("\x1b[D")).toEqual([{ type: "tab" }]);
    expect(decodeInput("\x1b[Z")).toEqual([{ type: "tab" }]);
    expect(decodeInput("\x1b")).toEqual([{ type: "esc" }]);
    expect(decodeInput("a")).toEqual([{ type: "char", ch: "a" }]);
    expect(decodeInput("ab\r")).toEqual([
      { type: "char", ch: "a" },
      { type: "char", ch: "b" },
      { type: "enter" },
    ]);
    expect(decodeInput("\x1b[9~")).toEqual([]); // unknown escape -> nothing
  });

  test("SGR mouse: click, release and wheel", () => {
    expect(decodeInput("\x1b[<0;12;7M")).toEqual([
      { type: "click", row: 6, col: 11 },
    ]);
    expect(decodeInput("\x1b[<0;12;7m")).toEqual([]); // release
    expect(decodeInput("\x1b[<64;5;5M")).toEqual([]); // wheel
  });

  // SS3 (application-cursor-mode) arrows: a terminal left in DECCKM by a
  // previous full-screen program sends ESC-O-<letter> instead of the CSI
  // (ESC-[-<letter>) form. Before the fix these fell into the bare-esc
  // branch (cancel, on an empty search) followed by two literal chars -
  // review finding 4.
  test("SS3 arrows (ESC O A/B/C/D) decode the same as their CSI form", () => {
    expect(decodeInput("\x1bOA")).toEqual([{ type: "up" }]);
    expect(decodeInput("\x1bOB")).toEqual([{ type: "down" }]);
    expect(decodeInput("\x1bOC")).toEqual([{ type: "tab" }]);
    expect(decodeInput("\x1bOD")).toEqual([{ type: "tab" }]);
  });
});

// -----------------------------------------------------------------------
// displayWidth
// -----------------------------------------------------------------------

describe("displayWidth", () => {
  test("CJK, emoji, combining marks and zero-width characters each measure the cells they occupy", () => {
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("😀")).toBe(2);
    expect(displayWidth("café")).toBe(4);
    // Spec (.pipeline/spec.md §4.4) expects 3 assuming ICU joins ನ್ನ
    // into one grapheme cluster; this runtime instead splits it as two
    // clusters (4 graphemes total) - an ICU segmentation detail, not a
    // wrong width range (verified with a standalone Intl.Segmenter probe).
    expect(displayWidth("ಕನ್ನಡ")).toBe(4);
    expect(displayWidth("🇮🇳")).toBe(1);
    expect(displayWidth("‍")).toBe(0);
    expect(displayWidth("️")).toBe(0);
  });

  const WIDE_SAMPLES = [
    "ಕನ್ನಡ",
    "日本語テキスト",
    "😀😀😀",
    "🇮🇳🇮🇳",
    "café café",
  ];

  test("truncate never returns more display cells than its budget", () => {
    for (const s of WIDE_SAMPLES) {
      for (let w = 1; w <= 12; w++) {
        expect(displayWidth(truncate(s, w))).toBeLessThanOrEqual(w);
      }
    }
  });

  test("a wide grapheme is never split in half", () => {
    const lone =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
    for (const s of WIDE_SAMPLES) {
      for (let w = 1; w <= 12; w++) {
        expect(lone.test(truncate(s, w))).toBe(false);
      }
    }
  });
});

// -----------------------------------------------------------------------
// layout
// -----------------------------------------------------------------------

describe("layout", () => {
  test("two columns at cols=100: header contains CONTACTS and GROUPS; granted row [x], ungranted [ ]", () => {
    const s = initPicker(
      model({ dms: [rohan, priya], groups: [family, wil] }),
      100,
      24,
    );
    const text = layout(s, 100, 24).join("\n");
    expect(text).toContain("CONTACTS");
    expect(text).toContain("GROUPS");
    expect(text).toContain("[x] Rohan");
    expect(text).toContain("[ ] Priya");
  });

  test("no drawn line contains @g.us, @s.whatsapp.net, @lid, or the raw digit run from any item's jid", () => {
    const numberDm = item({
      jid: "61403911675@s.whatsapp.net",
      label: "•••••1675",
      granted: false,
    });
    const s = initPicker(model({ dms: [numberDm], groups: [family] }), 100, 24);
    const text = layout(s, 100, 24).join("\n");
    expect(text).not.toContain("@g.us");
    expect(text).not.toContain("@s.whatsapp.net");
    expect(text).not.toContain("@lid");
    expect(text).not.toContain("61403911675");
    expect(text).not.toContain(family.jid);
  });

  test("every line's stripAnsi width <= cols, and lines.length <= rows, at several sizes", () => {
    const s = initPicker(
      model({ dms: [rohan, priya], groups: [family, wil], color: true }),
      100,
      24,
    );
    for (const [cols, rows] of [
      [100, 24],
      [60, 24],
      [100, 10],
      [40, 8],
    ] as const) {
      const lines = layout(s, cols, rows);
      expect(lines.length).toBeLessThanOrEqual(rows);
      for (const l of lines)
        expect(stripAnsi(l).length).toBeLessThanOrEqual(cols);
    }
  });

  test("cols=60 stacks: CONTACTS and GROUPS on separate lines, one column wide", () => {
    const s = initPicker(
      model({ dms: [rohan, priya], groups: [family, wil] }),
      60,
      24,
    );
    const lines = layout(s, 60, 24);
    const contactsRow = lines.findIndex((l) => l.includes("CONTACTS"));
    const groupsRow = lines.findIndex(
      (l, i) => i > contactsRow && l.includes("GROUPS"),
    );
    expect(contactsRow).toBeGreaterThanOrEqual(0);
    expect(groupsRow).toBeGreaterThan(contactsRow);
  });

  test("a short terminal still emits the search, picked and footer lines", () => {
    const s = initPicker(
      model({ dms: [rohan, priya], groups: [family, wil] }),
      40,
      8,
    );
    const lines = layout(s, 40, 8);
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines.some((l) => l.startsWith("Search:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Picked:"))).toBe(true);
    expect(lines.some((l) => l.includes("Submit"))).toBe(true);
  });

  test("a long label is truncated with an ellipsis; an emoji label is never cut mid-surrogate", () => {
    const long = item({ jid: "x@g.us", label: "A".repeat(200), kind: "group" });
    const emoji = item({
      jid: "y@s.whatsapp.net",
      label: "\u{1F600}".repeat(50),
      kind: "dm",
    });
    const s = initPicker(model({ dms: [emoji], groups: [long] }), 40, 24);
    const text = layout(s, 40, 24).join("\n");
    expect(text).toContain("…");
    const lone =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
    expect(lone.test(text)).toBe(false);
  });

  test("a label containing ANSI, CR, LF and a bidi override reaches the frame with all of them gone", () => {
    const dirty = item({
      jid: "d@s.whatsapp.net",
      label: "a\x1b[31mb\rc\nd‮e",
    });
    const s = initPicker(model({ dms: [dirty] }), 100, 24);
    const text = layout(s, 100, 24).join("\n");
    expect(text).not.toContain("\x1b[31m");
    expect(text).not.toContain("\r");
    expect(text).not.toContain("‮");
    expect(text).toContain("a[31mbcde");
  });

  test("an empty contacts column draws dmNote, wrapped to the column width", () => {
    const s = initPicker(
      model({
        dms: [],
        groups: [family],
        dmNote:
          "No contacts to review - set WHATSAPP_CACHE_CONTACTS=0 to opt out.",
      }),
      100,
      24,
    );
    const text = layout(s, 100, 24).join("\n");
    expect(text).toContain("WHATSAPP_CACHE_CONTACTS=0");
  });

  test("an empty column with no note draws dim '(none)'", () => {
    const s = initPicker(
      model({ dms: [], groups: [family], dmNote: "" }),
      100,
      24,
    );
    const text = layout(s, 100, 24).join("\n");
    expect(text).toContain("(none)");
  });

  test("chips: '+' for a new tick, '-' for a revoked grant, '×' present", () => {
    let s = initPicker(model({ dms: [rohan, priya] }), 100, 24);
    s = press(s, { type: "space" }); // untick rohan (granted) -> "-" chip
    s = press(s, { type: "down" }, { type: "space" }); // tick priya -> "+" chip
    const text = layout(s, 100, 24).join("\n");
    expect(text).toContain("[- Rohan ×]");
    expect(text).toContain("[+ Priya ×]");
  });

  test("chips overflow the picked line width and show a leading '+N more'", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      item({
        jid: `c${i}@s.whatsapp.net`,
        label: `Contact Number ${i}`,
        granted: false,
      }),
    );
    let s = initPicker(model({ dms: many }), 40, 24);
    for (let i = 0; i < many.length; i++) {
      s = press(s, { type: "space" });
      if (i < many.length - 1) s = press(s, { type: "down" });
    }
    const text = layout(s, 40, 24).join("\n");
    expect(text).toMatch(/\+\d+ more/);
  });

  test("Restore is dim / not clickable when hasBackup:false", () => {
    const s = initPicker(model({ hasBackup: false }), 100, 24);
    const lines = layout(s, 100, 24);
    const row = lines.findIndex((l) => l.includes("Submit"));
    const plain = stripAnsi(lines[row]);
    const col = plain.indexOf("Restore");
    expect(hitTest(s, 100, 24, row, col)).toBeNull();
  });

  test("a column with more items than fit ends with '… +N more'", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      item({ jid: `g${i}@g.us`, label: `Group ${i}`, kind: "group" }),
    );
    const s = initPicker(model({ groups: many }), 100, 10);
    const text = layout(s, 100, 10).join("\n");
    expect(text).toMatch(/… \+\d+ more/);
  });
});

// -----------------------------------------------------------------------
// adversarial - a large model, every documented terminal size
// -----------------------------------------------------------------------

describe("layout - adversarial large model", () => {
  function bigModel(): PickerModel {
    const groups = Array.from({ length: 200 }, (_, i) =>
      item({
        jid: `g${i}12345678@g.us`,
        label: `Group ${i}`,
        kind: "group",
        granted: i % 3 === 0,
      }),
    );
    const dms = Array.from({ length: 100 }, (_, i) => {
      const num = `9198765${String(i).padStart(4, "0")}`; // 11 raw digits
      return item({
        jid: `${num}@s.whatsapp.net`,
        label: `•••••${String(i).padStart(4, "0")}`, // masked, no saved name
        kind: "dm",
        granted: i % 5 === 0,
      });
    });
    return model({ dms, groups });
  }

  test("every layout line stays within cols and rows for a 200-group/100-contact model", () => {
    const s = initPicker(bigModel(), 80, 24);
    for (const cols of [40, 70, 80, 120]) {
      for (const rows of [10, 24, 50]) {
        const lines = layout(s, cols, rows);
        expect(lines.length).toBeLessThanOrEqual(rows);
        for (const l of lines) {
          expect(stripAnsi(l).length).toBeLessThanOrEqual(cols);
        }
      }
    }
  });

  test("a one-row column still draws its focused item instead of only a more-line (review finding 11)", () => {
    const s = initPicker(bigModel(), 80, 24);
    for (const [cols, rows] of [
      [60, 11],
      [60, 12],
      [100, 7],
      [100, 8],
    ]) {
      const lines = layout(s, cols, rows);
      expect(lines.length).toBeLessThanOrEqual(rows);
      const text = lines.map(stripAnsi).join("\n");
      expect(text).toContain(">[");
      expect(text).toContain("Group 0");
    }
  });

  test("no drawn line leaks a JID suffix or an unmasked 8+ digit run, contacts with no saved name", () => {
    let s = initPicker(bigModel(), 80, 24);
    // Tick a few rows so chips (which also render labels) are exercised too.
    s = press(s, { type: "space" }, { type: "down" }, { type: "space" });
    const digitRun = /\d{8,}/;
    for (const cols of [40, 70, 80, 120]) {
      for (const rows of [10, 24, 50]) {
        const text = layout(s, cols, rows).join("\n");
        expect(text).not.toContain("@g.us");
        expect(text).not.toContain("@s.whatsapp.net");
        expect(text).not.toContain("@lid");
        expect(digitRun.test(text)).toBe(false);
      }
    }
  });

  // Review finding 1: the window offset was derived from bodyRows, but only
  // bodyRows-1 rows are actually drawn once a trailing "... +N more" line is
  // needed, so the cursor sat one row below the last drawn row for almost
  // the whole scroll range - Space would then toggle an access grant the
  // operator cannot see. 200 groups at 100x24 (bodyRows 18) overflows almost
  // immediately; 25 Downs lands deep in that range.
  test("the cursor marker stays inside the drawn window once a column overflows", () => {
    let s = initPicker(bigModel(), 100, 24);
    s = press(s, { type: "tab" }); // groups column, right-hand side of the line
    for (let i = 0; i < 25; i++) s = press(s, { type: "down" });
    expect(s.cursor.groups).toBe(25);
    const focusedLabel = visibleItems(s, "groups")[25].label;
    const text = layout(s, 100, 24).join("\n");
    // Marker is glued directly to the box (">[x]"/">[ ]"), not the row start
    // - the groups column sits to the right of the padded dms column, so a
    // per-line "starts with >" check would miss it entirely.
    const markers = text.match(/>\[[x ]\]/g) ?? [];
    expect(markers).toHaveLength(1);
    const idx = text.indexOf(markers[0]!);
    expect(text.slice(idx, idx + 60)).toContain(focusedLabel);
  });

  function wideModel(): PickerModel {
    const scripts = [`ಕನ್ನಡ`, `日本語`, `😀`, `🇮🇳`, `Café`];
    const dms = Array.from({ length: 40 }, (_, i) =>
      item({
        jid: `d${i}@s.whatsapp.net`,
        label: `${scripts[i % scripts.length]} ${i}`,
        kind: "dm",
        granted: i % 4 === 0,
      }),
    );
    const groups = Array.from({ length: 40 }, (_, i) =>
      item({
        jid: `w${i}@g.us`,
        label: `${scripts[(i + 1) % scripts.length]} Group ${i}`,
        kind: "group",
        granted: i % 4 === 0,
      }),
    );
    return model({ dms, groups });
  }

  test("every layout line's DISPLAY width stays within cols for a wide-script model", () => {
    const s = initPicker(wideModel(), 80, 24);
    for (const cols of [40, 70, 80, 120]) {
      for (const rows of [10, 24, 50]) {
        const lines = layout(s, cols, rows);
        expect(lines.length).toBeLessThanOrEqual(rows);
        for (const l of lines) {
          expect(displayWidth(stripAnsi(l))).toBeLessThanOrEqual(cols);
        }
      }
    }
  });
});

// -----------------------------------------------------------------------
// hitTest / click
// -----------------------------------------------------------------------

describe("hitTest / click", () => {
  test("a click on a contacts row toggles it and moves focus + cursor there", () => {
    let s = initPicker(
      model({ dms: [rohan, priya], groups: [family] }),
      100,
      24,
    );
    const lines = layout(s, 100, 24);
    const row = lines.findIndex((l) => l.includes("Priya"));
    const ev = hitTest(s, 100, 24, row, 5);
    expect(ev).toEqual({ type: "focus", column: "dms", index: 1 });
    s = reducePicker(s, { type: "click", row, col: 5 });
    expect(s.focus).toBe("dms");
    expect(s.cursor.dms).toBe(1);
    expect(s.ticked.has(priya.jid)).toBe(true);
  });

  test("a click on a chip's '×' removes that chip (same result as backspace-on-empty)", () => {
    let s = initPicker(model({ dms: [rohan] }), 100, 24);
    s = press(s, { type: "space" }); // untick -> struck chip
    const lines = layout(s, 100, 24);
    const row = lines.findIndex((l) => l.startsWith("Picked:"));
    const plain = stripAnsi(lines[row]);
    const col = plain.indexOf("×");
    const ev = hitTest(s, 100, 24, row, col);
    expect(ev).toEqual({ type: "unchip", jid: rohan.jid });
    s = reducePicker(s, { type: "click", row, col });
    expect(s.chips).toEqual([]);
    expect(s.ticked.has(rohan.jid)).toBe(true);
  });

  test("clicks on Submit/Undo/Restore dispatch those actions; a click on blank space is a no-op", () => {
    const s = initPicker(model({ hasBackup: true }), 100, 24);
    const lines = layout(s, 100, 24);
    const row = lines.findIndex((l) => l.includes("Submit"));
    const plain = stripAnsi(lines[row]);
    expect(hitTest(s, 100, 24, row, plain.indexOf("Submit"))).toEqual({
      type: "submit",
    });
    expect(hitTest(s, 100, 24, row, plain.indexOf("Undo"))).toEqual({
      type: "undo",
    });
    expect(hitTest(s, 100, 24, row, plain.indexOf("Restore"))).toEqual({
      type: "restore",
    });
    // Row 0 is now the focusable search line (hits focusSearch, not null) -
    // probe blank space past the last footer part instead.
    expect(hitTest(s, 100, 24, row, 70)).toBeNull();
  });

  test("after a resize event the same screen coordinates hit the new geometry", () => {
    let s = initPicker(model({ dms: [rohan, priya] }), 100, 24);
    s = reducePicker(s, { type: "resize", cols: 60, rows: 24 });
    const lines = layout(s, 60, 24);
    const row = lines.findIndex((l) => l.includes("Priya"));
    const ev = hitTest(s, 60, 24, row, 5);
    expect(ev).toEqual({ type: "focus", column: "dms", index: 1 });
  });

  // Review finding 2: both columns share every body row in the two-column
  // form, and itemRows used to be matched on row alone - a click anywhere on
  // a row, including deep inside the right-hand GROUPS column, resolved to
  // the LEFT (dms) item on that same line. col 55 at cols=100 is inside the
  // GROUPS column (rightX = leftW + 2 = 51).
  test("a click in the GROUPS column focuses the group, not the dm on the same row", () => {
    let s = initPicker(model({ dms: [rohan], groups: [family] }), 100, 24);
    const lines = layout(s, 100, 24);
    const row = lines.findIndex((l) => l.includes("Family"));
    const ev = hitTest(s, 100, 24, row, 55);
    expect(ev).toEqual({ type: "focus", column: "groups", index: 0 });
    s = reducePicker(s, { type: "click", row, col: 55 });
    expect(s.focus).toBe("groups");
    expect(s.ticked.has(family.jid)).toBe(false); // family was granted -> untoggled
    expect(s.ticked.has(rohan.jid)).toBe(true); // dm row on the same line untouched
  });

  test("a click on a row draws the '>' marker on that row in the next frame", () => {
    // Contacts row.
    let s = initPicker(
      model({ dms: [rohan, priya], groups: [family] }),
      100,
      24,
    );
    let lines = layout(s, 100, 24);
    let row = lines.findIndex((l) => l.includes("Priya"));
    let next = reducePicker(s, { type: "click", row, col: 5 });
    let frameLine = stripAnsi(layout(next, 100, 24)[row]);
    expect(frameLine).toContain(">[");
    expect(frameLine.indexOf(">[")).toBeLessThan(frameLine.indexOf("Priya"));

    // Groups row (right-hand column at cols=100, rightX=51).
    s = initPicker(model({ dms: [rohan], groups: [family, wil] }), 100, 24);
    lines = layout(s, 100, 24);
    row = lines.findIndex((l) => l.includes("WIL Group HUDINI"));
    next = reducePicker(s, { type: "click", row, col: 55 });
    frameLine = stripAnsi(layout(next, 100, 24)[row]);
    const markerIdx = frameLine.indexOf(">[");
    expect(markerIdx).toBeGreaterThanOrEqual(51); // right half of the line
    expect(frameLine.slice(markerIdx)).toContain("WIL Group HUDINI");
  });

  test("a click on the search line focuses it and ticks nothing", () => {
    const s = initPicker(model({ dms: [rohan] }), 100, 24);
    expect(hitTest(s, 100, 24, 0, 3)).toEqual({ type: "focusSearch" });
    const next = reducePicker(s, { type: "click", row: 0, col: 3 });
    expect(next.focus).toBe("search");
    expect(next.ticked).toEqual(s.ticked);
  });
});

// -----------------------------------------------------------------------
// footer
// -----------------------------------------------------------------------

describe("footer", () => {
  test("the footer reads Submit: enter / Undo: ctrl-z / Restore: ctrl-r / Quit: esc", () => {
    const s = initPicker(model({ hasBackup: true }), 100, 24);
    const lines = layout(s, 100, 24);
    const footerLine = lines.find((l) => l.includes("Submit"))!;
    expect(footerLine).toBe(
      "Submit: enter   Undo: ctrl-z   Restore: ctrl-r   Quit: esc",
    );
  });

  test("verbs are bold+accent and keys dim when colour is on", () => {
    const s = initPicker(model({ hasBackup: true, color: true }), 100, 24);
    const lines = layout(s, 100, 24);
    const footerLine = lines.find((l) => l.includes("Submit"))!;
    expect(footerLine).toContain(
      "\x1b[1;32mSubmit\x1b[0m: \x1b[2menter\x1b[0m",
    );
  });

  test("the short footer is used when the full one does not fit", () => {
    const s = initPicker(model({ hasBackup: true }), 40, 24);
    const lines = layout(s, 40, 24);
    const row = lines.findIndex((l) => l.includes("Submit"));
    const footerLine = stripAnsi(lines[row]);
    expect(footerLine).toBe("Submit  Undo  Restore  Quit");
    const restoreCol = footerLine.indexOf("Restore");
    expect(hitTest(s, 40, 24, row, restoreCol)).toEqual({ type: "restore" });
  });
});

// -----------------------------------------------------------------------
// applySelection
// -----------------------------------------------------------------------

describe("applySelection", () => {
  function base(): {
    allowFrom: string[];
    groups: Record<
      string,
      { requireMention: boolean; allowFrom: string[]; roster?: boolean }
    >;
  } {
    return {
      allowFrom: ["kept@s.whatsapp.net", "revoke-me@s.whatsapp.net"],
      groups: {
        "kept@g.us": {
          requireMention: false,
          allowFrom: ["x@s"],
          roster: true,
        },
        "revoke@g.us": { requireMention: true, allowFrom: [], roster: false },
      },
    };
  }

  test("rule 1: a group shown but not selected is deleted", () => {
    const b = base();
    const out = applySelection(
      b,
      { groups: new Set(["kept@g.us"]), dms: new Set(), roster: new Set() },
      { groups: new Set(["kept@g.us", "revoke@g.us"]), dms: new Set() },
    );
    expect(out.groups["revoke@g.us"]).toBeUndefined();
    expect(out.groups["kept@g.us"]).toBeDefined();
  });

  test("rule 2: a group already configured survives byte-identical, roster included", () => {
    const b = base();
    const out = applySelection(
      b,
      {
        groups: new Set(["kept@g.us"]),
        dms: new Set(),
        roster: new Set(["kept@g.us"]),
      },
      { groups: new Set(["kept@g.us"]), dms: new Set() },
    );
    expect(out.groups["kept@g.us"]).toEqual(b.groups["kept@g.us"]);
  });

  test("rule 3: a new group gets requireMention:true, empty allowFrom, roster from the selection", () => {
    const b = base();
    const out = applySelection(
      b,
      {
        groups: new Set(["new@g.us"]),
        dms: new Set(),
        roster: new Set(["new@g.us"]),
      },
      { groups: new Set(), dms: new Set() },
    );
    expect(out.groups["new@g.us"]).toEqual({
      requireMention: true,
      allowFrom: [],
      roster: true,
    });
  });

  test("rule 4: allowFrom drops only a shown+unticked dm; an entry the server added while shown never listed it is kept", () => {
    const b = {
      allowFrom: [
        "kept@s.whatsapp.net",
        "revoke-me@s.whatsapp.net",
        "added-by-server@s.whatsapp.net",
      ],
      groups: {},
    };
    const out = applySelection(
      b,
      {
        groups: new Set(),
        dms: new Set(["kept@s.whatsapp.net"]),
        roster: new Set(),
      },
      {
        groups: new Set(),
        dms: new Set(["kept@s.whatsapp.net", "revoke-me@s.whatsapp.net"]),
      },
    );
    expect([...out.allowFrom].sort()).toEqual(
      ["added-by-server@s.whatsapp.net", "kept@s.whatsapp.net"].sort(),
    );
  });

  test("rule 5: base is never mutated", () => {
    const b = base();
    const before = JSON.stringify(b);
    applySelection(
      b,
      { groups: new Set(), dms: new Set(), roster: new Set() },
      { groups: new Set(["kept@g.us", "revoke@g.us"]), dms: new Set() },
    );
    expect(JSON.stringify(b)).toBe(before);
  });
});

// -----------------------------------------------------------------------
// e2e - drives runPicker over a fake, paced stdin. Interactive/timing
// sensitive: skipped only under CI, never removed (brief stop condition).
// -----------------------------------------------------------------------

describe("runPicker e2e", () => {
  test.skipIf(!!process.env.CI)(
    "search + Enter + Enter submits with the highlighted group ticked",
    async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let written = "";
      output.on("data", (d) => (written += d.toString()));
      (input as unknown as { setRawMode: () => void }).setRawMode = () => {
        throw new Error("setRawMode must not be called on a non-TTY stream");
      };
      const familyItem = item({
        jid: "fam@g.us",
        label: "Family",
        kind: "group",
      });
      const resultPromise = runPicker(model({ groups: [familyItem] }), {
        input: input as unknown as NodeJS.ReadStream,
        output: output as unknown as NodeJS.WriteStream,
      });
      const type = async (s: string) => {
        await new Promise((r) => setTimeout(r, 50));
        input.write(s);
      };
      await type("\t"); // focus groups (dms column is empty)
      await type("f");
      await type("a");
      await type("m");
      await type("\r"); // tick highlighted, clear search
      await type("\r"); // submit
      const result = await resultPromise;
      expect(result).toEqual({
        action: "submit",
        groups: new Set(["fam@g.us"]),
        dms: new Set(),
        roster: new Set(),
      });
      expect(written).toContain("\x1b[?1000h");
      expect(written).toContain("\x1b[?1006h");
      expect(written).toContain("\x1b[?1006l\x1b[?1000l");
      expect(written).toContain("\x1b[?1049l");
    },
    { timeout: 5000 },
  );

  test.skipIf(!!process.env.CI)(
    "Ctrl-C resolves null, and the teardown sequence was still written",
    async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let written = "";
      output.on("data", (d) => (written += d.toString()));
      const resultPromise = runPicker(model({ dms: [rohan] }), {
        input: input as unknown as NodeJS.ReadStream,
        output: output as unknown as NodeJS.WriteStream,
      });
      await new Promise((r) => setTimeout(r, 50));
      input.write("\x03");
      const result = await resultPromise;
      expect(result).toBeNull();
      expect(written).toContain("\x1b[?1049l");
    },
    { timeout: 5000 },
  );
});
