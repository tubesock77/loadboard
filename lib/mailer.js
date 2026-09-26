// Sends email as your Microsoft 365 mailbox (EMAIL_FROM) through Microsoft Graph.
// Uses an Entra app (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET) whose Mail.Send permission
// is limited to that one mailbox in Exchange. Messages land in the mailbox's Sent Items.
const { getSetting, setSetting } = require('./db');

const LOGIN = (process.env.MS_LOGIN_URL || 'https://login.microsoftonline.com').replace(/\/$/, '');
const GRAPH = (process.env.MS_GRAPH_URL || 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
const cfg = () => ({
  tenant: process.env.MS_TENANT_ID || '', client: process.env.MS_CLIENT_ID || '',
  secret: process.env.MS_CLIENT_SECRET || '', from: process.env.EMAIL_FROM || '',
});
const configured = () => { const c = cfg(); return !!(c.tenant && c.client && c.secret && c.from); };

let token = null, tokenExp = 0;
async function getToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  const c = cfg();
  const res = await fetch(`${LOGIN}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.client, client_secret: c.secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Microsoft sign-in failed: ' + (j.error_description || j.error || res.status).toString().split('\r\n')[0]);
  token = j.access_token; tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
  return token;
}

const addr = list => [...new Set((list || []).flat().filter(Boolean).map(s => String(s).trim().toLowerCase()))]
  .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).map(address => ({ emailAddress: { address } }));

// send({ to, bcc, subject, html, replyTo })
async function send({ to, bcc, subject, html, replyTo }) {
  if (!configured()) throw new Error('Email is not set up (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, EMAIL_FROM in Render).');
  const c = cfg();
  const message = {
    subject: String(subject || '').slice(0, 250),
    body: { contentType: 'HTML', content: html },
    toRecipients: addr([to]), bccRecipients: addr([bcc]),
  };
  if (replyTo) message.replyTo = addr([replyTo]);
  if (!message.toRecipients.length && !message.bccRecipients.length) throw new Error('No valid recipient');
  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(c.from)}/sendMail`, {
    method: 'POST', headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: true }), signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const msg = (j.error && (j.error.message || j.error.code)) || `HTTP ${res.status}`;
    if (res.status === 403) throw new Error(`Microsoft refused to send as ${c.from}: ${msg} (check the Exchange permission for the LOADBOARD app).`);
    throw new Error('Microsoft Graph: ' + msg);
  }
  setSetting('email_last_ok', new Date().toISOString());
  return true;
}

// fire-and-forget wrapper for automatic emails: never breaks a bid or award
function sendQuiet(opts, label) {
  if (!configured()) return;
  send(opts).catch(e => {
    console.warn(`[email] ${label || 'send'} failed:`, e.message);
    setSetting('email_last_error', `${new Date().toISOString()} ${label || ''}: ${e.message}`.slice(0, 400));
  });
}

function status() {
  const c = cfg();
  return { configured: configured(), from: c.from, missing: ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'EMAIL_FROM'].filter(k => !process.env[k]),
    lastOk: getSetting('email_last_ok', ''), lastError: getSetting('email_last_error', '') };
}

module.exports = { send, sendQuiet, configured, status, from: () => cfg().from };
