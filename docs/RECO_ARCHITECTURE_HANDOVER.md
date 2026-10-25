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

Writes for a key go through a per-key queue (one in flight; a newer save replaces a queued one). A failed write is toasted and retried on the next save. `Store._hasApi()` false → localStorage (`reco_` prefix) for browser testing.

**Three latches refuse a write rather than guess**, and they are at three different grains:

- `Store.readOnlyKeys[key]` — the file of a whole persisted key could not be **read** at load, so that key is never written in that session. This is the original latch and it is unchanged.
- `Store.readOnlyFiles[file]` — **per FILE, added with F17.** One `reco/extraValues/<tplId>.json` that could not be read or parsed latches that path: `Store.mergeWrite` **refuses** that template's writes and says so once, and every other template keeps saving. Writing those records into the main file instead would give one template two homes, and the day the share recovers the older copy wins per cell and replaces work somebody did. The cost of the refusal is the keystroke (T-S10-6).
- the boot latch for `extraValueMaster` (**F19**) — damage is known **at boot**, not at the first save: the message is *"nothing is being saved to it in this session"* rather than "starting it empty", the first keystroke into that template is told as well, and exactly **one** quarantine copy is kept under `reco/_corrupt/`.

**`Store.mergeWrite(key, mutate, opts)` is the one write path for `extraValueMaster`**, and its merge rule is the opposite of the one this file documented until the fix round. **For the top-level ids a file owns, the file on the share is the AUTHORITY, and this session's buffered intents replay on top of it** (`Store._takeDisk`, then `m.intents.forEach`). An id in memory that the file does not have is **dropped**. See §5b for what that replaced and why reinstating it reintroduces two blockers.

`App.returnToHub()`, `pagehide` and `window.__hubFlush()` flush pending writes; `window.__hubPendingWrites()` reports how many are outstanding.

**And two gates now ask before a window leaves with unwritten typing (F11).** After the flush, `App.returnToHub` calls `App._pendingLeaveOk()`, which reads `AppState.pendingCount()` — the save timer, `Store`'s buffered merge intents and `Versioning`'s queue — and, if anything is owed, refuses to leave without a confirm **naming the count**: *"N change(s) have not reached the shared folder yet — it did not answer when Reco tried to save them, and they are only in this window … Stay, and Reco keeps trying on its own."* `App._wireLeaveGuard()` is the twin for **closing the window**, which does not go through that button; `beforeunload` is best-effort inside a webview, so it is belt and braces and never the fix on its own. The question names a number rather than saying "unsaved changes" because what is owed is a count of typed values and the operator can go and look at them. See §15.6 for what is still reachable past these two gates.

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

One thing deliberately **not** done, recorded so it is not re-attempted blind.
(The other — re-keying `manualTags` — **has now landed properly**, as the
`_pk`-keyed store in §5b. Re-keying the session map onto `_pk || _id` was tried
and refused first, because it still lands on `_id` for a keyless template, it
lives on the session so Clear Data destroys it, it is serialised inside the
85.6 MiB blob, and being per-session it cannot carry a value across *files*.
§5b is the store that answers all four.) A "someone else
changed this template while you had it open" check was written and removed:
`AppState.recoTemplates` is read once, at boot, so the comparison only ever saw
this session's own object and could never fire. The hazard is real — the editor
deep-clones on open and `saveTemplate` replaces the whole object, so a field a
colleague set at 10:00 is wiped by a save from a 09:00 clone — and detecting it
means re-reading the stored template from the share at save time, which makes
`saveTemplate` async.

| helper (added with §5b) | what it is | why |
|---|---|---|
| `Store.mergeWrite(key, mutate, opts)` | read → merge → write, **all inside one `Store._enqueue` job**, debounced 150 ms | `Store.save` is a whole-file `write_file` with no re-read and no mtime check, and `AppState.load()` runs once, at boot. A read taken *outside* the queue sees the pre-write state of a write already in flight, so two bursts 200 ms apart both read the stale object and **the operator loses their own writes** — no second client needed |
| `Store._takeDisk(mem, disk, owns)` | the merge half: for the ids this file owns, **the disk object wins**, and an id in memory the file does not have is **deleted** | it **replaced** `Store._mergeUnder` (disk deep-merged *under* memory). Under the old rule absence in the file was indistinguishable from absence in a stale read, so a deletion could not be expressed at all — see §5b, and do not restore it |
| `Reco.storeKey(tpl, row)` | `row._pk`, or null — never mints | the stricter sibling of `Reco.rowKey`: it refuses the **truthy** string `'||'` that `getRowPK` mints when every key component is blank, which would collapse every blank-key row in every file onto one key |
| `Reco.dataSetOf(sess, row)` | `sess.dataSetIds[row._dsi]`, or null | which file a row came from. "Add Data" *concatenates* and nothing ever removes a data set, so a session-level answer would make September's typed values appear on October's rows |
| `Reco._extraRec` / `_extraTyped` / `_extraOverride` | the three readers of the store | one ladder, read by the grid, every export, every report, the Excel view **and the AEG journal loop**, so the screen and the journal cannot disagree. `_extraOverride` is also the **second** duplicate-key guard: it serves nothing when `Reco._dupPkCountFor` says the key names more than one loaded row (§5c) |
| `Reco._setOverride` / `_clearOverride` (added with §5c) | the two writers of a `k:'override'` record, each returning `{ok}` or `{ok:false, reason, message}` | an override is **refused** on a pk-less row, on a key shared by more than one loaded row (it would multiply money into a journal entry) and on a row already posted to the ledger. The revert **deletes** the record: writing the computed value back would freeze it |
| `Reco.isRowPosted(tpl, sess, row)` (S12) | the ONE answer to "is this number in the general ledger" | there were two, and they disagreed: this read the raw row while `ExcelLink._isPosted` read the enriched one, so a post-entry value typed into an added column made the grid say *open* and the Excel review say *posted*. #26's posted-row refusal **is** this function |
| `Reco._dupPkCountFor(tpl, sess, pk)` | how many loaded rows share a key, from `ingestData`'s own pass (memoised on the row array, never on `sess`) | a duplicate `_pk` is a tolerated state, and an override keyed on it would be read by every row with that key |
| `Reco._ovSchema(tpl, sess)` | the grid's **cached** `XlSchema` for override edits | routing an override through `applyEdits` with no `schema` re-runs `XlSchema.build` — its 2,000-row numeric-kind scan per formula extra, **and now F6's O(rows) key Set** — on every keystroke-blur. Re-measured on this tree: **2.893 ms per override** with the cached schema at 200k rows, and `XlSchema.build` alone is **60.8 ms** at that size once the template holds one record (§5c, Cost) |
| `Reco._extraCarried(tpl, sess, row, name)` (added with §5d) | the record when the value in this cell came from **another** file, else null | carried-ness is **derived** (`rec.ds` against `Reco.dataSetOf`), never stored, so the mark clears by itself — which is why `Reco.setTag` has to pass `{force:true}` on a carried cell, or re-entering the value is a no-op and the mark is unclearable |
| `Reco._carryColumn(tpl, name)` | the added column with the carry box ticked, or null | the twin of `_overrideColumn`, and the same two questions kept apart: `_extraTyped` answers *scope*, this answers *may this column be carried at all* (`custom`/`dropdown`, persisted, not `_ssSingleUse`) |
| `Reco._promoteCarryForward(tpl, prevExtras)` | moves legacy `sess.manualTags` values of a newly-carried column into the store, in ONE S13 write | without it the operator ticks the box and gets nothing until the period after next. It leaves an existing record byte-identical, which is what makes a second save promote nothing |
| `Reco._typedValueList(tpl, sess)` / `_typedCount(tpl)` | the Values panel's rows (scope, carried-ness, dead columns) and the Manage card's count | these records exist nowhere else — no row, no `Cn` row, no `sess` — so one screen has to be able to show and remove them |
| `Reco._dropExtraValueRec` / `_dropExtraValuesNotIn` | delete one record by key, or every record for keys not in the loaded data | `_dropOverrideRec` is now a one-line delegate to the first: #26's cell revert, #26's panel Revert and #30's Remove are the same deletion, and only the sentence differs |

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
- Ingesting data warns when rows share a primary key (they collapse to one when reopened from
  history). On a key that contains an **added column**, that warning moved **before** the write and
  became a blocking confirm the operator can refuse — see §14.4 for why it is scoped that way.

### 5b. Typed values of added columns — the `_pk`-keyed store (S10)

**The bug this exists for.** A `custom` or `dropdown` added column's value is not on the row and
never reaches the CSV. It used to live in `sess.manualTags`, keyed `row._id + '||' + name`
(`Reco._tagKey`) — and `row._id` is minted fresh by `U.uid()` on **every** load. So typing a
vendor name onto 400 rows, saving, and reopening the file the next morning gave 400 blanks, with
the values still in `reco/recoSessions.json` under row ids that no longer existed anywhere, and
nothing warning anyone. Reproduced before the fix; `tests/e2e/run_store_e2e.mjs` S4 pins it.

**The store.** `AppState.extraValueMaster[tplId][pk][colName]`, persisted as
`reco/extraValueMaster.json`:

```
{ k: 'typed' | 'override',   // EXPLICIT, never inferred from the presence of `prev`
  v: String,                 // always a String
  typed: String?,            // the raw keystroke when it differed from v
  prev: String?, src: 'formula'|'lookup'?,   // k:'override' only (#26)
  ds: String,                // '<day file>#u<n>' — the UPLOAD it was entered against
  by: String, at: String }   // AppState.currentUser, ISO
```

- **Nested, never a joined `pk + '||' + col` key.** `getRowPK` already joins the key components
  with `'||'` and escapes nothing, so a flat key is ambiguous the moment a key *value* contains
  `'||'`. Nesting fixes only the **second** join; the first is ticket **T-24R2-5**.
- **`ds` names an UPLOAD, not a day file** — `Versioning.pathFor(tpl) + '#u<n>'`, pushed in
  `ingestData`. Naming it by the day file alone made two uploads on one calendar day **one** data
  set, because both append to the same CSV: a value typed on the morning's bank extract appeared
  on the afternoon's GL extract for the same reference, unmarked and unconfirmable, on every
  template on the share with the carry flag **off** — and because the AEG extras loop runs before
  the keyword filter, a leaked keyword value decided whether a row posted at all (3,000 posted
  where 1,000 was marked; `run_store_e2e` section 34). A catch-up, a month-end with two periods
  open and a corrected file re-uploaded are all this shape. **The day file is still the prefix**,
  which is what makes the round trip work (`Reco._dsInScope`, §5d).
  **The stamp is a counter, not a clock**, so a test and a replay give the same names — and
  `Reco._maxUploadStamp(tplId, dsPath)` is the rule a future reader cannot guess: the counter is
  raised to the highest `#u<n>` any record **already on the share** names for that day file, so a
  name is **never reused while a record names it**. Without it `Reco.clearSession` installs a
  fresh session, the per-session count restarts at `#u1`, and a *different* extract is handed the
  name the stored values were typed against — which is what survives a Clear. One sparse walk of
  this template's records per upload, beside a key mint that is already O(rows).
- **`k` is explicit.** A column can be flipped `formula` → `custom` in the type select with
  nothing cleared, and after that flip `k` is the only thing that says how to read *absence* and
  which panel owns the record. Absence is the one place the kinds differ: `k:'typed'` + empty
  **deletes** the record (a tag has no computed base to reveal); `k:'override'` + `{v:''}` is a
  deliberate blank that only the revert control clears.
- **It is NOT in `PERSIST_KEYS`, and that is load-bearing.** `AppState.flush` iterates
  `PERSIST_KEYS` and, for any key whose serialised text changed, calls `Store.save` →
  `write_file` with the whole file, no re-read and no mtime check. **Membership *is* the blind
  overwrite** — and since **T-S10-1**, `entryHistory` and `docNumberMaster` are out of that list
  for the same reason and go through `AppState.ledgerFlush` → `Store.mergeWrite` (§16) — and once `manualTags` stops being written there is no second copy of these values
  anywhere (no mirror on `sess`, no `Cn` row in the CSV). It is read in `Store.loadAll` via
  `readJson` (so it inherits the `readOnlyKeys` latch and the `reco/_corrupt/` quarantine),
  assigned in `AppState.load`, and written **only** through `Store.mergeWrite`.
- **Written compact** (`Store.COMPACT_KEYS`): the file is re-read on every merge write, so
  pretty-printing would roughly triple the round trip. Measured 144–148 bytes a record
  (`reco/extraValueMaster.json`, below).

**THE MERGE RULE CHANGED IN THE FIX ROUND, AND IT IS THE SINGLE MOST IMPORTANT CHANGE IN IT.
Do not restore the old sentence.** This file used to say the disk object was deep-merged **under**
the in-memory one, on the argument that *a local record always beats a stale read*. That argument
is what caused two blockers, and `Store._mergeUnder` is gone. What runs now is
`Store._takeDisk(mem, disk, owns)`:

> **For the top-level ids this file owns, the file on the share is the AUTHORITY**, and this
> session's buffered intents replay straight on top of it. An id in memory that the file does not
> have is **dropped**.

That is safe for exactly one reason, and the reason is the queue: the read is **inside**
`Store._enqueue`, so it cannot predate a write of ours that has already resolved. Everything of
ours that reached the share is in the object we just read; everything that has not is still in
`m.intents` and is replayed one cell each. What is in memory and in neither is a record we read at
**boot** and have not touched since — and for that record a colleague is the authority,
**including when they have deleted it.**

**The old rule could not express a deletion at all**, because absence in the file is
indistinguishable from absence in a stale read. Two blockers, both reproduced on two pages:

- **a revert was resurrected.** Page A reverts an override; the share correctly becomes `{}`.
  Page B then types an unrelated Note, its memory still holds the reverted record, and the
  deep-merge-under puts it **back** — on the share, on the reverting operator's own screen, and in
  the AEG source row the journal is built from. Measured: `journalDr` 1040 where 60 is right
  (`run_store_e2e` section 33 is the gate; reviewer probe `skB/p13_override_resurrect.mjs` 4/0).
- **a delete lost to stale memory**, the same shape for a `k:'typed'` record.

`AppState.extraValueMaster` is still never **reassigned** — `_takeDisk` mutates it in place, so
every reference anything else holds stays valid — and merge granularity is **per cell**
(`{pk: {col: rec}}`), because the intents are what carry this session's own changes and they
mutate one cell each.
- **The escape hatch, in the loader on day one so it is never a migration.** `loadAll` reads
  `reco/extraValueMaster.json` and then deep-merges any `reco/extraValues/*.json`, remembering in
  `Store.extraValueFiles` which file each template's records came from; the **split file wins** on
  a conflict, and `Reco._extraValueFile` routes that template's writes back to it.
  **Two things that sentence used to get wrong.** (1) A split file that could **not** be read or
  parsed is **latched** (`Store.readOnlyFiles[rel] = true`, F17): that template's writes are
  **REFUSED** and said out loud, not routed anywhere. Routing them into the main file would give
  one template two homes, and the day the share recovers a colleague's older copy replaces
  somebody's work per cell. An **empty** file is readable and means "split, with nothing in it
  yet", so it routes and is **not** latched. The cost of the refusal is the keystroke
  (**T-S10-6**). (2) **There is no panel.** Moving a template is a boot message naming the file,
  the record count, the MB and the biggest template in it, plus a person with folder access
  moving the JSON by hand. That is reachable, and it is not a control (**T-S10-3**).

**THE CEILING IS A STATED LIMIT, NOT A GUESS.** `Store.VALUE_FILE_CEILING = 50000`. Past it the
boot names the file and the way out, and nothing is done automatically. The numbers it rests on,
re-measured on this tree (local disk through the test bridge, best of three taking the minimum;
the byte sizes came back **identical to the byte** across the whole fix round, which is the
evidence the store's shape never moved):

| records in one file | file size | B/record | boot, page-load→ready | the read a merge write performs | ONE merge write, end to end |
|---|---|---|---|---|---|
| 2,000 | 287,797 B | 144 | 533 ms | 10 ms | 35 ms |
| 50,000 | 7,327,799 B | 147 | 804 ms | 208 ms | 620 ms |
| 200,000 | 29,577,801 B | 148 | 1,848 ms | 837 ms | 2,418 ms |

All records load at boot at every size. **Where it stops being usable is about 50,000 records per
file**, and the reason is the share and not the CPU: at 200,000 records one merge write is 2.4 s
of local work **plus the whole 29.6 MB crossing the wire twice** — roughly 6 s at 10 MB/s — for
every 150 ms typing burst, and `Store._enqueue` serialises per file, so bursts queue behind each
other and two colleagues typing are each moving 30 MB a burst. **Two things are still open and a
team heading past the ceiling should have them first:** nothing prunes records whose key is in no
file, so a share grows towards the ceiling and never comes back (**T-S10-3**), and the remedy is a
message rather than a control.

**The read ladder, written once in `Reco._extraOwnValue` and copied surgically to one other
place.** Order matters at every step:

1. the **override gate first, above the type switch**, so it covers `formula` *and*
   `master_lookup`;
2. the type switch, unchanged;
3. in the dropdown/custom tail: **the row value wins** (which is what leaves the AEG To-Account
   extra alone with no special case), **then** the stored record, **then** the legacy
   `sess.manualTags` read.

**The legacy `manualTags` read is permanent.** It is what keeps `run_reports_e2e` passing with no
edit — that suite seeds `sess.manualTags[...]` directly, which makes it the regression test for
the whole migration — and it is the only home for a value on a keyless template, a blank-key row,
or a spreadsheet scratch column. **Writes moved; reads keep the fallback for ever.**

The one other evaluator is the **AEG source-row loop**, which gets the identical three lines plus
the same gate, deliberately *without* being swapped onto `_rowWithExtras`: it has its own
To-Account exception and its own `''`-vs-`'#ERR'` divergence from the grid, and rewriting it would
change posted numbers. That is safe only because `RecoTemplate._exclusiveRoleConflict` forbids an
override- or carry-enabled column from being any AEG control column — the loop runs **before** the
keyword filter, so a value read there can decide whether a row posts at all. (The grid is no
longer a third evaluator: it reads `fullOf()[ac.name]` through `Reco.rowFull`.)

**What the store will NOT take** (`Reco._setExtraTyped` returns false and the value goes to
`sess.manualTags`, exactly as before): a column that is not a **persisted, non-`_ssSingleUse`**
entry in `tpl.additionalColumns` (spreadsheet mode can add three shapes, and
`_ssCleanupSingleUseAfterEntry` deletes two of them — their records would be orphaned on the
share for ever under a name nothing can show); a row with no usable store key; and a row whose
data set cannot be named, because a file-scoped record for it could never be read back.

**Scope is per ROW, not per session (S14).** `sess.dataSetIds` holds the data sets whose rows are
in `sess.data`, in arrival order, and each row carries `_dsi`, a small integer index into it (a
path string per row would add ~9 MB to `recoSessions.json` at 200k rows). Stamped in
`ingestData` (pushed — "Add Data" concatenates) and in `loadVersionedFile` (replaced — that load
replaces `sess.data`). A row with no `_dsi` — one typed in with **+ Row**, or a session written by
an older build — answers null and takes the legacy branch. `dataSetIds` is **DATA** in
`Panes.DATA_KEYS`, for the same reason `activeVersionFile` is.

A `k:'typed'` record is then **file-scoped** unless the column has `carryForward === true`, which
**§5d sets** — off by default, so off is every template that exists today. With the flag off the
improvement is this, exactly: the value **survives reopening its own file from version history**,
and does **not** appear on a row from another file. It does **not** survive onto a *different
extract uploaded the same day*: after the per-upload `ds` stamp, such a row is a different data
set and comes up blank, which is the fix for the leak described under `ds` above
(`run_store_e2e` sections 34 and 40). **So the Clear's own confirm over-promises**: it says the
kept values "come back when a file with those keys is loaded again", and the file that brings them
back is the day file reopened from history, not the next extract. **T-30-4.**
`k:'override'` records are always key-scoped — an override is a decision about the invoice, not
about the file.

**Also moved with it:** all four backup sites (`backupSession`, `restoreSession` and its confirm
text, `App.exportBackup`, `App.importBackup`), `RecoTemplate.remove`, and the Excel review badge,
which split in two — a tag the store serves is `notVersioned` ("kept against this row key in the
shared values file") rather than `sessionOnly` ("kept in this session"), because for such a column
the old wording was the opposite of true.

### 5c. The manual override of a computed column (#26)

> *"column with formula and option to override should be there."*

A `formula`, `master` or `master_lookup` added column can be marked **Allow manual override per
row** in the template's Additional Columns. A person then types their own value into that cell; it
is stored as a `k:'override'` record in the same `_pk`-keyed store as §5b, with `prev` (what the
formula or lookup said at the time) and `src` (`'formula'` or `'lookup'`); a **revert** control
puts the computed value back; and every override is listed under **Manage → Manual Overrides**
with who, when, what it replaced, what the formula says now, and Revert.

**Read at render time, never stamped into a row, and no `Cn` version row.** `isVersioned` stays
false: no template column changed, so a `Cn` row would be byte-identical to its predecessor and
would tell a reader of the CSV that nothing happened while something did. The column keeps
`role:'computed'` and gains `desc.overridable` — a new role would mean hunting every
`role !== 'computed'` comparison in the file, and exactly one of them needed changing (the Excel
review badge, which now says `override`).

**The override applies to lookups as well as formulas**, and a lookup override is listed
distinctly, because overriding a lookup stops that row following a master every colleague trusts —
a different decision from disagreeing with arithmetic.

**Four refusals, each one a failure somebody would otherwise meet.** `Reco._setOverride` returns
`{ok:false, reason, message}` and writes nothing:

| refused | why |
|---|---|
| a column nobody ticked the box for | so a workbook cannot smuggle an override into a column the template owner never opened. The **grid cell says so**: a locked computed cell now carries `title="Computed in Reco. To let people type their own value here, turn on 'Allow manual override per row'…"` and `cursor:not-allowed`, where it used to carry no title at all — and since the flag defaults false, that is every template that exists today |
| a row with no usable key | it goes to `res.rejected` with the existing `noPk` reason, never counted as applied. A record filed under no key could not be found again |
| **more than one loaded row shares the `_pk`** | three AP lines under `INV-7`, one overridden to 1000, and a key-scoped override makes all three read 1000: the entry posts **3000** where the three rows are worth **2030**. Unlike a correction, where broadcasting to every row with the key is the documented intent, broadcasting an override is a money bug. The count is in the message (*"3 loaded rows share the row key “INV-7”…"*) and the cell renders **locked**. **This is only the first of two independent guards — see below** |
| **the row is already posted to the general ledger** | naming the accounting reference, so the answer is "reverse entry AEG-… first" rather than "no". This is a call to S12 — and it guards the **four delete routes** as well as the write (F10): `applyEdits {clear:true}` (the grid's own revert), the **Manual Overrides** panel's one-click ↺, the **Column Values** panel's per-record Remove, and *"remove every record for keys not in the current data"*, which still does its job on the keys that are **not** in the ledger, so it is a refusal about the ledger and not a blanket ban |

**AND A SECOND, INDEPENDENT GUARD AT THE READER — RC-6, because the write guard was not enough.**
`Reco._setOverride` can only ask about the key **as it is when the value is typed**, and the key
becomes shared **afterwards** as a matter of routine: the override is typed on the one `INV-7`
line in this week's file, and next week's **Add Data** brings two more lines under the same
invoice number, which is the ordinary shape of an AP extract. The stored record was then read by
all three rows, the column showed 1000 on each, and the entry posted **3000**. The only toast was
*"Loaded 2 rows"*. So `Reco._extraOverride` now **suppresses** the record whenever
`Reco._dupPkCountFor` says the key names more than one loaded row — at the one chokepoint the grid,
a report total, the CSV, the workbook, the Excel view and the AEG source-row loop all share, so the
screen and the journal cannot disagree about which it is.

**The arithmetic changes with the second guard, and it is money, so it is spelled out.**
Suppression means **every row posts its own formula** — not the "1000 + 30 + 0" a reader would
expect. On the suite's own non-degenerate fixture the three rows read `2000, 30, 0` and the entry
posts **2030** (`run_store_e2e` section 37, R3a/R3b; before the duplicate arrives the same record
applies and posts 1000, and R3f is the control that it applies again once the duplicate is
corrected). **Why suppress rather than pick a row:** the record is keyed on the key **alone** and
cannot name a row, so there is no way to apply it to one of three and leave the others computed.
Two readings are possible and the app refuses to guess.
**The record is KEPT, not deleted** — a key duplicated this month may be unique next month — and
**the operator is told**, in the *Duplicate primary keys* modal that fires on the same load:
*"1 manual override(s) have stopped applying … INV-7 / Net … They are not deleted"*. Not in a
toast, which is why a toast-reading probe sees no warning.
**Note for a reader of the suite:** O2f's `1030` is a **premise, not a gate**. Its fixture is
degenerate — row 1's formula value happens to equal the override — so 1030 is reached both by
applying the override to the right row and by suppressing it. R3a/R3b on the `2000 / 30 / 0`
fixture are what distinguish them.

**Canonicalised on write, but only when it is a number.** `Formula._tokenValue` rejects a comma,
so `1,234.50` stored verbatim gives `#ERR` from `{Net}*2` while `U.num` reads 1234.5 — the same
override reading two ways on two surfaces. A `'value'` column therefore stores
`String(U.num(raw))` (`1,234.50` → `1234.5`, `(500)` → `-500`) with the raw keystroke kept in
`typed`. Something that is **not** a number is stored **verbatim**: `U.num('abc')` is 0 and a
silent zero in a column that feeds a journal entry is the class of bug this exists to prevent, and
refusing it instead would make the kind rule below unreachable.

**THE OLD GUARANTEE FOR THAT VERBATIM VALUE WAS WRONG, AND F4 IS THE PROOF.** This file used to
say *"the dependent formula then says `#ERR`, which is loud."* It is loud for `{Net}*2`, because
`Formula._tokenValue` rejects a comma — and it is **silent** for `NUM({Net})`, which is how every
AEG input column in this codebase is written: `NUM` reads `'1.234,50'` as 101.2345 and `'abc'` and
`"'500"` as **0**. Both readings are defensible, so the store still keeps the characters and the
**guarantee moved to the one door into entry history**: `Reco.previewEntryFromSelection` refuses
the posting **by name**, naming the key, the column, the characters and what they replaced —
*"… which is not a number (it replaced 20) … so this entry is refused"* — and builds nothing.
**The test, as MR-1 left it.** This file used to say the test was *"the stored value is not a
number **and** `rec.prev` was"* — i.e. only *this override turned a numeric cell non-numeric*.
**MR-1 removed that conjunction**, and the removal is the fix, not a detail: for a cell whose
formula reads `#ERR`, `rec.prev` **is** `'#ERR'` and is not numeric, so the one cell Z1 refuses
over was the one cell this refusal stopped looking at the moment somebody typed over it — and the
override box is the only tool the app offers for correcting a computed cell by hand, which is
exactly where Z1's own message sends the operator. Measured: `"'500"` over an `#ERR` cell posted
**Dr 150 for three rows worth 150 + INV-3**, with INV-3 contributing nothing and stamped
`POSTED`. **If you are tempted to put the `prev` test back, that is blocker A1 and this paragraph
is why it is not there.**

What the code now reads is
`if (!U.isNumeric(rec.prev) && !readsForRow(r).has(cn)) return;` — refuse when the stored value is
not a number **and** (`rec.prev` was a number **or** this column is one *this journal entry
actually reads*). `readsForRow` is the AEG template's input columns, their labels, its value /
club-by / From-Account / To-Account columns and `tpl.valueColumn`, or — for a bucketed row — that
row's **own Special JV's** `inputColumns`; the keyword column is in both sets. Labels are in it
as well as names, because the AEG loop falls back to `r[ic.label]`, so an added column named
after an input column's *label* is read by the entry even though the editor never objected.
The `prev` arm is what still protects decision **J.8**: a column that was textual all along,
whose kind is derived from its values rather than declared, and which exports as text. A column
the journal reads as an amount or an account code is never that one, so there the test has
nothing to protect and is dropped. `1,234.50`, `(500)` and `500 ` are canonicalised before they
are stored, so none of them lands here; a record on a duplicated key is skipped because
`_extraOverride` is no longer serving it; and it runs **after** the keyword filter, because
refusing a posting over a row the filter dropped is a refusal about a row nobody is posting.
**The residue is open and visible:** a report **TOTAL** still reads 101.2345 for three rows worth
100 beside the characters it came from. It cannot be posted any more, which is why it is
**T-26-5** and not a blocker.

**The exported kind does not depend on where in the file the override is.** `XlSchema.build`'s
numeric-kind scan stops at 2,000 rows, so an override on row 50,000 never entered it: the column
kept `kind:'value'` and `buildExport` wrote that one cell as forced text inside a numeric column,
where Excel's SUM silently excludes it and the load-back diff is quiet because the baseline
recorded the same text. The scan now also walks the sparse store for that column, **scoped to the
keys of the rows being exported** — a lazy `Set` over `opts.rows || sess.data`, built at most once
per build and only if something asks, so a template with no records still walks no rows, which is
every template today. **The scope is the fix, not a detail (F6):** the unscoped reading of that
sentence is what shipped first, and one stale record under a key nobody had loaded since April
downgraded a whole numeric column to text — 2,000 good numbers reached a colleague's workbook as
strings and their SUM read 0. It is scoped to `rows` rather than `sess.data` because a filtered or
selected export is a different question with the same answer shape. **It is not free:** see
**Cost** below.

**The workbook contains the column.** The in-app view filtered on `showExtras`/computed while the
real export filtered on `d.role !== 'computed'`, so a user was shown an editable input and handed
a workbook without it. Both `includeComputed` filters and the `showExtras:'inputs'` filter now
read `|| d.overridable`.

**The revert is a `clear` edit, handled before `const cur = …`** in `applyEdits`, immediately
after its two guards. `applyEdits` runs its noop check *before* it dispatches on `writeTo`, and
`XlSchema.currentValue` would by then return **the override**, so both plausible readings of a
value-based revert fail: passing no value makes `value === ''`, which equals an empty override (so
an empty override would be **permanent**), and passing the computed value no-ops whenever the
formula has drifted to equal the override. It is not ridden on `e.force`.

**The Excel view's undo does not latch an override.** Its history recorded `before` as the
*computed* value when no override existed and replayed it as a **value**, so Ctrl+Z after typing
250 stored `{v:'90', prev:'250'}`: the cell *looked* right and was frozen at 90 in the grid, the
reports, the CSV and any posted JV. The history entry now carries `beforeOverride` (the record, or
null) and a null is turned back into a `clear: true` edit.

**Cost.** An override must not end in `AppState.save()`, which serialises every persist key —
measured 798–1378 ms / 85.6 MiB at 200k rows — to discover nothing changed: the record is written
by `Store.mergeWrite` through `Reco._extraValueFlush`, and `applyEdits` skips the trailing save
when an override was the only thing applied. The grid's two handlers pass the **cached** schema
(`Reco._ovSchema`), because routing through `applyEdits` with no `schema` re-runs `XlSchema.build`
per keystroke-blur. **No `recoSessions.json` write at all** — that part held.

**The per-override number in this section was wrong by 29x and is replaced.** Re-measured at
200,000 rows on this tree, best of three taking the minimum: **2.893 ms per override** with the
cached schema (30 overrides through `_setOverride`), against reviewer A's **1.41 ms** on the same
code. The old **0.1 ms** was optimistic and the "2.5 ms without the cached schema" it was compared
against was **not** re-measured, so that comparison is withdrawn rather than restated. At 500,000
rows an override is 0.017 ms each with a warm duplicate-key memo — the memo build is the cost, not
the override.

**AND ONE REGRESSION THIS SECTION'S COST ARGUMENT RESTS ON, which nobody measured until the
verification round.** `XlSchema.build` at 200,000 rows, once a template holds **one** override
record: **60.8 ms**, against **3.4 ms** at `4b8fd90` — same fixture, same machine, run back to
back. With **no** records it is unchanged (3.7 ms vs 3.0 ms), so F6's "no walk at all for a
template with no records" holds; what costs is that `rows = opts.rows || sess.data`, so **any**
template holding even one record pays an O(rows) `Set` build once per build.

| caller | pays? |
|---|---|
| the grid's two override handlers | **no** — they pass the cached `Reco._ovSchema` |
| `Reco.columnCatalog` (the pickers) | **no** — it passes `rows: []` |
| the **export** schema | **yes** |
| the **editor** schema | **yes** |
| `ExcelLink.diff` — the **load-back plan** | **yes** |
| `Reco._reversePlan` — the **reversal plan** | **yes** |
| any **`applyEdits`** caller that does not pass a `schema` | **yes** |

60 ms on a one-off action is tolerable, and nothing here is on a keystroke path — but this
section's whole cost argument was written while that function was 2 ms, so it has one —
**T-26-7**, which names the paying callers by function — and this line.

**The header count is an honest map-key count** — *"N override(s) stored for this column (some keys
may not be in the loaded data)"*. Counting the overrides on the loaded rows would need a Set over
every row on every render, and orphans are kept on purpose.

**S12 — one answer to "is this posted".** `Reco.isRowPosted(tpl, sess, row)` has **three** arms,
asked in this order: the **row property** first (that is what `commitEntryFromPreview` writes and
what a reversal deletes); then the **ladder**, when the post-entry column is an **added** column
whose value is computed or lives in the store; and then — **the arm that matters, added by RC-5** —
**the ledger's own record**, `Reco._postedRefForPk` over `entry.postedPks` with `postedCol` and
`postedValue`.

**The third arm is what makes the answer survive a reload, and it is a money fix rather than a
tidy-up.** For an **added** post-entry column — which the picker offers — commit stamps a plain
row property and queues a version row only `if (isStdCol)`, so **nothing durable held the mark**:
`loadVersionedFile` carries template columns only. After the reload every colleague does the next
morning, and after a Clear, this function answered *"open"* about a row that is in the general
ledger while `Reco._postedRefFor` named the entry about the same row. The grid badge went blank,
the Posted-JV Tracking card reported 0 posted / 0 missing, and **#26's posted-row refusal could
not fire — so a person typed 999999 over a number that was already posted and it was accepted.**
The ledger's record is **key-scoped**, which is what posted-ness is (an invoice is in the ledger
whatever file it is read in), and **nothing new is written to the share** to get it.
**Both the column and the value are compared**, because both are editable: an entry that stamped
`Reviewed` into `Workflow` must not answer for a template that now stamps `Posted` into `Status`.
An entry written before `postedCol` existed carries neither and therefore says nothing, which
leaves every older share answering exactly as it does today. **A reversed or cancelled entry is
not a posted row** — the mark is dropped, which re-opens the override, which is what the
refusal's own sentence invites. Verified after the reload, where it used to break: all six readers
give one answer, and `setOverride` answers *"REFUSED: posted … under AEMVAHYO5T … Reverse that
entry before changing the number it was posted with."*

There were two implementations giving opposite answers about the
same row — this one and `ExcelLink._isPosted`, which read the enriched row — and §5b made the
divergence reachable in a new way, because a typed value now survives a reload while the row
property a stamp wrote does not. Every caller was converted: the grid badge, the Excel-view status
cell, `postedJvAudit` (which opens a Masters pass when the column is an added lookup, so a master
is indexed once rather than once per row), the posted-JV exception export (which now shows the
value the decision was made on) and `ExcelLink._isPosted`, which is now a one-line delegate. The
two-argument call is still accepted, because five sites in `run_reverse_e2e` use it.

**S11 is asked, not duplicated — and it is now decided from the RECORDS, not from the box (F5).**
A column **holds the override role while it holds override records, ticked or not**:
`_exclusiveRoleConflict` falls back to `Reco._overrideCount(t, n)` when the box is off. The hole
that closed: unticking *Allow manual override per row* deliberately leaves every stored record
applying (`_extraOverride` does not consult the flag — silently recomputing a number a preparer
signed off is the worse of the two, and that is settled), so **two silent template edits** —
untick, then assign the same column as the AEG keyword column — put a stale override in charge of
whether a row posts at all, and the entry posted **1007** where the extract had marked **7**.
Neither edit said a word. The refusal now names the column and the count, and the **untick itself
says how many keep applying**: *"“Kw” can no longer be overridden by hand, but 1 override(s)
already stored against row keys KEEP APPLYING — the box only stops new ones."* Sparse walk, on a
toggle only, and no walk at all for a template with no records.
**Only the override arm, and that is not an oversight:** an override is **key**-scoped, so it
applies to a row nobody typed it on, which is what makes it dangerous in an AEG control column. A
`k:'typed'` record on a column with no carry flag is **file**-scoped, so it is read on exactly the
rows the operator typed it on — a plain dropdown may therefore still be the keyword column, which
O14a asserts and which the editor offers on purpose.
**One thing the refusal leaves behind, and it has its own ticket (T-26-8):** an AEG left holding
`keywordValues` with **no** `keywordColumn` posts **every** row (dr 1007 again, reached a
different way). The operator's only protection is the refusal toast. The AEG never had that
validation, so it is not a regression of these three features — but following the refusal now
reaches it.

The `allowOverride` checkbox calls
`RecoTemplate._exclusiveRoleConflict(t, name, 'allowOverride')`; the matrix already held that row
in both directions, and `aeg.inputColumns` joined it with #26 (T-24R2-6), so the AEG editor
refuses renaming an input column onto an overridable one. The box is **always enabled and refused
in the handler**, like the primary-key boxes and for the reason that comment gives: the Primary
Key block is emitted before the Additional Columns editor and ticking a key there does not redraw
it, so a greyed-out box would stay grey after the user had just ticked one.

Tests: `tests/e2e/run_store_e2e.mjs` sections [12]–[22] (O1–O14), with O1, O2 and O3 as the
gates — **and sections [33]–[48]**, which the fix round added and where every one of the twenty
review findings is pinned: [33]–[34] the two merge/data-set gates (RC-1, RC-2), [35]–[40]
R1–R6 (F3, F10, F1, F5, F4, F9) and [41]–[48] X1–X8 (F11/F19, F17, F12, F20, F13, F18, F6, F15).
`run_store_e2e` held **378 passed / 0 failed** when this section was written, and is the suite
that holds all three features' gates — **plus sections [49]–[53]**, which the money round added
(Z1, T-26-5, T-26-6, T-S10-1, T-30-3; see §16), and [54]–[88] from the five rounds after it. **It
is at 743 today**; §18 to §21 carry the round-by-round arithmetic. The figure is written as history on
purpose: a bare count in a feature write-up goes stale on the next round and then reads as a claim
about the suite rather than a note about when the feature landed.

### 5d. Carrying a typed value forward to the next file (#30)

Ticket #30 was *"option to preload values of selected custom columns from previous file on loading
new file"*. There is **no preload step**: the store of §5b is keyed on the row's `_pk` and read at
render time, so loading a new file costs zero extra reads and zero extra writes. What #30 adds is
the flag that decides the **scope** of a `k:'typed'` record, the mark that says a value came from
another file, and the one-time promotion that makes the flag mean something the day it is ticked.

**THE FLAG, OFF BY DEFAULT, PER COLUMN.** `ac.carryForward === true` on a `custom` or `dropdown`
added column, set by **Carry this value forward to the next file** in the template's Additional
Columns (`RecoTemplate._carryBox` / `toggleCarry`). Off is every template that exists today, and
off means **file-scoped**: `Reco._extraTyped` honours the record only for a row whose data set
(`Reco.dataSetOf`, i.e. `sess.dataSetIds[row._dsi]`) matches `rec.ds`. On means **key-scoped**:
honoured for that key in any file. `k:'override'` records are always key-scoped, because an
override is a decision about the invoice and not about the file.

**WHY THE SCOPE IS PER ROW AND NOT PER SESSION, and it was a blocker.** "Add Data" does
`sess.data = sess.data.concat(mapped);` and nothing ever removes a data set, so September's rows
are still in `sess.data` when October's render. A session-level test would therefore have shipped
the cross-file carry this feature promises it does **not** — by default, on every template on the
share. `row._dsi` (a small integer index into `sess.dataSetIds`; a path string would add ~9 MB to
`recoSessions.json` at 200k rows) is what makes the test per row. It is stamped **last** in both
row literals, because `run_panes_e2e`'s T1 diffs `recoSessions.json` byte for byte. A row with no
`_dsi` — a `+ Row` row, or a session persisted by an older build — answers `null` and is treated as
out of scope rather than guessed at.

**THE MARK IS DERIVED, NEVER STORED** (`Reco._extraCarried`): `rec.ds` against the row's own data
set, through **`Reco._dsInScope(rowDs, recDs)`** — the same predicate `Reco._extraTyped` uses for
scope, so the mark cannot disagree with whether the value was honoured. Its three cases are
deliberately **not** symmetric, because `ds` names an upload: the same data set is in scope;
different **day files** are out of scope (that is decision M); and the same day file with
different uploads is in scope **only if the ROW's data set is the bare day file** — i.e. the
operator has reopened that file from version history, at which point its uploads really are one
file and nothing can tell them apart. A row from a **fresh** upload is a different extract that
happens to land in the same CSV, and a value typed on another upload is not about it. That prefix
match is what makes the round trip work: a record stays in scope when its day file is reopened.
A stored flag would have to be cleared by every writer that touches the cell, and the one
that forgot would leave an accent on a value somebody had confirmed. The grid renders a carried
cell with `td.carry-set`, a `title` naming **who typed it, what, in which file and when**, and a
`✓` confirm button. **Nothing at all is emitted when a cell is not carried**, which is why the two
grid-`<tbody>` byte-identity gates (`run_colorder_e2e` T1 and `run_pk_extras_e2e` G1) needed no
amendment for #30.

**CONFIRMING NEEDS ITS OWN PATH, and that is what the derived mark costs.** `applyEdits` does
`if (String(value) === String(cur)) { res.noop++; continue; }` and `cur` (`XlSchema.currentValue`)
reads a tag through the **enriched** row — i.e. the carried value. So re-entering it is a no-op,
`ds` is never re-stamped, and the mark is **unclearable**. `Reco.setTag` therefore asks
`Reco._extraCarried` first and passes `{ force: true }` on that one edit, which `applyEdits`
already honours for "a decision the user made explicitly". It asks **only when the cell is
carried**, so an ordinary re-type of an ordinary tag still no-ops and still writes nothing to the
share. `Reco.confirmCarried` is the `✓`: a **dropdown** is why that button exists at all — picking
the option that is already selected fires no `change` event, so without it a carried dropdown
could only be confirmed by choosing something else and choosing back.

**`ds` ON WRITE IS THE ROW'S DATA SET, NEVER `Versioning.pathFor(tpl)`.** `pathFor` is *today's*
day file; a file reopened from history on a later calendar day belongs to its own file, and
stamping today's path would make the value vanish from its own file's scope on the next repaint.
`pathFor` is used in `ingestData` only to **name** the data set the upload is going into — and the
name it builds is `pathFor(tpl) + '#u<n>'`, an **upload** stamp and not the bare day-file path
(see §5b for the leak that forced it and for `Reco._maxUploadStamp`, which is why a Clear cannot
hand a different extract an old name).

**THE ONE-TIME PROMOTION** (`Reco._promoteCarryForward`, called from `saveTemplate`). Without it
the operator ticks the box and gets nothing until the period after next: the values on screen were
typed before the box was ticked, so they are in `sess.manualTags` — keyed on `row._id`, which is
re-minted on every load — and the store has nothing against the key to carry. The promotion moves
each legacy value of a column that **gained** the flag into the store in **one** S13 write, and
deletes the legacy entry for that exact cell (one truth per cell). It leaves a cell that already
has a record **byte-identical**, because such a record became key-scoped the instant the flag went
on; that is what makes a second save with nothing changed promote nothing. `prevExtras` is captured
**inside `saveTemplate`'s `else` block before the swap** — at the `--- THE CRITICAL FIX ---`
anchor `orig` is out of scope and the stored template already *is* `t` — and the session is read as
`AppState.recoSessions[t.id]`, never through `activeRecoId`, because the editor is reachable from
Home.

**S11 IS WHAT MAKES A *FLAGGED* COLUMN SAFE IN THE JOURNAL, and it does not cover the whole
hazard.** The AEG extras loop reads the store through its own copy of the same ladder, and it runs
**before** the keyword filter — so a carried value on the keyword column would decide whether a
row posts at all, and one on an input or `aggregateBy` column (matched by name) would set an
account code or change how amounts group. `RecoTemplate._exclusiveRoleConflict(t, name,
'carryForward')` refuses **a column with the carry flag** being any of those, in both editors and
both directions. The alternative remedy — leave the AEG loop reading `manualTags` only — would
have shipped a **permanent divergence** where the grid shows the carried value and the journal
posts without it.

**WHAT S11 DOES NOT SAY, because F9 proved this sentence used to overstate it.** The matrix is
asked about the **flag**, and it says **nothing** about an added column carrying **no** flag at
all. A plain `dropdown`'s typed record really did decide whether a row posted — 3,000 posted where
1,000 was marked — and S11 never fired, because nothing about that column was ticked. **What
closes that hole is the per-upload `ds` stamp, not S11**: a `k:'typed'` record with no carry flag
is **file-scoped**, so it is read on exactly the rows of the upload it was typed against
(`run_store_e2e` sections 34 and 40). And that is also why a plain dropdown **may** still be the
AEG keyword column — a shape the editor offers on purpose (O14a) — while an **override**, which is
key-scoped, may not (§5c, S11).

**DECISION S, followed literally and with its own objection fixed.** The carry box is **disabled
with its reason** on a template with no primary keys, and **absent** on a computed column (which
has #26's override box instead). #26 chose "always enabled, refused in the handler" for its box
because the Primary Key block is emitted *before* this editor and ticking a key there does not
redraw it, so a greyed box would stay grey. `RecoTemplate.togglePK` now calls
`RecoTemplate._syncCarryBoxes(t)`, which enables/disables those boxes and swaps their reason **in
place** — no re-render (which would throw away the focus and scroll of the block the user is in),
and no element id (decision U allows one only for a bounded name on `Panes.PANE_IDS`), so the
boxes are found by their class. The handler refuses as well, because a disabled input is a UI
state and not a rule.

**THE VALUES PANEL** (Manage → **Column Values**, `Reco.openValuesModal`). The typed values of
added columns are the one kind of record in this app that exists **nowhere else** — not on the
row, not in a `Cn` row in `reco_data/`, not on `sess` — so there is one screen that lists them with
who, when, which file and their scope, marks a key that is not in the loaded data and a column
that no longer exists, and can **Remove** one or **remove every record for keys not in the current
data** (with a confirm naming the count). The card appears only once the template has a carry
column or the store holds a typed record for it, so no Manage screen that exists today gains one.

**AND THE CLEAR SAYS WHAT SURVIVES — AND IT CURRENTLY SAYS IT TOO BROADLY.**
`Reco.confirmClearSession` replaced the card's inline
`confirm('… Manual offsets, corrections, and entries are kept.')`, which did not mention typed
values at all — and before §5b a Clear silently destroyed them. It names the count of values that
are kept (against the row key, in the shared values file) and the ones that cannot be (a row with
no key, a spreadsheet scratch column), which live only in that session.
**The over-promise, stated plainly because an operator will test it:** the confirm says those
values *"come back when a file with those keys is loaded again"*. With the carry flag **off** they
come back when **that day file is reopened from version history** — not on a *different* extract
uploaded the same day, which is a new data set and comes up blank by design (`ds`, §5b;
`run_store_e2e` section 40). **T-30-4** is the wording.

Tests: `tests/e2e/run_store_e2e.mjs` sections [23]–[32] (C0–C12), with **C1** (the default flag
leaves an Add Data file 2 blank), **C2** (confirming a carried value clears the mark, both halves)
and **C3** (a 50,000-cell fill-down is ONE write) as the gates — plus sections **[33]–[48]**,
listed in §5c, which are where the twenty review findings are pinned (section 34 and R6/[40] are
#30's own: two uploads on one calendar day, and a different extract after a Clear).

**C3, re-measured, as a range rather than one number**, because it moves with the machine and both
ends were seen on this tree: **338–526 ms to apply**, **869–1,721 ms to settle** including the
debounce, `{applied: 50000, rejected: 0}`, **6.84 MB written once**, **one `write_file`**, 50,000
records in the store. During the burst `applyEdits` is synchronous, so the window drops to about
29 animation frames — visibly janky for roughly a second. That is the pre-existing cost of
`applyEdits`, not of the store.

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
5. **Apply** revalidates (rows still there, values unchanged since the review, history queue empty), then `Reco.applyEdits(…, {historyFirst:true, meta})` writes **one `Cn` per key first** and only then changes the session — if the history write fails nothing changes. A colleague's newer values for other columns of the same key are carried into that `Cn` so they are not reverted. Tag columns go to the **shared values file** first (`Reco._setExtraTyped`, which also deletes any legacy `sess.manualTags` entry for that cell — one truth per cell) and to `sess.manualTags` only when the store refuses the row; the load-back review badges such a cell `notVersioned`, not `sessionOnly` (§5b). A non-template To-Account column goes to the row. The manifest is then rebased (`rebased`/`dismissed`/`imports`/`lastImport`), so loading the same file again shows nothing new and only later edits appear next time.
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

- An eligible tag column is **no longer session-only**: since §5b its value is kept against the
  row key in the shared values file and survives a reopen. What remains session-only is the
  legacy fallback — a template with no primary keys, a blank-key row, a spreadsheet scratch
  column, or an older build. A non-template To-Account column still goes to the row.
  `recoSessions.json` remains last-writer-wins across users.
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
10. record the mark, the mirror and the freed document numbers as **merge intents**
   (`AppState.ledgerFlush`, T-S10-1 — they used to be a whole-file flush of
   `AppState._snap.entryHistory = null`), flush, re-read the share to confirm the mark, and
   append the reversal log

**Step 4 before step 5 is load-bearing.** The stamp is what makes a row look dealt-with to
everyone else; the mark is only a record. Marked-but-still-stamped is the worst state
available, so the mark is refused unless the `Cn` rows come back off the share. The other way
round — rows released, entry not yet marked — the user sees at once and simply presses Reverse
again: the un-stamp is idempotent, because the second pass finds the column already clear.

**Step 4b exists because the un-stamp between step 3 and step 10 is the longest write window in
the app** — 900 ms per read on a share, 14 s for 200,000 keys, over 100 s end to end. Step 3's
read is what refuses a *conflict*; step 4b's is what re-bases the plan on a fresher record, and
re-checking `base.reversal` there is what stops two people reversing the same entry both minting
a mirror.

**The clobber half of that paragraph is gone, and this is the durable fix it named.** Since
**T-S10-1**, `reco/entryHistory.json` is no longer whole-file last-writer-wins: step 10 records
the mark, the mirror and the `reversalCancelled` note as **merge intents** replayed onto the file
`Store.mergeWrite` has just read *inside* `Store._enqueue`, so a colleague who generated an entry
during the un-stamp no longer has it dropped by this write — which used to leave their row
stamped `Posted` with no accounting record behind it. **Every intent re-finds what it mutates by
`accountingId`**, because `Store._takeDisk` replaces the template's array with the share's before
the intent runs, so `base`, `list` and the mirror are detached copies by then. An entry the share
no longer holds (somebody restored a backup mid-reversal) is put **back** with its reversal
rather than dropped: the rows are already released, and an entry reading posted with released
rows is the one state worth avoiding.

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

- **DATA (14)** — `data`, `loadedAt`, `clearedAt`, `activeVersionFile`, **`dataSetIds`**,
  `corrections`, `offsets`, `manualTags`, `cellFormulas`, `cellFormats`, `extraColumns`,
  `selectedRows`, `_docMatches`, `columnOrder`. Read and written straight through to the owner, so
  both panes see one reconciliation. **`dataSetIds` is the fourteenth, added with §5b/§5d**, and it
  is DATA for the reason `activeVersionFile` is: it is the list of data sets whose rows are in
  `sess.data`, and each row's `_dsi` indexes into it, so it is what makes a typed value
  **file-scoped**. Per-pane it would make the same row answer about a different file in each pane.
- **VIEW (24)** — `activeSection`, `columnFilters`, `columnSorts`, `slicers`, `statusFilter`,
  `requireAttachment`, `requireComment`, `requireGroup`, `page`, `pageSize`, `columnWidths`,
  `hiddenCols`, `zoom`, `activeCell`, `selRange`, `selSig`, `spreadsheetMode`,
  `formatToolbarOpen`, `excelViewActive`, `correctionExtraCols`, `_dismissDocMatches`,
  `_virtRowHeight`, `_initialScrollTop`, `_fillDrag`. Private to the pane.
- an **unclassified** key makes the view **refuse rather than guess** (`Panes.auditKeys()` is
  asserted complete by the suite, so a new session key fails a test instead of leaking).

Two classifications are against instinct and deliberate. `manualTags` is DATA because what it
holds is content and not a preference — but **it is no longer where a typed value lives.** Since
§5b the value of an added column is written to `AppState.extraValueMaster`, which is **not a
session key at all** and therefore is not in either list; `manualTags` is the **permanent legacy
read fallback** (a keyless template, a blank-key row, a spreadsheet scratch column, and every
session written by an older build). It stays DATA because those remaining values are still shared
content, and because `run_reports_e2e` seeds it directly — which is what makes that suite the
regression test for the whole migration. `columnOrder` is DATA:
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

---

## 14. Added columns in the primary key

> *"added columns can also be used for primary key section"*

A key component may now be a template column **or an added column whose value is a
deterministic function of template columns**. The value is computed once, when the data is
loaded, and frozen into `row._pk`; nothing recomputes it.

### 14.1 The rule, and why it is this narrow

| allowed | refused, with its own reason |
|---|---|
| a template column | `custom` / `dropdown` — the user types into them, so the key would change under the row |
| a `formula` over template columns and **earlier** eligible extras | a formula calling `TODAY` / `AGE` / `AGEING` / `AGEING_BUCKET` — the key would move with the clock |
| a `master_lookup` with `source === 'accounts'` and a complete config | `docNumbers` (grows on every commit) and `corrections` (keyed *by* the key) |
| | `custom:*` masters — their ids are **positional** (`'custom:' + idx` against `splice(idx, 1)`), so deleting one silently re-points every `custom:1` config at a different table with `additionalColumns` byte-identical, so no definition-change confirm fires |
| | the legacy `type: 'master'` — its `evalLookup` branch scans `AppState.aegMaster` inline per row and never calls `Masters.lookup` |

The formula check **whitelists the grammar** rather than blacklisting names, because
`Formula._compile` builds `new Function('__t', ...names, 'return (' + code + ');')` — everything
outside `{…}` is raw JavaScript. So `CONCAT({Doc},"-",Date.now())` would pass a name blacklist and
give every row a unique throwaway key. `{…}` tokens and string literals are stripped, clock
helpers are matched on **call position** with word boundaries, and any remaining identifier that
is not a key of `Formula._helpers` is rejected. (A substring test for `AGE` would also refuse a
legitimate `ROUND(AVERAGE({A},{B}),2)` with a visibly nonsense reason, which is how people learn
to distrust a validator.)

### 14.2 Two readers, and the difference matters

- **`Reco.rowKey(tpl, row)`** — the BUSINESS key. Tests `primaryKeys.length` **first**, then
  returns `row._pk`, and **never mints**: a pure reader, null on miss. Twenty behavioural readers
  were converted to it.
- **`row._pk`** — STORAGE identity. Every row has a truthy one (`_auto_`+uid or `_added_`+id).
  Read directly only by `applyEdits`, `appendUpload`, `_ssFmtRowKey` and the version store.

Conflating them is not a style question. Both the manual-offset and correction writes are guarded
only by a bare `if (pk)` on the line after the key is taken, so returning `_pk` ahead of the
`primaryKeys` test would start filing records under throwaway uids — unbounded garbage in two
shared files every colleague loads at boot.

`Reco.storeKey` adds a fourth clause: null when every key component is empty. With two key
columns both blank, `getRowPK` returns the string `'||'`, which is **truthy**, so `ingestData`'s
`_auto_` fallback never fires and every blank-key row in every file of that template collapses
onto one key. Blank key cells are routine on a bank or GL extract.

### 14.3 The frozen value, in one place

The grid recomputes a derived extra on every render, so after a colleague edits the shared
accounts master the key column would *print* `VEND-44` while `_pk` stayed `VEND-33` — and every
other surface is on `VEND-33`. `Reco._rowWithExtras` now returns the **frozen** component for a
key extra instead of recomputing it. That one edit is why the grid, the CSV export, every report,
the Excel view, `XlSchema.currentValue` and `Reco.displayCellValue` agree without a branch each.

`Reco.keyCellValue` does the guarded split out of `_pk`, refusing to split a storage-only key and
falling back when the part count does not match `primaryKeys.length` — because `getRowPK` joins
with `'||'` and escapes nothing. `Reco.keyDrift` paints **⚠ recalculated** on a cell whose
recomputed value disagrees with the frozen one, so the screen says when it is not showing the key.

#### AND THIS IS WHERE A PER-ROW DRIFT CHECK DIES. Read this before writing one.

**"`row._pk` disagrees with what the rule computes for this row now" is NOT evidence that the rule
moved.** A frozen `_pk` is *supposed* to disagree with a recompute **whenever the row's own data
changed**, because that is what freezing a key means — it is the whole point of this section. The
disagreement has (at least) two causes and the comparison cannot tell them apart:

| the key disagrees because | and the right answer is |
|---|---|
| the **template's key rule** changed (a formula edited, a lookup re-pointed) | the row on screen is not the row the folder holds; refuse the write |
| the **row's own data** changed — a correction, a cell edit, a fill, a replace, a carried value, a column that this month's file does not carry | **nothing is wrong at all**; the frozen key is the key, and it is what every other surface and the day file are on |

Round 6 built that comparison into the write guard (`Reco._keyRowDrifted`) and narrowed it three
times; round 7 **removed it**, because the narrowings were a list of the shapes somebody had
thought of and five more were measured in an afternoon — one of them a correction of a key-feeding
column, which is the Correction tab's whole purpose, bricking the row for every later gesture with
a sentence that blamed a colleague. §18.12 has all five and `run_store_e2e` **[86]** gates them.

**What CAN be asked honestly** is whether the key was minted by **a different RULE** — and that
needs the rule's **signature recorded on the row at mint time** (a hash of the key extras'
definitions, carried through the day file's control columns) and compared signature-to-signature,
never value-to-value. A signature says nothing whatever about the row's data, which is exactly the
distinction a value comparison cannot make. **Round 8 built it** — `Reco.keyRuleSig`, `row._pksig`,
the `_pksig` control column — and T-S10-19 is closed for a derived key. **§19** has it. Two things
about it belong in this section, because this is where a reader comes to understand what freezing a
key means:

- **the signature is over the RULE'S DEFINITION and never over the master's DATA.** A
  `master_lookup` key extra's config is in it, so re-pointing the lookup moves it; the accounts
  master's rows are not, so a colleague adding a nominal code does not. That exclusion is this
  section's own argument applied to the new control: the frozen key is the key, and the day file and
  every surface in Reco are on it. Hashing the master's rows would be a value comparison in disguise
  and would refuse every gesture on every lookup-keyed template.
- **a row with no signature is not refused.** Every row written before round 8 has none. So this
  protects rows minted after it and nothing else, and the shape where the key names **no added
  column** is not covered at all — that is **T-S10-25**, measured rather than claimed shut.

### 14.4 The mint, and the question asked before anything is written

A key extra may depend on an **earlier, eligible, non-key** extra. `Formula.substituteTokens`
turns a missing reference into `''` *silently*, so `CONCAT({Base},"-",{Line})` with `Base`
unmaterialised mints `'-1'`, `'-2'`… — thousands of rows sharing one `_pk`, `collapseToActive`
then keeps one row per key, and **a 200,000-row day file reopens as a few dozen rows**. So the
mint materialises the transitive closure in declaration order, reusing one scratch object, chunked
with the busy overlay above `BUSY_ROWS`.

**AND THE SAME SHAPE IS WHY A PER-ROW DRIFT CHECK CANNOT BE SAVED BY A "SKIP THE EMPTY ONES" RULE.**
Round 6's guard skipped a recompute that was *wholly* `''` or `'#ERR'`, and §18.11 described that as
the C6 non-firing. It is not what happens: `CONCAT({Base},"-",{Line})` minted as `'E1-S1'` when the
file carried `Base`, reopened from a file whose header does not, recomputes to the **partial**
`'E1-'` — a positive disagreement — and every gesture on that row was refused. The example in the
paragraph above is itself the counter-example. Measured and gated at `run_store_e2e` **R17c**;
§18.12 and **T-S10-21**.

Then, **before `appendUpload` writes anything**, the operator is asked once about whatever is
wrong with the minted keys — and the question is assembled worst-first:

| arm | when it is asked | why |
|---|---|---|
| a master a key component depends on is unreadable or empty | **hard refusal**, any key | identity must not depend on a file that failed to load |
| an empty or `#ERR` component | any key | a key with one empty part still *looks* like a key, so nothing later refuses those rows and they match no history. `'#ERR'` is not empty either — every row that errors shares one key |
| all parts blank | any key | they collapse onto the truthy `'||'` |
| a component containing `'||'` | any key | the stored key cannot be split back |
| **duplicates** | **a derived key only** | see below |

**The duplicate arm is deliberately scoped to a derived key.** On a key made of template columns
duplicates are a pre-existing tolerated state: ingest has always loaded them and shown the
*Duplicate primary keys* panel afterwards, and `ExcelLink` carries a whole `dupPk` badge machinery
for them. An AP or GL extract keyed on a document number with several lines per document **is**
that shape, so asking before the write would question such a reconciliation on every upload, with
Cancel loading nothing — a template nobody has touched behaving differently on Monday. On a
derived key a duplicate is new information: the formula or lookup collapsed rows that arrived
distinct. Gate: `run_pk_extras_e2e.mjs` G29, mutation-proved both ways.

### 14.5 Migration — a no-op, and the three visible changes

`primaryKeys` holds only template-column names today and the new keyable set is a superset, so
the save filter keeps exactly what it kept. Every row already carries `_pk`, `rowKey` returns it,
the mint path is not re-entered. No control column, no widened header, no CSV rewrite. Verified
byte-identical on a template-column key: the grid markup, the CSV an edit writes, the Excel
export's descriptors and per-cell values, a report's numbers, `recoSessions.json` byte order, and
`correctionMaster.json` / `manualOffsetMaster.json` on the share.

Three things **do** change on data nobody has touched, and the team should know:

1. **A key with an empty, `#ERR` or all-blank component is now questioned before the upload is
   written**, where it used to load silently and quietly match no history. Cancel loads nothing.
   This is the fix, not a regression — but it is a new question on an old template.
2. **A keyless template's corrections and manual offsets are visibly saved nowhere.** They always
   were (the write is guarded by `if (pk)` and `getRowPK` returns null), but it was silent. The
   Correction tab now says so. *(Pre-existing and unchanged: the toast still says "Correction
   applied" on a blank-key row of a keyed template while nothing is written.)*
3. **A reader that previously recomputed a different key than `_pk` now returns `_pk`.** Only
   reachable with an editable key column, `excelView.allowPkEdit` on, and an actual edit to a key
   cell. This is convergence on the key that history, the offset master, the Special JV claims and
   the posted-JV index were already using. A group or comment filed under the diverged key becomes
   unreachable from the grid; `Groups.resolvePk`'s version-file fallback resolves such an orphan
   from history.

**First template to adopt a derived key: nothing is retroactive.** The loaded session keeps its
keys; the **next upload** mints the new way and those rows do not match older history. The
existing confirm says this, and it now also fires when a key extra's **formula or config** changes
— which previously left `primaryKeys` byte-identical and said nothing while the next upload
detached history. `tplSignature` hashes the key extras' definitions (`kx`) for the same reason,
but only when the key actually names one, so an existing template keeps the signature it has.

**Downgrade** is safe-ish: the stored JSON stays readable, the old `saveTemplate` filter strips the
key the next time anyone saves that template, and the next upload mints `_auto_` keys — which is
why the empty-component warning matters, as a diagnosis.

> **ROUND 8 CHANGED THE SECOND SENTENCE OF THIS SECTION, and a reader who stops at "no control
> column, no widened header, no CSV rewrite" will now be wrong for half the templates.** T-S10-19's
> fix adds a control column, `_pksig`, to the day file — **but only for a template whose key names an
> added column.** For a template-column key, every claim above still holds exactly, byte for byte,
> and `run_pk_extras` **G1** still pins it. For a derived key: the header gains `_pksig` between
> `_by` and the template columns — **in a day file this build CREATES.**
>
> **AND THERE IS NO CSV REWRITE AT ALL, which is a round-8 REVIEW correction of what the round-8
> BUILD wrote here.** The build's own sentence said the first write into a pre-dating day file costs
> *"**one** whole-file rewrite inside `append_csv_rows` … Once per file"*, correctly naming it as the
> rewrite `Versioning._fields`'s comment warns can lose a colleague's concurrent append — and then
> pricing it as a one-off. Measured in two separate processes, that rewrite **lost a colleague's
> append in three of four timings with both writers reporting success**, and it is not once per file
> ever: today's day file belongs to whichever build writes it first, so while any colleague is on an
> older build it recurs once per template **per day**. `Versioning._appendRows` now reads the
> existing header (`Versioning._headerOf`) and, when the file has no `_pksig`, asks for neither the
> column nor the field — so rows written into a day file an un-upgraded build created land
> **unsigned**, which the migration already accepts. **No existing day file on any share is ever
> rewritten by this change.** §19.5, **[88] R19k2 / R19w**, `T-S10-28`.
>
> An older build on the same folder reads a file this one wrote, loads every row, drops `_pksig` on
> the way in and appends against the existing header with the column blank — and that blank is
> repaired on the way back IN, by `Versioning.collapseToActive` inheriting the signature of the
> newest version of the same `_pk` that has one, because otherwise one ordinary edit from an
> un-upgraded window reopened the dead-key door for that row in silence. Measured for real against
> `55171d8` at `run_store_e2e` **[88] R19l** and **R19v**. §19.
>
> **AND THERE IS EXACTLY ONE PATH THAT DOES WIDEN AN EXISTING DAY FILE — COMPACTION — WHICH THE
> ABSOLUTE TWO PARAGRAPHS UP DID NOT SAY, AND BEHIND IT WAS A HOLE IN THE SIGNATURE.** The B1 guard
> lives in `Versioning._appendRows`. `Versioning.compactFile` does not go through it: it calls
> `Versioning.writeFile`, whose `Versioning._fields` asks for `_pksig` for every derived-key
> template, so "Compact" on a pre-change day file rewrites it with the column in. **That half is
> safe and is the one route that upgrades such a file** — compaction is already a whole-file rewrite
> under the path lock, it is a deliberate operator action on one named file from Version History,
> every row it keeps carries no signature so nothing is claimed about any of them, and
> `append_csv_rows` writes against the **file's** header, so an un-upgraded build appending
> afterwards writes a blank in the column rather than a misaligned row (the direction **R19l**
> measures). **The half that was not safe:** `Versioning._hdrCache` was never invalidated by
> `writeFile`. Measured end to end — compact a pre-change file, then Add Data — `_appendRows` asked
> `Versioning._headerOf`, got the **stale narrow header** out of the cache, concluded the file had
> no `_pksig` and deleted the signature off the record. **A row the mint had signed landed unsigned
> in a file whose header carries the column**, and the reopen handed it back unsigned, so after a
> real key-rule change it is the one row that is **not** refused — the harm T-S10-19 exists for,
> arriving through the guard that was added to protect the file. One line in `writeFile` now sets
> what the cache holds (and clears it on an empty write, which leaves the file with no header at
> all). **[88] R19z** gates both halves, because a fix that stopped compaction widening at all would
> also satisfy the second one.

### 14.6 Cost

The mint at **500,000 rows** is **1,246 ms** (best of three), against a 60,000 ms budget, with the
window answering throughout (25 busy paints, worst frame gap 76 ms). A template-column key with
the same three added columns is **394 ms** — unchanged — so existing templates pay nothing.

### 14.7 Known limitations

- **`custom:*` masters as key sources** are refused until custom masters have stable uids
  (ticket).
- ~~**`saveTemplate`'s read-modify-write race now splits ROW IDENTITY, not just a column's
  values.**~~ **Closed by T-24R2-1 (§18.2).** Two colleagues editing one template's key
  concurrently used to produce version rows under two incompatible key schemes in one day file,
  with no confirm and no signature move, because the loser's clone and the stored template agreed.
  Re-measured on this tree: one upload from each of two pages wrote **eight** keys for four
  business rows before the fix and **four** after it (`run_store_e2e` S241e). The stale save is now
  **refused**, not merged — and the window is refreshed from the folder so "close it and open it
  again" is a recovery rather than a loop.
- A row typed into the grid (`+ Row`) keys on `_added_`+id, so it has no business key until the
  extract next contains it.

---

## 15. Release note — the typed-value store, the override (#26) and carry-forward (#30)

Three features, one mechanism. They are described together because they are **one store**: #26
and #30 are two answers to the question that store asks, *whose value is this and where does it
apply*. Nothing here is a second copy of anything.

### 15.1 What an operator gets

- **A value you type into an added column stays typed.** Type a vendor name, a reviewer, a
  comment code into a column you added in the template, close the app, come back tomorrow, reopen
  the file — it is still there, and it is there for your colleagues too, because it is kept on the
  shared folder against the **row key** (the invoice number, the document reference) rather than
  against the screen. It survives a **Clear Data** and reopening the day file from **Version
  History**. Manage → **Column Values** is the one screen that lists every such value with who
  typed it, when, which file and whether it is in scope, and can remove one or all the orphans.
- **#26 — a computed column you can disagree with.** Tick **Allow manual override per row** on a
  `formula`, `master` or `master_lookup` added column and people can type their own number into
  that cell. The cell shows it everywhere the computed value used to show: the grid, a report
  total, a CSV, the workbook, the Excel view **and the journal entry** — though the in-app Excel
  view shows the value without marking it as an override (T-26-1). Manage → **Manual
  Overrides** lists every one with who, when, what it replaced, what the formula says **now**, and
  **Revert**. Until the box is ticked the cell is locked and now **says why** on hover, where it
  used to say nothing at all.
- **#30 — last month's value, already filled in.** Tick **Carry this value forward to the next
  file** on a `custom` or `dropdown` column and next period's file comes up with that key's value
  already in it, marked with an accent and a tooltip naming **who typed it, what, in which file
  and when**, and a **✓** to confirm it. Confirming or re-typing clears the accent and keeps the
  value. **Off by default**, and off means a value is shown only on rows from the data set it was
  typed against.

### 15.2 The bug that started it, and what was actually reproduced

A `custom` or `dropdown` column's value is not on the row and never reaches the CSV. It lived in
`sess.manualTags`, keyed `row._id + '||' + name` — and **`row._id` is minted fresh by `U.uid()` on
every load.**

So: type a vendor name onto **400 rows**, save, reopen the file the next morning, and get **400
blanks** — with the values still sitting in `reco/recoSessions.json` on the shared folder, under
row ids that no longer existed anywhere, and nothing warning anyone. `run_store_e2e` S4 pins it.

**Reproduced from scratch on seven routes** in the verification round (`verify/v_q3.mjs`, 10/10),
because one route passing proves nothing about the one an operator takes: type six vendor names,
then (1) close and reopen the app, (2) reopen the day file from Version History, (3) Clear and
reload, (4) boot fresh with auto-load, (5) reopen from history **with the clock moved to a later
calendar day**, (6) **Add Data**, and (7) post, reverse, reopen. The values come back in every
case.

Two further reproductions behind the other two features, both measured rather than argued:
a key-scoped override read by three rows under one invoice number posted **3000** where the rows
were worth **2030**, with no warning but *"Loaded 2 rows"*; and a typed value leaking between **two
uploads on one calendar day** posted **3000** where **1000** was marked, on every template on the
share with the carry flag off.

### 15.3 The one store

`AppState.extraValueMaster[tplId][pk][colName]`, persisted as `reco/extraValueMaster.json`,
written compact, 144–148 bytes a record:

```
{ k: 'typed' | 'override',   // EXPLICIT, never inferred from the presence of `prev`
  v: String,                 // always a String
  typed: String?,            // the raw keystroke when it differed from v
  prev: String?, src: 'formula'|'lookup'?,   // k:'override' only (#26)
  ds: String,                // '<day file>#u<n>' - the UPLOAD it was entered against
  by: String, at: String }   // AppState.currentUser, ISO
```

**`k` is explicit, and it is the only thing that survives a type flip.** A column can be flipped
`formula` → `custom` in the type select with nothing cleared. After that flip `k` is what says how
to read **absence** and which panel owns the record: `k:'typed'` + empty **deletes** the record (a
tag has no computed base to reveal), while `k:'override'` + `{v:''}` is a deliberate blank that
only the revert control clears. Inferring the kind from the presence of `prev` would make an empty
override permanent.

**It is NOT in `PERSIST_KEYS`, and that is load-bearing, not an omission.** `AppState.flush`
iterates `PERSIST_KEYS` and, for any key whose serialised text changed, calls `Store.save` →
`write_file` **with the whole file, no re-read and no mtime check**. **Membership *is* the blind
overwrite.** A colleague's record written after our boot would be gone the next time we saved
anything — and once `manualTags` stops being written there is **no second copy of these values
anywhere**: no mirror on `sess`, no `Cn` row in the CSV, nothing in `reco_data/`. (**T-S10-9**
adds the one exception, and it is deliberately not on the share: an intent that has **not yet been
written** is journalled to the typing machine's own `localStorage` and cleared when its write
resolves — see §18.5. A record that landed still has exactly one copy, which is this file.) So the
key is
read in `Store.loadAll` (inheriting the `readOnlyKeys` latch and the `reco/_corrupt/` quarantine),
assigned in `AppState.load`, and written **only** through `Store.mergeWrite` — read, merge and
write **all inside one `Store._enqueue` job**, debounced 150 ms, so a 50,000-cell fill-down is one
write.

**The merge rule, and the sentence that must not come back.** For the ids a file owns, **the file
on the share is the authority** and this session's buffered intents replay on top of it
(`Store._takeDisk`); an id in memory the file does not have is **dropped**. That is safe because
the read is *inside* the queue, so it cannot predate a write of ours that already resolved. It
replaced `Store._mergeUnder` — the disk deep-merged **under** memory, on the argument that *a
local record always beats a stale read* — which **could not represent a deletion at all**: a
revert was resurrected by any other open page's next keystroke, and a delete lost to stale memory.
§5b has the full account. **A reader who "restores" the old rule reintroduces both blockers.**

### 15.4 What is refused, and what each refusal protects

Each row is a refusal somebody would otherwise meet, and the thing it protects is nameable.

| feature | refused | what that protects |
|---|---|---|
| #26 | a column nobody ticked **Allow manual override** for | the template owner's column. A workbook cannot smuggle an override into it, and the locked cell now carries a title saying how to open it |
| #26 | a row with **no usable key** | the record itself — filed under no key it could never be found again. It goes to `res.rejected` with `noPk`, never counted as applied |
| #26 | **more than one loaded row shares the `_pk`** (on the write) | a journal entry. Three AP lines under `INV-7`, one overridden to 1000, posts **3000** where the rows are worth **2030**. The count is in the message |
| #26 | an override whose key **stops naming one row** (at the **reader**, independently) | the same journal entry, for the case the write guard cannot see: next week's Add Data makes the key shared **after** the value was typed. The record is **suppressed, not deleted**, every row posts its own formula, and the *Duplicate primary keys* modal names what stopped applying |
| #26 | changing **or reverting** an override on a row **already posted to the ledger** — all four delete routes | the general ledger. The message names the accounting reference — an `AE…` reference, *not* `AEG-…`; `AEG` is the journal-template module, never an id — so the answer is *"reverse `AEMVAUQHDL7K` first"* rather than *"no"* |
| #26 | **posting an entry** that contains a non-numeric override in a column **this entry reads**, *or* one that turned a numeric cell non-numeric | the ledger again, by name: the key, the column, the characters and what they replaced — and, when what it replaced was not a number either, *why the cell still counts*. Nothing is built. **MR-1 widened this**: the `rec.prev`-was-numeric arm alone let an override of an `#ERR` cell through, which is the one cell Z1 refuses over. See §5c |
| **Z1** | **posting an entry** in which a formula the linked AEG template *reads* could not be worked out (`#ERR`) | the ledger, by the amount. `U.num('#ERR')` is **0**, so the cell the grid, the reports, the CSV and the workbook all show as `#ERR` used to contribute a **silent zero** to a posted figure and its row was stamped `Posted` with no line behind it. Named: the key, the column and the formula. Scoped to the columns the entry reads, and judged **pre-filter** for the keyword column — see §16 |
| #26 | assigning a column that still **holds override records** as an AEG control column — box ticked or not | whether a row posts at all. Two silent edits (untick, then assign) once posted **1007** where **7** was marked. The untick itself says how many records keep applying |
| #30 | a **carry-flagged** column as any AEG control column — the **keyword**, **post-entry** or **To Account** column, or a linked AEG template's **input**, **From Account**, **To Account** or **club-by** column — in both editors and both directions | an account code and a row's posting. The AEG extras loop runs **before** the keyword filter, so a carried value there would decide whether a row posts at all |
| #30 | the carry box at all on a template with **no primary keys** (disabled, with its reason) and on a **computed** column (absent — it has #26's box instead) | a record that could never be read back, and a column with two owners |
| both | a write to a `reco/extraValues/*.json` that **could not be read** at boot | a colleague's record. One template must never have two homes, or the older copy replaces somebody's work when the share recovers. Per **file**, so one damaged template does not stop the team typing |
| both | a record for a `_ssSingleUse` spreadsheet column | an orphan on the share for ever under a name nothing can show |
| `k:'typed'` only | a row whose data set cannot be named | a file-scoped record that could never be read back. An **override** is key-scoped, so it needs no data set and stores `ds: ''` rather than refusing |
| **MR-6** | **Generate** at all, while `reco/entryHistory.json` **could not be read at boot** | every entry already in that file. Nothing is written to a ledger this window cannot see, so generating cannot stamp rows `POSTED` on the share with no journal entry behind them. The modal says to repair the file (a copy is in `reco/_corrupt/`) and reopen; the selection is kept |
| **MR-7** | a **document number another entry already holds** — tested in memory *and again inside the merge intent*, on the file the merge has just read | the resolver. `Reco._postedRefFor` reads the shared master, not the entry's own field, so two entries under one number resolve a row to the **wrong** accounting reference. Two colleagues could both be told *"Document numbers saved"* |
| **§12** | a **reversal** whose entry's **document numbers changed** on the share while the dialog was open | the cancel-or-contra decision itself, which turns on exactly that fact. The entry is **not** marked, the rows are released, and the message prints both readings side by side |
| **T-S10-11** | *nothing* — this one is a **re-mint**, not a refusal | an entry whose accounting reference a colleague minted in the same millisecond is recorded under a **new** reference rather than dropped, and the operator is told which. See §17 |

### 15.5 The cost, measured

All re-measured on this tree in the verification round, local disk through the test bridge, best of
three taking the minimum.

| | measured |
|---|---|
| one file, 2,000 records | 287,797 B · boot 533 ms · the read a merge write performs 10 ms · one merge write end to end 35 ms |
| one file, 50,000 records | 7,327,799 B · boot 804 ms · 208 ms · 620 ms |
| one file, 200,000 records | 29,577,801 B · boot 1,848 ms · 837 ms · 2,418 ms |
| per record | 144–148 bytes; all records load at boot at every size |
| one override at 200,000 rows, cached schema | **2.893 ms** (reviewer A measured 1.41 ms on the same code). The **0.1 ms** this file used to claim was 29x optimistic |
| one override at 500,000 rows, warm duplicate-key memo | 0.017 ms — the memo build is the cost, not the override |
| a 50,000-cell fill-down | 338–526 ms to apply, 869–1,721 ms to settle, `{applied: 50000, rejected: 0}`, **one** `write_file`, 6.84 MB written once, ~29 animation frames during the burst |
| `recoSessions.json` writes caused by an override | **none** |
| **`XlSchema.build`, 200k rows, template holds ≥ 1 record** | **60.8 ms**, against **3.4 ms** at `4b8fd90` — an 18x regression |
| `XlSchema.build`, 200k rows, template holds **no** records | 3.7 ms vs 3.0 ms — unchanged |

**The `XlSchema.build` regression is in this table because §5c's cost argument rests on that
function being cheap, and it no longer is.** F6 scoped the store walk to the keys of the rows being
exported, which fixed a real money bug — one stale record under an unloaded key had been
downgrading a whole numeric column to text, so 2,000 good numbers reached a colleague's workbook as
strings and their SUM read 0 — but the key `Set` is O(rows) and `rows = opts.rows || sess.data`, so
**any** template holding even one record pays it once per build.

| caller | safe or pays |
|---|---|
| the grid's two override handlers | **safe** — they pass the cached `Reco._ovSchema` |
| `Reco.columnCatalog` (the column pickers) | **safe** — it passes `rows: []` |
| a template with **no** records, anywhere | **safe** — the walk is lazy and never runs |
| the **export** schema | **pays** |
| the **editor** schema | **pays** |
| `ExcelLink.diff` — the **load-back plan** | **pays** |
| `Reco._reversePlan` — the **reversal plan** | **pays** |
| any **`applyEdits`** caller that passes no `schema` | **pays** |

60 ms on a one-off action is tolerable and nothing that pays is on a keystroke path. **T-26-7**
carries it, which is why it is named here rather than left in a probe log.

**Where this stops being usable: about 50,000 records per file** (`Store.VALUE_FILE_CEILING`). The
limit is the share, not the CPU: at 200,000 records one merge write is 2.4 s of local work **plus
the whole 29.6 MB crossing the wire twice** — roughly 6 s at 10 MB/s — for every 150 ms typing
burst, and `Store._enqueue` serialises per file, so bursts queue behind each other and two
colleagues typing are each moving 30 MB a burst.

**Verified, as opposed to argued — AT THE TIME THIS WAS WRITTEN, which is the point of the
sentence and not a reason to trust the number today.** On the tree this section measured,
`run_store_e2e` was 378 passed / 0 failed and the **seventeen** node suites totalled **2,574**
end-to-end checks (378 + 304 + 254 + 250 + 170 + 163 + 147 + 123 + 119 + 107 + 107 + 100 + 94 + 79
+ 73 + 65 + 41), with `pytest` — the eighteenth suite — at 75 passed / 1 skipped. Every suite was
at or above its `4b8fd90` count; not one went down.

> **CURRENT, re-measured on this tree:** `run_store_e2e` **743**, the seventeen node suites
> **2,941**, `pytest` **83 passed / 1 skipped**. Store went 378 → 441 → 508 → 582 → 598 → 638 →
> 672 → 694 across the money round and the seven data-loss rounds (§16, §18), then 714 → 724 → 726
> across round 8's build, its review pass and the cleanup round (§19, §19.8, §19.9), then **731**
> with the bridge round's [89] (§20) and **743** with T-26-11's [90] (§21). `pytest` went 75 → 83 in that last round, which is the first
> time it moved in nine rounds: the losses it closes are CROSS-PROCESS, and pytest is the only
> suite that can run two processes. **The cost table above was
> NOT re-measured on this tree** — the figures in it are from the tree that produced the 378, and
> `XlSchema.build`'s 18x regression (T-26-7) is still open, so they are the right order of
> magnitude and the wrong decimal. Re-measure before resting an argument on one; §16.4a is the rule
> for how (an operation count, never a wall clock). The store gate was also shown
**non-vacuous** by mutation: `Reco._manualTag` forced to return `''` in a **copy** of `Reco.html`
turns `run_reports_e2e` red (105/2), which is what proves the legacy read fallback is load-bearing
rather than decorative.

### 15.6 Known limitations

Named as plainly as the rest, because every one of these is reachable by an operator.

- ~~**A value typed while the shared folder is down is in this window's memory only.**~~
  **Closed by T-S10-9 (§18.5).** The intents are still buffered and retried on a widening gap
  (300 / 600 / 1,200 / 2,400 ms), the operator is still told while they are typing, and both doors
  out still ask — but there is now a **second copy on this PC**. Each unwritten intent is
  journalled to `localStorage` as it is buffered and cleared when its write resolves, and the next
  boot **offers the replay by count, naming the cells**, through the same merge write. The replay
  carries a **per-cell timestamp guard**: an intent is applied only where the share holds no record
  for that cell or holds one whose `at` is **older**, and every cell skipped is named with who holds
  the newer value and what it says. The journal never reaches the share — what is owed to the folder
  is owed by this machine — and each entry carries the base folder it was typed against, so a
  journal belonging to another folder is **kept on this PC and named, not replayed and not
  deleted**: *"They are STILL KEPT on this PC — point Reco back at that folder and they go on
  it."* (This sentence said "discarded rather than replayed" until round 5. That was the state
  **before** finding B2: `journalClear()` took no argument, so the boot that refused to replay a
  journal **deleted** it — in the worst case with nothing said at all. `journalClear(keep)` now
  takes a predicate and clears only what it consumed. A base the launcher cannot report is treated
  as **UNKNOWN** and the journal is left alone, rather than read as a different folder.)
  `run_store_e2e` section
  [68] (S109a–S109l) is the gate, and it tests the **losing** case as hard as the winning one.
  **What the operator is told changed with it:** the leave gate no longer says "lose them" about
  values it is keeping.
- **A row whose key is no longer the key this reconciliation works out cannot be written against —
  and the way out is Clear Loaded Data, not Add Data.** Two things put you in that state. One: a
  colleague changes how the reconciliation works out its row keys while you have rows loaded, and
  your save is refused (T-24R2-1). Two: you open a day file from Version History that was **written
  before** such a change, which hands those rows back under the keys that file holds — in any
  window, including the one that made the change, with nothing wrong anywhere (**T-S10-19**).
  **BOTH CASES ARE NOW REFUSED, and case two took three rounds to get right.** The
  colleague's-key-change latch covers case one exactly: it is recorded when the definition changes,
  which is a fact about the template. Case two — the day file written before the change — is
  invisible to it, and the round-6 fix for it (comparing each row's stored key against a fresh
  recompute) was removed because that comparison cannot tell *"the rule moved"* from *"this row's
  own data moved"*, and refused five measured pieces of ordinary work. **Round 8 answers case two
  with the key rule's SIGNATURE**, recorded on the row when its key is minted and carried through
  the day file: a row whose signature is not the one this reconciliation's rule has now cannot be
  written against, and a row with **no** signature — every row saved before round 8 — can. So the
  protection is real for anything saved from round 8 onwards and is still only advice for anything
  older. `run_store_e2e` **[84] R15d/R15e** and **[88]** are the gates; **T-S10-19** is closed and
  **T-S10-25** carries the one shape left (a key that names no added column, whose component LIST is
  later edited).
  **AND HERE IS THE PART THE ROUND-8 BUILD DID NOT SAY TO THE OPERATOR, WHICH IS THE FIX'S REAL
  BLAST RADIUS: a key-rule change makes EVERY EARLIER DAY FILE of that reconciliation read-only.**
  Not just today's. Nobody can tag a vendor, record a correction, mark an offset, edit a cell or
  group a row on any day file written under the previous rule, in any window, for ever — because
  nothing re-keys a saved file and reopening it brings the old keys back every time. **The recovery
  that EXISTS** is Clear Loaded Data and then load **that day's extract** again: those rows come
  back re-keyed under the rule in force now, into today's file, and the work can be filed against
  them. *"Clear Loaded Data and load the extract again"* on its own is **not** advice for an older
  day file — it loads TODAY's extract, which is a different day's rows, and the round-8 build's
  refusal sentence said it anyway and was measured sending an operator round a loop with nothing
  filed at the end of it. **Before changing how a reconciliation works out its row keys, be as sure
  as you would be about anything on this list**, because the month's finished day files stop taking
  work the moment you press OK on that confirm. **How much of the screen is affected is visible**:
  a refused row carries a **⊘ older rule** badge, so the two copies of one business row can be told
  apart before you type into either.
  For case one: **nothing can be filed against such a row**, and the refusal says which verb did
  not happen. **This is a rule and not a list of controls**, which matters because the list was
  wrong four rounds running: the question is asked at the WRITE, by the one pair of functions
  through which a row becomes a key for a record the shared folder holds, so a control nobody
  thought of is covered on the day it is written (**T-S10-20, §18.11**). Nothing you had already
  filed is deleted, and nothing is lost — what you type against such a row would have gone to the
  shared folder under a key nobody else works out, which is the loss this refuses. **The recovery
  is Clear Loaded Data and then load the extract again**: "Add Data" ADDS to what is on screen, so
  those rows would keep their old keys and the refusal would stay. Your typed values, offsets and
  corrections are kept on the shared folder throughout — the Clear confirm says which.
  **T-S10-16, T-S10-18, T-S10-19, T-S10-20 (§18.9, §18.10, §18.11).**
  **Two things are worth knowing about the shape of this.**
  (a) **A reopened day file shows the same business row TWICE**, once under the key the file holds
  and once under the key the extract mints, with the key cell showing the stored one (§14.3) so
  neither copy looks unusual. The live copy works normally; the one from the file is refused.
  **THIS ADVICE CHANGED IN ROUND 8 AND THE CORRECTION IS THE USEFUL PART.** It used to read *"do
  not type into that copy" is the whole of the advice*, which put the whole of the protection on the
  operator noticing which of two identical-looking rows was which — and the rows are
  identical-looking **by design**, because the key cell shows the frozen value. **You do not have to
  tell them apart any more.** If a row came out of a day file written before the rule changed, the
  app refuses the write itself and says so in its own words: *"This row came back from a saved day
  file and its key was minted under a DIFFERENT row-key rule from the one in force now … Opening
  that day file again will keep bringing the old keys back — nothing re-keys a saved file. To
  record this against the row, use Clear Loaded Data and then load that day's EXTRACT again …
  Every day file this reconciliation wrote under the previous rule is read-only in the same way."*
  Nothing is filed, nothing is half-done, and the sentence names the verb that did not happen.
  **THAT IS NOT THE SENTENCE THE ROUND-8 BUILD WROTE, AND THE TWO CLAIMS IT LOST ARE WHY THIS
  PARAGRAPH IS WORTH READING TWICE.** The build's version said the file *"was **written before**
  this reconciliation's row-key rule was changed"* and added *"**Nobody has changed anything** while
  you had these rows open: the file is simply older than the rule."* Neither is sayable here. The
  direction is not knowable — a backup restore puts an OLDER rule back under a NEWER day file — and
  "nobody has changed anything" is reachable by the operator's **own** template save, over rows the
  upload minted in that window that no file ever handed back, which is exactly the claim round 7
  deleted a sentence for. Both halves are now asserted **absent** from all three branches
  (`run_store_e2e` **[88] R19u2**, **R19f**); if you find either of them on a screen, the gate has
  been removed. **Two things it is still worth knowing.** It only works for rows saved from round 8
  onwards: a day file older than that carries no signature and its rows are still writable under
  their old keys, so for an old file the advice above is still the whole of it. And the recovery is
  **that day's extract and not today's** — Clear Loaded Data, then load the extract **for the day
  that file covers**, which is the correction the paragraph above this one is about.
  (b) **A control that writes EVERY row on screen is refused as a whole, and after round 8 that
  costs something again on one screen only — the reopened day file.** sheet mode's "↓ Fill Column"
  and the Find dialog's "↻ Replace All" write every row in the filtered view, so if any row in it
  came out of a file older than the rule the whole control is refused with one sentence.
  **That screen is exactly the one the advice in (a) is telling you to leave**, so the refusal and
  the advice agree; the recovery is Clear Loaded Data and load the extract again, after which the
  view holds nothing older than the rule and the controls work normally. *"Replaced 0 of 2,000"* and
  a silent per-row skip are both worse than one sentence, which is why it is all-or-none.
  **WHAT THIS PARAGRAPH IS NOT SAYING, because it said the opposite twice:** an ordinary edit,
  correction, fill or carried value **never** causes this. Round 6 refused the whole view whenever
  one row's own DATA had moved — one correction was enough — and that cost is gone and stays gone:
  `run_store_e2e` **[86] R17b** measures a corrected row NOT refusing "↻ Replace All" for the file.
  The round-8 trigger is a row whose key was minted by a **different rule**, which only a reopened
  pre-change day file (or a partial restore) puts on screen. Gates: **[84] R15g** and **[88] R19h**
  for the cost, **[86] R17b** for the thing it is not. §18.12, §19.
  **And one case that USED to be called a deliberate non-firing is no longer a special case at
  all:** where a key column is a lookup into a shared master, a colleague editing that master does
  not change how the key is worked out — the key stays what it was, the day file holds it, and
  every screen in Reco is on it by design (§14.3). That was the first measured false positive of a
  per-row value comparison, and with no such comparison in the guard it needs no exception; it is
  kept as a gate (**R15i**) because it is the cheapest tripwire against one being re-added.
- **A damaged `reco/extraValues/<tplId>.json` still refuses the write** — rather than rerouting
  it, which is the right trade (a template with two homes loses work when the share recovers).
  Since **T-S10-9** the value typed into that template while the file is broken is no longer lost
  with it: the refusal resolves not-written, so the intent stays in this PC's journal and is
  offered again at the next boot. It will go on being refused until the file is repaired, which is
  correct — it is still owed. **T-S10-6.**
- **A posted row whose key LATER becomes duplicated keeps the override in the ledger while the
  screen stops showing it — and the panel now says so by name (T-26-6, §16).** The state is
  unchanged; what changed is that it is no longer silent. The new reader guard is what does this: it suppresses a record whose
  key no longer names one row, so the reports, the CSV and the workbook fall back to the computed
  value while the entry already posted still carries the typed one — the ledger holds 1000 and
  the screen reads 20. It is the one case where §5c's *"the screen and the journal cannot
  disagree"* does not hold, and it is the price of the guard rather than a defect in it.
  **T-26-6.**
- ~~**The one-time promotion picks a winner on a duplicate key, silently.**~~ **Closed by
  T-30-3 (§16).** The promotion no longer picks: a key whose rows hold two *different* legacy
  values is left alone, both values stay in `sess.manualTags`, the keys are named in one confirm
  before anything is written, and declining it promotes nothing. A duplicate key whose rows hold
  the *same* value is not a conflict — there is nothing to pick between, and one record serving
  both rows is the feature.
- **The in-app Excel view marks neither an override nor a carried cell.** The value is right
  there — it is the mark that is missing, so in that one surface a typed value is
  indistinguishable from a computed one. **T-26-1** and **T-30-2**.
- **Past about 50,000 records a template's values want their own file**, and the remedy is a **boot
  message**, not a control: it names the file, the record count, the MB and the biggest template,
  and somebody with folder access moves that template's JSON into `reco/extraValues/<tplId>.json`,
  which Reco reads at startup and writes to from then on. Nothing converts anything automatically.
  **And nothing prunes records whose key is in no file**, so a share grows towards the ceiling and
  never comes back — **T-S10-3**, which a team heading past the ceiling should have first.
- **A non-numeric override still reads as a number in a report TOTAL** — 101.2345 for three rows
  worth 100, measured on this tree. It can no longer be **posted** (§5c), which is why it is a
  ticket and not a blocker, but it is a wrong number on a screen beside the characters it came
  from. **T-26-5.**
- **An AEG left holding `keywordValues` with no `keywordColumn` posts every row.** That is the
  state #26's new role refusal leaves an operator in if they ignore the toast. The AEG never had
  that validation, so it is not a regression of these features — but following the refusal now
  reaches it. **T-26-8.**
- ~~**Two colleagues saving one template at once no longer lose a carry/override flag — WHILE
  THIS SESSION OWES THE SHARE NOTHING.**~~ **Generalised and the skip deleted by T-S10-7
  (§18.1).** Every template field the editor did not touch now keeps the folder's value, not just
  the two flags, and the `AppState.pendingCount() === 0` skip is gone: C6h's hazard is real, but
  the condition for it is a write owed **for `reco/recoTemplates.json`**, and `pendingCount()`
  also answers yes for a typed cell value in a different file — so the reconciliation sat out
  exactly the case where the operator had just typed. An owed templates write is now **landed
  first** (`RecoTemplate._tplWriteOwed`, which compares against `AppState._snap`) and the read then
  describes the share. The shape below is still worth knowing before anyone reorders those lines.
  The reconciliation
  against the share runs **before** `AppState.save()`, not after it, and `saveTemplate` returns the
  guard so a caller that wants the settled state can `await` it. Doing it the other way round made
  the flag-less write a **race** rather than a bug: `save()` is a 250 ms debounce, so if the folder
  answered inside 250 ms there was one correct write, and if it did not there were **two — the
  first of them wrong, and readable by anyone booting in between**. Measured 5 times out of 5 on
  the slow side: the share held the flag-less template the instant the other page's awaited flush
  returned, and was repaired ~2.5 s later. Reconciling first removes the window instead of
  narrowing it, and makes it one write. Everything above that line stays **synchronous**, the swap
  included, so a caller that saves a template and reads `AppState.recoTemplates` on the next line
  is unaffected. `run_store_e2e` section [45] (X5a–X5d) is the gate, and it is green — including
  the two controls, that B's own edits are still saved and that a flag B **did** untick is still
  turned off, so the share wins only for a setting that editor never touched. **What was not
  re-run:** the reviewer's own `skB/p6b_promote.mjs` P6j, which measured the old window. The
  suite's gate is what stands behind this line.
- ~~**The share is still read once, at boot, for everything except this.**~~ **Closed by
  T-S10-7 and T-24R2-1 (§18.1, §18.2).** `AppState.recoTemplates` is still loaded once at boot and
  the editor still deep-clones on open — what changed is that `saveTemplate` **re-reads the stored
  template off the share** before its write and merges field by field against
  `RecoTemplate._openedWith`. A **key-definition** difference is the one case that does not merge:
  it **refuses** the save (T-24R2-1), because silently keeping the folder's key rule under a save
  the operator believes succeeded leaves their next upload minting under a scheme they never chose.
  **What is still true:** the swap stays **synchronous** and happens before the folder answers, so
  the merge and the refusal both run after it — which is why `RecoTemplate._abandonSave` puts the
  **folder's** template back and closes the editor, rather than restoring this window's stale one.
- **The flag change is per template, not retroactive per value.** Ticking carry-forward promotes
  the values currently on screen once (`Reco._promoteCarryForward`), which is what makes the box
  mean something the day it is ticked; **unticking leaves stored records applying** — silently
  recomputing a number a preparer signed off is the worse of the two, and the untick says how many
  keep applying.
- **The Clear confirm over-promises.** It says the kept values come back "when a file with those
  keys is loaded again"; with carry off, the file that brings them back is the day file reopened
  from Version History, not a different extract uploaded the same day. **T-30-4.**
- **A flat `pk + '||' + col` ambiguity remains one level up.** Nesting the store fixed the second
  join; `getRowPK` still joins key components with `'||'` and escapes nothing. **T-24R2-5.**
- **There are FOUR byte-identity baselines, not five**, and the record should say four:
  `run_colorder_e2e` `76dffed`, `run_pk_extras_e2e` `3047f82`, `run_correction_e2e` `d9957fc`,
  `run_panes_e2e` `5f61d76` — every one resolving under `git rev-parse` and actually passed to
  `makeRoot`. The review round found a fifth **declared and never read** in `run_store_e2e`, which
  both fixers' reports counted as a gate; it was deleted in `a824485`, so "five baselines, all
  pinned" was never true and is no longer even arguable. **The remaining caveat is real:** all four
  are **abbreviated** SHAs, which stay unambiguous only while the repo is small. No gate tracks a
  moving ref — `grep -rnE "BASE_REV *= *process.env.BASE_REV *\|\| *'(HEAD|main|origin)"
  tests/e2e/*.mjs` is empty, which is F14's fix holding.
- **`pytest` and `run_panes_e2e` read the temp root's path shape** through the Excel-link engine's
  local-vs-shared and `pathTooLong` logic. With `TMPDIR` on a long path they come back 69/6 and
  163/1-plus-a-crash; with the default root they are 75 passed 1 skipped and 304/0. Anyone
  measuring a count from a contained temp root will see a regression that is not there.
  **T-S10-8.**

---

## 16. The money round — Z1, T-26-5, T-26-6, T-S10-1, T-30-3

Five tickets, picked because each one either puts a **wrong number into a journal entry or a
shared master** or **silently destroys somebody's work**. Gates: `run_store_e2e` sections
[49]–[53], 42 checks.

### 16.1 Z1 — a broken formula posted a SILENT ZERO, and here is it happening

Deferred across three rounds with *"raise its priority"* each time, and never reproduced. It is
now reproduced, on the build before the fix
(`scratchpad/money/out/z1_repro_before.txt`, and `run_store_e2e` section [49] re-measures the
figure in the same run rather than quoting it):

> An added `formula` column **`AED = NUM({Base})/NUM({Rate})`** — an FC-to-AED conversion, and
> `AED` is already the name of the default AEG template's `valueColumn` *and* one of its input
> columns, so the template links with no re-mapping at all. Three rows: `INV-1` Base 100 Rate 2,
> `INV-2` Base 300 Rate 3, **`INV-3` Base 500 Rate 0** — a blank or zero rate on one line of an
> FX extract is ordinary weather.
>
> | the same cell, `INV-3 / AED` | reads |
> |---|---|
> | the grid (off the DOM it drew) | `#ERR` |
> | `Reco._extraValueForRow` — the one read ladder | `#ERR` |
> | the report cell | `#ERR` |
> | the CSV export | `#ERR` |
> | the real workbook cell | `#ERR` |
> | **the AEG source row the journal is built from** | **`#ERR`** |
>
> **POSTED ENTRY `AEMVAUQHDL`, lines Dr 150.00 / Cr 150.00**, `postedPks` =
> `["INV-1","INV-2","INV-3"]`, every row stamped `POSTED`, and the only thing on screen was
> *"Entry AEMVAUQHDL generated (2 lines)"*. `INV-1` is worth 50 and `INV-2` is worth 100, so the
> **largest of the three invoices contributed nothing** and was closed anyway. Un-aggregated the
> same fixture posts four lines totalling 150 and `INV-3` gets **no line at all** while still
> being stamped and still being in `postedPks`.

**THE TICKET'S OWN MECHANISM IS NOT THE ONE THAT BITES, and this is the finding.** The AEG
source-row loop's `catch(e) { r[ac.name] = ''; }` — the `''`-vs-`'#ERR'` divergence the loop's
comment, this document and the ticket all name — is **unreachable**: `Formula.evaluate` catches on
**both** of its paths (the compiled one and the text-substitution fallback) and *returns* `'#ERR'`.
So the loop was already answering exactly what the grid shows, and the divergence had never posted
anything. What posted the zero is **`U.num('#ERR') === 0`** inside `Reco._buildEntryLines`.

**The shape chosen, and why.** Both candidates were built, and only one of them is the fix:

- **(a) make the loop answer `'#ERR'`.** Done — but on its own it fixes **nothing**:
  `U.num('#ERR')` is 0 just as `U.num('')` is, so the entry posts the same zero with the grid
  merely agreeing about the cell. It is kept for exactly one reason: it leaves the refusal **one
  sentinel to key on**. If a later change ever does make `evaluate()` throw, `''` is
  indistinguishable from *"this column has no value"* and the refusal would silently stop firing.
- **(b) REFUSE the posting**, at RC-8's door — `Reco.previewEntryFromSelection`, the one way into
  entry history — naming the key, the column and the formula. A wrong number in a ledger is worse
  than a blocked entry, and this app's rule is to refuse rather than guess wherever two readings
  are possible: `#ERR` could mean 0 or *"nobody knows yet"*, and the app cannot tell. **There is
  no honest guess available**: the last good value is not in the file, the formula is not
  invertible, and dropping the row would post an entry quietly smaller than the selection the
  operator ticked, which is the harm rather than the remedy.

**The scope is narrow on purpose**, because refusing on every `#ERR` anywhere would change what
every existing template can post — the objection **T-26-4** was deferred for. Only a column the
entry **reads** counts: an AEG input column by `name` *or* by `label`, the `valueColumn`, an
`aggregateBy`, either account `inputColumn`, the keyword column, or the template's own
`valueColumn` (the fallback when the AEG value field comes back blank). A broken formula in a
column the linked template never reads does **not** refuse (`Z1h`, with the figure unchanged).
Deliberately **not** in the set: the **post-entry column** — it is not an amount, not an account,
does not decide whether a row posts, and a cancel restoring `#ERR` into a cell whose formula
already says `#ERR` changes nothing.

**The keyword column is judged BEFORE the filter**, and it is the one place RC-8's *"after the
keyword filter, deliberately"* is the wrong rule. For an override, a row the filter dropped is not
in the entry and refusing over it would be a refusal about a row nobody is posting. For the
keyword column **the failure is what dropped the row**: the cell could not be worked out, so the
filter could not match it, so the row silently did not post (`Z1i`/`Z1j`). Every other column is
judged on the surviving rows.

### 16.2 T-26-5 — a total that is not the sum of the column it is under

RC-8 keeps a non-numeric override out of the ledger; it could still reach a **screen total**. The
shipped total row was already guarded by `U.isNumeric`, so with `Net` typed over as `1.234,50`
the total read **100** for a column showing 40, 60 and `1.234,50` — **and said nothing about the
cell it had dropped**. Reviewer A's naive reading of the same column is **101.2345**
(`scratchpad/store/fix/p3.out`), which is what every other `U.num` reader of it still gives.

`Reco._reportColumnTotal(rows, col)` is now the one place the arithmetic lives and returns
`{sum, excluded, samples}`; the total cell carries `data-total-sum` / `data-total-excluded` and a
`*`, and the report footer names the count, the column and the characters. **A blank cell is not
"not a number"** and is not counted — it has always been out of every total, nobody reads an empty
cell as an amount, and counting it would put a warning under every sparse column in the app,
including a deliberately blank override. Controls: `1,234.50` is canonicalised by `_setOverride`
to `1234.5` and is **fully** in the total with no footnote; an empty override likewise.

### 16.3 T-26-6 — the duplicate-key panel names what is already in the ledger

RC-6's suppression stands: an override whose key stops naming one row is not served, because the
alternative multiplies a number into a **new** entry. Where that key had already been **posted**,
the ledger holds the typed value and the screen falls back to the computed one — measured here as
**ledger 1000, screen 20**. The *Duplicate primary keys* panel now carries a second block
(`data-dup-posted`) naming those keys, the column, the amount the ledger holds and the
**accounting reference**, from `Reco._postedRefForPk` — which answers from the key alone and is
never `weak`, so a key with no reference gets no sentence rather than a guess. A reversed entry is
marked as such, because telling somebody to reverse it twice would be wrong.

### 16.4 T-S10-1 — the ledger's own two files now merge-write

`entryHistory` and `docNumberMaster` left `PERSIST_KEYS`, are assigned in `AppState.load` as the
values store is, and every write goes through **`AppState.ledgerFlush(key, mutate)` →
`Store.mergeWrite(key, mutate, {depth: 0})`** — `depth: 0` because the top-level value of each is
one template's *array* of entries and one template's *map* of document numbers, and the template
is the unit a race happens in. Reproduced before the fix: two pages on one share, A posts, B
(booted before A's entry existed) posts, and **`reco/entryHistory.json` held one accountingId out
of two**, both ways round.

The nine write sites: `commitEntryFromPreview` (the append — **keyed on `idNonce` since
T-S10-11, not on `accountingId`**, because two windows can mint one reference and a skip on the
reference alone discarded one of the two entries; see §17), `Reco.saveAllocation` (both keys), `Reco.removeDocNumber` (new — it was an
inline `delete` in an `onclick` followed by `AppState.save()`, which would no longer have written
anything), `RecoTemplate.remove`, `App.importBackup`, `Reco.restoreSession`, and `reverseEntry`
(the mark, the mirror, the `reversalCancelled` note and the freed document numbers).

> **THE RULE A FUTURE READER CANNOT GUESS: an intent must re-find what it mutates, by id.**
> `Store._takeDisk` replaces `AppState[key][tplId]` with the object just read off the share, so
> an intent that closes over an entry taken *before* that read mutates a detached copy and writes
> nothing at all. Every intent looks its entry up by `accountingId` in the map it is handed, and
> every one is idempotent, because a failed write leaves the intent buffered for the next job.
>
> **And the same rule binds the TESTS.** Changing `AppState.entryHistory` in memory is no longer
> changing what the app will read — the next merge write puts the share's copy back, which is
> precisely what stops a stale page clobbering a colleague. `run_reverse_e2e` and
> `run_specialjv_e2e` had six fixtures that simulated a state *on the share* by mutating the map
> in memory and relying on `reverseEntry`'s step-3 whole-file flush to publish it; that flush was
> itself part of the clobber. Both suites now have a `publishLedger(page)` helper and call it
> after those mutations. **No assertion in either file changed** by that work — `run_specialjv_e2e`
> is still at 123/0, and `run_reverse_e2e` is at 255/0 after the MR-3 gate was rewritten (below).

`AppState.adoptLedger(key, next)` replaces a map's *contents* in place (via `Store._takeDisk`)
because `reverseEntry` used to reassign `AppState.entryHistory` outright three times, which would
have left a buffered intent pointing at the old object.

> **WHAT THIS DOES *NOT* CLOSE, because this file has claimed otherwise once already.** The
> **boot-time** half of the clobber is gone. Two halves remain:
> 1. **Cross-page, T-S10-10.** The merge write is atomic within one page (`Store._enqueue`) and
>    **not between pages** — there is no compare-and-swap in the bridge's `write_file` and no lock
>    file. Two people writing within one read-write cycle of each other still produce a file
>    holding one of the two entries, and the loser's write **succeeded**. The window is measured
>    at **100–250 ms** for a 2.2 MB history on local disk, and proportionally longer over the
>    wire. `_confirmEntryOnShare` and `_reSettleEntry` heal what lands inside the settle and
>    **say so when they cannot**; a clobber after that look is still invisible. The complete fix
>    is a **write-if-unchanged in the Python bridge**, which no round has been allowed to edit.
> 2. **A mixed fleet, T-S10-12.** An un-upgraded copy of the app on the same folder still writes
>    `reco/entryHistory.json` and `reco/docNumberMaster.json` as **whole files with no re-read**,
>    so it keeps destroying colleagues' entries while the fix appears to work for everyone else —
>    and because this build refreshes memory on every write, it reads as *intermittent* rather
>    than attributable to one machine. Measured on one share root with `apps/Reco.html` swapped
>    between builds. **Every copy of the app on the folder has to be on this build** before the
>    T-S10-1 fix holds. A build stamp written into `reco/` at boot, warning when an older stamp
>    is seen, would make that enforceable instead of a request.

### 16.4a MR-3's gate is an operation count, not a clock

> **Round 7 note.** The dead-key guard's own cost gate (`run_store_e2e` **[85]**, R16a–R16c) is
> built on this section's rule and its reading changed when the per-row arm came out: the question
> is now `Reco._keyStale[tpl.id]` and nothing else, so a formula-keyed template pays **zero**
> recomputes on every write path, where round 6 paid 4,110 for 4,000 questions at 2,000 rows. The
> counter that proves the question was asked at all (`questionsAsked >= rows`) is kept beside it,
> because a cost of zero is also what a guard that never runs costs. §18.12.
>
> **Round 8 note.** T-S10-19's signature arm is counted the same way, by the same rule, and the
> count is in the app rather than in the test: `Reco._keySigComputed` is incremented only when
> `keyRuleSig` actually walks the canonical JSON and hashes it, so **[85] R16d** and **[88] R19j2**
> both read a number instead of a duration. It is **0** across 2,000 guarded writes — one per mint
> pass and nothing after it — because the answer is cached against the template object and against
> the identity of `primaryKeys` and `additionalColumns`, which `saveTemplate` replaces, so the cache
> cannot outlive an edit. The per-write cost is a `WeakMap` get and two identity compares. That measurement is also the answer
> to T-S10-19's open question (a): *"skipping it keeps the cost at one property read"* turned out to
> be weighing a WeakMap get against a property read, so the question was decided on the day file's
> header width instead, which is a real cost. §19.
>
> **Round 8's review pass priced the one cost that note left out, and it is the biggest of them.**
> The signature is stored **per row** in `sess.data`, and `reco/recoSessions.json` is the file this
> app rewrites wholesale on a 250 ms timer and ships to the shared folder. Measured through the real
> serialiser, with and without the field: `Store.serialize('recoSessions', …)` is **21,467,287**
> bytes with `_pksig` and **15,467,287** without at 200,000 rows — **+6.0 MB, exactly 30 bytes a
> row** (`,"_pksig":"1:4da9a4e41e8f2d20"`) — and **54,167,287 vs 39,167,287 at 500,000**, so
> **+15.0 MB**. §14.6 already calls an 85 MiB serialise at 200,000 rows a problem; this is roughly a
> 7% tax on the slowest shared write in the product, on every save. The day file costs **19 bytes a
> signed row** and **1 byte** per pre-existing row in a file that has the column.
> **IT IS A PRICE AND NOT A BUG, and it is written down here so that somebody has agreed to it**
> rather than discovering it. The cheaper shape, if it ever matters: the signature is one string per
> data set, so `sess` could hold it once (beside `sess.dataSetIds`, which is already per-row by
> index through `_dsi`) and the row literal could read it from there — the **day file** still needs
> the per-row column, because a reopened file genuinely mixes rules. Not done in this round: it
> changes the row literal `run_panes_e2e` diffs byte for byte and the saving is bytes, not
> correctness. **T-S10-29.**
>
> **The operation counts the build claimed are all true and were re-measured.** The mint pays ONE
> canonical-JSON-plus-hash pass for 200,000 rows and ZERO for the next 500,000 (the `WeakMap`
> cache); 10,000 guarded writes plus one all-or-none batch add ZERO passes. The review pass added
> one more input to that cache and did not change its shape: `tpl.columns` now goes in **by identity
> AND by length**, because `Reco.addCorrectionCol` pushed into that array IN PLACE and no identity
> test can see a push. The per-write cost is a `WeakMap` get and four compares.

Worth reading before you touch a performance assertion anywhere in this project.

MR-3's fix took an `O(history)` reversal count **out of** `_postedAuditIndex`'s memo key — the key
was being rebuilt, and the history walked, on **every** `_postedRefFor` call, memo hit included.
`run_reverse_e2e` guarded it with `check(memo.ratio < 4, …)` where `ratio = many / one`, two
wall-clock figures **both under two microseconds**. Observed on consecutive runs of the same tree:
`1.47 µs at 1 entry, 0.93 µs at 2,000 — ratio 0.64`. A scheduler hiccup inside the 3,000-call loop
at *one* entry halves the denominator, and the only gate the fix has fails for a reason that has
nothing to do with the code. The tempting response — raise the threshold — walks the gate down
until it measures nothing.

**The claim was never "it is fast". It is "a warm call does a constant amount of work whatever the
history's length".** So the 2,000 fixture entries are built with `Object.defineProperty`
accessors over `reversal` and `accountingId` that count reads, and the claim is read off the
counters:

| over 3,000 warm calls | at 1 entry | at 2,000 entries |
|---|---|---|
| `reversal` reads | **0** | **0** |
| `accountingId` reads | **6,000** (2 per call: `_postedRefFor` and `_postedRefForPk` each ask for the index) | **6,000** |
| the scan it replaced | — | **6,000,000** |
| **one COLD `_postedAuditIndex`** | — | **4,001** `reversal` reads, and **0** on the memo hit straight after |

Four assertions, no threshold in any of them: `reversal` is read **not at all**; the
`accountingId` count at 2,000 **equals** the count at 1 (so the per-call work does not grow with
the history); the removed scan really does read `2000 × 3000` properties; and — the probe's own
premise — **a cold index build reads 4,001 and the memo hit after it reads 0**. That last one is
not decoration. It is the only thing that proves the counting accessors are on the array *the
code walks* rather than merely on the one the fixture is holding; without it, `0 reads` and a
blind probe are the same reading. The timings are still printed, as a report.

**Mutation-checked**, with the readings:

| mutant | what it reads | which assertion dies |
|---|---|---|
| the reversal count back in the memo key | `reversal` **12,000,000** at 2,000 entries (4,000 per call — two index calls per `_postedRefFor`) | the `0 reversal reads` gate, and the premise with it |
| a key that joins every `accountingId` | `accountingId` **12,000** at 1 entry vs **12,006,000** at 2,000 | the *same count at 2,000 as at 1* gate |

> **And the trap that cost a round of runs: `run_reverse_e2e` has no `APP_REV` / `APP_FILE`
> knob.** `run_store_e2e` does, so `APP_FILE=…/mutant.html node tests/e2e/run_reverse_e2e.mjs`
> looks like it works, runs to completion, and quietly measures the **working tree**. Both
> "mutants" came back 255/0 with identical property counts, which read as *the gate is blind*
> when the truth was *the mutant was never loaded*. A mutation check on that suite has to put the
> mutant **into `apps/Reco.html`** and copy the real file back afterwards (`trap … EXIT`, and
> `cmp` at the end to prove it).

### 16.5 T-30-3 — the promotion no longer picks between two legacy values

`Reco._promoteCarryForward` walked `sess.data` in order and wrote one record per key, so two rows
sharing a key with **different** legacy values lost one of them: last row wins, and the legacy
`manualTags` entry the loser came from is deleted in the same pass, with no second copy anywhere.
Reproduced: both rows read `Bob`, `Alice` gone from the store **and** from `sess.manualTags`.

It now collects conflicts in the same pass, promotes the non-conflicting cells, leaves the
conflicting `(key, column)` **and both legacy values** exactly where they are, and asks **one
confirm in `saveTemplate`** — beside the primary-key warning, which is where that wording already
lives — *before* anything is written, naming each key with `Reco._pkLabel`, both values and the
`Reco._dupPkCountFor` row count. Declining promotes nothing and deletes nothing. **Same value on
both rows is not a conflict**: there is nothing to pick between, and one record serving both rows
is the feature (`k:'typed'` broadcasts on purpose; only an **override** refuses, because
broadcasting money is a bug and broadcasting a note is the feature).

> **"EXACTLY WHERE THEY ARE" IS NOT THE SAME AS REACHABLE, and this file has said otherwise.**
> *Where they are* is `sess.manualTags`, whose key is `row._id + '||' + name` — and `row._id` is
> re-minted by `U.uid()` on **every load**. So the characters survive in
> `reco/recoSessions.json` under ids no reader can reach, and **the operator sees a cell that has
> gone blank**. Measured on the same fixture: `INV-7=Bob` before this feature (which picked a
> winner — the thing the ticket complained about) and `INV-7=` after it. Not picking is still
> right; the confirm and the toast say so. Making the values **reachable** is **T-26-11**, and
> until it is done, declining the promotion trades *one value silently lost* for *both values
> silently unreachable*.

### 16.6 Known limitations of this round

- **A row whose amount works out to a legitimate 0 still produces no journal line and is still
  stamped `Posted`.** `_buildEntryLines` has `if (value === 0) return;`, and
  `commitEntryFromPreview` stamps every standard row. Z1 closes the `#ERR` case, which is the one
  where the zero is a *failure*; a genuinely zero row is a different question and is **T-26-9**.
- **The summary cards have T-26-5's silence too.** `Sum`, `Avg`, `Min` and `Max` skip a
  non-numeric cell without saying how many. Only the total row and the footer were in the
  ticket's **Fix**; the cards want the same treatment and are **T-26-10**.
- **Z1's refusal is all-or-nothing.** There is no *"post the rows that are fine"* — that would
  post an entry quietly smaller than the selection, which is the harm this refusal exists to
  prevent. Correcting the data or the formula is the route.


---

## 17. T-S10-11 — two windows minting the same accounting reference

### 17.1 The one thing to read if you read nothing else

**The accounting reference is two characters longer than it used to be.** `AEMVAUQHDL` became
`AEMVAUQHDL7K`. The last two characters are drawn once per window, at the first mint, and are the
same on every reference that window produces. **Tell the team**, because the reference is what
people quote to each other, write on documents and type into the GL.

### 17.2 What was happening

`'AE' + Date.now().toString(36).toUpperCase()` is **one string per millisecond**, with no window
in it. Two people pressing *Generate* in the same millisecond minted the **same** reference — and
the append that records an entry was idempotent **by that string**:

```js
if (!list.some(e => e && e.accountingId === accountingId)) list.push(entry);
```

So each window's append was a no-op against the other's record. **One journal entry was
discarded.** Both operators were told *"Entry AEMVAYN4CT generated (2 lines)"*, **both** row sets
were stamped `POSTED` on the share, and both writes **succeeded**, so nothing in either window
ever said otherwise. Measured at a 0 ms stagger: `posted ["AEMVAYN4CT","AEMVAYN4CT"]` with
`reco/entryHistory.json` gaining **one** entry.

Downstream it was worse than a missing record, because the two entries were
**indistinguishable**: the reversal takes the first match, `docNumberMaster` maps a number to one
of them, and `_postedAuditIndex` resolves a row to whichever it met first.

**And every test that covered this read green**, which is the part worth remembering. Section
`[57]`'s S109a asked *"is each id present on the share?"* — with one id under two names, both
lookups hit the same single record. S109b asked the same of the four document numbers. A
presence test cannot see a collision; only a **count** and a **comparison** can.

### 17.3 The fix, in two halves

**One — a per-window suffix, `U.accountingId()`.** The mint lives in one place now and both
callers use it (`commitEntryFromPreview`, and `reverseEntry`'s mirror). Two base-36 characters
are drawn from `Math.random()` at the first call and cached in `U._aeTag` for the life of the
window. A same-millisecond collision goes from **1 in 1** to about **1 in 1,296**. This is
option (a) of the ticket; option (b) — a counter allocated through `Store.mergeWrite` — is exact
but makes *Generate* wait on the shared folder, and was not taken.

**Two — the append tells our own entry from a stranger's.** The suffix leaves a residue, and a
residue that silently loses a journal entry is not acceptable, so the rule changed as well.
Every entry carries an `idNonce` (`U.uid()`), and the one copy of the append rule is
`Reco._appendEntryIntent`:

```js
const held = list.find(e => e && e.accountingId === entry.accountingId);
if (!held) { list.push(entry); return false; }
if (held === entry || held.idNonce === entry.idNonce) return false;   // our own intent, replayed
entry.accountingId = Reco._reMintAgainst(list);                        // a stranger holds it
list.push(entry);
```

**Why a nonce and not a deep compare:** the first write goes out *before* `postedPks` and
`postedPrev` are attached to the entry, so a replay of a perfectly ordinary entry does not equal
what is already on the share. An entry written by an older build has no nonce, which reads
correctly as *"not mine"*.

**Replays converge.** `entry.accountingId` is reassigned **in place**, so the next replay of the
same intent looks the **new** reference up, meets its own nonce and does nothing. The same object
is in `AppState.entryHistory`, so this window's own memory moves with it.

**Four sites replay that intent** — the *Generate* door, `_confirmEntryOnShare`'s repair,
`_reSettleEntry`, and `reverseEntry`'s **mirror** — and they call the one function rather than
carrying four copies of the rule. A site that skips on the reference alone is a site that loses
the entry.

**The mirror is the reversal's version of the same bug**, and worse in one way: a skipped mirror
leaves the original **marked reversed** with no contra behind it. So the mirror carries an
`idNonce` too, goes through `_appendEntryIntent`, and the **link follows it** —
`e.reversal.reversalId`, which is what walks from the original to the contra, is set from where
the mirror actually landed, **inside the mutate**, so a replay cannot leave it naming a reference
the mirror no longer has.

### 17.4 Everything that had to stop trusting the announced reference

| reader | now |
|---|---|
| `_confirmEntryOnShare`'s *"did it reach the share?"* look | matches on `accountingId` **and** `idNonce`. Matching the reference alone would find the **stranger's** record and report success over a lost entry — the bug's own shape |
| `_reSettleEntry`'s *"still there"* test | the same, for the same reason |
| the `docNumberMaster` intent | writes `entry.accountingId`, read when the merge job runs, not the string captured at mint |
| the allocate modal (`setTimeout`, 300 ms) | `entry.accountingId || accountingId`, read at fire time |
| `AppState._activeEntryId` | repointed by `Reco._noticeReMint` |

### 17.5 When the 1-in-1,296 does happen, the operator is told

`Reco._noticeReMint` is a no-op unless the reference moved. When it did, it opens a modal headed
*"This entry is **AEMW1Q3R8F**, not AEMVAYN4CT"*, says that both entries are on the share and
**nothing has been lost**, and says plainly that the old reference is **a colleague's entry** — so
if it has already been written on a document, correct it. It also rewrites the document numbers
that still read the old reference (only ours can), repoints `AppState._activeEntryId`, and
re-renders the entries tab so the screen does not contradict the modal.

### 17.6 The gates, and what each one is for

In `tests/e2e/run_store_e2e.mjs`:

- **`[57]` S109c / S109d** — the two assertions the ticket's *Test* paragraph asked for: two
  windows posting in one `Promise.all` get **different** references and
  `reco/entryHistory.json` holds **two** entries. S109e checks the shape people quote is still
  `AE` + base-36 and the same length in both windows.
- **`[57]` S109f / S109g** — the **mechanism**, inside one page and with no timing in the answer.
  Two mints a millisecond apart share their last two characters while everything before them
  changes (so the suffix is not more clock), and 300 fresh draws produce more than one value (so
  it is drawn per window, not compiled in). These exist because **S109c/S109d would still read
  green with the suffix removed** — the content test re-mints the loser anyway, which is the fix
  working, and exactly why the outcome cannot be the gate on the suffix.
- **`[57b]` S111a–S111h** — the residue, made deterministic. `U.accountingId` is **pinned** to one
  string in both windows, which is the state every build before this one was in permanently.
  **The ordering is the section:** page B boots **before** anything is posted, because
  `AppState.entryHistory` is read once at boot and a B that opens later already holds A's entry,
  where the in-window uniqueness guard at the mint site sidesteps the collision on its own. With
  that line moved below A's post, the section reads green against an append that skips on the
  reference alone. S111a and S111a2 are the two premises; S111b–S111h are the claims.

**Mutation-checked on the committed tree**, and the readings are the clearest record of the bug
there is:

| mutant | what the share held | which assertions died |
|---|---|---|
| the per-window suffix removed | both windows minted `AEMVB5ZQXC`; `reco/entryHistory.json` still held **two** entries (`AEMVB5ZQXC`, `AEMVB5ZR59`) with each entry's document numbers following it — `D1/D2 → ZR59`, `D3/D4 → ZQXC` | **S109b, S109c, S109f, S109g** (4) |
| the reference-only append restored | both windows under `AEPINNED1`; the share held **ONE** entry, and `D3/D4` pointed at the *other operator's* entry | **S111b, S111c, S111f** (3) |

The first row is the fix working without its first layer: a certain collision, and **nothing
lost** — because the append re-minted the loser and the document numbers followed. The second row
is the bug: one record, one operator's journal entry gone, and their document numbers resolving
their rows to a colleague's GL entry.

> One detail the first row also shows, and it is by design: S109b died because the fixture
> captured window A's reference *before* A's re-mint landed (the re-mint happened later, in
> `_confirmEntryOnShare`'s repair). The share and the master were both correct. That is exactly
> why every reader in §17.4 re-reads `entry.accountingId` instead of trusting a string captured
> at mint time — a captured reference can be stale, and `_noticeReMint` is what corrects the one
> the operator is looking at.

### 17.7 Still open

- **T-S10-10's cross-page clobber is not closed by this.** A colleague's write landing *after*
  `_reSettleEntry`'s look is still invisible, and the complete fix is a **write-if-unchanged in
  the Python bridge**, which no round has been allowed to edit.
- **A mixed fleet still destroys entries.** An un-upgraded copy of the app on the same folder
  writes `reco/entryHistory.json` as a whole file with no re-read. See **T-S10-12**.
- **The `idNonce` makes two colliding entries distinguishable to the *code*, not to a
  person.** Nothing in the UI shows it; the modal in §17.5 is the human-facing half.
- **A re-minted *mirror* does not get the §17.5 modal.** The mirror is never lost, and the
  original→contra link always names where it landed, but the reversal's own toast and
  `reco/reversals.log.csv` line are written from `newId` as announced. Reaching that case needs
  two people reversing **different** entries in the same millisecond **and** drawing the same
  two characters, so the announced reference is right about 1,295 times out of 1,296 — and when
  it is not, the record on the share is correct and the log line is not. Worth a notice if
  anybody ever meets it.

---

## 18. The data-loss round — T-S10-7, T-24R2-1, T-S10-5, T-F2-8, T-S10-9, T-26-4

> **THE ONE THING TO CARRY OUT OF THIS WHOLE SECTION, if you are here because a row's key stopped
> being the key the shared folder works out.** A row is unsafe to write against when its `_pk` is
> not what the template's rule computes for it **now** — because a colleague changed the rule
> (T-24R2-1, the latch) or because the rows came out of a day file written before such a change
> (T-S10-19). **That question is asked at the WRITE, not at the controls**: `Reco.writeKey` and
> `Reco.writeVerKey` are the only two ways a ROW becomes a KEY for a record the folder shares, and
> both ask. It is deliberately **not a list of function names**, and that is not a style
> preference — it is the measured outcome of four rounds that each wrote such a list and each found
> more controls afterwards (3, then +7, then +5, then +4 found with real mouse clicks, then +4 that
> only a static enumeration found). `run_store_e2e` **[82]** enumerates the writers out of
> `apps/Reco.html` itself and fails on a write that is neither guarded nor allow-listed with a
> reason, so the next control is caught on the day it is written. **§18.11 is the round that did
> this and the paragraph the next person needs; §18.9 and §18.10 are the two that tried the list.**

Six tickets with one thing in common: **every one of them lost somebody's work silently.** No
toast, no confirm, no row in the CSV — the value or the setting was simply not there the next
time anyone looked. That is why every assertion in `run_store_e2e` sections **[63]–[68]** — and,
after the review of this round, **[69]–[77]** (§18.8) — reads a
**file** or a **value** — what is on the share, what the next upload mints, what the entry
posts — and never a toast on its own.

Ports **21240–21259** for the build, **21300–21319** for the review round, **21380–21399** for
round 5. The suite goes from 441 checks to **502**, to **582** once the review's own sections are
in, to **598** once T-S10-16's sixteen are added to **[71]** (§18.9), and to **638** with round
5's sections **[79]–[81]** (§18.10).

> **READ §18.8 AND §18.10 BEFORE TRUSTING ANYTHING IN §18.1–§18.9.** Two reviewers put fourteen
> findings against this round, **every one of them reproduced and confirmed** — two BLOCKERs, seven
> HIGHs — and two of §18.7's "known limitations" were measured to say the **opposite** of what
> happens. A verifier then read the fixes and said **do not ship**: T-S10-16 was reported closed
> and was not, and **five more documented sentences** had come to say the opposite of what the code
> does — two of them (§18.5 and §15.6) repeating the very failure this banner is about. §18.10 is
> that round. Every one of those sentences is corrected in place, where it was, rather than only
> contradicted later: a reader who stops at §18.5 must not be taught the mechanism B2 deleted.

### 18.1 T-S10-7 — every template field, not just the two flags

**Reproduced first, with two browser contexts on one share** (`scratchpad/dataloss/build/p1_s107.mjs`):

```
bBootDesc      : first
A in memory    : {'order': ['Note','Amount','Invoice'], 'toasts': ['success: Template saved to database']}
share after A  : {'displayOrder': ['Note','Amount','Invoice'], 'displayOrderBy': 'Test User', ...}
B in memory    : {'order': None, 'desc': 'B was here', 'toasts': ['success: Template saved to database']}
share after B  : {'displayOrder': None, 'description': 'B was here'}
```

A published a team column order; B — booted earlier, and it never touched the order — saved a
description from its older clone and **reverted it**, with a green *"Template saved to database"*
the only thing said. That order is the column order of every CSV and every Excel workbook the
template exports, for everyone on the folder.

**The fix is three questions per field**, asked of the stored template re-read off the share:

| this editor changed it | the folder changed it | what happens |
|---|---|---|
| yes | — | the operator's decision; it goes through untouched |
| no | yes | **the folder's value is kept**, and named |
| no | no | nothing to decide |

`RecoTemplate._openedWith` is what makes the diff possible, and it is why a check against
`AppState.recoTemplates` was written here once and removed: that array is read only at boot, so it
holds **this session's own object** and the comparison could never fire. `_openedWith` is the clone
the editor opened *and* what `finish()` last published — i.e. "what this window believes the folder
holds", the third fact the diff needs.

The same three questions run **inside `additionalColumns`**, per column and per field, which is
where a colleague's formula and the two carry/override flags live. A column's **`name`** is merged
only when both sides are paired by `_cid` (§18.3): without an id a rename is indistinguishable from
a remove-plus-add, and renaming the column here would strand every record filed under the old name.
A column the **folder** has that neither this editor nor the clone it opened ever saw is a
colleague's new column, so it is **appended** and named; a column this editor **removed** stays
removed, because that decision has already been put to the operator with the record count.

**Both deletions the ticket asks for were made.**

- **RC-12's two-field special case is gone.** `_flagsOf`, `_readSharedExtraFlags` and
  `_reconcileSharedFlags` are replaced by `_readSharedTemplate` → `_settleShared` → `_mergeShared`.
  The two flags are now merged by the general rule; section **[45]** (X5a–X5d) is still the gate
  and still green. X5b reads the merge's **one question** instead of RC-12's toast — the claim is
  unchanged ("B is told that somebody else had changed this template, naming the column"), only the
  channel moved, because the ticket asks for the fields to be *named in one confirm*.
- **The `AppState.pendingCount() === 0` skip is gone.** C6h's hazard is real: `AppState.save()` is
  a 250 ms debounce, so a second save from the same screen used to reach the read while the first
  was still a pending timer, and the file then held **our own past**. But the condition for that is
  a write owed **for `reco/recoTemplates.json`**, and `pendingCount()` also answers yes for a typed
  cell value and for a queued version row. So the reconciliation sat out exactly the case where the
  operator had just typed — which is most saves. `RecoTemplate._tplWriteOwed()` asks the precise
  question (`Store.serialize('recoTemplates', …)` against `AppState._snap.recoTemplates`), and an
  owed write is **landed first**; the read then describes the share. **S107j–S107m** pin it: the
  premise asserts `pendingCount() > 0` at the moment of the save, and the gate asserts that A's
  order survives *and* that the value the operator had just typed still reached the folder.

**Cancel means something**, which is why this is a confirm and not a toast: `_abandonSave` puts the
**folder's** template back (not this window's stale one), skips `AppState.save()`, and **closes the
editor**. Left open, `_editing` still holds the stale field and the next press of Save would publish
it with nothing left to notice.

### 18.2 T-24R2-1 — a key change is REFUSED, not merged, and here is the argument

The general merge of §18.1 would "cover" a key-definition change, and the share would even end up
with one scheme — the mutation run proves it: with the refusal disabled but the merge in place, the
day-file measurement **still** reads four keys for four rows. **That is not the harm.** The harm is
operator-facing:

- B's session was loaded and keyed under the **old** scheme and every loaded row carries a frozen
  `_pk` from it. Silently adopting the folder's key rule under a save B believes succeeded means
  B's **next upload** mints keys under a scheme B never chose.
- Every other field can be looked at and re-edited. A key change has already **detached history
  from the rows** by the time anyone notices — version history, manual offsets, corrections,
  groups, comments, and the typed values of added columns, which are the one thing in that list
  with no second copy anywhere.
- So "silently keeping the share's key definition under a save the operator thinks succeeded is its
  own trap" is exactly right, and the refusal is earned by the half the merge cannot fix.

**The rule.** `RecoTemplate._keyDefOf` reads `primaryKeys` plus the definition of every column in
the key's **dependency closure** (`Reco._keyDepNames` — one hop is too shallow, because editing the
helper formula a key extra reads changes every row's identity while leaving the key extra
byte-identical), from **both** sides. Any difference between the share and `_openedWith` refuses the
save with the ticket's own sentence, **whatever this editor did** — two people both moving row
identity is a conflict, not a merge. Nothing is stored, not even the field B did edit.

**The recovery is real, not a loop.** `_abandonSave` refreshes this window from the folder and
closes the editor, so the next clone carries the colleague's key and the same change saves
immediately (**S241f**).

**The measurement, which is what the ticket asks be asserted:** one upload from each of two pages
into `reco_data/<folder>/<MMM-YY>/<DD>.csv`.

| | distinct `_pk` for 4 business rows |
|---|---|
| before (pre-fix run, `build/pre_s107.txt`) | **8** — `D1, D1-X, D2, D2-X, D3, D3-X, D4, D4-X` |
| after (**S241e**) | **4** — `D1-X, D2-X, D3-X, D4-X`, every one of them A's |

### 18.3 T-S10-5 — `_cid`, and why the slot rule had to stay

`renamedCols` paired `prevExtras[idx]` with `t.additionalColumns[idx]` — the same **slot** in the
editor's list. Renaming a column in place migrated its values (X3a–X3c); renaming it **and**
dragging it elsewhere in one save looked exactly like *"the old one was removed and a new one was
added"*, so the operator got the **removal** confirm — the one that offers to delete the values
rather than move them — and the records stayed filed under the old name if they cancelled.

An added column now gets a stable **`_cid`** when it is **created**, at the three places one can be
created: `RecoTemplate.addExtraCol`, `Reco.ssAddColumn`'s persist branch, and `Reco.ssPromoteCol`
(where a session column becomes a template column). **Never backfilled**, and that is deliberate:
lazily minting one on edit would make `kxDef`'s JSON comparison differ from the stored template's
and fire the primary-key confirm on a save that changed nothing.

**The slot rule stays as the fallback** for every column written before the id, and **S105g–S105h**
pin it: a column with no `_cid` renamed-and-moved is still read as a removal and still asks first,
which is the safe side of the fork. One refinement beyond the ticket's Fix paragraph: `typeAway`
pairs the same way, so a column renamed **and** retyped in one save still gets its type question
(the ticket's *What* names that case; its *Fix* did not).

A `_cid` that exists but matches nothing on the new list means the column really was removed —
falling back to the slot there would pair it with whatever column now sits in that position and
migrate one column's values onto another.

### 18.4 T-F2-8 — two lines, three writers

`Reco.editCell`, `Reco.manualOffset` and `Reco.unmarkOffset` all ended `if (!row) return;`. With the
row held by `_id` (A6) there is a real path where it has left this pane's data between the render
and the commit — a reload, a restore, an Excel load-back, a programmatic template switch — so the
edit is **correctly** not written, and the operator's typing left the screen with nothing said.
All three now carry the sentence `applyCorrection` has used for the same case since fixer 1 wrote
it. **F28d is the control that matters:** a row that *is* there still commits, the value is in the
store **and on the shared folder**, and **nothing is said at all** — `editCell` runs on every cell
commit in the app, so the hot path had to stay silent when it works.

### 18.5 T-S10-9 — the journal, and the guard that is the whole design

`mergeWrite` **refuses** rather than writes when it cannot read the file it has to merge into,
which is right — writing then replaces a colleague's file with whatever this session holds. So the
typing stayed buffered, was retried four times on a widening gap, and was announced. What was left
was the answer **yes** at the leave gate: the store keeps **one truth per cell** and deliberately no
second copy, so there was nothing to recover from. Reviewer B's P3f is the measurement: four typed
values, cells `["INV-1=","INV-2=","INV-3=","INV-4="]`, store `{}`.

**There is a second copy now, and it is local.** Each unwritten intent is journalled as it is
buffered and cleared when its write resolves. It never reaches the share: what is owed to the
folder is owed by **this machine**.

**The review question is the replay, not the writing.** A colleague may have typed the same cell
while this window was offline, and a blind replay would overwrite a **newer** value with an older
one and call it recovery — worse than the loss it fixes. So:

- the guard is **per cell**, not per file and not per template: one stale cell must not hold back
  three good ones (**S109j** asserts the winning case in the same run as the losing one);
- an intent is applied only where the share holds **no** record for that cell or holds one whose
  `at` is **older**. `AppState.load()` has just finished, so `AppState.extraValueMaster` **is** what
  the folder holds, which is what makes the comparison honest;
- the comparison is a **string compare**, because every `at` in the store is an ISO 8601 UTC stamp
  from `new Date().toISOString()`, which sorts lexicographically — parsing dates to compare them is
  how a timezone gets into a decision that has none;
- a record with **no** `at` counts as newer: *"somebody typed this and we cannot tell when"* is not
  something to overwrite. Equal stamps are also left alone — we cannot tell them apart and the
  share is already serving one of them;
- every skipped cell is **named**, with who holds the newer value, what it says and what this
  window had. *"4 values recovered"* with one silently dropped is the same silence in a different
  coat.

**Where the work is, and it is a measured constraint, not a preference.** The first build journalled
through `localStorage` on every keystroke, which made C3's 50,000-cell fill-down quadratic (parse
50,000 entries, push one, stringify 50,000 — fifty thousand times) and **hung the suite for eleven
minutes**. So the owed set lives in a `Map` in memory and `localStorage` is written only when being
durable is what matters:

- a write resolves **not-written** — the folder is misbehaving, which is the whole case this exists
  for. Scheduled on a 300 ms timer, so a share that is down for a fill-down is still one write per
  burst;
- the window is **going away** — `pagehide` and the `beforeunload` guard call `journalPersist()`
  **synchronously**, because an async write there may never run;
- the hub's **leave gate** asks — it persists first and then counts off the durable journal, so the
  count it promises is the count that is really on this PC.

On the happy path nothing touches `localStorage` at all. If a persist **fails** (storage full) it is
said once, because the leave gate would otherwise offer to keep values that are not being kept —
a worse lie than the silence it replaced.

**Where the clear happens, and it was wrong once.** The clear is **inside the write path**
(`Store._mergeJob`, beside MR-8's own intent bookkeeping: one journal id per intent, in the same
order, and the ids the job answered for are cleared when the write resolves). It was written the
obvious way first — hung off the promise `Reco._extraValueFlush` returns — and that is exactly
wrong for the one case the journal exists for: **a write that fails resolves that promise** with
`{refused}` while the value is still owed, and the **retry** that finally lands resolves nothing.
So a folder that came back on its own left the journal full, the next boot offered values that were
already on the share, the per-cell guard skipped every one of them, and the operator was told that
*somebody else* had typed those cells since — which was them. **S109m–S109p** is the assertion that
caught it, and it is the assertion that pins it: the retry carries both values to the folder
(`S109n`), the journal clears itself (`S109o`), and the next boot asks nothing (`S109p`).

**Two smaller rules worth knowing.** The journal is keyed by **cell** (`tag`), so a cell typed three
times while the folder was down leaves **one** entry carrying the last value; and it is cleared by
**intent id**, because a write that resolves while a newer value for the same cell is still buffered
(MR-8's window) must not clear the newer one. Each entry carries the **base folder** it was typed
against, so a journal belonging to a folder this PC is no longer pointed at is **kept and named**
rather than replayed into this one — and **kept** is the word that matters. This paragraph said
"discarded and named" until round 5, which is what the code did before finding B2 and what B2's
fix deleted: `journalClear()` spared nothing, so the boot that refused to replay another folder's
journal destroyed it, and the toast on the mixed path told the operator to *"point Reco back at
that folder"* about entries the same function had just removed. `journalClear(keep)` takes a
predicate; the `discarded` sentence is said from **above** the early return so the
all-other-folder case is announced at all; and a base the launcher cannot report is **UNKNOWN**,
not a different folder. Anyone reading the old sentence would have rebuilt the unconditional
clear, which is why it is corrected here rather than only in §18.8.

**Declining the offer keeps the journal**, and the operator is asked again next time: declining is
"not now", and the one thing this feature exists to stop is a typed value going away without being
asked about. An **accepted** replay clears the journal either way, skipped cells included — they are
not owed to the folder any more, they are decisions for a person.

### 18.6 T-26-4 — warn and offer to drop, which is a user decision already taken

Nothing in `previewEntryFromSelection` asked `Reco.isRowPosted` and `commitEntryFromPreview` did not
either, so a row already in the general ledger could be posted a second time. The pre-fix run
measured it: `entryHistory` held `["AE…S1:INV-1", "AE…KS1:INV-1+INV-2"]` — **two entries whose
`postedPks` both name the same row**.

The ledger after the fix, from the same selection with *"Leave them out"* pressed (**T264h**):
`["AE…S1:INV-1", "AE…ZGT:INV-2"]` — one entry each.

**The decision is warn-and-offer, not a refusal**, and it is built exactly that way: the preview
**still opens**, the posted rows are named with the accounting reference each one is already in
(off the same `Reco._postedRefForPk` the override refusal uses), and both ways on sit in the
banner. A refusal would change what every existing template can post, which is what this ticket
was deferred for in the first place.

- **The default is to post them, and the WARNING is what is new.** This was built the other way
  round first — posted rows dropped unless the operator said otherwise — and **three suites caught
  it**: `run_jv_gen` read `standard:1 buckets:[]` where it expects two TCH rows bucketed,
  `run_jv_engine` read 4 lines where the hand-written TCH page writes 8, and `Z1h` could not reach
  a posting at all. Every one of those is a workflow that **deliberately re-posts**, which is
  exactly what this ticket was deferred for — and Z1's own comment in this file already settles the
  principle: *"skipping the row would post an entry that is quietly smaller than the selection the
  operator ticked — which is the harm, not the remedy."* So nothing about what the entry posts
  changes unless somebody presses **"Leave them out"**. `Z1h2` asserts that directly: the warning
  fires on those three rows and they are **still in** the entry.
- **The drop is one press, not a mode.** `Reco._dropPosted` is **consumed by the preview it
  reopens**, so the next Preview Entry is back to the plain behaviour — a sticky "drop posted rows"
  is how a workflow quietly becomes one that posts less than it was told to, every day.
- The split sits **after the keyword filter** (a row the filter dropped is not in the entry, so
  naming it would be a warning about a row nobody is posting) and **above both ledger-write
  refusals** (a row being left out must not refuse the entry over a broken formula or a
  non-numeric override in a cell this entry is no longer going to read).
- **A reversed or cancelled entry does not count**, and that needed no special case here:
  `Reco.isRowPosted` already answers false for one, because the reversal is the documented way back
  (§12) and a gate that fired on it would make the recovery route unusable. **T264j–T264k** are the
  control: a reversed row previews with no warning and no banner.
- **And one thing the ticket did not ask for.** Once the operator has pressed *"Leave them out"* on
  a selection in which *every* row is already posted, the entry is **empty**, and Generate now
  refuses with a sentence that names the rows and their references (**T264l**). The guard is narrow
  by construction: it fires only when rows were dropped **for being posted**
  (`postedIncluded === false`), so a preview that is empty for any other reason behaves exactly as
  it did.
  **This bullet used to say Generate "would close the modal having written nothing and said
  nothing", and that was wrong** — corrected in T-26-9's round, which measured it with both
  all-dropped guards disabled (§22). The lines-less guard in `commitEntryFromPreview` already
  caught the empty entry, wrote nothing and left the preview open. What it said was `Nothing to
  post`: three words naming no row, no reason and nothing to do next. The sentence is an
  improvement on a bad message, not the removal of a silence.

**`Z1h` is unchanged and a second check was added beside it.** `Z1h` pins the *scope* of Z1's
`#ERR` refusal, and it gets there by re-posting the three rows `Z1g` posted a moment earlier. With
the default as shipped that passes through untouched; `Z1h2` is the new line, and it asserts both
halves of the decision at once — the warning **fires** on those rows, and they are **still in** the
entry.

### 18.7 Known limitations of this round

- **The merge runs after the swap, because the swap stays synchronous.** Every caller in the app
  and every fixture in the suite saves a template and reads `AppState.recoTemplates` on the next
  line, so `saveTemplate` could not become `async` without changing that contract. The consequence
  is real: the store side-effects that run between the swap and the folder's answer — a column
  rename's record migration, a removal's record drop, carry-forward's promotion — have **already
  happened** when a merge is cancelled or a key change refused. In the ordinary case (an edit to an
  ordinary field) nothing ran and Cancel is clean; in the rare one, the folder's template is put
  back and the editor closes, but a rename that was part of the same save has already moved its
  records.
  **~~Not ticketed as a defect because those records moved *with* a column that is still on the
  folder under its old name — nothing is deleted.~~ THAT WAS MEASURED FALSE, TWICE, AND IS NOW
  FIXED.** It was the review's finding A1 (BLOCKER) and A2 (HIGH):
  - the **removal** arm is a `_dropExtraValueCols`, i.e. a DELETE. The operator answered yes to
    *"Removing "Vendor" (3) also deletes 3 value(s) people have typed into that column … They go
    for EVERYONE using this folder and cannot be brought back"*, the save was then refused for a
    colleague's key change, and the folder was left with the column **back on the template and zero
    of the three records** — under a toast reading *"Nothing was saved"*. Share values before 3,
    **after 0**. The confirm's own promise (*"If you meant to RENAME the column, cancel and change
    its name in place instead — that keeps the values"*) was false, because cancelling the SAVE did
    not cancel the delete. Reachable with **no key change at all**: any colleague field change plus
    Cancel on the merge question.
  - the **rename** arm ORPHANS: the records went to `Supplier` while the folder's template kept
    `Vendor`, so the column read blank for everyone and the three values sat in the file
    unreachable — after a green *"3 value(s) … now belong to Supplier"* **one toast before**
    *"Nothing was saved"*.

  **The fix keeps the swap synchronous and moves the WRITING.** The three store side-effects
  (`_promoteCarryForward`, `_renameExtraValueCol`, `_dropExtraValueCols`) **and the toasts that
  announce them** are staged into one closure that only the success path invokes (`stageStore` →
  `saveAndSay`). The confirms stay where they were, above the swap, because what the operator
  decided does not change; a sentence about records that have not moved yet is a sentence that may
  never become true. `run_store_e2e` **[69]** is the gate, on both abandon arms and with a control
  that a save which SUCCEEDS still migrates and still deletes. Anybody making `saveTemplate` async
  can delete the staging; until then this is the chokepoint.
- **An owed templates write is LANDED FIRST, and that publish is the narrowed form of the old
  hazard.** `_tplWriteOwed()` true means this window holds a template change it has not published,
  and publishing it is owed work — but if a colleague changed the same template in that window,
  the flush clobbers their change *before* the read can see it. It now takes **both** an
  unpublished template change in this session **and** a colleague's change in the same window,
  where the `pendingCount()` skip it replaced needed only a typed cell. The flush is also
  **synchronous on its line**, because `AppState.flush()` serialises in its own body before its
  first `await`: deferring it by one microtask moves the serialisation past the swap, the flush
  then publishes this editor's own clone, and the whole fix reads green while doing nothing. It
  was written that way once and the suite passed on a lucky read/write ordering through the bridge
  queue.
  **ONE WORD OF THAT IS NOW CONDITIONAL.** Since the review's finding A3, `AppState.flush()` has
  one wait of its own at the top of its body: if `recoTemplates` is **held** (§18.8), it awaits the
  settle before serialising anything. The invariant above still holds *for the flush issued on
  that line*, because the hold is taken at the swap — i.e. after this read has been issued — so
  that flush never sees one. It does not hold for flushes in general, and anybody moving this code
  has to keep the two apart.
- **`additionalColumns` is merged per column and per field, not structurally.** A colleague's
  **reorder** of the added-column list is not detected as such: if this editor did not touch the
  list, the folder's whole array is taken by the top-level rule; if it did, the per-column merge
  runs and the editor's order wins. Column order inside that list matters (it is the evaluation
  order a formula reads), so two people reordering it at once is still last-writer-wins on the
  order itself.
- **The journal is this PC's, and it is not backed up.** A machine that is reimaged with an
  unwritten journal loses it.
  **~~A second window of the same app on the same PC shares the `localStorage` origin, so the two
  windows share one journal (correctly — the cells are keyed — … the per-cell guard makes that safe
  rather than destructive).~~ THAT SAID THE OPPOSITE OF WHAT HAPPENED. It was finding B1
  (BLOCKER), and it is now fixed.** The cells were keyed **per window in memory**; the persist was
  a whole-list **blind write** — `journalPersist()` did
  `Store._jrnlWrite(Array.from(Store._jrnlMap().values()))`, and `_jrnlMap()` reads
  `localStorage` only while `_jrnlMem === null`, so a window whose map is already live never saw
  the other window's entries again. The per-cell guard runs at **replay**, long after the loss.
  Measured, two pages in one browser context (one PC's origin): window A typed INV-1 with the
  folder down, journal `["INV-1/Vendor=A-typed-this"]`; window B then typed a **different** cell
  and the journal read `["INV-2/Vendor=B-typed-this"]` — **INV-1 gone**. Last writer won every
  time, the boot replayed one value, the only toast was a green *"1 value(s) kept on this PC are
  back on the shared folder"*, and the share ended with `INV-1=undefined`. The precondition is only
  that the second window has touched the journal earlier in the day; any persist does it — a failed
  write, `pagehide`, the `beforeunload` guard, or the hub's leave gate, which persists first.
  **`journalPersist()` is now a read-merge-write**: the disk list is re-read, merged by cell with
  the live map, newest `at` winning, and a cell this window has already SETTLED (`Store._jrnlGone`)
  is not resurrected by the re-read. `run_store_e2e` **[73]** is the gate. Two windows is a
  configuration this team is known to run — T-S10-11 exists because of it, and
  `U.accountingId()` draws two base-36 characters per **window** for exactly that reason.
- **A template a colleague DELETED from the folder is silently republished by a save from a
  window that still has it open.** `_readSharedTemplate` answers `null`, `_settleShared` has
  nothing to compare, and the save goes through as it always did. That is not a loss of anybody's
  work — it is the opposite — and the delete's own record cleanup (`RecoTemplate.remove`) has
  already happened, so the resurrected template comes back without the values. Worth a ticket of
  its own if the team ever deletes templates on a live folder.
- **The replay offers values, it does not offer *entries*.** `entryHistory` and `docNumberMaster`
  go through `AppState.ledgerFlush` → `Store.mergeWrite` and are **not** journalled: a journal entry
  is a cell, and a lost journal entry is **T-S10-10**'s cross-page clobber, not this.
- **T-26-4 counts a row as posted from the ledger's own record**, which is RC-5's key-scoped
  answer. A row whose key is **duplicated** in the loaded data is therefore named once per loaded
  row sharing that key, because the preview works on rows; the dedupe is by `_id`, so the count in
  the banner can exceed the number of distinct references. Cosmetic, and it errs towards saying
  more rather than less.

### 18.8 The review of this round — fourteen findings, four causes, and two holes the first fix opened

Two reviewers read §18.1–§18.7 against the build at `d1e9509` and put **fourteen findings**: two
BLOCKERs, seven HIGHs, four MEDIUMs, one LOW pair. Both verdicts were **do not ship**. Every one
was **reproduced before it was believed** — the reviewers' probes re-ported into one block on ports
21300–21319, kept in `scratchpad/dataloss/fix/probes/` — and **every one was confirmed**. Thirteen
are fixed; the fourteenth is ticketed as **T-S10-15** and argued below.

`run_store_e2e` sections **[69]–[77]** are the gates. Each one FAILED on `d1e9509` and the pre-fix
run is `scratchpad/dataloss/fix/pre_store.txt`.

**There were N = 4 shared causes, not fourteen bugs**, and each was closed once at its chokepoint:

| cause | findings | the chokepoint |
|---|---|---|
| `saveTemplate` did irreversible work before the folder had answered | A1, A2, A3, B5 | the store migrations **staged** into one closure the success path invokes, and the `recoTemplates` key **held** out of every write until the settle resolves |
| the merge looked in one direction, and only at fields nobody had touched | A5, A7 | the mirror pass and the `both` list in `_mergeShared` |
| the journal was treated as this window's private list | B1, B2, B3 | one read-merge-write, one `keep` predicate, one `id → tag` index, all inside `Store`'s journal block |
| T-F2-8 had been applied to a list of functions rather than to a rule | B4, B6 | five call sites and one sentence — `applyEdits` is shared, but gating it would also gate the machine paths (the Excel load-back), which must not be told to "press Load" |

A4 has no shared cause: it is the key refusal's own blind spot, fixed where the refusal is.

**What each one was, in one line, with what was measured:**

- **A1 / A2 (BLOCKER, HIGH)** — the abandoned save had already deleted or orphaned three people's
  typed values, and had already said so. Rewritten into §18.7 above, where the false sentence was.
- **A3 (HIGH) — the swap-to-answer gap published the un-merged clone.** From the swap until the
  folder answers, `AppState.recoTemplates` holds the editor's clone, and **any** write of that key
  publishes it — one ordinary `AppState.save()` from a tag, an offset or a group 250 ms later was
  enough. Measured: a colleague's `displayOrder` present on the share, **`null`** after this
  window's own flush, under two green *"Template saved to database"* toasts and zero confirms.
  That order is the column order of every CSV and every workbook the template exports, for
  everyone. **The fix is a per-key HOLD** — `RecoTemplate._settleOwed` / `_tplHold()`, honoured by
  `AppState._keyHeld` in `flush()` and `saveKeys()`. Held, never dropped: `_snap` is left alone so
  the key still reads as owed to `_tplWriteOwed()` and `pendingCount()`. **[70]** is the gate.
- **A4 (HIGH) — the key refusal left this window typing under a dead key.** T-24R2-1's recovery
  sentence (*"Close it and open it again: this window now carries their key"*) was only ever true
  of the **template**. `_abandonSave` refreshes `AppState.recoTemplates`, `_openedWith` and the
  posted index; nothing re-keys the rows already loaded, whose `_pk` was minted under the rule that
  has just gone. Measured: after doing exactly what the sentence said, B typed into `Vendor`, the
  record landed under `D1`, and A's upload under the folder's rule read `D1-X` and showed blank —
  **no toast anywhere**. The round had traded a silent revert of a colleague's key rule for a
  silent loss of this operator's typing. **The fix is a latch, not a guess**: `Reco._keyStale`
  (per window, never on the session, so it cannot be serialised to a colleague who has nothing
  wrong), the refusal's own new sentence about the rows on screen, and two typing doors that refuse
  with a sentence until the rows are read again. Re-minting the keys here would change every loaded
  row's identity behind the operator's back; the Load they are sent to do is the route that does it
  properly, with the duplicate-key and blank-key questions attached. **[71]** is the gate, with a
  control that typing works normally again once the rows have been read again: a latch, not a dead
  end.
  ~~*Cleared by `Reco._mintKeysSync`, which every re-keying route goes through — an upload, Add
  Data, a restore, a version load, an Excel load-back.*~~ **BOTH HALVES OF THAT SENTENCE WERE
  FALSE, AND IT IS WHY THIS ROUND NEEDED A SECOND ONE.** Walked: `_mintKeysSync` has two call sites
  and both are `Reco.ingestData` (an upload or a paste). A **restore** does not come through it,
  `Reco.loadVersionedFile` copies `_pk` **straight out of the day file**, and the **Excel
  load-back** applies to rows already in `sess.data`. And the one route that does clear it re-keys
  only the rows it **appends**, because "Add Data" concatenates. The latch therefore came off while
  the rows it was protecting still carried their dead keys — finding A4 again, reached by the route
  this very sentence prescribed. The lift is now `Reco._keyStaleLift`, after the concat, and only
  when the session holds nothing but the rows that mint just keyed; the refusal names **Clear
  Loaded Data and then the load** instead of "press Load". **§18.10.**
  **THE LATCH GUARDED THREE DOORS AND THERE WERE FIVE — ~~filed as T-S10-16~~, NOW CLOSED, AND
  THE LATCH IS ASKED PER ACTION.** `setTag`, `setOverride` and `revertOverride` consulted it;
  `applyCorrection`, `manualOffset`, `unmarkOffset` and `editCell` did not, and
  `manualOffsetMaster[id][pk]` / `correctionMaster[id][pk][col]` are keyed by the same frozen
  `_pk` — both files being in `AppState.PERSIST_KEYS`, i.e. whole-file blind writes of files every
  colleague parses at boot. All five doors are now measured rather than three
  (`scratchpad/dataloss/close/repro_before.txt`, port 21340; the ticket's own probe could not
  measure the offset door because its fixture carried no tolerance). The decision taken is the
  **per-ACTION latch at every entry point, not a rule inside `Reco.rowKey`**; §18.9 is the
  five-door table, the argument against `rowKey` and the two doors that measurement leaves open
  (**T-S10-18**).
- **A5 / A7 (MEDIUM, LOW)** — the merge APPENDED a column the folder had gained and had no mirror
  for one the folder had **removed**, so an older clone silently resurrected it (blank, because the
  record delete had already run — operators learn that removing an added column "does not take");
  and when **both** sides changed the same field the editor won with nothing said, so the one
  person who could go and ask a colleague about it was the one person who did not know there was
  anything to ask. Both are the same pass: the mirror, and the `both` list that `_askMerged` names.
  An **absent** `additionalColumns` is not a removal — a template written by a build with no added
  columns has no such key, and reading that as "the folder removed every one of them" would empty
  the editor's list. **[72]** is the gate.
- **A8 (LOW)** — past eight already-posted rows the T-26-4 banner stopped naming them. 8 of 10
  named, with nothing saying there were more. Now disclosed.
- **B1 (BLOCKER)** — two windows on one PC destroyed each other's journal. Rewritten into §18.7
  above, where the false sentence was.
- **B2 (HIGH) — the replay DELETED the journal of the folder it refused to replay into.**
  `journalClear()` took no argument and spared nothing, and the `return` on the "nothing belongs
  here" path sat **above** the `discarded` toast. Measured: four values typed against the folder
  the team had just moved off, `Store._jrnlRead()` after the boot `[]` — **gone** — and **not one
  toast said anything**; with one of four belonging elsewhere, the toast said *"Point Reco back at
  that folder to put them on it"* about an entry the same function had just deleted. The same wipe
  fired whenever `get_folder_info()` was transiently unavailable, because `_jrnlBase` then read
  `''` and every entry classified as another folder's. Now `journalClear(keep)` takes a predicate,
  the `discarded` sentence is said from **above** the early return, and an **UNKNOWN** base is no
  longer read as a different folder. **[74]** is the gate.
- **B3 (HIGH) — `journalDone()` was O(n²) inside the queued write job.** It walked the whole Map
  with no early exit, once per intent, synchronously, from inside `Store._mergeJob` — and because
  the loop runs after the write but still inside the per-path job for
  `reco/extraValueMaster.json`, the queue for that **shared** file was held for all of it by a loop
  doing no I/O. Measured 10 / 171 / 3,585 / **19,305 ms** at 1,000 / 5,000 / 20,000 / 50,000 cells;
  a 50,000-cell fill-down went from ~0.95 s to **21.9 s** with the window frozen. §18.5 says the
  owed set was put in a Map precisely to stop the first build's quadratic hanging the suite for
  eleven minutes — the quadratic had **moved, not gone**, and the suite could not see it because
  C3b counts the writes (still exactly one) and C3e only reports a wall clock (§16.4a). Fixed with
  a `_jrnlById` index, and **[75]** counts the SCANS rather than the clock.
- **B4 (HIGH) — `setTag` at a vanished row wrote the legacy `manualTags` under the dead `_id`.**
  Of the writers that were still not speaking this was the one where the edit was **lost** rather
  than merely dropped: the legacy store is keyed on an id `U.uid()` mints fresh on every load, so
  the `manualTags` READ fallback can never find it again, and it was not journalled either, so
  T-S10-9's replay cannot recover it. It is also the door most typing goes through — `editCell`
  serves FILE columns and `setTag` serves every ADDED one. The dead-id write is deleted and
  T-F2-8's sentence put there. The legacy `manualTags` **read** fallback is untouched and
  `run_reports_e2e` still seeds and reads it: that is about records written by older builds and
  never needed this write path, which only fires when the row is already gone. **[76]**.
- **B5 (HIGH) — the editor closed and the screen went home before the write was decided, and
  neither leave guard knew.** Measured 120 ms after Save: page `home`, `pendingCount` 0,
  `__hubPendingWrites()` 0, `leaveOk` **true**, no toast — and the share's description `null`
  afterwards. The hold fixes this too, because `pendingCount()` counts a held key, so both leave
  gates ask; `pagehide` force-releases (`_releaseHoldForExit`) so a closing window cannot be held
  open by one. **[70]**'s R2d/R2e.
  **AND THE EDIT IS STILL LOST IF THE WINDOW GOES ANYWAY, WHICH IS A DELIBERATE TRADE AND NOT AN
  OVERSIGHT.** Measured with the share read delayed 2,500 ms and the window going away 120 ms
  after Save: both leave gates ask, and if the operator leaves regardless the share's description
  is still `null` afterwards (`p7_savegap` 15b). At that moment `AppState.recoTemplates` holds the
  editor's **un-merged** clone, so publishing it from `pagehide` would revert whatever the
  colleague changed — finding A3, deliberately. So the choice is between losing one undecided edit
  from a window that was warned twice, and silently reverting a colleague's published field; this
  round takes the first. Written down because an undocumented refusal reads as a bug nobody
  noticed.
- **B6 (MEDIUM)** — four more row-level writers said nothing when their row had gone:
  `setOverride`, `revertOverride`, `confirmCarried`, `ssToggleRowSingleUse`. One sentence each, in
  the words each already implies, two of them about a **delete** that did not happen. **[76]**.

#### The hold opened two holes of its own, and they are the reason this round took a second pass

Both were found by the gates, not by reading, and both are worth knowing because they are the
general shape of "defer a write":

1. **A held write that is merely SKIPPED is a dropped write.** `saveTemplate(); await
   AppState.flush();` is how every caller in the app and every fixture in the suite lands a save.
   A flush that skipped the held key published **nothing at all** and the next share read then
   described the folder's **past** — so `_mergeShared` read the field this editor had just set as
   a colleague's change, kept the folder's older value, and quietly unticked it. Measured as
   **C6h**'s carried value (`carried:false`, `grid:""`) and as **X5**'s own premise failing. So
   `flush()` and `saveKeys()` **wait** for the settle and then write the MERGED template.
2. **Waiting inside `flush()` is circular unless the settle's write is taken off the debounce.**
   With `RecoTemplate._tplWritten = AppState.save()`, the second save's share read waited for the
   first save's guard and then for a **250 ms debounce that only a flush resolves** — and that
   flush found the key held by the second save and waited for the second save's guard, which was
   waiting for the flush. `run_store_e2e` stopped dead at **[28] C6h** and never returned. So the
   settle writes its own key **directly**: `AppState._writeKeyNow('recoTemplates')` serialises,
   updates `_snap` the way `flush()` does, and resolves on the WRITE. No hold can be up for the
   save that is releasing one, which is why it may bypass `_keyHeld`.
3. **And "settled" is not "landed".** `_writeKeyNow` queues the write and updates `_snap` on the
   same line, so `_tplWriteOwed()` answers *nothing owed* while the bytes are still in `Store`'s
   queue, and `_tplHold()` is already false because `release()` runs before `saveAndSay()`. A save
   starting in that window read the folder's past and unticked the flag again — which is why C6h
   **flipped run to run** rather than failing cleanly, and why it only showed under the suite's own
   load (fifteen live bridges by section [28]) and not in a one-page probe. The share read now
   waits for `RecoTemplate._tplWritten` on **every** path, and the guard resolves **after** the
   write, so `await RecoTemplate._flagGuard` means what every caller already read it to mean. The
   owed-write flush stays **synchronous on its own line**, ahead of every `.then`, for the reason
   §18.7 gives. Reproduced deterministically by slowing the write of that one file and leaving
   every read alone (`probes/q5_slowwrite.mjs`): with the wait removed, the second save is asked
   *"Someone else changed this template on the shared folder while you had it open: "Vendor" —
   carry this value forward to the next file is OFF on the shared folder"* about a colleague who
   does not exist, and the flag is gone from memory and from the folder.

#### A6 — WONT_FIX this round, ticketed as T-S10-15

`run_panes_e2e` **[4]**'s byte-identity gate fails about one run in three (1 in 8 measured on one
tree, 0 in 8 on five consecutive runs) because `sess._virtRowHeight` is written by an unawaited
`setTimeout(0)` that nothing synchronises with the fixture's final `await AppState.flush()`.
`git diff c94264d d1e9509 -- apps/Reco.html | grep _virtRowHeight` is **empty** on both the
reviewer's measurement and mine, so it is not a behaviour change this round made. The fix belongs
in the fixture, which this round may not edit; making the measurement eager in the app would change
a field the byte-identity gate compares against base `5f61d76` and break it for real. The ticket
carries the mechanism **and the premise hole the reviewer found**: `TPL_B` and `TPL_C` are never
measured at all (8/8 runs), so the gate already compares two sessions absent on both sides and
reads green by symmetry — a premise assertion added naively would fail today.

#### Fixture corrections, and the argument for each — and THE HONEST COUNT IS FOUR, not two

> **THIS HEADING SAID "TWO" AND READERS STOPPED THERE.** The two below are this subsection's; §18.10
> records **two more** (`R3_RELOAD_AND_TYPE` and `R3_RELOAD_BOTH` in [71], which now call
> `Reco.clearSession()` before their load), and a verifier found a fifth, X5b's toast-to-confirm
> change in [45], which is still described only where it was made. **Four or five, not two** —
> counted here because a reader auditing a gate meets this heading first. **Round 6 adjusted none**:
> `git diff --numstat tests/e2e/run_store_e2e.mjs` reads **`906  0`** — nine hundred and six lines
> added, none removed, no assertion reworded, no regex loosened and no byte-identity baseline
> touched (§18.11).

The rule for this round was: **make the code satisfy the gate, do not adjust the gate.** Two gates
were adjusted anyway, and both are timing reads rather than claims:

- **C7c** (`run_store_e2e` [29], byte-identical to `c94264d` before this) asserts
  `check(c7.toast1.some(m => /now kept against the row key/.test(m)), 'C7c and the operator is told
  it happened, rather than having to guess', c7.toast1)`. The **assertion, the regex and the
  message are unchanged**; what moved is the line on which `toast1` is read, from immediately after
  the synchronous `saveTemplate()` to after the `await AppState.flush()` the fixture already
  performed two lines later. The promotion and its sentence are staged behind the folder's answer
  **because of A1 and A2** — a sentence about records that have not moved yet is exactly what A2
  measured — so "the operator is told it happened" cannot be said before it has happened. The same
  move makes **C7e** stricter: it now also fails if the second save says it promoted something a
  moment later.
- **R2e** asserted `leaveOk === false` while its own fixture stubbed `window.confirm` to return
  `true` for every question, so it could never pass: `_pendingLeaveOk()` **returns** `confirm(...)`.
  It now asserts what the finding is about — `gap.leaveAsked === true`, the question was put at
  all — and says so in its own message.

Everything else in the nine that were red at the first checkpoint was **code**, or a fixture
premise that never put the window into the state the finding is about (R3's page had no active
reconciliation, so `setTag` was returning at `if (!tpl || !sess) return;` and exercising nothing).

### 18.9 T-S10-16 — the latch is asked per ACTION, and why not inside `Reco.rowKey`

A4's latch closed the two typing doors its own finding had measured. **Five doors write under a
row key**, and the other three were measured, after the T-24R2-1 refusal and with
`Reco._keyStale.TPL_X === true` while the folder's rule computes `D<n>-X`
(`scratchpad/dataloss/close/repro_before.txt`, port 21340):

| door | what it said | what reached the share |
|---|---|---|
| `setTag` | `error` — the latch's sentence | nothing |
| `setOverride` | `error` — *"Nothing was overridden"* | nothing |
| `revertOverride` | `error` — *"Nothing was reverted"* | nothing |
| `applyCorrection` | **`success: Correction applied`** | `reco/correctionMaster.json` → **`D2`** |
| `manualOffset` | **nothing at all** | `reco/manualOffsetMaster.json` → **`D3`** |
| `unmarkOffset` | **`success: Unmarked 1 row(s)`** | **`D5`'s record DELETED** under the dead key |
| `editCell` | **nothing at all** | day-file version row → **`D4`** |

Two of them say something that is not true, two say nothing at all, and the unmark is a **delete
that did not happen** where the folder is concerned: it removes this window's copy and leaves the
one a colleague's load would read, so the row is offset again tomorrow under a green toast. The
offset door is the one the ticket could only predict — its fixture had no tolerance, so
`checkOffsetTolerance` refused every single-row offset before `manualOffset` wrote anything.
`run_store_e2e`'s `R1_SETUP` now carries `toleranceValue` and an editable column, and **R3g asserts
the door is reachable** so the hole cannot come back quietly.

**THE DECISION: the latch at the doors, asked per ACTION — not a rule inside `Reco.rowKey`.**
What was considered, and why the other was worse:

- **`Reco.rowKey` is a key READER, not a write path.** The renderer takes a row's `pk` attribute and
  every badge through it; so do the status / attachment / comment filters, `runAutoOffset`'s restore
  of a manual offset, the ⚠ recalculated drift check, `Groups.resolvePk` and the timeline. A
  refusal there would blank the screen this latch exists to keep **honest** — and §18.8's own
  reason for a latch rather than a re-mint is that the operator's view of their own rows must not
  change behind their back.
- **THE MACHINE PATH GOES THROUGH IT.** `ingestData` computes keys with no operator at the
  keyboard; a sentence telling it to load the rows again is addressed to nobody, which is exactly
  why `applyEdits` was not the chokepoint for B4/B6 either.
  **CORRECTED IN ROUND 5: this bullet said "the Excel load-back AND `ingestData`", and the Excel
  load-back is only half a machine path.** `ExcelLink.apply()` is the **Apply button** of the
  review dialog, with an operator's finger on it, and its write — `Reco.applyEdits(tpl, sess,
  edits, { source: 'excel', … })` — lands in the same pk-keyed shared store as `Reco.setTag`.
  Measured after the refusal: a green *"Applied 1 change to 1 row(s)"* and the dead key in
  `reco/extraValueMaster.json`. The latch is now at `ExcelLink.apply`, **not** at `applyEdits`,
  which the real machine paths share. The argument against `rowKey` is unaffected — `ingestData`
  alone carries it — but the sentence was wrong and it was being used to excuse an open door.
- **One function cannot carry four verbs.** `rowKey(tpl, row)` does not know whether its caller is
  correcting, offsetting, unmarking or typing, so the sentence it could produce is the generic one —
  and a sentence that reads like another function's is how an operator learns to ignore it.
- **Cost.** `rowKey` runs once per row per render; on a 500k-row extract a check there is half a
  million latch reads and, worse, half a million toasts in the one case it fires.

So the question is asked where the **gesture** is, and the rule written at `Reco._keyStale` is
deliberately about an action rather than a list of function names: *a gesture asks it when its key
comes from a row on screen and it writes a pk-keyed store the folder shares.* One verb per action,
the latch at **every** entry point of that action:

| action | verb | entry points now latched |
|---|---|---|
| type into an added column | *saved* | `setTag` (A4) |
| override / revert a computed column | *overridden* / *reverted* | `setOverride`, `revertOverride` (A4) |
| correct a value | *corrected* | `applyCorrection` |
| offset a row | *offset* | `manualOffset`, `bulkMarkOffset`, `offsetSelected`, `_xlOffsetSelectedRows` |
| unmark an offset | *unmarked* | `smartUnmark` (both gestures reach it), `bulkMarkOffset`'s unmark arm |
| change a file cell | *changed* | `editCell` |

The offset action having **four** entry points is the point of the rule: T-S10-16 named four
function names, and a fix applied to a list of names rather than to an action is the mistake B4/B6
were about. `R3q` measures the selection-toolbar door for that reason.

**NOT latched, deliberately:** `removeManualOffset(pk)` and `removeCorrection(pk, col)`. Their key
comes from the **stored master** the panel is listing, not from a row on screen — it is still the
key it always was, and cleaning up a record under it is right to let through.

**The gate** is `run_store_e2e` **[71]**, extended with R3g–R3v: each door refused *with its own
verb*, and then the files — `reco/correctionMaster.json` and `reco/manualOffsetMaster.json` hold
nothing under the dead key, no version row for the refused file-cell edit reaches
`reco_data/<folder>/<MMM-YY>/<DD>.csv`, and the record filed while the keys were still right is
**still there**. The **control** is R3s–R3v: after a reload the latch lifts, both doors work
normally, and the correction and the offset are filed under the folder's own key (`D7-X` / `D8-X`)
with nothing said. A latch that never lifts is a worse bug than the one it fixes. Measured failing
first on the unfixed tree (10 of 10 new assertions red, `close/store_fail_first.txt`) and again
through `APP_FILE` against `f9329e7` (`close/store_mutation.txt`).

> **THAT CONTROL WAS TRUE OF THE WRONG THING, AND SO WAS THE SENTENCE ABOVE IT.** R3s–R3v read
> `sess.data[length-2]` and `[length-1]` — only the rows the reload had just minted — so they could
> not see that the latch had lifted while the rest of the session was still dead-keyed; and above
> `Reco.BUSY_ROWS` the latch never lifted at all, so "a latch that never lifts is a worse bug than
> the one it fixes" was a description of this build. Both measured in §18.10, which also carries
> the gates that would have caught them.

**WHAT THIS DOES NOT CLOSE, MEASURED AND NOT PREDICTED** (`close/other_doors.txt`, port 21341):
group membership and a comment are pk-keyed writes to `groupMaster` / `commentMaster` — both in
`PERSIST_KEYS` — and their key comes from a row on screen too. After the refusal the group door
said a green *"Group "G1" created with 1 member(s)"* and filed the member as **`D1`**; the comment
door said *"Comment posted"* and linked it to **`D2`**. They were **not** latched here: a group is
also an offset control with refusals of its own, and the attachment door was not measured at all.
That was **T-S10-18**, with the measurement in it — not a prediction, and not an untested bolt-on.
**It is CLOSED in §18.10**, together with the attachment door it told the next reader not to
assume either answer for: that one was measured open too, filing `linkedPks` under the dead key
behind a green *"Uploaded: note.txt"*.

### 18.10 Round 5 — THE LIFT, the sixth door, and T-S10-18

A verifier read the whole of §18.8/§18.9 against the build at `eb33073`, reproduced the fixes from
the reviewers' own probes upward, and said **DO NOT SHIP**. Eleven of the fourteen findings were
genuinely closed; **T-S10-16 was reported closed and was not**, and five documented sentences had
come to say the opposite of what the code does. This section is that round. Its gates are
`run_store_e2e` **[79]–[81]**, ports **21380–21399**; the suite goes 598 → **638**.

**Everything below was reproduced before it was touched** — `scratchpad/dataloss/lift/logs/`
`v5c_before.txt` (the verifier's own probe, re-ported), `w1_before.txt` and `w2_before.txt` (mine)
— and every assertion reads a FILE or a VALUE.

#### THE LIFT, which is findings 1 and 2 and one line

`Reco._keyStale` came off at the **head of `Reco._mintKeysSync`**, under a comment that wrote the
bug down as the design. Three things were wrong with that, and all three let an operator type under
a dead key again:

| | what the build did | measured |
|---|---|---|
| **the appended rows** | the mint runs over the rows an upload is BRINGING, and "Add Data" CONCATENATES, so the latch came off while every row already on screen kept its dead key | B refused → B presses the only file input the UI has → keys `["G1","G2","G3-X"]`, latch OFF, `Reco.setTag` on row 1 says **nothing**, `reco/extraValueMaster.json` gains **`G1`**, the colleague's upload of the same business row reads `G1-X=""` |
| **above `Reco.BUSY_ROWS`** | the chunked pass passes `from`=0 for the FIRST chunk, so `from == null` was false and the clear **never ran at all** | a 100,001-row load re-mints correctly (last `_pk` `B100000-ZZ`) and leaves the latch UP; typing into a row **that load minted** is refused for ever — on exactly the 500k-row extracts this app is for |
| **a declined load** | the head of the mint is ABOVE `Reco._keyIngestCheck`, which is the only place a load can be refused | the operator answers **no** to the key question, *"Nothing was loaded"*, and the latch is off with nothing re-keyed |

**THE FIX IS ONE SITE: `Reco._keyStaleLift(tpl, sess, mapped)`**, called from
`Reco._ingestAfterMint` on the line after `sess.data = sess.data.concat(mapped)`. It lifts the
latch only when the session holds **nothing but the rows that mint just keyed** (length, plus the
first and last row by identity). That is the first line at which the latch's own question — *is
every row on screen keyed by the folder's rule?* — can be **answered instead of assumed**, and it
closes all three holes at once: after the concat, after the refusal, and for the chunked pass and
the synchronous one alike.

**WHY THE WHOLE SESSION AND NOT PER ROW.** The verifier named three candidate fixes. Clearing
**per row** is kinder — typing into a row a later upload keyed correctly would work — and it cannot
be made safe: the routes that put a dead-keyed row on screen **without minting it** would hand back
rows no mark knows about (`Reco.loadVersionedFile` copies `_pk` straight out of the day file, and a
session restore does not go through the mint at all), and every door that writes a SET of rows — the
bulk offset, the selection sum bar, the Excel load-back's Apply — would need a partial refusal of
its own, which is the per-function-name mistake at row level. Making the **Load REPLACE** rather
than append while the latch is up was rejected too: it changes the meaning of the most-used control
in the app, conditionally on a rare state, and takes rows off the screen that the operator put there
(§5b's S14 says the concat is deliberate). What is left is one flag, one lift site, one sentence.
**The cost is a refusal on a row whose key is right**, and the sentence now names the route that
clears it.

#### THE REFUSAL'S SENTENCE, because it prescribed a recovery that does not work

T-24R2-1's refusal — and the latch's own sentence at every door — said *"press Load to read the rows
again"*. **There is no Load.** The only file input the UI has is **"Add Data"**
(`apps/Reco.html:18597`), and it concatenates (`18798`), so the operator who did exactly what they
were told kept their dead keys and the latch came off anyway. Both sentences now name **Clear Loaded
Data and then the load**, and say why Add Data is not it:

> Nothing was *saved / corrected / offset / unmarked / changed / overridden / reverted / grouped /
> removed from the group / commented / attached / loaded back from Excel*. Somebody else changed how
> this reconciliation identifies its rows while these rows were loaded, so the keys on screen are the
> OLD ones — anything filed against them goes where nobody else can see it, and anything meant to
> change a record on the shared folder cannot reach it. **Use Clear Loaded Data and then load the
> rows again** under the shared folder's rule, and try again. (Add Data on its own ADDS to what is on
> screen, so those rows would keep the old keys.)

Clear Loaded Data is the right recovery and not a consolation prize: its own confirm says what it
keeps — the typed values, the manual offsets, the corrections, the comments, the groups, the posted
entries and the version history — and what it costs is the rows on screen, the selection and the
page. The refusal says so too.

#### THE SIXTH DOOR: the Excel load-back's Apply

§18.9 declined to put the latch inside `Reco.rowKey` partly because *"the machine paths go through
it — the Excel load-back and `ingestData` have no operator at the keyboard"*. **Half of that was
false, and it was being used to excuse an open door.** `ExcelLink.apply()` is the **Apply button**
of the load-back review dialog (`apps/Reco.html:9222`), and its write at `9329` is
`Reco.applyEdits(tpl, sess, edits, { source: 'excel', … })` — the same pk-keyed shared store as
`Reco.setTag`. Measured after the refusal: a green *"Applied 1 change to 1 row(s)"* and **`E2`** in
`reco/extraValueMaster.json` while the folder's rule computes `E2-X`.

The latch is at **`ExcelLink.apply`** and **not** at `applyEdits`, which `ingestData` and the real
machine paths share and which must never tell a machine to load anything again. The review dialog
stays open, as it does for every other abort, so the operator's ticks are not thrown away.

#### T-S10-18, CLOSED — and the attachment door, measured at last

All four doors were measured open in one run (`w1_before.txt`), files and not toasts:

| door | what it said | what reached the share |
|---|---|---|
| `createGroupFromSelection` | **`success: Group "VG2" created with 1 member(s)`** | `reco/groupMaster.json` → members **`["E1"]`** |
| `addSelectionToGroup` | **`success: Added 1 new member(s)`** | `groupMaster` → **`["E2"]`** |
| `removeSelectionFromGroup` | **`success: Removed 1 member(s) from group`** | the **`E4`** membership filed while the keys were right **DELETED**, the colleague-visible copy left behind |
| `Comments._confirmAdd` | **`success: Comment posted`** | `reco/commentMaster.json` → `linkedPks` **`["E3"]`** |
| `Timeline._confirmUpload` | **`success: Uploaded: note.txt`** | `reco/attachmentMaster.json` → `linkedPks` **`["E5"]`** |
| `Reco._bulkUploadToRow` | **`success: Uploaded 2 of 2 files`** | `attachmentMaster` → **`["E1"]`** twice |

**The attachment door is the one T-S10-18 recorded as unmeasured, with instructions not to assume
either answer. It writes a pk-keyed shared record**, so it is latched like the rest, and it is asked
**before** the upload: a file that reaches the shared folder and is then linked where nobody can see
it is worse than one not saved at all. Verbs: *grouped*, *removed from the group*, *commented*,
*attached* — and the group and attach actions are latched at **both** of their entry points each,
because the rule is about the action. Only the **row** branch of the comment and attach dialogs is
latched: a group-linked comment or attachment is filed against the group's id, not a row key.
`Comments.removeForRow` and the attachment panel's own deletes stay unlatched for §18.9's stated
reason — their key comes from the stored master, not from a row on screen. The reversal comment
(`Reco.reverseEntry`'s one `Comments.create`) is unlatched for the same reason: its keys come out of
the posted entry's own un-stamp list.

#### A7, which was reported fixed and was not

`_mergeShared` collects the `both` list; `RecoTemplate._settleShared` returned at
`if (!said.length) return true;` **before `_askMerged`**, the one place the *"you and somebody else
both changed X"* sentence is said. So it only ever fired when the folder **also** changed a field
this editor had left alone — and the case the finding measured is the one where the ONLY difference
is a field both sides changed. Measured: the share settles to B's value (correct) and **B's confirms
are `[]`**. The fix is the verifier's: `if (!said.length && !both.length) return true;`, plus the
gate it asked for — **`_askMerged` must not claim to be keeping anything when nothing was kept**. A
bulleted list of nothing under *"those are being kept as the folder has them"* is how an operator
learns to click through a dialog, so the kept clause is now said only when `said` is non-empty.

#### Two sentence defects in the same question

* **"the offset tolerance", twice.** `_sayField` maps `toleranceMode` and `toleranceValue` to one
  label on purpose, so a colleague who changed both was listed twice. **De-duplicated where the
  question is built**, not at each push, so the next pair of fields that share a label cannot bring
  it back — and the team order's `displayOrderBy` / `displayOrderAt` stamps now carry the label of
  the field they stamp, so a published order is **one** bullet instead of three.
* **`displayOrderBy` is rewritten to the saving user on publish, and that is correct — a judgement,
  not a fix.** Every path that rewrites it has just put the publish confirm in front of **this**
  operator, naming the new order and what it changes for everyone (`orderMoved` gates both), so the
  stamp answers the question it is for: *who published the order that is on the folder now*.
  Preserving the previous publisher would make the stamp say a colleague published an order they
  never saw. What was worth fixing is the question, above.

#### The one-save name collision: REFUSED

Delete the added column **"Legacy"** and rename **"Vendor" → "Legacy"** in the same save. Measured:
the only question asked is *'Removing "Vendor" (3) also deletes 3 value(s)…'* — naming the column
being **renamed** — and afterwards the column called Legacy holds the **deleted** column's
`L1/L2/L3` while Vendor's `Acme/Bosch/Cummins` are gone, under a green *"Template saved to
database"*. The rename arm declines to migrate onto an occupied name, which is right (it would merge
two columns' records), so the rename quietly degrades into a removal with the wrong name in the
question.

**Fixed as a refusal**, beside the three name refusals already at the head of `saveTemplate` (a
padded name, a duplicate name, a file/added clash — all of which refuse rather than guess, because
"the option that loses data" is never the one to take). A record is filed against the column
**name**: there is one slot per name and this save needs two. The sentence names both columns and
asks for two saves, which work correctly today. **`_cid`-paired renames only** — on a column written
before the stable id the pair is the editor's SLOT (§18.3), which cannot tell a rename from a
removal plus a move, and refusing there would refuse a plain removal of the first of two columns.

#### What this round MEASURED and did not fix

> **THIS SUBSECTION'S COMPLETENESS CLAIM WAS FALSE, AND §18.11 IS THE ROUND THAT FOUND OUT.** What
> it says about the eighteen doors it walked is true and was re-measured twice. What it says about
> there being **ONE** remaining route is not: there were **FIVE**. A final verifier walked gestures
> with real mouse clicks and found four live controls that were never on anybody's list — sheet
> mode's **✓ Apply** and **↓ Fill Column**, the sheet-mode **fill-handle drag** and the **in-app
> Excel view's own cell edit** — and §18.11's own static enumeration then found **four more** that
> no human walk had named (sheet mode's **×**, Find & Replace's two doors and the **journal post's
> stamp**). The phrase *"any latched gesture"* was carrying the whole claim and no reader would
> have noticed. **Read the paragraph below as a description of eighteen doors, never as a count of
> the remaining ones.**

The report's own question — *can a row that was on screen before the refusal still be written under
its dead key by ANY gesture?* — has a second half. **Not through any of the eighteen latched
gestures while the latch is up**: twelve row-level doors plus the Excel Apply and T-S10-18's four,
measured against the files. **But yes through a route that is not a latch hole at all** (and, as
§18.11 measured, through eight controls that simply were not latched): `Reco.loadVersionedFile`
copies `_pk` straight out of the day file, and a day file written before the key change carries the
old keys for ever. Measured after a CORRECT recovery, with the latch properly down
(`probes/w4_dayfile.mjs`): reopening today's day file puts `K1/K2/K3` back beside `K1-X/K2-X/K3-X`,
the key cell shows the frozen `K1` so it looks ordinary, `Reco.setTag` on it says **nothing**, and
`reco/extraValueMaster.json` gains **`K1`**. `Reco.keyDriftCount` reads **3**, so the mechanism that
would carry a per-row mark already knows which rows they are.

It is **ticketed here and CLOSED in §18.11 — T-S10-19**, with the measurement, the three candidate
remedies and why they pull against each other. (It was also **bigger than this paragraph says**:
§18.11 measured **ten** doors going through on such a file, six of them in total silence, reaching
**all five** pk-keyed shared masters plus the day file — not one door and one file.) The short reason: this is reachable with no refusal in the story, by
anyone including the colleague who made the change, so it is not this latch's hole; it is what a key
change does to the files already on the share, which is exactly what #24's confirm warns about. The
fix that fits the house rule is a write-side arm on the DRIFT check — per row, not per session — and
it needs its own measurement of what happens to records already filed under both schemes.

#### The gates, failing first, and the mutations

`run_store_e2e` **[79]** R11a–R11q (the lift, the appended row, the declined load, the
Clear-and-Load control, and the lift above `Reco.BUSY_ROWS`), **[80]** R12a–R12n (the six doors and
their control) and **[81]** R13a–R13f (A7, the duplicate label, the collision). The new gate the
verifier asked for is **R11d**, which fires every door at an **OLD** row: §18.9's own control
R3s–R3v reads `sess.data[length-2]` and `[length-1]`, i.e. only the rows the reload minted, which is
why it could not see any of this.

**Failing first, in the tree, with the gates in and no app change: `612 passed, 26 failed`** — the
26 red are exactly the new assertions, and the 14 that were green on the unfixed build are the
premises and the Clear-and-Load controls, which proves the controls are not mirrors of the fix.
**After: `638 passed, 0 failed`.** Mutations, each a copy of the fixed file with ONE change reversed
and loaded through `APP_FILE` so `apps/Reco.html` is never touched (house rule 8): the lift reversed
reddens the R11 assertions and A4's own loop again; the Excel latch alone reddens R12a/R12b; the four
T-S10-18 latches alone redden R12c–R12k; the attachment door alone reddens its own two; A7's early
return reddens R13a/R13b; the de-duplication reddens R13d; the collision refusal reddens R13e/R13f.
**[79]**'s big-load arm asserts nothing about time (§16.4a) and the gate is cheap enough not to
need to: the rows are built in the page, and the arm REPORTS — never checks — **`ms: 3247`** for the
Clear, the 100,001-row chunked mint and the flush together. "This gate must not take ten minutes to
run" is a claim, so the arm carries the reading beside it.

**TWO FIXTURE LINES CHANGED IN A PRE-EXISTING GATE, and they are the third and fourth of this
round's adjustments** (§18.8 names two, the verifier found a third): `R3_RELOAD_AND_TYPE` and
`R3_RELOAD_BOTH` in **[71]** now call `Reco.clearSession()` before their load. Every assertion,
regex and message is untouched. The reason is the fix itself — those controls claim *"a reload
re-mints the keys and lifts the latch"*, and that is only true of a load which covers the session;
"Add Data" on its own re-keys what it appends and the latch stays up **by design**, which is what
**[79]** gates. Both controls were green on the unfixed build with the Clear in place, so the change
is behaviour-neutral where it stands.

**THE VERIFIER'S OWN PROBE, `probes/v5b_latchlift.mjs`, now reads 7 as-expected / 2 not — and the
two are BY DESIGN.** Its `Q5b-B2`/`Q5b-B3` load 100,001 rows by **Add Data into a session that
already holds four rows**, so under this fix the latch correctly stays up. `Q5b-A3`/`Q5b-A4` — the
blocker — are now green. **R11p/R11q** take the same big-load reading through the route the refusal
names, and they are green.

### 18.11 Round 6 — THE CHOKEPOINT: the question is asked at the WRITE, and a gate enumerates the writers

**If you read one paragraph of this document, read this one.** Four rounds closed this cluster by
listing the controls that write under a row key, and every round found more:

| round | what it added | claimed |
|---|---|---|
| 1 (A4) | `setTag`, `setOverride`, `revertOverride` | 3 doors |
| 2 (T-S10-16, §18.9) | `applyCorrection`, `manualOffset`, `smartUnmark`, `editCell`, `offsetSelected`, `bulkMarkOffset`'s two arms, `_xlOffsetSelectedRows` | +7, **closed** |
| 3 (§18.10) | the lift was wrong; `ExcelLink.apply`, the group, comment and attachment doors were open | +5, **closed** |
| 4 (a verifier with REAL MOUSE CLICKS) | sheet mode's **✓ Apply** (silent, a version row in the shared day CSV), **↓ Fill Column** (green *"Applied to 3 row(s)"*, three version rows), the **fill-handle drag** (green *"Filled 2 cells"*, two dead keys in `extraValueMaster`), the **in-app Excel view's cell edit** (silent, `E3.Vendor` while the folder's rule computes `E3-X`) | +4, **open** |
| 5 (this round's static enumeration) | sheet mode's **×** / Delete (`_ssClearActive`), **Find & Replace**'s single and bulk replace, and the **journal post's stamp** (`commitEntryFromPreview`, which also writes `entry.postedPks`) | **+4 that no human walk had named** |

The round-4 verifier wrote the diagnosis: *"the round's own diagnosis repeated a third time —
'T-F2-8 was applied to a list of functions rather than to a rule' — the rule is now written down at
`Reco._keyStale` and four pre-existing writers that satisfy it were never listed."* And: *"the suite
cannot see any of it: no section touches sheet mode or the Excel view's typing after a refusal, so
638/0 is honest about what it measures and silent about this."*

**The problem was never the list. The problem was that the list was the mechanism.**

#### The write paths, enumerated from the code

Every one of these gestures ends in a write to a pk-keyed record the whole team reads. Grepping for
every assignment into each master and every `Versioning.queueChange` gives **58 write sites in 44
functions**, and they funnel like this:

| what reaches the share | the funnel |
|---|---|
| a typed value / an override in `reco/extraValueMaster.json` | `Reco._extraValueFlush` — already "the one door for the values store" — reached for a row only through `Reco._setExtraTyped` / `Reco._setOverride`, whose single caller is **`Reco.applyEdits`** |
| a correction in `correctionMaster` | one write, in `Reco.applyCorrection` |
| a manual offset in `manualOffsetMaster` | five writes and two deletes, all of the shape `mm[pk] = { recoId, byUser: true }` / `delete mm[pk]` |
| a group membership in `groupMaster` | `Groups.addMembers` / `Groups.removeMembers`, from four controls |
| a comment's `linkedPks` in `commentMaster` | `Comments.create`, from two |
| an attachment's `linkedPks` in `attachmentMaster` | `Attachments.upload`, from two |
| a version row in `reco_data/<folder>/<MMM-YY>/<DD>.csv` | **`Versioning.appendChangesBatch`** — the single funnel for `appendChange`, `queueChange` → `flushQueue` and five direct callers |

**There is no single function.** `Reco.applyEdits` and `Versioning.appendChangesBatch` are the two
real funnels, and between them they miss the five masters that are written by plain assignment.
What every one of the 58 sites *does* share is one step: **a ROW becomes a KEY, in order to write.**
That step is the chokepoint, and it did not exist as a function, so this round made it one.

#### The chokepoint

```
Reco.writeKey(tpl, sess, row, verb)      -> the business key to file a record against, or null
Reco.writeVerKey(tpl, sess, row, verb)   -> row._pk for a day-file version row, or null
```

Both ask `Reco._keyWriteUnsafe`, which is where the rule lives, and both say the refusal with the
caller's **verb**. They are a drop-in for `Reco.rowKey(tpl, row)` at a write site, because every
write site already guarded itself with `if (pk)` — so a refusal is all-or-none with **no new
control flow at the call site**. `Reco.applyEdits` asks the same question once per edit and puts the
refusal in `res.rejected`, which `Reco._xlApply` and `Reco._afterOverride` already show.

**Why not inside `Reco.rowKey`** — the argument from §18.9 is unchanged and was re-checked against
the call sites: `rowKey` is a key **READER** on every render path (the renderer's row attribute and
every badge, the status / attachment / comment filters, `runAutoOffset`'s restore, the ⚠ drift
check, `Groups.resolvePk`, the timeline). Refusing there would blank the screen this rule exists to
keep **honest**; it runs once per row per render, so a 500,000-row extract would ask the question
half a million times per paint; and it cannot carry a verb, so the only sentence it could say is the
generic one. A write-side pair has none of those three problems: it runs once per record written, it
takes the verb as an argument, and no reader calls it. **The gate asserts the rule is not in
`rowKey`** (G82g), so nobody can "simplify" it back in.

**The gesture-level `Reco._keyStaleBlock` is kept ON TOP of it, not replaced by it.** At the gesture
the verb and the whole selection are in hand, so the refusal is **one sentence and all-or-none**
before anything is written. At the write it is unforgettable. Both, because either alone is worse:
only-at-the-gesture is four rounds of this document, and only-at-the-write gives a silent per-row
drop behind a green count.

#### ~~THE RULE IS ABOUT THE ROW, AND THAT IS WHAT CLOSES T-S10-19~~ — **THIS WAS WRONG, AND IT WAS NOT MERELY TOO WIDE. REMOVED IN ROUND 7 (§18.12, T-S10-21)**

> **READ THIS BEFORE THE REST OF THIS SUBSECTION.** Everything below about the per-row arm is kept
> because the reasoning is the thing the next person needs — it is the **third** time this trap has
> been walked into — but the arm itself is **gone** and the conclusion it reaches is **invalid**.
>
> **Why it is invalid, and not just over-wide.** The arm asked *"is `row._pk` still what this
> template's rule computes for this row NOW?"* and treated a disagreement as *"the template's rule
> moved"*. A frozen `_pk` is **supposed** to disagree with a recompute whenever the **row's own
> data** changed — that is what freezing a key means (§14.3) — so the inference has a second,
> ordinary cause that the comparison cannot see. Every feature of this app that EDITS A ROW
> produces it. The three "measured false positives" in the table below are therefore not a
> complete narrowing of a sound test; they are the first three members of an open-ended family,
> and round 7 measured five more in an afternoon:
>
> 1. a **correction of a key-feeding column** — handover §14's own worked shape, `CONCAT({Doc})`
>    over a file column — bricked the row: every later gesture refused with a sentence blaming a
>    colleague for a change nobody made, and the recovery that sentence names (Clear Loaded Data
>    and load again) is where the correction was actually lost. It also said **both** *"Nothing was
>    corrected…"* and a green *"Correction applied"*;
> 2. the **second edit** of a row whose key-feeding *editable* column was edited;
> 3. a **partial recompute** — `CONCAT({Base},"-",{Line})` with one component missing from this
>    month's file recomputes to `'E1-'`, a POSITIVE disagreement, so the documented C6 non-firing
>    (below) never covered §14.4's own example;
> 4. a **key formula that reads the clock** (`AGEING`), which the editor refuses on SAVE and
>    nothing re-checks when stored: not drifted today, drifted tomorrow, for every row;
> 5. **one bricked row refused "↻ Replace All" for an entire file**, because a control that writes
>    every row in the view asks about every row.
>
> All five are now named gates in `run_store_e2e` **[86]** (R17a, R17a2, R17c, R17d, R17e, R17b), so
> an arm cannot come back without clearing them — **and clearing them is not enough**: a sixth shape
> was always going to exist, which is the argument, and the honest test is a **signature**, not a
> value. See §18.12.
>
> **And the design note's own failure direction was backwards too**, further down: it says a
> mis-named owner *"shows up as a false positive the allow-list absorbs, rather than a silent
> miss"*. Measured, a mis-named owner is a **SILENT MISS** — the write is credited to a
> neighbouring function, and the neighbour is usually one of the guarded ones, so the write
> inherits somebody else's guard call and the gate goes green. Corrected in the code and in §18.12.

A template latch can only see *"somebody else changed the rule while I had rows loaded"*. It is
structurally blind to **T-S10-19**: rows handed back by a day file **written before** such a change,
in a window that did nothing wrong. **Round 6's answer, now removed**, was that
`Reco._keyWriteUnsafe` asks two things, in this order:

1. **the latch** (`Reco._keyStale[tpl.id]`) — one property read, and the better sentence;
2. **the row** (`Reco._keyRowDrifted`) — is `row._pk` still what this template's rule works out for
   this row *now*?

The latch is therefore an **optimisation and a wording**, not the mechanism. `Reco.keyDriftCount`
already named exactly the affected rows before this round, so the hook existed.

**The narrowing, and it was MEASURED before it was written** (`choke/logs/p2_rule.txt`). A naive
per-row drift test has three false positives, and every one of them would refuse ordinary work:

| case | `Reco.keyDrift` says | the write-side rule says | why |
|---|---|---|---|
| C1 a template whose key names no added column | not drifted | not drifted, **one property read** | every template before #24 |
| C2 an `_added_` row (+ Row) | not drifted | not drifted | it never had a business key to disagree with |
| C3 a **formula** key extra, the formula changed | **drifted** | **DRIFTED** | this is the harm; T-24R2-1 and T-S10-19 both |
| C4 a **`master_lookup`** key extra, a colleague saves the shared accounts master | **drifted** | **not drifted** | §14.3's frozen value working as designed. The rule did not move, the day file holds the key, and every surface in Reco is deliberately on it. A guard that fired here would refuse every gesture on every template with a lookup in its key, **for the life of the file** |
| C5 a key component containing `'\|\|'`, so `_pk` cannot be split back | **drifted** | **not drifted** | `getRowPK` joins with `'\|\|'` and escapes nothing, so drift is indistinguishable from an unsplittable key. Ingest already asks the operator about that row (§14.4) |
| C6 a key formula whose referenced column is not on the row | **drifted** | **not drifted** | `Formula.substituteTokens` turns a missing reference into `''` **silently**, so a row from a file with a different column set would otherwise read as drifted on every key it has |

So `Reco._keyRowCols(tpl)` returns only those key extras whose value the **row's own loaded columns
decide** — a `formula` whose transitive closure contains no master-reading extra — and
`Reco._keyRowDrifted` counts only a **positive** disagreement where the stored component can be
recovered and the recomputed one is a real value. **`Reco.keyDrift` is deliberately left alone and
the two now disagree on C4/C5/C6**, which is right: `keyDrift` answers the SCREEN's question (*is
this cell printing a recalculation?*) and is correct to say yes; this answers the WRITE's question
(*can I attribute the disagreement to the template's own rule having moved?*), which is narrower.

**What that leaves open, said plainly:** on a template whose key is a lookup into a shared master,
a day file written before the *lookup's configuration* changed is still writable under its old
keys. Those templates keep the colleague's-key-change latch and nothing more. The measurement is
`run_store_e2e` **R15i** and the exposure is recorded on **T-S10-19**.

#### THE GATE THAT CANNOT GO STALE — `run_store_e2e` [82]

This is the deliverable that matters most, because 638 green checks could not see four open doors:
**every assertion named a function somebody remembered.** [82] names none. It reads
`apps/Reco.html`, enumerates every write into each pk-keyed master (including through a local alias
such as `const mm = AppState.manualOffsetMaster[id]`) and every `Versioning` append, works out the
`Module.method` each write sits in, and **fails when one of those functions neither consults the
guard nor is on an explicit allow-list with a reason**. When it fails it prints the file, the line,
the master, the offending line of code and what to do — because a structural failure a reader cannot
act on gets commented out.

It is structural, so it will have false positives as the code moves. **That is designed for:**

- the **allow-list is the pressure valve**, and every entry carries a reason a reader can check
  against the code (the machine paths `Reco._replayJournal`, `App.importBackup`,
  `Reco.restoreSession`, `Reco._promoteCarryForward`; the column-keyed `Reco._renameExtraValueCol`;
  the stored-key deletes `Reco.removeCorrection` / `Reco.removeManualOffset` / the four
  `_dropExtraValue*`; `Reco.reverseEntry`, whose keys come from the posted-entry index;
  `Reco._setExtraTyped` / `Reco._setOverride`, whose one caller asks and inside which a refusal
  would become a **silent session-only write**; `Versioning.appendChange` / `flushQueue`, which are
  plumbing downstream of a guarded call site; and the `forTemplate` lazy-`{}` initialisers);
- a **stale allow-list entry fails too** (G82h). An entry that matches nothing is a reason nobody
  can check any more, and a list of those is how a pressure valve becomes a rubber stamp;
- the gate **self-tests** (G82b, G82c, G82d): it asserts it still FINDS at least 55 sites in 40
  functions, that the seventeen doors this round and the four before it are still found **and**
  still guarded, and that all six masters plus the day file are represented. A regex that quietly
  stops matching would otherwise make the whole gate green for ever, which is exactly the failure
  mode it exists to prevent.

> **ROUND 7: THE THREE PARAGRAPHS ABOVE WERE TOO CONFIDENT, AND ONE OF THEM WAS BACKWARDS.** An
> adversarial attack blinded this gate **eleven ways** while all eight assertions stayed green, and
> two of the eleven are ordinary accidents rather than attacks: `const bag = AppState.xMaster;`
> without a subscript (which ran the whole 672-check suite with the gate still reporting "58 write
> site(s)"), and the ordinary spelling `name: function (…) {` instead of `name(…) {`. A write at
> column 0 made the gate **CRASH**, inside this file's single `try/finally` with no `catch`, so the
> run died with no tally and [83]/[84]/[85] never executed. The self-tests above did not stop a
> class going dark either: three previously-closed doors fit **exactly** inside G82b's floor,
> decoy writes restored the slack without limit, and G82c was a hand-copied list of seventeen names
> with four guarded writers missing from it. And the **failure direction is wrong**: a mis-named
> owner is a silent MISS, not an absorbed false positive. All of it is fixed or admitted in
> §18.12; the numbers and the allow-list in this subsection are round 6's and are superseded there.

**And the behavioural gates the suite was missing.** [83] drives sheet mode's three buttons and the
in-app Excel view **from the rendered DOM** — real clicks on `✓ Apply`, `↓ Fill Column` and `×`,
real keystrokes into the Excel view's cell — after a key change, and then reads the shared day CSV
and `reco/extraValueMaster.json`; its control re-runs them after Clear-and-Load and asserts the
version row lands under the folder's own key. [84] is T-S10-19: the window that MADE the change,
latch down, presses Open Existing on today's day file, gets `K1,K2,K3,K1-X,K2-X,K3-X`, and **ten**
doors are fired at the dead copies and then at the live copies beside them.

#### The numbers

**Before, on `999b936` with the gates in and no app change: `13` of the new assertions red and
every pre-existing assertion green** (`choke/logs/store_failfirst.txt`) — the green ones are the
premises and the Clear-and-Load controls, which is what proves the controls are not mirrors of the
fix. **After: `672 passed, 0 failed`, twice** (baseline 638, so +34 checks). No test was weakened:
`git diff --numstat tests/e2e/run_store_e2e.mjs` reads **`906  0`** — nothing removed, no assertion
reworded, no byte-identity baseline touched.

**The mutations**, each a copy of the fixed file with ONE change reversed, loaded through `APP_FILE`
so `apps/Reco.html` is never written (house rule 8; `md5` identical before and after all six, and
`cmp` clean):

| mutant | what it reverses | what reddens |
|---|---|---|
| m1 | sheet mode's **✓ Apply** / **↓ Fill Column** unlatched | G82a, G82c, R14a, R14b, **and R15d–R15j**, because T-S10-19's walk fires those two doors as well |
| m2 | the **per-row arm** removed; the template latch is all that is left | G82f, R15d, R15e, R15f, R15j, R16c — **and nothing in [83]**, because the latch still covers the colleague's-key-change case. That is the measurement that separates the two arms |
| m3 | the **§14.3 narrowing** widened, so a `master_lookup` key extra reads as drifted | **R15i only** |
| m4 | sheet mode's **×** unlatched | G82a, G82c, R14c, R15d |
| m5 | the **`applyEdits` chokepoint** removed | G82a, G82c, R14e |
| m6 | **a new button added**, writing `manualOffsetMaster` without asking — the next person's control, which no behavioural assertion in the suite names | **G82a only.** This is the one that matters: 672 checks and only the static enumeration can see it |

**What G82a says when it fails**, from the m6 run:

```
✗ G82a EVERY WRITE INTO A PK-KEYED SHARED MASTER AND EVERY DAY-FILE APPEND IS INSIDE A FUNCTION
       THAT CONSULTS THE GUARD, OR IS ALLOW-LISTED WITH A REASON. 60 write site(s) in 45
       function(s) enumerated from the source.
apps/Reco.html:30191  in Reco.offsetEverythingOnScreen()  writes manualOffsetMaster
        const mm = AppState.manualOffsetMaster[id] = AppState.manualOffsetMaster[id] || {};
        FIX: take the key through Reco.writeKey(tpl, sess, row, '<verb>') for a master, or
             Reco.writeVerKey(tpl, sess, row, '<verb>') for a day-file version row, and add
             Reco._keyStaleBlock(tpl, '<verb>', sess, rows) at the gesture so the refusal is
             one sentence and all-or-none. If this write's key comes from a STORED master or
             from the machine rather than from a row on screen, add Reco.offsetEverythingOnScreen
             to this section's ALLOW list WITH THE REASON.
```

**The cost, as an operation count and never a clock (§16.4a).** `run_store_e2e` **[85]** offsets
2,000 selected rows in one gesture and counts `Reco._extraComputedValue`: a template whose key
names no added column pays **0** recomputes (`Reco._keyExtraSet` returns null and the question is
one property read — that is every template before #24 and every template keyed on a file column); a
formula-keyed one pays **4,110 for 4,000 questions**, i.e. one per question plus the grid's own
repaint of the ~110 rows on screen. The question is asked **once per record written**, which is the
whole reason it is not inside `Reco.rowKey` — there it would run once per row per **paint**.

T-S10-19's true size, measured by this round's own probe against `999b936`
(`choke/logs/p3_before.txt`): **ten of ten doors went through, six in TOTAL SILENCE**, and
`extraValueMaster` gained `K1,K2,K3`, `correctionMaster` `K2`, `manualOffsetMaster` `K3`,
`groupMaster` a membership `[K1]`, `commentMaster` a `linkedPks` `[K2]` and the day file five `Cn`
rows under `K1/K2/K3`. The ticket said six doors; it was ten, and the two the verifier had not
counted are sheet mode's and the drag's.

**One defect this round's own fix introduced, caught by the suite within the hour and worth the
warning.** The refusal is said once per gesture, not once per row, so a bulk offset over 500 rows
does not produce 500 toasts. The first build cleared that flag **one task later** (`setTimeout 0`).
Two gestures of the same action in succession — *create group from selection* then *add selection to
a group*, or the single attach then the multi-file drop — are separated by an `await`, not by a
task, so the **second was refused in total silence**: [80] R12e and R12k went red. It is cleared on
a **microtask** now, which cannot interrupt the synchronous row loop a bulk gesture is. A silent
refusal arriving by the back door of its own fix is exactly the shape this cluster is about.

### 18.12 Round 7 — THE PER-ROW ARM COMES OUT, ASK BEFORE YOU MUTATE, DOOR 22, AND AN UN-BLINDED GATE

**If you read one paragraph of this subsection, read this one.** Round 6's write-side chokepoint —
`Reco.writeKey` / `Reco.writeVerKey`, the row-to-key STEP made into a function and asked at every
write into a shared pk-keyed store — **is right and it is kept.** It is the first version of this
fix that is a rule rather than a list of function names, after four rounds of lists. What was built
**on top** of it was wrong, and an adversarial attack measured it three ways: it found a
twenty-second door, it blinded the static gate eleven ways, and it provoked false refusals that
destroy ordinary work. This round removes the wrong part, fixes the order in which every guarded
write happens, closes the door, and un-blinds the gate.

#### 1. THE PER-ROW DRIFT ARM IS REMOVED, AND THE REASON IS THAT ITS INFERENCE WAS INVALID

`Reco._keyRowDrifted` asked *"is `row._pk` still what this template's rule computes for this row
NOW?"* and treated a disagreement as *"the template's rule moved"*. **A frozen `_pk` is supposed to
disagree with a recompute whenever the ROW'S OWN DATA changed** — that is what freezing a key means
(§14.3) — so ordinary work read as drift. Three rounds in a row narrowed it and declared the
cluster closed; each narrowing was a list of the shapes somebody had thought of, which is the same
mistake as a list of function names one level up.

**Five measured false refusals, all on ONE window, with the latch DOWN and nobody else involved.**
Each is now a separate named gate in `run_store_e2e` **[86]**, and the failing-first run of those
gates against `5c1fb25` is `scratchpad/dataloss/unbrick/logs/FAILFIRST_store.txt`:

| # | the shape | what round 6 did | gate |
|---|---|---|---|
| 1 | **a correction of a key-feeding column** — §14's own worked shape, a key extra `CONCAT({Doc})` over a file column, and the operator corrects `Doc`, which is the Correction tab's whole purpose | said **both** *"Nothing was corrected… this reconciliation now works its keys out differently"* **and** a green *"Correction applied"*; `reco/correctionMaster.json` was never created; the row was left showing the corrected value with `_corrected_Doc` set; and **every later gesture on that row** (correct, offset, edit, group) was refused with a sentence blaming a colleague for a template change that never happened. The recovery it named — Clear Loaded Data and load again — is where the correction actually died | **R17a**, **R17a2** |
| 2 | **the second edit** of a row whose key-feeding *editable* column was edited. "A template column the template marks editable" and "a key formula over it" are both ordinary settings | the first edit went through in silence and filed its version row under the old key; the second was refused. The row bricked itself on first use | **R17e** |
| 3 | **a partial recompute.** The C6 skip only covered a recompute that was *wholly* `''` or `'#ERR'`, so §14.4's own `CONCAT({Base},"-",{Line})` with one component missing from this month's file recomputes to `'E1-'` against a minted `'E1-S1'` | a POSITIVE disagreement, so everything on that row was refused — and the documented non-firing was not what happened | **R17c** |
| 4 | **a key formula that reads the clock**, `CONCAT({Doc},"-",AGEING({Doc}))`, which `RecoTemplate._pkFormulaOk` refuses on SAVE and **nothing re-checks when stored** | not drifted today, drifted tomorrow, for **every row of that template**: the whole reconciliation goes read-only overnight with the colleague-blaming sentence | **R17d** |
| 5 | **one bricked row refused "↻ Replace All" for an entire file**, because `_replaceAll` asks about every row in the file before its loop | *"Nothing was replaced"* about all three rows, from a real click on the button | **R17b** |

**A sixth shape was always going to exist, and that is the argument.** The arm fires whenever a
row's own data has moved since its key was minted, and every feature of this app that EDITS A ROW
does that. Enumerating those features is the list this cluster has failed at four times.

**So `Reco._keyWriteUnsafe` asks the TEMPLATE LATCH only** — *"did the key DEFINITION change while
these rows were loaded?"* That is a property of the **template**, recorded when the definition
changes, and it cannot be confused with a row's own data changing. The latch was verified in both
directions by round 5 (it lifts after Clear-and-Load, stays up after an Add Data onto dead-keyed
rows, lifts above `BUSY_ROWS`, stays up on a declined load) and nothing here disturbs it. The
chokepoint's shape is unchanged — `writeKey(tpl, sess, row, verb)` still takes the row, because
[82] G82e reads that signature and because the signature fix below needs the row.

**`run_store_e2e` [82] G82f is now the INVERSE of what it was**, and deliberately: it asserted that
the question asks the row; it now asserts that the question is the latch and asks no per-row
recompute. Re-adding an arm fails G82f until somebody turns that check round *with [86]'s six gates
green* — which is the bar, and it is that high because three rounds running declared this closed and
were wrong.

**T-S10-19 LOSES ITS FIX AND IS RE-OPENED**, with the design the chokepoint round had already
identified written onto it. *(Round 8 built that design and closed it — §19. Everything in this
subsection about why the per-row arm had to go is unchanged and is still the reason a value
comparison must never come back; what changed is that the signature it names now exists.)* **Why per-row drift is not a substitute for it**, in one paragraph,
because this is the thing the next person needs: a *value* comparison answers "does this key still
come out of today's data?", which is a question about the DATA; what T-S10-19 needs answered is "was
this key minted by the rule that is in force now?", which is a question about the RULE. Record the
**rule's signature** on the row at mint time — a hash of the key extras' definitions, written beside
`_pk` and carried through the day file's control columns — and compare signatures, never values. A
signature mismatch cannot be caused by a correction, an edit, a fill, a missing column or the clock,
so it has none of the five shapes above. It is a schema change (a new control column, a migration
for rows that have none, and a decision about what an absent signature means) and it is a round of
its own. `run_store_e2e` **[84]** measured the hole instead of claiming it was shut: all ten
doors went through at a dead-keyed row and **R15e asserted positively** that records land under both
identities, so a future fix makes that check fail and gets re-read. *(Round 8 was that fix. R15d,
R15e and R15g are rewritten to the new behaviour — all ten refused, nothing on the share under a
dead key, and the all-or-none refusal disclosed — each with the before and after set out above it
in the suite. R15h and R15i are untouched.)* **R15j** keeps `Reco.keyDriftCount` alive, because it
names exactly the rows a signature check has to cover — and §18.11's claim that it was the hook that
made the drift check a safety control is withdrawn: it has **no reader in the app at all**, only
this suite, `run_pk_extras` G8 and these documents. *(Round 8 left it that way on purpose: it counts
VALUE drift, not RULE drift, so it is not the signature's counter and reusing it would have been the
round-6 conflation in a tidier form. §19 answers T-S10-19's question (c) with the refusal sentence
instead.)*

#### 2. MUTATE-THEN-ASK IS A BUG WHATEVER THE GUARD ASKS

`Reco.applyCorrection` wrote `row[colName] = newVal` and **then** asked for the key, so a refusal
left the row mutated, the screen saying the correction happened, `_corrected_<col>` set,
`reco/recoSessions.json` on the share carrying the changed value through `AppState.save()`, and **no
record anywhere** — behind two toasts, one green and one red. Find & Replace had the same order.

**ASK FIRST, MUTATE AFTER, at all eleven sites where a write-side guard can refuse.** The ask is
`Reco._keyAsk(tpl, sess, row, verb)`, which exists because `Reco.writeKey` answers `null` for **two**
different things — *refused* and *this template has no business key at all* (`Reco.rowKey` answers
`null` on a keyless template, which is most of them) — so a caller that must not mutate on a refusal
cannot read the answer off the key. The eleven: `Reco.applyCorrection`, `FindReplace._replaceOne`,
`FindReplace._replaceAll`, `Reco._xlOffsetSelectedRows`, `Reco.bulkMarkOffset`,
`Reco.offsetSelected`, `Reco.manualOffset`, `Reco._ssCommit` (both arms), `Reco._ssClearActive`,
`Reco._unmarkRows` and `Reco.commitEntryFromPreview`'s stamp.

**`_replaceAll` is now plan → ask → mutate**, all-or-none: the replacements are computed without
touching a row, every touched row goes through `Reco.writeVerKey`, and only then is a single cell
written.

**The gate is the ORDER, read out of the source** — `[82]` **G82m** — because after the per-row arm
came out the order is only *safe* at runtime because the gesture asked the same question a hundred
lines earlier, and an order that is safe by accident is the shape that came back three rounds
running. G82m names each site's own ask (not "any guard call in the function": the first version
matched the gesture-level `_keyStaleBlock` at the top of the function and stayed green when the
mutation was moved back above its ask — mutant `m21_mutate_first`) and requires it to be the nearest
ask above **every** occurrence of that mutation, within fourteen lines. The behavioural half is
**[87] R18a/R18a2/R18b**, which assert the row is **UNCHANGED** after a refusal — `row[col]` is what
it was, no `_corrected_` flag appeared, `sess.corrections` is empty, exactly one toast and it is red
— and that `reco/recoSessions.json` **on the share** does not carry the refused value.

**`_replaceAll`'s all-or-none: decided, and the decision is that there is nothing left to decide.**
The attack asked for per-row-skip-and-say-how-many or an honest disclosure. With the per-row arm
gone, *unsafe* is a property of the template, so every row in the view answers the same way: a
per-row skip could only ever skip all of them or none, and *"Replaced 0 of 2,000"* is a worse
sentence than one refusal. **All-or-none is kept and §15.6 is corrected**, because what §15.6
disclosed was the per-row cost — which no longer exists — and it never mentioned Find & Replace at
all.

**One defect this round's own fix introduced, caught by the suite within the hour.** The journal
post's stamp is over a `Map`, so `targets.some(...)` threw; and a bare `return` there would have
skipped the pending Special JV clear, the modal close and the single-use cleanup — the journal entry
is already written by that point, so abandoning the rest of the commit is worse than an unstamped
row, which the exception list exists to show. The ask now runs over `Array.from(targets.values())`
and guards the stamp block alone.

#### 3. DOOR TWENTY-TWO, AND THE SIX-MASTER LIST WAS NOT THE SET OF SHARED STORES

`Reco.openSpecialJv`'s completion callback wrote `primaryKeys` / `sentPks` — row keys taken straight
off the rows on screen — into `AppState.pendingSpecialJV`, which is in `AppState.PERSIST_KEYS`: a
**whole-file** write of `reco/pendingSpecialJV.json` that every colleague parses at boot. With the
latch UP, in a window that had just been refused a template save, it said only `success: Special JV
"TCHX" completed` and the share gained `sentPks ["E1","E2"]` while the folder's own rule computed
`E1-X`/`E2-X`. The consequence is the double post this whole cluster exists to stop: no colleague's
row matches the pending entry, so the rows whose JV has already been raised look **un-sent to
everybody**, including to the operator after a correct Clear-and-load, and can be sent and posted
again. Measured: `scratchpad/dataloss/unbrick/logs/repro_a3.txt`.

**Closed in two places.** The question is asked **at the gesture, before `SpecialJV.open`** — being
told after the operator has keyed a JV in another application is being told too late — and the keys
are then minted **through `Reco.writeVerKey`** in the callback, all-or-none, because the latch can go
up while the JV page is open. `writeVerKey` is the right half of the pair: this store is keyed on the
row's storage identity `_pk`, the same identity the day file and `SpecialJV.matchesRows` use, and
every row has a truthy one (§14.2) — so a `null` answer there means *refused* and nothing else. Gate:
**[87] R18c**, which asserts the JV page never opened, nothing green was said, and the file on the
share gained nothing.

**THE SIX-MASTER LIST WAS WRONG BECAUSE ITS EXCLUSIONS WERE NEVER WRITTEN DOWN.** [82] now carries a
`STORES` table that answers for **every** `PERSIST_KEYS` member and every `reco/*.json` the app
writes, **including the ones that hold no row keys and why** — and **G82j** / **G82k** read
`PERSIST_KEYS` and the `reco/*.json` literals out of the source, so a new shared store fails this
section until somebody answers for it. **G82l** fails on any entry whose reasoning is missing.

| store | holds row keys? | why / what covers it |
|---|---|---|
| `recoSessions` | **yes** — every row's `_pk`, and `sess.corrections` keyed by business key | it is the session serialised, so no gesture writes a key *into* it; what has to be true is that a refused gesture leaves the rows alone, which is G82m and [87] R18a2 |
| `extraValueMaster` | **yes** — `[tpl][pk][col]` | enumerated |
| `correctionMaster` | **yes** — `[tpl][pk][col]` | enumerated |
| `manualOffsetMaster` | **yes** — `[tpl][pk]` | enumerated |
| `groupMaster` | **yes** — `members` is a list of row keys | enumerated |
| `commentMaster` | **yes** — `linkedPks` | enumerated |
| `attachmentMaster` | **yes** — `linkedPks` | enumerated |
| `pendingSpecialJV` | **yes** — `primaryKeys` / `sentPks` / `inputData[]._pk` | **DOOR 22**, enumerated as of this round |
| `entryHistory` | **yes** — `entry.postedPks` | enumerated, and asked at the gesture in `commitEntryFromPreview` |
| `reco/reversals.log.{csv,json}` | **yes** — `unstamped` / `skipped` / `sessionOnly` | allow-listed with a reason: an **append-only audit log the app never reads back**, whose keys came from the posted-entry index on the share. A log recording a different key from the one acted on would be a worse log |
| `reco_excel/<folder>/_links/<id>.json` | **yes, in `key` identity mode** — `rebased` / `dismissed` are keyed `<row key>|<column>` | allow-listed with a reason: the keys come out of the **workbook the operator exported**, the records are that one export's baseline bookkeeping read only by its own review dialog, and the gesture that writes them (`ExcelLink.apply`) is latched |
| `recoTemplates` | no | keyed by TEMPLATE id; it holds the column and formula definitions — **including the key rule**, which is why saving it is what raises the latch |
| `aegTemplates` | no | keyed by journal-template id; column mappings and posting rules |
| `aegMaster` | no | the accounts master: ACCOUNT rows with their own Reference |
| `aegSettings` | no | folder-wide settings |
| `customMasters` | no | operator-defined lookup tables keyed by their own first column |
| `docNumberMaster` | no | DOCUMENT numbers mapped to an `accountingId` — checked against the code, not assumed |
| `reco/_corrupt/*.json` | no | a verbatim copy of a file that would not parse; nothing is keyed and nothing is read back |
| `reco/extraValues/*.json` | no | **not a separate store** — the split-file form of `extraValueMaster` (S11), written only through the enumerated `Reco._extraValueFlush` |

#### 4. THE STATIC GATE, UN-BLINDED — AND WHAT A TEXT GATE CANNOT DO

The gate is a **detector, not a safety mechanism**: the safety mechanism is the chokepoint, which a
gesture cannot get a key without going through. It ranks below everything above. But it was blind
**eleven** ways with all eight assertions green, and two of those are ordinary accidents rather than
attacks. Every shape is now graded in one second against 44 mutant files
(`scratchpad/dataloss/unbrick/logs/G82_MUTATION.txt`): **44 RED, and the shipped tree the only
green**.

| blind shape | outcome |
|---|---|
| `const bag = AppState.xMaster;` — the master taken WITHOUT a subscript. Ran the full suite at 672/0 with the gate still printing "58 write site(s)" | **FIXED** — the alias map matches `AppState.<master>` with or without a subscript |
| `name: function (…) {` and `name: (…) => {` instead of `name(…) {` — the write credited to the previous method, which is guarded. **An ordinary spelling, not an attack** | **FIXED** — four definition shapes are recognised |
| a `/* comment */` at the START of a write line — `codeOf` dropped the whole line, code and all. **Also an ordinary accident** | **FIXED** — comments are stripped from the line instead of the line being dropped |
| a write at **column 0** inside a method — the gate **CRASHED** (`codeOf(-1)` threw) inside the suite's single `try/finally` with no `catch`, so the run died with no tally and [83]/[84]/[85] never executed | **FIXED twice** — a write with no owner gets an empty body and fails G82a **by name**, and the whole section is wrapped so a defect in the detector is a red check (**G82z**) that names itself rather than taking the suite down |
| a `function foo()` declaration at the end of the file, credited to a method **10,708 lines** above it | **FIXED** — declarations are recognised, bodies end where their **braces** close, and **G82n** fails when a write is credited to a function with an implausible body (that is what a mis-attribution looks like from outside) |
| `AppState[nm][id][pk] = …` with a computed master name | **FIXED** — any `AppState[<expr>][…] =` is a site |
| `const MAP = { off: AppState.xMaster }; MAP.off[id][pk] = …` | **FIXED** — object-literal aliases are read |
| `const V = Versioning; V.queueChange(…)` | **FIXED** — module aliases are read |
| the write inside `new Function('…')`, spread over three lines so no single line names the master | **FIXED, and more bluntly than asked** — a text gate cannot read a constructed function body, so **every** `new Function` / `eval` is a site that must be guarded or allow-listed with a reason. There are three in the tree and all three are the formula engine |
| a new unguarded door **NAMED** `removeManualOffset`, so the allow-list matched it; and an allow-listed function **gaining** writes for ever, because the list is per FUNCTION | **FIXED** — every allow-list entry carries its **write-site census** (`sites` + the stores it writes) and **G82i** fails on any drift |
| `if (false) { Reco.writeKey(...) }` satisfying the GUARD text test | **PARTLY FIXED, honestly** — `if (false)` / `if (0)` / `if (!1)` blocks are stripped from the body before the test, because that is the measured shape. A guard call behind any **other** false condition, on a different row, or after an early return, still counts. **Only a parse plus a control-flow walk can answer that: T-S10-22.** |
| the four self-tests not preventing a class going dark: three closed doors fitted **exactly** inside G82b's floor; decoys restored the slack without limit; G82c was a hand-copied list of seventeen with four guarded writers missing | **FIXED** — **G82b**'s floor is raised to the current reading, **G82d** is now a floor **per store** so a decoy in one cannot cover a loss in another, **G82c** lists **all 22** guarded writers, and **G82q** fails if a writer becomes guarded without being added to that list, so the list cannot silently fall behind the code either |
| the design note saying a mis-named owner "surfaces as a false positive the allow-list absorbs, rather than a silent miss" | **FIXED IN THE PROSE TOO** — measured, it is a **silent miss**: the write inherits a neighbouring function's guard call. The note in [82] now says so, and §18.11's copy is marked |

**What a text gate cannot do, said plainly and ticketed as T-S10-22 rather than papered over:**
reachability (above); and a **master passed as a parameter** — `Reco._unmarkRows` receives the
offset master as an argument and writes through it, and the alias is declared in the CALLER, so the
enumeration sees the caller and not the helper. That one helper is pinned **by name** in G82m, which
is a list of names and is admitted as one. A real JS parse is the honest answer to both. A gate that
**crashes** and a gate defeated by `name: function (){` were not design limits; they were defects,
and they are fixed.

#### The numbers

**Failing first.** The six new behavioural gates and five of the static ones are RED against
`5c1fb25`'s app through `APP_FILE`, GREEN against the tree:
**`678 passed, 16 failed` → `694 passed, 0 failed`**
(`scratchpad/dataloss/unbrick/logs/FAILFIRST_store.txt` and `logs/store_run2.txt`). The sixteen are
G82a, G82c, G82e, G82f, G82m, R15d, R15e, R15g, R16b, R17a, R17a2, R17b, R17c, R17d, R17e and R18c.

**Every suite, one at a time, with the seven-glob sweep on the line after each run inside the runner
script** (`scratchpad/dataloss/unbrick/net2.sh`, `netdefault.sh`, `netstore.sh`): pytest 75 (1
skipped) · jv_core_unit 250 · e2e 73 · autoload 41 · xllink 65 · xlview 94 · reports 107 ·
grid_scale 100 · colorder 147 · pk_extras 170 · **store 694** (baseline 672) · correction 163 ·
panes 304 · reverse 256 · specialjv 123 · jv_engine 79 · jv_gen 107 · jv_wizard 119. **0 failed
everywhere.** All four byte-identity gates untouched and green (colorder T1 `76dffed`, pk_extras G1
`3047f82`, correction `d9957fc`, panes `5f61d76`).

**The +22, accounted for, so the total cannot hide the removal:** [82] 8 → 16 (**+8**); [86] new
(**+9**); [87] new (**+5**); [84] stays at **11 checks** and [85] at **3**, so the two sections that
lost assertions do not show it in a count — which is why the five are named here.

**THE FIVE ASSERTIONS THAT WENT**, each one a thing the per-row arm itself guaranteed and nothing
else can:

| removed | what it asserted | what replaces it |
|---|---|---|
| **R15d** | every one of the ten doors is REFUSED at a row the day file handed back | a new **R15d** asserting they go THROUGH, naming T-S10-19 as open |
| **R15e** | ...and not one of them also says something green | a new **R15e** asserting POSITIVELY that records land under both identities on the share, so a future fix makes it fail |
| **R15f** | nothing reached any of the five shared masters or the day file under a dead key | a new **R15f**: the healthy copies still work (the ordinary path is not what broke) |
| **R15g** | the CONTROL that the question is per ROW and not per template — the arm's own justification | a new **R15g**: "↓ Fill Column" fills the whole filtered view again |
| **R15j** | "↓ Fill Column" is refused even from a healthy cell — the arm's disclosed cost | folded into the new R15g, and **§15.6 is corrected** |

**R15h and R15i are KEPT unchanged** (the control's records land under the folder's keys; a
`master_lookup`-keyed template is writable), and a new **R15j** keeps `Reco.keyDriftCount` alive for
the signature round. **Two assertions were INVERTED rather than removed**, deliberately and with the
same IDs, so that re-adding the arm fails them: **G82f** (asked the ROW → asks the LATCH only) and
**R16b** (one recompute per question → **zero**).

**`git diff --numstat tests/e2e/run_store_e2e.mjs` against `5c1fb25` reads `1077 227`.** The 227
removed lines are the whole of the old [82] (replaced in place, 8 checks → 16), the five assertions
above and the three R16 texts. No assertion was loosened to pass: every removal is an assertion
about the arm that no longer exists, and every one is named here.

**Mutation evidence.** 44 mutant files graded through the real [82], each one copy-with-one-change
loaded by path so `apps/Reco.html` is never written: the attack's own 22, the same shapes rebuilt on
this tree (18), plus three of this round's own — `m20_rearm` (a per-row arm put back) reddens
**G82f**; `m21_mutate_first` (applyCorrection's mutation moved back above its ask) reddens
**G82m**; `m23_sscommit_order` (sheet mode's single-cell ask moved below its mutation) reddens
**G82m**; `m22_new_persist_key` (a new `PERSIST_KEYS` member nobody answered for) reddens **G82j**.
44 RED, 1 green, and the green one is the tree.

**No test was weakened and no baseline moved.** `git diff --numstat tests/e2e/run_store_e2e.mjs`
against `5c1fb25` is additive except for the six replaced R15 assertions and the three rewritten
R16 ones, each named above with its reason; the four byte-identity gates are untouched.

---

## 19. Round 8 — T-S10-19: THE KEY RULE'S SIGNATURE, RECORDED ON THE ROW AT MINT TIME

**If you read one paragraph of this section, read this one.** The question *"can this row be written
against?"* has been asked five different ways in eight rounds. Four rounds answered it with a LIST
of the gestures that write, and each list was wrong. Round 6 moved the question to the WRITE, which
is right and is kept — but asked it as *"is `row._pk` still what the rule computes for this row
NOW?"*, which is a question about the **DATA**, and a frozen `_pk` is **supposed** to disagree with a
recompute whenever the row's own data changed (§14.3). Round 7 removed that and left T-S10-19 open
and measured. Round 8 asks the question the ticket always needed: **"was this key minted by the rule
that is in force now?"** — a question about the **RULE** — by recording the rule's **signature** on
the row when its key is minted and comparing signature to signature. A signature cannot be moved by
a correction, a cell edit, a fill, a replace, a carried value, a column this month's file does not
carry, or the clock, because not one of those is in it. **If you find yourself comparing a key to a
recompute, you have rebuilt round 6: read §14.3 and §18.12 and stop.**

### 19.1 What was open, measured before anything was changed

The window that **made** the key change, with the latch correctly DOWN and nothing wrong anywhere in
its story, presses **Open Existing** on today's day file and gets the same three business rows on
screen **twice**, under two identities, with the key cell showing the frozen value so neither copy
looks unusual. Reproduced on `55171d8` from round 7's own probe, re-ported
(`scratchpad/pksig/build/probes/r1_tendoor.mjs`, port 21480,
`scratchpad/pksig/build/logs/r1_tendoor.txt`):

| door | what it said | what reached the share |
|---|---|---|
| `setTag` | **nothing at all** | `reco/extraValueMaster.json` → `K1` |
| `applyCorrection` | a green *"Correction applied"* | `reco/correctionMaster.json` → `K2` |
| `manualOffset` | **nothing at all** | `reco/manualOffsetMaster.json` → `K3` |
| `editCell` | **nothing at all** | a `Cn` row under `K1` in the day file |
| `createGroupFromSelection` | a green *"Group "G19" created with 1 member(s)"* | `reco/groupMaster.json` members `["K1"]` |
| `Comments._confirmAdd` | a green *"Comment posted"* | `reco/commentMaster.json` `linkedPks ["K2"]` |
| sheet mode **✓ Apply** | **nothing at all** | a `Cn` row under `K1` |
| sheet mode **↓ Fill Column** | a green *"Applied to 6 row(s)"* | `Cn` rows under `K1/K2/K3` |
| sheet mode **×** | **nothing at all** | a `Cn` row under `K3` |
| the **fill-handle drag** | a green *"Filled 2 cells"* | `extraValueMaster` under `K1`…`K3` |

**Ten doors, and not one of them said anything in error.** Five were in total silence and five said
only something green. *(The ticket said "SIX of them in total silence"; measured on this tree it is
**five** silent and five green-only. The count is corrected here rather than repeated.)* The day
file's header was `_pk,_ver,_ts,_src,_by,Doc,Line,Amount` — no signature anywhere — and
`Reco.keyDriftCount` already named exactly the three affected rows.

### 19.2 The signature: what is in it, and the one thing that is deliberately not

`Reco.keyRuleSig(tpl)` = `'1:' + fnv1a64(canonical(RecoTemplate._keyRuleDefOf(tpl)))`, sixteen hex
digits, e.g. `1:f21c738dfe7fc3fe`.

> **THIS WAS `_keyDefOf` WHEN ROUND 8 WAS BUILT AND IT WAS A BLOCKER. The review pass corrected it
> and the argument that was offered FOR `_keyDefOf` is the thing to read, because it is the mistake
> and it reads like a virtue.** That argument was: there is only one definition of "the key rule" in
> the file, so *"a change that raises the latch"* and *"a change that moves the signature"* are the
> same set **by construction**. Both skeptics found independently that this is the defect.
> `_keyDefOf` keeps the **whole stored column object**, so display and ownership flags the key
> engine never reads were in the hash, and **four edits an operator can make through the editor's
> own handlers moved the signature while the rule went on computing BYTE-IDENTICAL keys** — ticking
> *Allow manual override per row* on a key helper, ticking *Carry this value forward* on one, a
> MIS-CLICK on a key extra's type dropdown clicked straight back (`_setExtraType` leaves three
> dropdown defaults behind for ever, invisible in the editor, with no control that removes them),
> and reformatting a key formula. Every row minted before was then refused at every door with its
> key exactly what the folder's rule computes: **round 6's harm with a different cause**, which is
> the one thing this round was told not to rebuild.
>
> **THE ASYMMETRY THE "same set by construction" ARGUMENT MISSES:
> over-approximating is CHEAP IN A WARNING and RUINOUS IN A REFUSAL.** The latch and T-24R2-1's
> confirm are warnings, so they **keep the coarse `_keyDefOf`** and may go on firing on a detour.
> The signature refuses, so it needs the narrow projection. One definition of "the key rule" was
> the right instinct and `_keyRuleDefOf` keeps it — same `primaryKeys`, same `Reco._keyDepNames`
> closure, same walk; one definition of "which BYTES of it matter" was the error.

- **A PROJECTION of `_keyDefOf`'s walk, per type, down to what `Reco._extraOwnValue`'s ladder
  actually reads.** `primaryKeys` in order, the closure's names in **declaration order**, and per
  closure column: the normalised `type`; for `formula` the formula text; for `master` the
  `masterRefColumn`/`masterValueColumn` pair; for `master_lookup` the four fields
  `Masters._lookupCfg` resolves (`source`, `matchColumn`, `matchKey`, `returnKey`) — that function
  is already the one place that says what a lookup's rule IS, so this cannot drift from it. For
  `dropdown`/`custom`: the name and the type and **nothing else**.
- **`carryForward` IS NOT IN IT ON ANY TYPE, AND THE CLEANUP ROUND TOOK IT OUT — the fifth instance
  of the shape the review found four of.** The round-8 build recorded it for `dropdown`/`custom`
  *"because `Reco._extraTyped` reads it as the SCOPE test and it therefore decides WHICH typed
  record becomes the value"*. That reason is not live on the MINT path, for two independent measured
  reasons (**[88] R19s**, both halves in one fixture). **One: a dropdown or custom column cannot be
  in a key's closure at all.** `RecoTemplate._pkEligible1` refuses it by TYPE — *"you type this
  column in by hand, so its value is not worked out from the data"* — and `_pkFormulaOk` refuses a
  key FORMULA that **reads** one for the same reason, so `saveTemplate`'s prune empties
  `primaryKeys`; measured through the real save for both types. **Two: and past the save, by hand,
  the flag still cannot reach a minted key.** `Reco.ingestData` reserves `row._pk = ''` before the
  mint and `_mintKeysSync` assigns the key only AFTER computing it, so `Reco.storeKey` is null for
  every row the mint walks, `_extraRec` finds nothing and `_extraTyped` returns at its RECORD test —
  **above** the line that reads `carryForward`. The same file row and the same stored record mint
  the same key with the box on and off. **And that half is not blind:** the same record on a row
  that HAS the key is readable with the flag on and scoped out with it off, and
  `Reco._extraOwnValue` — the mint's own value function, the one `_keyScratch` calls — answers
  `OPEN` with the flag on and `''` with it off over that row. The scope test is real; it is only
  unreachable while a key is being minted. That is §14.3 exactly: **the key is frozen, the cell is
  not.** **And a third reason, the oldest of the three:** `RecoTemplate._exclusiveRoleConflict`
  treats `pk`, `allowOverride` and `carryForward` as **exclusive roles** — *"three different answers
  to who owns its value"* — so a column that **is** part of the row key cannot hold the carry flag
  at all, refused in both editors and in both directions (§5c). So recording the flag bought nothing
  and cost a refusal of every earlier row of the reconciliation the moment somebody ticked the box.
  Keeping one field of `_keyDefOf`'s over-approximation would have been the same mistake one field
  smaller.
- **WHAT IS OUT, AND WHY LEAVING IT OUT CANNOT MISS A RULE CHANGE.** `allowOverride` is never read
  where the value is **read** — `Reco._extraOverride` honours a stored override record whether the
  box is ticked or not, and the box gates the WRITE at `Reco._setOverride` — so ticking it cannot
  change what the rule computes for any row. The option list, `optionsSource` and `optionsMasterCfg`
  constrain what an operator may **choose**, which is data, and `row[ac.name] != null` wins over all
  of it in `_extraOwnValue`'s tail. `_cid`, `label`, `_ssSingleUse` and every display flag are not
  on the value path at all. `carryForward` on a **computed** column is unread for a second,
  simpler reason as well — the computed arms return `_extraComputedBase` and never reach
  `_extraTyped` at all — which is the second of the four shapes; the bullet above is why it is out
  for the typed types too.
- **THE CLOSURE'S DECLARATION ORDER IS IN, and `_keyDefOf` could not carry it at all** because its
  `defs` is an object keyed by NAME and the canonicaliser sorts object keys. `Reco._keyScratch`
  materialises the closure in declaration order, so moving one closure column past another
  genuinely changes what the key comes out as. **[88] R19r** gates it; the mutant that drops it
  (`m12_noorder`) reddens exactly that.
- **WHITESPACE OUTSIDE A STRING LITERAL IS LAYOUT, NOT RULE** (`Reco._keyCanonFormula`), and the
  difficulty is the half that must NOT be canonicalised: in `CONCAT({Doc}," - ",{Line})` the spaces
  inside the quotes **are** the rule, so `" - "` and `" -  "` must stay different signatures —
  collapsing them would hash two DIFFERENT rules the same and leave a dead key **not refused**,
  which is the whole harm this ticket exists for. It reuses `Formula._compile`'s own literal
  pattern, the one place that already decides what counts as a string in a formula, and **bails out
  to the raw text** on a backtick (a template literal that pattern does not model) or an
  unterminated quote. **The bail-out direction is deliberate**: its cost is a formatting edit of
  that one formula moving the signature, under `saveTemplate`'s own confirm, and the cost of
  guessing would be a dead key nothing refuses. Only one of those two is allowed to be wrong.
  **[88] R19t**.
- **A canonical text, not `JSON.stringify`.** Object keys sorted, recursively. `JSON.stringify`
  emits properties in insertion order, so two colleagues' builds holding the same definition with
  its fields written in a different order would hash differently and refuse each other's rows — on
  a folder where a mixed fleet is already a live problem (T-S10-12). Nothing behavioural can catch
  that, because every fixture builds its template in one program in one order, so it is asserted
  directly: **[88] R19o**.
- **NOT the master's rows, and that is the design rather than an omission.** A `master_lookup` key
  extra's CONFIG is inside `_keyDefOf`, so re-pointing a lookup moves the signature. The accounts
  master's DATA is not: a colleague adding a nominal code changes what the key *would* compute
  without changing the rule that minted it, the day file holds the minted key, and every surface in
  Reco is deliberately on it (§14.3). Hashing those rows would be round 6 by another route and
  would refuse every gesture on every lookup-keyed template. **[88] R19p** asserts the hash itself,
  with the memo bypassed — see §19.6, because that check exists only because a mutant survived
  everything else.
- **Null when the key names no added column**, which is every template that existed before #24.
  `Versioning._fields` reads the same answer, so the day-file header's width is a property of the
  TEMPLATE and never of which rows a write happens to carry. **T-S10-25** carries what that leaves
  open.
- **Versioned, and compared only within a version.** The hash's INPUT is a format. A future round
  that changed what is hashed would otherwise make every row minted by this build read as *"a
  different rule"* and take those reconciliations read-only overnight — R17d's shape arriving
  through this fix's own front door. So a signature whose version this build does not recognise is
  treated as **absent**, i.e. not refused, and **bumping `Reco.KEYSIG_VER` is a migration that has
  to be written down as one**. **[88] R19n**.
- **It is a RULE hash and not a TEMPLATE hash.** Two templates with the same key rule share a
  signature, and that is fine: every comparison happens inside one template, and every pk-keyed
  store is `[tplId][pk]`. It is also a small virtue — two colleagues' identically-defined templates
  agree.

### 19.3 The five sites, and the two hazards the ticket's design did not name

| # | site | what had to change |
|---|---|---|
| 1 | `Reco._mintAcc` / `Reco._mintKeysSync` | the signature is computed **once per mint pass** onto the accumulator (which the chunked mint shares across chunks, so 500,000 rows pay one hash) and stamped as `row._pksig` on every row that got a **business** key. Not on an `_auto_` row: its identity is a throwaway uid no rule computes, so no rule change can detach it and refusing it later would be a false refusal — the same line `_keyFrozenPart` draws |
| 2 | `Versioning._fields` | **HAZARD ONE, CONFIRMED REAL.** The control list was fixed at five and the function also sweeps **every key present in any row** into the header, so a per-row signature lands in the CSV **by accident** and the header's WIDTH then varies between writes — a batch of pre-change rows, or an `_auto_`-keyed append, writes a narrower file and the next write widens it again. Each widening is a whole-file rewrite inside `append_csv_rows` (`main.py:683`), which is the rewrite that function's own comment says can lose a colleague's concurrent append. So `_pksig` is in the **FIXED** list — **but only when `Reco.keyRuleSig(tpl)` is non-null**, which is the one correction to the orchestrator's reading and is load-bearing: unconditional, it reddens four assertions in four suites that pin this header verbatim (`run_e2e:144`, `run_autoload:123`, `run_colorder:1491`, `run_reverse:416`) and `run_pk_extras` **G1**'s byte-identical day file, which is #24's own acceptance bar |
| 3a | `Versioning.appendUpload` | **the orchestrator's reading named only `appendChangesBatch`, and this is the write that puts the signature in the day file in the FIRST place.** Without it there is nothing for a reopened row to bring back |
| 3b | `Versioning.appendChangesBatch` | the `Cn` record is `{_pk,_ver,_ts}` + `tpl.columns` only, so an append drops it. Without this, **one edit launders a protected row into an unprotected one**: `collapseToActive` keeps the latest version per key, so the `Cn` row is what a reopen reads |
| 4 | `Reco.loadVersionedFile`'s row literal | **HAZARD TWO, AND IT IS THE WHOLE TICKET.** Set only when the file carries one, so a pre-change row gets **no property at all** rather than an empty one and is byte-identical to what that line built before; `_dsi` still goes last |
| 5 | `Reco._keyWriteUnsafe` / `_keyRowsUnsafe` | the template latch stays FIRST, unchanged and undisturbed, then `Reco._keySigMoved(tpl, row)`. The second gets its own refusal sentence |

**The orchestrator's reading was right at all five sites and incomplete at two:** site 3 is two
record builds, not one, and site 2 has to be conditional on the template or four suites nobody may
edit go red. Both corrections are in the code comments at those lines.

### 19.4 The sentence, and why there are THREE now

> **ROUND 8's REVIEW PASS REWROTE THIS AND THE OLD TEXT IS LEFT BELOW BECAUSE IT IS THE LESSON.**
> The sentence quoted further down said two things that are FALSE in the commonest case, and the
> claim made for it — *"produced only by a signature mismatch, so what it says is true every time
> it is said"* — is what to distrust. It was measured saying *"This row came back from a **SAVED DAY
> FILE**"* and *"**Nobody has changed anything** while you had these rows open"* to an operator
> whose own template save, ten seconds earlier, had moved the signature under rows
> `Reco.ingestData` had minted in that same window and no file had ever handed back. **Round 7
> deleted the previous second sentence for exactly this** — it blamed a colleague for a template
> change that had never happened — so blaming a FILE instead is the same mistake with a different
> object. And the recovery it named, *Clear Loaded Data and then load the extract again*, was
> measured going round a loop that cannot help for a day file older than the edit: last week's rows
> live only in last week's file, loading the extract again brings back a DIFFERENT day's rows, and
> reopening the file brings the old keys back every time. That is the *"Press Load"* defect round 5
> fixed, reintroduced for a different set of rows.
>
> **THE DISCRIMINATOR IS A FACT THE CODE ALREADY HAD, which is why this is a correction and not a
> new mechanism.** `Reco.ingestData` stamps an upload's data set id with a `#u<n>` suffix and
> `Reco.loadVersionedFile` does not (it sets `sess.dataSetIds = [fullPath]`), so `Reco.dataSetOf`
> tells a row this window minted from one a file handed back — **exactly, and per row**, which
> matters because a reopened file plus **Add Data** puts both kinds on ONE screen.
> `Reco._keyOldRuleWhy` returns one of three:
>
> | branch | when | what it says |
> |---|---|---|
> | `oldrulemine` | the row's data set id carries `#u` | the rule *"was changed **AFTER** these rows were loaded"*; **Clear Loaded Data and load the extract again** — which really does re-key them |
> | `oldrulefile` | it does not | the key *"was minted under a **DIFFERENT** row-key rule"*; *"Opening that day file again will keep bringing the old keys back — **nothing re-keys a saved file**"*; load **that day's EXTRACT** again; and *"Every day file this reconciliation wrote under the previous rule is read-only in the same way"* |
> | `oldrule` | there is no data set id (a `+ Row` row, or a session older than S14) | only what is true either way, claiming **neither** |
>
> **NO BRANCH SAYS "Nobody has changed anything", AND NO BRANCH CLAIMS A DIRECTION.** The old
> sentence said the file was written *before* the rule changed; `App.importBackup` puts an OLDER
> rule back under a NEWER day file, so that is backwards in a real case (skA A7, and `T-S10-26`
> carries the missing confirm). **[88] R19u / R19u2 / R19f** gate all of it — R19u with a POSITIVE
> source clause, for G82f's reason: a mutant that hard-coded one branch left every behavioural
> check green.
>
> **AND "THE SIGNATURE IS SHOWN NOWHERE" WAS HALF WRONG.** Not showing the hash is right — sixteen
> digits is a string no operator can judge. But *"this row cannot be written"* has to be visible
> **before** the gesture, the way an overridable cell already refuses typing in the cell rather than
> after it: the same business key was measured on screen TWICE, one copy refused and one writable,
> with both rows rendering the same class, no title and no badge, and `Reco.keyDriftCount` reading
> **zero** because it counts VALUE drift and nothing had drifted. There is now a **row** badge
> (`⊘ older rule`, guarded on `row._pksig` first, so no template that existed before this round
> renders a byte differently) and `Reco.keyOldRuleCount(tpl, sess)` for the number a
> Clear-and-load decision needs. It goes on the ROW and not on the key cell because the key extra
> is often not in `displayColumns` at all — it was not in the fixture where this was measured
> missing. `keyDriftCount` is still left alone: different question, different answer. **[88] R19x**.
> The toolbar surface and a *"show only rows from an older rule"* filter are **not** built and are
> on **T-S10-27**.

#### The round-8 build's own text, kept for the record — SUPERSEDED, AND NOT WHAT THE APP SAYS

**Everything from here to the end of §19.4 is the BUILD's write-up and the sentence it shipped,
which the review pass then replaced with the three branches above.** Nothing in it is live. It is
kept because the argument is the useful part and because this cluster has twice shipped prose that
said the opposite of the code, so a deleted mistake is a mistake nobody can check.

Round 7 deleted the second refusal sentence because nothing could produce it, and because the one it
deleted (*"These rows carry the keys they were SAVED with"*) was produced by the per-row drift arm
on ordinary work and **blamed a colleague for a template change that had never happened**. The build
believed something could produce a second sentence again, and that it said something true every
time it was said:

> *"Nothing was saved. This row came back from a **SAVED DAY FILE** that was written before this
> reconciliation's row-key rule was changed, so the key on it is the OLD one — anything filed
> against it goes where nobody else can see it, and anything meant to change a record on the shared
> folder cannot reach it. **Nobody has changed anything while you had these rows open: the file is
> simply older than the rule.** Use Clear Loaded Data and then load the extract again, and try
> again. (Add Data on its own ADDS to what is on screen, so those rows would keep the old keys.)"*

**And it was not true every time it was said**, which is the finding above: the operator's own
template save reaches that branch, and *"written before"* claims a direction the code cannot know.
Both halves are now asserted **absent** from all three branches (**[88] R19u2**, **R19f**).

Saying the **latch's** sentence here would be the round-6 mistake in prose, which is why **[88]
R19f** asserts which sentence is said and that the other one is not. The sentence is also the
answer to T-S10-19's question (c): the signature is shown **nowhere else**. A sixteen-digit hash is
a string no operator can judge (T-S10-24's own complaint about row keys in a confirm), and a badge
on the key cell would collide with `Reco.keyDrift`'s existing **⚠ recalculated**, which answers a
different question and would read as *"the key is wrong"* — and the key is exactly right for the
file it came from. `Reco.keyDriftCount` is left alone and still has **no reader in the app**: it
counts VALUE drift, not RULE drift, so it is not this arm's counter. **A SECOND READERLESS COUNTER
WAS ADDED, AND THE BUILD'S SENTENCE HERE SAID OTHERWISE:** `Reco.keyOldRuleCount` has no reader in
the app either — the toolbar surface is **T-S10-27** — and **[88] R19x2** reads it beside the badge
on a rendered screen so it cannot rot unmeasured.

### 19.5 The migration, the format change, and both back-compat directions

**A row with NO signature is NOT refused.** Every row on every share before this round has none, and
refusing them would make the app read-only on the day it ships. So this protects only rows minted
after it. An empty string counts as none (Papa gives `''` for a present-but-empty column), and an
unrecognised version counts as none.

**The format change, plainly.** For a template whose key names an added column, the day file's
header becomes `_pk,_ver,_ts,_src,_by,_pksig,` + the template columns — **in a day file this build
CREATES**. For a template-column key nothing changes at all.

> **A DAY FILE THIS BUILD DID NOT CREATE IS NOT WIDENED, AND THAT IS A ROUND-8 REVIEW CORRECTION OF
> THE MOST EXPENSIVE KIND: THE BUILD'S OWN COST NOTE WAS AN UNDERSTATEMENT OF A DATA LOSS.** It
> said the first write into a pre-change day file takes *"one whole-file rewrite … it happens once
> per file, and it is the migration"*, and that *"it is the rewrite that can lose a colleague's
> concurrent append"* — correctly naming the hazard and then pricing it as a one-off. **Measured,
> in two separate PROCESSES against the real bridge** (two windows are two processes;
> `LauncherAPI._writing` is a per-path lock INSIDE one): a 120,000-row pre-`_pksig` day file, this
> build appending one signed row, a colleague appending 0.00 / 0.15 / 0.40 / 0.80 s later. **In the
> first THREE both writers reported success, the header widened, and the COLLEAGUE'S ROW WAS NOT IN
> THE FILE** — 120,001 rows where 120,002 were written. At 0.80 s, past the end of the 672 ms
> rewrite, both survived, so the loss window is exactly the length of the rewrite. And it is **not**
> once per file ever: every append goes to TODAY's day file and today's file belongs to whichever
> build writes it first, so while **any** colleague is on an older build (T-S10-12 calls a mixed
> fleet the normal state) it is one rewrite per template **per day**, bigger the later in the day it
> happens. `Versioning._fields`'s own comment has warned about that rewrite since `_src`/`_by` were
> pinned into the header to avoid it; **adding a sixth control column is what finally made it
> happen.**
>
> **SO `Versioning._appendRows` ASKS FOR THE HEADER FIRST** (`Versioning._headerOf`, memoised per
> path — free on the `appendChangesBatch` path, where `_maxCn` has already read the file) and, when
> the file exists and its header has no `_pksig`, takes the column off the **fields** AND off the
> **records**. Both, because `append_csv_rows` unions its `fields` with every key present in any
> row, so leaving it on a record widens the file anyway. **THE PRICE, which is the honest half:**
> rows written into a day file an un-upgraded build created land **unsigned**, and an unsigned row
> is not refused — which is the migration decision the ticket had already taken and is not widened
> by this. A day file this build creates still carries the column in its first write, where there
> is no existing header to rewrite, so **the cost is nil once the fleet is uniform**. The fix was
> available only inside `apps/Reco.html`: making the widening branch cross-process safe is the
> better fix and lives in `main.py:683`, which this round may not edit — **T-S10-28**.
> **[88] R19k2** (turned round — it used to assert the widening happens), **R19w**, and
> `scratchpad/pksig/fix/probes/f1_widen.mjs` on the file.

**Direction one — this build on a CSV written before the change.** A hand-written day file with no
`_pksig` column at all reopens, the rows carry no signature, and they are **writable**: the typed
value lands under the key the file holds. **[88] R19k**.

**Direction two — an OLDER build on a CSV this build wrote**, run for real in a second browser
context against a second bridge whose app root is `git show 55171d8:apps/Reco.html`, because the
handover already warns that a mixed fleet on one folder is a live problem. It loads all six rows,
says nothing in error, and appends its own `Cn` row. It **drops** `_pksig` on the way in (its row
literal copies `_pk`, `_ver` and `tpl.columns`), so its appended record carries an **empty**
signature — which this build reads back as *"no signature"*. The header is **unchanged** by its
append, because `append_csv_rows` writes against the existing header whenever the fields it is
handed are already in it and the old build asks for a narrower set. **So a mixed fleet degrades to
"the old build's rows are unprotected" and never to a lost column, a lost row or a refused load.**
**[88] R19l**.

> **BUT "the old build's rows are unprotected" WAS TOO KIND TO ITSELF, AND THIS IS THE REVIEW'S
> SHARPEST FINDING AFTER §19.2.** `Versioning.collapseToActive` keeps the **latest** version per
> key, so that empty-signature `Cn` row is what a reopen READS — which means **one ordinary cell
> edit by a colleague who has not upgraded strips a row's protection for good**, and the dead-key
> door reopens for exactly that row. Measured on one shared folder with this build and the real
> `55171d8` build: after a genuine key-rule change the untouched rows were refused (correct) and
> the edited row went through **in total silence**, with the typed value landing on the share under
> the dead key. The build's summary said T-S10-19 *is closed for a derived key*; on a mixed folder
> it was not, and the handover's own T-S10-12 says a mixed fleet is the normal state.
>
> **IT IS REPAIRED ON THE WAY IN, where this build is in charge**: in `collapseToActive`, an active
> row with no `_pksig` inherits the signature of the newest version of the **same `_pk`** that has
> one. **That is exact rather than a guess** — a row's `_pk` is what FILES it, so the versions of
> one `_pk` in one file are versions of one row, and no build can change the key without changing
> the `_pk` the version is filed under — and **it does not widen the migration one inch**: a `_pk`
> whose every version is unsigned stays unsigned and stays writable. The second pass runs only when
> some row in the file carried a signature, so every file on every share today, and every keyless
> template, walks exactly what it walked before. **[88] R19v**, and `probes/b5_mixed.mjs` against
> the real older build.

### 19.6a The review pass's mutation grid, and the one mutant that still survives

Twelve more mutants, one per thing the review pass changed, graded through
`scratchpad/pksig/fix/probes/g_grade.mjs` (every claim is one of the new gates asked as a **pure
call** — `keyRuleSig` over freshly built template objects so the `WeakMap` cannot answer,
`_keyOldRuleWhy`, `_keyRefusal`, `collapseToActive`) plus `f1_widen`, `f2_say` and `a6_fix`, all
with `APP_FILE`, so `apps/Reco.html` was never written. Ten reddened only their own claims:

| mutant | what it reverts | what went red |
|---|---|---|
| `m1_defof` | hash `_keyDefOf` again — round 8's defect | R19q (**nine** of the ten shapes), R19r (loses closure order), R19t, and the A2 loop in `a6_fix` |
| `m2_rawformula` | no formula canonicalisation | R19q (`formatOnly` alone), R19t, the A2 loop |
| `m3_onesay` | one sentence again | R19u, and both A3 gates in `f2_say` |
| `m4_nomark` | no row badge | both A4 gates **in the round's own probes — and NOTHING IN THE SUITE**, which is §19.9's first finding |
| `m5_widen` | widen the file again | both B1 gates in `f1_widen` |
| `m6_nolaunderfix` | no signature inheritance | R19v |
| `m7_hash32` | lane 2 fed the high byte again | the two-lane check |
| `m10_carryall` | record `carryForward` for every type | R19q |
| `m11_carrynone` | record it for no type | R19s — **and that grading was wrong: `m11_carrynone` is the CORRECT build, and the cleanup round shipped it. See §19.9** |
| `m12_noorder` | drop the closure's declaration order | R19r |

`m8_clash` **survived the whole grid** and produced **[88] R19y**, which is the same lesson as
R19p one round later: the gates around `Reco.addCorrectionCol` measured **consistency** — that the
cached signature agrees with a fresh one, and that the same rows get the same answer before and
after an unrelated save — and once `tpl.columns` was in the cache key, the WRONG answer was
consistent. **A consistency gate cannot catch a wrong premise.** With R19y it reddens.

**`m9_cachekey` STILL SURVIVES, AND THAT IS REPORTED RATHER THAN GATED, because the honest reason
is that its defect is no longer reachable.** It reverts `tpl.columns` out of both `WeakMap` cache
keys. The only reachable in-place mutation of `tpl.columns` on a live template was
`Reco.addCorrectionCol`'s push, and that is refused at source now, so nothing in the app can make
the cached answer stale. The change is kept anyway — belt beside that brace — because a wrong answer
there is a **retroactive refusal of every row in the reconciliation, arriving at the next unrelated
template save**, and the price of keeping it is two property reads per cache hit. If a future round
adds another writer of `tpl.columns`, this is the line that absorbs it.

### 19.6 One mutant survived everything, and the gate it produced

Twelve mutants, each a copy with exactly one thing reverted, graded through
`scratchpad/pksig/build/probes/grade.mjs` with `APP_FILE` (the one suite-side variable that is
honoured — house rule 8) so `apps/Reco.html` was never written. Eleven reddened their own claims and
only their own. **`m7_hash_master` — the accounts master's ROWS hashed into the signature, which is
the dishonest answer to question (b) — passed all twenty-one claims**, including the one written to
catch exactly it.

The reason is worth more than the mutant: **`Reco.keyRuleSig` is memoised against the template
object and the IDENTITY of `primaryKeys` / `additionalColumns`**, and editing `AppState.aegMaster`
moves none of those, so the cached answer came back and the behavioural fixture could not see the
difference. The harm would then have arrived **late** — at the next unrelated template save, which
replaces both arrays and invalidates the cache — and refused every row of that template
retroactively. That is R17d's shape (*not drifted today, drifted tomorrow*) reaching the app through
this round's own fix. **[88] R19p** now asks the question over **freshly built** template objects,
which the cache cannot answer for, and asserts that replacing every row of the accounts master
leaves the signature unchanged while moving the lookup's `returnKey` moves it. `m7_hash_master`
reddens it.

### 19.7 What this round did NOT change

- **The template latch** — unchanged, and verified in both directions by round 5. It is still the
  first arm, because it is one property read and its sentence is the better one when it applies.
- **Round 6's chokepoint** — `Reco.writeKey` / `Reco.writeVerKey` / `Reco._keyAsk`, and
  ask-first-mutate-after at all eleven sites. Unchanged. [82]'s `STORES` table, G82a–G82z and
  [87] are untouched.
- **[82] G82f was NOT turned round**, and the instruction for this round anticipated that it might
  have to be. The thing it forbids is a per-row **recompute** (`_keyRowDrifted`,
  `_extraComputedValue`, `_keyFrozenPart`, `_keyRowCols`); `_keySigMoved` reads two strings and
  touches no cell, so the forbidding half and the latch half both pass **unchanged**. A third,
  POSITIVE clause was **added**, for the same reason the other two exist: without it, *deleting* the
  signature arm would leave G82f green, and a safety control whose removal nothing notices is the
  shape that whole section is about.
- **[86]'s six false-refusal gates** — R17a, R17a2, R17e, R17c, R17d, R17b. All six green, and they
  are the measurement that tells a signature from a recompute. `m12_rearm_round6` (a value
  recompute put back beside the signature arm) reddens R17a's shape in the grader, which is what
  that mutant is for.
- **`Reco.keyDriftCount`** — no reader added, no counter added. §19.4 says why.

### 19.8 The numbers

**Failing first.** The suite changes went in **before** the app change, so every new assertion was
recorded RED against the unchanged tree and then GREEN against the fix
(`scratchpad/pksig/build/logs/FAILFIRST_store.txt` → `logs/net/store_e2e.txt`). The failing-first
run reached **696 green and 14 RED** and then died in [88] on a defect in one of the new fixtures
(`\r\n` inside a JS **template literal** is interpreted at build time, so the generated code
carried a real newline inside a string: `SyntaxError`). That is reported rather than tidied away,
because a crashed run is not a measurement — the escape was fixed and the SAME fourteen then went
green. **The fourteen:** G82f, R15d, R15e, R15g, R19a, R19b, R19c, the R19 premise, R19d, R19e,
R19f, R19h, R19i, R19j. After the app change the run read **`713 passed, 1 failed`** (the one being
this round's own vacuous R19k2, below) and, with that fixed, **`714 passed, 0 failed`**.

> **ROUND 8's REVIEW PASS: `724 passed, 0 failed` on store (`+10` on the build's 714, `+30` on the
> `55171d8` baseline of 694), 0 failed on all eighteen suites, all four byte-identity gates
> untouched. The +10 is named: [88] gains R19q, R19r, R19s, R19t, R19u, R19u2, R19v, R19w, R19x and
> R19y. Nothing was removed and no count went down. THREE checks were turned round or rewritten and
> each is named where it sits: [84]'s `refused()` matcher and R15g's (the sentence changed, so the
> matcher keys on *"DIFFERENT row-key rule"* — narrower, not wider, and the two claims that were
> taken out of the sentence are asserted ABSENT at R19f); **R19k2**, which used to assert that the
> widening whole-file rewrite HAPPENS and now asserts it does not, because what it pinned was a
> measured data loss; and **R19f**, rewritten to the new sentence. `G82f WAS NOT TURNED ROUND` — the
> signature arm still calls `_keySigMoved(tpl, row)` and still names no recompute, so all three of
> its clauses pass unchanged. ALL SIX [86] GATES GREEN: R17a, R17a2, R17e, R17c, R17d, R17b. ONE
> MORE OF THE BUILD'S OWN DEFECTS, FOUND BY THE REVIEW PASS AND WORTH NAMING: `R19_WALK` captured
> only the first **240 characters** of a toast, which is shorter than the refusal sentence — so
> R19f's existing clause that it must not say *"Nobody has changed anything"* was being asserted
> against a string truncated before those words could appear. The capture is raised to 1,200, which
> measures **more** of the sentence, not less.**

**+20 on store, and the arithmetic is named so the total cannot hide anything:** [88] is new
(**+19**) and [85] gains R16d (**+1**). [84] stays at **11 checks** and [82] at **16**, because R15d,
R15e, R15g and G82f were *rewritten in place* rather than added — each with its before and after set
out in the suite above it, and each named in §19.7 and on T-S10-19. No assertion was removed.
`git diff --numstat tests/e2e/run_store_e2e.mjs` reads **`960 60`**; the 60 removed lines are the
four rewritten assertions, the two replaced design notes in [84] and the two one-line gates in [85]
that grew a field, and nothing else.

**Two of this round's own defects, both caught by its own assertions, both named because an
assertion that passes vacuously is worse than one that fails.** (1) [84]'s `refused()` matcher still
looked for **round 6's** sentence (`were SAVED with`), which round 7 deleted, so it read "WENT
THROUGH" for ten doors that were all being refused — R15d went red for the wrong reason and the
matcher now names both sentences and asserts WHICH one. (2) R19k2 first read its own measurement as
vacuous: the template marked no column editable, so `Reco.editCell` no-opped, no `Cn` row was
appended and the widening rewrite never happened. The assertion failed rather than passing on
nothing, and it now carries the premise (`cnRowsAfter >= 1`) so it cannot.

**Every suite, one at a time, with the seven-glob sweep on the line after each run inside the runner
script and `df -h /` on the line after that** (`scratchpad/pksig/build/net.sh`): pytest 75 (1
skipped) · jv_core_unit 250 · e2e 73 · autoload 41 · xllink 65 · xlview 94 · reports 107 ·
grid_scale 100 · colorder 147 · pk_extras 170 · **store 714** (baseline 694) · correction 163 ·
panes 304 · reverse 256 · specialjv 123 · jv_engine 79 · jv_gen 107 · jv_wizard 119. **0 failed
everywhere**, nothing below baseline. All four byte-identity gates untouched and green — colorder
T1 (`76dffed`), **pk_extras G1 (`3047f82`), which is the one this round had to design around**,
correction (`d9957fc`) and panes (`5f61d76`). `run_panes_e2e` [4]'s known flake (T-S10-15) did not
occur. Disk 30% at the start and 30% at the end, read after every run, never above 31%.

**Mutation evidence.** Twelve mutants, each a copy with exactly one thing reverted, graded through
`scratchpad/pksig/build/probes/grade.mjs` by `APP_FILE` so `apps/Reco.html` was never written
(md5 `21d4761f6458b6d1c91c9274482f4201` before, between and after; `git status` unchanged). The tree
is **22 of 22**; every mutant reddens its own claims and no others:

| mutant | claims reddened |
|---|---|
| `m1_no_mint` (site 1) | 10 — the mint, the CSV rows, the Cn row, the rule move, the round trip, the refusal, the sentence, all-or-none, both lookup arms |
| `m2_fields_swept` (site 2) | **1** — the header. The rows still carry the signature and the round trip still works, which is precisely the hazard: it lands in the CSV by accident and the WIDTH varies |
| `m3_no_upload` (site 3a) | 4 |
| `m4_no_cn` (site 3b) | 4 — including the round trip, because `collapseToActive` reads the latest version per key |
| `m5_no_load` (site 4) | 5 — and R19a/R19b/R19c stay **GREEN**, which is hazard two exactly: the mint-side assertions pass while the fix protects nothing |
| `m6_no_arm` (site 5) | 5 — including G82f |
| `m7_hash_master` | **1, and only after §19.6's gate was written for it.** It passed all 21 other claims |
| `m8_sig_always` (question (a) the other way) | 1 — and its reading is the cost: the template-column key's day file becomes `_pk,_ver,_ts,_src,_by,_pksig,Doc,Line,Amount` |
| `m9_version_strict` | 1 |
| `m10_no_canon` | 1 — the canonicalisation, which nothing behavioural reaches |
| `m11_absent_refused` (the migration widened) | 3 |
| `m12_rearm_round6` (a value recompute put back) | 3 — including the correction-of-a-key-feeding-column shape, which is [86] R17a's |

**No test was weakened and no baseline moved.** Four assertions were rewritten, in place, with the
same ids, and each carries its own before/after note: R15d and R15e because round 7 wrote them
asserting the hole was open and said *"so a future fix makes R15e fail and gets re-read"*; R15g
because the all-or-none cost is real again on one screen and is disclosed rather than designed
away; G82f because a safety control whose removal nothing notices is what [82] exists to prevent.

### 19.9 The cleanup round — the nine things that stood between round 8 and shipping

The review pass's verifier signed the BEHAVIOUR off and refused to sign the round off: *"what stops
me is not the behaviour."* Nine items as the verifier listed them. **None is a false refusal and
none loses a value** — the worst of them loses the PROTECTION on a value rather than the value, by
letting a row that should be signed land unsigned, which is a refusal that will not happen later.
**Five were sentences; one was a safety control with no
behavioural test anywhere; and three were defects in the code or in what the docs claimed about it,
two of which became code changes.** The four that are not sentences are worth more than the five
that are — and one of them (the header cache) was a silent hole in the signature itself, which the
verifier had listed as a one-line tidy-up.

**THE TWO CODE DEFECTS, BOTH MEASURED END TO END BEFORE ANYTHING WAS CHANGED**
(`scratchpad/cleanup/probes/`, which the gates below were then written from):

1. **COMPACTION WIDENS AN EXISTING DAY FILE, AND THE NEXT APPEND INTO IT LOST ITS SIGNATURE.** B1's
   guard lives in `Versioning._appendRows`; `Versioning.compactFile` calls `Versioning.writeFile`
   instead, and `Versioning._fields` asks for `_pksig` for every derived-key template — so §14.5's
   absolute *"No existing day file on any share is ever rewritten by this change"* was false on
   that path. **The widening itself is safe and is the only route that upgrades such a file** (see
   §14.5 for the four reasons). **What was not safe:** `Versioning._hdrCache` was never invalidated
   by `writeFile`, so after a compaction the next `Add Data` read the stale narrow header, concluded
   the file had no `_pksig` and **deleted the signature off the record**. A row the mint had signed
   landed unsigned in a file whose header carries the column, and the reopen handed it back unsigned
   — so after a real key-rule change it is the one row that is **not** refused. That is the harm
   T-S10-19 exists for, arriving through the guard added to protect the file. One line in
   `writeFile`; **[88] R19z** asserts the row the mint signed, the value in the FILE, and the value
   a reopen brings back, plus both premises (B1 held; the compaction really rewrote).
2. **`carryForward` WAS STILL IN THE SIGNATURE, which is the fifth instance of the shape the review
   pass found four of.** §19.2 has the measurement: a dropdown or custom column cannot be in a key's
   closure at all (`_pkEligible1` and `_pkFormulaOk` refuse it, measured through the real save), and
   past the save, by hand, the flag still cannot reach a minted key — because `_extraTyped` returns
   at its record test while `row._pk` is the empty string the ingest reserves. **[88] R19s now
   asserts the opposite of what it asserted**, and the review pass's own mutation grid had graded
   the right answer as a defect (`m11_carrynone`, §19.6a). Ticking *Carry this value forward* on a
   typed key helper no longer refuses every earlier row of the reconciliation.

**THE BLIND GATE.** The **⊘ older rule** badge had no behavioural gate anywhere in the net. R19x is
a regex over `APPSRC`, and a mutant that deleted the `statusHtml +=` line while leaving every
character that regex matches behind in a comment read **724 / 0** — which made the badge the one
safety control in the round whose removal nothing noticed, and it is the control that answers A4's
measurement (the same business key on screen twice, one copy refused and one writable, with nothing
to tell them apart). **[88] R19x2** reads the rendered `<tbody>` of the mixed screen R19e already
builds: `class="badge oldrule"` and the words *"⊘ older rule"* on each of the three rows the day
file handed back, on **none** of the three live copies of the same business rows in the same
`<tbody>`, and `Reco.keyOldRuleCount` reading 3 over the same session. The live half is the mirror —
a badge on every row would satisfy the dead half and be useless.

**THE FIVE SENTENCES, all of them the same failure and all of them in the cluster that has already
shipped documentation saying the opposite of the code twice.** §15.6(a) quoted, in the present
tense, a refusal sentence the code is gated never to say, and then reinstated the *Clear and load
the extract again* loop the same bullet says is not advice for an older day file. T-S10-19's own
summary block asserted as fact the *"same set by construction"* argument the review called the
central defect; its answer to question (c) quoted the same dead sentence and cited **R19f** — the
gate that asserts it ABSENT — as the proof; and the same answer said *"no new readerless counter was
added"* when `Reco.keyOldRuleCount` is one. `Reco.keyRuleSig`'s own header in `apps/Reco.html` said
*"`RecoTemplate._keyDefOf(tpl)` and nothing else"* and *"THERE IS DELIBERATELY NO SECOND DEFINITION
OF THE KEY RULE IN THIS FILE"* sixty lines above the code that hashes `_keyRuleDefOf`, and **[88]
R19m** repeated the refuted argument as its own reason. Every one of them is now the historical
account, marked as the mistake, because **a reader who trusts a summary block rebuilds the defect**
— which is what three of these five would have done.

**One claim the round-8 build made about §19.2 is also withdrawn:** the reason given for recording
`carryForward` (*"`_extraTyped` reads it as the SCOPE test"*) was not live during a mint, and that
is why the flag is gone rather than re-justified.

**MUTATION EVIDENCE, three mutants against three probes, every claim asked as a probe of its own so
the grid runs in minutes instead of in three half-hour suites** (`scratchpad/cleanup/probes/`
`c1_carry`, `c2_compact`, `c3_badge` — the last reads `R19_MK` / `R19_A_KEY` / `R19_RELOAD` /
`R19_REOPEN` / `R19_WALK` **out of the suite**, so what it runs is what the suite runs). All three
with `APP_FILE`, so `apps/Reco.html` was never written: md5 `bdafdc90f7d8ae93751463564dc9282d`
before and after.

| mutant | what it reverts | c1_carry | c2_compact | c3_badge |
|---|---|---|---|---|
| `n1_nobadge` | the badge render deleted, with **every character R19x's regex matches left behind in a comment** | — | — | **C3b, C3d RED** |
| `n2_nohdrcache` | `writeFile` does not refresh `Versioning._hdrCache` | — | **C2d, C2f, C2g RED** | — |
| `n3_carryback` | `carry` back in the projection for the typed types | **C1e RED** | — | — |

Each reddens exactly its own probe and nothing else. **`n1_nobadge` leaves C3c — the live-copies
mirror — GREEN**, which is the point of pairing it: with no badge rendered at all, "no badge on the
live rows" is satisfied, so the dead half is the load-bearing clause and the mirror only stops a
build that badges everything. That is the same pairing R19q and R19r have.

**The numbers.** `run_store_e2e` **726 passed, 0 failed** (`+2` on the review pass's 724: [88] gains
**R19x2** and **R19z**; **R19s** and **R19q**'s `dropHelperCarry*` pair were turned round *in place*,
so neither adds a count, and nothing was removed). The seventeen node suites total **2,924**.

**Every suite, one at a time, with the seven-glob sweep on the line after each run inside the runner
script and `df -h /` on the line after that** (`scratchpad/cleanup/net.sh`): pytest 75 (1 skipped) ·
jv_core_unit 250 · e2e 73 · autoload 41 · xllink 65 · xlview 94 · reports 107 · grid_scale 100 ·
colorder 147 · pk_extras 170 · **store 726** (baseline 724) · correction 163 · panes 304 · reverse
256 · specialjv 123 · jv_engine 79 · jv_gen 107 · jv_wizard 119. **0 failed everywhere**, nothing
below baseline, and all four byte-identity gates untouched and green — colorder T1 (`76dffed`),
pk_extras G1 (`3047f82`), correction (`d9957fc`) and panes (`5f61d76`). `run_panes_e2e` was read
**three times** and gave 304 / 0 each time, so T-S10-15's flake did not occur. `apps/Reco.html`'s
md5 was the same before and after the whole net. Disk 30% at every reading.





## 20. The bridge round — T-S10-10 and T-S10-28: writes that are safe between PROCESSES

**`main.py` had never been edited by any of the nine rounds before this one**, by their own
self-imposed scope, and both of these tickets said in their **Why it is only a ticket** paragraph
that the fix was in there. So they stayed open while every other door was closed around them. This
round opened that file.

### 20.1 What was wrong, measured first, in two real processes

`LauncherAPI._writing` is a per-path lock **inside one process**. Two colleagues are two processes
on two machines, so it does not see them at all. Both losses were reproduced before anything was
changed, with `subprocess` and not threads — a threaded version of either passes on the broken code
and proves nothing.

| | probe | before | after |
|---|---|---|---|
| **T-S10-10** the ledger | `scratchpad/bridge/probes/p2_jsonrace.py`, 1,000 entries | an entry lost at **every** stagger, 0 ms included, **both writers reporting success** | 1,002 of 1,002, one process refusing once and succeeding on the retry |
| **T-S10-28** the CSV | `p1_csvrace.py` (T-S10-28's own `b3_race.py`), 30,000 rows | `B_LOST` at 0.00 s and 0.15 s — 30,001 rows where 30,002 were written | `B_LOST: false` at 0.00 / 0.15 / 0.40 / 0.80 s |

In the ledger case nobody is told, and **the rows stay stamped POSTED on the share with nothing
behind them**, which is what makes it the worst of the open tickets rather than a tidiness one.

### 20.2 The lock, and why it is the OS's and not a lock FILE

T-S10-10 ruled out the lock-file shape and was right: `write_file` cannot fail on "already
exists", so such a lock is only advisory, and **a stale one left by a page that crashed would block
the ledger for everybody** — a worse failure than the one it replaces.

`main._cross_process_lock` uses the **OS's own advisory file lock** instead (`fcntl.flock` on
POSIX, `msvcrt.locking` on Windows) on one file per path under `ROOT/.locks/` (see below for why
it is one folder and not a sidecar beside each file). The kernel drops it when the handle closes **or the process dies**, so there is no stale
state at all: no staleness timeout to decide, nothing to break by hand. What remains is a **wait**
(`LOCK_WAIT_S`, ten seconds — far longer than the longest write this bridge performs, a 672 ms
whole-file rewrite of a 7.7 MB day file, and short enough that a pathological holder cannot wedge
the window).

Three properties were chosen deliberately and each has a test:

- **It is held inside ONE bridge call and never crosses the JS boundary**, so a page that throws
  between two calls cannot leak it. That is also why the ledger needs the token as well as the
  lock.
- **A share that cannot lock degrades to unlocked** (`ENOLCK` / `EOPNOTSUPP` / `ENOSYS` /
  `EINVAL`, or no `fcntl` and no `msvcrt`, or the lock file cannot be created) — no worse than before
  this change, and far better than refusing to save. `test_a_share_that_cannot_lock_still_saves`.
- **A wait that runs out raises `main.LockBusy`**, and the caller treats it as a failed write. A
  write that quietly proceeded after giving up on the lock would be exactly the loss this exists to
  stop. It is **its own exception class** and not a message to match on: `write_file_if_unchanged`
  turns this one case into `{ok: false, reason: "busy"}` and lets every other `OSError` through, and
  deciding that by searching the text of an exception is how a reworded message quietly becomes an
  unhandled failure. (The first version of this round did match on the text; the class and
  `test_a_busy_lock_is_its_own_answer_and_not_a_throw` replaced it, and the test asserts both
  directions.)

**WHERE THE LOCKS LIVE, AND THE FIRST VERSION OF THIS ROUND GOT IT WRONG.** They are one file each
under **`ROOT/.locks/`**, named by the sha1 of the path relative to ROOT. The first version put a
`.<name>.lock` **sidecar beside each file**: simpler — no hashing, and `LauncherAPI.list_files`
already skips dotfiles — but it **doubles the file count in every folder the app writes to**, 31
day files and 31 twins in a month folder. This shared folder is browsed by people; that is the
whole point of Version History, the Excel link and `_archive/`. So that is a visible change to
their folder for an implementation detail. **Two suites said so by going red**, both listing the
real filesystem rather than going through `list_files`: `run_jv_wizard`'s "the engine was seeded
once and only once" saw `.jv-core-1.0.0.js.lock` beside the engine, and `run_jv_gen`'s R-19 saw
them in the archive. The name is the **hash** and not the path with its separators replaced,
because a reconciliation named with the separator character would then collide with another one —
and a collision here is two unrelated files sharing a lock, a silent stall rather than a visible
bug. `test_the_locks_live_in_one_hidden_folder_and_not_beside_the_data` asserts both halves.

Granularity stays **one lock per file**, so two reconciliations never wait on each other.
`folder_manager.iter_files` **skips the whole `.locks` directory** on a folder migration: the locks
are empty, they mean nothing outside the folder they were taken in, and on Windows the source one
may still be HELD by an open window — which a copy of a byte-range-locked file can fail on. The
copy and the verify are the same walk, so they agree about it.

### 20.3 The token, which is what actually closes the ledger

**The lock is NOT the fix for T-S10-10, and the probe says so in both directions.** Both pages have
already READ before either writes, so serialising the writes just decides which one wins: with the
lock and the plain `write_file`, `p2_jsonrace.py` still loses an entry at every stagger. What
closes it is a compare-and-swap:

- `LauncherAPI.read_file_with_token(rel)` → `{text, token}` — the file and the **sha256 of its
  bytes**, in ONE read. Reading the text and then asking for the token separately would be two
  reads with a window between them, which is the bug.
- `LauncherAPI.write_file_if_unchanged(rel, text, token)` → `{ok, token, reason}` — the check and
  the write **inside the lock**, so two processes cannot both pass the check and both replace.
  `reason` is `changed` (re-read and replay) or `busy` (the wait ran out).
- A **hash and not mtime+size**, because both of those lie in the cases that matter: mtime
  granularity on a share can be coarser than the gap between two saves, and a ledger entry replaced
  by another of the same length leaves the size identical.
  `test_content_token_is_the_bytes_and_not_the_clock` asserts both halves, including that
  re-writing the SAME bytes leaves the token alone.
- `token: ""` means **"I expect this file not to exist yet"**, so the first writer of a ledger
  cannot clobber a second one that got there first. An absent token is not "write anyway" — that
  would make a caller who forgot the token silently as dangerous as `write_file`.

`Store._mergeJob` is now that loop. On a `changed` refusal it re-reads, takes the share as the
authority again (`Store._takeDisk`) and **replays the same intents on top**, up to
`Store._CAS_TRIES` (8). That is sound rather than lucky because the intents were built to be
idempotent and to re-find what they mutate **by id** — the property T-S10-1 and the settle round
already rely on. `answering` is captured once, before the loop, and deliberately not recomputed: an
intent that arrives during a retry must not be applied by a job that is about to clear only the
first `answering` of them, which is MR-8's loss from the other direction.

### 20.4 What this round did NOT change

- **Round 8's B1 guard stays.** `Versioning._appendRows` goes on refusing to widen a day file it
  did not create, and **[88] R19k2 / R19w** go on gating that. The lock only helps where BOTH
  writers have it, and an un-upgraded build takes none — so on a mixed fleet, which is the normal
  state (T-S10-12), the widening rewrite is still unsafe. The guard comes off when the fleet is
  uniform, which is a fact about a deployment that no code can assert.
- **The whole-file `PERSIST_KEYS` writes are untouched**, and that is **T-S10-31**, filed by this
  round: `Store.save` writes a serialised snapshot with no intents to replay, so it needs a merge
  RULE before it can use the primitive that now exists. `reco/recoSessions.json` is the one that
  matters, and it is read off the code rather than measured.
- **`write_file` is still an unconditional overwrite.** It takes the lock, so it cannot land inside
  another process's multi-step operation, but callers that must not clobber a colleague use
  `write_file_if_unchanged`. Making `write_file` itself conditional would break every caller that
  legitimately replaces a file.

### 20.5 The gates, and the one that needed a barrier

**pytest, where the losses live:** seven new cases in `tests/test_launcher.py` and one in
`tests/test_folder_manager.py`. **All of them fail on the build before this round and all of them
pass on it** (`7 failed, 37 passed` → `0 failed, 44 passed` for the seven that existed when that
was measured), and
`test_a_colleagues_append_survives_the_widening_rewrite` fails **three times out of three**, naming
both writers' success and the missing row.

**That test needed two things to stop being vacuous.** A **barrier** (each worker touches a
`.ready` file and waits for `.go`), because without one the two processes' startup jitter is longer
than the thing being measured; and a **60,000-row file**, because at 4,000 rows the rewrite
finished inside that jitter and the test PASSED on the broken code — which is worse than no test.
Both are written down in the test.

**`run_store_e2e` [89] R20a–R20e, the page's half, which pytest cannot reach.** The cross-process
loss is *not* measurable in the e2e bridge and that is said in the section rather than fudged: it
is one python process with a threaded server, so `_writing` already serialises the two pages. What
[89] measures instead: that the token is really used (`Store._casWrites` / `_casRetries` /
`_casUnconditional`, operation counts and never clocks, §16.4a); that a colleague writing between
this page's read and its write is **not clobbered and does not clobber** (both records on the share
afterwards, with the retry counted so the collision cannot have been missed); that `busy` is said
and the value lands on the retry with `pendingCount()` back to zero; and that an older launcher
with neither method still saves (`_casUnconditional` non-zero, so the degradation can never be
mistaken for the fix working).

**AND THE SECOND WRITE DOOR BROKE THIRTY-THREE EXISTING CHECKS, which is the useful part of this
section.** Every fixture that counted "how many times did this file get written" named
`write_file`, and every fixture that faulted "the share did not answer" faulted `read_file`. The
merge now goes through `read_file_with_token` and `write_file_if_unchanged`, so those counters read
**zero** and those faults **never fired** — so the debounce gates (S2a, S10b, O9c, C3b) passed
vacuously and the whole T-S10-9 journal block (S109*, R5*, R6*) measured a folder that was never
down. Not one of them was weakened: `writesOf` now names both doors through one `WRITE_METHODS`
list, and each fault fixture faults both. **A rename of a write path is a silent test-coverage
change**, and the only reason this was caught is that those checks assert on FILES and VALUES, so
they went RED instead of staying green on nothing.

## 21. T-26-11 — the two values the app promised to keep, and where it put them

### 21.1 What was wrong, and the measurement that isolated it

T-30-3 made the one-time carry-forward promotion **refuse to pick** when one row key holds two
different legacy values, and leave both where they are. That was right: a `k:'typed'` record
broadcasts to every row with the key, so writing one of them would have deleted the other in the
same pass with no second copy. The dialog said so.

But *"where they are"* is `sess.manualTags`, keyed on `row._id + '||' + col`, and `row._id` is
re-minted by `U.uid()` on **every load**. So the next time those rows come back off a day file the
keys point at nothing.

**The YES path is what isolates the cause** (`scratchpad/cf/probes/q1_orphan.mjs`). Tick the box,
answer YES, then reopen through Version History:

| | before the reopen | after it |
|---|---|---|
| `INV-8` (one row, `Carol`) | promoted into the store | **`INV-8=Carol` on screen**, off the share |
| `INV-9` (two rows, both `Dave`) | promoted — not a conflict | **`INV-9=Dave` on screen** |
| `INV-7` (two rows, `Alice` / `Bob`) | refused, left in `manualTags` | **`INV-7=` blank**, both strings orphaned |

The declined path cannot show this, and that is worth knowing: a decline abandons the save above
the template swap, so **nothing** is promoted and every legacy value in the column orphans at the
next reopen — which also means T-30-3's promised recovery (*"fix the duplicate rows and save
again"*) has nothing left to promote by then. Nothing said so. **[90] R21f**.

> **One correction to my own first measurement, because it would have "proved" the right conclusion
> for the wrong reason.** `Reco._extraValueForRow(tpl, sess, row, ac)` takes the **column object**,
> not its name. The first version of the probe passed `'Vendor'`, so the function read
> `row[undefined]` and answered `''` for every row — a blank cell for all three keys, including the
> two the promotion had successfully moved. Passing the def is what produced the table above, and
> the table is the finding: `INV-8` and `INV-9` are **not** blank.

### 21.2 The shape chosen: a note, not a value

`Reco._cfRecord` writes the conflict onto the session when the promotion refuses to pick — the key,
the column, **both strings**, `at` and `by` — and `Reco.carryConflicts(tpl, sess)` reads it back,
pruned of pairs something else has since answered (a record now exists for that cell, whoever wrote
it).

**No reader of the values store was taught anything.** That is the whole reason for this shape: the
ticket's own "honest shape", a `k:'conflict'` record in `extraValueMaster` carrying two values and
no value, would have needed the grid, the ladder, the reports, the CSV, the workbook, the AEG
extras loop and both ledger-write refusals all taught what it means — the review that `k:'typed'`
vs `k:'override'` already cost once. **[90] R21d** asserts the cell is still blank and the promoted
keys still come back, so "it is a note and not a value" is gated rather than claimed.

**Why the session, and what that costs.** It survives the reopen that causes the harm
(`Reco.loadVersionedFile` replaces `sess.data` and nothing else) and it is persisted whole in
`reco/recoSessions.json` — **[90] R21c2** reads the note off the share, because a note that lived
only in this window's memory would die at the next restart, which is the same harm one day away.
The property is **created lazily and deleted when the last note goes**, so a session with nothing
to say is byte-identical to one that never had a conflict: `run_panes_e2e` diffs that file byte for
byte against base `5f61d76`, and `row._dsi` goes on the end of a row for the same gate's sake.
The honest limit: the note is exactly as durable as the two values it describes, which are in the
same file — and no more. A window that writes `recoSessions.json` whole can still clobber another
window's note, which is **T-S10-31** and not this ticket's to fix.

### 21.3 The recovery is the operator's, which is not the app picking

The panel — the existing **Column Values** screen, which is already "the one screen that lists the
typed values" — gains the conflicts **at the top**, because they are the only thing on it waiting
for somebody. Each row shows the key, the column, both strings, when and by whom, and two actions:

- **Keep this one.** The person is shown both values and told, before anything happens, that the one
  they pick will read on **every** row with that key and how many loaded rows that is, and what the
  other value was. It goes through `Reco.setTag`, the door a typed value in the grid already uses,
  so the key-rule refusals (T-S10-19/20), the carried-value `force` path, the journal (T-S10-9) and
  the merge write all apply with nothing re-implemented. **This is the operator choosing, which is a
  different thing from the promotion choosing silently** — the thing T-30-3 forbade.
- **Dismiss.** Removes the note and nothing else — it writes nothing and deletes nothing, for
  somebody who has corrected the duplicate rows and retyped by hand. The confirm names both values
  first, because the note is the last copy that is easy to read.

**The card carries the count** (`⚠ N unresolved`), and that is not decoration: the Column Values
card appears only once the template HAS a carry column or a stored value, and the whole point of
the conflict is that **neither happened for that key**. A panel nobody can find is the same as no
panel. **[90] R21e** reads the panel off the rendered modal, **R21e2** reads the card off
`Reco.renderManage`'s own output, and **R21j** reads the kept value off the share.

> **The first version of R21e2 was a false positive and is worth naming.** It called a
> `Reco.openManageModal` that does not exist (the cards come from `Reco.renderManage`), read
> `#modalBody` anyway, and matched the Column Values panel that was still sitting in it — so it went
> green while gating nothing. The lesson is the cheap one: a check that reads a shared DOM container
> after opening something else is asserting about whatever was there last.

### 21.4 The two refusals that had to be right

- **A refused write must not forget the note.** With the key-rule latch up, `setTag` refuses —
  and if `cfKeep` cleared the note on the way past, the refusal would have **deleted the only
  record of the two values**. It is forgotten only once a record for that cell really exists.
  **[90] R21g**.
- **No row with that key on screen is a refusal with a reason.** A value is kept *against* the row
  key, so there has to be a row to keep it against; the sentence names the key and says to load the
  file that holds it. **[90] R21h**.

### 21.5 Two defects this round's own gates caught, both worth naming

**The note was wired into the wrong function, and only the DECLINED path could tell.**
`Reco._cfRecord` went into `Reco._promoteCarryForward`, which looked like the right place: it is
where the conflict is computed and where the refusal to pick happens. But the confirm is asked by
`RecoTemplate.saveTemplate` **above the template swap**, so that Cancel can abandon the save — and
on Cancel the promotion never runs at all. **[90] R21f** read `recorded: []` on the declined
template. The note is now written at the ask, which both paths reach; the promotion keeps a second,
idempotent call for the caller that promotes with no ask at all. **The decline is the path that
needs it more**: it stores nothing, so nothing in that column is kept against a row key, and the
next reopen orphans every legacy value in it rather than just the conflicting pair.

**R21g passed on nothing happening at all.** It asserted "nothing was filed and the note is still
there", which is also true when the action does nothing — and the action was doing nothing, because
the fixture had left `AppState.activeRecoId` on the other template, so `Reco.cfKeep` looked in the
wrong session and every arm answered *"That conflict is no longer listed"*. It now asserts the
**latch's own sentence**, so a refusal for the wrong reason reads red. Same shape as every other
vacuous-pass this project has had: an assertion about an ABSENCE needs a second clause naming what
should be PRESENT.

## 22. T-26-9 — the ticked row that produces no journal line, named before it is stamped

### 22.1 The harm

`Reco._buildEntryLines` drops a group whose summed value is 0 (`if (value === 0) return;`) and it
is right to: a zero-value line is not an accounting entry, and templates rely on that.
`commitEntryFromPreview` then stamps **every** standard row in the selection with the post-entry
value and puts every one of them into `entry.postedPks`. So a row can be closed, audited as posted
under an accounting reference, and have nothing at all behind it in the ledger.

Measured before the fix (`scratchpad/zero/probes/z1_zero.mjs`, three rows, one worth `0`, all three
ticked):

```
lines: 4            entryLines: 4         <- the zero row produced none, correctly
postedPks: ["INV-1","INV-2","INV-3"]      <- and is audited as posted anyway
stamped:   ["INV-1=POSTED","INV-2=POSTED","INV-3=POSTED"]
previewNamesZero: false
zeroReader: "no such field"
```

The last two lines are the reason this was invisible rather than merely wrong. The preview renders
the lines that **were** built, which is exactly the set that cannot show a dropped group, and
`Reco._pendingEntry` had no field for it — nothing in the app, on any surface, could name the row.

### 22.2 What was built, and what was deliberately not

**Warn and offer to drop.** The ticket lists two options and says it should be decided with
T-26-4; they are not equal. Leaving the stamp off a row that produced no line changes what
`entry.postedPks` means for every entry already on the share, and T-26-4's round recorded three
suites going red when that default was flipped for its sibling (`run_jv_gen` read `standard:1
buckets:[]` where it expects two TCH rows bucketed, `run_jv_engine` read 4 lines where the
hand-written page writes 8, and `Z1h` could not reach a posting at all — every one of them a
workflow that deliberately posts what the gate would drop). So **the default is unchanged**,
`R22d` is the check that pins it, and what is new is that it is said and that there is a way out.

**Reported from the line that drops the group.** `_buildEntryLines` gained a fifth `audit`
out-param and pushes `{ rows, value }` from inside the `value === 0` branch. The group's total is
only known there, and a caller that re-derived this grouping to find the dropped rows would be a
second copy of the grouping to get wrong.

**The row is found by identity, not by index.** `aegInputs` is built by index from `standardRows`,
so a `Map` from input object to row is identity. Nothing is stamped onto the input objects:
`AEG.buildLine` reads them and an output-column mapping could pick a bookkeeping property up.

**The banner names each row's OWN amount and its GROUP's total**, because those answer different
questions. A row worth zero is a data problem on that row. A row worth something inside a group
worth zero means the rows ticked with it cancel it out — and only the second one is fixed by
reticking.

**The drop is applied AFTER the lines are built**, which is sound rather than lazy: the rows being
dropped are exactly the ones whose group summed to zero, so they contributed no line and the entry
written is the same entry either way (`R22h` asserts four lines before and four after). The only
thing the button moves is which rows this entry closes — which is the whole of what the operator is
being asked. `standardRows`, `sourceRows` and `aegInputs` are all filtered (`R22i`), so nothing
downstream can still reach a dropped row.

**One press, not a mode.** `Reco._dropZero` is consumed by the preview it reopens, exactly as
`Reco._dropPosted` is, so the next *Preview Entry* is back to the plain behaviour. A sticky "leave
zero rows open" is how a workflow quietly stops closing rows it should.

### 22.3 The defect the round did not set out to find

Both drop flags are consumed by the **one** rebuild the banner buttons trigger. So on a selection
that trips both banners, pressing *"Leave them out"* on the posted banner put the zero rows back
**into** the stamp behind an operator who had already pressed *"Leave them unmarked"* — and the
banner on screen went back to reading *"Marked posted by this entry"*, with nothing to show that
the answer had changed. Each handler now carries the other banner's answer, read off
`Reco._pendingEntry` rather than kept in a second flag: `_pendingEntry.zeroIncluded` is what the
banner on screen is displaying, so the two cannot drift. **R22s** is the gate.

### 22.4 The gates, and the mutation grid

`[91] R22a–R22x` in `run_store_e2e`, 24 checks over four fixtures — one template per arm, because
re-using one carries the previous arm's `POSTED` stamps into the next and the control arm's whole
job is to measure a selection with nothing wrong with it (the first version did re-use one, and the
control read *"4 selected row(s) are already posted"*).

The modal is read as `document.getElementById('appModalBody')` with **no `|| document.body`
fallback**: `document.body.innerHTML` contains this app's own `<script>` text, so a phrase that
appears in a code comment or in a string the app builds matches with no modal rendered at all.
`opened` is the clause that says an absence is a quiet banner and not an empty modal.

`scratchpad/zero/mut/run.py`, 7 × 26 — seven mutations against the 26 checks of the round's own
probe (`scratchpad/zero/probes/z2_fix.mjs`: the same assertions over the same four fixtures). The
grid runs against the probe and not against `[91]` because a probe can be pointed at a mutated
copy of `apps/Reco.html` through `APP_FILE` and a suite section cannot. Each mutation turned
exactly the checks it should, named below by the `[91]` check carrying the same assertion:

| mutation | red |
| --- | --- |
| no `audit` out-param — the drop is not reported at all | 14 |
| no banner in the preview | `R22e`, `R22f`, `R22j` |
| no toast | `R22g` |
| the default flipped — rows dropped unless somebody asks | `R22d` + downstream |
| the sibling banner's answer not carried | `R22s`, `R22t` |
| no all-dropped guard | `R22w` |
| `sourceRows` left unfiltered | `R22i` |

### 22.5 One correction this round owes T-26-4

T-26-4's guard comment and §18 both said that when every row had been dropped, Generate "closed the
modal having written nothing and said nothing". **It did not.** Measured with both all-dropped
guards disabled, the lines-less guard already in `commitEntryFromPreview` caught it, wrote nothing
and left the preview open:

```
said: ["error: Nothing to post"]    history: 0    modal still open
```

Three words naming no row, no reason and nothing to do next, on a screen where three rows are
ticked and a button has just been pressed — a bad message, not a silence. Both sentences are
corrected, T-26-9's own guard is an improvement on that message rather than the removal of a
silence, and `R22v` is the control that keeps the claim honest: it asserts that nothing is written
and the preview stays open **and says in its own text that this was already true**.

## 23. T-26-8 — the AEG keyword filter is a pair, and half a pair posted everything

### 23.1 The harm

`if (aeg.keywordColumn && aeg.keywordValues)` in `Reco.previewEntryFromSelection` was the only
thing narrowing a selection to the rows the operator meant. With the **values** set and the
**column** empty the `&&` is false, no filter runs, and every selected row posts — and nothing on
the Generate screen said the filter was not running. The AEG never validated the pair; it behaves
the same on `e9851b4`.

Measured before the fix (`scratchpad/kw/probes/k1_repro.mjs`), five rows worth 1, 2, 4, 8 and 1000
with a filter naming the one value `POST` that only the row worth 4 carries, all five ticked:

```
standardRows: [INV-1, INV-2, INV-3, INV-4, INV-5]
postedDr:     1015            <- 1+2+4+8+1000, against the 4 that was asked for
postedPks:    all five        stamped: all five POSTED
previewSaysFilter: false      <- /keyword/i matches nothing in the rendered preview
```

The largest row in the file was in the general ledger because a dropdown was left at *"— none —"*.
The amounts are powers of two plus 1000 on purpose: every subset sums to a different number, so
the posted total **names** which rows went in rather than merely counting them.

### 23.2 The walk in is one the app itself leads

This is why it is a ticket now rather than a curiosity. S11's exclusive-role matrix refuses a
column still holding override records as the AEG keyword column — correctly, since an override is
**key-scoped** and would decide whether a row posts at all. `RecoTemplate.setAegRole` returns
`false` and leaves the field at `''`. The values the operator has already typed are in the editing
template, written by an `oninput` with **no gate at all**. `K1h`–`K1i` measured exactly that:
`returned: false`, the matrix's own sentence in the toast, `column: ''`, `values: 'POST'`. One
dismissed toast was the whole of the protection.

(The probe's first two attempts at this arm asserted against a fixture that did not exist —
`Reco.setTag` writes a `k:'typed'` record and only the **override** arm refuses, then
`_setOverride` refuses a row arm 1 had already posted. Both are recorded in the probe's comments;
the matrix's own comment explains why a plain dropdown may legitimately be the keyword column, and
`O14a` asserts it.)

### 23.3 Asked at the save, refused at the ledger door

- **The save asks**, beside `saveTemplate`'s own confirms, naming the values (or the column), that
  the other half is missing, and the consequence. OK still saves — a template may legitimately be
  half set up mid-edit — and Cancel abandons the save like every other confirm there.
- **The door refuses**, before the entry is built, and names **how many rows it would have been
  handed instead**. That count is what makes the sentence act-on-able rather than a complaint.

**A refusal here, where T-26-4 and T-26-9 chose warn-and-offer at this same door.** Those two name
a judgement the operator could genuinely have intended, so the preview opens and they choose. This
one is a template that *contradicts itself* — values to match, no column to match them in — and
there is no reading under which "post every row instead" is what it was asked to do. The recovery
is one edit, which the sentence names.

**Both directions and trimmed.** A column with no values is a filter that was set up and never
finished and posts everything just the same. And both readers `.trim()`, which is a behavioural
choice: untrimmed, `'   '` is **truthy**, so the old `&&` read it as a filter in force, split it
into an empty allow-list and answered *"No selected rows match the keyword filter"* — a sentence
about the rows, on a selection where every row would have matched a filter that had been finished.

**Both fields empty is left alone.** That is "no keyword filter": the overwhelmingly common
template, deliberate, and not the bug. `R23n`–`R23o` pin it, and they pin it with a **posting** —
`dr 1015`, all five rows — so the control cannot be a second refusal read the same way.

### 23.4 The gates

`[92] R23a–R23t`, 20 checks over five templates (one per arm; arm A is run twice, before and after
the column is filled in, which is the recovery the refusal names). "Nothing was posted" is read off
`entryHistory` **and** every post-entry cell, never off the absence of a pending entry — a refusal
that still wrote would look identical otherwise.

`scratchpad/kw/mut/run.py`, 7 × 19 against the round's own probe
(`scratchpad/kw/probes/k2_fix.mjs`), each mutation turning exactly the checks it should, named here
by the `[92]` check carrying the same assertion:

| mutation | red |
| --- | --- |
| no ledger-door refusal at all | `R23c/d/e/i/k/l/r` |
| no save-time ask | `R23a`, `R23j`, `R23p`, `R23q` |
| the refusal widened to both-empty too | `R23n`, `R23o` |
| only the values-no-column arm | `R23k`, `R23l`, `R23r` |
| the readers do not trim | `R23r` |
| the refusal drops the row count | `R23d` |
| the save-side column-no-values arm dropped | `R23j`, `R23q` |

### 23.5 The gate found a suite fixture in the same state

`[31] C6f` empties `keywordColumn` so `Vendor` can be offered *as* the keyword column without
clashing with itself, and saves — leaving `keywordValues: 'go'` behind. That is exactly the
half-set-up pair this ticket is about, so `TPL_S11` then posted every row it was given, and `C6h`
— which is about a **carried** value and has nothing to do with the keyword filter — was quietly
relying on that. With the door refusing, `C6h` read `ctx.sourceRows` of `null` and the suite threw.

The fixture now clears **both** fields, which states what it means: no keyword filter. A sweep of
every `aegIntegration` fixture across all sixteen suites found no other half-pair — the rest set
`keywordValues: ''`, and the one other non-empty value (`Status` / `Closed`) is complete. This is
the ordinary shape of a gate landing: the first thing it catches is the code that had been living
in the state, and here that was a test fixture rather than a template on the share.

## 24. T-26-10 — the summary cards had T-26-5's silence too

### 24.1 The harm

T-26-5 gave the total **row** a count of the cells it could not add and a footnote naming them. The
**cards** beside it still dropped the same cells in silence: `Sum`, `Avg`, `Min` and `Max` each ran
their own pass with their own `U.isNumeric` test and `continue`d, keeping no count.

Measured on T-26-5's own fixture, as the ticket's Test asks — `Net` reading 40, 60 and `1.234,50`
(a European decimal comma, which `U.isNumeric` correctly refuses):

| figure | before |
| --- | --- |
| total row | `100.00 *`, one footer sentence |
| `Sum` card | `100.00` — no `*`, no tooltip |
| `Avg` card | `50.00` — the average of **two** cells where the column shows three |
| `Min` / `Max` | `40.00` / `60.00` — ranked only over the cells they could read |
| `Count` card | `3` — correct, and untouched by this round |

The card is the figure somebody reads **first**, and it sat one line above a total row that did say
so.

### 24.2 `Reco._reportColumnTotal` is now the one reader for a report column

`mn`/`mx` moved into the helper, so the total row and every card come out of the same arithmetic.
Two implementations of *"what this column adds up to"* is exactly what T-26-5's own comment warned
about: the count lives **with** the arithmetic so the figure and the sentence cannot disagree about
how many. There is deliberately no `filled` field — the `Count` card wants the count of non-blank
cells, which is `n + excluded` exactly, and a fourth number that is the sum of two others is a
fourth number to keep in step.

### 24.3 All four, not only `Sum`

The ticket's **Fix** names `Sum` because that is where the helper was reusable; its **What** names
all four, and all four drop the cell. Scaling the fix down to `Sum` would have left three cards
with the same silence. `Avg` is the worst of them for being less obviously a sum. `Min` and `Max`
rank only what they could read, and the dropped cell may be either extreme — **R24k** makes that
concrete by overriding the cell to the **largest** value and watching `Max` pick it up.

`Count` is exempt **by construction**, at the one place the mark is decided (`func !== 'Count'`),
rather than by a special case bolted on later. A cell holding characters that are not a number is
still a filled cell.

### 24.4 One sentence per column, and the mark follows the total row

`noteFor(col, tt)` is keyed by column, so five figures on `Net` that all dropped the same cell
produce **one** footer sentence (**R24f**). Without that the operator reads the same sentence five
times and learns to skip it.

The card is marked the way the total row already is — a `*` on the figure, the count in the
tooltip, the sentence in the footer — so there is one convention to learn. The numbers are on the
card as `data-card-col` / `data-card-func` / `data-card-excluded`, for the reason the total row's
are: a figure is the one thing a test must be able to read as a **value** and not as a sentence.

### 24.5 Fewer passes, not more — as an operation count

The card loop memoises the helper per **column** for the life of one render. Five cards on `Net`
plus a total row on `Net` walk the rows **twice** where the old loop walked them **six** times
(once per card, `Count` included, plus the total). **R24l** and **R24m** count the calls to the one
function that walks the rows; **R24n** is the clause that catches a memo keyed wrongly, because a
single global slot would hand one column's cards another column's figures and both counts would
still pass. An operation count and never a wall clock (§16.4a).

The original comment's caution — *"One pass, no `Math.min(...nums)`: spreading a 200k-value array
threw Maximum call stack size exceeded"* — is kept rather than undone; it now lives in the helper.

### 24.6 One trap this round walked into twice

The `*` lives **inside** `.card-value`, beside the `<strong>`, as the total row's does inside its
`<td>`. So a check that reads the whole node and compares it to `'100.00'` asserts the fix did
**not** land, and the round's own probe went red on a correct build until the figure and the mark
were read separately. And the pass-count arm runs after the control reverted the override, so `Net`
is back to its formula values — the first version of `R24n` expected the overridden figures. Both
are the same lesson: a check that encodes an assumption about state the previous arm left behind
has to say so, and `R24n`'s comment now does.

## 25. T-S10-13 — "Document numbers saved", and then one toast later "it was NOT saved"

### 25.1 The harm, and the ordering that produces it

`Reco.saveAllocation` tests the number against **this window's** copy of the shared master and
refuses properly when it is taken there. But the authoritative test lives inside the merge intent,
because it is the only one that runs on the file the merge has just read — so it resolves **after**
the function has closed the dialog and said *"Document numbers saved"*. When the share disagrees,
`Reco._dnRefused` takes the claim back off both files and said so in an **error toast**, which is
the exact shape MR-6 was raised about: *"the one toast that did fire scrolled away in four
seconds"*.

Measured (`scratchpad/dn/probes/d1_repro.mjs`): B writes `GL-7000` to the share, then A allocates
the same number while A's in-memory master still does not know it, so A's immediate test passes:

```
knewBefore:  [D1, D2]              <- no GL-7000: only the intent can catch this
right after: success: Document numbers saved      modalOpen: false
after flush: error: ... was NOT saved             modalOpen: false
```

The ordering is the whole fixture. Reaching the **in-memory** refusal instead measures MR-7, not
this.

### 25.2 The constraint this is built around

`saveAllocation` must stay **synchronous**. The comment at its head records why, and it cost a
suite run to learn: two existing callers do not await it, so when its tail moved to a later tick it
closed a dialog the caller had opened in the meantime — `run_reverse_e2e` went **254 → 236**, with
`Reco.reverseEntry()` finding `_reverseState` already null and silently minting no mirror. *A UI
entry point that other code drives must not become async quietly.*

So the tail (`App.closeModal`, `App.navigate`) still runs on the same tick, unchanged. Only the
**sentence** moved. A UI entry point may not become async — but it may speak late.

### 25.3 What was built

- **`_dnRefused` opens a modal**, the same precedence `_confirmEntryOnShare` uses for a journal
  entry that may not have landed, and for the same reason: a document number the operator believes
  is theirs is a **resolver** for every future re-upload, so a row carrying it resolves to somebody
  else's accounting reference. The title names the number and says it was not saved; the body names
  the number, the entry that holds it, the entry it was taken off, and
  `reco/docNumberMaster.json`.
- **The toast stays as well.** It is what reaches somebody looking at the grid rather than the
  dialog; the modal is what will not scroll away.
- **The footer carries the way back** — a button reopening the allocate dialog for *this* entry
  with the refused number already cleared (the correction removed it from `entry.docNumbers`, which
  `openAllocateModal` reads), so the next thing on screen is the box to type a different one into.
- **The success waits for the merge**, from a promise nothing awaits, and only if
  `Reco._dnSaid[accountingId]` is unset. `_dnRefused` sets that flag **before** either of its
  sentences, so the success cannot slip out between them even if its flush resolves first. A folder
  that cannot be reached claims nothing: the `.catch` is deliberately silent, because the claim is
  owed and retried on every save and the share-write machinery has its own sentence for it.

### 25.4 The control that keeps the deferral honest

A deferred sentence that never arrives would be a worse bug than the one this round fixes, so
`D2n`–`D2p` allocate a number nobody holds and assert that it lands **on the share and on the
entry** and is still confirmed. The success is a save, not just a sentence.

### 25.5 The mutation grid caught a flaky check of my own

`D2m` ("A's entry does not carry the number in memory either") went red under four mutations that
touch nothing but the toasts. That is not a finding about the code — it is a flaky check, and the
explanation was already written in `_dnRefused`'s own comment: *"by the time it runs, `_takeDisk`
has replaced this template's array with the share's and `entry` above is a detached copy"*, which
is why the function re-finds the entry by `accountingId`. The probe was holding the **pre-flush
object**, so it read whichever copy it happened to get. It now re-finds the entry the same way the
code does.

Worth keeping as a lesson in both directions: a mutation that turns a check red for no reason
related to the mutation is the grid telling you about the **test**, and the fix was in a comment
the code already carried. After the repair `R25m` is red under no mutation at all, which is the
correct status for a control — none of the seven touch the data path.

The grid as it stands, named by the `[94]` check carrying each assertion:

| mutation | red |
| --- | --- |
| no modal (the pre-round toast only) | `R25e/f/g/h/i` |
| the success fires on this tick again | `R25c`, `R25k` |
| the deferred success ignores `_dnSaid` | `R25k` |
| the success dropped entirely | `R25n` |
| the modal names no entry | `R25g` |
| no way back in the footer | `R25i` |
| the toast dropped, modal only | `R25j` |

(Also, for the third time in this project: a **backtick inside a page-side template literal closes
it**. The repaired comment quoted `entry` in backticks and the probe threw `SyntaxError: missing )
after argument list` at parse time.)

## 26. T-S10-14 — the reversal mirror moved on the share and nobody said so

### 26.1 The harm

T-S10-11 gave the reversal mirror the same protections the generated entry has: a per-window
suffix, an `idNonce`, the shared append rule, and `e.reversal.reversalId` set **inside the mutate**
from where the mirror actually landed. So the mirror is never lost and the original→contra link is
always right. What the reversal door did **not** get is `Reco._noticeReMint`, which the Generate
door has had since that same ticket. The toast and the `reco/reversals.log.csv` line were both
written from `newId` **as announced**, so when the share re-minted the mirror they named a
reference the mirror does not have — and that reference belongs to somebody else's entry.

Measured (`scratchpad/rev/probes/r1_repro.mjs`):

```
toast:                  Entry AEMVJWG1C4AB reversed by AEPINREVZZZZ
e.reversal.reversalId:  AEPINREVZZZZ1        <- set in the mutate, and right
reversals.log.csv:      AEPINREVZZZZ on BOTH lines, one of them a colleague's
notice modal:           none
the share:              both mirrors present, under different references
```

The data was correct throughout. Only what the operator was told was wrong — and the number they
were told is the one they would quote and write on a document.

### 26.2 The window is narrower than the ticket said, and finding that was most of the round

T-S10-14 described *"two people reversing different entries in the same millisecond and drawing
the same two base-36 characters — about 1 in 1,296"*. That is the condition for the **clash**, not
for the stale announcement.

`Reco.reverseEntry` does not mint blind. It reads the share itself and `AppState.adoptLedger`s the
result **before** the mint — twice (`sh` before the plan re-check, `sh2` before the writes) — so
its own local de-dup loop normally sees the colleague's mirror and corrects `newId` before a word
is said. The announcement can only go stale if the colleague's write lands **after every read this
window made and before this window's merge job**: one read-write cycle, *on top of* the 1 in 1,296.

Three versions of the probe measured B's own de-dup loop doing the right thing and reported it as
the bug. The fourth stubs `Reco._reverseReadShareHistory` so that **every** read B makes has the
colleague's mirror filtered out of what it RETURNS — the share file is untouched. That is the
honest shape of the window and nothing more.

```js
/* in the probe: the stub applies to EVERY read, not just the first.
   Hiding only the first leaves sh2 to inform the local loop, which is a
   different measurement. */
Reco._reverseReadShareHistory = async function () {
  const r = await realRead.apply(Reco, arguments);
  if (r && r.ok && r.base && Array.isArray(r.base.TPL_E)) {
    r.base.TPL_E = r.base.TPL_E.filter(e => !e || e.accountingId !== HIDE);
  }
  return r;
};
```

### 26.3 The fix, and the one place it lives

Everything downstream of the mint — toast, log, `AppState._activeEntryId`, the allocate dialog —
already read `newId`, so a single adoption after the flush fixes all of them:

```js
await AppState.flush();
const announcedNewId = newId;
if (mirror && mirror.accountingId && String(mirror.accountingId) !== String(newId)) {
  newId = String(mirror.accountingId);
}
```

Then the toast names the real reference, the log line carries both, and:

```js
if (announcedNewId !== newId) {
  Reco._noticeReMint(tpl, announcedNewId, mirror, []);
  return;                        // deliberately NOT the 300ms allocate dialog
}
if (newId) setTimeout(() => Reco.openAllocateModal(newId), 300);
```

The empty array is the honest fourth argument: a reversal **frees** document numbers (step 6), it
registers none, so there is nothing to re-point, and `_noticeReMint` skips that block on it.

**The `return` is load-bearing.** `reverseEntry` opens the allocate dialog on a 300 ms
`setTimeout`, which would replace the notice — the one sentence that matters — a third of a second
after it appeared. The operator can allocate from the entries tab, which the notice's own
re-render leaves them looking at. Being told the reference is wrong comes before being asked to
type numbers against it.

### 26.4 There was never a log line to correct

The ticket's Fix asked for *"a correcting line to `reco/reversals.log.csv` rather than rewriting
the one already there, because the log is append-only by design"*. But `_reverseAppendLog` is
called **after** `await AppState.flush()`, so at the moment the adoption happens the log holds
nothing about this reversal yet. One line carrying `reversalId` **and** `announcedReversalId` is
the same audit trail with nothing to reconcile, and append-only is respected by construction.

The column is empty on every ordinary reversal (`R26m`), so a log only ever read by a human does
not grow a column of noise.

### 26.5 `_reverseAppendLog` builds a FIXED field list — a bug the probe found

```js
const flat = { at: …, by: …, template: …, reversalId: line.reversalId || '', … };
await window.pywebview.api.append_csv_rows('reco/reversals.log.csv', Object.keys(flat), [flat]);
```

The field list is explicit, so a caller passing a new key gets it **dropped in silence** and the
column never appears. Three checks were red on a build whose `reverseEntry` was already right, and
the premise check `R26i` (*the log has both a `reversalId` and an `announcedReversalId` column*) is
what located it. **Anything new passed to `_reverseAppendLog` must be added to that literal too.**

### 26.6 Two mutations measured nothing until the probe waited past the setTimeout

| mutation | turns red |
| --- | --- |
| the mirror is not adopted (the pre-round state) | `R26f`, `R26g`, `R26h`, `R26j`, `R26k`, `R26l` |
| adopted, but no notice is raised | `R26g`, `R26h` |
| the notice is raised without the early return | `R26g`, `R26h` |
| the announced reference is not passed to the log | `R26l` |
| ...passed on EVERY line, not only the moved one | `R26m` |
| the log's `flat` literal drops the field | `R26i`, `R26l`, `R26m` |
| the early return is taken on every reversal | `R26c` |

The third and the seventh were `red=NONE` on the first pass. Both are about **which modal is on
screen a third of a second later**, and the probe was reading it straight after the flush, so the
notice was there whether or not something replaced it. The probe now waits 450 ms past the
`setTimeout`, which also bought `R26c` — the control that the ordinary path still gets its
allocate dialog.

**The general lesson: a check that reads UI state can only measure a deferred change if it waits
past the defer.** This project already keeps a rule that performance gates must be operation counts
and never wall clocks (§16.4a); this is the opposite case, where a wall-clock wait is the only
honest way to read a `setTimeout`'s effect, and the right length is *past the known delay* rather
than a guess.

### 26.7 A prefix is not a reference

`Reco._reMintAgainst` returns `U.accountingId() + (++n)`, so the re-minted reference has the
announced one as a **prefix**: `/reversed by AEPINREVZZZZ/` matches a *correct* toast naming
`AEPINREVZZZZ1`. Two versions of this probe reported first the harm and then the fix off exactly
that ambiguity.

Every id comparison in `[95]` is `===` against `e.reversal.reversalId`, and every field of
`reversals.log.csv` is read by **column index** off the header row rather than by a regex over the
line.

## 27. T-C27-7 + T-C27-9 — two added columns with one name

### 27.1 One state, two different defects

The state: `tpl.additionalColumns` and `sess.extraColumns` both hold an entry called `Dup`.
`_rowWithExtras` walks the concat of the two lists, so **the last writer wins** and that is what
the grid draws. Every helper reader resolves the column name through `Reco._extraDef`, which
searches `tpl.additionalColumns` only and returns the **first** match. The two answers are not
the same object and need not be the same value.

Measured (`scratchpad/dup/probes/p1_repro.mjs`, arm A) with extras
`[Mid, Dup(template formula "xM"), Dup(session, typed)]`:

```
the grid cell            ''      <- the walk's LAST writer wins
every helper reader      'xM'    <- _extraDef resolves the FIRST entry
filter "is empty"        0 rows  <- a filter hiding a row it should show
the slicer offered       ['xM']  <- a value no row on screen showed
Find/Replace             1 hit   <- in a column the screen showed blank
```

### 27.2 The round's correction to T-C27-7

T-C27-7 attributes those five lines to its own mechanism — `_extraValueForRow` passing `ac.name`
to a walk that stops at the first entry carrying it. **It does not cause them.** Asking about the
first entry stops before the first entry, which is correct, so that entry answers its own value
whichever form the stop takes. `R27f` and `R27n` are the checks that pin it: after the fix
`_extraDef` still answers the template entry, and that entry still answers `'A'` on the ticket's
own fixture.

What the entry stop does fix is the ticket's own **measurement**, which is confirmed exactly: on
`[Dup="A", Mid="M", Dup=CONCAT("x",{Mid})]`, asking about the **third** entry answered `'x'`
against the walk's `'xM'`, because `{Mid}` was never evaluated. That list is **not reachable
through the editor** — `saveTemplate` refuses its own duplicate, *"Added column "Dup" is defined
twice"* (`R27l`) — so it arrives from a hand-edited `recoTemplates.json`, `App.importBackup` or a
different build.

**So the two tickets split cleanly: T-C27-7 is a contract defect in a helper with nine callers,
and T-C27-9 is the defect that produced the harm both tickets describe.**

### 27.3 The stop is resolved to an index once

```js
let stopAfter = -1, stopBefore = -1;
if (typeof upto === 'number') stopAfter = upto;             // _corrUpto: stop AFTER
else if (upto && typeof upto === 'object') {                // an ENTRY: stop BEFORE it
  stopBefore = extras.indexOf(upto);
  if (stopBefore < 0) stopBefore = extras.findIndex(a => a && a.name === upto.name);
} else if (upto != null) stopBefore = extras.findIndex(a => a && a.name === upto);
```

Both at `-1` walks the whole list, which is byte for byte what the name form did for a name that
was not in it. **The entry form is the one callers should use**: `_extraValueForRow` and
`_extraBaseValue` both hold the definition, not an index. The name fallback for an entry that is
not in the list exists so a detached clone cannot throw or silently walk everything; no caller in
the file passes one.

`rowFull`'s parameter is now `upto`, not `uptoName` — T-C27-8 asked for that, because the name
described a single-shaped argument that stopped existing when `_corrUpto` began passing a number.
The two sentences above it about a row memo are still wrong and still T-C27-8's; the comment says
so rather than leaving a reader to find out.

### 27.4 `_extraBaseValue`'s change is unmeasurable, on purpose

`_extraBaseValue` resolves its entry through `Reco._storeColumn`, which searches
`tpl.additionalColumns` only and returns the first match — and template entries come first in the
concat, so **the name stop and the entry stop resolve the same index for every input**. The
mutation that reverts it reports `red=NONE`.

That is the right result, not a probe fault. The change is there so those two adjacent lines
cannot disagree about which `Dup` is meant if `_storeColumn` is ever made session-aware. **A
change that cannot be gated is recorded as ungated**, in the ticket and here, rather than left
sitting inside a grid that looks clean.

### 27.5 The repair, and why it is a rename on the open

`Reco._dedupeSessionExtras(sess, tpl)` from `ensureSessionShape`, whose `tpl` is a new optional
second parameter:

| caller | passes a template? | why |
| --- | --- | --- |
| `Reco.render` | yes | the open; this is where the repair happens |
| `Reco.ingestData` | yes | the other path that brings a session into existence |
| `Panes._viewFor` | **no** | `extraColumns` is a DATA key on that proxy, so a rename would write through to the owner and repeat `Reco.render`'s work |
| `Reco.makeSession` | no | a fresh session has no extras to collide |

**Rename, not drop.** The ticket offered either. The session entry is the operator's own column
and may carry values they typed, so dropping it discards their work to tidy a collision nobody
told them about. `<name> (session)`, then `(session 2)` and up, so a second collision cannot land
on the name the first rename wanted (`R27q`).

**`Reco._reKeyColumnName` moves what names the column**: `sess.manualTags` (keyed
`row._id + '||' + name`, so the suffix moves), `columnFilters`, `columnWidths`, `slicers`,
`hiddenCols`, `columnSorts.col`, and the **inner** keys of `cellFormats` / `cellFormulas`, which
are keyed by row first. Nothing on a shared pk-keyed master is touched: a session-only extra's
value never reaches one (decision P).

**The template entry is never touched** (`R27e`) — it is the shared one, and renaming it would
change what every colleague sees.

**And it is said**, one sentence per collision naming both names, deferred by `setTimeout(0)` so
it does not fire inside a render that has not drawn the new heading yet.

### 27.6 Why `ensureSessionShape` and not `saveTemplate`

`saveTemplate` has no session in scope **by design** — the same reason F3's prune could not be
widened — and refusing at a third place would not help a share already in this state.
`ensureSessionShape` is the only function that sees both lists on every open, so the repair is
also a migration.

### 27.7 The mutation grid, and the suite fixture that was already in this state

| mutation | turns red |
| --- | --- |
| the entry form treated as a name again | `R27m` |
| `_extraComputedValue` passes the name | `R27m` |
| `_extraBaseValue` passes the name | **nothing** — see 27.4 |
| the repair is never called | `R27b/c/d/g/h/i/j/o/p/q/r` |
| it renames in silence | `R27c`, `R27p`, `R27r` |
| the rename carries nothing with it | `R27d`, `R27h`, `R27i`, `R27j` |
| the TEMPLATE entry is renamed instead | `R27b/e/f/g/h/i/j/k/q/r` |
| the standard columns are not "taken" | `R27o`, `R27p` |
| the rename does not seek a free name | `R27q`, `R27r` |
| only the rendering pane is re-keyed | `R27v` (via `p3_split.mjs`) |
| the pane walk asks `pane.view` | `R27v` (via `p3_split.mjs`) |

The third row is the documented no-op. The re-key mutation is worth reading twice: removing it
turns `R27h`/`R27i`/`R27j` red as well as `R27d`, because `hiddenCols` left naming `Dup` then
hides the **template** column — the operator's own view setting applied to somebody else's
column.

**`run_correction_e2e` `[R2-F12]` builds this exact collision** and stayed green, because it
captures its extras list immediately after `saveTemplate` and before the first `App.navigate` —
the one window in which the state exists. That is luck of ordering, not a property, so its header
now says so and `[R2-F12x]` asserts the rename. A fixture that silently stops testing what its
name claims is worse than one that fails.

### 27.8 The pane half, and two wrong versions of it

`Reco._dedupeSessionExtras` renames entries in `sess.extraColumns`, which is a **DATA** key — one
copy on the owner, reached through either pane. So are `manualTags`, `cellFormats` and
`cellFormulas`. But `columnFilters`, `slicers`, `columnWidths`, `hiddenCols` and `columnSorts` are
**VIEW** keys: one copy per pane. Re-keying only the session `Reco.render` is holding leaves the
other pane's settings naming `Dup`, which after the rename resolves to the **template** column —
that pane then filters and hides somebody else's column.

**Wrong version 1: `pn.view`.** Measured (`scratchpad/dup/probes/p3_split.mjs`): after
`Panes.openSplit()` the panes read

```
p0:noview   p1:view
```

The **owning pane has no view object**. Its VIEW keys live on the owner session itself and only
the second pane gets a proxy, which `Panes.viewFor` encodes as `p.view || owner`. Asking
`pn.view` missed the owning pane every time.

**Wrong version 2: an arm that could not see the difference.** With `App.navigate('reco')` the
repair fires on **p0's** render, so `sess` is already the owner — the owning pane's own object —
and `pn.view` picks up p1. Both panes move, and the mutation reported `red=NONE`. The arm had to
render the **non-owner pane alone**, which is a real idiom and not a test contrivance: three sites
do it, each guarded by `pane !== Panes.owner()`.

| site | why it renders one pane |
| --- | --- |
| `Reco._slicerRepaint` | a slicer applied in the non-owner pane |
| `Reco._corrRepaint` | the correction panel's own repaint |
| the virt-cols escalation in `refreshGrid` | `#recoTableArea` only exists on the owner pane |

On that render `sess` is p1's view, and nothing but `Panes.viewFor` names p0's object. `R27u`
asserts the arm rendered that way; `R27v` is what it buys.

**The lesson is the one this project keeps relearning from a different direction:** a mutation
that measures nothing is usually the ARM's fault, not the grid's. Two of the eleven came back
`red=NONE` on the first pass here — one legitimately (27.4) and one because the fixture rendered
the pane that hid the defect.

## 28. T-24R2-4 — a custom master's own id

### 28.1 The harm

`Masters.catalog` pushed `{ id: 'custom:' + idx }`. A `master_lookup` stored that as
`masterCfg.source`, and `Home.deleteCustomMaster` did `AppState.customMasters.splice(idx, 1)`.
Nothing re-pointed anything.

Measured (`scratchpad/cm/probes/c1_repro.mjs`):

```
three masters:   Vendors / Centres / Regions, each answering a different
                 Val for Code=K1
the lookup:      masterCfg.source = 'custom:1'   ->  FROM-CENTRES
delete master 0: allowed, no toast, no confirm beyond "Delete this master?"
the same cell:   FROM-REGIONS
additionalColumns:  byte-identical
XlSchema.tplSignature:  unmoved
Reco.keyRuleSig:        unmoved
```

The ticket named only `tplSignature`. **The second signature matters more**, because
`Reco.keyRuleSig` is what is stamped on every row as `_pksig` and what the dead-key refusals read:
a key rule that silently reads a different table keeps the same signature, so nothing is refused
and nothing is said.

### 28.2 The four parts

| part | where |
| --- | --- |
| mint `cm.uid`, re-minting duplicates | `Masters.ensureCustomUids` |
| emit and resolve the uid | `Masters.catalog`, `Masters._customAt`, `Masters._customIsStable` |
| repair at the dangerous moment | `Home.deleteCustomMaster`, `Masters._rewriteLegacyCustomSources` |
| allow it in a row key | `RecoTemplate._pkEligible1` |

### 28.3 Why the mint is AFTER the `_snap` loop

`AppState.load` snapshots every `PERSIST_KEYS` value so the first save writes only real changes.
Minting uids **before** that loop would make the snapshot match the minted bytes, and the uids
would never reach the file — a different uid every session, and a template naming
`custom:<uid>` would resolve nothing. Minting **after** leaves them dirty, so the next legitimate
`AppState.save` writes them. It is the same shape `ensureSessionShape`'s `_autoLoadAttempted`
deletion uses.

`customMasters` is in `PERSIST_KEYS`, which is what makes this safe: a template saved with a
`custom:<uid>` source and the uid itself go out in **one** save and cannot be durable apart.

### 28.4 The legacy resolver is kept for good

```js
_customAt(token) {
  const key = String(token).slice(7);
  if (/^\d+$/.test(key)) return list[parseInt(key, 10)] || null;   // legacy, by position
  return list.find(cm => cm && String(cm.uid) === key) || null;    // stable, by search
}
```

A config written by any earlier build still reads the table it always read (`R28c`), and that
back-compatibility is the whole risk of this change, so it is asserted rather than assumed.

The rewrite to a uid happens **only in `Home.deleteCustomMaster`**, for two reasons:

- it writes `recoTemplates`, the shared file, so it belongs to a gesture the operator chose — a
  background rewrite of a shared template file is the shape T-24R2-1 is about;
- the delete is the only moment it matters, because a position only moves when the list does, and
  it is the **last** moment the index is still correct.

### 28.5 A custom master as a key source — the decision the ticket left open

Nothing separated it from the Accounts Master except the identity:

| | Accounts Master | custom master |
| --- | --- | --- |
| shared table anyone may edit | yes | yes |
| frozen into `_pk` at mint (decision G) | yes | yes |
| a recalculated cell marked by `keyDrift` | yes | yes |
| indexed by `Masters.indexFor` | yes | yes — it is generic over `cfg.source` |

So the refusal was about the **position**, not the master, and it now reads that way: the stable
form is allowed, a bare index is refused with the same sentence plus what to do about it, and a uid
naming nothing is refused for what it is. `docNumbers` and `corrections` stay refused for reasons
that do not apply to a custom list — one grows as the team posts, the other is keyed **by** the row
key.

### 28.6 The grid caught two faults in its own mutations

| mutation | turns red |
| --- | --- |
| the catalog emits positions again | `R28b` |
| `ensureCustomUids` mints nothing | twelve checks |
| `_customAt` drops the legacy index arm | `R28c` and nine more |
| the delete does not rewrite the sources | `R28e`, `R28f` and seven more |
| the rewrite is MOVED after the splice | the same nine |
| the key-user scan is skipped | `R28m`–`R28p` |
| nothing counts as being in the key | `R28m`–`R28p` |
| the warning is dropped from the CONFIRM | `R28i` |
| ...and from the TOAST | `R28j` |
| `_customIsStable` calls an index stable | `R28r` |
| `_pkEligible` refuses every custom again | `R28q`, `R28s` |
| a duplicate uid is not re-minted | `R28u` |

Two were wrong on the first pass, and `red=NONE` is what said so — the grid auditing the test
rather than the code:

- *"the rewrite happens after the splice"* **added** a second call instead of moving the first, so
  the original still did the right thing. The runner now takes a **list** of edits for one
  mutation, which is what moving a call needs.
- the warning mutation was named for the confirm **and** the toast while only emptying the confirm.
  The toast has a mutation of its own now.

### 28.7 A probe fault that cost four runs, and will happen again

A probe that throws before its own `bridge.proc.kill()` leaves the bridge **listening**. The next
run then dies with

```
OSError: [Errno 98] Address already in use
```

which is a port complaint standing in front of the real error. Moving to a "free" port does not
help, because the next failure leaves a bridge there too. Two genuine faults hid behind it:

- **`AppState.recoSessions` is the per-pane VIEW table** (MODULE 4b) and is repointed at whichever
  template the owning pane shows. A fixture built in one `page.evaluate` and read in a later one
  can find it `undefined`; the read must use `AppState.recoSessionsOwned`.
- **`page.evaluate(STRING, arg)` ignores `arg`.** A string first argument is an *expression*, not a
  function to call with the second, so `evaluate(SETUP, [id, src, inKey])` evaluated to the
  function object and never ran it. The house idiom in `run_store_e2e` is concatenation —
  `SETUP + '(' + JSON.stringify(args) + ')'` — and that is why.

`scratchpad/cm/probes/lib.mjs` now frees the port before spawning, by finding the listening socket
in `/proc/net/tcp` and the process holding its inode. **Any probe copied from another round's
directory should take that change with it.**

## 29. T-24R2-2 — a hand-added row's frozen business key

### 29.1 Three arms, and the third is not in the ticket

`Reco._ssBlankRow` writes no `_pk` on purpose, so `Reco.rowKey`'s `_ssAdded` branch answered
`Reco.getRowPK(tpl, row)` **live**, off the cells, every time.

| arm | what `rowKey` answered | the harm |
| --- | --- | --- |
| A — a typed key | `NEW-1`, then `NEW-2` once the key cell was edited | the correction stayed under `NEW-1`, unreachable from its own row, silently |
| B — one DERIVED component | `null` | every door refused the row, while the grid showed `L-D9` for the same column |
| C — a MULTI-component key with a derived part | `'D9||'` | truthy, accepted everywhere, and not what the extract computes (`D9||L-D9`) |

Arm C is the one the ticket misses, and the screen made it worse rather than better: decision G
recovers a key extra's value **out of the key**, `'D9||'` splits into exactly `primaryKeys.length`
parts, and the part for `Look` was `''` — so the derived cell rendered **blank**. Arm B shows
`L-D9` for the identical formula only because its key is null, so there is nothing to recover and
the value is computed.

### 29.2 `_bk`, not `_pk` — and why the chokepoint is the assertion that matters

```js
if (row && row._ssAdded) return row._bk || Reco.getRowPK(tpl, row) || null;
```

`Reco.writeVerKey` returns `row._pk` and is the key a version row in the shared day file goes
under. A `_pk` on a session-only row would therefore start appending change rows for a row the
operator chose **not** to persist, erasing the difference between **+ Row** and **+ Persistent
Row**. `_bk` carries the business key and nothing else.

Two assertions, deliberately:

- **`R29l2`** — `writeVerKey` answers `null` for all three frozen rows while `_bk` is set. This is
  the property.
- **`R29l`** — not one version row reached `reco_data/` across every arm. This is the consequence.

The mutation that freezes into `_pk` turns `R29l2` red and leaves `R29l` **green**, which is
precisely why both exist: an empty day file would also pass on a build that never wrote one, and
T-S10-20's point is that the question is asked at the **write**, not at the gesture.

### 29.3 The derived columns ARE computed — the ticket's open decision

```js
const upto = Reco._keyClosureUpto(tpl);
const src = upto >= 0 ? Reco._keyScratch(tpl, sess, row, upto, Reco._fullCtx(), {}) : row;
```

The same machinery the upload mint uses. A hand-added invoice is keyed by the rule the file would
have keyed it by, so the correction filed on it is applied when the extract next contains that key
— which is the whole point of letting the row have a key. Nothing new appears on screen: the grid
already showed those values, which is arm B's premise.

### 29.4 When it refuses to freeze

| condition | why |
| --- | --- |
| any component blank | the row is still being typed in; it keeps answering off its cells and its key still **moves** (round 2's behaviour) |
| any component `#ERR` | an immovable key minted from a broken formula is one no later correction of the formula could undo |

The freeze is the **last** thing that happens to such a row, not the first.

### 29.5 The re-key, and which entry wins

A partial multi-component key is truthy, so a correction can be filed under `'D9||'` before the key
is complete. `Reco._reKeyRowMasters` re-files the four pk-keyed masters the ticket names —
`manualOffsetMaster`, `correctionMaster`, `groupMaster`, `commentMaster`.

**An entry already under the frozen key wins** (`R29o2`). The frozen key is the one the extract
carries, so what is already there belongs to the real row; the hand-added row's partial-key entry
is the one to drop. The mutation that clobbers it is in the grid.

### 29.6 `_pksig` is absent on a plain-column key, and that is right

`Reco.keyRuleSig` returns `null` unless `Reco._keyExtraSet` is non-empty, because only an **added
column's definition** can be redefined — a template column's value is on the row. An uploaded row
on such a template carries no signature either, so the hand-added row matches it. `R29p` asserts
the absence and `R29p2` the presence on a key that names an extra; read apart, the first looks like
a gap.

### 29.7 Two faults of this round's own

**The pre-freeze key was read too late.** The freeze first used `Reco.getRowPK` for the "previous"
answer — which reads the cells **as they are now**, i.e. the new key — so `was === key` and the
move never happened. `R29o` was red with the correction left under `'D9||'`. `applyEdits` now
captures the answer **before** the edit lands and passes it in, because only the caller can know
it:

```js
const preKey = new Map();
edits.forEach(e => { const r = e && e.row;
  if (r && r._ssAdded && !r._bk && !r._pk && !preKey.has(r)) preKey.set(r, String(Reco.rowKey(tpl, r) || '')); });
```

**A stale comment, found by copying it.** `_ssBlankRow`'s note named *"_ssFillColumn's two,
_ssCommitCell and _ssClearCell"* as the four writers guarded by `if (row._pk)`. **None of those
three functions exists.** T-S10-20 folded them into `Reco.writeVerKey` and the list was never
corrected; I copied it into my own comment before checking, and found it only when the day-file
control would not go red under the `_pk` mutation. Both notes now name the chokepoint and its real
callers: `_ssCommit`'s two (`'filled'`, `'changed'`), `_ssClearActive`'s (`'cleared'`), and the
fill at the paste door.

**The general lesson, which this project keeps paying for in a new place each time: a comment that
names functions is a comment that rots.** The ones that have survived name a CHOKEPOINT and say
what it decides. Both corrected notes are written that way.

## 30. T-24R2-3 — a renamed column keeps its place

### 30.1 The five lists did not behave alike

Renaming the added column `Ref` to `Ref2` on a template that names it in all five stored lists,
measured (`scratchpad/rn/probes/n1_repro.mjs`):

| list | before | after | |
| --- | --- | --- | --- |
| `primaryKeys` | `['Doc','Ref']` | `['Doc']` | **pruned** by `_pkEligible` |
| `displayOrder` | `[Doc,Ref,Other,Amount]` | `[Doc,Other,Amount]` | **pruned** |
| `correctionContextCols` | `['Ref']` | `[]` | **pruned** |
| `aggregateBy` | `['Ref']` | `['Ref']` | **dangling** |
| `editableColumns` | `['Ref']` | `['Ref']` | **dangling** |

The ticket lists the last four as wanting "the same treatment", which assumes they share a
behaviour. They don't: two lose the setting and two go on naming a column that no longer exists —
a report grouped by nothing, an editability rule pointing at nothing. One carry-over fixes both
shapes.

### 30.2 The pairing was already in the file, 160 lines too late

The ticket proposes pairing by POSITION, guarded by "same length and same types in the same
order", and its own *Why it is only a ticket* paragraph explains why that is dangerous: a
positional pairing carries the key to the **wrong column** whenever the editor also added, removed
or reordered something, which is worse than dropping it.

T-S10-5 had already solved this with a stable `_cid` per added column, and `saveTemplate` already
held a `_cid`-first pairing — for migrating typed values, 160 lines **below** the prune that needed
it. This round lifted it:

```js
_renamedExtras(before, after)   // _cid first, the editor's slot as fallback
```

Both questions now ask it once: the carry-over before the prune, and the value migration where it
always was. The four guards are unchanged — the old name is still a column; the new name was
already in use (round 5 refuses that, it would merge two columns' records); the type changed; no
pair at all.

### 30.3 One before-list, after shipping two

The first version asked the carry-over against `RecoTemplate._openedWith` — *"did **this operator**
rename it"*, which `_openedWith` answers exactly and the stored template only approximates — and
the value migration against the stored template. Two before-lists, with a paragraph justifying
the difference.

**The mutation that swapped one for the other turned nothing red.** T-S10-7 re-reads the share at
the head of `saveTemplate` and merges field by field against `_openedWith`, so by that line the two
coincide in every state a single window can produce. The distinction was real in principle and
unobservable in practice.

Both now read the stored template. **A distinction that cannot be measured is not worth two
code paths and the paragraph explaining them** — and the grid is what said so, not an argument.

### 30.4 The question

```
"Ref" is now called "Ref2".

It is part of the row key, the team column order and the correction tab's context columns.

Keep it there under the new name?

Cancel leaves it out — and a reconciliation whose key loses a component identifies its
rows differently from every row already stored.
```

One per renamed column and not one per list, which is what `RecoTemplate._listsNaming` and
`_LIST_SAY` are for. Asked rather than assumed: it is the operator's key, and a rename is not by
itself a statement about it. On **no**, the behaviour is exactly what it was — the rename lands,
the key drops, and round 2's dropped-component sentence is still said.

### 30.5 Neither signature stays put, and that is right

The ticket's Test asks for `tplSignature` **unmoved** on yes. Measured:

```
XlSchema.tplSignature   3b3d60b4           -> a37c864c
Reco.keyRuleSig         1:a92838e8a2ca7b65 -> 1:70eb016047ef1a77
```

`tplSignature` hashes the column **names**, so any rename moves it — and it should, because a
linked workbook's header row really has changed. `keyRuleSig` moves because the key rule now names
`Ref2` and the definition hashed under it is a different one, which is exactly what T-S10-19's
refusal exists to notice. **What the carry-over protects is the key, not either hash**, and the
ticket conflated the two.

### 30.6 A mutation that measured nothing until the fixture grew

| mutation | turns red |
| --- | --- |
| the carry-over never runs | ten checks |
| it carries over without asking | `R30c`, `R30d`, `R30k`, `R30l`, `R30p` |
| the answer is ignored (always no) | `R30e/f/g/h/j/m/q` |
| only `primaryKeys` is carried | `R30f`, `R30g`, `R30q` |
| the question names no list | `R30d` |
| ...and does not say what the key costs | `R30d` |
| **the pairing is positional only** | `R30p`, `R30q` |
| the type-change guard is removed | `R30n` |
| one question per LIST, not per column | `R30c`, `R30p` |

The seventh came back `red=NONE` on the first pass, and the `_cid` arm looked decorative: with a
rename that does not MOVE the column, a positional pairing gives the same answer. `R30o`–`R30q`
are what make it load-bearing — one press of the Eval arrow renames and reorders in one save, and
slot 0 then holds a different column, so a positional pairing carries the key to `Other`.

**Same lesson as 28.6 and 27.7, from a third direction: when a mutation measures nothing, suspect
the fixture before the grid.** Three rounds running, that has been the answer.

## 31. T-24R2-7 — the AEG link is S11's third direction

### 31.1 Why the matrix could not see it

`XlSchema.aegTemplateFor` returns null unless `aegIntegration.enabled`. So with the integration off
— the default for a new template — `_exclusiveRoleConflict` has no linked template to consult and
answers null for every column. And `enabled` / `aegTemplateId` were **raw inline assignments** in
the editor's own HTML:

```html
onchange="RecoTemplate._editing.aegIntegration.enabled=this.checked; RecoTemplate.renderEditor()"
onchange="RecoTemplate._editing.aegIntegration.aegTemplateId=this.value; RecoTemplate.renderEditor()"
```

Two clicks in the order a person works — tick the override box while off, then switch on and link —
and the matrix is never asked again. Measured (`scratchpad/ag/probes/g1_repro.mjs`): null before,
a refusal after, nothing said either time, and the template stored with the integration on, the
link made, and an AEG control column carrying a manual override.

### 31.2 The gate asks about the template AS IT WOULD BE

```js
_aegLinkGate(t, what, revert) {
  const bad = RecoTemplate._aegLinkConflicts(t);
  if (!bad.length) return true;
  const hard = bad.filter(b => b.clearable);
  if (hard.length) { revert(); /* name the columns and the remedy */ return false; }
  /* warn, listing the columns and their counts */ return true;
}
```

Both handlers **apply** the change, then ask, then put it back on a refusal. Predicting the answer
from the change would mean a second copy of the matrix's reasoning; applying it first means the
existing matrix answers unchanged.

`_aegLinkConflicts` asks only about roles the column actually **holds** — `allowOverride` is held
by the box **or** by stored records (RC-7's rule), `carryForward` by its own flag. Asking about a
role a column does not hold answers about some other clash, which is not this gate's business.

### 31.3 The decision the ticket leaves open, taken as a split

The ticket proposes one answer — allow and warn — because it worries a template already in the
state could never turn its integration on. That gives up the refusal where it is most useful:

| conflict | outcome | why |
| --- | --- | --- |
| **clearable** (box ticked) | refused, naming columns + remedy | the fix is one click away in this editor |
| **unclearable** (box off, records remain) | allowed, warned | nothing to untick; refusing is a dead end |

MR-1 refuses the posting either way, which is what makes the warning sufficient.

### 31.4 Three mutations that measured nothing, and why each was the fixture

| mutation | why it looked unmeasurable | the arm that fixed it |
| --- | --- | --- |
| the ENABLE handler does not gate | enabling comes first, so nothing is linked yet and only the link handler can refuse | `R31l`/`R31m`: a stored `aegTemplateId` with the integration off — what linking and then unticking leaves behind |
| the refusal does not list the columns | with ONE conflicting column the matrix's own sentence quotes it anyway | `R31n`/`R31o`: two columns, where the list says both and the matrix says one |
| turning it OFF is gated too | turning off makes `aegTemplateFor` null, so the AEG roles vanish and there is nothing to refuse | `R31q`/`R31r`: see below |

**The third one is the interesting one, and the grid is what found it.** Gating the off-direction
looks free. It is not, for a reason that has nothing to do with the AEG link:
`_aegLinkConflicts` asks the matrix, and the matrix **also** answers about the
`{ key component, allowOverride, carryForward }` triple. A column that is both a key component and
override-flagged — a state the pk matrix prevents today and an older build could have stored —
would then make turning the integration **off** the one thing refused. That is what the `on &&`
guard buys, and nothing else in the round would have told me.

**Fourth round running where `red=NONE` meant the fixture, not the grid** (see 28.6, 30.6). The
rule is now reliable enough to state as one: when a mutation measures nothing, the first question
is what state the arms never reach.

### 31.5 What was deliberately not done

The ticket's second route — "the matrix matches input columns by `name` only while the AEG loop
falls back to `r[ic.label]`" — needs no S11 gap: MR-1's read set already covers it by adding the
label, which the ticket itself records. Left as it is.

No save-time gate was added either. A template already in the conflicting state is not made worse
by an unrelated save, and refusing one would block an import; the journal door is the backstop the
ticket names.

---

## 32. T-24R2-5 — a one-component key is its own frozen value

### 32.1 Three shapes, not one harm

`Reco.getRowPK` is `primaryKeys.map(…).join('||')` and escapes nothing, so a key component whose
own value holds `'||'` makes `Reco._keyFrozenPart`'s `parts.length === pks.length` guard fail.
The ticket treats that as one harm. It is three, and only one of them costs anything
(`scratchpad/pp/probes/p1_repro.mjs`):

| the key | minted `_pk` | parts / components | `_keyFrozenPart` | the cell | what is lost |
| --- | --- | --- | --- | --- | --- |
| **A** one component, an added column | `A\|\|B` | 2 / 1 | `null` | ⚠ recalculated | **nothing — the key IS the component** |
| **B** two components | `D1\|\|A\|\|B` | 3 / 2 | `null` | ⚠ recalculated | the frozen component, genuinely |
| **C** one component, a STANDARD column | `A\|\|B` | 2 / 1 | `null` | nothing marked | nothing — the value is on the row |

**Arm A is the common case, not the corner.** A single-component key is the shape every template
that existed before #24 has (`Reco._pkLabel`'s own note). The ticket's claim that "every fix is a
storage-format change … a migration across every file on the share" is true of arm B and false of
the shape most shares hold: with ONE component there is nothing to split, so the whole `_pk` is
the answer.

### 32.2 What shipped, both lines on the READ side

```js
/* Reco._keyFrozenPart, before any split is attempted */
if (pks.length === 1) return String(pk);

/* the mint's pipe counter */
else if (a.multi && a.pkIsExtra[c] && s.indexOf('||') !== -1) { pipes++; a.pipes[pks[c]]++; }
```

The `a.multi` guard is the other half of the same thought: a one-component key is no longer
**asked** about at ingest, because with one component nothing is lost and the question was asking
the operator to accept a loss that does not happen.

**`Reco._pkLabel` already had this shortcut** — `if (pks.length < 2) return s;`, with the note that
a single-column key "is every template that existed before #24" — so the two functions that read the
same `_pk` disagreed about the same key shape, and the one the operator sees was the correct one.
That is the cheapest tell this round had, and it was sitting forty lines away.

**No byte of storage moved.** `run_store_e2e` R32e reads the day files and all four arms' rows
carry the same unescaped `'||'` the pre-round build wrote. No migration, no new gate, **no
baseline to pin** — which is why this round added none of the four byte-identity gates §12.4 lists.

### 32.3 `pkIsExtra` on the counter is correct, and arm C is why

A standard template column's value is **on the row**, so `Reco.keyCellValue`'s fallback returns it
whatever `_pk` looks like. Nothing is recovered from storage because nothing needs to be, and
nothing is marked. Counting those rows would produce a question about a loss that cannot happen —
the same mistake the `a.multi` guard removes, on the other axis. The ticket lists this shape
nowhere.

### 32.4 Arm B is left as filed, and the question IS the answer

`D1||A` + `B` cannot be told from `D1` + `A||B` without changing what is written, and that change
round-trips the CSV control column, the four pk-keyed masters, the Special JV claims and the
posted-JV index. So the ticket's own second option is taken, and the existing warning was
**checked for honesty rather than assumed**: `Reco._keyIngestCheck` names the separator, says the
stored key "cannot be split back into its parts", says the column will show a freshly worked-out
value "marked ⚠ recalculated", and carries `hard: false`. It is a question, so the row is still
written when the operator says yes — which R32i reads off the disk rather than off a toast. The
⚠ badge stays on arm B too, which is right: there the cell really is printing a recalculation.

**And the ticket's Test paragraph specifies the mechanism it assumed, not the outcome it wanted.**
"Assert the minted `_pk` splits back into exactly `primaryKeys.length` parts" can only be true
after the storage change, and is false on the build that closes the harm. R32a–R32d assert the
outcome instead: the component is recovered, the printed value is unchanged, and the ⚠ badge is
gone — a badge on a cell showing the stored value being a false alarm about the one thing that
badge exists to report.

### 32.5 The fifth consecutive round where `red=NONE` was the fixture

Dropping the `pkIsExtra` guard from the counter measured nothing, and the grid was right:

| why it looked unmeasurable | the arm that fixed it |
| --- | --- |
| on arm C the key has ONE component, so `a.multi` short-circuits and the counter is never reached | **arm D** — a MULTI-component key whose pipe-carrying part is a standard COLUMN (`['Doc','Ref']`): `a.multi` is true, so the counter is reachable, and `pkIsExtra` is the only thing stopping the question |

Arm D also made the "shortcut fires for every key shape" mutation measure two further checks.
See 28.6, 30.6, 31.4 — the rule stated there held for the fifth round running: **when a mutation
measures nothing, the first question is what state the arms never reach, not whether the mutation
was wrong.**

### 32.6 The fix silenced a question another section's fixture was standing on

`run_store_e2e` **R11g** went red, and it was right to. R11g/R11h are about the dead-key latch —
a load the operator ABORTED re-keys nothing, so it cannot lift the latch — and the fixture reached
that abort by ingesting one row whose key value held `'||'`, declining the question. TPL_L's key is
a single derived component, so after this round there is no question to decline and the load simply
succeeded: 1 row loaded, `asked: 0`.

The fixture now reaches the abort through the **duplicate** arm (two rows minting the same derived
key), which `_keyIngestCheck` still asks about on a derived key. **R11g names which arm asked**, so
a later change to that arm fails on the premise instead of leaving R11h green on a load that was
never aborted — which is the shape of failure the premise exists to prevent, and is exactly what
would have happened here if R11g had only counted `asked > 0` against a question of any kind.

The lesson is narrower than "check the suite": a premise that reaches its subject through an
unrelated guard inherits that guard's lifetime. R11h's subject is the latch; the pipe question was
scaffolding, and scaffolding needs to say what it is standing on.
