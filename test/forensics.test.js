import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import JSZip from 'jszip';

import forensicsPlugin from '../src/plugins/forensics.js';
import {
  cleanImageMetadata,
  decodeQr,
  hammingDistanceHex,
  inspectMedia,
  perceptualHash,
} from '../src/core/forensics.js';
import { getMemoryDb } from '../src/database/index.js';
import { normalize } from '../src/core/message.js';

const CHAT = '120363000000000001@g.us';
const SENDER = '15550002222@s.whatsapp.net';

async function qrBuffer(value = 'https://example.test/hello') {
  return QRCode.toBuffer(value, { type: 'png', errorCorrectionLevel: 'H', margin: 2, width: 240 });
}

function quotedCommand(command, quotedMessage) {
  return normalize({
    key: { id: `${command}-command`, remoteJid: CHAT, participant: SENDER, fromMe: false },
    message: {
      extendedTextMessage: {
        text: command,
        contextInfo: { stanzaId: 'quoted-file', participant: SENDER, quotedMessage },
      },
    },
    messageTimestamp: 1,
  });
}

async function commandContext(command, quotedMessage, bytes) {
  const out = [];
  return {
    msg: quotedCommand(command, quotedMessage), jid: CHAT,
    text: String(command).replace(/^\.[^\s]+\s*/, ''),
    socket: { async downloadMediaMessage() { return bytes; } },
    logger: { warn() {}, error() {} }, db: await getMemoryDb(),
    async reply(text) { out.push({ type: 'reply', text }); },
    async send(jid, content, options) { out.push({ type: 'send', jid, content, options }); },
    out,
  };
}

function command(name) { return forensicsPlugin.commands.find((entry) => entry.name === name); }

test('forensics decodes QR content, detects PNG, and creates a stable visual fingerprint', async () => {
  const buffer = await qrBuffer();
  const report = await inspectMedia(buffer, { media: { mimetype: 'image/png', type: 'image', payload: {} } });
  assert.equal(report.detected.mime, 'image/png');
  assert.equal(report.image.dimensions.width, 240);
  assert.equal(await decodeQr(buffer), 'https://example.test/hello');
  const hash = await perceptualHash(buffer);
  assert.match(hash, /^[0-9a-f]{16}$/);
  assert.equal(hammingDistanceHex(hash, hash), 0);
});

test('forensics strips injected JPEG EXIF/XMP-like APP1 bytes without altering image scan data', async () => {
  const scan = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  const cleaned = await cleanImageMetadata(scan, 'image/jpeg');
  assert.equal(cleaned.includes(Buffer.from('Exif')), false);
  assert.deepEqual(cleaned, Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]));
});

test('forensics preserves a clean PNG file and can still scan its QR after cleanup', async () => {
  const buffer = await qrBuffer('hello clean');
  const cleaned = await cleanImageMetadata(buffer, 'image/png');
  assert.equal(cleaned.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(await decodeQr(cleaned), 'hello clean');
});

test('forensics reads WAV audio container and technical details locally', async () => {
  const dataBytes = 8000;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  const report = await inspectMedia(wav, { media: { mimetype: 'audio/wav', type: 'audio', payload: {} } });
  assert.equal(report.av.container, 'WAVE');
  assert.equal(report.av.sampleRate, 8000);
  assert.equal(report.av.channels, 1);
});

test('forensics reads PDF document properties and active-content markers', async () => {
  const buffer = Buffer.from('%PDF-1.7\n1 0 obj << /Title (Report) /Author (Ayesha) /Creator (Writer) /Producer (PDF Engine) /CreationDate (D:20261016120000) /ModDate (D:20261017130000) /JS (app.alert) /EmbeddedFiles 2 0 R >>\nhttps://example.test/file\n%%EOF');
  const report = await inspectMedia(buffer, { media: { mimetype: 'application/pdf', type: 'document', payload: { fileName: 'report.pdf' } } });
  assert.equal(report.document.type, 'pdf');
  assert.equal(report.document.author, 'Ayesha');
  assert.equal(report.document.javascript, true);
  assert.equal(report.document.embeddedFiles, true);
  assert.deepEqual(report.document.urls, ['https://example.test/file']);
});

test('forensics reads Office core properties, macros, and external links', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('docProps/core.xml', '<cp:coreProperties xmlns:dc="x" xmlns:cp="y" xmlns:dcterms="z"><dc:creator>Ayesha</dc:creator><cp:lastModifiedBy>Hamza</cp:lastModifiedBy><dcterms:created>2026-10-16T10:00:00Z</dcterms:created></cp:coreProperties>');
  zip.file('docProps/app.xml', '<Properties><Application>Microsoft Word</Application><Pages>3</Pages></Properties>');
  zip.file('word/document.xml', '<document/>');
  zip.file('word/vbaProject.bin', Buffer.from('macro'));
  zip.file('word/_rels/document.xml.rels', '<Relationships><Relationship Target="https://example.test/template" TargetMode="External"/></Relationships>');
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const report = await inspectMedia(buffer, { media: { mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', type: 'document', payload: { fileName: 'secret.docx' } } });
  assert.equal(report.document.author, 'Ayesha');
  assert.equal(report.document.lastModifiedBy, 'Hamza');
  assert.equal(report.document.macros, true);
  assert.deepEqual(report.document.externalLinks, ['https://example.test/template']);
});

test('.md replies with a neat local report and .md full attaches raw readable fields', async () => {
  const buffer = await qrBuffer();
  const quoted = { imageMessage: { mimetype: 'image/png', mediaKey: 'a', directPath: '/image' } };
  const ctx = await commandContext('.md full', quoted, buffer);
  await command('md').execute(ctx);
  assert.match(ctx.out[0].text, /MEDIA X-RAY/);
  assert.equal(ctx.out[1].type, 'send');
  assert.equal(ctx.out[1].content.mimetype, 'text/plain');
});

test('.qr, .clean and .fingerprint operate only on the replied image bytes', async () => {
  const buffer = await qrBuffer('https://example.test/login');
  const quoted = { imageMessage: { mimetype: 'image/png', mediaKey: 'a', directPath: '/image' } };

  const qrCtx = await commandContext('.qr', quoted, buffer);
  await command('qr').execute(qrCtx);
  assert.match(qrCtx.out[0].text, /QR DECODED/);
  assert.match(qrCtx.out[0].text, /example\.test/);

  const cleanCtx = await commandContext('.clean', quoted, buffer);
  await command('clean').execute(cleanCtx);
  assert.equal(cleanCtx.out[0].content.mimetype, 'image/png');
  assert.match(cleanCtx.out[0].content.fileName, /-clean\.png$/);

  const fingerprintCtx = await commandContext('.fingerprint', quoted, buffer);
  await command('fingerprint').execute(fingerprintCtx);
  assert.match(fingerprintCtx.out[0].text, /MEDIA FINGERPRINT/);
});
