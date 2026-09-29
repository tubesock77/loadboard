// Admin: carriers for each saved lane, carriers added by hand, email-a-load preview, inbox look-back.
const WHY_SHORT = w => w.replace(/^on lane list "(.+)"$/, 'lane list').replace('bid this lane before', 'bid before').replace('emailed about this lane', 'emailed about lane')
  .replace('signed up on the board', 'board sign-up').replace('lane alert you added', 'alert');

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
  $('#lnCarriers').innerHTML = rows.length ? rows.map(r => `<div class="lncar-row"><div><b>${esc(r.company || r.name || r.email)}</b> <span class="muted sm">${r.mc ? 'MC ' + esc(r.mc) + ' · ' : ''}${esc(r.email)}${r.source === 'inbox' ? ' · from past email' : ''}</span></div>
      <button class="x" type="button" data-lcdel="${r.id}" title="Remove from this lane" aria-label="Remove">×</button></div>`).join('')
    : '<div class="muted sm">No carriers on this lane yet.</div>';
  $$('[data-lcdel]').forEach(b => b.onclick = async () => { await api(`/api/admin/lanes/${lnLaneId}/carriers/${b.dataset.lcdel}`, { method: 'DELETE' }); loadLaneCarriers(); });
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

// ---------- email a load: preview, pick, send ----------
let nt = { id: null, rows: [], picked: new Set() };
async function openNotify(loadId, afterPost) {
  const d = await api(`/api/admin/loads/${loadId}/recipients`).catch(() => null);
  if (!d) return;
  if (afterPost && !d.recipients.filter(r => !r.already_sent).length) return; // nobody to tell — don't pop up
  nt = { id: loadId, rows: d.recipients, picked: new Set(d.recipients.filter(r => !r.already_sent && !r.already_bid).map(r => r.email)) };
  $('#ntTitle').textContent = `Email this load · ${d.load.lane}`;
  $('#ntIntro').innerHTML = `${d.recipients.length ? `These carriers run this lane${d.load.post_rate ? `. They'll see your rate of <b>${esc(money(d.load.post_rate))}</b>` : ''}. Untick anyone you don't want, or add someone.` : 'No carriers are tied to this lane yet. Add some below, or add them to the saved lane so they show up next time.'}`;
  $('#ntMsg').innerHTML = '';
  renderNotify();
  if (!$('#notifyDlg').open) $('#notifyDlg').showModal();
}
function renderNotify() {
  $('#ntList').innerHTML = nt.rows.map(r => `<label class="ntrow ${r.already_sent ? 'done' : ''}">
      <input type="checkbox" data-nt="${esc(r.email)}" ${nt.picked.has(r.email) ? 'checked' : ''}>
      <div><b>${esc(r.company || r.name || r.email)}</b> <span class="muted sm">${r.mc ? 'MC ' + esc(r.mc) + ' · ' : ''}${esc(r.email)}</span>
        <div class="sm">${r.why.map(w => `<span class="lanetag">${esc(WHY_SHORT(w))}</span>`).join(' ')}${r.already_sent ? ' <span class="chip" style="font-size:11px;padding:0 6px">already emailed</span>' : ''}${r.already_bid ? ' <span class="chip good" style="font-size:11px;padding:0 6px">already bid</span>' : ''}</div></div></label>`).join('')
    || '<div class="muted sm">Nobody on the list yet.</div>';
  $('#ntCount').textContent = `${nt.picked.size} selected`;
  $('#ntSend').textContent = nt.picked.size ? `Send to ${nt.picked.size}` : 'Send';
  $('#ntSend').disabled = !nt.picked.size;
}
$('#ntList').onchange = e => { const x = e.target.closest('[data-nt]'); if (!x) return; x.checked ? nt.picked.add(x.dataset.nt) : nt.picked.delete(x.dataset.nt); renderNotify(); };
$('#ntAll').onclick = () => { nt.rows.forEach(r => nt.picked.add(r.email)); renderNotify(); };
$('#ntNone').onclick = () => { nt.picked.clear(); renderNotify(); };
carrierSearch($('#ntSearch'), $('#ntResults'), c => {
  if (!nt.rows.find(r => r.email === c.email)) nt.rows.push({ email: c.email, name: c.name || '', company: c.company || '', mc: c.mc || '', why: ['added now'] });
  nt.picked.add(c.email); renderNotify();
}, true);
$('#ntSend').onclick = async () => {
  const emails = [...nt.picked]; if (!emails.length) return;
  $('#ntSend').disabled = true; $('#ntSend').textContent = 'Sending…';
  try {
    const r = await api(`/api/admin/loads/${nt.id}/notify`, { method: 'POST', body: { emails } });
    $('#notifyDlg').close(); toast(`Emailed ${r.sent} carrier${r.sent === 1 ? '' : 's'}${r.failed.length ? ` · ${r.failed.length} failed` : ''}`);
  } catch (err) { $('#ntMsg').innerHTML = `<div class="notice err">${esc(err.message)}</div>`; renderNotify(); }
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
    $('#lkStatus').textContent = `Read ${d.scanned} emails · ${lk.length} carriers asked about lanes · ${pass} on your Highway list`;
    $('#lkList').innerHTML = lk.length ? `<div class="panel table-wrap"><table class="data"><thead><tr><th style="width:30px"></th><th>Carrier</th><th>Lanes they asked about</th><th>Adds to saved lanes</th></tr></thead><tbody>` +
      lk.map((c, i) => `<tr style="${c.highway_pass ? '' : 'opacity:.5'}"><td><input type="checkbox" data-lk="${i}" ${c.highway_pass && !c.already ? 'checked' : ''} ${c.highway_pass ? '' : 'disabled'}></td>
        <td><b>${esc(c.company || c.name || c.email)}</b><div class="muted sm">${c.mc ? 'MC ' + esc(c.mc) + ' · ' : ''}${esc(c.email)}</div>${c.highway_pass ? '<span class="chip good" style="font-size:11px;padding:0 6px">✓ Highway</span>' : '<span class="chip bad" style="font-size:11px;padding:0 6px">Not on Highway list — skipped</span>'}${c.already ? ' <span class="chip" style="font-size:11px;padding:0 6px">already on a lane</span>' : ''}</td>
        <td>${c.lanes.map(l => `<span class="lanetag">${esc(l.o || 'Any')}→${esc(l.d || 'Any')}</span>`).join(' ')}</td>
        <td class="sm">${c.saved_lanes.length ? c.saved_lanes.map(s => esc(s.name)).join(', ') : '<span class="muted">none yet — saved as a lane alert</span>'}</td></tr>`).join('') + '</tbody></table></div>'
      : '<div class="panel empty">No lane requests found in that period.</div>';
    $('#lkApply').disabled = !lk.some(c => c.highway_pass);
  } catch (err) { $('#lkStatus').textContent = err.message; }
  $('#lkRun').disabled = false;
};
$('#lkApply').onclick = async () => {
  const pick = $$('[data-lk]:checked').map(x => lk[Number(x.dataset.lk)]);
  if (!pick.length) { toast('Nothing selected'); return; }
  const r = await api('/api/admin/inbox/lookback/apply', { method: 'POST', body: { carriers: pick } });
  $('#lookDlg').close(); toast(`Added ${r.people} carrier${r.people === 1 ? '' : 's'} · ${r.lanes_added} to saved lanes · ${r.alerts} lane alerts`);
  if (!$('[data-pane="inbox"]').hidden) loadInbox();
};
