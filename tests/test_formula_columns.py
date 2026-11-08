"""Formulas that use the columns added above them, and the same column several times."""

from __future__ import annotations

import polars as pl

import engine as E
import formula as F
from conftest import cols


def job_for(f, adds, keep=("DOC_NO",)):
    return {"files": [str(f)], "columns": cols(*keep),
            "add_columns": [{"name": n, "kind": "formula", "value": v} for n, v in adds]}


def run(f, job, notes=None):
    return E.build_pipeline(E.Source.from_dict({"path": str(f)}), job, notes=notes).collect()


def test_a_formula_can_use_added_columns_above_it(tmp_path):
    f = tmp_path / "a.csv"
    f.write_text("DOC_NO,AMOUNT,TAX,Pax Name\n1,10,YQ,Ann\n2,20,YR,Bo\n", encoding="utf-8")
    notes: list[str] = []
    # LABEL reads TAX (never kept, never used above) and DOUBLE (made above it), twice each
    got = run(f, job_for(f, [("DOUBLE", "AMOUNT * 2"),
                             ("LABEL", 'TAX & "-" & DOUBLE & "-" & TAX & [DOUBLE] & [Pax Name]')]), notes)
    assert got["LABEL"].to_list() == ["YQ-20-YQ20Ann", "YR-40-YR40Bo"]
    assert notes == [], "no column is wrongly reported missing"


def test_a_formula_cannot_use_a_column_added_below_it(tmp_path):
    f = tmp_path / "a.csv"
    f.write_text("DOC_NO,AMOUNT\n1,10\n", encoding="utf-8")
    try:
        run(f, job_for(f, [("FIRST", "LATER + 1"), ("LATER", "AMOUNT")]))
    except ValueError as exc:
        assert "FIRST" in str(exc) and "LATER" in str(exc)
    else:
        raise AssertionError("a column made below can't be read above it")


def test_an_added_column_may_replace_a_file_column_and_still_read_it(tmp_path):
    f = tmp_path / "a.csv"
    f.write_text("DOC_NO,AMOUNT\n1,10\n2,5\n", encoding="utf-8")
    got = run(f, job_for(f, [("AMOUNT", "AMOUNT * 3"), ("TWICE", "AMOUNT + AMOUNT")]))
    assert got["AMOUNT"].to_list() == ["30", "15"] and got["TWICE"].to_list() == ["60", "30"]


def test_check_knows_the_added_columns_it_is_given():
    assert F.check("DOUBLE * AMOUNT", ["AMOUNT"])["ok"] is False
    r = F.check("DOUBLE * AMOUNT + [DOUBLE]", ["AMOUNT", "DOUBLE"])
    assert r["ok"] and r["columns"] == ["AMOUNT", "DOUBLE"]
    assert pl.DataFrame({"AMOUNT": ["2"], "DOUBLE": ["4"]}).select(
        F.num_expr("DOUBLE * AMOUNT + [DOUBLE]", ["AMOUNT", "DOUBLE"])).item() == 12
