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
├── special_jv_mapping/<REF>.json       JV definition (ref, displayName, inputColumns, accounts, jvSpec, audit)
├── special_jv_mapping/.lock_<REF>.json advisory lock while a JV is being published (invisible to list_files)
├── special_jv_templates/<REF>.html     JV calculator UI (ROOT/apps/special_jv_templates/ also works)
├── special_jv_templates/_engine/…      the reviewed JV engine a generated page loads (§6.7)
├── special_jv_drafts/<REF>.json        a JV being built: data only, never registered
└── special_jv_archive/<REF>/<stamp>_<user>/{<REF>.json,<REF>.html}   the version a publish replaced
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
| 2c | 1265 | `FilterOps` — 22 operators; **the one table of which operators suit which column kind** (`kindOf` / `opsFor` / `suits`), and the one evaluator (§7a) |
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

Four modules were added after those line numbers were taken, and are found by
their banner comment rather than by line (`MODULE 2d — JV ENGINE`, and so on):

| Module | Contents |
|---|---|
| 2d | the three `_engine/` files carried verbatim as inert text, `JV_ENGINE_VERSION`, `JV_ENGINE_FILES`, and `JVCore` built by evaluating the core island — so Reco runs the same text it writes to the share (§6.7) |
| 3j / 3k | `XlSchema` and `ExcelLink` — the Excel round trip (§7) |
| 9b | `JvGen` + `JvCreator` — the two texts, and the write path onto the share (§6.8) |
| 9c | `JvWizard` — the nine-step creator and its live test-run (§6.9) |

Additional-column values (master lookups, formulas, tags) are computed in one place: `Reco._extraOwnValue`, reached through `Reco.rowFull(tpl, sess, row, uptoName)` (cascading, declaration order). The grid, Excel view, filters, sort, slicers, pivot, custom reports and exports all use it.

### Shared helpers worth knowing before you add a feature

Several features were each about to grow their own copy of the same thing, so
these exist once. Added as foundations; most have no second caller yet.

| helper | what it is | why |
|---|---|---|
| `Reco._runState(tplId)` | per-app-run state, never serialised | a latch or an "is loading" flag written to the shared folder outlives the run that set it and reaches colleagues who never saw the event (see §5a) |
| `AppState.saveKeys(...keys)` | write only the named keys, debounced on `SAVE_DELAY` like `save()` | `save()` serialises every persisted key to decide what changed; `recoSessions` alone is 798–1378 ms / 85.6 MiB at 200k rows. **It is no saving at all for a view preference**, because those live on `sess` inside `recoSessions` — making those cheap means moving them out |
| `Masters.indexFor(tpl, ac, ctx)` | matchKey→returnKey `Map`, built once per render pass | replaced a per-row scan of the master. Threaded as an explicit per-call `ctx`, **never** module-cached: a stale master is a wrong account code |
| `Reco._fullPass()` / `_fullEnd()` / `_fullCtx()` | the render pass that owns that `ctx` | **every opener is paired with a `finally`.** An index that outlives its render is a stale chart of accounts: edit an account, re-render, and the grid still shows the old nominal. That bug was shipped into the working tree once and caught by two reviewers |
| `Reco.rowFull(tpl, sess, row, uptoName)` | the row enriched with its additional columns, threading the pass `ctx` | there is deliberately **no** whole-row memo: `uptoName` is set on every real call, because an additional column must see only the columns declared *above* it, so a whole-row memo is never read |
| `Reco.displayCellValue(...)` | the one display rule | replaced the grid's private "does the column name contain the word date" branch |
| `Reco.columnCatalog(tpl, sess)` | one column list | replaced three hand-rolled ones |
| `fileNames` / `extraNames` / `allNames` in `saveTemplate` | the name sets every prune reads | the prune they replace tested against `t.columns` alone, so anything else naming an added column was silently deleted on save |

Two things deliberately **not** done, recorded so they are not re-attempted
blind. `manualTags` is still keyed on the session `_id`, so a value typed into an
added column does not survive a reload; re-keying it onto `_pk || _id` was tried
and refused, because it still lands on `_id` for a keyless template, it lives on
the session so Clear Data destroys it, it is serialised inside the 85.6 MiB blob,
and being per-session it cannot carry a value across *files* — the durable
`_pk`-keyed store lands with the features that need it. And a "someone else
changed this template while you had it open" check was written and removed:
`AppState.recoTemplates` is read once, at boot, so the comparison only ever saw
this session's own object and could never fire. The hazard is real — the editor
deep-clones on open and `saveTemplate` replaces the whole object, so a field a
colleague set at 10:00 is wiped by a save from a 09:00 clone — and detecting it
means re-reading the stored template from the share at save time, which makes
`saveTemplate` async.

---

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

### 5a. Opening a reco: what loads, when, and what the screen says

The user's report was *"once the reco is opened its first shown just not loading
the data and only when clicking only its loading the data"*. The cause was a
latch: `sess._autoLoadAttempted` was an ordinary session property, and
`Store.serialize` strips exactly one key (`_fillDrag`), so the latch was written
into `reco/recoSessions.json` **on the shared folder** and read back on every
later start. Two ways in: Clear Loaded Data set it deliberately, to stop the
file it had just cleared coming straight back, and that suppression then never
expired; and opening a template *before* the day's extract landed latched an
attempt that found nothing. Because the file is shared, one person's Clear Data
stopped that template auto-loading for the whole team, permanently.

The contract now:

- **The latch is per-run**, in `Reco._runState(tplId)` — `{ autoLoadTried,
  autoLoadFailed, autoLoading, loadGen, savedFiles, latestFile }`. It is never
  serialised. `ensureSessionShape` deletes `_autoLoadAttempted` from any session
  that still carries one, so the old value leaves the share on the next write.
- **Clear Loaded Data records `clearedAt`**, an ISO timestamp, and that one IS
  persisted. Auto-load skips a candidate file whose newest `upload` row `_ts` is
  at or before it. So a reco cleared on purpose stays cleared, and the next
  genuinely newer upload still appears by itself.
- **Re-opening a template clears the latch** (`Reco._reopened(tplId)`, called
  from `RecoTemplate.open` and `Home.openEntryForDoc`), so an extract that lands
  an hour after the first look is found without restarting. The latch exists to
  stop a read per repaint — `Reco.render` runs on every navigation and section
  switch — not to stop the user finding today's file.
- **Only a conclusive outcome latches.** "I looked and there is nothing" and "I
  loaded it" are conclusive. "The share did not answer" is not: it sets
  `autoLoadFailed`, toasts the reason, and leaves the latch so the *next
  repaint* does not retry, while *re-opening* does. Clearing the latch inside the
  failure path is an endless read loop against a dead share — it was written that
  way once and caught by a test.
- **The read path has a strict mode.** `Versioning.listFiles/latestDataFile/loadActive`
  take `strict` and propagate the failure instead of returning `[]`. Without it a
  failed read reported **"File empty"**, because `readFile` swallowed the error —
  "unreadable" and "empty" were the same thing to the caller.
- **A file with rows but no `_pk`** is an error naming the reason, not a green
  `Loaded 0 active rows`.
- **Loads carry a generation counter.** `ingestData`, `clearSession` and an
  explicit `loadVersionedFile` bump `run.loadGen`; auto-load captures it and
  `loadVersionedFile` discards its result if it no longer matches. This was a
  **data-loss** bug: on a slow share, a user who gave up waiting and used Add
  Data had their upload replaced by the in-flight auto-load's older rows, under a
  success toast. Add Data, Paste Data and Open Existing are also disabled while a
  read is in flight.
- **Three honest empty states**, from `Reco._renderEmptyState`: *reading* (with a
  spinner and `aria-busy`), *read succeeded and the folder is empty* (the old
  copy), and *read succeeded and N saved files exist* — the last with an "Open
  the latest" button, because telling someone to upload data they already
  uploaded is actively misleading. The empty state also no longer replaces the
  whole section, so Manage (and Version History) is reachable with an empty grid.

**Not the cause, and deliberately left alone:** `loadVersionedFile`'s repaint
guard `AppState.currentPage === 'reco' && AppState.activeRecoId === id`. It was
the first suspect and it is innocent — only two callers pass a param to
`App.navigate` and both set `activeRecoId` first. The one time it declines, it is
doing its job: stopping a slow read for one template painting over the template
the user has since moved to. Section 9 of `run_autoload_e2e.mjs` guards that
behaviour so the "obvious" fix cannot be made later. `App.navigate` now also
assigns `activeRecoId` from its param, so a future caller cannot reintroduce the
hole the guard protects against.

Suite: `tests/e2e/run_autoload_e2e.mjs` (41 checks; 12 passed before the fix).
The test bridge gained `--slow-read <ms>` and `reco_data/**`-scoped fault
injection to make any of this testable.

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

**`window.pywebview` is NOT reachable inside a JV page, so the handshake is the
only channel — not belt-and-braces.** Established from the pywebview 5.4 source
rather than a manual check, for two independent reasons:

1. `inject_pywebview()` (`webview/util.py`) is called from
   `EdgeChrome.on_navigation_completed` (`webview/platforms/edgechromium.py`),
   bound to WebView2's **top-level** `NavigationCompleted`. pywebview never
   subscribes to `FrameNavigationCompleted`; there is no frame handling in the
   backend at all.
2. Even if it did, the injection runs through `ExecuteScriptAsync`, which
   executes in the current **top-level document** only.

`window.parent.pywebview` is blocked too: `main.py` creates the window with
`html=HUB_HTML` and `LauncherAPI.resolve_url()` hands out `file://` URLs, so Reco
and a JV page are two distinct **opaque** origins under Chromium's default.
Reading across throws.

Consequences worth keeping in mind: a generated JV page must carry zero inline
script for readability and review, not for sandboxing; and
`iframe sandbox="allow-scripts"` was considered and **not** added, because the
origin boundary is the real protection and `sandbox` would buy nothing while
risking TCH's modals.

**Test fidelity:** `tests/e2e/bridge_server.py` serves the iframe from the same
HTTP origin unless `--jv-port` is passed, which is a *weaker* environment than
production. Both `run_e2e.mjs` and `run_specialjv_e2e.mjs` now pass it. When that
suite was switched over, nine checks failed at once — the fixture chose its
malformed-line mode through `window.parent._fakeMode`, a same-origin read, so
cross-origin every one of those nine refusal cases had been quietly sending
*balanced* lines and being correctly accepted. Keep the JV suites on `--jv-port`.

### 6.4a Posted JVs and the accounting-reference control

The user asked to *"keep a track on jv marked as posted and highlight cases where
accounting reference not updated for posted jv"*. What exists:

- `entry.specialJvs[]` carries, per JV, `{ jvId, ref, primaryKeys, claimedNotSent, meta }`
  where `primaryKeys` is the **audited** set — only the rows that JV was actually
  sent and actually consumed. `Reco._jvConsumedPks` computes it and
  `Reco._jvUnsentClaims` records what a JV claimed but was never given.
- `entry.postedPks` is the keys of the rows an entry stamped. It exists because a
  posted standard row's only other link is its session `_id`, which is re-minted
  on the next load — without it every correctly posted row read as "no GL
  reference" and the exception list filled with false positives.
- `Reco._postedAuditIndex` / `_postedIdxReset` / `isRowPosted` / `_postedRefFor`
  resolve "is this row posted, and under which accounting reference". A badge on
  the row (`_postedBadge`) shows it.
- `Reco.openPostedJvAuditModal` lists posted JVs and their rows;
  `exportPostedJvExceptions` exports the rows that are posted with no accounting
  reference recorded; `exportPostedJvMap` exports the whole mapping.
- Entries written by older builds carry `specialJvIds` only, with no
  `specialJvs`; `_postedAuditIndex` special-cases them rather than reporting
  every one of their rows as an exception.

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

### 6.7 A Special JV as data — the spec-driven engine

A second route exists, and it needs no new JavaScript. One reviewed engine
interprets a declarative spec, so a new Special JV is a JSON record instead of
a new program on the shared folder:

```
special_jv_templates/_engine/jv-core-1.0.0.js    the compute core — no DOM, and it compiles nothing
special_jv_templates/_engine/jv-page-1.0.0.js    the handshake + the DOM, using TCH.html's own hooks
special_jv_templates/_engine/jv-page-1.0.0.css   TCH's look
special_jv_templates/EXAMPLE_TCH.html            the worked example: a page with NO script of its own
```

* The maths lives in a new `jvSpec` block inside `special_jv_mapping/<REF>.json`
  (every key that was there keeps its exact meaning). `special_jv_mapping/TCH.json`
  carries TCH's own maths in that form, as the example to copy — and
  `special_jv_templates/TCH.html` is **untouched** and still ignores it: a
  hand-written calculator keeps working exactly as §6.1–§6.6 describe.
* A generated page is a shell: a title, a stylesheet link, a mount `<div>`, an
  inert `<script type="application/json">` copy of its own mapping, and two
  `<script src>` tags. No inline script, no `on*` attribute. That is the point:
  "a colleague added a JV" stops meaning "a colleague put new executable code
  on the shared folder".
* Amounts are a closed grammar (`JVCore.Expr`: `+ - * / ( )`,
  `abs min max round round2 neg ifpos ifneg`, and names the spec itself
  declares). Nothing a user types is ever compiled, division by zero refuses
  instead of posting a silent zero, and a spec that is malformed or from a
  newer Reco draws a panel listing every reason and posts nothing.
* `apps/Reco.html` MODULE 2d carries the three files verbatim as inert text
  islands and runs the core from the first one, so the creator's preview and
  the calculator page cannot drift, and the creator can seed `_engine/` on a
  share that has never had it (`init_skeleton` copies no app files).
* Tests: `tests/e2e/run_jv_core_unit.mjs` (no browser) and
  `tests/e2e/run_jv_engine_e2e.mjs`, which drives `EXAMPLE_TCH` through the
  real Reco with `run_e2e.mjs`'s four rows and asserts it produces TCH's eight
  lines byte for byte.

### 6.8 The creator: how those files get onto the share

`apps/Reco.html` MODULE 9b holds the half that writes. **`JvGen`** turns a
definition into the two texts and nothing else: `JvGen.island(def)` escapes
`<`, `>`, `&`, U+2028 and U+2029 as JSON `\u` escapes — never HTML entities,
which are *not* decoded inside an `application/json` block and would corrupt
the `&` in `TCH JV — Cross Currency & Charges` — and `JvGen.page(def)` builds
the shell and **refuses to return it** (`JvGen.pageProblems`) if it would
carry an inline script, an `on*` attribute, a `javascript:` URL or an
unescaped island. `JvGen.mappingJson(def)` is the mapping as it goes on the
share.

**`JvCreator`** owns the folder. `Entry Generator → Special JVs` lists every
registered JV, badged from what is actually in the files, with `Duplicate…`
(copy a JV under a new short code — the whole of the creator's UI for now),
`Retire` / `Bring back`, and *What is on the share?*, which prints the three
fingerprints side by side.

`JvCreator.publish(def, opts)` is the write path, and it returns
`{ok, mode, errors, warnings, steps, written, archive, needs, inUse, engine}`
rather than throwing, so the UI and the tests read the same answer. In order:

1. the short code must be 1–24 of `[A-Za-z0-9_-]` starting with a letter, not
   a Windows device name, not starting with `_` (that reserves `_engine/`);
   `JvCreator._paths()` throws for anything else, so a bad code can never
   become a path. Every write is relative, under one of the four JV folders.
2. `JVCore.validateSpec` must return no errors. `inputColumns` is derived
   first, as the union of every column's label and accepted spellings — Reco
   projects only the names listed there, so a spelling the spec accepts but
   the mapping does not declare would arrive blank.
3. the target is classified **from the files**: `new`, `generated`,
   `handEdited`, `abandoned`, `pageOnly`, `mappingOnly`, `handWritten`,
   `detached`, `strayPage`, `strayMapping`. A page with no
   `<meta name="generator">` is never overwritten at any price, and a page
   whose embedded JSON no longer matches the mapping needs a second, explicit
   confirmation.
4. a code that differs from an existing one only by capitals is refused (the
   share is a Windows folder), and so is a code whose page or mapping already
   exists but is not ours.
5. `audit.rev` / `audit.updatedAt` on the share are compared with the ones the
   edit began from; if they moved, nothing is written and the message names
   who moved them. A JV that has already posted entries needs its short code
   typed back (`needs: 'typedRef'`).
6. an advisory lock at `special_jv_mapping/.lock_<REF>.json`: refused when it
   is under ten minutes old and belongs to someone else, otherwise written,
   given a second to settle and read back. **This narrows the race, it does
   not close it** — the bridge has no create-if-absent primitive. One method
   in `main.py` (`O_EXCL`) would close it properly.
7. the current pair is copied to `special_jv_archive/<REF>/<stamp>_<user>/`.
   That **is** the rollback mechanism: the bridge has no delete and no rename,
   so a previous version only exists if it was copied first.
8. `_engine/` is seeded from MODULE 2d's islands when a file is missing, and
   an existing one is never touched or compared — the version is in the
   filename, so a JV keeps the engine it was validated against.
9. **the page is written first, the mapping second**, because the mapping *is*
   the registration: a half-written JV stays invisible rather than appearing in
   the To Account dropdown with a blank iframe.
10. both files are read back and compared byte for byte, and the island is
    parsed and hashed against the page's own `<meta name="jv-spec-hash">`. On
    any mismatch the previous version is put back from step 7; for a code that
    never existed, the page becomes a placeholder that says it was not
    published (nothing can be deleted).
11. the lock is emptied, `SpecialJV.load()` runs, and any load problem is
    reported.

**Retire, never delete** (`JvCreator.setRetired`): `audit.retired = true`, the
ref stays registered so a pending JV can still be completed or discarded, and
`SpecialJV._buildToAccountOptions` stops offering it.

**The admin password is a guard against accidents, not security.** It is asked
for exactly one creator action — forcing an overwrite after a conflict — and
`pwd.txt` is a plain text file sitting in the base folder: anyone who can open
the shared folder can read it in Notepad. It is no longer readable *through the
app* (`main.py::_abs` refuses it), so `verify_admin_password` is the only way
to check it, but do not describe it to the team as an authorisation boundary.

Tests: `tests/e2e/run_jv_gen_e2e.mjs` creates `TCH2` by copying TCH through the
tab, the dialog and the Publish button, opens it through the real
`SpecialJV.open` and asserts TCH's eight lines; then one test per rule above,
including a traversal code, a case collision, a stray file, a conflict with
nothing written, a tampered read-back that restores, a hand-edited page the
engine warns about at run time, and retire.

### 6.9 The wizard — building a JV without writing anything

MODULE 9c (`JvWizard`) is the screen a finance user sees. It writes nothing to
the share itself: every write still goes through `JvCreator.publish` /
`JvCreator.downloadFiles`, so §6.8's rules have exactly one implementation.

**The way in.** `Entry Generator → Special JVs → + New Special JV`, and the
same button on Home's *Available Special JVs* panel — which now renders even
when nothing is registered, because otherwise a share with no JVs had no entry
point at all. `Edit…` on a card opens an existing JV; a JV whose page the
creator did not write opens **read-only** and can only be copied.

**Where to start from** — `JvWizard.openChooser()`: *Start from TCH* (its spec
is shipped in its own mapping, so copying it costs nothing and touches
nothing), *Copy one of ours*, *Start blank*, *Import a JV file…* (paste a
colleague's `<REF>.json`; it keeps none of its history and its code is typed
again). A copy goes through `JvCreator.duplicateDef`, the same function the
`Duplicate…` button uses.

**Nine steps, and the order they were built in.** The chips are clickable —
unlike `RecoTemplate`'s — because a copy arrives with every step filled in.

| step | what it decides | written to |
|---|---|---|
| 1 | short code, name, page heading, and the columns Reco must send | `ref`, `displayName`, `jvSpec.columns`, and `inputColumns` **derived** |
| 2 | the row types, and the ordered rules that sort a row into one | `jvSpec.kinds`, `jvSpec.classify` |
| 3 | one section per period / per column value / one for everything; the 10-day presets | `jvSpec.sections`, `remarks.ranges` |
| 4 | the boxes typed once per section | `jvSpec.fields` |
| 5 | the totals worked out from the rows | `jvSpec.aggregates` |
| 6 | the accounts, from the Accounts Master | `jvSpec.slots` + the `accounts` block |
| 7 | the entries — the heart | `jvSpec.entries`, `remarks.templates` |
| 8 | the checks run before anything is handed back | `jvSpec.validate`, `entryDefaults` |
| 9 | the live test-run, and Publish | — |

**Step 9 is the screen that matters, and it is where the wizard opens.** Four
panels, all driven by the same `JVCore` calls the generated page makes —
`classify`, `aggregates`, `runChecks`, `buildAll` — over real rows: how each
row sorted and why an ignored one was ignored; each section's totals with its
typed boxes **live**; the Dr/Cr lines under the real AEG column names with the
per-currency balance strip; and everything that would stop it, red for blocking
and amber for not, each with a *Take me there*. Test rows come from the rows
selected in a template, all its rows, the rows a pending JV last ran on, a
paste, or six rows synthesised from the classification rules themselves. They
are projected exactly as `Reco.openSpecialJv` projects them (`SpecialJV.pick`
over the derived `inputColumns`), so **the alias trap is visible here instead of
in production**: rename a column and the amounts go to zero while you watch.
Capped at the first 500 rows, said out loud. Recompute is debounced ~120 ms and
rewrites only the figures, never a control holding a caret — `JvWizard._touch`
versus `JvWizard._struct` is that distinction, and it is why typing in a Sale
Data box does not lose focus.

**Nothing can be published without a computed, balanced test-run**
(`JvWizard._canPublish`): a valid spec, a name, no blocking check, and every
currency balanced. Publish recomputes first, so what is on screen is what is
judged. The footer also offers *Save as a draft* (`special_jv_drafts/<REF>.json`
— data only, no page, not registered; the tab lists drafts with *Carry on with
it*) and *Download the files instead*, which is the no-bridge path.

**The amount is one stored thing.** A formula string over the names the spec
declares, parsed by `JVCore.Expr` — never `new Function`, never `eval`. Two
editors over it: the default `+ add / − take off` term rows, which serialise to
`a + b - c` and parse back out of it (`JvWizard.parseTerms` /
`serialTerms`, round-trip tested), and, for anything that is no longer a plain
signed sum, the same grammar in a text box checked on every keystroke with the
error shown inline. Two buttons do the work a formula builder alone cannot:
*one entry per currency* (a `forEachCurrency` rule — TCH's USD and EUR
adjustments in one click) and *balancing figure* (the flip-the-sign sum over
every name the other entries already read, expanded through `forEachCurrency`
first — the shape of TCH's charges entry).

**`Check against the real <REF> page →`** opens a hand-written calculator with
the same rows through the real `SpecialJV.open`, and diffs the lines it posts
against the lines this spec produces, field by field, plus the rows each would
close. That is the only honest test of "my new JV does what the old one did",
and it needs no new plumbing.

**What the creator refuses.** A short code that is not a safe file name; a code
that exists; TCH, or any page it did not write; an entry whose Dr and Cr are
the same account; a formula that is not in the grammar; a test-run that does
not balance. Everything typed anywhere in the nine screens goes through
`U.esc` / `U.escAttr` / `U.jsq`, so markup in a label injects nothing into the
creator's own screens either.

Tests: `tests/e2e/run_jv_wizard_e2e.mjs` (99 checks). The headline test rebuilds
TCH **through this UI** — clicks and typing only, no JSON — from *Start blank*,
publishes it as `TCHW`, opens `TCHW` through the real `SpecialJV.open` and
asserts every figure `run_e2e.mjs` asserts for the real TCH page; then *Start
from TCH* → `TCH3` whose spec, accounts and input columns equal TCH's; the live
recompute on a keystroke; the diff against the real TCH page coming back
*Identical*; the read-only path; the hostile-formula corpus; the injection
corpus; drafts; and the term-builder round trip.

---

## 6a. Filters and custom reports — what an operator means

**One table, used everywhere.** `FilterOps` owns both halves of a filter, so a
menu can never offer something the arithmetic will not honour:

- `FilterOps.kindOf(tpl, col)` → `'date'` (column `isDate`), `'value'`
  (`isValue`), `'status'` (the `_status` pseudo-column) or `'text'`.
  Extras and computed columns are `'text'`: they carry no type flag.
- `FilterOps.opsFor(kind, keepOp)` → the operators to offer. A date column gets
  `before / after / on or before / on or after / between / not between` and no
  `>`; a value column gets `> >= < <=` and no date operators; `_status` gets
  only equality and list operators; `'text'` keeps all 22. `keepOp` keeps an
  operator a *saved* filter already uses in the menu, flagged *not suited to
  this column*, so an old report can be read and corrected instead of silently
  losing a condition.
- `FilterOps.evaluate(value, op, val, val2, kind)` is given the **same kind**.
  On a date column a range compares days; on a value column it compares
  amounts, so `1234.5` matches a stored `1,234.50` and `-50` matches `(50)`.

Both operator menus — the report filter editor (`RecoTemplate._renderReportFilter`)
and the grid's column dropdown (`Reco.toggleColDropdown`) — are built from
`opsFor`, and both evaluation sites (`Reco.runReport`, `Reco.applyTableFiltersSort`)
pass the kind, so the grid and the reports cannot drift apart.

**Untyped columns.** When the kind is `'text'`, the ordering operators let the
filter's own bounds decide: bounds that are dates and not numbers mean a date
comparison, anything else means an amount comparison. That is what makes
`between` work on a computed column holding dates. Equality on an untyped
column stays exact text. `U.looksLikeDate` is the strict sniffer behind this —
unlike `U.parseDate` it never falls through to `new Date(text)`.

**Reports.** `Reco.runReport` computes extras, then the report's computed
columns (which may reference extras and earlier computed columns), then filters,
then sorts. A filter row with no column chosen is skipped — counted as a match
it made every row pass under OR logic. The sort resolves its column with
`Reco.isDateColumn`, which reads a template column's `isDate` flag and
otherwise samples the values, so a computed date column no longer sorts as text.

`Reco.renderCustomReport` computes each summary card in one pass (never
`Math.min(...nums)` — spreading 200k values threw *Maximum call stack size
exceeded* and took the whole report down). `Sum` of an empty result is `0.00`;
`Avg`/`Min`/`Max` with no numbers are `—`. The total row tests cells with
`U.isNumeric`, the same test the `Sum` card uses, so the two agree on
accounting negatives.

`Reco.REPORT_ROW_CAP` (5,000) limits **only the on-screen table**. The cards,
the total row and the CSV export always cover every row, and the toolbar says
so: *showing the first 5,000 of 200,006 rows — Export CSV gives all 200,006*.
Table and CSV share `Reco._reportCellText`, so an export can never show a
different date than the screen.

---

## 6b. The grid on a large extract — what keeps it responsive

A finance user loads tens of thousands of rows, often a few hundred thousand.
Four rules hold the grid together at that size. Break one and the window
starts freezing again.

**1. Work is proportional to what is on screen, not to `sess.data.length`.**
The table is virtualised to ~110 rows (`Reco._VIRT_WINDOW`) whatever the page
size, including `Reco.PAGE_ALL` ("All rows (no paging)" in the page-size list).
The slicer follows the same rule: `Reco._slicerDistinct` scans every row to
count the distinct values honestly, but `Reco._slicerRender` only ever draws
`Reco.SLICER_CAP` (500) of them and the count line says what it is showing —
*200,000 distinct values · showing the first 500 — type to narrow the list*.
Search filters the in-memory list and redraws that small window; it does not
touch the undrawn values. **The selection lives in `Reco._slicerState.sel`,
never in the DOM**, because a value a user already picked may be outside the
cap, and reading the selection back off the DOM would silently drop it
(`_slicerMatches` also pulls picked values to the front). `_slicerDistinct`
coerces a value with `String(val||'')` — *exactly* what `applyTableFiltersSort`
uses to match a slicer value. Change one side only and the list will offer a
value (e.g. a formula column's `0`) that matches no row.

**2. A click that changes one thing does not re-render everything.**
`Reco.refreshGrid()` redraws only `#recoTableArea` and `#recoSlicerBar`, and
falls back to `App.navigate('reco')` whenever the grid is not what is on
screen — so no caller has to know. Paging, page size, sorting, column filters,
slicers, the status filter, a column reorder and sheet-mode page crossing all
go through it. Selection goes further and touches no markup at all:
`toggleRowSelect` / `toggleAllRows` / `clearSelection` / `endDragSelect` update
the rendered rows with `_updateVisualRow` (`_syncVisibleSelection` for a bulk
change), refresh the header tick with `_syncSelectAllBox` (empty / half /
full) and recompute the bar. `updateSelSumBar` walks **the selection**, not the
extract. Things that change the topbar — filter sets, hide/unhide a column,
zoom, reset view, anything that changes offsets — must still use
`App.navigate`, because `refreshGrid` leaves the topbar alone.

**3. Keys are computed once, not per comparison.** `Reco._sortKeyed` makes one
pass over the rows for blank / date / number / text keys and then sorts on
those, reusing one `Intl.Collator`. It reproduces `_compareValues` exactly —
blanks last, then dates, then numbers, then natural text — and
`run_grid_scale_e2e.mjs` §5 asserts that against a copy of the original
comparator for six value shapes in both directions. **Any change here must keep
that test green: the order rows appear in is something users read.**
`Reco._buildRowIdxMap` caches the `_id → index` map against the row array's
identity and length (`_invalidateIdx` for an in-place push), and `_rowById` /
`_rowsByIds` use it — the bulk-offset and tolerance paths used to scan the
whole extract once per selected id. `Reco._virtState` holds what the last
render computed so the scroll handler can move the window without re-running
the pipeline, and `_filteredCount` / `_pageCount` reuse it. Caches live on
`Reco`, **not on the session**: sessions are JSON-serialised to the shared
folder, where a `Map` would be written as `{}`.

**4. What cannot be made fast says so.** `Reco._withBusy(cost, text, work)`
paints a progress panel, yields a frame so it appears, then does the work;
below `Reco.BUSY_ROWS` (100,000 row-equivalents) it stays silent, so a small
session never flashes a modal. `cost` is in row-equivalents, so a caller whose
work is cheaper per row scales it down (select-all passes half). The slicer's
scan yields every `SLICER_SLICE_MS` (60ms) of held thread and only raises the
bar once the scan has already run for 250ms — a plain column opens instantly,
a formula column reports progress. Shape copied from `ExcelLink._progress`.

**Navigation.** The pager states the page, the row range and the true totals
with thousands separators (`U.fmtInt`), drops the "filtered" figure when
nothing is filtered out, and offers a page box and a row box (Enter to jump;
`gotoRowInput` turns to the page, scrolls the virtual window and flashes the
row — `_flashFrow` survives a counted number of body rebuilds rather than a
wall-clock timeout, because a frame can be seconds late while a large session
is being written out). `PageDown` / `PageUp` / `Ctrl+Home` / `Ctrl+End` page
the grid; `Reco._onGridKey` decides it is a paging key **before** counting
anything, bows out inside an input, a modal or sheet mode, and the header is
`position: sticky`.

**Measured, 200k rows × 6 columns + 2 extras, Chromium** (before → after):
slicer on a 200k-distinct column 5,819 → 83 ms and 200,000 → 500 DOM nodes
(19.2 MB → 72 KB of markup); slicer search 1,901 → 11 ms; sort by date
1,747 → 192 ms; sort by text 1,623 → 71 ms; tick one row 221 → 34 ms; clear a
200k selection 120 → 33 ms; page turn 150 → 45 ms; longest blocking task
5,800 → 244 ms. At 500k rows the slicer was a 15.5-second freeze building
48 MB of markup; it is now 237 ms.

**Not fixed (known).** `Store.serialize('recoSessions')` is one
`JSON.stringify` of the whole session on the main thread: 141 ms / 16 MB at
200k rows, 238 ms / 42 MB at 500k, and the full `AppState.flush` round trip
(serialise + write through the bridge) is 668 ms at 200k and 2.7 s at 500k.
It is debounced 250 ms, so a burst of clicks pays it once, but a save of a
very large session still hitches the window. That is the persistence layer,
shared with the Excel link, and was left alone.

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

### Custom reports — defects found and fixed in this build

Found by a matrix probe over every report feature crossed with every column
kind (text, `isDate`, `isValue`, computed extra, master lookup, free tag,
`_status`) and all 22 operators; locked in by `tests/e2e/run_reports_e2e.mjs`.

- **A date range was wrong, not merely unsupported.** `between` ran through
  `parseFloat`, so `'05/01/2026'` compared as the number **5** — the
  day-of-month. *Date between 01/01/2026 and 31/03/2026* returned every row,
  including December 2025 and June 2026. `>`, `>=`, `<`, `<=` had the same
  fault, and there was no date-range operator at all. Every operator menu
  offered all 22 operators for every column.
- **`Min`/`Max` summary cards broke a large report outright** —
  `Math.min(...nums)` threw *Maximum call stack size exceeded* above roughly
  125,000 values, taking the whole report render down with it.
- **The total row silently dropped accounting negatives.** Its `parseFloat`
  guard rejected `(50)`, so the total read 1,834.50 where the `Sum` card on the
  same column read 1,784.50.
- **The report sort looked the column up only in `tpl.columns`**, so a computed
  or extra date column sorted as text — `04-Feb-26` before `31-Dec-25`. The
  grid's column sort had the same fault.
- **The CSV export ignored the report's date-format overrides**, so the file
  disagreed with the screen.
- **An unfinished filter row (no column chosen) counted as a match**, which
  made an OR report return every row and silently voided its other conditions.
- **`Sum` over an empty result read `—`** rather than `0.00`.
- **A formula that could not work printed `NaN`** (or `Infinity`), which reads
  like a value yet is skipped by totals and cards and sorts as text. It now
  reads `#ERR`, and the editor says to wrap a formatted amount in `NUM()`.
- **The 5,000-row table cap was effectively invisible** — one line below 5,000
  rows of table. It is now stated in the toolbar, above the table.
- A summary card could only name a column the report displayed; cards may now
  name any column the report can reach, and one naming a deleted column says so.

### Known limitations (not changed)

- Multi-user: two people saving the same `reco/<key>.json` — last writer wins (change detection only reduces the overlap). Version CSV appends are safe.
- Formula tokens are numbers only for plain numerics; use `NUM({Amount})` for `1,234.50` / `(10)`.
- jspreadsheet/jsuites are not in this repository; keep the copies already in `apps/lib/`.

---

## 8. Adding a new Special JV — checklist

This is the hand-written route, and it stays supported. **Before taking it,
read §6.7, §6.8 and §6.9**: if the JV's maths is "classify the rows, total them
per section, post a few Dr/Cr pairs", it can be a `jvSpec` block plus a
generated shell, with no new JavaScript on the shared folder at all — and
`Entry Generator → Special JVs → + New Special JV` will build it and write both
files, with a live test-run against real rows before anything is saved. Take
this checklist only when the JV needs something §10 of the creator's
specification lists as out of scope: one Dr/Cr pair per *row*, an account
chosen from the data, a conditional entry, three legs, two currencies on one
pair, or a genuinely bespoke layout.

1. Write `special_jv_templates/<REF>.html`. Read `window.parent._specialJvInputs / _specialJvDef / _specialJvRef` inside `try`; if that throws, post `{type:'specialJV.ready', ref:'<REF>'}` and wait for `{type:'specialJV.init', inputs, def, ref}` (copy the pattern from TCH.html §0 and §10).
2. On submit post `{type:'specialJV.complete', ref, jvId, lines, primaryKeys, inputData, meta?}`; on cancel post `{type:'specialJV.cancel', ref}`.
3. Write `special_jv_mapping/<REF>.json` with `ref` exactly matching the HTML stem, a `displayName`, and every input column the calculator needs.
4. Reopen Reco (the registry loads at boot). The ref appears in the To Account dropdown and on Home.
5. Emit lines with the AEG output column names and amounts as 2-dp strings, one side per line, balanced per currency. `SpecialJV.checkLines` now refuses a set that does not balance (per currency, to the cent), a line with both sides or neither, a negative or non-numeric amount, and a blank currency beside lines that have one — at arrival, in the preview and at commit. A JV may also only report primary keys Reco actually handed it.

---

## 9. Quick orientation for a fresh session

- **"Where does X get saved?"** → `AppState.flush` → `Store.save` (Module 3).
- **"Why is the JV empty?"** → `inputColumns` in the mapping JSON (`Reco.openSpecialJv`); Reco toasts input columns with no values.
- **"Why can't I click Generate?"** → `canGenerate` in `_renderPreviewModal`: every bucket needs a completed JV for exactly those rows (`SpecialJV.matchesRows`).
- **"Where is the row data on disk?"** → `reco_data/<tpl.dataFolder>/<MMM-YY>/<DD>.csv`; active view = `Versioning.loadActive`.
- **"How do I test without the launcher?"** → open `Reco.html` directly (localStorage mode), or run the e2e suite which drives the real bridge.
- **"The grid feels heavy on a big file"** → §6b. Check first whether the
  action went through `Reco.refreshGrid()` or a full `App.navigate('reco')`,
  and whether anything is iterating `sess.data` per click.
- **"How do I add a Special JV?"** → `Entry Generator → Special JVs → + New Special JV` (§6.9). The hand-written route is §8 and is for the shapes a spec cannot say.
- **Tests:** `python -m pytest tests/` (launcher + migration engine) and `node tests/e2e/run_e2e.mjs` (Reco, TCH and the hub in Chromium against the real `LauncherAPI`, including an "older launcher" mode). `run_reports_e2e.mjs` covers filters and custom reports (§6a); `run_grid_scale_e2e.mjs` covers the grid on a 200k-row extract (§6b); `run_specialjv_e2e.mjs` covers the host side of a Special JV; `run_jv_core_unit.mjs` (no browser), `run_jv_engine_e2e.mjs`, `run_jv_gen_e2e.mjs` and `run_jv_wizard_e2e.mjs` cover §6.7, §6.8 and §6.9. Run one at a time — each binds fixed ports.

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

### 11.8 Review findings worth knowing about

The feature was reviewed across eight dimensions with every finding independently verified; 26 defects were fixed, 6 were refuted. Four shaped the design and are worth remembering:

- **A link manifest is not trusted as a path.** `close()` and `sweep()` delete what a manifest's `file.rel` names. The path jail keeps that inside ROOT, but all of Reco's data is inside ROOT too, and `_links/` sits on the shared folder where anything can write a file. `_workbook_path` therefore accepts only `.xlsx`/`.xlsm` under `reco_excel/`, and the sweep ignores JSON that is not a Reco manifest. Never widen that.
- **A cell swallowed by a merge reads as empty**, which is indistinguishable from a deliberate clear. The merge check must run *before* the value is looked at.
- **An explicit decision is written even when the value already matches** (`edits[].force`). The version row is the record of the decision and carries the pulled history values with it; dropping it as a no-op silently reverted the user on the next reopen.
- **The version CSV's control columns are fixed** (`_pk,_ver,_ts,_src,_by`). A header that grows later turns an append into a whole-file rewrite, and that rewrite can lose a colleague's concurrent append.

### 11.9 Known limitations

- Tag and To-Account extra columns are session-only, as before (lost when data is reopened). `recoSessions.json` remains last-writer-wins across users.
- Duplicate primary keys collapse to one row per key in history; a change to one duplicate is applied to all rows with that key.
- New rows typed in Excel are not imported (v1).
- openpyxl cannot write "ignore error" flags: text cells holding digits show Excel's green triangle (harmless, explained on *How to use*).
- Real Excel behaviour (repair prompts, owner-file naming on the share, Protected View, export time on a slow share) cannot be tested in CI — see the manual checklist in §11.10.

### 11.10 Manual checks on a Windows PC with Excel

1. Guarded mode: sorting works; typing in a grey column is refused (paste is not — expected). Locked mode: filtering works, sorting is refused.
2. After a save in Excel: no repair prompt; hidden sheets, dropdowns and comments survive.
3. Save repeatedly while Reco is open: the banner moves to *Saved* and Excel never reports a sharing violation.
4. **Open again** brings the open workbook to the front; Excel not installed → *Save a copy…* works.
5. Export 20k × 20 on the share and compare with the dialog's time estimate.

---

## 12. Reversing a generated entry — Cancel and Reverse

An entry generated in error had no undo. It has two now, and the app does not guess which is
wanted, because **nothing in this codebase records whether an entry reached the general
ledger**: `entry.docNumbers` is a form a human types into 300 ms after generation, and the
post-entry stamp is written unconditionally. So the dialog asks, with the inference stated in
words.

| | **Cancel** | **Reverse** |
|---|---|---|
| Meaning | it never reached the GL | it is posted and is now a fact |
| The original | kept, tombstoned with `reversal.mode='cancelled'` | kept, untouched except for `reversal.mode='reversed'` |
| New entry | none | one, Dr and Cr cells swapped, `reverses: '<original id>'` |
| The stamp | undone (one more `Cn` append) | undone (one more `Cn` append) |
| `docNumberMaster` | every key still valued with this id is freed | nothing freed |
| Consumed Special JV | back as pending, with its workings | never restored |

### 12.1 How the dialog decides

An accounting reference recorded against the entry sets the **default** (`Reverse`); blank
defaults to `Cancel`. The dialog says which inference it is acting on — *"No accounting
reference is recorded against AE1Q2W3E, so this will be CANCELLED and its 412 row(s) released.
If it is already in the general ledger, post a reversal entry instead."* — and the other route
is one click away on the same dialog. A reason of at least 3 characters is required; the button
carries the verb of the chosen mode. The app never cancels a posted entry on the strength of a
blank field, and never posts a reversal the user did not choose.

**That inference is part of the conflict signature.** `_reversePlanSig` carries
`docs: plan.docs.slice().sort()` and `dm: plan.defaultMode`, computed from the ENTRY
(`_reverseDocsOf`), not from the local `docNumberMaster`. Without them the pre-write share
re-read checked everything *except* the one fact the decision was made of: A could open the
dialog on an unallocated entry, B could allocate a GL voucher to it, and A's Cancel would go
through on a fact that stopped being true while the dialog was open — a record reading
`mode: 'cancelled'` with the voucher in its own `evidence`. The re-read now refuses with *"The
shared record disagrees with this one"*, the same check is repeated **after** the un-stamp
against the entry's `docNumbers` on the share, and overriding the pre-selected mode asks
outright in both directions (cancelling an entry that has a reference names the voucher;
reversing one that has none says so).

### 12.2 Order of operations (`Reco.reverseEntry`)

1. re-run `Reco._reversePlan`; refuse if its signature no longer matches what the dialog showed
2. (Reverse) the swapped lines and their balance check — see 12.4
3. `AppState.flush()`, then re-read `reco/entryHistory.json`, merge, and refuse if the share
   already carries a `reversal` (naming who and when)
4. **the un-stamp**, through `Reco.applyEdits({ scope:'allStandard', historyFirst:true, trusted:true, pulled })`
4b. **re-read and re-merge `reco/entryHistory.json` again**, re-check `base.reversal` and the
   mode evidence, and re-apply onto that fresher base
5. mark the original, and (Reverse) append the mirror
6. (Cancel) free the document numbers · 7 (Cancel) restore the pending Special JVs
8. one `Comments.create` linked to the affected keys (capped at 500) · 9 `_postedIdxReset()`
10. clear `AppState._snap.entryHistory`, flush, re-read the share to confirm the mark, and
   append the reversal log

**Step 4 before step 5 is load-bearing.** The stamp is what makes a row look dealt-with to
everyone else; the mark is only a record. Marked-but-still-stamped is the worst state
available, so the mark is refused unless the `Cn` rows come back off the share. The other way
round — rows released, entry not yet marked — the user sees at once and simply presses Reverse
again: the un-stamp is idempotent, because the second pass finds the column already clear.

**Step 4b exists because `entryHistory.json` is whole-file last-writer-wins** and the un-stamp
between step 3 and step 10 is the longest write window in the app — 900 ms per read on a share,
14 s for 200,000 keys, over 100 s end to end. Step 3's read is what refuses a *conflict*; step
4b's is what keeps the write from being a *clobber*: a colleague who generated an entry inside
that window had it dropped by this write while their row kept its `Posted` stamp, leaving a
closed row with no accounting record behind it. Re-checking `base.reversal` there also means
two people reversing the same entry cannot both mint a mirror. The durable fix is S13
`Store.mergeWrite`.

**The commit runs under `Reco._busy`** (`BUSY_ROWS: 100000`), naming each stage, and
`_reversePlan` in `openReverseEntryModal` runs under `_withBusy`. A 200,000-row reversal used
to run for 104–122 s with no modal at all. Every refusal from step 3 onwards goes through a
local `refuse()` that takes the overlay down *before* opening its own modal, because
`_busyDone` looks for the bar inside the modal body.

### 12.3 Three things that make the un-stamp real

- **`scope: 'allStandard'`.** `XlSchema.build` gives a template column `writeTo: 'row'` only
  inside `if (can)`, where `can = role === 'toAccount' || scope === 'allStandard' || editableSet.has(name)`.
  `trusted` clears the editable and role guards but never touches `writeTo`. So with the
  default scope, a post-entry column that is not in `editableColumns` — the normal production
  shape — put the edit in `sessionOnly`, wrote **no** `Cn` row, and threw nothing: the grid
  showed the rows released and the share never heard about it.
- **`opts.pulled`.** `appendChangesBatch` writes the whole row for a key, built from this
  session's row. A colleague's edit to any other column, made after this session loaded, would
  be reverted — up to 5,000 keys, under a success toast. The reversal reads
  `Versioning.changesSince(tpl, plan.rebaseFrom, pkSet, true)` first and passes every differing
  cell as `pulled`, so the `Cn` row is the **share's** current row with one cell cleared.
  Three things had to be true for that to hold:
  - **the read is `strict`.** Without it `Versioning.readFile` returns `[]` on a failed read and
    `listFiles` skips an unlistable folder, so "the share could not be read" arrived as "nothing
    has changed since" and the un-stamp wrote its stale snapshot over the share — on the path
    the app then reported as *"the reversal was not recorded"*, so nothing recorded the loss. A
    failed rebase read is now a refusal **before any write**:
    `{ok:false, problem:'… cannot be rebased onto it; nothing was written'}`, the same treatment
    the post-write verification failure gets.
  - **`loadedAt` means "when the rows I hold came off the share".** `ingestData` no longer moves
    it: appended rows are new, have no share history to rebase onto, and go out as `upload` rows
    anyway, while the rows already held still date from the earlier load. Moving it forward made
    a colleague's *earlier* edit stop being seen as theirs — and reverted it.
  - **a session with no watermark still rebases.** `ensureSessionShape` sets
    `loadedAt = loadedAt || ''`, so every session restored from a build before the watermark
    existed would have skipped the rebase — on the day this ships, nobody on the share could
    rebase at all. `plan.rebaseFrom` is therefore DERIVED from the active version file's own day
    (`Versioning.dayStartOf(path, 2)`) when `loadedAt` is empty, recorded as
    `reversal.rebaseDerived`. Erring early can only read more files and hand back the share's
    current record, which is what the un-stamp wants to write onto; erring late is the lost
    edit. Where nothing can be derived either (no `activeVersionFile`) the un-stamp is
    **blocked** and the dialog's reload is the only route — writing an un-stamp that was not
    rebased is the overwrite the rebase exists to prevent. The alternative — blocking in every
    no-watermark case — was rejected because it makes a reload of up to 200,000 rows the price
    of any reversal, and the derived watermark is strictly safer than `loadedAt` ever was.
- **Reading the write back.** `Versioning._withLock` and the launcher's `_path_locks` are both
  in-process, and two people run two processes over one folder. After the write the keys are
  re-read from the share and the post-entry column confirmed; a key that the plan said would be
  versioned and that comes back without a version label **refuses the mark**.
- **Two kinds of "it does not read the stamp any more".** `_reversePlan` resolves
  `postedPrev[pk]` *before* the drift check. A key whose current value is what this entry
  recorded as the value before it stamped goes to `plan.alreadyUnstamped`, not to
  `plan.skipped`: that is the state the app's **own** earlier attempt leaves behind on the retry
  the dialog recommends (the `Cn` rows landed, the verification read failed, the mark did not),
  and `_reverseUnstamp` confirms it against the share's own `Cn` row (`_src === 'reverse:<id>'`)
  before wording it *"released by an earlier attempt of this reversal"*. Calling it *"somebody
  changed it after this entry"* put a false accusation in a permanent audit record, reported
  *"0 row(s) released"* for a reversal that released every row, and left every row's Timeline
  without the reversal, because step 8's key list came from `un.unstamped` alone.

### 12.4 What is refused, and what can be forced

`SpecialJV.checkLines` problems split into SHAPE problems and BALANCE problems (one per
unbalanced currency bucket). A swap turns each bucket's Dr total into its Cr total, so it can
neither cause nor cure a shape problem:

- **malformed source lines** (shape problems on the original) → a **forced confirmation**
  quoting the problems, the same treatment `unbalanced` gets, recorded as `linesMalformed` on
  both records. Every shape rule in `checkLines` is swap-invariant, so the mirror reproduces the
  original's defect exactly — which is what undoing a posted entry means — and the refusal had
  no arithmetic behind it. It also told the user to *"correct the entry at source"* when a
  GENERATED entry has no source to correct, and left `Cancel` ("it never reached the general
  ledger") as the only working action on an entry that may well be in the ledger. The AEG
  `autoExchange` branch really does emit a line with neither side, and a Special JV that leaves
  the currency column blank reaches this the same way, with no template change at all.
- **the swap itself fails** → refused outright; that is a defect in the app.
- **only a currency bucket is out, on both** → the genuine "the original never balanced" case.
  Also a confirmation; accepting records `linesUnbalanced` on both records.

Also refused, with no force: a template that maps one column to both sides, and an entry whose
lines do not carry the Dr/Cr columns the reversal would swap (a legacy entry whose AEG template
has since been renamed or re-mapped). `entry.lineCols` / `aegTemplateId`, captured at
generation, are what let a post-change entry reverse into its own columns years later.

### 12.5 Readers that had to change

- `_postedAuditIndex` keeps a reversed or cancelled entry's keys in a **separate** map. A
  cancelled entry stamped nothing that is still true and a reversed entry's rows were released,
  so it no longer shadows a later entry over the same key (`postedPks` was guarded by
  `if (!byPk.has(k))`, so the oldest entry won and kept winning); and a row that is still
  stamped after a reversal — the half-done state — comes back from `_postedRefFor` marked
  `reversed`, is counted as an **exception** by `postedJvAudit` with a reason naming the entry
  and the date, and is painted with the `posted-noref` warning badge rather than clean green.
- `openAllocateModal` and `saveAllocation` refuse a reversed or cancelled entry, and **both**
  `Allocate Doc#` buttons are dropped for one.
- `JvCreator.inUse` skips a cancelled entry: the cancel handed the JV back as pending, where it
  is already counted.
- `_postedAuditIndex` carries `reversal` onto each `byJv` row. The push sits above the
  `if (rev) return;` guard deliberately — a *reversed* entry's JV did post — but without the
  mark, "Special JVs posted" read 1 for a cancelled entry while `JvCreator.inUse` correctly read
  0, and a cancel-and-regenerate made it 2 for one JV that posted once. `postedJvAudit` now
  reports `jvLive` / `jvCancelled` / `jvReversed`, the card counts a cancelled one out and
  renders its row struck through with who cancelled it and when, and `exportPostedJvMap` carries
  an `EntryReversal` column so a spreadsheet of the map cannot count a dead entry as live.
- `exportEntryCsv` names the file `<id>-CANCELLED.csv` / `<id>-REVERSED.csv` and prepends a
  marker row (a mirror gets a `REVERSING ENTRY for <id>` row). The Export CSV button is
  deliberately kept on a reversed entry's toolbar, and these CSVs are how an entry reaches the
  GL system, so the file itself has to say it. `viewSourceRows` says the rows were released and
  may have been re-reconciled since.
- `_postedIdxReset()` bumps `_postedIdxGen`, and the memo key uses that counter instead of
  counting the reversals in the history. The count was an O(history) scan recomputed on every
  `_postedRefFor` call: `postedJvAudit` went 175 ms at one entry to 1,280 ms at 2,000.
- `_buildReversalLines` deep-copies each line. One level was not enough: a cell that is an
  OBJECT (what `AEG.buildLine` writes when a master lookup misses) was the same instance in the
  original and the mirror, both living in `AppState.entryHistory`.
- `App._carryReversalsList` re-applies a reversal onto a restored record, so a backup taken
  before one cannot un-reverse an entry; the confirm names any id whose reversing entry the
  backup does not hold.
- **The trail has two second homes, and the reason is that neither alone is both append-only
  and the shape the app reads.** `reco/reversals.log.csv` is written through the launcher's
  `append_csv_rows`, which creates-or-appends and never reads the file, and it carries the
  mirror's own `linesJson` / `lineCols` / `docNumbers` — so the contra is recoverable by hand
  when the whole-file `entryHistory` write loses it, which is what "a second home" has to mean.
  `reco/reversals.log.json` (the JSON-per-line trail) stays for continuity, but there is no text
  append in the bridge, so it is read-modify-write: one failed read used to be swallowed into
  `txt = ''` and the whole file rewritten from a single line, **erasing every reversal already
  logged**. It is never written now when the read failed — the file is left exactly as it is and
  `reversal.logProblem` says so.

### 12.6 Known limitations

- A stamp on an **added** (non-template) post-entry column was never written to the share, so
  undoing it is session-only — the dialog says so. An added column with no `postedPrev`
  recorded (every entry already on the share) is **left alone** rather than cleared, because
  clearing it would wipe whatever the user typed.
- A `formula` / `master` post-entry column can only have the shadow value deleted; it then
  computes again. `isRowPosted` and `ExcelLink._isPosted` still disagree about such a column
  (pre-existing).
- A key present on two session rows collapses to one entry in `postedPrev`: read it as
  per-KEY, never per-row.
- **A colleague who already has this data loaded puts the stamp back.** The release is durable
  in the append-only version file, but `recoSessions.json` is another whole-file shared JSON
  written from memory, so a colleague whose session pre-dates the reversal restores the stamp
  the next time they save or edit one of those rows. That is the store's semantics (S13), not
  this feature's, but the user meets it here, so the dialog's "what will happen" list and the
  success toast both say it: **they must press Load before they touch these rows.** The
  `⚠ <id> cancelled` badge and the posted-row audit surface it after the fact.
- Out of scope in this version: the exportable reversal report CSV, a "posted to the general
  ledger" tick at allocation time (which would let the dialog know instead of asking), and a
  "Finish re-opening" action for the keys that were not in the loaded data (they are recorded in
  `reversal.notInSession`; reversing again once the right file is loaded is the manual route).

---

## 13. Two review panes side by side

> *"option to parallelly open 2 segments and review and have each to have separate linked Excel"*

**⫿ Split** puts a second pane beside the first. Two slices of one reconciliation, or a
different template in each. Independent view, shared data, **one live Excel link per pane**.

### 13.1 The one indirection that made it affordable

`AppState.recoSessions[tplId]` is read in 123 places. None of them changed. Instead:

| | before | after |
|---|---|---|
| the real sessions | `AppState.recoSessions` | **`AppState.recoSessionsOwned`** |
| what the 123 readers see | the session | **a view table**: `tplId → the view of the pane that owns that template now` |
| what is serialised to `reco/recoSessions.json` | `AppState.recoSessions` | `AppState._persistValue('recoSessions')` → the **owned** map |

A *view* is a proxy built by `Panes._makeView`. Every key is classified exactly once:

- **DATA (13)** — `data`, `loadedAt`, `clearedAt`, `activeVersionFile`, `corrections`,
  `offsets`, `manualTags`, `cellFormulas`, `cellFormats`, `extraColumns`, `selectedRows`,
  `_docMatches`, `columnOrder`. Read and written straight through to the owner, so both panes
  see one reconciliation.
- **VIEW (24)** — `activeSection`, `columnFilters`, `columnSorts`, `slicers`, `statusFilter`,
  `requireAttachment`, `requireComment`, `requireGroup`, `page`, `pageSize`, `columnWidths`,
  `hiddenCols`, `zoom`, `activeCell`, `selRange`, `selSig`, `spreadsheetMode`,
  `formatToolbarOpen`, `excelViewActive`, `correctionExtraCols`, `_dismissDocMatches`,
  `_virtRowHeight`, `_initialScrollTop`, `_fillDrag`. Private to the pane.
- an **unclassified** key makes the view **refuse rather than guess** (`Panes.auditKeys()` is
  asserted complete by the suite, so a new session key fails a test instead of leaking).

Two classifications are against instinct and deliberate. `manualTags` is DATA: it is the typed
value of an additional column for a row, i.e. content, not a preference. `columnOrder` is DATA:
it is the legacy *team* order read by `_legacyTeamOrder`, so per-pane it would default to null
in the second pane. **Consequence to state out loud: the column order is shared by both panes**
(it is stored per reconciliation per PC via `Reco.userPref`, which is why the two panes converge
on it rather than moving together — for one repaint they can show one template in two orders,
each internally consistent; the suite pins that consistency).

Slot 0's `view` is deliberately `null`, meaning *my view IS the owner session object*. That is
what makes the no-split case byte-identical: `recoSessions[tplId] === recoSessionsOwned[tplId]`,
and every expression in the grid renderer is character-for-character what it was.

**Seven whole-session assignment sites** were converted (`Panes.ensureSession` /
`replaceSession` / `dropSession`): boot load, backup export, backup import, the two lazy creates
in `Reco.render` and `Reco.ingestData`, `restoreSession`, `clearSession` — and
`RecoTemplate.remove`, which is a *delete* and is why a `recoSessions[x] =` grep could never
find it. `AppState.flush` asserts the two maps agree on key set, which is what catches an eighth
site being added later.

### 13.2 Ids, and the rule that holds instead of the one that did not

Two panes render the same markup twice, so `document.getElementById` is ambiguous.
`Panes._ownIds` parks every id on `PANE_IDS` into the owning pane and strips it from the other,
and `Panes.el(paneKey, id)` reads one pane's. `Panes.dupIdAudit()` counts **every** id in the
document rather than only the listed ones — which is how `xlEditInExcelBtn` and
`sessionRestoreFile` were caught.

The build's original safety argument was *"by the time an emitted handler runs, its own pane owns
both the ids and `AppState.activeRecoId`"*. That is true of the pane being **entered** and false
of the pane being **left**. The rule that actually holds, and the one to work to:

> A handler is pane-correct **iff the user gesture that fires it is also the gesture that last
> set the owner.**

98 functions open by resolving the pane from a global. 94 are correct by construction. Exactly
two classes break the rule:

1. **Commit-on-blur.** The gesture that moves the owner is the capture-phase `pointerdown` in
   the *other* pane, which runs *before* the browser's blur — so the `change` handler re-reads
   the pane the user clicked **into**. One chokepoint: `Panes.focus` flushes a pending
   commit-on-blur before `Panes.install`, and `Panes.focusDom` moves the keyboard with the
   ownership (F6 otherwise left the edit pending and already aimed at the wrong template, with
   the window open until whatever blurred the cell minutes later).
2. **A handler inside the one shared `#appModal`.** The modal is outside both pane roots, so
   clicking it re-focuses nothing. There is **no chokepoint** here and N = 4, not 98: Find &
   Replace and the slicer stamp the pane and template they were opened on, every write
   re-resolves through the stamp and refuses with a sentence when that pane has moved on, and
   `_replaceOne` re-finds its row by `_id`. The pane-switch hotkeys also grew the modal guard
   the file already uses twice.

### 13.3 What is refused, and why that is the feature working

The row selection is **shared** — that is the point of the split. So each consumer that writes
to the journal or the shared folder takes the key of the pane it was clicked in and refuses a
selection that reaches outside what that pane shows, naming the count and the remedy:

> *2 of your 5 selected rows are not in this pane. Preview Entry only acts on the rows this pane
> shows, so nothing was posted. Clear this pane's filters to include them, or act in the pane
> that shows them.*

Pane-scoped and refusing: **Preview Entry**, **Mark Offset**, **Unmark**, the **three group
actions** (group membership is a pk-keyed write that gates offsetting), and the Excel export's
**Selected** row scope (its sibling *Shown in Reco now* always was). **`offsetSelected` is the
sanctioned exception** and takes both panes' rows under one reco id, because offsetting two
sides against each other is the whole reason to split.

Four cross-pane DOM exceptions are sanctioned, each named in one comment with its reason so
nobody tidies them back, and each keeping today's document-level lookup verbatim when there is
no split: `updateSelSumBar`, `_syncVisibleSelection`, `_rowEl`/`_rowEls`, and `_repaintRow`
(which otherwise drew an edit in the owner pane only — an edit invisible in the pane beside it
is a wrong number on a screen two people are comparing).

Also refused, each with a sentence rather than a silent `return false`: a **third pane**,
**Excel View** and **Sheet mode** while split, and **two periods at once** (every edit appends
to today's file, so two copies of one row collide in the edit batcher).

### 13.4 One live Excel link per pane

`ExcelLink._active` is keyed by **pane** (each entry carries its `tplId`); `_activeForTpl(tplId)`
is the accessor for *the live link on this template*. `_watch` became `_watches`, one interval
per pane; `_lookedUp` is per pane **and** template; and `_tick`'s `activeRecoId !== w.tplId`
guard became *this pane still exists and still shows this template*. A pane that moves to
another template **releases** its link rather than carrying it, and the link stays **open** on
the share so it is adoptable from 📗 Links. The same row edited in both workbooks surfaces as a
reviewed **conflict** in whichever is loaded back second, in either order, never pre-ticked.

No Python change was needed for any of this.

### 13.5 Three behaviour changes outside the split

These apply whether or not a split is open, and the team should know:

- **The Correction tab refuses an empty corrected value** — *"There is nothing in the
  corrected-value box — nothing was changed."* Before, `FMT.validate` passed `''`, so a blank
  Apply cleared a real reference, marked the row corrected so it left the tab looking done, and
  wrote `{newVal: ''}` to the shared `correctionMaster`, where it re-blanked that key on every
  future load for every colleague — with no `Cn` row anywhere to show it. If a field genuinely
  needs blanking from that screen, that wants its own control, not an empty box reporting success.
- **F6 and Ctrl+Alt+Arrow do nothing while a dialog is open**, and say so. Switching panes under
  a dialog that belongs to one of them cannot be made to mean anything.
- **Closing a pane no longer forgets its workbook.** `ExcelLink.confirmLeave` is the only gate on
  *Return to hub*; a released pane's link is now still known to it, so a colleague cannot walk
  away from a workbook whose edits are still sitting on the share.

### 13.6 Costs, measured

| | measured |
|---|---|
| a second pane's render, 200k rows **with a sort** | one pane 135–172 ms / **one** pipeline pass of 84–113 ms; two panes 267–315 ms / **two** passes |
| the same, **unfiltered and unsorted** | `applyTableFiltersSort` is under 1 ms of a ~32 ms navigate |
| `AppState.flush()` with **one** 200k-row template | 24.6 MiB serialised, 1,320–1,839 ms |
| with **two** 200k-row templates loaded | 49.3 MiB, 3,372–3,893 ms — linear in the templates held |

The second pane really does cost a second filter+sort pass, and the suite pins it at exactly one
pass per pane with a ratio ceiling. **The memo that would remove it was refused on evidence, not
skipped:** a memo keyed by the view object cannot make the second pane's pass a hit at all (two
panes are two view objects, and once they carry different filters they can never share an entry),
and the specified invalidation point knows nothing about `sess.offsets` — so under
`statusFilter: 'open'` a Mark Offset would be served a stale hit. The cheaper alternative
(repaint the second pane through `_refreshVirtBody`) was shimmed in and measured **drawing a row
that had just been offset as still open**, which in a reconciliation workbench is a
double-posting invitation. Ticket T-F2-1 records what a safe memo would need.

The flush figure is not caused by the split — it only makes holding two big templates the normal
way to work. It is the same whole-file shared JSON every other feature writes.

### 13.7 Known limitations

- **Two panes maximum**, and **not two periods** of one template at once.
- **Excel View and Sheet mode** are unavailable while split (the four jspreadsheet singletons
  would need lifting — its own ticket).
- The **column order is shared** by both panes, per reconciliation per PC (§13.1).
- `Reco._rowById`'s index memo is keyed on *(array identity, length)*, so an **in-place**
  re-order of `sess.data` would hand back the wrong row. Nothing in the tree re-orders in place
  today — every real route replaces the array — but A1, A6 and B2 all now address rows by `_id`
  through it, so it is a shared latent single point of failure (ticket T-F1-1).
- `Reco.applyCorrection` still writes **no `Cn` row** to the day file (pre-existing): the share's
  only record of a correction is the `correctionMaster` entry.
