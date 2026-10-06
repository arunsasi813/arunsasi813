# Reco Suite — Architecture & Handover

**Status as of the attached build** · `Reco.html` (≈504 KB, 10,861 lines) · `TCH.html` (≈31 KB, 625 lines) · `main.py` (Automation Hub launcher)

This document is the cold-start brief. Read it before touching code in a new session.

---

## 1. What this system is

Three cooperating pieces:

| Piece | File | Role |
|---|---|---|
| **Launcher / Hub** | `main.py` (`LauncherAPI` + `HUB_HTML`) | pywebview shell. Auth, folder resolution, filesystem bridge. Lists and launches `.html` tools. |
| **Reco** | `apps/Reco.html` | The main app. Reconciliation workbench + AEG (Accounting Entry Generator) + Special JV orchestration. Single-file HTML/JS, no build step. |
| **Special JV** | `special_jv_templates/TCH.html` + `special_jv_mapping/TCH.json` | Pluggable bespoke JV calculators. Opened in an iframe modal by Reco, return accounting lines via `postMessage`. |

**Purpose:** reconcile large finance extracts, carry corrections/offsets forward across uploads, and generate balanced double-entry accounting lines — including JVs whose maths is too bespoke for the generic AEG template engine.

**Deployment reality:** everything runs from a network/shared folder, offline, inside a single WebView2 window. There is no server. All persistence is files on disk, written through the Python bridge.

---

## 2. Folder structure

The launcher asks for one **root folder** once (admin-password gated), persists it to `launcher_config.json` next to `main.py`, and resolves every relative path against it.

```
<ROOT>/                                 ← the folder chosen at login; LauncherAPI.folder_path
├── pwd.txt                             admin password for the folder-change gate (default "admin123" if absent)
├── master/
│   ├── user.csv                        login table: col0=ID, col1=Name, col2=Email, then one column per app key (1/0)
│   └── accounts_master.csv             AEG Accounts Master — Reference,RC,Nominal,SubNominal,AnalysisKey,LOB
├── apps/
│   ├── Reco.html                       the app (filename stem must match a user.csv column, lowercased)
│   ├── lib/                            jspreadsheet.js, jsuites.js, jspreadsheet.css, jsuites.css
│   └── icon/<appkey>.png               optional tile icon (also looked up at <ROOT>/icon/)
├── icon/<appkey>.png                   alternative icon location
├── aegtemplates/<templateId>.json      one JSON per AEG template
├── reco/                               all app state, one JSON per key
│   ├── recoTemplates.json
│   ├── recoSessions.json
│   ├── entryHistory.json
│   ├── docNumberMaster.json
│   ├── manualOffsetMaster.json
│   ├── correctionMaster.json
│   ├── pendingSpecialJV.json
│   ├── groupMaster.json
│   ├── attachmentMaster.json
│   ├── commentMaster.json
│   ├── customMasters.json
│   └── aegSettings.json
├── reco_data/<TemplateName>/<MMM-YY>/<DD>.csv      versioned row store (see §5)
├── reco_attachments/<templateId>/<id>_<filename>   uploaded files
├── special_jv_mapping/<REF>.json       JV definition (ref, displayName, inputColumns)
└── special_jv_templates/<REF>.html     JV calculator UI
```

Folder names are **load-bearing** — `Store`, `Versioning`, `SpecialJV`, and `Attachments` all hardcode these prefixes.

---

## 3. The pywebview connection

`LauncherAPI` is passed as `js_api`. Reco reaches it as `window.pywebview.api.*`. Every path argument is **relative to `folder_path`**.

### Bridge methods Reco actually uses

| Method | Returns | Used by |
|---|---|---|
| `read_file(rel)` | `str` (`""` if missing) | `Store.loadAll`, `Versioning.readFile`, `SpecialJV.load` |
| `write_file(rel, data)` | `True` | `Store.save`, `Versioning.writeFile` |
| `load_master()` | CSV `str` | `Store.loadAll` → parsed by PapaParse into `aegMaster` |
| `save_master(csv)` | `True` | `Store.save('aegMaster')` |
| `load_templates()` | `list[dict]` | `Store.loadAll`, `_syncAegTemplates` |
| `save_template(id, json)` | `True` | `_syncAegTemplates` |
| `delete_template(id)` | `True` | `_syncAegTemplates` (removes orphans) |
| `list_directories(rel)` | `list[str]` ⚠️ **a list** | `Versioning.listFiles` (month folders) |
| `list_folder_files(rel)` | **JSON string** ⚠️ | `Versioning.listFiles`, `SpecialJV.load` |
| `save_attachment(tplId, name, b64)` | `{id, storedPath, size}` | `Attachments.upload` |
| `read_attachment(storedPath)` | base64 `str` or `None` | `Attachments.fetchBase64` |
| `delete_attachment(storedPath)` | `bool` | `Attachments.remove` |
| `current_username()` | `str` | `AppState.load` → `aegSettings.currentUser` |
| `return_to_hub()` | — | the ← Hub button in the header |

### Bridge methods available but **unused** by Reco

`write_csv`, `write_json`, `read_file_json`, `read_csv_json`, `read_excel_json`, `excel_sheet_names`, `list_projects`, `load_project`, `load_projects_pair`, `list_project_files`, `project_metadata`, `path_exists`, `path_exists_json`, `read_xlsx`, `write_xlsx`, `show_save_dialog`, `write_file_abs`, `launch_file`, `verify_admin_password`.

`show_save_dialog` + `write_file_abs` are the clean path for "export to a user-chosen location" — currently exports go through a Blob download instead.

### Store routing (Module 3)

`Store.save(key, data)` dispatches by key:

- `aegMaster` → `Papa.unparse` → `save_master`
- `aegTemplates` → `_syncAegTemplates` (diff existing IDs, delete removed, write all)
- everything else → `write_file('reco/<key>.json', JSON.stringify(data, null, 2))`

`Store._hasApi()` gates everything. In a plain browser it silently falls back to `localStorage` with prefix `reco_`. This fallback is why the app opens standalone for testing, and why localStorage data never reaches disk.

### Boot sequence

```js
window.addEventListener('pywebviewready', bootApp);
setTimeout(() => { if (!window.pywebview) bootApp(); }, 1000);   // browser fallback

async function bootApp() {
  await AppState.load();        // Store.loadAll → all the reads above
  await SpecialJV.load();       // scans special_jv_mapping/*.json
  populateThemeSelect();
  App._wireRecoHotkeys();
  App.navigate('home');
}
```

---

## 4. Module map of `Reco.html`

| Module | Approx. line | Contents |
|---|---|---|
| 0a / 0b | 18 / 507 | Themes (single Default, CSS-variable driven) + 7 colour palettes, separate dropdowns |
| 1 | 762 | `U` — uid, esc, num, date parsing/format, file & paste parsing |
| 2 | 867 | `FMT` — format-pattern validation (D/N/A/T/S) with regex cache |
| 2b | 907 | `Formula` — LEFT/RIGHT/MID/TEXT_BEFORE/AFTER/BETWEEN/MONTH/YEAR/DAY/AGEING/TODAY/IF, `{Col}` tokens |
| 2c | 1129 | `FilterOps` — 21 operators, shared by column filters, slicers, reports |
| 3 | 1193 | `Store` — the bridge router described above |
| 3aa | 1332 | `Masters` — uniform read over Accounts / Doc Numbers / Corrections / Custom masters |
| 3b | 1438 | `Versioning` — the `reco_data/` CSV store |
| 3c | 1640 | `SpecialJV` — registry + iframe modal |
| 3d | 1761 | `Groups` — PK-set grouping per template |
| 3e | 1898 | `Attachments` — disk-backed files linked to PKs/groups |
| 3f | 2062 | `Timeline` — merged attachments + comments per row |
| 3g | 2271 | `Comments` |
| 3h | 2443 | `FilterSets` — saved filter combinations |
| 3i | 2562 | `FindReplace` — Ctrl+F |
| 4 | 2842 | `AppState` — the in-memory shape; `save()` / `load()` |
| 5 | 2909 | `App` — navigation, modal, backup/restore (`version: 4`) |
| 6 | 3018 | `Home` — template cards, Masters grid, Special JV registry card, doc# lookup |
| 7 | 3196 | `RecoTemplate` — 5-step wizard |
| 8 | 4155 | `Reco` — the engine. Also hosts the Excel/jspreadsheet view (4514+), spreadsheet phases 2–5 (4920–5600), DOM virtualization (7411) |
| 9 | 9785 | `AEG` — generic double-entry template engine |

`AppState` keys that persist: `recoTemplates, recoSessions, aegTemplates, aegMaster, aegSettings, entryHistory, docNumberMaster, manualOffsetMaster, correctionMaster, pendingSpecialJV, groupMaster, attachmentMaster, commentMaster, customMasters`.

Reco sections: **Action** (grid / Excel view / pivot), **Correction**, **Reports**, **Entries**, **Manage**.

---

## 5. Versioned data store (`reco_data/`)

Path: `reco_data/<safeTemplateName>/<MMM-YY>/<DD>.csv`, e.g. `reco_data/BSP_RUB/Oct-26/06.csv`.

Every stored row carries three control columns:

- `_pk` — the template's primary-key columns joined with `||` (or `_auto_<uid>` if no PKs defined)
- `_ver` — `upload` for the originally loaded row, then `C1`, `C2`, … for each edit
- `_ts` — ISO timestamp

`Versioning.collapseToActive()` reduces a file to one row per `_pk`: highest `Cn`, falling back to the `upload` row. `autoLoadLatest()` opens the newest file automatically when a template is opened with an empty session.

**Implication:** edits are append-only. The CSV grows; nothing is ever overwritten in place. `appendChangesBatch` exists so a multi-cell edit produces one `Cn` per PK rather than one per cell.

---

## 6. Special JV — the whole mechanism

This is the part that trips people up. Read it fully.

### 6.1 Registration

On boot, `SpecialJV.load()`:

1. `list_folder_files('special_jv_mapping')` → JSON string → parse → array of `{name, ext, size_kb}`
2. For each `*.json`: `read_file('special_jv_mapping/<name>')` → parse
3. If the object has a `ref`, it is registered as `registry[ref]`, and `def.htmlPath` is **derived**, not read from the JSON:

```js
def.htmlPath = 'special_jv_templates/' + def.ref + '.html';
```

So **`ref` must exactly equal the HTML filename stem.** `ref: "TCH"` ⟹ `special_jv_templates/TCH.html`.

### 6.2 Mapping JSON shape

```json
{
  "ref": "TCH",
  "displayName": "TCH JV — Cross Currency & Charges",
  "inputColumns": [
    { "name": "Date" },
    { "name": "Txn Type" },
    { "name": "Currency" },
    { "name": "FC Amount" }
  ]
}
```

`inputColumns` is the **projection contract**. `Reco.openSpecialJv` copies *only* these column names (plus `_pk` and `_id`) out of each selected row into the payload. A field absent from `inputColumns` does not reach the JV, no matter what is on screen. This is the #1 cause of "the JV shows blanks".

### 6.3 Trigger path

1. A template has `aegIntegration.enabled` and a linked AEG template.
2. The AEG template's **To Account** input column is rendered as a dropdown whose options come from `SpecialJV.buildToAccountOptions()` — every `Reference` in the Accounts Master, **plus** every registered JV ref, labelled `⚡ <displayName> (Special JV)`.
3. User selects rows → *Preview Entry from Selection*.
4. `Reco.previewEntryFromSelection` splits the selection on the To-Account value:
   - `SpecialJV.isJvRef(ref)` true → into `jvBuckets[ref]`
   - otherwise → `standardRows`, which go through `AEG.buildLine` as normal.
5. The preview modal shows a **Special JV Requirements** banner per bucket with a *Complete →* button. **Generate is disabled** until every bucket in the current selection has a completed JV.

### 6.4 The iframe handshake

`SpecialJV.open(ref, payload, onComplete)`:

```js
window._specialJvInputs = payload;   // array of projected rows
window._specialJvRef    = ref;
window._specialJvDef    = def;       // the mapping JSON

// modal body contains:
<iframe src="special_jv_templates/TCH.html?t=<Date.now()>"></iframe>
```

The cache-buster means edits to the JV HTML take effect on next open without restarting the app.

The JV page reads the globals off its parent:

```js
const inputs = window.parent._specialJvInputs || [];
const ref    = window.parent._specialJvRef    || 'TCH';
const def    = window.parent._specialJvDef    || { inputColumns: [] };
```

This works because both documents are same-origin under `file://`. It is deliberately *not* `postMessage` inbound — only outbound.

The JV returns via one message:

```js
parent.postMessage({
  type: 'specialJV.complete',
  ref:  'TCH',
  jvId: 'JV_TCH_<base36 timestamp>',
  lines: [ /* accounting line objects */ ],
  primaryKeys: [ /* _pk values consumed */ ],
  inputData: inputs
}, '*');
```

Reco's listener is **one-shot** and filters on `ev.data.ref === ref`. Cancel posts the same message with empty arrays.

Line objects must use the AEG output column names: `Reference, RC, Nominal, SubNominal, Analysis Key, LOB, Cur, Reco, Dr, Cr, Doc, Desc`.

### 6.5 Pending JV lifecycle

On completion the result is pushed to `AppState.pendingSpecialJV[templateId]` with `_fromCurrentSelection: true` and persisted immediately. This means:

- A completed JV **survives a reload** before the entry is generated.
- On a later preview, pendings from earlier selections appear as *Carried forward* banners with a Discard button.
- `commitEntryFromPreview` merges standard + JV lines into one `entryHistory` record (`specialJvIds` keeps the trail), applies the post-entry classification to both the standard source rows *and* the JV-consumed rows (matched by `_pk`), then removes the consumed pendings.
- Home shows a `⚡ Pending Special JV: N` counter; template cards show a per-template badge.

### 6.6 TCH specifics

`TCH.html` is the one implemented JV. Its logic:

**Inputs it expects:** `Date`, `Txn Type` (`RAPID` or `OF*`), `Currency` (RUB/USD/EUR), `FC Amount`.

**UI:** N "TCH sections", each with a period range, a Reco code, auto-computed Rapid (RUB/USD/EUR) and OF (RUB) totals, and five manually entered Sale Data fields. Period presets are generated from the months present in the data, three slots per month (1–10, 11–20, 21–EOM), formatted `MM/DD/YY`. Each source row is assigned to a section via a dropdown.

**Lines produced per section** (zero amounts skipped, sides swapped if the amount is negative):

| # | Description | Amount | Dr | Cr |
|---|---|---|---|---|
| 1 | Cross Currency Adjustment (RUB) | `rubEqUsd + rubEqEur` | 17036 / RC 78061 | 85001 / RC 78061 |
| 2 | Cross Currency Adjustment USD | `rapid.USD` | 85001 / RC 78061 | 17036 / RC 78061 |
| 3 | Cross Currency Adjustment EUR | `rapid.EUR` | 85001 / RC 78061 | 17036 / RC 78061 |
| 4 | BSP TCH Charges | `-(of.RUB + rubEqUsd + rubEqEur + rapid.RUB)` | 35008 / RC 50000 | 17036 / RC 78061 |

Fixed on every line: `SubNominal "0"`, `Analysis Key "0"`, `LOB "51"`, `Reference ""`, `Doc ""`. `Reco` = the section's Reco Code, defaulting to `TCH<n>`.

Remarks: `Cross Currency Adjustment Entry for DD MMM - DD MMM YY` / `BSP TCH Charges for …`.

Submit refuses to post unless every section has valid dates **and** each currency balances to within 0.01.

---

## 7. Known issues and gaps

### Blocking

1. **`self.data_root` does not exist.** `save_attachment`, `read_attachment`, and `delete_attachment` all reference `self.data_root`, but `LauncherAPI.__init__` only sets `_window`, `current_user`, `folder_path`. Every attachment call raises `AttributeError`. The JS catches it and silently falls back to base64-in-localStorage, so **attachments appear to work but never reach disk**. Fix: set `self.data_root = folder_path` in `login()` (and in `init_app()` when restoring a saved folder), or replace the references with `self.folder_path`.

### Correctness

2. **CDN dependency.** `Reco.html` loads SheetJS and PapaParse from `cdnjs.cloudflare.com`. On a locked-down or offline machine both are `undefined` and every CSV/XLSX path fails. `jspreadsheet`/`jsuites` are already vendored under `lib/` — do the same for these two.
3. **`App.init()` is dead code** that still calls `AppState.load()` without `await`. Boot goes through `bootApp()`. Remove `App.init` to avoid someone wiring it back up and getting an empty-state race.
4. **Asymmetric return types.** `list_directories` returns a Python list; `list_folder_files` returns a JSON *string*. Both are consumed correctly today, but the next call site will get it wrong. Normalise one way.
5. **TCH field-name candidates are inconsistent.** `computeTotalsFor` looks for `['Txn Type','Txn Type','Type','TransactionType']` (duplicate entry) while `renderRowsTable` looks for `['TxnType','Txn Type','Type']`. A column named `TxnType` colours rows correctly but contributes nothing to the totals. Unify into one constant.
6. **TCH account codes are hardcoded.** 17036 / 85001 / 35008, RC 78061 / 50000, LOB 51 — none of it reads the Accounts Master. A chart-of-accounts change means editing the JV HTML. Consider moving these into the mapping JSON.

### Scaling

7. **`recoSessions.json` is written whole on every `AppState.save()`** — and `save()` writes all 14 keys every time. With large sessions this is a full serialise-and-rewrite per edit. The versioned CSV store was meant to carry the row data; the session JSON duplicating it is the pressure point.
8. **No write debouncing.** `AppState.save()` fires synchronously from many UI handlers.
9. **Append-only version files never compact.** A heavily edited template accumulates a long CSV with one row per change.

### Minor

10. `postMessage(..., '*')` — harmless under `file://`, but tighten if this ever moves to a server.
11. Backup format is `version: 4` and includes every master; restore accepts v2 AEG-only backups.
12. The `Masters` module, Groups, Attachments, Comments, Timeline, FilterSets, and Find&Replace are all wired but lightly exercised — expect rough edges before any of them is relied on.

---

## 8. Adding a new Special JV — checklist

1. Write `special_jv_templates/<REF>.html`. Read `window.parent._specialJvInputs` / `._specialJvDef`. Post `{type:'specialJV.complete', ref, jvId, lines, primaryKeys, inputData}` on submit **and** on cancel.
2. Write `special_jv_mapping/<REF>.json` with `ref` exactly matching the HTML stem, a `displayName`, and an `inputColumns` array listing every field the calculator needs.
3. Restart Reco (or just reopen — the registry loads at boot only).
4. The ref appears in the To Account dropdown as `⚡ <displayName> (Special JV)` and on the Home page's *Available Special JVs* card.
5. Emit lines using the AEG output column names. Balance per currency before posting — Reco does not re-validate.

---

## 9. Quick orientation for a fresh session

- **"Where does X get saved?"** → `Store.save` in Module 3, line ~1213.
- **"Why is the JV empty?"** → `inputColumns` in the mapping JSON, consumed at `Reco.openSpecialJv` (~line 9212).
- **"Why can't I click Generate?"** → `canGenerate` in `_renderPreviewModal` (~line 9200): every `jvBucket` needs a matching `jvCompleted` entry with `_fromCurrentSelection`.
- **"Where is the row data on disk?"** → `reco_data/<TemplateName>/<MMM-YY>/<DD>.csv`, collapsed by `Versioning.collapseToActive`.
- **"How do I test without the launcher?"** → open `Reco.html` directly; `Store._hasApi()` is false and everything routes to `localStorage`. Special JVs still work (same-origin iframe), but the registry will be empty because `list_folder_files` is unavailable.
