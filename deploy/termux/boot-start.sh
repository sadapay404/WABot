#!/data/data/com.termux/files/usr/bin/bash
#
# Run by Termux:Boot after the phone restarts (or powers on after an outage).
#
#   1. Wait for the network. At boot the WiFi radio is not up yet.
#   2. Do NOT wait forever. If there is no WiFi, start anyway: the bot retries
#      on its own with a capped backoff and connects when a network appears.
#   3. Use `nexus ensure`, not `nexus start`: a bot the owner stopped with
#      `nexus stop` stays stopped across reboots until `nexus start`.
#
# Requires the Termux:Boot app (F-Droid). Install it and open it once, and set
# its battery usage to Unrestricted, or Android will not run this script.

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
LOG="$HOME/.nexus-wa/logs/boot.log"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "boot script ran at $(date '+%F %T')"

# Keep the CPU awake for the whole session, before anything else.
command -v termux-wake-lock >/dev/null && termux-wake-lock

# True if the internet is reachable. Uses whichever tool this Termux has.
online() {
  if command -v ping >/dev/null 2>&1; then
    ping -c 1 -W 3 8.8.8.8 >/dev/null 2>&1 && return 0
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 5 -o /dev/null https://api.github.com && return 0
  fi
  return 1
}

# Give the WiFi radio up to about two minutes, checking every 5 seconds.
for i in $(seq 1 24); do
  if online; then
    echo "network up after ~$((i * 5))s"
    break
  fi
  [ "$i" -eq 24 ] && echo "no network after ~2m — starting anyway, it will retry"
  sleep 5
done

# 'nexus' is on PATH inside Termux, but a boot context can have a minimal
# environment, so fall back to the installed path, then to the repo copy.
if command -v nexus >/dev/null 2>&1; then
  nexus ensure
elif [ -x "$PREFIX/bin/nexus" ]; then
  "$PREFIX/bin/nexus" ensure
else
  bash "$HOME/nexus-wa/deploy/termux/nexus" ensure
fi
