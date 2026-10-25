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

> **Two bridge methods are optional but worth copying, because without them two colleagues saving at the same moment can lose one of the two saves** — measured, in two processes, with both writers reporting success (T-S10-10). `read_file_with_token(rel)` returns `{text, token}`, the file and the sha256 of its bytes in one read; `write_file_if_unchanged(rel, text, token)` writes only while the file still holds what that token describes, and answers `{ok: false, reason: "changed"}` otherwise. Reco's merge writes use them where they exist and fall back to `write_file` where they do not, so an older launcher keeps working. Copy `_cross_process_lock`, `_content_token` and `_lock_file_for` with them (the locks are one file each under `ROOT/.locks/`, and `folder_manager.iter_files` skips that folder): the lock is what makes the check and the write one step, and it also belongs on `write_file` and on both branches of `append_csv_rows` (T-S10-28). See handover §20.

## Edit in Excel

In a template's Reco view, **📗 Edit in Excel** writes the rows to a real Excel workbook (dropdowns for list columns, real dates and amounts, read-only columns greyed) and opens it in Microsoft Excel. Edit, press **Ctrl+S**, and Reco notices the save: click **Load back**, review the changes (and any conflicts with edits made in Reco meanwhile), and apply. Every applied change is recorded in the version history (`_src = excel:<id>`). **📗 Links** lists open workbooks; **Load from file…** loads a copy saved elsewhere. Without the new launcher (or without openpyxl) the workbook is downloaded instead and loaded back with *Load from file…* (no dropdowns). Details: handover §11.

## A row key built from an added column

A template's **Primary Key** can now include a column you added, as long as its value is worked
out from the file's own columns — a **formula** (say `CONCAT({Doc},"-",{Line})`) or a **lookup
into the accounts master**. Columns people type into cannot be key components, and the picker says
why beside each box.

The value is computed **once, when the data is loaded**, and frozen into the row. So if a
colleague edits the accounts master next week, your rows keep the identity they were loaded with —
and the cell shows **⚠ recalculated** if the two ever disagree, rather than quietly showing one
value while the history, the offsets and the journal use another.

Before an upload is written, Reco asks once if anything is wrong with the keys it worked out: a
part that came out empty or `#ERR`, parts that are all blank, or a value containing the `||`
separator. Each of those still *looks* like a key, so nothing later would refuse those rows and
they would match no history. You can say no and nothing is written. Duplicate keys are only
questioned *before the write* when the key contains an added column — on a key made of file
columns, several lines per document is just the shape of an AP extract, so nothing is asked.
The **load** is no longer silent, though: when rows share a key, the **Duplicate primary keys**
panel opens (unless that question has just named them), and it names any manual override that
has stopped applying — a key that no longer names one row cannot say which row the typed number
was about, so those cells show their computed value again, and that is what a journal entry
would post. Nothing is deleted: correct the duplicate rows and they apply again.

Nothing is retroactive: data already loaded keeps its keys, and the **next** upload mints the new
way. The confirm says so, and it now also fires when you change a key column's formula — which
used to say nothing while the next upload detached the history. Details: handover §14.

## The value you typed is still there tomorrow

What you type into an added **custom** or **dropdown** column — a vendor name, a status, a note —
is now kept against the **row key** on the shared folder, for everyone using it. Close the file,
open it again next week, and the values are where you left them; a colleague who opens it on
another PC reads them without anybody sending anything.

They did not survive before, and whoever lost an afternoon to that deserves to see it named: the
value used to be filed under the row's internal id, and Reco mints those fresh every time data is
loaded. So a vendor name typed onto 400 rows came back as 400 blanks the next day — the typing
was still on the share, under row ids that no longer existed, and nothing said so.

Two things it needs, because the row key is what the value is found again by: the template has
**Primary Keys**, and the column is one of the template's **Additional Columns** rather than a
one-off column added in spreadsheet mode. A template with no keys, or a row whose key cells are
all blank, behaves exactly as it always did — the value shows while the data is loaded and goes
when it is reloaded.

**Manage → Column Values** is the list: the row key, the column, the value, who typed it, when,
which file they typed it into, and whether it is reaching the screen right now. **Remove** deletes
one for everybody and it cannot be got back. Details: handover §5b.

One honest limit. "On the shared folder" means Reco has to be able to write to it. If the folder
stops answering, your typing is held in this window, Reco tells you so while you type and keeps
retrying on its own, and both ways out of the app — the hub button and closing the window — ask
first and name how many changes have not got there yet. If you answer *leave anyway*, those ones
are gone: there is deliberately only one copy of a typed value. So if Reco says the folder is not
answering, the right move is to leave it open. Handover §15.6.

## Typing over a formula

A **formula**, **master** or **master lookup** column can be marked **Allow manual override per
row** in the template's Additional Columns. The cell is then yours to type into: your value
replaces what Reco works out, for that row key, for everyone using the folder. The cell is marked,
and its tooltip says who typed it, when, and what the formula or the lookup said before. **↺**
beside the cell puts the computed value back — the revert *deletes* the record, which is what lets
the formula speak again instead of freezing a number that happens to match it today.

**Manage → Manual Overrides** is the list of who changed what: each row key and column, whether it
replaces a formula or a master lookup, what it replaced, what it reads now, what the formula would
say today, who, when, and **↺ Revert** on every line. Nothing is written onto the row and no
version row in `reco_data/` is touched, so the history still says what the file said.

Three refusals, each saying why on screen:

- **A row already posted to the general ledger.** The message names the accounting reference it
  was posted under. Reverse that entry first: the number a journal was posted with can be neither
  changed nor reverted behind the ledger's back.
- **A reference that names more than one row.** An override is kept against the key, so on three
  AP lines sharing one invoice number it would apply to all three and multiply the amount into a
  journal entry. The message says how many rows share it — add another key column, or correct the
  duplicate rows.
- **A row with no key**, which would leave nothing to find the value by once the file is reopened.

And if a reference stops naming one row later — next month's extract has two lines where last
month's had one — the override stops applying rather than picking one of them, and the load says
which ones went: **A row key built from an added column**, above. Details: handover §5c.

## Carrying a value into the next file

An added **custom** or **dropdown** column can be marked **Carry this value forward to the next
file**. With it on, a value somebody typed against a row key is already filled in when that key
turns up in a later extract, so a vendor name that has not changed is not retyped every month. It
needs **Primary Keys** as well, and the box says so until the template has them.

It is **off by default**, and off means a typed value is shown only on rows from the file it was
typed into — nothing changes for a template already in use until somebody ticks the box. When you
do tick it, the values already on screen in that column are kept against their row keys in the
same save, so the column works from the next file rather than the one after.

A carried cell is **marked**, and the mark is the point: the value is there and usable, but it was
typed against a different file and nobody has confirmed it for the one you are looking at. The
tooltip says who typed it, in which file, and when. Click **✓** beside the cell to confirm it for
this file — the value does not change, the mark goes — or type over it, which does the same.
Re-entering the same value counts, because the mark is worked out from the file the value was last
typed against rather than stored as a flag somebody has to clear. The in-app Excel view shows a
carried value but does not mark it or offer the ✓ yet, so confirm those in the grid.

Column Values says which columns carry forward, and marks each stored value **any file** or **its
own file**. Details: handover §5d.

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
leaving the tab. They read the way the grid's own read-only cells read: a date held as
an Excel serial reads `01/01/24`, not `45292`; a lookup reads the looked-up value; and a
VAT rate formatted as a percentage is `5.00%` on both screens, not `5.00%` on one and
`0.05` on the other. (An *editable* column carrying a number format is the one
exception — the grid shows it in an input box, unformatted, so `10` there can read
`10.00` here.)

Up to six columns are shown at once. Anything beyond that, and anything already on the
row as its key or as the value you are correcting, stays in the chip row and the tab
says how many and why — so a list of nine never quietly renders as four.

The choice is **yours, on this PC** — it never goes near the shared folder, so nobody
else's list changes when you pick one. **Save as the team default** publishes it (behind
a confirm that says so) as the starting list for every colleague who has not chosen
their own; their own choices still win. **Clear** and a chip's `×` only ever touch your
own list — they cannot delete the team's.

When the list in force is the team's, the tab says whose it is and when they set it
(*the team default - set by Priya on 01-Oct-26*), and the confirm says the same before
you replace theirs. A column that exists only in this session's loaded data cannot be a
team default: the app names it — in the confirm, or in a message if that leaves
nothing to publish — and it stays on your own list.

Once you have chosen for yourself you are no longer following the team, and the tab says
so (*your own choice*). **Follow the team default** gives your own choice up again and
follows theirs from then on, including a column they publish later. Whoever published can
also take it back: with your own list empty that same button reads **Clear the team
default** and, behind the same confirm, removes it so nobody is started on anything.

Once at least one column is chosen the list is shown 200 rows at a time, with **Show
200 more**; with nothing chosen the whole error list is shown exactly as before.


## The accounting reference is two characters longer

`AEMVAUQHDL` is now `AEMVAUQHDL7K`. **Tell the team**, because the reference is what people quote
to each other, write on documents and type into the GL.

The reason is worth knowing. The old reference was the clock and nothing else — one string per
millisecond — so **two people pressing Generate in the same millisecond got the same reference**,
and the record that keeps an entry was keyed on exactly that string. One of the two journal
entries was **discarded**. Both operators were told *"Entry … generated"*, both sets of rows were
stamped `POSTED` on the shared folder, and both saves **succeeded**, so nothing in either window
ever said otherwise — and the two entries were indistinguishable afterwards, so a reversal found
the first one, a document number named one of them, and a row resolved to whichever came first.

The last two characters are now drawn once per window, so two windows differ about 1,295 times out
of 1,296. For the remaining one, an entry whose reference a colleague has already taken is
recorded under a **new** reference instead of being dropped, and a message names it: *"This entry
is AEMW1Q3R8F, not AEMVAYN4CT"*, saying that nothing has been lost and that the old reference
belongs to a colleague's entry, so correct it if it has already been written down.

Nothing has to be done to existing references. The ones already on the shared folder keep their
old shape and still work everywhere. Details: handover §17.

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
node tests/e2e/run_pk_extras_e2e.mjs    # added columns in the row key: eligibility, the frozen value, the mint, and the question asked before the write
node tests/e2e/run_store_e2e.mjs        # the typed values of added columns: the shared store, the manual override, carry-forward, and what each refuses
node tests/e2e/run_correction_e2e.mjs   # the correction tab's context columns: byte-identical with none chosen, the cap and the Apply index, scope, truncation, two panes
node tests/e2e/run_panes_e2e.mjs        # two panes side by side: session ownership, id parking, per-pane scroll, ledger-write refusals, one Excel link per pane
node tests/e2e/run_reverse_e2e.mjs      # reversing a generated entry: cancel it if it never posted, contra it if it did
node tests/e2e/run_specialjv_e2e.mjs    # Special JV safety: balance at arrival/preview/commit, posted-JV tracking, ref validation
node tests/e2e/run_jv_engine_e2e.mjs    # a generated, data-only JV page driven through the real Reco — the lines TCH produces
node tests/e2e/run_jv_gen_e2e.mjs       # JvGen: the files a published Special JV is made of, and what they do on arrival
node tests/e2e/run_jv_wizard_e2e.mjs    # the Special JV creator wizard, end to end
```

Run them one at a time — each binds a fixed port block (`run_jv_core_unit.mjs` needs
neither a port nor a browser, and takes about a second). All eighteen must pass:
83 pytest cases (1 skipped), and `3,122` end-to-end checks — 250 + 73 + 41 + 65 + 94
+ 107 + 100 + 147 + 170 + 923 + 164 + 304 + 256 + 123 + 79 + 107 + 119, in the order
above.

Do **not** set `TMPDIR` for `pytest`. Six `tests/test_excel_link.py` cases decide
*shared* versus *local* from where the root sits, and a root under a different
temporary directory makes them read `local` and fail for a reason that has nothing to
do with the code. The Node suites are the other way round and want a `TMPDIR` you can
clean up: each run leaves a share root behind, and a few thousand of them fill the
disk.

A count that has gone **down** is a regression, not a tidy-up: these suites only ever
grow, and each one's header comment names the gates it exists to hold.
