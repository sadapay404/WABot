# Nexus-WA — feature backlog

Prioritised candidates. Effort is roughly how much real work it is
(S/M/L), and **risk** is the ban-risk or privacy cost — that column matters
more than the effort one.

**Status key:** ✅ shipped · 🟡 shipped, needs live verification · ⬜ not built

> 🟡 means the code path is implemented and unit-tested against the mock
> transport, but the specific thing it depends on — a real WhatsApp handshake,
> a real `ffmpeg` binary, a real AI provider, a real webhook endpoint — cannot
> be exercised in this sandbox. Treat these as "written, not proven in
> production", and expect to fix something the first time you run them.

---

## Privacy & awareness — the anti-delete family

The hard part (capturing content on the way in) was already done.

| Idea | Effort | Risk | Status | Notes |
|---|---|---|---|---|
| **Edited-message diff** | S | none | ✅ | WhatsApp sends `MESSAGE_EDIT` as a protocol message, not a revoke. Shows *was → now*, with the original recovered from the message cache. |
| **View-once recovery** | M | none | 🟡 | Media is fetched the instant the message arrives, because WhatsApp invalidates the blob once it is seen. Archived to disk and forwarded to your own chat. |
| **Profile-change watch** | S | none | ✅ | Alerts on photo/name/status/about changes. |
| **"Am I blocked?" probe** | S | low | ✅ | Needs **≥2 independent signals** before it says anything, and always says *"suspected"*. WhatsApp never reports a block; anything claiming otherwise is lying to you. |
| **Last-seen log** | S | low | ✅ | Presence transitions recorded. Opt-in per contact. |
| **Group-join/leave watch** | S | none | ✅ | `WAMessageStubType` carries this. |

## Personal productivity

| Idea | Effort | Risk | Status | Notes |
|---|---|---|---|---|
| **`.note` / `.todo`** | S | none | ✅ | Capture from any chat, list, complete. |
| **`.remind`** | M | none | ✅ | Relative (`in 20 minutes`), clock (`at 8pm`), weekday (`friday 5pm`), recurring (`every day 9am`). Two shapes: `.remind call mom at 8pm` and `.remind in 20 minutes \| call mom`. |
| **`.search`** | M | none | ✅ | FTS5 with `porter unicode61`, falls back to `LIKE` if the SQLite build lacks FTS5 or a MATCH expression is malformed. |
| **`.forward`** | S | low | ✅ | Forwards a cached message, including one that was deleted. |
| **Voice-note transcription** | M | none | 🟡 | Groq `whisper-large-v3-turbo` / OpenAI `whisper-1`. Gemini has no audio-transcription endpoint and says so rather than pretending. |
| **Daily digest** | M | low | ✅ | `.digest` — deletions, edits, view-once, group churn, profile changes, busiest chats, what is due. |
| **Receipt/invoice extractor** | M | none | ⬜ | Vision model over document/image messages → structured CSV. Genuinely saves hours. |

## AI

| Idea | Effort | Risk | Status | Notes |
|---|---|---|---|---|
| **`.ai` with context** | M | none | 🟡 | groq / openai / gemini behind one interface. Per-chat memory capped at `AI_MAX_HISTORY`. |
| **`.summarize`** | M | none | 🟡 | Summarise the last N messages of a group you've been away from. |
| **`.vision`** | M | none | 🟡 | Describe/OCR an image. |
| **Draft replies, never auto-send** | S | **medium** | 🟡 | `.draft` returns text marked *"Draft (not sent)"*. It will never message another person. |
| **Language translation** | S | low | 🟡 | `.translate <lang> <text>`. |

**Memory is deliberately not persisted.** Conversation history lives in RAM
only. Writing every prompt to SQLite means keeping a permanent transcript of
everything you ever asked, with no retention policy — that is a privacy
decision you should make explicitly, not one a bot should make for you.

## Automation

| Idea | Effort | Risk | Status | Notes |
|---|---|---|---|---|
| **Persistent scheduler** | M | none | ✅ | Survives restarts. Recurring jobs re-arm from `run_at + interval`, not from "now", so a delayed tick does not slide the schedule later. |
| **Recurring templates** | S | low | ✅ | `every day 9am`, `every friday 5pm`, `every 30m`. |
| **Keyword triggers** | M | **medium** | ✅ **off by default** | Per-chat 90s cooldown. Enabling it logs a warning and writes an audit entry — see the note below. |
| **Webhooks out** | M | low | ✅ | Owner-added URLs only. Optional HMAC-SHA256 in `x-nexus-signature`. Payload is metadata + text, never media bytes. Consecutive failures are counted per hook. |

**Why triggers ship disabled.** An auto-reply is the single most bot-shaped
thing a userbot can do — it is what Meta's heuristics look for, and it is what
makes your friends notice something is off. It is also the easiest thing to
leave running by accident and have it answer your landlord at 3am. If you turn
it on, keep it to one narrow chat.

## Media

| Idea | Effort | Risk | Status | Notes |
|---|---|---|---|---|
| **`.sticker`** | S | low | 🟡 | Needs `ffmpeg`. Prints an install hint if it is missing instead of crashing. |
| **`.transcribe`** | M | none | 🟡 | Voice note → text. |
| **Media auto-archive** | M | low | ✅ | View-once and deleted media are written to `data/media/`. Storage cost is the real constraint. |
| **`.download`** | M | low | ⬜ | Media → cloud storage link, since WhatsApp blobs expire. |

## Safety & admin

| Idea | Effort | Risk | Status | Notes |
|---|---|---|---|---|
| **Health check endpoint** | S | none | ✅ | `/healthz`, unauthenticated, for the PaaS liveness probe. |
| **Panic kill-switch** | S | none | ✅ | `.panic` drops the outbound queue and refuses new sends. `.panic resume` releases it. An unrecognised argument does **not** engage it. |
| **Outbound loop breaker** | S | none | 🟡 | Blocks the 5th normalized-exact or ≥80%-token-overlap text/caption send (3+ tokens) to one destination within 60s; halts the queue and alerts the self-chat. Tune with `OUTBOUND_LOOP_THRESHOLD` and `OUTBOUND_LOOP_WINDOW_MS`; inspect the cause before `.panic resume`. |
| **Audit log** | S | none | ✅ | `.audit [n]` — who did what, newest first. |
| **Session backup** | M | low | ✅ | `.backup <passphrase>` → AES-256-GCM blob of `data/auth` + the DB. Passphrase is never stored, and a wrong passphrase is deliberately indistinguishable from a corrupt file. |
| **Rate-limit anomaly alert** | S | none | ⬜ | Warn when outbound volume spikes — a loop is how accounts die. |

---

## New ideas (next round)

Things worth doing that were not in the original list.

### Worth building soon

| Idea | Effort | Risk | Notes |
|---|---|---|---|
| **Digest scheduling built in** | S | none | `.digest daily 8am` registers the recurring job directly, instead of making you compose `.schedule every day 8am \| /digest`. |
| **Retention policy** | S | none | `RETENTION_DAYS` — prune `message_cache`, `media_archive` and `view_once` older than N days. Right now the database only grows. |
| **Restore-from-backup command** | S | none | `.backup restore <id> <passphrase>` over Telegram. Currently restore is code-complete but only reachable from a shell. |
| **Webhook retry with backoff** | S | low | Three attempts, 30s/2m/10m, then stop. A hook that is down for a minute should not lose the event. |
| **Per-contact opt-in for watchers** | S | **medium** | Presence logging and profile watching are surveillance-adjacent. Make them explicit per contact rather than global. |

### Larger, higher value

| Idea | Effort | Risk | Notes |
|---|---|---|---|
| **`.ask` over your own history (RAG)** | L | none | Embed the message cache, then answer *"what did the landlord say about the deposit?"*. The highest-value AI feature here, and the one that justifies keeping the cache. Needs an embedding store and a real retrieval eval — do not ship it on cosine similarity alone. |
| **Trip/mode awareness** | M | low | Suppress reminders while you are driving or asleep; queue them instead. Presence + time-of-day is enough signal. |
| **Invoice/receipt pipeline** | M | none | Vision → structured rows → monthly CSV. Pairs with `.vision`. |
| **Shared family group bot** | M | **medium** | Let a second trusted JID run a subset of commands. Multiplies the blast radius of a mistake; only do it once the audit log has proven itself. |
| **Signal/Telegram mirror** | L | low | One inbox. Large surface area, and now two services can get you banned. |

### Still explicitly not building

- **Mass messaging / broadcast lists / bulk joins.** Fastest route to a
  permanent ban, and the reason most "WhatsApp userbot" repos are abandoned.
- **Auto-replying to real people by default.** Drafts-for-approval only.
- **Spam, "bug" messages, or anything else from the userbot repos this
  project borrows its architecture from.** The architecture is the useful
  part; the payloads are not.
- **Anything that hides itself from the account owner.** No covert logging,
  no silent forwarding to a third party. Every watcher is listed on the
  dashboard and can be switched off.
