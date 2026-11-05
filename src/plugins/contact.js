import { resolveRecipient } from '../core/scheduleWizard.js';
import { jidToPhone } from '../core/jid.js';

const MAX_CHOICES = 8;

function usage() {
  return [
    '*Private contact names*',
    '`.contact set 03001234567 | Ayesha Khan` — save your own persistent label',
    '`.contact set Ayesha Khan | Aunt Ayesha` — rename an exact saved contact',
    '`.contact list` — list owner/synced contact labels',
    '`.contact remove 03001234567` — remove only your owner-entered label',
    'Saved labels override WhatsApp profile/push names in alerts and reports. Use `|` before a multiword new name.',
  ].join('\n');
}

function directAddress(value) {
  const text = String(value || '').trim();
  return text.includes('@') || /^\+?[\d(). -]+$/.test(text);
}

function parseSet(text) {
  const raw = String(text || '').trim();
  const pipe = raw.indexOf('|');
  if (pipe >= 0) {
    return { target: raw.slice(0, pipe).trim(), name: raw.slice(pipe + 1).trim() };
  }
  const [target, ...name] = raw.split(/\s+/);
  // An unambiguous short form is useful for a number/JID. Names on both sides
  // must use the pipe, otherwise their word boundary cannot be known safely.
  return directAddress(target) ? { target, name: name.join(' ') } : { target: '', name: '' };
}

function choices(query, matches, verb) {
  const rows = matches.slice(0, MAX_CHOICES);
  return [
    `*Saved contact matches for “${query}”*`,
    ...rows.map((match, index) => `${index + 1}. ${match.label}${match.phone ? ` (+${match.phone})` : ''}`),
    `Reply with a number from this list to ${verb}.`,
  ].join('\n');
}

function choose(ctx, result, verb, apply, reply = ctx.reply) {
  const matches = (result.matches || []).slice(0, MAX_CHOICES);
  if (!matches.length) return reply(`No saved contact matches “${result.query}”.`);
  const prompts = ctx.bot?.prompts;
  if (!prompts) return reply(`${choices(result.query, matches, verb)}\n\nRun the command again with an exact name or phone number.`);

  const waitForChoice = async ({ text, reply: nextReply }) => {
    const selected = /^\d+$/.test(String(text || '').trim()) ? matches[Number(text) - 1] : null;
    if (!selected) {
      prompts.set(ctx.jid, { kind: 'contact-choice', ownerOnly: true, sender: ctx.sender, onReply: waitForChoice });
      return nextReply(`Reply with a number from 1 to ${matches.length}, or run .contact again with an exact saved name/phone number.`);
    }
    return apply(selected, nextReply);
  };

  prompts.set(ctx.jid, { kind: 'contact-choice', ownerOnly: true, sender: ctx.sender, onReply: waitForChoice });
  return reply(choices(result.query, matches, verb));
}

function labelFor(contacts, row) {
  const profile = contacts.profile(row.jid);
  const phone = profile.phoneE164 || jidToPhone(row.jid);
  return `${row.manual_name ? '★ ' : ''}${row.local_name || profile.name || row.jid}${phone ? ` (+${String(phone).replace(/^\+/, '')})` : ''}`;
}

export default {
  name: 'contact',
  aliases: ['contacts'],
  category: 'privacy',
  description: 'Assign persistent owner contact names for alerts and commands',
  usage: '.contact set <number|exact name> | <your name> | .contact list | .contact remove <number|exact name>',
  ownerOnly: true,
  async execute(ctx) {
    const contacts = ctx.bot?.contacts;
    if (!contacts) return ctx.reply('Contact storage is not active in this mode.');
    const subcommand = String(ctx.args?.[0] || '').toLowerCase();

    if (!subcommand || ['help', '?'].includes(subcommand)) return ctx.reply(usage());

    if (['list', 'ls'].includes(subcommand)) {
      const query = ctx.args.slice(1).join(' ').trim().toLocaleLowerCase();
      const seen = new Set();
      const rows = contacts.named()
        .filter((row) => {
          const key = `${row.jid}:${row.local_name || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return !query || String(row.local_name || '').toLocaleLowerCase().includes(query);
        })
        .slice(0, 100);
      if (!rows.length) return ctx.reply(query ? `No saved contact labels match “${query}”.` : 'No synced or owner-named contacts are cached yet.');
      const more = contacts.named().length > rows.length ? '\n_Showing the first 100 contacts; use `.contact list <name>` to filter._' : '';
      return ctx.reply(['*Contacts*', '_★ = your persistent name (used before WhatsApp profile/push names)_', '', ...rows.map((row, index) => `${index + 1}. ${labelFor(contacts, row)}`), more].filter(Boolean).join('\n'));
    }

    if (['set', 'name', 'rename'].includes(subcommand)) {
      const { target, name } = parseSet(ctx.args.slice(1).join(' '));
      if (!target || !name) return ctx.reply(usage());
      let recipient = resolveRecipient(target, contacts);
      const apply = (selected, reply) => {
        try {
          const saved = contacts.setManualName(selected.jid, name);
          const phone = contacts.profile(saved.jid).phoneE164 || jidToPhone(saved.jid);
          return reply(`✅ Saved *${saved.name}*${phone ? ` for +${String(phone).replace(/^\+/, '')}` : ''}. This name now overrides WhatsApp profile/push names.`);
        } catch (error) {
          return reply(`Could not save that name: ${error.message}`);
        }
      };
      if (recipient.status === 'ambiguous') return choose(ctx, recipient, 'save this name', apply);
      if (recipient.status !== 'resolved') return ctx.reply('Enter a complete WhatsApp number/JID or an exact saved contact name.');
      return apply(recipient, ctx.reply);
    }

    if (['remove', 'rm', 'delete', 'unset'].includes(subcommand)) {
      const target = ctx.args.slice(1).join(' ').trim();
      if (!target) return ctx.reply(usage());
      const recipient = resolveRecipient(target, contacts);
      const apply = (selected, reply) => {
        const removed = contacts.clearManualName(selected.jid);
        return reply(removed ? '🗑️ Removed your persistent contact name. WhatsApp/synced labels may still be shown.' : 'That contact has no persistent owner name to remove.');
      };
      if (recipient.status === 'ambiguous') return choose(ctx, recipient, 'remove the persistent name', apply);
      if (recipient.status !== 'resolved') return ctx.reply('Enter a complete WhatsApp number/JID or an exact saved contact name.');
      return apply(recipient, ctx.reply);
    }

    return ctx.reply(usage());
  },
};
