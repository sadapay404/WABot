#!/data/data/com.termux/files/usr/bin/bash
#
# Nexus-WA — one-shot Termux install, through to the pairing code.
#
#   bash install.sh                 asks for your number
#   bash install.sh 923067607949    non-interactive
#
# The repo is private, so cloning needs a token. Either export it first:
#
#   export NEXUS_GH_TOKEN=github_pat_xxxx
#
# or the script will ask for it.
#
# Safe to re-run: every step checks before acting, and .env is never
# overwritten without asking.
#
set -uo pipefail

REPO_OWNER="sadapay404"
REPO_NAME="WABot"
REPO_BRANCH="arena/fa15663b-wabot"
APP_DIR="$HOME/nexus-wa"
DATA_DIR="$HOME/.nexus-wa"
LOG="$DATA_DIR/logs/nexus.log"

B=$'\033[1m'; DIM=$'\033[2m'; C=$'\033[36m'; G=$'\033[32m'
Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'

say()  { printf '\n%s▸ %s%s\n' "$C" "$1" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1" >&2; }
die()  { printf '\n%s✗ %s%s\n\n' "$R" "$1" "$N"; exit 1; }

[ -n "${PREFIX:-}" ] || die "Run this inside Termux — \$PREFIX is not set."

# ── 0. the number, up front so we fail early on a typo ────────────────
# Digits only, with a leading + or 00 stripped. A bare local number
# (03xx…) is assumed to be Pakistan, since that is what this was written
# for — and it says so, because a wrong guess here means pairing to the
# wrong number.
normalise() {
  local val
  val=$(printf '%s' "$1" | tr -cd '0-9+')
  case "$val" in
    +*)  val="${val#+}" ;;
    00*) val="${val#00}" ;;
    0*)  val="92${val#0}"; warn "assumed Pakistan (+92) — using $val" ;;
  esac
  printf '%s' "$val"
}

valid() { local v=${#1}; [ "$v" -ge 9 ] && [ "$v" -le 15 ]; }

ask_number() {
  local prompt="$1" val
  while :; do
    # To stderr: this runs inside $(...), so stdout IS the return value.
    printf '  %s: ' "$prompt" >&2
    read -r val || { printf ''; return 0; }   # EOF on a closed stdin
    val=$(normalise "$val")
    if [ -z "$val" ] && [ "${2:-}" = "optional" ]; then printf ''; return 0; fi
    valid "$val" && { printf '%s' "$val"; return 0; }
    warn "that does not look like a phone number ($val) — digits only, with country code"
  done
}

# Same normaliser whether the number arrives as an argument or from the
# keyboard, so the two paths cannot disagree.
NUMBER="${1:-}"
if [ -z "$NUMBER" ]; then
  say "Which WhatsApp number should the bot link to?"
  printf '  %sUse the SPARE number, not your main one.%s\n' "$Y" "$N"
  NUMBER=$(ask_number "number")
else
  NUMBER=$(normalise "$NUMBER")
fi
valid "$NUMBER" || die "no usable phone number."
ok "bot will link as +$NUMBER"

say "Which number is allowed to command it?"
printf '  %sLeave blank to use the same number (you then command it from its own "Message yourself" chat).%s\n' "$DIM" "$N"
OWNER=$(ask_number "your number" optional)
[ -z "$OWNER" ] && OWNER="$NUMBER"
ok "owner +$OWNER"

# ── 1. packages ──────────────────────────────────────────────────────
say "Installing packages"
# upgrade, not just update: a half-upgraded package set is what makes
  # curl die with 'cannot locate symbol SSL_set_quic_*'. Bringing everything
  # forward first avoids installing a new libcurl against an old openssl.
  pkg update -y >/dev/null 2>&1
  pkg upgrade -y >/dev/null 2>&1
for p in nodejs-lts git ffmpeg termux-api; do
  if pkg list-installed 2>/dev/null | grep -q "^$p/"; then ok "$p"
  else printf '  · %s…\n' "$p"; pkg install -y "$p" >/dev/null 2>&1 && ok "$p" || warn "$p failed — continuing"; fi
done

# ── 2. Node, and the built-in SQLite that makes this install easy ────
say "Checking Node"
command -v node >/dev/null || die "node missing. Run 'pkg install nodejs-lts' and re-run."
ok "node $(node -p process.versions.node)"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node >= 22.5 required."
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('create table t(a)');d.prepare('insert into t values(?)').run(1);if(d.prepare('select count(*) c from t').get().c!==1)throw 0" 2>/dev/null \
  && ok "built-in node:sqlite works — no native modules to compile" \
  || { warn "node:sqlite unavailable; installing a compiler for better-sqlite3"
       pkg install -y clang python make >/dev/null 2>&1; }

# ── 3. code (private repo, so this needs a token) ────────────────────
say "Getting the code"
if [ -d "$APP_DIR/.git" ]; then
  ok "already cloned — updating"
  git -C "$APP_DIR" fetch origin "$REPO_BRANCH" >/dev/null 2>&1 \
    && git -C "$APP_DIR" reset --hard "origin/$REPO_BRANCH" >/dev/null 2>&1 \
    || warn "update failed; using what is there"
else
  if [ -z "${NEXUS_GH_TOKEN:-}" ]; then
    printf '  %sThis repo is private, so git needs a token.%s\n' "$DIM" "$N"
    printf '  Create one at github.com → Settings → Developer settings →\n'
    printf '  Fine-grained tokens, scoped to %s, permission Contents: Read-only.\n\n' "$REPO_NAME"
    printf '  token: '
    read -r NEXUS_GH_TOKEN
  fi
  [ -n "${NEXUS_GH_TOKEN:-}" ] || die "no token given; cannot clone a private repo."
  URL="https://x-access-token:${NEXUS_GH_TOKEN}@github.com/${REPO_OWNER}/${REPO_NAME}.git"
  git clone --branch "$REPO_BRANCH" --depth 1 "$URL" "$APP_DIR" 2>&1 | tail -3 \
    || die "clone failed. Is the token valid and scoped to $REPO_NAME?"
  # Do not leave the token sitting in .git/config on a phone that travels.
  git -C "$APP_DIR" remote set-url origin "https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
  ok "cloned (token removed from the git config)"
fi
cd "$APP_DIR" || die "cannot enter $APP_DIR"

# ── 4. dependencies ──────────────────────────────────────────────────
say "Installing dependencies"
npm install --omit=optional --no-audit --fund=false 2>&1 | tail -2

# ── 5. config ────────────────────────────────────────────────────────
say "Writing .env"
mkdir -p "$DATA_DIR/auth" "$DATA_DIR/media" "$DATA_DIR/backups" "$DATA_DIR/logs"
if [ -f .env ] && ! grep -q "^WA_PAIRING_NUMBER=$NUMBER$" .env 2>/dev/null; then
  cp .env ".env.bak.$(date +%s)"
  warn "backed up the existing .env before rewriting it"
fi
cat > .env <<EOF
# Written by install.sh on $(date '+%F %T')
NEXUS_MODE=observe
WA_ROLE=burner
WA_BOT_NAME=Nexus-WA
WA_PAIRING_NUMBER=$NUMBER
OWNER_JIDS=${OWNER}@s.whatsapp.net
LOG_LEVEL=info

DB_PATH=$DATA_DIR/nexus.db
WA_SESSION_DIR=$DATA_DIR/auth
MEDIA_DIR=$DATA_DIR/media
BACKUP_DIR=$DATA_DIR/backups

DASHBOARD_ENABLED=false

# Optional — leave blank to skip
AI_PROVIDER=
AI_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_OWNER_ID=
EOF
ok "bot=+$NUMBER  owner=+$OWNER  mode=observe (read-only)"
printf '  %sobserve means it will not send anything yet. Switch to live later with /mode.%s\n' "$DIM" "$N"

# ── 6. control script + autostart ────────────────────────────────────
say "Installing the 'nexus' command and boot hook"
install -m 755 deploy/termux/nexus "$PREFIX/bin/nexus" && ok "nexus"
mkdir -p "$HOME/.termux/boot"
install -m 755 deploy/termux/boot-start.sh "$HOME/.termux/boot/nexus-wa.sh" && ok "autostart hook"
pkg list-installed 2>/dev/null | grep -q '^termux-boot/' \
  || warn "install the 'Termux:Boot' app from F-Droid and open it once, or rebooting will not restart the bot"

# ── 7. keep Android from killing it ──────────────────────────────────
say "Locking the CPU awake"
command -v termux-wake-lock >/dev/null && { termux-wake-lock; ok "wake lock held"; } \
  || warn "termux-wake-lock unavailable — install termux-api"

# ── 8. start and wait for the pairing code ───────────────────────────
say "Starting"
: >"$LOG"
nexus start >/dev/null 2>&1 || warn "nexus start reported a problem — reading the log anyway"

printf '  waiting for the pairing code'
CODE=""
for i in $(seq 1 45); do
  CODE=$(grep -aoE "pairing code: [0-9A-Z-]+" "$LOG" 2>/dev/null | tail -1 | sed 's/pairing code: //')
  [ -n "$CODE" ] && break
  if grep -aq "pairing code request failed" "$LOG" 2>/dev/null; then
    warn "$(grep -a 'pairing code request failed' "$LOG" | tail -1 | sed 's/.*failed: //')"
    break
  fi
  printf '.'; sleep 2
done
echo

if [ -n "$CODE" ]; then
  printf '\n%s' "$B"
  printf '  ┌──────────────────────────────────────────┐\n'
  printf '  │   PAIRING CODE:  %-23s│\n' "$CODE"
  printf '  └──────────────────────────────────────────┘%s\n\n' "$N"
  printf '  On the phone holding +%s:\n' "$NUMBER"
  printf '    WhatsApp → Linked devices → Link a device\n'
  printf '    → "Link with phone number instead" → enter the code\n\n'

  printf '  waiting for the link'
  for i in $(seq 1 60); do
    grep -aq "ready ·" "$LOG" 2>/dev/null && break
    printf '.'; sleep 3
  done
  echo
  if grep -aq "ready ·" "$LOG"; then
    printf '\n  %s✓ LINKED.%s The bot is running.\n\n' "$G" "$N"
    nexus status
    cat <<EOF

  Next:
    nexus logs        watch what it does
    .commands         message the bot from WhatsApp
    /mode live        on Telegram, once you trust it

  It is in observe mode: it reads and remembers but sends nothing.
EOF
  else
    warn "not linked yet. Check the code was entered, then: nexus logs"
  fi
else
  printf '\n  %sNo pairing code appeared.%s\n\n' "$Y" "$N"
  echo "  Most likely causes:"
  echo "    · the number is already linked — WhatsApp only issues a code once"
  echo "    · no network yet (WiFi not connected)"
  echo "    · WhatsApp rejected the number"
  echo
  echo "  Diagnose with:  nexus logs"
  echo "  Retry with:     nexus restart && nexus pair"
fi

printf '\n%sDo these or Android will kill the bot within an hour:%s\n' "$B" "$N"
cat <<'EOF'
  · Settings → Apps → Termux → Battery → Unrestricted
  · Settings → Apps → Termux → allow Autostart
  · Lock Termux in the recent-apps list
  · Never swipe Termux away

EOF
