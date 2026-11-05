"""Parquet in and out: a .parquet is a source like any other, a run can write
Parquet with real types, and Convert turns extracts into Parquet in one go."""

from __future__ import annotations

import datetime as dt

import openpyxl
import polars as pl

import engine as E
import workspace as W
from conftest import cols, rule


def sales_parquet(path, n=10):
    pl.DataFrame({
        "DOC_NO": [f"{i:06d}" for i in range(n)],
        "TAX_CODE": ["YQ" if i % 2 else "XT" for i in range(n)],
        "AMOUNT": [10.5 * (i + 1) for i in range(n)],
        "ISSUED": [dt.date(2026, 1, 1 + i) for i in range(n)],
        "PAX": [i for i in range(n)],
    }).write_parquet(path)
    return path


def test_a_parquet_file_is_a_source_like_any_other(tmp_path):
    f = sales_parquet(tmp_path / "jan.parquet")
    listed = E.list_folder(str(tmp_path))["files"]
    assert [(x["name"], x["kind"]) for x in listed] == [("jan.parquet", "parquet")]
    pk = E.peek_all([str(f)], {"header_row": 5}, rows=2)["files"][0]          # header row is ignored
    assert pk["ok"] and pk["rows_est"] == 10 and pk["rows_exact"] and pk["rows"][0][:2] == ["000000", "XT"]
    r = W.run_setup({"groups": [{"name": "S", "files": [str(f)], "setup": {
        "columns": cols("DOC_NO", "AMOUNT", "ISSUED"), "filters": rule("TAX_CODE", "equals", "YQ")}}],
        "output": {"folder": str(tmp_path / "o"), "basename": "x", "format": "csv"}})
    assert r["ok"] and r["rows"] == 5, r
    lines = (tmp_path / "o" / "x.csv").read_text(encoding="utf-8").split()
    assert lines[:2] == ["DOC_NO,AMOUNT,ISSUED", "000001,21.0,2026-01-02"]
    assert E.count_rows({"files": [str(f)], "filters": rule("AMOUNT", "gt", "50")})["total"] == 6
    found = E.find({"files": [str(f)], "columns": cols("DOC_NO")}, {"values": "000003\n999", "scope": "all"})
    assert found["ok"] and found["total"] == 1 and found["missing"] == ["999"]


def test_parquet_output_keeps_numbers_and_dates_typed_and_ids_as_text(data):
    tmp, f = data
    r = W.run_setup({"groups": [{"name": "Sales", "files": [str(f["jan"]), str(f["feb"])],
                                 "setup": {"columns": cols("DOC_NO", "TAX_CODE", "AMOUNT", "ISSUE_DATE")}}],
                     "output": {"folder": str(tmp / "o"), "basename": "m", "format": "parquet"}})
    assert r["ok"], r
    out = pl.read_parquet(tmp / "o" / "m.parquet")
    assert out.height == 72
    assert dict(out.schema) == {"DOC_NO": pl.String, "TAX_CODE": pl.String, "AMOUNT": pl.Float64, "ISSUE_DATE": pl.Date}
    assert out["ISSUE_DATE"][0] == dt.date(2026, 1, 1)
    # a column format set on the Output tab wins over the guess
    r = W.run_setup({"groups": [{"name": "Sales", "files": [str(f["jan"])], "setup": {
        "columns": cols("DOC_NO", "AMOUNT"), "output": {"formats": {"AMOUNT": {"type": "text"}}}}}],
        "output": {"folder": str(tmp / "o2"), "basename": "m", "format": "parquet"}})
    assert pl.read_parquet(tmp / "o2" / "m.parquet").schema["AMOUNT"] == pl.String


def test_leading_zeros_and_long_numbers_stay_text(tmp_path):
    (tmp_path / "a.csv").write_text("REF,ACCOUNT,TKT,VAL\n0012,123456789012345,7,1.5\n0099,223456789012345,8,2\n",
                                    encoding="utf-8")
    r = E.convert_to_parquet({"files": [str(tmp_path / "a.csv")], "folder": str(tmp_path / "pq")})
    assert r["ok"], r
    got = pl.read_parquet(tmp_path / "pq" / "a.parquet")
    assert dict(got.schema) == {"REF": pl.String, "ACCOUNT": pl.String, "TKT": pl.String, "VAL": pl.Float64}
    assert got["REF"].to_list() == ["0012", "0099"]


def test_combined_run_writes_a_parquet_per_table_and_checks_beside_it(data):
    tmp, f = data
    ws = {"groups": [
        {"name": "Sales", "files": [str(f["jan"]), str(f["feb"])], "setup": {"columns": cols("DOC_NO", "AMOUNT")}},
        {"name": "Codes", "files": [str(f["codes"])], "setup": {"columns": cols("TAX_CODE", "RATE")}},
    ], "checks": [{"kind": "rows", "table": "Codes", "min": 3}],
        "output": {"folder": str(tmp / "o"), "basename": "b", "format": "parquet"}}
    r = W.run_setup(ws)
    assert r["ok"], r
    names = sorted(p.split("/")[-1].split("\\")[-1] for p in r["written"])
    assert names == ["b_Checks.xlsx", "b_Codes.parquet", "b_Sales.parquet"], names
    assert pl.read_parquet(tmp / "o" / "b_Codes.parquet").schema["RATE"] == pl.Float64
    assert openpyxl.load_workbook(tmp / "o" / "b_Checks.xlsx")["Checks"]["C2"].value == "PASS"


def test_convert_reads_each_file_as_set_up_and_skips_parquet(data):
    tmp, f = data
    src = sales_parquet(tmp / "jan" / "already.parquet", 3)
    r = E.convert_to_parquet({"files": [str(f["jan"]), str(f["codes"]), str(src)], "folder": str(tmp / "pq")})
    assert r["ok"] and len(r["written"]) == 2, r
    assert r["files"][2]["note"].startswith("already Parquet")
    sales = pl.read_parquet(tmp / "pq" / "sales_JAN.parquet")
    assert sales.height == 36 and sales.schema["AMOUNT"] == pl.Float64 and sales.schema["DOC_NO"] == pl.String
    codes = pl.read_parquet(tmp / "pq" / "codes.parquet")
    assert codes.columns == ["TAX_CODE", "DESCRIPTION", "RATE"] and codes.schema["RATE"] == pl.Float64
    # and the converted files read back as sources
    back = W.run_setup({"groups": [{"name": "S", "files": [str(tmp / "pq" / "sales_JAN.parquet")],
                                    "setup": {"columns": cols("DOC_NO", "AMOUNT")}}],
                        "output": {"folder": str(tmp / "o"), "basename": "x", "format": "csv"}})
    assert back["ok"] and back["rows"] == 36


def test_a_bad_file_does_not_stop_the_others(data):
    tmp, f = data
    bad = tmp / "bad.xlsx"
    bad.write_bytes(b"not a workbook")
    r = E.convert_to_parquet({"files": [str(bad), str(f["feb"])], "folder": str(tmp / "pq")})
    assert len(r["written"]) == 1 and r["errors"] and "bad.xlsx" in r["errors"][0]


def test_preview_pages_through_a_big_file(tmp_path):
    f = sales_parquet(tmp_path / "big.parquet", 25)
    job = {"files": [str(f)], "columns": cols("DOC_NO")}
    first = E.preview(job, 10)
    assert first["shown"] == 10 and first["more"] and first["rows"][0] == ["000000"]
    last = E.preview(job, 10, 20)
    assert last["offset"] == 20 and last["shown"] == 5 and not last["more"] and last["rows"][0] == ["000020"]
