// Ashby apply adapter. Fills an Ashby public application form
// (jobs.ashbyhq.com/<org>/<jobId>/application) from a per-job answers.json, then STOPS
// before submit and keeps the browser open so the human reviews and clicks
// "Submit Application". It NEVER clicks Submit.
//
// Ashby hosts a lean, no-login React form reached via the LinkedIn "Apply on company
// website" link. Standard fields carry stable `_systemfield_*` ids, which makes identity
// easy, but four things shape this adapter:
//   - THERE ARE TWO input[type=file] ON THE PAGE. The FIRST is Ashby's "Autofill from
//     resume" widget, which parses an upload and rewrites the form's fields; the real
//     slot is the SECOND, `#_systemfield_resume`. Grabbing `input[type=file]` first-match
//     (as some other adapters here do) hits the autofill widget and lets Ashby's parser
//     overwrite everything we filled. Always address the résumé slot BY ID.
//   - Boolean questions render as a Yes/No BUTTON PAIR backed by a hidden, tabindex=-1
//     checkbox, and they are a trap twice over. First, the checkbox is `checked` only for
//     Yes, so `checked === false` means EITHER "answered No" OR "never touched" — it cannot
//     confirm a No; the selected button gains an `_active_<hash>` class, so read THAT.
//     (Same shape as Greenhouse's `.select__single-value`.) Second, the pair is a TOGGLE,
//     not a radio group: clicking the already-active option UNSETS it. A human reviewing the
//     filled form and clicking "Yes" to confirm it thereby clears it, and Submit fails with
//     "Missing entry for required field" — which is exactly how id 182's first submit died.
//     The adapter therefore attaches a verify note telling the human to LOOK, not click.
//   - Custom/screening questions are named/ided with a per-posting UUID, so they are
//     matched by LABEL WORDING from answers.screening[], never by a hardcoded id. Labels
//     carry the stable class `ashby-application-form-question-title`.
//   - Submit is gated by an INVISIBLE reCAPTCHA (a `g-recaptcha-response` textarea), so the
//     anti-automation launch flags are always-on and `--channel msedge` is available.
//
//   node scripts/ashby/apply.js --url <ashby-apply-url> --id <dbId> \
//        --answers output/<id>/answers.json --outDir output/<id> [--dryRun] [--channel msedge]
//
// Emits `EVENT {json}` lines and writes ashby-state.json + ashby-filled.png to --outDir.
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

// Normalize an Ashby job-page URL to its /application form endpoint. Company-hosted
// embedded boards (e.g. acme.com/careers?ashby_jid=<uuid>) are passed through untouched —
// they render the same form inline, and findFormFrame locates it either way.
function toApplyUrl(url) {
  const u = String(url).trim();
  if (!/jobs\.ashbyhq\.com/i.test(u)) return u;
  const base = u.split('?')[0].replace(/\/+$/, '');
  return /\/application$/.test(base) ? base : base + '/application';
}

// The form is normally top-level on jobs.ashbyhq.com, but an embedded company board serves
// it from an Ashby iframe. Return whichever frame actually holds the form.
async function findFormFrame(page, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      if (await f.locator('#_systemfield_name').count().catch(() => 0)) return f;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function fillById(frame, id, value) {
  if (!value) return { ok: false, reason: 'no-value' };
  const loc = frame.locator(`#${CSS_escape(id)}`).first();
  if (!(await loc.count())) return { ok: false, reason: 'not-found' };
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.fill(String(value), { timeout: 4000 }).catch(() => {});
  const got = await loc.inputValue().catch(() => '');
  return { ok: !!got, value: got };
}

// Minimal CSS.escape for ids we build selectors from (Ashby uses UUIDs, which start with a
// digit often enough that a bare #<uuid> selector is invalid).
function CSS_escape(id) {
  return String(id).replace(/^(\d)/, '\\3$1 ').replace(/([^\w-])/g, '\\$1');
}

// Locate a question's control by the wording of its label, then act on it. Ashby question
// ids are per-posting UUIDs, so wording is the only stable key.
async function findQuestion(frame, labelRe) {
  return frame.evaluateHandle((reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const labels = Array.from(document.querySelectorAll('label, [class*="question-title"]'));
    for (const l of labels) {
      if (!re.test(norm(l.textContent))) continue;
      // Climb until we reach a block that owns an actual control.
      let n = l;
      for (let i = 0; i < 6 && n; i++) {
        n = n.parentElement;
        if (!n) break;
        const ctl = n.querySelector('textarea, input[type=text], input[type=email], div[class*="yesno"], select');
        if (ctl) return ctl;
      }
    }
    return null;
  }, labelRe.source);
}

// Set an Ashby Yes/No question.
//
// ⚠️ The widget is a TOGGLE, not a radio group: clicking the option that is already active
// UNSETS it, returning the question to unanswered. That is the reverse of the instinct a
// reviewing human has — "click Yes to confirm my answer" silently clears it, and Submit then
// fails with "Missing entry for required field" on a question that was correctly filled.
// This cost a failed submit on id 182. Hence the verify note the caller attaches: it tells
// the human to LOOK, not to click.
//
// Verification reads the button's `_active_` class, because the backing checkbox is
// unchecked for both "answered No" and "never answered". (Same shape as Greenhouse's
// `.select__single-value`.) A real ElementHandle click is used over `evaluate(el.click())`
// as the more faithful interaction; both were measured to commit the same React state, so
// this is defensive, not a fix for anything observed.
async function answerYesNo(frame, handle, wanted) {
  const want = /^(yes|si|sí|true)$/i.test(String(wanted)) ? 'Yes' : 'No';
  const buttons = await handle.$$('button');
  let target = null;
  for (const b of buttons) {
    const t = ((await b.innerText().catch(() => '')) || '').trim();
    if (t.toLowerCase() === want.toLowerCase()) { target = b; break; }
  }
  if (!target) return { ok: false, reason: 'button-not-found' };
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ timeout: 5000 }).catch(() => {});
  await frame.page().waitForTimeout(500);
  // Verify on the BUTTON's _active_ class: the backing checkbox is unchecked for both
  // "No" and "never answered", so it cannot confirm a No.
  const confirmed = await frame.evaluate((el) => {
    const active = Array.from(el.querySelectorAll('button')).find((b) => /_active_/.test(b.className));
    return active ? (active.innerText || '').trim() : null;
  }, handle);
  return { ok: !!confirmed && confirmed.toLowerCase() === want.toLowerCase(), value: confirmed };
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
  const writeState = (o) => fs.writeFileSync(path.join(outDir, 'ashby-state.json'), JSON.stringify(o, null, 2), 'utf8');
  const filled = [];
  const pending = [];

  const applyUrl = toApplyUrl(a.url);
  const dryRun = !!a.dryRun;
  // Submit is gated by an invisible reCAPTCHA, which scores the browser. Ship the
  // anti-automation tells stripped always-on; --channel msedge drives real Edge if the
  // human's Submit click is ever challenged.
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
  await page.waitForTimeout(3000);

  const frame = await findFormFrame(page);
  if (!frame) {
    emit('form-not-found', { url: applyUrl });
    writeState({ status: 'form-not-found', url: applyUrl });
    await browser.close();
    process.exit(4);
  }
  emit('form-found', { url: applyUrl, frame: frame === page.mainFrame() ? 'main' : frame.url() });

  // 1) Identity. Ashby uses a single "Full Name" field, not first/last.
  for (const [id, value, key] of [
    ['_systemfield_name', answers.full_name, 'full_name'],
    ['_systemfield_email', answers.email, 'email'],
  ]) {
    const r = await fillById(frame, id, value);
    if (r.ok) filled.push({ field: key, value: r.value });
    else { emit('fill-skip', { field: key, reason: r.reason }); pending.push({ field: key, note: `enter ${key} by hand` }); }
  }

  // Optional standard fields Ashby sometimes renders; fill only if present.
  for (const [id, value, key] of [
    ['_systemfield_phone', answers.phone, 'phone'],
    ['_systemfield_linkedin', (answers.links || {}).linkedin, 'linkedin'],
    ['_systemfield_github', (answers.links || {}).github, 'github'],
    ['_systemfield_website', (answers.links || {}).website, 'website'],
  ]) {
    if (!value) continue;
    if (!(await frame.locator(`#${CSS_escape(id)}`).count())) continue;
    const r = await fillById(frame, id, value);
    if (r.ok) filled.push({ field: key, value: r.value });
  }

  // 2) Résumé / CV upload — ADDRESS BY ID. The first input[type=file] on the page is the
  //    "Autofill from resume" widget, whose parser would overwrite the fields above.
  const resumeInput = frame.locator('#_systemfield_resume').first();
  const docLabel = await frame.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const l = document.querySelector('label[for="_systemfield_resume"]');
    return l ? norm(l.textContent).replace(/\*/g, '').trim() : '';
  });
  const kind = classifyDocField(docLabel); // 'cv' | 'resume' | 'unknown'
  emit('doc-field', { present: !!(await resumeInput.count()), label: docLabel, kind });

  const resumePdf = path.join(outDir, 'resume.pdf');
  const hasResume = fs.existsSync(resumePdf);
  let uploadPath = answers.resume_upload || answers.cv_upload || '';
  let uploadedType = answers.resume_doc_type || 'cv';
  let needsResume = false;
  if (kind === 'resume') {
    if (hasResume) { uploadPath = resumePdf; uploadedType = 'resume'; }
    else { needsResume = true; uploadPath = ''; }
  }
  if ((await resumeInput.count()) && uploadPath) {
    const abs = path.resolve(uploadPath);
    if (fs.existsSync(abs)) {
      try {
        await resumeInput.setInputFiles(abs);
        await page.waitForTimeout(2000);
        filled.push({ field: 'resume', value: path.basename(abs), kind, uploadedType });
        emit('uploaded', { file: path.basename(abs), kind, uploadedType });
      } catch (e) { emit('upload-error', { message: String(e).slice(0, 160) }); }
    } else {
      emit('upload-missing', { path: uploadPath });
      pending.push({ field: 'resume', note: `file missing: ${uploadPath}` });
    }
  }

  // 3) Screening questions, matched by label wording. type: 'yesno' drives the button pair;
  //    anything else is a text/textarea fill.
  for (const q of (answers.screening || [])) {
    if (!q.label_contains) continue;
    const re = new RegExp(q.label_contains, 'i');
    const handle = await findQuestion(frame, re);
    const el = handle.asElement();
    if (!el) {
      emit('screening', { label_contains: q.label_contains, ok: false, reason: 'not-found' });
      pending.push({ field: `screening:${q.label_contains}`, note: `answer by hand: ${String(q.value).slice(0, 80)}` });
      continue;
    }
    await el.scrollIntoViewIfNeeded().catch(() => {});
    let r;
    if (q.type === 'yesno') {
      r = await answerYesNo(frame, el, q.value);
    } else {
      await el.fill(String(q.value), { timeout: 5000 }).catch(() => {});
      const got = await el.inputValue().catch(() => '');
      r = { ok: !!got, value: got };
    }
    emit('screening', { label_contains: q.label_contains, type: q.type || 'text', ok: r.ok, reason: r.reason });
    if (r.ok) {
      // The Yes/No pair is a toggle (see answerYesNo), so a reviewing human who clicks the
      // selected option to confirm it silently clears the answer. Say so explicitly.
      const verify = q.type === 'yesno'
        ? (q.verify ? q.verify + ' ' : '') +
          `DO NOT CLICK "${r.value}" TO CONFIRM IT — this widget is a toggle and re-clicking the ` +
          'active option unsets it, which makes Submit fail with "Missing entry for required field". ' +
          'Just check it is highlighted; only click if it is not.'
        : q.verify;
      filled.push({ field: `screening:${q.label_contains}`, value: String(r.value).slice(0, 120), verify });
    } else pending.push({ field: `screening:${q.label_contains}`, note: `answer by hand: ${String(q.value).slice(0, 80)}` });
  }

  // 4) Any consent checkbox Ashby renders for this tenant (none on every form).
  if (answers.consent === true || /^(yes|accept|si|sí)$/i.test(String(answers.consent || ''))) {
    const boxes = frame.locator('input[type=checkbox]:not([tabindex="-1"])');
    const n = await boxes.count();
    for (let i = 0; i < n; i++) {
      const c = boxes.nth(i);
      await c.check({ force: true, timeout: 3000 }).catch(() => {});
      if (await c.isChecked().catch(() => false)) filled.push({ field: `consent[${i}]`, value: 'checked' });
      else pending.push({ field: `consent[${i}]`, note: 'tick the consent box by hand' });
    }
  }

  await page.waitForTimeout(600);
  const shot = path.join(outDir, 'ashby-filled.png');
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

  if (needsResume) {
    const note = 'Form asks for a RÉSUMÉ but none authored yet. Write output/' + (a.id || '<id>') +
      '/resume.md (condensed from the CV, tailored to the role), render it to resume.pdf, then re-run.';
    emit('needs-resume', { label: docLabel, outDir, shot, note });
    writeState({ status: 'needs-resume', kind, label: docLabel, filled, pending, shot, note });
  } else {
    emit('filled', { filled, pending, shot, kind, uploadedType, note: 'Review every answer, then click "Submit Application". Nothing is submitted by this script.' });
    writeState({ status: 'filled', kind, uploadedType, filled, pending, shot });
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
})().catch(e => { console.error('ERR', e); emit('error', { message: String(e) }); process.exit(1); });
