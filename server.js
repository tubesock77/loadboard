// Freight Load Board — carriers view loads and bid; admin posts loads and awards.
// Zero third-party dependencies. Requires Node.js 22.13 or newer.
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
  'stops', 'requirements', 'notes', 'target_rate', 'bid_deadline', 'contact_name', 'contact_phone', 'contact_email', 'miles'];
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
    if (f === 'bid_deadline' && v) { const t = Date.parse(v); v = isNaN(t) ? null : new Date(t).toISOString(); }
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
function mapImportRow(obj) {
  const out = {};
  for (const [field, names] of Object.entries(IMPORT_ALIASES)) {
    const k = names.find(n => obj[n] != null && obj[n] !== '');
    if (k) out[field] = obj[k];
  }
  if (out.pickup_date) out.pickup_date = excelDate(out.pickup_date);
  if (out.delivery_date) out.delivery_date = excelDate(out.delivery_date);
  if (out.bid_deadline && /^\d{5}(\.\d+)?$/.test(out.bid_deadline)) out.bid_deadline = new Date(Date.UTC(1899, 11, 30) + Number(out.bid_deadline) * 86400000).toISOString();
  if (out.status) out.status = String(out.status).toLowerCase();
  return out;
}

const TEMPLATE_CSV = 'ref,origin_city,origin_state,origin_zip,dest_city,dest_state,dest_zip,pickup_date,pickup_window,delivery_date,delivery_window,equipment,temp,weight,pallets,commodity,stops,requirements,notes,target_rate,bid_deadline,status\n' +
  'SO-10421,Salt Lake City,UT,84104,Dallas,TX,75212,2026-10-02,08:00-14:00,2026-10-05,FCFS 06:00-12:00,53\' Dry Van,,38500,22,Packaged candy,0,No double brokering; load locks required,,2200,2026-09-30 15:00,open\n';

function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

function publicConfig() {
  return {
    company: getSetting('company_name', 'Brock LLC MC# 375005'),
    tagline: getSetting('board_tagline', 'Truckload freight available for bid'),
    contact_phone: getSetting('default_contact_phone', ''),
    contact_email: getSetting('default_contact_email', ''),
    bid_terms: getSetting('bid_terms', 'Bids are all-in USD (linehaul + fuel). Submitting a bid does not guarantee award; we will contact the awarded carrier directly.'),
  };
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

    if (m === 'GET' && p === '/api/admin/me') return send(res, 200, { ok: true });

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
      const keys = ['company_name', 'board_tagline', 'default_contact_name', 'default_contact_phone', 'default_contact_email', 'bid_terms'];
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
  geo.resumePending();
});
