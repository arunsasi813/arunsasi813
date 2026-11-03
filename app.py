"""
ColSift — desktop shell.

    pip install pywebview polars fastexcel
    python app.py

Build a lean Windows exe with build.py (see nuitka-build.txt for the details).
"""

from __future__ import annotations

import functools
import json
import os
import subprocess
import sys
import threading
import traceback
from pathlib import Path

import webview

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
    return webview.windows[0] if getattr(webview, "windows", None) else None


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
    fd = getattr(webview, "FileDialog", None)
    if fd is not None:
        return getattr(fd, kind)
    return getattr(webview, f"{kind}_DIALOG")


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
            "analysis": A.meta(),
            "workspace": W.meta(),
            "delims": E.DELIMS,
            "excel_engine": excel_engine,
            "profiles_dir": str(E.profile_dir()),
            "app_dir": str(E.app_dir()),
            "frozen": E.frozen(),
            "home": str(Path.home()),
        }

    # -- discovery --------------------------------------------------------
    @guard
    def list_files(self, p: dict) -> dict:
        return _m()[0].list_folder(p.get("folder", ""), bool(p.get("recursive")), p.get("pattern", ""))

    @guard
    def sheets(self, path: str) -> dict:
        return {"ok": True, "sheets": _m()[0].sheet_names(path)}

    @guard
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
    def columns(self, source: dict) -> dict:
        return _m()[0].columns_of(source)

    # -- pipeline ---------------------------------------------------------
    @guard
    def preview(self, p: dict) -> dict:
        return _m()[0].preview(p.get("job") or {}, int(p.get("rows") or 200))

    @guard
    def count(self, job: dict) -> dict:
        return _m()[0].count_rows(job, on_progress=lambda x: _js("onProgress", x))

    @guard
    def find(self, p: dict) -> dict:
        return _m()[0].find(p.get("job") or {}, p.get("params") or {},
                            on_progress=lambda x: _js("onProgress", x))

    @guard
    def describe_filters(self, spec: dict) -> dict:
        return {"ok": True, "text": _m()[0].describe_filters(spec)}

    @guard
    def cancel(self) -> dict:
        """Stops a run between files or chunks; whatever it had written is removed."""
        _CANCEL.set()
        return {"ok": True}

    @guard
    def peek_all(self, p: dict) -> dict:
        return _m()[0].peek_all(p.get("files") or [], p.get("source") or {}, int(p.get("rows") or 4),
                                p.get("reference") or [])

    @guard
    def analyse(self, p: dict) -> dict:
        """The Analysis tab. scope 'active' is the current file (instant on a peek
        sample); 'all' runs the whole batch, like Count."""
        _CANCEL.clear()
        return _m()[0].analyse(p.get("job") or {}, p.get("scope") or "active",
                               on_progress=lambda x: _js("onProgress", x))

    @guard
    def drill(self, p: dict) -> dict:
        """Rows behind a clicked bar, slice or pivot cell."""
        return _m()[0].drill(p.get("job") or {}, p.get("scope") or "active", p.get("filters") or [],
                             int(p.get("limit") or 500), on_progress=lambda x: _js("onProgress", x))

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
        return _background("setup", lambda: E.run(job, on_progress=lambda x: _js("onProgress", x), cancel=_CANCEL))

    @guard
    def run_setup(self, setup: dict) -> dict:
        """The Run button: every group's ColSift work, then the combine steps, then one
        export. A one-group setup is the classic extract. Results land on onRunDone()."""
        W = _m()[3]
        return _background("setup", lambda: W.run_setup(setup, on_progress=lambda x: _js("onProgress", x),
                                                        cancel=_CANCEL))

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
    def ws_schema(self, ws: dict) -> dict:
        return _m()[3].schema(ws)

    @guard
    def ws_preview(self, p: dict) -> dict:
        return _m()[3].preview(p.get("workspace") or {}, p.get("table") or "", int(p.get("rows") or 200),
                               bool(p.get("related")))

    @guard
    def ws_analyse(self, p: dict) -> dict:
        _CANCEL.clear()
        return _m()[3].analyse(p.get("workspace") or {}, p.get("report") or {}, p.get("scope") or "preview",
                               on_progress=lambda x: _js("onProgress", x), cancel=_CANCEL)

    @guard
    def ws_drill(self, p: dict) -> dict:
        return _m()[3].drill(p.get("workspace") or {}, p.get("report") or {}, p.get("scope") or "preview",
                             p.get("filters") or [], int(p.get("limit") or 500))

    @guard
    def ws_check_relationships(self, ws: dict) -> dict:
        return _m()[3].check_relationships(ws)

    @guard
    def ws_suggest_relationships(self, ws: dict) -> dict:
        return _m()[3].suggest_relationships(ws)

    @guard
    def ws_run(self, ws: dict) -> dict:
        W = _m()[3]
        return _background("workspace", lambda: W.run(ws, on_progress=lambda x: _js("onProgress", x),
                                                      cancel=_CANCEL))


def main() -> None:
    global _WINDOW
    # First reads of several workbooks run in worker processes (see engine.prepare).
    # Harmless when not frozen; required for some frozen layouts. It has to come
    # before anything else, the import thread included.
    import multiprocessing
    multiprocessing.freeze_support()
    if not UI.exists():
        print(f"ui.html missing next to app.py (looked in {HERE})", file=sys.stderr)
        raise SystemExit(1)
    threading.Thread(target=_load_modules, daemon=True).start()
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
