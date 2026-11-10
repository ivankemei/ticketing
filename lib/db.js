const { Pool, types } = require('pg');
const { DB_URL } = require('./config');

types.setTypeParser(20, (v) => parseInt(v, 10)); // bigint (COUNT, BIGINT columns) -> number
types.setTypeParser(1700, (v) => parseFloat(v)); // numeric (SUM) -> number

if (!DB_URL) console.error('DATABASE_URL is not set. Add a Postgres database (see README).');

const local = /localhost|127\.0\.0\.1/.test(DB_URL);
const pool = new Pool({
  connectionString: DB_URL,
  max: Number(process.env.PG_POOL_MAX || 3),
  idleTimeoutMillis: 10000,
  ssl: local || /sslmode=/.test(DB_URL) ? undefined : { rejectUnauthorized: false },
});
pool.on('error', (e) => console.error('[pg pool]', e.message));

const q = (text, params) => pool.query(text, params);

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    c.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  tagline TEXT,
  prefix TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('player','team','spectator')),
  capacity INTEGER,
  price INTEGER NOT NULL,
  tickets_per_slot INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  public_id TEXT UNIQUE NOT NULL,
  token TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  team_name TEXT,
  game_id TEXT,
  slots INTEGER NOT NULL,
  ticket_count INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  holders TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  merchant_request_id TEXT,
  checkout_request_id TEXT UNIQUE,
  mpesa_receipt TEXT UNIQUE,
  result_desc TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  paid_at BIGINT,
  emailed_at BIGINT,
  email_attempt_at BIGINT,
  email_error TEXT,
  last_query_at BIGINT
);
CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  serial TEXT UNIQUE NOT NULL,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  holder_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid',
  created_at BIGINT NOT NULL,
  used_at BIGINT,
  used_by TEXT
);
CREATE TABLE IF NOT EXISTS scans (
  id SERIAL PRIMARY KEY,
  serial TEXT,
  result TEXT NOT NULL,
  scanned_at BIGINT NOT NULL,
  scanned_by TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS mpesa_callbacks (
  id SERIAL PRIMARY KEY,
  checkout_request_id TEXT,
  payload TEXT NOT NULL,
  received_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS stk_requests (
  checkout_request_id TEXT PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_hits (key TEXT NOT NULL, ts BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_orders_event_status ON orders(event_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);
CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets(order_id);
CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id, status);
CREATE INDEX IF NOT EXISTS idx_rate_hits ON rate_hits(key, ts);
`;

const SEED = [
  // code, name, tagline, prefix, kind, capacity, price (KES), tickets_per_slot, sort
  ['konami', 'KONAMI (PES)', 'eFootball / PES 1v1 knockout', 'KON', 'player', 64, 1000, 1, 1],
  ['fifa', 'FIFA', 'EA FC 1v1 knockout', 'FIF', 'player', 64, 1000, 1, 2],
  ['cod', 'Call of Duty', 'Teams of 4 · one ticket per player', 'COD', 'team', 16, 5000, 4, 3],
  ['chess', 'Chess', 'Open tournament', 'CHS', 'player', 64, 800, 1, 4],
  ['pool', 'Pool', 'Singles knockout', 'POL', 'player', 32, 800, 1, 5],
  ['spectator', 'Spectator', 'Watch the action live', 'SPC', 'spectator', null, 200, 1, 6],
];

let readyPromise;
// Creates tables and seeds the six categories on first run. Safe to call on every cold start.
function ready() {
  if (!readyPromise) {
    readyPromise = tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(727001)');
      await c.query(SCHEMA);
      const n = (await c.query('SELECT COUNT(*) AS n FROM events')).rows[0].n;
      if (n === 0) {
        for (const r of SEED)
          await c.query('INSERT INTO events (code,name,tagline,prefix,kind,capacity,price,tickets_per_slot,sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', r);
      }
    }).catch((e) => { readyPromise = null; throw e; });
  }
  return readyPromise;
}

module.exports = { pool, q, tx, ready };
