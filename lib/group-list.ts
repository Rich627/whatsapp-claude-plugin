import { safeName } from "./sanitize";

// list_groups' text. Only allowlisted groups are listed, the only ones the
// plugin can send to: an account in hundreds of groups otherwise floods the
// session with ids it cannot use, some of them legacy
// `<creator-phone>-<ts>@g.us` ids.
export function formatGroupList(
  groups: { id: string; subject?: string | null }[],
  allowlist: Record<string, { roster?: boolean }>,
): string {
  if (groups.length === 0) return "This account is not in any groups.";
  const allowed = groups
    .filter((g) => Object.hasOwn(allowlist, g.id))
    // Same reason as resolveGroupName: an admin-settable subject is
    // rendered into text the model reads.
    .map((g) => ({ ...g, name: safeName(g.subject)?.trim() || "(no name)" }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const lines = allowed.map(
    (g) =>
      `${g.name}${allowlist[g.id]?.roster ? "  (roster access)" : ""}\n    ${g.id}`,
  );
  return allowed.length
    ? `${allowed.length} allowlisted group(s):\n\n${lines.join("\n")}`
    : "No joined group is allowlisted.";
}
