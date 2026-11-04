"""Duplicates across all files: found over every file together, after each file's own work."""

from __future__ import annotations

import openpyxl
import polars as pl
import pytest

import engine as E
import workspace as W
from conftest import cols


@pytest.fixture
def months(tmp_path):
    a, b = tmp_path / "jan.csv", tmp_path / "feb.csv"
    a.write_text("DOC_NO,AMOUNT\nA1,10\nA2,20\nA3,30\n,5\n", encoding="utf-8")
    b.write_text("DOC_NO,AMOUNT\na3 ,31\nA4,40\nA4,41\n,6\n", encoding="utf-8")
    return tmp_path, [str(a), str(b)]


def job(tmp, files, keep, **extra):
    return {"files": files, "columns": cols("DOC_NO", "AMOUNT"),
            "batch_dupes": {"keys": ["DOC_NO"], "keep": keep, "count_col": "DUP_COUNT", "files_col": "DUP_FILES",
                            "occ_col": "DUP_NO"},
            "output": {"folder": str(tmp / "out"), "basename": keep, "format": "csv", **extra}}


def rows(path):
    return pl.read_csv(path, infer_schema=False).rows()


def test_every_row_marked_across_files(months):
    tmp, files = months
    r = E.run(job(tmp, files, "all"))
    assert r["ok"], r
    got = rows(r["written"][0])
    # (DOC_NO, AMOUNT, count, files, occurrence) — "a3 " matches "A3" (trimmed, any case)
    assert got == [("A1", "10", "1", "1", "1"), ("A2", "20", "1", "1", "1"), ("A3", "30", "2", "2", "1"),
                   (None, "5", "1", "1", "1"), ("a3", "31", "2", "2", "2"), ("A4", "40", "2", "1", "1"),
                   ("A4", "41", "2", "1", "2"), (None, "6", "1", "1", "1")]


@pytest.mark.parametrize("keep, want", [
    ("dups", ["30", "31", "40", "41"]),
    ("files", ["30", "31"]),
    ("first", ["10", "20", "30", "5", "40", "6"]),
    ("last", ["10", "20", "5", "31", "41", "6"]),
    ("unique", ["10", "20", "5", "6"]),
])
def test_what_to_keep(months, keep, want):
    tmp, files = months
    r = E.run(job(tmp, files, keep))
    assert [x[1] for x in rows(r["written"][0])] == want


def test_one_output_per_input_gets_its_own_rows_back(months):
    tmp, files = months
    r = E.run(job(tmp, files, "dups", mode="per_file"))
    assert r["ok"], r
    out = sorted(r["written"])
    assert [x[1] for x in rows(out[0])] == ["31", "40", "41"]          # feb
    assert [x[1] for x in rows(out[1])] == ["30"]                      # jan


def test_count_and_full_analysis_see_it(months):
    tmp, files = months
    j = job(tmp, files, "dups")
    c = E.count_rows(j)
    assert c["ok"] and c["total"] == 4 and [f["rows"] for f in c["files"]] == [1, 3], c
    j["analysis"] = {"items": [{"id": "k", "kind": "kpi", "values": [{"column": "AMOUNT", "agg": "sum"}]}]}
    res = E.analyse(j, "all")
    assert res["items"][0]["table"]["rows"][0]["nums"][-1] == 142


def test_a_key_the_output_lacks_is_explained(months):
    tmp, files = months
    j = job(tmp, files, "dups")
    j["columns"] = cols("AMOUNT")
    r = E.run(j)
    assert not r["ok"] and "keep it on the Columns tab" in r["error"]


def test_a_group_in_a_combined_setup(months):
    tmp, files = months
    ws = {"groups": [{"name": "Docs", "files": files, "setup": job(tmp, files, "files")},
                     {"name": "Other", "files": files[:1], "setup": {"columns": cols("DOC_NO")}}],
          "output": {"folder": str(tmp / "o"), "format": "xlsx", "basename": "m"}}
    sc = {t["name"]: t["columns"] for t in W.schema(ws)["tables"]}
    assert sc["Docs"] == ["DOC_NO", "AMOUNT", "DUP_COUNT", "DUP_FILES", "DUP_NO"]
    r = W.run_setup(ws)
    assert r["ok"], r
    docs = list(openpyxl.load_workbook(r["written"][0])["Docs"].iter_rows(values_only=True))
    assert [x[1] for x in docs[1:]] == [30, 31]          # combined runs write real numbers
