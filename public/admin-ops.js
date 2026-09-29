// Admin working tools: tracking, carrier profiles, saved lanes, address book, paste-to-post, bulk actions, counters, reports.
// Loaded after admin.html's main script; uses its globals (api, $, $$, esc, money, toast, loads, refreshLoads, openLoad, openBids…).

let facilities = [], savedLanes = [], refsLoaded = false;
const STAGE_LIST = [['awarded', 'Awarded'], ['ratecon', 'Rate con sent (Aljex)'], ['dispatched', 'Dispatched'], ['picked_up', 'Picked up'], ['delivered', 'Delivered'], ['invoiced', 'Invoiced']];
const STAGE_SHORT = { awarded: 'Awarded', ratecon: 'Rate con sent', dispatched: 'Dispatched', picked_up: 'Picked up', delivered: 'Delivered', invoiced: 'Invoiced' };
const stageLabel = k => STAGE_SHORT[k] || 'Awarded';
const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));

function flagChip(f) {
  if (f === 'preferred') return ' <span class="chip good" style="font-size:11.5px;padding:1px 7px" title="Preferred carrier">★ Preferred</span>';
  if (f === 'dnu') return ' <span class="chip bad" style="font-size:11.5px;padding:1px 7px" title="You marked this carrier Do not use">Do not use</span>';
  return '';
}
function counterChip(c) {
  if (!c) return '';
  const cls = c.status === 'accepted' ? 'good' : c.status === 'declined' ? 'bad' : 'warn';
  const t = c.status === 'accepted' ? 'accepted' : c.status === 'declined' ? 'declined' : 'sent';
  return `<div style="margin-top:3px"><span class="chip ${cls}" style="font-size:11.5px;padding:1px 7px">Counter ${esc(money(c.amount))} ${t}</span></div>`;
}
const fmtDay = iso => iso ? new Date(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

async function refreshRefs() {
  try {
    [facilities, savedLanes] = await Promise.all([api('/api/admin/facilities'), api('/api/admin/lanes')]);
    refsLoaded = true; fillLaneQuick();
  } catch (_) { /* not signed in yet */ }
}
function fillLaneQuick() {
  const opts = savedLanes.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  $('#laneQuick').innerHTML = `<option value="">From saved lane…</option>${opts}`;
  $('#laneQuick').hidden = !savedLanes.length;
}
$('#laneQuick').onchange = e => { const lane = savedLanes.find(l => l.id === Number(e.target.value)); e.target.value = ''; if (lane) openLoadFromLane(lane); };
function openLoadFromLane(lane) {
  openLoad(null);
  applyLaneToForm(lane);
}
function applyLaneToForm(lane) {
  const f = $('#loadForm');
  Object.entries(lane.data || {}).forEach(([k, v]) => { if (f.elements[k]) f.elements[k].value = v; });
  $('#f_lane').value = String(lane.id); $('#f_lane_id').value = String(lane.id);
  $('#loadMsg').innerHTML = `<div class="notice ok">Filled from saved lane <b>${esc(lane.name)}</b>. Set the dates and bids-due time, then save.</div>`;
  f.elements.pickup_date.focus();
}

// ---------- load form extras ----------
function facOptions() { return `<option value="">—</option>` + facilities.map(x => `<option value="${x.id}">${esc(x.name)}${x.city ? ' · ' + esc(x.city) + ', ' + esc(x.state || '') : ''}</option>`).join(''); }
async function onOpenLoad(v, isEdit) {
  if (!refsLoaded) await refreshRefs();
  $('#f_lane').innerHTML = `<option value="">— saved lane —</option>` + savedLanes.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  $('#f_origin_fac').innerHTML = facOptions(); $('#f_dest_fac').innerHTML = facOptions();
  $('#pasteBox').hidden = true; $('#pasteText').value = ''; $('#pasteMsg').textContent = '';
  $('#starter').hidden = !!isEdit;
  const custs = [...new Set(loads.map(l => l.customer).filter(Boolean))].sort();
  $('#custList').innerHTML = custs.map(c => `<option value="${esc(c)}">`).join('');
}
$('#f_lane').onchange = e => { const lane = savedLanes.find(l => l.id === Number(e.target.value)); if (lane) applyLaneToForm(lane); };
['origin', 'dest'].forEach(side => {
  $(`#f_${side}_fac`).onchange = e => {
    const x = facilities.find(f => f.id === Number(e.target.value)); if (!x) return;
    const f = $('#loadForm');
    f.elements[side + '_name'].value = x.name || ''; f.elements[side + '_address'].value = x.address || '';
    f.elements[side + '_city'].value = x.city || ''; f.elements[side + '_state'].value = x.state || ''; f.elements[side + '_zip'].value = x.zip || '';
    const win = f.elements[side === 'origin' ? 'pickup_window' : 'delivery_window'];
    if (x.hours && !win.value) win.value = x.hours;
  };
});
$$('[data-savefac]').forEach(b => b.onclick = async () => {
  const side = b.dataset.savefac, f = $('#loadForm');
  const body = { name: f.elements[side + '_name'].value.trim(), address: f.elements[side + '_address'].value, city: f.elements[side + '_city'].value,
    state: f.elements[side + '_state'].value, zip: f.elements[side + '_zip'].value, hours: f.elements[side === 'origin' ? 'pickup_window' : 'delivery_window'].value };
  if (!body.name) { toast(`Type the ${side === 'origin' ? 'shipper' : 'receiver'} name first`); f.elements[side + '_name'].focus(); return; }
  try { await api('/api/admin/facilities', { method: 'POST', body }); await refreshRefs(); $('#f_origin_fac').innerHTML = facOptions(); $('#f_dest_fac').innerHTML = facOptions(); toast('Saved to address book'); }
  catch (e) { toast(e.message); }
});
$('#saveLaneBtn').onclick = async () => {
  const f = $('#loadForm'); const data = {};
  LANE_KEYS.forEach(([k]) => { if (f.elements[k] && f.elements[k].value.trim()) data[k] = f.elements[k].value.trim(); });
  if (!data.origin_city && !data.origin_state) { toast('Fill in the lane first'); return; }
  const name = prompt('Name this lane:', `${data.origin_city || data.origin_state || ''} → ${data.dest_city || data.dest_state || ''}${data.customer ? ' (' + data.customer + ')' : ''}`);
  if (!name) return;
  try { await api('/api/admin/lanes', { method: 'POST', body: { name, data } }); await refreshRefs(); toast('Lane saved — find it under Lanes & places'); }
  catch (e) { toast(e.message); }
};

// ---------- paste to post ----------
$('#pasteToggle').onclick = () => { $('#pasteBox').hidden = !$('#pasteBox').hidden; if (!$('#pasteBox').hidden) $('#pasteText').focus(); };
$('#pasteFill').onclick = () => {
  const r = parseTender($('#pasteText').value);
  const f = $('#loadForm'); const filled = [];
  Object.entries(r).forEach(([k, v]) => { if (v != null && v !== '' && f.elements[k]) { f.elements[k].value = v; filled.push(k); } });
  const names = { origin_city: 'pickup', dest_city: 'delivery', pickup_date: 'pickup date', delivery_date: 'delivery date', weight: 'weight', pallets: 'pallets', equipment: 'equipment', temp: 'temp', ref: 'load #', customer_rate: 'rate', commodity: 'commodity', pickup_window: 'pickup time', delivery_window: 'delivery time', origin_name: 'shipper', dest_name: 'receiver' };
  const got = filled.filter(k => names[k]).map(k => names[k]);
  $('#pasteMsg').textContent = got.length ? `Filled: ${got.join(', ')}. Check everything before saving.` : 'Couldn\'t find load details in that text.';
};
function parseTender(text) {
  const t = String(text || '').replace(/\r/g, '');
  const out = {};
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  // City, ST 12345 (or City ST 12345) — first is pickup, next is delivery, unless labeled
  const locRe = /([A-Za-z][A-Za-z .'-]{1,40}?),?\s+([A-Z]{2})\b[ ,]*(\d{5})?(?:-\d{4})?/g;
  const locs = [];
  lines.forEach((ln, i) => {
    let m; locRe.lastIndex = 0;
    while ((m = locRe.exec(ln))) {
      if (!US_STATES.has(m[2])) continue;
      const city = m[1].replace(/^(.*\b(to|from|at|in|pickup|pick up|pu|delivery|deliver|del|dest|destination|origin|shipper|consignee|receiver|stop \d+)\b[:\s-]*)/i, '').trim();
      if (!city || city.length < 2 || /^\d/.test(city)) continue;
      const ctx = (lines[i - 1] || '') + ' ' + ln;
      locs.push({ city: titleCase(city), state: m[2], zip: m[3] || '', i, pick: /\b(pick ?up|pu|shipper|origin|from|ship from)\b/i.test(ctx), drop: /\b(deliver|delivery|del|consignee|receiver|dest|destination|to|ship to|drop)\b/i.test(ln) || /\b(deliver|consignee|receiver|ship to|drop)\b/i.test(lines[i - 1] || '') });
    }
  });
  const o = locs.find(x => x.pick && !x.drop) || locs[0];
  const d = locs.find(x => x !== o && x.drop) || locs.find(x => x !== o);
  if (o) Object.assign(out, { origin_city: o.city, origin_state: o.state, origin_zip: o.zip });
  if (d) Object.assign(out, { dest_city: d.city, dest_state: d.state, dest_zip: d.zip });
  // facility names: the line right before an address, or "Shipper: X"
  const lab = (re) => { for (const ln of lines) { const m = ln.match(re); if (m && m[1].trim()) return m[1].trim().slice(0, 80); } return ''; };
  out.origin_name = lab(/^(?:shipper|pick ?up (?:at|location)|origin|ship from)\s*[:#-]\s*(.+)$/i);
  out.dest_name = lab(/^(?:consignee|receiver|deliver(?:y)? (?:to|location)|ship to)\s*[:#-]\s*(.+)$/i);
  // a street line (starts with a number) right after the shipper / consignee line
  const street = re => { const i = lines.findIndex(ln => re.test(ln)); const nx = i >= 0 ? lines[i + 1] || '' : ''; return /^\d{1,6}\s+\S/.test(nx) && !/\b[A-Z]{2}\s+\d{5}\b/.test(nx) ? nx.slice(0, 120) : ''; };
  out.origin_address = street(/^(?:shipper|pick ?up (?:at|location)|origin|ship from)\s*[:#-]/i);
  out.dest_address = street(/^(?:consignee|receiver|deliver(?:y)? (?:to|location)|ship to)\s*[:#-]/i);
  // dates
  const yr = new Date().getFullYear();
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const dateIn = s => {
    let m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (m) { const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : yr; return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; }
    m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i);
    if (m) return `${m[3] || yr}-${String(MON[m[1].toLowerCase()]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/); if (m) return m[0];
    return '';
  };
  const timeIn = s => { const m = s.match(/\b(\d{1,2}:?\d{2})\s*(?:-|–|to)\s*(\d{1,2}:?\d{2})\b/) || s.match(/\b(?:appt|appointment|@|at)\s*(\d{1,2}:\d{2}\s*(?:am|pm)?)/i); return m ? (m[2] ? `${m[1]}–${m[2]}` : 'Appt ' + m[1]) : ''; };
  let pu = '', del = '';
  for (const ln of lines) {
    const dt = dateIn(ln); if (!dt) continue;
    if (!pu && /\b(pick ?up|pu|ship|load(?:ing)? date|ready)\b/i.test(ln)) { pu = dt; out.pickup_window = timeIn(ln); }
    else if (!del && /\b(deliver|delivery|del|due|drop|appt)\b/i.test(ln)) { del = dt; out.delivery_window = timeIn(ln); }
  }
  if (!pu || !del) { const all = lines.map(dateIn).filter(Boolean); if (!pu) pu = all[0] || ''; if (!del) del = all.find(x => x !== pu) || ''; }
  out.pickup_date = pu; out.delivery_date = del;
  let m;
  if ((m = t.match(/\b(\d{1,2},?\d{3})\s*(?:lbs?|pounds|#)\b/i) || t.match(/\bweight\s*[:#-]?\s*(\d{1,2},?\d{3})/i))) out.weight = m[1].replace(/,/g, '');
  if ((m = t.match(/\b(\d{1,2})\s*(?:pallets?|plts?|skids?|pl)\b/i) || t.match(/\bpallets?\s*[:#-]?\s*(\d{1,2})\b/i))) out.pallets = m[1];
  if ((m = t.match(/(-?\d{1,2})\s*°?\s*(?:degrees\s*)?F\b/))) out.temp = `${m[1]}°F`;
  if (/reefer|refrigerated|temp controlled/i.test(t)) out.equipment = "53' Reefer";
  else if (/flat ?bed/i.test(t)) out.equipment = "48' Flatbed";
  else if (/step ?deck/i.test(t)) out.equipment = 'Step Deck';
  else if (/\bvan\b|dry van/i.test(t)) out.equipment = "53' Dry Van";
  if ((m = t.match(/\b(?:load|order|po|ref(?:erence)?|shipment|bol)\s*(?:#|no\.?|number)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{2,20})\b/i)) && /\d/.test(m[1])) out.ref = m[1];
  if ((m = t.match(/\$\s?(\d{1,2},?\d{3}(?:\.\d{2})?)/))) out.customer_rate = m[1].replace(/,/g, '');
  if ((m = t.match(/\b(?:commodity|product|description)\s*[:#-]\s*(.+)/i))) out.commodity = m[1].trim().slice(0, 80);
  return out;
}
function titleCase(s) { return s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()); }

// ---------- bulk actions ----------
function renderBulk() {
  // drop selections that no longer exist
  [...selected].forEach(id => { if (!loads.find(l => l.id === id)) selected.delete(id); });
  $('#bulkbar').hidden = !selected.size;
  $('#bulkCount').textContent = `${selected.size} selected`;
}
$('#loadTable').addEventListener('change', e => {
  const x = e.target.closest('[data-sel]'); if (!x) return;
  const id = Number(x.dataset.sel); x.checked ? selected.add(id) : selected.delete(id);
  x.closest('tr').classList.toggle('sel', x.checked); renderBulk();
  const sa = $('#selAll'); if (sa) sa.checked = false;
});
$('#bulkClear').onclick = () => { selected.clear(); renderLoads(); };
$$('[data-bulk]').forEach(b => b.onclick = async () => {
  const action = b.dataset.bulk, ids = [...selected];
  const body = { ids, action };
  if (action === 'deadline') { const v = $('#bulkDeadline').value; if (!v) { toast('Pick a date and time first'); $('#bulkDeadline').focus(); return; } body.deadline = new Date(v).toISOString(); }
  if (action === 'delete' && !confirm(`Delete ${ids.length} load(s) and all their bids? This can't be undone.`)) return;
  if (action !== 'delete' && action !== 'deadline' && !confirm(`${b.textContent} for ${ids.length} load(s)? Awarded loads are skipped.`)) return;
  const r = await api('/api/admin/loads/bulk', { method: 'POST', body });
  toast(`${r.changed} load${r.changed === 1 ? '' : 's'} updated`); if (action === 'delete') selected.clear();
  refreshLoads();
});

// ---------- counter offers ----------
async function sendCounter(b, l) {
  if (b.dataset.email !== '1') { toast('This carrier left no email — call them with your counter instead'); return; }
  const amt = prompt(`Counter offer (all-in $). Their bid is ${money(Number(b.dataset.amt))}:`, '');
  if (!amt) return;
  const message = prompt('Optional note to the carrier (leave blank for none):', '') || '';
  try { await api(`/api/admin/bids/${b.dataset.counter}/counter`, { method: 'POST', body: { amount: amt, message } }); toast('Counter sent — you\'ll get an email when they answer'); renderBids(l.id); }
  catch (e) { toast(e.message); }
}

// ---------- tracking ----------
let trk = { loads: [] };
async function loadTracking() { trk = await api('/api/admin/tracking'); renderTracking(); }
$('#trkSearch').oninput = () => renderTracking(); $('#trkFilter').onchange = () => renderTracking();
function stageDots(l) {
  const cur = STAGE_LIST.findIndex(s => s[0] === (l.stage || 'awarded'));
  return `<div class="dots" title="${esc(stageLabel(l.stage))}">${STAGE_LIST.map((s, i) => `<i class="${i <= cur ? 'on' : ''}"></i>`).join('')}</div><div class="sm"><b>${esc(stageLabel(l.stage))}</b></div>`;
}
function renderTracking() {
  const q = $('#trkSearch').value.trim().toLowerCase(), all = $('#trkFilter').value === 'all';
  const list = trk.loads.filter(l => (all || l.stage !== 'invoiced') && (!q || [l.ref, l.aljex_pro, l.public_id, l.origin_city, l.origin_state, l.dest_city, l.dest_state, l.carrier, l.carrier_mc, l.customer].join(' ').toLowerCase().includes(q)));
  const count = k => trk.loads.filter(l => (l.stage || 'awarded') === k).length;
  $('#trkStats').innerHTML = STAGE_LIST.map(([k, lab]) => `<div class="stat"><b>${count(k)}</b><span>${esc(lab)}</span></div>`).join('');
  if (!list.length) { $('#trkTable').innerHTML = `<tbody><tr><td class="empty">${trk.loads.length ? 'Nothing matches.' : 'No awarded loads yet. When you award a bid, the load shows up here to track through delivery and invoicing.'}</td></tr></tbody>`; return; }
  $('#trkTable').innerHTML = `<thead><tr><th>Load</th><th>Dates</th><th>Carrier</th><th class="num">Carrier · customer</th><th>Stage</th><th>Latest</th><th></th></tr></thead><tbody>` +
    list.map(l => {
      const margin = l.customer_rate && l.carrier_rate ? l.customer_rate - l.carrier_rate : null;
      const needsRc = (l.stage || 'awarded') === 'awarded';
      return `<tr>
      <td><div class="lane" style="font-size:15px">${esc(place(l.origin_city, l.origin_state))} <span class="arrow">→</span> ${esc(place(l.dest_city, l.dest_state))}</div>
        <div class="muted sm">${l.aljex_pro ? 'Pro <b class="mono">' + esc(l.aljex_pro) + '</b> · ' : ''}${l.ref ? '#' + esc(l.ref) : esc(l.public_id)}${l.customer ? ' · ' + esc(l.customer) : ''}</div></td>
      <td style="white-space:nowrap" class="sm">PU ${esc(fmtDate(l.pickup_date) || '—')}<br>DEL ${esc(fmtDate(l.delivery_date) || '—')}</td>
      <td><b>${esc(l.carrier || '')}</b><div class="muted sm mono">MC ${esc(l.carrier_mc || '')}</div><div class="sm">${esc(l.carrier_phone || '')}</div></td>
      <td class="num">${esc(money(l.carrier_rate))}<div class="muted sm">${l.customer_rate ? esc(money(l.customer_rate)) : 'no customer rate'}</div>${margin != null ? `<div class="sm" style="color:${margin >= 0 ? 'var(--good)' : 'var(--bad)'}">${margin >= 0 ? '+' : '−'}${esc(money(Math.abs(margin)))}</div>` : ''}</td>
      <td>${stageDots(l)}${needsRc ? '<div class="sm" style="color:var(--amber);font-weight:600">Send rate con in Aljex</div>' : ''}</td>
      <td class="sm" style="max-width:220px">${l.last_note ? esc(l.last_note.split(' · ')[0]).slice(0, 90) : '<span class="muted">—</span>'}${l.doc_count ? `<div class="muted">📎 ${l.doc_count} doc${l.doc_count === 1 ? '' : 's'}</div>` : ''}</td>
      <td><button class="btn sm primary" data-file="${l.id}">Open</button></td></tr>`;
    }).join('') + '</tbody>';
}
$('#trkTable').onclick = e => { const b = e.target.closest('[data-file]'); if (b) openFile(Number(b.dataset.file)); };

async function openFile(id) {
  $('#fileBody').innerHTML = '<div class="muted">Loading…</div>';
  if (!$('#fileDlg').open) $('#fileDlg').showModal();
  const d = await api(`/api/admin/loads/${id}/file`);
  const l = d.load, w = d.winner;
  $('#fileTitle').textContent = `${place(l.origin_city, l.origin_state)} → ${place(l.dest_city, l.dest_state)}`;
  const curIdx = STAGE_LIST.findIndex(s => s[0] === (l.stage || (l.status === 'awarded' ? 'awarded' : '')));
  const margin = l.customer_rate && w ? l.customer_rate - w.amount : null;
  $('#fileBody').innerHTML = `
    <div class="filehead">
      <div><span>Load</span><b>${l.ref ? '#' + esc(l.ref) : esc(l.public_id)}</b><small>PU ${esc(fmtDate(l.pickup_date) || '—')}${l.pickup_window ? ' ' + esc(l.pickup_window) : ''} · DEL ${esc(fmtDate(l.delivery_date) || '—')}${l.delivery_window ? ' ' + esc(l.delivery_window) : ''}</small>
        <small>${esc([l.origin_name, l.origin_address].filter(Boolean).join(', '))}${l.dest_name || l.dest_address ? ' → ' + esc([l.dest_name, l.dest_address].filter(Boolean).join(', ')) : ''}</small></div>
      <div><span>Carrier</span>${w ? `<b><button class="linkbtn" data-cp="${esc(w.mc)}" style="font-size:inherit;text-decoration:none;color:inherit">${esc(w.company)}</button></b><small class="mono">MC ${esc(w.mc)}</small><small>${esc([w.contact_name, w.phone, w.email].filter(Boolean).join(' · '))}</small>` : '<b class="muted">Not awarded</b>'}</div>
      <div><span>Rates</span><b class="mono">${w ? esc(money(w.amount)) : '—'}${w ? ` <button class="linkbtn sm" type="button" id="fl_rateEdit" style="font-family:var(--body)">edit</button>` : ''}</b><small>carrier${l.miles && w ? ' · $' + (w.amount / l.miles).toFixed(2) + '/mi' : ''}</small>
        ${margin != null ? `<small style="color:${margin >= 0 ? 'var(--good)' : 'var(--bad)'};font-weight:700">Margin ${margin >= 0 ? '+' : '−'}${esc(money(Math.abs(margin)))} (${Math.round(margin / l.customer_rate * 100)}%)</small>` : ''}</div>
    </div>
    <div class="grid g4">
      <div class="field"><label for="fl_pro">Aljex Pro #</label><input id="fl_pro" value="${esc(l.aljex_pro || '')}"></div>
      <div class="field"><label for="fl_cust">Customer</label><input id="fl_cust" value="${esc(l.customer || '')}"></div>
      <div class="field"><label for="fl_rate">Customer rate $</label><input id="fl_rate" inputmode="decimal" value="${l.customer_rate ?? ''}"></div>
      <div class="field" style="align-self:end"><button class="btn" type="button" id="fl_save">Save</button></div>
    </div>
    ${l.status === 'awarded' ? `<div><div class="muted sm" style="margin-bottom:6px">Click the next step when it's done. Click a finished step to undo it.</div><div class="stepper">${STAGE_LIST.map(([k, lab], i) => {
      const at = l.stage_dates[k];
      return `<button type="button" class="step ${at ? 'done' : ''} ${i === curIdx + 1 ? 'next' : ''}" data-stage="${k}" data-label="${esc(lab)}" data-done="${at ? 1 : 0}"><b>${at ? '✓ ' : ''}${esc(lab)}</b><small>${at ? esc(fmtDateTime(at)) : i === curIdx + 1 ? 'Mark done' : ''}</small></button>`;
    }).join('')}</div>${curIdx === 0 ? '<div class="notice warn" style="margin-top:8px">Next: send the rate confirmation from Aljex (Pro # above), then mark <b>Rate con sent</b>.</div>' : ''}</div>`
      : '<div class="notice">Tracking steps start when the load is awarded.</div>'}
    <div class="grid g2" style="align-items:start">
      <div class="panel" style="padding:14px">
        <h3 style="font-size:18px;margin-bottom:8px">Notes &amp; check calls</h3>
        <div class="actions" style="align-items:stretch;flex-wrap:nowrap"><select id="fl_kind" style="width:auto"><option value="call">Check call</option><option value="note">Note</option></select>
          <input id="fl_note" placeholder="Driver loaded, ETA Wed 10:00…"><button class="btn primary" type="button" id="fl_add">Add</button></div>
        <ul class="notelist">${d.notes.map(n => `<li class="${n.kind}"><span class="k">${n.kind === 'call' ? '📞' : n.kind === 'stage' ? '●' : '✎'}</span><div>${esc(n.text)}<small>${esc(fmtDateTime(n.created_at))}</small></div>${n.kind !== 'stage' ? `<button class="x" data-delnote="${n.id}" title="Delete note" aria-label="Delete note">×</button>` : ''}</li>`).join('') || '<li class="muted">No notes yet.</li>'}</ul>
      </div>
      <div class="panel" style="padding:14px">
        <h3 style="font-size:18px;margin-bottom:8px">Documents</h3>
        <div class="actions" style="align-items:center"><select id="fl_dkind" style="width:auto">${d.doc_kinds.map(k => `<option>${esc(k)}</option>`).join('')}</select><input type="file" id="fl_file" style="width:auto;flex:1"></div>
        <div class="muted sm" style="margin-top:4px">PDF, photo or any file up to 12 MB (BOL, POD, signed rate con from Aljex…)</div>
        <ul class="doclist">${d.docs.map(x => `<li><span class="chip" style="font-size:11.5px;padding:1px 7px">${esc(x.kind)}</span> <a href="/api/admin/docs/${x.id}" target="_blank" rel="noopener">${esc(x.filename)}</a> <small class="muted">${Math.max(1, Math.round(x.size / 1024))} KB · ${esc(fmtDay(x.created_at))}</small><button class="x" data-deldoc="${x.id}" title="Delete" aria-label="Delete document">×</button></li>`).join('') || '<li class="muted">No documents yet.</li>'}</ul>
      </div>
    </div>`;
  const b = $('#fileBody');
  $('#fl_save').onclick = async () => { await api(`/api/admin/loads/${id}/stage`, { method: 'PUT', body: { aljex_pro: $('#fl_pro').value, customer: $('#fl_cust').value, customer_rate: $('#fl_rate').value } }); toast('Saved'); openFile(id); afterFileChange(); };
  $$('[data-stage]', b).forEach(x => x.onclick = async () => {
    const done = x.dataset.done === '1';
    if (done && !confirm(`Undo "${x.dataset.label}" and the steps after it?`)) return;
    await api(`/api/admin/loads/${id}/stage`, { method: 'PUT', body: { stage: x.dataset.stage, undo: done } });
    openFile(id); afterFileChange();
  });
  const add = async () => { const text = $('#fl_note').value.trim(); if (!text) return; await api(`/api/admin/loads/${id}/notes`, { method: 'POST', body: { kind: $('#fl_kind').value, text } }); openFile(id); afterFileChange(); };
  $('#fl_add').onclick = add; $('#fl_note').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  $$('[data-delnote]', b).forEach(x => x.onclick = async () => { if (!confirm('Delete this note?')) return; await api(`/api/admin/notes/${x.dataset.delnote}`, { method: 'DELETE' }); openFile(id); });
  $$('[data-deldoc]', b).forEach(x => x.onclick = async () => { if (!confirm('Delete this document?')) return; await api(`/api/admin/docs/${x.dataset.deldoc}`, { method: 'DELETE' }); openFile(id); afterFileChange(); });
  $('#fl_file').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 12 * 1024 * 1024) { toast('Files can be up to 12 MB'); return; }
    toast('Uploading…');
    try { await api(`/api/admin/loads/${id}/docs`, { method: 'POST', body: { kind: $('#fl_dkind').value, filename: file.name, mime: file.type, data: await fileToBase64(file) } }); toast('Uploaded'); openFile(id); afterFileChange(); }
    catch (err) { toast(err.message); }
  };
  $$('[data-cp]', b).forEach(x => x.onclick = () => openCarrier(x.dataset.cp));
  const re = $('#fl_rateEdit'); if (re) re.onclick = () => editRate(w.id, w.amount, w.company, () => { openFile(id); afterFileChange(); });
}
function afterFileChange() { if (!$('[data-pane="tracking"]').hidden) loadTracking(); refreshLoads(); }

// ---------- carrier profiles ----------
let cps = [];
async function loadProfiles() { cps = await api('/api/admin/carrier-profiles'); renderProfiles(); }
$('#cpSearch').oninput = () => renderProfiles(); $('#cpFilter').onchange = () => renderProfiles();
function renderProfiles() {
  const q = $('#cpSearch').value.trim().toLowerCase(), f = $('#cpFilter').value;
  const list = cps.filter(c => (!q || [c.company, c.mc, c.highway_name].join(' ').toLowerCase().includes(q)) &&
    (!f || (f === 'pass' ? c.highway_pass : f === 'fail' ? !c.highway_pass : c.flag === f)))
    .sort((a, b) => ((b.flag === 'preferred') - (a.flag === 'preferred')) || (b.wins - a.wins) || (b.bids - a.bids));
  if (!list.length) { $('#cpTable').innerHTML = `<tbody><tr><td class="empty">${cps.length ? 'No carriers match.' : 'No carriers yet. Everyone who bids shows up here.'}</td></tr></tbody>`; return; }
  $('#cpTable').innerHTML = `<thead><tr><th>Carrier</th><th>Highway</th><th>Lanes bid</th><th class="num">Bids</th><th class="num">Won</th><th>Last bid</th><th></th></tr></thead><tbody>` +
    list.map(c => `<tr style="${c.flag === 'dnu' ? 'opacity:.65' : ''}">
      <td><b>${esc(c.company || c.highway_name || '—')}</b>${flagChip(c.flag)}${c.manual ? ' <span class="chip" style="font-size:11px;padding:0 6px">Added by you</span>' : ''}<div class="mono muted sm">${c.manual && String(c.mc).startsWith('email:') ? esc(c.email) : 'MC ' + esc(c.mc)}${c.hq_state ? ' · based ' + esc(c.hq_state) : ''}</div>${c.notes ? `<div class="sm muted" style="max-width:320px">${esc(c.notes.slice(0, 90))}</div>` : ''}</td>
      <td>${c.highway_pass ? '<span class="chip good">✓ Pass</span>' : '<span class="chip bad">✗ Not on list</span>'}</td>
      <td>${c.lanes.slice(0, 5).map(x => `<span class="lanetag">${esc(x.o)}→${esc(x.d)}${x.n > 1 ? ' ×' + x.n : ''}</span>`).join(' ') || '<span class="muted">—</span>'}${c.lanes.length > 5 ? ` <span class="muted">+${c.lanes.length - 5}</span>` : ''}</td>
      <td class="num">${c.bids}</td><td class="num">${c.wins || 0}</td>
      <td class="sm" style="white-space:nowrap">${c.last_bid ? esc(fmtDay(c.last_bid)) : '—'}</td>
      <td><button class="btn sm" data-cp="${esc(c.manual ? 'email:' + c.email : c.mc)}">Open</button></td></tr>`).join('') + '</tbody>';
}
$('#cpTable').onclick = e => { const b = e.target.closest('[data-cp]'); if (b) openCarrier(b.dataset.cp); };
async function openCarrier(mc) {
  $('#cpBody').innerHTML = '<div class="muted">Loading…</div>';
  if (!$('#cpDlg').open) $('#cpDlg').showModal();
  const c = await api(`/api/admin/carrier-profiles/${encodeURIComponent(mc)}`);
  $('#cpTitle').textContent = c.company || 'MC ' + c.mc;
  const won = c.bids.filter(b => b.status === 'awarded').length;
  $('#cpBody').innerHTML = `
    <div class="filehead">
      <div><span>MC</span><b class="mono">${esc(c.mc)}</b><small>${c.highway ? '<span style="color:var(--good);font-weight:700">✓ On Highway list</span>' + (c.highway.name ? ' · ' + esc(c.highway.name) : '') : '<span style="color:var(--bad);font-weight:700">✗ Not on Highway list</span>'}</small>
        ${c.highway ? `<small>${esc([c.highway.phone, c.highway.email].filter(Boolean).join(' · '))}${c.highway.hq_state ? ' · based ' + esc(c.highway.hq_state) : ''}</small>` : ''}</div>
      <div><span>History</span><b>${c.bids.length} bid${c.bids.length === 1 ? '' : 's'} · ${won} won</b><small>${c.bids[0] ? 'Last bid ' + esc(fmtDay(c.bids[0].updated_at)) : ''}</small></div>
    </div>
    <div class="grid g3" style="align-items:start">
      <div class="field"><label for="cp_flag">Flag</label><select id="cp_flag"><option value="">None</option><option value="preferred" ${c.flag === 'preferred' ? 'selected' : ''}>★ Preferred</option><option value="dnu" ${c.flag === 'dnu' ? 'selected' : ''}>Do not use</option></select></div>
      <div class="field" style="grid-column:span 2"><label for="cp_notes">Notes <span class="hint">(private)</span></label><textarea id="cp_notes" rows="2">${esc(c.notes)}</textarea></div>
    </div>
    <div><button class="btn primary" type="button" id="cp_save">Save</button> <span class="muted sm">"Do not use" carriers are skipped by the automatic lane-matched daily email and get a warning when you award.</span></div>
    ${c.contacts.length ? `<div><h3 style="font-size:17px;margin-bottom:6px">Contacts used on bids</h3>${c.contacts.map(x => `<div class="sm">${esc([x.name, x.phone, x.email].filter(Boolean).join(' · '))}</div>`).join('')}</div>` : ''}
    <div class="panel table-wrap"><table class="data"><thead><tr><th>Load</th><th>Pickup</th><th class="num">Bid</th><th class="num">$/mi</th><th>Result</th></tr></thead><tbody>
      ${c.bids.map(b => `<tr><td><div class="lane" style="font-size:14.5px">${esc(place(b.origin_city, b.origin_state))} <span class="arrow">→</span> ${esc(place(b.dest_city, b.dest_state))}</div><div class="muted sm">${b.ref ? '#' + esc(b.ref) : esc(b.public_id)}</div></td>
        <td class="sm">${esc(fmtDate(b.pickup_date) || '—')}</td><td class="num">${esc(money(b.amount))}</td><td class="num">${b.miles ? '$' + (b.amount / b.miles).toFixed(2) : '—'}</td>
        <td>${b.status === 'awarded' ? '<span class="status awarded">Won</span>' : b.load_status === 'awarded' ? '<span class="muted sm">Lost</span>' : b.load_status === 'open' ? '<span class="status open">Open</span>' : '<span class="muted sm">Closed</span>'}</td></tr>`).join('') || '<tr><td class="empty" colspan="5">No bids.</td></tr>'}
    </tbody></table></div>`;
  $('#cp_save').onclick = async () => {
    await api(`/api/admin/carrier-profiles/${encodeURIComponent(mc)}`, { method: 'PUT', body: { flag: $('#cp_flag').value, notes: $('#cp_notes').value } });
    toast('Carrier saved'); if (!$('[data-pane="profiles"]').hidden) loadProfiles();
    if ($('#bidsDlg').open && openBidsId) renderBids(openBidsId);
  };
}
let openBidsId = null;
const _openBids = openBids;
openBids = async function (l) { openBidsId = l.id; return _openBids(l); };

// ---------- saved lanes ----------
const LANE_KEYS = [['origin_name', 'Shipper name'], ['origin_address', 'Shipper address'], ['origin_city', 'Origin city'], ['origin_state', 'Origin state'], ['origin_zip', 'Origin ZIP'],
  ['dest_name', 'Receiver name'], ['dest_address', 'Receiver address'], ['dest_city', 'Dest city'], ['dest_state', 'Dest state'], ['dest_zip', 'Dest ZIP'],
  ['pickup_window', 'Pickup window'], ['delivery_window', 'Delivery window'], ['equipment', 'Equipment'], ['temp', 'Temp'], ['weight', 'Weight (lb)'], ['pallets', 'Pallets'],
  ['commodity', 'Commodity'], ['stops', 'Extra stops'], ['miles', 'Miles'], ['customer', 'Customer'], ['customer_rate', 'Customer rate $'], ['target_rate', 'Target carrier rate $'], ['post_rate', 'Rate to post $ (shown to carriers)'],
  ['requirements', 'Requirements (shown to carriers)'], ['notes', 'Notes (shown to carriers)']];
let editingLane = null;
async function loadLanesTab() { await refreshRefs(); renderLanes(); renderFacs(); }
function repeatText(l) {
  if (!l.repeat_on) return '<span class="muted">Manual</span>';
  const days = String(l.repeat_days).split(',').map(Number);
  const dtxt = days.length === 7 ? 'Every day' : days.join(',') === '1,2,3,4,5' ? 'Weekdays' : days.map(d => DAYS[d]).join(', ');
  return `<b>${esc(dtxt)}</b> ${esc(l.repeat_time)}<div class="muted sm">PU +${l.repeat_pickup_days}d · bids due ${l.repeat_bid_hours}h</div>`;
}
function renderLanes() {
  if (!savedLanes.length) { $('#laneTable').innerHTML = '<tbody><tr><td class="empty">No saved lanes yet. Fill in a load, then click <b>Save as lane</b> — or click <b>+ New lane</b>.</td></tr></tbody>'; return; }
  $('#laneTable').innerHTML = `<thead><tr><th>Lane</th><th>Details</th><th>Posting</th><th>Last posted</th><th></th></tr></thead><tbody>` +
    savedLanes.map(l => { const d = l.data || {}; return `<tr>
      <td><b>${esc(l.name)}</b><div class="lane" style="font-size:14px">${esc(place(d.origin_city, d.origin_state, d.origin_zip))} <span class="arrow">→</span> ${esc(place(d.dest_city, d.dest_state, d.dest_zip))}</div></td>
      <td class="sm">${esc([d.equipment, d.commodity, d.weight ? Number(d.weight).toLocaleString() + ' lb' : ''].filter(Boolean).join(' · '))}<div class="muted">${esc([d.customer, d.customer_rate ? money(d.customer_rate) : ''].filter(Boolean).join(' · '))}</div></td>
      <td class="sm">${repeatText(l)}</td>
      <td class="sm">${l.last_posted ? esc(fmtDate(l.last_posted)) : '—'}</td>
      <td><div class="actions" style="flex-wrap:nowrap;gap:6px"><button class="btn sm primary" data-lpost="${l.id}" title="Post a load now with the lane's schedule settings">Post now</button><button class="btn sm" data-luse="${l.id}" title="Open a new load pre-filled from this lane">Use</button><button class="btn sm" data-ledit="${l.id}">Edit</button></div></td></tr>`; }).join('') + '</tbody>';
}
$('#laneTable').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  const lane = savedLanes.find(l => l.id === Number(b.dataset.lpost || b.dataset.luse || b.dataset.ledit)); if (!lane) return;
  if (b.dataset.lpost) {
    const d = lane.data || {};
    if (!confirm(`Post "${lane.name}" now?\n\nPickup ${lane.repeat_pickup_days} day(s) from today, bids due in ${lane.repeat_bid_hours} hours. You can edit it afterwards.`)) return;
    const L = await api(`/api/admin/lanes/${lane.id}/post`, { method: 'POST' }); toast('Load posted'); await refreshRefs(); renderLanes(); refreshLoads();
  }
  if (b.dataset.luse) { $$('.tabs button').find(x => x.dataset.tab === 'loads').click(); openLoadFromLane(lane); }
  if (b.dataset.ledit) openLane(lane);
};
$('#newLane').onclick = () => openLane(null);
function openLane(l) {
  editingLane = l;
  $('#laneTitle').textContent = l ? 'Edit lane' : 'New saved lane';
  $('#ln_name').value = l ? l.name : '';
  const d = (l && l.data) || {};
  $('#laneFields').innerHTML = LANE_KEYS.map(([k, lab]) => `<div class="field" style="${/address|requirements|notes|name/.test(k) ? 'grid-column:span 2' : ''}"><label for="lnf_${k}">${esc(lab)}</label><input id="lnf_${k}" value="${esc(d[k] ?? '')}"></div>`).join('');
  $('#ln_repeat').checked = !!(l && l.repeat_on);
  const days = String(l ? l.repeat_days : '1,2,3,4,5').split(',').map(Number);
  $('#ln_days').innerHTML = DAYS.map((n, i) => `<label class="daychip"><input type="checkbox" value="${i}" ${days.includes(i) ? 'checked' : ''}> ${n}</label>`).join('');
  $('#ln_time').value = l ? l.repeat_time : '07:00';
  $('#ln_pu').value = l ? l.repeat_pickup_days : 1; $('#ln_tr').value = l ? (l.repeat_transit_days ?? '') : 1; $('#ln_bh').value = l ? l.repeat_bid_hours : 24;
  $('#laneDel').hidden = !l;
  $('#laneDlg').showModal();
}
$('#laneForm').onsubmit = async e => {
  e.preventDefault();
  const data = {}; LANE_KEYS.forEach(([k]) => { const v = $('#lnf_' + k).value.trim(); if (v) data[k] = k.endsWith('_state') ? v.toUpperCase() : v; });
  const body = { name: $('#ln_name').value, data, repeat_on: $('#ln_repeat').checked, repeat_days: $$('#ln_days input:checked').map(x => x.value).join(','),
    repeat_time: $('#ln_time').value, repeat_pickup_days: $('#ln_pu').value, repeat_transit_days: $('#ln_tr').value.trim(), repeat_bid_hours: $('#ln_bh').value };
  if (body.repeat_on && !body.repeat_days) { toast('Pick at least one day'); return; }
  const wasNew = !editingLane;
  const savedLane = await api(editingLane ? `/api/admin/lanes/${editingLane.id}` : '/api/admin/lanes', { method: editingLane ? 'PUT' : 'POST', body });
  $('#laneDlg').close(); await refreshRefs(); renderLanes();
  if (wasNew) { toast('Lane saved — now add the carriers who run it'); openLane(savedLane); }
  else toast(body.repeat_on ? 'Lane saved — it will post itself on schedule' : 'Lane saved');
};
$('#laneDel').onclick = async () => { if (!confirm(`Delete lane "${editingLane.name}"? Loads already posted from it are kept.`)) return; await api(`/api/admin/lanes/${editingLane.id}`, { method: 'DELETE' }); $('#laneDlg').close(); await refreshRefs(); renderLanes(); };

// ---------- address book ----------
let editingFac = null;
$('#facSearch').oninput = () => renderFacs();
function renderFacs() {
  const q = $('#facSearch').value.trim().toLowerCase();
  const list = facilities.filter(f => !q || [f.name, f.address, f.city, f.state, f.zip, f.contact].join(' ').toLowerCase().includes(q));
  if (!list.length) { $('#facTable').innerHTML = `<tbody><tr><td class="empty">${facilities.length ? 'No matches.' : 'No saved locations yet. Add one here, or click "Save shipper to address book" in the load form.'}</td></tr></tbody>`; return; }
  $('#facTable').innerHTML = `<thead><tr><th>Name</th><th>Address</th><th>Contact</th><th>Hours</th><th></th></tr></thead><tbody>` +
    list.map(f => `<tr><td><b>${esc(f.name)}</b>${f.notes ? `<div class="muted sm" style="max-width:260px">${esc(f.notes.slice(0, 80))}</div>` : ''}</td>
      <td class="sm">${esc(f.address || '')}<div>${esc([f.city, f.state].filter(Boolean).join(', '))} ${esc(f.zip || '')}</div></td>
      <td class="sm">${esc(f.contact || '')}<div>${esc(f.phone || '')}</div></td><td class="sm">${esc(f.hours || '')}</td>
      <td><button class="btn sm" data-fedit="${f.id}">Edit</button></td></tr>`).join('') + '</tbody>';
}
$('#facTable').onclick = e => { const b = e.target.closest('[data-fedit]'); if (b) openFac(facilities.find(f => f.id === Number(b.dataset.fedit))); };
$('#newFac').onclick = () => openFac(null);
const FAC_F = ['name', 'address', 'city', 'state', 'zip', 'contact', 'phone', 'hours', 'notes'];
function openFac(f) { editingFac = f; $('#facTitle').textContent = f ? 'Edit location' : 'New location'; FAC_F.forEach(k => $('#fc_' + k).value = f ? f[k] || '' : ''); $('#facDel').hidden = !f; $('#facDlg').showModal(); }
$('#facForm').onsubmit = async e => {
  e.preventDefault(); const body = {}; FAC_F.forEach(k => body[k] = $('#fc_' + k).value);
  await api(editingFac ? `/api/admin/facilities/${editingFac.id}` : '/api/admin/facilities', { method: editingFac ? 'PUT' : 'POST', body });
  $('#facDlg').close(); toast('Saved'); await refreshRefs(); renderFacs();
};
$('#facDel').onclick = async () => { if (!confirm(`Delete "${editingFac.name}" from the address book?`)) return; await api(`/api/admin/facilities/${editingFac.id}`, { method: 'DELETE' }); $('#facDlg').close(); await refreshRefs(); renderFacs(); };

// ---------- reports ----------
function ymd(d) { return d.toISOString().slice(0, 10); }
function presetRange(v) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  if (v === '7') return [ymd(new Date(Date.now() - 7 * 864e5)), ymd(now)];
  if (v === '30u') return [ymd(new Date(Date.now() - 30 * 864e5)), ymd(new Date(Date.now() + 60 * 864e5))];
  if (v === '30') return [ymd(new Date(Date.now() - 30 * 864e5)), ymd(now)];
  if (v === 'mtd') return [ymd(new Date(Date.UTC(y, m, 1))), ymd(now)];
  if (v === 'lm') return [ymd(new Date(Date.UTC(y, m - 1, 1))), ymd(new Date(Date.UTC(y, m, 0)))];
  if (v === 'ytd') return [`${y}-01-01`, ymd(now)];
  return null;
}
$('#repPreset').onchange = () => { const r = presetRange($('#repPreset').value); if (r) { $('#repFrom').value = r[0]; $('#repTo').value = r[1]; } loadReports(); };
$('#repFrom').onchange = $('#repTo').onchange = () => { $('#repPreset').value = 'custom'; loadReports(); };
async function loadReports() {
  if (!$('#repFrom').value) { const r = presetRange($('#repPreset').value) || presetRange('30u'); $('#repFrom').value = r[0]; $('#repTo').value = r[1]; }
  const d = await api(`/api/admin/reports?from=${$('#repFrom').value}&to=${$('#repTo').value}`);
  const tbl = (title, rows, keyLabel) => `<div class="panel table-wrap"><table class="data"><caption class="repcap">${esc(title)}</caption><thead><tr><th>${esc(keyLabel)}</th><th class="num">Loads</th><th class="num">Covered</th><th class="num">Avg bids</th><th class="num">Avg carrier $</th><th class="num">Revenue</th><th class="num">Margin</th></tr></thead><tbody>` +
    (rows.length ? rows.map(r => `<tr><td>${esc(r.key)}</td><td class="num">${r.loads}</td><td class="num">${r.awarded}</td><td class="num">${r.avg_bids}</td><td class="num">${r.avg_rate ? esc(money(r.avg_rate)) : '—'}</td><td class="num">${r.revenue ? esc(money(r.revenue)) : '—'}</td>
      <td class="num">${r.revenue ? `<span style="color:${r.margin >= 0 ? 'var(--good)' : 'var(--bad)'}">${esc(money(r.margin))}</span><div class="muted sm">${r.margin_pct}%</div>` : '—'}</td></tr>`).join('') : '<tr><td class="empty" colspan="7">Nothing in this range.</td></tr>') + '</tbody></table></div>';
  $('#repBody').innerHTML = `
    <div class="repcards">
      <div><span>Loads posted</span><b>${d.posted}</b><small>${d.no_bids} got no bids</small></div>
      <div><span>Covered</span><b>${d.awarded}</b><small>${d.cover_pct}% of posted</small></div>
      <div><span>Avg bids / load</span><b>${d.avg_bids}</b></div>
      <div><span>Revenue</span><b>${esc(money(d.revenue))}</b><small>${d.with_rate} load${d.with_rate === 1 ? '' : 's'} with a customer rate</small></div>
      <div><span>Carrier pay</span><b>${esc(money(d.carrier_cost))}</b></div>
      <div><span>Margin</span><b style="color:${d.margin >= 0 ? 'var(--good)' : 'var(--bad)'}">${esc(money(d.margin))}</b><small>${d.margin_pct != null ? d.margin_pct + '%' : ''}${d.with_rate ? ' · ' + esc(money(Math.round(d.margin / d.with_rate))) + '/load' : ''}</small></div>
    </div>
    ${d.missing_rate ? `<div class="notice warn">${d.missing_rate} awarded load${d.missing_rate === 1 ? ' has' : 's have'} no customer rate, so ${d.missing_rate === 1 ? "it's" : "they're"} left out of revenue and margin. Add it in Tracking → Open.</div>` : ''}
    <div class="stat-row">${d.by_stage.map(s => `<div class="stat"><b>${s.n}</b><span>${esc(s.label)}</span></div>`).join('')}</div>
    <div class="stack">${tbl('By customer', d.by_customer, 'Customer')}${tbl('Top lanes', d.by_lane, 'Lane')}${tbl('Top carriers (covered loads)', d.by_carrier, 'Carrier')}</div>`;
}

// ---------- rates settled outside the site ----------
async function editRate(bidId, current, company, done) {
  const v = prompt(`Agreed rate for ${company} (all-in $).\nCurrently ${money(current)}:`, String(current));
  if (v == null || !v.trim()) return;
  const note = prompt('Optional note (e.g. "agreed on phone"):', '') || '';
  try { await api(`/api/admin/bids/${bidId}/amount`, { method: 'PUT', body: { amount: v, note } }); toast('Rate updated'); done && done(); }
  catch (e) { toast(e.message); }
}
let bookLoad = null;
function openBookOff(l) {
  bookLoad = l;
  ['mc', 'amount', 'company', 'contact', 'phone', 'email', 'note'].forEach(k => $('#bk_' + k).value = '');
  $('#bk_notify').checked = false; $('#bk_hw').textContent = ''; $('#bookMsg').innerHTML = '';
  $('#bookLane').innerHTML = `<b>${esc(place(l.origin_city, l.origin_state))} → ${esc(place(l.dest_city, l.dest_state))}</b>${l.ref ? ' · #' + esc(l.ref) : ''}`;
  $('#bookDlg').showModal(); $('#bk_mc').focus();
}
let bkTimer = null;
$('#bk_mc').oninput = () => {
  clearTimeout(bkTimer);
  bkTimer = setTimeout(async () => {
    const mc = $('#bk_mc').value.replace(/\D/g, ''); if (mc.length < 4) { $('#bk_hw').textContent = ''; return; }
    try {
      const r = await api('/api/carrier-name?mc=' + encodeURIComponent(mc));
      $('#bk_hw').innerHTML = r.name ? `<span style="color:var(--good);font-weight:600">✓ On Highway list: ${esc(r.name)}</span>` : '<span style="color:var(--bad);font-weight:600">✗ Not on Highway list</span>';
      if (r.name && !$('#bk_company').value) $('#bk_company').value = r.name;
      // fill contact from an earlier bid by this MC
      const prof = cps.find(c => c.mc === mc);
      if (!prof) { const all = await api('/api/admin/carrier-profiles'); cps = all; }
      const p = cps.find(c => c.mc === mc);
      if (p) { if (!$('#bk_company').value) $('#bk_company').value = p.company || ''; const d = await api('/api/admin/carrier-profiles/' + mc); const c = d.contacts[0];
        if (c) { if (!$('#bk_contact').value) $('#bk_contact').value = c.name || ''; if (!$('#bk_phone').value) $('#bk_phone').value = c.phone || ''; if (!$('#bk_email').value) $('#bk_email').value = c.email || ''; }
        if (p.flag === 'dnu') $('#bk_hw').innerHTML += ' · <b style="color:var(--bad)">You marked this carrier Do not use</b>'; }
    } catch (_) { /* ignore */ }
  }, 350);
};
$('#bookForm').onsubmit = async e => {
  e.preventDefault();
  const l = bookLoad;
  if (l.status === 'awarded' && !confirm('This load is already awarded. Switch the award to this carrier?')) return;
  try {
    await api(`/api/admin/loads/${l.id}/manual-award`, { method: 'POST', body: { mc: $('#bk_mc').value, amount: $('#bk_amount').value, company: $('#bk_company').value,
      contact_name: $('#bk_contact').value, phone: $('#bk_phone').value, email: $('#bk_email').value, note: $('#bk_note').value, notify: $('#bk_notify').checked } });
    $('#bookDlg').close(); toast('Load awarded — send the rate con from Aljex, then mark it in Tracking');
    renderBids(l.id); refreshLoads();
  } catch (err) { $('#bookMsg').innerHTML = `<div class="notice err">${esc(err.message)}</div>`; }
};

// "Rate to post" starts from the target rate: typing a target fills it in until you change it yourself
(() => {
  const f = $('#loadForm'); if (!f) return;
  let last = '';
  f.elements.target_rate.addEventListener('focus', () => { last = f.elements.target_rate.value; });
  f.elements.target_rate.addEventListener('input', () => {
    const pr = f.elements.post_rate; if (!pr) return;
    if (!pr.value || pr.value === last) pr.value = f.elements.target_rate.value;
    last = f.elements.target_rate.value;
  });
})();
