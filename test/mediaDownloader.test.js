import test from 'node:test';
import assert from 'node:assert/strict';

import { downloadWhatsAppMedia } from '../src/core/mediaDownloader.js';

test('media downloader uses the preview transport adapter when available', async () => {
  const raw = { key: { id: 'MOCK-IMAGE' } };
  const socket = {
    async downloadMediaMessage(message) {
      assert.equal(message, raw);
      return Buffer.from('preview media');
    },
  };

  assert.deepEqual(await downloadWhatsAppMedia(socket, raw), Buffer.from('preview media'));
});

test('media downloader uses Baileys package utility with reupload context for real sockets', async () => {
  const raw = { key: { id: 'LIVE-IMAGE' } };
  const logger = { warn() {}, error() {} };
  const calls = [];
  const socket = {
    async updateMediaMessage(message) {
      calls.push(['reupload', message]);
    },
  };
  const packageDownloader = async (...args) => {
    calls.push(args);
    return Buffer.from('downloaded media');
  };

  const buffer = await downloadWhatsAppMedia(socket, raw, logger, packageDownloader);
  assert.deepEqual(buffer, Buffer.from('downloaded media'));
  assert.equal(calls[0][0], raw);
  assert.equal(calls[0][1], 'buffer');
  assert.deepEqual(calls[0][2], {});
  assert.equal(calls[0][3].logger, logger);
  await calls[0][3].reuploadRequest({ key: { id: 'REUPLOAD' } });
  assert.deepEqual(calls[1], ['reupload', { key: { id: 'REUPLOAD' } }]);
});
