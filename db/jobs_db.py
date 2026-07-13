#!/usr/bin/env python3
"""SQLite data layer for the LinkedIn job-search pipeline.

Single writer for the jobs database. Portal-agnostic: the internal auto-increment
`id` is the primary key (and names the output/<id>/ folder), while each portal's
native id lives in `source_job_id`. Dedup is on UNIQUE(source, source_job_id).

CLI:
  python db/jobs_db.py init
  python db/jobs_db.py upsert --json '{"source":"linkedin","source_job_id":"123","role":"..."}'
  python db/jobs_db.py upsert --file rows.json          # a single object or an array of objects
  python db/jobs_db.py get --id 7
  python db/jobs_db.py get --source linkedin --source-job-id 123
  python db/jobs_db.py list [--status found] [--search-tag ".NET AI"] [--source linkedin]
  python db/jobs_db.py set-status --id 7 --status applied [--notes "..."]

All commands print JSON to stdout so callers (Node/PowerShell/me) can parse the result.
Stdlib only (sqlite3) — no external dependencies.
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "jobs.db")
DB_PATH = os.path.normpath(DB_PATH)

# Columns a caller may set via upsert (id/created_at/updated_at are managed here).
WRITABLE = [
    "source", "source_job_id", "role", "company", "company_website", "country",
    "salary_asked", "application_site", "job_url", "cv_path", "cover_letter_path",
    "presentation_letter_path", "notes", "status", "search_tag", "applied_at",
]

# Ordered application funnel. Single source of truth for both status validation
# (VALID_STATUS) and the web dashboard's ordering/coloring of the status dropdown.
# The pipeline scripts only ever set found/prepared/applied/skipped/external-logged;
# the interview stages and terminal states are set manually via the dashboard/CLI.
STATUS_ORDER = [
    "found", "prepared", "applied",
    "screening", "call-interview", "technical-interview", "final-interview",
    "offer", "accepted",
    "rejected", "withdrawn", "on-hold",
    "skipped", "closed", "external-logged",
]
VALID_STATUS = set(STATUS_ORDER)

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    source                    TEXT NOT NULL,
    source_job_id             TEXT NOT NULL,
    role                      TEXT,
    company                   TEXT,
    company_website           TEXT,
    country                   TEXT,
    salary_asked              TEXT,
    application_site          TEXT,
    job_url                   TEXT,
    cv_path                   TEXT,
    cover_letter_path         TEXT,
    presentation_letter_path  TEXT,
    notes                     TEXT,
    status                    TEXT NOT NULL DEFAULT 'found',
    search_tag                TEXT,
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL,
    applied_at                TEXT,
    UNIQUE(source, source_job_id)
);
"""


def now():
    return datetime.now().isoformat(timespec="seconds")


def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db():
    with connect() as conn:
        conn.executescript(SCHEMA)
    return {"ok": True, "db": DB_PATH}


def _row_to_dict(row):
    return dict(row) if row is not None else None


def upsert_one(conn, data):
    """Insert a new job or update an existing one matched by (source, source_job_id).

    Only keys present in `data` (and writable) are touched; existing values are not
    clobbered by missing keys. Returns the full row dict plus an `_action` marker.
    """
    source = data.get("source")
    source_job_id = data.get("source_job_id")
    if not source or source_job_id in (None, ""):
        raise ValueError("upsert requires non-empty 'source' and 'source_job_id'")
    source_job_id = str(source_job_id)

    fields = {k: data[k] for k in WRITABLE if k in data and k not in ("source", "source_job_id")}
    if "status" in fields and fields["status"] not in VALID_STATUS:
        raise ValueError(f"invalid status {fields['status']!r}; valid: {sorted(VALID_STATUS)}")

    cur = conn.execute(
        "SELECT * FROM jobs WHERE source = ? AND source_job_id = ?",
        (source, source_job_id),
    )
    existing = cur.fetchone()
    ts = now()

    if existing is None:
        cols = ["source", "source_job_id", "created_at", "updated_at"] + list(fields.keys())
        vals = [source, source_job_id, ts, ts] + list(fields.values())
        placeholders = ", ".join(["?"] * len(cols))
        conn.execute(
            f"INSERT INTO jobs ({', '.join(cols)}) VALUES ({placeholders})", vals
        )
        row_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        action = "inserted"
    else:
        row_id = existing["id"]
        if fields:
            sets = ", ".join([f"{k} = ?" for k in fields.keys()]) + ", updated_at = ?"
            conn.execute(
                f"UPDATE jobs SET {sets} WHERE id = ?",
                list(fields.values()) + [ts, row_id],
            )
        action = "updated"

    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (row_id,)).fetchone()
    result = _row_to_dict(row)
    result["_action"] = action
    return result


def cmd_upsert(args):
    if args.json:
        payload = json.loads(args.json)
    elif args.file:
        with open(args.file, "r", encoding="utf-8") as f:
            payload = json.load(f)
    else:
        payload = json.load(sys.stdin)

    rows = payload if isinstance(payload, list) else [payload]
    results = []
    with connect() as conn:
        for data in rows:
            results.append(upsert_one(conn, data))
        conn.commit()
    return results if isinstance(payload, list) else results[0]


def cmd_get(args):
    with connect() as conn:
        if args.id is not None:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (args.id,)).fetchone()
        elif args.source and args.source_job_id:
            row = conn.execute(
                "SELECT * FROM jobs WHERE source = ? AND source_job_id = ?",
                (args.source, str(args.source_job_id)),
            ).fetchone()
        else:
            raise ValueError("get requires --id OR (--source AND --source-job-id)")
    return _row_to_dict(row)


def cmd_list(args):
    clauses, params = [], []
    if args.status:
        clauses.append("status = ?"); params.append(args.status)
    if args.search_tag:
        clauses.append("search_tag = ?"); params.append(args.search_tag)
    if args.source:
        clauses.append("source = ?"); params.append(args.source)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    with connect() as conn:
        rows = conn.execute(f"SELECT * FROM jobs{where} ORDER BY id", params).fetchall()
    return [_row_to_dict(r) for r in rows]


def cmd_set_status(args):
    if args.status not in VALID_STATUS:
        raise ValueError(f"invalid status {args.status!r}; valid: {sorted(VALID_STATUS)}")
    ts = now()
    sets = ["status = ?", "updated_at = ?"]
    params = [args.status, ts]
    if args.notes is not None:
        sets.append("notes = ?"); params.append(args.notes)
    if args.status == "applied":
        sets.append("applied_at = ?"); params.append(ts)
    params.append(args.id)
    with connect() as conn:
        conn.execute(f"UPDATE jobs SET {', '.join(sets)} WHERE id = ?", params)
        conn.commit()
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (args.id,)).fetchone()
    return _row_to_dict(row)


def main():
    p = argparse.ArgumentParser(description="Jobs SQLite data layer")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init")

    up = sub.add_parser("upsert")
    up.add_argument("--json")
    up.add_argument("--file")

    g = sub.add_parser("get")
    g.add_argument("--id", type=int)
    g.add_argument("--source")
    g.add_argument("--source-job-id", dest="source_job_id")

    ls = sub.add_parser("list")
    ls.add_argument("--status")
    ls.add_argument("--search-tag", dest="search_tag")
    ls.add_argument("--source")

    ss = sub.add_parser("set-status")
    ss.add_argument("--id", type=int, required=True)
    ss.add_argument("--status", required=True)
    ss.add_argument("--notes")

    # Job data is full of accented (ES/EU) characters; emit UTF-8 regardless of the console codepage.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    args = p.parse_args()
    dispatch = {
        "init": lambda a: init_db(),
        "upsert": cmd_upsert,
        "get": cmd_get,
        "list": cmd_list,
        "set-status": cmd_set_status,
    }
    try:
        result = dispatch[args.cmd](args)
    except Exception as e:  # surface a clean JSON error to callers
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
