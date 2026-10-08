#!/usr/bin/env node
/**
 * Nexus-WA — entry point.
 *
 * Boot order (deliberately, so a failure at any stage is obvious):
 *   config → logger → database → stores → watchers → plugins → transport
 *   → outbound queue → dispatcher → services → dashboard → Telegram → scheduler
 *
 * Transports:
 *   dry-run  MockWhatsAppSocket   (default — no WhatsApp account touched)
 *   observe  real Baileys, outbound blocked for non-owners
 *   live     real Baileys, full
 */

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

import { buildConfig, validateConfig, MODES } from './config/index.js';
import { createLogger } from './core/logger.js';
import { getDb } from './database/index.js';
import { PluginLoader } from './core/pluginLoader.js';
import { Dispatcher } from './core/dispatcher.js';
import { normalize } from './core/message.js';
import { MockWhatsAppSocket, MOCK_OWNER_JID } from './core/mockSocket.js';
import { SessionRegistry } from './core/sessionRegistry.js';
import { ContactStore } from './core/contactStore.js';
import { MessageCache } from './core/messageCache.js';
import { MediaStore } from './core/mediaStore.js';
import { AntiDelete } from './core/antiDelete.js';
import { ViewOnceCapture } from './core/viewOnce.js';
import { EditWatch } from './core/editWatch.js';
import { ProfileWatch } from './core/profileWatch.js';
import { PresenceLog } from './core/presenceLog.js';
import { GroupWatch } from './core/groupWatch.js';
import { Scheduler } from './core/scheduler.js';
import { Triggers } from './core/triggers.js';
import { Webhooks } from './core/webhooks.js';
import { AuditLog } from './core/audit.js';
import { SessionBackup } from './core/backup.js';
import { RemoteVault } from './core/remoteVault.js';
import { NoteStore } from './core/notes.js';
import { AiClient } from './core/ai.js';
import { OutboundQueue } from './core/outboundQueue.js';
import { LogBuffer } from './core/logBuffer.js';
import { Dashboard } from './web/dashboard.js';
import { normalizeJid } from './core/jid.js';
import { formatUptime } from './lib/format.js';

// ── CLI ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

const overrides = {};
if (has('--dry-run')) overrides.mode = MODES.DRY_RUN;
if (has('--pairing')) overrides.mode = overrides.mode || MODES.OBSERVE;
if (has('--qr')) overrides.mode = overrides.mode || MODES.OBSERVE;
if (valueOf('--pairing')) {
  overrides.mode = MODES.OBSERVE;
  overrides.pairingNumber = valueOf('--pairing');
}

const config = buildConfig(overrides);
const logger = createLogger(config.logLevel, 'nexus');
const logs = new LogBuffer(600).attach();
const startedAt = Date.now();

// ── Banner ───────────────────────────────────────────────────────────
function banner() {
  const bar = '─'.repeat(62);
  const risk = { 0: 'NONE (no WhatsApp connection)', 1: 'LOW (burner only)', 2: 'HIGH' }[config.risk];
  process.stdout.write(
    `\n\x1b[36m┌${bar}┐\x1b[0m\n` +
      `\x1b[36m│\x1b[0m  \x1b[1mNexus-WA\x1b[0m  ·  mode: \x1b[1m${config.mode}\x1b[0m  ·  ban risk: \x1b[33m${risk}\x1b[0m\n` +
      `\x1b[36m└${bar}┘\x1b[0m\n\n`
  );
}

// ── Shared event wiring (identical for mock and real transports) ─────
function wireEvents(socket, app) {
  // The mock is a plain EventEmitter; Baileys emits through `socket.ev`.
  const on = socket.ev ? (e, f) => socket.ev.on(e, f) : (e, f) => socket.on(e, f);
  const { dispatcher, cache, antiDelete, viewOnce, editWatch, registry, contacts, presenceLog, profileWatch, groupWatch, webhooks, logger: log } = app;
  const selfJid = () => (socket.user?.id ? normalizeJid(socket.user.id) : '');

  on('messages.upsert', async ({ messages = [] } = {}) => {
    for (const raw of messages) {
      try {
        // Group membership stubs carry no `message` — handle them first.
        groupWatch?.onMessage(raw);

        const msg = normalize(raw);
        if (selfJid()) registry.countIn(selfJid());

        // View-once FIRST: the media blob is invalidated once the message is
        // seen, so this must run before anything else can touch it.
        const vo = await viewOnce?.onMessage(raw, msg);
        if (vo) webhooks?.emit('viewonce', { from: msg.sender, kind: vo.kind, bytes: vo.mediaBytes });

        antiDelete?.onMessage(raw, msg); // cache — a revoke may follow
        await dispatcher.handle(socket, msg);
      } catch (err) {
        log.error(`messages.upsert handler: ${err.stack || err.message}`);
      }
    }
  });

  // Awaited on purpose: delivery runs through the outbound queue, and a
  // fire-and-forget handler silently drops alerts under load or at shutdown.
  on('messages.update', async (updates = []) => {
    for (const u of updates) {
      try {
        const deleted = await antiDelete?.onUpdate(u);
        if (deleted) webhooks?.emit('delete', { from: deleted.senderJid, kind: deleted.record?.kind });

        const edited = await editWatch?.onUpdate(u);
        if (edited) webhooks?.emit('edit', { from: edited.senderJid });
      } catch (err) {
        log.error(`messages.update handler: ${err.message}`);
      }
    }
  });

  on('contacts.update', (list = []) => {
    try {
      contacts.upsertMany(list);
      for (const c of list) {
        profileWatch?.observe({
          jid: c.id,
          name: c.notify ?? c.name ?? null,
          photo: c.imgUrl ?? null,
        });
      }
    } catch (err) {
      log.error(`contacts.update handler: ${err.message}`);
    }
  });

  on('messaging-history.set', (payload = {}) => {
    try {
      if (payload.contacts?.length) {
        contacts.upsertMany(payload.contacts);
        log.info(`history sync: cached ${payload.contacts.length} contacts`);
      }
    } catch (err) {
      log.error(`history sync handler: ${err.message}`);
    }
  });

  on('presence.update', (payload) => {
    try {
      presenceLog?.onUpdate(payload);
    } catch (err) {
      log.error(`presence.update handler: ${err.message}`);
    }
  });
}

// ── Boot ─────────────────────────────────────────────────────────────
async function main() {
  banner();

  const { problems, warnings } = validateConfig(config);
  for (const w of warnings) logger.warn(w);
  if (problems.length) {
    for (const p of problems) logger.fatal(p);
    process.exit(1);
  }
  logger.info(
    `mode=${config.mode}  prefix="${config.prefix}"  owners=${config.safety.ownerJids.length || '(none)'}  role=${config.wa.role}`
  );

  // ── Remote vault restore ─────────────────────────────────────────
  // This has to happen before getDb() opens the database, and before the
  // transport connects. Overwriting a SQLite file underneath an already-open
  // WAL connection is undefined behaviour: at best the restored rows are
  // ignored because the handle still points at the old inode, at worst the
  // file is corrupted. Restoring the session first is also what lets Baileys
  // resume an existing device instead of starting a fresh pairing.
  const backup = new SessionBackup({
    logger,
    sessionDir: config.wa.sessionDir,
    dbPath: config.db.path,
    dir: config.storage.backupDir,
  });
  const vault = new RemoteVault({
    logger,
    backup,
    cfg: config.vault,
    // A vault that quietly stops backing up is the one failure mode here that
    // turns into a lost session, so it has to be able to shout.
    onAlert: (text) => {
      const jid = socket?.user?.id ? normalizeJid(socket.user.id) : null;
      if (!jid) return logger.warn(`vault alert (no self jid yet): ${text}`);
      socket.sendMessage(jid, { text }).catch((err) =>
        logger.error(`could not deliver a vault alert: ${err.message}`)
      );
    },
  });

  if (!config.isDryRun) {
    const sessionFiles = fs.existsSync(config.wa.sessionDir)
      ? fs.readdirSync(config.wa.sessionDir).filter((f) => f !== '.gitkeep')
      : [];
    if (sessionFiles.length === 0) {
      const restored = await vault.restoreIfEmpty(false);
      if (restored) {
        logger.warn(
          'restored session and database from the remote vault — ' +
            'WhatsApp may ask you to confirm this device'
        );
      }
    } else {
      logger.info(`local session present (${sessionFiles.length} file(s)) — not restoring from the vault`);
    }
  }

  // Storage. Opened only after the vault has had its chance to replace the file.
  const db = await getDb(config, logger);

  // Stores.
  const registry = new SessionRegistry(db, logger);
  const contacts = new ContactStore(db, logger);
  const cache = new MessageCache(db, logger);
  const mediaStore = new MediaStore({ db, logger, dir: config.storage.mediaDir });
  const notes = new NoteStore(db, logger);
  const audit = new AuditLog(db, logger);
  const webhooks = new Webhooks({ db, logger });
  const triggers = new Triggers({ db, logger });
  const presenceLog = new PresenceLog({ db, logger });
  const ai = new AiClient({ config, logger });

  // Plugins.
  const plugins = new PluginLoader({ dir: path.join(config.root, 'src', 'plugins'), logger });
  await plugins.loadAll();

  if (has('--list-plugins')) {
    printPluginList(plugins);
    process.exit(plugins.failures.length ? 1 : 0);
  }

  // Transport.
  let socket;
  let connection = null;
  if (config.isDryRun) {
    socket = new MockWhatsAppSocket({ logger });
    await socket.connect();
  } else {
    const { WhatsAppConnection } = await import('./core/whatsapp.js');
    connection = new WhatsAppConnection({ config, logger, cache });
    socket = await connection.connect();
  }

  // Structural rate limiting, applied to both transports so dry-run pacing
  // matches production. attach() wraps the socket in place and returns it.
  const queue = new OutboundQueue(socket, config, logger);
  queue.attach();

  // Dispatcher.
  const dispatcher = new Dispatcher({
    plugins,
    config,
    logger,
    db,
    bot: {},
    defaultOwnerJid: config.isDryRun ? MOCK_OWNER_JID : null,
  });

  const selfJid = normalizeJid(socket.user?.id || '');

  // Watchers.
  const profileWatch = new ProfileWatch({ db, logger, presenceLog, selfJid });
  const groupWatch = new GroupWatch({ db, contacts, logger });
  const editWatch = new EditWatch({ socket, db, cache, contacts, logger, config });
  const antiDelete = new AntiDelete({
    socket, db, cache, contacts, registry, logger, config,
    selfJid: config.isDryRun ? selfJid : null,
  });
  const viewOnce = new ViewOnceCapture({
    socket, db, cache, contacts, registry, mediaStore, logger, config,
    downloader: config.isDryRun ? (raw) => socket.downloadMediaMessage(raw) : null,
  });
  const scheduler = new Scheduler({
    db, socket, logger, contacts,
    tickMs: config.scheduler.tickMs,
    maxPerTick: config.scheduler.maxPerTick,
  });

  const app = {
    config, logger, db, startedAt,
    registry, contacts, cache, mediaStore, notes, audit, webhooks, triggers,
    presenceLog, profileWatch, groupWatch, editWatch, antiDelete, viewOnce,
    scheduler, ai, backup, vault, plugins, dispatcher, queue, logs, connection,
    selfJid,
    // Kill-switch: the only thing that can stop outbound instantly.
    safety: {
      halt: () => queue.halt(),
      resume: () => queue.resume(),
      halted: () => queue.halted,
      allowOnce: () => queue.allowOnce(),
    },
    dashboard: null,
    dashboardUrl: null,
    shutdown: (why) => shutdown(why),
  };
  dispatcher.bot = app;

  wireEvents(socket, app);

  // Webhook notifications for anything the dispatcher audits.
  const originalAuditRecord = audit.record.bind(audit);
  audit.record = (e) => {
    originalAuditRecord(e);
    webhooks.emit('audit', { action: e.action, plugin: e.plugin });
  };

  // Register the linked number.
  if (!config.isDryRun && selfJid) {
    registry.upsert({ jid: selfJid, pushName: socket.user?.name, role: config.wa.role });
  }

  // Dashboard. Optional — a port conflict must never take the bot down,
  // because the WhatsApp link is the product and this is just a window on it.
  if (config.dashboard.enabled) {
    const dash = new Dashboard({ app, config, logger, port: config.dashboard.port });
    try {
      await dash.listen(config.dashboard.host);
      app.dashboard = dash;
      app.dashboardUrl = dash.url();
      logger.info(`dashboard → ${dash.url()}`);
    } catch (err) {
      logger.error(
        `dashboard unavailable: ${err.message} — continuing without it ` +
          `(set DASHBOARD_PORT to another value, or DASHBOARD_ENABLED=false)`
      );
    }
  }

  // Seed synthetic data so the dashboard is evaluable before any real link.
  if (config.isDryRun && config.dashboard.seedDemo && registry.list().length === 0) {
    const { seedDemoData } = await import('./lib/demoSeed.js');
    const n = seedDemoData({ db, registry, contacts, selfJid });
    logger.info(
      `seeded synthetic demo data (${n.sessions} sessions, ${n.contacts} contacts, ` +
        `${n.deletions} deletions) — dry-run only`
    );
  }

  // Telegram control panel.
  let telegram = null;
  if (config.telegram.enabled) {
    const { TelegramPanel } = await import('./core/telegram.js');
    telegram = new TelegramPanel({ config, logger, app });
    app.telegram = telegram;
    await telegram.start();
    if (connection) {
      connection
        .on('qr', (qr) => telegram.sendQr(qr))
        .on('pairing-code', (code) => telegram.sendPairingCode(code))
        .on('relogin', () =>
          telegram.sendAlert('WhatsApp session invalidated', 'Restart the bot and scan a fresh QR.')
        )
        .on('close', ({ reason, action }) =>
          telegram.sendAlert('WhatsApp disconnected', `code ${reason ?? 'none'} → ${action}`)
        );
    }
  }

  // Scheduler last, so everything it may deliver already exists.
  scheduler.start();
  vault.start();

  logger.info(
    `ready · ${plugins.commands.size} command(s) · ${registry.list().length} session(s) · ` +
      `${scheduler.pending().length} pending job(s) · up ${formatUptime(process.uptime())}\n`
  );

  installShutdownHandlers(app, telegram);

  if (config.isDryRun && !has('--serve')) {
    await runPreviewConsole(socket, dispatcher, plugins, app);
  } else {
    logger.info('running headless — Ctrl-C or SIGTERM to stop');
    setInterval(() => {}, 1 << 30);
  }
}

// ── Graceful shutdown ────────────────────────────────────────────────
let shuttingDown = false;
let appRef = null;

async function shutdown(why = 'signal') {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`shutting down (${why})…`);
  try {
    appRef?.scheduler?.stop();
    // One final push, so a restart does not roll the session back by half an hour.
    await appRef?.vault?.push?.();
    appRef?.vault?.stop?.();
    await appRef?.telegram?.stop?.();
    await appRef?.dashboard?.stop?.();
    await appRef?.connection?.stop?.();
  } catch (err) {
    logger.warn(`shutdown error: ${err.message}`);
  }
  process.exit(0);
}

function installShutdownHandlers(app, telegram) {
  appRef = { ...app, telegram };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => shutdown(sig));
  }
}

// ── Preview console (dry-run only) ───────────────────────────────────
const HELP = `
\x1b[36mYou are talking to the bot as its OWNER, through a fake WhatsApp socket.\x1b[0m
Nothing is sent to Meta. Type bot commands, or these harness commands:

  \x1b[1m/group <msg>\x1b[0m       send <msg> as a stranger inside a simulated group
  \x1b[1m/as <jid> <msg>\x1b[0m    send <msg> as some other WhatsApp user
  \x1b[1m/delete <jid> <text>\x1b[0m   send a message then delete it
  \x1b[1m/edit <jid> <text> | <new text>\x1b[0m  send then rewrite it
  \x1b[1m/viewonce <jid> <caption>\x1b[0m  a view-once image (captured + forwarded)
  \x1b[1m/presence <jid> <state>\x1b[0m     simulate presence
  \x1b[1m/joined <jid>\x1b[0m      simulate someone joining a group
  \x1b[1m/contacts\x1b[0m          add demo address-book names
  \x1b[1m/list\x1b[0m              show the loaded plugins
  \x1b[1m/out\x1b[0m               dump everything the bot "sent"
  \x1b[1m/stats\x1b[0m             all service counters
  \x1b[1m/quit\x1b[0m              exit
`;

function printPluginList(plugins) {
  const rows = plugins.list();
  if (!rows.length) process.stdout.write('  (no plugins loaded)\n');
  for (const p of rows) {
    const gate = p.ownerOnly ? ' \x1b[33m[owner]\x1b[0m' : '';
    const alias = p.aliases.length ? ` \x1b[2m(${p.aliases.join(', ')})\x1b[0m` : '';
    process.stdout.write(`  \x1b[1m${p.usage}\x1b[0m${alias}${gate} — ${p.description}\n`);
  }
  for (const f of plugins.failures) {
    process.stdout.write(`  \x1b[31m✗ ${f.file}: ${f.error}\x1b[0m\n`);
  }
}

async function runPreviewConsole(socket, dispatcher, plugins, app) {
  process.stdout.write(`${HELP}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const isTTY = process.stdin.isTTY;

  // A line queue, not rl.question(): piped input delivers every line and then
  // EOF almost immediately, which races a re-prompt and drops the tail.
  const queueLines = [];
  let waiting = null;
  let eof = false;

  rl.on('line', (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else queueLines.push(line);
  });
  rl.on('close', () => {
    eof = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(null);
    }
  });

  const nextLine = () => {
    if (queueLines.length) return Promise.resolve(queueLines.shift());
    if (eof) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiting = resolve;
    });
  };

  for (;;) {
    if (isTTY) process.stdout.write('\x1b[90myou›\x1b[0m ');
    const line = await nextLine();
    if (line === null) break;

    const input = line.trim();
    if (!input) continue;

    try {
      if (input === '/quit' || input === '/exit') break;
      else if (input === '/list') printPluginList(plugins);
      else if (input === '/out') process.stdout.write(JSON.stringify(socket.outbox, null, 2) + '\n');
      else if (input === '/stats') process.stdout.write(JSON.stringify(allStats(app, dispatcher), null, 2) + '\n');
      else if (input.startsWith('/group ')) await socket.injectGroup(input.slice(7), { pushName: 'Stranger' });
      else if (input.startsWith('/as ')) {
        const [jid, ...rest] = input.slice(4).trim().split(/\s+/);
        if (!jid || !rest.length) process.stdout.write('  usage: /as <jid> <message>\n');
        else await socket.inject(rest.join(' '), { from: jid, pushName: 'Stranger' });
      } else if (input.startsWith('/delete ')) await simulateDeletion(socket, input.slice(8));
      else if (input.startsWith('/edit ')) await simulateEdit(socket, input.slice(6));
      else if (input.startsWith('/viewonce ')) await simulateViewOnce(socket, input.slice(10));
      else if (input.startsWith('/presence ')) {
        const [jid, state] = input.slice(10).trim().split(/\s+/);
        await socket.injectPresence(jid, state || 'available');
      } else if (input.startsWith('/joined ')) {
        await socket.injectGroupEvent('joined', { participants: [input.slice(8).trim()] });
      } else if (input === '/contacts') {
        const demo = [
          { id: '15550001111@s.whatsapp.net', name: 'Me', notify: 'Me' },
          { id: '15550002222@s.whatsapp.net', name: 'Mom', notify: 'Mom ❤️' },
          { id: '15550003333@s.whatsapp.net', name: null, notify: 'Random Guy' },
        ];
        app.contacts.upsertMany(demo);
        process.stdout.write(`  added ${demo.length} demo contacts\n`);
      } else await socket.inject(input, { from: MOCK_OWNER_JID, pushName: 'Owner' });
    } catch (err) {
      logger.error(err.stack || err.message);
    }
  }

  process.stdout.write(
    `\npreview ended · ${socket.outbox.length} message(s) "sent" · 0 real WhatsApp calls\n`
  );
  rl.close();
  await shutdown('preview ended');
}

function allStats(app, dispatcher) {
  return {
    dispatcher: dispatcher.stats,
    antiDelete: app.antiDelete?.stats,
    viewOnce: app.viewOnce?.stats,
    edits: app.editWatch?.stats,
    triggers: app.triggers?.stats,
    scheduler: app.scheduler?.summary(),
    queue: app.queue?.depth(),
    cache: app.cache?.size(),
    media: app.mediaStore?.stats(),
    notes: app.notes?.summary(),
    ai: { provider: app.ai?.provider, configured: app.ai?.configured(), ...app.ai?.stats },
  };
}

// ── Harness simulators ───────────────────────────────────────────────
async function simulateDeletion(socket, spec) {
  const [jid, ...rest] = spec.trim().split(/\s+/);
  const text = rest.join(' ');
  if (!jid || !text) return process.stdout.write('  usage: /delete <jid> <text>\n');
  const sent = await socket.inject(text, { from: jid, pushName: 'Stranger' });
  process.stdout.write(`  injected stanza ${sent.key.id}, now revoking…\n`);
  await socket.injectRevoke(sent.key.id, { from: jid, jid });
}

async function simulateEdit(socket, spec) {
  // Shape: /edit <jid> <old text> | <new text>
  // Split on the pipe FIRST — the old text is free prose and may itself
  // contain spaces, so splitting on whitespace first mis-assigns the JID.
  const [left, ...rightParts] = spec.split('|');
  const right = rightParts.join('|').trim();
  const [jid, ...oldWords] = left.trim().split(/\s+/);
  const before = oldWords.join(' ');

  if (!jid || !before || !right) {
    return process.stdout.write('  usage: /edit <jid> <old text> | <new text>\n');
  }
  const from = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
  const sent = await socket.inject(before, { from, pushName: 'Stranger' });
  process.stdout.write(`  injected stanza ${sent.key.id}, now editing…\n`);
  await socket.injectEdit(sent.key.id, right, { from, jid: from });
}

async function simulateViewOnce(socket, spec) {
  const [jid, ...rest] = spec.trim().split(/\s+/);
  if (!jid) return process.stdout.write('  usage: /viewonce <jid> [caption]\n');
  await socket.inject(rest.join(' ') || '', {
    from: jid,
    pushName: 'Stranger',
    media: { imageMessage: { mimetype: 'image/jpeg', fileLength: 48213 } },
    viewOnce: true,
  });
}

main().catch((err) => {
  logger.fatal(err.stack || err.message);
  process.exit(1);
});
