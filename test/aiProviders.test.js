import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildConfig, parseAiProviders } from '../src/config/index.js';
import { AiClient, AiError, AiNotConfigured, modelSupportsImages } from '../src/core/ai.js';
import { createLogger } from '../src/core/logger.js';
import { setEnvValue } from '../src/core/envFile.js';

const quiet = createLogger('fatal');

function openAiReply(text) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }) };
}
function failure(status) {
  return { ok: false, status, text: async () => JSON.stringify({ error: { message: `boom ${status}` } }) };
}

function clientWith({ providers = parseAiProviders(), keys, fetchImpl, requestTimeoutMs }) {
  const config = {
    ai: { provider: 'groq', providers, keys, model: '', maxHistory: 12 },
  };
  return new AiClient({ config, logger: quiet, fetchImpl, requestTimeoutMs });
}

test('AI route is always Groq first then OpenRouter, regardless of an old provider list', () => {
  assert.deepEqual(parseAiProviders('gemini:1,openrouter:2,groq:3,openai:4'), [
    { provider: 'groq', priority: 1 },
    { provider: 'openrouter', priority: 2 },
  ]);
  assert.deepEqual(parseAiProviders('', 'gemini').map((entry) => entry.provider), ['groq', 'openrouter']);
  assert.deepEqual(parseAiProviders('openrouter:1,groq:2').map((entry) => entry.provider), ['groq', 'openrouter']);
});

test('a stale Gemini provider/model setting falls back to Groq without reusing the Gemini model ID', () => {
  const oldProvider = process.env.AI_PROVIDER;
  const oldModel = process.env.AI_MODEL;
  try {
    process.env.AI_PROVIDER = 'gemini';
    process.env.AI_MODEL = 'gemini-unavailable-model';
    const config = buildConfig({ mode: 'dry-run' });
    assert.equal(config.ai.provider, 'groq');
    assert.equal(config.ai.model, '');
  } finally {
    if (oldProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = oldProvider;
    if (oldModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = oldModel;
  }
});

test('OpenRouter uses the fixed free router model and its endpoint', async () => {
  const seen = [];
  const ai = clientWith({
    keys: { groq: '', openrouter: 'or-key' },
    fetchImpl: async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
      return openAiReply('routed');
    },
  });
  assert.equal(await ai.complete({ prompt: 'hi' }), 'routed');
  assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(seen[0].body.model, 'openrouter/free');
  assert.equal(seen[0].auth, 'Bearer or-key');
});

test('Groq failure falls through directly to OpenRouter; Gemini is never contacted', async () => {
  const calls = [];
  const ai = clientWith({
    keys: { gemini: 'old-key', groq: 'g', openrouter: 'or' },
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('groq.com')) return failure(503);
      return openAiReply('fallback answer');
    },
  });
  assert.equal(await ai.complete({ prompt: 'hi' }), 'fallback answer');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /groq\.com/);
  assert.match(calls[1], /openrouter\.ai/);
  assert.ok(!calls.some((url) => url.includes('generativelanguage')));
});

test('a text request has a hard deadline even when a fetch implementation ignores abort', async () => {
  let signal;
  const ai = clientWith({
    keys: { groq: 'g', openrouter: '' },
    requestTimeoutMs: 25,
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    },
  });
  await assert.rejects(ai.complete({ prompt: 'hi' }), (error) => {
    assert.ok(error instanceof AiError);
    assert.match(error.message, /timed out after 1s/);
    return true;
  });
  assert.equal(signal.aborted, true);
});

test('audio transcription never goes to OpenRouter', async () => {
  const ai = clientWith({
    keys: { groq: '', openrouter: 'or' },
    fetchImpl: async () => openAiReply('x'),
  });
  await assert.rejects(ai.transcribeAudio({ base64: 'AAAA' }), AiNotConfigured);
});

test('Groq Qwen and OpenRouter free router are recognised as vision-capable', () => {
  assert.equal(modelSupportsImages('groq', 'qwen/qwen3.8-27b'), true);
  assert.equal(modelSupportsImages('openrouter', 'openrouter/free'), true);
  assert.equal(modelSupportsImages('groq', 'openai/gpt-oss-120b'), false);
});

test('an image request automatically uses Groq Qwen when Groq text model is not visual', async () => {
  const seen = [];
  const ai = clientWith({
    keys: { groq: 'g', openrouter: '' },
    fetchImpl: async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return openAiReply('image understood');
    },
  });

  assert.equal(await ai.complete({ prompt: 'read this', images: ['aGVsbG8='] }), 'image understood');
  assert.match(seen[0].url, /groq\.com/);
  assert.equal(seen[0].body.model, 'qwen/qwen3.8-27b');
  assert.equal(seen[0].body.messages.at(-1).content[1].type, 'image_url');
  assert.match(seen[0].body.messages.at(-1).content[1].image_url.url, /^data:image\/jpeg;base64,aGVsbG8=/);
});

test('providers without a key are skipped entirely', async () => {
  const calls = [];
  const ai = clientWith({
    keys: { groq: '', openrouter: 'or' },
    fetchImpl: async (url) => {
      calls.push(url);
      return openAiReply('ok');
    },
  });
  await ai.complete({ prompt: 'hi' });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /openrouter\.ai/);
});

test('when both active providers fail the error names each one', async () => {
  const ai = clientWith({
    keys: { groq: 'g', openrouter: 'or' },
    fetchImpl: async () => failure(503),
  });
  await assert.rejects(ai.complete({ prompt: 'hi' }), (err) => {
    assert.ok(err instanceof AiError);
    assert.match(err.message, /groq: provider 503/);
    assert.match(err.message, /openrouter: provider 503/);
    return true;
  });
});

test('no active keys at all reports not configured', async () => {
  const ai = clientWith({ keys: { groq: '', openrouter: '' }, fetchImpl: async () => openAiReply('x') });
  assert.equal(ai.configured(), false);
  await assert.rejects(ai.complete({ prompt: 'hi' }), AiNotConfigured);
});

test('setEnvValue replaces the line in place and leaves the rest alone', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'envf-')), '.env');
  fs.writeFileSync(file, '# top\nGROQ_API_KEY=abc\nAI_PROVIDERS=groq:1\nAI_PROVIDERS=dup:9\nTAIL=1\n');
  setEnvValue('AI_PROVIDERS', 'groq:1,openrouter:2', file);
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    '# top\nGROQ_API_KEY=abc\nAI_PROVIDERS=groq:1,openrouter:2\nTAIL=1\n'
  );
  setEnvValue('NEW_KEY', 'x', file);
  assert.match(fs.readFileSync(file, 'utf8'), /\nNEW_KEY=x\n$/);
  assert.throws(() => setEnvValue('lower', 'x', file));
});
