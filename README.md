# Nexus-WA

A modular, 24/7 personal WhatsApp assistant with a private Telegram control
panel and a web dashboard. Built on
[Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web
multi-device) and designed so that **every feature is one file you drop into
`src/plugins/`**.

> ⚠️ Baileys is an unofficial client. Using it may violate WhatsApp's Terms of
> Service and carries a real risk of account restriction. Read
> [`docs/PREVIEW.md`](docs/PREVIEW.md) before connecting any account you care
> about.

---

## Quickstart

```bash
npm install
cp .env.example .env      # leave NEXUS_MODE=dry-run for now

npm run preview           # interactive console, ZERO WhatsApp connection
npm run dashboard         # headless + web dashboard on :3000
npm test                  # 178 tests
```

In the preview console try:

```
.contacts                                  add demo address-book names
/delete 15550002222@s.whatsapp.net hey     send a message, then delete it
.status
```

The `/delete` demo runs the real anti-delete pipeline and produces:

```
🗑️ Deleted message

👤 Mom · +15550002222
   push name: Mom ❤️
ℹ️ 01:17

> hey can you send me the wifi password
```

delivered to the chat you have with yourself — the only chat on WhatsApp that
nobody else can read.

---

## What it does today

**Anti-delete.** WhatsApp tells you a message was revoked but never what it
said. Nexus-WA caches inbound messages, joins the revoke against that cache,
and pushes the recovered content — plus the actual photo, video or voice note
where it can still be fetched — to your own chat. It resolves the sender's
**name from your address book**, their phone number and country, and it works
for group-admin deletions too.

**Session registry & dashboard.** Every number this install has ever been
linked to is recorded with its country, role (burner/primary), status,
message counts, connect count and first/last seen. The web dashboard renders
all of it plus deletions, plugins, contacts, queue depth and a live log tail.

**Safety shield.** A serial outbound queue with per-chat rate limits, a
repeated-text loop breaker that halts and alerts the owner, a global volume
warning, and simulated typing; an owner-only whitelist that fails closed,
silent rejection of strangers, per-command cooldowns, and an `observe` mode
that reads real traffic while blocking all outbound to non-owners.

**Remote control.** A single-tenant Telegram panel: `/status`, `/sessions`,
`/logs`, `/deletes`, `/plugins`, `/qr`, `/mode`, `/antidelete`, `/kill`.

### Hosting

**Run it on a phone with Termux** — see [`docs/TERMUX.md`](docs/TERMUX.md).
Free, no credit card, and it has a real filesystem, so you pair once and never
again. `deploy/termux/setup.sh` does the install; `nexus start` runs it.

[`docs/DEPLOY.md`](docs/DEPLOY.md) covers Docker and bare metal, and explains
why no free cloud tier can actually run this bot 24/7 — including why Render
will ask you for a card even though every guide says it will not.

### Commands

37 commands across 15 plugin files. `.help` prints the live list; everything
below is generated from it. **owner** means it is refused unless the sender is
in `OWNER_JIDS`.

**Basics**

| Command | Access | What |
|---|---|---|
| `.ping` | anyone | round-trip latency |
| `.help [category]` | anyone | command list, owner-only entries hidden from guests |
| `.status` | owner | mode, uptime, sessions, queue, watcher stats |
| `.sessions` | owner | every number ever linked, with country and traffic |

**Watching** — passive, all toggleable via `.watch`

| Command | Access | What |
|---|---|---|
| `.antidelete [on\|off\|media on\|off\|list]` | owner | deletion alerts |
| `.edits [n]` | owner | messages edited after sending, with the diff |
| `.viewonce [n] \| on\|off` | owner | view-once events; media only when WhatsApp delivers it to this linked-device profile |
| `.presence [n]` | owner | who was online and when |
| `.groups [n]` | owner | group joins and leaves |
| `.blocked [jid]` | owner | *suspected* blocks, with the signals behind each guess |
| `.watch [name on\|off]` | owner | show or toggle every watcher |

Passive delete/edit/view-once capture processes events from every chat the
linked WhatsApp device receives; `OWNER_JIDS` gates commands, not captured
senders. Alerts go to `CAPTURE_ALERT_JID` when set, otherwise to a remote owner
or the linked account’s own chat. Keep the main controller whitelisted; add the
linked number with `.env owner add <number>` to enable fresh owner commands in
its “You” chat.

**Notes, reminders, search**

| Command | Access | What |
|---|---|---|
| `.note <text> \| list \| del <id>` | owner | notes to yourself |
| `.todo <text> [in 10m \| at 8pm \| tomorrow 9am]` | owner | tasks, optionally with a reminder |
| `.remind to <contact/number> <when> \| <text>` | owner | send a one-off or recurring reminder to that WhatsApp recipient |
| `.schedule to <contact/number> <when> \| <message>` | owner | send to a recipient later, once or on a repeat; preview + confirmation |
| `.agenda [today\|week]` | owner | read-only local-time view of pending sends |
| `.jobs \| .jobs cancel <id>` | owner | list or cancel scheduled jobs |
| `.search <terms>` | owner | full-text search over the message cache |
| `.forward <stanzaId>` | owner | re-send a cached message, even a deleted one |
| `.digest [hours]` | owner | what happened while you were away |

**AI** — needs `GROQ_API_KEY`, `GEMINI_API_KEY` or `OPENAI_API_KEY`

| Command | Access | What |
|---|---|---|
| `.ai <prompt>` | anyone | ask the model, with per-chat memory |
| `.ask chats` / `.ask <n> <count|all> <question>` | owner | ask about selected cached one-to-one chats; explicit transcript is sent to the configured AI provider |
| `.summarize [n]` | owner | summarise recent messages in this chat |
| `.vision [instruction]` | owner | describe or OCR an attached image |
| `.translate <lang> [text]` | anyone | translate the last message, or your own text |
| `.draft [tone]` | owner | draft a reply **for your approval** — never auto-sends |
| `.forget` | owner | clear this chat's AI memory |

**Media**

| Command | Access | What |
|---|---|---|
| `.sticker` | anyone | attached image → WebP sticker (needs `ffmpeg`) |
| `.transcribe` | owner | attached voice note → text |
| `.archive [n]` | owner | what the bot has archived to disk |

**Admin**

| Command | Access | What |
|---|---|---|
| `.panic \| .panic resume` | owner | stop all outbound instantly, then release it |
| `.env status \| set \| unset \| owner` | owner | manage approved AI settings and controller numbers; API secrets stay hidden |
| `.audit [n]` | owner | what the bot has done on your behalf |
| `.backup <passphrase> \| .backup list` | owner | encrypted export of session + database |
| `.vault \| .vault test \| .vault push` | owner | check the remote backup, or prove it works end to end |
| `.trigger list \| on \| add <pat> => <reply>` | owner | keyword auto-replies — **off by default** |
| `.webhook list \| add <url> [events]` | owner | POST events to a URL you control |

---

## Layout

```
├── src/
│   ├── config/index.js       env → one validated config object
│   ├── core/
│   │   ├── logger.js         zero-dep, pino-compatible, with sinks
│   │   ├── message.js        ⭐ the ONLY place raw Baileys messages are parsed
│   │   ├── dispatcher.js     ⭐ every authorisation and safety gate
│   │   ├── pluginLoader.js   scans src/plugins/, quarantines broken files
│   │   ├── mockSocket.js     ⭐ fake transport — makes dry-run possible
│   │   ├── jid.js            JID + phone + country resolution
│   │   ├── outboundQueue.js  ⭐ rate limits, loop and volume protection
│   │   ├── messageCache.js   two-tier cache that makes anti-delete possible
│   │   ├── antiDelete.js     ⭐ revoke detection, recovery, notification
│   │   ├── contactStore.js   your saved names vs. their push names
│   │   ├── sessionRegistry.js every number ever linked
│   │   ├── logBuffer.js      ring buffer for /logs
│   │   ├── whatsapp.js       Baileys connection + reconnect policy
│   │   ├── telegram.js       Telegram control panel
│   │   └── scheduler.js      SQLite-backed reminders and recurring jobs
│   ├── database/index.js     node:sqlite, better-sqlite3 fallback
│   ├── lib/{format,demoSeed}.js
│   ├── web/{dashboard.js,index.html}
│   ├── plugins/              drop a file here to add a feature
│   └── index.js              boot + preview console
├── test/                     node:test suites + fixtures
├── data/                     gitignored: session credentials + SQLite
└── docs/
```

---

## Why this architecture

**1. The socket sits behind an interface.** `core/message.js` normalises every
inbound message and `core/mockSocket.js` implements the real socket's surface.
Both feed the identical normaliser and dispatcher, so a command that works in
dry-run exercised the same code it will in production. Even the outbound queue
wraps both transports, so preview pacing matches production.

**2. All risk logic is in one file.** `core/dispatcher.js` holds every gate.
There is no path to a plugin that bypasses it, so a safety review is a
200-line read rather than a whole-repo audit.

**3. Rate limiting is structural, not conventional.** `OutboundQueue` replaces
`socket.sendMessage` on the socket itself, so no future plugin can forget to
throttle — the capability simply isn't there.

**4. Plugins fail alone.** Each file is imported independently; anything that
throws is recorded in `failures` and skipped rather than crashing the process.

**5. Config fails closed.** An unknown `NEXUS_MODE` degrades to `dry-run`.
`live` refuses to start without an owner whitelist *and* a Telegram panel. An
empty `OWNER_JIDS` means nobody is the owner. The dashboard refuses to start in
a connected mode without a token.

---

## Run modes

| Mode | WhatsApp | Outbound | Dashboard auth | Use |
|---|---|---|---|---|
| `dry-run` | not connected | n/a | none needed | develop and review |
| `observe` | connected | blocked for non-owners | token required | validate on a **burner** |
| `live` | connected | full | token required | production |

---

## Dependency decisions

**Baileys `7.0.0-rc14`**, not the `legacy` `6.7.24` stable line. `6.7.24`
depends on `libsignal` via a **git URL**, which needs outbound GitHub access at
build time — it failed outright in this workspace with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, and it is a classic cause of PaaS build
failures. rc14 resolves `libsignal: ^6.0.0` from the registry and installs in
~3s. `DisconnectReason` and the rest of the connection API were verified
present before pinning.

**`node:sqlite` over `better-sqlite3`.** Node's built-in SQLite (≥22.5) means
zero native dependencies — no node-gyp, no compiler, no prebuild download.
`better-sqlite3` failed its first build attempt here. It remains an
`optionalDependency` and `database/index.js` falls back to it automatically;
everything above that file is driver-agnostic.

**No web framework.** The dashboard is `node:http` plus one HTML file, so there
is nothing to keep patched on a bot meant to run unattended for weeks.

---

## Roadmap

- [x] **Step 1** — scaffold, config, plugin loader, dispatcher, dry-run harness
- [x] **Step 2** — Baileys connection, pairing/QR to Telegram, session
      persistence, session registry, contact store, anti-delete, web dashboard,
      Telegram panel, outbound queue
- [ ] **Phase 3** — AI orchestrator, voice-note transcription, vision
- [x] **Phase 4** — SQLite-backed persistent scheduler + reminder engine
- [ ] **Phase 5** — Dockerfile, health checks, cloud deploy, reconnect hardening

See [`docs/IDEAS.md`](docs/IDEAS.md) for the candidate feature backlog.

---

## Test coverage notes

`npm test` exercises the real modules and entry point with the mock transport.
Writing the tests surfaced several defects that reading the code had not:

- `normalizeJid()` stripped the **domain** from device JIDs
  (`12025550188:12@s.whatsapp.net` → `12025550188`), which would have broken
  self-detection and contact matching.
- `classifyDisconnect()` classified a disconnect with **no status code** as a
  logout — wiping stored credentials on a transient network drop.
- The `messages.update` handler was fire-and-forget, so deletion alerts were
  silently dropped when the process was busy or shutting down.
- `resolvePhone()` fed group JIDs to the phone parser and invented countries
  for chats that have no number.
- The mock transport collapsed injected strangers back to the owner, making the
  authorisation gate untestable in preview.
