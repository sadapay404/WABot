import test from 'node:test';
import assert from 'node:assert/strict';

import helpPlugin from '../src/plugins/help.js';

const commands = [
  { name: 'ping', usage: '.ping', description: 'Confirm liveness', ownerOnly: false },
  { name: 'contact', usage: '.contact list', description: 'Manage contact labels', ownerOnly: true },
  { name: 'ai', usage: '.ai <question>', description: 'Ask AI', ownerOnly: false },
];

function context({ isOwner = false, args = [] } = {}) {
  const replies = [];
  const sent = [];
  return {
    args,
    isOwner,
    jid: '15550002222@s.whatsapp.net',
    config: { mode: 'live', prefix: '.' },
    logger: { warn() {} },
    plugins: {
      listByCategory() {
        return new Map([
          ['ai', [commands[2]]],
          ['privacy', [commands[1]]],
          ['tools', [commands[0]]],
        ]);
      },
    },
    replies,
    sent,
    async reply(text) {
      replies.push(text);
      return { key: { id: `MENU-${replies.length}` }, message: { text } };
    },
    async send(jid, content, options) {
      sent.push({ jid, content, options });
    },
  };
}

test('.help renders a sorted menu and attaches commands.md in reply to it', async () => {
  const ctx = context({ isOwner: true });
  await helpPlugin.execute(ctx);

  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0], /\*AI\*/);
  assert.match(ctx.replies[0], /`\.ai`/);
  assert.match(ctx.replies[0], /`\.contact`/);
  assert.match(ctx.replies[0], /commands\.md reference is attached/i);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].content.fileName, 'commands.md');
  assert.ok(Buffer.isBuffer(ctx.sent[0].content.document));
  assert.equal(ctx.sent[0].options.quoted.key.id, 'MENU-1');
});

test('.help hides owner-only commands from a guest but still attaches the reference', async () => {
  const ctx = context();
  await helpPlugin.execute(ctx);

  assert.doesNotMatch(ctx.replies[0], /`\.contact`/);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].options.quoted.key.id, 'MENU-1');
});
