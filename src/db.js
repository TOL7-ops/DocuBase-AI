/**
 * DATABASE — SQLite via better-sqlite3
 *
 * Initialises the database, runs migrations on startup.
 * Exports the db instance for use across the app.
 *
 * Schema: Contract V2 / AGENT_BUILD_V2.md
 */

const path    = require('path');
const fs      = require('fs');
const Database = require('better-sqlite3');

const DB_PATH  = process.env.DB_PATH || path.resolve(__dirname, '..', 'data', 'rag.db');
const DATA_DIR = path.dirname(DB_PATH);
console.log(`[db] using: ${DB_PATH}`);

// Ensure data/ directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Performance pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ── Schema migrations ─────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    document_id TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chunks (
    chunk_id    TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content     TEXT NOT NULL,
    char_start  INTEGER NOT NULL,
    char_end    INTEGER NOT NULL,
    embedding   TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);

  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_turns (
    turn_id      TEXT PRIMARY KEY,
    session_id   TEXT    NOT NULL,
    turn_number  INTEGER NOT NULL,
    question     TEXT    NOT NULL,
    answer       TEXT    NOT NULL,
    sources      TEXT    NOT NULL DEFAULT '[]',
    tool_used    TEXT,
    timestamp    TEXT    NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_turns_session_id ON session_turns(session_id);
`);

module.exports = db;