import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const COMMAND_REFERENCE = fileURLToPath(new URL('../../commands.md', import.meta.url));

const CATEGORY_LABELS = { ai: 'AI' };

function titleCase(value) {
  const raw = String(value || 'other');
  return CATEGORY_LABELS[raw] || raw.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function visibleCommands(ctx, filter = '') {
  const groups = [];
  for (const [category, commands] of ctx.plugins.listByCategory()) {
    if (filter && category !== filter) continue;
    const available = commands.filter((command) => !command.ownerOnly || ctx.isOwner);
    if (available.length) groups.push([category, available]);
  }
  return groups;
}

function renderMenu(groups, { filter, mode, prefix }) {
  const total = groups.reduce((count, [, commands]) => count + commands.length, 0);
  const heading = filter ? `${titleCase(filter)} commands` : 'Command menu';
  const lines = [
    `🧭 *Nexus ${heading}*`,
    `_${total} available · prefix: ${prefix}_`,
    '',
  ];

  for (const [category, commands] of groups) {
    lines.push(`*${titleCase(category)}*`);
    if (filter) {
      for (const command of commands) {
        lines.push(`• \`${command.usage}\`${command.ownerOnly ? ' 🔒' : ''} — ${command.description}`);
      }
    } else {
      lines.push(commands.map((command) => `\`.${command.name}\``).join('  ·  '));
    }
    lines.push('');
  }

  if (!filter) lines.push(`_Use ${prefix}help <category> for syntax and details._`);
  lines.push('_The complete commands.md reference is attached in reply to this menu._');
  lines.push(`_mode: ${String(mode || 'unknown').toUpperCase()}_`);
  return lines.join('\n');
}

async function attachReference(ctx, menu) {
  if (!menu?.key || typeof ctx.send !== 'function') return;
  try {
    await ctx.send(
      ctx.jid,
      {
        document: fs.readFileSync(COMMAND_REFERENCE),
        fileName: 'commands.md',
        mimetype: 'text/markdown',
        caption: 'Nexus-WA command reference',
      },
      { quoted: menu, nexusSkipTyping: true }
    );
  } catch (error) {
    // The menu itself remains useful if a host accidentally omitted the static
    // reference. Do not turn a successful help response into an error loop.
    ctx.logger?.warn?.(`could not attach commands.md: ${error.message}`);
  }
}

export default {
  name: 'help',
  aliases: ['h', 'commands', 'menu'],
  category: 'tools',
  description: 'Show the clean, sorted command menu and reference',
  usage: '.help [category]',
  ownerOnly: false,

  async execute(ctx) {
    const filter = String(ctx.args[0] || '').trim().toLowerCase();
    const groups = visibleCommands(ctx, filter);
    if (!groups.length) {
      return ctx.reply(
        filter
          ? `No commands are available in \`${filter}\`. Use \`${ctx.config.prefix}help\` to view the menu.`
          : 'No commands are available to you.'
      );
    }

    const menu = await ctx.reply(renderMenu(groups, {
      filter,
      mode: ctx.config.mode,
      prefix: ctx.config.prefix,
    }));
    await attachReference(ctx, menu);
  },
};
