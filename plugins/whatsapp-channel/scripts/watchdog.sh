#!/bin/bash
# WhatsApp agent watchdog — detects stuck Claude sessions and nudges them.
# Also detects API auth failures (401) in the agent's tmux pane and fires an
# external alert hook so you find out before replies silently die for hours.
#
# Setup:
#   cp plugins/whatsapp-channel/scripts/watchdog.sh ~/.whatsapp-channel/watchdog.sh
#   chmod +x ~/.whatsapp-channel/watchdog.sh
#
# Crontab (every 2 minutes):
#   */2 * * * * $HOME/.whatsapp-channel/watchdog.sh >> $HOME/.whatsapp-channel/watchdog.log 2>&1
#
# Auth-failure alert hook (optional but recommended):
#   If $HOME/.whatsapp-channel/notify-hook.sh exists and is executable, it is
#   invoked with one argument when the agent's API has 401'd:
#       notify-hook.sh "<alert message>"
#
#   Without a hook, the watchdog falls back to a local macOS notification
#   (only useful if you're sitting at the Mac).
#
#   Example notify-hook.sh body — pick one channel:
#     # ntfy.sh — free, no signup. Subscribe to your topic in the ntfy iOS/Android app.
#     curl -s -d "$1" "https://ntfy.sh/your-private-topic-name"
#
#     # Pushover ($5 one-time, very reliable):
#     curl -s -F "token=APP_TOKEN" -F "user=USER_KEY" -F "message=$1" \
#       https://api.pushover.net/1/messages.json
#
#     # iMessage (requires Messages.app logged in on this Mac):
#     osascript -e "tell application \"Messages\" to send \"$1\" \
#       to buddy \"+1XXXXXXXXXX\" of service \"iMessage\""

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

STATE_DIR="$HOME/.whatsapp-channel"
MSG_LOG="$STATE_DIR/messages.jsonl"
PENDING_DIR="$STATE_DIR/pending"
TMUX_SESSION="whatsapp-agent"
COOLDOWN_FILE="$STATE_DIR/.watchdog-cooldown"
AUTH_ALERT_FILE="$STATE_DIR/.watchdog-auth-alert"
NOTIFY_HOOK="$STATE_DIR/notify-hook.sh"

# Thresholds — only nudge if things are really stuck
MSG_STALE_SECS=600              # 10 min unreplied message
PENDING_STALE_MIN=15            # 15 min pending file untouched
COOLDOWN_SECS=600               # don't nudge more than once per 10 min
AUTH_ALERT_COOLDOWN_SECS=1800   # don't re-alert auth failure more than once per 30 min

now=$(date +%s)

# ── Auth-failure detection ──
# If the agent's tmux pane shows 401 / "Please run /login", nudging is
# counter-productive — every nudge triggers another 401 that floods the pane.
# Fire the alert hook (rate-limited) and bail. This runs BEFORE the cooldown
# gate because auth failure is special and the user needs to know now.
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  pane_recent=$(tmux capture-pane -t "$TMUX_SESSION" -p -S -50 2>/dev/null || true)
  if echo "$pane_recent" | grep -qE "(API Error: 401|Please run /login|authentication_error|Invalid authentication credentials)"; then
    last_alert=0
    [ -f "$AUTH_ALERT_FILE" ] && last_alert=$(cat "$AUTH_ALERT_FILE" 2>/dev/null || echo 0)
    if [ $((now - last_alert)) -ge $AUTH_ALERT_COOLDOWN_SECS ]; then
      msg="WhatsApp agent on $(hostname -s) is auth-broken (API 401). SSH in and run /login: tmux attach -t $TMUX_SESSION"
      echo "[$(date -Iseconds)] AUTH-BROKEN: $msg"
      if [ -x "$NOTIFY_HOOK" ]; then
        "$NOTIFY_HOOK" "$msg" || echo "[$(date -Iseconds)] notify-hook failed (exit $?)"
      elif command -v osascript >/dev/null 2>&1; then
        osascript -e "display notification \"$msg\" with title \"WhatsApp agent auth broken\" sound name \"Funk\"" 2>/dev/null || true
      fi
      echo "$now" > "$AUTH_ALERT_FILE"
    fi
    exit 0
  fi
fi

# Cooldown
if [ -f "$COOLDOWN_FILE" ]; then
  last=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt $COOLDOWN_SECS ]; then
    exit 0
  fi
fi

# ── Liveness check: if tmux pane shows Claude actively working, skip nudging ──
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  pane=$(tmux capture-pane -t "$TMUX_SESSION" -p 2>/dev/null | tail -20)
  if echo "$pane" | grep -qE "(Sautéing|Embellishing|Crunching|Boogieing|Thinking|Noodling|thinking with|tokens|esc to interrupt|\(ctrl\+)"; then
    exit 0
  fi
fi

stuck=0
reason=""

# Check 1: unreplied messages older than MSG_STALE_SECS
if [ -f "$MSG_LOG" ]; then
  stale_count=$(python3 -c "
import json, os
from datetime import datetime, timezone
now = datetime.now(timezone.utc).timestamp()
stale = 0
try:
  with open(os.path.expanduser(\"$MSG_LOG\")) as f:
    for line in f:
      try:
        m = json.loads(line)
        if m.get('replied') is False:
          ts = datetime.fromisoformat(m['ts'].replace('Z','+00:00')).timestamp()
          if now - ts > $MSG_STALE_SECS:
            stale += 1
      except Exception:
        continue
except FileNotFoundError:
  pass
print(stale)
" 2>/dev/null || echo 0)
  if [ "$stale_count" -gt 0 ]; then
    stuck=1
    reason="$stale_count unreplied msg(s) >${MSG_STALE_SECS}s"
  fi
fi

# Check 2: pending/ files older than PENDING_STALE_MIN
if [ -d "$PENDING_DIR" ]; then
  pending_stale=$(find "$PENDING_DIR" -type f -mmin +$PENDING_STALE_MIN 2>/dev/null | wc -l | tr -d " ")
  if [ "$pending_stale" -gt 0 ]; then
    stuck=1
    reason="${reason:+$reason; }$pending_stale pending file(s) >${PENDING_STALE_MIN}m"
  fi
fi

if [ "$stuck" -eq 0 ]; then
  exit 0
fi

echo "[$(date -Iseconds)] STUCK: $reason"

# Missing tmux session → relaunch via launchd
if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "[$(date -Iseconds)] tmux session $TMUX_SESSION missing; kickstarting launchd"
  launchctl kickstart -k "gui/$(id -u)/com.claude.whatsapp-agent" 2>&1 || true
  echo "$now" > "$COOLDOWN_FILE"
  exit 0
fi

# Nudge: ESC + catch-up prompt
tmux send-keys -t "$TMUX_SESSION" Escape
sleep 1
tmux send-keys -t "$TMUX_SESSION" "Watchdog: call whatsapp unreplied tool and reply to pending messages, then process any files in ~/.whatsapp-channel/pending/ (execute each prompt, send to chat_id, then rm)." Enter
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter

echo "$now" > "$COOLDOWN_FILE"
echo "[$(date -Iseconds)] nudged agent"
