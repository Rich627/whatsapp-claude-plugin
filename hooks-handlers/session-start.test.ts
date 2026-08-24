import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "session-start.sh");

// Sources just the function/array defs from the hook script (everything
// before "# Check setup state") so this exercises the actual shipped
// version_gt() and CHANGELOG_* arrays, not a reimplementation of them.
// Moved here from server.ts's old announceUpdateIfNeeded() tests when the
// update-notice logic relocated to this hook (see PR review on #22).
function evalHookLogic(script: string): string {
  return execFileSync(
    "bash",
    [
      "-c",
      `source <(sed -n '1,/^# Check setup state/p' "${HOOK}" | head -n -1); ${script}`,
    ],
    { encoding: "utf8" },
  );
}

describe("session-start.sh: version_gt()", () => {
  // "0.9.0" is deliberately not "0.1.0": version_gt() must compare
  // numerically ("0.18.0" > "0.9.0"), not as strings (where "0.18.0" <
  // "0.9.0" because "1" < "9"). A naive string compare would wrongly treat
  // 0.9.0 as newer and skip the notice entirely.
  test("0.18.0 > 0.9.0 (numeric, not string, compare)", () => {
    const out = evalHookLogic(
      `version_gt "0.18.0" "0.9.0" && echo yes || echo no`,
    );
    expect(out.trim()).toBe("yes");
  });

  test("0.9.0 is not > 0.18.0", () => {
    const out = evalHookLogic(
      `version_gt "0.9.0" "0.18.0" && echo yes || echo no`,
    );
    expect(out.trim()).toBe("no");
  });

  test("equal versions are not >", () => {
    const out = evalHookLogic(
      `version_gt "0.18.0" "0.18.0" && echo yes || echo no`,
    );
    expect(out.trim()).toBe("no");
  });

  test("anything is > an empty (never-recorded) version", () => {
    const out = evalHookLogic(`version_gt "0.18.0" "" && echo yes || echo no`);
    expect(out.trim()).toBe("yes");
  });
});

describe("session-start.sh: update-notice note selection", () => {
  // Real CHANGELOG_VERSIONS/CHANGELOG_NOTES has one entry today, which can't
  // tell "only the latest" apart from "all newer" — so this stubs two
  // entries to actually exercise both branches, same as
  // announceUpdateIfNeeded()'s old CHANGELOG.slice(-1) vs .filter() split.
  const selectNotes = (lastSeen: string) => `
    CHANGELOG_VERSIONS=("0.17.0" "0.18.0")
    CHANGELOG_NOTES=("old note" "new note")
    last_seen="${lastSeen}"
    notes=""
    if [ -z "$last_seen" ]; then
      last_idx=$((\${#CHANGELOG_VERSIONS[@]} - 1))
      notes="\${CHANGELOG_NOTES[$last_idx]}"
    else
      for i in "\${!CHANGELOG_VERSIONS[@]}"; do
        if version_gt "\${CHANGELOG_VERSIONS[$i]}" "$last_seen"; then
          notes="\${notes:+\${notes}|}\${CHANGELOG_NOTES[$i]}"
        fi
      done
    fi
    echo -n "$notes"
  `;

  test("never recorded shows only the latest entry, not the whole history", () => {
    const out = evalHookLogic(selectNotes(""));
    expect(out).toBe("new note");
  });

  test("an older recorded version shows every entry newer than it", () => {
    const out = evalHookLogic(selectNotes("0.9.0"));
    expect(out).toBe("old note|new note");
  });

  test("a current recorded version shows nothing", () => {
    const out = evalHookLogic(selectNotes("0.18.0"));
    expect(out).toBe("");
  });
});

describe("session-start.sh: WIZARD_CMD", () => {
  // Same fix as server.ts's WIZARD_CMD (PR #22 review): absolute, not
  // "bun scripts/access.ts wizard", since a marketplace install runs from
  // ~/.claude/plugins/cache/.../<version>/, where the relative form
  // resolves to nothing.
  test("is an absolute path with JSON-escaped quotes, not the relative form", () => {
    const out = evalHookLogic(`echo -n "$WIZARD_CMD"`);
    expect(out).toContain('\\"');
    expect(out).toContain("/scripts/access.ts");
    expect(out).not.toBe("bun scripts/access.ts wizard");
  });
});

describe("session-start.sh: full JSON output", () => {
  // The script hand-rolls JSON via a heredoc rather than a real encoder, so
  // this is the one check that catches an unescaped quote or backtick
  // breaking the emitted JSON once real note text (which wraps WIZARD_CMD in
  // markdown backticks) gets spliced in.
  test("update notice renders as valid, parseable JSON", () => {
    const out = evalHookLogic(`
      last_seen="0.9.0"
      current_version="0.18.0"
      notes=""
      for i in "\${!CHANGELOG_VERSIONS[@]}"; do
        if version_gt "\${CHANGELOG_VERSIONS[$i]}" "$last_seen"; then
          notes="\${notes:+\${notes}\\n}\${CHANGELOG_NOTES[$i]}"
        fi
      done
      from_suffix=" (from v\${last_seen})"
      msg="WhatsApp plugin updated to v\${current_version}\${from_suffix}.\\n\\nWhat's new:\\n\${notes}"
      cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "\${msg}"
  }
}
EOF
    `);
    const parsed = JSON.parse(out);
    const ctx: string = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("WhatsApp plugin updated to v0.18.0 (from v0.9.0)");
    expect(ctx).toContain("scripts/access.ts");
    expect(ctx).toContain("`bun");
  });
});
