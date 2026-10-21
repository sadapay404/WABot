import test from 'node:test';
import assert from 'node:assert/strict';

import { buildConfig } from '../src/config/index.js';
import { getMemoryDb } from '../src/database/index.js';
import { addAiBlock } from '../src/core/aiAccess.js';
import imaginePlugin from '../src/plugins/imagine.js';

const OWNER = '15550009999@s.whatsapp.net';
const BOB = '15550002222@s.whatsapp.net';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

function command() {
  return imaginePlugin.commands.find((entry) => entry.name === 'imagine');
}

async function setup({ configured = true, owner = false } = {}) {
  const config = buildConfig({ mode: 'live' });
  config.safety.ownerJids = [OWNER];
  config.ai.dailyLimit = 200;
  const db = await getMemoryDb();
  const replies = [];
  const sends = [];
  const calls = [];
  const generator = {
    configured: () => configured,
    async generate(input) {
      calls.push(input);
      return { bytes: jpeg, mimetype: 'image/jpeg', ext: 'jpg' };
    },
  };
  const ctx = {
    text: 'a tiny astronaut watering flowers on the moon',
    args: ['a', 'tiny', 'astronaut', 'watering', 'flowers', 'on', 'the', 'moon'],
    config,
    db,
    sender: owner ? OWNER : BOB,
    jid: owner ? OWNER : BOB,
    isOwner: owner,
    isSelfIssued: false,
    msg: { raw: { key: { id: 'command-1' } } },
    bot: { imageGenerator: generator },
    socket: {
      async sendMessage(jid, content, options) {
        sends.push({ jid, content, options });
        return { key: { id: 'image-1' } };
      },
    },
    async reply(text) {
      replies.push(text);
      return { key: { id: 'reply-1' } };
    },
  };
  return { ctx, db, replies, sends, calls };
}

test('public .imagine in live mode sends one generated image and only the explicit prompt goes to the generator', async () => {
  const { ctx, sends, calls, replies } = await setup();
  await command().execute(ctx);

  assert.equal(replies.length, 0);
  assert.deepEqual(calls, [{ prompt: ctx.text }]);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].jid, BOB);
  assert.deepEqual(sends[0].content.image, jpeg);
  assert.equal(sends[0].content.mimetype, 'image/jpeg');
  assert.match(sends[0].content.caption, /a tiny astronaut/);
  assert.match(sends[0].content.caption, /Cloudflare Workers AI/);
  assert.equal(sends[0].options.quoted, ctx.msg.raw);
});

test('an AI-blocked participant cannot use image generation', async () => {
  const { ctx, db, calls, sends, replies } = await setup();
  addAiBlock(db, BOB, OWNER);
  await command().execute(ctx);

  assert.equal(calls.length, 0);
  assert.equal(sends.length, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /^🤖 /);
});

test('missing Cloudflare configuration gives an actionable reply without using an image quota or generator', async () => {
  const { ctx, calls, replies, sends } = await setup({ configured: false });
  await command().execute(ctx);

  assert.equal(calls.length, 0);
  assert.equal(sends.length, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /CLOUDFLARE_ACCOUNT_ID/);
  assert.match(replies[0], /CLOUDFLARE_API_TOKEN/);
});

test('image prompt is required and is never generated when absent', async () => {
  const { ctx, calls, replies } = await setup();
  ctx.text = '';
  ctx.args = [];
  await command().execute(ctx);
  assert.equal(calls.length, 0);
  assert.match(replies[0], /usage: \.imagine/);
});
