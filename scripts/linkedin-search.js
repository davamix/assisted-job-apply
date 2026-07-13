// Scrape one LinkedIn Jobs search (remote) into JSON job cards.
// Usage:
//   node scripts/linkedin-search.js --keywords ".NET AI Engineer" \
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
  const authFile = a.auth || path.join(__dirname, '..', '.auth', 'linkedin-state.json');
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

  // The results list is virtualized — scroll the scrollable list container to load cards.
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const findScroller = () =>
      document.querySelector('.jobs-search-results-list') ||
      document.querySelector('div.scaffold-layout__list > div') ||
      document.querySelector('.scaffold-layout__list') ||
      document.scrollingElement;
    const scroller = findScroller();
    for (let i = 0; i < 12; i++) {
      scroller.scrollBy(0, 800);
      window.scrollBy(0, 400);
      await sleep(500);
    }
    scroller.scrollTo(0, 0);
    await sleep(400);
  });

  const max = parseInt(a.max, 10) || 25;
  const jobs = await page.evaluate((max) => {
    const text = (el, sels) => {
      for (const s of sels) {
        const n = el.querySelector(s);
        if (n && n.textContent.trim()) return n.textContent.trim().replace(/\s+/g, ' ');
      }
      return null;
    };
    const cardSel = [
      'li[data-occludable-job-id]',
      'div.job-card-container[data-job-id]',
      'li.scaffold-layout__list-item',
      'li.jobs-search-results__list-item',
    ];
    let cards = [];
    for (const s of cardSel) {
      cards = Array.from(document.querySelectorAll(s));
      if (cards.length) break;
    }
    const out = [];
    const seen = new Set();
    for (const c of cards) {
      let id = c.getAttribute('data-occludable-job-id') || c.getAttribute('data-job-id');
      const link = c.querySelector('a[href*="/jobs/view/"]');
      if (!id && link) {
        const m = link.getAttribute('href').match(/\/jobs\/view\/(\d+)/);
        if (m) id = m[1];
      }
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const role = text(c, [
        '.job-card-list__title--link', '.job-card-list__title',
        'a.job-card-container__link', '.artdeco-entity-lockup__title',
      ]);
      const company = text(c, [
        '.job-card-container__primary-description',
        '.artdeco-entity-lockup__subtitle', '.job-card-container__company-name',
      ]);
      const location = text(c, [
        '.job-card-container__metadata-item', '.artdeco-entity-lockup__caption',
        '.job-card-container__metadata-wrapper',
      ]);
      out.push({
        source_job_id: id,
        role,
        company,
        location,
        url: `https://www.linkedin.com/jobs/view/${id}/`,
      });
      if (out.length >= max) break;
    }
    return out;
  }, max);

  if (a.debugShot) await page.screenshot({ path: a.debugShot, fullPage: false });
  const result = JSON.stringify(jobs, null, 2);
  if (a.out) fs.writeFileSync(a.out, result, 'utf8');
  console.log(result);
  console.error(`[linkedin-search] ${jobs.length} cards | ${url}`);
  await browser.close();
})().catch((err) => { console.error('ERROR:', err); process.exit(1); });
