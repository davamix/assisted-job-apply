// Teamtailor apply adapter. Fills a Teamtailor application form from a per-job answers.json,
// then STOPS before submit and keeps the browser open so the human can finish anything left
// (unanswered screening questions, consent, review) and submit. It NEVER clicks Submit.
//
// Differences from the BambooHR adapter (scripts/bamboohr/apply.js) that shape this one:
//  - a cookie consent wall covers the page and swallows the first click;
//  - APPLY opens an in-page Stimulus overlay, not a new URL;
//  - fields are Rails-named: candidate[first_name], candidate[answers_attributes][N][choice];
//  - screening questions come as radio groups, multi-select checkbox groups, or free text,
//    and some are wrapped in custom comboboxes whose inputs are not directly clickable.
//
// Anything it cannot fill confidently is emitted as `screening-unanswered` and left for the
// human rather than guessed at. Questions are matched on wording, not index, since the
// answers_attributes indices are positional and shift when the posting is edited.
//
//   node scripts/teamtailor/apply.js --url <careers-url> --id <dbId> \
//        --answers output/<id>/answers.json --outDir output/<id>
//
// Emits `EVENT {json}` lines and writes tt-state.json + tt-filled.png to --outDir.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { classifyDocField } = require('../common/classify-doc-field');
const { mdToPlainText } = require('../common/md-to-text');

const emit = (event, extra = {}) => console.log('EVENT ' + JSON.stringify({ event, ...extra }));

const APPLY_SEL = 'button[data-action*="form-overlay#showFormOverlay"]';

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

// screening is an array of { question (regex, matched against the question wording), answer }.
// answer is a string for radio/text, or an array of strings for multi-select checkboxes.
function pickAnswer(rules, group) {
  for (const r of rules) {
    if (r.name && r.name === group.name) return r.answer;
  }
  for (const r of rules) {
    if (r.question && new RegExp(r.question, 'i').test(group.question || '')) return r.answer;
  }
  return undefined;
}

async function acceptCookies(page) {
  for (const t of ['Accept all', 'Aceptar todas', 'Accept', 'Aceptar', 'Allow all']) {
    const b = page.locator(`button:has-text("${t}")`).first();
    if (await b.count()) { await b.click({ timeout: 3000 }).catch(() => {}); return t; }
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
  const writeState = (o) => fs.writeFileSync(path.join(outDir, 'tt-state.json'), JSON.stringify(o, null, 2), 'utf8');
  const filled = [];
  const unanswered = [];

  const val = (v) => (v == null ? '' : String(v));
  const TEXT = {
    'candidate[first_name]': val(answers.first_name),
    'candidate[last_name]': val(answers.last_name),
    'candidate[email]': val(answers.email),
    'candidate[phone]': [val(answers.phone_country_code), val(answers.phone)].filter(Boolean).join(' '),
  };

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await ctx.newPage();
  await page.goto(a.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const cookie = await acceptCookies(page);
  emit('cookies', { accepted: cookie });
  await page.waitForTimeout(1500);

  await page.locator(APPLY_SEL).first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // 1) Personal text fields.
  for (const [name, value] of Object.entries(TEXT)) {
    if (!value) continue;
    try {
      const loc = page.locator(`[name="${name}"]`).first();
      if (await loc.count()) { await loc.fill(value, { timeout: 4000 }); filled.push({ field: name, value }); }
    } catch (e) { /* leave for human */ }
  }

  // 2) CV upload. Teamtailor labels the first file input "Upload CV" and the second
  //    "Additional files"; classify the caption so a Résumé-specific ask is not silently
  //    satisfied with the full CV (same gate as the BambooHR adapter).
  const fileInfo = await page.evaluate(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const f = document.querySelector('input[type=file]');
    if (!f) return { present: false, label: '' };
    let t = '';
    const id = f.getAttribute('id');
    if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) t = norm(l.textContent); }
    if (!t) { const l = f.closest('label'); if (l) t = norm(l.textContent); }
    if (!t) t = norm(f.getAttribute('aria-label'));
    return { present: true, label: t.replace(/\*?\s*Required$/i, '').trim() };
  });

  const kind = classifyDocField(fileInfo.label); // 'cv' | 'resume' | 'unknown'
  emit('doc-field', { present: fileInfo.present, label: fileInfo.label, kind });

  const resumePdf = path.join(outDir, 'resume.pdf');
  const hasResume = fs.existsSync(resumePdf);
  const configured = answers.cv_upload ? String(answers.cv_upload) : '';
  let uploadPath = configured;
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
        await page.locator('input[type=file]').first().setInputFiles(abs);
        filled.push({ field: 'cv', value: path.basename(abs), kind, uploadedType });
        emit('uploaded', { file: path.basename(abs), kind, uploadedType });
      } catch (e) { emit('upload-error', { message: String(e) }); }
    } else {
      emit('upload-missing', { path: uploadPath });
    }
  }

  // 3) Cover letter (textarea). Authored as Markdown; the field takes prose, so flatten it.
  const clPath = answers.cover_letter_text_file ? path.resolve(String(answers.cover_letter_text_file)) : '';
  if (clPath && fs.existsSync(clPath)) {
    try {
      const body = mdToPlainText(fs.readFileSync(clPath, 'utf8'));
      const ta = page.locator('[name="candidate[job_applications_attributes][0][cover_letter]"]').first();
      if (await ta.count()) {
        await ta.fill(body, { timeout: 5000 });
        filled.push({ field: 'cover_letter', value: path.basename(clPath), chars: body.length });
      }
    } catch (e) { emit('cover-letter-error', { message: String(e) }); }
  } else if (clPath) {
    emit('cover-letter-missing', { path: clPath });
  }

  // 4) Screening questions. Enumerate each answers_attributes group with its wording and
  //    control type, then resolve against answers.screening by wording.
  const groups = await page.evaluate(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const byIdx = {};
    document.querySelectorAll('[name*="answers_attributes"]').forEach(el => {
      const name = el.getAttribute('name') || '';
      const m = /answers_attributes\]\[(\d+)\]\[(\w+)\]/.exec(name);
      if (!m) return;
      const [, idx, key] = m;
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (!byIdx[idx]) byIdx[idx] = { index: Number(idx), key: '', names: new Set(), type: '', question: '', choices: [] };
      const g = byIdx[idx];

      // Question wording sits on the group-level container. Teamtailor anchors a hidden
      // input there, higher in the DOM than the individual choice inputs — walking up from
      // a choice input only reaches that choice's own wrapper, which yields the choice
      // labels ("Less than 1 Between 1 and 3 years…") instead of the question. So use the
      // hidden input purely as the anchor for the wording, never as a fillable control.
      if (!g.question) {
        let p = el.closest('div,fieldset,li,section'), hops = 0;
        while (p && hops < 6) {
          const t = norm(p.innerText || '');
          if (t.length > 12) { g.question = t.split('\n')[0].replace(/\*?\s*Required.*$/i, '').trim(); break; }
          p = p.parentElement; hops++;
        }
      }
      if (type === 'hidden') return;

      g.key = g.key || key;
      g.names.add(name);
      if (type === 'radio' || type === 'checkbox') {
        g.type = type;
        const id = el.getAttribute('id');
        const lab = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) || el.closest('label');
        const txt = norm(lab && lab.textContent);
        if (txt) g.choices.push(txt);
      } else {
        g.type = 'text';
      }
    });
    return Object.values(byIdx)
      .map(g => ({ ...g, names: [...g.names], name: [...g.names][0] }))
      .filter(g => g.names.length) // drop groups that were hidden-only: nothing to fill
      .sort((x, y) => x.index - y.index);
  });
  emit('questions', { count: groups.length, questions: groups.map(g => ({ index: g.index, type: g.type, question: g.question })) });

  const rules = Array.isArray(answers.screening) ? answers.screening : [];
  for (const group of groups) {
    const want = pickAnswer(rules, group);
    if (want == null) {
      unanswered.push({ index: group.index, question: group.question, type: group.type, choices: group.choices });
      emit('screening-unanswered', { index: group.index, question: group.question, type: group.type });
      continue;
    }

    if (group.type === 'text') {
      try {
        const loc = page.locator(`[name="${group.name}"]`).first();
        if (await loc.count()) { await loc.fill(String(want), { timeout: 4000 }); filled.push({ field: group.question, value: String(want) }); }
      } catch (e) { emit('fill-error', { question: group.question, message: String(e) }); }
      continue;
    }

    // Radio / checkbox. Two renderings exist and they need different handling:
    //  - plain choice buttons, whose label is directly clickable;
    //  - a Stimulus dropdown (forms--inputs--choice, show-as-dropdown-value="true"). Its
    //    radios are sr-only and live OUTSIDE the panel, so label[for=…] is never clickable;
    //    the panel holds <button data-search-text="…"> menu items that call selectRadio.
    //    Open the panel, click the menu item, and let the controller check the radio —
    //    forcing `checked` directly leaves the component's own required validation input
    //    empty ("You must select an option"), which silently blocks submit later.
    // Either way, the click is only believed once the input reports checked.
    const wants = Array.isArray(want) ? want : [want];
    for (const w of wants) {
      const info = await page.evaluate(({ names, w }) => {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim();
        const inputs = names.flatMap(n => [...document.querySelectorAll(`[name="${CSS.escape(n)}"]`)]);
        for (const el of inputs) {
          const id = el.getAttribute('id');
          const lab = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) || el.closest('label');
          const txt = norm(lab && lab.textContent);
          if (txt && txt.toLowerCase() === String(w).toLowerCase()) {
            const root = el.closest('[data-controller~="forms--inputs--choice"]');
            const isDropdown = !!root && root.getAttribute('data-forms--inputs--choice-show-as-dropdown-value') === 'true';
            const btn = root && root.querySelector('[data-common--dropdown-target="button"]');
            const panel = root && root.querySelector('[data-common--dropdown-target="dropdown"]');
            let optionId = null;
            if (panel) {
              const item = [...panel.querySelectorAll('[data-common--dropdown-target="menuItem"]')]
                .find(b => norm(b.getAttribute('data-search-text')).toLowerCase() === String(w).toLowerCase());
              if (item) {
                if (!item.id) item.id = 'tt-opt-' + Math.random().toString(36).slice(2, 9);
                optionId = item.id;
              }
            }
            return { found: true, inputId: id, isDropdown, buttonId: btn ? btn.getAttribute('id') : null, optionId };
          }
        }
        return { found: false };
      }, { names: group.names, w });

      let ok = false;
      if (info.found && info.inputId) {
        try {
          if (info.isDropdown) {
            if (!info.buttonId || !info.optionId) throw new Error('dropdown trigger or option not found');
            await page.locator(`#${info.buttonId}`).scrollIntoViewIfNeeded().catch(() => {});
            await page.locator(`#${info.buttonId}`).click({ timeout: 4000 });
            await page.waitForTimeout(400);
            await page.locator(`#${info.optionId}`).click({ timeout: 4000 });
          } else {
            await page.locator(`label[for="${info.inputId}"]`).first().click({ timeout: 4000 });
          }
          await page.waitForTimeout(300);
          ok = await page.locator(`#${info.inputId}`).isChecked().catch(() => false);
          if (ok && info.isDropdown && info.buttonId) {
            // Single-select panels close themselves; multi-select ones stay open and would
            // cover the fields below.
            const open = await page.locator(`#${info.buttonId}`).getAttribute('aria-expanded').catch(() => null);
            if (open === 'true') await page.locator(`#${info.buttonId}`).click({ timeout: 2000 }).catch(() => {});
          }
        } catch (e) { ok = false; }
      }

      if (ok) {
        filled.push({ field: group.question, value: w });
      } else {
        unanswered.push({ index: group.index, question: group.question, type: group.type, choices: group.choices, wanted: w });
        emit('screening-click-failed', { index: group.index, question: group.question, wanted: w, dropdown: !!info.isDropdown });
      }
    }
  }

  // 5) Privacy-policy consent — accept per the standing compliance defaults.
  // Rails emits a hidden value="0" input *before* the real checkbox, sharing its name, so
  // select on type: matching the name alone lands on the hidden one and checks nothing.
  if (answers.consent === true || /^(yes|accept)$/i.test(String(answers.consent || ''))) {
    try {
      const c = page.locator('input[type=checkbox][name="candidate[consent_given]"]').first();
      if (await c.count()) {
        await c.check({ timeout: 4000 }).catch(() => {});
        if (await c.isChecked().catch(() => false)) filled.push({ field: 'consent_given', value: 'checked' });
        else emit('consent-failed', { note: 'consent checkbox not checked — do it by hand' });
      }
    } catch (e) { emit('consent-failed', { message: String(e) }); }
  }

  await page.waitForTimeout(800);
  const shot = path.join(outDir, 'tt-filled.png');
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

  if (needsResume) {
    const note = 'Form asks for a RÉSUMÉ but none authored yet. Write output/' + (a.id || '<id>') +
      '/resume.md (condensed from the CV, tailored to the role), render it to resume.pdf, then re-run.';
    emit('needs-resume', { label: fileInfo.label, outDir, shot, note });
    writeState({ status: 'needs-resume', kind, label: fileInfo.label, filled, unanswered, shot, note });
  } else {
    emit('filled', { filled, unanswered, shot, kind, uploadedType, note: 'Unanswered questions + Submit are yours.' });
    writeState({ status: 'filled', kind, uploadedType, filled, unanswered, shot });
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
