// Flatten a Markdown letter to the plain text an ATS textarea should receive.
//
// The authored letters live as Markdown in output/<id>/ (bold, links, an H1 title), but a
// cover-letter textarea takes prose — pasting the raw source would show literal ** and
// [text](url) to the reader. This strips the syntax while keeping the words.
//
// The leading H1 is dropped: it titles the file ("Cover Letter — AI Engineer, SDG Group"),
// it is not part of the letter the employer reads.
//
//   mdToPlainText('# T\n\nDear **X**, see [site](https://a.b)')
//     -> 'Dear X, see site (https://a.b)'

// A link whose label is just its own URL (bare or scheme-less, as in
// [example.com](https://example.com)) collapses to the URL alone — rendering it as
// "example.com (https://example.com)" would say the same thing twice.
const bareUrl = (u) => String(u).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');

function mdToPlainText(md) {
  let s = String(md == null ? '' : md).replace(/\r\n/g, '\n');

  s = s.replace(/^#\s+.*\n+/, '');              // drop the file's H1 title
  s = s.replace(/^#{1,6}\s+/gm, '');            // any remaining headings -> plain lines
  s = s.replace(/```[\s\S]*?```/g, '');         // fenced code has no place in a letter
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

  // [text](url) -> "text (url)", collapsing to the URL when the label merely repeats it.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) =>
    bareUrl(text) === bareUrl(url) ? url.trim() : `${text} (${url})`);

  s = s.replace(/(\*\*\*|___)(\S[\s\S]*?\S?)\1/g, '$2');
  s = s.replace(/(\*\*|__)(\S[\s\S]*?\S?)\1/g, '$2');
  s = s.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  s = s.replace(/^\s{0,3}[-*+]\s+/gm, '- ');
  s = s.replace(/^\s{0,3}(?:---|\*\*\*|___)\s*$/gm, '');
  s = s.replace(/[ \t]+$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim() + '\n';
}

module.exports = { mdToPlainText };
