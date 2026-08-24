import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Spawns the real script (not a reimplementation of its logic) with
// WHATSAPP_STATE_DIR pointed at a scratch dir, same override server.ts
// itself supports for tests.
const SCRIPT = join(import.meta.dir, "update-notice.ts");
const PLUGIN_VERSION: string = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", ".claude-plugin", "plugin.json"),
    "utf8",
  ),
).version;

function run(dir: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync("bun", [SCRIPT], {
    env: { ...process.env, WHATSAPP_STATE_DIR: dir, ...extraEnv },
    encoding: "utf8",
  });
}

describe("update-notice.ts", () => {
  // "0.9.0" is deliberately not "0.1.0": version comparison must be
  // numeric ("0.18.0" > "0.9.0"), not a plain string compare (where
  // "0.18.0" < "0.9.0" because "1" < "9").
  test("announces once when the recorded version is older, using numeric version compare", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-notice-old-"));
    writeFileSync(join(dir, ".last-seen-version"), "0.9.0");
    const parsed = JSON.parse(run(dir));
    const ctx = parsed.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain(
      `WhatsApp plugin updated to v${PLUGIN_VERSION} (from v0.9.0)`,
    );
    expect(ctx).toContain("scripts/access.ts");
    expect(readFileSync(join(dir, ".last-seen-version"), "utf8")).toBe(
      PLUGIN_VERSION,
    );
  });

  test("stays quiet (empty stdout) when the recorded version already matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-notice-current-"));
    writeFileSync(join(dir, ".last-seen-version"), PLUGIN_VERSION);
    expect(run(dir)).toBe("");
  });

  test("first-ever run (never recorded) still writes the marker and shows only the latest entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-notice-first-"));
    const parsed = JSON.parse(run(dir));
    const ctx = parsed.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain(`WhatsApp plugin updated to v${PLUGIN_VERSION}`);
    expect(ctx).not.toContain("(from v");
    expect(readFileSync(join(dir, ".last-seen-version"), "utf8")).toBe(
      PLUGIN_VERSION,
    );
  });

  test("skipped entirely in static mode (env var) — no output, no write", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-notice-static-env-"));
    writeFileSync(join(dir, ".last-seen-version"), "0.1.0");
    expect(run(dir, { WHATSAPP_ACCESS_MODE: "static" })).toBe("");
  });

  // Regression: server.ts's own .env loader strips surrounding quotes
  // before comparing, so WHATSAPP_ACCESS_MODE="static" (quoted) must be
  // detected the same way here, not just the bare unquoted form.
  test("skipped in static mode set via a quoted .env value", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-notice-static-quoted-"));
    writeFileSync(join(dir, ".env"), 'WHATSAPP_ACCESS_MODE="static"\n');
    writeFileSync(join(dir, ".last-seen-version"), "0.1.0");
    expect(run(dir)).toBe("");
  });

  // Regression: a hand-rolled JSON heredoc would break if .last-seen-version
  // ever contained a quote or backslash; JSON.stringify can't.
  test("output is valid JSON even when .last-seen-version contains quote/backslash characters", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-notice-inject-"));
    writeFileSync(join(dir, ".last-seen-version"), '0.9.0"; \\ malicious');
    const out = run(dir);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});
