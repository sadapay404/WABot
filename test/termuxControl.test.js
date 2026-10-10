import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import termuxPlugin from '../src/plugins/termux.js';
import { TermuxControl } from '../src/core/termuxControl.js';

const quietLogger = {
  child() { return this; },
  warn() {},
  error() {},
};

function makeInstall(t, { prefix = '/data/data/com.termux/files/usr', pid = 123 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-termux-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'nexus-wa');
  const appPrefix = path.join(home, 'data', 'data', 'com.termux', 'files', 'usr');
  const nexusPath = path.join(appPrefix, 'bin', 'nexus');
  const dataDir = path.join(home, '.nexus-wa');
  fs.mkdirSync(path.join(root, 'deploy', 'termux'), { recursive: true });
  fs.mkdirSync(path.dirname(nexusPath), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'deploy', 'termux', 'nexus'), '#!/bin/sh\n');
  fs.writeFileSync(nexusPath, '#!/bin/sh\n');
  fs.writeFileSync(path.join(dataDir, 'nexus.pid'), '456\n');
  fs.writeFileSync(path.join(dataDir, 'nexus.bot.pid'), `${pid}\n`);
  return {
    home,
    root,
    pid,
    prefix: prefix === '/data/data/com.termux/files/usr' ? appPrefix : prefix,
    appPrefix,
  };
}

function fakeContext({
  args = [],
  jid = 'owner@s.whatsapp.net',
  selfJid = 'bot@s.whatsapp.net',
  ownerJids = ['owner@s.whatsapp.net'],
  control = {},
} = {}) {
  const replies = [];
  return {
    ctx: {
      args,
      jid,
      sender: 'owner@s.whatsapp.net',
      isOwner: true,
      config: { safety: { ownerJids } },
      bot: { selfJid, termuxControl: control },
      async reply(text) { replies.push(text); },
    },
    replies,
  };
}

function runnerFor({ behind = 0, ahead = 0, dirty = '', afterPull = 'def5678' } = {}) {
  const calls = [];
  let headLookups = 0;
  const run = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    if (command === 'git' && args[0] === 'status') return { stdout: dirty };
    if (command === 'git' && args[0] === 'branch') return { stdout: 'arena/owner-branch\n' };
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return { stdout: 'origin/arena/owner-branch\n' };
    }
    if (command === 'git' && args[0] === 'fetch') return { stdout: '' };
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--short') {
      if (args[2] === 'HEAD') {
        headLookups++;
        return { stdout: `${headLookups === 1 ? 'abc1234' : afterPull}\n` };
      }
      return { stdout: 'def5678\n' };
    }
    if (command === 'git' && args[0] === 'rev-list') {
      return { stdout: `${ahead}\t${behind}\n` };
    }
    return { stdout: '' };
  };
  return { run, calls };
}

function makeControl(t, options = {}) {
  const install = makeInstall(t, options);
  const { run, calls } = options.runner || runnerFor(options);
  const prefix = install.prefix === install.appPrefix
    ? install.appPrefix
    : install.prefix;
  const env = { PREFIX: prefix, PATH: process.env.PATH };
  const control = new TermuxControl({
    root: install.root,
    logger: quietLogger,
    env,
    home: install.home,
    pid: install.pid,
    run,
    hasProcess: () => true,
    schedule: (fn, delay) => {
      const timer = { delay, fire: fn, unref() {} };
      control.scheduledTimer = timer;
      return timer;
    },
    spawnImpl: (file, args, spawnOptions) => {
      const child = new EventEmitter();
      child.unref = () => {};
      control.spawned = { file, args, options: spawnOptions };
      return child;
    },
  });
  return { control, calls, install, env };
}

test('Termux update checks are limited to the supervised standard install', async (t) => {
  const { control, calls, install } = makeControl(t, { behind: 2 });
  const result = await control.check();
  assert.equal(result.ok, true);
  assert.equal(result.branch, 'arena/owner-branch');
  assert.equal(result.current, 'abc1234');
  assert.equal(result.remote, 'def5678');
  assert.equal(result.behind, 2);
  assert.ok(calls.every((call) => call.cwd === install.root));

  const outside = new TermuxControl({
    root: install.root,
    logger: quietLogger,
    env: { PREFIX: '/usr' },
    home: install.home,
    pid: install.pid,
    run: async () => { throw new Error('must not run'); },
  });
  assert.match(outside.availability().reason, /only in the Termux install/);
});

test('update fast-forwards, installs the documented dependencies, and avoids destructive git commands', async (t) => {
  const { control, calls } = makeControl(t, { behind: 2 });
  const result = await control.update();
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(result.current, 'def5678');
  assert.deepEqual(
    calls.find((call) => call.command === 'git' && call.args[0] === 'pull')?.args,
    ['pull', '--ff-only']
  );
  assert.deepEqual(
    calls.find((call) => call.command === 'npm')?.args,
    ['ci', '--omit=optional', '--no-audit', '--fund=false']
  );
  assert.equal(calls.some((call) => ['reset', 'checkout', 'clean'].includes(call.args[0])), false);
});

test('update refuses local changes and local-only commits without pulling', async (t) => {
  const dirty = makeControl(t, { dirty: ' M src/local-change.js\n', behind: 2 });
  const dirtyResult = await dirty.control.update();
  assert.equal(dirtyResult.ok, false);
  assert.match(dirtyResult.reason, /local changes/);
  assert.equal(dirty.calls.some((call) => call.args[0] === 'pull'), false);

  const ahead = makeControl(t, { ahead: 1, behind: 2 });
  const aheadResult = await ahead.control.update();
  assert.equal(aheadResult.ok, false);
  assert.match(aheadResult.reason, /local commits/);
  assert.equal(ahead.calls.some((call) => call.args[0] === 'pull'), false);
});

test('scheduled restart invokes nexus restart, not a direct Node kill', (t) => {
  const { control, install } = makeControl(t);
  const scheduled = control.scheduleRestart(1234);
  assert.equal(scheduled.ok, true);
  assert.equal(control.spawned, undefined);
  assert.equal(control.scheduledTimer.delay, 1234);
  const available = control.availability();
  assert.equal(available.ok, true);
  control.scheduledTimer.fire();
  assert.equal(control.spawned.file, available.nexusPath);
  assert.deepEqual(control.spawned.args, ['restart']);
  assert.equal(control.spawned.options.cwd, install.root);
  assert.equal(control.spawned.options.detached, true);
});

test('WhatsApp update and restart commands require the private owner-control chat', async () => {
  const calls = [];
  const control = {
    async check() { calls.push('check'); return { ok: true, branch: 'main', current: 'a', remote: 'a', ahead: 0, behind: 0 }; },
    async update() { calls.push('update'); return { ok: true, updated: false, branch: 'main', current: 'a', remote: 'a', ahead: 0, behind: 0 }; },
    availability() { return { ok: true }; },
    scheduleRestart() { calls.push('restart'); return { ok: true }; },
  };
  const update = termuxPlugin.commands.find((command) => command.name === 'update');
  const restart = termuxPlugin.commands.find((command) => command.name === 'restart');

  const privateOwner = fakeContext({ args: ['check'], control });
  await update.execute(privateOwner.ctx);
  assert.deepEqual(calls, ['check']);
  assert.match(privateOwner.replies[0], /Already up to date/);

  const otherChat = fakeContext({ args: [], jid: 'someone-else@s.whatsapp.net', control });
  await update.execute(otherChat.ctx);
  assert.deepEqual(calls, ['check']);
  assert.match(otherChat.replies[0], /private controller chat/);

  const restartOwner = fakeContext({ args: [], control });
  await restart.execute(restartOwner.ctx);
  assert.deepEqual(calls, ['check', 'restart']);
  assert.match(restartOwner.replies[0], /Restarting Nexus-WA/);
});
