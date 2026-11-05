"""Find: values from a file's column, cleaned keys, ends-with, every match exported
with what was not found; and a column's profile."""

from __future__ import annotations

import openpyxl
import polars as pl

import engine as E
from conftest import cols


def ledger(tmp):
    (tmp / "ledger.csv").write_text(
        "DOC,AMOUNT,NOTE\n000123,10,a\n456.0,20,b\nAB-77,30,c\n9988,40,x\n000123,50,again\n", encoding="utf-8")
    return tmp / "ledger.csv"


def test_cleaned_keys_match_what_plain_matching_misses(tmp_path):
    f = ledger(tmp_path)
    job = {"files": [str(f)], "columns": cols("DOC", "AMOUNT")}
    plain = E.find(job, {"values": "123\n456\nab77", "scope": "column", "column": "DOC"})
    assert plain["total"] == 0 and plain["missing"] == ["123", "456", "ab77"]
    clean = E.find(job, {"values": "123\n456\nab77\n555", "scope": "column", "column": "DOC",
                         "zeros": True, "intlike": True, "symbols": True})
    assert clean["total"] == 4, clean
    assert clean["missing"] == ["555"] and clean["found"] == 3


def test_ends_with(tmp_path):
    f = ledger(tmp_path)
    r = E.find({"files": [str(f)]}, {"values": "88", "mode": "ends", "scope": "column", "column": "DOC"})
    assert r["total"] == 1 and r["rows"][0][0] == "9988"


def test_export_every_match_with_keys_and_not_found(data):
    tmp, f = data
    vals = "\n".join([f"E1{k:04d}" for k in range(0, 36, 3)] + ["E2004" + "0", "NOPE1", "NOPE2"])
    job = {"files": [str(f["jan"]), str(f["feb"])],
           "output": {"folder": str(tmp / "o"), "basename": "tickets", "format": "xlsx"}}
    r = E.find_export(job, {"values": vals, "scope": "column", "column": "DOC_NO"})
    assert r["ok"], r
    assert r["rows"] == 13 and r["missing"] == ["NOPE1", "NOPE2"]
    wb = openpyxl.load_workbook(tmp / "o" / "tickets_matches.xlsx")
    rows = list(wb["Matches"].iter_rows(values_only=True))
    assert rows[0][:3] == ("SOURCE_FILE", "MATCHED_IN", "MATCH_KEY") and len(rows) == 14
    assert {r[0] for r in rows[1:]} == {"sales_JAN.csv", "sales_FEB.csv"}
    assert [c[0] for c in wb["Not found"].iter_rows(values_only=True)] == ["NOT_FOUND", "NOPE1", "NOPE2"]
    # csv: the matches and the list as two files; parquet: the list in a workbook
    job["output"]["format"] = "csv"
    r = E.find_export(job, {"values": vals, "scope": "all"})
    assert sorted(p.split("/")[-1].split("\\")[-1] for p in r["written"]) == ["tickets_matches.csv", "tickets_not_found.csv"]
    job["output"]["format"] = "parquet"
    r = E.find_export(job, {"values": vals, "scope": "all"})
    assert pl.read_parquet(tmp / "o" / "tickets_matches.parquet").height == 13
    assert (tmp / "o" / "tickets_not_found.xlsx").exists()


def test_values_come_from_a_column_of_a_workbook(tmp_path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Requested by finance"])
    ws.append([])
    ws.append(["Line", "Document No", "Comment"])
    for i, d in enumerate(["A1", "A2", "A2", "", "A9"]):
        ws.append([i + 1, d, "x"])
    wb.save(tmp_path / "list.xlsx")
    r = E.key_list(str(tmp_path / "list.xlsx"))
    assert r["ok"] and r["column"] == "Document No", r
    assert r["values"] == ["A1", "A2", "A2", "A9"] and r["unique"] == 3
    assert E.key_list(str(tmp_path / "list.xlsx"), "comment")["column"] == "Comment"


def test_column_profile(data):
    tmp, f = data
    job = {"files": [str(f["jan"]), str(f["feb"])], "active": str(f["jan"])}
    amt = E.column_stats(job, "AMOUNT")
    assert amt["ok"] and amt["kind"] == "number" and amt["rows"] == 36 and amt["files"] == 1
    assert abs(amt["sum"] - pl.read_csv(f["jan"])["AMOUNT"].sum()) < 1e-6
    code = E.column_stats(job, "TAX_CODE", "all")
    assert code["kind"] == "text" and code["rows"] == 72 and code["distinct"] == 4
    assert code["top"][0][1] == 18 and not code["unique_key"]
    assert E.column_stats(job, "DOC_NO", "all")["unique_key"]
    assert E.column_stats(job, "ISSUE_DATE")["kind"] == "date"
