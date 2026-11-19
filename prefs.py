"""Preferences: how ColSift uses this PC — memory, threads, the memory guard, the cache,
autosave. Kept beside the setups (profiles\\app\\settings.json), read by the window, the
worker process and scheduled runs alike.

The performance profile sizes the pieces big jobs are cut into — blocks of a big text
file parsed at once, keys lined up at once by Compare and by duplicates, cells written
to a workbook at once. Smaller pieces: less memory, a little slower. "auto" picks from
the PC's memory.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

PROFILES = {
    #             blocks at once  Compare cells  duplicate keys  workbook cells
    "low":      {"TEXT_INFLIGHT": 1, "CMP_BUCKET_CELLS": 900_000, "DEDUPE_BUCKET_ROWS": 250_000, "XLSX_CHUNK_CELLS": 600_000},
    "balanced": {"TEXT_INFLIGHT": 2, "CMP_BUCKET_CELLS": 1_800_000, "DEDUPE_BUCKET_ROWS": 500_000, "XLSX_CHUNK_CELLS": 1_200_000},
    "fast":     {"TEXT_INFLIGHT": 3, "CMP_BUCKET_CELLS": 3_600_000, "DEDUPE_BUCKET_ROWS": 1_000_000, "XLSX_CHUNK_CELLS": 2_400_000},
}
LABELS = {"auto": "Automatic", "low": "Low memory", "balanced": "Balanced", "fast": "Fast"}
DEFAULTS = {"performance": "auto", "threads": 0, "memory_guard": True, "cache_gb": 10.0, "autosave": True}
GIB = 1024 ** 3


def path() -> Path:
    import engine as E
    return E.profile_dir() / "app" / "settings.json"


def load() -> dict:
    try:
        got = json.loads(path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        got = {}
    return clean({**DEFAULTS, **(got if isinstance(got, dict) else {})})


def clean(s: dict) -> dict:
    out = dict(DEFAULTS)
    perf = str(s.get("performance") or "auto")
    out["performance"] = perf if perf in ("auto", *PROFILES) else "auto"
    try:
        out["threads"] = max(0, min(int(s.get("threads") or 0), os.cpu_count() or 64))
    except (TypeError, ValueError):
        out["threads"] = 0
    out["memory_guard"] = s.get("memory_guard", True) is not False
    out["autosave"] = s.get("autosave", True) is not False
    try:
        out["cache_gb"] = max(0.5, min(float(s.get("cache_gb") or DEFAULTS["cache_gb"]), 1000.0))
    except (TypeError, ValueError):
        out["cache_gb"] = DEFAULTS["cache_gb"]
    return out


def save(s: dict) -> dict:
    s = clean({**load(), **(s or {})})
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, indent=1), encoding="utf-8")
    os.replace(tmp, p)
    apply(s)
    return {"ok": True, "settings": s, "profile": profile(s)}


def profile(s: dict | None = None) -> str:
    """The profile in force: the one chosen, or for "auto" the one this PC's memory suits."""
    s = s or load()
    if s["performance"] in PROFILES:
        return s["performance"]
    import engine as E
    total = (E.system_memory() or (16 * GIB, 0))[0] or 16 * GIB
    return "low" if total < 7 * GIB else "balanced" if total < 15 * GIB else "fast"


def apply(s: dict | None = None) -> str:
    """Set the engine's knobs from the preferences; returns the profile used."""
    import datamgr as D
    import engine as E
    s = s or load()
    prof = profile(s)
    for k, v in PROFILES[prof].items():
        setattr(D if hasattr(D, k) and not hasattr(E, k) else E, k, v)
    if not os.environ.get("COLSIFT_CACHE_GB"):
        E.CACHE_CAP_GB = float(s["cache_gb"])
    return prof


def worker_env(s: dict | None = None) -> dict:
    """Variables a worker process needs before polars loads."""
    s = s or load()
    return {"POLARS_MAX_THREADS": str(s["threads"])} if s["threads"] else {}


# ---- the memory guard ---------------------------------------------------------------
GUARD_FLOOR = 300 * 1024 ** 2       # free memory below which the guard acts...
GUARD_SHARE = 0.04                   # ...or below this share of the PC's memory, whichever is more
GUARD_SECONDS = 2.0                  # for this long — a brief dip is not a reason to stop


def short_of_memory(total: int, available: int) -> bool:
    return bool(total) and available < max(GUARD_FLOOR, GUARD_SHARE * total)


# ---- autosave of the open setup ------------------------------------------------------
def autosave_path() -> Path:
    import engine as E
    return E.profile_dir() / "app" / "autosave.json"


def autosave_put(p: dict) -> dict:
    from datetime import datetime
    a = autosave_path()
    a.parent.mkdir(parents=True, exist_ok=True)
    tmp = a.with_suffix(".tmp")
    tmp.write_text(json.dumps({"time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "name": str(p.get("name") or ""),
                               "saved": bool(p.get("saved")), "setup": p.get("setup") or {}}), encoding="utf-8")
    os.replace(tmp, a)
    return {"ok": True}


def autosave_get() -> dict:
    try:
        got = json.loads(autosave_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"ok": True, "found": False}
    return {"ok": True, "found": True, **got}


def autosave_clear() -> dict:
    try:
        autosave_path().unlink()
    except OSError:
        pass
    return {"ok": True}
