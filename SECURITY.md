# Security Policy

This project bridges WhatsApp into Claude Code. A running instance holds **WhatsApp
linked-device credentials** and can **send and receive messages as the linked account**,
so security reports are taken seriously.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use GitHub's private reporting:

1. Go to the [**Security** tab](https://github.com/Rich627/whatsapp-claude-plugin/security)
   of this repository.
2. Click **Report a vulnerability** to open a private advisory.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (or a proof of concept).
- Any affected version(s) or configuration.

You can expect an initial response within a few days. Please give a reasonable window
to fix the issue before any public disclosure.

## Scope & things to keep in mind

- Runtime secrets (WhatsApp auth, access config) live in `~/.whatsapp-channel/` and
  must **never** be committed to the repository. If you find credentials or tokens in
  the git history or in a PR, treat it as a security report.
- Access control (DM/group allowlists, pairing codes, LID↔phone mapping) is a security
  boundary. Bugs that let an unauthorized sender trigger the agent are in scope.
- This is a hobbyist/community project with no formal SLA, but genuine reports will
  always get a response.
