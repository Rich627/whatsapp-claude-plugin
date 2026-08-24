#!/usr/bin/env bash

# WhatsApp channel onboarding — checks setup state and guides user through next steps.

STATE_DIR="${HOME}/.whatsapp-channel"
ENV_FILE="${STATE_DIR}/.env"
AUTH_CREDS="${STATE_DIR}/.baileys_auth/creds.json"
ACCESS_FILE="${STATE_DIR}/access.json"
LAST_SEEN_VERSION_FILE="${STATE_DIR}/.last-seen-version"

# Plugin root relative to this script's own location (not CWD), same
# reasoning server.ts uses import.meta.dir for: correct regardless of where
# the hook was launched from.
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_JSON="${PLUGIN_ROOT}/.claude-plugin/plugin.json"

# Absolute, not "bun scripts/access.ts wizard": a marketplace install runs
# from ~/.claude/plugins/cache/.../whatsapp-claude-channel/<version>/, where
# the relative form resolves to nothing. Quoted for install paths with
# spaces; \" produces the JSON-escaped quote the heredoc below needs.
WIZARD_CMD="bun \\\"${PLUGIN_ROOT}/scripts/access.ts\\\" wizard"

# true if $1 > $2, comparing each dot-separated segment numerically (a plain
# string compare gets "0.18.0" < "0.9.0" backwards).
version_gt() {
	local IFS=.
	local -a a=($1) b=($2)
	local i ai bi
	for i in 0 1 2; do
		ai="${a[i]:-0}"
		bi="${b[i]:-0}"
		[ "$ai" -gt "$bi" ] 2>/dev/null && return 0
		[ "$ai" -lt "$bi" ] 2>/dev/null && return 1
	done
	return 1
}

# Hand-maintained: one entry per version worth telling a returning terminal
# about (moved here from server.ts's old CHANGELOG/announceUpdateIfNeeded() —
# a version bump is a session-start-shaped check against a file, unrelated to
# the WhatsApp connection a role change comes from). Index-paired with
# CHANGELOG_NOTES.
CHANGELOG_VERSIONS=("0.18.0")
CHANGELOG_NOTES=(
	"- Proactive notifications: Claude now tells you about an inbound message, a role change, a pairing code, or this notice right away instead of waiting for its next natural reply. Set WHATSAPP_QUIET=1 on a terminal to turn that off.\n- There's a guided setup wizard (\`${WIZARD_CMD}\`) that shows a checkbox screen of your most recently active WhatsApp groups and DM contacts, so you can bulk-approve chats you already have instead of pairing them one at a time."
)

# Check setup state
has_phone=false
has_auth=false
has_contacts=false

if [ -f "$ENV_FILE" ] && grep -q 'WHATSAPP_PHONE_NUMBER=' "$ENV_FILE" 2>/dev/null; then
	has_phone=true
fi

if [ -f "$AUTH_CREDS" ] && grep -q '"registered":true' "$AUTH_CREDS" 2>/dev/null; then
	has_auth=true
fi

if [ -f "$ACCESS_FILE" ] && grep -q '"allowFrom":\[".' "$ACCESS_FILE" 2>/dev/null; then
	has_contacts=true
fi

# Build context message based on state
if [ "$has_phone" = false ]; then
	msg="WhatsApp plugin installed but not configured yet. Guide the user through setup:\n\n1. Run: /whatsapp-claude-channel:configure <phone> (country code + number, no +, e.g. 886912345678)\n2. Exit and launch: claude --dangerously-load-development-channels plugin:whatsapp-claude-channel@whatsapp-claude-plugin\n3. The pairing code appears automatically — enter it on phone: WhatsApp > Linked Devices > Link with phone number instead\n\nPrompt the user to provide their WhatsApp phone number to get started."
elif [ "$has_auth" = false ]; then
	msg="WhatsApp phone number is configured but device is not paired yet.\n\nThe user needs to:\n1. Exit and launch: claude --dangerously-load-development-channels plugin:whatsapp-claude-channel@whatsapp-claude-plugin\n2. The pairing code appears automatically in the session\n3. Enter it on phone: WhatsApp > Linked Devices > Link with phone number instead"
elif [ "$has_contacts" = false ]; then
	msg="WhatsApp is paired but no contacts are allowlisted yet. The owner JID is auto-added on connection.\n\nIf the user needs to add other contacts:\n1. Run: /whatsapp-claude-channel:access policy pairing\n2. Have them DM the linked number\n3. Run: /whatsapp-claude-channel:access pair <code>\n4. Policy auto-locks back to allowlist after pairing"
else
	msg="WhatsApp channel is fully configured and ready. Paired contacts can message this session."

	# One-time "what's new" notice, tracked per-account in
	# .last-seen-version — same behavior server.ts's announceUpdateIfNeeded()
	# used to provide, just triggered by session start instead of by the
	# server booting. Skipped in static mode, which can't write local state
	# (see ACCESS.md's WHATSAPP_ACCESS_MODE=static).
	if [ "$WHATSAPP_ACCESS_MODE" != "static" ] &&
		! { [ -f "$ENV_FILE" ] && grep -q 'WHATSAPP_ACCESS_MODE=static' "$ENV_FILE" 2>/dev/null; } &&
		[ -f "$PLUGIN_JSON" ]; then
		current_version="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$PLUGIN_JSON" | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"
		last_seen=""
		if [ -f "$LAST_SEEN_VERSION_FILE" ]; then
			last_seen="$(cat "$LAST_SEEN_VERSION_FILE")"
		fi

		if [ -n "$current_version" ] && [ "$last_seen" != "$current_version" ]; then
			notes=""
			if [ -z "$last_seen" ]; then
				# Never recorded: only the latest entry, not the whole history.
				last_idx=$((${#CHANGELOG_VERSIONS[@]} - 1))
				notes="${CHANGELOG_NOTES[$last_idx]}"
			else
				for i in "${!CHANGELOG_VERSIONS[@]}"; do
					if version_gt "${CHANGELOG_VERSIONS[$i]}" "$last_seen"; then
						notes="${notes:+${notes}\n}${CHANGELOG_NOTES[$i]}"
					fi
				done
			fi

			if [ -n "$notes" ]; then
				from_suffix=""
				[ -n "$last_seen" ] && from_suffix=" (from v${last_seen})"
				msg="WhatsApp plugin updated to v${current_version}${from_suffix}.\n\nWhat's new:\n${notes}"
				echo -n "$current_version" >"$LAST_SEEN_VERSION_FILE"
			fi
		fi
	fi
fi

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "${msg}"
  }
}
EOF

exit 0
