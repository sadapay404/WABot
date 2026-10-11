import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseCommand } from './message.js';
import { isUserJid, normalizeJid, phoneToJid } from './jid.js';
import { captureAlertJid } from './alertRouting.js';

const SECRET_KEYS = new Set(['GROQ_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']);
const EDITABLE_KEYS = new Set([
  ...SECRET_KEYS,
  'AI_PROVIDER',
  'AI_MODEL',
  'AI_MAX_HISTORY',
  'AI_ASK_MAX_CHARS',
  'CAPTURE_ALERT_JID',
]);
const SECRET_TTL_MS = 2 * 60 * 1_000;
const MAX_SECRET_LENGTH = 4_096;

function userJid(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const jid = normalizeJid(text.includes('@') ? text : phoneToJid(text));
  return isUserJid(jid) ? jid : '';
}

function encodeEnv(value) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) throw new Error('values must fit on one line');
  return JSON.stringify(text);
}

function matchingEnvLine(line, name) {
  return new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line);
}

export class EnvEditor {
  constructor({ config, logger, selfJid = '', filePath = path.join(config.root, '.env'), now = () => Date.now() }) {
    this.config = config;
    this.logger = logger.child({ scope: 'env-editor' });
    this.selfJid = selfJid;
    this.filePath = filePath;
    this.now = now;
    this.pending = new Map();
  }

  /** Do not write configuration commands or secrets into either message cache. */
  shouldSkipMessage(msg) {
    const parsed = parseCommand(msg, this.config.prefix);
    if (parsed.command === 'env') return true;
    return parsed.command === 'backup' && parsed.args.length > 0 && parsed.args[0] !== 'list';
  }

  startSecret({ ownerJid, chatJid, key, promptText = '' }) {
    const owner = normalizeJid(ownerJid);
    for (const [pendingKey, pending] of this.pending) {
      if (pending.ownerJid === owner) this.pending.delete(pendingKey);
    }
    this.pending.set(this.#pendingKey(ownerJid, chatJid), {
      ownerJid: owner,
      chatJid: normalizeJid(chatJid),
      key,
      promptText: String(promptText),
      promptMessageId: '',
      expiresAt: this.now() + SECRET_TTL_MS,
    });
  }

  setPromptMessageId({ ownerJid, chatJid, messageId }) {
    const key = this.#pendingKey(ownerJid, chatJid);
    const pending = this.pending.get(key);
    if (pending) pending.promptMessageId = String(messageId || '');
  }

  cancelSecret({ ownerJid, chatJid }) {
    return this.pending.delete(this.#pendingKey(ownerJid, chatJid));
  }

  /** Consume the next private message in a pending owner secret-entry flow. */
  async consumePending({ msg, socket, isOwner }) {
    if (!isOwner) return false;
    const owner = normalizeJid(msg.sender);
    const entry = [...this.pending.entries()].find(([, pending]) => pending.ownerJid === owner);
    if (!entry) return false;
    const [key, pending] = entry;
    if (msg?.upsertType && msg.upsertType !== 'notify') {
      // History/replay events cannot satisfy the flow, but must not fall
      // through and persist a plaintext key in ordinary caches either.
      msg.sensitive = true;
      return true;
    }
    const promptEcho = msg?.isBot && (
      (pending.promptMessageId && String(msg.id || '') === pending.promptMessageId) ||
      (pending.promptText && String(msg.text || '').normalize('NFKC').trim() === pending.promptText.normalize('NFKC').trim())
    );
    if (promptEcho) return false;
    if (msg?.isBot && normalizeJid(msg.jid) !== normalizeJid(this.selfJid)) return false;
    this.pending.delete(key);

    if (msg?.isGroup || normalizeJid(msg.jid) !== pending.chatJid) {
      // If the owner sends anything outside the prompted private chat during
      // the secret-entry window, drop it from local caches and cancel the flow.
      msg.sensitive = true;
      await socket.sendMessage(pending.chatJid, { text: 'API-key entry cancelled because the next message was not in the same private chat. No setting changed.' });
      return true;
    }

    if (msg?.media) {
      await socket.sendMessage(msg.jid, { text: 'API-key entry cancelled because a media message was received. No setting changed.' });
      return true;
    }
    if (pending.expiresAt <= this.now()) {
      await socket.sendMessage(msg.jid, { text: 'Secret entry expired. Start again with `.env set GROQ_API_KEY` (or another provider key).' });
      return true;
    }

    const text = String(msg.text || '').trim();
    const parsed = parseCommand(msg, this.config.prefix);
    if (parsed.command === 'env' && /^cancel$/i.test(parsed.args[0] || '')) {
      await socket.sendMessage(msg.jid, { text: 'API-key entry cancelled. No setting changed.' });
      return true;
    }
    if (!text || text.startsWith(this.config.prefix)) {
      await socket.sendMessage(msg.jid, { text: 'API-key entry cancelled because the next message was not a plain key. No setting changed.' });
      return true;
    }
    if (text.length > MAX_SECRET_LENGTH || /[\0\r\n]/.test(text)) {
      await socket.sendMessage(msg.jid, { text: 'That value is too long or contains a line break. No setting changed.' });
      return true;
    }

    try {
      this.#saveValue(pending.key, text);
      this.#applyValue(pending.key, text);
      this.logger.info(`updated ${pending.key} through the owner configuration flow`);
      await socket.sendMessage(msg.jid, {
        text: `${pending.key} saved. It was not added to the bot's message or AI-context cache. WhatsApp still retains your sent message; delete it locally afterward if you do not want it in that chat history.`,
      });
    } catch (error) {
      this.logger.error(`could not update ${pending.key}: ${error.message}`);
      await socket.sendMessage(msg.jid, { text: `Could not save ${pending.key}: ${error.message}. The key itself was not logged.` });
    }
    return true;
  }

  setValue(name, value) {
    const key = String(name || '').trim().toUpperCase();
    if (!EDITABLE_KEYS.has(key)) throw new Error('that setting is not remotely editable');
    if (SECRET_KEYS.has(key)) throw new Error('API keys must be entered as the next message, not inline');
    const normalized = this.#validateValue(key, value);
    this.#saveValue(key, normalized);
    this.#applyValue(key, normalized);
    return key;
  }

  unsetValue(name) {
    const key = String(name || '').trim().toUpperCase();
    if (!EDITABLE_KEYS.has(key)) throw new Error('that setting is not remotely editable');
    if (SECRET_KEYS.has(key)) {
      this.#saveValue(key, '');
      this.#applyValue(key, '');
      return key;
    }
    if (key === 'AI_PROVIDER') {
      this.#saveValue(key, 'groq');
      this.#applyValue(key, 'groq');
      return key;
    }
    this.#removeValue(key);
    this.#applyValue(key, '');
    return key;
  }

  addOwner(value) {
    const jid = userJid(value);
    if (!jid) throw new Error('enter a complete WhatsApp number or user JID');
    const current = this.#normalizedOwners();
    if (current.includes(jid)) return { jid, changed: false };
    const next = [...current, jid];
    this.#saveValue('OWNER_JIDS', next.join(','));
    this.config.safety.ownerJids = next;
    process.env.OWNER_JIDS = next.join(',');
    return { jid, changed: true };
  }

  removeOwner(value) {
    const jid = userJid(value);
    if (!jid) throw new Error('enter a complete WhatsApp number or user JID');
    const current = this.#normalizedOwners();
    const next = current.filter((item) => item !== jid);
    if (next.length === current.length) return { jid, changed: false };
    if (!next.length) throw new Error('at least one owner must remain; the live bot refuses to run without an owner');
    this.#saveValue('OWNER_JIDS', next.join(','));
    this.config.safety.ownerJids = next;
    process.env.OWNER_JIDS = next.join(',');
    return { jid, changed: true };
  }

  owners() {
    return this.#normalizedOwners();
  }

  status() {
    const ai = this.config.ai || {};
    const keys = ['GROQ_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']
      .map((name) => `${name}: ${ai.keys?.[name.toLowerCase().replace('_api_key', '')] ? 'set (hidden)' : 'not set'}`);
    const alert = captureAlertJid(this.config, this.selfJid) || 'linked account self-chat';
    return [
      `AI provider: ${ai.provider || 'groq'}`,
      `AI model: ${ai.model || '(provider default)'}`,
      `AI history window: ${ai.maxHistory || 12}`,
      ...keys,
      `Capture alerts: ${alert}`,
      `Owner numbers: ${this.#normalizedOwners().length}`,
    ].join('\n');
  }

  #validateValue(key, value) {
    const text = String(value ?? '').trim();
    if (!text) throw new Error('enter a non-empty value');
    if (/[\0\r\n]/.test(text)) throw new Error('values must fit on one line');
    if (key === 'AI_PROVIDER') {
      const provider = text.toLowerCase();
      if (!['groq', 'openai', 'gemini', 'openrouter'].includes(provider)) throw new Error('provider must be groq, gemini, openrouter, or openai');
      return provider;
    }
    if (key === 'AI_MODEL') {
      if (text.length > 128 || !/^[a-zA-Z0-9._:/-]+$/.test(text)) throw new Error('model ID contains unsupported characters');
      return text;
    }
    if (key === 'AI_MAX_HISTORY') {
      const number = Number(text);
      if (!Number.isInteger(number) || number < 2 || number > 40) throw new Error('AI_MAX_HISTORY must be an integer from 2 to 40');
      return String(number);
    }
    if (key === 'AI_ASK_MAX_CHARS') {
      const number = Number(text);
      if (!Number.isInteger(number) || number < 4_000 || number > 100_000) throw new Error('AI_ASK_MAX_CHARS must be from 4000 to 100000');
      return String(number);
    }
    if (key === 'CAPTURE_ALERT_JID') {
      const jid = userJid(text);
      if (!jid) throw new Error('use a full WhatsApp user number or JID');
      return jid;
    }
    throw new Error('unsupported setting');
  }

  #applyValue(key, value) {
    if (['GROQ_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'].includes(key)) {
      const provider = key.replace('_API_KEY', '').toLowerCase();
      this.config.ai.keys[provider] = value;
      process.env[key] = value;
    } else if (key === 'AI_PROVIDER') {
      this.config.ai.provider = value || 'groq';
      process.env.AI_PROVIDER = this.config.ai.provider;
    } else if (key === 'AI_MODEL') {
      this.config.ai.model = value;
      process.env.AI_MODEL = value;
    } else if (key === 'AI_MAX_HISTORY') {
      this.config.ai.maxHistory = Number(value) || 12;
      process.env.AI_MAX_HISTORY = value;
    } else if (key === 'AI_ASK_MAX_CHARS') {
      this.config.ai.askMaxChars = Number(value) || 60_000;
      process.env.AI_ASK_MAX_CHARS = value;
    } else if (key === 'CAPTURE_ALERT_JID') {
      this.config.safety.captureAlertJid = value;
      process.env.CAPTURE_ALERT_JID = value;
    }
  }

  #normalizedOwners() {
    return [...new Set((this.config.safety.ownerJids || []).map(userJid).filter(Boolean))];
  }

  #pendingKey(ownerJid, chatJid) {
    return `${normalizeJid(ownerJid)}\u0000${normalizeJid(chatJid)}`;
  }

  #saveValue(name, value) {
    const key = String(name).toUpperCase();
    const old = fs.existsSync(this.filePath) ? fs.readFileSync(this.filePath, 'utf8') : '';
    const lines = old.split(/\r?\n/);
    const matching = [];
    for (let i = 0; i < lines.length; i++) if (matchingEnvLine(lines[i], key)) matching.push(i);
    const replacement = `${key}=${encodeEnv(value)}`;
    if (matching.length) {
      lines[matching[0]] = replacement;
      for (const index of matching.slice(1).reverse()) lines.splice(index, 1);
    } else {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      lines.push(replacement);
    }
    this.#writeAtomic(lines.join('\n').replace(/\n*$/, '\n'));
  }

  #removeValue(name) {
    const key = String(name).toUpperCase();
    if (!fs.existsSync(this.filePath)) return;
    const lines = fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/).filter((line) => !matchingEnvLine(line, key));
    this.#writeAtomic(lines.join('\n').replace(/\n*$/, '\n'));
  }

  #writeAtomic(content) {
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* already renamed */ }
    }
  }
}

export default EnvEditor;
