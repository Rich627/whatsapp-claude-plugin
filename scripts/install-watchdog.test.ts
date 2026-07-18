import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "install-watchdog.ts");
const REPO_WATCHDOG = join(import.meta.dir, "watchdog.sh");

// Fake `crontab` put first on PATH: `-l` prints the store file (exit 1 if
// absent, like real crontab with no crontab yet), `-` writes stdin to it.
let stubDir: string;
beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "crontab-stub-"));
  const stub = join(stubDir, "crontab");
  writeFileSync(
    stub,
    `#!/bin/sh
if [ "$1" = "-l" ]; then
  [ -f "$CRONTAB_STORE" ] || { echo "no crontab for $(whoami)" >&2; exit 1; }
  cat "$CRONTAB_STORE"
else
  cat > "$CRONTAB_STORE"
fi
`,
  );
  chmodSync(stub, 0o755);
});

// execFileSync throws on nonzero exit, so every passing test also proves
// the exit-0 contract (same trick as doctor.test.ts).
function runScript(stateDir: string, cronStore: string, arg?: string): string {
  return execFileSync("bun", arg ? [SCRIPT, arg] : [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      WHATSAPP_STATE_DIR: stateDir,
      CRONTAB_STORE: cronStore,
      PATH: `${stubDir}:${process.env.PATH}`,
    },
  });
}

function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), "watchdog-fixture-"));
}

function freshCronStore(): string {
  // A path inside a fresh temp dir; the file itself does not exist yet
  // (= user has no crontab).
  return join(mkdtempSync(join(tmpdir(), "cron-store-")), "store");
}

describe("status", () => {
  test("nothing installed → INFO for file and cron", () => {
    const out = runScript(freshStateDir(), freshCronStore(), "status");
    expect(out).toContain("[INFO] watchdog-file: not installed");
    expect(out).toContain("[INFO] watchdog-cron: no crontab entry");
  });

  test("file installed + cron entry → PASS for both", () => {
    const dir = freshStateDir();
    const store = freshCronStore();
    const target = join(dir, "watchdog.sh");
    writeFileSync(target, readFileSync(REPO_WATCHDOG));
    chmodSync(target, 0o755);
    writeFileSync(store, `*/2 * * * * ${target} >> ${join(dir, "watchdog.log")} 2>&1\n`);
    const out = runScript(dir, store, "status");
    expect(out).toContain("[PASS] watchdog-file:");
    expect(out).toContain("[PASS] watchdog-cron:");
  });

  test("file present but not executable → WARN", () => {
    const dir = freshStateDir();
    const target = join(dir, "watchdog.sh");
    writeFileSync(target, readFileSync(REPO_WATCHDOG));
    chmodSync(target, 0o644);
    const out = runScript(dir, freshCronStore(), "status");
    expect(out).toContain("[WARN] watchdog-file:");
    expect(out).toContain("not executable");
  });

  test("file customized (differs from repo copy) → INFO noting local edits", () => {
    const dir = freshStateDir();
    writeFileSync(join(dir, "watchdog.sh"), "#!/bin/bash\n# my custom fork\n");
    chmodSync(join(dir, "watchdog.sh"), 0o755);
    const out = runScript(dir, freshCronStore(), "status");
    expect(out).toContain("[INFO] watchdog-file: installed with local modifications");
  });

  test("status is the default subcommand", () => {
    const out = runScript(freshStateDir(), freshCronStore());
    expect(out).toContain("[INFO] watchdog-file: not installed");
  });
});
