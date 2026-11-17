"""Data management — the Quarry workbench on ColSift's engine.

    browse(p)    one page of any file — Parquet, CSV / TXT, Excel — with a view on it:
                 the columns to show, filters, a sort, distinct rows. A first page with no
                 filters or sort reads only the start of the file.
    count(p)     the rows a view leaves, over one file or every ticked file.
    combine(p)   many files into one Parquet file: each read as its source settings say,
                 stacked by column name, numbers and dates typed, one file at a time.
    export(p)    a view over the ticked files as CSV / TXT / Excel / Parquet — one file,
                 or one per input — streamed, split at Excel's row limit.

A view is {"columns": [...], "filters": [{"column", "op", "value", "value2"}],
"join": "and" | "or", "sort": {"column", "desc"}, "unique": bool}. Filters are ColSift's
own conditions (the ops of the Filters tab), so they mean the same thing everywhere.
Values are read as text, as everywhere in ColSift; a sort on a column that holds numbers
sorts by number.
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path

import polars as pl

import engine as E

SOURCE_COL = "SOURCE_FILE"
PAGE_MAX = 5_000


def _source(path: str, source: dict | None) -> "E.Source":
    return E.Source.from_dict({**(source or {}), "path": str(path)})


def _plain(lf: pl.LazyFrame) -> pl.LazyFrame:
    """Every column as text, as ColSift reads it (Parquet keeps its own labels)."""
    sch = lf.collect_schema()
    if all(t == pl.String for t in sch.values()):
        return lf
    return E.parquet_text(lf)


def _filters(lf: pl.LazyFrame, view: dict) -> pl.LazyFrame:
    rules = [f for f in view.get("filters") or [] if f.get("enabled", True) is not False and f.get("op")]
    if not rules:
        return lf
    cols = lf.collect_schema().names()
    exprs = []
    for f in rules:
        if f.get("op") != "formula" and f.get("column") not in cols:
            raise ValueError(f"No column {f.get('column')} in this file")
        e = E.build_filter({"column": f.get("column"), "op": f.get("op"), "value": f.get("value", ""),
                            "value2": f.get("value2", ""), "case_sensitive": bool(f.get("case_sensitive")),
                            "date_format": f.get("date_format") or ""}, cols)
        if e is not None:
            exprs.append(e)
    if not exprs:
        return lf
    if (view.get("join") or "and") == "or":
        return lf.filter(pl.any_horizontal(exprs))
    return lf.filter(pl.all_horizontal(exprs))


def _sort_keys(lf: pl.LazyFrame, col: str, desc: bool) -> pl.LazyFrame:
    """Numbers by number, everything else by text: a column of amounts sorts 9 before 10."""
    num = E._num(col).alias("__k_num")
    return (lf.with_columns(num, pl.col(col).alias("__k_txt"))
              .sort(["__k_num", "__k_txt"], descending=[desc, desc], nulls_last=True)
              .drop(["__k_num", "__k_txt"]))


def apply_view(lf: pl.LazyFrame, view: dict | None, sort: bool = True) -> pl.LazyFrame:
    view = view or {}
    lf = _filters(_plain(lf), view)
    cols = [c for c in view.get("columns") or [] if c]
    if cols:
        have = lf.collect_schema().names()
        miss = [c for c in cols if c not in have]
        lf = lf.select([pl.col(c) if c in have else pl.lit(None, dtype=pl.String).alias(c) for c in cols])
        if miss and len(miss) == len(cols):
            raise ValueError(f"None of the chosen columns is in this file ({', '.join(miss[:3])} …)")
    if view.get("unique"):
        lf = lf.unique(maintain_order=True)
    s = view.get("sort") or {}
    if sort and s.get("column") and s["column"] in lf.collect_schema().names():
        lf = _sort_keys(lf, s["column"], bool(s.get("desc")))
    return lf


def _needs_whole_file(view: dict | None) -> bool:
    v = view or {}
    return bool([f for f in v.get("filters") or [] if f.get("enabled", True) is not False and f.get("op")]
                or (v.get("sort") or {}).get("column") or v.get("unique"))


def _frame(path: str, source: dict | None, rows: int | None) -> pl.LazyFrame:
    """The file, lazily. `rows` set: only the start of it is read (a sample)."""
    src = _source(path, source)
    if rows:
        src = E.sample_source(src, rows)
    return E.load_lazy(src)


def _stored(path: str, lf: pl.LazyFrame) -> dict:
    """The types the file itself stores: Parquet's own; text and workbooks are text."""
    if E.is_parquet(Path(path)):
        try:
            return dict(pl.scan_parquet(path).collect_schema())
        except Exception:  # noqa: BLE001
            pass
    return dict(lf.collect_schema())


def _last_source(lf: pl.LazyFrame) -> pl.LazyFrame:
    names = lf.collect_schema().names()
    return lf.select([c for c in names if c != SOURCE_COL] + [SOURCE_COL]) if SOURCE_COL in names else lf


def _cheap_total(path: str) -> int | None:
    p = Path(path)
    if E.is_parquet(p):
        try:
            return int(pl.scan_parquet(p).select(pl.len()).collect().item())
        except Exception:  # noqa: BLE001
            return None
    return None


def schema(p: dict) -> dict:
    """The columns of a file and their stored types (Parquet keeps real types)."""
    path = p.get("path") or ""
    sch = _stored(path, _frame(path, p.get("source"), 50))
    return {"ok": True, "columns": list(sch), "dtypes": [str(t) for t in sch.values()],
            "total": _cheap_total(path), "kind": E.file_kind(Path(path)) if hasattr(E, "file_kind") else ""}


def browse(p: dict) -> dict:
    """One page of a file, after the view. No filter, sort or distinct: only the start of
    the file is read; otherwise the whole file is (once — big text files and workbooks
    are kept as a fast copy after that)."""
    t0 = time.time()
    path = p.get("path") or ""
    if not path:
        return {"ok": False, "error": "Click a file on the left first."}
    view = p.get("view") or {}
    offset = max(0, int(p.get("offset") or 0))
    limit = max(1, min(int(p.get("limit") or 200), PAGE_MAX))
    whole = _needs_whole_file(view)
    raw = _frame(path, p.get("source"), None if whole else offset + limit + 1)
    stored = _stored(path, raw)
    lf = apply_view(raw, view)
    page = lf.slice(offset, limit + 1).collect()
    more = page.height > limit
    page = page.head(limit)
    total = None if whole else _cheap_total(path)
    rows = [["" if v is None else str(v) for v in r] for r in page.iter_rows()]
    return {"ok": True, "file": Path(path).name, "columns": page.columns,
            "dtypes": [str(stored.get(c, pl.String)) for c in page.columns],
            "all_columns": list(stored), "rows": rows, "offset": offset, "more": more,
            "total": total, "whole": whole, "elapsed": round(time.time() - t0, 2)}


def count(p: dict, on_progress=None, cancel=None) -> dict:
    """Rows after the view, file by file."""
    t0 = time.time()
    files = [f for f in p.get("files") or [] if f]
    if not files:
        return {"ok": False, "error": "Tick at least one file."}
    view = {**(p.get("view") or {}), "sort": None}
    per, total = [], 0
    for i, f in enumerate(files, 1):
        E._check_cancel(cancel)
        if on_progress:
            on_progress({"stage": "read", "file": Path(f).name, "index": i, "total": len(files)})
        try:
            n = int(apply_view(_frame(f, p.get("source"), None), view, sort=False)
                    .select(pl.len()).collect(engine="streaming").item())
            per.append({"file": Path(f).name, "rows": n})
            total += n
        except E.Cancelled:
            raise
        except Exception as exc:  # noqa: BLE001 — one unreadable file doesn't stop the count
            per.append({"file": Path(f).name, "rows": None, "error": E.brief(exc)})
    return {"ok": True, "total": total, "files": per, "elapsed": round(time.time() - t0, 2)}


def _staged(files: list[str], source: dict | None, view: dict | None, stage: Path, add_source: bool,
            on_progress=None, cancel=None, sort: bool = False) -> tuple[list[Path], list[dict]]:
    """Each file through the view into a staged Parquet part: one file in memory at a time."""
    parts, per = [], []
    for i, f in enumerate(files, 1):
        E._check_cancel(cancel)
        name = Path(f).name
        if on_progress:
            on_progress({"stage": "read", "file": name, "index": i, "total": len(files)})
        try:
            lf = apply_view(_frame(f, source, None), view, sort=sort)
            if add_source:
                lf = lf.with_columns(pl.lit(name).alias(SOURCE_COL))
            part = stage / f"p{i:05d}.parquet"
            E._sink(lf, part)
            n = int(pl.scan_parquet(part).select(pl.len()).collect().item())
            parts.append(part)
            per.append({"file": name, "rows": n})
        except E.Cancelled:
            raise
        except Exception as exc:  # noqa: BLE001
            per.append({"file": name, "rows": None, "error": E.brief(exc)})
    if len(parts) > 1:
        E._align_stage(parts)
    return parts, per


def _dest(p: dict, ext: str) -> Path:
    if p.get("path"):
        return Path(p["path"]).expanduser()
    folder = p.get("folder") or ""
    if not folder:
        raise ValueError("Choose a folder to write to first.")
    name = (p.get("name") or "combined").strip() or "combined"
    name = E._safe_name(name[:-len(ext)] if name.lower().endswith(ext) else name, 120)
    return E._norm(folder) / f"{name}{ext}"


COMPRESSIONS = ("zstd", "snappy", "gzip", "lz4", "uncompressed")


def combine(p: dict, on_progress=None, cancel=None) -> dict:
    """Many files into one Parquet file. Each is read as the source settings say (sheet,
    header row, separator), optionally through a view; the columns are matched by name
    (one file's missing column is blank); numbers and dates are typed unless asked not
    to; SOURCE_FILE says where each row came from."""
    t0 = time.time()
    files = [f for f in p.get("files") or [] if f]
    if not files:
        return {"ok": False, "error": "Tick the files to combine."}
    dest = _dest(p, ".parquet")
    comp = p.get("compression") if p.get("compression") in COMPRESSIONS else "zstd"
    stage = E._stage_dir()
    try:
        parts, per = _staged(files, p.get("source"), p.get("view"), stage, p.get("add_source", True) is not False,
                             on_progress, cancel)
        if not parts:
            errs = [f"{x['file']} — {x.get('error')}" for x in per if x.get("error")]
            return {"ok": False, "error": errs[0] if errs else "Nothing to combine.", "files": per}
        if on_progress:
            on_progress({"stage": "write", "part": dest.name})
        lf = _last_source(pl.scan_parquet(parts))
        s = (p.get("view") or {}).get("sort") or {}
        if s.get("column") and s["column"] in lf.collect_schema().names():
            lf = _sort_keys(lf, s["column"], bool(s.get("desc")))
        plan = E.parquet_plan(lf, p.get("formats"), p.get("detect", True) is not False)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".part")
        out = lf.with_columns(plan) if plan else lf
        try:
            out.sink_parquet(tmp, compression=comp, row_group_size=int(p.get("row_group") or 122_880))
        except Exception:  # noqa: BLE001 — a plan the streaming sink can't take
            out.collect(engine="streaming").write_parquet(tmp, compression=comp)
        E._replace(tmp, dest)
        sch = pl.scan_parquet(dest).collect_schema()
        rows = int(pl.scan_parquet(dest).select(pl.len()).collect().item())
        typed = [c for c, t in sch.items() if t != pl.String]
        errors = [f"{x['file']} — {x['error']}" for x in per if x.get("error")]
        return {"ok": True, "written": [str(dest)], "rows": rows, "files": per, "errors": errors,
                "columns": len(sch), "typed": typed, "size": dest.stat().st_size,
                "elapsed": round(time.time() - t0, 2)}
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def export(p: dict, on_progress=None, cancel=None) -> dict:
    """The view over the ticked files, written as CSV / TXT / XLSX / Parquet: one file
    (`mode` "one", rows stacked by column name) or one file per input ("per_file")."""
    t0 = time.time()
    files = [f for f in p.get("files") or [] if f]
    if not files:
        return {"ok": False, "error": "Tick at least one file."}
    fmt = p.get("format") or "csv"
    if fmt not in ("csv", "txt", "xlsx", "parquet"):
        return {"ok": False, "error": f"Unknown format {fmt}"}
    out = {**(p.get("output") or {}), "folder": p.get("folder") or (p.get("output") or {}).get("folder"),
           "format": fmt}
    if not out.get("folder"):
        return {"ok": False, "error": "Choose a folder to write to first."}
    stem = E._safe_name((p.get("name") or "export").strip() or "export", 120)
    mode = p.get("mode") or "one"
    add_source = bool(p.get("add_source")) and mode == "one"
    stage = E._stage_dir()
    written: list[str] = []
    try:
        parts, per = _staged(files, p.get("source"), p.get("view"), stage, add_source, on_progress, cancel,
                             sort=mode != "one")
        if not parts:
            errs = [f"{x['file']} — {x.get('error')}" for x in per if x.get("error")]
            return {"ok": False, "error": errs[0] if errs else "Nothing to write.", "files": per}
        ok_files = [x for x in per if not x.get("error")]
        if mode == "one":
            lf = _last_source(pl.scan_parquet(parts))
            s = (p.get("view") or {}).get("sort") or {}
            if s.get("column") and s["column"] in lf.collect_schema().names():
                lf = _sort_keys(lf, s["column"], bool(s.get("desc")))
                sorted_part = stage / "sorted.parquet"
                E._sink(lf, sorted_part)
                lf = pl.scan_parquet(sorted_part)
            total = sum(x["rows"] for x in ok_files)
            if on_progress:
                on_progress({"stage": "write", "part": stem})
            written += E.write_parts(lf, total, out, stem, fmt, cancel)
        else:
            used: set[str] = set()
            for part, info in zip(parts, ok_files):
                E._check_cancel(cancel)
                name = E._unique(f"{stem}_{E._safe_name(Path(info['file']).stem, 80)}", used)
                if on_progress:
                    on_progress({"stage": "write", "part": name})
                written += E.write_parts(pl.scan_parquet(part), info["rows"], out, name, fmt, cancel)
        errors = [f"{x['file']} — {x['error']}" for x in per if x.get("error")]
        return {"ok": True, "written": written, "rows": sum(x["rows"] for x in ok_files), "files": per,
                "errors": errors, "elapsed": round(time.time() - t0, 2)}
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def write_rows(p: dict) -> dict:
    """A small table from the interface (PDF text or search hits) as CSV / XLSX / Parquet."""
    cols = [str(c) for c in p.get("columns") or []]
    rows = p.get("rows") or []
    if not cols:
        return {"ok": False, "error": "Nothing to write."}
    path = Path(p.get("path") or "")
    if not str(path):
        return {"ok": False, "error": "No file name."}
    df = pl.DataFrame([[None if v is None else str(v) for v in r] + [None] * (len(cols) - len(r)) for r in rows],
                      schema={c: pl.String for c in cols}, orient="row") if rows else \
        pl.DataFrame(schema={c: pl.String for c in cols})
    fmt = path.suffix.lower().lstrip(".") or "csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "parquet":
        E.write_parquet(df.lazy(), path, E.parquet_plan(df.lazy(), None, True))
    elif fmt == "xlsx":
        E.write_xlsx_book(path, [{"name": p.get("sheet") or "Data", "lf": df.lazy(), "rows": df.height}],
                          {"header": True, "autofilter": True})
    else:
        df.write_csv(path, separator="\t" if fmt == "txt" else ",")
    return {"ok": True, "path": str(path), "rows": df.height}
