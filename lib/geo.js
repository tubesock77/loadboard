// Geocoding (OpenStreetMap Nominatim) + driving route & miles (OSRM). Free services, no API key.
// Runs in a background queue, one lookup per ~1.1s to respect Nominatim's usage policy.
const { db } = require('./db');

const UA = process.env.GEOCODER_USER_AGENT || 'FreightLoadBoard/1.0 (self-hosted)';
const NOMINATIM = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const OSRM = process.env.OSRM_URL || 'https://router.project-osrm.org';

const cache = new Map();
let lastCall = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

// Each provider returns {lat,lng}, null (looked, not found) or throws (service refused/unreachable).
const providers = [
  async function nominatim({ city, state, zip }) {
    const wait = 1100 - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const params = new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'us,ca,mx' });
    if (city) params.set('q', [city, state, zip].filter(Boolean).join(', ')); else params.set('postalcode', zip);
    const j = await getJson(`${NOMINATIM}/search?${params}`);
    return j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
  },
  async function photon({ city, state, zip }) {
    const q = [city, STATES[state] || state, zip].filter(Boolean).join(', ');
    const j = await getJson(`https://photon.komoot.io/api/?limit=5&q=${encodeURIComponent(q)}`);
    const f = (j.features || []).find(x => ['US', 'CA', 'MX'].includes(String(x.properties && x.properties.countrycode).toUpperCase()));
    return f ? { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] } : null;
  },
  async function openMeteo({ city, state, zip }) {
    const name = city || zip;
    if (!name) return null;
    const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&format=json&name=${encodeURIComponent(name)}`);
    const list = (j.results || []).filter(r => ['US', 'CA', 'MX'].includes(r.country_code));
    const full = STATES[state];
    const hit = list.find(r => full && r.admin1 === full) || (!state ? list[0] : null);
    return hit ? { lat: hit.latitude, lng: hit.longitude } : null;
  },
];

async function geocode(city, state, zip) {
  city = String(city || '').trim(); state = String(state || '').trim().toUpperCase();
  zip = String(zip || '').trim().replace(/\.0+$/, '');
  if (/^\d{4}$/.test(zip)) zip = '0' + zip; // spreadsheets drop the leading zero (e.g. 02101)
  zip = zip.slice(0, 5);
  if (!city && !zip) return null;
  const key = [city, state, zip].join('|').toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const problems = [];
  for (const p of providers) {
    try {
      const r = await p({ city, state, zip });
      if (r && isFinite(r.lat) && isFinite(r.lng)) { cache.set(key, r); return r; }
    } catch (e) { problems.push(`${p.name}: ${e.message}`); }
  }
  if (problems.length === providers.length) throw new Error('all map lookups failed (' + problems.join('; ') + ')');
  cache.set(key, null);
  return null;
}

async function route(a, b) {
  const url = `${OSRM}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=simplified&geometries=geojson`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('router HTTP ' + res.status);
  const j = await res.json();
  const r = j.routes && j.routes[0];
  return r ? { miles: Math.round(r.distance / 1609.344), geometry: r.geometry } : null;
}

function haversineMiles(a, b) {
  const R = 3958.8, toR = d => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function processLoad(id) {
  const L = db.prepare('SELECT * FROM loads WHERE id = ?').get(id);
  if (!L) return;
  try {
    const o = await geocode(L.origin_city, L.origin_state, L.origin_zip);
    const d = await geocode(L.dest_city, L.dest_state, L.dest_zip);
    if (!o || !d) throw new Error(`address not found: ${!o ? [L.origin_city, L.origin_state, L.origin_zip].filter(Boolean).join(' ') : [L.dest_city, L.dest_state, L.dest_zip].filter(Boolean).join(' ')}`);
    let miles = null, geom = null;
    try { const r = await route(o, d); if (r) { miles = r.miles; geom = JSON.stringify(r.geometry); } }
    catch (_) { miles = Math.round(haversineMiles(o, d) * 1.18); } // road-distance estimate if router is down
    db.prepare(`UPDATE loads SET origin_lat=?, origin_lng=?, dest_lat=?, dest_lng=?, route_geojson=?, geo_status='ok', geo_error=NULL,
      miles = CASE WHEN miles_manual = 1 THEN miles ELSE ? END WHERE id = ?`)
      .run(o.lat, o.lng, d.lat, d.lng, geom, miles, id);
  } catch (e) {
    console.warn(`[geo] load ${id}: ${e.message}`);
    try { db.prepare(`UPDATE loads SET geo_status='failed', geo_error=? WHERE id = ?`).run(e.message.slice(0, 300), id); } catch (_) { /* retried on next start */ }
  }
}

const queue = [];
let running = false;
function enqueue(id) {
  if (!queue.includes(id)) queue.push(id);
  if (!running) drain();
}
async function drain() {
  running = true;
  while (queue.length) {
    const id = queue.shift();
    try { await processLoad(id); } catch (e) { console.warn(`[geo] load ${id}: ${e.message}`); }
  }
  running = false;
}
function resumePending() {
  db.prepare(`SELECT id FROM loads WHERE geo_status IN ('pending','failed')`).all().forEach(r => enqueue(r.id));
}
// retry loads that couldn't be mapped (e.g. a lookup service was down) every 20 minutes
setInterval(() => {
  db.prepare(`SELECT id FROM loads WHERE geo_status = 'failed' AND status IN ('open','draft')`).all().forEach(r => enqueue(r.id));
}, 20 * 60000).unref();

module.exports = { enqueue, resumePending };
