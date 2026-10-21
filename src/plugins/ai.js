/**
 * AI commands. All share one orchestrator (core/ai.js); the difference is only
 * what context each one feeds it.
 *
 * If no API key is configured every command says so plainly. A bot that
 * silently pretends to be an AI is worse than one that admits it has no key.
 */

import { AiNotConfigured, AiError } from '../core/ai.js';
import { jidToPhone } from '../core/jid.js';
import { extractMediaType, extractQuotedRaw, extractText } from '../core/message.js';
import {
  addAiBlock,
  authorizeAiRequest,
  displayAiUser,
  listAiBlocks,
  removeAiBlock,
} from '../core/aiAccess.js';
import { setEnvValue } from '../core/envFile.js';
import { downloadWhatsAppMedia } from '../core/mediaDownloader.js';

const SYSTEM_BASE =
  'You are Nexus-WA, a concise personal assistant running inside WhatsApp. ' +
  'Replies are read on a phone: keep them short, use plain text, avoid markdown ' +
  'headings, and never pad. If you do not know, say so.';

/** Current caption media, or the one explicitly quoted by a text command. */
function mediaSource(ctx, expectedType) {
  if (ctx.msg?.media?.type === expectedType) return { raw: ctx.msg.raw, media: ctx.msg.media };
  const quoted = extractQuotedRaw(ctx.msg?.raw);
  const media = quoted ? extractMediaType(quoted.message) : null;
  return media?.type === expectedType ? { raw: quoted, media } : null;
}

async function run(ctx, build) {
  const ai = ctx.bot?.ai;
  if (!ai) return ctx.reply('The AI orchestrator is not active in this mode.');
  try {
    const result = await build(ai);
    await ctx.reply(result);
  } catch (err) {
    if (err instanceof AiNotConfigured) {
      return ctx.reply(`🤖 _Not configured._\n\n${err.message}\n\nSet it in \`.env\`, then restart.`);
    }
    if (err instanceof AiError) return ctx.reply(`⚠️ AI error: ${err.message}`);
    throw err;
  }
}


const PROVIDER_NAMES = ['groq', 'gemini', 'openrouter', 'openai'];
const MAX_CONTEXT = 50;
const MAX_QUOTED_TEXT = 8_000;

/** `.ai 5 what did he say` -> { count: 5, question }. A bare number is a usage error. */
function parseAiArgs(args) {
  const list = [...args];
  let count = 0;
  if (list.length && /^\d{1,3}$/.test(list[0])) {
    count = Number(list.shift());
    if (count < 1 || count > MAX_CONTEXT) {
      return { error: `Context must be between 1 and ${MAX_CONTEXT} messages.` };
    }
  }
  return { count, question: list.join(' ').trim() };
}

function transcript(rows, contacts) {
  return rows
    .map((row) => {
      let who = 'Me';
      if (!row.from_me) {
        const name = contacts?.displayName?.(row.sender_jid);
        const phone = jidToPhone(row.sender_jid || '');
        who = name?.source && name.source !== 'jid' && name.name ? name.name : phone ? `+${phone}` : 'Other';
      }
      return `${who}: ${row.text}`;
    })
    .join('\n');
}

function renderProviders(ctx) {
  const cfg = ctx.config?.ai || {};
  const keys = cfg.keys || {};
  const sorted = [...(cfg.providers || [])].sort((a, b) => a.priority - b.priority);
  if (!sorted.length) return 'No AI providers configured. Set AI_PROVIDERS in .env, e.g. gemini:1,groq:2,openrouter:3.';
  const lines = sorted.map((e, i) =>
    `${i + 1}. ${e.provider} (priority ${e.priority}) ${keys[e.provider] ? '✓ key set' : '✗ no key, add ' + e.provider.toUpperCase() + '_API_KEY to .env'}`
  );
  return `*AI providers, in order*\n${lines.join('\n')}`;
}

/** The question path: `.ai <question>` or `.ai <n> <question>`. */
async function askAi(ctx) {
  const parsed = parseAiArgs(ctx.args || []);
  if (parsed.error) return ctx.reply(parsed.error);
  if (!parsed.question) {
    return ctx.reply(`usage: .ai <question>\nor: .ai <n> <question> (uses the last n messages of this chat, 1–${MAX_CONTEXT})`);
  }

  const quotedRaw = extractQuotedRaw(ctx.msg?.raw);
  if (quotedRaw && parsed.count) {
    return ctx.reply('When replying to one message, use `.ai <question>` without a history number.');
  }

  // A public user cannot request cached multi-message history. The deliberately
  // linked main account is allowed to do so from its own phone; that command is
  // opt-in through physical possession of the linked account, not .env.
  if (!ctx.isOwner && !ctx.isSelfIssued && parsed.count) {
    return ctx.reply('For privacy, public AI accepts only `.ai <question>` without chat-history context.');
  }

  // Check access before downloading a quoted image or invoking any provider.
  const access = await authorizeAiRequest(ctx);
  if (!access.allowed) return;

  let rows = [];
  if (parsed.count) {
    rows = ctx.bot?.chatContext?.recent(ctx.jid, parsed.count) || [];
    if (!rows.length) return ctx.reply('No messages cached for this chat yet, so there is no context to use.');
  }

  if (quotedRaw) {
    const quotedMedia = extractMediaType(quotedRaw.message);
    const quotedText = extractText(quotedRaw.message).trim().slice(0, MAX_QUOTED_TEXT);
    if (quotedMedia && quotedMedia.type !== 'image') {
      return ctx.reply('Reply-to-message AI supports quoted text, captions, or images.');
    }
    if (!quotedMedia && !quotedText) {
      return ctx.reply('That quoted message has no text, caption, or supported image to analyse.');
    }

    let images = [];
    if (quotedMedia?.type === 'image') {
      try {
        const buffer = await downloadWhatsAppMedia(ctx.socket, quotedRaw, ctx.logger);
        images = [buffer.toString('base64')];
      } catch (err) {
        return ctx.reply(`⚠️ Could not download the quoted image: ${err.message}`);
      }
    }

    const source = quotedMedia
      ? `One quoted image${quotedText ? ` with this caption:\n${quotedText}` : ''}`
      : `One quoted message:\n${quotedText}`;
    const prompt = `${source}\n\nQuestion about ONLY that quoted item:\n${parsed.question}`;
    return run(ctx, async (ai) => {
      const answer = await ai.complete({ prompt, system: SYSTEM_BASE, images, maxTokens: 1000 });
      return `🤖 *AI's Answer*\n\n${answer}`;
    });
  }

  const prompt = rows.length
    ? `Conversation so far (last ${rows.length} messages in this chat):\n${transcript(rows, ctx.bot?.contacts)}\n\nQuestion: ${parsed.question}`
    : parsed.question;

  await run(ctx, async (ai) => {
    const answer = await ai.complete({ prompt, system: SYSTEM_BASE, maxTokens: 1500 });
    return `🤖 *AI's Answer*\n\n${answer}`;
  });
}

const CHECK_PROVIDERS = ['gemini', 'groq', 'openrouter'];
const CHECK_TRIGGER = '-check-';
const BLOCK_TRIGGER = '-blist-';
const UNBLOCK_TRIGGER = '-wlist-';

async function manageAiBlocklist(ctx, action, args) {
  if (!ctx.isOwner) return ctx.reply('Only the controller can change the AI blocklist.');

  const target = String(args[0] || '').trim();
  if (!target || target.toLowerCase() === 'list') {
    const rows = listAiBlocks(ctx.db);
    if (!rows.length) return ctx.reply('🤖 *AI blocklist*\n\nNo numbers are blocked.');
    return ctx.reply(`🤖 *AI blocklist (${rows.length})*\n\n${rows.map((row) => `• ${displayAiUser(row.jid)}`).join('\n')}`);
  }

  try {
    if (action === 'block') {
      const result = addAiBlock(ctx.db, target, ctx.sender);
      return ctx.reply(result.changed
        ? `🤖 ${displayAiUser(result.jid)} cannot use provider-backed AI commands now.`
        : `🤖 ${displayAiUser(result.jid)} is already blocked from provider-backed AI commands.`);
    }
    const result = removeAiBlock(ctx.db, target);
    return ctx.reply(result.changed
      ? `🤖 ${displayAiUser(result.jid)} can use AI commands again.`
      : `🤖 ${displayAiUser(result.jid)} was not on the AI blocklist.`);
  } catch (err) {
    return ctx.reply(`⚠️ ${err.message}`);
  }
}

/**
 * `.ai -check- [all|gemini|groq|openrouter|openai]`. Owner only.
 * A plain word "check" is not the trigger: prompts may start with it.
 */
async function aiCheck(ctx, rest) {
  if (!ctx.isOwner) return ctx.reply('Only the owner can run .ai -check-.');
  const ai = ctx.bot?.ai;
  if (!ai) return ctx.reply('The AI orchestrator is not active in this mode.');
  const target = String(rest[0] || 'all').toLowerCase();
  if (target !== 'all' && !PROVIDER_NAMES.includes(target)) {
    return ctx.reply('usage: .ai -check- [all|gemini|groq|openrouter|openai]');
  }
  const names = target === 'all' ? [...CHECK_PROVIDERS] : [target];
  if (target === 'all' && ai.config.keys?.openai) names.push('openai');

  const results = await Promise.all(names.map((name) => ai.check(name)));
  const lines = results.map((r) =>
    r.ok
      ? `✅ *${r.provider}* (${r.model}) works. Reply: "${r.reply}" (${r.ms} ms)`
      : `❌ *${r.provider}* (${r.model}) does not work.\nWhy: ${r.problem}${r.raw ? `\nProvider said: ${r.raw}` : ''}`
  );
  return ctx.reply(`🔎 *AI check*\n\n${lines.join('\n\n')}\n\nFix any ❌ line, then send .ai -check- again.`);
}

export default {
  category: 'ai',
  commands: [
    {
      name: 'ai',
      aliases: ['gpt'],
      description: 'Ask the AI anything. Add a number to include that many recent messages of this chat as context.',
      usage: '.ai <question>  or  .ai <n> <question>',
      ownerOnly: false,
      async execute(ctx) {
        const subcommand = String(ctx.args?.[0] || '').toLowerCase();
        if (subcommand === CHECK_TRIGGER) return aiCheck(ctx, ctx.args.slice(1));
        if (subcommand === BLOCK_TRIGGER) return manageAiBlocklist(ctx, 'block', ctx.args.slice(1));
        if (subcommand === UNBLOCK_TRIGGER) return manageAiBlocklist(ctx, 'unblock', ctx.args.slice(1));
        try {
          return await askAi(ctx);
        } catch (err) {
          // Never go silent. A reply that names the problem beats no reply.
          return ctx.reply(`⚠️ .ai failed: ${err.message}\n\nSend .ai -check- to see which provider has the problem.`);
        }
      },
    },
    {
      name: 'aiprovider',
      aliases: ['aiorder'],
      description: 'Show or set AI provider priority (1 = tried first, the rest are fallbacks)',
      usage: '.aiprovider  or  .aiprovider <groq|gemini|openrouter|openai> <priority>',
      ownerOnly: true,
      requires: [
        {
          index: 0,
          name: 'provider',
          prompt: 'Which provider? Reply with groq, gemini, openrouter or openai.',
          validate: (v) => (PROVIDER_NAMES.includes(String(v).trim().toLowerCase()) ? String(v).trim().toLowerCase() : null),
        },
        {
          index: 1,
          name: 'priority',
          prompt: 'What priority? 1 = tried first, 2 = tried if 1 fails, 3 = last. Reply with a number.',
          validate: (v) => (/^[1-9]$/.test(String(v).trim()) ? Number(String(v).trim()) : null),
        },
      ],
      async execute(ctx) {
        const cfg = ctx.config?.ai;
        if (!cfg) return ctx.reply('AI config is not loaded.');

        if (ctx.args?.length >= 2) {
          const provider = String(ctx.args[0]).toLowerCase();
          const priority = Number(ctx.args[1]);
          if (!PROVIDER_NAMES.includes(provider) || !(priority >= 1)) {
            return ctx.reply('usage: .aiprovider <groq|gemini|openrouter|openai> <priority>');
          }
          const next = (cfg.providers || []).filter((e) => e.provider !== provider);
          next.push({ provider, priority });
          next.sort((a, b) => a.priority - b.priority);
          cfg.providers = next;
          try {
            setEnvValue('AI_PROVIDERS', next.map((e) => `${e.provider}:${e.priority}`).join(','));
          } catch (err) {
            return ctx.reply(`Priority changed for this run, but writing .env failed: ${err.message}`);
          }
          return ctx.reply(`${renderProviders(ctx)}\n\nApplied now and saved to .env.`);
        }
        return ctx.reply(renderProviders(ctx));
      },
    },
    {
      name: 'summarize',
      aliases: ['summarise', 'tldr'],
      description: 'Summarise recent messages from this chat',
      usage: '.summarize [count]',
      ownerOnly: true,
      async execute(ctx) {
        const n = Math.min(Number.parseInt(ctx.args[0], 10) || 40, 200);
        const rows = ctx.db
          .prepare(
            `SELECT sender_jid, text, ts FROM message_cache
              WHERE chat_jid = ? AND text IS NOT NULL AND text <> ''
              ORDER BY ts DESC LIMIT ?`
          )
          .all(ctx.jid, n)
          .reverse();

        if (rows.length < 3) {
          return ctx.reply('Not enough cached messages here to summarise yet.');
        }

        const transcript = rows
          .map((r) => `[${new Date(r.ts).toISOString().slice(11, 16)}] ${r.sender_jid?.split('@')[0] || '?'}: ${r.text}`)
          .join('\n');

        await run(ctx, (ai) =>
          ai.complete({
            prompt: `Summarise this WhatsApp conversation in 5 bullet points. Capture decisions, questions and anything needing a reply.\n\n${transcript}`,
            system: SYSTEM_BASE,
            maxTokens: 500,
          })
        );
      },
    },
    {
      name: 'vision',
      aliases: ['describe', 'ocr', 'visual'],
      description: 'Describe/OCR an image in its caption or an image you reply to',
      usage: '.vision [instruction] (image caption or reply to image)',
      ownerOnly: true,
      async execute(ctx) {
        const source = mediaSource(ctx, 'image');
        if (!source) {
          return ctx.reply('Put `.vision` in an image caption, or reply to an image with `.vision [instruction]`.');
        }
        let buffer;
        try {
          buffer = await downloadWhatsAppMedia(ctx.socket, source.raw, ctx.logger);
        } catch (err) {
          return ctx.reply(`⚠️ Could not download the image: ${err.message}`);
        }
        const b64 = buffer.toString('base64');
        const instruction =
          ctx.text || 'Describe this image concisely. If it contains text, transcribe it verbatim.';

        await run(ctx, (ai) =>
          ai.complete({ prompt: instruction, system: SYSTEM_BASE, images: [b64], maxTokens: 600 })
        );
      },
    },
    {
      name: 'translate',
      aliases: ['tr'],
      description: 'Translate the last message, or your own text',
      usage: '.translate <lang> [text]',
      ownerOnly: false,
      async execute(ctx) {
        const lang = ctx.args[0];
        if (!lang) return ctx.reply('usage: .translate <language> [text]');
        const text = ctx.args.slice(1).join(' ');

        let source = text;
        if (!source) {
          const row = ctx.db
            .prepare(
              `SELECT text FROM message_cache
                WHERE chat_jid = ? AND text IS NOT NULL AND text <> '' AND id <> ?
                ORDER BY ts DESC LIMIT 1`
            )
            .get(ctx.jid, ctx.msg.id || '');
          source = row?.text;
        }
        if (!source) return ctx.reply('Nothing to translate — include the text after the language.');

        await run(ctx, (ai) =>
          ai.complete({
            prompt: `Translate the following into ${lang}. Output ONLY the translation, no preamble.\n\n${source}`,
            system: SYSTEM_BASE,
            maxTokens: 600,
          })
        );
      },
    },
    {
      name: 'draft',
      aliases: ['reply'],
      description: 'Draft a reply for YOUR approval — never auto-sends',
      usage: '.draft [tone]',
      ownerOnly: true,
      async execute(ctx) {
        const row = ctx.db
          .prepare(
            `SELECT sender_jid, text FROM message_cache
              WHERE chat_jid = ? AND text IS NOT NULL AND text <> '' AND id <> ?
              ORDER BY ts DESC LIMIT 1`
          )
          .get(ctx.jid, ctx.msg.id || '');
        if (!row) return ctx.reply('No message here to reply to.');

        const tone = ctx.text || 'natural and brief';

        await run(ctx, async (ai) => {
          const text = await ai.complete({
            prompt: `Write a reply to this message in a ${tone} tone. Output ONLY the message text.\n\n"${row.text}"`,
            system: SYSTEM_BASE,
            maxTokens: 300,
          });
          // Deliberately never sent. Auto-replying to real people is the fastest
          // way to look like a bot, to Meta and to your contacts.
          return `✍️ *Draft (not sent)*\n\n${text}\n\n_Copy it, edit it, send it yourself._`;
        });
      },
    },
    {
      name: 'forget',
      aliases: ['reset'],
      description: 'Clear the AI conversation memory for this chat',
      usage: '.forget',
      ownerOnly: true,
      async execute(ctx) {
        const ai = ctx.bot?.ai;
        if (!ai) return ctx.reply('The AI orchestrator is not active in this mode.');
        ai.forget(ctx.jid);
        await ctx.reply('🧠 Memory for this chat cleared.');
      },
    },
  ],
};
