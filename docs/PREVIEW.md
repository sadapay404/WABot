# Previewing Nexus-WA without risking your WhatsApp account

## The hard truth first

Baileys is a **reverse-engineered WhatsApp Web client**. It speaks WhatsApp's
private WebSocket protocol; it is not an official API. That means:

> **There is no sandbox. There is no test number issued by Meta. There is no
> dry-run endpoint.** The moment a real socket authenticates, Meta sees a real
> linked device on a real account.

So "preview the bot before connecting my personal WhatsApp" cannot mean "test
against a fake WhatsApp server" — no such thing exists. What it *can* mean is a
**ladder of increasingly real environments**, where each rung proves a
different class of thing and only the last rung touches your personal number.

That ladder is what this project is built around.

---

## The four rungs

| Rung | Mode | WhatsApp connected? | Ban risk | Proves |
|---|---|---|---|---|
| **0** | `dry-run` | ❌ never | **zero** | plugin logic, parsing, authorisation, scheduler |
| **1** | `observe` | ✅ burner number | low (burner absorbs it) | real handshake, real inbound messages |
| **2** | `observe` → `live` on burner | ✅ burner number | low | outbound, reconnect, 24/7 stability |
| **3** | `live` | ✅ **your number** | managed | nothing new — this is just rung 2 promoted |

The key idea: **rung 3 must contain no code that rung 2 did not already run.**
If that holds, promoting your personal number is a config change, not a gamble.

---

## Rung 0 — dry-run (what you have right now)

```bash
npm run preview
```

This boots the *real* application — real config, real logger, real plugin
loader, real command dispatcher, real authorisation gates — behind a fake
WhatsApp transport (`src/core/mockSocket.js`).

**No network socket to WhatsApp is ever opened.** There is no auth handshake,
no pairing code, no QR. Nothing reaches Meta. You literally cannot be banned by
a process that never connects.

```
┌──────────────────────────────────────────────────────────────┐
│  Nexus-WA  ·  mode: dry-run  ·  ban risk: NONE (no WhatsApp connection)
└──────────────────────────────────────────────────────────────┘

you› .ping
← Owner: .ping
→ you: 🏓 *Pong* — 1ms
     • mode: `DRY-RUN`
     • you: `owner`

you› /as 15550002222@s.whatsapp.net .ping
← Stranger: .ping
→ 15550002222: 🏓 *Pong* — 0ms
     • you: `guest`          ← correctly NOT the owner

you› /group .ping
← Stranger: .ping
   (no reply — .ping's 1s cooldown swallowed it)

you› /stats
{ "handled": 2, "rejected": 1, "errors": 0 }
```

### Harness commands

| Command | What it simulates |
|---|---|
| `.ping` | a message **from you** (the owner) |
| `/as <jid> <msg>` | a message from **someone else** — use this to attack your own authorisation gates |
| `/group <msg>` | a message from a stranger **inside a group** |
| `/list` | loaded plugins + any that failed to load |
| `/out` | JSON dump of everything the bot "sent" |
| `/stats` | handled / rejected / error counters |
| `/quit` | exit |

You can also script it, which is how CI previews it:

```bash
printf '.ping\n/stats\n/quit\n' | npm run preview
```

### Why dry-run is trustworthy (and not a toy)

Both transports feed the **same** normaliser. `core/message.js` is the single
place that turns a raw Baileys message into `{ text, sender, isGroup, quoted,
media }`, and the mock socket emits messages in genuine Baileys shape:

```js
{ key: { remoteJid, fromMe, id, participant }, pushName, messageTimestamp,
  message: { conversation: '.ping' } }
```

So when `.ai` parses correctly in dry-run, the parsing code that ran is the
identical code that will run in production. Only the network layer differs.

### What dry-run does **not** prove

Be clear-eyed about this. Dry-run cannot tell you anything about:

- the Baileys handshake, pairing codes, QR, or credential storage
- real media: downloading voice notes, uploading stickers, codec handling
- WhatsApp's odder message types (buttons, templates, reactions, ephemeral
  messages, edited messages) beyond what the normaliser handles
- **Meta's rate-limiting and ban heuristics** — the thing you actually care about
- multi-device sync, history sync, or being logged out by another device
- reconnect behaviour on a flaky network

Everything above is proven on rungs 1–2, with a burner.

---

## Rung 1 — `observe` mode on a burner number

```bash
# .env
NEXUS_MODE=observe
WA_PAIRING_NUMBER=15551234567     # the BURNER, digits only
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_OWNER_ID=987654321
```

In observe mode the bot **really connects** to WhatsApp, but outbound is
hard-blocked at the dispatcher (`core/dispatcher.js`, gate 3):

- inbound messages are read and logged to your Telegram panel
- commands from anyone who is not you are swallowed silently
- nothing is ever sent to a stranger

That gives you a real linked device, real message flow, real session
persistence — with almost no outbound traffic for Meta to pattern-match.

### Getting a burner number

Options, cheapest first:

1. **A spare SIM / old number** you already own — best option if you have one.
2. **A cheap prepaid SIM** in a second handset or an old Android you have lying
   around. WhatsApp needs to receive one SMS.
3. **Google Voice** (US) — works, but numbers from VoIP ranges are more likely
   to be flagged.
4. **An eSIM** from a low-cost provider (Airalo, Holafly, etc.).

Avoid "temporary SMS" websites. Those numbers are already abused, frequently
pre-banned, and you will lose the session the moment someone else rents the
same number.

**Never** link your personal number to test. If a ban happens during
experimentation, you want it to land on the burner.

---

## Rung 2 — `live` on the burner

Once observe mode has been stable for a day or two:

```bash
NEXUS_MODE=live
OWNER_JIDS=15551234567@s.whatsapp.net   # the burner is its own owner here
```

Now exercise the risky paths deliberately:

- send 50 scheduled messages in a burst and watch the queue throttle
- leave it running 48h and confirm it survives reconnects
- kill the container mid-conversation and confirm it resumes
- test group behaviour in a group that contains only you

Anything that misbehaves here would have misbehaved on your personal number.

---

## Rung 3 — your personal number

Only now. The change is two lines:

```bash
NEXUS_MODE=live
WA_PAIRING_NUMBER=<your number>
OWNER_JIDS=<your JID>@s.whatsapp.net
```

Delete `data/auth/` first so a fresh session is created, and scan the new QR.

### Residual risk you should accept knowingly

Even used perfectly, an unofficial client carries risk that no amount of
engineering removes:

- WhatsApp's Terms of Service prohibit unofficial clients. Enforcement is
  inconsistent, but it is a real policy and real accounts do get banned.
- Sudden outbound volume, joining many groups quickly, or messaging people who
  do not have your number saved are the strongest known triggers.
- A ban can be temporary (24–72h) or permanent. **Back up your chats first**
  and make sure you can re-register your number if you lose the session.

The mitigations this project bakes in — a serial outbound queue, per-minute rate
limits, simulated typing indicators, silent rejection of strangers, and an
owner-only whitelist — reduce the *probability*. They do not reduce it to zero,
and no bot can honestly claim otherwise.

---

## Migrating from your burner to your real number

Your plan — test on a spare number, promote to the main one — is the correct
approach, and the code is built so that promotion is a config change rather
than a migration.

### What carries over automatically

| Data | Carries over? | Why |
|---|---|---|
| Plugins, commands, config | ✅ yes | not tied to any account |
| Scheduled jobs (Phase 4) | ✅ yes | keyed by recipient JID, not by session |
| Session history | ✅ yes | the burner stays in the registry, marked `retired` |
| Anti-delete history | ✅ yes | kept for audit |
| Contacts cache | ⚠️ partial | names re-sync from *your* address book on the new link |
| WhatsApp session credentials | ❌ no | `data/auth/` is per-number and must be re-created |
| Message cache | ❌ effectively no | the old stanza ids are meaningless on a new link |

### Procedure

```bash
# 1. Stop the bot cleanly so nothing is mid-send.
#    (Telegram panel: /kill, or SIGTERM)

# 2. Back up the database — this is your audit trail.
cp data/nexus.db data/nexus.db.backup-$(date +%F)

# 3. Retire the burner in the record rather than deleting it.
#    The dashboard keeps showing it, which is the point: you can see exactly
#    which number did what, and when.

# 4. Wipe ONLY the WhatsApp credentials. Never the database.
rm -rf data/auth

# 5. Point at your real number.
#    .env:
#      WA_PAIRING_NUMBER=<your number>
#      OWNER_JIDS=<your number>@s.whatsapp.net
#      WA_ROLE=primary
#      NEXUS_MODE=observe      ← one more pass in observe mode
```

Start in `observe`, not `live`. Send the bot a message and confirm the Telegram
panel shows your real JID and country. Then:

```bash
NEXUS_MODE=live
```

### Why not skip straight to `live`?

Because the one thing dry-run and the burner cannot prove is how *your* number
reacts to being linked to an unofficial client. One observe-mode pass on the
real number costs you nothing and catches a bad pairing before the bot has said
a word to anyone.

### Back up first

Before linking your personal number:

1. WhatsApp → Settings → Chats → **Chat backup** → Back Up.
2. Write down that you can re-register the number from the SIM if the session
   is lost.
3. Accept that a restriction is possible regardless of how careful the code is.

---

## Verifying before you trust it

```bash
npm test
```

The suite drives the real modules and the real entry point, including the
authorisation gates and the "fails closed with an empty owner list" case:

```
# tests 31
# pass 31
# fail 0
```

If you add a plugin, add a case to `test/smoke.test.js`. The harness makes that
cheap, and it is the only reason "it worked in dry-run" is worth saying.
