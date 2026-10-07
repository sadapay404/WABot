#!/data/data/com.termux/files/usr/bin/bash
#
# Run by Termux:Boot after the phone restarts.
#
# Two things this has to get right, both because of how this particular phone
# is used: it lives on WiFi only, and that WiFi comes and goes.
#
#   1. Wait for the network before starting. At boot the radio is not up yet,
#      and a bot that connects instantly just fails and retries.
#   2. Do NOT wait indefinitely. If the phone is powered on somewhere with no
#      WiFi, the bot should still start — it retries on its own, forever, with
#      a capped backoff, so it will come up the moment a network appears.
#
# Requires the "Termux:Boot" app from F-Droid. Install it and open it once
# after installing, or it never gets permission to run these.

LOG="$HOME/.nexus-wa/logs/boot.log"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "boot script ran at $(date '+%F %T')"

# Keep the CPU awake for the whole session, before anything else.
command -v termux-wake-lock >/dev/null && termux-wake-lock

# Give the WiFi radio up to ~2 minutes, checking every 5 seconds.
for i in $(seq 1 24); do
  if ping -c 1 -W 3 8.8.8.8 >/dev/null 2>&1; then
    echo "network up after ~$((i * 5))s"
    break
  fi
  [ "$i" -eq 24 ] && echo "no network after ~2m — starting anyway, it will retry"
  sleep 5
done

# 'nexus' is on PATH inside Termux, but a boot context can have a minimal
# environment, so call the control script by its installed path as a fallback.
if command -v nexus >/dev/null 2>&1; then
  nexus start
else
  "$PREFIX/bin/nexus" start 2>/dev/null || bash "$HOME/nexus-wa/deploy/termux/nexus" start
fi
