#!/usr/bin/env bash

# WhatsApp channel onboarding — checks setup state and guides user through next steps.

STATE_DIR="${WHATSAPP_STATE_DIR:-${HOME}/.whatsapp-channel}"
ENV_FILE="${STATE_DIR}/.env"
AUTH_CREDS="${STATE_DIR}/.baileys_auth/creds.json"
ACCESS_FILE="${STATE_DIR}/access.json"

# Plugin root relative to this script's own location (not CWD): correct
# regardless of where the hook was launched from.
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Check setup state
has_phone=false
has_auth=false
has_contacts=false

if [ -f "$ENV_FILE" ] && grep -q 'WHATSAPP_PHONE_NUMBER=' "$ENV_FILE" 2>/dev/null; then
	has_phone=true
fi

# Both JSON files are written pretty-printed (JSON.stringify with indent by
# server.ts/scripts/access.ts; Baileys may do either), so a pattern must not
# assume compact "key":value spacing — strip all whitespace before matching.
# Grepping the file directly only ever matched compact JSON, which left
# has_contacts false on every current install and buried the fully-configured
# branch (and the update notice) below.
json_has() {
	local flat
	flat="$(tr -d '[:space:]' <"${1}" 2>/dev/null)" || return 1
	grep -q "${2}" <<<"${flat}"
}

if [[ -f ${AUTH_CREDS} ]] && json_has "${AUTH_CREDS}" '"registered":true'; then
	has_auth=true
fi

if [[ -f ${ACCESS_FILE} ]] && json_has "${ACCESS_FILE}" '"allowFrom":\[".'; then
	has_contacts=true
fi

# Build context message based on state
if [ "$has_phone" = false ]; then
	msg="WhatsApp plugin installed but not configured yet. Guide the user through setup:\n\n1. Run: /whatsapp-channel:configure <phone> (country code + number, no +, e.g. 886912345678)\n2. Exit and launch: claude --dangerously-load-development-channels plugin:whatsapp-channel@whatsapp-claude-plugin\n3. The pairing code appears automatically — enter it on phone: WhatsApp > Linked Devices > Link with phone number instead\n\nPrompt the user to provide their WhatsApp phone number to get started."
elif [ "$has_auth" = false ]; then
	msg="WhatsApp phone number is configured but device is not paired yet.\n\nThe user needs to:\n1. Exit and launch: claude --dangerously-load-development-channels plugin:whatsapp-channel@whatsapp-claude-plugin\n2. The pairing code appears automatically in the session\n3. Enter it on phone: WhatsApp > Linked Devices > Link with phone number instead"
elif [ "$has_contacts" = false ]; then
	msg="WhatsApp is paired but no contacts are allowlisted yet. The owner JID is auto-added on connection.\n\nIf the user needs to add other contacts:\n1. Run: /whatsapp-channel:access policy pairing\n2. Have them DM the linked number\n3. Run: /whatsapp-channel:access pair <code>\n4. Policy auto-locks back to allowlist after pairing"
else
	# Fully configured: check for a one-time "what's new" notice first. It
	# prints its own complete, already-valid JSON (built with
	# JSON.stringify, not hand-rolled here) when there's something new, and
	# nothing otherwise — a real bun script rather than more bash so version
	# compare and JSON escaping reuse localeCompare/JSON.stringify instead
	# of reimplementing both (see scripts/update-notice.ts).
	notice_json="$(bun "${PLUGIN_ROOT}/scripts/update-notice.ts" 2>/dev/null)"
	if [[ -n ${notice_json} ]]; then
		echo "${notice_json}"
		exit 0
	fi
	msg="WhatsApp channel is fully configured and ready. Paired contacts can message this session."
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
