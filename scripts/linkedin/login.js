// One-time login: opens a real browser, YOU log in manually (I never see the password),
// then it saves the session cookies to an auth file for reuse.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

(async () => {
  const authFile = process.argv[2] || path.join(__dirname, '..', '..', '.auth', 'linkedin-state.json');
  fs.mkdirSync(path.dirname(authFile), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
  });
  const page = await context.newPage();

  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  console.log('>>> Please log in to LinkedIn in the browser window (complete 2FA if asked).');
  console.log('>>> Waiting up to 4 minutes for a logged-in session...');

  // Detect login by presence of the `li_at` session cookie — page/URL agnostic, handles 2FA.
  const deadline = Date.now() + 230000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    const cookies = await context.cookies('https://www.linkedin.com');
    if (cookies.some(c => c.name === 'li_at' && c.value)) { loggedIn = true; break; }
    await page.waitForTimeout(2000);
  }

  if (!loggedIn) {
    console.log('RESULT: NOT_LOGGED_IN (no session detected within timeout)');
    await browser.close();
    process.exit(2);
  }

  await page.waitForTimeout(2500);
  await context.storageState({ path: authFile });
  console.log('RESULT: LOGGED_IN');
  console.log('SAVED_AUTH_TO:', authFile);
  console.log('CURRENT_URL:', page.url());
  await browser.close();
})().catch(err => { console.error('ERROR:', err); process.exit(1); });
