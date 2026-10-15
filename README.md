# Reco Suite

Reconciliation workbench (Reco), Accounting Entry Generator and Special JVs, run from a shared folder inside the **Automation Hub** pywebview launcher.

| Path | What it is |
|---|---|
| `main.py` | Launcher: sign-in, app tiles, filesystem bridge, **base-folder set / switch / migrate** |
| `folder_manager.py` | Folder inspection, migration engine (copy → verify → switch → optional move) |
| `excel_link.py` | **Excel link** engine: builds the `.xlsx` for "📗 Edit in Excel" (dropdowns, typed cells, guarded read-only columns), detects Excel saves, reads the workbook back for "Load back" |
| `apps/Reco.html` | The Reco app |
| `apps/lib/` | Vendored PapaParse 5.4.1 and SheetJS 0.18.5 (add your existing jspreadsheet/jsuites files here) |
| `special_jv_templates/TCH.html`, `special_jv_mapping/TCH.json` | The TCH Special JV and its mapping (account codes live in the JSON) |
| `docs/RECO_ARCHITECTURE_HANDOVER.md` | Architecture, bridge contract, every fix in this build |
| `tests/` | `pytest` for the launcher/migration, Playwright end-to-end tests for Reco, TCH and the hub |

## Deploy

1. Copy `apps/Reco.html`, `apps/lib/papaparse.min.js`, `apps/lib/xlsx.full.min.js`, `special_jv_templates/` and `special_jv_mapping/` into the shared base folder (keep your existing `master/`, `reco/`, `reco_data/`, `apps/lib/jspreadsheet*`/`jsuites*`).
2. Put `main.py`, `folder_manager.py` and `excel_link.py` together on each PC (or package them with PyInstaller).
3. `pip install -r requirements.txt`, then `python main.py` (`--debug` opens the dev tools).

The first start asks for the base folder. Later changes go through **📁 Base folder…** in the hub (admin password: `pwd.txt` in the base folder, default `admin123`):

- **Switch to an existing folder** — repoint the hub (no copying).
- **Migrate all files to a new folder** — copies everything, verifies it, switches, and leaves `MIGRATED_TO.txt` so colleagues' launchers offer to follow. Optionally removes the originals after a SHA-256-verified copy.

> `main.py` was rebuilt from the bridge contract in the handover doc because the original launcher was not available. If you keep your own launcher, Reco still works with it (every new bridge method is optional); to add the folder migration to it, copy `folder_manager.py` and the base-folder methods of `LauncherAPI` (`get_folder_info`, `inspect_path`, `browse_folder`, `set_base_folder`, `initialize_folder`, `preflight_migration`, `start_migration`, `migration_status`, `cancel_migration`, `follow_pointer`) plus the settings modal in `HUB_HTML`.

## Edit in Excel

In a template's Reco view, **📗 Edit in Excel** writes the rows to a real Excel workbook (dropdowns for list columns, real dates and amounts, read-only columns greyed) and opens it in Microsoft Excel. Edit, press **Ctrl+S**, and Reco notices the save: click **Load back**, review the changes (and any conflicts with edits made in Reco meanwhile), and apply. Every applied change is recorded in the version history (`_src = excel:<id>`). **📗 Links** lists open workbooks; **Load from file…** loads a copy saved elsewhere. Without the new launcher (or without openpyxl) the workbook is downloaded instead and loaded back with *Load from file…* (no dropdowns). Details: handover §11.

## Reviewing side by side

**⪿ Split** in the Reco toolbar opens a second pane beside the first. Use it to
hold one slice of a reconciliation still while you work another — unmatched rows on
the left, a supplier's invoices on the right — or to put a different template in each
pane and compare them.

Each pane keeps its **own** filters, slicers, sort, page, page size, column widths,
hidden columns, zoom, cell cursor and scroll position. The **data is shared**: an edit,
a tag or an offset made in one pane is in the other, because both panes are two views
of one reconciliation, not two copies of it. `● Active` marks the pane that has the
keyboard and the toolbar; **F6** or **Ctrl+Alt+← / →** switches, the splitter
drags, and `✕ Close pane` closes one. The split and its ratio are remembered on this
PC. Two panes is the maximum.

**Each pane has its own linked Excel workbook** — its own ⌨ Edit in Excel, its own
banner, its own save watcher and its own baseline. Export "as shown" means as shown in
*that* pane. The same row edited in both workbooks surfaces as a reviewed conflict in
whichever is loaded back second, never silently pre-ticked. Closing a pane leaves its
link open on the share, adoptable later from 📗 Links.

Three things the split deliberately refuses, each saying why on screen:

- **Posting across panes.** The row selection is shared, which is the point — but
  Preview Entry, Mark Offset and Unmark act only on the rows the pane you clicked in
  can see, and refuse a selection that reaches outside it rather than quietly posting
  rows you are not looking at. Offset Selected is the exception: offsetting two sides
  against each other is the whole reason to split, so it takes both panes' rows under
  one reco id.
- **Excel View and Sheet mode** while a split is open.
- **Two periods at once.** Every edit appends to today's file, so two copies of one row
  would collide.

The column *order* is shared by both panes (it is stored per reconciliation per PC, not
per pane). The Correction tab now refuses an empty corrected value — blanking a field
from that tab was how a cross-pane mix-up could reach the shared correction master.

## Columns beside the value you are correcting

On the Correction tab, **Show columns…** picks any columns of the template — file
columns, added columns, formula columns and master lookups alike — and shows them
read-only beside each bad value, so you can tell what the value should be without
leaving the tab. They show exactly what the grid shows: a date held as an Excel serial
reads `01/01/24`, not `45292`, a lookup reads the looked-up value, and a cell someone
has formatted in the Excel view reads the way it reads there — a VAT rate formatted as
a percentage is `5.00%` on both screens, not `5.00%` on one and `0.05` on the other.

The choice is **yours, on this PC** — it never goes near the shared folder, so nobody
else's list changes when you pick one. **Save as the team default** publishes it (behind
a confirm that says so) as the starting list for every colleague who has not chosen
their own; their own choices still win. **Clear** and a chip's `×` only ever touch your
own list — they cannot delete the team's.

Once you have chosen for yourself you are no longer following the team, and the tab says
so (*your own choice*). **Follow the team default** gives your own choice up again and
follows theirs from then on, including a column they publish later. Whoever published can
also take it back: with your own list empty that same button reads **Clear the team
default** and, behind the same confirm, removes it so nobody is started on anything.

Once at least one column is chosen the list is shown 200 rows at a time, with **Show
200 more**; with nothing chosen the whole error list is shown exactly as before.


## Tests

```bash
python -m pytest tests/                 # launcher bridge, migration engine, Excel link engine
node tests/e2e/run_jv_core_unit.mjs     # the Special JV engine with no browser: TCH's figures, the formula parser, validateSpec
node tests/e2e/run_e2e.mjs              # Reco, TCH and the hub in Chromium against the real bridge
node tests/e2e/run_autoload_e2e.mjs     # opening a reco loads its latest file by itself, and says so while it is reading
node tests/e2e/run_xllink_e2e.mjs       # Edit in Excel → edit (openpyxl) → Load back → review → apply
node tests/e2e/run_xlview_e2e.mjs       # the in-app Excel view (jspreadsheet CE 5, from tests/e2e/vendor)
node tests/e2e/run_reports_e2e.mjs      # custom reports: what a filter means per column kind, cards, totals, CSV, 200k rows
node tests/e2e/run_grid_scale_e2e.mjs   # the grid on a 200k-row extract: slicers, surgical updates, progress, navigation, sort order
node tests/e2e/run_colorder_e2e.mjs     # the display column order: a team order, your own order on this PC, and the export following the team's
node tests/e2e/run_correction_e2e.mjs   # the correction tab's context columns: byte-identical with none chosen, the cap and the Apply index, scope, truncation, two panes
node tests/e2e/run_panes_e2e.mjs        # two panes side by side: session ownership, id parking, per-pane scroll, ledger-write refusals, one Excel link per pane
node tests/e2e/run_reverse_e2e.mjs      # reversing a generated entry: cancel it if it never posted, contra it if it did
node tests/e2e/run_specialjv_e2e.mjs    # Special JV safety: balance at arrival/preview/commit, posted-JV tracking, ref validation
node tests/e2e/run_jv_engine_e2e.mjs    # a generated, data-only JV page driven through the real Reco — the lines TCH produces
node tests/e2e/run_jv_gen_e2e.mjs       # JvGen: the files a published Special JV is made of, and what they do on arrival
node tests/e2e/run_jv_wizard_e2e.mjs    # the Special JV creator wizard, end to end
```

Run them one at a time — each binds a fixed port block (`run_jv_core_unit.mjs` needs
neither a port nor a browser, and takes about a second). All sixteen must pass:
75 pytest cases (1 skipped), and `1,979` end-to-end checks — 250 + 73 + 41 + 63 + 94
+ 107 + 100 + 145 + 123 + 301 + 254 + 123 + 79 + 107 + 119, in the order above.

A count that has gone **down** is a regression, not a tidy-up: these suites only ever
grow, and each one's header comment names the gates it exists to hold.
