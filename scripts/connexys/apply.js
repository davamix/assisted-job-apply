// Connexys apply adapter. Fills a Connexys public application form from a per-job
// answers.json, then STOPS before submit and keeps the browser open so the human reviews
// and clicks "ENVOYER MA CANDIDATURE". It NEVER submits.
//
// Connexys is a Salesforce-native ATS (Bullhorn; Dutch origin, hence the Dutch field
// headings that leak into syndicated LinkedIn adverts — "Functie-eisen",
// "Arbeidsvoorwaarden", "Bedrijfsomschrijving"). The careers site is an Angular SPA on the
// customer's own domain and the apply form lives at
//   https://<careers-domain>/job/<18-char Salesforce id>/apply
// reached from the LinkedIn "Apply on company website" link, often via an
// easyapply.jobs/r/<token> redirector. Either URL may be passed as --url; a job URL
// without /apply gets it appended.
//
// Four things shape this adapter:
//   - THE FORM IS RENDERED CLIENT-SIDE AND SLOWLY. Nothing exists at DOMContentLoaded and
//     `networkidle` NEVER fires (the page polls an addthis/Apple/Google widget set), so
//     navigation waits on `domcontentloaded` and then polls for a real field.
//   - **THE CV UPLOAD PARSES THE CV AND OVERWRITES THE IDENTITY FIELDS.** The widget is a
//     `<span class="cxsFileUpload" fieldname="cxsrec__last_cv__c">` wrapping a CROSS-ORIGIN
//     iframe on `<tenant>.my.salesforce-sites.com/apex/cxsrec__cxsApplyFormDocument?…
//     parseCV=true`, so there is NO `input[type=file]` in the page — the click has to be
//     caught with Playwright's `filechooser` event. Roughly 5-6 s AFTER the file lands,
//     Salesforce's CV parser writes its own guesses into first name / last name / e-mail /
//     phone, silently clobbering anything already typed there. So the order is forced:
//     **upload FIRST, wait for the parse to settle, and only THEN fill the identity fields**,
//     which now double as a correction pass. This matters beyond tidiness — on a Spanish
//     two-surname name the parser drops half of it (a "García Fernández" comes back as
//     "Fernández"), so letting the parse win would submit a wrong legal name. Completion
//     signal: the button label flips "Charger" → "Remplacer" and the filename appears in
//     the documents section.
//   - **MOST FIELDS IN THE DOM ARE RECRUITER-ONLY AND MUST NOT BE TOUCHED.** Connexys ships
//     the back-office fields into the same form and merely hides them: on this tenant 7 of
//     the 15 (Titre de la Candidature, Type de candidat, Langue de communication, Type
//     d'offre, Origine, Plateforme, Marque) are `display:none`. They carry the tempting
//     labels — "Origine" and "Plateforme" look exactly like the standing
//     `how_did_you_find_out: LinkedIn` compliance answer — but they are the recruiter's own
//     source-tracking, pre-set by the ATS from the referer, and writing to them would
//     forge internal attribution. Every lookup here goes through `visibleFieldByLabel`,
//     which SKIPS hidden fields by design.
//   - THE SELECTS HAVE NO `name` AND their `cxsField_<n>` ids are positional (they shift
//     per tenant and per job), so fields are resolved by their `<label for=…>` WORDING,
//     never by index.
//
// Postcode and the RQTH (disability-accommodation) question are personal data that
// answers.json may deliberately omit — when absent they are reported as `pending` for the
// human to fill at the review gate, never invented.
//
//   node scripts/connexys/apply.js --url <job-or-apply-url> --id <dbId> \
//        --answers output/<id>/answers.json --outDir output/<id> [--dryRun] [--channel msedge]
//
// Emits `EVENT {json}` lines and writes connexys-state.json + connexys-filled.png to --outDir.
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

// Resolve a job URL to its apply form. The careers site serves /job/<sfid> for the advert
// and /job/<sfid>/apply for the form; a slugged URL (/job/<slug>/<sfid>) works either way.
function resolveApplyUrl(url) {
  const u = String(url).trim();
  if (/\/apply(\?|$)/i.test(u)) return u;
  return u.replace(/\/+$/, '') + '/apply';
}

// Find a VISIBLE form field by its <label for=…> wording. Hidden fields are skipped on
// purpose: Connexys renders the recruiter's back-office fields into the same form and only
// hides them with CSS (see header). Returns the element id, or null.
async function visibleFieldByLabel(page, pattern) {
  return page.evaluate(({ src, flags }) => {
    const re = new RegExp(src, flags);
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (!el.id) continue;
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const visible = el.offsetParent !== null && cs.visibility !== 'hidden' && box.width > 0;
      if (!visible) continue;
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab && re.test(norm(lab.textContent))) return el.id;
    }
    return null;
  }, { src: pattern.source, flags: pattern.flags });
}

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

// `CSS.escape` exists inside page.evaluate (browser scope) but not out here in Node, and
// these ids are built by the ATS — escape defensively rather than interpolating them raw.
const cssId = (id) => '#' + String(id).replace(/([^\w-])/g, '\\$1');

// Type into a text input, replacing whatever is there (the CV parser usually got there
// first). Reads the value back so a silently-rejected field is reported, not assumed.
async function fillById(page, id, value) {
  if (value === undefined || value === null || value === '') return { ok: false, reason: 'no-value' };
  const loc = page.locator(cssId(id));
  if (!(await loc.count())) return { ok: false, reason: 'not-found' };
  await loc.fill('').catch(() => {});
  await loc.fill(String(value)).catch(() => {});
  await loc.evaluate((el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }).catch(() => {});
  const got = await loc.inputValue().catch(() => '');
  return { ok: norm(got) === norm(String(value)), value: got, reason: 'value-mismatch' };
}

// Pick a native <select> option by wording (exact first, then substring) and read back what
// actually landed. These are plain selects, so selectOption works — but Angular only sees
// the choice through the change event Playwright already fires.
async function setSelectByLabel(page, id, wanted) {
  const opts = await page.evaluate((sel) => {
    const el = document.getElementById(sel);
    return el ? Array.from(el.options).map((o) => ({ v: o.value, t: (o.textContent || '').replace(/\s+/g, ' ').trim() })) : [];
  }, id);
  if (!opts.length) return { ok: false, reason: 'not-found' };
  const want = norm(wanted).toLowerCase();
  let opt = opts.find((o) => o.t.toLowerCase() === want);
  if (!opt) opt = opts.find((o) => o.t.toLowerCase().includes(want));
  if (!opt) return { ok: false, reason: 'no-such-option', sample: opts.filter((o) => o.v).map((o) => o.t) };
  await page.selectOption(cssId(id), { value: opt.v }).catch(() => {});
  const got = await page.evaluate((sel) => {
    const el = document.getElementById(sel);
    return el ? { value: el.value, text: el.selectedOptions[0] ? el.selectedOptions[0].textContent.trim() : '' } : null;
  }, id);
  return { ok: !!got && got.value === opt.v, value: got ? got.text : '', reason: 'not-applied' };
}

(async () => {
  const a = parseArgs(process.argv);
  if (!a.url) { console.error('missing --url'); process.exit(2); }
  const outDir = path.resolve(a.outDir || path.join('output', String(a.id || 'tmp')));
  fs.mkdirSync(outDir, { recursive: true });
  const answersPath = path.resolve(a.answers || path.join(outDir, 'answers.json'));
  if (!fs.existsSync(answersPath)) { console.error('missing answers file: ' + answersPath); process.exit(2); }
  const answers = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
  const dryRun = !!a.dryRun;

  const filled = [];
  const pending = [];
  const writeState = (extra) => fs.writeFileSync(
    path.join(outDir, 'connexys-state.json'),
    JSON.stringify({ id: a.id || null, at: new Date().toISOString(), ...extra }, null, 2),
  );

  // Anti-automation flags always-on: this form's submit gate is unprobed, and they cost
  // nothing (see scripts/README.md "Bot-detection at submit").
  const launchOpts = {
    headless: !!dryRun,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (a.channel) launchOpts.channel = a.channel;
  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1400 }, locale: 'fr-FR' });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();

  const applyUrl = resolveApplyUrl(a.url);
  // networkidle never settles on this page (persistent third-party widget polling).
  await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

  // The Angular app renders the form well after DOMContentLoaded; poll for a real field.
  let emailId = null;
  const formDeadline = Date.now() + 60000;
  while (Date.now() < formDeadline) {
    emailId = await visibleFieldByLabel(page, /e-?mail/i);
    if (emailId) break;
    await page.waitForTimeout(1000);
  }
  if (!emailId) {
    emit('form-not-found', { url: applyUrl, title: await page.title() });
    writeState({ status: 'form-not-found', url: applyUrl });
    await browser.close();
    process.exit(4);
  }
  emit('form-found', { url: page.url(), title: await page.title() });

  // Resolve every field we intend to touch, by label wording, visible-only.
  const ids = {
    linkedin: await visibleFieldByLabel(page, /linkedin/i),
    first_name: await visibleFieldByLabel(page, /pr[ée]nom|first ?name|nombre/i),
    last_name: await visibleFieldByLabel(page, /nom de famille|last ?name|apellido/i),
    email: emailId,
    phone: await visibleFieldByLabel(page, /portable|t[ée]l[ée]phone|phone|m[óo]vil/i),
    postcode: await visibleFieldByLabel(page, /code postal|post ?code|c[óo]digo postal/i),
    contract_type: await visibleFieldByLabel(page, /type de contrat|contract type|tipo de contrato/i),
    availability: await visibleFieldByLabel(page, /disponibilit|availability|disponibilidad/i),
    rqth: await visibleFieldByLabel(page, /RQTH|am[ée]nagement/i),
    consent: await visibleFieldByLabel(page, /confidentialit|privacy|confidencialidad/i),
    marketing: await visibleFieldByLabel(page, /recevoir des offres|job alerts/i),
  };
  emit('fields-resolved', ids);

  // 1) CV FIRST — the upload's parser overwrites the identity fields ~6 s later, so it has
  //    to run before they are filled (see header). The slot's label is a bare "CV".
  const docSlotLabel = await page.evaluate(() => {
    const span = document.querySelector('.cxsFileUpload[fieldname]');
    if (!span) return '';
    const sec = span.closest('[class*=DocumentsSection], section, div');
    const head = sec ? sec.querySelector('label, h1, h2, h3, h4, .cxsSectionTitle') : null;
    return (head ? head.textContent : (span.getAttribute('fieldname') || '')).replace(/\s+/g, ' ').trim();
  });
  const kind = classifyDocField(docSlotLabel);
  const uploadPath = answers.resume_upload || answers.cv_upload || '';
  const uploadedType = answers.resume_doc_type || 'cv';
  emit('doc-field', { label: docSlotLabel, kind, uploadedType });

  // Honour the CV-vs-Résumé rule: never feed the full CV to a slot that asked for a résumé.
  if (kind === 'resume' && uploadedType !== 'resume') {
    emit('needs-resume', { label: docSlotLabel });
    pending.push({ field: 'cv_file', note: 'slot asks for a RÉSUMÉ; author output/<id>/resume.md first — the CV was not attached' });
  } else if (uploadPath) {
    const abs = path.resolve(uploadPath);
    if (!fs.existsSync(abs)) {
      emit('upload-missing', { path: uploadPath });
      pending.push({ field: 'cv_file', note: `file missing: ${uploadPath}` });
    } else {
      const widget = page.locator('.cxsFileUpload[fieldname]').first();
      let uploaded = false;
      try {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 20000 }),
          widget.click({ timeout: 15000 }),
        ]);
        await chooser.setFiles(abs);
        // Done when the button flips "Charger" → "Remplacer" and the filename shows.
        const base = path.basename(abs);
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          const txt = await page.evaluate(() => {
            const s = document.querySelector('.cxsFileUpload[fieldname]');
            const sec = s ? s.closest('[class*=DocumentsSection]') || s.parentElement : null;
            return sec ? (sec.innerText || '').replace(/\s+/g, ' ').trim() : '';
          });
          if (txt.includes(base) || /Remplacer|Replace|Vervangen/i.test(txt)) { uploaded = true; break; }
          await page.waitForTimeout(1000);
        }
      } catch (e) {
        emit('upload-error', { message: String(e.message || e).slice(0, 200) });
      }
      if (uploaded) {
        filled.push({ field: 'cv_file', value: path.basename(abs), kind, uploadedType });
        emit('uploaded', { file: path.basename(abs), uploadedType });
      } else {
        pending.push({ field: 'cv_file', note: `upload did not confirm — attach ${path.basename(abs)} by hand` });
      }
    }
  }

  // 2) Let the Salesforce CV parser finish writing its guesses, so step 3 overwrites them
  //    rather than racing them. Settled = the identity values stop changing.
  const readIdentity = () => page.evaluate((m) => {
    const out = {};
    for (const [k, id] of Object.entries(m)) {
      if (!id) continue;
      const el = document.getElementById(id);
      if (el) out[k] = el.value;
    }
    return out;
  }, { first_name: ids.first_name, last_name: ids.last_name, email: ids.email, phone: ids.phone });
  let prev = JSON.stringify(await readIdentity());
  let stable = 0;
  const parseDeadline = Date.now() + 25000;
  while (Date.now() < parseDeadline && stable < 3) {
    await page.waitForTimeout(1500);
    const cur = JSON.stringify(await readIdentity());
    if (cur === prev) stable++; else { stable = 0; prev = cur; }
  }
  const parsed = await readIdentity();
  emit('cv-parse-settled', { parsed });

  // 3) Identity + contact — authoritative, overwriting the parser. Anything the parser got
  //    wrong (it truncates two-surname Spanish names) is corrected here; the diff is
  //    reported so a silent mis-parse is visible at the review gate.
  for (const [key, value] of [
    ['linkedin', answers.linkedin_url || answers.link_url],
    ['first_name', answers.first_name],
    ['last_name', answers.last_name],
    ['email', answers.email],
    ['phone', answers.phone],
    ['postcode', answers.postcode],
  ]) {
    const id = ids[key];
    if (!id) { if (value) pending.push({ field: key, note: `field not found on the form — check by hand` }); continue; }
    if (value === undefined || value === null || value === '') {
      emit('left-for-human', { field: key });
      pending.push({ field: key, note: `not in answers.json by choice — nothing was invented; type it by hand` });
      continue;
    }
    const r = await fillById(page, id, value);
    if (r.ok) {
      const was = parsed[key];
      const corrected = was !== undefined && norm(was) !== norm(String(value));
      filled.push({ field: key, value: r.value, ...(corrected ? { corrected_from_cv_parse: was } : {}) });
      if (corrected) emit('corrected-parse', { field: key, was, now: r.value });
    } else {
      pending.push({ field: key, note: `type ${key} by hand (${r.reason})` });
    }
  }

  // 4) Visible selects. Type de contrat is the contract-type criterion made explicit on the
  //    form — CDI is the permanent-employee option.
  for (const [key, value, note] of [
    ['contract_type', answers.contract_type, 'pick the contract type by hand'],
    ['availability', answers.availability, 'pick your availability by hand'],
    ['rqth', answers.rqth, 'RQTH (disability accommodations) — personal data, answer by hand'],
  ]) {
    const id = ids[key];
    if (!id) continue;
    if (!value) {
      emit('left-for-human', { field: key });
      pending.push({ field: key, note });
      continue;
    }
    const r = await setSelectByLabel(page, id, value);
    emit('select', { field: key, wanted: value, ok: r.ok, got: r.value, reason: r.reason });
    if (r.ok) filled.push({ field: key, value: r.value });
    else pending.push({ field: key, note: `pick "${value}" by hand (${r.reason})`, options: r.sample });
  }

  // 5) Privacy declaration — the standing compliance default (accept the policy). The
  //    marketing opt-in next to it is a different thing and is deliberately left alone.
  if (ids.consent && (answers.consent === true || /^(yes|accept|oui|si|sí)$/i.test(String(answers.consent || '')))) {
    const box = page.locator(cssId(ids.consent));
    await box.check({ force: true, timeout: 5000 }).catch(() => {});
    if (!(await box.isChecked().catch(() => false))) {
      await page.evaluate((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, ids.consent);
    }
    if (await box.isChecked().catch(() => false)) filled.push({ field: 'consent', value: 'checked' });
    else pending.push({ field: 'consent', note: 'tick the privacy declaration by hand' });
  }
  if (ids.marketing) {
    const on = await page.locator(cssId(ids.marketing)).isChecked().catch(() => false);
    emit('marketing-optin', { checked: on, note: 'left as the form shipped it — not an application field' });
  }

  // Report any anti-bot marker actually present, without assuming which gate will fire.
  const captcha = await page.locator('.g-recaptcha, iframe[src*="recaptcha"], iframe[src*="challenges.cloudflare"]').count();
  if (captcha) pending.push({ field: 'captcha', note: 'solve the challenge yourself before submitting' });

  // The form is a modal with its OWN internal scroll, and it opens scrolled to "Information
  // personnelle" — which puts the Documents section, the only place the attached CV's
  // filename is visible, above the captured area. A fullPage screenshot of the document does
  // not fix that. Scroll the modal itself back to the top first, so the review screenshot
  // actually evidences the attachment instead of implying it.
  await page.evaluate(() => {
    const span = document.querySelector('.cxsFileUpload[fieldname]');
    if (span) span.scrollIntoView({ block: 'center' });
    for (let el = span && span.parentElement; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 4) { el.scrollTop = 0; break; }
    }
  }).catch(() => {});
  await page.waitForTimeout(800);
  const shot = path.join(outDir, 'connexys-filled.png');
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

  emit('filled', {
    filled, pending, shot, kind, uploadedType,
    note: 'Review every answer, fill what is listed as pending, then click "ENVOYER MA CANDIDATURE". Nothing is submitted by this script.',
  });
  writeState({ status: 'filled', url: page.url(), kind, uploadedType, captcha: !!captcha, cv_parse: parsed, filled, pending, shot });

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
