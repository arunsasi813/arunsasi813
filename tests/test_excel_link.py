"""Excel link (excel_link.py + LauncherAPI.excel_link_*): export, read back, status, manifests."""

import builtins
import copy
import datetime as dt
import decimal
import hashlib
import importlib.util
import json
import os
import platform
import re
import shutil
import sys
import threading
import time
import types
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
import excel_link  # noqa: E402
import folder_manager as fm  # noqa: E402
import main  # noqa: E402

_spec = importlib.util.spec_from_file_location("xl_edit", REPO / "tests" / "e2e" / "xl_edit.py")
xl_edit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(xl_edit)

openpyxl = pytest.importorskip("openpyxl")


# ──────────────────────────────────────────────────────────────────────────────
# Fixtures (same root/api pattern as test_launcher.py)
# ──────────────────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def xl_env(tmp_path, monkeypatch):
    monkeypatch.setenv("RECO_XL_WORK_DIR", str(tmp_path / "xlwork"))
    monkeypatch.setenv("RECO_XL_NO_LAUNCH", "1")


@pytest.fixture
def root(tmp_path, monkeypatch):
    r = tmp_path / "root"
    (r / "apps").mkdir(parents=True)
    (r / "apps" / "Reco.html").write_text("<html></html>")
    (r / "master").mkdir()
    (r / "master" / "user.csv").write_text("ID,Name,Email,reco\r\ntester,Test User,t@x.com,1\r\n")
    monkeypatch.setattr(main, "_os_user", lambda: "tester")
    return r


@pytest.fixture
def api(root, tmp_path):
    cfg = tmp_path / "launcher_config.json"
    cfg.write_text(json.dumps({"folder_path": str(root)}))
    return main.LauncherAPI(config_path=cfg)


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

EID = "X20261006T104233-k3f9"


def col(key, kind="text", editable=False, **kw):
    c = {"key": key, "header": key, "kind": kind, "editable": editable, "hidden": False, "widthPx": 100}
    c.update(kw)
    return c


ID_COLS = [col("__reco_row_id", "id", hidden=True, widthPx=90), col("__reco_key", "id", hidden=True, widthPx=90),
           {**col("_status_", "status"), "header": "Reco Status"}]
COLS = ID_COLS + [
    col("Doc", note="Read-only — changes here are ignored"),
    col("Status", editable=True, list="RecoList_1", strict=True, editor="list", note="Editable · dropdown (strict)"),
    col("Remarks", editable=True, editor="text", note="Editable"),
    col("When", "date", editable=True, editor="date"),
    col("Amount", "value", note="Read-only"),
]
BASE_COLS = ["Status", "Remarks", "When"]


def make_head(n, eid=EID, cols=None, **over):
    cols = cols or COLS
    head = {
        "api": 1, "exportId": eid, "tplId": "tpl1", "tplName": "Bank Reco", "dataFolder": "bank_reco",
        "user": "tester", "area": "shared", "fileName": f"Bank_Reco_20261006-1042_{eid[-4:]}.xlsx",
        "rowCount": n, "sheetName": "Reco Data", "protect": "soft", "dateFormat": "dd-mmm-yyyy",
        "valueFormat": "#,##0.00;(#,##0.00)", "includeBase": True, "allowNewRows": False, "newRowBuffer": 0,
        "columns": cols,
        "lists": {"RecoList_1": {"title": "Status", "values": ["Open", "Cleared"]}},
        "meta": {"format": "1", "exportId": eid, "tplId": "tpl1", "tplName": "Bank Reco", "dataFolder": "bank_reco",
                 "dataSheet": "Reco Data", "headerRow": "1", "exportedAt": "2026-10-06T06:42:33.120Z",
                 "exportedBy": "tester", "tplSignature": "abc", "protect": "soft", "rowCount": str(n),
                 "columnsJson": json.dumps(cols)},
        "readme": [["Bank Reco — edit in Excel"], ["1.", "Edit the yellow columns"],
                   [{"v": "Editable", "fill": "FFF9DB"}, "yellow cells"]],
        "manifest": {"format": 1, "exportId": eid, "tplId": "tpl1", "tplName": "Bank Reco",
                     "dataFolder": "bank_reco", "tier": "P", "exportedAt": "2026-10-06T06:42:33.120Z",
                     "exportedBy": "tester", "scope": "view", "columnsMode": "asShown", "protect": "soft",
                     "session": {"activeVersionFile": "reco_data/x/06.csv", "rowCount": n, "exportedRows": n},
                     "tplSignature": "abc", "columns": [], "baseCols": BASE_COLS, "fpCols": ["Doc", "Amount"]},
    }
    head.update(over)
    return head


def rid(i):
    return f"r{i:05d}"


def make_rows(n):
    cells, base = [], []
    for i in range(n):
        st = "Cleared" if i % 3 == 0 else "Open"
        when = f"2026-10-{(i % 28) + 1:02d}" if i % 5 else None
        rem = f"note {i}" if i % 2 else None
        cells.append([rid(i), f"D{i}", "Offset" if i % 4 == 0 else "Open", f"{i:06d}", st, rem, when,
                      round((i - 50) * 10.25, 2)])
        base.append([rid(i), f"D{i}", "fp", "", st, rem or "", f"D:{when}" if when else ""])
    return cells, base


def wait_job(api, job_id, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = api.excel_link_job(job_id)
        assert j["ok"], j
        if j["state"] != "running":
            return j
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def export(api, head, cells, base, chunk=5000):
    r = api.excel_link_export_begin(head)
    assert r["ok"], r
    for i in range(0, len(cells), chunk):
        rr = api.excel_link_export_rows(r["token"], cells[i:i + chunk], base[i:i + chunk])
        assert rr["ok"], rr
    f = api.excel_link_export_finish(r["token"])
    assert f["ok"], f
    j = wait_job(api, f["job_id"])
    assert j["state"] == "done", j
    return j["result"]


def do_export(api, root, n=10, **over):
    cells, base = make_rows(n)
    res = export(api, make_head(n, **over), cells, base)
    path = root / res["rel"] if res["rel"] else Path(os.environ["RECO_XL_WORK_DIR"]) / res["name"]
    return res, path


def read(api, source, opts=None):
    r = api.excel_link_read_start(source, opts or {})
    assert r["ok"], r
    j = wait_job(api, r["job_id"])
    rows = []
    if j["state"] == "done":
        off = 0
        while True:
            p = api.excel_link_read_page(r["job_id"], off, 2000)
            assert p["ok"], p
            rows += p["rows"]
            if p["next"] is None:
                break
            off = p["next"]
        assert api.excel_link_job_release(r["job_id"]) is True
    return j, rows


def links_dir(root):
    return root / "reco_excel" / "bank_reco" / "_links"


def sheet_xml(path, name="Reco Data"):
    with zipfile.ZipFile(path) as z:
        return z.read(excel_link._sheet_part(z, name)).decode("utf-8")


def zip_replace(path, member, fn):
    tmp = Path(str(path) + ".tmp")
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == member:
                data = fn(data.decode("utf-8")).encode("utf-8")
            zout.writestr(item, data)
    os.replace(tmp, path)


def data_part(path, name="Reco Data"):
    with zipfile.ZipFile(path) as z:
        return excel_link._sheet_part(z, name)


def engine(api):
    return api._xlink()


def edit_head(root, eid, fn):
    hp = links_dir(root) / f"{eid}.json"
    head = json.loads(hp.read_text(encoding="utf-8"))
    fn(head)
    hp.write_text(json.dumps(head), encoding="utf-8")


# ──────────────────────────────────────────────────────────────────────────────
# 1-4  capabilities and export
# ──────────────────────────────────────────────────────────────────────────────

def test_capabilities_shape(api):
    r = api.excel_link_capabilities()
    json.dumps(r)
    assert r["ok"] and r["api"] == 1
    assert r["openpyxl"] == openpyxl.__version__ == "3.1.5"
    for k in ("pywin32", "platform", "handler", "localWorkDir", "limits"):
        assert k in r
    assert r["handler"]["kind"] in ("excel", "libreoffice", "other", "none")
    assert r["limits"] == {**r["limits"], "maxRows": 1048575, "maxCols": 16384, "chunkRows": 5000}


def test_capabilities_without_openpyxl(api, monkeypatch):
    monkeypatch.setattr(excel_link, "_openpyxl_version", lambda: None)
    assert api.excel_link_capabilities()["openpyxl"] is None
    r = api.excel_link_export_begin(make_head(1))
    assert r == {**r, "ok": False, "code": "no_openpyxl"}


def test_export_types_and_layout(api, root):
    cols = ID_COLS + [
        col("T1", editable=True, list="RecoList_1", editor="list", note="Editable · dropdown"),
        col("T2"), col("T3"),
        col("D1", "date", editable=True), col("V1", "value"), col("V2", "value"),
        col("V3", "value", editable=True), col("T4", editable=True)]
    head = make_head(1, cols=cols, lists={"RecoList_1": {"title": "T1", "values": ["000123", "X"]}})
    big = [{"key": f"k{i}", "pad": "x" * 1000} for i in range(70)]
    head["meta"]["columnsJson"] = json.dumps(big)                  # > 2 chunks of 30,000
    head["manifest"]["baseCols"] = ["T1"]
    row = ["r1", "k1", "Open", "000123", "#N/A", '=HYPERLINK("x")', "2026-10-06", 1234.5, -10, {"s": "N/A"}, None]
    res = export(api, head, [row], [["r1", "k1", "fp", "", "000123"]])
    p = root / res["rel"]
    assert res["rows"] == 1 and res["cols"] == len(cols) and isinstance(res["mtimeNs"], str)

    wb = openpyxl.load_workbook(p)
    ws = wb["Reco Data"]
    data = [ws.cell(2, c) for c in range(4, 12)]
    assert [c.value for c in data[:3]] == ["000123", "#N/A", '=HYPERLINK("x")']
    assert [c.data_type for c in data[:3]] == ["s", "s", "s"]            # never a formula / error
    assert data[3].value == dt.datetime(2026, 10, 6) and data[3].is_date
    assert data[4].value == 1234.5 and data[5].value == -10 and data[6].value == "N/A" and data[7].value is None
    assert [c.style for c in data] == ["Reco Ed Text", "Reco RO Text", "Reco RO Text", "Reco Ed Date",
                                       "Reco RO Value", "Reco RO Value", "Reco Ed Value", "Reco Ed Text"]
    assert data[0].number_format == "@" and data[3].number_format == "dd-mmm-yyyy"
    assert data[4].number_format == "#,##0.00;(#,##0.00)"
    assert ws["A2"].style == "Reco Id" and ws["A1"].style == "Reco Hdr Id" and ws["D1"].style == "Reco Hdr Ed"
    assert ws.column_dimensions["A"].hidden and ws.column_dimensions["B"].hidden
    assert not ws.column_dimensions["D"].hidden
    assert ws.freeze_panes == "D2"
    assert ws.auto_filter.ref == "A1:K2"
    lists_dv = [d for d in ws.data_validations.dataValidation if d.type == "list"]
    assert [d.formula1 for d in lists_dv] == ["RecoList_1"] and str(lists_dv[0].sqref) == "D2"
    assert wb.defined_names["RecoList_1"].attr_text == "'Lists'!$A$2:$A$3"
    assert wb["Lists"].sheet_state == "hidden" and wb["_reco_meta"].sheet_state == "veryHidden"
    assert wb["_reco_base"].sheet_state == "veryHidden"
    assert [s.title for s in wb.worksheets] == ["Reco Data", "How to use", "Lists", "_reco_meta", "_reco_base"]
    assert ws["D1"].comment is not None and "dropdown" in ws["D1"].comment.text
    assert wb.properties.creator == "tester" and wb.properties.title == "Bank Reco"
    assert wb["How to use"]["A1"].font.b and wb["How to use"].protection.sheet

    meta = {r[0]: r[1] for r in wb["_reco_meta"].iter_rows(values_only=True)}
    chunks = sorted((k for k in meta if k.startswith("columnsJson.")), key=lambda k: int(k.split(".")[1]))
    assert len(chunks) >= 3 and all(len(meta[k]) <= 30000 for k in chunks)
    assert json.loads("".join(meta[k] for k in chunks)) == big
    assert meta["exportId"] == EID and meta["dataSheet"] == "Reco Data" and meta["area"] == "shared"
    assert meta["manifestRel"] == f"reco_excel/bank_reco/_links/{EID}.json"

    # The reader returns the same values as typed raw cells.
    j, rows = read(api, {"exportId": EID}, {"elide": False})
    assert rows[0]["cells"][3:] == [["s", "000123"], ["s", "#N/A"], ["s", '=HYPERLINK("x")'],
                                    ["d", "2026-10-06T00:00:00"], ["n", 1234.5], ["n", -10], ["s", "N/A"], None]
    assert j["result"]["meta"]["columns"] == big


def test_protection_modes(api, root):
    out = {}
    for i, mode in enumerate(("soft", "locked", "none")):
        eid = f"X20261006T10423{i}-ab1{i}"
        res, p = do_export(api, root, 4, eid=eid, protect=mode)
        out[mode] = (p, sheet_xml(p))
    soft, locked, none = (out[m][1] for m in ("soft", "locked", "none"))

    assert 'sheet="1"' not in soft and "<sheetProtection" not in soft
    guards = re.findall(r'<dataValidation sqref="([^"]+)"[^>]*type="custom"[^>]*><formula1>FALSE</formula1>', soft)
    assert guards == ["A2:D5", "H2:H5"]                       # id, key, status, Doc | Amount

    prot = re.search(r"<sheetProtection[^>]*>", locked).group(0)
    for attr in ('sheet="1"', 'autoFilter="0"', 'sort="0"', 'formatCells="0"', 'formatColumns="0"',
                 'insertRows="1"', 'deleteRows="1"'):
        assert attr in prot, attr
    assert "<formula1>FALSE</formula1>" not in locked
    wb = openpyxl.load_workbook(out["locked"][0])
    ws = wb["Reco Data"]
    assert ws["E2"].protection.locked is False and ws["D2"].protection.locked is True
    assert [ws.cell(1, c).value for c in (9, 10, 11)] == list(excel_link.SCRATCH_COLS)
    assert all(ws.column_dimensions[L].protection.locked is False for L in "IJK")
    assert ws.auto_filter.ref == "A1:K5"

    assert "<sheetProtection" not in none and "<formula1>FALSE</formula1>" not in none
    # Lists and How to use are always protected.
    for p, _ in out.values():
        wb = openpyxl.load_workbook(p)
        assert wb["Lists"].protection.sheet and wb["How to use"].protection.sheet


def test_new_row_buffer(api, root):
    res, p = do_export(api, root, 3, allowNewRows=True, newRowBuffer=5)
    ws = openpyxl.load_workbook(p)["Reco Data"]
    dvs = {str(d.sqref): d for d in ws.data_validations.dataValidation}
    assert dvs["E2:E9"].type == "list" and dvs["G2:G9"].type == "date"
    assert dvs["A2:D4"].formula1 == "FALSE"                 # guards cover the exported rows only
    assert ws.auto_filter.ref == "A1:H9"
    assert ws.column_dimensions["E"].protection.locked is False


def test_manifest_files(api, root):
    res, p = do_export(api, root, 12)
    hp, bp = links_dir(root) / f"{EID}.json", links_dir(root) / f"{EID}.base.json"
    head, base = json.loads(hp.read_text()), json.loads(bp.read_text())
    assert len(base["rowSigs"]) == len(base["rows"]) == 12 and base["baseCols"] == BASE_COLS
    assert head["exportSha256"] == hashlib.sha256(p.read_bytes()).hexdigest() == res["sha256"]
    assert isinstance(head["exportMtimeNs"], str) and head["exportMtimeNs"] == str(p.stat().st_mtime_ns)
    assert head["exportSize"] == p.stat().st_size and head["sigWidth"] == len(COLS)
    assert head["file"] == {"area": "shared", "rel": res["rel"], "name": p.name}
    assert head["status"] == "open" and head["rev"] == 1 and head["imports"] == [] and head["lastImport"] is None
    assert head["rebased"] == {} and head["dismissed"] == {} and head["newRowSigs"] == {}
    assert head["fpCols"] == ["Doc", "Amount"] and head["session"]["exportedRows"] == 12   # JS fields kept
    assert res["rel"] == f"reco_excel/bank_reco/tester/{p.name}"
    # Never overwrite: same file name (or same export id) again.
    again = api.excel_link_export_begin(make_head(12, eid="X20261006T104233-zzzz", fileName=p.name))
    assert again["ok"] is False and again["code"] == "exists"
    assert api.excel_link_export_begin(make_head(12))["code"] == "exists"
    m = api.excel_link_manifest(EID, True)
    assert m["ok"] and m["head"]["exportId"] == EID
    assert m["base"]["baseCols"] == BASE_COLS and len(m["base"]["rows"]) == 12 and "rowSigs" not in m["base"]


def test_export_chunk_validation(api):
    r = api.excel_link_export_begin(make_head(3))
    tok = r["token"]
    cells, base = make_rows(3)
    assert api.excel_link_export_rows(tok, [cells[0][:-1]], [base[0]])["code"] == "bad_spec"
    assert api.excel_link_export_rows(tok, cells[:1], [])["code"] == "bad_spec"
    assert api.excel_link_export_rows(tok, [cells[0]] * 5001, [base[0]] * 5001)["code"] == "bad_spec"
    assert api.excel_link_export_rows(tok, json.dumps(cells[:2]), json.dumps(base[:2])) == {"ok": True, "received": 2}
    assert api.excel_link_export_finish(tok)["code"] == "row_count_mismatch"
    assert api.excel_link_export_rows(tok, cells[2:], base[2:])["received"] == 3
    assert api.excel_link_export_finish(tok)["ok"]
    assert api.excel_link_export_finish(tok)["code"] == "bad_token"
    bad = make_head(1)
    bad["columns"] = COLS + [col("Doc")]
    assert api.excel_link_export_begin(bad)["code"] == "bad_spec"            # duplicate header
    assert api.excel_link_export_begin(make_head(1, fileName="../x.xlsx"))["code"] == "bad_spec"
    assert api.excel_link_export_begin(make_head(1, fileName="x.xls"))["code"] == "bad_spec"
    assert api.excel_link_export_begin(make_head(1_048_576))["code"] == "too_large"
    assert api.excel_link_export_begin(json.dumps(make_head(1, eid="X20261006T104233-json")))["ok"]


# ──────────────────────────────────────────────────────────────────────────────
# 5-16  reading back
# ──────────────────────────────────────────────────────────────────────────────

def test_read_untouched_elides_all(api, root):
    do_export(api, root, 25)
    j, rows = read(api, {"exportId": EID})
    r = j["result"]
    assert r["rowsSent"] == 0 and rows == [] and r["rowsRead"] == 25
    assert set(r["unchangedRids"]) == {rid(i) for i in range(25)}
    assert r["manifestFound"] and r["sheetMatch"] == "meta" and r["headerRow"] == 1
    assert r["ridCol"] == 0 and r["keyCol"] == 1 and r["exportId"] == EID and r["base"] is None
    assert [h["text"] for h in r["headers"]] == [c["header"] for c in COLS]
    assert r["file"]["sha256"] == hashlib.sha256(Path(root / "reco_excel/bank_reco/tester" / r["file"]["name"])
                                                 .read_bytes()).hexdigest()
    assert isinstance(r["file"]["mtimeNs"], str) and r["file"]["ext"] == ".xlsx"
    assert not list((Path(os.environ["RECO_XL_WORK_DIR"]) / ".snap").iterdir())   # snapshot deleted


def test_read_after_edit(api, root):
    _, p = do_export(api, root, 30)
    wb = openpyxl.load_workbook(p)                 # full re-save in normal mode
    ws = wb["Reco Data"]
    ws["E3"] = "Cleared"                           # r00001 Status
    ws["F4"] = "edited"                            # r00002 Remarks
    ws["G5"] = dt.datetime(2026, 11, 1)            # r00003 When
    wb.save(p)
    j, rows = read(api, {"exportId": EID})
    r = j["result"]
    assert r["rowsSent"] == 3 and len(r["unchangedRids"]) == 27
    assert {x["rid"]: x["r"] for x in rows} == {rid(1): 3, rid(2): 4, rid(3): 5}
    by = {x["rid"]: x for x in rows}
    assert by[rid(1)]["cells"][4] == ["s", "Cleared"] and by[rid(1)]["pk"] == "D1"
    assert by[rid(2)]["cells"][5] == ["s", "edited"]
    assert by[rid(3)]["cells"][6] == ["d", "2026-11-01T00:00:00"]
    assert by[rid(3)]["cells"][7] == ["n", -481.75] and len(by[rid(3)]["cells"]) == len(COLS)


def test_sorted_rows_still_elided(api, root):
    _, p = do_export(api, root, 20)
    xl_edit.apply(str(p), [{"op": "reverse_rows"}])
    j, _ = read(api, {"exportId": EID})
    assert j["result"]["rowsSent"] == 0 and len(j["result"]["unchangedRids"]) == 20
    xl_edit.apply(str(p), [{"op": "sort", "col": "Amount", "reverse": True}, {"op": "set", "rid": rid(7),
                                                                              "col": "Status", "value": "Cleared"}])
    j, rows = read(api, {"exportId": EID})
    assert [x["rid"] for x in rows] == [rid(7)] and len(j["result"]["unchangedRids"]) == 19


def test_partial_column_shuffle_sends_rows(api, root):
    _, p = do_export(api, root, 11)
    xl_edit.apply(str(p), [{"op": "shuffle_cols_from", "col_index": 4}])
    j, rows = read(api, {"exportId": EID})
    assert j["result"]["rowsSent"] == 10 and j["result"]["unchangedRids"] == [rid(5)]   # the middle row
    first = next(x for x in rows if x["rid"] == rid(0))
    assert first["cells"][3] == ["s", "000010"]                       # Doc now belongs to another row


def test_rebased_rows_not_elided(api, root):
    do_export(api, root, 8)
    assert api.excel_link_update_manifest(EID, {"rebased": {f"{rid(4)}|Status": "Open"}})["ok"]
    j, rows = read(api, {"exportId": EID})
    assert [x["rid"] for x in rows] == [rid(4)] and rid(4) not in j["result"]["unchangedRids"]


def test_formula_two_pass(api, root):
    _, p = do_export(api, root, 5)
    xl_edit.apply(str(p), [{"op": "set", "row": 2, "col": "Remarks", "value": "=D2*2", "type": "formula"}])
    j, rows = read(api, {"exportId": EID})
    assert j["result"]["formulaCells"] == 1 and rows[0]["cells"][5] == ["z", None, "=D2*2"]
    part = data_part(p)

    def inject(xml):
        out, n = re.subn(r"(<c r=\"F2\"[^>]*>)<f>D2\*2</f>(?:<v\s*/>|<v></v>)?", r"\1<f>D2*2</f><v>2469</v>", xml)
        assert n == 1
        return out
    zip_replace(p, part, inject)
    j, rows = read(api, {"exportId": EID})
    assert rows[0]["cells"][5] == ["f", ["n", 2469], "=D2*2"]


def test_error_cell(api, root):
    _, p = do_export(api, root, 5)
    xl_edit.apply(str(p), [{"op": "error", "rid": rid(2), "col": "Remarks", "value": "#N/A"}])
    assert re.search(r'<c r="F4"[^>]*t="e"[^>]*><v>#N/A</v></c>', sheet_xml(p))
    j, rows = read(api, {"exportId": EID})
    assert rows[0]["rid"] == rid(2) and rows[0]["cells"][5] == ["e", "#N/A"]


def test_merged_cells_reported(api, root):
    _, p = do_export(api, root, 10)
    xl_edit.apply(str(p), [{"op": "merge", "range": "E5:E9"}])
    j, _ = read(api, {"exportId": EID})
    assert j["result"]["merged"] == ["E5:E9"]
    assert excel_link.merged_ranges(p, "Reco Data") == ["E5:E9"]
    assert excel_link.merged_ranges(p, "No such sheet") == []


def test_duplicate_rid_second_pass(api, root):
    _, p = do_export(api, root, 6)
    xl_edit.apply(str(p), [{"op": "dup_row", "rid": rid(2)}])
    j, rows = read(api, {"exportId": EID})
    r = j["result"]
    assert r["dupRids"] == {rid(2): [4, 8]}
    assert [(x["r"], x["rid"]) for x in rows] == [(4, rid(2)), (8, rid(2))]
    assert rows[0]["cells"] == rows[1]["cells"] and rows[0]["cells"][3] == ["s", "000002"]
    assert rid(2) not in r["unchangedRids"] and len(r["unchangedRids"]) == 5


def test_blank_rows_and_unsized_sheet(api, root):
    _, p = do_export(api, root, 12)
    xl_edit.apply(str(p), [{"op": "insert_blank_rows", "before_rid": rid(5), "n": 2}])
    part = data_part(p)
    zip_replace(p, part, lambda x: re.sub(r'<dimension ref="[^"]*"\s*/>', '<dimension ref="A1:B3"/>', x))
    j, rows = read(api, {"exportId": EID})
    r = j["result"]
    assert r["blankRows"] == 2 and r["rowsRead"] == 12 and r["rowsSent"] == 0
    zip_replace(p, part, lambda x: re.sub(r'<dimension ref="[^"]*"\s*/>', "", x))
    j, rows = read(api, {"exportId": EID}, {"elide": False})
    assert len(rows) == 12 and rows[-1]["r"] == 15 and all(len(x["cells"]) == len(COLS) for x in rows)


def test_sheet_renamed_and_title_rows(api, root):
    _, p = do_export(api, root, 6)
    xl_edit.apply(str(p), [{"op": "rename_sheet", "name": "My data"},
                           {"op": "insert_rows_top", "n": 2, "title": "October report"}])
    j, rows = read(api, {"exportId": EID})
    r = j["result"]
    assert (r["sheet"], r["sheetMatch"], r["headerRow"]) == ("My data", "header-scan", 3)
    assert r["rowsSent"] == 0 and len(r["unchangedRids"]) == 6
    wb = openpyxl.load_workbook(p)
    wb.copy_worksheet(wb["My data"]).title = "Copy"
    wb.save(p)
    j, _ = read(api, {"exportId": EID})
    assert j["state"] == "failed" and j["code"] == "ambiguous_sheet"
    assert sorted(j["candidates"]) == ["Copy", "My data"] and sorted(j["result"]["candidates"]) == ["Copy", "My data"]
    j, _ = read(api, {"exportId": EID}, {"sheet": "Copy"})
    assert j["state"] == "done" and j["result"]["sheet"] == "Copy" and j["result"]["headerRow"] == 3


def test_unsupported_and_truncated(api, root, tmp_path, monkeypatch):
    eng = engine(api)
    for ext in (".xls", ".xlsb", ".csv"):
        f = tmp_path / f"book{ext}"
        f.write_bytes(b"not a workbook")
        tok = eng.register_pick(str(f))["token"]
        r = api.excel_link_read_start({"token": tok}, {})
        assert r["ok"] is False and r["code"] == "unsupported_format" and "xlsx" in r["error"]
    _, p = do_export(api, root, 30)
    cut = tmp_path / "half.xlsx"
    data = p.read_bytes()
    cut.write_bytes(data[: len(data) // 2])
    sleeps = []
    monkeypatch.setattr(excel_link, "_sleep", sleeps.append)
    tok = eng.register_pick(str(cut))["token"]
    j, _ = read(api, {"token": tok})
    assert j["state"] == "failed" and j["code"] == "busy_saving" and sleeps
    assert api.excel_link_read_start({"token": "Pnope"}, {})["code"] == "bad_token"


def test_read_by_token_finds_manifest_or_embedded_base(api, root, tmp_path):
    _, p = do_export(api, root, 9)
    copy_path = tmp_path / "saved as.xlsx"                       # "Save As" elsewhere
    shutil.copy2(p, copy_path)
    tok = engine(api).register_pick(str(copy_path))["token"]
    j, rows = read(api, {"token": tok})
    r = j["result"]
    assert r["exportId"] == EID and r["manifestFound"] and r["rowsSent"] == 0 and not r["baseInWorkbook"]
    assert r["file"]["name"] == "saved as.xlsx"
    # Manifest lost: the embedded _reco_base is the baseline, nothing is elided.
    shutil.rmtree(links_dir(root))
    engine(api)._head_paths.clear()
    j, rows = read(api, {"token": tok})
    r = j["result"]
    assert not r["manifestFound"] and r["baseInWorkbook"] and r["rowsSent"] == 9
    assert r["base"]["header"] == ["rid", "pk", "fp", "flags"] + BASE_COLS
    assert r["base"]["rows"][1] == [rid(1), "D1", "fp", "", "Open", "note 1", "D:2026-10-02"]
    assert r["meta"]["exportId"] == EID and isinstance(r["meta"]["columns"], list)


# ──────────────────────────────────────────────────────────────────────────────
# 17-22  status, ids, local area, close/sweep, manifest updates, listing
# ──────────────────────────────────────────────────────────────────────────────

def test_status_settle_and_owner_file(api, root, monkeypatch):
    _, p = do_export(api, root, 5)
    clock = [1000.0]
    monkeypatch.setattr(excel_link, "_mono", lambda: clock[0])
    s = api.excel_link_status(EID)
    assert s["state"] == "not_saved" and s["exists"] and not s["savedSinceExport"] and not s["ownerFile"]
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
    s = api.excel_link_status(EID)
    assert s["state"] == "saving" and s["savedSinceExport"] and s["newSinceLastImport"] and not s["settled"]
    clock[0] += 2
    s = api.excel_link_status(EID)
    assert s["state"] == "saved" and s["settled"] and isinstance(s["mtimeNs"], str)
    (p.parent / ("~$" + p.name)).write_text("owner")
    assert api.excel_link_status(EID)["ownerFile"] is True
    r = api.excel_link_update_manifest(EID, {"lastImport": {"at": "now", "by": "tester", "sha256": "x",
                                                            "mtimeNs": s["mtimeNs"], "size": s["size"]}})
    assert r == {"ok": True, "rev": 2}
    s = api.excel_link_status(EID)
    assert s["savedSinceExport"] and not s["newSinceLastImport"] and s["state"] == "saved"
    p.unlink()
    assert api.excel_link_status(EID)["state"] == "missing"
    assert api.excel_link_status("X20261006T104233-none")["code"] == "missing_manifest"


def test_path_jail_and_ids(api, root, tmp_path, monkeypatch):
    for fn in (api.excel_link_open, api.excel_link_status, api.excel_link_manifest, api.excel_link_close,
               api.excel_link_reveal, api.excel_link_save_copy):
        assert fn("../../etc/passwd")["code"] == "bad_spec"
    assert api.excel_link_update_manifest("nope", {})["code"] == "bad_spec"
    assert api.excel_link_export_rows("Tnope", [], [])["code"] == "bad_token"
    assert api.excel_link_export_finish("Tnope")["code"] == "bad_token"
    assert api.excel_link_open("X20261006T104233-none")["code"] == "missing"
    assert api.excel_link_manifest("X20261006T104233-none")["code"] == "missing"
    assert api.excel_link_read_start({"exportId": "X20261006T104233-none"})["code"] == "missing"
    assert api.excel_link_job("nope")["code"] == "unknown_job"
    assert api.excel_link_read_page("nope", 0, 10)["code"] == "unknown_job"

    # Manifests can only point inside WORK_DIR (local) or ROOT (shared).
    outside = tmp_path / "evil.xlsx"
    outside.write_bytes(b"x")
    d = links_dir(root)
    d.mkdir(parents=True)
    for eid, f in (("X20261006T104233-esc1", {"area": "local", "name": "../evil.xlsx"}),
                   ("X20261006T104233-esc2", {"area": "shared", "rel": "../evil.xlsx"}),
                   ("X20261006T104233-esc3", {"area": "local", "name": str(outside)})):
        (d / f"{eid}.json").write_text(json.dumps({"exportId": eid, "file": f, "status": "open"}))
        assert api.excel_link_open(eid)["code"] == "bad_spec"
        assert api.excel_link_close(eid)["deleted"] is False
        assert api.excel_link_read_start({"exportId": eid})["code"] == "bad_spec"
    assert outside.exists()

    # pick_file maps a dialog path to a token; the token is not an export id.
    _, p = do_export(api, root, 3)
    fake = types.ModuleType("webview")
    fake.FileDialog = types.SimpleNamespace(OPEN="open-enum", SAVE="save-enum", FOLDER="folder-enum")
    monkeypatch.setitem(sys.modules, "webview", fake)

    class Win:
        calls = []

        def create_file_dialog(self, kind, **kw):
            self.calls.append((kind, kw))
            return (str(p),)
    win = Win()
    api._set_window(win)
    r = api.excel_link_pick_file()
    assert r["ok"] and r["name"] == p.name and win.calls[0][0] == "open-enum"
    assert "xlsx" in win.calls[0][1]["file_types"][0]
    assert api.excel_link_open(r["token"])["code"] == "bad_spec"
    j, _ = read(api, {"token": r["token"]})
    assert j["state"] == "done" and j["result"]["exportId"] == EID
    win.create_file_dialog = lambda kind, **kw: None
    assert api.excel_link_pick_file() == {"ok": False, "cancelled": True}
    api._set_window(None)
    assert api.excel_link_pick_file()["ok"] is False


def test_long_path_falls_back_local(api, root, monkeypatch):
    monkeypatch.setattr(excel_link, "LONG_PATH_LIMIT", 10)
    res, p = do_export(api, root, 4)
    assert res["area"] == "local" and res["rel"] is None and "pathTooLong" in res["warnings"]
    wd = Path(os.environ["RECO_XL_WORK_DIR"])
    assert p == wd / res["name"] and p.is_file()
    head = json.loads((links_dir(root) / f"{EID}.json").read_text())   # manifests stay in ROOT
    assert head["file"] == {"area": "local", "rel": None, "name": res["name"], "machine": platform.node()}
    assert api.excel_link_status(EID)["exists"]
    meta = {r[0]: r[1] for r in openpyxl.load_workbook(p)["_reco_meta"].iter_rows(values_only=True)}
    assert meta["area"] == "local"
    j, _ = read(api, {"exportId": EID})
    assert j["result"]["rowsSent"] == 0
    # The same link seen from another PC.
    edit_head(root, EID, lambda h: h["file"].update(machine="OTHER-PC"))
    s = api.excel_link_status(EID)
    assert s["state"] == "other_pc" and s["otherPc"] and not s["exists"]
    assert api.excel_link_open(EID)["code"] == "other_pc"
    assert api.excel_link_read_start({"exportId": EID})["code"] == "other_pc"


def test_explicit_local_area_and_unwritable_share(api, root, monkeypatch):
    res, p = do_export(api, root, 2, area="local")
    assert res["area"] == "local" and res["warnings"] == [] and p.parent == Path(os.environ["RECO_XL_WORK_DIR"])
    monkeypatch.setattr(fm, "is_writable", lambda path: False)
    res, p = do_export(api, root, 2, eid="X20261006T104233-nowr")
    assert res["area"] == "local" and "sharedNotWritable" in res["warnings"]


def _age_closed(root, eid, days):
    stamp = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    edit_head(root, eid, lambda h: h.update(closedAt=stamp))


def test_close_and_sweep(api, root):
    eng = engine(api)
    res_a, pa = do_export(api, root, 3)
    owner = pa.parent / ("~$" + pa.name)
    owner.write_text("x")
    r = api.excel_link_close(EID)
    assert r == {"ok": True, "deleted": False, "deferred": True} and pa.exists()
    head = api.excel_link_manifest(EID)["head"]
    assert head["status"] == "closed" and head["closedAt"] and head["rev"] == 2
    owner.unlink()
    eng.sweep()
    assert pa.exists()                                      # closed less than a day ago
    _age_closed(root, EID, 2)
    eng.sweep()
    assert not pa.exists() and (links_dir(root) / f"{EID}.json").exists()
    _age_closed(root, EID, 100)
    eng.sweep()
    assert not (links_dir(root) / f"{EID}.json").exists() and not (links_dir(root) / f"{EID}.base.json").exists()

    # Open links are never deleted, however old.
    eid_b = "X20251006T104233-old1"
    res_b, pb = do_export(api, root, 3, eid=eid_b)
    edit_head(root, eid_b, lambda h: h.update(exportedAt="2020-01-01T00:00:00.000Z"))
    old = time.time() - 400 * 86400
    os.utime(pb, (old, old))
    eng.sweep()
    assert pb.exists() and (links_dir(root) / f"{eid_b}.json").exists()
    r = api.excel_link_close(eid_b)
    assert r == {"ok": True, "deleted": True, "deferred": False} and not pb.exists()
    assert api.excel_link_close(eid_b, False)["deleted"] is False

    # Snapshots older than a day and orphaned local workbooks older than 30 days.
    wd = Path(os.environ["RECO_XL_WORK_DIR"])
    (wd / ".snap").mkdir(parents=True, exist_ok=True)
    stale, fresh = wd / ".snap" / "a.xlsx", wd / ".snap" / "b.xlsx"
    orphan, young = wd / "orphan.xlsx", wd / "young.xlsx"
    for f in (stale, fresh, orphan, young):
        f.write_bytes(b"x")
    os.utime(stale, (time.time() - 2 * 86400,) * 2)
    os.utime(orphan, (time.time() - 40 * 86400,) * 2)
    res_c, pc = do_export(api, root, 2, eid="X20261006T104233-locl", area="local")
    os.utime(pc, (time.time() - 40 * 86400,) * 2)           # referenced by an open link: kept
    counts = eng.sweep()
    assert not stale.exists() and fresh.exists() and not orphan.exists() and young.exists() and pc.exists()
    assert counts["snapshots"] == 1 and counts["orphans"] == 1


def test_update_manifest_merge(api, root):
    do_export(api, root, 3)
    assert api.excel_link_update_manifest(EID, {"rebased": {"a|Status": "x"}, "dismissed": {"a|R": "1"}})["rev"] == 2
    assert api.excel_link_update_manifest(EID, json.dumps({"rebased": {"b|Status": "y"},
                                                           "dismissed": {"b|R": "2"}}))["rev"] == 3
    for i in range(55):
        api.excel_link_update_manifest(EID, {"importAppend": {"at": str(i), "counts": {"applied": i}}})
    r = api.excel_link_update_manifest(EID, {"newRowSigs": {"s1": "r9"}, "status": "closed"})
    assert r == {"ok": True, "rev": 3 + 55 + 1}
    head = api.excel_link_manifest(EID)["head"]
    assert head["rebased"] == {"a|Status": "x", "b|Status": "y"} and head["dismissed"] == {"a|R": "1", "b|R": "2"}
    assert len(head["imports"]) == 50 and head["imports"][0]["at"] == "5" and head["imports"][-1]["at"] == "54"
    assert head["newRowSigs"] == {"s1": "r9"} and head["status"] == "closed" and head["closedAt"]
    assert api.excel_link_update_manifest(EID, {"status": "open"})["ok"]
    assert api.excel_link_manifest(EID)["head"]["closedAt"] is None
    for bad in ({"rev": 9}, {"file": {}}, {"status": "bogus"}, {"rebased": []}, {"importAppend": "x"}):
        assert api.excel_link_update_manifest(EID, bad)["code"] == "bad_patch"
    assert api.excel_link_update_manifest("X20261006T104233-none", {"status": "open"})["code"] == "missing"


def test_list_summaries(api, root, monkeypatch):
    do_export(api, root, 3)
    do_export(api, root, 4, eid="X20261007T104233-two2")
    d = links_dir(root)
    (d / "X20261008T000000-tier.json").write_text(json.dumps({     # written by the JS fallback tier
        "format": 1, "exportId": "X20261008T000000-tier", "tplId": "tpl1", "tier": "S",
        "exportedAt": "2026-10-08T00:00:00.000Z", "file": {"area": "download", "name": "dl.xlsx"}}))
    (d / "~$X20261006T104233-k3f9.json").write_text("locked")
    (d / "broken.json").write_text("{not json")
    real_open = builtins.open

    def guarded(file, *a, **kw):
        if str(file).endswith(".base.json"):
            raise AssertionError(f"base file read: {file}")
        return real_open(file, *a, **kw)
    monkeypatch.setattr(builtins, "open", guarded)
    r = api.excel_link_list("bank_reco")
    monkeypatch.setattr(builtins, "open", real_open)
    json.dumps(r)
    assert r["ok"]
    assert [x["exportId"] for x in r["links"]] == ["X20261008T000000-tier", "X20261007T104233-two2", EID]
    first = r["links"][-1]
    for k in ("exportId", "tplId", "tplName", "fileName", "area", "exportedAt", "exportedBy", "rows", "status",
              "closedAt", "lastImport", "exists", "size", "mtime", "ownerFile", "savedSinceExport",
              "newSinceLastImport", "otherPc"):
        assert k in first, k
    assert first["rows"] == 3 and first["exists"] and first["status"] == "open" and first["area"] == "shared"
    tier_s = r["links"][0]
    assert tier_s["exists"] is False and tier_s["fileName"] == "dl.xlsx" and tier_s["status"] == "open"
    s = api.excel_link_status("X20261008T000000-tier")
    assert s["ok"] and s["state"] == "missing" and s["exists"] is False
    assert api.excel_link_manifest("X20261008T000000-tier", True)["base"] is None
    assert api.excel_link_update_manifest("X20261008T000000-tier", {"dismissed": {"a": "b"}})["rev"] == 1
    assert api.excel_link_open("X20261008T000000-tier")["code"] == "missing"
    assert api.excel_link_close("X20261008T000000-tier") == {"ok": True, "deleted": False, "deferred": False}
    assert api.excel_link_list("")["ok"] and len(api.excel_link_list("")["links"]) == 3
    assert api.excel_link_list("nothing_here") == {"ok": True, "links": []}


# ──────────────────────────────────────────────────────────────────────────────
# 23-28  sanitising, cancel, JSON safety, migration skip, launching, perf
# ──────────────────────────────────────────────────────────────────────────────

def test_sanitize_defensive(api, root):
    cells, base = make_rows(3)
    cells[0][5] = "bad\x01text"
    cells[1][3] = "y" * 40000
    res = export(api, make_head(3), cells, base)
    assert "sanitized:Remarks" in res["warnings"] and "sanitized:Doc" in res["warnings"]
    wb = openpyxl.load_workbook(root / res["rel"])
    ws = wb["Reco Data"]
    assert ws["F2"].value == "badtext" and len(ws["D3"].value) == 32767
    j, _ = read(api, {"exportId": EID})
    assert j["result"]["rowsSent"] == 0                   # signatures use the sanitised text


def test_job_cancel(api, root, monkeypatch):
    gate = threading.Event()
    real = excel_link.write_workbook

    def slow(*a, **kw):
        gate.wait(10)
        return real(*a, **kw)
    monkeypatch.setattr(excel_link, "write_workbook", slow)
    head = make_head(5)
    cells, base = make_rows(5)
    tok = api.excel_link_export_begin(head)["token"]
    api.excel_link_export_rows(tok, cells, base)
    job_id = api.excel_link_export_finish(tok)["job_id"]
    assert api.excel_link_job(job_id)["state"] == "running" and api.excel_link_job(job_id)["result"] is None
    assert api.excel_link_job_cancel(job_id) is True
    gate.set()
    j = wait_job(api, job_id)
    assert j["state"] == "cancelled" and j["result"] is None
    target = root / "reco_excel" / "bank_reco" / "tester" / head["fileName"]
    assert not target.exists() and not (links_dir(root) / f"{EID}.json").exists()
    assert not (links_dir(root) / f"{EID}.base.json").exists()
    assert api.excel_link_job_cancel(job_id) is False
    assert api.excel_link_job_release(job_id) is True and api.excel_link_job_release(job_id) is False


def test_json_safe_all_methods(api, root, tmp_path, monkeypatch):
    fake = types.ModuleType("webview")
    fake.FileDialog = types.SimpleNamespace(OPEN="open", SAVE="save", FOLDER="folder")
    monkeypatch.setitem(sys.modules, "webview", fake)
    _, p = do_export(api, root, 4)

    class Win:
        def create_file_dialog(self, kind, **kw):
            return (str(p),) if kind == "open" else str(tmp_path / "copy.xlsx")
    api._set_window(Win())
    r = api.excel_link_read_start({"exportId": EID}, {"elide": False})
    job_id = r["job_id"]
    wait_job(api, job_id)
    calls = [
        api.excel_link_capabilities(), r, api.excel_link_job(job_id), api.excel_link_read_page(job_id, 0, 2),
        api.excel_link_read_page(job_id, 2, 5000), api.excel_link_status(EID), api.excel_link_manifest(EID, True),
        api.excel_link_update_manifest(EID, {"lastImport": {"at": "x"}}), api.excel_link_list("bank_reco"),
        api.excel_link_open(EID), api.excel_link_reveal(EID), api.excel_link_pick_file(),
        api.excel_link_save_copy(EID), api.excel_link_job_cancel(job_id), api.excel_link_job_release(job_id),
        api.excel_link_close(EID, False),
        # error paths
        api.excel_link_export_begin({}), api.excel_link_export_begin("{bad json"),
        api.excel_link_export_rows("x", [], []), api.excel_link_export_finish("x"), api.excel_link_job("x"),
        api.excel_link_read_start({}, {}), api.excel_link_read_page("x"), api.excel_link_status("x"),
        api.excel_link_manifest("x"), api.excel_link_update_manifest(EID, {"x": 1}), api.excel_link_open("x"),
        api.excel_link_reveal("X20261006T104233-none"), api.excel_link_save_copy("X20261006T104233-none"),
        api.excel_link_close("X20261006T104233-none"),
    ]
    for c in calls:
        json.dumps(c)                                          # no default=
        assert isinstance(c, (dict, bool))
    assert calls[3]["next"] == 2 and calls[4]["next"] is None and len(calls[4]["rows"]) == 2
    assert calls[11]["ok"] and calls[12] == {"ok": True, "path": str(tmp_path / "copy.xlsx")}
    assert (tmp_path / "copy.xlsx").read_bytes() == p.read_bytes()
    # An unexpected exception becomes code 'internal' instead of a rejected promise.
    monkeypatch.setattr(excel_link.ExcelLinkEngine, "status", lambda self, eid: 1 / 0)
    r = api.excel_link_status(EID)
    assert r["ok"] is False and r["code"] == "internal" and "ZeroDivisionError" in r["error"]
    # json_safe itself
    obj = {"d": dt.date(2026, 1, 2), "t": dt.datetime(2026, 1, 2, 3, 4), "dec": decimal.Decimal("1.5"),
           "p": Path("/x"), "s": {2, 1}, "nan": float("nan"), "inf": float("inf"), 3: (1, 2), "b": b"x"}
    out = excel_link.json_safe(obj)
    json.dumps(out)
    assert out == {"d": "2026-01-02", "t": "2026-01-02T03:04:00", "dec": 1.5, "p": str(Path("/x")), "s": [1, 2],
                   "nan": None, "inf": None, "3": [1, 2], "b": "x"}


def test_folder_manager_skips_owner_files(tmp_path):
    (tmp_path / "reco_excel").mkdir()
    (tmp_path / "reco_excel" / "book.xlsx").write_bytes(b"x")
    (tmp_path / "reco_excel" / "~$book.xlsx").write_bytes(b"owner")
    names = [r for r, _, _ in fm.iter_files(str(tmp_path))]
    assert names == [os.path.join("reco_excel", "book.xlsx")]


def test_no_launch_env(api, root, monkeypatch):
    _, p = do_export(api, root, 2)
    r = api.excel_link_open(EID)
    assert r["ok"] and r["action"] == "skipped" and r["handler"]["kind"] in ("excel", "libreoffice", "other", "none")
    assert api.excel_link_reveal(EID) == {"ok": True, "action": "skipped"}
    launched = []
    monkeypatch.delenv("RECO_XL_NO_LAUNCH")
    monkeypatch.setattr(excel_link.subprocess, "Popen", lambda *a, **kw: launched.append(a))
    monkeypatch.setattr(excel_link.shutil, "which", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(excel_link.sys, "platform", "linux")
    assert api.excel_link_open(EID)["action"] == "launched" and launched[0][0] == ["xdg-open", str(p)]
    p.unlink()
    assert api.excel_link_open(EID)["code"] == "missing"


@pytest.mark.skipif(not os.environ.get("RECO_PERF"), reason="perf smoke: set RECO_PERF=1")
def test_perf_smoke(api, root):
    cols = COLS + [col(f"X{i}", "text" if i % 2 else "value") for i in range(7)]
    cells, base = make_rows(5000)
    for i, row in enumerate(cells):
        row += [f"x{i}" if k % 2 else i * 1.5 for k in range(7)]
    t0 = time.time()
    export(api, make_head(5000, cols=cols), cells, base)
    t1 = time.time()
    j, rows = read(api, {"exportId": EID}, {"elide": False})
    t2 = time.time()
    assert len(rows) == 5000
    assert t1 - t0 < 5 and t2 - t1 < 5, (t1 - t0, t2 - t1)


# ──────────────────────────────────────────────────────────────────────────────
# Pure helpers
# ──────────────────────────────────────────────────────────────────────────────

def test_raw_cell_and_row_sig():
    rc = excel_link.raw_cell
    assert rc(None) is None and rc(True, "b") == ["b", True] and rc(3, "n") == ["n", 3]
    assert rc(float("nan")) == ["e", "#NUM!"] and rc("#REF!", "e") == ["e", "#REF!"]
    assert rc(dt.datetime(2026, 10, 6, 12, 30, 59, 700000)) == ["d", "2026-10-06T12:31:00"]
    assert rc(dt.date(2026, 10, 6)) == ["d", "2026-10-06T00:00:00"]
    assert rc(dt.time(9, 5, 1)) == ["s", "09:05:01"]
    assert rc("=A1*2", "f") == ["f", None, "=A1*2"] and rc("a_x000D_\nb", "s") == ["s", "a\r\nb"]
    sig = excel_link.row_sig
    assert sig(["a", None, 1.0], 4) == sig(["a", "", 1, None])
    assert sig([0.1 + 0.2]) == sig([0.3]) and sig([-10.0]) == sig([-10])
    assert sig([dt.datetime(2026, 1, 2)]) == sig([dt.date(2026, 1, 2)])
    assert sig(["=A1"]) != sig(["=A1"], formulas=[0])
    assert sig(["a\r\nb"]) == sig(["a\nb"]) and len(sig(["x"])) == 16
    assert excel_link.owner_files(Path("/nonexistent/book.xlsx")) == []
