import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drives the real SessionStart hook (bash), not a reimplementation, against
// a scratch WHATSAPP_STATE_DIR — the same override server.ts and
// update-notice.ts honor. The hook always exits 0 and prints one JSON
// object; what varies is additionalContext (model-facing) and, when there is
// an update to announce, systemMessage (user-facing).
const HOOK = join(import.meta.dir, "..", "hooks-handlers", "session-start.sh");
const PLUGIN_VERSION: string = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", ".claude-plugin", "plugin.json"),
    "utf8",
  ),
).version;

function runHookRaw(dir: string): Record<string, any> {
  return JSON.parse(
    execFileSync("bash", [HOOK], {
      env: { ...process.env, WHATSAPP_STATE_DIR: dir },
      encoding: "utf8",
    }),
  );
}

function runHook(dir: string): string {
  return runHookRaw(dir).hookSpecificOutput.additionalContext as string;
}

// A state dir as the current code actually writes it: pretty-printed JSON
// everywhere (JSON.stringify(x, null, 2)).
function configuredStateDir(opts: { allowFrom: string[] }): string {
  const dir = mkdtempSync(join(tmpdir(), "wa-hook-"));
  writeFileSync(join(dir, ".env"), "WHATSAPP_PHONE_NUMBER=886900000000\n");
  mkdirSync(join(dir, ".baileys_auth"));
  writeFileSync(
    join(dir, ".baileys_auth", "creds.json"),
    JSON.stringify({ registered: true }, null, 2) + "\n",
  );
  writeFileSync(
    join(dir, "access.json"),
    JSON.stringify(
      { dmPolicy: "allowlist", allowFrom: opts.allowFrom, groups: {} },
      null,
      2,
    ) + "\n",
  );
  // Keep the update notice quiet unless a test overwrites this — these tests
  // are about the state-detection branches, not the notice.
  writeFileSync(join(dir, ".last-seen-version"), PLUGIN_VERSION);
  return dir;
}

describe("session-start.sh", () => {
  // Regression: the old check grepped the file for compact
  // '"allowFrom":[".' and never matched the pretty-printed form everything
  // writes, so every configured install was greeted as having no contacts.
  test("pretty-printed access.json with contacts → fully-configured message", () => {
    const dir = configuredStateDir({
      allowFrom: ["886900000000@s.whatsapp.net"],
    });
    expect(runHook(dir)).toContain("fully configured and ready");
  });

  test("compact (legacy) access.json with contacts is still recognized", () => {
    const dir = configuredStateDir({
      allowFrom: ["886900000000@s.whatsapp.net"],
    });
    writeFileSync(
      join(dir, "access.json"),
      '{"dmPolicy":"allowlist","allowFrom":["886900000000@s.whatsapp.net"],"groups":{}}\n',
    );
    expect(runHook(dir)).toContain("fully configured and ready");
  });

  test("empty allowFrom → still the no-contacts onboarding message", () => {
    const dir = configuredStateDir({ allowFrom: [] });
    expect(runHook(dir)).toContain("no contacts are allowlisted yet");
  });

  test("pretty-printed creds.json ('registered': true with space) counts as paired", () => {
    // configuredStateDir writes creds pretty-printed already; getting past
    // the has_auth branch to the fully-configured message proves it matched.
    const dir = configuredStateDir({
      allowFrom: ["886900000000@s.whatsapp.net"],
    });
    expect(runHook(dir)).not.toContain("not paired yet");
  });

  // The 0.18.0 update notice only fires from the fully-configured branch —
  // exactly the branch this bug made unreachable, which is how it shipped
  // dead. End-to-end through the hook, not just update-notice.ts's own tests.
  test("update notice reaches the hook output when the recorded version is older", () => {
    const dir = configuredStateDir({
      allowFrom: ["886900000000@s.whatsapp.net"],
    });
    writeFileSync(join(dir, ".last-seen-version"), "0.9.0");
    const out = runHookRaw(dir);
    // The notice itself is user-facing, and the model still gets the same
    // briefing it would have had with no notice at all.
    expect(out.systemMessage).toContain(
      `WhatsApp plugin updated to v${PLUGIN_VERSION}`,
    );
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "fully configured and ready",
    );
  });
});
