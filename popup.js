const $ = (id) => document.getElementById(id);

const FIELDS = [
  ['first_name', 'First Name'],
  ['last_name', 'Last Name'],
  ['position', 'Position'],
  ['skills', 'Skills'],
  ['location', 'Location'],
  ['profile_link', 'Profile Link'],
];
const PROFILE_COLS = [
  ['name', 'Name'], ['first_name', 'First Name'], ['last_name', 'Last Name'],
  ['company', 'Company'], ['position', 'Position'], ['headline', 'Headline'],
  ['location', 'Location'], ['profile_link', 'Profile Link'],
  ['expected', 'Expected Name'], ['match', 'Verified'], ['status', 'Status'],
];

let activeTab = null;
let job = null;    // search job
let pjob = null;   // profile-lookup job
let view = 'search';

/* ----------------------------------------------------------- settings */
async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) return;
  document.querySelectorAll('#fields input').forEach((i) => { if (settings.fields && i.dataset.field in settings.fields) i.checked = settings.fields[i.dataset.field]; });
  if (settings.mode) document.querySelector(`input[name=mode][value=${settings.mode}]`).checked = true;
  if (settings.from) $('from').value = settings.from;
  if (settings.to) $('to').value = settings.to;
  if (settings.delayMin) $('delayMin').value = settings.delayMin;
  if (settings.delayMax) $('delayMax').value = settings.delayMax;
  $('skipHidden').checked = !!settings.skipHidden;
  $('verify').checked = !!settings.verify;
  $('deepSkills').checked = !!settings.deepSkills;
  if (settings.profileInput) $('profileInput').value = settings.profileInput;
  if (settings.view) setView(settings.view);
}

function readSettings() {
  const fields = {};
  document.querySelectorAll('#fields input').forEach((i) => { fields[i.dataset.field] = i.checked; });
  return {
    fields,
    mode: document.querySelector('input[name=mode]:checked').value,
    from: parseInt($('from').value, 10) || 1,
    to: parseInt($('to').value, 10) || 0,
    delayMin: parseFloat($('delayMin').value) || 3,
    delayMax: parseFloat($('delayMax').value) || 6,
    skipHidden: $('skipHidden').checked,
    verify: $('verify').checked,
    deepSkills: $('deepSkills').checked,
    profileInput: $('profileInput').value,
    view,
  };
}

function persist() { chrome.storage.local.set({ settings: readSettings() }); }

/* ---------------------------------------------------------------- tabs */
function setView(v) {
  view = v;
  $('panelSearch').hidden = v !== 'search';
  $('panelProfiles').hidden = v !== 'profiles';
  $('tabSearch').classList.toggle('active', v === 'search');
  $('tabProfiles').classList.toggle('active', v === 'profiles');
  $('tabSearch').setAttribute('aria-selected', v === 'search');
  $('tabProfiles').setAttribute('aria-selected', v === 'profiles');
}
$('tabSearch').addEventListener('click', () => { setView('search'); persist(); });
$('tabProfiles').addEventListener('click', () => { setView('profiles'); persist(); });

/* ------------------------------------------------------------- tab info */
async function detectTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  const status = $('tabStatus');
  let ok = false;
  try {
    const u = new URL(tab.url);
    ok = /(^|\.)linkedin\.com$/.test(u.hostname) && u.pathname.startsWith('/search/results/people');
  } catch (e) { /* ignore */ }
  if (!ok) {
    status.textContent = 'Search tab: open a LinkedIn people search to use “Search results”.';
    status.className = 'sub bad';
    return false;
  }
  status.textContent = 'People search detected';
  status.className = 'sub ok';
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__lse.pageInfo() });
    const info = r && r.result;
    if (info) {
      status.textContent = `People search detected · page ${info.currentPage}${info.totalPages ? ` of ${info.totalPages}+` : ''} · ${info.cardCount} results on this page`;
      if (info.totalPages) $('detected').textContent = `(${info.totalPages}+ pages visible)`;
      $('zeroHint').hidden = info.cardCount > 0;
    }
  } catch (e) { /* page still loading; fine */ }
  return true;
}

/* --------------------------------------------------------------- render */
function barState(bar, fill, pct, indeterminate) {
  bar.classList.toggle('indeterminate', indeterminate);
  fill.style.width = indeterminate ? '' : pct + '%';
}

function renderSearch() {
  const isRunning = job && job.status === 'running';
  const canResume = job && ['stopped', 'interrupted', 'error'].includes(job.status) && job.current && !(job.to && job.current > job.to);
  $('start').hidden = !!isRunning;
  $('stop').hidden = !isRunning;
  $('resume').hidden = !canResume;

  const hasRows = job && job.rows && job.rows.length > 0;
  $('results').hidden = !hasRows;
  $('count').textContent = hasRows ? job.rows.length : 0;
  $('progress').hidden = !job;
  if (job) {
    const total = job.to || job.totalPages;
    let pct = 0;
    if (total) {
      const span = Math.max(1, total - job.from + 1);
      const doneCount = job.status === 'done' ? span : Math.max(0, job.current - job.from);
      pct = Math.min(100, Math.round((doneCount / span) * 100));
    }
    barState($('progress').querySelector('.bar'), $('barFill'), pct, isRunning && !total);
    const word = { running: 'Running', done: 'Done', stopped: 'Stopped', interrupted: 'Interrupted', error: 'Error' }[job.status] || job.status;
    $('progressText').textContent = `${word} · page ${job.current}${total ? ' of ' + total : ''} · ${job.rows.length} profiles`;
    $('message').textContent = (job.message || '') + (job.paywall ? ' LinkedIn is showing a search-limit notice, so results may be capped.' : '');
  }
  $('rangeRow').hidden = document.querySelector('input[name=mode]:checked').value !== 'range';
}

function renderProfiles() {
  const isRunning = pjob && pjob.status === 'running';
  $('pStart').hidden = !!isRunning;
  $('pStop').hidden = !isRunning;
  $('pProgress').hidden = !pjob;
  const results = pjob ? pjob.items.filter((i) => i.result) : [];
  $('pResults').hidden = !results.length;
  $('pCount').textContent = results.length;
  if (pjob) {
    const total = pjob.items.length;
    barState($('pProgress').querySelector('.bar'), $('pBarFill'), Math.round((pjob.current / total) * 100), false);
    const word = { running: 'Running', done: 'Done', stopped: 'Stopped', interrupted: 'Interrupted', error: 'Error' }[pjob.status] || pjob.status;
    const failed = pjob.items.filter((i) => i.status === 'error').length;
    $('pProgressText').textContent = `${word} · ${pjob.current} of ${total} profiles${failed ? ` · ${failed} could not be read` : ''}`;
    $('pMessage').textContent = pjob.message || '';
  }
  // preview table
  const t = $('pTable');
  t.textContent = '';
  const cols = [['name', 'Name'], ['company', 'Company'], ['position', 'Position'], ['location', 'Location'], ['match', 'Verified']];
  const head = t.insertRow();
  cols.forEach(([, h]) => { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); });
  (pjob ? pjob.items : []).forEach((it) => {
    if (!it.result && it.status !== 'error') return;
    const tr = t.insertRow();
    cols.forEach(([k]) => {
      const td = tr.insertCell();
      const v = k === 'match' ? (it.match || '') : ((it.result && it.result[k]) || '');
      td.textContent = v;
      td.title = v;
      if (k === 'match') td.className = /^verified$/i.test(v) ? 'good' : (v ? 'bad' : '');
      if (k === 'name' && !v && it.error) { td.textContent = '⚠ ' + it.error; td.className = 'bad'; td.title = it.error; }
    });
  });
}

function render() { renderSearch(); renderProfiles(); }

function showError(msg) {
  $('error').textContent = msg || '';
  $('error').hidden = !msg;
}

/* --------------------------------------------------------------- export */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
  return '"' + s.replace(/"/g, '""') + '"';
}
const toCsv = (cols, rows) => '﻿' + [cols.map(([, h]) => csvCell(h)).join(','), ...rows.map((r) => cols.map(([k]) => csvCell(r[k])).join(','))].join('\r\n');
const toJson = (cols, rows) => JSON.stringify(rows.map((r) => Object.fromEntries(cols.map(([k]) => [k, r[k] == null ? '' : r[k]]))), null, 2);
const toTsv = (cols, rows) => [cols.map(([, h]) => h).join('\t'), ...rows.map((r) => cols.map(([k]) => String(r[k] == null ? '' : r[k]).replace(/[\t\r\n]+/g, ' ')).join('\t'))].join('\n');

function searchCols() {
  const sel = readSettings().fields;
  const cols = FIELDS.filter(([k]) => sel[k]);
  if (job && job.rows.some((r) => r.verified)) cols.push(['verified', 'Verified']);
  return cols;
}

function profileRows() {
  return (pjob ? pjob.items : []).map((it) => ({
    ...(it.result || { profile_link: it.url }),
    expected: it.expected || '',
    match: it.match || '',
    status: it.status === 'done' ? 'OK' : (it.error || it.status),
  }));
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

async function copyText(btn, text) {
  await navigator.clipboard.writeText(text);
  const old = btn.textContent;
  btn.textContent = 'Copied ✓';
  setTimeout(() => (btn.textContent = old), 1500);
}

/* ------------------------------------------------- profile input parsing */
function parseProfileInput(text) {
  const items = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^\s,|;]+/i);
    if (!m) continue;
    let url = m[0];
    if (!/^https?:/i.test(url)) url = 'https://' + url;
    try {
      const u = new URL(url);
      url = `https://www.linkedin.com${u.pathname.replace(/\/?$/, '/')}`;
    } catch (e) { continue; }
    const expected = line.replace(m[0], ' ').replace(/[|,;\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({ url, expected });
  }
  return items;
}

/* -------------------------------------------------------------- actions */
async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  showError(res && res.ok ? '' : (res && res.error) || 'Something went wrong.');
  return res;
}

$('start').addEventListener('click', async () => {
  const s = readSettings();
  if (!Object.values(s.fields).some(Boolean)) return showError('Pick at least one field to extract.');
  if (s.mode === 'range') {
    if (s.from < 1 || s.from > 100) return showError('“From” must be between 1 and 100.');
    if (s.to && s.to < s.from) return showError('“To” must be ≥ “From”.');
  }
  if (!(await detectTab())) return showError('Open a LinkedIn people search results page first.');
  if (job && job.rows && job.rows.length && !confirm('Starting a new run replaces the results currently stored. Continue?')) return;
  persist();
  await send({ type: 'start', tabId: activeTab.id, mode: s.mode, from: s.from, to: s.to, delayMin: s.delayMin, delayMax: s.delayMax, skipHidden: s.skipHidden, verify: s.verify, deepSkills: s.deepSkills && s.fields.skills });
});
$('resume').addEventListener('click', () => send({ type: 'start', resume: true }));
$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  await send({ type: 'stop', which: 'search' });
  $('stop').disabled = false;
});
$('clear').addEventListener('click', async () => {
  if (!confirm('Delete the extracted results?')) return;
  const r = await send({ type: 'clear', which: 'search' });
  if (r && r.ok) { job = null; render(); }
});
$('dlCsv').addEventListener('click', () => download(`linkedin-search-${stamp()}.csv`, toCsv(searchCols(), job.rows), 'text/csv;charset=utf-8'));
$('dlJson').addEventListener('click', () => download(`linkedin-search-${stamp()}.json`, toJson(searchCols(), job.rows), 'application/json'));
$('copy').addEventListener('click', () => copyText($('copy'), toTsv(searchCols(), job.rows)));

$('pStart').addEventListener('click', async () => {
  const items = parseProfileInput($('profileInput').value);
  if (!items.length) return showError('Paste at least one LinkedIn profile link (linkedin.com/in/…).');
  if (pjob && pjob.items && pjob.items.some((i) => i.result) && !confirm('Starting a new run replaces the profile results currently stored. Continue?')) return;
  const s = readSettings();
  persist();
  await send({ type: 'startProfiles', items, delayMin: s.delayMin, delayMax: s.delayMax });
});
$('pStop').addEventListener('click', async () => {
  $('pStop').disabled = true;
  await send({ type: 'stop', which: 'profiles' });
  $('pStop').disabled = false;
});
$('pClear').addEventListener('click', async () => {
  if (!confirm('Delete the profile results?')) return;
  const r = await send({ type: 'clear', which: 'profiles' });
  if (r && r.ok) { pjob = null; render(); }
});
$('pCsv').addEventListener('click', () => download(`linkedin-profiles-${stamp()}.csv`, toCsv(PROFILE_COLS.filter(([k]) => k !== 'expected' && k !== 'match' || profileRows().some((r) => r[k])), profileRows()), 'text/csv;charset=utf-8'));
$('pJson').addEventListener('click', () => download(`linkedin-profiles-${stamp()}.json`, toJson(PROFILE_COLS, profileRows()), 'application/json'));
$('pCopy').addEventListener('click', () => copyText($('pCopy'), toTsv(PROFILE_COLS, profileRows())));

// Diagnostics: current tab structure + the last run's log, as one block of text
$('diag').addEventListener('click', async () => {
  try {
    const out = {};
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__lse.diagnose() });
      out.page = JSON.parse(r.result);
    } catch (e) { out.page = 'unavailable: ' + e.message; }
    const { job: j, pjob: p } = await chrome.storage.local.get(['job', 'pjob']);
    if (j) out.searchJob = { status: j.status, message: j.message, current: j.current, rows: (j.rows || []).length, log: j.log, lastDiag: j.lastDiag ? JSON.parse(j.lastDiag) : undefined };
    if (p) out.profileJob = { status: p.status, message: p.message, current: p.current, items: p.items.map((i) => ({ status: i.status, error: i.error, match: i.match })), log: p.log };
    await navigator.clipboard.writeText(JSON.stringify(out, null, 1));
    $('diag').textContent = 'Copied ✓ – paste it in the chat';
  } catch (e) { showError('Could not read diagnostics: ' + e.message); }
});

document.querySelectorAll('input, textarea').forEach((i) => i.addEventListener('change', () => { persist(); render(); }));
$('profileInput').addEventListener('input', () => persist());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.job) job = changes.job.newValue || null;
  if (changes.pjob) pjob = changes.pjob.newValue || null;
  if (changes.job || changes.pjob) render();
});

/* ----------------------------------------------------------------- init */
(async () => {
  await loadSettings();
  const stored = await chrome.storage.local.get(['job', 'pjob']);
  job = stored.job || null;
  pjob = stored.pjob || null;
  render();
  await detectTab();
})();
