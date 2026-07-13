// Render a Markdown file to a clean, ATS-friendly A4 PDF using the Chromium that
// Playwright already ships (no pandoc/LaTeX needed).
// Usage: node scripts/md-to-pdf.js --in "output/7/CV.md" --out "/tmp/CV.pdf" [--title "Your Name"]
const { chromium } = require('@playwright/test');
const MarkdownIt = require('markdown-it');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  return a;
}

const CSS = `
  * { box-sizing: border-box; }
  body { font-family: "Calibri", "Segoe UI", Arial, sans-serif; color: #1a1a1a; font-size: 10.5pt; line-height: 1.4; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 2pt; color: #0b3d5c; }
  h2 { font-size: 12.5pt; margin: 14pt 0 4pt; padding-bottom: 2pt; border-bottom: 1.5px solid #0b3d5c; color: #0b3d5c; text-transform: uppercase; letter-spacing: .4px; }
  h3 { font-size: 11pt; margin: 9pt 0 2pt; }
  p { margin: 3pt 0; }
  ul { margin: 3pt 0 3pt 0; padding-left: 16pt; }
  li { margin: 1.5pt 0; }
  a { color: #0b57d0; text-decoration: none; }
  strong { color: #111; }
  hr { border: none; border-top: 1px solid #ccc; margin: 8pt 0; }
  code { font-family: Consolas, monospace; background: #f2f4f7; padding: 0 3px; border-radius: 3px; font-size: 9.5pt; }
`;

(async () => {
  const a = parseArgs(process.argv);
  if (!a.in || !a.out) { console.error(JSON.stringify({ error: 'need --in and --out' })); process.exit(2); }
  const md = fs.readFileSync(a.in, 'utf8');
  const html = new MarkdownIt({ html: true, linkify: true, breaks: false }).render(md);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${html}</body></html>`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(doc, { waitUntil: 'load' });
  fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
  await page.pdf({
    path: a.out,
    format: 'A4',
    printBackground: true,
    margin: { top: '14mm', bottom: '14mm', left: '15mm', right: '15mm' },
  });
  await browser.close();
  console.log(JSON.stringify({ ok: true, out: path.resolve(a.out), bytes: fs.statSync(a.out).size }));
})().catch((err) => { console.error('ERROR:', err); process.exit(1); });
