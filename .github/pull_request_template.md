<!-- markdownlint-disable-file MD041 -->
<!-- Thanks for contributing! Please fill this out so your PR is easy to review. -->

## What & why

<!-- What does this change do, and why? Link any related issue (e.g. "Fixes #4"). -->

## How I tested it

<!-- This is a live WhatsApp bridge — describe the manual steps you ran. -->

## Checklist

- [ ] I ran `trunk fmt` and `trunk check` and it passes.
- [ ] **Version bumped in BOTH files to the same new version** (patch = fix, minor = feature):
  - [ ] `.claude-plugin/plugin.json` → `version`
  - [ ] `.claude-plugin/marketplace.json` → `plugins[0].version` (the **inner** one — not the top-level marketplace version)
- [ ] No new runtime dependencies (or I opened an issue to discuss first).
- [ ] No runtime state / secrets committed (nothing from `~/.whatsapp-channel/`).
- [ ] If I touched `server.ts` connection lifecycle, the singleton lock, or access/allowlist gating, I described the invariant I preserved above.
