# Reco Suite — Architecture & Handover

**Status as of this build (v2)** · `apps/Reco.html` (≈11,400 lines) · `special_jv_templates/TCH.html` (≈740 lines) · `main.py` + `folder_manager.py` (Automation Hub launcher)

This document is the cold-start brief. Read it before touching code in a new session. §7 lists every issue from the previous handover and how it was resolved; §10 covers the new base-folder set/switch/migrate feature.

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
- Single-cell edits (grid, Excel view, sheet mode, fill) are queued for 150 ms and written as **one `Cn` per PK per burst** (`Versioning.queueChange`).
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
