"""Studio visuals: measures and rows worked out for a Measure Studio design, under
the dashboard's filters; and the studio page ColSift ships."""

from __future__ import annotations

from pathlib import Path

import pytest

import analysis as A
import engine as E
import studio_embed

ROOT = Path(__file__).resolve().parent.parent


def sales(f) -> "E.pl.LazyFrame":
    return E.load_lazy(E.Source(path=str(f["jan"])))


def item(**kw) -> dict:
    return {"kind": "studio", "id": "s1", "project": {"settings": {"name": "Sales"}, "blocks": []},
            "measures": [{"name": "Revenue", "agg": "sum", "column": "AMOUNT"}, {"name": "Tickets", "agg": "rows"},
                         {"name": "Docs", "agg": "distinct", "column": "DOC_NO"}], **kw}


def test_measures_follow_the_dashboard_filters(data):
    tmp, f = data
    full = A.dashboard(sales(f), [item()])[0]
    assert full["name"] == "Sales" and full["values"]["Tickets"] == 36 and full["values"]["Docs"] == 36
    yq = A.dashboard(sales(f), [item()], filters=[{"column": "TAX_CODE", "values": ["YQ"]}])[0]
    assert yq["values"]["Tickets"] == 9 and yq["values"]["Revenue"] < full["values"]["Revenue"]
    free = A.dashboard(sales(f), [item(ignore_filters=True)], filters=[{"column": "TAX_CODE", "values": ["YQ"]}])[0]
    assert free["values"]["Tickets"] == 36


def test_rows_per_value_per_month_and_top_records(data):
    tmp, f = data
    it = item(blocks={
        "bar1": {"mode": "group", "by": {"column": "TAX_CODE"}},
        "ln1": {"mode": "group", "by": {"column": "ISSUE_DATE", "group": "month"}},
        "nt1": {"mode": "rows", "columns": ["DOC_NO", "AMOUNT"], "sort_by": "AMOUNT", "limit": 3},
        "off": {"mode": "off"},
        "bad": {"mode": "group", "by": {"column": "NOPE"}}})
    r = A.dashboard(sales(f), [it])[0]
    bar = r["ctx"]["bar1"]
    assert [c["__label"] for c in bar] == ["XT", "YQ", "YR", "ZR"]
    assert bar[0]["TAX_CODE"] == "XT" and bar[0]["Tickets"] == 9 and sum(c["Revenue"] for c in bar) == pytest.approx(r["values"]["Revenue"])
    assert [c["__label"] for c in r["ctx"]["ln1"]] == ["2026-01"]
    top = r["ctx"]["nt1"]
    assert len(top) == 3 and top[0]["AMOUNT"] == max(c["AMOUNT"] for c in top) and isinstance(top[0]["AMOUNT"], float)
    assert top[0]["DOC_NO"].startswith("E1")                    # an ID stays text
    assert "off" not in r["ctx"] and "NOPE" in r["block_errors"]["bad"]


def test_a_row_cap_keeps_the_biggest_groups_in_their_order(data):
    tmp, f = data
    r = A.dashboard(sales(f), [item(blocks={"b": {"by": {"column": "DOC_NO"}, "limit": 3}})])[0]
    got = r["ctx"]["b"]
    assert len(got) == 3 and [c["__label"] for c in got] == sorted(c["__label"] for c in got)
    biggest = sorted(c["Revenue"] for c in A.dashboard(sales(f), [item(blocks={"b": {"by": {"column": "DOC_NO"}, "limit": 500}})])[0]["ctx"]["b"])[-3:]
    assert sorted(c["Revenue"] for c in got) == biggest


def test_the_workbook_gets_the_measures_as_a_table(data):
    tmp, f = data
    res = {"items": A.dashboard(sales(f), [item()]), "tabs": []}
    grids = E.analysis_grids(res, {"analysis": {"export": True}})
    cells = [r["cells"] for r in grids[0]["grid"]]
    assert ["Measure", "Value"] in cells and ["Tickets", "36"] in cells


def test_the_shipped_studio_has_the_hooks_and_patches_only_an_original(tmp_path):
    page = (ROOT / "studio.html").read_text(encoding="utf-8")
    for hook in ("ColSift live data", "window.msColSift", "if (window.__MS_EMBED) return;", "liveRows(b) || parseGrid(b.sample)"):
        assert hook in page, hook
    again = tmp_path / "again.html"
    with pytest.raises(SystemExit, match="already has the ColSift hooks"):
        studio_embed.build(ROOT / "studio.html", again)
