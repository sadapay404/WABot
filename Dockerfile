# Nexus-WA
#
# bookworm-slim rather than alpine: alpine's musl libc means any native module
# has to be compiled from source instead of using a prebuilt binary. The bot
# needs no native modules at all (SQLite comes from Node's built-in
# node:sqlite), so the extra ~40 MB of glibc buys a build that cannot fail on
# a toolchain problem.
FROM node:22-bookworm-slim

# ffmpeg powers .sticker and the media probe. The bot degrades gracefully
# without it, but there is no reason to ship without it here.
# curl is for the HEALTHCHECK. ca-certificates for the TLS to WhatsApp.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so the layer is cached until package.json changes.
# --omit=optional skips better-sqlite3 (a fallback we do not need) and avoids
# pulling in node-gyp and a C toolchain.
COPY package.json package-lock.json ./
RUN npm ci --omit=optional --omit=dev --no-audit --fund=false \
    && npm cache clean --force

COPY src ./src

# Everything persistent lives under /data: the WhatsApp session credentials,
# the SQLite database, archived media and encrypted backups. Mount a volume
# here or you will re-pair on every restart.
ENV NODE_ENV=production \
    DB_PATH=/data/nexus.db \
    WA_SESSION_DIR=/data/auth \
    MEDIA_DIR=/data/media \
    BACKUP_DIR=/data/backups \
    DASHBOARD_HOST=0.0.0.0 \
    DASHBOARD_PORT=3000
RUN mkdir -p /data/auth /data/media /data/backups

# Run as an unprivileged user. The session directory holds private-key
# material; there is no reason for the process to be root to read it.
RUN useradd --create-home --shell /usr/sbin/nologin nexus \
    && chown -R nexus:nexus /app /data
USER nexus

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

# --serve keeps the process alive with no controlling terminal. Without it the
# preview console exits on EOF, which is exactly what a container looks like.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js", "--serve"]
