# `data/` — the SQLite database

The pipeline stores every job it finds/triages/applies-to in a SQLite database here:
`data/jobs.db`. The `.db` file is **personal** and git-ignored (only this README is committed).

## Create it
```bash
python db/jobs_db.py init
```

## Schema (`jobs` table)
Portal-agnostic: an internal auto-increment `id` is the primary key (and names the
`output/<id>/` folder), while each portal's native id lives in `source_job_id`.

| column | notes |
|--------|-------|
| `id` | internal auto-increment PK; used as `<jobId>` for `output/<id>/` |
| `source`, `source_job_id` | portal (`linkedin`) + its native id; `UNIQUE(source, source_job_id)` dedups |
| `role`, `company`, `company_website`, `country` | job facts |
| `salary_asked` | your researched/target figure for this role |
| `application_site` | `LinkedIn` or an external site name |
| `job_url` | direct link to the posting |
| `cv_path`, `cover_letter_path`, `presentation_letter_path` | relative paths into `output/<id>/` (null if none) |
| `notes` | free-text observations (fit, remote eligibility, "closed for application", etc.) |
| `status` | funnel: `found` → `prepared` → `applied` → `screening` → `call-interview` → `technical-interview` → `final-interview` → `offer` → `accepted`; outcomes `rejected` / `withdrawn` / `on-hold`; plus `skipped` / `closed` / `external-logged` (full list = `jobs_db.STATUS_ORDER`) |
| `search_tag` | which configured search surfaced it |
| `created_at`, `updated_at`, `applied_at` | timestamps |

## CLI
```bash
python db/jobs_db.py init
python db/jobs_db.py upsert --file row.json          # single object or an array
python db/jobs_db.py get --id 3
python db/jobs_db.py get --source linkedin --source-job-id 123456
python db/jobs_db.py list [--status found] [--search-tag "..."] [--source linkedin]
python db/jobs_db.py set-status --id 3 --status applied [--notes "..."]
```
