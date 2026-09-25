// SQLite storage using Node's built-in driver (Node 22.13+). No npm packages needed.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'loadboard.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS loads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT UNIQUE NOT NULL,
  ref TEXT,
  status TEXT NOT NULL DEFAULT 'open',          -- draft | open | closed | awarded
  origin_city TEXT, origin_state TEXT, origin_zip TEXT,
  dest_city TEXT, dest_state TEXT, dest_zip TEXT,
  origin_lat REAL, origin_lng REAL, dest_lat REAL, dest_lng REAL,
  route_geojson TEXT,
  miles REAL, miles_manual INTEGER DEFAULT 0,
  geo_status TEXT DEFAULT 'pending',            -- pending | ok | failed
  pickup_date TEXT, pickup_window TEXT,
  delivery_date TEXT, delivery_window TEXT,
  equipment TEXT, temp TEXT, weight INTEGER, pallets TEXT, commodity TEXT,
  stops INTEGER DEFAULT 0,
  requirements TEXT, notes TEXT,
  target_rate REAL,                             -- admin only, never shown to carriers
  bid_deadline TEXT,                            -- ISO timestamp
  contact_name TEXT, contact_phone TEXT, contact_email TEXT,
  awarded_bid_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  load_id INTEGER NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  mc TEXT NOT NULL,
  company TEXT, contact_name TEXT, email TEXT, phone TEXT,
  amount REAL NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',        -- active | awarded | lost
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (load_id, mc)
);

CREATE TABLE IF NOT EXISTS qualified_carriers (
  mc TEXT PRIMARY KEY,
  name TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// migrations
if (!db.prepare("SELECT 1 FROM pragma_table_info('qualified_carriers') WHERE name = 'email'").get()) {
  db.exec('ALTER TABLE qualified_carriers ADD COLUMN email TEXT');
}
for (const [col, def] of [['source', "TEXT DEFAULT 'manual'"], ['sync_closed', 'INTEGER DEFAULT 0'], ['customer', 'TEXT'], ['ss_row_id', 'TEXT']]) {
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('loads') WHERE name = ?`).get(col)) db.exec(`ALTER TABLE loads ADD COLUMN ${col} ${def}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS email_optout (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

function getSetting(key, fallback = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

function newPublicId() {
  // short, unguessable-enough id for share links, e.g. "L-7K3QX9"
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  const bytes = crypto.randomBytes(6);
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return 'L-' + s;
}

module.exports = { db, getSetting, setSetting, newPublicId, DATA_DIR };
