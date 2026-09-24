// Shared helpers for all pages.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
function esc(v) {
  return v == null ? '' : String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n, cents = false) {
  if (n == null || n === '') return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
}
function perMile(amount, miles) {
  return amount && miles ? '$' + (amount / miles).toFixed(2) + '/mi' : '';
}
function fmtDate(d) {
  if (!d) return '';
  const t = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T12:00:00') : new Date(d);
  if (isNaN(t)) return d;
  return t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '';
  const t = new Date(d.includes('T') || d.includes('Z') ? d : d.replace(' ', 'T') + 'Z');
  if (isNaN(t)) return d;
  return t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function timeLeft(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return { text: 'Bidding closed', urgent: true, closed: true };
  const h = ms / 3600000;
  if (h < 1) return { text: `Closes in ${Math.max(1, Math.round(ms / 60000))} min`, urgent: true };
  if (h < 24) return { text: `Closes in ${Math.round(h)} hr`, urgent: h < 6 };
  return { text: `Bids due ${fmtDateTime(iso)}`, urgent: false };
}
function place(city, state, zip) {
  return [city, state].filter(Boolean).join(', ') || zip || '—';
}
function weight(w) { return w ? Number(w).toLocaleString('en-US') + ' lb' : ''; }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'loadboard' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON */ }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Link copied'); }
  catch (_) { window.prompt('Copy this link:', text); }
}

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
};

async function applyBranding() {
  try {
    const c = await api('/api/config');
    $$('[data-company]').forEach(el => el.textContent = c.company);
    $$('[data-tagline]').forEach(el => el.textContent = c.tagline);
    document.title = document.title.replace('{company}', c.company);
    return c;
  } catch (_) { return {}; }
}

const TRUCK_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 6h13v10H1z"/><path d="M14 9h4l3 3v4h-7"/><circle cx="5.5" cy="17.5" r="1.8"/><circle cx="17.5" cy="17.5" r="1.8"/></svg>';
