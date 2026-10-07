/**
 * AI commands. All share one orchestrator (core/ai.js); the difference is only
 * what context each one feeds it.
 *
 * If no API key is configured every command says so plainly. A bot that
 * silently pretends to be an AI is worse than one that admits it has no key.
 */

import { AiNotConfigured, AiError } from '../core/ai.js';

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

export default {
  category: 'ai',
  commands: [
    {
      name: 'ai',
      aliases: ['ask', 'gpt'],
      description: 'Ask the model anything, with per-chat memory',
      usage: '.ai <prompt>',
      ownerOnly: false,
      async execute(ctx) {
        if (!ctx.text) return ctx.reply('usage: .ai <your question>');
        await run(ctx, (ai) =>
          ai.complete({
            prompt: ctx.text,
            system: SYSTEM_BASE,
            chatKey: ctx.jid,
            maxTokens: 700,
          })
        );
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
      description: 'Describe or read text from an attached image',
      usage: '.vision [instruction]',
      ownerOnly: true,
      async execute(ctx) {
        if (!ctx.msg.media || ctx.msg.media.type !== 'image') {
          return ctx.reply('Attach an image, then send .vision');
        }
        let buffer;
        try {
          buffer = await ctx.socket.downloadMediaMessage(ctx.msg.raw);
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
