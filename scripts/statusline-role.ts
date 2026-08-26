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
 *    Files whose server pid (from the filename) is not currently running a
 *    server are dropped first, so neither a killed server's file nor one
 *    whose pid has since been recycled can keep printing a role.
 * 2. The process tree, for a server that predates the stamp or a client that
 *    never identified itself: climb the ppid chain to the Claude Code CLI
 *    (this script does NOT run as its direct child — see
 *    findServerPidForTerminal), then the plugin's own wrapper among that
 *    CLI's descendants (matched on the plugin dir name — "server.ts" alone
 *    hits other plugins' servers too), then server.ts under that wrapper.
 *
 * If neither finds anything, one last check: is one of our own ancestors a
 * Claude Code CLI launched with this channel on its command line? Then a
 * server is on its way and we print a dim "WA:…" instead of nothing. Claude
 * Code does not re-render the statusline while the session is idle, so a
 * blank first paint stays blank until the user types - 16-22 s of "is this
 * thing on?". The marker means requested, not confirmed; a real role always
 * wins over it, and the server writing "starting" before it knows its role
 * renders identically.
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
// The Claude Code CLI is launched with the channel it was asked for on its
// command line: `claude.exe --channels=plugin:whatsapp-channel@whatsapp-claude-plugin`
// (confirmed live 2026-08-26; the shell above it carries the same string).
// Match the CHANNEL SPEC, not "whatsapp-channel" alone: the plugin's own
// directory name is in this script's command line too - the documented
// statusLine wiring is `... && bun <plugin-dir>/scripts/statusline-role.ts` -
// so the bare name would call every session pending, including sessions that
// never asked for WhatsApp. Overridable for tests only, same as the two above.
const CHANNEL_MATCH =
  process.env.WA_STATUSLINE_CHANNEL_MATCH ?? "plugin:whatsapp-channel";

const COLOR: Record<string, string> = {
  primary: "\x1b[32m", // green
  secondary: "\x1b[36m", // cyan
  reconnecting: "\x1b[33m", // yellow
  starting: "\x1b[2m", // dim - asked for, not confirmed yet
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
  files: string[],
  ancestors: number[],
): string | null {
  const owners = new Map<number, string>();
  for (const f of files) {
    const [role, owner] = f.split("\n");
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

// Nothing readable exists yet, but did this terminal even ask for WhatsApp?
// The CLI carries the channel it was launched with on its command line, so if
// one of OUR OWN ancestors is such a CLI, a server is on its way and the right
// thing to print is "requested, not confirmed" rather than nothing.
//
// Ancestors only, never a scan of the whole table, for the same reason as
// everything else in this file: a sibling terminal's CLI would otherwise make
// this one claim a channel it never asked for.
export function pendingRoleFromAncestors(
  rows: ProcRow[],
  ancestors: number[],
): string | null {
  const mine = new Set(ancestors);
  return rows.some((r) => mine.has(r.pid) && r.command.includes(CHANNEL_MATCH))
    ? "starting"
    : null;
}

// "starting" has no role to name yet - it means the server is coming up, or
// this terminal asked for the channel and nothing has answered. One ellipsis
// glyph, dim, so the first paint is never blank and never claims a role.
const LABEL: Record<string, string> = { starting: "…" };

export function formatSegment(role: string): string {
  const color = COLOR[role];
  return color ? `${color}WA:${LABEL[role] ?? role}${RESET}` : "";
}

// Every role file in the state dir whose server is still running. Missing
// dir, unreadable file, no files at all: an empty list, same as every other
// miss in here.
//
// The liveness filter is what stops a stamped file outliving its server:
// only a graceful exit removes one, so a killed server leaves a file whose
// owning session is still alive and still our ancestor, and the stamp would
// keep printing a role for a server that is gone. server.ts's startup sweep
// cannot cover it - nothing starts.
//
// A live pid is not enough on its own, though. A pid names a slot, not a
// process: once the killed server's pid is recycled by any unrelated process
// the file passes a liveness test again, and the segment goes back to
// printing a role for a server that does not exist - a statusline that
// claims a connection is live is worse than one that says nothing, since
// telling the two terminals apart is the whole reason it is on screen. So
// the process holding that pid must also LOOK like the server (confirmed
// against a live one: its command line is `bun server.ts`). What is left is
// a recycled pid that happens to be another server.ts whose file is also
// stamped with one of our own ancestors, which does not happen in practice.
//
// A non-numeric name has no entry either and drops out the same way.
function readRoleFiles(liveCommands: Map<number, string>): string[] {
  try {
    return readdirSync(STATE_DIR)
      .filter((f) => f.startsWith(".role-"))
      .filter((f) => {
        const command = liveCommands.get(Number(f.slice(".role-".length)));
        return command !== undefined && command.includes(SERVER_MATCH);
      })
      .map((f) => {
        try {
          return readFileSync(join(STATE_DIR, f), "utf8");
        } catch {
          return "";
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
    const stamped = roleFromOwnerStamp(
      readRoleFiles(new Map(rows.map((r) => [r.pid, r.command]))),
      ancestors,
    );
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
    const roleFile = pid === null ? "" : join(STATE_DIR, `.role-${pid}`);
    // Line 1 only: a stamped file has the owner pid on line 2.
    const tree =
      roleFile && existsSync(roleFile)
        ? readFileSync(roleFile, "utf8").split("\n")[0]!.trim()
        : "";
    // Last: neither path found a role file for this terminal, so fall back to
    // "this terminal asked for the channel" - the marker, not a role.
    const role = tree || pendingRoleFromAncestors(rows, ancestors) || "";
    const segment = formatSegment(role);
    if (segment) process.stdout.write(segment);
  } catch {
    // A broken statusline segment is worse than a missing one.
  }
}

if (import.meta.main) main();
