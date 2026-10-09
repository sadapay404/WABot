# Running Nexus-WA on a phone with Termux

Free forever, no credit card, no account verification. This is the recommended
host: it has a **real filesystem**, so there is no re-pairing and no need for the
GitHub vault, and it connects from your own home IP, which looks normal to
WhatsApp rather than like a datacentre login.

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
| **Scheduled reminders** | **Not lost, but late.** Overdue jobs still match the query `run_at <= now` (`src/core/scheduler.js:142`), so a 9am reminder fires the moment the phone reconnects — once, at whatever time that is. |
| **Recurring jobs** | **Fire once, not in a burst.** The next run is rolled forward past the current time (`scheduler.js:179`), so an hourly job missed four times fires once and reschedules. No drift. |
| **A job interrupted mid-send** | Recovered. `resumeOrphans()` flips anything left `running` back to `pending` at boot. |
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
- Run `npm install --omit=optional --no-audit --fund=false` once after updating;
  the postinstall step applies the pinned Baileys patch.
- Pair the new companion from the Business phone. The old linked device is not
  removed. To roll back, stop the bot, restore the old `WA_SESSION_DIR` and set
  `WA_COMPANION_PROFILE=web`.

This is based on an upstream user's Business-account test, not a live test on
your number. Use a spare test Business account first; linking the additional
companion consumes one linked-device slot. Do not delete the old auth directory
or remove the old linked device unless you later choose to do so.

**Practical advice:** keep the phone at home on a charger when you can. If it
has to travel, expect reminders to land late rather than on time.

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

`.schedule`, `.remind`, and the read-only `.agenda` can be entered in the “You”
chat. The paired Business account’s own number must be in `OWNER_JIDS`; the
dispatcher accepts these owner-authorized commands there only for fresh messages.
It ignores the bot’s own sent-message echoes and replayed history, and does not
open other commands in the self-chat.

A `.remind` requires a receiving contact/number for that request. It is sent
from the paired WhatsApp Business account to that destination; it does not go
to the “You” chat or Telegram, and the recipient does not need to message the
bot first. No message is sent to the recipient before the due time. Delivery
and phone notifications still depend on the Business account being online and
the recipient’s WhatsApp settings.

```text
.agenda today  # pending sends due today
.agenda week   # pending sends across the next 7 local calendar days
.jobs          # list pending jobs
.jobs cancel 12 # cancel job #12
```

`.agenda` is read-only, groups schedules by local date, and shows the next
occurrence of each repeating schedule; overdue pending sends appear first.
`.jobs` remains available and currently displays timestamps in UTC.
One-time jobs that become overdue while the phone is offline are delivered once
when it reconnects. Recurring jobs skip missed intervals rather than sending a
catch-up burst.

## Day to day

```sh
nexus status     # running? linked? memory? battery?
nexus logs       # follow the log (Ctrl-C stops watching, not the bot)
nexus restart
nexus stop
nexus pair       # reprint the pairing code
```

`nexus status` reports memory deliberately: Android kills the largest process
first, so it is worth knowing. Expect roughly **80 MB**.

Logs rotate automatically at 5 MB — Termux has no logrotate and a runaway log
would fill the phone.

If the bot crashes, the supervisor restarts it with a growing delay (5s, 10s, …
capped at 60s) so a crash-loop cannot hammer WhatsApp's servers.

---

## Updating

```sh
cd ~/nexus-wa && git pull --ff-only && npm install --omit=optional --no-audit --fund=false && nexus restart
```

Your database, session and notes live in `~/.nexus-wa`, outside the repo, so an
update never touches them.

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
safe double-stop. The bot itself booted under the supervisor with
`ready · 34 command(s) · 5 session(s)`.

**Not verified:** Termux itself. This sandbox is Linux, not Android, so
`pkg install`, `termux-wake-lock`, `Termux:Boot` autostart, and Android's
process-killing behaviour could not be executed here. The scripts are written to
standard Termux conventions and every command that may be missing is guarded
with a fallback and a warning, but expect to read the output of `setup.sh`
rather than assume it all worked.
