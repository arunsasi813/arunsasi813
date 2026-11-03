"""The overview dashboard across tables, Run dashboards, and dashboards refreshed by a run."""

from __future__ import annotations

import openpyxl
import polars as pl

import workspace as W
from conftest import cols, rule
from test_core import grouped

SUM = [{"column": "AMOUNT", "agg": "sum"}]


def with_overview(tmp, f) -> dict:
    ws = grouped(tmp, f)
    ws["steps"] = [{"name": "WithCodes", "kind": "lookup", "input": "Sales", "from": "Codes",
                    "on": [{"left": "TAX_CODE", "right": "TAX_CODE"}], "columns": [{"column": "DESCRIPTION"}]}]
    ws["overview"] = {"analysis": {"items": [
        {"id": "s", "kind": "kpi", "table": "Sales", "values": SUM},
        {"id": "r", "kind": "kpi", "table": "Refunds", "values": SUM},
        {"id": "w", "kind": "breakdown", "table": "WithCodes", "by": {"column": "DESCRIPTION"}, "values": SUM},
        {"id": "sl", "kind": "slicer", "table": "Sales", "by": {"column": "TAX_CODE"}},
        {"id": "x", "kind": "kpi", "values": SUM},
    ], "filters": []}, "summaries": {"tabs": [
        {"id": "p", "name": "By code", "table": "Refunds", "pivot": {"rows": [{"column": "TAX_CODE"}], "values": SUM}}]}}
    return ws


def kpi(res, iid):
    item = next(i for i in res["items"] if i["id"] == iid)
    return item["table"]["rows"][0]["nums"][-1]


def sales_total(f, code=None):
    df = pl.concat([pl.read_csv(f["jan"], infer_schema=False), pl.read_csv(f["feb"], infer_schema=False)])
    df = df.with_columns(pl.col("AMOUNT").cast(pl.Float64)).filter(pl.col("AMOUNT") > 300)
    if code:
        df = df.filter(pl.col("TAX_CODE") == code)
    return df["AMOUNT"].sum()


def test_overview_cards_read_their_own_tables(data):
    tmp, f = data
    ws = with_overview(tmp, f)
    res = W.analyse(ws, {**ws["overview"], "id": W.OVERVIEW_ID}, "all")
    assert res["ok"], res
    assert abs(kpi(res, "s") - sales_total(f)) < 1e-6
    assert abs(kpi(res, "r") - (-59.75)) < 1e-6
    assert {i["source"] for i in res["items"] if i.get("source")} == {"Sales", "Refunds", "WithCodes"}
    assert "Pick the data" in next(i for i in res["items"] if i["id"] == "x")["error"]
    assert next(t for t in res["tabs"] if t["id"] == "p")["table"]["rows"]


def test_a_slicer_filters_every_table_that_has_the_field(data):
    tmp, f = data
    ws = with_overview(tmp, f)
    ws["overview"]["analysis"]["filters"] = [{"column": "TAX_CODE", "values": ["YQ"], "mode": "keep"},
                                             {"column": "NOPE", "values": ["1"], "mode": "keep"}]
    res = W.analyse(ws, {**ws["overview"], "id": W.OVERVIEW_ID}, "all")
    assert abs(kpi(res, "s") - sales_total(f, "YQ")) < 1e-6
    assert abs(kpi(res, "r") - (-47.25)) < 1e-6
    assert [r["cells"][0] for r in next(i for i in res["items"] if i["id"] == "w")["table"]["rows"]
            if r["kind"] == "data"] == ["Fuel surcharge"]
    assert any("NOPE" in n for n in res["notes"])
    sl = next(i for i in res["items"] if i["id"] == "sl")
    assert sl["selected"] == ["YQ"] and {v["value"] for v in sl["facets"]["values"]} == {"XT", "YQ", "YR", "ZR"}


def test_drill_on_an_overview_card_ignores_fields_its_table_lacks(data):
    tmp, f = data
    ws = with_overview(tmp, f)
    rep = {**ws["overview"], "id": W.OVERVIEW_ID, "table": "Refunds"}
    r = W.drill(ws, rep, "all", [{"column": "TAX_CODE", "values": ["YQ"]}, {"column": "DESCRIPTION", "values": ["x"]}])
    assert r["ok"] and r["total"] == 2, r


def test_run_writes_the_overview_and_hands_back_every_dashboard(data):
    tmp, f = data
    ws = with_overview(tmp, f)
    ws["overview"]["analysis"]["export"] = True
    ws["groups"][0]["setup"]["analysis"] = {"items": [{"id": "g1", "kind": "kpi", "values": SUM}]}
    ws["output"].update(refresh_dashboards=True, pdf={"dashboard": True})
    r = W.run_setup(ws)
    assert r["ok"], r
    wb = openpyxl.load_workbook(next(p for p in r["written"] if p.endswith(".xlsx")))
    assert "Overview" in wb.sheetnames
    cells = [c for row in wb["Overview"].iter_rows(values_only=True) for c in row if isinstance(c, str)]
    assert any(c.endswith("· Refunds") for c in cells)
    assert any(p.endswith(".pdf") for p in r["written"])
    d = r["dashboards"]
    assert "overview" in d and any(k.startswith("g:") for k in d)
    assert abs(kpi(d["overview"], "s") - sales_total(f)) < 1e-6 and d["overview"]["scope"] == "all"


def test_run_dashboards_reads_every_file_and_writes_nothing(data):
    tmp, f = data
    ws = with_overview(tmp, f)
    ws["groups"][0]["setup"]["analysis"] = {"items": [{"id": "g1", "kind": "kpi", "values": SUM}]}
    r = W.run_dashboards(ws)
    assert r["ok"], r
    keys = set(r["dashboards"])
    assert "overview" in keys and len([k for k in keys if k.startswith("g:")]) == 1
    g = next(v for k, v in r["dashboards"].items() if k.startswith("g:"))
    assert abs(kpi(g, "g1") - sales_total(f)) < 1e-6
    assert not (tmp / "out").exists()


def test_a_one_group_run_hands_back_its_dashboard(data):
    tmp, f = data
    job = {"files": [str(f["jan"])], "columns": cols("TAX_CODE", "AMOUNT"), "filters": rule("TAX_CODE", "equals", "YQ"),
           "analysis": {"items": [{"id": "k", "kind": "kpi", "values": SUM}]},
           "output": {"folder": str(tmp / "o"), "format": "csv", "refresh_dashboards": True}}
    ws = W.from_any(job, "One")
    r = W.run_setup(ws)
    assert r["ok"] and r["mode"] == "single", r
    (k, v), = r["dashboards"].items()
    assert k == f"g:{ws['groups'][0]['id']}"
    want = pl.read_csv(f["jan"], infer_schema=False).filter(pl.col("TAX_CODE") == "YQ")["AMOUNT"].cast(pl.Float64).sum()
    assert abs(kpi(v, "k") - want) < 1e-6
