# Nexus-WA command quick reference

This is the compact reference for the **43-command** Nexus-WA build. Commands use the `.` prefix shown below. In observe mode, replies are limited to the configured owner; commands that could send a message remain subject to the outbound safety controls.

**Access:** **Owner** means the sender must be a phone-number JID in `OWNER_JIDS`. **Anyone** means the command is not owner-only. Public `.ai` replies are built into live mode; fixed safeguards are described below.

> For complete examples, guided flows, scheduling grammar, privacy limitations, and troubleshooting, see [`docs/COMMANDS.md`](docs/COMMANDS.md).

## All commands

| Command | Aliases | Access | Purpose |
|---|---|---|---|
| `.agenda` | — | Owner | View pending sends or decide missed jobs |
| `.ai` | `.gpt` | Anyone in live mode | Ask AI or analyse one replied-to text/image; the linked main account may use `.ai <n>` context; controller has `-check-` and blocklist controls |
| `.aiprovider` | `.aiorder` | Owner | Show or set AI provider priority (1 = tried first, the rest are fallbacks) |
| `.antidelete` | `.ad`, `.deleted`, `.deletes` | Owner | Toggle deletion capture/alerts and review history |
| `.archive` | `.media` | Owner | List locally archived media |
| `.ask` | — | Owner | Ask about explicitly selected direct-chat history |
| `.audit` | `.log` | Owner | Review bot actions |
| `.backup` | `.export` | Owner | Create an encrypted local backup or list backups |
| `.calc` | `.calculate` | Anyone | Solve safe arithmetic locally; AI handles algebra/word equations and `--process` |
| `.blocked` | `.blockcheck` | Owner | Review suspected blocks (never certain) |
| `.digest` | `.summary`, `.briefing` | Owner | Summarize recent activity |
| `.draft` | `.reply` | Owner | Draft a reply; never sends it |
| `.edits` | `.edited` | Owner | Review edited messages |
| `.env` | — | Owner | Change approved AI settings/owners privately |
| `.forget` | `.reset` | Owner | Clear this chat’s in-memory AI history |
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
| `.update` | `.upgrade` | Owner | Check GitHub and safely fast-forward a Termux or Kerit source deployment |
| `.vault` | `.backup-remote` | Owner | Check/test/push the configured remote vault |
| `.viewonce` | `.vo` | Owner | Control or review view-once capture |
| `.vision` | `.describe`, `.ocr`, `.visual` | Owner | Describe/OCR an attached image |
| `.watch` | `.watchers` | Owner | Show/toggle passive watchers |
| `.webhook` | `.hooks` | Owner | Add/list/remove outbound webhooks |

## Common usage reminders

- Use **`.vision`**, `.describe`, `.ocr`, or **`.visual`** with an image caption. It uses only vision-capable AI models; Groq `openai/gpt-oss-120b` is text-only.
- Use **`.sticker`** as the caption of an attached image; it is not a text-only command. The FFmpeg conversion now uses a portable transparent padding color.
- **`.status`** lists statuses. Use **`.health`** for bot/runtime health.
- In live mode, public `.ai` works in DMs/groups without `PUBLIC_AI_*` or `SELF_AI_COMMANDS` settings. It sends only the question, or exactly one quoted text/caption/image when invoked as a reply; public users cannot request cached history.
- The linked main account may use `.ai <question>` and `.ai <n> <question>` in any direct chat/group. Normal outgoing text remains ignored; replayed commands are deduplicated. The spare controller can use `.ai -blist- <number>` / `.ai -wlist- <number>` privately to manage the persistent AI blocklist.
- `.calc <equation>` evaluates safe arithmetic locally. Algebra, word equations, and `.calc <equation> --process` use the configured AI; its label is `Equation Solved--Calc`.
- On Kerit, set `ALLOW_LIVE_WITHOUT_TELEGRAM=true` only with the spare controller number in `OWNER_JIDS`. Set `NEXUS_HOST=kerit` only for a Git checkout; after `.update`, use the panel **Restart** button.
- Use `.help` or `.help <category>` to see the commands loaded by the running bot.
- In the main-number setup, send owner commands from the configured **spare controller phone** in a direct chat with the main linked number—not from the main account’s self/You chat.
- Do not put secrets, pairing codes, API keys, session files, or raw logs into a chat command.
