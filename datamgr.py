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


# ---- compare two files by key ---------------------------------------------------

CMP_PREVIEW = 500
KEY_SEP = "\x1f"


def _cmp_text(e: pl.Expr, o: dict) -> pl.Expr:
    """A value as compared: text, trimmed unless asked not to, case folded on request."""
    t = e.cast(pl.String).fill_null("")
    if o.get("trim", True) is not False:
        t = t.str.strip_chars()
    if o.get("case"):
        t = t.str.to_uppercase()
    return t


def _cmp_key(cols: list[str], o: dict) -> pl.Expr:
    parts = []
    for c in cols:
        k = _cmp_text(pl.col(c), {**o, "case": o.get("key_case", True)})
        if o.get("zeros"):
            k = k.str.replace(r"^0+(\d)", "$1")
        parts.append(k)
    return pl.concat_str(parts, separator=KEY_SEP).alias("__k")


def _num_of(t: pl.Expr) -> pl.Expr:
    """Text as a number, as ColSift reads amounts: 1,234.50 and (250) included."""
    return t.str.replace_all(r"[,\s]", "").str.replace_all(r"^\((.*)\)$", r"-$1").cast(pl.Float64, strict=False)


def _differs(a: pl.Expr, b: pl.Expr, o: dict) -> pl.Expr:
    """True where the two sides differ. Both numbers: by number, within `tol`."""
    ta, tb = _cmp_text(a, o), _cmp_text(b, o)
    if o.get("numbers", True) is False:
        return ta != tb
    na, nb = _num_of(ta), _num_of(tb)
    tol = float(o.get("tol") or 0)
    both = na.is_not_null() & nb.is_not_null()
    return pl.when(both).then((na - nb).abs() > tol + 1e-9).otherwise(ta != tb)


def compare(p: dict, on_progress=None, cancel=None) -> dict:
    """Two files — an old and a new extract, two months, two systems — lined up by a key.

    {a, b: paths, source, keys: [...], columns: [...] (default: every column both have),
     trim, case, zeros (leading zeros in keys), numbers (1.50 = 1.5), tol, folder, name,
     format: "xlsx" | "csv" | "parquet" | "" (no file)}

    Returns the counts — only in A (removed), only in B (added), changed, the same —
    the changes per column, keys that repeat, and the first rows of each. With a folder,
    writes them: one workbook with Summary, Added, Removed and Changed sheets (Changed:
    a row per changed value — the key, the column, old and new)."""
    t0 = time.time()
    a, b = p.get("a") or "", p.get("b") or ""
    if not a or not b:
        return {"ok": False, "error": "Pick the two files to compare."}
    keys = [k for k in p.get("keys") or [] if k]
    if not keys:
        return {"ok": False, "error": "Pick the column (or columns) that identify a row — a ticket or document number."}
    o = {k: p.get(k) for k in ("trim", "case", "zeros", "numbers", "tol", "key_case")}
    stage = E._stage_dir()
    try:
        frames = {}
        for side, path in (("A", a), ("B", b)):
            E._check_cancel(cancel)
            if on_progress:
                on_progress({"stage": "read", "file": Path(path).name, "index": 1 if side == "A" else 2, "total": 2})
            lf = _plain(_frame(path, p.get("source"), None))
            have = lf.collect_schema().names()
            miss = [k for k in keys if k not in have]
            if miss:
                return {"ok": False, "error": f"{Path(path).name} has no column {', '.join(miss)}"}
            frames[side] = (lf, have)
        common = [c for c in frames["A"][1] if c in frames["B"][1] and c not in keys]
        cols = [c for c in (p.get("columns") or common) if c in common]
        only_a = [c for c in frames["A"][1] if c not in frames["B"][1]]
        only_b = [c for c in frames["B"][1] if c not in frames["A"][1]]
        staged = {}
        for side in ("A", "B"):
            lf, have = frames[side]
            want = keys + [c for c in cols]
            path = stage / f"{side}.parquet"
            E._sink(lf.select([pl.col(c) for c in want]).with_columns(_cmp_key(keys, o)).with_row_index("__r"), path)
            staged[side] = path
        A, B = pl.scan_parquet(staged["A"]), pl.scan_parquet(staged["B"])
        dups = {}
        for side, lf in (("A", A), ("B", B)):
            d = lf.group_by("__k").agg(pl.len().alias("n"), pl.first(keys[0]).alias("key")).filter(pl.col("n") > 1)
            got = d.select(pl.len(), pl.col("n").sum()).collect()
            ex = d.sort("n", descending=True).head(10).collect()
            dups[side] = {"keys": int(got.item(0, 0)), "rows": int(got.item(0, 1) or 0),
                          "examples": [f"{k} ×{n}" for k, n in zip(ex["key"], ex["n"])]}
        A1, B1 = A.unique("__k", keep="first", maintain_order=True), B.unique("__k", keep="first", maintain_order=True)
        rename = {c: f"{c}__b" for c in keys + cols + ["__r"]}
        joined = A1.join(B1.rename(rename), on="__k", how="full", coalesce=True, nulls_equal=True)
        in_a = pl.col(keys[0]).is_not_null()
        in_b = pl.col(f"{keys[0]}__b").is_not_null()
        jpath = stage / "joined.parquet"
        E._check_cancel(cancel)
        if on_progress:
            on_progress({"stage": "write", "part": "comparing"})
        diff = [_differs(pl.col(c), pl.col(f"{c}__b"), o).alias(f"__d_{i}") for i, c in enumerate(cols)]
        E._sink(joined.with_columns(in_a.alias("__a"), in_b.alias("__b"), *diff), jpath)
        J = pl.scan_parquet(jpath)
        dcols = [f"__d_{i}" for i in range(len(cols))]
        both = J.filter(pl.col("__a") & pl.col("__b"))
        anyd = pl.any_horizontal([pl.col(c) for c in dcols]) if dcols else pl.lit(False)
        stats = J.select(
            (pl.col("__a") & ~pl.col("__b")).sum().alias("removed"), (~pl.col("__a") & pl.col("__b")).sum().alias("added"),
            (pl.col("__a") & pl.col("__b")).sum().alias("both"),
            (pl.col("__a") & pl.col("__b") & anyd).sum().alias("changed"),
            *[(pl.col("__a") & pl.col("__b") & pl.col(c)).sum().alias(c) for c in dcols]).collect().row(0, named=True)
        per_col = {c: int(stats[f"__d_{i}"]) for i, c in enumerate(cols) if stats[f"__d_{i}"]}
        # in file order: removed as A has them, added as B has them, changes row by row
        removed = J.filter(pl.col("__a") & ~pl.col("__b")).sort("__r").select(keys + cols)
        added = J.filter(~pl.col("__a") & pl.col("__b")).sort("__r__b").select([pl.col(f"{c}__b").alias(c) for c in keys + cols])
        long = pl.concat([both.filter(pl.col(f"__d_{i}")).select(
            pl.col("__r"), pl.lit(i, dtype=pl.UInt32).alias("__c"),
            *[pl.col(k) for k in keys], pl.lit(c).alias("COLUMN"), pl.col(c).cast(pl.String).alias("OLD"),
            pl.col(f"{c}__b").cast(pl.String).alias("NEW")) for i, c in enumerate(cols)], how="vertical") \
            .sort(["__r", "__c"]).drop(["__r", "__c"]) \
            if cols else pl.DataFrame(schema={**{k: pl.String for k in keys}, "COLUMN": pl.String, "OLD": pl.String,
                                              "NEW": pl.String}).lazy()
        n = int(p.get("preview") or CMP_PREVIEW)
        rows = lambda lf: [["" if v is None else str(v) for v in r] for r in lf.head(n).collect().iter_rows()]  # noqa: E731
        res = {"ok": True, "a": Path(a).name, "b": Path(b).name, "keys": keys, "columns": cols,
               "only_in_a_columns": only_a, "only_in_b_columns": only_b,
               "counts": {"removed": int(stats["removed"]), "added": int(stats["added"]), "same": int(stats["both"]) - int(stats["changed"]),
                          "changed": int(stats["changed"]), "values_changed": sum(per_col.values())},
               "per_column": per_col, "duplicates": dups,
               "removed": {"columns": keys + cols, "rows": rows(removed)},
               "added": {"columns": keys + cols, "rows": rows(added)},
               "changed": {"columns": keys + ["COLUMN", "OLD", "NEW"], "rows": rows(long)}}
        fmt = p.get("format") or ""
        if fmt and p.get("folder"):
            E._check_cancel(cancel)
            stem = E._safe_name((p.get("name") or "compare").strip() or "compare", 120)
            summary = pl.DataFrame({"WHAT": ["File A (old)", "File B (new)", "Key", "Only in A — removed", "Only in B — added",
                                             "In both, changed", "In both, the same", "Values changed",
                                             "Keys repeated in A", "Keys repeated in B"] +
                                            [f"Changed: {c}" for c in per_col],
                                    "VALUE": [res["a"], res["b"], " + ".join(keys), *[str(res["counts"][k]) for k in
                                              ("removed", "added", "changed", "same", "values_changed")],
                                              str(dups["A"]["keys"]), str(dups["B"]["keys"])] + [str(v) for v in per_col.values()]})
            parts = {"Summary": summary.lazy(), "Added": added, "Removed": removed, "Changed": long}
            out = {**(p.get("output") or {}), "folder": p["folder"]}
            written = []
            if fmt == "xlsx":
                sheets = []
                for name, lf in parts.items():
                    cnt = int(lf.select(pl.len()).collect().item())
                    if cnt > E.XLSX_MAX_ROWS:
                        raise ValueError(f"{name} has {cnt:,} rows — too many for one Excel sheet. Choose CSV or Parquet.")
                    sheets.append({"name": name, "lf": lf, "rows": cnt})
                path = E._out_path(out, stem, "xlsx")
                E.write_xlsx_book(path, sheets, {"header": True, "autofilter": True, **out}, cancel)
                written.append(str(path))
            else:
                for name, lf in parts.items():
                    cnt = int(lf.select(pl.len()).collect().item())
                    written += E.write_parts(lf, cnt, {**out, "format": fmt}, f"{stem}_{name.lower()}", fmt, cancel)
            res["written"] = written
        res["elapsed"] = round(time.time() - t0, 2)
        return res
    finally:
        shutil.rmtree(stage, ignore_errors=True)


# ---- SQL over the ticked files -------------------------------------------------

ALL_TABLE = "files"


def table_names(files: list[str]) -> list[tuple[str, str]]:
    """Each file's table name: its name without the extension, letters, digits and _
    (sales_JAN.csv → sales_JAN); a name used twice gets _2, _3."""
    import re
    out, used = [], {ALL_TABLE}
    for f in files:
        base = re.sub(r"\W+", "_", Path(f).stem).strip("_") or "file"
        if base[0].isdigit():
            base = f"t_{base}"
        name, i = base, 2
        while name.lower() in used:
            name, i = f"{base}_{i}", i + 1
        used.add(name.lower())
        out.append((name, f))
    return out


def tables(p: dict) -> dict:
    """The tables a query can name, with their columns (headers only)."""
    files = [f for f in p.get("files") or [] if f]
    out = []
    for name, f in table_names(files):
        try:
            cols = list(_frame(f, p.get("source"), 50).collect_schema().names())
            out.append({"name": name, "file": Path(f).name, "path": f, "columns": cols})
        except Exception as exc:  # noqa: BLE001
            out.append({"name": name, "file": Path(f).name, "path": f, "columns": [], "error": E.brief(exc)})
    if len(files) > 1:
        cols = []
        for t in out:
            cols += [c for c in t["columns"] if c not in cols]
        out.append({"name": ALL_TABLE, "file": f"every ticked file, stacked, with {SOURCE_COL}", "path": "",
                    "columns": cols + [SOURCE_COL]})
    return {"ok": True, "tables": out}


def sql(p: dict, on_progress=None, cancel=None) -> dict:
    """A SELECT over the ticked files: each is a table named after the file, and `files`
    is all of them stacked (with SOURCE_FILE). Columns that hold only numbers read as
    numbers (IDs and codes stay text) unless `numbers` is "text". Shows the first
    `limit` rows; with `format` and a folder, writes every row of the result."""
    import workspace as W
    t0 = time.time()
    files = [f for f in p.get("files") or [] if f]
    if not files:
        return {"ok": False, "error": "Tick the files to query on the left."}
    names = dict(table_names(files))

    def get(name: str) -> pl.LazyFrame:
        if name == ALL_TABLE:
            parts = [_plain(_frame(f, p.get("source"), None)).with_columns(pl.lit(Path(f).name).alias(SOURCE_COL))
                     for f in files]
            return pl.concat(parts, how="diagonal_relaxed")
        return _plain(_frame(names[name], p.get("source"), None))

    try:
        lf, used = W.sql_over(p.get("query"), [*names, ALL_TABLE], get, p.get("numbers") or "auto")
    except W.WorkspaceError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — polars' own message says what is wrong
        return {"ok": False, "error": E.brief(exc)}
    if on_progress:
        on_progress({"stage": "read", "file": ", ".join(used), "index": 1, "total": 1})
    limit = max(1, min(int(p.get("limit") or 500), PAGE_MAX))
    try:
        res: dict = {"ok": True, "used": used}
        fmt = p.get("format") or ""
        if fmt and p.get("folder"):
            stage = E._stage_dir()
            try:
                part = stage / "result.parquet"
                E._sink(lf, part)
                total = int(pl.scan_parquet(part).select(pl.len()).collect().item())
                out = {**(p.get("output") or {}), "folder": p["folder"], "format": fmt}
                stem = E._safe_name((p.get("name") or "query").strip() or "query", 120)
                if on_progress:
                    on_progress({"stage": "write", "part": stem})
                res["written"] = E.write_parts(pl.scan_parquet(part), total, out, stem, fmt, cancel)
                res["total"] = total
                df = pl.scan_parquet(part).head(limit + 1).collect()
            finally:
                shutil.rmtree(stage, ignore_errors=True)
        else:
            df = lf.head(limit + 1).collect(engine="streaming")
    except E.Cancelled:
        raise
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": E.brief(exc)}
    res.update({"columns": df.columns, "dtypes": [str(t) for t in df.dtypes], "more": df.height > limit,
                "rows": [["" if v is None else str(v) for v in r] for r in df.head(limit).iter_rows()],
                "elapsed": round(time.time() - t0, 2)})
    return res
