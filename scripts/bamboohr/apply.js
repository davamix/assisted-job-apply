// BambooHR apply adapter. Fills a BambooHR application form from a per-job answers.json,
// then STOPS before submit and keeps the browser open so the human can add anything left
// (Address/ZIP, custom "Fabric" dropdowns), solve the reCAPTCHA, review, and submit.
// It NEVER clicks Submit.
//
// Résumé/CV detection: it reads the file-upload field's label, classifies it as CV vs
// Résumé (scripts/common/classify-doc-field.js), and uploads answers.resume_upload. If the
// form asks specifically for a Résumé and none has been authored yet, it does NOT upload —
// it emits `needs-resume` so a tailored output/<id>/resume.md can be written and rendered
// to resume.pdf, then re-run. See scripts/README.md.
//
//   node scripts/bamboohr/apply.js --url <careers-url> --id <dbId> \
//        --answers output/<id>/answers.json --outDir output/<id>
//
// Emits `EVENT {json}` lines and writes bamboo-state.json + bamboo-filled.png to --outDir.
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

// screening may be a { groupName: "Yes"|"No" } map or an array of
// { name?, question?, answer } rules. Normalize to rules; name match wins over question regex.
function normalizeScreening(screening) {
  if (!screening) return [];
  if (Array.isArray(screening)) return screening;
  return Object.entries(screening).map(([name, answer]) => ({ name, answer }));
}
function pickAnswer(rules, group) {
  for (const r of rules) if (r.name && r.name === group.name) return r.answer;
  for (const r of rules) if (r.question && new RegExp(r.question, 'i').test(group.question || '')) return r.answer;
  return undefined;
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
  const writeState = (o) => fs.writeFileSync(path.join(outDir, 'bamboo-state.json'), JSON.stringify(o, null, 2), 'utf8');
  const filled = [];

  // Text fields sourced from answers.json (skip any that are empty).
  const val = (v) => (v == null ? '' : String(v));
  const desiredPay = answers.desired_pay
    || (answers.salary_target ? `From ${answers.salary_target} ${answers.salary_currency || 'EUR'} (negotiable)` : '');
  const TEXT = {
    '#firstName': val(answers.first_name),
    '#lastName': val(answers.last_name),
    '#email': val(answers.email),
    '#phone': [val(answers.phone_country_code), val(answers.phone)].filter(Boolean).join(' '),
    '[name="city.value"]': val(answers.city),
    '#desiredPay': desiredPay,
    '#websiteUrl': val(answers.website),
    '#linkedinUrl': val(answers.linkedin),
  };

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await ctx.newPage();
  await page.goto(a.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.locator('[data-bi-id="careers-site-apply-button"]').first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(3500);

  // 1) Text fields.
  for (const [sel, value] of Object.entries(TEXT)) {
    if (!value) continue;
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) { await loc.fill(value, { timeout: 4000 }); filled.push({ field: sel, value }); }
    } catch (e) { /* leave for human */ }
  }

  // 2) Résumé / CV upload — detect what the field asks for, then decide what to attach.
  const fileInfo = await page.evaluate(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    // The upload widget's own chrome ("Choose File", "No file selected", …) and the
    // input's generic aria-label ("file-input") are not the field's caption — treat them
    // as noise so the real wording (e.g. "Resume", "CV") is what we classify.
    const strip = s => norm((s || '').replace(/choose file|no file selected|drag (and|&) drop|browse|upload a file|adjuntar|seleccionar archivo|ning[uú]n archivo|sin archivo/gi, ' '));
    const generic = t => !t || /^(file|file[-_ ]?input|upload|attachment|choose file|browse|archivo|adjuntar)\s*\*?$/i.test(t);
    const DOC = /r[eé]sum[eé]|\bcv\b|curriculum vitae/i;
    const f = document.querySelector('input[type=file]');
    if (!f) return { present: false, label: '' };
    let t = '';
    // 1) Explicit association: label[for], a wrapping <label>, or a meaningful aria-label.
    const id = f.getAttribute('id');
    if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) t = strip(l.textContent); }
    if (generic(t)) { const l = f.closest('label'); if (l) t = strip(l.textContent); }
    if (generic(t)) { const al = norm(f.getAttribute('aria-label')); if (!generic(al)) t = al; }
    // 2) A résumé/CV-worded caption near the input. BambooHR renders it as a plain <p>
    //    (not a <label>) and the real <input type=file> is a 0x0 overlay, so we match by
    //    wording + position (nearest such caption directly above) rather than DOM nesting.
    //    This is the signal classifyDocField acts on.
    if (generic(t) || !DOC.test(t)) {
      const fr = f.getBoundingClientRect();
      let best = null, bestGap = Infinity, firstDoc = null;
      document.querySelectorAll('label, legend, p, span, strong, b, h1, h2, h3, h4, h5, h6, [class*="label" i]').forEach(el => {
        if (el.querySelectorAll('*').length > 1) return;
        const s = strip(el.textContent);
        if (!s || s.length > 40 || !DOC.test(s)) return;
        if (!firstDoc) firstDoc = s;
        const r = el.getBoundingClientRect();
        const gap = fr.top - r.bottom;
        if (r.bottom <= fr.top + 6 && gap >= 0 && gap < bestGap) { bestGap = gap; best = s; }
      });
      if (best || firstDoc) t = best || firstDoc;
    }
    return { present: true, label: t };
  });

  const kind = classifyDocField(fileInfo.label); // 'cv' | 'resume' | 'unknown'
  emit('doc-field', { present: fileInfo.present, label: fileInfo.label, kind });

  const resumePdf = path.join(outDir, 'resume.pdf');
  const hasResume = fs.existsSync(resumePdf);
  const configured = answers.resume_upload ? String(answers.resume_upload) : '';
  const configuredIsResume = answers.resume_doc_type === 'resume' || /resume|résumé|resumé|résume/i.test(configured);

  let uploadPath = configured;
  let uploadedType = answers.resume_doc_type || (configuredIsResume ? 'resume' : 'cv');
  let needsResume = false;
  if (kind === 'resume') {
    if (hasResume) { uploadPath = resumePdf; uploadedType = 'resume'; }       // prefer the on-demand résumé
    else if (!configuredIsResume) { needsResume = true; uploadPath = ''; }    // gate: don't attach the CV to a résumé slot
  }

  if (fileInfo.present && uploadPath) {
    const abs = path.resolve(uploadPath);
    if (fs.existsSync(abs)) {
      try {
        await page.locator('input[type=file]').first().setInputFiles(abs);
        filled.push({ field: 'resume', value: path.basename(abs), kind, uploadedType });
        emit('uploaded', { file: path.basename(abs), kind, uploadedType });
      } catch (e) { emit('upload-error', { message: String(e) }); }
    } else {
      emit('upload-missing', { path: uploadPath });
    }
  }

  // 3) Country / State — native hidden selects, driven by answers (skip if not provided).
  const SELECTS = [];
  if (answers.country) SELECTS.push(['countryId.value', String(answers.country)]);
  if (answers.state) SELECTS.push(['state.value', String(answers.state)]);
  for (const [name, label] of SELECTS) {
    try {
      const sel = page.locator(`select[name="${name}"]`).first();
      if (await sel.count()) {
        await sel.selectOption({ label }).then(() => filled.push({ field: name, value: label })).catch(() => {});
      }
    } catch (e) {}
  }
  await page.waitForTimeout(500);

  // 4) Screening (Yes/No) radios — resolved from answers.screening (name or question match).
  const rules = normalizeScreening(answers.screening);
  const groups = await page.evaluate(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const seen = {}; const out = [];
    document.querySelectorAll('input[type=radio]').forEach(r => {
      const nm = r.getAttribute('name'); if (!nm || seen[nm]) return; seen[nm] = 1;
      let p = r.closest('fieldset, .fab-FormField, [class*="FormField" i], div'); let hops = 0, q = '';
      while (p && hops < 5) { const t = norm(p.innerText || ''); if (t.length > 8) { q = t; break; } p = p.parentElement; hops++; }
      out.push({ name: nm, question: q });
    });
    return out;
  });

  for (const group of groups) {
    const want = pickAnswer(rules, group);
    if (want == null) { emit('screening-unanswered', { name: group.name, question: group.question }); continue; }
    try {
      const tag = await page.evaluate(({ name, want }) => {
        const radios = [...document.querySelectorAll(`input[name="${CSS.escape(name)}"]`)];
        for (const r of radios) {
          const lab = r.closest('label') || (r.id ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`) : null);
          const txt = ((lab && lab.textContent) || '').replace(/\s+/g, ' ').trim();
          if (new RegExp('^' + want + '$', 'i').test(txt) || (lab && new RegExp('\\b' + want + '\\b', 'i').test(txt) && txt.length < 6)) {
            const el = lab || r; el.setAttribute('data-fill', name); return true;
          }
        }
        // Fallback by order: Yes = first, No = second.
        const idx = /^yes$/i.test(want) ? 0 : 1;
        if (radios[idx]) { const el = radios[idx].closest('label') || radios[idx]; el.setAttribute('data-fill', name); return true; }
        return false;
      }, { name: group.name, want });
      if (tag) {
        await page.locator(`[data-fill="${group.name}"]`).first().click({ timeout: 3000 }).catch(async () => {
          await page.evaluate((n) => { const el = document.querySelector(`[data-fill="${n}"]`); const r = el.querySelector ? el.querySelector('input[type=radio]') : el; if (r) { r.click(); r.dispatchEvent(new Event('change', { bubbles: true })); } }, group.name);
        });
        filled.push({ field: group.name.replace('customQuestionAnswers.', ''), value: want });
      }
    } catch (e) {}
  }

  await page.waitForTimeout(800);
  const shot = path.join(outDir, 'bamboo-filled.png');
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

  if (needsResume) {
    const note = 'Form asks for a RÉSUMÉ but none authored yet. Write output/' + (a.id || '<id>') +
      '/resume.md (condensed from the CV, tailored to the role), render it to resume.pdf, then re-run.';
    emit('needs-resume', { label: fileInfo.label, outDir, shot, note });
    writeState({ status: 'needs-resume', kind, label: fileInfo.label, filled, shot, note });
  } else {
    emit('filled', { filled, shot, kind, uploadedType, note: 'Address & ZIP left blank; reCAPTCHA + Submit are yours.' });
    writeState({ status: 'filled', kind, uploadedType, filled, shot });
  }

  // Keep the browser open for the human to finish. Close on signal or after 45 min.
  const closeFile = path.join(outDir, 'CLOSE');
  const deadline = Date.now() + 45 * 60 * 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(closeFile)) break;
    await page.waitForTimeout(2000);
  }
  await browser.close();
})().catch(e => { console.error('ERR', e); emit('error', { message: String(e) }); process.exit(1); });
