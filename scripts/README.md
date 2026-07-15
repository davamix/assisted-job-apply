# scripts/

Automation scripts, organized as **site-agnostic common utilities** plus **one folder per
job portal**. The tool started LinkedIn-only and now supports external ATS portals
(BambooHR and Teamtailor, with Greenhouse/Lever/Workday likely to follow), so each portal
is an *adapter* implementing only the capabilities it supports.

## Layout

```
scripts/
  common/                    # site-agnostic utilities
    md-to-pdf.js             # render Markdown (CV / résumé / letter) -> PDF via templates/
    md-to-text.js            # flatten Markdown (letter) -> plain text for an ATS textarea
    classify-doc-field.js    # classify an upload field label -> 'cv' | 'resume' | 'unknown'
  linkedin/                  # LinkedIn Jobs adapter (full pipeline)
    login.js  verify.js  search.js  job-detail.js  easyapply.js
  bamboohr/                  # BambooHR external-apply adapter (apply only)
    apply.js
    probe-fields.js  probe-questions.js   # reconnaissance used to build a job's answers.json
  teamtailor/                # Teamtailor external-apply adapter (apply only)
    apply.js
    probe-fields.js          # reconnaissance used to build a job's answers.json
```

Run everything from the repo root (`f:\JobSearch`) so `output/`, `assets/`, `config/`,
`.auth/` resolve. The npm aliases in `package.json` wrap the common invocations
(`npm run login|verify|search|detail|apply|apply:bamboohr|pdf`).

## Capability matrix

| Site       | session (login/verify) | search | job-detail (triage) | apply (fill + human gate) |
|------------|:----------------------:|:------:|:-------------------:|:-------------------------:|
| linkedin   | ✓                      | ✓      | ✓                   | ✓                         |
| bamboohr   | –                      | –      | –                   | ✓                         |
| teamtailor | –                      | –      | –                   | ✓                         |

External ATS sites are reached via the "Apply on company website" link found during
LinkedIn triage, so they usually implement **apply only**.

## Conventions (shared by every adapter)

- **Headed by default; NEVER auto-submit.** An adapter fills the form, screenshots it, and
  stops. The human reviews and submits. LinkedIn's driver waits for an `APPROVE`/`ABORT`
  signal file; BambooHR fills then waits for a `CLOSE` signal (the human solves the
  reCAPTCHA and clicks Submit).
- **Signal files** live in the job's output dir (`output/<id>/`): `APPROVE`, `ABORT`,
  `CLOSE` — empty marker files the human (or Claude) creates to advance/stop a run.
- **`answers.json`** (per job, at `output/<id>/answers.json`) is the flat data source an
  adapter fills from — identity, experience years, screening/compliance answers, and the
  documents to attach. See [output/README.md](../output/README.md) for the full key list.
- **Paths** passed as CLI args are resolved relative to the current working directory
  (repo root); the only repo-relative internal path is the LinkedIn auth file
  `.auth/linkedin-state.json` (resolved via `__dirname`).
- **State/telemetry:** adapters print `EVENT {json}` lines and write a `*-state.json` into
  the output dir.

## Documents: CV vs Résumé

Some employers ask for a **Résumé** (shorter, US-style) rather than the full **CV**. The
apply adapter reads the upload field's label and classifies it via
`common/classify-doc-field.js`:

- **CV** (or "CV/Résumé", where a CV is acceptable) → attach the default CV
  (`assets/…-ATS.pdf`) or, if adaptation is warranted, an adapted `output/<id>/CV.md` →
  `CV.pdf`.
- **Résumé** (asked for specifically) → author `output/<id>/resume.md` **condensed from the
  CV markdown** and tailored to the role, render it with `common/md-to-pdf.js` to
  `resume.pdf` (it picks `templates/resume.html` from the filename; pass `--role` to tailor
  the title line), and attach that. The Markdown is the durable artifact (surfaced in the
  dashboard); the PDF is transient and may be discarded after upload.

If the form asks for a Résumé but none has been authored yet, the adapter emits
`needs-resume` and does **not** attach the CV to the résumé slot — author the résumé, then
re-run. `answers.json` carries `resume_upload` (the file to attach) and `resume_doc_type`
(`"cv"` | `"resume"`, for auditing / the dashboard).

## Adapter contract

A portal adapter should:
1. Take `--url` (and, for apply, `--answers`/`--outDir` or `--id`).
2. Fill from `answers.json`; never invent data.
3. Detect the résumé/CV upload field and honor the CV-vs-Résumé rule above.
4. Stop before submit; emit `EVENT` lines + a `*-state.json`; wait on a signal file.
5. Emit the same job shapes the DB expects (`source` + `source_job_id`) when it also does
   search/detail.

### Per-site quirks

- **linkedin** — the logged-in DOM is fully obfuscated (hashed CSS classes); scripts rely
  on accessible labels/roles and anchors like the "About the job" heading, not classes.
  The résumé is *selected* from LinkedIn's already-uploaded files by `cv_filename_hint`
  (a radio), not uploaded fresh.
- **bamboohr** — custom "Fabric" dropdowns reject Playwright's native `selectOption`
  (Address is left to the human); Country/State use hidden native `<select>`s that do
  accept it; there is a `g-recaptcha-response` the human solves and a `nickname_hpcsaf`
  honeypot that must be left blank.
- **teamtailor** — a cookie wall covers the page and swallows the first click, so it must
  be dismissed before anything else is reachable. APPLY opens an in-page Stimulus overlay
  (`click->careersite--jobs--form-overlay#showFormOverlay`), not a `/applications/new` URL.
  Fields are Rails-named (`candidate[first_name]`, `candidate[answers_attributes][N][…]`),
  which brings two traps:
  - **Consent** renders a hidden `value="0"` input *before* the real checkbox, sharing the
    name `candidate[consent_given]` — match on `input[type=checkbox]`, or you check nothing.
  - **Dropdown questions** (`forms--inputs--choice` with `show-as-dropdown-value="true"`)
    keep their radios `sr-only` and *outside* the panel, so `label[for=…]` is never
    clickable. Open the trigger and click the panel's `<button data-search-text="…">`, and
    let the controller check the radio: forcing `checked` leaves the component's own
    `required` validation input empty and the form rejects the submit with "You must select
    an option". Plain (non-dropdown) choice groups are clicked by label as usual.

  Screening questions are matched on **wording, not `answers_attributes` index** — those
  indices are positional and shift when the posting is edited. The question wording is
  anchored on the group's hidden input, which sits higher in the DOM than the choice
  inputs; walking up from a choice input yields only the choice labels. Every choice click
  is confirmed with `isChecked()` before being reported as filled.
