"""Drive the real interface in a browser, end to end.

    python tests/ui_smoke.py [--shots DIR] [--only folders,dash,...] [--headed]

Starts devserver.py on a private port with private setups and cache folders, builds
a small month of extracts in two folders, and walks through the features a person
uses: folders, groups, columns and filters per group, combine steps, relationships,
dashboards (one per table and the overview across tables), the run, setups.
Screenshots of each stage go to --shots. Not part of pytest: it needs Chromium.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from conftest import write_codes, write_refunds, write_sales  # noqa: E402

TOKEN = "test-token"
CHROME = os.environ.get("COLSIFT_CHROME", "/opt/pw-browsers/chromium")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def make_data(tmp: Path) -> dict:
    jan, feb = tmp / "data" / "jan", tmp / "data" / "feb"
    jan.mkdir(parents=True)
    feb.mkdir(parents=True)
    write_sales(jan / "sales_JAN.csv", 1)
    write_sales(feb / "sales_FEB.csv", 2, start=36)
    write_codes(jan / "codes.xlsx")
    write_refunds(feb / "refunds_FEB.txt")
    return {"jan": jan, "feb": feb, "out": tmp / "out"}


class UI:
    def __init__(self, page, shots: Path | None):
        self.page = page
        self.shots = shots
        self.n = 0
        self.answers: list[str] = []          # what the next prompt() dialogs are answered with

    def on_dialog(self, dlg) -> None:
        if dlg.type == "prompt" and self.answers:
            dlg.accept(self.answers.pop(0))
        else:
            dlg.accept()                       # confirm() and prompt() answer yes / the suggestion

    def shot(self, name: str) -> None:
        if self.shots:
            self.n += 1
            self.page.screenshot(path=str(self.shots / f"{self.n:02d}_{name}.png"))

    def js(self, expr: str):
        return self.page.evaluate(expr)

    def msg(self) -> str:
        return self.page.inner_text("#msg")

    def wait_msg(self, text: str, timeout: int = 30000) -> None:
        self.page.wait_for_function(f"document.querySelector('#msg').textContent.includes({json.dumps(text)})",
                                    timeout=timeout)

    def then(self, text: str, action) -> None:
        """Do something and wait until the status line says `text` (the line is reset first)."""
        self.js("document.querySelector('#msg').textContent = ''")
        action()
        self.wait_msg(text)

    def tab(self, p: str) -> None:
        self.page.click(f"button.tab[data-p={p}]")

    def folders(self, *paths) -> None:
        """What Browse / ＋ would do, minus the native dialog the browser can't show."""
        self.js(f"setFolders({json.dumps([str(p) for p in paths])}); refreshFiles()")
        self.page.wait_for_function("S.files.length > 0 && !document.querySelector('#msg').textContent.includes('Loading')")
        self.page.wait_for_timeout(300)

    def files_shown(self) -> list[str]:
        return self.js("[...document.querySelectorAll('#filelist .file .nm')].map(e => e.textContent)")


# --------------------------------------------------------------------------
# sections
# --------------------------------------------------------------------------

def folders_and_loading(ui: UI, d: dict) -> None:
    page = ui.page
    ui.folders(d["jan"])
    page.wait_for_selector("#filelist .file")
    assert sorted(ui.files_shown()) == ["codes.xlsx", "sales_JAN.csv"], ui.files_shown()
    assert page.locator("#filelist .fold").count() == 0, "one folder, one group: the plain list"
    # ＋ another folder: the list turns into folders, closed until clicked
    ui.js(f"setFolders([...S.folders.map(f => f.path), {json.dumps(str(d['feb']))}]); refreshFiles()")
    page.wait_for_function("S.files.length === 4")
    page.wait_for_selector("#filelist .fold")
    assert page.locator("#filelist .fold").count() == 2
    assert ui.js("S.sel.size") == 4, "files of a newly added folder are ticked for the one group"
    page.click("#filelist .fold:nth-child(1) .fnm")          # collapse jan, if open
    ui.js("S.foldOpen = {}; drawFiles()")
    assert ui.files_shown() == [], "several folders: shown at folder level"
    page.click(f"#filelist .fold[data-fold='{d['feb']}'] .fnm")
    assert sorted(ui.files_shown()) == ["refunds_FEB.txt", "sales_FEB.csv"]
    ui.shot("folders")
    # untick February's folder for the group with its folder checkbox
    page.click(f"#filelist .fold[data-fold='{d['feb']}'] input[data-fchk]")
    assert ui.js("S.sel.size") == 2
    page.click(f"#filelist .fold[data-fold='{d['feb']}'] input[data-fchk]")
    assert ui.js("S.sel.size") == 4

    # a second group, with February's folder given to it
    page.click("#groupBar [data-gmenu]")
    page.click("#groupBar [data-gadd=blank]")
    page.wait_for_selector("#groupBar .gchip.on:has-text('Group 2')")
    page.select_option(f"#filelist .fold[data-fold='{d['feb']}'] select[data-fgroup]", label="→ Group 2")
    ui.wait_msg("now belongs to")
    files2 = ui.js("WS.groups[1].files.map(p => p.split(/[\\\\/]/).pop()).sort()")
    assert files2 == ["refunds_FEB.txt", "sales_FEB.csv"], files2
    assert ui.js("WS.groups[1].folders.length") == 1
    ui.shot("folder_to_group")

    # save; then open only January and load it: nothing from February may appear
    page.fill("#profileName", "Two folders")
    ui.then("Saved", lambda: page.click("#saveProfile"))
    saved = json.loads((Path(os.environ["COLSIFT_PROFILES"]) / "Two folders.json").read_text())
    assert [x["path"] for x in saved["folders"]] == [str(d["jan"]), str(d["feb"])], saved.get("folders")
    ui.then("New setup", lambda: page.click("#newProfile"))
    ui.folders(d["jan"])
    assert sorted(ui.files_shown()) == ["codes.xlsx", "sales_JAN.csv"]
    page.select_option("#profileList", "Two folders")
    ui.then("Loaded", lambda: page.click("#loadProfile"))
    # the folder tied to Group 2 is part of the setup, so it opens with it
    page.wait_for_function("S.folders.length === 2")
    listed = set(ui.js("S.files.map(f => f.path)"))
    assert all(p in listed for g in ui.js("WS.groups.map(g => g.files)") for p in g), "no file outside the open folders"
    assert len(listed) == 4

    # a setup saved with files from a folder that isn't open: they are left out, and said so
    ui.js("WS.groups[1].folders = []; S.foldOpen = {}")
    page.fill("#profileName", "Loose")
    ui.then("Saved", lambda: page.click("#saveProfile"))
    ui.then("New setup", lambda: page.click("#newProfile"))
    ui.folders(d["jan"])
    page.select_option("#profileList", "Loose")
    ui.then("Loaded", lambda: page.click("#loadProfile"))
    assert sorted(ui.files_shown()) == ["codes.xlsx", "sales_JAN.csv"], ui.files_shown()
    assert ui.js("S.files.length") == 2, "a loaded setup never adds files that aren't in the open folders"
    said = ui.msg().lower()          # the file list's note, or the load's own line after it
    assert any(x in said for x in ("not in these folders", "not found here", "not in the open folders")), ui.msg()
    ui.shot("loaded_without_stale_files")
    # ＋ February brings the saved assignments back
    ui.js(f"setFolders([...S.folders.map(f => f.path), {json.dumps(str(d['feb']))}]); refreshFiles()")
    page.wait_for_function("S.files.length === 4")
    page.wait_for_function("WS.groups[1].files.length === 2")


def new_setup(ui: UI) -> None:
    page = ui.page
    ui.then("New setup", lambda: page.click("#newProfile"))


def group_card(ui: UI, n: int, name: str, mode: str = "", value: str = "") -> None:
    """Name group n on the Combine tab and give it a file rule."""
    page = ui.page
    card = f"#wsGroups .gcard:nth-child({n})"
    page.fill(f"{card} input[data-k=name]", name)
    page.dispatch_event(f"{card} input[data-k=name]", "change")
    if mode:
        page.select_option(f"{card} select[data-k=mode]", mode)
        page.fill(f"{card} input[data-k=value]", value)
        page.dispatch_event(f"{card} input[data-k=value]", "input")
        page.dispatch_event(f"{card} input[data-k=value]", "change")


def three_groups(ui: UI, d: dict) -> None:
    """Sales (sales_*), Codes (.xlsx), Refunds (refund…) sorted by their rules, Sales
    keeping three columns with AMOUNT > 300."""
    page = ui.page
    new_setup(ui)
    ui.folders(d["jan"], d["feb"])
    ui.tab("ws")
    group_card(ui, 1, "Sales", "pattern", "sales_*")
    for name, mode, value in (("Codes", "ext", ".xlsx"), ("Refunds", "contains", "refund")):
        page.click("#groupBar [data-gmenu]")
        page.click("#groupBar [data-gadd=blank]")
        n = ui.js("WS.groups.length")
        page.wait_for_selector(f"#wsGroups .gcard:nth-child({n})")
        group_card(ui, n, name, mode, value)
    ui.then("Sorted", lambda: page.click("#wsAuto"))
    got = ui.js("Object.fromEntries(WS.groups.map(g => [g.name, g.files.map(p => p.split(/[\\\\/]/).pop()).sort()]))")
    assert got == {"Sales": ["sales_FEB.csv", "sales_JAN.csv"], "Codes": ["codes.xlsx"], "Refunds": ["refunds_FEB.txt"]}, got
    ui.js("switchGroup(WS.groups[0].id)")
    page.wait_for_function("document.querySelector('#peekFile').textContent.startsWith('sales_')")
    page.wait_for_function("S.allCols.length === 5")
    ui.tab("cols")
    page.click("#cNone")
    for c in ("DOC_NO", "TAX_CODE", "AMOUNT"):
        page.locator(f"#collist .col:has(.nm:text-is('{c}')) input[data-k=inc]").check()
    ui.tab("filt")
    page.click("#rules .qg.root > .gh [data-k=addrule]")
    page.select_option("#rules .rule select[data-k=col]", "AMOUNT")
    page.select_option("#rules .rule select[data-k=op]", "gt")
    page.fill("#rules .rule input[data-k=val]", "300")
    page.dispatch_event("#rules .rule input[data-k=val]", "input")
    ui.js("syncBack(); wsSchemaRefresh(true)")
    page.wait_for_function("(S.wsSchema?.tables || []).length === 3")


def add_visual(ui: UI, q: str) -> None:
    """＋ Add visual ▾, then the kind."""
    ui.page.click("#anAddBtn")
    ui.page.click(f"#anAddMenu [data-q={q}]")


def kpi_value(ui: UI, table: str) -> float:
    return ui.js(f"""(() => {{ const it = AT().analysis.items.find(i => i.kind === 'kpi' && i.table === {json.dumps(table)});
        const r = (S.anData?.items || []).find(x => x.id === it.id); return r.table.rows[0].nums.slice(-1)[0]; }})()""")


def overview_dashboard(ui: UI, d: dict) -> None:
    page = ui.page
    three_groups(ui, d)
    ui.tab("anal")
    page.select_option("#anSource", "o:")
    page.wait_for_selector("#anAddFrom", state="visible")
    for table, q in (("Sales", "kpi"), ("Refunds", "kpi"), ("Sales", "slicer")):
        page.select_option("#anAddFrom", table)
        ui.then("Analysis ready", lambda q=q: add_visual(ui, q))
    assert ui.js("AT().analysis.items.map(i => i.table)") == ["Sales", "Refunds", "Sales"]
    assert page.locator("#anCards .srcchip").all_inner_texts() == ["Sales", "Refunds", "Sales"]
    assert abs(kpi_value(ui, "Refunds") - (-59.75)) < 1e-6
    ui.shot("overview")
    # a slicer on Sales' TAX_CODE narrows the Refunds card too — Refunds has TAX_CODE as well
    ui.then("Analysis ready", lambda: page.locator("#anCards .slicer label:has-text('YQ') input").check())
    assert abs(kpi_value(ui, "Refunds") - (-47.25)) < 1e-6
    ui.shot("overview_sliced")
    # the card editor says which table it reads, and can switch it
    page.locator("#anCards .card.item").nth(1).locator("[data-act=edit]").click()
    assert page.locator("#anCards select[data-f=table]").input_value() == "Refunds"
    page.locator("#anCards .card.item").nth(1).locator("[data-act=edit]").click()
    page.wait_for_timeout(600)

    # Run all dashboards: every file, every dashboard, nothing written
    ui.then("worked out over every file", lambda: page.click("#anRunDash"))
    assert ui.js("document.querySelector('#anMode').textContent") == "Every file"
    assert not d["out"].exists()

    # a run that hands its dashboards back, with the Overview in the workbook
    page.click("#anExportBtn")
    page.check("#anExport")
    ui.tab("out")
    page.fill("#outFolder", str(d["out"]))
    page.dispatch_event("#outFolder", "change")
    page.select_option("#outFormat", "xlsx")
    page.dispatch_event("#outFormat", "change")
    page.check("#runDash")
    ui.then("Dashboards refreshed from the run", lambda: page.click("#btnRun"))
    page.wait_for_selector("#p-anal.on")
    assert "the run" in page.inner_text("#anNote"), page.inner_text("#anNote")
    import openpyxl
    book = next(d["out"].glob("*.xlsx"))
    wb = openpyxl.load_workbook(book)
    assert {"Sales", "Codes", "Refunds", "Overview"} <= set(wb.sheetnames), wb.sheetnames
    assert ui.page.inner_text("#memInfo").startswith("Memory ")
    ui.shot("after_run")


def duplicates_across_files(ui: UI, d: dict) -> None:
    """The Filters tab's duplicates card: a key, keep only keys in several files, counts."""
    page = ui.page
    new_setup(ui)
    jan, feb = d["jan"].parent / "dup_jan", d["jan"].parent / "dup_feb"
    for p, body in ((jan, "DOC_NO,AMOUNT\nA1,10\nA2,20\n"), (feb, "DOC_NO,AMOUNT\nA2,21\nA3,30\n")):
        p.mkdir(exist_ok=True)
        (p / f"{p.name}.csv").write_text(body, encoding="utf-8")
    ui.folders(jan, feb)
    page.wait_for_function("S.allCols.length === 2")
    ui.tab("filt")
    page.select_option("#dupAdd", "DOC_NO")
    page.select_option("#dupKeep", "files")
    page.check("#dupCount")
    page.check("#dupFiles")
    assert "Preview looks within the first file" in page.inner_text("#dupNote")
    ui.tab("out")
    page.fill("#outFolder", str(d["out"] / "dups"))
    page.dispatch_event("#outFolder", "change")
    page.select_option("#outFormat", "csv")
    page.dispatch_event("#outFormat", "change")
    page.uncheck("#runDash")
    ui.then("Done", lambda: page.click("#btnRun"))
    out = next((d["out"] / "dups").glob("*.csv")).read_text(encoding="utf-8").split()
    assert out == ["DOC_NO,AMOUNT,DUP_COUNT,DUP_FILES", "A2,20,2,2", "A2,21,2,2"], out
    ui.shot("duplicates")


def parameters(ui: UI, d: dict) -> None:
    """{MONTH} in the folder and the output, {PERIOD} from today, one asked at the run."""
    import datetime as dt
    page = ui.page
    new_setup(ui)
    ui.tab("out")
    page.click("#paramAdd")                                   # PERIOD: last month, yyyy-mm
    page.click("#paramAdd")                                   # MONTH: a fixed value
    page.wait_for_selector("#paramRows [data-pi='1']")
    assert ui.js("WS.params.map(p => p.name)") == ["PERIOD", "MONTH"]
    row = "#paramRows [data-pi='1']"
    page.fill(f"{row} input[data-pk=value]", "jan")
    page.dispatch_event(f"{row} input[data-pk=value]", "change")
    page.wait_for_function("S.paramValues.MONTH === 'jan'")
    today = dt.date.today()
    last = (today.replace(day=1) - dt.timedelta(days=1)).strftime("%Y-%m")
    assert ui.js("S.paramValues.PERIOD") == last
    assert page.inner_text("#paramRows [data-pi='0'] .chip2") == f"= {last}"

    tpl = str(d["jan"].parent / "{MONTH}")
    ui.folders(tpl)
    assert ui.js("S.folders[0].path") == str(d["jan"]) and ui.js("S.folders[0].tpl") == tpl
    assert sorted(ui.files_shown()) == ["codes.xlsx", "sales_JAN.csv"], ui.files_shown()
    # another month: the same setup now reads February's folder
    page.fill(f"{row} input[data-pk=value]", "feb")
    page.dispatch_event(f"{row} input[data-pk=value]", "change")
    page.wait_for_function("S.folders[0] && S.folders[0].path.endsWith('feb') && S.files.length === 2 && "
                           "S.files.every(f => /FEB/.test(f.name))")
    ui.shot("parameters")

    # asked at each run, used in the output folder and name
    page.select_option(f"{row} select[data-pk=mode]", "ask")
    page.wait_for_function("WS.params[1].mode === 'ask'")
    page.fill("#outFolder", str(d["out"] / "p_{MONTH}"))
    page.dispatch_event("#outFolder", "change")
    page.fill("#outName", "report_{PERIOD}")
    page.dispatch_event("#outName", "change")
    page.select_option("#outFormat", "csv")
    page.dispatch_event("#outFormat", "change")
    page.uncheck("#runDash")
    ui.answers = ["feb"]
    ui.then("Done", lambda: page.click("#btnRun"))
    assert ui.answers == [], "the run asked for {MONTH}"
    written = sorted(x.name for x in (d["out"] / "p_feb").iterdir())
    assert written and all(n.startswith(f"report_{last}") for n in written), written

    # saved as written: the folder keeps {MONTH}, the parameters travel with the setup
    page.fill("#profileName", "Monthly")
    ui.then("Saved", lambda: page.click("#saveProfile"))
    saved = json.loads((Path(os.environ["COLSIFT_PROFILES"]) / "Monthly.json").read_text())
    assert [x["path"] for x in saved["folders"]] == [tpl], saved["folders"]
    assert [p["name"] for p in saved["params"]] == ["PERIOD", "MONTH"]
    assert saved["output"]["folder"].endswith("p_{MONTH}")
    ui.then("New setup", lambda: page.click("#newProfile"))
    assert ui.js("WS.params.length") == 0
    page.select_option("#profileList", "Monthly")
    ui.then("Loaded", lambda: page.click("#loadProfile"))
    assert ui.js("WS.params.map(p => p.name)") == ["PERIOD", "MONTH"]


def run_checks(ui: UI, d: dict) -> None:
    """Checks on the Output tab: Check now, a Stop check that writes nothing, then as a warning."""
    page = ui.page
    three_groups(ui, d)
    ui.tab("out")
    out = d["out"] / "checked"
    page.fill("#outFolder", str(out))
    page.dispatch_event("#outFolder", "change")
    page.select_option("#outFormat", "xlsx")
    page.dispatch_event("#outFormat", "change")
    page.uncheck("#runDash")
    page.click("#checkAdd")                                   # Sales has at least 1 row
    page.click("#checkAdd")
    r1 = "#checkRows [data-ci='1']"
    page.select_option(f"{r1} select[data-ck=kind]", "found")
    page.select_option(f"{r1} select[data-ck=table]", "Sales")
    page.select_option(f"{r1} select[data-ck=col]", "TAX_CODE")
    page.select_option(f"{r1} select[data-ck=table2]", "Codes")
    assert ui.js("WS.checks.map(c => [c.kind, c.table, (c.cols || []).join(), c.table2 || ''])") == \
        [["rows", "Sales", "", ""], ["found", "Sales", "TAX_CODE", "Codes"]]
    ui.then("Checks: 1 pass, 1 fail", lambda: page.click("#checkNow"))
    assert "a run now would write nothing" in ui.msg()
    assert page.inner_text("#checkRows [data-ci='0'] .ckres").startswith("✓")
    assert "ZR" in page.inner_text(f"{r1} .ckres"), page.inner_text(f"{r1} .ckres")
    ui.shot("checks")
    assert not out.exists(), "Check now writes nothing"

    ui.then("Stopped before writing", lambda: page.click("#btnRun"))
    assert not out.exists() or not any(out.iterdir())
    assert "Checks — 1 of 2 pass" in page.inner_text("#runResults")
    ui.shot("checks_stopped")

    ui.tab("out")
    page.select_option(f"{r1} select[data-ck=on_fail]", "warn")
    ui.then("1 check warned", lambda: page.click("#btnRun"))
    import openpyxl
    wb = openpyxl.load_workbook(next(out.glob("*.xlsx")))
    rows = list(wb["Checks"].iter_rows(values_only=True))
    assert [r[2] for r in rows[1:]] == ["PASS", "FAIL (warning)"], rows

    page.fill("#profileName", "Checked")
    ui.then("Saved", lambda: page.click("#saveProfile"))
    ui.then("New setup", lambda: page.click("#newProfile"))
    assert ui.js("WS.checks.length") == 0
    page.select_option("#profileList", "Checked")
    ui.then("Loaded", lambda: page.click("#loadProfile"))
    assert ui.js("WS.checks.map(c => c.on_fail)") == ["stop", "warn"]


def parquet_and_lookup(ui: UI, d: dict) -> None:
    """A Parquet source, column stats, Convert to Parquet, Parquet output, and Find with
    a list from a file, cleaned keys and Export every match."""
    import polars as pl
    page = ui.page
    new_setup(ui)
    src = d["jan"].parent / "pq_src"
    src.mkdir(exist_ok=True)
    pl.DataFrame({"DOC_NO": ["000123", "000456", "000789"], "AMOUNT": [10.5, 20.0, 30.25],
                  "TAX_CODE": ["YQ", "XT", "YQ"]}).write_parquet(src / "tickets.parquet")
    (src / "more.csv").write_text("DOC_NO,AMOUNT,TAX_CODE\n000999,5,YR\n", encoding="utf-8")
    (d["jan"].parent / "wanted.csv").write_text("Ticket\n123\n999\n555\n", encoding="utf-8")
    ui.folders(src)
    assert sorted(ui.files_shown()) == ["more.csv", "tickets.parquet"], ui.files_shown()
    page.click("#filelist .file:has(.nm:text-is('tickets.parquet'))")
    page.wait_for_function("S.allCols.length === 3 && S.active && S.active.endsWith('tickets.parquet')")
    # the preview and the dashboard read the file clicked, not the first one ticked (more.csv)
    page.click("#btnPreview")
    page.wait_for_function("document.querySelector('#resInfo').textContent.includes('tickets.parquet')")
    assert "3 rows" in page.inner_text("#resInfo"), page.inner_text("#resInfo")
    ui.tab("anal")
    # the dashboard reads a sample: the first rows of each ticked file, the clicked one first
    ui.then("Analysis ready — the first 100 rows of each of 2 files", lambda: add_visual(ui, "kpi"))
    assert ui.js("document.querySelector('#anMode').textContent") == "Sample · 100 rows per file"
    ui.tab("cols")
    page.click("#collist .col:has(.nm:text-is('AMOUNT')) [data-k=stats]")
    page.wait_for_selector("#colStats .cs-range")
    assert page.inner_text("#colStats .cs-range").startswith("Min 10.5"), page.inner_text("#colStats")
    page.click("#colStatsAll")
    page.wait_for_function("document.querySelector('#colStats .cs-sum')?.textContent.startsWith('4 rows in 2 files')")
    ui.shot("column_stats")

    out = d["out"] / "pq"
    ui.tab("out")
    page.fill("#outFolder", str(out))
    page.dispatch_event("#outFolder", "change")
    ui.then("Converted", lambda: page.click("#pqConvert"))
    assert (out / "more.parquet").exists() and not (out / "tickets.parquet").exists()
    assert "skipped" in page.inner_text("#runResults")
    ui.tab("out")
    page.select_option("#outFormat", "parquet")
    page.dispatch_event("#outFormat", "change")
    assert not page.is_visible("#txtOpts")
    page.uncheck("#runDash")
    ui.then("Done", lambda: page.click("#btnRun"))
    got = pl.read_parquet(next(out.glob("extract*.parquet")))
    assert got.height == 4 and got.schema["AMOUNT"] == pl.Float64 and got.schema["DOC_NO"] == pl.String

    ui.tab("find")
    ui.js(f"loadKeyFile({json.dumps(str(d['jan'].parent / 'wanted.csv'))})")
    page.wait_for_function("document.querySelector('#findVals').value.split('\\n').length === 3")
    assert page.inner_text("#findListInfo").startswith("3 values")
    page.select_option("#findScope", "column")
    page.wait_for_timeout(200)
    page.select_option("#findCol", "DOC_NO")
    page.check("#findZeros")
    ui.then("hits", lambda: page.click("#doFind"))
    assert "1 of 3 not found" in page.inner_text("#findMissBox"), page.inner_text("#findMissBox")
    ui.js("S.output.format = 'xlsx'")
    ui.then("Exported 2 matching rows", lambda: page.click("#findExport"))
    assert (out / "extract_matches.xlsx").exists()
    ui.shot("find_export")


def studio_visual(ui: UI, d: dict) -> None:
    """A Studio card: measures over the dashboard's rows, a bar list bound to a column,
    the designer opening over the window and saving back, slicers narrowing it."""
    page = ui.page
    new_setup(ui)
    src = d["jan"].parent / "studio_src"
    src.mkdir(exist_ok=True)
    (src / "sales_JAN.csv").write_bytes((d["jan"] / "sales_JAN.csv").read_bytes())
    ui.folders(src)
    page.wait_for_function("S.allCols.length === 5")
    ui.tab("anal")
    ui.then("Analysis ready", lambda: add_visual(ui, "slicer"))
    ui.then("Analysis ready", lambda: add_visual(ui, "studio"))
    card = "#anCards .card.item:nth-child(2)"
    frame = page.frame_locator(f"{card} iframe.msv")
    total = sum(35.5 + (k * 37) % 900 for k in range(36))
    frame.locator(".ms-kv").first.wait_for()
    assert frame.locator(".ms-kv").first.inner_text() == f"{total:,.0f}", frame.locator(".ms-kv").first.inner_text()
    assert frame.locator(".ms-kv").nth(1).inner_text() == "36"
    assert frame.locator("text=YQ").count() >= 1, "the bar list draws a row per TAX_CODE"
    ui.shot("studio_card")
    # a slicer narrows the Studio card like any other
    ui.then("Analysis ready", lambda: page.locator("#anCards .slicer label:has-text('YQ') input").check())
    page.wait_for_function("""() => { const f = document.querySelector('#anCards iframe.msv');
        return f && f.contentDocument && [...f.contentDocument.querySelectorAll('.ms-kv')].some(x => x.textContent === '9'); }""")
    # bindings: rename a measure, and the design's references show what is not set
    page.locator(f"{card} [data-act=edit]").click()
    page.wait_for_selector(f"{card} [data-f=mname]")
    assert page.locator(f"{card} [data-bid] select[data-f=mscol]").input_value() == "TAX_CODE"
    page.locator(f"{card} [data-act=edit]").click()
    # the designer opens over the window, shows the real numbers, and saves back
    page.locator(f"{card} [data-act=msedit]").first.click()
    page.wait_for_selector("#msEd", state="visible")
    ed = page.frame_locator("#msEdFrame")
    ed.locator(".top .acts button:has-text('Use in ColSift')").wait_for()
    pv = ed.frame_locator("#pv")
    pv.locator(".ms-kv").first.wait_for()
    assert pv.locator(".ms-kv").nth(1).inner_text() == "9", "the designer previews the dashboard's numbers"
    ui.shot("studio_designer")
    ui.then("Studio visual saved", lambda: ed.locator(".top .acts button:has-text('Use in ColSift')").click())
    assert not page.is_visible("#msEd")
    ui.then("DAX copied", lambda: page.evaluate("msCopyDax(AT().analysis.items.find(x => x.kind === 'studio'))"))
    # the visual as a web page, with the numbers on screen (the YQ slice)
    page.locator(f"{card} [data-act=cmenu]").click()
    ui.then("as a web page", lambda: page.locator(f"{card} [data-act=mshtml]").click())
    saved_page = next((Path(os.environ["COLSIFT_SAVED"])).glob("*.html")).read_text(encoding="utf-8")
    assert saved_page.count("<iframe") == 1 and "3,281" in saved_page and "ms-kv" in saved_page
    # the preview pages through the file
    ui.tab("res")
    page.fill("#prevRows", "10")
    page.click("#doPreview")
    page.wait_for_function("document.querySelector('#resInfo').textContent.startsWith('Rows 1–10')")
    page.click("#prevNext")
    page.wait_for_function("document.querySelector('#resInfo').textContent.startsWith('Rows 11–20')")
    assert not page.is_disabled("#prevBack")
    page.fill("#prevRows", "200")
    ui.tab("anal")
    # saved with the setup, drawn again after loading it
    page.fill("#profileName", "Studio")
    ui.then("Saved", lambda: page.click("#saveProfile"))
    saved = json.loads((Path(os.environ["COLSIFT_PROFILES"]) / "Studio.json").read_text())
    items = saved["groups"][0]["setup"]["analysis"]["items"]
    st = next(x for x in items if x["kind"] == "studio")
    assert st["project"]["blocks"] and [m["name"] for m in st["measures"]] == ["Total AMOUNT", "Rows"]
    ui.then("New setup", lambda: page.click("#newProfile"))
    page.select_option("#profileList", "Studio")
    ui.then("Loaded", lambda: page.click("#loadProfile"))
    ui.tab("anal")
    page.wait_for_function("""() => { const f = document.querySelector('#anCards iframe.msv');
        return f && f.contentDocument && f.contentDocument.querySelectorAll('.ms-kv').length >= 2; }""", timeout=60000)


def dashboard_basics(ui: UI, d: dict) -> None:
    """The dashboard as a newcomer meets it: a suggested layout from the columns, the
    sample badge and its size, every file on request, and each card's ⋯ menu and editor."""
    page = ui.page
    new_setup(ui)
    src = d["jan"].parent / "basics_src"
    src.mkdir(exist_ok=True)
    (src / "sales_JAN.csv").write_bytes((d["jan"] / "sales_JAN.csv").read_bytes())
    ui.folders(src)
    page.wait_for_function("S.allCols.length === 5")
    ui.tab("anal")
    page.wait_for_selector("#anCards .anempty [data-sug]")
    ui.wait_msg("Analysis ready")
    ui.then("Analysis ready", lambda: page.click("#anCards .anempty [data-sug]"))
    kinds = ui.js("AT().analysis.items.map(i => [i.kind, i.chart || '', (i.by || {}).column || ''])")
    assert kinds == [["slicer", "", "TAX_CODE"], ["kpi", "", ""], ["kpi", "", ""], ["breakdown", "bar", "TAX_CODE"],
                     ["trend", "line", "ISSUE_DATE"], ["breakdown", "donut", "CURRENCY"]], kinds
    page.wait_for_function("(S.anData?.items || []).length === 6 && S.anData.items.every(r => !r.error)")
    mode = "document.querySelector('#anMode').textContent"
    assert ui.js(mode) == "Sample · 100 rows per file"
    ui.shot("suggested_dashboard")
    # a smaller sample: the numbers come from the first 10 rows
    page.fill("#anSample", "10")
    ui.then("Analysis ready — the first 10 rows of sales_JAN.csv, 10 rows", lambda: page.dispatch_event("#anSample", "change"))
    assert ui.js(mode) == "Sample · 10 rows per file"
    ui.then("Analysis ready — 1 file", lambda: page.click("#anRunAll"))
    assert ui.js(mode) == "Every file"
    # the ⋯ menu: width and remove; the editor folds its extras away
    card = "#anCards .card.item:nth-child(4)"
    page.hover(card)
    page.locator(f"{card} [data-act=cmenu]").click()
    page.locator(f"{card} .wpick [data-w=full]").click()
    assert "full" in page.get_attribute(card, "class")
    page.locator(f"{card} [data-act=edit]").click()
    assert page.locator(f"{card} [data-f=bsort]").count() == 0
    page.locator(f"{card} [data-act=more]").click()
    assert page.locator(f"{card} [data-f=bsort]").input_value() == "value_desc"
    ui.shot("card_editor")
    page.locator(f"{card} [data-act=edit]").click()
    page.hover("#anCards .card.item:nth-child(6)")
    page.locator("#anCards .card.item:nth-child(6) [data-act=cmenu]").click()
    page.locator("#anCards .card.item:nth-child(6) [data-act=del]").click()
    assert ui.js("AT().analysis.items.length") == 5
    WS_sample = ui.js("setupPayload().sample_rows")
    assert WS_sample == 10, WS_sample


SECTIONS = {"folders": folders_and_loading, "dash": overview_dashboard, "dups": duplicates_across_files,
            "params": parameters, "checks": run_checks, "data": parquet_and_lookup, "studio": studio_visual,
            "basics": dashboard_basics}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", default="")
    ap.add_argument("--only", default="")
    ap.add_argument("--headed", action="store_true")
    a = ap.parse_args()
    shots = Path(a.shots) if a.shots else None
    if shots:
        shots.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="colsift_ui_"))
    d = make_data(tmp)
    env = {**os.environ, "COLSIFT_PROFILES": str(tmp / "profiles"), "COLSIFT_CACHE": str(tmp / "cache")}
    (tmp / "profiles").mkdir()
    os.environ.update({k: env[k] for k in ("COLSIFT_PROFILES", "COLSIFT_CACHE")})
    os.environ["COLSIFT_SAVED"] = str(tmp / "saved")
    port = free_port()
    srv = subprocess.Popen([sys.executable, str(ROOT / "devserver.py"), "--port", str(port), "--no-browser",
                            "--token", TOKEN, "--save-dir", str(tmp / "saved")], env=env, cwd=str(ROOT),
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    from playwright.sync_api import sync_playwright
    errors: list[str] = []
    try:
        time.sleep(1.5)
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME, headless=not a.headed)
            page = browser.new_page(viewport={"width": 1500, "height": 950})
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.set_default_timeout(30000)
            page.goto(f"http://127.0.0.1:{port}/?t={TOKEN}")
            page.wait_for_function("S.meta && S.meta.ops && S.meta.ops.length")
            ui = UI(page, shots)
            page.on("dialog", ui.on_dialog)
            only = [x for x in a.only.split(",") if x] or list(SECTIONS)
            for name in only:
                print(f"-- {name}", flush=True)
                try:
                    SECTIONS[name](ui, d)
                except Exception:
                    if shots:
                        page.screenshot(path=str(shots / f"FAILED_{name}.png"))
                    print("status line at failure:", ui.msg())
                    raise
            browser.close()
    finally:
        srv.terminate()
        try:
            out = srv.communicate(timeout=5)[0]
        except subprocess.TimeoutExpired:
            srv.kill()
            out = ""
        tracebacks = [b for b in (out or "").split("Traceback")[1:]]
        if tracebacks:
            print("server tracebacks:\n" + "\n".join("Traceback" + t[:1500] for t in tracebacks))
    if errors:
        print("page errors:\n  " + "\n  ".join(errors))
        return 1
    print(f"UI smoke passed{f' — screenshots in {shots}' if shots else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
