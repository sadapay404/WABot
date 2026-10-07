export default {
  name: 'slow',
  category: 'test',
  description: 'Cooldown fixture',
  cooldownMs: 60000,
  async execute(ctx) { await ctx.reply('slow ok'); },
};
