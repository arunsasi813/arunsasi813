# ColSift

Pull a handful of columns out of very large text and Excel extracts — then combine
several kinds of extract, analyse them on an interactive dashboard, and export it all
in one go.

```
pip install -r requirements.txt        (pywebview, polars, fastexcel, openpyxl)
python app.py
```

`fastexcel` and `openpyxl` are optional — without fastexcel it falls back to openpyxl
and tells you so in the bottom-left of the rail. No CDN, no network calls, nothing to host.

| File | What it is |
|---|---|
| `engine.py` | All the data work for one setup. No UI imports — testable and scriptable on its own. |
| `workspace.py` | A setup's groups run together: each group's extract, then append / merge / lookup / SQL steps, relationships, one combined export. |
| `analysis.py` | Dashboard visuals, slicers, cross-filtering, drill-through and the Excel-style pivots. |
| `pdfout.py` | Dashboard and summary PDFs, written directly — no PDF library. |
| `formula.py` | Excel-style formulas compiled to polars expressions. |
| `xlsxfast.py` | Streams the first rows of an .xlsx without parsing the whole sheet. |
| `app.py` | pywebview window + JS bridge. |
| `checks.py` | Checks that pass or fail a run: row counts, unique keys, blanks, keys found, totals, a query that must find nothing. |
| `worker.py` | Runs, counts, Find and full-data dashboards in a process of their own, so running out of memory can't close the window. |
| `ui.html` | The interface. Inline CSS and JS. |
| `studio.html` | Measure Studio with ColSift's hooks — the designer and renderer of Studio visuals. |
| `studio_embed.py` | Makes `studio.html` from a Measure Studio file: `python studio_embed.py measure-studio.html`. |
| `build.py` / `build.bat` | The lean exe build — see [Building a small, fast exe](#building-a-small-fast-exe). |
| `devserver.py` | The same interface in a normal browser, for development and the UI tests. |
| `tests/` | Unit tests (`python -m pytest tests -q`) and a browser walk-through (`python tests/ui_smoke.py`). |

## What's new in 2.4 — picking columns while you write a formula

- **Suggestions as you type.** In any formula box — an added column, a filter formula, a
  dashboard value (*ƒ formula…*), a Combine step's *Keep rows where* or new column — type a
  few letters and the matching columns are listed under the cursor, best match first
  (`tax` finds `TAX_CODE`, `tc` does too), then the matching functions. ↑ ↓ choose, Enter or
  Tab inserts, Esc closes; `[` lists every column for a bracketed name; **Ctrl+Space** lists
  them all. A column whose name has spaces goes in as `[Pax Name]` by itself.
- **The columns beside the formula.** Clicking into a formula box opens a **▦ Columns** list
  on the right: the file's columns and, for an added column, **the columns added above it**
  — the ones it can use. Click a column to put it at the cursor, as many times as the formula
  needs; drag one onto the formula to put it where you drop it (never inside another name).
  Columns already in the formula are ticked, or show ×2, ×3. Buttons for `+ − × ÷ & = <> > <
  ( ) , ""` sit above the list, and **ƒ Functions** is the second tab. *Close* hides the list
  for that box; ▦ Columns under an added column brings it back.
- **A formula can use the columns added above it.** `TAX_CODE & "-" & DOUBLE`, where DOUBLE
  is an added column above, now runs and passes *Check*; before, a formula that named an
  added column lost track of the file's columns it also used, and failed with
  "Unknown column TAX_CODE".

## What's new in 2.3 — memory and a simpler dashboard

- **A sample unless you ask for every file.** Opening the Analysis tab, a slicer click, the
  rows behind a bar, a group's preview: each reads **the first 100 rows of each ticked file**
  (up to 200 files) — an .xlsx streams just those rows, a big text file its first 8 MB, a
  Parquet file its first row group. Nothing reads a whole file until you press **▶ Every file**,
  *Run all dashboards*, Count or Run. A badge beside *Data* says which you are looking at —
  **Sample · 100 rows per file** or **Every file** — and *rows per file* sets the sample size
  (saved with the setup).
- **Every file, one file at a time.** *▶ Every file*, Run and Count take the files in turn: each
  goes through the setup's steps and is written to a staging Parquet file before the next is
  opened, and the results are written from there in slices. Only one file's working set is in
  memory, however many files there are.
- **Big text files are read in blocks.** A CSV / TXT over 48 MB is read 8 MB at a time, cut at a
  record boundary (quoted commas and line breaks included), into a cached folder of Parquet
  parts — once; later reads scan the parts. The CSV reader never holds the whole file.
- **Duplicates and distinct rows without loading every file.** Each row's key becomes a
  16-byte fingerprint; the fingerprints are split into buckets of at most 500,000 keys and
  counted bucket by bucket — how many times, in how many files, first and last — and the flags
  joined back to each file's rows a million rows at a time. Every *Keep* choice (every row,
  repeats only, in several files, first, last, unique), the count, files and occurrence columns
  and *Distinct rows* work this way, in Run, Count, *Every file* and the dashboards.
- **A simpler dashboard.**
  - One **＋ Add visual** menu (each kind says what it shows) replaces the row of buttons.
  - **✨ Suggest a dashboard** lays out a slicer, a total, a row count, a breakdown, a trend
    and a donut from the columns that look right — numbers, dates and text with a handful of
    values, judged from the data itself, not just the names.
  - A card shows **Edit** and **⋯** (rows behind it, width, duplicate, remove).
  - The editor shows what it shows, the measure and the grouping first; sort, top N, number
    format, target and the filter switches sit under *More options*.
  - *Dashboard / Summaries in the output* moved into *Export ▾*.

Peak memory of one operation, 6,000,000 rows (four 1.5M-row CSVs, 454 MB), fresh process:

| | 2.2 | 2.3 |
|---|---:|---:|
| Open the Analysis tab | 367 MB | 97 MB |
| The rows behind a bar | 365 MB | 95 MB |
| A group's preview | 402 MB | 81 MB |
| Dashboard on every file | 888 MB | 204 MB |
| … with duplicates across files | 1,613 MB | 321 MB |
| Run with duplicates | 1,560 MB | 317 MB |
| Run with *Distinct rows* | 1,707 MB | 391 MB |
| Count with duplicates | 585 MB | 323 MB |

## What's new in 2.2

- **Studio visuals — Measure Studio inside the dashboard.** *✦ Studio* on the Analysis tab adds a
  visual designed in Measure Studio: KPI cards, bar lists, column and line charts, donuts,
  gauges, waterfalls, notes and tables, in its themes. The card's **measures** are set beside it
  (`Revenue` = Sum of AMOUNT, `Tickets` = Rows, `Docs` = Count distinct of DOC_NO …) and worked
  out over the card's rows after the dashboard's slicers and clicks; each block that draws rows
  gets **a row per value** of a column (or per month, quarter, year …) with every measure for that
  row, or the top records. *✦ Design* opens Measure Studio over the window with those real
  numbers in its preview; *Use in ColSift* saves the design into the card. In the studio a block
  reads `[Revenue]`, `DIVIDE([Revenue], [Tickets])`, `[@cm] - [@pm]` — its own expressions,
  evaluated against ColSift's values; a block with nothing bound stays empty on the dashboard
  rather than showing sample numbers. *Copy DAX* puts the same design on the clipboard as a
  measure for Power BI's HTML Content visual. The design is saved with the setup; the workbook
  and PDF list the card's measures. *⤓ HTML* on a card (or *Export → Studio visuals → HTML page*)
  saves the visual with the numbers on screen as a web page that opens in any browser.
- **Page through a file** on the Result tab: *Prev* / *Next* move the preview through the first
  ticked file a page at a time (the rows you set), reading only up to that page.
- **Parquet in and out.** `.parquet` / `.pq` / `.parq` files are listed with the rest and work
  everywhere — peek, columns, filters, groups, Find, Count, dashboards — reading only the
  columns a step needs; the labels are the file's own column names. **Parquet** is an output
  format too: columns stay typed (numbers, dates), while IDs, codes, values with leading zeros
  and long digit strings stay text; column formats set on the Output tab win. Dashboards,
  summaries and checks go to a workbook beside it.
- **Convert to Parquet** (Output tab): each ticked file as the source settings read it (sheet,
  header row, separator), every column, saved as `<name>.parquet` with numbers and dates typed —
  one click, in the worker. A workbook that takes a minute to open reads in a second as Parquet.
- **Column profile** (Σ on a column, Columns tab): rows, blanks, distinct values, whether it is a
  key, min / max / sum / average or the date range, and the ten most common values — for the
  open file, or *Every ticked file*.
- **Find, as a lookup.** *Load from a file…* takes the values from a column of an Excel, CSV or
  Parquet file (the column named like DOC / TICKET / REF / INVOICE / …_NO, or pick another).
  *Clean both sides*: ignore leading zeros (00123 = 123), 123.0 = 123, ignore spaces and symbols
  (AB-12 = AB12). *Ends with* joins exact / contains / starts with. **Export every match** writes
  every matching row of every ticked file — no row cap — with `SOURCE_FILE`, `MATCHED_IN` and
  `MATCH_KEY`, plus the values not found, in the Output tab's folder and format (a workbook gets
  *Matches* and *Not found* sheets).

## What's new in 2.1

- **Several folders at once.** **＋** beside *Browse* adds another folder; the files pane then
  shows a row per folder — closed until you click it — with a box that ticks all its files for
  the open group. Folders are saved with the setup.
- **A folder can belong to a group.** Pick a group on the folder's row (or *＋ Folder* on the
  group's card on the Combine tab): every file in that folder goes to that group, other groups'
  rules leave them alone, and each run reads the folder as it stands then — next month's files
  included, from the window or the command line.
- **Loading a setup shows only what is in the open folders.** It used to add every file the
  setup was saved with to the list, wherever it lived. Now each saved file stays in its group
  when the same file is listed, follows a file of the same name in the open folders, or is left
  out — and the status line says which. *＋* the missing folder and they come back. With no
  folder open, the setup's own folders open.
- **Overview — one dashboard over several tables.** Under *Data* on the Analysis tab: each card
  and summary reads the group or combined table you pick for it, side by side. A slicer or a
  clicked value filters every card whose table has that field.
- **Run all dashboards** works out every dashboard of the setup over every file in one pass,
  writing nothing; switching *Data* then shows those results without reading again.
- **"then dashboards"** beside *Run*: when the run finishes, the Analysis tab opens on the
  dashboards worked out from the run's own full data — no second read.
- **Runs can't close the window any more.** Run, Count, Find and full-data dashboards work in a
  process of their own. If one runs out of memory or crashes, it stops and says so (with the
  memory it had used); the window, the setup and everything unsaved stay. The status bar shows
  memory use, each run reports its peak, and crashes are written to `colsift.log`.
- **Duplicates across all files** (Filters tab). Pick key columns and a group looks for
  repeats over every one of its files together — a ticket in January's and February's extract
  counts twice. Keep every row, only repeated keys, keys found in more than one file, the first
  or last of each key, or keys that appear once; optional `DUP_COUNT`, `DUP_FILES` and `DUP_NO`
  columns. Keys compare trimmed and ignoring case; a blank key never repeats.
  It runs after each file's own filters and columns, in the run, Count, dashboards and
  combined groups. Preview looks within its one file and says so.
- **Run parameters** (Output tab). Write `{PERIOD}` — or any name you define — in a folder, a
  file rule, a filter value, a column's text, SQL, a check, or the output's name and folder.
  Each parameter is a fixed value, a value asked for at every run (the last answer is
  suggested), or a date worked out from today: today, yesterday, this / last month, quarter or
  year, in an Excel-style format (`yyyy-mm`, `MMMyy` → JUL26, `yyyy-Qq` → 2026-Q3). A folder
  written `D:\extracts\{PERIOD}` lists next month's folder by itself. From the command line,
  `--set PERIOD=2026-09` answers or overrides one. A regex's `\d{6}` is left alone: only names
  defined as parameters are filled in.
- **Checks** (Output tab) — reconciliations worked out on the finished tables before anything
  is written:

  | Check | Passes when |
  |---|---|
  | Row count | the table has between Min and Max rows (both blank: at least 1) |
  | Same rows as | the table has exactly as many rows as another |
  | No repeated keys | each key — one column or several together — appears once |
  | No blanks | a column is never blank |
  | Every key found in | every value of a column is in a column of another table |
  | Totals agree | a column's total equals another table's column total, or a number, within ± |
  | Query finds nothing | a `SELECT` over the tables returns no rows (`… WHERE AMOUNT < 0`) |

  A failed **Stop** check writes nothing and says why, with examples (the keys that repeat,
  the codes not found). **Warn** writes and lists it. *Check now* works them out over every
  file without writing. Results show on the Output and Result tabs, in a `Checks` sheet (or
  `<name>_Checks.csv`) beside the output and in the run log. `colsift-cli` exits with **3**
  when a check stopped the run, so a scheduled script can tell that from a failure (1).
- **Checked on Windows by GitHub Actions** (`.github/workflows/colsift.yml`): the unit tests
  run on Windows and Linux on every push. With `[build]` in the commit message (or run by
  hand), it builds `ColSift.exe` and `colsift-cli.exe` on Windows, starts the exe once with
  `--selftest` — a worker process from the exe, progress, memory, a crash that must not close
  the app, a real count and run — and attaches both exes to the run.

## What's new in 2.0

- **Groups — several kinds of file in one setup.** A setup can hold several groups, each
  with its own files (by hand, or automatically by name pattern, extension, regex, folder or
  column layout) and its own ordinary ColSift work: header, columns, filters, added columns,
  formats, dashboard. The **Combine** tab then works on those results with **append, merge,
  lookup, SQL, transform and group-and-total** steps and **relationships**, and one **Run**
  does all of it and writes one output — sheets of one workbook, or one CSV / TXT file
  each — with dashboards and summaries alongside. A setup with one group is exactly the
  1.x extract.
- **An interactive dashboard, Power BI style.** Slicers; click a bar, slice or row to filter
  every other visual (the clicked visual highlights instead); right-click for the rows
  behind any mark or pivot cell; columns, bars, lines, areas, pie, donut, stacked and
  clustered charts, heat maps; KPI cards with target and sparkline; several measures side by
  side; top-N; a table-of-rows visual; drag cards to rearrange, three widths.
- **Pivots you can work with.** Fold and unfold subtotal groups, click a value header to
  sort by it, click a cell to see its rows, heat-map shading, a chart over the pivot, report
  filters picked from a list of values with counts, and "follow the dashboard filters".
- **PDF export** of the dashboard and the summaries — separately or together, from the
  Analysis tab (exactly what is on screen) or with every run.
- **Setups travel.** Export one setup, or every setup in one file; import them on another
  machine. Names that clash get " (2)".
- **A much smaller exe.** `build.bat` builds in a clean environment into one compressed
  exe and deletes Nuitka's scratch folder — the usual reason a build looked like 1 GB+.
- Fixes along the way: the sheet picker now actually switches sheets; a slow first read
  of one file can no longer overwrite the columns of the file you clicked next; loading a
  setup no longer inherits output settings (formats, splitting) from the one open before;
  `engine.py` runs on Python 3.10 / 3.11 again (a 3.12-only f-string had crept in).

## The flow

1. **Browse** to a folder — **＋** adds more folders. Readable files are listed (under their
   folder when there are several); use the name filter for `TAX_*.xlsx`.
   Handled: `.csv .txt .tsv .tab .dlt .del .dat .prn .psv .pip .asc .out` and
   `.xlsx .xlsm .xlsb .xls`.
2. **Peek** shows the first rows exactly as they sit in the file. Click a row number to make it
   the header — rows above it grey out because they're being skipped. Set **Header → Detect
   per file** when a batch has the junk-row count varying between files.
3. **Columns** — tick what you keep, rename in the alias box, reorder with the arrows.
   *Tick from a list…* takes a pasted list of names and tells you which ones aren't in the file.
4. **Filters** — nested groups: *ALL of* (AND) / *ANY of* (OR), any depth, with **NOT** on
   any group. A live line above the builder shows the logic exactly as it will run, e.g.
   `DOC_NO is not empty AND NOT (AMOUNT > 100 OR REMARKS contains "adj")`. `( )` puts a
   condition into its own group; *Ungroup* dissolves one. Ops: empty / not empty, equals,
   contains, starts/ends with, one-of, regex, numeric comparisons, between. Conditions can
   use columns you aren't keeping. Setups saved before nesting existed load unchanged.
5. **Add columns** — fixed text, source file name, run date, row number, joined key, substring,
   zero-pad, find/replace, case, cleaned number, reformatted date, or a formula.
6. **Output** — CSV, delimited TXT, or XLSX. One combined file or one per input.
   With more than one group, *What the run writes* picks the tables, their sheet names and
   the layout — see [Groups and Combine](#groups-and-combine--several-kinds-of-file-in-one-setup).
7. **Find** (Ctrl+F) looks up specific values across every ticked file — one column,
   the columns you keep, or all of them. Paste a list of ticket numbers and it reports
   hits per file, which column matched, and **which values are not there at all**.
8. **Preview** (F5) dry-runs the whole pipeline against the first selected file.
   **Run** (Ctrl+Enter) writes.

Everything above belongs to the *open group* — the highlighted chip in the **Groups** bar
over the tabs. A new setup has one group, and then ColSift works exactly as it always has.

Save the whole setup — every group, the Combine steps, relationships, dashboards and the
output — under **Saved setups**. They go to `COLSIFT_PROFILES` if set,
otherwise a `profiles` folder beside the app, otherwise `~/.colsift/profiles` — the
rail shows which one is live. See `nuitka-build.txt` for why that order matters once
you compile.

## Filters

34 conditions, grouped in the picker:

- **Presence** — is empty, is not empty.
- **Text** — equals, contains, starts with, ends with, matches regex, each with its "does not" twin. `Aa` makes it case-sensitive.
- **List** — is one of / is not one of (comma or line separated).
- **Number** — >, ≥, <, ≤, between, not between, is a number, is not a number. Numbers read the Excel way: `1,234.50`, `(250)`, `5%`.
- **Length** — length is, greater than, less than.
- **Date** — date is, before, after, between, is a valid date, is not a valid date. Dates read day-first in any common layout (`31/07/2026`, `2026-07-31`, `31-Jul-2026`, `31JUL26`, Excel serials); type `today` for the run date. The small box after the value sets the column's layout when it isn't day-first (`mm/dd/yyyy`), and the typed date is read the same way.
- **Duplicates** — is duplicated in the file, appears once in the file.
- **Custom** — formula is TRUE: any formula returning TRUE/FALSE, e.g. `AND(AMOUNT > 100, LEFT(DOC_NO, 1) = "E")`.

The **col** toggle on =, ≠, contains, starts/ends with, >, ≥, <, ≤ and date is/before/after compares with another column in the same row instead of a typed value.

## Formulas

Excel-style, compiled to polars expressions, so they run at column speed, not row by row. [FORMULAS.md](FORMULAS.md) lists all 73 functions with examples; **ƒ Functions** in the app is the same list, searchable, with Insert.

While you write one, typing a few letters suggests the matching columns and functions, and the **▦ Columns** list beside it has every column the formula can use — click one in at the cursor (the same column as often as needed) or drag it into place.

- Columns by name — `AMOUNT` — or in brackets when the name has spaces or clashes with a function: `[Pax Name]`, `[LEFT]`.
- An added formula column can use the file's columns and every added column above it in the list. A filter formula uses the file's columns: filters run before the added columns are made.
- Text in double quotes, `""` for a quote inside. `&` joins text. `+ - * / ^ %` and `= <> < <= > >=` as in Excel; text comparisons ignore case. `;` works as the argument separator too.
- Blank is 0 in arithmetic and "" in text. A row that can't be worked out (divide by zero, a bad date) comes out blank instead of failing the run; wrap it in `IFERROR` to choose the fallback.
- `COLSUM`, `COLCOUNT`, `COLMIN`, `COLMAX`, `COLAVG` total a column over the file, optionally per group: `AMOUNT / COLSUM(AMOUNT, DOC_NO)` is each row's share of its document.
- Not available: VLOOKUP/XLOOKUP (use a Lookup column with a pasted table), SUMIF/COUNTIF (COLSUM/COLCOUNT with a group column, or a filter), OFFSET/INDIRECT, array formulas. Unknown names get a "did you mean" and, for these, a pointer to the alternative.

```
IF(AMOUNT > 1000, "REVIEW", "OK")
IFS(TAX_CODE = "YQ", "Fuel", TAX_CODE = "YR", "Carrier", TRUE, "Other")
ROUND(AMOUNT * 1.05, 2)
TEXT(DATEVALUE(ISSUE_DATE), "dd-mmm-yyyy")
EOMONTH(ISSUE_DATE, 0)
LEFT(TKT_NO, 3) & "-" & RIGHT(TKT_NO, 10)
REGEXEXTRACT(REMARKS, "PNR[: ]*(\w{6})")
AMOUNT / COLSUM(AMOUNT, DOC_NO)
```

Formula results are text in the output; give the column a Number or Date format on the Output tab to write real numbers or dates.

Other new column kinds: Copy; Part of a column (cut at a separator, −1 = last part); Extract with a pattern (regex group); First non-blank of several columns; Look up in a table you paste (two columns straight from Excel, or `KEY=value` lines — not found gives blank, the original, or fixed text); How many rows share this value; Occurrence of this value (1, 2, 3… in file order).

## Analysis and summaries

2.0 in short — see the sections below for the underlying engine:

- **＋ Add visual** puts a number, slicer, columns, trend, donut, matrix, table or Studio
  visual on the dashboard (it guesses sensible columns), or **✨ Suggest a dashboard** lays out
  several at once. **Edit** a card for the rest: visual type, several measures (shown side by
  side), grouping, and under *More options* sort, top-N, number format, target, sparkline,
  ignore filters, chart only. **⋯** on a card: the rows behind it, width, duplicate, remove.
- The numbers come from **a sample** — the first rows of each ticked file — until you press
  **▶ Every file**; the badge beside *Data* says which.
- **Slicers and clicks share one set of filters**, shown as chips above the cards. Click a bar,
  slice, point or table row to filter by it (Ctrl-click adds to it); the visual you clicked keeps
  all its values and highlights the selection, everything else filters — as in Power BI. A slicer
  lists its values under every *other* filter, with counts.
- **Right-click** any mark or table row — or *⋯ → Show the rows behind it*, or click a pivot cell — for the
  rows behind it (first 500, with the total), copyable straight into Excel.
- **Export ▾** writes what is on screen: dashboard → PDF, summaries → PDF, both in one PDF, or
  Excel / CSV.
- **Overview** (setups with several groups or a Combine step): one dashboard whose cards each
  read their own group or combined table. Pick the table in the *Add* bar before adding a card,
  or in the card's editor; each card shows its table. Filters reach every card whose table has
  the field — a TAX_CODE slicer on Sales narrows Refunds too — and are ignored by the others.
  Summary tabs pick their table the same way. With *Dashboard in the output* it is written as an
  *Overview* sheet (each card labelled with its table) and as a PDF.
- **Run all dashboards** — every dashboard of the setup (each group's, each combined table's,
  the Overview) over every file, in one pass, writing nothing. *▶ Every file* does the same
  for the dashboard on screen. Full-data results are kept: switching *Data* shows them again,
  with the time they were worked out; *↻ Refresh sample* or editing a card works them out anew.
- **then dashboards** (beside *Run*, saved with the setup): the run works out the dashboards
  from the data it has just read and the Analysis tab opens on them.


The Analysis tab reads the extracted frame — after filters, renames and computed columns, the same rows the output is written from — so what you see and what lands in the sheets is one computation. **↻ Refresh sample** reads the first rows of each ticked file (100 by default — *rows per file* beside it), the file you clicked first; **▶ Every file** runs the whole batch, one file at a time, like Count.

**Dashboard.** Cards you add, arrange and keep with the setup:

- One number — any aggregation of a column, or of a formula (`AMOUNT * 1.05`).
- Total by a column, with sorting and top-N, as a table with an optional bar chart.
- Over time — a date column grouped by day, week, month, quarter or year, with an optional line chart.
- Spread across ranges — number buckets of a size you choose.
- Cross-tab of two columns.
- Data checks — per column: rows, blanks, distinct, repeated, values that aren't numbers, values that aren't dates. Quick way to find the month where a column changed shape.

A card that can't be worked out (a column that file doesn't have, a bad formula) shows its own message; the others still draw.

**Summaries.** Each sub-tab is a pivot, built by dragging columns into Rows, Columns, Values and Report filters:

- 18 aggregations: Sum, Average, Median, Min, Max, Product, StdDev, StdDevP, Var, VarP, Count (filled cells), Count numbers, Count blanks, Distinct count, Earliest, Latest, First, Last.
- Several row and column fields, several values, per-field subtotals, grand total row and column.
- Show values as: % of grand total, % of row, % of column, % of its subtotal, running total, difference from the row above, % change from the row above, rank.
- Group a field by year, quarter, month, month name across years, week, day, weekday, number ranges, first letter or length. Sort A–Z, Z–A, biggest or smallest first, and keep the top or bottom N within each parent group.

Subtotals and grand totals are recomputed from the rows, never added up from the cells above them — the only way Average, Distinct count and StdDev come out right, and what Excel does too. Every level is one group-by and they are all collected in a single polars pass. The pivots were checked cell for cell against pandas `pivot_table` on 4,000 rows: nine aggregations by one field, two row fields crossed with month columns, subtotals, grand totals, all matching.

**PDF.** On the Output tab, *Dashboard as PDF* / *Summaries as PDF* write `<name>_dashboard.pdf`
and `<name>_summaries.pdf` beside the data on every run (or one `<name>_analysis.pdf`), A4 / A3 /
Letter, landscape or portrait: KPI tiles, the charts as vector drawings, and every table with its
header repeated on each page — a pivot wider than the page carries on across pages with its row
labels repeated. The PDFs use the built-in Helvetica font, which covers English and Western
European text; other scripts print as "?" — the Excel output carries every character.

**Which data.** The *Data* picker at the top of the tab chooses what the dashboard and
summaries read: a group's own extract (picking one opens that group), or a table made on
the Combine tab. Each has its own cards and summary tabs, all kept with the setup. A group
that a relationship starts from also gets the linked tables' columns as fields
(`Codes.DESCRIPTION`).

**Into the output.** Tick *Dashboard in the output* and *Summaries in the output*:

- When the data lands in one workbook, the sheets ride along with it: `Data`, then `Analysis` (the cards stacked), then one sheet per summary tab.
- When the output splits into several files, or the format is CSV, they get their own: `<name>_analysis.xlsx`, or one CSV per table.
- Cells are real numbers with the format you chose — a % show-as exports as a percentage — and subtotal and grand rows are bold, so the sheet can be sorted, charted or re-pivoted in Excel.

Guard rails: a pivot over about 300,000 cells or 50,000 row groups is refused with a message telling you what to change, rather than building something that is really a second extract.

## Output options

- **Column formats.** Text (the default — exactly as extracted, leading zeros kept), Number or Date. Number and Date write real Excel number and date cells with a preset or any Excel format code; in CSV/TXT they format the text. A value that doesn't read as one stays as text, and the run reports how many per column. *Detect from preview* guesses from the preview rows and leaves ID-like columns (…_NO, …_ID, CODE, TKT, DOC, PNR, long digit strings) as text.
- **Text files.** UTF-8, UTF-8 with BOM (Excel opens it without mangling Arabic or accents) or Windows-1252; CRLF or LF; decimal comma for Number columns.
- **Excel header** bold and shaded, or plain.
- **Large outputs.** Split every N rows or by the value of a column (one part per TAX_CODE, say), into sheets of one workbook or separate files. XLSX always splits at Excel's 1,048,575 data rows (Data_2, Data_3 …). At most 500 parts.
- **Run log.** `<name>_log.txt` beside the output: input files and rows, filters, files written, warnings, errors.

## Groups and Combine — several kinds of file in one setup

One setup, one Run. A setup holds one or more **groups**; each group is a kind of file (the
monthly sales CSVs, the codes workbook, the refunds TXT) with its own files and its own
ColSift work. **Run** does, in order:

1. **Each group's ColSift work** — read its files with its header / separator / sheet, keep
   and rename its columns, apply its filters, add its columns (and distinct / row limit).
   Exactly what a one-group setup has always done.
2. **The Combine steps**, in order, on those results — append, merge, lookup, SQL, transform,
   group-and-total. A step sees the group *after* its filters and column picks.
3. **One export** of every table you tick, plus the dashboards and summaries — as sheets and
   / or PDFs.

**The Groups bar** (above the tabs) shows every group with its file count. Click one and
every tab — Peek, Columns, Filters, Add columns, Find, Output formats, Analysis — edits that
group; the files ticked on the left are that group's files. *＋ Group* adds a blank group
(its own files and columns), a copy of the open one, or a saved setup as a group.
Double-click a chip to rename it, ✕ removes it.

**Combine tab**

*1 · Groups & files.* One card per group: name, on / off, its file rule, *Open* (switches the
tabs to it), *Save as setup*. The file × group grid places files by hand; **Auto-group**
places them by each group's rule:

| Rule | Example |
|---|---|
| File name matches a wildcard | `SALES_*.xlsx; SALES_*.csv` |
| File name contains | `refund` |
| Extension | `.txt; .dat` |
| Regular expression | `^TAX_\d{6}` |
| Folder name contains | `2026-07` |
| File has these columns | `DOC_NO; AMOUNT` — blank means the group's kept columns |

A file can feed several groups (two sheets of one workbook, each read by its own group). The
rules are saved with the setup, so next month *Browse* to the new folder and the files sort
themselves.

**Folders.** The files pane lists exactly what the open folders hold. Several folders are
treated as one list — a group can take files from any of them — and each can instead be given
to one group: on the folder's row in the files pane, or with *＋ Folder* on the group's card. A
folder given to a group hands it every file there (or every file its rule picks, when it has
one), keeps them from other groups' rules, and is read again at each run, so files added later
are included. When a setup is loaded, its saved files are fitted to the open folders: the same
file, else a file of the same name, else left out and reported.

*2 · Combine.* Each step makes a new table from the groups and the steps above it:

- **Append** — stack tables; columns matched by name; optional SOURCE column saying where each row came from.
- **Merge** — join on one or more key pairs: every row of the first table, only rows in both, every row of both, every row of the second, first-table rows *with* a match, or *without* one (the reconciliation case). Keys compare as trimmed text, optionally ignoring case; a blank key never matches. *First match only* makes it behave like VLOOKUP so row counts can't grow; *Match column* adds a Yes / No column.
- **Lookup** — XLOOKUP: bring chosen columns (renamed if you like) from another table by key; not found gives blank or your text. Never changes the row count.
- **SQL query** — `SELECT … FROM Sales s JOIN Codes c ON …` over any tables by name (`"Name With Spaces"` in double quotes). Columns holding only numbers are read as numbers so `SUM` and `>` work; ID-like columns (…_NO, CODE, 13-digit tickets, leading zeros) stay text.
- **Transform** — keep rows where a formula is TRUE, add formula columns, keep / rename columns, drop duplicates, sort, first N rows. Same formulas as Add columns.
- **Group and total** — one row per key with any of the 18 aggregations.

*3 · Relationships.* `Sales.TAX_CODE → Codes.TAX_CODE` (detail → lookup, many to one)
makes every column of Codes a field of the Sales dashboard and summaries, as
`Codes.DESCRIPTION` — in slicers, charts, pivots, filters and formulas — without a merge
step. The lookup side is cut to one row per key first, so totals never double; chains
(Sales → Codes → Groups) work three levels deep. **Suggest** finds likely links; **Check**
reports repeated keys on the lookup side and keys with no match.

A relationship can use a key column the group does **not** keep: the key pickers also offer
the group's other source columns (*read for the link only*). That column is read alongside
the group, used for the link, and left out of the group's own table — so the Columns tab
decides what is written, not what can be linked. The group's filters still decide which
rows take part.

*Preview a table* (bottom of the tab) shows any group or step from the first files and rows
of each group — quick however big the batch; tick *with related columns* to see the
relationship fields.

**Output tab** — with more than one group (or any Combine step) a *What the run writes* card
appears:

- **Each group as its own table**, or **stacked into one table "All groups"** with a SOURCE
  column (columns matched by name) — for groups that are the same data from different
  sources.
- **One workbook with a sheet per table**, or a workbook per table; CSV / TXT write one
  file per table, `<name>_<table>.csv`.
- **Real numbers and dates** — columns holding only numbers or dates become typed Excel
  cells (IDs and codes stay text; SQL and group totals are always numbers). A group's own
  column formats still win for its columns.
- **Which tables**, and each one's sheet or file name.

Folder, file name, header, timestamp, overwrite, PDFs and the run log are shared by the
whole setup; splitting by rows or by value and one output per input file apply to a
one-group setup. The run log lists every group, step, relationship, input file and table.

Every group is staged exactly as a one-group run is (one file at a time by default), and
each derived table is built once to Parquet before it is written, so writing a joined table
in chunks never re-runs the join.

Headless, a saved setup with groups runs the same way:

```
python engine.py --profile "Monthly close"
python engine.py --profile "Monthly close" --folder D:\extracts\2026-07 --out D:\output
python engine.py --job monthly.json
```

`--folder` re-sorts that folder's files into the groups by their rules (a setup whose only
group is placed by hand takes every readable file there, as before). Setups saved as
"workspaces" by earlier 2.0 builds load as ordinary setups with their groups, and
`--workspace NAME` / `--workspace-file` still run them.

## Sharing the exe — "Windows protected your PC"

That blue Microsoft Defender SmartScreen screen is not a virus detection. SmartScreen warns about
any program that came from the internet (a browser download, an Outlook or Teams attachment, a
zip from one of those) unless it is **signed** by a publisher it already knows. ColSift.exe is
not signed, and every new build is a new file that starts with no reputation. What helps, best
first:

1. **Sign the exe.** The prompt then names your company instead of "Unknown publisher", and the
   reputation builds on your certificate, so new versions inherit it rather than starting again.
   - *Microsoft's Trusted Signing service on Azure* — a monthly fee (around US$10 at the time of
     writing), Microsoft validates your organisation and manages the certificate; check its
     current eligibility rules for your country and whether you sign as a company or a person.
   - *A code-signing certificate from a certificate authority* (DigiCert, Sectigo, GlobalSign,
     SSL.com, …). Since 2023 the key lives on a hardware token or the CA's cloud signing service.
     An EV certificate no longer skips the SmartScreen reputation step, so a standard (OV) one is
     usually enough.
   - *Inside a company*: IT can sign with the company's own certificate, which company PCs
     already trust, or allow the exe through Defender / Intune / AppLocker.

   Once you have one, every build signs itself: set `COLSIFT_SIGN_PFX` and
   `COLSIFT_SIGN_PASSWORD` (a .pfx), or `COLSIFT_SIGN_CMD` (any signing tool's command, with
   `{file}` where the exe goes) before `build.bat`. On GitHub Actions, add the repository
   secrets `COLSIFT_SIGN_PFX_B64` (the .pfx as base64) and `COLSIFT_SIGN_PASSWORD`; the run's
   *Signature* step shows the result. `--company "Your Company"` (or the variable
   `COLSIFT_COMPANY`) puts your name in the exe's properties.
2. **Hand it over the way company software travels.** SmartScreen checks files that carry the
   "came from the internet" mark. Copying ColSift.exe from a company network share, or deploying
   it through IT (Intune, Configuration Manager, a software centre), does not add that mark.
3. **Unblock it once.** Right-click ColSift.exe → Properties → tick *Unblock* → OK (or
   PowerShell: `Unblock-File .\ColSift.exe`). Or, on the warning, *More info* → *Run anyway*.
   Either is needed once per new version on each PC.
4. **Smart App Control** (on some new Windows 11 installs) blocks unsigned programs with no
   *Run anyway*; only signing gets past it.
5. If Defender itself flags the file (a named detection, not the SmartScreen screen), submit the
   exe to Microsoft as a false positive on its security intelligence submission page. Packed
   one-file programs trip that more often; `build.bat --mode standalone` makes a folder instead,
   which is less often flagged — zip it or wrap it in an installer.

## Moving setups between machines

*Saved setups → Export* writes the selected setup as JSON — every group, step and
relationship in it (the same job file `engine.py --job` runs). *Export all* writes every
setup into one bundle. *Import…* takes
any of those (several files at once); a name already in use gets " (2)".

## Heavy batches

- **One file at a time** (default). Each input goes through the pipeline and streams to a staging Parquet file (`<cache>\staging`) before the next one starts, so only one file's working set is in memory — for a workbook, its one full parse. Outputs are then written from the staged data 200,000 rows at a time. Staging is deleted after the run; leftovers from a crash are swept after a day.
- **Several at once.** Up to four files together, plus the process-pool first read for workbooks. Faster for many small files on a multi-core machine; more memory.
- **Cancel** stops between files or chunks and deletes whatever that run wrote. A file that fails, or runs out of memory, gets its own error row and the rest carry on (unless *Stop on first error*). Per-file row counts are exact in every mode.
- **A process of its own.** Run, Count, Find, *▶ Every file*, *Run all dashboards* and
  drill-through on every file work in a separate process (`worker.py`). Memory is the usual
  reason a big batch fails — a workbook is parsed whole, a join is built in memory — and inside
  the window's process that used to close the window. Now the worker stops, the window says
  what happened and how much memory it had used, and nothing else is lost; the worker's memory
  goes back to the system the moment it ends, so the window stays small between runs. Cancel
  reaches it; one that doesn't stop within 20 seconds is ended. Only one such job runs at a time.
  The first start of a worker takes about a second (it loads polars). `COLSIFT_INPROCESS=1`
  runs everything in the window's process as before; a PC that won't start a second process
  falls back to that by itself.
- **Memory meter.** The status bar shows the window's memory and, during a run, the worker's;
  it turns amber when the PC is short of free memory and red when nearly out. The tooltip says
  how much is free. Each run's results end with its peak memory.
- **Crash log.** `colsift.log` in `%LOCALAPPDATA%\ColSift\logs` (or `COLSIFT_LOGS`) collects
  Python tracebacks from any thread and, for a crash in native code, the stack at the moment it
  happened — what to send when something goes wrong.
- Interactive reads (peek, preview, field lists) take turns, so two big workbooks are never
  parsed at the same moment; cards draw at most 1,500 rows and pivots 4,000 on screen — the
  export carries every row.

## Peek

- `.xlsx`/`.xlsm` peeks stream only the rows shown instead of parsing the sheet: 10 ms for 40 rows against 1.51 s for the full parse of the 60k-row test book. The streamed reader matches calamine cell for cell (checked on 200,000 cells across five workbook styles). When it can't prove the layout — a later row starting further left than anything read — it falls back to the full parse. `.xls`/`.xlsb` always take the full parse.
- **Peek all ticked** shows every ticked file's header row, column count, layout against the current file (missing / extra columns), approximate rows and first rows, without reading any workbook in full.
- Preview of a workbook not yet read uses its first 2,000 rows and says so; Count and Extract read it in full.

## Notes that matter

- **Search reads lines before it parses them.** When a search spans four or more columns
  of a text file, ColSift first finds the lines containing a search value anywhere, then
  parses only those. The exact per-column test still runs on them, so results match a
  full parse — checked case by case against it. It steps aside on its own whenever that
  can't be guaranteed: a file containing any quote character (quoted fields can span
  lines), a value containing the separator, a quote or a line break, or a case-insensitive
  search for non-ASCII text. Every-column search: 3.7 s → 1.0 s on the bench set.
- **Ragged files.** Text reads take their width from the widest row in the file, not the
  first. Before this, a file whose first data row was shorter than its header failed with
  a ShapeError, and headerless files silently dropped fields past the first row's width.
- **NOT is a true complement.** Every condition is strictly true/false — a blank or
  non-numeric AMOUNT is *false* for `AMOUNT > 100`, so `NOT (AMOUNT > 100)` keeps it. No row
  silently falls through both sides.
- **A file missing a column doesn't sink the batch.** Filter or formula inputs a file lacks
  read as blank, and the per-file results say so (`No REMARKS — read as blank`). Tick
  *strict columns* in the job JSON to make it an error instead.
- **Workbook cache.** calamine re-parses the whole sheet on every read, with no way to stop
  early. The first read of each sheet now writes a raw copy (every row, headerless) to
  Parquet in `%LOCALAPPDATA%\ColSift\cache`; everything after is a lazy scan of only the
  columns a query touches. Moving the header row or changing filters never invalidates it;
  editing the workbook does. Capped at 10 GB (LRU). The rail shows size and has *Clear*.
  The copies are the sheet's data — clear the cache if that matters on a shared machine.

- **Every value is read as text.** Leading zeros on doc numbers, 13-digit ticket numbers and
  IATA codes survive intact. Numeric filters cast on the fly, stripping thousands separators
  and reading `(500)` as `-500`.
- **Formula columns** cast referenced columns to numbers by default, so `GROSS - TAX` works
  even though everything is text. Untick *Treat columns as numbers* for string work like
  `DOC_NO || '-' || TAX_CODE`.
- **Excel row limit.** Past 1,048,575 rows the output splits across `Data_1`, `Data_2`… Choose
  CSV if you're going to reload it anyway — it's much faster to write.
- **Encodings.** Non-UTF-8 text files are transcoded once to a temp copy and cached by
  modification time, so repeated previews don't pay for it twice.
- **Speed.** Delimited output streams straight to disk with `sink_csv`, so the result never
  has to fit in memory. XLSX output is built by polars as vectorised XML and zipped — about
  10x faster than xlsxwriter, verified cell-for-cell against openpyxl, calamine and
  LibreOffice. `COLSIFT_XLSX=classic` switches back to xlsxwriter if you ever need to.
- **Parallel first reads.** Several new workbooks are parsed in worker processes (calamine
  holds the GIL, so threads can't). Only engages with 4+ cores and 2+ uncached workbooks over
  20 MB; if a pool can't start it quietly goes one at a time. `COLSIFT_WORKERS=1` turns it off.
  Measured for correctness, not speed — the build box had one core.
- **Delimiter detection** scores separators by *consistency* — the one that splits every line
  into the same number of fields wins — with the file extension as a tiebreak. That is what
  makes `.dlt` and ragged `.dat` files land correctly without being told.

Limits worth knowing (1.3):

- The XLSX writer — now with typed number and date cells and several sheets per book — is verified with openpyxl, calamine and LibreOffice, but has not been opened in real Excel yet. Open one output before relying on it.
- The streamed peek is pure Python XML (~3,300 rows/s): right for peeks and previews, not full reads.
- Duplicate filters, the duplicate-count and occurrence columns and COLSUM-style totals work within each file, not across the batch.
- A formula naming a column that a file lacks fails for that file (reported on its row) rather than reading the column as blank.
- The speed benefit of *Several at once* wasn't measurable here — the build box has one core.
- Exported pivots repeat the column-field label above each of its value columns instead of merging cells across them, so every column stays self-describing when you sort or filter the sheet.
- Analysis runs over the whole output group: with *split by value*, the numbers cover all the parts together, not one part each.
- Charts are drawn in the app (inline SVG) and in the PDFs (vector); the exported sheets carry the tables, not chart objects.
- Combine previews use the first 5 files of each group, up to 5,000 rows each; runs and "every file" read everything.
- A relationship joins the lookup side's *first* row per key; *Check* on the Relationships tab says when a key repeats.
- An Overview filter matches fields by name: a slicer on TAX_CODE narrows every table with a TAX_CODE column, whatever the values mean there. Rename a column (alias) when two tables use one name for different things.
- The memory meter, the crash log and the worker process were tested on Linux; the Windows parts (memory figures through the Windows API, the worker under the Nuitka exe) follow the documented interfaces but have not been run on Windows yet.

## Headless

Same engine, no window — for a scheduled monthly run:

```
python engine.py --profile "Monthly YQ tax" --folder D:\extracts\2026-07 --pattern "TAX_*"
python engine.py --profile "Monthly YQ tax" --folder D:\extracts\2026-07 --count
python engine.py --profile "Monthly" --set PERIOD=2026-09        # a run parameter
python engine.py --job job.json --out D:\output
ColSift.exe --selftest result.json                              # no window: checks the exe works here
```

Exit codes: 0 done, 1 failed, 2 setup not found, 3 a check stopped the run (nothing written).

## Building a small, fast exe

```
build.bat                      one compressed ColSift.exe in dist\
build.bat --mode standalone    a folder instead — fastest start
build.bat --cli                also colsift-cli.exe for scheduled runs
build.bat --lean               drop the openpyxl fallback too
```

`build.bat` makes a clean virtual environment (`.buildenv`), installs only
`requirements.txt` + `requirements-build.txt`, and runs `build.py`. Why the old builds were
1 GB+ and these aren't:

1. **Nuitka's scratch folder.** `app.build` (generated C, objects) sat beside `app.dist` and
   is routinely bigger than the program. `build.py` passes `--remove-output`, so it is gone
   when the build finishes.
2. **Whatever else was installed.** Nuitka follows every import it can see; a Python with
   pandas, pyarrow (300 MB+), numpy, matplotlib or Qt hands it all of that. The clean
   environment has none of it, and `build.py` also excludes them by name.
3. **One compressed file.** `--onefile` packs the program with zstd to roughly a third of the
   folder. The first start unpacks it once into `%LOCALAPPDATA%\ColSift\<version>`; later
   starts reuse that copy, so they are as quick as the folder build.

Also: xlsxwriter is not shipped (ColSift writes .xlsx itself); PDFs need no library; the
window opens while polars is still importing. `python depscan.py` re-measures what is really
imported (with 2.0's groups and PDFs: still only polars), and `python buildsize.py
dist\app.dist` shows what a folder build contains. Details in `nuitka-build.txt`.

## Measured

Two 60k-row × 40-column workbooks plus two 400k-row text files, the full UI flow:

| Step | Before | First time | Reopened |
|---|---:|---:|---:|
| Click a workbook (peek) | 1.3 s | 1.8 s | 0.01 s |
| Load columns | 2.9 s | 0.01 s | 0.01 s |
| Preview | 2.9 s | 0.03 s | 0.03 s |
| Count, 4 files | 7.7 s | 2.4 s | 0.6 s |
| Find, one column | 6.1 s | 0.3 s | 0.4 s |
| Find, every column | 12.0 s | 1.0 s | 1.0 s |
| Extract → CSV | 8.8 s | 0.6 s | 0.6 s |
| Extract → XLSX | 28.2 s | 2.5 s | 2.5 s |
| **Total** | **69.9 s** | **8.6 s** | **5.2 s** |

The first click on a new workbook is slower than before — that is the cache being written.
Count pays a one-off ~0.1 s per text file per session for the width scan (see ragged files).

1.3 on the same machine:

| | |
|---|---|
| Peek 40 rows, unread 60k × 40 xlsx | 0.01 s (full parse 1.51 s) |
| Peek all 5 bench files, nothing cached | 0.25 s |
| Preview of an unread workbook (2,000-row sample) | 0.50 s |
| Whole UI flow, cold / warm | 8.1 s / 4.8 s (1.2: 8.6 / 5.2) |
| 8 files, 2.16M rows → CSV, warm: one at a time / several | 3.4 s, 149 MB peak / 3.5 s, 200 MB |
| Same, cold (two workbook parses) | 6.7 s, 329 MB either way — the parse sets the ceiling |
| 2.16M rows → one XLSX, typed AMOUNT, 3 sheets | 12 s, 291 MB peak |
| Dashboard + 2 pivots over 4,000 rows | 0.19 s |
| Extract + dashboard + 2 summary sheets, 60k-row workbook | 1.6 s |

2.0 build, measured (Linux, Nuitka 4.2, polars 1.44, `build.py --cli`, same flags as the Windows build):

| | |
|---|---|
| Folder build (`--mode standalone`), everything that ships | 238 MB — 172 MB of it is polars' Rust core |
| One-file build (the default) | **45 MB** |
| Nuitka scratch folder left behind | none (`--remove-output`) |
| Headless run of a setup with 2 groups, a SQL join, a relationship, xlsx + 2 PDFs — including start-up | 0.9 s, first start and later ones alike |

The Windows GUI build adds pywebview and its .NET / WebView2 glue — a few MB.

## Build size

`buildsize.py` audits a Nuitka dist folder (biggest parts, what's safe to delete, `--prune` to delete it). `depscan.py` runs a full ColSift flow and reports which packages were actually imported, with the `--nofollow-import-to=` flags to add. Both are covered in nuitka-build.txt.

## Environment switches

| Variable | Effect |
|---|---|
| `COLSIFT_PROFILES` | Where setups live (default: `profiles\` beside the app) |
| `COLSIFT_CACHE` | Where the workbook cache lives (default: `%LOCALAPPDATA%\ColSift\cache`) |
| `COLSIFT_CACHE_GB` | Cache cap, default 10 |
| `COLSIFT_NO_CACHE=1` | Read workbooks directly every time |
| `COLSIFT_TEXT_CACHE_MB` | Text files bigger than this (default 48) are read in blocks into a cached Parquet copy |
| `COLSIFT_WORKERS=n` | Worker processes for first reads; `1` = off |
| `COLSIFT_XLSX=classic` | Use xlsxwriter instead of the fast writer (not in the lean build) |
| `COLSIFT_INPROCESS=1` | Run, Count, Find and full dashboards in the window's own process (no worker) |
| `COLSIFT_LOGS` | Where `colsift.log` goes (default: `%LOCALAPPDATA%\ColSift\logs`) |
| `COLSIFT_COMPANY` | Building: the publisher name in the exe's properties |
| `COLSIFT_SIGN_PFX`, `COLSIFT_SIGN_PASSWORD` | Building: sign each exe with this .pfx (see *Sharing the exe*) |
| `COLSIFT_SIGN_CMD` | Building: sign each exe with this command instead, `{file}` standing for the exe |
