// One-time login for a Workday tenant: opens a real browser, YOU sign in manually
// (the password is never seen or stored here), then saves the session cookies to an auth
// file for reuse — same pattern as scripts/linkedin/login.js.
//
// Workday candidate accounts are PER TENANT: an account with one employer does not work
// for another. So each employer gets its own auth file, named after the tenant.
//
//   node scripts/workday/login.js --tenant https://iqvia.wd1.myworkdayjobs.com/IQVIA \
//        [--auth .auth/workday-iqvia-state.json] [--start <url>]
//
// Detection uses the shared probe in session.js, which requires POSITIVE evidence of the
// candidate account UI — see the traps documented there. Tenants vary and Workday
// localises its labels, so if detection misses, create the marker file .auth/SAVE and the
// session is saved regardless.
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

// "https://iqvia.wd1.myworkdayjobs.com/IQVIA" -> "iqvia" (for the auth filename)
function tenantSlug(tenant) {
  try {
    const u = new URL(tenant);
    const host = u.hostname.split('.')[0];
    const site = u.pathname.split('/').filter(Boolean).pop() || '';
    return (site || host).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  } catch { return 'tenant'; }
}

(async () => {
  const a = parseArgs(process.argv);
  if (!a.tenant) {
    console.error('need --tenant, e.g. --tenant https://iqvia.wd1.myworkdayjobs.com/IQVIA');
    process.exit(2);
  }
  const tenant = String(a.tenant).replace(/\/+$/, '');
  const root = path.join(__dirname, '..', '..');
  const authFile = a.auth
    ? path.resolve(String(a.auth))
    : path.join(root, '.auth', `workday-${tenantSlug(tenant)}-state.json`);
  const marker = path.join(root, '.auth', 'SAVE');
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  try { fs.unlinkSync(marker); } catch {}

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();

  // Start at the sign-in form, not candidate_home: candidate_home is not reachable
  // anonymously and answers with a client-side "Requested page not found" error popup
  // (the SPA still serves HTTP 200, so only a browser reveals this).
  const start = String(a.start || `${tenant}/login`);
  await page.goto(start, { waitUntil: 'domcontentloaded' }).catch(() => {});
  console.log('>>> Please sign in to Workday in the browser window.');
  console.log('>>> Waiting up to 6 minutes for a signed-in session...');
  console.log('>>> (If it does not detect automatically, tell me and I will create .auth/SAVE.)');

  const deadline = Date.now() + 6 * 60 * 1000;
  let ok = false;
  let last = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(marker)) { ok = true; console.log('>>> .auth/SAVE marker seen — saving session.'); break; }
    try {
      last = await probeSession(page);
      if (last.signedIn) { ok = true; break; }
    } catch { /* mid-navigation; try again next tick */ }
    await page.waitForTimeout(2000);
  }

  if (!ok) {
    console.log('RESULT: NOT_SIGNED_IN (no session detected within timeout)');
    if (last) console.log('LAST_PROBE:', JSON.stringify(last));
    await browser.close();
    process.exit(2);
  }

  await page.waitForTimeout(2500);
  await context.storageState({ path: authFile });
  try { fs.unlinkSync(marker); } catch {}
  console.log('RESULT: SIGNED_IN');
  console.log('SAVED_AUTH_TO:', authFile);
  console.log('CURRENT_URL:', page.url());
  await browser.close();
})().catch(err => { console.error('ERROR:', err); process.exit(1); });
