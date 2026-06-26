const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const _cache = new Map();

function forFamily(familyId) {
  if (_cache.has(familyId)) return _cache.get(familyId);

  const dir = path.join(DATA_DIR, familyId);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(path.join(dir, 'wa.db'));
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE,
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      is_from_me INTEGER DEFAULT 0,
      status TEXT DEFAULT 'sent',
      is_allowed INTEGER DEFAULT 1,
      is_read INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS wa_connection (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT DEFAULT 'disconnected',
      phone_number TEXT,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  const api = {
    getContacts: () =>
      db.prepare('SELECT * FROM contacts ORDER BY display_name').all(),

    addContact: (phone, name) =>
      db.prepare(
        'INSERT OR REPLACE INTO contacts (phone_number, display_name) VALUES (?,?)'
      ).run(phone, name),

    removeContact: (phone) =>
      db.prepare('DELETE FROM contacts WHERE phone_number = ?').run(phone),

    isAllowedContact: (phone) =>
      !!db.prepare('SELECT 1 FROM contacts WHERE phone_number = ?').get(phone),

    saveMessage: ({ messageId, fromNumber, toNumber, content, timestamp, isFromMe, status, isAllowed }) => {
      try {
        db.prepare(`
          INSERT OR IGNORE INTO messages
            (message_id, from_number, to_number, content, timestamp, is_from_me, status, is_allowed)
          VALUES (?,?,?,?,?,?,?,?)
        `).run(messageId, fromNumber, toNumber, content, timestamp,
          isFromMe ? 1 : 0, status, isAllowed ? 1 : 0);
      } catch (_) {}
    },

    getMessages: (number) =>
      db.prepare(`
        SELECT * FROM messages
        WHERE is_allowed = 1 AND (from_number = ? OR to_number = ?)
        ORDER BY timestamp ASC
      `).all(number, number),

    getAllMessages: (number) =>
      db.prepare(`
        SELECT * FROM messages WHERE from_number = ? OR to_number = ?
        ORDER BY timestamp ASC
      `).all(number, number),

    getChats: () => {
      const contacts = db.prepare('SELECT * FROM contacts ORDER BY display_name').all();
      return contacts.map((c) => {
        const last = db.prepare(`
          SELECT * FROM messages WHERE is_allowed = 1
          AND (from_number = ? OR to_number = ?)
          ORDER BY timestamp DESC LIMIT 1
        `).get(c.phone_number, c.phone_number);
        const unread = db.prepare(`
          SELECT COUNT(*) AS cnt FROM messages
          WHERE is_allowed = 1 AND from_number = ? AND is_read = 0
        `).get(c.phone_number)?.cnt || 0;
        return {
          ...c,
          last_message: last?.content || null,
          last_message_time: last?.timestamp || null,
          last_from_me: last?.is_from_me || 0,
          unread_count: unread,
        };
      });
    },

    getBlockedSenders: () =>
      db.prepare(`
        SELECT DISTINCT from_number FROM messages
        WHERE is_allowed = 0 AND is_from_me = 0
      `).all(),

    markRead: (number) =>
      db.prepare('UPDATE messages SET is_read = 1 WHERE from_number = ?').run(number),

    updateStatus: (messageId, status) =>
      db.prepare('UPDATE messages SET status = ? WHERE message_id = ?').run(status, messageId),

    setStatus: (status, phone) =>
      db.prepare(`
        INSERT OR REPLACE INTO wa_connection (id, status, phone_number, updated_at)
        VALUES (1, ?, ?, strftime('%s','now'))
      `).run(status, phone || null),

    getStatus: () =>
      db.prepare('SELECT * FROM wa_connection WHERE id = 1').get(),
  };

  _cache.set(familyId, api);
  return api;
}

function listFamilies() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR).filter((f) =>
    fs.existsSync(path.join(DATA_DIR, f, 'auth'))
  );
}

module.exports = { forFamily, listFamilies };
