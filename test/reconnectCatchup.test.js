import test from 'node:test';
import assert from 'node:assert/strict';

import { getMemoryDb } from '../src/database/index.js';
import { createLogger } from '../src/core/logger.js';
import { Scheduler } from '../src/core/scheduler.js';
import { ReconnectCatchup } from '../src/core/reconnectCatchup.js';

const quiet = createLogger('fatal');
const SELF = '15550009999@s.whatsapp.net';
const OWNER = '15550001111@s.whatsapp.net';

function socketRig() {
  const sent = [];
  return {
    sent,
    async sendMessage(jid, content) { sent.push({ jid, content }); },
  };
}

test('reconnect catch-up reports the outage and moves elapsed schedules to owner review', async () => {
  const db = await getMemoryDb();
  const socket = socketRig();
  const scheduler = new Scheduler({ db, socket, logger: quiet });
  const config = {
    scheduler: { timezone: 'Asia/Karachi' },
    safety: { ownerJids: [OWNER], captureAlertJid: '' },
  };
  const catchup = new ReconnectCatchup({ db, scheduler, socket, config, selfJid: SELF, logger: quiet });

  assert.equal(await catchup.onOpen({}, 1_000), false, 'first-ever open has no previous outage');
  catchup.onClose({ reason: 503 }, 2_000);
  const job = scheduler.add({ jid: OWNER, text: 'review after reconnect', runAt: 3_000 });

  const result = await catchup.onOpen({}, 10_000);
  assert.equal(result.missed, 1);
  assert.equal(scheduler.get(job.id).status, 'missed');
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].jid, OWNER, 'catch-up is private to the configured owner');
  assert.match(socket.sent[0].content.text, /Outage window/);
  assert.match(socket.sent[0].content.text, /Schedules needing your decision: 1/);
  assert.match(socket.sent[0].content.text, /\.agenda missed send/);
  assert.equal(await catchup.onOpen({}, 11_000), false, 'duplicate open does not duplicate the report');
  assert.equal(socket.sent.length, 1);
});

test('process restart without a close event uses the last successful open as an outage start', async () => {
  const db = await getMemoryDb();
  const socket = socketRig();
  const scheduler = new Scheduler({ db, socket, logger: quiet });
  const config = { scheduler: { timezone: 'Asia/Karachi' }, safety: { ownerJids: [OWNER] } };
  const first = new ReconnectCatchup({ db, scheduler, socket, config, selfJid: SELF, logger: quiet });
  await first.onOpen({}, 5_000);

  const afterRestart = new ReconnectCatchup({ db, scheduler, socket, config, selfJid: SELF, logger: quiet });
  afterRestart.noteBoot(15_000);
  const result = await afterRestart.onOpen({}, 20_000);
  assert.equal(result.start, 5_000);
  assert.equal(result.end, 20_000);
  assert.match(socket.sent.at(-1).content.text, /Outage window/);
});
