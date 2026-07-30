# assisted-job-apply

A **human-in-the-loop** assistant that helps you search LinkedIn Jobs and fill in **Easy Apply**
applications with your own data — then **pauses and waits for your explicit approval before it
ever submits anything**. It drives a real browser with [Playwright](https://playwright.dev),
triages postings against your profile, drafts cover letters, and keeps a local SQLite record of
everything.

> ⚠️ **Disclaimer** — This automates **your own** LinkedIn account using your own session.
> Automated access may conflict with LinkedIn's User Agreement and could lead to account
> restrictions. Use it responsibly, at a modest volume, and entirely at your own risk. It is a
> personal productivity aid, not a mass-application bot. No submission ever happens without you
> approving it first.

---

## Contents

- [What it does](#what-it-does) — the pitch, and what it deliberately won't do
- [How it works](#how-it-works) — the pipeline, end to end
- [Adapters](#adapters) — the job portals it can drive
- [Repository layout](#repository-layout) — what every file is
- [Prerequisites](#prerequisites)
- [Setup](#setup) — install, your profile, your CV, your searches, the database
- [Usage](#usage) — login → search → triage → prepare → apply
  - [The approval protocol](#the-approval-protocol) — how the driver pauses for you
- [Dashboard (web UI)](#dashboard-web-ui) — local view over your applications
- [Configuration](#configuration) — `config/profile.json` and `config/search.json`
- [Database](#database) — the SQLite record and its CLI
- [Customization](#customization) — tuning it to your own search
- [Limitations & troubleshooting](#limitations--troubleshooting)
- [Changelog](#changelog)
- [License](#license)

---

## What it does

- 🔐 **Log in once** in a real browser; the session is reused so your password is never stored or scripted.
- 🔎 **Search** LinkedIn Jobs (remote, date-posted, location filters) and scrape the result cards.
- 🗃️ **Store** every job in a portal-agnostic **SQLite** database (dedup, status tracking).
- 🔬 **Triage** each posting: full description, Easy-Apply vs. external, open/closed, already-applied, salary hints.
- ✍️ **Prepare** a tailored cover letter, and the right document to attach: your **CV**, or a
  **Résumé** created on demand (shorter, US-style, tailored to the role) when a form asks for one.
- ✅ **Apply** through the multi-step Easy Apply form — filling contact info, screening questions,
  compliance attestations, selecting the right resume, uploading a cover letter — then **stopping at
  the review page for your approval**.
- 🏢 **External ATS portals** (BambooHR, Teamtailor, Bizneo, Workable, Workday, Greenhouse and Viterbit today) have
  their own *apply adapters* that fill the company form and pause for you to review and submit — same
  never-auto-submit rule. See [Adapters](#adapters).

## How it works

```
config/search.json ─▶ linkedin/search.js ─▶ ingest_search.py ─▶ [ SQLite: found ]
                                                                        │
                                                     linkedin/job-detail.js (triage)
                                                                        │  (you decide fit)
                                                                        ▼
              templates/ ▶ common/md-to-pdf.js ◀─ cover letter / CV / résumé ─ [ prepared ]
                                                                        │
                              linkedin/easyapply.js  ·OR·  <site>/apply.js (headed)
                                                        fills every step … then PAUSES
                                                                        │
                                          you review screenshot ▶ create APPROVE / ABORT / CLOSE
                                                                        │
                                                                 [ applied ] ─▶ SQLite
```

The apply driver **never clicks the final Submit on its own**. It fills the form, screenshots the
review page, writes `output/<jobId>/state.json`, and polls for a signal file you create.

## Adapters

Scripts are organized as per-site **adapters** (`scripts/<site>/`) over shared `scripts/common/`
utilities. LinkedIn drives the whole pipeline; external ATS portals are reached through the
"Apply on company website" link found during triage, so they implement **apply only**. Every
adapter obeys the same contract: fill from `answers.json`, never invent data, verify each field,
screenshot, and **stop before submit**.

| Portal | Capabilities | Run it |
|---|---|---|
| **LinkedIn** | session · search · triage · apply | `npm run login` · `search` · `detail` · `apply` |
| **BambooHR** | apply | `npm run apply:bamboohr -- --url <careers-url> --id <dbId>` |
| **Teamtailor** | apply | `npm run apply:teamtailor -- --url <careers-url> --id <dbId>` |
| **Bizneo** | apply | `npm run apply:bizneo -- --url <careers-url> --id <dbId>` |
| **Workable** | apply | `npm run apply:workable -- --url <careers-url> --id <dbId>` |
| **Greenhouse** | apply | `npm run apply:greenhouse -- --url <apply-url> --id <dbId>` |
| **Viterbit** | apply | `npm run apply:viterbit -- --url <apply-url> --id <dbId>` |
| **Workday** | session (per tenant) · apply | `npm run login:workday -- --tenant <tenant-url>`, then `npm run apply:workday -- --url <job-url> --id <dbId>` |

Worth knowing before you use one:

- **Workday needs an account**, unlike the others, and it is **per tenant** — an account with one
  employer does not work for another, so each gets its own `.auth/workday-<tenant>-state.json`.
  It also keeps your résumé on the *candidate profile* rather than the application, so re-running
  appends duplicates; the adapter skips re-uploading a file it already finds attached.
- **BambooHR** leaves Address/ZIP to you and has a reCAPTCHA you solve before submitting.
- **Teamtailor** hides a cookie wall in front of the form and opens the application as an in-page
  overlay; its dropdowns reject a forced value and will block the submit if faked.
- **Bizneo** is a public form (no login). Its Country/City are select2 widgets — City is a *remote
  autocomplete*, and setting the native value never fires the country→city cascade — and the dates
  use a JS datepicker, so the adapter drives all three through their real UI, not raw values. It
  also supports `--dryRun` (headless, no human gate) to validate a fill end to end.
- **Workable** is a public form (no login). Its "Salary expectations" is a *formatted-number* field
  (takes a plain integer — `65000` renders as `65.000`), the phone is an intl-tel-input widget, and
  the "Resume" upload genuinely asks for a résumé, so it gets a tailored one rather than the full CV.
  Also supports `--dryRun`. Its **Submit is gated by a Cloudflare Turnstile** — see the next note.
- **Greenhouse** is a public form (no login). The application lives **inside an iframe** on the company
  careers page (e.g. `careers.<company>.com/…/apply/?gh_jid=<id>`, pointing at Greenhouse's board —
  Fever's is the EU board), so the adapter finds that frame and fills inside it. Its select questions
  are **react-select comboboxes** (the chosen value shows in a `.select__single-value`, not the input),
  the privacy authorization is a required single-option combobox, and the "Country" field is the phone
  widget's dial-code selector. The "Resume/CV" slot takes the full CV; the cover letter is optional and
  left blank. Supports `--dryRun`. Its **Submit is gated by an invisible reCAPTCHA Enterprise** — see the
  next note.
- **Viterbit** is a Spanish ATS that runs on the company's *own* careers domain (e.g.
  `talento.between.tech`) — the "Hiring with Viterbit" footer is the only reliable tell. Public form, no
  login, at the `/apply/` sub-path of the job page. Two things make it unlike the others: **Cloudflare
  challenges the page load rather than the submit**, so the adapter runs a real headed browser by default
  and there is no headless dry run; and its **radio questions arrive pre-checked on the first option**, so
  an unanswered radio still submits an answer — the adapter sets every radio explicitly and reports any it
  could not match along with the value the site would have sent. City is an AJAX-backed select2 with no
  static options. Supports `--dryRun` (still opens a window; it just skips the review pause).
- **Some portals gate the final Submit with an anti-bot challenge** (Cloudflare Turnstile, hCaptcha,
  reCAPTCHA) that rejects Playwright's bundled Chromium by its automation fingerprint, so the "Verify
  you are human" checkbox fails no matter how you click it. The fix is to make the driven browser
  trustworthy: the **Workable** and **Greenhouse** adapters strip the automation tells at launch and accept
  **`--channel msedge`** (or `chrome`) to drive a real installed browser, which clears the challenge —
  the same fix ports to any other adapter when a portal needs it. If a hardened challenge still blocks,
  just finish that one submit in your own everyday browser (nothing is lost for a no-login form). First
  hit on Workable (Turnstile); Greenhouse uses an invisible reCAPTCHA; assume any portal can do it.
- Most portals ship a `probe-fields.js` — read-only reconnaissance that enumerates a form and its
  screening questions so a job's `answers.json` can be written against what the page really is.

[scripts/README.md](scripts/README.md) has the capability matrix, the adapter contract, and the
full per-site quirk list — read it before adding a portal.

## Repository layout

| Path | What it is |
|------|-----------|
| `scripts/linkedin/login.js` | One-time manual login; saves the session to `.auth/`. |
| `scripts/linkedin/verify.js` | Sanity-check that the saved session still works. |
| `scripts/linkedin/search.js` | Scrape one job search into JSON. |
| `scripts/linkedin/job-detail.js` | Fetch one job's full detail for triage. |
| `scripts/linkedin/easyapply.js` | Fill an Easy Apply form and pause for approval. |
| `scripts/bamboohr/apply.js` | Fill a BambooHR external form and pause for you to submit. |
| `scripts/teamtailor/apply.js` | Fill a Teamtailor external form and pause for you to submit. |
| `scripts/bizneo/apply.js` | Fill a Bizneo external form and pause for you to submit. |
| `scripts/workable/apply.js` | Fill a Workable external form and pause for you to submit. |
| `scripts/greenhouse/apply.js` | Fill a Greenhouse external form and pause for you to submit. |
| `scripts/viterbit/apply.js` | Fill a Viterbit external form and pause for you to submit. |
| `scripts/workday/login.js` · `verify.js` | Per-tenant Workday candidate session → `.auth/`. |
| `scripts/workday/apply.js` | Walk Workday's 5-step wizard and stop at Review. |
| `scripts/<site>/probe-fields.js` | Read-only recon of a form, to build its `answers.json`. |
| `scripts/common/md-to-pdf.js` | Render a Markdown CV/résumé/letter to PDF (via Chromium + `templates/`). |
| `scripts/common/md-to-text.js` | Flatten a Markdown letter to prose for a cover-letter textarea. |
| `templates/` | HTML + CSS for the rendered PDFs (`cv.html`, `resume.html`, `letter.html`) — all styling lives here, plus how and when to use each document. |
| `scripts/common/classify-doc-field.js` | Classify an upload field as asking for a CV vs a Résumé. |
| `scripts/README.md` | Script layout, capability matrix, and the per-site adapter contract. |
| `db/jobs_db.py` | SQLite data layer + CLI. |
| `db/ingest_search.py` | Load search JSON into the database. |
| `web/app.py` | Local web **dashboard** over the database (stdlib only). |
| `config/search.json` | Your searches + filters (committed example). |
| `config/profile.example.json` | Template for your answers → copy to `config/profile.json`. |
| `assets/` · `output/` · `data/` | Personal files — **git-ignored**; each has a README describing its contents. |
| `.auth/` | Your LinkedIn session token — **git-ignored, secret**. |
| `docs/ARCHITECTURE.md` | Deeper design notes. |

## Prerequisites

- **Node.js 18+** and **Python 3.10+**
- A LinkedIn account

## Setup

```bash
# 1. Install dependencies
npm install
npx playwright install chromium        # download the browser Playwright drives

# 2. Your answers
cp config/profile.example.json config/profile.json
#   edit config/profile.json — name, email, phone, city, links, experience, work auth, salary…

# 3. Your CV (see assets/README.md for the expected files)
#   put CV.pdf (ATS-friendly) and optionally CV.md into assets/
#   and point config/profile.json → default_cv_pdf at it

# 4. Your searches
#   edit config/search.json (keywords, location, geoId, remote, date range)

# 5. Create the database
python db/jobs_db.py init
```

> Python note: the DB layer is **standard-library only** (`sqlite3`) — no `pip install` needed.
> A virtualenv is optional; if you use one, create it with `python -m venv .venv`.

## Usage

Run everything **from the project root** (so Node resolves `node_modules`).

**1. Log in (once):**
```bash
node scripts/linkedin/login.js
# a browser opens — log in manually (incl. 2FA). The session saves to .auth/linkedin-state.json.
node scripts/linkedin/verify.js        # optional: confirm it works
```

**2. Search and store:**
```bash
node scripts/linkedin/search.js --keywords ".NET AI Engineer" \
     --location "Spain" --geoId 105646813 --tpr r604800 --remote --max 25 \
     --out search.json
python db/ingest_search.py --file search.json --tag ".NET + AI/RAG"
```
- `--tpr` = date posted: `r86400` (24h), `r604800` (past week).
- `--geoId` = LinkedIn's location id. Find it by running a Jobs search in your browser and copying
  the `geoId=` value from the URL (e.g. Spain = `105646813`).
- Add `--headed` to watch the browser; omit for headless.

**3. Triage a job:**
```bash
node scripts/linkedin/job-detail.js --id <linkedinJobId>
# returns description, apply_type (easy_apply | external | closed | already_applied), salary hint…
```
Decide fit, then record it, e.g.:
```bash
python db/jobs_db.py set-status --id <dbId> --status skipped --notes "below salary floor"
```

**4. Prepare artifacts** (optional): write `output/<dbId>/Cover letter.md`, then
```bash
node scripts/common/md-to-pdf.js --in "output/<dbId>/Cover letter.md" --out "output/<dbId>/Cover letter.pdf"
```
Write only the letter itself — the letterhead (name, contacts, date) is generated from
`config/profile.json`, and the template is picked from the filename.

If a form asks specifically for a **Résumé** (not a CV), write a shorter, role-tailored
`output/<dbId>/resume.md` (condensed from your CV) and render it the same way to `resume.pdf`
(add `--role "…"` to tailor its title line); point `answers.json` → `resume_upload` at that PDF.
If it asks for a **presentation letter** instead of a cover letter, render the reusable
`assets/presentation-letter.md`. See [templates/README.md](templates/README.md) for which document
to use when, and [scripts/README.md](scripts/README.md) for the adapter contract.

**5. Apply (human-gated):**
```bash
node scripts/linkedin/easyapply.js --id <linkedinJobId> \
     --answers "output/<dbId>/answers.json" --signalDir "output/<dbId>"
```
It opens a **visible** browser, fills every step, and stops at the review page. Watch it, check
`output/<dbId>/review.png`, then:
```bash
# approve and submit:
touch "output/<dbId>/APPROVE"
# or discard without submitting:
touch "output/<dbId>/ABORT"
```
On success it screenshots the confirmation. Record it:
```bash
python db/jobs_db.py set-status --id <dbId> --status applied --notes "…"
```

### The approval protocol
`linkedin/easyapply.js` writes `output/<jobId>/state.json` with a `status`:
- `ready_for_approval` — everything filled; waiting for you.
- `needs_input` — a required field it couldn't answer; complete it in the live browser, then `APPROVE`.
- `applied` / `aborted` / `timeout` — terminal.

It polls for `APPROVE`/`ABORT` for `--timeoutMs` (default 15 min). See `output/README.md` for every artifact.

## Dashboard (web UI)

A small, local web view of the database — see every job at a glance, open its documents, filter, and
**track each application through the interview process**:

```bash
python web/app.py                 # then open http://127.0.0.1:8000
#   --port 8000   change the port
#   --host 127.0.0.1  bind address (keep it local — it serves your personal DB and docs)
```

- **Filter** by status, market (`search_tag`), country, source, or a role/company text search; the
  summary chips show live counts per status (click one to filter).
- **Documents** — direct links to each job's cover / presentation letters, any tailored CV, and an
  on-demand **Résumé** when one was created (a `.md` links its rendered `.pdf` when present); your
  base CV in `assets/` is linked in the header. Apply screenshots show up as 📎 evidence.
- **Track status** — an inline dropdown changes a job's status through the funnel:
  `found → prepared → applied → screening → call / technical / final interview → offer → accepted`,
  with `rejected` / `withdrawn` / `on-hold` as outcomes. Notes are editable inline. Changes write
  straight to `data/jobs.db` (same validation as the CLI), so the dashboard and `jobs_db.py` stay in
  sync. Stdlib only — no `pip install`, no build step.

## Configuration

- **`config/profile.json`** (from the example) — all the answers used to fill forms: identity,
  location, links, years of experience, work authorization, salary floor, languages, screening
  answers, and `compliance_defaults` (how conflict-of-interest / privacy-policy questions are
  answered by default). Git-ignored.
- **`config/search.json`** — a list of searches (`tag`, `keywords`) plus shared `defaults`
  (`remote`, `datePostedDays`, `maxPerSearch`, `locations` with `geoId`).

## Database

SQLite at `data/jobs.db`, managed by `db/jobs_db.py` (`init | upsert | get | list | set-status`).
Portal-agnostic schema so other job boards can be added later. Full schema + CLI in `data/README.md`.

## Customization

- **Form field matching** lives in `scripts/linkedin/easyapply.js` as a `RULES` array (label
  regex → answer key). Add rules for questions specific to your field.
- **Adding a job board** — scripts are organized as per-site *adapters* (`scripts/<site>/`) over
  shared `scripts/common/` utilities. See [Adapters](#adapters) for what exists today and
  [scripts/README.md](scripts/README.md) for the layout, capability matrix, and adapter contract;
  `scripts/teamtailor/` is a compact worked example (probe + apply, no session).
- **Compliance defaults** (all conflict questions → "No", accept policy, "found via LinkedIn",
  never auto-follow the company) are applied automatically and shown on the review screen before you approve.
- **Headed vs. headless**: search/detail default to headless; the apply driver is headed so you can watch.

## Limitations & troubleshooting

- LinkedIn's logged-in DOM is **heavily obfuscated** (hashed class names). The scripts rely on
  accessible labels/roles and stable text anchors, but LinkedIn changes its UI often — if a
  selector breaks, the diagnostic pattern in `docs/ARCHITECTURE.md` shows how to inspect and fix it.
- **External application sites** — [supported portals](#adapters) have an *apply adapter* under
  `scripts/<site>/` (BambooHR, Teamtailor, Bizneo, Workable, Workday, Greenhouse, Viterbit). Anything else (Lever, …) is
  logged for you to complete manually. Adapters fill the form and pause — you review and submit (never
  auto-submitted).
- **"Verify you are human" fails at submit** — a Cloudflare Turnstile / reCAPTCHA (or similar) is rejecting
  the automated browser. Re-run an adapter that supports it (Workable, Greenhouse today) with **`--channel
  msedge`** (or `chrome`) to drive a real installed browser; if it still blocks, finish that submit in your
  own everyday browser. See [Adapters](#adapters).
- **The form never appears at all, just "Verificación de seguridad en curso"** — the same challenge, but
  guarding the *page load* (Viterbit does this). No headless browser clears it; the adapter already runs
  real headed Edge, so if it still hangs, open the apply URL in your own browser and fill from the values
  in `output/<id>/answers.json`.
- If the LinkedIn session expires, re-run `linkedin/login.js`; for Workday, re-run
  `workday/login.js --tenant <tenant-url>` (`workday/verify.js` tells you whether it is still good).
- Run scripts from the project root; if you must run from elsewhere, set `NODE_PATH` to the project's `node_modules`.

## Changelog

Newest first. Entry format: `### YYYY-MM-DD — Specific title`, followed by its PR link where there
is one, then one bullet per notable change — not one per commit.

### 2026-07-30 — Viterbit adapter

- **Viterbit supported** — `scripts/viterbit/apply.js`. A Spanish ATS that serves each customer on their own careers domain (the *"Hiring with Viterbit"* footer is the tell, not the hostname); public form, no login, at the `/apply/` sub-path of the job page. Symfony-named fields (`apply[…]`), identity by name, screening questions by `question_id` with label-wording fallback, city driven as an AJAX-backed select2 with no static options, and the upload's real prompt read from the `.form-group` label ("Curriculum" → CV) rather than Bootstrap's empty filename `<label>`.
- **Cloudflare gates the page load, not the submit** — a first for this project. Bundled Chromium fails it in either mode and even real Edge fails it *headless*, so the adapter defaults to `channel: 'msedge'` + `headless: false` and waits out the interstitial by polling the page title. `--dryRun` still opens a window; it only skips the review pause.
- **Radio questions arrive pre-checked on their first option**, so leaving one alone silently submits an answer the candidate never gave — the opposite of a blank text field. Every radio is now set explicitly from `answers.json`, and an unmatched one is reported in `pending` together with the value the site would have posted. `answers.screening[]` gained an optional `verify` note for answers a human should confirm on screen.

### 2026-07-18 — Greenhouse adapter ([#10](https://github.com/davamix/assisted-job-apply/pull/10))

- **Greenhouse supported** — `scripts/greenhouse/apply.js`. A public application form (no login) served **inside an iframe** on the company careers page (`careers.<company>.com/…/apply/?gh_jid=<id>`, pointing at a Greenhouse board — the EU board `job-boards.eu.greenhouse.io` in this case); the adapter locates that frame and fills inside it. Identity fields by stable id, custom questions by `question_<id>` (falling back to label wording), and select questions driven as **react-select comboboxes** — the chosen value renders in a `.select__single-value`, not the input, so that is where the fill is verified. The privacy authorization is a required single-option combobox; the "Country" field is the phone widget's dial-code selector. The "Resume/CV" slot takes the full CV and the optional cover letter is left blank. Ships `probe-fields.js` + `probe-selects.js` recon and supports `--dryRun`.
- **Submit gated by an invisible reCAPTCHA Enterprise** — no visible checkbox; it scores the browser when you click Submit. The adapter ships the anti-automation launch flags always-on and takes `--channel msedge`, same as Workable's Turnstile.

### 2026-07-17 — Workable adapter ([#9](https://github.com/davamix/assisted-job-apply/pull/9))

- **Workable supported** — `scripts/workable/apply.js`. A public application form (no login) reached via the LinkedIn "Apply on company website" link. Identity fields by name; custom questions (e.g. "Salary expectations", a formatted-number field) matched by label wording; intl-tel-input phone; visually-hidden `gdpr` consent. The "Resume" upload correctly attaches a tailored résumé, not the full CV. Supports `--dryRun`.
- **Bot-detection at submit, documented as cross-cutting** — some portals gate the final Submit with a Cloudflare Turnstile/hCaptcha/reCAPTCHA that rejects Playwright's bundled Chromium. The Workable adapter strips the automation tells at launch and accepts `--channel` (e.g. `msedge`) to drive a real installed browser (the pattern ports to the others); fallback is to finish that submit in your own browser.

### 2026-07-16 — Bizneo adapter ([#7](https://github.com/davamix/assisted-job-apply/pull/7))

- **Bizneo supported** — `scripts/bizneo/apply.js`. A public application form (no login) reached via the LinkedIn "Apply on company website" link.
- Country/City are **select2** widgets driven through their real UI: setting the native value never fires the country→city cascade, and City is a **remote autocomplete** with no static option list. The dates use a JS datepicker, and the visually-hidden consent checkbox needs `check({ force: true })`.
- Adds a `--dryRun` mode (headless, no human gate) to validate a fill end to end.

### 2026-07-15 — Workday adapter ([#4](https://github.com/davamix/assisted-job-apply/pull/4))

- **Workday supported** — `scripts/workday/`: `login.js` / `verify.js` for a **per-tenant** candidate session, `apply.js` to walk the 5-step wizard and stop at Review, `probe-fields.js` for recon. First portal needing an account.
- Workday keeps your **résumé on the candidate profile**, not the application, and the widget appends — re-running stacked duplicate CVs. The adapter now skips uploading a file it already finds attached.
- `login.js` and `verify.js` share one signed-in probe requiring **positive evidence**: an earlier version read "no Sign In button" as success and saved an anonymous session.

### 2026-07-15 — Teamtailor adapter ([#3](https://github.com/davamix/assisted-job-apply/pull/3))

- **Teamtailor supported** — `scripts/teamtailor/apply.js` + `probe-fields.js`. Handles the cookie wall, the in-page Stimulus form overlay, and Rails-named fields.
- Screening questions are matched on **question wording, not field index**, so a re-ordered posting fails loudly instead of filing the right answer under the wrong question.
- Every choice is confirmed with `isChecked()` before being reported as filled — two bugs shipped as *false successes* (an unticked consent box, an unset location) that would have blocked the submit.
- `common/md-to-text.js` added: letters are authored in Markdown, but a cover-letter textarea takes prose.

### 2026-07-15 — HTML templates for rendered documents ([#2](https://github.com/davamix/assisted-job-apply/pull/2))

- **All PDF styling now lives in [`templates/`](templates/)** (`cv.html`, `resume.html`, `letter.html`); `md-to-pdf.js` holds none. Edit the CSS there and re-render — no code change.
- **The letterhead is generated**, not authored: name, role, contacts and date come from `config/profile.json` at render time. Write documents *without* a name/contact header or you get it twice.
- **Presentation letters** (letters of introduction) added as a document type — reusable, kept at `assets/presentation-letter.md`, rendered through `letter.html`.
- Fixed: cover letters lost paragraph spacing and their signature line breaks in PDF; every `ASP.NET` / `VB.NET` on a CV rendered as a dead link (`.NET` is a real TLD); phone numbers split across lines.
- Documents produced before this keep their own headers and are left alone as historical records.

### 2026-07-14 — CV vs Résumé handling, per-site adapters ([#1](https://github.com/davamix/assisted-job-apply/pull/1))

- Upload fields are classified as **CV vs Résumé**; a Résumé is authored on demand (condensed from your CV, tailored to the role) and the CV is never substituted into a Résumé slot.
- `scripts/` reorganized into `common/` plus one folder per job portal; BambooHR apply adapter added.

### 2026-07-13 — Local web dashboard

- `web/app.py` serves a local dashboard over `data/jobs.db`: filter by status/market/country, move jobs through the status funnel, edit notes inline, and open each job's generated documents.

### 2026-07-13 — Initial public release

- LinkedIn job search, triage, and human-gated Easy Apply — the driver fills every step, screenshots the review page, and waits for your approval. Nothing is ever submitted on its own.

## License

[MIT](LICENSE).
