"""The window's bridge: heavy work in a worker process, crash and cancel handling,
the memory meter. pywebview isn't needed — a stand-in module is enough for Api."""

from __future__ import annotations

import os
import sys
import threading
import time
import types

import pytest

sys.modules.setdefault("webview", types.SimpleNamespace(windows=[]))
import app  # noqa: E402
from conftest import cols  # noqa: E402


@pytest.fixture
def calls(monkeypatch):
    got: list[tuple[str, dict]] = []
    monkeypatch.setattr(app, "_js", lambda fn, payload: got.append((fn, payload)))
    monkeypatch.setenv("COLSIFT_LOGS", os.environ["COLSIFT_PROFILES"])
    monkeypatch.setitem(app._LOG, "path", None)
    app._load_modules()
    return got


def test_heavy_work_runs_in_another_process_and_reports_progress(calls):
    r = app._heavy("_selftest", {"sleep": 0.6, "echo": "hi"}, lambda: {"ok": False})
    assert r["ok"] and r["echo"] == "hi" and r["pid"] != os.getpid(), r
    assert r["peak_memory"] > 0
    assert any(fn == "onProgress" and p.get("stage") == "test" for fn, p in calls)


def test_a_worker_that_dies_leaves_the_window_standing(calls):
    r = app._heavy("_selftest", {"exit": 7}, lambda: {"ok": False})
    assert not r["ok"] and r["crashed"] and "exit code 7" in r["error"] and "memory" in r["error"]
    assert "worker _selftest died" in app._crash_log().read_text()


def test_cancel_reaches_the_worker(calls):
    out = {}
    t = threading.Thread(target=lambda: out.update(r=app._heavy("_selftest", {"sleep": 30}, lambda: None)))
    t.start()
    time.sleep(2.5)
    app._CANCEL.set()
    t.join(20)
    assert out["r"].get("cancelled"), out


def test_one_heavy_job_at_a_time(calls):
    t = threading.Thread(target=lambda: app._heavy("_selftest", {"sleep": 3}, lambda: None))
    t.start()
    time.sleep(1.0)
    r = app._heavy("_selftest", {}, lambda: None)
    t.join(20)
    assert not r["ok"] and "already running" in r["error"]


def test_isolation_can_be_switched_off(calls, monkeypatch):
    monkeypatch.setenv("COLSIFT_INPROCESS", "1")
    assert app._heavy("_selftest", {}, lambda: {"ok": True, "here": True}) == {"ok": True, "here": True}


def test_count_and_run_setup_through_the_bridge(calls, data):
    tmp, f = data
    api = app.Api()
    job = {"files": [str(f["jan"]), str(f["feb"])], "columns": cols("DOC_NO", "AMOUNT")}
    r = api.count(job)
    assert r["ok"] and r["total"] == 72, r
    setup = {"groups": [{"name": "Sales", "files": job["files"], "setup": {"columns": job["columns"]}}],
             "output": {"folder": str(tmp / "o"), "format": "csv"}}
    assert api.run_setup(setup)["started"]
    for _ in range(300):
        done = [p for fn, p in calls if fn == "onRunDone"]
        if done:
            break
        time.sleep(0.1)
    assert done and done[0]["ok"] and done[0]["peak_memory"] > 0, done


def test_memory_meter(calls):
    m = app.Api().memory()
    assert m["ok"] and m["app"] > 0 and m["total"] > m["available"] > 0 and m["worker"] == 0
