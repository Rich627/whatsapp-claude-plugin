import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
    writeFileSync(
      store,
      `*/2 * * * * ${target} >> ${join(dir, "watchdog.log")} 2>&1\n`,
    );
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
    expect(out).toContain(
      "[INFO] watchdog-file: installed with local modifications",
    );
  });

  test("status is the default subcommand", () => {
    const out = runScript(freshStateDir(), freshCronStore());
    expect(out).toContain("[INFO] watchdog-file: not installed");
  });
});

describe("install", () => {
  test("fresh install: file copied executable, cron line appended", () => {
    const dir = freshStateDir();
    const store = freshCronStore();
    const out = runScript(dir, store, "install");
    const target = join(dir, "watchdog.sh");
    expect(readFileSync(target, "utf8")).toBe(
      readFileSync(REPO_WATCHDOG, "utf8"),
    );
    // executable bit set
    expect(() => execFileSync("test", ["-x", target])).not.toThrow();
    const cron = readFileSync(store, "utf8");
    expect(cron).toContain(`*/2 * * * * ${target}`);
    expect(cron).toContain("watchdog.log");
    expect(out).toContain("[PASS] watchdog-cron:");
  });

  test("re-run is idempotent: no duplicate cron line, no rewrite", () => {
    const dir = freshStateDir();
    const store = freshCronStore();
    runScript(dir, store, "install");
    const out = runScript(dir, store, "install");
    const cron = readFileSync(store, "utf8");
    const hits = cron
      .split("\n")
      .filter((l) => l.includes(join(dir, "watchdog.sh"))).length;
    expect(hits).toBe(1);
    expect(out).toContain("already");
  });

  test("customized watchdog.sh is NOT overwritten (WARN), cron still handled", () => {
    const dir = freshStateDir();
    const store = freshCronStore();
    const custom = "#!/bin/bash\n# my custom fork\n";
    writeFileSync(join(dir, "watchdog.sh"), custom);
    chmodSync(join(dir, "watchdog.sh"), 0o755);
    const out = runScript(dir, store, "install");
    expect(readFileSync(join(dir, "watchdog.sh"), "utf8")).toBe(custom);
    expect(out).toContain("[WARN] watchdog-file:");
    expect(readFileSync(store, "utf8")).toContain(
      `*/2 * * * * ${join(dir, "watchdog.sh")}`,
    );
  });

  test("existing unrelated crontab lines preserved byte-for-byte", () => {
    const dir = freshStateDir();
    const store = freshCronStore();
    const existing =
      "0 9 * * * /usr/local/bin/backup.sh # nightly\n*/5 * * * * echo hi\n";
    writeFileSync(store, existing);
    runScript(dir, store, "install");
    const cron = readFileSync(store, "utf8");
    expect(cron.startsWith(existing)).toBe(true);
    expect(cron).toContain(`*/2 * * * * ${join(dir, "watchdog.sh")}`);
  });

  test("missing state dir → ERROR, nothing done", () => {
    const store = freshCronStore();
    const out = runScript(
      join(tmpdir(), "definitely-absent-state-dir-xyz"),
      store,
      "install",
    );
    expect(out).toContain("[ERROR] watchdog-file:");
    expect(existsSync(store)).toBe(false);
  });

  test("read-only state dir → ERROR, crontab never touched", () => {
    const dir = freshStateDir();
    const store = freshCronStore();
    // Make state dir read-only so copy/chmod will fail
    chmodSync(dir, 0o555);
    const out = runScript(dir, store, "install");
    expect(out).toContain("[ERROR] watchdog-file:");
    // Verify crontab was never written to (store file does not exist)
    expect(existsSync(store)).toBe(false);
    // Restore permissions for cleanup
    chmodSync(dir, 0o755);
  });
});

describe("uninstall", () => {
  test("removes only the watchdog line; file and other lines stay", () => {
    const dir = freshStateDir();
    const store = freshCronStore();
    writeFileSync(store, "0 9 * * * /usr/local/bin/backup.sh\n");
    runScript(dir, store, "install");
    const out = runScript(dir, store, "uninstall");
    const cron = readFileSync(store, "utf8");
    expect(cron).toContain("backup.sh");
    expect(cron).not.toContain("watchdog.sh");
    expect(existsSync(join(dir, "watchdog.sh"))).toBe(true);
    expect(out).toContain("[PASS] watchdog-cron: removed");
  });

  test("nothing to remove → INFO", () => {
    const out = runScript(freshStateDir(), freshCronStore(), "uninstall");
    expect(out).toContain("[INFO] watchdog-cron: no crontab entry to remove");
  });
});
