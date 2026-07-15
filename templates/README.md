# templates/

HTML + CSS used by `scripts/common/md-to-pdf.js` to turn Markdown into PDF.

Rendering is **Markdown → HTML (`markdown-it`) → template → PDF (Chromium)**. Each template is a
complete HTML document with `{{placeholder}}` slots the script fills in. All styling lives here; the
script has none. Edit the CSS in these files and re-render — no code change needed.

## The templates

| Template | Renders | Picked when the filename |
|---|---|---|
| `cv.html` | CVs, tailored CVs | matches nothing else (the default) |
| `resume.html` | On-demand résumés | contains "resume" / "résumé" |
| `letter.html` | Cover letters, presentation letters | contains "cover" or "presentation" |

`--template cv|resume|letter` overrides the filename guess.

All three open with the **same letterhead**, so every document you send a company looks like one set.
Below it they differ by how much space the document has to spend:

| | Margins | Type | Target |
|---|---|---|---|
| `cv.html` | 14 / 15mm | 10.5pt / 1.4 | as long as it needs (4 pages is normal) |
| `resume.html` | 13 / 16mm | 10.5pt / 1.4 | **one page** |
| `letter.html` | 20 / 22mm | 11pt / 1.5 | one page |

There is no separate presentation-letter template on purpose: a presentation letter differs from a
cover letter in what it says, not how it looks, so a fourth stylesheet would only be `letter.html`
drifting.

## When to use which document

| Document | Use it when | Tailored per job? |
|---|---|---|
| **CV** | the form asks for a CV, or by default | only if the role warrants it |
| **Résumé** | the form asks specifically for a résumé | yes — condensed from the CV for that role |
| **Cover letter** | the form has a cover-letter slot (most common) | yes — always |
| **Presentation letter** | the form asks for one instead (rare) | no — reusable as-is |

A **CV** is the full history. A **résumé** is a one-page pitch condensed from it for a specific role
— never attach a CV to a résumé slot (`scripts/common/classify-doc-field.js` decides which a form is
asking for). A **cover letter** argues your fit for one posting. A **presentation letter** introduces
you generally; see below.

## The letterhead is generated, not authored

Name, role, contacts and date come from `config/profile.json` at render time, so they cannot drift
between documents. **Never write them into the Markdown** — you will get them twice.

| Slot | Filled with | In |
|---|---|---|
| `{{content}}` | the rendered Markdown | all |
| `{{title}}` | `--title`, else the input filename (PDF metadata) | all |
| `{{name}}` | `full_name` | all |
| `{{role}}` | `--role`, else `current_title` | all |
| `{{contacts}}` | location, email, phone, links — varies, see below | all |
| `{{date}}` | `--date`, else today as "15 July 2026" | letter |

**The contact line** differs by template on purpose:

- **letter** — email · one link · phone. One restrained line; the link is picked by priority
  (`website` → `github` → `linkedin`).
- **cv** — email · phone · every link. A CV is the document people go looking for your work in.
- **résumé** — as the CV, but led by `location_city, location_country (remote)`, because remote and
  where-you-are decide whether the rest of the page gets read.

**The role line** — a CV and a letter use your standing `current_title`. A résumé is written for one
role, so pass a tailored one: `--role "AI Engineer · C#/.NET + GenAI"`.

## Writing the Markdown

The file holds only what you write. **No name, no contact block, no footer.** A CV or résumé starts
at its first `## Section`; a letter starts at the salutation:

```markdown
# Cover Letter — Role, Company     <- labels the file; hidden in the PDF

Dear [Salutation],

[Opening paragraph]

[Middle paragraphs]

[Closing paragraph]

Best regards,
**Your Name**
```

An `# ...` heading is hidden in every template: it names the file for the dashboard, it isn't part of
the document an employer reads.

The signature block relies on `breaks: true` (set for the letter template) to keep "Best regards,"
and your name on separate lines — Markdown would otherwise collapse them into one.

The accent colour marks **what you scan down the left edge**, and nothing else: project names on the
CV (backticked — `` `Acopio` `` — which is why `code` renders as a label, not a monospace chip), and
each bullet's lead-in on the résumé (`- **Acopio** — …`). Inline `**emphasis**` mid-sentence stays
plain bold; a résumé bolds enough keywords that colouring them all turns the page into noise.

### Cover letter vs presentation letter

Most employers ask for a **cover letter**; some ask for a **presentation letter** (a letter of
introduction). They are not the same document, and the difference is entirely in the writing:

|  | Cover letter | Presentation letter |
|---|---|---|
| Argues | why you fit **this** role | who you are, generally |
| Names | the company and the posting | neither — it's reusable |
| Draws on | the job description | your own background |
| Closes by | asking to discuss the role | offering to stay in touch |
| Reused? | never — written per application | yes, edited rarely |

A presentation letter is roughly three short paragraphs: **who you are**, **what you bring**, and
**what you're looking for** — closing on staying in touch, now or later. Keep the posting out of it;
if you find yourself answering a job ad, you're writing a cover letter.

Because it is reusable and names no company, it lives once at `assets/presentation-letter.md` rather
than per-job under `output/<id>/`. It is *your* letter: the shape is reusable, the content is not.

## Rendering

```
node scripts/common/md-to-pdf.js --in <file.md> --out <file.pdf> [--template …] [--role …] [--date …]
```

```
# cover letter for job 15
node scripts/common/md-to-pdf.js --in "output/15/Cover letter.md" --out "output/15/Cover letter.pdf"

# résumé, with a role line tailored to the posting
node scripts/common/md-to-pdf.js --in "output/15/resume.md" --out "output/15/resume.pdf" \
  --role "AI Engineer · C#/.NET + GenAI"

# presentation letter (reusable; rendered where the application needs it)
node scripts/common/md-to-pdf.js --in "assets/presentation-letter.md" --out "output/15/Presentation letter.pdf"
```

Rendering needs `config/profile.json` for the letterhead — it will refuse without it.

## Changing a template

Edit the CSS, re-render any real document, and open the PDF. Two traps, both learned the hard way:

**Check the page count from the PDF, not from a browser screenshot.** If you script a preview,
`browser.newPage()` takes `viewport` — pass `viewportSize` and Playwright silently ignores it, giving
you a 1280px-wide page instead of A4's 794px. Layout then looks fine while the real PDF wraps. To
count pages for real, read `/Type /Pages … /Count N` out of the PDF bytes.

**Contacts must stay atomic.** Each item in the letterhead is a `<span class="item">` with
`white-space: nowrap`, so the line wraps *between* contacts, never inside one. Without it the plain
spaces in a phone number (`+00 000 000 000`) are wrap opportunities and it splits across two lines.

## Linkify

Rendering runs with `linkify` on but `fuzzyLink` **off**. `.NET` is a real TLD, so schemeless
autolinking turns every "ASP.NET" and "VB.NET" on a CV into a dead link to `http://ASP.NET`. Write
URLs with an explicit scheme or as `[markdown](links)`; both still resolve.
