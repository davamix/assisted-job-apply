// Drive a LinkedIn Easy Apply, filling what the profile can answer, then STOP at the
// review step and wait for human approval (a signal file) before submitting.
//
// The modal DOM is fully obfuscated (hashed classes, no role=dialog), so we work via
// accessible labels/roles and tag the modal root with data-ez-root at runtime to scope
// field enumeration (keeps us away from the page's nav search input).
//
// Usage:
//   node scripts/linkedin/easyapply.js --id <jobId> --answers <answers.json> \
//        --signalDir <dir> [--shotDir <dir>] [--timeoutMs 900000] [--headless]
//
// It runs headed by default (you watch it). It emits `EVENT {json}` lines and writes
// <signalDir>/state.json. When it prints event "ready_for_approval" it polls <signalDir>
// for a file named APPROVE or ABORT. Create APPROVE to submit, ABORT to discard.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = { headless: false, timeoutMs: '900000' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--headless') a.headless = true;
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  return a;
}
const emit = (event, extra = {}) => console.log('EVENT ' + JSON.stringify({ event, ...extra }));

// label regex -> key in answers; `choice` marks radio (fieldset) Yes/No questions.
// Order matters: more specific patterns first. Selects (dropdown Yes/No, consent) are
// resolved here too and filled via option matching (not `choice`).
const RULES = [
  // Conditional "if YES, provide details" fields — must come BEFORE the conflict rule.
  { re: /if (your|the) answer is yes|please provide the name|si (tu|su) respuesta es s[ií]/i, key: 'conflict_details' },
  // Consent / policy acceptance dropdown.
  { re: /read and accept|i accept|he le[íi]do|acepto|consent|privacy policy|data protection|gdpr|rgpd/i, key: 'consent' },
  // Conflict-of-interest / compliance Yes/No dropdowns.
  { re: /relationship with|conflict of interest|competitor|government official|shareholder|board member|family (member|and)|entity and\/or/i, key: 'conflict' },
  { re: /country code|código.*pa[ií]s|prefijo/i, key: 'phone_country_code' },
  { re: /mobile phone|phone number|tel[eé]fono/i, key: 'phone' },
  { re: /email|correo/i, key: 'email' },
  { re: /first name|nombre(?! completo)/i, key: 'first_name' },
  { re: /last name|apellidos?|surname/i, key: 'last_name' },
  { re: /full( legal)? name|nombre completo/i, key: 'full_name' },
  { re: /linkedin profile|linkedin( |-)?url|perfil de linkedin/i, key: 'linkedin' },
  { re: /^\s*website\s*$|personal website|portfolio|sitio web|página web/i, key: 'website' },
  { re: /\bcity\b|ciudad|localidad/i, key: 'city' },
  // Threshold Yes/No experience question for the core stack (.NET/C#): phrased as a
  // yes/no ("do you have +5 years of .NET?"), so the numeric years_dotnet won't fit as a
  // radio answer. Must precede the numeric rule below. Handled specially in resolveAnswer:
  // answers Yes when the asked threshold is within the candidate's .NET years, else pauses.
  { re: /(tienes|cuentas con|posees|dispones de|do you have|have you|al menos|at least|m[aá]s de|more than|minimum|m[ií]nimo|\+\s*\d|\d\s*\+).*(experiencia|experience|años|years).*(c#|\.net|dotnet)/i, key: '__dotnet_exp', choice: true },
  { re: /(years|años).*(c#|\.net|dotnet)/i, key: 'years_dotnet' },
  { re: /python/i, key: 'years_python' },
  { re: /pytorch|tensorflow|keras|scikit/i, key: 'years_pytorch' },
  { re: /ml ?ops/i, key: 'years_mlops' },
  // Whole-word AI/ML/LLM only — avoids matching the "ia" inside Spanish "experiencia".
  { re: /(years|años).*(\bai\b|\bia\b|machine learning|\bml\b|\bllm\b|genai|generative|\brag\b|deep learning)/i, key: 'years_ai' },
  { re: /how many years|cu[aá]ntos años|years of experience|años de experiencia/i, key: 'years_total' },
  { re: /authoriz|eligible to work|legally|right to work|work permit|work permission|permit to work|autorizad|permiso de trabajo|permiso para trabajar|puedes trabajar|derecho a trabajar/i, key: 'authorized', choice: true },
  { re: /sponsor|visa|patrocin/i, key: 'sponsorship', choice: true },
  { re: /salary|compensation|expected pay|pretensiones|salarial|remuneraci/i, key: 'salary_target' },
  { re: /notice period|availab|disponibilidad|preaviso/i, key: 'notice' },
  { re: /how did you (hear|find out|learn|know)|d[oó]nde.*conoci|c[oó]mo.*conoci|source of application/i, key: 'hear_about' },
  { re: /english/i, key: 'english_level' },
  { re: /degree|education|estudios|titulaci/i, key: 'education' },
];

function resolveAnswer(label, ans) {
  const L = label.toLowerCase();
  for (const r of RULES) {
    if (r.re.test(L)) {
      if (r.key === 'authorized') {
        if (/united states|u\.s\.|\busa\b|\bus\b/i.test(L)) return { value: ans.authorized_us || 'No', choice: true };
        return { value: ans.authorized_spain || 'Yes', choice: true };
      }
      if (r.key === 'sponsorship') return { value: ans.sponsorship || 'No', choice: true };
      if (r.key === '__dotnet_exp') {
        // Parse the asked threshold (e.g. "+5", "at least 3", "más de 5 años"); answer Yes
        // only if it's within the candidate's .NET years, otherwise pause for a human.
        const m = L.match(/(?:\+\s*|m[aá]s de\s*|al menos\s*|at least\s*|more than\s*|minimum\s*|m[ií]nimo\s*)(\d+)/) || L.match(/(\d+)\s*\+?\s*(?:años?|years?)/);
        const need = m ? parseInt(m[1], 10) : 0;
        const have = parseInt(ans.years_dotnet, 10) || 0;
        if (need > have) return null;
        return { value: 'Yes', choice: true };
      }
      const v = ans[r.key];
      if (v !== undefined && v !== null && v !== '') return { value: String(v), choice: !!r.choice };
    }
  }
  return null;
}

// Runs in the page: tag modal root, return current step heading + enumerated fields.
function enumerateInPage() {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // Modal root = nearest ancestor of a footer action button that also has a heading.
  const footBtn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^(next|continue to next step|review|review your application|submit application|enviar solicitud|revisar|siguiente)$/i.test(
      norm(b.getAttribute('aria-label') || b.textContent)));
  let root = footBtn;
  while (root && !(root.querySelector('h2, h3, [role="heading"]'))) root = root.parentElement;
  root = root || document.querySelector('form') || document.body;
  document.querySelectorAll('[data-ez-root]').forEach((e) => e.removeAttribute('data-ez-root'));
  root.setAttribute('data-ez-root', '1');

  const heading = norm((root.querySelector('h2, h3, [role="heading"]') || {}).textContent);

  const fields = [];
  let idx = 0;
  // Single inputs / selects / textareas with a resolvable label.
  root.querySelectorAll('input, select, textarea').forEach((el) => {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (['hidden', 'file', 'search', 'submit', 'button'].includes(type)) return;
    if (el.type === 'radio' || el.type === 'checkbox') return; // handled as choices below
    let label = '';
    const id = el.getAttribute('id');
    if (id) { const l = root.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) label = norm(l.textContent); }
    if (!label) { const l = el.closest('label'); if (l) label = norm(l.textContent); }
    if (!label) label = norm(el.getAttribute('aria-label'));
    el.setAttribute('data-ez-field', String(idx));
    const options = el.tagName === 'SELECT' ? Array.from(el.options).map((o) => norm(o.textContent)) : null;
    fields.push({ i: idx, label, tag: el.tagName.toLowerCase(), type, options, value: norm(el.value), required: el.required || /\*/.test(label) });
    idx++;
  });
  // Choice groups (fieldset + radios).
  const choices = [];
  let gidx = 0;
  root.querySelectorAll('fieldset').forEach((fs) => {
    const radios = Array.from(fs.querySelectorAll('input[type=radio]'));
    if (!radios.length) return;
    fs.setAttribute('data-ez-group', String(gidx));
    // The fieldset text is often just "Yes No"; the real question sits in a preceding
    // sibling. Walk back to the nearest sibling with real text.
    const fsText = norm(fs.innerText);
    let legend = norm((fs.querySelector('legend, [role="heading"]') || {}).textContent);
    if (!legend) legend = norm(fs.getAttribute('aria-label'));
    if (!legend || /^(yes\s*no|no\s*yes|s[ií]\s*no|no\s*s[ií])$/i.test(legend)) {
      let p = fs.previousElementSibling, hops = 0;
      while (p && hops < 4 && norm(p.innerText).length < 6) { p = p.previousElementSibling; hops++; }
      legend = (p && norm(p.innerText)) || fsText;
    }
    const opts = radios.map((r, k) => {
      r.setAttribute('data-ez-choice', gidx + ':' + k);
      let lab = '';
      const id = r.getAttribute('id');
      if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) lab = norm(l.textContent); }
      if (!lab) { const l = r.closest('label'); if (l) lab = norm(l.textContent); }
      return { k, label: lab, value: norm(r.getAttribute('value')), checked: r.checked };
    });
    // If radios expose no label/value, derive option labels from the fieldset tokens ("Yes No").
    if (opts.every((o) => !o.label && !o.value)) {
      const toks = fsText.split(/\s+/).filter(Boolean);
      if (toks.length === opts.length) opts.forEach((o, i) => { o.label = toks[i]; });
    }
    choices.push({ g: gidx, legend, options: opts, answered: opts.some((o) => o.checked) });
    gidx++;
  });

  const footLabel = footBtn ? norm(footBtn.getAttribute('aria-label') || footBtn.textContent) : null;
  return { heading, fields, choices, footLabel };
}

(async () => {
  const a = parseArgs(process.argv);
  if (!a.id || !a.answers || !a.signalDir) {
    console.error(JSON.stringify({ error: 'need --id --answers --signalDir' }));
    process.exit(2);
  }
  const ans = JSON.parse(fs.readFileSync(a.answers, 'utf8'));
  const shotDir = a.shotDir || a.signalDir;
  fs.mkdirSync(a.signalDir, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  const authFile = a.auth || path.join(__dirname, '..', '..', '.auth', 'linkedin-state.json');
  const writeState = (o) => fs.writeFileSync(path.join(a.signalDir, 'state.json'), JSON.stringify(o, null, 2), 'utf8');

  const browser = await chromium.launch({ headless: !!a.headless });
  const context = await browser.newContext({ storageState: authFile, viewport: { width: 1300, height: 940 } });
  const page = await context.newPage();
  await page.goto(`https://www.linkedin.com/jobs/view/${a.id}/`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // Guard: already applied / closed.
  const guard = await page.evaluate(() => {
    const t = document.querySelector('main')?.innerText || '';
    return { alreadyApplied: /Application submitted|Solicitud enviada/i.test(t), closed: /No longer accepting applications|Ya no se aceptan/i.test(t) };
  });
  if (guard.closed) { emit('closed'); writeState({ status: 'closed' }); await browser.close(); return; }
  if (guard.alreadyApplied) { emit('already_applied'); writeState({ status: 'already_applied' }); await browser.close(); return; }

  await page.getByRole('button', { name: /easy apply to this job/i }).first().click()
    .catch(async () => { await page.getByRole('button', { name: /^easy apply$/i }).first().click().catch(() => {}); });
  await page.waitForTimeout(2000);

  const filledLog = [];
  let blocked = false;
  let unfilled = [];
  let coverUploaded = false;
  const MAX_STEPS = 10;
  for (let step = 0; step < MAX_STEPS; step++) {
    const info = await page.evaluate(enumerateInPage);

    // Fill single fields.
    for (const f of info.fields) {
      if (!f.label) continue;
      if (f.value && f.type !== 'select') continue; // keep prefilled values
      const r = resolveAnswer(f.label, ans);
      if (!r) continue;
      const loc = page.locator(`[data-ez-field="${f.i}"]`);
      try {
        if (f.tag === 'select') {
          const opts = (f.options || []).filter((o) => o && !/^select an option|^selecciona/i.test(o));
          const v = r.value.toLowerCase();
          const target =
            opts.find((o) => o.toLowerCase() === v) ||
            opts.find((o) => o.toLowerCase().startsWith(v)) ||
            opts.find((o) => o.toLowerCase().includes(v)) ||
            (/^yes$/i.test(r.value) ? opts.find((o) => /^yes|^s[ií]/i.test(o)) : null) ||
            (/^no$/i.test(r.value) ? opts.find((o) => /^no/i.test(o)) : null);
          if (target) { await loc.selectOption({ label: target }); filledLog.push({ label: f.label, value: target }); }
          else { continue; } // unknown option set — leave for human
        } else {
          await loc.fill(r.value);
          filledLog.push({ label: f.label, value: r.value });
        }
      } catch {}
    }
    // Answer choice (radio) questions. Unlabeled/unmatched Yes-No compliance groups
    // default to "No" per the user's standing policy (still shown at the review pause).
    for (const c of info.choices) {
      if (c.answered) continue;
      const r = resolveAnswer(c.legend, ans);
      const lc = (t) => (t || '').toLowerCase();
      const isYes = (t) => /^(yes|s[ií]|true)/.test(lc(t));
      const isNo = (t) => /^(no|false)/.test(lc(t));
      const pick = (want) => {
        const w = lc(want);
        return c.options.find((o) => {
          const t = lc(o.label || o.value);
          if (!t) return false;
          if (/^(yes|s[ií]|true)/.test(w)) return isYes(t);   // Yes matches "Sí"
          if (/^(no|false)/.test(w)) return isNo(t);
          return t.startsWith(w);
        });
      };
      let opt = r ? pick(r.value) : null;
      // Safe fallback: ONLY an unresolved conflict/compliance question defaults to "No".
      // Any other unknown Yes/No is left unanswered (the run pauses for a human).
      if (!opt && !r && /relationship|conflict|competitor|government|shareholder|board member|referred|family/i.test(c.legend || '')) {
        opt = pick('No');
      }
      if (!opt) continue;
      const labelText = (opt.label || opt.value || '').trim();
      let clicked = false;
      // Primary: click the visible option label within the group (drives React state reliably).
      if (labelText) {
        const esc = labelText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try {
          await page.locator(`[data-ez-group="${c.g}"]`).getByText(new RegExp(`^\\s*${esc}\\s*$`, 'i')).first().click({ timeout: 2500 });
          clicked = true;
        } catch {}
      }
      // Fallback: native in-page click on the hidden radio input.
      if (!clicked) {
        try {
          await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) { el.click(); el.dispatchEvent(new Event('change', { bubbles: true })); }
          }, `[data-ez-choice="${c.g}:${opt.k}"]`);
          clicked = true;
        } catch {}
      }
      if (clicked) filledLog.push({ q: (c.legend || '[unlabeled]').slice(0, 70), value: labelText });
    }
    // Cover letter: paste into any empty textarea if provided and label looks like a letter/message.
    if (ans.cover_letter) {
      for (const f of info.fields) {
        if (f.tag === 'textarea' && !f.value && /cover|letter|message|carta|motivaci|additional/i.test(f.label || '')) {
          try { await page.locator(`[data-ez-field="${f.i}"]`).fill(ans.cover_letter); filledLog.push({ label: f.label, value: '[cover letter]' }); } catch {}
        }
      }
    }

    // Ensure the intended CV is the selected resume. LinkedIn auto-selects the most
    // recently uploaded file, which may be a cover letter used on a prior application.
    if (ans.cv_filename_hint) {
      try {
        const needSelect = await page.evaluate((hint) => {
          const re = new RegExp(hint, 'i');
          const radios = [...document.querySelectorAll('input[type=radio]')];
          for (const r of radios) {
            let node = r, txt = '';
            for (let i = 0; i < 5 && node; i++) { txt = (node.innerText || '').replace(/\s+/g, ' '); if (re.test(txt)) break; node = node.parentElement; }
            if (re.test(txt)) { if (!r.checked) { r.setAttribute('data-ez-cv', '1'); return true; } return false; }
          }
          return false;
        }, ans.cv_filename_hint);
        if (needSelect) {
          const cvLoc = page.getByText(new RegExp(ans.cv_filename_hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first();
          const ok = await cvLoc.click({ timeout: 2000 }).then(() => true).catch(() => false);
          if (!ok) await page.evaluate(() => { const el = document.querySelector('[data-ez-cv]'); if (el) { el.click(); el.dispatchEvent(new Event('change', { bubbles: true })); } });
          filledLog.push({ label: 'Resume (CV) selected', value: ans.cv_filename_hint });
        }
      } catch {}
    }

    // Upload a cover-letter file if this page offers it (optional slot).
    if (ans.cover_letter_pdf && !coverUploaded) {
      const btn = page.getByRole('button', { name: /upload cover letter|adjuntar (la )?carta|subir carta/i }).first();
      if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
        try {
          const [chooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 5000 }),
            btn.click(),
          ]);
          await chooser.setFiles(path.resolve(ans.cover_letter_pdf));
          await page.waitForTimeout(1500);
          coverUploaded = true;
          filledLog.push({ label: 'Cover letter (file)', value: path.basename(ans.cover_letter_pdf) });
        } catch {}
      }
    }

    const shot = path.join(shotDir, `step-${step}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    emit('step', { step, heading: info.heading, foot: info.footLabel, fields: info.fields.map((f) => ({ label: f.label, tag: f.tag, options: f.options })), choices: info.choices.map((c) => ({ legend: c.legend, options: c.options.map((o) => o.label) })), shot });

    const isFinal = info.footLabel && /submit application|enviar solicitud/i.test(info.footLabel);
    if (isFinal) break;

    // Advance.
    // Signature of the current page's content (headings + footer + field/choice labels).
    // Comparing field SETS avoids the false "blocked" when consecutive pages share the
    // same heading and "Next" button (e.g. contact page -> resume page).
    const sig = (x) => JSON.stringify([x.heading, x.footLabel, x.fields.map((f) => f.label), x.choices.map((c) => c.legend)]);
    const before = sig(info);
    await page.getByRole('button', { name: /^(next|continue to next step|review|review your application|siguiente|revisar)$/i }).first().click().catch(() => {});
    await page.waitForTimeout(1600);
    const afterInfo = await page.evaluate(enumerateInPage);
    const after = sig(afterInfo);
    if (after === before) {
      // Blocked: a required field we couldn't confidently fill remains. Hand to human.
      blocked = true;
      unfilled = await page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const root = document.querySelector('[data-ez-root]') || document.body;
        const out = [];
        root.querySelectorAll('input, select, textarea').forEach((el) => {
          const type = (el.getAttribute('type') || el.tagName).toLowerCase();
          if (['hidden', 'file', 'search', 'submit', 'button', 'radio'].includes(type)) return;
          const empty = el.tagName === 'SELECT' ? (!el.value || /select an option|selecciona/i.test(el.options[el.selectedIndex]?.text || '')) : !el.value;
          const req = el.required || (el.getAttribute('aria-required') === 'true');
          if (empty && req) {
            let label = '';
            const id = el.getAttribute('id');
            if (id) { const l = root.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) label = norm(l.textContent); }
            if (!label) { const l = el.closest('label'); if (l) label = norm(l.textContent); }
            if (label) out.push(label);
          }
        });
        return [...new Set(out)];
      });
      const shot2 = path.join(shotDir, `blocked-${step}.png`);
      await page.screenshot({ path: shot2 }).catch(() => {});
      emit('needs_input', { step, heading: info.heading, shot: shot2, unfilled });
      break;
    }
  }

  // On the review screen, uncheck "Follow <company> to stay up to date with their page"
  // (user preference: never auto-follow). Only act when it is actually checked.
  try {
    const f = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const cb = [...document.querySelectorAll('input[type=checkbox]')].find((c) => {
        let n = c, t = '';
        for (let i = 0; i < 4 && n; i++) { t = norm(n.innerText); if (/follow .*(stay up to date|their page|page)/i.test(t)) break; n = n.parentElement; }
        return /follow .*(stay up to date|their page|page)/i.test(t);
      });
      if (!cb) return { found: false };
      cb.setAttribute('data-ez-follow', '1');
      const id = cb.getAttribute('id');
      let lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      if (!lab) lab = cb.closest('label');
      if (lab) lab.setAttribute('data-ez-follow-label', '1');
      return { found: true, checked: cb.checked, hasLabel: !!lab };
    });
    if (f.found && f.checked) {
      let done = false;
      if (f.hasLabel) done = await page.locator('[data-ez-follow-label]').click({ timeout: 2000 }).then(() => true).catch(() => false);
      if (!done) await page.locator('[data-ez-follow]').click({ force: true, timeout: 2000 }).catch(() => {});
      const still = await page.evaluate(() => { const el = document.querySelector('[data-ez-follow]'); return el ? el.checked : false; });
      if (still) await page.evaluate(() => { const el = document.querySelector('[data-ez-follow]'); if (el) { el.click(); el.dispatchEvent(new Event('change', { bubbles: true })); } });
      filledLog.push({ label: 'Follow company', value: 'unchecked' });
    }
  } catch {}

  // Review / approval gate (single source of truth — reflects whether we're blocked).
  const reviewShot = path.join(shotDir, 'review.png');
  await page.screenshot({ path: reviewShot }).catch(() => {});
  const status = blocked ? 'needs_input' : 'ready_for_approval';
  emit(status, { filled: filledLog, unfilled, shot: reviewShot, signalDir: a.signalDir });
  writeState({ status, filled: filledLog, unfilled, shot: reviewShot });

  const approveFile = path.join(a.signalDir, 'APPROVE');
  const abortFile = path.join(a.signalDir, 'ABORT');
  const deadline = Date.now() + (parseInt(a.timeoutMs, 10) || 900000);
  let decision = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(approveFile)) { decision = 'approve'; break; }
    if (fs.existsSync(abortFile)) { decision = 'abort'; break; }
    await page.waitForTimeout(2000);
  }

  if (decision === 'approve') {
    // Advance through any remaining Next/Review steps (you may have completed fields
    // during the pause), then submit — only if a real Submit button is reached.
    let submitted = false;
    for (let i = 0; i < 8 && !submitted; i++) {
      const submitBtn = page.getByRole('button', { name: /submit application|enviar solicitud/i }).first();
      if (await submitBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await submitBtn.click().catch(() => {});
        submitted = true;
        break;
      }
      const nextBtn = page.getByRole('button', { name: /^(next|continue to next step|review|review your application|siguiente|revisar)$/i }).first();
      if (await nextBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await nextBtn.click().catch(() => {});
        await page.waitForTimeout(1200);
      } else {
        break; // stuck on a validation block — do not force
      }
    }
    await page.waitForTimeout(3000);
    const done = await page.evaluate(() => /application sent|was sent to|solicitud enviada|application submitted|you'?ve applied|hemos enviado/i.test(document.body.innerText || ''));
    const confShot = path.join(shotDir, 'confirmation.png');
    await page.screenshot({ path: confShot }).catch(() => {});
    if (submitted) {
      emit('applied', { confirmed: done, shot: confShot });
      writeState({ status: 'applied', confirmed: done, filled: filledLog, shot: confShot });
    } else {
      emit('submit_failed', { note: 'Could not reach Submit — a required field is still empty on the form.', shot: confShot });
      writeState({ status: 'submit_failed', filled: filledLog, shot: confShot });
    }
  } else if (decision === 'abort') {
    await page.getByRole('button', { name: /dismiss/i }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: /discard/i }).first().click().catch(() => {});
    emit('aborted');
    writeState({ status: 'aborted', filled: filledLog });
  } else {
    emit('timeout');
    writeState({ status: 'timeout', filled: filledLog });
  }
  await browser.close();
})().catch((err) => { console.error('ERROR:', err); emit('error', { message: String(err) }); process.exit(1); });
