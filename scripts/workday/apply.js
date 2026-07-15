// Workday apply adapter. Signs in from the saved session (scripts/workday/login.js), walks
// the MANUAL apply wizard filling each step from a per-job answers.json, verifies every
// field it touches, and STOPS before the final submit — the human reviews and submits.
// It NEVER clicks Submit.
//
//   node scripts/workday/apply.js --url <job-url> --id <dbId> \
//        [--answers output/<id>/answers.json] [--outDir output/<id>] \
//        [--auth .auth/workday-<tenant>-state.json] [--headed] [--maxStep 1]
//
// Emits `EVENT {json}` lines and writes wd-state.json + wd-step<N>.png to --outDir.
//
// Notes on Workday, learned by probing IQVIA's tenant:
//  - Entering the wizard creates a DRAFT application in the tenant. Reversible, but real.
//  - "Apply Manually" is used over "Autofill with Resume" on purpose: the parser rewrites
//    experience into the application unreviewed, and nothing here should claim something
//    the human did not choose.
//  - Every field is wrapped in [data-automation-id="formField-<name>"]; options in a
//    dropdown are [data-automation-id="promptOption"]. This vocabulary is stable across
//    tenants, unlike the tenant-specific landing paths (IQVIA uses /userHome, others
//    /candidate_home).
//  - Some fields (Country, Country Phone Code) arrive pre-filled from the account; the
//    adapter leaves a correct value alone rather than re-selecting it.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

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

const ff = (name) => `[data-automation-id="formField-${name}"]`;

// --- field helpers. Each returns true only after re-reading the DOM. -------------------

async function fillText(page, name, value) {
  if (!value) return null;
  const loc = page.locator(`${ff(name)} input, input[name="${name}"]`).first();
  if (!(await loc.count())) return null;
  await loc.fill(String(value), { timeout: 5000 }).catch(() => {});
  const got = await loc.inputValue().catch(() => '');
  return got.trim() === String(value).trim();
}

// Radios are real inputs but their labels do not take a click reliably — check the input
// itself, found by matching its label[for] text, and read .checked back as proof.
async function pickRadio(page, name, label) {
  if (!label) return null;
  if (!(await page.locator(ff(name)).count())) return null;
  const id = await page.evaluate(({ n, l }) => {
    const w = document.querySelector(`[data-automation-id="formField-${n}"]`);
    if (!w) return null;
    for (const r of w.querySelectorAll('input[type=radio]')) {
      const lab = (r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)) || r.closest('label');
      const txt = ((lab && lab.textContent) || '').replace(/\s+/g, ' ').trim();
      if (txt.toLowerCase() === String(l).toLowerCase()) return r.id;
    }
    return null;
  }, { n: name, l: label });
  if (!id) return false;
  const input = page.locator(`#${id}`);
  await input.check({ timeout: 4000 }).catch(async () => {
    await page.locator(`label[for="${id}"]`).first().click({ timeout: 3000 }).catch(() => {});
  });
  return input.isChecked().catch(() => false);
}

// A plain Workday dropdown: a button[aria-haspopup="listbox"] whose options are
// <li role="option"> — NOT promptOption, which belongs to the multiselect widget below.
// The trigger's own text is the current selection, and that is how the result is verified.
async function pickPrompt(page, name, value) {
  if (!value) return null;
  const trigger = page.locator(`${ff(name)} button[aria-haspopup="listbox"]`).first();
  if (!(await trigger.count())) return null;
  const current = (await trigger.textContent().catch(() => '') || '').trim();
  if (current.toLowerCase() === String(value).toLowerCase()) return true; // pre-filled
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
  const opt = page.locator(`li[role="option"]`).filter({ hasText: new RegExp(`^\\s*${value}\\s*$`, 'i') }).first();
  if (!(await opt.count())) { await page.keyboard.press('Escape').catch(() => {}); return false; }
  await opt.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(700);
  const after = (await trigger.textContent().catch(() => '') || '').trim();
  return after.toLowerCase() === String(value).toLowerCase();
}

// Click an option in an open multiselect popup, scrolling to find it.
// Two traps: the list is VIRTUALISED (an option that has not rendered yet is not absent —
// IQVIA's "LinkedIn" entry only appears after ~3 scrolls), and the already-selected pills
// reuse the promptOption id, so options inside selectedItemList must be excluded.
async function clickPromptOption(page, text) {
  for (let i = 0; i < 15; i++) {
    const hit = await page.evaluate(({ t }) => {
      const os = [...document.querySelectorAll('[data-automation-id="promptOption"]')]
        .filter(o => !o.closest('[data-automation-id="selectedItemList"]'));
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const found = os.find(o => norm(o.textContent) === String(t).toLowerCase());
      if (found) { found.setAttribute('data-wd-target', '1'); return true; }
      const last = os[os.length - 1];
      if (last) last.scrollIntoView({ block: 'end' });
      return false;
    }, { t: text });
    if (hit) {
      await page.locator('[data-wd-target="1"]').first().click({ timeout: 4000 }).catch(() => {});
      await page.evaluate(() => document.querySelectorAll('[data-wd-target]').forEach(e => e.removeAttribute('data-wd-target')));
      return true;
    }
    await page.waitForTimeout(700);
  }
  return false;
}

// Like pickPrompt, but the wanted answer is a SUBSTRING of the option. Application
// Question options are full sentences carrying en-dashes and curly quotes ("NO – I am NOT
// a UK licensed Medic…"), so exact matching is hopeless; the substring is what answers.json
// carries. Verified by reading the trigger's text back.
async function pickPromptContains(page, name, needle) {
  if (!needle) return null;
  const trigger = page.locator(`${ff(name)} button[aria-haspopup="listbox"]`).first();
  if (!(await trigger.count())) return null;
  const has = async () => {
    const t = (await trigger.textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
    return t.toLowerCase().includes(String(needle).toLowerCase());
  };
  if (await has()) return true;
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(900);
  const hit = await page.evaluate(({ n }) => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const os = [...document.querySelectorAll('li[role="option"]')];
    const exact = os.find(o => norm(o.textContent).toLowerCase() === String(n).toLowerCase());
    const partial = os.find(o => norm(o.textContent).toLowerCase().includes(String(n).toLowerCase()));
    const target = exact || partial;
    if (target) { target.setAttribute('data-wd-opt', '1'); return norm(target.textContent); }
    return null;
  }, { n: needle });
  if (!hit) { await page.keyboard.press('Escape').catch(() => {}); return false; }
  await page.locator('[data-wd-opt="1"]').first().click({ timeout: 4000 }).catch(() => {});
  await page.evaluate(() => document.querySelectorAll('[data-wd-opt]').forEach(e => e.removeAttribute('data-wd-opt')));
  await page.waitForTimeout(700);
  return has();
}

// The Skills multiselect is search-driven, not browsable: it shows "No Items." until a
// query is TYPED, and the lookup is server-side and slow (several seconds), so an empty
// option list means "still searching", not "no such skill". Only an exact taxonomy match
// is accepted — the near misses for "C#" alone include "C Sharp (Programming Language)",
// "Unity C#" and "Objective-C", so guessing at the closest one would put skills on the
// application that were never claimed.
async function addSkill(page, skill) {
  const wrap = page.locator(ff('skills')).first();
  if (!(await wrap.count())) return null;
  const pills = () => wrap.locator('[data-automation-id="selectedItem"]').allTextContents().catch(() => []);
  const has = async () => (await pills()).some(t => t.replace(/\s+/g, ' ').trim().toLowerCase() === String(skill).toLowerCase());
  if (await has()) return true;

  const input = wrap.locator('input').first();
  await input.click({ timeout: 5000 }).catch(() => {});
  await input.fill('').catch(() => {});
  await input.type(String(skill), { delay: 120 }).catch(() => {});
  // Typing alone does not run the lookup — the query is only submitted on Enter. Without
  // this the list stays "No Items." forever and every skill looks unmatched.
  await page.waitForTimeout(600);
  await input.press('Enter').catch(() => {});

  let found = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(700);
    found = await page.evaluate(({ t }) => {
      const os = [...document.querySelectorAll('[data-automation-id="promptOption"]')]
        .filter(o => !o.closest('[data-automation-id="selectedItemList"]'));
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const hit = os.find(o => norm(o.textContent).toLowerCase() === String(t).toLowerCase());
      if (hit) { hit.setAttribute('data-wd-target', '1'); return true; }
      return false;
    }, { t: skill });
    if (found) break;
  }
  if (!found) { await input.fill('').catch(() => {}); return false; }
  await page.locator('[data-wd-target="1"]').first().click({ timeout: 4000 }).catch(() => {});
  await page.evaluate(() => document.querySelectorAll('[data-wd-target]').forEach(e => e.removeAttribute('data-wd-target')));
  await page.waitForTimeout(1200);
  return has();
}

// A Workday searchable multiselect (e.g. "How Did You Hear About Us"). Its options are
// HIERARCHICAL and typing does NOT filter into the children, so the taxonomy path must be
// walked level by level (["Job Boards/Websites", "Job Boards/Websites - LinkedIn - Job
// Posting"]). The choice becomes a [selectedItem] pill — the pill is the proof.
async function pickPromptPath(page, name, pathArr) {
  const steps = Array.isArray(pathArr) ? pathArr : [pathArr];
  if (!steps.length || !steps[0]) return null;
  const wrap = page.locator(ff(name)).first();
  if (!(await wrap.count())) return null;
  const target = String(steps[steps.length - 1]);
  const pills = () => wrap.locator('[data-automation-id="selectedItem"]').allTextContents().catch(() => []);
  if ((await pills()).some(t => t.toLowerCase().includes(target.toLowerCase()))) return true;

  const input = wrap.locator('input').first();
  if (!(await input.count())) return null;
  await input.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1300);
  for (const level of steps) {
    if (!(await clickPromptOption(page, level))) {
      await page.keyboard.press('Escape').catch(() => {});
      return false;
    }
    await page.waitForTimeout(1600);
  }
  await page.waitForTimeout(800);
  return (await pills()).some(t => t.toLowerCase().includes(target.toLowerCase()));
}

// --- step enumeration ------------------------------------------------------------------

async function dumpStep(page) {
  return page.evaluate(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const labelFor = (el) => {
      let t = '';
      const id = el.getAttribute('id');
      if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) t = norm(l.textContent); }
      if (!t) { const l = el.closest('label'); if (l) t = norm(l.textContent); }
      if (!t) t = norm(el.getAttribute('aria-label'));
      return t;
    };
    const fields = [];
    document.querySelectorAll('[data-automation-id^="formField-"]').forEach(w => {
      const name = (w.getAttribute('data-automation-id') || '').replace(/^formField-/, '');
      const el = w.querySelector('input, select, textarea, [aria-haspopup="listbox"]');
      if (!el) return;
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      // Application Questions are named by GUID and their control only says "Select One",
      // so the question itself has to come off the wrapper's own label/legend.
      const wrapLabel = norm((w.querySelector('label, legend') || {}).textContent || '');
      fields.push({
        name,
        type,
        required: el.getAttribute('aria-required') === 'true' || el.required || null,
        label: wrapLabel || labelFor(el),
        value: el.value || norm(el.textContent) || null,
      });
    });
    const active = document.querySelector('[data-automation-id="progressBarActiveStep"]');
    return {
      url: location.href,
      step: norm(active && active.textContent),
      fields,
      hasNext: !!document.querySelector('[data-automation-id="pageFooterNextButton"]'),
      nextText: norm((document.querySelector('[data-automation-id="pageFooterNextButton"]') || {}).textContent || ''),
    };
  });
}

// --- main -------------------------------------------------------------------------------

(async () => {
  const a = parseArgs(process.argv);
  if (!a.url) { console.error(JSON.stringify({ error: 'need --url' })); process.exit(2); }
  const outDir = a.outDir || (a.id ? `output/${a.id}` : 'output');
  const answersPath = a.answers || path.join(outDir, 'answers.json');
  if (!fs.existsSync(answersPath)) { console.error(JSON.stringify({ error: `answers not found: ${answersPath}` })); process.exit(2); }
  const answers = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
  const authFile = path.resolve(String(a.auth || path.join(__dirname, '..', '..', '.auth', 'workday-iqvia-state.json')));
  if (!fs.existsSync(authFile)) { console.error(JSON.stringify({ error: `auth not found: ${authFile} — run scripts/workday/login.js` })); process.exit(2); }
  fs.mkdirSync(outDir, { recursive: true });
  const writeState = (o) => fs.writeFileSync(path.join(outDir, 'wd-state.json'), JSON.stringify(o, null, 2), 'utf8');
  const maxStep = Number(a.maxStep || 1);

  const browser = await chromium.launch({ headless: !a.headed });
  const ctx = await browser.newContext({ storageState: authFile, viewport: { width: 1440, height: 1100 } });
  const page = await ctx.newPage();

  // Go straight to the manual wizard: clicking through the chooser is flaky once a draft
  // exists, and this URL is where that click lands anyway.
  const base = String(a.url).replace(/\/apply.*$/, '').replace(/\/+$/, '');
  await page.goto(`${base}/apply/applyManually`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(4000);
  emit('landed', { url: page.url() });

  const filled = [];
  const problems = [];
  const record = (field, value, ok) => {
    if (ok === null) return; // field not present on this tenant's form
    if (ok) filled.push({ field, value });
    else { problems.push({ field, value }); emit('fill-failed', { field, value }); }
  };

  // --- Step 1: My Information
  record('source', answers.hear_about, await pickPromptPath(page, 'source', answers.hear_about_path || answers.hear_about));
  record('candidateIsPreviousWorker', answers.previous_worker, await pickRadio(page, 'candidateIsPreviousWorker', answers.previous_worker));
  record('legalName--firstName', answers.first_name, await fillText(page, 'legalName--firstName', answers.first_name));
  record('legalName--lastName', answers.last_name, await fillText(page, 'legalName--lastName', answers.last_name));
  record('legalName--secondaryLastName', answers.second_last_name, await fillText(page, 'legalName--secondaryLastName', answers.second_last_name));
  record('city', answers.city, await fillText(page, 'city', answers.city));
  record('country', answers.country, await pickPrompt(page, 'country', answers.country));
  record('phoneType', answers.phone_device_type, await pickPrompt(page, 'phoneType', answers.phone_device_type));
  record('phoneNumber', answers.phone, await fillText(page, 'phoneNumber', answers.phone));

  // --- Step 2 fillers, applied once the wizard reaches My Experience.
  // Work Experience / Education / Certifications are optional sections behind Add buttons;
  // only Skills and the Resume/CV upload are required, and the CV carries the rest.
  const fillStep2 = async () => {
    const done = [];
    const cv = answers.cv_upload ? path.resolve(String(answers.cv_upload)) : '';
    const ITEM = '[data-automation-id="file-upload-item"], [data-automation-id="fileUploadItem"]';
    if (cv && fs.existsSync(cv)) {
      const base = path.basename(cv);
      // Workday stores resumes on the candidate PROFILE, not just on this application, and
      // the upload widget appends rather than replaces. Re-running therefore stacks up
      // duplicate CVs (five runs left five identical copies attached, cleaned up by hand).
      // So look for the file by name first and skip the upload when it is already there.
      const attached = await page.locator(ITEM).allTextContents().catch(() => []);
      if (attached.some(t => t.includes(base))) {
        emit('resume-already-attached', { file: base, attachedCount: attached.length, note: 'skipped upload — Workday keeps resumes on the profile between runs' });
        done.push({ field: 'resume', value: `${base} (already attached)` });
        if (attached.length > 1) emit('resume-duplicates', { count: attached.length, note: 'more than one file attached — likely earlier runs; remove the extras by hand' });
      } else {
        const file = page.locator('input[type=file]').first();
        if (await file.count()) {
          await file.setInputFiles(cv).catch(e => emit('upload-error', { message: String(e).slice(0, 120) }));
          await page.waitForTimeout(3000);
          const shown = await page.locator(ITEM).allTextContents().catch(() => []);
          if (shown.some(t => t.includes(base))) { done.push({ field: 'resume', value: base }); emit('uploaded', { file: base }); }
          else { problems.push({ field: 'resume', value: base }); emit('fill-failed', { field: 'resume' }); }
        } else {
          problems.push({ field: 'resume', value: base });
          emit('upload-no-input', { note: 'no file input and no matching attachment found' });
        }
      }
    } else if (cv) { emit('upload-missing', { path: cv }); }

    for (const skill of (answers.skills || [])) {
      const ok = await addSkill(page, skill);
      if (ok === null) { emit('skills-widget-missing', { note: 'formField-skills not on the page — step may not have finished rendering' }); break; }
      if (ok) done.push({ field: 'skill', value: skill });
      else { problems.push({ field: 'skill', value: skill }); emit('skill-unmatched', { skill, note: 'no exact taxonomy match — left off rather than guessing a near one' }); }
    }
    return done;
  };

  await page.waitForTimeout(600);
  const step1 = await dumpStep(page);
  emit('step', { step: step1.step, fields: step1.fields.map(f => ({ name: f.name, required: f.required, value: f.value })) });
  await page.screenshot({ path: path.join(outDir, 'wd-step1.png'), fullPage: true }).catch(() => {});
  emit('filled', { step: 1, filled, problems, note: 'Address/postal left to the human by convention.' });

  // --- Advance, mapping each subsequent step. Never past the Review step's submit.
  //
  // The wizard keeps ONE url across all five steps and nothing is persisted as a draft
  // (Candidate Home stays empty until submit), so the whole flow lives in a single session
  // and there is no navigation to wait on. waitForLoadState returns instantly and would
  // hand back the previous step's DOM — so wait for the field set itself to change.
  const sig = (d) => JSON.stringify(d.fields.map(f => f.name));

  // A step renders progressively, so "the field set differs from the last step" can be true
  // of a half-built page (My Experience briefly shows its file input before Skills exists).
  // Wait for the set to also hold still before believing it.
  const waitForStableStep = async (prevSig) => {
    let last = null, lastSig = null, stable = 0;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      const d = await dumpStep(page);
      const s = sig(d);
      if (s === prevSig) continue; // still the previous step
      if (s === lastSig) { stable++; if (stable >= 2) return d; } else { stable = 0; }
      lastSig = s; last = d;
    }
    return last;
  };

  const steps = [step1];
  let prev = step1;
  for (let n = 2; n <= maxStep + 1 && n <= 5; n++) {
    const next = page.locator('[data-automation-id="pageFooterNextButton"]').first();
    if (!(await next.count())) { emit('no-next', { at: n - 1 }); break; }
    const label = (await next.textContent().catch(() => '') || '').trim();
    if (/submit/i.test(label)) { emit('reached-submit', { note: 'stopping: submit is the human’s' }); break; }
    await next.click({ timeout: 8000 }).catch(e => emit('next-click-failed', { message: String(e).slice(0, 120) }));

    const d = await waitForStableStep(sig(prev));
    const changed = !!d && sig(d) !== sig(prev);
    if (!changed) {
      // Same fields still on screen: Workday rejected the step rather than advancing.
      const errs = await page.locator('[data-automation-id="errorMessage"], [role="alert"]').allTextContents().catch(() => []);
      emit('step-did-not-advance', { at: n - 1, errors: errs.slice(0, 6) });
      await page.screenshot({ path: path.join(outDir, `wd-stuck${n - 1}.png`), fullPage: true }).catch(() => {});
      break;
    }
    steps.push(d);
    prev = d;
    emit('step', { step: d.step, url: d.url, nextText: d.nextText, fields: d.fields });

    // Application Questions are GUID-named dropdowns whose choices only exist once opened,
    // so there is no way to author answers.json for them without looking first.
    if (a.dumpOptions) {
      for (const f of d.fields.filter(x => x.type === 'button')) {
        const trig = page.locator(`${ff(f.name)} button[aria-haspopup="listbox"]`).first();
        if (!(await trig.count())) continue;
        await trig.scrollIntoViewIfNeeded().catch(() => {});
        await trig.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(900);
        const opts = await page.locator('li[role="option"]').allTextContents().catch(() => []);
        emit('question-options', { name: f.name, question: f.label, options: opts.map(t => t.trim()).filter(Boolean) });
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(400);
      }
    }

    if (/my experience/i.test(d.step || '')) {
      const done = await fillStep2();
      filled.push(...done);
      emit('filled', { step: 2, filled: done, problems });
      prev = await dumpStep(page); // the uploads/skills change the field set
    }

    // Voluntary Disclosures: accept the Terms & Conditions / data-processing consent, per
    // the standing compliance defaults. Any demographic questions here are optional and are
    // deliberately left alone — they are the candidate's to answer, not ours.
    if (/voluntary disclosures/i.test(d.step || '')) {
      const done = [];
      const boxes = page.locator('[data-automation-id^="formField-"] input[type=checkbox]');
      const n2 = await boxes.count();
      for (let i = 0; i < n2; i++) {
        const box = boxes.nth(i);
        const label = await box.evaluate(el => {
          const w = el.closest('[data-automation-id^="formField-"]');
          return ((w && w.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        }).catch(() => '');
        if (!/terms|conditions|consent|privacy|acknowledge/i.test(label)) { emit('disclosure-left-alone', { label: label.slice(0, 70) }); continue; }
        await box.check({ timeout: 4000 }).catch(() => {});
        if (await box.isChecked().catch(() => false)) done.push({ field: 'terms', value: label.slice(0, 50) });
        else { problems.push({ field: 'terms', value: label.slice(0, 50) }); emit('fill-failed', { field: 'terms' }); }
      }
      filled.push(...done);
      emit('filled', { step: 4, filled: done, problems });
      prev = await dumpStep(page);
    }

    if (/application questions/i.test(d.step || '')) {
      const rules = Array.isArray(answers.screening) ? answers.screening : [];
      const done = [];
      for (const f of d.fields.filter(x => x.type === 'button')) {
        const rule = rules.find(r => r.question && new RegExp(r.question, 'i').test(f.label || ''));
        if (!rule) { emit('question-unanswered', { question: (f.label || '').slice(0, 90) }); continue; }
        const ok = await pickPromptContains(page, f.name, rule.answer);
        if (ok) done.push({ field: (f.label || '').slice(0, 60), value: rule.answer });
        else { problems.push({ field: (f.label || '').slice(0, 60), value: rule.answer }); emit('fill-failed', { question: (f.label || '').slice(0, 70), answer: rule.answer }); }
      }
      filled.push(...done);
      emit('filled', { step: 3, filled: done, problems });
      prev = await dumpStep(page);
    }

    await page.screenshot({ path: path.join(outDir, `wd-step${n}.png`), fullPage: true }).catch(() => {});
    if (n > maxStep) break;
  }

  writeState({ status: 'mapped', filled, problems, steps });

  if (a.headed) {
    const closeFile = path.join(outDir, 'CLOSE');
    const deadline = Date.now() + 45 * 60 * 1000;
    while (Date.now() < deadline) { if (fs.existsSync(closeFile)) break; await page.waitForTimeout(2000); }
  }
  await browser.close();
})().catch(e => { console.error('ERR', e); emit('error', { message: String(e) }); process.exit(1); });
