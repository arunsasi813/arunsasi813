# Reco Suite — Architecture & Handover

**Status as of this build (v2)** · `apps/Reco.html` (≈11,400 lines) · `special_jv_templates/TCH.html` (≈740 lines) · `main.py` + `folder_manager.py` (Automation Hub launcher)

This document is the cold-start brief. Read it before touching code in a new session. §7 lists every issue from the previous handover and how it was resolved; §10 covers the base-folder set/switch/migrate feature; §11 the **Excel link** (📗 Edit in Excel → Load back); §12 the in-app Excel view and its options.

---

## 1. What this system is

| Piece | File | Role |
|---|---|---|
| **Launcher / Hub** | `main.py` (`LauncherAPI` + `HUB_HTML`), `folder_manager.py` | pywebview shell. Sign-in, base-folder resolution, **set / switch / migrate the base folder**, filesystem bridge. Lists and launches `.html` tools. |
| **Reco** | `apps/Reco.html` | The main app. Reconciliation workbench + AEG (Accounting Entry Generator) + Special JV orchestration. Single-file HTML/JS, no build step. |
| **Special JV** | `special_jv_templates/TCH.html` + `special_jv_mapping/TCH.json` | Pluggable bespoke JV calculators. Opened in an iframe modal by Reco, return accounting lines via `postMessage`. |

**Purpose:** reconcile large finance extracts, carry corrections/offsets forward across uploads, and generate balanced double-entry accounting lines — including JVs whose maths is too bespoke for the generic AEG template engine.

**Deployment reality:** everything runs from a network/shared folder, offline, inside a single WebView2 window. There is no server. All persistence is files on disk, written through the Python bridge. Nothing is loaded from the internet any more (PapaParse and SheetJS are vendored).

> `main.py` in this repository was **rebuilt from this document's bridge contract** (the original was not available). It implements every method listed in §3. The semantics of the "project" helpers (`list_projects`, `load_project`, …) were never documented and are a best guess — check them against any other hub app that uses them.

---

## 2. Folder structure

The launcher asks for one **base folder** once, persists it to `launcher_config.json` next to `main.py` (key `folder_path`; the older keys `folder`, `base_folder`, `root`, `path` are still read), and resolves every relative path against it. Changing it later is admin-password gated (§10).

```
<ROOT>/                                 ← LauncherAPI.folder_path (alias: data_root)
├── pwd.txt                             admin password for folder changes (default "admin123" if absent)
├── MIGRATED_TO.txt                     only in an OLD root after a migration: points launchers at the new one
├── master/
│   ├── user.csv                        sign-in table: col0=ID, col1=Name, col2=Email, then one column per app key (1/0)
│   └── accounts_master.csv             AEG Accounts Master — Reference,RC,Nominal,SubNominal,AnalysisKey,LOB
├── apps/
│   ├── Reco.html                       the app (filename stem must match a user.csv column, lowercased)
│   ├── lib/                            jspreadsheet.js, jsuites.js, *.css  +  papaparse.min.js, xlsx.full.min.js (vendored)
│   └── icon/<appkey>.png               optional tile icon (also looked up at <ROOT>/icon/; .svg/.jpg/.ico accepted)
├── aegtemplates/<templateId>.json      one JSON per AEG template
├── reco/                               all app state, one JSON per key (recoSessions.json is written compact)
│   ├── recoTemplates.json … customMasters.json
│   └── _corrupt/<key>_<timestamp>.json copy of a JSON file that could not be parsed at load (never overwritten)
├── reco_data/<dataFolder>/<MMM-YY>/<DD>.csv        versioned row store (see §5)
├── reco_data/<dataFolder>/_archive/…               full copies kept by "Compact" (Manage → Version History)
├── reco_attachments/<templateId>/<id>_<filename>   uploaded files; storedPath is RELATIVE to ROOT
├── reco_excel/<dataFolder>/<user>/<file>.xlsx      workbooks opened with "📗 Edit in Excel" (§11)
├── reco_excel/<dataFolder>/_links/<exportId>.json  Excel-link manifests (+ .base.json baselines)
├── special_jv_mapping/<REF>.json       JV definition (ref, displayName, inputColumns, accounts)
└── special_jv_templates/<REF>.html     JV calculator UI (ROOT/apps/special_jv_templates/ also works)
```

Folder names are **load-bearing** — `Store`, `Versioning`, `SpecialJV`, and `Attachments` hardcode these prefixes.

---

## 3. The pywebview connection

`LauncherAPI` is passed as `js_api`. Reco reaches it as `window.pywebview.api.*` (every call returns a Promise; a Python exception rejects it). Every path argument is **relative to `folder_path`** and cannot escape it (`../x`, `C:/x` and UNC paths outside ROOT raise `ValueError`; an absolute path that is inside ROOT is accepted for legacy attachment records; a leading `/` is treated as ROOT-relative).

### Bridge methods Reco uses

| Method | Returns | Notes |
|---|---|---|
| `read_file(rel)` | `str` | `""` if the file does not exist. **Raises** if it exists but cannot be read, or the base folder is unreachable — Reco then refuses to overwrite that key (§4). |
| `write_file(rel, data)` | `True` | Atomic (temp file + `os.replace`, retried on Windows sharing violations), serialised per path. |
| `append_csv_rows(rel, fields, rows)` *(new)* | `int` | Appends version rows without rewriting the file; adds missing header columns with a single rewrite. |
| `load_master()` / `save_master(csv)` | `str` / `True` | `master/accounts_master.csv` |
| `load_templates()` / `save_template(id, json)` / `delete_template(id)` | list / `True` | `aegtemplates/*.json` |
| `list_directories(rel)` | `list[str]` | |
| `list_files(rel)` *(new)* | `list[{name, ext, size_kb, modified}]` | Use this in new code. |
| `list_folder_files(rel)` | JSON **string** of the same list | Kept unchanged for older apps. Reco accepts either (`Store.listFiles`). |
| `save_attachment(tplId, name, b64)` | `{id, storedPath, size}` | storedPath is relative → survives a folder migration. |
| `read_attachment(storedPath)` / `delete_attachment(storedPath)` | base64 / `bool` | |
| `resolve_url(rel)` *(new)* | `file://` URL or `""` | Locates `special_jv_templates/<REF>.html` under ROOT or ROOT/apps. |
| `show_save_dialog(name)` + `write_file_abs(path, text)` / `write_file_b64_abs(path, b64)` *(new)* | | All exports (CSV, XLSX, backups, attachments, AEG template JSON) go through a native **Save as** dialog. |
| `current_username()` | `str` | Signed-in user's name (resolves the OS user from `user.csv` if the hub has not run). |
| `return_to_hub()` | — | Reco's 🏠 Hub button calls `App.returnToHub()`, which flushes pending saves first. |
| `path_exists(rel)` | `bool` | Used to find JV pages with older launchers. |
| `excel_link_*` *(new, optional)* | `{ok:true,…}` / `{ok:false, code, error}` | The Excel link engine (`excel_link.py`, §11): `capabilities`, `export_begin/rows/finish`, `job`/`job_cancel`/`job_release`, `open`, `status`, `read_start`/`read_page`, `manifest`, `update_manifest`, `list`, `close`, `pick_file`, `reveal`, `save_copy`. Never raise. Without them Reco falls back to SheetJS (§11.6). |

### Other bridge methods (for other hub apps)

`write_csv`, `write_json`, `read_file_json`, `read_csv_json`, `read_excel_json`, `excel_sheet_names`, `read_xlsx`, `write_xlsx` (openpyxl), `path_exists_json`, `launch_file` (open with the OS default program), `list_projects`, `load_project`, `load_projects_pair`, `list_project_files`, `project_metadata` (over `ROOT/projects/<name>/`), `verify_admin_password`.

### Hub-only methods

`init_app`, `login`, `logout`, `list_apps`, `open_app`, `close_window`, and the base-folder methods in §10.

### Store routing (Module 3)

`AppState.save()` is now **debounced (250 ms)** and **change-detected**: `AppState.flush()` serialises each of the 14 keys, compares it with the text last loaded/saved (`AppState._snap`) and calls `Store.save(key, data, text)` only for keys that changed. `Store.save` dispatches by key:

- `aegMaster` → `Papa.unparse({fields, data})` (union of columns) → `save_master`
- `aegTemplates` → `_syncAegTemplates`: writes only templates whose JSON changed and deletes only templates this session loaded or wrote (a colleague's new template is never deleted)
- everything else → `write_file('reco/<key>.json', …)` (`recoSessions` compact, others pretty-printed)

Writes for a key go through a per-key queue (one in flight; a newer save replaces a queued one). A failed write is toasted and retried on the next save. Keys whose file could not be **read** at load are in `Store.readOnlyKeys` and are never written in that session. `Store._hasApi()` false → localStorage (`reco_` prefix) for browser testing.

`App.returnToHub()`, `pagehide` and `window.__hubFlush()` flush pending writes; `window.__hubPendingWrites()` reports how many are outstanding.

### Boot sequence

```js
window.addEventListener('pywebviewready', bootApp);
// + poll for window.pywebview.api (pywebview can inject before the listener exists);
//   no pywebview after 1 s → browser mode. bootApp() runs once (guard).
async function bootApp() {
  await AppState.load();        // Store.loadAll; snapshots for change detection; current user
  await SpecialJV.load();       // special_jv_mapping/*.json
  populateThemeSelect(); App._wireRecoHotkeys(); App.navigate('home');
  // Store.loadProblems → one dialog listing unreadable / damaged files and bad JV mappings
}
```

---

## 4. Module map of `Reco.html`

| Module | Line | Contents |
|---|---|---|
| 0a / 0b | 25 / 514 | Themes (single Default, CSS-variable driven) + 7 colour palettes |
| 1 | 769 | `U` — uid, esc, **jsq** (safe JS string in an attribute), **num** (`(1,234.50)`, `1,234.50-`), isNumeric, **parseDate** (validates, MM/DD fallback, serial-as-text, DD-MMM-YY), fmtDate, **download** (save dialog), downloadWorkbook |
| 2 | 959 | `FMT` — format-pattern validation (D/N/A/T/S) |
| 2b | 999 | `Formula` — helpers + `{Col}` tokens, **compiled once per formula**; new `NUM()` helper |
| 2c | 1265 | `FilterOps` — 21 operators; numeric ops understand `1,234.50` |
| 3 | 1335 | `Store` — bridge router, write queue, load-problem tracking |
| 3aa | 1559 | `Masters` — Accounts / Doc Numbers / Corrections / Custom masters |
| 3b | 1665 | `Versioning` — the `reco_data/` CSV store (§5) |
| 3c | 2018 | `SpecialJV` — registry, src resolution, iframe modal + handshake (§6) |
| 3d–3i | 2220–3029 | Groups, Attachments, Timeline, Comments, FilterSets, Find & Replace |
| 4 | 3316 | `AppState` — state, debounced `save()`, `flush()`, `load()`, `currentUser` |
| 5 | 3426 | `App` — navigation, modal, backup/restore (`version: 4`), `returnToHub` |
| 6 | 3545 | `Home` |
| 7 | 3723 | `RecoTemplate` — 5-step wizard; `dataFolder`; validation |
| 8 | 4685 | `Reco` — the engine, Excel view (jspreadsheet), sheet mode, virtualised grid, reports, entries, preview/commit, groups, manage (+ Version History) |
| 9 | 10428 | `AEG` — generic double-entry template engine |

Additional-column values (master lookups, formulas, tags) are computed in one place: `Reco._rowWithExtras(tpl, sess, row)` (cascading, declaration order). The grid, Excel view, filters, sort, slicers, pivot, custom reports and exports all use it.

---

## 5. Versioned data store (`reco_data/`)

Path: `reco_data/<dataFolder>/<MMM-YY>/<DD>.csv`. `dataFolder` is fixed when the template is created (from its name, made unique) and stored on the template, so **renaming a template keeps its history**. Old templates without `dataFolder` keep using `_safe(name)`.

Control columns: `_pk` (PK columns joined with `||`, or `_auto_<uid>`), `_ver` (`upload`, `C1`, `C2`, …), `_ts`. The `_pk` written at upload is the row's session `_pk` (previously a second random `_auto_` key was generated, so edits on PK-less templates never matched their upload row).

- Header = control columns + template columns + every key present (Papa's default would drop columns added later).
- Writes are serialised per file. With the new launcher, rows are **appended** (`append_csv_rows`); with an older one the file is read strictly and rewritten (a failed read aborts instead of rewriting with only the new rows).
- Single-cell edits (grid, Excel view, sheet mode, fill) go through `Reco.applyEdits` and are queued for 150 ms and written as **one `Cn` per PK per burst** (`Versioning.queueChange`).
- Edits loaded back from Excel are written **history first** (`appendChangesBatch(tpl, pkRows, meta)`; the session only changes once the rows are on disk) and carry two audit columns, `_src` = `excel:<exportId>` and `_by` = user. Reopening data copies only template columns, so these never reach the rows.
- `Versioning.changesSince(tpl, isoTs, pkSet)` returns the newest `Cn` per key written after a moment (used to detect colleagues' edits while a workbook was out in Excel).
- `collapseToActive()` — highest `Cn` per PK, else `upload`; ties go to the row written later.
- Opening a file (`Reco.loadVersionedFile` → `Versioning.loadActive`) applies the latest `Cn` from **newer** files, because edits always go to the day's file. Auto-load picks the newest file that contains `upload` rows.
- **Compaction** (Manage → Version History): keeps every upload row and the latest `Cn` per PK; optionally archives the full file to `_archive/` first.
- Ingesting data warns when rows share a primary key (they collapse to one when reopened from history).

---

## 6. Special JV — the whole mechanism

### 6.1 Registration

`SpecialJV.load()` lists `special_jv_mapping/*.json` (`list_files`, or `list_folder_files` on older launchers), parses each, and registers `registry[ref]` with `def.htmlPath = 'special_jv_templates/<ref>.html'` (derived — `ref` must equal the HTML filename stem). Mapping files without `ref`, unreadable files and duplicate refs are reported in the load-problems dialog.

### 6.2 Mapping JSON shape

```json
{
  "ref": "TCH",
  "displayName": "TCH JV — Cross Currency & Charges",
  "inputColumns": [ { "name": "Date" }, { "name": "Txn Type" }, { "name": "Currency" }, { "name": "FC Amount" } ],
  "accounts": {
    "clearing": { "nominal": "17036", "rc": "78061" },
    "crossCcy": { "nominal": "85001", "rc": "78061" },
    "charges":  { "nominal": "35008", "rc": "50000" },
    "subNominal": "0", "analysisKey": "0", "lob": "51"
  }
}
```

`inputColumns` is the **projection contract**: `Reco.openSpecialJv` copies only these columns (plus `_pk`, `_id`). Names match exactly first, then ignoring case/spaces/underscores (`TxnType` feeds `Txn Type`); Reco toasts any input column with no values at all. `accounts` is optional and read by TCH (defaults = the codes above).

### 6.3 Trigger path

1. A template has `aegIntegration.enabled` and a linked AEG template.
2. The AEG **To Account** input column is a dropdown of Accounts Master references **plus** JV refs (`⚡ <displayName> (Special JV)`).
3. **Preview Entry** uses the selected rows, or every visible open row when nothing is selected (both buttons).
4. The preview works on **copies** of the rows (computed values are not written back into the session) and splits them: JV refs → `jvBuckets[ref]`, the rest → standard AEG lines.
5. One banner per bucket with **Complete →**; **Generate** stays disabled until each bucket has a completed JV for exactly those rows.

### 6.4 The iframe handshake

`SpecialJV.open(ref, payload, onComplete, onCancel)`:

- sets `window._specialJvInputs / _specialJvRef / _specialJvDef`;
- resolves the page: `resolve_url()` (new launcher) → else `../special_jv_templates/…` when Reco runs from `ROOT/apps/` and `path_exists` finds it at ROOT → else the old relative path; adds `?t=<now>` cache-buster;
- listens for messages **from that iframe only** (`ev.source === iframe.contentWindow`), any stale listener is removed first and when the modal closes.

The JV page reads the globals from `window.parent` when it can. Chromium isolates `file://` documents unless the browser runs with `--allow-file-access-from-files`, so when that read throws the page posts `{type:'specialJV.ready', ref}` and Reco answers `{type:'specialJV.init', ref, def, inputs}`. Both paths are tested.

The JV returns:

```js
parent.postMessage({ type: 'specialJV.complete', ref, jvId, lines, primaryKeys, inputData, meta }, '*');
parent.postMessage({ type: 'specialJV.cancel',   ref }, '*');   // cancel
```

A `complete` with no lines is treated as a cancel (it used to unblock Generate with zero lines). Line objects use the AEG output column names: `Reference, RC, Nominal, SubNominal, Analysis Key, LOB, Cur, Reco, Dr, Cr, Doc, Desc`.

### 6.5 Pending JV lifecycle

A completed JV is stored in `AppState.pendingSpecialJV[templateId]` with `sentPks` (rows sent), `primaryKeys` (rows consumed), `lines`, `meta`, `ts`. On every preview, `_fromCurrentSelection` is **recomputed**: a pending JV satisfies a bucket only if it was computed for exactly those rows. Others appear as *Carried forward* (with Discard) and are included in the entry. A completed one can be redone (**Redo**).

`commitEntryFromPreview` merges standard + JV lines into one `entryHistory` record (`specialJvIds`, `specialJvs[{jvId, ref, primaryKeys, meta}]`, `createdBy`), applies the post-entry classification to the standard rows and to the rows each JV **consumed** (rows sent to a JV but left unassigned there are not marked), versions that change when the column is a template column, and removes the consumed pendings.

### 6.6 TCH specifics

**Inputs:** `Date`, `Txn Type` (`RAPID` or `OF*`), `Currency` (RUB/USD/EUR), `FC Amount`. One field-name list per field is used everywhere (`FIELDS`), and one `classify(row)` decides RAPID / OF / ignored for both the totals and the row colouring. Ignored rows show why.

**UI:** N sections, each with a period (MM/DD/YY), Range Preset (three slots per month in the data), Reco code, auto-computed Rapid (RUB/USD/EUR) and OF (RUB) totals, five Sale Data fields. **Auto-assign by period** and **Assign all rows to…** fill the row assignments. Typing no longer rebuilds the form (it used to lose focus after every keystroke).

**Lines per section** (zero amounts skipped, sides swapped when negative, amounts rounded to 2 dp):

| # | Description | Amount | Dr | Cr |
|---|---|---|---|---|
| 1 | Cross Currency Adjustment (RUB) | `rubEqUsd + rubEqEur` | clearing 17036 / 78061 | crossCcy 85001 / 78061 |
| 2 | Cross Currency Adjustment USD | `rapid.USD` | crossCcy | clearing |
| 3 | Cross Currency Adjustment EUR | `rapid.EUR` | crossCcy | clearing |
| 4 | BSP TCH Charges | `-(of.RUB + rubEqUsd + rubEqEur + rapid.RUB)` | charges 35008 / 50000 | clearing |

Remarks: `Cross Currency Adjustment Entry for DD MMM - DD MMM YY` / `BSP TCH Charges for …` — the period is now parsed as MM/DD/YY (it was parsed day-first, so "10/01/26 → 10/10/26" read as January–October).

Submit validates **every** section's period (and From ≤ To), asks once about empty Reco codes and about unassigned RAPID/OF rows, and checks each currency balances within 0.01. `meta.sections` carries each section's period, sale data, totals and consumed PKs for audit. `RUB (no 2.1)`, `RUB Total (no 2)` and `TCH Charges` are recorded in `meta` but, as before, not used in the postings.

---

## 7. Issues from the previous handover — resolution

| # | Issue | Resolution |
|---|---|---|
| 1 | `self.data_root` did not exist → attachments silently went to localStorage | `data_root` is an alias of `folder_path`; attachments are stored with relative paths; Reco no longer falls back to localStorage when the bridge exists (failures are shown). |
| 2 | CDN dependency | PapaParse 5.4.1 and SheetJS 0.18.5 vendored in `apps/lib/` (same versions; CDN only as fallback if lib/ lacks them). |
| 3 | Dead `App.init()` | Removed. Boot is `bootApp()` with a run-once guard. |
| 4 | Asymmetric list return types | `list_files()` and `list_directories()` return lists; `list_folder_files()` keeps its JSON string for older apps; Reco accepts both. |
| 5 | TCH field-name candidates inconsistent | One `FIELDS` list + one `classify()` used by totals and colouring. |
| 6 | TCH account codes hardcoded | `accounts` in `special_jv_mapping/TCH.json` (defaults unchanged). |
| 7 | All 14 keys rewritten on every save | Only changed keys are written; `recoSessions.json` compact. |
| 8 | No write debouncing | 250 ms debounce + per-key serial queue + flush on hub/close. |
| 9 | Version files never compact | Manage → Version History → Compact (optional archive). Edits appended instead of rewriting. |
| 10 | `postMessage('*')` | Messages are accepted only from the JV's own iframe; the parent→iframe handshake also uses the iframe's window. (`'*'` remains the target because `file://` origins are `"null"`.) |
| 11 | Backup format | Unchanged (`version: 4`, v2 accepted); restore now asks for confirmation; session restore warns on template mismatch. |
| 12 | Lightly exercised modules | Covered by the end-to-end tests (`tests/e2e`). |

### Other defects found and fixed in this build

- **Data integrity:** concurrent edits overwrote each other's version rows (read-modify-write race); `Papa.unparse` dropped columns not in the first row; corrupt `reco/*.json` was silently replaced by an empty file on the next save (now preserved in `reco/_corrupt/`); an unreachable share at load could lead to empty data being saved over the real file; renaming a template orphaned its history; PK-less templates duplicated rows on reload; edits saved on a later day were invisible when reopening the upload file; Excel-view "number format" wrote formatted text (`(1,234.56)`, `AED 1,234.56`) into the data; the preview wrote computed/stale lookup values into session rows.
- **Special JV / entries:** cancelling the JV recorded an empty JV and unblocked Generate; a stale listener from a closed JV modal could fire on the next JV; `_fromCurrentSelection` was persisted as `true`, so an old JV for different rows could satisfy a new preview; rows sent to a JV but not consumed were marked as posted; the top **Preview Entry** button ignored the selection.
- **Crashes / wrong results:** right-click row menu crashed (`sess` undefined); Find & Replace missed matches (global regex `lastIndex`) and treated `$&` in plain-text replacements as a pattern; **Clear Loaded Data** immediately re-loaded the latest file; a slow auto-load could land in another template; selection bar/Excel view ignored *percentage* tolerance; custom report cards showed "undefined" and always summed; report computed columns could not use extra columns; export/pivot/report ignored `master_lookup` columns and values typed into extra columns; exports turned `0` into blank; numbers like `(1,234.50)` and `1,234.50-` counted as 0; `{A}-{B}` with negative `B` gave `#ERR`; numeric sort/filters read `1,234` as 1; `31/02/2026` rolled into March; Excel serials stored as text were not dates; Excel dates shifted a day west of UTC; values containing `'` broke buttons (103 handlers now use `U.jsq`); quick-edit mode leaked into the next template edit (could lose a new template); deleting a template left its groups, comments, attachments and pending JVs behind; step 3 of the wizard had a duplicate, lossy copy of the additional-columns editor; AEG had five duplicate method definitions (dead code removed); `aegSettings.currentUser` was shared by everyone on the folder (identity is now per session from the launcher).

### Known limitations (not changed)

- Multi-user: two people saving the same `reco/<key>.json` — last writer wins (change detection only reduces the overlap). Version CSV appends are safe.
- Formula tokens are numbers only for plain numerics; use `NUM({Amount})` for `1,234.50` / `(10)`.
- jspreadsheet/jsuites are not in this repository; keep the copies already in `apps/lib/`.

---

## 8. Adding a new Special JV — checklist

1. Write `special_jv_templates/<REF>.html`. Read `window.parent._specialJvInputs / _specialJvDef / _specialJvRef` inside `try`; if that throws, post `{type:'specialJV.ready', ref:'<REF>'}` and wait for `{type:'specialJV.init', inputs, def, ref}` (copy the pattern from TCH.html §0 and §10).
2. On submit post `{type:'specialJV.complete', ref, jvId, lines, primaryKeys, inputData, meta?}`; on cancel post `{type:'specialJV.cancel', ref}`.
3. Write `special_jv_mapping/<REF>.json` with `ref` exactly matching the HTML stem, a `displayName`, and every input column the calculator needs.
4. Reopen Reco (the registry loads at boot). The ref appears in the To Account dropdown and on Home.
5. Emit lines with the AEG output column names, amounts as 2-dp strings, balanced per currency — Reco does not re-validate.

---

## 9. Quick orientation for a fresh session

- **"Where does X get saved?"** → `AppState.flush` → `Store.save` (Module 3).
- **"Why is the JV empty?"** → `inputColumns` in the mapping JSON (`Reco.openSpecialJv`); Reco toasts input columns with no values.
- **"Why can't I click Generate?"** → `canGenerate` in `_renderPreviewModal`: every bucket needs a completed JV for exactly those rows (`SpecialJV.matchesRows`).
- **"Where is the row data on disk?"** → `reco_data/<tpl.dataFolder>/<MMM-YY>/<DD>.csv`; active view = `Versioning.loadActive`.
- **"How do I test without the launcher?"** → open `Reco.html` directly (localStorage mode), or run the e2e suite which drives the real bridge.
- **Tests:** `python -m pytest tests/` (launcher + migration engine) and `node tests/e2e/run_e2e.mjs` (Reco, TCH and the hub in Chromium against the real `LauncherAPI`, including an "older launcher" mode).

---

## 10. Base folder: set, switch, migrate

All in the hub (📁 **Base folder…**, admin password from `ROOT/pwd.txt`, default `admin123`; when the share is offline the last verified password, cached as a hash in `launcher_config.json`, is accepted).

- **First run** — choose the folder; if it has no `apps/`, `master/` or `reco/`, the hub offers to create the standard structure (`folder_manager.init_skeleton`, never overwrites) including `master/user.csv` with the current Windows user and access to every app found.
- **Switch to an existing folder** — points the hub at another folder that already holds the data (no copy). Recent folders are listed.
- **Migrate all files to a new folder** — `folder_manager.MigrationJob`:
  1. preflight: refuses the same folder or nested folders, checks the destination is writable and has space, counts conflicts (policy: *stop*, *keep existing*, *overwrite*);
  2. copies every file (temp file + rename, timestamps kept, Windows long paths), with progress and Cancel;
  3. verifies sizes (and SHA-256 when "verify" or "move" is chosen);
  4. switches `launcher_config.json` to the new folder only after verification;
  5. optionally removes the originals (a *move*; requires typing MOVE; only files whose copy matched by SHA-256);
  6. writes `MIGRATED_TO.txt` in the old folder — any launcher still pointing there offers **Switch to the new folder**.

  Nothing is switched if any file fails to copy or verify. Because every stored path (attachments included) is relative to ROOT, the app works unchanged in the new folder.

---

## 11. Excel link — "📗 Edit in Excel" and Load back

**What the user sees.** In a template's Reco view, **📗 Edit in Excel** opens a dialog (rows: shown / open / selected / all; columns: as shown / all template columns; protection; date format; shared folder or this PC). **Create workbook** writes a real `.xlsx` and opens it in Excel. A green banner then follows the file: *not saved yet* → *Excel is saving…* → *Saved in Excel at 10:42 · changes not loaded* (amber, with **Load back**; a toast offers the same). **Load back** reads the saved file, compares it with Reco and opens a review: **Changes** (ticked), **Conflicts** (changed in Excel *and* in Reco since the export — default *Keep Reco*), **Problems** (never applied) and **Info**. **Apply** writes the ticked edits; the grid, Excel view, pivot and reports all recompute from the updated rows. **📗 Links** (toolbar) and **Manage → 📗 Excel Links** list every workbook (mine / everyone; open, saved-not-loaded, closed, stale) with Load back, Open, Show in folder, Save a copy, Close link and **Load from file…** (for a copy saved elsewhere).

### 11.1 Pieces

| Where | What |
|---|---|
| `excel_link.py` | Engine: workbook writer (openpyxl `write_only`), reader (two passes, snapshot copy), save detection, manifests, background jobs, sweep. Pure functions are unit-tested. |
| `main.py` | Thin `LauncherAPI.excel_link_*` wrappers. Every call returns `{ok:true,…}` or `{ok:false, code, error}` and never raises. |
| `apps/Reco.html` · `XlSchema` (module 3j) | The column model shared by the Excel link and the in-app Excel view: which columns exist and which are editable with which editor, `canon()` (the only comparison function), `coerce()` (write back in the row's own style). |
| `apps/Reco.html` · `ExcelLink` (module 3k) | Dialog, export, banner/polling, Load back (read → match → three-way diff), review, apply, links panel, SheetJS fallback. |
| `Reco.applyEdits(tpl, sess, edits, opts)` | **The one write path** for cell edits (grid `editCell`/`setTag`, the Excel view and the Excel link). |
| `Versioning.appendChangesBatch(tpl, pkRows, meta)` / `changesSince(tpl, isoTs, pkSet)` | `meta` adds audit columns `_src` (`excel:<exportId>`) and `_by`; `changesSince` returns the newest `Cn` per key written after a moment (colleagues' edits while the workbook was out). |

### 11.2 Files

```
<ROOT>/reco_excel/<dataFolder>/<user>/<Template>_<yyyymmdd-HHMM>_<id4>.xlsx   the workbook (shared area, default)
<ROOT>/reco_excel/<dataFolder>/_links/<exportId>.json                         head manifest (small, updated on every import)
<ROOT>/reco_excel/<dataFolder>/_links/<exportId>.base.json                    baseline values + row signatures (written once)
%LOCALAPPDATA%\AutomationHub\ExcelLink\<file>.xlsx                            "This PC" area (and the fallback for long paths / read-only share)
```

`exportId` = `X<yyyymmdd>T<HHMMSS>-<4 chars>`. Workbooks are never overwritten. Closed links' workbooks are deleted after a day (unless open in Excel), their manifests after 90 days; open links are never cleaned up, only flagged *stale* after `staleDays` (7).

### 11.3 The workbook

| Sheet | Content |
|---|---|
| `Reco Data` | Row 1 headers, data from row 2. Hidden **A `__reco_row_id`** (= `row._id`) and **B `__reco_key`** (= `row._pk`), C `Reco Status`, then the columns in Reco's order. Editable cells yellow (unlocked), read-only grey, ids grey. Typed cells: dates are real dates (`dd-mmm-yyyy` by default so a day/month swap is visible), amounts numbers with `#,##0.00;(#,##0.00)`, text always text (so `000123` and `=…` stay as typed — no formula injection). Freeze panes at D2, autofilter over every column (A:B included, so sorting moves the ids with their rows). |
| `How to use` | Steps, notes, a table of the columns (editable? how? allowed values) and the To-Account codes. |
| `Lists` (hidden) | One column per dropdown; data validation uses defined names `RecoList_<n>` (no 255-character limit, commas allowed). Strict lists stop invalid input; datalist columns only warn. |
| `_reco_meta` (very hidden) | Export id, template id, data folder, column model (JSON) — so a copy can be loaded from anywhere. |
| `_reco_base` (very hidden, ≤ 20,000 rows) | Baseline copy used when the shared manifest is not reachable. |

Protection modes: **Guarded** (default; no sheet protection, read-only columns shaded and guarded by a custom validation, sorting works), **Locked** (sheet protected without password, filtering allowed, Excel refuses to sort; three unlocked "Notes" scratch columns), **None**. In every mode the **importer** is what keeps the data correct; Excel's validation can be bypassed by paste.

### 11.4 Save detection

Reco polls `excel_link_status` every 2 s while the template is on screen (and on window focus; every 10 s after 10 quiet minutes). "Open in Excel" comes from Excel's `~$<name>` owner file; "saved" means size/mtime changed and stayed the same for 1.5 s. Status never opens the workbook (no lock probe while Excel saves). Folder migration skips `~$` files.

### 11.5 Load back

1. Flush pending saves; the launcher **snapshot-copies** the workbook (retries while Excel is mid-save) and reads the copy twice with openpyxl (formulas, then cached values). Rows whose cells are byte-identical to the export (row signature) are not sent to the page; rows that were already loaded once are always sent, so a revert is still seen.
2. Identity: template id must match. Sheet found by the `__reco_row_id` header (renamed sheets and title rows are fine). Headers mapped by exact text → normalised text → position. Rows matched by hidden id; if the data was reopened since the export (`_id` regenerated) they re-match by unique `_pk` (badge *re-matched*). Hidden columns deleted → key column → visible primary keys (after a confirmation). A fingerprint of read-only identity columns (keys, value, doc number, or the template's `excelLink.fpCols`) detects rows that were sorted only partly or pasted over (`rowMisaligned`, row skipped).
3. Three-way rule per editable cell: `B` = value at export (or as last loaded), `C` = Reco now **including shared history written after the export**, `E` = Excel. `E=B` unchanged · `E=C` already applied · invalid (not in list, not a date/number, Excel error, formula without a value, merged cell) → Problem · `C=B` → Change (ticked) · otherwise → Conflict (Keep Reco by default). Changes are unticked when the row was offset or posted since the export, when a pending Special JV used the row (To Account), and when more than 50 cells / 20 % of a column were cleared.
4. Values are compared through `XlSchema.canon` (dates `D:YYYY-MM-DD`, amounts `N:<number>`, text trimmed with NBSP/CRLF normalised, dropdowns matched case-insensitively and spelled as the option). Leading zeros lost by Excel (`000123` → 123) count as unchanged.
5. **Apply** revalidates (rows still there, values unchanged since the review, history queue empty), then `Reco.applyEdits(…, {historyFirst:true, meta})` writes **one `Cn` per key first** and only then changes the session — if the history write fails nothing changes. A colleague's newer values for other columns of the same key are carried into that `Cn` so they are not reverted. Tag columns go to `sess.manualTags` (session only, as in the grid); a non-template To-Account column to the row. The manifest is then rebased (`rebased`/`dismissed`/`imports`/`lastImport`), so loading the same file again shows nothing new and only later edits appear next time.
6. Rows deleted in Excel are never deleted in Reco; rows added in Excel are counted and ignored (use **+ Persistent Row**).

### 11.6 Fallback (older launcher or browser)

Without `excel_link_*` (or without openpyxl) the workbook is built with SheetJS in the page and downloaded: same layout and hidden sheets, visible `Lists` sheet, **no dropdowns, colours or protection**. After saving in Excel, **Load from file…** reads it with SheetJS and goes through the same review and apply. With an older launcher that still has `write_file`, the manifest is written to the same `_links/` folder.

### 11.7 Template options

Template wizard → step "Columns & display" → **Excel view & Excel link**: default rows/columns/protection/date format/area, stale days, identity columns (`tpl.excelLink`), and the in-app Excel view's edit scope, key-column policy and display defaults (`tpl.excelView`). Users override the view defaults for themselves with **⚙ View** (stored in their browser profile; they can only *narrow* the edit scope).

### 11.8 Known limitations

- Tag and To-Account extra columns are session-only, as before (lost when data is reopened). `recoSessions.json` remains last-writer-wins across users.
- Duplicate primary keys collapse to one row per key in history; a change to one duplicate is applied to all rows with that key.
- New rows typed in Excel are not imported (v1).
- openpyxl cannot write "ignore error" flags: text cells holding digits show Excel's green triangle (harmless, explained on *How to use*).
- Real Excel behaviour (repair prompts, owner-file naming on the share, Protected View, export time on a slow share) cannot be tested in CI — see the manual checklist in §11.9.

### 11.9 Manual checks on a Windows PC with Excel

1. Guarded mode: sorting works; typing in a grey column is refused (paste is not — expected). Locked mode: filtering works, sorting is refused.
2. After a save in Excel: no repair prompt; hidden sheets, dropdowns and comments survive.
3. Save repeatedly while Reco is open: the banner moves to *Saved* and Excel never reports a sharing violation.
4. **Open again** brings the open workbook to the front; Excel not installed → *Save a copy…* works.
5. Export 20k × 20 on the share and compare with the dialog's time estimate.
