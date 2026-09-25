// Freight Load Board — carriers view loads and bid; admin posts loads and awards.
// Zero third-party dependencies. Requires Node.js 22.13 or newer.
process.env.TZ = 'UTC'; // parse times without a zone as UTC, then shift to TIMEZONE below
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSetting, setSetting, newPublicId } = require('./lib/db');
const qualify = require('./lib/qualify');
const geo = require('./lib/geo');
const { parseAny, rowsToObjects } = require('./lib/sheet');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || getSetting('session_secret') || (() => {
  const s = crypto.randomBytes(32).toString('hex'); setSetting('session_secret', s); return s;
})();
const PUBLIC_DIR = path.join(__dirname, 'public');
const TIMEZONE = process.env.TIMEZONE || 'America/Denver';
const LOAD_SYNC_MINUTES = Number(process.env.LOAD_SYNC_MINUTES || 5);

// "2026-09-30 15:00" typed in a sheet means 3 PM in your time zone, not UTC.
function localToIso(str) {
  const s = String(str).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) { const t = Date.parse(s); return isNaN(t) ? null : new Date(t).toISOString(); }
  const naive = Date.parse(s.replace(/^(\d{4}-\d{2}-\d{2})[ T]/, '$1T'));
  if (isNaN(naive)) return null;
  const offset = at => Date.parse(new Date(at).toLocaleString('en-US', { timeZone: TIMEZONE, hour12: false }).replace(', 24:', ', 00:') + ' UTC') - at;
  let t = naive - offset(naive);
  t = naive - offset(t);
  return new Date(t).toISOString();
}

if (!ADMIN_PASSWORD) console.warn('\n  !! ADMIN_PASSWORD is not set. Admin login is disabled until you set it.\n');

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8' };

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
const fail = (res, status, message) => send(res, status, { error: message });

function readBody(req, limit = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Upload too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, file) {
  const p = path.join(PUBLIC_DIR, file);
  if (!p.startsWith(PUBLIC_DIR)) return fail(res, 404, 'Not found');
  fs.readFile(p, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=300' });
    res.end(data);
  });
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

// simple in-memory rate limiter
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600000)) hits.delete(k); }, 600000).unref();

// ---------- admin session (signed cookie) ----------
function sign(v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url'); }
function makeToken() { const exp = Date.now() + 1000 * 60 * 60 * 12; return `${exp}.${sign(String(exp))}`; }
function isAdmin(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)lb_admin=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function cookie(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return `lb_admin=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// ---------- loads ----------
const LOAD_FIELDS = ['ref', 'status', 'origin_city', 'origin_state', 'origin_zip', 'dest_city', 'dest_state', 'dest_zip',
  'pickup_date', 'pickup_window', 'delivery_date', 'delivery_window', 'equipment', 'temp', 'weight', 'pallets', 'commodity',
  'stops', 'requirements', 'notes', 'target_rate', 'bid_deadline', 'contact_name', 'contact_phone', 'contact_email', 'miles', 'customer'];
const PUBLIC_FIELDS = ['public_id', 'ref', 'status', 'origin_city', 'origin_state', 'origin_zip', 'dest_city', 'dest_state', 'dest_zip',
  'origin_lat', 'origin_lng', 'dest_lat', 'dest_lng', 'miles', 'pickup_date', 'pickup_window', 'delivery_date', 'delivery_window',
  'equipment', 'temp', 'weight', 'pallets', 'commodity', 'stops', 'requirements', 'notes', 'bid_deadline',
  'contact_name', 'contact_phone', 'contact_email', 'updated_at'];
const STATUSES = ['draft', 'open', 'closed', 'awarded'];

function cleanLoad(input) {
  const out = {};
  for (const f of LOAD_FIELDS) {
    if (!(f in input)) continue;
    let v = input[f];
    if (typeof v === 'string') v = v.trim();
    if (v === '') v = null;
    if (['weight', 'stops'].includes(f) && v != null) v = Math.round(Number(String(v).replace(/[^0-9.]/g, ''))) || null;
    if (['target_rate', 'miles'].includes(f) && v != null) v = Number(String(v).replace(/[^0-9.]/g, '')) || null;
    if (['origin_state', 'dest_state'].includes(f) && v) v = String(v).toUpperCase().slice(0, 3);
    if (f === 'status' && !STATUSES.includes(v)) v = 'open';
    if (f === 'bid_deadline' && v) v = localToIso(v);
    if (typeof v === 'string') v = v.slice(0, 2000);
    out[f] = v;
  }
  return out;
}

function biddingOpen(L) {
  return L.status === 'open' && (!L.bid_deadline || Date.parse(L.bid_deadline) > Date.now());
}

const bidStats = db.prepare(`SELECT COUNT(*) AS bid_count, MIN(amount) AS low_bid FROM bids WHERE load_id = ?`);

const passStats = db.prepare(`SELECT COUNT(*) AS pass_count, MIN(b.amount) AS low_pass_bid FROM bids b
  JOIN qualified_carriers q ON q.mc = b.mc WHERE b.load_id = ?`);

function publicLoad(L) {
  const o = {};
  for (const f of PUBLIC_FIELDS) o[f] = L[f];
  const s = bidStats.get(L.id);
  o.bid_count = s.bid_count; o.low_bid = s.low_bid;
  o.bidding_open = biddingOpen(L);
  o.bid_step = bidStep();
  o.route = L.route_geojson ? JSON.parse(L.route_geojson) : null;
  return o;
}

function adminLoad(L) {
  const s = bidStats.get(L.id);
  const h = passStats.get(L.id);
  return { ...L, route_geojson: undefined, bid_count: s.bid_count, low_bid: s.low_bid, bidding_open: biddingOpen(L),
    pass_count: h.pass_count, low_pass_bid: h.low_pass_bid };
}

function insertLoad(data) {
  const d = cleanLoad(data);
  d.public_id = newPublicId();
  d.status = d.status || 'open';
  d.miles_manual = d.miles ? 1 : 0;
  d.geo_status = 'pending';
  const cols = Object.keys(d);
  const r = db.prepare(`INSERT INTO loads (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => d[c]));
  const id = Number(r.lastInsertRowid);
  geo.enqueue(id);
  return id;
}

function updateLoad(id, data) {
  const before = db.prepare('SELECT * FROM loads WHERE id = ?').get(id);
  if (!before) return false;
  const d = cleanLoad(data);
  if ('miles' in d) d.miles_manual = d.miles ? 1 : 0;
  const addrChanged = ['origin_city', 'origin_state', 'origin_zip', 'dest_city', 'dest_state', 'dest_zip'].some(f => f in d && d[f] !== before[f]);
  if (addrChanged || ('miles' in d && !d.miles && before.miles_manual) || before.geo_status === 'failed') d.geo_status = 'pending';
  const cols = Object.keys(d);
  if (!cols.length) return true;
  db.prepare(`UPDATE loads SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...cols.map(c => d[c]), id);
  if (d.geo_status === 'pending') geo.enqueue(id);
  return true;
}

// Map a spreadsheet row (bulk import) to load fields. Accepts friendly header names.
const IMPORT_ALIASES = {
  ref: ['ref', 'reference', 'load', 'load_number', 'load', 'order', 'order_number', 'po', 'bol'],
  origin_city: ['origin_city', 'pickup_city', 'from_city', 'shipper_city'],
  origin_state: ['origin_state', 'pickup_state', 'from_state', 'shipper_state'],
  origin_zip: ['origin_zip', 'pickup_zip', 'from_zip', 'shipper_zip'],
  dest_city: ['dest_city', 'destination_city', 'delivery_city', 'to_city', 'consignee_city'],
  dest_state: ['dest_state', 'destination_state', 'delivery_state', 'to_state', 'consignee_state'],
  dest_zip: ['dest_zip', 'destination_zip', 'delivery_zip', 'to_zip', 'consignee_zip'],
  pickup_date: ['pickup_date', 'ship_date', 'pu_date'],
  pickup_window: ['pickup_window', 'pickup_time', 'pu_time', 'pu_window'],
  delivery_date: ['delivery_date', 'del_date', 'due_date'],
  delivery_window: ['delivery_window', 'delivery_time', 'del_time', 'del_window'],
  equipment: ['equipment', 'equipment_type', 'trailer', 'trailer_type', 'mode'],
  temp: ['temp', 'temperature', 'reefer_temp'],
  weight: ['weight', 'weight_lbs', 'lbs'],
  pallets: ['pallets', 'pallet_count', 'pieces', 'units'],
  commodity: ['commodity', 'product', 'description'],
  stops: ['stops', 'extra_stops'],
  requirements: ['requirements', 'special_requirements', 'accessorials'],
  notes: ['notes', 'comments'],
  target_rate: ['target_rate', 'target', 'budget'],
  bid_deadline: ['bid_deadline', 'deadline', 'bids_due', 'bid_due'],
  miles: ['miles', 'distance'],
  contact_name: ['contact_name', 'contact'], contact_phone: ['contact_phone', 'phone'], contact_email: ['contact_email', 'email'],
  status: ['status'],
};
function excelDate(v) {
  // Excel serial dates (e.g. 46300) -> YYYY-MM-DD
  if (/^\d{5}(\.\d+)?$/.test(v)) { const d = new Date(Date.UTC(1899, 11, 30) + Number(v) * 86400000); return d.toISOString().slice(0, 10); }
  const t = Date.parse(v); return isNaN(t) ? v : new Date(t).toISOString().slice(0, 10);
}
function mapImportRow(obj, keepEmpty = false) {
  const out = {};
  for (const [field, names] of Object.entries(IMPORT_ALIASES)) {
    const k = names.find(n => obj[n] != null && obj[n] !== '');
    if (k) out[field] = obj[k];
    else if (keepEmpty && names.some(n => n in obj)) out[field] = ''; // column exists but cell is blank -> clear it
  }
  if (out.pickup_date) out.pickup_date = excelDate(out.pickup_date);
  if (out.delivery_date) out.delivery_date = excelDate(out.delivery_date);
  if (out.bid_deadline && /^\d{5}(\.\d+)?$/.test(out.bid_deadline)) out.bid_deadline = localToIso(new Date(Date.UTC(1899, 11, 30) + Number(out.bid_deadline) * 86400000).toISOString().slice(0, 16).replace('T', ' '));
  if (out.status) out.status = String(out.status).toLowerCase();
  return out;
}

const TEMPLATE_CSV = "Load #,Pickup City,Pickup State,Pickup Zip,Delivery City,Delivery State,Delivery Zip,Pickup Date,Pickup Window,Delivery Date,Delivery Window,Equipment,Temp,Weight,Pallets,Commodity,Stops,Requirements,Notes,Target Rate,Bid Deadline,Miles,Status\n" +
  "SO-10421,Salt Lake City,UT,84104,Dallas,TX,75212,10/2/2026,08:00-14:00,10/5/2026,FCFS 06:00-12:00,53' Dry Van,,38500,22,Packaged candy,0,Load locks required,,2200,9/30/2026 15:00,,open\n";

function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

function bidStep() {
  const n = Number(getSetting('bid_step', '50'));
  return isFinite(n) && n >= 0 ? n : 50;
}

function publicConfig() {
  return {
    company: getSetting('company_name', 'Brock LLC MC# 375005'),
    tagline: getSetting('board_tagline', 'Truckload freight available for bid'),
    contact_phone: getSetting('default_contact_phone', ''),
    contact_email: getSetting('default_contact_email', ''),
    bid_step: bidStep(),
    bid_terms: getSetting('bid_terms', `Bids are all-in USD (linehaul + fuel).${bidStep() ? ` Bids go in $${bidStep()} steps (e.g. $1,000, $${(1000 + bidStep()).toLocaleString('en-US')}), and a new low must be at least $${bidStep()} under the current bid.` : ''} Submitting a bid does not guarantee award; we will contact the awarded carrier directly.`),
  };
}



// ---------- Google Sheet load sync ----------
// The sheet is the source of truth for loads that came from it (matched by Load #).
// New row -> new load. Changed row -> load updated. Row deleted -> load closed (bids kept).
let syncing = null;
async function syncLoadsFromSheet() {
  const url = getSetting('load_sheet_url');
  if (!url) throw new Error('No load sheet link saved yet.');
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      const res = await fetch(qualify.toDownloadUrl(url), { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`The load sheet link returned HTTP ${res.status}. Make sure it's shared as "Anyone with the link can view".`);
      const rows = rowsToObjects(parseAny(Buffer.from(await res.arrayBuffer())));
      if (rows.length && !Object.keys(rows[0]).some(k => IMPORT_ALIASES.ref.includes(k)))
        throw new Error('The load sheet needs a "Load #" column (header: ref, Load Number, Order, PO or BOL) so each row can be matched to a load.');
      const seen = new Set(), skipped = [];
      let created = 0, updated = 0, closed = 0;
      const find = db.prepare(`SELECT * FROM loads WHERE source = 'sheet' AND ref = ?`);
      rows.forEach((r, i) => {
        const L = mapImportRow(r, true);
        const ref = String(L.ref || '').trim();
        const hasContent = Object.values(r).some(v => String(v).trim() !== '');
        if (!ref) { if (hasContent) skipped.push({ row: i + 2, reason: 'no Load #' }); return; }
        if (seen.has(ref)) { skipped.push({ row: i + 2, reason: `duplicate Load # ${ref}` }); return; }
        if (!(L.origin_city || L.origin_zip) || !(L.dest_city || L.dest_zip)) { skipped.push({ row: i + 2, reason: 'missing origin or destination' }); return; }
        seen.add(ref);
        const sheetStatus = ['open', 'draft', 'closed'].includes(L.status) ? L.status : null;
        const existing = find.get(ref);
        if (!existing) {
          const id = insertLoad({ ...L, status: sheetStatus || 'open' });
          db.prepare(`UPDATE loads SET source = 'sheet' WHERE id = ?`).run(id);
          created++; return;
        }
        const patch = cleanLoad(L);
        delete patch.status;
        if (existing.status !== 'awarded') {
          if (sheetStatus && sheetStatus !== existing.status) patch.status = sheetStatus;
          else if (!sheetStatus && existing.status === 'closed' && existing.sync_closed) patch.status = 'open'; // row came back
        }
        if (!patch.miles && !existing.miles_manual) delete patch.miles; // keep calculated miles
        const changed = Object.keys(patch).filter(k => String(patch[k] ?? '') !== String(existing[k] ?? ''));
        if (changed.length || existing.sync_closed) {
          const diff = Object.fromEntries(changed.map(k => [k, patch[k]]));
          if (changed.length) updateLoad(existing.id, diff);
          db.prepare('UPDATE loads SET sync_closed = 0 WHERE id = ?').run(existing.id);
          if (changed.length) updated++;
        }
      });
      // rows removed from the sheet -> close those loads (never delete; bids are kept)
      for (const L of db.prepare(`SELECT id, ref FROM loads WHERE source = 'sheet' AND status IN ('open','draft')`).all()) {
        if (!seen.has(L.ref)) {
          db.prepare(`UPDATE loads SET status = 'closed', sync_closed = 1, updated_at = datetime('now') WHERE id = ?`).run(L.id);
          closed++;
        }
      }
      const result = { created, updated, closed, rows: seen.size, skipped, at: new Date().toISOString() };
      setSetting('load_sync_last', JSON.stringify(result));
      setSetting('load_sync_error', '');
      return result;
    } catch (e) {
      setSetting('load_sync_error', e.message);
      throw e;
    } finally { syncing = null; }
  })();
  return syncing;
}
function loadSyncStatus() {
  let last = null; try { last = JSON.parse(getSetting('load_sync_last') || 'null'); } catch (_) { /* ignore */ }
  return { url: getSetting('load_sheet_url', ''), last, error: getSetting('load_sync_error', ''), minutes: LOAD_SYNC_MINUTES,
    sheetLoads: db.prepare(`SELECT COUNT(*) AS n FROM loads WHERE source = 'sheet' AND status = 'open'`).get().n };
}
function startLoadSync() {
  const tick = () => {
    if (!getSetting('load_sheet_url')) return;
    let last = null; try { last = JSON.parse(getSetting('load_sync_last') || 'null'); } catch (_) { /* ignore */ }
    const age = last ? (Date.now() - Date.parse(last.at)) / 60000 : Infinity;
    if (age >= LOAD_SYNC_MINUTES || getSetting('load_sync_error')) syncLoadsFromSheet().catch(e => console.warn('[loads] sync failed:', e.message));
  };
  setTimeout(tick, 8000);
  setInterval(tick, 60000).unref();
}

// ---------- Smartsheet load sync ----------
// Reads the LOAD BOARD sheet: POST checked -> live, unchecked/deleted -> closed. Matched by LOAD #.
// Writes back BOARD STATUS, BIDS, LOW BID, HWY PASS BIDS, AWARDED *, LOAD LINK, LAST SYNC.
const SS_API = (process.env.SMARTSHEET_API || 'https://api.smartsheet.com/2.0').replace(/\/$/, '');
const SS_MINUTES = Number(process.env.SMARTSHEET_SYNC_MINUTES || 3);
const ssToken = () => process.env.SMARTSHEET_TOKEN || '';
const ssSheetId = () => getSetting('ss_sheet_id') || process.env.SMARTSHEET_SHEET_ID || '7699725211094916';
const SS_READ = {
  'LOAD #': 'ref', 'CUSTOMER': 'customer', 'PICKUP CITY': 'origin_city', 'PICKUP ST': 'origin_state', 'PICKUP ZIP': 'origin_zip',
  'DELIVERY CITY': 'dest_city', 'DELIVERY ST': 'dest_state', 'DELIVERY ZIP': 'dest_zip', 'PICKUP DATE': 'pickup_date',
  'PICKUP WINDOW': 'pickup_window', 'DELIVERY DATE': 'delivery_date', 'DELIVERY WINDOW': 'delivery_window', 'EQUIPMENT': 'equipment',
  'TEMP': 'temp', 'WEIGHT': 'weight', 'PALLETS': 'pallets', 'COMMODITY': 'commodity', 'STOPS': 'stops', 'REQUIREMENTS': 'requirements',
  'NOTES': 'notes', 'TARGET RATE': 'target_rate', 'MILES': 'miles',
};
const SS_WRITE = ['BOARD STATUS', 'BIDS', 'LOW BID', 'HWY PASS BIDS', 'AWARDED CARRIER', 'AWARDED MC', 'AWARDED RATE', 'LOAD LINK', 'LAST SYNC'];

async function ssFetch(pathname, opts = {}) {
  const res = await fetch(SS_API + pathname, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${ssToken()}`, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (_) { /* not json */ }
  if (!res.ok) {
    const msg = j && j.message ? j.message : `HTTP ${res.status}`;
    if (res.status === 401) throw new Error('Smartsheet rejected the token. Check SMARTSHEET_TOKEN in Render (Environment).');
    if (res.status === 404) throw new Error(`Smartsheet sheet ${ssSheetId()} not found, or the token's account can't open it.`);
    throw new Error('Smartsheet: ' + msg);
  }
  return j;
}

function parseTime(t) {
  const m = String(t || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?$/i);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0);
  if (m[3]) { const pm = m[3].toLowerCase() === 'p'; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  if (h > 23 || min > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

function boardStatus(L) {
  if (!L) return 'CLOSED';
  if (L.status === 'awarded') return 'AWARDED';
  if (L.status === 'open') return biddingOpen(L) ? 'LIVE' : 'EXPIRED';
  return 'CLOSED';
}

let ssSyncing = null, ssSoon = null;
async function syncSmartsheet() {
  if (!ssToken()) throw new Error('SMARTSHEET_TOKEN is not set in Render (Environment).');
  if (ssSyncing) return ssSyncing;
  ssSyncing = (async () => {
    try {
      const sheet = await ssFetch(`/sheets/${ssSheetId()}`);
      const colByTitle = {}, titleById = {};
      for (const c of sheet.columns) { colByTitle[c.title.trim().toUpperCase()] = c; titleById[c.id] = c.title.trim().toUpperCase(); }
      if (!colByTitle['LOAD #'] || !colByTitle['POST']) throw new Error('The Smartsheet needs "LOAD #" and "POST" columns.');
      const base = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : getSetting('base_url', '');
      const find = db.prepare(`SELECT * FROM loads WHERE source = 'smartsheet' AND ref = ?`);
      const seen = new Set(), skipped = [], errors = new Map();
      let created = 0, updated = 0, closed = 0;
      const rowInfo = [];
      sheet.rows.forEach((row, i) => {
        const cell = {};
        for (const c of row.cells || []) cell[titleById[c.columnId]] = c.value;
        const ref = String(cell['LOAD #'] ?? '').trim();
        const hasContent = Object.entries(cell).some(([k, v]) => !SS_WRITE.includes(k) && v != null && String(v).trim() !== '' && v !== false);
        if (!ref) { if (hasContent) skipped.push({ row: i + 1, reason: 'no LOAD #' }); return; }
        if (seen.has(ref)) { skipped.push({ row: i + 1, reason: `duplicate LOAD # ${ref}` }); errors.set(row.id, 'dup'); rowInfo.push({ row, cell, ref }); return; }
        seen.add(ref);
        rowInfo.push({ row, cell, ref });
        const L = {};
        for (const [title, field] of Object.entries(SS_READ)) if (title in colByTitle) L[field] = cell[title] ?? '';
        L.ref = ref;
        if (colByTitle['BID DUE DATE']) {
          const d = cell['BID DUE DATE'];
          L.bid_deadline = d ? `${String(d).slice(0, 10)} ${parseTime(cell['BID DUE TIME']) || '23:59'}` : '';
        }
        const post = cell['POST'] === true;
        const existing = find.get(ref);
        const complete = (L.origin_city || L.origin_zip) && (L.dest_city || L.dest_zip);
        if (!complete) { if (post) { skipped.push({ row: i + 1, reason: `${ref}: missing pickup or delivery city/ZIP` }); errors.set(row.id, 'err'); } if (!existing) return; }
        if (!existing) {
          if (!post) return; // only create when POST is checked
          const id = insertLoad({ ...L, status: 'open' });
          db.prepare(`UPDATE loads SET source = 'smartsheet', ss_row_id = ? WHERE id = ?`).run(String(row.id), id);
          created++; return;
        }
        const patch = complete ? cleanLoad(L) : {};
        if (existing.status !== 'awarded') {
          const want = post && complete ? 'open' : 'closed';
          if (want !== existing.status) patch.status = want;
        }
        if (!patch.miles && !existing.miles_manual) delete patch.miles;
        const changed = Object.keys(patch).filter(k => String(patch[k] ?? '') !== String(existing[k] ?? ''));
        if (changed.length) {
          updateLoad(existing.id, Object.fromEntries(changed.map(k => [k, patch[k]])));
          if (patch.status === 'closed') closed++; else updated++;
        }
        if (existing.ss_row_id !== String(row.id)) db.prepare('UPDATE loads SET ss_row_id = ? WHERE id = ?').run(String(row.id), existing.id);
      });
      // rows deleted from the sheet -> close
      for (const L of db.prepare(`SELECT id, ref FROM loads WHERE source = 'smartsheet' AND status IN ('open','draft')`).all()) {
        if (!seen.has(L.ref)) { db.prepare(`UPDATE loads SET status = 'closed', updated_at = datetime('now') WHERE id = ?`).run(L.id); closed++; }
      }
      // write results back to the sheet (only cells that changed)
      const stamp = new Date().toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TIMEZONE });
      const updates = [];
      for (const { row, cell, ref } of rowInfo) {
        const L = find.get(ref);
        const vals = {};
        if (errors.get(row.id) === 'dup') vals['BOARD STATUS'] = 'ERROR';
        else if (errors.get(row.id) === 'err' && !L) vals['BOARD STATUS'] = 'ERROR';
        else if (!L) { if (cell['BOARD STATUS'] || cell['LOAD LINK']) Object.assign(vals, { 'BOARD STATUS': '', 'LOAD LINK': '' }); else continue; }
        else {
          const st = bidStats.get(L.id), hp = passStats.get(L.id);
          const win = L.awarded_bid_id ? db.prepare('SELECT * FROM bids WHERE id = ?').get(L.awarded_bid_id) : null;
          Object.assign(vals, {
            'BOARD STATUS': errors.get(row.id) === 'err' ? 'ERROR' : boardStatus(L),
            'BIDS': st.bid_count || 0, 'LOW BID': st.low_bid ?? '', 'HWY PASS BIDS': hp.pass_count || 0,
            'AWARDED CARRIER': win ? win.company : '', 'AWARDED MC': win ? win.mc : '', 'AWARDED RATE': win ? win.amount : '',
            'LOAD LINK': base ? `${base}/load/${L.public_id}` : '',
          });
        }
        const cells = [];
        for (const [title, v] of Object.entries(vals)) {
          const col = colByTitle[title]; if (!col) continue;
          if (String(cell[title] ?? '') !== String(v ?? '')) cells.push({ columnId: col.id, value: v === '' ? '' : v });
        }
        if (cells.length && colByTitle['LAST SYNC']) cells.push({ columnId: colByTitle['LAST SYNC'].id, value: stamp });
        if (cells.length) updates.push({ id: row.id, cells });
      }
      for (let i = 0; i < updates.length; i += 200) await ssFetch(`/sheets/${ssSheetId()}/rows`, { method: 'PUT', body: updates.slice(i, i + 200) });
      const result = { created, updated, closed, rows: seen.size, written: updates.length, skipped, sheet: sheet.name, at: new Date().toISOString() };
      setSetting('ss_sync_last', JSON.stringify(result));
      setSetting('ss_sync_error', '');
      return result;
    } catch (e) {
      setSetting('ss_sync_error', e.message);
      throw e;
    } finally { ssSyncing = null; }
  })();
  return ssSyncing;
}
// push bid / award changes to Smartsheet shortly after they happen
function smartsheetSoon() {
  if (!ssToken()) return;
  clearTimeout(ssSoon);
  ssSoon = setTimeout(() => syncSmartsheet().catch(e => console.warn('[smartsheet]', e.message)), 4000);
}
function smartsheetStatus() {
  let last = null; try { last = JSON.parse(getSetting('ss_sync_last') || 'null'); } catch (_) { /* ignore */ }
  return { tokenSet: !!ssToken(), sheetId: ssSheetId(), last, error: getSetting('ss_sync_error', ''), minutes: SS_MINUTES,
    baseUrl: process.env.PUBLIC_URL || getSetting('base_url', ''),
    liveLoads: db.prepare(`SELECT COUNT(*) AS n FROM loads WHERE source = 'smartsheet' AND status = 'open'`).get().n };
}
function startSmartsheetSync() {
  if (!ssToken()) return;
  const tick = () => syncSmartsheet().catch(e => console.warn('[smartsheet] sync failed:', e.message));
  setTimeout(tick, 5000);
  setInterval(tick, SS_MINUTES * 60000).unref();
}

// ---------- carrier email list ----------
const EMAIL_RE = /[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}/gi;
function carrierContacts() {
  const byEmail = new Map();
  const add = (email, row) => {
    const e = email.toLowerCase();
    const cur = byEmail.get(e);
    if (!cur) byEmail.set(e, { email: e, ...row, sources: [row.source] });
    else {
      if (!cur.sources.includes(row.source)) cur.sources.push(row.source);
      for (const k of ['mc', 'company', 'contact_name', 'phone', 'last_bid']) if (!cur[k] && row[k]) cur[k] = row[k];
      cur.bid_count = (cur.bid_count || 0) + (row.bid_count || 0);
    }
  };
  // carriers who have bid (most recent details per MC + email)
  db.prepare(`SELECT b.mc, b.email, b.company, b.contact_name, b.phone, COUNT(*) AS bid_count, MAX(b.updated_at) AS last_bid
    FROM bids b WHERE b.email != '' GROUP BY b.mc, lower(b.email) ORDER BY last_bid DESC`).all()
    .forEach(r => (r.email.match(EMAIL_RE) || []).forEach(e => add(e, { ...r, source: 'bid' })));
  // emails from the Highway sheet (if it has an email column)
  db.prepare(`SELECT mc, name, email FROM qualified_carriers WHERE email IS NOT NULL AND email != ''`).all()
    .forEach(r => (r.email.match(EMAIL_RE) || []).forEach(e => add(e, { mc: r.mc, company: r.name, source: 'highway sheet', bid_count: 0 })));
  const pass = new Set(db.prepare('SELECT mc FROM qualified_carriers').all().map(r => r.mc));
  const out = new Set(db.prepare('SELECT email FROM email_optout').all().map(r => r.email));
  return [...byEmail.values()].map(c => ({ ...c, highway_pass: pass.has(c.mc), opted_out: out.has(c.email) }))
    .sort((a, b) => (b.highway_pass - a.highway_pass) || String(b.last_bid || '').localeCompare(String(a.last_bid || '')) || a.email.localeCompare(b.email));
}

function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : `${proto}://${req.headers.host}`;
}

function buildDigest(base) {
  const cfg = publicConfig();
  const loads = db.prepare(`SELECT * FROM loads WHERE status = 'open' ORDER BY pickup_date IS NULL, pickup_date, id`).all().filter(biddingOpen);
  const h = v => (v == null ? '' : String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  const tz = process.env.TIMEZONE || 'America/Denver';
  const day = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: tz });
  const fmtD = d => { if (!d) return 'TBD'; const t = new Date(d + 'T12:00:00Z'); return isNaN(t) ? d : t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); };
  const fmtDue = d => d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz }) : '';
  const place = (c, s, z) => [c, s].filter(Boolean).join(', ') || z || '';
  const subject = `${cfg.company} · ${loads.length} load${loads.length === 1 ? '' : 's'} available · ${day}`;
  const contact = [cfg.contact_phone, cfg.contact_email].filter(Boolean).join(' · ');
  const rows = loads.map(l => {
    const url = `${base}/load/${l.public_id}`;
    const eq = [l.equipment, l.temp].filter(Boolean).join(' · ');
    const det = [eq, l.weight ? Number(l.weight).toLocaleString() + ' lb' : '', l.miles ? Math.round(l.miles).toLocaleString() + ' mi' : ''].filter(Boolean).join(' · ');
    return {
      text: `${place(l.origin_city, l.origin_state, l.origin_zip)} → ${place(l.dest_city, l.dest_state, l.dest_zip)}\n  Pick up ${fmtD(l.pickup_date)}${l.pickup_window ? ' ' + l.pickup_window : ''} · Deliver ${fmtD(l.delivery_date)}\n  ${det}${l.bid_deadline ? `\n  Bids due ${fmtDue(l.bid_deadline)}` : ''}\n  View & bid: ${url}`,
      html: `<tr>
        <td style="padding:12px 10px;border-bottom:1px solid #D6DCE6;vertical-align:top">
          <div style="font:700 16px Arial,sans-serif;color:#141B27;text-transform:uppercase">${h(place(l.origin_city, l.origin_state, l.origin_zip))} &rarr; ${h(place(l.dest_city, l.dest_state, l.dest_zip))}</div>
          <div style="font:14px Arial,sans-serif;color:#586478;margin-top:4px">${h(det)}${l.ref ? ' · #' + h(l.ref) : ''}</div></td>
        <td style="padding:12px 10px;border-bottom:1px solid #D6DCE6;vertical-align:top;font:14px Arial,sans-serif;color:#141B27;white-space:nowrap">PU ${h(fmtD(l.pickup_date))}<br>DEL ${h(fmtD(l.delivery_date))}${l.bid_deadline ? `<br><span style="color:#B7780A">Due ${h(fmtDue(l.bid_deadline))}</span>` : ''}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #D6DCE6;vertical-align:top;text-align:right">
          <a href="${h(url)}" style="display:inline-block;background:#1D4F9E;color:#ffffff;font:700 14px Arial,sans-serif;text-decoration:none;padding:8px 14px;border-radius:6px">View &amp; bid</a></td></tr>`,
    };
  });
  const text = `${cfg.company}\nAvailable loads — ${day}\n\n` + (rows.length ? rows.map(r => r.text).join('\n\n') : 'No open loads right now.') +
    `\n\nAll loads: ${base}/\n${contact ? 'Questions: ' + contact + '\n' : ''}Reply "remove" to stop getting this list.`;
  const html = `<div style="max-width:680px;font-family:Arial,sans-serif;color:#141B27">
    <div style="background:#1D4F9E;color:#ffffff;padding:16px 18px;border-radius:8px 8px 0 0">
      <div style="font:700 20px Arial,sans-serif;text-transform:uppercase;letter-spacing:.5px">${h(cfg.company)}</div>
      <div style="font:14px Arial,sans-serif;opacity:.9;margin-top:2px">Available loads — ${h(day)}</div></div>
    <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border:1px solid #D6DCE6;border-top:0;border-collapse:collapse">
      ${rows.length ? rows.map(r => r.html).join('') : '<tr><td style="padding:16px;font:14px Arial,sans-serif">No open loads right now.</td></tr>'}
    </table>
    <p style="font:14px Arial,sans-serif;margin:14px 0 4px"><a href="${h(base)}/" style="color:#1D4F9E;font-weight:700">See all available loads</a></p>
    <p style="font:12px Arial,sans-serif;color:#586478;margin:4px 0">${contact ? 'Questions: ' + h(contact) + '<br>' : ''}Reply "remove" to stop getting this list.</p></div>`;
  return { subject, text, html, count: loads.length };
}

// ---------- router ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;
  const ip = clientIp(req);

  // pages
  if (m === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, 'index.html');
  if (m === 'GET' && /^\/load\/[\w-]+\/?$/.test(p)) return serveFile(res, 'load.html');
  if (m === 'GET' && (p === '/admin' || p === '/admin/')) return serveFile(res, 'admin.html');
  if (m === 'GET' && p.startsWith('/static/')) return serveFile(res, p.slice(8).replace(/\.\./g, ''));
  if (m === 'GET' && p === '/healthz') return send(res, 200, 'ok');

  // ---- public API ----
  if (m === 'GET' && p === '/api/config') return send(res, 200, publicConfig());

  if (m === 'GET' && p === '/api/loads') {
    const rows = db.prepare(`SELECT * FROM loads WHERE status = 'open' ORDER BY pickup_date IS NULL, pickup_date, id`).all();
    return send(res, 200, rows.filter(biddingOpen).map(publicLoad).map(l => ({ ...l, route: undefined })));
  }

  let mm;
  if (m === 'GET' && (mm = p.match(/^\/api\/loads\/([\w-]+)$/))) {
    const L = db.prepare(`SELECT * FROM loads WHERE public_id = ? AND status != 'draft'`).get(mm[1]);
    if (!L) return fail(res, 404, 'This load is no longer posted.');
    return send(res, 200, publicLoad(L));
  }

  if (m === 'POST' && (mm = p.match(/^\/api\/loads\/([\w-]+)\/bids$/))) {
    if (limited('b:' + ip, 20, 600000)) return fail(res, 429, 'Too many bids from this connection. Please wait a few minutes.');
    const L = db.prepare('SELECT * FROM loads WHERE public_id = ?').get(mm[1]);
    if (!L || L.status === 'draft') return fail(res, 404, 'This load is no longer posted.');
    if (!biddingOpen(L)) return fail(res, 409, 'Bidding is closed for this load.');
    const b = await readBody(req, 20000);
    const mc = qualify.normalizeMC(b.mc);
    if (!mc) return fail(res, 400, 'Enter your MC number (digits only, e.g. 123456).');
    // Highway check happens behind the scenes for the admin view; it never blocks the bid.
    qualify.check(mc).catch(() => {});
    const amount = Math.round(Number(String(b.amount || '').replace(/[^0-9.]/g, '')) * 100) / 100;
    if (!(amount >= 50 && amount <= 250000)) return fail(res, 400, 'Enter your all-in rate in dollars, e.g. 2150.');
    // Bid step (default $50): every bid is a multiple of the step (1,000 / 1,050 / 1,100 ...),
    // and a new low must be at least one step under the current bid - including the lead carrier lowering their own.
    const step = bidStep();
    if (step > 0) {
      const fmt = n => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
      if (Math.abs(amount / step - Math.round(amount / step)) > 1e-9) {
        const down = Math.floor(amount / step) * step, up = down + step;
        return fail(res, 400, `Bids go in ${fmt(step)} steps, like ${fmt(1000)} or ${fmt(1000 + step)}. Try ${fmt(down)} or ${fmt(up)}.`);
      }
      const low = db.prepare('SELECT MIN(amount) AS low FROM bids WHERE load_id = ?').get(L.id).low;
      const otherLow = db.prepare('SELECT MIN(amount) AS low FROM bids WHERE load_id = ? AND mc != ?').get(L.id, mc).low;
      if (otherLow != null && amount === otherLow)
        return fail(res, 400, `${fmt(amount)} ties the current bid. Bid ${fmt(otherLow - step)} or less to take the lead.`);
      if (low != null && amount < low && amount > low - step)
        return fail(res, 400, `Bids must be at least ${fmt(step)} under the current bid of ${fmt(low)}. Bid ${fmt(low - step)} or less.`);
    }
    const s = v => (v == null ? '' : String(v).trim().slice(0, 300));
    const company = s(b.company), contact = s(b.contact_name), email = s(b.email), phone = s(b.phone);
    if (!company) return fail(res, 400, 'Enter your company name.');
    if (!contact) return fail(res, 400, 'Enter a contact name.');
    if (!email && !phone) return fail(res, 400, 'Enter a phone number or email so we can reach you.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'That email address doesn\'t look right.');
    db.prepare(`INSERT INTO bids (load_id, mc, company, contact_name, email, phone, amount, notes, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(load_id, mc) DO UPDATE SET company=excluded.company, contact_name=excluded.contact_name, email=excluded.email,
        phone=excluded.phone, amount=excluded.amount, notes=excluded.notes, ip=excluded.ip, updated_at=datetime('now')`)
      .run(L.id, mc, company, contact, email, phone, amount, s(b.notes).slice(0, 1000), ip);
    const st = bidStats.get(L.id);
    smartsheetSoon();
    return send(res, 200, { ok: true, amount, low_bid: st.low_bid, bid_count: st.bid_count, you_are_low: amount <= st.low_bid });
  }

  // ---- admin API ----
  if (p === '/api/admin/login' && m === 'POST') {
    if (limited('login:' + ip, 8, 900000)) return fail(res, 429, 'Too many attempts. Try again in 15 minutes.');
    if (!ADMIN_PASSWORD) return fail(res, 503, 'Admin password is not configured on the server (set ADMIN_PASSWORD).');
    const { password } = await readBody(req, 5000);
    const a = Buffer.from(String(password || '')), bb = Buffer.from(ADMIN_PASSWORD);
    if (a.length !== bb.length || !crypto.timingSafeEqual(a, bb)) return fail(res, 401, 'Wrong password.');
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, makeToken(), 43200) });
  }
  if (p === '/api/admin/logout' && m === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });

  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return fail(res, 401, 'Please sign in.');
    // CSRF guard: state-changing admin calls must come from our own pages
    if (m !== 'GET' && req.headers['x-requested-with'] !== 'loadboard') return fail(res, 403, 'Bad request origin.');

    if (m === 'GET' && p === '/api/admin/me') { const b = baseUrl(req); if (getSetting('base_url') !== b) setSetting('base_url', b); return send(res, 200, { ok: true }); }
    // any admin change may affect what Smartsheet should show
    if (m !== 'GET' && !p.startsWith('/api/admin/smartsheet')) smartsheetSoon();
    if (m === 'GET' && p === '/api/admin/smartsheet') return send(res, 200, smartsheetStatus());
    if (m === 'POST' && p === '/api/admin/smartsheet/run') { try { await syncSmartsheet(); } catch (_) { /* saved in status */ } return send(res, 200, smartsheetStatus()); }
    if (m === 'PUT' && p === '/api/admin/smartsheet') { const { sheetId } = await readBody(req, 2000); setSetting('ss_sheet_id', String(sheetId || '').replace(/\D/g, '')); try { await syncSmartsheet(); } catch (_) { /* saved */ } return send(res, 200, smartsheetStatus()); }

    if (m === 'GET' && p === '/api/admin/loads') {
      const rows = db.prepare('SELECT * FROM loads ORDER BY CASE status WHEN \'open\' THEN 0 WHEN \'draft\' THEN 1 WHEN \'closed\' THEN 2 ELSE 3 END, pickup_date IS NULL, pickup_date DESC, id DESC').all();
      return send(res, 200, rows.map(adminLoad));
    }
    if (m === 'POST' && p === '/api/admin/loads') {
      const id = insertLoad(await readBody(req));
      return send(res, 200, adminLoad(db.prepare('SELECT * FROM loads WHERE id = ?').get(id)));
    }
    if ((mm = p.match(/^\/api\/admin\/loads\/(\d+)$/))) {
      const id = Number(mm[1]);
      if (m === 'GET') { const L = db.prepare('SELECT * FROM loads WHERE id = ?').get(id); return L ? send(res, 200, adminLoad(L)) : fail(res, 404, 'Not found'); }
      if (m === 'PUT') { if (!updateLoad(id, await readBody(req))) return fail(res, 404, 'Not found'); return send(res, 200, adminLoad(db.prepare('SELECT * FROM loads WHERE id = ?').get(id))); }
      if (m === 'DELETE') { db.prepare('DELETE FROM loads WHERE id = ?').run(id); return send(res, 200, { ok: true }); }
    }
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/loads\/(\d+)\/duplicate$/))) {
      const L = db.prepare('SELECT * FROM loads WHERE id = ?').get(Number(mm[1]));
      if (!L) return fail(res, 404, 'Not found');
      const copy = { ...L, ref: L.ref ? L.ref + ' (copy)' : null, status: 'draft', miles: L.miles_manual ? L.miles : null };
      const id = insertLoad(copy);
      return send(res, 200, adminLoad(db.prepare('SELECT * FROM loads WHERE id = ?').get(id)));
    }
    if (m === 'GET' && (mm = p.match(/^\/api\/admin\/loads\/(\d+)\/bids$/))) {
      return send(res, 200, db.prepare(`SELECT b.*, CASE WHEN q.mc IS NULL THEN 0 ELSE 1 END AS highway_pass, q.name AS highway_name
        FROM bids b LEFT JOIN qualified_carriers q ON q.mc = b.mc WHERE b.load_id = ? ORDER BY b.amount ASC, b.created_at ASC`).all(Number(mm[1])));
    }
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/bids\/(\d+)\/award$/))) {
      const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(Number(mm[1]));
      if (!bid) return fail(res, 404, 'Bid not found');
      db.exec('BEGIN');
      db.prepare(`UPDATE bids SET status = CASE WHEN id = ? THEN 'awarded' ELSE 'lost' END WHERE load_id = ?`).run(bid.id, bid.load_id);
      db.prepare(`UPDATE loads SET status = 'awarded', awarded_bid_id = ?, updated_at = datetime('now') WHERE id = ?`).run(bid.id, bid.load_id);
      db.exec('COMMIT');
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/loads\/(\d+)\/reopen$/))) {
      const id = Number(mm[1]);
      db.prepare(`UPDATE bids SET status = 'active' WHERE load_id = ?`).run(id);
      db.prepare(`UPDATE loads SET status = 'open', awarded_bid_id = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE' && (mm = p.match(/^\/api\/admin\/bids\/(\d+)$/))) {
      db.prepare('DELETE FROM bids WHERE id = ?').run(Number(mm[1]));
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/admin/bids.csv') {
      const rows = db.prepare(`SELECT l.ref AS load_ref, l.public_id, l.origin_city || ', ' || l.origin_state AS origin, l.dest_city || ', ' || l.dest_state AS destination,
        l.pickup_date, l.miles, b.mc, CASE WHEN q.mc IS NULL THEN 'Not on list' ELSE 'Pass' END AS highway, b.company, b.contact_name, b.phone, b.email, b.amount,
        CASE WHEN l.miles > 0 THEN ROUND(b.amount / l.miles, 2) END AS rate_per_mile, b.status, b.notes, b.created_at, b.updated_at
        FROM bids b JOIN loads l ON l.id = b.load_id LEFT JOIN qualified_carriers q ON q.mc = b.mc ORDER BY l.id DESC, b.amount ASC`).all();
      return send(res, 200, toCSV(rows) || 'no bids yet', { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="bids.csv"' });
    }
    if (m === 'GET' && p === '/api/admin/template.csv') {
      return send(res, 200, TEMPLATE_CSV, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="load-import-template.csv"' });
    }
    if (m === 'POST' && p === '/api/admin/import') {
      const { data, filename } = await readBody(req);
      const rows = rowsToObjects(parseAny(Buffer.from(String(data || ''), 'base64')));
      const created = [], skipped = [];
      rows.forEach((r, i) => {
        const L = mapImportRow(r);
        if (!(L.origin_city || L.origin_zip) || !(L.dest_city || L.dest_zip)) { skipped.push(i + 2); return; }
        created.push(insertLoad(L));
      });
      return send(res, 200, { created: created.length, skipped, filename });
    }

    // ---- Google Sheet load sync ----
    if (m === 'GET' && p === '/api/admin/loadsync') return send(res, 200, loadSyncStatus());
    if (m === 'PUT' && p === '/api/admin/loadsync') {
      const { url } = await readBody(req, 10000);
      setSetting('load_sheet_url', String(url || '').trim());
      if (!url) { setSetting('load_sync_error', ''); return send(res, 200, loadSyncStatus()); }
      try { await syncLoadsFromSheet(); } catch (_) { /* error saved in status */ }
      return send(res, 200, loadSyncStatus());
    }
    if (m === 'POST' && p === '/api/admin/loadsync/run') {
      try { await syncLoadsFromSheet(); } catch (_) { /* error saved in status */ }
      return send(res, 200, loadSyncStatus());
    }

    // ---- carrier email list + daily load email ----
    if (m === 'GET' && p === '/api/admin/contacts') return send(res, 200, carrierContacts());
    if (m === 'POST' && p === '/api/admin/contacts/optout') {
      const { email, out } = await readBody(req, 5000);
      const e = String(email || '').trim().toLowerCase();
      if (!e) return fail(res, 400, 'Missing email');
      if (out) db.prepare('INSERT OR IGNORE INTO email_optout (email) VALUES (?)').run(e);
      else db.prepare('DELETE FROM email_optout WHERE email = ?').run(e);
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/admin/digest') return send(res, 200, buildDigest(baseUrl(req)));

    // carriers / settings
    if (m === 'GET' && p === '/api/admin/carriers') return send(res, 200, qualify.status());
    if (m === 'PUT' && p === '/api/admin/carriers') {
      const b = await readBody(req, 10000);
      if ('url' in b) setSetting('carrier_sheet_url', String(b.url || '').trim());
      if ('mcColumn' in b) setSetting('carrier_mc_column', String(b.mcColumn || '').trim());
      setSetting('carrier_source', 'url');
      let count = null, error = null;
      if (b.url) { try { count = await qualify.refreshFromUrl(); } catch (e) { error = e.message; } }
      return send(res, 200, { ...qualify.status(), count: count ?? qualify.status().count, error });
    }
    if (m === 'POST' && p === '/api/admin/carriers/refresh') {
      try { await qualify.refreshFromUrl(); return send(res, 200, qualify.status()); }
      catch (e) { return fail(res, 400, e.message); }
    }
    if (m === 'POST' && p === '/api/admin/carriers/upload') {
      const { data, filename } = await readBody(req);
      try { qualify.importFromFile(Buffer.from(String(data || ''), 'base64'), String(filename || 'upload')); return send(res, 200, qualify.status()); }
      catch (e) { return fail(res, 400, e.message); }
    }
    if (m === 'POST' && p === '/api/admin/carriers/test') {
      const { mc } = await readBody(req, 2000);
      return send(res, 200, await qualify.check(mc));
    }
    if (p === '/api/admin/settings') {
      const keys = ['company_name', 'board_tagline', 'default_contact_name', 'default_contact_phone', 'default_contact_email', 'bid_terms', 'bid_step'];
      if (m === 'PUT') { const b = await readBody(req, 20000); keys.forEach(k => { if (k in b) setSetting(k, String(b[k] ?? '').slice(0, 2000)); }); }
      const out = publicConfig(); out.default_contact_name = getSetting('default_contact_name', '');
      out.company_name = out.company; out.board_tagline = out.tagline; out.default_contact_phone = out.contact_phone; out.default_contact_email = out.contact_email;
      return send(res, 200, out);
    }
    return fail(res, 404, 'Unknown admin endpoint');
  }

  return send(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) fail(res, err.status || 500, err.status ? err.message : 'Something went wrong on our side. Please try again.');
  });
});

process.on('unhandledRejection', e => console.error('[unhandled]', e));
process.on('uncaughtException', e => console.error('[uncaught]', e));

server.listen(PORT, () => {
  console.log(`Load board running on http://localhost:${PORT}  (admin: /admin)`);
  qualify.startAutoRefresh();
  startLoadSync();
  startSmartsheetSync();
  geo.resumePending();
});
