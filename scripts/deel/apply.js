// Deel ATS ("Hire with Deel") apply adapter. Fills a public, no-login application form at
// jobs.deel.com/<org>/job-details/<jobId>/application from a per-job answers.json, then STOPS
// before submit and keeps the browser open so the human reviews and clicks "Apply". It NEVER
// clicks Apply.
//
// Deel hires for itself (org "deel") and for other employers through this form, and LinkedIn's
// "Apply on company website" link for Deel's own postings lands on www.deel.com/careers/job/
// ?ats_id=<uuid> instead, a marketing page whose job ids are Ashby ids. That page links to
// the form; toApplyUrl() rewrites both shapes straight to it. Ashby's own hosted form
// (jobs.ashbyhq.com/Deel/<id>) returns 404, so the Ashby adapter cannot be used.
//
// What shapes this adapter (first seen on id 392, Deel's "Applied AI Engineer"):
//   - The page is Material UI. Identity fields have stable `name`s (firstName, lastName, email,
//     phoneNumber_dialCode, phoneNumber, linkedinProfileUrl). Every posting-specific question
//     is a `[data-field-id=<uuid>]` block whose wording sits in an h4 Typography, so questions
//     are matched by `question_id` (that uuid) or by `label_contains` wording, never by the
//     generated `_r_N_` ids, which change between renders.
//   - Dropdowns are MUI Autocompletes (an <input role=combobox> plus a listbox portalled to
//     <body>), not <select>s. A value only counts once an option is CLICKED: typed text that
//     matches nothing is discarded on blur. The dial code is one too, with options like
//     "ES +34". "Select one or more" variants are multi-selects that render chips.
//   - Yes/No questions are real radio groups (native inputs wrapped in labels), so a reviewing
//     human can click the chosen option again without unsetting it (unlike Ashby's toggles).
//   - There is ONE file input: the résumé dropzone, a hidden <input type=file> whose aria-label
//     carries the employer's wording ("Please upload your resume as a PDF file…"). The "Upload
//     your resume to autofill" banner is a separate button that would parse a file into the
//     fields; this adapter never touches it, and re-checks the identity fields after the upload
//     anyway.
//   - A "Talent Pool" consent box (other employers hiring through Deel can find the profile)
//     is optional and is left to the human. It is not a privacy-policy acceptance.
//   - No captcha markers on the form at first sight; the anti-automation launch flags are
//     always-on regardless, and `--channel msedge` drives real Edge if Apply is challenged.
//
//   node scripts/deel/apply.js --url <deel careers or jobs.deel.com URL> --id <dbId> \
//        [--answers output/<id>/answers.json] [--outDir output/<id>] [--dryRun] [--channel msedge]
//
// Emits `EVENT {json}` lines and writes deel-state.json + deel-filled.png to --outDir.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { classifyDocField } = require('../common/classify-doc-field');

const emit = (event, extra = {}) => console.log('EVENT ' + JSON.stringify({ event, ...extra }));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

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

// www.deel.com/careers/job/?ats_id=<uuid> (LinkedIn's link), www.deel.com/careers/job/<uuid>/
// and www.deel.com/careers/position/?ashby_jid=<uuid> are Deel's own postings (org "deel").
// jobs.deel.com/<org>/job-details/<uuid>[/application] is the form for any employer.
function toApplyUrl(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return String(url).trim(); }
  const host = u.hostname.toLowerCase();
  const jobs = u.pathname.match(new RegExp(`^/([^/]+)/job-details/(${UUID})`, 'i'));
  if (host === 'jobs.deel.com' && jobs) return `https://jobs.deel.com/${jobs[1]}/job-details/${jobs[2]}/application`;
  if (/(^|\.)deel\.com$/.test(host)) {
    const id = u.searchParams.get('ats_id') || u.searchParams.get('ashby_jid') ||
      (u.pathname.match(new RegExp(`/careers/job/(${UUID})`, 'i')) || [])[1];
    if (id) return `https://jobs.deel.com/deel/job-details/${id}/application`;
  }
  return u.toString();
}

// Pick the option to click for a wanted value: exact text first, then a dial-code style
// suffix ("ES +34" for "+34"), then a unique prefix or substring match.
function pickOption(options, wanted) {
  const w = norm(wanted).toLowerCase();
  const texts = options.map((o) => norm(o).toLowerCase());
  let i = texts.indexOf(w);
  if (i >= 0) return i;
  i = texts.findIndex((t) => t.endsWith(' ' + w));
  if (i >= 0) return i;
  for (const test of [(t) => t.startsWith(w), (t) => t.includes(w)]) {
    const hits = texts.map((t, k) => (test(t) ? k : -1)).filter((k) => k >= 0);
    if (hits.length === 1) return hits[0];
  }
  return -1;
}

// Choose one option in a MUI Autocomplete: open it, type to filter, click the matching option.
// `typeFirst` is text to filter by when it differs from the option wanted: the dial-code list
// filters on the country name or ISO code ("Spain", "ES") but not on "+34". Long lists are
// VIRTUALISED (only a screenful of <li> exists at a time), so when typing finds nothing the
// listbox is scrolled and re-read until the option shows up.
// Returns { ok, value, choices }. For a multi-select, `value` is the chip list afterwards.
async function chooseAutocomplete(page, input, wanted, { multiple = false, scope = null, typeFirst = [] } = {}) {
  const optLoc = page.locator('[role="listbox"] [role="option"]');
  const readOpts = () => optLoc.evaluateAll((els) => els.map((e) => e.getAttribute('data-text') || e.innerText)).catch(() => []);
  await input.scrollIntoViewIfNeeded().catch(() => {});
  let choices = [];
  let idx = -1;
  for (const typed of [...typeFirst.filter(Boolean), wanted]) {
    await input.click({ timeout: 5000 }).catch(() => {});
    await input.fill('').catch(() => {});
    await input.pressSequentially(norm(typed).slice(0, 40), { delay: 15 }).catch(() => {});
    await page.waitForTimeout(500);
    choices = await readOpts();
    idx = pickOption(choices, wanted);
    if (idx >= 0) break;
  }
  if (idx < 0) {
    // Clear the filter and walk the virtualised list.
    await input.fill('').catch(() => {});
    await input.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    const seen = new Set();
    for (let step = 0; step < 80 && idx < 0; step++) {
      choices = await readOpts();
      choices.forEach((c) => seen.add(norm(c)));
      idx = pickOption(choices, wanted);
      if (idx >= 0) break;
      const moved = await page.locator('[role="listbox"]').first().evaluate((lb) => {
        const before = lb.scrollTop;
        lb.scrollTop = before + Math.max(lb.clientHeight - 20, 40);
        return lb.scrollTop !== before;
      }).catch(() => false);
      if (!moved) break;
      await page.waitForTimeout(150);
    }
    if (idx < 0) choices = Array.from(seen);
  }
  if (idx < 0) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, reason: 'option-not-found', choices: choices.slice(0, 12).map(norm) };
  }
  const picked = norm(choices[idx]);
  await optLoc.nth(idx).scrollIntoViewIfNeeded().catch(() => {});
  await optLoc.nth(idx).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape').catch(() => {});
  if (multiple) {
    const chips = scope ? await scope.locator('.MuiChip-label').allInnerTexts().catch(() => []) : [];
    const got = chips.map(norm);
    return { ok: got.some((c) => c.toLowerCase() === picked.toLowerCase()), value: got.join(', '), choices: [] };
  }
  // The dial code displays only "+34" after "ES +34" is picked, so accept the picked option's
  // tail as well as the whole option or the wanted text.
  const got = norm(await input.inputValue().catch(() => ''));
  const g = got.toLowerCase();
  const ok = !!g && (g === picked.toLowerCase() || picked.toLowerCase().endsWith(' ' + g) || g === norm(wanted).toLowerCase());
  return { ok, value: got, choices: [] };
}

// Read every posting-specific question block: its uuid, wording, whether it is required, the
// widget it uses and (for radios) the option labels.
async function readQuestions(page) {
  return page.evaluate(() => {
    const n = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('[data-field-id]')).map((b) => {
      const title = b.querySelector('h1, h2, h3, h4, h5, .MuiTypography-h4') || b.querySelector('p');
      const raw = n(title ? title.textContent : '');
      const radios = Array.from(b.querySelectorAll('input[type=radio]'));
      const combo = b.querySelector('input[role=combobox]');
      const box = b.querySelector('input[type=checkbox]');
      const text = b.querySelector('textarea, input[type=text]:not([role=combobox]), input[type=email], input[type=url], input[type=number]');
      let widget = 'unknown';
      if (radios.length) widget = 'radio';
      else if (combo) widget = /one or more/i.test(n((b.querySelector('label') || {}).textContent)) ? 'multiselect' : 'select';
      else if (box) widget = 'checkbox';
      else if (text) widget = text.tagName === 'TEXTAREA' ? 'textarea' : 'text';
      return {
        id: b.getAttribute('data-field-id'),
        question: raw.replace(/\s*\*\s*$/, ''),
        required: /\*\s*$/.test(raw),
        widget,
        choices: radios.map((r) => n((r.closest('label') || {}).textContent)),
      };
    });
  });
}

function findAnswer(screening, q) {
  for (const s of screening) if (s.question_id && s.question_id === q.id) return s;
  for (const s of screening) {
    if (!s.label_contains) continue;
    try { if (new RegExp(s.label_contains, 'i').test(q.question)) return s; } catch { /* bad regex */ }
  }
  return null;
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
  const writeState = (o) => fs.writeFileSync(path.join(outDir, 'deel-state.json'), JSON.stringify(o, null, 2), 'utf8');
  const filled = [];
  const pending = [];

  const applyUrl = toApplyUrl(a.url);
  const dryRun = !!a.dryRun;
  const launchOpts = {
    headless: dryRun || !!a.headless,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (a.channel) launchOpts.channel = a.channel;
  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();
  // 'load', not 'networkidle': the page keeps analytics connections open and never idles.
  await page.goto(applyUrl, { waitUntil: 'load' });
  const first = page.locator('input[name="firstName"]').first();
  if (!(await first.waitFor({ timeout: 20000 }).then(() => true).catch(() => false))) {
    emit('form-not-found', { url: applyUrl, landed: page.url() });
    writeState({ status: 'form-not-found', url: applyUrl, landed: page.url() });
    await browser.close();
    process.exit(4);
  }
  await page.waitForTimeout(1000);
  emit('form-found', { url: applyUrl, title: await page.title() });

  // 1) Résumé FIRST, so that anything the upload might parse into the fields is overwritten by
  //    the fills below (and re-checked at the end). The employer's wording is the aria-label.
  const fileInput = page.locator('input[type=file][aria-label]').first();
  const docLabel = norm(await fileInput.getAttribute('aria-label').catch(() => '')).replace(/\s*\*\s*$/, '');
  const kind = classifyDocField(docLabel); // 'cv' | 'resume' | 'unknown'
  const uploadPath = answers.resume_upload || answers.cv_upload || '';
  const uploadedType = answers.resume_doc_type || 'cv';
  emit('doc-field', { present: !!(await fileInput.count()), label: docLabel, kind, uploadedType });
  let needsResume = false;
  if (kind === 'resume' && uploadedType !== 'resume') {
    // Never feed the full CV to a slot that asked for a résumé.
    needsResume = true;
    pending.push({ field: 'resume', note: 'slot asks for a RÉSUMÉ; author output/<id>/resume.md and render it first. The CV was not attached.' });
  } else if (!(await fileInput.count())) {
    pending.push({ field: 'resume', note: 'no file input found; attach the document by hand' });
  } else if (uploadPath) {
    const abs = path.resolve(uploadPath);
    if (!fs.existsSync(abs)) {
      emit('upload-missing', { path: uploadPath });
      pending.push({ field: 'resume', note: `file missing: ${uploadPath}` });
    } else {
      await fileInput.setInputFiles(abs);
      const base = path.basename(abs);
      const shown = await page.getByText(base, { exact: false }).first()
        .waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
      if (shown) {
        filled.push({ field: 'resume', value: base, kind, uploadedType });
        emit('uploaded', { file: base, kind, uploadedType });
      } else {
        emit('upload-unconfirmed', { file: base });
        pending.push({ field: 'resume', note: `uploaded ${base} but its name never appeared on the page; check the attachment` });
      }
    }
  }
  await page.waitForTimeout(1000);

  // 2) Identity, by stable field name.
  const identity = [
    ['firstName', answers.first_name, 'first_name'],
    ['lastName', answers.last_name, 'last_name'],
    ['email', answers.email, 'email'],
    ['phoneNumber', answers.phone, 'phone'],
    ['linkedinProfileUrl', answers.linkedin || (answers.links || {}).linkedin, 'linkedin'],
  ];
  const fillIdentity = async () => {
    const out = [];
    for (const [name, value, key] of identity) {
      const loc = page.locator(`input[name="${name}"]`).first();
      if (!value || !(await loc.count())) continue;
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.fill(String(value), { timeout: 4000 }).catch(() => {});
      out.push({ key, name, value: String(value), got: await loc.inputValue().catch(() => '') });
    }
    return out;
  };
  for (const r of await fillIdentity()) {
    if (r.got === r.value) filled.push({ field: r.key, value: r.got });
    else pending.push({ field: r.key, note: `enter by hand: ${r.value}` });
  }
  const dial = page.locator('input[name="phoneNumber_dialCode"]').first();
  if (answers.phone_country_code && (await dial.count())) {
    const r = await chooseAutocomplete(page, dial, answers.phone_country_code,
      { typeFirst: [answers.phone_country, answers.country] });
    if (r.ok) filled.push({ field: 'phone_country_code', value: r.value });
    else pending.push({ field: 'phone_country_code', note: `pick ${answers.phone_country_code} by hand (${r.reason})` });
  }

  // 3) Posting-specific questions, matched by uuid or wording from answers.screening[]. Any
  //    question with no entry is listed for the human with its choices, never guessed.
  const screening = Array.isArray(answers.screening) ? answers.screening : [];
  const questions = await readQuestions(page);
  emit('questions', { count: questions.length, questions: questions.map((q) => ({ id: q.id, q: q.question.slice(0, 80), widget: q.widget, required: q.required })) });
  for (const q of questions) {
    const block = page.locator(`[data-field-id="${q.id}"]`).first();
    const ans = findAnswer(screening, q);
    if (!ans || ans.value === undefined || ans.value === null || ans.value === '') {
      pending.push({ question: q.question, type: q.widget, required: q.required, choices: q.choices.length ? q.choices : undefined, note: ans && ans.verify ? ans.verify : undefined });
      continue;
    }
    let r = { ok: false, reason: 'unsupported-widget' };
    const values = Array.isArray(ans.value) ? ans.value : [ans.value];
    if (q.widget === 'radio') {
      const want = norm(values[0]).toLowerCase();
      const labels = block.locator('label:has(input[type=radio])');
      const n = await labels.count();
      r = { ok: false, reason: 'option-not-found', choices: q.choices };
      for (let i = 0; i < n; i++) {
        const lab = labels.nth(i);
        if (norm(await lab.innerText().catch(() => '')).toLowerCase() !== want) continue;
        const radio = lab.locator('input[type=radio]');
        if (!(await radio.isChecked().catch(() => false))) {
          await lab.scrollIntoViewIfNeeded().catch(() => {});
          await lab.click({ timeout: 5000 }).catch(() => {});
          if (!(await radio.isChecked().catch(() => false))) await radio.check({ force: true, timeout: 3000 }).catch(() => {});
        }
        r = { ok: await radio.isChecked().catch(() => false), value: norm(await lab.innerText()) };
        break;
      }
    } else if (q.widget === 'select' || q.widget === 'multiselect') {
      const input = block.locator('input[role=combobox]').first();
      for (const v of values) {
        r = await chooseAutocomplete(page, input, v, { multiple: q.widget === 'multiselect', scope: block });
        if (!r.ok) break;
      }
    } else if (q.widget === 'text' || q.widget === 'textarea') {
      const el = block.locator('textarea, input[type=text]:not([role=combobox]), input[type=email], input[type=url], input[type=number]').first();
      await el.fill(String(values[0]), { timeout: 5000 }).catch(() => {});
      const got = await el.inputValue().catch(() => '');
      r = { ok: got === String(values[0]), value: got };
    } else if (q.widget === 'checkbox') {
      const box = block.locator('input[type=checkbox]').first();
      if (/^(yes|true|checked|si|sí)$/i.test(String(values[0]))) await box.check({ force: true, timeout: 3000 }).catch(() => {});
      r = { ok: await box.isChecked().catch(() => false), value: 'checked' };
    }
    emit('screening', { id: q.id, question: q.question.slice(0, 80), widget: q.widget, ok: r.ok, reason: r.reason });
    if (r.ok) filled.push({ field: `screening:${q.question.slice(0, 60)}`, value: String(r.value).slice(0, 120), verify: ans.verify });
    else pending.push({ question: q.question, type: q.widget, required: q.required, choices: r.choices || (q.choices.length ? q.choices : undefined), wanted: String(values.join(', ')), note: r.reason });
  }

  // 4) The Talent Pool box sits outside the question blocks. It is optional and is the human's
  //    choice, so it is only reported.
  const pool = await page.evaluate(() => {
    const box = Array.from(document.querySelectorAll('input[type=checkbox]')).find((c) => !c.closest('[data-field-id]'));
    if (!box) return null;
    // The wording is a sibling of the box's wrapper, not inside a <label>: climb until there is text.
    let l = box;
    while (l.parentElement && (l.textContent || '').replace(/\s+/g, '').length < 20) l = l.parentElement;
    return { text: (l.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140), checked: box.checked };
  });
  if (pool) pending.push({ question: pool.text, type: 'checkbox', required: false, note: 'optional, your choice; left unticked' });

  // 5) Re-check identity: if anything (the upload's parser, a re-render) changed a field after
  //    it was filled, fill it again and say so.
  for (const [name, value, key] of identity) {
    if (!value) continue;
    const loc = page.locator(`input[name="${name}"]`).first();
    if (!(await loc.count())) continue;
    const got = await loc.inputValue().catch(() => '');
    if (got !== String(value)) {
      emit('refilled', { field: key, was: got });
      await loc.fill(String(value)).catch(() => {});
    }
  }

  // Report any anti-bot marker actually present, without assuming which gate will fire.
  const captcha = await page.locator('iframe[src*="recaptcha"], iframe[src*="challenges.cloudflare"], iframe[src*="hcaptcha"]').count();
  if (captcha) pending.push({ field: 'captcha', note: 'solve the challenge yourself before clicking Apply' });

  await page.waitForTimeout(500);
  const shot = path.join(outDir, 'deel-filled.png');
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

  if (needsResume) {
    const note = 'Form asks for a RÉSUMÉ but none is prepared. Write output/' + (a.id || '<id>') +
      '/resume.md (condensed from the CV, tailored to the role), render it, then re-run.';
    emit('needs-resume', { label: docLabel, outDir, shot, note, filled, pending });
    writeState({ status: 'needs-resume', url: applyUrl, kind, label: docLabel, filled, pending, shot, note });
  } else {
    emit('filled', { filled, pending, shot, kind, uploadedType, note: 'Review every answer, answer what is pending, then click "Apply". Nothing is submitted by this script.' });
    writeState({ status: 'filled', url: applyUrl, kind, uploadedType, captcha: !!captcha, filled, pending, shot });
  }

  // Keep the browser open for the human to review + submit. Close on CLOSE signal or 45 min.
  if (!dryRun) {
    const closeFile = path.join(outDir, 'CLOSE');
    const deadline = Date.now() + 45 * 60 * 1000;
    while (Date.now() < deadline) {
      if (fs.existsSync(closeFile)) break;
      await page.waitForTimeout(2000);
    }
  }
  await browser.close();
})().catch((e) => { console.error('ERR', e); emit('error', { message: String(e) }); process.exit(1); });
