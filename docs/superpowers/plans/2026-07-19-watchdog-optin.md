# Watchdog Opt-in (v0.14.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Setup asks "want auto-recovery?" and on yes deterministically installs the watchdog (copy + chmod + append-only crontab entry) via a tested bun script.

**Architecture:** Same pattern as v0.13.0 doctor — a deterministic bun script (`scripts/install-watchdog.ts`, subcommands `status|install|uninstall`) does all mutations; a thin new phase in `skills/setup/SKILL.md` drives the conversation. Doctor's watchdog-absent message points at setup.

**Tech Stack:** Bun + TypeScript, `bun test`. No new dependencies. Spec: `docs/superpowers/specs/2026-07-19-watchdog-optin-design.md`.

## Global Constraints

- No new dependencies; no imports from `server.ts`; `server.ts` is NOT touched.
- `WHATSAPP_STATE_DIR` env overrides the state dir (default `~/.whatsapp-channel`), same as `scripts/doctor.ts:30-31`.
- Output contract (parsed by skills): `[PASS|INFO|WARN|ERROR] <check-id>: <message>` lines; script always exits 0.
- Tests must never touch the real crontab or real `~/.whatsapp-channel` — `crontab` is stubbed via PATH, state dir via `WHATSAPP_STATE_DIR`.
- Version bump 0.13.2 → 0.14.0 in BOTH `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` `plugins[0].version` (NOT marketplace's top-level `version`).
- Before push: lint the full diff (docs included) with `~/.cache/trunk/launcher/trunk check`; commit locally, maintainer reviews before push.
- git: stage only files this plan creates/modifies — `docs/governance/` and other sessions' changes must never be swept in; re-run `git status --short` before every commit.

---

### Task 1: `install-watchdog.ts` skeleton + `status` subcommand

**Files:**

- Create: `scripts/install-watchdog.ts`
- Test: `scripts/install-watchdog.test.ts`

**Interfaces:**

- Produces: CLI `bun scripts/install-watchdog.ts [status|install|uninstall]` (default `status`); env `WHATSAPP_STATE_DIR`; report lines `[SEV] watchdog-file: …` / `[SEV] watchdog-cron: …`.
- Produces (for Tasks 2–3, module-internal): `STATE_DIR`, `SOURCE`, `TARGET`, `LOG_FILE`, `report()`, `readCrontab()`, `writeCrontab()`, `cronReferencesWatchdog()`, `CRON_LINE`.
- Test harness produces (for Tasks 2–3): `runScript(stateDir, cronStore, args)`, `freshStateDir()`, `stubDir` with fake `crontab`.

- [ ] **Step 1: Write the test file with harness + status tests**

```typescript
// scripts/install-watchdog.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/install-watchdog.test.ts`
Expected: FAIL — `install-watchdog.ts` does not exist (bun exec error in every test).

- [ ] **Step 3: Write the script with shared helpers + status**

```typescript
#!/usr/bin/env bun
/**
 * install-watchdog.ts — install/verify/remove the watchdog cron job.
 *
 * Usage:            bun scripts/install-watchdog.ts [status|install|uninstall]
 * Fixture/testing:  WHATSAPP_STATE_DIR=/path + a stubbed `crontab` on PATH.
 *
 * status    — report file + crontab state (read-only)
 * install   — copy scripts/watchdog.sh → $STATE_DIR/watchdog.sh, chmod +x,
 *             append a crontab entry. Never overwrites a locally modified
 *             watchdog.sh; never touches existing crontab lines.
 * uninstall — remove only the watchdog crontab line(s); the file stays.
 *
 * Output contract (parsed by skills/setup/SKILL.md):
 *   [PASS|INFO|WARN|ERROR] <check-id>: <message>
 * Always exits 0 — the report is the interface.
 */

import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_STATE_DIR = join(homedir(), ".whatsapp-channel");
const STATE_DIR = process.env.WHATSAPP_STATE_DIR ?? DEFAULT_STATE_DIR;
const SOURCE = join(import.meta.dir, "watchdog.sh");
const TARGET = join(STATE_DIR, "watchdog.sh");
const LOG_FILE = join(STATE_DIR, "watchdog.log");
// The manual-install form suggested by the watchdog.sh header comment —
// recognized so a hand-installed entry is not duplicated.
const HOME_FORM = "$HOME/.whatsapp-channel/watchdog.sh";
const CRON_LINE = `*/2 * * * * ${TARGET} >> ${LOG_FILE} 2>&1`;

type Severity = "PASS" | "INFO" | "WARN" | "ERROR";

function report(sev: Severity, id: string, msg: string): void {
  console.log(`[${sev}] ${id}: ${msg}`);
}

// ── crontab helpers (crontab resolved via PATH so tests can stub it) ────

function readCrontab(): string {
  try {
    return execFileSync("crontab", ["-l"], { encoding: "utf8" });
  } catch {
    return ""; // no crontab for this user yet
  }
}

function writeCrontab(content: string): void {
  const body =
    content.endsWith("\n") || content === "" ? content : content + "\n";
  execFileSync("crontab", ["-"], { input: body });
}

function cronReferencesWatchdog(line: string): boolean {
  if (line.includes(TARGET)) return true;
  // Only equate the $HOME form with TARGET when TARGET is the default path.
  return STATE_DIR === DEFAULT_STATE_DIR && line.includes(HOME_FORM);
}

function watchdogCronLines(): string[] {
  return readCrontab().split("\n").filter(cronReferencesWatchdog);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function sameAsRepoCopy(): boolean {
  try {
    return readFileSync(TARGET, "utf8") === readFileSync(SOURCE, "utf8");
  } catch {
    return false;
  }
}

// ── subcommands ─────────────────────────────────────────────────────────

function status(): void {
  if (!existsSync(TARGET)) {
    report("INFO", "watchdog-file", `not installed — expected at ${TARGET}`);
  } else if (!isExecutable(TARGET)) {
    report(
      "WARN",
      "watchdog-file",
      `${TARGET} exists but is not executable — cron runs will fail (fix: chmod +x ${TARGET})`,
    );
  } else if (!sameAsRepoCopy()) {
    report(
      "INFO",
      "watchdog-file",
      `installed with local modifications at ${TARGET} (differs from the plugin's scripts/watchdog.sh — install will not overwrite it)`,
    );
  } else {
    report("PASS", "watchdog-file", `installed and executable at ${TARGET}`);
  }

  const lines = watchdogCronLines();
  if (lines.length === 0) {
    report(
      "INFO",
      "watchdog-cron",
      "no crontab entry — the watchdog never runs without one",
    );
  } else {
    report(
      "PASS",
      "watchdog-cron",
      `crontab entry present: ${lines[0].trim()}`,
    );
  }
}

function main(): void {
  const cmd = process.argv[2] ?? "status";
  switch (cmd) {
    case "status":
      status();
      break;
    default:
      report(
        "ERROR",
        "usage",
        `unknown subcommand "${cmd}" (expected status|install|uninstall)`,
      );
  }
}

main();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/install-watchdog.test.ts`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git status --short   # confirm only the two new files are yours
git add scripts/install-watchdog.ts scripts/install-watchdog.test.ts
git commit -m "feat(watchdog): install-watchdog.ts status subcommand

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `install` subcommand

**Files:**

- Modify: `scripts/install-watchdog.ts` (add `install()`, wire into `main()`)
- Test: `scripts/install-watchdog.test.ts` (append describe block)

**Interfaces:**

- Consumes: Task 1's helpers (`report`, `readCrontab`, `writeCrontab`, `cronReferencesWatchdog`, `watchdogCronLines`, `sameAsRepoCopy`, `isExecutable`, `SOURCE`, `TARGET`, `CRON_LINE`, `STATE_DIR`) and test harness (`runScript`, `freshStateDir`, `freshCronStore`, `REPO_WATCHDOG`).
- Produces: `bun scripts/install-watchdog.ts install` — progress lines under check-ids `watchdog-file`, `watchdog-cron` (the setup skill re-runs `status` afterward for verification; install itself prints only what it did).

- [ ] **Step 1: Append install tests**

```typescript
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
});
```

Also add `existsSync` to the test file's `node:fs` import list.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `bun test scripts/install-watchdog.test.ts`
Expected: the 5 install tests FAIL (`unknown subcommand "install"` in output → assertions on `[PASS]`/file content fail); Task 1's 5 still pass.

- [ ] **Step 3: Implement install()**

Add to `scripts/install-watchdog.ts` (before `main`), and add a `case "install": install(); break;` to the switch:

```typescript
function install(): void {
  if (!existsSync(STATE_DIR) || !statSync(STATE_DIR).isDirectory()) {
    report(
      "ERROR",
      "watchdog-file",
      `state dir ${STATE_DIR} does not exist — run /whatsapp-claude-channel:setup first (the server creates it on first start)`,
    );
    return;
  }

  // 1. File: copy unless a locally modified copy is already there.
  if (!existsSync(TARGET)) {
    copyFileSync(SOURCE, TARGET);
    chmodSync(TARGET, 0o755);
    report("PASS", "watchdog-file", `installed ${TARGET} (executable)`);
  } else if (sameAsRepoCopy()) {
    chmodSync(TARGET, 0o755);
    report(
      "PASS",
      "watchdog-file",
      `already installed at ${TARGET} — unchanged`,
    );
  } else {
    report(
      "WARN",
      "watchdog-file",
      `${TARGET} exists with local modifications — NOT overwriting it (delete it first if you want the plugin's version)`,
    );
    if (!isExecutable(TARGET)) {
      report(
        "WARN",
        "watchdog-file",
        `${TARGET} is not executable — cron runs will fail (fix: chmod +x ${TARGET})`,
      );
    }
  }

  // 2. Crontab: append-only; never touch existing lines.
  const current = readCrontab();
  if (watchdogCronLines().length > 0) {
    report(
      "PASS",
      "watchdog-cron",
      "crontab entry already present — unchanged",
    );
  } else {
    const base =
      current === "" || current.endsWith("\n") ? current : current + "\n";
    writeCrontab(base + CRON_LINE + "\n");
    report("PASS", "watchdog-cron", `appended: ${CRON_LINE}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/install-watchdog.test.ts`
Expected: 10 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git status --short
git add scripts/install-watchdog.ts scripts/install-watchdog.test.ts
git commit -m "feat(watchdog): install subcommand — copy + chmod + append-only crontab

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `uninstall` subcommand

**Files:**

- Modify: `scripts/install-watchdog.ts` (add `uninstall()`, wire into `main()`)
- Test: `scripts/install-watchdog.test.ts` (append describe block)

**Interfaces:**

- Consumes: Task 1's helpers and test harness.
- Produces: `bun scripts/install-watchdog.ts uninstall` — removes only watchdog cron line(s), file untouched.

- [ ] **Step 1: Append uninstall tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `bun test scripts/install-watchdog.test.ts`
Expected: the 2 uninstall tests FAIL (`unknown subcommand`); the other 10 pass.

- [ ] **Step 3: Implement uninstall()**

Add to `scripts/install-watchdog.ts` and add `case "uninstall": uninstall(); break;` to the switch:

```typescript
function uninstall(): void {
  const current = readCrontab();
  if (watchdogCronLines().length === 0) {
    report("INFO", "watchdog-cron", "no crontab entry to remove");
    return;
  }
  const kept = current
    .split("\n")
    .filter((l) => !cronReferencesWatchdog(l))
    .join("\n");
  writeCrontab(kept);
  report(
    "PASS",
    "watchdog-cron",
    `removed the watchdog crontab entry (${TARGET} itself was left in place — inert without cron)`,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/install-watchdog.test.ts`
Expected: 12 pass, 0 fail. Also run `bun test scripts/` — doctor tests still green (16 pass).

- [ ] **Step 5: Commit**

```bash
git status --short
git add scripts/install-watchdog.ts scripts/install-watchdog.test.ts
git commit -m "feat(watchdog): uninstall subcommand — remove cron line only

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Doctor linkage

**Files:**

- Modify: `scripts/doctor.ts:443-451` (the `checkWatchdog` not-installed branch)
- Test: `scripts/doctor.test.ts` (add assertion in the `optional features` describe)

**Interfaces:**

- Consumes: nothing new. `server.ts` untouched.
- Produces: doctor's watchdog-absent INFO now names the setup skill.

- [ ] **Step 1: Add the failing assertion to doctor.test.ts**

Append inside `describe("optional features", …)`:

```typescript
test("watchdog absent → message points at setup for install", () => {
  const out = runDoctor(freshStateDir());
  expect(out).toContain(
    "run /whatsapp-claude-channel:setup to install auto-recovery",
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test scripts/doctor.test.ts`
Expected: 1 fail (message still says "scripts/watchdog.sh in the plugin repo"), 16 pass.

- [ ] **Step 3: Change the message in doctor.ts**

In `checkWatchdog()`, replace:

```typescript
      "watchdog not installed (optional) — scripts/watchdog.sh in the plugin repo enables auto-recovery",
```

with:

```typescript
      "watchdog not installed (optional) — run /whatsapp-claude-channel:setup to install auto-recovery",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/`
Expected: all pass (17 doctor + 12 install-watchdog).

- [ ] **Step 5: Commit**

```bash
git status --short
git add scripts/doctor.ts scripts/doctor.test.ts
git commit -m "feat(doctor): point watchdog-absent finding at setup install flow

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Setup skill Phase 5

**Files:**

- Modify: `skills/setup/SKILL.md` (insert new Phase 5, renumber old Phase 5 → Phase 6)

**Interfaces:**

- Consumes: `bun "${CLAUDE_PLUGIN_ROOT}/scripts/install-watchdog.ts" status|install` from Tasks 1–2.

- [ ] **Step 1: Edit SKILL.md**

Replace the line `## Phase 5: Done` and insert before it, so the file reads (old Phase 5 content is unchanged, only retitled):

```markdown
## Phase 5: Auto-Recovery (Watchdog) — Optional

Explain briefly:

> "Optional last step: a watchdog — a cron job that checks every 2 minutes
> whether the agent is stuck or dead, nudges or restarts it, and alerts you if
> API auth breaks. Recommended if this agent runs unattended. One caveat: its
> nudge/restart mechanics act on a tmux session named `whatsapp-agent` — if you
> run Claude some other way, it can detect problems but not revive the agent.
> Want it installed?"

**If yes:**

1. Show current state: run `bun "${CLAUDE_PLUGIN_ROOT}/scripts/install-watchdog.ts" status` and summarize the output.
2. Tell the user exactly what install will do: copy `scripts/watchdog.sh` to `~/.whatsapp-channel/watchdog.sh`, make it executable, and append this line to their crontab (nothing else in the crontab is touched):
   `*/2 * * * * ~/.whatsapp-channel/watchdog.sh >> ~/.whatsapp-channel/watchdog.log 2>&1`
3. On confirmation, run `bun "${CLAUDE_PLUGIN_ROOT}/scripts/install-watchdog.ts" install`.
4. Verify: run the `status` subcommand again and show the user both checks pass. If the script reports a WARN about local modifications, relay it verbatim — it means their existing watchdog.sh was preserved, not replaced.
5. If the user does not appear to be running inside tmux, remind them: start the agent as `tmux new-session -s whatsapp-agent claude` for the watchdog's nudge/restart to work.

**If no:** one sentence — they can re-run `/whatsapp-claude-channel:setup` anytime to install it. If they later want failure notifications on their phone, the notify-hook option is documented in the header of `watchdog.sh`.

To undo later: `bun "${CLAUDE_PLUGIN_ROOT}/scripts/install-watchdog.ts" uninstall` removes the cron entry.

## Phase 6: Done
```

Also update the Phase 4 ending line `If no, skip to Phase 4.` context — check Phase 3's "If no, skip to Phase 4." still points correctly (it does; Phase 4 unchanged). No other renumbering exists in the file.

- [ ] **Step 2: Verify the skill file structure**

Run: `grep -n "^## Phase" skills/setup/SKILL.md`
Expected: Phases 1,2,3,4,5 (Auto-Recovery),6 (Done) in order, each exactly once.

- [ ] **Step 3: Commit**

```bash
git status --short
git add skills/setup/SKILL.md
git commit -m "feat(setup): offer watchdog auto-recovery install as setup Phase 5

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Version bump + release verification

**Files:**

- Modify: `.claude-plugin/plugin.json` (`"version": "0.13.2"` → `"0.14.0"`)
- Modify: `.claude-plugin/marketplace.json` (`plugins[0].version` `"0.13.2"` → `"0.14.0"`; leave top-level `"version": "1.5.0"` alone)

- [ ] **Step 1: Bump both versions and verify the pairing**

Run: `grep -n '"version"' .claude-plugin/marketplace.json .claude-plugin/plugin.json`
Expected: three lines — marketplace top-level `1.5.0` (untouched), marketplace `plugins[0]` `0.14.0`, plugin.json `0.14.0`.

- [ ] **Step 2: Full test suite**

Run: `bun test scripts/`
Expected: all pass, 0 fail.

- [ ] **Step 3: Live read-only verification on this machine**

Run: `bun scripts/install-watchdog.ts status` (real state dir, real crontab — status is read-only).
Expected: report lines only, no mutation. Do NOT run `install` on this machine and do NOT touch mini.

- [ ] **Step 4: Lint the full diff (docs included)**

Run: `~/.cache/trunk/launcher/trunk check $(git diff --name-only origin/main...HEAD | tr '\n' ' ')`
(`origin/main...HEAD` covers every file changed since the last push, docs and specs included.) Fix findings; `~/.cache/trunk/launcher/trunk fmt <files>` for formatting.
Expected: no issues (or fixed + amended into the relevant commits).

- [ ] **Step 5: Commit**

```bash
git status --short   # only the two .claude-plugin files staged-to-be
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump version to 0.14.0 (watchdog opt-in setup flow)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Stop — maintainer review before push**

Present the commit list (`git log --oneline origin/main..HEAD`) and diff summary. Do NOT push.
