import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TermuxControl } from '../src/core/termuxControl.js';
import { createLogger } from '../src/core/logger.js';

test('refreshNexusCommand replaces the installed command with the repo copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cmd-'));
  const appDir = path.join(dir, 'nexus-wa');
  const bin = path.join(dir, 'usr', 'bin');
  fs.mkdirSync(path.join(appDir, 'deploy', 'termux'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'deploy', 'termux', 'nexus'), '#!/bin/sh\necho new\n');
  const nexusPath = path.join(bin, 'nexus');
  fs.writeFileSync(nexusPath, '#!/bin/sh\necho old\n');

  const control = new TermuxControl({ root: appDir, logger: createLogger('fatal'), home: dir, pid: 4242 });
  assert.equal(control.refreshNexusCommand({ appDir, nexusPath }), true);
  assert.equal(fs.readFileSync(nexusPath, 'utf8'), '#!/bin/sh\necho new\n');
  assert.ok(fs.statSync(nexusPath).mode & 0o100, 'stays executable');
  assert.deepEqual(fs.readdirSync(bin), ['nexus'], 'no temp file left behind');
});

test('refreshNexusCommand reports failure without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cmd-'));
  const control = new TermuxControl({ root: dir, logger: createLogger('fatal'), home: dir, pid: 1 });
  assert.equal(control.refreshNexusCommand({ appDir: dir, nexusPath: path.join(dir, 'missing', 'nexus') }), false);
});
