// Geocoding (OpenStreetMap Nominatim) + driving route & miles (OSRM). Free services, no API key.
// Runs in a background queue, one lookup per ~1.1s to respect Nominatim's usage policy.
const { db } = require('./db');

const UA = process.env.GEOCODER_USER_AGENT || 'FreightLoadBoard/1.0 (self-hosted)';
const NOMINATIM = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const OSRM = process.env.OSRM_URL || 'https://router.project-osrm.org';

const cache = new Map();
let lastCall = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function geocode(city, state, zip) {
  const q = [city, state, zip].filter(Boolean).join(', ');
  if (!q) return null;
  const key = q.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const wait = 1100 - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const params = new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'us,ca,mx' });
  if (zip && !city) params.set('postalcode', zip); else params.set('q', q);
  const res = await fetch(`${NOMINATIM}/search?${params}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('geocoder HTTP ' + res.status);
  const j = await res.json();
  const out = j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
  cache.set(key, out);
  return out;
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
    if (!o || !d) throw new Error('address not found');
    let miles = null, geom = null;
    try { const r = await route(o, d); if (r) { miles = r.miles; geom = JSON.stringify(r.geometry); } }
    catch (_) { miles = Math.round(haversineMiles(o, d) * 1.18); } // road-distance estimate if router is down
    db.prepare(`UPDATE loads SET origin_lat=?, origin_lng=?, dest_lat=?, dest_lng=?, route_geojson=?, geo_status='ok',
      miles = CASE WHEN miles_manual = 1 THEN miles ELSE ? END WHERE id = ?`)
      .run(o.lat, o.lng, d.lat, d.lng, geom, miles, id);
  } catch (e) {
    console.warn(`[geo] load ${id}: ${e.message}`);
    try { db.prepare(`UPDATE loads SET geo_status='failed' WHERE id = ?`).run(id); } catch (_) { /* retried on next start */ }
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

module.exports = { enqueue, resumePending };
