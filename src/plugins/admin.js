/**
 * Administrative controls. Everything here is owner-only, because every one of
 * these can make the bot send messages, stop sending them, or export your
 * credentials.
 */
export default {
  category: 'admin',
  commands: [
    {
      name: 'panic',
      aliases: ['stop', 'halt'],
      description: 'Stop ALL outbound messages immediately',
      usage: '.panic | .panic resume',
      ownerOnly: true,
      async execute(ctx) {
        const safety = ctx.bot?.safety;
        if (!safety) return ctx.reply('Safety controller is not active in this mode.');

        const arg = (ctx.args[0] || '').toLowerCase();

        if (arg === 'resume' || arg === 'off') {
          safety.resume();
          ctx.bot?.audit?.record({
            action: 'panic-resume',
            actorJid: ctx.sender,
            plugin: 'panic',
          });
          return ctx.reply('▶️ Outbound resumed. Normal rate limits apply.');
        }

        // An unrecognised argument must NOT engage the switch. Halting on a
        // typo means a mistyped command silently stops every reminder.
        if (arg && arg !== 'on') {
          return ctx.reply(
            `Unknown argument \`${ctx.args[0]}\`.\n\n` +
              '• `.panic` — stop all outbound\n' +
              '• `.panic resume` — start again'
          );
        }

        const depth = safety.halt();
        // Let this one confirmation through, or the owner engages the switch
        // and gets silence back — no way to know whether to send `resume`.
        safety.allowOnce();
        ctx.bot?.audit?.record({
          action: 'panic-halt',
          actorJid: ctx.sender,
          plugin: 'panic',
          detail: `${depth} queued message(s) dropped`,
        });
        await ctx.reply(
          `🛑 *Outbound halted.*\n\n` +
            `• ${depth} queued message(s) dropped\n` +
            `• nothing further will be sent\n` +
            `• inbound is still read and logged\n\n` +
            `Send \`.panic resume\` to continue.`
        );
      },
    },
    {
      name: 'audit',
      aliases: ['log'],
      description: 'Show what the bot has done on your behalf',
      usage: '.audit [count]',
      ownerOnly: true,
      async execute(ctx) {
        const audit = ctx.bot?.audit;
        if (!audit) return ctx.reply('Audit log is not active in this mode.');
        const n = Math.min(Number.parseInt(ctx.args[0], 10) || 20, 50);
        await ctx.reply(`📜 *Audit log (${audit.count()} total)*\n\n${audit.text(n)}`);
      },
    },
    {
      name: 'backup',
      aliases: ['export'],
      description: 'Write an encrypted backup of session + database',
      usage: '.backup <passphrase> | .backup list',
      ownerOnly: true,
      async execute(ctx) {
        const backup = ctx.bot?.backup;
        if (!backup) return ctx.reply('Backup is not active in this mode.');

        if (ctx.args[0] === 'list') {
          const rows = backup.list();
          if (!rows.length) return ctx.reply('No backups yet.');
          return ctx.reply(
            ['💾 *Backups*', '', ...rows.map((r) => `\`${r.name}\` · ${r.bytes} bytes`)].join('\n')
          );
        }

        const passphrase = ctx.args[0];
        if (!passphrase) {
          return ctx.reply(
            'usage: `.backup <passphrase>`\n\n' +
              'The passphrase encrypts your WhatsApp identity key with AES-256-GCM.\n' +
              'It is never stored — lose it and the backup is unrecoverable.'
          );
        }

        try {
          const res = backup.create(passphrase);
          ctx.bot?.audit?.record({
            action: 'backup',
            actorJid: ctx.sender,
            plugin: 'backup',
            detail: res.file.split('/').pop(),
          });
          await ctx.reply(
            `💾 Backup written.\n\n• ${res.sessions} session file(s)\n• ${res.bytes} bytes\n• \`${
              res.file.split('/').pop()
            }\`\n\n⚠️ Move it off this host — the disk is ephemeral.`
          );
        } catch (err) {
          await ctx.reply(`⚠️ Backup failed: ${err.message}`);
        }
      },
    },
    {
      name: 'trigger',
      aliases: ['triggers'],
      description: 'Keyword auto-replies (off by default — read the warning)',
      usage: '.trigger list | .trigger on | .trigger add <pattern> => <reply>',
      ownerOnly: true,
      async execute(ctx) {
        const triggers = ctx.bot?.triggers;
        if (!triggers) return ctx.reply('Triggers are not active in this mode.');

        const sub = (ctx.args[0] || 'list').toLowerCase();

        if (sub === 'list') {
          const rows = triggers.list();
          return ctx.reply(
            [
              `🎯 *Triggers* — ${triggers.enabled() ? 'ENABLED' : 'DISABLED'}`,
              '',
              ...(rows.length
                ? rows.map(
                    (t) =>
                      `\`#${t.id}\` ${t.enabled ? '✅' : '⏸'} \`${t.pattern}\` → "${String(t.response).slice(0, 50)}" ` +
                      `(${t.match_count} hits${t.chat_jid ? '' : ', global'})`
                  )
                : ['none defined']),
            ].join('\n')
          );
        }
        if (sub === 'on' || sub === 'off') {
          const on = sub === 'on';
          triggers.setEnabled(on);
          ctx.bot?.audit?.record({ action: `triggers-${sub}`, actorJid: ctx.sender, plugin: 'trigger' });
          return ctx.reply(
            on
              ? '🎯 Triggers ENABLED — the bot will now reply to strangers unprompted. `.trigger off` to stop.'
              : '🎯 Triggers disabled.'
          );
        }
        if (sub === 'del') {
          return ctx.reply(triggers.remove(Number.parseInt(ctx.args[1], 10)) ? 'Deleted.' : 'Not found.');
        }
        if (sub === 'add') {
          const rest = ctx.args.slice(1).join(' ');
          const [pattern, response] = rest.split('=>').map((s) => s.trim());
          if (!pattern || !response) return ctx.reply('usage: `.trigger add <pattern> => <reply>`');
          const row = triggers.add({ pattern, response, chatJid: ctx.isGroup ? ctx.jid : null });
          return ctx.reply(
            `🎯 Trigger \`#${row.id}\` added${ctx.isGroup ? ' (this group only)' : ' (global, DMs only)'}.\n` +
              (triggers.enabled() ? '' : '_Triggers are currently disabled — `.trigger on`._')
          );
        }
        return ctx.reply('usage: .trigger list | on | off | add <pattern> => <reply> | del <id>');
      },
    },
    {
      name: 'webhook',
      aliases: ['hooks'],
      description: 'POST events to a URL you control',
      usage: '.webhook list | .webhook add <url> [events]',
      ownerOnly: true,
      async execute(ctx) {
        const hooks = ctx.bot?.webhooks;
        if (!hooks) return ctx.reply('Webhooks are not active in this mode.');

        const sub = (ctx.args[0] || 'list').toLowerCase();

        if (sub === 'list') {
          const rows = hooks.list();
          return ctx.reply(
            ['🔗 *Webhooks*', '', ...(rows.length ? rows.map((h) => `\`#${h.id}\` ${h.enabled ? '✅' : '⏸'} ${h.url} [${h.events}] last=${h.last_status ?? '-'}`) : ['none'])].join('\n')
          );
        }
        if (sub === 'add') {
          const url = ctx.args[1];
          const events = ctx.args[2] || '*';
          if (!url) return ctx.reply('usage: `.webhook add <url> [event,event]`');
          try {
            const row = hooks.add({ url, events });
            return ctx.reply(`🔗 Webhook \`#${row.id}\` added for \`${events}\`.`);
          } catch (err) {
            return ctx.reply(`⚠️ ${err.message}`);
          }
        }
        if (sub === 'del') {
          return ctx.reply(hooks.remove(Number.parseInt(ctx.args[1], 10)) ? 'Removed.' : 'Not found.');
        }
        return ctx.reply('usage: .webhook list | add <url> [events] | del <id>');
      },
    },
  ],
};
