# Hosting Nexus-WA

## The honest answer first

**There is no free, no-credit-card, always-on cloud host left that can run this
bot.** As of late 2026:

| Host | Free tier | Card? | Why it fails for a WhatsApp bot |
|---|---|---|---|
| **Render** | 750 h/mo, 512 MB | No | Sleeps after 15 min idle. A sleeping bot is a disconnected bot. Free tier has **no persistent disk**, so `data/auth` is wiped on every restart and you re-pair. |
| **Koyeb** | 1 service, 512 MB | **Yes** — $29 hold since Feb 2026 | Card-free Hobby plan was removed. |
| **Railway** | $5 trial, then $1/mo | Yes (since Aug 2023) | Not free past the trial. |
| **Fly.io** | 2 VM-hours trial | Yes after | No free tier since Oct 2024. |
| **Oracle Cloud** | Always Free ARM | Yes | Needs a card; ARM allowance halved June 2026. |
| **Heroku / Glitch** | — | — | Free tiers gone. |

Two things make this hard, and they are not negotiable:

1. **The bot is a linked WhatsApp device.** It holds a persistent outbound
   socket. Anything that sleeps, scales to zero, or cold-starts will drop the
   session, and WhatsApp notices repeated link/unlink churn.
2. **`data/auth` must survive restarts.** Those files *are* your login. On an
   ephemeral filesystem you re-pair every deploy — and re-pairing constantly is
   exactly the pattern that gets an account flagged.

So: **run it on a machine you already own.** That is genuinely $0, needs no
card, is truly 24/7, and has a real disk. An old laptop, a Raspberry Pi 4/5, a
mini PC, or a spare Android phone via Termux all work. Node 22.5+ is the only
hard requirement.

If you would rather pay a little: a **$3–5/month VPS** (Hetzner, Contabo,
OVH) is what actually works in the cloud, and this repo ships ready for it.

---

## Option A — Docker (recommended)

```bash
git clone https://github.com/sadapay404/WABot.git
cd WABot
cp .env.example .env
$EDITOR .env                 # set the four values below
docker compose up -d --build
docker compose logs -f       # the pairing code appears here
```

**The four values you must set in `.env`:**

```bash
OWNER_JIDS=923xxxxxxxxx@s.whatsapp.net   # YOUR number, digits only + @s.whatsapp.net
WA_PAIRING_NUMBER=923xxxxxxxxx           # your SPARE number (E.164 without the +)
NEXUS_MODE=observe                       # start here, not live
DASHBOARD_TOKEN=<openssl rand -hex 24>
```

`WA_PAIRING_NUMBER` is what produces the **8-character pairing code** instead of
a QR — much easier over SSH. Leave it empty to get a QR in the logs instead.

The number is normalised for you: `+92 300 123-4567`, `92 300 1234567` and
`923001234567` all resolve to the same thing. If it is empty the bot warns and
falls back to QR rather than failing.

Then, on the phone with the spare number:
**WhatsApp → Settings → Linked devices → Link a device → "Link with phone
number instead"** → enter the 8 characters.

Everything persistent lives in the `nexus-data` Docker volume at `/data`:
session credentials, the database, archived media, encrypted backups. Delete
that volume and you re-pair from scratch.

```bash
docker compose logs -f          # watch it
docker compose restart          # restart
docker compose down             # stop (data survives)
docker compose down -v          # stop AND delete everything — you will re-pair
```

## Option B — bare metal (Raspberry Pi / old laptop / VPS)

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin nexus
sudo mkdir -p /opt/nexus-wa /var/lib/nexus-wa
sudo cp -r . /opt/nexus-wa
sudo chown -R nexus:nexus /opt/nexus-wa /var/lib/nexus-wa

cd /opt/nexus-wa
cp .env.example .env && sudo nano .env      # same four values as above
npm ci --omit=optional --omit=dev

sudo cp deploy/nexus-wa.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nexus-wa
journalctl -u nexus-wa -f                   # pairing code appears here
```

The unit runs as an unprivileged user, restarts on crash, and mounts only
`/var/lib/nexus-wa` as writable.

**ffmpeg** powers `.sticker` and the media probe. Optional — the bot degrades
gracefully without it — but install it if you want stickers:
`sudo apt install ffmpeg`.

---

## Reaching the dashboard

The dashboard can drive your WhatsApp account. `docker-compose.yml` binds it to
`127.0.0.1` **on purpose** — publishing it on `0.0.0.0` puts it in front of
every scanner on the internet, protected only by a token.

**Cloudflare Tunnel** — free, no card, no open inbound port:

```bash
cloudflared tunnel --url http://127.0.0.1:3000
# prints a https://<random>.trycloudflare.com URL
```

**Tailscale** — free for personal use, puts the dashboard on a private network
reachable only from your own devices. Install Tailscale on the host and your
phone, then open `http://<tailscale-ip>:3000`.

Either way, set `DASHBOARD_TOKEN`. In `observe`/`live` mode the server refuses
to serve the dashboard without one. `/healthz` stays open for liveness probes.

---

## Modes — do this in order

| Mode | WhatsApp | Outbound | Use it for |
|---|---|---|---|
| `dry-run` | not connected | n/a | Evaluating the UI. No account touched. |
| `observe` | connected | **blocked for non-owners** | Validating on your **spare** number |
| `live` | connected | full | Production, once you trust it |

Start in `observe`. Send yourself messages, watch the dashboard, let it run for
a few days. Only then consider `live`.

`/mode` on the Telegram panel refuses to switch to `live` while `OWNER_JIDS` is
empty, which is the mistake that would let strangers drive your account.

---

## Moving from the spare number to your main number

Full details in [`PREVIEW.md`](PREVIEW.md). The short version:

```bash
docker compose down                       # stop cleanly — never kill -9
docker run --rm -v nexus-data:/data -v "$PWD":/out alpine \
  cp /data/nexus.db /out/nexus.db.bak     # back up the database
rm -rf <volume>/auth                      # forget the SPARE number
```

Then in `.env`: set `WA_PAIRING_NUMBER` to your **main** number, set
`OWNER_JIDS` to your main number, set `WA_ROLE=primary`. Restart and pair again.

Plugins, config, scheduled jobs, notes and the audit log all carry over.
Contacts re-sync from WhatsApp. The WhatsApp credentials and the message cache
do not — those are per-number by design.

**Never delete the database when switching numbers.** Only `auth/`.

---

## Before you connect your main number

- [ ] Ran on the spare for at least a few days without incident
- [ ] `OWNER_JIDS` contains **only** your numbers
- [ ] `DASHBOARD_TOKEN` is set and not the example value
- [ ] You have run `.backup <passphrase>` at least once and restored from it
- [ ] The host has a real persistent disk (not an ephemeral PaaS filesystem)
- [ ] Keyword triggers are still **off** unless you deliberately turned them on

## Troubleshooting

**The bot restarted and asked me to pair again.** Your `data/` volume is not
actually persistent. Check `docker volume ls` and confirm `nexus-data` exists,
and that you did not use `down -v`.

**`cannot open SQLite database … is not writable`.** The data directory is
owned by the wrong user. `sudo chown -R nexus:nexus /var/lib/nexus-wa`.

**Pairing code does not appear.** `WA_PAIRING_NUMBER` is normalised
automatically, so formatting is rarely the problem — check the logs for a
WhatsApp connection error instead. If the number is empty you will get a QR.

**Dashboard shows "token protected" and rejects you.** Pass it as
`?token=…` in the URL or the `x-dashboard-token` header.

**`.sticker` says ffmpeg is missing.** `sudo apt install ffmpeg`, then restart.
Everything else keeps working without it.
