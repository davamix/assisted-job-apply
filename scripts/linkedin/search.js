// Scrape one LinkedIn Jobs search (remote) into JSON job cards.
// Usage:
//   node scripts/linkedin/search.js --keywords ".NET AI Engineer" \
//        --location "Spain" --geoId 105646813 --tpr r604800 --remote \
//        --start 0 --max 25 [--headed] [--out file.json]
// Prints a JSON array of { source_job_id, role, company, location, url } to stdout.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = { remote: false, headed: false, tpr: 'r604800', start: '0', max: '25' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--remote') a.remote = true;
    else if (k === '--headed') a.headed = true;
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  return a;
}

function buildUrl(a) {
  const p = new URLSearchParams();
  if (a.keywords) p.set('keywords', a.keywords);
  if (a.location) p.set('location', a.location);
  if (a.geoId) p.set('geoId', a.geoId);
  if (a.remote) p.set('f_WT', '2');          // 2 = Remote
  if (a.tpr) p.set('f_TPR', a.tpr);          // r604800 = past week, r86400 = 24h
  p.set('start', a.start || '0');
  return 'https://www.linkedin.com/jobs/search/?' + p.toString();
}

(async () => {
  const a = parseArgs(process.argv);
  const authFile = a.auth || path.join(__dirname, '..', '..', '.auth', 'linkedin-state.json');
  const url = buildUrl(a);

  const browser = await chromium.launch({ headless: !a.headed });
  const context = await browser.newContext({
    storageState: authFile,
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  if (/\/login|\/authwall|\/checkpoint/.test(page.url())) {
    console.error(JSON.stringify({ error: 'session_invalid', url: page.url() }));
    await browser.close();
    process.exit(3);
  }

  // The results list is virtualized — scroll the scrollable list container and collect cards
  // at every step (cards scrolled past can be unmounted, so extracting only at the end loses them).
  // Two layouts are handled:
  //  - new UI (/jobs/search-results/, seen 2026-09): /jobs/search/ redirects there. Cards are
  //    div[role=button][componentkey="job-card-component-ref-<jobId>"], no /jobs/view/ links;
  //    <p>s in order = title, company, location. Scroller = [data-testid="lazy-column"].
  //  - old UI: li[data-occludable-job-id] / div.job-card-container[data-job-id] with class hooks.
  const max = parseInt(a.max, 10) || 25;
  const jobs = await page.evaluate(async (max) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const clean = (s) => (s || '').trim().replace(/\s+/g, ' ') || null;
    const text = (el, sels) => {
      for (const s of sels) {
        const n = el.querySelector(s);
        if (n && n.textContent.trim()) return clean(n.textContent);
      }
      return null;
    };
    const NEW_KEY = 'job-card-component-ref-';

    const fromNewCard = (c) => {
      const id = c.getAttribute('componentkey').slice(NEW_KEY.length);
      const ps = Array.from(c.querySelectorAll('p'));
      // On some cards the title <p> holds an accessible span ("Selected, Title (Verified job)")
      // plus an aria-hidden visual copy: drop the copy, then the screen-reader prefix/suffix.
      let role = null;
      if (ps[0]) {
        const t = ps[0].cloneNode(true);
        t.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
        role = (clean(t.textContent) || clean(ps[0].textContent) || '')
          .replace(/^Selected,\s*/, '').replace(/\s*\(Verified job\)$/, '') || null;
      }
      return { id, role, company: clean(ps[1]?.textContent), location: clean(ps[2]?.textContent) };
    };

    const fromOldCard = (c) => {
      let id = c.getAttribute('data-occludable-job-id') || c.getAttribute('data-job-id');
      const link = c.querySelector('a[href*="/jobs/view/"]');
      if (!id && link) {
        const m = link.getAttribute('href').match(/\/jobs\/view\/(\d+)/);
        if (m) id = m[1];
      }
      return {
        id,
        role: text(c, [
          '.job-card-list__title--link', '.job-card-list__title',
          'a.job-card-container__link', '.artdeco-entity-lockup__title',
        ]),
        company: text(c, [
          '.job-card-container__primary-description',
          '.artdeco-entity-lockup__subtitle', '.job-card-container__company-name',
        ]),
        location: text(c, [
          '.job-card-container__metadata-item', '.artdeco-entity-lockup__caption',
          '.job-card-container__metadata-wrapper',
        ]),
      };
    };

    const found = new Map();
    const collect = () => {
      const newCards = document.querySelectorAll(`div[role="button"][componentkey^="${NEW_KEY}"]`);
      if (newCards.length) {
        for (const c of newCards) {
          const j = fromNewCard(c);
          if (j.id && !found.has(j.id)) found.set(j.id, j);
        }
        return;
      }
      const oldSel = [
        'li[data-occludable-job-id]',
        'div.job-card-container[data-job-id]',
        'li.scaffold-layout__list-item',
        'li.jobs-search-results__list-item',
      ];
      for (const s of oldSel) {
        const cards = document.querySelectorAll(s);
        if (!cards.length) continue;
        for (const c of cards) {
          const j = fromOldCard(c);
          if (j.id && !found.has(j.id)) found.set(j.id, j);
        }
        break;
      }
    };

    const scroller =
      document.querySelector('[data-testid="lazy-column"]') ||
      document.querySelector('.jobs-search-results-list') ||
      document.querySelector('div.scaffold-layout__list > div') ||
      document.querySelector('.scaffold-layout__list') ||
      document.scrollingElement;
    collect();
    for (let i = 0; i < 12 && found.size < max; i++) {
      scroller.scrollBy(0, 800);
      window.scrollBy(0, 400);
      await sleep(500);
      collect();
    }

    return Array.from(found.values()).slice(0, max).map((j) => ({
      source_job_id: j.id,
      role: j.role,
      company: j.company,
      location: j.location,
      url: `https://www.linkedin.com/jobs/view/${j.id}/`,
    }));
  }, max);

  if (a.debugShot) await page.screenshot({ path: a.debugShot, fullPage: false });
  const result = JSON.stringify(jobs, null, 2);
  if (a.out) fs.writeFileSync(a.out, result, 'utf8');
  console.log(result);
  console.error(`[linkedin-search] ${jobs.length} cards | ${url}`);
  await browser.close();
})().catch((err) => { console.error('ERROR:', err); process.exit(1); });
