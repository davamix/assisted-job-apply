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

## What it does

- 🔐 **Log in once** in a real browser; the session is reused so your password is never stored or scripted.
- 🔎 **Search** LinkedIn Jobs (remote, date-posted, location filters) and scrape the result cards.
- 🗃️ **Store** every job in a portal-agnostic **SQLite** database (dedup, status tracking).
- 🔬 **Triage** each posting: full description, Easy-Apply vs. external, open/closed, already-applied, salary hints.
- ✍️ **Prepare** a tailored cover letter (and optionally an adapted CV → PDF).
- ✅ **Apply** through the multi-step Easy Apply form — filling contact info, screening questions,
  compliance attestations, selecting the right resume, uploading a cover letter — then **stopping at
  the review page for your approval**.

## How it works

```
config/search.json ─▶ linkedin-search.js ─▶ ingest_search.py ─▶ [ SQLite: found ]
                                                                        │
                                                     linkedin-job-detail.js (triage)
                                                                        │  (you decide fit)
                                                                        ▼
                                    md-to-pdf.js ◀─ cover letter / CV ─ [ prepared ]
                                                                        │
                                                     linkedin-easyapply.js (headed)
                                                        fills every step … then PAUSES
                                                                        │
                                          you review screenshot ▶ create APPROVE / ABORT
                                                                        │
                                                                 [ applied ] ─▶ SQLite
```

The apply driver **never clicks the final Submit on its own**. It fills the form, screenshots the
review page, writes `output/<jobId>/state.json`, and polls for a signal file you create.

## Repository layout

| Path | What it is |
|------|-----------|
| `scripts/linkedin-login.js` | One-time manual login; saves the session to `.auth/`. |
| `scripts/linkedin-verify.js` | Sanity-check that the saved session still works. |
| `scripts/linkedin-search.js` | Scrape one job search into JSON. |
| `scripts/linkedin-job-detail.js` | Fetch one job's full detail for triage. |
| `scripts/linkedin-easyapply.js` | Fill an Easy Apply form and pause for approval. |
| `scripts/md-to-pdf.js` | Render a Markdown CV/cover letter to PDF (via Chromium). |
| `db/jobs_db.py` | SQLite data layer + CLI. |
| `db/ingest_search.py` | Load search JSON into the database. |
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
node scripts/linkedin-login.js
# a browser opens — log in manually (incl. 2FA). The session saves to .auth/linkedin-state.json.
node scripts/linkedin-verify.js        # optional: confirm it works
```

**2. Search and store:**
```bash
node scripts/linkedin-search.js --keywords ".NET AI Engineer" \
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
node scripts/linkedin-job-detail.js --id <linkedinJobId>
# returns description, apply_type (easy_apply | external | closed | already_applied), salary hint…
```
Decide fit, then record it, e.g.:
```bash
python db/jobs_db.py set-status --id <dbId> --status skipped --notes "below salary floor"
```

**4. Prepare artifacts** (optional): write `output/<dbId>/Cover letter.md`, then
```bash
node scripts/md-to-pdf.js --in "output/<dbId>/Cover letter.md" --out "output/<dbId>/Cover letter.pdf"
```

**5. Apply (human-gated):**
```bash
node scripts/linkedin-easyapply.js --id <linkedinJobId> \
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
`linkedin-easyapply.js` writes `output/<jobId>/state.json` with a `status`:
- `ready_for_approval` — everything filled; waiting for you.
- `needs_input` — a required field it couldn't answer; complete it in the live browser, then `APPROVE`.
- `applied` / `aborted` / `timeout` — terminal.

It polls for `APPROVE`/`ABORT` for `--timeoutMs` (default 15 min). See `output/README.md` for every artifact.

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

- **Form field matching** lives in `scripts/linkedin-easyapply.js` as a `RULES` array (label
  regex → answer key). Add rules for questions specific to your field.
- **Compliance defaults** (all conflict questions → "No", accept policy, "found via LinkedIn",
  never auto-follow the company) are applied automatically and shown on the review screen before you approve.
- **Headed vs. headless**: search/detail default to headless; the apply driver is headed so you can watch.

## Limitations & troubleshooting

- LinkedIn's logged-in DOM is **heavily obfuscated** (hashed class names). The scripts rely on
  accessible labels/roles and stable text anchors, but LinkedIn changes its UI often — if a
  selector breaks, the diagnostic pattern in `docs/ARCHITECTURE.md` shows how to inspect and fix it.
- **External application sites** (Workday, Greenhouse, etc.) are intentionally **not auto-filled** by
  default — they're logged so you can complete them manually.
- If the session expires, just re-run `linkedin-login.js`.
- Run scripts from the project root; if you must run from elsewhere, set `NODE_PATH` to the project's `node_modules`.

## License

[MIT](LICENSE).
