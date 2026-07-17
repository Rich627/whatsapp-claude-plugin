# Contributing

Thanks for contributing to the WhatsApp MCP Server for Claude Code! This project is
small and moves fast, so a few conventions keep pull requests easy to review and merge.

## Project at a glance

- **Runtime:** [Bun](https://bun.sh). TypeScript runs directly — there is **no build
  step** and **no test suite**.
- **Dependencies:** only two — `@modelcontextprotocol/sdk` and
  `@whiskeysockets/baileys`. Baileys is pinned to a release candidate and patched by
  `patch-baileys.mjs` (runs automatically on `postinstall`). **Please do not add new
  runtime dependencies without opening an issue first** — a slim dependency tree is a
  deliberate goal.
- **The whole MCP server is one file:** `server.ts`.

## Getting set up

```bash
bun install     # installs deps and runs patch-baileys.mjs via postinstall
bun server.ts   # runs the MCP server
```

Runtime state (WhatsApp auth, access config, group data) lives in
`~/.whatsapp-channel/`, created at runtime. **Never commit runtime state into the
repo.**

## Before you open a pull request

1. **Format and lint with Trunk.** CI runs `trunk check` on every PR.

   ```bash
   trunk fmt      # auto-format
   trunk check    # lint (prettier, markdownlint, shellcheck, shfmt, checkov, trufflehog)
   ```

2. **Bump the version — in BOTH files.** This is the single most common mistake in
   PRs, and getting it wrong makes `plugin update` silently no-op for every user. You
   must bump **both** of these to the **same** new version:

   - `.claude-plugin/plugin.json` → `version`
   - `.claude-plugin/marketplace.json` → `plugins[0].version` (the **inner** one)

   > ⚠️ `marketplace.json` also has a **top-level** `version` field — that is the
   > marketplace's own version. **Leave it alone.** Only the `plugins[0].version`
   > needs to match `plugin.json`.

   Quick check (should print two matching versions):

   ```bash
   grep -n '"version"' .claude-plugin/plugin.json .claude-plugin/marketplace.json
   ```

   Use semver: **patch** for fixes, **minor** for features. CI enforces that the two
   versions match.

3. **Be careful in `server.ts`'s sensitive areas.** Three areas have regressed before.
   If your change touches any of them, please call out in the PR description what
   invariant you preserved:

   - **Connection lifecycle** (connect / reconnect / disconnect handling)
   - **The singleton lock** (prevents duplicate/orphaned servers silently killing
     replies)
   - **Allowlist / access gating** (DM & group access control, LID↔phone mapping)

   `server.ts` uses module-level state that spans the whole file, so `grep` the whole
   file for every symbol you touch before changing it.

## Pull request expectations

- Keep PRs focused — one fix or feature per PR is much easier to review.
- Describe **what** changed and **why**, and how you tested it (this is a live
  WhatsApp bridge, so note the manual steps you ran).
- The PR template checklist covers the version bump and `trunk check` — please tick it
  honestly.

## Reporting bugs & security issues

- **Bugs / features:** open a GitHub issue using the templates.
- **Security vulnerabilities:** please do **not** open a public issue — see
  [`SECURITY.md`](SECURITY.md).
