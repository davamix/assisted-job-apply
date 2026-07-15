// Probe a Teamtailor careers page: open the application form, then enumerate it.
// Reconnaissance only — read-only, headless. Prints the field list as JSON so the
// per-job answers.json (selectors + screening questions) can be built. See apply.js.
//
// Teamtailor differs from BambooHR in two ways that matter here:
//  - a cookie consent wall covers the page and swallows the first click, so it must be
//    dismissed before anything else is reachable;
//  - APPLY is a Stimulus button that opens an in-page form overlay
//    (click->careersite--jobs--form-overlay#showFormOverlay), not a link to a new URL.
//
//   node scripts/teamtailor/probe-fields.js <careers-url>
const { chromium } = require('@playwright/test');

const APPLY_SEL = 'button[data-action*="form-overlay#showFormOverlay"]';

async function acceptCookies(page) {
  for (const t of ['Accept all', 'Aceptar todas', 'Accept', 'Aceptar', 'Allow all']) {
    const b = page.locator(`button:has-text("${t}")`).first();
    if (await b.count()) { await b.click({ timeout: 3000 }).catch(() => {}); return t; }
  }
  return null;
}

(async () => {
  const url = process.argv[2];
  if (!url) { console.error('need a careers url'); process.exit(2); }
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const cookie = await acceptCookies(page);
  await page.waitForTimeout(1500);

  let clicked = false;
  try {
    const btn = page.locator(APPLY_SEL).first();
    if (await btn.count()) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 5000 });
      clicked = true;
    }
  } catch (e) {}
  await page.waitForTimeout(4000);

  const info = await page.evaluate(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const labelFor = (el) => {
      let t = '';
      const id = el.getAttribute('id');
      if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) t = norm(l.textContent); }
      if (!t) { const l = el.closest('label'); if (l) t = norm(l.textContent); }
      if (!t) t = norm(el.getAttribute('aria-label'));
      if (!t) {
        let p = el.closest('div,fieldset,li,section'); let hops = 0;
        while (p && hops < 3 && !t) {
          const lab = p.querySelector('label, legend, [class*="label" i]');
          if (lab && lab !== el) t = norm(lab.textContent);
          p = p.parentElement; hops++;
        }
      }
      return t;
    };
    const fields = [];
    document.querySelectorAll('input, select, textarea').forEach(el => {
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (['hidden', 'submit', 'button', 'image'].includes(type)) return;
      fields.push({
        tag: el.tagName.toLowerCase(),
        type,
        id: el.getAttribute('id') || null,
        name: el.getAttribute('name') || null,
        placeholder: el.getAttribute('placeholder') || null,
        required: el.required || el.getAttribute('aria-required') === 'true' || null,
        label: labelFor(el),
        options: el.tagName === 'SELECT' ? Array.from(el.options).map(o => norm(o.textContent)).slice(0, 12) : null,
      });
    });
    // Teamtailor renders each screening question as a group of radios/checkboxes sharing a
    // candidate[answers_attributes][N][...] name. The per-input label is only the *choice*
    // ("B2", "Yes"), so walk up to the surrounding block for the question wording itself.
    const questions = {};
    document.querySelectorAll('input[name*="answers_attributes"]').forEach(el => {
      const name = el.getAttribute('name');
      const m = /answers_attributes\]\[(\d+)\]/.exec(name || '');
      if (!m) return;
      const idx = m[1];
      if (questions[idx]) { questions[idx].choices.push(norm(labelFor(el))); return; }
      let q = '', p = el.closest('div,fieldset,li,section'), hops = 0;
      while (p && hops < 6) {
        const t = norm(p.innerText || '');
        if (t.length > 12) { q = t.split('\n')[0]; break; }
        p = p.parentElement; hops++;
      }
      questions[idx] = {
        index: Number(idx),
        name,
        type: (el.getAttribute('type') || '').toLowerCase(),
        question: q.replace(/\*?Required$/i, '').trim(),
        choices: [norm(labelFor(el))],
      };
    });

    const fileButtons = Array.from(document.querySelectorAll('button, a, [role=button]'))
      .map(b => norm(b.getAttribute('aria-label') || b.textContent))
      .filter(t => t && /resume|cv|cover letter|attach|upload|drag|drop|choose file|browse/i.test(t) && t.length < 60);
    const submitButtons = Array.from(document.querySelectorAll('button, input[type=submit], [role=button]'))
      .map(b => norm(b.getAttribute('aria-label') || b.value || b.textContent))
      .filter(t => t && /submit|apply|send application|enviar/i.test(t) && t.length < 40);
    return {
      url: location.href,
      fieldCount: fields.length,
      fields,
      questions: Object.values(questions).sort((a, b) => a.index - b.index),
      fileButtons: [...new Set(fileButtons)],
      submitButtons: [...new Set(submitButtons)],
    };
  });

  console.log('COOKIE_ACCEPTED:', cookie);
  console.log('CLICKED_APPLY:', clicked);
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
