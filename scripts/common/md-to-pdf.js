// Render a Markdown file to a clean, ATS-friendly A4 PDF using the Chromium that
// Playwright already ships (no pandoc/LaTeX needed).
// Markdown -> HTML (markdown-it) -> templates/<template>.html -> PDF.
// Usage: node scripts/common/md-to-pdf.js --in "output/7/CV.md" --out "/tmp/CV.pdf"
//        [--template letter|cv|resume] [--role "AI Engineer"] [--title "Your Name"]
//        [--date "15 July 2026"]
const { chromium } = require('@playwright/test');
const MarkdownIt = require('markdown-it');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  return a;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');

function pickTemplate(a) {
  if (a.template) return a.template;
  const f = path.basename(a.in);
  // A presentation letter differs from a cover letter in what it says, not in
  // how it looks, so both take the letter layout.
  if (/cover|presentation/i.test(f)) return 'letter';
  if (/r[eé]sum[eé]/i.test(f)) return 'resume';
  return 'cv';
}

// One link only, most personal first: a site you own says more than a profile page.
const pickLink = (links) => links.website || links.github || links.linkedin || '';

// "Barcelona, Spain (remote)" — a résumé leads with this because remote and
// where-you-are decide whether the rest of the page gets read.
function locationText(me) {
  const where = [me.location_city, me.location_country].filter(Boolean).join(', ');
  return me.remote_only && where ? `${where} (remote)` : where;
}

// "15 July 2026" — unambiguous to both European and US readers, unlike 07/15 vs 15/07.
const today = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

function loadMe() {
  const p = path.join(ROOT, 'config', 'profile.json');
  if (!fs.existsSync(p)) throw new Error(`the letterhead needs ${p} — copy config/profile.example.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Scheme and "www." are noise in a letterhead; the trailing slash even more so.
const linkText = (url) => url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
const linkHtml = (url) => `<a href="${esc(url)}">${esc(linkText(url))}</a>`;

function contactsHtml(me, template) {
  const links = me.links || {};
  const mail = me.email ? `<a href="mailto:${esc(me.email)}">${esc(me.email)}</a>` : '';
  const all = [links.website, links.github, links.linkedin].filter(Boolean).map(linkHtml);
  const one = [pickLink(links)].filter(Boolean).map(linkHtml);
  const byTemplate = {
    // One restrained line: a single link, closing on the phone.
    letter: [mail, ...one, esc(me.phone)],
    // Lead with the direct contacts, then every link — a CV is where people go
    // looking for your work.
    cv: [mail, esc(me.phone), ...all],
    // Lead with location; otherwise as the CV.
    resume: [esc(locationText(me)), mail, esc(me.phone), ...all],
  };
  // Each contact is atomic: the line may wrap between items, never inside one.
  // The plain spaces in a phone number are otherwise wrap opportunities, and it
  // breaks across lines.
  return (byTemplate[template] || byTemplate.cv)
    .filter(Boolean)
    .map((c) => `<span class="item">${c}</span>`)
    .join('<span class="sep">&middot;</span>');
}

(async () => {
  const a = parseArgs(process.argv);
  if (!a.in || !a.out) { console.error(JSON.stringify({ error: 'need --in and --out' })); process.exit(2); }

  const template = pickTemplate(a);
  const tplPath = path.join(ROOT, 'templates', `${template}.html`);
  if (!fs.existsSync(tplPath)) { console.error(JSON.stringify({ error: `no such template: ${tplPath}` })); process.exit(2); }

  const md = fs.readFileSync(a.in, 'utf8');
  // breaks:true keeps the signature block's line breaks, which Markdown would
  // otherwise collapse into one line. A CV has no such run-on lines.
  const isLetter = template === 'letter';
  const renderer = new MarkdownIt({ html: true, linkify: true, breaks: isLetter });
  // .NET is a real TLD, so fuzzy linkify turns every "ASP.NET" and "VB.NET" on a
  // CV into a dead link. Schemeless autolinking costs more than it earns here;
  // explicit http(s):// URLs and [markdown](links) still resolve.
  renderer.linkify.set({ fuzzyLink: false });
  const content = renderer.render(md);

  // Every template carries a generated letterhead; only the letter dates itself.
  const me = loadMe();
  const doc = fill(fs.readFileSync(tplPath, 'utf8'), {
    title: esc(a.title || path.basename(a.in, '.md')),
    content,
    name: esc(me.full_name),
    // A résumé is written for one role, so its title line is tailored per
    // application; --role overrides the standing one from the profile.
    role: esc(a.role || me.current_title),
    contacts: contactsHtml(me, template),
    date: esc(a.date || today()),
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(doc, { waitUntil: 'load' });
  fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
  // Page size and margins come from each template's @page rule, so a template
  // owns its whole layout and this script owns none of it.
  await page.pdf({ path: a.out, printBackground: true, preferCSSPageSize: true });
  await browser.close();
  console.log(JSON.stringify({ ok: true, template, out: path.resolve(a.out), bytes: fs.statSync(a.out).size }));
})().catch((err) => { console.error('ERROR:', err); process.exit(1); });
