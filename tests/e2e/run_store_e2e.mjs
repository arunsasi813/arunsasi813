/* S10 — THE ONE PK-KEYED STORE for an added column's value.
 *
 *     node tests/e2e/run_store_e2e.mjs
 *
 * WHAT THIS GUARDS. The value a person types into an added `custom` or
 * `dropdown` column was never on the row: it lived in `sess.manualTags` keyed
 * `row._id + '||' + name`, and `row._id` is minted fresh by U.uid() on EVERY
 * load. So a vendor name typed onto 400 rows, saved, and reopened tomorrow was
 * 400 blanks, with the values still in reco/recoSessions.json under row ids
 * that no longer existed, and nothing warning anyone. (Reproduced before any
 * code was written: scratchpad/store/s1/probe_output.txt.)
 *
 * This phase adds `AppState.extraValueMaster` — keyed on the row's STABLE key
 * `_pk` — plus `Store.mergeWrite` (read+merge+write inside ONE `Store._enqueue`
 * job), and moves the WRITE there while the legacy `manualTags` READ stays as a
 * permanent fallback. NOTHING IS SWITCHED ON. No UI, no flags, no feature.
 * Default behaviour is byte-identical except that a typed value now survives
 * reopening its own file and a Clear.
 *
 * The gates, in the order of how much they matter:
 *
 *   S1  THE LEGACY `manualTags` READ FALLBACK IS PERMANENT. run_reports_e2e
 *       seeds `sess.manualTags[...]` directly and reads the value back through
 *       the ladder; that makes it the regression test for this whole
 *       migration. S1 seeds it the same way here so this suite fails too if
 *       anyone ever "modernises" the fallback away.
 *       NOTE, SAID OUT LOUD: S1 is the one section that PASSES BEFORE THE
 *       CHANGE AND AFTER IT. That is its job — it is a no-regression gate, not
 *       a defect reproduction. Every other section below fails before the
 *       change, and pre.txt records which.
 *   S2  ONE WRITE PER BURST. `extraValueMaster` is NOT in PERSIST_KEYS, so a
 *       tag edit plus an unrelated `AppState.flush()` must call `write_file`
 *       for `reco/extraValueMaster.json` EXACTLY ONCE. Membership in
 *       PERSIST_KEYS *is* the blind overwrite of a shared file (AppState.flush
 *       writes the whole file with no re-read and no mtime check), and once
 *       `manualTags` stops being written there is NO SECOND COPY ANYWHERE.
 *   S3  TWO PEOPLE, BOTH KEEP THEIR WORK. Two browser contexts on one share
 *       type different keys; both records are in the file afterwards. Without
 *       the read-merge-write the second page writes a file that does not
 *       contain the first page's record and says nothing.
 *
 * PHASE 2 (#26, THE MANUAL OVERRIDE) adds O1-O11 and S12, in sections
 * [12]-[21]. Its own gates:
 *
 *   O1  THE REVERT DELETES THE RECORD. Setting an override and reverting it
 *       puts the formula value back AND removes the pk/column key - including
 *       for an EMPTY override, which is the case a value-based revert
 *       silently makes permanent (`''` equals the empty override, so
 *       applyEdits' noop check swallows it).
 *   O2  A DUPLICATE KEY MULTIPLIES MONEY INTO A JOURNAL ENTRY. Three rows
 *       under one invoice: the override is refused with the count in the
 *       message, the entry still posts 1000 + 30 + 0, and the same test
 *       plants the record by hand to show the 3000 it would otherwise post.
 *   O3  ONE STRING ON SEVEN SURFACES - the grid, a report total, the CSV, the
 *       real workbook, the in-app Excel view, the AEG preview and a Special
 *       JV bucket - each read from its own output.
 *   S12 ONE ANSWER TO "IS THIS POSTED". The post-entry column may be an added
 *       column, whose value lives in the store and not on the row; the grid
 *       badge said "open" while the Excel review said "posted".
 *
 * Then: S4 the data-loss bug is fixed; S5 `Reco.storeKey`'s three clauses
 * (including the truthy-`'||'` defect); S6 spreadsheet scratch columns must
 * not write durable shared records; S7 PERSIST_KEYS; S8 S13 under contention
 * and under readOnlyKeys; S9 every new reader with `sess = null`; S10 a
 * 2,000-edit burst is ONE write, with the wall clock; S11 the
 * `reco/extraValues/*.json` escape hatch.
 *
 * PHASE 3 (#30, CARRY-FORWARD) adds C0-C12 in sections [23]-[32]. Its gates:
 *
 *   C1  WITH THE DEFAULT FLAG (falsy), "ADD DATA" OF A SECOND FILE WITHOUT A
 *       CLEAR LEAVES THE SAME KEY BLANK. This is the blocker's exact
 *       scenario: `sess.data = sess.data.concat(mapped);` and nothing ever
 *       removes a data set, so a session-scoped test would have shipped the
 *       cross-file carry the feature promises it does not, by default, on
 *       every template on the share.
 *   C2  RE-ENTERING A CARRIED VALUE CLEARS THE CARRIED MARK, and so does
 *       changing it. applyEdits' noop check reads `cur` through the enriched
 *       row - i.e. the carried value - so without decision O's `force` path
 *       `ds` is never re-stamped and the mark is UNCLEARABLE.
 *   C3  A 50,000-CELL FILL-DOWN WRITES THE FILE ONCE (the 150 ms debounce).
 *
 * Then: C4 the ask itself; C5 decision N (`ds` is the ROW's data set, not
 * today's day file); C6 decision K's role matrix in both editors and both
 * directions, with the money consequence demonstrated; C7 decision Q's
 * one-time promotion, both halves; C8 decision S; C9 the Clear confirm;
 * C10 the Values panel.
 *
 * Ports 20800-20859 (phase 1: 20801-20805; #26: 20821-20823;
 * #30: 20842-20846).
 */
import { spawn, execFileSync } from 'node:child_process';
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
const PORT = 20801;
const PORT_B = 20802;     // the second share: S3's two-page contention
const PORT_BIG = 20803;   // S10's 2,000-edit burst
const PORT_HATCH = 20804; // S11's reco/extraValues/*.json
const PORT_BK = 20805;    // the four backup sites
const PORT_OV = 20821;    // #26: the override fixture
const PORT_DUP = 20822;   // #26: O2's duplicate key
const PORT_BIGO = 20823;  // #26: O7/O9 at 200,000 rows
/* THE FIXER ROUND (F1-F12). Each section that needs its own share gets its
   own port, because a two-page contention test cannot share a root. */
const PORT_FIX_DEL  = 20847;   // F1  RC-1: the delete vs a stale page
const PORT_FIX_DS   = 20848;   // F2  RC-2: two uploads in one calendar day
const PORT_FIX_DUP  = 20849;   // F3  RC-3a: a duplicate arriving by Add Data
const PORT_FIX_POST = 20850;   // F4/F5 RC-3b/c: the posted mark and the delete routes
const PORT_FIX_ROLE = 20851;   // F6  RC-3d: the role matrix and the untick
const PORT_FIX_NUM  = 20852;   // F7/F8 RC-4: the non-numeric override, the kind scan
const PORT_FIX_COL  = 20853;   // F9  the added column's lifecycle
const PORT_FIX_SAY  = 20854;   // F10 the store says when it could not save
const PORT_FIX_SPL  = 20855;   // F10 the damaged split file
const PORT_FIX_DRAG = 20856;   // F11 the spreadsheet fill drag
const PORT_FIX_SAFE = 20857;   // F12 the confirms that name the values
/* The build every assertion here was shown to FAIL against. Override with
   BASE_REV=<rev>. */
const BASE_REV = process.env.BASE_REV || 'e9851b4';

let failures = 0, passes = 0;
function check(cond, msg, extra) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 900) : '')); }
  return !!cond;
}
function note(msg, extra) {
  console.log('    · ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : ''));
}
function section(n, title) { console.log('\n[' + n + '] ' + title); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* Run the WHOLE suite against another build without touching the working
   tree: APP_REV=<rev> builds every app root from `git show <rev>:apps/Reco.html`.
   That is how pre.txt was produced (APP_REV=e9851b4). */
const APP_REV = process.env.APP_REV || null;
if (APP_REV) console.log('APP_REV=' + APP_REV + ' — running against that build, not the working tree');

/* APP_FILE=<path> does the same thing with a FILE instead of a revision,
   which is how a phase whose "before" is the UNCOMMITTED working tree of the
   phase ahead of it records its pre-fix run:
     APP_FILE=.../store/s2/Reco.html.bak node tests/e2e/run_store_e2e.mjs
   is phase 2's pre.txt, the same way APP_REV=e9851b4 is phase 1's. */
const APP_FILE = process.env.APP_FILE || null;
if (APP_FILE) console.log('APP_FILE=' + APP_FILE + ' — running against that file, not the working tree');

function makeRoot(name, fromRev) {
  fromRev = fromRev || APP_REV;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-store-'));
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
  } else if (APP_FILE) {
    fs.mkdirSync(path.join(root, 'apps'), { recursive: true });
    fs.copyFileSync(APP_FILE, path.join(root, 'apps/Reco.html'));
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

async function openReco(browser, bridge, file) {
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
  await page.goto(bridge.url + '/apps/' + (file || 'Reco.html'));
  await page.waitForSelector('#appMain .panel', { timeout: 30000 });
  await page.evaluate(() => {
    window.__toasts = [];
    const real = U.toast;
    U.toast = function (msg, kind) { window.__toasts.push({ msg: String(msg), kind: kind || '' }); return real.apply(U, arguments); };
  });
  return { ctx, page, errors };
}
const readToasts = page => page.evaluate(() => (window.__toasts || []).slice());
const callLog = async bridge => (await (await fetch(bridge.url + '/__log')).json()).calls;
const resetLog = async bridge => { await fetch(bridge.url + '/__reset_log', { method: 'POST' }); };
const writesOf = (calls, rel) => calls.filter(c => c.method === 'write_file' && c.arg0 === rel).length;
/* The day file this template's version rows go into, and its rows. Used by
   O1i, which asserts that an override writes NO Cn row (decision I). */
const verFile = (root, folder) => {
  const d = new Date();
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]
    + '-' + String(d.getFullYear()).slice(-2);
  return path.join(root, 'reco_data', folder, mon, String(d.getDate()).padStart(2, '0') + '.csv');
};
const csvRows = (file) => {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = lines[0].split(',');
  return lines.slice(1).map(l => {
    const v = l.split(','); const o = {};
    head.forEach((h, i) => { o[h] = v[i]; });
    return o;
  });
};
const diskJson = (root, rel) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); }
  catch (e) { return null; }
};

/* ---------------------------------------------------------------------------
   THE FIXTURE. One keyed template with ONE added `custom` column ("Vendor")
   and one added `dropdown` column ("Status"), plus a SECOND template with NO
   primary keys at all (S5's legacy branch) and a THIRD with two key columns
   (S5's truthy-'||' defect). `nRows` rows with fixed `Invoice` values.
   ONE string, evaluated in whichever build is under test.
--------------------------------------------------------------------------- */
const SETUP = `(async function (arg) {
  const [nRows] = arg;
  const mk = (id, name, keys, cols) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = id; t.name = name;
    t.columns = cols.map(n => ({ name: n, label: n, formats: [], isValue: n === 'Amount' }));
    t.primaryKeys = keys;
    t.valueColumn = 'Amount';
    t.displayColumns = cols.slice();
    t.additionalColumns = [{ name: 'Vendor', type: 'custom' },
                           { name: 'Status', type: 'dropdown', options: 'Open,Closed' }];
    RecoTemplate.saveTemplate();
    return AppState.recoTemplates.find(x => x.id === id);
  };
  const keyed   = mk('TPL_K',  'Keyed',    ['Invoice'],         ['Invoice', 'Amount']);
  const keyless = mk('TPL_N',  'No keys',  [],                  ['Invoice', 'Amount']);
  const twoKey  = mk('TPL_2',  'Two keys', ['Invoice', 'Line'], ['Invoice', 'Line', 'Amount']);

  const ingest = async (tpl, rows, fields) => {
    RecoTemplate.open(tpl.id);
    await Reco.ingestData(tpl, rows.map(x => { const o = {}; fields.forEach((f, i) => o[f] = x[i]); return o; }), fields);
    App.closeModal();
  };
  const spec = [];
  for (let i = 1; i <= nRows; i++) spec.push(['INV-' + i, String(i * 100)]);
  await ingest(keyed, spec, ['Invoice', 'Amount']);
  await ingest(keyless, spec.slice(0, 3), ['Invoice', 'Amount']);
  /* TWO KEY COLUMNS, BOTH BLANK on rows 2 and 3 — which is what makes
     getRowPK mint the TRUTHY string '||' and collapse every blank-key row in
     every file of that template onto one key. Blank key cells are routine on
     a bank or GL extract. */
  await ingest(twoKey, [['INV-1', 'L1', '100'], ['', '', '200'], ['', '', '300']],
               ['Invoice', 'Line', 'Amount']);
  AppState.activeRecoId = 'TPL_K';
  await AppState.flush();
  return { k: keyed.id, n: keyless.id, t2: twoKey.id };
})`;

/* What the SCREEN says an added column is worth, through the one ladder. */
const CELLS = `(function (arg) {
  const [tplId, col] = arg;
  const tpl = AppState.recoTemplates.find(x => x.id === tplId);
  const sess = AppState.recoSessions[tplId];
  const ac = (tpl.additionalColumns || []).find(a => a.name === col);
  Reco._fullPass();
  try { return sess.data.map(r => String(Reco._extraValueForRow(tpl, sess, r, ac))); }
  finally { Reco._fullEnd(); }
})`;

/* Type into an added column through the REAL grid write path. */
const TYPE = `(async function (arg) {
  const [tplId, col, pairs] = arg;     // pairs: [[rowIndex, value], ...]
  const tpl = AppState.recoTemplates.find(x => x.id === tplId);
  const sess = AppState.recoSessions[tplId];
  const edits = pairs.map(([i, v]) => ({ row: sess.data[i], col, value: v }));
  const res = await Reco.applyEdits(tpl, sess, edits, { source: 'grid', trusted: true });
  await AppState.flush();
  if (typeof Store.idle === 'function') await Store.idle();
  return { applied: res.applied, rejected: res.rejected.length, noop: res.noop };
})`;

const procs = [];
const browser = await chromium.launch();
try {
  /* =====================================================================
     [1] S1 — THE GATE. The legacy manualTags read fallback is PERMANENT.
     ===================================================================== */
  section(1, 'S1 (THE GATE) — the legacy `sess.manualTags` read fallback is permanent');
  const A = makeRoot('share-a');
  if (!A.root) throw new Error('could not build the app root');
  const bridgeA = await startBridge(A.root, PORT); procs.push(bridgeA.proc);
  const oa = await openReco(browser, bridgeA);
  const page = oa.page;
  const ids = await page.evaluate(SETUP + '([6])');
  note('fixture', ids);

  /* Seeded EXACTLY as run_reports_e2e.mjs does it (its lines 124-125):
       sess.manualTags = {};
       sess.manualTags[sess.data[0]._id + '||Tag'] = 'alpha';
     That suite is decision D's gate; this is the same shape so that a change
     which breaks it breaks this suite too, with a message that says why. */
  const legacy = await page.evaluate(() => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions.TPL_K;
    sess.manualTags = {};
    sess.manualTags[sess.data[0]._id + '||Vendor'] = 'alpha';
    sess.manualTags[sess.data[1]._id + '||Status'] = 'Closed';
    const ac = n => (tpl.additionalColumns || []).find(a => a.name === n);
    return {
      row0Vendor: String(Reco._extraValueForRow(tpl, sess, sess.data[0], ac('Vendor'))),
      row1Status: String(Reco._extraValueForRow(tpl, sess, sess.data[1], ac('Status'))),
      row2Vendor: String(Reco._extraValueForRow(tpl, sess, sess.data[2], ac('Vendor'))),
      /* The AEG source-row loop is the OTHER evaluator and it must read the
         same ladder, or the grid shows a value the journal posts without. */
      viaRowFull: String(Reco.rowFull(tpl, sess, sess.data[0]).Vendor),
      helperStillThere: typeof Reco._manualTag === 'function' && typeof Reco._tagKey === 'function'
    };
  });
  check(legacy.row0Vendor === 'alpha',
    'S1a a value seeded straight into sess.manualTags still reads back through the ladder (run_reports_e2e A23)', legacy);
  check(legacy.row1Status === 'Closed',
    'S1b the fallback covers a `dropdown` column too, not only `custom`', legacy);
  check(legacy.row2Vendor === '',
    'S1c a row with no seeded tag and no record is still blank', legacy);
  check(legacy.viaRowFull === 'alpha',
    'S1d the enriched row (Reco.rowFull) carries the legacy value, so every export and report does', legacy);
  check(legacy.helperStillThere,
    'S1e Reco._manualTag and Reco._tagKey still exist — the fallback is not "modernised" away', legacy);

  /* =====================================================================
     [2] S4 — THE BUG FROM STEP 1 IS FIXED.
     ===================================================================== */
  section(2, 'S4 — the data-loss bug: a typed value survives a reload of its own file, and a Clear');
  const typed = await page.evaluate(TYPE + `(['TPL_K', 'Vendor', [[0,'Acme Ltd'],[1,'Borax SA'],[2,'Cromwell'],[3,'Delta Oil'],[4,'Enigma Co'],[5,'Fulcrum']]])`);
  note('applyEdits', typed);
  check(typed.applied === 6, 'S4a all six edits were applied', typed);

  const onScreen1 = await page.evaluate(CELLS + `(['TPL_K', 'Vendor'])`);
  check(same(onScreen1, ['Acme Ltd','Borax SA','Cromwell','Delta Oil','Enigma Co','Fulcrum']),
    'S4b the six typed values are on screen right after typing', onScreen1);

  const storeFile = diskJson(A.root, 'reco/extraValueMaster.json');
  check(storeFile && storeFile.TPL_K && Object.keys(storeFile.TPL_K).length === 6,
    'S4c reco/extraValueMaster.json holds six records, keyed by _pk not by row id',
    storeFile && storeFile.TPL_K ? Object.keys(storeFile.TPL_K) : storeFile);
  check(storeFile && storeFile.TPL_K && storeFile.TPL_K['INV-1']
        && storeFile.TPL_K['INV-1'].Vendor && storeFile.TPL_K['INV-1'].Vendor.k === 'typed',
    'S4d the record carries an EXPLICIT k:\'typed\' (never inferred from the presence of `prev`)',
    storeFile && storeFile.TPL_K && storeFile.TPL_K['INV-1']);
  const rec1 = storeFile && storeFile.TPL_K && storeFile.TPL_K['INV-1'] && storeFile.TPL_K['INV-1'].Vendor;
  check(!!(rec1 && rec1.v === 'Acme Ltd' && typeof rec1.ds === 'string' && rec1.ds
           && typeof rec1.by === 'string' && typeof rec1.at === 'string'),
    'S4e the record carries v / ds / by / at', rec1);
  check(!!(rec1 && !('prev' in rec1) && !('src' in rec1)),
    'S4f a k:\'typed\' record carries no `prev` and no `src` — those are the override\'s fields', rec1);

  /* NESTED, never a joined `pk + '||' + col` key: getRowPK already joins with
     '||' and escapes nothing, so a flat key would be ambiguous. */
  check(storeFile && !Object.keys(storeFile.TPL_K || {}).some(k => k.indexOf('||Vendor') !== -1),
    'S4g the store is NESTED [tplId][pk][col], not a joined pk+\'||\'+col key',
    Object.keys((storeFile || {}).TPL_K || {}));

  /* RELOAD THE PAGE and load THE SAME FILE back — the exact motion that lost
     400 vendor names. */
  await oa.ctx.close();
  const ob = await openReco(browser, bridgeA);
  const reload = await ob.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    AppState.activeRecoId = tpl.id;
    const files = await Versioning.listFiles(tpl, true);
    const f = await Versioning.latestDataFile(tpl, files, true);
    await Reco.loadVersionedFile(f.fullPath, tpl.id);
    const sess = AppState.recoSessions[tpl.id];
    const ac = (tpl.additionalColumns || []).find(a => a.name === 'Vendor');
    Reco._fullPass();
    try {
      return {
        file: f.fullPath,
        pks: sess.data.map(r => r._pk),
        newIds: sess.data.map(r => r._id),
        cells: sess.data.map(r => String(Reco._extraValueForRow(tpl, sess, r, ac))),
        tagKeys: Object.keys(sess.manualTags || {}),
        vendorTagKeys: Object.keys(sess.manualTags || {}).filter(k => /\|\|Vendor$/.test(k)).length
      };
    } finally { Reco._fullEnd(); }
  });
  note('reloaded', { file: reload.file, tagKeys: reload.tagKeys.length, vendorTagKeys: reload.vendorTagKeys });
  check(same(reload.cells, ['Acme Ltd','Borax SA','Cromwell','Delta Oil','Enigma Co','Fulcrum']),
    'S4h THE BUG IS FIXED: all six typed values survive a page reload and a reload of their own file',
    reload.cells);
  /* The six values are NOT in sess.manualTags any more — which is the point:
     that is the home keyed on a row id that is re-minted on every load. */
  check(reload.vendorTagKeys === 0,
    'S4i and none of the six is left behind in sess.manualTags under a row id that no longer exists',
    reload.tagKeys);

  /* A CLEAR wipes the session. The store is not on the session. */
  const cleared = await ob.page.evaluate(async () => {
    Reco.clearSession();
    await AppState.flush();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const files = await Versioning.listFiles(tpl, true);
    const f = await Versioning.latestDataFile(tpl, files, true);
    await Reco.loadVersionedFile(f.fullPath, tpl.id);
    const sess = AppState.recoSessions[tpl.id];
    const ac = (tpl.additionalColumns || []).find(a => a.name === 'Vendor');
    Reco._fullPass();
    try { return sess.data.map(r => String(Reco._extraValueForRow(tpl, sess, r, ac))); }
    finally { Reco._fullEnd(); }
  });
  check(same(cleared, ['Acme Ltd','Borax SA','Cromwell','Delta Oil','Enigma Co','Fulcrum']),
    'S4j and they survive a Clear Loaded Data followed by loading the file again', cleared);

  /* An EMPTY value DELETES a k:'typed' record (a tag has no computed base to
     reveal, so blank and absent are the same thing).
     ONE assertion, and it names BOTH halves on purpose: "the record is gone"
     passes vacuously on a build that never wrote one, which is exactly the
     shape of test that proves nothing. */
  const storeBeforeEmpty = diskJson(A.root, 'reco/extraValueMaster.json');
  const hadRecord = !!(storeBeforeEmpty && storeBeforeEmpty.TPL_K
    && storeBeforeEmpty.TPL_K['INV-1'] && storeBeforeEmpty.TPL_K['INV-1'].Vendor);
  const emptied = await ob.page.evaluate(TYPE + `(['TPL_K', 'Vendor', [[0,'']]])`);
  const afterEmpty = await ob.page.evaluate(CELLS + `(['TPL_K','Vendor'])`);
  const storeAfterEmpty = diskJson(A.root, 'reco/extraValueMaster.json');
  const stillThere = !!(storeAfterEmpty && storeAfterEmpty.TPL_K
    && storeAfterEmpty.TPL_K['INV-1'] && storeAfterEmpty.TPL_K['INV-1'].Vendor);
  check(hadRecord && !stillThere && afterEmpty[0] === '',
    'S4k an empty value DELETES the k:\'typed\' record (it existed, then it did not) rather than storing {v:\'\'}',
    { hadRecord, stillThere, cell: afterEmpty[0] });
  check(!!(storeAfterEmpty && storeAfterEmpty.TPL_K && storeAfterEmpty.TPL_K['INV-2']),
    'S4l and only THAT cell went — the other five records are untouched',
    storeAfterEmpty && storeAfterEmpty.TPL_K ? Object.keys(storeAfterEmpty.TPL_K) : null);
  note('applyEdits for the clear', emptied);

  /* =====================================================================
     [3] S2 — THE GATE. Exactly one write_file per burst, and an unrelated
     AppState.flush() must not touch the store's file at all.
     ===================================================================== */
  section(2.5, 'S2 (THE GATE) — one `write_file` for reco/extraValueMaster.json per burst');
  await resetLog(bridgeA);
  const s2 = await ob.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions[tpl.id];
    /* ONE tag edit ... */
    await Reco.applyEdits(tpl, sess, [{ row: sess.data[0], col: 'Vendor', value: 'Gamma Ltd' }],
      { source: 'grid', trusted: true });
    /* ... PLUS an unrelated change and an unrelated whole-state flush. This
       is the shape that would blind-overwrite the shared store if the key
       were in PERSIST_KEYS. */
    sess.page = (sess.page || 0) + 1;
    await AppState.flush();
    await Store.idle();
    await new Promise(r => setTimeout(r, 400));
    await Store.idle();
    return { ok: true };
  });
  const logS2 = await callLog(bridgeA);
  const n2 = writesOf(logS2, 'reco/extraValueMaster.json');
  note('write_file calls in this burst', logS2.filter(c => c.method === 'write_file').map(c => c.arg0));
  check(n2 === 1,
    'S2a after a tag edit PLUS an unrelated AppState.flush(), write_file for reco/extraValueMaster.json was called EXACTLY ONCE',
    { count: n2 });
  check(writesOf(logS2, 'reco/recoSessions.json') >= 1,
    'S2b the unrelated flush did happen (recoSessions was written), so S2a is not vacuous',
    { recoSessions: writesOf(logS2, 'reco/recoSessions.json') });
  note('s2', s2);

  /* =====================================================================
     [4] S7 — decision E. extraValueMaster is NOT in PERSIST_KEYS, and a
     flush with only an unrelated change must not write it AT ALL.
     ===================================================================== */
  section(3, 'S7 — decision E: `extraValueMaster` is not in PERSIST_KEYS');
  const keys = await ob.page.evaluate(() => ({
    persist: AppState.PERSIST_KEYS.slice(),
    inState: typeof AppState.extraValueMaster,
    saveKeysIgnores: null
  }));
  check(keys.persist.indexOf('extraValueMaster') === -1,
    'S7a `extraValueMaster` is NOT in AppState.PERSIST_KEYS — membership IS the blind overwrite', keys.persist);
  check(keys.inState === 'object',
    'S7b but AppState.extraValueMaster exists and is an object', keys.inState);

  await resetLog(bridgeA);
  const s7 = await ob.page.evaluate(async () => {
    const sess = AppState.recoSessions.TPL_K;
    sess.page = (sess.page || 0) + 1;      // an unrelated change, nothing to do with the store
    await AppState.flush();
    await Store.idle();
    await new Promise(r => setTimeout(r, 400));
    await Store.idle();
    const r = await AppState.saveKeys('extraValueMaster');
    return { saveKeys: r };
  });
  const logS7 = await callLog(bridgeA);
  check(writesOf(logS7, 'reco/extraValueMaster.json') === 0,
    'S7c an AppState.flush() with only an unrelated change does not write the store at all',
    { count: writesOf(logS7, 'reco/extraValueMaster.json'),
      wrote: logS7.filter(c => c.method === 'write_file').map(c => c.arg0) });
  check(s7.saveKeys && !(s7.saveKeys.written || []).includes('extraValueMaster'),
    'S7d AppState.saveKeys ignores it too (it filters to PERSIST_KEYS), so S13 is the only writer', s7.saveKeys);

  /* =====================================================================
     [5] S5 — Reco.storeKey's three clauses.
     ===================================================================== */
  section(4, 'S5 — `Reco.storeKey`: no keys → null, all components blank → null, else row._pk');
  const sk = await ob.page.evaluate(() => {
    const K = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const N = AppState.recoTemplates.find(x => x.id === 'TPL_N');
    const T2 = AppState.recoTemplates.find(x => x.id === 'TPL_2');
    const sN = AppState.recoSessions.TPL_N, sK = AppState.recoSessions.TPL_K, s2 = AppState.recoSessions.TPL_2;
    return {
      keyed:      Reco.storeKey(K, sK.data[0]),
      keyless:    Reco.storeKey(N, sN.data[0]),
      keylessPk:  sN.data[0]._pk,
      twoKeyGood: Reco.storeKey(T2, s2.data[0]),
      twoKeyPks:  s2.data.map(r => r._pk),
      /* ROWS 2 AND 3 have both key components blank. getRowPK joins them into
         the TRUTHY string '||', so the `_auto_` fallback never fires and
         every blank-key row in every file collapses onto one key. */
      twoKeyBlank: [Reco.storeKey(T2, s2.data[1]), Reco.storeKey(T2, s2.data[2])],
      /* A row with no row at all. */
      nullRow: Reco.storeKey(K, null),
      noTpl:   Reco.storeKey(null, sK.data[0])
    };
  });
  note('storeKey', sk);
  check(sk.keyed === 'INV-1', 'S5a a keyed row answers row._pk', sk.keyed);
  check(sk.keyless === null,
    'S5b a template with no primaryKeys answers null (clause 1) — and never mints', sk);
  check(sk.twoKeyGood === 'INV-1||L1', 'S5c a two-component key answers the joined _pk', sk.twoKeyGood);
  check(same(sk.twoKeyBlank, [null, null]),
    'S5d THE TRUTHY-\'||\' DEFECT: two blank key columns answer null, not the string \'||\' that every blank-key row would share',
    { storeKey: sk.twoKeyBlank, actualPks: sk.twoKeyPks });
  check(sk.nullRow === null && sk.noTpl === null,
    'S5e a null row and a null template answer null rather than throwing', sk);

  /* AND THE BEHAVIOUR THAT FOLLOWS: those rows go down the LEGACY branch,
     exactly as today — the value lands in sess.manualTags, not in the store. */
  const legacyBranch = await ob.page.evaluate(async () => {
    const out = {};
    /* THE CONTROL, and it is what stops S5f/S5g passing vacuously: on a build
       with no store at all, "the value did NOT reach the store" is true of
       every template. So prove in the same probe that a KEYED row's value
       DOES reach it. */
    {
      const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
      const sess = AppState.recoSessions.TPL_K;
      await Reco.applyEdits(tpl, sess, [{ row: sess.data[4], col: 'Status', value: 'Open' }],
        { source: 'grid', trusted: true });
      out.control = {
        inStore: !!((((AppState.extraValueMaster || {}).TPL_K || {})[sess.data[4]._pk] || {}).Status),
        inTags: (sess.manualTags || {})[sess.data[4]._id + '||Status'] || null
      };
    }
    for (const id of ['TPL_N', 'TPL_2']) {
      const tpl = AppState.recoTemplates.find(x => x.id === id);
      const sess = AppState.recoSessions[id];
      const rowIdx = id === 'TPL_N' ? 0 : 1;        // TPL_2 row 1 is the blank-key row
      const row = sess.data[rowIdx];
      await Reco.applyEdits(tpl, sess, [{ row, col: 'Vendor', value: 'LEGACY-' + id }],
        { source: 'grid', trusted: true });
      const ac = (tpl.additionalColumns || []).find(a => a.name === 'Vendor');
      out[id] = {
        onScreen: String(Reco._extraValueForRow(tpl, sess, row, ac)),
        inTags: (sess.manualTags || {})[row._id + '||Vendor'] || null,
        inStore: JSON.stringify(((AppState.extraValueMaster || {})[id]) || {})
      };
    }
    await AppState.flush(); await Store.idle();
    return out;
  });
  note('legacy branch', legacyBranch);
  check(legacyBranch.control.inStore && legacyBranch.control.inTags === null,
    'S5e2 (the control for S5f/S5g) a KEYED row\'s typed value reaches the store and not sess.manualTags',
    legacyBranch.control);
  check(legacyBranch.TPL_N.inTags === 'LEGACY-TPL_N' && legacyBranch.TPL_N.inStore === '{}',
    'S5f a keyless template\'s typed value goes to sess.manualTags and NOT to the store — exactly as today',
    legacyBranch.TPL_N);
  check(legacyBranch.TPL_2.inTags === 'LEGACY-TPL_2' && legacyBranch.TPL_2.inStore === '{}',
    'S5g a blank-key row\'s typed value goes to sess.manualTags and NOT to the store, so blank-key rows cannot collapse onto one key',
    legacyBranch.TPL_2);
  check(legacyBranch.TPL_N.onScreen === 'LEGACY-TPL_N' && legacyBranch.TPL_2.onScreen === 'LEGACY-TPL_2',
    'S5h and both are on screen, through the legacy arm of the same ladder', legacyBranch);

  /* =====================================================================
     [6] S6 — decision P. Spreadsheet scratch columns must not write
     durable shared records, and the cleanup must delete what it orphans.
     ===================================================================== */
  section(5, 'S6 — decision P: a `_ssSingleUse` spreadsheet column never reaches the store');
  const ss = await ob.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions.TPL_K;
    /* The three shapes `_ssAddColumn` can produce:
         A  session-only  (sess.extraColumns, _ssSingleUse)      -> scratch
         B  persisted single-use (tpl.additionalColumns, _ssSingleUse) -> scratch
         C  persisted      (tpl.additionalColumns, no _ssSingleUse)    -> durable */
    sess.extraColumns = (sess.extraColumns || []).concat(
      [{ name: 'ScratchA', type: 'custom', _ssAdded: true, _ssSingleUse: true }]);
    tpl.additionalColumns = (tpl.additionalColumns || []).concat(
      [{ name: 'ScratchB', type: 'custom', _ssAdded: true, _ssSingleUse: true },
       { name: 'KeepC',    type: 'custom', _ssAdded: true, _ssSingleUse: false }]);
    const row = sess.data[2];
    for (const col of ['ScratchA', 'ScratchB', 'KeepC'])
      await Reco.applyEdits(tpl, sess, [{ row, col, value: col + '-val' }], { source: 'grid', trusted: true });
    await AppState.flush(); await Store.idle();
    const mine = ((AppState.extraValueMaster || {}).TPL_K || {})[row._pk] || {};
    /* Only the three names under test: this row also carries the `Vendor`
       record S4 typed, and sweeping it into the set would make the assertion
       about something else. */
    const THREE = ['ScratchA', 'ScratchB', 'KeepC'];
    const seen = {
      pk: row._pk,
      inStore: THREE.filter(c => !!mine[c]),
      otherColsUntouched: !!mine.Vendor,
      inTags: THREE.filter(c => !!(sess.manualTags || {})[row._id + '||' + c]),
      onScreen: ['ScratchA', 'ScratchB', 'KeepC'].map(c => {
        const ac = (tpl.additionalColumns || []).concat(sess.extraColumns || []).find(a => a.name === c);
        return String(Reco._extraValueForRow(tpl, sess, row, ac));
      })
    };
    /* Now the cleanup that deletes the single-use columns. */
    const res = Reco._ssCleanupSingleUseAfterEntry([]);
    await AppState.flush(); await Store.idle();
    seen.cleanup = res;
    const after = ((AppState.extraValueMaster || {}).TPL_K || {})[row._pk] || {};
    seen.afterCleanup = THREE.filter(c => !!after[c]);
    seen.vendorSurvived = !!after.Vendor;
    return seen;
  });
  note('spreadsheet columns', ss);
  /* ONE EXACT-SET assertion, not three "is absent" ones: on a build with no
     store, "ScratchA is not in the store" is true of every name there is. */
  check(same(ss.inStore, ['KeepC']) && ss.otherColsUntouched,
    'S6a of the three, the store holds EXACTLY the persisted non-single-use column — not the '
    + 'session-only `_ssSingleUse` one, and not the persisted `_ssSingleUse` one',
    { three: ss.inStore, vendorStillThere: ss.otherColsUntouched });
  check(same(ss.inTags, ['ScratchA', 'ScratchB']),
    'S6b and exactly the two scratch columns fall through to today\'s manualTags branch, '
    + 'where session-scoped scratch values belong', ss.inTags);
  check(same(ss.onScreen, ['ScratchA-val', 'ScratchB-val', 'KeepC-val']),
    'S6c all three are on screen regardless of which home they landed in', ss.onScreen);
  check(same(ss.afterCleanup, ['KeepC']) && ss.vendorSurvived,
    'S6d the cleanup of the two single-use columns leaves the durable column\'s record — and '
    + 'every other column\'s record — alone',
    { three: ss.afterCleanup, vendorSurvived: ss.vendorSurvived });

  /* The cleanup must delete store records for a column name it removes.
     Set one up through the store and then remove the column. */
  const orphan = await ob.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions.TPL_K;
    tpl.additionalColumns = (tpl.additionalColumns || []).concat(
      [{ name: 'Doomed', type: 'custom', _ssAdded: true, _ssSingleUse: false }]);
    await Reco.applyEdits(tpl, sess, [{ row: sess.data[3], col: 'Doomed', value: 'will-be-removed' }],
      { source: 'grid', trusted: true });
    await AppState.flush(); await Store.idle();
    const before = Object.keys(((AppState.extraValueMaster || {}).TPL_K || {})[sess.data[3]._pk] || {});
    const vendorBefore = !!((((AppState.extraValueMaster || {}).TPL_K || {})[sess.data[3]._pk] || {}).Vendor);
    /* Now mark it single-use and run the cleanup, which deletes the column. */
    tpl.additionalColumns.find(a => a.name === 'Doomed')._ssSingleUse = true;
    Reco._ssCleanupSingleUseAfterEntry([]);
    await AppState.flush(); await Store.idle();
    const after = ((AppState.extraValueMaster || {}).TPL_K || {})[sess.data[3]._pk] || {};
    return {
      before, vendorBefore,
      after: Object.keys(after),
      vendorAfter: !!after.Vendor,
      colGone: !(tpl.additionalColumns || []).some(a => a.name === 'Doomed')
    };
  });
  note('orphan cleanup', orphan);
  const orphanDisk = diskJson(A.root, 'reco/extraValueMaster.json');
  /* Both halves in one assertion, for the same reason as S6a: "the record is
     gone" is free on a build that never stored one. */
  check(orphan.before.indexOf('Doomed') !== -1 && orphan.colGone
        && orphan.after.indexOf('Doomed') === -1
        && orphan.vendorBefore === orphan.vendorAfter,
    'S6e the cleanup DELETES the store records for a removed column name — the record existed, '
    + 'the column went, the record went with it instead of sitting on the share for ever — and '
    + 'the row\'s OTHER records are untouched', orphan);
  check(orphan.before.indexOf('Doomed') !== -1
        && !JSON.stringify(orphanDisk || {}).includes('will-be-removed'),
    'S6f and the deletion reached the shared FILE, not just memory',
    { before: orphan.before, stillOnDisk: JSON.stringify(orphanDisk || {}).includes('will-be-removed') });

  /* =====================================================================
     [7] S9 — decision T. Every new reader with sess = null.
     ===================================================================== */
  section(6, 'S9 — decision T: every new reader starts `if (!sess) return null;`');
  const nulls = await ob.page.evaluate(() => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions.TPL_K;
    const row = sess.data[1];
    const out = { results: {}, threw: [] };
    /* A CARRY column and a NON-CARRY column: the scope test is the one branch
       that differs between them, and it dereferences sess. */
    tpl.additionalColumns.find(a => a.name === 'Vendor').carryForward = true;
    const probe = (name, fn) => { try { out.results[name] = fn(); } catch (e) { out.threw.push(name + ': ' + e.message); } };
    probe('_extraRec.carry',       () => Reco._extraRec(tpl, null, row, 'Vendor'));
    probe('_extraRec.noCarry',     () => Reco._extraRec(tpl, null, row, 'Status'));
    probe('_extraTyped.carry',     () => Reco._extraTyped(tpl, null, row, 'Vendor'));
    probe('_extraTyped.noCarry',   () => Reco._extraTyped(tpl, null, row, 'Status'));
    probe('_extraOverride.carry',  () => Reco._extraOverride(tpl, null, row, 'Vendor'));
    probe('_extraOverride.noCarry',() => Reco._extraOverride(tpl, null, row, 'Status'));
    probe('dataSetOf',             () => Reco.dataSetOf(null, row));
    probe('dataSetOf.nullRow',     () => Reco.dataSetOf(sess, null));
    delete tpl.additionalColumns.find(a => a.name === 'Vendor').carryForward;
    return out;
  });
  note('null-sess readers', nulls);
  check(nulls.threw.length === 0, 'S9a no new reader throws when handed sess = null', nulls.threw);
  check(Object.keys(nulls.results).length === 8
        && Object.values(nulls.results).every(v => v === null),
    'S9b every one answers null — for a carry column and for a non-carry column', nulls.results);

  /* =====================================================================
     [8] S8 — S13 under contention, and under readOnlyKeys.
     ===================================================================== */
  section(7, 'S8 — `Store.mergeWrite`: the operator\'s own writes, and a refusal that speaks once');
  await resetLog(bridgeA);
  const cont = await ob.page.evaluate(async () => {
    const put = (pk, col, v) => Store.mergeWrite('extraValueMaster', m => {
      const t = m.TPL_K || (m.TPL_K = {});
      (t[pk] || (t[pk] = {}))[col] = { k: 'typed', v: v, ds: 'ds-test', by: 'tester', at: new Date().toISOString() };
    }, { depth: 2 });
    AppState.extraValueMaster = AppState.extraValueMaster || {};
    /* 50 ms apart: inside the 150 ms debounce, so ONE write that carries both. */
    put('CONT-A', 'Vendor', 'fifty-a');
    await new Promise(r => setTimeout(r, 50));
    put('CONT-A', 'Status', 'fifty-b');
    await new Promise(r => setTimeout(r, 400));
    await Store.idle();
    const after50 = JSON.parse(JSON.stringify((AppState.extraValueMaster.TPL_K || {})['CONT-A'] || {}));
    /* 200 ms apart: two separate jobs, the second re-reads inside the queue.
       A read taken OUTSIDE the queue sees the pre-write state of a write
       already in flight, and the operator loses their own write. */
    put('CONT-B', 'Vendor', 'twohundred-a');
    await new Promise(r => setTimeout(r, 200));
    put('CONT-B', 'Status', 'twohundred-b');
    await new Promise(r => setTimeout(r, 500));
    await Store.idle();
    return { after50, after200: JSON.parse(JSON.stringify((AppState.extraValueMaster.TPL_K || {})['CONT-B'] || {})) };
  });
  const contDisk = diskJson(A.root, 'reco/extraValueMaster.json');
  const logCont = await callLog(bridgeA);
  note('writes during contention', writesOf(logCont, 'reco/extraValueMaster.json'));
  check(cont.after50.Vendor && cont.after50.Status,
    'S8a two mergeWrite calls 50 ms apart BOTH land in memory', cont.after50);
  check(!!(contDisk && contDisk.TPL_K && contDisk.TPL_K['CONT-A']
           && contDisk.TPL_K['CONT-A'].Vendor && contDisk.TPL_K['CONT-A'].Status),
    'S8b and both are in the file', contDisk && contDisk.TPL_K && contDisk.TPL_K['CONT-A']);
  check(!!(contDisk && contDisk.TPL_K && contDisk.TPL_K['CONT-B']
           && contDisk.TPL_K['CONT-B'].Vendor && contDisk.TPL_K['CONT-B'].Status),
    'S8c two calls 200 ms apart — one write already in flight when the second is queued — BOTH survive',
    contDisk && contDisk.TPL_K && contDisk.TPL_K['CONT-B']);
  check(writesOf(logCont, 'reco/extraValueMaster.json') <= 3,
    'S8d the 50 ms pair was coalesced by the 150 ms debounce (<= 3 writes for 4 intents)',
    writesOf(logCont, 'reco/extraValueMaster.json'));

  /* A DELETE must survive the merge. Merging the disk object UNDER the
     in-memory one would otherwise RESURRECT a record the user just removed,
     which is why the buffered intent is re-applied after the merge. */
  const del = await ob.page.evaluate(async () => {
    await Store.mergeWrite('extraValueMaster', m => {
      if (m.TPL_K && m.TPL_K['CONT-A']) delete m.TPL_K['CONT-A'].Vendor;
    }, { depth: 2 });
    if (AppState.extraValueMaster.TPL_K && AppState.extraValueMaster.TPL_K['CONT-A'])
      delete AppState.extraValueMaster.TPL_K['CONT-A'].Vendor;
    await new Promise(r => setTimeout(r, 400));
    await Store.idle();
    return JSON.parse(JSON.stringify((AppState.extraValueMaster.TPL_K || {})['CONT-A'] || {}));
  });
  const delDisk = diskJson(A.root, 'reco/extraValueMaster.json');
  check(!del.Vendor && !!del.Status,
    'S8e a DELETE is not resurrected by the merge (the intent is re-applied AFTER the disk object is merged under)', del);
  check(!!(delDisk && delDisk.TPL_K && delDisk.TPL_K['CONT-A'] && !delDisk.TPL_K['CONT-A'].Vendor
           && delDisk.TPL_K['CONT-A'].Status),
    'S8f and the delete reached the file', delDisk && delDisk.TPL_K && delDisk.TPL_K['CONT-A']);

  /* readOnlyKeys: refuse the write and tell the user ONCE. */
  const ro = await ob.page.evaluate(async () => {
    window.__toasts = [];
    Store.readOnlyKeys.extraValueMaster = true;
    const a = await Store.mergeWrite('extraValueMaster', m => { m.NEVER = { x: { y: 1 } }; }, { depth: 2 });
    const b = await Store.mergeWrite('extraValueMaster', m => { m.NEVER2 = { x: { y: 1 } }; }, { depth: 2 });
    await new Promise(r => setTimeout(r, 400));
    await Store.idle();
    delete Store.readOnlyKeys.extraValueMaster;
    return { a, b, toasts: (window.__toasts || []).map(t => t.msg) };
  });
  const roDisk = diskJson(A.root, 'reco/extraValueMaster.json');
  note('readOnly toasts', ro.toasts);
  check(!!(ro.a && ro.a.refused) && !!(ro.b && ro.b.refused),
    'S8g a readOnlyKeys entry REFUSES the write rather than overwriting a file it could not read', ro);
  check(!(roDisk && (roDisk.NEVER || roDisk.NEVER2)),
    'S8h and nothing reached the file', roDisk && Object.keys(roDisk));
  check(ro.toasts.length === 1,
    'S8i and it tells the user ONCE, not once per intent', ro.toasts);

  /* =====================================================================
     [9] S3 — THE GATE. Two pages, one share, different keys, both survive.
     ===================================================================== */
  section(8, 'S3 (THE GATE) — two pages typing different keys BOTH survive');
  const B = makeRoot('share-b');
  const bridgeB = await startBridge(B.root, PORT_B); procs.push(bridgeB.proc);
  const p1 = await openReco(browser, bridgeB);
  await p1.page.evaluate(SETUP + '([4])');
  /* Page 2 boots AFTER page 1 has written the template and the rows, so it
     holds its OWN in-memory copy of the store — which is the condition that
     makes a blind whole-file write destroy a colleague's record. */
  const p2 = await openReco(browser, bridgeB);
  const bothSee = await p2.page.evaluate(() => ({
    rows: (AppState.recoSessions.TPL_K || { data: [] }).data.map(r => r._pk),
    store: JSON.stringify(AppState.extraValueMaster || {})
  }));
  note('page 2 booted with', bothSee);

  const w1 = await p1.page.evaluate(TYPE + `(['TPL_K','Vendor',[[0,'TYPED-BY-PAGE-1']]])`);
  const seenByTwo = await p2.page.evaluate(() => JSON.stringify(AppState.extraValueMaster || {}));
  const w2 = await p2.page.evaluate(TYPE + `(['TPL_K','Vendor',[[1,'TYPED-BY-PAGE-2']]])`);
  note('page 1 wrote', w1); note('page 2 wrote', w2);
  note('page 2 could not have known about page 1\'s record', { itsMemoryBefore: seenByTwo });

  const shared = diskJson(B.root, 'reco/extraValueMaster.json');
  const r1 = shared && shared.TPL_K && shared.TPL_K['INV-1'] && shared.TPL_K['INV-1'].Vendor;
  const r2 = shared && shared.TPL_K && shared.TPL_K['INV-2'] && shared.TPL_K['INV-2'].Vendor;
  check(!!(r1 && r1.v === 'TYPED-BY-PAGE-1'), 'S3a page 1\'s record is in the file', r1);
  check(!!(r2 && r2.v === 'TYPED-BY-PAGE-2'),
    'S3b page 2\'s record is in the file', r2);
  check(!!(r1 && r2),
    'S3c BOTH SURVIVE — page 2\'s write re-read and merged instead of replacing the whole file',
    shared && shared.TPL_K);

  /* The reverse order too, and with page 1 going second this time. */
  const w3 = await p2.page.evaluate(TYPE + `(['TPL_K','Status',[[2,'Closed']]])`);
  const w4 = await p1.page.evaluate(TYPE + `(['TPL_K','Status',[[3,'Open']]])`);
  note('reverse order', { w3, w4 });
  const shared2 = diskJson(B.root, 'reco/extraValueMaster.json');
  const all4 = shared2 && shared2.TPL_K
    && shared2.TPL_K['INV-1'] && shared2.TPL_K['INV-1'].Vendor
    && shared2.TPL_K['INV-2'] && shared2.TPL_K['INV-2'].Vendor
    && shared2.TPL_K['INV-3'] && shared2.TPL_K['INV-3'].Status
    && shared2.TPL_K['INV-4'] && shared2.TPL_K['INV-4'].Status;
  check(!!all4, 'S3d all four records from the two pages are in the file, in either order',
    shared2 && shared2.TPL_K);

  /* And a record written straight onto the share by a THIRD party (a
     colleague's client this test does not run) survives the next write. */
  const outside = JSON.parse(fs.readFileSync(path.join(B.root, 'reco/extraValueMaster.json'), 'utf8'));
  outside.TPL_K['INV-4'] = Object.assign({}, outside.TPL_K['INV-4'],
    { Vendor: { k: 'typed', v: 'TYPED-BY-A-COLLEAGUE', ds: 'x', by: 'colleague', at: new Date().toISOString() } });
  fs.writeFileSync(path.join(B.root, 'reco/extraValueMaster.json'), JSON.stringify(outside));
  await p1.page.evaluate(TYPE + `(['TPL_K','Vendor',[[2,'TYPED-BY-PAGE-1-AGAIN']]])`);
  const shared3 = diskJson(B.root, 'reco/extraValueMaster.json');
  check(!!(shared3 && shared3.TPL_K && shared3.TPL_K['INV-4'] && shared3.TPL_K['INV-4'].Vendor
           && shared3.TPL_K['INV-4'].Vendor.v === 'TYPED-BY-A-COLLEAGUE'),
    'S3e a record written onto the share between two of our writes is NOT destroyed by the next one',
    shared3 && shared3.TPL_K && shared3.TPL_K['INV-4']);
  await p1.ctx.close(); await p2.ctx.close();

  /* =====================================================================
     [10] S11 — the escape hatch of decision G.
     ===================================================================== */
  section(9, 'S11 — decision G: reco/extraValues/<tplId>.json is merged at boot and never written back');
  const H = makeRoot('share-hatch');
  const bridgeH = await startBridge(H.root, PORT_HATCH); procs.push(bridgeH.proc);
  const h1 = await openReco(browser, bridgeH);
  await h1.page.evaluate(SETUP + '([4])');
  await h1.ctx.close();

  /* Hand-place a split file, as the Values panel will one day write it. */
  fs.mkdirSync(path.join(H.root, 'reco/extraValues'), { recursive: true });
  fs.writeFileSync(path.join(H.root, 'reco/extraValues/TPL_K.json'), JSON.stringify({
    TPL_K: { 'INV-1': { Vendor: { k: 'typed', v: 'FROM-THE-SPLIT-FILE', ds: 'split-ds',
                                  by: 'someone', at: new Date().toISOString() } } }
  }));
  const mainBefore = diskJson(H.root, 'reco/extraValueMaster.json');

  const h2 = await openReco(browser, bridgeH);
  const hatch = await h2.page.evaluate(() => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions.TPL_K;
    const rec = Reco._extraRec(tpl, sess, sess.data[0], 'Vendor');
    return {
      merged: rec ? rec.v : null,
      file: (Store.extraValueFiles || {}).TPL_K || null,
      inMemory: JSON.stringify(((AppState.extraValueMaster || {}).TPL_K || {})['INV-1'] || {})
    };
  });
  note('hatch', hatch);
  check(hatch.merged === 'FROM-THE-SPLIT-FILE',
    'S11a a record in reco/extraValues/<tplId>.json is deep-merged in at boot — nothing to convert, ever', hatch);
  check(hatch.file === 'reco/extraValues/TPL_K.json',
    'S11b and the loader remembers which file that template\'s records live in', hatch.file);

  await h2.page.evaluate(TYPE + `(['TPL_K','Status',[[1,'Closed']]])`);
  const mainAfter = diskJson(H.root, 'reco/extraValueMaster.json');
  const splitAfter = diskJson(H.root, 'reco/extraValues/TPL_K.json');
  check(!JSON.stringify(mainAfter || {}).includes('FROM-THE-SPLIT-FILE'),
    'S11c the split record is NEVER written back into reco/extraValueMaster.json',
    mainAfter);
  check(!!(splitAfter && splitAfter.TPL_K && splitAfter.TPL_K['INV-1']
           && splitAfter.TPL_K['INV-1'].Vendor
           && splitAfter.TPL_K['INV-2'] && splitAfter.TPL_K['INV-2'].Status),
    'S11d a NEW write for a split template goes to its own file, beside the record already there',
    splitAfter && splitAfter.TPL_K);
  check(same(Object.keys((mainAfter || {})), Object.keys((mainBefore || {}))),
    'S11e the main file\'s template set is untouched by a write to a split template',
    { before: Object.keys(mainBefore || {}), after: Object.keys(mainAfter || {}) });
  await h2.ctx.close();

  /* =====================================================================
     [11] S10 — cost. A 2,000-edit burst is ONE write.
     ===================================================================== */
  section(10, 'S10 — cost: a 2,000-edit burst is ONE write; wall clock best of 3 (the MINIMUM)');
  const BIG = makeRoot('share-big');
  const bridgeBig = await startBridge(BIG.root, PORT_BIG); procs.push(bridgeBig.proc);
  const ob2 = await openReco(browser, bridgeBig);
  await ob2.page.evaluate(SETUP + '([2000])');

  /* BEST OF 3 TAKING THE MINIMUM — house practice after three knife-edge
     timing tests failed for contention, not for the thing they measured. */
  const runs = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    await resetLog(bridgeBig);
    const r = await ob2.page.evaluate(async (attempt) => {
      const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
      const sess = AppState.recoSessions.TPL_K;
      const edits = sess.data.map((row, i) => ({ row, col: 'Vendor', value: 'V' + attempt + '-' + i }));
      const t0 = performance.now();
      const res = await Reco.applyEdits(tpl, sess, edits, { source: 'grid', trusted: true });
      await AppState.flush();
      await Store.idle();
      const t1 = performance.now();
      /* The 150 ms debounce may still be pending; wait it out and settle. */
      await new Promise(r => setTimeout(r, 500));
      await Store.idle();
      return { applied: res.applied, ms: Math.round(t1 - t0) };
    }, attempt);
    const log = await callLog(bridgeBig);
    runs.push({ attempt, applied: r.applied, ms: r.ms,
                storeWrites: writesOf(log, 'reco/extraValueMaster.json'),
                sessWrites: writesOf(log, 'reco/recoSessions.json') });
  }
  runs.forEach(r => note('run ' + r.attempt, r));
  const best = runs.reduce((a, b) => (b.ms < a.ms ? b : a));
  const minWrites = Math.min(...runs.map(r => r.storeWrites));
  console.log('    · BEST OF 3 (minimum): ' + best.ms + ' ms for 2,000 edits  ('
    + (best.ms / 2000).toFixed(3) + ' ms/edit), store writes ' + best.storeWrites);
  check(runs.every(r => r.applied === 2000), 'S10a all 2,000 edits applied in every run', runs.map(r => r.applied));
  check(minWrites === 1 && runs.every(r => r.storeWrites === 1),
    'S10b a 2,000-edit burst is ONE write of reco/extraValueMaster.json — the 150 ms debounce',
    runs.map(r => r.storeWrites));
  const bigDisk = diskJson(BIG.root, 'reco/extraValueMaster.json');
  check(bigDisk && bigDisk.TPL_K && Object.keys(bigDisk.TPL_K).length === 2000,
    'S10c and all 2,000 records are in it', bigDisk && bigDisk.TPL_K ? Object.keys(bigDisk.TPL_K).length : null);
  const sizeKb = Math.round(fs.statSync(path.join(BIG.root, 'reco/extraValueMaster.json')).size / 1024);
  note('file size for 2,000 records', sizeKb + ' KB  (' +
    Math.round(fs.statSync(path.join(BIG.root, 'reco/extraValueMaster.json')).size / 2000) + ' bytes/record)');
  check(sizeKb < 400,
    'S10d the file is COMPACT (serialised through Store.serialize\'s compact branch, not pretty-printed)',
    sizeKb + ' KB');

  /* The whole point of the burst: the typed values read back through the
     ladder at 2,000 rows without a per-row scan. */
  const bigRead = await ob2.page.evaluate(() => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions.TPL_K;
    const ac = (tpl.additionalColumns || []).find(a => a.name === 'Vendor');
    const t0 = performance.now();
    Reco._fullPass();
    let n = 0;
    try { sess.data.forEach(r => { if (Reco._extraValueForRow(tpl, sess, r, ac)) n++; }); }
    finally { Reco._fullEnd(); }
    return { filled: n, ms: Math.round(performance.now() - t0) };
  });
  note('one whole-session read pass over 2,000 rows', bigRead);
  check(bigRead.filled === 2000, 'S10e every one of the 2,000 reads back through the ladder', bigRead);
  await ob2.ctx.close();

  /* =====================================================================
     [11b] THE FOUR BACKUP SITES. A backup that carries the rows and not the
     values people typed into the added columns restores two different points
     in time - and those values exist NOWHERE ELSE: no mirror on `sess`, no Cn
     row in the CSV. So all four sites must carry it, and restoreSession's
     confirm must NAME it, because replacing it is irreversible in a way
     replacing the loaded data is not.
     ===================================================================== */
  section('11b', 'The four backup sites carry the store, and the confirm names it');
  const BK = makeRoot('share-backup');
  const bridgeBK = await startBridge(BK.root, PORT_BK); procs.push(bridgeBK.proc);
  const bk = await openReco(browser, bridgeBK);
  await bk.page.evaluate(SETUP + '([4])');
  await bk.page.evaluate(TYPE + `(['TPL_K','Vendor',[[0,'BACKED-UP'],[1,'ALSO-BACKED-UP']]])`);

  const files = await bk.page.evaluate(() => {
    /* Capture what each EXPORTER writes. U.download is wrapped so the text is
       readable without a real download. */
    window.__dl = [];
    const rd = U.download;
    U.download = function (name, text) { window.__dl.push({ name, text: String(text) }); };
    Reco.backupSession();
    App.exportBackup();
    U.download = rd;
    return window.__dl.map(d => ({ name: d.name, obj: JSON.parse(d.text) }));
  });
  const sessBk = files.find(f => /reco_session_/.test(f.name));
  const suiteBk = files.find(f => /reco_suite_backup_/.test(f.name));
  check(!!(sessBk && sessBk.obj.extraValueMaster
           && sessBk.obj.extraValueMaster['INV-1']
           && sessBk.obj.extraValueMaster['INV-1'].Vendor.v === 'BACKED-UP'),
    'BK1 Reco.backupSession() carries this template\'s records (keyed by pk, like correctionMaster)',
    sessBk && sessBk.obj.extraValueMaster);
  check(!!(suiteBk && suiteBk.obj.extraValueMaster && suiteBk.obj.extraValueMaster.TPL_K
           && suiteBk.obj.extraValueMaster.TPL_K['INV-2']),
    'BK2 App.exportBackup() carries the WHOLE map (it is the suite-wide backup)',
    suiteBk && Object.keys(suiteBk.obj.extraValueMaster || {}));

  /* The confirm text must name it. Captured, then the restore is driven with
     the file the exporter just produced. */
  const restored = await bk.page.evaluate(async (payload) => {
    const out = { confirmText: '' };
    const realConfirm = window.confirm;
    window.confirm = (m) => { out.confirmText = String(m); return true; };
    try {
      /* Wipe the records first, so a restore that does nothing is visible. */
      AppState.extraValueMaster = {};
      await Store.mergeWrite('extraValueMaster', m => { delete m.TPL_K; }, { depth: 2 });
      await Store.idle();
      out.wiped = Object.keys(AppState.extraValueMaster);
      /* restoreSession reads a File through a FileReader. */
      const file = new File([JSON.stringify(payload)], 'b.json', { type: 'application/json' });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.createElement('input'); input.type = 'file'; input.files = dt.files;
      Reco.restoreSession({ target: input });
      for (let i = 0; i < 80 && !Object.keys(AppState.extraValueMaster || {}).length; i++)
        await new Promise(r => setTimeout(r, 25));
      await AppState.flush(); await Store.idle();
    } finally { window.confirm = realConfirm; }
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions.TPL_K;
    const ac = (tpl.additionalColumns || []).find(a => a.name === 'Vendor');
    out.cells = sess.data.map(r => String(Reco._extraValueForRow(tpl, sess, r, ac)));
    out.keys = Object.keys((AppState.extraValueMaster || {}).TPL_K || {});
    return out;
  }, sessBk.obj);
  note('restoreSession', { confirm: restored.confirmText, wiped: restored.wiped, keys: restored.keys });
  check(restored.wiped.length === 0 && restored.keys.length === 2,
    'BK3 restoreSession() puts the records back (and they really were gone first)', restored);
  check(restored.cells[0] === 'BACKED-UP' && restored.cells[1] === 'ALSO-BACKED-UP',
    'BK4 and they are on screen through the ladder', restored.cells);
  const bkDisk = diskJson(BK.root, 'reco/extraValueMaster.json');
  check(!!(bkDisk && bkDisk.TPL_K && bkDisk.TPL_K['INV-1']),
    'BK5 and the restore reached the shared file — through S13, not a bare assignment that no flush would ever write',
    bkDisk && bkDisk.TPL_K ? Object.keys(bkDisk.TPL_K) : bkDisk);
  check(/typed values of added columns/i.test(restored.confirmText),
    'BK6 restoreSession\'s confirm NAMES the typed values, because replacing them is irreversible in a way replacing the loaded data is not',
    restored.confirmText);

  /* THE FOURTH SITE, and the one where getting it wrong is a TOTAL loss: the
     whole-suite restore, whose own confirm says it "REPLACES the templates,
     sessions, masters and entry history shared by everyone using this folder".
     It needs its own write, because this key is not in PERSIST_KEYS and the
     AppState.flush() at the end of importBackup would therefore never write
     it - the restore would look like it worked and be gone on the next boot. */
  const imported = await bk.page.evaluate(async (payload) => {
    const realConfirm = window.confirm;
    const out = { confirmText: '' };
    window.confirm = (m) => { out.confirmText = String(m); return true; };
    try {
      AppState.extraValueMaster = {};
      await Store.mergeWrite('extraValueMaster', m => { Object.keys(m).forEach(k => delete m[k]); }, { depth: 2 });
      await Store.idle();
      out.wiped = Object.keys(AppState.extraValueMaster);
      const file = new File([JSON.stringify(payload)], 'suite.json', { type: 'application/json' });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.createElement('input'); input.type = 'file'; input.files = dt.files;
      App.importBackup({ target: input });
      for (let i = 0; i < 120 && !Object.keys(AppState.extraValueMaster || {}).length; i++)
        await new Promise(r => setTimeout(r, 25));
      await AppState.flush(); await Store.idle();
      await new Promise(r => setTimeout(r, 400));
      await Store.idle();
    } finally { window.confirm = realConfirm; }
    out.keys = Object.keys((AppState.extraValueMaster || {}).TPL_K || {});
    return out;
  }, suiteBk.obj);
  note('importBackup', imported);
  check(imported.wiped.length === 0 && imported.keys.length === 2,
    'BK7 App.importBackup() restores the whole map (and it really was empty first)', imported);
  const impDisk = diskJson(BK.root, 'reco/extraValueMaster.json');
  check(!!(impDisk && impDisk.TPL_K && impDisk.TPL_K['INV-1'] && impDisk.TPL_K['INV-2']),
    'BK8 AND IT REACHED THE FILE: importBackup\'s own AppState.flush() cannot write this key, so '
    + 'without its own S13 write the restore would be gone on the next boot',
    impDisk && impDisk.TPL_K ? Object.keys(impDisk.TPL_K) : impDisk);
  await bk.ctx.close();

  /* =====================================================================
     [12] Decision U — no new ids, and nothing emitted unconditionally.
     ===================================================================== */
  section(11, 'Decision U — the two-pane constraints are untouched');
  const ob3 = await openReco(browser, bridgeA);
  const panes = await ob3.page.evaluate(() => {
    const audit = Panes.auditKeys();
    return { audit, data: Panes.DATA_KEYS.slice(), view: Panes.VIEW_KEYS.slice() };
  });
  check(panes.audit.ok,
    'U1 Panes.auditKeys(): every key a fresh session carries is still classified (the new `dataSetIds` included)',
    panes.audit);
  check(panes.data.indexOf('dataSetIds') >= 0,
    'U2 `dataSetIds` is DATA — which file this template\'s rows came from is a fact about the data, like activeVersionFile',
    panes.data);
  check(panes.data.indexOf('manualTags') >= 0,
    'U3 `manualTags` is still DATA — the fallback is permanent, so the key stays on the list', panes.data);
  const err3 = ob3.errors.filter(e => !/Could not save|injected fault/.test(e));
  check(err3.length === 0, 'U4 no page error and no console error on a plain boot', err3);
  await ob3.ctx.close();

  /* =====================================================================
     #26 — THE MANUAL OVERRIDE. Sections [12]-[20], assertions O1-O11.

     A `formula` or `master_lookup` added column can be marked "Allow manual
     override per row"; a person types their own value into that cell; it is
     stored as k:'override' with `prev` (what the formula said then) and `src`
     (formula vs lookup, because the user asked for them to be visibly
     distinct); a revert control puts the computed value back by DELETING the
     record; every override is listed with who, when, before, after and
     Revert. Refused on a row already posted to the general ledger, naming the
     accounting reference. Refused when more than one loaded row shares the
     key. Refused on a pk-less row.
     ===================================================================== */

  /* THE #26 FIXTURE. One keyed template with:
       Net   formula  NUM({Base})*2        allowOverride   <- the formula arm
       Twice formula  {Net}*2              (plain)         <- decision J.7: this
                                            is the column that said #ERR when a
                                            typed "1,234.50" was stored verbatim
       Acct  master_lookup -> accounts     allowOverride   <- the lookup arm
       AED   formula  NUM({Net})           (plain)         <- an AEG input column
                                            by NAME, which is how an override
                                            legitimately reaches a journal entry
       Note  custom                        (a tag, for the ladder's other half)
     Status is the post-entry column. The linked AEG template is the default
     DR/CR one, whose inputColumns include AED and whose aggregateBy is
     ['Reco','ToAccount'] - so a selection of rows with one Reco and one
     ToAccount aggregates into ONE line whose value is the sum of AED.
     S11 is satisfied by construction: neither Net nor Acct is the keyword
     column, the post-entry column, the To Account column, an input column of
     the linked template, or one of its aggregateBy columns. */
  const OV_SETUP = `(async function (arg) {
    const [nRows, tplId] = arg;
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = tplId; t.name = 'Overrides ' + tplId;
    t.columns = ['Invoice', 'Base', 'Reco', 'ToAccount', 'Status']
      .map(n => ({ name: n, label: n, formats: [], isValue: n === 'Base' }));
    t.primaryKeys = ['Invoice'];
    t.valueColumn = 'Base';
    t.docNumberColumn = 'Invoice';
    t.displayColumns = t.columns.map(c => c.name);
    t.editableColumns = ['Status'];
    t.additionalColumns = [
      { name: 'Net',   type: 'formula', formula: 'NUM({Base})*2', allowOverride: true },
      { name: 'Twice', type: 'formula', formula: '{Net}*2' },
      { name: 'Acct',  type: 'master_lookup', allowOverride: true,
        masterCfg: { source: 'accounts', matchColumn: 'ToAccount', matchKey: 'Reference', returnKey: 'Nominal' } },
      { name: 'AED',   type: 'formula', formula: 'NUM({Net})' },
      { name: 'Note',  type: 'custom' }
    ];
    t.enableReporting = true;
    t.reports = [{ name: 'R', columns: ['Invoice', 'Net'] }];
    t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id,
      keywordColumn: '', keywordValues: '', postEntryColumn: 'Status', postEntryValue: 'Posted' };
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    RecoTemplate.open(tpl.id);
    const fields = ['Invoice', 'Base', 'Reco', 'ToAccount', 'Status'];
    const rows = [];
    for (let i = 1; i <= nRows; i++)
      rows.push({ Invoice: 'INV-' + i, Base: String(i * 10), Reco: 'R1', ToAccount: 'ACC1', Status: '' });
    await Reco.ingestData(tpl, rows, fields);
    App.closeModal();
    AppState.activeRecoId = tpl.id;
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    return { id: tpl.id, folder: tpl.dataFolder };
  })`;

  /* Read one override record out of the in-memory store, as plain JSON. */
  const REC = `(function (arg) {
    const [tplId, pk, col] = arg;
    const r = (((AppState.extraValueMaster || {})[tplId] || {})[pk] || {})[col];
    return r ? JSON.parse(JSON.stringify(r)) : null;
  })`;

  /* ---------------------------------------------------------------------
     [12] O1 (THE GATE) — set, then revert: the formula value is back AND the
     key is GONE from the store. Including from an EMPTY override, which is
     the case a value-based revert silently makes permanent.
     --------------------------------------------------------------------- */
  section(12, 'O1 (THE GATE) — the revert puts the computed value back and DELETES the record');
  const OV = makeRoot('share-ov');
  if (!OV.root) throw new Error('could not build the #26 app root');
  const bridgeOv = await startBridge(OV.root, PORT_OV); procs.push(bridgeOv.proc);
  const ovp = await openReco(browser, bridgeOv);
  const ovIds = await ovp.page.evaluate(OV_SETUP + `([6, 'TPL_OV'])`);
  note('#26 fixture', ovIds);

  /* SAID IN WORDS RATHER THAN A STACK TRACE. On a build without #26 every
     assertion from here on fails by not existing, and the first evaluate
     below aborts the run - which is the right reason to fail and is how
     pre.txt was recorded (APP_FILE=<the build before>). This names it. */
  const have26 = await ovp.page.evaluate(() => ({
    setOverride: typeof Reco.setOverride, _setOverride: typeof Reco._setOverride,
    _clearOverride: typeof Reco._clearOverride, _overrideColumn: typeof Reco._overrideColumn,
    _overrideList: typeof Reco._overrideList, openOverridesModal: typeof Reco.openOverridesModal,
    _overrideBox: typeof RecoTemplate._overrideBox, toggleOverride: typeof RecoTemplate.toggleOverride,
    isRowPostedArity: Reco.isRowPosted.length
  }));
  check(Object.keys(have26).every(k => k === 'isRowPostedArity' ? have26[k] === 3 : have26[k] === 'function'),
    'O0 the feature exists at all: the two writers, the panel, the editor box and S12\'s three-argument '
    + 'isRowPosted. Everything after this line fails by not existing on a build without #26', have26);

  const o1 = await ovp.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_OV');
    const sess = AppState.recoSessions.TPL_OV;
    const row = sess.data.find(r => r._pk === 'INV-1');          // Base 10 -> Net 20
    const read = () => String(Reco.rowFull(tpl, sess, row).Net);
    const rec = () => { const r = Reco._extraRec(tpl, sess, row, 'Net'); return r ? JSON.parse(JSON.stringify(r)) : null; };
    const out = { computed: read() };
    const r1 = await Reco.setOverride(row._id, 'Net', '1000');
    out.setRes = { applied: r1.applied, rejected: r1.rejected.length, reasons: r1.sessionOnly.map(s => s.reason) };
    out.afterSet = read();
    out.rec = rec();
    out.onRow = Object.prototype.hasOwnProperty.call(row, 'Net');
    const r2 = await Reco.revertOverride(row._id, 'Net');
    out.revertRes = { applied: r2.applied, rejected: r2.rejected.length, reasons: r2.sessionOnly.map(s => s.reason) };
    out.afterRevert = read();
    out.recAfterRevert = rec();
    /* THE EMPTY OVERRIDE. {v:''} is a DELIBERATE BLANK - a computed column has
       a value underneath to reveal, so clearing the cell cannot mean "no
       record". A value-based revert would pass '' , which equals the empty
       override, and applyEdits' noop check would swallow it: the blank would
       be permanent. */
    await Reco.setOverride(row._id, 'Net', '');
    out.emptyShows = read();
    out.emptyRec = rec();
    await Reco.revertOverride(row._id, 'Net');
    out.afterEmptyRevert = read();
    out.recAfterEmptyRevert = rec();
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    await new Promise(r => setTimeout(r, 400));
    if (typeof Store.idle === 'function') await Store.idle();
    return out;
  });
  note('O1', o1);
  check(o1.computed === '20', 'O1a the premise: the formula column reads 20 for INV-1 (Base 10 x 2)', o1.computed);
  check(o1.afterSet === '1000' && o1.setRes.applied === 1 && o1.setRes.reasons.join() === 'override',
    'O1b typing 1000 over the formula shows 1000, is reported APPLIED, and is reported as an override', o1);
  check(!!(o1.rec && o1.rec.k === 'override' && o1.rec.v === '1000' && o1.rec.prev === '20'
           && o1.rec.src === 'formula' && o1.rec.by && o1.rec.at),
    'O1c the record is k:\'override\' with v, prev (what the formula said then), src, by and at', o1.rec);
  check(o1.onRow === false,
    'O1d and NOTHING was written onto the row - an override is read at render time, so it never reaches the versioned CSV',
    o1.onRow);
  check(o1.afterRevert === '20' && o1.recAfterRevert === null && o1.revertRes.applied === 1,
    'O1e (THE GATE) revert: the formula value is BACK and the pk/column key is GONE from the store', o1);
  check(o1.emptyShows === '' && !!(o1.emptyRec && o1.emptyRec.k === 'override' && o1.emptyRec.v === ''),
    'O1f an EMPTY override is a deliberate blank, not a delete: the cell shows nothing and the record exists',
    { shows: o1.emptyShows, rec: o1.emptyRec });
  check(o1.afterEmptyRevert === '20' && o1.recAfterEmptyRevert === null,
    'O1g (THE GATE) and reverting an EMPTY override brings the computed value back - the case a '
    + 'value-based revert makes PERMANENT, because \'\' equals the empty override and no-ops', o1);
  const o1disk = diskJson(OV.root, 'reco/extraValueMaster.json');
  check(!((((o1disk || {}).TPL_OV || {})['INV-1'] || {}).Net),
    'O1h and the deletion reached the shared file - S13 merges the disk object UNDER memory, so without '
    + 'replaying the intent the record would come straight back', (o1disk || {}).TPL_OV);
  const o1csv = verFile(OV.root, ovIds.folder);
  const o1rows = csvRows(o1csv).filter(r => r._pk === 'INV-1');
  check(o1rows.length === 1 && o1rows[0]._ver === 'upload',
    'O1i DECISION I: no Cn version row was written for an override - a row byte-identical to its '
    + 'predecessor would tell a reader of the CSV that nothing happened while something did',
    o1rows.map(r => r._ver));

  /* ---------------------------------------------------------------------
     [13] O2 (THE GATE) — a duplicate key multiplies money into a journal
     entry, so the override is refused with the count in the message.
     --------------------------------------------------------------------- */
  section(13, 'O2 (THE GATE) — three rows share a key: REFUSED, and the entry posts 1000 + 30 + 0');
  const DUPR = makeRoot('share-dup');
  const bridgeDup = await startBridge(DUPR.root, PORT_DUP); procs.push(bridgeDup.proc);
  const dp = await openReco(browser, bridgeDup);
  await dp.page.evaluate(`(async function () {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_DUP'; t.name = 'Duplicate keys';
    t.columns = ['Invoice', 'Base', 'Reco', 'ToAccount']
      .map(n => ({ name: n, label: n, formats: [], isValue: n === 'Base' }));
    t.primaryKeys = ['Invoice'];
    t.valueColumn = 'Base';
    t.displayColumns = t.columns.map(c => c.name);
    t.additionalColumns = [
      { name: 'Net', type: 'formula', formula: 'NUM({Base})', allowOverride: true },
      { name: 'AED', type: 'formula', formula: 'NUM({Net})' }
    ];
    t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id,
      keywordColumn: '', keywordValues: '', postEntryColumn: '', postEntryValue: '' };
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_DUP');
    RecoTemplate.open(tpl.id);
    /* THREE AP LINES UNDER ONE INVOICE - PLAN.md's own example. A duplicate
       _pk is a TOLERATED state: ingestData only warns (the confirm is
       auto-accepted by this suite's dialog handler). */
    await Reco.ingestData(tpl, [
      { Invoice: 'INV-7', Base: '1000', Reco: 'R1', ToAccount: 'ACC1' },
      { Invoice: 'INV-7', Base: '30',   Reco: 'R1', ToAccount: 'ACC1' },
      { Invoice: 'INV-7', Base: '0',    Reco: 'R1', ToAccount: 'ACC1' }
    ], ['Invoice', 'Base', 'Reco', 'ToAccount']);
    App.closeModal();
    AppState.activeRecoId = 'TPL_DUP';
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    return true;
  })()`);

  const o2 = await dp.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_DUP');
    const sess = AppState.recoSessions.TPL_DUP;
    /* The journal, as the preview builds it: the AEG template aggregates by
       Reco + ToAccount, so these three rows are ONE line whose value is the
       sum of the AED column - and AED is NUM({Net}), so an override of Net
       reaches it. */
    const total = () => {
      App.closeModal();
      sess.selectedRows = {};
      sess.data.forEach(r => { sess.selectedRows[r._id] = true; });
      Reco.previewEntryFromSelection(false);
      const ctx = Reco._pendingEntry;
      if (!ctx) return { error: 'no preview' };
      const lc = Reco._jvLineCols(ctx.aegTpl);
      const val = l => { const v = l[lc.dr]; return U.num(v && typeof v === 'object' ? v.value : v); };
      const cre = l => { const v = l[lc.cr]; return U.num(v && typeof v === 'object' ? v.value : v); };
      const dr = (ctx.lines || []).reduce((s, l) => s + val(l), 0);
      const cr = (ctx.lines || []).reduce((s, l) => s + cre(l), 0);
      const inputs = (ctx.aegInputs || []).map(o => U.num(o[ctx.aegTpl.valueColumn]));
      const nets = (ctx.sourceRows || []).map(r => String(r.Net));
      App.closeModal();
      return { dr, cr, inputs, nets, sum: inputs.reduce((a, b) => a + b, 0), lines: (ctx.lines || []).length };
    };
    const out = { count: Reco._dupPkCountFor(tpl, sess, 'INV-7'), before: total() };
    const row2 = sess.data[1];                       // the 30 line
    const res = await Reco.applyEdits(tpl, sess, [{ row: row2, col: 'Net', value: '1000' }],
      { source: 'grid', trusted: true, schema: Reco._ovSchema(tpl, sess) });
    out.rejected = res.rejected.map(r => ({ reason: r.reason, message: r.message }));
    out.applied = res.applied;
    out.stored = Object.keys((AppState.extraValueMaster || {}).TPL_DUP || {});
    out.after = total();
    /* THE MONEY, DEMONSTRATED. This is what a build without the refusal
       writes - and what it then posts. Put in by hand, read through the real
       preview, and taken back out again, so the assertion above is about
       something. */
    AppState.extraValueMaster.TPL_DUP = { 'INV-7': { Net: { k: 'override', v: '1000', prev: '30',
      src: 'formula', ds: '', by: 'demo', at: new Date().toISOString() } } };
    out.broadcast = total();
    delete AppState.extraValueMaster.TPL_DUP;
    out.restored = total();
    return out;
  });
  note('O2', { count: o2.count, before: o2.before, after: o2.after, broadcast: o2.broadcast, rejected: o2.rejected });
  check(o2.count === 3, 'O2a the premise: three loaded rows share the key INV-7', o2.count);
  check(o2.before.sum === 1030 && o2.before.dr === 1030 && o2.before.cr === 1030 && o2.before.lines === 2,
    'O2b the premise: the journal preview over the three rows posts 1000 + 30 + 0 = 1030 (one aggregated Dr/Cr pair)',
    o2.before);
  check(o2.applied === 0 && o2.rejected.length === 1 && o2.rejected[0].reason === 'dupPk'
        && /\b3\b/.test(o2.rejected[0].message) && /3 of them/.test(o2.rejected[0].message),
    'O2c (THE GATE) the override is REFUSED, not applied, with the COUNT in the message', o2.rejected);
  check(o2.stored.length === 0, 'O2d and nothing at all was written to the store', o2.stored);
  check(o2.after.sum === 1030 && o2.after.dr === 1030,
    'O2e (THE GATE) so the entry still posts 1030', o2.after);
  check(o2.broadcast.sum === 3000 && o2.broadcast.nets.join() === '1000,1000,1000',
    'O2f AND THE MONEY BUG IS REAL: with the record in place all three rows read 1000 and the entry '
    + 'posts 3000 - which is what the refusal exists to stop', o2.broadcast);
  check(o2.restored.sum === 1030, 'O2g (control) removing the planted record puts the entry back to 1030', o2.restored);
  const o2err = dp.errors.filter(e => !/Could not save|injected fault/.test(e));
  check(o2err.length === 0, 'O2h no page error in the duplicate-key run', o2err.slice(0, 4));

  /* ---------------------------------------------------------------------
     [14] O3 — SEVEN SURFACES, ONE STRING. Read from each surface's own
     output, not from a shared helper: that is the only way this says
     anything about whether the screen and the journal agree.
     --------------------------------------------------------------------- */
  section(14, 'O3 — the grid, a report total, the CSV, the workbook, the Excel view, the AEG preview '
    + 'and a Special JV bucket all show the same string');
  const o3 = await ovp.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_OV');
    const sess = AppState.recoSessions.TPL_OV;
    const r2 = sess.data.find(r => r._pk === 'INV-2');     // Base 20 -> Net 40
    const r5 = sess.data.find(r => r._pk === 'INV-5');     // Base 50 -> Net 100
    /* INV-5 goes to a Special JV, so one overridden row is in a bucket and
       one is in the standard lines. */
    r5.ToAccount = 'TSTJV';
    SpecialJV.registry['TSTJV'] = { ref: 'TSTJV', displayName: 'Test JV' };
    SpecialJV.resetOptions();
    await Reco.setOverride(r2._id, 'Net', '777');
    await Reco.setOverride(r5._id, 'Net', '777');
    const out = {};

    // 1. THE GRID, from the DOM it actually drew.
    App.navigate('reco');
    const tr = document.querySelector('tbody tr[data-rid="' + CSS.escape(r2._id) + '"]');
    const td = tr && tr.querySelector('td[data-col="Net"]');
    const inp = td && td.querySelector('input');
    out.grid = inp ? inp.value : (td ? td.textContent.trim() : null);
    out.gridHasRevert = !!(td && td.querySelector('button.ov-revert'));
    out.gridAccent = !!(td && /ov-set/.test(td.className));

    // 2. A REPORT TOTAL, through Reco.runReport.
    const rpt = { name: 'R', columns: ['Invoice', 'Net'] };
    const rrows = Reco.runReport(tpl, sess, rpt);
    out.report = String((rrows.find(r => r.Invoice === 'INV-2') || {}).Net);
    out.reportTotal = rrows.reduce((s, r) => s + U.num(r.Net), 0);

    // 3. THE CSV EXPORT, from what the exporter wrote.
    window.__dl = [];
    const rd = U.download;
    U.download = function (name, text) { window.__dl.push({ name: name, text: String(text) }); };
    try { Reco.exportData('csv'); } finally { U.download = rd; }
    const csv = (window.__dl[0] || {}).text || '';
    const head = csv.split(/\r?\n/)[0].split(',');
    const line = csv.split(/\r?\n/).find(l => l.indexOf('INV-2') !== -1) || '';
    out.csv = (line.split(',')[head.indexOf('Net')] || '').replace(/"/g, '');

    // 4. THE REAL WORKBOOK EXPORT, from its typed cells.
    const xo = { rows: 'all', columns: 'asShown', includeComputed: true, protect: 'soft', dateFormat: 'dd-mmm-yyyy' };
    const built = await ExcelLink.buildExport(tpl, sess, xo, 'S');
    const ci = built.head.columns.findIndex(c => c.key === 'Net');
    const cell = (built.cells.find(l => l[1] === 'INV-2') || [])[ci];
    out.workbook = String(cell && typeof cell === 'object' ? cell.s : cell);
    out.workbookKind = (built.head.columns[ci] || {}).kind;

    // 6. THE AEG PREVIEW (the journal), and 7. A SPECIAL JV BUCKET.
    App.closeModal();
    sess.selectedRows = {};
    sess.data.forEach(r => { sess.selectedRows[r._id] = true; });
    Reco.previewEntryFromSelection(false);
    const ctx = Reco._pendingEntry;
    out.aegSourceRow = String((ctx.sourceRows.find(r => r._pk === 'INV-2') || {}).Net);
    out.aegInputTotal = (ctx.aegInputs || []).reduce((s, o) => s + U.num(o[ctx.aegTpl.valueColumn]), 0);
    const bucket = (ctx.jvBuckets || {})['TSTJV'] || [];
    out.jvBucketRows = bucket.length;
    out.jvBucket = String((bucket[0] || {}).Net);
    App.closeModal();
    return out;
  });
  note('O3', o3);
  check(o3.grid === '777' && o3.gridAccent && o3.gridHasRevert,
    'O3a THE GRID shows 777 in an input, with the accent and the revert control', o3);
  check(o3.report === '777' && o3.reportTotal === 20 + 777 + 60 + 80 + 777 + 120,
    'O3b A REPORT TOTAL counts 777 (and only for the two overridden rows)', { cell: o3.report, total: o3.reportTotal });
  check(o3.csv === '777', 'O3c THE CSV EXPORT writes 777', o3.csv);
  check(o3.workbook === '777', 'O3d THE REAL WORKBOOK EXPORT writes 777, as a typed cell', { cell: o3.workbook, kind: o3.workbookKind });
  check(o3.aegSourceRow === '777',
    'O3e THE AEG SOURCE ROW carries 777 - the journal loop reads the store through its own copy of the '
    + 'same gate, so the screen and the entry cannot disagree', o3.aegSourceRow);
  check(o3.aegInputTotal === 20 + 777 + 60 + 80 + 120,
    'O3f and the journal inputs add up with it (INV-5 is in a Special JV bucket, not in the standard lines)',
    o3.aegInputTotal);
  check(o3.jvBucketRows === 1 && o3.jvBucket === '777',
    'O3g A SPECIAL JV BUCKET carries 777 for the row that targets it', { rows: o3.jvBucketRows, net: o3.jvBucket });

  /* The Excel view is the seventh surface and needs the real worksheet. */
  await ovp.page.evaluate(() => { AppState.activeSubSection = 'excel'; window.__prevWs = Reco._xlWorksheet || null; RecoTemplate.open('TPL_OV'); });
  await ovp.page.waitForFunction(() => Reco._xlCtx && Reco._xlCtx.ws && Reco._xlCtx.tplId === 'TPL_OV'
    && document.querySelector('#excelViewHost .jss_worksheet'), null, { timeout: 15000 });
  await sleep(100);
  const o3x = await ovp.page.evaluate(() => {
    const C = Reco._xlCtx;
    const x = (C.ws.options.columns || []).findIndex(c => c && c.name === 'Net');
    const y = C.ws.options.data.findIndex(r => String(r[C.ridX]) === String((C.sess.data.find(z => z._pk === 'INV-2') || {})._id));
    const d = C.S.byName.get('Net');
    return { x: x, y: y, cell: x >= 0 && y >= 0 ? String(C.ws.options.data[y][x]) : null,
             readOnly: !!(C.ws.options.columns[x] || {}).readOnly, type: (C.ws.options.columns[x] || {}).type,
             editable: !!(d && d.editable), writeTo: d && d.writeTo, kind: d && d.kind };
  });
  note('O3 Excel view', o3x);
  check(o3x.cell === '777' && o3x.readOnly === false,
    'O3h THE IN-APP EXCEL VIEW shows 777, in a cell that is NOT read-only (an overridable column is an input)', o3x);

  /* ---------------------------------------------------------------------
     [15] O4 — the master-lookup arm: it works, it is listed DISTINCTLY from
     a formula override, and it is refused on a posted row with the
     accounting reference named.
     --------------------------------------------------------------------- */
  section(15, 'O4 — a master_lookup override, listed distinctly, and refused on a posted row');
  const o4 = await ovp.page.evaluate(async () => {
    AppState.activeSubSection = 'reco';
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_OV');
    const sess = AppState.recoSessions.TPL_OV;
    const r4 = sess.data.find(r => r._pk === 'INV-4');
    const out = { lookupBefore: String(Reco.rowFull(tpl, sess, r4).Acct) };
    await Reco.setOverride(r4._id, 'Acct', '99999');
    out.lookupAfter = String(Reco.rowFull(tpl, sess, r4).Acct);
    const rec = Reco._extraRec(tpl, sess, r4, 'Acct');
    out.rec = rec ? JSON.parse(JSON.stringify(rec)) : null;
    /* THE PANEL. Both kinds are in it, and they are told apart by `src`. */
    const list = Reco._overrideList(tpl, sess).map(it => ({ pk: it.pk, col: it.col, src: it.rec.src,
      v: it.rec.v, prev: it.rec.prev, by: it.rec.by, inData: it.inData, now: it.now }));
    out.list = list;
    Reco.openOverridesModal();
    const body = document.getElementById('appModalBody');
    out.panelHtml = body ? body.innerHTML : '';
    out.panelTitle = (document.getElementById('appModalTitle') || {}).textContent || '';
    App.closeModal();

    /* A POSTED ROW. This is exactly what commitEntryFromPreview leaves
       behind: the post-entry column stamped on the row, and an entry in the
       history whose postedPks carry the key. */
    const r6 = sess.data.find(r => r._pk === 'INV-6');
    r6.Status = 'Posted';
    AppState.entryHistory.TPL_OV = [{ accountingId: 'AEG-OV-1', createdAt: new Date().toISOString(),
      createdBy: 'tester', postedPks: ['INV-6'], sourceRowIds: [r6._id], specialJvs: [] }];
    Reco._postedIdxReset();
    out.posted = Reco.isRowPosted(tpl, sess, r6);
    const res = await Reco.applyEdits(tpl, sess, [{ row: r6, col: 'Acct', value: '11111' }],
      { source: 'grid', trusted: true, schema: Reco._ovSchema(tpl, sess) });
    out.refusal = res.rejected.map(r => ({ reason: r.reason, message: r.message }));
    out.applied = res.applied;
    out.rec6 = !!(((AppState.extraValueMaster.TPL_OV || {})['INV-6'] || {}).Acct);
    /* And the grid says so before anyone types: the cell is locked, with the
       same reason. */
    App.navigate('reco');
    const tr = document.querySelector('tbody tr[data-rid="' + CSS.escape(r6._id) + '"]');
    const td = tr && tr.querySelector('td[data-col="Acct"]');
    out.lockedTitle = td ? (td.getAttribute('title') || '') : null;
    out.lockedHasInput = !!(td && td.querySelector('input'));
    /* S11, THE ROLE MATRIX: #26 adds a CALL, never a second gate. Asked in
       both directions, on a CLONE of the template (which is what the editor
       holds), so nothing here changes the live one. renderEditor is stubbed
       only to keep this out of the editor's DOM - it is asserted to have been
       called, because a box that stays ticked after a refusal reads as a
       saved setting. */
    RecoTemplate._editing = JSON.parse(JSON.stringify(tpl));
    RecoTemplate._openedWith = JSON.parse(JSON.stringify(tpl));
    out.s11 = RecoTemplate._exclusiveRoleConflict(RecoTemplate._editing, 'Status', 'allowOverride');
    out.s11Pk = RecoTemplate._exclusiveRoleConflict(RecoTemplate._editing, 'Invoice', 'allowOverride');
    const iNet = RecoTemplate._editing.additionalColumns.findIndex(a => a.name === 'Net');
    const iAed = RecoTemplate._editing.additionalColumns.findIndex(a => a.name === 'AED');
    out.boxHtml = RecoTemplate._overrideBox(RecoTemplate._editing, RecoTemplate._editing.additionalColumns[iNet], iNet);
    /* The same box on a template with NO primary keys: the reason renders
       beside it rather than greying it out, because the Primary Key block is
       emitted BEFORE this editor and ticking a key there does not redraw it. */
    out.boxNoKeys = RecoTemplate._overrideBox({ primaryKeys: [], additionalColumns: [] }, { name: 'X', type: 'formula' }, 0);
    const re = RecoTemplate.renderEditor;
    out.rendered = 0;
    RecoTemplate.renderEditor = function () { out.rendered++; };
    try {
      /* 'AED' is an INPUT COLUMN of the linked AEG template, so S11 must
         refuse it: the AEG extras loop runs BEFORE the keyword filter, so a
         value read there can decide whether a row posts at all, and an input
         column matched by name sets an account code. */
      RecoTemplate.toggleOverride(iAed, true);
      out.aedAllowed = !!RecoTemplate._editing.additionalColumns[iAed].allowOverride;
      out.aedToast = (((window.__toasts || []).slice(-1)[0]) || {}).msg || '';
      RecoTemplate.toggleOverride(iNet, false);
      out.netOff = !RecoTemplate._editing.additionalColumns[iNet].allowOverride;
      RecoTemplate.toggleOverride(iNet, true);
      out.netOn = !!RecoTemplate._editing.additionalColumns[iNet].allowOverride;
    } finally { RecoTemplate.renderEditor = re; }
    out.liveUntouched = !!(AppState.recoTemplates.find(x => x.id === 'TPL_OV')
      .additionalColumns.find(a => a.name === 'Net') || {}).allowOverride;
    App.navigate('reco');
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    return out;
  });
  note('O4', { before: o4.lookupBefore, after: o4.lookupAfter, rec: o4.rec, refusal: o4.refusal, list: o4.list });
  check(o4.lookupBefore === '12345' && o4.lookupAfter === '99999',
    'O4a a MASTER_LOOKUP override works: the row stops following the shared master', o4);
  check(!!(o4.rec && o4.rec.src === 'lookup' && o4.rec.prev === '12345' && o4.rec.k === 'override'),
    'O4b and its record says src:\'lookup\' with the master\'s own answer as `prev`', o4.rec);
  const o4f = o4.list.find(x => x.col === 'Net'), o4l = o4.list.find(x => x.col === 'Acct');
  check(!!(o4f && o4f.src === 'formula' && o4l && o4l.src === 'lookup'),
    'O4c the Overrides list carries both, told apart by src', o4.list);
  check(/master lookup/.test(o4.panelHtml) && /formula/.test(o4.panelHtml)
        && /Revert/.test(o4.panelHtml) && /INV-4/.test(o4.panelHtml),
    'O4d and the panel renders a LOOKUP override VISIBLY DISTINCT from a formula one, with Revert',
    o4.panelHtml.slice(0, 400));
  check(o4.posted === true && o4.applied === 0 && o4.refusal.length === 1
        && o4.refusal[0].reason === 'posted' && /AEG-OV-1/.test(o4.refusal[0].message),
    'O4e (the user\'s own decision) an override is REFUSED on a row already posted to the general '
    + 'ledger, NAMING the accounting reference', o4.refusal);
  check(o4.rec6 === false, 'O4f and nothing was stored for the posted row', o4.rec6);
  check(!o4.lockedHasInput && /already posted/.test(o4.lockedTitle || '') && /AEG-OV-1/.test(o4.lockedTitle || ''),
    'O4g and the grid LOCKS that cell with the same reason, so nobody types into it first', o4.lockedTitle);
  check(!!o4.s11 && /post-entry/.test(o4.s11) && !!o4.s11Pk,
    'O4h S11 refuses the post-entry column and a key column as overridable - one matrix, asked, not a second gate',
    { postEntry: o4.s11, pk: o4.s11Pk });
  check(o4.aedAllowed === false && /AEG/.test(o4.aedToast) && o4.rendered >= 1,
    'O4i and the CHECKBOX asks it: ticking an AEG input column is refused, the box is put back, and the '
    + 'toast names what it protected', { allowed: o4.aedAllowed, toast: o4.aedToast, rendered: o4.rendered });
  check(o4.netOff === true && o4.netOn === true && o4.liveUntouched === true,
    'O4j the flag goes off and on again on the editor\'s own clone, leaving the live template alone until save',
    { off: o4.netOff, on: o4.netOn, live: o4.liveUntouched });
  check(/Allow manual override per row/.test(o4.boxHtml) && /checkbox/.test(o4.boxHtml)
        && /Manual Overrides/.test(o4.boxHtml) && /Needs primary keys/.test(o4.boxNoKeys),
    'O4k the template editor offers the flag on a computed column with what it means, and says why it '
    + 'cannot be used on a template with no primary keys', o4.boxHtml.slice(0, 200));

  /* ---------------------------------------------------------------------
     [16] O5 — DECISION J.4: the Excel view's undo must not latch an override.
     --------------------------------------------------------------------- */
  section(16, 'O5 — DECISION J.4: Ctrl+Z after typing an override CLEARS it, it does not latch the computed value');
  await ovp.page.evaluate(() => {
    AppState.activeSubSection = 'excel';
    window.__prevWs = Reco._xlWorksheet || null;
    RecoTemplate.open('TPL_OV');
  });
  await ovp.page.waitForFunction(() => Reco._xlCtx && Reco._xlCtx.ws && Reco._xlCtx.tplId === 'TPL_OV'
    && document.querySelector('#excelViewHost .jss_worksheet'), null, { timeout: 15000 });
  await sleep(120);
  const xy = await ovp.page.evaluate(() => {
    const C = Reco._xlCtx;
    const x = (C.ws.options.columns || []).findIndex(c => c && c.name === 'Net');
    const rid = (C.sess.data.find(z => z._pk === 'INV-3') || {})._id;
    const y = C.ws.options.data.findIndex(r => String(r[C.ridX]) === String(rid));
    return { x: x, y: y, computed: String(C.ws.options.data[y][x]) };
  });
  check(xy.x >= 0 && xy.y >= 0 && xy.computed === '60',
    'O5a the premise: INV-3\'s Net cell is in the sheet and reads the computed 60', xy);
  const cellSel = `#excelViewHost td[data-x="${xy.x}"][data-y="${xy.y}"]`;
  await ovp.page.click(cellSel);
  await ovp.page.keyboard.type('250', { delay: 15 });
  await ovp.page.keyboard.press('Enter');
  await sleep(250);
  const afterType = await ovp.page.evaluate(REC + `(['TPL_OV','INV-3','Net'])`);
  const sheetAfterType = await ovp.page.evaluate((a) => String(Reco._xlCtx.ws.options.data[a.y][a.x]), xy);
  check(!!(afterType && afterType.k === 'override' && String(afterType.v) === '250' && afterType.prev === '60'),
    'O5b typing 250 in the Excel view stores an override of 250 over the computed 60', afterType);
  check(sheetAfterType === '250', 'O5c and the sheet shows it', sheetAfterType);
  await ovp.page.keyboard.press('Control+z');
  await sleep(350);
  const afterUndo = await ovp.page.evaluate(REC + `(['TPL_OV','INV-3','Net'])`);
  const sheetAfterUndo = await ovp.page.evaluate((a) => ({
    sheet: String(Reco._xlCtx.ws.options.data[a.y][a.x]),
    enriched: String(Reco.rowFull(Reco._xlCtx.tpl, Reco._xlCtx.sess,
      Reco._xlCtx.sess.data.find(z => z._pk === 'INV-3')).Net)
  }), xy);
  check(afterUndo === null,
    'O5d (DECISION J.4) Ctrl+Z CLEARS the override - the store key is GONE. Recording `before` as the '
    + 'computed value and replaying it as a VALUE stored {v:\'60\', prev:\'250\'}: the cell LOOKED right '
    + 'and was frozen at 60 in the grid, the reports, the CSV and any posted JV', afterUndo);
  check(sheetAfterUndo.sheet === '60' && sheetAfterUndo.enriched === '60',
    'O5e and both the sheet and the enriched row are computing again', sheetAfterUndo);

  /* ---------------------------------------------------------------------
     [17] O6 — DECISION J.7: canonicalise on write, keep the keystroke.
     --------------------------------------------------------------------- */
  section(17, 'O6 — DECISION J.7: 1,234.50 and (500) are canonicalised, {Net}*2 does not say #ERR');
  const o6 = await ovp.page.evaluate(async () => {
    AppState.activeSubSection = 'reco';
    App.navigate('reco');
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_OV');
    const sess = AppState.recoSessions.TPL_OV;
    const row = sess.data.find(r => r._pk === 'INV-1');
    const out = {};
    const read = () => {
      const full = Reco.rowFull(tpl, sess, row);
      return { net: String(full.Net), twice: String(full.Twice) };
    };
    await Reco.setOverride(row._id, 'Net', '1,234.50');
    out.comma = read();
    out.commaRec = JSON.parse(JSON.stringify(Reco._extraRec(tpl, sess, row, 'Net')));
    await Reco.setOverride(row._id, 'Net', '(500)');
    out.paren = read();
    out.parenRec = JSON.parse(JSON.stringify(Reco._extraRec(tpl, sess, row, 'Net')));
    /* AND SOMETHING THAT IS NOT A NUMBER AT ALL is stored VERBATIM - never
       put through U.num, which would read it as 0. A silent zero in a column
       that feeds a journal entry is the class of bug this canonicalisation
       exists to prevent; refusing it instead would make decision J.8
       unreachable, because a formula column's kind is DERIVED from its values
       and J.8 is about an override that changes it. Stored verbatim, the
       dependent formula says #ERR, which is loud. */
    const res = await Reco.applyEdits(tpl, sess, [{ row: row, col: 'Net', value: 'see note' }],
      { source: 'grid', trusted: true, schema: Reco._ovSchema(tpl, sess) });
    out.textApplied = res.applied;
    out.textRejected = res.rejected.map(r => r.reason);
    out.textRec = JSON.parse(JSON.stringify(Reco._extraRec(tpl, sess, row, 'Net')));
    out.text = read();
    await Reco.revertOverride(row._id, 'Net');
    out.reverted = read();
    return out;
  });
  note('O6', o6);
  check(o6.comma.net === '1234.5' && o6.commaRec.v === '1234.5' && o6.commaRec.typed === '1,234.50',
    'O6a "1,234.50" is stored canonical (1234.5) with the RAW KEYSTROKE kept in `typed`', o6);
  check(o6.comma.twice === '2469',
    'O6b and a dependent formula {Net}*2 computes - stored verbatim it gave #ERR, because '
    + 'Formula._tokenValue rejects a comma while U.num reads 1234.5: one override reading two ways on two surfaces',
    o6.comma);
  check(o6.paren.net === '-500' && o6.parenRec.v === '-500' && o6.parenRec.typed === '(500)'
        && o6.paren.twice === '-1000',
    'O6c "(500)" - the accounting negative - is stored as -500 and {Net}*2 is -1000', o6);
  check(o6.textApplied === 1 && o6.textRejected.length === 0 && o6.textRec.v === 'see note'
        && !('typed' in o6.textRec) && o6.text.net === 'see note',
    'O6d a NON-NUMERIC override is stored VERBATIM, never through U.num - which would have read it as 0, '
    + 'a silent zero in a column that feeds a journal entry', o6.textRec);
  check(o6.text.twice === '#ERR',
    'O6e and the dependent formula says #ERR, which is loud: the honest answer to multiplying something '
    + 'that is not a number (and decision J.8 then makes the whole column export as text)', o6.text);
  check(o6.reverted.net === '20' && o6.reverted.twice === '40',
    'O6f and the revert brings both the column and everything derived from it back', o6.reverted);

  /* ---------------------------------------------------------------------
     [18] O7 / O8 — DECISION J.8 and J.9, on a 200,000-row session.
     WRITTEN TWICE: the override inside the 2,000-row sample, and at row
     50,000 where the scan never reaches.
     --------------------------------------------------------------------- */
  section(18, 'O7 (written twice) — the exported KIND does not depend on WHERE the override is; '
    + 'O8 — the overridable column is IN the workbook');
  const BIGO = makeRoot('share-bigov');
  const bridgeBigO = await startBridge(BIGO.root, PORT_BIGO); procs.push(bridgeBigO.proc);
  const bo = await openReco(browser, bridgeBigO);
  /* sess.data is assigned DIRECTLY, as run_colorder_e2e's 200k fixture does:
     200,000 rows through ingestData would be a minute of upload for a
     question about the SCHEMA. Such rows carry no _dsi, which is a real case
     (decision M) and is irrelevant here: an override is always key-scoped. */
  const bigIds = await bo.page.evaluate(`(function () {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_BIG'; t.name = 'Big overrides';
    t.columns = ['Invoice', 'Base'].map(n => ({ name: n, label: n, formats: [], isValue: n === 'Base' }));
    t.primaryKeys = ['Invoice'];
    t.valueColumn = 'Base';
    t.displayColumns = ['Invoice', 'Base'];
    t.additionalColumns = [
      { name: 'Net', type: 'formula', formula: 'NUM({Base})*2', allowOverride: true },
      { name: 'Plain', type: 'formula', formula: 'NUM({Base})' }
    ];
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_BIG');
    RecoTemplate.open(tpl.id);
    const sess = AppState.recoSessions.TPL_BIG;
    Reco.ensureSessionShape(sess);
    const n = 200000;
    const data = new Array(n);
    for (let i = 0; i < n; i++) data[i] = { _id: 'b' + i, _pk: 'K' + i, _ver: 'upload', Invoice: 'K' + i, Base: String(i + 1) };
    sess.data = data;
    sess._autoLoadAttempted = true;
    AppState.activeRecoId = 'TPL_BIG';
    return { rows: sess.data.length, folder: tpl.dataFolder };
  })()`);
  note('200k fixture', bigIds);

  const kindOf = async (idx) => bo.page.evaluate(async (idx) => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_BIG');
    const sess = AppState.recoSessions.TPL_BIG;
    const row = sess.data[idx];
    /* A NON-NUMERIC override is the case decision J.8 is about: the column
       stays kind:'value' if the scan cannot see the override, and the export
       then writes one forced-TEXT cell inside a numeric column, where Excel's
       SUM silently excludes it and the load-back diff is quiet because the
       baseline recorded the same text. */
    await Reco.setOverride(row._id, 'Net', 'see note');
    const S = XlSchema.build(tpl, sess, { scope: 'template', showExtras: 'all' });
    const d = S.byName.get('Net');
    sess.selectedRows = {}; sess.selectedRows[row._id] = true;
    const xo = { rows: 'selected', columns: 'asShown', includeComputed: true, protect: 'soft', dateFormat: 'dd-mmm-yyyy' };
    const built = await ExcelLink.buildExport(tpl, sess, xo, 'S');
    const ci = built.head.columns.findIndex(c => c.key === 'Net');
    const cell = (built.cells[0] || [])[ci];
    const out = { idx: idx, pk: row._pk, kind: d.kind, isValue: !!d.isValue,
                  manifestKind: (built.head.columns[ci] || {}).kind,
                  cellType: (cell && typeof cell === 'object') ? 'forcedText' : typeof cell,
                  cell: (cell && typeof cell === 'object') ? cell.s : cell };
    await Reco.revertOverride(row._id, 'Net');
    sess.selectedRows = {};
    return out;
  }, idx);

  const o7a = await kindOf(9);          // row 10 — inside the 2,000-row sample
  const o7b = await kindOf(49999);      // row 50,000 — the scan never gets there
  note('O7 inside the sample', o7a);
  note('O7 at row 50,000', o7b);
  check(o7a.kind === 'text' && o7a.cellType === 'string',
    'O7a an override INSIDE the sample turns the column to text, and the cell exports as text', o7a);
  check(o7b.kind === 'text' && o7b.cellType === 'string',
    'O7b (DECISION J.8) AND SO DOES ONE AT ROW 50,000 - the scan stops at 2,000 rows, so the sparse '
    + 'store is walked instead of more rows', o7b);
  check(o7a.kind === o7b.kind && o7a.manifestKind === o7b.manifestKind && o7a.cellType === o7b.cellType,
    'O7c (THE POINT) the exported KIND does not depend on WHERE in the file the override is',
    { inside: o7a, far: o7b });

  const o8 = await bo.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_BIG');
    const sess = AppState.recoSessions.TPL_BIG;
    sess.selectedRows = {}; sess.selectedRows[sess.data[0]._id] = true;
    /* includeComputed FALSE is the setting that used to drop it: the in-app
       view filters on showExtras/computed and this filters on
       `role !== 'computed'`, so the user was shown an editable input and
       handed a workbook without the column. */
    const xo = { rows: 'selected', columns: 'asShown', includeComputed: false, protect: 'soft', dateFormat: 'dd-mmm-yyyy' };
    const built = await ExcelLink.buildExport(tpl, sess, xo, 'S');
    const keys = built.head.columns.map(c => c.key);
    const S = XlSchema.build(tpl, sess, { scope: 'template', showExtras: 'inputs' });
    sess.selectedRows = {};
    return { keys: keys, inputsView: S.cols.map(d => d.name),
             editable: !!(S.byName.get('Net') || {}).editable, writeTo: (S.byName.get('Net') || {}).writeTo };
  });
  note('O8', o8);
  check(o8.keys.indexOf('Net') !== -1 && o8.keys.indexOf('Plain') === -1,
    'O8 (DECISION J.9) the OVERRIDABLE column is in the workbook even with "include computed columns" off, '
    + 'and a plain computed column still is not', o8.keys);
  check(o8.inputsView.indexOf('Net') !== -1 && o8.inputsView.indexOf('Plain') === -1 && o8.editable
        && o8.writeTo === 'override',
    'O8b and "inputs only" keeps it too, as an editable column that writes to the override store', o8);

  /* ---------------------------------------------------------------------
     [19] O9 — DECISION J.5: wall clock PER OVERRIDE at 200k rows, best of 3
     taking the minimum, and NO recoSessions.json write for an override-only
     edit.
     --------------------------------------------------------------------- */
  section(19, 'O9 — DECISION J.5: wall clock per override at 200,000 rows, and no session write');
  const o9runs = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    /* SETTLE FIRST, THEN RESET THE LOG. Anything an earlier section still
       owed - a selection cleared, a debounced write - would otherwise be
       counted as this attempt's session write, and O9b is the assertion that
       there is none. */
    await bo.page.evaluate(async () => {
      await AppState.flush(); await Store.idle();
      await new Promise(r => setTimeout(r, 300)); await Store.idle();
    });
    await resetLog(bridgeBigO);
    const r = await bo.page.evaluate(async (attempt) => {
      const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_BIG');
      const sess = AppState.recoSessions.TPL_BIG;
      const t0 = performance.now();
      for (let i = 0; i < 30; i++) await Reco.setOverride(sess.data[i]._id, 'Net', String(1000 + attempt * 100 + i));
      const t1 = performance.now();
      await AppState.flush(); await Store.idle();
      await new Promise(r => setTimeout(r, 450)); await Store.idle();
      /* The same thirty, routed with NO schema in opts - which is what the
         grid did before decision J.5 and what re-runs XlSchema.build, and its
         2,000-row numeric-kind scan per formula extra, per keystroke-blur. */
      const t2 = performance.now();
      for (let i = 0; i < 30; i++)
        await Reco.applyEdits(tpl, sess, [{ row: sess.data[i], col: 'Net', value: String(2000 + attempt * 100 + i) }],
          { source: 'grid', trusted: true });
      const t3 = performance.now();
      await AppState.flush(); await Store.idle();
      await new Promise(r => setTimeout(r, 450)); await Store.idle();
      return { cached: Math.round(t1 - t0), uncached: Math.round(t3 - t2),
               stored: Object.keys((AppState.extraValueMaster.TPL_BIG || {})).length };
    }, attempt);
    const log = await callLog(bridgeBigO);
    o9runs.push({ attempt: attempt, cached: r.cached, uncached: r.uncached, stored: r.stored,
                  sessWrites: writesOf(log, 'reco/recoSessions.json'),
                  storeWrites: writesOf(log, 'reco/extraValueMaster.json') });
  }
  o9runs.forEach(r => note('run ' + r.attempt, r));
  const bestCached = Math.min(...o9runs.map(r => r.cached));
  const bestUncached = Math.min(...o9runs.map(r => r.uncached));
  console.log('    · BEST OF 3 (minimum) at 200,000 rows: ' + bestCached + ' ms for 30 overrides = '
    + (bestCached / 30).toFixed(1) + ' ms EACH   (same 30 with no cached schema: ' + bestUncached
    + ' ms = ' + (bestUncached / 30).toFixed(1) + ' ms each)');
  check(bestCached / 30 < 50,
    'O9a WALL CLOCK PER OVERRIDE at 200,000 rows is under 50 ms with the cached schema the grid handlers '
    + 'pass (measured ' + (bestCached / 30).toFixed(1) + ' ms)', { cached: bestCached, uncached: bestUncached });
  check(o9runs.every(r => r.sessWrites === 0),
    'O9b (DECISION J.5) NO recoSessions.json write for an override-only edit: AppState.save() serialises '
    + 'every persist key (798-1378 ms / 85.6 MiB at 200k) to discover nothing changed',
    o9runs.map(r => r.sessWrites));
  check(o9runs.every(r => r.storeWrites >= 1 && r.storeWrites <= 4),
    'O9c and the 60 overrides of each run reach the shared file in a handful of debounced writes, not 60',
    o9runs.map(r => r.storeWrites));
  check(bestUncached >= bestCached,
    'O9d (the comparison this bound means something against) the same thirty with no cached schema are '
    + 'not faster', { cached: bestCached, uncached: bestUncached });
  const o9err = bo.errors.filter(e => !/Could not save|injected fault/.test(e));
  check(o9err.length === 0, 'O9e no page error at 200,000 rows', o9err.slice(0, 4));
  await bo.ctx.close();

  /* ---------------------------------------------------------------------
     [20] O10 — the locked cell's voice; O11 — both backup pairs.
     --------------------------------------------------------------------- */
  section(20, 'O10 — the locked computed cell has a VOICE; O11 — an override survives both backup pairs');
  const o10 = await ovp.page.evaluate(() => {
    AppState.activeSubSection = 'reco';
    App.navigate('reco');
    const sess = AppState.recoSessions.TPL_OV;
    const row = sess.data.find(r => r._pk === 'INV-1');
    const tr = document.querySelector('tbody tr[data-rid="' + CSS.escape(row._id) + '"]');
    const plain = tr && tr.querySelector('td[data-col="Twice"]');     // computed, NOT overridable
    const over  = tr && tr.querySelector('td[data-col="Net"]');       // overridable
    const th = document.querySelector('thead th[data-col="Net"] .ov-count');
    return {
      title: plain ? (plain.getAttribute('title') || '') : null,
      style: plain ? (plain.getAttribute('style') || '') : null,
      hasInput: !!(plain && plain.querySelector('input')),
      overHasInput: !!(over && over.querySelector('input')),
      thBadge: th ? th.textContent : null,
      thTitle: th ? (th.getAttribute('title') || '') : null
    };
  });
  note('O10', o10);
  check(!o10.hasInput && /Allow manual override per row/.test(o10.title || '')
        && /Additional Columns/.test(o10.title || ''),
    'O10 (the discoverability answer) a computed cell nobody ticked the box for carries the title that '
    + 'says how to turn typing on - every template that exists today lands here, and the cell had NO '
    + 'title at all', o10.title);
  check(/cursor:not-allowed/.test(o10.style || ''), 'O10b and the cursor says so too', o10.style);
  check(o10.overHasInput, 'O10c while the overridable column on the same row is an input', o10);
  check(/^↺ \d+$/.test(o10.thBadge || '') && /some keys may not be in the loaded data/.test(o10.thTitle || ''),
    'O10d the column header carries an HONEST map-key count, and the tooltip says what it counts',
    { badge: o10.thBadge, title: o10.thTitle });

  const o11 = await ovp.page.evaluate(async () => {
    const out = {};
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_OV');
    const sess = AppState.recoSessions.TPL_OV;
    const row = sess.data.find(r => r._pk === 'INV-2');
    window.__dl = [];
    const rd = U.download;
    U.download = function (name, text) { window.__dl.push({ name: name, text: String(text) }); };
    try { Reco.backupSession(); App.exportBackup(); } finally { U.download = rd; }
    const files = window.__dl.map(d => ({ name: d.name, obj: JSON.parse(d.text) }));
    const one = files.find(f => /reco_session_/.test(f.name));
    const all = files.find(f => /reco_suite_backup_/.test(f.name));
    out.sessionBackup = (((one || {}).obj || {}).extraValueMaster || {})['INV-2'] || null;
    out.suiteBackup = ((((all || {}).obj || {}).extraValueMaster || {}).TPL_OV || {})['INV-2'] || null;

    const realConfirm = window.confirm;
    window.confirm = (m) => { out.confirmText = String(m); return true; };
    try {
      AppState.extraValueMaster = {};
      await Store.mergeWrite('extraValueMaster', m => { delete m.TPL_OV; }, { depth: 2 });
      await Store.idle();
      out.wiped = String(Reco.rowFull(tpl, sess, row).Net);
      const file = new File([JSON.stringify((one || {}).obj)], 'b.json', { type: 'application/json' });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.createElement('input'); input.type = 'file'; input.files = dt.files;
      Reco.restoreSession({ target: input });
      for (let i = 0; i < 80 && !Object.keys(AppState.extraValueMaster || {}).length; i++)
        await new Promise(r => setTimeout(r, 25));
      await AppState.flush(); await Store.idle();
    } finally { window.confirm = realConfirm; }
    const back = AppState.recoSessions.TPL_OV.data.find(r => r._pk === 'INV-2');
    out.restored = String(Reco.rowFull(tpl, AppState.recoSessions.TPL_OV, back).Net);
    out.restoredRec = (((AppState.extraValueMaster.TPL_OV || {})['INV-2'] || {}).Net) || null;
    return out;
  });
  note('O11', { session: o11.sessionBackup, suite: o11.suiteBackup, wiped: o11.wiped, restored: o11.restored });
  check(!!(o11.sessionBackup && o11.sessionBackup.Net && o11.sessionBackup.Net.k === 'override'
           && o11.sessionBackup.Net.v === '777'),
    'O11a Reco.backupSession() carries the OVERRIDE record (it exists nowhere else: no mirror on sess, no Cn row)',
    o11.sessionBackup);
  check(!!(o11.suiteBackup && o11.suiteBackup.Net && o11.suiteBackup.Net.v === '777'),
    'O11b App.exportBackup() carries it too', o11.suiteBackup);
  check(o11.wiped === '40' && o11.restored === '777'
        && !!(o11.restoredRec && o11.restoredRec.k === 'override'),
    'O11c and a restore brings it back - the cell computed 40 while it was gone, and reads 777 again',
    { wiped: o11.wiped, restored: o11.restored });
  check(/typed values of added columns/i.test(o11.confirmText || ''),
    'O11d restoreSession\'s confirm NAMES the values it replaces', o11.confirmText);

  /* ---------------------------------------------------------------------
     [21] S12 — ONE answer to "is this number in the general ledger".
     THE REPRODUCTION: a post-entry column that is an added `custom` column,
     whose value is in the pk-keyed store and NOT on the row.
     --------------------------------------------------------------------- */
  section(21, 'S12 — the two implementations of "is this posted" are now one function');
  const s12 = await ovp.page.evaluate(async () => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_S12'; t.name = 'Posted through the store';
    t.columns = ['Invoice', 'Base'].map(n => ({ name: n, label: n, formats: [], isValue: n === 'Base' }));
    t.primaryKeys = ['Invoice'];
    t.valueColumn = 'Base';
    t.displayColumns = ['Invoice', 'Base'];
    t.additionalColumns = [{ name: 'Workflow', type: 'custom' }];
    t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id, keywordColumn: '',
      keywordValues: '', postEntryColumn: 'Workflow', postEntryValue: 'Posted' };
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_S12');
    RecoTemplate.open(tpl.id);
    await Reco.ingestData(tpl, [{ Invoice: 'S1', Base: '10' }, { Invoice: 'S2', Base: '20' }], ['Invoice', 'Base']);
    App.closeModal();
    AppState.activeRecoId = 'TPL_S12';
    const sess = AppState.recoSessions.TPL_S12;
    const row = sess.data.find(r => r._pk === 'S1');
    /* Typed by a person into their own column: the tag branch writes the
       pk-keyed record and DELETES any row property, so the value is only in
       the store - which is exactly the state a reload leaves behind now that
       a typed value survives one. */
    await Reco.applyEdits(tpl, sess, [{ row: row, col: 'Workflow', value: 'Posted' }],
      { source: 'grid', trusted: true });
    const full = Reco.rowFull(tpl, sess, row);
    const out = {
      onRow: Object.prototype.hasOwnProperty.call(row, 'Workflow'),
      inStore: !!(((AppState.extraValueMaster.TPL_S12 || {}).S1 || {}).Workflow),
      enriched: String(full.Workflow),
      isRowPosted: Reco.isRowPosted(tpl, sess, row),
      excelLink: ExcelLink._isPosted(tpl, full, sess),
      legacyArity: Reco.isRowPosted(tpl, row),
      other: Reco.isRowPosted(tpl, sess, sess.data.find(r => r._pk === 'S2')),
      audit: Reco.postedJvAudit(tpl, sess, { countsOnly: true }),
      badge: Reco._postedBadge(tpl, sess, row)
    };
    const a = Reco.postedJvAudit(tpl, sess);
    out.exceptionValue = (a.exceptions[0] || {}).value;
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    return out;
  });
  note('S12', s12);
  check(s12.onRow === false && s12.inStore && s12.enriched === 'Posted',
    'S12a the premise: the post-entry value a person typed is in the pk-keyed store and NOT on the row', s12);
  check(s12.isRowPosted === true,
    'S12b (THE FIX) Reco.isRowPosted reads it - it read the RAW row, so the grid badge, the posted-JV '
    + 'audit and the exception CSV all said "not posted" about a row the share says is posted', s12);
  check(s12.excelLink === s12.isRowPosted,
    'S12c and ExcelLink._isPosted, which always read the enriched row, now gives the SAME answer - '
    + 'there is one function, not two', { excelLink: s12.excelLink, isRowPosted: s12.isRowPosted });
  check(s12.legacyArity === true,
    'S12d the two-argument call every build before this one used still works (five sites in run_reverse_e2e)',
    s12.legacyArity);
  check(s12.other === false, 'S12e and a row nobody typed into is not posted', s12.other);
  check(s12.audit.posted === 1 && s12.audit.configured,
    'S12f the posted-JV audit counts it', s12.audit);
  check(s12.exceptionValue === 'Posted',
    'S12g and the exception export shows the value the decision was made on, not an empty raw property',
    s12.exceptionValue);
  check(/no GL ref|posted-noref|posted-ref/.test(s12.badge || ''),
    'S12h and the row carries a posted badge in the grid', (s12.badge || '').slice(0, 200));

  /* ---------------------------------------------------------------------
     [22] O14 — T-24R2-6, which its own ticket says becomes live work in the
     SAME COMMIT as the allowOverride box. With no flag in existence the
     matrix refused nothing on these paths, so the gate would have been a call
     that could not fire; #26's box can be ticked, so it can.
     --------------------------------------------------------------------- */
  section(22, 'O14 — T-24R2-6: renaming an AEG input column ONTO an overridable column is refused');
  const o14 = await ovp.page.evaluate(() => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_OV');
    const aeg = AppState.aegTemplates.find(x => x.id === tpl.aegIntegration.aegTemplateId);
    const out = { linked: !!aeg, overridable: (tpl.additionalColumns.find(a => a.name === 'Net') || {}).allowOverride };
    /* The matrix itself, in the direction the ticket names. */
    out.direct = RecoTemplate._exclusiveRoleConflict(tpl, 'Net', 'aeg.inputColumns');
    out.directPlain = RecoTemplate._exclusiveRoleConflict(tpl, 'Twice', 'aeg.inputColumns');
    /* And through the editor's own writer. AEG.editingTemplate is what the
       editor holds; openEditor is called by the refusal and is wrapped. */
    AEG.editingTemplate = JSON.parse(JSON.stringify(aeg));
    const i = AEG.editingTemplate.inputColumns.findIndex(c => c.name === 'Doc');
    window.__toasts = [];
    const ret = AEG.updateInputCol(i, 'name', 'Net');
    out.refusedReturn = ret;
    out.nameAfterRefusal = AEG.editingTemplate.inputColumns[i].name;
    out.toast = ((window.__toasts || []).slice(-1)[0] || {}).msg || '';
    /* THE CONTROL: an ordinary rename is silent and applied. */
    window.__toasts = [];
    const ret2 = AEG.updateInputCol(i, 'name', 'DocRef');
    out.okReturn = ret2;
    out.nameAfterOk = AEG.editingTemplate.inputColumns[i].name;
    out.okToasts = (window.__toasts || []).length;
    /* The two inline writers now go through the one writer that asks. */
    out.selectHtml = AEG.selectInputCol(AEG.editingTemplate, 'valueColumn', 'AED');
    App.closeModal();
    return out;
  });
  note('O14', o14);
  check(o14.overridable === true && !!o14.direct && /cannot also be an AEG column/.test(o14.direct)
        && /override by hand/.test(o14.direct) && o14.directPlain === null,
    'O14a the matrix refuses an OVERRIDABLE column as an AEG input column, and says nothing about a '
    + 'plain computed one - one arm extended, not a second gate', { refused: o14.direct, plain: o14.directPlain });
  check(o14.refusedReturn === false && o14.nameAfterRefusal === 'Doc' && /Net/.test(o14.toast),
    'O14b renaming an AEG input column onto it is REFUSED, the name is unchanged, and the toast names it',
    { ret: o14.refusedReturn, name: o14.nameAfterRefusal, toast: o14.toast });
  check(o14.okReturn === true && o14.nameAfterOk === 'DocRef' && o14.okToasts === 0,
    'O14c (the control) an ordinary rename is applied and silent', o14);
  check(/AEG.setEditingPath\('valueColumn'/.test(o14.selectHtml),
    'O14d and the AEG value / currency column selects write through setEditingPath, not into the '
    + 'editing template inline - one writer, which is the one that asks', o14.selectHtml.slice(0, 120));

  const ovErr = ovp.errors.filter(e => !/Could not save|injected fault/.test(e));
  check(ovErr.length === 0, 'O12 no page error and no console error across the whole #26 run', ovErr.slice(0, 6));
  const ovToasts = (await readToasts(ovp.page)).filter(t => t.kind === 'error');
  note('error toasts in the #26 run (the refusals are deliberate)', ovToasts.map(t => t.msg.slice(0, 80)));
  check(ovToasts.every(t => /already posted|share the row key|no row key|not switched on|override|belongs to the journal/i.test(t.msg)),
    'O13 every error toast in the run is one of #26\'s own refusals, each naming its reason', ovToasts.map(t => t.msg.slice(0, 120)));
  await ovp.ctx.close();
  await dp.ctx.close();


  /* =====================================================================
     PHASE 3 (#30, CARRY-FORWARD) — sections [23]-[32].

     A `custom` or `dropdown` added column can be marked "Carry this value
     forward to the next file"; a value typed against a row's KEY is then
     honoured for that key in ANY file; a carried value is marked on screen
     and the mark clears when the operator confirms or changes it; and with
     the flag OFF - every template that exists today - a typed value is
     honoured only for rows from the data set it was entered against.

     THE GATES:
       C1  WITH THE DEFAULT FLAG, "ADD DATA" OF A SECOND FILE LEAVES THE SAME
           KEY BLANK. This is the blocker's exact scenario: sess.data is
           CONCATENATED and nothing ever removes a data set, so a
           session-scoped test would have shipped the cross-file carry the
           feature promises it does not, by default, on every template on the
           share.
       C2  RE-ENTERING A CARRIED VALUE CLEARS THE MARK, and so does changing
           it. applyEdits' noop check reads `cur` through the enriched row -
           i.e. the carried value - so without decision O's force path the
           mark is UNCLEARABLE.
       C3  A 50,000-CELL FILL-DOWN WRITES THE FILE ONCE.
     ===================================================================== */
  const PORT_CF = 20842;    // the carry fixture
  const PORT_DAY = 20843;   // C5: decision N, a later calendar day
  const PORT_S11 = 20844;   // C6: the role matrix, and the money
  const PORT_FILL = 20845;  // C3: the 50,000-cell fill-down
  const PORT_NK = 20846;    // C8: a keyless template

  /* THE #30 FIXTURE. One keyed template with
       Vendor custom     <- the column the carry box goes on
       Stage  dropdown   <- the carry box on a dropdown, and C5's NON-carry column
       Calc   formula    <- decision S: NO carry box at all on a computed column
     A TEST CANNOT MOVE THE CLOCK, and Versioning.pathFor names the data set by
     TODAY's day file - so `Versioning.dayFile` is stubbed to say which day it
     is. That is not a mock of the thing under test: the upload really does go
     into a different file in reco_data/, and loadVersionedFile really does
     name the data set from that file's own path. It is the only way to have
     two data sets in one run. */
  const CF_SETUP = `(async function (arg) {
    const [tplId, day] = arg;
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = tplId; t.name = 'Carry ' + tplId;
    t.columns = ['Invoice', 'Amount'].map(n => ({ name: n, label: n, formats: [], isValue: n === 'Amount' }));
    t.primaryKeys = ['Invoice'];
    t.valueColumn = 'Amount';
    t.displayColumns = ['Invoice', 'Amount'];
    t.additionalColumns = [
      { name: 'Vendor', type: 'custom' },
      { name: 'Stage',  type: 'dropdown', options: ['Open', 'Closed'] },
      { name: 'Calc',   type: 'formula', formula: 'NUM({Amount})*2' }
    ];
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    RecoTemplate.open(tpl.id);
    window.__realDayFile = Versioning.dayFile;
    Versioning.dayFile = () => day;
    await Reco.ingestData(tpl, [{ Invoice: 'INV-1', Amount: '100' }, { Invoice: 'INV-2', Amount: '200' }],
      ['Invoice', 'Amount']);
    App.closeModal();
    AppState.activeRecoId = tpl.id;
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    return { id: tpl.id, folder: tpl.dataFolder, dataSetIds: AppState.recoSessions[tpl.id].dataSetIds.slice() };
  })`;

  /* "Add Data" - ingestData CONCATENATES, which is the whole point of C1. */
  const CF_ADD = `(async function (arg) {
    const [tplId, day, rows] = arg;
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    Versioning.dayFile = () => day;
    await Reco.ingestData(tpl, rows, ['Invoice', 'Amount']);
    App.closeModal();
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    const sess = AppState.recoSessions[tplId];
    return { dataSetIds: sess.dataSetIds.slice(), rows: sess.data.length,
             dsi: sess.data.map(r => ({ inv: r.Invoice, dsi: r._dsi })) };
  })`;

  /* Every row's value for one added column, WITH the data set it came from,
     read through the one ladder. */
  const CF_CELLS = `(function (arg) {
    const [tplId, col] = arg;
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const sess = AppState.recoSessions[tplId];
    const ac = (tpl.additionalColumns || []).find(a => a.name === col);
    Reco._fullPass();
    try {
      return sess.data.map(r => ({
        inv: r.Invoice, dsi: r._dsi, ds: Reco.dataSetOf(sess, r),
        v: String(Reco._extraValueForRow(tpl, sess, r, ac)),
        carried: !!Reco._extraCarried(tpl, sess, r, col)
      }));
    } finally { Reco._fullEnd(); }
  })`;

  /* The cell as the GRID draws it, from the same descriptor list the header
     is built from - not from XlSchema, which is a different list. */
  const CF_CELLHTML = `(function (arg) {
    const [tplId, inv, dsi, col] = arg;
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const sess = AppState.recoSessions[tplId];
    const row = sess.data.find(r => r.Invoice === inv && r._dsi === dsi);
    if (!row) return null;
    const desc = Reco.effectiveColumnDescs(tpl, sess, { showExtras: 'all' }).find(d => d.name === col);
    Reco._fullPass();
    try { return Reco._renderExtraCell(tpl, sess, row, desc, 0, () => Reco._rowWithExtras(tpl, sess, row)); }
    finally { Reco._fullEnd(); }
  })`;

  /* ---------------------------------------------------------------------
     [23] C0 — the feature exists at all, said in words rather than a stack
     trace. On a build without #30 every assertion from here on fails by not
     existing, and the first evaluate aborts the run - which is the right
     reason to fail, and is how pre.txt was recorded.
     --------------------------------------------------------------------- */
  section(23, 'C0 — #30 exists: the editor box, the derived mark, the confirm path, the promotion, the panel');
  const CF = makeRoot('share-cf');
  if (!CF.root) throw new Error('could not build the #30 app root');
  const bridgeCf = await startBridge(CF.root, PORT_CF); procs.push(bridgeCf.proc);
  const cfp = await openReco(browser, bridgeCf);
  const have30 = await cfp.page.evaluate(() => ({
    _carryBox: typeof RecoTemplate._carryBox, toggleCarry: typeof RecoTemplate.toggleCarry,
    _syncCarryBoxes: typeof RecoTemplate._syncCarryBoxes,
    _extraCarried: typeof Reco._extraCarried, _carryColumn: typeof Reco._carryColumn,
    confirmCarried: typeof Reco.confirmCarried,
    _promoteCarryForward: typeof Reco._promoteCarryForward,
    openValuesModal: typeof Reco.openValuesModal, removeValueRec: typeof Reco.removeValueRec,
    removeValuesNotLoaded: typeof Reco.removeValuesNotLoaded,
    _typedValueList: typeof Reco._typedValueList, _typedCount: typeof Reco._typedCount,
    confirmClearSession: typeof Reco.confirmClearSession
  }));
  check(Object.keys(have30).every(k => have30[k] === 'function'),
    'C0 the editor box, the derived mark, the confirm path, the promotion and the Values panel all exist. '
    + 'Everything after this line fails by not existing on a build without #30', have30);

  /* ---------------------------------------------------------------------
     [24] C1 (THE GATE) — the default flag is falsy, and "Add Data" of a
     second file without a Clear leaves the same key BLANK.
     --------------------------------------------------------------------- */
  section(24, 'C1 (THE GATE) — with the DEFAULT flag, Add Data of file 2 leaves the same key BLANK');
  const cfIds = await cfp.page.evaluate(CF_SETUP + `(['TPL_CF', '01.csv'])`);
  note('#30 fixture', cfIds);
  const cfTyped = await cfp.page.evaluate(TYPE + `(['TPL_CF', 'Vendor', [[0,'Acme Ltd'],[1,'Borax SA']]])`);
  check(cfTyped.applied === 2, 'C1a the premise: two values typed into file 1 were applied', cfTyped);
  const cfFlagOff = await cfp.page.evaluate(() => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_CF');
    return (tpl.additionalColumns || []).map(a => ({ name: a.name, carryForward: a.carryForward }));
  });
  check(cfFlagOff.every(a => a.carryForward === undefined),
    'C1b THE DEFAULT IS OFF, per column — saveTemplate stored no carryForward on any column', cfFlagOff);

  /* "ADD DATA", no Clear. The same invoice is in next month's extract. */
  const cfAdd = await cfp.page.evaluate(CF_ADD
    + `(['TPL_CF', '02.csv', [{Invoice:'INV-1',Amount:'110'},{Invoice:'INV-2',Amount:'210'},{Invoice:'INV-3',Amount:'300'}]])`);
  note('after Add Data', cfAdd);
  check(cfAdd.rows === 5 && cfAdd.dataSetIds.length === 2
        && same(cfAdd.dsi.map(d => d.dsi), [0, 0, 1, 1, 1]),
    'C1c the blocker\'s CONDITION is present: sess.data was CONCATENATED, BOTH data sets are in play at '
    + 'once, and every row says which upload it came from', cfAdd);
  const cfCells1 = await cfp.page.evaluate(CF_CELLS + `(['TPL_CF', 'Vendor'])`);
  note('Vendor, flag OFF', cfCells1);
  const m1 = cfCells1.find(c => c.inv === 'INV-1' && c.dsi === 0);
  const m2 = cfCells1.find(c => c.inv === 'INV-1' && c.dsi === 1);
  const m3 = cfCells1.find(c => c.inv === 'INV-3' && c.dsi === 1);
  const m2b = cfCells1.find(c => c.inv === 'INV-2' && c.dsi === 1);
  check(m2 && m2.v === '' && m2b && m2b.v === '' && m3 && m3.v === '',
    'C1d (THE GATE) BOTH keys that were typed in file 1 are BLANK on their file-2 rows, and so is a key '
    + 'that was never typed', { file2SameKeys: [m2, m2b], file2NewKey: m3 });
  check(m1 && m1.v === 'Acme Ltd',
    'C1e (the control, so C1d is not "nothing was ever typed") the file-1 row still shows it', m1);
  const cfStore1 = diskJson(CF.root, 'reco/extraValueMaster.json');
  check(!!(cfStore1 && cfStore1.TPL_CF && Object.keys(cfStore1.TPL_CF).length === 2
           && cfStore1.TPL_CF['INV-1'].Vendor.ds === cfIds.dataSetIds[0]),
    'C1f and the record IS on the share, stamped with the data set it was typed against — the value is '
    + 'not lost, it is out of scope', cfStore1 && cfStore1.TPL_CF);
  check(cfCells1.every(c => c.carried === false),
    'C1g nothing is MARKED as carried either, because nothing is being carried', cfCells1.map(c => c.carried));

  /* ---------------------------------------------------------------------
     [25] C4 — the flag ON: a value typed in file 1 is honoured for the same
     key in file 2, and the mark says it was carried.
     --------------------------------------------------------------------- */
  section(25, 'C4 — the flag ON: the same key in the next file is filled in, and MARKED as carried');
  const cfOn = await cfp.page.evaluate(() => {
    /* Through the REAL editor path: edit -> toggleCarry -> saveTemplate. */
    RecoTemplate.edit('TPL_CF');
    window.__toasts = [];
    RecoTemplate.toggleCarry(0, true);          // Vendor
    const afterToggle = !!RecoTemplate._editing.additionalColumns[0].carryForward;
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_CF');
    return { afterToggle, stored: !!tpl.additionalColumns[0].carryForward,
             stage: tpl.additionalColumns[1].carryForward,
             toasts: (window.__toasts || []).map(t => t.msg).slice(0, 3),
             carryColumn: !!Reco._carryColumn(tpl, 'Vendor'),
             stageCarryColumn: !!Reco._carryColumn(tpl, 'Stage') };
  });
  note('C4 toggle', cfOn);
  check(cfOn.afterToggle && cfOn.stored && cfOn.stage === undefined && cfOn.carryColumn && !cfOn.stageCarryColumn,
    'C4a the box is ticked through the real editor path, stored on THAT column only, and nothing else '
    + 'on the template gained it', cfOn);
  const cfCells2 = await cfp.page.evaluate(CF_CELLS + `(['TPL_CF', 'Vendor'])`);
  note('Vendor, flag ON', cfCells2);
  const c2m2 = cfCells2.find(c => c.inv === 'INV-1' && c.dsi === 1);
  const c2m1 = cfCells2.find(c => c.inv === 'INV-1' && c.dsi === 0);
  const c2m3 = cfCells2.find(c => c.inv === 'INV-3' && c.dsi === 1);
  check(c2m2 && c2m2.v === 'Acme Ltd' && c2m2.carried === true,
    'C4b (the ask) the value typed in file 1 is honoured for the same key on a row from file 2, and is '
    + 'DERIVED as carried', c2m2);
  check(c2m1 && c2m1.v === 'Acme Ltd' && c2m1.carried === false,
    'C4c the file-1 row shows the same value and is NOT marked — carried-ness is the record\'s data set '
    + 'against THIS row\'s, so the row it was typed on is never marked', c2m1);
  check(c2m3 && c2m3.v === '',
    'C4d a key the store has never seen is still blank — "previous file" means the newest value FOR THAT '
    + 'KEY, not the previous row', c2m3);
  const cfHtml = await cfp.page.evaluate(CF_CELLHTML + `(['TPL_CF', 'INV-1', 1, 'Vendor'])`);
  note('carried cell', (cfHtml || '').slice(0, 300));
  check(/class="carry-set"/.test(cfHtml || '') && /Carried forward\./.test(cfHtml || '')
        && /01\.csv/.test(cfHtml || '') && /Reco\.confirmCarried\(/.test(cfHtml || ''),
    'C4e the grid draws the accent, a title that NAMES THE FILE the value came from and who typed it, '
    + 'and a confirm control', (cfHtml || '').slice(0, 400));
  const cfHtml1 = await cfp.page.evaluate(CF_CELLHTML + `(['TPL_CF', 'INV-1', 0, 'Vendor'])`);
  check(!/carry-set/.test(cfHtml1 || '') && !/confirmCarried/.test(cfHtml1 || ''),
    'C4f and the file-1 cell is the byte-identical plain cell it always was — NOTHING is emitted when a '
    + 'cell is not carried, which is what keeps the two tbody byte-identity gates intact',
    (cfHtml1 || '').slice(0, 200));
  const cfHtmlNo = await cfp.page.evaluate(CF_CELLHTML + `(['TPL_CF', 'INV-3', 1, 'Stage'])`);
  check(/^<td data-col="Stage"><select onchange="Reco\.setTag\('[^']+','Stage',this\.value\)">/.test(cfHtmlNo || '')
        && !/carry-set|carry-ok|title=/.test(cfHtmlNo || ''),
    'C4g a NON-carry dropdown cell is the unchanged markup: the <td> carries only data-col, with no '
    + 'class, no title and no button', (cfHtmlNo || '').slice(0, 200));

  /* ---------------------------------------------------------------------
     [26] C2 (THE GATE) — decision O. Confirming a carried value clears the
     mark, and so does changing it.
     --------------------------------------------------------------------- */
  section(26, 'C2 (THE GATE) — DECISION O: re-entering a carried value clears the mark, and so does changing it');
  await resetLog(bridgeCf);
  const c2 = await cfp.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_CF');
    const sess = AppState.recoSessions.TPL_CF;
    const r1 = sess.data.find(r => r.Invoice === 'INV-1' && r._dsi === 1);
    const r2 = sess.data.find(r => r.Invoice === 'INV-2' && r._dsi === 1);
    const rec = row => { const x = Reco._extraRec(tpl, sess, row, 'Vendor'); return x ? JSON.parse(JSON.stringify(x)) : null; };
    const read = row => { Reco._fullPass(); try { return String(Reco.rowFull(tpl, sess, row).Vendor); } finally { Reco._fullEnd(); } };
    const out = { before1: rec(r1), before2: rec(r2),
                  carried1: !!Reco._extraCarried(tpl, sess, r1, 'Vendor'),
                  carried2: !!Reco._extraCarried(tpl, sess, r2, 'Vendor'),
                  rowDs: Reco.dataSetOf(sess, r1) };
    /* HALF ONE: THE SAME VALUE, confirmed. This is the one applyEdits
       no-ops: `cur` reads through the enriched row, i.e. the carried value. */
    const raw = await Reco.applyEdits(tpl, sess, [{ row: r1, col: 'Vendor', value: out.before1.v }],
      { source: 'grid', trusted: true });
    out.rawNoop = { applied: raw.applied, noop: raw.noop };
    out.afterRawNoop = rec(r1);
    Reco.confirmCarried(r1._id, 'Vendor');
    await new Promise(r => setTimeout(r, 30));
    out.after1 = rec(r1);
    out.stillCarried1 = !!Reco._extraCarried(tpl, sess, r1, 'Vendor');
    out.value1 = read(r1);
    /* HALF TWO: A DIFFERENT VALUE. */
    Reco.setTag(r2._id, 'Vendor', 'Borax Updated');
    await new Promise(r => setTimeout(r, 30));
    out.after2 = rec(r2);
    out.stillCarried2 = !!Reco._extraCarried(tpl, sess, r2, 'Vendor');
    out.value2 = read(r2);
    /* AND THE FILE-1 ROW OF THE SAME KEY now reads the confirmed record, so
       nothing was forked. */
    out.file1Row = read(sess.data.find(r => r.Invoice === 'INV-1' && r._dsi === 0));
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    await new Promise(r => setTimeout(r, 400));
    if (typeof Store.idle === 'function') await Store.idle();
    return out;
  });
  note('C2', c2);
  check(c2.carried1 && c2.carried2 && c2.rawNoop.noop === 1 && c2.rawNoop.applied === 0
        && c2.afterRawNoop.ds === c2.before1.ds,
    'C2a THE DEFECT, named: both cells are carried, and applyEdits ALONE no-ops a same-value confirm and '
    + 'leaves `ds` where it was — which is why decision O needs its own path', c2);
  check(c2.after1 && c2.after1.v === 'Acme Ltd' && c2.after1.ds === c2.rowDs
        && c2.after1.at !== c2.before1.at && c2.stillCarried1 === false && c2.value1 === 'Acme Ltd',
    'C2b (THE GATE, half one) the SAME-VALUE confirm re-stamps ds/at, the mark CLEARS, and the value is '
    + 'unchanged', { before: c2.before1, after: c2.after1, carried: c2.stillCarried1 });
  check(c2.after2 && c2.after2.v === 'Borax Updated' && c2.after2.ds === c2.rowDs
        && c2.stillCarried2 === false && c2.value2 === 'Borax Updated',
    'C2c (THE GATE, half two) CHANGING the value clears the mark too', { after: c2.after2, carried: c2.stillCarried2 });
  check(c2.file1Row === 'Acme Ltd',
    'C2d and the file-1 row of the same key reads the confirmed record — one record per key, not a fork '
    + 'per file', c2.file1Row);
  const c2disk = diskJson(CF.root, 'reco/extraValueMaster.json');
  check(!!(c2disk && c2disk.TPL_CF && c2disk.TPL_CF['INV-1'] && c2disk.TPL_CF['INV-1'].Vendor
           && c2disk.TPL_CF['INV-1'].Vendor.ds === c2.rowDs
           && c2disk.TPL_CF['INV-2'].Vendor.v === 'Borax Updated'),
    'C2e both confirmations reached the SHARED FILE', (c2disk || {}).TPL_CF);
  const c2log = await callLog(bridgeCf);
  check(writesOf(c2log, 'reco/extraValueMaster.json') <= 2,
    'C2f and the two confirmations 30 ms apart were coalesced by the 150 ms debounce, not one write each',
    { writes: writesOf(c2log, 'reco/extraValueMaster.json') });

  /* ---------------------------------------------------------------------
     [27] C5 — DECISION N: `ds` on write is the ROW's data set, never today's
     day file. Reopen a file from history on a LATER CALENDAR DAY and type
     into a NON-carry column.
     --------------------------------------------------------------------- */
  section(27, 'C5 — DECISION N: a value typed on a later day into a reopened file stays on screen');
  const DAY = makeRoot('share-day');
  const bridgeDay = await startBridge(DAY.root, PORT_DAY); procs.push(bridgeDay.proc);
  const dayp = await openReco(browser, bridgeDay);
  await dayp.page.evaluate(CF_SETUP + `(['TPL_DAY', '01.csv'])`);
  const c5 = await dayp.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_DAY');
    /* IT IS NOW A LATER CALENDAR DAY. Versioning.pathFor would answer
       .../09.csv from here on; the file being reopened is .../01.csv. */
    Versioning.dayFile = () => '09.csv';
    const today = Versioning.pathFor(tpl);
    const files = await Versioning.listFiles(tpl, true);
    const f = files.find(x => /01\.csv$/.test(x.fullPath));
    await Reco.loadVersionedFile(f.fullPath, tpl.id);
    const sess = AppState.recoSessions[tpl.id];
    const row = sess.data.find(r => r.Invoice === 'INV-1');
    /* A NON-CARRY column, which is the only one the file test applies to. */
    Reco.setTag(row._id, 'Stage', 'Closed');
    await new Promise(r => setTimeout(r, 30));
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    const rec = Reco._extraRec(tpl, sess, row, 'Stage');
    const out = { today: today, reopened: f.fullPath, rowDs: Reco.dataSetOf(sess, row),
                  rec: rec ? JSON.parse(JSON.stringify(rec)) : null,
                  carry: !!Reco._carryColumn(tpl, 'Stage') };
    /* THE REPAINT. Not a re-read of a variable: the whole grid is drawn
       again and the value is read back out of the DOM it produced. */
    AppState.activeRecoId = tpl.id;
    App.navigate('reco');
    const tr = document.querySelector('tbody tr[data-rid="' + CSS.escape(row._id) + '"]');
    const td = tr && tr.querySelector('td[data-col="Stage"]');
    const sel = td && td.querySelector('select');
    out.onScreen = sel ? sel.value : (td ? td.textContent.trim() : null);
    out.marked = !!(td && /carry-set/.test(td.className));
    return out;
  });
  note('C5', c5);
  check(c5.carry === false && c5.rec && c5.rec.ds === c5.reopened && c5.rec.ds !== c5.today,
    'C5a DECISION N: `ds` is the data set of the ROW (the file reopened from history), NOT today\'s day '
    + 'file — which is what would have made the value vanish from its own file\'s scope', c5);
  check(c5.onScreen === 'Closed',
    'C5b and the value is still on screen after a full repaint — read back out of the DOM the grid drew',
    { onScreen: c5.onScreen, rowDs: c5.rowDs });
  check(c5.marked === false,
    'C5c and it is NOT marked as carried: it is in its own file\'s scope', c5.marked);
  await dayp.ctx.close();

  /* ---------------------------------------------------------------------
     [28] C6 — DECISION K: S11 refuses a carryForward column that is an AEG
     control column, in BOTH editors and BOTH directions. Then the MONEY
     consequence: with the gate in force the grid and the journal read the
     SAME value for a store-served column.
     --------------------------------------------------------------------- */
  section(28, 'C6 — DECISION K: the role matrix in both editors and both directions, and the money');
  const S11R = makeRoot('share-s11');
  const bridgeS11 = await startBridge(S11R.root, PORT_S11); procs.push(bridgeS11.proc);
  const s11p = await openReco(browser, bridgeS11);
  const s11ids = await s11p.page.evaluate(`(async function () {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_S11'; t.name = 'Role matrix';
    t.columns = ['Invoice', 'Base', 'Reco', 'ToAccount', 'Status', 'Keyword']
      .map(n => ({ name: n, label: n, formats: [], isValue: n === 'Base' }));
    t.primaryKeys = ['Invoice'];
    t.valueColumn = 'Base';
    t.displayColumns = t.columns.map(c => c.name);
    t.additionalColumns = [
      { name: 'Vendor', type: 'custom' },                                  // 0: legal to carry
      { name: 'KwExtra', type: 'custom' },                                 // 1: the AEG keyword column
      { name: 'PostExtra', type: 'custom' },                               // 2: the AEG post-entry column
      { name: 'AED', type: 'formula', formula: 'NUM({Base})' },            // 3: a linked AEG input column
      { name: 'Net', type: 'formula', formula: 'NUM({Base})*2', allowOverride: true }, // 4: the triple
      { name: 'ClubBy', type: 'custom' }                                   // 5: a linked aggregateBy column
    ];
    t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id,
      keywordColumn: 'KwExtra', keywordValues: 'go', postEntryColumn: 'PostExtra', postEntryValue: 'Posted' };
    RecoTemplate.saveTemplate();
    const aeg = AppState.aegTemplates.find(x => x.id === AppState.recoTemplates.find(y => y.id === 'TPL_S11').aegIntegration.aegTemplateId);
    aeg.aggregateBy = ['Reco', 'ClubBy'];
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_S11');
    RecoTemplate.open(tpl.id);
    window.__realDayFile = Versioning.dayFile;
    Versioning.dayFile = () => '01.csv';
    await Reco.ingestData(tpl, [
      { Invoice: 'S-1', Base: '10', Reco: 'R1', ToAccount: 'ACC1', Status: '', Keyword: '' },
      { Invoice: 'S-2', Base: '20', Reco: 'R1', ToAccount: 'ACC1', Status: '', Keyword: '' }
    ], ['Invoice', 'Base', 'Reco', 'ToAccount', 'Status', 'Keyword']);
    App.closeModal();
    AppState.activeRecoId = tpl.id;
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    return { aegInputs: (aeg.inputColumns || []).map(c => c.name), aggregateBy: aeg.aggregateBy.slice(),
             toAcct: XlSchema.toAccountCol(tpl) };
  })()`);
  note('C6 fixture', s11ids);

  const c6a = await s11p.page.evaluate(() => {
    RecoTemplate.edit('TPL_S11');
    const t = RecoTemplate._editing;
    const names = (t.additionalColumns || []).map(a => a.name);
    const tryCarry = name => {
      const i = names.indexOf(name);
      window.__toasts = [];
      RecoTemplate.toggleCarry(i, true);
      const msg = ((window.__toasts || [])[0] || {}).msg || '';
      const set = !!RecoTemplate._editing.additionalColumns[i].carryForward;
      if (set) delete RecoTemplate._editing.additionalColumns[i].carryForward;
      return { set, msg };
    };
    /* Add the two linked-AEG roles the matrix also forbids, so all four arms
       are exercised rather than only the two on tpl.aegIntegration. */
    const linked = XlSchema.aegTemplateFor(t);
    const out = { aegInputs: (linked.inputColumns || []).map(c => c.name) };
    out.keyword   = tryCarry('KwExtra');
    out.postEntry = tryCarry('PostExtra');
    out.aegInput  = tryCarry('AED');
    out.clubBy    = tryCarry('ClubBy');
    out.override  = tryCarry('Net');          // the triple: already allowOverride
    out.legal     = tryCarry('Vendor');       // the control
    /* A KEY COMPONENT is the third leg of the triple. */
    out.pkDirect = RecoTemplate._exclusiveRoleConflict(t, 'Invoice', 'carryForward');
    /* AND THE TEMPLATE'S OWN To Account COLUMN. */
    out.toAcctDirect = RecoTemplate._exclusiveRoleConflict(t, XlSchema.toAccountCol(t) || 'ToAccount', 'carryForward');
    App.closeModal();
    return out;
  });
  note('C6 direction 1 (the Reco editor)', c6a);
  check(c6a.keyword.set === false && /keyword column/.test(c6a.keyword.msg)
        && c6a.postEntry.set === false && /post-entry column/.test(c6a.postEntry.msg),
    'C6a the AEG keyword and post-entry columns are REFUSED as carryForward, each naming what it '
    + 'protected', { keyword: c6a.keyword, postEntry: c6a.postEntry });
  check(c6a.aegInput.set === false && /input column of the linked/.test(c6a.aegInput.msg)
        && c6a.clubBy.set === false && /club-by column/.test(c6a.clubBy.msg),
    'C6b a linked AEG template\'s INPUT column and a club-by column are refused too', { aegInput: c6a.aegInput, clubBy: c6a.clubBy });
  check(c6a.override.set === false && /only be one of/.test(c6a.override.msg),
    'C6c and the triple holds: a column that people can override by hand cannot also be carried forward',
    c6a.override);
  check(c6a.legal.set === true,
    'C6d (the control) a plain custom column that is none of those roles IS allowed — the gate refuses '
    + 'the four roles, not the feature', c6a.legal);
  check(!!c6a.pkDirect && /row key/.test(c6a.pkDirect) && !!c6a.toAcctDirect && /To Account/.test(c6a.toAcctDirect),
    'C6e a primary-key component and the To Account column are refused as well',
    { pk: c6a.pkDirect, toAcct: c6a.toAcctDirect });

  const c6b = await s11p.page.evaluate(() => {
    /* DIRECTION 2: the column is carried FIRST, and then someone tries to
       give it an AEG role — in the Reco editor and in the AEG editor. */
    /* SAVED FIRST, not just set on the editor's clone: AEG._roleClash reads
       AppState.recoTemplates, which is the whole point of "the other
       direction" - the AEG editor asks about the reconciliations as they are
       STORED, not as somebody happens to have one open. */
    RecoTemplate.edit('TPL_S11');
    RecoTemplate._editing.additionalColumns.find(a => a.name === 'Vendor').carryForward = true;
    RecoTemplate._editing.aegIntegration.keywordColumn = '';
    RecoTemplate.saveTemplate();
    RecoTemplate.edit('TPL_S11');
    const t = RecoTemplate._editing;
    window.__toasts = [];
    const asKeyword = RecoTemplate.setAegRole('keywordColumn', 'Vendor');
    const kwMsg = ((window.__toasts || [])[0] || {}).msg || '';
    const kwAfter = RecoTemplate._editing.aegIntegration.keywordColumn;
    window.__toasts = [];
    const asPost = RecoTemplate.setAegRole('postEntryColumn', 'Vendor');
    const postMsg = ((window.__toasts || [])[0] || {}).msg || '';
    /* THE AEG EDITOR's own direction. */
    const aeg = XlSchema.aegTemplateFor(t);
    AEG.editingTemplate = JSON.parse(JSON.stringify(aeg));
    const was = AEG.editingTemplate.inputColumns[0].name;
    window.__toasts = [];
    const ret = AEG.updateInputCol(0, 'name', 'Vendor');
    const aegMsg = ((window.__toasts || [])[0] || {}).msg || '';
    const aegAfter = AEG.editingTemplate.inputColumns[0].name;
    App.closeModal();
    const stored = AppState.recoTemplates.find(x => x.id === 'TPL_S11');
    return { asKeyword, kwMsg, kwAfter, asPost, postMsg, aegRet: ret, aegMsg, aegAfter, was,
             storedCarry: !!(stored.additionalColumns.find(a => a.name === 'Vendor') || {}).carryForward };
  });
  note('C6 direction 2', c6b);
  check(c6b.storedCarry === true && c6b.asKeyword === false && c6b.kwAfter === '' && /carried forward/.test(c6b.kwMsg)
        && c6b.asPost === false && /carried forward/.test(c6b.postMsg),
    'C6f THE OTHER DIRECTION, in the Reco editor: making an already-carried column the AEG keyword or '
    + 'post-entry column is refused, and the role is NOT written', c6b);
  check(c6b.aegRet === false && c6b.aegAfter !== 'Vendor' && /carried forward/.test(c6b.aegMsg),
    'C6g and in the AEG EDITOR: renaming an input column onto a carried column is refused',
    { ret: c6b.aegRet, name: c6b.aegAfter, msg: c6b.aegMsg });

  /* THE MONEY CONSEQUENCE. With the gate in force, the AEG source-row loop
     and the grid read the SAME value for a store-served column — which is
     exactly what the alternative remedy (leave the AEG loop reading
     manualTags) would have made impossible. */
  const c6money = await s11p.page.evaluate(async () => {
    RecoTemplate.edit('TPL_S11');
    RecoTemplate._editing.additionalColumns.find(a => a.name === 'Vendor').carryForward = true;
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_S11');
    const sess = AppState.recoSessions.TPL_S11;
    AppState.activeRecoId = tpl.id;
    const r1 = sess.data.find(r => r.Invoice === 'S-1');
    Reco.setTag(r1._id, 'Vendor', 'CarryVendor');
    Reco.setTag(r1._id, 'KwExtra', 'go');
    sess.data.filter(r => r !== r1).forEach(r => { Reco.setTag(r._id, 'KwExtra', 'go'); });
    await new Promise(r => setTimeout(r, 40));
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    /* THE SECOND FILE, so the value is genuinely CARRIED when the journal
       reads it — the condition under which the two surfaces could diverge. */
    Versioning.dayFile = () => '02.csv';
    await Reco.ingestData(tpl, [{ Invoice: 'S-1', Base: '10', Reco: 'R1', ToAccount: 'ACC1', Status: '', Keyword: '' }],
      ['Invoice', 'Base', 'Reco', 'ToAccount', 'Status', 'Keyword']);
    App.closeModal();
    const r1b = sess.data.filter(r => r.Invoice === 'S-1').slice(-1)[0];
    Reco.setTag(r1b._id, 'KwExtra', 'go');
    await new Promise(r => setTimeout(r, 40));
    const out = { carried: !!Reco._extraCarried(tpl, sess, r1b, 'Vendor') };
    Reco._fullPass();
    try { out.grid = String(Reco.rowFull(tpl, sess, r1b).Vendor); } finally { Reco._fullEnd(); }
    sess.selectedRows = {};
    sess.selectedRows[r1b._id] = true;
    Reco.previewEntryFromSelection(false);
    const ctx = Reco._pendingEntry;
    out.aegRows = (ctx.sourceRows || []).length;
    out.aeg = String(((ctx.sourceRows || [])[0] || {}).Vendor);
    App.closeModal();
    return out;
  });
  note('C6 money', c6money);
  check(c6money.carried === true && c6money.aegRows === 1 && c6money.grid === 'CarryVendor'
        && c6money.aeg === c6money.grid,
    'C6h (THE MONEY) with the gate in force the AEG SOURCE ROW and the GRID read the SAME carried value '
    + '— the permanent divergence the alternative remedy would have shipped cannot happen', c6money);
  await s11p.ctx.close();

  /* ---------------------------------------------------------------------
     [29] C7 — DECISION Q: the one-time promotion fires for a column that
     GAINED the flag, and a second save with no change promotes nothing and
     leaves ds/at untouched.
     --------------------------------------------------------------------- */
  section(29, 'C7 — DECISION Q: the one-time promotion, and a second save that promotes nothing');
  const c7 = await cfp.page.evaluate(async () => {
    /* A SECOND template on this share, so nothing C4 did can flatter it. */
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_Q'; t.name = 'Promotion';
    t.columns = ['Invoice', 'Amount'].map(n => ({ name: n, label: n, formats: [], isValue: n === 'Amount' }));
    t.primaryKeys = ['Invoice']; t.valueColumn = 'Amount';
    t.displayColumns = ['Invoice', 'Amount'];
    t.additionalColumns = [{ name: 'Rep', type: 'custom' }, { name: 'Other', type: 'custom' }];
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_Q');
    RecoTemplate.open(tpl.id);
    Versioning.dayFile = () => '01.csv';
    await Reco.ingestData(tpl, [{ Invoice: 'Q-1', Amount: '10' }, { Invoice: 'Q-2', Amount: '20' },
                                { Invoice: 'Q-3', Amount: '30' }], ['Invoice', 'Amount']);
    App.closeModal();
    const sess = AppState.recoSessions.TPL_Q;
    /* THE PRE-STORE WORLD: values in sess.manualTags, keyed on row._id. */
    sess.manualTags = sess.manualTags || {};
    sess.manualTags[Reco._tagKey(sess.data[0], 'Rep')] = 'Alice';
    sess.manualTags[Reco._tagKey(sess.data[1], 'Rep')] = 'Bob';
    sess.manualTags[Reco._tagKey(sess.data[0], 'Other')] = 'untouched';
    /* AND one cell that ALREADY has a record, typed through the real path:
       the promotion must leave it exactly as it is. */
    await Reco.applyEdits(tpl, sess, [{ row: sess.data[2], col: 'Rep', value: 'Carol' }],
      { source: 'grid', trusted: true });
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    const q3Before = JSON.parse(JSON.stringify(Reco._extraRec(tpl, sess, sess.data[2], 'Rep')));

    /* THE EDITOR IS REACHABLE FROM HOME: the active reco is another template
       entirely, which is why the promotion reads AppState.recoSessions[t.id]
       and never activeRecoId. */
    AppState.activeRecoId = 'TPL_CF';
    RecoTemplate.edit('TPL_Q');
    RecoTemplate.toggleCarry(0, true);              // Rep gains the flag
    window.__toasts = [];
    RecoTemplate.saveTemplate();
    const toast1 = (window.__toasts || []).map(x => x.msg);
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    const after1 = JSON.parse(JSON.stringify((AppState.extraValueMaster || {}).TPL_Q || {}));
    const legacyAfter1 = Object.keys(sess.manualTags || {}).map(k => k.split('||')[1]).sort();

    /* HALF TWO: a SECOND save with nothing changed. */
    await new Promise(r => setTimeout(r, 20));
    RecoTemplate.edit('TPL_Q');
    window.__toasts = [];
    RecoTemplate.saveTemplate();
    const toast2 = (window.__toasts || []).map(x => x.msg);
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    const after2 = JSON.parse(JSON.stringify((AppState.extraValueMaster || {}).TPL_Q || {}));
    AppState.activeRecoId = 'TPL_CF';
    return { q3Before, toast1, toast2, after1, after2, legacyAfter1,
             onScreen: (() => { Reco._fullPass(); try {
               return sess.data.map(r => String(Reco.rowFull(tpl, sess, r).Rep)); } finally { Reco._fullEnd(); } })() };
  });
  note('C7', { toast1: c7.toast1, toast2: c7.toast2, legacyAfter1: c7.legacyAfter1 });
  check(!!(c7.after1['Q-1'] && c7.after1['Q-1'].Rep && c7.after1['Q-1'].Rep.v === 'Alice'
           && c7.after1['Q-2'].Rep.v === 'Bob' && c7.after1['Q-1'].Rep.k === 'typed'),
    'C7a (half one) the promotion fires for the column that GAINED the flag: the legacy values are now '
    + 'records against the row key', c7.after1);
  check(!c7.after1['Q-1'].Other && same(c7.legacyAfter1, ['Other']),
    'C7b and ONLY that column: the other column\'s legacy value is left in sess.manualTags, and the two '
    + 'promoted legacy entries are deleted — one truth per cell', { after: c7.after1['Q-1'], legacy: c7.legacyAfter1 });
  check(c7.toast1.some(m => /now kept against the row key/.test(m)),
    'C7c and the operator is told it happened, rather than having to guess', c7.toast1);
  check(same(c7.after1['Q-3'].Rep, c7.q3Before),
    'C7d a cell that ALREADY had a record is left byte-identical — it became key-scoped the instant the '
    + 'flag went on, so re-stamping would rewrite a colleague\'s by/at for nothing',
    { before: c7.q3Before, after: c7.after1['Q-3'].Rep });
  check(same(c7.after2, c7.after1) && !c7.toast2.some(m => /now kept against the row key/.test(m)),
    'C7e (THE SECOND HALF) a second save with no change promotes NOTHING and leaves every ds/at '
    + 'untouched', { toast2: c7.toast2, same: same(c7.after2, c7.after1) });
  check(same(c7.onScreen, ['Alice', 'Bob', 'Carol']),
    'C7f and all three values are still on screen — the promotion moved their home, not their value',
    c7.onScreen);

  /* ---------------------------------------------------------------------
     [30] C8 — DECISION S: the flag is DISABLED WITH ITS REASON on a keyless
     template, and ABSENT for a computed column.
     --------------------------------------------------------------------- */
  section(30, 'C8 — DECISION S: disabled with its reason on a keyless template, absent for a computed column');
  const c8 = await cfp.page.evaluate(() => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_NK'; t.name = 'No keys';
    t.columns = ['Ref', 'Amount'].map(n => ({ name: n, label: n, formats: [], isValue: n === 'Amount' }));
    t.primaryKeys = [];
    t.valueColumn = 'Amount';
    t.displayColumns = ['Ref', 'Amount'];
    t.additionalColumns = [{ name: 'Vendor', type: 'custom' },
                           { name: 'Stage', type: 'dropdown', options: ['a', 'b'] },
                           { name: 'Calc', type: 'formula', formula: 'NUM({Amount})*2' },
                           { name: 'Look', type: 'master_lookup',
                             masterCfg: { source: 'accounts', matchColumn: 'Ref', matchKey: 'Reference', returnKey: 'Nominal' } }];
    const cell = n => RecoTemplate._extraConfigCell(t, t.additionalColumns[n], n, []);
    const out = { keyless: { custom: cell(0), dropdown: cell(1), formula: cell(2), lookup: cell(3) } };
    window.__toasts = [];
    RecoTemplate.toggleCarry(0, true);
    out.keylessToggle = { set: !!t.additionalColumns[0].carryForward,
                          msg: ((window.__toasts || [])[0] || {}).msg || '' };
    /* NOW TICK A PRIMARY KEY, which is the case that made #26 refuse decision
       S: the Primary Key block is emitted BEFORE this editor and nothing
       redraws it. The emitted markup for a KEYED template, and the in-place
       patch, are both checked. */
    t.primaryKeys = ['Ref'];
    out.keyed = { custom: cell(0) };
    App.closeModal();
    return out;
  });
  note('C8', { keylessCustom: c8.keyless.custom.slice(0, 200), toggle: c8.keylessToggle });
  check(/class="carry-box"/.test(c8.keyless.custom) && /disabled/.test(c8.keyless.custom)
        && /Needs primary keys/.test(c8.keyless.custom),
    'C8a DECISION S, literally: on a keyless template the box is DISABLED and its reason is beside it',
    c8.keyless.custom.slice(0, 300));
  check(/class="carry-box"/.test(c8.keyless.dropdown) && /disabled/.test(c8.keyless.dropdown),
    'C8b and the same on a `dropdown` column', c8.keyless.dropdown.slice(-300));
  check(!/carry-box/.test(c8.keyless.formula) && !/carry-box/.test(c8.keyless.lookup),
    'C8c and it is ABSENT for a computed column — a formula or a lookup has no typed value to carry; '
    + 'what it has is #26\'s override box', { formula: /carry-box/.test(c8.keyless.formula), lookup: /carry-box/.test(c8.keyless.lookup) });
  check(/Allow manual override per row/.test(c8.keyless.formula),
    'C8d (the control) the computed column does still carry #26\'s override box, so C8c is about the '
    + 'carry box and not about an empty cell', c8.keyless.formula.slice(-240));
  check(c8.keylessToggle.set === false && /needs primary keys/i.test(c8.keylessToggle.msg),
    'C8e and the handler refuses too — a disabled input is a UI state, not a rule', c8.keylessToggle);
  check(/class="carry-box"/.test(c8.keyed.custom) && !/disabled/.test(c8.keyed.custom)
        && /kept against the row key/.test(c8.keyed.custom),
    'C8f on a KEYED template the box is enabled and the help says what it does', c8.keyed.custom.slice(0, 300));

  /* The stale-grey problem #26 named, fixed rather than dodged: the box
     un-greys when a primary key is ticked, with no re-render. */
  const c8sync = await cfp.page.evaluate(() => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_SY'; t.name = 'Sync';
    t.columns = ['Ref', 'Amount'].map(n => ({ name: n, label: n, formats: [], isValue: n === 'Amount' }));
    t.primaryKeys = [];
    t.displayColumns = ['Ref', 'Amount'];
    t.additionalColumns = [{ name: 'Vendor', type: 'custom' }];
    RecoTemplate._step = 2;
    RecoTemplate.renderEditor();
    const box = () => document.querySelector('.carry-box input[type="checkbox"]');
    const help = () => document.querySelector('.carry-box .help');
    const out = { rendered: !!box(), disabledBefore: !!(box() || {}).disabled,
                  helpBefore: ((help() || {}).textContent || '').slice(0, 40) };
    RecoTemplate.togglePK('Ref', true);
    out.keys = RecoTemplate._editing.primaryKeys.slice();
    out.disabledAfter = !!(box() || {}).disabled;
    out.helpAfter = ((help() || {}).textContent || '').slice(0, 40);
    /* and back off again */
    RecoTemplate.togglePK('Ref', false);
    out.disabledAgain = !!(box() || {}).disabled;
    App.closeModal();
    return out;
  });
  note('C8 sync', c8sync);
  check(c8sync.rendered && c8sync.disabledBefore === true && c8sync.disabledAfter === false
        && c8sync.disabledAgain === true && /Needs primary keys/.test(c8sync.helpBefore)
        && !/Needs primary keys/.test(c8sync.helpAfter),
    'C8g THE STALE-GREY PROBLEM, fixed and not dodged: ticking a primary key un-greys the carry box and '
    + 'swaps its reason IN PLACE — no re-render, no element id — and unticking it greys it again', c8sync);

  /* ---------------------------------------------------------------------
     [31] C9 — the Clear-Loaded-Data confirm says what will and will not
     survive. C10 — the Values panel.
     --------------------------------------------------------------------- */
  section(31, 'C9 — the Clear confirm says what survives; C10 — the Values panel');
  const c9 = await cfp.page.evaluate(() => {
    AppState.activeRecoId = 'TPL_CF';
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_CF');
    const sess = AppState.recoSessions.TPL_CF;
    /* A value that CANNOT be stored against a key, so the sentence has both
       halves to report: a spreadsheet single-use scratch column. */
    sess.manualTags = sess.manualTags || {};
    sess.manualTags['nosuchrow||Scratch'] = 'x';
    const manage = Reco.renderManage(tpl, sess);
    const asked = [];
    const realConfirm = window.confirm;
    let cleared = 0;
    const realClear = Reco.clearSession;
    Reco.clearSession = function () { cleared++; };
    try {
      window.confirm = m => { asked.push(String(m)); return false; };
      Reco.confirmClearSession();
      const clearedOnCancel = cleared;
      window.confirm = m => { asked.push(String(m)); return true; };
      Reco.confirmClearSession();
      return { manage: /Reco.confirmClearSession\(\)/.test(manage), asked, clearedOnCancel, cleared,
               typedCount: Reco._typedCount(tpl) };
    } finally { window.confirm = realConfirm; Reco.clearSession = realClear; }
  });
  note('C9', { asked: (c9.asked[0] || '').slice(0, 400), cleared: c9.cleared });
  const c9msg = c9.asked[0] || '';
  check(c9.manage && c9.asked.length === 2,
    'C9a the Manage card routes through Reco.confirmClearSession, which asks once per click', c9);
  check(/KEPT:/.test(c9msg) && /LOST:/.test(c9msg)
        && new RegExp(c9.typedCount + ' value\\(s\\) typed into added columns').test(c9msg)
        && /shared values file/.test(c9msg),
    'C9b the confirm NAMES what survives — the typed values of added columns, with a count — and what '
    + 'does not. The old sentence did not mention them at all, and before S10 a Clear destroyed them',
    c9msg.slice(0, 500));
  check(/live only in this session/.test(c9msg),
    'C9c and it names the values that CANNOT survive (a row with no key, or a scratch column), rather '
    + 'than promising that everything typed is kept', c9msg.slice(0, 500));
  check(c9.clearedOnCancel === 0 && c9.cleared === 1,
    'C9d Cancel clears nothing and OK clears once', c9);

  const c10 = await cfp.page.evaluate(async () => {
    const id = 'TPL_CF';
    AppState.activeRecoId = id;
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    delete sess.manualTags['nosuchrow||Scratch'];
    /* AN ORPHAN (a key from a file that has been closed since) and a DEAD
       COLUMN (a rename, or a column that was deleted), both written through
       S13 the way any other record is. */
    await Reco._extraValueFlush(id, m => {
      const t = m[id] || (m[id] = {});
      (t['INV-99'] || (t['INV-99'] = {})).Vendor =
        { k: 'typed', v: 'Ghost Ltd', ds: 'reco_data/x/Sep-26/01.csv', by: 'Someone', at: '2026-09-01T10:00:00.000Z' };
      (t['INV-2'] || (t['INV-2'] = {})).OldVendor =
        { k: 'typed', v: 'Renamed Co', ds: 'reco_data/x/Sep-26/01.csv', by: 'Someone', at: '2026-09-02T10:00:00.000Z' };
    });
    const list = Reco._typedValueList(tpl, sess).map(it => ({ pk: it.pk, col: it.col, v: it.rec.v,
      inData: it.inData, colGone: it.colGone, carry: it.carry, carried: it.carried, onScreen: it.onScreen }));
    const manage = Reco.renderManage(tpl, sess);
    Reco.openValuesModal();
    const html = (document.getElementById('appModalBody') || document.body).innerHTML;
    const out = { list, html: html,
      manageCard: /Reco.openValuesModal\(\)/.test(manage),
      manageCount: (/Column Values <span class="badge general">(\d+)</.exec(manage) || [])[1],
      hasRemove: (html.match(/Reco\.removeValueRec\(/g) || []).length,
      hasRemoveAll: /Reco\.removeValuesNotLoaded\(\)/.test(html),
      hasColumnGone: /column gone/.test(html),
      hasNotLoaded: /not loaded/.test(html),
      hasAnyFile: /any file/.test(html), hasOwnFile: /its own file/.test(html) };
    /* REMOVE ONE. */
    window.__toasts = [];
    Reco.removeValueRec('INV-99', 'Vendor');
    out.afterOne = !!(((AppState.extraValueMaster || {})[id] || {})['INV-99'] || {}).Vendor;
    out.toastOne = ((window.__toasts || [])[0] || {}).msg || '';
    /* REMOVE ALL FOR KEYS NOT IN THE CURRENT DATA. INV-2's OldVendor record
       IS in the loaded data's key set, so it must SURVIVE - "not loaded" is
       about the KEY, not about the column. */
    const realConfirm = window.confirm;
    let askedAll = '';
    try {
      window.confirm = m => { askedAll = String(m); return true; };
      await Reco._extraValueFlush(id, m => {
        const t = m[id] || (m[id] = {});
        (t['INV-77'] || (t['INV-77'] = {})).Vendor =
          { k: 'typed', v: 'Gone Ltd', ds: 'reco_data/x/Sep-26/01.csv', by: 'Someone', at: '2026-09-03T10:00:00.000Z' };
      });
      Reco.removeValuesNotLoaded();
    } finally { window.confirm = realConfirm; }
    out.askedAll = askedAll;
    const byTpl = (AppState.extraValueMaster || {})[id] || {};
    out.keysAfterAll = Object.keys(byTpl).sort();
    out.inv2Cols = Object.keys(byTpl['INV-2'] || {}).sort();
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    await new Promise(r => setTimeout(r, 400));
    if (typeof Store.idle === 'function') await Store.idle();
    App.closeModal();
    return out;
  });
  note('C10', { list: c10.list, keysAfterAll: c10.keysAfterAll, manageCount: c10.manageCount });
  check(c10.manageCard && c10.manageCount === '4',
    'C10a the Manage screen gains a Column Values card with an honest count of the stored records',
    { card: c10.manageCard, count: c10.manageCount });
  check(c10.list.length === 4 && c10.hasRemove === 4,
    'C10b the panel LISTS every stored value, each with its own Remove', { n: c10.list.length, buttons: c10.hasRemove });
  check(c10.hasNotLoaded && c10.hasColumnGone && c10.hasAnyFile && c10.hasOwnFile,
    'C10c and marks: a key that is not in the loaded data, a column that no longer exists, and the SCOPE '
    + 'of each record (any file vs its own file)', { notLoaded: c10.hasNotLoaded, colGone: c10.hasColumnGone,
      anyFile: c10.hasAnyFile, ownFile: c10.hasOwnFile });
  check(c10.list.some(it => it.colGone && it.col === 'OldVendor')
        && c10.list.filter(it => it.colGone).length === 1,
    'C10d the dead-column record is identified as such, and only it', c10.list);
  check(c10.afterOne === false && /Removed the value on/.test(c10.toastOne),
    'C10e Remove deletes that one record', { still: c10.afterOne, toast: c10.toastOne });
  check(/not in the data loaded right now/.test(c10.askedAll) && /cannot be undone/.test(c10.askedAll),
    'C10f "Remove all for keys not in the current data" asks first, naming the count and that it cannot '
    + 'be undone', c10.askedAll.slice(0, 300));
  check(same(c10.keysAfterAll, ['INV-1', 'INV-2']) && same(c10.inv2Cols, ['OldVendor', 'Vendor']),
    'C10g and it removed exactly the orphan keys: the loaded keys are untouched, INCLUDING the dead '
    + 'column\'s record on a key that IS loaded — "not loaded" is about the key, not the column',
    { keys: c10.keysAfterAll, inv2: c10.inv2Cols });
  const c10disk = diskJson(CF.root, 'reco/extraValueMaster.json');
  check(same(Object.keys((c10disk || {}).TPL_CF || {}).sort(), ['INV-1', 'INV-2']),
    'C10h and the removals reached the SHARED FILE', Object.keys((c10disk || {}).TPL_CF || {}));

  /* ---------------------------------------------------------------------
     [32] C3 (THE GATE) — a 50,000-cell fill-down writes the file ONCE.
     --------------------------------------------------------------------- */
  section(32, 'C3 (THE GATE) — a 50,000-cell fill-down writes reco/extraValueMaster.json ONCE');
  const FILL = makeRoot('share-fill');
  const bridgeFill = await startBridge(FILL.root, PORT_FILL); procs.push(bridgeFill.proc);
  const fp = await openReco(browser, bridgeFill);
  await fp.page.evaluate(`(function () {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_FILL'; t.name = 'Fill';
    t.columns = ['Invoice', 'Amount'].map(n => ({ name: n, label: n, formats: [], isValue: n === 'Amount' }));
    t.primaryKeys = ['Invoice']; t.valueColumn = 'Amount';
    t.displayColumns = ['Invoice', 'Amount'];
    t.additionalColumns = [{ name: 'Vendor', type: 'custom', carryForward: true }];
    RecoTemplate.saveTemplate();
    /* 50,000 rows assigned directly, as run_colorder_e2e's own big fixture
       does: an ingest of 50,000 rows would be measuring Versioning, not the
       store. The rows carry _pk and _dsi, which is what a real loaded file
       gives them. */
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_FILL');
    const sess = Reco.makeSession();
    sess.dataSetIds = ['reco_data/Fill/Oct-26/01.csv'];
    const data = new Array(50000);
    for (let i = 0; i < 50000; i++)
      data[i] = { _id: 'r' + i, _pk: 'INV-' + i, _ver: 'upload', Invoice: 'INV-' + i,
                  Amount: String(i), _dsi: 0 };
    sess.data = data;
    AppState.recoSessions[tpl.id] = sess;
    AppState.activeRecoId = tpl.id;
    return sess.data.length;
  })()`);
  const fillRuns = [];
  for (let i = 0; i < 3; i++) {
    await resetLog(bridgeFill);
    const r = await fp.page.evaluate(async (pass) => {
      const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_FILL');
      const sess = AppState.recoSessions.TPL_FILL;
      /* THE FILL-DOWN: one source value written into 50,000 cells of one
         added column, through the edit pipeline a bulk write uses, with the
         CACHED schema (decision J.5 — without it XlSchema.build and its
         2,000-row numeric scan run per cell). */
      const S = Reco._ovSchema(tpl, sess);
      const edits = new Array(50000);
      for (let i = 0; i < 50000; i++) edits[i] = { row: sess.data[i], col: 'Vendor', value: 'Acme ' + pass };
      const t0 = performance.now();
      const res = await Reco.applyEdits(tpl, sess, edits, { source: 'grid', trusted: true, schema: S });
      const t1 = performance.now();
      await AppState.flush();
      if (typeof Store.idle === 'function') await Store.idle();
      await new Promise(r => setTimeout(r, 400));
      if (typeof Store.idle === 'function') await Store.idle();
      const t2 = performance.now();
      return { applied: res.applied, rejected: res.rejected.length, noop: res.noop,
               editMs: Math.round(t1 - t0), totalMs: Math.round(t2 - t0),
               records: Object.keys((AppState.extraValueMaster || {}).TPL_FILL || {}).length };
    }, i);
    const log = await callLog(bridgeFill);
    fillRuns.push({ ...r, writes: writesOf(log, 'reco/extraValueMaster.json'),
                    sessWrites: writesOf(log, 'reco/recoSessions.json') });
    note('fill pass ' + (i + 1), fillRuns[i]);
  }
  const bestFill = fillRuns.reduce((a, b) => (b.totalMs < a.totalMs ? b : a));
  const maxWrites = Math.max(...fillRuns.map(r => r.writes));
  check(fillRuns.every(r => r.applied === 50000 && r.rejected === 0),
    'C3a all 50,000 cells were applied, none rejected', fillRuns.map(r => ({ a: r.applied, r: r.rejected })));
  check(maxWrites === 1,
    'C3b (THE GATE) write_file for reco/extraValueMaster.json was called EXACTLY ONCE per fill-down, in '
    + 'all three passes — the 150 ms debounce coalesces 50,000 intents into one read-merge-write',
    fillRuns.map(r => r.writes));
  check(fillRuns.every(r => r.records === 50000),
    'C3c and all 50,000 records are in the store', fillRuns.map(r => r.records));
  check(fillRuns.every(r => r.sessWrites === 0),
    'C3f and reco/recoSessions.json was written ZERO times — a fill-down of an added column changes '
    + 'nothing on the session, so the one file that moves is the values file. AppState.save() '
    + 'serialises every persist key (798-1378 ms / 85.6 MiB at 200k rows) to discover that',
    fillRuns.map(r => r.sessWrites));
  const fillDisk = diskJson(FILL.root, 'reco/extraValueMaster.json');
  check(Object.keys((fillDisk || {}).TPL_FILL || {}).length === 50000,
    'C3d and all 50,000 reached the shared FILE', Object.keys((fillDisk || {}).TPL_FILL || {}).length);
  const fillBytes = fs.statSync(path.join(FILL.root, 'reco/extraValueMaster.json')).size;
  note('C3 MEASURED (best of 3, the minimum)', { editMs: bestFill.editMs, totalMs: bestFill.totalMs,
    msPerCell: +(bestFill.editMs / 50000).toFixed(4), fileBytes: fillBytes,
    bytesPerRecord: Math.round(fillBytes / 50000), allPasses: fillRuns.map(r => r.totalMs) });
  check(bestFill.editMs >= 0,
    'C3e the wall clock is reported: ' + bestFill.editMs + ' ms for 50,000 cells ('
    + (bestFill.editMs / 50000).toFixed(4) + ' ms/cell), one write of ' + Math.round(fillBytes / 1024)
    + ' KB', { runs: fillRuns.map(r => ({ editMs: r.editMs, totalMs: r.totalMs, writes: r.writes })) });
  await fp.ctx.close();

  const cfErr = cfp.errors.filter(e => !/Could not save|injected fault/.test(e));
  check(cfErr.length === 0, 'C11 no page error and no console error across the whole #30 run', cfErr.slice(0, 6));
  /* EVERY REFUSAL MESSAGE THIS RUN ACTUALLY PRODUCED, collected from the
     sections that captured them rather than from window.__toasts - which
     several sections reset to read their own, so a census of what is left in
     it at the end would pass on an empty array and prove nothing. */
  const cfRefusals = [c6a.keyword.msg, c6a.postEntry.msg, c6a.aegInput.msg, c6a.clubBy.msg,
    c6a.override.msg, c6a.pkDirect, c6a.toAcctDirect, c6b.kwMsg, c6b.postMsg, c6b.aegMsg,
    c8.keylessToggle.msg].filter(Boolean);
  note('refusal messages this run produced', cfRefusals.map(m => m.slice(0, 70)));
  check(cfRefusals.length === 11
        && cfRefusals.every(m => /needs primary keys|carried forward|only be one of|belongs to the journal|AEG column|row key|To Account/i.test(m)),
    'C12 all 11 refusals this run produced NAME what they protected — not one is a bare "cannot"',
    { n: cfRefusals.length, bare: cfRefusals.filter(m => !/needs primary keys|carried forward|only be one of|belongs to the journal|AEG column|row key|To Account/i.test(m)) });
  const cfLate = (await readToasts(cfp.page)).filter(t => t.kind === 'error');
  check(cfLate.every(t => /already gone|loaded right now|needs primary keys|carried forward/i.test(t.msg)),
    'C12b and no UNEXPECTED error toast was left behind after the last section reset the log',
    cfLate.map(t => t.msg.slice(0, 120)));
  await cfp.ctx.close();

  /* =====================================================================
     THE FIXER ROUND — F1-F12, sections [33]-[43].

     Twenty findings came back from two reviewers against the three phases
     above. These sections pin the ones that were CONFIRMED, each one written
     from the reviewer's own reproduction and asserting on VALUES: what the
     file on the share holds, what the ladder resolves, and what the journal
     preview posts.

     THE FOUR ROOT CAUSES, because most of the twenty are faces of one of
     them and it matters that the fix is at the chokepoint:

       RC-1  THE MERGE COULD NOT EXPRESS A DELETE. Store._mergeJob merged the
             disk object UNDER memory, so a record this session never wrote
             and that somebody else has since deleted was re-imposed on the
             share by our next write. F1.
       RC-2  THE DATA SET WAS THE DAY FILE, so two uploads in one calendar
             day were ONE scope and a value typed on the first appeared on
             the second - unmarked, unconfirmable, and able to decide whether
             a row posts. F2.
       RC-3  THE OVERRIDE'S REFUSALS GUARDED ONLY THE WRITE. A duplicate key
             arriving later, a posted mark that evaporated on reload, a
             delete route that never asked the ledger, and a role matrix that
             asked about the FLAG rather than the records. F3-F6.
       RC-4  A NON-NUMERIC OVERRIDE REACHED A JOURNAL AS A SILENT 0 (or as
             1.23 for a European-formatted 1.234,50), because U.num is what
             NUM() and every report total call. F7.
     ===================================================================== */

  /* ---------------------------------------------------------------------
     [33] F1 (THE GATE) — RC-1. ONE SHARE, TWO PAGES. The preparer reverts an
     override; a colleague who never saw the revert types one unrelated cell;
     the reverted record must NOT come back - not on the share, not on the
     preparer's own screen, and not in the AEG source row the journal is
     built from. The same for a cleared typed value.

     AND THE OTHER DIRECTION IN THE SAME SECTION, because a fix that makes
     disk win everywhere would pass the first half and silently throw away
     the operator's own work: F1f/F1g assert that both pages' own records are
     still in the file and that a record planted on the share by a third
     client is untouched.
     --------------------------------------------------------------------- */
  section(33, 'F1 (THE GATE) — RC-1: a revert is not resurrected by another open page\'s next write');
  const FD = makeRoot('share-fix-del');
  const bridgeFD = await startBridge(FD.root, PORT_FIX_DEL); procs.push(bridgeFD.proc);
  const fd1 = await openReco(browser, bridgeFD);
  await fd1.page.evaluate(OV_SETUP + `([3, 'TPL_FD'])`);
  /* The preparer overrides INV-1 Net 20 -> 1000 and types a Note on INV-3. */
  const fdSet = await fd1.page.evaluate(async () => {
    const sess = AppState.recoSessions.TPL_FD;
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_FD');
    await Reco.setOverride(sess.data[0]._id, 'Net', '1000');
    await Reco.applyEdits(tpl, sess, [{ row: sess.data[2], col: 'Note', value: 'ACME' }],
      { source: 'grid', trusted: true, schema: Reco._ovSchema(tpl, sess) });
    await AppState.flush(); if (Store.idle) await Store.idle();
    await new Promise(r => setTimeout(r, 400)); if (Store.idle) await Store.idle();
    return true;
  });
  const fdDisk0 = diskJson(FD.root, 'reco/extraValueMaster.json');
  check(!!(fdDisk0 && fdDisk0.TPL_FD && fdDisk0.TPL_FD['INV-1'] && fdDisk0.TPL_FD['INV-1'].Net
           && fdDisk0.TPL_FD['INV-3'] && fdDisk0.TPL_FD['INV-3'].Note),
    'F1 premise: the preparer\'s override and typed value are both on the share',
    fdDisk0 && fdDisk0.TPL_FD);
  /* THE COLLEAGUE OPENS THE APP and holds both records in memory. */
  const fd2 = await openReco(browser, bridgeFD);
  const fdBoot = await fd2.page.evaluate(() => {
    AppState.activeRecoId = 'TPL_FD'; AppState.activeSubSection = 'reco';
    return JSON.parse(JSON.stringify((AppState.extraValueMaster || {}).TPL_FD || {}));
  });
  check(!!(fdBoot['INV-1'] && fdBoot['INV-1'].Net && fdBoot['INV-3'] && fdBoot['INV-3'].Note),
    'F1 premise: page 2 booted holding both records — which is the condition under which a stale '
    + 'memory can re-impose them', fdBoot);
  /* THE PREPARER UNDOES BOTH: the override was wrong and the vendor name was wrong. */
  const fdRev = await fd1.page.evaluate(async () => {
    const sess = AppState.recoSessions.TPL_FD;
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_FD');
    const a = await Reco.applyEdits(tpl, sess, [{ row: sess.data[0], col: 'Net', clear: true }],
      { source: 'grid', trusted: true, schema: Reco._ovSchema(tpl, sess) });
    const b = await Reco.applyEdits(tpl, sess, [{ row: sess.data[2], col: 'Note', value: '' }],
      { source: 'grid', trusted: true, schema: Reco._ovSchema(tpl, sess) });
    await AppState.flush(); if (Store.idle) await Store.idle();
    await new Promise(r => setTimeout(r, 400)); if (Store.idle) await Store.idle();
    return { ovApplied: a.applied, tagApplied: b.applied };
  });
  const fdDisk1 = diskJson(FD.root, 'reco/extraValueMaster.json');
  check(fdRev.ovApplied === 1 && !((fdDisk1.TPL_FD || {})['INV-1'] || {}).Net
        && !((fdDisk1.TPL_FD || {})['INV-3'] || {}).Note,
    'F1 premise: both deletions reached the shared file', { fdRev, after: fdDisk1.TPL_FD });
  /* THE COLLEAGUE, who never saw either undo, types ONE UNRELATED CELL. */
  await fd2.page.evaluate(async () => {
    const sess = AppState.recoSessions.TPL_FD;
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_FD');
    await Reco.setOverride(sess.data[1]._id, 'Net', '77');
    await AppState.flush(); if (Store.idle) await Store.idle();
    await new Promise(r => setTimeout(r, 400)); if (Store.idle) await Store.idle();
  });
  const fdDisk2 = diskJson(FD.root, 'reco/extraValueMaster.json') || {};
  note('F1 the share after the colleague\'s unrelated override', fdDisk2.TPL_FD);
  check(!(((fdDisk2.TPL_FD || {})['INV-1']) || {}).Net,
    'F1a (THE GATE) the colleague\'s unrelated edit does NOT resurrect the override the preparer '
    + 'reverted', (fdDisk2.TPL_FD || {})['INV-1']);
  check(!(((fdDisk2.TPL_FD || {})['INV-3']) || {}).Note,
    'F1b and it does not resurrect the typed value the preparer cleared either — every deletion in '
    + 'this store went the same way', (fdDisk2.TPL_FD || {})['INV-3']);
  check(!!(((fdDisk2.TPL_FD || {})['INV-2']) || {}).Net,
    'F1c (control) the colleague\'s OWN record is in the file, so F1a is not passing because nothing '
    + 'was written', (fdDisk2.TPL_FD || {})['INV-2']);
  /* THE PREPARER'S OWN SCREEN AND THE JOURNAL, after their next store write
     re-reads the share inside the merge. */
  const fdMoney = await fd1.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_FD');
    const sess = AppState.recoSessions.TPL_FD;
    await Reco.applyEdits(tpl, sess, [{ row: sess.data[2], col: 'Note', value: 'later' }],
      { source: 'grid', trusted: true, schema: Reco._ovSchema(tpl, sess) });
    await AppState.flush(); if (Store.idle) await Store.idle();
    await new Promise(r => setTimeout(r, 400)); if (Store.idle) await Store.idle();
    Reco._fullPass();
    let net; try { net = String(Reco.rowFull(tpl, sess, sess.data[0]).Net); } finally { Reco._fullEnd(); }
    App.closeModal();
    sess.selectedRows = {}; sess.data.forEach(r => { sess.selectedRows[r._id] = true; });
    Reco.previewEntryFromSelection(false);
    const ctx = Reco._pendingEntry || {};
    const inputs = (ctx.aegInputs || []).map(o => U.num(o[ctx.aegTpl.valueColumn]));
    const srcNets = (ctx.sourceRows || []).map(r => String(r.Net));
    App.closeModal();
    return { net, srcNets, sum: inputs.reduce((a, b) => a + b, 0),
             rec: (((AppState.extraValueMaster || {}).TPL_FD || {})['INV-1'] || {}).Net || null };
  });
  note('F1 the preparer\'s own screen and journal afterwards', fdMoney);
  check(fdMoney.net === '20' && !fdMoney.rec,
    'F1d the preparer\'s own screen still shows the computed 20 they reverted to', fdMoney);
  /* Base 10/20/30 -> Net 20/40/60; INV-2 is overridden to 77 by the colleague,
     which is a legitimate record. 20 + 77 + 60 = 157. The resurrected override
     would make it 1000 + 77 + 60 = 1137. */
  check(fdMoney.sum === 157 && fdMoney.srcNets.join() === '20,77,60',
    'F1e (THE MONEY) and the journal posts 20 + 77 + 60 = 157, not the 1137 the resurrected '
    + 'override would have posted', fdMoney);
  /* THE OTHER DIRECTION: a third client's record written straight onto the
     share must survive our next write, and ours must survive too. */
  const fdThird = await fd1.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_FD');
    const sess = AppState.recoSessions.TPL_FD;
    await Reco.applyEdits(tpl, sess, [{ row: sess.data[1], col: 'Note', value: 'mine' }],
      { source: 'grid', trusted: true, schema: Reco._ovSchema(tpl, sess) });
    await AppState.flush(); if (Store.idle) await Store.idle();
    await new Promise(r => setTimeout(r, 400)); if (Store.idle) await Store.idle();
    return true;
  });
  const fdFile = path.join(FD.root, 'reco/extraValueMaster.json');
  const fdNow = JSON.parse(fs.readFileSync(fdFile, 'utf8'));
  fdNow.TPL_FD['INV-9'] = { Note: { k: 'typed', v: 'A COLLEAGUE', ds: '', by: 'Other',
                                    at: new Date().toISOString() } };
  fs.writeFileSync(fdFile, JSON.stringify(fdNow));
  await fd1.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_FD');
    const sess = AppState.recoSessions.TPL_FD;
    await Reco.applyEdits(tpl, sess, [{ row: sess.data[2], col: 'Note', value: 'again' }],
      { source: 'grid', trusted: true, schema: Reco._ovSchema(tpl, sess) });
    await AppState.flush(); if (Store.idle) await Store.idle();
    await new Promise(r => setTimeout(r, 400)); if (Store.idle) await Store.idle();
  });
  const fdDisk3 = (diskJson(FD.root, 'reco/extraValueMaster.json') || {}).TPL_FD || {};
  check(!!(fdDisk3['INV-9'] && fdDisk3['INV-9'].Note
           && fdDisk3['INV-9'].Note.v === 'A COLLEAGUE'),
    'F1f a record written onto the share by a third client between two of our writes is untouched',
    fdDisk3['INV-9']);
  check(!!(fdDisk3['INV-2'] && fdDisk3['INV-2'].Note && fdDisk3['INV-2'].Note.v === 'mine'
           && fdDisk3['INV-2'].Net && fdDisk3['INV-3'] && fdDisk3['INV-3'].Note.v === 'again'),
    'F1g and this session\'s own records - from THREE separate bursts - are all still there, so the '
    + 'fix is not "the disk always wins"', fdDisk3);
  const fdErr = [...fd1.errors, ...fd2.errors].filter(e => !/Could not save|injected fault/.test(e));
  check(fdErr.length === 0, 'F1h no page error in the two-page run', fdErr.slice(0, 4));
  await fd2.ctx.close();
  await fd1.ctx.close();

  /* ---------------------------------------------------------------------
     [34] F2 (THE GATE) — RC-2. TWO UPLOADS ON ONE CALENDAR DAY, with the
     REAL CLOCK and no stub: a catch-up, a month-end where last period and
     this period are both opened, a corrected file re-uploaded. Both append to
     the same day file, so `Versioning.pathFor` named ONE data set for both
     and a value typed on the first upload was in scope for the second's rows
     - with no carry flag, no accent, no tooltip and nothing to confirm.

     C1 could not catch this because its fixture stubs Versioning.dayFile so
     the two uploads land in different day files. This section is the same
     scenario with the clock left alone, and it carries the money: the added
     dropdown is the AEG keyword column (which S11 permits for a column with
     no flag, and `run_store_e2e` O14a pins that it does), the AEG extras loop
     runs BEFORE the keyword filter, so the leaked value decides whether a row
     posts at all.
     --------------------------------------------------------------------- */
  section(34, 'F2 (THE GATE) — RC-2: two uploads on one calendar day are two data sets');
  const DS = makeRoot('share-fix-ds');
  const bridgeDS = await startBridge(DS.root, PORT_FIX_DS); procs.push(bridgeDS.proc);
  const dsp = await openReco(browser, bridgeDS);
  const f2 = await dsp.page.evaluate(async () => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_F2'; t.name = 'Money';
    t.columns = ['Invoice', 'Amount', 'Reco', 'ToAccount']
      .map(n => ({ name: n, label: n, formats: [], isValue: n === 'Amount' }));
    t.primaryKeys = ['Invoice'];
    t.valueColumn = 'Amount';
    t.displayColumns = t.columns.map(c => c.name);
    /* ONE added dropdown, NO FLAGS AT ALL - carryForward and allowOverride
       are both undefined, which is every template that exists today. */
    t.additionalColumns = [{ name: 'Status', type: 'dropdown', options: 'Open,Closed' },
                           { name: 'AED', type: 'formula', formula: 'NUM({Amount})' }];
    t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id,
      keywordColumn: 'Status', keywordValues: 'Closed', postEntryColumn: '', postEntryValue: '' };
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_F2');
    const out = {};
    /* S11 says NOTHING about an unflagged added column as the keyword column,
       which is what makes this reachable from the editor at all. */
    out.s11 = RecoTemplate._exclusiveRoleConflict(tpl, 'Status', 'aeg.keywordColumn');
    const fields = ['Invoice', 'Amount', 'Reco', 'ToAccount'];
    RecoTemplate.open(tpl.id);
    await Reco.ingestData(tpl, [{ Invoice: 'INV-1', Amount: '1000', Reco: 'R1', ToAccount: 'ACC1' },
                                { Invoice: 'INV-2', Amount: '50', Reco: 'R1', ToAccount: 'ACC1' }], fields);
    App.closeModal();
    AppState.activeRecoId = 'TPL_F2';
    const sess = AppState.recoSessions.TPL_F2;
    /* THE PREPARER MARKS SEPTEMBER'S INV-1 'Closed'. */
    await Reco.applyEdits(tpl, sess, [{ row: sess.data[0], col: 'Status', value: 'Closed' }],
      { source: 'grid', trusted: true, schema: Reco._ovSchema(tpl, sess) });
    out.dayFile = Versioning.pathFor(tpl);
    /* SAME AFTERNOON: "Add Data" of October. Nobody touches the new rows. */
    await Reco.ingestData(tpl, [{ Invoice: 'INV-1', Amount: '2000', Reco: 'R1', ToAccount: 'ACC1' },
                                { Invoice: 'INV-3', Amount: '70', Reco: 'R1', ToAccount: 'ACC1' }], fields);
    App.closeModal();
    await AppState.flush(); if (Store.idle) await Store.idle();
    out.dataSetIds = sess.dataSetIds.slice();
    out.dsi = sess.data.map(r => r._dsi);
    Reco._fullPass();
    try {
      const ac = tpl.additionalColumns.find(a => a.name === 'Status');
      out.status = sess.data.map(r => r.Invoice + ':' + r.Amount + '=' + String(Reco._extraValueForRow(tpl, sess, r, ac)));
      out.marked = sess.data.map(r => !!Reco._extraCarried(tpl, sess, r, 'Status'));
    } finally { Reco._fullEnd(); }
    /* THE JOURNAL, through the real preview. */
    App.closeModal();
    sess.selectedRows = {}; sess.data.forEach(r => { sess.selectedRows[r._id] = true; });
    Reco.previewEntryFromSelection(false);
    const ctx = Reco._pendingEntry || {};
    out.picked = (ctx.sourceRows || []).map(r => r.Invoice + ':' + r.Amount);
    out.sum = (ctx.aegInputs || []).reduce((s, o) => s + U.num(o[ctx.aegTpl.valueColumn]), 0);
    App.closeModal();
    return out;
  });
  note('F2', f2);
  check(f2.s11 === null,
    'F2 premise: S11 permits an UNFLAGGED added column as the AEG keyword column, so this is '
    + 'reachable from the editor and not a hand-built state', { s11: f2.s11 });
  check(f2.dsi.join() === '0,0,1,1' && f2.dataSetIds.length === 2,
    'F2a (THE GATE) two uploads on ONE calendar day are TWO data sets — both append to the same day '
    + 'file, so naming the data set by that file made them one', { ids: f2.dataSetIds, dsi: f2.dsi });
  check(f2.status.join('|') === 'INV-1:1000=Closed|INV-2:50=|INV-1:2000=|INV-3:70=',
    'F2b (THE GATE) September\'s "Closed" is NOT on October\'s row for the same invoice — and it IS '
    + 'still on the row it was typed on, so this is not "nothing was ever typed"', f2.status);
  check(f2.picked.join() === 'INV-1:1000',
    'F2c (THE MONEY) only the row the preparer actually marked reaches the journal', f2.picked);
  check(f2.sum === 1000,
    'F2d and the entry posts 1000, the amount that was marked — not 3000', { sum: f2.sum });
  check(f2.marked.every(m => m === false),
    'F2e and nothing is marked as carried, because nothing was carried (the flag is off)', f2.marked);
  /* THE ROUND TRIP MUST STILL WORK. A record typed against an upload has to
     be honoured when the operator reopens the DAY FILE that upload went into:
     once it is reopened from history the two uploads really are one file and
     cannot be told apart, so the day file is the honest scope then. */
  const f2b = await dsp.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_F2');
    const files = await Versioning.listFiles(tpl);
    const f = files[files.length - 1];
    await Reco.loadVersionedFile(f.fullPath || f.path, tpl.id);
    const sess = AppState.recoSessions.TPL_F2;
    Reco._fullPass();
    try {
      const ac = tpl.additionalColumns.find(a => a.name === 'Status');
      return { ids: sess.dataSetIds.slice(),
               cells: sess.data.map(r => r.Invoice + '=' + String(Reco._extraValueForRow(tpl, sess, r, ac))),
               marked: sess.data.map(r => !!Reco._extraCarried(tpl, sess, r, 'Status')) };
    } finally { Reco._fullEnd(); }
  });
  note('F2 after reopening the day file from history', f2b);
  check(f2b.cells.some(c => c === 'INV-1=Closed'),
    'F2f and the value is STILL honoured when the day file it was typed into is reopened from '
    + 'history — the scope is the upload while both are on screen, and the file once it is one file '
    + 'again', f2b.cells);
  check(f2b.marked.every(m => m === false),
    'F2g ...and it is not marked as carried there either, because it was typed into that file', f2b);
  const f2err = dsp.errors.filter(e => !/Could not save|injected fault/.test(e));
  check(f2err.length === 0, 'F2h no page error in the two-upload run', f2err.slice(0, 4));
  await dsp.ctx.close();

  const allErrors = [...oa.errors, ...ob.errors].filter(e => !/Could not save|injected fault/.test(e));
  check(allErrors.length === 0, 'U5 no page error across the whole run', allErrors.slice(0, 6));

} finally {
  await browser.close();
  for (const p of procs) { try { p.kill('SIGTERM'); } catch (e) {} }
}

console.log('\n' + (failures ? '✗ ' : '✓ ') + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
