// Reconnaissance for an Ashby application form: dump every field, its label, type and the
// per-posting UUID, so a job's answers.json can be written against real wording.
//
// Ashby question ids are UUIDs that change per posting, so answers.json matches questions by
// `label_contains` wording — this script is how you read that wording. It also reports which
// widget each question uses, since booleans are a Yes/No button pair rather than a checkbox
// you can tick, and flags the "Autofill from resume" file input so it is not mistaken for
// the real résumé slot.
//
//   node scripts/ashby/probe-fields.js --url <ashby-apply-url> [--shot probe.png]
const { chromium } = require('@playwright/test');

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

function toApplyUrl(url) {
  const u = String(url).trim();
  if (!/jobs\.ashbyhq\.com/i.test(u)) return u;
  const base = u.split('?')[0].replace(/\/+$/, '');
  return /\/application$/.test(base) ? base : base + '/application';
}

(async () => {
  const a = parseArgs(process.argv);
  if (!a.url) { console.error(JSON.stringify({ error: 'need --url' })); process.exit(2); }

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();
  await page.goto(toApplyUrl(a.url), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  const out = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

    // Every question block is anchored by a label; Ashby tags them with a stable class.
    const questions = [];
    document.querySelectorAll('label, [class*="question-title"]').forEach((l) => {
      const text = norm(l.textContent);
      if (!text) return;
      let n = l, ctl = null;
      for (let i = 0; i < 6 && n && !ctl; i++) {
        n = n.parentElement;
        if (n) ctl = n.querySelector('textarea, input:not([type=hidden]), div[class*="yesno"], select');
      }
      if (!ctl) return;
      const isYesNo = /yesno/.test(ctl.className || '') || !!(n && n.querySelector('div[class*="yesno"]'));
      const tag = ctl.tagName.toLowerCase();
      questions.push({
        label: text.replace(/\*$/, '').trim(),
        required: /\*/.test(text) || ctl.required || null,
        widget: isYesNo ? 'yesno' : (tag === 'input' ? (ctl.getAttribute('type') || 'text') : tag),
        id: ctl.id || null,
        name: ctl.getAttribute('name') || (isYesNo && n ? (n.querySelector('input[type=checkbox]') || {}).name : null) || null,
        answers_json_type: isYesNo ? 'yesno' : (tag === 'textarea' ? 'textarea' : 'text'),
      });
    });

    const files = [...document.querySelectorAll('input[type=file]')].map((f, i) => ({
      index: i,
      id: f.id || null,
      isAutofillWidget: !f.id,   // Ashby's parser widget has no id; the real slot is #_systemfield_resume
      label: f.id ? norm((document.querySelector(`label[for="${f.id}"]`) || {}).textContent || '') : '(Autofill from resume)',
    }));

    const html = document.documentElement.outerHTML;
    return {
      url: location.href,
      title: document.title,
      questions,
      fileInputs: files,
      submitButton: norm(([...document.querySelectorAll('button')].find((b) => /submit/i.test(b.innerText)) || {}).innerText || ''),
      captchaMarkers: {
        recaptcha: /g-recaptcha|recaptcha\.net|grecaptcha/i.test(html),
        turnstile: /cf-turnstile|challenges\.cloudflare/i.test(html),
        hcaptcha: /hcaptcha/i.test(html),
      },
    };
  });

  console.log(JSON.stringify(out, null, 2));
  if (a.shot) await page.screenshot({ path: String(a.shot), fullPage: true }).catch(() => {});
  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
