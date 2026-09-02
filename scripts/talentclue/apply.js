// TalentClue apply adapter. Fills a TalentClue public application form from a per-job
// answers.json, then STOPS before submit and keeps the browser open so the human reviews,
// solves the reCAPTCHA and clicks "Inscríbete". It NEVER submits.
//
// TalentClue is a Drupal 7 ATS (form_id `cv_node_form`) reached from the LinkedIn
// "Apply on company website" link. The job page lives at
//   https://<company>.talentclue.com/<lang>/node/<jobId>/<token>
// and its "Inscríbete" control links to the form at
//   https://<company>.talentclue.com/<lang>/node/add/cv/job/<jobId>/company/<companyId>/<token>?clicked_button=apply_manually
// Either URL may be passed as --url; a job-page URL is resolved to the form automatically.
//
// Four things shape this adapter:
//   - EVERY <select> ON THE PAGE IS HIDDEN, wrapped by jQuery **Chosen**
//     (`display:none` native select + a `.chosen-container` sibling that draws the visible
//     control). Playwright's `selectOption` therefore fails its actionability check, and
//     even forced it would leave the Chosen display showing "- Escoge -" and, worse, would
//     not fire the `change` the page's own behaviours listen for. Drive the native select
//     through jQuery instead — `.val(v).trigger('change').trigger('chosen:updated')` —
//     which updates the value, the dependent behaviours AND the visible widget in one go.
//     jQuery 1.12.4 is on the page, so `window.jQuery` is always available.
//   - PAÍS AND FORMACIÓN ARE **SHS** (Simple Hierarchical Select) WIDGETS, not plain
//     selects. The element carrying the `name` (`field_cv_country_iso[und][0][tid]`) is a
//     hidden TEXT input holding the chosen taxonomy tid; the dropdown the human sees is a
//     JS-generated `<select id="<baseId>-select-1">` with NO name, itself Chosen-wrapped.
//     Picking a level-1 value SPAWNS a `-select-2` (País → provincia, Ciclo Formativo
//     Superior → familia profesional) whose tid REPLACES the level-1 one, so stopping at
//     level 1 submits a plausible-looking wrong term: pass `country_sub` / `degree_sub` in
//     answers.json, and read the hidden text input back to confirm what SHS propagated. A
//     sub-level with no value supplied is reported as pending, never guessed.
//   - THE FILE UPLOAD IS AJAX AND AUTOMATIC (Drupal behaviour `autoUpload`; the "Subir"
//     button is `display:none` and pressed for you). `setInputFiles` alone is not "done" —
//     the request has to land. The completion signal is the hidden
//     `field_cv_file[und][0][fid]` input flipping from `0` to a real file id; poll THAT,
//     not the visible widget.
//   - SUBMIT IS GATED BY A **VISIBLE reCAPTCHA v2 checkbox** ("I'm not a robot", a 304x78
//     `.g-recaptcha` iframe), which the human solves — same shape as BambooHR's, not
//     Greenhouse's invisible one. The anti-automation launch flags are always-on anyway so
//     the human's click is not scored against a browser advertising itself as automated;
//     `--channel msedge` drives real Edge if a click is ever challenged.
//
// Identity-document number and date of birth are REQUIRED by this form but are personal
// data that may deliberately not be in answers.json — when absent they are reported as
// `pending` for the human to type at the review gate, never invented.
//
//   node scripts/talentclue/apply.js --url <job-or-apply-url> --id <dbId> \
//        --answers output/<id>/answers.json --outDir output/<id> [--dryRun] [--channel msedge]
//
// Emits `EVENT {json}` lines and writes talentclue-state.json + talentclue-filled.png to --outDir.
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

// A TalentClue job page and its application form are different URLs. Accept either: if the
// form path is not already present, open the page and follow its apply link.
async function resolveApplyUrl(page, url) {
  if (/\/node\/add\/cv\//i.test(url)) return url;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const href = await page.evaluate(() => {
    const a = document.querySelector('a[href*="node/add/cv"]');
    return a ? a.href : null;
  });
  return href || url;
}

// Set a Chosen-wrapped native <select> by option wording, through jQuery so that the
// page's own change handlers and the visible Chosen widget both update. Returns the label
// actually selected, read back from the DOM.
async function setChosen(page, selectSelector, wanted) {
  return page.evaluate(({ sel, wanted }) => {
    const $ = window.jQuery;
    const el = document.querySelector(sel);
    if (!el) return { ok: false, reason: 'not-found' };
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const want = norm(wanted).toLowerCase();
    const opts = Array.from(el.options);
    let opt = opts.find((o) => norm(o.textContent).toLowerCase() === want);
    if (!opt) opt = opts.find((o) => norm(o.textContent).toLowerCase().includes(want));
    if (!opt) return { ok: false, reason: 'no-such-option', sample: opts.slice(1, 8).map((o) => norm(o.textContent)) };
    if (!$) { // No jQuery would mean the page changed shape; fall back to native events.
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      $(el).val(opt.value).trigger('change').trigger('chosen:updated');
    }
    return { ok: el.value === opt.value, value: norm(opt.textContent), tid: opt.value };
  }, { sel: selectSelector, wanted });
}

// Set an SHS (hierarchical taxonomy) field: drive its level-1 select, then — if the pick
// spawns a sub-level — drive that too, and finally confirm the tid landed on the hidden
// text input that actually carries the form `name`. Both SHS fields on this form are two
// levels deep (País → provincia, Ciclo Formativo Superior → familia profesional), and the
// tid that gets submitted is the DEEPEST one chosen, so stopping at level 1 submits the
// wrong term. A sub-level with no `sub` value supplied is reported as pending, not guessed.
async function setShs(page, baseId, wanted, sub) {
  const r = await setChosen(page, `#${baseId}-select-1`, wanted);
  if (!r.ok) return r;
  await page.waitForTimeout(1500); // SHS fetches and appends the sub-level select.
  const readSub = () => page.evaluate((id) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const el = document.querySelector(`#${CSS.escape(id)}-select-2`);
    return el ? { present: true, options: Array.from(el.options).map((o) => norm(o.textContent)) } : { present: false, options: [] };
  }, baseId);

  let subState = await readSub();
  let subResult = null;
  if (subState.present && sub) {
    subResult = await setChosen(page, `#${baseId}-select-2`, sub);
    await page.waitForTimeout(1000);
  }
  const after = await page.evaluate((id) => {
    const hidden = document.getElementById(id);
    return { tid: hidden ? hidden.value : null, hasLevel3: !!document.querySelector(`#${CSS.escape(id)}-select-3`) };
  }, baseId);

  return {
    ...r,
    ...after,
    hasSubLevel: subState.present,
    subOptions: subState.options.slice(0, 12),
    subValue: subResult && subResult.ok ? subResult.value : null,
    subOk: subState.present ? !!(subResult && subResult.ok) : true,
    subReason: subResult ? subResult.reason : (subState.present && !sub ? 'no-sub-value-supplied' : undefined),
  };
}

// TalentClue's phone field is validated as DIGITS ONLY — the canonical `+34 600 123 456`
// kept in config/profile.json is rejected inline with «El número de teléfono debe ser
// numérico. Por ejemplo "0034678901234" o "678901234"», which would block the human's
// submit. Convert here rather than denormalising answers.json: strip separators and turn a
// leading `+` into the international `00` prefix the form asks for.
function toTalentCluePhone(phone) {
  const s = String(phone || '').trim();
  if (!s) return s;
  const digits = s.replace(/\D/g, '');
  return s.startsWith('+') ? '00' + digits : digits;
}

async function fillById(page, id, value) {
  if (value === undefined || value === null || value === '') return { ok: false, reason: 'no-value' };
  const loc = page.locator(`#${id}`).first();
  if (!(await loc.count())) return { ok: false, reason: 'not-found' };
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.fill(String(value), { timeout: 4000 }).catch(() => {});
  const got = await loc.inputValue().catch(() => '');
  return { ok: !!got, value: got };
}

// The four open questions (`oq0_answer` … `oq3_answer`) are per-posting: the indices depend
// on the order the recruiter typed them, so match on the LABEL WORDING and follow its
// `for=` to the textarea — never on a hardcoded oq index.
async function findQuestionId(page, reSrc) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    for (const l of Array.from(document.querySelectorAll('label[for^="edit-oq"]'))) {
      if (re.test(norm(l.textContent))) return l.getAttribute('for');
    }
    return null;
  }, reSrc);
}

(async () => {
  const a = parseArgs(process.argv);
  if (!a.url) { console.error('missing --url'); process.exit(2); }
  const outDir = a.outDir || path.join('output', String(a.id || 'tmp'));
  fs.mkdirSync(outDir, { recursive: true });
  const answersPath = a.answers || path.join(outDir, 'answers.json');
  const answers = JSON.parse(fs.readFileSync(answersPath, 'utf8'));

  const writeState = (o) => fs.writeFileSync(path.join(outDir, 'talentclue-state.json'), JSON.stringify(o, null, 2), 'utf8');
  const filled = [];
  const pending = [];

  const dryRun = !!a.dryRun;
  // Submit is gated by a visible reCAPTCHA v2 checkbox the human ticks. Strip the
  // automation tells so that click is not scored against a self-declared bot.
  const launchOpts = {
    headless: dryRun || !!a.headless,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (a.channel) launchOpts.channel = a.channel;
  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, locale: 'es-ES' });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();

  const applyUrl = await resolveApplyUrl(page, String(a.url).trim());
  await page.goto(applyUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  if (!(await page.locator('#edit-field-cv-email-und-0-email').count())) {
    emit('form-not-found', { url: applyUrl, title: await page.title() });
    writeState({ status: 'form-not-found', url: applyUrl });
    await browser.close();
    process.exit(4);
  }
  emit('form-found', { url: applyUrl });

  // 1) Identity + contact. Plain Drupal text inputs with stable ids.
  for (const [id, value, key] of [
    ['edit-field-cv-email-und-0-email', answers.email, 'email'],
    ['edit-field-cv-phone-und-0-value', toTalentCluePhone(answers.phone), 'phone'],
    ['edit-field-cv-name-und-0-value', answers.first_name, 'first_name'],
    ['edit-field-cv-surname-und-0-value', answers.last_name, 'last_name'],
    ['edit-field-cv-city-und-0-value', answers.city, 'city'],
    ['edit-title', answers.current_title, 'current_title'],
    ['edit-field-cv-link-und-0-url', answers.link_url, 'link_url'],
  ]) {
    const r = await fillById(page, id, value);
    if (r.ok) filled.push({ field: key, value: r.value });
    else if (r.reason !== 'no-value') {
      emit('fill-skip', { field: key, reason: r.reason });
      pending.push({ field: key, note: `enter ${key} by hand` });
    }
  }

  // 2) Identity document (type + number) and date of birth. Both are REQUIRED by the form
  //    but are personal data that answers.json may deliberately omit — report, never guess.
  const doc = answers.identity_document || null;
  if (doc && doc.type && doc.number) {
    const r = await setChosen(page, '#edit-field-cv-identity-card-und', doc.type);
    if (r.ok) filled.push({ field: 'identity_document_type', value: r.value });
    else pending.push({ field: 'identity_document_type', note: `pick "${doc.type}" by hand (${r.reason})` });
    const n = await fillById(page, 'edit-field-cv-personal-id-und-0-value', doc.number);
    if (n.ok) filled.push({ field: 'identity_document_number', value: 'set' });
    else pending.push({ field: 'identity_document_number', note: 'enter the ID number by hand' });
  } else {
    emit('left-for-human', { field: 'identity_document' });
    pending.push({
      field: 'identity_document',
      note: 'REQUIRED: pick "Documento de identificación" (DNI/NIE/…) and type the number. Not in answers.json by choice — nothing was invented.',
    });
  }

  const birth = answers.birth_date || null; // "YYYY-MM-DD"
  const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  if (birth && /^\d{4}-\d{2}-\d{2}$/.test(birth)) {
    const [y, m, d] = birth.split('-');
    const parts = [
      ['edit-field-cv-birth-und-0-value-day', String(Number(d)), 'birth_day'],
      ['edit-field-cv-birth-und-0-value-month', MONTHS_ES[Number(m) - 1], 'birth_month'],
      ['edit-field-cv-birth-und-0-value-year', y, 'birth_year'],
    ];
    for (const [sel, want, key] of parts) {
      const r = await setChosen(page, `#${sel}`, want);
      if (r.ok) filled.push({ field: key, value: r.value });
      else pending.push({ field: key, note: `pick ${want} by hand (${r.reason})` });
    }
  } else {
    emit('left-for-human', { field: 'birth_date' });
    pending.push({
      field: 'birth_date',
      note: 'REQUIRED: pick "Fecha de nacimiento" (día / mes / año). Not in answers.json by choice — nothing was invented.',
    });
  }

  // 3) País and Formación — SHS hierarchical selects (see header).
  for (const [baseId, wanted, sub, key] of [
    ['edit-field-cv-country-iso-und-0-tid', answers.country, answers.country_sub, 'country'],
    ['edit-field-cv-degree-und-0-tid', answers.degree, answers.degree_sub, 'degree'],
  ]) {
    if (!wanted) { pending.push({ field: key, note: `pick ${key} by hand` }); continue; }
    const r = await setShs(page, baseId, wanted, sub);
    emit('shs', { field: key, wanted, sub, ok: r.ok, tid: r.tid, hasSubLevel: r.hasSubLevel, subOk: r.subOk, subReason: r.subReason, reason: r.reason });
    if (!r.ok) {
      pending.push({ field: key, note: `pick "${wanted}" by hand (${r.reason})`, options: r.sample });
      continue;
    }
    filled.push({ field: key, value: r.subValue ? `${r.value} › ${r.subValue}` : r.value, tid: r.tid });
    if (r.hasSubLevel && !r.subOk) {
      pending.push({
        field: `${key}:sub-level`,
        note: sub
          ? `sub-level "${sub}" could not be set (${r.subReason}); pick it by hand from: ${(r.subOptions || []).join(', ')}`
          : `a second dropdown appeared after "${r.value}"; pick its value by hand from: ${(r.subOptions || []).join(', ')}`,
      });
    }
    if (r.hasLevel3) pending.push({ field: `${key}:level-3`, note: 'a third dropdown appeared; pick its value by hand' });
  }

  // 4) CV upload. The label is a bare "Archivo", which classifies as `unknown` — but the
  //    field is `field_cv_file` on a `cv_node_form`, i.e. structurally the CV slot, so a CV
  //    is correct here and the résumé rule is not triggered. If a job ever wants a résumé,
  //    set resume_upload/resume_doc_type in answers.json and it is honoured as-is.
  const fileInput = page.locator('#edit-field-cv-file-und-0-upload').first();
  const docLabel = await page.evaluate(() => {
    const l = document.querySelector('label[for="edit-field-cv-file-und-0"]');
    return l ? (l.textContent || '').replace(/\s+/g, ' ').replace(/\*/g, '').trim() : '';
  });
  const kind = classifyDocField(docLabel); // 'unknown' on this form — see note above.
  const uploadPath = answers.resume_upload || answers.cv_upload || '';
  const uploadedType = answers.resume_doc_type || 'cv';
  emit('doc-field', { present: !!(await fileInput.count()), label: docLabel, kind, uploadedType });

  if ((await fileInput.count()) && uploadPath) {
    const abs = path.resolve(uploadPath);
    if (!fs.existsSync(abs)) {
      emit('upload-missing', { path: uploadPath });
      pending.push({ field: 'cv_file', note: `file missing: ${uploadPath}` });
    } else {
      await fileInput.setInputFiles(abs);
      // Drupal's autoUpload fires the hidden "Subir" button; the upload is only really done
      // once the hidden fid input stops being "0".
      let fid = '0';
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        fid = await page.evaluate(() => {
          const el = document.querySelector('input[name="field_cv_file[und][0][fid]"]');
          return el ? el.value : '0';
        });
        if (fid && fid !== '0') break;
        await page.waitForTimeout(1000);
      }
      if (fid && fid !== '0') {
        filled.push({ field: 'cv_file', value: path.basename(abs), kind, uploadedType, fid });
        emit('uploaded', { file: path.basename(abs), fid, uploadedType });
      } else {
        emit('upload-timeout', { file: path.basename(abs) });
        pending.push({ field: 'cv_file', note: `upload did not complete — attach ${path.basename(abs)} by hand` });
      }
    }
  }

  // 5) The posting's open questions, matched by label wording (see findQuestionId).
  for (const q of (answers.screening || [])) {
    if (!q.label_contains) continue;
    const id = await findQuestionId(page, q.label_contains);
    if (!id) {
      emit('screening', { label_contains: q.label_contains, ok: false, reason: 'not-found' });
      pending.push({ field: `screening:${q.label_contains}`, note: `answer by hand: ${String(q.value).slice(0, 80)}` });
      continue;
    }
    const r = await fillById(page, id, q.value);
    emit('screening', { label_contains: q.label_contains, id, ok: r.ok, reason: r.reason });
    if (r.ok) filled.push({ field: `screening:${q.label_contains}`, value: String(r.value).slice(0, 160), verify: q.verify });
    else pending.push({ field: `screening:${q.label_contains}`, note: `answer by hand: ${String(q.value).slice(0, 80)}` });
  }

  // 6) Data-protection consent — the standing compliance default (accept the policy).
  //    The box is wrapped in its own <label>, whose text contains a lightbox link to the
  //    privacy policy: a real click lands on the label and can open that lightbox instead
  //    of ticking anything, so `check()` is tried first and a direct `checked = true` (plus
  //    the `change` the page listens for) is the fallback. Verified with isChecked() either way.
  if (answers.consent === true || /^(yes|accept|si|sí)$/i.test(String(answers.consent || ''))) {
    const box = page.locator('#edit-field-cv-conditions-und').first();
    if (await box.count()) {
      await box.check({ force: true, timeout: 3000 }).catch(() => {});
      if (!(await box.isChecked().catch(() => false))) {
        await page.evaluate(() => {
          const el = document.getElementById('edit-field-cv-conditions-und');
          if (!el) return;
          el.checked = true;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
      if (await box.isChecked().catch(() => false)) filled.push({ field: 'consent', value: 'checked' });
      else pending.push({ field: 'consent', note: 'tick the consent box by hand' });
    }
  }

  // The reCAPTCHA is the human's to solve; report whether it is actually on this form.
  const hasCaptcha = await page.locator('.g-recaptcha, iframe[src*="recaptcha"]').count();
  if (hasCaptcha) pending.push({ field: 'recaptcha', note: 'tick "No soy un robot" yourself before submitting' });

  await page.waitForTimeout(600);
  const shot = path.join(outDir, 'talentclue-filled.png');
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

  emit('filled', {
    filled, pending, shot, kind, uploadedType,
    note: 'Review every answer, fill what is listed as pending, solve the reCAPTCHA, then click "Inscríbete". Nothing is submitted by this script.',
  });
  writeState({ status: 'filled', url: applyUrl, kind, uploadedType, recaptcha: !!hasCaptcha, filled, pending, shot });

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
