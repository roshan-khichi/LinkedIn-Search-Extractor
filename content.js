// Injected on demand into LinkedIn tabs by background.js / popup.js.
// Exposes window.__lse with page-reading helpers. Runs in the extension's isolated world.
(() => {
  if (window.__lse && window.__lse.v === 3) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /* ------------------------------------------------------------------ cards */
  // Walks open shadow roots too (only used when the normal lookup finds nothing, because it is slower)
  function deepQueryAll(sel, root = document) {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) out.push(...deepQueryAll(sel, el.shadowRoot));
    }
    return out;
  }

  const PRIMARY = '[data-view-name="people-search-result"]';

  // Smallest ancestor of `el` that still holds only ONE distinct profile
  function cardFromNode(el) {
    const li = el.closest('[role="listitem"], li');
    if (li) return li;
    let node = el;
    while (node.parentElement && node.parentElement !== document.body) {
      const p = node.parentElement;
      const links = new Set([...p.querySelectorAll('a[href*="/in/"]')].map((a) => normalizeProfileUrl(a.getAttribute('href'))));
      if (links.size > 1) break;
      node = p;
    }
    return node;
  }

  function getCards() {
    // 1) current LinkedIn layout (obfuscated class names, stable data-view-name hook)
    let cards = [...document.querySelectorAll(PRIMARY)];
    if (cards.length) return cards;
    // 2) classic layout
    cards = [...document.querySelectorAll('li.reusable-search__result-container')];
    if (cards.length) return cards;
    // 3) generic: every search-snippet id or /in/ link marks a person; climb to its card
    const found = new Set();
    const roots = document.querySelectorAll('[id^="SearchResultssnippet"]');
    roots.forEach((n) => found.add(cardFromNode(n)));
    const scope = document.querySelector('main') || document;
    scope.querySelectorAll('a[href*="/in/"]').forEach((a) => {
      if (a.closest('header, nav, aside, footer, [role="navigation"]')) return;
      found.add(cardFromNode(a));
    });
    if (found.size) return [...found];
    // 3b) leaf list items in <main> that look like a person row
    const items = [...document.querySelectorAll('main [role="listitem"]')].filter((li) =>
      !li.querySelector('[role="listitem"]') && li.querySelectorAll('p').length >= 2 &&
      li.querySelector('a[href*="/in/"], a[href*="/search/results/people"], button'));
    if (items.length) return items;
    // 4) last resort: look inside shadow roots
    deepQueryAll(PRIMARY).forEach((n) => found.add(n));
    return [...found];
  }

  function splitName(full) {
    let n = clean(full);
    if (!n || /^linkedin member$/i.test(n)) return { first: '', last: '' };
    n = n.split(',')[0];                           // drop credentials after comma ("Jane Doe, PhD")
    n = n.replace(/\s*\([^)]*\)\s*/g, ' ');        // drop "(She/Her)" style parentheticals
    n = n.replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, ''); // drop leading titles
    const parts = clean(n).split(' ').filter(Boolean);
    return { first: parts[0] || '', last: parts.slice(1).join(' ') };
  }

  function normalizeProfileUrl(href) {
    try {
      const u = new URL(href, location.origin);
      if (!/\/in\//.test(u.pathname)) return '';
      return u.origin + u.pathname.replace(/\/?$/, '/');
    } catch (e) { return ''; }
  }

  function parseSkills(text) {
    const m = clean(text).match(/(?:^|\s)Skills?\s*:\s*(.+)$/i);
    if (!m) return [];
    return m[1].split(/\s*[,;•·|]\s*/).map(clean).filter((s) => s && s !== '...' && s !== '…');
  }

  function extractCurrent(card) {
    const snippetBox = card.querySelector('[id^="SearchResultssnippet"]');
    const titleLink = card.querySelector('a[data-view-name="search-result-lockup-title"]');

    const ps = [...card.querySelectorAll('p')].filter((p) => !(snippetBox && snippetBox.contains(p)));
    const meta = ps.filter((p) => {
      const t = clean(p.textContent);
      return t && !/^[\d.,KkMm]+\+?\s*followers?$/i.test(t) && !/mutual connection/i.test(t) && !/^(Current|Past|Skills?)\s*:/i.test(t);
    });

    // Name
    let rawName = '';
    if (titleLink) {
      const c = titleLink.cloneNode(true);
      c.querySelectorAll('[role="img"], svg').forEach((e) => e.remove());
      rawName = clean(c.textContent);
    } else if (meta[0]) {
      rawName = clean(meta[0].textContent).replace(/\s*•.*$/, '');
    }
    const hidden = !rawName || /^linkedin member$/i.test(rawName);
    const { first, last } = splitName(rawName);

    const position = meta[1] ? clean(meta[1].textContent) : '';
    const location_ = meta[2] ? clean(meta[2].textContent) : '';
    const snippet = snippetBox ? clean(snippetBox.textContent) : '';

    // Profile link: real /in/ link if visible, else rebuild from the member URN LinkedIn exposes in the snippet id
    let link = '';
    const a = card.querySelector('a[href*="/in/"]');
    if (a) link = normalizeProfileUrl(a.getAttribute('href'));
    if (!link && snippetBox) {
      const urn = (snippetBox.id || '').replace(/^SearchResultssnippet_/, '');
      if (/^ACo[A-Za-z0-9_-]+$/.test(urn)) link = `https://www.linkedin.com/in/${urn}/`;
    }
    if (!link) {
      const m = card.innerHTML.match(/profileUrn=urn%3Ali%3Afsd_profile%3A(ACo[A-Za-z0-9_-]+)/);
      if (m) link = `https://www.linkedin.com/in/${m[1]}/`;
    }

    return { first, last, position, location: location_, link, snippet, hidden, skills: parseSkills(snippet) };
  }

  function extractClassic(card) {
    const a = card.querySelector('.entity-result__title-text a.app-aware-link, a.app-aware-link[href*="/in/"]');
    let rawName = '';
    if (a) {
      const vis = a.querySelector('span[aria-hidden="true"]');
      rawName = clean((vis || a).textContent);
    }
    const hidden = !rawName || /^linkedin member$/i.test(rawName);
    const { first, last } = splitName(rawName);
    const position = clean(card.querySelector('.entity-result__primary-subtitle')?.textContent);
    const location_ = clean(card.querySelector('.entity-result__secondary-subtitle')?.textContent);
    const snippet = clean(card.querySelector('.entity-result__summary')?.textContent);
    return {
      first, last, position, location: location_, hidden, snippet,
      link: a ? normalizeProfileUrl(a.getAttribute('href')) : '',
      skills: parseSkills(snippet),
    };
  }

  // Fallback for unknown markup: works from the visible text lines of the card.
  function extractGeneric(card) {
    const a = card.querySelector('a[href*="/in/"]');
    let link = a ? normalizeProfileUrl(a.getAttribute('href')) : '';
    const snippetBox = card.querySelector('[id^="SearchResultssnippet"]');
    if (!link && snippetBox) {
      const urn = (snippetBox.id || '').replace(/^SearchResultssnippet_/, '');
      if (/^ACo[A-Za-z0-9_-]+$/.test(urn)) link = `https://www.linkedin.com/in/${urn}/`;
    }
    const raw = (card.innerText || card.textContent || '').split(/\n+/).map(clean).filter(Boolean);
    const noise = /^(•|·|1st|2nd|3rd\+?|•\s*(1st|2nd|3rd\+?)|view|follow|connect|message|pending|verified|premium|open to work|[\d.,KkMm]+\+?\s*followers?|.*mutual connections?.*|(current|past|skills?)\s*:.*)$/i;
    let lines = raw.filter((l) => !noise.test(l));
    // the name is often rendered twice (link text + label): drop the repeats
    if (lines[0]) lines = [lines[0], ...lines.slice(1).filter((l) => !l.startsWith(lines[0]))];
    const snippetLine = raw.find((l) => /^(Current|Past|Skills?)\s*:/i.test(l)) || '';
    const rawName = (lines[0] || '').replace(/\s*•.*$/, '');
    const hidden = !rawName || /^linkedin member$/i.test(rawName);
    const { first, last } = splitName(rawName);
    return {
      first, last, hidden, link,
      position: lines[1] || '', location: lines[2] || '',
      snippet: snippetLine, skills: parseSkills(snippetLine),
    };
  }

  function extract(opts = {}) {
    const rows = [];
    for (const card of getCards()) {
      let r;
      if (card.matches(PRIMARY)) r = extractCurrent(card);
      else if (card.matches('li.reusable-search__result-container')) r = extractClassic(card);
      else r = extractGeneric(card);
      rows.push({
        first_name: r.hidden ? 'LinkedIn' : r.first,
        last_name: r.hidden ? 'Member' : r.last,
        position: r.position,
        skills: r.skills.join(','),
        location: r.location,
        profile_link: r.link,
        snippet: r.snippet,
        name_hidden: r.hidden,
      });
    }
    return { rows, info: pageInfo() };
  }

  /* -------------------------------------------------------------- page info */
  function pageInfo() {
    const url = new URL(location.href);
    const current = parseInt(url.searchParams.get('page') || '1', 10) || 1;
    let total = 0;
    document.querySelectorAll('[data-testid^="pagination-indicator"], .artdeco-pagination__indicator--number').forEach((b) => {
      const n = parseInt(clean(b.textContent), 10);
      if (n > total) total = n;
    });
    const next = document.querySelector('[data-testid="pagination-controls-next-button-visible"], button.artdeco-pagination__button--next');
    const hasNext = !!next && !next.disabled && next.getAttribute('aria-disabled') !== 'true';
    return {
      url: location.href,
      path: location.pathname,
      isPeopleSearch: location.pathname.startsWith('/search/results/people'),
      currentPage: current,
      totalPages: total || null,
      hasNext,
      cardCount: getCards().length,
      noResults: /no results found/i.test(document.body ? document.body.innerText.slice(0, 5000) : ''),
      blocked: /^\/(checkpoint|authwall|login|uas\/login)/.test(location.pathname),
      paywall: !!document.querySelector('[data-view-name="search-paywall-people-warn-upsell"]'),
    };
  }

  /* ---------------------------------------------------------------- waiting */
  async function waitReady(timeout = 25000) {
    const t0 = Date.now();
    let last = -1, stable = 0, nudged = false;
    while (Date.now() - t0 < timeout) {
      if (!nudged && Date.now() - t0 > 4000 && getCards().length === 0) {
        nudged = true; // some pages only render results once scrolled
        window.scrollTo(0, 600); await sleep(600); window.scrollTo(0, 0);
      }
      const info = pageInfo();
      if (info.blocked) return info;
      if (info.cardCount > 0) {
        stable = info.cardCount === last ? stable + 1 : 0;
        last = info.cardCount;
        if (stable >= 2) return pageInfo();
      } else if (info.noResults) {
        return info;
      }
      await sleep(400);
    }
    return pageInfo();
  }

  // Scroll each card (and the pager) into view so lazy-rendered content is present
  async function autoScroll() {
    const cards = getCards();
    for (let i = 0; i < cards.length; i += 2) {
      cards[i].scrollIntoView({ block: 'center' });
      await sleep(200 + Math.random() * 200);
    }
    if (cards.length) cards[cards.length - 1].scrollIntoView({ block: 'center' });
    await sleep(500);
    const pager = document.querySelector('[data-testid="pagination-controls-list"], .artdeco-pagination');
    if (pager) pager.scrollIntoView({ block: 'center' });
    await sleep(500);
    window.scrollTo(0, 0);
    return getCards().length;
  }

  /* ------------------------------------------- experimental: skills details */
  async function extractSkillsPage() {
    const t0 = Date.now();
    let items = [];
    const find = () => [...document.querySelectorAll('main [role="listitem"], main li')]
      .filter((el) => !el.querySelector('[role="listitem"], li'));
    while (Date.now() - t0 < 12000) {
      if (/^\/(checkpoint|authwall|login|uas\/login)/.test(location.pathname)) return { blocked: true, skills: [] };
      items = find();
      if (items.length) break;
      await sleep(500);
    }
    // load more rows if the list is lazy
    for (let i = 0; i < 4; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(500);
    }
    items = find();
    const skills = [], seen = new Set();
    for (const it of items) {
      const el = it.querySelector('p, span[aria-hidden="true"]');
      let t = clean(el ? el.textContent : '');
      if (!t || t.length > 80) continue;
      // LinkedIn renders each label twice (visible + screen-reader text): "Python Python" / "PythonPython"
      const dup = t.match(/^(.+?)\s*\1$/);
      if (dup) t = dup[1].trim();
      if (/endorse|mutual|connection|follower|^show|^see |^\d+$/i.test(t)) continue;
      const k = t.toLowerCase();
      if (!seen.has(k)) { seen.add(k); skills.push(t); }
    }
    return { blocked: false, skills };
  }

  /* ------------------------------------------------------------ paging */
  function signature() {
    return getCards().map((c) => {
      const id = c.querySelector('[id^="SearchResultssnippet"]');
      const a = c.querySelector('a[href*="/in/"]');
      return (id && id.id) || (a && a.getAttribute('href')) || clean(c.textContent).slice(0, 50);
    }).join('|');
  }

  // Click LinkedIn's own "Next" button (single-page navigation, like a human)
  function clickNext() {
    const el = document.querySelector('[data-testid="pagination-controls-next-button-visible"], button.artdeco-pagination__button--next, button[aria-label="Next"]');
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }

  // Resolves with pageInfo once the list shows a different page of results
  async function waitChange({ page, prevSig, timeout }) {
    const t0 = Date.now();
    let last = '', stable = 0;
    while (Date.now() - t0 < timeout) {
      const info = pageInfo();
      if (info.blocked) return info;
      if (info.currentPage === page && info.cardCount > 0) {
        const sig = signature();
        if (sig !== prevSig) {
          stable = sig === last ? stable + 1 : 0;
          last = sig;
          if (stable >= 2) return info;
        }
      }
      await sleep(400);
    }
    return null;
  }

  /* ----------------------------------------------------- profile reading */
  const NOISE_AFTER_NAME = /^(?:[·•]\s*)?(?:1st|2nd|3rd\+?|\d+(?:st|nd|rd|th)\s+degree connection)$|^\(?(?:he|she|they|him|her|them)\/\w+\)?$|^(?:verified|premium|·|•|open to work|hiring)$/i;

  function textLines(root) {
    const out = [];
    for (const l of (root.innerText || '').split(/\n+/).map(clean)) {
      if (l && l !== out[out.length - 1]) out.push(l); // drop consecutive repeats (visible + screen-reader copies)
    }
    return out;
  }

  function extractProfile() {
    const main = document.querySelector('main') || document.body;
    const title = document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*\|\s*LinkedIn.*$/i, '');
    const titleName = clean(title.split(/\s+[-–—]\s+/)[0]);

    let name = '';
    const h1 = main.querySelector('h1');
    if (h1 && clean(h1.textContent) && clean(h1.textContent).length <= 80) name = clean(h1.textContent);
    if (!name && titleName && !/^(linkedin|sign in|log in|join linkedin)/i.test(titleName)) name = titleName;
    name = name.replace(/\s*[·•]\s*(1st|2nd|3rd\+?)$/i, '');

    const um = location.pathname.match(/^\/in\/([^/]+)/);
    const out = { name, first_name: '', last_name: '', headline: '', position: '', company: '', location: '', url: um ? `https://www.linkedin.com/in/${um[1]}/` : location.href.split('?')[0], ok: false };
    if (!name) return out;
    const sn = splitName(name);
    out.first_name = sn.first || (/^linkedin member$/i.test(name) ? 'LinkedIn' : '');
    out.last_name = sn.last || (/^linkedin member$/i.test(name) ? 'Member' : '');

    // --- top card: name, headline, location ---
    const nameEl = [...main.querySelectorAll('h1, h2, h3, p, span, a')].find((e) => {
      const t = clean(e.textContent);
      return e.children.length <= 3 && t.startsWith(name) && t.length < name.length + 30;
    });
    let lines = [];
    let box = nameEl;
    for (let i = 0; i < 8 && box && box.parentElement; i++) {
      box = box.parentElement;
      lines = textLines(box);
      if (lines.some((l) => /contact info/i.test(l))) break;
    }
    const idx = lines.findIndex((l) => l.startsWith(name));
    const after = (idx >= 0 ? lines.slice(idx + 1) : lines).filter((l) => !NOISE_AFTER_NAME.test(l));
    const ci = after.findIndex((l) => /contact info/i.test(l));
    out.headline = after.find((l) => !/contact info/i.test(l)) || '';
    if (ci >= 0) {
      const same = clean(after[ci].replace(/[\s·•]*contact info.*$/i, ''));
      out.location = same || (ci > 0 ? after[ci - 1] : '');
      if (out.location === out.headline) out.location = '';
    }

    // --- company ---
    const aria = [...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).find((a) => /^Current company/i.test(a));
    const am = aria && aria.match(/Current company:\s*([^.]+?)\./i);
    if (am) out.company = clean(am[1]);

    // --- experience (first entry) ---
    let expTitle = '', expCompany = '';
    const heading = [...main.querySelectorAll('h2, h3, p, span, div')].find((e) => e.children.length === 0 && /^Experience$/i.test(clean(e.textContent)));
    const section = heading && (heading.closest('section') || heading.parentElement.parentElement.parentElement);
    if (section) {
      const item = [...section.querySelectorAll('[role="listitem"], li')][0];
      if (item) {
        const l = textLines(item);
        const looksType = /^(full-time|part-time|self-employed|freelance|contract|internship|apprenticeship|seasonal)\b|^\d+\s*(yrs?|mos?)\b/i;
        if (l.length > 1 && (looksType.test(l[1]) || /^\d+\s*(yrs?|mos?)/i.test(l[1]))) {
          expCompany = l[0];                     // grouped roles: company first
          expTitle = l[2] || '';
        } else if (l.length > 1) {
          expTitle = l[0];
          expCompany = clean(l[1].split('·')[0]);
        }
      }
    }
    if (!out.company) out.company = expCompany;
    if (!out.company) {
      const hm = out.headline.match(/(?:\bat\b|@)\s+(.+?)(?:\s*[|·•,]|$)/i);
      if (hm) out.company = clean(hm[1]);
    }
    out.position = expTitle || out.headline;
    out.ok = true;
    return out;
  }

  // True when LinkedIn served a "page doesn't exist" / 404 for this URL
  function isNotFound() {
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav && nav.responseStatus === 404) return true;
    } catch (e) { /* older Chrome */ }
    if (/^\/(404|in\/unavailable)/.test(location.pathname)) return true;
    const head = document.title + ' ' + (((document.querySelector('main') || document.body).innerText || '').slice(0, 700));
    return /page (doesn['’]t|does not) exist|page not found|this page is not available|profile (is )?(not available|unavailable)|couldn['’]t find (that|this) (page|profile)/i.test(head);
  }

  // Waits for a profile page to render, nudges lazy sections, then reads it
  async function readProfile(timeout = 22000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (/^\/(checkpoint|authwall|login|uas\/login)/.test(location.pathname)) return { blocked: true, ok: false };
      if (isNotFound()) return { notFound: true, blocked: false, ok: false };
      const main = document.querySelector('main');
      if (main && (main.querySelector('h1') || (main.innerText || '').length > 300)) break;
      await sleep(500);
    }
    await sleep(800);
    // LinkedIn swaps member-ID links (/in/ACoAA…) for the public vanity link once the page has loaded
    for (let i = 0; i < 6 && /^\/in\/ACo/.test(location.pathname); i++) await sleep(500);
    for (let i = 0; i < 3; i++) { window.scrollBy(0, 700); await sleep(450); }
    const main = document.querySelector('main');
    if (main) main.scrollTo && main.scrollTo(0, 0);
    window.scrollTo(0, 0);
    await sleep(300);
    if (isNotFound()) return { notFound: true, blocked: false, ok: false };
    const r = extractProfile();
    r.blocked = false;
    r.notFound = false;
    return r;
  }

  /* ------------------------------------------------------------ diagnostics */
  function skeleton(el, max = 3500) {
    const c = el.cloneNode(true);
    c.querySelectorAll('script, style, svg, img, picture').forEach((n) => n.remove());
    const walk = (n) => {
      if (n.nodeType === 3) { n.textContent = n.textContent.replace(/\S+/g, (w) => w.slice(0, 3) + '…'); return; }
      if (n.nodeType !== 1) return;
      [...n.attributes].forEach((at) => {
        if (!/^(data-view-name|data-testid|role|id|href|aria-label)$/.test(at.name)) n.removeAttribute(at.name);
        else if (at.name === 'href') n.setAttribute('href', at.value.replace(/^https?:\/\/[^/]+/, '').split('?')[0].slice(0, 40));
        else if (at.name === 'id') n.setAttribute('id', at.value.slice(0, 24));
      });
      n.childNodes.forEach(walk);
    };
    walk(c);
    return c.outerHTML.replace(/\s+/g, ' ').slice(0, max);
  }

  function diagnose() {
    const q = (s) => { try { return document.querySelectorAll(s).length; } catch (e) { return -1; } };
    const names = {};
    document.querySelectorAll('[data-view-name]').forEach((n) => { const k = n.getAttribute('data-view-name'); names[k] = (names[k] || 0) + 1; });
    const topNames = Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 30);
    let shadowHosts = 0;
    document.querySelectorAll('*').forEach((n) => { if (n.shadowRoot) shadowHosts++; });
    const inLinks = [...document.querySelectorAll('a[href*="/in/"]')].slice(0, 5).map((a) => a.getAttribute('href').replace(/^https?:\/\/[^/]+/, '').split('?')[0].slice(0, 60));
    const first = document.querySelector(PRIMARY) || document.querySelector('[id^="SearchResultssnippet"]') || document.querySelector('main [role="listitem"]') || document.querySelector('main li');
    const card = first ? cardFromNode(first) : null;
    return JSON.stringify({
      extensionVersion: chrome.runtime.getManifest().version,
      path: location.pathname,
      pageParam: new URL(location.href).searchParams.get('page'),
      readyState: document.readyState,
      scroll: { y: Math.round(window.scrollY), viewport: window.innerHeight, docHeight: document.documentElement.scrollHeight },
      counts: {
        peopleSearchResult: q(PRIMARY), snippetIds: q('[id^="SearchResultssnippet"]'), classicResults: q('li.reusable-search__result-container'),
        main: q('main'), roleListitem: q('[role="listitem"]'), li: q('li'), anchorsIn: q('a[href*="/in/"]'),
        iframes: q('iframe'), shadowHosts, paginationButtons: q('[data-testid^="pagination-indicator"], .artdeco-pagination__indicator--number'),
      },
      cardsFound: getCards().length,
      pageInfo: pageInfo(),
      dataViewNames: topNames,
      sampleProfileLinks: inLinks,
      firstCardSkeleton: card ? skeleton(card) : null,
      profileGuess: location.pathname.startsWith('/in/') ? extractProfile() : undefined,
      profileTopLines: location.pathname.startsWith('/in/') ? textLines(document.querySelector('main') || document.body).slice(0, 40) : undefined,
    }, null, 1);
  }

  window.__lse = { v: 3, extract, pageInfo, waitReady, autoScroll, extractSkillsPage, diagnose, signature, clickNext, waitChange, readProfile };
})();
