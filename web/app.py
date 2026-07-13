#!/usr/bin/env python3
"""Local web dashboard for the job-application database.

A tiny, dependency-free (stdlib only) HTTP server that renders data/jobs.db as a
filterable table, lets you change each job's status + notes, and links straight to
the generated documents (cover / presentation letters, tailored CV).

It reuses db/jobs_db.py as the data layer (same DB, same VALID_STATUS), so the CLI
and the dashboard can never disagree about what a valid status is.

Run:
  python web/app.py [--port 8000] [--host 127.0.0.1]
then open the printed http://127.0.0.1:8000 URL. Local, single-user tool: it serves
your personal DB and documents, so keep it bound to localhost.
"""
import argparse
import json
import mimetypes
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Reuse the DB layer (single source of truth for schema + VALID_STATUS/STATUS_ORDER).
PROJECT_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "db"))
import jobs_db  # noqa: E402  (path adjusted above; mirrors ingest_search.py)

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "output")
ASSETS_DIR = os.path.join(PROJECT_ROOT, "assets")
# Directories the /files endpoint is allowed to serve from (nothing else).
DOC_ROOTS = [OUTPUT_DIR, ASSETS_DIR]

# Columns that a job's filter query may constrain (exact match).
EXACT_FILTERS = ("status", "search_tag", "country", "source")


# --------------------------------------------------------------------------- data

def list_jobs(filters):
    """Return job rows matching the given filters, each with a resolved documents list."""
    clauses, params = [], []
    for col in EXACT_FILTERS:
        val = filters.get(col)
        if val:
            clauses.append(f"{col} = ?")
            params.append(val)
    q = filters.get("q")
    if q:
        clauses.append("(role LIKE ? OR company LIKE ?)")
        like = f"%{q}%"
        params += [like, like]
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    with jobs_db.connect() as conn:
        rows = conn.execute(f"SELECT * FROM jobs{where} ORDER BY id", params).fetchall()
    result = []
    for r in rows:
        d = jobs_db._row_to_dict(r)
        d["documents"] = resolve_documents(d)
        result.append(d)
    return result


def meta():
    """Distinct filter values + per-status counts + the always-available base CVs."""
    with jobs_db.connect() as conn:
        def distinct(col):
            return [row[0] for row in conn.execute(
                f"SELECT DISTINCT {col} FROM jobs WHERE {col} IS NOT NULL AND {col} <> '' ORDER BY {col}"
            ).fetchall()]
        counts = {row[0]: row[1] for row in conn.execute(
            "SELECT status, COUNT(*) FROM jobs GROUP BY status"
        ).fetchall()}
        total = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
    return {
        "statuses": jobs_db.STATUS_ORDER,
        "search_tags": distinct("search_tag"),
        "countries": distinct("country"),
        "sources": distinct("source"),
        "counts": counts,
        "total": total,
        "base_documents": list_dir_documents(ASSETS_DIR, "assets"),
    }


def update_job(job_id, status, notes):
    """Update a job's status and/or notes; stamp applied_at when moving to applied.

    Mirrors jobs_db.cmd_set_status, generalized to also set notes. Returns the row,
    or None if the job doesn't exist. Raises ValueError on an invalid status.
    """
    sets, params = [], []
    if status is not None:
        if status not in jobs_db.VALID_STATUS:
            raise ValueError(f"invalid status {status!r}; valid: {sorted(jobs_db.VALID_STATUS)}")
        sets.append("status = ?")
        params.append(status)
        if status == "applied":
            sets.append("applied_at = ?")
            params.append(jobs_db.now())
    if notes is not None:
        sets.append("notes = ?")
        params.append(notes)
    if not sets:
        raise ValueError("nothing to update: provide 'status' and/or 'notes'")
    sets.append("updated_at = ?")
    params.append(jobs_db.now())
    params.append(job_id)
    with jobs_db.connect() as conn:
        cur = conn.execute(f"UPDATE jobs SET {', '.join(sets)} WHERE id = ?", params)
        conn.commit()
        if cur.rowcount == 0:
            return None
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    d = jobs_db._row_to_dict(row)
    d["documents"] = resolve_documents(d)
    return d


# ----------------------------------------------------------------------- documents

def _rel(abspath):
    return os.path.relpath(abspath, PROJECT_ROOT).replace(os.sep, "/")


def _doc_entry(abspath, label, group):
    ext = os.path.splitext(abspath)[1].lower().lstrip(".")
    return {
        "label": label,
        "url": "/files?path=" + urllib.parse.quote(_rel(abspath)),
        "type": ext,
        "group": group,
    }


def resolve_documents(row):
    """Build the list of clickable documents for a job row.

    Sources, de-duplicated: the DB path columns (preferring a .pdf sibling for a .md
    cover letter), then anything auto-discovered under output/<id>/ (cover letter +
    screenshots as secondary 'evidence').
    """
    docs, seen = [], set()

    def add(relpath, label, group="doc"):
        abspath = os.path.normpath(os.path.join(PROJECT_ROOT, relpath))
        if not os.path.isfile(abspath):
            return
        key = os.path.normcase(abspath)
        if key in seen:
            return
        seen.add(key)
        docs.append(_doc_entry(abspath, label, group))

    if row.get("cv_path"):
        add(row["cv_path"], "CV")
    clp = row.get("cover_letter_path")
    if clp:
        base, ext = os.path.splitext(clp)
        if ext.lower() == ".md":
            add(base + ".pdf", "Cover letter (PDF)")  # preferred, view in browser
            add(clp, "Cover letter (MD)")
        else:
            add(clp, "Cover letter")
    if row.get("presentation_letter_path"):
        add(row["presentation_letter_path"], "Presentation letter")

    outdir = os.path.join(OUTPUT_DIR, str(row["id"]))
    if os.path.isdir(outdir):
        for name in ("Cover letter.pdf", "Cover letter.md"):
            label = "Cover letter (PDF)" if name.endswith(".pdf") else "Cover letter (MD)"
            add(f"output/{row['id']}/{name}", label)
        for name in sorted(os.listdir(outdir)):
            if name.lower().endswith(".png"):
                add(f"output/{row['id']}/{name}", name, group="evidence")
    return docs


def list_dir_documents(directory, group):
    """List the linkable documents (pdf/md/png) directly in a directory."""
    docs = []
    if not os.path.isdir(directory):
        return docs
    for name in sorted(os.listdir(directory)):
        abspath = os.path.join(directory, name)
        if name.lower() == "readme.md":  # folder placeholder, not a document
            continue
        if os.path.isfile(abspath) and os.path.splitext(name)[1].lower() in (".pdf", ".md", ".png"):
            docs.append(_doc_entry(abspath, name, group))
    return docs


def safe_doc_path(relpath):
    """Resolve a /files path to a real file inside an allowed doc root, or None.

    Guards against path traversal: the resolved real path must live inside output/
    or assets/.
    """
    candidate = os.path.normpath(os.path.join(PROJECT_ROOT, relpath))
    real = os.path.normcase(os.path.realpath(candidate))
    for root in DOC_ROOTS:
        root_real = os.path.normcase(os.path.realpath(root))
        if real == root_real or real.startswith(root_real + os.sep):
            if os.path.isfile(real):
                return real
    return None


# -------------------------------------------------------------------------- server

class Handler(BaseHTTPRequestHandler):
    server_version = "JobsDashboard/1.0"

    # -- helpers ------------------------------------------------------------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, body, content_type, extra=None):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message):
        self._send_json({"error": message}, status=status)

    # -- routing ------------------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path in ("/", "/index.html"):
                return self._serve_static("index.html")
            if path == "/api/meta":
                return self._send_json(meta())
            if path == "/api/jobs":
                qs = urllib.parse.parse_qs(parsed.query)
                filters = {k: qs[k][0] for k in list(EXACT_FILTERS) + ["q"] if qs.get(k)}
                return self._send_json(list_jobs(filters))
            if path == "/files":
                return self._serve_file(parsed.query)
            return self._error(404, "not found")
        except Exception as e:  # keep the server alive; report cleanly
            return self._error(500, str(e))

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        parts = parsed.path.strip("/").split("/")
        try:
            # POST /api/jobs/{id}
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "jobs" and parts[2].isdigit():
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                data = json.loads(raw or b"{}")
                row = update_job(int(parts[2]), data.get("status"), data.get("notes"))
                if row is None:
                    return self._error(404, f"job {parts[2]} not found")
                return self._send_json(row)
            return self._error(404, "not found")
        except ValueError as e:
            return self._error(400, str(e))
        except Exception as e:
            return self._error(500, str(e))

    # -- static + files -----------------------------------------------------
    def _serve_static(self, name):
        abspath = os.path.normpath(os.path.join(STATIC_DIR, name))
        if not abspath.startswith(STATIC_DIR) or not os.path.isfile(abspath):
            return self._error(404, "not found")
        with open(abspath, "rb") as f:
            body = f.read()
        ctype = mimetypes.guess_type(abspath)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        return self._send_bytes(body, ctype)

    def _serve_file(self, query):
        qs = urllib.parse.parse_qs(query)
        relpath = (qs.get("path") or [""])[0]
        if not relpath:
            return self._error(400, "missing 'path'")
        real = safe_doc_path(relpath)
        if not real:
            return self._error(404, "not found")
        with open(real, "rb") as f:
            body = f.read()
        ext = os.path.splitext(real)[1].lower()
        if ext == ".md":
            ctype = "text/plain; charset=utf-8"
        elif ext == ".pdf":
            ctype = "application/pdf"
        else:
            ctype = mimetypes.guess_type(real)[0] or "application/octet-stream"
        # Display inline (PDF/PNG) rather than forcing a download.
        return self._send_bytes(body, ctype, {"Content-Disposition": "inline"})

    def log_message(self, fmt, *args):  # concise console logging
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    p = argparse.ArgumentParser(description="Local job-application dashboard")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    args = p.parse_args()

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}"
    print(f"Job dashboard serving at {url}  (DB: {jobs_db.DB_PATH})")
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        httpd.server_close()


if __name__ == "__main__":
    main()
