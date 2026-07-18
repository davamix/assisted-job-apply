# scripts/

Automation scripts, organized as **site-agnostic common utilities** plus **one folder per
job portal**. The tool started LinkedIn-only and now supports external ATS portals
(BambooHR, Teamtailor, Bizneo, Workable, Workday and Greenhouse, with Lever likely to
follow), so each portal is an *adapter* implementing only the capabilities it supports.

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
  bizneo/                    # Bizneo ATS external-apply adapter (apply only)
    apply.js
  workable/                  # Workable ATS external-apply adapter (apply only)
    apply.js
  greenhouse/                # Greenhouse ATS external-apply adapter (apply only)
    apply.js
    probe-fields.js  probe-selects.js   # reconnaissance used to build a job's answers.json
  workday/                   # Workday external-apply adapter (session + apply)
    login.js  verify.js      # per-tenant candidate session -> .auth/workday-<tenant>-state.json
    session.js               # shared "is this session signed in?" probe
    apply.js                 # walks the 5-step wizard, stops at Review
    probe-fields.js          # reconnaissance used to build a job's answers.json
```

Run everything from the repo root (`f:\JobSearch`) so `output/`, `assets/`, `config/`,
`.auth/` resolve. The npm aliases in `package.json` wrap the common invocations
(`npm run login|verify|search|detail|apply|apply:bamboohr|apply:teamtailor|apply:bizneo|apply:workable|apply:greenhouse|apply:workday|pdf`).

## Capability matrix

| Site       | session (login/verify) | search | job-detail (triage) | apply (fill + human gate) |
|------------|:----------------------:|:------:|:-------------------:|:-------------------------:|
| linkedin   | ✓                      | ✓      | ✓                   | ✓                         |
| bamboohr   | –                      | –      | –                   | ✓                         |
| teamtailor | –                      | –      | –                   | ✓                         |
| bizneo     | –                      | –      | –                   | ✓                         |
| workable   | –                      | –      | –                   | ✓                         |
| greenhouse | –                      | –      | –                   | ✓                         |
| workday    | ✓ (per tenant)         | –      | –                   | ✓                         |

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

## Bot-detection at submit (Cloudflare Turnstile & friends)

Some ATS gate the **final Submit** with an anti-bot challenge — a Cloudflare **Turnstile**
"Verify you are human" checkbox, or hCaptcha / reCAPTCHA. These challenges fingerprint the
*browser*, not the data, and Playwright's **bundled Chromium advertises that it's automated**:
the `--enable-automation` launch flag, `navigator.webdriver === true`, and the
`AutomationControlled` blink feature. When the challenge sees those, the checkbox spins or
fails **no matter how the human clicks it**. First seen on **Workable's** submit step
(id 51); assume it can appear on any external portal (Greenhouse, Lever, etc. use Cloudflare
too). It is distinct from BambooHR's reCAPTCHA, which a human solves normally — here the
challenge is rejecting the *driven browser itself*.

**Greenhouse** (id 52, Fever) gates submit with an **invisible reCAPTCHA Enterprise** (a
`g-recaptcha-response` textarea + a `recaptcha.net/.../anchor` frame) — no visible checkbox;
it scores the browser silently when the human clicks **Submit application**. Same defense:
ship the anti-automation launch flags always-on (they are, in `greenhouse/apply.js`) and pass
`--channel msedge` if a click is challenged. This is the invisible cousin of BambooHR's visible
reCAPTCHA and Workable's Turnstile.

**Do not try to solve or bypass the challenge programmatically** — the human still clicks it.
The only goal is to make the driven browser trustworthy enough that the human's click is
accepted. Escalate in this order:

1. **Strip the obvious automation tells at launch.** Safe to add to any adapter; always-on
   in `workable/apply.js`:
   ```js
   const browser = await chromium.launch({
     headless: false,
     args: ['--disable-blink-features=AutomationControlled'],
     ignoreDefaultArgs: ['--enable-automation'],
   });
   const ctx = await browser.newContext({ /* … */ });
   await ctx.addInitScript(() => {
     Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
   });
   ```
2. **Drive a REAL installed browser** instead of bundled Chromium, via Playwright's
   `channel` — real browsers clear Turnstile far more often. The Workable adapter takes
   `--channel msedge` for this. On this machine **Chrome is not installed but Edge is**
   (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`), so `msedge` is the
   go-to; use `chrome` where available. (Steps 1 + 2 together got id 51 past Turnstile.)
3. **Hand the final submit to the human's own everyday browser.** If a hardened *managed*
   challenge still blocks, stop fighting it: for a public, no-login form the automation adds
   nothing but the auto-fill, so give the human the apply URL and the values to enter — the
   adapter's `*-state.json` (`filled` / `pending`) and `*-filled.png` screenshot already
   list them — and let them finish in their normal browser, where no bot-detection triggers.

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

- **bizneo** — the public application form (careers.ats.bizneo.cloud, reached via the
  LinkedIn "Apply on company website" link with `?displayed_form=true`) needs **no login**.
  Fields are Rails-named (`inscription_form[user_form][…]`), and three traps shape the adapter:
  - **Country + City are select2 widgets, not plain `<select>`s.** Setting the native value
    does not fire the `change` select2/htmx listen for, so the country→city htmx cascade
    (`hx-get=/registration/new`, swaps `#user-region-id`) never runs. Both must be driven
    through the select2 UI: open the `#select2-…-container`, type into
    `input.select2-search__field`, click the matching `li.select2-results__option`.
  - **City (`region_id`) is a select2 *remote* autocomplete** (`data-url=/suggest/locations`,
    `data-minimum-input-length=3`) — there is no static option list. Type ≥3 chars and pick
    from the AJAX results (e.g. "Barcelona, Barcelona, Cataluña, España").
  - **The "Disponibilidad" dates use air-datepicker**: the submitted value lives on a hidden
    real `<input>` (`data-component-datepicker="date"`), mirrored by a readonly visible one.
    Click the visible field and the calendar's `.air-datepicker-cell.-current-` for "today",
    else force-fill the real input with a `DD/MM/YYYY` string. "Disponibilidad hasta" is
    required but odd for a permanent, open-ended candidate — the adapter leaves it blank
    (only fills it from an explicit `availability_to`) and the human picks it at review.
  - **Consent** is a Rails checkbox preceded by a hidden `value="0"` input sharing its name,
    *and* the real checkbox is visually hidden (`opacity:0`, 1px, absolute) with the click
    surface on its `<label>`, so a plain `.check()` sees it as non-actionable — use
    `check({ force: true })` (which also avoids the privacy-policy `<a>` inside the label).

- **workable** — the public application form
  (`apply.workable.com/<company>/j/<shortcode>/apply/`) is a React SPA reached via the
  LinkedIn "Apply on company website" link (which lands on the *job* page; the form lives
  at the `/apply/` sub-path — the adapter normalizes either URL). No login. It is a light
  form, but four things shape the adapter:
  - **Standard fields carry stable `name`s** (`firstname`, `lastname`, `email`, `phone`),
    so identity is filled by name. Custom/screening questions are named `CA_<id>`
    (job-specific), so they are matched by **label wording** from `answers.screening[]`,
    never by a hardcoded name.
  - **"Salary expectations" is a formatted-number field**, not free text: it strips
    non-digits and formats with a dot thousands separator, and it treats `,` as a decimal
    (so `"From 65,000 EUR"` collapses to `"65,00"`). Send a **plain integer** — `65000`
    renders as `65.000`. "Negotiable / from …" can't live here; carry that in the follow-up.
  - **Phone is an intl-tel-input widget.** Fill the full `+34 …` value and the widget
    detects the country (the flag flips to Spain, the visible field keeps the national
    part); typing only the national number inherits whatever flag is selected.
  - **The CV/résumé slot's label sits ABOVE the drop-zone** in a `[class*="label"]` element
    (e.g. "* Resume"), with the "*" required marker split into its own node — read/**join**
    those fragments before classifying, or you only capture "*", fall through to `unknown`,
    and wrongly attach the CV. On Workable the slot is genuinely **"Resume"**, so the
    CV-vs-Résumé rule correctly attaches a tailored `output/<id>/resume.pdf`, not the CV.
    Consent is a visually-hidden `gdpr` checkbox (same `check({ force: true })` trick as
    Bizneo); the optional Address block uses a Places autocomplete and is left to the human.
  - **Submit is gated by Cloudflare Turnstile** — see the section below; the adapter ships
    the anti-detection launch flags always-on and takes `--channel msedge` to drive real Edge.

- **greenhouse** — the application form is **served inside an iframe** named `grnhse_iframe`
  on the company careers page (`careers.<company>.com/jobs/<id>/…/apply/?gh_jid=<id>`),
  pointing at a Greenhouse board — Fever's is the **EU** board
  (`job-boards.eu.greenhouse.io/embed/job_app`). The adapter finds that frame by URL and does
  **every fill inside it** (`findFormFrame` waits for `#first_name`). Traps:
  - **Standard identity fields carry stable ids** inside the frame (`#first_name`,
    `#last_name`, `#preferred_name`, `#email`, `#phone`). Custom/screening questions are
    `#question_<id>` — **job-specific ids**, so `answers.screening[]` matches by `question_id`
    with `label_contains` (wording) as the stable fallback, and the adapter resolves the id
    from the wording when only the label is given (ids shift when a posting is edited).
  - **Select questions are react-select comboboxes**, not native `<select>`s. The
    `#question_<id>` input is only a search box: after you click an option from the
    `[role="option"]` listbox it is **cleared** (`opacity:0`, empty `value`) and the chosen
    label renders in a sibling **`.select__single-value`** — so confirm the selection *there*,
    never via `inputValue()` (which stays empty and reads as a false failure).
  - **The GDPR/privacy authorization is itself a required combobox** with a single option
    (`"Acknowledge/Confirm"`), not a checkbox — selecting it is the standing accept-policy
    compliance default.
  - **The "Country" field is the phone widget's country selector** (a react-select whose
    option labels carry a **dial code**, e.g. `"Spain +34"`, and whose selected single-value
    shows just the flag + `+34`) — match its option by **substring**, not an anchored string.
    `#phone` (the number) is filled with the full `+34 …` value.
  - **Résumé slot** is a real `input[type=file]#resume` under a **"Resume/CV"** heading
    (classifies `cv` → default CV; no résumé authored). `#cover_letter` is **optional** and
    left blank unless `answers.cover_letter_upload` is set.
  - **Submit is gated by an invisible reCAPTCHA Enterprise** — see the section above; the
    adapter ships the anti-detection flags always-on and takes `--channel msedge`.

- **workday** — the only portal so far needing an **account**: sign in once with
  `workday/login.js` (per tenant — a Workday account with one employer does not work for
  another) and the session lands in `.auth/workday-<tenant>-state.json`. Everything else is
  a trap for the unwary:
  - **Nothing persists as a draft.** Candidate Home stays empty until submit, so the whole
    5-step wizard must be filled in ONE run; the url never changes between steps either,
    so there is no navigation to wait on.
  - **But the resume DOES persist** — on the candidate *profile*, not the application, and
    the widget appends rather than replaces. Re-running once stacked five identical CVs.
    `apply.js` now checks for the file by name and skips the upload if it is already there.
  - **Tenant-specific paths**: IQVIA's signed-in landing page is `/userHome`, not
    `/candidate_home` (which errors). The SPA answers HTTP 200 for missing pages and fails
    client-side, so `curl` cannot tell them apart — only a browser can.
  - **Two different dropdowns.** A plain one is `button[aria-haspopup="listbox"]` with
    `<li role="option">` choices; the multiselect uses `[data-automation-id="promptOption"]`.
    Selected pills reuse the `promptOption` id, so options must exclude anything inside
    `selectedItemList`.
  - **"How Did You Hear About Us" is hierarchical and virtualised** — typing does not filter
    into children, so the taxonomy path is walked level by level, scrolling to load more
    ("Job Boards/Websites" → "Job Boards/Websites - LinkedIn - Job Posting").
  - **Skills is search-driven and needs Enter** — typing alone never runs the lookup and the
    list reads "No Items." forever. The search is server-side and slow, so an empty list
    means "still searching", not "no match".
  - Steps render progressively, so wait for the field set to hold *still*, not merely to
    differ, or you probe a half-built page.
  - Application Questions are GUID-named with "Select One" as their only label: match on the
    wrapper's question wording and select options by substring (they carry en-dashes and
    curly quotes).

  Every value is read back from the DOM before being reported as filled — on a form this
  indirect, a click that lands on nothing looks identical to one that works.
