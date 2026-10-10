/**
 * Nexus-WA — message normaliser.
 *
 * THE most important file for making dry-run preview trustworthy.
 *
 * Raw Baileys messages are a discriminated union with ~30 possible shapes
 * (conversation, extendedTextMessage, imageMessage, buttonsResponseMessage…).
 * Both the REAL socket (core/whatsapp.js) and the FAKE socket
 * (core/mockSocket.js) hand their raw messages to this one function.
 *
 * Consequence: when a command works in dry-run, the text extraction, group
 * detection, quoted-reply handling and ownership check have executed the
 * exact same lines of code they will in production. Only the network
 * transport differs.
 */

/** Keys Baileys may use for the message payload, in priority order. */
const MESSAGE_KEYS = [
  'conversation',
  'extendedTextMessage',
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
  'contactMessage',
  'locationMessage',
  'buttonsResponseMessage',
  'listResponseMessage',
  'templateButtonReplyMessage',
  'reactionMessage',
  'protocolMessage',
];

const MEDIA_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
];

/**
 * WhatsApp wraps several message kinds in an outer envelope before they reach
 * us. Reading only the top level silently yields an empty message for:
 *
 *   viewOnceMessage / viewOnceMessageV2 / viewOnceMessageV2Extension
 *       → view-once photos, videos and voice notes
 *   ephemeralMessage
 *       → ANY message in a disappearing-messages chat (very common)
 *   documentWithCaptionMessage
 *   editedMessage, associatedChildMessage, groupStatusMessage(V2)
 *
 * Baileys' own `extractMessageContent` unwraps these; this is the equivalent
 * for our normaliser, and it also reports WHICH wrapper was present, because
 * "this was view-once" is itself the interesting signal.
 */
const ENVELOPE_KEYS = [
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'ephemeralMessage',
  'documentWithCaptionMessage',
  'editedMessage',
  'associatedChildMessage',
  'groupStatusMessage',
  'groupStatusMessageV2',
];

const VIEW_ONCE_KEYS = new Set([
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
]);

/**
 * Peel envelope layers off a Baileys message payload.
 * @returns {{inner:object, flags:{viewOnce:boolean, ephemeral:boolean, edited:boolean}, wrappers:string[]}}
 */
export function unwrap(message) {
  let inner = message || {};
  const wrappers = [];
  const flags = { viewOnce: false, ephemeral: false, edited: false };

  // Guard the loop: a malformed payload could otherwise cycle.
  for (let depth = 0; depth < 5; depth++) {
    const key = ENVELOPE_KEYS.find((k) => inner?.[k]?.message);
    if (!key) break;
    wrappers.push(key);
    if (VIEW_ONCE_KEYS.has(key)) flags.viewOnce = true;
    if (key === 'ephemeralMessage') flags.ephemeral = true;
    if (key === 'editedMessage') flags.edited = true;
    inner = inner[key].message;
  }

  return { inner, flags, wrappers };
}

/**
 * Pull the human text out of any Baileys message payload.
 * @param {object} message - the `msg.message` object
 * @returns {string}
 */
export function extractText(message) {
  if (!message) return '';
  const { inner } = unwrap(message);
  if (!inner) return '';

  if (typeof inner.conversation === 'string') return inner.conversation;

  const ext = inner.extendedTextMessage;
  if (ext?.text) return ext.text;

  const btn = inner.buttonsResponseMessage;
  if (btn?.selectedDisplayText) return btn.selectedDisplayText;
  if (btn?.selectedButtonId) return btn.selectedButtonId;

  const list = inner.listResponseMessage;
  if (list?.title) return list.title;

  const tmpl = inner.templateButtonReplyMessage;
  if (tmpl?.selectedDisplayText) return tmpl.selectedDisplayText;

  // Media captions
  for (const key of MEDIA_KEYS) {
    if (inner[key]?.caption) return inner[key].caption;
  }

  const reaction = inner.reactionMessage?.text;
  if (reaction) return `Reaction: ${reaction}`;

  const location = inner.locationMessage || inner.liveLocationMessage;
  if (location) {
    const parts = [];
    if (location.name) parts.push(String(location.name));
    if (location.address) parts.push(String(location.address));
    if (Number.isFinite(location.degreesLatitude) && Number.isFinite(location.degreesLongitude)) {
      parts.push(`${location.degreesLatitude}, ${location.degreesLongitude}`);
    }
    if (parts.length) return `Location: ${parts.join(' — ')}`;
  }

  const contact = inner.contactMessage;
  if (contact?.displayName) return `Contact: ${contact.displayName}`;
  const contacts = inner.contactsArrayMessage?.contacts;
  if (Array.isArray(contacts) && contacts.length) {
    return `Contacts: ${contacts.map((item) => item?.displayName || 'unnamed').join(', ')}`;
  }

  const poll = inner.pollCreationMessageV3 || inner.pollCreationMessage;
  if (poll?.name) {
    const options = (poll.options || []).map((item) => item?.optionName).filter(Boolean);
    return `Poll: ${poll.name}${options.length ? ` (${options.join('; ')})` : ''}`;
  }

  const invite = inner.groupInviteMessage;
  if (invite?.groupName) return `Group invite: ${invite.groupName}`;

  return '';
}

/**
 * Detect the media payload type so plugins can branch on it
 * (.sticker needs an image, .transcribe needs audio…).
 */
export function extractMediaType(message) {
  if (!message) return null;
  const { inner } = unwrap(message);
  if (!inner) return null;

  for (const key of MEDIA_KEYS) {
    if (inner[key]) {
      return {
        type: key.replace('Message', ''),
        key,
        payload: inner[key],
        mimetype: inner[key].mimetype || null,
        seconds: inner[key].seconds ?? null,
      };
    }
  }
  return null;
}

/**
 * Normalise a raw Baileys message object into a flat, plugin-friendly context.
 * @param {object} raw - one element of the `messages` array from messages.upsert
 * @returns {object} NormalisedMessage
 */
export function normalize(raw) {
  const key = raw?.key || {};
  const jid = key.remoteJid || '';
  const message = raw?.message || {};

  const isGroup = jid.endsWith('@g.us');
  // In a group the sender is in key.participant; in a DM it is the remoteJid.
  const sender = key.fromMe
    ? key.remoteJid
    : isGroup
      ? key.participant || jid
      : jid;

  // Context lives on the UNWRAPPED message, so a quoted reply inside a
  // disappearing-messages chat is still visible.
  const { inner, flags, wrappers } = unwrap(message);
  const contextInfo =
    inner?.extendedTextMessage?.contextInfo ||
    inner?.imageMessage?.contextInfo ||
    inner?.videoMessage?.contextInfo ||
    inner?.documentMessage?.contextInfo ||
    null;

  const media = extractMediaType(message);

  return {
    /** Raw Baileys object — kept so plugins can reach anything we didn't map. */
    raw,
    id: key.id || null,
    jid,
    sender,
    isGroup,
    isBot: Boolean(key.fromMe),
    groupName: contextInfo?.groupName || null,
    pushName: raw?.pushName || null,
    text: extractText(message).trim(),
    media,
    /** True from an envelope, a flat media flag, or Baileys' unavailable key marker. */
    viewOnce: Boolean(flags.viewOnce || key.isViewOnce || media?.payload?.viewOnce),
    /** True inside a disappearing-messages chat. */
    ephemeral: flags.ephemeral,
    edited: flags.edited,
    wrappers,
    quoted: contextInfo?.stanzaId
      ? { id: contextInfo.stanzaId, participant: contextInfo.participant || null }
      : null,
    mentions: (contextInfo?.mentionedJid || []).map((m) => String(m).split('@')[0]),
    timestamp: Number(raw?.messageTimestamp || Date.now() / 1000),
  };
}

/**
 * Parse a normalised message into a command invocation.
 * @returns {{isCommand:boolean, command:string|null, args:string[], argsRaw:string}}
 */
export function parseCommand(normalized, prefix = '.') {
  const text = normalized.text || '';
  const empty = { isCommand: false, command: null, args: [], argsRaw: '' };

  if (!text.startsWith(prefix)) return empty;

  const body = text.slice(prefix.length).trim();
  if (!body) return empty;

  const [command, ...rest] = body.split(/\s+/);
  return {
    isCommand: true,
    command: command.toLowerCase(),
    args: rest,
    argsRaw: rest.join(' '),
  };
}

export default { normalize, extractText, extractMediaType, parseCommand };
