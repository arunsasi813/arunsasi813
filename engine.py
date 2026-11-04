"""
ColSift engine — pull a few columns out of very large text/Excel extracts.

No UI dependencies. Import from app.py (pywebview) or run headless:
    python engine.py --job job.json
"""

from __future__ import annotations

import csv as _csv
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import threading
import time
import traceback
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable

import polars as pl

import analysis as A
import formula as F
import xlsxfast

TEXT_EXT = {".csv", ".txt", ".tsv", ".tab", ".dlt", ".del", ".dat",
            ".prn", ".psv", ".pip", ".asc", ".out"}
EXT_DELIM = {".csv": ",", ".tsv": "\t", ".tab": "\t", ".psv": "|", ".pip": "|"}
EXCEL_EXT = {".xlsx", ".xlsm", ".xlsb", ".xls"}
ALL_EXT = TEXT_EXT | EXCEL_EXT

DELIMS = {"comma": ",", "tab": "\t", "pipe": "|", "semicolon": ";", "space": " ", "caret": "^"}
XLSX_MAX_ROWS = 1_048_575  # minus header row


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def frozen() -> bool:
    return bool(getattr(sys, "frozen", False)) or "__compiled__" in globals()


def resource_dir() -> Path:
    """Where read-only bundled files live (ui.html). Under Nuitka onefile this is
    the temp extraction dir — correct for reading, wrong for writing."""
    return Path(__file__).resolve().parent


def app_dir() -> Path:
    """Where the exe actually sits, so writes survive a onefile run."""
    if frozen():
        for cand in (sys.argv[0], sys.executable):
            try:
                p = Path(cand).resolve()
            except OSError:
                continue
            if p.exists() and p.suffix.lower() in {".exe", ".bin", ""} and p.is_file():
                return p.parent
    return Path(__file__).resolve().parent


def writable(d: Path) -> bool:
    try:
        d.mkdir(parents=True, exist_ok=True)
        probe = d / ".colsift_write_test"
        probe.write_text("x", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


def _norm(p: str | os.PathLike) -> Path:
    return Path(str(p)).expanduser().resolve()


def brief(exc: Exception, limit: int = 300) -> str:
    """Polars dumps its whole query plan on failure — keep the first useful line."""
    msg = str(exc).split("\n\nResolved plan")[0].strip()
    msg = re.sub(r"\s*\n\s*", " ", msg)
    if len(msg) > limit:
        msg = msg[:limit].rstrip() + " ..."
    return f"{type(exc).__name__}: {msg}"


def dedupe(names: Iterable[Any]) -> list[str]:
    """Make a clean, unique, non-empty column-name list."""
    out: list[str] = []
    seen: dict[str, int] = {}
    for i, raw in enumerate(names):
        n = "" if raw is None else str(raw).strip()
        n = re.sub(r"\s+", " ", n)
        if not n or n.lower() in {"none", "nan", "null"}:
            n = f"col_{i + 1}"
        key = n.lower()
        if key in seen:
            seen[key] += 1
            n = f"{n} ({seen[key]})"
        else:
            seen[key] = 0
        out.append(n)
    return out


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:,.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} GB"


# --------------------------------------------------------------------------
# memory and logs — what the status bar shows, and where crashes are written
# --------------------------------------------------------------------------

def _win_memory(pid: int | None) -> tuple[int, int] | None:
    import ctypes
    from ctypes import wintypes

    class PMC(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
    k32.K32GetProcessMemoryInfo.restype = wintypes.BOOL
    h = k32.GetCurrentProcess() if pid is None else k32.OpenProcess(0x1000 | 0x0010, False, int(pid))
    if not h:
        return None
    try:
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        if not k32.K32GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb):
            return None
        return int(pmc.WorkingSetSize), int(pmc.PeakWorkingSetSize)
    finally:
        if pid is not None:
            k32.CloseHandle(h)


def process_memory(pid: int | None = None) -> tuple[int, int] | None:
    """(resident bytes now, peak resident bytes) of this process or `pid` — what
    Task Manager calls Memory. None where the platform won't say."""
    try:
        if sys.platform.startswith("win"):
            return _win_memory(pid)
        status = Path(f"/proc/{pid or 'self'}/status")
        if status.exists():
            vals = {}
            for line in status.read_text().splitlines():
                k, _, v = line.partition(":")
                if k in ("VmRSS", "VmHWM"):
                    vals[k] = int(v.split()[0]) * 1024
            return vals.get("VmRSS", 0), vals.get("VmHWM", 0)
        if pid is None:
            import resource
            peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            return peak, peak            # macOS reports bytes
    except Exception:  # noqa: BLE001 — a meter must never break anything
        return None
    return None


def system_memory() -> tuple[int, int] | None:
    """(total, available) physical memory in bytes."""
    try:
        if sys.platform.startswith("win"):
            import ctypes
            from ctypes import wintypes

            class MS(ctypes.Structure):
                _fields_ = [("dwLength", wintypes.DWORD), ("dwMemoryLoad", wintypes.DWORD),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            ms = MS()
            ms.dwLength = ctypes.sizeof(MS)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms)):
                return int(ms.ullTotalPhys), int(ms.ullAvailPhys)
            return None
        info = Path("/proc/meminfo")
        if info.exists():
            vals = {}
            for line in info.read_text().splitlines():
                k, _, v = line.partition(":")
                if k in ("MemTotal", "MemAvailable"):
                    vals[k] = int(v.split()[0]) * 1024
            return vals.get("MemTotal", 0), vals.get("MemAvailable", 0)
    except Exception:  # noqa: BLE001
        return None
    return None


def log_dir() -> Path:
    """Where crash reports go: beside the workbook cache on local disk."""
    local = os.environ.get("LOCALAPPDATA")
    for cand in filter(None, (Path(os.environ["COLSIFT_LOGS"]) if os.environ.get("COLSIFT_LOGS") else None,
                              Path(local) / "ColSift" / "logs" if local else None,
                              Path.home() / ".colsift" / "logs",
                              Path(tempfile.gettempdir()) / "colsift-logs")):
        if writable(cand):
            return cand
    return Path(tempfile.gettempdir())


def is_excel(path: Path) -> bool:
    return path.suffix.lower() in EXCEL_EXT


def resolve_delim(name_or_char: str) -> str:
    if not name_or_char:
        return ","
    return DELIMS.get(name_or_char, name_or_char[:1])


# --------------------------------------------------------------------------
# discovery
# --------------------------------------------------------------------------

def list_folder(folder: str, recursive: bool = False, pattern: str = "") -> dict:
    """Files in a folder that this tool can actually open."""
    root = _norm(folder)
    if not root.is_dir():
        return {"ok": False, "error": f"Not a folder: {root}", "files": []}

    it = root.rglob("*") if recursive else root.glob("*")
    rx = None
    if pattern.strip():
        # wildcard -> regex, case-insensitive
        rx = re.compile(
            "^" + re.escape(pattern.strip()).replace(r"\*", ".*").replace(r"\?", ".") + "$",
            re.I,
        )

    files = []
    for p in it:
        try:
            if not p.is_file() or p.name.startswith("~$"):
                continue
            if p.suffix.lower() not in ALL_EXT:
                continue
            if rx and not rx.match(p.name):
                continue
            st = p.stat()
            files.append(
                {
                    "name": p.name,
                    "path": str(p),
                    "rel": str(p.relative_to(root)),
                    "ext": p.suffix.lower(),
                    "kind": "excel" if is_excel(p) else "text",
                    "size": st.st_size,
                    "size_h": human_size(st.st_size),
                    "modified": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
                }
            )
        except OSError:
            continue

    files.sort(key=lambda f: f["name"].lower())
    return {"ok": True, "root": str(root), "files": files, "count": len(files)}


def sheet_names(path: str) -> list[str]:
    p = _norm(path)
    if not is_excel(p):
        return []
    try:
        return list(_book(p).sheet_names)
    except Exception:
        pass
    try:
        from openpyxl import load_workbook

        wb = load_workbook(str(p), read_only=True, data_only=True)
        try:
            return list(wb.sheetnames)
        finally:
            wb.close()
    except Exception as exc:
        raise RuntimeError(f"Cannot read sheets from {p.name}: {exc}") from exc


# --------------------------------------------------------------------------
# raw peek — the physical first lines, so you can pick the header row
# --------------------------------------------------------------------------

def _open_text(path: Path, encoding: str):
    enc = encoding or "utf-8"
    return open(path, "r", encoding=enc, errors="replace", newline="")


_TRANSCODED: dict[tuple, Path] = {}


def as_utf8(path: Path, encoding: str) -> Path:
    """polars reads UTF-8 only. Copy odd encodings once, in chunks, and reuse."""
    enc = (encoding or "utf-8").lower().replace("_", "-")
    if enc in {"utf-8", "utf8", ""}:
        return path
    st = path.stat()
    key = (str(path), st.st_mtime_ns, st.st_size, enc)
    cached = _TRANSCODED.get(key)
    if cached and cached.exists():
        return cached

    import tempfile

    tmp = Path(tempfile.gettempdir()) / f"colsift_{abs(hash(key)):x}.txt"
    with open(path, "r", encoding=enc, errors="replace", newline="") as src, \
         open(tmp, "w", encoding="utf-8", newline="") as dst:
        while chunk := src.read(1 << 20):
            dst.write(chunk)
    _TRANSCODED[key] = tmp
    return tmp


def raw_peek(path: str, n: int = 40, encoding: str = "utf-8", sheet: str | None = None) -> dict:
    """First n physical rows, unparsed. Drives the header-row picker."""
    p = _norm(path)
    if not p.exists():
        return {"ok": False, "error": f"File not found: {p}"}

    if is_excel(p):
        rows, extra = None, {}
        if _cached_sheet(p, sheet) is None:
            try:   # stream just these rows instead of parsing the whole sheet
                r = xlsxfast.read_rows(p, sheet, n)
                if r["exact"]:
                    rows = [["" if c is None else c for c in row] for row in r["rows"]]
                    extra = {"fast": True, "rows_est": r.get("rows_est")}
            except Exception:  # noqa: BLE001 — .xls/.xlsb or an odd layout: calamine below
                rows = None
        if rows is None:
            try:
                rows = _excel_raw_rows(p, sheet, n)
            except Exception as exc:
                return {"ok": False, "error": str(exc)}
        lines = [" | ".join("" if c is None else str(c) for c in r) for r in rows]
        return {"ok": True, "kind": "excel", "lines": lines, "cells": rows, "delimiter": None, **extra}

    lines = []
    try:
        with _open_text(p, encoding) as fh:
            for i, line in enumerate(fh):
                if i >= n:
                    break
                lines.append(line.rstrip("\r\n"))
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    return {"ok": True, "kind": "text", "lines": lines,
            "delimiter": sniff_delimiter(lines, p.suffix.lower())}


def sniff_delimiter(lines: list[str], ext: str = "") -> str:
    """Consistency beats frequency: the right separator splits every line the same way."""
    rows = [l for l in lines[:25] if l.strip()]
    if not rows:
        return EXT_DELIM.get(ext, ",")

    def score(d: str) -> tuple:
        counts = [l.count(d) for l in rows]
        if not any(counts):
            return (0, 0)
        common = max(set(counts), key=counts.count)
        if common == 0:
            return (0, 0)
        agree = counts.count(common) / len(counts)
        return (agree, common)

    ranked = sorted(",\t|;^~".replace(",", ","), key=lambda d: score(d), reverse=True)
    hint = EXT_DELIM.get(ext)
    if hint and score(hint)[0] >= 0.9:
        return hint
    best = ranked[0]
    if score(best)[0] < 0.5:
        try:
            return _csv.Sniffer().sniff("\n".join(rows), delimiters=",\t|;^").delimiter
        except Exception:
            return hint or ","
    return best


def suggest_header_row(lines: list[str], delimiter: str | None) -> int:
    """First row that looks like labels: most non-empty cells, mostly non-numeric."""
    best_row, best_score = 1, -1.0
    for i, line in enumerate(lines[:30]):
        cells = line.split(delimiter) if delimiter else [c.strip() for c in line.split(" | ")]
        cells = [c.strip().strip('"') for c in cells]
        filled = [c for c in cells if c]
        if len(filled) < 2:
            continue
        wordy = sum(1 for c in filled if not re.fullmatch(r"[-+]?[\d.,/ ]+", c))
        score = len(filled) * 2 + (wordy / len(filled)) * 10 - i * 0.4
        if score > best_score:
            best_score, best_row = score, i + 1
    return best_row


_PEEK_CACHE: dict[tuple, dict] = {}


def _peek_key(p: Path, encoding: str, sheet: str | None) -> tuple:
    try:
        st = p.stat()
    except OSError:
        return (str(p), 0, encoding, sheet or "")
    return (str(p), st.st_mtime_ns, encoding, sheet or "")


def _peek_cached(path: str, encoding: str, sheet: str | None) -> dict:
    p = _norm(path)
    if not p.exists():
        return {"ok": False}
    key = _peek_key(p, encoding, sheet)
    hit = _PEEK_CACHE.get(key)
    if hit is None:
        hit = raw_peek(path, 30, encoding, sheet)
        if len(_PEEK_CACHE) > 64:
            _PEEK_CACHE.clear()
        _PEEK_CACHE[key] = hit
    return hit


# --------------------------------------------------------------------------
# excel readers (calamine first, openpyxl fallback)
# --------------------------------------------------------------------------

def _book(p: Path):
    # Opening is free (measured ~0 ms); calamine does its parsing in load_sheet.
    import fastexcel

    return fastexcel.read_excel(str(p))


def clear_cache() -> None:
    """Drop the small in-memory lookups. The on-disk workbook cache is separate."""
    _PEEK_CACHE.clear()
    _HEADER_CACHE.clear()
    _WIDTH_CACHE.clear()


# --------------------------------------------------------------------------
# workbook cache — parse each sheet once, then scan it as Parquet
# --------------------------------------------------------------------------
# calamine re-parses the whole sheet on every read and there is no way to stop it
# early, so peek -> columns -> preview -> count -> extract used to cost five full
# parses per workbook. The first read now writes the raw sheet (every row, every
# column, headerless) to Parquet; everything after is a lazy scan that reads only
# the columns and row groups a query touches. The raw copy is header-independent,
# so moving the header row or changing filters never invalidates it.

CACHE_VERSION = 1
CACHE_CAP_GB = float(os.environ.get("COLSIFT_CACHE_GB") or 10)
_CACHE_ON = os.environ.get("COLSIFT_NO_CACHE", "").lower() not in {"1", "true", "yes"}
_CACHE_DIR: Path | None = None
_HEADER_CACHE: dict[tuple, list[str]] = {}
_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def set_cache(on: bool) -> None:
    global _CACHE_ON
    _CACHE_ON = bool(on)


def cache_on() -> bool:
    return _CACHE_ON and cache_dir() is not None


def cache_dir() -> Path | None:
    """Local disk, never beside the exe: the copies are big and the exe may sit on
    a share. Templates are the opposite case — small, and they belong with the app."""
    global _CACHE_DIR
    if _CACHE_DIR is not None:
        return _CACHE_DIR
    env, local = os.environ.get("COLSIFT_CACHE"), os.environ.get("LOCALAPPDATA")
    for cand in filter(None, (Path(env) if env else None,
                              Path(local) / "ColSift" / "cache" if local else None,
                              Path.home() / ".cache" / "colsift",
                              Path(tempfile.gettempdir()) / "colsift-cache")):
        if writable(cand):
            _CACHE_DIR = cand
            return cand
    return None


def _resolve_sheet(p: Path, sheet: str | None) -> str:
    names = sheet_names(str(p))
    if not names:
        raise ValueError(f"{p.name} has no sheets")
    return sheet if sheet in names else names[0]


def _sheet_key(p: Path, sheet: str) -> str:
    st = p.stat()
    raw = f"v{CACHE_VERSION}|{p}|{st.st_mtime_ns}|{st.st_size}|{sheet}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:24]


def _read_sheet_raw(p: Path, sheet: str) -> pl.DataFrame:
    """Every cell as text, no header handling. Columns c0..cN."""
    try:
        df = _calamine_sheet(p, sheet)
    except Exception:
        rows = _excel_raw_rows_direct(p, sheet, None)
        width = max((len(r) for r in rows), default=0)
        rows = [r + [""] * (width - len(r)) for r in rows]
        df = pl.DataFrame({f"c{i}": [r[i] for r in rows] for i in range(width)},
                          schema={f"c{i}": pl.String for i in range(width)})
    return df.rename({c: f"c{i}" for i, c in enumerate(df.columns)})


def build_sheet_cache(path: str, sheet: str | None = None) -> dict:
    """Parse one sheet into the cache. Module-level so a process pool can run it."""
    d = cache_dir()
    if d is None:
        raise RuntimeError("No writable cache folder")
    p = _norm(path)
    target = _resolve_sheet(p, sheet)
    key = _sheet_key(p, target)
    pq = d / f"{key}.parquet"
    if pq.exists():
        try:
            os.utime(pq)          # least-recently-used pruning reads this
        except OSError:
            pass
        return {"ok": True, "path": str(pq), "built": False}

    with _LOCKS_GUARD:
        lock = _LOCKS.setdefault(key, threading.Lock())
    with lock:
        if pq.exists():
            return {"ok": True, "path": str(pq), "built": False}
        t0 = time.time()
        df = _read_sheet_raw(p, target)
        tmp = d / f"{key}.{os.getpid()}.{threading.get_ident()}.tmp"
        df.write_parquet(tmp, compression="lz4", statistics=True, row_group_size=65_536)
        os.replace(tmp, pq)       # atomic — a crash never leaves a half-written cache
        st = p.stat()
        (d / f"{key}.json").write_text(json.dumps({
            "source": str(p), "sheet": target, "mtime_ns": st.st_mtime_ns,
            "size": st.st_size, "rows": df.height, "cols": df.width,
            "seconds": round(time.time() - t0, 2),
            "built": datetime.now().isoformat(timespec="seconds"),
        }), encoding="utf-8")
    _prune(d, keep=key, source=str(p), sheet=target)
    return {"ok": True, "path": str(pq), "built": True, "rows": df.height}


def _prune(d: Path, keep: str, source: str, sheet: str) -> None:
    """Drop superseded copies of the same sheet, stale temp files, then trim to the cap."""
    now = time.time()
    for tmp in d.glob("*.tmp"):
        try:
            if now - tmp.stat().st_mtime > 3600:
                tmp.unlink()
        except OSError:
            pass
    for meta in d.glob("*.json"):
        if meta.stem == keep:
            continue
        try:
            m = json.loads(meta.read_text(encoding="utf-8"))
        except Exception:
            continue
        if m.get("source") == source and m.get("sheet") == sheet:
            for f in (meta, meta.with_suffix(".parquet")):
                try:
                    f.unlink()
                except OSError:
                    pass
    entries = []
    for pq in d.glob("*.parquet"):
        try:
            st = pq.stat()
            entries.append((st.st_mtime, st.st_size, pq))
        except OSError:
            pass
    total, cap = sum(e[1] for e in entries), CACHE_CAP_GB * 1024 ** 3
    for _, size, pq in sorted(entries):
        if total <= cap:
            break
        if pq.stem == keep:
            continue
        for f in (pq, pq.with_suffix(".json")):
            try:
                f.unlink()
            except OSError:
                pass
        total -= size


def cache_info() -> dict:
    d = cache_dir()
    if d is None:
        return {"ok": True, "on": False, "dir": "", "entries": 0, "bytes": 0, "size_h": "0 B"}
    files = list(d.glob("*.parquet"))
    size = sum(f.stat().st_size for f in files if f.exists())
    return {"ok": True, "on": _CACHE_ON, "dir": str(d), "entries": len(files),
            "bytes": size, "size_h": human_size(size)}


def cache_clear() -> dict:
    d = cache_dir()
    n = 0
    if d is not None:
        for f in list(d.glob("*.parquet")) + list(d.glob("*.json")) + list(d.glob("*.tmp")):
            try:
                f.unlink()
                n += f.suffix == ".parquet"
            except OSError:
                pass
    clear_cache()
    return {"ok": True, "removed": n}


def _excel_lazy(src: "Source") -> pl.LazyFrame:
    """Cached sheet with the header promoted — all lazy, nothing read yet."""
    info = build_sheet_cache(src.path, src.sheet)
    pq = info["path"]
    scan = pl.scan_parquet(pq)
    raw = scan.collect_schema().names()
    if src.has_header:
        top = max(0, src.header_row - 1)
        names = _HEADER_CACHE.get((pq, top))
        if names is None:
            head = scan.slice(top, 1).collect()
            names = dedupe(head.row(0)) if head.height else [f"col_{i + 1}" for i in range(len(raw))]
            _HEADER_CACHE[(pq, top)] = names
        data = scan.slice(top + 1 + src.skip_after_header)
    else:
        names = [f"col_{i + 1}" for i in range(len(raw))]
        data = scan.slice(src.skip_after_header)
    return data.rename(dict(zip(raw, names)))


def _workers(todo: list[tuple[str, str]]) -> int:
    env = os.environ.get("COLSIFT_WORKERS")
    if env and env.isdigit():
        return max(1, int(env))
    sizes = [Path(p).stat().st_size for p, _ in todo]
    # A sheet in memory runs ~10x its .xlsx size. Keep parallel parses honest on RAM.
    if max(sizes) > 250 * 1024 ** 2:
        return 1
    if len(todo) < 2 or sum(sizes) < 20 * 1024 ** 2:
        return 1          # pool start-up (~1-2 s on Windows) would eat the gain
    cap = 2 if sum(sizes) > 400 * 1024 ** 2 else 3
    return min(len(todo), cap, max(1, (os.cpu_count() or 2) // 2))


def prepare(files: list[str], source: dict | None, on_progress=None, workers: int | None = None) -> dict:
    """Parse every workbook that is not cached yet, several at once when it pays.

    calamine holds the GIL, so threads would not help — this uses processes. Each
    worker writes its own Parquet and returns a path, so no sheet data crosses a
    process boundary. If a pool cannot start (locked-down PC, antivirus, sandbox)
    it falls back to one at a time rather than failing."""
    if not cache_on():
        return {"built": 0, "errors": {}}
    sheet = (source or {}).get("sheet") or None
    todo = []
    for f in files:
        p = _norm(f)
        if not is_excel(p) or not p.exists():
            continue
        try:
            target = _resolve_sheet(p, sheet)
            if not (cache_dir() / f"{_sheet_key(p, target)}.parquet").exists():
                todo.append((str(p), target))
        except Exception:
            continue
    if not todo:
        return {"built": 0, "errors": {}}

    errors: dict[str, str] = {}
    done = 0

    def tick(path: str) -> None:
        if on_progress:
            on_progress({"stage": "prepare", "file": Path(path).name,
                         "index": done, "total": len(todo)})

    workers = workers or _workers(todo)
    if workers > 1:
        try:
            import multiprocessing as mp
            from concurrent.futures import ProcessPoolExecutor, as_completed

            with ProcessPoolExecutor(max_workers=workers,
                                     mp_context=mp.get_context("spawn")) as ex:
                futs = {ex.submit(build_sheet_cache, p, s): p for p, s in todo}
                for fut in as_completed(futs):
                    try:
                        fut.result()
                        done += 1
                        tick(futs[fut])
                    except Exception:  # noqa: BLE001 — retried below, one at a time
                        pass
        except Exception:  # noqa: BLE001 — pool never started
            traceback.print_exc()

    # Serial pass. After a pool this only does real work for what the pool did not
    # finish — a broken pool (locked-down PC, antivirus killing children), a worker
    # that ran out of memory — because build_sheet_cache returns at once for
    # anything already cached. Only a failure HERE is a genuine file error.
    for p, s in todo:
        if (cache_dir() / f"{_sheet_key(Path(p), s)}.parquet").exists():
            continue
        done += 1
        tick(p)
        try:
            build_sheet_cache(p, s)
        except Exception as exc:  # noqa: BLE001
            errors[p] = brief(exc)
    return {"built": len(todo) - len(errors), "errors": errors, "workers": workers}


def _calamine_sheet(p: Path, sheet: str | None, skip: int = 0, n: int | None = None,
                    use_columns: list[int] | None = None) -> pl.DataFrame:
    """Read a sheet as raw strings via calamine. Raises if fastexcel is unusable."""
    book = _book(p)
    names = list(book.sheet_names)
    target = sheet if (sheet and sheet in names) else names[0]
    kw = {"header_row": None, "skip_rows": skip, "n_rows": n, "dtypes": "string"}
    if use_columns is not None:
        kw["use_columns"] = use_columns
    sh = book.load_sheet_by_name(target, **kw)
    return sh.to_polars().with_columns(pl.all().cast(pl.String))


def _excel_raw_rows(p: Path, sheet: str | None, n: int | None) -> list[list[str]]:
    if cache_on():
        try:
            scan = pl.scan_parquet(build_sheet_cache(str(p), sheet)["path"])
            df = (scan.head(n) if n else scan).collect()
            return [["" if v is None else str(v) for v in row] for row in df.iter_rows()]
        except Exception:  # noqa: BLE001
            traceback.print_exc()
    return _excel_raw_rows_direct(p, sheet, n)


def _excel_raw_rows_direct(p: Path, sheet: str | None, n: int | None) -> list[list[str]]:
    try:
        df = _calamine_sheet(p, sheet, 0, n)
        return [["" if v is None else str(v) for v in row] for row in df.iter_rows()]
    except Exception:
        pass  # fall through to openpyxl
    from openpyxl import load_workbook

    wb = load_workbook(str(p), read_only=True, data_only=True)
    try:
        ws = wb[sheet] if sheet and sheet in wb.sheetnames else wb[wb.sheetnames[0]]
        rows = []
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if n is not None and i >= n:
                break
            rows.append(["" if v is None else str(v) for v in row])
        return rows
    finally:
        wb.close()


def _excel_frame(p: Path, sheet: str | None, header_row: int, skip_after: int,
                 has_header: bool, needed: set[str] | None = None) -> pl.DataFrame:
    """Whole sheet as strings, header promoted from the chosen row.

    When `needed` is known we read the label row first and hand calamine the column
    indices, so a 200-column sheet only decodes the handful we asked for."""
    top = (header_row - 1) if has_header else 0
    use = None
    if needed and has_header:
        # calamine re-parses the sheet on every read, so a probe read to learn the
        # column names would cost more than pruning saves. Only prune when the peek
        # already sitting in cache can tell us the names for free.
        pk = _PEEK_CACHE.get(_peek_key(p, "utf-8", sheet))
        cells = (pk or {}).get("cells")
        if cells and len(cells) > top:
            names = dedupe(cells[top])
            idx = [i for i, n in enumerate(names) if n in needed]
            if names and 0 < len(idx) < len(names):
                use = idx
    try:
        df = _calamine_sheet(p, sheet, skip=top, use_columns=use)
    except Exception:
        rows = _excel_raw_rows_direct(p, sheet, None)[top:]
        if not rows:
            return pl.DataFrame()
        width = max(len(r) for r in rows)
        rows = [r + [""] * (width - len(r)) for r in rows]
        df = pl.DataFrame(
            {f"c{i}": [r[i] for r in rows] for i in range(width)},
            schema={f"c{i}": pl.String for i in range(width)},
        )

    if df.height == 0:
        return df

    if has_header:
        names = dedupe(df.row(0))
        df = df.slice(1 + skip_after)
        names = names[:df.width]
    else:
        names = [f"col_{i + 1}" for i in range(df.width)]
        df = df.slice(skip_after)
    return df.rename(dict(zip(df.columns, names)))


# --------------------------------------------------------------------------
# source spec -> LazyFrame
# --------------------------------------------------------------------------

@dataclass
class Source:
    path: str
    sheet: str | None = None
    has_header: bool = True
    header_row: int = 1          # 1-based, physical row holding the labels
    skip_after_header: int = 0
    delimiter: str = ","          # name or literal char
    quote_char: str = '"'
    comment_prefix: str = ""
    encoding: str = "utf-8"
    trim: bool = True
    blank_as_null: bool = True
    auto_header: bool = False     # detect the label row per file
    auto_delimiter: bool = True   # sniff the separator per file
    sample_rows: int = 0          # preview only: read this many rows of an unread workbook

    @staticmethod
    def from_dict(d: dict) -> "Source":
        f = {k: v for k, v in (d or {}).items() if k in Source.__dataclass_fields__}
        return Source(**f)

    def resolved(self) -> "Source":
        """Fill in whatever was left on Auto, per file."""
        if not (self.auto_header or (self.auto_delimiter and not is_excel(_norm(self.path)))):
            return self
        peek = _peek_cached(self.path, self.encoding, self.sheet)
        if not peek.get("ok"):
            return self
        out = Source(**{k: getattr(self, k) for k in Source.__dataclass_fields__})
        if self.auto_delimiter and peek.get("delimiter"):
            out.delimiter = peek["delimiter"]
        if self.auto_header and self.has_header:
            out.header_row = suggest_header_row(
                peek["lines"], resolve_delim(out.delimiter) if peek["kind"] == "text" else None
            )
        return out


def _csv_header(p: Path, src: Source) -> list[str]:
    sep = resolve_delim(src.delimiter)
    with _open_text(p, src.encoding) as fh:
        for _ in range(src.header_row - 1):
            if fh.readline() == "":
                return []
        line = fh.readline()
    if not line:
        return []
    reader = _csv.reader(io.StringIO(line), delimiter=sep, quotechar=src.quote_char or '"')
    try:
        return dedupe(next(reader))
    except StopIteration:
        return []


def load_lazy(src: Source, needed: set[str] | None = None) -> pl.LazyFrame:
    """Everything comes back as String — leading zeros and long doc numbers survive.

    `needed` is the set of columns the rest of the pipeline will actually touch.
    Passing it keeps the per-column cleanup off the other 200 columns and lets the
    CSV scan skip parsing them at all."""
    src = src.resolved()
    p = _norm(src.path)
    if not p.exists():
        raise FileNotFoundError(f"File not found: {p}")

    if is_excel(p):
        lf = None
        if src.sample_rows and _cached_sheet(p, src.sheet) is None:
            lf = _excel_sample_lazy(src)
        if lf is None and cache_on():
            try:
                lf = _excel_lazy(src)
            except Exception:  # noqa: BLE001 — disk full, locked folder: read directly
                traceback.print_exc()
        if lf is None:
            lf = _excel_frame(p, src.sheet, src.header_row, src.skip_after_header,
                              src.has_header, needed).lazy()
    else:
        sep = resolve_delim(src.delimiter)
        kw: dict[str, Any] = dict(
            has_header=False,
            separator=sep,
            quote_char=(src.quote_char or None),
            infer_schema=False,
            truncate_ragged_lines=True,
            ignore_errors=True,
            encoding="utf8-lossy",
            raise_if_empty=False,
        )
        if src.comment_prefix:
            kw["comment_prefix"] = src.comment_prefix

        target = as_utf8(p, src.encoding)
        skip = (src.header_row + src.skip_after_header) if src.has_header else src.skip_after_header
        names: list[str] = []
        if src.has_header:
            names = _csv_header(p, src)
            if not names:
                raise ValueError(f"No header found at row {src.header_row} in {p.name}")
        # Width comes from the widest row in the file, not the first one. Letting
        # polars infer it from row one broke files whose first row is short
        # (ShapeError) and silently truncated headerless files' wider rows.
        width = max(len(names), _data_width(target, skip, sep, src.quote_char or ""))
        names += [f"col_{i + 1}" for i in range(len(names), width)]
        kw.pop("infer_schema", None)
        lf = pl.scan_csv(target, skip_rows=skip, schema={n: pl.String for n in names}, **kw)

    return _finish(lf, src, needed)


def _finish(lf: pl.LazyFrame, src: "Source", needed: set[str] | None) -> pl.LazyFrame:
    """Projection + the cleanup every reader shares, so every path yields the same rows."""
    have = lf.collect_schema().names()
    keep = [c for c in have if c in needed] if needed else have
    if needed and keep and len(keep) < len(have):
        lf = lf.select(keep)          # pushes down into the scan

    lf = lf.with_columns(pl.all().cast(pl.String))
    if src.trim:
        lf = lf.with_columns(pl.all().str.strip_chars())
    if src.blank_as_null:
        lf = lf.with_columns(
            pl.when(pl.all().str.len_chars() == 0).then(None).otherwise(pl.all()).name.keep()
        )
    return lf


_WIDTH_CACHE: dict[tuple, int] = {}


def _data_width(target: Path, skip: int, sep: str, q: str) -> int:
    """Widest row after `skip`. One raw pass counting separators, cached per file.
    Quotes can hide separators inside fields, so quoted files are measured with a
    proper CSV reader over a sample instead of the raw count."""
    st = target.stat()
    key = (str(target), st.st_mtime_ns, st.st_size, skip, sep, q)
    if key in _WIDTH_CACHE:
        return _WIDTH_CACHE[key]
    raw = pl.scan_csv(target, has_header=False, separator="\x1f", quote_char=None,
                      infer_schema=False, skip_rows=skip, new_columns=["line"],
                      encoding="utf8-lossy", truncate_ragged_lines=True, raise_if_empty=False)
    line = pl.col("line").fill_null("")
    probes = [line.str.count_matches(sep, literal=True).max().alias("seps")]
    if q:
        probes.append(line.str.contains(q, literal=True).any().alias("quoted"))
    try:
        row = raw.select(probes).collect(engine="streaming").row(0, named=True)
    except Exception:  # noqa: BLE001
        row = {"seps": None, "quoted": True}
    if row.get("quoted"):
        import itertools
        with open(target, "r", encoding="utf-8", errors="replace", newline="") as fh:
            for _ in range(skip):
                if not fh.readline():
                    break
            rdr = _csv.reader(itertools.islice(fh, 5000), delimiter=sep, quotechar=q)
            width = max((len(r) for r in rdr), default=0)
    else:
        width = int(row.get("seps") or 0) + 1
    _WIDTH_CACHE[key] = width
    return width


LINESCAN_MIN_COLS = 4          # below this the normal scan already reads almost nothing
LINESCAN_MAX_ROWS = 250_000
LINESCAN_MAX_BYTES = 256 * 1024 ** 2


def _line_candidates(src: "Source", probe: list[str], fold: bool,
                     available: list[str], needed: set[str] | None) -> pl.LazyFrame | None:
    """grep before parse. Find the lines holding a search value anywhere, then parse
    only those with the file's own settings. The exact per-column test still runs on
    the result, so this only has to be a guaranteed SUPERSET of the true matches.

    Returns None whenever that guarantee is not provable, and the caller scans the
    file normally. Measured: 1.08 s -> 0.16 s on a 400k-row, 40-column extract."""
    src = src.resolved()
    p = _norm(src.path)
    if is_excel(p) or not probe:
        return None
    sep, q = resolve_delim(src.delimiter), (src.quote_char or "")
    # A value holding the separator, a quote or a line break can be split across
    # fields or escaped in the raw text, so "substring of the line" stops holding.
    if any(sep in v or (q and q in v) or "\n" in v or "\r" in v for v in probe):
        return None
    # Only ASCII case-folding is exactly the same on a line as on a cell; other
    # scripts have context-dependent lower-casing (Greek final sigma, dotted I).
    if fold and not all(v.isascii() for v in probe):
        return None

    target = as_utf8(p, src.encoding)
    skip = (src.header_row + src.skip_after_header) if src.has_header else src.skip_after_header
    raw = pl.scan_csv(target, has_header=False, separator="\x1f", quote_char=None,
                      infer_schema=False, skip_rows=skip, new_columns=["line"],
                      encoding="utf8-lossy", truncate_ragged_lines=False, raise_if_empty=False)
    try:
        if raw.collect_schema().len() != 1:       # a stray \x1f in the first line
            return None
        line = pl.col("line").fill_null("")
        if q and raw.select(line.str.contains(q, literal=True).any()).collect(
                engine="streaming").item():
            return None                           # quoted fields may span lines
        cands = raw.filter(line.str.contains_any(probe, ascii_case_insensitive=fold)).collect(
            engine="streaming")
    except Exception:  # noqa: BLE001 — ragged \x1f later in the file, odd bytes: scan normally
        return None
    if cands.height > LINESCAN_MAX_ROWS or \
            (cands.height and cands["line"].str.len_bytes().sum() > LINESCAN_MAX_BYTES):
        return None                               # values too common to be worth it

    names = list(available)
    if not cands.height:
        empty = pl.DataFrame(schema={n: pl.String for n in names}).lazy()
        return _finish(empty, src, needed)
    kw: dict[str, Any] = dict(has_header=False, separator=sep, quote_char=None,
                              schema={n: pl.String for n in names},
                              truncate_ragged_lines=True, ignore_errors=True,
                              encoding="utf8-lossy")
    if src.comment_prefix:
        kw["comment_prefix"] = src.comment_prefix
    buf = ("\n".join(cands["line"].to_list()) + "\n").encode("utf-8")
    return _finish(pl.read_csv(io.BytesIO(buf), **kw).lazy(), src, needed)


def columns_of(src_dict: dict) -> dict:
    src = Source.from_dict(src_dict)
    try:
        lf = load_lazy(src)
        return {"ok": True, "columns": lf.collect_schema().names()}
    except Exception as exc:
        return {"ok": False, "error": brief(exc), "columns": []}


# --------------------------------------------------------------------------
# filters
# --------------------------------------------------------------------------

FILTER_OPS = [   # id, label, needs a value, group in the picker
    ("not_empty", "is not empty", False, "Presence"), ("is_empty", "is empty", False, "Presence"),
    ("equals", "equals", True, "Text"), ("not_equals", "does not equal", True, "Text"),
    ("contains", "contains", True, "Text"), ("not_contains", "does not contain", True, "Text"),
    ("starts_with", "starts with", True, "Text"), ("not_starts_with", "does not start with", True, "Text"),
    ("ends_with", "ends with", True, "Text"), ("not_ends_with", "does not end with", True, "Text"),
    ("regex", "matches regex", True, "Text"), ("not_regex", "does not match regex", True, "Text"),
    ("in_list", "is one of", True, "List"), ("not_in_list", "is not one of", True, "List"),
    ("gt", "greater than", True, "Number"), ("gte", "greater or equal", True, "Number"),
    ("lt", "less than", True, "Number"), ("lte", "less or equal", True, "Number"),
    ("between", "between", True, "Number"), ("not_between", "not between", True, "Number"),
    ("is_number", "is a number", False, "Number"), ("not_number", "is not a number", False, "Number"),
    ("len_eq", "length is", True, "Length"), ("len_gt", "length greater than", True, "Length"),
    ("len_lt", "length less than", True, "Length"),
    ("date_on", "date is", True, "Date"), ("date_before", "date before", True, "Date"),
    ("date_after", "date after", True, "Date"), ("date_between", "date between", True, "Date"),
    ("is_date", "is a valid date", False, "Date"), ("not_date", "is not a valid date", False, "Date"),
    ("is_duplicate", "is duplicated in the file", False, "Duplicates"),
    ("is_unique", "appears once in the file", False, "Duplicates"),
    ("formula", "formula is TRUE", True, "Custom"),
]
COLUMN_COMPARE_OPS = {"equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with",
                      "gt", "gte", "lt", "lte", "date_on", "date_before", "date_after"}
_NOVALUE = {o[0] for o in FILTER_OPS if not o[2]}


def _num(col: str) -> pl.Expr:
    return (
        pl.col(col)
        .str.replace_all(r"[,\s]", "")
        .str.replace_all(r"^\((.*)\)$", r"-$1")
        .cast(pl.Float64, strict=False)
    )


def _split_list(v: str) -> list[str]:
    parts = re.split(r"[\r\n;,]+", str(v))
    return [p.strip() for p in parts if p.strip()]


_OP_LABEL = {o[0]: o[1] for o in FILTER_OPS}


def _as_number(val: Any, col: str, op: str) -> float:
    s = str("" if val is None else val).replace(",", "").strip()
    if s.startswith("(") and s.endswith(")"):
        s = "-" + s[1:-1]
    try:
        return float(s)
    except ValueError:
        raise ValueError(
            f"Condition “{col} {_OP_LABEL.get(op, op)}” needs a number — got “{val}”"
        ) from None


def _as_date(val: Any, col: str, op: str, fmt: str | None = None) -> date:
    """The typed comparison date: read in the rule's own date format first (so a US
    column compares with US-typed dates), then any common layout, then 'today'."""
    s = str(val if val is not None else "").strip()
    if s.lower() == "today":
        return date.today()
    d = None
    if s and fmt and str(fmt).strip().lower() not in ("", "auto"):
        d = pl.select(F.parse_date(pl.lit(s), fmt)).item()
    if d is None and s:
        d = pl.select(F.parse_date(pl.lit(s))).item()
    if d is None:
        raise ValueError(f"Condition “{col} {_OP_LABEL.get(op, op)}” needs a date like 31/07/2026 — got “{val}”")
    return d


def build_filter(rule: dict, columns: list[str] | None = None) -> pl.Expr | None:
    """One condition -> a strictly boolean expression, never null.

    Folding nulls to False here is what makes NOT on a group a clean complement:
    NOT (AMOUNT > 100) keeps the blank amounts instead of silently losing them."""
    col, op, val = rule.get("column"), rule.get("op", "not_empty"), rule.get("value", "")
    cs = bool(rule.get("case_sensitive", False))
    if op == "formula":
        text = str(val or "").strip()
        if not text:
            return None
        try:
            return F.bool_expr(text, columns or [])
        except F.FormulaError as exc:
            raise ValueError(f"Filter formula: {exc}") from None
    if not col:
        return None

    c = pl.col(col)
    txt = c.fill_null("")
    cmp = txt if cs else txt.str.to_lowercase()
    vs_col = rule.get("against") == "column" and op in COLUMN_COMPARE_OPS and bool(val)
    if vs_col:
        o = pl.col(str(val)).fill_null("")
        other = o if cs else o.str.to_lowercase()
    else:
        other = pl.lit(str(val) if cs else str(val).lower())

    if op == "not_empty":
        e = txt.str.strip_chars() != ""
    elif op == "is_empty":
        e = txt.str.strip_chars() == ""
    elif op == "equals":
        e = cmp == other
    elif op == "not_equals":
        e = cmp != other
    elif op in ("contains", "not_contains"):
        e = cmp.str.contains(other, literal=True)
        e = ~e if op == "not_contains" else e
    elif op in ("starts_with", "not_starts_with"):
        e = cmp.str.starts_with(other)
        e = ~e if op == "not_starts_with" else e
    elif op in ("ends_with", "not_ends_with"):
        e = cmp.str.ends_with(other)
        e = ~e if op == "not_ends_with" else e
    elif op in ("in_list", "not_in_list"):
        items = _split_list(val) if cs else [x.lower() for x in _split_list(val)]
        e = cmp.is_in(items)
        e = ~e if op == "not_in_list" else e
    elif op in ("regex", "not_regex"):
        e = txt.str.contains(str(val) if cs else f"(?i){val}")
        e = ~e if op == "not_regex" else e
    elif op in ("len_eq", "len_gt", "len_lt"):
        n = int(_as_number(val, col, op))
        ln = txt.str.len_chars()
        e = ln == n if op == "len_eq" else ln > n if op == "len_gt" else ln < n
    elif op in ("is_number", "not_number"):
        filled = txt.str.strip_chars() != ""
        isnum = _num(col).is_not_null()
        e = filled & isnum if op == "is_number" else filled & ~isnum
    elif op in ("is_date", "not_date"):
        filled = txt.str.strip_chars() != ""
        ok = F.parse_date(c, rule.get("date_format")).is_not_null()
        e = filled & ok if op == "is_date" else filled & ~ok
    elif op.startswith("date_"):
        fmt = rule.get("date_format")
        d = F.parse_date(c, fmt)
        if op == "date_between":
            lo, hi = _as_date(val, col, op, fmt), _as_date(rule.get("value2") or val, col, op, fmt)
            e = d.is_between(min(lo, hi), max(lo, hi))
        else:
            ref = F.parse_date(pl.col(str(val)), fmt) if vs_col else pl.lit(_as_date(val, col, op, fmt))
            e = d == ref if op == "date_on" else d < ref if op == "date_before" else d > ref
    elif op in ("is_duplicate", "is_unique"):
        key = txt.str.strip_chars() if cs else txt.str.strip_chars().str.to_lowercase()
        n = pl.len().over(key)
        e = (key != "") & (n > 1 if op == "is_duplicate" else n == 1)
    else:
        n = _num(col)
        ref = _num(str(val)) if vs_col else None
        if op in ("gt", "gte", "lt", "lte"):
            r = ref if vs_col else _as_number(val, col, op)
            e = n > r if op == "gt" else n >= r if op == "gte" else n < r if op == "lt" else n <= r
        elif op in ("between", "not_between"):
            lo = _as_number(val, col, op)
            v2 = rule.get("value2")
            hi = _as_number(v2, col, op) if str(v2 or "").strip() else lo
            e = n.is_between(min(lo, hi), max(lo, hi))
            e = (~e & n.is_not_null()) if op == "not_between" else e
        else:
            raise ValueError(f"Unknown filter op: {op}")
    return e.fill_null(False)


def normalize_filters(spec: dict | None) -> dict:
    """Accept the v1 flat shape {mode, rules} and the v2 tree; always return a tree.
    Old saved setups keep working."""
    if not spec:
        return {"type": "group", "mode": "and", "negate": False, "enabled": True, "children": []}
    if spec.get("type") == "rule":
        return {"type": "group", "mode": "and", "negate": False, "enabled": True,
                "children": [spec]}
    kids = spec.get("children")
    if kids is None:
        kids = spec.get("rules") or []
    node = {"type": "group", "mode": (spec.get("mode") or "and").lower(),
            "negate": bool(spec.get("negate")), "enabled": spec.get("enabled", True) is not False,
            "children": []}
    for k in kids:
        k = k or {}
        if k.get("type") == "group" or "children" in k or "rules" in k:
            node["children"].append(normalize_filters(k))
        else:
            node["children"].append({**k, "type": "rule"})
    return node


def build_filter_tree(node: dict | None, columns: list[str] | None = None) -> pl.Expr | None:
    """Disabled nodes and empty groups drop out rather than matching nothing."""
    if not node or node.get("enabled") is False:
        return None
    if node.get("type") == "rule":
        return build_filter(node, columns)
    parts = [e for e in (build_filter_tree(k, columns) for k in node.get("children") or []) if e is not None]
    if not parts:
        return None
    if len(parts) == 1:
        e = parts[0]
    else:
        e = pl.all_horizontal(parts) if node.get("mode", "and") != "or" else pl.any_horizontal(parts)
    return ~e if node.get("negate") else e


def filter_columns(spec: dict | None, available: list[str] | None = None) -> set[str]:
    """Columns the live part of the tree reads — disabled branches don't count."""
    out: set[str] = set()

    def walk(n: dict) -> None:
        if not n or n.get("enabled") is False:
            return
        if n.get("type") == "rule":
            if n.get("op") == "formula":
                out.update(F.referenced(str(n.get("value") or ""), available or []))
                return
            if n.get("column"):
                out.add(n["column"])
            if n.get("against") == "column" and n.get("op") in COLUMN_COMPARE_OPS and n.get("value"):
                out.add(str(n["value"]))
            return
        for k in n.get("children") or []:
            walk(k)

    walk(normalize_filters(spec))
    return out


_SYM = {"equals": "=", "not_equals": "≠", "gt": ">", "gte": "≥", "lt": "<", "lte": "≤"}


def describe_filters(spec: dict | None) -> str:
    """Plain rendering for the CLI and logs:  A AND (B OR NOT (C AND D))"""
    def rule(r: dict) -> str:
        op, col, v = r.get("op"), r.get("column", "?"), r.get("value", "")
        label = _OP_LABEL.get(op, op)
        if op == "formula":
            return f"formula[{v}]"
        if op in _NOVALUE:
            return f"{col} {label}"
        other = f"[{v}]" if r.get("against") == "column" and op in COLUMN_COMPARE_OPS else None
        if op in _SYM:
            return f"{col} {_SYM[op]} {other or v}"
        if op in ("between", "not_between", "date_between"):
            return f"{col} {label} {v} and {r.get('value2') or v}"
        if other or op.startswith("date_"):
            return f"{col} {label} {other or v}"
        return f'{col} {label} "{v}"'

    def walk(n: dict, depth: int) -> str:
        if not n or n.get("enabled") is False:
            return ""
        if n.get("type") == "rule":
            return rule(n)
        parts = [p for p in (walk(k, depth + 1) for k in n.get("children") or []) if p]
        if not parts:
            return ""
        s = f" {'OR' if n.get('mode') == 'or' else 'AND'} ".join(parts)
        if n.get("negate"):
            return f"NOT ({s})"
        return f"({s})" if depth and len(parts) > 1 else s

    return walk(normalize_filters(spec), 0) or "(no conditions — every row passes)"


def apply_filters(lf: pl.LazyFrame, spec: dict) -> pl.LazyFrame:
    e = build_filter_tree(normalize_filters(spec), lf.collect_schema().names())
    return lf if e is None else lf.filter(e)


# --------------------------------------------------------------------------
# computed / additional columns
# --------------------------------------------------------------------------

ADD_KINDS = [   # id, label, group in the picker
    ("formula", "Formula (Excel-style)", "Formula"),
    ("constant", "Fixed text", "Basic"), ("copy", "Copy of a column", "Basic"),
    ("filename", "Source file name", "Source"), ("filestem", "Source file name (no extension)", "Source"),
    ("filepath", "Source full path", "Source"), ("sheet", "Source sheet name", "Source"),
    ("folder", "Source folder name", "Source"), ("today", "Run date", "Source"),
    ("rownum", "Row number", "Source"),
    ("concat", "Join columns", "Text"), ("substring", "Substring of a column", "Text"),
    ("split", "Part of a column, cut at a separator", "Text"),
    ("extract", "Extract with a pattern (regex)", "Text"), ("pad", "Pad / fix width", "Text"),
    ("replace", "Find and replace", "Text"), ("case", "Upper / lower / title", "Text"),
    ("coalesce", "First non-blank of several columns", "Text"),
    ("lookup", "Look up in a table you paste", "Lookup"),
    ("number", "Clean to number", "Numbers & dates"), ("date", "Reformat date", "Numbers & dates"),
    ("dupcount", "How many rows share this value", "Duplicates"),
    ("occurrence", "Occurrence of this value (1, 2, 3…)", "Duplicates"),
    ("sql", "SQL expression (older setups)", "Formula"),
]


def parse_mapping(text: str) -> dict[str, str]:
    """Two columns pasted from Excel (tab), or key=value / key,value per line."""
    out: dict[str, str] = {}
    for line in str(text or "").splitlines():
        if not line.strip():
            continue
        for sep in ("\t", "=", ",", ";", "|"):
            if sep in line:
                k, v = line.split(sep, 1)
                out[k.strip()] = v.strip()
                break
    return out


def add_computed(lf: pl.LazyFrame, specs: list[dict], ctx: dict) -> pl.LazyFrame:
    for spec in specs or []:
        if spec.get("enabled") is False:
            continue
        name = (spec.get("name") or "").strip()
        kind = spec.get("kind") or "constant"
        if not name:
            continue
        src = spec.get("source") or ""
        val = spec.get("value", "")

        if kind == "constant":
            e = pl.lit(str(val))
        elif kind == "filename":
            e = pl.lit(ctx.get("filename", ""))
        elif kind == "filestem":
            e = pl.lit(ctx.get("filestem", ""))
        elif kind == "filepath":
            e = pl.lit(ctx.get("filepath", ""))
        elif kind == "sheet":
            e = pl.lit(ctx.get("sheet", "") or "")
        elif kind == "folder":
            e = pl.lit(ctx.get("folder", ""))
        elif kind == "today":
            e = pl.lit(datetime.now().strftime(str(val) or "%Y-%m-%d"))
        elif kind == "rownum":
            lf = lf.with_row_index("__rn__", offset=int(spec.get("start") or 1))
            e = pl.col("__rn__").cast(pl.String)
        elif kind == "concat":
            cols = spec.get("sources") or ([src] if src else [])
            sep = str(spec.get("sep", ""))
            if not cols:
                continue
            e = pl.concat_str([pl.col(c).fill_null("") for c in cols], separator=sep)
        elif kind == "substring":
            start = max(0, int(spec.get("start") or 1) - 1)
            length = spec.get("length")
            e = pl.col(src).fill_null("").str.slice(
                start, int(length) if str(length).strip() else None
            )
        elif kind == "pad":
            width = int(spec.get("length") or 0)
            ch = (str(spec.get("pad_char") or "0"))[:1]
            base = pl.col(src).fill_null("")
            e = base.str.pad_start(width, ch) if spec.get("side", "left") == "left" \
                else base.str.pad_end(width, ch)
        elif kind == "replace":
            find, repl = str(spec.get("find", "")), str(spec.get("value", ""))
            lit = not bool(spec.get("regex"))
            e = pl.col(src).fill_null("").str.replace_all(find, repl, literal=lit)
        elif kind == "case":
            base = pl.col(src).fill_null("")
            mode = spec.get("mode", "upper")
            e = base.str.to_uppercase() if mode == "upper" else (
                base.str.to_lowercase() if mode == "lower" else base.str.to_titlecase()
            )
        elif kind == "number":
            dp = spec.get("decimals")
            n = _num(src)
            e = n.round(int(dp)).cast(pl.String) if str(dp).strip() else n.cast(pl.String)
        elif kind == "date":
            in_fmt = str(spec.get("find") or "%d/%m/%Y")
            out_fmt = str(spec.get("value") or "%Y-%m-%d")
            e = (
                pl.col(src).fill_null("")
                .str.to_date(in_fmt, strict=False)
                .dt.strftime(out_fmt)
            )
        elif kind == "formula":
            try:
                e = F.text_expr(str(val), lf.collect_schema().names(), ctx)
            except F.FormulaError as exc:
                raise ValueError(f"Column “{name}”: {exc}") from None
        elif kind == "copy":
            e = pl.col(src)
        elif kind == "split":
            part = int(spec.get("part") or 1)
            e = pl.col(src).fill_null("").str.split(str(spec.get("sep") or "-")).list.get(
                part - 1 if part > 0 else part, null_on_oob=True)
        elif kind == "extract":
            pat = str(spec.get("find") or "")
            grp = int(spec.get("group") or (1 if "(" in pat else 0))
            e = pl.col(src).str.extract(pat if grp else f"({pat})", grp or 1)
        elif kind == "coalesce":
            cols = [c for c in spec.get("sources") or [] if c]
            if not cols:
                continue
            e = pl.coalesce([pl.when(pl.col(c).fill_null("").str.strip_chars() != "").then(pl.col(c)) for c in cols])
        elif kind == "lookup":
            table = parse_mapping(spec.get("table") or "")
            fold = not spec.get("case_sensitive")
            keys = {(k.lower() if fold else k): v for k, v in table.items()}
            probe = pl.col(src).fill_null("").str.strip_chars()
            probe = probe.str.to_lowercase() if fold else probe
            mode = spec.get("default_mode") or "blank"
            fallback = (pl.col(src) if mode == "keep" else
                        pl.lit(str(spec.get("value") or "")) if mode == "text" else pl.lit(None, pl.String))
            e = probe.replace_strict(list(keys), list(keys.values()), default=fallback, return_dtype=pl.String) \
                if keys else fallback
        elif kind == "dupcount":
            e = pl.len().over(pl.col(src).fill_null(""))
        elif kind == "occurrence":
            e = pl.int_range(1, pl.len() + 1, dtype=pl.Int64).over(pl.col(src).fill_null(""))
        elif kind == "sql":
            lf, e, temps = _sql_expr(lf, str(val), spec.get("numeric", True))
        else:
            raise ValueError(f"Unknown column type: {kind}")

        lf = lf.with_columns(e.cast(pl.String).alias(name))
        if kind == "rownum":
            lf = lf.drop("__rn__")
        if kind == "sql" and temps:
            lf = lf.drop(temps)
    return lf


def _sql_expr(lf: pl.LazyFrame, text: str, numeric: bool):
    """Everything is text, so `AMOUNT * -1` would fail. Cast what the formula touches."""
    if not numeric:
        return lf, pl.sql_expr(text), []
    names = sorted(lf.collect_schema().names(), key=len, reverse=True)
    rewritten, temps = text, []
    for i, col in enumerate(names):
        pat = rf'"{re.escape(col)}"|(?<![\w."]){re.escape(col)}(?![\w."])'
        if not re.search(pat, rewritten):
            continue
        tok = f"__f{i}"
        rewritten = re.sub(pat, tok, rewritten)
        lf = lf.with_columns(_num(col).alias(tok))
        temps.append(tok)
    return lf, pl.sql_expr(rewritten), temps


# --------------------------------------------------------------------------
# pipeline
# --------------------------------------------------------------------------

def referenced_columns(job: dict, available: list[str]) -> set[str]:
    """Every column the job names: kept, filtered on, or fed into a computed column.
    Not intersected with the file — callers use the difference to spot gaps."""
    need: set[str] = set()
    for c in job.get("columns") or []:
        if c.get("include", True) and c.get("name"):
            need.add(c["name"])
    need |= filter_columns(job.get("filters"), available)
    for a in job.get("add_columns") or []:
        if a.get("enabled") is False:
            continue
        if a.get("source"):
            need.add(a["source"])
        need.update(a.get("sources") or [])
        if a.get("kind") == "formula":
            need |= F.referenced(str(a.get("value") or ""), available)
        if a.get("kind") == "sql":
            text = str(a.get("value") or "")
            for col in available:
                if re.search(rf'"{re.escape(col)}"|(?<![\w."]){re.escape(col)}(?![\w."])', text):
                    need.add(col)
    for c in job.get("find_scope") or []:
        need.add(c)
    return need


def needed_columns(job: dict, available: list[str]) -> set[str]:
    return referenced_columns(job, available) & set(available)


PREVIEW_SAMPLE = 2000


def _cached_sheet(p: Path, sheet: str | None) -> Path | None:
    d = cache_dir()
    if d is None or not _CACHE_ON:
        return None
    try:
        pq = d / f"{_sheet_key(p, _resolve_sheet(p, sheet))}.parquet"
    except Exception:  # noqa: BLE001
        return None
    return pq if pq.exists() else None


def _excel_fast_names(src: "Source") -> list[str] | None:
    """Column names from the streamed peek — no full parse. None when unsure."""
    r = src.resolved()
    pk = _peek_cached(r.path, r.encoding, r.sheet)
    cells = pk.get("cells") or []
    if not pk.get("fast") or not cells:
        return None
    width = max(len(x) for x in cells)
    if not r.has_header:
        return [f"col_{i + 1}" for i in range(width)]
    top = max(0, r.header_row - 1)
    if top >= len(cells):
        return None
    return dedupe(list(cells[top]) + [None] * (width - len(cells[top])))


def _excel_sample_lazy(src: "Source") -> pl.LazyFrame | None:
    """The first rows of an unread workbook, header promoted — preview without a full parse."""
    p = _norm(src.path)
    top = max(0, src.header_row - 1) if src.has_header else 0
    try:
        r = xlsxfast.read_rows(p, src.sheet, top + 1 + src.skip_after_header + src.sample_rows)
    except Exception:  # noqa: BLE001
        return None
    if not r["exact"] or not r["rows"]:
        return None
    width = max(len(x) for x in r["rows"])
    rows = [list(x) + [None] * (width - len(x)) for x in r["rows"]]
    if src.has_header:
        if top >= len(rows):
            return None
        names, data = dedupe(rows[top]), rows[top + 1 + src.skip_after_header:]
    else:
        names, data = [f"col_{i + 1}" for i in range(width)], rows[src.skip_after_header:]
    return pl.DataFrame({n: [x[i] for x in data] for i, n in enumerate(names)},
                        schema={n: pl.String for n in names}).lazy()


def _schema_names(src: Source) -> list[str]:
    p = _norm(src.path)
    if is_excel(p) and _cached_sheet(p, src.sheet) is None:
        names = _excel_fast_names(src)
        if names is not None:
            return names
    return load_lazy(src).collect_schema().names()


def _ctx_for(p: Path, sheet: str | None) -> dict:
    return {
        "filename": p.name,
        "filestem": p.stem,
        "filepath": str(p),
        "folder": p.parent.name,
        "sheet": sheet or "",
    }


def build_pipeline(src: Source, job: dict, for_preview: bool = False,
                   available: list[str] | None = None,
                   notes: list[str] | None = None) -> pl.LazyFrame:
    available = available if available is not None else _schema_names(src)
    need = needed_columns(job, available)
    lf = load_lazy(src, need or None)

    # A month where one extract lacks a column should not sink the whole batch.
    # Filter / formula inputs that are missing read as blank, and we say so.
    kept = {c.get("name") for c in job.get("columns") or [] if c.get("include", True)}
    gaps = sorted((referenced_columns(job, available) - set(available)) - kept)
    if gaps:
        if job.get("strict_columns"):
            raise ValueError(f"{Path(src.path).name} has no column {', '.join(gaps)}")
        lf = lf.with_columns([pl.lit(None, dtype=pl.String).alias(g) for g in gaps])
        if notes is not None:
            notes.append(f"No {', '.join(gaps)} — read as blank")

    lf = apply_filters(lf, job.get("filters") or {})
    lf = add_computed(lf, job.get("add_columns") or [],
                      _ctx_for(_norm(src.path), src.sheet))

    picks = [c for c in (job.get("columns") or []) if c.get("include", True)]
    if picks:
        exprs = []
        for c in picks:
            name = c.get("name")
            if name not in available:
                if job.get("strict_columns"):
                    raise ValueError(f"Column '{name}' not in {Path(src.path).name}")
                if notes is not None:
                    notes.append(f"No {name} — written blank")
                exprs.append(pl.lit(None, dtype=pl.String).alias(c.get("alias") or name))
                continue
            alias = (c.get("alias") or "").strip() or name
            exprs.append(pl.col(name).alias(alias))
        added = [a.get("name") for a in (job.get("add_columns") or [])
                 if a.get("enabled") is not False and (a.get("name") or "").strip()]
        exprs += [pl.col(n) for n in added]
        lf = lf.select(exprs)

    if job.get("distinct"):
        lf = lf.unique(maintain_order=True)
    limit = job.get("limit")
    if limit and not for_preview:
        lf = lf.head(int(limit))
    return lf


def preview(job: dict, rows: int = 200) -> dict:
    """Run the whole pipeline against the first file only, capped."""
    files = job.get("files") or []
    if not files:
        return {"ok": False, "error": "Pick at least one file first."}
    src = Source.from_dict({**(job.get("source") or {}), "path": files[0]})
    t0 = time.time()
    notes: list[str] = []
    p0 = _norm(files[0])
    sampled = (p0.suffix.lower() in xlsxfast.FAST_EXT and _cached_sheet(p0, src.sheet) is None
               and bool(_peek_cached(str(p0), src.encoding, src.sheet).get("fast")))
    if sampled:
        src.sample_rows = PREVIEW_SAMPLE
    try:
        raw_cols = _schema_names(src)
        lf = build_pipeline(src, job, for_preview=True, available=raw_cols, notes=notes)
        if batch_dupes(job):
            lf = across_files(lf, job)
            notes.append("Duplicates across files: the preview looks within this file only — "
                         "Run, Count and the dashboards on every file look across all of them")
        df = lf.head(int(rows)).collect()
    except Exception as exc:
        return {"ok": False, "error": brief(exc)}
    return {
        "ok": True,
        "notes": notes,
        "sampled": PREVIEW_SAMPLE if sampled else 0,
        "filter_text": describe_filters(job.get("filters")),
        "file": Path(src.path).name,
        "columns": df.columns,
        "all_columns": raw_cols,
        "rows": [["" if v is None else str(v) for v in r] for r in df.iter_rows()],
        "shown": df.height,
        "elapsed": round(time.time() - t0, 2),
    }


def _sequential(job: dict) -> bool:
    return (job.get("processing") or "sequential") != "parallel"


def _collect_many(lfs: list[pl.LazyFrame], sequential: bool = False) -> list[Any]:
    """Side by side in one polars call — or, for heavy batches, strictly one at a time
    so only one file's working set is ever in memory. Failures land on their own file."""
    if not lfs:
        return []
    if not sequential:
        try:
            return pl.collect_all(lfs, engine="streaming")
        except Exception:  # noqa: BLE001 — redo singly to pin the error on the right file
            pass
    out = []
    for lf in lfs:
        try:
            out.append(lf.collect(engine="streaming"))
        except Exception as exc:  # noqa: BLE001
            out.append(exc)
    return out


def count_rows(job: dict, on_progress=None) -> dict:
    """Exact matched-row count across every selected file."""
    t0 = time.time()
    files = job.get("files") or []
    prep = prepare(files, job.get("source"), on_progress, workers=1 if _sequential(job) else None)
    per_file, lfs, owners = [], [], []
    for f in files:
        name = Path(f).name
        if f in prep["errors"] or str(_norm(f)) in prep["errors"]:
            per_file.append({"file": name, "rows": 0,
                             "error": prep["errors"].get(str(_norm(f)), "Could not read")})
            continue
        src = Source.from_dict({**(job.get("source") or {}), "path": f})
        notes: list[str] = []
        try:
            lfs.append(build_pipeline(src, job, notes=notes).select(pl.len()))
            owners.append(len(per_file))
            per_file.append({"file": name, "rows": 0, "note": "; ".join(notes) or None})
        except Exception as exc:  # noqa: BLE001
            per_file.append({"file": name, "rows": 0, "error": brief(exc)})

    total = 0
    if batch_dupes(job) and lfs:
        # rows per file after duplicates are found over every file together
        whole = [build_pipeline(Source.from_dict({**(job.get("source") or {}), "path": files[k]}), job)
                 for k, row in enumerate(per_file) if not row.get("error")]
        try:
            got = (across_files(stacked(whole), job).group_by(SRC_COL).len()
                   .collect(engine="streaming"))
            n = {int(r[0]): int(r[1]) for r in got.iter_rows()}
            for j, i in enumerate(owners):
                per_file[i]["rows"] = n.get(j, 0)
                total += per_file[i]["rows"]
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": brief(exc), "files": per_file}
        return {"ok": True, "total": total, "files": per_file, "elapsed": round(time.time() - t0, 2),
                "note": "Counted after duplicates across files"}
    for i, res in zip(owners, _collect_many(lfs, _sequential(job))):
        if isinstance(res, Exception):
            per_file[i]["error"] = brief(res)
        else:
            per_file[i]["rows"] = int(res.item())
            total += per_file[i]["rows"]
    return {"ok": True, "total": total, "files": per_file,
            "elapsed": round(time.time() - t0, 2)}


# --------------------------------------------------------------------------
# writing
# --------------------------------------------------------------------------

def _write_delimited(df: pl.DataFrame, path: Path, out: dict) -> None:
    df.write_csv(
        path,
        separator=resolve_delim(out.get("delimiter", ",")),
        include_header=bool(out.get("header", True)),
        quote_style=out.get("quote_style", "necessary"),
        line_terminator=out.get("line_terminator", "\n"),
        null_value=out.get("null_value", ""),
    )


# --------------------------------------------------------------------------
# fast .xlsx — polars builds the sheet XML in Rust, Python only zips it
# --------------------------------------------------------------------------
# xlsxwriter costs ~5 µs of Python per cell whatever API you use (measured: per
# cell, per row and its private writer all land within 10% of each other). A sheet
# is just XML inside a zip, so the rows are generated as one vectorised string
# expression and streamed into the archive. Cells are inline strings with explicit
# r="B7" references — the same layout xlsxwriter emits, so Excel reads it natively.

_XML_BAD = "[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\uFFFE\\uFFFF]"
_NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"


def _col_letter(i: int) -> str:
    s, i = "", i + 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def _esc(s: str) -> str:
    s = re.sub(_XML_BAD, "", str(s))
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _cell_text(col: str, bad: bool = True, long: bool = True, esc: bool = True) -> pl.Expr:
    # strip illegal XML chars -> Excel's 32,767-char cell cap -> escape (in that
    # order, so the cap can never cut an entity in half). Each step is skipped for
    # columns shown not to need it — codes and amounts need none of them.
    e = pl.col(col).cast(pl.String)
    if bad:
        e = e.str.replace_all(_XML_BAD, "")
    if long:
        e = e.str.slice(0, 32767)
    if esc:
        e = (e.str.replace_all("&", "&amp;", literal=True)
              .str.replace_all("<", "&lt;", literal=True)
              .str.replace_all(">", "&gt;", literal=True))
    return e


def _rows_xml(df: pl.DataFrame, first_row: int, kinds: dict | None = None) -> pl.DataFrame:
    """One XML string per row. `kinds` turns chosen columns into real number / date
    cells; a value that won't parse falls back to a text cell, so nothing is lost."""
    rn = pl.int_range(first_row, first_row + pl.len(), dtype=pl.Int64).cast(pl.String)
    probes = []
    for c in df.columns:
        t = pl.col(c).cast(pl.String)
        probes += [t.str.contains(r"^\s|\s$").any().alias(f"{c}\x00edge"),
                   t.str.contains(_XML_BAD).any().alias(f"{c}\x00bad"),
                   t.str.contains(r"[&<>]").any().alias(f"{c}\x00esc"),
                   (t.str.len_chars().max() > 32767).alias(f"{c}\x00long")]
    flags = df.select(probes).row(0, named=True) if df.height else {}
    f = lambda c, k: bool(flags.get(f"{c}\x00{k}"))  # noqa: E731
    cells = []
    for i, c in enumerate(df.columns):
        L = _col_letter(i)
        text_cell = pl.when(pl.col(c).is_not_null()).then(pl.concat_str([
            pl.lit(f'<c r="{L}'), rn,
            pl.lit('" t="inlineStr"><is><t xml:space="preserve">' if f(c, "edge") else '" t="inlineStr"><is><t>'),
            _cell_text(c, bad=f(c, "bad"), long=f(c, "long"), esc=f(c, "esc")), pl.lit("</t></is></c>")]))
        k = (kinds or {}).get(c)
        if not k:
            cells.append(text_cell)
            continue
        kind, sid, din, with_time = k
        if kind == "number":
            v = F.clean_number(pl.col(c))
        elif with_time:
            v = F.to_serial(F.parse_datetime(pl.col(c), din), "datetime")
        else:
            v = F.to_serial(F.parse_date(pl.col(c), din), "date")
        num_cell = pl.concat_str([pl.lit(f'<c r="{L}'), rn, pl.lit(f'" s="{sid}"><v>'), v.cast(pl.String), pl.lit("</v></c>")])
        cells.append(pl.when(v.is_not_null() & v.is_finite()).then(num_cell).otherwise(text_cell))
    row = pl.concat_str([pl.lit('<row r="'), rn, pl.lit('">'), *cells, pl.lit("</row>")], ignore_nulls=True)
    return df.select(row.alias("x"))


def _col_widths(df: pl.DataFrame) -> list[float]:
    sample = df.head(2000)
    lens = sample.select([pl.col(c).cast(pl.String).str.len_chars().max().alias(c)
                          for c in sample.columns]).row(0) if sample.height else [0] * df.width
    return [min(60.0, max(8.0, max(len(str(c)), int(n or 0)) + 2.5))
            for c, n in zip(df.columns, lens)]


def _safe_sheet(name: str) -> str:
    name = re.sub(r"[\[\]:*?/\\\\]", "_", str(name or "Data")).strip("'") or "Data"
    return name[:31]


XLSX_CHUNK = 200_000
MAX_PARTS = 500


class Cancelled(Exception):
    pass


class OutputLocked(RuntimeError):
    pass


def _check_cancel(cancel) -> None:
    if cancel is not None and cancel.is_set():
        raise Cancelled()


def _replace(tmp: Path, final: Path) -> None:
    try:
        os.replace(tmp, final)
    except PermissionError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise OutputLocked(f"{final.name} is open in another program (Excel?) — close it and run again") from None


def _xlsx_kinds(formats: dict, columns: list[str], codes: list[str]) -> dict:
    """Which columns get real number / date cells, and which style id each uses.
    `codes` is the workbook-wide format list and grows as sheets are scanned."""
    kinds = {}
    for c in columns:
        fm = (formats or {}).get(c) or {}
        t = fm.get("type") or "text"
        if t not in ("number", "date"):
            continue
        code = (fm.get("fmt") or ("General" if t == "number" else "dd/mm/yyyy")).strip()
        if code not in codes:
            codes.append(code)
        sid = 2 + codes.index(code)
        kinds[c] = ("number", sid, None, False) if t == "number" else \
            ("date", sid, fm.get("date_in"), F.has_time(F.to_strftime(code)))
    return kinds


def _styles_xml(codes: list[str], header_style: str) -> str:
    """xf 0 plain · xf 1 header · 2+i format i · 2+len+i format i in bold.
    codes[0] is always General, so 2+len(codes) is plain bold."""
    real = [c for c in codes if c != "General"]
    nf = (f'<numFmts count="{len(real)}">' + "".join(
        f'<numFmt numFmtId="{164 + i}" formatCode="{_esc(c)}"/>' for i, c in enumerate(real)) + "</numFmts>") if real else ""
    fid = {c: (164 + real.index(c) if c in real else 0) for c in codes}
    head = ('<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>'
            if header_style != "plain" else '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>')
    body = "".join(f'<xf numFmtId="{fid[c]}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' for c in codes)
    bold = "".join(f'<xf numFmtId="{fid[c]}" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' for c in codes)
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="{_NS_MAIN}">{nf}'
            '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
            '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
            '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
            '<fill><patternFill patternType="solid"><fgColor rgb="FFEDF2F1"/><bgColor indexed="64"/></patternFill></fill></fills>'
            '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
            '<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right>'
            '<top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>'
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            f'<cellXfs count="{2 + 2 * len(codes)}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>{head}{body}{bold}</cellXfs>'
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')


def _grid_rows_xml(grid: list[dict], fmts: list, codes: list[str], nbold: int) -> str:
    """Small hand-built sheets (pivots, dashboards): a cell is a number when the
    table says it is, so the workbook can be sorted, charted and re-pivoted."""
    BOLD = {"subtotal", "grand", "title"}
    out = []
    for r, row in enumerate(grid, start=1):
        kind = row.get("kind") or "data"
        cells = []
        for c, text in enumerate(row.get("cells") or []):
            ref = f"{_col_letter(c)}{r}"
            num = (row.get("nums") or [None] * (c + 1))[c] if c < len(row.get("nums") or []) else None
            if kind == "head":
                if text == "":
                    continue
                cells.append(f'<c r="{ref}" t="inlineStr" s="1"><is><t>{_esc(str(text))}</t></is></c>')
            elif isinstance(num, (int, float)) and num == num and abs(num) != float("inf"):
                code = (fmts[c] if c < len(fmts) and fmts[c] else "General")
                sid = 2 + codes.index(code) + (nbold if kind in BOLD else 0)
                cells.append(f'<c r="{ref}" s="{sid}"><v>{float(num):.10g}</v></c>')
            elif str(text) != "":
                sid = 2 + len(codes) if kind in BOLD else 0
                s_attr = f' s="{sid}"' if kind in BOLD else ""
                cells.append(f'<c r="{ref}" t="inlineStr"{s_attr}><is><t xml:space="preserve">{_esc(str(text))}</t></is></c>')
        out.append(f'<row r="{r}">' + "".join(cells) + "</row>")
    return "".join(out)


def _tab_sel(i: int) -> str:
    # kept out of the f-strings below: a backslash inside an f-string expression is a
    # SyntaxError before Python 3.12, and the build machine may well be on 3.10 / 3.11
    return 'tabSelected="1" ' if i == 0 else ""


def write_xlsx_book(path: Path, sheets: list[dict], out: dict, cancel=None, progress=None) -> Path:
    """Stream one workbook. Each sheet is read from its LazyFrame XLSX_CHUNK rows at a
    time, so a 1M-row sheet never sits in memory whole. sheets: [{name, lf, rows}]."""
    import zipfile

    header = bool(out.get("header", True))
    codes: list[str] = ["General"]
    plan = []
    for sh in sheets:
        if sh.get("grid") is not None:
            for c in sh.get("fmts") or []:
                if c and c not in codes:
                    codes.append(c)
            plan.append(None)
        else:
            plan.append(_xlsx_kinds(sh.get("formats") or out.get("formats") or {},
                                    sh["lf"].collect_schema().names(), codes))
    tmp = path.with_name(path.name + ".part")
    scratch: list[Path] = []
    try:
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as z:
            z.writestr("[Content_Types].xml",
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                '<Default Extension="xml" ContentType="application/xml"/>'
                '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                + "".join(f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                          for i in range(len(sheets))) + "</Types>")
            z.writestr("_rels/.rels",
                f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="{_NS_PKG}">'
                f'<Relationship Id="rId1" Type="{_NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>')
            z.writestr("xl/_rels/workbook.xml.rels",
                f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="{_NS_PKG}">'
                + "".join(f'<Relationship Id="rId{i + 1}" Type="{_NS_REL}/worksheet" Target="worksheets/sheet{i + 1}.xml"/>'
                          for i in range(len(sheets)))
                + f'<Relationship Id="rId{len(sheets) + 1}" Type="{_NS_REL}/styles" Target="styles.xml"/></Relationships>')
            z.writestr("xl/styles.xml", _styles_xml(codes, out.get("header_style") or "bold"))
            defined = []
            for i, sh in enumerate(sheets):
                if sh.get("grid") is not None:          # a pivot or dashboard sheet
                    grid = sh["grid"]
                    width = max((len(g.get("cells") or []) for g in grid), default=1)
                    body = _grid_rows_xml(grid, sh.get("fmts") or [], codes, len(codes))
                    widths = sh.get("widths") or [max(10, min(42, max((len(str((g.get("cells") or [""])[c]))
                                                 for g in grid if c < len(g.get("cells") or [])), default=8) + 2))
                                                 for c in range(width)]
                    z.writestr(f"xl/worksheets/sheet{i + 1}.xml",
                        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="{_NS_MAIN}" xmlns:r="{_NS_REL}">'
                        f'<dimension ref="A1:{_col_letter(max(0, width - 1))}{max(1, len(grid))}"/>'
                        f'<sheetViews><sheetView {_tab_sel(i)}workbookViewId="0"/></sheetViews>'
                        '<sheetFormatPr defaultRowHeight="15"/><cols>'
                        + "".join(f'<col min="{j + 1}" max="{j + 1}" width="{w:.1f}" customWidth="1"/>'
                                  for j, w in enumerate(widths)) + "</cols><sheetData>" + body +
                        '</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>')
                    continue
                kinds = plan[i] or {}
                frozen_hdr = header and out.get("autofilter", True)
                lf, total = sh["lf"], int(sh["rows"])
                cols = lf.collect_schema().names()
                chunk = lf.head(min(total, XLSX_CHUNK)).collect() if total else pl.DataFrame(schema={c: pl.String for c in cols})
                widths = _col_widths(chunk) if cols else []
                last_col = _col_letter(max(0, len(cols) - 1))
                ref = f"A1:{last_col}{max(1, total + (1 if header else 0))}"
                if frozen_hdr and cols:
                    defined.append(f'<definedName name="_xlnm._FilterDatabase" localSheetId="{i}" hidden="1">'
                                   f"'{_esc(sh['name']).replace(chr(39), chr(39) * 2)}'!$A$1:${last_col}${max(1, total + 1)}</definedName>")
                pane = ('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
                        '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>') if frozen_hdr else ""
                head = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="{_NS_MAIN}" xmlns:r="{_NS_REL}">'
                        f'<dimension ref="{ref}"/><sheetViews><sheetView {_tab_sel(i)}workbookViewId="0">{pane}</sheetView></sheetViews>'
                        '<sheetFormatPr defaultRowHeight="15"/>'
                        + ("<cols>" + "".join(f'<col min="{j + 1}" max="{j + 1}" width="{w:.1f}" customWidth="1"/>'
                                              for j, w in enumerate(widths)) + "</cols>" if widths else "") + "<sheetData>")
                if header:
                    head += '<row r="1">' + "".join(f'<c r="{_col_letter(j)}1" t="inlineStr" s="1"><is><t>{_esc(c)}</t></is></c>'
                                                    for j, c in enumerate(cols)) + "</row>"
                tail = ("</sheetData>" + (f'<autoFilter ref="{ref}"/>' if frozen_hdr and cols else "")
                        + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>')
                with z.open(f"xl/worksheets/sheet{i + 1}.xml", "w", force_zip64=True) as w:
                    w.write(head.encode("utf-8"))
                    off = 0
                    while chunk.height:
                        _check_cancel(cancel)
                        rows_file = tmp.with_name(f"{tmp.name}.r{i}")
                        scratch.append(rows_file)
                        _rows_xml(chunk, (2 if header else 1) + off, kinds).write_csv(
                            rows_file, include_header=False, quote_style="never", line_terminator="\n")
                        with open(rows_file, "rb") as r:
                            while block := r.read(1 << 22):
                                w.write(block)
                        rows_file.unlink()
                        off += chunk.height
                        if progress:
                            progress(off, total, sh["name"])
                        if off >= total:
                            break
                        chunk = lf.slice(off, XLSX_CHUNK).collect()
                    w.write(tail.encode("utf-8"))
            z.writestr("xl/workbook.xml",
                f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="{_NS_MAIN}" xmlns:r="{_NS_REL}">'
                '<bookViews><workbookView/></bookViews><sheets>'
                + "".join(f'<sheet name="{_esc(sh["name"])}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, sh in enumerate(sheets))
                + "</sheets>" + (f"<definedNames>{''.join(defined)}</definedNames>" if defined else "") + "</workbook>")
        _replace(tmp, path)
    finally:
        for f in [tmp, *scratch]:
            try:
                f.unlink()
            except OSError:
                pass
    return path


def _write_xlsx_fast(df: pl.DataFrame, path: Path, out: dict) -> list[Path]:
    chunk = min(int(out.get("max_rows_per_sheet") or XLSX_MAX_ROWS), XLSX_MAX_ROWS)
    parts = max(1, -(-df.height // chunk)) if df.height else 1
    base = _safe_sheet(out.get("sheet_name") or "Data")
    sheets = [{"name": base if parts == 1 else _safe_sheet(f"{base[:27]}_{i + 1}"),
               "lf": df.slice(i * chunk, chunk).lazy(), "rows": min(chunk, max(0, df.height - i * chunk))}
              for i in range(parts)]
    write_xlsx_book(path, sheets, out)
    return [path]


def _write_xlsx(df: pl.DataFrame, path: Path, out: dict) -> list[Path]:
    if (out.get("xlsx_engine") or os.environ.get("COLSIFT_XLSX") or "fast") == "fast":
        try:
            return _write_xlsx_fast(df, path, out)
        except Exception:  # noqa: BLE001 — never lose an export over the fast path
            traceback.print_exc()
    return _write_xlsx_classic(df, path, out)


def _write_xlsx_classic(df: pl.DataFrame, path: Path, out: dict) -> list[Path]:
    written: list[Path] = []
    chunk = int(out.get("max_rows_per_sheet") or XLSX_MAX_ROWS)
    chunk = min(chunk, XLSX_MAX_ROWS)
    parts = max(1, -(-df.height // chunk)) if df.height else 1
    sheet_base = out.get("sheet_name") or "Data"

    try:
        import xlsxwriter  # noqa: F401
        engine_ok = True
    except ImportError:
        engine_ok = False

    if engine_ok:
        import xlsxwriter

        wb = xlsxwriter.Workbook(str(path), {"constant_memory": True})
        hdr = wb.add_format({"bold": True, "bg_color": "#EDF2F1", "border": 1})
        for i in range(parts):
            part = df.slice(i * chunk, chunk)
            ws = wb.add_worksheet(sheet_base if parts == 1 else f"{sheet_base}_{i + 1}")
            if out.get("header", True):
                for c, name in enumerate(part.columns):
                    ws.write_string(0, c, name, hdr)
                ws.freeze_panes(1, 0)
                if out.get("autofilter", True) and part.width:
                    ws.autofilter(0, 0, max(1, part.height), part.width - 1)
            for c, name in enumerate(part.columns):
                ws.set_column(c, c, min(48, max(10, len(str(name)) + 4)))
            off = 1 if out.get("header", True) else 0
            for r, row in enumerate(part.iter_rows()):
                for c, v in enumerate(row):
                    ws.write_string(r + off, c, "" if v is None else str(v))
        wb.close()
    else:
        from openpyxl import Workbook

        wb = Workbook(write_only=True)
        for i in range(parts):
            part = df.slice(i * chunk, chunk)
            ws = wb.create_sheet(sheet_base if parts == 1 else f"{sheet_base}_{i + 1}")
            if out.get("header", True):
                ws.append(list(part.columns))
            for row in part.iter_rows():
                ws.append(["" if v is None else str(v) for v in row])
        wb.save(str(path))
    written.append(path)
    return written


def _out_path(out: dict, stem: str, fmt: str) -> Path:
    folder = _norm(out.get("folder") or ".")
    folder.mkdir(parents=True, exist_ok=True)
    ext = {"csv": ".csv", "txt": ".txt", "xlsx": ".xlsx"}[fmt]
    name = stem
    if out.get("timestamp"):
        name = f"{name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    path = folder / f"{name}{ext}"
    if not out.get("overwrite", True):
        i = 1
        while path.exists():
            path = folder / f"{name} ({i}){ext}"
            i += 1
    return path


def count_lines(path: Path) -> int:
    """Newlines in a file, read in 4 MB blocks — cheap enough to run after a sink."""
    n, tail = 0, b"\n"
    with open(path, "rb") as fh:
        while block := fh.read(1 << 22):
            n += block.count(b"\n")
            tail = block[-1:]
    if tail not in (b"\n", b""):
        n += 1
    return n


def sink_delimited(lf: pl.LazyFrame, out: dict, stem: str) -> str:
    """Stream straight to disk — the frame never has to fit in memory."""
    path = _out_path(out, stem, (out.get("format") or "csv").lower())
    lf.sink_csv(
        path,
        separator=resolve_delim(out.get("delimiter", ",")),
        include_header=bool(out.get("header", True)),
        quote_style=out.get("quote_style", "necessary"),
        line_terminator=out.get("line_terminator", "\n"),
        null_value=out.get("null_value", ""),
        maintain_order=True,
    )
    return str(path)


def _sink_kwargs(out: dict) -> dict:
    return dict(
        separator=resolve_delim(out.get("delimiter", ",")),
        include_header=bool(out.get("header", True)),
        quote_style=out.get("quote_style", "necessary"),
        line_terminator=out.get("line_terminator", "\n"),
        null_value=out.get("null_value", ""),
        maintain_order=True,
    )


def _run_sinks(sinks, out, per_file, written, errors) -> None:
    kw = _sink_kwargs(out)
    try:
        pl.collect_all([lf.sink_csv(path, lazy=True, **kw) for _, path, lf in sinks],
                       engine="streaming")
        failed = set()
    except Exception:  # noqa: BLE001 — isolate the bad file, keep the good ones
        failed = set()
        for i, path, lf in sinks:
            try:
                lf.sink_csv(path, **kw)
            except Exception as exc:  # noqa: BLE001
                failed.add(i)
                per_file[i].update(rows=0, error=brief(exc))
                errors.append(f"{per_file[i]['file']} — {brief(exc)}")
    hdr = 1 if out.get("header", True) else 0
    for i, path, _ in sinks:
        if i in failed:
            continue
        per_file[i]["rows"] = max(0, count_lines(path) - hdr)
        written.append(str(path))


def sink_and_count(lf: pl.LazyFrame, out: dict, stem: str) -> tuple[str, int]:
    path = sink_delimited(lf, out, stem)
    rows = max(0, count_lines(Path(path)) - (1 if out.get("header", True) else 0))
    return path, rows


def write_output(df: pl.DataFrame, out: dict, stem: str) -> list[str]:
    fmt = (out.get("format") or "csv").lower()
    path = _out_path(out, stem, fmt)

    if fmt == "xlsx":
        if df.height > XLSX_MAX_ROWS and not out.get("max_rows_per_sheet"):
            out = {**out, "max_rows_per_sheet": XLSX_MAX_ROWS}
        return [str(p) for p in _write_xlsx(df, path, out)]

    _write_delimited(df, path, out)
    return [str(path)]


# ---- output formats for text outputs ---------------------------------------

def text_formatters(formats: dict, columns: list[str], decimal_comma: bool = False) -> list[pl.Expr]:
    """CSV/TXT: typed columns rendered through their format; values that don't parse
    pass through untouched, so a stray "N/A" in an amount column is never lost."""
    out = []
    for c in columns:
        fm = (formats or {}).get(c) or {}
        t = fm.get("type") or "text"
        if t == "number":
            txt = F.fmt_number(F.clean_number(pl.col(c)), fm.get("fmt") or "General")
            if decimal_comma:
                txt = (txt.str.replace_all(",", "\x00", literal=True).str.replace_all(".", ",", literal=True)
                       .str.replace_all("\x00", ".", literal=True))
        elif t == "date":
            code = F.to_strftime(fm.get("fmt") or "dd/mm/yyyy")
            d = F.parse_datetime(pl.col(c), fm.get("date_in")) if F.has_time(code) else F.parse_date(pl.col(c), fm.get("date_in"))
            txt = d.dt.strftime(code)
        else:
            continue
        out.append(pl.coalesce([txt, pl.col(c)]).alias(c))
    return out


def format_warnings(lf: pl.LazyFrame, formats: dict, prefix: str = "") -> list[str]:
    cols = lf.collect_schema().names()
    probes, kinds = [], {}
    for c in cols:
        fm = (formats or {}).get(c) or {}
        t = fm.get("type") or "text"
        if t not in ("number", "date"):
            continue
        bad = F.clean_number(pl.col(c)).is_null() if t == "number" else F.parse_date(pl.col(c), fm.get("date_in")).is_null()
        probes.append((pl.col(c).is_not_null() & (pl.col(c).str.strip_chars() != "") & bad).sum().alias(c))
        kinds[c] = "numbers" if t == "number" else "dates"
    if not probes:
        return []
    row = lf.select(probes).collect().row(0, named=True)
    return [f"{prefix}{c}: {n:,} value{'s' if n != 1 else ''} weren't {kinds[c]} — written as text"
            for c, n in row.items() if n]


def _write_csv_part(lf: pl.LazyFrame, path: Path, out: dict) -> None:
    fx = text_formatters(out.get("formats") or {}, lf.collect_schema().names(), bool(out.get("decimal_comma")))
    if fx:
        lf = lf.with_columns(fx)
    enc = (out.get("encoding") or "utf-8").lower()
    tmp = path.with_name(path.name + ".part")
    try:
        lf.sink_csv(tmp, include_bom=enc == "utf-8-sig", check_extension=False, **_sink_kwargs(out))
        if enc not in ("utf-8", "utf-8-sig"):
            enc_tmp = path.with_name(path.name + ".enc")
            with open(tmp, "r", encoding="utf-8", newline="") as src, \
                    open(enc_tmp, "w", encoding=enc, errors="replace", newline="") as dst:
                while block := src.read(1 << 20):
                    dst.write(block)
            tmp.unlink()
            tmp = enc_tmp
        _replace(tmp, path)
    finally:
        for f in (path.with_name(path.name + ".part"), path.with_name(path.name + ".enc")):
            try:
                f.unlink()
            except OSError:
                pass


# ---- splitting big outputs ---------------------------------------------------

def _safe_name(s: str, limit: int = 80) -> str:
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(s)).strip().strip(".")
    return (s or "blank")[:limit]


def _unique(name: str, used: set[str], limit: int | None = None) -> str:
    cand, i = name, 2
    while cand.lower() in used:
        suffix = f" ({i})"
        cand = (name[:limit - len(suffix)] if limit else name) + suffix
        i += 1
    used.add(cand.lower())
    return cand


def plan_parts(lf: pl.LazyFrame, total: int, out: dict, fmt: str) -> tuple[list[dict], str]:
    """Cut the output into parts: by a column's values, every N rows, and always at
    Excel's 1,048,575-row limit for .xlsx. Returns the parts and 'sheets' or 'files'."""
    split = out.get("split") or {}
    by = split.get("by") or "none"
    into = (split.get("into") or "sheets") if fmt == "xlsx" else "files"
    limit = int(split.get("rows") or 0) if by == "rows" else 0
    if fmt == "xlsx":
        limit = min(limit or XLSX_MAX_ROWS, XLSX_MAX_ROWS)
    groups: list[tuple[str, pl.LazyFrame, int]] = []
    if by == "value" and split.get("column"):
        col = split["column"]
        if col not in lf.collect_schema().names():
            raise ValueError(f"Split column “{col}” isn't in the output — keep it (or add it) first")
        counts = lf.group_by(col, maintain_order=True).agg(pl.len().alias("__n")).collect()
        if counts.height > MAX_PARTS:
            raise ValueError(f"“{col}” has {counts.height:,} different values — over {MAX_PARTS} parts. "
                             "Split by a column with fewer values.")
        for v, n in counts.iter_rows():
            label = "(blank)" if v is None or not str(v).strip() else str(v).strip()
            groups.append((label, lf.filter(pl.col(col).is_null() if v is None else pl.col(col) == v), int(n)))
    else:
        groups.append(("", lf, int(total)))
    parts = []
    for label, sub, n in groups:
        k = -(-n // limit) if limit and n > limit else 1
        for j in range(k):
            parts.append({"label": label, "idx": j + 1, "of": k,
                          "lf": sub.slice(j * limit, limit) if k > 1 else sub,
                          "rows": min(limit, n - j * limit) if k > 1 else n})
    if len(parts) > MAX_PARTS:
        raise ValueError(f"That would make {len(parts):,} parts — over the {MAX_PARTS} limit. Raise the rows per part.")
    return parts, into


def write_parts(lf: pl.LazyFrame, total: int, out: dict, stem: str, fmt: str,
                cancel=None, progress=None, extra: list[dict] | None = None) -> list[str]:
    """`extra` holds analysis / summary grids. They ride along in the workbook when
    the data lands in exactly one workbook; otherwise they get their own file."""
    parts, into = plan_parts(lf, total, out, fmt)
    base = _safe_sheet(out.get("sheet_name") or "Data")
    written: list[str] = []
    extra = list(extra or [])
    if extra:
        used = {_safe_sheet(base).lower()}
        for e in extra:
            e["name"] = A.sheet_name(e["name"], used)
    one_book = fmt == "xlsx" and (into == "sheets" or len(parts) == 1)
    if extra and not one_book:
        if fmt == "xlsx":
            path = _out_path(out, f"{stem}_analysis", "xlsx")
            write_xlsx_book(path, extra, out, cancel)
            written.append(str(path))
        else:
            for e in extra:
                pth = _out_path(out, f"{stem}_{_safe_name(e['name'], 60)}", fmt)
                _write_grid_csv(e["grid"], pth, out)
                written.append(str(pth))
        extra = []
    if fmt == "xlsx" and into == "sheets":
        used: set[str] = set()
        sheets = []
        for pt in parts:
            nm = pt["label"] or base
            if pt["of"] > 1:
                nm = f"{nm[:25]}_{pt['idx']}"
            sheets.append({"name": _unique(_safe_sheet(nm), used, 31), "lf": pt["lf"], "rows": pt["rows"]})
        path = _out_path(out, stem, "xlsx")
        write_xlsx_book(path, sheets + extra, out, cancel, progress)
        return [str(path), *written]
    used = set()
    for pt in parts:
        _check_cancel(cancel)
        name = stem + (f"_{_safe_name(pt['label'], 60)}" if pt["label"] else "") + \
            (f"_part{pt['idx']:03d}" if pt["of"] > 1 else "")
        path = _out_path(out, _unique(name, used), fmt)
        if fmt == "xlsx":
            write_xlsx_book(path, [{"name": base, "lf": pt["lf"], "rows": pt["rows"]}, *extra], out, cancel, progress)
            extra = []
        else:
            _write_csv_part(pt["lf"], path, out)
            if progress:
                progress(pt["rows"], pt["rows"], path.name)
        written.append(str(path))
    return written


# ---- analysis and summaries -------------------------------------------------

def analysis_grids(result: dict, job: dict) -> list[dict]:
    """The dashboard and each summary tab as sheet grids: one Analysis sheet with
    the cards stacked, then one sheet per summary tab, in the tab order."""
    out = []
    for t in A.export_tables(result, job):
        if t["kind"] == "summary":
            text, nums, fmts = A.table_rows(t["table"])
            kinds = A.kinds(t["table"])
            grid = [{"cells": r, "nums": n, "kind": k} for r, n, k in zip(text, nums, kinds)]
            out.append({"name": t["name"], "grid": grid, "fmts": fmts})
            continue
        grid: list[dict] = []
        fmts: list[str | None] = []
        if result.get("filter_text"):
            grid.append({"cells": [f"Filtered: {result['filter_text']}"], "nums": [None], "kind": "data"})
            grid.append({"cells": [], "nums": [], "kind": "data"})
        for item in t["items"]:
            text, nums, ifmts = A.table_rows(item["table"])
            kinds = A.kinds(item["table"])
            grid.append({"cells": [item.get("name") or ""], "nums": [None], "kind": "title"})
            grid += [{"cells": r, "nums": n, "kind": k} for r, n, k in zip(text, nums, kinds)]
            grid.append({"cells": [], "nums": [], "kind": "data"})
            for i, f in enumerate(ifmts):        # widest card decides each column
                if i >= len(fmts):
                    fmts.append(f)
                elif f and not fmts[i]:
                    fmts[i] = f
        if grid:
            out.append({"name": t["name"], "grid": grid, "fmts": fmts})
    return out


def _write_grid_csv(grid: list[dict], path: Path, out: dict) -> None:
    sep = resolve_delim(out.get("delimiter") or "comma")
    eol = out.get("line_terminator") or "\n"
    enc = (out.get("encoding") or "utf-8").lower()
    buf = io.StringIO()
    w = _csv.writer(buf, delimiter=sep, lineterminator=eol, quoting=_csv.QUOTE_MINIMAL)
    for row in grid:
        w.writerow([("" if c is None else str(c)) for c in (row.get("cells") or [])])
    tmp = path.with_name(path.name + ".part")
    tmp.write_text(buf.getvalue(), encoding="utf-8-sig" if enc == "utf-8-sig" else enc, errors="replace")
    _replace(tmp, path)


def _analysis_frame(job: dict, scope: str = "active", on_progress=None, rows: int = 0) -> tuple[pl.DataFrame, str, int]:
    """The extracted frame the Analysis tab works on: the current file (a sampled
    workbook stays sampled) or, for scope 'all', every ticked file stacked."""
    files = job.get("files") or []
    if not files:
        raise ValueError("Pick at least one file first.")
    if scope == "all":
        prep = prepare(files, job.get("source"), on_progress, workers=1 if _sequential(job) else None)
        lfs = []
        for f in files:
            p = _norm(f)
            if str(p) in prep["errors"]:
                continue
            src = Source.from_dict({**(job.get("source") or {}), "path": str(p)})
            lfs.append(build_pipeline(src, job))
        if not lfs:
            raise ValueError("No file could be read.")
        frames = [d for d in _collect_many(lfs, _sequential(job)) if not isinstance(d, Exception)]
        if not frames:
            raise ValueError("No file could be read.")
        if batch_dupes(job) or job.get("distinct"):
            df = across_files(stacked([f.lazy() for f in frames]), job).drop(SRC_COL).collect()
        else:
            df = pl.concat(frames, how="diagonal_relaxed")
        return df, f"{len(frames)} file{'s' if len(frames) != 1 else ''}, {df.height:,} rows", 0
    src = Source.from_dict({**(job.get("source") or {}), "path": files[0]})
    p0 = _norm(files[0])
    sampled = (PREVIEW_SAMPLE if p0.suffix.lower() in xlsxfast.FAST_EXT
               and _cached_sheet(p0, src.sheet) is None
               and bool(_peek_cached(str(p0), src.encoding, src.sheet).get("fast")) else 0)
    src.sample_rows = sampled
    lf = build_pipeline(src, job, for_preview=bool(sampled))
    if batch_dupes(job):            # within this one file — "every file" looks across all of them
        lf = across_files(lf, job)
    df = lf.head(int(rows)).collect() if rows else lf.collect(engine="streaming")
    return df, f"{p0.name}, {df.height:,} rows", sampled


def analyse(job: dict, scope: str = "active", on_progress=None, rows: int = 0) -> dict:
    """What the Analysis tab draws. scope 'active' reads the current file only
    (fast, and a sampled workbook stays sampled); 'all' runs the whole batch."""
    t0 = time.time()
    try:
        df, note, sampled = _analysis_frame(job, scope, on_progress, rows)
        res = A.analyse(df.lazy(), job)
        return {**res, "scope": scope, "note": note, "sampled": sampled, "rows_seen": df.height,
                "elapsed": round(time.time() - t0, 2)}
    except (A.AnalysisError, F.FormulaError, ValueError) as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": brief(exc)}


def drill(job: dict, scope: str = "active", filters: list[dict] | None = None, limit: int = 500,
          on_progress=None) -> dict:
    """The rows behind a clicked bar, slice or pivot cell — after the dashboard's own
    filters when asked (a card that follows them), plus the clicked path."""
    t0 = time.time()
    try:
        df, note, sampled = _analysis_frame(job, scope, on_progress)
        cols = df.columns
        res = A.detail(df.lazy(), list(filters or []), cols, limit)
        return {**res, "note": note, "sampled": sampled, "elapsed": round(time.time() - t0, 2)}
    except (A.AnalysisError, F.FormulaError, ValueError) as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": brief(exc)}


# ---- the run ---------------------------------------------------------------------

def wants_analysis(job: dict) -> bool:
    an, su = job.get("analysis") or {}, job.get("summaries") or {}
    return bool((an.get("export") and an.get("items")) or (su.get("export") and su.get("tabs")))


def pdf_parts(job: dict) -> list[str]:
    """Which PDF reports the run writes beside the data: the dashboard, the summaries,
    or both — independent of whether they also ride along as sheets."""
    pdf = (job.get("output") or {}).get("pdf") or {}
    an, su = job.get("analysis") or {}, job.get("summaries") or {}
    parts = []
    if pdf.get("dashboard") and [i for i in an.get("items") or [] if i.get("kind") != "slicer"]:
        parts.append("dashboard")
    if pdf.get("summaries") and su.get("tabs"):
        parts.append("summaries")
    return parts


def write_pdfs(res: dict, job: dict, out: dict, stem: str, title: str, subtitle: str = "") -> list[str]:
    """<stem>_dashboard.pdf and <stem>_summaries.pdf — or one <stem>_analysis.pdf when
    the output asks for them together."""
    import pdfout

    parts = pdf_parts(job)
    if not parts:
        return []
    pdf = out.get("pdf") or {}
    kw = dict(title=title, subtitle=subtitle, size=pdf.get("size") or "A4",
              landscape=(pdf.get("orientation") or "landscape") == "landscape")
    folder = _norm(out.get("folder") or ".")
    folder.mkdir(parents=True, exist_ok=True)
    stamp = f"_{datetime.now():%Y%m%d_%H%M%S}" if out.get("timestamp") else ""
    if pdf.get("combined") and len(parts) > 1:
        targets = [(parts, folder / f"{stem}_analysis{stamp}.pdf")]
    else:
        targets = [([p], folder / f"{stem}_{p}{stamp}.pdf") for p in parts]
    written = []
    for which, path in targets:
        try:
            pdfout.analysis_pdf(path, res, which, **kw)
        except PermissionError:
            raise OutputLocked(f"{path.name} is open in another program — close it and run again") from None
        written.append(str(path))
    return written


def _stage_dir() -> Path:
    import shutil

    base = (cache_dir() or Path(tempfile.gettempdir())) / "staging"
    d = base / f"run_{os.getpid()}_{time.time_ns()}"
    d.mkdir(parents=True, exist_ok=True)
    for old in base.glob("run_*"):          # leftovers from a crashed run
        try:
            if old != d and time.time() - old.stat().st_mtime > 86400:
                shutil.rmtree(old, ignore_errors=True)
        except OSError:
            pass
    return d


# --------------------------------------------------------------------------
# across every file — duplicates by key, after each file's own pipeline
# --------------------------------------------------------------------------
# Filters and computed columns work file by file. A ticket that turns up in both
# January's and February's extract is a duplicate only when the files are looked at
# together, so this step runs once over everything the files produced.

DUP_KEEP = [("all", "Every row — just add the columns"), ("dups", "Only rows whose key repeats"),
            ("files", "Only keys found in more than one file"), ("first", "The first row of each key"),
            ("last", "The last row of each key"), ("unique", "Only keys that appear once")]
SRC_COL = "__colsift_src"


def batch_dupes(job: dict) -> dict | None:
    """The job's duplicates-across-files step, or None when it has none."""
    d = job.get("batch_dupes") or {}
    keys = [str(k) for k in d.get("keys") or [] if str(k or "").strip()]
    if not keys or d.get("enabled") is False:
        return None
    keep = d.get("keep") or "all"
    if keep not in {k for k, _ in DUP_KEEP}:
        raise ValueError(f"Duplicates across files: unknown choice “{keep}”")
    return {"keys": keys, "keep": keep, "fold": d.get("fold", True) is not False,
            "count_col": str(d.get("count_col") or "").strip(), "files_col": str(d.get("files_col") or "").strip(),
            "occ_col": str(d.get("occ_col") or "").strip()}


def stacked(parts: list[pl.LazyFrame]) -> pl.LazyFrame:
    """Files one under another, each row tagged with its file's position."""
    return pl.concat([lf.with_columns(pl.lit(i, dtype=pl.UInt32).alias(SRC_COL)) for i, lf in enumerate(parts)],
                     how="diagonal_relaxed")


def across_files(lf: pl.LazyFrame, job: dict) -> pl.LazyFrame:
    """Distinct rows and the duplicates step over everything at once. `lf` may carry
    SRC_COL (from stacked); it is kept for the caller to split on or drop."""
    cols = lf.collect_schema().names()
    data = [c for c in cols if c != SRC_COL]
    if job.get("distinct"):
        lf = lf.unique(subset=data, keep="first", maintain_order=True)
    d = batch_dupes(job)
    if not d:
        return lf
    miss = [k for k in d["keys"] if k not in data]
    if miss:
        raise ValueError(f"Duplicates across files: the output has no column {', '.join(miss)} — "
                         "keep it on the Columns tab (under its new name, if renamed)")
    kk = [f"__dk{i}" for i in range(len(d["keys"]))]
    norm = []
    for k in d["keys"]:
        e = pl.col(k).cast(pl.String).str.strip_chars().fill_null("")
        norm.append(e.str.to_lowercase() if d["fold"] else e)
    lf = lf.with_columns([e.alias(n) for e, n in zip(norm, kk)]).with_row_index("__dr")
    blank = pl.all_horizontal([pl.col(n) == "" for n in kk])        # no key: never a duplicate
    files = pl.col(SRC_COL).n_unique().over(kk) if SRC_COL in cols else pl.lit(1)
    lf = lf.with_columns(
        pl.when(blank).then(1).otherwise(pl.len().over(kk)).cast(pl.Int64).alias("__dc"),
        pl.when(blank).then(1).otherwise(files).cast(pl.Int64).alias("__df"),
        pl.when(blank).then(1).otherwise(pl.col("__dr").rank("ordinal").over(kk)).cast(pl.Int64).alias("__do"))
    keep = {"dups": pl.col("__dc") > 1, "files": pl.col("__df") > 1, "first": pl.col("__do") == 1,
            "last": pl.col("__do") == pl.col("__dc"), "unique": pl.col("__dc") == 1}.get(d["keep"])
    if keep is not None:
        lf = lf.filter(keep)
    adds = [pl.col(src).cast(pl.String).alias(name) for src, name in
            (("__dc", d["count_col"]), ("__df", d["files_col"]), ("__do", d["occ_col"])) if name]
    if adds:
        lf = lf.with_columns(adds)
    return lf.drop(["__dr", "__dc", "__df", "__do", *kk])


def _materialised(lf: pl.LazyFrame, stage: Path, name: str) -> pl.LazyFrame:
    """Work a plan out once into the staging folder: written in chunks later, a window
    over every file must not be recomputed for each chunk."""
    path = stage / f"{name}_{time.time_ns()}.parquet"
    try:
        lf.sink_parquet(path, compression="lz4")
    except Exception:  # noqa: BLE001 — a plan the streaming sink can't take
        lf.collect(engine="streaming").write_parquet(path, compression="lz4")
    return pl.scan_parquet(path)


def _align_stage(paths: list[Path]) -> None:
    """Give every staged file the same columns in the same order, so the combined
    output is one multi-file Parquet scan that can be sliced in chunks cheaply."""
    schemas = [pl.scan_parquet(pth).collect_schema().names() for pth in paths]
    union: list[str] = []
    for names in schemas:
        union += [n for n in names if n not in union]
    for pth, names in zip(paths, schemas):
        if names != union:
            tmp = pth.with_suffix(".align.parquet")
            pl.scan_parquet(pth).select([pl.col(c) if c in names else pl.lit(None, dtype=pl.String).alias(c)
                                        for c in union]).sink_parquet(tmp)
            os.replace(tmp, pth)


def _write_log(out: dict, job: dict, per_file: list, written: list, errors: list,
               warnings: list, total: int, elapsed: float) -> str:
    path = _norm(out["folder"]) / f"{_safe_name(out.get('basename') or 'extract')}_log.txt"
    lines = [f"ColSift run log — {datetime.now():%Y-%m-%d %H:%M:%S}", "",
             f"Filters:    {describe_filters(job.get('filters'))}",
             f"Processing: {'one file at a time' if _sequential(job) else 'several files at once'}",
             f"Format:     {(out.get('format') or 'csv').upper()}"]
    if wants_analysis(job):
        an, su = job.get("analysis") or {}, job.get("summaries") or {}
        bits = ([f"{len(an.get('items') or [])} dashboard item(s)"] if an.get("export") else []) + \
               ([f"{len(su.get('tabs') or [])} summary tab(s)"] if su.get("export") else [])
        lines.append(f"Analysis:   {', '.join(bits)}")
    lines += ["", "Input files:"]
    for f in per_file:
        state = f"ERROR  {f['error']}" if f.get("error") else f"{f.get('rows') or 0:>12,} rows"
        lines.append(f"  {f['file']:<48} {state}" + (f"   · {f['note']}" if f.get("note") else ""))
    lines += ["", "Written:"] + [f"  {w}" for w in written] + ["", f"Rows written: {total:,}", f"Elapsed: {elapsed}s"]
    if warnings:
        lines += ["", "Warnings:"] + [f"  {w}" for w in warnings]
    if errors:
        lines += ["", "Errors:"] + [f"  {e}" for e in errors]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(path)


class StoppedOnError(Exception):
    """A file failed and the job says stop_on_error. Carries the rows staged so far."""

    def __init__(self, message: str, results: list[dict]):
        super().__init__(message)
        self.results = results


def stage_inputs(job: dict, stage: Path, on_progress=None, cancel=None, prefix: str = "",
                 label: str = "") -> list[dict]:
    """Every input of a job through the pipeline into its own Parquet file under
    `stage` — one at a time in 'sequential' mode, so only one file's working set is in
    memory. Returns one row per input: {file, rows, note} plus "_path", or {file, rows:
    0, error}. Used by run() and by workspaces, which stage several setups side by side."""
    files = job.get("files") or []
    sequential = _sequential(job)
    notify = (lambda **k: on_progress(k)) if on_progress else (lambda **k: None)
    tag = f"{label}: " if label else ""
    prep = {"errors": {}} if sequential else prepare(files, job.get("source"), on_progress)

    def stage_one(i: int, f: str) -> dict:
        p = _norm(f)
        if str(p) in prep["errors"]:
            raise RuntimeError(prep["errors"][str(p)])
        src = Source.from_dict({**(job.get("source") or {}), "path": str(p)})
        if is_excel(p) and cache_on():
            build_sheet_cache(str(p), src.sheet)        # this workbook's one full parse
        notes: list[str] = []
        dst = stage / f"{prefix}{i:05d}.parquet"
        build_pipeline(src, job, notes=notes).sink_parquet(dst, compression="lz4")
        n = pl.scan_parquet(dst).select(pl.len()).collect().item()
        return {"file": p.name, "path": str(p), "rows": int(n), "note": "; ".join(notes) or None, "_path": dst}

    def failed(f: str, exc: BaseException) -> dict:
        msg = ("Not enough memory for this file — close other programs, or process it on its own"
               if isinstance(exc, MemoryError) else brief(exc))
        return {"file": _norm(f).name, "path": str(_norm(f)), "rows": 0, "error": msg}

    results: list[dict] = [{}] * len(files)
    if sequential:
        for i, f in enumerate(files):
            _check_cancel(cancel)
            notify(stage="read", file=tag + _norm(f).name, index=i + 1, total=len(files))
            try:
                results[i] = stage_one(i, f)
            except Cancelled:
                raise
            except BaseException as exc:  # noqa: BLE001 — MemoryError included
                if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                    raise
                results[i] = failed(f, exc)
                if job.get("stop_on_error"):
                    raise StoppedOnError(f"{tag}{results[i]['file']} — {results[i]['error']}",
                                         [r for r in results if r]) from None
    else:
        from concurrent.futures import ThreadPoolExecutor, as_completed
        with ThreadPoolExecutor(max_workers=max(1, min(4, os.cpu_count() or 2))) as ex:
            futs = {ex.submit(stage_one, i, f): i for i, f in enumerate(files)}
            for done, fut in enumerate(as_completed(futs), 1):
                i = futs[fut]
                notify(stage="read", file=tag + _norm(files[i]).name, index=done, total=len(files))
                try:
                    results[i] = fut.result()
                except Exception as exc:  # noqa: BLE001
                    results[i] = failed(files[i], exc)
        _check_cancel(cancel)
    return results


def run(job: dict, on_progress=None, cancel=None) -> dict:
    """Two phases. Stage: each input goes through the pipeline and streams to its own
    Parquet file — in 'sequential' mode strictly one file at a time, so only one
    file's working set (for a workbook, its one unavoidable parse) is ever in memory.
    Write: outputs are cut into parts and read back from the staged data in chunks.
    Row counts per input come from the staged files, so they are always exact."""
    import shutil

    t0 = time.time()
    files = job.get("files") or []
    if not files:
        return {"ok": False, "error": "No files selected."}
    out = dict(job.get("output") or {})
    if not out.get("folder"):
        return {"ok": False, "error": "Choose an output folder."}
    fmt = (out.get("format") or "csv").lower()
    per_input = (out.get("mode") or "combine") != "combine"
    notify = (lambda **k: on_progress(k)) if on_progress else (lambda **k: None)

    stage = _stage_dir()
    per_file: list[dict] = []
    written: list[str] = []
    try:
        try:
            results = stage_inputs(job, stage, on_progress, cancel)
        except StoppedOnError as st:
            per_file = [{k: v for k, v in r.items() if k != "_path"} for r in st.results]
            return {"ok": False, "error": str(st), "files": per_file}

        per_file = [{k: v for k, v in r.items() if k != "_path"} for r in results]
        errors = [f"{r['file']} — {r['error']}" for r in results if r.get("error")]
        good = [(r["file"], r["_path"]) for r in results if not r.get("error")]
        if not good:
            return {"ok": False, "error": "Nothing to write — every file failed.", "files": per_file, "errors": errors}

        if batch_dupes(job):
            # duplicates are found over every file together, then (one output per
            # input) each file gets its own rows back
            notify(stage="build", part="duplicates across files")
            both = _materialised(across_files(stacked([pl.scan_parquet(p) for _, p in good]), job), stage, "across")
            kept = both.select(pl.len()).collect().item()
            read = sum(int(r.get("rows") or 0) for r in results if not r.get("error"))
            label = dict(DUP_KEEP)[batch_dupes(job)["keep"]].split(" —")[0].lower()
            dup_note = f"Duplicates across files ({label}): {kept:,} of the {read:,} rows read were kept"
            if per_input:
                groups = [(Path(name).stem + str(out.get("suffix") or ""),
                           both.filter(pl.col(SRC_COL) == i).drop(SRC_COL), name) for i, (name, _) in enumerate(good)]
            else:
                groups = [(out.get("basename") or "extract", both.drop(SRC_COL), "")]
        elif per_input:
            groups = [(Path(name).stem + str(out.get("suffix") or ""), [pth], name) for name, pth in good]
        else:
            _align_stage([pth for _, pth in good])
            groups = [(out.get("basename") or "extract", [pth for _, pth in good], "")]
        warnings: list[str] = [dup_note] if batch_dupes(job) else []
        total_rows = 0
        analysis_back = None
        for stem, paths, label in groups:
            _check_cancel(cancel)
            if isinstance(paths, pl.LazyFrame):
                lf = paths
            else:
                lf = pl.scan_parquet(paths if len(paths) > 1 else paths[0])
                if job.get("distinct"):
                    lf = lf.unique(maintain_order=True)
            total = lf.select(pl.len()).collect().item()
            if total == 0 and not out.get("write_empty"):
                continue
            total_rows += total
            extra: list[dict] = []
            back = bool(job.get("_return_analysis")) and len(groups) == 1
            if wants_analysis(job) or pdf_parts(job) or back:
                notify(stage="analyse", part=stem)
                try:
                    res = A.analyse(lf, job)
                    if back:          # the window shows this dashboard after the run
                        analysis_back = {**res, "note": f"{label or 'All files'}, {total:,} rows"}
                    if wants_analysis(job):
                        extra = analysis_grids(res, job)
                    warnings += [f"{i['name']}: {i['error']}" for i in res["items"] if i.get("error")]
                    warnings += [f"{t['name']}: {t['error']}" for t in res["tabs"] if t.get("error")]
                    warnings += res.get("notes") or []
                    if pdf_parts(job):
                        notify(stage="write", part=f"{stem} PDF")
                        written += write_pdfs(res, job, out, stem, (out.get("pdf") or {}).get("title") or stem,
                                              f"{label or 'All files'} · {total:,} rows")
                except (A.AnalysisError, F.FormulaError) as exc:
                    warnings.append(f"Analysis skipped — {exc}")
            notify(stage="write", rows=0, total=total, part=stem)
            written += write_parts(lf, total, out, stem, fmt, cancel,
                                   lambda off, tot, part: notify(stage="write", rows=off, total=tot, part=part),
                                   extra)
            if out.get("formats"):
                warnings += format_warnings(lf, out["formats"], f"{label}: " if label else "")
        elapsed = round(time.time() - t0, 2)
        log = _write_log(out, job, per_file, written, errors, warnings, total_rows, elapsed) if out.get("log") else None
        if not written:
            return {"ok": False, "error": "Every file matched 0 rows — nothing was written.", "files": per_file,
                    "errors": errors, "elapsed": elapsed}
        res = {"ok": True, "written": written, "rows": total_rows, "files": per_file, "errors": errors,
               "warnings": warnings, "log": log, "elapsed": elapsed}
        if analysis_back is not None:
            res["analysis"] = analysis_back
        return res
    except Cancelled:
        for w in written:
            try:
                Path(w).unlink()
            except OSError:
                pass
        return {"ok": False, "cancelled": True, "error": "Cancelled — nothing from this run was kept.",
                "files": per_file}
    except (OutputLocked, ValueError) as exc:
        return {"ok": False, "error": str(exc), "files": per_file}
    finally:
        shutil.rmtree(stage, ignore_errors=True)


# --------------------------------------------------------------------------
# lookup — hash search for specific values
# --------------------------------------------------------------------------

def _needles(text: str, case_sensitive: bool) -> list[str]:
    seen, out = set(), []
    for part in re.split(r"[\r\n\t]+|,(?=\s)|;", str(text or "")):
        v = part.strip().strip('"').strip("'")
        if not v:
            continue
        k = v if case_sensitive else v.lower()
        if k not in seen:
            seen.add(k)
            out.append(v)
    return out


def _scope_columns(scope: str, column: str, job: dict, available: list[str]) -> list[str]:
    if scope == "column":
        return [column] if column in available else []
    if scope == "kept":
        picked = [c["name"] for c in (job.get("columns") or [])
                  if c.get("include", True) and c.get("name") in available]
        return picked or available
    return available


def find(job: dict, params: dict, on_progress=None) -> dict:
    """Look up specific values across the selected files.

    Exact mode builds a hash set and lets polars probe it — the same cost whether you
    hand it one ticket number or fifty thousand. Every file's probe runs in one
    parallel batch; a second batch only happens for files that overflow the row cap.
    """
    t0 = time.time()
    files = job.get("files") or []
    if not files:
        return {"ok": False, "error": "Tick at least one file."}

    cs = bool(params.get("case_sensitive"))
    needles = _needles(params.get("values", ""), cs)
    if not needles:
        return {"ok": False, "error": "Type at least one value to look for."}
    # Ticket and doc numbers have no letters, so lower-casing every cell of every
    # column buys nothing. Only fold case when a search value actually has case.
    fold = not cs and any(n.lower() != n.upper() for n in needles)
    probe = [n.lower() for n in needles] if fold else list(needles)
    probe_set = set(probe)
    mode = params.get("mode", "exact")
    scope = params.get("scope", "all")
    limit = int(params.get("limit") or 500)
    want_missing = bool(params.get("missing", True)) and mode == "exact"

    prep = prepare(files, job.get("source"), on_progress, workers=1 if _sequential(job) else None)
    per_file, plans, errors = [], [], []
    fast_files = 0

    for f in files:
        p = _norm(f)
        if str(p) in prep["errors"]:
            per_file.append({"file": p.name, "hits": 0, "error": prep["errors"][str(p)]})
            continue
        src = Source.from_dict({**(job.get("source") or {}), "path": str(p)})
        try:
            available = _schema_names(src)
            cols = _scope_columns(scope, params.get("column", ""), job, available)
            if not cols:
                per_file.append({"file": p.name, "hits": 0, "error": "Column not in this file."})
                continue
            need = set(cols) | needed_columns(job, available)
            lf = None
            if params.get("linescan", True) and mode in ("exact", "contains", "starts") \
                    and len(cols) >= LINESCAN_MIN_COLS:
                lf = _line_candidates(src, probe, fold, available, need)
                if lf is not None:
                    fast_files += 1
            if lf is None:
                lf = load_lazy(src, need)
            tests = []
            for c in cols:
                col = pl.col(c).fill_null("")
                col = col.str.to_lowercase() if fold else col
                if mode == "exact":
                    tests.append(col.is_in(probe))
                elif mode == "starts":
                    tests.append(pl.any_horizontal([col.str.starts_with(v) for v in probe]))
                else:
                    tests.append(col.str.contains_any(probe))
            matched = lf.filter(pl.any_horizontal(tests)).with_columns(
                pl.coalesce([pl.when(t).then(pl.lit(c)) for c, t in zip(cols, tests)])
                  .alias("MATCHED_IN"),
                pl.lit(p.name).alias("SOURCE_FILE"),
            )
            plans.append({"i": len(per_file), "lf": matched, "cols": cols})
            per_file.append({"file": p.name, "hits": 0})
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{p.name} — {brief(exc)}")
            per_file.append({"file": p.name, "hits": 0, "error": brief(exc)})

    # Pass 1 — limit+1 rows from every file at once. If a file did not fill the cap,
    # its height IS its hit count and its rows are the whole story.
    heads = _collect_many([pl_["lf"].head(limit + 1) for pl_ in plans], _sequential(job))
    overflow = []
    for plan, res in zip(plans, heads):
        if isinstance(res, Exception):
            per_file[plan["i"]]["error"] = brief(res)
            plan["df"] = None
            continue
        plan["df"] = res
        if res.height > limit:
            overflow.append(plan)
        else:
            per_file[plan["i"]]["hits"] = res.height

    # Pass 2 — only the files that overflowed: exact count, plus values for "missing".
    if overflow:
        counts = _collect_many([o["lf"].select(pl.len()) for o in overflow], _sequential(job))
        for o, res in zip(overflow, counts):
            per_file[o["i"]]["hits"] = 0 if isinstance(res, Exception) else int(res.item())
        if want_missing:
            full = _collect_many([o["lf"].select(o["cols"], _sequential(job)) for o in overflow])
            for o, res in zip(overflow, full):
                o["vals"] = None if isinstance(res, Exception) else res

    found: set[str] = set()
    hit_rows: list[list[str]] = []
    header: list[str] = []
    for plan in plans:
        df = plan.get("df")
        if df is None:
            continue
        if want_missing:
            src_df = plan.get("vals") if plan in overflow else df
            if src_df is not None and src_df.height:
                vals = (src_df.select([c for c in plan["cols"] if c in src_df.columns])
                        .unpivot(value_name="__v").get_column("__v").drop_nulls())
                vals = vals.str.to_lowercase() if fold else vals
                found |= set(vals.unique().to_list()) & probe_set
        if df.height and len(hit_rows) < limit:
            header = header or df.columns
            room = limit - len(hit_rows)
            aligned = df.select([pl.col(c) if c in df.columns else pl.lit(None).alias(c)
                                 for c in header]) if df.columns != header else df
            hit_rows += [["" if v is None else str(v) for v in r]
                         for r in aligned.head(room).iter_rows()]

    total = sum(x["hits"] for x in per_file)
    missing = []
    if want_missing:
        lookup = {(n.lower() if fold else n): n for n in needles}
        missing = [lookup[k] for k in probe if k not in found]

    return {
        "ok": True, "total": total, "searched": len(needles),
        "files": per_file, "columns": header, "rows": hit_rows,
        "found": len(needles) - len(missing), "missing": missing,
        "capped": total > len(hit_rows), "errors": errors,
        "line_scanned": fast_files,
        "elapsed": round(time.time() - t0, 2),
    }


# --------------------------------------------------------------------------
# profiles
# --------------------------------------------------------------------------

_PROFILE_DIR: Path | None = None


def profile_dir() -> Path:
    """1. COLSIFT_PROFILES  2. profiles\\ next to the exe  3. the user profile.
    Program Files installs are read-only, so 3 is a real case, not a formality."""
    global _PROFILE_DIR
    if _PROFILE_DIR is not None:
        return _PROFILE_DIR
    env = os.environ.get("COLSIFT_PROFILES")
    for cand in filter(None, (Path(env) if env else None,
                              app_dir() / "profiles",
                              Path.home() / ".colsift" / "profiles")):
        if writable(cand):
            _PROFILE_DIR = cand
            return cand
    raise RuntimeError("Nowhere writable to keep setups — set COLSIFT_PROFILES.")


def save_profile(name: str, job: dict) -> dict:
    safe = re.sub(r"[^A-Za-z0-9 _.()-]", "_", (name or "profile").strip()) or "profile"
    p = profile_dir() / f"{safe}.json"
    payload = {k: v for k, v in job.items() if k != "files"}
    payload["_saved"] = datetime.now().isoformat(timespec="seconds")
    p.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return {"ok": True, "name": safe, "path": str(p)}


def _profile_files() -> dict[str, Path]:
    """Saved setups by name. 2.0's first cut kept workspaces in profiles\\workspaces;
    they are setups too now, listed alongside (a name saved here wins)."""
    out: dict[str, Path] = {}
    legacy = profile_dir() / "workspaces"
    if legacy.is_dir():
        out.update({p.stem: p for p in legacy.glob("*.json")})
    out.update({p.stem: p for p in profile_dir().glob("*.json")})
    return out


def _groups_in(p: Path) -> int:
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0
    return len(d.get("groups") or []) if isinstance(d, dict) and d.get("groups") is not None else 1


def list_profiles() -> list[dict]:
    return sorted(
        ({"name": n, "path": str(p), "groups": _groups_in(p),
          "modified": datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d %H:%M")}
         for n, p in _profile_files().items()),
        key=lambda x: x["name"].lower(),
    )


def load_profile(name: str) -> dict:
    """The saved JSON as it is ("job") and as a setup with its groups ("setup")."""
    p = _profile_files().get(name)
    if p is None:
        return {"ok": False, "error": f"No setup named {name}"}
    raw = json.loads(p.read_text(encoding="utf-8"))
    import workspace as W
    return {"ok": True, "job": raw, "setup": W.from_any(raw, name)}


def delete_profile(name: str) -> dict:
    for p in (profile_dir() / f"{name}.json", profile_dir() / "workspaces" / f"{name}.json"):
        if p.exists():
            p.unlink()
    return {"ok": True}


# ---- moving setups between machines -------------------------------------------
# One setup exports as its plain job JSON (so `engine.py --job` still runs it, with
# --folder supplying the files); several export as a bundle that can also carry
# workspaces. Import takes any of those, or a workspace file on its own.

BUNDLE_KIND = "colsift.bundle"
_SETUP_KEYS = {"columns", "source", "filters", "add_columns", "output", "analysis", "summaries"}


def export_profiles(names: list[str], path: str, workspaces: list[str] | None = None) -> dict:
    names = [n for n in names or [] if n]
    wsn = [n for n in workspaces or [] if n]
    if not names and not wsn:
        return {"ok": False, "error": "Nothing picked to export."}
    target = Path(path)
    if len(names) == 1 and not wsn:
        r = load_profile(names[0])
        if not r["ok"]:
            return r
        payload = {**r["job"], "_name": names[0]}
    else:
        payload = {"kind": BUNDLE_KIND, "version": 1, "exported": datetime.now().isoformat(timespec="seconds"),
                   "setups": {}, "workspaces": {}}
        for n in names:
            r = load_profile(n)
            if r["ok"]:
                payload["setups"][n] = r["job"]
        if wsn:
            import workspace as W
            for n in wsn:
                r = W.load(n)
                if r["ok"]:
                    payload["workspaces"][n] = r["workspace"]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return {"ok": True, "path": str(target), "setups": len(names), "workspaces": len(wsn)}


def _free_name(name: str, taken: set[str]) -> str:
    cand, i = name, 2
    while cand.lower() in taken:
        cand = f"{name} ({i})"
        i += 1
    taken.add(cand.lower())
    return cand


def import_profiles(path: str, overwrite: bool = False) -> dict:
    """Read a setup, a bundle or a workspace file into the profiles folder. A name
    already in use gets " (2)" unless overwrite is on."""
    p = Path(path)
    try:
        data = json.loads(p.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        return {"ok": False, "error": f"Could not read {p.name}: {exc}"}
    if not isinstance(data, dict):
        return {"ok": False, "error": f"{p.name} isn't a ColSift setup file."}
    import workspace as W
    setups: dict[str, dict] = {}
    spaces: dict[str, dict] = {}
    if data.get("kind") == BUNDLE_KIND:
        setups = {str(k): v for k, v in (data.get("setups") or {}).items() if isinstance(v, dict)}
        spaces = {str(k): v for k, v in (data.get("workspaces") or {}).items() if isinstance(v, dict)}
    elif data.get("kind") in (W.WS_KIND, W.SETUP_KIND) or data.get("groups") is not None:
        spaces = {str(data.get("_name") or data.get("name") or p.stem): data}
    elif _SETUP_KEYS & set(data):
        setups = {str(data.get("_name") or p.stem): data}
    else:
        return {"ok": False, "error": f"{p.name} isn't a ColSift setup, bundle or workspace."}
    # everything lands as a setup in the one list; a 2.0 workspace is a setup with groups
    taken = {x["name"].lower() for x in list_profiles()}
    done_s = []
    for name, job in list(setups.items()) + list(spaces.items()):
        job = {k: v for k, v in job.items() if k not in ("_name", "files")}
        nm = name if overwrite else _free_name(re.sub(r"[^A-Za-z0-9 _.()-]", "_", name).strip() or "setup", taken)
        done_s.append(save_profile(nm, job)["name"])
    return {"ok": True, "setups": done_s, "workspaces": []}


# --------------------------------------------------------------------------
# headless
# --------------------------------------------------------------------------

def _cli(argv: list[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser(prog="colsift", description="Extract columns from big extracts.")
    ap.add_argument("--job", help="job JSON file")
    ap.add_argument("--profile", help="saved profile name")
    ap.add_argument("--folder", help="input folder (overrides job files)")
    ap.add_argument("--pattern", default="", help="filename wildcard, e.g. TAX_*.xlsx")
    ap.add_argument("--out", help="output folder override")
    ap.add_argument("--count", action="store_true", help="count matches, write nothing")
    ap.add_argument("--workspace", help="saved workspace name — runs every group, step and report")
    ap.add_argument("--workspace-file", help="workspace JSON file")
    ap.add_argument("--recursive", action="store_true", help="with --folder: include subfolders")
    a = ap.parse_args(argv)

    if a.workspace or a.workspace_file:
        import workspace as W
        wargs = (["--workspace", a.workspace] if a.workspace else ["--file", a.workspace_file])
        wargs += (["--folder", a.folder] if a.folder else []) + (["--out", a.out] if a.out else [])
        wargs += ["--recursive"] if a.recursive else []
        return W._cli(wargs)

    if a.job:
        job = json.loads(Path(a.job).read_text(encoding="utf-8"))
    elif a.profile:
        r = load_profile(a.profile)
        if not r["ok"]:
            print(r["error"], file=sys.stderr)
            return 2
        job = r["job"]
    else:
        ap.error("need --job or --profile")

    if job.get("groups") is not None and not a.count:
        # a setup with groups: every group's ColSift work, the combine steps, one export
        import workspace as W
        ws = W.from_any(job, a.profile or "")
        if a.folder:
            # the folder replaces the files the setup was saved with: groups keep files of
            # the same name, rules re-sort the rest; a lone hand-picked group takes them all
            files = [f["path"] for f in list_folder(a.folder, a.recursive, pattern=a.pattern)["files"]]
            live = [g for g in ws["groups"] if g["enabled"]]
            if len(live) == 1 and (live[0]["match"].get("mode") or "manual") == "manual" and not live[0]["folders"]:
                live[0]["files"] = files
            else:
                ws = W.rebind(ws, files)["workspace"]
        if a.out:
            ws["output"]["folder"] = a.out
        res = W.run_setup(ws, on_progress=lambda p: print(f"  {p}", file=sys.stderr))
        print(json.dumps(res, indent=2, default=str))
        return 0 if res.get("ok") else 1
    if job.get("groups") is not None:        # --count on a setup: its first group
        import workspace as W
        ws = W.from_any(job)
        job = W.group_job(ws, ws["groups"][0])

    if a.folder:
        job["files"] = [f["path"] for f in list_folder(a.folder, a.recursive, pattern=a.pattern)["files"]]
        rule = job.get("match") or {}
        if not a.pattern and (rule.get("mode") or "manual") != "manual":
            import workspace as W        # the setup's own file rule picks its files
            job["files"] = [f for f in job["files"] if W.match_rule(
                f, rule, W._file_columns(f, job) if rule.get("mode") == "layout" else None, job)]
            print(f"{len(job['files'])} file(s) match the setup's rule ({rule.get('mode')}: {rule.get('value')})",
                  file=sys.stderr)
    if a.out:
        job.setdefault("output", {})["folder"] = a.out

    if a.count:
        print("filters:", describe_filters(job.get("filters")), file=sys.stderr)
        r = count_rows(job)
        print(json.dumps(r, indent=2))
        return 0

    res = run(job, on_progress=lambda p: print(f"  {p}", file=sys.stderr))
    print(json.dumps(res, indent=2))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))


# --------------------------------------------------------------------------
# peek every ticked file — layout check before a batch runs
# --------------------------------------------------------------------------

def peek_all(files: list[str], source: dict | None, rows: int = 5, reference: list[str] | None = None) -> dict:
    ref = [c for c in (reference or []) if c]
    out = []
    for f in files:
        p = _norm(f)
        item: dict[str, Any] = {"file": p.name, "path": str(p), "kind": "excel" if is_excel(p) else "text"}
        try:
            st = p.stat()
            item["size_h"] = human_size(st.st_size)
            src = Source.from_dict({**(source or {}), "path": str(p)}).resolved()
            names = _schema_names(src)
            pk = _peek_cached(str(p), src.encoding, src.sheet)
            top = (src.header_row if src.has_header else 0) + src.skip_after_header
            if is_excel(p):
                data = [list(r) for r in (pk.get("cells") or [])[top:top + rows]]
                cached = _cached_sheet(p, src.sheet)
                if cached is not None:
                    item["rows_est"] = max(0, pl.scan_parquet(cached).select(pl.len()).collect().item() - top)
                    item["rows_exact"] = True
                else:
                    est = pk.get("rows_est")
                    item["rows_est"] = None if est is None else max(0, est - top + (1 if src.has_header else 0) - 1)
                    item["rows_exact"] = False
            else:
                sep, lines = resolve_delim(src.delimiter), pk.get("lines") or []
                data = [next(_csv.reader([ln], delimiter=sep, quotechar=src.quote_char or '"')) if ln else []
                        for ln in lines[top:top + rows]]
                body = lines[top:]
                avg = sum(len(x) + 1 for x in body) / len(body) if body else 0
                item["rows_est"] = max(0, int(st.st_size / avg) - top) if avg else None
                item["rows_exact"] = False
                item["delimiter"] = src.delimiter
            item.update(ok=True, header_row=src.header_row if src.has_header else None, columns=names,
                        rows=[["" if v is None else str(v) for v in r] for r in data])
            if ref:
                have, want = set(names), set(ref)
                item["missing"] = [c for c in ref if c not in have]
                item["extra"] = [c for c in names if c not in want]
        except Exception as exc:  # noqa: BLE001
            item.update(ok=False, error=brief(exc))
        out.append(item)
    return {"ok": True, "files": out}
