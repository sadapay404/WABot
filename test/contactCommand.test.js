import test from 'node:test';
import assert from 'node:assert/strict';

import { getMemoryDb } from '../src/database/index.js';
import { createLogger } from '../src/core/logger.js';
import { ContactStore } from '../src/core/contactStore.js';
import contactPlugin from '../src/plugins/contact.js';

const quiet = createLogger('fatal');
const OWNER = '15550001111@s.whatsapp.net';
const PN = '923001234567@s.whatsapp.net';

function context(contacts, args, replies) {
  return {
    args,
    text: args.slice(1).join(' '),
    jid: OWNER,
    sender: OWNER,
    bot: { contacts, prompts: null },
    reply: async (text) => replies.push(String(text)),
  };
}

test('.contact saves, lists, and removes an owner-persistent label without overwriting synced contact data', async () => {
  const db = await getMemoryDb();
  const contacts = new ContactStore(db, quiet);
  contacts.upsert({ id: PN, name: 'WhatsApp Saved Ayesha', notify: 'Ayesha profile' });
  const replies = [];

  await contactPlugin.execute(context(contacts, ['set', '03001234567', '|', 'Ayesha', '—', 'Doctor'], replies));
  assert.equal(contacts.profile(PN).name, 'Ayesha — Doctor');
  assert.match(replies.at(-1), /Saved \*Ayesha — Doctor\*/);

  await contactPlugin.execute(context(contacts, ['list'], replies));
  assert.match(replies.at(-1), /★ Ayesha — Doctor/);

  // A later profile sync cannot replace the owner-entered label.
  contacts.upsert({ id: PN, name: 'Changed synced name', notify: 'Changed profile' });
  assert.equal(contacts.profile(PN).name, 'Ayesha — Doctor');

  await contactPlugin.execute(context(contacts, ['remove', '03001234567'], replies));
  assert.equal(contacts.profile(PN).name, 'Changed synced name');
});
