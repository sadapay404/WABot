#!/data/data/com.termux/files/usr/bin/bash
#
# Run every 15 minutes by Android's job scheduler (Termux:API), and by MacroDroid
# through the RUN_COMMAND intent as a second, independent trigger.
#
# It does one thing: `nexus ensure`. If the bot should be running and is not,
# it is started. If the bot was stopped on purpose (`nexus stop`), nothing happens.
#
# Scheduled by `nexus start` / `nexus watchdog on`. Check it with `nexus doctor`.

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
DATA_DIR="$HOME/.nexus-wa"
mkdir -p "$DATA_DIR/logs"

NEXUS="$PREFIX/bin/nexus"
[ -x "$NEXUS" ] || NEXUS="$HOME/nexus-wa/deploy/termux/nexus"

date '+%F %T' >"$DATA_DIR/watchdog.last"
bash "$NEXUS" ensure >>"$DATA_DIR/logs/watchdog.log" 2>&1
