// Fetch triage detail for one LinkedIn job. LinkedIn's logged-in markup uses hashed
// class names, so we anchor on stable signals: the "About the job" heading (its next
// sibling holds the description) and the apply button's aria-label.
// Usage: node scripts/linkedin-job-detail.js --id 4436660607 [--headed] [--captureExternal]
// title/company are taken from the search card upstream; this returns description, apply
// state, salary hint, and open/closed/already-applied flags.
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
  const authFile = a.auth || path.join(__dirname, '..', '.auth', 'linkedin-state.json');
  const url = `https://www.linkedin.com/jobs/view/${a.id}/`;

  const browser = await chromium.launch({ headless: !a.headed });
  const context = await browser.newContext({
    storageState: authFile,
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  if (/\/login|\/authwall|\/checkpoint/.test(page.url())) {
    console.error(JSON.stringify({ error: 'session_invalid', url: page.url() }));
    await browser.close();
    process.exit(3);
  }

  // Expand truncated description.
  for (const re of [/see more/i, /ver más/i, /mostrar más/i]) {
    try {
      const b = page.getByRole('button', { name: re }).first();
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
    let descEl = null, best = 0;
    main.querySelectorAll('div, h2, h3, section, span').forEach((el) => {
      if (bad(el) || !HEAD_RE.test(norm(el.textContent))) return;
      const sib = el.nextElementSibling;
      const len = sib ? (sib.innerText || '').length : 0;
      if (len > best) { best = len; descEl = sib; }
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

    // --- Apply button (primary <button> in main, not the sidebar).
    let apply_label = null;
    const buttons = Array.from(main.querySelectorAll('button')).filter((b) => !bad(b));
    const applyBtn = buttons.find((b) => {
      const l = norm(b.getAttribute('aria-label') || b.textContent);
      return l.length < 60 && /easy apply|apply|solicit/i.test(l);
    });
    if (applyBtn) apply_label = norm(applyBtn.getAttribute('aria-label') || applyBtn.textContent);

    const mainText = main.innerText || '';
    const already_applied = /Application submitted|Solicitud enviada/i.test(mainText) ||
      (apply_label ? /^applied\b/i.test(apply_label) : false);
    const closed = /No longer accepting applications|Ya no se aceptan solicitudes/i.test(mainText);

    let apply_type = 'unknown';
    if (closed) apply_type = 'closed';
    else if (apply_label && /easy apply|solicitud (sencilla|simplificada)/i.test(apply_label)) apply_type = 'easy_apply';
    else if (apply_label && /\bapply\b|solicitar/i.test(apply_label)) apply_type = 'external';
    else if (already_applied) apply_type = 'already_applied';

    // --- Salary hint from the description text.
    const salaryRe = /(€|\bEUR\b|\$|\bUSD\b|£|\bGBP\b)\s?[\d.,]{2,}[^\n.]{0,40}|[\d.,]{2,}\s?(€|EUR|k\/year|per year|al año|anual|bruto)/i;
    const salary_hint = description ? (description.match(salaryRe) || [null])[0] : null;

    return { description, apply_type, apply_label, already_applied, closed, salary_hint };
  });

  // Best-effort external destination capture (no submission).
  let external_url = null, external_domain = null;
  if (a.captureExternal && data.apply_type === 'external') {
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

  const out = { source_job_id: String(a.id), url, ...data, external_url, external_domain };
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((err) => { console.error('ERROR:', err); process.exit(1); });
