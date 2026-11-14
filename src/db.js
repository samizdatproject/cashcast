// SQLite storage: one row per listening session, one row per key a session has unlocked.
import Database from 'better-sqlite3';

export function openDb(file = ':memory:') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,          -- sha256 of the bearer token; the token itself is never stored
      listener_address TEXT NOT NULL,
      user_pkh TEXT NOT NULL,
      session_pk TEXT NOT NULL,
      timeout INTEGER NOT NULL,
      max_refund_fee INTEGER NOT NULL,
      address TEXT NOT NULL,
      funding_txid TEXT, funding_vout INTEGER, funding_sats INTEGER,
      paid_amount INTEGER NOT NULL DEFAULT 0, paid_sig TEXT,
      settle_txid TEXT,
      status TEXT NOT NULL DEFAULT 'open', -- open → funded → settled | refunded | expired
      created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS unlocked (
      session_id TEXT NOT NULL, track TEXT NOT NULL, segment INTEGER NOT NULL,
      PRIMARY KEY (session_id, track, segment)
    );
  `);
  // Added later: the per-segment price fixed when the session opened (sats).
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (!cols.includes('price_sats')) db.exec('ALTER TABLE sessions ADD COLUMN price_sats INTEGER');
  return db;
}
