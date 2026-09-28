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
  tpl_howto: 'To bid, just reply with your all-in rate and MC# — for example: "2400 MC 123456 load #{example}".',
  tpl_load: 'Here are the details for this load:',
  tpl_bid: 'Got it — your bid of {rate} on {lane} (load #{load}) is in. {standing}',
  tpl_bid_problem: "Thanks — we couldn't enter your bid on {lane} (load #{load}): {problem}",
  tpl_book: "Got it — you asked to book {lane} (load #{load}) at {rate}. We'll confirm shortly and send the rate confirmation.",
  tpl_closed: 'Thanks — load #{load} ({lane}) is no longer available.',
  tpl_remove: "You're off our load list. Reply anytime if you want back on.",
  tpl_alert: 'A load just posted on a lane you asked about:',
  tpl_value: '',
  tpl_signoff: 'Thanks,\n{company}',
};
const tpl = k => { const v = getSetting(k); return v == null ? TEMPLATES[k] : v; };

const STATE_NAMES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY' };
const STATES = new Set(Object.values(STATE_NAMES).concat('DC'));
const STATE_RE = Object.keys(STATE_NAMES).sort((a, b) => b.length - a.length).join('|');

module.exports = function inbox(ctx) {
  const { mailer, emailLayout, siteBase, notifyTo, usd, hx, laneOf, TIMEZONE, placeBid, biddingOpen, publicConfig, bidStats, normalizeMC } = ctx;
  const mode = () => getSetting('inbox_mode', 'off');
  const now = () => new Date().toISOString();

  // ---------- text helpers ----------
  function newText(body) {
    // keep only what the sender wrote, not the quoted email below it
    const lines = String(body || '').replace(/\r/g, '').split('\n');
    const out = [];
    for (const ln of lines) {
      if (/^\s*>/.test(ln)) break;
      if (/^\s*(-{2,}\s*original message|_{5,}|from:\s.+|sent from my|on .{4,80} wrote:$|-----\s*forwarded)/i.test(ln)) break;
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

  function findLane(subject, text) {
    const cities = knownCities();
    const srcs = [String(subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, ''), text.slice(0, 1500)];
    const side = `([A-Za-z][A-Za-z .'-]{0,40}?,?\\s*\\b[A-Z]{2}\\b(?:\\s+\\d{5})?|[A-Za-z][A-Za-z .'-]{1,40}?)`;
    const sep = `\\s*(?:\\bto\\b|->|→|>|–|—|-|/|\\bthru\\b)\\s*`;
    for (const src of srcs) {
      for (const line of src.split('\n')) {
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
  function findMC(text) {
    const m = String(text || '').match(/\b(?:MC|M\.C\.|MC#|docket)\s*[#:.-]?\s*(\d{4,8})\b/i);
    return m ? normalizeMC(m[1]) : '';
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

  function openLoads() { return db.prepare(`SELECT * FROM loads WHERE status = 'open'`).all().filter(biddingOpen); }
  function findLoadRef(subject, text) {
    const all = `${subject}\n${text}`;
    let m = all.match(/\bL-[23456789A-HJ-NP-Z]{6}\b/);
    if (m) { const L = db.prepare('SELECT * FROM loads WHERE public_id = ?').get(m[0]); if (L) return L; }
    m = String(subject || '').match(/\bLoad\s+([A-Za-z0-9][A-Za-z0-9-]{1,30})\s*·/);
    if (m) { const L = db.prepare(`SELECT * FROM loads WHERE (ref = ? OR public_id = ?) AND status != 'draft' ORDER BY id DESC`).get(m[1], m[1]); if (L) return L; }
    // "#A1", "load 48213", "order SO-10988" — only refs of real loads, and only if they look like a ref
    const refs = db.prepare(`SELECT id, ref FROM loads WHERE ref IS NOT NULL AND ref != '' AND status != 'draft' ORDER BY id DESC LIMIT 500`).all();
    for (const r of refs) {
      const ref = String(r.ref).trim(); if (ref.length < 2) continue;
      const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?:#|\\bload\\s*#?\\s*|\\border\\s*#?\\s*|\\bref\\s*#?\\s*)${esc}\\b`, 'i').test(all)) return db.prepare('SELECT * FROM loads WHERE id = ?').get(r.id);
    }
    return null;
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
  function loadBlock(L) {
    const url = siteBase() ? `${siteBase()}/load/${L.public_id}` : '';
    const st = bidStats.get(L.id);
    const d = v => { if (!v) return 'TBD'; const t = new Date(String(v).slice(0, 10) + 'T12:00:00Z'); return isNaN(t) ? v : t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); };
    const facts = [[L.equipment, L.temp].filter(Boolean).join(' · '), L.weight ? Number(L.weight).toLocaleString() + ' lb' : '', L.pallets ? L.pallets + ' pallets' : '', L.miles ? Math.round(L.miles).toLocaleString() + ' mi' : '', L.commodity || ''].filter(Boolean).join(' · ');
    const due = L.bid_deadline ? new Date(L.bid_deadline).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TIMEZONE }) : '';
    return `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border:1px solid #D6DCE6;border-radius:8px;margin:0 0 10px;border-collapse:separate">
      <tr><td style="padding:12px 14px;font:14px Arial,sans-serif;color:#141B27">
        <div style="font:700 16px Arial,sans-serif;text-transform:uppercase">${hx(laneOf(L))}</div>
        <div style="color:#586478;margin:2px 0 6px">Load #${hx(L.ref || L.public_id)}</div>
        <div>Pick up <b>${hx(d(L.pickup_date))}${L.pickup_window ? ' ' + hx(L.pickup_window) : ''}</b> · Deliver <b>${hx(d(L.delivery_date))}${L.delivery_window ? ' ' + hx(L.delivery_window) : ''}</b></div>
        ${facts ? `<div style="margin-top:2px">${hx(facts)}</div>` : ''}
        ${L.requirements ? `<div style="margin-top:2px;color:#586478">${hx(L.requirements)}</div>` : ''}
        <div style="margin-top:6px">${L.book_rate ? `<b style="color:#17724A">Book it now: ${usd(L.book_rate)} all-in</b> · ` : ''}${st.bid_count ? `Current bid ${usd(st.low_bid)}` : 'No bids yet'}${due ? ` · Bids due ${hx(due)}` : ''}</div>
        ${url ? `<div style="margin-top:8px"><a href="${hx(url)}" style="color:#1D4F9E;font-weight:700">Map &amp; details</a></div>` : ''}
      </td></tr></table>`;
  }
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

    // 2) about a specific load? (load # in subject/body, or a reply to our email that listed exactly one load)
    let L = findLoadRef(subject, text);
    if (!L && msg.conversationId) {
      const prev = db.prepare(`SELECT load_ids FROM inbox WHERE conv_id = ? AND load_ids IS NOT NULL ORDER BY id DESC LIMIT 1`).get(msg.conversationId);
      const ids = prev ? JSON.parse(prev.load_ids || '[]') : [];
      if (ids.length === 1) L = db.prepare('SELECT * FROM loads WHERE id = ?').get(ids[0]);
    }
    const rate = findRate(text, mc);
    const wantsBook = /\b(book(ing)? it|book (this|that|the load|load)|^book\b|i'?ll take it|we'?ll take it|we can take it|we'?ll book|i accept|we accept|accept(ed)? the (rate|price)|let'?s book)\b/im.test(text) || /^\s*book\b/i.test(text);
    if (L) {
      res.load_ids = [L.id];
      const vl = { ...vars, lane: laneOf(L), load: L.ref || L.public_id, rate: '' };
      if (!biddingOpen(L)) {
        res.kind = 'load_question'; res.summary = `About load #${vl.load} (${vl.lane}), which is no longer open.`;
        res.reply = { subject: reSub(subject), html: compose('Load no longer available', [para(fill(tpl('tpl_closed'), vl))], vars) };
        const other = matchLoads({ o: { state: L.origin_state } }, '', '').exact.filter(x => x.id !== L.id).slice(0, 4);
        if (other.length) { res.reply.html = compose('Load no longer available', [para(fill(tpl('tpl_closed'), vl)), para(fill(tpl('tpl_more'), vl)), ...other.map(loadBlock), para(fill(tpl('tpl_howto'), { ...vl, example: other[0].ref || other[0].public_id }))], vars); res.load_ids = other.map(x => x.id); }
        res.status = 'auto_ok'; return res;
      }
      if (wantsBook && L.book_rate) {
        res.kind = 'book'; res.amount = L.book_rate; vl.rate = usd(L.book_rate);
        if (!mc) { res.status = 'needs_you'; res.summary = `Wants to BOOK load #${vl.load} at ${vl.rate}, but no MC# found — reply and ask for it.`; return res; }
        res.summary = `Wants to BOOK load #${vl.load} (${vl.lane}) at ${vl.rate} — MC ${mc}.`;
        res.actions.push({ type: 'bid', load_id: L.id, book_now: true, ...who });
        res.reply = { subject: reSub(subject), html: compose('Booking request received', [para(fill(tpl('tpl_book'), vl)), loadBlock(L)], vars) };
        res.status = 'auto_ok'; return res;
      }
      if (wantsBook && !rate) {
        // "I'll take it" with no number: you decide who gets the load
        res.kind = 'load_question'; res.status = 'needs_you';
        res.summary = `Wants load #${vl.load} (${vl.lane})${mc ? ' — MC ' + mc : ''} but gave no rate — call or reply to them.`;
        return res;
      }
      if (rate) {
        res.kind = 'bid'; res.amount = rate; vl.rate = usd(rate);
        if (!mc) { res.status = 'needs_you'; res.summary = `Offered ${vl.rate} on load #${vl.load}, but no MC# found — reply and ask for it.`; return res; }
        res.summary = `Bid ${vl.rate} on load #${vl.load} (${vl.lane}) — MC ${mc}.`;
        res.actions.push({ type: 'bid', load_id: L.id, amount: rate, ...who });
        res.reply = { subject: reSub(subject), template: 'bid', vars: vl, load_id: L.id };
        res.status = 'auto_ok'; return res;
      }
      res.kind = 'load_question'; res.summary = `Asked about load #${vl.load} (${vl.lane}).`;
      res.reply = { subject: reSub(subject), html: compose(`Load #${vl.load}`, [para(fill(tpl('tpl_load'), vl)), loadBlock(L), para(fill(tpl('tpl_howto'), { ...vl, example: vl.load }))], vars) };
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
      const parts = [];
      if (exact.length) { parts.push(para(fill(tpl('tpl_loads'), vl)), ...exact.map(loadBlock)); }
      else parts.push(para(fill(tpl('tpl_none'), vl)));
      if (near.length) parts.push(para(fill(tpl('tpl_more'), vl)), ...near.map(loadBlock));
      const listed = exact.concat(near);
      if (listed.length) parts.push(para(fill(tpl('tpl_howto'), { ...vl, example: listed[0].ref || listed[0].public_id })));
      res.load_ids = listed.map(x => x.id);
      res.reply = { subject: reSub(subject), html: compose(listed.length ? `Loads ${lt}` : `Nothing ${lt} yet`, parts, vars) };
      res.actions.push({ type: 'alert', email, name, mc, o_state: lane.o && lane.o.state, o_city: lane.o && lane.o.city, d_state: lane.d && lane.d.state, d_city: lane.d && lane.d.city,
        equipment, avail_date: truck ? date : '', kind: truck ? 'truck' : 'lane', already: listed.map(x => x.id) });
      res.status = 'auto_ok'; return res;
    }

    // 4) a rate with no load we can identify, or anything else → you
    if (rate) res.summary = `Mentioned ${usd(rate)} but no load # or lane found.`;
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
        const r = placeBid(L, { mc: a.mc, amount: a.amount, company: a.company, contact_name: a.contact_name, email: a.email, phone: a.phone, book_now: !!a.book_now, notes: 'By email' }, { source: 'email', skipConfirm: true });
        a.result = r;
        results.push(r.ok ? `${a.book_now ? 'Book-it-now request' : 'Bid'} ${usd(r.amount)} entered` : `Bid not entered: ${r.error}`);
        if (plan.reply && plan.reply.template === 'bid') {
          const vl = plan.reply.vars;
          const st = L ? bidStats.get(L.id) : null;
          const standing = r.ok ? (r.you_are_low ? "You're winning this load right now — we'll let you know if someone beats it." : `You're not winning yet — the current bid is ${usd(st.low_bid)}.${r.next_max ? ` Reply with ${usd(r.next_max)} or less to take the lead.` : ''}`) : '';
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
        await mailer.send({ to: row.from_email, subject: plan.reply.subject || ('RE: ' + (row.subject || '')), html: plan.reply.html });
        sent = true;
      } catch (e) { error = e.message; }
    }
    db.prepare(`UPDATE inbox SET status = ?, result = ?, error = ?, reply_subject = ?, reply_html = ?, sent_at = CASE WHEN ? THEN datetime('now') ELSE sent_at END, plan = ? WHERE id = ?`)
      .run(error ? 'error' : 'sent', results.join(' · '), error || null, plan.reply ? plan.reply.subject : null, plan.reply ? plan.reply.html : null, sent ? 1 : 0, JSON.stringify(plan), row.id);
    ctx.onChange && ctx.onChange();
    return { sent, error, results };
  }

  // preview a bid reply before it runs (review mode)
  function previewReply(plan) {
    if (!plan.reply) return null;
    if (plan.reply.html) return plan.reply.html;
    if (plan.reply.template === 'bid') {
      const a = (plan.actions || []).find(x => x.type === 'bid'); const L = a && db.prepare('SELECT * FROM loads WHERE id = ?').get(a.load_id);
      return L ? compose(`Bid received: ${usd(a.amount)}`, [para(fill(tpl('tpl_bid'), { ...plan.reply.vars, rate: usd(a.amount), standing: '(winning / not winning is filled in when it sends)' })), loadBlock(L)], plan.reply.vars) : null;
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
    if (alerting || !mailer.configured() || getSetting('alerts_on', '1') !== '1') return;
    alerting = true;
    try {
      const loads = openLoads();
      if (!loads.length) return;
      const alerts = db.prepare(`SELECT * FROM lane_alerts WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?)`).all(now());
      const out = new Set(db.prepare('SELECT email FROM email_optout').all().map(r => r.email));
      const dnu = new Set(db.prepare(`SELECT mc FROM carrier_profiles WHERE flag = 'dnu'`).all().map(r => r.mc));
      const sentQ = db.prepare('SELECT 1 FROM alert_sends WHERE alert_id = ? AND load_id = ?');
      const byEmail = new Map();
      for (const a of alerts) {
        if (out.has(a.email) || (a.mc && dnu.has(a.mc))) continue;
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
          [para(fill(tpl('tpl_alert'), vars)), ...list.map(loadBlock), para(fill(tpl('tpl_howto'), { ...vars, example: list[0].ref || list[0].public_id })),
            unsub ? `<p style="font-size:12px;color:#586478">You asked for loads on this lane. <a href="${hx(unsub)}" style="color:#586478">Stop these alerts</a>.</p>` : ''], vars);
        try {
          await mailer.send({ to: email, subject: list.length === 1 ? `New load: ${laneOf(list[0])}${list[0].book_rate ? ' · Book now ' + usd(list[0].book_rate) : ''}` : `${list.length} new loads on your lanes`, html });
          const ins = db.prepare('INSERT OR IGNORE INTO alert_sends (alert_id, load_id) VALUES (?, ?)');
          for (const { L, alert } of g.loads.values()) ins.run(alert.id, L.id);
          for (const a of g.alerts) db.prepare(`UPDATE lane_alerts SET last_sent_at = datetime('now'), sent_count = sent_count + 1 WHERE id = ?`).run(a.id);
          // remember what we sent, so a reply with a rate can find the load
          db.prepare(`INSERT INTO inbox (msg_id, from_email, subject, kind, status, summary, load_ids, reply_subject, reply_html, sent_at, received_at) VALUES (?, ?, ?, 'alert_out', 'sent', ?, ?, ?, ?, datetime('now'), ?)`)
            .run('alert-' + crypto.randomBytes(8).toString('hex'), email, '(lane alert)', `Lane alert sent: ${list.map(laneOf).join('; ')}`, JSON.stringify(list.map(L => L.id)), 'Lane alert', html, now());
        } catch (e) { console.warn('[alerts] send failed:', e.message); setSetting('email_last_error', `${now()} lane alert: ${e.message}`.slice(0, 400)); }
      }
    } finally { alerting = false; }
  }

  function start() {
    setTimeout(() => poll().catch(() => {}), 15000);
    setInterval(() => poll().catch(() => {}), 2 * 60000).unref();
    setInterval(() => sendAlerts().catch(e => console.warn('[alerts]', e.message)), 2 * 60000).unref();
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
        if ('alert_days' in b) setSetting('alert_days', String(Math.max(7, Math.min(365, Number(b.alert_days) || 60))));
      }
      const t = {}; for (const k of Object.keys(TEMPLATES)) t[k] = tpl(k);
      return send(res, 200, { mode: mode(), since: getSetting('inbox_since', ''), last_check: getSetting('inbox_last_check', ''), last_error: getSetting('inbox_last_error', ''),
        configured: mailer.configured(), from: mailer.from(), templates: t, defaults: TEMPLATES, alerts_on: getSetting('alerts_on', '1') === '1', alert_days: Number(getSetting('alert_days', '60')),
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
        substr(body, 1, 1500) AS body FROM inbox WHERE ${where} ORDER BY received_at DESC, id DESC LIMIT 200`).all(...(where.includes('?') ? [st] : []));
      return send(res, 200, rows.map(r => {
        const plan = JSON.parse(r.plan || '{}');
        const loads = JSON.parse(r.load_ids || '[]').map(id => db.prepare('SELECT id, ref, public_id, origin_city, origin_state, dest_city, dest_state FROM loads WHERE id = ?').get(id)).filter(Boolean);
        return { ...r, plan: undefined, reply_preview: r.reply_html || previewReply(plan), actions: (plan.actions || []).map(a => a.type), loads, lane: r.lane ? JSON.parse(r.lane) : null,
          carrier_flag: r.mc ? (db.prepare('SELECT flag FROM carrier_profiles WHERE mc = ?').get(r.mc) || {}).flag || '' : '' };
      })), true;
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
    // lane alerts
    if (p === '/api/admin/alerts') {
      if (m === 'GET') return send(res, 200, db.prepare(`SELECT * FROM lane_alerts ORDER BY active DESC, created_at DESC LIMIT 500`).all()), true;
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

  return { adminRoutes, publicRoutes, start, poll, sendAlerts, analyze, TEMPLATES };
};
