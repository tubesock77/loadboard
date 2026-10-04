// loads@ inbox assistant (no AI): reads carrier emails, works out what they want with plain rules,
// and answers with canned replies filled from the load board. Also runs lane alerts.
//
// Modes (Admin → Inbox): off | review (replies wait for you to click Send) | auto (sends on its own).
// Anything it can't understand is left for you. It never deletes, moves or flags mail.
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id TEXT UNIQUE NOT NULL, conv_id TEXT,
  from_email TEXT, from_name TEXT, subject TEXT, body TEXT, received_at TEXT, web_link TEXT,
  kind TEXT,                     -- remove | bid | book | load_question | lane | truck | unknown | ignored
  status TEXT,                   -- draft | sent | needs_you | done | ignored | error
  summary TEXT,                  -- what the rules found, in plain words
  plan TEXT,                     -- JSON: actions to run + reply to send
  load_ids TEXT,                 -- JSON array of load ids referenced or listed in the reply
  mc TEXT, amount REAL, lane TEXT,
  reply_subject TEXT, reply_html TEXT, result TEXT, error TEXT,
  sent_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS inbox_status ON inbox(status);
CREATE INDEX IF NOT EXISTS inbox_from ON inbox(from_email);
CREATE TABLE IF NOT EXISTS lane_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL, name TEXT, mc TEXT,
  o_state TEXT, d_state TEXT, o_city TEXT, d_city TEXT, equipment TEXT, avail_date TEXT,
  kind TEXT DEFAULT 'lane',      -- lane | truck
  source TEXT DEFAULT 'email',   -- email | site | admin
  token TEXT UNIQUE, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT, last_sent_at TEXT, sent_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS lane_alerts_email ON lane_alerts(email);
CREATE TABLE IF NOT EXISTS carrier_links (
  token TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, company TEXT, mc TEXT, phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), used_at TEXT
);
CREATE TABLE IF NOT EXISTS alert_sends (
  alert_id INTEGER NOT NULL, load_id INTEGER NOT NULL, sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (alert_id, load_id)
);
`);

// ---------- canned replies (editable in Admin → Inbox → Replies) ----------
const TEMPLATES = {
  tpl_greeting: 'Hi {first_name},',
  tpl_loads: "Thanks for reaching out. Here's what we have {lane_text} right now:",
  tpl_more: 'We also have these nearby:',
  tpl_none: "We don't have anything {lane_text} right now. We saved your lane and we'll email you as soon as something posts.",
  tpl_howto: 'Tap a button under the load, or just reply with your all-in rate and MC#.',
  tpl_buttons_note: "No login or forms. We'll confirm with you directly before anything is booked.",
  tpl_load: 'Here are the details for this load:',
  tpl_bid: 'Got it — your offer of {rate} on {lane} is in. {standing}',
  tpl_bid_problem: "Thanks — we couldn't enter your bid on {lane} (load #{load}): {problem}",
  tpl_book: "Got it — you asked to book {lane} (load #{load}) at {rate}. We'll confirm shortly and send the rate confirmation.",
  tpl_closed: 'Thanks — {lane} is no longer available.',
  tpl_remove: "You're off our load list. Reply anytime if you want back on.",
  tpl_alert: 'A load just posted on a lane you asked about:',
  tpl_notify: 'We have a load on a lane you run:',
  tpl_not_approved: "Thanks for reaching out. We checked MC {mc} and it doesn't currently pass our carrier vetting through Highway, so we aren't able to work with you on our loads right now. Please reach out to Highway (highway.com) to see what's needed to get approved — once you pass, we'd be glad to work with you.",
  tpl_first_look: "You're getting first look at this load before it goes out to our full list:",
  tpl_value: '',
  tpl_signoff: 'Thanks,\n{company}',
};
// an older built-in wording that was saved unchanged follows the new built-in wording
const OLD_DEFAULTS = { tpl_not_approved: "Thanks for reaching out. We checked MC {mc} and it doesn't currently meet our carrier requirements, so we aren't able to work with you on our loads right now. If that changes, feel free to reach out again." };
const tpl = k => { const v = getSetting(k); return v == null || v === OLD_DEFAULTS[k] ? TEMPLATES[k] : v; };

const STATE_NAMES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY' };
const STATES = new Set(Object.values(STATE_NAMES).concat('DC'));
const STATE_RE = Object.keys(STATE_NAMES).sort((a, b) => b.length - a.length).join('|');

module.exports = function inbox(ctx) {
  const { mailer, emailLayout, siteBase, notifyTo, usd, hx, laneOf, TIMEZONE, placeBid, biddingOpen, publicConfig, bidStats, normalizeMC } = ctx;
  const inFirstLook = ctx.inFirstLook || (() => false);
  const mode = () => getSetting('inbox_mode', 'off');
  const now = () => new Date().toISOString();

  // ---------- text helpers ----------
  function newText(body) {
    // keep only what the sender wrote, not the quoted email below it
    const self = String(mailer.from() || '').toLowerCase();
    const lines = String(body || '').replace(/\r/g, '').split('\n');
    const out = [];
    for (const ln of lines) {
      if (/^\s*>/.test(ln)) break;
      if (/^\s*(-{2,}\s*original message|_{5,}|from:\s.+|sent from my|on .{4,80} wrote:$|-----\s*forwarded)/i.test(ln)) break;
      if (/wrote:\s*$/i.test(ln) || /^\s*on\s.{3,60}\b\d{1,2}:\d{2}\s*(am|pm)?\b/i.test(ln) || /^\s*(sent|date):\s.+\d{4}/i.test(ln)) break; // gmail/iphone quote header (can wrap)
      if (self && ln.toLowerCase().includes(self) && out.length) break;                                          // our own email quoted below theirs
      out.push(ln);
    }
    return out.join('\n').trim().slice(0, 4000);
  }
  function knownCities() {
    const m = new Map();
    db.prepare(`SELECT origin_city c, origin_state s FROM loads WHERE origin_city IS NOT NULL UNION SELECT dest_city, dest_state FROM loads WHERE dest_city IS NOT NULL
      UNION SELECT city, state FROM facilities WHERE city IS NOT NULL`).all()
      .forEach(r => { if (r.c && r.s && STATES.has(String(r.s).toUpperCase())) m.set(r.c.toLowerCase().trim(), String(r.s).toUpperCase()); });
    return m;
  }
  const title = s => String(s || '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).trim();

  // one side of a lane: "Denver, CO" / "Denver CO 80216" / "CO" / "Colorado" / "Denver" (if a known city)
  function place(raw, cities) {
    let t = String(raw || '').replace(/[()"'.]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    let m = t.match(/^(.*?)[,\s]+([A-Za-z]{2})(?:\s+\d{5})?$/);
    if (m && STATES.has(m[2].toUpperCase()) && m[1].trim() && !/^(to|from|out|of|in)$/i.test(m[1].trim())) return { city: title(m[1]), state: m[2].toUpperCase() };
    if (/^[A-Z]{2}$/.test(t) && STATES.has(t)) return { state: t };
    const nm = STATE_NAMES[t.toLowerCase()]; if (nm) return { state: nm };
    const c = cities.get(t.toLowerCase()); if (c) return { city: title(t), state: c };
    // last words might be the city ("loads out of salt lake city")
    const words = t.split(' ');
    for (let i = 0; i < words.length; i++) { const tail = words.slice(i).join(' ').toLowerCase(); if (cities.has(tail)) return { city: title(tail), state: cities.get(tail) }; if (STATE_NAMES[tail]) return { state: STATE_NAMES[tail] }; }
    return null;
  }

  // "Spanish Spgs" → "Spanish Springs", "SLC" → "Salt Lake City", "Ft Worth" → "Fort Worth"
  const CITY_ABBR = [[/\bspgs?\b\.?/gi, 'Springs'], [/\bmtn\b\.?/gi, 'Mountain'], [/\bft\b\.?/gi, 'Fort'], [/\bhts\b\.?/gi, 'Heights'], [/\bjct\b\.?/gi, 'Junction'],
    [/\bpt\b\.?/gi, 'Point'], [/\bslc\b/gi, 'Salt Lake City'], [/\bst\.\s+(?=[a-z])/gi, 'Saint '], [/\bcty\b\.?/gi, 'City'], [/\bvly\b\.?/gi, 'Valley'], [/\bbch\b\.?/gi, 'Beach']];
  const unAbbr = t => CITY_ABBR.reduce((x, [re, v]) => x.replace(re, v), String(t || ''));
  const noIds = t => String(t || '').replace(/\b(?:MC|M\.C\.|DOT|USDOT|docket)\s*[#:.-]*\s*\d{4,8}\b.*$/i, '').trim();
  // loose city match: blank matches anything; otherwise same first word or one name starts with the other
  function cityOk(a, b) {
    if (!a || !b) return true;
    const n = x => unAbbr(x).toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
    const x = n(a), y = n(b);
    return x === y || x.startsWith(y) || y.startsWith(x) || x.split(' ')[0] === y.split(' ')[0];
  }
  function findLane(subject, text) {
    const cities = knownCities();
    // labeled lines: "Pick Up: Spanish Spgs, NV" / "Drop Off: Salt Lake City, UT"
    {
      const all = `${String(subject || '')}\n${String(text || '').slice(0, 2000)}`;
      const lab = re => { const m = all.match(re); return m ? place(unAbbr(noIds(m[1])).replace(/\s+(on|for|at|by|pick|pu|del|appt|appointment)\b.*$/i, ''), cities) : null; };
      const o = lab(/^\s*(?:pick[\s-]?up|pu|p\/u|origin|orig|from|shipper|pickup location|loading)\s*(?:city|location)?\s*[:\-–]\s*([^\n]{2,60})$/im);
      const d = lab(/^\s*(?:drop[\s-]?off|drop|delivery|deliver(?:ing)?|del|dest(?:ination)?|consignee|to|delivery location|unloading)\s*(?:city|location)?\s*[:\-–]\s*([^\n]{2,60})$/im);
      if (o && d) return { o, d };
    }
    const srcs = [String(subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, ''), text.slice(0, 1500)];
    const side = `([A-Za-z][A-Za-z .'-]{0,40}?,?\\s*\\b[A-Z]{2}\\b(?:\\s+\\d{5})?|[A-Za-z][A-Za-z .'-]{1,40}?)`;
    const sep = `\\s*(?:\\bto\\b|->|→|>|–|—|-|/|\\bthru\\b)\\s*`;
    for (const src of srcs) {
      for (const rawLine of src.split('\n')) {
        const line = unAbbr(rawLine.replace(/\b(?:MC|M\.C\.|DOT|USDOT)\s*[#:.-]*\s*\d{4,8}\b/gi, ' '));
        // "Liberty, MO (0) Salt Lake City, UT" / "Liberty, MO  Salt Lake City, UT" (load-board replies: no word between)
        const pp = line.match(/([A-Za-z][A-Za-z .'-]{1,40}?),\s*([A-Z]{2})\b[^A-Za-z]{1,14}?([A-Za-z][A-Za-z .'-]{1,40}?),\s*([A-Z]{2})\b/);
        if (pp && STATES.has(pp[2]) && STATES.has(pp[4])) {
          const a = place(pp[1].replace(/^.*\b(lanes?|loads?|freight|anything|looking for|need|have|from|out of|any|re|fw|fwd)\b\s*:?\s*/i, '') + ', ' + pp[2], cities), b = place(pp[3].replace(/^\s*(to|thru)\s+/i, '') + ', ' + pp[4], cities);
          if (a && b) return { o: a, d: b };
        }
        // two-sided lanes
        const re = new RegExp(`${side}${sep}${side}(?=$|[\\s,.;!?)]|\\s+(?:on|for|with|this|next|pick|pu|tomorrow|today|mon|tue|wed|thu|fri|sat|sun|\\d))`, 'gi');
        let m;
        while ((m = re.exec(line))) {
          const a = place(m[1].replace(/^.*\b(lanes?|loads?|freight|anything|looking for|need|have|from|out of|any)\b\s*/i, ''), cities);
          const b = place(m[2], cities);
          if (a && b && !(a.state === b.state && !a.city && !b.city && m[0].length < 6)) return { o: a, d: b };
        }
        // bare state pair in capitals: "CO-TX", "UT to CA"
        const sp = line.match(/\b([A-Z]{2})\s*(?:to|-|>|→|\/)\s*([A-Z]{2})\b/);
        if (sp && STATES.has(sp[1]) && STATES.has(sp[2])) return { o: { state: sp[1] }, d: { state: sp[2] } };
        const nm = line.match(new RegExp(`\\b(${STATE_RE})\\s+(?:to|-|>)\\s+(${STATE_RE})\\b`, 'i'));
        if (nm) return { o: { state: STATE_NAMES[nm[1].toLowerCase()] }, d: { state: STATE_NAMES[nm[2].toLowerCase()] } };
      }
    }
    // one-sided: "out of Denver", "empty in Salt Lake City UT", "headed to Texas"
    const all = srcs.join('\n');
    const oneSide = (re) => { const m = all.match(re); return m ? place(m[1].split(/\s+(?:on|for|this|next|by|and|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|with|\d)/i)[0], cities) : null; };
    const o = oneSide(/\b(?:out of|outta|from|empty in|empty at|available in|avail in|truck in|trucks in|unloading in|delivering in|sitting in|leaving|picking up in|near)\s+([A-Za-z][A-Za-z ,.'-]{1,40}?(?:\s+\d{5})?)(?=$|[\n,.;!?]|\s+(?:on|for|this|next|by|and|going|headed|to|tomorrow|today|mon|tue|wed|thu|fri|sat|sun|with|\d))/i);
    const d = oneSide(/\b(?:headed to|heading to|going to|back to|home to|into|toward|towards)\s+([A-Za-z][A-Za-z ,.'-]{1,40}?(?:\s+\d{5})?)(?=$|[\n,.;!?]|\s+(?:on|for|this|next|by|and|tomorrow|today|mon|tue|wed|thu|fri|sat|sun|with|\d))/i);
    if (o || d) return { o: o || null, d: d || null };
    return null;
  }

  function findDate(text) {
    const t = String(text || '').toLowerCase();
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
    const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (/\btoday\b|\bnow\b|\bready\b/.test(t)) return ymd(today);
    if (/\btomorrow\b|\btmrw\b/.test(t)) { const d = new Date(today); d.setDate(d.getDate() + 1); return ymd(d); }
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const wd = t.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/);
    if (wd) { const d = new Date(today); const want = days.indexOf(wd[1]); let add = (want - d.getDay() + 7) % 7; if (add === 0) add = 0; d.setDate(d.getDate() + add); return ymd(d); }
    const m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (m) { const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : today.getFullYear(); return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; }
    return '';
  }
  function findEquipment(text) {
    const t = String(text || '');
    if (/\breefer|refrigerated|\brf\b/i.test(t)) return 'reefer';
    if (/flat ?bed|step ?deck|\bfb\b/i.test(t)) return 'flatbed';
    if (/\bvan\b|dry van|\bdv\b/i.test(t)) return 'van';
    return '';
  }
  // our own MC (from the company name, e.g. "Brock LLC MC# 375005") is never the carrier's
  const ownMC = () => normalizeMC((String(publicConfig().company || '').match(/MC\s*#?\s*(\d{4,8})/i) || [])[1] || '');
  function findMC(text) {
    const own = ownMC(), re = /\b(?:MC|M\.C\.|docket)[\s#:.-]*(\d{4,8})\b/gi; let m;
    while ((m = re.exec(String(text || '')))) { const v = normalizeMC(m[1]); if (v && v !== own) return v; }
    return '';
  }
  function findRate(text, mc) {
    const t = String(text || '').replace(/\b(?:MC|DOT|USDOT)\s*[#:.-]?\s*\d{4,8}\b/gi, ' ').replace(/\b\d{5}(?:-\d{4})?\b(?=\s*$|\s*\n)/g, ' ')
      .replace(/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g, ' ').replace(/\b\d{1,2},?\d{3}\s*(?:lbs?|pounds|#)\b/gi, ' ').replace(/\b\d{1,3}(?:\.\d+)?\s*(?:mi|miles|loaded miles)\b/gi, ' ');
    const cands = [];
    let m;
    const push = v => { const n = Number(String(v).replace(/,/g, '')); if (n >= 300 && n <= 25000 && String(n) !== String(mc)) cands.push(n); };
    const r1 = /\$\s?(\d{1,2},?\d{3}(?:\.\d{2})?|\d{3})\b/g; while ((m = r1.exec(t))) push(m[1]);
    if (cands.length) return cands[0];
    const r2 = /\b(?:rate|bid|do it for|do|at|for|all[- ]?in|offer|need|price|number)\s*(?:is|of|:)?\s*\$?\s?(\d{1,2},?\d{3})\b/gi; while ((m = r2.exec(t))) push(m[1]);
    if (cands.length) return cands[0];
    const r3 = /\b(\d{1,2},?\d{3})\s*(?:all[- ]?in|flat|total|usd|dollars|firm|\$)/gi; while ((m = r3.exec(t))) push(m[1]);
    if (cands.length) return cands[0];
    // a message that is basically just a number: "2400" / "2,450 thanks"
    const r4 = t.trim().match(/^\$?\s?(\d{1,2},?\d{3})\b/); if (r4) push(r4[1]);
    return cands[0] || null;
  }

  // loads open to everyone (a load in first look is only for your favorites)
  function openLoads() { return db.prepare(`SELECT * FROM loads WHERE status = 'open'`).all().filter(biddingOpen).filter(L => !inFirstLook(L)); }
  function findLoadRef(subject, text) {
    const all = `${subject}\n${text}`;
    let m = all.match(/\bL-[23456789A-HJ-NP-Z]{6}\b/);
    if (m) { const L = db.prepare('SELECT * FROM loads WHERE public_id = ?').get(m[0]); if (L) return L; }
    m = String(subject || '').match(/\bLoad\s+([A-Za-z0-9][A-Za-z0-9-]{1,30})\s*·/);
    if (m) { const L = db.prepare(`SELECT * FROM loads WHERE (ref = ? OR public_id = ?) AND status != 'draft' ORDER BY id DESC`).get(m[1], m[1]); if (L) return L; }
    // subject names one of our open loads by its cities — e.g. a load-board reply "Liberty, MO (0) Salt Lake City, UT"
    const bySubj = loadsInSubject(subject);
    if (bySubj.length === 1) return bySubj[0];
    if (bySubj.length > 1) { const dt = findDate(text); const same = dt ? bySubj.filter(L => String(L.pickup_date || '').slice(0, 10) === dt) : []; if (same.length === 1) return same[0]; }
    // "#A1", "load 48213", "order SO-10988" — only refs of real loads, and only if they look like a ref
    const refs = db.prepare(`SELECT id, ref FROM loads WHERE ref IS NOT NULL AND ref != '' AND status != 'draft' ORDER BY id DESC LIMIT 500`).all();
    for (const r of refs) {
      const ref = String(r.ref).trim(); if (ref.length < 2) continue;
      const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?:#|\\bload\\s*#?\\s*|\\border\\s*#?\\s*|\\bref\\s*#?\\s*)${esc}\\b`, 'i').test(all)) return db.prepare('SELECT * FROM loads WHERE id = ?').get(r.id);
    }
    return null;
  }
  // open loads whose pickup city/state and delivery city/state both appear, in that order, in the subject
  function loadsInSubject(subject) {
    const n = x => ' ' + String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    const subj = n(String(subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, ''));
    if (subj.trim().length < 6) return [];
    const at = (city, st, from) => {
      if (!city) return -1;
      const c = n(city).trimEnd(); let i = subj.indexOf(c, from);
      while (i !== -1) { const rest = subj.slice(i + c.length, i + c.length + 8); if (!st || new RegExp(`^ ${String(st).toLowerCase()} `).test(rest) || !/^ [a-z]{2} /.test(rest)) return i + c.length; i = subj.indexOf(c, i + 1); }
      return -1;
    };
    return openLoads().filter(L => { const a = at(L.origin_city, L.origin_state, 0); return a !== -1 && at(L.dest_city, L.dest_state, a) !== -1; })
      .sort((a, b) => String(a.pickup_date || '9').localeCompare(String(b.pickup_date || '9')));
  }
  function matchLoads(lane, date, equipment) {
    const eqOk = L => !equipment || ((/reefer|refrig|temp/i.test(L.equipment || '') || !!L.temp) ? 'reefer' : /flat|step|deck|conestoga/i.test(L.equipment || '') ? 'flatbed' : 'van') === equipment;
    const dateOk = L => !date || !L.pickup_date || (Math.abs((Date.parse(L.pickup_date) - Date.parse(date)) / 864e5) <= 2);
    const loads = openLoads().filter(eqOk);
    const o = lane && lane.o, d = lane && lane.d;
    const same = (p, st, city) => p && p.state === st && (!p.city || !city || p.city.toLowerCase() === String(city).toLowerCase() || true);
    let exact = loads.filter(L => (!o || same(o, L.origin_state, L.origin_city)) && (!d || same(d, L.dest_state, L.dest_city)) && dateOk(L));
    // rank: city matches first, then soonest pickup
    const rank = L => ((o && o.city && L.origin_city && o.city.toLowerCase() === L.origin_city.toLowerCase()) ? -2 : 0) + ((d && d.city && L.dest_city && d.city.toLowerCase() === L.dest_city.toLowerCase()) ? -1 : 0);
    exact.sort((a, b) => rank(a) - rank(b) || String(a.pickup_date || '9').localeCompare(String(b.pickup_date || '9')));
    let near = [];
    if (o && d) near = loads.filter(L => !exact.includes(L) && (L.origin_state === o.state) && dateOk(L)).slice(0, 4);
    return { exact: exact.slice(0, 8), near };
  }

  const laneText = lane => {
    if (!lane) return '';
    const p = x => x ? (x.city ? `${x.city}, ${x.state}` : x.state) : '';
    if (lane.o && lane.d) return `from ${p(lane.o)} to ${p(lane.d)}`;
    if (lane.o) return `out of ${p(lane.o)}`;
    if (lane.d) return `into ${p(lane.d)}`;
    return '';
  };
  const reSub = s => /^\s*re\s*:/i.test(String(s || '')) ? String(s) : 'RE: ' + String(s || '');
  const fill = (s, vars) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] != null ? vars[k] : '');
  const para = s => s ? `<p style="margin:0 0 12px">${hx(s).replace(/\n/g, '<br>')}</p>` : '';

  // one load, fully described in the email so the carrier doesn't have to click
  // private per-carrier link token (no login): who they are travels with the button
  function linkToken(email, extra = {}) {
    email = String(email || '').toLowerCase().trim(); if (!email) return '';
    const cur = db.prepare('SELECT * FROM carrier_links WHERE email = ?').get(email);
    if (cur) {
      if (extra.mc && !cur.mc) db.prepare('UPDATE carrier_links SET mc = ? WHERE token = ?').run(extra.mc, cur.token);
      if (extra.name && !cur.name) db.prepare('UPDATE carrier_links SET name = ? WHERE token = ?').run(extra.name, cur.token);
      return cur.token;
    }
    const t = crypto.randomBytes(12).toString('base64url');
    db.prepare('INSERT INTO carrier_links (token, email, name, company, mc, phone) VALUES (?, ?, ?, ?, ?, ?)').run(t, email, extra.name || '', extra.company || '', extra.mc || '', extra.phone || '');
    return t;
  }
  const U = v => String(v == null ? '' : v).toUpperCase();
  function btn(href, label, bg, fg) {
    return `<td style="padding:0 8px 8px 0"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="${bg}" style="background:${bg};border:2px solid ${bg === '#ffffff' ? '#1D4F9E' : bg};border-radius:7px">
      <a href="${hx(href)}" style="display:inline-block;padding:10px 16px;font:700 15px Arial,sans-serif;color:${fg};text-decoration:none;white-space:nowrap">${label}</a></td></tr></table></td>`;
  }
  // one load, one line per item (like a rate-con sheet), with the carrier's own buttons
  function loadBlock(L, opt = {}) {
    const url = siteBase() ? `${siteBase()}/load/${L.public_id}` : '';
    const d = v => { if (!v) return ''; const t = new Date(String(v).slice(0, 10) + 'T12:00:00Z'); return isNaN(t) ? v : t.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'UTC' }).replace(',', ''); };
    const when = (date, win) => [d(date), win].filter(Boolean).join(' ') || 'TBD';
    const drops = 1 + (Number(L.stops) || 0);
    const cell = 'padding:6px 10px;border:1px solid #C9D1DD;font:14px Arial,sans-serif;color:#141B27;vertical-align:top';
    // two columns only: label | value (no third notes column)
    const row = (k, v, note = '', strong = false) => v ? `<tr><td style="${cell};width:34%;font-weight:700;background:#F3F6FA">${k}</td><td style="${cell};${strong ? 'font-weight:700;color:#17724A' : ''}">${hx(U(v))}${note ? `<span style="color:#586478;font-weight:400"> · ${hx(U(note))}</span>` : ''}</td></tr>` : '';
    const loc = (c, st, z) => [[c, st].filter(Boolean).join(', '), z].filter(Boolean).join(' ');
    const rows = [
      row('PICKUP LOCATION', loc(L.origin_city, L.origin_state, L.origin_zip)),
      row('DELIVERY LOCATION', loc(L.dest_city, L.dest_state, L.dest_zip)),
      row('PICKS / DROPS', `1 PICK / ${drops} DROP${drops === 1 ? '' : 'S'}`, L.miles ? Math.round(L.miles).toLocaleString() + ' MI' : ''),
      L.post_rate ? row('RATE', usd(L.post_rate), '', true) : '',
      row('EQUIPMENT', [L.equipment, L.temp].filter(Boolean).join(' · ') || 'TBD', L.requirements || ''),
      row('PICKUP TIME', when(L.pickup_date, L.pickup_window)),
      row('DELIVERY TIME', when(L.delivery_date, L.delivery_window)),
      L.weight ? row('WEIGHT', Number(L.weight).toLocaleString() + ' LBS') : '',
      row('COMMODITY', L.commodity || ''),
      row('NOTES', L.notes || ''),
    ].join('');
    const tok = opt.token || '';
    const base = siteBase();
    let buttons = '';
    if (base) {
      const cells = [];
      if (tok && L.post_rate) cells.push(btn(`${base}/o/${tok}/${L.public_id}?a=cover`, `&#10003; Can cover at ${usd(L.post_rate)}`, '#17724A', '#ffffff'));
      cells.push(btn(`${base}/o/${tok || '_'}/${L.public_id}?a=offer`, 'Make an offer', '#1D4F9E', '#ffffff'));
      const subj = `Offer: ${laneOf(L)} (${L.public_id})`;
      const body = `Offer on ${laneOf(L)} (${L.public_id})\nAll-in rate: $\nMC#: \n`;
      cells.push(btn(`mailto:${mailer.from()}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`, 'Reply by email', '#ffffff', '#1D4F9E'));
      buttons = `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 4px"><tr>${cells.join('')}</tr></table>`;
    }
    return `${opt.n ? `<div style="font:700 15px Arial,sans-serif;margin:0 0 6px;text-transform:uppercase">Load ${opt.n} · ${hx(laneOf(L))}</div>` : ''}
      <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin:0 0 12px">${rows}</table>
      ${buttons}
      <p style="margin:0 0 16px;font:13px/1.5 Arial,sans-serif;color:#586478">${hx(tpl('tpl_buttons_note'))}${url ? ` <a href="${hx(url)}" style="color:#586478">Map &amp; details</a>` : ''}</p>`;
  }
  // several loads: number them Load 1, Load 2 … so carriers can say which
  const blocks = (list, token) => list.map((L, i) => loadBlock(L, { token, n: list.length > 1 ? i + 1 : 0 }));
  function compose(heading, parts, vars) {
    const body = [para(fill(tpl('tpl_greeting'), vars)), ...parts, para(fill(tpl('tpl_value'), vars)), para(fill(tpl('tpl_signoff'), vars))].join('');
    return emailLayout(heading, body, null);
  }

  // ---------- understand one email and plan the response ----------
  function analyze(msg) {
    const from = ((msg.from || {}).emailAddress || {});
    const email = String(from.address || '').toLowerCase();
    const name = String(from.name || '').trim();
    const subject = String(msg.subject || '');
    const body = String((msg.body || {}).content || msg.bodyPreview || '');
    const text = newText(body);
    const headers = Object.fromEntries((msg.internetMessageHeaders || []).map(h => [String(h.name).toLowerCase(), String(h.value)]));
    const self = String(mailer.from() || '').toLowerCase();
    const cfg = publicConfig();
    const first = (name.split(/[\s,]+/)[0] || '').replace(/[^A-Za-z'-]/g, '') || 'there';
    const vars = { first_name: first, name, company: cfg.company };
    const res = { email, name, subject, body: body.slice(0, 20000), text, kind: 'unknown', status: 'needs_you', summary: '', actions: [], reply: null, load_ids: [], mc: '', amount: null, lane: null };

    // loop / junk guards: never answer ourselves, robots, bounces, out-of-office, newsletters
    const robot = !email || email === self || /(^|[._-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?|alerts?)([._-]|@)/i.test(email)
      || (headers['auto-submitted'] && !/^no$/i.test(headers['auto-submitted'])) || /bulk|junk|list/i.test(headers.precedence || '')
      || !!headers['list-unsubscribe'] || !!headers['x-autoreply'] || !!headers['x-autorespond']
      || /^\s*(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|undeliverable|delivery (status|has failed)|mail delivery|read:|returned mail|accepted:|declined:|tentative:)/i.test(subject);
    if (robot) { res.kind = 'ignored'; res.status = 'ignored'; res.summary = 'Automatic email, out-of-office, bounce or newsletter — ignored.'; return res; }
    // Aljex rate-confirmation traffic (signatures, rate con replies) — you handle those in Aljex/Outlook
    if (/signatures? complete|aljex|rate ?con(firmation)?s?\b|carrier confirmation|tender (accepted|declined)/i.test(subject) || /\baljex\b/i.test(text.slice(0, 600))) {
      res.kind = 'ignored'; res.status = 'ignored'; res.summary = 'Aljex / rate-confirmation email — skipped.'; return res;
    }

    // 1) take me off the list
    const firstLine = (text.split('\n').find(l => l.trim()) || '').trim();
    if (/^(please\s+)?(remove|unsubscribe|stop|take (me|us) off|opt[- ]?out)\b/i.test(firstLine) || /^\s*(remove|unsubscribe)\s*(me)?\s*$/i.test(subject.replace(/^\s*(re|fw)\s*:\s*/i, ''))) {
      res.kind = 'remove'; res.summary = 'Asked to be removed from the load list.';
      res.actions.push({ type: 'optout', email });
      res.reply = { subject: reSub(subject), html: compose("You're off the list", [para(fill(tpl('tpl_remove'), vars))], vars) };
      res.status = 'auto_ok'; return res;
    }

    // who is this carrier? MC from the email, or from their earlier bids / Highway list
    let mc = findMC(text) || findMC(subject);
    const prior = db.prepare(`SELECT * FROM bids WHERE lower(email) = ? ORDER BY updated_at DESC LIMIT 1`).get(email);
    const hw = db.prepare(`SELECT * FROM qualified_carriers WHERE lower(email) LIKE ? LIMIT 1`).get('%' + email + '%');
    if (!mc && prior) mc = prior.mc;
    if (!mc && hw) mc = hw.mc;
    if (!mc) { const r = db.prepare(`SELECT mc FROM inbox WHERE from_email = ? AND mc IS NOT NULL AND mc != '' ORDER BY id DESC LIMIT 1`).get(email); if (r) mc = r.mc; }
    if (!mc) { const r = db.prepare(`SELECT mc FROM lane_alerts WHERE email = ? AND mc IS NOT NULL AND mc != '' ORDER BY id DESC LIMIT 1`).get(email); if (r) mc = r.mc; }
    res.mc = mc || '';
    const who = { mc, company: (prior && prior.mc === mc && prior.company) || (hw && hw.mc === mc && hw.name) || (mc && (db.prepare('SELECT name FROM qualified_carriers WHERE mc = ?').get(mc) || {}).name) || name || email,
      contact_name: name || (prior && prior.contact_name) || email, email, phone: (prior && prior.phone) || '' };

    const token = linkToken(email, { name, mc });

    // is this a follow-up in a conversation we already answered? → it's yours (first touch only)
    const plainSubj = subject.replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim().toLowerCase();
    const followup = (msg.conversationId && db.prepare(`SELECT 1 FROM inbox WHERE conv_id = ? AND msg_id != ? LIMIT 1`).get(msg.conversationId, msg.id || ''))
      || (/^\s*re\s*:/i.test(subject) && db.prepare(`SELECT reply_subject FROM inbox WHERE from_email = ? AND sent_at IS NOT NULL AND sent_at > datetime('now', '-30 day')`).all(email)
        .some(r => String(r.reply_subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim().toLowerCase() === plainSubj));

    // 2) about a specific load? (L-id / load # in subject or body, or the conversation of a reply that listed one load)
    let L = findLoadRef(subject, text);
    if (!L && msg.conversationId) {
      const prev = db.prepare(`SELECT load_ids FROM inbox WHERE conv_id = ? AND load_ids IS NOT NULL ORDER BY id DESC LIMIT 1`).get(msg.conversationId);
      const ids = prev ? JSON.parse(prev.load_ids || '[]') : [];
      if (ids.length === 1) L = db.prepare('SELECT * FROM loads WHERE id = ?').get(ids[0]);
    }
    if (!L && followup) {
      // replied to an email that listed several loads: "load 2" / "the second one"
      const prev = db.prepare(`SELECT load_ids FROM inbox WHERE ((conv_id = ? AND ? IS NOT NULL) OR from_email = ?) AND load_ids IS NOT NULL ORDER BY id DESC LIMIT 1`).get(msg.conversationId || '', msg.conversationId || null, email);
      const ids = prev ? JSON.parse(prev.load_ids || '[]') : [];
      const n = (text.match(/\bload\s*#?\s*(\d)\b/i) || [])[1];
      if (n && ids[Number(n) - 1]) L = db.prepare('SELECT * FROM loads WHERE id = ?').get(ids[Number(n) - 1]);
      else if (ids.length === 1) L = db.prepare('SELECT * FROM loads WHERE id = ?').get(ids[0]);
      else if (ids.length > 1) {
        // "the Liberty one" / "Ogden load": a city that only one of the listed loads has
        const cand = ids.map(id => db.prepare('SELECT * FROM loads WHERE id = ?').get(id)).filter(Boolean);
        const hit = cand.filter(x => [x.origin_city, x.dest_city].some(c => c && new RegExp(`\\b${String(c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)));
        if (hit.length === 1) L = hit[0];
      }
    }
    // no load number, but the lane they wrote matches exactly one open load → that's the one
    if (!L && !followup) {
      const ln = findLane(subject, text);
      if (ln && ln.o && ln.d && ln.o.city && ln.d.city) { // both cities named, not just states
        const hits = openLoads().filter(x => x.origin_state === ln.o.state && x.dest_state === ln.d.state && cityOk(ln.o.city, x.origin_city) && cityOk(ln.d.city, x.dest_city));
        if (hits.length === 1) L = hits[0];
      }
    }
    const rate = findRate(text, mc);
    const wantsIt = /\b(i'?ll take it|we'?ll take it|we can take it|we can (do|cover) it|can cover|i accept|we accept|accept(ed)? the (rate|price)|book (it|this|that)|we'?ll book)\b/i.test(text);
    const laneTag = L ? `${laneOf(L)}${L.ref ? ' (#' + L.ref + ')' : ''}` : '';

    // a rate (+MC) for a known load: never auto-reply — record it for you to add with one click
    if (L && (rate || (wantsIt && L.post_rate))) {
      const amt = rate || L.post_rate;
      res.load_ids = [L.id]; res.kind = 'bid'; res.amount = amt; res.status = 'needs_you';
      if (!mc) { res.summary = `${usd(amt)} on ${laneTag} — no MC# found. Answer them in Outlook.`; return res; }
      res.summary = `${rate ? 'Offer' : 'Can cover at your rate'} ${usd(amt)} on ${laneTag} — MC ${mc}. Tap "Add as bid", then answer them in Outlook.`;
      res.actions.push({ type: 'bid', load_id: L.id, amount: amt, source: rate ? 'offer' : 'cover', ...who });
      return res;
    }
    // any other reply in a thread we already answered → you
    if (followup) {
      res.kind = 'followup'; res.status = 'needs_you'; if (L) res.load_ids = [L.id];
      res.summary = `Replied to our email${L ? ' about ' + laneTag : ''}${rate ? ` — offered ${usd(rate)} but didn't say which load` : wantsIt ? ' — wants the load but gave no rate' : ''}. Answer in Outlook.`;
      return res;
    }
    if (L) {
      res.load_ids = [L.id];
      const vl = { ...vars, lane: laneOf(L), load: L.ref || L.public_id, rate: '' };
      if (!biddingOpen(L)) {
        res.kind = 'load_question'; res.summary = `About ${laneTag}, which is no longer open.`;
        const other = matchLoads({ o: { state: L.origin_state } }, '', '').exact.filter(x => x.id !== L.id).slice(0, 4);
        const parts = [para(fill(tpl('tpl_closed'), vl))];
        if (other.length) parts.push(para(fill(tpl('tpl_more'), vl)), ...blocks(other, token), para(fill(tpl('tpl_howto'), vl)));
        res.reply = { subject: reSub(subject), html: compose('Load no longer available', parts, vars) };
        res.load_ids = other.map(x => x.id);
        res.status = 'auto_ok'; return res;
      }
      if (wantsIt) { res.kind = 'load_question'; res.status = 'needs_you'; res.summary = `Wants ${laneTag}${mc ? ' — MC ' + mc : ''} but gave no rate — call or reply to them.`; return res; }
      res.kind = 'load_question'; res.summary = `Asked about ${laneTag}.`;
      res.reply = { subject: reSub(subject), html: compose(laneOf(L), [para(fill(tpl('tpl_load'), vl)), ...blocks([L], token), para(fill(tpl('tpl_howto'), vl))], vars) };
      // a real question needs a person; a plain "is this available / details?" gets the details
      if (/\?/.test(text) && !/\b(available|still open|details|info|information|rate|pay|paying|what.{0,20}(pay|rate|weight|commodity))\b/i.test(text)) res.status = 'needs_you';
      else res.status = 'auto_ok';
      return res;
    }

    // 3) a lane or an empty truck
    const lane = findLane(subject, text);
    if (lane) {
      const truck = /\b(empty|truck|trucks|available|avail|capacity|unloading|delivering|open deck|my driver|our driver|driver will be)\b/i.test(text + ' ' + subject) && lane.o;
      const date = findDate(text + ' ' + subject);
      const equipment = findEquipment(text + ' ' + subject);
      res.lane = { ...lane, date, equipment };
      const lt = laneText(lane);
      const { exact, near } = matchLoads(lane, truck ? date : '', equipment);
      res.kind = truck ? 'truck' : 'lane';
      res.summary = `${truck ? 'Truck available' : 'Looking for loads'} ${lt}${date ? ' around ' + date : ''}${equipment ? ' (' + equipment + ')' : ''} — ${exact.length} match${exact.length === 1 ? '' : 'es'}${near.length ? ', ' + near.length + ' nearby' : ''}.`;
      const vl = { ...vars, lane_text: lt };
      const listed = exact.concat(near);
      const parts = [];
      if (exact.length) parts.push(para(fill(tpl('tpl_loads'), vl)));
      else parts.push(para(fill(tpl('tpl_none'), vl)));
      const bl = blocks(listed, token);
      parts.push(...bl.slice(0, exact.length));
      if (near.length) parts.push(para(fill(tpl('tpl_more'), vl)), ...bl.slice(exact.length));
      if (listed.length) parts.push(para(fill(tpl('tpl_howto'), vl)));
      res.load_ids = listed.map(x => x.id);
      const title = lane.o && lane.d ? `${lane.o.city ? lane.o.city + ', ' : ''}${lane.o.state} → ${lane.d.city ? lane.d.city + ', ' : ''}${lane.d.state}` : `Loads ${lt}`;
      res.reply = { subject: reSub(subject), html: compose(listed.length ? title : `Nothing ${lt} yet`, parts, vars) };
      res.actions.push({ type: 'alert', email, name, mc, o_state: lane.o && lane.o.state, o_city: lane.o && lane.o.city, d_state: lane.d && lane.d.state, d_city: lane.d && lane.d.city,
        equipment, avail_date: truck ? date : '', kind: truck ? 'truck' : 'lane', already: listed.map(x => x.id) });
      res.status = 'auto_ok';
      // already answered this carrier about this lane in the last day → don't send the same list twice
      const recent = db.prepare(`SELECT lane FROM inbox WHERE from_email = ? AND status = 'sent' AND kind IN ('lane','truck') AND sent_at > datetime('now', '-1 day')`).all(email)
        .map(r => JSON.parse(r.lane || 'null')).filter(Boolean);
      const key = x => `${x.o ? x.o.state : ''}>${x.d ? x.d.state : ''}`;
      if (recent.some(x => key(x) === key(lane))) { res.status = 'needs_you'; res.summary += ' Already sent them this lane in the last day — answer in Outlook if needed.'; }
      return res;
    }

    // 4) a rate with no load we can identify, or anything else → you
    if (rate) res.summary = `Mentioned ${usd(rate)} but no load or lane found — answer in Outlook.`;
    else res.summary = 'Couldn\'t tell what they need — left for you.';
    return res;
  }

  // ---------- run a plan ----------
  function runActions(row, plan) {
    const results = [];
    for (const a of plan.actions || []) {
      if (a.type === 'optout') { db.prepare('INSERT OR IGNORE INTO email_optout (email) VALUES (?)').run(a.email); db.prepare('UPDATE lane_alerts SET active = 0 WHERE email = ?').run(a.email); results.push('Removed from the daily list and lane alerts'); }
      if (a.type === 'alert') {
        const id = saveAlert(a);
        if (id) { const ins = db.prepare('INSERT OR IGNORE INTO alert_sends (alert_id, load_id) VALUES (?, ?)'); (a.already || []).forEach(l => ins.run(id, l)); results.push('Saved lane alert'); }
      }
      if (a.type === 'bid') {
        const L = db.prepare('SELECT * FROM loads WHERE id = ?').get(a.load_id);
        const r = placeBid(L, { mc: a.mc, amount: a.amount, company: a.company, contact_name: a.contact_name, email: a.email, phone: a.phone, notes: 'By email' },
          { source: a.source === 'cover' ? 'cover' : 'email', skipConfirm: true, bypassRules: a.source === 'cover' });
        a.result = r;
        results.push(r.ok ? `Bid ${usd(r.amount)} added` : `Bid not added: ${r.error}`);
        if (plan.reply && plan.reply.template === 'bid') {
          const vl = plan.reply.vars;
          const st = L ? bidStats.get(L.id) : null;
          const standing = r.ok ? "We'll confirm with you directly before anything is booked." : '';
          plan.reply.html = r.ok
            ? compose(`Bid received: ${usd(r.amount)}`, [para(fill(tpl('tpl_bid'), { ...vl, rate: usd(r.amount), standing })), loadBlock(L)], vl)
            : compose('About your bid', [para(fill(tpl('tpl_bid_problem'), { ...vl, problem: r.error })), loadBlock(L)], vl);
        }
      }
    }
    return results;
  }
  async function execute(row) {
    const plan = JSON.parse(row.plan || '{}');
    const results = runActions(row, plan);
    let sent = false, error = '';
    if (plan.reply && plan.reply.html && row.from_email) {
      try {
        // no more than 4 automatic replies per sender per day
        const n = db.prepare(`SELECT COUNT(*) n FROM inbox WHERE from_email = ? AND sent_at > datetime('now', '-1 day')`).get(row.from_email).n;
        if (n >= 4) throw new Error('Reply limit reached for this sender today (4) — answer them yourself.');
        // answer inside their thread; if the original is gone, send a new email with RE: subject
        const threaded = /^(notify-|look-)/.test(row.msg_id || '') ? false : await mailer.reply(row.msg_id, plan.reply.html);
        if (!threaded) await mailer.send({ to: row.from_email, subject: plan.reply.subject || ('RE: ' + (row.subject || '')), html: plan.reply.html });
        mailer.markRead(row.msg_id).catch(() => {});
        sent = true;
      } catch (e) { error = e.message; }
    }
    db.prepare(`UPDATE inbox SET status = ?, result = ?, error = ?, reply_subject = ?, reply_html = ?, sent_at = CASE WHEN ? THEN datetime('now') ELSE sent_at END, plan = ? WHERE id = ?`)
      .run(error ? 'error' : sent ? 'sent' : 'done', results.join(' · '), error || null, plan.reply ? plan.reply.subject : null, plan.reply ? plan.reply.html : null, sent ? 1 : 0, JSON.stringify(plan), row.id);
    ctx.onChange && ctx.onChange();
    return { sent, error, results };
  }

  // preview a bid reply before it runs (review mode)
  function previewReply(plan) {
    if (!plan.reply) return null;
    if (plan.reply.html) return plan.reply.html;
    if (plan.reply.template === 'bid') {
      const a = (plan.actions || []).find(x => x.type === 'bid'); const L = a && db.prepare('SELECT * FROM loads WHERE id = ?').get(a.load_id);
      return L ? compose(`Bid received: ${usd(a.amount)}`, [para(fill(tpl('tpl_bid'), { ...plan.reply.vars, rate: usd(a.amount), standing: "We'll confirm with you directly before anything is booked." })), loadBlock(L)], plan.reply.vars) : null;
    }
    return null;
  }

  // ---------- poll the mailbox ----------
  let polling = false;
  async function poll() {
    if (polling || mode() === 'off' || !mailer.configured()) return { skipped: true };
    polling = true;
    try {
      let since = getSetting('inbox_since');
      if (!since) { since = now(); setSetting('inbox_since', since); } // first run: only mail from now on
      const msgs = await mailer.listInbox(since, 50);
      let n = 0;
      for (const msg of msgs) {
        if (db.prepare('SELECT 1 FROM inbox WHERE msg_id = ?').get(msg.id)) { since = msg.receivedDateTime; continue; }
        const a = analyze(msg);
        const plan = { actions: a.actions, reply: a.reply };
        const auto = mode() === 'auto' && a.status === 'auto_ok';
        const status = a.status === 'ignored' ? 'ignored' : a.status === 'auto_ok' ? (a.kind === 'remove' || auto ? 'queued' : 'draft') : 'needs_you';
        const r = db.prepare(`INSERT INTO inbox (msg_id, conv_id, from_email, from_name, subject, body, received_at, web_link, kind, status, summary, plan, load_ids, mc, amount, lane)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(msg.id, msg.conversationId || null, a.email, a.name, a.subject, a.body, msg.receivedDateTime, msg.webLink || null,
          a.kind, status, a.summary, JSON.stringify(plan), a.load_ids.length ? JSON.stringify(a.load_ids) : null, a.mc || null, a.amount, a.lane ? JSON.stringify(a.lane) : null);
        if (status === 'queued') await execute(db.prepare('SELECT * FROM inbox WHERE id = ?').get(Number(r.lastInsertRowid)));
        since = msg.receivedDateTime; n++;
      }
      setSetting('inbox_since', since);
      setSetting('inbox_last_check', now()); setSetting('inbox_last_error', '');
      return { checked: msgs.length, new: n };
    } catch (e) {
      setSetting('inbox_last_error', `${now()} ${e.message}`.slice(0, 500)); setSetting('inbox_last_check', now());
      return { error: e.message };
    } finally { polling = false; }
  }

  // ---------- lane alerts ----------
  function saveAlert(a) {
    const email = String(a.email || '').toLowerCase().trim();
    if (!email || (!a.o_state && !a.d_state)) return null;
    if (db.prepare('SELECT 1 FROM email_optout WHERE email = ?').get(email) && a.source !== 'site') return null;
    const dup = db.prepare(`SELECT id FROM lane_alerts WHERE email = ? AND active = 1 AND IFNULL(o_state,'') = ? AND IFNULL(d_state,'') = ? AND IFNULL(equipment,'') = ? AND kind = ?`)
      .get(email, a.o_state || '', a.d_state || '', a.equipment || '', a.kind || 'lane');
    const days = a.kind === 'truck' ? 5 : Math.max(7, Number(getSetting('alert_days', '60')) || 60);
    const exp = new Date(Date.now() + days * 864e5).toISOString();
    if (dup) { db.prepare(`UPDATE lane_alerts SET expires_at = ?, avail_date = COALESCE(?, avail_date), mc = COALESCE(NULLIF(?, ''), mc), name = COALESCE(NULLIF(?, ''), name) WHERE id = ?`).run(exp, a.avail_date || null, a.mc || '', a.name || '', dup.id); return dup.id; }
    if (a.source === 'site') db.prepare('DELETE FROM email_optout WHERE email = ?').run(email);
    return Number(db.prepare(`INSERT INTO lane_alerts (email, name, mc, o_state, d_state, o_city, d_city, equipment, avail_date, kind, source, token, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(email, a.name || '', a.mc || '', a.o_state || null, a.d_state || null, a.o_city || null, a.d_city || null, a.equipment || null, a.avail_date || null, a.kind || 'lane', a.source || 'email',
        crypto.randomBytes(12).toString('base64url'), exp).lastInsertRowid);
  }
  let alerting = false;
  async function sendAlerts() {
    if (alerting || !mailer.configured() || getSetting('alerts_on', '0') !== '1') return;
    alerting = true;
    try {
      const loads = openLoads();
      if (!loads.length) return;
      const alerts = db.prepare(`SELECT * FROM lane_alerts WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?)`).all(now());
      const out = new Set(db.prepare('SELECT email FROM email_optout').all().map(r => r.email));
      const dnu = new Set(db.prepare(`SELECT mc FROM carrier_profiles WHERE flag = 'dnu'`).all().map(r => r.mc));
      const sentQ = db.prepare('SELECT 1 FROM alert_sends WHERE alert_id = ? AND load_id = ?');
      const HW = highwayIndex();
      const byEmail = new Map();
      for (const a of alerts) {
        if (out.has(a.email) || (a.mc && dnu.has(a.mc)) || !HW.check(a.email, a.mc).pass) continue;
        const { exact } = matchLoads({ o: a.o_state ? { state: a.o_state } : null, d: a.d_state ? { state: a.d_state } : null }, a.kind === 'truck' ? a.avail_date : '', a.equipment || '');
        const fresh = exact.filter(L => !sentQ.get(a.id, L.id) && (a.source !== 'email' || Date.parse(L.created_at.replace(' ', 'T') + 'Z') > Date.parse(a.created_at.replace(' ', 'T') + 'Z') - 36e5));
        if (!fresh.length) continue;
        if (!byEmail.has(a.email)) byEmail.set(a.email, { alerts: [], loads: new Map(), name: a.name, token: a.token });
        const g = byEmail.get(a.email); g.alerts.push(a); fresh.forEach(L => g.loads.set(L.id, { L, alert: a }));
      }
      const cfg = publicConfig();
      for (const [email, g] of byEmail) {
        const list = [...g.loads.values()].map(x => x.L).slice(0, 8);
        const first = (String(g.name || '').split(/[\s,]+/)[0] || '').replace(/[^A-Za-z'-]/g, '') || 'there';
        const vars = { first_name: first, company: cfg.company };
        const unsub = siteBase() ? `${siteBase()}/alerts/off/${g.token}` : '';
        const html = compose(list.length === 1 ? `New load: ${laneOf(list[0])}` : `${list.length} new loads on your lanes`,
          [para(fill(tpl('tpl_alert'), vars)), ...blocks(list, linkToken(email, { name: g.name })), para(fill(tpl('tpl_howto'), vars)),
            unsub ? `<p style="font-size:12px;color:#586478">You asked for loads on this lane. <a href="${hx(unsub)}" style="color:#586478">Stop these alerts</a>.</p>` : ''], vars);
        try {
          const alertSubject = list.length === 1 ? `New load: ${laneOf(list[0])}${list[0].post_rate ? ' · ' + usd(list[0].post_rate) : ''}` : `${list.length} new loads on your lanes`;
          await mailer.send({ to: email, subject: alertSubject, html });
          const ins = db.prepare('INSERT OR IGNORE INTO alert_sends (alert_id, load_id) VALUES (?, ?)');
          for (const { L, alert } of g.loads.values()) ins.run(alert.id, L.id);
          for (const a of g.alerts) db.prepare(`UPDATE lane_alerts SET last_sent_at = datetime('now'), sent_count = sent_count + 1 WHERE id = ?`).run(a.id);
          // remember what we sent, so a reply with a rate can find the load
          db.prepare(`INSERT INTO inbox (msg_id, from_email, subject, kind, status, summary, load_ids, reply_subject, reply_html, sent_at, received_at) VALUES (?, ?, ?, 'alert_out', 'sent', ?, ?, ?, ?, datetime('now'), ?)`)
            .run('alert-' + crypto.randomBytes(8).toString('hex'), email, '(lane alert)', `Lane alert sent: ${list.map(laneOf).join('; ')}`, JSON.stringify(list.map(L => L.id)), alertSubject, html, now());
        } catch (e) { console.warn('[alerts] send failed:', e.message); setSetting('email_last_error', `${now()} lane alert: ${e.message}`.slice(0, 400)); }
      }
    } finally { alerting = false; }
  }

  // a newly posted load on a lane with starred favorites waits off the board until you pick: first look, or everyone
  const HELD = '9999-12-31T00:00:00.000Z';
  function holdForFirstLook(id, auto) {
    const L = db.prepare('SELECT * FROM loads WHERE id = ?').get(id);
    if (!L || L.status !== 'open' || L.first_look_until) return false;
    const favs = recipientsFor(L).filter(r => r.favorite && r.highway_pass);
    if (!favs.length) return false;
    db.prepare('UPDATE loads SET first_look_until = ?, first_look_released = 0, first_look_reminded = 0 WHERE id = ?').run(HELD, id);
    db.prepare(`INSERT INTO load_notes (load_id, kind, text) VALUES (?, 'note', ?)`).run(id, `Held for first look (${favs.length} favorite${favs.length === 1 ? '' : 's'}) — not on the board yet`);
    if (auto && mailer.configured()) {
      mailer.sendQuiet({ to: notifyTo(), subject: `Held for first look · ${laneOf(L)}`, html: emailLayout(`Held for first look: ${hx(laneOf(L))}`,
        `This load posted from a saved lane with favorites (${favs.map(f => hx(f.company || f.email)).join(', ')}). It's off the board until you send the first look or send it to everyone.`,
        siteBase() ? { url: `${siteBase()}/admin`, label: 'Open admin' } : null) }, 'first-look hold');
    }
    return true;
  }

  // when a first look runs out: remind you (nothing goes to the full list until you click)
  async function firstLookReminders() {
    const due = db.prepare(`SELECT * FROM loads WHERE status = 'open' AND first_look_until IS NOT NULL AND first_look_released = 0 AND first_look_reminded = 0 AND first_look_until < ?`).all(now());
    for (const L of due) {
      db.prepare('UPDATE loads SET first_look_reminded = 1 WHERE id = ?').run(L.id);
      if (!mailer.configured()) continue;
      const st = bidStats.get(L.id);
      const favBids = db.prepare(`SELECT b.company, b.amount FROM bids b WHERE b.load_id = ? ORDER BY b.amount`).all(L.id);
      const html = emailLayout(`First look ended: ${hx(laneOf(L))}`,
        `Your favorites have had their head start on <b>${hx(laneOf(L))}</b>${L.ref ? ' (#' + hx(L.ref) + ')' : ''}.
         <p>${favBids.length ? `${favBids.length} bid${favBids.length === 1 ? '' : 's'} so far: ${favBids.slice(0, 5).map(b => `${hx(b.company)} ${usd(b.amount)}`).join(' · ')}` : 'No bids from them yet.'}</p>
         <p>It's still off the board. Open admin to award it, or send it to everyone.</p>`,
        siteBase() ? { url: `${siteBase()}/admin`, label: 'Open admin' } : null);
      mailer.sendQuiet({ to: notifyTo(), subject: `First look ended · ${laneOf(L)}${st.bid_count ? ' · ' + st.bid_count + ' bid' + (st.bid_count === 1 ? '' : 's') : ''}`, html }, 'first-look reminder');
    }
  }

  function start() {
    setInterval(() => firstLookReminders().catch(e => console.warn('[first look]', e.message)), 60000).unref();
    setTimeout(() => poll().catch(() => {}), 15000);
    setInterval(() => poll().catch(() => {}), 2 * 60000).unref();
    setInterval(() => sendAlerts().catch(e => console.warn('[alerts]', e.message)), 2 * 60000).unref();
  }

  // live Highway check: by MC, or by an email address that appears in the Highway sheet (Dispatch Email)
  function highwayIndex() {
    const byMc = new Map(), byEmail = new Map();
    for (const r of db.prepare('SELECT mc, name, email, phone FROM qualified_carriers').all()) {
      byMc.set(r.mc, r);
      (String(r.email || '').match(/[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}/gi) || []).forEach(e => byEmail.set(e.toLowerCase(), r));
    }
    return { check: (email, mc) => { const r = (mc && byMc.get(String(mc))) || byEmail.get(String(email || '').toLowerCase()); return r ? { pass: true, mc: r.mc, name: r.name, phone: r.phone } : { pass: false }; } };
  }
  // everyone on your lane lists / lane alerts / added carriers, with today's Highway status
  function trackedCarriers() {
    const out = new Map();
    const put = (email, mc) => { email = String(email || '').toLowerCase(); if (email && !out.has(email)) out.set(email, mc || ''); };
    db.prepare('SELECT email, mc FROM lane_carriers').all().forEach(r => put(r.email, r.mc));
    db.prepare('SELECT email, mc FROM carriers_manual').all().forEach(r => put(r.email, r.mc));
    db.prepare(`SELECT email, mc FROM lane_alerts WHERE active = 1`).all().forEach(r => put(r.email, r.mc));
    return out;
  }
  // after each Highway refresh: who became good to go, who dropped off.
  // The snapshot holds who was passing / waiting last time; carriers added since are just recorded.
  function highwayState() {
    const hw = highwayIndex(), pass = [], waiting = [];
    for (const [email, mc] of trackedCarriers()) (hw.check(email, mc).pass ? pass : waiting).push(email);
    return { pass, waiting };
  }
  function highwaySnapshotMerge() {
    let prev = null; try { prev = JSON.parse(getSetting('hw_snapshot') || 'null'); } catch (_) { prev = null; }
    if (!prev) return highwaySnapshot();
    const known = new Set([...(prev.pass || []), ...(prev.waiting || [])]);
    const cur = highwayState();
    cur.pass.forEach(e => { if (!known.has(e)) prev.pass.push(e); }); cur.waiting.forEach(e => { if (!known.has(e)) prev.waiting.push(e); });
    setSetting('hw_snapshot', JSON.stringify(prev));
  }
  function highwaySnapshot() { setSetting('hw_snapshot', JSON.stringify(highwayState())); }
  function highwayChanged() {
    let prev = null; try { prev = JSON.parse(getSetting('hw_snapshot') || 'null'); } catch (_) { prev = null; }
    const cur = highwayState();
    setSetting('hw_snapshot', JSON.stringify(cur));
    if (!prev) return;
    const wasWaiting = new Set(prev.waiting || []), wasPass = new Set(prev.pass || []);
    const joined = cur.pass.filter(e => wasWaiting.has(e)), dropped = cur.waiting.filter(e => wasPass.has(e));
    if (joined.length || dropped.length) setSetting('hw_changes', JSON.stringify({ at: new Date().toISOString(), joined, dropped }));
  }
  // everyone who should hear about a load: the saved lane's carrier list, carriers who bid this lane before
  // (Highway pass only), and lane alerts (emailed about it / signed up). Skips opt-outs and Do not use.
  function recipientsFor(L) {
    const out = new Map();
    const optout = new Set(db.prepare('SELECT email FROM email_optout').all().map(r => r.email));
    const dnu = new Set(db.prepare(`SELECT mc FROM carrier_profiles WHERE flag = 'dnu'`).all().map(r => r.mc));
    const hw = new Map(db.prepare('SELECT mc, name FROM qualified_carriers').all().map(r => [r.mc, r.name]));
    const H = highwayIndex();
    const add = (r, why) => {
      const email = String(r.email || '').toLowerCase().trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
      if (optout.has(email) || (r.mc && dnu.has(r.mc))) return;
      const cur = out.get(email);
      if (cur) { if (!cur.why.includes(why)) cur.why.push(why); for (const k of ['name', 'company', 'mc', 'phone']) if (!cur[k] && r[k]) cur[k] = r[k]; return; }
      out.set(email, { email, name: r.name || '', company: r.company || (r.mc && hw.get(r.mc)) || '', mc: r.mc || '', phone: r.phone || '', why: [why] });
    };
    const saved = db.prepare('SELECT * FROM lanes').all().filter(s => { if (s.id === L.lane_id) return true; const d = JSON.parse(s.data || '{}'); return d.origin_state && d.dest_state && d.origin_state === L.origin_state && d.dest_state === L.dest_state; });
    const favs = new Set();
    for (const sl of saved) db.prepare('SELECT * FROM lane_carriers WHERE lane_id = ?').all(sl.id).forEach(r => { add(r, `on lane list "${sl.name}"`); if (r.favorite) favs.add(String(r.email).toLowerCase()); });
    db.prepare(`SELECT b.mc, b.company, b.contact_name AS name, b.email, b.phone FROM bids b JOIN loads l ON l.id = b.load_id
      WHERE l.origin_state = ? AND l.dest_state = ? AND l.id != ? AND b.email != '' GROUP BY lower(b.email)`).all(L.origin_state, L.dest_state, L.id)
      .forEach(r => add(r, 'bid this lane before'));
    db.prepare(`SELECT * FROM lane_alerts WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?)`).all(now())
      .filter(a => (!a.o_state || a.o_state === L.origin_state) && (!a.d_state || a.d_state === L.dest_state) && (a.o_state || a.d_state))
      .forEach(a => add({ email: a.email, name: a.name, mc: a.mc }, a.source === 'site' ? 'signed up on the board' : a.source === 'admin' ? 'lane alert you added' : 'emailed about this lane'));
    const sent = new Set(db.prepare('SELECT email FROM load_notifies WHERE load_id = ?').all(L.id).map(r => r.email));
    const bidders = new Set(db.prepare(`SELECT lower(email) e FROM bids WHERE load_id = ? AND email != ''`).all(L.id).map(r => r.e));
    return [...out.values()].map(r => { const h = H.check(r.email, r.mc); return { ...r, mc: r.mc || h.mc || '', company: h.name || r.company || '', favorite: favs.has(r.email), already_sent: sent.has(r.email), already_bid: bidders.has(r.email), highway_pass: h.pass }; })
      .sort((a, b) => (b.highway_pass - a.highway_pass) || (b.favorite - a.favorite) || (a.already_sent - b.already_sent) || String(a.company || a.email).localeCompare(String(b.company || b.email)));
  }


  // ---------- signatures: phone numbers, company, title, website, address ----------
  function fmtPhone(v) {
    const d = String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    return /^[2-9]\d{9}$/.test(d) ? `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : '';
  }
  const FREE_MAIL = /@(gmail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|comcast|att|sbcglobal|protonmail|proton|gmx|mail|yandex|zoho)\./i;
  function siteFromEmail(email) { const d = String(email).split('@')[1] || ''; return d && !FREE_MAIL.test(email) ? 'https://' + d.toLowerCase() : ''; }
  function signatureInfo(body, email) {
    const text = newText(body);
    const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const out = { phones: [] };
    const re = /(?:\+?1[\s.-]?)?(\(?[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4})(?:\s*(?:x|ext\.?|extension)\s*(\d{1,6}))?/gi;
    for (const ln of lines) {
      let m;
      while ((m = re.exec(ln))) {
        const raw = m[1], before = ln.slice(Math.max(0, m.index - 22), m.index).toLowerCase();
        const labeled = /\b(p|ph|phone|tel|t|c|cell|m|mobile|mob|o|office|d|direct|dispatch|call|text|main|number)\b\s*[:.#-]*\s*$/.test(before) || /phone|cell|mobile|direct|office/.test(before);
        const shaped = /[()\s.-]/.test(raw);
        if (!labeled && !shaped) continue;               // a bare 10-digit number (load #, DOT) — skip
        if (/\bfax\b|\bf\s*[:.]\s*$/.test(before)) continue;
        if (/\b(mc|dot|usdot|load|order|po|pro|ref|invoice)\b[\s#:.-]*$/.test(before)) continue;
        const num = fmtPhone(raw); if (!num) continue;
        const kind = /\b(c|cell|m|mobile|mob|text)\b/.test(before) ? 'cell' : /\b(d|direct)\b/.test(before) ? 'direct' : /office|main|o\b/.test(before) ? 'office' : '';
        if (!out.phones.find(x => x.num === num)) out.phones.push({ num: m[2] ? `${num} x${m[2]}` : num, kind });
      }
    }
    // only look for company / title / address in the last lines (the signature), not in what they wrote about loads
    const tail = lines.slice(-14);
    for (const ln of tail) {
      if (ln.length > 70 || /@/.test(ln)) continue;
      if (!out.company && /\b(LLC|L\.L\.C|INC|CORP|CORPORATION|CO\.|LTD|TRANSPORT(ATION)?|TRUCKING|LOGISTICS|FREIGHT|CARRIERS?|EXPRESS|LINES|HAULING|ENTERPRISES?)\b/i.test(ln) && !/\b(MC|DOT)\s*#?\s*\d/i.test(ln) && !/https?:|www\./i.test(ln))
        out.company = ln.replace(/^[-–—|•\s]+|[-–—|•\s]+$/g, '');
      if (!out.role && /\b(dispatch(er)?|owner|operator|operations|manager|president|ceo|coo|founder|director|coordinator|agent|sales|safety|accounting|broker|fleet|logistics specialist)\b/i.test(ln) && ln.split(' ').length <= 6 && !/\d{3}/.test(ln))
        out.role = ln.replace(/^[-–—|•\s]+|[-–—|•\s]+$/g, '');
      if (!out.city) {
        const i = tail.indexOf(ln), prev = i > 0 ? tail[i - 1] : '';
        const cz = ln.match(/^([A-Za-z][A-Za-z .'-]{1,30}),\s*([A-Z]{2})\.?,?\s+(\d{5})(?:-\d{4})?$/);            // "Salt Lake City, UT 84119"
        const full = ln.match(/^(\d+\s[^,]{2,50}),\s*([A-Za-z][A-Za-z .'-]{1,30}),\s*([A-Z]{2})\.?,?\s+(\d{5})(?:-\d{4})?\b/); // "1450 W 2100 S, Salt Lake City, UT 84119"
        if (cz && STATES.has(cz[2])) { out.city = title(cz[1]); out.state = cz[2]; out.zip = cz[3]; if (/^\d+\s+\S/.test(prev) && prev.length < 60) out.address = prev.replace(/,$/, ''); }
        else if (full && STATES.has(full[3])) { out.address = full[1].trim(); out.city = title(full[2]); out.state = full[3]; out.zip = full[4]; }
      }
    }
    const w = text.match(/\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi) || [];
    const site = w.map(u => u.replace(/[.,;]+$/, '')).find(u => !/linkedin|facebook|instagram|twitter|x\.com|youtube|outlook|microsoft|office\.com|aka\.ms|google|safelinks|brocktrans|mailchimp|calendly|zoom\.us|teams/i.test(u));
    if (site) out.website = /^https?:/i.test(site) ? site : 'https://' + site;
    return out;
  }

  // ---------- routes ----------
  async function adminRoutes(m, p, url, req, res) {
    const { send, fail, readBody } = ctx;
    let mm;
    if (p === '/api/admin/inbox/settings') {
      if (m === 'PUT') {
        const b = await readBody(req, 50000);
        if ('inbox_mode' in b && ['off', 'review', 'auto'].includes(b.inbox_mode)) {
          if (b.inbox_mode !== 'off' && mode() === 'off' && !getSetting('inbox_since')) setSetting('inbox_since', now());
          setSetting('inbox_mode', b.inbox_mode);
        }
        for (const k of Object.keys(TEMPLATES)) if (k in b) setSetting(k, String(b[k] ?? '').slice(0, 3000));
        if ('alerts_on' in b) setSetting('alerts_on', b.alerts_on ? '1' : '0');
        if (b.retry_mark_read) setSetting('mark_read_blocked', '0');
        if ('alert_days' in b) setSetting('alert_days', String(Math.max(7, Math.min(365, Number(b.alert_days) || 60))));
      }
      const t = {}; for (const k of Object.keys(TEMPLATES)) t[k] = tpl(k);
      return send(res, 200, { mode: mode(), since: getSetting('inbox_since', ''), last_check: getSetting('inbox_last_check', ''), last_error: getSetting('inbox_last_error', ''),
        configured: mailer.configured(), from: mailer.from(), mark_read_blocked: getSetting('mark_read_blocked', '') === '1', templates: t, defaults: TEMPLATES, alerts_on: getSetting('alerts_on', '0') === '1', alert_days: Number(getSetting('alert_days', '60')),
        counts: Object.fromEntries(db.prepare(`SELECT status, COUNT(*) n FROM inbox WHERE kind != 'alert_out' GROUP BY status`).all().map(r => [r.status, r.n])) }), true;
    }
    if (m === 'POST' && p === '/api/admin/inbox/check') {
      const saved = mode(); if (saved === 'off') return fail(res, 400, 'Turn the inbox on first (Review or Automatic).'), true;
      const r = await poll(); await sendAlerts().catch(() => {}); return send(res, 200, r), true;
    }
    if (m === 'GET' && p === '/api/admin/inbox') {
      const st = url.searchParams.get('status') || 'open';
      const where = st === 'open' ? `status IN ('needs_you','draft','error')` : st === 'all' ? `kind != 'alert_out'` : st === 'handled' ? `status IN ('sent','done') AND kind != 'alert_out'` : `status = ?`;
      const rows = db.prepare(`SELECT id, msg_id, from_email, from_name, subject, received_at, web_link, kind, status, summary, plan, load_ids, mc, amount, lane, result, error, sent_at, reply_html,
        substr(body, 1, 6000) AS body FROM inbox WHERE ${where} ORDER BY received_at DESC, id DESC LIMIT 200`).all(...(where.includes('?') ? [st] : []));
      const HWI = highwayIndex();
      return send(res, 200, rows.map(r => {
        const plan = JSON.parse(r.plan || '{}');
        const loads = JSON.parse(r.load_ids || '[]').map(id => db.prepare('SELECT id, ref, public_id, origin_city, origin_state, dest_city, dest_state FROM loads WHERE id = ?').get(id)).filter(Boolean);
        const hwc = HWI.check(r.from_email, r.mc);
        return { ...r, plan: undefined, company: hwc.name || '', highway_pass: hwc.pass, highway_mc: hwc.mc || '', reply_preview: r.reply_html || previewReply(plan), actions: (plan.actions || []).map(a => a.type), loads, lane: r.lane ? JSON.parse(r.lane) : null,
          carrier_flag: r.mc ? (db.prepare('SELECT flag FROM carrier_profiles WHERE mc = ?').get(r.mc) || {}).flag || '' : '' };
      })), true;
    }
    // ---- one click: tell a carrier who isn't on your Highway list that you can't use them ----
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/inbox\/(\d+)\/decline$/))) {
      const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(Number(mm[1]));
      if (!row) return fail(res, 404, 'Not found'), true;
      const b = await readBody(req, 2000);
      const cfg = publicConfig();
      const first = (String(row.from_name || '').split(/[\s,]+/)[0] || '').replace(/[^A-Za-z'-]/g, '') || 'there';
      const vars = { first_name: first, name: row.from_name || '', company: cfg.company, mc: row.mc || 'your MC' };
      const html = emailLayout('Carrier requirements', [para(fill(tpl('tpl_greeting'), vars)), para(fill(tpl('tpl_not_approved'), vars)), para(fill(tpl('tpl_signoff'), vars))].join(''), null);
      if (b.preview) return send(res, 200, { html, text: fill(tpl('tpl_not_approved'), vars) }), true;
      if (!mailer.configured()) return fail(res, 400, 'Email isn\'t connected (Settings → Email).'), true;
      const subject = reSub(row.subject || '');
      try {
        const threaded = /^(notify-|look-)/.test(row.msg_id || '') ? false : await mailer.reply(row.msg_id, html);
        if (!threaded) await mailer.send({ to: row.from_email, subject, html });
      } catch (e) { return fail(res, 400, e.message), true; }
      mailer.markRead(row.msg_id).catch(() => {});
      db.prepare(`UPDATE inbox SET status = 'sent', result = ?, error = NULL, reply_subject = ?, reply_html = ?, sent_at = datetime('now') WHERE id = ?`)
        .run('Told them they don\'t pass Highway', subject, html, row.id);
      ctx.onChange && ctx.onChange();
      return send(res, 200, { ok: true }), true;
    }
    // ---- you write the reply here (optionally with load details + buttons); goes out in their thread ----
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/inbox\/(\d+)\/write$/))) {
      const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(Number(mm[1]));
      if (!row) return fail(res, 404, 'Not found'), true;
      const b = await readBody(req, 50000);
      const text = String(b.text || '').trim().slice(0, 8000);
      const ids = [...new Set((Array.isArray(b.load_ids) ? b.load_ids : []).map(Number).filter(Boolean))].slice(0, 10);
      const list = ids.map(id => db.prepare('SELECT * FROM loads WHERE id = ?').get(id)).filter(Boolean);
      if (!text && !list.length) return fail(res, 400, 'Write a message or pick a load to send.'), true;
      const cfg = publicConfig();
      const first = (String(row.from_name || '').split(/[\s,]+/)[0] || '').replace(/[^A-Za-z'-]/g, '') || 'there';
      const vars = { first_name: first, name: row.from_name || '', company: cfg.company, lane: list[0] ? laneOf(list[0]) : '' };
      const token = linkToken(row.from_email, { name: row.from_name, mc: row.mc });
      const parts = [];
      if (text) parts.push(para(text));
      else parts.push(para(fill(tpl('tpl_greeting'), vars)), para(fill(tpl(list.length > 1 ? 'tpl_loads' : 'tpl_load'), { ...vars, lane_text: '' })));
      if (list.length) parts.push(...blocks(list, token), para(fill(tpl('tpl_howto'), vars)), para(fill(tpl('tpl_value'), vars)));
      parts.push(para(fill(tpl('tpl_signoff'), vars)));
      const heading = list.length === 1 ? laneOf(list[0]) : list.length ? `${list.length} loads` : (cfg.company || 'Reply');
      const html = emailLayout(heading, parts.join(''), null);
      if (b.preview) return send(res, 200, { html }), true;
      if (!mailer.configured()) return fail(res, 400, 'Email isn\'t connected (Settings → Email).'), true;
      const subject = reSub(row.subject || (list[0] ? laneOf(list[0]) : ''));
      try {
        const threaded = /^(notify-|look-)/.test(row.msg_id || '') ? false : await mailer.reply(row.msg_id, html);
        if (!threaded) await mailer.send({ to: row.from_email, subject, html });
      } catch (e) { return fail(res, 400, e.message), true; }
      mailer.markRead(row.msg_id).catch(() => {});
      for (const L of list) {
        db.prepare(`INSERT OR REPLACE INTO load_notifies (load_id, email) VALUES (?, ?)`).run(L.id, row.from_email);
        db.prepare(`INSERT INTO load_notes (load_id, kind, text) VALUES (?, 'note', ?)`).run(L.id, `Details emailed to ${row.from_name || row.from_email} from the Inbox`);
      }
      const prevIds = JSON.parse(row.load_ids || '[]');
      db.prepare(`UPDATE inbox SET status = 'sent', result = ?, error = NULL, reply_subject = ?, reply_html = ?, sent_at = datetime('now'), load_ids = ? WHERE id = ?`)
        .run(`You replied from the site${list.length ? ' with ' + list.length + ' load' + (list.length === 1 ? '' : 's') : ''}`, subject, html, JSON.stringify([...new Set([...prevIds, ...ids])]) , row.id);
      ctx.onChange && ctx.onChange();
      return send(res, 200, { ok: true }), true;
    }
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/inbox\/(\d+)\/(send|done|ignore|reopen|reprocess)$/))) {
      const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(Number(mm[1]));
      if (!row) return fail(res, 404, 'Not found'), true;
      const act = mm[2];
      if (act === 'send') {
        if (!['draft', 'error', 'needs_you'].includes(row.status)) return fail(res, 400, 'Already handled.'), true;
        const plan = JSON.parse(row.plan || '{}'); if (!plan.reply && !(plan.actions || []).length) return fail(res, 400, 'Nothing to send for this one — reply from Outlook.'), true;
        const b = await readBody(req, 20000);
        if (b.note && plan.reply) { const extra = `<p style="margin:0 0 12px">${hx(String(b.note)).replace(/\n/g, '<br>')}</p>`; if (plan.reply.html) plan.reply.html = plan.reply.html.replace('<div style="font:15px/1.5 Arial,sans-serif">', '<div style="font:15px/1.5 Arial,sans-serif">' + extra); db.prepare('UPDATE inbox SET plan = ? WHERE id = ?').run(JSON.stringify(plan), row.id); }
        const r = await execute(db.prepare('SELECT * FROM inbox WHERE id = ?').get(row.id));
        return r.error ? fail(res, 400, r.error) : send(res, 200, r), true;
      }
      if (act === 'reprocess') {
        const a = analyze({ id: row.msg_id, conversationId: row.conv_id, subject: row.subject, from: { emailAddress: { address: row.from_email, name: row.from_name } }, body: { content: row.body } });
        const status = a.status === 'auto_ok' ? 'draft' : a.status === 'ignored' ? 'ignored' : 'needs_you';
        db.prepare(`UPDATE inbox SET kind = ?, status = ?, summary = ?, plan = ?, load_ids = ?, mc = ?, amount = ?, lane = ?, error = NULL WHERE id = ?`)
          .run(a.kind, status, a.summary, JSON.stringify({ actions: a.actions, reply: a.reply }), a.load_ids.length ? JSON.stringify(a.load_ids) : null, a.mc || null, a.amount, a.lane ? JSON.stringify(a.lane) : null, row.id);
        return send(res, 200, { ok: true }), true;
      }
      db.prepare('UPDATE inbox SET status = ? WHERE id = ?').run(act === 'done' ? 'done' : act === 'ignore' ? 'ignored' : 'needs_you', row.id);
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/admin/highway-changes') {
      if (m === 'DELETE') { setSetting('hw_changes', ''); return send(res, 200, { ok: true }), true; }
      let c = null; try { c = JSON.parse(getSetting('hw_changes') || 'null'); } catch (_) { c = null; }
      const H = highwayIndex(); const tracked = trackedCarriers();
      let pass = 0, waiting = 0; for (const [e, mc] of tracked) H.check(e, mc).pass ? pass++ : waiting++;
      return send(res, 200, { changes: c, pass, waiting }), true;
    }
    // ---- carriers for a lane / carriers added by hand ----
    if (m === 'GET' && p === '/api/admin/carrier-search') {
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      if (q.length < 2) return send(res, 200, []), true;
      const like = '%' + q + '%', digits = q.replace(/\D/g, '');
      const out = new Map();
      const put = (r, source) => { const e = String(r.email || '').match(/[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}/i); const email = e ? e[0].toLowerCase() : '';
        const key = email || 'mc:' + r.mc; if (!out.has(key)) out.set(key, { email, name: r.name || '', company: r.company || '', mc: r.mc || '', phone: r.phone || '', source }); };
      db.prepare(`SELECT mc, name AS company, email, phone FROM qualified_carriers WHERE lower(name) LIKE ? OR lower(email) LIKE ? OR (? != '' AND mc LIKE ?) LIMIT 15`).all(like, like, digits, digits + '%').forEach(r => put(r, 'highway'));
      db.prepare(`SELECT mc, company, name, email, phone FROM carriers_manual WHERE lower(company) LIKE ? OR lower(name) LIKE ? OR lower(email) LIKE ? OR (? != '' AND mc LIKE ?) LIMIT 10`).all(like, like, like, digits, digits + '%').forEach(r => put(r, 'added'));
      db.prepare(`SELECT mc, company, contact_name AS name, email, phone FROM bids WHERE email != '' AND (lower(company) LIKE ? OR lower(email) LIKE ? OR (? != '' AND mc LIKE ?)) GROUP BY lower(email) LIMIT 10`).all(like, like, digits, digits + '%').forEach(r => put(r, 'bid'));
      const hw = new Set(db.prepare('SELECT mc FROM qualified_carriers').all().map(r => r.mc));
      return send(res, 200, [...out.values()].slice(0, 20).map(r => ({ ...r, highway_pass: !!(r.mc && hw.has(r.mc)) }))), true;
    }
    if ((mm = p.match(/^\/api\/admin\/lanes\/(\d+)\/carriers$/))) {
      const laneId = Number(mm[1]);
      if (m === 'GET') { const H = highwayIndex(); return send(res, 200, db.prepare('SELECT * FROM lane_carriers WHERE lane_id = ? ORDER BY company COLLATE NOCASE, email').all(laneId)
        .map(r => { const h = H.check(r.email, r.mc); return { ...r, mc: r.mc || h.mc || '', company: h.name || r.company || '', highway_pass: h.pass, favorite: !!r.favorite }; })
        .sort((a, b) => (b.favorite - a.favorite) || (b.highway_pass - a.highway_pass) || String(a.company || a.email).localeCompare(String(b.company || b.email)))), true; }
      if (m === 'POST') {
        const b = await readBody(req, 100000);
        const list = Array.isArray(b.carriers) ? b.carriers.slice() : [];
        if (b.paste) (String(b.paste).match(/[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[a-z]{2,}/gi) || []).forEach(e => list.push({ email: e, source: 'manual' }));
        let added = 0;
        const ins = db.prepare(`INSERT OR IGNORE INTO lane_carriers (lane_id, email, name, company, mc, phone, source) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const c of list.slice(0, 500)) {
          const email = String(c.email || '').trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
          // fill in what we know about this email
          const hw = db.prepare(`SELECT * FROM qualified_carriers WHERE lower(email) LIKE ? LIMIT 1`).get('%' + email + '%');
          const bid = db.prepare(`SELECT * FROM bids WHERE lower(email) = ? ORDER BY updated_at DESC LIMIT 1`).get(email);
          const man = db.prepare(`SELECT * FROM carriers_manual WHERE email = ?`).get(email);
          const r = ins.run(laneId, email, c.name || (man && man.name) || (bid && bid.contact_name) || '', c.company || (man && man.company) || (hw && hw.name) || (bid && bid.company) || '',
            normalizeMC(c.mc) || (man && man.mc) || (hw && hw.mc) || (bid && bid.mc) || '', c.phone || (man && man.phone) || (hw && hw.phone) || (bid && bid.phone) || '', c.source || 'manual');
          added += r.changes;
        }
        highwaySnapshotMerge(); return send(res, 200, { ok: true, added }), true;
      }
    }
    if (m === 'PUT' && (mm = p.match(/^\/api\/admin\/lanes\/(\d+)\/carriers\/(\d+)$/))) {
      const b = await readBody(req, 2000);
      db.prepare('UPDATE lane_carriers SET favorite = ? WHERE lane_id = ? AND id = ?').run(b.favorite ? 1 : 0, Number(mm[1]), Number(mm[2]));
      return send(res, 200, { ok: true }), true;
    }
    if (m === 'DELETE' && (mm = p.match(/^\/api\/admin\/lanes\/(\d+)\/carriers\/(\d+)$/))) { db.prepare('DELETE FROM lane_carriers WHERE lane_id = ? AND id = ?').run(Number(mm[1]), Number(mm[2])); return send(res, 200, { ok: true }), true; }
    if (p === '/api/admin/carriers-manual') {
      if (m === 'GET') return send(res, 200, db.prepare('SELECT * FROM carriers_manual ORDER BY company COLLATE NOCASE').all().map(c => ({ ...c, lane_ids: db.prepare('SELECT lane_id FROM lane_carriers WHERE email = ?').all(c.email).map(r => r.lane_id) }))), true;
      if (m === 'POST') {
        const b = await readBody(req, 20000);
        const email = String(b.email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Enter the carrier\'s email.'), true;
        const vals = [String(b.name || '').slice(0, 120), String(b.company || '').slice(0, 160), normalizeMC(b.mc), String(b.phone || '').slice(0, 40), String(b.notes || '').slice(0, 1000)];
        db.prepare(`INSERT INTO carriers_manual (email, name, company, mc, phone, notes) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(email) DO UPDATE SET name = excluded.name, company = excluded.company, mc = excluded.mc, phone = excluded.phone, notes = excluded.notes`).run(email, ...vals);
        if (Array.isArray(b.lane_ids)) {
          db.prepare('DELETE FROM lane_carriers WHERE email = ? AND source = ?').run(email, 'manual');
          const ins = db.prepare(`INSERT OR IGNORE INTO lane_carriers (lane_id, email, name, company, mc, phone, source) VALUES (?, ?, ?, ?, ?, ?, 'manual')`);
          b.lane_ids.map(Number).filter(Boolean).forEach(id => ins.run(id, email, vals[0], vals[1], vals[2], vals[3]));
        }
        db.prepare('DELETE FROM email_optout WHERE email = ?').run(email);
        highwaySnapshotMerge(); return send(res, 200, { ok: true }), true;
      }
    }
    if ((mm = p.match(/^\/api\/admin\/carriers-manual\/(\d+)$/)) && m === 'DELETE') {
      const c = db.prepare('SELECT * FROM carriers_manual WHERE id = ?').get(Number(mm[1]));
      if (c) { db.prepare('DELETE FROM carriers_manual WHERE id = ?').run(c.id); db.prepare(`DELETE FROM lane_carriers WHERE email = ? AND source = 'manual'`).run(c.email); }
      return send(res, 200, { ok: true }), true;
    }

    // ---- who should hear about this load: preview, then send ----
    if ((mm = p.match(/^\/api\/admin\/loads\/(\d+)\/recipients$/)) && m === 'GET') {
      const L = db.prepare('SELECT * FROM loads WHERE id = ?').get(Number(mm[1])); if (!L) return fail(res, 404, 'Not found'), true;
      const fl = !L.first_look_until ? 'none' : L.first_look_released ? 'released' : L.first_look_until === HELD ? 'held' : (L.first_look_until < now() ? 'ended' : 'active');
      return send(res, 200, { load: { id: L.id, lane: laneOf(L), post_rate: L.post_rate, open: biddingOpen(L), first_look: fl, first_look_until: fl === 'held' ? null : L.first_look_until, bid_count: bidStats.get(L.id).bid_count }, recipients: recipientsFor(L) }), true;
    }
    if ((mm = p.match(/^\/api\/admin\/loads\/(\d+)\/notify$/)) && m === 'POST') {
      const L = db.prepare('SELECT * FROM loads WHERE id = ?').get(Number(mm[1])); if (!L) return fail(res, 404, 'Not found'), true;
      if (!biddingOpen(L)) return fail(res, 400, 'This load isn\'t open — post it first.'), true;
      if (!mailer.configured()) return fail(res, 400, 'Email isn\'t connected (Settings → Email).'), true;
      const b = await readBody(req, 100000);
      const emails = [...new Set((Array.isArray(b.emails) ? b.emails : []).map(e => String(e).trim().toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))].slice(0, 400);
      if (!emails.length) return fail(res, 400, 'Pick at least one carrier.'), true;
      const firstLook = Number(b.first_look_hours) > 0 ? Math.min(72, Number(b.first_look_hours)) : 0;
      const known = new Map(recipientsFor(L).map(r => [r.email, r]));
      const H = highwayIndex();
      const waiting = emails.filter(e => !H.check(e, (known.get(e) || {}).mc).pass);
      for (const w of waiting) emails.splice(emails.indexOf(w), 1);
      if (!emails.length) return fail(res, 400, 'None of those carriers are on your Highway list yet.'), true;
      const cfg = publicConfig();
      let sent = 0; const failed = [];
      for (const e of emails) {
        const r = known.get(e) || {};
        const first = (String(r.name || '').split(/[\s,]+/)[0] || '').replace(/[^A-Za-z'-]/g, '') || 'there';
        const vars = { first_name: first, company: cfg.company };
        const html = compose(laneOf(L), [para(fill(tpl(firstLook ? 'tpl_first_look' : 'tpl_notify'), vars)), ...blocks([L], linkToken(e, { name: r.name, mc: r.mc })), para(fill(tpl('tpl_howto'), vars))], vars);
        const subject = `${firstLook ? 'First look' : 'Load available'}: ${laneOf(L)}${L.post_rate ? ' · ' + usd(L.post_rate) : ''}`;
        try {
          await mailer.send({ to: e, subject, html });
          db.prepare(`INSERT OR REPLACE INTO load_notifies (load_id, email) VALUES (?, ?)`).run(L.id, e);
          // log it so a reply finds this load (and never triggers a second canned reply)
          db.prepare(`INSERT INTO inbox (msg_id, from_email, subject, kind, status, summary, load_ids, reply_subject, reply_html, sent_at, received_at) VALUES (?, ?, ?, 'alert_out', 'sent', ?, ?, ?, ?, datetime('now'), ?)`)
            .run('notify-' + crypto.randomBytes(8).toString('hex'), e, '(load email)', `Load email sent: ${laneOf(L)}`, JSON.stringify([L.id]), subject, html, now());
          // lane alerts for this carrier count this load as sent
          db.prepare(`INSERT OR IGNORE INTO alert_sends (alert_id, load_id) SELECT id, ? FROM lane_alerts WHERE email = ?`).run(L.id, e);
          sent++;
        } catch (err) { failed.push(`${e}: ${err.message}`); }
      }
      if (firstLook && sent) {
        db.prepare(`UPDATE loads SET first_look_until = ?, first_look_released = 0, first_look_reminded = 0 WHERE id = ?`).run(new Date(Date.now() + firstLook * 3600000).toISOString(), L.id);
      } else if (sent && L.first_look_until) {
        db.prepare(`UPDATE loads SET first_look_released = 1 WHERE id = ?`).run(L.id); // sending to everyone puts it on the board
      }
      db.prepare(`INSERT INTO load_notes (load_id, kind, text) VALUES (?, 'note', ?)`).run(L.id, `${firstLook ? `First look (${firstLook} hr) emailed to` : 'Emailed to'} ${sent} carrier${sent === 1 ? '' : 's'}${failed.length ? ` (${failed.length} failed)` : ''}`);
      return send(res, 200, { ok: true, sent, failed, skipped_not_highway: waiting.length }), true;
    }

    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/loads\/(\d+)\/release$/))) {
      db.prepare(`UPDATE loads SET first_look_released = 1 WHERE id = ?`).run(Number(mm[1]));
      db.prepare(`INSERT INTO load_notes (load_id, kind, text) VALUES (?, 'note', 'First look ended — put on the board')`).run(Number(mm[1]));
      return send(res, 200, { ok: true }), true;
    }
    // ---- look back through past loads@ email for carriers who asked about lanes ----
    if (m === 'POST' && p === '/api/admin/inbox/lookback') {
      const b = await readBody(req, 2000);
      const days = Math.max(7, Math.min(180, Number(b.days) || 90));
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const msgs = await mailer.listInbox(since, 2000);
      const self = String(mailer.from() || '').toLowerCase();
      const H = highwayIndex();
      const saved = db.prepare('SELECT * FROM lanes').all().map(r => ({ ...r, data: JSON.parse(r.data || '{}') }));
      const by = new Map();
      for (const msg of msgs) {
        const a = analyze(msg);
        if (a.kind === 'ignored' || !a.email || a.email === self) continue;
        const lane = a.lane || (() => { const lid = (a.load_ids || [])[0]; const L = lid && db.prepare('SELECT origin_state, dest_state FROM loads WHERE id = ?').get(lid); return L ? { o: { state: L.origin_state }, d: { state: L.dest_state } } : null; })();
        if (!lane) continue;
        const key = a.email;
        if (!by.has(key)) {
          const h = H.check(a.email, a.mc);
          by.set(key, { email: a.email, name: a.name, mc: h.mc || a.mc || '', company: h.name || '', phone: h.phone || '', highway_pass: h.pass, lanes: [], last: msg.receivedDateTime });
        }
        const c = by.get(key);
        const k = `${lane.o ? lane.o.state : ''}>${lane.d ? lane.d.state : ''}`;
        if (!c.lanes.find(x => x.k === k)) c.lanes.push({ k, o: lane.o ? lane.o.state : '', d: lane.d ? lane.d.state : '' });
      }
      const already = new Set(db.prepare('SELECT email FROM lane_carriers').all().map(r => r.email));
      const out = [...by.values()].map(c => ({ ...c, already: already.has(c.email),
        saved_lanes: saved.filter(s => c.lanes.some(l => (!l.o || l.o === s.data.origin_state) && (!l.d || l.d === s.data.dest_state) && (l.o || l.d))).map(s => ({ id: s.id, name: s.name })) }))
        .sort((x, y) => (y.highway_pass - x.highway_pass) || y.lanes.length - x.lanes.length);
      return send(res, 200, { days, scanned: msgs.length, carriers: out }), true;
    }
    // ---- phone contacts: everyone who emailed loads@, with phone numbers pulled from their signatures ----
    if (m === 'POST' && p === '/api/admin/inbox/contacts') {
      const b = await readBody(req, 2000);
      const days = Math.max(7, Math.min(365, Number(b.days) || 180));
      const msgs = await mailer.listInbox(new Date(Date.now() - days * 864e5).toISOString(), 5000);
      const self = String(mailer.from() || '').toLowerCase();
      const H = highwayIndex();
      const by = new Map();
      for (const msg of msgs.slice().reverse()) { // newest first, so the latest signature wins
        const a = analyze(msg);
        if (a.kind === 'ignored' || a.kind === 'remove' || !a.email || a.email === self) continue;
        const sig = signatureInfo(String((msg.body || {}).content || msg.bodyPreview || ''), a.email);
        let c = by.get(a.email);
        if (!c) { c = { email: a.email, name: a.name, mc: a.mc || '', phones: [], sig: {}, emails: 0, last_at: msg.receivedDateTime }; by.set(a.email, c); }
        c.emails++;
        if (!c.mc && a.mc) c.mc = a.mc;
        for (const ph of sig.phones) if (!c.phones.find(x => x.num === ph.num)) c.phones.push(ph);
        for (const k of ['company', 'role', 'website', 'address', 'city', 'state', 'zip']) if (!c.sig[k] && sig[k]) c.sig[k] = sig[k];
      }
      const manual = new Map(db.prepare('SELECT * FROM carriers_manual').all().map(r => [String(r.email).toLowerCase(), r]));
      const bidPhone = new Map(db.prepare(`SELECT lower(email) e, phone, company, contact_name FROM bids WHERE email != '' ORDER BY updated_at`).all().map(r => [r.e, r]));
      const rows = [...by.values()].map(c => {
        const h = H.check(c.email, c.mc), mm = manual.get(c.email) || {}, bp = bidPhone.get(c.email) || {};
        // best number: their own cell/direct from the signature, then any signature number, then bids / Highway
        const own = c.phones.find(x => x.kind === 'cell') || c.phones.find(x => x.kind === 'direct') || c.phones[0];
        const phone = own ? own.num : fmtPhone(mm.phone) || fmtPhone(bp.phone) || fmtPhone(h.phone) || '';
        const phoneFrom = own ? 'signature' : fmtPhone(mm.phone) || fmtPhone(bp.phone) ? 'their bid' : fmtPhone(h.phone) ? 'Highway (company line)' : '';
        let nm = String(c.name || bp.contact_name || mm.name || '').replace(/["']/g, '').trim();
        if (!nm || /@/.test(nm)) nm = '';
        const parts = nm.split(/\s+/).filter(Boolean);
        const company = h.name || c.sig.company || mm.company || bp.company || '';
        const mc = h.mc || c.mc || '';
        return { first: parts[0] || (nm ? nm : c.email.split('@')[0]), last: parts.slice(1).join(' '), phone, phone_from: phoneFrom, other_phones: c.phones.filter(x => x.num !== phone).map(x => x.num),
          address: c.sig.address || '', city: c.sig.city || '', state: c.sig.state || '', zip: c.sig.zip || '', country: phone ? 'US' : '',
          email: c.email, company, role: (c.sig.role && c.sig.role.toLowerCase() !== nm.toLowerCase() ? c.sig.role : '') || (mc ? `Carrier - MC ${mc}` : ''), website: c.sig.website || siteFromEmail(c.email),
          mc, highway_pass: h.pass, emails: c.emails, last_at: c.last_at };
      }).sort((x, y) => (!!y.phone - !!x.phone) || String(x.company || x.first).localeCompare(String(y.company || y.first)));
      return send(res, 200, { days, scanned: msgs.length, contacts: rows }), true;
    }
    if (m === 'POST' && p === '/api/admin/inbox/lookback/apply') {
      const b = await readBody(req, 500000);
      let lanesAdded = 0, alerts = 0, people = 0;
      // everyone is kept; Highway is checked live every time a load goes out, so "waiting" carriers
      // become good to go on their own when the Highway sheet is updated
      for (const c of (Array.isArray(b.carriers) ? b.carriers : []).slice(0, 2000)) {
        const email = String(c.email || '').toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
        db.prepare(`INSERT OR IGNORE INTO carriers_manual (email, name, company, mc, phone, source) VALUES (?, ?, ?, ?, ?, 'inbox')`).run(email, c.name || '', c.company || '', normalizeMC(c.mc), c.phone || '');
        people++;
        const ins = db.prepare(`INSERT OR IGNORE INTO lane_carriers (lane_id, email, name, company, mc, phone, source) VALUES (?, ?, ?, ?, ?, ?, 'inbox')`);
        for (const sl of c.saved_lanes || []) lanesAdded += ins.run(Number(sl.id), email, c.name || '', c.company || '', normalizeMC(c.mc), c.phone || '').changes;
        for (const l of c.lanes || []) if (saveAlert({ email, name: c.name, mc: normalizeMC(c.mc), o_state: l.o || null, d_state: l.d || null, kind: 'lane', source: 'email' })) alerts++;
      }
      highwaySnapshotMerge(); return send(res, 200, { ok: true, people, lanes_added: lanesAdded, alerts }), true;
    }

    // lane alerts
    if (p === '/api/admin/alerts') {
      if (m === 'GET') {
        const H = highwayIndex();
        return send(res, 200, db.prepare(`SELECT * FROM lane_alerts ORDER BY active DESC, created_at DESC LIMIT 2000`).all()
          .map(a => { const h = H.check(a.email, a.mc); return { ...a, mc: a.mc || h.mc || '', company: h.name || (db.prepare('SELECT company FROM carriers_manual WHERE email = ?').get(a.email) || {}).company || '', highway_pass: h.pass }; })), true;
      }
      if (m === 'POST') {
        const b = await readBody(req, 5000);
        const id = saveAlert({ email: b.email, name: b.name, mc: normalizeMC(b.mc), o_state: String(b.o_state || '').toUpperCase().slice(0, 2) || null, d_state: String(b.d_state || '').toUpperCase().slice(0, 2) || null, equipment: b.equipment || '', kind: 'lane', source: 'admin' });
        if (!id) return fail(res, 400, 'Enter an email and at least a pickup or delivery state (and make sure they haven\'t opted out).'), true;
        const L = openLoads(); const ins = db.prepare('INSERT OR IGNORE INTO alert_sends (alert_id, load_id) VALUES (?, ?)');
        if (!b.send_current) matchLoads({ o: b.o_state ? { state: String(b.o_state).toUpperCase() } : null, d: b.d_state ? { state: String(b.d_state).toUpperCase() } : null }, '', b.equipment || '').exact.forEach(x => ins.run(id, x.id));
        return send(res, 200, { ok: true, id }), true;
      }
    }
    if ((mm = p.match(/^\/api\/admin\/alerts\/(\d+)$/)) && m === 'DELETE') { db.prepare('DELETE FROM lane_alerts WHERE id = ?').run(Number(mm[1])); db.prepare('DELETE FROM alert_sends WHERE alert_id = ?').run(Number(mm[1])); return send(res, 200, { ok: true }), true; }
    // test the rules without a mailbox: paste an email
    if (m === 'POST' && p === '/api/admin/inbox/test') {
      const b = await readBody(req, 50000);
      const a = analyze({ id: 'test', subject: b.subject || '', from: { emailAddress: { address: b.from || 'carrier@example.com', name: b.name || 'Test Carrier' } }, body: { content: b.body || '' } });
      return send(res, 200, { kind: a.kind, summary: a.summary, status: a.status, actions: a.actions.map(x => x.type), mc: a.mc, amount: a.amount, lane: a.lane, reply_preview: previewReply({ actions: a.actions, reply: a.reply }) }), true;
    }
    return false;
  }

  async function publicRoutes(m, p, req, res, ip) {
    const { send, fail, readBody, limited } = ctx;
    let mm;
    // one-tap page from the email buttons: /o/<carrier token or _>/<load id>
    if (m === 'GET' && /^\/o\/[\w-]{1,40}\/L-[\w]{4,10}\/?$/.test(p)) return ctx.serveFile(res, 'offer.html'), true;
    if ((mm = p.match(/^\/api\/o\/([\w-]{1,40})\/(L-[\w]{4,10})$/))) {
      const L = db.prepare(`SELECT * FROM loads WHERE public_id = ? AND status != 'draft'`).get(mm[2]);
      if (!L) return fail(res, 404, 'This load is no longer posted.'), true;
      const link = mm[1] === '_' ? null : db.prepare('SELECT * FROM carrier_links WHERE token = ?').get(mm[1]);
      const prior = link ? db.prepare('SELECT * FROM bids WHERE lower(email) = ? ORDER BY updated_at DESC LIMIT 1').get(link.email) : null;
      const who = link ? { email: link.email, name: link.name || (prior && prior.contact_name) || '', company: link.company || (prior && prior.company) || '', mc: link.mc || (prior && prior.mc) || '',
        phone: link.phone || (prior && prior.phone) || '' } : null;
      if (who && who.mc && !who.company) who.company = (db.prepare('SELECT name FROM qualified_carriers WHERE mc = ?').get(who.mc) || {}).name || '';
      if (m === 'GET') {
        return send(res, 200, { open: biddingOpen(L), awarded: L.status === 'awarded', post_rate: L.post_rate || null, bid_step: ctx.bidStep ? ctx.bidStep() : 50,
          load: { public_id: L.public_id, lane: laneOf(L), origin: [L.origin_city, L.origin_state].filter(Boolean).join(', '), dest: [L.dest_city, L.dest_state].filter(Boolean).join(', '),
            pickup_date: L.pickup_date, pickup_window: L.pickup_window, delivery_date: L.delivery_date, delivery_window: L.delivery_window, equipment: L.equipment, weight: L.weight, miles: L.miles, commodity: L.commodity },
          carrier: who, known: !!(who && who.mc && who.company && (who.name || who.email)) }), true;
      }
      if (m === 'POST') {
        if (limited('o:' + ip, 20, 600000)) return fail(res, 429, 'Too many tries. Please wait a few minutes.'), true;
        const b = await readBody(req, 10000);
        const cover = b.action === 'cover';
        if (cover && !L.post_rate) return fail(res, 400, 'This load has no posted rate — make an offer instead.'), true;
        const data = { mc: b.mc || (who && who.mc), company: b.company || (who && who.company), contact_name: b.contact_name || (who && (who.name || who.email)),
          email: b.email || (who && who.email) || '', phone: b.phone || (who && who.phone) || '', amount: cover ? L.post_rate : b.amount,
          notes: [cover ? 'Can cover at posted rate' : '', String(b.note || '').slice(0, 500)].filter(Boolean).join(' — ') };
        const r = placeBid(L, data, { ip, source: cover ? 'cover' : 'offer', skipConfirm: true, bypassRules: cover });
        if (!r.ok) return fail(res, r.status || 400, r.error), true;
        // remember them for next time
        if (data.email) {
          const t = link ? link.token : linkToken(data.email);
          db.prepare(`UPDATE carrier_links SET mc = ?, company = ?, name = COALESCE(NULLIF(?, ''), name), phone = COALESCE(NULLIF(?, ''), phone), used_at = datetime('now') WHERE token = ?`)
            .run(normalizeMC(data.mc), data.company || '', data.contact_name || '', data.phone || '', t);
        }
        return send(res, 200, { ok: true, amount: r.amount, cover, name: data.contact_name, lane: laneOf(L), token: r.token }), true;
      }
    }
    // carrier signs up for lane alerts on the board
    if (m === 'POST' && p === '/api/alerts') {
      if (limited('al:' + ip, 10, 3600000)) return fail(res, 429, 'Too many sign-ups from this connection. Try again later.'), true;
      const b = await readBody(req, 5000);
      const email = String(b.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Enter a valid email.'), true;
      const lanes = (Array.isArray(b.lanes) ? b.lanes : []).slice(0, 6).map(l => ({ o: String(l.o || '').toUpperCase().slice(0, 2), d: String(l.d || '').toUpperCase().slice(0, 2) }))
        .filter(l => (STATES.has(l.o) || !l.o) && (STATES.has(l.d) || !l.d) && (l.o || l.d));
      if (!lanes.length) return fail(res, 400, 'Pick at least one pickup or delivery state.'), true;
      const eq = ['van', 'reefer', 'flatbed'].includes(b.equipment) ? b.equipment : '';
      const ids = lanes.map(l => saveAlert({ email, name: String(b.name || '').slice(0, 80), mc: normalizeMC(b.mc), o_state: l.o || null, d_state: l.d || null, equipment: eq, kind: 'lane', source: 'site' })).filter(Boolean);
      // loads already posted on these lanes go out in the next alert run, so they get something right away
      return send(res, 200, { ok: true, count: ids.length }), true;
    }
    if (m === 'GET' && (mm = p.match(/^\/alerts\/off\/([\w-]{10,40})$/))) {
      const a = db.prepare('SELECT * FROM lane_alerts WHERE token = ?').get(mm[1]);
      if (a) db.prepare('UPDATE lane_alerts SET active = 0 WHERE email = ?').run(a.email);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Alerts stopped</title><body style="font:16px Arial,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;color:#141B27">
        <h2>${a ? 'Lane alerts stopped' : 'Link not found'}</h2><p>${a ? `We won't send lane alerts to ${hx(a.email)} anymore.` : 'This link is not valid.'}</p><p><a href="/">See open loads</a></p></body>`);
      return true;
    }
    return false;
  }

  return { adminRoutes, publicRoutes, start, poll, sendAlerts, analyze, linkToken, highwayChanged, holdForFirstLook, TEMPLATES };
};
