const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'tickets.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  tagline TEXT,
  prefix TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('player','team','spectator')),
  capacity INTEGER,                       -- NULL = unlimited (counted in slots: players, teams or seats)
  price INTEGER NOT NULL,                 -- KES per slot (per player / per team / per spectator)
  tickets_per_slot INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
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
  holders TEXT NOT NULL,                  -- JSON array of ticket holder names
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed | cancelled | review
  merchant_request_id TEXT,
  checkout_request_id TEXT UNIQUE,
  mpesa_receipt TEXT UNIQUE,
  result_desc TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  emailed_at INTEGER,
  email_error TEXT,
  last_query_at INTEGER
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  serial TEXT UNIQUE NOT NULL,            -- UNIQUE constraint = no duplicate serials, ever
  order_id INTEGER NOT NULL REFERENCES orders(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  holder_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid',   -- valid | used | void
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT
);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY,
  serial TEXT,
  result TEXT NOT NULL,                   -- VALID | ALREADY_USED | INVALID | VOID
  scanned_at INTEGER NOT NULL,
  scanned_by TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS mpesa_callbacks (
  id INTEGER PRIMARY KEY,
  checkout_request_id TEXT,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_event_status ON orders(event_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);
CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets(order_id);
CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id, status);
`);

// Seed the six categories once. Prices are placeholders; change them in the admin page.
if (db.prepare('SELECT COUNT(*) c FROM events').get().c === 0) {
  const ins = db.prepare(`INSERT INTO events (code,name,tagline,prefix,kind,capacity,price,tickets_per_slot,sort)
                          VALUES (?,?,?,?,?,?,?,?,?)`);
  [
    ['konami', 'KONAMI (PES)', 'eFootball / PES 1v1 knockout', 'KON', 'player', 64, 500, 1, 1],
    ['fifa', 'FIFA', 'EA FC 1v1 knockout', 'FIF', 'player', 64, 500, 1, 2],
    ['cod', 'Call of Duty', 'Teams of 4 · one ticket per player', 'COD', 'team', 16, 2000, 4, 3],
    ['chess', 'Chess', 'Open tournament', 'CHS', 'player', 64, 300, 1, 4],
    ['pool', 'Pool', 'Singles knockout', 'POL', 'player', 32, 300, 1, 5],
    ['spectator', 'Spectator', 'Watch the action live', 'SPC', 'spectator', null, 200, 1, 6],
  ].forEach((r) => ins.run(...r));
}

// Secret used to sign QR codes and staff tokens. Generated once and persisted.
function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  const f = path.join(dataDir, '.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

module.exports = { db, dataDir, secret: loadSecret() };
