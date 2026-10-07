#!/data/data/com.termux/files/usr/bin/bash
#
# Apply the Android exemptions that stop the OS killing Termux.
#
#   bash harden.sh          apply everything it can
#   bash harden.sh --check  report what is and is not in place, change nothing
#
# These settings need shell privilege. This script looks for, in order:
#
#   1. rish  — Shizuku's elevated shell. Install Shizuku from F-Droid, start
#              it, and get rish per Shizuku's own instructions.
#   2. su    — a rooted device.
#   3. nothing — in which case it prints the adb commands to run from a PC.
#
# Safe to re-run, and worth re-running after a reboot: some ROMs reset appops
# on restart, and Shizuku does not survive a reboot at all unless the device
# is rooted.
#
set -uo pipefail

PKGS="com.termux com.termux.boot com.termux.api"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

B=$'\033[1m'; C=$'\033[36m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
say()  { printf '\n%s▸ %s%s\n' "$C" "$1" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$R" "$N" "$1"; }
note() { printf '  %s·%s %s\n' "$D" "$N" "$1"; }

# ── find a way to run privileged commands ────────────────────────────
PRIV=""
for cand in rish "$HOME/rish" ./rish; do
  if command -v "$cand" >/dev/null 2>&1 || [ -x "$cand" ]; then PRIV="$cand"; break; fi
done
[ -z "$PRIV" ] && command -v su >/dev/null 2>&1 && PRIV="su -c"

priv() {
  case "$PRIV" in
    "su -c") su -c "$1" 2>&1 ;;
    "")      printf 'NO_PRIV' ;;
    *)       "$PRIV" -c "$1" 2>&1 || sh "$PRIV" -c "$1" 2>&1 ;;
  esac
}

if [ -z "$PRIV" ]; then
  printf '\n%sNo privileged shell found.%s\n\n' "$Y" "$N"
  cat <<'EOF'
  These settings need shell privilege. Easiest route without a PC:

    1. Install Shizuku from F-Droid
    2. Open it and start it via "Wireless debugging"
    3. Get rish (Shizuku's shell) into your PATH per Shizuku's docs
    4. Re-run:  bash harden.sh

  Or from a computer with adb, run the commands printed at the end.

EOF
fi

# ── the settings ─────────────────────────────────────────────────────
# Android 12+ counts Termux's child processes as "phantom processes" and
# kills them past a limit. This is the single most common reason a Termux
# bot dies for no visible reason, and it is separate from doze/battery.
PHANTOM=(
  "/system/bin/device_config set_sync_disabled_for_tests persistent"
  "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
  "settings put global settings_enable_monitor_phantom_procs false"
)

say "Phantom process limit (Android 12+)"
for c in "${PHANTOM[@]}"; do
  if [ "$CHECK_ONLY" = 1 ]; then note "$c"; continue; fi
  out=$(priv "$c")
  [ "$out" = "NO_PRIV" ] && { warn "skipped (no privileged shell): $c"; continue; }
  # On some Android 12 builds this cannot be changed at all and the command
  # still exits 0. Read it back.
  cur=$(priv "/system/bin/device_config get activity_manager max_phantom_processes" 2>/dev/null)
  if printf '%s' "$cur" | grep -q "2147483647"; then ok "phantom process limit lifted"
  else warn "phantom limit still enforced by your ROM — this one is not always changeable"; fi
  break   # one read-back covers all three settings
done

# ── per-app exemptions ───────────────────────────────────────────────
say "Doze whitelist and appops"
APPOPS=(
  RUN_IN_BACKGROUND
  RUN_ANY_IN_BACKGROUND
  SYSTEM_EXEMPT_FROM_ACTIVITY_BG_START_RESTRICTION
  SYSTEM_EXEMPT_FROM_HIBERNATION
  SYSTEM_EXEMPT_FROM_POWER_RESTRICTIONS
  SYSTEM_EXEMPT_FROM_SUSPENSION
  WAKE_LOCK
)
# Setting an appop and having it stick are different things. Some ROMs accept
# the command and ignore it, and `cmd appops set` exits 0 either way — so a
# green tick next to "0/7 applied" is worse than no output at all. Read every
# setting back before claiming it.
for pkg in $PKGS; do
  if [ "$CHECK_ONLY" = 1 ]; then note "$pkg: deviceidle whitelist + ${#APPOPS[@]} appops"; continue; fi
  out=$(priv "cmd deviceidle whitelist +$pkg")
  [ "$out" = "NO_PRIV" ] && { warn "skipped (no privileged shell): $pkg"; continue; }
  # dumpsys is the fallback on ROMs where `cmd deviceidle` is not exposed.
  printf '%s' "$out" | grep -qi "error\|unknown" && priv "dumpsys deviceidle whitelist +$pkg" >/dev/null

  # Confirm the whitelist took, rather than assuming the command worked.
  if priv "cmd deviceidle whitelist" 2>/dev/null | grep -q "$pkg"; then wl="whitelisted"
  else wl="NOT whitelisted"; fi

  n=0; failed=""
  for op in "${APPOPS[@]}"; do
    priv "cmd appops set $pkg $op allow" >/dev/null
    # Verify. A ROM that silently refused will read back something else.
    if priv "cmd appops get $pkg $op" 2>/dev/null | grep -qi "allow"; then
      n=$((n+1))
    else
      failed="$failed $op"
    fi
  done

  # Pin the standby bucket to active so the app is not deprioritised.
  priv "am set-standby-bucket $pkg active" >/dev/null
  priv "am set-inactive $pkg false" >/dev/null

  if [ "$n" -eq "${#APPOPS[@]}" ] && [ "$wl" = "whitelisted" ]; then
    ok "$pkg — $wl, $n/${#APPOPS[@]} appops confirmed"
  elif [ "$n" -eq 0 ]; then
    bad "$pkg — nothing applied ($wl). Your ROM rejected these; use the OEM settings below."
  else
    warn "$pkg — $wl, $n/${#APPOPS[@]} appops confirmed; refused:$failed"
  fi
done

# ── what still has to be done by hand ────────────────────────────────
say "Still needs doing by hand"
cat <<EOF
  No command can do these — they are OEM settings:

  · Settings → Apps → Termux → Battery → ${B}Unrestricted${N}
  · Settings → Apps → Termux → allow ${B}Autostart${N}
    ${D}(Xiaomi/Huawei/Oppo/Vivo hide this under Battery or "App launch")${N}
  · Lock Termux in the ${B}recent-apps${N} list (pull down / tap the lock icon)
  · Install ${B}Termux:Boot${N} from F-Droid and open it once
  · In the Termux notification, tap ${B}Acquire wakelock${N} — or run
    termux-wake-lock, which the bot does for you

EOF

# ── adb equivalent, for a PC ─────────────────────────────────────────
if [ -z "$PRIV" ] || [ "${1:-}" = "--adb" ]; then
  say "Or run these from a computer with adb"
  for c in "${PHANTOM[@]}"; do printf '  adb shell "%s"\n' "$c"; done
  for pkg in $PKGS; do
    printf '  adb shell cmd deviceidle whitelist +%s\n' "$pkg"
    for op in "${APPOPS[@]}"; do printf '  adb shell cmd appops set %s %s allow\n' "$pkg" "$op"; done
  done
  echo
fi

say "Honest limits"
cat <<'EOF'
  · Memory pressure still kills processes. Nothing prevents that.
  · Shizuku does NOT survive a reboot unless the device is rooted, and
    some ROMs reset appops on restart. Re-run this after a reboot:
        bash ~/nexus-wa/deploy/termux/harden.sh
  · On some Android 12 builds the phantom-process setting cannot be
    changed at all. If the bot keeps dying, check `nexus logs` for a
    gap with no output — that is the OS killing it, not a crash.
  · A watchdog running INSIDE Termux is useless: when Android kills
    Termux, the watchdog dies with it. If you want a watchdog it has to
    be a separate app (MacroDroid, Tasker) that restarts Termux.

EOF
