"""2.9: widths remembered between sessions, samples and column lists that never read a
whole file, the run report, and the checks before Run."""

from pathlib import Path

import pytest

import engine as E
import report
import scheduling as SC
import workspace as W
from conftest import cols
from test_checks import two_groups


# ---- first reads -------------------------------------------------------------------
def big_csv(tmp_path, rows=20_000) -> Path:
    p = tmp_path / "big.csv"
    p.write_text("ID,NAME,AMOUNT\n" + "".join(f"{i},n{i},{i}.5{',extra' if i == rows - 1 else ''}\n" for i in range(rows)))
    return p


def test_a_width_is_remembered_beside_the_cache(tmp_path):
    p = big_csv(tmp_path)
    assert E._known_width(p, 1, ",", '"') is None
    w = E._data_width(p, 1, ",", '"')
    assert w == 4, "the last row is one wider"
    E.clear_cache()                                    # a new session: memory empty
    assert E._known_width(p, 1, ",", '"') == 4, "read back from widths.json"
    assert (E.cache_dir() / "widths.json").exists()
    p.write_text(p.read_text() + "1,2,3,4,5\n")         # the file changes: its old width doesn't count
    assert E._known_width(p, 1, ",", '"') is None


def test_a_sample_never_measures_the_whole_file(tmp_path, monkeypatch):
    p = big_csv(tmp_path, 200_000)
    monkeypatch.setattr(E, "TEXT_CACHE_MB", 0.5)        # the file counts as big
    monkeypatch.setattr(E, "TEXT_SAMPLE_BYTES", 64 * 1024)
    monkeypatch.setattr(E, "_data_width", lambda *a: pytest.fail("a sample measured the whole file"))
    src = E.Source.from_dict({"path": str(p)})
    src.sample_rows = 100
    assert E.cached_text(src, scan=False) is None
    df = E.load_lazy(src).head(100).collect()
    assert df.height == 100 and df.columns[:3] == ["ID", "NAME", "AMOUNT"]
    assert E._schema_names(src)[:3] == ["ID", "NAME", "AMOUNT"]


def test_columns_of_a_workbook_without_parsing_it(data, monkeypatch):
    tmp, f = data
    full = E.load_lazy(E.Source.from_dict({"path": str(f["codes"])})).collect_schema().names()
    E.cache_clear()
    monkeypatch.setattr(E, "build_sheet_cache", lambda *a, **k: pytest.fail("the window parsed the whole workbook"))
    monkeypatch.setattr(E, "_excel_frame", lambda *a, **k: pytest.fail("the window parsed the whole workbook"))
    r = E.columns_of({"path": str(f["codes"])})
    assert r["ok"] and r["columns"] == full == ["TAX_CODE", "DESCRIPTION", "RATE"]


# ---- the run report ------------------------------------------------------------------
def test_the_report_says_what_ran(data):
    tmp, f = data
    ws = two_groups(tmp, f, [{"name": "Has rows", "kind": "rows", "table": "Sales", "min": "1"}], fmt="csv")
    ws["name"] = "Month <end>"
    ws["params"] = [{"name": "MONTH", "mode": "fixed", "value": "jan"}]
    res = W.run_setup(ws)
    assert res["ok"], res
    entry = {"setup": ws["name"], "start": "2026-11-20 07:00:00", "seconds": 3.2, "ok": True, "source": "manual",
             "peak_memory": 123 * 1024 ** 2}
    html = report.page(entry, ws, res)
    assert "Run report — Month &lt;end&gt;" in html and "<end>" not in html, "names are escaped"
    for bit in ("Done", "by hand", "{MONTH}", "jan", "sales_JAN.csv", "Has rows", "pass", "123.0 MB", "Files read — "):
        assert bit in html, bit
    assert all(Path(w).name in html for w in res["written"])
    path = report.write(entry, ws, res)
    assert Path(path).parent == SC.runs_dir() and "Run report — Month &lt;end&gt;" in Path(path).read_text(encoding="utf-8")


def test_runs_by_hand_and_scheduled_runs_get_a_report(data):
    from datetime import datetime

    import app
    tmp, f = data
    ws = two_groups(tmp, f, [], fmt="csv")
    ws["name"] = "Quick"
    res = W.run_setup(ws)
    app._log_manual_run(ws, res, datetime(2026, 11, 20, 7))
    assert res["report"] and Path(res["report"]).exists()
    assert SC.history()["runs"][0]["report"] == res["report"]
    E.save_profile("Quick", ws)
    assert app.headless_run(["--run", "Quick"]) == 0
    last = SC.history()["runs"][0]
    assert last.get("source") != "manual" and Path(last["report"]).exists()
    assert "scheduled" in Path(last["report"]).read_text(encoding="utf-8")


def test_a_failed_run_says_why(data):
    tmp, f = data
    html = report.page({"setup": "X", "ok": False, "error": "The disk is full", "source": "manual"}, {}, {"ok": False})
    assert "Failed" in html and "The disk is full" in html


# ---- the checks before Run -------------------------------------------------------------
def test_preflight_finds_what_would_fail(data, monkeypatch):
    import app
    app._load_modules()
    tmp, f = data
    ws = two_groups(tmp, f, [], fmt="csv")
    ws["output"] = {"folder": str(tmp / "out"), "format": "csv", "basename": "month"}
    ok = app.preflight(ws)
    assert ok["problems"] == [] and ok["warnings"] == [] and ok["files"] == 3
    # no folder
    assert app.preflight({**ws, "output": {}})["problems"] == ["Choose an output folder on the Output tab."]
    # an earlier output open in Excel
    (tmp / "out" / "month.csv").write_text("x")
    monkeypatch.setattr(app, "_locked", lambda p: p.name == "month.csv")
    pf = app.preflight(ws)
    assert len(pf["problems"]) == 1 and "month.csv is open in another program" in pf["problems"][0]
    monkeypatch.setattr(app, "_locked", lambda p: False)
    # a file gone, and a full disk
    ws["groups"][0]["files"].append(str(tmp / "gone.csv"))
    monkeypatch.setattr(app, "_free", lambda p: 10 * 1024 ** 2)
    pf = app.preflight(ws)
    assert pf["problems"] == []
    assert any("can't be found any more (gone.csv)" in w for w in pf["warnings"])
    assert any("free where the output goes" in w for w in pf["warnings"])
