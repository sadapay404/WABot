/**
 * AI commands. All share one orchestrator (core/ai.js); the difference is only
 * what context each one feeds it.
 *
 * If no API key is configured every command says so plainly. A bot that
 * silently pretends to be an AI is worse than one that admits it has no key.
 */

import { AiNotConfigured, AiError } from '../core/ai.js';
import { jidToPhone } from '../core/jid.js';
import { setEnvValue } from '../core/envFile.js';
import { downloadWhatsAppMedia } from '../core/mediaDownloader.js';

const SYSTEM_BASE =
  'You are Nexus-WA, a concise personal assistant running inside WhatsApp. ' +
  'Replies are read on a phone: keep them short, use plain text, avoid markdown ' +
  'headings, and never pad. If you do not know, say so.';

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


const PROVIDER_NAMES = ['groq', 'gemini', 'openai'];
const MAX_CONTEXT = 50;
const DAY_CAP_FALLBACK = 200;
const COOLDOWN_FALLBACK_SEC = 15;

/** Per-sender cooldown and a daily cap, both in memory. Owner is exempt from cooldown. */
const lastAskAt = new Map();
let dailyCount = { day: '', used: 0 };

/** @returns {string|null} reason to refuse, or null after recording the use */
function takeQuota(ctx) {
  const day = new Date().toISOString().slice(0, 10);
  if (dailyCount.day !== day) dailyCount = { day, used: 0 };

  const cap = ctx.config?.ai?.dailyLimit ?? DAY_CAP_FALLBACK;
  if (dailyCount.used >= cap) {
    return `🤖 Daily AI limit reached (${cap} questions). It resets at midnight UTC.`;
  }

  if (!ctx.isOwner) {
    const cooldownMs = (ctx.config?.ai?.senderCooldownSec ?? COOLDOWN_FALLBACK_SEC) * 1_000;
    const sender = String(ctx.sender || ctx.jid);
    const waitMs = (lastAskAt.get(sender) || 0) + cooldownMs - Date.now();
    if (waitMs > 0) return `🤖 Please wait ${Math.ceil(waitMs / 1_000)}s before asking again.`;
    lastAskAt.set(sender, Date.now());
  }

  dailyCount.used += 1;
  return null;
}

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
  if (!sorted.length) return 'No AI providers configured. Set AI_PROVIDERS in .env, e.g. groq:1,gemini:2.';
  const lines = sorted.map((e, i) =>
    `${i + 1}. ${e.provider} (priority ${e.priority}) ${keys[e.provider] ? '✓ key set' : '✗ no key, add ' + e.provider.toUpperCase() + '_API_KEY to .env'}`
  );
  return `*AI providers, in order*\n${lines.join('\n')}`;
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
        const parsed = parseAiArgs(ctx.args || []);
        if (parsed.error) return ctx.reply(parsed.error);
        if (!parsed.question) {
          return ctx.reply(`usage: .ai <question>\nor: .ai <n> <question> (uses the last n messages of this chat, 1–${MAX_CONTEXT})`);
        }

        const limited = takeQuota(ctx);
        if (limited) return ctx.reply(limited);

        let rows = [];
        if (parsed.count) {
          rows = ctx.bot?.chatContext?.recent(ctx.jid, parsed.count) || [];
          if (!rows.length) return ctx.reply('No messages cached for this chat yet, so there is no context to use.');
        }
        const prompt = rows.length
          ? `Conversation so far (last ${rows.length} messages in this chat):\n${transcript(rows, ctx.bot?.contacts)}\n\nQuestion: ${parsed.question}`
          : parsed.question;

        await run(ctx, async (ai) => {
          const answer = await ai.complete({ prompt, system: SYSTEM_BASE, maxTokens: 700 });
          return `🤖 *AI's Answer*\n\n${answer}`;
        });
      },
    },
    {
      name: 'aiprovider',
      aliases: ['aiorder'],
      description: 'Show or set AI provider priority (1 = tried first, the rest are fallbacks)',
      usage: '.aiprovider  or  .aiprovider <groq|gemini|openai> <priority>',
      ownerOnly: true,
      requires: [
        {
          index: 0,
          name: 'provider',
          prompt: 'Which provider? Reply with groq, gemini or openai.',
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
            return ctx.reply('usage: .aiprovider <groq|gemini|openai> <priority>');
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
      aliases: ['describe', 'ocr'],
      description: 'Describe or read text from an attached image (put the command in its caption)',
      usage: '.vision [instruction] (image caption)',
      ownerOnly: true,
      async execute(ctx) {
        if (!ctx.msg.media || ctx.msg.media.type !== 'image') {
          return ctx.reply('Send an image with `.vision` in its caption.');
        }
        let buffer;
        try {
          buffer = await downloadWhatsAppMedia(ctx.socket, ctx.msg.raw, ctx.logger);
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
