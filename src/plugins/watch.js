import { timeAgo } from '../lib/format.js';

/**
 * Steering for the passive watchers, plus read-outs of what they have caught.
 * Each watcher is independently switchable, because "capture everything" is a
 * decision you should be able to reverse per-feature.
 */
export default {
  category: 'privacy',
  commands: [
    {
      name: 'watch',
      aliases: ['watchers'],
      description: 'Show or toggle every passive watcher',
      usage: '.watch | .watch <name> on|off',
      ownerOnly: true,
      async execute(ctx) {
        const b = ctx.bot || {};
        const table = [
          ['viewonce', b.viewOnce, 'view-once capture'],
          ['antidelete', b.antiDelete, 'deleted messages'],
          ['edits', b.editWatch, 'edited messages'],
          ['profiles', b.profileWatch, 'profile / block watch'],
          ['presence', b.presenceLog, 'last-seen log'],
          ['groups', b.groupWatch, 'group join/leave'],
          ['triggers', b.triggers, 'keyword auto-replies'],
          ['scheduler', b.scheduler, 'scheduled jobs'],
        ].filter(([, svc]) => svc && typeof svc.enabled === 'function');

        const name = (ctx.args[0] || '').toLowerCase();
        if (name) {
          const hit = table.find(([n]) => n === name);
          if (!hit) return ctx.reply(`Unknown watcher. Options: ${table.map(([n]) => n).join(', ')}`);
          const want = (ctx.args[1] || '').toLowerCase();
          if (want !== 'on' && want !== 'off') {
            return ctx.reply(`\`${name}\` is currently ${hit[1].enabled() ? 'ON' : 'OFF'}.`);
          }
          hit[1].setEnabled(want === 'on');
          ctx.bot?.audit?.record({
            action: `watch-${name}-${want}`,
            actorJid: ctx.sender,
            plugin: 'watch',
          });
          return ctx.reply(`${want === 'on' ? '✅' : '⏸'} ${hit[2]} → ${want.toUpperCase()}`);
        }

        const lines = ['👁️ *Watchers*', ''];
        for (const [n, svc, label] of table) {
          lines.push(`${svc.enabled() ? '✅' : '⏸'} \`${n}\` — ${label}`);
        }
        lines.push('', '_Toggle with `.watch <name> on|off`_');
        await ctx.reply(lines.join('\n'));
      },
    },
    {
      name: 'viewonce',
      aliases: ['vo'],
      description: 'List captured view-once messages',
      usage: '.viewonce [count] | .viewonce on|off',
      ownerOnly: true,
      async execute(ctx) {
        const vo = ctx.bot?.viewOnce;
        if (!vo) return ctx.reply('View-once capture is not active in this mode.');

        const arg = (ctx.args[0] || '').toLowerCase();
        if (arg === 'on' || arg === 'off') {
          vo.setEnabled(arg === 'on');
          return ctx.reply(`👁️ View-once capture → ${arg.toUpperCase()}`);
        }

        const rows = vo.recent(Math.min(Number.parseInt(arg, 10) || 10, 30));
        const s = vo.stats;
        if (!rows.length) {
          return ctx.reply(
            `👁️ Nothing captured yet.\n\n_detected ${s.detected} · captured ${s.captured} · ` +
              `expired ${s.expired} · unavailable ${s.unavailable || 0}_`
          );
        }

        const lines = [
          `👁️ *View-once (${rows.length})*`,
          '',
          ...rows.map((r) => {
            const when = timeAgo(r.captured_at);
            const size = r.media_bytes
              ? ` · ${Math.round(r.media_bytes / 1024)} KB`
              : ' · no media bytes';
            const state = r.forwarded ? '✅' : '⚠️';
            return `${state} *${r.sender_name || r.sender_phone || 'unknown'}* ${when} — ${r.kind}${size}` +
              (r.caption ? `\n  > ${String(r.caption).slice(0, 90)}` : '');
          }),
        ];
        await ctx.reply(lines.join('\n'));
      },
    },
    {
      name: 'edits',
      aliases: ['edited'],
      description: 'List messages that were edited after sending',
      usage: '.edits [count]',
      ownerOnly: true,
      async execute(ctx) {
        const ew = ctx.bot?.editWatch;
        if (!ew) return ctx.reply('Edit watch is not active in this mode.');

        const rows = ew.recent(Math.min(Number.parseInt(ctx.args[0], 10) || 10, 30));
        if (!rows.length) return ctx.reply('✏️ No edits recorded yet.');

        const lines = ['✏️ *Edited messages*', ''];
        for (const r of rows) {
          const was = r.before_text === null ? '_(not captured)_' : `"${String(r.before_text).slice(0, 70)}"`;
          lines.push(
            `• *${r.sender_name || 'unknown'}* ${timeAgo(r.edited_at)}\n  was ${was}\n  now "${String(r.after_text || '').slice(0, 70)}"`
          );
        }
        await ctx.reply(lines.join('\n'));
      },
    },
    {
      name: 'presence',
      aliases: ['lastseen', 'online'],
      description: 'Who was online and when they were last seen',
      usage: '.presence [count]',
      ownerOnly: true,
      async execute(ctx) {
        const pl = ctx.bot?.presenceLog;
        if (!pl) return ctx.reply('Presence logging is not active in this mode.');

        const rows = pl.recent(Math.min(Number.parseInt(ctx.args[0], 10) || 15, 40));
        if (!rows.length) return ctx.reply('No presence recorded yet.');

        const lines = ['🟢 *Presence*', ''];
        for (const r of rows) {
          const name = ctx.bot?.contacts?.displayName(r.jid).name || r.jid;
          const dot = r.state === 'available' ? '🟢' : r.state === 'composing' ? '✍️' : '⚪';
          lines.push(`${dot} *${name}* — ${r.state}${r.last_seen ? ` · last seen ${timeAgo(r.last_seen)}` : ''}`);
        }
        await ctx.reply(lines.join('\n'));
      },
    },
    {
      name: 'blocked',
      aliases: ['blockcheck'],
      description: 'Suspected blocks, with the signals behind each guess',
      usage: '.blocked | .blocked <jid>',
      ownerOnly: true,
      async execute(ctx) {
        const pw = ctx.bot?.profileWatch;
        if (!pw) return ctx.reply('Profile watch is not active in this mode.');

        if (ctx.args[0]) {
          const r = pw.suspectBlocked(ctx.args[0]);
          const name = ctx.bot?.contacts?.displayName(ctx.args[0]).name || ctx.args[0];
          if (!r.suspected) {
            return ctx.reply(`✅ No strong signals for *${name}*.\n\nSignals seen: ${r.signals.length ? r.signals.join(', ') : 'none'}`);
          }
          return ctx.reply(
            `⚠️ *${name}* — suspected block (${r.score} signals):\n` +
              r.signals.map((s) => `  • ${s}`).join('\n') +
              '\n\n_This is inference, not fact. WhatsApp does not report blocks._'
          );
        }

        const suspects = pw.suspects();
        if (!suspects.length) return ctx.reply('⚠️ No suspected blocks recorded.');

        const lines = ['⚠️ *Suspected blocks*', ''];
        for (const jid of suspects) {
          const r = pw.suspectBlocked(jid);
          const name = ctx.bot?.contacts?.displayName(jid).name || jid;
          lines.push(`• *${name}* (${r.score}) — ${r.signals.join(', ')}`);
        }
        lines.push('', '_Inference from photo/presence/name signals. WhatsApp does not report blocks._');
        await ctx.reply(lines.join('\n'));
      },
    },
    {
      name: 'groups',
      aliases: ['grouplog'],
      description: 'Recent group membership changes',
      usage: '.groups [count]',
      ownerOnly: true,
      async execute(ctx) {
        const gw = ctx.bot?.groupWatch;
        if (!gw) return ctx.reply('Group watch is not active in this mode.');

        const rows = gw.recent(Math.min(Number.parseInt(ctx.args[0], 10) || 15, 40));
        if (!rows.length) return ctx.reply('👥 No group events recorded yet.');

        const lines = ['👥 *Group activity*', ''];
        for (const r of rows) {
          const who = (r.detail || '')
            .split(',')
            .filter(Boolean)
            .map((j) => ctx.bot?.contacts?.displayName(j).name || j)
            .join(', ');
          lines.push(`• *${r.group_name || 'group'}* — ${who || 'someone'} ${r.kind} · ${timeAgo(r.ts)}`);
        }
        await ctx.reply(lines.join('\n'));
      },
    },
  ],
};
