"""
First rows of an .xlsx / .xlsm, streamed — without parsing the whole sheet.

calamine (fastexcel) decodes an entire sheet before it returns a single row, so on a
heavy workbook the header row alone used to cost a full parse. This reads the sheet
XML as a stream, stops after N rows, and resolves only the shared strings those rows
use. Cells are rendered the way calamine renders them — whole numbers without ".0",
date-formatted cells as "2026-07-01 00:00:00", booleans as "true"/"false" — and the
grid starts where calamine's does (it drops leading empty rows and columns), so row
numbers and column names agree with the full read that happens later.

The one thing a prefix of the sheet cannot prove is the left edge: a row further down
could hold a value left of anything seen so far. read_rows() reports `exact`; when it
is False the caller should use calamine instead.
"""

from __future__ import annotations

import posixpath
import zipfile
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from xml.etree.ElementTree import iterparse

FAST_EXT = {".xlsx", ".xlsm"}
_DATE_IDS = set(range(14, 23)) | {45, 46, 47}


class NotSupported(Exception):
    pass


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _col_index(ref: str) -> int:
    n = 0
    for ch in ref:
        o = ord(ch)
        if 65 <= o <= 90:
            n = n * 26 + o - 64
        elif 97 <= o <= 122:
            n = n * 26 + o - 96
        else:
            break
    return n - 1


def _row_number(ref: str) -> int:
    digits = "".join(ch for ch in ref if ch.isdigit())
    return int(digits) if digits else 0


def _is_date_code(code: str) -> bool:
    out, i, q = [], 0, False
    while i < len(code):
        ch = code[i]
        if ch == '"':
            q = not q
        elif ch == "\\":
            i += 2
            continue
        elif ch == "[" and not q:
            j = code.find("]", i)
            i = len(code) if j < 0 else j + 1
            continue
        elif not q:
            out.append(ch)
        i += 1
    body = "".join(out).lower()
    return body != "general" and any(c in body for c in "dmyhs")


def _workbook(z: zipfile.ZipFile) -> tuple[list[tuple[str, str]], bool]:
    rels = {}
    with z.open("xl/_rels/workbook.xml.rels") as fh:
        for _, el in iterparse(fh):
            if _local(el.tag) == "Relationship":
                rels[el.get("Id")] = el.get("Target", "")
    sheets, d1904 = [], False
    with z.open("xl/workbook.xml") as fh:
        for _, el in iterparse(fh):
            t = _local(el.tag)
            if t == "workbookPr":
                d1904 = (el.get("date1904") or "").lower() in ("1", "true")
            elif t == "sheet":
                rid = next((v for k, v in el.attrib.items() if _local(k) == "id"), None)
                target = rels.get(rid, "")
                part = target.lstrip("/") if target.startswith("/") else \
                    posixpath.normpath(posixpath.join("xl", target))
                sheets.append((el.get("name", ""), part))
    return sheets, d1904


def sheet_names(path: str) -> list[str]:
    with zipfile.ZipFile(path) as z:
        return [n for n, _ in _workbook(z)[0]]


def _date_styles(z: zipfile.ZipFile) -> list[bool]:
    try:
        fh = z.open("xl/styles.xml")
    except KeyError:
        return []
    fmts: dict[int, str] = {}
    xfs: list[int] = []
    inside = False
    with fh:
        for ev, el in iterparse(fh, events=("start", "end")):
            t = _local(el.tag)
            if t == "cellXfs":
                inside = ev == "start"
            elif ev == "end" and t == "numFmt":
                try:
                    fmts[int(el.get("numFmtId", "-1"))] = el.get("formatCode", "")
                except ValueError:
                    pass
            elif ev == "start" and t == "xf" and inside:
                try:
                    xfs.append(int(el.get("numFmtId") or 0))
                except ValueError:
                    xfs.append(0)
    return [(i in _DATE_IDS) or (i in fmts and _is_date_code(fmts[i])) for i in xfs]


def _shared_strings(z: zipfile.ZipFile, upto: int) -> list[str]:
    """Only as far as index `upto` — writers put strings in order of first use, so the
    first rows of a sheet almost always need only the start of the table."""
    out: list[str] = []
    try:
        fh = z.open("xl/sharedStrings.xml")
    except KeyError:
        return out
    with fh:
        for _, el in iterparse(fh):
            if _local(el.tag) != "si":
                continue
            parts = []
            for ch in el:
                lt = _local(ch.tag)
                if lt == "t":
                    parts.append(ch.text or "")
                elif lt == "r":
                    parts.extend(g.text or "" for g in ch if _local(g.tag) == "t")
            out.append("".join(parts))
            el.clear()
            if len(out) > upto:
                break
    return out


def _num_text(v: str) -> str:
    """calamine's rule, measured: the float's exact binary value rounded to 9 decimal
    places, trailing zeros trimmed (Rust's {:.9}). So 1/3 -> 0.333333333 and
    99999999999999.98 -> 99999999999999.984375 — shortest-repr would get both wrong."""
    try:
        f = float(v)
    except ValueError:
        return v
    if f != f or f in (float("inf"), float("-inf")):
        return v
    try:
        s = format(Decimal(f), ".9f")
    except InvalidOperation:
        return v
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def _date_text(v: str, d1904: bool) -> str:
    try:
        f = float(v)
    except ValueError:
        return v
    if d1904:
        f += 1462
    if f < 60:                      # calamine's shift for Excel's phantom 1900-02-29
        f += 1
    dt = datetime(1899, 12, 30) + timedelta(milliseconds=round(f * 86_400_000))
    s = dt.strftime("%Y-%m-%d %H:%M:%S")
    return s + f".{dt.microsecond // 1000:03d}" if dt.microsecond else s


def read_rows(path: str | Path, sheet: str | None = None, n: int = 40) -> dict:
    p = Path(path)
    if p.suffix.lower() not in FAST_EXT:
        raise NotSupported(f"{p.suffix} needs the full reader")
    try:
        z = zipfile.ZipFile(p)
    except zipfile.BadZipFile as exc:
        raise NotSupported(str(exc)) from exc
    with z:
        try:
            sheets, d1904 = _workbook(z)
        except KeyError as exc:
            raise NotSupported(f"unusual workbook layout: {exc}") from exc
        if not sheets:
            raise NotSupported("no sheets")
        name, part = next(((s, pt) for s, pt in sheets if s == sheet), sheets[0])

        rows: dict[int, dict[int, tuple[str, str | None, str]]] = {}
        dim, first, lo, hi, seq_row = None, None, None, -1, 0
        need_sst, need_style = -1, False
        with z.open(part) as fh:
            cur: dict[int, tuple[str, str | None, str]] = {}
            seq_col, row_no = 0, 0
            for ev, el in iterparse(fh, events=("start", "end")):
                t = _local(el.tag)
                if ev == "start":
                    if t == "row":
                        r = el.get("r")
                        seq_row = int(r) if r and r.isdigit() else seq_row + 1
                        row_no, cur, seq_col = seq_row, {}, 0
                    elif t == "dimension":
                        dim = el.get("ref")
                    continue
                if t == "c":
                    ref = el.get("r")
                    ci = _col_index(ref) if ref else seq_col
                    seq_col = ci + 1
                    typ, st, val = el.get("t", "n"), el.get("s"), None
                    for ch in el:
                        lt = _local(ch.tag)
                        if lt == "v":
                            val = ch.text or None      # <v></v> on an uncached formula = no value
                        elif lt == "is":
                            val = "".join(
                                (g.text or "") if _local(g.tag) == "t" else
                                "".join(x.text or "" for x in g if _local(x.tag) == "t")
                                for g in ch if _local(g.tag) in ("t", "r"))
                    if val is not None:
                        cur[ci] = (typ, st, val)
                        if typ == "s":
                            try:
                                need_sst = max(need_sst, int(val))
                            except ValueError:
                                pass
                        elif typ == "n" and st:
                            need_style = True
                    el.clear()
                elif t == "row":
                    if cur:
                        if first is None:
                            first = row_no
                        rows[row_no] = cur
                        ks = cur.keys()
                        lo = min(ks) if lo is None else min(lo, min(ks))
                        hi = max(hi, max(ks))
                    el.clear()
                    if first is not None and row_no >= first + n - 1:
                        break
                elif t == "sheetData":
                    break

        sst = _shared_strings(z, need_sst) if need_sst >= 0 else []
        dates = _date_styles(z) if need_style else []

    names = [s for s, _ in sheets]
    if first is None:
        return {"rows": [], "exact": True, "sheet": name, "sheets": names, "dimension": dim,
                "rows_est": 0, "width": 0}

    def render(typ: str, st: str | None, val: str):
        if typ == "s":
            try:
                return sst[int(val)]
            except (ValueError, IndexError):
                return None
        if typ in ("inlineStr", "str", "d"):
            return val
        if typ == "b":
            return "true" if val.strip() in ("1", "true") else "false"
        if typ == "e":
            return None
        if st is not None and dates:
            try:
                if dates[int(st)]:
                    return _date_text(val, d1904)
            except (ValueError, IndexError):
                pass
        return _num_text(val)

    width = hi - lo + 1
    out = []
    for r in range(first, first + n):
        if r > max(rows):
            break
        cells = rows.get(r, {})
        line: list[str | None] = [None] * width
        for ci, (typ, st, val) in cells.items():
            line[ci - lo] = render(typ, st, val)
        out.append(line)

    exact = lo == 0
    rows_est = None
    if dim and ":" in dim:
        a, b = dim.split(":", 1)
        exact = exact or _col_index(a) == lo
        rows_est = max(0, _row_number(b) - first + 1)
    return {"rows": out, "exact": exact, "sheet": name, "sheets": names, "dimension": dim,
            "rows_est": rows_est, "width": width}
