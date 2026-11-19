"""Preferences, the memory guard, autosave, run history and diagnostics."""

import json
import time

import pytest

import datamgr as D
import engine as E
import prefs
import scheduling as SC

GB = 1024 ** 3


@pytest.fixture
def knobs(monkeypatch):
    """Whatever apply() sets is put back after the test."""
    for mod, k in ((E, "TEXT_INFLIGHT"), (D, "CMP_BUCKET_CELLS"), (E, "DEDUPE_BUCKET_ROWS"), (E, "XLSX_CHUNK_CELLS"),
                   (E, "CACHE_CAP_GB")):
        monkeypatch.setattr(mod, k, getattr(mod, k))
    monkeypatch.delenv("COLSIFT_CACHE_GB", raising=False)


def test_defaults_and_bad_values():
    assert prefs.load() == prefs.DEFAULTS
    s = prefs.clean({"performance": "turbo", "threads": "-3", "memory_guard": 0, "cache_gb": "x", "autosave": None})
    assert s == {**prefs.DEFAULTS, "memory_guard": True, "autosave": True}
    assert prefs.clean({"memory_guard": False, "threads": 10 ** 6})["threads"] >= 1


def test_saved_beside_the_setups_and_not_listed_as_one(knobs):
    r = prefs.save({"performance": "low", "threads": 2, "cache_gb": 3})
    assert r["ok"] and r["profile"] == "low"
    f = E.profile_dir() / "app" / "settings.json"
    assert json.loads(f.read_text())["threads"] == 2
    assert prefs.load()["performance"] == "low"
    assert all(p["name"] != "settings" for p in E.list_profiles())


@pytest.mark.parametrize("total, want", [(4 * GB, "low"), (8 * GB, "balanced"), (15.6 * GB, "fast"), (64 * GB, "fast")])
def test_automatic_follows_the_pcs_memory(monkeypatch, total, want):
    monkeypatch.setattr(E, "system_memory", lambda: (int(total), int(total / 2)))
    assert prefs.profile({**prefs.DEFAULTS}) == want


def test_a_profile_sets_the_piece_sizes(knobs):
    prefs.apply({**prefs.DEFAULTS, "performance": "low", "cache_gb": 2.5})
    assert (E.TEXT_INFLIGHT, D.CMP_BUCKET_CELLS, E.DEDUPE_BUCKET_ROWS, E.XLSX_CHUNK_CELLS) == (1, 900_000, 250_000, 600_000)
    assert E.CACHE_CAP_GB == 2.5
    prefs.apply({**prefs.DEFAULTS, "performance": "fast"})
    assert E.TEXT_INFLIGHT == 3 and D.CMP_BUCKET_CELLS == 3_600_000 and E._xlsx_chunk(12) == 200_000
    assert prefs.worker_env({**prefs.DEFAULTS, "threads": 3}) == {"POLARS_MAX_THREADS": "3"}
    assert prefs.worker_env(prefs.DEFAULTS) == {}


def test_low_memory_gives_the_same_answers(tmp_path, knobs):
    a, b = tmp_path / "a.csv", tmp_path / "b.csv"
    a.write_text("K,V\n" + "".join(f"{i},{i}\n" for i in range(3000)))
    b.write_text("K,V\n" + "".join(f"{i},{i + (i % 7 == 0)}\n" for i in range(1500, 4500)))
    prefs.apply({**prefs.DEFAULTS, "performance": "fast"})
    fast = D.compare({"a": str(a), "b": str(b), "keys": ["K"]})
    prefs.apply({**prefs.DEFAULTS, "performance": "low"})
    D.CMP_BUCKET_CELLS = 2_000                                  # many buckets, even here
    low = D.compare({"a": str(a), "b": str(b), "keys": ["K"]})
    changed = sum(1 for i in range(1500, 3000) if i % 7 == 0)
    assert low["counts"] == fast["counts"] == {"removed": 1500, "added": 1500, "same": 1500 - changed,
                                               "changed": changed, "values_changed": changed}
    assert low["changed"]["rows"] == fast["changed"]["rows"]


def test_the_guard_acts_on_a_lasting_shortage_only():
    assert prefs.short_of_memory(16 * GB, int(0.5 * GB))
    assert not prefs.short_of_memory(16 * GB, 2 * GB)
    assert prefs.short_of_memory(4 * GB, 200 * 1024 ** 2)
    assert not prefs.short_of_memory(0, 0)


def test_the_guard_stops_a_real_worker(monkeypatch):
    import app
    app._load_modules()
    monkeypatch.setattr(prefs, "GUARD_SECONDS", 0.3)
    monkeypatch.setattr(E, "system_memory", lambda: (16 * GB, int(0.1 * GB)))
    t0 = time.monotonic()
    r = app._in_child("_selftest", {"sleep": 30, "echo": "x"})
    assert r["ok"] is False and r["guarded"] is True and "before the PC ran out of memory" in r["error"]
    assert time.monotonic() - t0 < 20, "stopped long before the job's 30 seconds"


def test_the_guard_can_be_turned_off(monkeypatch):
    import app
    app._load_modules()
    prefs.save({"memory_guard": False})
    monkeypatch.setattr(E, "system_memory", lambda: (16 * GB, int(0.1 * GB)))
    r = app._in_child("_selftest", {"sleep": 0.2, "echo": "x"})
    assert r.get("echo") == "x" and not r.get("guarded")


def test_autosave_keeps_the_last_state():
    assert prefs.autosave_get() == {"ok": True, "found": False}
    prefs.autosave_put({"name": "Month end", "saved": False, "setup": {"groups": [{"name": "G"}]}})
    got = prefs.autosave_get()
    assert got["found"] and got["name"] == "Month end" and got["saved"] is False and got["setup"]["groups"][0]["name"] == "G"
    prefs.autosave_clear()
    assert prefs.autosave_get()["found"] is False


def test_runs_by_hand_are_history_but_not_news():
    from datetime import datetime

    import app
    SC.news()                                                     # first look: no backlog
    app._log_manual_run({"name": "Month end"}, {"ok": True, "written": ["x.csv"], "peak_memory": 5}, datetime(2999, 1, 1))
    app._log_manual_run({}, {"ok": False, "error": "boom"}, datetime(2999, 1, 2))
    runs = SC.history()["runs"]
    assert [(r["setup"], r["source"], r["code"]) for r in runs] == [("(not saved)", "manual", 1), ("Month end", "manual", 0)]
    assert SC.news()["runs"] == []


def test_diagnostics_say_what_matters():
    import app
    app._load_modules()
    d = app.diagnostics()
    from version import VERSION
    assert d["ok"] and d["version"] == VERSION
    for k in ("ColSift", "polars", "Memory", "Performance", "Memory guard", "Setups", "Cache", "Crash log"):
        assert k in d["info"], k
    assert d["text"].startswith(f"ColSift: {VERSION}")
