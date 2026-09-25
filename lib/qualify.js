// Highway-approved carrier list. Source is a Google Sheet / Excel link (auto-refreshed) or an uploaded file.
// A carrier qualifies if their MC number appears in the list.
const { db, getSetting, setSetting } = require('./db');
const { parseAny } = require('./sheet');

const REFRESH_MINUTES = Number(process.env.CARRIER_REFRESH_MINUTES || 30);

function normalizeMC(v) {
  if (v == null) return '';
  const s = String(v).toUpperCase();
  // ignore values that are clearly DOT numbers
  if (/\bDOT\b/.test(s) && !/\bMC\b/.test(s)) return '';
  const digits = s.replace(/\.0+$/, '').replace(/[^0-9]/g, '').replace(/^0+/, '');
  return digits.length >= 3 && digits.length <= 8 ? digits : '';
}

// Turn a share link into a direct-download link.
function toDownloadUrl(url) {
  url = String(url || '').trim();
  if (!url) return '';
  let m = url.match(/docs\.google\.com\/spreadsheets\/d\/e\/([^/]+)/);
  if (m) {
    const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1];
    return `https://docs.google.com/spreadsheets/d/e/${m[1]}/pub?output=csv${gid ? '&gid=' + gid : ''}`;
  }
  m = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) {
    const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1];
    return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? '&gid=' + gid : ''}`;
  }
  // OneDrive / SharePoint share links: ask for the raw file
  if (/sharepoint\.com|onedrive\.live\.com|1drv\.ms/i.test(url) && !/[?&]download=1/.test(url)) {
    return url + (url.includes('?') ? '&' : '?') + 'download=1';
  }
  return url;
}

const MC_HEADER = /^(mc|mc\s*#|mc\s*no\.?|mc\s*number|mc\s*num|mc_number|mc\/mx|mc\/mx\s*#|mc\/mx\s*number|docket|docket\s*number|docket\s*#)$/i;
const NAME_HEADER = /(legal\s*name|carrier\s*name|company\s*name|company|carrier|dba|name)/i;
const EMAIL_HEADER = /e-?\s*mail/i;

function extractCarriers(rows, mcColumnSetting) {
  const wanted = (mcColumnSetting || '').trim().toLowerCase();
  let headerRow = -1, mcCol = -1, nameCol = -1, emailCol = -1;
  for (let r = 0; r < Math.min(rows.length, 15) && mcCol < 0; r++) {
    rows[r].forEach((h, i) => {
      const t = String(h).trim();
      if (mcCol >= 0) return;
      if (wanted ? t.toLowerCase() === wanted : MC_HEADER.test(t)) { mcCol = i; headerRow = r; }
    });
    if (mcCol < 0 && !wanted) {
      rows[r].forEach((h, i) => { if (mcCol < 0 && /\bmc\b/i.test(String(h)) && !/dot/i.test(String(h))) { mcCol = i; headerRow = r; } });
    }
  }
  if (mcCol >= 0) {
    rows[headerRow].forEach((h, i) => { if (emailCol < 0 && i !== mcCol && EMAIL_HEADER.test(String(h))) emailCol = i; });
    rows[headerRow].forEach((h, i) => { if (nameCol < 0 && i !== mcCol && i !== emailCol && NAME_HEADER.test(String(h))) nameCol = i; });
  } else {
    // No header found: pick the column with the most "MC123456"-looking values
    const scores = {};
    rows.forEach(r => r.forEach((v, i) => { if (/^\s*MC[\s#:-]*\d{3,8}\s*$/i.test(String(v))) scores[i] = (scores[i] || 0) + 1; }));
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    if (!best) throw new Error(wanted
      ? `Couldn't find a column named "${mcColumnSetting}" in the sheet.`
      : 'Couldn\'t find an MC number column. Name the column "MC" or "MC Number", or set the column name in Settings.');
    mcCol = +best[0];
  }
  const out = new Map();
  for (let r = headerRow + 1; r < rows.length; r++) {
    const mc = normalizeMC(rows[r][mcCol]);
    if (mc && !out.has(mc)) {
      const cell = i => (i >= 0 ? String(rows[r][i] || '').trim() : '');
      const emails = (cell(emailCol).match(/[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}/gi) || []).map(e => e.toLowerCase());
      out.set(mc, { name: cell(nameCol), email: [...new Set(emails)].join(', ') });
    }
  }
  return out;
}

function saveCarriers(map, sourceLabel) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM qualified_carriers');
    const ins = db.prepare('INSERT INTO qualified_carriers (mc, name, email) VALUES (?, ?, ?)');
    for (const [mc, v] of map) ins.run(mc, v.name, v.email);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  setSetting('carriers_last_refresh', new Date().toISOString());
  setSetting('carriers_last_error', '');
  setSetting('carriers_source_label', sourceLabel);
  return map.size;
}

let refreshing = null;
async function refreshFromUrl() {
  const url = getSetting('carrier_sheet_url');
  if (!url) throw new Error('No sheet link saved yet.');
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const res = await fetch(toDownloadUrl(url), { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`The sheet link returned HTTP ${res.status}. Make sure it's shared as "Anyone with the link can view".`);
      const buf = Buffer.from(await res.arrayBuffer());
      const map = extractCarriers(parseAny(buf), getSetting('carrier_mc_column'));
      if (map.size === 0) throw new Error('The sheet loaded but no MC numbers were found in it.');
      return saveCarriers(map, 'link');
    } catch (e) {
      setSetting('carriers_last_error', e.message);
      throw e;
    } finally { refreshing = null; }
  })();
  return refreshing;
}

function importFromFile(buf, filename) {
  const map = extractCarriers(parseAny(buf), getSetting('carrier_mc_column'));
  if (map.size === 0) throw new Error('No MC numbers were found in that file.');
  setSetting('carrier_source', 'file');
  return saveCarriers(map, 'file: ' + filename);
}

function status() {
  return {
    source: getSetting('carrier_source', 'url'),
    url: getSetting('carrier_sheet_url', ''),
    mcColumn: getSetting('carrier_mc_column', ''),
    count: db.prepare('SELECT COUNT(*) AS n FROM qualified_carriers').get().n,
    lastRefresh: getSetting('carriers_last_refresh'),
    lastError: getSetting('carriers_last_error', ''),
    sourceLabel: getSetting('carriers_source_label', ''),
    refreshMinutes: REFRESH_MINUTES,
  };
}

function minutesSinceRefresh() {
  const t = getSetting('carriers_last_refresh');
  return t ? (Date.now() - Date.parse(t)) / 60000 : Infinity;
}

async function check(mcInput) {
  const mc = normalizeMC(mcInput);
  if (!mc) return { ok: false, mc: '', reason: 'invalid' };
  const find = () => db.prepare('SELECT mc, name FROM qualified_carriers WHERE mc = ?').get(mc);
  let row = find();
  // Not found? If using a link and the list is a few minutes old, pull a fresh copy once (catches newly approved carriers).
  if (!row && getSetting('carrier_source', 'url') === 'url' && getSetting('carrier_sheet_url') && minutesSinceRefresh() > 3) {
    try { await refreshFromUrl(); row = find(); } catch (_) { /* keep the cached list */ }
  }
  return row ? { ok: true, mc, name: row.name || '' } : { ok: false, mc, reason: 'not_listed' };
}

function startAutoRefresh() {
  const tick = () => {
    if (getSetting('carrier_source', 'url') === 'url' && getSetting('carrier_sheet_url') && minutesSinceRefresh() >= REFRESH_MINUTES) {
      refreshFromUrl().catch(e => console.warn('[carriers] refresh failed:', e.message));
    }
  };
  setTimeout(tick, 5000);
  setInterval(tick, 60000).unref();
}

// Fast name lookup for the bid form (cached list only; never triggers a sheet download).
function lookupName(mcInput) {
  const mc = normalizeMC(mcInput);
  if (!mc) return null;
  const r = db.prepare('SELECT name FROM qualified_carriers WHERE mc = ?').get(mc);
  return r && r.name ? r.name : null;
}

module.exports = { lookupName, normalizeMC, toDownloadUrl, refreshFromUrl, importFromFile, status, check, startAutoRefresh, extractCarriers };
