"""The Data module: browse a page of any file through a view, count, combine many files
into one Parquet, export a view — and the file plumbing the PDF module uses."""

from __future__ import annotations

import base64
import sys
import types

import openpyxl
import polars as pl
import pytest

import datamgr as D

sys.modules.setdefault("webview", types.SimpleNamespace(windows=[]))
import app  # noqa: E402


@pytest.fixture
def files(tmp_path):
    a = tmp_path / "a.csv"
    a.write_text("DOC_NO,AMOUNT,TAX\n" + "\n".join(f"E{i:03d},{[9, 10, 100, 2.5][i % 4] + i},{['YQ', 'YR', 'XT'][i % 3]}"
                                                    for i in range(60)) + "\n", encoding="utf-8")
    b = tmp_path / "b.parquet"
    pl.DataFrame({"DOC_NO": [f"P{i}" for i in range(40)], "AMOUNT": [float(i) for i in range(40)],
                  "EXTRA": ["x"] * 40}).write_parquet(b)
    x = tmp_path / "c.xlsx"
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["DOC_NO", "AMOUNT", "TAX"])
    for i in range(25):
        ws.append([f"X{i}", i * 2, "YQ"])
    wb.save(x)
    return tmp_path, {"a": str(a), "b": str(b), "c": str(x)}


def test_a_first_page_reads_only_the_start_and_pages_on(files):
    _, f = files
    r = D.browse({"path": f["a"], "limit": 25})
    assert r["ok"] and not r["whole"] and r["more"] and len(r["rows"]) == 25
    assert r["columns"] == ["DOC_NO", "AMOUNT", "TAX"] and r["rows"][0][0] == "E000"
    nxt = D.browse({"path": f["a"], "limit": 25, "offset": 50})
    assert [row[0] for row in nxt["rows"]] == [f"E{i:03d}" for i in range(50, 60)] and not nxt["more"]
    pq = D.browse({"path": f["b"], "limit": 5})
    assert pq["total"] == 40 and pq["dtypes"] == ["String", "Float64", "String"]
    xl = D.browse({"path": f["c"], "limit": 5})
    assert xl["rows"][0] == ["X0", "0", "YQ"] and xl["more"]


def test_a_view_filters_sorts_by_number_and_picks_columns(files):
    _, f = files
    view = {"columns": ["AMOUNT", "DOC_NO"], "filters": [{"column": "TAX", "op": "equals", "value": "yq"}],
            "sort": {"column": "AMOUNT", "desc": False}}
    r = D.browse({"path": f["a"], "view": view, "limit": 100})
    assert r["whole"] and r["columns"] == ["AMOUNT", "DOC_NO"]
    amounts = [float(row[0]) for row in r["rows"]]
    assert amounts == sorted(amounts) and len(amounts) == 20, "9 sorts before 10: by number, not text"
    either = D.browse({"path": f["a"], "view": {"join": "or", "filters": [
        {"column": "TAX", "op": "equals", "value": "XT"}, {"column": "DOC_NO", "op": "equals", "value": "E000"}]}, "limit": 100})
    assert len(either["rows"]) == 21
    dist = D.browse({"path": f["a"], "view": {"columns": ["TAX"], "unique": True}, "limit": 100})
    assert sorted(row[0] for row in dist["rows"]) == ["XT", "YQ", "YR"]
    with pytest.raises(ValueError, match="No column NOPE"):
        D.browse({"path": f["a"], "view": {"filters": [{"column": "NOPE", "op": "equals", "value": "1"}]}})


def test_count_goes_file_by_file(files):
    _, f = files
    r = D.count({"files": [f["a"], f["b"], f["c"]], "view": {"filters": [{"column": "AMOUNT", "op": "gt", "value": "30"}]}})
    assert r["ok"] and [x["rows"] for x in r["files"]] == [sum(1 for i in range(60) if [9, 10, 100, 2.5][i % 4] + i > 30), 9, 9]
    assert r["total"] == sum(x["rows"] for x in r["files"])


def test_combine_stacks_every_file_into_one_typed_parquet(files):
    tmp, f = files
    r = D.combine({"files": [f["a"], f["b"], f["c"]], "folder": str(tmp / "out"), "name": "all", "compression": "snappy"})
    assert r["ok"] and r["rows"] == 125, r
    got = pl.read_parquet(tmp / "out" / "all.parquet")
    assert got.columns == ["DOC_NO", "AMOUNT", "TAX", "EXTRA", "SOURCE_FILE"]
    assert got.schema["AMOUNT"] == pl.Float64 and got.schema["DOC_NO"] == pl.String
    assert got.filter(pl.col("SOURCE_FILE") == "b.parquet")["TAX"].null_count() == 40, "a missing column is blank"
    # through a view, without types or the source column
    r = D.combine({"files": [f["a"], f["c"]], "folder": str(tmp / "out"), "name": "yq", "detect": False, "add_source": False,
                   "view": {"filters": [{"column": "TAX", "op": "equals", "value": "YQ"}], "columns": ["DOC_NO", "AMOUNT"],
                            "sort": {"column": "AMOUNT", "desc": True}}})
    got = pl.read_parquet(tmp / "out" / "yq.parquet")
    assert got.columns == ["DOC_NO", "AMOUNT"] and got.schema["AMOUNT"] == pl.String and got.height == 45
    nums = [float(v) for v in got["AMOUNT"]]
    assert nums == sorted(nums, reverse=True)


def test_export_one_file_or_one_per_input(files):
    tmp, f = files
    out = tmp / "ex"
    r = D.export({"files": [f["a"], f["b"]], "folder": str(out), "name": "both", "format": "xlsx", "add_source": True,
                  "view": {"sort": {"column": "AMOUNT", "desc": True}}})
    assert r["ok"] and r["rows"] == 100 and r["written"] == [str(out / "both.xlsx")]
    ws = openpyxl.load_workbook(out / "both.xlsx").active
    rows = list(ws.iter_rows(values_only=True))
    assert rows[0] == ("DOC_NO", "AMOUNT", "TAX", "EXTRA", "SOURCE_FILE") and len(rows) == 101
    amounts = [float(r[1]) for r in rows[1:]]
    assert amounts == sorted(amounts, reverse=True), "sorted across both files"
    r = D.export({"files": [f["a"], f["c"]], "folder": str(out), "name": "each", "format": "csv", "mode": "per_file",
                  "view": {"columns": ["DOC_NO"]}})
    assert sorted(p.split("/")[-1].split("\\")[-1] for p in r["written"]) == ["each_a.csv", "each_c.csv"]
    assert (out / "each_c.csv").read_text(encoding="utf-8-sig").splitlines()[:2] == ["DOC_NO", "X0"]
    r = D.export({"files": [f["b"]], "folder": str(out), "name": "pq", "format": "parquet"})
    assert pl.read_parquet(out / "pq.parquet").schema["AMOUNT"] == pl.Float64
    assert not D.export({"files": [f["a"]], "format": "csv"})["ok"], "a folder is needed"


def test_write_rows_as_csv_excel_or_parquet(tmp_path):
    for ext in ("csv", "xlsx", "parquet"):
        r = D.write_rows({"path": str(tmp_path / f"t.{ext}"), "columns": ["A", "B"], "rows": [["1", "x"], ["2"]]})
        assert r["ok"] and r["rows"] == 2
    assert pl.read_parquet(tmp_path / "t.parquet").to_dicts() == [{"A": 1, "B": "x"}, {"A": 2, "B": None}]
    assert list(openpyxl.load_workbook(tmp_path / "t.xlsx").active.iter_rows(values_only=True))[1][1] == "x"


# ---- the PDF module's file plumbing ------------------------------------------

def test_files_go_in_and_out_a_chunk_at_a_time(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "CHUNK", 1000)
    api = app.Api()
    blob = bytes(range(256)) * 20                     # 5,120 bytes: six chunks
    src = tmp_path / "in.pdf"
    src.write_bytes(blob)
    got, off = b"", 0
    while True:
        r = api.file_read({"path": str(src), "offset": off})
        assert r["ok"] and r["size"] == len(blob)
        got += base64.b64decode(r["b64"])
        off = r["next"]
        if r["done"]:
            break
    assert got == blob
    assert not api.file_read({"path": str(tmp_path / "x.exe")})["ok"], "only PDFs and images are read"
    b = api.file_save_begin({"folder": str(tmp_path / "out"), "filename": "copy.pdf"})
    for i in range(0, len(blob), 777):
        assert api.file_save_chunk({"token": b["token"], "b64": base64.b64encode(blob[i:i + 777]).decode()})["ok"]
    e = api.file_save_end({"token": b["token"]})
    assert e["ok"] and (tmp_path / "out" / "copy.pdf").read_bytes() == blob
    b2 = api.file_save_begin({"folder": str(tmp_path / "out"), "filename": "copy.pdf", "overwrite": False})
    assert b2["path"].endswith("copy (1).pdf")
    api.file_save_end({"token": b2["token"], "abort": True})
    assert not (tmp_path / "out" / "copy (1).pdf").exists() and not list((tmp_path / "out").glob("*.part"))
    assert not api.file_save_begin({"path": str(tmp_path / "evil.bat")})["ok"]


def test_pdfs_in_the_open_folders_and_the_pdf_page(tmp_path):
    (tmp_path / "sub").mkdir()
    for p in ("a.pdf", "b.PDF", "c.png", "d.csv", "sub/e.pdf"):
        (tmp_path / p).write_bytes(b"%PDF-1.4")
    api = app.Api()
    names = lambda r: [x["name"] for x in r["files"]]  # noqa: E731
    assert names(api.pdf_list({"folders": [{"path": str(tmp_path)}]})) == ["a.pdf", "b.PDF"]
    assert names(api.pdf_list({"folders": [{"path": str(tmp_path), "recursive": True}], "images": True})) == \
        ["a.pdf", "b.PDF", "c.png", "e.pdf"]
    r = api.pdf_html()
    assert r["ok"]
    html = r["html"]
    assert "/*@VENDOR" not in html and "/*@APP@*/" not in html
    assert "globalThis.pdfjsLib" in html and "PDFLib" in html and "window.pdfApp" in html
    # the libraries are inlined: only the page's own script tags close
    assert html.count("</script>") == 4
