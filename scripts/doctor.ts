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
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CRON_SECTION_RE, parseCronSection } from "../lib/cron";

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
const NOTIFY_HOOK = join(STATE_DIR, "notify-hook.sh"); // fixed path watchdog.sh looks for (NOTIFY_HOOK var in its header)
const INBOX_DIR = join(STATE_DIR, "inbox");
const DIAG_LOG_FILE = join(STATE_DIR, "diag.log");
const LID_MAP_FILE = join(STATE_DIR, "lid-map.json");
const MSG_STALE_SECS = 600; // mirrors scripts/watchdog.sh MSG_STALE_SECS
// Past this, an unreplied line says "nobody answered", not "the session is
// stuck", so it stops counting toward the stuck-session warning. See the
// windowed test in checkActivity.
const MSG_STALE_MAX_SECS = 24 * 60 * 60;
// inbox/ is pruned hourly by the running primary to the message horizon, so
// at the default 7 days steady moderate use stays well under this; crossing
// it means a long horizon, a burst of large files, or no primary running.
const INBOX_WARN_BYTES = 500_000_000; // 500 MB
// Half of server.ts's own DIAG_MAX_BYTES (20 MB) self-truncation cap — past
// this point diag.log is filling fast enough to hit that reset soon, which
// erases whatever evidence is flooding it before anyone reads it.
const DIAG_LOG_WARN_BYTES = 10_000_000; // 10 MB
// lid-map.json entries are short JID-pair strings (~80-150 bytes with JSON
// overhead); 2 MB implies roughly 15-20k cached contacts, far past what a
// real contact/group list produces — a sign the stranger-aging prune isn't
// keeping it bounded on this machine.
const LID_MAP_WARN_BYTES = 2_000_000; // 2 MB

type Severity = "PASS" | "INFO" | "WARN" | "ERROR";
type Fix = { kind: "safe" | "manual"; text: string };

const out: string[] = [];
const counts: Record<Severity, number> = {
  PASS: 0,
  INFO: 0,
  WARN: 0,
  ERROR: 0,
};

function report(sev: Severity, id: string, msg: string, fix?: Fix): void {
  counts[sev]++;
  out.push(`[${sev}] ${id}: ${msg}`);
  if (fix) out.push(`    fix[${fix.kind}]: ${fix.text}`);
}

// ── portable process helpers ────────────────────────────────────────────

// OS start time of a process: a string if running, null if no such process,
// undefined if the probe could not tell. Same probe as server.ts's
// processStartTime (keep in sync: its output must match the lock file).
function processStartTime(pid: number): string | null | undefined {
  const [cmd, args]: [string, string[]] =
    process.platform === "win32"
      ? [
          `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop | ForEach-Object { $_.CreationDate.ToFileTimeUtc() })`,
          ],
        ]
      : ["ps", ["-p", String(pid), "-o", "lstart="]];
  try {
    return (
      execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        windowsHide: true,
      }).trim() || null
    );
  } catch (err) {
    return process.platform !== "win32" &&
      typeof (err as { status?: unknown }).status === "number"
      ? null
      : undefined;
  }
}

// Parent PID, or null when unknown. Windows has no "reparented to PID 1"
// notion, so the orphan check below is not implemented there; the server's
// own parent-death poll (and stdin EOF) is what ends an orphan on Windows.
function processPpid(pid: number): number | null {
  if (process.platform === "win32") return null;
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
        text: "Restart Claude Code with the plugin enabled (/mcp should list 'whatsapp'), then run /whatsapp-channel:setup",
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
        text: "Run /whatsapp-channel:setup and scan the QR code",
      },
    );
    return;
  }
  const creds = readJson(CREDS_FILE);
  if (creds === null) {
    report("ERROR", "auth", "creds.json is corrupt (unparseable JSON)", {
      kind: "manual",
      text: `Re-link from scratch: rm -rf ${AUTH_DIR} then restart Claude Code and run /whatsapp-channel:setup. WARNING: this discards the linked session — only do it if the channel is otherwise dead.`,
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
        text: "Run /whatsapp-channel:setup to finish linking",
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
  const [pidLine = "", startLine = "", clientLine = ""] = raw.split("\n");
  const pid = Number(pidLine.trim());
  const lockedStart = startLine.trim();
  if (!Number.isFinite(pid) || pid <= 0) {
    report("WARN", "server", `lock file is malformed (${LOCK_FILE})`, {
      kind: "safe",
      text: `rm ${JSON.stringify(LOCK_FILE)}`,
    });
    return;
  }
  // Alive means: PID exists AND its start time matches what the lock
  // recorded — the same PID-reuse guard as server.ts's acquireSingletonLock.
  const currentStart = processStartTime(pid);
  if (currentStart === undefined) {
    report(
      "WARN",
      "server",
      `could not verify whether PID ${pid} is the server (start-time probe failed) — not offering to remove the lock`,
    );
    return;
  }
  const alive =
    currentStart !== null && lockedStart !== "" && currentStart === lockedStart;
  if (!alive) {
    report(
      "WARN",
      "server",
      `stale lock — PID ${pid} is gone or the PID was reused (the server also self-heals this on next start)`,
      { kind: "safe", text: `rm ${JSON.stringify(LOCK_FILE)}` },
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
        text: `kill ${pid}   # wait ~5s; if still alive: kill -9 ${pid} && rm ${JSON.stringify(LOCK_FILE)}`,
      },
    );
    return;
  }
  // Line 3 of the lock is the client that started the holder, so this can name
  // the owner instead of hedging. Absent on locks written before 0.15.0, and
  // on servers started by a client that does not identify itself.
  const client = clientLine.trim();
  const owner =
    client === ""
      ? " — started by a client that does not identify itself, or before 0.15.0"
      : client === (process.env.CLAUDE_PID ?? "").trim()
        ? " — started by this session"
        : ` — started by another session or client (pid ${client})`;
  report("PASS", "server", `server running (pid ${pid})${owner}`);
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
        text: "Restore from a backup if you have one; otherwise reconfigure with /whatsapp-channel:access after the next restart",
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
  if (
    !acc.groups ||
    typeof acc.groups !== "object" ||
    Array.isArray(acc.groups)
  )
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
        text: "Fix the listed fields by hand, or delete access.json and reconfigure via /whatsapp-channel:access",
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
  let oldUnreplied = 0;
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
        // Split, not filtered. The 24h inbound expiry that used to retire
        // these lines is gone (one 7-day horizon, 0.25.0), so without an upper
        // bound a single never-answered message would report a stuck session
        // on every run for a week. But DROPPING the old ones is its own bug:
        // a session dead for two days with no new traffic would then report
        // "no stale unreplied messages" - a clean bill of health for exactly
        // the case someone runs doctor to diagnose. So the old ones stop
        // counting as stuck-session evidence and are reported separately.
        const ageMs = now - t;
        if (e.replied === false && ageMs > MSG_STALE_SECS * 1000) {
          if (ageMs < MSG_STALE_MAX_SECS * 1000) staleUnreplied++;
          else oldUnreplied++;
        }
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
  // Reported whatever the verdict above, so a long-dead session cannot hide
  // behind a PASS: these are past the stuck-session window but still on the
  // retention horizon, and "nobody ever answered" is worth seeing.
  if (oldUnreplied > 0) {
    report(
      "INFO",
      "activity",
      `${oldUnreplied} inbound message(s) unreplied for >24h — not counted as a stuck session; check the last-inbound time above if that looks wrong`,
    );
  }
}

function checkTranscription(): void {
  if (!existsSync(WHISPER_SCRIPT)) {
    report(
      "INFO",
      "transcription",
      `voice transcription not set up (optional) — ${WHISPER_SCRIPT} not found; voice notes arrive as plain audio attachments`,
    );
    return;
  }
  try {
    accessSync(WHISPER_SCRIPT, constants.X_OK);
    report("PASS", "transcription", `${WHISPER_SCRIPT} present and executable`);
  } catch {
    report(
      "WARN",
      "transcription",
      `${WHISPER_SCRIPT} exists but is not executable — transcription will fail`,
      { kind: "safe", text: `chmod +x ${WHISPER_SCRIPT}` },
    );
  }
}

function checkGroupConfigs(acc: AccessShape | null): void {
  if (!acc) return;
  for (const gid of Object.keys(acc.groups)) {
    const cfg = join(GROUPS_DIR, gid, "config.md");
    if (!existsSync(cfg)) {
      report("INFO", "group-configs", `${gid}: no config.md (defaults apply)`);
      continue;
    }
    let content = "";
    try {
      content = readFileSync(cfg, "utf8");
    } catch {
      report(
        "WARN",
        "group-configs",
        `${gid}: config.md exists but is unreadable`,
      );
      continue;
    }
    // THE SERVER'S OWN PARSER, imported - not a second copy of its regex.
    // The copy that used to live here was written as "the exact regex the
    // server uses", then lib/cron.ts gained \r?\n for CRLF files and this one
    // did not. So a config.md saved by a Windows editor scheduled correctly
    // while doctor WARNed and told the user to rename a heading that was
    // already right - a diagnostic contradicting the thing it diagnoses.
    // Sharing the parser also means doctor now reports the JOBS that will run
    // and the lines that were rejected, rather than counting bullets and
    // assuming each one became a job.
    if (CRON_SECTION_RE.test(content)) {
      const { jobs, errors } = parseCronSection(content);
      report(
        "INFO",
        "group-configs",
        `${gid}: ## Cron Jobs section with ${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}`,
      );
      for (const err of errors) {
        report("WARN", "group-configs", `${gid}: ${err}`, {
          kind: "manual",
          text: `Fix that line in ${cfg} - it is in the section but schedules nothing`,
        });
      }
    } else if (/^#{1,6}\s.*cron/im.test(content)) {
      report(
        "WARN",
        "group-configs",
        `${gid}: config.md has a cron-like heading that is not exactly "## Cron Jobs" — the server silently ignores it`,
        {
          kind: "manual",
          text: `Rename the heading in ${cfg} to exactly "## Cron Jobs"`,
        },
      );
    } else {
      report("PASS", "group-configs", `${gid}: config.md present`);
    }
  }
}

function checkWatchdog(): void {
  if (!existsSync(WATCHDOG_SCRIPT)) {
    report(
      "INFO",
      "watchdog",
      "watchdog not installed (optional) — run /whatsapp-channel:setup to install auto-recovery",
    );
    return;
  }
  let executable = true;
  try {
    accessSync(WATCHDOG_SCRIPT, constants.X_OK);
  } catch {
    executable = false;
  }
  let inCrontab = false;
  try {
    inCrontab = execFileSync("crontab", ["-l"], { encoding: "utf8" }).includes(
      "watchdog.sh",
    );
  } catch {
    /* no crontab for this user */
  }
  report(
    "INFO",
    "watchdog",
    `installed at ${WATCHDOG_SCRIPT} (${executable ? "executable" : "NOT executable — chmod +x it"}, ${inCrontab ? "referenced in crontab" : "not in crontab — add a */2 entry per the script header"})`,
  );

  // watchdog.sh looks for a notify hook at this exact fixed path (its
  // NOTIFY_HOOK var, set in the header) — there is no separate "enabled"
  // flag, so the file's presence there IS the configuration. A hook that
  // exists but can't run means auth/net/stuck-agent alerts silently fall
  // back to a local macOS notification only — nobody gets paged remotely.
  if (!existsSync(NOTIFY_HOOK)) {
    report(
      "INFO",
      "watchdog",
      `no notify hook at ${NOTIFY_HOOK} (optional) — alerts fall back to a local macOS notification only`,
    );
    return;
  }
  try {
    accessSync(NOTIFY_HOOK, constants.X_OK);
    report(
      "PASS",
      "watchdog",
      `notify hook ${NOTIFY_HOOK} present and executable`,
    );
  } catch {
    report(
      "WARN",
      "watchdog",
      `notify hook ${NOTIFY_HOOK} exists but is not executable — watchdog alerts will silently fall back to a local notification instead of paging out`,
      { kind: "safe", text: `chmod +x ${NOTIFY_HOOK}` },
    );
  }
}

function bytesToMb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

function checkDiskUsage(): void {
  // inbox/ — pruned by the primary (pruneInbox) while one runs. The threshold
  // assumes the default 7-day horizon; doctor cannot see the lock holder's TTL.
  if (!existsSync(INBOX_DIR)) {
    report(
      "INFO",
      "disk-usage",
      "inbox/ does not exist yet — no attachments downloaded",
    );
  } else {
    let totalBytes = 0;
    let fileCount = 0;
    try {
      for (const name of readdirSync(INBOX_DIR)) {
        try {
          const st = statSync(join(INBOX_DIR, name));
          if (st.isFile()) {
            totalBytes += st.size;
            fileCount++;
          }
        } catch {
          /* file vanished mid-scan; skip */
        }
      }
    } catch (err) {
      report("WARN", "disk-usage", `could not read inbox/: ${err}`);
      totalBytes = -1;
    }
    if (totalBytes >= 0) {
      const mb = bytesToMb(totalBytes);
      if (totalBytes > INBOX_WARN_BYTES) {
        report(
          "WARN",
          "disk-usage",
          `inbox/ holds ${fileCount} file(s), ${mb} MB — a running primary prunes it hourly to the message horizon (7 days unless WHATSAPP_MESSAGE_TTL_DAYS says otherwise); this threshold assumes that default, and nothing prunes while no server runs`,
          {
            kind: "manual",
            text: `Restart the lock-holding terminal with a lower WHATSAPP_MESSAGE_TTL_DAYS (it is read at startup), or clear attachments you no longer need, e.g.: find ${INBOX_DIR} -type f -mtime +7 -delete`,
          },
        );
      } else {
        report("PASS", "disk-usage", `inbox/: ${fileCount} file(s), ${mb} MB`);
      }
    }
  }

  // ONE rule for "how big is this file, if I can tell". Both readings below
  // used a bare statSync, outside any try - unlike the inbox scan above, which
  // guards every one. A file deleted between existsSync and statSync, an
  // EACCES, a symlink to a vanished target, or diag.log replaced by a
  // directory would throw straight out of checkDiskUsage.
  const sizeOf = (p: string): number | null => {
    try {
      return statSync(p).size;
    } catch {
      return null;
    }
  };

  // diag.log — self-truncates at 20 MB (server.ts's DIAG_MAX_BYTES), but a
  // fast-filling log means something is repeatedly failing and the evidence
  // is about to be wiped by that reset.
  if (!existsSync(DIAG_LOG_FILE)) {
    report("INFO", "disk-usage", "diag.log does not exist yet");
  } else {
    const bytes = sizeOf(DIAG_LOG_FILE);
    const mb = bytes === null ? "?" : bytesToMb(bytes);
    if (bytes === null) {
      report("WARN", "disk-usage", `could not read ${DIAG_LOG_FILE}`);
    } else if (bytes > DIAG_LOG_WARN_BYTES) {
      report(
        "WARN",
        "disk-usage",
        `diag.log is ${mb} MB — approaching the server's own 20 MB self-truncation cap; something may be logging repeatedly`,
        { kind: "manual", text: `tail -100 ${DIAG_LOG_FILE}` },
      );
    } else {
      report("PASS", "disk-usage", `diag.log: ${mb} MB`);
    }
  }

  // lid-map.json — the LID↔phone contact cache; unbounded growth here means
  // every stranger who ever messaged is still cached.
  if (!existsSync(LID_MAP_FILE)) {
    report("INFO", "disk-usage", "lid-map.json does not exist yet");
  } else {
    const bytes = sizeOf(LID_MAP_FILE);
    const mb = bytes === null ? "?" : bytesToMb(bytes);
    if (bytes === null) {
      report("WARN", "disk-usage", `could not read ${LID_MAP_FILE}`);
    } else if (bytes > LID_MAP_WARN_BYTES) {
      report(
        "WARN",
        "disk-usage",
        `lid-map.json is ${mb} MB — larger than a normal contact list; likely accumulating stale stranger entries`,
        {
          kind: "manual",
          text: `Inspect ${LID_MAP_FILE}; if it is mostly stale strangers, back it up and remove it — the server re-derives entries as needed.`,
        },
      );
    } else {
      report("PASS", "disk-usage", `lid-map.json: ${mb} MB`);
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────

// THE REPORT IS PRINTED WHATEVER HAPPENS. `out` is only flushed at the very
// end, so before this any throw anywhere in any check aborted the run and
// printed NOTHING - no checks, no summary, just a stack trace. That is the
// worst failure mode this file has: a diagnostic that dies silently on the
// machine you are trying to diagnose, and it tells you less than running
// nothing at all. The specific throw that prompted this is fixed above
// (sizeOf), but the guard is here so the NEXT unguarded call cannot do it
// again. The thrown error becomes an ERROR row, so it is in the report rather
// than instead of it.
try {
  checkEnv();
  if (checkStateDir()) {
    checkAuth();
    checkServer();
    const acc = checkAccess();
    checkActivity();
    checkTranscription();
    checkGroupConfigs(acc);
    checkWatchdog();
    checkDiskUsage();
  }
} catch (err) {
  report(
    "ERROR",
    "doctor",
    `a check stopped early: ${err}. Everything above still ran; everything below it did not.`,
  );
} finally {
  out.push(
    `SUMMARY: ${counts.ERROR} error, ${counts.WARN} warn, ${counts.INFO} info, ${counts.PASS} pass`,
  );
  console.log(out.join("\n"));
}
