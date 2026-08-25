#!/usr/bin/env bun
/**
 * statusline-role.ts — prints "WA:<role>" for the WhatsApp MCP server
 * belonging to *this* terminal, or nothing if there isn't one running here.
 *
 * Wire it into a Claude Code statusLine command, appended after whatever it
 * already prints, e.g.:
 *   your-existing-statusline-command && bun <plugin-dir>/scripts/statusline-role.ts
 *
 * Two ways to find the right server, in order.
 *
 * 1. The stamp. server.ts writes the pid of the Claude Code session that owns
 *    it as line 2 of its role file, so we climb our own ppid chain and take
 *    the file whose owner is one of our ancestors. Ownership is read, not
 *    guessed, so a sibling terminal's server can never be mistaken for ours.
 * 2. The process tree, for a server that predates the stamp or a client that
 *    never identified itself: climb the ppid chain to the Claude Code CLI
 *    (this script does NOT run as its direct child — see
 *    findServerPidForTerminal), then the plugin's own wrapper among that
 *    CLI's descendants (matched on the plugin dir name — "server.ts" alone
 *    hits other plugins' servers too), then server.ts under that wrapper.
 *
 * Never throws, never writes: prints nothing and exits 0 on any miss, same
 * contract as the tool it's meant to sit quietly next to.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR =
  process.env.WHATSAPP_STATE_DIR ?? join(homedir(), ".whatsapp-channel");
// Overridable for tests only — production matches this plugin's own dir
// name, which is unique across the process tree. NOTE process.ppid is NOT
// the Claude Code CLI: a statusLine setting is a compound command, so this
// runs under a shell the CLI spawned separately. findServerPidForTerminal
// is what gets from here to the CLI.
const WRAPPER_MATCH =
  process.env.WA_STATUSLINE_WRAPPER_MATCH ?? "whatsapp-channel";
const SERVER_MATCH = process.env.WA_STATUSLINE_MATCH ?? "server.ts";
const PARENT_PID = Number(process.env.WA_STATUSLINE_PARENT_PID ?? process.ppid);

const COLOR: Record<string, string> = {
  primary: "\x1b[32m", // green
  secondary: "\x1b[36m", // cyan
  reconnecting: "\x1b[33m", // yellow
};
const RESET = "\x1b[0m";

export interface ProcRow {
  pid: number;
  ppid: number;
  command: string;
}

function listProcesses(): ProcRow[] {
  if (process.platform === "win32") {
    const out = execFileSync(
      `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    const parsed = out ? JSON.parse(out) : [];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((r) => ({
      pid: r.ProcessId,
      ppid: r.ParentProcessId,
      command: r.CommandLine ?? "",
    }));
  }
  const out = execFileSync("ps", ["-e", "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}

// The real launch chain (confirmed against a live session) is CLI -> plugin
// wrapper (`bun run --cwd <plugin> start`) -> server.ts, i.e. a *grandchild*
// of the CLI, not a direct child. WRAPPER_MAX_DEPTH=3 covers that plus one
// spare hop for a shell-wrapped launch (`cmd /c ...`, `sh -c ...`).
const WRAPPER_MAX_DEPTH = 3;
// server.ts is always a direct child of the wrapper in the confirmed chain;
// one spare hop here too, cheap since this only scans the wrapper's own
// subtree, not the whole process table.
const SERVER_MAX_DEPTH = 2;

// Breadth-first, first match wins. Only scans descendants of rootPid, so
// scoping rootPid to the already-identified wrapper (not the whole CLI
// process tree) is what keeps this from picking an unrelated process.
function findDescendant(
  rows: ProcRow[],
  rootPid: number,
  match: string,
  maxDepth: number,
): number | null {
  let frontier = new Set([rootPid]);
  for (let depth = 0; depth < maxDepth; depth++) {
    const children = rows.filter((r) => frontier.has(r.ppid));
    const hit = children.find((r) => r.command.includes(match));
    if (hit) return hit.pid;
    frontier = new Set(children.map((r) => r.pid));
    if (frontier.size === 0) break;
  }
  return null;
}

// EVERY match, shallowest first, because the wrapper pattern is the plugin
// dir name and more than one child of the CLI legitimately carries it in its
// command line: the statusline's own shell does (the documented wiring is
// `... && bun <plugin-dir>/scripts/statusline-role.ts`), this very script
// does, and so does any `bun <plugin-dir>/scripts/access.ts` the session
// happens to run. Win32_Process rows are not pid-ordered, so a first-match
// search picks an arbitrary one of them and the segment blanks out whenever
// that pick has no server.ts under it - the original bug, downgraded from
// permanent to intermittent, which is worse to diagnose.
function findDescendants(
  rows: ProcRow[],
  rootPid: number,
  match: string,
  maxDepth: number,
): number[] {
  const hits: number[] = [];
  let frontier = new Set([rootPid]);
  for (let depth = 0; depth < maxDepth; depth++) {
    const children = rows.filter((r) => frontier.has(r.ppid));
    for (const c of children) if (c.command.includes(match)) hits.push(c.pid);
    frontier = new Set(children.map((r) => r.pid));
    if (frontier.size === 0) break;
  }
  return hits;
}

export function findServerPid(
  rows: ProcRow[],
  cliPid: number,
  wrapperMatch: string,
  serverMatch: string,
): number | null {
  // A candidate is only the real wrapper if server.ts sits under it. The
  // decoys above have no such child, so they cost one scan of their own
  // (empty) subtree each and nothing else.
  for (const wrapperPid of findDescendants(
    rows,
    cliPid,
    wrapperMatch,
    WRAPPER_MAX_DEPTH,
  )) {
    const serverPid = findDescendant(
      rows,
      wrapperPid,
      serverMatch,
      SERVER_MAX_DEPTH,
    );
    if (serverPid !== null) return serverPid;
  }
  return null;
}

// The bug this exists for (issue #3): a statusLine setting is a compound
// command, so this script runs under a shell that the CLI spawned SEPARATELY
// from the plugin wrapper. The shell is the wrapper's SIBLING, not its
// ancestor:
//
//   claude.exe (CLI)
//   ├── bun run --cwd <plugin> start   (wrapper)
//   │   └── bun server.ts              <- the role file lives here
//   └── sh -c "<statusline command>"   <- process.ppid, where we start
//
// So searching down from process.ppid could never reach the wrapper, and
// the segment silently never rendered from PR #18 until now. Climb to the
// first common ancestor instead, retrying the wrapper search at each hop,
// nearest first.
//
// Deliberately NOT a scan of the whole process table: two terminals means
// two CLIs each with their own wrapper, and an arbitrary pick would show the
// OTHER terminal's role — the one thing this segment exists to tell apart.
//
// Bounded climb, 3 hops: enough for shell -> [shell] -> CLI with one spare.
//
// This tree walk can only tell "a server under this terminal" from "a server
// under a sibling terminal" while no shared ancestor is in range - and when
// one is, it picks the sibling's LIVE server over this terminal's own wrapper
// that has none yet, i.e. a confident wrong label rather than a blank. That
// is why roleFromOwnerStamp exists and runs first; this path is the
// compatibility fallback, kept only for a server that has not restarted since
// the stamp shipped, or a client that never sets CLAUDE_PID.
const ANCESTOR_MAX_HOPS = 3;

// This process, then its parent, then its parent's parent, nearest first.
export function ancestorChain(
  rows: ProcRow[],
  startPid: number,
  maxHops: number = ANCESTOR_MAX_HOPS,
): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const chain: number[] = [];
  let pid: number | undefined = startPid;
  for (let hop = 0; hop <= maxHops; hop++) {
    // pid 0 and a self-parenting row both appear in real Win32_Process
    // output. Neither can spin this loop - the hop bound ends it either way -
    // so this only skips the pointless work they would otherwise cause.
    if (pid === undefined || pid <= 0) break;
    chain.push(pid);
    pid = byPid.get(pid)?.ppid;
  }
  return chain;
}

// The stamped path (preferred): server.ts writes the pid of the Claude Code
// session that owns it as line 2 of its role file, so ownership is READ
// rather than inferred. A file whose owner is one of our own ancestors is
// ours by definition - a sibling terminal's server can never match, however
// close it sits in the process tree, and a stale file from a dead session
// cannot either, since a dead pid is nobody's ancestor.
//
// Nearest ancestor first, so the innermost session wins if a Claude Code
// session ever runs inside another one.
export function roleFromOwnerStamp(
  files: { content: string }[],
  ancestors: number[],
): string | null {
  const owners = new Map<number, string>();
  for (const f of files) {
    const [role, owner] = f.content.split("\n");
    const ownerPid = Number((owner ?? "").trim());
    // No line 2 at all: a server predating the stamp, or a client that never
    // identified itself. Unusable here - the tree search still covers it.
    if (!role || !Number.isInteger(ownerPid) || ownerPid <= 0) continue;
    if (!owners.has(ownerPid)) owners.set(ownerPid, role.trim());
  }
  for (const pid of ancestors) {
    const role = owners.get(pid);
    if (role) return role;
  }
  return null;
}

export function findServerPidForTerminal(
  rows: ProcRow[],
  startPid: number,
  wrapperMatch: string,
  serverMatch: string,
  maxHops: number = ANCESTOR_MAX_HOPS,
): number | null {
  for (const pid of ancestorChain(rows, startPid, maxHops)) {
    const found = findServerPid(rows, pid, wrapperMatch, serverMatch);
    if (found !== null) return found;
  }
  return null;
}

export function formatSegment(role: string): string {
  const color = COLOR[role];
  return color ? `${color}WA:${role}${RESET}` : "";
}

// Every role file in the state dir. Missing dir, unreadable file, no files
// at all: an empty list, same as every other miss in here.
function readRoleFiles(): { content: string }[] {
  try {
    return readdirSync(STATE_DIR)
      .filter((f) => f.startsWith(".role-"))
      .map((f) => {
        try {
          return { content: readFileSync(join(STATE_DIR, f), "utf8") };
        } catch {
          return { content: "" };
        }
      });
  } catch {
    return [];
  }
}

function main(): void {
  try {
    const rows = listProcesses();
    const ancestors = ancestorChain(rows, PARENT_PID);
    // Stamped ownership first. The tree search below is the fallback for a
    // server that has not been restarted since this shipped, or a client that
    // does not identify itself - it can confuse a sibling terminal's server
    // for ours, which is exactly what the stamp exists to prevent.
    const stamped = roleFromOwnerStamp(readRoleFiles(), ancestors);
    if (stamped) {
      const segment = formatSegment(stamped);
      if (segment) process.stdout.write(segment);
      return;
    }
    const pid = findServerPidForTerminal(
      rows,
      PARENT_PID,
      WRAPPER_MATCH,
      SERVER_MATCH,
    );
    if (pid === null) return;
    const roleFile = join(STATE_DIR, `.role-${pid}`);
    if (!existsSync(roleFile)) return;
    // Line 1 only: a stamped file has the owner pid on line 2.
    const segment = formatSegment(
      readFileSync(roleFile, "utf8").split("\n")[0]!.trim(),
    );
    if (segment) process.stdout.write(segment);
  } catch {
    // A broken statusline segment is worse than a missing one.
  }
}

if (import.meta.main) main();
