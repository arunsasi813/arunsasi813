"""
ColSift — desktop shell.

    pip install pywebview polars fastexcel
    python app.py

Build a lean Windows exe with build.py (see nuitka-build.txt for the details).
"""

from __future__ import annotations

import faulthandler
import functools
import json
import os
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path


def _webview():
    """pywebview, imported when the window needs it — not at module level: every
    worker process imports this module again, and must not load the GUI with it."""
    import webview
    return webview

# Read-only bundle dir (ui.html travels with the exe); the writable dir is separate —
# under Nuitka onefile they are NOT the same place. engine.py owns the writable rule.
HERE = Path(__file__).resolve().parent
UI = HERE / "ui.html"

# pywebview walks every PUBLIC attribute of the js_api object to build its JS shim.
# A webview.Window hanging off `self` sends it into the native GUI objects, where the
# EdgeChromium backend dies comparing a .NET Rectangle. So Api holds no state at all —
# the window and the run flag live at module level.
_WINDOW: "webview.Window | None" = None
_BUSY = threading.Event()
_CANCEL = threading.Event()

# polars and the engine take a moment to import. The window opens first; the import
# runs beside it and the first call that needs the engine waits for it.
_MODS: dict = {}
_LOADED = threading.Event()


def _load_modules() -> None:
    try:
        import analysis as A
        import engine as E
        import formula as F
        import workspace as W
        _MODS.update(A=A, E=E, F=F, W=W)
    except Exception as exc:  # noqa: BLE001 — reported by the first call that needs it
        _MODS["error"] = exc
        traceback.print_exc()
    finally:
        _LOADED.set()


def _m():
    if not _LOADED.is_set():
        _LOADED.wait()
    if "error" in _MODS:
        raise RuntimeError(f"The engine could not start: {_MODS['error']}")
    return _MODS["E"], _MODS["A"], _MODS["F"], _MODS["W"]


def _win() -> "webview.Window | None":
    if _WINDOW is not None:
        return _WINDOW
    if "webview" not in sys.modules:
        return None
    wv = _webview()
    return wv.windows[0] if getattr(wv, "windows", None) else None


def _js(fn: str, payload) -> None:
    w = _win()
    if not w:
        return
    try:
        w.evaluate_js(f"window.{fn}({json.dumps(payload, default=str)})")
    except Exception:
        pass


def _brief(exc: Exception) -> str:
    try:
        return _m()[0].brief(exc)
    except Exception:  # noqa: BLE001
        return f"{type(exc).__name__}: {exc}"


def guard(fn):
    """Never let an exception cross the JS bridge as a stack trace."""
    @functools.wraps(fn)          # keeps the real signature for pywebview arg binding
    def wrapper(*a, **kw):
        try:
            return fn(*a, **kw)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return {"ok": False, "error": _brief(exc)}
    return wrapper


def _dialog(kind: str):
    """pywebview 5 moved the dialog constants into FileDialog; older ones keep the names."""
    wv = _webview()
    fd = getattr(wv, "FileDialog", None)
    if fd is not None:
        return getattr(fd, kind)
    return getattr(wv, f"{kind}_DIALOG")


def _first(res) -> str:
    if not res:
        return ""
    if isinstance(res, (list, tuple)):
        return str(res[0]) if res else ""
    return str(res)


def _background(label: str, work) -> dict:
    """Fire and forget — results land on window.onRunDone()."""
    if _BUSY.is_set():
        return {"ok": False, "error": "A run is already going."}
    _BUSY.set()
    _CANCEL.clear()

    def go():
        try:
            res = work()
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            res = {"ok": False, "error": _brief(exc)}
        finally:
            _BUSY.clear()
        _js("onRunDone", {**res, "kind": label})

    threading.Thread(target=go, daemon=True).start()
    return {"ok": True, "started": True}


# --------------------------------------------------------------------------
# heavy work runs in a worker process (worker.py)
# --------------------------------------------------------------------------
# A run, Count, Find or a dashboard over every file can need more memory than the
# machine has. In this process that ends the window; in a worker it ends the worker,
# and the window says so. Interactive reads (peek, preview, a dashboard on the
# preview) stay here — they are small — but take turns, so two big workbooks are
# never parsed at the same moment.

_HEAVY = threading.Lock()
_READ = threading.RLock()
_CHILD: dict = {"proc": None, "rss": 0, "peak": 0, "kind": ""}
CANCEL_GRACE = 20            # seconds a cancelled worker gets to stop by itself
_LOG: dict = {"path": None, "fh": None}


def _isolation() -> bool:
    return os.environ.get("COLSIFT_INPROCESS", "").lower() not in {"1", "true", "yes"}


def _crash_log() -> Path:
    """colsift.log — on local disk, the same folder engine.log_dir() picks. Worked out
    here without the engine: logging starts before polars has finished importing."""
    if _LOG["path"] is None:
        import tempfile
        local = os.environ.get("LOCALAPPDATA")
        cands = [Path(os.environ["COLSIFT_LOGS"]) if os.environ.get("COLSIFT_LOGS") else None,
                 Path(local) / "ColSift" / "logs" if local else None,
                 Path.home() / ".colsift" / "logs", Path(tempfile.gettempdir()) / "colsift-logs"]
        for d in filter(None, cands):
            try:
                d.mkdir(parents=True, exist_ok=True)
                with open(d / "colsift.log", "a", encoding="utf-8"):
                    pass
                _LOG["path"] = d / "colsift.log"
                break
            except OSError:
                continue
        else:
            _LOG["path"] = Path(tempfile.gettempdir()) / "colsift.log"
    return _LOG["path"]


def _log(text: str) -> None:
    try:
        with open(_crash_log(), "a", encoding="utf-8") as fh:
            fh.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} {text}\n")
    except OSError:
        pass


def _human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:,.0f} {unit}" if unit in ("B", "KB", "MB") else f"{n:,.1f} {unit}"
        n /= 1024
    return str(n)


_EXIT = {3221225477: "an access violation", 3221226505: "a fatal error in native code",
         3221225495: "no memory left", 3221225725: "a stack overflow", -9: "the system stopped it (memory)",
         -11: "a crash in native code", -6: "a fatal error in native code", 137: "the system stopped it (memory)"}


def _crash_text(code, peak: int) -> str:
    why = _EXIT.get(code if code is None or code < 2 ** 31 else code, None) if code is not None else None
    why = why or (f"exit code {code}" if code is not None else "no answer")
    used = f" after using {_human(peak)} of memory" if peak else ""
    return (f"The work stopped unexpectedly ({why}){used}. The window is fine and nothing else was lost. "
            "This is almost always memory running out: on the Output tab choose “One file at a time”, "
            "tick fewer files, or write CSV instead of Excel. Details are in " + str(_crash_log()))


def _sample_child(p) -> None:
    try:
        got = _m()[0].process_memory(p.pid) if p is not None and p.pid else None
    except Exception:  # noqa: BLE001
        got = None
    if got:
        _CHILD["rss"] = got[0]
        _CHILD["peak"] = max(_CHILD["peak"], got[1] or got[0], got[0])


class _NoWorker(Exception):
    pass


def _in_child(kind: str, payload: dict) -> dict:
    import multiprocessing as mp
    import queue

    import worker

    E = _m()[0]
    try:
        ctx = mp.get_context("spawn")
        q, ev = ctx.Queue(), ctx.Event()
        settings = {"cache": E.cache_on(), "crash_log": str(_crash_log()),
                    "env": {k: v for k, v in os.environ.items() if k.startswith("COLSIFT_")}}
        p = ctx.Process(target=worker.main, args=(kind, payload, q, ev, settings),
                        name=f"colsift-{kind}", daemon=True)
        p.start()
    except Exception as exc:  # noqa: BLE001 — a PC that won't start a second process
        raise _NoWorker(str(exc)) from exc
    _CHILD.update(proc=p, rss=0, peak=0, kind=kind)
    res, last, pending, asked = None, 0.0, None, None
    try:
        while True:
            if _CANCEL.is_set() and asked is None:
                ev.set()
                asked = time.monotonic()
            if asked is not None and time.monotonic() - asked > CANCEL_GRACE and p.is_alive():
                p.terminate()                      # it didn't reach a point where it checks
            try:
                typ, val = q.get(timeout=0.25)
            except queue.Empty:
                _sample_child(p)
                if pending is not None:
                    _js("onProgress", {**pending, "mem": _CHILD["rss"]})
                    pending, last = None, time.monotonic()
                if p.is_alive():
                    continue
                try:                               # it may have finished just now
                    typ, val = q.get(timeout=1.5)
                except queue.Empty:
                    break
            if typ == "done":
                res = val
                break
            if time.monotonic() - last >= 0.2:     # progress at most five times a second
                _js("onProgress", {**val, "mem": _CHILD["rss"]})
                pending, last = None, time.monotonic()
            else:
                pending = val
    finally:
        _sample_child(p)
        p.join(timeout=15)
        if p.is_alive():
            p.kill()
            p.join(timeout=5)
        peak, code = _CHILD["peak"], p.exitcode
        _CHILD.update(proc=None, rss=0, kind="")
    if res is None:
        if asked is not None:
            return {"ok": False, "cancelled": True, "error": "Cancelled — the work was stopped.", "peak_memory": peak}
        _log(f"worker {kind} died: exit code {code}, peak {_human(peak)}")
        return {"ok": False, "crashed": True, "error": _crash_text(code, peak), "peak_memory": peak}
    if isinstance(res, dict):
        res["peak_memory"] = peak
    return res


def _heavy(kind: str, payload: dict, here):
    """Run `kind` in a worker process; `here` is the same job in this process, used
    when isolation is off (COLSIFT_INPROCESS=1) or a second process can't start."""
    if not _HEAVY.acquire(blocking=False):
        return {"ok": False, "error": "Something heavy is already running — wait for it, or press Cancel."}
    try:
        _CANCEL.clear()
        if _isolation():
            try:
                return _in_child(kind, payload)
            except _NoWorker as exc:
                _log(f"worker could not start ({exc}) — running {kind} in the window's process")
        return here()
    finally:
        _HEAVY.release()


def _reading(fn):
    """Interactive reads take turns (see above)."""
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        with _READ:
            return fn(*a, **kw)
    return wrapper


def _install_logging() -> None:
    """Crashes leave a trace: Python tracebacks from any thread, and a native crash's
    stack via faulthandler, go to colsift.log in the log folder."""
    try:
        fh = open(_crash_log(), "a", buffering=1, encoding="utf-8")   # noqa: SIM115 — kept open for the session
    except OSError:
        return
    _LOG["fh"] = fh
    fh.write(f"\n=== ColSift started {datetime.now():%Y-%m-%d %H:%M:%S}, pid {os.getpid()} ===\n")
    faulthandler.enable(fh, all_threads=True)
    if sys.stderr is None or getattr(sys, "frozen", False) or "__compiled__" in globals():
        sys.stderr = fh                      # a windowed exe has no console: tracebacks land in the log

    def hook(et, ev, tb):
        traceback.print_exception(et, ev, tb, file=fh)

    sys.excepthook = hook
    threading.excepthook = lambda a: traceback.print_exception(a.exc_type, a.exc_value, a.exc_traceback, file=fh)


class Api:
    """Bridge surface. Methods and nothing else — no instance attributes."""

    # -- shell ------------------------------------------------------------
    @guard
    def pick_folder(self, start: str = "") -> dict:
        w = _win()
        if not w:
            return {"ok": False, "error": "Window is not ready yet."}
        res = w.create_file_dialog(_dialog("FOLDER"), directory=start or str(Path.home()))
        return {"ok": True, "folder": _first(res)}

    @guard
    def save_dialog(self, p: dict) -> dict:
        """Where to save a file: {filename, folder, types: ["PDF (*.pdf)"]}."""
        w = _win()
        if not w:
            return {"ok": False, "error": "Window is not ready yet."}
        res = w.create_file_dialog(_dialog("SAVE"), directory=p.get("folder") or str(Path.home()),
                                   save_filename=p.get("filename") or "",
                                   file_types=tuple(p.get("types") or ("All files (*.*)",)))
        return {"ok": True, "path": _first(res)}

    @guard
    def open_dialog(self, p: dict) -> dict:
        w = _win()
        if not w:
            return {"ok": False, "error": "Window is not ready yet."}
        res = w.create_file_dialog(_dialog("OPEN"), directory=p.get("folder") or str(Path.home()),
                                   allow_multiple=bool(p.get("multiple")),
                                   file_types=tuple(p.get("types") or ("All files (*.*)",)))
        paths = [str(x) for x in (res or [])] if isinstance(res, (list, tuple)) else ([str(res)] if res else [])
        return {"ok": True, "paths": paths}

    @guard
    def open_path(self, path: str) -> dict:
        p = Path(path)
        target = str(p if p.is_dir() else p.parent)
        if sys.platform.startswith("win"):
            os.startfile(target)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", target])
        else:
            subprocess.Popen(["xdg-open", target])
        return {"ok": True}

    @guard
    def open_file(self, path: str) -> dict:
        """Open a written file itself (a PDF, a workbook) in its default program."""
        if sys.platform.startswith("win"):
            os.startfile(path)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
        return {"ok": True}

    @guard
    def meta(self) -> dict:
        E, A, F, W = _m()
        try:
            import fastexcel  # noqa: F401
            excel_engine = "calamine (fast)"
        except ImportError:
            excel_engine = "openpyxl (slower — pip install fastexcel)"
        return {
            "ok": True,
            "ops": [{"id": o[0], "label": o[1], "needs_value": o[2], "group": o[3]} for o in E.FILTER_OPS],
            "kinds": [{"id": k[0], "label": k[1], "group": k[2]} for k in E.ADD_KINDS],
            "column_compare": sorted(E.COLUMN_COMPARE_OPS),
            "dup_keep": [{"id": i, "label": l} for i, l in E.DUP_KEEP],
            "analysis": A.meta(),
            "workspace": W.meta(),
            "delims": E.DELIMS,
            "excel_engine": excel_engine,
            "profiles_dir": str(E.profile_dir()),
            "log": str(_crash_log()),
            "isolated": _isolation(),
            "app_dir": str(E.app_dir()),
            "frozen": E.frozen(),
            "home": str(Path.home()),
        }

    # -- discovery --------------------------------------------------------
    @guard
    def list_files(self, p: dict) -> dict:
        return _m()[0].list_folder(p.get("folder", ""), bool(p.get("recursive")), p.get("pattern", ""))

    @guard
    def list_folders(self, p: dict) -> dict:
        """Several folders at once — the files pane groups them by folder."""
        return _m()[3].list_folders(p.get("folders") or [], p.get("pattern") or "")

    @guard
    @_reading
    def sheets(self, path: str) -> dict:
        return {"ok": True, "sheets": _m()[0].sheet_names(path)}

    @guard
    @_reading
    def peek(self, p: dict) -> dict:
        E = _m()[0]
        r = E.raw_peek(p.get("path", ""), int(p.get("rows") or 40),
                       p.get("encoding") or "utf-8", p.get("sheet") or None)
        if r.get("ok"):
            r["suggested_header"] = E.suggest_header_row(
                r["lines"],
                E.resolve_delim(r["delimiter"]) if r["kind"] == "text" else None,
            )
        return r

    @guard
    @_reading
    def columns(self, source: dict) -> dict:
        return _m()[0].columns_of(source)

    # -- pipeline ---------------------------------------------------------
    @guard
    @_reading
    def preview(self, p: dict) -> dict:
        return _m()[0].preview(p.get("job") or {}, int(p.get("rows") or 200))

    @guard
    def count(self, job: dict) -> dict:
        return _heavy("count", {"job": job},
                      lambda: _m()[0].count_rows(job, on_progress=lambda x: _js("onProgress", x)))

    @guard
    def find(self, p: dict) -> dict:
        job, params = p.get("job") or {}, p.get("params") or {}
        return _heavy("find", {"job": job, "params": params},
                      lambda: _m()[0].find(job, params, on_progress=lambda x: _js("onProgress", x)))

    @guard
    def describe_filters(self, spec: dict) -> dict:
        return {"ok": True, "text": _m()[0].describe_filters(spec)}

    @guard
    def cancel(self) -> dict:
        """Stops a run between files or chunks; whatever it had written is removed."""
        _CANCEL.set()
        return {"ok": True}

    @guard
    @_reading
    def peek_all(self, p: dict) -> dict:
        return _m()[0].peek_all(p.get("files") or [], p.get("source") or {}, int(p.get("rows") or 4),
                                p.get("reference") or [])

    @guard
    def analyse(self, p: dict) -> dict:
        """The Analysis tab. scope 'active' is the current file (instant on a peek
        sample); 'all' runs the whole batch, like Count."""
        job, scope = p.get("job") or {}, p.get("scope") or "active"
        here = lambda: _m()[0].analyse(job, scope, on_progress=lambda x: _js("onProgress", x))  # noqa: E731
        if scope == "all":
            return _heavy("analyse", {"job": job}, here)
        with _READ:
            return here()

    @guard
    def drill(self, p: dict) -> dict:
        """Rows behind a clicked bar, slice or pivot cell."""
        job, scope, filters, limit = p.get("job") or {}, p.get("scope") or "active", p.get("filters") or [], \
            int(p.get("limit") or 500)
        here = lambda: _m()[0].drill(job, scope, filters, limit)  # noqa: E731
        if scope == "all":
            return _heavy("drill", {"job": job, "filters": filters, "limit": limit}, here)
        with _READ:
            return here()

    @guard
    def export_analysis(self, p: dict) -> dict:
        """Write what the Analysis tab shows — dashboard, summaries or both — as PDF,
        Excel or CSV, straight from the computed result (no recomputation)."""
        E, A, _F, _W = _m()
        import pdfout

        res = p.get("result") or {}
        parts = [x for x in (p.get("parts") or ["dashboard", "summaries"]) if x in ("dashboard", "summaries")]
        fmt = (p.get("format") or "pdf").lower()
        path = p.get("path") or ""
        if not path:
            ext = {"pdf": "pdf", "xlsx": "xlsx", "csv": "csv"}[fmt]
            d = self.save_dialog({"filename": f"{p.get('name') or 'analysis'}.{ext}", "folder": p.get("folder") or "",
                                  "types": [{"pdf": "PDF (*.pdf)", "xlsx": "Excel workbook (*.xlsx)",
                                             "csv": "CSV files (*.csv)"}[fmt]]})
            path = d.get("path") or ""
            if not path:
                return {"ok": False, "cancelled": True, "error": "Not saved."}
        target = Path(path)
        if target.suffix.lower() != f".{fmt}":
            target = target.with_suffix(f".{fmt}")
        target.parent.mkdir(parents=True, exist_ok=True)
        if fmt == "pdf":
            pdfout.analysis_pdf(target, res, parts, title=p.get("title") or "ColSift analysis",
                                subtitle=p.get("subtitle") or "", size=p.get("size") or "A4",
                                landscape=(p.get("orientation") or "landscape") == "landscape")
            return {"ok": True, "written": [str(target)]}
        spec = {"analysis": {"export": "dashboard" in parts, "sheet_name": "Dashboard"},
                "summaries": {"export": "summaries" in parts}}
        grids = E.analysis_grids(res, spec)
        if not grids:
            return {"ok": False, "error": "Nothing to export — work the analysis out first."}
        if fmt == "xlsx":
            used: set[str] = set()
            for g in grids:
                g["name"] = A.sheet_name(g["name"], used)
            E.write_xlsx_book(target, grids, {"header": True, "header_style": "bold"})
            return {"ok": True, "written": [str(target)]}
        written = []
        for g in grids:
            pth = target.with_name(f"{target.stem}_{E._safe_name(g['name'], 60)}.csv")
            E._write_grid_csv(g["grid"], pth, {"delimiter": "comma", "encoding": "utf-8-sig"})
            written.append(str(pth))
        return {"ok": True, "written": written}

    @guard
    def formula_check(self, p: dict) -> dict:
        return _m()[2].check(p.get("text") or "", p.get("columns") or [])

    @guard
    def formula_reference(self) -> dict:
        return {"ok": True, **_m()[2].reference()}

    # -- workbook cache -----------------------------------------------------
    @guard
    def cache_info(self) -> dict:
        return _m()[0].cache_info()

    @guard
    def cache_clear(self) -> dict:
        return _m()[0].cache_clear()

    @guard
    def set_cache(self, on: bool) -> dict:
        E = _m()[0]
        E.set_cache(bool(on))
        return E.cache_info()

    @guard
    def run(self, job: dict) -> dict:
        """One job the 1.x way. The UI now calls run_setup; kept for scripts."""
        E = _m()[0]
        return _background("setup", lambda: _heavy("run", {"job": job}, lambda: E.run(
            job, on_progress=lambda x: _js("onProgress", x), cancel=_CANCEL)))

    @guard
    def run_setup(self, setup: dict) -> dict:
        """The Run button: every group's ColSift work, then the combine steps, then one
        export. A one-group setup is the classic extract. Results land on onRunDone()."""
        W = _m()[3]
        return _background("setup", lambda: _heavy("run_setup", {"setup": setup}, lambda: W.run_setup(
            setup, on_progress=lambda x: _js("onProgress", x), cancel=_CANCEL)))

    @guard
    def ws_dashboards(self, p: dict) -> dict:
        """Run dashboards: every dashboard of the setup (or those in `only`) over every
        file, in a worker. Nothing is written."""
        ws, only = p.get("workspace") or {}, p.get("only")
        return _heavy("dashboards", {"workspace": ws, "only": only}, lambda: _m()[3].run_dashboards(
            ws, "all", on_progress=lambda x: _js("onProgress", x), cancel=_CANCEL, only=only))

    @guard
    def memory(self) -> dict:
        """The status bar's meter: this window, the worker if one is running, the machine."""
        E = _m()[0]
        me, mach = E.process_memory() or (0, 0), E.system_memory() or (0, 0)
        live = _CHILD["proc"] is not None
        return {"ok": True, "app": me[0], "app_peak": me[1], "worker": _CHILD["rss"] if live else 0,
                "worker_kind": _CHILD["kind"] if live else "", "worker_peak": _CHILD["peak"],
                "total": mach[0], "available": mach[1], "log": str(_crash_log())}

    # -- profiles ---------------------------------------------------------
    @guard
    def save_profile(self, p: dict) -> dict:
        return _m()[0].save_profile(p.get("name", ""), p.get("job") or {})

    @guard
    def profiles(self) -> dict:
        return {"ok": True, "profiles": _m()[0].list_profiles()}

    @guard
    def load_profile(self, name: str) -> dict:
        return _m()[0].load_profile(name)

    @guard
    def delete_profile(self, name: str) -> dict:
        return _m()[0].delete_profile(name)

    @guard
    def export_profile(self, p: dict) -> dict:
        """One setup (or, with names / workspaces, a bundle) to a file you pick."""
        E = _m()[0]
        names = p.get("names") or ([p["name"]] if p.get("name") else [])
        spaces = p.get("workspaces") or []
        path = p.get("path") or ""
        if not path:
            one = len(names) == 1 and not spaces
            only_ws = len(spaces) == 1 and not names
            d = self.save_dialog({"filename": f"{names[0] if one else spaces[0] if only_ws else 'colsift-setups'}.json",
                                  "types": ["ColSift setup (*.json)"]})
            path = d.get("path") or ""
            if not path:
                return {"ok": False, "cancelled": True, "error": "Not exported."}
        if not path.lower().endswith(".json"):
            path += ".json"
        return E.export_profiles(names, path, spaces)

    @guard
    def import_profiles(self, p: dict) -> dict:
        E = _m()[0]
        paths = p.get("paths") or []
        if not paths:
            d = self.open_dialog({"multiple": True, "types": ["ColSift setup (*.json)", "All files (*.*)"]})
            paths = d.get("paths") or []
            if not paths:
                return {"ok": False, "cancelled": True, "error": "Nothing imported."}
        setups, spaces, errors = [], [], []
        for path in paths:
            r = E.import_profiles(path, bool(p.get("overwrite")))
            if r.get("ok"):
                setups += r["setups"]
                spaces += r["workspaces"]
            else:
                errors.append(r.get("error"))
        return {"ok": bool(setups or spaces) or not errors, "setups": setups, "workspaces": spaces,
                "errors": errors, "error": "; ".join(e for e in errors if e) or None}

    # -- workspaces ---------------------------------------------------------
    @guard
    def ws_list(self) -> dict:
        return {"ok": True, "workspaces": _m()[3].list_saved()}

    @guard
    def ws_save(self, p: dict) -> dict:
        return _m()[3].save(p.get("name") or "", p.get("workspace") or {})

    @guard
    def ws_load(self, name: str) -> dict:
        return _m()[3].load(name)

    @guard
    def ws_delete(self, name: str) -> dict:
        return _m()[3].delete(name)

    @guard
    def ws_autogroup(self, p: dict) -> dict:
        return _m()[3].auto_group(p.get("workspace") or {}, p.get("files") or [], p.get("keep_manual", True))

    @guard
    def ws_rebind(self, p: dict) -> dict:
        """Fit a setup's groups to the files listed now (see workspace.rebind)."""
        return _m()[3].rebind(p.get("workspace") or {}, p.get("files") or [], p.get("saved") or {})

    @guard
    @_reading
    def ws_schema(self, ws: dict) -> dict:
        return _m()[3].schema(ws)

    @guard
    @_reading
    def ws_preview(self, p: dict) -> dict:
        return _m()[3].preview(p.get("workspace") or {}, p.get("table") or "", int(p.get("rows") or 200),
                               bool(p.get("related")))

    @guard
    def ws_analyse(self, p: dict) -> dict:
        ws, rep, scope = p.get("workspace") or {}, p.get("report") or {}, p.get("scope") or "preview"
        here = lambda: _m()[3].analyse(ws, rep, scope, on_progress=lambda x: _js("onProgress", x),  # noqa: E731
                                       cancel=_CANCEL)
        if scope == "all":
            return _heavy("ws_analyse", {"workspace": ws, "report": rep}, here)
        with _READ:
            return here()

    @guard
    def ws_drill(self, p: dict) -> dict:
        ws, rep, scope = p.get("workspace") or {}, p.get("report") or {}, p.get("scope") or "preview"
        filters, limit = p.get("filters") or [], int(p.get("limit") or 500)
        here = lambda: _m()[3].drill(ws, rep, scope, filters, limit)  # noqa: E731
        if scope == "all":
            return _heavy("ws_drill", {"workspace": ws, "report": rep, "filters": filters, "limit": limit}, here)
        with _READ:
            return here()

    @guard
    @_reading
    def ws_check_relationships(self, ws: dict) -> dict:
        return _m()[3].check_relationships(ws)

    @guard
    @_reading
    def ws_suggest_relationships(self, ws: dict) -> dict:
        return _m()[3].suggest_relationships(ws)

    @guard
    def ws_run(self, ws: dict) -> dict:
        W = _m()[3]
        return _background("workspace", lambda: _heavy("run_setup", {"setup": ws}, lambda: W.run_setup(
            ws, on_progress=lambda x: _js("onProgress", x), cancel=_CANCEL)))


def selftest(out: str) -> int:
    """`ColSift.exe --selftest result.json`: checks a build without opening a window —
    the worker process starts from the exe, does real work, reports progress and its
    memory, and a worker that dies leaves this process standing. Writes what it saw as
    JSON; exit code 0 when all of it held."""
    import tempfile

    _load_modules()
    res: dict = {"pid": os.getpid(), "frozen": bool(getattr(sys, "frozen", False) or "__compiled__" in globals())}
    seen: list = []
    global _js
    keep, _js = _js, (lambda fn, payload: seen.append(fn))
    try:
        res["worker"] = _heavy("_selftest", {"sleep": 0.5, "echo": "hello"}, lambda: {"ok": False, "in_process": True})
        res["progress_events"] = seen.count("onProgress")
        res["crash"] = _heavy("_selftest", {"exit": 3}, lambda: {"ok": False, "in_process": True})
        d = Path(tempfile.mkdtemp(prefix="colsift_selftest_"))
        rows = ["DOC_NO,TAX_CODE,AMOUNT"] + [f"D{i:05d},{'YQ' if i % 3 else 'YR'},{i}.50" for i in range(5000)]
        (d / "t.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
        job = {"files": [str(d / "t.csv")], "columns": [{"name": "DOC_NO", "include": True}],
               "filters": {"type": "group", "mode": "and", "children": [
                   {"type": "rule", "column": "TAX_CODE", "op": "equals", "value": "YR"}]},
               "output": {"folder": str(d / "out"), "format": "xlsx"}}
        res["count"] = Api().count(job)
        res["run"] = _heavy("run_setup", {"setup": {"groups": [{"name": "T", "files": job["files"], "setup": job}],
                                                    "output": job["output"]}}, lambda: {"ok": False, "in_process": True})
        res["memory"] = Api().memory()
    finally:
        _js = keep
    w, c, n, r, m = res["worker"], res["crash"], res["count"], res["run"], res["memory"]
    checks = {
        "worker ran in its own process": bool(w.get("ok")) and w.get("pid") not in (None, os.getpid()),
        "worker reported progress": res["progress_events"] > 0,
        "worker memory measured": (w.get("peak_memory") or 0) > 0,
        "a dying worker is reported, not fatal": bool(c.get("crashed")) and not c.get("ok"),
        "count in the worker": n.get("total") == 1667,
        "run in the worker wrote a workbook": bool(r.get("ok")) and any(str(p).endswith(".xlsx") for p in r.get("written") or []),
        "memory meter reads this process and the machine": (m.get("app") or 0) > 0 and (m.get("total") or 0) > 0,
    }
    res["checks"] = checks
    Path(out).write_text(json.dumps(res, indent=2, default=str), encoding="utf-8")
    return 0 if all(checks.values()) else 1


def main() -> None:
    global _WINDOW
    # First reads of several workbooks run in worker processes (see engine.prepare).
    # Harmless when not frozen; required for some frozen layouts. It has to come
    # before anything else, the import thread included.
    import multiprocessing
    multiprocessing.freeze_support()
    _install_logging()
    if "--selftest" in sys.argv:
        i = sys.argv.index("--selftest")
        raise SystemExit(selftest(sys.argv[i + 1] if len(sys.argv) > i + 1 else "colsift-selftest.json"))
    if not UI.exists():
        print(f"ui.html missing next to app.py (looked in {HERE})", file=sys.stderr)
        raise SystemExit(1)
    threading.Thread(target=_load_modules, daemon=True).start()
    webview = _webview()
    _WINDOW = webview.create_window(
        "ColSift — column extractor",
        str(UI),
        js_api=Api(),
        width=1440,
        height=900,
        min_size=(1040, 660),
        background_color="#172026",
    )
    webview.start(debug=bool(os.environ.get("COLSIFT_DEBUG")))


if __name__ == "__main__":
    main()
