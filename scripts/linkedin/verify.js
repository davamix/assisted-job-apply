// Verify the saved session works: load cookies, hit the feed, confirm we're logged in.
const { chromium } = require('@playwright/test');
const path = require('path');

(async () => {
  const authFile = process.argv[2] || path.join(__dirname, '..', '..', '.auth', 'linkedin-state.json');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: authFile });
  const page = await context.newPage();

  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const url = page.url();
  const redirectedToLogin = /\/login|\/authwall|\/checkpoint/.test(url);

  // Try to read the logged-in user's name from the profile nav.
  let name = null;
  try {
    name = await page.locator('.profile-card-name, .global-nav__me-photo').first().getAttribute('alt', { timeout: 4000 });
  } catch {}
  if (!name) {
    try { name = (await page.title()); } catch {}
  }

  console.log('URL:', url);
  console.log('LOGGED_IN:', !redirectedToLogin);
  console.log('WHOAMI:', name);
  await browser.close();
})().catch(err => { console.error('ERROR:', err); process.exit(1); });
