// Admin working tools: address book, saved lanes + repeat posting, tracking after award (stages, notes, documents),
// carrier profiles, counter offers, bulk actions and reports. Rate confirmations are NOT made here — they go out of Aljex.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSetting, setSetting, DATA_DIR } = require('./db');

const DOC_DIR = path.join(DATA_DIR, 'docs');
fs.mkdirSync(DOC_DIR, { recursive: true });

const STAGES = [
  ['awarded', 'Awarded'],
  ['ratecon', 'Rate con sent (Aljex)'],
  ['dispatched', 'Dispatched'],
  ['picked_up', 'Picked up'],
  ['delivered', 'Delivered'],
  ['invoiced', 'Invoiced'],
];
const STAGE_KEYS = STAGES.map(s => s[0]);
const DOC_KINDS = ['Rate con', 'BOL', 'POD', 'Invoice', 'Lumper', 'Other'];
const FACILITY_FIELDS = ['name', 'address', 'city', 'state', 'zip', 'contact', 'phone', 'hours', 'notes'];
const LANE_REPEAT = ['repeat_on', 'repeat_days', 'repeat_time', 'repeat_pickup_days', 'repeat_transit_days', 'repeat_bid_hours'];

const str = (v, n = 500) => (v == null ? '' : String(v).trim().slice(0, n));
const intOr = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

function denverParts(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' })
    .formatToParts(date).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
    dow: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday] };
}
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

module.exports = function ops(ctx) {
  const { send, fail, readBody, adminLoad, insertLoad, mailer, emailLayout, siteBase, notifyTo, loadSubject, laneOf, usd, hx, TIMEZONE, bidStats, loadFacts } = ctx;

  // ---------- helpers ----------
  const getLoad = id => db.prepare('SELECT * FROM loads WHERE id = ?').get(id);
  function laneRow(r) {
    let data = {}; try { data = JSON.parse(r.data || '{}'); } catch (_) { /* ignore */ }
    return { ...r, data, repeat_on: !!r.repeat_on };
  }
  function cleanLaneData(d) {
    const out = {};
    const keep = ['origin_name', 'origin_address', 'origin_city', 'origin_state', 'origin_zip', 'dest_name', 'dest_address', 'dest_city', 'dest_state', 'dest_zip',
      'pickup_window', 'delivery_window', 'equipment', 'temp', 'weight', 'pallets', 'commodity', 'stops', 'requirements', 'notes',
      'target_rate', 'customer', 'customer_rate', 'miles', 'post_rate'];
    for (const k of keep) if (d && d[k] != null && String(d[k]).trim() !== '') out[k] = str(d[k], 2000);
    return out;
  }
  function saveLane(id, b) {
    const name = str(b.name, 120) || 'Saved lane';
    const vals = {
      name, data: JSON.stringify(cleanLaneData(b.data || {})),
      repeat_on: b.repeat_on ? 1 : 0,
      repeat_days: String(b.repeat_days || '1').split(',').map(Number).filter(n => n >= 0 && n <= 6).join(',') || '1',
      repeat_time: /^\d{2}:\d{2}$/.test(b.repeat_time || '') ? b.repeat_time : '07:00',
      repeat_pickup_days: Math.max(0, Math.min(30, intOr(b.repeat_pickup_days, 1))),
      repeat_transit_days: b.repeat_transit_days === '' || b.repeat_transit_days == null ? null : Math.max(0, Math.min(30, intOr(b.repeat_transit_days, 1))),
      repeat_bid_hours: Math.max(1, Math.min(240, intOr(b.repeat_bid_hours, 24))),
    };
    const cols = Object.keys(vals);
    if (id) {
      db.prepare(`UPDATE lanes SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...cols.map(c => vals[c]), id);
      return id;
    }
    return Number(db.prepare(`INSERT INTO lanes (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => vals[c])).lastInsertRowid);
  }

  // post a load from a saved lane (used by the repeat scheduler and the "Post now" button)
  function postFromLane(lane, when = new Date()) {
    const L = laneRow(lane);
    const today = denverParts(when, TIMEZONE).day;
    const pickup = addDays(today, L.repeat_pickup_days ?? 1);
    const data = { ...L.data, status: 'open', pickup_date: pickup,
      delivery_date: L.repeat_transit_days == null ? null : addDays(pickup, L.repeat_transit_days),
      bid_deadline: new Date(when.getTime() + (L.repeat_bid_hours || 24) * 3600000).toISOString() };
    const id = insertLoad(data);
    db.prepare(`UPDATE loads SET lane_id = ?, contact_name = NULL WHERE id = ?`).run(L.id, id);
    db.prepare(`UPDATE lanes SET last_posted = ?, last_load_id = ? WHERE id = ?`).run(today, id, L.id);
    db.prepare(`INSERT INTO load_notes (load_id, kind, text) VALUES (?, 'note', ?)`).run(id, `Posted from saved lane "${L.name}"`);
    if (ctx.holdForFirstLook) ctx.holdForFirstLook(id, true);
    return id;
  }
  function startRepeatScheduler() {
    const tick = () => {
      try {
        const now = new Date();
        const p = denverParts(now, TIMEZONE);
        for (const lane of db.prepare('SELECT * FROM lanes WHERE repeat_on = 1').all()) {
          const days = String(lane.repeat_days || '').split(',').map(Number);
          if (!days.includes(p.dow) || p.hhmm < (lane.repeat_time || '07:00') || lane.last_posted === p.day) continue;
          const id = postFromLane(lane, now);
          console.log(`[lanes] posted "${lane.name}" as load ${id}`);
          ctx.onChange && ctx.onChange();
        }
      } catch (e) { console.warn('[lanes] repeat failed:', e.message); }
    };
    setTimeout(tick, 8000);
    setInterval(tick, 60000).unref();
  }

  // ---------- carriers ----------
  function carrierList() {
    const rows = db.prepare(`SELECT b.mc,
        (SELECT company FROM bids x WHERE x.mc = b.mc ORDER BY x.updated_at DESC LIMIT 1) AS company,
        COUNT(*) AS bids, SUM(CASE WHEN b.status = 'awarded' THEN 1 ELSE 0 END) AS wins, MAX(b.updated_at) AS last_bid,
        MIN(b.amount) AS min_bid
      FROM bids b GROUP BY b.mc ORDER BY last_bid DESC`).all();
    const prof = new Map(db.prepare('SELECT * FROM carrier_profiles').all().map(r => [r.mc, r]));
    const q = new Map(db.prepare('SELECT mc, name, hq_state FROM qualified_carriers').all().map(r => [r.mc, r]));
    const lanes = new Map();
    db.prepare(`SELECT b.mc, l.origin_state AS o, l.dest_state AS d, COUNT(*) AS n FROM bids b JOIN loads l ON l.id = b.load_id
      WHERE l.origin_state IS NOT NULL AND l.dest_state IS NOT NULL GROUP BY b.mc, l.origin_state, l.dest_state ORDER BY n DESC`).all()
      .forEach(r => { if (!lanes.has(r.mc)) lanes.set(r.mc, []); lanes.get(r.mc).push({ o: r.o, d: r.d, n: r.n }); });
    // carriers you added by hand
    for (const m of db.prepare('SELECT * FROM carriers_manual').all()) {
      const key = m.mc || ('email:' + m.email);
      if (!rows.find(r => r.mc === key || (m.mc && r.mc === m.mc))) rows.push({ mc: key, company: m.company || m.name || m.email, bids: 0, wins: 0, last_bid: null, manual: true, email: m.email, contact: m.name, phone: m.phone });
    }
    // carriers with a profile but no bids (e.g. flagged from the Highway list) still show
    for (const [mc, p] of prof) if (!rows.find(r => r.mc === mc)) rows.push({ mc, company: (q.get(mc) || {}).name || '', bids: 0, wins: 0, last_bid: null });
    const manualByMc = new Map(db.prepare(`SELECT * FROM carriers_manual WHERE mc IS NOT NULL AND mc != ''`).all().map(m => [m.mc, m]));
    rows.forEach(r => { const m = manualByMc.get(r.mc); if (m && !r.bids) { r.manual = true; r.email = m.email; } });
    return rows.map(r => ({ ...r, flag: (prof.get(r.mc) || {}).flag || '', notes: (prof.get(r.mc) || {}).notes || '',
      highway_pass: q.has(r.mc), highway_name: (q.get(r.mc) || {}).name || '', hq_state: (q.get(r.mc) || {}).hq_state || '', lanes: lanes.get(r.mc) || [] }));
  }
  function carrierDetail(mc) {
    const p = db.prepare('SELECT * FROM carrier_profiles WHERE mc = ?').get(mc) || { mc, flag: '', notes: '' };
    const q = db.prepare('SELECT * FROM qualified_carriers WHERE mc = ?').get(mc);
    const bids = db.prepare(`SELECT b.id, b.amount, b.status, b.updated_at, b.company, b.contact_name, b.email, b.phone, b.notes,
        l.id AS load_id, l.ref, l.public_id, l.origin_city, l.origin_state, l.dest_city, l.dest_state, l.pickup_date, l.miles, l.status AS load_status, l.awarded_bid_id
      FROM bids b JOIN loads l ON l.id = b.load_id WHERE b.mc = ? ORDER BY b.updated_at DESC LIMIT 200`).all(mc);
    const contacts = [];
    const seen = new Set();
    for (const b of bids) { const k = [b.contact_name, b.email, b.phone].join('|').toLowerCase(); if (!seen.has(k)) { seen.add(k); contacts.push({ name: b.contact_name, email: b.email, phone: b.phone, last: b.updated_at }); } }
    return { mc, flag: p.flag || '', notes: p.notes || '', company: (bids[0] || {}).company || (q && q.name) || '',
      highway: q ? { name: q.name, email: q.email, phone: q.phone, hq_state: q.hq_state, hq_zip: q.hq_zip } : null,
      contacts: contacts.slice(0, 10), bids };
  }

  // ---------- counter offers ----------
  function counterEmail(c, bid, L) {
    const link = `${siteBase()}/counter/${c.token}`;
    return emailLayout(`Counter offer: ${usd(c.amount)}`,
      `Hi ${hx(bid.contact_name || bid.company)}, thanks for your bid of ${usd(bid.amount)} on <b>${hx(laneOf(L))}</b>${L.ref ? ' (#' + hx(L.ref) + ')' : ''}.
       We can do <b>${usd(c.amount)}</b> all-in.${c.message ? `<p><i>“${hx(c.message)}”</i></p>` : ''}${loadFacts(L)}
       <p>Click below to accept or decline. Accepting updates your bid to ${usd(c.amount)}; we'll confirm the award separately.</p>`,
      { url: link, label: 'Review counter offer' });
  }

  // ---------- reports ----------
  function report(from, to) {
    const loads = db.prepare(`SELECT l.*, b.amount AS carrier_rate, b.company AS carrier, b.mc AS carrier_mc,
        (SELECT COUNT(*) FROM bids x WHERE x.load_id = l.id) AS bid_count
      FROM loads l LEFT JOIN bids b ON b.id = l.awarded_bid_id
      WHERE l.status != 'draft' AND date(COALESCE(l.pickup_date, l.created_at)) BETWEEN date(?) AND date(?)`).all(from, to);
    const awarded = loads.filter(l => l.status === 'awarded' && l.carrier_rate);
    const withRev = awarded.filter(l => l.customer_rate);
    const sum = (a, f) => a.reduce((s, x) => s + (Number(f(x)) || 0), 0);
    const revenue = sum(withRev, l => l.customer_rate), carrierCost = sum(withRev, l => l.carrier_rate);
    const group = (arr, keyFn) => {
      const m = new Map();
      for (const l of arr) { const k = keyFn(l); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(l); }
      return [...m.entries()].map(([k, a]) => {
        const rev = a.filter(x => x.customer_rate && x.carrier_rate);
        const r = sum(rev, x => x.customer_rate), c = sum(rev, x => x.carrier_rate);
        return { key: k, loads: a.length, awarded: a.filter(x => x.status === 'awarded').length, revenue: r, cost: c, margin: r - c,
          margin_pct: r ? Math.round((r - c) / r * 1000) / 10 : null, avg_rate: a.filter(x => x.carrier_rate).length ? Math.round(sum(a, x => x.carrier_rate) / a.filter(x => x.carrier_rate).length) : null,
          avg_bids: Math.round(sum(a, x => x.bid_count) / a.length * 10) / 10 };
      }).sort((x, y) => y.loads - x.loads || y.revenue - x.revenue);
    };
    return {
      from, to,
      posted: loads.length, awarded: awarded.length, cover_pct: loads.length ? Math.round(awarded.length / loads.length * 100) : 0,
      avg_bids: loads.length ? Math.round(sum(loads, l => l.bid_count) / loads.length * 10) / 10 : 0,
      no_bids: loads.filter(l => !l.bid_count).length,
      revenue, carrier_cost: carrierCost, margin: revenue - carrierCost, margin_pct: revenue ? Math.round((revenue - carrierCost) / revenue * 1000) / 10 : null,
      with_rate: withRev.length, missing_rate: awarded.length - withRev.length,
      by_customer: group(loads, l => l.customer || '(no customer)').slice(0, 25),
      by_lane: group(loads, l => l.origin_state && l.dest_state ? `${l.origin_state} → ${l.dest_state}` : '').slice(0, 25),
      by_carrier: group(awarded, l => l.carrier ? `${l.carrier} · MC ${l.carrier_mc}` : '').slice(0, 25),
      by_stage: STAGES.map(([k, label]) => ({ key: k, label, n: awarded.filter(l => (l.stage || 'awarded') === k).length })),
    };
  }

  // ---------- routes ----------
  // returns true if handled
  async function adminRoutes(m, p, url, req, res) {
    let mm;
    // address book
    if (p === '/api/admin/facilities') {
      if (m === 'GET') return send(res, 200, db.prepare('SELECT * FROM facilities ORDER BY name COLLATE NOCASE').all()), true;
      if (m === 'POST') {
        const b = await readBody(req, 20000);
        if (!str(b.name)) return fail(res, 400, 'Give the location a name.'), true;
        const vals = FACILITY_FIELDS.map(f => f === 'state' ? str(b[f], 3).toUpperCase() : str(b[f], f === 'notes' ? 2000 : 300));
        const id = Number(db.prepare(`INSERT INTO facilities (${FACILITY_FIELDS.join(',')}) VALUES (${FACILITY_FIELDS.map(() => '?').join(',')})`).run(...vals).lastInsertRowid);
        return send(res, 200, db.prepare('SELECT * FROM facilities WHERE id = ?').get(id)), true;
      }
    }
    if ((mm = p.match(/^\/api\/admin\/facilities\/(\d+)$/))) {
      const id = Number(mm[1]);
      if (m === 'PUT') {
        const b = await readBody(req, 20000);
        const vals = FACILITY_FIELDS.map(f => f === 'state' ? str(b[f], 3).toUpperCase() : str(b[f], f === 'notes' ? 2000 : 300));
        db.prepare(`UPDATE facilities SET ${FACILITY_FIELDS.map(f => f + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, id);
        return send(res, 200, db.prepare('SELECT * FROM facilities WHERE id = ?').get(id)), true;
      }
      if (m === 'DELETE') { db.prepare('DELETE FROM facilities WHERE id = ?').run(id); return send(res, 200, { ok: true }), true; }
    }

    // saved lanes
    if (p === '/api/admin/lanes') {
      if (m === 'GET') return send(res, 200, db.prepare('SELECT * FROM lanes ORDER BY name COLLATE NOCASE').all().map(laneRow)), true;
      if (m === 'POST') { const id = saveLane(null, await readBody(req, 50000)); return send(res, 200, laneRow(db.prepare('SELECT * FROM lanes WHERE id = ?').get(id))), true; }
    }
    if ((mm = p.match(/^\/api\/admin\/lanes\/(\d+)$/))) {
      const id = Number(mm[1]);
      if (m === 'PUT') { saveLane(id, await readBody(req, 50000)); return send(res, 200, laneRow(db.prepare('SELECT * FROM lanes WHERE id = ?').get(id))), true; }
      if (m === 'DELETE') { db.prepare('DELETE FROM lanes WHERE id = ?').run(id); return send(res, 200, { ok: true }), true; }
    }
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/lanes\/(\d+)\/post$/))) {
      const lane = db.prepare('SELECT * FROM lanes WHERE id = ?').get(Number(mm[1]));
      if (!lane) return fail(res, 404, 'Lane not found'), true;
      const id = postFromLane(lane);
      return send(res, 200, adminLoad(getLoad(id))), true;
    }

    // bulk actions on loads
    if (m === 'POST' && p === '/api/admin/loads/bulk') {
      const b = await readBody(req, 50000);
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean).slice(0, 500);
      let n = 0;
      for (const id of ids) {
        const L = getLoad(id); if (!L) continue;
        if (b.action === 'close' && L.status !== 'awarded') { db.prepare(`UPDATE loads SET status = 'closed', updated_at = datetime('now') WHERE id = ?`).run(id); n++; }
        if (b.action === 'draft' && L.status !== 'awarded') { db.prepare(`UPDATE loads SET status = 'draft', updated_at = datetime('now') WHERE id = ?`).run(id); n++; }
        if (b.action === 'open' && L.status !== 'awarded') { db.prepare(`UPDATE loads SET status = 'open', bid_deadline = COALESCE(?, bid_deadline), updated_at = datetime('now') WHERE id = ?`).run(b.deadline || null, id); n++; }
        if (b.action === 'deadline' && b.deadline && L.status !== 'awarded') { db.prepare(`UPDATE loads SET bid_deadline = ?, status = CASE WHEN status = 'closed' THEN 'open' ELSE status END, updated_at = datetime('now') WHERE id = ?`).run(b.deadline, id); n++; }
        if (b.action === 'delete') { db.prepare('DELETE FROM loads WHERE id = ?').run(id); n++; }
      }
      return send(res, 200, { ok: true, changed: n }), true;
    }

    // tracking after award
    if (m === 'GET' && p === '/api/admin/tracking') {
      const rows = db.prepare(`SELECT l.*, b.company AS carrier, b.mc AS carrier_mc, b.amount AS carrier_rate, b.contact_name AS carrier_contact,
          b.phone AS carrier_phone, b.email AS carrier_email,
          (SELECT COUNT(*) FROM load_docs d WHERE d.load_id = l.id) AS doc_count,
          (SELECT text || ' · ' || created_at FROM load_notes n WHERE n.load_id = l.id AND n.kind != 'stage' ORDER BY n.id DESC LIMIT 1) AS last_note
        FROM loads l LEFT JOIN bids b ON b.id = l.awarded_bid_id WHERE l.status = 'awarded'
        ORDER BY CASE COALESCE(l.stage, 'awarded') WHEN 'invoiced' THEN 1 ELSE 0 END, l.pickup_date IS NULL, l.pickup_date DESC, l.id DESC`).all();
      return send(res, 200, { stages: STAGES, loads: rows.map(r => ({ ...r, route_geojson: undefined, stage_dates: JSON.parse(r.stage_dates || '{}') })) }), true;
    }
    if ((mm = p.match(/^\/api\/admin\/loads\/(\d+)\/file$/)) && m === 'GET') {
      const L = getLoad(Number(mm[1])); if (!L) return fail(res, 404, 'Not found'), true;
      const winner = L.awarded_bid_id ? db.prepare('SELECT * FROM bids WHERE id = ?').get(L.awarded_bid_id) : null;
      return send(res, 200, { load: { ...adminLoad(L), stage_dates: JSON.parse(L.stage_dates || '{}') }, winner, stages: STAGES, doc_kinds: DOC_KINDS,
        notes: db.prepare('SELECT * FROM load_notes WHERE load_id = ? ORDER BY id DESC').all(L.id),
        docs: db.prepare('SELECT id, kind, filename, mime, size, created_at FROM load_docs WHERE load_id = ? ORDER BY id DESC').all(L.id) }), true;
    }
    if (m === 'PUT' && (mm = p.match(/^\/api\/admin\/loads\/(\d+)\/stage$/))) {
      const id = Number(mm[1]); const L = getLoad(id); if (!L) return fail(res, 404, 'Not found'), true;
      const b = await readBody(req, 5000);
      const dates = JSON.parse(L.stage_dates || '{}');
      if (b.stage && STAGE_KEYS.includes(b.stage)) {
        const idx = STAGE_KEYS.indexOf(b.stage);
        if (b.undo) { STAGE_KEYS.slice(idx).forEach(k => delete dates[k]); if (!dates.awarded && L.status === 'awarded') dates.awarded = L.awarded_at || new Date().toISOString(); }
        else STAGE_KEYS.slice(0, idx + 1).forEach(k => { if (!dates[k]) dates[k] = b.at || new Date().toISOString(); });
        const cur = [...STAGE_KEYS].reverse().find(k => dates[k]) || null;
        db.prepare(`UPDATE loads SET stage = ?, stage_dates = ?, updated_at = datetime('now') WHERE id = ?`).run(cur, JSON.stringify(dates), id);
        const label = STAGES[idx][1];
        db.prepare(`INSERT INTO load_notes (load_id, kind, text) VALUES (?, 'stage', ?)`).run(id, b.undo ? `Undid: ${label}` : label);
      }
      if ('aljex_pro' in b) db.prepare('UPDATE loads SET aljex_pro = ? WHERE id = ?').run(str(b.aljex_pro, 40) || null, id);
      if ('customer_rate' in b) { const v = Number(String(b.customer_rate || '').replace(/[^0-9.]/g, '')); db.prepare('UPDATE loads SET customer_rate = ? WHERE id = ?').run(v || null, id); }
      if ('customer' in b) db.prepare('UPDATE loads SET customer = ? WHERE id = ?').run(str(b.customer, 200) || null, id);
      return send(res, 200, { ok: true }), true;
    }
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/loads\/(\d+)\/notes$/))) {
      const b = await readBody(req, 20000);
      const text = str(b.text, 4000); if (!text) return fail(res, 400, 'Type a note first.'), true;
      db.prepare(`INSERT INTO load_notes (load_id, kind, text) VALUES (?, ?, ?)`).run(Number(mm[1]), b.kind === 'call' ? 'call' : 'note', text);
      return send(res, 200, { ok: true }), true;
    }
    if (m === 'DELETE' && (mm = p.match(/^\/api\/admin\/notes\/(\d+)$/))) { db.prepare(`DELETE FROM load_notes WHERE id = ? AND kind != 'stage'`).run(Number(mm[1])); return send(res, 200, { ok: true }), true; }
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/loads\/(\d+)\/docs$/))) {
      const id = Number(mm[1]); if (!getLoad(id)) return fail(res, 404, 'Not found'), true;
      const b = await readBody(req, 20 * 1024 * 1024);
      const buf = Buffer.from(String(b.data || ''), 'base64');
      if (!buf.length) return fail(res, 400, 'Empty file'), true;
      if (buf.length > 12 * 1024 * 1024) return fail(res, 400, 'Files can be up to 12 MB.'), true;
      const filename = str(b.filename, 180).replace(/[\\/]/g, '_') || 'document';
      const ext = (path.extname(filename).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || [''])[0];
      const file = `${id}-${crypto.randomBytes(8).toString('hex')}${ext}`;
      fs.writeFileSync(path.join(DOC_DIR, file), buf);
      db.prepare(`INSERT INTO load_docs (load_id, kind, filename, mime, size, file) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, DOC_KINDS.includes(b.kind) ? b.kind : 'Other', filename, str(b.mime, 100) || 'application/octet-stream', buf.length, file);
      return send(res, 200, { ok: true }), true;
    }
    if ((mm = p.match(/^\/api\/admin\/docs\/(\d+)$/))) {
      const d = db.prepare('SELECT * FROM load_docs WHERE id = ?').get(Number(mm[1]));
      if (!d) return fail(res, 404, 'Not found'), true;
      if (m === 'GET') {
        const fp = path.join(DOC_DIR, path.basename(d.file));
        if (!fs.existsSync(fp)) return fail(res, 404, 'File missing'), true;
        const inline = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(d.mime);
        res.writeHead(200, { 'Content-Type': inline ? d.mime : 'application/octet-stream', 'Content-Length': fs.statSync(fp).size,
          'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${d.filename.replace(/[^\w.\- ]/g, '_')}"`, 'Cache-Control': 'private, no-store' });
        fs.createReadStream(fp).pipe(res); return true;
      }
      if (m === 'DELETE') { try { fs.unlinkSync(path.join(DOC_DIR, path.basename(d.file))); } catch (_) { /* already gone */ } db.prepare('DELETE FROM load_docs WHERE id = ?').run(d.id); return send(res, 200, { ok: true }), true; }
    }

    // carrier profiles
    if (m === 'GET' && p === '/api/admin/carrier-profiles') return send(res, 200, carrierList()), true;
    if ((mm = p.match(/^\/api\/admin\/carrier-profiles\/(\d{3,8})$/))) {
      if (m === 'GET') return send(res, 200, carrierDetail(mm[1])), true;
      if (m === 'PUT') {
        const b = await readBody(req, 20000);
        const flag = ['preferred', 'dnu'].includes(b.flag) ? b.flag : '';
        db.prepare(`INSERT INTO carrier_profiles (mc, flag, notes) VALUES (?, ?, ?) ON CONFLICT(mc) DO UPDATE SET flag = excluded.flag, notes = excluded.notes, updated_at = datetime('now')`)
          .run(mm[1], flag, str(b.notes, 4000));
        return send(res, 200, carrierDetail(mm[1])), true;
      }
    }

    // counter offers
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/bids\/(\d+)\/counter$/))) {
      const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(Number(mm[1]));
      if (!bid) return fail(res, 404, 'Bid not found'), true;
      const L = getLoad(bid.load_id);
      if (L.status === 'awarded') return fail(res, 400, 'This load is already awarded.'), true;
      if (!bid.email) return fail(res, 400, 'This carrier left no email, so a counter can\'t be sent. Call them instead.'), true;
      if (!mailer.configured()) return fail(res, 400, 'Email isn\'t connected yet (Settings → Email).'), true;
      if (!siteBase()) return fail(res, 400, 'Set PUBLIC_URL in Render so the counter link works.'), true;
      const b = await readBody(req, 5000);
      const amount = Math.round(Number(String(b.amount || '').replace(/[^0-9.]/g, '')));
      if (!amount || amount < 50) return fail(res, 400, 'Enter a counter amount.'), true;
      db.prepare(`UPDATE counters SET status = 'withdrawn' WHERE bid_id = ? AND status = 'sent'`).run(bid.id);
      const token = crypto.randomBytes(16).toString('base64url');
      const cid = Number(db.prepare(`INSERT INTO counters (bid_id, load_id, amount, message, token) VALUES (?, ?, ?, ?, ?)`).run(bid.id, L.id, amount, str(b.message, 600), token).lastInsertRowid);
      const c = db.prepare('SELECT * FROM counters WHERE id = ?').get(cid);
      try { await mailer.send({ to: bid.email, subject: loadSubject(L), html: counterEmail(c, bid, L) }); }
      catch (e) { db.prepare('DELETE FROM counters WHERE id = ?').run(cid); return fail(res, 400, 'Email failed: ' + e.message), true; }
      db.prepare(`INSERT INTO load_notes (load_id, kind, text) VALUES (?, 'note', ?)`).run(L.id, `Counter ${usd(amount)} sent to ${bid.company} (MC ${bid.mc})`);
      return send(res, 200, { ok: true, counter: c }), true;
    }
    if (m === 'DELETE' && (mm = p.match(/^\/api\/admin\/counters\/(\d+)$/))) {
      db.prepare(`UPDATE counters SET status = 'withdrawn' WHERE id = ? AND status = 'sent'`).run(Number(mm[1]));
      return send(res, 200, { ok: true }), true;
    }

    // fix a carrier rate that was settled outside the site (phone, email, Aljex)
    if (m === 'PUT' && (mm = p.match(/^\/api\/admin\/bids\/(\d+)\/amount$/))) {
      const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(Number(mm[1]));
      if (!bid) return fail(res, 404, 'Bid not found'), true;
      const b = await readBody(req, 5000);
      const amount = Math.round(Number(String(b.amount || '').replace(/[^0-9.]/g, '')) * 100) / 100;
      if (!amount || amount < 1) return fail(res, 400, 'Enter the agreed rate.'), true;
      if (amount === bid.amount) return send(res, 200, { ok: true }), true;
      db.prepare(`UPDATE bids SET amount = ?, updated_at = datetime('now') WHERE id = ?`).run(amount, bid.id);
      db.prepare(`INSERT INTO load_notes (load_id, kind, text) VALUES (?, 'note', ?)`)
        .run(bid.load_id, `Rate for ${bid.company} (MC ${bid.mc}) changed ${usd(bid.amount)} → ${usd(amount)}${str(b.note, 300) ? ' — ' + str(b.note, 300) : ' (settled outside the site)'}`);
      ctx.onChange && ctx.onChange();
      return send(res, 200, { ok: true }), true;
    }
    // award to a carrier booked off the site (they may never have bid)
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/loads\/(\d+)\/manual-award$/))) {
      const L = getLoad(Number(mm[1])); if (!L) return fail(res, 404, 'Not found'), true;
      const b = await readBody(req, 10000);
      const mc = ctx.normalizeMC(b.mc);
      const amount = Math.round(Number(String(b.amount || '').replace(/[^0-9.]/g, '')) * 100) / 100;
      if (!mc) return fail(res, 400, 'Enter the carrier\'s MC number.'), true;
      if (!str(b.company)) return fail(res, 400, 'Enter the carrier\'s company name.'), true;
      if (!amount) return fail(res, 400, 'Enter the agreed rate.'), true;
      const email = str(b.email, 200).toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'That email doesn\'t look right.'), true;
      const note = '[booked outside the site]' + (str(b.note, 300) ? ' ' + str(b.note, 300) : '');
      db.exec('BEGIN');
      try {
        db.prepare(`INSERT INTO bids (load_id, mc, company, contact_name, email, phone, amount, notes, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admin')
          ON CONFLICT(load_id, mc) DO UPDATE SET company = excluded.company, contact_name = COALESCE(NULLIF(excluded.contact_name, ''), bids.contact_name),
            email = COALESCE(NULLIF(excluded.email, ''), bids.email), phone = COALESCE(NULLIF(excluded.phone, ''), bids.phone),
            amount = excluded.amount, notes = TRIM(COALESCE(bids.notes, '') || ' ' || excluded.notes), updated_at = datetime('now')`)
          .run(L.id, mc, str(b.company, 200), str(b.contact_name, 120), email, str(b.phone, 40), amount, note);
        const bid = db.prepare('SELECT * FROM bids WHERE load_id = ? AND mc = ?').get(L.id, mc);
        db.prepare(`UPDATE bids SET status = CASE WHEN id = ? THEN 'awarded' ELSE 'lost' END WHERE load_id = ?`).run(bid.id, L.id);
        const dates = JSON.parse(L.stage_dates || '{}'); if (!dates.awarded) dates.awarded = new Date().toISOString();
        db.prepare(`UPDATE loads SET status = 'awarded', awarded_bid_id = ?, awarded_at = COALESCE(awarded_at, datetime('now')), stage = COALESCE(stage, 'awarded'),
          stage_dates = ?, updated_at = datetime('now') WHERE id = ?`).run(bid.id, JSON.stringify(dates), L.id);
        db.prepare(`INSERT INTO load_notes (load_id, kind, text) VALUES (?, 'stage', ?)`).run(L.id, `Awarded to ${bid.company} (MC ${mc}) at ${usd(amount)} — booked outside the site`);
        db.exec('COMMIT');
        if (b.notify && ctx.emailsAfterAward) ctx.emailsAfterAward(getLoad(L.id), bid);
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      ctx.onChange && ctx.onChange();
      return send(res, 200, { ok: true }), true;
    }

    // reports
    if (m === 'GET' && p === '/api/admin/reports') {
      const today = denverParts(new Date(), TIMEZONE).day;
      const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : addDays(today, -30);
      const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('to') || '') ? url.searchParams.get('to') : addDays(today, 30);
      return send(res, 200, report(from, to)), true;
    }
    return false;
  }

  // public: the carrier's counter-offer page
  async function publicRoutes(m, p, req, res) {
    let mm;
    if (m === 'GET' && /^\/counter\/[\w-]{10,40}\/?$/.test(p)) return ctx.serveFile(res, 'counter.html'), true;
    if ((mm = p.match(/^\/api\/counter\/([\w-]{10,40})$/))) {
      const c = db.prepare('SELECT * FROM counters WHERE token = ?').get(mm[1]);
      if (!c) return fail(res, 404, 'This offer link isn\'t valid.'), true;
      const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(c.bid_id);
      const L = getLoad(c.load_id);
      if (!bid || !L) return fail(res, 404, 'This offer is no longer available.'), true;
      const open = L.status === 'open' || L.status === 'closed';
      const view = () => ({ status: c.status, amount: c.amount, message: c.message, your_bid: (db.prepare('SELECT amount FROM bids WHERE id = ?').get(bid.id) || bid).amount, company: bid.company, mc: bid.mc,
        load: { public_id: L.public_id, ref: L.ref, lane: laneOf(L), pickup_date: L.pickup_date, delivery_date: L.delivery_date, equipment: L.equipment, miles: L.miles,
          awarded: L.status === 'awarded', awarded_to_you: L.awarded_bid_id === bid.id } });
      if (m === 'GET') return send(res, 200, view()), true;
      if (m === 'POST') {
        const b = await readBody(req, 2000);
        if (c.status !== 'sent') return fail(res, 400, c.status === 'withdrawn' ? 'This offer was withdrawn.' : `You already ${c.status} this offer.`), true;
        if (!open) return fail(res, 400, 'This load has been covered.'), true;
        const accept = b.action === 'accept';
        db.prepare(`UPDATE counters SET status = ?, responded_at = datetime('now') WHERE id = ?`).run(accept ? 'accepted' : 'declined', c.id);
        if (accept) db.prepare(`UPDATE bids SET amount = ?, notes = TRIM(COALESCE(notes, '') || ' [accepted counter ' || ? || ']'), updated_at = datetime('now') WHERE id = ?`).run(c.amount, usd(c.amount), bid.id);
        db.prepare(`INSERT INTO load_notes (load_id, kind, text) VALUES (?, 'note', ?)`).run(L.id, `${bid.company} (MC ${bid.mc}) ${accept ? 'ACCEPTED' : 'declined'} counter ${usd(c.amount)}`);
        c.status = accept ? 'accepted' : 'declined';
        if (mailer.configured()) mailer.sendQuiet({ to: notifyTo(), replyTo: bid.email || undefined, subject: `Counter ${accept ? 'accepted' : 'declined'} ${usd(c.amount)} · ${loadSubject(L)}`,
          html: emailLayout(`Counter ${accept ? 'accepted' : 'declined'}: ${usd(c.amount)}`,
            `<b>${hx(bid.company)}</b> (MC ${hx(bid.mc)}) ${accept ? '<b style="color:#17724A">accepted</b>' : '<b style="color:#B42318">declined</b>'} your counter of ${usd(c.amount)} on <b>${hx(laneOf(L))}</b>${L.ref ? ' (#' + hx(L.ref) + ')' : ''}.
             ${accept ? '<p>Their bid is now ' + usd(c.amount) + '. Award it in admin when you\'re ready.</p>' : ''}`,
            siteBase() ? { url: `${siteBase()}/admin`, label: 'Open admin' } : null) }, 'counter reply');
        ctx.onChange && ctx.onChange();
        return send(res, 200, view()), true;
      }
    }
    return false;
  }

  // server-side lane matching for the automatic daily list
  function matchingEmails(loads, contacts) {
    const lanes = new Set(loads.map(l => `${l.origin_state}>${l.dest_state}`));
    const origins = new Set(loads.map(l => l.origin_state).filter(Boolean));
    const dests = new Set(loads.map(l => l.dest_state).filter(Boolean));
    const dnu = new Set(db.prepare(`SELECT mc FROM carrier_profiles WHERE flag = 'dnu'`).all().map(r => r.mc));
    return contacts.filter(c => !dnu.has(c.mc) && (
      c.lanes.some(x => lanes.has(`${x.o}>${x.d}`) || origins.has(x.o) || dests.has(x.d)) || (c.hq_state && origins.has(c.hq_state))
    )).map(c => c.email);
  }

  return { adminRoutes, publicRoutes, startRepeatScheduler, matchingEmails, STAGES };
};
