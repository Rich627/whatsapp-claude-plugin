#!/bin/bash
# WhatsApp agent watchdog — detects stuck Claude sessions and nudges them.
# If nudging doesn't unstick it within STUCK_STREAK_LIMIT consecutive checks
# (e.g. the WhatsApp/Baileys connection itself dropped, which a nudge can't
# fix), it hard-restarts the agent instead — via $HOME/start-whatsapp-agent.sh
# if you have one, otherwise a launchd kickstart.
# Also detects API auth failures (401) in the agent's tmux pane and fires an
# external alert hook so you find out before replies silently die for hours.
#
# Setup:
#   cp scripts/watchdog.sh ~/.whatsapp-channel/watchdog.sh
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
STUCK_STREAK_FILE="$STATE_DIR/.watchdog-stuck-streak"
RESTART_COOLDOWN_FILE="$STATE_DIR/.watchdog-restart-cooldown"
# Optional: a full agent restart script (graceful /exit + relaunch), e.g. one
# that ends with `tmux new-session -d -s whatsapp-agent ... claude ...`.
# If absent, hard restarts fall back to a launchd kickstart.
RESTART_SCRIPT="$HOME/start-whatsapp-agent.sh"

# Thresholds — only nudge if things are really stuck
MSG_STALE_SECS=600              # 10 min unreplied message
PENDING_STALE_MIN=15            # 15 min pending file untouched
COOLDOWN_SECS=600               # don't nudge more than once per 10 min
AUTH_ALERT_COOLDOWN_SECS=1800   # don't re-alert auth failure more than once per 30 min
STUCK_STREAK_LIMIT=3            # after this many consecutive stuck-and-nudged checks
                                 # (~20-30 min), stop nudging and hard-restart instead —
                                 # a nudge only re-asks the agent to call its tools, which
                                 # can't fix a dead WhatsApp connection the agent itself
                                 # can't reconnect (see docs/governance/A-diagnosis.md #2)
RESTART_COOLDOWN_SECS=1800      # don't hard-restart more than once per 30 min

now=$(date +%s)

# Full restart: tmux session is alive but repeated nudges haven't unstuck it
# (e.g. the WhatsApp/Baileys connection itself dropped and won't self-heal —
# a nudge just re-asks the agent to call tools against a connection that's
# still dead). Returns 1 (does nothing) if the restart cooldown is active.
hard_restart() {
  local reason="$1"
  local last_restart=0
  [ -f "$RESTART_COOLDOWN_FILE" ] && last_restart=$(cat "$RESTART_COOLDOWN_FILE" 2>/dev/null || echo 0)
  if [ $((now - last_restart)) -lt $RESTART_COOLDOWN_SECS ]; then
    echo "[$(date -Iseconds)] would hard-restart ($reason) but restart cooldown active; nudging instead"
    return 1
  fi

  echo "[$(date -Iseconds)] HARD-RESTART: $reason"
  if [ -x "$RESTART_SCRIPT" ]; then
    nohup "$RESTART_SCRIPT" >>"$STATE_DIR/watchdog-restart.log" 2>&1 &
  else
    launchctl kickstart -k "gui/$(id -u)/com.claude.whatsapp-agent" 2>&1 || true
  fi

  msg="WhatsApp agent on $(hostname -s) auto-restarted by watchdog ($reason)."
  if [ -x "$NOTIFY_HOOK" ]; then
    "$NOTIFY_HOOK" "$msg" || echo "[$(date -Iseconds)] notify-hook failed (exit $?)"
  elif command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$msg\" with title \"WhatsApp agent auto-restarted\" sound name \"Funk\"" 2>/dev/null || true
  fi

  echo "0" > "$STUCK_STREAK_FILE"
  echo "$now" > "$RESTART_COOLDOWN_FILE"
  echo "$now" > "$COOLDOWN_FILE"
  return 0
}

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
    echo "0" > "$STUCK_STREAK_FILE"
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
  echo "0" > "$STUCK_STREAK_FILE"
  exit 0
fi

echo "[$(date -Iseconds)] STUCK: $reason"

# Missing tmux session → relaunch via the restart script when available
# (falling back to launchd). Kickstarting a launchd service that was never
# installed 502s forever and the agent stays down — seen 2026-07-14.
if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  if [ -x "$RESTART_SCRIPT" ]; then
    echo "[$(date -Iseconds)] tmux session $TMUX_SESSION missing; relaunching via $RESTART_SCRIPT"
    nohup "$RESTART_SCRIPT" >>"$STATE_DIR/watchdog-restart.log" 2>&1 &
  else
    echo "[$(date -Iseconds)] tmux session $TMUX_SESSION missing; kickstarting launchd"
    launchctl kickstart -k "gui/$(id -u)/com.claude.whatsapp-agent" 2>&1 || true
  fi
  echo "0" > "$STUCK_STREAK_FILE"
  echo "$now" > "$COOLDOWN_FILE"
  exit 0
fi

# Session is alive but stuck again — bump the streak. Past STUCK_STREAK_LIMIT
# consecutive stuck checks, nudging clearly isn't working (e.g. the WhatsApp
# connection itself died), so hard-restart instead of nudging forever.
streak=0
[ -f "$STUCK_STREAK_FILE" ] && streak=$(cat "$STUCK_STREAK_FILE" 2>/dev/null || echo 0)
streak=$((streak + 1))

if [ "$streak" -ge "$STUCK_STREAK_LIMIT" ]; then
  if hard_restart "$reason; stuck through $streak consecutive checks"; then
    exit 0
  fi
  # restart cooldown was active — fall through and nudge as a fallback
fi

echo "$streak" > "$STUCK_STREAK_FILE"

# Nudge: ESC + catch-up prompt
tmux send-keys -t "$TMUX_SESSION" Escape
sleep 1
tmux send-keys -t "$TMUX_SESSION" "Watchdog: call whatsapp unreplied tool and reply to pending messages, then process any files in ~/.whatsapp-channel/pending/ (execute each prompt, send to chat_id, then rm)." Enter
sleep 1
tmux send-keys -t "$TMUX_SESSION" Enter

echo "$now" > "$COOLDOWN_FILE"
echo "[$(date -Iseconds)] nudged agent (streak $streak/$STUCK_STREAK_LIMIT)"
