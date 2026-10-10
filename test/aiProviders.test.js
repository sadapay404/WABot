import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseAiProviders } from '../src/config/index.js';
import { AiClient, AiError, AiNotConfigured } from '../src/core/ai.js';
import { createLogger } from '../src/core/logger.js';
import { setEnvValue } from '../src/core/envFile.js';

const quiet = createLogger('fatal');

function openAiReply(text) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }) };
}
function failure(status) {
  return { ok: false, status, text: async () => JSON.stringify({ error: { message: `boom ${status}` } }) };
}

function clientWith({ providers, keys, fetchImpl }) {
  const config = {
    ai: { provider: 'groq', providers, keys, model: '', maxHistory: 12 },
  };
  return new AiClient({ config, logger: quiet, fetchImpl });
}

test('AI_PROVIDERS is sorted by priority, unknown and duplicate names dropped', () => {
  const list = parseAiProviders('gemini:2,groq:1,bogus:3,openai:3,groq:9');
  assert.deepEqual(list, [
    { provider: 'groq', priority: 1 },
    { provider: 'gemini', priority: 2 },
    { provider: 'openai', priority: 3 },
  ]);
});

test('without AI_PROVIDERS the legacy AI_PROVIDER leads, the rest follow', () => {
  assert.deepEqual(parseAiProviders('', 'openai').map((e) => e.provider), ['openai', 'groq', 'gemini']);
  assert.deepEqual(parseAiProviders('', '').map((e) => e.provider), ['groq', 'gemini', 'openai']);
});

test('complete() falls back to the next provider when the first fails', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return url.includes('groq.com') ? failure(500) : openAiReply('from openai');
  };
  const ai = clientWith({
    providers: parseAiProviders('groq:1,openai:2'),
    keys: { groq: 'g', openai: 'o', gemini: '' },
    fetchImpl,
  });
  const answer = await ai.complete({ prompt: 'hi' });
  assert.equal(answer, 'from openai');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /groq\.com/);
  assert.match(calls[1], /openai\.com/);
});

test('providers without a key are skipped entirely', async () => {
  const calls = [];
  const ai = clientWith({
    providers: parseAiProviders('groq:1,openai:2'),
    keys: { groq: '', openai: 'o' },
    fetchImpl: async (url) => {
      calls.push(url);
      return openAiReply('ok');
    },
  });
  await ai.complete({ prompt: 'hi' });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /openai\.com/);
});

test('when every provider fails the error names each one', async () => {
  const ai = clientWith({
    providers: parseAiProviders('groq:1,openai:2'),
    keys: { groq: 'g', openai: 'o' },
    fetchImpl: async () => failure(503),
  });
  await assert.rejects(ai.complete({ prompt: 'hi' }), (err) => {
    assert.ok(err instanceof AiError);
    assert.match(err.message, /groq: provider 503/);
    assert.match(err.message, /openai: provider 503/);
    return true;
  });
});

test('no keys at all reports not configured', async () => {
  const ai = clientWith({ providers: parseAiProviders('groq:1'), keys: { groq: '' }, fetchImpl: async () => openAiReply('x') });
  assert.equal(ai.configured(), false);
  await assert.rejects(ai.complete({ prompt: 'hi' }), AiNotConfigured);
});

test('setEnvValue replaces the line in place and leaves the rest alone', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'envf-')), '.env');
  fs.writeFileSync(file, '# top\nGROQ_API_KEY=abc\nAI_PROVIDERS=groq:1\nAI_PROVIDERS=dup:9\nTAIL=1\n');
  setEnvValue('AI_PROVIDERS', 'openai:1,groq:2', file);
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    '# top\nGROQ_API_KEY=abc\nAI_PROVIDERS=openai:1,groq:2\nTAIL=1\n'
  );
  setEnvValue('NEW_KEY', 'x', file);
  assert.match(fs.readFileSync(file, 'utf8'), /\nNEW_KEY=x\n$/);
  assert.throws(() => setEnvValue('lower', 'x', file));
});
