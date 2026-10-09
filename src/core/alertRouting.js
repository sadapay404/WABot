import { isUserJid, normalizeJid, phoneToJid } from './jid.js';

function asUserJid(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const jid = normalizeJid(text.includes('@') ? text : phoneToJid(text));
  return isUserJid(jid) ? jid : '';
}

/**
 * Where passive privacy-watcher alerts go. Prefer an explicit destination,
 * then the first configured owner other than the linked account, and finally
 * the linked account's own chat. This keeps event capture independent of who
 * sent the original message while making alerts visible to a remote controller.
 */
export function captureAlertJid(config, selfJid) {
  const self = normalizeJid(selfJid);
  const configured = asUserJid(config?.safety?.captureAlertJid);
  if (configured) return configured;

  const owner = (config?.safety?.ownerJids || [])
    .map(asUserJid)
    .find((jid) => jid && jid !== self);
  return owner || self;
}

export default captureAlertJid;
