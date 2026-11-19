"""How fast, and how much memory: every heavy operation on a big, realistic batch.

    python bench.py make --dir D:\\bench [--rows 1500000] [--files 4]
    python bench.py run  --dir D:\\bench [--only run_csv,compare] [--warm] [--profile low] [--json out.json]

`make` writes FILES CSVs of ROWS rows and 14 columns (ticket-like data: codes, amounts,
dates, names, a quoted note with commas), each file's keys overlapping the next one's by
half, with some amounts changed — so Compare, duplicates and lookups have real work to do.

`run` starts every operation in a fresh process, as the worker would, with an empty
workbook / text cache (a first run), and prints its seconds and peak memory (the
process's high-water mark, polars included). `--warm` runs each a second time on the
cache the first run left — a run on files read before.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


# ---------------------------------------------------------------- data
def make(d: Path, rows: int, files: int) -> None:
    import polars as pl

    d.mkdir(parents=True, exist_ok=True)
    for k in range(files):
        doc = pl.int_range(0, rows, eager=True).alias("i") + k * (rows // 2)
        df = pl.DataFrame({"doc": doc}).with_columns(
            pl.format("E{}", pl.col("doc").cast(pl.Utf8).str.zfill(9)).alias("DOC_NO"),
            pl.col("doc").mod(4).replace_strict({0: "XT", 1: "YQ", 2: "YR", 3: "ZR"}, return_dtype=pl.Utf8).alias("TAX_CODE"),
            ((pl.col("doc") * 37).mod(90_000) / 100 + pl.when(pl.col("doc").mod(10) == 0).then(k).otherwise(0))
            .round(2).alias("AMOUNT"),
            pl.format("{}/{}/2026", (pl.col("doc").mod(28) + 1).cast(pl.Utf8).str.zfill(2),
                      ((pl.col("doc") // 28).mod(12) + 1).cast(pl.Utf8).str.zfill(2)).alias("ISSUE_DATE"),
            pl.col("doc").mod(5).replace_strict({0: "USD", 1: "AED", 2: "EUR", 3: "GBP", 4: "INR"},
                                                return_dtype=pl.Utf8).alias("CURRENCY"),
            pl.format("PAX {}", pl.col("doc").mod(100_000)).alias("PAX_NAME"),
            pl.col("doc").mod(7).replace_strict({0: "DXB-LHR", 1: "DXB-BOM", 2: "DXB-JFK", 3: "DXB-SYD", 4: "DXB-CDG",
                                                 5: "DXB-KHI", 6: "DXB-MNL"}, return_dtype=pl.Utf8).alias("ROUTE"),
            pl.format("AG{}", pl.col("doc").mod(997)).alias("AGENT"),
            pl.format("Y{}", pl.col("doc").mod(50)).alias("FARE_BASIS"),
            pl.col("doc").mod(3).replace_strict({0: "EK", 1: "FZ", 2: "QR"}, return_dtype=pl.Utf8).alias("CARRIER"),
            (pl.col("doc").mod(4) + 1).alias("COUPON"),
            (pl.col("doc").mod(500) / 10).alias("TAX_AMOUNT"),
            pl.when(pl.col("doc").mod(20) == 0).then(pl.format("note, {}", pl.col("doc").mod(9)))
            .otherwise(pl.lit("")).alias("REMARKS"),
            pl.col("doc").mod(3).replace_strict({0: "OPEN", 1: "USED", 2: "VOID"}, return_dtype=pl.Utf8).alias("STATUS"),
        ).drop("doc", "i", strict=False)
        path = d / f"sales_{k + 1:02d}.csv"
        df.write_csv(path)
        print(f"{path.name}: {df.height:,} rows, {path.stat().st_size / 1e6:,.0f} MB")
    vals = [f"E{i:09d}" for i in range(0, rows * 2, max(1, rows // 1000))][:2000]
    (d / "find_values.txt").write_text("\n".join(vals), encoding="utf-8")


def _files(d: Path) -> list[str]:
    return [str(p) for p in sorted(d.glob("sales_*.csv"))]


# ---------------------------------------------------------------- operations
COLS = ["DOC_NO", "TAX_CODE", "AMOUNT", "ISSUE_DATE", "CURRENCY", "AGENT"]


def _job(d: Path, fmt: str, out: str, **extra) -> dict:
    return {"files": _files(d), "columns": [{"name": c, "include": True} for c in COLS],
            "filters": {"type": "group", "mode": "and", "children": [
                {"type": "rule", "column": "TAX_CODE", "op": "in_list", "value": "YQ, YR"}]},
            "output": {"folder": str(d / "out" / out), "format": fmt, "basename": out}, **extra}


def _setup(job: dict) -> dict:
    return {"groups": [{"name": "Sales", "files": job["files"], "setup": job}], "output": job["output"]}


def _dash(d: Path) -> dict:
    s = [{"column": "AMOUNT", "agg": "sum"}]
    job = {**_job(d, "csv", "dash"), "analysis": {"items": [
        {"id": "k", "kind": "kpi", "values": s},
        {"id": "b", "kind": "breakdown", "by": {"column": "TAX_CODE"}, "values": s},
        {"id": "t", "kind": "trend", "by": {"column": "ISSUE_DATE"}, "values": s},
        {"id": "x", "kind": "crosstab", "by": {"column": "CURRENCY"}, "by2": {"column": "TAX_CODE"}, "values": s}]}}
    return _setup(job)


def ops(d: Path) -> dict:
    import datamgr as D
    import engine as E
    import workspace as W

    f = _files(d)
    vals = (d / "find_values.txt").read_text(encoding="utf-8")
    yr = {"filters": [{"column": "TAX_CODE", "op": "equals", "value": "YR"}]}
    return {
        "run_csv": lambda: W.run_setup(_setup(_job(d, "csv", "run_csv"))),
        "run_xlsx": lambda: W.run_setup(_setup({**_job(d, "xlsx", "run_xlsx"), "filters": {
            "type": "group", "mode": "and", "children": [{"type": "rule", "column": "TAX_CODE", "op": "equals",
                                                          "value": "YR"}]}})),
        "run_parquet": lambda: W.run_setup(_setup(_job(d, "parquet", "run_parquet"))),
        "run_dupes": lambda: W.run_setup(_setup(_job(d, "csv", "run_dupes", batch_dupes={
            "keys": ["DOC_NO"], "keep": "dups", "count_col": "TIMES"}))),
        "count": lambda: E.count_rows(_job(d, "csv", "count")),
        "find": lambda: E.find({"files": f}, {"values": vals, "scope": "column", "column": "DOC_NO"}),
        "dashboards": lambda: W.run_dashboards(_dash(d)),
        "convert": lambda: E.convert_to_parquet({"files": f, "folder": str(d / "out" / "pq")}),
        "browse_sorted": lambda: D.browse({"path": f[0], "limit": 200, "view": {
            **yr, "sort": {"column": "AMOUNT", "desc": True}}}),
        "data_count": lambda: D.count({"files": f, "view": yr}),
        "data_combine": lambda: D.combine({"files": f, "folder": str(d / "out" / "combine"), "name": "all"}),
        "data_export_xlsx": lambda: D.export({"files": f, "folder": str(d / "out" / "export"), "name": "yr",
                                              "format": "xlsx", "view": yr}),
        "compare": lambda: D.compare({"a": f[0], "b": f[1], "keys": ["DOC_NO"]}),
        "compare_export": lambda: D.compare({"a": f[0], "b": f[1], "keys": ["DOC_NO"], "folder": str(d / "out" / "cmp"),
                                             "name": "cmp", "format": "csv"}),
        "sql": lambda: D.sql({"files": f, "query": "SELECT TAX_CODE, CURRENCY, SUM(AMOUNT) AS total, COUNT(*) AS n "
                                                   "FROM files GROUP BY TAX_CODE, CURRENCY ORDER BY total DESC"}),
    }


def one(name: str, d: Path) -> dict:
    import engine as E
    import prefs

    prefs.apply({**prefs.DEFAULTS, "performance": os.environ.get("COLSIFT_BENCH_PROFILE") or "balanced"})

    fn = ops(d)[name]
    t0 = time.perf_counter()
    r = fn()
    secs = time.perf_counter() - t0
    mem = E.process_memory() or (0, 0)
    ok = bool(r.get("ok", True)) if isinstance(r, dict) else True
    return {"op": name, "seconds": round(secs, 2), "peak_mb": round(mem[1] / 2 ** 20), "ok": ok,
            "error": (r.get("error") if isinstance(r, dict) else None)}


def run(d: Path, only: list[str], warm: bool, profile: str = "balanced") -> list[dict]:
    names = only or _names()
    res = []
    for name in names:
        cache = d / "cache" / name
        shutil.rmtree(cache, ignore_errors=True)
        shutil.rmtree(d / "out", ignore_errors=True)
        env = {**os.environ, "COLSIFT_CACHE": str(cache), "COLSIFT_PROFILES": str(d / "profiles"),
               "COLSIFT_BENCH_PROFILE": profile}
        for attempt in (["cold"] + (["warm"] if warm else [])):
            if attempt == "warm":
                shutil.rmtree(d / "out", ignore_errors=True)
            cp = subprocess.run([sys.executable, __file__, "op", name, "--dir", str(d)], env=env,
                                capture_output=True, text=True)
            line = next((x for x in reversed(cp.stdout.splitlines()) if x.startswith("{")), "")
            r = json.loads(line) if line else {"op": name, "ok": False, "error": (cp.stderr or "")[-400:]}
            r["pass"] = attempt
            res.append(r)
            print(f"{name:18} {attempt:4}  {r.get('seconds', '–'):>7} s  {r.get('peak_mb', '–'):>6} MB"
                  f"{'' if r.get('ok') else '  FAILED: ' + str(r.get('error'))[:200]}", flush=True)
        shutil.rmtree(cache, ignore_errors=True)
    return res


def _names() -> list[str]:
    return ["run_csv", "run_xlsx", "run_parquet", "run_dupes", "count", "find", "dashboards", "convert",
            "browse_sorted", "data_count", "data_combine", "data_export_xlsx", "compare", "compare_export", "sql"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["make", "run", "op"])
    ap.add_argument("name", nargs="?")
    ap.add_argument("--dir", required=True)
    ap.add_argument("--rows", type=int, default=1_500_000)
    ap.add_argument("--files", type=int, default=4)
    ap.add_argument("--only", default="")
    ap.add_argument("--warm", action="store_true")
    ap.add_argument("--json", default="")
    ap.add_argument("--profile", default="balanced", choices=["low", "balanced", "fast"])
    a = ap.parse_args()
    d = Path(a.dir)
    if a.cmd == "make":
        make(d, a.rows, a.files)
    elif a.cmd == "op":
        print(json.dumps(one(a.name, d)))
    else:
        res = run(d, [x for x in a.only.split(",") if x], a.warm, a.profile)
        if a.json:
            Path(a.json).write_text(json.dumps(res, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
