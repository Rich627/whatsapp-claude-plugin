import { join } from "node:path";

// Absolute, not "bun scripts/access.ts wizard": a marketplace install runs
// from ~/.claude/plugins/cache/.../whatsapp-claude-channel/<version>/, where
// the relative form resolves to nothing. JSON.stringify quotes the path
// (safe for install locations with spaces) and escapes any backslashes in a
// Windows path. pluginRoot is the caller's own repo-root directory
// (server.ts's import.meta.dir, or update-notice.ts's parent).
export function wizardCmd(pluginRoot: string): string {
  // Forward slashes even on Windows: join() gives back OS separators, and a
  // backslash path only gets uglier once JSON.stringify doubles each one -
  // bun and every shell in play here (bash, PowerShell) accept "/" fine.
  const path = join(pluginRoot, "scripts", "access.ts").replace(/\\/g, "/");
  return `bun ${JSON.stringify(path)} wizard`;
}
