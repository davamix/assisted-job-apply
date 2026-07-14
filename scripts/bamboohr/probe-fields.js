// Probe a BambooHR careers page: click the apply button, then enumerate the form.
// Reconnaissance only — read-only, headless. Prints the field list as JSON so the
// per-job answers.json (selectors + screening questions) can be built. See apply.js.
//
//   node scripts/bamboohr/probe-fields.js <careers-url>
const { chromium } = require('@playwright/test');
(async () => {
  const url = process.argv[2] || 'https://lifebit.bamboohr.com/careers/44';
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Click the apply button that swaps in the application form.
  let clicked = false;
  try {
    const btn = page.locator('[data-bi-id="careers-site-apply-button"]').first();
    if (await btn.count()) { await btn.scrollIntoViewIfNeeded().catch(()=>{}); await btn.click({ timeout: 5000 }); clicked = true; }
  } catch (e) {}
  await page.waitForTimeout(3500);

  const info = await page.evaluate(() => {
    const norm = s => (s||'').replace(/\s+/g,' ').trim();
    const labelFor = (el, root) => {
      let t = '';
      const id = el.getAttribute('id');
      if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) t = norm(l.textContent); }
      if (!t) { const l = el.closest('label'); if (l) t = norm(l.textContent); }
      if (!t) t = norm(el.getAttribute('aria-label'));
      if (!t) {
        // BambooHR wraps each field; look for a nearby label-ish element.
        let p = el.closest('div,fieldset,li,section'); let hops=0;
        while (p && hops<3 && !t) {
          const lab = p.querySelector('label, legend, .fab-FormField__label, [class*="label" i]');
          if (lab && lab !== el) t = norm(lab.textContent);
          p = p.parentElement; hops++;
        }
      }
      return t;
    };
    const fields = [];
    document.querySelectorAll('input, select, textarea').forEach(el => {
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (['hidden','submit','button','image'].includes(type)) return;
      fields.push({
        tag: el.tagName.toLowerCase(),
        type,
        id: el.getAttribute('id') || null,
        name: el.getAttribute('name') || null,
        placeholder: el.getAttribute('placeholder') || null,
        required: el.required || el.getAttribute('aria-required') === 'true' || null,
        label: labelFor(el),
        options: el.tagName === 'SELECT' ? Array.from(el.options).map(o=>norm(o.textContent)).slice(0,12) : null,
      });
    });
    const fileButtons = Array.from(document.querySelectorAll('button, a, [role=button]'))
      .map(b => norm(b.getAttribute('aria-label') || b.textContent))
      .filter(t => t && /resume|cv|cover letter|attach|upload|drag|drop|choose file|browse/i.test(t) && t.length < 60);
    const submitButtons = Array.from(document.querySelectorAll('button, input[type=submit], [role=button]'))
      .map(b => norm(b.getAttribute('aria-label') || b.value || b.textContent))
      .filter(t => t && /submit|apply|send application|enviar/i.test(t) && t.length < 40);
    return { url: location.href, fieldCount: fields.length, fields, fileButtons: [...new Set(fileButtons)], submitButtons: [...new Set(submitButtons)] };
  });

  console.log('CLICKED_APPLY:', clicked);
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
