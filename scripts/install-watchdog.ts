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
  const body = content.endsWith("\n") || content === "" ? content : content + "\n";
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
    report("PASS", "watchdog-cron", `crontab entry present: ${lines[0].trim()}`);
  }
}

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
  try {
    if (!existsSync(TARGET)) {
      copyFileSync(SOURCE, TARGET);
      chmodSync(TARGET, 0o755);
      report("PASS", "watchdog-file", `installed ${TARGET} (executable)`);
    } else if (sameAsRepoCopy()) {
      chmodSync(TARGET, 0o755);
      report("PASS", "watchdog-file", `already installed at ${TARGET} — unchanged`);
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report(
      "ERROR",
      "watchdog-file",
      `failed to install ${TARGET}: ${message}`,
    );
    return;
  }

  // 2. Crontab: append-only; never touch existing lines.
  try {
    const current = readCrontab();
    const hasWatchdogLine = current
      .split("\n")
      .some((line) => cronReferencesWatchdog(line));

    if (hasWatchdogLine) {
      report("PASS", "watchdog-cron", "crontab entry already present — unchanged");
    } else {
      const base = current === "" || current.endsWith("\n") ? current : current + "\n";
      writeCrontab(base + CRON_LINE + "\n");
      report("PASS", "watchdog-cron", `appended: ${CRON_LINE}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report(
      "ERROR",
      "watchdog-cron",
      `failed to update crontab: ${message}`,
    );
  }
}

function main(): void {
  const cmd = process.argv[2] ?? "status";
  switch (cmd) {
    case "status":
      status();
      break;
    case "install":
      install();
      break;
    default:
      report("ERROR", "usage", `unknown subcommand "${cmd}" (expected status|install|uninstall)`);
  }
}

main();
