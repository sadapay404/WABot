import { isUserJid, jidToPhone, normalizeJid, phoneToJid } from './jid.js';

/**
 * Public AI is intentionally fixed in source for this personal deployment.
 * These caps prevent one busy group member from turning the linked account into
 * an unlimited public relay. They do not depend on .env and are not remotely
 * editable.
 */
export const PUBLIC_AI_POLICY = Object.freeze({
  senderCooldownSec: 20,
  dailyLimit: 100,
  perSenderDailyLimit: 10,
});

/** Mild replies for a deliberately blocked AI request. */
export const BLOCKED_AI_REPLIES = Object.freeze([
  '🤖 Nice try. The AI is taking a coffee break from this number.',
  '🤖 This number is on the AI bench today.',
  '🤖 Plot twist: this command is not available for this number.',
  '🤖 The robot checked the list. This number did not make the guest list.',
  '🤖 That AI door is politely locked for this number.',
  '🤖 The calculator is innocent, but the AI is not accepting this request.',
  '🤖 A bold command. Sadly, this number is on the no-AI list.',
  '🤖 The bot has seen your request and dramatically declined it.',
  '🤖 This number has been promoted to spectator mode for AI commands.',
  '🤖 The AI has filed this request under “not today.”',
]);

const quotaStates = new WeakMap();
const fallbackQuotaConfig = {};

function quotaState(config) {
  const key = config && typeof config === 'object' ? config : fallbackQuotaConfig;
  const day = new Date().toISOString().slice(0, 10);
  let state = quotaStates.get(key);
  if (!state || state.day !== day) {
    state = { day, owner: 0, public: 0, publicBySender: new Map(), lastAskAt: new Map() };
    quotaStates.set(key, state);
  }
  return state;
}

/** Convert a human phone number or WhatsApp user JID into a stable user JID. */
export function aiUserJid(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const jid = normalizeJid(raw.includes('@') ? raw : phoneToJid(raw));
  return isUserJid(jid) ? jid : '';
}

export function isAiBlocked(db, value) {
  if (!db) return false;
  const candidates = (Array.isArray(value) ? value : [value]).map(aiUserJid).filter(Boolean);
  return candidates.some((jid) => Boolean(db.prepare('SELECT 1 FROM ai_blocklist WHERE jid = ? LIMIT 1').get(jid)));
}

export function addAiBlock(db, value, actorJid = '') {
  const jid = aiUserJid(value);
  if (!db || !jid) throw new Error('use a complete WhatsApp phone number or user JID');
  const result = db
    .prepare('INSERT OR IGNORE INTO ai_blocklist(jid, created_at, created_by) VALUES (?, ?, ?)')
    .run(jid, Date.now(), normalizeJid(actorJid));
  return { jid, changed: Number(result.changes || 0) > 0 };
}

export function removeAiBlock(db, value) {
  const jid = aiUserJid(value);
  if (!db || !jid) throw new Error('use a complete WhatsApp phone number or user JID');
  const result = db.prepare('DELETE FROM ai_blocklist WHERE jid = ?').run(jid);
  return { jid, changed: Number(result.changes || 0) > 0 };
}

export function listAiBlocks(db, limit = 100) {
  if (!db) return [];
  return db
    .prepare('SELECT jid, created_at FROM ai_blocklist ORDER BY created_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(Number(limit) || 100, 500)));
}

export function displayAiUser(jid) {
  const phone = jidToPhone(jid);
  return phone ? `+${phone}` : normalizeJid(jid);
}

/**
 * Guests can use public AI only in live mode. This policy is source-controlled:
 * it deliberately ignores obsolete PUBLIC_AI_* .env entries.
 */
export function publicAiAllowed(ctx) {
  return Boolean(ctx?.isOwner || ctx?.config?.isLive);
}

/**
 * Charge an AI provider request to the correct daily allowance. Linked-main
 * outgoing commands deliberately use the owner allowance because they are a
 * deliberate account action, not anonymous public traffic.
 */
export function takeAiQuota(ctx) {
  const state = quotaState(ctx?.config);
  const ai = ctx?.config?.ai || {};

  if (ctx?.isOwner || ctx?.isSelfIssued) {
    const cap = ai.dailyLimit ?? 200;
    if (state.owner >= cap) {
      return { allowed: false, notice: `🤖 Owner AI daily limit reached (${cap}). It resets at midnight UTC.` };
    }
    state.owner += 1;
    return { allowed: true };
  }

  const sender = String(ctx?.sender || ctx?.jid || '');
  const now = Date.now();
  const cooldownMs = PUBLIC_AI_POLICY.senderCooldownSec * 1_000;
  if ((state.lastAskAt.get(sender) || 0) + cooldownMs > now) return { allowed: false };

  const senderUsed = state.publicBySender.get(sender) || 0;
  if (state.public >= PUBLIC_AI_POLICY.dailyLimit || senderUsed >= PUBLIC_AI_POLICY.perSenderDailyLimit) {
    return { allowed: false };
  }

  state.lastAskAt.set(sender, now);
  state.public += 1;
  state.publicBySender.set(sender, senderUsed + 1);
  return { allowed: true };
}

/**
 * Authorise one provider-backed AI request. Local calculation deliberately
 * does not call this, so it remains available even to a blocked participant.
 */
export async function authorizeAiRequest(ctx, { publicRequest = true } = {}) {
  if (publicRequest && !publicAiAllowed(ctx)) return { allowed: false };
  if (!ctx?.isOwner && isAiBlocked(ctx?.db, [ctx?.sender, ctx?.msg?.senderAlt])) {
    const reply = BLOCKED_AI_REPLIES[Math.floor(Math.random() * BLOCKED_AI_REPLIES.length)];
    await ctx.reply(reply);
    return { allowed: false, blocked: true };
  }

  const quota = takeAiQuota(ctx);
  if (!quota.allowed && quota.notice) await ctx.reply(quota.notice);
  return quota;
}

export default {
  PUBLIC_AI_POLICY,
  BLOCKED_AI_REPLIES,
  aiUserJid,
  isAiBlocked,
  addAiBlock,
  removeAiBlock,
  listAiBlocks,
  displayAiUser,
  publicAiAllowed,
  takeAiQuota,
  authorizeAiRequest,
};
