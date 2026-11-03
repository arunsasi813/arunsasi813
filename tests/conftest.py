"""Shared fixtures: a small month of extracts in two folders, and a private place for
setups and the workbook cache so tests never touch the real ones."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

CODES = [("XT", "Airport tax", "5"), ("YQ", "Fuel surcharge", "12.5"), ("YR", "Carrier fee", "3")]


def write_sales(path: Path, month: int, n: int = 36, start: int = 0) -> None:
    rows = ["DOC_NO,TAX_CODE,AMOUNT,ISSUE_DATE,CURRENCY"]
    for i in range(n):
        k = start + i
        rows.append(f"E{month}{k:04d},{['XT', 'YQ', 'YR', 'ZR'][k % 4]},{35.5 + (k * 37) % 900:.2f},"
                    f"{(i % 28) + 1:02d}/{month:02d}/2026,{'USD' if k % 2 else 'AED'}")
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")


def write_codes(path: Path) -> None:
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Codes"
    ws.append(["TAX_CODE", "DESCRIPTION", "RATE"])
    for r in CODES:
        ws.append(list(r))
    wb.save(path)


def write_refunds(path: Path) -> None:
    path.write_text("DOC_NO|TAX_CODE|AMOUNT\nR0001|YQ|-40.00\nR0002|XT|-12.50\nR0003|YQ|-7.25\n",
                    encoding="utf-8")


@pytest.fixture(autouse=True)
def private_dirs(tmp_path, monkeypatch):
    """Setups and the workbook cache live under the test's own folder."""
    monkeypatch.setenv("COLSIFT_PROFILES", str(tmp_path / "profiles"))
    monkeypatch.setenv("COLSIFT_CACHE", str(tmp_path / "cache"))
    (tmp_path / "profiles").mkdir()
    import engine as E

    monkeypatch.setattr(E, "_PROFILE_DIR", None, raising=False)
    monkeypatch.setattr(E, "_CACHE_DIR", None, raising=False)
    E.clear_cache()
    yield


@pytest.fixture
def data(tmp_path):
    """jan/ holds January's sales and the codes workbook; feb/ February's sales and refunds."""
    jan, feb = tmp_path / "jan", tmp_path / "feb"
    jan.mkdir()
    feb.mkdir()
    write_sales(jan / "sales_JAN.csv", 1)
    write_sales(feb / "sales_FEB.csv", 2, start=36)
    write_codes(jan / "codes.xlsx")
    write_refunds(feb / "refunds_FEB.txt")
    files = {"jan": jan / "sales_JAN.csv", "feb": feb / "sales_FEB.csv", "codes": jan / "codes.xlsx",
             "refunds": feb / "refunds_FEB.txt"}
    return tmp_path, files


def cols(*names: str) -> list[dict]:
    return [{"name": n, "include": True} for n in names]


def rule(column: str, op: str, value: str = "") -> dict:
    return {"type": "group", "mode": "and", "children": [{"type": "rule", "column": column, "op": op, "value": value}]}
