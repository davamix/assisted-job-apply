# Architecture

This document explains how `assisted-job-apply` is built and the techniques that make it work
against LinkedIn's obfuscated UI. For setup/usage see the top-level [README](../README.md).

## Design principles

1. **Human-in-the-loop.** The apply driver fills forms but never submits without an explicit
   `APPROVE` signal from you. This is the core safety guarantee.
2. **Reuse a real session, never store the password.** You log in manually once; Playwright saves
   the session cookies (`storageState`) and reuses them.
3. **Obfuscation-proof selectors.** LinkedIn's logged-in DOM uses hashed class names and no stable
   `id`/`role`/`data-*` on containers. So the scripts target **accessible labels & roles**, **stable
   text anchors**, and **runtime-injected `data-ez-*` attributes** — never CSS class names.
4. **Separation of concerns.** Browser automation is Node/Playwright; the datastore is Python/SQLite.
   They communicate through JSON files, so either side can be swapped or scripted independently.

## Components

### Session (`linkedin-login.js`, `linkedin-verify.js`)
`login` launches a **headed** browser at the LinkedIn login page and polls for the `li_at` session
cookie (so it transparently handles 2FA). Once present, it saves `context.storageState()` to
`.auth/linkedin-state.json`. Every other script loads that file via
`browser.newContext({ storageState })`. `verify` loads it and confirms the feed is reachable.

### Search (`linkedin-search.js`)
Builds a Jobs search URL from CLI flags (`keywords`, `location`, `geoId`, `f_WT=2` for remote,
`f_TPR` for date posted, `start` for pagination), scrolls the virtualized results list to load
cards, then extracts `{ source_job_id, role, company, location, url }` per card. Job ids come from
the stable `data-occludable-job-id` / `data-job-id` attribute or the `/jobs/view/<id>` href.

### Ingest (`db/ingest_search.py`)
Reads a search's JSON array and upserts each row as `status=found`, parsing the country out of the
location string. Dedups on `(source, source_job_id)`.

### Triage (`linkedin-job-detail.js`)
Opens a single posting and extracts, **without relying on class names**:
- **Description** — finds the element whose text is exactly *"About the job"* (or localized
  equivalents) and takes its next sibling's text (the description body). Falls back to the largest
  cohesive text block, skipping recommendation/promo chrome.
- **Apply type** — reads the primary `<button>`'s `aria-label` (`Easy Apply to this job` →
  `easy_apply`; otherwise `external`). Detects `closed` and `already_applied` from page text.
- **Salary hint** — regex over the description for currency/pay patterns.

### Apply driver (`linkedin-easyapply.js`)
The most involved component. A step loop drives the multi-page Easy Apply modal:

1. **Locate the modal & enumerate fields.** In-page, it finds the modal root (nearest ancestor of a
   footer action button that also contains a heading), tags it `data-ez-root`, and enumerates every
   input/select/textarea (tagged `data-ez-field`) and radio group / `<fieldset>` (tagged
   `data-ez-group` / `data-ez-choice`) **within that root** — so the page's nav search box is never touched.
2. **Fill from answers.** A `RULES` array maps label regexes to answer keys
   (`resolveAnswer(label, answers)`). Text/number fields are `fill()`ed; `<select>`s are matched by
   option text (with **Yes↔Sí** synonym handling); radio groups read their question from the
   fieldset's preceding sibling and answer by clicking the **visible label** (LinkedIn's real
   `<input>`s are hidden, so a label click is what registers in React).
3. **Resume & cover letter.** Explicitly selects the intended CV by filename hint (LinkedIn defaults
   to the most-recently-uploaded file, which may be wrong), and uploads a cover-letter PDF via the
   file chooser when — and only when — the form has a cover-letter slot.
4. **Advance detection.** After clicking *Next/Review* it compares a **signature of the page's field
   set** before/after (not the heading, since consecutive pages reuse "Apply to X" + a "Next"
   button). Same signature ⇒ a required field is blocking ⇒ it records `needs_input` and pauses.
5. **Review gate.** On the final page it unchecks "Follow \<company\>", screenshots the review,
   writes `state.json = ready_for_approval`, and polls `signalDir` for `APPROVE` / `ABORT`.
6. **Submit / abort.** On `APPROVE` it clicks through any remaining steps until *Submit application*,
   submits, verifies the confirmation, and writes `state.json = applied`. Safe fallbacks: unknown
   Yes/No questions are left unanswered (pausing for a human) rather than guessed — **except**
   clearly-worded conflict/compliance questions, which default to "No".

Events are emitted as `EVENT {json}` lines to stdout and mirrored into `state.json`, so an
orchestrator (or you) can watch progress and read the filled-field log.

### PDF rendering (`md-to-pdf.js`)
Markdown → HTML (`markdown-it`) → PDF using the Chromium that Playwright already ships
(`page.pdf()`), with print CSS tuned for a clean, ATS-friendly one-column resume/letter. No LaTeX,
pandoc, or system PDF tooling required.

### Datastore (`db/jobs_db.py`)
Standard-library `sqlite3`. Single `jobs` table with an internal auto-increment `id` (also the
`output/<id>/` folder name) and `UNIQUE(source, source_job_id)` for dedup. `upsert` only writes the
keys you provide (never clobbers existing values with nulls). All output is UTF-8 JSON so callers
can parse it. Verbs: `init | upsert | get | list | set-status`.

## Data flow (files as the interface)
`search.js` → JSON → `ingest_search.py` → **DB**; `job-detail.js` → JSON (your judgment) → **DB**;
you author `output/<id>/answers.json` (often derived from `config/profile.json`) → `easyapply.js`
reads it, writes screenshots + `state.json`, waits for your `APPROVE`/`ABORT` file → you record the
result in the **DB**.

## Extending it
- **New questions:** add a `{ re, key }` entry to `RULES` in `linkedin-easyapply.js` and the matching
  key to your answers.
- **New job board:** the DB is portal-agnostic (`source` + `source_job_id`). Add a `<board>-search.js`
  + `<board>-easyapply.js` that emit the same JSON shapes; the DB layer is unchanged.
- **When a selector breaks:** open the page headed, run a small `page.evaluate` probe that dumps
  candidate elements' tag/text/attributes (the approach used to build these scripts), and update the
  anchor — prefer accessible text/roles over class names.
