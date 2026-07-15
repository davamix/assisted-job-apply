# `assets/` — your CV lives here

This folder holds **your reusable personal documents** and is git-ignored (only this README is
committed). Nothing here is uploaded to the repository.

## What to put here

| File | Format | Purpose |
|------|--------|---------|
| `CV.md` | Markdown | Editable source of your CV. Used to render tailored PDFs via `scripts/common/md-to-pdf.js`, and as context when drafting cover letters / adapting the CV. |
| `CV.pdf` | PDF (ATS-friendly) | The resume file attached when a form needs a file upload. Point `default_cv_pdf` in `config/profile.json` at this path. |
| `presentation-letter.md` | Markdown | Your **presentation letter** (letter of introduction) — who you are, what you bring, what you're looking for. Reusable: it names no company or posting, so it lives here rather than per-job. Rendered on demand when a form asks for one instead of a cover letter. See `templates/README.md`. |

Documents here are authored **without a name/contact header** — the letterhead is generated from
`config/profile.json` at render time. Writing one in gets you it twice. See `templates/README.md`.

You can name the files anything you like — just make `config/profile.json` → `default_cv_pdf`
match, and (if you use the "select the right resume" feature) set `cv_filename_hint` in a job's
`output/<id>/answers.json` to a substring of the filename (e.g. `"CV"`).

## Notes
- **LinkedIn Easy Apply** reuses the resume you already saved on LinkedIn by default, so a local
  PDF is mainly for cover-letter rendering, CV tailoring, and any file-upload prompt.
- Keep an **ATS-friendly** PDF (plain layout, selectable text, no multi-column/graphics) so parsers read it correctly.
- Tailored CVs generated per job are written to `output/<jobId>/CV.md` (also git-ignored).
