// Bizneo apply adapter. Fills a Bizneo ATS application form (careers.ats.bizneo.cloud)
// from a per-job answers.json, then STOPS before submit and keeps the browser open so the
// human can finish anything left (the "Disponibilidad hasta" date, review) and click
// "Enviar candidatura". It NEVER clicks Submit.
//
// The Bizneo public application form (reached via the LinkedIn "Apply on company website"
// link, ?displayed_form=true) needs no login. Its fields are Rails-named
// (inscription_form[user_form][…]) and carry three traps that shape this adapter:
//   - Country + City are select2 widgets, not plain <select>s. Setting the native value
//     does NOT fire the change select2/htmx listen for, so the country->city htmx cascade
//     never runs. Both must be driven through the select2 UI (open, type, click option).
//   - City (region_id) is a select2 REMOTE autocomplete (data-url=/suggest/locations,
//     min-input-length=3): there is no static option list — type >=3 chars and pick from
//     the AJAX results ("Barcelona, Barcelona, Cataluña, España").
//   - The "Disponibilidad" dates use air-datepicker: the submitted value lives on a hidden
//     real <input>, mirrored by a readonly visible one. Force-filling the real input sets
//     the value; we also drive the calendar's "today" cell when we can.
//
// The consent checkbox, like other Rails forms, is preceded by a hidden value="0" input
// sharing its name — match on input[type=checkbox] or you check nothing.
//
//   node scripts/bizneo/apply.js --url <bizneo-form-url> --id <dbId> \
//        --answers output/<id>/answers.json --outDir output/<id>
//
// Emits `EVENT {json}` lines and writes bizneo-state.json + bizneo-filled.png to --outDir.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { classifyDocField } = require('../common/classify-doc-field');

const emit = (event, extra = {}) => console.log('EVENT ' + JSON.stringify({ event, ...extra }));
const N = 'inscription_form[user_form]';

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

// DD/MM/YYYY for a Date (Bizneo/Spanish locale).
function ddmmyyyy(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Resolve an availability value: "today" -> today's date, else pass a DD/MM/YYYY through.
function resolveDate(v) {
  if (!v) return null;
  if (/^today$/i.test(String(v))) return ddmmyyyy(new Date());
  return String(v);
}

async function acceptCookies(page) {
  for (const t of ['Aceptar todas', 'Aceptar', 'Accept all', 'Accept', 'Allow all', 'Aceptar todo']) {
    const b = page.locator(`button:has-text("${t}")`).first();
    if (await b.count()) { await b.click({ timeout: 3000 }).catch(() => {}); return t; }
  }
  return null;
}

// Drive a select2 widget attached to native <select id=selectId>: open, type, click match.
// Works for both the static country list and the remote (AJAX) city autocomplete.
async function select2Pick(page, selectId, typeText, matchRe, { remote = false } = {}) {
  const container = page.locator(`#select2-${selectId}-container`);
  if (!(await container.count())) return { ok: false, reason: 'container-not-found' };
  await container.scrollIntoViewIfNeeded().catch(() => {});
  await container.click({ timeout: 5000 });
  await page.waitForTimeout(400);
  const search = page.locator('input.select2-search__field').first();
  if (await search.count()) await search.fill(typeText, { timeout: 4000 }).catch(() => {});
  // Remote options need the AJAX round-trip; static ones are instant.
  await page.waitForTimeout(remote ? 2600 : 700);
  const opts = page.locator('li.select2-results__option');
  const n = await opts.count();
  for (let i = 0; i < n; i++) {
    const t = (await opts.nth(i).innerText().catch(() => '')).trim();
    if (matchRe.test(t)) { await opts.nth(i).click({ timeout: 4000 }).catch(() => {}); return { ok: true, picked: t }; }
  }
  // Close the dropdown so it doesn't cover fields below.
  await page.keyboard.press('Escape').catch(() => {});
  return { ok: false, reason: 'no-match', sample: [] };
}

// Fill an air-datepicker field: click the visible input to open the calendar and click the
// "today" cell; fall back to force-filling the real hidden input with the DD/MM/YYYY string.
async function fillDatepicker(page, fieldName, value) {
  const real = page.locator(`input[name="${fieldName}"]`).first();
  if (!(await real.count())) return { ok: false, reason: 'field-not-found' };
  const today = /^(today)$/i.test(String(value)) || value === ddmmyyyy(new Date());
  const wrapper = real.locator('xpath=ancestor::div[contains(@class,"air-datepicker-inputs-wrapper")]').first();
  const visible = wrapper.locator('input.air-alt-input').first();
  try {
    if (today && await visible.count()) {
      await visible.click({ timeout: 3000 });
      await page.waitForTimeout(500);
      const cur = page.locator('.air-datepicker-cell.-current-').first();
      if (await cur.count()) { await cur.click({ timeout: 3000 }); await page.waitForTimeout(300); }
    }
  } catch { /* fall through to force-fill */ }
  let v = await real.inputValue().catch(() => '');
  if (!v) {
    // Force-fill the real input with the literal date string.
    await real.fill(String(value), { timeout: 3000 }).catch(() => {});
    await real.dispatchEvent('change').catch(() => {});
    await real.dispatchEvent('input').catch(() => {});
    // Mirror it into the visible readonly field so the human sees it.
    const vis = wrapper.locator('input.air-alt-input').first();
    if (await vis.count()) await vis.evaluate((el, val) => { el.value = val; }, String(value)).catch(() => {});
    v = await real.inputValue().catch(() => '');
  }
  return { ok: !!v, value: v };
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
  const writeState = (o) => fs.writeFileSync(path.join(outDir, 'bizneo-state.json'), JSON.stringify(o, null, 2), 'utf8');
  const filled = [];
  const pending = []; // things deliberately left for the human

  const val = (v) => (v == null ? '' : String(v));
  const TEXT = {
    [`${N}[email]`]: val(answers.email),
    [`${N}[first_name]`]: val(answers.first_name),
    [`${N}[last_name]`]: val(answers.last_name),
    [`${N}[desired_salary]`]: val(answers.desired_salary),
    [`${N}[linkedin]`]: val(answers.linkedin),
  };

  // Real runs are headed and wait for the human to submit. --dryRun fills headlessly,
  // screenshots, and exits without the human gate — used to validate a fill end to end.
  const dryRun = !!a.dryRun;
  const browser = await chromium.launch({ headless: dryRun || !!a.headless });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await ctx.newPage();
  await page.goto(a.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const cookie = await acceptCookies(page);
  emit('cookies', { accepted: cookie });
  await page.waitForTimeout(800);

  // The ?displayed_form=true URL shows the form directly; if not, click "¡Aplica ahora!".
  if (!(await page.locator(`[name="${N}[email]"]`).count())) {
    await page.locator('button:has-text("Aplica ahora"), a:has-text("Aplica ahora")').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  // 1) Plain text fields.
  for (const [name, value] of Object.entries(TEXT)) {
    if (!value) continue;
    try {
      const loc = page.locator(`[name="${name}"]`).first();
      if (await loc.count()) { await loc.fill(value, { timeout: 4000 }); filled.push({ field: name, value }); }
    } catch (e) { emit('fill-error', { field: name, message: String(e).slice(0, 160) }); }
  }

  // 2) CV upload. Label is "Adjuntar CV" -> classifies as CV. Honor the CV-vs-Résumé gate:
  //    an explicit Résumé ask must not be silently satisfied with the full CV.
  const fileName = `${N}[assets_attributes][0][file]`;
  const fileInfo = await page.evaluate((fname) => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const f = document.querySelector(`input[name="${fname}"]`) || document.querySelector('input[type=file]');
    if (!f) return { present: false, label: '' };
    let t = '';
    const id = f.getAttribute('id');
    if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) t = norm(l.textContent); }
    if (!t) { const l = f.closest('label'); if (l) t = norm(l.textContent); }
    if (!t) t = norm(f.getAttribute('aria-label'));
    return { present: true, label: t.replace(/\*?\s*(Required|Obligatorio)$/i, '').trim() };
  }, fileName);

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
        await page.locator(`input[name="${fileName}"]`).first().setInputFiles(abs);
        await page.waitForTimeout(1200);
        filled.push({ field: 'cv', value: path.basename(abs), kind, uploadedType });
        emit('uploaded', { file: path.basename(abs), kind, uploadedType });
      } catch (e) { emit('upload-error', { message: String(e).slice(0, 160) }); }
    } else {
      emit('upload-missing', { path: uploadPath });
    }
  }

  // 3) Country -> City (both select2; country runs an htmx cascade first). select2 builds
  //    its container id from the native <select>'s id: inscription_form_user_form_<field>.
  const countryText = answers.country || 'España';
  const cRes = await select2Pick(page, 'inscription_form_user_form_country_code', countryText, new RegExp(`^${countryText}$`, 'i'));
  emit('country', cRes);
  if (cRes.ok) filled.push({ field: 'country', value: cRes.picked }); else pending.push({ field: 'country', note: 'pick country by hand' });
  await page.waitForTimeout(1800); // let the htmx region cascade settle

  const cityText = answers.city || 'Barcelona';
  const cityRes = await select2Pick(page, `inscription_form_user_form_region_id`, cityText, new RegExp(cityText, 'i'), { remote: true });
  emit('city', cityRes);
  if (cityRes.ok) filled.push({ field: 'city', value: cityRes.picked }); else pending.push({ field: 'city', note: 'type >=3 chars and pick the city by hand' });

  // 4) Availability dates (air-datepicker). "desde" = start; fill from answers (default today).
  const fromVal = resolveDate(answers.availability_from || 'today');
  const fromRes = await fillDatepicker(page, `${N}[availability_init_date]`, fromVal);
  emit('availability-from', fromRes);
  if (fromRes.ok) filled.push({ field: 'availability_from', value: fromRes.value });

  //    "hasta" (availability end) is required but semantically odd for a permanent, open-ended
  //    candidate — do NOT fabricate one. Fill only if the answers file states it explicitly;
  //    otherwise leave it for the human to pick in the calendar during review.
  if (answers.availability_to) {
    const toRes = await fillDatepicker(page, `${N}[availability_end_date]`, resolveDate(answers.availability_to));
    emit('availability-to', toRes);
    if (toRes.ok) filled.push({ field: 'availability_to', value: toRes.value });
  } else {
    pending.push({ field: 'availability_to', note: 'REQUIRED "Disponibilidad hasta" left blank — pick a date in the calendar before submit' });
    emit('availability-to-pending', { note: 'left blank on purpose (permanent/open-ended); set it by hand' });
  }

  // 5) Privacy-policy consent. Two traps: (a) a hidden value="0" input precedes the checkbox
  //    and shares its name, so match on input[type=checkbox] or you toggle the wrong one; and
  //    (b) the real checkbox is visually hidden (opacity:0, 1px, position:absolute) with the
  //    click surface on its <label>, so a plain .check() sees it as non-actionable and fails.
  //    check({force:true}) toggles the input directly (and avoids the privacy-policy <a> inside
  //    the label); fall back to clicking the label if that ever stops working.
  if (answers.consent === true || /^(yes|accept|si|sí)$/i.test(String(answers.consent || ''))) {
    const c = page.locator(`input[type=checkbox][name="inscription_form[terms_and_conditions]"]`).first();
    try {
      if (await c.count()) {
        await c.check({ force: true, timeout: 4000 }).catch(() => {});
        if (!(await c.isChecked().catch(() => false))) {
          const id = await c.getAttribute('id').catch(() => null);
          if (id) await page.locator(`label[for="${id}"]`).first().click({ timeout: 3000 }).catch(() => {});
        }
        if (await c.isChecked().catch(() => false)) filled.push({ field: 'consent', value: 'checked' });
        else { pending.push({ field: 'consent', note: 'tick the privacy-policy consent box by hand' }); emit('consent-failed', { note: 'consent checkbox not checked — do it by hand' }); }
      }
    } catch (e) { emit('consent-failed', { message: String(e).slice(0, 160) }); }
  }

  await page.waitForTimeout(800);
  const shot = path.join(outDir, 'bizneo-filled.png');
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

  if (needsResume) {
    const note = 'Form asks for a RÉSUMÉ but none authored yet. Write output/' + (a.id || '<id>') +
      '/resume.md (condensed from the CV, tailored to the role), render it to resume.pdf, then re-run.';
    emit('needs-resume', { label: fileInfo.label, outDir, shot, note });
    writeState({ status: 'needs-resume', kind, label: fileInfo.label, filled, pending, shot, note });
  } else {
    emit('filled', { filled, pending, shot, kind, uploadedType, note: 'Review, set "Disponibilidad hasta", then click "Enviar candidatura". Nothing is submitted by this script.' });
    writeState({ status: 'filled', kind, uploadedType, filled, pending, shot });
  }

  // Keep the browser open for the human to finish + submit. Close on CLOSE signal or 45 min.
  // A dry run skips the human gate entirely (it never had a visible browser to submit in).
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
