import test from 'node:test';
import assert from 'node:assert/strict';

import { getMemoryDb } from '../src/database/index.js';
import { createLogger } from '../src/core/logger.js';
import { MessageCache } from '../src/core/messageCache.js';
import { ContactStore } from '../src/core/contactStore.js';
import { normalize } from '../src/core/message.js';
import searchPlugin from '../src/plugins/search.js';

const quiet = createLogger('fatal');
const SELF = '15550009999@s.whatsapp.net';
const CONTACT = '15550002222@s.whatsapp.net';

test('.search displays cached stanza IDs that .forward can use', async () => {
  const db = await getMemoryDb();
  const cache = new MessageCache(db, quiet);
  const contacts = new ContactStore(db, quiet);
  contacts.upsert({ id: CONTACT, name: 'Sam' });
  const raw = {
    key: { id: 'SEARCH-STANZA-1', remoteJid: CONTACT, fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1_000),
    message: { conversation: 'A searchable example phrase.' },
  };
  cache.store(raw, normalize(raw), SELF);

  let report = '';
  await searchPlugin.commands.find((command) => command.name === 'search').execute({
    text: 'searchable example',
    db,
    bot: { contacts },
    reply: async (text) => { report = String(text); },
  });

  assert.match(report, /Sam/);
  assert.match(report, /SEARCH-STANZA-1/);
  assert.match(report, /phrase\./);
});
