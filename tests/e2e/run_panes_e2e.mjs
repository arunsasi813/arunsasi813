/* F7 commit (a) — the Panes module and session ownership.
 *
 *     node tests/e2e/run_panes_e2e.mjs
 *
 * This commit introduces ONE indirection and nothing a user can see:
 *
 *   AppState.recoSessionsOwned   the real sessions. THE ONLY THING PERSISTED.
 *   AppState.recoSessions        the VIEW TABLE: { tplId -> the view of the
 *                                pane that owns tplId right now }
 *
 * With no split open the two maps hold the SAME objects, so all 123 existing
 * `AppState.recoSessions[id]` reads keep working with no edit at the call
 * site. The hazard that buys is that assigning a whole session into the view
 * table no longer persists it — there are six such assignments in Reco.html
 * and every one now goes through Panes.ensureSession / Panes.replaceSession.
 *
 * The gates, in the order of how much they matter:
 *
 *   T1  NOTHING CHANGED. The same scripted sitting (new template, ingest,
 *       filter, tag, offset, clear, restore) run against THIS build and
 *       against the build before it writes a byte-identical
 *       reco/recoSessions.json, once the two timestamps are normalised out.
 *       If the view table ever reached the file, or a session stopped
 *       reaching it, this fails.
 *   T2  Every key a session carries is classified DATA or VIEW. An
 *       unclassified key is per-pane by construction, which is the SILENT
 *       failure: a value typed in one pane would never reach the other pane
 *       or the shared file. Panes._makeView refuses to build a view while
 *       one exists, so v1 declines to split rather than guess.
 *   T3  Each of the six whole-session assignment sites persists what it
 *       assigned. Clear Loaded Data and Restore Session are checked against
 *       the FILE, not against memory, because a view-table-only write looks
 *       perfect in memory and loses the data on the next load.
 *   T4  A brand-new template with no entry in recoSessions.json works and
 *       persists — both doors into a template's first session (Reco.render
 *       and Reco.ingestData), whose shared anchor line matches twice and so
 *       could not be edited by text.
 *   T5  A built view (what pane 1 will get) reads and writes DATA through to
 *       the owner, keeps VIEW keys private, follows a wholesale replacement
 *       of the owner, and NEVER silently no-ops a DATA write when the owner
 *       is missing.
 *
 * COMMIT (b) ADDS sections [5]-[13]: the DOM and CSS split, the duplicate-id
 * chokepoint, capture-phase focus with F6 / Ctrl+Alt+Arrow, and the per-pane
 * scroll plumbing. Its gates:
 *
 *   T6  EXACTLY ONE element in the document carries each PANE_IDS id, after
 *       opening the split, switching focus, re-rendering each pane and
 *       closing it — and exactly one element carries `.reco-table-wrap`,
 *       which is the class 13 document-level lookups resolve verbatim.
 *   T7  A SCROLLBAR DRAG in the UNFOCUSED pane — driven by setting
 *       scrollTop, NOT by mouse.wheel, because a scrollbar drag dispatches
 *       neither pointerdown nor wheel — repaints that pane's tbody and not
 *       the other's, without moving the focus.
 *   T8  Opening a brand-new template with no entry in recoSessions.json
 *       works and persists, in the SECOND pane.
 *   T9  Excel View and Sheet mode are REFUSED while a split is open, each
 *       with a sentence saying why, and cannot be forced past the button.
 *   T10 The split is remembered per machine; restoring a stored slice
 *       cannot reach a DATA key; nothing new reaches the shared folder.
 *
 * COMMIT (c) ADDS sections [16]-[18]: the ledger-write refusals and the
 * three sanctioned sum-bar exceptions, plus the v1 contract said out loud.
 * COMMIT (d) ADDS section [19]: one live Excel link PER PANE. Its gates:
 *
 *   T11 Preview Entry with a CROSS-PANE selection refuses, and says why —
 *       and so does Mark Offset, which writes the offset master on the
 *       shared folder. Nothing is posted, nothing is stamped, and the
 *       selection survives so it can be fixed. Offset Selected is the
 *       sanctioned exception: it IS the cross-pane action.
 *   T12 One shared selection paints BOTH panes' sum bars, tolerance chips
 *       and row ticks, with no re-render (the three sanctioned exceptions).
 *   T13 Two live links on ONE template, each diffing its OWN baseline: a
 *       row edited in both workbooks surfaces as a reviewed CONFLICT rather
 *       than a silent overwrite — in either load order.
 *   T14 A link in the UNFOCUSED pane still notices a save (the dropped
 *       activeRecoId guard).
 *   T15 What v1 does not do, it says: a third pane, two periods of one
 *       reconciliation, Excel View and Sheet mode while split.
 *
 * Ports 20100-20119.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pw;
try { pw = await import('playwright'); }
catch { pw = await import('/opt/node22/lib/node_modules/playwright/index.mjs'); }
const { chromium } = pw;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const OS_USER = os.userInfo().username;
const PORT = 20101;
const PORT_BASE = 20102;
const PORT_SPLIT = 20103;
const PORT_SEL = 20104;
const PORT_XL = 20105;
/* The build T1 compares against: the commit before this one. Override with
   BASE_REV=<rev>. */
const BASE_REV = process.env.BASE_REV || '5f61d76';
/* Run the WHOLE suite against another build: APP_REV=<rev>. That is how the
   assertions here were shown to fail on the build before the change. */
const APP_REV = process.env.APP_REV || null;
if (APP_REV) console.log('APP_REV=' + APP_REV + ' — running against that build, not the working tree');

let failures = 0, passes = 0;
function check(cond, msg, extra) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 900) : '')); }
  return !!cond;
}
function note(msg, extra) {
  console.log('    · ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : ''));
}

function makeRoot(name, fromRev) {
  fromRev = fromRev || APP_REV;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-panes-'));
  const root = path.join(base, name);
  const cp = (src, dst) => {
    fs.mkdirSync(path.dirname(path.join(root, dst)), { recursive: true });
    fs.copyFileSync(path.join(REPO, src), path.join(root, dst));
  };
  if (fromRev) {
    let txt;
    try { txt = execFileSync('git', ['-C', REPO, 'show', fromRev + ':apps/Reco.html'], { maxBuffer: 64 * 1024 * 1024 }); }
    catch (e) {
      note('build ' + fromRev + ' is not available from git', String(e.message || e).slice(0, 160));
      return { root: null };
    }
    fs.mkdirSync(path.join(root, 'apps'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps/Reco.html'), txt);
  } else cp('apps/Reco.html', 'apps/Reco.html');
  for (const f of fs.readdirSync(path.join(REPO, 'apps/lib'))) cp('apps/lib/' + f, 'apps/lib/' + f);
  for (const f of ['jspreadsheet.js', 'jspreadsheet.css', 'jsuites.js', 'jsuites.css']) cp('tests/e2e/vendor/' + f, 'apps/lib/' + f);
  for (const d of ['master', 'reco', 'reco_data', 'attachments']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'master/user.csv'), `ID,Name,Email,reco\r\n${OS_USER},Test User,,1\r\n`);
  fs.writeFileSync(path.join(root, 'master/accounts_master.csv'),
    'Reference,RC,Nominal,SubNominal,AnalysisKey,LOB\r\nACC1,100,12345,0,0,51\r\nACC2,200,22222,0,0,52\r\n');
  return { root };
}

async function startBridge(root, port) {
  const proc = spawn('python3', [path.join(HERE, 'bridge_server.py'), root, String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => {
    proc.stdout.on('data', d => { if (String(d).includes('READY')) res(); });
    proc.on('exit', c => rej(new Error('bridge exited ' + c)));
  });
  const shim = await (await fetch(`http://127.0.0.1:${port}/__shim.js`)).text();
  return { proc, shim, url: `http://127.0.0.1:${port}`, port };
}

async function openReco(browser, bridge) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript(bridge.shim);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(t)) errors.push('console: ' + t);
  });
  page.on('dialog', d => d.accept());
  await page.goto(bridge.url + '/apps/Reco.html');
  await page.waitForSelector('#appMain .panel', { timeout: 20000 });
  await page.evaluate(() => {
    window.__toasts = [];
    const real = U.toast;
    U.toast = function (msg, kind) { window.__toasts.push({ msg: String(msg), kind: kind || '' }); return real.apply(U, arguments); };
  });
  return { ctx, page, errors };
}
const readToasts = page => page.evaluate(() => (window.__toasts || []).slice());
/* The same hook openReco installs. A page reload drops it, and a test that
   then reads window.__toasts reads undefined. */
const installToastHook = page => page.evaluate(() => {
  window.__toasts = [];
  const real = U.toast;
  U.toast = function (msg, kind) { window.__toasts.push({ msg: String(msg), kind: kind || '' }); return real.apply(U, arguments); };
});

/* ---------------------------------------------------------------------------
   T1's SITTING. One string, evaluated identically in both builds, that walks
   every route this commit touches: a template's FIRST session (Reco.render's
   lazy create), a second template's first session through ingestData, rows,
   a filter, a tag through applyEdits, a manual offset, a selection, Clear
   Loaded Data, and a Restore Session. Fixed ids and fixed row values so the
   two builds can only differ by the build: Playwright serialises this one
   function to the same source text for both pages.
--------------------------------------------------------------------------- */
const SITTING = async function () {
  function mkTpl(id, name) {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = id; t.name = name;
    t.columns = [
      { name: 'Doc',    label: 'Doc',    formats: [] },
      { name: 'Date',   label: 'Date',   formats: [], isDate: true },
      { name: 'Amount', label: 'Amount', formats: [], isValue: true },
      { name: 'Status', label: 'Status', formats: [] }
    ];
    t.primaryKeys = ['Doc'];
    t.valueColumn = 'Amount';
    t.docNumberColumn = 'Doc';
    t.editableColumns = ['Status'];
    t.displayColumns = ['Doc', 'Date', 'Amount', 'Status'];
    t.additionalColumns = [{ name: 'Note', type: 'custom' }];
    RecoTemplate.saveTemplate();
    return AppState.recoTemplates.find(x => x.id === id);
  }

  /* A — a brand-new template, opened for the first time. Nothing in
     recoSessions.json names it, so this is Reco.render's lazy create. */
  const tA = mkTpl('TPL_A', 'Pane A');
  RecoTemplate.open('TPL_A');
  const sA = AppState.recoSessions.TPL_A;
  sA.data = [0,1,2,3,4,5].map(i => ({
    _id: 'a' + i, _pk: 'DA' + i, _ver: 'upload',
    Doc: 'DA' + i, Date: '0' + (i + 1) + '/01/2026',
    Amount: String((i + 1) * 100), Status: i % 2 ? 'Open' : 'Cleared'
  }));
  App.navigate('reco');

  /* B — a template whose FIRST session is created by ingestData, i.e. the
     other half of the anchor line that matches twice. */
  const tB = mkTpl('TPL_B', 'Pane B');
  Reco.ingestData(tB, [
    { Doc: 'DB0', Date: '01/01/2026', Amount: '10', Status: 'Open' },
    { Doc: 'DB1', Date: '02/01/2026', Amount: '20', Status: 'Open' }
  ], ['Doc', 'Date', 'Amount', 'Status']);
  /* ingestData appends the upload to the day file in the background and
     stamps sess.activeVersionFile from the .then. Waiting for it is what
     makes the file this sitting writes deterministic; without it the stamp
     lands before or after the flush depending on disk speed, and T1 fails
     about one run in four. */
  for (let i = 0; i < 120 && !AppState.recoSessions.TPL_B.activeVersionFile; i++) {
    await new Promise(r => setTimeout(r, 25));
  }

  /* VIEW state and DATA state on A, through the ordinary routes. */
  AppState.activeRecoId = 'TPL_A';
  App.navigate('reco');
  const a = AppState.recoSessions.TPL_A;
  a.statusFilter = 'all';
  a.columnFilters = { Status: [{ op: 'eq', val: 'Open', enabled: true }] };
  a.page = 1; a.pageSize = 50; a.zoom = 1.25;
  a.columnWidths = { Doc: 140 };
  a.hiddenCols = ['Date'];
  a.selectedRows = { a0: true, a2: true };
  Reco.applyEdits(tA, a, [{ row: a.data[0], col: 'Note', value: 'typed' }],
                  { source: 'grid', trusted: true });
  a.offsets['a1'] = { amount: 100, by: 'test', at: 'FIXED' };

  /* C — a third template, cleared, so the CLEARED session is what must be on
     disk. clearedAt is a timestamp and is normalised out by the caller. */
  const tC = mkTpl('TPL_C', 'Pane C');
  RecoTemplate.open('TPL_C');
  AppState.recoSessions.TPL_C.data = [{ _id: 'c0', _pk: 'DC0', _ver: 'upload', Doc: 'DC0', Amount: '9' }];
  AppState.activeRecoId = 'TPL_C';
  Reco.clearSession();

  /* D — a fourth template, replaced by a Restore Session. */
  const tD = mkTpl('TPL_D', 'Pane D');
  RecoTemplate.open('TPL_D');
  AppState.recoSessions.TPL_D.data = [{ _id: 'd0', _pk: 'DD0', _ver: 'upload', Doc: 'DD0', Amount: '1' }];
  AppState.activeRecoId = 'TPL_D';
  const backup = JSON.parse(JSON.stringify(AppState.recoSessions.TPL_D));
  backup.data = [
    { _id: 'd9', _pk: 'DD9', _ver: 'upload', Doc: 'DD9', Amount: '77' },
    { _id: 'd8', _pk: 'DD8', _ver: 'upload', Doc: 'DD8', Amount: '88' }
  ];
  backup.page = 3;
  const payload = JSON.stringify({ session: backup, exportedAt: 'FIXED' });
  const file = new File([payload], 'backup.json', { type: 'application/json' });
  const realConfirm = window.confirm;
  window.confirm = () => true;
  try {
    Reco.restoreSession({ target: { files: [file], value: 'x' } });
    for (let i = 0; i < 60 && (AppState.recoSessions.TPL_D.data || []).length !== 2; i++) {
      await new Promise(r => setTimeout(r, 25));
    }
  } finally { window.confirm = realConfirm; }

  await AppState.flush();
  return {
    templates: AppState.recoTemplates.map(t => t.id),
    rowsA: (AppState.recoSessions.TPL_A.data || []).length,
    rowsB: (AppState.recoSessions.TPL_B.data || []).length,
    rowsC: (AppState.recoSessions.TPL_C.data || []).length,
    rowsD: (AppState.recoSessions.TPL_D.data || []).length,
    verB: !!AppState.recoSessions.TPL_B.activeVersionFile
  };
};

/* loadedAt / clearedAt are wall-clock, activeVersionFile carries today's
   date, and the _id of an ingested row is U.uid(). Their PRESENCE is still
   compared; only the value is normalised. Everything else must match to the
   byte. */
function normalise(txt) {
  const d = JSON.parse(txt);
  Object.keys(d).sort().forEach(k => {
    const s = d[k];
    if (!s || typeof s !== 'object') return;
    if (s.loadedAt) s.loadedAt = 'FIXED';
    if (s.clearedAt) s.clearedAt = 'FIXED';
    if (s.activeVersionFile) s.activeVersionFile = 'FIXED';
    (s.data || []).forEach(r => { if (r && !/^[a-d][0-9]+$/.test(String(r._id))) r._id = 'MINTED'; });
    if (s.manualTags) {
      const out = {};
      Object.keys(s.manualTags).sort().forEach(tk => { out[tk.replace(/^[^|]+\|\|/, m => /^[a-d]\d/.test(m) ? m : 'MINTED||')] = s.manualTags[tk]; });
      s.manualTags = out;
    }
  });
  const sorted = {};
  Object.keys(d).sort().forEach(k => { sorted[k] = d[k]; });
  return JSON.stringify(sorted, null, 1);
}

const watchdog = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15 * 60 * 1000);
const procs = [];
const browser = await chromium.launch();

try {
  /* ====================================================================
     [1] T2 — the classification audit.
     ==================================================================== */
  console.log('\n[1] every key a session carries is classified DATA or VIEW');
  const A = makeRoot('now');
  const bridgeA = await startBridge(A.root, PORT); procs.push(bridgeA.proc);
  const { page, errors } = await openReco(browser, bridgeA);

  const audit = await page.evaluate(() => Panes.auditKeys());
  check(audit.ok, 'Panes.auditKeys(): no unclassified key, no name on two lists', audit);
  check(audit.unclassified.length === 0,
    'nothing on a fresh session is in neither DATA_KEYS nor VIEW_KEYS', audit.unclassified);
  check(audit.dupes.length === 0, 'no key is both DATA and VIEW', audit.dupes);
  const lists = await page.evaluate(() => ({
    data: Panes.DATA_KEYS, view: Panes.VIEW_KEYS, pending: Panes.VIEW_KEYS_PENDING
  }));
  note('DATA (' + lists.data.length + ')', lists.data);
  note('VIEW (' + lists.view.length + ')', lists.view);
  note('VIEW, still globals on AppState', lists.pending);
  check(lists.data.indexOf('manualTags') >= 0,
    'manualTags is DATA — a value typed in one pane is a value in both, and applyEdits is its one write path');
  check(lists.data.indexOf('selectedRows') >= 0,
    'selectedRows is DATA — the shared selection IS the feature ("tick these off against those")');
  check(lists.data.indexOf('columnOrder') >= 0,
    'columnOrder is DATA — it is the legacy TEAM order off the shared folder, and per-pane it would default to null in the second pane');
  check(lists.view.indexOf('hiddenCols') >= 0 && lists.view.indexOf('page') >= 0 && lists.view.indexOf('slicers') >= 0,
    'hiddenCols / page / slicers are VIEW — independent filtering is the ask');

  /* A view cannot be built while a key is unclassified: that default is the
     silent one, so it must refuse rather than guess. */
  const refuse = await page.evaluate(() => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_UN'; t.name = 'Unclassified';
    t.columns = [{ name: 'Doc', label: 'Doc', formats: [] }];
    t.primaryKeys = ['Doc']; t.displayColumns = ['Doc'];
    RecoTemplate.saveTemplate();
    Panes.ensureSession('TPL_UN');
    const ok = !!Panes._makeView('TPL_UN');
    AppState.recoSessionsOwned.TPL_UN.somethingNobodyClassified = { typed: 'value' };
    let msg = '';
    try { Panes._makeView('TPL_UN'); } catch (e) { msg = String(e.message || e); }
    delete AppState.recoSessionsOwned.TPL_UN.somethingNobodyClassified;
    Panes.dropSession('TPL_UN');
    AppState.recoTemplates = AppState.recoTemplates.filter(x => x.id !== 'TPL_UN');
    return { ok, msg };
  });
  check(refuse.ok, 'the premise: a view builds fine while every key is classified');
  check(/somethingNobodyClassified/.test(refuse.msg) && /DATA_KEYS/.test(refuse.msg),
    'Panes._makeView REFUSES to build a view over an unclassified key, and names it', refuse.msg);

  /* ====================================================================
     [2] T5 — the view object: pane 1's half of the model.
     ==================================================================== */
  console.log('\n[2] a built view reads and writes DATA through to the owner');
  const v = await page.evaluate(() => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_V'; t.name = 'View';
    t.columns = [{ name: 'Doc', label: 'Doc', formats: [] }, { name: 'Amount', label: 'Amount', formats: [], isValue: true }];
    t.primaryKeys = ['Doc']; t.valueColumn = 'Amount'; t.displayColumns = ['Doc', 'Amount'];
    RecoTemplate.saveTemplate();
    Panes.ensureSession('TPL_V');
    const o = AppState.recoSessionsOwned.TPL_V;
    const view = Panes._makeView('TPL_V');
    const out = { looksLikeASession: true };
    o.data = [{ _id: 'v1', _pk: 'V1', Doc: 'V1', Amount: '5' }];
    out.readsThrough = view.data.length === 1 && view.data[0].Doc === 'V1';
    view.manualTags = { 'v1||Note': 'typed on the right' };
    out.writesThrough = o.manualTags['v1||Note'] === 'typed on the right';
    view.selectedRows.v1 = true;
    out.selectionIsShared = o.selectedRows.v1 === true;
    view.page = 7; view.statusFilter = 'open'; view.hiddenCols = ['Amount']; view.zoom = 1.5;
    out.viewIsPrivate = o.page !== 7 && o.statusFilter !== 'open'
                     && (o.hiddenCols || []).length === 0 && o.zoom !== 1.5;
    /* viewFor is the comparison _xlLive will make once Excel View is per pane. */
    out.viewForUnownedIsNull = Panes.viewFor('p1', 'TPL_V') === null;
    /* The owner is REPLACED wholesale by Clear and by Restore, so a view must
       never capture it. */
    const fresh = Reco.makeSession();
    fresh.data = [{ _id: 'v9', _pk: 'V9', Doc: 'V9' }];
    Panes.replaceSession('TPL_V', fresh);
    out.followsReplacement = view.data.length === 1 && view.data[0].Doc === 'V9';
    /* And with no owner at all, a DATA write must not be a silent no-op. */
    delete AppState.recoSessionsOwned.TPL_V;
    let threw = false;
    try { view.offsets = { z: true }; } catch (e) { threw = true; }
    out.revived = !!AppState.recoSessionsOwned.TPL_V;
    out.noSilentNoOp = threw || (out.revived && AppState.recoSessionsOwned.TPL_V.offsets.z === true);
    Panes.dropSession('TPL_V');
    AppState.recoTemplates = AppState.recoTemplates.filter(x => x.id !== 'TPL_V');
    return out;
  });
  check(v.readsThrough, 'a view READS a DATA key through to the owner');
  check(v.writesThrough, 'a view WRITES a DATA key through to the owner — a tag typed on the right is on the left');
  check(v.selectionIsShared, 'the selection is shared between the panes');
  check(v.viewIsPrivate, 'page / statusFilter / hiddenCols / zoom written on the view do NOT reach the owner', v);
  check(v.viewForUnownedIsNull, 'Panes.viewFor returns null for a pane that is not showing that template');
  check(v.followsReplacement, 'a view follows a wholesale replacement of the owner — it holds no captured reference', v);
  check(v.noSilentNoOp,
    'a DATA write with the owner missing throws or creates-and-retries; a silent no-op is impossible', v);

  /* ====================================================================
     [3] T3/T4 — the six assignment sites, checked against the FILE.
     ==================================================================== */
  console.log('\n[3] the six whole-session assignment sites persist what they assigned');
  const sit = await page.evaluate(SITTING);
  note('sitting', sit);
  check(sit.rowsA === 6 && sit.rowsB === 2 && sit.rowsC === 0 && sit.rowsD === 2 && sit.verB,
    'the premise: the sitting did what it meant to in memory', sit);

  const file1 = path.join(A.root, 'reco/recoSessions.json');
  /* Snapshotted HERE, before the backup-import test below narrows the owned
     map: T1 compares the file the sitting wrote, not the file left at the end
     of the run. */
  const afterSitting = fs.readFileSync(file1, 'utf8');
  const disk = JSON.parse(afterSitting);
  check(!!disk.TPL_A && disk.TPL_A.data.length === 6,
    'site 3 — a brand-new template opened for the first time (Reco.render) is on the share', Object.keys(disk));
  check(!!disk.TPL_B && disk.TPL_B.data.length === 2,
    'site 4 — a template whose first session came from ingestData is on the share');
  check(!!disk.TPL_C && disk.TPL_C.data.length === 0 && !!disk.TPL_C.clearedAt,
    'site 6 — Clear Loaded Data: the CLEARED session is what reached the file', disk.TPL_C && disk.TPL_C.clearedAt);
  check(!!disk.TPL_D && disk.TPL_D.data.length === 2 && disk.TPL_D.data[0].Doc === 'DD9',
    'site 5 — Restore Session: the RESTORED session is what reached the file',
    disk.TPL_D && disk.TPL_D.data.map(r => r.Doc));
  check(disk.TPL_A.manualTags && Object.keys(disk.TPL_A.manualTags).length === 1,
    'DATA written through applyEdits is on the share', disk.TPL_A.manualTags);

  const maps = await page.evaluate(() => ({
    drift: Panes.keySetDrift(),
    identical: Object.keys(AppState.recoSessionsOwned)
      .every(k => AppState.recoSessions[k] === AppState.recoSessionsOwned[k]),
    split: Panes.isSplit(), panes: Panes.count(), owner: Panes.owner().key,
    ownerTpl: Panes.owner().tplId, ctx: !!Panes.ctx()
  }));
  check(maps.drift.ownedOnly.length === 0 && maps.drift.viewOnly.length === 0,
    'the view table and the owned map agree on key set', maps.drift);
  check(maps.identical,
    'WITH NO SPLIT THE TWO MAPS HOLD THE SAME OBJECTS — every existing AppState.recoSessions[id] read is unchanged');
  check(!maps.split && maps.panes === 1 && maps.owner === 'p0',
    'one pane, and it owns the screen', maps);
  check(maps.ownerTpl === 'TPL_D' && maps.ctx,
    'slot 0 tracks AppState.activeRecoId, and Panes.ctx() resolves it', maps);

  /* ====================================================================
     [3b] THE ONE THING ONLY THIS COMMIT CAN GET WRONG, and the only test
     that can catch it: when a NON-slot-0 pane owns a template, the view
     table holds a VIEW object, and the shared folder must still receive the
     OWNER. Serialising the view table instead would publish that pane's
     private page / filters / zoom to the whole team — and with no split open
     the two maps hold the same objects, so nothing else in this suite can
     tell the two apart. There is no DOM split until commit (b), so the pane
     record is fabricated here: the ownership model is what is under test.
     ==================================================================== */
  console.log('\n[3b] with a second pane owning a template, the OWNER is what reaches the share');
  const p1 = await page.evaluate(async () => {
    const out = {};
    const panes = Panes.panes();
    panes.push({ key: 'p1', tplId: 'TPL_A', view: null, root: null });
    Panes.ensureSession('TPL_A');
    const pane1 = Panes.byKey('p1');
    Panes.install(pane1);
    out.split = Panes.isSplit();
    out.viewTableIsTheView = AppState.recoSessions.TPL_A === pane1.view
                          && pane1.view !== AppState.recoSessionsOwned.TPL_A;
    out.viewForMatches = Panes.viewFor('p1', 'TPL_A') === AppState.recoSessions.TPL_A;
    out.ctxPaneKey = (Panes.ctx('p1') || {}).paneKey;
    out.ownerPageBefore = AppState.recoSessionsOwned.TPL_A.page;
    /* a private VIEW change in pane 1, and a shared DATA change through it */
    const sess = AppState.recoSessions.TPL_A;
    sess.page = 99; sess.zoom = 1.9; sess.hiddenCols = ['Doc', 'Amount', 'Status'];
    sess.statusFilter = 'pane-one-only';
    sess.manualTags = Object.assign({}, sess.manualTags, { 'a3||Note': 'typed in pane 1' });
    out.dataReachedOwner = AppState.recoSessionsOwned.TPL_A.manualTags['a3||Note'] === 'typed in pane 1';
    out.viewStayedPrivate = AppState.recoSessionsOwned.TPL_A.page !== 99
                         && AppState.recoSessionsOwned.TPL_A.statusFilter !== 'pane-one-only';
    out.drift = Panes.keySetDrift();
    await AppState.flush();
    /* put the fixture back: one pane, slot 0, owning what it owned */
    Panes.install(panes[0]);
    panes.length = 1;
    Panes.syncViewTable();
    out.backToOnePane = !Panes.isSplit()
                     && AppState.recoSessions.TPL_A === AppState.recoSessionsOwned.TPL_A;
    return out;
  });
  check(p1.split && p1.viewTableIsTheView,
    'the premise: pane 1 owns TPL_A, so the view table holds a VIEW object, not the session', p1);
  check(p1.viewForMatches && p1.ctxPaneKey === 'p1',
    'Panes.viewFor / Panes.ctx resolve that pane', p1);
  check(p1.dataReachedOwner, 'a DATA key typed in pane 1 reaches the owner', p1);
  check(p1.viewStayedPrivate, 'pane 1\'s page / statusFilter stay on pane 1', p1);
  check(p1.drift.ownedOnly.length === 0 && p1.drift.viewOnly.length === 0,
    'no key-set drift with a split open', p1.drift);
  const diskP1 = JSON.parse(fs.readFileSync(file1, 'utf8'));
  check(diskP1.TPL_A.manualTags['a3||Note'] === 'typed in pane 1',
    'the DATA typed in pane 1 is on the share');
  check(diskP1.TPL_A.page === p1.ownerPageBefore
     && diskP1.TPL_A.statusFilter !== 'pane-one-only'
     && (diskP1.TPL_A.hiddenCols || []).length === 1
     && diskP1.TPL_A.zoom !== 1.9,
    'PANE 1\'S PRIVATE VIEW STATE DID NOT REACH THE SHARED FOLDER — the file holds the owner, not the view table',
    { page: diskP1.TPL_A.page, statusFilter: diskP1.TPL_A.statusFilter,
      hiddenCols: diskP1.TPL_A.hiddenCols, zoom: diskP1.TPL_A.zoom });
  check(Object.keys(diskP1.TPL_A).every(k => Object.getOwnPropertyDescriptor(diskP1.TPL_A, k).value !== undefined),
    'the file is a plain session, with no accessor-shaped leftovers from a view');
  check(p1.backToOnePane, 'the fixture is back to one pane', p1);

  /* Backup round-trip: export reads the OWNED map, import replaces it and
     rebuilds the view table. */
  const bk = await page.evaluate(async () => {
    const out = {};
    window.__dl = null;
    const realDl = U.download;
    U.download = (name, text) => { window.__dl = { name, text }; };
    try { App.exportBackup(); } finally { U.download = realDl; }
    const d = JSON.parse(window.__dl.text);
    out.exportHasSessions = Object.keys(d.recoSessions || {}).sort().join(',');
    out.exportRowsA = (d.recoSessions.TPL_A.data || []).length;
    d.recoSessions = { TPL_A: d.recoSessions.TPL_A };          // a narrower backup
    const realConfirm = window.confirm; window.confirm = () => true;
    try {
      App.importBackup({ target: { files: [new File([JSON.stringify(d)], 'b.json')], value: 'x' } });
      for (let i = 0; i < 60 && AppState.recoSessionsOwned.TPL_B; i++) await new Promise(r => setTimeout(r, 25));
    } finally { window.confirm = realConfirm; }
    out.ownedAfter = Object.keys(AppState.recoSessionsOwned).sort().join(',');
    out.viewAfter = Object.keys(AppState.recoSessions).sort().join(',');
    out.drift = Panes.keySetDrift();
    return out;
  });
  check(bk.exportHasSessions === 'TPL_A,TPL_B,TPL_C,TPL_D' && bk.exportRowsA === 6,
    'site 1 — exportBackup writes the real sessions, not the view table', bk);
  check(bk.ownedAfter === 'TPL_A' && bk.viewAfter === 'TPL_A',
    'site 2 — importBackup replaces the owned map and REBUILDS the view table from it', bk);
  check(bk.drift.ownedOnly.length === 0 && bk.drift.viewOnly.length === 0,
    'no key-set drift after a backup import', bk.drift);

  /* The dev assertion that catches a seventh assignment site. */
  const dev = await page.evaluate(async () => {
    const seen = [];
    const real = console.error;
    console.error = function () { seen.push(Array.from(arguments).join(' ')); };
    try {
      AppState.recoSessions.GHOST = { data: [] };       // a stray view-table insert
      await AppState.flush();
    } finally { delete AppState.recoSessions.GHOST; console.error = real; }
    return seen.filter(s => /recoSessionsOwned/.test(s));
  });
  check(dev.length === 1 && /GHOST/.test(dev[0]),
    'AppState.flush reports a view table that has drifted from the saved map, and names the id', dev);

  const toasts = await readToasts(page);
  check(!toasts.some(t => t.kind === 'error'), 'no error toast in the whole run',
    toasts.filter(t => t.kind === 'error').slice(0, 4));
  const expected = /no session owned template TPL_V on write of sess\.offsets/;
  check(errors.filter(e => !expected.test(e)).length === 0,
    'no page or console errors beyond the one the revive test provoked', errors.slice(0, 5));

  /* ====================================================================
     [4] T1 — NOTHING CHANGED: the same sitting against the build before.
     ==================================================================== */
  console.log('\n[4] the same sitting on the build before this one writes the same file');
  const B = makeRoot('base', BASE_REV);
  if (!B.root) {
    note('skipped: ' + BASE_REV + ' is not available');
  } else {
    const bridgeB = await startBridge(B.root, PORT_BASE); procs.push(bridgeB.proc);
    const rB = await openReco(browser, bridgeB);
    const sitB = await rB.page.evaluate(SITTING);
    check(JSON.stringify(sitB) === JSON.stringify(sit),
      'the sitting behaves identically in memory on both builds', { base: sitB, now: sit });
    const file2 = path.join(B.root, 'reco/recoSessions.json');
    const nowTxt = normalise(afterSitting);
    const baseTxt = normalise(fs.readFileSync(file2, 'utf8'));
    if (!check(nowTxt === baseTxt,
      'reco/recoSessions.json IS BYTE-IDENTICAL to what the build before this one wrote')) {
      const a = nowTxt.split('\n'), b = baseTxt.split('\n');
      for (let i = 0, shown = 0; i < Math.max(a.length, b.length) && shown < 12; i++) {
        if (a[i] !== b[i]) { note('line ' + i + ' now : ' + String(a[i]).slice(0, 160)); note('line ' + i + ' base: ' + String(b[i]).slice(0, 160)); shown++; }
      }
      note('lengths', { now: nowTxt.length, base: baseTxt.length });
    }
    check(rB.errors.length === 0, 'the baseline build logged no errors either', rB.errors.slice(0, 3));
  }

  /* ====================================================================
     COMMIT (b) — THE DOM AND CSS SPLIT, THE ID CHOKEPOINT, CAPTURE-PHASE
     FOCUS AND THE PER-PANE SCROLL PLUMBING.

     A fresh root and a fresh page: the sections above deliberately leave
     four templates and a narrowed backup behind, and these tests are about
     what is on screen.
     ==================================================================== */
  console.log('\n[5] the split opens, and exactly one element carries each PANE_IDS id');
  const C = makeRoot('split');
  const bridgeC = await startBridge(C.root, PORT_SPLIT); procs.push(bridgeC.proc);
  const pc = await openReco(browser, bridgeC);
  const page2 = pc.page;

  /* 3,000 rows, one page, so the virtual window is well inside the list and
     a scroll has somewhere to go. */
  await page2.evaluate(async () => {
    function mk(id, name) {
      RecoTemplate.create();
      const t = RecoTemplate._editing;
      t.id = id; t.name = name;
      t.columns = [
        { name: 'Doc', label: 'Doc', formats: [] },
        { name: 'Amount', label: 'Amount', formats: [], isValue: true },
        { name: 'Status', label: 'Status', formats: [] }
      ];
      t.primaryKeys = ['Doc']; t.valueColumn = 'Amount'; t.docNumberColumn = 'Doc';
      t.editableColumns = ['Status'];
      t.displayColumns = ['Doc', 'Amount', 'Status'];
      t.additionalColumns = [{ name: 'Note', type: 'custom' }];
      RecoTemplate.saveTemplate();
      return AppState.recoTemplates.find(x => x.id === id);
    }
    mk('TPL_S', 'Split me');
    RecoTemplate.open('TPL_S');
    const s = AppState.recoSessions.TPL_S;
    s.data = Array.from({ length: 3000 }, (_, i) => ({
      _id: 'r' + i, _pk: 'D' + i, _ver: 'upload',
      Doc: 'D' + i, Amount: String(i + 1), Status: (i % 2) ? 'Open' : 'Cleared'
    }));
    s.pageSize = Reco.PAGE_ALL;
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 150));
  });

  const dom = {};
  const snap = () => page2.evaluate(() => ({
    panes: Panes.count(),
    roots: document.querySelectorAll('.reco-pane').length,
    shells: document.querySelectorAll('.reco-shell').length,
    wraps: document.querySelectorAll('.reco-table-wrap').length,
    parked: document.querySelectorAll('.reco-table-wrap-parked').length,
    splits: document.querySelectorAll('.reco-split').length,
    owner: Panes.owner().key,
    audit: Panes.idAudit(),
    classes: [...document.querySelectorAll('.reco-pane')].map(p => p.className),
    chips: [...document.querySelectorAll('[data-pane-chip]')].map(c => c.textContent)
  }));

  dom.one = await snap();
  check(dom.one.panes === 1 && dom.one.shells === 1 && dom.one.wraps === 1 && dom.one.audit.ok,
    'before: one pane, one shell, one grid wrapper, no duplicate id', dom.one);

  const opened = await page2.evaluate(async () => {
    const ok = Panes.openSplit();
    await new Promise(r => setTimeout(r, 250));
    return ok;
  });
  dom.open = await snap();
  check(opened === true, 'Panes.openSplit() opened the second pane');
  check(dom.open.panes === 2 && dom.open.roots === 2 && dom.open.shells === 2 && dom.open.splits === 1,
    'two pane roots, two shells, one split container', dom.open);
  check(dom.open.wraps === 1 && dom.open.parked === 1,
    'EXACTLY ONE element carries .reco-table-wrap — the other is parked, which is what keeps the 13 verbatim document.querySelector(\'.reco-table-wrap\') lookups meaning "the pane I am acting on"', dom.open);
  check(dom.open.audit.ok && dom.open.audit.missing.length === 0,
    'OPENED: exactly one element carries each PANE_IDS id', dom.open.audit);
  check(dom.open.classes.join('|') === 'reco-pane owner|reco-pane'
     && dom.open.chips.join('|') === '● Active|○',
    'the owner pane is the one with the border and the ● Active chip', dom.open);

  /* Focus switch — by the key binding, which is the only route a keyboard
     user and a scrollbar-dragging user have. */
  await page2.keyboard.press('F6');
  dom.f6 = await snap();
  check(dom.f6.owner === 'p1' && dom.f6.audit.ok && dom.f6.wraps === 1 && dom.f6.parked === 1,
    'FOCUS SWITCHED (F6): ownership and every id moved with it, still exactly one of each', dom.f6);
  check(dom.f6.chips.join('|') === '○|● Active', 'the chip followed the focus', dom.f6.chips);
  await page2.keyboard.press('Control+Alt+ArrowLeft');
  dom.ctrlLeft = await snap();
  check(dom.ctrlLeft.owner === 'p0' && dom.ctrlLeft.audit.ok,
    'Ctrl+Alt+Left focuses the left pane', dom.ctrlLeft);
  await page2.keyboard.press('Control+Alt+ArrowRight');
  check((await page2.evaluate(() => Panes.owner().key)) === 'p1', 'Ctrl+Alt+Right focuses the right pane');
  await page2.keyboard.press('Control+Alt+ArrowLeft');

  /* Re-render each pane, which is what every one of the 68
     App.navigate('reco') sites does. */
  dom.rerender = await page2.evaluate(async () => {
    const out = [];
    for (const key of ['p0', 'p1', 'p0']) {
      Panes.renderPane(Panes.byKey(key));
      await new Promise(r => setTimeout(r, 60));
      out.push({ after: key, owner: Panes.owner().key, audit: Panes.idAudit(),
                 wraps: document.querySelectorAll('.reco-table-wrap').length });
    }
    return out;
  });
  check(dom.rerender.every(s => s.audit.ok && s.wraps === 1),
    'RE-RENDERED each pane: still exactly one of each id, and the parked class survived', dom.rerender);
  check(dom.rerender.every(s => s.owner === 'p0'),
    'rendering the NON-focused pane hands ownership straight back (withOwner)', dom.rerender.map(s => s.owner));

  /* ====================================================================
     [6] THE GATE: a SCROLLBAR DRAG in the UNFOCUSED pane — driven by
     setting scrollTop, not by mouse.wheel, because a scrollbar drag
     dispatches neither pointerdown nor wheel and a wheel-only test passes
     while the scrollbar path ships broken.
     ==================================================================== */
  console.log('\n[6] a scrollbar drag in the UNFOCUSED pane repaints THAT pane and no other');
  const scrollOne = async (slot, px) => page2.evaluate(async (a) => {
    const roots = [...document.querySelectorAll('.reco-pane')];
    const rid = r => { const tr = r.querySelectorAll('tbody tr[data-rid]'); return { first: tr[0] && tr[0].dataset.rid, last: tr[tr.length - 1] && tr[tr.length - 1].dataset.rid, n: tr.length }; };
    const before = roots.map(rid);
    const w = roots[a.slot].querySelector('.reco-table-wrap, .reco-table-wrap-parked');
    w.scrollTop = a.px;                       // a scrollbar drag, not a wheel
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise(r => setTimeout(r, 120));
    return { before, after: roots.map(rid), owner: Panes.owner().key, activeRecoId: AppState.activeRecoId };
  }, { slot, px });

  const sc1 = await scrollOne(1, 20000);
  check(sc1.owner === 'p0', 'the focus did NOT move — a scrollbar drag must not have to move it', sc1);
  check(sc1.after[1].first !== sc1.before[1].first && sc1.after[1].n > 0,
    'the SCROLLED (unfocused) pane\'s tbody moved to its new window', { before: sc1.before[1], after: sc1.after[1] });
  check(sc1.after[0].first === sc1.before[0].first && sc1.after[0].last === sc1.before[0].last,
    'THE OTHER PANE\'S TBODY DID NOT CHANGE — before this commit _refreshVirtBody found its tbody with a document-level query and repainted the left pane with the right pane\'s rows',
    { before: sc1.before[0], after: sc1.after[0] });

  /* and the same the other way round, with the right pane focused */
  await page2.keyboard.press('F6');
  const sc2 = await scrollOne(0, 40000);
  check(sc2.owner === 'p1' && sc2.after[0].first !== sc2.before[0].first
     && sc2.after[1].first === sc2.before[1].first,
    'the same in reverse: scrolling the unfocused LEFT pane leaves the focused right pane alone', sc2);
  await page2.keyboard.press('F6');

  /* ====================================================================
     [7] INDEPENDENT VIEW STATE — the feature itself.
     ==================================================================== */
  console.log('\n[7] each pane filters, pages, hides and zooms on its own');
  const indep = await page2.evaluate(async () => {
    const out = {};
    const tpl = AppState.recoTemplates.find(t => t.id === 'TPL_S');
    const v0 = Panes.viewFor('p0', 'TPL_S'), v1 = Panes.viewFor('p1', 'TPL_S');
    v0.columnFilters = { Status: [{ op: 'equals', val: 'Open', enabled: true }] };
    v1.columnFilters = { Status: [{ op: 'equals', val: 'Cleared', enabled: true }] };
    v0.pageSize = 50; v1.pageSize = 200;
    v0.page = 0; v1.page = 2;
    v0.hiddenCols = ['Amount']; v1.hiddenCols = [];
    v0.zoom = 1.3; v1.zoom = 0.8;
    v0._virtRowHeight = null; v1._virtRowHeight = null;
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 300));
    out.counts = [Reco.applyTableFiltersSort(tpl, v0).length, Reco.applyTableFiltersSort(tpl, v1).length];
    out.cols = [Reco.effectiveDisplayCols(tpl, v0), Reco.effectiveDisplayCols(tpl, v1)];
    const roots = [...document.querySelectorAll('.reco-pane')];
    out.zooms = roots.map(r => (r.querySelector('.reco-table-wrap, .reco-table-wrap-parked') || {}).style.zoom);
    out.rowHeights = [v0._virtRowHeight, v1._virtRowHeight];
    out.firstRows = roots.map(r => { const tr = r.querySelector('tbody tr[data-rid]'); return tr ? tr.dataset.rid : null; });
    /* every rendered row in each pane belongs to THAT pane's filter */
    out.wrongSide = roots.map((r, i) => {
      const want = i === 0 ? 'Open' : 'Cleared';
      const data = AppState.recoSessionsOwned.TPL_S.data;
      const byId = new Map(data.map(x => [x._id, x]));
      return [...r.querySelectorAll('tbody tr[data-rid]')].filter(tr => (byId.get(tr.dataset.rid) || {}).Status !== want).length;
    });
    out.audit = Panes.idAudit();
    return out;
  });
  check(indep.counts[0] === 1500 && indep.counts[1] === 1500,
    'each pane\'s filter is applied to its own view', indep.counts);
  check(indep.wrongSide[0] === 0 && indep.wrongSide[1] === 0,
    'EVERY ROW RENDERED IN A PANE BELONGS TO THAT PANE\'S FILTER — read per pane root, not globally', indep);
  check(indep.cols[0].indexOf('Amount') < 0 && indep.cols[1].indexOf('Amount') >= 0,
    'a column hidden in the left pane is still shown in the right one', indep.cols);
  check(indep.zooms[0] === '1.3' && indep.zooms[1] === '0.8',
    'each pane carries its own zoom — the fixups wrapper is what keeps a render of one from zooming the other', indep.zooms);
  check(indep.rowHeights[0] > 0 && indep.rowHeights[1] > 0 && indep.rowHeights[0] !== indep.rowHeights[1],
    '_virtRowHeight is measured per VIEW, because two panes may be at different zooms', indep.rowHeights);
  check(indep.firstRows[0] !== indep.firstRows[1], 'the two panes are showing different rows', indep.firstRows);
  check(indep.audit.ok, 'still exactly one of each id after an independent repaint', indep.audit);

  /* PageDown acts on the focused pane only. */
  const paged = await page2.evaluate(() => ({ p0: Panes.viewFor('p0', 'TPL_S').page, p1: Panes.viewFor('p1', 'TPL_S').page }));
  await page2.keyboard.press('PageDown');
  await page2.waitForTimeout(150);
  const paged2 = await page2.evaluate(() => ({ p0: Panes.viewFor('p0', 'TPL_S').page, p1: Panes.viewFor('p1', 'TPL_S').page, owner: Panes.owner().key }));
  check(paged2.owner === 'p0' && paged2.p0 === paged.p0 + 1 && paged2.p1 === paged.p1,
    'PageDown turns the FOCUSED pane\'s page and leaves the other one where it was', { before: paged, after: paged2 });
  await page2.keyboard.press('F6');
  await page2.keyboard.press('PageDown');
  await page2.waitForTimeout(150);
  const paged3 = await page2.evaluate(() => ({ p0: Panes.viewFor('p0', 'TPL_S').page, p1: Panes.viewFor('p1', 'TPL_S').page, owner: Panes.owner().key }));
  check(paged3.owner === 'p1' && paged3.p1 === paged2.p1 + 1 && paged3.p0 === paged2.p0,
    'after a keyboard focus switch it turns the OTHER pane\'s page', { before: paged2, after: paged3 });

  /* ====================================================================
     [8] CAPTURE-PHASE POINTERDOWN — a real click in the unfocused pane.
     ==================================================================== */
  console.log('\n[8] a click in the unfocused pane acts on THAT pane');
  await page2.evaluate(() => { Panes.focusSlot(0); });
  const target = await page2.evaluate(() => {
    const tr = document.querySelector('.reco-pane[data-pane="1"] tbody tr[data-rid]');
    return tr ? tr.dataset.rid : null;
  });
  check(!!target, 'the right pane has a row to click', target);
  await page2.click('.reco-pane[data-pane="1"] tbody tr[data-rid="' + target + '"] td:nth-child(2)');
  await page2.waitForTimeout(120);
  const clicked = await page2.evaluate((rid) => ({
    owner: Panes.owner().key,
    activeRecoId: AppState.activeRecoId,
    selected: !!(AppState.recoSessionsOwned.TPL_S.selectedRows || {})[rid],
    ownerPaneTickIsOn: !!(document.querySelector('.reco-pane[data-pane="1"] tbody tr[data-rid="' + rid + '"]') || {}).classList?.contains('selected'),
    audit: Panes.idAudit()
  }), target);
  check(clicked.owner === 'p1',
    'THE CAPTURE-PHASE POINTERDOWN MOVED OWNERSHIP BEFORE THE ROW\'S OWN HANDLER RAN — this is what lets every emitted inline handler resolve through AppState.activeRecoId unchanged', clicked);
  check(clicked.selected, 'the row it ticked is the row that was clicked', clicked);
  check(clicked.audit.ok, 'no duplicate id after a click-driven focus change', clicked.audit);

  /* ====================================================================
     [9] SHARED DATA, PRIVATE VIEW — through the DOM this time.
     ==================================================================== */
  console.log('\n[9] an edit in one pane is an edit in both; the view state is not');
  const shared = await page2.evaluate(async () => {
    const out = {};
    const tpl = AppState.recoTemplates.find(t => t.id === 'TPL_S');
    /* both panes on the same rows, so the DOM can be compared row for row */
    ['p0', 'p1'].forEach(k => {
      const v = Panes.viewFor(k, 'TPL_S');
      v.columnFilters = {}; v.slicers = {}; v.columnSorts = null;
      v.statusFilter = 'all'; v.page = 0; v.pageSize = 200;
    });
    /* [6] left both panes scrolled, and each pane keeps its own scroll
       position across a repaint (Reco.render's save/restore is root-scoped),
       so put both back at the top before comparing row for row. */
    document.querySelectorAll('.reco-table-wrap, .reco-table-wrap-parked')
      .forEach(w => { w.scrollTop = 0; });
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 250));
    const row = AppState.recoSessionsOwned.TPL_S.data[3];
    out.rid = row._id;
    out.bothHaveTheRow = [...document.querySelectorAll('.reco-pane')]
      .map(p => !!p.querySelector('tbody tr[data-rid="' + row._id + '"]'));

    /* manualTags is DATA: typed through the RIGHT pane's view */
    Reco.applyEdits(tpl, Panes.viewFor('p1', 'TPL_S'),
      [{ row, col: 'Note', value: 'typed on the right' }], { source: 'grid', trusted: true });
    out.throughOwner = AppState.recoSessionsOwned.TPL_S.manualTags[row._id + '||Note'];
    out.throughLeftView = Panes.viewFor('p0', 'TPL_S').manualTags[row._id + '||Note'];

    /* extraColumns is DATA: a column added on the right exists on the left */
    Panes.viewFor('p1', 'TPL_S').extraColumns =
      (Panes.viewFor('p1', 'TPL_S').extraColumns || []).concat([{ name: 'Mine', type: 'custom', _ssAdded: true }]);
    out.leftSeesTheColumn = (Panes.viewFor('p0', 'TPL_S').extraColumns || []).some(c => c.name === 'Mine');

    /* offsets is DATA, and the grid DRAWS it: ticking a row off on the right
       must show as Offset on the left after the left pane's repaint. This is
       the headline action — "tick these three off against those two" — seen
       from the other pane. */
    Panes.viewFor('p1', 'TPL_S').offsets[row._id] = { amount: 1, by: 'test', at: 'now' };
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 300));
    out.offsetShown = [...document.querySelectorAll('.reco-pane')].map(p => {
      const tr = p.querySelector('tbody tr[data-rid="' + row._id + '"]');
      return tr ? /row-offset/.test(tr.className) : null;
    });
    out.audit = Panes.idAudit();
    return out;
  });
  check(shared.bothHaveTheRow[0] === true && shared.bothHaveTheRow[1] === true,
    'the premise: with the same filters and page both panes show the same row', shared);
  check(shared.throughOwner === 'typed on the right' && shared.throughLeftView === 'typed on the right',
    'manualTags is DATA: a value typed on the right reads back through the left pane\'s view', shared);
  check(shared.leftSeesTheColumn, 'extraColumns is DATA: a column added in one pane exists in both', shared);
  check(shared.offsetShown[0] === true && shared.offsetShown[1] === true,
    'A ROW TICKED OFF IN ONE PANE IS DRAWN AS OFFSET IN BOTH — the panes share one data record', shared.offsetShown);
  check(shared.audit.ok, 'still one of each id', shared.audit);

  /* ====================================================================
     [10] A DIFFERENT TEMPLATE IN THE OTHER PANE — and a BRAND-NEW one,
     with no entry in recoSessions.json.
     ==================================================================== */
  console.log('\n[10] a brand-new template in the second pane works and persists');
  const fresh = await page2.evaluate(async () => {
    const out = {};
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_NEW'; t.name = 'Never opened';
    t.columns = [{ name: 'Doc', label: 'Doc', formats: [] }, { name: 'Amount', label: 'Amount', formats: [], isValue: true }];
    t.primaryKeys = ['Doc']; t.valueColumn = 'Amount'; t.displayColumns = ['Doc', 'Amount'];
    RecoTemplate.saveTemplate();
    out.notInTheFileYet = !AppState.recoSessionsOwned.TPL_NEW;
    out.set = Panes.setPaneTemplate('p1', 'TPL_NEW');
    await new Promise(r => setTimeout(r, 250));
    out.sessionExists = !!AppState.recoSessionsOwned.TPL_NEW;
    out.paneTpls = Panes.panes().map(p => p.tplId);
    out.note = document.body.textContent.indexOf('offsets and selections do not cross templates') >= 0;
    /* rows into the new template, through the pane that shows it */
    Panes.focusSlot(1);
    Reco.ingestData(AppState.recoTemplates.find(x => x.id === 'TPL_NEW'),
      [{ Doc: 'N1', Amount: '5' }, { Doc: 'N2', Amount: '6' }], ['Doc', 'Amount']);
    for (let i = 0; i < 120 && !AppState.recoSessions.TPL_NEW.activeVersionFile; i++) await new Promise(r => setTimeout(r, 25));
    await new Promise(r => setTimeout(r, 200));
    out.rows = [...document.querySelectorAll('.reco-pane')].map(p => p.querySelectorAll('tbody tr[data-rid]').length);
    out.audit = Panes.idAudit();
    out.drift = Panes.keySetDrift();
    /* pane 1's own slice must NOT be what gets persisted */
    Panes.viewFor('p1', 'TPL_NEW').page = 77;
    Panes.viewFor('p1', 'TPL_NEW').statusFilter = 'right-pane-only';
    await AppState.flush();
    Panes.focusSlot(0);
    return out;
  });
  check(fresh.notInTheFileYet && fresh.sessionExists,
    'a template with no entry in recoSessions.json gets one when a pane is pointed at it', fresh);
  check(fresh.set && fresh.paneTpls.join(',') === 'TPL_S,TPL_NEW', 'the two panes are on two templates', fresh.paneTpls);
  check(fresh.note, 'and the header SAYS that offsets and selections do not cross templates', fresh.note);
  check(fresh.rows[1] === 2 && fresh.rows[0] > 2, 'each pane shows its own template\'s rows', fresh.rows);
  check(fresh.audit.ok && fresh.drift.ownedOnly.length === 0 && fresh.drift.viewOnly.length === 0,
    'no duplicate id and no key-set drift with two templates open', fresh);
  const diskC = JSON.parse(fs.readFileSync(path.join(C.root, 'reco/recoSessions.json'), 'utf8'));
  check(!!diskC.TPL_NEW && (diskC.TPL_NEW.data || []).length === 2,
    'the brand-new template PERSISTED — it reached reco/recoSessions.json', Object.keys(diskC));
  check(diskC.TPL_NEW.page !== 77 && diskC.TPL_NEW.statusFilter !== 'right-pane-only',
    'and the second pane\'s private page / filter did NOT reach the shared folder',
    { page: diskC.TPL_NEW.page, statusFilter: diskC.TPL_NEW.statusFilter });

  /* ====================================================================
     [11] WHAT v1 REFUSES — and says so.
     ==================================================================== */
  console.log('\n[11] Excel View and Sheet mode are refused while split, with a reason');
  const forbidden = await page2.evaluate(async () => {
    const out = {};
    window.__toasts.length = 0;
    Reco.setSubSection('excel');
    out.subAfter = AppState.activeSubSection;
    Reco.toggleSpreadsheetMode();
    out.ssAfter = !!Panes.viewFor(Panes.owner().key, Panes.owner().tplId).spreadsheetMode;
    out.toasts = window.__toasts.slice();
    /* even forced past the button — an older handler, or a test — the render
       must not put two spreadsheets on screen */
    AppState.activeSubSection = 'excel';
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 250));
    out.xlHosts = document.querySelectorAll('#excelViewHost, [data-pid="excelViewHost"]').length;
    out.xlInstance = !!Reco._xlInstance;
    out.saysSo = document.body.textContent.indexOf('Excel View is off while two panes are open') >= 0;
    out.grids = document.querySelectorAll('.reco-table-wrap, .reco-table-wrap-parked').length;
    AppState.activeSubSection = 'reco';
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 200));
    return out;
  });
  check(forbidden.subAfter !== 'excel', 'the Excel View button is refused while a split is open', forbidden);
  check(forbidden.ssAfter === false, 'so is Sheet mode', forbidden);
  check(forbidden.toasts.filter(t => /Excel View is not available/.test(t.msg)).length === 1
     && forbidden.toasts.filter(t => /Sheet mode is not available/.test(t.msg)).length === 1,
    'each refusal SAYS WHY on screen rather than silently not happening',
    forbidden.toasts.map(t => t.msg.slice(0, 80)));
  check(forbidden.xlHosts === 0 && forbidden.xlInstance === false && forbidden.grids === 2,
    'forced past the button, the render still draws two grids and no spreadsheet', forbidden);
  check(forbidden.saysSo, 'and the toolbar says Excel View is off while two panes are open', forbidden);

  /* ====================================================================
     [12] THE SPLIT IS REMEMBERED PER MACHINE, AND NOTHING NEW REACHES
     THE SHARE.
     ==================================================================== */
  console.log('\n[12] the split is remembered on this machine, not on the share');
  const stored = await page2.evaluate(() => {
    Panes.layout().ratio = 0.35;
    Panes._saveLayout();
    Panes.saveViews();
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    return {
      layout: JSON.parse(localStorage.getItem('reco.panes.v1')),
      viewKeys: keys.filter(k => k.indexOf('reco.paneView.v1.') === 0),
      viewBlob: JSON.parse(localStorage.getItem('reco.paneView.v1.TPL_NEW') || 'null')
    };
  });
  check(stored.layout && stored.layout.split === true && stored.layout.tplId === 'TPL_NEW'
     && Math.abs(stored.layout.ratio - 0.35) < 1e-9,
    'the layout (open, which template, the ratio) is in localStorage', stored.layout);
  check(stored.viewBlob && !('data' in stored.viewBlob) && !('offsets' in stored.viewBlob)
     && !('manualTags' in stored.viewBlob) && !('selectedRows' in stored.viewBlob),
    'the stored slice holds VIEW keys ONLY — a blob containing `data` would, assigned through the view accessor, overwrite the template\'s rows on the shared folder',
    stored.viewBlob && Object.keys(stored.viewBlob));
  const diskC2 = JSON.parse(fs.readFileSync(path.join(C.root, 'reco/recoSessions.json'), 'utf8'));
  check(!('p1' in diskC2) && !('panes' in diskC2) && Object.keys(diskC2).every(k => k.indexOf('TPL_') === 0),
    'reco/recoSessions.json still holds nothing but one session per template', Object.keys(diskC2));

  /* a stored blob that tries to carry DATA in is refused key by key */
  const whitelist = await page2.evaluate(() => {
    const rowsBefore = AppState.recoSessionsOwned.TPL_NEW.data.length;
    localStorage.setItem('reco.paneView.v1.TPL_NEW', JSON.stringify({
      page: 4, zoom: 0.9, data: [], offsets: { x: true }, manualTags: { 'a||b': 'poison' }, nonsenseKey: 1
    }));
    const v = Panes.viewFor('p1', 'TPL_NEW');
    Panes._restoreView(v, 'TPL_NEW');
    return {
      rowsAfter: AppState.recoSessionsOwned.TPL_NEW.data.length, rowsBefore,
      page: v.page, zoom: v.zoom,
      offsets: Object.keys(AppState.recoSessionsOwned.TPL_NEW.offsets || {}).length,
      tags: Object.keys(AppState.recoSessionsOwned.TPL_NEW.manualTags || {}).filter(k => /poison/.test(String(AppState.recoSessionsOwned.TPL_NEW.manualTags[k]))).length,
      nonsense: ('nonsenseKey' in v)
    };
  });
  check(whitelist.rowsAfter === whitelist.rowsBefore && whitelist.offsets === 0 && whitelist.tags === 0,
    'RESTORING A STORED SLICE CANNOT REACH DATA: `data`, `offsets` and `manualTags` in the blob are dropped, not assigned through the accessor', whitelist);
  check(whitelist.page === 4 && whitelist.zoom === 0.9 && whitelist.nonsense === false,
    'the VIEW keys in it are restored and an unknown key is not', whitelist);

  /* ====================================================================
     [13] CLOSING, AND THE RELOAD.
     ==================================================================== */
  console.log('\n[13] closing a pane, and a reload that brings the split back');
  const closed = await page2.evaluate(async () => {
    Panes.focusSlot(0);
    Panes.closeSplit('p1');
    await new Promise(r => setTimeout(r, 250));
    return {
      panes: Panes.count(), shells: document.querySelectorAll('.reco-shell').length,
      splits: document.querySelectorAll('.reco-split').length,
      wraps: document.querySelectorAll('.reco-table-wrap').length,
      parked: document.querySelectorAll('.reco-table-wrap-parked').length,
      audit: Panes.idAudit(),
      showing: AppState.activeRecoId,
      sameObject: AppState.recoSessions.TPL_S === AppState.recoSessionsOwned.TPL_S,
      drift: Panes.keySetDrift(),
      layout: JSON.parse(localStorage.getItem('reco.panes.v1'))
    };
  });
  check(closed.panes === 1 && closed.shells === 1 && closed.splits === 0
     && closed.wraps === 1 && closed.parked === 0,
    'CLOSED: one shell again, and no parked wrapper left behind', closed);
  check(closed.audit.ok && closed.audit.missing.length === 0,
    'CLOSED: exactly one element carries each PANE_IDS id', closed.audit);
  check(closed.sameObject && closed.drift.ownedOnly.length === 0 && closed.drift.viewOnly.length === 0,
    'with the split closed the view table and the owned map hold the same objects again', closed);
  check(closed.layout.split === false, 'and the machine remembers that the split is closed', closed.layout);

  /* Home (or AEG) and back. Home.render replaces #appMain wholesale, so the
     split container is destroyed and has to be rebuilt on the way back — with
     each pane still on its own template, and still exactly one of each id. */
  const viaHome = await page2.evaluate(async () => {
    Panes.openSplit('TPL_NEW');
    await new Promise(r => setTimeout(r, 250));
    App.navigate('home');
    await new Promise(r => setTimeout(r, 200));
    const goneWhileHome = document.querySelectorAll('.reco-split').length;
    RecoTemplate.open('TPL_S');
    await new Promise(r => setTimeout(r, 400));
    const back = { panes: Panes.count(), roots: document.querySelectorAll('.reco-pane').length,
                   tpls: Panes.panes().map(p => p.tplId), owner: Panes.owner().key,
                   audit: Panes.idAudit() };
    App.navigate('aeg');
    await new Promise(r => setTimeout(r, 200));
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 400));
    return { goneWhileHome, back,
             viaAeg: { panes: Panes.count(), roots: document.querySelectorAll('.reco-pane').length,
                       tpls: Panes.panes().map(p => p.tplId), audit: Panes.idAudit() } };
  });
  check(viaHome.goneWhileHome === 0, 'the split container goes with the reco page', viaHome);
  check(viaHome.back.panes === 2 && viaHome.back.roots === 2 && viaHome.back.audit.ok
     && viaHome.back.tpls.join(',') === 'TPL_S,TPL_NEW' && viaHome.back.owner === 'p0',
    'HOME AND BACK rebuilds it with each pane on its own template', viaHome.back);
  check(viaHome.viaAeg.panes === 2 && viaHome.viaAeg.roots === 2 && viaHome.viaAeg.audit.ok
     && viaHome.viaAeg.tpls.join(',') === 'TPL_S,TPL_NEW',
    'and so does a trip through the Entry Generator', viaHome.viaAeg);

  /* reload the page, and the split comes back */
  const toastsBeforeReload = await readToasts(page2);
  await page2.reload();
  await page2.waitForSelector('#appMain .panel', { timeout: 20000 });
  await installToastHook(page2);
  const reloaded = await page2.evaluate(async () => {
    RecoTemplate.open('TPL_S');
    await new Promise(r => setTimeout(r, 400));
    return {
      panes: Panes.count(), roots: document.querySelectorAll('.reco-pane').length,
      tpls: Panes.panes().map(p => p.tplId), owner: Panes.owner().key,
      audit: Panes.idAudit(), wraps: document.querySelectorAll('.reco-table-wrap').length,
      ratio: Panes.layout().ratio,
      basis: (document.querySelector('.reco-pane') || {}).style?.flexBasis
    };
  });
  check(reloaded.panes === 2 && reloaded.roots === 2 && reloaded.wraps === 1 && reloaded.audit.ok,
    'AFTER A RELOAD the remembered split is rebuilt, with one addressable pane', reloaded);
  check(reloaded.tpls.join(',') === 'TPL_S,TPL_NEW',
    'each pane is back on the template it was showing', reloaded.tpls);
  check(String(reloaded.basis).indexOf('35') === 0, 'and at the width the splitter was left at', reloaded.basis);


  /* ====================================================================
     [14] THE SEVENTH WHOLE-SESSION SITE — and it is a DELETE, which is why
     the `AppState.recoSessions[x] =` grep could never find it.
     ==================================================================== */
  console.log('\n[14] deleting a template deletes the session off the share, not a view-table key');
  const del = await page2.evaluate(async () => {
    const out = {};
    const errs = [];
    const real = console.error;
    console.error = function () { errs.push(Array.from(arguments).join(' ')); };
    try {
      /* a third template, shown by the second pane, then deleted from under it */
      RecoTemplate.create();
      const t = RecoTemplate._editing;
      t.id = 'TPL_DOOMED'; t.name = 'Doomed';
      t.columns = [{ name: 'Doc', label: 'Doc', formats: [] }, { name: 'Amount', label: 'Amount', formats: [], isValue: true }];
      t.primaryKeys = ['Doc']; t.valueColumn = 'Amount'; t.displayColumns = ['Doc', 'Amount'];
      RecoTemplate.saveTemplate();
      Panes.setPaneTemplate('p1', 'TPL_DOOMED');
      await new Promise(r => setTimeout(r, 200));
      AppState.recoSessions.TPL_DOOMED.data = [{ _id: 'x0', _pk: 'X0', _ver: 'upload', Doc: 'X0', Amount: '1' }];
      await AppState.flush();
      out.onDiskBefore = true;
      const realConfirm = window.confirm; window.confirm = () => true;
      try { RecoTemplate.remove('TPL_DOOMED'); } finally { window.confirm = realConfirm; }
      await AppState.flush();
      out.owned = !!AppState.recoSessionsOwned.TPL_DOOMED;
      out.view = !!AppState.recoSessions.TPL_DOOMED;
      out.drift = Panes.keySetDrift();
      /* back to the reco page: the pane that showed it must say so */
      App.navigate('reco');
      await new Promise(r => setTimeout(r, 300));
      out.panes = Panes.count();
      out.saysDeleted = document.body.textContent.indexOf('This reconciliation has been deleted') >= 0;
      out.audit = Panes.idAudit();
      out.errors = errs.slice();
    } finally { console.error = real; }
    return out;
  });
  const diskDel = JSON.parse(fs.readFileSync(path.join(C.root, 'reco/recoSessions.json'), 'utf8'));
  check(!del.owned && !del.view,
    'the deleted template is gone from BOTH the owned map and the view table', del);
  check(!('TPL_DOOMED' in diskDel),
    'AND IT IS GONE FROM THE SHARED FILE — deleting the view-table key would have left the real session on the folder, to come back on the next load', Object.keys(diskDel));
  check(del.drift.ownedOnly.length === 0 && del.drift.viewOnly.length === 0 && del.errors.length === 0,
    'no key-set drift and no console error from flush\'s dev assertion', del);
  check(del.saysDeleted && del.audit.ok,
    'the pane that was showing it SAYS it was deleted, and offers to close itself', del);

  /* ====================================================================
     [15] A REFUSAL INSTEAD OF A STACK TRACE. Panes._makeView refuses to
     build a view while a session carries a key that is in neither list.
     Commit (a) left that escaping into openSplit and into Restore; both are
     caught here, because refusing is only right if the user is told.
     ==================================================================== */
  console.log('\n[15] an unclassified session key declines the split instead of throwing');
  const refuse2 = await page2.evaluate(async () => {
    const out = {};
    Panes.closeSplit('p1');
    await new Promise(r => setTimeout(r, 200));
    out.onePane = Panes.count() === 1;
    const id = Panes.owner().tplId;
    window.__toasts.length = 0;
    AppState.recoSessionsOwned[id].somethingFromALaterBuild = { typed: 'value' };
    out.openReturned = Panes.openSplit();
    await new Promise(r => setTimeout(r, 200));
    out.stillOnePane = Panes.count() === 1;
    out.splitDom = document.querySelectorAll('.reco-split').length;
    out.toast = (window.__toasts[0] || {}).msg || '';
    out.audit = Panes.idAudit();
    delete AppState.recoSessionsOwned[id].somethingFromALaterBuild;
    /* THE ONE PATH WHERE A REFUSAL CAN STILL FIRE WITH A SPLIT OPEN: a
       backup written by a later build. importBackup replaces the session map
       wholesale, and syncViewTable drops and rebuilds EVERY view, so a key
       in neither list is met there. A pane that already holds a view keeps
       working through it — the accessors re-resolve the owner on every read —
       which is why replaceSession alone cannot fire this. */
    out.reopened = Panes.openSplit();
    await new Promise(r => setTimeout(r, 200));
    window.__toasts.length = 0;
    window.__dl = null;
    const realDl = U.download;
    U.download = (name, text) => { window.__dl = { name, text }; };
    try { App.exportBackup(); } finally { U.download = realDl; }
    const d = JSON.parse(window.__dl.text);
    d.recoSessions[id].fromALaterBuild = { typed: 'value' };
    d.recoSessions[id].data = [{ _id: 'z0', _pk: 'Z0', _ver: 'upload' }];
    let threw = '';
    const realConfirm2 = window.confirm; window.confirm = () => true;
    try {
      App.importBackup({ target: { files: [new File([JSON.stringify(d)], 'later.json')], value: 'x' } });
      for (let k = 0; k < 80 && (AppState.recoSessionsOwned[id].data || []).length !== 1; k++) await new Promise(r => setTimeout(r, 25));
    } catch (e) { threw = String(e.message || e); }
    finally { window.confirm = realConfirm2; }
    await new Promise(r => setTimeout(r, 200));
    out.threw = threw;
    out.replaced = (AppState.recoSessionsOwned[id].data || []).length;
    out.closedTheSplit = Panes.count() === 1;
    out.saidInvalid = (window.__toasts || []).some(t => /Invalid backup/.test(t.msg));
    out.restoreToast = ((window.__toasts || []).find(t => /second pane was closed/.test(t.msg)) || {}).msg || '';
    out.drift = Panes.keySetDrift();
    delete AppState.recoSessionsOwned[id].fromALaterBuild;
    return out;
  });
  check(refuse2.openReturned === false && refuse2.stillOnePane && refuse2.splitDom === 0,
    'openSplit DECLINES over an unclassified key and leaves no half-built split behind', refuse2);
  check(/could not be opened/.test(refuse2.toast) && /neither/.test(refuse2.toast),
    'and it says why, naming the key', refuse2.toast.slice(0, 160));
  check(refuse2.reopened === true, 'with the key gone it opens normally again', refuse2);
  check(refuse2.threw === '' && refuse2.replaced === 1 && !refuse2.saidInvalid,
    'A BACKUP FROM A LATER BUILD IS STILL APPLIED, and is NOT reported as "Invalid backup" — the refusal does not escape into importBackup\'s catch',
    { threw: refuse2.threw, rows: refuse2.replaced, saidInvalid: refuse2.saidInvalid });
  check(refuse2.closedTheSplit && refuse2.drift.ownedOnly.length === 0 && refuse2.drift.viewOnly.length === 0,
    'the second pane is given up instead — the panes are a convenience, the rows are not', refuse2);
  check(/second pane was closed/.test(refuse2.restoreToast),
    'and the user is told why, rather than being left with a stack trace and half a restore', refuse2.restoreToast.slice(0, 170));

  const toastsC = toastsBeforeReload.concat(await readToasts(page2));
  const expectedErr = /not available while two panes|could not be opened|second pane was closed/;
  check(!toastsC.some(t => t.kind === 'error' && !expectedErr.test(t.msg)),
    'no error toast in the whole split run beyond the refusals the tests provoked',
    toastsC.filter(t => t.kind === 'error' && !expectedErr.test(t.msg)).map(t => t.msg.slice(0, 70)));
  check(pc.errors.length === 0, 'no page or console errors in the whole split run', pc.errors.slice(0, 6));

  /* ====================================================================
     [16] ONE SHARED SELECTION, TWO PANES — and the three sanctioned
     exceptions to MODULE 4b's invariant that the owner pane is the only
     addressable pane. updateSelSumBar, _syncVisibleSelection and
     _rowEl/_rowEls all paint selection state WITHOUT a render (they run on
     every tick of a checkbox), so each has to reach both panes or the pane
     the user is not clicking in shows a stale Σ, a stale tolerance chip and
     stale ticks.
     ==================================================================== */
  console.log('\n[16] one shared selection, two sum bars, ticks in both panes');
  const D = makeRoot('sel');
  const bridgeD = await startBridge(D.root, PORT_SEL); procs.push(bridgeD.proc);
  const ps = await openReco(browser, bridgeD);
  const page3 = ps.page;

  await page3.evaluate(async () => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_SEL'; t.name = 'Tick off';
    t.columns = [
      { name: 'Doc', label: 'Doc', formats: [] },
      { name: 'Amount', label: 'Amount', formats: [], isValue: true },
      { name: 'Status', label: 'Status', formats: [] }
    ];
    t.primaryKeys = ['Doc']; t.valueColumn = 'Amount'; t.docNumberColumn = 'Doc';
    t.editableColumns = ['Status'];
    t.displayColumns = ['Doc', 'Amount', 'Status'];
    t.toleranceMode = 'amount'; t.toleranceValue = 0;
    /* AEG on, so Preview Entry is a real button with a real path behind it:
       a refusal that only fires because the template is misconfigured would
       prove nothing. */
    t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id,
                         keywordColumn: '', keywordValues: '', postEntryColumn: '', postEntryValue: '' };
    RecoTemplate.saveTemplate();
    RecoTemplate.open('TPL_SEL');
    const s = AppState.recoSessions.TPL_SEL;
    /* Six rows on one side (+) and six on the other (-), so a cross-pane
       pick can net to zero — which is the action the whole feature exists
       for: "tick these three off against those two". */
    s.data = [];
    for (let i = 0; i < 6; i++) {
      s.data.push({ _id: 'h' + i, _pk: 'H' + i, _ver: 'upload', Doc: 'H' + i, Amount: String(100 * (i + 1)), Status: 'Hold' });
      s.data.push({ _id: 'o' + i, _pk: 'O' + i, _ver: 'upload', Doc: 'O' + i, Amount: String(-100 * (i + 1)), Status: 'Open' });
    }
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 150));
    Panes.openSplit();
    await new Promise(r => setTimeout(r, 300));
  });

  /* Both panes unfiltered first: ONE row ticked in one pane must be marked
     in BOTH, with no re-render anywhere. */
  const both = await page3.evaluate(async () => {
    Panes.focusSlot(0);
    const marked = rid => [...document.querySelectorAll('.reco-pane')].map(r => {
      const w = Panes.wrapIn(r);
      const tr = w ? [...w.querySelectorAll('tbody tr[data-rid]')].find(x => x.dataset.rid === rid) : null;
      return tr ? (tr.classList.contains('selected') ? 'selected' : 'plain') : 'absent';
    });
    const boxes = () => [...document.querySelectorAll('.reco-pane')].map(r => {
      const b = r.querySelector('[id="recoSelectAll"], [data-pid="recoSelectAll"]');
      return b ? (b.checked ? 'on' : b.indeterminate ? 'some' : 'off') : 'none';
    });
    const bars = () => ['p0', 'p1'].map(k => { const el = Panes.el(k, 'selSumBar'); return el ? el.textContent : null; });
    const out = { before: marked('h4'), boxesBefore: boxes() };
    Reco.toggleRowSelect('h4', true);
    out.after = marked('h4');
    out.els = Reco._rowEls('h4', 'TPL_SEL').length;
    out.boxes = boxes();
    out.bars = bars();
    out.sameBarElement = Panes.el('p0', 'selSumBar') === Panes.el('p1', 'selSumBar');
    Reco.toggleRowSelect('h4', false);
    out.cleared = bars().map(t => /Selected/.test(t || '') ? 'still' : 'gone');
    return out;
  });
  check(both.sameBarElement === false, 'the two panes have two different #selSumBar elements', both.sameBarElement);
  check(both.before.join('|') === 'plain|plain' && both.after.join('|') === 'selected|selected',
    'EXCEPTION 2 — a row ticked in one pane is marked in BOTH panes that show it, with no re-render',
    { before: both.before, after: both.after });
  check(both.els === 2, 'EXCEPTION 3 — _rowEls finds that row\'s <tr> in both panes (one each)', both.els);
  check(both.bars[0] && both.bars[1] && /Selected: 1/.test(both.bars[0]) && /Selected: 1/.test(both.bars[1]),
    'EXCEPTION 1 — both panes\' sum bars were painted, not just the owner\'s', both.bars);
  check(both.boxes.join('|') === 'some|some',
    'and each pane\'s own select-all box went half-ticked against its own filtered list', both.boxes);
  check(both.cleared.join('|') === 'gone|gone', 'un-ticking clears both bars too', both.cleared);

  /* ====================================================================
     [17] THE LEDGER-WRITE REFUSALS. Preview Entry with a selection present
     ignores the filters entirely, stamps postedPks and then clears the
     selection — so a cross-pane selection would post the other pane's rows
     with nothing left on screen to show what went in. Offset Selected is
     the deliberate exception: it IS the cross-pane action.
     ==================================================================== */
  console.log('\n[17] Preview Entry and Mark Offset refuse a cross-pane selection, and say why');
  const refusal = await page3.evaluate(async () => {
    const out = {};
    const v0 = Panes.viewFor('p0', 'TPL_SEL'), v1 = Panes.viewFor('p1', 'TPL_SEL');
    v0.columnFilters = { Status: [{ op: 'equals', val: 'Hold', enabled: true }] };
    v1.columnFilters = { Status: [{ op: 'equals', val: 'Open', enabled: true }] };
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 300));
    /* THREE on the left and TWO on the right, netting to zero: 100+200+300
       against -200-400. PLAN2's own example of the headline action. */
    const sess = AppState.recoSessionsOwned.TPL_SEL;
    sess.selectedRows = { h0: true, h1: true, h2: true, o1: true, o3: true };
    Reco._syncVisibleSelection();
    Reco.updateSelSumBar();
    out.counts = [Reco.applyTableFiltersSort(AppState.recoTemplates[0], v0).length,
                  Reco.applyTableFiltersSort(AppState.recoTemplates[0], v1).length];
    out.bars = ['p0', 'p1'].map(k => { const el = Panes.el(k, 'selSumBar'); return el ? el.textContent : null; });

    const run = (fn) => { window.__toasts = []; let threw = ''; try { fn(); } catch (e) { threw = String(e.message || e); } return { toasts: window.__toasts.slice(), threw }; };

    out.preview0 = run(() => Reco.previewEntryFromSelection(false, 'p0'));
    out.preview1 = run(() => Reco.previewEntryFromSelection(false, 'p1'));
    out.mark0 = run(() => Reco.bulkMarkOffset(true, 'p0'));
    out.unmark1 = run(() => Reco.bulkMarkOffset(false, 'p1'));
    out.afterRefusals = {
      selected: Object.keys(sess.selectedRows || {}).filter(k => sess.selectedRows[k]).length,
      offsets: Object.keys(sess.offsets || {}).length,
      entries: (AppState.entryHistory.TPL_SEL || []).length,
      modal: document.getElementById('appModal').classList.contains('show'),
      recoIds: sess.data.filter(r => r._recoId).length,
      master: Object.keys(AppState.manualOffsetMaster.TPL_SEL || {}).length
    };

    /* THE SANCTIONED CROSS-PANE WRITE: Offset Selected takes all five. */
    out.offset = run(() => Reco.offsetSelected('p0'));
    await new Promise(r => setTimeout(r, 250));
    const rids = new Set(sess.data.filter(r => r._recoId).map(r => r._recoId));
    out.afterOffset = {
      offsets: Object.keys(sess.offsets || {}).length,
      stamped: sess.data.filter(r => r._recoId).map(r => r.Doc).sort().join(','),
      oneRecoId: rids.size,
      master: Object.keys(AppState.manualOffsetMaster.TPL_SEL || {}).sort().join(','),
      selected: Object.keys(sess.selectedRows || {}).filter(k => sess.selectedRows[k]).length
    };

    /* POSITIVE CONTROL: a selection entirely inside this pane is NOT
       refused — it reaches the tolerance check, which is a different
       objection in different words. */
    sess.selectedRows = { h3: true, h4: true };
    out.inPaneMark = run(() => Reco.bulkMarkOffset(true, 'p0'));
    out.inPanePreview = run(() => Reco.previewEntryFromSelection(false, 'p0'));
    App.closeModal();
    return out;
  });
  check(refusal.counts[0] === 6 && refusal.counts[1] === 6, 'the two panes show six rows each, with no row in both', refusal.counts);
  check(/Selected: 5/.test(refusal.bars[0] || '') && /Selected: 5/.test(refusal.bars[1] || '')
     && /Σ Amount: 0.00/.test(refusal.bars[0] || '') && /Σ Amount: 0.00/.test(refusal.bars[1] || ''),
    'THREE ON THE LEFT AND TWO ON THE RIGHT: both sum bars show all five and the same Σ of zero', refusal.bars);
  check(/Within tolerance/.test(refusal.bars[0] || '') && /Within tolerance/.test(refusal.bars[1] || ''),
    'and the tolerance chip is right in BOTH panes — a stale "Within tolerance ✓" beside live rows is what exception 1 exists to prevent', refusal.bars);
  check(/2 not in this pane/.test(refusal.bars[0] || '') && /3 not in this pane/.test(refusal.bars[1] || ''),
    'each bar says how many of the selection its own pane does not show, BEFORE anything is clicked', refusal.bars);
  check(refusal.preview0.toasts.length === 1 && /2 of your 5 selected rows are not in this pane/.test(refusal.preview0.toasts[0].msg)
     && /nothing was posted/.test(refusal.preview0.toasts[0].msg) && refusal.preview0.toasts[0].kind === 'error',
    'PREVIEW ENTRY WITH A CROSS-PANE SELECTION REFUSES, and says why', refusal.preview0);
  check(/3 of your 5 selected rows are not in this pane/.test((refusal.preview1.toasts[0] || {}).msg || ''),
    'and from the other pane it names that pane\'s own count', (refusal.preview1.toasts[0] || {}).msg);
  check(/pane that shows them/.test((refusal.preview0.toasts[0] || {}).msg || ''),
    'the refusal says what to do instead, rather than only saying no', (refusal.preview0.toasts[0] || {}).msg);
  check(/2 of your 5/.test((refusal.mark0.toasts[0] || {}).msg || '') && /nothing was marked/.test((refusal.mark0.toasts[0] || {}).msg || ''),
    'MARK OFFSET refuses too — it writes the offset master on the shared folder', refusal.mark0);
  check(/3 of your 5/.test((refusal.unmark1.toasts[0] || {}).msg || '') && /nothing was unmarked/.test((refusal.unmark1.toasts[0] || {}).msg || ''),
    'and so does Unmark, which can drop a whole offset group', refusal.unmark1);
  check(refusal.afterRefusals.selected === 5 && refusal.afterRefusals.offsets === 0
     && refusal.afterRefusals.entries === 0 && refusal.afterRefusals.recoIds === 0
     && refusal.afterRefusals.master === 0 && refusal.afterRefusals.modal === false,
    'NOTHING HAPPENED on any of the four refusals: no entry, no offset, no _recoId, no master row, and the selection is still there to fix',
    refusal.afterRefusals);
  check(refusal.afterOffset.offsets === 5 && refusal.afterOffset.oneRecoId === 1
     && refusal.afterOffset.stamped === 'H0,H1,H2,O1,O3',
    'OFFSET SELECTED IS THE SANCTIONED EXCEPTION: all five rows, from both panes, under ONE reco id', refusal.afterOffset);
  check(refusal.afterOffset.master === 'H0,H1,H2,O1,O3',
    'and all five pks reach manualOffsetMaster, so the cross-pane offset survives a reload', refusal.afterOffset.master);
  check(!/not in this pane/.test(JSON.stringify(refusal.inPaneMark.toasts))
     && /outside tolerance/.test((refusal.inPaneMark.toasts[0] || {}).msg || ''),
    'POSITIVE CONTROL: a selection entirely inside the pane is not refused — it reaches the tolerance check', refusal.inPaneMark);
  check(!/not in this pane/.test(JSON.stringify(refusal.inPanePreview.toasts)) && refusal.inPanePreview.threw === '',
    'and Preview Entry runs for it', refusal.inPanePreview);

  /* THE REAL BUTTON, not the function call. The sum bar in each pane carries
     ITS OWN pane key in the handler it emits, which is what makes the
     refusal right even when the click never moved the focus — a DOM .click()
     fires no pointerdown, so the owner stays the LEFT pane while the RIGHT
     pane's button runs. */
  const barClick = await page3.evaluate(async () => {
    const sess = AppState.recoSessionsOwned.TPL_SEL;
    sess.offsets = {};
    sess.data.forEach(r => { delete r._recoId; delete r._manualOffset; });
    AppState.manualOffsetMaster.TPL_SEL = {};
    sess.selectedRows = { h0: true, h1: true, o1: true };
    Panes.focusSlot(0);
    Reco._syncVisibleSelection();
    Reco.updateSelSumBar();
    window.__toasts = [];
    const bar = Panes.el('p1', 'selSumBar');
    const btn = bar ? [...bar.querySelectorAll('button')].find(b => /Preview Entry/.test(b.textContent)) : null;
    const attr = btn ? btn.getAttribute('onclick') : '';
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 80));
    return { attr, toasts: window.__toasts.slice(), owner: Panes.owner().key,
             entries: (AppState.entryHistory.TPL_SEL || []).length,
             modal: document.getElementById('appModal').classList.contains('show') };
  });
  check(/previewEntryFromSelection\(false,'p1'\)/.test(barClick.attr || ''),
    'the right pane\'s sum bar emits its OWN pane key into the handler', barClick.attr);
  check(barClick.owner === 'p0' && /2 of your 3 selected rows are not in this pane/.test((barClick.toasts[0] || {}).msg || '')
     && barClick.entries === 0 && barClick.modal === false,
    'CLICKING THE REAL BUTTON in the right pane refuses with the RIGHT pane\'s count, even though the focus never left the left pane — the key comes from the markup, not from the focus',
    barClick);

  /* The header select-all box: PANE-SCOPED while split, because replacing
     the whole selection would throw away the ticks the user put in the other
     pane — which is the thing the shared selection exists for. */
  const selectAll = await page3.evaluate(async () => {
    const sess = AppState.recoSessionsOwned.TPL_SEL;
    sess.selectedRows = { h0: true, h2: true };          // two ticks in the LEFT pane
    Reco._syncVisibleSelection();
    Reco.updateSelSumBar();
    const box = Panes.el('p1', 'recoSelectAll');
    const attr = box ? box.getAttribute('onchange') : '';
    if (box) { box.checked = true; box.dispatchEvent(new Event('change')); }
    await new Promise(r => setTimeout(r, 400));
    const on = Object.keys(sess.selectedRows).filter(k => sess.selectedRows[k]).sort().join(',');
    if (box) { box.checked = false; box.dispatchEvent(new Event('change')); }
    await new Promise(r => setTimeout(r, 400));
    const off = Object.keys(sess.selectedRows).filter(k => sess.selectedRows[k]).sort().join(',');
    return { attr, on, off, owner: Panes.owner().key };
  });
  check(/toggleAllRows\(this.checked,'p1'\)/.test(selectAll.attr || ''),
    'the header select-all box carries its pane\'s key too', selectAll.attr);
  check(selectAll.on === 'h0,h2,o0,o1,o2,o3,o4,o5',
    'SELECT ALL IN THE RIGHT PANE ADDS ONLY THE RIGHT PANE\'S ROWS and leaves the left pane\'s two ticks alone — it used to replace the whole selection',
    selectAll.on);
  check(selectAll.off === 'h0,h2',
    'and un-ticking it removes only that pane\'s rows again', selectAll.off);

  /* The refusal must be a NO-OP with no split: selecting rows and then
     filtering them away still posts them, exactly as it does today. That is
     a pre-existing hazard, older than the panes, and changing it is a
     visible change to behaviour fourteen suites pin. */
  const single = await page3.evaluate(async () => {
    Panes.closeSplit('p1');
    await new Promise(r => setTimeout(r, 250));
    const sess = AppState.recoSessionsOwned.TPL_SEL;
    sess.columnFilters = { Status: [{ op: 'equals', val: 'Hold', enabled: true }] };
    sess.selectedRows = { h5: true, o5: true };          // o5 is filtered away
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 200));
    window.__toasts = [];
    let threw = '';
    try { Reco.previewEntryFromSelection(false, 'p0'); } catch (e) { threw = String(e.message || e); }
    const out = { split: Panes.isSplit(), toasts: window.__toasts.slice(), threw };
    App.closeModal();
    return out;
  });
  check(single.split === false && !/not in this pane/.test(JSON.stringify(single.toasts)),
    'WITH NO SPLIT THE REFUSAL IS A NO-OP — single-pane behaviour is exactly what it was', single);

  /* ====================================================================
     [18] THE V1 CONTRACT, SAID OUT LOUD. Where the user asked for
     something v1 does not do, the app says so instead of quietly not doing
     it: a third pane, two periods of one reconciliation, Excel View and
     Sheet mode while split (refused in [11] too), and offsets that do not
     cross templates.
     ==================================================================== */
  console.log('\n[18] what v1 does not do, it SAYS');
  const contract = await page3.evaluate(async () => {
    const out = {};
    /* The ⫿ Split button's own tooltip, read off the single-pane screen. */
    const btn = [...document.querySelectorAll('button')].find(b => /Split/.test(b.textContent));
    out.splitTitle = btn ? btn.title : '';
    Panes.openSplit();
    await new Promise(r => setTimeout(r, 250));
    out.panes = Panes.count();
    /* A THIRD PANE. */
    window.__toasts = [];
    out.third = Panes.openSplit();
    out.thirdToasts = window.__toasts.slice();
    out.panesAfter = Panes.count();
    /* The two tooltips that carry the rest of the contract. */
    const sel = document.querySelector('.reco-pane.owner select[onchange*="setPaneTemplate"]');
    out.pickerTitle = sel ? sel.title : '';
    const closeB = [...document.querySelectorAll('.reco-pane.owner button')].find(b => /Close pane/.test(b.textContent));
    out.closeTitle = closeB ? closeB.title : '';
    const xlBtn = [...document.querySelectorAll('.reco-pane.owner button')].find(b => /Excel View/.test(b.textContent));
    out.xlTitle = xlBtn ? xlBtn.title : '';
    out.xlNote = (document.querySelector('.reco-pane.owner .pane-note') || {}).textContent || '';
    return out;
  });
  check(contract.third === false && contract.panesAfter === 2,
    'a THIRD pane is refused and the two open panes are untouched', contract);
  check(contract.thirdToasts.length === 1 && /Two panes is the maximum/.test(contract.thirdToasts[0].msg),
    'AND IT SAYS SO — before this it was a silent `return false`', contract.thirdToasts);
  check(/Max 2 panes/.test(contract.splitTitle) && /Excel View and Sheet mode are not available/.test(contract.splitTitle),
    'the ⫿ Split button says up front what the split cannot do', contract.splitTitle);
  check(/offsets and selections do not cross templates/i.test(contract.pickerTitle)
     && /two periods at once is not supported/i.test(contract.pickerTitle),
    'the pane template picker says offsets do not cross templates AND that two periods is not supported', contract.pickerTitle);
  check(/other one stays/.test(contract.closeTitle), 'and ✕ Close pane says the other pane stays', contract.closeTitle);
  check(/Not available while two panes are open/.test(contract.xlTitle),
    'the Excel View button says why it is off while split', contract.xlTitle);

  /* TWO PERIODS of one reconciliation: refused by the data model (one
     loaded file per template), so loading another version file moves BOTH
     panes — and says so, because a user who split to compare two months
     would otherwise just see their rows change. */
  const periods = await page3.evaluate(async () => {
    const t = AppState.recoTemplates.find(x => x.id === 'TPL_SEL');
    Reco.ingestData(t, [
      { Doc: 'V1', Amount: '11', Status: 'Hold' },
      { Doc: 'V2', Amount: '22', Status: 'Open' }
    ], ['Doc', 'Amount', 'Status']);
    for (let i = 0; i < 160 && !AppState.recoSessionsOwned.TPL_SEL.activeVersionFile; i++) {
      await new Promise(r => setTimeout(r, 25));
    }
    App.closeModal();
    const file = AppState.recoSessionsOwned.TPL_SEL.activeVersionFile;
    window.__toasts = [];
    const r = await Reco.loadVersionedFile(file, 'TPL_SEL');
    await new Promise(r2 => setTimeout(r2, 250));
    return { file: String(file || '').split('/').pop(), ok: !!(r && r.ok), split: Panes.isSplit(),
             panesOnIt: Panes.panesFor('TPL_SEL').length, toasts: window.__toasts.slice() };
  });
  check(periods.ok && periods.panesOnIt === 2, 'a version file was loaded while both panes showed that template', periods);
  check(periods.toasts.some(t => /Both panes now show/.test(t.msg) && /two periods side by side is not supported/.test(t.msg)),
    'TWO PERIODS AT ONCE IS NOT SUPPORTED, AND THE APP SAYS SO when a load moves both panes',
    periods.toasts.map(t => t.msg.slice(0, 110)));

  check(ps.errors.length === 0, 'no page or console errors in the selection and contract run', ps.errors.slice(0, 6));

  /* ====================================================================
     [19] ONE LIVE EXCEL LINK PER PANE — "have each to have separate linked
     Excel", the half of the ask the user named in their own words.

     Everything that makes a load-back correct is already per EXPORT ID (the
     manifest, its baseline, the three-way diff, every launcher call), so
     what changes here is the KEY: ExcelLink._active and the watcher interval
     move from tplId to paneKey, and _tick stops refusing to poll for
     anything but the active template.

     THE PROPERTY THAT MATTERS, and the reason two links are safe: each
     load-back diffs its OWN baseline, and the "Reco now" side of the diff
     pulls the history written since that export — so a row edited in both
     workbooks surfaces as a reviewed CONFLICT rather than a silent
     overwrite, in EITHER load order. Both orders are tested below.
     ==================================================================== */
  console.log('\n[19] two live Excel links on one template, one per pane');
  const xlEdit = (file, ops) => {
    const opsFile = file + '.ops.json';
    fs.writeFileSync(opsFile, JSON.stringify(ops));
    const r = spawnSync('python3', [path.join(HERE, 'xl_edit.py'), file, opsFile], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('xl_edit failed: ' + r.stderr + r.stdout);
    return r.stdout;
  };
  const E = makeRoot('xl');
  const bridgeE = await startBridge(E.root, PORT_XL); procs.push(bridgeE.proc);
  const px = await openReco(browser, bridgeE);
  const page4 = px.page;
  /* The harness auto-accepts dialogs; record the questions so the pane-close
     confirmation can be asserted rather than assumed. */
  await page4.evaluate(() => {
    window.__confirms = [];
    window.confirm = function (m) { window.__confirms.push(String(m)); return true; };
  });
  const capsE = await page4.evaluate(() => ExcelLink.caps());
  check(capsE && capsE.openpyxl, 'the launcher can write real workbooks (tier P)', capsE);

  const xlTplId = 'TPL_XL';
  await page4.evaluate(async () => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_XL'; t.name = 'Two workbooks';
    t.columns = ['Doc', 'Status', 'Remarks', 'Amount'].map(n => ({
      name: n, label: n, formats: [], isValue: n === 'Amount'
    }));
    t.primaryKeys = ['Doc']; t.valueColumn = 'Amount'; t.docNumberColumn = 'Doc';
    t.editableColumns = ['Status', 'Remarks'];
    t.displayColumns = ['Doc', 'Status', 'Remarks', 'Amount'];
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_XL');
    RecoTemplate.open('TPL_XL');
    const rows = [];
    for (let i = 1; i <= 40; i++) rows.push({ Doc: 'D' + i, Status: (i % 2 ? 'Open' : 'Hold'), Remarks: '', Amount: String(i) });
    Reco.ingestData(tpl, rows, ['Doc', 'Status', 'Remarks', 'Amount']);
    for (let i = 0; i < 160 && !AppState.recoSessionsOwned.TPL_XL.activeVersionFile; i++) {
      await new Promise(r => setTimeout(r, 25));
    }
    App.closeModal();
    await AppState.flush();
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 200));
    Panes.openSplit();
    await new Promise(r => setTimeout(r, 300));
    /* The right pane takes one side of the reconciliation. "As shown"
       therefore means something different in each pane, which is the
       per-pane export with no new export plumbing at all. */
    Panes.viewFor('p1', 'TPL_XL').columnFilters = { Status: [{ op: 'equals', val: 'Hold', enabled: true }] };
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 300));
  });
  const ridOf = doc => page4.evaluate((d) => (AppState.recoSessionsOwned.TPL_XL.data.find(r => r.Doc === d) || {})._id, doc);
  const dfE = await page4.evaluate(() => Versioning.folderFor(AppState.recoTemplates.find(t => t.id === 'TPL_XL')));
  const headIn = (df, eid) => JSON.parse(fs.readFileSync(path.join(E.root, 'reco_excel', df, '_links', eid + '.json'), 'utf8'));
  const headOf = eid => headIn(dfE, eid);

  /* Export from one pane, through the real dialog, in that pane. */
  const exportFromPane = async (slot, key, df) => {
    const prev = await page4.evaluate((k) => (ExcelLink._active[k] || {}).exportId || '', key);
    await page4.evaluate((i) => Panes.focusSlot(i), slot);
    await page4.click('.reco-pane[data-pane="' + slot + '"] #xlEditInExcelBtn');
    await page4.waitForSelector('#xlCreateBtn, #appModalFooter button:has-text("Create a new one")', { timeout: 15000 });
    let prompted = false;
    if (await page4.$('#appModalFooter button:has-text("Create a new one")')) {
      prompted = true;
      await page4.click('#appModalFooter button:has-text("Create a new one")');
      await page4.waitForSelector('#xlCreateBtn', { timeout: 10000 });
    }
    const dlgPane = await page4.getAttribute('#xlDlg', 'data-pane');
    await page4.click('#xlCreateBtn');
    await page4.waitForFunction(([k, p]) => {
      const a = ExcelLink._active[k];
      return a && a.exportId && a.exportId !== p && !ExcelLink._busy;
    }, [key, prev], { timeout: 60000 });
    const info = await page4.evaluate((k) => {
      const a = ExcelLink._active[k];
      return { exportId: a.exportId, tplId: a.tplId, fileName: a.fileName };
    }, key);
    const head = headIn(df || dfE, info.exportId);
    return Object.assign(info, { dlgPane, prompted, head, df: df || dfE,
      headPath: path.join(E.root, 'reco_excel', df || dfE, '_links', info.exportId + '.json'),
      file: head.file && head.file.rel ? path.join(E.root, head.file.rel) : null });
  };

  const L = await exportFromPane(0, 'p0');
  const R = await exportFromPane(1, 'p1');
  const two = await page4.evaluate(() => ({
    active: Object.keys(ExcelLink._active).sort().map(k => ({ pane: k, tplId: ExcelLink._active[k].tplId, exportId: ExcelLink._active[k].exportId })),
    watches: Object.keys(ExcelLink._watches).sort(),
    banners: ['p0', 'p1'].map(k => (Panes.el(k, 'xlLinkBanner') || {}).textContent || ''),
    bannerPanes: [...document.querySelectorAll('.reco-pane')].map(r => {
      const b = r.querySelector('[id="xlLinkBanner"], [data-pid="xlLinkBanner"]');
      return b ? b.dataset.pane : null;
    }),
    audit: Panes.idAudit(), dupes: Panes.dupIdAudit(), owner: Panes.owner().key
  }));
  check(L.exportId && R.exportId && L.exportId !== R.exportId,
    'TWO EXPORTS, TWO EXPORT IDS — before this the second silently replaced the first\'s banner entry',
    [L.exportId, R.exportId]);
  check(L.dlgPane === 'p0' && R.dlgPane === 'p1',
    'each export dialog carried the pane it was opened from (data-pane), not the focus at the time it was submitted',
    [L.dlgPane, R.dlgPane]);
  check(two.active.length === 2 && two.active.every(a => a.tplId === 'TPL_XL'),
    'the live-link map holds ONE ENTRY PER PANE, both on the same template', two.active);
  check(two.watches.join(',') === 'p0,p1', 'and there are TWO watchers, one per pane — it was a single global interval', two.watches);
  check(L.head.session.exportedRows === 40 && R.head.session.exportedRows === 20,
    'the two workbooks hold DIFFERENT ROWS: "as shown" is as shown in that pane (40 and 20)',
    [L.head.session.exportedRows, R.head.session.exportedRows]);
  check(!!L.file && !!R.file && fs.existsSync(L.file) && fs.existsSync(R.file)
     && path.basename(L.file) !== path.basename(R.file),
    'two workbooks on the share with different names — so their ~$ owner files, which are derived from the path, cannot collide either',
    [L.file && path.basename(L.file), R.file && path.basename(R.file)]);
  check(two.banners[0].indexOf(L.fileName) >= 0 && two.banners[1].indexOf(R.fileName) >= 0,
    'EACH PANE\'S BANNER SHOWS ITS OWN WORKBOOK', two.banners.map(b => b.slice(0, 80)));
  check(two.bannerPanes.join(',') === 'p0,p1' && two.audit.ok && two.dupes.ok,
    'two banners on screen, still exactly one addressable id of each — including no duplicate id anywhere outside the modal',
    { bannerPanes: two.bannerPanes, dupes: two.dupes });

  /* ---- THE DROPPED activeRecoId GUARD: the unfocused pane must notice. */
  const ridD6 = await ridOf('D6');          // a Hold row, so it is in BOTH workbooks
  await page4.evaluate(() => Panes.focusSlot(0));
  xlEdit(R.file, [{ op: 'set', rid: ridD6, col: 'Remarks', value: 'typed on the right' }]);
  let noticed = null;
  try {
    await page4.waitForFunction(() => {
      const a = ExcelLink._active.p1;
      return a && a.status && a.status.state === 'saved' && a.status.newSinceLastImport;
    }, null, { timeout: 40000 });
    noticed = await page4.evaluate(() => ({
      owner: Panes.owner().key,
      p1: !!(ExcelLink._active.p1.status || {}).newSinceLastImport,
      p0: !!(ExcelLink._active.p0.status || {}).newSinceLastImport,
      banners: ['p0', 'p1'].map(k => (Panes.el(k, 'xlLinkBanner') || {}).textContent || '')
    }));
  } catch (e) {
    noticed = { timeout: String(e.message || e).slice(0, 120),
                state: await page4.evaluate(() => JSON.stringify(ExcelLink._active)) };
  }
  check(noticed && noticed.owner === 'p0' && noticed.p1 === true && noticed.p0 === false,
    'a save in the RIGHT pane\'s workbook is noticed by the RIGHT pane\'s watcher while the LEFT pane has the focus, and does not touch the left pane\'s link',
    noticed);
  check(noticed && noticed.banners && /changes not loaded/.test(noticed.banners[1]) && !/changes not loaded/.test(noticed.banners[0]),
    'and the amber "changes not loaded" banner is in THAT pane, not in the focused one',
    noticed && noticed.banners && noticed.banners.map(b => b.slice(0, 70)));

  /* ---- the "your workbook has unloaded changes" prompt is per pane. */
  await page4.evaluate((i) => Panes.focusSlot(i), 0);
  await page4.click('.reco-pane[data-pane="0"] #xlEditInExcelBtn');
  await page4.waitForSelector('#xlCreateBtn, #appModalFooter button:has-text("Create a new one")', { timeout: 15000 });
  const promptLeft = await page4.$('#appModalFooter button:has-text("Create a new one")');
  await page4.evaluate(() => App.closeModal());
  await page4.evaluate((i) => Panes.focusSlot(i), 1);
  await page4.click('.reco-pane[data-pane="1"] #xlEditInExcelBtn');
  await page4.waitForSelector('#xlCreateBtn, #appModalFooter button:has-text("Create a new one")', { timeout: 15000 });
  const promptRight = await page4.$('#appModalFooter button:has-text("Create a new one")');
  const rightPromptText = promptRight ? await page4.textContent('#appModalBody') : '';
  await page4.evaluate(() => App.closeModal());
  check(!promptLeft,
    'the LEFT pane can make its own workbook while the RIGHT pane has unloaded changes — the prompt consults that pane\'s link only');
  check(!!promptRight && /not loaded back yet/.test(rightPromptText),
    'and the RIGHT pane, whose own workbook has them, is asked about it', rightPromptText.slice(0, 120));

  /* ---- ORDER ONE: load the LEFT workbook, then the RIGHT one. */
  const loadBackIn = async (source) => {
    await page4.evaluate((src) => { ExcelLink.load(src); }, source);
    await page4.waitForFunction(() => !ExcelLink._busy && document.getElementById('appModal').classList.contains('show')
      && (document.getElementById('xlApplyBtn') || /Load back/.test(document.getElementById('appModalTitle').textContent)),
      null, { timeout: 40000 });
    return page4.evaluate(() => {
      const p = ExcelLink._plan;
      if (!p) return { refused: document.getElementById('appModalBody').textContent.slice(0, 200) };
      const s = x => ({ col: x.col, doc: x.row ? x.row.Doc : null, B: x.B, C: x.C, E: x.E, tick: x.tick, take: x.take });
      return { exportId: p.exportId, baseline: p.baselineSource,
               changes: p.changes.map(s), conflicts: p.conflicts.map(s), problems: p.problems.map(s) };
    });
  };
  const applyReview = async () => {
    await page4.click('#xlApplyBtn');
    await page4.waitForFunction(() => !ExcelLink._busy && !ExcelLink._plan, null, { timeout: 30000 }).catch(() => {});
    await page4.evaluate(() => AppState.flush());
  };
  xlEdit(L.file, [{ op: 'set', rid: ridD6, col: 'Remarks', value: 'typed on the left' }]);
  const planL = await loadBackIn({ exportId: L.exportId, paneKey: 'p0' });
  check(planL.changes && planL.changes.some(c => c.doc === 'D6' && c.col === 'Remarks' && c.E === 'typed on the left')
     && !(planL.conflicts || []).length,
    'ORDER 1: the LEFT workbook\'s edit is an ordinary change against its own baseline', planL);
  await applyReview();
  const afterL = await page4.evaluate((rid) => (AppState.recoSessionsOwned.TPL_XL.data.find(r => r._id === rid) || {}).Remarks, ridD6);
  check(afterL === 'typed on the left', 'and it is applied to the one shared data record', afterL);

  const planR = await loadBackIn({ exportId: R.exportId, paneKey: 'p1' });
  const confR = (planR.conflicts || []).find(c => c.doc === 'D6' && c.col === 'Remarks');
  check(!!confR && confR.E === 'typed on the right' && confR.C === 'typed on the left',
    'ORDER 1 GATE: THE SAME ROW EDITED IN BOTH WORKBOOKS IS A REVIEWED CONFLICT in the second one, not a silent overwrite — each diff is against its OWN baseline and pulls the history written since that export',
    { conflicts: planR.conflicts, changes: planR.changes });
  check(!(planR.changes || []).some(c => c.doc === 'D6' && c.col === 'Remarks'),
    'and it is NOT offered as a plain change, which would have overwritten the other workbook\'s value on a tick', planR.changes);
  const takenNeither = await page4.evaluate(() => {
    const p = ExcelLink._plan;
    const c = (p.conflicts || []).find(x => x.col === 'Remarks');
    return { take: c ? !!c.take : null, n: (p.conflicts || []).length };
  });
  check(takenNeither.take === false, 'a conflict is not pre-ticked: the user decides which value stands', takenNeither);
  await page4.evaluate(() => App.closeModal());
  await page4.evaluate(() => { ExcelLink._plan = null; });

  /* ---- ORDER TWO: a fresh pair, loaded the other way round. */
  const L2 = await exportFromPane(0, 'p0');
  const R2 = await exportFromPane(1, 'p1');
  const ridD8 = await ridOf('D8');
  xlEdit(L2.file, [{ op: 'set', rid: ridD8, col: 'Remarks', value: 'left two' }]);
  xlEdit(R2.file, [{ op: 'set', rid: ridD8, col: 'Remarks', value: 'right two' }]);
  const planR2 = await loadBackIn({ exportId: R2.exportId, paneKey: 'p1' });
  check(planR2.changes && planR2.changes.some(c => c.doc === 'D8' && c.col === 'Remarks' && c.E === 'right two'),
    'ORDER 2: the RIGHT workbook is loaded FIRST this time, and its edit is a plain change', planR2.changes);
  await applyReview();
  const planL2 = await loadBackIn({ exportId: L2.exportId, paneKey: 'p0' });
  const confL2 = (planL2.conflicts || []).find(c => c.doc === 'D8' && c.col === 'Remarks');
  check(!!confL2 && confL2.E === 'left two' && confL2.C === 'right two',
    'ORDER 2 GATE: the overlap surfaces as a conflict in whichever workbook is loaded SECOND — the protection does not depend on the order',
    { conflicts: planL2.conflicts, changes: planL2.changes });
  await page4.evaluate(() => App.closeModal());
  await page4.evaluate(() => { ExcelLink._plan = null; });
  /* FOUR links now exist on this template and each manifest records only
     its OWN history: L and R2 were applied, R and L2 had their conflict
     reviews closed without applying, and nothing crossed over. */
  const imports = {
    L: !!headOf(L.exportId).lastImport, R: !!headOf(R.exportId).lastImport,
    L2: !!headOf(L2.exportId).lastImport, R2: !!headOf(R2.exportId).lastImport,
    Lcount: (headOf(L.exportId).lastImport || {}).count,
    R2count: (headOf(R2.exportId).lastImport || {}).count
  };
  check(imports.L && imports.R2 && !imports.R && !imports.L2
     && imports.Lcount === 1 && imports.R2count === 1,
    'FOUR links on one template, and each manifest records only its own import: the two that were applied have one each, the two whose conflict reviews were closed have none',
    imports);

  /* ---- one global Excel flight, but it says whose. */
  const busy = await page4.evaluate(() => {
    const was = ExcelLink._busyWhat;
    ExcelLink._busyWhat = { paneKey: 'p1', tplName: 'Two workbooks', what: 'loading a workbook back into' };
    const msg = ExcelLink._busyMsg();
    ExcelLink._busyWhat = was;
    return msg;
  });
  check(/An Excel task is already running/.test(busy) && /right pane/.test(busy) && /Two workbooks/.test(busy),
    'the one global Excel flight is kept, and the busy message now names the pane and the template holding it', busy);

  /* ---- THE DROPPED GUARD, in the case that proves it. With both panes on
     ONE template the old guard (`AppState.activeRecoId !== w.tplId`) is
     satisfied for both watchers, so it passes either way — the case it
     breaks is a pane showing ANOTHER template, which is allowed and which
     the whole point of a link per pane depends on. */
  const xl2 = await page4.evaluate(async () => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_XL2'; t.name = 'Other side';
    t.columns = ['Doc', 'Status', 'Remarks', 'Amount'].map(n => ({ name: n, label: n, formats: [], isValue: n === 'Amount' }));
    t.primaryKeys = ['Doc']; t.valueColumn = 'Amount'; t.docNumberColumn = 'Doc';
    t.editableColumns = ['Status', 'Remarks'];
    t.displayColumns = ['Doc', 'Status', 'Remarks', 'Amount'];
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_XL2');
    RecoTemplate.open('TPL_XL2');
    const rows = [];
    for (let i = 1; i <= 12; i++) rows.push({ Doc: 'G' + i, Status: 'Open', Remarks: '', Amount: String(i * 7) });
    Reco.ingestData(tpl, rows, ['Doc', 'Status', 'Remarks', 'Amount']);
    for (let i = 0; i < 160 && !AppState.recoSessionsOwned.TPL_XL2.activeVersionFile; i++) {
      await new Promise(r => setTimeout(r, 25));
    }
    App.closeModal();
    await AppState.flush();
    /* The template opened in slot 0 (that is what RecoTemplate.open does);
       put it in the RIGHT pane and bring the left one back to TPL_XL. */
    Panes.setOwnerTemplate('TPL_XL');
    const moved = Panes.setPaneTemplate('p1', 'TPL_XL2');
    await new Promise(r => setTimeout(r, 400));
    Panes.focusSlot(0);
    await new Promise(r => setTimeout(r, 150));
    return { moved, tplIds: Panes.panes().map(p => p.tplId), owner: Panes.owner().key,
             released: !ExcelLink._active.p1, df: Versioning.folderFor(AppState.recoTemplates.find(t2 => t2.id === 'TPL_XL2')),
             note: (document.querySelector('.reco-pane.owner .pane-note') || {}).textContent || '' };
  });
  check(xl2.moved === true && xl2.tplIds.join(',') === 'TPL_XL,TPL_XL2' && xl2.owner === 'p0',
    'the right pane is pointed at a SECOND template while the left keeps the first', xl2);
  check(xl2.released === true,
    'moving a pane to another template RELEASES its link rather than carrying it along', xl2.released);
  check(headOf(R2.exportId).status === 'open',
    'and that released link is still OPEN on the share — a link is never auto-closed',
    headOf(R2.exportId).status);
  check(/Two templates: offsets and selections do not cross templates/.test(xl2.note),
    'the header says offsets and selections do not cross templates', xl2.note);

  const R3 = await exportFromPane(1, 'p1', xl2.df);
  await page4.evaluate(() => Panes.focusSlot(0));
  const beforeAmber = await page4.evaluate(() => ({
    owner: Panes.owner().key, activeRecoId: AppState.activeRecoId,
    watch1: (ExcelLink._watches.p1 || {}).tplId
  }));
  xlEdit(R3.file, [{ op: 'set', rid: await page4.evaluate(() => (AppState.recoSessionsOwned.TPL_XL2.data.find(r => r.Doc === 'G3') || {})._id),
                     col: 'Remarks', value: 'saved in the other template' }]);
  let crossNoticed = null;
  try {
    await page4.waitForFunction(() => {
      const a = ExcelLink._active.p1;
      return a && a.status && a.status.state === 'saved' && a.status.newSinceLastImport;
    }, null, { timeout: 45000 });
    crossNoticed = await page4.evaluate(() => ({
      owner: Panes.owner().key, activeRecoId: AppState.activeRecoId,
      amber: /changes not loaded/.test((Panes.el('p1', 'xlLinkBanner') || {}).textContent || ''),
      p1tpl: ExcelLink._active.p1.tplId
    }));
  } catch (e) {
    crossNoticed = { timedOut: true, state: await page4.evaluate(() => JSON.stringify({ active: ExcelLink._active, watches: Object.keys(ExcelLink._watches) })) };
  }
  check(beforeAmber.activeRecoId === 'TPL_XL' && beforeAmber.watch1 === 'TPL_XL2',
    'the focused pane is on one template and the watched link is on the other — which is what the old guard could not see past', beforeAmber);
  check(crossNoticed && !crossNoticed.timedOut && crossNoticed.amber === true && crossNoticed.p1tpl === 'TPL_XL2',
    'A SAVE IN THE UNFOCUSED PANE\'S WORKBOOK IS NOTICED EVEN WHEN THAT PANE SHOWS ANOTHER TEMPLATE — _tick\'s guard was "is this the ACTIVE template", which in a split means that link never polls at all',
    crossNoticed);

  /* ---- closing a pane whose workbook has unloaded saves asks first, and
     leaves the link OPEN on the share so it can be adopted again. */
  const paneClosed = await page4.evaluate(async () => {
    window.__confirms = [];
    const before = Object.keys(ExcelLink._active).sort().join(',');
    const ok = Panes.closeSplit('p1');
    await new Promise(r => setTimeout(r, 300));
    return { ok, before, after: Object.keys(ExcelLink._active).sort().join(','),
             watches: Object.keys(ExcelLink._watches).sort().join(','),
             confirms: window.__confirms.slice(), panes: Panes.count() };
  });
  check(paneClosed.confirms.some(c => /not loaded back/.test(c) && /leaves the link open/.test(c)),
    'CLOSING A PANE WITH UNLOADED EXCEL SAVES ASKS FIRST, and says the link stays open', paneClosed.confirms);
  check(paneClosed.ok && paneClosed.panes === 1 && paneClosed.before === 'p0,p1' && paneClosed.after === 'p0' && paneClosed.watches === 'p0',
    'the closed pane\'s link and its watcher are released; the surviving pane keeps its own', paneClosed);
  check(headIn(R3.df, R3.exportId).status === 'open',
    'AND THE LINK IS STILL OPEN ON THE SHARE — a pane closing must never close a colleague\'s workbook out from under them',
    headIn(R3.df, R3.exportId).status);
  const adoptable = await page4.evaluate(async (eid) => {
    const links = await ExcelLink.listLinks(AppState.recoTemplates.find(t => t.id === 'TPL_XL2'));
    const l = links.find(x => x.exportId === eid);
    return { listed: !!l, status: l && l.status, newSince: l && l.newSinceLastImport };
  }, R3.exportId);
  check(adoptable.listed && adoptable.status === 'open',
    'and the Links panel still lists it, so either pane can adopt it again', adoptable);

  check(px.errors.length === 0, 'no page or console errors in the whole two-workbook run', px.errors.slice(0, 6));

} finally {
  clearTimeout(watchdog);
  await browser.close();
  procs.forEach(p => { try { p.kill(); } catch (e) {} });
}

console.log('\n' + (failures ? '✗ ' : '✓ ') + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
