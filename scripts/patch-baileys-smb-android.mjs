#!/usr/bin/env node
/**
 * Nexus-WA's opt-in WhatsApp Business companion patch for Baileys 7.0.0-rc14.
 *
 * This is deliberately narrow: it does not change Baileys' behavior unless
 * WA_COMPANION_PROFILE=smb_android is selected at runtime. It adds only the
 * protocol fields needed by that mode, and refuses unknown Baileys versions or
 * source layouts instead of silently installing a partial patch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BAILEYS = path.join(ROOT, 'node_modules/@whiskeysockets/baileys');
const EXPECTED_VERSION = '7.0.0-rc14';

if (!fs.existsSync(path.join(BAILEYS, 'package.json'))) {
  console.log('[nexus] Baileys not installed; skipping Business companion patch.');
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(path.join(BAILEYS, 'package.json'), 'utf8'));
if (pkg.version !== EXPECTED_VERSION) {
  throw new Error(
    `[nexus] SMB_ANDROID patch expects Baileys ${EXPECTED_VERSION}; found ${pkg.version}. ` +
      'Review the upstream source before changing the pinned dependency.'
  );
}

function patch(relativePath, marker, before, after, label) {
  const file = path.join(BAILEYS, relativePath);
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(marker)) return;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`[nexus] Could not apply Baileys SMB_ANDROID patch: ${label} source changed.`);
  }
  fs.writeFileSync(file, source.slice(0, first) + after + source.slice(first + before.length));
  console.log(`[nexus] Applied Baileys SMB_ANDROID patch: ${label}`);
}

patch(
  'lib/Utils/validate-connection.js',
  "config.nexusCompanionProfile === 'smb_android'\n            ? proto.ClientPayload.UserAgent.Platform.SMB_ANDROID",
  `        platform: config.browser[1].toLocaleLowerCase().includes('android')
            ? proto.ClientPayload.UserAgent.Platform.ANDROID
            : proto.ClientPayload.UserAgent.Platform.WEB,`,
  `        platform: config.nexusCompanionProfile === 'smb_android'
            ? proto.ClientPayload.UserAgent.Platform.SMB_ANDROID
            : config.browser[1].toLocaleLowerCase().includes('android')
                ? proto.ClientPayload.UserAgent.Platform.ANDROID
                : proto.ClientPayload.UserAgent.Platform.WEB,`,
  'SMB_ANDROID UserAgent'
);

patch(
  'lib/Utils/validate-connection.js',
  "config.nexusCompanionProfile === 'smb_android' || !config.browser[1].toLocaleLowerCase().includes('android')",
  `    if (!config.browser[1].toLocaleLowerCase().includes('android')) {
        payload.webInfo = getWebInfo(config);
    }`,
  `    if (config.nexusCompanionProfile === 'smb_android' || !config.browser[1].toLocaleLowerCase().includes('android')) {
        payload.webInfo = getWebInfo(config);
    }`,
  'webInfo on SMB_ANDROID'
);

patch(
  'lib/Utils/companion-reg-client-utils.js',
  "browserName.toLocaleLowerCase() === 'android'",
  `export const getCompanionWebClientType = ([os, browserName]) => {
    if (browserName === 'Desktop') {
        return os === 'Windows' ? CompanionWebClientType.UWP : CompanionWebClientType.ELECTRON;
    }
    return BROWSER_TO_COMPANION_WEB_CLIENT[browserName] || CompanionWebClientType.OTHER_WEB_CLIENT;
};`,
  `export const getCompanionWebClientType = ([os, browserName]) => {
    if (browserName.toLocaleLowerCase() === 'android') {
        // WhatsApp's web pairing handshake requires CHROME as the companion ID;
        // ANDROID_PHONE is the DeviceProps type, not a web companion ID.
        return CompanionWebClientType.CHROME;
    }
    if (browserName === 'Desktop') {
        return os === 'Windows' ? CompanionWebClientType.UWP : CompanionWebClientType.ELECTRON;
    }
    return BROWSER_TO_COMPANION_WEB_CLIENT[browserName] || CompanionWebClientType.OTHER_WEB_CLIENT;
};`,
  'Android companion ID'
);

patch(
  'lib/Socket/socket.js',
  'config.nexusCompanionPlatformDisplay ||',
  '                            content: `${browser[1]} (${browser[0]})`',
  `                            content: config.nexusCompanionProfile === 'smb_android'
                                ? (config.nexusCompanionPlatformDisplay || 'Chrome (Ubuntu)')
                                : browser[1] + ' (' + browser[0] + ')'`,
  'validated Business pairing display'
);
