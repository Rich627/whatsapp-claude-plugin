#!/usr/bin/env bun
/**
 * statusline-role.ts — prints "WA:<role>" for the WhatsApp MCP server
 * belonging to *this* terminal, or nothing if there isn't one running here.
 *
 * Wire it into a Claude Code statusLine command, appended after whatever it
 * already prints, e.g.:
 *   your-existing-statusline-command && bun <plugin-dir>/scripts/statusline-role.ts
 *
 * Finds the server in three steps: climb the ppid chain to the Claude Code
 * CLI that owns this terminal (this script does NOT run as its direct child
 * — see findServerPidForTerminal), then the plugin's own wrapper process
 * among that CLI's descendants (identified by the plugin dir name — unique
 * even when another plugin's server also happens to be named server.ts,
 * which is common enough that matching "server.ts" against the whole process
 * tree picks the wrong one), then server.ts among *that wrapper's* children
 * specifically. Reads the matched pid's role file (written by server.ts on
 * every role change — see ROLE_FILE there). Never throws, never writes:
 * prints nothing and exits 0 on any miss, same contract as the tool it's
 * meant to sit quietly next to.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
// ponytail: bounded climb, 3 hops. Ceiling: if this terminal has no server
// of its own AND a host process (a terminal app owning several tabs) sits
// within 3 hops, the climb reaches a sibling terminal's wrapper and shows
// ITS role. Note this is now the deterministic outcome, not a coincidence:
// findServerPid tries every candidate, so once a sibling's wrapper is in
// range its live server.ts always wins over this terminal's own wrapper that
// has none (still starting, or shut down). A confident wrong label, where
// the first-match version would more often have rendered nothing. Blank was
// the honest answer, so this trade is only acceptable because the reach
// needs a tab host inside 3 hops, which no layout seen so far has.
// 3 covers shell -> [shell] -> CLI with one hop spare. Real fix when it
// bites: have server.ts record the owning CLI pid in the role file and match
// on it, instead of inferring ownership from the process tree.
const ANCESTOR_MAX_HOPS = 3;

export function findServerPidForTerminal(
  rows: ProcRow[],
  startPid: number,
  wrapperMatch: string,
  serverMatch: string,
  maxHops: number = ANCESTOR_MAX_HOPS,
): number | null {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  let pid: number | undefined = startPid;
  for (let hop = 0; hop <= maxHops; hop++) {
    // pid 0 and a self-parenting row both appear in real Win32_Process
    // output. Neither can spin this loop - the hop bound ends it either way -
    // so this only skips the pointless scans they would otherwise cause.
    if (pid === undefined || pid <= 0) return null;
    const found = findServerPid(rows, pid, wrapperMatch, serverMatch);
    if (found !== null) return found;
    pid = byPid.get(pid)?.ppid;
  }
  return null;
}

export function formatSegment(role: string): string {
  const color = COLOR[role];
  return color ? `${color}WA:${role}${RESET}` : "";
}

function main(): void {
  try {
    const pid = findServerPidForTerminal(
      listProcesses(),
      PARENT_PID,
      WRAPPER_MATCH,
      SERVER_MATCH,
    );
    if (pid === null) return;
    const roleFile = join(STATE_DIR, `.role-${pid}`);
    if (!existsSync(roleFile)) return;
    const segment = formatSegment(readFileSync(roleFile, "utf8").trim());
    if (segment) process.stdout.write(segment);
  } catch {
    // A broken statusline segment is worse than a missing one.
  }
}

if (import.meta.main) main();
