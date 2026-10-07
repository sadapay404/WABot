// Replies with a payload that exceeds WhatsApp's per-message ceiling,
// so the dispatcher's chunking can be asserted.
export default {
  name: 'long',
  category: 'test',
  description: 'Long-reply chunking fixture',
  async execute(ctx) {
    await ctx.reply('x'.repeat(9000));
  },
};
