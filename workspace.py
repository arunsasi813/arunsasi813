"""
ColSift setups — one or more groups of files, combined into one export.

A setup is a list of groups. Each group is the ordinary ColSift work for one kind
of file — header row, columns, filters, computed columns — with its own files:

    groups      Sales  <- SALES_*.xlsx   (its columns, filters, formulas)
                Refund <- REF_*.csv      (its columns, filters, formulas)
                Rates  <- rates.xlsx

A setup with one group is the classic extract and runs exactly as it always did
(run_setup hands it to engine.run). With more groups, or any combine step, a run
goes: every group's ColSift work -> the combine steps on those results -> one
export. Each group becomes a table; steps build new tables from them, the way
Power Query or a SQL view would:

    append      stack tables one under another (columns matched by name)
    merge       join two tables on key columns — left, inner, full, right,
                "only rows with a match", "only rows without one"
    lookup      bring chosen columns from another table by key (XLOOKUP)
    sql         a SELECT over any tables, by name
    transform   filters, formula columns, column picks — the setup editors'
                own machinery, on a table
    group       group and total, like GROUP BY

Relationships (Sales.CODE -> Codes.CODE, many to one) let a dashboard or
summary on Sales use Codes' columns directly, as "Codes.DESCRIPTION", without a
merge step: the lookup side is joined in for the analysis only. A relationship's
key columns are read even when the group's Columns tab doesn't keep them, so a
link never depends on what the extract writes.

run() writes any chosen tables into one workbook (a sheet each) or one CSV/TXT
file each — the groups separately or stacked as "All groups" — with the
dashboards and summaries as extra sheets and/or PDFs.

Everything stays lazy until written. In "all" scope each group's files are
staged to Parquet exactly as a single-setup run does (one file at a time), and
each derived table is materialised once before it is written, so writing a
joined table in 200,000-row chunks never re-runs the join per chunk.
"""

from __future__ import annotations

import copy
import fnmatch
import json
import re
import shutil
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import polars as pl

import analysis as A
import checks as C
import engine as E
import formula as F

SETUP_KIND = "colsift.setup"
SETUP_VERSION = 2
WS_KIND = "colsift.workspace"          # what 2.0's first cut saved; still read
WS_VERSION = SETUP_VERSION
STACK_NAME = "All groups"

STEP_KINDS = [   # id, label, what it does
    ("append", "Append", "Stack tables one under another — columns are matched by name"),
    ("merge", "Merge", "Join two tables on matching key columns"),
    ("lookup", "Lookup", "Bring columns from another table by key, like XLOOKUP"),
    ("sql", "SQL query", "SELECT over any tables by name"),
    ("transform", "Transform", "Filter rows, add formula columns, pick and rename columns"),
    ("group", "Group and total", "One row per key with sums, counts … like GROUP BY"),
]
JOIN_HOW = [
    ("left", "Every row of the first table (left join)"),
    ("inner", "Only rows found in both (inner join)"),
    ("full", "Every row of both tables (full outer join)"),
    ("right", "Every row of the second table (right join)"),
    ("semi", "First-table rows that have a match"),
    ("anti", "First-table rows with NO match"),
]
MATCH_MODES = [
    ("pattern", "File name matches a wildcard (TAX_*.xlsx; several with ;)"),
    ("contains", "File name contains text"),
    ("ext", "Extension is (.csv;.txt)"),
    ("regex", "File name matches a regular expression"),
    ("folder", "Folder name contains text"),
    ("layout", "File has these columns (blank = the setup's kept columns)"),
    ("manual", "Only files I assign by hand"),
]

PREVIEW_FILES = 5          # per group, in preview scope
PREVIEW_ROWS = 5000        # per file, in preview scope
SQL_SAMPLE = 2000          # rows looked at to decide which columns read as numbers
_IDLIKE = re.compile(r"(^|[_\s.])(NO|NUM|NUMBER|ID|CODE|KEY|REF|TKT|DOC|PNR)([_\s.]|$)", re.I)


class WorkspaceError(ValueError):
    pass


def meta() -> dict:
    return {"step_kinds": [{"id": i, "label": l, "help": h} for i, l, h in STEP_KINDS],
            "join_how": [{"id": i, "label": l} for i, l in JOIN_HOW],
            "match_modes": [{"id": i, "label": l} for i, l in MATCH_MODES],
            "checks": C.meta()}


def _id() -> str:
    return "w" + uuid.uuid4().hex[:8]


# --------------------------------------------------------------------------
# shape: defaults, names, validation
# --------------------------------------------------------------------------

OUTPUT_DEFAULTS = {
    # the classic extract's options — they drive a one-group run unchanged
    "folder": "", "basename": "extract", "format": "csv", "delimiter": "comma", "header": True,
    "mode": "combine", "timestamp": False, "overwrite": True, "autofilter": True, "quote_style": "necessary",
    "sheet_name": "Data", "split": {"by": "none", "rows": 1000000, "column": "", "into": "sheets"},
    "encoding": "utf-8", "line_terminator": "\n", "decimal_comma": False, "header_style": "bold",
    "log": False, "pdf": {},
    # several groups / combine steps
    "layout": "workbook", "tables": [], "autotype": True, "groups_as": "sheets",
}
_CLASSIC_KEYS = {"columns", "source", "filters", "add_columns", "output", "analysis", "summaries", "files"}


def normalize(ws: dict | None) -> dict:
    """Fill in defaults so every later step can index without guarding."""
    ws = copy.deepcopy(ws or {})
    ws["kind"], ws["version"] = SETUP_KIND, SETUP_VERSION
    ws.setdefault("name", "")
    groups = []
    for g in ws.get("groups") or []:
        g = {"id": g.get("id") or _id(), "name": str(g.get("name") or "").strip() or "Group",
             "enabled": g.get("enabled", True) is not False, "setup": g.get("setup") or {},
             "profile": g.get("profile") or "", "files": list(dict.fromkeys(g.get("files") or [])),
             "folders": _folders(g.get("folders")),
             "match": {"mode": "manual", "value": "", **(g.get("match") or {})}}
        groups.append(g)
    ws["groups"] = groups
    ws["folders"] = _folders(ws.get("folders"))
    ws["steps"] = [{"id": s.get("id") or _id(), "enabled": s.get("enabled", True) is not False,
                    "name": str(s.get("name") or "").strip() or "Step", **{k: v for k, v in s.items()
                                                                          if k not in ("id", "enabled", "name")}}
                   for s in ws.get("steps") or []]
    ws["relationships"] = [{"id": r.get("id") or _id(), "enabled": r.get("enabled", True) is not False,
                            "fold": r.get("fold", True) is not False, **{k: v for k, v in r.items()
                                                                          if k not in ("id", "enabled", "fold")}}
                           for r in ws.get("relationships") or []]
    ws["reports"] = [{"id": r.get("id") or _id(), "name": r.get("name") or "Report", "table": r.get("table") or "",
                      "analysis": {"export": False, "items": [], "filters": [], **(r.get("analysis") or {})},
                      "summaries": {"export": False, "tabs": [], **(r.get("summaries") or {})}}
                     for r in ws.get("reports") or []]
    out = {**copy.deepcopy(OUTPUT_DEFAULTS), **(ws.get("output") or {})}
    out.pop("formats", None)                      # column formats belong to each group
    ws["output"] = out
    ws["processing"] = ws.get("processing") or "sequential"
    ws["params"] = [p for p in ws.get("params") or [] if isinstance(p, dict) and str(p.get("name") or "").strip()]
    ws["param_values"] = dict(ws.get("param_values") or {})
    ws["checks"] = [C.normalize(c) for c in ws.get("checks") or [] if isinstance(c, dict)]
    ov = ws.get("overview") or {}
    ws["overview"] = {"name": ov.get("name") or "Overview",
                      "analysis": {"export": False, "sheet_name": "Overview", "items": [], "filters": [],
                                   **(ov.get("analysis") or {})},
                      "summaries": {"export": False, "tabs": [], **(ov.get("summaries") or {})}}
    return ws


def _folders(v: Any) -> list[dict]:
    """Folders as [{path, recursive}] — a plain string is a folder without its subfolders."""
    out, seen = [], set()
    for x in v or []:
        d = {"path": x, "recursive": False} if isinstance(x, str) else dict(x or {})
        p = str(d.get("path") or "").strip()
        if p and p not in seen:
            seen.add(p)
            out.append({"path": p, "recursive": bool(d.get("recursive"))})
    return out


def from_any(obj: dict | None, name: str = "") -> dict:
    """Any saved shape -> a setup: a 1.x single setup (a job), 2.0's workspace, or a
    setup already. A job becomes a setup with one group, named after the setup."""
    obj = copy.deepcopy(obj or {})
    if obj.get("groups") is not None or obj.get("kind") in (SETUP_KIND, WS_KIND):
        ws = normalize(obj)
        if name and not ws["name"]:
            ws["name"] = name
        return ws
    files = obj.pop("files", None) or []
    out = dict(obj.pop("output", None) or {})
    formats = out.pop("formats", None) or {}
    processing = obj.pop("processing", None)
    match = obj.pop("match", None)
    checks = obj.pop("checks", None)
    for k in ("_name", "_saved", "kind", "version"):
        obj.pop(k, None)
    gname = str(name or out.get("basename") or "Group 1").strip()
    group = {"name": gname if gname.lower() != "extract" else "Group 1", "files": files,
             "match": match or {"mode": "manual", "value": ""},
             "setup": {**obj, "output": {"formats": formats}}}
    return normalize({"name": name, "groups": [group], "output": out, "processing": processing,
                      "checks": checks or []})


def is_classic(ws: dict) -> bool:
    """One group and no combine step: the classic extract, every 1.x option intact."""
    return len([g for g in ws["groups"] if g["enabled"]]) == 1 and not [s for s in ws["steps"] if s["enabled"]]


def group_job(ws: dict, g: dict) -> dict:
    """A group as the engine's job: its ColSift settings, its files, and the setup's
    output with the group's column formats."""
    st = copy.deepcopy(g.get("setup") or {})
    formats = (st.pop("output", None) or {}).get("formats") or {}
    return {**st, "files": list(g.get("files") or []),
            "output": {**copy.deepcopy(ws["output"]), "formats": formats},
            "processing": ws.get("processing") or "sequential"}


def _key(name: str) -> str:
    return str(name or "").strip().lower()


def stacked(ws: dict) -> bool:
    taken = {_key(g["name"]) for g in ws["groups"]} | {_key(s["name"]) for s in ws["steps"]}
    return (ws["output"].get("groups_as") == "stacked" and any(g["enabled"] for g in ws["groups"])
            and _key(STACK_NAME) not in taken)


def tables_of(ws: dict) -> list[dict]:
    """Every table the setup defines, in dependency order: groups, "All groups" when
    they are stacked, then steps."""
    # a file group's kind is "group", and so is a "Group and total" step's: is_group tells them apart
    out = [{"name": g["name"], "kind": "group", "id": g["id"], "is_group": True} for g in ws["groups"] if g["enabled"]]
    if stacked(ws):
        out.append({"name": STACK_NAME, "kind": "stack", "id": "__stack"})
    out += [{"name": s["name"], "kind": s.get("kind") or "?", "id": s["id"]} for s in ws["steps"] if s["enabled"]]
    return out


def validate(ws: dict) -> list[str]:
    problems, seen = [], {}
    for t in tables_of(ws):
        k = _key(t["name"])
        if k in seen:
            problems.append(f"Two tables are called “{t['name']}” — table names must be unique")
        seen[k] = t
    for s in ws["steps"]:
        if not s["enabled"]:
            continue
        for ref in _step_inputs(s):
            if _key(ref) not in seen:
                problems.append(f"Step “{s['name']}” uses “{ref}”, which isn't a table here")
    return problems


def _step_inputs(s: dict) -> list[str]:
    k = s.get("kind")
    if k == "append":
        return [x for x in s.get("inputs") or [] if x]
    if k == "merge":
        return [x for x in (s.get("left"), s.get("right")) if x]
    if k == "lookup":
        return [x for x in (s.get("input"), s.get("from")) if x]
    if k in ("transform", "group"):
        return [x for x in [s.get("input")] if x]
    return []          # sql: resolved from the query text


# --------------------------------------------------------------------------
# which file belongs to which setup
# --------------------------------------------------------------------------

def _patterns(v: str) -> list[str]:
    return [p.strip() for p in re.split(r"[;\n,]+", str(v or "")) if p.strip()]


def match_rule(path: str, rule: dict, columns: list[str] | None = None, setup: dict | None = None) -> bool:
    """Does a file belong to a group, by that group's rule? `columns` is the file's
    header under the group's own source settings, needed only for 'layout'."""
    mode = (rule or {}).get("mode") or "manual"
    val = str((rule or {}).get("value") or "")
    cs = bool((rule or {}).get("case"))
    p = Path(path)
    name = p.name if cs else p.name.lower()
    if mode == "pattern":
        pats = _patterns(val)
        return any(fnmatch.fnmatchcase(name, x if cs else x.lower()) for x in pats) if pats else False
    if mode == "contains":
        parts = _patterns(val)
        return any((x if cs else x.lower()) in name for x in parts) if parts else False
    if mode == "ext":
        exts = [("." + x.lstrip(".")).lower() for x in _patterns(val)]
        return p.suffix.lower() in exts if exts else False
    if mode == "regex":
        try:
            return bool(re.search(val, p.name, 0 if cs else re.I)) if val else False
        except re.error:
            return False
    if mode == "folder":
        parts = _patterns(val)
        folder = str(p.parent) if cs else str(p.parent).lower()
        return any((x if cs else x.lower()) in folder for x in parts) if parts else False
    if mode == "layout":
        if columns is None:
            return False
        want = _patterns(val) or [c.get("name") for c in (setup or {}).get("columns") or []
                                  if c.get("include", True) and c.get("name")]
        have = {c.lower() for c in columns}
        return bool(want) and all(w.lower() in have for w in want)
    return False


def _file_columns(path: str, setup: dict) -> list[str] | None:
    try:
        src = E.Source.from_dict({**(setup.get("source") or {}), "path": path})
        return E._schema_names(src)
    except Exception:  # noqa: BLE001 — a file that can't be read under this setup simply doesn't match
        return None


def auto_group(ws: dict, files: list[str], keep_manual: bool = True, replace: bool = False) -> dict:
    """Assign files to groups by the groups' rules, first match wins, in group order.
    Files already placed by hand in a 'manual' group stay where they are. With
    `replace`, `files` is everything there is: a group keeps nothing from outside it."""
    ws = normalize(ws)
    assign: dict[str, str | None] = {}
    why: dict[str, str] = {}
    manual = {f: g["id"] for g in ws["groups"] if (g["match"].get("mode") or "manual") == "manual"
              for f in g["files"]} if keep_manual else {}
    owned = {f: g["id"] for g in ws["groups"] if g["enabled"] for f in folder_files(g, files)}
    for f in files:
        if f in owned:                      # a folder assigned to a group: its files are that group's
            assign[f], why[f] = owned[f], "folder"
            continue
        if f in manual:
            assign[f], why[f] = manual[f], "assigned by hand"
            continue
        assign[f] = None
        for g in ws["groups"]:
            if not g["enabled"] or (g["match"].get("mode") or "manual") == "manual":
                continue
            cols = _file_columns(f, g["setup"]) if g["match"]["mode"] == "layout" else None
            if match_rule(f, g["match"], cols, g["setup"]):
                assign[f], why[f] = g["id"], g["match"]["mode"]
                break
    for g in ws["groups"]:
        keep = [] if replace else [f for f in g["files"] if f not in assign]   # files outside this list stay
        g["files"] = keep + [f for f in files if assign.get(f) == g["id"]]
    counts = {g["id"]: len(g["files"]) for g in ws["groups"]}
    return {"ok": True, "workspace": ws, "assign": assign, "why": why, "counts": counts,
            "unassigned": [f for f in files if not assign.get(f)]}


def list_folders(folders: list[dict] | list[str], pattern: str = "") -> dict:
    """The readable files of several folders, each tagged with the folder it was
    listed under, each file once (a subfolder listed twice doesn't double it)."""
    files: list[dict] = []
    report: list[dict] = []
    seen: set[str] = set()
    for d in _folders(folders):
        r = E.list_folder(d["path"], d["recursive"], pattern)
        if not r.get("ok"):
            report.append({"path": d["path"], "error": r.get("error") or f"Cannot read {d['path']}"})
            continue
        n = 0
        for f in r["files"]:
            if f["path"] not in seen:
                seen.add(f["path"])
                files.append({**f, "folder": d["path"]})
                n += 1
        report.append({"path": d["path"], "count": n})
    return {"ok": True, "files": files, "folders": report, "count": len(files)}


def list_files(folders: list[dict] | list[str], pattern: str = "") -> list[str]:
    """Every readable file in these folders, in folder order, each file once."""
    return [f["path"] for f in list_folders(folders, pattern)["files"]]


def _under(path: str, folder: dict) -> bool:
    p, root = Path(path), Path(folder["path"])
    try:
        rel = p.relative_to(root)
    except ValueError:
        return False
    return folder.get("recursive") or len(rel.parts) == 1


def folder_files(g: dict, files: list[str]) -> list[str]:
    """The files of `files` that a group takes because one of its folders holds them —
    all of them, or those its file rule picks when it has one."""
    if not g.get("folders"):
        return []
    mode = (g.get("match") or {}).get("mode") or "manual"
    out = []
    for f in files:
        if not any(_under(f, d) for d in g["folders"]):
            continue
        if mode in ("manual", "folder"):
            out.append(f)
        else:
            cols = _file_columns(f, g["setup"]) if mode == "layout" else None
            if match_rule(f, g["match"], cols, g["setup"]):
                out.append(f)
    return out


def expand_folders(ws: dict) -> dict:
    """A group with folders assigned reads whatever those folders hold *now* — so next
    month's files are picked up without touching the setup."""
    ws = normalize(ws)
    for g in ws["groups"]:
        if g["folders"]:
            have = list_files(g["folders"])
            g["files"] = list(dict.fromkeys([f for f in g["files"] if Path(f).exists()] + folder_files(g, have)))
    return ws


def rebind(ws: dict, files: list[str], saved: dict[str, list[str]] | None = None) -> dict:
    """Fit a setup to the files at hand (the folders open in the window, or --folder).

    A saved setup remembers full paths. Loading it must not drag those paths into the
    file list: a file the setup knew stays in its group when the same path is listed,
    else moves to a listed file of the same name (the setup copied to another folder),
    else is dropped — and reported. Folder-assigned groups take what their folders
    hold among `files`; rule groups are re-sorted over `files`. `saved` gives each
    group's paths from when the setup was loaded, so adding a folder later brings
    back the assignments it holds."""
    ws = normalize(ws)
    listed = list(dict.fromkeys(files))
    have = set(listed)
    by_name: dict[str, list[str]] = {}
    for f in listed:
        by_name.setdefault(Path(f).name.lower(), []).append(f)
    dropped: dict[str, list[str]] = {}
    moved = 0
    for g in ws["groups"]:
        want = list(dict.fromkeys(list(g["files"]) + list((saved or {}).get(g["id"]) or [])))
        out: list[str] = []
        for f in want:
            if f in have:
                out.append(f)
                continue
            alt = [x for x in by_name.get(Path(f).name.lower(), []) if x not in out]
            if alt:
                out.append(alt[0])
                moved += 1
            elif f in g["files"]:
                dropped.setdefault(g["name"], []).append(Path(f).name)
        g["files"] = list(dict.fromkeys(out + folder_files(g, listed)))
    if any((g["match"].get("mode") or "manual") != "manual" for g in ws["groups"] if g["enabled"]):
        ws = auto_group(ws, listed, keep_manual=True, replace=True)["workspace"]
    return {"ok": True, "workspace": ws, "moved": moved, "dropped": dropped,
            "counts": {g["id"]: len(g["files"]) for g in ws["groups"]}}


# --------------------------------------------------------------------------
# building tables
# --------------------------------------------------------------------------

def _as_text(lf: pl.LazyFrame) -> pl.LazyFrame:
    """The engine's filters, formulas and pivots expect text; SQL and group steps
    may hand back numbers. Cast only what isn't text already."""
    sch = lf.collect_schema()
    odd = [c for c, t in sch.items() if t != pl.String]
    if not odd:
        return lf
    return lf.with_columns([
        (pl.col(c).dt.strftime("%Y-%m-%d") if sch[c] == pl.Date else
         F.fmt_general(pl.col(c).cast(pl.Float64)) if sch[c].is_numeric() else pl.col(c).cast(pl.String)).alias(c)
        for c in odd])


def _norm_key(e: pl.Expr, fold: bool) -> pl.Expr:
    t = e.cast(pl.String).str.strip_chars()
    if fold:
        t = t.str.to_lowercase()
    return pl.when(t == "").then(None).otherwise(t)       # blank keys never match each other


def _sort_expr(col: str) -> list[pl.Expr]:
    return [F.clean_number(pl.col(col)), pl.col(col).cast(pl.String)]


class Builder:
    """Resolves table names to LazyFrames for one scope:

      schema   lazily, over the first file of each group — for field lists
      preview  the first PREVIEW_FILES files × PREVIEW_ROWS rows of each group
      all      every file, staged to Parquet; derived tables materialised once
    """

    def __init__(self, ws: dict, scope: str = "preview", on_progress: Callable | None = None,
                 cancel=None, stage: Path | None = None):
        self.ws = normalize(ws)
        self.scope = scope
        self.on_progress = on_progress
        self.cancel = cancel
        self.stage = stage
        self.frames: dict[str, pl.LazyFrame] = {}
        self.formats: dict[str, dict] = {}
        self.per_file: list[dict] = []
        self.notes: list[str] = []
        self._busy: set[str] = set()
        self.raw: dict[str, pl.LazyFrame] = {}      # groups with their relationship-only key columns
        self.hidden: dict[str, list[str]] = {}
        self.by_name = {}
        for g in self.ws["groups"]:
            if g["enabled"]:
                self.by_name.setdefault(_key(g["name"]), ("group", g))
        if stacked(self.ws):
            self.by_name.setdefault(_key(STACK_NAME), ("stack", {"name": STACK_NAME}))
        for s in self.ws["steps"]:
            if s["enabled"]:
                self.by_name.setdefault(_key(s["name"]), ("step", s))

    # -- public -------------------------------------------------------------
    def names(self) -> list[str]:
        return [t["name"] for t in tables_of(self.ws)]

    def get(self, name: str) -> pl.LazyFrame:
        k = _key(name)
        if k in self.frames:
            return self.frames[k]
        if k not in self.by_name:
            raise WorkspaceError(f"There is no table called “{name}”")
        if k in self._busy:
            raise WorkspaceError(f"“{name}” depends on itself — check the steps that feed it")
        self._busy.add(k)
        try:
            kind, obj = self.by_name[k]
            E._check_cancel(self.cancel)
            if kind == "group":
                lf = self._group(obj)
                self.raw[k] = lf
                hid = [h for h in self.hidden.get(k) or [] if h in lf.collect_schema().names()]
                if hid:                    # read for relationships only — not part of the group's table
                    lf = lf.drop(hid)
            elif kind == "stack":
                lf = self._stack()
            else:
                lf = self._step(obj)
            if self.scope == "all" and kind in ("step", "stack"):
                lf = self._materialise(obj["name"], lf)
        finally:
            self._busy.discard(k)
        self.frames[k] = lf
        return lf

    def _full(self, name: str) -> pl.LazyFrame:
        """A table as relationships see it: a group keeps its relationship keys even
        when its Columns tab doesn't."""
        lf = self.get(name)
        return self.raw.get(_key(name), lf)

    def _rel_keys(self, gname: str) -> list[str]:
        keys = []
        for r in self.ws["relationships"]:
            if not r["enabled"]:
                continue
            if _key(r.get("from")) == _key(gname) and r.get("from_col"):
                keys.append(r["from_col"])
            if _key(r.get("to")) == _key(gname) and r.get("to_col"):
                keys.append(r["to_col"])
        return list(dict.fromkeys(keys))

    def _stack(self) -> pl.LazyFrame:
        """Every group's rows one under another, with the group's name in SOURCE."""
        names = [g["name"] for g in self.ws["groups"] if g["enabled"]]
        lfs = []
        for n in names:
            try:
                lfs.append(self.get(n).with_columns(pl.lit(n).alias("SOURCE")))
            except WorkspaceError as exc:
                self.notes.append(f"{STACK_NAME}: {exc}")
        if not lfs:
            raise WorkspaceError("no group could be read")
        self._inherit({"name": STACK_NAME}, names)
        out = pl.concat(lfs, how="diagonal_relaxed")
        cols = out.collect_schema().names()
        return out.select(["SOURCE"] + [c for c in cols if c != "SOURCE"])

    def related(self, name: str) -> pl.LazyFrame:
        """The table with every lookup table reachable through relationships joined
        in, their columns named Table.Column. Lookup sides are cut to one row per
        key first, so a relationship never multiplies rows."""
        base = _as_text(self._full(name))
        have = base.collect_schema().names()
        done = {_key(name)}
        # (table whose columns are in `base`, how its columns are named there)
        frontier = [(name, "")]
        depth = 0
        while frontier and depth < 3:
            nxt = []
            for tname, prefix in frontier:
                for r in self.ws["relationships"]:
                    if not r["enabled"] or _key(r.get("from")) != _key(tname) or _key(r.get("to")) in done:
                        continue
                    if _key(r.get("to")) not in self.by_name:
                        self.notes.append(f"Relationship to “{r.get('to')}” skipped — no such table")
                        continue
                    left_col = f"{prefix}{r.get('from_col')}"
                    if left_col not in have:
                        self.notes.append(f"Relationship {tname}.{r.get('from_col')} skipped — no such column")
                        continue
                    to_name = self.by_name[_key(r["to"])][1]["name"]
                    dim = _as_text(self._full(to_name))
                    dcols = dim.collect_schema().names()
                    if r.get("to_col") not in dcols:
                        self.notes.append(f"Relationship to {to_name}.{r.get('to_col')} skipped — no such column")
                        continue
                    fold = r.get("fold", True)
                    dim = (dim.with_columns(_norm_key(pl.col(r["to_col"]), fold).alias("__rk"))
                              .filter(pl.col("__rk").is_not_null())
                              .unique(subset=["__rk"], keep="first", maintain_order=True)
                              .rename({c: f"{to_name}.{c}" for c in dcols}))
                    base = (base.with_columns(_norm_key(pl.col(left_col), fold).alias("__rk"))
                                .join(dim, on="__rk", how="left", coalesce=True).drop("__rk"))
                    have = base.collect_schema().names()
                    done.add(_key(to_name))
                    nxt.append((to_name, f"{to_name}."))
            frontier, depth = nxt, depth + 1
        return base

    # -- groups -------------------------------------------------------------
    def _group_job(self, g: dict, files: list[str]) -> dict:
        job = {**copy.deepcopy(g["setup"]), "files": files}
        job["processing"] = self.ws.get("processing") or job.get("processing") or "sequential"
        # A relationship on a column the group doesn't keep still works: the column is
        # read alongside and dropped again from the group's own table (see get()).
        keys = self._rel_keys(g["name"])
        picks = [c for c in job.get("columns") or [] if c.get("include", True) and c.get("name")]
        if keys and picks:
            out_names = {(c.get("alias") or "").strip() or c["name"] for c in picks}
            out_names |= {(a.get("name") or "").strip() for a in job.get("add_columns") or []
                          if a.get("enabled") is not False}
            hid = [k for k in keys if k not in out_names]
            if hid:
                job["columns"] = list(job.get("columns") or []) + [{"name": k, "include": True} for k in hid]
                self.hidden[_key(g["name"])] = hid
        return job

    def _group(self, g: dict) -> pl.LazyFrame:
        files = [f for f in g["files"] if Path(f).exists()]
        missing = len(g["files"]) - len(files)
        if missing:
            self.notes.append(f"{g['name']}: {missing} file(s) no longer exist — skipped")
        self.formats[_key(g["name"])] = dict(((g["setup"].get("output") or {}).get("formats")) or {})
        if not files:
            raise WorkspaceError(f"“{g['name']}” has no files — tick its files on the left, or give it a file rule")
        if self.scope == "all":
            return self._group_all(g, files)
        take = files[:1] if self.scope == "schema" else files[:PREVIEW_FILES]
        job = self._group_job(g, take)
        frames = []
        for f in take:
            src = E.Source.from_dict({**(job.get("source") or {}), "path": f})
            p = E._norm(f)
            if (p.suffix.lower() in E.xlsxfast.FAST_EXT and E._cached_sheet(p, src.sheet) is None
                    and bool(E._peek_cached(str(p), src.encoding, src.sheet).get("fast"))):
                src.sample_rows = E.PREVIEW_SAMPLE if self.scope == "schema" else PREVIEW_ROWS
            lf = E.build_pipeline(src, job, for_preview=True)
            if self.scope == "schema":       # the columns, the duplicate counts included
                return E.across_files(lf, job) if E.batch_dupes(job) else lf
            frames.append(lf.head(PREVIEW_ROWS))
        got = E._collect_many(frames, sequential=True)
        ok = [d for d in got if not isinstance(d, Exception)]
        for d, f in zip(got, take):
            if isinstance(d, Exception):
                self.notes.append(f"{g['name']}: {Path(f).name} — {E.brief(d)}")
        if not ok:
            raise WorkspaceError(f"“{g['name']}”: none of its files could be read")
        if len(files) > len(take):
            self.notes.append(f"{g['name']}: preview uses {len(take)} of {len(files)} files, "
                              f"up to {PREVIEW_ROWS:,} rows each")
        if E.batch_dupes(g["setup"]):
            return E.across_files(E.stacked([d.lazy() for d in ok]), g["setup"]).drop(E.SRC_COL)
        return pl.concat(ok, how="diagonal_relaxed").lazy()

    def _group_all(self, g: dict, files: list[str]) -> pl.LazyFrame:
        job = self._group_job(g, files)
        sub = self.stage / f"g_{g['id']}"
        sub.mkdir(parents=True, exist_ok=True)
        results = E.stage_inputs(job, sub, self.on_progress, self.cancel, label=g["name"])
        for r in results:
            self.per_file.append({"group": g["name"], **{k: v for k, v in r.items() if k != "_path"}})
        good = [r["_path"] for r in results if not r.get("error")]
        if not good:
            raise WorkspaceError(f"“{g['name']}”: every file failed")
        if E.batch_dupes(g["setup"]):          # duplicates over every file of the group, worked out once
            whole = E.across_files(E.stacked([pl.scan_parquet(p) for p in good]), g["setup"]).drop(E.SRC_COL)
            return self._materialise(f"{g['name']} duplicates", whole)
        E._align_stage(good)
        lf = pl.scan_parquet(good if len(good) > 1 else good[0])
        if g["setup"].get("distinct"):
            lf = lf.unique(maintain_order=True)
        return lf

    def _materialise(self, name: str, lf: pl.LazyFrame) -> pl.LazyFrame:
        path = self.stage / f"t_{re.sub(r'[^A-Za-z0-9]+', '_', name)[:40]}_{uuid.uuid4().hex[:6]}.parquet"
        if self.on_progress:
            self.on_progress({"stage": "build", "part": name})
        try:
            lf.sink_parquet(path, compression="lz4")
        except Exception:  # noqa: BLE001 — a plan the streaming sink can't take: collect instead
            lf.collect(engine="streaming").write_parquet(path, compression="lz4")
        return pl.scan_parquet(path)

    # -- steps --------------------------------------------------------------
    def _step(self, s: dict) -> pl.LazyFrame:
        kind = s.get("kind")
        fn = {"append": self._append, "merge": self._merge, "lookup": self._lookup, "sql": self._sql,
              "transform": self._transform, "group": self._groupby}.get(kind)
        if fn is None:
            raise WorkspaceError(f"Step “{s['name']}”: unknown kind “{kind}”")
        try:
            lf = fn(s)
        except (WorkspaceError, F.FormulaError, A.AnalysisError) as exc:
            raise WorkspaceError(f"Step “{s['name']}”: {exc}") from None
        except pl.exceptions.PolarsError as exc:
            raise WorkspaceError(f"Step “{s['name']}”: {E.brief(exc)}") from None
        return lf

    def _need_cols(self, table: str, cols: list[str], lf: pl.LazyFrame) -> None:
        have = lf.collect_schema().names()
        miss = [c for c in cols if c not in have]
        if miss:
            raise WorkspaceError(f"{table} has no column {', '.join(miss)}")

    def _inherit(self, s: dict, sources: list[str]) -> None:
        fm: dict = {}
        for n in sources:
            for c, v in (self.formats.get(_key(n)) or {}).items():
                fm.setdefault(c, v)
        self.formats[_key(s["name"])] = fm

    def _append(self, s: dict) -> pl.LazyFrame:
        names = [n for n in s.get("inputs") or [] if n]
        if len(names) < 1:
            raise WorkspaceError("pick the tables to stack")
        tag = str(s.get("source_col") or "").strip()
        lfs = []
        for n in names:
            lf = self.get(n)
            if tag:
                lf = lf.with_columns(pl.lit(n).alias(tag))
            lfs.append(lf)
        self._inherit(s, names)
        out = pl.concat(lfs, how="diagonal_relaxed")
        if tag:     # the source column first, where a reader looks for it
            cols = out.collect_schema().names()
            out = out.select([tag] + [c for c in cols if c != tag])
        return out

    def _join(self, s: dict, left: str, right: str, on: list[dict], how: str, bring: list[str] | None,
              first_only: bool, fold: bool, suffix: str, flag: str = "", rename: dict | None = None,
              default: str | None = None) -> pl.LazyFrame:
        """The one join behind Merge and Lookup. Keys are compared as trimmed text —
        and without regard to case when `fold` — and a blank key never matches. With
        `flag`, a Yes / No column says whether each row found a match; with `default`,
        brought columns read that text where there was no match."""
        L, R = self.get(left), self.get(right)
        on = [k for k in on if k.get("left") and k.get("right")]
        if not on:
            raise WorkspaceError("pick at least one pair of key columns")
        self._need_cols(left, [k["left"] for k in on], L)
        self._need_cols(right, [k["right"] for k in on], R)
        lcols, rcols = L.collect_schema().names(), R.collect_schema().names()
        rkeys = [k["right"] for k in on]
        if bring is None or not bring:
            bring = [c for c in rcols if c not in rkeys]
        self._need_cols(right, bring, R)
        rename = dict(rename or {})
        kn = [f"__k{i}" for i in range(len(on))]
        Lx = L.with_columns([_norm_key(pl.col(k["left"]), fold).alias(kn[i]) for i, k in enumerate(on)])
        keep_rv = how in ("full", "right")
        sel = [_norm_key(pl.col(k["right"]), fold).alias(kn[i]) for i, k in enumerate(on)]
        if keep_rv:
            sel += [pl.col(k["right"]).alias(f"__rv{i}") for i, k in enumerate(on)]
        final_names: dict[str, str] = {}
        taken = set(lcols)
        for c in bring:
            nm = rename.get(c) or c
            if nm in taken:
                nm = f"{nm}{suffix or '_' + right}"
            taken.add(nm)
            final_names[c] = nm
        if how not in ("semi", "anti"):
            sel += [pl.col(c).alias(f"__b{j}") for j, c in enumerate(bring)]
        mark = bool(flag) or default is not None
        if mark:
            sel.append(pl.lit(True).alias("__m"))
        Rx = R.select(sel).filter(pl.all_horizontal([pl.col(k).is_not_null() for k in kn]))
        if first_only:
            Rx = Rx.unique(subset=kn, keep="first", maintain_order=True)
        if how in ("semi", "anti"):
            out = Lx.join(Rx.select(kn).unique(), on=kn, how=how)
            if flag:
                out = out.with_columns(pl.lit("Yes" if how == "semi" else "No").alias(flag))
            return out.drop(kn)
        out = Lx.join(Rx, on=kn, how=how, coalesce=True,
                      maintain_order="left" if how in ("left", "inner") else "none")
        if keep_rv:
            out = out.with_columns([pl.coalesce([pl.col(k["left"]), pl.col(f"__rv{i}")]).alias(k["left"])
                                    for i, k in enumerate(on)])
        out = out.rename({f"__b{j}": final_names[c] for j, c in enumerate(bring)})
        if default is not None:
            out = out.with_columns([pl.when(pl.col("__m").is_null()).then(pl.lit(default))
                                    .otherwise(pl.col(final_names[c]).cast(pl.String)).alias(final_names[c])
                                    for c in bring])
        if flag:
            out = out.with_columns(pl.when(pl.col("__m").is_not_null()).then(pl.lit("Yes"))
                                   .otherwise(pl.lit("No")).alias(flag))
        drop = kn + ([f"__rv{i}" for i in range(len(on))] if keep_rv else []) + (["__m"] if mark else [])
        return out.drop(drop)

    def _merge(self, s: dict) -> pl.LazyFrame:
        how = s.get("how") or "left"
        if how not in {h for h, _ in JOIN_HOW}:
            raise WorkspaceError(f"unknown join “{how}”")
        left, right = s.get("left"), s.get("right")
        if not left or not right:
            raise WorkspaceError("pick both tables")
        self._inherit(s, [left, right])
        return self._join(s, left, right, s.get("on") or [], how, s.get("columns") or None,
                          bool(s.get("first_only")), s.get("fold", True) is not False,
                          str(s.get("suffix") or ""), str(s.get("flag") or "").strip())

    def _lookup(self, s: dict) -> pl.LazyFrame:
        base, src = s.get("input"), s.get("from")
        if not base or not src:
            raise WorkspaceError("pick the table to add to and the table to look in")
        cols = [c for c in s.get("columns") or [] if (c.get("column") if isinstance(c, dict) else c)]
        bring = [c["column"] if isinstance(c, dict) else c for c in cols]
        rename = {c["column"]: (c.get("as") or "").strip() for c in cols if isinstance(c, dict) and (c.get("as") or "").strip()}
        if not bring:
            raise WorkspaceError("pick the columns to bring back")
        self._inherit(s, [base, src])
        default = str(s.get("default") or "") if (s.get("not_found") or "blank") == "text" else None
        return self._join(s, base, src, s.get("on") or [], "left", bring, True,
                          s.get("fold", True) is not False, str(s.get("suffix") or ""),
                          str(s.get("flag") or "").strip(), rename, default)

    def _sql(self, s: dict) -> pl.LazyFrame:
        names = [obj["name"] for _, obj in self.by_name.values() if _key(obj["name"]) != _key(s["name"])]
        lf, used = sql_over(s.get("sql"), names, self.get, s.get("numbers") or "auto")
        self._inherit(s, used)
        return lf

    def _transform(self, s: dict) -> pl.LazyFrame:
        src = s.get("input")
        if not src:
            raise WorkspaceError("pick the table to transform")
        self._inherit(s, [src])
        lf = _as_text(self.get(src))
        lf = E.apply_filters(lf, s.get("filters") or {})
        lf = E.add_computed(lf, s.get("add_columns") or [], {"filename": s["name"], "filestem": s["name"],
                                                              "filepath": "", "folder": "", "sheet": ""})
        picks = [c for c in s.get("columns") or [] if c.get("include", True) and c.get("name")]
        if picks:
            have = lf.collect_schema().names()
            miss = [c["name"] for c in picks if c["name"] not in have]
            if miss:
                raise WorkspaceError(f"no column {', '.join(miss)}")
            lf = lf.select([pl.col(c["name"]).alias((c.get("alias") or "").strip() or c["name"]) for c in picks])
        if s.get("distinct"):
            lf = lf.unique(maintain_order=True)
        sorts = [x for x in s.get("sort") or [] if x.get("column")]
        if sorts:
            exprs, desc = [], []
            for x in sorts:
                for e in _sort_expr(x["column"]):
                    exprs.append(e)
                    desc.append(bool(x.get("desc")))
            lf = lf.sort(exprs, descending=desc, nulls_last=True, maintain_order=True)
        if s.get("limit"):
            lf = lf.head(int(s["limit"]))
        return lf

    def _groupby(self, s: dict) -> pl.LazyFrame:
        src = s.get("input")
        if not src:
            raise WorkspaceError("pick the table to group")
        lf = _as_text(self.get(src))
        cols = lf.collect_schema().names()
        by = [b for b in s.get("by") or [] if b]
        self._need_cols(src, by, lf)
        vals = [v for v in s.get("values") or [] if v.get("column") or v.get("expr")]
        if not vals:
            raise WorkspaceError("add at least one total")
        aggs = [A._agg_expr(v, cols).alias(A.value_name(v)) for v in vals]
        fm = {}
        for v in vals:
            code = v.get("fmt") or A.DEFAULT_FMT.get(v.get("agg") or "sum")
            if code and (v.get("agg") or "sum") in A.DEFAULT_FMT:
                fm[A.value_name(v)] = {"type": "number", "fmt": code}
        self.formats[_key(s["name"])] = fm
        if not by:
            return lf.select(aggs)
        keys = [pl.col(b).fill_null("") for b in by]
        out = lf.group_by(keys, maintain_order=True).agg(aggs)
        return out.sort([e for b in by for e in _sort_expr(b)], nulls_last=True)


def sql_over(q: Any, names: list[str], get: Callable[[str], pl.LazyFrame], numbers: str = "auto") -> tuple[pl.LazyFrame, list[str]]:
    """A SELECT over the named tables. Each table answers to its name, and to it with
    spaces as underscores (FROM All_groups); only the tables the query names are built."""
    q = str(q or "").strip().rstrip(";")
    if not q:
        raise WorkspaceError("write a SELECT")
    if not re.match(r"(?is)^\s*(with|select)\b", q):
        raise WorkspaceError("only SELECT (or WITH … SELECT) queries run here")
    ctx = pl.SQLContext()
    used = []
    for nm in names:
        safe = re.sub(r"\W+", "_", nm).strip("_")
        alias = [a for a in {nm, safe, nm.lower(), safe.lower()} if a]
        if not any(re.search(r'(?<![\w"])' + re.escape(a) + r'(?![\w"])', q, re.I) or f'"{a}"' in q for a in alias):
            continue
        lf = get(nm)
        if numbers == "auto":
            lf = _typed(lf)
        for a in alias:
            ctx.register(a, lf)
        used.append(nm)
    if not used:
        raise WorkspaceError("the query names none of the tables — use a table's name after FROM")
    return ctx.execute(q, eager=False), used


def _typed(lf: pl.LazyFrame) -> pl.LazyFrame:
    """For SQL: text columns whose sampled values all read as numbers become numbers,
    so SUM(AMOUNT) and AMOUNT > 100 behave. ID-like columns (…_NO, CODE, 13-digit
    tickets, values with leading zeros) stay text so their keys still match."""
    sch = lf.collect_schema()
    text = [c for c, t in sch.items() if t == pl.String and not _IDLIKE.search(c)]
    if not text:
        return lf
    sample = lf.select(text).head(SQL_SAMPLE).collect()
    conv = []
    for c in text:
        s = sample[c].drop_nulls().str.strip_chars()
        s = s.filter(s != "")
        if not len(s):
            continue
        if s.str.contains(r"^0\d").any() or s.str.contains(r"^\d{9,}$").all():
            continue
        if pl.select(F.clean_number(pl.lit(s)).is_null().any()).item():
            continue
        conv.append(c)
    return lf.with_columns([F.clean_number(pl.col(c)).alias(c) for c in conv]) if conv else lf


# --------------------------------------------------------------------------
# what the UI asks for
# --------------------------------------------------------------------------

def schema(ws: dict) -> dict:
    """Column lists for every table (and, with relationships, the columns an analysis
    on it can use). Reads only headers and a sample."""
    t0 = time.time()
    b = Builder(ws, "schema")
    out = []
    problems = validate(b.ws)
    for t in tables_of(b.ws):
        item: dict[str, Any] = {"name": t["name"], "kind": t["kind"], "id": t["id"]}
        try:
            item["columns"] = b.get(t["name"]).collect_schema().names()
            if t.get("is_group"):           # what a relationship can use beyond the kept columns
                g = b.by_name[_key(t["name"])][1]
                first = next((f for f in g["files"] if Path(f).exists()), None)
                if first:
                    try:
                        src = E.Source.from_dict({**(g["setup"].get("source") or {}), "path": first})
                        item["source_columns"] = E._schema_names(src)
                    except Exception:  # noqa: BLE001
                        pass
            try:
                rel = b.related(t["name"]).collect_schema().names()
                item["related"] = [c for c in rel if c not in item["columns"]]
            except Exception as exc:  # noqa: BLE001
                item["related"] = []
                item["related_error"] = E.brief(exc)
        except Exception as exc:  # noqa: BLE001 — one bad step must not hide the others
            item["error"] = str(exc) if isinstance(exc, WorkspaceError) else E.brief(exc)
            item["columns"] = []
        out.append(item)
    return {"ok": True, "tables": out, "problems": problems, "notes": b.notes,
            "elapsed": round(time.time() - t0, 2)}


def preview(ws: dict, table: str, rows: int = 200, related: bool = False) -> dict:
    t0 = time.time()
    b = Builder(ws, "preview")
    try:
        lf = b.related(table) if related else b.get(table)
        df = _as_text(lf).head(int(rows)).collect()
        n = lf.select(pl.len()).collect().item()
    except (WorkspaceError, F.FormulaError, A.AnalysisError, ValueError) as exc:
        return {"ok": False, "error": str(exc), "notes": b.notes}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": E.brief(exc), "notes": b.notes}
    return {"ok": True, "table": table, "columns": df.columns, "shown": df.height, "rows_in_preview": int(n),
            "rows": [["" if v is None else str(v) for v in r] for r in df.iter_rows()],
            "notes": b.notes, "elapsed": round(time.time() - t0, 2)}


def _report(ws: dict, report: dict | str | None) -> dict:
    if isinstance(report, dict):
        return report
    for r in ws.get("reports") or []:
        if r.get("id") == report or r.get("name") == report:
            return r
    raise WorkspaceError("No such report")


def _frame_for(ws: dict, table: str, scope: str, on_progress=None, cancel=None) -> tuple[pl.DataFrame, list[str], Path | None]:
    stage = E._stage_dir() if scope == "all" else None
    try:
        b = Builder(ws, "all" if scope == "all" else "preview", on_progress, cancel, stage)
        df = b.related(table).collect(engine="streaming")
        return df, b.notes, stage
    except BaseException:
        if stage is not None:
            shutil.rmtree(stage, ignore_errors=True)
        raise


OVERVIEW_ID = "__overview"


def _is_overview(report: Any) -> bool:
    return isinstance(report, dict) and (report.get("id") == OVERVIEW_ID or bool(report.get("overview")))


def _card_table(x: dict, tables: dict[str, str]) -> str | None:
    return tables.get(_key(x.get("table") or ""))


def overview_result(ws: dict, ov: dict, frame: Callable[[str], pl.LazyFrame]) -> dict:
    """One dashboard over several tables. Each card and summary tab names the table it
    reads; `frame(table)` hands that table (with its relationship fields) once. The
    dashboard's filters — slicers, clicked values — reach every card whose table has
    the filtered field, so a slicer on TAX_CODE narrows Sales and Refunds alike."""
    tables = {_key(n): n for n in [t["name"] for t in tables_of(ws)]}
    an, su = ov.get("analysis") or {}, ov.get("summaries") or {}
    items = [i for i in an.get("items") or [] if i.get("enabled") is not False]
    tabs = [t for t in su.get("tabs") or [] if t.get("enabled") is not False]
    filters = [f for f in an.get("filters") or [] if f.get("enabled") is not False and
               [v for v in f.get("values") or [] if str(v) != ""]]
    order = list(dict.fromkeys(n for n in (_card_table(x, tables) for x in items + tabs) if n))
    got_items: dict[str, dict] = {}
    got_tabs: dict[str, dict] = {}
    facets: dict[str, dict] = {}
    notes: list[str] = []
    used: set[int] = set()
    info: dict[str, dict] = {}
    columns: list[str] = []
    for t in order:
        mine = [i for i in items if _card_table(i, tables) == t]
        mine_tabs = [x for x in tabs if _card_table(x, tables) == t]
        try:
            lf = frame(t)
            cols = lf.collect_schema().names()
        except Exception as exc:  # noqa: BLE001 — one table that can't be built must not sink the rest
            msg = str(exc) if isinstance(exc, WorkspaceError) else E.brief(exc)
            for x in mine:
                got_items[x["id"]] = {"id": x["id"], "kind": x.get("kind") or "kpi", "name": x.get("name") or "",
                                      "width": x.get("width") or "half", "error": f"{t}: {msg}"}
            for x in mine_tabs:
                got_tabs[x["id"]] = {"id": x["id"], "name": x.get("name") or "Summary", "error": f"{t}: {msg}"}
            continue
        columns += [c for c in cols if c not in columns]
        fl = []
        for i, f in enumerate(filters):
            if A.usable_filters([f], cols):
                fl.append(f)
                used.add(i)
        info[t] = {"columns": cols}
        sub = {"analysis": {"items": mine, "filters": fl}, "summaries": {"tabs": mine_tabs}}
        res = A.analyse(lf, sub, cols)
        for r in res["items"]:                 # "source": the table it reads ("table" is its result)
            got_items[r["id"]] = {**r, "source": t}
        for r in res["tabs"]:
            got_tabs[r["id"]] = {**r, "source": t}
        for k, v in (res.get("facets") or {}).items():
            facets.setdefault(k, v)
    for i, f in enumerate(filters):
        if i not in used and order:
            notes.append(f"Filter on {f.get('column')} reaches no card — none of their tables has that field")
    out_items = []
    for x in items:
        if x["id"] in got_items:
            out_items.append(got_items[x["id"]])
        else:
            out_items.append({"id": x["id"], "kind": x.get("kind") or "kpi", "name": x.get("name") or "",
                              "width": x.get("width") or "half",
                              "error": "Pick the data this card reads" if not x.get("table")
                              else f"There is no table called “{x.get('table')}”"})
    out_tabs = [got_tabs.get(x["id"]) or {"id": x["id"], "name": x.get("name") or "Summary",
                                          "error": "Pick the data this summary reads"} for x in tabs]
    live = [f for i, f in enumerate(filters) if i in used]
    return {"ok": True, "items": out_items, "tabs": out_tabs, "facets": facets, "filters": live,
            "filter_text": A.describe_filters(live), "notes": notes, "columns": columns, "tables": info}


def _overview_frames(b: "Builder") -> Callable[[str], pl.LazyFrame]:
    memo: dict[str, pl.LazyFrame] = {}

    def frame(t: str) -> pl.LazyFrame:
        if t not in memo:
            memo[t] = b.related(t).collect(engine="streaming").lazy()
        return memo[t]
    return frame


def analyse_overview(ws: dict, scope: str = "preview", on_progress=None, cancel=None) -> dict:
    t0 = time.time()
    ws = normalize(ws)
    stage = E._stage_dir() if scope == "all" else None
    try:
        b = Builder(ws, "all" if scope == "all" else "preview", on_progress, cancel, stage)
        res = overview_result(ws, ws["overview"], _overview_frames(b))
        rows = {t: None for t in res["tables"]}
        return {**res, "scope": scope, "note": f"Overview · {len(rows)} table{'' if len(rows) == 1 else 's'}" +
                (" (preview)" if scope != "all" else ""), "sampled": 0,
                "notes": b.notes + res["notes"], "elapsed": round(time.time() - t0, 2)}
    except E.Cancelled:
        return {"ok": False, "cancelled": True, "error": "Cancelled."}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc) if isinstance(exc, WorkspaceError) else E.brief(exc)}
    finally:
        if stage is not None:
            shutil.rmtree(stage, ignore_errors=True)


def _has_cards(spec: dict) -> bool:
    return bool((spec.get("analysis") or {}).get("items") or (spec.get("summaries") or {}).get("tabs"))


def dashboards_with(ws: dict, b: "Builder", only: set[str] | None = None, notify=None) -> dict[str, dict]:
    """Every dashboard of a setup over one Builder: each group's own ("g:<id>"), each
    combined table's ("t:<table>") and the overview ("overview"). In "all" scope the
    groups are staged once and every dashboard reads the staged data."""
    out: dict[str, dict] = {}
    rel_from = {_key(r.get("from")) for r in ws["relationships"] if r["enabled"]}
    frame = _overview_frames(b)
    for g in ws["groups"]:
        k = f"g:{g['id']}"
        if not g["enabled"] or not _has_cards(g["setup"]) or (only is not None and k not in only):
            continue
        if notify:
            notify(stage="analyse", part=g["name"])
        try:
            lf = frame(g["name"]) if _key(g["name"]) in rel_from else \
                b.get(g["name"]).collect(engine="streaming").lazy()
            res = A.analyse(lf, g["setup"])
            out[k] = {**res, "note": f"{g['name']}, {lf.select(pl.len()).collect().item():,} rows"}
        except (WorkspaceError, A.AnalysisError, F.FormulaError) as exc:
            out[k] = {"ok": False, "error": str(exc)}
    for rep in ws["reports"]:
        k = f"t:{rep.get('table')}"
        if not rep.get("table") or not _has_cards(rep) or (only is not None and k not in only):
            continue
        if notify:
            notify(stage="analyse", part=rep["name"])
        try:
            lf = frame(rep["table"])
            res = A.analyse(lf, rep)
            out[k] = {**res, "note": f"{rep['table']}, {lf.select(pl.len()).collect().item():,} rows"}
        except (WorkspaceError, A.AnalysisError, F.FormulaError) as exc:
            out[k] = {"ok": False, "error": str(exc)}
    if _has_cards(ws["overview"]) and (only is None or "overview" in only):
        if notify:
            notify(stage="analyse", part="Overview")
        res = overview_result(ws, ws["overview"], frame)
        out["overview"] = {**res, "note": f"Overview · {len(res['tables'])} tables"}
    return out


def run_dashboards(ws: dict, scope: str = "all", on_progress=None, cancel=None, only: list[str] | None = None) -> dict:
    """The Analysis tab's Run dashboards: every dashboard (or those in `only`), over
    every file, without writing anything."""
    t0 = time.time()
    ws = expand_folders(normalize(E.apply_params(ws)))
    stage = E._stage_dir() if scope == "all" else None
    notify = (lambda **k: on_progress(k)) if on_progress else None
    try:
        b = Builder(ws, "all" if scope == "all" else "preview", on_progress, cancel, stage)
        got = dashboards_with(ws, b, set(only) if only else None, notify)
        for v in got.values():
            v.setdefault("ok", True)
            v["scope"] = scope
        return {"ok": True, "dashboards": got, "notes": b.notes, "elapsed": round(time.time() - t0, 2),
                "rows_read": sum(int(f.get("rows") or 0) for f in b.per_file)}
    except E.Cancelled:
        return {"ok": False, "cancelled": True, "error": "Cancelled."}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc) if isinstance(exc, WorkspaceError) else E.brief(exc)}
    finally:
        if stage is not None:
            shutil.rmtree(stage, ignore_errors=True)


def analyse(ws: dict, report: dict | str, scope: str = "preview", on_progress=None, cancel=None) -> dict:
    """A dashboard / summaries on a workspace table — its lookup tables included."""
    if _is_overview(report):
        return analyse_overview({**(ws or {}), "overview": report}, scope, on_progress, cancel)
    t0 = time.time()
    ws = normalize(ws)
    stage = None
    try:
        rep = _report(ws, report)
        if not rep.get("table"):
            return {"ok": False, "error": "Pick the table this report reads."}
        df, notes, stage = _frame_for(ws, rep["table"], scope, on_progress, cancel)
        res = A.analyse(df.lazy(), rep)
        return {**res, "scope": scope, "note": f"{rep['table']}, {df.height:,} rows" +
                (" (preview)" if scope != "all" else ""), "sampled": 0, "rows_seen": df.height,
                "notes": notes + (res.get("notes") or []), "elapsed": round(time.time() - t0, 2)}
    except (WorkspaceError, A.AnalysisError, F.FormulaError, ValueError) as exc:
        return {"ok": False, "error": str(exc)}
    except E.Cancelled:
        return {"ok": False, "cancelled": True, "error": "Cancelled."}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": E.brief(exc)}
    finally:
        if stage is not None:
            shutil.rmtree(stage, ignore_errors=True)


def drill(ws: dict, report: dict | str, scope: str = "preview", filters: list[dict] | None = None,
          limit: int = 500) -> dict:
    t0 = time.time()
    ws = normalize(ws)
    stage = None
    try:
        rep = _report(ws, report)
        df, notes, stage = _frame_for(ws, rep.get("table") or "", scope)
        # an overview's filters can name fields of other tables; they don't narrow this one
        res = A.detail(df.lazy(), A.usable_filters(list(filters or []), df.columns, notes), df.columns, limit)
        return {**res, "notes": notes, "elapsed": round(time.time() - t0, 2)}
    except (WorkspaceError, A.AnalysisError, F.FormulaError, ValueError) as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": E.brief(exc)}
    finally:
        if stage is not None:
            shutil.rmtree(stage, ignore_errors=True)


def check_relationships(ws: dict) -> dict:
    """For each relationship, on the preview: how many keys the lookup side repeats
    (it should be one row per key) and how many keys on the detail side find nothing."""
    b = Builder(ws, "preview")
    out = []
    for r in b.ws["relationships"]:
        item = {"id": r["id"]}
        try:
            L, R = _as_text(b.get(r["from"])), _as_text(b.get(r["to"]))
            fold = r.get("fold", True)
            lk = L.select(_norm_key(pl.col(r["from_col"]), fold).alias("k")).filter(pl.col("k").is_not_null())
            rk = R.select(_norm_key(pl.col(r["to_col"]), fold).alias("k")).filter(pl.col("k").is_not_null())
            dup, rn, miss, ln = pl.collect_all([
                rk.group_by("k").len().filter(pl.col("len") > 1).select(pl.len()),
                rk.select(pl.col("k").n_unique()),
                lk.unique().join(rk.unique(), on="k", how="anti").select(pl.len()),
                lk.select(pl.col("k").n_unique())])
            item.update(ok=True, duplicate_keys=int(dup.item()), lookup_keys=int(rn.item()),
                        unmatched_keys=int(miss.item()), detail_keys=int(ln.item()))
        except Exception as exc:  # noqa: BLE001
            item.update(ok=False, error=str(exc) if isinstance(exc, WorkspaceError) else E.brief(exc))
        out.append(item)
    return {"ok": True, "relationships": out, "notes": b.notes}


def suggest_relationships(ws: dict) -> dict:
    """Pairs of tables sharing a column name that look like detail -> lookup on the
    preview: the key repeats on the detail side, is unique on the lookup side, and
    most detail keys are found there."""
    b = Builder(ws, "preview")
    names = b.names()
    stats: dict[tuple[str, str], tuple[int, int]] = {}
    cols: dict[str, list[str]] = {}
    for n in names:
        try:
            cols[n] = _as_text(b.get(n)).collect_schema().names()
        except Exception:  # noqa: BLE001
            cols[n] = []
    have = {(_key(r.get("from")), r.get("from_col"), _key(r.get("to")), r.get("to_col")) for r in b.ws["relationships"]}

    def keys(t: str, c: str) -> pl.LazyFrame:
        return _as_text(b.get(t)).select(_norm_key(pl.col(c), True).alias("k")).filter(pl.col("k").is_not_null())

    def stat(t: str, c: str) -> tuple[int, int]:
        if (t, c) not in stats:
            n, u = pl.collect_all([keys(t, c).select(pl.len()), keys(t, c).select(pl.col("k").n_unique())])
            stats[(t, c)] = (int(n.item()), int(u.item()))
        return stats[(t, c)]

    out = []
    for a in names:
        for z in names:
            if a == z or set(cols[a]) == set(cols[z]):
                continue
            for c in [c for c in cols[a] if c in cols[z]]:
                if (_key(a), c, _key(z), c) in have:
                    continue
                try:
                    an, au = stat(a, c)
                    zn, zu = stat(z, c)
                    if not (zn and zn == zu and an > au and zu < an):
                        continue
                    hit = keys(a, c).unique().join(keys(z, c).unique(), on="k", how="semi").select(pl.len()).collect().item()
                    if au and hit / au >= 0.5:
                        out.append({"from": a, "from_col": c, "to": z, "to_col": c, "coverage": round(hit / au, 3)})
                except Exception:  # noqa: BLE001
                    continue
    out.sort(key=lambda r: -r["coverage"])
    return {"ok": True, "suggestions": out[:40]}


# --------------------------------------------------------------------------
# the run
# --------------------------------------------------------------------------

def _auto_formats(lf: pl.LazyFrame, given: dict, detect: bool) -> dict:
    """Numbers from SQL / group steps become number cells; with `detect`, text columns
    whose values all read as numbers or dates do too (ID-like names excepted)."""
    sch = lf.collect_schema()
    fm = {c: v for c, v in (given or {}).items() if c in sch}
    for c, t in sch.items():
        if c in fm:
            continue
        if t.is_float():
            fm[c] = {"type": "number", "fmt": "#,##0.00"}
        elif t.is_integer():
            fm[c] = {"type": "number", "fmt": "#,##0"}
        elif t == pl.Date:
            fm[c] = {"type": "date", "fmt": "dd/mm/yyyy"}
    if detect:
        text = [c for c, t in sch.items() if t == pl.String and c not in fm and not _IDLIKE.search(c)]
        if text:
            sample = lf.select(text).head(SQL_SAMPLE).collect()
            for c in text:
                s = sample[c].drop_nulls().str.strip_chars()
                s = s.filter(s != "")
                if not len(s):
                    continue
                if s.str.contains(r"[/\-.A-Za-z]").all() and s.str.contains(r"\d").all() and \
                        not pl.select(F.parse_date(pl.lit(s)).is_null().any()).item():
                    fm[c] = {"type": "date", "fmt": "dd/mm/yyyy"}
                elif not (s.str.contains(r"^-?0\d").any() or s.str.contains(r"^\d{9,}$").all()) and \
                        not pl.select(F.clean_number(pl.lit(s)).is_null().any()).item():
                    dec = s.str.contains(r"\.\d").any()
                    fm[c] = {"type": "number", "fmt": "#,##0.00" if dec else "0"}
    return fm


def _out_tables(ws: dict) -> list[dict]:
    """The tables the run writes, in order, with their sheet / file names."""
    tabs = tables_of(ws)
    names = [t["name"] for t in tabs]
    chosen = [t for t in ws["output"].get("tables") or [] if t.get("table")]
    if not chosen:
        if stacked(ws):             # stacked: "All groups" stands in for the separate groups
            return [{"table": t["name"], "sheet": t["name"]} for t in tabs if not t.get("is_group")]
        return [{"table": n, "sheet": n} for n in names]
    known = {_key(n): n for n in names}
    return [{"table": known[_key(t["table"])], "sheet": (t.get("sheet") or "").strip() or known[_key(t["table"])]}
            for t in chosen if t.get("enabled", True) is not False and _key(t["table"]) in known]


def run(ws: dict, on_progress=None, cancel=None) -> dict:
    """Stage every group, build every chosen table, and write them all — one workbook
    with a sheet each, or one CSV / TXT file each — plus the reports."""
    t0 = time.time()
    ws = normalize(ws)
    out = dict(ws["output"])
    if not out.get("folder"):
        return {"ok": False, "error": "Choose an output folder on the Output tab."}
    problems = validate(ws)
    if problems:
        return {"ok": False, "error": problems[0], "problems": problems}
    wanted = _out_tables(ws)
    if not wanted:
        return {"ok": False, "error": "Tick at least one table to write."}
    fmt = (out.get("format") or "xlsx").lower()
    notify = (lambda **k: on_progress(k)) if on_progress else (lambda **k: None)
    stage = E._stage_dir()
    written: list[str] = []
    warnings: list[str] = []
    b = Builder(ws, "all", on_progress, cancel, stage)
    try:
        base = E._safe_name(out.get("basename") or "workspace")
        frames = []
        for t in wanted:
            E._check_cancel(cancel)
            try:
                lf = b.get(t["table"])
            except WorkspaceError as exc:
                warnings.append(str(exc))
                continue
            n = lf.select(pl.len()).collect().item()
            fm = _auto_formats(lf, b.formats.get(_key(t["table"])) or {}, bool(out.get("autotype", True)))
            frames.append({**t, "lf": lf, "rows": int(n), "formats": fm})
        if not frames:
            return {"ok": False, "error": warnings[0] if warnings else "No table could be built.",
                    "warnings": warnings, "files": b.per_file}

        # checks: worked out on the built tables before anything is written
        results = check_tables(ws, b.get, b.names(), cancel, notify)
        verdict = C.verdict(results)
        if verdict["stop"]:
            return {"ok": False, "stopped": True, "error": verdict["error"], "checks": results,
                    "warnings": warnings + b.notes, "files": b.per_file}
        warnings += verdict["warnings"]
        check_grid = C.grid(results) if results and out.get("checks_sheet", True) is not False else None

        # dashboards: each group's own, those on combined tables, the overview — computed
        # once over the staged data, for the sheets, the PDFs and (when asked) the window
        extra: list[dict] = []
        pdfs: list[tuple[str, dict, dict, str]] = []
        want_dash = bool(out.get("refresh_dashboards"))
        specs: list[tuple[str, str, dict]] = []          # key, title, spec
        specs += [(f"g:{g['id']}", g["name"], g["setup"]) for g in ws["groups"] if g["enabled"]]
        specs += [(f"t:{r['table']}", r["name"], r) for r in ws["reports"] if r.get("table")]
        specs.append(("overview", ws["overview"]["name"], ws["overview"]))
        need = {k for k, _, sp in specs if _has_cards(sp) and
                (E.wants_analysis(sp) or E.pdf_parts({**sp, "output": out}) or want_dash)}
        dash = dashboards_with(ws, b, need, notify) if need else {}
        for k, title, sp in specs:
            res = dash.get(k)
            if res is None:
                continue
            if res.get("ok") is False:
                warnings.append(f"{title} analysis skipped — {res.get('error')}")
                continue
            warnings += [f"{title} · {i['name']}: {i['error']}" for i in res["items"] if i.get("error")]
            warnings += [f"{title} · {x['name']}: {x['error']}" for x in res["tabs"] if x.get("error")]
            if k == "overview":           # which table each card reads, in the sheet and the PDF
                res = {**res, "items": [{**i, "name": f"{i.get('name') or ''} · {i['source']}"} if i.get("source") else i
                                        for i in res["items"]],
                       "tabs": [{**x, "name": f"{x.get('name') or ''} · {x['source']}"} if x.get("source") else x
                                for x in res["tabs"]]}
            if E.wants_analysis(sp):
                for grid in E.analysis_grids(res, sp):
                    own = k == "overview" and grid["name"] == ((sp.get("analysis") or {}).get("sheet_name") or "Overview")
                    extra.append({**grid, "name": grid["name"] if own else f"{title} {grid['name']}"})
            if E.pdf_parts({**sp, "output": out}):
                pdfs.append((title, sp, res, res.get("note") or title))

        if fmt == "xlsx" and (out.get("layout") or "workbook") == "workbook":
            if check_grid:
                extra.append(check_grid)
            used: set[str] = set()
            sheets = []
            for fr in frames:
                parts = max(1, -(-fr["rows"] // E.XLSX_MAX_ROWS))
                for i in range(parts):
                    nm = fr["sheet"] if parts == 1 else f"{fr['sheet'][:26]}_{i + 1}"
                    sheets.append({"name": E._unique(E._safe_sheet(nm), used, 31),
                                   "lf": fr["lf"].slice(i * E.XLSX_MAX_ROWS, E.XLSX_MAX_ROWS) if parts > 1 else fr["lf"],
                                   "rows": min(E.XLSX_MAX_ROWS, fr["rows"] - i * E.XLSX_MAX_ROWS) if parts > 1 else fr["rows"],
                                   "formats": fr["formats"]})
            for e in extra:
                e["name"] = A.sheet_name(e["name"], used)
            path = E._out_path(out, base, "xlsx")
            notify(stage="write", rows=0, total=sum(f["rows"] for f in frames), part=path.name)
            E.write_xlsx_book(path, sheets + extra, out, cancel,
                              lambda off, tot, part: notify(stage="write", rows=off, total=tot, part=part))
            written.append(str(path))
        else:
            for fr in frames:
                E._check_cancel(cancel)
                stem = f"{base}_{E._safe_name(fr['sheet'], 60)}"
                notify(stage="write", rows=0, total=fr["rows"], part=fr["sheet"])
                if fmt == "xlsx":
                    path = E._out_path(out, stem, "xlsx")
                    parts = max(1, -(-fr["rows"] // E.XLSX_MAX_ROWS))
                    E.write_xlsx_book(path, [{"name": "Data" if parts == 1 else f"Data_{i + 1}",
                                              "lf": fr["lf"].slice(i * E.XLSX_MAX_ROWS, E.XLSX_MAX_ROWS),
                                              "rows": min(E.XLSX_MAX_ROWS, fr["rows"] - i * E.XLSX_MAX_ROWS),
                                              "formats": fr["formats"]} for i in range(parts)], out, cancel)
                else:
                    path = E._out_path(out, stem, fmt)
                    E._write_csv_part(_as_text(fr["lf"]), path, {**out, "formats": fr["formats"]})
                written.append(str(path))
            if extra:
                if fmt == "xlsx":
                    path = E._out_path(out, f"{base}_analysis", "xlsx")
                    used = set()
                    for e in extra:
                        e["name"] = A.sheet_name(e["name"], used)
                    E.write_xlsx_book(path, extra, out, cancel)
                    written.append(str(path))
                else:
                    for e in extra:
                        pth = E._out_path(out, f"{base}_{E._safe_name(e['name'], 60)}", fmt)
                        E._write_grid_csv(e["grid"], pth, out)
                        written.append(str(pth))
            if check_grid:
                pth = E._out_path(out, f"{base}_{C.SHEET}", fmt)
                if fmt == "xlsx":
                    E.write_xlsx_book(pth, [check_grid], out, cancel)
                else:
                    E._write_grid_csv(check_grid["grid"], pth, out)
                written.append(str(pth))
        for name, spec, res, sub in pdfs:
            stem = f"{base}_{E._safe_name(name, 50)}" if len(pdfs) > 1 else base
            written += E.write_pdfs(res, {**spec, "output": out}, out, stem,
                                    (out.get("pdf") or {}).get("title") or name, sub)
        for fr in frames:
            if fr["formats"]:
                warnings += E.format_warnings(_as_text(fr["lf"]), fr["formats"], f"{fr['sheet']}: ")
        warnings += b.notes
        errors = [f"{f.get('group')}: {f['file']} — {f['error']}" for f in b.per_file if f.get("error")]
        elapsed = round(time.time() - t0, 2)
        log = _write_log(ws, frames, b.per_file, written, errors, warnings, elapsed, results) if out.get("log") else None
        if want_dash:
            for v in dash.values():
                v.setdefault("ok", True)
                v["scope"] = "all"
        return {"ok": True, "written": written, "rows": sum(f["rows"] for f in frames),
                "tables": [{"table": f["table"], "sheet": f["sheet"], "rows": f["rows"]} for f in frames],
                "files": [{**f, "file": f"{f.get('group')}: {f['file']}"} for f in b.per_file],
                "errors": errors, "warnings": warnings, "log": log, "elapsed": elapsed,
                "dashboards": dash if want_dash else None, "checks": results}
    except E.Cancelled:
        for w in written:
            try:
                Path(w).unlink()
            except OSError:
                pass
        return {"ok": False, "cancelled": True, "error": "Cancelled — nothing from this run was kept.",
                "files": b.per_file}
    except E.StoppedOnError as exc:
        return {"ok": False, "error": str(exc), "files": b.per_file}
    except (E.OutputLocked, WorkspaceError, ValueError) as exc:
        return {"ok": False, "error": str(exc), "files": b.per_file}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": E.brief(exc), "files": b.per_file}
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def run_setup(ws: dict, on_progress=None, cancel=None) -> dict:
    """The Run button. A setup with one group and no combine step is the classic
    extract — engine.run, with every one of its options (one file per input,
    splitting, per-file row counts). Anything more: every group's ColSift work,
    then the combine steps on those results, then one export."""
    ws = expand_folders(from_any(E.apply_params(ws)))
    if not [g for g in ws["groups"] if g["enabled"]]:
        return {"ok": False, "error": "The setup has no groups."}
    if is_classic(ws):
        g = next(g for g in ws["groups"] if g["enabled"])
        job = group_job(ws, g)
        if not job["files"]:
            return {"ok": False, "error": f"Tick the files for “{g['name']}” on the left."}
        want = bool(ws["output"].get("refresh_dashboards")) and _has_cards(g["setup"])
        if want:
            job["_return_analysis"] = True
        if any(c["enabled"] for c in ws["checks"]):
            job["_checks"] = _classic_checks(ws, g, cancel)
        res = E.run(job, on_progress, cancel)
        got = res.pop("analysis", None)
        if want and res.get("ok"):
            if got is None:          # one output per input file: the dashboard reads them all, so read again
                again = run_dashboards(ws, "all", on_progress, cancel, [f"g:{g['id']}"])
                got = (again.get("dashboards") or {}).get(f"g:{g['id']}")
            if got is not None:
                res["dashboards"] = {f"g:{g['id']}": {**got, "ok": got.get("ok", True), "scope": "all"}}
        return {**res, "mode": "single"}
    return {**run(ws, on_progress, cancel), "mode": "combined"}


def check_tables(ws: dict, get: Callable[[str], pl.LazyFrame], names: list[str], cancel=None, notify=None) -> list[dict]:
    """The setup's enabled checks over tables `get` builds."""
    if not any(c["enabled"] for c in ws.get("checks") or []):
        return []
    if notify:
        notify(stage="build", part="checks")
    return C.evaluate(ws["checks"], get, names, lambda q: sql_over(q, names, get)[0], cancel, E._check_cancel)


def _classic_checks(ws: dict, g: dict, cancel=None) -> Callable[[pl.LazyFrame], dict]:
    """For engine.run: the checks over the one table a plain extract writes."""
    names = [g["name"]]

    def hook(whole: pl.LazyFrame) -> dict:
        def get(t: str) -> pl.LazyFrame:
            if _key(t) in ("", _key(g["name"])):
                return whole
            raise WorkspaceError(f"There is no table called “{t}” — this setup builds one table, “{g['name']}”")
        results = check_tables(ws, get, names, cancel)
        grid = C.grid(results) if results and ws["output"].get("checks_sheet", True) is not False else None
        return {**C.verdict(results), "results": results, "grid": grid, "log": C.log_lines(results)}
    return hook


def test_checks(ws: dict, scope: str = "all", on_progress=None, cancel=None) -> dict:
    """The Check now button: the checks over every file (or the preview's sample),
    nothing written."""
    t0 = time.time()
    ws = expand_folders(from_any(E.apply_params(ws)))
    if not any(c["enabled"] for c in ws["checks"]):
        return {"ok": True, "checks": [], "scope": scope}
    stage = E._stage_dir() if scope == "all" else None
    b = Builder(ws, "all" if scope == "all" else "preview", on_progress, cancel, stage)
    try:
        results = check_tables(ws, b.get, b.names(), cancel)
    except E.Cancelled:
        return {"ok": False, "cancelled": True, "error": "Cancelled."}
    finally:
        if stage is not None:
            shutil.rmtree(stage, ignore_errors=True)
    v = C.verdict(results)
    return {"ok": True, "checks": results, "scope": scope, "passed": v["passed"], "failed": v["failed"],
            "stop": v["stop"], "notes": b.notes, "files": b.per_file, "elapsed": round(time.time() - t0, 2)}


def _write_log(ws: dict, frames: list[dict], per_file: list[dict], written: list[str], errors: list[str],
               warnings: list[str], elapsed: float, checks: list[dict] | None = None) -> str:
    out = ws["output"]
    path = E._norm(out["folder"]) / f"{E._safe_name(out.get('basename') or 'workspace')}_log.txt"
    lines = [f"ColSift run — {ws.get('name') or 'setup'} — {datetime.now():%Y-%m-%d %H:%M:%S}", "",
             f"Format: {(out.get('format') or 'xlsx').upper()} · "
             f"{'one workbook' if out.get('layout', 'workbook') == 'workbook' else 'a file per table'}", "",
             "Groups:"]
    for g in ws["groups"]:
        if g["enabled"]:
            lines.append(f"  {g['name']:<28} {len(g['files'])} file(s) · filters: "
                         f"{E.describe_filters(g['setup'].get('filters'))}")
    if ws["steps"]:
        lines += ["", "Steps:"] + [f"  {s['name']:<28} {s.get('kind')}" for s in ws["steps"] if s["enabled"]]
    if ws["relationships"]:
        lines += ["", "Relationships:"] + [f"  {r.get('from')}.{r.get('from_col')} -> {r.get('to')}.{r.get('to_col')}"
                                           for r in ws["relationships"] if r["enabled"]]
    lines += ["", "Input files:"]
    for f in per_file:
        state = f"ERROR  {f['error']}" if f.get("error") else f"{f.get('rows') or 0:>12,} rows"
        lines.append(f"  {f.get('group', '')}: {f['file']:<44} {state}")
    lines += ["", "Tables written:"] + [f"  {f['sheet']:<32} {f['rows']:>12,} rows" for f in frames]
    lines += ["", "Files:"] + [f"  {w}" for w in written] + ["", f"Elapsed: {elapsed}s"]
    lines += C.log_lines(checks or [])
    if warnings:
        lines += ["", "Warnings:"] + [f"  {w}" for w in warnings]
    if errors:
        lines += ["", "Errors:"] + [f"  {e}" for e in errors]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(path)


# --------------------------------------------------------------------------
# saved workspaces
# --------------------------------------------------------------------------

def ws_dir() -> Path:
    """Where 2.0's first cut kept workspaces. They now live in the one setup list;
    save() writes there, and this folder is only read."""
    d = E.profile_dir() / "workspaces"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9 _.()-]", "_", (name or "workspace").strip()) or "workspace"


def save(name: str, ws: dict) -> dict:
    ws = normalize(ws)
    ws["name"] = name.strip() or ws.get("name") or _safe(name)
    return E.save_profile(name, ws)


def list_saved() -> list[dict]:
    return [p for p in E.list_profiles() if p.get("groups", 1) > 1 or Path(p["path"]).parent.name == "workspaces"]


def load(name: str) -> dict:
    r = E.load_profile(name)
    if not r["ok"]:
        return {"ok": False, "error": f"No setup named {name}"}
    return {"ok": True, "workspace": r["setup"]}


def delete(name: str) -> dict:
    return E.delete_profile(name)


# --------------------------------------------------------------------------
# headless
# --------------------------------------------------------------------------

def _cli(argv: list[str]) -> int:
    import argparse
    import sys

    ap = argparse.ArgumentParser(prog="colsift-workspace", description="Run a ColSift workspace.")
    ap.add_argument("--workspace", help="saved workspace name")
    ap.add_argument("--file", help="workspace JSON file")
    ap.add_argument("--folder", help="re-assign files from this folder with the groups' rules")
    ap.add_argument("--recursive", action="store_true")
    ap.add_argument("--out", help="output folder override")
    a = ap.parse_args(argv)
    if a.file:
        ws = json.loads(Path(a.file).read_text(encoding="utf-8"))
    elif a.workspace:
        r = load(a.workspace)
        if not r["ok"]:
            print(r["error"], file=sys.stderr)
            return 2
        ws = r["workspace"]
    else:
        ap.error("need --workspace or --file")
    if a.folder:
        files = [f["path"] for f in E.list_folder(a.folder, a.recursive)["files"]]
        ws = rebind(ws, files)["workspace"]
    if a.out:
        ws.setdefault("output", {})["folder"] = a.out
    res = run_setup(ws, on_progress=lambda p: print(f"  {p}", file=sys.stderr))
    print(json.dumps(res, indent=2, default=str))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    import sys
    raise SystemExit(_cli(sys.argv[1:]))
