# Running Nexus-WA on a phone with Termux

Free forever, no credit card, no account verification. This is the recommended
host: it has a **real filesystem**, so there is no re-pairing and no need for the
GitHub vault, and it connects from your own home IP, which looks normal to
WhatsApp rather than like a datacentre login. For the complete sorted list of
WhatsApp commands, aliases, subcommands, and examples, see
[`COMMANDS.md`](COMMANDS.md).

---

## Install

Install **Termux** and **Termux:Boot** from [F-Droid](https://f-droid.org) —
**not** from the Play Store. The Play Store build is years out of date and its
packages will not work.

Open Termux once, then:

```sh
pkg install -y git
git clone -b arena/fa15663b-wabot https://github.com/sadapay404/WABot.git ~/nexus-wa
cd ~/nexus-wa
bash deploy/termux/setup.sh
```

Then edit the config and start:

```sh
nano ~/nexus-wa/.env     # set WA_PAIRING_NUMBER and OWNER_JIDS
nexus start
nexus pair               # prints the 8-character code
```

Link it: **WhatsApp → Linked devices → Link a device → "Link with phone number
instead"** → type the code.

No native modules are compiled. The project needs Node ≥ 22.5 and uses Node's
built-in `node:sqlite`; `better-sqlite3` is only an optional fallback. That
removes the step that usually breaks Termux installs.

---

## Your three questions

### 1. The phone loses internet between home and class

**Nothing breaks, and you do not have to do anything.**

When the connection drops, `classifyDisconnect` sees no status code and returns
`'backoff'` — *not* `'relogin'` — so the stored credentials are left completely
alone (`src/core/whatsapp.js:37`). The bot then retries with exponential backoff
**capped at 60 seconds and with no attempt limit** (`whatsapp.js:73`, `:193-198`).
It never gives up.

So the phone can be offline for five minutes or five hours; when WiFi appears at
your brother's class, the bot reconnects within a minute by itself.

The honest cost: **while it is offline it is offline.** No commands, and nothing
sends. It is not buffering your messages.

### 2. The phone dies and restarts — do you re-pair?

**No. You pair once.**

Credentials live in `~/.nexus-wa/auth` on the phone's real storage, and a reboot
does not touch it. On start the bot reads those files and resumes the existing
linked device.

`Termux:Boot` restarts the bot automatically after a reboot. It waits up to two
minutes for WiFi, then starts anyway — because a bot that waits for a network
that never comes is worse than one that starts and retries.

For this to work you must install **Termux:Boot** and **open it once** after
installing, or Android never grants it permission to run.

### 3. WiFi only, no cellular — internet is the real worry

That is the right thing to worry about, and it is the one limitation Termux
cannot fix. What happens during a gap:

| | |
|---|---|
| **Scheduled reminders/messages** | A job that is stale or whose time passed during a disconnect is moved to `missed`; it is **not automatically sent late**. The ordinary timer allows up to 60 seconds of scheduling jitter. |
| **Recurring jobs** | A missed occurrence pauses that schedule until you choose `send` (send this occurrence now, then re-arm) or `skip` (advance to the next future occurrence). It never bursts through missed occurrences. |
| **A job interrupted mid-send** | Its `running` state is recovered as pending; if its due time has passed, it enters the missed queue for an explicit owner decision. |
| **Reconnect catch-up** | On reconnect, the owner control chat receives the outage window and the missed schedules awaiting a decision. `.agenda missed` lists them again at any time. |
| **Messages sent to you** | Partial. WhatsApp replays recent history to linked devices on reconnect, but this is not guaranteed for everything. Do not treat the bot as a reliable archive of what arrived while it was down. |
| **View-once media** | Captured only when WhatsApp delivers the media to this linked-device profile. Some profiles receive just a view-once marker; the bot records and alerts on that event but cannot recover bytes it never received. If the bot is offline, a short-lived blob may also expire before reconnect. |

The default companion is Baileys' **Ubuntu/Chrome web profile**. `creds.platform`
identifies the primary WhatsApp account platform (`smba`/`smbi`), not the linked
companion type; logs now label it `account platform` separately from the
requested companion profile.

For WhatsApp Business view-once media, the upstream Baileys report [#2782](https://github.com/WhiskeySockets/Baileys/issues/2782)
reports success with a *fresh* `SMB_ANDROID` companion, `webInfo` present,
`companion_platform_id=CHROME (1)`, and `DeviceProps=ANDROID_PHONE`. Nexus-WA has
an opt-in patch for this exact combination on Baileys `7.0.0-rc14`:

- Set `WA_COMPANION_PROFILE=smb_android`.
- Use a **new, separate** `WA_SESSION_DIR` (for example, the absolute path
  `/data/data/com.termux/files/home/.nexus-wa/auth-smb`). This keeps the current
  linked session and its auth files untouched. The app refuses to apply this
  profile to an already-authenticated directory.
- Run `npm ci --omit=optional --no-audit --fund=false` once after updating;
  the postinstall step applies the pinned Baileys patch.
- Pair the new companion from the Business phone. The old linked device is not
  removed. To roll back, stop the bot, restore the old `WA_SESSION_DIR` and set
  `WA_COMPANION_PROFILE=web`.

This is based on an upstream user's Business-account test, not a live test on
your number. Use a spare test Business account first; linking the additional
companion consumes one linked-device slot. Do not delete the old auth directory
or remove the old linked device unless you later choose to do so.

**Practical advice:** keep the phone at home on a charger when you can. If it
has to travel, delivery may pause during the outage; missed schedules wait for
your send-now/skip choice instead of being sent late automatically.

---

## Keep Android from killing it

This is the part that decides whether the whole thing works. Without it Android
kills the bot within an hour.

```sh
termux-wake-lock
```

Then in Android settings:

- **Settings → Apps → Termux → Battery → Unrestricted**
- **Settings → Apps → Termux → allow Autostart** (some phones: Settings → Battery → App launch)
- **Lock Termux in the recent-apps list** — open recents, pull Termux down or tap the lock icon
- Do **not** swipe Termux away to "clear" it

Xiaomi/Huawei/Oppo/Vivo are the worst offenders here. Check
[dontkillmyapp.com](https://dontkillmyapp.com) for your exact model.

---

## Scheduling messages and reminders

The scheduler stores jobs in SQLite, so one-time and recurring jobs survive a
bot restart. New schedule/reminder dates use `SCHEDULE_TIMEZONE=Asia/Karachi`
(the default), not the Termux/server timezone. A saved job is an absolute
instant, so changing this setting later does not move existing jobs.

You can enter a complete request in the “You” chat using a saved contact name
or a WhatsApp number (country code included; `+` is optional; Pakistani local
`03…` mobile format is also accepted):

```text
.schedule to Sam on 9 September at 12:00 am | Happy birthday!
.schedule to Sam every Friday at 8:00 pm | Your weekly update
.schedule to Sam every 2 weeks on Monday at 9 am | Send the report
.schedule to Sam the 15th of every month at 9 am | Rent is due
.schedule to Sam last Friday of every month at 5 pm | Monthly update
.schedule to Sam annually on 9 September at 9 am | Happy birthday!
.remind to 923001234567 in 2 days at 7:20 pm | Take your medicine
```

The first pipe separates the schedule details from the exact message body;
additional pipes are kept in the message. Supported deterministic patterns
include `in N days at H:MM am/pm`, `tomorrow at 9 am`, `every 2 weeks on Monday
at 9 am`, `the 15th of every month at 9 am`, `last Friday of every month at
5 pm`, and `annually on 9 September at 9 am`. Use AM/PM for a bare hour.
For a date such as the 31st that is absent in some months, the bot asks whether
to skip those months or use their last day. Recurring previews show the next
three send times. The parser is local and rules-based; it does not send your
request to an AI service.

If you type only `.schedule` or `.remind`, or leave something out, the bot asks
for the missing recipient, message, date/time, or time-of-day. It always shows
a preview of the recipient, local send time, and message. Reply `YES` to save
it or `NO`/`CANCEL` to discard it. An unfinished draft survives a restart and
expires after 24 hours. If a saved contact name is missing or ambiguous, reply
with the exact saved name or a full phone number.

Any explicitly owner-only command can be entered in the “You” chat once the
linked account’s number is in `OWNER_JIDS`. Fresh messages only are accepted:
the dispatcher ignores the bot’s sent-message echoes and replayed history.
Public commands remain unavailable in the self-chat.

A `.remind` requires a receiving contact/number for that request. It is sent
from the paired WhatsApp Business account to that destination; it does not go
to the “You” chat or Telegram, and the recipient does not need to message the
bot first. No message is sent to the recipient before the due time. Delivery
and phone notifications still depend on the Business account being online and
the recipient’s WhatsApp settings.

```text
.agenda today                 # pending sends due today
.agenda week                  # pending sends across the next 7 local calendar days
.agenda missed                # list missed schedules awaiting your choice
.agenda missed send 12        # explicitly send missed job #12 now
.agenda missed skip 12        # skip it; a recurring job advances to its next time
.jobs                         # list pending jobs
.jobs edit 12                 # choose recipient, text, time, or all
.jobs edit 12 all             # change all three fields
.jobs cancel 12               # cancel job #12
```

`.agenda today/week` are read-only local-time views. If a schedule is missed,
`.agenda missed` shows each one separately; choose `send` or `skip` by job ID.
A one-time skip retires that job; for a recurring schedule it advances to the
next future occurrence. Reconnecting also sends the private owner chat an outage
window and a short list of schedules needing a decision. No recipient receives
an advance notice.

`.jobs edit <id>` prompts for recipient, text, time, or all three. The proposed
change is previewed and saved only after `YES`; `NO`/`CANCEL` leaves the queued
job unchanged. Due/missed jobs are not editable through this flow.

## Privacy capture and controller access

The `.antidelete`, `.viewonce`, and `.edits` watchers process events for every
chat the linked WhatsApp device actually receives; `OWNER_JIDS` restricts who
can run commands, not whose messages can be recorded. Check the switches with
`.watch`; enable them with `.watch antidelete on`, `.watch viewonce on`, and
`.watch edits on` if needed.

Capture alerts go to `CAPTURE_ALERT_JID` when set; otherwise they go to the first
configured owner other than the linked number, falling back to the linked
account’s own chat. You can set the destination remotely with
`.env set CAPTURE_ALERT_JID <number>`. WhatsApp/Baileys can only capture edits,
deletions, and view-once media that the linked device receives. A marker-only
view-once event means WhatsApp supplied no media bytes to save; this cannot be
fixed by changing the command whitelist.

Keep the owner whitelist for administrative commands. From the current owner’s
private controller chat, `.env owner add <linked-number>` adds the paired
number without removing the main controller. Once added, owner-only commands
also work in the linked account’s fresh “You” chat. `.env owner list` shows the
current allowlist.

## Ask AI about selected one-to-one chats

`.ask chats` lists private chats with text currently cached by the linked
session. The numbered selection lasts 30 minutes; you can also select one
cached direct chat by phone number (`03…` Pakistani format is accepted). Ask
about one or more chats with:

```text
.ask 2 40 What should I reply?
.ask 03001234567 40 What should I reply?
.ask 2 all Summarize our chat
.ask 2,4 50 Compare what we discussed
.ask 2 after 2026-10-01 What did we decide?
.ask 2 after 2026-10-01 to 2026-10-07 | Summarize that period
.ask 2 on 2026-10-07 What did we discuss that day?
.ask 2 to 2026-10-07 Summarize everything up to that date
.ask 2 40 --redact phones,emails | What should I reply?
.ask 2 40 --phrase "private phrase" | Summarize
```

The count applies to each selected chat. `all` or a date-filtered query uses
up to the cached text within the configured context-size limit; media bytes are
not included. Dates must be `YYYY-MM-DD` in `SCHEDULE_TIMEZONE` (normally
`Asia/Karachi`). Date endpoints are inclusive: `after DATE` starts at local
midnight on that date, `after DATE to DATE` selects the inclusive range,
`on DATE` selects one calendar day, and `to DATE` includes cached messages through
that local date. History starts when this device receives messages, so it is
not a guaranteed export of messages from before pairing or while the bot was
offline. Each `.ask` request sends only the selected text/date range to the
configured AI provider for that request; it does not store the transcript in AI
chat memory and never sends a reply to the other person. Optional
`--redact phones,emails` and `--phrase "text to hide"` rules run locally on both the
transcript and question before the provider call. The phrase form requires `|`
before the question. Group selection is intentionally deferred for a separate
design discussion.

## Read cached messages privately

Use either spelling in the owner's private controller chat or the linked
account’s “You” chat:

```text
.receive 03001234567 5  # latest 5 cached messages from one direct chat
.recieve 03001234567 5  # accepted spelling alias
.receive unread         # chats WhatsApp currently reports as unread
.receive unread 25      # cap cached text previews at 25 entries
.receive 03001234567 5 --text-only
```

The report stays in the private control chat. A direct phone/contact lookup
identifies message kinds (text, voice note, view-once, photo, video, document,
location, contact, and other cached types); locally available media may be
attached, up to five files per request and 16 MB per file. In `unread` mode WhatsApp provides only a
**chat-level** count, not the IDs of individual unread messages: the command
reports that count and labels cached text only as an unverified recent preview.
It does not attach media in that mode. Unknown counts are not treated as unread,
and cache recency alone is never used as evidence. The receiver does not call
`readMessages`/`markRead` or message the source chat. No blue-tick behavior is
guaranteed without live WhatsApp testing.

## Change approved settings from WhatsApp

Use the owner’s private controller chat (or the linked account’s “You” chat
once it is on the owner list):

```text
.env status
.env set AI_PROVIDER groq
.env set GROQ_API_KEY
```

After the last command, send the API key as the **next plain-text message** in
the same private chat, within two minutes. The key is written with owner-only
file permissions, is not echoed or placed in the bot’s message/AI-context cache,
and becomes active without a restart. `.env status` never prints secret values.
Only approved AI settings, capture-alert destination, and owner numbers can be
changed; this command cannot edit arbitrary environment variables or touch the
WhatsApp session directory. WhatsApp itself still keeps the key message in the
chat history, so delete it locally after the confirmation if you want it removed
from that chat on your phone.

## Day to day

```sh
nexus status     # running? linked? memory? battery?
nexus logs       # follow the log (Ctrl-C stops watching, not the bot)
nexus restart
nexus stop
nexus pair       # reprint the pairing code
nexus pair --new 923001234567   # switch the bot to another WhatsApp number
```

### Switching to another WhatsApp number

`nexus pair --new <number>` does the whole move in one step:

1. Stops the bot.
2. Moves the current session and database into `~/.nexus-wa` (renamed, not deleted).
   Scheduled jobs from the old account go with the database, so they cannot fire from the new one.
3. Points `.env` at a fresh session, makes the new number the owner, and uses a separate remote-vault file so the old backup is not restored.
4. Starts the bot in `observe` mode and prints the pairing code.

Then link the account on its phone (Settings → Linked devices → Link a device → Link with phone number). Add `--yes` to skip the confirmation prompt.

Rollback: `nexus stop`, restore the `.env.bak-*` copy it saved, and move the `auth-old-*` folder back to `~/.nexus-wa/auth`.

After the phone update below, reinstall the command once: `install -m 755 ~/nexus-wa/deploy/termux/nexus $PREFIX/bin/nexus`.

`nexus status` reports memory deliberately: Android kills the largest process
first, so it is worth knowing. Expect roughly **80 MB**.

Logs rotate automatically at 5 MB — Termux has no logrotate and a runaway log
would fill the phone.

If the bot crashes, the supervisor restarts it with a growing delay (5s, 10s, …
capped at 60s) so a crash-loop cannot hammer WhatsApp's servers.

---

## Updating

```sh
cd ~/nexus-wa && git pull --ff-only && npm ci --omit=optional --no-audit --fund=false && nexus restart
```

Your database, session and notes live in `~/.nexus-wa`, outside the repo, so an
update never touches them. `npm ci` uses the committed lockfile without rewriting
it, which keeps future Git updates clean.

If `git pull` reports a local `package-lock.json` change, preserve it in a stash
before retrying; do not reset or discard it blindly:

```sh
cd ~/nexus-wa && git stash push -m "before Nexus-WA update" -- package-lock.json && git pull --ff-only && npm ci --omit=optional --no-audit --fund=false && nexus restart
```

The stash keeps the old lockfile change for review. Do not `stash pop` it over
the updated lockfile unless you specifically need that local change.

After this version is installed, the owner can also manage the Termux bot from
WhatsApp's private controller chat or the linked account's “You” chat:

```text
.update check   # see whether the configured GitHub branch is ahead
.update         # fast-forward, install dependencies, and restart
.restart        # restart only
```

These controls require the standard `~/nexus-wa` install running under
`nexus start`. Updates refuse a dirty or diverged/local-ahead Git branch rather
than resetting or overwriting it. A successful update restarts only after
`npm ci` completes; the WhatsApp session, database, and notes remain in
`~/.nexus-wa`. The existing `.env` and linked session are kept; the update does not re-pair WhatsApp.

---

## Backup

You do not *need* the remote vault here — a real disk means a restart costs you
nothing. But a phone can be lost or stolen, and unlike a server it is not in a
datacentre.

To keep an off-site copy, set the `REMOTE_VAULT_*` variables in `.env` exactly as
described in `DEPLOY.md`, then check it with:

```
.vault test
```

That does a real push-then-pull and tells you which setting is wrong if it fails.

---

## What has and has not been verified

**Verified on this machine:** the `nexus` control script end to end — start,
`status` reporting the real bot PID and memory, crash-restart by the supervisor
(a killed bot came back under a new PID), clean stop leaving zero processes, and
safe double-stop. The previous supervisor smoke test booted with
`ready · 34 command(s) · 5 session(s)`. The current no-connection dry-run
registry, including `.agenda`, selected-chat `.ask`, `.env`, and Termux controls,
reports 40 commands across 17 plugin files.

**Not verified:** Termux itself. This sandbox is Linux, not Android, so
`pkg install`, `termux-wake-lock`, `Termux:Boot` autostart, and Android's
process-killing behaviour could not be executed here. The scripts are written to
standard Termux conventions and every command that may be missing is guarded
with a fallback and a warning, but expect to read the output of `setup.sh`
rather than assume it all worked.
