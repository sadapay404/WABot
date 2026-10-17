/** Text-to-image command. The output is generated remotely by Cloudflare Workers
 * AI; only the explicit prompt is transmitted and generated image bytes are
 * never written to the local media archive. */

import {
  ImageGenerationError,
  ImageGenerationNotConfigured,
} from '../core/imageGeneration.js';
import { authorizeImageGeneration } from '../core/aiAccess.js';

const MAX_PROMPT_CHARS = 2_048;

function captionPrompt(prompt) {
  const compact = String(prompt).replace(/\s+/g, ' ').trim();
  return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
}

export default {
  category: 'ai',
  commands: [
    {
      name: 'imagine',
      aliases: ['image', 'img', 'draw'],
      description: 'Generate a fresh image from a text prompt using Cloudflare Workers AI',
      usage: '.imagine <what you want to see>',
      ownerOnly: false,
      async execute(ctx) {
        const prompt = String(ctx.text || '').trim();
        if (!prompt) return ctx.reply('usage: .imagine <what you want to see>');

        const generator = ctx.bot?.imageGenerator;
        // Check live-mode/blocklist access before revealing configuration, so an
        // AI-blocked participant receives the same mild response as every other
        // provider-backed command. Validation and missing setup do not spend a
        // finite image request, so charge only immediately before generation.
        const access = await authorizeImageGeneration(ctx, { charge: false });
        if (!access.allowed) return;
        if (!generator?.configured?.()) {
          return ctx.reply(
            '🎨 _Image generation is not configured._\n\n' +
            'The controller must set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN privately with `.env` first.'
          );
        }
        if (prompt.length > MAX_PROMPT_CHARS) {
          return ctx.reply(`Keep the image prompt to ${MAX_PROMPT_CHARS.toLocaleString()} characters or fewer.`);
        }
        const quota = await authorizeImageGeneration(ctx);
        if (!quota.allowed) return;

        try {
          const image = await generator.generate({ prompt });
          return ctx.socket.sendMessage(ctx.jid, {
            image: image.bytes,
            mimetype: image.mimetype,
            fileName: `nexus-image-${Date.now()}.${image.ext}`,
            caption: `🎨 ${captionPrompt(prompt)}\n\n_Generated with Cloudflare Workers AI._`,
          }, { quoted: ctx.msg?.raw });
        } catch (error) {
          if (error instanceof ImageGenerationNotConfigured) {
            return ctx.reply(`🎨 _Image generation is not configured._\n\n${error.message}`);
          }
          if (error instanceof ImageGenerationError) return ctx.reply(`⚠️ Image generation failed: ${error.message}`);
          throw error;
        }
      },
    },
  ],
};
