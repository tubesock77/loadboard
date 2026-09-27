// Truck operating cost model: break-even, market check and bid margin tags (admin only).
// Based on ATRI 2026 (2025 data), EIA weekly regional diesel and DAT spot rates. Every number is editable in Admin → Settings.
const { getSetting, setSetting } = require('./db');

const DEFAULTS = {
  equip: {
    van:     { label: 'Dry van', nonfuel: 1.854, mpg: 6.5, extra: 0,    market: 2.89 },
    reefer:  { label: 'Reefer',  nonfuel: 1.95,  mpg: 6.2, extra: 0.09, market: 3.38 },
    flatbed: { label: 'Flatbed', nonfuel: 1.95,  mpg: 6.0, extra: 0,    market: 3.54 },
  },
  diesel: { US: 6.529, NE: 6.517, CA: 6.546, LA: 6.139, MW: 6.680, GC: 6.177, RM: 6.340, WC: 7.456, CAL: 8.246 },
  diesel_asof: 'EIA week of Sep 21, 2026',
  market_asof: 'DAT spot all-in, Aug 2026 avg',
  deadhead_pct: 15,
  thin_pct: 10,
  fair_pct: 20,
};

const REGIONS = {
  US: 'U.S. average', NE: 'New England', CA: 'Central Atlantic', LA: 'Lower Atlantic', MW: 'Midwest',
  GC: 'Gulf Coast', RM: 'Rocky Mountain', WC: 'West Coast (not CA)', CAL: 'California',
};
const STATE_REGION = {};
const put = (r, list) => list.split(' ').forEach(s => { STATE_REGION[s] = r; });
put('NE', 'CT ME MA NH RI VT');
put('CA', 'DE DC MD NJ NY PA');
put('LA', 'FL GA NC SC VA WV');
put('MW', 'IL IN IA KS KY MI MN MO NE ND SD OH OK TN WI');
put('GC', 'AL AR LA MS NM TX');
put('RM', 'CO ID MT UT WY');
put('WC', 'AK AZ HI NV OR WA');
put('CAL', 'CA');

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function getModel() {
  let saved = {};
  try { saved = JSON.parse(getSetting('cost_model', '{}') || '{}'); } catch (_) { saved = {}; }
  const m = JSON.parse(JSON.stringify(DEFAULTS));
  for (const k of Object.keys(m.equip)) {
    const s = (saved.equip || {})[k] || {};
    for (const f of ['nonfuel', 'mpg', 'extra', 'market']) m.equip[k][f] = num(s[f], m.equip[k][f]);
  }
  for (const r of Object.keys(m.diesel)) m.diesel[r] = num((saved.diesel || {})[r], m.diesel[r]);
  for (const f of ['deadhead_pct', 'thin_pct', 'fair_pct']) m[f] = num(saved[f], m[f]);
  for (const f of ['diesel_asof', 'market_asof']) if (typeof saved[f] === 'string') m[f] = saved[f].slice(0, 80);
  return m;
}

function saveModel(body) {
  const cur = getModel();
  const b = body || {};
  for (const k of Object.keys(cur.equip)) {
    const s = (b.equip || {})[k] || {};
    for (const f of ['nonfuel', 'mpg', 'extra', 'market']) if (f in s) cur.equip[k][f] = num(s[f], cur.equip[k][f]);
    if (!(cur.equip[k].mpg > 0)) cur.equip[k].mpg = DEFAULTS.equip[k].mpg;
  }
  for (const r of Object.keys(cur.diesel)) if (b.diesel && r in b.diesel) cur.diesel[r] = num(b.diesel[r], cur.diesel[r]);
  for (const f of ['deadhead_pct', 'thin_pct', 'fair_pct']) if (f in b) cur[f] = Math.max(0, num(b[f], cur[f]));
  for (const f of ['diesel_asof', 'market_asof']) if (typeof b[f] === 'string') cur[f] = b[f].slice(0, 80);
  const out = { equip: {}, diesel: cur.diesel, diesel_asof: cur.diesel_asof, market_asof: cur.market_asof, deadhead_pct: cur.deadhead_pct, thin_pct: cur.thin_pct, fair_pct: cur.fair_pct };
  for (const k of Object.keys(cur.equip)) { const { label, ...rest } = cur.equip[k]; out.equip[k] = rest; }
  setSetting('cost_model', JSON.stringify(out));
  return getModel();
}
function resetModel() { setSetting('cost_model', '{}'); return getModel(); }

// "Reefer 53'", "Flatbed", "Step deck", "53' Van" → model key
function equipFromText(equipment, temp) {
  const t = String(equipment || '').toLowerCase();
  if (/reefer|refrig|temp|frozen|\brf\b/.test(t)) return 'reefer';
  if (/flat|step|deck|rgn|lowboy|conestoga|\bfb\b|\bsd\b/.test(t)) return 'flatbed';
  if (/van|dry|\bdv\b|\bv\b/.test(t)) return 'van';
  if (!t && String(temp || '').trim()) return 'reefer';
  return '';
}

function regionOf(state) { return STATE_REGION[String(state || '').trim().toUpperCase()] || 'US'; }

function estimate(L, model) {
  const m = model || getModel();
  const miles = Number(L.miles) || 0;
  const guessed = equipFromText(L.equipment, L.temp);
  const key = m.equip[L.cost_equip] ? L.cost_equip : (guessed || 'van');
  const source = m.equip[L.cost_equip] ? 'set' : guessed ? 'load' : 'default';
  const e = m.equip[key];
  const ro = regionOf(L.origin_state), rd = regionOf(L.dest_state);
  const diesel = (m.diesel[ro] + m.diesel[rd]) / 2;
  const cpm = e.nonfuel + diesel / e.mpg + e.extra;
  const dh = L.deadhead_pct != null && L.deadhead_pct !== '' && Number.isFinite(Number(L.deadhead_pct)) ? Number(L.deadhead_pct) : m.deadhead_pct;
  const r2 = v => Math.round(v * 100) / 100;
  const out = {
    equip: key, equip_label: e.label, equip_source: source, guessed: guessed || '',
    origin_region: REGIONS[ro], dest_region: REGIONS[rd], diesel: r2(diesel), cpm: r2(cpm),
    deadhead_pct: dh, deadhead_is_default: dh === m.deadhead_pct && (L.deadhead_pct == null || L.deadhead_pct === ''),
    market_rate: e.market, thin_pct: m.thin_pct, fair_pct: m.fair_pct, miles: miles || null,
  };
  if (!miles) return out;
  const total = miles * (1 + dh / 100);
  out.deadhead_miles = Math.round(total - miles);
  out.total_miles = Math.round(total);
  out.breakeven = Math.round(total * cpm);
  out.be_per_mile = r2(out.breakeven / miles);
  out.market = Math.round(miles * e.market);
  return out;
}

function tag(amount, est) {
  if (!est || !est.breakeven || !amount) return null;
  const margin = amount - est.breakeven;
  const pct = margin / amount * 100;
  const label = margin < 0 ? 'Below cost' : pct < est.thin_pct ? 'Thin' : pct < est.fair_pct ? 'Fair' : 'Padded';
  return { margin: Math.round(margin), pct: Math.round(pct * 10) / 10, label };
}

module.exports = { DEFAULTS, REGIONS, STATE_REGION, getModel, saveModel, resetModel, estimate, tag, equipFromText };
