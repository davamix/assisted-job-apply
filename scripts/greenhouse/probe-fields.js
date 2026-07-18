// Probe a Greenhouse application form, then enumerate it. Reconnaissance only —
// read-only, headless. Prints the field list as JSON so a per-job answers.json
// (identity + screening/custom questions + upload slots) can be built. See apply.js.
//
// Greenhouse is reached via the LinkedIn / careers "Apply" link. Company careers
// front-ends (e.g. Fever's careers.feverup.com) render the Greenhouse form either
// on their own domain (…/jobs/<id>/…/apply/?gh_jid=<id>) or inside a Greenhouse
// iframe (job-boards.greenhouse.io / boards.greenhouse.io/embed/job_app). This probe
// dumps whichever it finds, and reports any iframe so the adapter can descend into it.
//
//   node scripts/greenhouse/probe-fields.js <apply-url>
const { chromium } = require('@playwright/test');

async function acceptCookies(page) {
  for (const t of ['Accept all', 'Accept All', 'Aceptar todas', 'Aceptar todo', 'Accept', 'Aceptar', 'Allow all', 'Got it', 'I agree']) {
    const b = page.locator(`button:has-text("${t}")`).first();
    if (await b.count()) { await b.click({ timeout: 3000 }).catch(() => {}); return t; }
  }
  return null;
}

// The DOM-walking enumerator, run in whichever frame holds the form.
function enumerate() {
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const labelFor = (el) => {
    let t = '';
    const id = el.getAttribute('id');
    if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) t = norm(l.textContent); }
    if (!t) { const l = el.closest('label'); if (l) t = norm(l.textContent); }
    if (!t) t = norm(el.getAttribute('aria-label'));
    if (!t && el.getAttribute('aria-labelledby')) {
      const lab = document.getElementById(el.getAttribute('aria-labelledby'));
      if (lab) t = norm(lab.textContent);
    }
    if (!t) {
      let p = el.closest('div,fieldset,li,section'); let hops = 0;
      while (p && hops < 3 && !t) {
        const lab = p.querySelector('label, legend, [class*="label" i]');
        if (lab && lab !== el) t = norm(lab.textContent);
        p = p.parentElement; hops++;
      }
    }
    return t;
  };

  const fields = [];
  document.querySelectorAll('input, select, textarea').forEach(el => {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (['submit', 'button', 'image'].includes(type)) return;
    fields.push({
      tag: el.tagName.toLowerCase(),
      type,
      id: el.getAttribute('id') || null,
      name: el.getAttribute('name') || null,
      placeholder: el.getAttribute('placeholder') || null,
      required: el.required || el.getAttribute('aria-required') === 'true' || null,
      hidden: type === 'hidden' || el.offsetParent === null || null,
      autocomplete: el.getAttribute('autocomplete') || null,
      label: labelFor(el),
      options: el.tagName === 'SELECT' ? Array.from(el.options).map(o => norm(o.textContent)).slice(0, 20) : null,
    });
  });

  // Greenhouse custom questions: <div ...><label>Question</label> <input/select/textarea>…
  // Newer boards name them question_<id> or job_application[answers_attributes][N][...].
  const customQuestions = fields
    .filter(f => /question_\d+|answers_attributes|job_application\[/.test(f.name || '') || /question_\d+/.test(f.id || ''))
    .map(f => ({ tag: f.tag, type: f.type, id: f.id, name: f.name, required: f.required, label: f.label, options: f.options }));

  const fileInputs = Array.from(document.querySelectorAll('input[type=file]')).map(el => ({
    id: el.getAttribute('id') || null,
    name: el.getAttribute('name') || null,
    accept: el.getAttribute('accept') || null,
    label: labelFor(el),
  }));

  // Greenhouse upload widgets often hide the real file input and show Attach/Dropbox/Paste
  // buttons; capture nearby section headings so the CV-vs-Résumé classifier has wording.
  const uploadSections = Array.from(document.querySelectorAll('label, h2, h3, h4, [class*="label" i]'))
    .map(e => norm(e.textContent))
    .filter(t => /resume|résumé|cv|cover letter/i.test(t) && t.length < 60);

  const buttons = Array.from(document.querySelectorAll('button, a[role=button], input[type=submit], [role=button]'))
    .map(b => norm(b.getAttribute('aria-label') || b.value || b.textContent))
    .filter(t => t && t.length < 40);

  return {
    url: location.href,
    fieldCount: fields.length,
    fields,
    customQuestions,
    fileInputs,
    uploadSections: [...new Set(uploadSections)],
    buttons: [...new Set(buttons)].slice(0, 40),
  };
}

(async () => {
  const url = process.argv[2];
  if (!url) { console.error('need an apply url'); process.exit(2); }
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const cookie = await acceptCookies(page);
  await page.waitForTimeout(1500);

  // If the apply link only reveals the form after a click, try common apply triggers.
  for (const sel of ['a:has-text("Apply")', 'button:has-text("Apply")', 'a:has-text("Apply for this job")']) {
    if (await page.locator('input[name="first_name"], #first_name').count()) break;
    const b = page.locator(sel).first();
    if (await b.count()) { await b.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(3000); }
  }

  // Report the frame tree so we know whether the form is embedded in a Greenhouse iframe.
  const frames = page.frames().map(f => ({ name: f.name(), url: f.url() }));

  // Enumerate the main document plus every child frame; the form lives in exactly one.
  const results = [];
  for (const frame of page.frames()) {
    try {
      const info = await frame.evaluate(enumerate);
      if (info.fieldCount > 0) results.push({ frameUrl: frame.url(), ...info });
    } catch (e) { /* cross-origin frame we can't read — note via frames[] above */ }
  }

  const html = await page.content();
  const markers = {
    greenhouse: /greenhouse|gh_jid|grnhse|job_application|s3_upload_for/i.test(html),
    turnstile: /turnstile|cf-challenge/i.test(html),
    recaptcha: /recaptcha|g-recaptcha/i.test(html),
    hcaptcha: /hcaptcha/i.test(html),
  };

  console.log('COOKIE_ACCEPTED:', cookie);
  console.log('FRAMES:', JSON.stringify(frames, null, 2));
  console.log('MARKERS:', JSON.stringify(markers));
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
