# Hosting Nexus-WA

> **Use a phone with Termux.** See [`docs/TERMUX.md`](TERMUX.md).
>
> It is the only option here that is genuinely free, needs no credit card, and
> has a real filesystem — which means no re-pairing and no vault. Everything
> below is the reasoning that got us there, plus the cloud options if your
> situation changes.

## The honest answer first

**There is no free, no-credit-card, always-on cloud host left that can run this
bot.** As of late 2026:

| Host | Free tier | Card? | Why it fails for a WhatsApp bot |
|---|---|---|---|
| **Render** | 750 h/mo, 512 MB | **Sometimes — with no way around it** | See the note below. Also: sleeps after 15 min idle, so a sleeping bot is a disconnected bot, and the free tier has **no persistent disk**, so `data/auth` is wiped on every restart and you re-pair. |
| **Koyeb** | 1 service, 512 MB | **Yes** — $29 hold since Feb 2026 | Card-free Hobby plan was removed. |
| **Railway** | $5 trial, then $1/mo | Yes (since Aug 2023) | Not free past the trial. |
| **Fly.io** | 2 VM-hours trial | Yes after | No free tier since Oct 2024. |
| **Oracle Cloud** | Always Free ARM | Yes | Needs a card; ARM allowance halved June 2026. |
| **Heroku / Glitch** | — | — | Free tiers gone. |

Two things make this hard, and they are not negotiable:

### Render specifically: the "no credit card" claim is half true

Every guide says Render's free tier needs no card. That is the happy path.
Render reserves the right to demand one as an **anti-abuse verification**, and
when it does there is no alternative. From Render's own staff on their community
forum:

> "Sometimes we may request card details for verification purposes for
> anti-abuse/fraud measures. Entering your card details will trigger a $1
> verification payment which is immediately reversed."

and, to someone who asked whether there was another way:

> "Use of a credit card is required to be able to use our services, we don't
> have an alternative method."

Two practical notes if you are reading this *because* you hit that screen:

- It is a **$1 authorisation hold that is reversed**, not a charge. If you have
  any card at all — debit included — it is safe to use.
- It can also be triggered by selecting a **paid instance type**. Make sure the
  plan says **Free** before concluding you have hit the verification path.

If you have no card, Render is not available and no amount of configuration
changes that.

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

### ⚠️ Do not use the free "bot hosting" sites

Searching for free bot hosting turns up dozens of sites offering 24/7 Node.js
hosting for $0 and no card. **Do not put this bot on one of them.**

They all get full filesystem access to `data/auth`. Those files *are* your
WhatsApp login — anyone with them can impersonate your account from anywhere,
and you will not see it happen. This repo treats that directory as private-key
material for exactly this reason. An unknown free host is not a hosting
provider, it is a third party holding your account.

### If you have no machine of your own: Render free + the remote vault

This is the least-bad free path, and it needs a caveat you should read before
trying it.

Render's free tier gives 750 instance-hours a month — just enough for one
always-on service (a 31-day month is 744 hours). It cannot attach a persistent
disk, so the **remote vault** bridges that: it pushes an AES-256-GCM encrypted
snapshot of your session and database to a private GitHub repo on an interval,
and restores it on boot when `data/auth` is empty. The remote only ever sees
ciphertext.

```bash
# 1. Create a PRIVATE GitHub repo, e.g. nexus-vault
# 2. Create a fine-grained PAT: Contents → Read and write, scoped to that repo only
# 3. In .env:
REMOTE_VAULT_KIND=github
REMOTE_VAULT_URL=https://github.com/YOU/nexus-vault
REMOTE_VAULT_TOKEN=github_pat_...
REMOTE_VAULT_PASSPHRASE=<something long you will not lose>
REMOTE_VAULT_INTERVAL_MIN=30
```

Then deploy the Dockerfile to Render as a free web service, and add a free
uptime pinger (cron-job.org, UptimeRobot) hitting the URL every 10 minutes.

### Render specifics that will bite you

These are the details that break setups quietly:

- **Ping `/healthz`, never `/robots.txt`.** While a free service is asleep,
  Render intercepts `/robots.txt` and answers it *itself* — the request never
  reaches your app and never wakes it. `/healthz` does.
- **Only inbound HTTP or a new WebSocket wakes it.** Internal cron jobs and
  background timers do *not* count as activity, so the pinger has to be
  external.
- **750 instance-hours is exactly one always-on service.** A 31-day month is
  744 hours. A second free service kept awake pushes you over, and when the
  pool is exhausted Render suspends *every* free web service in the workspace
  until the 1st. Do not add a second service.
- **Render restarts free services at will**, even one kept permanently awake.
  So the vault is not a fallback, it is the normal path. Budget for restarts
  you did not schedule.
- **512 MB RAM / 0.1 CPU.** An earlier smoke test used ~73 MB RSS with 33
  commands. The current dry-run registry has 37 commands across 15 plugin
  files; re-measure on the target host, and do not enable heavy media archiving
  without checking its actual memory and disk budget.
- Free Postgres expires after 30 days. We do not use it — everything is
  SQLite inside the vault.

### What this means for re-pairing

Better than you would expect, but not never. On restart the vault restores
`data/auth` before Baileys connects, so normally the existing linked device
just resumes — **no re-pairing**. But the container's IP has changed, and
WhatsApp occasionally asks you to re-confirm a device that reappears from a
new network. When it does, you re-pair with the 8-character code. It is
minutes, not a rebuild, and your notes, reminders, message cache and audit log
all survive because the database is in the same blob.

**Read this before you do it:**

- **Use your spare number only. Never your main number.** Every restart is a
  login from a new datacentre IP. Occasional is normal; constant is the
  pattern that gets an account flagged.
- You can lose up to `REMOTE_VAULT_INTERVAL_MIN` of state on a restart —
  messages cached since the last push, reminders already delivered.
- Render's free tier is explicitly "not for production" and can change at any
  time; the free Postgres already expiring after 30 days is the precedent.
- If the passphrase is ever lost, the backup is unrecoverable and you re-pair.
  There is no reset.

This is a good way to **test** on a spare number. I would not run a main
number on it.

---

## Can GitHub or Telegram host it?

Both come up a lot, and neither can.

**GitHub cannot host a persistent process.** Actions caps a job at 6 hours and
gives ~2000 minutes/month on private repos; chaining workflows to stay alive
24/7 is a ToS violation that gets accounts suspended. Pages is static only.
Codespaces sleeps after 30 idle minutes and is a dev environment, not a host.
**GitHub *is* the right place for the vault** — a private repo holding your
encrypted backup — which is exactly what `REMOTE_VAULT_KIND=github` uses.

**Telegram is not a host.** It is a messaging API. The Telegram panel in this
repo lets you *command* the bot from Telegram (`/status`, `/qr`, `/mode`,
`/kill`), but something still has to run the bot process. Telegram is the
remote control, not the machine.

### The full free landscape

| Platform | Can host it? | Why |
|---|---|---|
| **Render free** | ✅ yes | 750 h/mo covers 24/7; no card. Needs a pinger + the vault. |
| GitHub (Actions/Pages/Codespaces) | ❌ | No persistent process; Actions 24/7 is a ToS violation |
| Telegram | ❌ | Messaging API, not compute |
| Cloudflare Workers | ❌ | Serverless; no filesystem, CPU-capped, no long-lived outbound socket |
| Vercel / Netlify | ❌ | Serverless functions with a 10s timeout; no WebSockets |
| Hugging Face Spaces | ❌ | Docker Spaces became a paid feature in 2026 |
| Deta | ❌ | Free, but no WebSocket support |
| Bonto | ❌ | 75 runtime hours/month against the 744 you need |
| Koyeb | ❌ | Needs a card ($29 hold) since Feb 2026 |
| Railway / Fly.io | ❌ | Not free past a short trial |
| Oracle Cloud | ❌ | Needs a card |
| Free "bot hosting" sites | ⚠️ **don't** | They hold your `data/auth` = your account |

**Render free + a private GitHub repo as the vault is the answer.** That is
what this repo is now set up for.

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

### All three at once

Cloudflare Tunnel, Tailscale and plain LAN are not mutually exclusive — run all
three and use whichever suits where you are. They listen on the same
`127.0.0.1:3000` (or the LAN interface) and cost nothing.

```bash
# 1. LAN — already works, no setup. Find the host's address:
ip -4 addr show | grep inet        # Linux
# then open http://192.168.x.x:3000 from your phone on the same Wi-Fi.
# For this you DO need to publish the port; set DASHBOARD_BIND=0.0.0.0 in the
# compose env, and understand that anyone on your Wi-Fi can reach it.

# 2. Tailscale — private network, works at home and away, nothing inbound open
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 3000     # or just use the 100.x.y.z address
# Open http://<tailscale-ip>:3000 from any device signed into your tailnet.

# 3. Cloudflare Tunnel — a public HTTPS URL, no open inbound port
cloudflared tunnel --url http://127.0.0.1:3000
# prints https://<random>.trycloudflare.com — share it with nobody
```

**Tailscale is the better default** if you only want access from your own
devices: it never exposes anything to the internet, and the URL cannot be
guessed or scanned. Use the Cloudflare quick tunnel when you need a throwaway
public link, and note that a quick tunnel URL changes every time it restarts —
a named tunnel (`cloudflared tunnel create`) gives you a stable one.

Whichever you use, set `DASHBOARD_TOKEN`. In `observe`/`live` mode the server
refuses to serve the dashboard without one. `/healthz` stays open for liveness
probes.

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
