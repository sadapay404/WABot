import test from 'node:test';
import assert from 'node:assert/strict';

import { AiClient, explainProviderError } from '../src/core/ai.js';
import { createLogger } from '../src/core/logger.js';

const quiet = createLogger('fatal');

const GROQ_RETIRED = 'The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.';

test('explainProviderError names a retired model in plain words', () => {
  assert.match(explainProviderError(GROQ_RETIRED, 404), /model name is retired/);
});

test('explainProviderError separates a bad key from a bad model and from quota', () => {
  assert.match(explainProviderError('API key not valid. Please pass a valid API key.', 400), /key was rejected/);
  assert.match(explainProviderError('Invalid API Key', 401), /key was rejected/);
  assert.match(explainProviderError('quota exceeded for metric', 429), /quota or rate limit/);
  assert.match(explainProviderError('Service Unavailable', 503), /trouble on their side/);
  assert.match(explainProviderError('fetch failed', null), /could not reach/);
  assert.match(explainProviderError('The operation was aborted due to timeout', null), /did not answer in time/);
});

test('explainProviderError never returns an empty reason', () => {
  assert.match(explainProviderError('', null), /unexpected provider error/);
});

function clientWith(keys, fetchImpl) {
  const config = {
    ai: {
      provider: 'groq',
      providers: [
        { provider: 'groq', priority: 1 },
        { provider: 'openrouter', priority: 2 },
      ],
      keys,
      model: '',
      maxHistory: 12,
    },
  };
  return new AiClient({ config, logger: quiet, fetchImpl });
}

test('check reports a working provider with its reply', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
  });
  const r = await clientWith({ groq: 'gsk_test' }, fetchImpl).check('groq');
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'OK');
  assert.equal(r.model, 'openai/gpt-oss-120b');
});

test('check refuses disabled Gemini without contacting it', async () => {
  let calls = 0;
  const r = await clientWith({ gemini: 'old-key' }, async () => {
    calls++;
    throw new Error('should not be called');
  }).check('gemini');
  assert.equal(r.ok, false);
  assert.match(r.problem, /disabled/);
  assert.equal(calls, 0);
});

test('check says plainly when a provider has no key', async () => {
  const r = await clientWith({}, async () => {
    throw new Error('should not be called');
  }).check('openrouter');
  assert.equal(r.ok, false);
  assert.match(r.problem, /OPENROUTER_API_KEY/);
});

test('check never leaks the key, even if the provider echoes it back', async () => {
  const key = 'gsk_LEAKME_987654';
  const fetchImpl = async () => {
    throw new Error(`request to https://x/?key=${key} failed`);
  };
  const r = await clientWith({ groq: key }, fetchImpl).check('groq');
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(key), 'key must not appear in the result');
});

import aiPlugin from '../src/plugins/ai.js';

function checkCommand() {
  return aiPlugin.commands.find((c) => c.name === 'ai');
}

test('.ai check is owner only; a stranger gets a plain refusal', async () => {
  const replies = [];
  await checkCommand().execute({
    args: ['-check-'], isOwner: false, reply: async (t) => replies.push(t),
    bot: {}, config: {}, jid: 'x@s.whatsapp.net',
  });
  assert.match(replies[0], /Only the owner/);
});

test('.ai check reports Groq and OpenRouter only', async () => {
  const fetchImpl = async () =>
    ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) });
  const ai = clientWith({ gemini: 'old-key', groq: 'q-key', openrouter: 'or-key' }, fetchImpl);
  const replies = [];
  await checkCommand().execute({
    args: ['-check-'], isOwner: true, reply: async (t) => replies.push(t),
    bot: { ai }, config: {}, jid: 'x@s.whatsapp.net',
  });
  const report = replies[0];
  assert.match(report, /AI check/);
  assert.match(report, /✅ \*groq\*/);
  assert.match(report, /✅ \*openrouter\*/);
  assert.doesNotMatch(report, /gemini/i);
});

test('an empty reply is explained, not shown as raw JSON', () => {
  const msg = explainProviderError('provider returned no content: {"id":"gen-1"}', null);
  assert.match(msg, /answered with no text/);
  assert.ok(!msg.includes('{"id"'), 'raw JSON must not reach the chat');
  assert.match(explainProviderError('the model used its whole reply limit on hidden reasoning', null), /answered with no text/);
});

test('a prompt that starts with the word check goes to the AI, not the checker', async () => {
  let seen = null;
  const ai = { complete: async (req) => { seen = req; return 'Looks fine.'; } };
  const replies = [];
  await checkCommand().execute({
    args: ['check', 'my', 'essay'], isOwner: true, reply: async (t) => replies.push(t),
    bot: { ai, chatContext: null }, config: {}, jid: 'x@s.whatsapp.net',
  });
  assert.ok(seen, 'the AI must be asked');
  assert.match(seen.prompt, /check my essay/);
  assert.ok(!replies.some((t) => /AI check/.test(t)), 'must not run the provider checker');
});
