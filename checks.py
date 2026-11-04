"""Checks that pass or fail a run.

A setup can carry checks — reconciliations over the tables it builds — that are
worked out after every group and combine step is built and before anything is
written:

    rows        the table has between Min and Max rows
    same_rows   the table has as many rows as another table
    unique      each key (one column or several together) appears once
    not_blank   a column is never blank
    found       every value of a column is found in a column of another table
    totals      a column's total equals another table's column total, or a number
    sql_empty   a SELECT over the tables returns no rows

Each check either stops the run (nothing is written) or only warns. The results
go to the window, to a Checks sheet (or _checks file) beside the output, to the
run log and to the command line's exit code.

The module knows nothing about groups or files: it is handed a function that
turns a table name into a LazyFrame, and one that runs a SELECT.
"""

from __future__ import annotations

import math
import uuid
from typing import Any, Callable

import polars as pl

import formula as F

KINDS = [  # id, label, what it checks
    ("rows", "Row count", "The table has at least Min and at most Max rows (leave one blank for no limit)."),
    ("same_rows", "Same rows as", "The table has exactly as many rows as another table."),
    ("unique", "No repeated keys", "Each key — one column, or several together — appears once. Blank keys are ignored."),
    ("not_blank", "No blanks", "The column is never blank."),
    ("found", "Every key found in", "Every value of the column is found in a column of another table (a lookup that misses nothing)."),
    ("totals", "Totals agree", "The column's total equals another table's column total — or a number — within the tolerance."),
    ("sql_empty", "Query finds nothing", "A SELECT over the tables returns no rows, e.g. SELECT * FROM Sales WHERE AMOUNT < 0."),
]
KIND_IDS = [k for k, _, _ in KINDS]
ON_FAIL = [("stop", "Stop — write nothing"), ("warn", "Warn and write")]
EXAMPLES = 5
SHEET = "Checks"


class CheckError(ValueError):
    pass


def meta() -> dict:
    return {"kinds": [{"id": i, "label": l, "help": h} for i, l, h in KINDS],
            "on_fail": [{"id": i, "label": l} for i, l in ON_FAIL]}


def _num(v: Any) -> float | None:
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    try:
        x = float(str(v).replace(",", "").strip())
    except ValueError:
        return None
    return None if math.isnan(x) else x


def _cols(v: Any) -> list[str]:
    if isinstance(v, str):
        v = v.split(",")
    return [str(c).strip() for c in v or [] if str(c).strip()]


def normalize(c: dict) -> dict:
    c = dict(c or {})
    kind = c.get("kind") if c.get("kind") in KIND_IDS else "rows"
    return {**c, "id": c.get("id") or "c" + uuid.uuid4().hex[:8], "kind": kind,
            "enabled": c.get("enabled", True) is not False,
            "name": str(c.get("name") or "").strip(),
            "table": str(c.get("table") or "").strip(), "cols": _cols(c.get("cols")),
            "table2": str(c.get("table2") or "").strip(), "col2": str(c.get("col2") or "").strip(),
            "fold": bool(c.get("fold", False)),
            "on_fail": c.get("on_fail") if c.get("on_fail") in ("stop", "warn") else "stop"}


def describe(c: dict) -> str:
    """What the check says, in a line — its name when it has none."""
    k, t, cols = c["kind"], c.get("table") or "the table", c.get("cols") or []
    col = cols[0] if cols else "?"
    other = f"{c.get('table2') or '?'}.{c.get('col2') or col}"
    if k == "rows":
        lo, hi = _num(c.get("min")), _num(c.get("max"))
        if lo is not None and hi is not None:
            return f"{t} has {_n(lo)}–{_n(hi)} rows" if lo != hi else f"{t} has {_n(lo)} rows"
        if hi is not None:
            return f"{t} has at most {_n(hi)} rows"
        return f"{t} has at least {_n(lo if lo is not None else 1)} row{'' if lo == 1 or lo is None else 's'}"
    if k == "same_rows":
        return f"{t} has as many rows as {c.get('table2') or '?'}"
    if k == "unique":
        return f"{t}: {' + '.join(cols) or '?'} never repeats"
    if k == "not_blank":
        return f"{t}: {col} is never blank"
    if k == "found":
        return f"{t}.{col} is all found in {other}"
    if k == "totals":
        if c.get("table2"):
            return f"{t}.{col} total = {other} total"
        return f"{t}.{col} total = {c.get('value') or '?'}"
    return f"Query finds nothing: {(c.get('sql') or '').strip()[:60]}"


def _n(x: float) -> str:
    return f"{int(x):,}" if float(x).is_integer() else f"{x:,.2f}"


def _key_expr(col: str, fold: bool) -> pl.Expr:
    e = pl.col(col).cast(pl.String).str.strip_chars()
    return e.str.to_lowercase() if fold else e


def _need(lf: pl.LazyFrame, table: str, cols: list[str]) -> None:
    have = lf.collect_schema().names()
    miss = [c for c in cols if c not in have]
    if miss:
        raise CheckError(f"{table} has no column {', '.join(miss)}")


def _rows(lf: pl.LazyFrame) -> int:
    return int(lf.select(pl.len()).collect().item())


def _one(c: dict, frame: Callable[[str], pl.LazyFrame], sql: Callable[[str], pl.LazyFrame] | None) -> dict:
    """status, detail, value, examples for one check."""
    k, t = c["kind"], c["table"]
    if k == "sql_empty":
        q = str(c.get("sql") or "").strip()
        if not q:
            raise CheckError("write a SELECT")
        if sql is None:
            raise CheckError("queries can't run here")
        lf = sql(q)
        df = lf.head(EXAMPLES).collect()
        n = _rows(lf) if df.height == EXAMPLES else df.height
        ex = [" · ".join(f"{col}={'' if v is None else v}" for col, v in zip(df.columns, r)) for r in df.iter_rows()]
        return {"ok": n == 0, "value": n, "examples": ex,
                "detail": "no rows" if n == 0 else f"{n:,} row{'' if n == 1 else 's'} found"}
    lf = frame(t)
    if k == "rows":
        n = _rows(lf)
        lo, hi = _num(c.get("min")), _num(c.get("max"))
        if lo is None and hi is None:
            lo = 1
        ok = (lo is None or n >= lo) and (hi is None or n <= hi)
        want = (f"between {_n(lo)} and {_n(hi)}" if lo is not None and hi is not None
                else f"at least {_n(lo)}" if lo is not None else f"at most {_n(hi)}")
        return {"ok": ok, "value": n, "detail": f"{n:,} rows" + ("" if ok else f" — expected {want}")}
    if k == "same_rows":
        if not c["table2"]:
            raise CheckError("choose the table to compare with")
        n, m = _rows(lf), _rows(frame(c["table2"]))
        return {"ok": n == m, "value": n - m,
                "detail": f"{n:,} rows, {c['table2']} {m:,}" + ("" if n == m else f" — {abs(n - m):,} {'more' if n > m else 'fewer'}")}
    cols = c["cols"]
    if not cols:
        raise CheckError("choose a column")
    _need(lf, t, cols)
    if k == "unique":
        keys = [_key_expr(col, c["fold"]).alias(col) for col in cols]
        blank = pl.all_horizontal([(pl.col(col).is_null() | (pl.col(col) == "")) for col in cols])
        rep = (lf.select(keys).filter(~blank).group_by(cols).agg(pl.len().alias("__n"))
               .filter(pl.col("__n") > 1).sort("__n", descending=True))
        stats = rep.select(pl.len().alias("keys"), pl.col("__n").sum().alias("rows")).collect().row(0)
        nkeys, nrows = int(stats[0] or 0), int(stats[1] or 0)
        ex = [f"{' + '.join(str(v) for v in r[:-1])} ×{r[-1]}" for r in rep.head(EXAMPLES).collect().iter_rows()]
        return {"ok": nkeys == 0, "value": nkeys, "examples": ex,
                "detail": "every key appears once" if nkeys == 0 else
                f"{nkeys:,} key{'' if nkeys == 1 else 's'} repeat, over {nrows:,} rows"}
    col = cols[0]
    if k == "not_blank":
        e = pl.col(col).cast(pl.String).str.strip_chars()
        n = int(lf.select((e.is_null() | (e == "")).sum()).collect().item() or 0)
        total = _rows(lf)
        return {"ok": n == 0, "value": n,
                "detail": "never blank" if n == 0 else f"blank in {n:,} of {total:,} rows"}
    if k == "found":
        if not c["table2"]:
            raise CheckError("choose the table to look in")
        other = frame(c["table2"])
        col2 = c["col2"] or col
        _need(other, c["table2"], [col2])
        left = lf.select(_key_expr(col, c["fold"]).alias("__k")).filter(pl.col("__k").is_not_null() & (pl.col("__k") != "")).unique()
        right = other.select(_key_expr(col2, c["fold"]).alias("__k")).unique()
        miss = left.join(right, on="__k", how="anti").sort("__k")
        n = _rows(miss)
        ex = [str(v) for v in miss.head(EXAMPLES).collect()["__k"].to_list()]
        return {"ok": n == 0, "value": n, "examples": ex,
                "detail": "every value found" if n == 0 else
                f"{n:,} value{'' if n == 1 else 's'} not found in {c['table2']}.{col2}"}
    if k == "totals":
        a = lf.select(F.clean_number(pl.col(col)).sum()).collect().item() or 0.0
        if c["table2"]:
            other = frame(c["table2"])
            col2 = c["col2"] or col
            _need(other, c["table2"], [col2])
            b = other.select(F.clean_number(pl.col(col2)).sum()).collect().item() or 0.0
            against = f"{c['table2']}.{col2} {b:,.2f}"
        else:
            b = _num(c.get("value"))
            if b is None:
                raise CheckError("give the number the total should be, or a table to compare with")
            against = f"expected {b:,.2f}"
        tol = _num(c.get("tolerance"))
        tol = 0.005 if tol is None else abs(tol)
        diff = float(a) - float(b)
        ok = abs(diff) <= tol + 1e-9
        return {"ok": ok, "value": round(diff, 6),
                "detail": f"{col} {a:,.2f}, {against}" + ("" if ok else f" — off by {diff:,.2f}")}
    raise CheckError(f"unknown check “{k}”")


def evaluate(checks: list[dict], frame: Callable[[str], pl.LazyFrame], tables: list[str],
             sql: Callable[[str], pl.LazyFrame] | None = None, cancel=None, check_cancel=None) -> list[dict]:
    """Every enabled check, in order. A check that can't be worked out (a column
    that isn't there, a query that fails) counts as failed: it says why."""
    out = []
    first = tables[0] if tables else ""
    for raw in checks or []:
        c = normalize(raw)
        if not c["enabled"]:
            continue
        if check_cancel:
            check_cancel(cancel)
        if not c["table"] and c["kind"] != "sql_empty":
            c["table"] = first
        r = {"id": c["id"], "name": c["name"] or describe(c), "kind": c["kind"], "table": c["table"],
             "on_fail": c["on_fail"], "examples": []}
        try:
            got = _one(c, frame, sql)
            r.update(status="pass" if got["ok"] else "fail", detail=got["detail"],
                     value=got.get("value"), examples=got.get("examples") or [])
        except Exception as exc:  # noqa: BLE001 — a broken check fails, it doesn't sink the run
            if type(exc).__name__ == "Cancelled":
                raise
            msg = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
            r.update(status="error", detail=f"couldn't be checked — {msg[:300]}", value=None)
        out.append(r)
    return out


def failed(results: list[dict]) -> list[dict]:
    return [r for r in results or [] if r["status"] != "pass"]


def verdict(results: list[dict]) -> dict:
    """stop: a check that stops the run failed; error: the line to show for it;
    warnings: one line per failed check that only warns."""
    bad = failed(results)
    stops = [r for r in bad if r["on_fail"] == "stop"]
    line = lambda r: f"{r['name']}: {r['detail']}" + (f" (e.g. {', '.join(r['examples'][:3])})" if r.get("examples") else "")
    return {"stop": bool(stops), "passed": len(results) - len(bad), "failed": len(bad),
            "error": (f"Stopped before writing — {len(stops)} check{'' if len(stops) == 1 else 's'} failed: "
                      + "; ".join(line(r) for r in stops)) if stops else "",
            "warnings": [f"Check failed — {line(r)}" for r in bad if r["on_fail"] == "warn"]}


def grid(results: list[dict]) -> dict:
    """The Checks sheet: one row per check."""
    rows = [{"cells": ["Check", "Table", "Result", "Detail", "Examples"], "nums": [None] * 5, "kind": "head"}]
    word = {"pass": "PASS", "fail": "FAIL", "error": "FAIL"}
    for r in results:
        res = word[r["status"]] + ("" if r["status"] == "pass" or r["on_fail"] == "stop" else " (warning)")
        rows.append({"cells": [r["name"], r.get("table") or "", res, r["detail"], ", ".join(r.get("examples") or [])],
                     "nums": [None] * 5, "kind": "data"})
    return {"name": SHEET, "grid": rows, "fmts": []}


def log_lines(results: list[dict]) -> list[str]:
    if not results:
        return []
    v = verdict(results)
    lines = ["", f"Checks: {v['passed']} passed, {v['failed']} failed"]
    for r in results:
        mark = "ok  " if r["status"] == "pass" else ("STOP" if r["on_fail"] == "stop" else "WARN")
        lines.append(f"  {mark} {r['name']} — {r['detail']}")
        if r.get("examples") and r["status"] != "pass":
            lines.append(f"       e.g. {', '.join(r['examples'])}")
    return lines
