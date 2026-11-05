import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateLocally, splitCalcRequest } from '../src/core/calculator.js';
import { getMemoryDb } from '../src/database/index.js';
import { addAiBlock } from '../src/core/aiAccess.js';
import calcPlugin from '../src/plugins/calc.js';

const calc = calcPlugin.commands.find((command) => command.name === 'calc');
const BOB = '15550002222@s.whatsapp.net';

function context({ text, db, complete = null } = {}) {
  const replies = [];
  const calls = [];
  return {
    ctx: {
      text,
      sender: BOB,
      jid: BOB,
      isOwner: false,
      isSelfIssued: false,
      config: { isLive: true, ai: { dailyLimit: 200 } },
      db,
      bot: complete ? { ai: { complete: async (request) => { calls.push(request); return complete; } } } : {},
      reply: async (value) => { replies.push(value); },
    },
    replies,
    calls,
  };
}

test('safe local calculator handles arithmetic without an AI provider', () => {
  assert.equal(calculateLocally('2 + 3 * 4').text, '14');
  assert.equal(calculateLocally('2^3^2').text, '512');
  assert.equal(calculateLocally('sqrt(81) + abs(-2)').text, '11');
  assert.equal(calculateLocally('process.exit()'), null);
  assert.deepEqual(splitCalcRequest(' 2 + 2 --process '), { equation: '2 + 2', process: true });
});

test('.calc responds with only a labelled local answer for ordinary arithmetic', async () => {
  const db = await getMemoryDb();
  const { ctx, replies, calls } = context({ text: '12 / 3 + 1', db });
  await calc.execute(ctx);
  assert.deepEqual(calls, []);
  assert.deepEqual(replies, ['🧮 *Equation Solved--Calc*\n\n5']);
});

test('.calc falls back to configured AI for algebra and uses AI for --process', async () => {
  const db = await getMemoryDb();
  const algebra = context({ text: '2x + 3 = 11', db, complete: 'x = 4' });
  await calc.execute(algebra.ctx);
  assert.equal(algebra.calls.length, 1);
  assert.match(algebra.calls[0].prompt, /2x \+ 3 = 11/);
  assert.deepEqual(algebra.replies, ['🧮 *Equation Solved--Calc*\n\nx = 4']);

  const process = context({ text: '2 + 2 --process', db: await getMemoryDb(), complete: '1. Add 2 and 2.\nFinal answer: 4' });
  await calc.execute(process.ctx);
  assert.equal(process.calls.length, 1);
  assert.match(process.replies[0], /Equation Solved--Calc/);
  assert.match(process.replies[0], /\*Process\*/);
  assert.match(process.replies[0], /Final answer: 4/);
});

test('an AI block never prevents a strictly local calc, but stops AI fallback', async () => {
  const db = await getMemoryDb();
  addAiBlock(db, BOB, '15550009999@s.whatsapp.net');

  const local = context({ text: '8 * 7', db });
  await calc.execute(local.ctx);
  assert.match(local.replies.at(-1), /\n\n56$/);

  const algebra = context({ text: 'x + 1 = 4', db, complete: 'x = 3' });
  await calc.execute(algebra.ctx);
  assert.equal(algebra.calls.length, 0);
  assert.match(algebra.replies.at(-1), /^🤖 /);
});
