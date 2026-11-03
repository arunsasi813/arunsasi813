"""Heavy work in a process of its own.

A run, a count, Find, or a dashboard over every file can need a lot of memory: a big
workbook is parsed whole, a join is built in memory, a pivot holds its groups. When
that happens inside the window's own process, running out of memory — or a crash in
native code (polars, calamine) — takes the whole window down with it, and with it
whatever was not saved.

So app.py hands these jobs to a child process started here. The child reports
progress and its result through a queue; if it dies, the window is still standing
and says what happened. Its memory is handed back to the system the moment it ends,
so the window stays small between runs.

Only module-level functions and plain data cross the process boundary.
"""

from __future__ import annotations

import faulthandler
import os
import sys
import traceback


def _jobs():
    import engine as E
    import workspace as W

    return {
        "run_setup": lambda p, prog, cancel: W.run_setup(p["setup"], prog, cancel),
        "run": lambda p, prog, cancel: E.run(p["job"], prog, cancel),
        "count": lambda p, prog, cancel: E.count_rows(p["job"], prog),
        "find": lambda p, prog, cancel: E.find(p["job"], p.get("params") or {}, prog),
        "analyse": lambda p, prog, cancel: E.analyse(p["job"], "all", prog),
        "drill": lambda p, prog, cancel: E.drill(p["job"], "all", p.get("filters") or [], int(p.get("limit") or 500)),
        "ws_analyse": lambda p, prog, cancel: W.analyse(p["workspace"], p["report"], "all", prog, cancel),
        "ws_drill": lambda p, prog, cancel: W.drill(p["workspace"], p["report"], "all", p.get("filters") or [],
                                                    int(p.get("limit") or 500)),
        "dashboards": lambda p, prog, cancel: W.run_dashboards(p["workspace"], "all", prog, cancel, p.get("only")),
        "_selftest": _selftest,
    }


def _selftest(p: dict, prog, cancel) -> dict:
    """Exercises the plumbing: progress, cancel, and a process that dies."""
    import time

    import engine as E

    if p.get("exit") is not None:
        os._exit(int(p["exit"]))
    for i in range(int(float(p.get("sleep") or 0) * 10)):
        if cancel is not None and cancel.is_set():
            raise E.Cancelled()
        prog({"stage": "test", "i": i})
        time.sleep(0.1)
    if p.get("hang"):
        time.sleep(float(p["hang"]))           # ignores cancel, like a long native call
    return {"ok": True, "pid": os.getpid(), "echo": p.get("echo")}


KINDS = ("run_setup", "run", "count", "find", "analyse", "drill", "ws_analyse", "ws_drill", "dashboards")


def main(kind: str, payload: dict, q, cancel, settings: dict) -> None:
    """The child's entry point. Puts ("progress", dict) any number of times, then
    exactly one ("done", result)."""
    log = settings.get("crash_log")
    if log:
        try:
            fh = open(log, "a", buffering=1, encoding="utf-8")        # noqa: SIM115 — lives as long as the process
            fh.write(f"\n--- worker {kind}, pid {os.getpid()}\n")
            faulthandler.enable(fh, all_threads=True)
            if sys.stderr is None:
                sys.stderr = fh
        except OSError:
            pass
    os.environ.update({k: str(v) for k, v in (settings.get("env") or {}).items()})
    import engine as E

    if settings.get("cache") is False:
        E.set_cache(False)

    def progress(x: dict) -> None:
        try:
            q.put(("progress", x))
        except Exception:  # noqa: BLE001 — progress is best effort
            pass

    try:
        res = _jobs()[kind](payload, progress, cancel)
    except E.Cancelled:
        res = {"ok": False, "cancelled": True, "error": "Cancelled."}
    except MemoryError:
        res = {"ok": False, "error": "Out of memory — try “One file at a time” on the Output tab, or fewer files."}
    except BaseException as exc:  # noqa: BLE001
        traceback.print_exc()
        res = {"ok": False, "error": E.brief(exc) if isinstance(exc, Exception) else repr(exc)}
    q.put(("done", res))
