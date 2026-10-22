import { delimiter, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Parse WHATSAPP_ATTACH_DIRS: a list of directories that outbound
 * attachments may come from, separated by the platform's path delimiter
 * (":", or ";" on Windows so drive letters survive). A leading "~" is the
 * home directory. Relative entries are dropped rather than resolved against
 * whatever the server's CWD happens to be, so the list means the same thing
 * however the server was launched. Unset, blank or invalid returns []:
 * only the inbox and outbox are exportable unless extra directories are granted.
 */
export function parseAttachDirs(
  raw: string | undefined,
  home: string,
  separator: string = delimiter,
): string[] {
  const parts = (raw ?? "")
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
  const dirs: string[] = [];
  for (const entry of parts) {
    const expanded =
      entry === "~"
        ? home
        : entry.startsWith("~/")
          ? join(home, entry.slice(2))
          : entry;
    if (!isAbsolute(expanded)) continue;
    dirs.push(resolve(expanded));
  }
  return dirs;
}

/**
 * True when `real` (an already-resolved path) is strictly inside one of
 * `dirs` (also resolved). A directory itself is not "inside" itself, and
 * "/a/bc" is not inside "/a/b".
 */
export function isInsideAny(real: string, dirs: string[]): boolean {
  return dirs.some((dir) =>
    real.startsWith(dir.endsWith(sep) ? dir : dir + sep),
  );
}
