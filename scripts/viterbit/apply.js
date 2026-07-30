// Viterbit apply adapter. Fills a Viterbit-hosted application form from a per-job
// answers.json, then STOPS before submit and keeps the browser open so the human can
// review and click "Enviar candidatura". It NEVER clicks Submit.
//
// Viterbit is a Spanish ATS that serves each customer on their own careers domain
// (e.g. BETWEEN at talento.between.tech) — the "Hiring with Viterbit" footer is the
// tell. Job page is `https://<careers-domain>/<job-slug>-<shortcode>/`, and the form
// lives one level down at `.../apply/` (the "Inscribirme" CTA). No login needed.
//
// Field names are Symfony-style: apply[name], apply[lastName], apply[email],
// apply[phone], apply[address][country], apply[address][city],
// apply[cvDocument][file], apply[questions][<24-hex-question-id>], apply[terms].
//
// Four traps shape this adapter:
//   - CLOUDFLARE GATES THE PAGE LOAD, not just submit. Unlike Workable/Greenhouse (where
//     the challenge only fires on the human's Submit click), Viterbit sits behind a
//     full-page Cloudflare interstitial ("Verificación de seguridad en curso"). Bundled
//     Chromium AND headless Edge both fail it and never reach the form, so this adapter
//     runs a REAL browser HEADED by default. There is no usable headless dry run.
//   - City is a select2 REMOTE autocomplete (data-url=/talent-community/utils/cities/,
//     data-param=<ISO country>), so it has NO static options — open it, type, and pick
//     from the AJAX results. Country is a normal select2 and usually pre-set to ES.
//   - RADIO QUESTIONS SHIP PRE-CHECKED ON THE FIRST OPTION. The BETWEEN form's disability
//     question arrives with "Si" already selected (checked="checked" in the markup), so
//     *not touching it submits an affirmative answer the candidate never gave*. Leaving a
//     radio alone is therefore NOT neutral here: every radio question must be answered
//     explicitly from answers.json, and any radio left unanswered is reported in `pending`
//     with its current on-page value so the human can see what would be sent.
//   - The consent checkbox is visually hidden with the click surface on its <label>, so
//     check({force:true}) with a label-click fallback (same shape as Bizneo).
//
//   node scripts/viterbit/apply.js --url <apply-url> --id <dbId> \
//        --answers output/<id>/answers.json --outDir output/<id>
//
// Emits `EVENT {json}` lines and writes viterbit-state.json + viterbit-filled.png to --outDir.
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

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const isYes = (v) => v === true || /^(yes|accept|si|sí|true)$/i.test(String(v || ''));

async function acceptCookies(page) {
  for (const t of ['Aceptar todo', 'Aceptar todas', 'Aceptar selección', 'Accept all', 'Aceptar']) {
    const b = page.locator(`button:has-text("${t}")`).first();
    if (await b.count()) { await b.click({ timeout: 3000 }).catch(() => {}); return t; }
  }
  return null;
}

// Cloudflare shows "Un momento…" / "Verificación de seguridad en curso" until it clears.
// Nothing to click — just wait it out and report whether we made it through.
async function passInterstitial(page, ms = 90000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => '');
    if (!/un momento|just a moment|verificaci/i.test(title)) return { ok: true, title };
    await page.waitForTimeout(2000);
  }
  return { ok: false, title: await page.title().catch(() => '') };
}

// Drive a select2 attached to native <select id=selectId>: open, type, click the match.
// `remote` allows time for the AJAX round-trip the city field needs.
async function select2Pick(page, selectId, typeText, matchRe, { remote = false } = {}) {
  const container = page.locator(`#select2-${selectId}-container`);
  if (!(await container.count())) return { ok: false, reason: 'container-not-found' };
  await container.scrollIntoViewIfNeeded().catch(() => {});
  await container.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  const search = page.locator('input.select2-search__field').first();
  if (await search.count()) await search.fill(typeText, { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(remote ? 2800 : 700);
  const opts = page.locator('li.select2-results__option');
  const n = await opts.count();
  const sample = [];
  for (let i = 0; i < n; i++) {
    const t = norm(await opts.nth(i).innerText().catch(() => ''));
    if (sample.length < 6) sample.push(t);
    if (matchRe.test(t)) {
      await opts.nth(i).click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(500);
      return { ok: true, picked: t };
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  return { ok: false, reason: 'no-match', sample };
}

// Read every apply[questions][<id>] control on the page with its visible label + kind.
async function readQuestions(page) {
  return page.evaluate(() => {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const byId = new Map();
    document.querySelectorAll('[name^="apply[questions]"]').forEach((el) => {
      const m = (el.getAttribute('name') || '').match(/^apply\[questions\]\[([^\]]+)\]$/);
      if (!m) return;
      const qid = m[1];
      if (!byId.has(qid)) byId.set(qid, { question_id: qid, kind: null, label: '', options: [] });
      const q = byId.get(qid);
      const type = (el.type || '').toLowerCase();
      if (type === 'radio') {
        q.kind = 'radio';
        const lab = el.closest('label');
        q.options.push({ id: el.id, value: el.value, text: norm(lab ? lab.textContent : ''), checked: el.checked });
      } else {
        q.kind = el.tagName === 'TEXTAREA' ? 'textarea' : (type === 'number' ? 'number' : 'text');
      }
      // The prompt sits in the nearest .form-group row's label, or the block heading above
      // a radio group. Walk up until we find non-empty label text that isn't an option.
      if (!q.label) {
        let n = el, hops = 0;
        while (n && hops < 8) {
          n = n.parentElement; hops++;
          if (!n) break;
          const cand = n.querySelector('label.col-form-label, .kt-section__title, label:not(.kt-radio):not(.kt-checkbox)');
          const t = norm(cand ? cand.textContent : '');
          if (t && t.length > 3) { q.label = t.slice(0, 300); break; }
        }
      }
    });
    return Array.from(byId.values());
  });
}

// Match an answers.screening[] entry to a question: explicit id first, then label wording.
function matchAnswer(q, screening) {
  for (const s of screening) if (s.question_id && s.question_id === q.question_id) return s;
  for (const s of screening) {
    const pat = s.label_contains || s.question;
    if (!pat) continue;
    try { if (new RegExp(pat, 'i').test(q.label)) return s; } catch { /* bad regex -> skip */ }
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
  const writeState = (o) => fs.writeFileSync(path.join(outDir, 'viterbit-state.json'), JSON.stringify(o, null, 2), 'utf8');

  const filled = [];
  const pending = [];  // required things deliberately left for the human
  const verify = [];   // filled, but the human should eyeball it before submitting

  // Cloudflare screens the page load, so a real browser is the default, not an escalation.
  // --channel overrides (e.g. --channel chrome); --chromium falls back to bundled Chromium.
  const channel = a.chromium ? undefined : (typeof a.channel === 'string' ? a.channel : 'msedge');
  const dryRun = !!a.dryRun; // fills + screenshots, then exits without waiting for the human
  const browser = await chromium.launch({
    channel,
    headless: false, // headless never clears the interstitial — see header
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, locale: 'es-ES' });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();
  await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const gate = await passInterstitial(page);
  emit('interstitial', gate);
  if (!gate.ok) {
    emit('error', { message: 'Cloudflare interstitial did not clear; cannot reach the form.' });
    writeState({ status: 'blocked', gate });
    await browser.close();
    process.exit(4);
  }
  await page.waitForTimeout(4000);

  const cookie = await acceptCookies(page);
  emit('cookies', { accepted: cookie });
  await page.waitForTimeout(1200);

  // The /apply/ URL shows the form directly; from a job page, click "Inscribirme" first.
  if (!(await page.locator('[name="apply[email]"]').count())) {
    await page.locator('a:has-text("Inscribirme"), button:has-text("Inscribirme")').first()
      .click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(4000);
    await passInterstitial(page, 30000);
  }
  if (!(await page.locator('[name="apply[email]"]').count())) {
    emit('error', { message: 'apply form not found on page' });
    writeState({ status: 'no-form', url: page.url() });
    await browser.close();
    process.exit(5);
  }

  // 1) Identity text fields.
  const TEXT = {
    'apply[name]': answers.first_name,
    'apply[lastName]': answers.last_name,
    'apply[email]': answers.email,
  };
  for (const [name, value] of Object.entries(TEXT)) {
    if (!value) continue;
    try {
      const loc = page.locator(`[name="${name}"]`).first();
      if (await loc.count()) { await loc.fill(String(value), { timeout: 4000 }); filled.push({ field: name, value: String(value) }); }
    } catch (e) { emit('fill-error', { field: name, message: String(e).slice(0, 160) }); }
  }

  // 2) Phone. The widget is intl-tel-input (data-rule-phoneintl): filling the full
  //    "+34 …" makes it detect the country and keep the dial code out of the field.
  if (answers.phone) {
    try {
      const p = page.locator('[name="apply[phone]"]').first();
      await p.fill(String(answers.phone), { timeout: 4000 });
      await p.dispatchEvent('input').catch(() => {});
      await p.dispatchEvent('change').catch(() => {});
      await page.waitForTimeout(400);
      filled.push({ field: 'phone', value: norm(await p.inputValue().catch(() => '')) || String(answers.phone) });
    } catch (e) { emit('fill-error', { field: 'phone', message: String(e).slice(0, 160) }); }
  }

  // 3) Country (usually pre-set to the careers site's default) then the remote City list.
  const countryText = answers.country || 'España';
  const curCountry = await page.locator('#apply_address_country').inputValue().catch(() => '');
  if (!curCountry) {
    const cRes = await select2Pick(page, 'apply_address_country', countryText, new RegExp(`^${countryText}$`, 'i'));
    emit('country', cRes);
    if (cRes.ok) filled.push({ field: 'country', value: cRes.picked });
    else pending.push({ field: 'country', note: 'pick the country by hand' });
    await page.waitForTimeout(1500);
  } else {
    emit('country', { ok: true, preset: curCountry });
    filled.push({ field: 'country', value: curCountry });
  }

  const cityText = answers.city || 'Barcelona';
  const cityRes = await select2Pick(page, 'apply_address_city', cityText, new RegExp(cityText, 'i'), { remote: true });
  emit('city', cityRes);
  if (cityRes.ok) filled.push({ field: 'city', value: cityRes.picked });
  else pending.push({ field: 'city', note: `type "${cityText}" into Ciudad and pick it by hand` });

  // 4) CV upload. The real prompt is the form-group label ("Curriculum"), NOT the
  //    <label class="custom-file-label"> bootstrap uses for the filename display (empty).
  const fileInfo = await page.evaluate(() => {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const f = document.querySelector('input[name="apply[cvDocument][file]"]') || document.querySelector('input[type=file]');
    if (!f) return { present: false, label: '' };
    let t = '';
    let n = f, hops = 0;
    while (n && hops < 6) {
      n = n.parentElement; hops++;
      if (!n) break;
      const l = n.querySelector('label.col-form-label');
      if (l && norm(l.textContent)) { t = norm(l.textContent); break; }
    }
    return { present: true, label: t.replace(/\*?\s*(Required|Obligatorio)$/i, '').trim() };
  });
  const kind = classifyDocField(fileInfo.label); // 'cv' | 'resume' | 'unknown'
  emit('doc-field', { present: fileInfo.present, label: fileInfo.label, kind });

  const resumePdf = path.join(outDir, 'resume.pdf');
  let uploadPath = answers.cv_upload ? String(answers.cv_upload) : '';
  let uploadedType = 'cv';
  let needsResume = false;
  if (kind === 'resume') {
    if (fs.existsSync(resumePdf)) { uploadPath = resumePdf; uploadedType = 'resume'; }
    else { needsResume = true; uploadPath = ''; }
  }
  if (fileInfo.present && uploadPath) {
    const abs = path.resolve(uploadPath);
    if (fs.existsSync(abs)) {
      try {
        await page.locator('input[name="apply[cvDocument][file]"]').first().setInputFiles(abs);
        await page.waitForTimeout(1200);
        filled.push({ field: 'cv', value: path.basename(abs), kind, uploadedType });
        emit('uploaded', { file: path.basename(abs), kind, uploadedType });
      } catch (e) { emit('upload-error', { message: String(e).slice(0, 160) }); }
    } else {
      emit('upload-missing', { path: uploadPath });
      pending.push({ field: 'cv', note: `file not found: ${uploadPath}` });
    }
  }

  // 5) Screening questions. Radios are the dangerous ones: Viterbit renders them with the
  //    first option pre-checked, so an unanswered radio still POSTs a value. Answer every
  //    one explicitly, and surface anything unmatched with the value it would submit.
  const screening = Array.isArray(answers.screening) ? answers.screening : [];
  const questions = await readQuestions(page);
  emit('questions', { count: questions.length, questions: questions.map((q) => ({ id: q.question_id, kind: q.kind, label: q.label })) });

  for (const q of questions) {
    const match = matchAnswer(q, screening);
    if (!match || match.answer == null || match.answer === '') {
      const preChecked = q.kind === 'radio' ? (q.options.find((o) => o.checked) || {}).text : undefined;
      pending.push({
        field: `question:${q.question_id}`,
        label: q.label,
        kind: q.kind,
        note: q.kind === 'radio'
          ? `NOT ANSWERED — the site pre-selected "${preChecked || '?'}"; choose the right option before submit`
          : 'NOT ANSWERED — fill it in before submit',
      });
      emit('question-unanswered', { id: q.question_id, label: q.label, kind: q.kind, preChecked });
      continue;
    }
    const want = String(match.answer);
    try {
      if (q.kind === 'radio') {
        const opt = q.options.find((o) => new RegExp(`^\\s*${want}\\s*$`, 'i').test(o.text)) ||
                    q.options.find((o) => new RegExp(want, 'i').test(o.text));
        if (!opt) {
          pending.push({ field: `question:${q.question_id}`, label: q.label, note: `no option matching "${want}" (options: ${q.options.map((o) => o.text).join(' / ')})` });
          continue;
        }
        const input = page.locator(`#${CSS_escape(opt.id)}`).first();
        await input.check({ force: true, timeout: 4000 }).catch(async () => {
          await page.locator(`label:has(#${CSS_escape(opt.id)})`).first().click({ timeout: 3000 }).catch(() => {});
        });
        const ok = await input.isChecked().catch(() => false);
        if (ok) {
          filled.push({ field: `question:${q.question_id}`, label: q.label, value: opt.text });
          if (match.verify) verify.push({ field: q.label, value: opt.text, note: match.verify });
        } else {
          pending.push({ field: `question:${q.question_id}`, label: q.label, note: `could not select "${want}" — set it by hand` });
        }
      } else {
        const loc = page.locator(`[name="apply[questions][${q.question_id}]"]`).first();
        await loc.fill(want, { timeout: 4000 });
        filled.push({ field: `question:${q.question_id}`, label: q.label, value: want });
        if (match.verify) verify.push({ field: q.label, value: want, note: match.verify });
      }
    } catch (e) {
      emit('question-error', { id: q.question_id, message: String(e).slice(0, 160) });
      pending.push({ field: `question:${q.question_id}`, label: q.label, note: 'fill failed — set it by hand' });
    }
  }

  // 6) GDPR consent. Visually hidden input, click surface on the <label> (same as Bizneo).
  if (isYes(answers.consent)) {
    try {
      const c = page.locator('input[type=checkbox][name="apply[terms]"]').first();
      if (await c.count()) {
        await c.check({ force: true, timeout: 4000 }).catch(() => {});
        if (!(await c.isChecked().catch(() => false))) {
          const id = await c.getAttribute('id').catch(() => null);
          if (id) await page.locator(`label[for="${id}"]`).first().click({ timeout: 3000 }).catch(() => {});
        }
        if (await c.isChecked().catch(() => false)) filled.push({ field: 'consent', value: 'checked' });
        else { pending.push({ field: 'consent', note: 'tick the RGPD consent box by hand' }); emit('consent-failed', {}); }
      }
    } catch (e) { emit('consent-failed', { message: String(e).slice(0, 160) }); }
  } else {
    pending.push({ field: 'consent', note: 'consent not set in answers.json — tick it by hand' });
  }

  await page.waitForTimeout(800);
  // Two shots, because `fullPage: true` does NOT capture the whole document here (it comes
  // back viewport-sized), and the form is about two screens tall. Anchor each half on a
  // real element — window.scrollTo(0,0) does not stick, since uploading the CV and picking
  // the city both re-scroll the page.
  const shotTop = path.join(outDir, 'viterbit-filled-top.png');    // identity, phone, city, CV
  const shot = path.join(outDir, 'viterbit-filled.png');           // questions, consent, submit
  await page.locator('[name="apply[name]"]').first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: shotTop }).catch(() => {});
  await page.locator('button[type=submit]').first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: shot }).catch(() => {});

  // Report what the phone widget actually holds: intl-tel-input may keep or strip the
  // dial code, and a mis-shaped number only fails at the human's Submit click.
  const phoneShown = norm(await page.locator('[name="apply[phone]"]').first().inputValue().catch(() => ''));
  emit('phone-final', { value: phoneShown });

  if (needsResume) {
    const note = `Form asks for a RÉSUMÉ but none authored yet. Write output/${a.id || '<id>'}/resume.md ` +
      '(condensed from the CV, tailored to the role), render it to resume.pdf, then re-run.';
    emit('needs-resume', { label: fileInfo.label, outDir, shot, note });
    writeState({ status: 'needs-resume', kind, label: fileInfo.label, filled, pending, verify, shot, note });
  } else {
    emit('filled', {
      filled, pending, verify, shot, kind, uploadedType,
      note: 'Review every answer, then click "Enviar candidatura". Nothing is submitted by this script.',
    });
    writeState({ status: 'filled', kind, uploadedType, filled, pending, verify, shot, url: page.url() });
  }

  // Human gate: keep the browser open until a CLOSE signal file appears (or 45 min).
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

// Minimal CSS.escape for the ids Viterbit generates (hex + underscores) — Node has no DOM.
function CSS_escape(id) {
  return String(id).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}
