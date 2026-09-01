import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
    const ctx = parsed.systemMessage as string;
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
    const ctx = parsed.systemMessage as string;
    expect(ctx).toContain(`WhatsApp plugin updated to v${PLUGIN_VERSION}`);
    expect(ctx).not.toContain("(from v");
    expect(readFileSync(join(dir, ".last-seen-version"), "utf8")).toBe(
      PLUGIN_VERSION,
    );
  });

  // Regression: CHANGELOG is newest-first, so the no-marker fallback has to
  // take the HEAD of the array. slice(-1) took the tail — the OLDEST entry —
  // and shipped a notice headed with the current version over notes from the
  // first release in the file. The test above asserts only the header, which
  // is exactly why that went unnoticed.
  //
  // The head note is read out of the source rather than pasted in, so this
  // keeps testing the slice direction instead of needing an edit every time
  // a release adds an entry — which is what it used to need, and what would
  // tempt the next person to "fix" it by pasting the new text in.
  test("first-ever run shows the NEWEST changelog entry, not the oldest", () => {
    const source = readFileSync(join(import.meta.dir, "update-notice.ts"), {
      encoding: "utf8",
    });
    // First string literal of at least 30 plain characters after the first
    // `notes: [` — i.e. the head entry's first note. Literals carrying a
    // ${...} interpolation are skipped: the source text and the rendered
    // output differ there, so they cannot be compared against the notice.
    const headNote = source
      .slice(source.indexOf("notes: ["))
      .match(/["`]([^"`$]{30,})/)?.[1];
    expect(headNote).toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), "wa-notice-newest-"));
    const ctx = JSON.parse(run(dir)).systemMessage as string;
    expect(ctx).toContain(headNote!.slice(0, 40));
    expect(ctx).not.toContain("Proactive notifications");
  });

  // Regression: a downgrade leaves changedVersion true while the version
  // filter matches nothing, which emitted "updated to v<older>" over an empty
  // bullet list — a false claim the model is explicitly told to relay. The
  // marker still has to advance, or every later session repeats the mistake.
  test("a downgrade says nothing but still records the version", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-notice-downgrade-"));
    writeFileSync(join(dir, ".last-seen-version"), "99.0.0");
    const out = run(dir);
    expect(out).not.toContain("What's new");
    expect(readFileSync(join(dir, ".last-seen-version"), "utf8")).toBe(
      PLUGIN_VERSION,
    );
  });

  // The head-of-CHANGELOG fallback above is only truthful while the head IS
  // the shipping version. Bump plugin.json without adding an entry and the
  // first-run notice says "updated to v0.21.0" over v0.20.0's bullets - the
  // same header/body mismatch, one version narrower. Nothing else enforces
  // the pairing, so this test is the enforcement: it fails at release time,
  // when adding the missing entry is trivial.
  test("the newest CHANGELOG entry is the version actually shipping", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-notice-invariant-"));
    const ctx = JSON.parse(run(dir)).systemMessage as string;
    const source = readFileSync(join(import.meta.dir, "update-notice.ts"), {
      encoding: "utf8",
    });
    const firstEntry = source.match(/version:\s*"([^"]+)"/)?.[1];
    expect(firstEntry).toBe(PLUGIN_VERSION);
    expect(ctx).toContain(`updated to v${PLUGIN_VERSION}`);
  });

  // Mechanizes AGENTS.md's Hard Rule 1 ("version bump on every push"), which
  // was prose-only before this: plugin.json and marketplace.json's
  // plugins[0].version must move together, or `plugin update` silently
  // no-ops for users stuck on the stale one. marketplace.json ALSO has a
  // top-level `version` (the marketplace's own) - deliberately not compared
  // here, since it tracks something else entirely.
  test("plugin.json's version matches marketplace.json's plugins[0].version", () => {
    const marketplace = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", ".claude-plugin", "marketplace.json"),
        "utf8",
      ),
    );
    const listedVersion = marketplace.plugins?.find(
      (p: { name?: string }) => p.name === "whatsapp-channel",
    )?.version;
    expect(listedVersion).toBe(PLUGIN_VERSION);
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

// Issue #2: the notice above can only ever announce a version the user
// ALREADY has, so the plugin could never say "a newer one is waiting".
// These build a real install tree in a temp dir - cache/<marketplace>/
// <plugin>/<version> next to marketplaces/<marketplace>/ - and run the real
// script from inside it, so the path derivation itself is under test, not a
// stubbed-out version of it.
describe("update available", () => {
  function fakeInstall(
    installed: string,
    marketplacePlugins: { name?: string; version?: string }[] | null,
    pluginName = "whatsapp-channel",
    marketplaceName = "whatsapp-claude-plugin",
  ): string {
    const root = mkdtempSync(join(tmpdir(), "wa-install-"));
    const pluginDir = join(
      root,
      "plugins",
      "cache",
      marketplaceName,
      pluginName,
      installed,
    );
    mkdirSync(join(pluginDir, "scripts"), { recursive: true });
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: pluginName, version: installed }),
    );
    for (const f of ["update-notice.ts", "wizard-cmd.ts"]) {
      copyFileSync(join(import.meta.dir, f), join(pluginDir, "scripts", f));
    }
    if (marketplacePlugins !== null) {
      const mktDir = join(
        root,
        "plugins",
        "marketplaces",
        marketplaceName,
        ".claude-plugin",
      );
      mkdirSync(mktDir, { recursive: true });
      writeFileSync(
        join(mktDir, "marketplace.json"),
        JSON.stringify({ name: marketplaceName, plugins: marketplacePlugins }),
      );
    }
    return join(pluginDir, "scripts", "update-notice.ts");
  }

  function runInstalled(
    script: string,
    stateDir: string,
    modelContext?: string,
  ): string {
    return execFileSync(
      "bun",
      modelContext ? [script, modelContext] : [script],
      {
        env: { ...process.env, WHATSAPP_STATE_DIR: stateDir },
        encoding: "utf8",
      },
    );
  }

  function currentState(version: string): string {
    const dir = mkdtempSync(join(tmpdir(), "wa-notice-avail-"));
    // Marker already current, so the "what's new" notice cannot fire and
    // anything printed is the available-update notice alone.
    writeFileSync(join(dir, ".last-seen-version"), version);
    return dir;
  }

  test("announces a newer version that is on offer but not installed", () => {
    const script = fakeInstall("0.19.0", [
      { name: "whatsapp-channel", version: "0.20.0" },
    ]);
    const ctx = JSON.parse(runInstalled(script, currentState("0.19.0")))
      .systemMessage as string;
    expect(ctx).toContain("v0.20.0");
    expect(ctx).toContain("v0.19.0");
    expect(ctx).toContain("claude plugin update whatsapp-channel");
  });

  test("says nothing when the installed version is already the offered one", () => {
    const script = fakeInstall("0.19.0", [
      { name: "whatsapp-channel", version: "0.19.0" },
    ]);
    expect(runInstalled(script, currentState("0.19.0"))).toBe("");
  });

  test("says nothing when the install is AHEAD of the marketplace", () => {
    // A local dev build, or a marketplace clone that has not refreshed yet.
    const script = fakeInstall("0.20.0", [
      { name: "whatsapp-channel", version: "0.19.0" },
    ]);
    expect(runInstalled(script, currentState("0.20.0"))).toBe("");
  });

  test("numeric version compare, so 0.9.0 is not treated as newer than 0.19.0", () => {
    const script = fakeInstall("0.19.0", [
      { name: "whatsapp-channel", version: "0.9.0" },
    ]);
    expect(runInstalled(script, currentState("0.19.0"))).toBe("");
  });

  test("picks its OWN entry, not whichever plugin the marketplace lists first", () => {
    const script = fakeInstall("0.19.0", [
      { name: "some-other-plugin", version: "9.9.9" },
      { name: "whatsapp-channel", version: "0.20.0" },
    ]);
    const ctx = JSON.parse(runInstalled(script, currentState("0.19.0")))
      .systemMessage as string;
    expect(ctx).toContain("v0.20.0");
    expect(ctx).not.toContain("9.9.9");
  });

  test("no marketplace clone at all (a repo checkout) is silent, not a crash", () => {
    const script = fakeInstall("0.19.0", null);
    expect(runInstalled(script, currentState("0.19.0"))).toBe("");
  });

  test("a marketplace file that is not valid JSON is silent, not a crash", () => {
    const script = fakeInstall("0.19.0", [
      { name: "whatsapp-channel", version: "0.20.0" },
    ]);
    // script is <root>/plugins/cache/<mkt>/<plugin>/<ver>/scripts/x.ts, so
    // six hops up lands on <root>/plugins.
    const bad = join(
      script,
      "..",
      "..",
      "..",
      "..",
      "..",
      "..",
      "marketplaces",
      "whatsapp-claude-plugin",
      ".claude-plugin",
      "marketplace.json",
    );
    writeFileSync(bad, "{ not json");
    expect(runInstalled(script, currentState("0.19.0"))).toBe("");
  });

  // The "what's new" notice burns its one chance the moment it fires, because
  // the marker advances right after. This one must not, or a session where
  // the model failed to relay it would be the only session that ever had it.
  test("repeats every session - it is not gated on the seen-version marker", () => {
    const script = fakeInstall("0.19.0", [
      { name: "whatsapp-channel", version: "0.20.0" },
    ]);
    const dir = currentState("0.19.0");
    expect(runInstalled(script, dir)).not.toBe("");
    expect(runInstalled(script, dir)).not.toBe("");
  });

  // The notice is for the human, so it must ride on systemMessage (shown to
  // them) and NOT on additionalContext (folded into model context, billed,
  // and only seen if the model chooses to repeat it).
  test("the notice goes to the user channel, never into model context", () => {
    const script = fakeInstall("0.19.0", [
      { name: "whatsapp-channel", version: "0.20.0" },
    ]);
    const out = JSON.parse(runInstalled(script, currentState("0.19.0")));
    expect(out.systemMessage).toContain("v0.20.0");
    expect(JSON.stringify(out.hookSpecificOutput ?? {})).not.toContain(
      "v0.20.0",
    );
  });

  // The notice replaces the calling hook's entire JSON output, so the caller
  // hands its model-facing message over to be carried through. Without it a
  // session that happens to see a notice would brief the model with nothing.
  test("carries the caller's model-facing message through untouched", () => {
    const script = fakeInstall("0.19.0", [
      { name: "whatsapp-channel", version: "0.20.0" },
    ]);
    const out = JSON.parse(
      runInstalled(script, currentState("0.19.0"), "briefing for the model"),
    );
    expect(out.hookSpecificOutput.additionalContext).toBe(
      "briefing for the model",
    );
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.systemMessage).toContain("v0.20.0");
  });
});
