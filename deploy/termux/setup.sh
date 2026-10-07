#!/data/data/com.termux/files/usr/bin/bash
#
# Nexus-WA — Termux one-shot setup.
#
# Run this ONCE on the phone that will host the bot:
#
#     bash <(curl -fsSL <raw-url>)          # or, after cloning:
#     bash deploy/termux/setup.sh
#
# It is safe to re-run: every step checks before it acts.
#
set -uo pipefail

REPO_URL="${NEXUS_REPO:-https://github.com/sadapay404/WABot.git}"
REPO_BRANCH="${NEXUS_BRANCH:-arena/fa15663b-wabot}"
APP_DIR="$HOME/nexus-wa"

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$1"; exit 1; }

[ -n "${PREFIX:-}" ] || die "This must run inside Termux. \$PREFIX is not set."

# ── 1. packages ──────────────────────────────────────────────────────
say "Installing packages"
pkg update -y >/dev/null 2>&1
# nodejs-lts, not nodejs: the project needs >= 22.5 for the built-in
# node:sqlite driver, which is what lets us skip compiling
# better-sqlite3 (a native module that routinely fails to build here).
for p in nodejs-lts git ffmpeg termux-api; do
  if pkg list-installed 2>/dev/null | grep -q "^$p/"; then
    ok "$p already installed"
  else
    printf '  · installing %s…\n' "$p"
    pkg install -y "$p" >/dev/null 2>&1 && ok "$p installed" || warn "$p failed — continuing"
  fi
done

# ── 2. Node version gate ─────────────────────────────────────────────
say "Checking Node"
command -v node >/dev/null || die "node not found after install. Run 'pkg install nodejs-lts' and retry."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
ok "node $(node -p process.versions.node)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  die "Node $NODE_MAJOR is too old; this needs >= 22.5.0 for the built-in SQLite driver."
fi

# The built-in driver is the whole reason this install is easy, so prove it
# works here rather than discovering later that the database is empty.
if node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('create table t(a)');d.prepare('insert into t values(?)').run(1);if(d.prepare('select count(*) c from t').get().c!==1)throw new Error('bad read')" 2>/dev/null; then
  ok "built-in node:sqlite works — no native modules needed"
else
  warn "node:sqlite unavailable; the bot will try better-sqlite3, which needs compiling."
  warn "Fix with: pkg install -y clang python make && npm i better-sqlite3"
fi

# ── 3. code ──────────────────────────────────────────────────────────
say "Getting the code"
if [ -d "$APP_DIR/.git" ]; then
  ok "repo already at $APP_DIR — pulling latest"
  git -C "$APP_DIR" fetch origin "$REPO_BRANCH" >/dev/null 2>&1
  git -C "$APP_DIR" checkout "$REPO_BRANCH" >/dev/null 2>&1
  git -C "$APP_DIR" reset --hard "origin/$REPO_BRANCH" >/dev/null 2>&1 || warn "pull failed; using what is there"
else
  [ -d "$APP_DIR" ] && die "$APP_DIR exists but is not a git repo. Move it aside and re-run."
  git clone --branch "$REPO_BRANCH" --depth 1 "$REPO_URL" "$APP_DIR" >/dev/null 2>&1 \
    || die "clone failed. Check the network and that $REPO_URL is reachable."
  ok "cloned to $APP_DIR"
fi

cd "$APP_DIR" || die "cannot cd to $APP_DIR"

# --omit=optional skips better-sqlite3. Deliberate: we use node:sqlite.
say "Installing dependencies (no native compilation)"
npm install --omit=optional --no-audit --fund=false 2>&1 | tail -2

# ── 4. data dir ──────────────────────────────────────────────────────
say "Preparing storage"
mkdir -p "$HOME/.nexus-wa/auth" "$HOME/.nexus-wa/media" "$HOME/.nexus-wa/backups" "$HOME/.nexus-wa/logs"
ok "~/.nexus-wa/ (db, auth, media, backups, logs)"

# ── 5. config ────────────────────────────────────────────────────────
say "Configuration"
if [ ! -f .env ]; then
  cp .env.example .env
  warn "created .env from the template — EDIT IT: nano ~/nexus-wa/.env"
  warn "at minimum set WA_PAIRING_NUMBER and OWNER_JIDS"
else
  ok ".env already exists — left untouched"
fi

# ── 6. control script ────────────────────────────────────────────────
say "Installing the 'nexus' command"
cp deploy/termux/nexus "$PREFIX/bin/nexus" 2>/dev/null \
  || cp "$APP_DIR/deploy/termux/nexus" "$PREFIX/bin/nexus"
chmod +x "$PREFIX/bin/nexus"
ok "run 'nexus start' / 'nexus status' / 'nexus logs' from anywhere"

# ── 7. autostart after a reboot ──────────────────────────────────────
say "Autostart on boot"
mkdir -p "$HOME/.termux/boot"
cp deploy/termux/boot-start.sh "$HOME/.termux/boot/nexus-wa.sh" 2>/dev/null || true
chmod +x "$HOME/.termux/boot/nexus-wa.sh"
if pkg list-installed 2>/dev/null | grep -q '^termux-boot/'; then
  ok "Termux:Boot script installed"
else
  warn "install the 'Termux:Boot' app from F-Droid, then open it once, for this to work"
fi

cat <<'BANNER'

────────────────────────────────────────────────────────────
  Setup finished. Three things left, in order:

  1. EDIT THE CONFIG
       nano ~/nexus-wa/.env
     Set WA_PAIRING_NUMBER (spare number) and OWNER_JIDS.

  2. KEEP THE PHONE AWAKE — run these, they matter:
       termux-wake-lock
     Then in Android settings:
       · Settings → Apps → Termux → Battery → Unrestricted
       · Settings → Apps → Termux → allow "Autostart"
       · Lock Termux in the recent-apps list (swipe-down/pin)
     Without these Android will kill the bot within an hour.

  3. START IT
       nexus start
       nexus logs          # watch for the pairing code

  Then link the device: WhatsApp → Linked devices → Link a
  device → "Link with phone number instead" → enter the code.
────────────────────────────────────────────────────────────

BANNER
