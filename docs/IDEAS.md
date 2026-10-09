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

Passive delete/edit/view-once capture is independent of `OWNER_JIDS`: it observes every event delivered to the linked device. Owner access controls commands only; alerts are routed to an explicit capture-alert JID, a remote owner, or the linked account’s own chat.

| Idea | Effort | Risk | Status | Notes |
|---|---|---|---|---|
| **Edited-message diff** | S | none | ✅ | WhatsApp sends `MESSAGE_EDIT` as a protocol message, not a revoke. Shows *was → now*, with the original recovered from the message cache. |
| **View-once recovery** | M | none | 🟡 | Media is fetched as soon as the message arrives, because WhatsApp may invalidate the blob once it is seen. Archived to disk and forwarded to the configured capture-alert destination. |
| **Profile-change watch** | S | none | ✅ | Alerts on photo/name/status/about changes. |
| **"Am I blocked?" probe** | S | low | ✅ | Needs **≥2 independent signals** before it says anything, and always says *"suspected"*. WhatsApp never reports a block; anything claiming otherwise is lying to you. |
| **Last-seen log** | S | low | ✅ | Presence transitions recorded. Opt-in per contact. |
| **Group-join/leave watch** | S | none | ✅ | `WAMessageStubType` carries this. |

## Personal productivity

| Idea | Effort | Risk | Status | Notes |
|---|---|---|---|---|
| **`.note` / `.todo`** | S | none | ✅ | Capture from any chat, list, complete. |
| **`.remind` / `.schedule` guided flow** | M | none | ✅ | Deterministic local date parsing, saved-name/phone recipient resolution, Asia/Karachi timezone, persistent 24-hour drafts, and recipient/time/message preview with explicit confirmation. `.remind` sends to a per-request WhatsApp contact/number, never the self-chat or Telegram. |
| **`.agenda`** | S | none | ✅ | Read-only `.agenda today\|week`; groups pending schedules by local date, shows overdue items first, and lists the next occurrence of each recurring schedule. |
| **`.search`** | M | none | ✅ | FTS5 with `porter unicode61`, falls back to `LIKE` if the SQLite build lacks FTS5 or a MATCH expression is malformed. |
| **`.forward`** | S | low | ✅ | Forwards a cached message, including one that was deleted. |
| **Voice-note transcription** | M | none | 🟡 | Groq `whisper-large-v3-turbo` / OpenAI `whisper-1`. Gemini has no audio-transcription endpoint and says so rather than pretending. |
| **Daily digest** | M | low | ✅ | `.digest` — deletions, edits, view-once, group churn, profile changes, busiest chats, what is due. |
| **Receipt/invoice extractor** | M | none | ⬜ | Vision model over document/image messages → structured CSV. Genuinely saves hours. |

## AI

| Idea | Effort | Risk | Status | Notes |
|---|---|---|---|---|
| **`.ai` with context** | M | none | 🟡 | groq / openai / gemini behind one interface. Per-chat AI memory is capped at `AI_MAX_HISTORY`. |
| **Selected-chat `.ask`** | M | medium | 🟡 | `.ask chats` lists cached one-to-one conversations; explicitly selects one or more, a message count or `all`, and a question. Sends text only to the chosen AI provider, drafts only, and does not persist transcript in AI memory. Group selection is deferred. |
| **`.summarize`** | M | none | 🟡 | Summarise the last N messages of the current chat. |
| **`.vision`** | M | none | 🟡 | Describe/OCR an image. |
| **Draft replies, never auto-send** | S | **medium** | 🟡 | `.draft` returns text marked *"Draft (not sent)"*. It will never message another person. |
| **Language translation** | S | low | 🟡 | `.translate <lang> <text>`. |

**AI conversation memory is deliberately not persisted.** `.ai` history stays in RAM only. `.ask` is different: the bot reads locally cached one-to-one text only after an owner selects chats and sends a question, then sends that bounded transcript to the configured provider for that request. Group selection remains disabled until its flow is agreed.

## Automation

| Idea | Effort | Risk | Status | Notes |
|---|---|---|---|---|
| **Persistent scheduler** | M | none | ✅ | Survives restarts; fixed intervals skip missed runs, while calendar rules re-arm at the next local wall-clock occurrence. |
| **Calendar recurrence rules** | M | none | ✅ | Biweekly weekday, monthly date/weekday, and annual rules; preview next three occurrences and require an explicit policy for missing dates. |
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
| **Remote approved settings** | M | medium | 🟡 | `.env` changes approved AI settings, capture-alert destination, and owner numbers only. API keys use a one-message private flow, are not cached or shown, and the local file is owner-readable only; WhatsApp still retains the sent key message. |
| **Session backup** | M | low | ✅ | `.backup <passphrase>` → AES-256-GCM blob of `data/auth` + the DB. Passphrase is never stored, and a wrong passphrase is deliberately indistinguishable from a corrupt file. |
| **Rate-limit anomaly alert** | S | none | 🟡 | Warns after 30 successful sends across all chats in 60s; alerts once per window and does not halt. Tune with `OUTBOUND_VOLUME_LIMIT` and `OUTBOUND_VOLUME_WINDOW_MS`. |

---

## New ideas (next round)

Practical follow-ons to the capture, remote-control, privacy, and selected-chat
work. These are suggestions only; none is silently enabled.

### Capture reliability and remote control

| Idea | Effort | Risk | Notes |
|---|---|---|---|
| **`.capture status`** | S | none | One compact report: watcher switches, alert destination, last event per type, and whether each alert send succeeded—without exposing message contents. Helps distinguish “WhatsApp did not emit an event” from “the bot failed to deliver it.” |
| **`.capture test`** | S | none | Send a labelled synthetic alert through the real routing/queue path, without creating or deleting a real WhatsApp message. Confirms that the main controller can receive bot alerts. |
| **`.capture recent [n]`** | M | low | Show a redacted event ledger with time, event type, chat label, and media availability. Useful for checking whether an event arrived without storing extra message text. |
| **Per-event alert destinations** | S | low | Route deletes, edits, and view-once alerts to different approved JIDs, while keeping one safe default. |
| **Remote graceful restart** | M | medium | Owner-only `.restart`/`.stop` with explicit confirmation and a supervisor check; never execute arbitrary shell text from WhatsApp. |
| **`.env test <provider>`** | M | low | Make a minimal provider request and report only pass/fail, latency, and provider name—never the key or prompt contents. |
| **Safe configuration rollback** | M | low | `.env undo` reverts the last non-secret setting and reports a redacted diff. Secret values are never kept in rollback history. |

### Private chat and AI controls

| Idea | Effort | Risk | Notes |
|---|---|---|---|
| **`.ask preview`** | S | low | Before calling the provider, show selected chat labels, message counts, time range, and context size; require a one-time `YES` for that exact request. |
| **Source-backed `.ask` answers** | M | medium | Ask the model to attach timestamps and short verbatim quotes to factual claims, then verify every quote against the selected local transcript. Easier to check than an unsupported summary. |
| **`.ask after <date>`** | M | low | Select a date/time range as well as a count, so a question can focus on “last Tuesday” without sending unrelated newer history. |
| **Temporary `.ask` follow-up session** | M | medium | Keep the same explicitly selected chats for a short expiry window; show a timer and `.ask end`, and never add a new chat automatically. |
| **`.forget chat <n>`** | M | low | Delete the local one-to-one transcript cache for a chosen chat, separate from `.forget` which clears AI prompt memory. |
| **Per-chat transcript retention** | M | low | Set a local text-cache expiry or exclusion for each direct chat, with a preview of what will be deleted; do not change media archives implicitly. |

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
