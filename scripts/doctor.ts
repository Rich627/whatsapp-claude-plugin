#!/usr/bin/env bun
/**
 * doctor.ts — read-only health check for the WhatsApp channel.
 *
 * Usage:              bun scripts/doctor.ts
 * Fixture/testing:    WHATSAPP_STATE_DIR=/path bun scripts/doctor.ts
 *
 * Output contract (parsed by skills/doctor/SKILL.md):
 *   [PASS|INFO|WARN|ERROR] <check-id>: <message>
 *       fix[safe]: <exact shell command — the skill may run it after the user confirms>
 *       fix[manual]: <instruction — the skill must never execute it>
 *   SUMMARY: <n> error, <n> warn, <n> info, <n> pass
 *
 * Never writes anything. Always exits 0 — the report is the interface.
 * Path constants mirror server.ts, which cannot be imported (module-load
 * side effects: it acquires the singleton lock at import time).
 */

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR =
  process.env.WHATSAPP_STATE_DIR ?? join(homedir(), ".whatsapp-channel");
const AUTH_DIR = join(STATE_DIR, ".baileys_auth");
const CREDS_FILE = join(AUTH_DIR, "creds.json");
const ACCESS_FILE = join(STATE_DIR, "access.json");
const LOCK_FILE = join(STATE_DIR, ".server.lock");
const MESSAGE_LOG = join(STATE_DIR, "messages.jsonl");
const GROUPS_DIR = join(STATE_DIR, "groups");
const WHISPER_SCRIPT = join(homedir(), "whisper-transcribe.sh"); // hardcoded by server.ts
const WATCHDOG_SCRIPT = join(STATE_DIR, "watchdog.sh");
const MSG_STALE_SECS = 600; // mirrors scripts/watchdog.sh MSG_STALE_SECS

type Severity = "PASS" | "INFO" | "WARN" | "ERROR";
type Fix = { kind: "safe" | "manual"; text: string };

const out: string[] = [];
const counts: Record<Severity, number> = { PASS: 0, INFO: 0, WARN: 0, ERROR: 0 };

function report(sev: Severity, id: string, msg: string, fix?: Fix): void {
  counts[sev]++;
  out.push(`[${sev}] ${id}: ${msg}`);
  if (fix) out.push(`    fix[${fix.kind}]: ${fix.text}`);
}

// ── portable ps helpers (macOS + Linux) ─────────────────────────────────

// OS start time of a process, or null if no such process. Same probe as
// server.ts's processStartTime — lstart distinguishes a reused PID.
function processStartTime(pid: number): string | null {
  try {
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function processPpid(pid: number): number | null {
  try {
    const n = Number(
      execFileSync("ps", ["-p", String(pid), "-o", "ppid="], {
        encoding: "utf8",
      }).trim(),
    );
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ── checks ──────────────────────────────────────────────────────────────

function checkEnv(): void {
  const pkg = readJson(
    join(import.meta.dir, "..", ".claude-plugin", "plugin.json"),
  );
  const version =
    pkg && typeof pkg === "object" && "version" in pkg
      ? String((pkg as { version: unknown }).version)
      : "unknown";
  report(
    "INFO",
    "env",
    `plugin v${version}, bun ${Bun.version}, ${process.platform}, state dir: ${STATE_DIR}`,
  );
}

function checkStateDir(): boolean {
  if (!existsSync(STATE_DIR)) {
    report(
      "ERROR",
      "state-dir",
      `${STATE_DIR} does not exist — the server has never run on this machine`,
      {
        kind: "manual",
        text: "Restart Claude Code with the plugin enabled (/mcp should list 'whatsapp'), then run /whatsapp-claude-channel:setup",
      },
    );
    return false;
  }
  if (!statSync(STATE_DIR).isDirectory()) {
    report("ERROR", "state-dir", `${STATE_DIR} exists but is not a directory`, {
      kind: "manual",
      text: `Move it aside (mv ${STATE_DIR} ${STATE_DIR}.bak) and restart Claude Code`,
    });
    return false;
  }
  try {
    accessSync(STATE_DIR, constants.W_OK);
  } catch {
    report("ERROR", "state-dir", `${STATE_DIR} is not writable`, {
      kind: "manual",
      text: `chmod u+rwx ${STATE_DIR}, then re-run doctor`,
    });
    return true; // dir exists; later checks can still read
  }
  report("PASS", "state-dir", `${STATE_DIR} exists and is writable`);
  return true;
}

function checkAuth(): void {
  if (!existsSync(CREDS_FILE)) {
    report(
      "ERROR",
      "auth",
      "no Baileys credentials — WhatsApp has never been linked",
      {
        kind: "manual",
        text: "Run /whatsapp-claude-channel:setup and scan the QR code",
      },
    );
    return;
  }
  const creds = readJson(CREDS_FILE);
  if (creds === null) {
    report("ERROR", "auth", "creds.json is corrupt (unparseable JSON)", {
      kind: "manual",
      text: `Re-link from scratch: rm -rf ${AUTH_DIR} then restart Claude Code and run /whatsapp-claude-channel:setup. WARNING: this discards the linked session — only do it if the channel is otherwise dead.`,
    });
    return;
  }
  const me = (creds as { me?: { id?: string } }).me;
  if (!me?.id) {
    report(
      "WARN",
      "auth",
      "credentials exist but have no paired identity (me.id) — pairing may not have completed",
      {
        kind: "manual",
        text: "Run /whatsapp-claude-channel:setup to finish linking",
      },
    );
    return;
  }
  report("PASS", "auth", `linked as ${me.id}`);
}

function checkServer(): void {
  if (!existsSync(LOCK_FILE)) {
    report("ERROR", "server", "no lock file — the MCP server is not running", {
      kind: "manual",
      text: "Start (or restart) a Claude Code session with the plugin enabled; /mcp should list 'whatsapp'. The server starts with the session.",
    });
    return;
  }
  let raw = "";
  try {
    raw = readFileSync(LOCK_FILE, "utf8");
  } catch {
    /* fall through to malformed */
  }
  const [pidLine = "", startLine = ""] = raw.split("\n");
  const pid = Number(pidLine.trim());
  const lockedStart = startLine.trim();
  if (!Number.isFinite(pid) || pid <= 0) {
    report("WARN", "server", `lock file is malformed (${LOCK_FILE})`, {
      kind: "safe",
      text: `rm ${LOCK_FILE}`,
    });
    return;
  }
  // Alive means: PID exists AND its start time matches what the lock
  // recorded — the same PID-reuse guard as server.ts's acquireSingletonLock.
  const currentStart = processStartTime(pid);
  const alive =
    currentStart !== null && lockedStart !== "" && currentStart === lockedStart;
  if (!alive) {
    report(
      "WARN",
      "server",
      `stale lock — PID ${pid} is gone or the PID was reused (the server also self-heals this on next start)`,
      { kind: "safe", text: `rm ${LOCK_FILE}` },
    );
    return;
  }
  const ppid = processPpid(pid);
  if (ppid === 1) {
    report(
      "ERROR",
      "server",
      `orphaned server (pid ${pid}, parent dead) is holding the Baileys session — no new session can connect until it exits`,
      {
        kind: "safe",
        text: `kill ${pid}   # wait ~5s; if still alive: kill -9 ${pid} && rm ${LOCK_FILE}`,
      },
    );
    return;
  }
  report(
    "PASS",
    "server",
    `server running (pid ${pid}) — note: it may belong to another Claude Code session on this machine`,
  );
}

const VALID_POLICIES = ["pairing", "allowlist", "disabled"];

type AccessShape = {
  dmPolicy: string;
  allowFrom: unknown[];
  groups: Record<string, unknown>;
  pending: Record<string, unknown>;
};

function checkAccess(): AccessShape | null {
  if (!existsSync(ACCESS_FILE)) {
    report(
      "INFO",
      "access-config",
      "access.json absent — the server creates defaults (dmPolicy: pairing) on next start",
    );
    return null;
  }
  const a = readJson(ACCESS_FILE);
  if (a === null || typeof a !== "object" || Array.isArray(a)) {
    report(
      "ERROR",
      "access-config",
      "access.json is corrupt — on next start the server moves it aside and starts fresh (allowlist and policies will need re-adding)",
      {
        kind: "manual",
        text: "Restore from a backup if you have one; otherwise reconfigure with /whatsapp-claude-channel:access after the next restart",
      },
    );
    return null;
  }
  const acc = a as Partial<AccessShape>;
  const problems: string[] = [];
  if (!VALID_POLICIES.includes(acc.dmPolicy as string))
    problems.push(
      `dmPolicy "${acc.dmPolicy}" invalid (expected ${VALID_POLICIES.join("/")})`,
    );
  if (!Array.isArray(acc.allowFrom)) problems.push("allowFrom is not an array");
  if (!acc.groups || typeof acc.groups !== "object" || Array.isArray(acc.groups))
    problems.push("groups is not an object");
  if (
    !acc.pending ||
    typeof acc.pending !== "object" ||
    Array.isArray(acc.pending)
  )
    problems.push("pending is not an object");
  if (problems.length > 0) {
    report(
      "ERROR",
      "access-config",
      `access.json malformed: ${problems.join("; ")}`,
      {
        kind: "manual",
        text: "Fix the listed fields by hand, or delete access.json and reconfigure via /whatsapp-claude-channel:access",
      },
    );
    return null;
  }
  const ok = acc as AccessShape;
  report(
    "PASS",
    "access-config",
    `dmPolicy: ${ok.dmPolicy}, ${ok.allowFrom.length} allowed contact(s), ${Object.keys(ok.groups).length} group(s)`,
  );
  if (ok.dmPolicy === "disabled")
    report(
      "INFO",
      "access-config",
      "DMs are disabled by policy — the channel only reacts in configured groups",
    );
  const pendingCount = Object.keys(ok.pending).length;
  if (pendingCount > 0)
    report(
      "INFO",
      "access-config",
      `${pendingCount} pending pairing code(s) awaiting approval`,
    );
  return ok;
}

function checkActivity(): void {
  if (!existsSync(MESSAGE_LOG)) {
    report("INFO", "activity", "no message log yet — no traffic has flowed");
    return;
  }
  const now = Date.now();
  let lastIn: number | null = null;
  let lastOut: number | null = null;
  let staleUnreplied = 0;
  for (const line of readFileSync(MESSAGE_LOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as {
        ts?: string;
        replied?: boolean;
        direction?: string;
      };
      const t = Date.parse(e.ts ?? "");
      if (!Number.isFinite(t)) continue;
      if ((e.direction ?? "in") === "in") {
        // inbound-default mirrors the server's catch_up logic
        lastIn = Math.max(lastIn ?? 0, t);
        if (e.replied === false && now - t > MSG_STALE_SECS * 1000)
          staleUnreplied++;
      } else {
        lastOut = Math.max(lastOut ?? 0, t);
      }
    } catch {
      /* skip corrupt lines, same as the server does */
    }
  }
  const age = (t: number | null): string =>
    t === null ? "never" : `${Math.round((now - t) / 60000)} min ago`;
  report(
    "INFO",
    "activity",
    `last inbound: ${age(lastIn)}, last outbound: ${age(lastOut)}`,
  );
  if (staleUnreplied > 0) {
    report(
      "WARN",
      "activity",
      `${staleUnreplied} inbound message(s) unreplied for >10 min — if the server is healthy, the agent session may be stuck or absent`,
    );
  } else {
    report("PASS", "activity", "no stale unreplied messages");
  }
}

// ── main ────────────────────────────────────────────────────────────────

checkEnv();
if (checkStateDir()) {
  checkAuth();
  checkServer();
  checkAccess();
  checkActivity();
}
out.push(
  `SUMMARY: ${counts.ERROR} error, ${counts.WARN} warn, ${counts.INFO} info, ${counts.PASS} pass`,
);
console.log(out.join("\n"));
