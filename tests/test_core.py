"""The engine, the setup model and the combined run."""

from __future__ import annotations

import json

import openpyxl
import polars as pl

import engine as E
import workspace as W
from conftest import cols, rule


def test_preview_keeps_the_picked_columns_and_filters(data):
    tmp, f = data
    job = {"files": [str(f["jan"])], "columns": cols("DOC_NO", "AMOUNT"), "filters": rule("AMOUNT", "gt", "500")}
    r = E.preview(job, 50)
    assert r["ok"], r
    assert r["columns"] == ["DOC_NO", "AMOUNT"]
    assert r["rows"] and all(float(x[1]) > 500 for x in r["rows"])


def test_run_csv_and_xlsx(data):
    tmp, f = data
    base = {"files": [str(f["jan"]), str(f["feb"])], "columns": cols("DOC_NO", "TAX_CODE", "AMOUNT"),
            "filters": rule("TAX_CODE", "equals", "YQ")}
    r = E.run({**base, "output": {"folder": str(tmp / "out"), "basename": "x", "format": "csv"}})
    assert r["ok"], r
    df = pl.read_csv(r["written"][0], infer_schema=False)
    assert df.columns == ["DOC_NO", "TAX_CODE", "AMOUNT"] and set(df["TAX_CODE"]) == {"YQ"} and df.height == 18
    r = E.run({**base, "output": {"folder": str(tmp / "out"), "basename": "y", "format": "xlsx"}})
    assert r["ok"], r
    rows = list(openpyxl.load_workbook(r["written"][0]).active.iter_rows(values_only=True))
    assert rows[0] == ("DOC_NO", "TAX_CODE", "AMOUNT") and len(rows) == 19


def test_dashboard_and_pdf(data):
    tmp, f = data
    job = {"files": [str(f["jan"])], "columns": cols("TAX_CODE", "AMOUNT"),
           "analysis": {"items": [{"id": "k", "kind": "kpi", "values": [{"column": "AMOUNT", "agg": "sum"}]},
                                  {"id": "b", "kind": "breakdown", "by": {"column": "TAX_CODE"},
                                   "values": [{"column": "AMOUNT", "agg": "sum"}]}]}}
    res = E.analyse(job, "all")
    assert res["ok"], res
    want = pl.read_csv(f["jan"], infer_schema=False)["AMOUNT"].cast(pl.Float64).sum()
    kpi = next(i for i in res["items"] if i["id"] == "k")
    assert abs(kpi["table"]["rows"][0]["nums"][-1] - want) < 1e-6
    import pdfout
    p = pdfout.analysis_pdf(tmp / "a.pdf", res)
    assert p.read_bytes().startswith(b"%PDF-1.4")


def test_classic_setup_becomes_one_group_and_runs_unchanged(data):
    tmp, f = data
    job = {"files": [str(f["jan"])], "columns": cols("DOC_NO"), "output": {"folder": str(tmp / "o"), "format": "csv"}}
    ws = W.from_any(job, "Plain")
    assert [g["name"] for g in ws["groups"]] == ["Plain"] and W.is_classic(ws)
    r = W.run_setup(ws)
    assert r["ok"] and r["mode"] == "single", r


def grouped(tmp, f) -> dict:
    return {
        "name": "Month end",
        "groups": [
            {"name": "Sales", "files": [str(f["jan"]), str(f["feb"])],
             "setup": {"columns": cols("DOC_NO", "TAX_CODE", "AMOUNT"), "filters": rule("AMOUNT", "gt", "300")}},
            {"name": "Refunds", "files": [str(f["refunds"])], "setup": {"source": {"delimiter": "pipe"},
                                                                        "columns": cols("DOC_NO", "TAX_CODE", "AMOUNT")}},
            {"name": "Codes", "files": [str(f["codes"])], "setup": {"columns": cols("TAX_CODE", "DESCRIPTION", "RATE")}},
        ],
        "output": {"folder": str(tmp / "out"), "basename": "month", "format": "xlsx"},
    }


def test_run_setup_groups_then_steps_then_export(data):
    tmp, f = data
    ws = grouped(tmp, f)
    ws["steps"] = [
        {"name": "WithCodes", "kind": "lookup", "input": "Sales", "from": "Codes",
         "on": [{"left": "TAX_CODE", "right": "TAX_CODE"}], "columns": [{"column": "DESCRIPTION"}]},
        {"name": "Both", "kind": "append", "inputs": ["Sales", "Refunds"], "source_col": "SOURCE"},
        {"name": "NoCode", "kind": "merge", "left": "Sales", "right": "Codes", "how": "anti",
         "on": [{"left": "TAX_CODE", "right": "TAX_CODE"}]},
        {"name": "Totals", "kind": "sql", "sql": "SELECT TAX_CODE, SUM(AMOUNT) AS TOTAL FROM Sales GROUP BY TAX_CODE"},
    ]
    r = W.run_setup(ws)
    assert r["ok"] and r["mode"] == "combined", r
    wb = openpyxl.load_workbook(r["written"][0])
    assert wb.sheetnames == ["Sales", "Refunds", "Codes", "WithCodes", "Both", "NoCode", "Totals"]
    sales = list(wb["Sales"].iter_rows(values_only=True))
    assert sales[0] == ("DOC_NO", "TAX_CODE", "AMOUNT") and all(float(x[2]) > 300 for x in sales[1:])
    look = list(wb["WithCodes"].iter_rows(values_only=True))
    assert look[0][-1] == "DESCRIPTION" and len(look) == len(sales)
    assert {x[1] for x in list(wb["NoCode"].iter_rows(values_only=True))[1:]} == {"ZR"}
    both = list(wb["Both"].iter_rows(values_only=True))
    assert len(both) == len(sales) + 3


def test_relationship_key_not_kept_by_the_group(data):
    tmp, f = data
    ws = grouped(tmp, f)
    ws["groups"][0]["setup"]["columns"] = cols("DOC_NO", "AMOUNT")          # TAX_CODE not kept
    ws["relationships"] = [{"from": "Sales", "from_col": "TAX_CODE", "to": "Codes", "to_col": "TAX_CODE"}]
    sc = {t["name"]: t for t in W.schema(ws)["tables"]}
    assert sc["Sales"]["columns"] == ["DOC_NO", "AMOUNT"] and "Codes.DESCRIPTION" in sc["Sales"]["related"]
    rep = {"name": "R", "table": "Sales", "analysis": {"items": [
        {"id": "b", "kind": "breakdown", "by": {"column": "Codes.DESCRIPTION"}, "values": [{"column": "AMOUNT", "agg": "sum"}]}]}}
    res = W.analyse(ws, rep, "all")
    assert res["ok"], res
    labels = [r["cells"][0] for r in res["items"][0]["table"]["rows"]]
    assert "Fuel surcharge" in labels and "(blank)" in labels


def test_groups_stacked_into_one_table(data):
    tmp, f = data
    ws = grouped(tmp, f)
    ws["groups"] = ws["groups"][:2]
    ws["output"]["groups_as"] = "stacked"
    assert [t["name"] for t in W.tables_of(W.normalize(ws))] == ["Sales", "Refunds", "All groups"]
    r = W.run_setup(ws)
    wb = openpyxl.load_workbook(r["written"][0])
    assert wb.sheetnames == ["All groups"]
    rows = list(wb["All groups"].iter_rows(values_only=True))
    assert rows[0][0] == "SOURCE" and {x[0] for x in rows[1:]} == {"Sales", "Refunds"}


def test_group_and_total_step_is_not_a_file_group(data):
    tmp, f = data
    ws = grouped(tmp, f)
    ws["groups"] = ws["groups"][:1]
    ws["steps"] = [{"name": "Totals", "kind": "group", "input": "Sales", "by": ["TAX_CODE"],
                    "values": [{"column": "AMOUNT", "agg": "sum", "name": "SUM"}]}]
    sc = {t["name"]: t for t in W.schema(ws)["tables"]}
    assert "error" not in sc["Totals"] and sc["Totals"]["columns"] == ["TAX_CODE", "SUM"]
    ws["output"]["groups_as"] = "stacked"
    r = W.run_setup(ws)
    assert openpyxl.load_workbook(r["written"][0]).sheetnames == ["All groups", "Totals"]


def test_setups_save_load_export_import(data, tmp_path):
    tmp, f = data
    ws = grouped(tmp, f)
    assert E.save_profile("Month end", W.normalize(ws))["ok"]
    E.save_profile("Plain", {"columns": cols("DOC_NO")})
    assert {p["name"]: p["groups"] for p in E.list_profiles()} == {"Month end": 3, "Plain": 1}
    got = E.load_profile("Month end")["setup"]
    assert [g["name"] for g in got["groups"]] == ["Sales", "Refunds", "Codes"]
    bundle = tmp_path / "all.json"
    assert E.export_profiles(["Month end", "Plain"], str(bundle))["ok"]
    E.delete_profile("Month end")
    r = E.import_profiles(str(bundle))
    assert r["ok"] and "Month end" in [p["name"] for p in E.list_profiles()]
    assert json.loads(bundle.read_text())["kind"] == E.BUNDLE_KIND


def test_cli_profile_with_groups(data):
    tmp, f = data
    ws = grouped(tmp, f)
    ws["groups"] = ws["groups"][:1]
    ws["groups"][0]["match"] = {"mode": "pattern", "value": "sales_*.csv"}
    ws["steps"] = [{"name": "Codes2", "kind": "sql", "sql": "SELECT DISTINCT TAX_CODE FROM Sales"}]
    E.save_profile("Month end", W.normalize(ws))
    code = E._cli(["--profile", "Month end", "--folder", str(f["feb"].parent), "--out", str(tmp / "me")])
    assert code == 0
    wb = openpyxl.load_workbook(tmp / "me" / "month.xlsx")
    assert wb.sheetnames == ["Sales", "Codes2"]
    assert {r[0][:2] for r in list(wb["Sales"].iter_rows(values_only=True))[1:]} == {"E2"}
