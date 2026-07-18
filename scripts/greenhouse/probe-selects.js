// Deeper Greenhouse probe: open each combobox/select question and dump its options,
// plus the exact DOM wiring (is there a hidden native <select>? what role does the
// listbox use?). Read-only. Prints JSON. Used to build the answers + the apply adapter.
//
//   node scripts/greenhouse/probe-selects.js <apply-url>
const { chromium } = require('@playwright/test');

(async () => {
  const url = process.argv[2];
  if (!url) { console.error('need an apply url'); process.exit(2); }
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  // Find the Greenhouse form frame.
  const frame = page.frames().find(f => /greenhouse/i.test(f.url()) && !/recaptcha|proxy/i.test(f.url()));
  if (!frame) { console.error('greenhouse frame not found'); await browser.close(); process.exit(3); }

  // List the question ids + labels + whether each looks like a combobox (has a sibling
  // input with role=combobox / aria-haspopup, or a hidden <select>).
  const questions = await frame.evaluate(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    document.querySelectorAll('[id^="question_"]').forEach(el => {
      if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') return;
      const id = el.id;
      const label = norm((document.querySelector(`label[for="${id}"]`) || {}).textContent || '');
      const container = el.closest('div');
      const combo = container ? container.querySelector('[role="combobox"], input[aria-haspopup], input:not([type])') : null;
      const nativeSelect = container ? container.querySelector('select') : null;
      out.push({
        id, label,
        elTag: el.tagName.toLowerCase(),
        elType: el.getAttribute('type'),
        elRole: el.getAttribute('role'),
        ariaHaspopup: el.getAttribute('aria-haspopup'),
        hasCombo: !!combo,
        comboRole: combo ? combo.getAttribute('role') : null,
        hasNativeSelect: !!nativeSelect,
      });
    });
    return out;
  });

  // For each question that looks selectable, click it and read the opened option list.
  const results = [];
  for (const q of questions) {
    const rec = { id: q.id, label: q.label, ...q, options: [], optionSelector: null, note: '' };
    try {
      const trigger = frame.locator(`#${q.id}`).first();
      await trigger.scrollIntoViewIfNeeded().catch(() => {});
      await trigger.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(700);
      const opened = await frame.evaluate(() => {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim();
        const sels = ['[role="option"]', '.select__option', 'li[id*="option"]', 'ul[role="listbox"] li', '[id*="-option-"]'];
        for (const sel of sels) {
          const nodes = Array.from(document.querySelectorAll(sel));
          const visible = nodes.filter(n => n.offsetParent !== null);
          if (visible.length) return { selector: sel, options: visible.map(n => norm(n.textContent)).slice(0, 30) };
        }
        return { selector: null, options: [] };
      });
      rec.optionSelector = opened.selector;
      rec.options = opened.options;
      // Close the dropdown before moving on.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(250);
    } catch (e) { rec.note = String(e).slice(0, 120); }
    results.push(rec);
  }

  console.log(JSON.stringify(results, null, 2));
  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
