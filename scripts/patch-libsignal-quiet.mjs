#!/usr/bin/env node
/**
 * libsignal 6.0.0 logs whole SessionEntry objects with console.info/warn.
 * Those objects contain ratchet and private-key material, so silence only the
 * object-bearing diagnostics. This is intentionally narrow and idempotent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBSIGNAL = path.join(ROOT, 'node_modules', 'libsignal');
const EXPECTED_VERSION = '6.0.0';
const target = path.join(LIBSIGNAL, 'src', 'session_record.js');

if (!fs.existsSync(path.join(LIBSIGNAL, 'package.json'))) {
  console.log('[nexus] libsignal not installed; skipping session-log privacy patch.');
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(path.join(LIBSIGNAL, 'package.json'), 'utf8'));
if (pkg.version !== EXPECTED_VERSION) {
  throw new Error(
    `[nexus] session-log privacy patch expects libsignal ${EXPECTED_VERSION}; found ${pkg.version}. ` +
      'Review the dependency source before changing the pinned version.'
  );
}

let source = fs.readFileSync(target, 'utf8');
const MARKER = 'Nexus-WA: Signal session details intentionally suppressed';
if (source.includes(MARKER)) {
  console.log('[nexus] libsignal session-log privacy patch already applied.');
  process.exit(0);
}

function replaceExactlyOnce(before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`[nexus] Could not apply session-log privacy patch: ${label} source changed.`);
  }
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceExactlyOnce(
  '            console.warn("Session already closed", session);',
  '            console.warn("Session already closed");',
  'already-closed diagnostic'
);
replaceExactlyOnce(
  '        console.info("Closing session:", session);',
  `        // ${MARKER}.`,
  'close-session diagnostic'
);
replaceExactlyOnce(
  '        console.info("Opening session:", session);',
  `        // ${MARKER}.`,
  'open-session diagnostic'
);

fs.writeFileSync(target, source);
console.log('[nexus] Applied libsignal session-log privacy patch.');
