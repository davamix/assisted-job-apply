// Fetch triage detail for one LinkedIn job. LinkedIn's logged-in markup uses hashed
// class names, so we anchor on stable signals: the "About the job" heading (its next
// sibling holds the description) and the apply control's aria-label.
// Usage: node scripts/linkedin/job-detail.js --id 4436660607 [--headed] [--captureExternal]
// title/company are taken from the search card upstream; this returns description, apply
// state (and the external URL when the control is a link), salary hint, LinkedIn's salary
// band and applicant count from the job header, and open/closed/already-applied flags.
const { chromium } = require('@playwright/test');
const path = require('path');

function parseArgs(argv) {
  const a = { headed: false, captureExternal: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--headed') a.headed = true;
    else if (k === '--captureExternal') a.captureExternal = true;
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  return a;
}

(async () => {
  const a = parseArgs(process.argv);
  if (!a.id) { console.error(JSON.stringify({ error: 'missing --id' })); process.exit(2); }
  const authFile = a.auth || path.join(__dirname, '..', '..', '.auth', 'linkedin-state.json');
  const url = `https://www.linkedin.com/jobs/view/${a.id}/`;

  const browser = await chromium.launch({ headless: !a.headed });
  const context = await browser.newContext({
    storageState: authFile,
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });

  if (/\/login|\/authwall|\/checkpoint/.test(page.url())) {
    console.error(JSON.stringify({ error: 'session_invalid', url: page.url() }));
    await browser.close();
    process.exit(3);
  }

  // The job header (apply control, "No longer accepting applications", salary band) renders
  // after the description. A fixed 3 s wait read it too early and reported a closed posting as
  // open, so wait until the description heading AND an apply/closed/applied marker are on the page.
  await page.waitForFunction(() => {
    const t = document.body.innerText || '';
    return /About the job|Sobre el empleo|Acerca del (empleo|puesto)|Descripción del empleo/i.test(t) &&
      /Easy Apply|\bApply\b|Solicitar|No longer accepting|Ya no se aceptan|Application submitted|Solicitud enviada/i.test(t);
  }, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);

  // Expand truncated description. Buttons inside <main> only: links labelled "more" navigate
  // away to the company page or the feed.
  for (const re of [/see more/i, /show more/i, /…\s*more/i, /ver más/i, /mostrar más/i]) {
    try {
      const b = page.locator('main').getByRole('button', { name: re }).first();
      if (await b.isVisible({ timeout: 800 })) await b.click();
    } catch {}
  }
  await page.waitForTimeout(400);

  const data = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const main = document.querySelector('main') || document.body;
    const bad = (el) => el.closest('aside, nav, header, footer');

    // --- Description: "About the job" heading → next sibling with the most text.
    const HEAD_RE = /^(About the job|Sobre el empleo|Acerca del (empleo|puesto)|Descripción del empleo)$/i;
    let descEl = null, headEl = null, best = 0;
    main.querySelectorAll('div, h2, h3, section, span').forEach((el) => {
      if (bad(el) || !HEAD_RE.test(norm(el.textContent))) return;
      const sib = el.nextElementSibling;
      const len = sib ? (sib.innerText || '').length : 0;
      if (len > best) { best = len; descEl = sib; headEl = el; }
    });
    let description = descEl ? descEl.innerText.trim() : null;

    // Fallback: largest cohesive block, skipping recommendation/promo chrome.
    if (!description || description.length < 120) {
      const blocks = [];
      main.querySelectorAll('p, div').forEach((el) => {
        if (bad(el)) return;
        const txt = el.innerText || '';
        if (txt.length > 300 && txt.length < 12000 && !/More jobs|Use AI to assess|People you can reach/i.test(txt)) {
          blocks.push(el);
        }
      });
      if (blocks.length) {
        blocks.sort((x, y) => x.querySelectorAll('div').length - y.querySelectorAll('div').length);
        description = blocks[0].innerText.trim();
      }
    }

    // --- Header: everything on the page before the description heading. On some layouts it
    // sits outside <main>, so read it from the body. It holds the closed notice, LinkedIn's
    // salary band and the applicant count; the similar-jobs list comes after the description.
    const bodyText = document.body.innerText || '';
    const hIdx = bodyText.search(/About the job|Sobre el empleo|Acerca del (empleo|puesto)|Descripción del empleo/i);
    const preDesc = hIdx > 0 ? bodyText.slice(0, hIdx) : bodyText;
    const promo = preDesc.search(/Use AI to assess|Get AI-powered advice|Show match details/i);
    const header = norm((promo > 0 ? preDesc.slice(0, promo) : preDesc).slice(-400)) || null;

    // --- Apply control: a <button> OR an <a> ("Apply on company website", "Easy Apply to
    // this job"), the first one that precedes the description heading, so the similar-jobs
    // cards further down never match.
    let apply_label = null, apply_href = null;
    const before = (el) => !headEl || !!(headEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
    const applyEl = Array.from(document.querySelectorAll('button, a')).find((el) => {
      if (el.closest('aside, nav, footer') || !before(el)) return false;
      const l = norm(el.getAttribute('aria-label') || el.textContent);
      return l.length < 60 && /easy apply|apply|solicit/i.test(l);
    });
    if (applyEl) {
      apply_label = norm(applyEl.getAttribute('aria-label') || applyEl.textContent);
      const href = applyEl.tagName === 'A' ? applyEl.getAttribute('href') : null;
      if (href) {
        try {
          // External links go through linkedin.com/safety/go/?url=<target>.
          const u = new URL(href, location.origin);
          apply_href = (/\/safety\/go/.test(u.pathname) && u.searchParams.get('url')) || u.href;
        } catch {}
      }
    }

    const already_applied = /Application submitted|Solicitud enviada/i.test(preDesc) ||
      (apply_label ? /^applied\b/i.test(apply_label) : false);
    const closed = /No longer accepting applications|Ya no se aceptan solicitudes/i.test(preDesc);

    let apply_type = 'unknown';
    if (closed) apply_type = 'closed';
    else if (apply_label && (/easy apply|solicitud (sencilla|simplificada)/i.test(apply_label) ||
      /openSDUIApplyFlow/.test(apply_href || ''))) apply_type = 'easy_apply';
    else if (apply_label && /\bapply\b|solicitar/i.test(apply_label)) apply_type = 'external';
    else if (already_applied) apply_type = 'already_applied';

    // --- LinkedIn's own salary band ("25K EUR/yr - 35K EUR/yr + Bonus") and applicant count.
    const bandRe = /[€$£]?\s?\d[\d.,]*\s?K?\s?(?:EUR|USD|GBP)?\/(?:yr|hr|mo)(?:\s*-\s*[€$£]?\s?\d[\d.,]*\s?K?\s?(?:EUR|USD|GBP)?\/(?:yr|hr|mo))?(?:\s*\+\s*[A-Za-z]+)?/i;
    const salary_band = norm((preDesc.match(bandRe) || [''])[0]) || null;
    const applicants = (preDesc.match(/(?:Over )?\d[\d,]* (?:applicants|people clicked apply)/i) || [null])[0];

    // --- Salary hint from the description text.
    const salaryRe = /(€|\bEUR\b|\$|\bUSD\b|£|\bGBP\b)\s?[\d.,]{2,}[^\n.]{0,40}|[\d.,]{2,}\s?(€|EUR|k\/year|per year|al año|anual|bruto)/i;
    const salary_hint = description ? (description.match(salaryRe) || [null])[0] : null;

    return { description, apply_type, apply_label, apply_href, already_applied, closed, salary_hint, salary_band, applicants, header };
  });

  // External destination: the link's own href when the control is an <a>; otherwise
  // (--captureExternal) click the button and read the page it opens (no submission).
  const { apply_href, ...fields } = data;
  let external_url = null, external_domain = null;
  if (data.apply_type === 'external' && apply_href) {
    try {
      const host = new URL(apply_href).hostname.replace(/^www\./, '');
      if (!/(^|\.)linkedin\.com$/i.test(host)) { external_url = apply_href; external_domain = host; }
    } catch {}
  }
  if (!external_url && a.captureExternal && data.apply_type === 'external') {
    try {
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 6000 }).catch(() => null),
        page.getByRole('button', { name: /apply|solicitar/i }).first().click({ timeout: 4000 }).catch(() => {}),
      ]);
      const target = popup || page;
      await target.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
      external_url = target.url();
      try { external_domain = new URL(external_url).hostname.replace(/^www\./, ''); } catch {}
      if (popup) await popup.close().catch(() => {});
    } catch {}
  }

  const out = { source_job_id: String(a.id), url, ...fields, external_url, external_domain };
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((err) => { console.error('ERROR:', err); process.exit(1); });
