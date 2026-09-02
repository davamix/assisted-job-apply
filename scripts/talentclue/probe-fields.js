// TalentClue reconnaissance: dump the live application form's controls so a job's
// answers.json can be built against real ids/options.
//
// TalentClue is a Drupal ATS (form_id `cv_node_form`); the apply form lives at
// /<lang>/node/add/cv/job/<jobId>/company/<companyId>/<token>?clicked_button=apply_manually,
// reached from the job page's "Inscríbete" link. Most controls are plain Drupal inputs, but
// País and Formación are **Simple Hierarchical Select (SHS)** widgets that only exist after
// JS runs, so a static fetch cannot see their options — hence this probe.
//
//   node scripts/talentclue/probe-fields.js --url <apply-url> [--headed]
const { chromium } = require('@playwright/test');

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

(async () => {
  const a = parseArgs(process.argv);
  if (!a.url) { console.error('missing --url'); process.exit(2); }
  const browser = await chromium.launch({
    headless: !a.headed,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, locale: 'es-ES' });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();
  await page.goto(a.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const out = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const labelFor = (el) => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return norm(l.textContent);
      }
      const w = el.closest('.form-item, .control-group');
      const l = w && w.querySelector('label');
      return l ? norm(l.textContent) : '';
    };
    const controls = [];
    document.querySelectorAll('input, select, textarea').forEach((el) => {
      if (el.type === 'hidden') return;
      const rec = {
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        id: el.id || null,
        name: el.getAttribute('name'),
        label: labelFor(el),
        required: el.required || /required/.test(el.className) || /form-required/.test((el.closest('.form-item, .control-group') || el).innerHTML || ''),
        visible: !!(el.offsetParent || el.getClientRects().length),
        cls: el.className || '',
      };
      if (el.tagName === 'SELECT') {
        rec.options = Array.from(el.options).map((o) => ({ v: o.value, t: norm(o.textContent) })).slice(0, 60);
        rec.optionCount = el.options.length;
      }
      controls.push(rec);
    });
    return {
      title: document.title,
      url: location.href,
      controls,
      shsWrappers: Array.from(document.querySelectorAll('[class*="shs"]')).map((e) => norm(e.className)).slice(0, 20),
      recaptcha: !!document.querySelector('.g-recaptcha, [src*="recaptcha"], textarea[name="g-recaptcha-response"]'),
      cookieBanner: Array.from(document.querySelectorAll('button, a')).map((e) => norm(e.textContent)).filter((t) => /aceptar|accept|cookies|consent/i.test(t)).slice(0, 8),
      fileInputs: Array.from(document.querySelectorAll('input[type=file]')).map((e) => ({ id: e.id, name: e.name, label: labelFor(e) })),
      submits: Array.from(document.querySelectorAll('input[type=submit], button[type=submit], button')).map((e) => norm(e.value || e.textContent)).filter(Boolean).slice(0, 12),
    };
  });
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
