#!/usr/bin/env python3
"""Ingest linkedin/search.js JSON output into the jobs DB as status=found rows.

Usage:
  python db/ingest_search.py --file search-out.json --tag ".NET + AI/RAG" [--source linkedin]

Each input item looks like: {source_job_id, role, company, location, url}
Maps to a DB row and inserts it (dedup on source+source_job_id). A job that is already in
the DB is left untouched and listed under "existing": re-ingesting it must not reset an
applied/skipped row back to "found". Country is parsed from the location string
(e.g. "Spain (Remote)" -> "Spain"). Prints a summary.
"""
import argparse
import json
import re
import sys

import jobs_db  # same directory


def parse_country(location):
    if not location:
        return None
    # "Chartered Community of Navarre, Spain (Remote)" -> "Spain"; "Spain (Remote)" -> "Spain"
    loc = re.sub(r"\(.*?\)", "", location).strip()
    if "," in loc:
        loc = loc.split(",")[-1].strip()
    return loc or None


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("--file", required=True)
    p.add_argument("--tag", required=True)
    p.add_argument("--source", default="linkedin")
    args = p.parse_args()

    with open(args.file, "r", encoding="utf-8") as f:
        items = json.load(f)

    inserted, existing = 0, []
    with jobs_db.connect() as conn:
        for it in items:
            known = conn.execute(
                "SELECT id, status FROM jobs WHERE source = ? AND source_job_id = ?",
                (args.source, str(it.get("source_job_id"))),
            ).fetchone()
            if known is not None:
                existing.append({"id": known["id"], "status": known["status"],
                                 "source_job_id": str(it.get("source_job_id"))})
                continue
            row = {
                "source": args.source,
                "source_job_id": str(it.get("source_job_id")),
                "role": it.get("role"),
                "company": it.get("company"),
                "country": parse_country(it.get("location")),
                "job_url": it.get("url"),
                "application_site": "LinkedIn",
                "search_tag": args.tag,
                "status": "found",
            }
            jobs_db.upsert_one(conn, row)
            inserted += 1
        conn.commit()
    print(json.dumps({"ingested": len(items), "inserted": inserted, "existing": existing, "tag": args.tag}))


if __name__ == "__main__":
    main()
