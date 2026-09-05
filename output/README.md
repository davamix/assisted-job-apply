# `output/` — per-job generated artifacts

This folder is created and filled **automatically**, one subfolder per job, named by the job's
internal database id: `output/<jobId>/`. Everything here is **personal** and git-ignored
(only this README is committed).

## What a job folder contains

| File | Created by | Meaning |
|------|-----------|---------|
| `answers.json` | you / the pipeline | The form answers for this job (see keys below). This is the input the apply driver reads. |
| `Cover letter.md` | pipeline | Draft cover letter for this job (Markdown), arguing your fit for **this** posting. |
| `Cover letter.pdf` | `scripts/common/md-to-pdf.js` | PDF of the cover letter, uploaded when a form has a cover-letter slot. |
| `Presentation letter.pdf` | `scripts/common/md-to-pdf.js` | Rendered from the reusable `assets/presentation-letter.md`, for the rare form that asks for a letter of introduction instead of a cover letter. No per-job `.md`: it names no company. |
| `CV.md` / `CV.pdf` | pipeline (optional) | A tailored CV for this job, only when adaptation is warranted (`.md` rendered to `.pdf`). |
| `resume.md` | pipeline (on demand) | A **Résumé** (shorter, US-style) authored when a form asks for one specifically — condensed from your CV, tailored to the role. Durable artifact; linked in the dashboard. |
| `resume.pdf` | `scripts/common/md-to-pdf.js` | Rendered Résumé, uploaded to the form. **Transient** — may be discarded after upload (the `.md` is what's kept). |

Documents are authored **without a name/contact header** — `md-to-pdf.js` generates the letterhead
from `config/profile.json`. See `templates/README.md` for which template renders what, and how.
Documents produced before that change keep their own headers and are left as historical records.
| `state.json` | `scripts/linkedin/easyapply.js` | Live run status (`ready_for_approval` / `needs_input` / `applied` / …) plus the log of every field it filled. |
| `step-*.png`, `review.png`, `confirmation.png` | apply driver | Screenshots of each Easy Apply step, the final review, and the submitted confirmation. |
| `APPROVE` / `ABORT` | **you** | Signal files. The LinkedIn apply driver pauses at the review and waits: create `APPROVE` to submit, `ABORT` to discard. |
| `bamboo-state.json`, `bamboo-filled.png`, `bamboo.log` | `scripts/bamboohr/apply.js` | External-apply (BambooHR) run state, the filled-form screenshot, and its log. |
| `CLOSE` | **you** | Signal file for external-apply adapters (e.g. BambooHR): the adapter fills the form and keeps the browser open — create `CLOSE` once you've submitted, to close it. |

## `answers.json` keys (form auto-fill)
Common fields the Easy Apply driver understands:
- Identity/contact: `first_name`, `last_name`, `full_name`, `email`, `phone`, `phone_country_code`, `city`, `linkedin`, `website`
- Experience (years): `years_total`, `years_dotnet`, `years_ai`, `years_python`, `years_pytorch`, `years_mlops`
- Screening: `authorized_spain`, `authorized_us`, `sponsorship`, `notice`, `english_level`, `education`, `hear_about`, `salary_target`
- Compliance: `conflict` (Yes/No), `conflict_details` (text when "No" → usually `"N/A"`), `consent` (accept policy)
- Files: `cv_filename_hint` (substring to pick the right resume on LinkedIn, e.g. `"CV"`), `cover_letter_pdf` (path to upload), `cover_letter` (plain text for any text box)
- Résumé/CV upload (external ATS): `resume_upload` (path to the PDF attached to the résumé/CV file input — the default CV, an adapted `output/<id>/CV.pdf`, or an on-demand `output/<id>/resume.pdf`), `resume_doc_type` (`"cv"` | `"resume"`, recorded for auditing / the dashboard)
- External-form extras (BambooHR): `country`, `state` (native-select labels), `desired_pay` (or derived from `salary_target`), and `screening` — a map of Yes/No screening answers, either `{ "customQuestionAnswers.yes_no_129": "Yes", … }` (by field name) or `[ { "question": "regex", "answer": "No" }, … ]` (by question text)
- External-form extras (Connexys): `postcode`, `contract_type` (the option wording, e.g. `"CDI"` for a permanent contract), `availability` (e.g. `"Immédiate"`), `rqth` (the French disability-accommodation question), and `link_url` for the LinkedIn profile field. Any of these left `null` is reported as `pending` at the review gate rather than guessed — the postcode and RQTH answers are personal data that may deliberately not be on record.

- Screening entries (Greenhouse, Viterbit) may also carry `question_id` (the portal's own id, matched first) with `label_contains` as the wording fallback, plus an optional `verify` note — text shown back to you at the review gate for an answer that was filled but only you can confirm (a personal fact, or a figure that departs from `config/profile.json`)

Most of these can be generated from `config/profile.json`; per-job files let you override anything
(e.g. tailored experience numbers or a job-specific cover letter).
