// Probe a Workday application wizard: sign in from the saved session, start the MANUAL
// apply path, and enumerate the current step's fields.
//
// Reconnaissance only — it never advances past the step it is asked for and NEVER submits.
// Note that entering the wizard at all creates a DRAFT application in the tenant; that is
// a real (reversible) side effect on the employer's system, not a submission.
//
//   node scripts/workday/probe-fields.js --url <job-apply-url> \
//        [--auth .auth/workday-iqvia-state.json] [--shot out.png]
//
// Deliberately picks "Apply Manually" over "Autofill with Resume": the parser rewrites
// experience into the application unreviewed, and the whole point of this pipeline is that
// nothing is claimed that the human did not choose.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t && t.startsWith('--')) {
      const k = t.slice(2);
      const next = argv[i + 1];
      a[k] = next && !next.startsWith('--') ? argv[++i] : true;
    }
  }
  return a;
}

const MANUAL = [
  '[data-automation-id="applyManually"]',
  'a:has-text("Apply Manually")',
  'button:has-text("Apply Manually")',
  'a:has-text("Solicitar manualmente")',
  'button:has-text("Solicitar manualmente")',
].join(', ');

(async () => {
  const a = parseArgs(process.argv);
  if (!a.url) { console.error('need --url'); process.exit(2); }
  const authFile = path.resolve(String(a.auth || path.join(__dirname, '..', '..', '.auth', 'workday-iqvia-state.json')));
  if (!fs.existsSync(authFile)) { console.error('auth file not found:', authFile); process.exit(2); }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: authFile, viewport: { width: 1440, height: 1100 } });
  const page = await ctx.newPage();
  await page.goto(String(a.url), { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(4000);

  console.log('LANDED:', page.url());
  console.log('TITLE:', await page.title());

  const manual = page.locator(MANUAL).first();
  if (await manual.count()) {
    await manual.click({ timeout: 8000 }).catch(e => console.log('MANUAL CLICK ERR:', String(e).slice(0, 120)));
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(5000);
    console.log('AFTER_MANUAL:', page.url());
  } else {
    console.log('NOTE: no "Apply Manually" control found on this page.');
  }

  const info = await page.evaluate(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const labelFor = (el) => {
      let t = '';
      const id = el.getAttribute('id');
      if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) t = norm(l.textContent); }
      if (!t) { const l = el.closest('label'); if (l) t = norm(l.textContent); }
      if (!t) t = norm(el.getAttribute('aria-label'));
      if (!t) {
        const lb = el.getAttribute('aria-labelledby');
        if (lb) {
          const parts = lb.split(/\s+/).map(i => document.getElementById(i)).filter(Boolean);
          t = norm(parts.map(p => p.textContent).join(' '));
        }
      }
      return t;
    };
    const fields = [];
    document.querySelectorAll('input, select, textarea').forEach(el => {
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (['hidden', 'submit', 'image'].includes(type)) return;
      fields.push({
        type,
        automationid: el.getAttribute('data-automation-id') || null,
        id: el.getAttribute('id') || null,
        name: el.getAttribute('name') || null,
        required: el.required || el.getAttribute('aria-required') === 'true' || null,
        label: labelFor(el),
      });
    });
    const buttons = [...document.querySelectorAll('button, a[role=button], [role=button]')]
      .map(b => ({ text: norm(b.getAttribute('aria-label') || b.textContent), aid: b.getAttribute('data-automation-id') }))
      .filter(b => b.text && b.text.length < 45);
    // Workday marks the wizard's progress rail with its own automation ids.
    const steps = [...document.querySelectorAll('[data-automation-id*="progressBar" i] *, [data-automation-id="progressBarStep"], nav li')]
      .map(e => norm(e.textContent)).filter(t => t && t.length < 40);
    return {
      fieldCount: fields.length,
      fields,
      buttons: buttons.slice(0, 30),
      steps: [...new Set(steps)].slice(0, 15),
      heading: norm((document.querySelector('h1, h2, [data-automation-id="pageHeader"]') || {}).textContent || ''),
    };
  });

  console.log('HEADING:', info.heading);
  console.log('STEPS:', JSON.stringify(info.steps));
  console.log('FIELD_COUNT:', info.fieldCount);
  console.log('FIELDS:', JSON.stringify(info.fields, null, 2));
  console.log('BUTTONS:', JSON.stringify(info.buttons, null, 2));

  if (a.shot) await page.screenshot({ path: String(a.shot), fullPage: true }).catch(() => {});
  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
