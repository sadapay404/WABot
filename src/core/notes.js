/**
 * Nexus-WA — notes and todos.
 *
 * Capture from any chat, because the useful property is that your phone is
 * already in your hand. Todos can carry a reminder time, in which case the
 * scheduler owns the actual delivery.
 */

export class NoteStore {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger.child({ scope: 'notes' });
  }

  add(text, { kind = 'note', remindAt = null } = {}) {
    if (!text?.trim()) throw new Error('nothing to save');
    const res = this.db
      .prepare('INSERT INTO notes(kind, text, done, remind_at, created_at) VALUES (?,?,0,?,?)')
      .run(kind, text.trim(), remindAt, Date.now());
    return this.get(Number(res.lastInsertRowid));
  }

  get(id) {
    return this.db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(id)) || null;
  }

  list({ kind = null, includeDone = false, limit = 50 } = {}) {
    const clauses = [];
    const params = [];
    if (kind) {
      clauses.push('kind = ?');
      params.push(kind);
    }
    if (!includeDone) clauses.push('done = 0');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM notes ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit);
  }

  complete(id) {
    const res = this.db
      .prepare('UPDATE notes SET done = 1, done_at = ? WHERE id = ? AND done = 0')
      .run(Date.now(), Number(id));
    return (res.changes || 0) > 0;
  }

  remove(id) {
    return (this.db.prepare('DELETE FROM notes WHERE id = ?').run(Number(id)).changes || 0) > 0;
  }

  /** Todos whose reminder is due and not yet done. */
  dueReminders(now = Date.now()) {
    return this.db
      .prepare('SELECT * FROM notes WHERE kind = ? AND done = 0 AND remind_at IS NOT NULL AND remind_at <= ?')
      .all('todo', now);
  }

  clearDueReminder(id) {
    this.db.prepare('UPDATE notes SET remind_at = NULL WHERE id = ?').run(Number(id));
  }

  /** Full-text-ish search over note bodies. */
  search(query, limit = 20) {
    const like = `%${String(query).replace(/[%_]/g, '')}%`;
    return this.db
      .prepare('SELECT * FROM notes WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?')
      .all(like, limit);
  }

  summary() {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN kind='note' AND done=0 THEN 1 ELSE 0 END) AS notes,
           SUM(CASE WHEN kind='todo' AND done=0 THEN 1 ELSE 0 END) AS todos,
           SUM(CASE WHEN done=1 THEN 1 ELSE 0 END) AS done
         FROM notes`
      )
      .get();
    return { notes: row.notes || 0, todos: row.todos || 0, done: row.done || 0 };
  }
}

export default NoteStore;
