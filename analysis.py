"""ColSift — analysis dashboard and Excel-style pivot summaries.

Everything here runs on the *extracted* frame: after filters, after renames,
after computed columns — the same frame the output is written from, so what the
Analysis tab shows and what lands in the exported sheets is one computation.

Two things are built on one engine:

  * **Dashboard items** — a KPI, a grouped total, a trend by month, a range
    distribution, a cross-tab, or a data-quality check. Each is a thin spec over
    the pivot below, so "Sum of AMOUNT by TAX_CODE" means the same in both.
  * **Summaries** — full pivots with several row and column fields, several
    value fields, per-field subtotals, grand totals, Excel's "show values as",
    top-N per field and date/number grouping.

Subtotals and grand totals are recomputed from the rows, never added up from the
cells above them, which is the only way Average, Distinct count and StdDev come
out right — Excel does the same. Every level is one group-by; they are all
collected in a single polars call.

Values in the frame are text, as everywhere else in ColSift: numeric aggregates
read them the Excel way ("1,234.50", "(250)", "5%"), and a value that isn't a
number is skipped by Sum the way an empty cell is.
"""

from __future__ import annotations

import re
from typing import Any

import polars as pl

import formula as F

# --------------------------------------------------------------------------
# what the UI offers
# --------------------------------------------------------------------------

AGGS = [   # id, label, group in the picker
    ("sum", "Sum", "Numbers"), ("average", "Average", "Numbers"), ("median", "Median", "Numbers"),
    ("min", "Min", "Numbers"), ("max", "Max", "Numbers"), ("product", "Product", "Numbers"),
    ("stddev", "StdDev (sample)", "Numbers"), ("stddevp", "StdDevP (whole set)", "Numbers"),
    ("var", "Var (sample)", "Numbers"), ("varp", "VarP (whole set)", "Numbers"),
    ("count", "Count — filled cells", "Counts"), ("count_num", "Count numbers", "Counts"),
    ("blanks", "Count blanks", "Counts"), ("distinct", "Distinct count", "Counts"),
    ("earliest", "Earliest date", "Dates"), ("latest", "Latest date", "Dates"),
    ("first", "First value", "Text"), ("last", "Last value", "Text"),
]
_NUMERIC = {"sum", "average", "median", "min", "max", "product", "stddev", "stddevp", "var", "varp"}
_COUNTS = {"count", "count_num", "blanks", "distinct"}
_AGG_LABEL = {a[0]: a[1] for a in AGGS}

SHOW_AS = [   # id, label — applied after the cells are computed, as in Excel
    ("none", "Plain value"),
    ("pct_grand", "% of grand total"), ("pct_row", "% of row"), ("pct_col", "% of column"),
    ("pct_parent", "% of its subtotal"),
    ("running", "Running total down the rows"), ("diff_prev", "Difference from the row above"),
    ("pct_prev", "% change from the row above"), ("rank", "Rank down the column"),
]
_PCT = {"pct_grand", "pct_row", "pct_col", "pct_parent", "pct_prev"}

GROUPINGS = [   # id, label, what it suits
    ("none", "As is", "Any"),
    ("year", "Year", "Date"), ("quarter", "Quarter", "Date"), ("month", "Month (2026-07)", "Date"),
    ("month_name", "Month name, years together", "Date"), ("week", "Week", "Date"),
    ("day", "Day", "Date"), ("weekday", "Day of the week", "Date"),
    ("bucket", "Number ranges", "Number"),
    ("first_letter", "First letter", "Text"), ("length", "Length", "Text"),
]

ITEM_KINDS = [   # id, label, group
    ("kpi", "One number", "Headline"),
    ("slicer", "Slicer — click values to filter the dashboard", "Interactive"),
    ("breakdown", "Total by a column", "Tables & charts"),
    ("trend", "Over time", "Tables & charts"),
    ("distribution", "Spread across ranges", "Tables & charts"),
    ("crosstab", "Cross-tab of two columns", "Tables & charts"),
    ("records", "Table of rows (top N)", "Tables & charts"),
    ("quality", "Data checks on chosen columns", "Checks"),
    ("studio", "Studio visual — designed in Measure Studio", "Visuals"),
]
STUDIO_MAX_ROWS = 500       # rows a Studio block gets: groups, periods or records

CHARTS = {   # the visuals each kind can draw; the first is the default
    "breakdown": [("none", "Table only"), ("bar", "Columns"), ("hbar", "Bars"), ("line", "Line"),
                  ("area", "Area"), ("pie", "Pie"), ("donut", "Donut")],
    "trend": [("line", "Line"), ("area", "Area"), ("bar", "Columns"), ("none", "Table only")],
    "distribution": [("bar", "Columns"), ("line", "Line"), ("area", "Area"), ("none", "Table only")],
    "crosstab": [("none", "Table only"), ("heatmap", "Heat map"), ("stacked", "Stacked columns"),
                 ("clustered", "Clustered columns"), ("line", "Lines")],
}
GROUP_SHORT = {"year": "Year", "quarter": "Quarter", "month": "Month", "month_name": "Month name",
               "week": "Week", "day": "Day", "weekday": "Weekday", "bucket": "Range",
               "first_letter": "First letter", "length": "Length"}
MAX_POINTS = 120          # labels sent for a chart; the table carries everything
FACET_LIMIT = 300         # values listed in a slicer or a filter picker

DEFAULT_FMT = {"sum": "#,##0.00", "average": "#,##0.00", "median": "#,##0.00", "min": "#,##0.00",
               "max": "#,##0.00", "product": "#,##0.00", "stddev": "#,##0.00", "stddevp": "#,##0.00",
               "var": "#,##0.00", "varp": "#,##0.00", "count": "#,##0", "count_num": "#,##0",
               "blanks": "#,##0", "distinct": "#,##0"}
BLANK = "(blank)"
GRAND = "Grand Total"
MAX_CELLS = 300_000      # a pivot big enough to be a second extract, not a summary
MAX_GROUPS = 50_000      # distinct row combinations


class AnalysisError(ValueError):
    pass


def meta() -> dict:
    return {"aggs": [{"id": a, "label": l, "group": g} for a, l, g in AGGS],
            "show_as": [{"id": i, "label": l} for i, l in SHOW_AS],
            "groupings": [{"id": i, "label": l, "for": w} for i, l, w in GROUPINGS],
            "item_kinds": [{"id": i, "label": l, "group": g} for i, l, g in ITEM_KINDS],
            "charts": {k: [{"id": i, "label": l} for i, l in v] for k, v in CHARTS.items()},
            "numeric_aggs": sorted(_NUMERIC), "default_formats": DEFAULT_FMT}


# --------------------------------------------------------------------------
# fields: the label you see, and the key it sorts on
# --------------------------------------------------------------------------

def _need(col: str, columns: list[str]) -> str:
    if col not in columns:
        near = [c for c in columns if c.lower() == str(col).lower()]
        if near:
            return near[0]
        raise AnalysisError(f"Column “{col}” isn't in the extract — it may have been unticked or renamed")
    return col


def _field_exprs(f: dict, columns: list[str]) -> tuple[pl.Expr, pl.Expr, pl.Expr]:
    """(label, numeric sort key, text sort key) for one row or column field."""
    col = _need(str(f.get("column") or ""), columns)
    g = f.get("group") or "none"
    raw = pl.col(col)
    txt = raw.fill_null("").str.strip_chars()
    blank = f.get("blank") or BLANK

    if g == "none":
        lab = pl.when(txt == "").then(pl.lit(blank)).otherwise(txt)
        return lab, F.clean_number(raw), txt
    if g in ("bucket", "length", "first_letter"):
        if g == "bucket":
            size = float(f.get("size") or 100) or 100.0
            n = F.clean_number(raw)
            lo = (n / size).floor() * size
            lab = pl.concat_str([F.fmt_general(lo), pl.lit(" to "), F.fmt_general(lo + size)])
            lab = pl.when(n.is_null()).then(pl.lit(blank)).otherwise(lab)
            return lab, lo, lab
        if g == "length":
            n = pl.when(txt == "").then(None).otherwise(txt.str.len_chars()).cast(pl.Float64)
            return pl.when(n.is_null()).then(pl.lit(blank)).otherwise(n.cast(pl.Int64).cast(pl.String)), n, txt
        first = txt.str.slice(0, 1).str.to_uppercase()
        lab = pl.when(txt == "").then(pl.lit(blank)).otherwise(first)
        return lab, pl.lit(None, pl.Float64), lab

    d = F.parse_date(raw, f.get("date_format"))
    pieces = {
        "year": (d.dt.year().cast(pl.String), d.dt.year()),
        "quarter": (pl.concat_str([d.dt.year().cast(pl.String), pl.lit(" Q"), d.dt.quarter().cast(pl.String)]),
                    d.dt.year() * 10 + d.dt.quarter()),
        "month": (d.dt.strftime("%Y-%m"), d.dt.year() * 100 + d.dt.month()),
        "month_name": (d.dt.strftime("%b"), d.dt.month()),
        "week": (d.dt.strftime("%G-W%V"), d.dt.iso_year() * 100 + d.dt.week()),
        "day": (d.dt.strftime("%Y-%m-%d"), d.dt.year() * 10000 + d.dt.month() * 100 + d.dt.day()),
        "weekday": (d.dt.strftime("%a"), d.dt.weekday()),
    }
    if g not in pieces:
        raise AnalysisError(f"Unknown grouping “{g}”")
    lab, key = pieces[g]
    return (pl.when(d.is_null()).then(pl.lit(blank)).otherwise(lab),
            key.cast(pl.Float64), pl.lit("").alias("t"))


def _value_exprs(v: dict, columns: list[str]) -> tuple[pl.Expr, pl.Expr]:
    """(numeric view, text view) of one value field — a column or a formula."""
    if str(v.get("expr") or "").strip():
        try:
            return F.num_expr(v["expr"], columns), F.text_expr(v["expr"], columns)
        except F.FormulaError as exc:
            raise AnalysisError(f"Value formula: {exc}") from None
    col = _need(str(v.get("column") or ""), columns)
    return F.clean_number(pl.col(col)), pl.col(col).cast(pl.String)


def _agg_expr(v: dict, columns: list[str]) -> pl.Expr:
    num, txt = _value_exprs(v, columns)
    agg = v.get("agg") or "sum"
    t = txt.fill_null("").str.strip_chars()
    filled = t != ""
    if agg == "sum":
        e = num.sum()
    elif agg == "average":
        e = num.mean()
    elif agg == "median":
        e = num.median()
    elif agg == "min":
        e = num.min()
    elif agg == "max":
        e = num.max()
    elif agg == "product":
        e = num.drop_nulls().product()
    elif agg in ("stddev", "stddevp"):
        e = num.std(ddof=1 if agg == "stddev" else 0)
    elif agg in ("var", "varp"):
        e = num.var(ddof=1 if agg == "var" else 0)
    elif agg == "count":
        e = filled.sum()
    elif agg == "count_num":
        e = num.is_not_null().sum()
    elif agg == "blanks":
        e = (~filled).sum()
    elif agg == "distinct":
        e = t.filter(filled).n_unique()
    elif agg in ("earliest", "latest"):
        d = F.parse_date(txt, v.get("date_format"))
        e = (d.min() if agg == "earliest" else d.max()).dt.strftime(F.to_strftime(v.get("fmt") or "yyyy-mm-dd"))
    elif agg in ("first", "last"):
        f = t.filter(filled)
        e = f.first() if agg == "first" else f.last()
    else:
        raise AnalysisError(f"Unknown aggregation “{agg}”")
    if agg in _NUMERIC:
        e = e.cast(pl.Float64)
    elif agg in _COUNTS:
        e = e.cast(pl.Int64).cast(pl.Float64)
    else:
        e = e.cast(pl.String)
    return e


def value_name(v: dict) -> str:
    if str(v.get("name") or "").strip():
        return v["name"].strip()
    what = v.get("expr") or v.get("column") or "?"
    return f"{_AGG_LABEL.get(v.get('agg') or 'sum', 'Sum')} of {what}"


def _is_numeric(v: dict) -> bool:
    return (v.get("agg") or "sum") in _NUMERIC or (v.get("agg") or "sum") in _COUNTS


def _fmt_for(v: dict, show_as: str) -> str | None:
    if not _is_numeric(v):
        return None
    if show_as in _PCT:
        return v.get("pct_fmt") or "0.0%"
    if show_as == "rank":
        return "#,##0"
    return v.get("fmt") or DEFAULT_FMT.get(v.get("agg") or "sum") or "#,##0.00"


# --------------------------------------------------------------------------
# report filters (the pivot's own, on top of the extract's)
# --------------------------------------------------------------------------

def _filter_expr(f: dict, columns: list[str]) -> pl.Expr | None:
    """One filter: keep (or drop) the rows whose label is in the list. The label is the
    field as the pivot shows it — so a filter on "Month" of ISSUE_DATE keeps "2026-07",
    and "(blank)" matches empty cells. That is what makes a clicked bar or pivot cell
    turn into exactly the rows behind it."""
    vals = [str(x) for x in (f.get("values") or []) if str(x) != ""]
    if not vals or f.get("enabled") is False:
        return None
    keep = _field_exprs(f, columns)[0].is_in(vals)
    return ~keep if f.get("mode", "keep") == "drop" else keep


def _apply_report_filters(lf: pl.LazyFrame, spec: dict, columns: list[str], skip=None) -> pl.LazyFrame:
    for f in spec.get("filters") or []:
        if skip is not None and skip(f):
            continue
        e = _filter_expr(f, columns)
        if e is not None:
            lf = lf.filter(e)
    return lf


def usable_filters(filters: list[dict] | None, columns: list[str], notes: list[str] | None = None) -> list[dict]:
    """Dashboard filters whose column the frame has. A filter left over from a column that
    was renamed or unticked is reported, not allowed to blank every card."""
    out = []
    for f in filters or []:
        if f.get("enabled") is False or not [v for v in (f.get("values") or []) if str(v) != ""]:
            continue
        try:
            _need(str(f.get("column") or ""), columns)
            out.append(f)
        except AnalysisError as exc:
            if notes is not None:
                notes.append(f"Filter ignored — {exc}")
    return out


def describe_filters(filters: list[dict] | None) -> str:
    bits = []
    for f in filters or []:
        vals = [str(v) for v in (f.get("values") or []) if str(v) != ""]
        if not vals or f.get("enabled") is False:
            continue
        g = f.get("group") or "none"
        name = f.get("column") or "?"
        if g != "none":
            name = f"{GROUP_SHORT.get(g, g)} of {name}"
        shown = ", ".join(vals[:6]) + (f" +{len(vals) - 6}" if len(vals) > 6 else "")
        bits.append(f"{name} {'is not' if f.get('mode') == 'drop' else 'is'} {shown}")
    return "; ".join(bits)


def facets(lf: pl.LazyFrame, field: dict, columns: list[str], limit: int = FACET_LIMIT) -> dict:
    """The distinct labels of a field with their row counts — what a slicer or a filter
    picker lists. Past `limit` values, the most frequent ones are kept."""
    lab, kn, kt = _field_exprs(field, columns)
    df = (lf.select(lab.alias("l"), kn.alias("n"), kt.alias("t"))
            .group_by("l").agg(pl.len().alias("c"), pl.col("n").first(), pl.col("t").first())
            .collect())
    total = df.height
    if total > limit:
        df = df.sort("c", descending=True).head(limit)
    blank = field.get("blank") or BLANK

    def key(r):
        if r["l"] == blank:
            return (2, 0.0, "")
        if r["n"] is None:
            return (1, 0.0, str(r["t"] or r["l"]).lower())
        return (0, float(r["n"]), "")
    rows = sorted(df.iter_rows(named=True), key=key)
    return {"values": [{"value": r["l"], "n": int(r["c"])} for r in rows],
            "distinct": total, "more": total > limit}


# --------------------------------------------------------------------------
# one group-by level
# --------------------------------------------------------------------------

def _level_lazy(lf: pl.LazyFrame, rfs: list[dict], cfs: list[dict], values: list[dict],
                columns: list[str]) -> pl.LazyFrame:
    fields = rfs + cfs
    pre, labels, keys = [], [], []
    for i, f in enumerate(fields):
        lab, kn, kt = _field_exprs(f, columns)
        pre += [lab.alias(f"__l{i}"), kn.alias(f"__n{i}"), kt.alias(f"__t{i}")]
        labels.append(f"__l{i}")
        keys += [pl.first(f"__n{i}").alias(f"__n{i}"), pl.first(f"__t{i}").alias(f"__t{i}")]
    aggs = [_agg_expr(v, columns).alias(f"__v{j}") for j, v in enumerate(values)]
    base = lf.with_columns(pre) if pre else lf
    return base.group_by(labels).agg(aggs + keys) if labels else base.select(aggs)


def _read_level(df: pl.DataFrame, nr: int, nc: int, nv: int) -> tuple[dict, dict]:
    """-> {(row labels): {(col labels): [values]}}, {(labels...): (num key, text key)}"""
    cells: dict[tuple, dict[tuple, list]] = {}
    skeys: dict[tuple, tuple] = {}
    for row in df.iter_rows(named=True):
        rk = tuple(row[f"__l{i}"] for i in range(nr))
        ck = tuple(row[f"__l{nr + i}"] for i in range(nc))
        cells.setdefault(rk, {})[ck] = [row[f"__v{j}"] for j in range(nv)]
        for i in range(nr + nc):
            path = (rk + ck)[:i + 1] if i < nr else ck[:i - nr + 1]
            skeys[("r" if i < nr else "c", path)] = (row.get(f"__n{i}"), row.get(f"__t{i}") or "")
    return cells, skeys


def _sorted_labels(paths: list[tuple], side: str, skeys: dict, field: dict,
                   measure: dict | None) -> list[tuple]:
    mode = (field or {}).get("sort") or "asc"
    def key(p):
        n, t = skeys.get((side, p), (None, ""))
        lab = p[-1]
        if lab == (field or {}).get("blank", BLANK) or lab == BLANK:
            return (2, 0.0, "")
        if n is None:
            return (1, 0.0, str(t or lab).lower())
        return (0, float(n), "")
    out = sorted(paths, key=key)
    if mode in ("value", "value_desc") and measure is not None:
        out = sorted(out, key=lambda p: (measure.get(p) is None, -(measure.get(p) or 0.0)
                                         if mode == "value_desc" else (measure.get(p) or 0.0)))
    elif mode == "desc":
        out = out[::-1]
    return out


# --------------------------------------------------------------------------
# the pivot
# --------------------------------------------------------------------------

def pivot(lf: pl.LazyFrame, spec: dict, columns: list[str] | None = None) -> dict:
    """Excel-style pivot -> a grid the UI draws and the writer exports verbatim."""
    columns = columns if columns is not None else lf.collect_schema().names()
    rfs = [f for f in (spec.get("rows") or []) if f.get("column")]
    cfs = [f for f in (spec.get("cols") or []) if f.get("column")]
    values = [v for v in (spec.get("values") or []) if v.get("column") or v.get("expr")]
    if not values:
        raise AnalysisError("Add at least one value — what should be summed or counted?")
    nv, nr, nc = len(values), len(rfs), len(cfs)
    lf = _apply_report_filters(lf, spec, columns)

    # every level in one collect: with the column fields, and again without them
    # (the Grand Total column) — subtotals are recomputed, never added up.
    plans, tags = [], []
    for k in range(nr + 1):
        plans.append(_level_lazy(lf, rfs[:k], cfs, values, columns)); tags.append(("x", k))
        if nc:
            plans.append(_level_lazy(lf, rfs[:k], [], values, columns)); tags.append(("t", k))
    frames = pl.collect_all(plans, engine="streaming")
    got = dict(zip(tags, frames))
    if got[("x", nr)].height > MAX_GROUPS:
        raise AnalysisError(f"That comes to {got[('x', nr)].height:,} groups — over {MAX_GROUPS:,}. "
                            "Use a coarser grouping, a top-N, or fewer row fields.")

    cells, skeys, totals = {}, {}, {}
    for k in range(nr + 1):
        c, s = _read_level(got[("x", k)], k, nc, nv)
        cells[k] = c
        skeys.update(s)
        if nc:
            t, _ = _read_level(got[("t", k)], k, 0, nv)
            totals[k] = {rk: v[()] for rk, v in t.items()}
        else:
            totals[k] = {rk: v[()] for rk, v in c.items()}

    # column order (deepest level holds every combination that exists)
    cpaths = sorted({ck for row in cells[nr].values() for ck in row})
    for i in range(nc):
        parents = sorted({p[:i] for p in cpaths})
        order, seen = [], {p[:i + 1] for p in cpaths}
        for par in parents:
            kids = [p for p in seen if p[:i] == par]
            order += _sorted_labels(kids, "c", skeys, cfs[i], None)
        rank = {p: j for j, p in enumerate(order)}
        cpaths = sorted(cpaths, key=lambda p: rank.get(p[:i + 1], 0))
    grand_col = bool(spec.get("grand_col", True)) and nc > 0
    ncols = len(cpaths) * nv + (nv if grand_col else 0)
    if max(1, got[("x", nr)].height) * max(1, ncols) > MAX_CELLS:
        raise AnalysisError(f"That pivot is about {got[('x', nr)].height * max(1, ncols):,} cells — "
                            f"over {MAX_CELLS:,}. Group the rows, drop a column field, or use a top-N.")

    # children of each prefix, sorted, with top-N applied within the parent
    kids: dict[tuple, list[tuple]] = {}
    for rk in cells[nr]:
        for k in range(nr):
            kids.setdefault(rk[:k], set()).add(rk[:k + 1])  # type: ignore[union-attr]
    for pref, ks in list(kids.items()):
        k = len(pref)
        fld = rfs[k]
        by = int((fld.get("top") or {}).get("by") or 0)
        measure = {p: totals[k + 1].get(p, [None] * nv)[min(by, nv - 1)] for p in ks} \
            if (fld.get("sort") in ("value", "value_desc") or fld.get("top")) else None
        order = _sorted_labels(sorted(ks), "r", skeys, fld, measure)
        top = fld.get("top") or {}
        n = int(top.get("n") or 0)
        if n > 0:
            ranked = sorted(order, key=lambda p: (measure or {}).get(p) is None or -((measure or {}).get(p) or 0.0))
            keep = set(ranked[-n:] if top.get("mode") == "bottom" else ranked[:n])
            order = [p for p in order if p in keep]
        kids[pref] = order

    # ---- emit rows
    body: list[dict] = []
    outline = (spec.get("layout") or "tabular") == "outline"
    subtotals = [bool(f.get("subtotal", True)) for f in rfs]

    def row_cells(path: tuple, k: int, kind: str) -> dict:
        labels: list[Any] = [None] * max(1, nr)
        for i, lab in enumerate(path):
            labels[i] = lab
        if kind == "subtotal":
            labels[k - 1] = f"{path[-1]} Total"
            for i in range(k, nr):
                labels[i] = None
        elif kind == "grand":
            labels[0] = GRAND
        if outline and kind == "data":
            for i in range(nr - 1):
                labels[i] = None
        vals: list[Any] = []
        src = cells[k].get(path, {})
        for cp in cpaths:
            vals += src.get(cp, [None] * nv)
        if grand_col:
            vals += totals[k].get(path, [None] * nv)
        return {"labels": labels, "vals": vals, "kind": kind, "level": max(0, k - 1), "path": path}

    def walk(prefix: tuple) -> None:
        k = len(prefix)
        for p in kids.get(prefix, []):
            if k + 1 == nr:
                body.append(row_cells(p, nr, "data"))
            else:
                walk(p)
                if subtotals[k]:
                    body.append(row_cells(p, k + 1, "subtotal"))

    if nr:
        walk(())
    else:
        body.append(row_cells((), 0, "data"))
    if spec.get("grand_row", True) and nr:
        body.append(row_cells((), 0, "grand"))

    # ---- show values as
    grand_all = totals[0].get((), [None] * nv)
    for j, v in enumerate(values):
        mode = v.get("show_as") or "none"
        if mode == "none" or not _is_numeric(v):
            continue
        idx = [j + i * nv for i in range(len(cpaths) + (1 if grand_col else 0))]
        data_rows = [r for r in body if r["kind"] == "data"]
        for ci, col_i in enumerate(idx):
            is_total_col = ci == len(cpaths)
            colvals = [r["vals"][col_i] for r in data_rows]
            if mode == "pct_col":
                base = grand_all[j] if is_total_col else (cells[0].get((), {}).get(cpaths[ci], [None] * nv)[j])
                for r in body:
                    r["vals"][col_i] = _ratio(r["vals"][col_i], base)
            elif mode == "pct_grand":
                for r in body:
                    r["vals"][col_i] = _ratio(r["vals"][col_i], grand_all[j])
            elif mode == "running":
                acc = 0.0
                for r in body:
                    if r["kind"] != "data":
                        r["vals"][col_i] = None
                        continue
                    acc += float(r["vals"][col_i] or 0.0)
                    r["vals"][col_i] = acc
            elif mode in ("diff_prev", "pct_prev"):
                prev = None
                for r in body:
                    if r["kind"] != "data":
                        r["vals"][col_i] = None
                        continue
                    cur = r["vals"][col_i]
                    r["vals"][col_i] = (None if prev is None or cur is None else
                                        (cur - prev if mode == "diff_prev" else _ratio(cur - prev, prev)))
                    prev = cur
            elif mode == "rank":
                order = sorted([x for x in colvals if x is not None], reverse=True)
                pos = {x: i + 1 for i, x in enumerate(order)}
                for r in body:
                    r["vals"][col_i] = None if r["kind"] != "data" else pos.get(r["vals"][col_i])
        if mode in ("pct_row", "pct_parent"):
            for r in body:
                base = (r["vals"][idx[-1]] if mode == "pct_row" and grand_col
                        else _parent_value(r, body, j, nv, cells, totals, nr))
                for col_i in idx:
                    r["vals"][col_i] = _ratio(r["vals"][col_i], base)

    # ---- headers, formats, display text
    fmts: list[str | None] = [None] * max(1, nr)
    head_top: list[list[str]] = [[""] * max(1, nr) for _ in range(nc)]
    head_val: list[str] = [f.get("name") or f["column"] for f in rfs] or ["Value"]
    colinfo: list[dict] = []          # per value column: which column path and value it holds
    for ci, cp in enumerate(cpaths + ([tuple([GRAND] * nc)] if grand_col else [])):
        for j, v in enumerate(values):
            for i in range(nc):
                head_top[i].append(cp[i] if i < len(cp) else "")
            head_val.append(value_name(v))
            fmts.append(_fmt_for(v, v.get("show_as") or "none"))
            colinfo.append({"path": [] if ci >= len(cpaths) else list(cp), "value": j,
                            "grand": ci >= len(cpaths)})
    if not nc:
        head_val = ([f.get("name") or f["column"] for f in rfs] or ["Value"]) + [value_name(v) for v in values]
        fmts = [None] * max(1, nr) + [_fmt_for(v, v.get("show_as") or "none") for v in values]

    head = [h for h in head_top]
    if nc and nv == 1 and not any(v.get("name") for v in values):
        head[0][0] = value_name(values[0])
        head.append([h if i >= max(1, nr) else (head_val[i] if i < nr else "") for i, h in enumerate(head_val)])
    else:
        head.append(head_val)
    ncol_total = max(1, nr) + ncols
    for h in head:
        h += [""] * (ncol_total - len(h))

    display = _render(body, fmts, nr)
    spec_of = lambda f: {k: f[k] for k in ("column", "group", "size", "date_format", "blank") if f.get(k) is not None}  # noqa: E731
    return {"ok": True, "head": head, "fmts": fmts, "rows": display,
            "row_fields": [f.get("name") or f["column"] for f in rfs],
            "row_specs": [spec_of(f) for f in rfs], "col_specs": [spec_of(f) for f in cfs],
            "colinfo": colinfo,
            "n_rows": len(body), "n_cols": ncol_total, "values": [value_name(v) for v in values]}


def _ratio(a: Any, b: Any) -> float | None:
    if a is None or b in (None, 0):
        return None
    return float(a) / float(b)


def _parent_value(r: dict, body: list[dict], j: int, nv: int, cells: dict, totals: dict, nr: int) -> Any:
    path = r["path"]
    k = max(0, len(path) - 1)
    return totals[k].get(path[:k], [None] * nv)[j]


def _render(body: list[dict], fmts: list[str | None], nr: int) -> list[dict]:
    """Numbers -> display strings, one polars pass per column."""
    ncols = len(body[0]["vals"]) if body else 0
    cols: list[list[str]] = []
    for c in range(ncols):
        code = fmts[max(1, nr) + c] if max(1, nr) + c < len(fmts) else None
        raw = [r["vals"][c] for r in body]
        if code and any(isinstance(x, (int, float)) for x in raw):
            s = pl.DataFrame({"v": [None if x is None else float(x) for x in raw]}, schema={"v": pl.Float64})
            cols.append(s.select(F.fmt_number(pl.col("v"), code)).to_series().to_list())
        else:
            cols.append(["" if x is None else str(x) for x in raw])
    out = []
    for i, r in enumerate(body):
        cells = ["" if x is None else str(x) for x in r["labels"]] + [cols[c][i] or "" for c in range(ncols)]
        nums = [None] * max(1, nr) + [x if isinstance(x, (int, float)) else None for x in r["vals"]]
        out.append({"cells": cells, "nums": nums, "kind": r["kind"], "level": r["level"],
                    "path": list(r.get("path") or ())})
    return out


# --------------------------------------------------------------------------
# dashboard items
# --------------------------------------------------------------------------

def _item_pivot_spec(item: dict) -> dict:
    kind = item.get("kind") or "kpi"
    vals = [v for v in (item.get("values") or []) if v.get("column") or v.get("expr")]
    if not vals:
        raise AnalysisError("Pick a column to measure")
    base = {"values": vals, "filters": item.get("filters") or [],
            "grand_row": bool(item.get("grand_row", kind != "kpi")), "grand_col": True}
    if kind == "kpi":
        return {**base, "rows": [], "cols": [], "grand_row": False}
    if kind == "breakdown":
        return {**base, "rows": [item.get("by") or {}], "cols": []}
    if kind == "trend":
        return {**base, "rows": [{**(item.get("by") or {}), "group": (item.get("by") or {}).get("group") or "month",
                                  "sort": "asc"}], "cols": []}
    if kind == "distribution":
        return {**base, "rows": [{**(item.get("by") or {}), "group": "bucket",
                                  "size": item.get("size") or 100, "sort": "asc"}], "cols": []}
    if kind == "crosstab":
        return {**base, "rows": [item.get("by") or {}], "cols": [item.get("by2") or {}]}
    raise AnalysisError(f"Unknown item kind “{kind}”")


def _quality(lf: pl.LazyFrame, item: dict, columns: list[str]) -> dict:
    cols = [_need(c, columns) for c in (item.get("columns") or []) if c]
    if not cols:
        raise AnalysisError("Pick the columns to check")
    probes = [pl.len().alias("__n")]
    for i, c in enumerate(cols):
        t = pl.col(c).fill_null("").str.strip_chars()
        probes += [(t == "").sum().alias(f"b{i}"), t.filter(t != "").n_unique().alias(f"d{i}"),
                   ((t != "") & F.clean_number(pl.col(c)).is_null()).sum().alias(f"x{i}"),
                   ((t != "") & F.parse_date(pl.col(c)).is_null()).sum().alias(f"y{i}")]
    r = lf.select(probes).collect().row(0, named=True)
    n = r["__n"]
    head = [["Column", "Rows", "Blank", "Distinct", "Repeated", "Not a number", "Not a date"]]
    rows = []
    for i, c in enumerate(cols):
        filled = n - r[f"b{i}"]
        rows.append({"cells": [c, f"{n:,}", f"{r[f'b{i}']:,}", f"{r[f'd{i}']:,}",
                               f"{max(0, filled - r[f'd{i}']):,}", f"{r[f'x{i}']:,}",
                               f"{r[f'y{i}']:,}"],
                     "nums": [None, n, r[f"b{i}"], r[f"d{i}"], max(0, filled - r[f"d{i}"]), r[f"x{i}"],
                              r[f"y{i}"]],
                     "kind": "data", "level": 0})
    return {"ok": True, "head": head, "rows": rows, "body": [], "fmts": [None] + ["#,##0"] * 6,
            "row_fields": ["Column"], "n_rows": len(rows), "n_cols": 7, "values": []}


def _series(table: dict) -> tuple[list[str], list[dict]]:
    """Chart data from a pivot: one label per data row, one series per value column
    (per column-field value and value field), grand-total columns left out."""
    nr = max(1, len(table.get("row_fields") or []))
    data = [r for r in table.get("rows") or [] if r["kind"] == "data"][:MAX_POINTS]
    labels = [" / ".join(c for c in r["cells"][:nr] if c) for r in data]
    vnames = table.get("values") or []
    series = []
    for ci, inf in enumerate(table.get("colinfo") or []):
        if inf.get("grand"):
            continue
        name = " / ".join(str(p) for p in inf.get("path") or [])
        vn = vnames[inf["value"]] if inf["value"] < len(vnames) else ""
        name = (f"{name} · {vn}" if len(vnames) > 1 else name) if name else vn
        series.append({"name": name, "col": ci,
                       "values": [r["nums"][nr + ci] if nr + ci < len(r["nums"]) else None for r in data],
                       "texts": [r["cells"][nr + ci] if nr + ci < len(r["cells"]) else "" for r in data]})
    return labels, series


def _fmt_one(num: float | None, code: str | None) -> str:
    if num is None:
        return ""
    return pl.select(F.fmt_number(pl.lit(float(num), pl.Float64), code or "General")).item() or ""


def _kpi(src: pl.LazyFrame, item: dict, table: dict, columns: list[str]) -> dict:
    r = table["rows"][0] if table["rows"] else None
    num = r["nums"][-1] if r else None
    code = (table.get("fmts") or [None])[-1]
    out = {"value": (r["cells"][-1] if r else ""), "caption": table["values"][0] if table["values"] else "",
           "num": num}
    tgt = str(item.get("target") if item.get("target") is not None else "").strip()
    if tgt:
        t = pl.select(F.clean_number(pl.lit(tgt))).item()
        if t is not None:
            out["target"] = _fmt_one(t, code)
            if num is not None and t:
                out["pct"] = num / t
                out["delta"] = _fmt_one(num - t, code)
    spark = item.get("spark") or {}
    if spark.get("column"):
        vals = [v for v in (item.get("values") or []) if v.get("column") or v.get("expr")][:1]
        sp = pivot(src, {"values": [{**vals[0], "show_as": "none"}], "cols": [], "grand_row": False,
                         "rows": [{**spark, "group": spark.get("group") or "month", "sort": "asc"}]}, columns)
        labels, series = _series(sp)
        if series:
            pts = [(lab, v, t) for lab, v, t in zip(labels, series[0]["values"], series[0]["texts"]) if v is not None]
            out["spark"] = [{"label": a, "value": b, "text": c} for a, b, c in pts]
            if len(pts) >= 2:
                last, prev = pts[-1][1], pts[-2][1]
                out["last"] = {"label": pts[-1][0], "text": pts[-1][2]}
                out["prev"] = {"label": pts[-2][0], "text": pts[-2][2]}
                out["change"] = None if not prev else (last - prev) / abs(prev)
    return out


def _records(lf: pl.LazyFrame, item: dict, columns: list[str]) -> dict:
    """A plain table of rows — the top N by a column, or the first N."""
    cols = [_need(c, columns) for c in (item.get("columns") or []) if c] or columns[:8]
    n = max(1, min(int(item.get("limit") or 25), 5000))
    q = lf
    by = item.get("sort_by")
    if by:
        b = _need(by, columns)
        desc = item.get("desc", True) is not False
        q = q.sort([F.clean_number(pl.col(b)), pl.col(b).fill_null("")], descending=[desc, desc], nulls_last=True)
    df, total = pl.collect_all([q.select(cols).head(n), lf.select(pl.len())])
    rows = [{"cells": ["" if v is None else str(v) for v in r], "nums": [None] * len(cols), "kind": "data",
             "level": 0, "path": []} for r in df.iter_rows()]
    return {"ok": True, "head": [cols], "rows": rows, "fmts": [None] * len(cols), "row_fields": [],
            "colinfo": [], "n_rows": len(rows), "n_cols": len(cols), "values": [],
            "n_total": int(total.item())}


def _plain(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return None if v != v else float(v)
    return str(v)


_PLAIN_NUM = re.compile(r"^-?(0|[1-9]\d*)(\.\d+)?$")


def _cell(v: Any) -> Any:
    """A record's value for the studio: a plain number as a number; IDs, codes and
    values with leading zeros stay text."""
    v = _plain(v)
    return float(v) if isinstance(v, str) and len(v) < 16 and _PLAIN_NUM.match(v) else v


def _studio_aggs(measures: list[dict], columns: list[str]) -> list[pl.Expr]:
    return [(pl.len().cast(pl.Float64) if (m.get("agg") or "sum") == "rows" else _agg_expr(m, columns)).alias(f"__m{i}")
            for i, m in enumerate(measures)]


def _studio(src: pl.LazyFrame, item: dict, columns: list[str]) -> dict:
    """A Studio visual's data: each bound measure over the card's rows (`values`), and
    per block the rows it draws (`ctx`) — one per value of a column (or month, …) with
    every measure for that group, or the top N records. Measure Studio evaluates the
    block's own expressions against these."""
    measures = [m for m in item.get("measures") or [] if str(m.get("name") or "").strip() and
                ((m.get("agg") or "sum") == "rows" or m.get("column") or str(m.get("expr") or "").strip())]
    names = [m["name"].strip() for m in measures]
    values: dict[str, Any] = {}
    if measures:
        row = src.select(_studio_aggs(measures, columns)).collect().row(0)
        values = {n: _plain(v) for n, v in zip(names, row)}
    ctx: dict[str, list[dict]] = {}
    errors: dict[str, str] = {}
    for bid, g in (item.get("blocks") or {}).items():
        if (g.get("mode") or "group") == "off":
            continue
        try:
            n = max(1, min(int(g.get("limit") or 50), STUDIO_MAX_ROWS))
            if (g.get("mode") or "group") == "rows":
                cols = [_need(c, columns) for c in (g.get("columns") or []) if c] or columns[:60]
                q = src
                if g.get("sort_by"):
                    b = _need(g["sort_by"], columns)
                    desc = g.get("desc", True) is not False
                    q = q.sort([F.clean_number(pl.col(b)), pl.col(b).fill_null("")], descending=[desc, desc], nulls_last=True)
                df = q.select(cols).head(n).collect()
                ctx[bid] = [{"__label": "" if r[0] is None else str(r[0]), "__order": i,
                             **{c: _cell(v) for c, v in zip(cols, r)}} for i, r in enumerate(df.iter_rows())]
                continue
            by = g.get("by") or {}
            if not by.get("column"):
                continue
            lab, nkey, tkey = _field_exprs(by, columns)
            df = src.group_by(lab.alias("__label")).agg(
                [nkey.min().alias("__nk"), tkey.min().alias("__tk"), *_studio_aggs(measures, columns)]).collect()
            if df.height > n:          # the biggest n by the first measure, then in their natural order
                df = df.sort("__m0", descending=True, nulls_last=True).head(n) if measures else df.head(n)
            df = df.sort(["__nk", "__tk", "__label"], nulls_last=True)
            rows = []
            for i, r in enumerate(df.iter_rows(named=True)):
                c = {"__label": r["__label"], "__order": i, by["column"]: r["__label"]}
                c.update({nm: _plain(r[f"__m{k}"]) for k, nm in enumerate(names)})
                rows.append(c)
            ctx[bid] = rows
        except (AnalysisError, F.FormulaError) as exc:
            errors[bid] = str(exc)
    fmts = [m.get("fmt") or {"rows": "#,##0"}.get(m.get("agg") or "sum") or DEFAULT_FMT.get(m.get("agg") or "sum")
            or "#,##0.00" for m in measures]
    body = [{"cells": [nm, _fmt_one(values.get(nm), f) if isinstance(values.get(nm), float) else str(values.get(nm) or "")],
             "nums": [None, values.get(nm) if isinstance(values.get(nm), float) else None], "kind": "data",
             "level": 0, "path": []} for nm, f in zip(names, fmts)]
    table = {"ok": True, "head": [["Measure", "Value"]], "rows": body, "fmts": [None, None], "row_fields": [],
             "colinfo": [], "n_rows": len(body), "n_cols": 2, "values": []}
    return {"values": values, "ctx": ctx, "errors": errors, "table": table}


def dashboard(lf: pl.LazyFrame, items: list[dict], columns: list[str] | None = None,
              filters: list[dict] | None = None) -> list[dict]:
    """Every card, each on the frame after the dashboard's filters (slicers and clicked
    values). A slicer lists its own values under every OTHER filter, so picking a month
    narrows the codes another slicer offers, but never hides the months themselves."""
    columns = columns if columns is not None else lf.collect_schema().names()
    filters = filters or []
    base = _apply_report_filters(lf, {"filters": filters}, columns) if filters else lf

    def fkey(f: dict) -> tuple:
        return (f.get("column"), f.get("group") or "none")

    def source_for(item: dict) -> pl.LazyFrame:
        """Cross-highlighting, as Power BI does it: a visual keeps every value of its
        own field when that field is filtered (the UI dims the others), and is filtered
        by everything else."""
        if item.get("ignore_filters") or not filters:
            return lf
        if (item.get("kind") or "kpi") not in ("breakdown", "trend", "distribution", "crosstab"):
            return base
        try:
            spec = _item_pivot_spec(item)
        except AnalysisError:
            return base
        own = {fkey(f) for f in spec["rows"] + spec["cols"] if f.get("column")}
        rest = [f for f in filters if fkey(f) not in own]
        if len(rest) == len(filters):
            return base
        return _apply_report_filters(lf, {"filters": rest}, columns) if rest else lf

    out = []
    for i, item in enumerate(items or []):
        if item.get("enabled") is False:
            continue
        kind = item.get("kind") or "kpi"
        iid = item.get("id") or f"i{i}"
        got: dict = {"id": iid, "kind": kind,
                     "name": item.get("name") or "", "width": item.get("width") or "half",
                     "chart": item.get("chart") or ("line" if kind == "trend" else "none")}
        src = source_for(item)
        try:
            if kind == "slicer":
                fld = item.get("by") or {}
                if not fld.get("column"):
                    raise AnalysisError("Pick the column to slice by")
                own = lambda f, fld=fld, iid=iid: (f.get("slicer") == iid or (  # noqa: E731
                    f.get("column") == fld.get("column") and (f.get("group") or "none") == (fld.get("group") or "none")))
                others = [f for f in filters if not own(f)]
                got["facets"] = facets(_apply_report_filters(lf, {"filters": others}, columns), fld, columns)
                got["selected"] = sorted({str(v) for f in filters if own(f) for v in (f.get("values") or [])})
                got["field"] = {k: fld[k] for k in ("column", "group", "size", "date_format") if fld.get(k) is not None}
                if not got["name"]:
                    got["name"] = fld["column"] if (fld.get("group") or "none") == "none" else \
                        f"{GROUP_SHORT.get(fld['group'], fld['group'])} of {fld['column']}"
                out.append(got)
                continue
            if kind == "studio":
                st = _studio(src, item, columns)
                got.update(values=st["values"], ctx=st["ctx"], block_errors=st["errors"], table=st["table"])
                if not got["name"]:
                    got["name"] = (((item.get("project") or {}).get("settings") or {}).get("name") or "Studio visual")
                out.append(got)
                continue
            if kind == "quality":
                table = _quality(src, item, columns)
            elif kind == "records":
                table = _records(src, item, columns)
            else:
                table = pivot(src, _item_pivot_spec(item), columns)
            got["table"] = table
            if kind == "kpi":
                got["kpi"] = _kpi(src, item, table, columns)
            elif kind not in ("quality", "records") and table["rows"]:
                labels, series = _series(table)
                got["labels"], got["series"] = labels, series
                if series:     # the 1.4 shape, kept for anything still reading it
                    got["points"] = [{"label": a, "value": b, "text": c} for a, b, c in
                                     zip(labels, series[0]["values"], series[0]["texts"]) if b is not None][:60]
            if not got.get("name"):
                got["name"] = _auto_name(item, table)
        except (AnalysisError, F.FormulaError) as exc:
            got["error"] = str(exc)
        except Exception as exc:  # noqa: BLE001 — one broken card must not sink the tab
            got["error"] = f"{type(exc).__name__}: {exc}"
        out.append(got)
    return out


def _auto_name(item: dict, table: dict) -> str:
    v = (item.get("values") or [{}])[0]
    what = value_name(v)
    kind = item.get("kind")
    if kind == "quality":
        return "Data checks"
    if kind == "records":
        by = item.get("sort_by")
        return f"Top {item.get('limit') or 25} rows by {by}" if by else "Rows"
    by = (item.get("by") or {}).get("column")
    if kind == "crosstab" and (item.get("by2") or {}).get("column"):
        return f"{what} by {by} and {item['by2']['column']}"
    extra = [value_name(x) for x in (item.get("values") or [])[1:] if x.get("column") or x.get("expr")]
    what = " and ".join([what] + extra)
    return f"{what} by {by}" if by else what


# --------------------------------------------------------------------------
# what gets exported
# --------------------------------------------------------------------------

def summaries(lf: pl.LazyFrame, tabs: list[dict], columns: list[str] | None = None,
              dash_filters: list[dict] | None = None) -> list[dict]:
    columns = columns if columns is not None else lf.collect_schema().names()
    filtered = None
    out = []
    for i, tab in enumerate(tabs or []):
        if tab.get("enabled") is False:
            continue
        spec = tab.get("pivot") or tab
        got = {"id": tab.get("id") or f"t{i}", "name": tab.get("name") or f"Summary {i + 1}",
               "chart": spec.get("chart") or "none", "heat": bool((spec.get("style") or {}).get("heat"))}
        src = lf
        if spec.get("dash_filters") and dash_filters:
            if filtered is None:
                filtered = _apply_report_filters(lf, {"filters": dash_filters}, columns)
            src = filtered
        try:
            got["table"] = pivot(src, spec, columns)
            if spec.get("chart") and spec.get("chart") != "none" and got["table"]["rows"]:
                got["labels"], got["series"] = _series(got["table"])
        except (AnalysisError, F.FormulaError) as exc:
            got["error"] = str(exc)
        except Exception as exc:  # noqa: BLE001
            got["error"] = f"{type(exc).__name__}: {exc}"
        out.append(got)
    return out


_NUM_TXT = r"^[-+(]?\s*[$€£¥₹]?\s*\d[\d,]*(\.\d+)?\s*\)?%?$"
_DATE_TXT = (r"^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}[-\s][A-Za-z]{3,9}[-\s]\d{2,4}"
             r")([ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?)?$")
PROFILE_ROWS = 2000


def profile(lf: pl.LazyFrame, rows: int = PROFILE_ROWS) -> list[dict]:
    """What each column looks like in its first rows — numbers, dates or text, and how many
    different values — so the dashboard can suggest visuals that suit the data."""
    try:
        df = lf.head(rows).collect()
    except Exception:  # noqa: BLE001 — a suggestion is never worth a failed dashboard
        return []
    out = []
    for c in df.columns:
        if c.startswith("__"):
            continue
        s = df[c]
        if s.dtype.is_numeric():
            kind = "number"
        elif s.dtype.is_temporal():
            kind = "date"
        else:
            v = s.cast(pl.String, strict=False).drop_nulls().str.strip_chars()
            v = v.filter(v != "")
            if not v.len():
                kind = "text"
            elif v.str.contains(_DATE_TXT).mean() >= 0.9:
                kind = "date"
            elif v.str.contains(_NUM_TXT).mean() >= 0.9:
                kind = "number"
            else:
                kind = "text"
        out.append({"name": c, "kind": kind, "distinct": int(s.n_unique()), "rows": df.height})
    return out


def analyse(lf: pl.LazyFrame, spec: dict, columns: list[str] | None = None) -> dict:
    """Both halves of the Analysis tab in one pass over the same frame."""
    columns = columns if columns is not None else lf.collect_schema().names()
    an = spec.get("analysis") or {}
    su = spec.get("summaries") or {}
    notes: list[str] = []
    filters = usable_filters(an.get("filters"), columns, notes)
    fx: dict[str, dict] = {}
    for tab in su.get("tabs") or []:        # values for the report-filter pickers
        for f in (tab.get("pivot") or tab).get("filters") or []:
            key = f"{f.get('column')}|{f.get('group') or 'none'}"
            if f.get("column") and key not in fx:
                try:
                    fx[key] = facets(lf, f, columns)
                except (AnalysisError, F.FormulaError):
                    pass
                except Exception:  # noqa: BLE001
                    pass
    return {"ok": True,
            "items": dashboard(lf, an.get("items") or [], columns, filters),
            "tabs": summaries(lf, su.get("tabs") or [], columns, filters),
            "facets": fx, "filters": filters, "filter_text": describe_filters(filters),
            "notes": notes, "columns": columns, "fields": profile(lf)}


def detail(lf: pl.LazyFrame, filters: list[dict], columns: list[str] | None = None,
           limit: int = 500) -> dict:
    """Drill-through: the rows behind a clicked bar, slice or pivot cell."""
    columns = columns if columns is not None else lf.collect_schema().names()
    sub = _apply_report_filters(lf, {"filters": filters}, columns)
    df, n = pl.collect_all([sub.head(max(1, int(limit))), sub.select(pl.len())])
    return {"ok": True, "columns": df.columns, "total": int(n.item()), "shown": df.height,
            "rows": [["" if v is None else str(v) for v in r] for r in df.iter_rows()],
            "filter_text": describe_filters(filters)}


def _table_grid(table: dict, title: str | None = None) -> list[list[Any]]:
    """A table as plain rows of (text, number|None) pairs for the writers."""
    grid: list[list[Any]] = []
    if title:
        grid.append([("__title__", title)])
    for h in table.get("head") or []:
        grid.append([("__head__", c) for c in h])
    for r in table.get("rows") or []:
        grid.append([(c, r["nums"][i] if i < len(r["nums"]) else None, r["kind"])
                     for i, c in enumerate(r["cells"])])
    return grid


def export_tables(result: dict, spec: dict) -> list[dict]:
    """-> [{name, kind, table}] for the sheets / csv files the run should write."""
    out = []
    an, su = spec.get("analysis") or {}, spec.get("summaries") or {}
    if an.get("export") and result.get("items"):
        out.append({"name": an.get("sheet_name") or "Analysis", "kind": "dashboard",
                    "items": [i for i in result["items"] if i.get("table")]})
    if su.get("export"):
        for t in result.get("tabs") or []:
            if t.get("table"):
                out.append({"name": t["name"], "kind": "summary", "table": t["table"]})
    return out


def table_rows(table: dict, fmt_numbers: bool = True) -> tuple[list[list[str]], list[list[Any]], list[str | None]]:
    """(text rows, numeric rows, per-column format codes) — what a writer needs."""
    head = [list(h) for h in (table.get("head") or [])]
    text = head + [list(r["cells"]) for r in (table.get("rows") or [])]
    nums = [[None] * len(h) for h in head] + [list(r["nums"]) for r in (table.get("rows") or [])]
    width = max((len(r) for r in text), default=0)
    for r, n in zip(text, nums):
        r += [""] * (width - len(r))
        n += [None] * (width - len(n))
    fmts = list(table.get("fmts") or []) + [None] * width
    return text, nums, fmts[:width]


def kinds(table: dict) -> list[str]:
    return ["head"] * len(table.get("head") or []) + [r["kind"] for r in (table.get("rows") or [])]


_SHEET_BAD = re.compile(r"[\[\]\*/\\?:]")


def sheet_name(name: str, used: set[str]) -> str:
    base = _SHEET_BAD.sub("_", str(name or "Summary")).strip("'") [:31] or "Summary"
    cand, i = base, 2
    while cand.lower() in used:
        suf = f"_{i}"
        cand = base[:31 - len(suf)] + suf
        i += 1
    used.add(cand.lower())
    return cand
