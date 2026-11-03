"""Which packages ColSift actually imports — evidence for the Nuitka excludes.

    python depscan.py                 (uses a generated sample file)
    python depscan.py C:\\extracts\\JUL.xlsx   (uses your own, more representative)

It runs a full flow — peek, columns, preview, count, extract to CSV and to XLSX
with formats, a formula column, the analysis dashboard and a pivot, the PDF report,
and a workspace with a SQL step, a transform and its own report — then prints
the top-level packages that were imported along the way, and the ones that were
not. Anything in the second list is safe to exclude from the build. Guessing at
this list is how a build ends up either bloated or broken at run time.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

HEAVY = {   # packages worth excluding if they turn out to be unused, with rough dist sizes
    "pandas": "~60 MB", "pyarrow": "~300 MB", "numpy": "~60 MB", "matplotlib": "~80 MB",
    "scipy": "~120 MB", "IPython": "~30 MB", "pytest": "~10 MB", "setuptools": "~10 MB",
    "PIL": "~20 MB", "sqlalchemy": "~30 MB", "tkinter": "~25 MB", "test": "stdlib tests",
    "lib2to3": "~5 MB", "pydoc_data": "~1 MB", "distutils": "~3 MB", "numba": "~50 MB",
    "dask": "~30 MB", "deltalake": "~40 MB", "xlsx2csv": "small", "connectorx": "~40 MB",
    "great_tables": "~10 MB", "altair": "~10 MB", "cloudpickle": "small", "fsspec": "small",
}
STDLIB_NOISE = {"_", "encodings", "codecs", "abc", "io", "os", "sys", "re", "types"}


def sample(path: Path) -> Path:
    f = path / "sample.csv"
    rows = ["DOC_NO,TKT_NO,TAX_CODE,AMOUNT,ISSUE_DATE,REMARKS"]
    for i in range(2000):
        rows.append(f"E{i:05d},176{i:07d},{['YQ','YR','ZR'][i % 3]},"
                    f"\"{i * 13 + 5:,}.50\",{(i % 28) + 1:02d}/{(i % 12) + 1:02d}/2026,{'x' if i % 2 else ''}")
    f.write_text("\n".join(rows) + "\n", encoding="utf-8")
    return f


def main() -> int:
    here = Path(__file__).resolve().parent
    sys.path.insert(0, str(here))
    tmp = Path(tempfile.mkdtemp(prefix="colsift_scan_"))
    try:
        src = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else sample(tmp)
        before = set(sys.modules)
        import engine as E            # noqa: PLC0415 — the point is to import it here

        out = tmp / "out"
        job = {
            "files": [str(src)],
            "source": {"has_header": True, "auto_header": True, "auto_delimiter": True},
            "filters": {"children": [{"type": "rule", "column": None, "op": "formula",
                                      "value": "LEN(DOC_NO) > 0"}]},
            "add_columns": [{"name": "BAND", "kind": "formula", "value": 'IF(AMOUNT > 1000, "HIGH", "LOW")'}],
            "analysis": {"export": True, "items": [
                {"id": "k", "kind": "kpi", "values": [{"column": "AMOUNT", "agg": "sum"}]},
                {"id": "b", "kind": "breakdown", "by": {"column": "TAX_CODE"},
                 "values": [{"column": "AMOUNT", "agg": "sum"}]}]},
            "summaries": {"export": True, "tabs": [{"id": "s", "name": "By code", "pivot": {
                "rows": [{"column": "TAX_CODE"}], "cols": [{"column": "ISSUE_DATE", "group": "month"}],
                "values": [{"column": "AMOUNT", "agg": "sum"}]}}]},
            "output": {"folder": str(out), "format": "csv", "basename": "scan",
                       "formats": {"AMOUNT": {"type": "number", "fmt": "#,##0.00"}}},
        }
        cols = E.columns_of({**job["source"], "path": str(src)})
        job["columns"] = [{"name": c, "include": True} for c in cols.get("columns", [])]
        import pdfout
        import workspace as W

        ws = {"name": "scan", "groups": [{"name": "Data", "setup": {k: v for k, v in job.items() if k != "files"},
                                          "files": [str(src)]}],
              "steps": [{"name": "Q", "kind": "sql", "sql": "SELECT * FROM Data LIMIT 10"},
                        {"name": "T", "kind": "transform", "input": "Data",
                         "add_columns": [{"name": "X", "kind": "formula", "value": "LEN(DOC_NO)"}]}],
              "reports": [{"name": "R", "table": "T", "analysis": {"export": True, "items": job["analysis"]["items"]},
                           "summaries": {"export": True, "tabs": job["summaries"]["tabs"]}}],
              "output": {"folder": str(out / "ws"), "format": "xlsx", "pdf": {"dashboard": True, "summaries": True}}}

        def pdf_step():
            res = E.analyse(job, "active")
            pdfout.analysis_pdf(out / "scan.pdf", res)
            return {"ok": True}

        steps = [
            ("peek", lambda: E.raw_peek(str(src), 30)),
            ("preview", lambda: E.preview(job, 50)),
            ("count", lambda: E.count_rows(job)),
            ("analysis", lambda: E.analyse(job, "active")),
            ("extract to csv", lambda: E.run(job)),
            ("extract to xlsx", lambda: E.run({**job, "output": {**job["output"], "format": "xlsx",
                                                                 "basename": "scan_x"}})),
            ("analysis to pdf", pdf_step),
            ("workspace preview", lambda: W.preview(ws, "T", 20)),
            ("workspace run", lambda: W.run(ws)),
        ]
        print(f"Scanning with {src.name}\n")
        for name, fn in steps:
            r = fn()
            ok = r.get("ok", True) if isinstance(r, dict) else True
            print(f"  {name:<16} {'ok' if ok else 'FAILED: ' + str(r.get('error'))[:60]}")
        new = {m.split(".")[0] for m in set(sys.modules) - before}
        new = {m for m in new if m and not m.startswith("_") and m not in STDLIB_NOISE}

        print("\nImported during the run (must stay in the build):")
        for m in sorted(new & (set(HEAVY) | {"polars", "fastexcel", "openpyxl", "xlsxwriter",
                                             "webview", "clr_loader", "pythonnet"})):
            print(f"  {m}")
        unused = [m for m in HEAVY if m not in new]
        print("\nNot imported — safe to exclude:")
        for m in sorted(unused):
            print(f"  {m:<14} {HEAVY[m]}")
        flags = " ".join(f"--nofollow-import-to={m}" for m in sorted(unused) if m not in ("tkinter", "test"))
        print("\nAdd to the Nuitka command:\n\n  " + flags + " ^")
        print("\nAlso safe regardless:\n  --noinclude-pytest-mode=nofollow --noinclude-setuptools-mode=nofollow "
              "--noinclude-IPython-mode=nofollow ^")
        if "numpy" in new:
            print("\nNOTE: numpy WAS imported — polars reached for it during this run. Keep it in the build.")
        (Path.cwd() / "depscan-result.json").write_text(json.dumps(
            {"imported": sorted(new), "excludable": sorted(unused)}, indent=1), encoding="utf-8")
        print("\nWritten: depscan-result.json")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
