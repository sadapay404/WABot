import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLOUDFLARE_IMAGE_MODEL,
  ImageGenerationClient,
  ImageGenerationError,
  ImageGenerationNotConfigured,
} from '../src/core/imageGeneration.js';
import { createLogger } from '../src/core/logger.js';

const quiet = createLogger('fatal');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

function client({ accountId = 'account-1234', apiToken = 'super-secret-token', fetchImpl } = {}) {
  return new ImageGenerationClient({
    config: { imageGen: { accountId, apiToken } },
    logger: quiet,
    fetchImpl,
  });
}

function jsonResponse(value, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(value),
  };
}

test('Cloudflare image generator posts the fixed free image model and validates its base64 JPEG', async () => {
  const seen = [];
  const image = await client({
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return jsonResponse({ success: true, result: { image: jpeg.toString('base64') } });
    },
  }).generate({ prompt: 'a hummingbird in a moonlit garden' });

  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /accounts\/account-1234\/ai\/run\/@cf\/black-forest-labs\/flux-1-schnell$/);
  assert.equal(seen[0].init.headers.authorization, 'Bearer super-secret-token');
  assert.deepEqual(JSON.parse(seen[0].init.body), { prompt: 'a hummingbird in a moonlit garden', steps: 4 });
  assert.equal(image.model, CLOUDFLARE_IMAGE_MODEL);
  assert.equal(image.mimetype, 'image/jpeg');
  assert.equal(image.ext, 'jpg');
  assert.deepEqual(image.bytes, jpeg);
});

test('Cloudflare image generator accepts direct image bytes after checking their signature', async () => {
  const image = await client({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => jpeg,
    }),
  }).generate({ prompt: 'a small red kite' });
  assert.equal(image.mimetype, 'image/jpeg');
  assert.deepEqual(image.bytes, jpeg);
});

test('image generator is honest when unset and does not issue a fetch', async () => {
  let calls = 0;
  const ai = client({ accountId: '', apiToken: '', fetchImpl: async () => { calls++; } });
  assert.equal(ai.configured(), false);
  await assert.rejects(ai.generate({ prompt: 'anything' }), ImageGenerationNotConfigured);
  assert.equal(calls, 0);
});

test('provider failures redact a token and malformed image data is rejected', async () => {
  const bad = client({
    fetchImpl: async () => jsonResponse({ success: false, errors: [{ message: 'bad token super-secret-token' }] }, { ok: false, status: 401 }),
  });
  await assert.rejects(bad.generate({ prompt: 'anything' }), (error) => {
    assert.ok(error instanceof ImageGenerationError);
    assert.equal(error.status, 401);
    assert.doesNotMatch(error.message, /super-secret-token/);
    assert.match(error.message, /\[token\]/);
    return true;
  });

  const malformed = client({
    fetchImpl: async () => jsonResponse({ success: true, result: { image: Buffer.from('not an image').toString('base64') } }),
  });
  await assert.rejects(malformed.generate({ prompt: 'anything' }), /valid JPEG, PNG, or WebP/);
});

test('image prompts are bounded before any provider request', async () => {
  let calls = 0;
  const ai = client({ fetchImpl: async () => { calls++; return jsonResponse({}); } });
  await assert.rejects(ai.generate({ prompt: 'x'.repeat(2_049) }), /2,048/);
  assert.equal(calls, 0);
});
