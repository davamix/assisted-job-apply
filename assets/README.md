# `assets/` — your CV lives here

This folder holds **your personal CV** and is git-ignored (only this README is committed).
Nothing here is uploaded to the repository.

## What to put here

| File | Format | Purpose |
|------|--------|---------|
| `CV.md` | Markdown | Editable source of your CV. Used to render tailored PDFs via `scripts/md-to-pdf.js`, and as context when drafting cover letters / adapting the CV. |
| `CV.pdf` | PDF (ATS-friendly) | The resume file attached when a form needs a file upload. Point `default_cv_pdf` in `config/profile.json` at this path. |

You can name the files anything you like — just make `config/profile.json` → `default_cv_pdf`
match, and (if you use the "select the right resume" feature) set `cv_filename_hint` in a job's
`output/<id>/answers.json` to a substring of the filename (e.g. `"CV"`).

## Notes
- **LinkedIn Easy Apply** reuses the resume you already saved on LinkedIn by default, so a local
  PDF is mainly for cover-letter rendering, CV tailoring, and any file-upload prompt.
- Keep an **ATS-friendly** PDF (plain layout, selectable text, no multi-column/graphics) so parsers read it correctly.
- Tailored CVs generated per job are written to `output/<jobId>/CV.md` (also git-ignored).
