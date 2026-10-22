// Orchestrates extraction. Lives in the service worker so it keeps running after the popup closes.
// Two job types, mirrored to chrome.storage.local:
//   "job"  – search-results extraction (pages)
//   "pjob" – profile lookup (pasted profile URLs)

const KEYS = { search: 'job', profiles: 'pjob' };
const MAX_PAGES = 100; // LinkedIn never serves more than 100 result pages per search

let job = null;     // search job (in memory)
let pjob = null;    // profile-lookup job (in memory)
let busy = false;   // only one job at a time
let keepAlive = null;
const tempTabs = new Set(); // background tabs we opened; closed immediately on Stop

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

/* ----------------------------------------------------------------- state */
function ref(which) { return which === 'profiles' ? pjob : job; }

async function persist(which) {
  const j = ref(which);
  await chrome.storage.local.set({ [KEYS[which]]: j });
  if (which === 'search') {
    try {
      const n = j && j.rows ? j.rows.length : 0;
      await chrome.action.setBadgeBackgroundColor({ color: j && j.status === 'running' ? '#0a66c2' : '#44546a' });
      await chrome.action.setBadgeText({ text: n ? String(n) : '' });
    } catch (e) { /* cosmetic */ }
  }
}

function log(j, msg) {
  j.log = j.log || [];
  j.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  if (j.log.length > 60) j.log.shift();
}

// A job can only be ended by us if the user has not already stopped it
async function finish(which, status, message) {
  const j = ref(which);
  if (!j || j.status === 'stopped') return;
  j.status = status;
  j.message = message || '';
  log(j, `${status}: ${message || ''}`);
  await persist(which);
}

const running = (j) => !!j && j.status === 'running';

// A stored "running" job at worker start-up means the worker was killed mid-run
(async () => {
  for (const which of ['search', 'profiles']) {
    const o = await chrome.storage.local.get(KEYS[which]);
    const j = o[KEYS[which]];
    if (j && j.status === 'running' && !busy) {
      if (which === 'search') job = j; else pjob = j;
      j.status = 'interrupted';
      j.message = 'Interrupted (browser or extension restarted).' + (which === 'search' ? ' Press Resume to continue.' : '');
      await persist(which);
    }
  }
})();

/* -------------------------------------------------------------- messaging */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'start') sendResponse(await startSearch(msg));
      else if (msg.type === 'startProfiles') sendResponse(await startProfiles(msg));
      else if (msg.type === 'stop') sendResponse(await stopJob(msg.which || 'search'));
      else if (msg.type === 'clear') sendResponse(await clearJob(msg.which || 'search'));
      else sendResponse({ ok: false, error: 'Unknown message' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true;
});

async function stopJob(which) {
  let j = ref(which);
  if (!j) { // worker restarted: act on the stored copy
    const o = await chrome.storage.local.get(KEYS[which]);
    j = o[KEYS[which]];
    if (j) { if (which === 'search') job = j; else pjob = j; }
  }
  if (j && (j.status === 'running' || j.status === 'interrupted')) {
    j.status = 'stopped';
    j.message = 'Stopped.' + (which === 'search' ? ' Press Resume to continue from this page.' : '');
    log(j, 'stopped by user');
    await persist(which);
  }
  // abort anything in flight right now
  for (const id of [...tempTabs]) { try { await chrome.tabs.remove(id); } catch (e) { /* gone */ } }
  tempTabs.clear();
  return { ok: true };
}

async function clearJob(which) {
  if (busy) return { ok: false, error: 'Stop the job first.' };
  if (which === 'search') job = null; else pjob = null;
  await chrome.storage.local.remove(KEYS[which]);
  if (which === 'search') await chrome.action.setBadgeText({ text: '' });
  return { ok: true };
}

/* ---------------------------------------------------------------- helpers */
function pageUrl(base, page) {
  // string-level edit keeps LinkedIn's original query encoding untouched
  if (/([?&])page=\d+/.test(base)) return base.replace(/([?&])page=\d+/, `$1page=${page}`);
  return base + (base.includes('?') ? '&' : '?') + `page=${page}`;
}

// Resolves once the tab has started a new navigation and finished loading it.
function watchNavigation(tabId, timeout = 45000) {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    let sawLoading = false;
    const timer = setTimeout(() => { cleanup(); reject(new Error('Page load timed out')); }, timeout);
    const onUpd = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) { cleanup(); resolve(); }
    };
    function cleanup() { chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(timer); }
    cancel = () => { cleanup(); resolve(); };
    chrome.tabs.onUpdated.addListener(onUpd);
  });
  return { promise, cancel };
}

async function navigate(tabId, url) {
  const w = watchNavigation(tabId);
  try { await chrome.tabs.update(tabId, { url }); }
  catch (e) { w.cancel(); throw e; }
  await w.promise;
}

// For freshly created tabs, whose "loading" event may fire before we can listen.
async function waitComplete(tabId, timeout = 40000) {
  const t0 = Date.now();
  await sleep(1200);
  while (Date.now() - t0 < timeout) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return;
    await sleep(500);
  }
  throw new Error('Profile load timed out');
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function call(tabId, fn, arg) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: (name, a) => window.__lse[name](a),
    args: [fn, arg === undefined ? null : arg],
  });
  return res && res[0] ? res[0].result : null;
}

// Sleep that ends early when the job is stopped
async function sleepWhile(j, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until && running(j)) await sleep(250);
}

// Open url in a background tab, run one content-script function, close the tab
async function visitTab(url, fn, arg) {
  const tab = await chrome.tabs.create({ url, active: false });
  tempTabs.add(tab.id);
  try {
    await waitComplete(tab.id);
    await inject(tab.id);
    return await call(tab.id, fn, arg);
  } finally {
    tempTabs.delete(tab.id);
    try { await chrome.tabs.remove(tab.id); } catch (e) { /* already gone */ }
  }
}

// Poll in short slices so Stop takes effect within a few seconds
async function waitCards(j, tabId, total) {
  const end = Date.now() + total;
  let info = null;
  while (Date.now() < end && running(j)) {
    info = await call(tabId, 'waitReady', 3000);
    if (info && (info.blocked || info.cardCount > 0 || info.noResults)) return info;
  }
  return info;
}

async function waitChange(j, tabId, page, prevSig, total) {
  const end = Date.now() + total;
  while (Date.now() < end && running(j)) {
    const info = await call(tabId, 'waitChange', { page, prevSig, timeout: 3000 });
    if (info) return info;
  }
  return null;
}

function startKeepAlive() { keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000); }
function stopKeepAlive() { clearInterval(keepAlive); keepAlive = null; }

/* --------------------------------------------------------- name matching */
function normName(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(',')[0].replace(/\([^)]*\)/g, ' ')
    .replace(/\b(dr|mr|mrs|ms|prof|phd|mba|md)\b\.?/g, ' ')
    .replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// -> 'match' | 'partial' | 'mismatch' | 'unknown'
function matchNames(a, b) {
  const A = normName(a), B = normName(b);
  if (!A || !B) return 'unknown';
  if (A === B) return 'match';
  const ta = A.split(' '), tb = B.split(' ');
  const first = ta[0] === tb[0];
  const last = ta[ta.length - 1] === tb[tb.length - 1];
  if (first && last) return 'match';
  const sb = new Set(tb);
  const inter = ta.filter((t) => sb.has(t)).length;
  if (inter >= Math.min(ta.length, tb.length) && inter > 0) return 'match';
  if (first || last || inter > 0) return 'partial';
  return 'mismatch';
}


/* ============================================================ SEARCH JOB */
async function waitIdle(ms = 6000) {
  const end = Date.now() + ms;
  while (busy && Date.now() < end) await sleep(200);
  return !busy;
}

async function startSearch(msg) {
  if (!(await waitIdle())) return { ok: false, error: 'A job is already running.' };

  if (msg.resume) {
    const o = await chrome.storage.local.get(KEYS.search);
    if (!o[KEYS.search]) return { ok: false, error: 'Nothing to resume.' };
    job = o[KEYS.search];
    job.status = 'running';
    job.message = '';
    job.firstNav = false;
    job.lastSig = null;
    try { await chrome.tabs.get(job.tabId); }
    catch (e) { job.status = 'error'; job.message = 'The LinkedIn tab was closed. Start a new run.'; await persist('search'); return { ok: false, error: job.message }; }
    log(job, 'resumed');
  } else {
    const tab = await chrome.tabs.get(msg.tabId);
    let u;
    try { u = new URL(tab.url); } catch (e) { return { ok: false, error: 'Cannot read this tab.' }; }
    if (!/(^|\.)linkedin\.com$/.test(u.hostname) || !u.pathname.startsWith('/search/results/people')) {
      return { ok: false, error: 'Open a LinkedIn people search results page first.' };
    }
    const curPage = parseInt(u.searchParams.get('page') || '1', 10) || 1;
    const from = msg.mode === 'range' ? Math.max(1, msg.from | 0 || 1) : 1;
    const to = msg.mode === 'range' ? Math.min(MAX_PAGES, Math.max(from, msg.to | 0 || from)) : null;
    job = {
      status: 'running',
      tabId: msg.tabId,
      baseUrl: u.href,
      mode: msg.mode,
      from, to,
      current: from,
      totalPages: null,
      rows: [],
      settings: {
        delayMin: Math.max(1.5, +msg.delayMin || 3),
        delayMax: Math.max(2, +msg.delayMax || 6),
        skipHidden: !!msg.skipHidden,
        deepSkills: !!msg.deepSkills,
        verify: !!msg.verify,
      },
      message: '',
      log: [],
      firstNav: true,
      startedFrom: curPage,
      startedAt: Date.now(),
    };
    if (job.settings.delayMax < job.settings.delayMin) job.settings.delayMax = job.settings.delayMin + 1;
    log(job, `started (${job.mode}${to ? ` ${from}-${to}` : ' all'})`);
  }
  busy = true;
  await persist('search');
  runSearch(); // intentionally not awaited
  return { ok: true };
}

async function visitRow(r, s) {
  // 1) verify: open the profile, check first + last name, take over the public profile link
  if (s.verify) {
    if (!r.orig_link) {
      r.verified = 'Unverified';
    } else {
      const p = await visitTab(r.orig_link, 'readProfile');
      if (!p || p.blocked) throw Object.assign(new Error('blocked'), { blocked: true });
      if (p.notFound) {
        r.profile_link = '';           // 404: the link is dead, so don't keep it
        r.verified = 'Unverified';
      } else if (!p.ok || !p.name) {
        r.verified = 'Unverified';     // page opened but could not be read
      } else {
        if (p.url) r.profile_link = p.url; // e.g. /in/laura-northrop-98365429/ instead of /in/ACoAA…
        const profileHidden = /^linkedin member$/i.test(p.name);
        if (r.name_hidden) {
          if (profileHidden) r.verified = 'Unverified';
          else { r.first_name = p.first_name; r.last_name = p.last_name; r.name_hidden = false; r.verified = 'Verified'; }
        } else {
          r.verified = matchNames(`${r.first_name} ${r.last_name}`, p.name) === 'match' ? 'Verified' : 'Unverified';
        }
      }
    }
  }
  // 2) skills
  if (s.deepSkills && !r.skills && r.profile_link) {
    const sk = await visitTab(r.profile_link.replace(/\/?$/, '/') + 'details/skills/', 'extractSkillsPage');
    if (sk && sk.blocked) throw Object.assign(new Error('blocked'), { blocked: true });
    r.skills = ((sk && sk.skills) || []).join(',');
  }
}

async function runSearch() {
  startKeepAlive();
  try {
    while (running(job)) {
      const page = job.current;
      if (job.to && page > job.to) { await finish('search', 'done', `Finished pages ${job.from}–${job.to}.`); break; }
      if (page > MAX_PAGES) { await finish('search', 'done', 'Reached LinkedIn’s 100-page limit.'); break; }

      job.message = `Loading page ${page}…`;
      await persist('search');

      // --- get to the page: already there / click "Next" / load by URL
      const tab = await chrome.tabs.get(job.tabId);
      let how = '';
      if (job.firstNav) {
        let cur = -1;
        try { cur = parseInt(new URL(tab.url).searchParams.get('page') || '1', 10) || 1; } catch (e) { /* ignore */ }
        if (cur === page && /\/search\/results\/people/.test(tab.url || '')) how = 'already open';
      }
      job.firstNav = false;
      if (!how && job.lastSig && job.lastPage === page - 1) {
        await inject(job.tabId);
        if (await call(job.tabId, 'clickNext')) {
          const ok = await waitChange(job, job.tabId, page, job.lastSig, 15000);
          if (!running(job)) break;
          if (ok) how = 'Next button';
          else log(job, `page ${page}: Next click did not change results, reloading by URL`);
        }
      }
      if (!running(job)) break;
      if (!how) { await navigate(job.tabId, pageUrl(job.baseUrl, page)); how = 'URL'; }
      log(job, `page ${page}: opened via ${how}`);

      await inject(job.tabId);
      let info = await waitCards(job, job.tabId, 25000);
      if (!running(job)) break;
      if (info && info.blocked) { await finish('search', 'error', 'LinkedIn asked for a login/verification. Resolve it in the tab, then press Resume.'); break; }
      if (!info || info.cardCount === 0) {
        await sleepWhile(job, 4000);
        info = await waitCards(job, job.tabId, 15000);
        if (!running(job)) break;
      }
      if (!info || info.cardCount === 0) {
        // capture what the page looks like, so the problem can be diagnosed
        try { job.lastDiag = await call(job.tabId, 'diagnose'); } catch (e) { /* ignore */ }
        if (job.rows.length === 0) await finish('search', 'error', `No result cards found on page ${page}. Use “Copy diagnostics” and send it to me.`);
        else await finish('search', 'error', `No results found on page ${page}. Press Resume to retry, or “Copy diagnostics”.`);
        break;
      }

      await call(job.tabId, 'autoScroll');
      const res = await call(job.tabId, 'extract');
      if (!running(job)) break;
      if (!res || !res.rows) { await finish('search', 'error', 'Could not read the page.'); break; }

      info = res.info || info;
      if (info.totalPages) job.totalPages = Math.max(job.totalPages || 0, info.totalPages);
      job.paywall = !!info.paywall;
      job.lastSig = await call(job.tabId, 'signature');
      job.lastPage = page;

      const keyOf = (r) => r.orig_link || r.profile_link || `${r.first_name}|${r.last_name}|${r.position}|${r.location}`;
      const seen = new Set(job.rows.map(keyOf));
      const added = [];
      for (const r of res.rows) {
        if (job.settings.skipHidden && r.name_hidden) continue;
        r.orig_link = r.profile_link;
        const k = keyOf(r);
        if (seen.has(k)) continue;
        seen.add(k);
        r.page = page;
        job.rows.push(r);
        added.push(r);
      }
      log(job, `page ${page}: ${res.rows.length} cards read, ${added.length} new`);
      job.message = `Page ${page}: ${res.rows.length} results read.`;
      await persist('search');

      // --- optional per-profile work (verification / skills): slow, many extra requests
      if (job.settings.verify || job.settings.deepSkills) {
        let i = 0;
        for (const r of added) {
          if (!running(job)) break;
          i++;
          job.message = `Page ${page}: checking profile ${i}/${added.length}…`;
          await persist('search');
          try { await visitRow(r, job.settings); }
          catch (e) {
            if (!running(job)) break;
            if (e && e.blocked) { await finish('search', 'error', 'LinkedIn asked for a login/verification while opening profiles. Resolve it, then Resume.'); break; }
            if (job.settings.verify && !r.verified) r.verified = 'Unverified';
            log(job, `profile check failed: ${e && e.message}`);
          }
          await persist('search');
          await sleepWhile(job, rand(Math.max(2, job.settings.delayMin / 2), Math.max(3, job.settings.delayMax / 2)) * 1000);
        }
        if (!running(job)) break;
      }

      if (!info.hasNext) {
        job.totalPages = page;
        await finish('search', 'done', `Reached the last page (${page}).`);
        break;
      }
      if (job.to && page >= job.to) { await finish('search', 'done', `Finished pages ${job.from}–${job.to}.`); break; }
      job.current = page + 1;
      const wait = rand(job.settings.delayMin, job.settings.delayMax);
      job.message = `Waiting ${wait.toFixed(1)}s before page ${job.current}…`;
      await persist('search');
      await sleepWhile(job, wait * 1000);
    }
  } catch (e) {
    if (running(job)) await finish('search', 'error', `Stopped: ${e && e.message ? e.message : e}. Press Resume to retry this page.`);
  } finally {
    stopKeepAlive();
    busy = false;
    if (job && job.status === 'running') { job.status = 'stopped'; await persist('search'); }
  }
}

/* ======================================================== PROFILE LOOKUP */
async function startProfiles(msg) {
  if (!(await waitIdle())) return { ok: false, error: 'A job is already running.' };
  const items = (msg.items || []).filter((i) => i && i.url).slice(0, 500);
  if (!items.length) return { ok: false, error: 'Paste at least one LinkedIn profile URL.' };
  pjob = {
    status: 'running',
    items: items.map((i) => ({ url: i.url, expected: i.expected || '', status: 'pending' })),
    current: 0,
    settings: { delayMin: Math.max(1.5, +msg.delayMin || 3), delayMax: Math.max(2, +msg.delayMax || 6) },
    message: '',
    log: [],
    startedAt: Date.now(),
  };
  if (pjob.settings.delayMax < pjob.settings.delayMin) pjob.settings.delayMax = pjob.settings.delayMin + 1;
  log(pjob, `started: ${items.length} profiles`);
  busy = true;
  await persist('profiles');
  runProfiles();
  return { ok: true };
}

async function runProfiles() {
  startKeepAlive();
  try {
    while (running(pjob) && pjob.current < pjob.items.length) {
      const it = pjob.items[pjob.current];
      pjob.message = `Opening profile ${pjob.current + 1} of ${pjob.items.length}…`;
      await persist('profiles');
      try {
        const p = await visitTab(it.url, 'readProfile');
        if (!running(pjob)) break;
        if (!p || p.blocked) {
          await finish('profiles', 'error', 'LinkedIn asked for a login/verification. Resolve it in your browser, then start again.');
          break;
        }
        const profileHidden = !p.name || /^linkedin member$/i.test(p.name);
        if (p.notFound) {
          it.result = { name: '', first_name: '', last_name: '', company: '', position: '', headline: '', location: '', profile_link: '' };
          it.status = 'error';
          it.error = 'Profile not found (404)';
          if (it.expected) it.match = 'Unverified';
        } else {
          it.result = {
            name: p.name || '', first_name: p.first_name || '', last_name: p.last_name || '',
            company: p.company || '', position: p.position || '', headline: p.headline || '',
            location: p.location || '', profile_link: p.url || it.url,
          };
          if (!p.ok || !p.name) { it.status = 'error'; it.error = 'Could not read this profile (private, or still loading)'; if (it.expected) it.match = 'Unverified'; }
          else {
            it.status = 'done';
            if (it.expected) it.match = !profileHidden && matchNames(it.expected, p.name) === 'match' ? 'Verified' : 'Unverified';
          }
        }
      } catch (e) {
        if (!running(pjob)) break;
        it.status = 'error';
        it.error = e && e.message ? e.message : String(e);
      }
      log(pjob, `${pjob.current + 1}/${pjob.items.length}: ${it.status}`);
      pjob.current++;
      await persist('profiles');
      if (pjob.current < pjob.items.length) {
        await sleepWhile(pjob, rand(pjob.settings.delayMin, pjob.settings.delayMax) * 1000);
      }
    }
    if (running(pjob)) await finish('profiles', 'done', `Finished ${pjob.items.length} profiles.`);
  } catch (e) {
    if (running(pjob)) await finish('profiles', 'error', `Stopped: ${e && e.message ? e.message : e}`);
  } finally {
    stopKeepAlive();
    busy = false;
    if (pjob && pjob.status === 'running') { pjob.status = 'stopped'; await persist('profiles'); }
  }
}
