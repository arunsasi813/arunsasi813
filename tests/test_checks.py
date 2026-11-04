"""Checks pass or fail a run: worked out on the built tables before anything is written."""

from __future__ import annotations

import openpyxl
import polars as pl

import engine as E
import workspace as W
from conftest import cols


def sales_total(f) -> float:
    return round(sum(pl.read_csv(f[k])["AMOUNT"].sum() for k in ("jan", "feb")), 2)


def two_groups(tmp, f, checks: list[dict], fmt: str = "xlsx") -> dict:
    return {"groups": [
        {"name": "Sales", "files": [str(f["jan"]), str(f["feb"])],
         "setup": {"columns": cols("DOC_NO", "TAX_CODE", "AMOUNT")}},
        {"name": "Codes", "files": [str(f["codes"])], "setup": {"columns": cols("TAX_CODE", "DESCRIPTION")}},
    ], "checks": checks, "output": {"folder": str(tmp / "out"), "basename": "month", "format": fmt}}


def by_name(res: dict) -> dict:
    return {c["name"]: c for c in res["checks"]}


def test_checks_pass_warn_and_land_in_a_checks_sheet(data):
    tmp, f = data
    total = sales_total(f)
    ws = two_groups(tmp, f, [
        {"name": "has rows", "kind": "rows", "table": "Sales", "min": 1},
        {"name": "tickets once", "kind": "unique", "table": "Sales", "cols": ["DOC_NO"]},
        {"name": "codes known", "kind": "found", "table": "Sales", "cols": ["TAX_CODE"], "table2": "Codes",
         "on_fail": "warn"},
        {"name": "total", "kind": "totals", "table": "Sales", "cols": ["AMOUNT"], "value": str(total)},
        {"name": "no negatives", "kind": "sql_empty", "sql": "SELECT * FROM Sales WHERE AMOUNT < 0"},
    ])
    r = W.run_setup(ws)
    assert r["ok"], r
    c = by_name(r)
    assert [c[n]["status"] for n in ("has rows", "tickets once", "total", "no negatives")] == ["pass"] * 4
    assert c["has rows"]["value"] == 72
    assert c["codes known"]["status"] == "fail" and c["codes known"]["examples"] == ["ZR"]
    assert any("codes known" in w and "ZR" in w for w in r["warnings"])
    wb = openpyxl.load_workbook(r["written"][0])
    sheet = [row for row in wb["Checks"].iter_rows(values_only=True)]
    assert sheet[0] == ("Check", "Table", "Result", "Detail", "Examples")
    assert {row[0]: row[2] for row in sheet[1:]}["codes known"] == "FAIL (warning)"
    assert {row[0]: row[2] for row in sheet[1:]}["total"] == "PASS"


def test_a_failed_stop_check_writes_nothing(data):
    tmp, f = data
    ws = two_groups(tmp, f, [{"kind": "found", "table": "Sales", "cols": ["TAX_CODE"], "table2": "Codes"},
                             {"kind": "totals", "table": "Sales", "cols": ["AMOUNT"], "value": "1"}])
    r = W.run_setup(ws)
    assert not r["ok"] and r["stopped"]
    assert "Stopped before writing — 2 checks failed" in r["error"] and "ZR" in r["error"]
    assert "off by" in r["checks"][1]["detail"]
    assert not (tmp / "out").exists() or not any((tmp / "out").iterdir())


def test_totals_against_another_table_and_same_rows(data):
    tmp, f = data
    ws = two_groups(tmp, f, [
        {"name": "t", "kind": "totals", "table": "Sales", "cols": ["AMOUNT"], "table2": "Sales", "on_fail": "warn"},
        {"name": "n", "kind": "same_rows", "table": "Sales", "table2": "Codes", "on_fail": "warn"},
        {"name": "case", "kind": "found", "table": "Codes", "cols": ["TAX_CODE"], "table2": "Sales", "fold": True},
    ])
    c = by_name(W.test_checks(ws))
    assert c["t"]["status"] == "pass" and c["t"]["value"] == 0
    assert c["n"]["status"] == "fail" and "72 rows, Codes 3" in c["n"]["detail"]
    assert c["case"]["status"] == "pass"
    assert not (tmp / "out").exists(), "Check now writes nothing"


def test_a_check_that_cannot_be_worked_out_fails_and_says_why(data):
    tmp, f = data
    ws = two_groups(tmp, f, [{"name": "bad", "kind": "not_blank", "table": "Sales", "cols": ["NOPE"]},
                             {"name": "gone", "kind": "rows", "table": "Nowhere"}])
    r = W.test_checks(ws)
    c = by_name(r)
    assert c["bad"]["status"] == "error" and "no column NOPE" in c["bad"]["detail"]
    assert c["gone"]["status"] == "error" and "Nowhere" in c["gone"]["detail"]
    assert r["stop"] and r["failed"] == 2


def test_plain_extract_checks_everything_it_read(data):
    tmp, f = data
    one = {"groups": [{"name": "Sales", "files": [str(f["jan"]), str(f["feb"])],
                       "setup": {"columns": cols("DOC_NO", "AMOUNT")}}],
           "output": {"folder": str(tmp / "o"), "basename": "x", "format": "csv"},
           "checks": [{"kind": "rows", "min": 72, "max": 72}, {"kind": "unique", "cols": ["DOC_NO"]},
                      {"kind": "not_blank", "cols": "AMOUNT"}]}
    r = W.run_setup(one)
    assert r["ok"] and r["mode"] == "single", r
    assert [c["status"] for c in r["checks"]] == ["pass"] * 3
    assert (tmp / "o" / "x_Checks.csv").read_text(encoding="utf-8").startswith("Check,Table,Result")
    # one output per input: still one Checks file, over every file
    one["output"]["mode"] = "per_file"
    r = W.run_setup(one)
    assert r["ok"] and sum(1 for w in r["written"] if w.endswith("x_Checks.csv")) == 1
    # a stop check over the one table: nothing written
    one["output"] = {"folder": str(tmp / "o2"), "basename": "x", "format": "csv"}
    one["checks"] = [{"kind": "rows", "max": 10}]
    r = W.run_setup(one)
    assert not r["ok"] and r["stopped"] and "72 rows — expected at most 10" in r["error"]
    assert not (tmp / "o2").exists() or not any((tmp / "o2").iterdir())


def test_duplicates_check_reports_the_keys(data):
    tmp, f = data
    ws = two_groups(tmp, f, [{"name": "u", "kind": "unique", "table": "Sales", "cols": ["TAX_CODE"]}])
    c = by_name(W.test_checks(ws))["u"]
    assert c["status"] == "fail" and c["value"] == 4 and "over 72 rows" in c["detail"]
    assert all("×18" in e for e in c["examples"])


def test_checks_take_parameters_and_the_cli_exits_3_when_they_stop(data, capsys):
    tmp, f = data
    ws = two_groups(tmp, f, [{"kind": "rows", "table": "Sales", "min": "{MIN}"}], fmt="csv")
    ws["params"] = [{"name": "MIN", "mode": "fixed", "value": "1"}]
    E.save_profile("Checked", ws)
    assert E._cli(["--profile", "Checked"]) == 0
    assert E._cli(["--profile", "Checked", "--set", "MIN=1000"]) == 3
    assert "STOP" in capsys.readouterr().err
