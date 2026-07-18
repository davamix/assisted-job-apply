// Greenhouse apply adapter. Fills a Greenhouse application form from a per-job
// answers.json, then STOPS before submit and keeps the browser open so the human
// reviews and clicks "Submit application". It NEVER clicks Submit.
//
// Greenhouse is reached via the LinkedIn / careers "Apply" link. On a company careers
// front-end (e.g. Fever's careers.feverup.com/jobs/<id>/…/apply/?gh_jid=<id>) the form
// is served INSIDE an iframe named `grnhse_iframe` pointing at Greenhouse's board
// (here the EU board job-boards.eu.greenhouse.io/embed/job_app). All fills happen in
// that frame — the adapter locates it by URL and waits for #first_name inside it.
//
// Form shape learned from the live Fever posting (id 52), and the traps it carries:
//   - Standard identity fields carry stable ids inside the frame: #first_name,
//     #last_name, #preferred_name (optional), #email. Phone is #phone (intl-tel-input).
//   - Custom/screening questions are #question_<id> — job-specific, so they are matched
//     by question_id first and LABEL WORDING as a fallback, never by position.
//   - Several questions are Greenhouse COMBOBOXES (role=combobox, aria-haspopup): the
//     visible #question_<id> input opens a [role="option"] listbox. Select by clicking
//     the option (there is no hidden native <select> to setOption on); the chosen label
//     lands back in the input's value, which we read back to confirm. Plain text
//     questions (LinkedIn URL, Desired salary) are just filled.
//   - The privacy/GDPR authorization is itself a required combobox with a single option
//     ("Acknowledge/Confirm"); selecting it is the compliance-defaults "accept policy".
//   - The résumé slot is a real input[type=file] #resume under a "Resume/CV" heading
//     (classifies as 'cv' -> attach the default CV). #cover_letter is optional and left
//     blank unless answers.cover_letter_upload is set.
//   - Submit is gated by an INVISIBLE reCAPTCHA Enterprise (a g-recaptcha-response
//     textarea + a recaptcha.net anchor frame). It scores the browser silently, so the
//     adapter ships the anti-automation launch flags always-on and takes --channel
//     (e.g. msedge) to drive a real installed browser; the human's click clears it.
//
//   node scripts/greenhouse/apply.js --url <apply-url> --id <dbId> \
//        --answers output/<id>/answers.json --outDir output/<id> [--channel msedge] [--dryRun]
//
// Emits `EVENT {json}` lines and writes greenhouse-state.json + greenhouse-filled.png to --outDir.
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

async function acceptCookies(page) {
  for (const t of ['Accept all', 'Accept All', 'Aceptar todas', 'Aceptar todo', 'Accept', 'Aceptar', 'Allow all', 'Got it', 'I agree', 'OK']) {
    const b = page.locator(`button:has-text("${t}")`).first();
    if (await b.count()) { await b.click({ timeout: 3000 }).catch(() => {}); return t; }
  }
  return null;
}

// The Greenhouse form is embedded in an iframe; poll for it (it loads async) and return
// the Frame that actually contains the application form (#first_name), not the reCAPTCHA
// / google-proxy child frames.
async function findFormFrame(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      if (/recaptcha|google|proxy/i.test(f.url())) continue;
      try {
        if (await f.locator('#first_name').count()) return f;
      } catch (_) { /* frame navigating */ }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

// Fill a text/tel input addressed by id inside the frame.
async function fillById(frame, id, value) {
  if (value == null || value === '') return { ok: false, reason: 'no-value' };
  const loc = frame.locator(`#${CSS_escape(id)}`).first();
  if (!(await loc.count())) return { ok: false, reason: 'not-found' };
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.fill(String(value), { timeout: 4000 }).catch(() => {});
  const got = await loc.inputValue().catch(() => '');
  return { ok: !!got, value: got };
}

// CSS.escape isn't available in Node; ids here are ASCII (question_<digits>, first_name…),
// but guard anyway.
function CSS_escape(s) { return String(s).replace(/([^a-zA-Z0-9_\-])/g, '\\$1'); }

// Read a react-select combobox's currently-selected label. Greenhouse uses react-select:
// the #question_<id> input is only a search box (cleared, opacity:0 after picking); the
// chosen value renders in a sibling `.select__single-value`. So confirm the selection
// there, not on the input's value.
async function comboSelectedValue(frame, id) {
  return frame.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return '';
    const control = el.closest('.select__control') || el.closest('[class*="control" i]') || el.closest('div');
    if (!control) return '';
    const sv = control.querySelector('.select__single-value, [class*="single-value" i]');
    return sv ? sv.textContent.replace(/\s+/g, ' ').trim() : '';
  }, id).catch(() => '');
}

// Open a Greenhouse (react-select) combobox #<id> and click the option matching optionRe,
// then confirm via the rendered single-value. Only one listbox is open at a time, so
// [role=option] is unambiguous. React-select renders the option *elements* before their
// text is painted, so a single-shot filter can miss on a headed run — poll for the match
// for a couple of seconds, and if nothing matches, type `typeText` to filter the list
// (react-select narrows as you type) before giving up.
async function selectCombo(frame, page, id, optionRe, typeText) {
  const trigger = frame.locator(`#${CSS_escape(id)}`).first();
  if (!(await trigger.count())) return { ok: false, reason: 'not-found' };
  await trigger.scrollIntoViewIfNeeded().catch(() => {});

  const options = frame.locator('[role="option"]');
  const findMatch = async () => {
    for (let t = 0; t < 10; t++) {
      if (await options.count()) {
        const m = options.filter({ hasText: optionRe }).first();
        if (await m.count()) return m;
      }
      await page.waitForTimeout(250);
    }
    return null;
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    await trigger.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(400);
    let match = await findMatch();
    // Fallback: type to filter the listbox, then re-match.
    if (!match && typeText) {
      await trigger.fill(String(typeText)).catch(() => {});
      await page.waitForTimeout(500);
      match = await findMatch();
    }
    if (match) {
      await match.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(300);
      const got = await comboSelectedValue(frame, id);
      if (optionRe.test(got) || got.length > 0) return { ok: true, value: got };
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }
  return { ok: false, reason: 'no-option-match' };
}

// Best-effort country field: it may be a combobox (opens a list) or a plain text input.
async function fillCountry(frame, page, value) {
  const loc = frame.locator('#country').first();
  if (!(await loc.count())) return { ok: false, reason: 'not-found' };
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.click({ timeout: 3000 }).catch(() => {});
  await loc.fill(String(value)).catch(() => {});
  await page.waitForTimeout(500);
  // Country is a react-select; its option labels carry a dial code ("Spain +34"), so match
  // on the name as a substring, not an exact string.
  const opt = frame.locator('[role="option"]').filter({ hasText: new RegExp(value, 'i') }).first();
  if (await opt.count()) { await opt.click().catch(() => {}); }
  else { await page.keyboard.press('Escape').catch(() => {}); }
  await page.waitForTimeout(300);
  // Country may be a react-select (value in .select__single-value) or a plain input.
  const got = (await comboSelectedValue(frame, 'country')) || (await loc.inputValue().catch(() => ''));
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
  const writeState = (o) => fs.writeFileSync(path.join(outDir, 'greenhouse-state.json'), JSON.stringify(o, null, 2), 'utf8');
  const filled = [];
  const pending = []; // things deliberately left for the human

  const dryRun = !!a.dryRun;
  // Submit is gated by an invisible reCAPTCHA Enterprise that scores the browser. Blunt
  // the obvious automation tells and (optionally) drive real Edge so the human's Submit
  // click is trusted. See scripts/README.md "Bot-detection at submit".
  const launchOpts = {
    headless: dryRun || !!a.headless,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (a.channel) launchOpts.channel = a.channel;
  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  const page = await ctx.newPage();
  await page.goto(a.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const cookie = await acceptCookies(page);
  emit('cookies', { accepted: cookie });
  await page.waitForTimeout(600);

  const frame = await findFormFrame(page);
  if (!frame) {
    emit('form-not-found', { url: a.url });
    writeState({ status: 'form-not-found', url: a.url });
    await browser.close();
    process.exit(4);
  }
  emit('form-frame', { url: frame.url() });

  // 1) Identity fields (stable ids inside the frame).
  for (const [id, value] of [
    ['first_name', answers.first_name],
    ['last_name', answers.last_name],
    ['preferred_name', answers.preferred_name],
    ['email', answers.email],
  ]) {
    if (value == null || value === '') continue;
    const r = await fillById(frame, id, value);
    if (r.ok) filled.push({ field: id, value: r.value });
    else emit('fill-skip', { field: id, reason: r.reason });
  }

  // 2) Country (optional; combobox-or-text, best effort).
  if (answers.country) {
    const r = await fillCountry(frame, page, answers.country);
    if (r.ok) filled.push({ field: 'country', value: r.value });
    else pending.push({ field: 'country', note: `set Country = ${answers.country} by hand` });
  }

  // 3) Phone (intl-tel-input): fill the full +CC number so the widget detects the country.
  if (answers.phone) {
    const r = await fillById(frame, 'phone', answers.phone);
    if (r.ok) filled.push({ field: 'phone', value: r.value });
    else pending.push({ field: 'phone', note: 'enter phone by hand' });
  }

  // 4) Screening / custom questions — resolve by question_id, else by label wording.
  for (const q of (answers.screening || [])) {
    let id = q.question_id;
    if (!id && q.label_contains) {
      // Resolve id from label wording (labels are stable across edits; ids are not).
      id = await frame.evaluate((reSrc) => {
        const re = new RegExp(reSrc, 'i');
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        for (const el of document.querySelectorAll('[id^="question_"]')) {
          const l = document.querySelector(`label[for="${el.id}"]`);
          if (l && re.test(norm(l.textContent))) return el.id;
        }
        return null;
      }, q.label_contains).catch(() => null);
    }
    if (!id) { pending.push({ field: q.label_contains || 'question', note: `answer by hand: ${q.value}` }); emit('question-unresolved', { label_contains: q.label_contains }); continue; }

    if (q.type === 'combobox') {
      const optRe = new RegExp(q.option_contains ? q.option_contains : `^${q.value}$`, 'i');
      const r = await selectCombo(frame, page, id, optRe, q.value);
      emit('screening-combo', { id, label_contains: q.label_contains, ok: r.ok, value: r.value, reason: r.reason });
      if (r.ok) filled.push({ field: id, label: q.label_contains, value: r.value });
      else pending.push({ field: id, note: `select "${q.value}" for "${q.label_contains}" by hand`, reason: r.reason });
    } else {
      const r = await fillById(frame, id, q.value);
      emit('screening-text', { id, label_contains: q.label_contains, ok: r.ok });
      if (r.ok) filled.push({ field: id, label: q.label_contains, value: r.value });
      else pending.push({ field: id, note: `type "${q.value}" for "${q.label_contains}" by hand`, reason: r.reason });
    }
  }

  // 5) Résumé / CV upload. Read the section wording near #resume and classify it; on this
  //    form it is "Resume/CV" -> 'cv' -> attach the default CV. Honor the CV-vs-Résumé
  //    gate: a slot asking specifically for a Résumé must not receive the full CV.
  const resumeInput = frame.locator('#resume').first();
  if (await resumeInput.count()) {
    const label = await frame.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const f = document.querySelector('#resume');
      let node = f, out = '';
      for (let i = 0; i < 6 && node; i++) {
        node = node.parentElement; if (!node) break;
        const texts = [];
        node.querySelectorAll('h1,h2,h3,h4,h5,h6,label,legend,[class*="label" i]').forEach((e) => {
          const t = norm(e.textContent);
          if (t && t.length < 40 && !/attach|dropbox|enter manually|drag|drop|choose file/i.test(t)) texts.push(t);
        });
        if (texts.length) { out = Array.from(new Set(texts)).join(' ').replace(/\*/g, '').trim(); break; }
      }
      return out;
    });
    const kind = classifyDocField(label); // 'cv' | 'resume' | 'unknown'
    emit('doc-field', { label, kind });

    const resumePdf = path.join(outDir, 'resume.pdf');
    const hasResume = fs.existsSync(resumePdf);
    let uploadPath = answers.cv_upload ? String(answers.cv_upload) : '';
    let uploadedType = 'cv';
    let needsResume = false;
    if (kind === 'resume') {
      if (hasResume) { uploadPath = resumePdf; uploadedType = 'resume'; }
      else { needsResume = true; uploadPath = ''; }
    }
    if (needsResume) {
      const note = 'Slot asks for a RÉSUMÉ but none authored yet. Write output/' + (a.id || '<id>') +
        '/resume.md (condensed from the CV, tailored to the role), render to resume.pdf, then re-run.';
      emit('needs-resume', { label, note });
      pending.push({ field: 'resume', note });
    } else if (uploadPath) {
      const abs = path.resolve(uploadPath);
      if (fs.existsSync(abs)) {
        try {
          await resumeInput.setInputFiles(abs);
          await page.waitForTimeout(1500);
          filled.push({ field: 'resume', value: path.basename(abs), kind, uploadedType });
          emit('uploaded', { file: path.basename(abs), kind, uploadedType });
        } catch (e) { emit('upload-error', { message: String(e).slice(0, 160) }); pending.push({ field: 'resume', note: 'attach CV by hand' }); }
      } else {
        emit('upload-missing', { path: uploadPath });
        pending.push({ field: 'resume', note: `CV file missing: ${uploadPath}` });
      }
    }
  }

  // 6) Cover letter is optional -> left blank unless a path is provided.
  if (answers.cover_letter_upload) {
    const cl = frame.locator('#cover_letter').first();
    const abs = path.resolve(String(answers.cover_letter_upload));
    if ((await cl.count()) && fs.existsSync(abs)) {
      await cl.setInputFiles(abs).catch(() => {});
      await page.waitForTimeout(1000);
      filled.push({ field: 'cover_letter', value: path.basename(abs) });
    }
  } else {
    pending.push({ field: 'cover_letter', note: 'optional — left blank' });
  }

  // 7) Anything the answers file explicitly defers to the human (e.g. pronouns).
  for (const h of (answers.leave_to_human || [])) {
    pending.push({ field: h.question_id || h.label_contains || 'field', note: h.reason || 'left for you' });
  }

  await page.waitForTimeout(600);
  const shot = path.join(outDir, 'greenhouse-filled.png');
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

  emit('filled', { filled, pending, shot, note: 'Review the form, fill anything left pending, then click "Submit application" in the Greenhouse frame. An invisible reCAPTCHA scores your click — if it balks, re-run with --channel msedge. Nothing is submitted by this script.' });
  writeState({ status: 'filled', frame: frame.url(), filled, pending, shot });

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
