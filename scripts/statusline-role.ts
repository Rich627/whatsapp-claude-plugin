#!/usr/bin/env bun
/**
 * statusline-role.ts — prints "WA:<role>" for the WhatsApp MCP server
 * belonging to *this* terminal, or nothing if there isn't one running here.
 *
 * Wire it into a Claude Code statusLine command, appended after whatever it
 * already prints, e.g.:
 *   your-existing-statusline-command && bun <plugin-dir>/scripts/statusline-role.ts
 *
 * Finds the server in two steps: first the plugin's own wrapper process
 * (a descendant of the Claude Code CLI that spawned this statusline command,
 * identified by the plugin dir name — unique even when another plugin's
 * server also happens to be named server.ts, which is common enough that
 * matching "server.ts" against the whole process tree picks the wrong one),
 * then server.ts among *that wrapper's* children specifically. Reads the
 * matched pid's role file (written by server.ts on every role change — see
 * ROLE_FILE there). Never throws, never writes: prints nothing and exits 0
 * on any miss, same contract as the tool it's meant to sit quietly next to.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR =
  process.env.WHATSAPP_STATE_DIR ?? join(homedir(), ".whatsapp-channel");
// Overridable for tests only — production matches this plugin's own dir
// name (unique across the process tree) and walks up to this script's real
// parent, the Claude Code CLI.
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

export function findServerPid(
  rows: ProcRow[],
  cliPid: number,
  wrapperMatch: string,
  serverMatch: string,
): number | null {
  const wrapperPid = findDescendant(
    rows,
    cliPid,
    wrapperMatch,
    WRAPPER_MAX_DEPTH,
  );
  if (wrapperPid === null) return null;
  return findDescendant(rows, wrapperPid, serverMatch, SERVER_MAX_DEPTH);
}

export function formatSegment(role: string): string {
  const color = COLOR[role];
  return color ? `${color}WA:${role}${RESET}` : "";
}

function main(): void {
  try {
    const pid = findServerPid(
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
