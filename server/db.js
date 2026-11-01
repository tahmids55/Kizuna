/**
 * Database layer — PostgreSQL everywhere.
 *
 *  • Production (Render): DATABASE_URL points at Neon (or any Postgres) → node-postgres pool.
 *  • Local dev & tests:   no DATABASE_URL → PGlite, a real Postgres engine compiled to WASM that
 *                         runs inside Node (stored in data/pglite, or in memory for tests).
 *
 * Queries use `?` placeholders (converted to $1, $2, …). Inside `tx(async () => …)` every
 * helper automatically runs on the transaction's connection (AsyncLocalStorage).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL = process.env.DATABASE_URL?.trim();
const PGLITE_DIR = process.env.KIZUNA_PGLITE || path.join(ROOT, 'data', 'pglite');

export const DB_LABEL = DATABASE_URL ? `postgres (${safeHost(DATABASE_URL)})` : PGLITE_DIR === 'memory' ? 'pglite (in-memory)' : `pglite (${PGLITE_DIR})`;

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'DATABASE_URL';
  }
}

const als = new AsyncLocalStorage();
let driver = null;

async function createDriver() {
  if (DATABASE_URL) {
    const { default: pg } = await import('pg');
    // Translate libpq-style URL options (as given by Neon) into node-postgres settings:
    //   sslmode=require          → verified TLS
    //   channel_binding=require  → SCRAM-SHA-256-PLUS (node-postgres ignores the URL form)
    const url = new URL(DATABASE_URL);
    const sslmode = url.searchParams.get('sslmode');
    const channelBinding = url.searchParams.get('channel_binding') === 'require';
    url.searchParams.delete('sslmode');
    url.searchParams.delete('channel_binding');
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
    const ssl = sslmode === 'disable' || (local && !sslmode) ? false : { rejectUnauthorized: true };
    const pool = new pg.Pool({
      connectionString: url.toString(),
      ssl,
      enableChannelBinding: channelBinding,
      max: Number(process.env.DB_POOL_MAX) || 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000, // Neon may need a moment to wake from scale-to-zero
    });
    pool.on('error', (e) => console.error('postgres pool error:', e.message));
    return {
      query: (text, params) => pool.query(text, params),
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn(client);
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      },
      end: () => pool.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  if (PGLITE_DIR !== 'memory') fs.mkdirSync(PGLITE_DIR, { recursive: true });
  const lite = PGLITE_DIR === 'memory' ? new PGlite() : new PGlite(PGLITE_DIR);
  const wrap = (q) => ({ query: (text, params) => q.query(text, params).then((r) => ({ rows: r.rows, rowCount: r.affectedRows ?? 0 })) });
  return {
    ...wrap(lite),
    transaction: (fn) => lite.transaction((t) => fn(wrap(t))),
    end: () => lite.close(),
  };
}

const toPg = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

async function exec(sql, params) {
  if (!driver) throw new Error('Database not initialised — call initDb() first');
  const conn = als.getStore() ?? driver;
  return conn.query(toPg(sql), params);
}

/** All rows. */
export const all = async (sql, ...params) => (await exec(sql, params)).rows;
/** First row (or undefined). */
export const get = async (sql, ...params) => (await exec(sql, params)).rows[0];
/** Run a statement; returns the number of affected rows. */
export const run = async (sql, ...params) => (await exec(sql, params)).rowCount ?? 0;
/** INSERT … and return the new row's id. */
export const insert = async (sql, ...params) => (await exec(`${sql} RETURNING id`, params)).rows[0].id;

/** Run `fn` in a transaction. Nested calls join the outer transaction. */
export function tx(fn) {
  if (als.getStore()) return fn();
  return driver.transaction((conn) => als.run(conn, fn));
}

/** Expand an id list into `?, ?, ?` for IN (…) clauses. */
export const placeholders = (list) => list.map(() => '?').join(', ');

const NOW = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/* Timestamps are stored as ISO-8601 text (UTC) so they compare and serialise identically everywhere. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#0d9488',
  avatar        TEXT,
  status_emoji  TEXT NOT NULL DEFAULT '',
  status_text   TEXT NOT NULL DEFAULT '',
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW},
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS conversations (
  id              SERIAL PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('direct','group','self')),
  name            TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  emoji           TEXT NOT NULL DEFAULT '',
  color           TEXT NOT NULL DEFAULT '#0d9488',
  direct_key      TEXT UNIQUE,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT ${NOW},
  last_message_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  last_read_id    INTEGER NOT NULL DEFAULT 0,
  muted           INTEGER NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0,
  joined_at       TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'text'
                  CHECK (kind IN ('text','system','task','idea','goal','decision','poll','checkin')),
  body            TEXT NOT NULL DEFAULT '',
  ref_id          INTEGER,
  meta            TEXT,
  reply_to_id     INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  pinned_at       TEXT,
  pinned_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  edited_at       TEXT,
  deleted_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS mentions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions(user_id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS attachments (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  uploader_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  file_key        TEXT NOT NULL UNIQUE,
  filename        TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_id);

-- File bytes live in the database: Render's free filesystem is wiped on every restart.
CREATE TABLE IF NOT EXISTS file_blobs (
  file_key TEXT PRIMARY KEY REFERENCES attachments(file_key) ON DELETE CASCADE,
  data     BYTEA NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_messages (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (user_id, message_id)
);

CREATE TABLE IF NOT EXISTS reminders (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id      INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  note            TEXT NOT NULL DEFAULT '',
  remind_at       TEXT NOT NULL,
  sent_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(sent_at, remind_at);

CREATE TABLE IF NOT EXISTS tasks (
  id                SERIAL PRIMARY KEY,
  conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  notes             TEXT NOT NULL DEFAULT '',
  assignee_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date          TEXT,
  priority          TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
  status            TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done')),
  message_id        INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  completed_at      TEXT,
  completed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT ${NOW},
  updated_at        TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_tasks_conv ON tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);

CREATE TABLE IF NOT EXISTS ideas (
  id                SERIAL PRIMARY KEY,
  conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','exploring','accepted','parked')),
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message_id        INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT ${NOW},
  updated_at        TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS idea_votes (
  idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (idea_id, user_id)
);

CREATE TABLE IF NOT EXISTS goals (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  unit            TEXT NOT NULL DEFAULT '',
  start_value     DOUBLE PRECISION NOT NULL DEFAULT 0,
  target_value    DOUBLE PRECISION NOT NULL,
  current_value   DOUBLE PRECISION NOT NULL DEFAULT 0,
  due_date        TEXT,
  owner_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','dropped')),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT ${NOW},
  updated_at      TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS goal_updates (
  id         SERIAL PRIMARY KEY,
  goal_id    INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  value      DOUBLE PRECISION NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS decisions (
  id                SERIAL PRIMARY KEY,
  conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  context           TEXT NOT NULL DEFAULT '',
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message_id        INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS decision_acks (
  decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (decision_id, user_id)
);

CREATE TABLE IF NOT EXISTS polls (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  question        TEXT NOT NULL,
  multiple        INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  closed_at       TEXT,
  created_at      TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS poll_options (
  id       SERIAL PRIMARY KEY,
  poll_id  INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label    TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id   INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (option_id, user_id)
);
`;

/** Every table, children first — used by `seed --reset`. */
export const TABLES = [
  'poll_votes', 'poll_options', 'polls', 'decision_acks', 'decisions', 'goal_updates', 'goals', 'idea_votes', 'ideas', 'tasks',
  'reminders', 'saved_messages', 'file_blobs', 'attachments', 'reactions', 'mentions', 'messages', 'conversation_members',
  'conversations', 'sessions', 'users',
];

let ready = null;
/** Connect and create tables (idempotent). Safe to call more than once. */
export function initDb() {
  ready ??= (async () => {
    driver = await createDriver();
    // Several app instances may boot at once; a lock keeps CREATE TABLE races out.
    await driver.transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(7461001)');
      for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await c.query(stmt);
    });
  })();
  return ready;
}

export async function closeDb() {
  await driver?.end();
  driver = null;
  ready = null;
}
