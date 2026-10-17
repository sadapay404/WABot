import test from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppConnection, livenessAction, SILENCE_MS, CONNECT_STALL_MS } from '../src/core/whatsapp.js';
import { createLogger } from '../src/core/logger.js';

const quiet = createLogger('fatal');
const cfg = { wa: { sessionDir: '/tmp/nexus-liveness-unused' }, telegram: { enabled: false } };
const NOW = 1_000_000_000_000;

test('a healthy open link with recent frames is left alone', () => {
  assert.equal(livenessAction({ state: 'open', now: NOW, lastFrameAt: NOW - 30_000, stateSince: NOW - 999_999 }), null);
});

test('an open link silent past SILENCE_MS is recycled', () => {
  const v = livenessAction({ state: 'open', now: NOW, lastFrameAt: NOW - SILENCE_MS - 1, stateSince: NOW - 9e6 });
  assert.equal(v.action, 'reconnect');
  assert.match(v.reason, /no traffic/);
});

test('a connect attempt stalled past CONNECT_STALL_MS is recycled, unless awaiting a link', () => {
  const stalled = { state: 'connecting', now: NOW, lastFrameAt: 0, stateSince: NOW - CONNECT_STALL_MS - 1 };
  assert.equal(livenessAction(stalled).action, 'reconnect');
  assert.equal(livenessAction({ ...stalled, awaitingLink: true }), null);
});

test('a closed state with nothing pending gets a reconnect scheduled', () => {
  assert.equal(livenessAction({ state: 'closed', now: NOW, lastFrameAt: 0, stateSince: NOW }).action, 'schedule');
  assert.equal(livenessAction({ state: 'closed', now: NOW, lastFrameAt: 0, stateSince: NOW, reconnectPending: true }), null);
});

test('forceReconnect runs connect once, even when called twice', async () => {
  const conn = new WhatsAppConnection({ config: cfg, logger: quiet });
  let calls = 0;
  conn.connect = async () => { calls++; return null; };
  conn.forceReconnect('test one');
  assert.equal(conn.reconnectTimer?.hasRef?.(), true,
    'a reconnect timer must keep Node alive after a socket closes');
  conn.forceReconnect('test two');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1);
  await conn.stop();
});

test('a socket that was replaced is ended and never reconnects by itself', async () => {
  const conn = new WhatsAppConnection({ config: cfg, logger: quiet });
  let calls = 0;
  conn.connect = async () => { calls++; return null; };
  let ended = 0;
  conn.socket = { end: () => { ended++; } };
  conn.forceReconnect('stall');
  assert.equal(ended, 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1);
  await conn.stop();
});

test('a failed reconnect schedules another attempt, but a fatal one halts', async () => {
  const conn = new WhatsAppConnection({ config: cfg, logger: quiet });
  let calls = 0;
  conn.connect = async () => { calls++; throw new Error('boom'); };
  conn.forceReconnect('retry test');
  // The retry waits out a jittered backoff (3–6s), so poll rather than sleep a fixed time.
  for (let i = 0; i < 160 && calls < 2; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls >= 2, `expected a retry, saw ${calls} call(s)`);
  await conn.stop();

  const fatal = new WhatsAppConnection({ config: cfg, logger: quiet });
  let fcalls = 0;
  fatal.connect = async () => { fcalls++; const e = new Error('config'); e.fatal = true; throw e; };
  fatal.forceReconnect('fatal test');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fatal.halted, true);
  assert.equal(fcalls, 1);
  await fatal.stop();
});
