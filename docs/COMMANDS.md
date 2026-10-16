# Command reference

A sorted, practical reference for the 55 WhatsApp commands currently loaded by
Nexus-WA. Examples assume the default `.` prefix (`NEXUS_PREFIX` can change it).
Replace names, numbers, IDs, and messages with your own. **Commands that schedule
or send messages can cause real WhatsApp sends in live mode; test with a safe
contact first.**

**Access:** “Owner” commands require the sender to be in `OWNER_JIDS`. “Anyone”
commands can also be used by non-owners. `.ask`, `.env`, `.receive`, `.restart`,
and `.update` only work in a private owner-control chat or the linked account’s
“You” chat. To discover a
category in WhatsApp, use `.help` followed by `admin`, `ai`, `automation`, `media`,
`privacy`, `productivity`, or `tools`.

## Sorted command index

| Command | Aliases | Access | Purpose |
|---|---|---|---|
| `.agenda` | — | Owner | View pending sends or decide missed jobs |
| `.ai` | `.gpt` | Anyone in live mode | Ask AI, analyse one replied-to text/image, or use linked-main `.ai <n>` context; controller can manage the AI blocklist |
| `.ai -check-` | — | Owner | Test each AI provider and explain any that does not work |
| `.aiprovider` | `.aiorder` | Owner | Show or set AI provider priority (1 = tried first, the rest are fallbacks) |
| `.antidelete` | `.ad`, `.deleted`, `.deletes` | Owner | Toggle deletion capture/alerts and review history |
| `.archive` | `.media` | Owner | List locally archived media |
| `.ask` | — | Owner | Ask about explicitly selected direct-chat history |
| `.audit` | `.log` | Owner | Review bot actions |
| `.backup` | `.export` | Owner | Create an encrypted local backup or list backups |
| `.calc` | `.calculate` | Anyone | Solve safe arithmetic locally; use AI for algebra/word equations or `--process` |
| `.clean` | `.stripmeta` | Anyone | Return a JPEG/PNG/WebP copy with common metadata removed |
| `.docxray` | `.docmeta`, `.pdfxray` | Anyone | Inspect PDF/Office document metadata, links, and macro markers |
| `.file` | `.filexray` | Anyone | Compare a file's shown name/type with its binary signature |
| `.fingerprint` | `.hash` | Anyone | Hash media and compare local exact/visual fingerprints |
| `.md` | `.metadata`, `.xray` | Anyone | Reveal embedded image/audio/video/document metadata; `.md full` attaches readable fields |
| `.qr` | `.decodeqr` | Anyone | Decode a QR code in a replied image or sticker |
| `.save` | `.asfile`, `.download` | Anyone | Re-send replied media as a downloadable Files document |
| `.timeline` | `.when` | Anyone | Show readable capture, creation, and modification timestamps |
| `.videoxray` | `.vmeta` | Anyone | Inspect video container, tracks, codec, and tags |
| `.audioxray` | `.ameta` | Anyone | Inspect voice/audio codec, tags, and technical details |
| `.where` | `.gps`, `.geotag` | Anyone | Make a map link from GPS embedded in a replied image |
| `.blocked` | `.blockcheck` | Owner | Review suspected blocks (never certain) |
| `.digest` | `.summary`, `.briefing` | Owner | Summarize recent activity |
| `.draft` | `.reply` | Owner | Draft a reply; never sends it |
| `.edits` | `.edited` | Owner | Review edited messages |
| `.env` | — | Owner | Change approved AI settings/owners privately |
| `.forget` | `.reset` | Owner | Clear this chat’s in-memory AI history |
| `.imagine` | `.image`, `.img`, `.draw` | Anyone in live mode | Generate a fresh image from an explicit text prompt |
| `.forward` | `.fwd` | Owner | Show a cached message in the current chat |
| `.groups` | `.grouplog` | Owner | Review recent group membership changes |
| `.health` | `.info`, `.runtime` | Owner | Runtime health: mode, uptime, sessions, queue, anti-delete |
| `.help` | `.h`, `.commands`, `.menu` | Anyone | Show available commands |
| `.jobs` | `.schedules` | Owner | List, edit, or cancel schedules |
| `.note` | `.n` | Owner | Save/list/delete notes |
| `.panic` | `.stop`, `.halt` | Owner | Halt or resume all outbound messages |
| `.ping` | `.p`, `.latency` | Anyone | Check response latency/runtime |
| `.presence` | `.lastseen`, `.online` | Owner | Review recorded presence |
| `.receive` | `.recieve` | Owner | Privately inspect cached inbound messages |
| `.remind` | `.reminder` | Owner | Schedule a recipient-specific reminder |
| `.restart` | `.reboot` | Owner | Restart the Termux bot, or show the safe Kerit panel restart path |
| `.schedule` | `.sched` | Owner | Schedule a WhatsApp message |
| `.search` | `.find`, `.q` | Owner | Search the local message cache |
| `.sessions` | `.numbers`, `.linked`, `.accounts` | Owner | List linked numbers/sessions |
| `.status` | `.statuses` | Owner | List statuses received while online; type a number to send one here |
| `.sticker` | `.s`, `.stick` | Anyone | Convert an attached image to a sticker |
| `.summarize` | `.summarise`, `.tldr` | Owner | Summarize cached messages in the current chat |
| `.todo` | `.task` | Owner | Save/list/complete tasks; optionally set a personal reminder |
| `.transcribe` | `.stt` | Owner | Transcribe an attached voice note |
| `.translate` | `.tr` | Anyone | Translate supplied text or the last cached message |
| `.trigger` | `.triggers` | Owner | Configure keyword auto-replies (off by default) |
| `.update` | `.upgrade` | Owner | Check GitHub and safely fast-forward Termux or Kerit source deployments |
| `.vault` | `.backup-remote` | Owner | Check/test/push the configured remote vault |
| `.viewonce` | `.vo` | Owner | Control or review view-once capture |
| `.vision` | `.describe`, `.ocr`, `.visual` | Owner | Describe/OCR an attached image |
| `.watch` | `.watchers` | Owner | Show/toggle passive watchers |
| `.webhook` | `.hooks` | Owner | Add/list/remove outbound webhooks |

---

## Commands A–Z

### `.agenda` — pending and missed schedules
**Access:** Owner · **Category:** Automation

```text
.agenda                 # same as week
.agenda today           # pending schedules due today
.agenda week            # next 7 local calendar days
.agenda missed          # list schedules awaiting your decision
.agenda missed send 12  # explicitly send missed job #12 now
.agenda missed skip 12  # skip missed job #12
```

The scheduler allows up to 60 seconds of timer jitter; after that (or after a
reconnect outage), overdue sends move to the missed queue and are **never
delivered late automatically**. Choose `send` or `skip` for each listed ID; the
missed list shows up to 50 at a time, so rerun it after resolving those if more
remain. The today/week agenda shows up to 100 pending jobs. Skipping a one-off
retires it; skipping a recurring job advances to its next future occurrence.
Sending a missed recurrence sends only that occurrence, then re-arms its next
future occurrence. All displayed times use `SCHEDULE_TIMEZONE` (default
`Asia/Karachi`).

### `.ai` — ask the configured AI
**Alias:** `.gpt` · **Access:** Anyone in `NEXUS_MODE=live` · **Category:** AI

```text
.ai Explain this in three short bullet points.
.ai 5 what did he decide about Friday?       # linked main account/controller only

# Reply to one text message or image, then send:
.ai What does this mean?
```

In live mode, any participant in a direct chat or group can use simple
`.ai <question>`. It sends the question to the configured AI provider with no
conversation memory or cached chat history. This public behavior is built into
source—there are no `PUBLIC_AI_*` or `SELF_AI_COMMANDS` environment entries to
add. Fixed in-memory safeguards silently apply a 20-second per-sender cooldown,
a limit of 10 provider requests per sender/day, and 100 public provider requests
per day (reset at midnight UTC).

A public reply-to-message request sends **only the replied-to item** and the new
question: one quoted text/caption or one quoted image. It does not fetch
surrounding messages or cached history. Quoted image bytes are sent to the
configured vision-capable provider. Replying to voice notes, documents, video,
stickers, or empty messages is not supported by this command.

The linked main account may deliberately send `.ai <question>` or
`.ai <n> <question>` (1–50 cached text messages) from its own phone in direct
chats and any group. The number form sends those selected cached messages to the
AI provider, so use it only where you are allowed to share that content. Normal
outgoing messages remain ignored; replayed/history deliveries are rejected and
message IDs are deduplicated. The linked main account cannot run `.ai -check-`,
`.ai -blist-`, or `.ai -wlist-` from another chat.

### AI blocklist (controller only)

```text
.ai -blist- 15551234567    # block a number
.ai -blist- list           # show the persistent blocklist
.ai -wlist- 15551234567    # remove the block
```

Use these only from the private spare-controller chat. A blocked participant
gets one random mild sarcastic preset instead of a provider-backed AI result.
The block applies to `.ai`, `.gpt`, quoted-message AI, `.imagine`/`.image`, and
the provider-backed part of `.calc`; strictly local arithmetic in `.calc` still works. The list is
stored in the local database, not `.env`.

### `.ai -check-` — test each AI provider (owner)
**Access:** Owner · **Category:** AI

```text
.ai -check-
.ai -check- gemini
.ai -check- groq
.ai -check- openrouter

A normal question that starts with the word check still goes to the AI, for example
.ai check my essay for spelling mistakes
```

Sends one small test message to each provider (or the one you name) and replies
with a line for each: ✅ it works, or ❌ with the reason in plain words and the
provider's own error text. The key is never shown. Use it after changing a key or
a model, or when `.ai` answers from a fallback.

### `.aiprovider` — AI provider order
**Alias:** `.aiorder` · **Access:** Owner · **Category:** AI

```text
.aiprovider
.aiprovider gemini 1
.aiprovider groq 2
.aiprovider openrouter 3
```

With no arguments it lists the providers in the order they are tried, and shows
whether each one has an API key set. With a provider and a priority it moves that
provider to that position (1 is tried first) and saves the order to `AI_PROVIDERS`
in `.env`. If a provider fails, the next one is tried. Providers without a key are
skipped. Keys are never shown. If the bot asks for the provider or the priority,
just reply with it.

### `.antidelete` — deletion alerts and history
**Aliases:** `.ad`, `.deleted`, `.deletes` · **Access:** Owner · **Category:** Privacy

```text
.antidelete             # list the latest 10 (default)
.antidelete 20          # list up to 20 recent deletions (max 30)
.antidelete list        # same list view
.antidelete on          # enable alerts
.antidelete off         # disable alerts
.antidelete media on    # allow forwarding available deleted media
.antidelete media off   # text/details only
.antidelete stats       # counters
```

The watcher only sees messages/events delivered to this linked device. `off`
stops processing/recording future delete events as well as their alerts; it does
not erase previously recorded events or cached originals. `media off` only stops
forwarding recovered media. Nothing can recover content WhatsApp never sent to
the device.

## Reply-based media forensics

All commands below work only on a file you explicitly reply to (or on media carrying
the command in its caption). Parsing happens **locally**: file bytes are not sent to
an AI or external metadata service. WhatsApp frequently removes EXIF from normal
photo sends, so the bot can report only fields that still exist—images sent as
documents are more likely to preserve their original metadata.

```text
.md                 # neat camera/GPS/timestamp/container report
.md full            # report plus a downloadable text file of readable fields
.where              # a Maps URL only when GPS is embedded
.file               # actual binary type vs shown filename/MIME
.docxray            # PDF/DOCX/XLSX/PPTX details, links, macro markers
.videoxray          # container, tracks, codec, dimensions/FPS where present
.audioxray          # voice/audio format, duration, tags and technical fields
.qr                 # decode QR from an image or sticker
.fingerprint        # SHA-256 and local visual duplicate comparison
.timeline           # readable capture/creation/modification times
.clean              # downloadable JPEG/PNG/WebP copy with common metadata stripped
.save               # re-send a voice note/sticker/media as a normal file
```

`.save` is particularly useful for normal voice notes: reply with `.save` and it
returns the unchanged audio bytes as an `.ogg` document that can be downloaded to
Files. It also works for stickers, images, video, audio, and documents while the
original is still available. It has a 100 MB safety limit. It does **not** bypass
WhatsApp view-once media.

`.file` reports signatures, extension mismatches, macro markers, external links,
and PDF JavaScript markers, but it is not an antivirus verdict. `.timeline` only
reports timestamps embedded in the file; differences can come from copying or
editing and are not proof that somebody lied. `.fingerprint` stores only hashes
for later local comparisons, not the media itself, and does not perform an internet
reverse-image search.

### `.archive` — locally archived media
**Alias:** `.media` · **Access:** Owner · **Category:** Media

```text
.archive       # latest 10 archive entries
.archive 25    # latest 25 (maximum 30)
```

Lists archive metadata and local paths; it does not upload the files.

### `.ask` — explicitly scoped AI questions
**Access:** Owner; use a private controller chat or “You” chat · **Category:** AI

```text
.ask chats
.ask 2 40 What should I reply?
.ask 2,4 50 Compare what we discussed.
.ask 03001234567 40 What did we decide?
.ask 2 all Summarize our chat.
.ask 2 after 2026-10-01 What did we decide from that date?
.ask 2 after 2026-10-01 to 2026-10-07 | Summarize that period.
.ask 2 on 2026-10-07 What did we discuss that day?
.ask 2 to 2026-10-07 Summarize through that date.
.ask 2 40 --redact phones,emails | What should I reply?
.ask 2 40 --phrase "private phrase" | Summarize.
```

`.ask chats` creates a numbered list of up to 30 cached direct chats; that
numbered snapshot expires after 30 minutes, so refresh it with `.ask chats` if
it is stale. Select up to five chats using comma-separated list numbers, or give
comma-separated direct phone/JID addresses instead; Pakistani `03…` phone format
is accepted. A count applies to each selected chat and must be 1–500, or `all`.

```text
.ask 03001234567,+14155550123 40 Compare these conversations.
```

Date filters use the configured schedule timezone and inclusive local calendar
dates: `after`/`from DATE` starts on that date, `after DATE to DATE` is an
inclusive range, `on DATE` is one day, and `to DATE` ends on that date. The
question follows the filter; `|` makes the boundary explicit.

Redaction options are local and per request. `--redact phones,emails` supports
`phones`, `emails`, or `all`; `--redact-phones` and `--redact-emails` are also
accepted. `--phrase "text to hide"` masks a specified phrase and requires `|`
before the question. The transcript and question are redacted before the AI
provider call. Only selected one-to-one cached text is used; group selection is
not enabled, and this command never replies to chat participants.

### `.audit` — action log
**Alias:** `.log` · **Access:** Owner · **Category:** Admin

```text
.audit       # latest 20 entries
.audit 40    # latest 40 (maximum 50)
```

### `.backup` — encrypted local backup
**Alias:** `.export` · **Access:** Owner · **Category:** Admin

```text
.backup <your-long-unique-passphrase>
.backup list
```

The passphrase encrypts the backup and is not stored; losing it makes the
backup unrecoverable. Use a private chat, do not reuse a password, and use a
single whitespace-free token (the command reads its first argument). WhatsApp
retains the command in chat history even though the bot avoids caching it.
`list` shows existing backup filenames/sizes. Move a backup off the host if its
disk is ephemeral.

### `.blocked` — suspected-block check
**Alias:** `.blockcheck` · **Access:** Owner · **Category:** Privacy

```text
.blocked
.blocked 15550002222@s.whatsapp.net
```

The first form lists recorded suspects; the second checks one full WhatsApp
user JID. Results are inference from independent profile/presence/contact
signals, **not proof**—WhatsApp does not report blocks.

### `.calc` — solve an equation
**Alias:** `.calculate` · **Access:** Anyone · **Category:** Tools

```text
.calc (12 / 3) + 1
.calc 2x + 3 = 11
.calc 2 + 2 --process
```

Basic arithmetic is evaluated locally using a safe parser; it never executes
JavaScript, shell commands, or arbitrary code. It supports parentheses,
`+ - * / % ^`, decimal values, `pi`, `e`, and `sqrt`, `abs`, `sin`, `cos`,
`tan`, `log`, and `ln`. Algebra and word equations use the configured AI
provider. Add `--process` at the end for a concise working explanation; that
also uses the provider. Replies use the `Equation Solved--Calc` label. A
blacklisted number can still use a strictly local calculation, but cannot use
the provider fallback or process explanation.

### `.digest` — recent activity summary
**Aliases:** `.summary`, `.briefing` · **Access:** Owner · **Category:** Productivity

```text
.digest        # last 24 hours
.digest 48     # last 48 hours (maximum 168)
```

### `.draft` — draft, do not send
**Alias:** `.reply` · **Access:** Owner · **Category:** AI

```text
.draft
.draft warm and concise
.draft professional but friendly
```

Drafts a response to the latest cached message in the current chat. It returns
text marked “Draft (not sent)”; copy/edit/send it yourself.

### `.edits` — edited-message history
**Alias:** `.edited` · **Access:** Owner · **Category:** Privacy

```text
.edits       # latest 10 (default)
.edits 25    # latest 25 (maximum 30)
```

### `.env` — private approved settings and owner access
**Access:** Owner; private controller chat only · **Category:** Admin

```text
.env
.env status
.env set AI_PROVIDER groq
.env set AI_PROVIDER openai
.env set AI_PROVIDER gemini
.env set AI_MODEL <provider-model-id>
.env set AI_MAX_HISTORY 12
.env set AI_ASK_MAX_CHARS 60000
.env set CLOUDFLARE_ACCOUNT_ID <account-id>
.env set CLOUDFLARE_API_TOKEN
.env set CAPTURE_ALERT_JID 15551234567
.env set GROQ_API_KEY
.env set OPENAI_API_KEY
.env set GEMINI_API_KEY
.env unset OPENAI_API_KEY
.env unset CLOUDFLARE_API_TOKEN
.env unset CLOUDFLARE_ACCOUNT_ID
.env unset AI_PROVIDER
.env unset AI_MODEL
.env unset CAPTURE_ALERT_JID
.env owner list
.env owner add 15551234567
.env owner remove 15551234567
```

Only approved settings can be changed. `AI_MAX_HISTORY` accepts 2–40 and
`AI_ASK_MAX_CHARS` accepts 4,000–100,000. Public AI, quoted-message AI,
linked-main `.ai <n>`, and `.imagine` safeguards are source-controlled live-mode
behavior; their limits are not panel variables. `CAPTURE_ALERT_JID` must be a
WhatsApp user number/JID, not a group. `CLOUDFLARE_ACCOUNT_ID` is the required
account identifier for image generation. Unsetting `AI_PROVIDER` resets it to
`groq`; unsetting other non-secret settings clears/resets that setting. The last
configured owner cannot be removed.

**API tokens are entered separately; never put one in the command.** For
example, send `.env set GROQ_API_KEY` or `.env set CLOUDFLARE_API_TOKEN`, then
send the actual value alone as your next plain-text message in the same private
chat, within two minutes. The bot does not echo/cache/log it; WhatsApp still
retains your sent message, so delete it locally afterward if you do not want it
in chat history. Send `.env cancel` to abort the pending entry.

### `.forget` — clear this chat’s AI memory
**Alias:** `.reset` · **Access:** Owner · **Category:** AI

```text
.forget
```

Clears the current chat’s in-memory `.ai` history. It does not erase the local
message cache or previous messages in WhatsApp.

### `.imagine` — generate a fresh image from text
**Aliases:** `.image`, `.img`, `.draw` · **Access:** Anyone in `NEXUS_MODE=live` · **Category:** AI

```text
.imagine a tiny astronaut watering flowers on the moon
.image a cinematic rainy street in Peshawar at night
```

Creates one new image from the explicit prompt using Cloudflare Workers AI's
fixed FLUX.1 Schnell model, then sends that image directly to the current chat.
It sends **only the prompt** to Cloudflare; generated image bytes are not put in
the local media archive. It requires both `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`, which the controller sets privately with `.env`.

Cloudflare's Free plan provides a daily allocation; there is no paid-provider
fallback. To keep a public group from spending that allocation, the command has
a fixed 45-second public cooldown, 3 images per public sender/day, 30 public
images/day, and 20 controller/linked-main images/day (UTC). The normal public
AI allowance also applies. The persistent AI blocklist covers this command, so
a blocked number receives the same mild block response as for `.ai`.

The linked main account can deliberately send a normal `.imagine <prompt>` in a
direct chat or group; replayed/history deliveries are ignored and deduplicated.

### `.forward` — show a cached message by ID
**Alias:** `.fwd` · **Access:** Owner · **Category:** Productivity

```text
.search invoice
.forward <stanza-id-shown-by-search>
```

Displays the cached message text/details in the current control chat, including
entries whose original was deleted. It does not send the message back to its
original sender and does not attach media.

### `.groups` — recent group membership events
**Aliases:** `.grouplog` · **Access:** Owner · **Category:** Privacy

```text
.groups       # latest 15 (default)
.groups 30    # latest 30 (maximum 40)
```

### `.health` — runtime health
**Aliases:** `.info`, `.runtime` · **Access:** Owner · **Category:** Tools

```text
.health
```

Shows the mode, uptime, linked sessions, outbound queue, and anti-delete state.
This used to be `.status`, which now lists statuses.

### `.help` — command list
**Aliases:** `.h`, `.commands`, `.menu` · **Access:** Anyone · **Category:** Tools

```text
.help
.help privacy
.help automation
.help ai
```

Available category filters: `admin`, `ai`, `automation`, `media`, `privacy`,
`productivity`, `tools`. Guests see only commands they are allowed to use.

### `.jobs` — list, edit, cancel
**Alias:** `.schedules` · **Access:** Owner · **Category:** Automation

```text
.jobs
.jobs edit 12
.jobs edit 12 recipient
.jobs edit 12 text
.jobs edit 12 time
.jobs edit 12 all
.jobs cancel 12
```

`edit` accepts `recipient`/`to`, `text`/`message`/`body`, `time`/`date`/`when`,
or `all`. It starts a guided flow; review the complete preview and reply `YES`
to apply it. Reply `NO` or `CANCEL` to keep the original unchanged. Only pending
jobs can be edited or cancelled; a due or missed job cannot be changed this way.
Use `.agenda missed` to review missed jobs. `.jobs` lists up to 50 pending jobs;
IDs are shown by `.jobs` and `.agenda missed`.

### `.note` — personal notes
**Alias:** `.n` · **Access:** Owner · **Category:** Productivity

```text
.note Call the clinic on Monday
.note list
.note del 4
.note delete 4
.note rm 4
```

The three delete forms are equivalent; use the ID shown by `.note list`.

### `.panic` — outbound kill switch
**Aliases:** `.stop`, `.halt` · **Access:** Owner · **Category:** Admin

```text
.panic          # halt outbound and drop queued messages
.panic on       # same halt action
.panic resume   # resume outbound
.panic off      # same as resume
```

Inbound processing continues while halted. `resume` restores normal safety and
rate limits; use this only when you intend to stop/resume all bot sends.

### `.ping` — latency/runtime check
**Aliases:** `.p`, `.latency` · **Access:** Anyone · **Category:** Tools

```text
.ping
```

### `.presence` — recorded online/last-seen transitions
**Aliases:** `.lastseen`, `.online` · **Access:** Owner · **Category:** Privacy

```text
.presence       # latest 15 (default)
.presence 30    # latest 30 (maximum 40)
```

Presence is only what the linked device received and recorded; it is not a
live guarantee of someone’s current status.

### `.receive` — private cached-message receiver
**Alias:** `.recieve` (both spellings work) · **Access:** Owner; private
controller chat only · **Category:** Privacy

```text
.receive 03001234567 5
.recieve 03001234567 5
.receive 03001234567 5 --text-only
.receive 03001234567 5 --no-media
.receive unread
.receive unread 25
.receive 923001234567@s.whatsapp.net 5
```

The direct phone/contact form reviews the latest 1–50 cached inbound messages
(default 5) and sends the report/media only to the private controller chat. If a
number matches multiple cached chat identities, use the full direct WhatsApp
JID to disambiguate. Available media is limited to five attachments per request
and 16 MB per file; use `--text-only` or `--no-media` to avoid retrieving media.

`unread [max]` reports WhatsApp’s synced **chat-level** unread count and may show
latest cached text as an explicitly unverified preview. `max` is a total
message-count budget across chats (default and maximum 100); the report examines
up to 50 chats. WhatsApp does not give this command the IDs of individual unread
messages, so previews are not labeled as confirmed unread, and media is not
attached in this mode. Unknown counts and recent-cache timing alone are never
treated as unread. The receiver never calls `readMessages`/`markRead` or opens
messages in the sender chat. Blue-tick behavior cannot be guaranteed without
live WhatsApp testing.

### `.remind` — schedule a recipient-specific reminder
**Alias:** `.reminder` · **Access:** Owner · **Category:** Automation

```text
.remind to Sam in 2 days at 7:20 pm | Take your medicine
.remind to 03001234567 tomorrow at 9 am | Bring the documents
.remind to Sam every Friday at 5 pm | Submit the weekly report
.remind
```

Replace `Sam` with a locally saved contact name. If you omit fields, the
guided flow asks for recipient, text, and time; ambiguous saved names prompt for
a choice. It previews the message and requires `YES`; `NO`/`CANCEL` discards
the draft. The reminder is addressed to the recipient specified for that
request, sent only at the due time, and is not sent as an advance notice. The
recipient message is prefixed with
`Reminder:`. Recurring reminders support interval and calendar rules; examples
include `every day at 8 pm`, `every 2 weeks on Monday at 9 am`,
`the 15th of every month at 9 am`, `last Friday of every month at 5 pm`, and
`annually on 9 September at 9 am`. Use a full date/time in the configured
schedule timezone. If a monthly/leap-day occurrence can be missing, the wizard
asks whether to skip that month/year or use its last day. You can start and
answer the guided flow in the private owner-control chat or the linked account’s
“You” chat; bot echoes and replayed history do not count as replies.

### `.restart` — restart safely on Termux or Kerit
**Alias:** `.reboot` · **Access:** Owner; private controller chat or “You” chat · **Category:** Admin

```text
.restart
.reboot
```

On the standard `~/nexus-wa` **Termux** install under `nexus start`, this uses the
installed `nexus restart` supervisor command. It does not kill Node directly,
unlink WhatsApp, or change the session/database in `~/.nexus-wa`.

On **Kerit/Pterodactyl**, `.restart` deliberately does not stop the process:
a clean in-container exit is not guaranteed to make the panel start it again.
Press **Restart** in the Kerit server panel instead. The command is available
there only after the host variable `NEXUS_HOST=kerit` is set.

### `.schedule` — schedule a WhatsApp message
**Alias:** `.sched` · **Access:** Owner · **Category:** Automation

```text
.schedule to Sam tomorrow at 9 am | The meeting starts soon.
.sched to 03001234567 in 2 days at 7:20 pm | Your package is ready.
.schedule to Sam on 9 September at 12:00 am | Happy birthday!
.schedule to Sam every Friday at 5 pm | Send the weekly report.
.schedule
```

Use a saved contact name or WhatsApp number; ambiguous saved names prompt for
a choice. The guided flow fills any missing recipient, message, or time; it
previews the exact recipient/body/time and requires `YES`. `NO`/`CANCEL` leaves
no job. No advance notice is sent. One-off and recurring schedules use the
same date/time examples as `.remind`. You can
start and answer the guided flow in the private owner-control chat or the linked
account’s “You” chat; bot echoes and replayed history do not count as replies.

### `.search` — search cached messages
**Aliases:** `.find`, `.q` · **Access:** Owner · **Category:** Productivity

```text
.search invoice
.search "meeting moved"
```

Returns up to 12 local-cache matches and their stanza IDs. Copy an ID from a
result into `.forward <id>`. Search uses cached text only; it does not search
WhatsApp’s full server history.

### `.sessions` — linked-number history
**Aliases:** `.numbers`, `.linked`, `.accounts` · **Access:** Owner · **Category:** Admin

```text
.sessions
```

### `.status` — statuses received while online
**Alias:** `.statuses` · **Access:** Owner · **Category:** Privacy

```text
.status
.status 10
```

Lists the statuses the bot received while it was online, newest first, numbered:
`Status 1: Ali (+923001234567) · 9:14 pm · photo — caption`. Type a number in the
same chat to send that status there. Photos, videos, voice notes, stickers, and
documents are re-downloaded and sent with the poster and time. The bot never views
or marks statuses as read. WhatsApp only delivers statuses while the bot is online,
so older statuses cannot be fetched. WhatsApp also removes status media after 24
hours, so an old number may fail with a message. Default list length is 20, maximum 50.

### `.sticker` — convert an attached image
**Aliases:** `.s`, `.stick` · **Access:** Anyone · **Category:** Media

```text
# Send an image with this command in the same message's caption:
.sticker
```

Requires `ffmpeg` on the host. The command only processes media attached to the
same command message; a separate or quoted image is not used. It sends the
converted sticker back to the current chat.

### `.summarize` — summarize current-chat cache
**Aliases:** `.summarise`, `.tldr` · **Access:** Owner · **Category:** AI

```text
.summarize       # latest 40 messages (default)
.summarize 100   # latest 100 (maximum 200)
```

Needs at least three cached text messages in the current chat and a configured
AI provider. Only the selected current chat is summarized.

### `.todo` — personal tasks and optional reminders
**Alias:** `.task` · **Access:** Owner · **Category:** Productivity

```text
.todo Buy printer paper
.todo Renew the parking pass at 8pm
.todo Take medicine in 1h
.todo Water the plants tomorrow 9am
.todo list
.todo done 7
```

Use `.todo list` to show open tasks and `.todo done <id>` to complete one.
Optional trailing time examples include `in 10m`, `at 8pm`, `tomorrow 9am`, a
weekday/time such as `Friday 9am`, and recurring forms such as `every day 9am`
or `every 30m`. Timed todos are personal task notifications; use `.remind` when
you want a message sent to a specified contact. Unlike `.schedule` and `.remind`,
timed todos use the legacy `TZ` setting for parsing (default `UTC`); `.todo list`
shows reminder timestamps in UTC.

### `.transcribe` — voice-note transcription
**Alias:** `.stt` · **Access:** Owner · **Category:** Media

```text
# Send an audio attachment with this command in the same message's caption:
.transcribe
```

Requires a configured audio-capable provider (Groq/Whisper or OpenAI/Whisper).
The command only processes audio attached to the command message; it does not
look up a separately sent or quoted voice note. If your WhatsApp client cannot
add a caption to the audio message, this command cannot trigger on that bare
voice note.

### `.translate` — translate supplied/recent text
**Alias:** `.tr` · **Access:** Anyone · **Category:** AI

```text
.translate Urdu Hello, how are you?
.translate Arabic
```

If text follows the language, translates that text. If omitted, translates the
last cached text message in the current chat. The prompt is sent to the
configured AI provider.

### `.trigger` — keyword auto-replies
**Alias:** `.triggers` · **Access:** Owner · **Category:** Admin

```text
.trigger                 # list rules/status
.trigger list
.trigger add invoice => Thanks, I’ll check it.
.trigger add /\bETA\b/i => I’ll send an update soon.
.trigger del 3
.trigger on
.trigger off
```

Plain patterns match case-insensitive substrings; `/pattern/` or `/pattern/i`
uses a regular expression. Adding the rule while in a group scopes it to that
group; adding it in a direct chat creates a global direct-message rule. Global
rules never run in groups. IDs are shown by `.trigger list`; matching replies
have a 90-second per-chat cooldown. Triggers are off by default. **`on` enables
unprompted auto-replies**, which can be disruptive and carry account risk; use
`off` to stop them.

### `.update` — safely update a Termux or Kerit source deployment
**Alias:** `.upgrade` · **Access:** Owner; private controller chat or “You” chat · **Category:** Admin

```text
.update check
.update
.upgrade check
```

`.update check` fetches the configured GitHub upstream and reports whether the
current branch has updates; it installs nothing. `.update` refuses a dirty
worktree, local-only commits, a missing upstream, branch switching, forced
updates, resets, and clean operations. When it is safe, it uses only
`git pull --ff-only` followed by `npm ci --omit=optional --no-audit --fund=false`.

On the standard supervised **Termux** install it refreshes the `nexus` command
and restarts after the dependency install succeeds. On a **Kerit/Pterodactyl**
Git checkout, set `NEXUS_HOST=kerit` to enable the same safe check/fast-forward.
After a successful Kerit update it tells you to press **Restart** once in the
server panel; it never calls `process.exit()` because that can leave the
container offline. An uploaded ZIP has no Git checkout, so it is reported as
not updateable rather than changed. WhatsApp auth, database, and notes are
preserved when they are on persistent storage.

### `.env` — private approved settings and owner access
**Access:** Owner; private controller chat only · **Category:** Admin

```text
.env
.env status
.env set AI_PROVIDER groq
.env set AI_PROVIDER openai
.env set AI_PROVIDER gemini
.env set AI_MODEL <provider-model-id>
.env set AI_MAX_HISTORY 12
.env set AI_ASK_MAX_CHARS 60000
.env set CLOUDFLARE_ACCOUNT_ID <account-id>
.env set CLOUDFLARE_API_TOKEN
.env set CAPTURE_ALERT_JID 15551234567
.env set GROQ_API_KEY
.env set OPENAI_API_KEY
.env set GEMINI_API_KEY
.env unset OPENAI_API_KEY
.env unset CLOUDFLARE_API_TOKEN
.env unset CLOUDFLARE_ACCOUNT_ID
.env unset AI_PROVIDER
.env unset AI_MODEL
.env unset CAPTURE_ALERT_JID
.env owner list
.env owner add 15551234567
.env owner remove 15551234567
```

Only approved settings can be changed. `AI_MAX_HISTORY` accepts 2–40 and
`AI_ASK_MAX_CHARS` accepts 4,000–100,000. Public AI, quoted-message AI,
linked-main `.ai <n>`, and `.imagine` safeguards are source-controlled live-mode
behavior; their limits are not panel variables. `CAPTURE_ALERT_JID` must be a
WhatsApp user number/JID, not a group. `CLOUDFLARE_ACCOUNT_ID` is the required
account identifier for image generation. Unsetting `AI_PROVIDER` resets it to
`groq`; unsetting other non-secret settings clears/resets that setting. The last
configured owner cannot be removed.

**API tokens are entered separately; never put one in the command.** For
example, send `.env set GROQ_API_KEY` or `.env set CLOUDFLARE_API_TOKEN`, then
send the actual value alone as your next plain-text message in the same private
chat, within two minutes. The bot does not echo/cache/log it; WhatsApp still
retains your sent message, so delete it locally afterward if you do not want it
in chat history. Send `.env cancel` to abort the pending entry.

### `.forget` — clear this chat’s AI memory
**Alias:** `.reset` · **Access:** Owner · **Category:** AI

```text
.forget
```

Clears the current chat’s in-memory `.ai` history. It does not erase the local
message cache or previous messages in WhatsApp.

### `.imagine` — generate a fresh image from text
**Aliases:** `.image`, `.img`, `.draw` · **Access:** Anyone in `NEXUS_MODE=live` · **Category:** AI

```text
.imagine a tiny astronaut watering flowers on the moon
.image a cinematic rainy street in Peshawar at night
```

Creates one new image from the explicit prompt using Cloudflare Workers AI's
fixed FLUX.1 Schnell model, then sends that image directly to the current chat.
It sends **only the prompt** to Cloudflare; generated image bytes are not put in
the local media archive. It requires both `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`, which the controller sets privately with `.env`.

Cloudflare's Free plan provides a daily allocation; there is no paid-provider
fallback. To keep a public group from spending that allocation, the command has
a fixed 45-second public cooldown, 3 images per public sender/day, 30 public
images/day, and 20 controller/linked-main images/day (UTC). The normal public
AI allowance also applies. The persistent AI blocklist covers this command, so
a blocked number receives the same mild block response as for `.ai`.

The linked main account can deliberately send a normal `.imagine <prompt>` in a
direct chat or group; replayed/history deliveries are ignored and deduplicated.

### `.forward` — show a cached message by ID
**Alias:** `.fwd` · **Access:** Owner · **Category:** Productivity

```text
.search invoice
.forward <stanza-id-shown-by-search>
```

Displays the cached message text/details in the current control chat, including
entries whose original was deleted. It does not send the message back to its
original sender and does not attach media.

### `.groups` — recent group membership events
**Aliases:** `.grouplog` · **Access:** Owner · **Category:** Privacy

```text
.groups       # latest 15 (default)
.groups 30    # latest 30 (maximum 40)
```

### `.health` — runtime health
**Aliases:** `.info`, `.runtime` · **Access:** Owner · **Category:** Tools

```text
.health
```

Shows the mode, uptime, linked sessions, outbound queue, and anti-delete state.
This used to be `.status`, which now lists statuses.

### `.help` — command list
**Aliases:** `.h`, `.commands`, `.menu` · **Access:** Anyone · **Category:** Tools

```text
.help
.help privacy
.help automation
.help ai
```

Available category filters: `admin`, `ai`, `automation`, `media`, `privacy`,
`productivity`, `tools`. Guests see only commands they are allowed to use.

### `.jobs` — list, edit, cancel
**Alias:** `.schedules` · **Access:** Owner · **Category:** Automation

```text
.jobs
.jobs edit 12
.jobs edit 12 recipient
.jobs edit 12 text
.jobs edit 12 time
.jobs edit 12 all
.jobs cancel 12
```

`edit` accepts `recipient`/`to`, `text`/`message`/`body`, `time`/`date`/`when`,
or `all`. It starts a guided flow; review the complete preview and reply `YES`
to apply it. Reply `NO` or `CANCEL` to keep the original unchanged. Only pending
jobs can be edited or cancelled; a due or missed job cannot be changed this way.
Use `.agenda missed` to review missed jobs. `.jobs` lists up to 50 pending jobs;
IDs are shown by `.jobs` and `.agenda missed`.

### `.note` — personal notes
**Alias:** `.n` · **Access:** Owner · **Category:** Productivity

```text
.note Call the clinic on Monday
.note list
.note del 4
.note delete 4
.note rm 4
```

The three delete forms are equivalent; use the ID shown by `.note list`.

### `.panic` — outbound kill switch
**Aliases:** `.stop`, `.halt` · **Access:** Owner · **Category:** Admin

```text
.panic          # halt outbound and drop queued messages
.panic on       # same halt action
.panic resume   # resume outbound
.panic off      # same as resume
```

Inbound processing continues while halted. `resume` restores normal safety and
rate limits; use this only when you intend to stop/resume all bot sends.

### `.ping` — latency/runtime check
**Aliases:** `.p`, `.latency` · **Access:** Anyone · **Category:** Tools

```text
.ping
```

### `.presence` — recorded online/last-seen transitions
**Aliases:** `.lastseen`, `.online` · **Access:** Owner · **Category:** Privacy

```text
.presence       # latest 15 (default)
.presence 30    # latest 30 (maximum 40)
```

Presence is only what the linked device received and recorded; it is not a
live guarantee of someone’s current status.

### `.receive` — private cached-message receiver
**Alias:** `.recieve` (both spellings work) · **Access:** Owner; private
controller chat only · **Category:** Privacy

```text
.receive 03001234567 5
.recieve 03001234567 5
.receive 03001234567 5 --text-only
.receive 03001234567 5 --no-media
.receive unread
.receive unread 25
.receive 923001234567@s.whatsapp.net 5
```

The direct phone/contact form reviews the latest 1–50 cached inbound messages
(default 5) and sends the report/media only to the private controller chat. If a
number matches multiple cached chat identities, use the full direct WhatsApp
JID to disambiguate. Available media is limited to five attachments per request
and 16 MB per file; use `--text-only` or `--no-media` to avoid retrieving media.

`unread [max]` reports WhatsApp’s synced **chat-level** unread count and may show
latest cached text as an explicitly unverified preview. `max` is a total
message-count budget across chats (default and maximum 100); the report examines
up to 50 chats. WhatsApp does not give this command the IDs of individual unread
messages, so previews are not labeled as confirmed unread, and media is not
attached in this mode. Unknown counts and recent-cache timing alone are never
treated as unread. The receiver never calls `readMessages`/`markRead` or opens
messages in the sender chat. Blue-tick behavior cannot be guaranteed without
live WhatsApp testing.

### `.remind` — schedule a recipient-specific reminder
**Alias:** `.reminder` · **Access:** Owner · **Category:** Automation

```text
.remind to Sam in 2 days at 7:20 pm | Take your medicine
.remind to 03001234567 tomorrow at 9 am | Bring the documents
.remind to Sam every Friday at 5 pm | Submit the weekly report
.remind
```

Replace `Sam` with a locally saved contact name. If you omit fields, the
guided flow asks for recipient, text, and time; ambiguous saved names prompt for
a choice. It previews the message and requires `YES`; `NO`/`CANCEL` discards
the draft. The reminder is addressed to the recipient specified for that
request, sent only at the due time, and is not sent as an advance notice. The
recipient message is prefixed with
`Reminder:`. Recurring reminders support interval and calendar rules; examples
include `every day at 8 pm`, `every 2 weeks on Monday at 9 am`,
`the 15th of every month at 9 am`, `last Friday of every month at 5 pm`, and
`annually on 9 September at 9 am`. Use a full date/time in the configured
schedule timezone. If a monthly/leap-day occurrence can be missing, the wizard
asks whether to skip that month/year or use its last day. You can start and
answer the guided flow in the private owner-control chat or the linked account’s
“You” chat; bot echoes and replayed history do not count as replies.

### `.restart` — restart safely on Termux or Kerit
**Alias:** `.reboot` · **Access:** Owner; private controller chat or “You” chat · **Category:** Admin

```text
.restart
.reboot
```

On the standard `~/nexus-wa` **Termux** install under `nexus start`, this uses the
installed `nexus restart` supervisor command. It does not kill Node directly,
unlink WhatsApp, or change the session/database in `~/.nexus-wa`.

On **Kerit/Pterodactyl**, `.restart` deliberately does not stop the process:
a clean in-container exit is not guaranteed to make the panel start it again.
Press **Restart** in the Kerit server panel instead. The command is available
there only after the host variable `NEXUS_HOST=kerit` is set.

### `.schedule` — schedule a WhatsApp message
**Alias:** `.sched` · **Access:** Owner · **Category:** Automation

```text
.schedule to Sam tomorrow at 9 am | The meeting starts soon.
.sched to 03001234567 in 2 days at 7:20 pm | Your package is ready.
.schedule to Sam on 9 September at 12:00 am | Happy birthday!
.schedule to Sam every Friday at 5 pm | Send the weekly report.
.schedule
```

Use a saved contact name or WhatsApp number; ambiguous saved names prompt for
a choice. The guided flow fills any missing recipient, message, or time; it
previews the exact recipient/body/time and requires `YES`. `NO`/`CANCEL` leaves
no job. No advance notice is sent. One-off and recurring schedules use the
same date/time examples as `.remind`. You can
start and answer the guided flow in the private owner-control chat or the linked
account’s “You” chat; bot echoes and replayed history do not count as replies.

### `.search` — search cached messages
**Aliases:** `.find`, `.q` · **Access:** Owner · **Category:** Productivity

```text
.search invoice
.search "meeting moved"
```

Returns up to 12 local-cache matches and their stanza IDs. Copy an ID from a
result into `.forward <id>`. Search uses cached text only; it does not search
WhatsApp’s full server history.

### `.sessions` — linked-number history
**Aliases:** `.numbers`, `.linked`, `.accounts` · **Access:** Owner · **Category:** Admin

```text
.sessions
```

### `.status` — statuses received while online
**Alias:** `.statuses` · **Access:** Owner · **Category:** Privacy

```text
.status
.status 10
```

Lists the statuses the bot received while it was online, newest first, numbered:
`Status 1: Ali (+923001234567) · 9:14 pm · photo — caption`. Type a number in the
same chat to send that status there. Photos, videos, voice notes, stickers, and
documents are re-downloaded and sent with the poster and time. The bot never views
or marks statuses as read. WhatsApp only delivers statuses while the bot is online,
so older statuses cannot be fetched. WhatsApp also removes status media after 24
hours, so an old number may fail with a message. Default list length is 20, maximum 50.

### `.sticker` — convert an attached image
**Aliases:** `.s`, `.stick` · **Access:** Anyone · **Category:** Media

```text
# Send an image with this command in the same message's caption:
.sticker
```

Requires `ffmpeg` on the host. The command only processes media attached to the
same command message; a separate or quoted image is not used. It sends the
converted sticker back to the current chat.

### `.summarize` — summarize current-chat cache
**Aliases:** `.summarise`, `.tldr` · **Access:** Owner · **Category:** AI

```text
.summarize       # latest 40 messages (default)
.summarize 100   # latest 100 (maximum 200)
```

Needs at least three cached text messages in the current chat and a configured
AI provider. Only the selected current chat is summarized.

### `.todo` — personal tasks and optional reminders
**Alias:** `.task` · **Access:** Owner · **Category:** Productivity

```text
.todo Buy printer paper
.todo Renew the parking pass at 8pm
.todo Take medicine in 1h
.todo Water the plants tomorrow 9am
.todo list
.todo done 7
```

Use `.todo list` to show open tasks and `.todo done <id>` to complete one.
Optional trailing time examples include `in 10m`, `at 8pm`, `tomorrow 9am`, a
weekday/time such as `Friday 9am`, and recurring forms such as `every day 9am`
or `every 30m`. Timed todos are personal task notifications; use `.remind` when
you want a message sent to a specified contact. Unlike `.schedule` and `.remind`,
timed todos use the legacy `TZ` setting for parsing (default `UTC`); `.todo list`
shows reminder timestamps in UTC.

### `.transcribe` — voice-note transcription
**Alias:** `.stt` · **Access:** Owner · **Category:** Media

```text
# Send an audio attachment with this command in the same message's caption:
.transcribe
```

Requires a configured audio-capable provider (Groq/Whisper or OpenAI/Whisper).
The command only processes audio attached to the command message; it does not
look up a separately sent or quoted voice note. If your WhatsApp client cannot
add a caption to the audio message, this command cannot trigger on that bare
voice note.

### `.translate` — translate supplied/recent text
**Alias:** `.tr` · **Access:** Anyone · **Category:** AI

```text
.translate Urdu Hello, how are you?
.translate Arabic
```

If text follows the language, translates that text. If omitted, translates the
last cached text message in the current chat. The prompt is sent to the
configured AI provider.

### `.trigger` — keyword auto-replies
**Alias:** `.triggers` · **Access:** Owner · **Category:** Admin

```text
.trigger                 # list rules/status
.trigger list
.trigger add invoice => Thanks, I’ll check it.
.trigger add /\bETA\b/i => I’ll send an update soon.
.trigger del 3
.trigger on
.trigger off
```

Plain patterns match case-insensitive substrings; `/pattern/` or `/pattern/i`
uses a regular expression. Adding the rule while in a group scopes it to that
group; adding it in a direct chat creates a global direct-message rule. Global
rules never run in groups. IDs are shown by `.trigger list`; matching replies
have a 90-second per-chat cooldown. Triggers are off by default. **`on` enables
unprompted auto-replies**, which can be disruptive and carry account risk; use
`off` to stop them.

### `.update` — safely update a Termux or Kerit source deployment
**Alias:** `.upgrade` · **Access:** Owner; private controller chat or “You” chat · **Category:** Admin

```text
.update check
.update
.upgrade check
```

`.update check` fetches the configured GitHub upstream and reports whether the
current branch has updates; it installs nothing. `.update` refuses a dirty
worktree, local-only commits, a missing upstream, branch switching, forced
updates, resets, and clean operations. When it is safe, it uses only
`git pull --ff-only` followed by `npm ci --omit=optional --no-audit --fund=false`.

On the standard supervised **Termux** install it refreshes the `nexus` command
and restarts after the dependency install succeeds. On a **Kerit/Pterodactyl**
Git checkout, set `NEXUS_HOST=kerit` to enable the same safe check/fast-forward.
After a successful Kerit update it tells you to press **Restart** once in the
server panel; it never calls `process.exit()` because that can leave the
container offline. An uploaded ZIP has no Git checkout, so it is reported as
not updateable rather than changed. WhatsApp auth, database, and notes are
preserved when they are on persistent storage.

### `.vault` — configured remote backup
**Alias:** `.backup-remote` · **Access:** Owner · **Category:** Admin

```text
.vault        # status
.vault status # status
.vault test   # push then pull a verification backup
.vault push   # push a backup now
```

Requires a configured remote vault. `test` and `push` transfer encrypted backup
data to that configured service; run them only if you have set up and trust the
remote destination.

### `.viewonce` — view-once capture/review
**Alias:** `.vo` · **Access:** Owner · **Category:** Privacy

```text
.viewonce       # latest 10 captured events
.viewonce 20    # latest 20 (maximum 30)
.viewonce on    # enable capture
.viewonce off   # disable capture
```

It can only save media bytes WhatsApp delivers to this linked-device profile;
a marker alone cannot be turned into media.

### `.vision` — describe/OCR an attached image
**Aliases:** `.describe`, `.ocr`, `.visual` · **Access:** Owner · **Category:** AI

```text
# Send an image with the command/instruction in the same message's caption:
.vision
.visual Read the sign and translate it to English.
```

The image and instruction are sent to a configured **vision-capable model**. A
separate or quoted image is not used; the image must be attached to the command
message. The bot skips text-only models (including Groq
`openai/gpt-oss-120b`) instead of sending them an image and producing a false
fallback warning. Configure Gemini or another documented vision-capable model
if the command says none is available.

### `.watch` — passive watcher switches
**Alias:** `.watchers` · **Access:** Owner · **Category:** Privacy

```text
.watch
.watch viewonce on
.watch antidelete off
.watch edits on
.watch profiles on
.watch presence off
.watch groups on
.watch triggers off
.watch scheduler on
```

With no name it lists watcher states. Available names: `viewonce`, `antidelete`,
`edits`, `profiles`, `presence`, `groups`, `triggers`, `scheduler`; each accepts
`on` or `off`. `.watch triggers on` has the auto-reply warning described under
`.trigger`. `.watch scheduler off` pauses delivery without deleting jobs; when
re-enabled, overdue jobs go through the missed-send review rules above. Use
`.jobs cancel <id>` to remove an individual pending job.

### `.webhook` — outbound event webhooks
**Alias:** `.hooks` · **Access:** Owner · **Category:** Admin

```text
.webhook
.webhook list
.webhook add https://example.com/wa-hook
.webhook add https://example.com/wa-hook delete,edit,viewonce,audit
.webhook del 2
```

Events default to `*` (all supported events). Current named events are
`delete`, `edit`, `viewonce`, and `audit`; provide a comma-separated list to
narrow it. The URL must use HTTP or HTTPS. Current payloads contain event
metadata, not message text or media bytes. IDs are shown by `.webhook list`;
`del` permanently removes the hook.
---

## Optional Telegram control panel

These slash commands are separate from the 38 WhatsApp dot commands. They work
only when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID` are configured; other
Telegram accounts are silently rejected.

```text
/antidelete             # status and counters
/antidelete on
/antidelete off
/antidelete media on
/antidelete media off
/deletes                # latest 10
/deletes 25             # latest 25 (maximum 30)
/help
/kill
/logs                   # latest 40 lines
/logs 100               # latest 100 (maximum 200)
/mode dry-run
/mode observe
/mode live
/plugins
/qr
/sessions
/start
/status
```

`/qr` only resends a QR that is already pending; it does not create a new one.
Do not use pairing/QR controls unless you intentionally started a pairing flow.
`/mode` changes the displayed/runtime mode flag, but changing the underlying
transport requires a restart. `/kill` gracefully stops the bot.
