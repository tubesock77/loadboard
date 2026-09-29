// Freight Load Board — carriers view loads and bid; admin posts loads and awards.
// Zero third-party dependencies. Requires Node.js 22.13 or newer.
process.env.TZ = 'UTC'; // parse times without a zone as UTC, then shift to TIMEZONE below
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSetting, setSetting, newPublicId } = require('./lib/db');
const cost = require('./lib/cost');
const qualify = require('./lib/qualify');
const geo = require('./lib/geo');
const { parseAny, rowsToObjects } = require('./lib/sheet');
const mailer = require('./lib/mailer');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || getSetting('session_secret') || (() => {
  const s = crypto.randomBytes(32).toString('hex'); setSetting('session_secret', s); return s;
})();
const PUBLIC_DIR = path.join(__dirname, 'public');
const TIMEZONE = process.env.TIMEZONE || 'America/Denver';

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
  'stops', 'requirements', 'notes', 'target_rate', 'bid_deadline', 'contact_name', 'contact_phone', 'contact_email', 'miles', 'customer',
  'origin_name', 'origin_address', 'dest_name', 'dest_address', 'customer_rate', 'aljex_pro', 'post_rate', 'lane_id'];
// Book it now is parked (Sep 28: Cody wants to pick every carrier). To bring it back, add 'book_rate' above and the field in admin.
const PUBLIC_FIELDS = ['public_id', 'ref', 'status', 'origin_city', 'origin_state', 'origin_zip', 'dest_city', 'dest_state', 'dest_zip',
  'origin_lat', 'origin_lng', 'dest_lat', 'dest_lng', 'miles', 'pickup_date', 'pickup_window', 'delivery_date', 'delivery_window',
  'equipment', 'temp', 'weight', 'pallets', 'commodity', 'stops', 'requirements', 'notes', 'bid_deadline',
  'contact_name', 'contact_phone', 'contact_email', 'updated_at', 'book_rate', 'post_rate'];
const STATUSES = ['draft', 'open', 'closed', 'awarded'];

function cleanLoad(input) {
  const out = {};
  for (const f of LOAD_FIELDS) {
    if (!(f in input)) continue;
    let v = input[f];
    if (typeof v === 'string') v = v.trim();
    if (v === '') v = null;
    if (f === 'lane_id') v = v == null ? null : (parseInt(v, 10) || null);
    if (['weight', 'stops'].includes(f) && v != null) v = Math.round(Number(String(v).replace(/[^0-9.]/g, ''))) || null;
    if (['target_rate', 'miles', 'customer_rate', 'book_rate', 'post_rate'].includes(f) && v != null) v = Number(String(v).replace(/[^0-9.]/g, '')) || null;
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
    pass_count: h.pass_count, low_pass_bid: h.low_pass_bid, ...costFields(L, s.low_bid, h.low_pass_bid) };
}
function costFields(L, low, lowPass, model) {
  const est = cost.estimate(L, model);
  return { cost: est, low_tag: s_tag(low, est), low_pass_tag: s_tag(lowPass, est) };
}
function s_tag(v, est) { return v ? cost.tag(v, est) : null; }

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
  customer: ['customer', 'customer_name', 'bill_to'], customer_rate: ['customer_rate', 'rate', 'sell_rate', 'revenue'],
  origin_name: ['shipper', 'shipper_name', 'pickup_name', 'origin_name'], origin_address: ['shipper_address', 'pickup_address', 'origin_address'],
  dest_name: ['consignee', 'consignee_name', 'receiver', 'delivery_name', 'dest_name'], dest_address: ['consignee_address', 'receiver_address', 'delivery_address', 'dest_address'],
  aljex_pro: ['pro', 'pro_number', 'aljex_pro', 'aljex'],
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
    tagline: getSetting('board_tagline', 'Independent Agent Loads'),
    contact_phone: getSetting('default_contact_phone', ''),
    contact_email: getSetting('default_contact_email', '') || process.env.EMAIL_FROM || '',
    bid_step: bidStep(),
    bid_terms: getSetting('bid_terms', `Bids are all-in USD (linehaul + fuel).${bidStep() ? ` Bids go in $${bidStep()} steps (e.g. $1,000, $${(1000 + bidStep()).toLocaleString('en-US')}), and a new low must be at least $${bidStep()} under the current bid.` : ''} Submitting a bid does not guarantee award; we will contact the awarded carrier directly.`),
  };
}



// Loads are entered in Admin (form, saved lanes, paste, repeat loads, CSV import). Sheet syncs were removed Sep 2026.
// Loads that came from Smartsheet / Google Sheet become regular admin-managed loads.
db.exec("UPDATE loads SET source = 'manual' WHERE source IN ('smartsheet', 'sheet')");
db.exec('UPDATE loads SET book_rate = NULL WHERE book_rate IS NOT NULL');

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
  // carriers you added by hand (or from the inbox look-back)
  db.prepare(`SELECT mc, email, company, name AS contact_name, phone FROM carriers_manual`).all()
    .forEach(r => (String(r.email).match(EMAIL_RE) || []).forEach(e => add(e, { ...r, source: 'added by you', bid_count: 0 })));
  // emails from the Highway sheet (if it has an email column)
  db.prepare(`SELECT mc, name, email FROM qualified_carriers WHERE email IS NOT NULL AND email != ''`).all()
    .forEach(r => (r.email.match(EMAIL_RE) || []).forEach(e => add(e, { mc: r.mc, company: r.name, source: 'highway sheet', bid_count: 0 })));
  const pass = new Map(db.prepare('SELECT mc, hq_state, hq_zip FROM qualified_carriers').all().map(r => [r.mc, r]));
  const out = new Set(db.prepare('SELECT email FROM email_optout').all().map(r => r.email));
  // lanes each carrier (MC) has bid on: pickup state -> delivery state
  const lanes = new Map();
  db.prepare(`SELECT b.mc, l.origin_state AS o, l.dest_state AS d, COUNT(*) AS n, MAX(b.updated_at) AS last,
      SUM(CASE WHEN b.status = 'awarded' THEN 1 ELSE 0 END) AS won
    FROM bids b JOIN loads l ON l.id = b.load_id WHERE l.origin_state IS NOT NULL AND l.dest_state IS NOT NULL
    GROUP BY b.mc, l.origin_state, l.dest_state ORDER BY n DESC`).all()
    .forEach(r => { if (!lanes.has(r.mc)) lanes.set(r.mc, []); lanes.get(r.mc).push({ o: r.o, d: r.d, n: r.n, won: r.won, last: r.last }); });
  return [...byEmail.values()].map(c => {
    const q = pass.get(c.mc);
    return { ...c, highway_pass: !!q, hq_state: q ? q.hq_state || '' : '', opted_out: out.has(c.email), lanes: lanes.get(c.mc) || [] };
  })
    .sort((a, b) => (b.highway_pass - a.highway_pass) || String(b.last_bid || '').localeCompare(String(a.last_bid || '')) || a.email.localeCompare(b.email));
}

function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : `${proto}://${req.headers.host}`;
}

function buildDigest(base, loadIds, token) {
  const cfg = publicConfig();
  const pick = Array.isArray(loadIds) && loadIds.length ? new Set(loadIds.map(Number)) : null;
  const loads = db.prepare(`SELECT * FROM loads WHERE status = 'open' ORDER BY pickup_date IS NULL, pickup_date, id`).all().filter(biddingOpen).filter(l => !pick || pick.has(l.id));
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
    const det = [eq, l.commodity, l.weight ? Number(l.weight).toLocaleString() + ' lb' : '', l.miles ? Math.round(l.miles).toLocaleString() + ' mi' : ''].filter(Boolean).join(' · ');
    return {
      text: `${place(l.origin_city, l.origin_state, l.origin_zip)} → ${place(l.dest_city, l.dest_state, l.dest_zip)}\n  Pick up ${fmtD(l.pickup_date)}${l.pickup_window ? ' ' + l.pickup_window : ''} · Deliver ${fmtD(l.delivery_date)}\n  ${det}${l.bid_deadline ? `\n  Bids due ${fmtDue(l.bid_deadline)}` : ''}\n  View & bid: ${url}`,
      html: `<tr>
        <td style="padding:12px 10px;border-bottom:1px solid #D6DCE6;vertical-align:top">
          <div style="font:700 16px Arial,sans-serif;color:#141B27;text-transform:uppercase">${h(place(l.origin_city, l.origin_state, l.origin_zip))} &rarr; ${h(place(l.dest_city, l.dest_state, l.dest_zip))}</div>
          <div style="font:14px Arial,sans-serif;color:#586478;margin-top:4px">${h(det)}</div>${l.post_rate ? `<div style="font:700 15px Arial,sans-serif;color:#17724A;margin-top:4px">Rate ${h('$' + Number(l.post_rate).toLocaleString('en-US'))}</div>` : ''}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #D6DCE6;vertical-align:top;font:14px Arial,sans-serif;color:#141B27;white-space:nowrap">PU ${h(fmtD(l.pickup_date))}<br>DEL ${h(fmtD(l.delivery_date))}${l.bid_deadline ? `<br><span style="color:#B7780A">Due ${h(fmtDue(l.bid_deadline))}</span>` : ''}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #D6DCE6;vertical-align:top;text-align:right">
          ${token ? `${l.post_rate ? `<a href="${h(`${base}/o/${token}/${l.public_id}?a=cover`)}" style="display:inline-block;background:#17724A;color:#ffffff;font:700 13px Arial,sans-serif;text-decoration:none;padding:8px 12px;border-radius:6px;margin:0 0 6px;white-space:nowrap">Can cover</a><br>` : ''}<a href="${h(`${base}/o/${token}/${l.public_id}?a=offer`)}" style="display:inline-block;background:#1D4F9E;color:#ffffff;font:700 13px Arial,sans-serif;text-decoration:none;padding:8px 12px;border-radius:6px;white-space:nowrap">Make an offer</a>`
            : `<a href="${h(url)}" style="display:inline-block;background:#1D4F9E;color:#ffffff;font:700 14px Arial,sans-serif;text-decoration:none;padding:8px 14px;border-radius:6px">View &amp; bid</a>`}</td></tr>`,
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

// ---------- email (sent as your Microsoft 365 mailbox) ----------
const EMAIL_DEFAULTS = { em_bid_alert: '1', em_bid_confirm: '1', em_outbid: '1', em_award_win: '1', em_award_lost: '0',
  daily_auto: '0', daily_time: '07:00', daily_days: '1,2,3,4,5', daily_only_pass: '1', daily_match: '0' };
const eset = k => getSetting(k, EMAIL_DEFAULTS[k] ?? '');
const on = k => eset(k) === '1';
const siteBase = () => process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : getSetting('base_url', '');
const notifyTo = () => getSetting('notify_email', '') || mailer.from();
const hx = v => (v == null ? '' : String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
const usd = n => (n == null || n === '' ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const laneOf = L => `${[L.origin_city, L.origin_state].filter(Boolean).join(', ')} → ${[L.dest_city, L.dest_state].filter(Boolean).join(', ')}`;
// same subject for every email about a load, so Outlook keeps them in one conversation
const loadSubject = L => `Load ${L.ref || L.public_id} · ${laneOf(L)}`;
function emailLayout(heading, body, cta) {
  const cfg = publicConfig();
  return `<div style="max-width:620px;font-family:Arial,sans-serif;color:#141B27">
    <div style="background:#1D4F9E;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0;font:700 18px Arial,sans-serif;text-transform:uppercase;letter-spacing:.5px">${hx(cfg.company)}</div>
    <div style="border:1px solid #D6DCE6;border-top:0;padding:18px;border-radius:0 0 8px 8px">
      <div style="font:700 20px Arial,sans-serif;margin-bottom:10px">${heading}</div>
      <div style="font:15px/1.5 Arial,sans-serif">${body}</div>
      ${cta ? `<p style="margin:18px 0 4px"><a href="${hx(cta.url)}" style="display:inline-block;background:#1D4F9E;color:#fff;font:700 15px Arial,sans-serif;text-decoration:none;padding:10px 18px;border-radius:6px">${hx(cta.label)}</a></p>` : ''}
    </div>
    <p style="font:12px Arial,sans-serif;color:#586478;margin:10px 2px">${[cfg.contact_phone, cfg.contact_email].filter(Boolean).map(hx).join(' · ')}</p></div>`;
}
function loadFacts(L) {
  const d = v => { if (!v) return ''; const t = new Date(String(v).slice(0, 10) + 'T12:00:00Z'); return isNaN(t) ? v : t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); };
  const rows = [['Pick up', [d(L.pickup_date), L.pickup_window].filter(Boolean).join(' · ')], ['Deliver', [d(L.delivery_date), L.delivery_window].filter(Boolean).join(' · ')],
    ['Equipment', [L.equipment, L.temp].filter(Boolean).join(' · ')], ['Commodity', L.commodity || ''], ['Rate', L.post_rate ? usd(L.post_rate) : ''], ['Weight', L.weight ? Number(L.weight).toLocaleString() + ' lb' : ''], ['Miles', L.miles ? Math.round(L.miles).toLocaleString() : '']]
    .filter(r => r[1]);
  return `<table style="border-collapse:collapse;margin:10px 0;font:14px Arial,sans-serif">${rows.map(r => `<tr><td style="padding:3px 14px 3px 0;color:#586478">${r[0]}</td><td style="padding:3px 0"><b>${hx(r[1])}</b></td></tr>`).join('')}</table>`;
}

function emailsAfterBid(L, bid, prevLow, opt = {}) {
  if (!mailer.configured()) return;
  const url = siteBase() ? `${siteBase()}/load/${L.public_id}` : '';
  const st = bidStats.get(L.id);
  const step = bidStep();
  const pass = !!qualify.lookupName(bid.mc) || !!db.prepare('SELECT 1 FROM qualified_carriers WHERE mc = ?').get(bid.mc);
  if (on('em_bid_alert')) {
    mailer.sendQuiet({ to: notifyTo(), replyTo: bid.email || undefined, subject: `${opt.bookNow ? 'BOOK IT NOW request ' + usd(bid.amount) : opt.kind === 'cover' ? 'CAN COVER at ' + usd(bid.amount) : opt.kind === 'offer' ? 'Offer ' + usd(bid.amount) : 'New bid ' + usd(bid.amount)} · ${loadSubject(L)}`,
      html: emailLayout(`${opt.bookNow ? '<span style="color:#B42318">Book it now:</span> ' : opt.kind === 'cover' ? '<span style="color:#17724A">Can cover at your rate:</span> ' : opt.kind === 'offer' ? 'Offer: ' : 'New bid: '}${usd(bid.amount)}${L.miles ? ` <span style="color:#586478;font-weight:400">(${usd(Math.round(bid.amount / L.miles * 100) / 100)}/mi)</span>` : ''}`,
        `<b>${hx(bid.company)}</b> · MC ${hx(bid.mc)} · ${pass ? '<span style="color:#17724A;font-weight:700">✓ Highway pass</span>' : '<span style="color:#B42318;font-weight:700">✗ Not on Highway list</span>'}<br>
         ${[bid.contact_name, bid.phone, bid.email].filter(Boolean).map(hx).join(' · ')}
         ${bid.notes ? `<br><i>“${hx(bid.notes)}”</i>` : ''}
         <p style="margin:12px 0 0"><b>${hx(laneOf(L))}</b>${L.ref ? ' · #' + hx(L.ref) : ''}<br>${L.post_rate ? `Your posted rate ${usd(L.post_rate)} · ` : ''}Low bid ${usd(st.low_bid)} · ${st.bid_count} bid${st.bid_count === 1 ? '' : 's'}${L.target_rate ? ` · target ${usd(L.target_rate)}` : ''}</p>
         ${bid.email ? '<p style="color:#586478;font-size:13px">Reply to this email to reach the carrier.</p>' : ''}`,
        siteBase() ? { url: `${siteBase()}/admin`, label: 'Open admin' } : null) }, 'bid alert');
  }
  if (on('em_bid_confirm') && bid.email && !opt.skipConfirm && opt.bookNow) {
    mailer.sendQuiet({ to: bid.email, subject: loadSubject(L),
      html: emailLayout(`Booking request received: ${usd(bid.amount)}`,
        `Thanks, ${hx(bid.contact_name || bid.company)}. You asked to book <b>${hx(laneOf(L))}</b>${L.ref ? ' (#' + hx(L.ref) + ')' : ''} at the posted rate of <b>${usd(bid.amount)}</b>.${loadFacts(L)}
         <p>We'll confirm shortly and send the rate confirmation. Reply to this email with any questions.</p>`, url ? { url, label: 'View load' } : null) }, 'book-now confirmation');
  } else if (on('em_bid_confirm') && bid.email && !opt.skipConfirm) {
    const lead = bid.amount <= st.low_bid;
    mailer.sendQuiet({ to: bid.email, subject: loadSubject(L),
      html: emailLayout(`Bid received: ${usd(bid.amount)}`,
        `Thanks, ${hx(bid.contact_name || bid.company)}. We received your bid on <b>${hx(laneOf(L))}</b>${L.ref ? ' (#' + hx(L.ref) + ')' : ''}.${loadFacts(L)}
         ${lead ? '<b style="color:#17724A">You\'re winning this load right now.</b> We\'ll email you if another carrier outbids you.'
          : `<b style="color:#B7780A">You're not winning yet.</b> The current bid is ${usd(st.low_bid)}.${step ? ` Bid ${usd(st.low_bid - step)} or less to take the lead.` : ''}`}
         <p>Questions? Just reply to this email.</p>`, url ? { url, label: lead ? 'View load' : 'Rebid' } : null) }, 'bid confirmation');
  }
  // tell the carrier who just lost the lead
  if (on('em_outbid') && prevLow && prevLow.mc !== bid.mc && prevLow.email && bid.amount < prevLow.amount) {
    mailer.sendQuiet({ to: prevLow.email, subject: loadSubject(L),
      html: emailLayout(`You've been outbid`,
        `Another carrier took the lead with <b>${usd(bid.amount)}</b> on <b>${hx(laneOf(L))}</b>${L.ref ? ' (#' + hx(L.ref) + ')' : ''}. Your bid was ${usd(prevLow.amount)}.
         ${step ? `<p>To take the lead, bid <b>${usd(bid.amount - step)} or less</b>.</p>` : ''}${L.bid_deadline ? `<p style="color:#586478">Bids due ${hx(new Date(L.bid_deadline).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TIMEZONE }))}</p>` : ''}`,
        url ? { url, label: 'Rebid now' } : null) }, 'outbid notice');
  }
}

function emailsAfterAward(L, winner) {
  if (!mailer.configured()) return;
  const url = siteBase() ? `${siteBase()}/load/${L.public_id}` : '';
  if (on('em_award_win') && winner.email) {
    mailer.sendQuiet({ to: winner.email, subject: loadSubject(L),
      html: emailLayout(`You've been awarded this load`,
        `Congratulations, ${hx(winner.contact_name || winner.company)}. <b>${hx(laneOf(L))}</b>${L.ref ? ' (#' + hx(L.ref) + ')' : ''} is awarded to <b>${hx(winner.company)}</b> (MC ${hx(winner.mc)}) at <b>${usd(winner.amount)}</b>.${loadFacts(L)}
         <p>We'll follow up with the rate confirmation and pickup details. Reply to this email with any questions.</p>`, url ? { url, label: 'View load' } : null) }, 'award notice');
  }
  if (on('em_award_lost')) {
    for (const b of db.prepare(`SELECT * FROM bids WHERE load_id = ? AND id != ? AND email != ''`).all(L.id, winner.id)) {
      mailer.sendQuiet({ to: b.email, subject: loadSubject(L),
        html: emailLayout('Load covered', `Thanks for bidding on <b>${hx(laneOf(L))}</b>${L.ref ? ' (#' + hx(L.ref) + ')' : ''}. This load has been covered. We hope to work with you on the next one.`,
          siteBase() ? { url: siteBase() + '/', label: 'See other loads' } : null) }, 'covered notice');
    }
  }
}

async function sendDailyEmail(base, onlyPass, loadIds, emails) {
  const d = buildDigest(base || siteBase(), loadIds);
  if (!d.count) return { sent: 0, recipients: 0, skipped: 'No open loads to send.' };
  let list = carrierContacts().filter(c => !c.opted_out && (!(onlyPass ?? on('daily_only_pass')) || c.highway_pass)).map(c => c.email);
  if (!Array.isArray(emails) && on('daily_match')) {
    // automatic lane targeting: only carriers whose bid history / home state fits today's loads
    const pick = Array.isArray(loadIds) && loadIds.length ? new Set(loadIds.map(Number)) : null;
    const todays = db.prepare(`SELECT * FROM loads WHERE status = 'open'`).all().filter(biddingOpen).filter(l => !pick || pick.has(l.id));
    const fit = new Set(OPS.matchingEmails(todays, carrierContacts()));
    list = list.filter(e => fit.has(e));
  }
  if (Array.isArray(emails)) { const want = new Set(emails.map(e => String(e).toLowerCase())); list = carrierContacts().filter(c => !c.opted_out && want.has(c.email)).map(c => c.email); }
  if (!list.length) return { sent: 0, recipients: 0, skipped: 'No carrier email addresses to send to.' };
  let sent = 0;
  if (list.length <= 500) {
    // one email per carrier, so each gets their own "Can cover" / "Make an offer" buttons
    for (const e of list) {
      const dd = buildDigest(base || siteBase(), loadIds, INBOX.linkToken(e));
      try { await mailer.send({ to: e, subject: dd.subject, html: dd.html }); sent++; }
      catch (err) { console.warn('[email] daily list to', e, 'failed:', err.message); }
    }
  } else {
    for (let i = 0; i < list.length; i += 50) { // big lists: 50 BCC per message keeps well inside Microsoft limits
      await mailer.send({ to: mailer.from(), bcc: list.slice(i, i + 50), subject: d.subject, html: d.html });
      sent++;
    }
  }
  setSetting('daily_last_sent', new Date().toISOString());
  return { sent, recipients: list.length, loads: d.count };
}

function startDailyScheduler() {
  setInterval(() => {
    if (!on('daily_auto') || !mailer.configured()) return;
    const now = new Date();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' })
      .formatToParts(now).map(p => [p.type, p.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
    const hhmm = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
    if (!eset('daily_days').split(',').map(Number).includes(dow)) return;
    if (hhmm < eset('daily_time') || getSetting('daily_last_day') === today) return;
    setSetting('daily_last_day', today);
    sendDailyEmail().then(r => console.log('[email] daily list:', JSON.stringify(r)))
      .catch(e => { console.warn('[email] daily list failed:', e.message); setSetting('email_last_error', `${new Date().toISOString()} daily list: ${e.message}`); });
  }, 60000).unref();
}

const OPS = require('./lib/ops')({ send, fail, readBody, adminLoad, insertLoad, mailer, emailLayout, siteBase, notifyTo, loadSubject, laneOf, usd, hx,
  TIMEZONE, bidStats, loadFacts, serveFile, emailsAfterAward, normalizeMC: qualify.normalizeMC, placeBid: (...a) => placeBid(...a), biddingOpen, carrierContacts, publicConfig, bidStep });

// ---------- placing a bid (website form, email reply, book-it-now) ----------
// Every path goes through here so the same rules apply. Returns { ok, ... } or { ok:false, status, error }.
function placeBid(L, b, opts = {}) {
  const bad = (error, status = 400) => ({ ok: false, status, error });
  if (!L || L.status === 'draft') return bad('This load is no longer posted.', 404);
  if (!biddingOpen(L)) return bad('Bidding is closed for this load.', 409);
  const mc = qualify.normalizeMC(b.mc);
  if (!mc) return bad('Enter your MC number (digits only, e.g. 123456).');
  // Highway check happens behind the scenes for the admin view; it never blocks the bid.
  qualify.check(mc).catch(() => {});
  const bookNow = !!(b.book_now && L.book_rate);
  const amount = bookNow ? Number(L.book_rate) : Math.round(Number(String(b.amount || '').replace(/[^0-9.]/g, '')) * 100) / 100;
  if (!(amount >= 50 && amount <= 250000)) return bad('Enter your all-in rate in dollars, e.g. 2150.');
  // Bid step (default $50): every bid is a multiple of the step (1,000 / 1,050 / 1,100 ...),
  // and a new low must be at least one step under the current bid - including the lead carrier lowering their own.
  // Booking at the posted book-it-now rate skips these rules.
  const step = bidStep();
  const fmt = n => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (step > 0 && !bookNow && !opts.bypassRules) {
    if (Math.abs(amount / step - Math.round(amount / step)) > 1e-9) {
      const down = Math.floor(amount / step) * step, up = down + step;
      return bad(`Bids go in ${fmt(step)} steps, like ${fmt(1000)} or ${fmt(1000 + step)}. Try ${fmt(down)} or ${fmt(up)}.`);
    }
    const low = db.prepare('SELECT MIN(amount) AS low FROM bids WHERE load_id = ?').get(L.id).low;
    const otherLow = db.prepare('SELECT MIN(amount) AS low FROM bids WHERE load_id = ? AND mc != ?').get(L.id, mc).low;
    if (otherLow != null && amount === otherLow)
      return bad(`${fmt(amount)} ties the current bid. Bid ${fmt(otherLow - step)} or less to take the lead.`);
    if (low != null && amount < low && amount > low - step)
      return bad(`Bids must be at least ${fmt(step)} under the current bid of ${fmt(low)}. Bid ${fmt(low - step)} or less.`);
  }
  const s = v => (v == null ? '' : String(v).trim().slice(0, 300));
  const company = s(b.company), contact = s(b.contact_name), email = s(b.email), phone = s(b.phone);
  if (!company) return bad('Enter your company name.');
  if (!contact) return bad('Enter a contact name.');
  if (!email && !phone) return bad('Enter a phone number or email so we can reach you.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('That email address doesn\'t look right.');
  const prevLow = db.prepare('SELECT * FROM bids WHERE load_id = ? ORDER BY amount ASC, created_at ASC LIMIT 1').get(L.id);
  const notes = (bookNow ? '[BOOK IT NOW] ' : '') + s(b.notes).slice(0, 1000);
  db.prepare(`INSERT INTO bids (load_id, mc, company, contact_name, email, phone, amount, notes, ip, book_now, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(load_id, mc) DO UPDATE SET company=excluded.company, contact_name=excluded.contact_name, email=excluded.email,
      phone=excluded.phone, amount=excluded.amount, notes=excluded.notes, ip=excluded.ip, book_now=excluded.book_now, source=excluded.source, updated_at=datetime('now')`)
    .run(L.id, mc, company, contact, email, phone, amount, notes.trim(), opts.ip || '', bookNow ? 1 : 0, opts.source || 'site');
  // private token lets this carrier's browser check "am I the lowest?" later (My bids page)
  let tok = db.prepare('SELECT token FROM bids WHERE load_id = ? AND mc = ?').get(L.id, mc).token;
  if (!tok) { tok = crypto.randomBytes(12).toString('base64url'); db.prepare('UPDATE bids SET token = ? WHERE load_id = ? AND mc = ?').run(tok, L.id, mc); }
  const st = bidStats.get(L.id);
  const bid = db.prepare('SELECT * FROM bids WHERE load_id = ? AND mc = ?').get(L.id, mc);
  if (bookNow) db.prepare(`INSERT INTO load_notes (load_id, kind, text) VALUES (?, 'note', ?)`).run(L.id, `BOOK IT NOW request from ${company} (MC ${mc}) at ${fmt(amount)}${opts.source === 'email' ? ' by email' : ''}`);
  emailsAfterBid(L, bid, prevLow, { bookNow, skipConfirm: !!opts.skipConfirm, kind: opts.source });
  return { ok: true, amount, token: tok, low_bid: st.low_bid, bid_count: st.bid_count, you_are_low: amount <= st.low_bid, book_now: bookNow, bid_id: bid.id,
    next_max: bidStep() ? st.low_bid - bidStep() : null };
}

const INBOX = require('./lib/inbox')({ send, fail, readBody, limited, mailer, emailLayout, siteBase, notifyTo, usd, hx, laneOf, TIMEZONE,
  placeBid: (...a) => placeBid(...a), biddingOpen, publicConfig, bidStats, normalizeMC: qualify.normalizeMC, serveFile, bidStep });

// ---------- router ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;
  const ip = clientIp(req);

  // pages
  if (m === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, 'index.html');
  if (m === 'GET' && /^\/load\/[\w-]+\/?$/.test(p)) return serveFile(res, 'load.html');
  if (m === 'GET' && (p === '/my-bids' || p === '/my-bids/')) return serveFile(res, 'mybids.html');
  if (m === 'GET' && (p === '/admin' || p === '/admin/')) return serveFile(res, 'admin.html');
  if (m === 'GET' && p.startsWith('/static/')) return serveFile(res, p.slice(8).replace(/\.\./g, ''));
  if (m === 'GET' && p === '/healthz') return send(res, 200, 'ok');

  if (await OPS.publicRoutes(m, p, req, res)) return;
  if (await INBOX.publicRoutes(m, p, req, res, ip)) return;

  // ---- public API ----
  if (m === 'GET' && p === '/api/config') return send(res, 200, publicConfig());

  // carrier's own bid status, looked up by the private tokens saved in their browser
  if (m === 'POST' && p === '/api/my-bids') {
    if (limited('mb:' + ip, 120, 600000)) return fail(res, 429, 'Too many requests. Please wait a minute.');
    const { tokens } = await readBody(req, 20000);
    const list = (Array.isArray(tokens) ? tokens : []).map(String).filter(t => /^[\w-]{8,40}$/.test(t)).slice(0, 100);
    const out = [];
    for (const t of list) {
      const b = db.prepare('SELECT * FROM bids WHERE token = ?').get(t);
      if (!b) continue;
      const L = db.prepare(`SELECT * FROM loads WHERE id = ? AND status != 'draft'`).get(b.load_id);
      if (!L) continue;
      const st = bidStats.get(L.id);
      const state = L.status === 'awarded' ? (L.awarded_bid_id === b.id ? 'won' : 'covered')
        : !biddingOpen(L) ? 'closed' : (b.amount <= st.low_bid ? 'leading' : 'outbid');
      out.push({ token: t, public_id: L.public_id, ref: L.ref, origin: [L.origin_city, L.origin_state].filter(Boolean).join(', '),
        dest: [L.dest_city, L.dest_state].filter(Boolean).join(', '), pickup_date: L.pickup_date, equipment: L.equipment, miles: L.miles,
        bid_deadline: L.bid_deadline, my_bid: b.amount, updated_at: b.updated_at, low_bid: st.low_bid, bid_count: st.bid_count,
        state, next_max: bidStep() ? st.low_bid - bidStep() : null, bid_step: bidStep() });
    }
    return send(res, 200, out);
  }

  // bid form: fill in the carrier's company name from the MC number (blank if not on the list)
  if (m === 'GET' && p === '/api/carrier-name') {
    if (limited('n:' + ip, 60, 600000)) return send(res, 200, { name: '' });
    return send(res, 200, { name: qualify.lookupName(url.searchParams.get('mc')) || '' });
  }

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
    const r = placeBid(L, await readBody(req, 20000), { ip, source: 'site' });
    if (!r.ok) return fail(res, r.status || 400, r.error);
    return send(res, 200, r);
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

    if (await OPS.adminRoutes(m, p, url, req, res)) return;
    if (await INBOX.adminRoutes(m, p, url, req, res)) return;
    if (m === 'GET' && p === '/api/admin/me') { const b = baseUrl(req); if (getSetting('base_url') !== b) setSetting('base_url', b); return send(res, 200, { ok: true }); }
    if (p === '/api/admin/email') {
      if (m === 'PUT') {
        const b = await readBody(req, 5000);
        for (const k of [...Object.keys(EMAIL_DEFAULTS), 'notify_email']) if (k in b) setSetting(k, String(b[k] ?? '').slice(0, 200));
      }
      const out = { ...mailer.status(), notify_email: getSetting('notify_email', ''), notify_effective: notifyTo(), daily_last_sent: getSetting('daily_last_sent', ''), base: siteBase() };
      for (const k of Object.keys(EMAIL_DEFAULTS)) out[k] = eset(k);
      return send(res, 200, out);
    }
    if (m === 'POST' && p === '/api/admin/email/test') {
      try {
        await mailer.send({ to: notifyTo(), subject: 'Load board test email', html: emailLayout('It works ✓', `This test was sent by your load board as <b>${hx(mailer.from())}</b>. Bid alerts, carrier confirmations, outbid notices, award notices and the daily load list will come from this address.`) });
        setSetting('email_last_error', '');
        return send(res, 200, { ok: true, to: notifyTo() });
      } catch (e) { setSetting('email_last_error', `${new Date().toISOString()} test: ${e.message}`); return fail(res, 400, e.message); }
    }
    if (m === 'POST' && p === '/api/admin/email/daily') {
      const { onlyPass, loadIds, emails } = await readBody(req, 200000);
      try { return send(res, 200, await sendDailyEmail(baseUrl(req), typeof onlyPass === 'boolean' ? onlyPass : undefined, loadIds, emails)); }
      catch (e) { setSetting('email_last_error', `${new Date().toISOString()} daily list: ${e.message}`); return fail(res, 400, e.message); }
    }

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
      const copy = { ...L, ref: L.ref ? L.ref + ' (copy)' : null, status: 'draft', miles: L.miles_manual ? L.miles : null, aljex_pro: null };
      const id = insertLoad(copy);
      return send(res, 200, adminLoad(db.prepare('SELECT * FROM loads WHERE id = ?').get(id)));
    }
    if (m === 'GET' && (mm = p.match(/^\/api\/admin\/loads\/(\d+)\/bids$/))) {
      const L = db.prepare('SELECT * FROM loads WHERE id = ?').get(Number(mm[1]));
      const est = L ? cost.estimate(L) : null;
      return send(res, 200, db.prepare(`SELECT b.*, CASE WHEN q.mc IS NULL THEN 0 ELSE 1 END AS highway_pass, q.name AS highway_name,
          cp.flag AS carrier_flag, cp.notes AS carrier_notes,
          (SELECT json_object('id', c.id, 'amount', c.amount, 'status', c.status, 'at', COALESCE(c.responded_at, c.created_at)) FROM counters c WHERE c.bid_id = b.id AND c.status != 'withdrawn' ORDER BY c.id DESC LIMIT 1) AS counter
        FROM bids b LEFT JOIN qualified_carriers q ON q.mc = b.mc LEFT JOIN carrier_profiles cp ON cp.mc = b.mc
        WHERE b.load_id = ? ORDER BY b.amount ASC, b.created_at ASC`).all(Number(mm[1]))
        .map(b => ({ ...b, counter: b.counter ? JSON.parse(b.counter) : null, cost_tag: cost.tag(b.amount, est) })));
    }
    // per-load cost overrides (equipment type for the cost model, deadhead %)
    if (m === 'PUT' && (mm = p.match(/^\/api\/admin\/loads\/(\d+)\/cost$/))) {
      const id = Number(mm[1]);
      const b = await readBody(req, 2000);
      const eq = ['van', 'reefer', 'flatbed'].includes(b.equip) ? b.equip : null;
      const dh = b.deadhead_pct === '' || b.deadhead_pct == null || !Number.isFinite(Number(b.deadhead_pct)) ? null : Math.min(200, Math.max(0, Number(b.deadhead_pct)));
      db.prepare('UPDATE loads SET cost_equip = ?, deadhead_pct = ? WHERE id = ?').run(eq, dh, id);
      const L = db.prepare('SELECT * FROM loads WHERE id = ?').get(id);
      return L ? send(res, 200, adminLoad(L)) : fail(res, 404, 'Not found');
    }
    if (p === '/api/admin/cost-model') {
      if (m === 'PUT') return send(res, 200, { model: cost.saveModel(await readBody(req, 20000)), regions: cost.REGIONS });
      if (m === 'DELETE') return send(res, 200, { model: cost.resetModel(), regions: cost.REGIONS });
      if (m === 'GET') return send(res, 200, { model: cost.getModel(), regions: cost.REGIONS, defaults: cost.DEFAULTS });
    }
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/bids\/(\d+)\/award$/))) {
      const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(Number(mm[1]));
      if (!bid) return fail(res, 404, 'Bid not found');
      db.exec('BEGIN');
      db.prepare(`UPDATE bids SET status = CASE WHEN id = ? THEN 'awarded' ELSE 'lost' END WHERE load_id = ?`).run(bid.id, bid.load_id);
      db.prepare(`UPDATE loads SET status = 'awarded', awarded_bid_id = ?, awarded_at = datetime('now'), stage = 'awarded',
        stage_dates = ?, updated_at = datetime('now') WHERE id = ?`).run(bid.id, JSON.stringify({ awarded: new Date().toISOString() }), bid.load_id);
      db.prepare(`INSERT INTO load_notes (load_id, kind, text) VALUES (?, 'stage', ?)`).run(bid.load_id, `Awarded to ${bid.company} (MC ${bid.mc}) at $${Number(bid.amount).toLocaleString('en-US')}`);
      db.exec('COMMIT');
      emailsAfterAward(db.prepare('SELECT * FROM loads WHERE id = ?').get(bid.load_id), bid);
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/loads\/(\d+)\/reopen$/))) {
      const id = Number(mm[1]);
      db.prepare(`UPDATE bids SET status = 'active' WHERE load_id = ?`).run(id);
      db.prepare(`UPDATE loads SET status = 'open', awarded_bid_id = NULL, awarded_at = NULL, stage = NULL, stage_dates = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
      db.prepare(`INSERT INTO load_notes (load_id, kind, text) VALUES (?, 'stage', 'Reopened for bids')`).run(id);
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
    // Delete a carrier's contact: removes every bid placed with that email (awarded bids are kept) + any opt-out entry.
    if (m === 'POST' && p === '/api/admin/contacts/delete') {
      const { email } = await readBody(req, 5000);
      const e = String(email || '').trim().toLowerCase();
      if (!e) return fail(res, 400, 'Missing email');
      const hits = db.prepare('SELECT id, status, email FROM bids').all()
        .filter(b => (String(b.email || '').match(EMAIL_RE) || []).some(x => x.toLowerCase() === e));
      const kept = hits.filter(b => b.status === 'awarded').length;
      db.exec('BEGIN');
      const del = db.prepare('DELETE FROM bids WHERE id = ?');
      hits.filter(b => b.status !== 'awarded').forEach(b => del.run(b.id));
      db.prepare('DELETE FROM email_optout WHERE email = ?').run(e);
      db.exec('COMMIT');
      const onSheet = db.prepare("SELECT 1 FROM qualified_carriers WHERE lower(email) LIKE ?").get('%' + e + '%');
      return send(res, 200, { ok: true, deleted: hits.length - kept, kept_awarded: kept, on_highway_sheet: !!onSheet });
    }
    if (m === 'GET' && p === '/api/admin/digest') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      const d = buildDigest(baseUrl(req), ids);
      d.loads = db.prepare(`SELECT id, public_id, ref, origin_city, origin_state, dest_city, dest_state, pickup_date, equipment FROM loads WHERE status = 'open' ORDER BY pickup_date IS NULL, pickup_date, id`).all()
        .filter(l => biddingOpen(db.prepare('SELECT * FROM loads WHERE id = ?').get(l.id)));
      return send(res, 200, d);
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
  startDailyScheduler();
  OPS.startRepeatScheduler();
  INBOX.start();
  geo.resumePending();
});
