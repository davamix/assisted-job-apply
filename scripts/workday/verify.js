// Verify a saved Workday session actually authenticates: load the cookies, hit the
// tenant's candidate_home, and report what is really there — same role as
// scripts/linkedin/verify.js.
//
//   node scripts/workday/verify.js --tenant https://iqvia.wd1.myworkdayjobs.com/IQVIA \
//        [--auth .auth/workday-iqvia-state.json] [--home userHome]
//
// The signed-in landing page is tenant-specific: IQVIA uses /userHome, while other tenants
// use /candidate_home. Hitting the wrong one yields a client-side error page and looks
// exactly like a failed session, so it is overridable.
//
// Uses the shared probe in session.js so login and verify can never disagree about what
// "signed in" means. Positive evidence only — see the traps documented there.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { probeSession } = require('./session');

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

(async () => {
  const a = parseArgs(process.argv);
  const tenant = String(a.tenant || 'https://iqvia.wd1.myworkdayjobs.com/IQVIA').replace(/\/+$/, '');
  const authFile = path.resolve(String(a.auth || path.join(__dirname, '..', '..', '.auth', 'workday-iqvia-state.json')));
  if (!fs.existsSync(authFile)) { console.error('auth file not found:', authFile); process.exit(2); }

  const state = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  const cookies = (state.cookies || []).map(c => c.name);
  console.log('AUTH_FILE:', authFile);
  console.log('COOKIE_COUNT:', cookies.length);
  console.log('COOKIE_NAMES:', cookies.join(', ') || '(none)');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: authFile });
  const page = await context.newPage();
  const home = String(a.home || 'userHome').replace(/^\/+/, '');
  await page.goto(`${tenant}/${home}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);

  const probe = await probeSession(page);

  console.log('URL:', probe.url);
  console.log('TITLE:', probe.title);
  console.log('ACCOUNT_EVIDENCE:', probe.accountEvidence);
  console.log('SIGN_IN_EVIDENCE:', probe.signInEvidence);
  console.log('SIGNED_IN:', probe.signedIn);
  console.log('BODY:', probe.bodyStart);
  await browser.close();
})().catch(err => { console.error('ERROR:', err); process.exit(1); });
