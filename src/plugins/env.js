import { jidToPhone, normalizeJid } from '../core/jid.js';

function isControlChat(ctx) {
  const chat = normalizeJid(ctx.jid);
  const self = normalizeJid(ctx.bot?.selfJid);
  const owners = (ctx.config?.safety?.ownerJids || []).map(normalizeJid);
  return Boolean(chat && (chat === self || owners.includes(chat)));
}

function ownerLabel(jid) {
  const phone = jidToPhone(jid);
  return phone ? `+${phone}` : jid;
}

const API_KEYS = new Set(['GROQ_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']);

export default {
  name: 'env',
  category: 'admin',
  description: 'Manage approved AI settings and owner access without exposing secrets',
  usage: '.env status | .env set <setting> <value> | .env set <API_KEY> | .env owner add|remove <number>',
  ownerOnly: true,
  privateOnly: true,
  async execute(ctx) {
    const editor = ctx.bot?.envEditor;
    if (!editor) return ctx.reply('Remote configuration is not active in this mode.');
    if (!isControlChat(ctx)) {
      return ctx.reply('For safety, use `.env` only in your private controller chat or the linked account’s “You” chat.');
    }

    const sub = String(ctx.args[0] || 'status').toLowerCase();
    const rawKey = String(ctx.args[1] || '').toUpperCase();

    if (sub === 'status') {
      return ctx.reply(['*Approved configuration*', '', editor.status(), '', 'Secret values are never displayed.'].join('\n'));
    }

    if (sub === 'owner') {
      const action = String(ctx.args[1] || '').toLowerCase();
      if (action === 'list') {
        const owners = editor.owners();
        return ctx.reply(owners.length
          ? ['*Authorized owners*', '', ...owners.map((jid, index) => `${index + 1}. ${ownerLabel(jid)}`)].join('\n')
          : 'No authorized owners are configured.');
      }
      const number = ctx.args[2];
      if (!number || !['add', 'remove'].includes(action)) {
        return ctx.reply('Usage: `.env owner list` | `.env owner add <WhatsApp number>` | `.env owner remove <WhatsApp number>`');
      }
      try {
        const result = action === 'add' ? editor.addOwner(number) : editor.removeOwner(number);
        return ctx.reply(result.changed
          ? `${action === 'add' ? 'Added' : 'Removed'} ${ownerLabel(result.jid)} ${action === 'add' ? 'as an owner' : 'from owners'}. The change applies immediately.`
          : `${ownerLabel(result.jid)} is already ${action === 'add' ? 'an owner' : 'not an owner'}.`);
      } catch (error) {
        return ctx.reply(`Could not update owners: ${error.message}`);
      }
    }

    if (sub === 'set') {
      const value = ctx.args.slice(2).join(' ').trim();
      if (API_KEYS.has(rawKey)) {
        if (value) {
          return ctx.reply('For safety, do not put an API key in the command. Use `.env set GROQ_API_KEY` and send the key as your next private message instead.');
        }
        const prompt = [
          `*Enter ${rawKey}*`,
          'Send the key as your next plain-text message within 2 minutes. The bot will not cache, log, echo, or show its value.',
          'WhatsApp still retains the message in this chat; delete it locally afterward if you want it removed from your chat history.',
          'Reply `.env cancel` to abort.',
        ].join('\n');
        editor.startSecret({ ownerJid: ctx.sender, chatJid: ctx.jid, key: rawKey, promptText: prompt });
        try {
          const sent = await ctx.reply(prompt);
          editor.setPromptMessageId({ ownerJid: ctx.sender, chatJid: ctx.jid, messageId: sent?.key?.id });
          return sent;
        } catch (error) {
          editor.cancelSecret({ ownerJid: ctx.sender, chatJid: ctx.jid });
          throw error;
        }
      }
      if (!value) {
        return ctx.reply('Usage: `.env set AI_PROVIDER groq` | `.env set AI_MODEL <model-id>` | `.env set AI_MAX_HISTORY 12` | `.env set AI_ASK_MAX_CHARS 60000` | `.env set CAPTURE_ALERT_JID <number>`');
      }
      try {
        const key = editor.setValue(rawKey, value);
        return ctx.reply(`${key} saved. The approved setting applies immediately; no restart is needed.`);
      } catch (error) {
        return ctx.reply(`Could not update ${rawKey || 'setting'}: ${error.message}`);
      }
    }

    if (sub === 'unset') {
      try {
        const key = editor.unsetValue(rawKey);
        return ctx.reply(`${key} cleared or reset. The change applies immediately.`);
      } catch (error) {
        return ctx.reply(`Could not update ${rawKey || 'setting'}: ${error.message}`);
      }
    }

    return ctx.reply([
      '*Remote configuration*',
      '`.env status` — show approved settings; secrets remain hidden.',
      '`.env set AI_PROVIDER groq|openai|gemini`',
      '`.env set GROQ_API_KEY` — then send the key as the next private message.',
      '`.env unset GROQ_API_KEY` — remove a saved key.',
      '`.env owner add <number>` — authorize the linked account or another controller.',
      'Only approved AI and owner settings can be changed; arbitrary environment variables are blocked.',
    ].join('\n'));
  },
};
