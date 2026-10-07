export default {
  name: 'secret',
  category: 'test',
  description: 'Owner-only fixture',
  ownerOnly: true,
  async execute(ctx) { await ctx.reply('vault opened'); },
};
