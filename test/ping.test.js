import test from 'node:test';
import assert from 'node:assert/strict';

import pingPlugin from '../src/plugins/ping.js';

test('.ping creates one immediate reply instead of a two-message typing sequence', async () => {
  const replies = [];
  await pingPlugin.execute({
    config: { mode: 'live' },
    plugins: { commands: new Map([['ping', pingPlugin]]) },
    isGroup: false,
    isOwner: true,
    reply: async (text, options) => replies.push({ text, options }),
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /\*Pong\*/);
  assert.equal(replies[0].options.nexusSkipTyping, true);
});
