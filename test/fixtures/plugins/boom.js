export default {
  name: 'boom',
  category: 'test',
  description: 'Throws on purpose',
  async execute() { throw new Error('deliberate plugin failure'); },
};
