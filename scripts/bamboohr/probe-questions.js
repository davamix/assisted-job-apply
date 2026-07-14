// Capture a BambooHR form's custom-question text, dropdown options, and file slots.
// Reconnaissance only — read-only, headless. Distinguishes the résumé vs cover-letter
// upload slots by their nearby label. See apply.js.
//
//   node scripts/bamboohr/probe-questions.js <careers-url>
const { chromium } = require('@playwright/test');
(async () => {
  const url = process.argv[2] || 'https://lifebit.bamboohr.com/careers/44';
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.locator('[data-bi-id="careers-site-apply-button"]').first().click({ timeout: 5000 }).catch(()=>{});
  await page.waitForTimeout(3500);

  const info = await page.evaluate(() => {
    const norm = s => (s||'').replace(/\s+/g,' ').trim();
    // Custom questions: for each unique radio-group name, find its question text.
    const groups = {};
    document.querySelectorAll('input[type=radio]').forEach(r => {
      const nm = r.getAttribute('name'); if (!nm) return;
      if (!groups[nm]) {
        // Walk up to the field wrapper, take its text minus the option labels.
        let p = r.closest('fieldset, .fab-FormField, [class*="FormField" i], div');
        let hops = 0, qtext = '';
        while (p && hops < 5) {
          const t = norm(p.innerText || '');
          if (t.length > 8) { qtext = t; break; }
          p = p.parentElement; hops++;
        }
        groups[nm] = qtext;
      }
    });
    // File inputs and their nearby labels (resume vs cover letter).
    const files = [];
    document.querySelectorAll('input[type=file]').forEach(f => {
      let p = f.closest('.fab-FormField, [class*="FormField" i], div, fieldset'); let hops=0, lab='';
      while (p && hops<4 && !lab) { const t = norm(p.innerText||''); if (t && t.length<80) lab=t; p=p.parentElement; hops++; }
      files.push({ required: f.required, accept: f.getAttribute('accept'), near: lab });
    });
    const opt = sel => { const s = document.querySelector(sel); return s ? Array.from(s.options).map(o=>norm(o.textContent)) : null; };
    return {
      questions: groups,
      files,
      countryOptions: opt('select[name="countryId.value"]'),
      stateOptions: opt('select[name="state.value"]'),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
