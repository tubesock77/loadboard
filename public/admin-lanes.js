// Admin: carriers for each saved lane, carriers added by hand, email-a-load preview, inbox look-back.
const WHY_SHORT = w => w.replace(/^on lane list "(.+)"$/, 'lane list').replace('bid this lane before', 'bid before').replace('emailed about this lane', 'emailed about lane')
  .replace('signed up on the board', 'board sign-up').replace('lane alert you added', 'alert');

// company (live from Highway by MC) first, contact second
const who2 = r => `<b>${esc(r.company || r.name || r.email)}</b>${r.mc ? ` <span class="muted sm">MC ${esc(r.mc)}</span>` : ''}`;
const who2sub = r => `<div class="muted sm">${r.company && r.name ? esc(r.name) + ' · ' : ''}${esc(r.email)}</div>`;
const star = (on, attr) => `<button type="button" class="star ${on ? 'on' : ''}" ${attr} title="${on ? 'Favorite — gets first look. Click to remove.' : 'Make a favorite — gets first look at loads on this lane'}" aria-label="Favorite">${on ? '★' : '☆'}</button>`;
const hwTag = ok => ok ? '<span class="chip good" style="font-size:11px;padding:0 6px">✓ Highway</span>' : '<span class="chip" style="font-size:11px;padding:0 6px" title="Not on your Highway list yet — added automatically once it is">Waiting on Highway</span>';

// ---------- search box helper (Highway list + past carriers) ----------
function carrierSearch(input, box, onPick, allowEmail = false) {
  let t = null;
  const hide = () => { box.hidden = true; box.innerHTML = ''; };
  input.addEventListener('input', () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    t = setTimeout(async () => {
      const rows = await api('/api/admin/carrier-search?q=' + encodeURIComponent(q)).catch(() => []);
      const typed = allowEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q) && !rows.some(r => r.email === q.toLowerCase());
      if (!rows.length && !typed) { box.innerHTML = '<div class="muted sm" style="padding:8px 10px">No match. Type a full email to add someone new.</div>'; box.hidden = false; return; }
      box.innerHTML = (typed ? `<button type="button" data-i="-1"><b>Add ${esc(q)}</b><span class="muted sm"> — new</span></button>` : '') +
        rows.map((r, i) => `<button type="button" data-i="${i}" ${r.email ? '' : 'disabled title="No email on file"'}><b>${esc(r.company || r.name || r.email)}</b>
          <span class="muted sm">${r.mc ? 'MC ' + esc(r.mc) + ' · ' : ''}${esc(r.email || 'no email on file')}</span>${r.highway_pass ? ' <span class="chip good" style="font-size:11px;padding:0 6px">Highway</span>' : ''}</button>`).join('');
      box.hidden = false;
      box.onclick = e => { const b = e.target.closest('button[data-i]'); if (!b || b.disabled) return; const i = Number(b.dataset.i); onPick(i === -1 ? { email: q.toLowerCase(), source: 'manual' } : { ...rows[i], source: rows[i].source === 'highway' ? 'highway' : 'manual' }); input.value = ''; hide(); };
    }, 250);
  });
  input.addEventListener('blur', () => setTimeout(hide, 200));
}

// ---------- carriers on a saved lane ----------
let lnLaneId = null;
const _openLane = openLane;
openLane = function (l) {
  _openLane(l);
  lnLaneId = l ? l.id : null;
  $('#lnNew').hidden = !!l; $('#lnSearch').closest('.field').hidden = !l; $('#lnCarriersBox details').hidden = !l;
  $('#lnCarriers').innerHTML = '';
  if (l) loadLaneCarriers();
};
async function loadLaneCarriers() {
  const rows = await api(`/api/admin/lanes/${lnLaneId}/carriers`);
  const favN = rows.filter(r => r.favorite).length;
  $('#lnCarriers').innerHTML = rows.length ? `<div class="muted sm">★ Star your favorites — they get first look at new loads on this lane before anyone else.${favN ? ` <b>${favN} favorite${favN === 1 ? '' : 's'}.</b>` : ''}</div>` +
    rows.map(r => `<div class="lncar-row" style="${r.highway_pass ? '' : 'opacity:.7'}">${star(r.favorite, `data-lcfav="${r.id}" data-on="${r.favorite ? 1 : 0}"`)}<div style="flex:1">${who2(r)} ${hwTag(r.highway_pass)}
        <div class="muted sm">${r.company && r.name ? esc(r.name) + ' · ' : ''}${esc(r.email)}${r.source === 'inbox' ? ' · from past email' : ''}</div></div>
      <button class="x" type="button" data-lcdel="${r.id}" title="Remove from this lane" aria-label="Remove">×</button></div>`).join('')
    : '<div class="muted sm">No carriers on this lane yet.</div>';
  $$('[data-lcdel]').forEach(b => b.onclick = async () => { await api(`/api/admin/lanes/${lnLaneId}/carriers/${b.dataset.lcdel}`, { method: 'DELETE' }); loadLaneCarriers(); });
  $$('[data-lcfav]').forEach(b => b.onclick = async () => { await api(`/api/admin/lanes/${lnLaneId}/carriers/${b.dataset.lcfav}`, { method: 'PUT', body: { favorite: b.dataset.on !== '1' } }); loadLaneCarriers(); });
}
async function addLaneCarriers(body) {
  const r = await api(`/api/admin/lanes/${lnLaneId}/carriers`, { method: 'POST', body });
  toast(r.added ? `Added ${r.added} carrier${r.added === 1 ? '' : 's'}` : 'Already on this lane'); loadLaneCarriers();
}
carrierSearch($('#lnSearch'), $('#lnResults'), c => addLaneCarriers({ carriers: [c] }), true);
$('#lnN_add').onclick = () => {
  const c = { company: $('#lnN_company').value, name: $('#lnN_name').value, email: $('#lnN_email').value, mc: $('#lnN_mc').value, source: 'manual' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email.trim())) { toast('Enter their email'); return; }
  addLaneCarriers({ carriers: [c] }); ['company', 'name', 'email', 'mc'].forEach(k => $('#lnN_' + k).value = '');
};
$('#lnPasteAdd').onclick = () => { const v = $('#lnPaste').value; if (!v.trim()) return; addLaneCarriers({ paste: v }); $('#lnPaste').value = ''; };

// ---------- add a carrier by hand (Carriers tab) ----------
let mcEditing = null;
async function openManualCarrier(email) {
  mcEditing = null;
  const all = await api('/api/admin/carriers-manual');
  const c = email ? all.find(x => x.email === email) : null; mcEditing = c;
  $('#mcTitle').textContent = c ? 'Edit carrier' : 'Add carrier';
  ['company', 'mc', 'name', 'phone', 'email', 'notes'].forEach(k => $('#mc_' + k).value = c ? c[k] || '' : '');
  if (!refsLoaded) await refreshRefs();
  const mine = new Set(c ? c.lane_ids : []);
  $('#mcLanes').innerHTML = savedLanes.length ? savedLanes.map(l => `<label class="daychip"><input type="checkbox" value="${l.id}" ${mine.has(l.id) ? 'checked' : ''}> ${esc(l.name)}</label>`).join('') : '<span class="muted sm">No saved lanes yet (Lanes &amp; places).</span>';
  $('#mcDel').hidden = !c;
  $('#mcDlg').showModal(); $('#mcFind').focus();
}
$('#cpAdd').onclick = () => openManualCarrier(null);
carrierSearch($('#mcFind'), $('#mcResults'), c => { $('#mc_company').value = c.company || ''; $('#mc_mc').value = c.mc || ''; $('#mc_name').value = c.name || ''; $('#mc_phone').value = c.phone || ''; $('#mc_email').value = c.email || ''; });
$('#mcForm').onsubmit = async e => {
  e.preventDefault();
  try {
    await api('/api/admin/carriers-manual', { method: 'POST', body: { company: $('#mc_company').value, mc: $('#mc_mc').value, name: $('#mc_name').value, phone: $('#mc_phone').value,
      email: $('#mc_email').value, notes: $('#mc_notes').value, lane_ids: $$('#mcLanes input:checked').map(x => Number(x.value)) } });
    $('#mcDlg').close(); toast('Carrier saved'); if (!$('[data-pane="profiles"]').hidden) loadProfiles();
  } catch (err) { toast(err.message); }
};
$('#mcDel').onclick = async () => { if (!mcEditing || !confirm(`Remove ${mcEditing.company || mcEditing.email}? Their bids (if any) are kept.`)) return; await api(`/api/admin/carriers-manual/${mcEditing.id}`, { method: 'DELETE' }); $('#mcDlg').close(); loadProfiles(); };
// carriers added by hand (no MC yet) open the edit form instead of the profile
const _openCarrier = openCarrier;
openCarrier = function (mc) { if (String(mc).startsWith('email:')) return openManualCarrier(String(mc).slice(6)); return _openCarrier(mc); };

// ---------- email a load: preview, pick, send (with first look for favorites) ----------
let nt = { id: null, rows: [], picked: new Set(), load: null, flMode: false };
const FL_HOURS = [1, 2, 4, 8, 24];
async function openNotify(loadId, afterPost) {
  const d = await api(`/api/admin/loads/${loadId}/recipients`).catch(() => null);
  if (!d) return;
  const fl = d.load.first_look;
  if (afterPost && fl !== 'held' && !d.recipients.filter(r => r.highway_pass && !r.already_sent).length) return; // nobody to tell — don't pop up
  const favs = d.recipients.filter(r => r.favorite && r.highway_pass);
  nt = { id: loadId, rows: d.recipients, load: d.load, flMode: (fl === 'held' || fl === 'none') && favs.some(r => !r.already_sent), picked: new Set() };
  pickDefault();
  $('#ntTitle').textContent = `Email this load · ${d.load.lane}`;
  $('#ntIntro').innerHTML = `${d.recipients.length ? `These carriers run this lane${d.load.post_rate ? `. They'll see your rate of <b>${esc(money(d.load.post_rate))}</b>` : ''}. Untick anyone you don't want, or add someone.` : 'No carriers are tied to this lane yet. Add some below, or add them to the saved lane so they show up next time.'}`;
  $('#ntMsg').innerHTML = '';
  renderNotify();
  if (!$('#notifyDlg').open) $('#notifyDlg').showModal();
}
function pickDefault() {
  nt.picked = new Set(nt.rows.filter(r => r.highway_pass && !r.already_sent && !r.already_bid && (!nt.flMode || r.favorite)).map(r => r.email));
}
function renderNotify() {
  const L = nt.load, fl = L.first_look, favN = nt.rows.filter(r => r.favorite && r.highway_pass && !r.already_sent).length;
  const box = $('#ntFL');
  if (nt.flMode) {
    box.hidden = false;
    box.innerHTML = `<div class="notice fl"><b>★ First look</b> — your ${favN === 1 ? 'favorite gets' : favN + ' favorites get'} this first. Everyone else, the board, the daily email and lane alerts wait.
      <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center"><label class="sm" for="ntHours" style="margin:0"><b>Head start</b></label>
      <select id="ntHours" style="width:auto;min-width:0;padding:4px 8px">${FL_HOURS.map(h => `<option value="${h}" ${h === Number(localStorage.getItem('fl_hours') || 2) ? 'selected' : ''}>${h} hour${h === 1 ? '' : 's'}</option>`).join('')}</select>
      <span class="muted sm">When it's up you get a reminder email. Nothing goes to the full list until you click.</span>
      <button class="linkbtn" type="button" id="ntSkip">Skip first look — send to everyone</button></div></div>`;
    $('#ntSkip').onclick = () => { nt.flMode = false; pickDefault(); renderNotify(); };
    $('#ntHours').onchange = e => { try { localStorage.setItem('fl_hours', e.target.value); } catch (_) { /* no storage */ } };
  } else if (fl === 'active' || fl === 'ended') {
    box.hidden = false;
    box.innerHTML = `<div class="notice ${fl === 'ended' ? 'warn' : 'fl'}"><b>★ First look ${fl === 'ended' ? 'ended' : 'running'}</b> — ${fl === 'ended' ? 'ended' : 'until'} ${esc(fmtDateTime(L.first_look_until))} · ${L.bid_count || 0} bid${L.bid_count === 1 ? '' : 's'} so far. The load is still off the board.
      <div class="muted sm" style="margin-top:4px">Send it to everyone below, put it on the board without emailing, or close this and award it from the bids.</div></div>`;
  } else if (fl === 'held') {
    box.hidden = false;
    box.innerHTML = `<div class="notice warn">This load is being held off the board for first look. Send it below to put it out.</div>`;
  } else box.hidden = true;
  $('#ntRelease').hidden = !(fl === 'active' || fl === 'ended' || (fl === 'held' && !nt.flMode));

  const waitN = nt.rows.filter(r => !r.highway_pass).length;
  const section = (r, i) => {
    const prev = nt.rows[i - 1];
    if (nt.flMode) {
      if (i === 0 && r.favorite && r.highway_pass) return `<div class="muted sm"><b>★ Favorites — first look</b></div>`;
      if (!(r.favorite && r.highway_pass) && (i === 0 || (prev.favorite && prev.highway_pass))) return `<div class="muted sm" style="margin-top:6px"><b>Everyone else</b> — they get it when you send to everyone.</div>`;
    }
    if (!r.highway_pass && (i === 0 || prev.highway_pass)) return `<div class="muted sm" style="margin-top:6px"><b>Waiting on Highway (${waitN})</b> — they get this email once they're on your Highway list. Update the Google Sheet to add them.</div>`;
    return '';
  };
  const lock = r => !r.highway_pass || (nt.flMode && !r.favorite);
  $('#ntList').innerHTML = nt.rows.map((r, i) => `${section(r, i)}<label class="ntrow ${r.already_sent || lock(r) ? 'done' : ''}">
      <input type="checkbox" data-nt="${esc(r.email)}" ${nt.picked.has(r.email) ? 'checked' : ''} ${lock(r) ? 'disabled' : ''}>
      <div>${r.favorite ? '<span class="star on" style="cursor:default">★</span> ' : ''}${who2(r)}${who2sub(r)}
        <div class="sm">${r.why.map(w => `<span class="lanetag">${esc(WHY_SHORT(w))}</span>`).join(' ')}${r.highway_pass ? '' : ' ' + hwTag(false)}${r.already_sent ? ' <span class="chip" style="font-size:11px;padding:0 6px">already emailed</span>' : ''}${r.already_bid ? ' <span class="chip good" style="font-size:11px;padding:0 6px">already bid</span>' : ''}</div></div></label>`).join('')
    || '<div class="muted sm">Nobody on the list yet.</div>';
  $('#ntCount').textContent = `${nt.picked.size} selected`;
  $('#ntSend').textContent = nt.picked.size ? (nt.flMode ? `Send first look to ${nt.picked.size}` : `Send to ${fl === 'active' || fl === 'ended' ? 'everyone · ' : ''}${nt.picked.size}`) : 'Send';
  $('#ntSend').disabled = !nt.picked.size;
}
$('#ntList').onchange = e => { const x = e.target.closest('[data-nt]'); if (!x) return; x.checked ? nt.picked.add(x.dataset.nt) : nt.picked.delete(x.dataset.nt); renderNotify(); };
$('#ntAll').onclick = () => { nt.rows.filter(r => r.highway_pass && (!nt.flMode || r.favorite)).forEach(r => nt.picked.add(r.email)); renderNotify(); };
$('#ntNone').onclick = () => { nt.picked.clear(); renderNotify(); };
carrierSearch($('#ntSearch'), $('#ntResults'), c => {
  if (!c.highway_pass) { toast("Not on your Highway list — they can't be emailed until they are"); return; }
  if (!nt.rows.find(r => r.email === c.email)) nt.rows.unshift({ email: c.email, name: c.name || '', company: c.company || '', mc: c.mc || '', why: ['added now'], highway_pass: true, favorite: nt.flMode });
  nt.picked.add(c.email); renderNotify();
}, true);
$('#ntSend').onclick = async () => {
  const emails = [...nt.picked]; if (!emails.length) return;
  const hours = nt.flMode ? Number(($('#ntHours') || {}).value || 2) : 0;
  $('#ntSend').disabled = true; $('#ntSend').textContent = 'Sending…';
  try {
    const r = await api(`/api/admin/loads/${nt.id}/notify`, { method: 'POST', body: { emails, first_look_hours: hours } });
    $('#notifyDlg').close(); toast(`${hours ? `First look (${hours} hr) emailed to` : 'Emailed'} ${r.sent} carrier${r.sent === 1 ? '' : 's'}${r.failed.length ? ` · ${r.failed.length} failed` : ''}${r.skipped_not_highway ? ` · ${r.skipped_not_highway} not on Highway, skipped` : ''}`);
    if (typeof refreshLoads === 'function') refreshLoads();
  } catch (err) { $('#ntMsg').innerHTML = `<div class="notice err">${esc(err.message)}</div>`; renderNotify(); }
};
$('#ntRelease').onclick = async () => {
  await api(`/api/admin/loads/${nt.id}/release`, { method: 'POST' });
  $('#notifyDlg').close(); toast('On the board now — nobody else was emailed');
  if (typeof refreshLoads === 'function') refreshLoads();
};

// ---------- inbox look-back ----------
let lk = [];
$('#ibLookBtn').onclick = () => { $('#lkList').innerHTML = ''; $('#lkStatus').textContent = ''; $('#lkApply').disabled = true; $('#lookDlg').showModal(); };
$('#lkRun').onclick = async () => {
  $('#lkStatus').textContent = 'Reading past emails… this can take a minute.'; $('#lkRun').disabled = true;
  try {
    const d = await api('/api/admin/inbox/lookback', { method: 'POST', body: { days: $('#lkDays').value } });
    lk = d.carriers;
    const pass = lk.filter(c => c.highway_pass).length;
    $('#lkStatus').textContent = `Read ${d.scanned} emails · ${lk.length} carriers asked about lanes · ${pass} on Highway now, ${lk.length - pass} waiting`;
    $('#lkList').innerHTML = lk.length ? `<div class="panel table-wrap"><table class="data"><thead><tr><th style="width:30px"></th><th>Carrier</th><th>Lanes they asked about</th><th>Adds to saved lanes</th></tr></thead><tbody>` +
      lk.map((c, i) => `<tr style="${c.highway_pass ? '' : 'opacity:.75'}"><td><input type="checkbox" data-lk="${i}" ${!c.already ? 'checked' : ''}></td>
        <td>${who2(c)}${who2sub(c)}${c.highway_pass ? '<span class="chip good" style="font-size:11px;padding:0 6px">✓ Highway</span>' : '<span class="chip" style="font-size:11px;padding:0 6px">Waiting on Highway — kept, joins once it passes</span>'}${c.already ? ' <span class="chip" style="font-size:11px;padding:0 6px">already on a lane</span>' : ''}</td>
        <td>${c.lanes.map(l => `<span class="lanetag">${esc(l.o || 'Any')}→${esc(l.d || 'Any')}</span>`).join(' ')}</td>
        <td class="sm">${c.saved_lanes.length ? c.saved_lanes.map(s => esc(s.name)).join(', ') : '<span class="muted">none yet — saved as a lane alert</span>'}</td></tr>`).join('') + '</tbody></table></div>'
      : '<div class="panel empty">No lane requests found in that period.</div>';
    $('#lkApply').disabled = !lk.length;
  } catch (err) { $('#lkStatus').textContent = err.message; }
  $('#lkRun').disabled = false;
};
$('#lkApply').onclick = async () => {
  const pick = $$('[data-lk]:checked').map(x => lk[Number(x.dataset.lk)]);
  if (!pick.length) { toast('Nothing selected'); return; }
  const r = await api('/api/admin/inbox/lookback/apply', { method: 'POST', body: { carriers: pick } });
  $('#lookDlg').close(); toast(`Saved ${r.people} carrier${r.people === 1 ? '' : 's'} · ${r.lanes_added} added to saved lanes · waiting ones join when they pass Highway`);
  if (!$('[data-pane="inbox"]').hidden) loadInbox();
};

// ---------- after a Highway update: who joined, who dropped off ----------
async function showHighwayChanges() {
  let d; try { d = await api('/api/admin/highway-changes'); } catch (_) { return; }
  const html = `<div class="notice ${d.changes ? 'ok' : ''}" style="display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;margin-bottom:12px">
      <span><b>Your lane carriers:</b> ${d.pass} on Highway · ${d.waiting} waiting on Highway</span>
      ${d.changes ? `<span>Last Highway update (${esc(fmtDateTime(d.changes.at))}): <b style="color:var(--good)">${d.changes.joined.length} now good to go</b>${d.changes.dropped.length ? ` · <b style="color:var(--bad)">${d.changes.dropped.length} dropped off</b>` : ''}
        <button class="linkbtn" type="button" data-hwmore>Who?</button> <button class="linkbtn" type="button" data-hwok>OK</button></span>` : '<span class="muted sm">Update your Highway Google Sheet and waiting carriers move over on their own.</span>'}
      <div data-hwlist hidden class="sm" style="flex-basis:100%">${d.changes ? `${d.changes.joined.length ? '<b>Now good to go:</b> ' + d.changes.joined.map(esc).join(', ') : ''}${d.changes.dropped.length ? '<br><b>Dropped off:</b> ' + d.changes.dropped.map(esc).join(', ') : ''}` : ''}</div></div>`;
  $$('.hwbanner').forEach(el => { el.innerHTML = html;
    const m = el.querySelector('[data-hwmore]'); if (m) m.onclick = () => { el.querySelector('[data-hwlist]').hidden = false; };
    const k = el.querySelector('[data-hwok]'); if (k) k.onclick = async () => { await api('/api/admin/highway-changes', { method: 'DELETE' }); showHighwayChanges(); }; });
}
$$('.tabs button').forEach(b => b.addEventListener('click', () => { if (b.dataset.tab === 'lanes' || b.dataset.tab === 'inbox') showHighwayChanges(); }));

// ---------- contacts for my phone (CSV in the phone app's import template) ----------
let ph = [];
const PH_COLS = ['First Name', 'Last Name', 'Phone Number', 'Address', 'City', 'State', 'Zip Code', 'Country', 'Email', 'Company', 'Role', 'Website'];
const PH_KEYS = ['first', 'last', 'phone', 'address', 'city', 'state', 'zip', 'country', 'email', 'company', 'role', 'website'];
$('#ibPhoneBtn').onclick = () => { $('#phList').innerHTML = ''; $('#phStatus').textContent = ''; $('#phDownload').disabled = true; $('#phoneDlg').showModal(); };
function renderPhone() {
  const only = $('#phOnly').checked, list = ph.map((c, i) => ({ c, i })).filter(x => !only || x.c.phone);
  const withPh = ph.filter(c => c.phone).length;
  $('#phStatus').textContent = ph.length ? `${ph.length} people emailed you · ${withPh} with a phone number` : $('#phStatus').textContent;
  $('#phList').innerHTML = list.length ? `<div class="panel table-wrap" style="max-height:52vh;overflow:auto"><table class="data"><thead><tr><th style="width:30px"><input type="checkbox" id="phAll" checked aria-label="All"></th><th>Company · contact</th><th>Phone</th><th>Title</th><th>Address</th><th>Website</th></tr></thead><tbody>` +
    list.map(({ c, i }) => `<tr><td><input type="checkbox" data-ph="${i}" ${c._off ? '' : 'checked'}></td>
      <td><b>${esc(c.company || [c.first, c.last].join(' '))}</b>${c.mc ? ` <span class="muted sm">MC ${esc(c.mc)}</span>` : ''}<div class="muted sm">${c.company ? esc([c.first, c.last].join(' ')) + ' · ' : ''}${esc(c.email)}</div></td>
      <td style="white-space:nowrap">${c.phone ? `<span class="mono">${esc(c.phone)}</span><div class="muted sm">${esc(c.phone_from)}${c.other_phones.length ? ` · also ${c.other_phones.map(esc).join(', ')}` : ''}</div>` : '<span class="muted">—</span>'}</td>
      <td class="sm">${esc(c.role || '')}</td><td class="sm">${esc([c.address, [c.city, c.state].filter(Boolean).join(', '), c.zip].filter(Boolean).join(' '))}</td><td class="sm">${esc((c.website || '').replace(/^https?:\/\//, ''))}</td></tr>`).join('') + '</tbody></table></div>'
    : (ph.length ? '<div class="panel empty">Nobody with a phone number in that period. Untick "Only people with a phone number" to see everyone.</div>' : '');
  $('#phDownload').disabled = !list.some(x => !x.c._off);
  const all = $('#phAll'); if (all) all.onchange = () => { list.forEach(x => x.c._off = !all.checked); renderPhone(); };
}
$('#phList').onchange = e => { const x = e.target.closest('[data-ph]'); if (!x) return; ph[Number(x.dataset.ph)]._off = !x.checked; $('#phDownload').disabled = !ph.some(c => !c._off && (!$('#phOnly').checked || c.phone)); };
$('#phOnly').onchange = renderPhone;
$('#phRun').onclick = async () => {
  $('#phStatus').textContent = 'Reading past emails… this can take a minute or two.'; $('#phRun').disabled = true; $('#phList').innerHTML = '';
  try { const d = await api('/api/admin/inbox/contacts', { method: 'POST', body: { days: $('#phDays').value } }); ph = d.contacts; $('#phStatus').textContent = ''; renderPhone(); $('#phStatus').textContent = `Read ${d.scanned} emails · ` + $('#phStatus').textContent; }
  catch (err) { $('#phStatus').textContent = err.message; }
  $('#phRun').disabled = false;
};
$('#phDownload').onclick = () => {
  const only = $('#phOnly').checked, rows = ph.filter(c => !c._off && (!only || c.phone));
  const q = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const csv = [PH_COLS.join(','), ...rows.map(c => PH_KEYS.map(k => q(c[k])).join(','))].join('\r\n') + '\r\n';
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `loads-contacts-${new Date().toISOString().slice(0, 10)}.csv`; document.body.appendChild(a); a.click(); a.remove();
  toast(`Downloaded ${rows.length} contact${rows.length === 1 ? '' : 's'}`);
};
