// Admin → Inbox: loads@ auto-replies (review / automatic), templates, test box, lane alerts.
let ib = { settings: null, rows: [] };
const KIND = { followup: 'Reply in a thread', lane: 'Lane request', truck: 'Truck available', bid: 'Bid by email', book: 'Book it now', load_question: 'Question on a load', remove: 'Remove me', unknown: 'Needs you', ignored: 'Automatic / junk' };
const STATUS = { draft: ['warn', 'Draft — review & send'], needs_you: ['bad', 'Needs you'], sent: ['good', 'Answered'], done: ['', 'Done'], ignored: ['', 'Ignored'], error: ['bad', 'Error'], queued: ['warn', 'Sending…'] };
const TPL_LABELS = {
  tpl_greeting: 'Greeting', tpl_loads: 'Loads found (lane request)', tpl_more: 'Nearby loads heading', tpl_none: 'Nothing on that lane', tpl_howto: 'How to respond (added under loads)', tpl_buttons_note: 'Line under the buttons',
  tpl_load: 'Details for one load', tpl_bid: 'Bid received', tpl_bid_problem: "Bid couldn't be entered", tpl_book: 'Book it now received', tpl_closed: 'Load no longer available',
  tpl_remove: 'Removed from list', tpl_alert: 'Lane alert (new load posted)', tpl_value: 'Why haul with us (added to every reply)', tpl_signoff: 'Sign-off' };

async function loadInbox() {
  ib.settings = await api('/api/admin/inbox/settings');
  renderIbBar();
  await Promise.all([refreshInbox(), refreshAlerts()]);
}
function renderIbBar() {
  const s = ib.settings;
  $$('input[name=ibmode]').forEach(r => r.checked = r.value === s.mode);
  $('#alertsOn').checked = s.alerts_on;
  const open = (s.counts.needs_you || 0) + (s.counts.draft || 0) + (s.counts.error || 0);
  $('#inboxCount').hidden = !open; $('#inboxCount').textContent = open;
  $('#ibStatus').textContent = s.mode === 'off' ? 'Off — not reading the inbox.' : s.last_check ? `Checked ${fmtDateTime(s.last_check)} · every 2 min` : 'Waiting for first check…';
  let setup = '';
  if (!s.configured) setup = '<div class="notice warn">Email isn\'t connected yet (Settings → Email).</div>';
  else if (s.last_error && /read|Mail\.Read|403|401|Access|denied/i.test(s.last_error) && s.mode !== 'off') setup = `<div class="notice err"><b>The site can send from ${esc(s.from)} but can't read it yet.</b> One more permission is needed — run this in the same PowerShell window you used before (Connect-ExchangeOnline as Cody@):
      <pre class="mono" style="white-space:pre-wrap;margin:8px 0 4px;font-size:12.5px">New-ManagementRoleAssignment -App 03d67516-4f3e-4db6-8a63-40f9598f6883 -Role "Application Mail.Read" -CustomResourceScope "Load Board mailbox"</pre>
      It's limited to ${esc(s.from)} only, like the send permission. It can take up to an hour to start working. <span class="muted">(${esc(s.last_error.slice(0, 160))})</span></div>`;
  else if (s.last_error && s.mode !== 'off') setup = `<div class="notice err"><b>Last check failed:</b> ${esc(s.last_error)}</div>`;
  else if (s.mode === 'off') setup = `<div class="notice">Turn on <b>Review</b> to start. The site reads new mail to ${esc(s.from || 'loads@')} (from the moment you turn it on), drafts the replies, and you click <b>Send</b>. Switch to <b>Automatic</b> once you trust it. "Remove me" requests are always handled right away.</div>`;
  $('#ibSetup').innerHTML = setup;
}
$$('input[name=ibmode]').forEach(r => r.onchange = async () => {
  if (r.value === 'auto' && !confirm('Automatic mode sends replies, enters email bids and saves lane alerts without waiting for you. Emails it can\'t read are still left for you. Turn it on?')) { renderIbBar(); return; }
  ib.settings = await api('/api/admin/inbox/settings', { method: 'PUT', body: { inbox_mode: r.value } }); renderIbBar(); toast(r.value === 'off' ? 'Inbox off' : r.value === 'review' ? 'Review mode on' : 'Automatic mode on');
});
$('#alertsOn').onchange = async () => { ib.settings = await api('/api/admin/inbox/settings', { method: 'PUT', body: { alerts_on: $('#alertsOn').checked } }); toast($('#alertsOn').checked ? 'Lane alerts on' : 'Lane alerts paused'); };
$('#ibCheck').onclick = async () => {
  $('#ibStatus').textContent = 'Checking…';
  try { const r = await api('/api/admin/inbox/check', { method: 'POST' }); toast(r.error ? 'Check failed' : `${r.new || 0} new email${r.new === 1 ? '' : 's'}`); } catch (e) { toast(e.message); }
  loadInbox();
};
$('#ibFilter').onchange = () => refreshInbox();

async function refreshInbox() {
  ib.rows = await api('/api/admin/inbox?status=' + $('#ibFilter').value);
  if (!ib.rows.length) { $('#ibList').innerHTML = `<div class="panel empty">${$('#ibFilter').value === 'open' ? 'Nothing waiting on you.' : 'No emails here yet.'}</div>`; return; }
  $('#ibList').innerHTML = ib.rows.map(r => {
    const [cls, lab] = STATUS[r.status] || ['', r.status];
    const lane = r.lane ? [r.lane.o ? (r.lane.o.city ? r.lane.o.city + ', ' : '') + r.lane.o.state : '', r.lane.d ? (r.lane.d.city ? r.lane.d.city + ', ' : '') + r.lane.d.state : ''].filter(Boolean).join(' → ') : '';
    const canSend = ['draft', 'needs_you', 'error'].includes(r.status) && r.reply_preview;
    const canAdd = ['needs_you', 'error'].includes(r.status) && !r.reply_preview && r.actions.includes('bid');
    return `<article class="ibitem" data-id="${r.id}">
      <header>
        <div><span class="chip ${cls}" style="font-size:11.5px;padding:1px 8px">${esc(lab)}</span> <span class="chip" style="font-size:11.5px;padding:1px 8px">${esc(KIND[r.kind] || r.kind)}</span>${flagChip(r.carrier_flag)}
          <div class="ibfrom"><b>${esc(r.from_name || r.from_email)}</b> <span class="muted">&lt;${esc(r.from_email)}&gt;</span>${r.mc ? ` <span class="mono muted sm">MC ${esc(r.mc)}</span>` : ''}</div>
          <div class="ibsubj">${esc(r.subject || '(no subject)')}</div></div>
        <div class="muted sm" style="white-space:nowrap">${esc(fmtDateTime(r.received_at))}</div>
      </header>
      <div class="ibsum"><b>${esc(r.summary || '')}</b>${r.result ? `<div class="sm" style="color:var(--good)">✓ ${esc(r.result)}</div>` : ''}${r.error ? `<div class="sm" style="color:var(--bad)">${esc(r.error)}</div>` : ''}
        ${r.loads.length ? `<div class="sm muted">Loads: ${r.loads.map(l => `#${esc(l.ref || l.public_id)} ${esc(l.origin_state || '')}→${esc(l.dest_state || '')}`).join(', ')}</div>` : ''}</div>
      <details><summary class="sm">Their email${r.reply_preview ? ' · the reply' : ''}</summary>
        <pre class="ibbody">${esc(r.body || '')}</pre>
        ${r.reply_preview ? `<div class="sm muted" style="margin:8px 0 4px">${r.status === 'sent' ? 'Reply sent' + (r.sent_at ? ' ' + esc(fmtDateTime(r.sent_at)) : '') : 'Reply that will be sent'}:</div><iframe class="ibprev" sandbox srcdoc="${esc(r.reply_preview)}"></iframe>` : ''}
      </details>
      <div class="actions ibact">
        ${canSend ? `<input class="ibnote" placeholder="Optional line to add at the top" data-note="${r.id}"><button class="btn sm primary" data-ib="send" data-id="${r.id}">${r.actions.includes('bid') ? 'Enter bid & send' : 'Send reply'}</button>` : ''}
        ${canAdd ? `<button class="btn sm primary" data-ib="send" data-id="${r.id}" title="Put this in the Bids window — nothing is sent to the carrier">Add as bid</button>` : ''}
        ${['needs_you', 'draft', 'error'].includes(r.status) ? `<button class="btn sm" data-ib="done" data-id="${r.id}" title="I handled it in Outlook">Done</button><button class="btn sm" data-ib="ignore" data-id="${r.id}">Ignore</button>` : `<button class="btn sm" data-ib="reopen" data-id="${r.id}">Reopen</button>`}
        ${['needs_you', 'draft'].includes(r.status) ? `<button class="btn sm" data-ib="reprocess" data-id="${r.id}" title="Read it again (e.g. after posting the load it asks about)">Re-read</button>` : ''}
        ${r.web_link ? `<a class="btn sm" href="${esc(r.web_link)}" target="_blank" rel="noopener">Open in Outlook ↗</a>` : ''}
        ${r.mc ? `<button class="btn sm" data-ibcp="${esc(r.mc)}">Carrier</button>` : ''}
      </div></article>`;
  }).join('');
}
$('#ibList').onclick = async e => {
  const cp = e.target.closest('[data-ibcp]'); if (cp) { openCarrier(cp.dataset.ibcp); return; }
  const b = e.target.closest('[data-ib]'); if (!b) return;
  const id = b.dataset.id, act = b.dataset.ib;
  const note = ($(`[data-note="${id}"]`) || {}).value || '';
  b.disabled = true;
  try {
    const r = await api(`/api/admin/inbox/${id}/${act}`, { method: 'POST', body: act === 'send' ? { note } : {} });
    toast(act === 'send' ? (r.results && r.results.length ? r.results.join(' · ') + (r.sent ? ' · reply sent' : '') : 'Reply sent') : act === 'reprocess' ? 'Read again' : 'Updated');
    if (act === 'send') refreshLoads();
  } catch (err) { toast(err.message); }
  loadInbox();
};

// templates
$('#ibTplBtn').onclick = () => {
  const t = ib.settings.templates;
  $('#tplFields').innerHTML = Object.keys(TPL_LABELS).map(k => `<div class="field"><label for="tp_${k}">${esc(TPL_LABELS[k])}</label><textarea id="tp_${k}" rows="${k === 'tpl_value' || k === 'tpl_howto' ? 3 : 2}" placeholder="${k === 'tpl_value' ? 'e.g. Quick pay in 2 days · No-touch freight · Detention paid after 2 hours · Consistent lanes out of Utah' : ''}">${esc(t[k] || '')}</textarea></div>`).join('');
  $('#alertDays').value = ib.settings.alert_days;
  $('#tplDlg').showModal();
};
$('#tplForm').onsubmit = async e => {
  e.preventDefault(); const body = { alert_days: $('#alertDays').value }; Object.keys(TPL_LABELS).forEach(k => body[k] = $('#tp_' + k).value);
  ib.settings = await api('/api/admin/inbox/settings', { method: 'PUT', body }); $('#tplDlg').close(); toast('Wording saved');
};
$('#tplReset').onclick = () => { if (!confirm('Put all reply wording back to the defaults?')) return; Object.keys(TPL_LABELS).forEach(k => $('#tp_' + k).value = ib.settings.defaults[k] || ''); };

// try an email
$('#ibTestBtn').onclick = () => { $('#ts_out').innerHTML = ''; $('#testDlg').showModal(); $('#ts_subject').focus(); };
$('#ts_run').onclick = async () => {
  const r = await api('/api/admin/inbox/test', { method: 'POST', body: { from: $('#ts_from').value, name: $('#ts_name').value, subject: $('#ts_subject').value, body: $('#ts_body').value } });
  const what = { alert: 'save a lane alert', bid: 'enter a bid', optout: 'take them off the list' };
  $('#ts_out').innerHTML = `<div class="notice ${r.status === 'auto_ok' ? 'ok' : r.status === 'ignored' ? '' : 'warn'}"><b>${esc(KIND[r.kind] || r.kind)}:</b> ${esc(r.summary)}
      ${r.actions.length ? `<div class="sm">It would ${r.actions.map(a => what[a] || a).join(' and ')}${r.reply_preview ? ', and reply:' : '.'}</div>` : r.status === 'needs_you' ? '<div class="sm">It would leave this one for you.</div>' : ''}</div>
    ${r.reply_preview ? `<iframe class="ibprev" sandbox srcdoc="${esc(r.reply_preview)}"></iframe>` : ''}`;
};

// lane alerts
let alerts = [];
async function refreshAlerts() {
  alerts = await api('/api/admin/alerts');
  if (!alerts.length) { $('#alertTable').innerHTML = '<tbody><tr><td class="empty">No lane alerts yet. They\'re saved when carriers email about a lane or sign up on the board.</td></tr></tbody>'; return; }
  $('#alertTable').innerHTML = `<thead><tr><th>Carrier</th><th>Lane</th><th>Type</th><th>From</th><th class="num">Sent</th><th>Until</th><th></th></tr></thead><tbody>` +
    alerts.map(a => { const expired = a.expires_at && Date.parse(a.expires_at) < Date.now(); return `<tr style="${!a.active || expired ? 'opacity:.55' : ''}">
      <td><b>${esc(a.name || a.email)}</b><div class="sm muted">${esc(a.email)}${a.mc ? ' · MC ' + esc(a.mc) : ''}</div></td>
      <td><span class="lanetag">${esc((a.o_city ? a.o_city + ', ' : '') + (a.o_state || 'Any'))} → ${esc((a.d_city ? a.d_city + ', ' : '') + (a.d_state || 'Any'))}</span>${a.equipment ? ` <span class="muted sm">${esc(a.equipment)}</span>` : ''}</td>
      <td class="sm">${a.kind === 'truck' ? 'Truck' + (a.avail_date ? ' ' + esc(fmtDate(a.avail_date)) : '') : 'Lane'}</td>
      <td class="sm">${esc({ email: 'Email', site: 'Board sign-up', admin: 'You' }[a.source] || a.source)}</td>
      <td class="num">${a.sent_count || 0}</td>
      <td class="sm">${!a.active ? 'Stopped' : expired ? 'Expired' : a.expires_at ? esc(fmtDate(a.expires_at.slice(0, 10))) : '—'}</td>
      <td><button class="btn sm danger" data-delalert="${a.id}" title="Delete alert">×</button></td></tr>`; }).join('') + '</tbody>';
}
$('#alertTable').onclick = async e => { const b = e.target.closest('[data-delalert]'); if (!b) return; if (!confirm('Delete this lane alert?')) return; await api(`/api/admin/alerts/${b.dataset.delalert}`, { method: 'DELETE' }); refreshAlerts(); };
$('#newAlert').onclick = async () => {
  const email = prompt('Carrier email:'); if (!email) return;
  const o = prompt('Pickup state (e.g. UT) — blank for any:', '') || '';
  const d = prompt('Delivery state (e.g. TX) — blank for any:', '') || '';
  try { await api('/api/admin/alerts', { method: 'POST', body: { email, o_state: o, d_state: d } }); toast('Alert added — they\'ll get new loads on that lane'); refreshAlerts(); } catch (err) { toast(err.message); }
};
// keep the tab badge fresh
setInterval(async () => { if (typeof refsLoaded !== 'undefined' && refsLoaded) { try { ib.settings = await api('/api/admin/inbox/settings'); const s = ib.settings; const open = (s.counts.needs_you || 0) + (s.counts.draft || 0) + (s.counts.error || 0); $('#inboxCount').hidden = !open; $('#inboxCount').textContent = open; } catch (_) { /* signed out */ } } }, 120000);
setTimeout(async () => { try { const s = await api('/api/admin/inbox/settings'); ib.settings = s; const open = (s.counts.needs_you || 0) + (s.counts.draft || 0) + (s.counts.error || 0); $('#inboxCount').hidden = !open; $('#inboxCount').textContent = open; } catch (_) { /* not signed in */ } }, 2500);
