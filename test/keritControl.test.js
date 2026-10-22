import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KeritControl } from '../src/core/keritControl.js';
import { HostControl } from '../src/core/hostControl.js';

const quietLogger = { child() { return this; }, warn() {}, error() {} };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-kerit-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

function runner({ behind = 2, ahead = 0, dirty = '' } = {}) {
  const calls = [];
  let headCalls = 0;
  const run = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    if (command === 'git' && args[0] === 'status') return { stdout: dirty };
    if (command === 'git' && args[0] === 'branch') return { stdout: 'main\n' };
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { stdout: 'origin/main\n' };
    if (command === 'git' && args[0] === 'fetch') return { stdout: '' };
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--short') {
      headCalls += 1;
      return { stdout: `${headCalls > 1 ? 'new4567' : 'old1234'}\n` };
    }
    if (command === 'git' && args[0] === 'rev-list') return { stdout: `${ahead}\t${behind}\n` };
    return { stdout: '' };
  };
  return { run, calls };
}

test('Kerit update is explicit, clean-only, and requires a panel restart', async (t) => {
  const root = fixture(t);
  const { run, calls } = runner({ behind: 2 });
  const control = new KeritControl({ root, logger: quietLogger, env: { NEXUS_HOST: 'kerit' }, run });

  assert.equal(control.availability().ok, true);
  const result = await control.update();
  assert.deepEqual(
    { ok: result.ok, updated: result.updated, restartRequired: result.restartRequired, current: result.current, platform: result.platform },
    { ok: true, updated: true, restartRequired: true, current: 'new4567', platform: 'kerit' }
  );
  assert.deepEqual(calls.find((c) => c.command === 'git' && c.args[0] === 'pull')?.args, ['pull', '--ff-only']);
  assert.deepEqual(calls.find((c) => c.command === 'npm')?.args, ['ci', '--omit=optional', '--no-audit', '--fund=false']);
  assert.equal(calls.some((c) => ['reset', 'checkout', 'clean'].includes(c.args[0])), false);
  assert.equal(control.scheduleRestart().ok, false);
  assert.match(control.scheduleRestart().reason, /panel/i);
});

test('Kerit update cannot be activated accidentally and refuses dirty source', async (t) => {
  const root = fixture(t);
  const off = new KeritControl({ root, logger: quietLogger, env: {}, run: async () => { throw new Error('must not run'); } });
  assert.match(off.availability().reason, /NEXUS_HOST=kerit/);

  const { run, calls } = runner({ dirty: ' M src/local.js\n' });
  const dirty = new KeritControl({ root, logger: quietLogger, env: { NEXUS_HOST: 'pterodactyl' }, run });
  const result = await dirty.update();
  assert.equal(result.ok, false);
  assert.match(result.reason, /local changes/i);
  assert.equal(calls.some((c) => c.args[0] === 'pull'), false);
});

test('host control picks the explicitly configured Kerit path', () => {
  const kerit = { availability: () => ({ ok: true, platform: 'kerit' }) };
  const termux = { availability: () => ({ ok: false, reason: 'not Termux' }) };
  const host = new HostControl({ root: '/', logger: quietLogger, termux, kerit });
  assert.deepEqual(host.availability(), { ok: true, platform: 'kerit' });
});
