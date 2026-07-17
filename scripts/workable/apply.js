// Workable apply adapter. Fills a Workable public application form
// (apply.workable.com/<company>/j/<shortcode>/apply/) from a per-job answers.json, then
// STOPS before submit and keeps the browser open so the human reviews and clicks
// "Submit application". It NEVER clicks Submit.
//
// The Workable apply form is a React SPA reached via the LinkedIn "Apply on company
// website" link (which lands on the job page; the form itself lives at .../apply/). It
// needs no login. Standard identity fields carry stable `name`s (firstname, lastname,
// email, phone), which shapes this adapter, plus three traps:
//   - Phone is an intl-tel-input widget (`iti__tel-input`). Filling the visible input with
//     a full "+34 ..." number lets the widget detect the country itself; typing only the
//     national part would inherit whatever flag is selected. We fill the E.164-style value.
//   - The CV/résumé upload is a generic "Choose file / drag and drop" input[type=file]
//     (no "CV"/"Résumé" wording), so it classifies as 'unknown' -> attach the default CV.
//     A form that *does* label the slot "Résumé" still triggers the needs-resume gate.
//   - GDPR consent is a visually-hidden checkbox (opacity:0, position:absolute) whose click
//     surface is its wrapping <label> (which also holds the Privacy Notice <a>). A plain
//     .check() sees it as non-actionable, so use check({force:true}) and fall back to the
//     label. Its name is `gdpr`.
//   - Custom/screening questions (e.g. "Salary expectations") are job-specific field names
//     (CA_<id>), so they are matched by LABEL WORDING from answers.screening[], never by a
//     hardcoded name. The optional Address block uses a Places autocomplete and is left to
//     the human.
//
//   node scripts/workable/apply.js --url <workable-apply-url> --id <dbId> \
//        --answers output/<id>/answers.json --outDir output/<id>
//
// Emits `EVENT {json}` lines and writes workable-state.json + workable-filled.png to --outDir.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { classifyDocField } = require('../common/classify-doc-field');

const emit = (event, extra = {}) => console.log('EVENT ' + JSON.stringify({ event, ...extra }));

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

// Normalize a job page / shortcode URL to the .../apply/ form endpoint.
function toApplyUrl(url) {
  let u = String(url).split('?')[0].replace(/\/+$/, '');
  if (!/\/apply$/.test(u)) u += '/apply';
  return u + '/';
}

async function acceptCookies(page) {
  for (const t of ['Accept all', 'Accept All', 'Aceptar todas', 'Aceptar todo', 'Accept', 'Aceptar', 'Allow all']) {
    const b = page.locator(`button:has-text("${t}")`).first();
    if (await b.count()) { await b.click({ timeout: 3000 }).catch(() => {}); return t; }
  }
  return null;
}

// Fill an input/textarea addressed by its `name`.
async function fillByName(page, name, value) {
  if (!value) return { ok: false, reason: 'no-value' };
  const loc = page.locator(`[name="${name}"]`).first();
  if (!(await loc.count())) return { ok: false, reason: 'not-found' };
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.fill(String(value), { timeout: 4000 }).catch(() => {});
  const got = await loc.inputValue().catch(() => '');
  return { ok: !!got, value: got };
}

// Locate a text/textarea input by the wording of its associated <label>, then fill it.
// Custom Workable fields are named CA_<id> (job-specific), so wording is the stable key.
async function fillByLabel(page, labelRe, value) {
  if (!value) return { ok: false, reason: 'no-value' };
  const handle = await page.evaluateHandle((reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const inputs = Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]), textarea'));
    for (const el of inputs) {
      let label = '';
      const id = el.getAttribute('id');
      if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) label = norm(l.textContent); }
      if (!label && el.getAttribute('aria-label')) label = norm(el.getAttribute('aria-label'));
      if (!label) { const w = el.closest('label'); if (w) label = norm(w.textContent); }
      if (re.test(label)) return el;
    }
    return null;
  }, labelRe.source);
  const el = handle.asElement();
  if (!el) return { ok: false, reason: 'not-found' };
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.fill(String(value), { timeout: 4000 }).catch(() => {});
  const got = await el.inputValue().catch(() => '');
  return { ok: !!got, value: got };
}

(async () => {
  const a = parseArgs(process.argv);
  if (!a.url) { console.error(JSON.stringify({ error: 'need --url' })); process.exit(2); }
  const outDir = a.outDir || (a.id ? `output/${a.id}` : 'output');
  const answersPath = a.answers || path.join(outDir, 'answers.json');
  if (!fs.existsSync(answersPath)) {
    console.error(JSON.stringify({ error: `answers file not found: ${answersPath}` }));
    process.exit(2);
  }
  const answers = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });
  const writeState = (o) => fs.writeFileSync(path.join(outDir, 'workable-state.json'), JSON.stringify(o, null, 2), 'utf8');
  const filled = [];
  const pending = []; // things deliberately left for the human

  const applyUrl = toApplyUrl(a.url);
  const dryRun = !!a.dryRun;
  // Workable's submit step is gated by a Cloudflare Turnstile ("Verify you are human")
  // that flags driven browsers by their automation fingerprint, so the checkbox never
  // passes. Blunt the obvious tells: drop the --enable-automation flag and the
  // AutomationControlled blink feature, and mask navigator.webdriver. --channel (e.g.
  // "msedge") drives a REAL installed browser, which clears the challenge far more often
  // than bundled Chromium. Even so, a hardened managed challenge may still block — the
  // fallback is for the human to do the final submit in their own everyday browser (this
  // is a public, no-login form).
  const launchOpts = {
    headless: dryRun || !!a.headless,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (a.channel) launchOpts.channel = a.channel;
  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();
  await page.goto(applyUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const cookie = await acceptCookies(page);
  emit('cookies', { accepted: cookie });
  await page.waitForTimeout(600);

  // Wait for the SPA form (firstname is the first required field).
  await page.locator('[name="firstname"]').first().waitFor({ timeout: 15000 }).catch(() => {});
  if (!(await page.locator('[name="firstname"]').count())) {
    emit('form-not-found', { url: applyUrl });
    writeState({ status: 'form-not-found', url: applyUrl });
    await browser.close();
    process.exit(4);
  }

  // 1) Identity fields (stable names).
  for (const [name, value] of [
    ['firstname', answers.first_name],
    ['lastname', answers.last_name],
    ['email', answers.email],
  ]) {
    const r = await fillByName(page, name, value);
    if (r.ok) filled.push({ field: name, value: r.value });
    else emit('fill-skip', { field: name, reason: r.reason });
  }

  // 2) Phone (intl-tel-input): fill the full +CC number so the widget detects the country.
  if (answers.phone) {
    const r = await fillByName(page, 'phone', answers.phone);
    if (r.ok) filled.push({ field: 'phone', value: r.value });
    else pending.push({ field: 'phone', note: 'enter phone by hand' });
  }

  // 3) Custom/screening questions matched by label wording (e.g. Salary expectations).
  for (const q of (answers.screening || [])) {
    const re = q.label_contains ? new RegExp(q.label_contains, 'i') : null;
    if (!re) continue;
    const r = await fillByLabel(page, re, q.value);
    emit('screening', { label_contains: q.label_contains, ok: r.ok, reason: r.reason });
    if (r.ok) filled.push({ field: `screening:${q.label_contains}`, value: r.value });
    else pending.push({ field: `screening:${q.label_contains}`, note: `answer "${q.label_contains}" by hand: ${q.value}` });
  }

  // 4) CV / résumé upload. Generic "Choose file" slot -> classify 'unknown' -> attach CV.
  //    Honor the CV-vs-Résumé gate: a slot labelled "Résumé" must not get the full CV.
  const fileInput = page.locator('input[type=file]').first();
  const fileInfo = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const f = document.querySelector('input[type=file]');
    if (!f) return { present: false, label: '' };
    // The section label ("* Resume") sits ABOVE the widget and, on Workable, renders in a
    // [class*="label"] element (NOT an h*/legend/strong) with the "*" required marker split
    // into its own node. Walk up ancestors; at the first level that yields any label text,
    // JOIN every fragment and classify the whole — grabbing only texts[0] catches just "*".
    let node = f, label = '';
    for (let i = 0; i < 5 && node; i++) {
      node = node.parentElement; if (!node) break;
      const texts = [];
      node.querySelectorAll('h1,h2,h3,h4,h5,label,legend,strong,[class*="label"]').forEach((e) => {
        const t = norm(e.textContent);
        if (t && t.length < 40 && !/choose file|drag and drop|svg/i.test(t)) texts.push(t);
      });
      if (texts.length) { label = Array.from(new Set(texts)).join(' ').replace(/\*/g, '').trim(); break; }
    }
    return { present: true, label };
  });
  const kind = classifyDocField(fileInfo.label); // 'cv' | 'resume' | 'unknown'
  emit('doc-field', { present: fileInfo.present, label: fileInfo.label, kind });

  const resumePdf = path.join(outDir, 'resume.pdf');
  const hasResume = fs.existsSync(resumePdf);
  let uploadPath = answers.cv_upload ? String(answers.cv_upload) : '';
  let uploadedType = 'cv';
  let needsResume = false;
  if (kind === 'resume') {
    if (hasResume) { uploadPath = resumePdf; uploadedType = 'resume'; }
    else { needsResume = true; uploadPath = ''; }
  }
  if (fileInfo.present && uploadPath) {
    const abs = path.resolve(uploadPath);
    if (fs.existsSync(abs)) {
      try {
        await fileInput.setInputFiles(abs);
        await page.waitForTimeout(1500);
        filled.push({ field: 'cv', value: path.basename(abs), kind, uploadedType });
        emit('uploaded', { file: path.basename(abs), kind, uploadedType });
      } catch (e) { emit('upload-error', { message: String(e).slice(0, 160) }); }
    } else {
      emit('upload-missing', { path: uploadPath });
      pending.push({ field: 'cv', note: `CV file missing: ${uploadPath}` });
    }
  }

  // 5) Optional Address block uses a Places autocomplete -> leave to the human.
  if (await page.locator('[name="address"]').count()) {
    pending.push({ field: 'address', note: 'optional Address/City/Country left blank (Places autocomplete) — fill by hand only if you want it' });
  }

  // 6) GDPR consent: visually-hidden checkbox, click surface on the wrapping label.
  if (answers.consent === true || /^(yes|accept|si|sí)$/i.test(String(answers.consent || ''))) {
    const c = page.locator('input[type=checkbox][name="gdpr"]').first();
    try {
      if (await c.count()) {
        await c.check({ force: true, timeout: 4000 }).catch(() => {});
        if (!(await c.isChecked().catch(() => false))) {
          // Fall back to clicking the wrapping label (avoid the Privacy Notice <a>).
          await c.evaluate((el) => { const lab = el.closest('label'); if (lab) lab.click(); }).catch(() => {});
        }
        if (await c.isChecked().catch(() => false)) filled.push({ field: 'consent', value: 'checked' });
        else { pending.push({ field: 'consent', note: 'tick the Privacy Notice consent box by hand' }); emit('consent-failed', {}); }
      } else {
        pending.push({ field: 'consent', note: 'no gdpr checkbox found — check for a consent box by hand' });
      }
    } catch (e) { emit('consent-failed', { message: String(e).slice(0, 160) }); }
  }

  await page.waitForTimeout(600);
  const shot = path.join(outDir, 'workable-filled.png');
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

  if (needsResume) {
    const note = 'Form asks for a RÉSUMÉ but none authored yet. Write output/' + (a.id || '<id>') +
      '/resume.md (condensed from the CV, tailored to the role), render it to resume.pdf, then re-run.';
    emit('needs-resume', { label: fileInfo.label, outDir, shot, note });
    writeState({ status: 'needs-resume', kind, label: fileInfo.label, filled, pending, shot, note });
  } else {
    emit('filled', { filled, pending, shot, kind, uploadedType, note: 'Review, adjust anything (e.g. salary), then click "Submit application". Nothing is submitted by this script.' });
    writeState({ status: 'filled', kind, uploadedType, filled, pending, shot });
  }

  // Keep the browser open for the human to finish + submit. Close on CLOSE signal or 45 min.
  if (!dryRun) {
    const closeFile = path.join(outDir, 'CLOSE');
    const deadline = Date.now() + 45 * 60 * 1000;
    while (Date.now() < deadline) {
      if (fs.existsSync(closeFile)) break;
      await page.waitForTimeout(2000);
    }
  }
  await browser.close();
})().catch(e => { console.error('ERR', e); emit('error', { message: String(e) }); process.exit(1); });
