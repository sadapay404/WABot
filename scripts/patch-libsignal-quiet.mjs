#!/usr/bin/env node
/**
 * libsignal 6.0.0 writes Signal-session diagnostics straight to console.
 * Some of those diagnostics serialize full SessionEntry objects containing
 * ratchet/private-key material; the rest can repeat hundreds of times during
 * a server-side session recovery. Baileys already reports a concise redacted
 * failure through Nexus' logger, so suppress only these direct diagnostics.
 *
 * The patch is deliberately pinned, narrow and idempotent. It refuses unknown
 * libsignal source layouts instead of silently leaving secret-bearing logs on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBSIGNAL = path.join(ROOT, 'node_modules', 'libsignal');
const EXPECTED_VERSION = '6.0.0';
const MARKER = 'Nexus-WA: Signal session diagnostics intentionally suppressed';

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

function suppress(relativePath, before, label, legacy = []) {
  const target = path.join(LIBSIGNAL, relativePath);
  let source = fs.readFileSync(target, 'utf8');
  const after = `        // ${MARKER}: ${label}.`;
  if (source.includes(after)) return false;

  const first = source.indexOf(before);
  if (first < 0) {
    // The preceding archive shipped a smaller privacy patch. Treat each of
    // its known replacements as already-safe so updating an existing install
    // can still add the newly discovered old-session/decrypt suppressions.
    if (legacy.some((entry) => source.includes(entry))) return false;
    throw new Error(`[nexus] Could not apply session-log privacy patch: ${label} source changed.`);
  }
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`[nexus] Could not apply session-log privacy patch: ${label} source changed.`);
  }
  source = source.slice(0, first) + after + source.slice(first + before.length);
  fs.writeFileSync(target, source);
  return true;
}

const changed = [
  // These two original calls printed entire SessionEntry instances, including
  // Signal ratchet/private-key data, to process stdout.
  suppress(
    'src/session_record.js',
    '            console.warn("Session already closed", session);',
    'already-closed session details',
    ['            console.warn("Session already closed");']
  ),
  suppress(
    'src/session_record.js',
    '        console.info("Closing session:", session);',
    'close-session details',
    ['Nexus-WA: Signal session details intentionally suppressed']
  ),
  suppress(
    'src/session_record.js',
    '        console.info("Opening session:", session);',
    'open-session details',
    ['Nexus-WA: Signal session details intentionally suppressed']
  ),
  suppress(
    'src/session_record.js',
    '                console.info("Removing old closed session:", oldestSession);',
    'old-session details'
  ),
  // These are non-secret but extremely noisy during a normal Signal recovery.
  // The surrounding Baileys error remains visible through the redacting logger.
  suppress(
    'src/session_builder.js',
    '            console.warn("Closing open session in favor of incoming prekey bundle");',
    'incoming-prekey recovery diagnostic'
  ),
  suppress(
    'src/session_cipher.js',
    '        console.error("Failed to decrypt message with any known session...");',
    'failed-decrypt diagnostic'
  ),
  suppress(
    'src/session_cipher.js',
    '            console.error("Session error:" + e, e.stack);',
    'per-session decrypt diagnostic'
  ),
  suppress(
    'src/session_cipher.js',
    '                console.warn("Decrypted message with closed session.");',
    'closed-session decrypt diagnostic'
  ),
].filter(Boolean).length;

console.log(
  changed
    ? `[nexus] Applied ${changed} libsignal session-log privacy patch(es).`
    : '[nexus] libsignal session-log privacy patch already applied.'
);
