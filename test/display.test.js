import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clock12, dateTime12, chatKind, chatTag, senderLine } from '../src/lib/display.js';
import { formatViewOnce } from '../src/core/viewOnce.js';
import { formatEdit } from '../src/core/editWatch.js';
import { formatDeletion } from '../src/core/antiDelete.js';

// 2026-10-10 15:05 in Karachi (UTC+5) = 10:05 UTC
const AFTERNOON = Date.UTC(2026, 9, 10, 10, 5);

test('clock12 renders 12-hour time in the configured zone', () => {
  assert.equal(clock12(AFTERNOON, 'Asia/Karachi'), '3:05 PM');
  assert.equal(clock12(Date.UTC(2026, 9, 10, 19, 0), 'Asia/Karachi'), '12:00 AM');
});

test('dateTime12 includes the date and a 12-hour clock', () => {
  assert.equal(dateTime12(AFTERNOON, 'Asia/Karachi'), 'Oct 10, 2026, 3:05 PM');
});

test('chatKind distinguishes group, chat, channel and status', () => {
  assert.equal(chatKind('120363000000000001@g.us'), 'Group');
  assert.equal(chatKind('923001234567@s.whatsapp.net'), 'Chat');
  assert.equal(chatKind('123456789@lid'), 'Chat');
  assert.equal(chatKind('120363000000000002@newsletter'), 'Channel');
  assert.equal(chatKind('status@broadcast'), 'Status');
});

test('senderLine always shows the number next to the name when known', () => {
  assert.equal(
    senderLine({ name: 'Ali', nameSource: 'contact', phoneE164: '+923001234567' }),
    'Ali (+923001234567)'
  );
  assert.equal(senderLine({ name: '923001234567', nameSource: 'jid', phoneE164: '+923001234567' }), '+923001234567');
  assert.equal(senderLine({ name: 'Ali', nameSource: 'contact', phoneE164: null }), 'Ali (number not known)');
  assert.equal(senderLine({}), 'unknown sender (number not known)');
});

test('alerts show sender with number, chat type and 12-hour time', () => {
  const profile = { name: 'Ali', nameSource: 'contact', phoneE164: '+923001234567', countryName: 'Pakistan' };
  const base = {
    profile, chatJid: '120363000000000001@g.us', chatLabel: 'Family', at: AFTERNOON,
    kind: 'image', status: 'captured', mediaBytes: 2048, caption: null,
  };

  const viewOnce = formatViewOnce(base);
  assert.match(viewOnce, /Ali \(\+923001234567\)/);
  assert.match(viewOnce, /Group: Family/);
  assert.match(viewOnce, /3:05 PM/);

  const edit = formatEdit({
    profile, chatJid: '923001234567@s.whatsapp.net', chatLabel: 'Ali (+923001234567)',
    at: AFTERNOON, before: 'hi', after: 'hello', isGroup: false, senderJid: '923001234567@s.whatsapp.net',
  });
  assert.match(edit, /Chat: Ali/);
  assert.match(edit, /3:05 PM/);
  assert.doesNotMatch(edit, /\b15:05\b/);

  const deletion = formatDeletion({
    profile, chatJid: '120363000000000001@g.us', chatLabel: 'Family', at: AFTERNOON,
    record: { kind: 'chat', has_media: false }, text: 'bye', senderJid: '923001234567@s.whatsapp.net',
  });
  assert.match(deletion, /Group: Family/);
  assert.match(deletion, /3:05 PM/);
});

test('chatTag combines the type and label', () => {
  assert.equal(chatTag('120363000000000001@g.us', 'Family'), 'Group: Family');
});
