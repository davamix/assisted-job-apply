# `output/` — per-job generated artifacts

This folder is created and filled **automatically**, one subfolder per job, named by the job's
internal database id: `output/<jobId>/`. Everything here is **personal** and git-ignored
(only this README is committed).

## What a job folder contains

| File | Created by | Meaning |
|------|-----------|---------|
| `answers.json` | you / the pipeline | The form answers for this job (see keys below). This is the input the apply driver reads. |
| `Cover letter.md` | pipeline | Draft cover letter for this job (Markdown). |
| `Cover letter.pdf` | `scripts/md-to-pdf.js` | PDF of the cover letter, uploaded when a form has a cover-letter slot. |
| `CV.md` | pipeline (optional) | A tailored CV for this job, only when adaptation is warranted. |
| `state.json` | `scripts/linkedin-easyapply.js` | Live run status (`ready_for_approval` / `needs_input` / `applied` / …) plus the log of every field it filled. |
| `step-*.png`, `review.png`, `confirmation.png` | apply driver | Screenshots of each Easy Apply step, the final review, and the submitted confirmation. |
| `APPROVE` / `ABORT` | **you** | Signal files. The apply driver pauses at the review and waits: create `APPROVE` to submit, `ABORT` to discard. |

## `answers.json` keys (form auto-fill)
Common fields the Easy Apply driver understands:
- Identity/contact: `first_name`, `last_name`, `full_name`, `email`, `phone`, `phone_country_code`, `city`, `linkedin`, `website`
- Experience (years): `years_total`, `years_dotnet`, `years_ai`, `years_python`, `years_pytorch`, `years_mlops`
- Screening: `authorized_spain`, `authorized_us`, `sponsorship`, `notice`, `english_level`, `education`, `hear_about`, `salary_target`
- Compliance: `conflict` (Yes/No), `conflict_details` (text when "No" → usually `"N/A"`), `consent` (accept policy)
- Files: `cv_filename_hint` (substring to pick the right resume, e.g. `"CV"`), `cover_letter_pdf` (path to upload), `cover_letter` (plain text for any text box)

Most of these can be generated from `config/profile.json`; per-job files let you override anything
(e.g. tailored experience numbers or a job-specific cover letter).
