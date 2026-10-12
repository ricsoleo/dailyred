// The admin page (admin.html): lists players' reports and lets the admin
// hide a trainer from the Hall of Fame, restore one, or close a report.
// Every call sends the admin token (kept for this tab in sessionStorage).

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'dailyred-admin';
const SUSPICIOUS_SECONDS = 90; // a whole battle against RED takes minutes

const session = {
  get() { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(value) { try { sessionStorage.setItem(TOKEN_KEY, value); } catch { /* this page only */ } },
  clear() { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* nothing kept */ } },
};

let token = session.get();
let showing = 'open';

class AuthError extends Error {}

async function call(method, path, body) {
  const res = await fetch(`api/admin/${path}`, {
    method,
    headers: { 'X-Admin-Token': token ?? '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 404) throw new AuthError(data.error || 'Wrong admin token.');
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : (word.endsWith('s') ? 'es' : 's')}`;
const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const duration = (s) => (s === null ? 'unfinished' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

function actionButton(label, run, quiet = true) {
  const button = el('button', `button ${quiet ? 'button-quiet' : 'button-run'}`, label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await run();
      await load();
    } catch (err) {
      button.disabled = false;
      showError(err);
    }
  });
  return button;
}

function battlesTable(battles) {
  const table = el('table', 'admin-battles');
  const head = table.createTHead().insertRow();
  for (const label of ['Day', 'Result', 'Time']) head.append(el('th', '', label));
  const body = table.createTBody();
  for (const b of battles) {
    const row = body.insertRow();
    if (b.result === 'won' && b.seconds !== null && b.seconds < SUSPICIOUS_SECONDS) row.className = 'is-suspicious';
    row.append(el('td', '', b.day), el('td', '', b.result ?? 'running'), el('td', '', duration(b.seconds)));
  }
  return table;
}

function reportCard(report) {
  const card = el('article', `admin-card admin-card-${report.kind}`);
  const head = el('header', 'admin-card-head');
  head.append(
    el('span', 'admin-kind', report.kind === 'result' ? 'Suspicious result' : 'Site problem'),
    el('span', 'admin-meta', `${when(report.createdAt)} · by ${report.reporter ? `${report.reporter.name} #${report.reporter.id}` : 'a visitor'}`),
  );
  if (report.status !== 'open') head.append(el('span', 'admin-status', `${report.status} ${when(report.closedAt)}`));
  card.append(head);
  if (report.note) card.append(el('blockquote', 'admin-note', report.note));

  const actions = el('div', 'admin-actions');
  if (report.kind === 'result' && report.target) {
    const t = report.target;
    const who = el('p', 'admin-target');
    who.append(el('strong', '', t.name), ` #${t.id} · ${plural(t.wins, 'win')}, ${plural(t.losses, 'loss')} · streak ${t.winStreak} (best ${t.bestWinStreak})`);
    if (t.hidden) who.append(el('span', 'admin-badge', 'hidden'));
    card.append(who, battlesTable(t.battles));
    if (report.status === 'open') {
      actions.append(t.hidden
        ? actionButton('Restore to the Hall of Fame', () => call('POST', `players/${t.id}`, { hidden: false }))
        : actionButton('Hide from the Hall of Fame', () => call('POST', `players/${t.id}`, { hidden: true }), false));
    }
  }
  if (report.kind === 'problem' && report.context) {
    card.append(el('pre', 'admin-context', JSON.stringify(report.context, null, 2)));
  }
  if (report.status === 'open') {
    if (report.kind === 'problem') actions.append(actionButton('Mark resolved', () => call('POST', `reports/${report.id}`, { status: 'resolved' }), false));
    actions.append(actionButton('Dismiss', () => call('POST', `reports/${report.id}`, { status: 'dismissed' })));
  }
  if (actions.childElementCount) card.append(actions);
  return card;
}

async function load() {
  const data = await call('GET', `reports?status=${showing}`);
  $('summary').textContent = data.reports.length
    ? `${data.reports.length} ${showing} report${data.reports.length === 1 ? '' : 's'}`
    : showing === 'open' ? 'No open reports.' : 'No closed reports yet.';
  $('reports').replaceChildren(...data.reports.map(reportCard));

  const hidden = $('hidden');
  hidden.replaceChildren();
  if (!data.hidden.length) hidden.append(el('li', 'admin-empty', 'Nobody.'));
  for (const p of data.hidden) {
    const li = el('li', 'admin-hidden-row');
    li.append(el('span', '', `${p.name} #${p.id} · ${plural(p.wins, 'win')}, ${plural(p.losses, 'loss')}`),
      actionButton('Restore', () => call('POST', `players/${p.id}`, { hidden: false })));
    hidden.append(li);
  }
}

function showError(err) {
  if (err instanceof AuthError) {
    token = null;
    session.clear();
    $('panel').hidden = true;
    $('login').hidden = false;
    $('login-error').textContent = err.message;
    $('login-error').hidden = false;
    return;
  }
  $('summary').textContent = err.message;
}

async function open() {
  try {
    await load();
    $('login').hidden = true;
    $('panel').hidden = false;
  } catch (err) {
    showError(err);
  }
}

function setShowing(which) {
  showing = which;
  $('show-open').setAttribute('aria-pressed', String(which === 'open'));
  $('show-closed').setAttribute('aria-pressed', String(which === 'closed'));
  load().catch(showError);
}

$('login').addEventListener('submit', (event) => {
  event.preventDefault();
  token = $('token').value.trim();
  session.set(token);
  $('token').value = '';
  open();
});
$('show-open').addEventListener('click', () => setShowing('open'));
$('show-closed').addEventListener('click', () => setShowing('closed'));
$('refresh').addEventListener('click', () => load().catch(showError));
$('logout').addEventListener('click', () => {
  token = null;
  session.clear();
  $('panel').hidden = true;
  $('login').hidden = false;
});

if (token) open();
