"""Run parameters: {NAME} anywhere in a setup, filled in when it runs."""

from __future__ import annotations

from datetime import date

import openpyxl
import pytest

import engine as E
import workspace as W
from conftest import cols, rule


@pytest.mark.parametrize("fmt, want", [
    ("yyyy-mm", "2026-07"), ("MMMyy", "JUL26"), ("mmm yyyy", "Jul 2026"), ("mmmm", "July"),
    ("dd/mm/yyyy", "04/07/2026"), ("yyyymm", "202607"), ("yyyy-Qq", "2026-Q3"), ("d.m.yy", "4.7.26"),
])
def test_date_formats(fmt, want):
    assert E.format_date(date(2026, 7, 4), fmt) == want


def test_values_from_modes_answers_and_overrides():
    setup = {"params": [{"name": "PERIOD", "mode": "last_month", "format": "MMMyy"},
                        {"name": "CODE", "mode": "ask", "value": "YQ"},
                        {"name": "SITE", "mode": "fixed", "value": "DXB"},
                        {"name": "bad name", "mode": "fixed", "value": "x"}],
             "param_values": {"CODE": "YR"}}
    assert E.param_values(setup, today=date(2026, 1, 9)) == {"PERIOD": "DEC25", "CODE": "YR", "SITE": "DXB"}
    assert E.param_values(setup, {"CODE": "XT", "PERIOD": "JUN26"}, today=date(2026, 1, 9))["PERIOD"] == "JUN26"


def test_only_parameters_are_filled_in():
    job = {"params": [{"name": "P", "mode": "fixed", "value": "2026-07"}],
           "files": ["D:/x/{P}/a.csv"], "filters": rule("DOC_NO", "regex", r"^E\d{4}$|{P}"), "id": "{P}",
           "note": "{OTHER} stays"}
    got = E.apply_params(job)
    assert got["files"] == ["D:/x/2026-07/a.csv"]
    assert got["filters"]["children"][0]["value"] == r"^E\d{4}$|2026-07"
    assert got["id"] == "{P}" and got["note"] == "{OTHER} stays"
    assert E.apply_params(got) == got
    assert E.apply_params({"workspace": job, "report": {"x": "{P}"}})["report"] == {"x": "2026-07"}


def monthly(tmp, f) -> dict:
    return {"name": "Monthly",
            "params": [{"name": "MONTH", "mode": "fixed", "value": "jan"}, {"name": "CODE", "mode": "ask", "value": "YQ"}],
            "folders": [str(tmp / "{MONTH}")],
            "groups": [{"name": "Sales", "match": {"mode": "pattern", "value": "sales_*"},
                        "setup": {"columns": cols("DOC_NO", "TAX_CODE"), "filters": rule("TAX_CODE", "equals", "{CODE}")}}],
            "output": {"folder": str(tmp / "out"), "basename": "tax_{MONTH}_{CODE}", "format": "xlsx"}}


def test_a_run_fills_in_folders_filters_and_the_output_name(data):
    tmp, f = data
    ws = monthly(tmp, f)
    ws["groups"][0]["folders"] = [str(tmp / "{MONTH}")]
    r = W.run_setup({**ws, "param_values": {"CODE": "YR"}})
    assert r["ok"], r
    assert r["written"][0].endswith("tax_jan_YR.csv") or r["written"][0].endswith("tax_jan_YR.xlsx")
    rows = list(openpyxl.load_workbook(r["written"][0]).active.iter_rows(values_only=True))[1:]
    assert rows and {x[1] for x in rows} == {"YR"} and {x[0][:2] for x in rows} == {"E1"}


def test_command_line_set_and_the_setups_own_folders(data):
    tmp, f = data
    E.save_profile("Monthly", W.normalize(monthly(tmp, f)))
    assert E._cli(["--profile", "Monthly", "--set", "MONTH=feb", "--set", "CODE=XT"]) == 0
    out = tmp / "out" / "tax_feb_XT.xlsx"
    rows = list(openpyxl.load_workbook(out).active.iter_rows(values_only=True))[1:]
    assert {x[0][:2] for x in rows} == {"E2"} and {x[1] for x in rows} == {"XT"}
