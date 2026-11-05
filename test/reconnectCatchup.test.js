import test from 'node:test';
import assert from 'node:assert/strict';

import { getMemoryDb, getSetting } from '../src/database/index.js';
import { createLogger } from '../src/core/logger.js';
import { Scheduler } from '../src/core/scheduler.js';
import {
  ReconnectCatchup,
  RECOVERY_MIN_OUTAGE_MS,
} from '../src/core/reconnectCatchup.js';

const quiet = createLogger('fatal');
const SELF = '15550009999@s.whatsapp.net';
const OWNER = '15550001111@s.whatsapp.net';
const pause = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

function socketRig() {
  const sent = [];
  return {
    sent,
    async sendMessage(jid, content) { sent.push({ jid, content }); },
  };
}

function rig(policy = {}) {
  const dbPromise = getMemoryDb();
  return dbPromise.then((db) => {
    const socket = socketRig();
    const scheduler = new Scheduler({ db, socket, logger: quiet });
    const config = {
      scheduler: { timezone: 'Asia/Karachi' },
      safety: { ownerJids: [OWNER], captureAlertJid: '' },
    };
    const catchup = new ReconnectCatchup({
      db, scheduler, socket, config, selfJid: SELF, logger: quiet,
      stableOpenMs: 5,
      minOutageMs: 0,
      cooldownMs: 0,
      ...policy,
    });
    return { db, socket, scheduler, catchup };
  });
}

test('reconnect catch-up waits for a stable open, then reports newly missed schedules once', async () => {
  const { socket, scheduler, catchup } = await rig();

  assert.equal(await catchup.onOpen({}, 1_000), false, 'first-ever open has no previous outage');
  catchup.onClose({ reason: 503 }, 2_000);
  const job = scheduler.add({ jid: OWNER, text: 'review after reconnect', runAt: 3_000 });

  const pending = await catchup.onOpen({}, 10_000);
  assert.equal(pending.pending, true);
  assert.equal(socket.sent.length, 0, 'a new handshake is not yet a recovery report');
  await pause();

  assert.equal(scheduler.get(job.id).status, 'missed');
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].jid, OWNER, 'catch-up is private to the configured owner');
  assert.match(socket.sent[0].content.text, /Outage window/);
  assert.match(socket.sent[0].content.text, /Schedules needing your decision: 1/);
  assert.match(socket.sent[0].content.text, /\.agenda missed send/);
  assert.equal(await catchup.onOpen({}, 11_000), false, 'duplicate open does not duplicate the report');
});

test('short non-actionable flaps are suppressed and a close cancels the stable timer', async () => {
  const { socket, catchup } = await rig({ minOutageMs: RECOVERY_MIN_OUTAGE_MS, stableOpenMs: 8 });
  catchup.onClose({}, 1_000);
  await catchup.onOpen({}, 2_000);
  catchup.onClose({}, 2_001); // flap before the stable window ends
  await pause(20);
  assert.equal(socket.sent.length, 0, 'a fleeting open cannot notify the owner');

  await catchup.onOpen({}, 3_000);
  await pause(20);
  assert.equal(socket.sent.length, 0, 'a short outage with no actionable job stays silent');
});

test('boot does not reinterpret long healthy uptime as an outage', async () => {
  const { db, socket, catchup } = await rig();
  // An old release stored only the last successful open. It is intentionally
  // not enough evidence to send a recovery report after a process restart.
  await catchup.onOpen({}, 5_000);
  const afterRestart = new ReconnectCatchup({
    db,
    scheduler: { markMissedDue() {}, missed: () => [] },
    socket,
    config: { scheduler: { timezone: 'Asia/Karachi' }, safety: { ownerJids: [OWNER] } },
    selfJid: SELF,
    logger: quiet,
    stableOpenMs: 0,
    minOutageMs: 0,
    cooldownMs: 0,
  });
  afterRestart.noteBoot(15_000);
  assert.equal(await afterRestart.onOpen({}, 20_000), false);
  assert.equal(socket.sent.length, 0);
  assert.equal(getSetting(db, 'connection.outageStartAt', '0'), '0');
});

test('failed report keeps the newer outage state instead of overwriting it', async () => {
  const { db, socket, catchup } = await rig({ stableOpenMs: 0 });
  socket.sendMessage = async () => {
    catchup.onClose({}, 3_000);
    throw new Error('offline again');
  };
  catchup.onClose({}, 1_000);
  await catchup.onOpen({}, 2_000);
  await pause();
  assert.equal(getSetting(db, 'connection.outageStartAt', '0'), '3000');
});
