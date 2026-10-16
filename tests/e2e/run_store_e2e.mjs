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
 * THE DATA-LOSS ROUND (sections [63]-[68]) adds T-S10-7, T-24R2-1, T-S10-5,
 * T-F2-8, T-26-4 and T-S10-9. Six tickets with one thing in common: every one
 * of them lost somebody's work SILENTLY - no toast, no confirm, no row in the
 * CSV - which is why every assertion in them reads a FILE or a VALUE (what is
 * on the share, what the next upload mints, what the entry posts) and never a
 * toast on its own. Their own gates:
 *
 *   S107  EVERY TEMPLATE FIELD, not the two flags RC-12 special-cased. A save
 *         from a 09:00 clone reverted a colleague's 10:00 display order with
 *         "Template saved to database" the only thing said. S107j-S107m are
 *         the DELETED pendingCount SKIP: the reconciliation used to sit out
 *         exactly the case where the operator had just typed.
 *   S241  A KEY-DEFINITION change is REFUSED and not merged, and the gate is
 *         what the NEXT UPLOAD MINTS: 8 distinct _pk for 4 business rows
 *         before, 4 after, one upload from each of two pages.
 *   S105  A column renamed AND moved in one save keeps its values (_cid), and
 *         S105g-S105h pin the SLOT fallback that older builds still need.
 *   F28   A dropped row-level edit says so - and F28d is the control that a
 *         working edit still says NOTHING, because editCell runs on every
 *         cell commit in the app.
 *   T264  A row already in the ledger is NAMED with its accounting reference
 *         and can be dropped with one press - and nothing about what the
 *         entry posts changes until somebody presses it (Z1h2).
 *   S109  Typing the folder could not take is kept on THIS PC and replayed
 *         through the same merge write, with a PER-CELL TIMESTAMP GUARD.
 *         S109h-S109j test the LOSING case as hard as the winning one, and
 *         S109m-S109p pin the other end of the journal's life: a folder that
 *         comes back on its own must leave the journal EMPTY.
 *
 * Ports 20800-20862 (phase 1: 20801-20805; #26: 20821-20823;
 * #30: 20842-20846; the fixer rounds: 20847-20862), the money round's
 * 21140-21158, and the data-loss round's 21240-21248.
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
const PORT_FIX_CLR  = 20858;   // R6  F9's other half: a Clear, then a different extract
/* ROUND 3 (fixer 2). The reviewer ids are F6/F11-F13/F15/F17-F20. Three of
   the ports above were declared for exactly these sections and never used
   (COL, SAY, SPL, DRAG); the last three are new, which moves the suite's
   range to 20800-20861. */
const PORT_FIX_KIND = 20859;   // F6  one orphan record vs the exported kind
const PORT_FIX_STPL = 20860;   // F13 two colleagues saving one template
const PORT_FIX_CONF = 20861;   // F20 the three settings that change what is read
const PORT_FIX_BIGF = 20862;   // F15 a values file past the measured ceiling
/* NOT A GATE, AND IT MUST NOT READ LIKE ONE. e9851b4 is the build these
   assertions were shown to FAIL against, recorded for whoever wants to repeat
   that; this suite's whole-build comparison is done with APP_REV / APP_FILE,
   which are separate and are what the runner actually passes. Two readers of
   this file counted the constant below as a fifth pinned byte-identity
   baseline — there are FOUR (colorder 76dffed, pk_extras 3047f82, correction
   d9957fc, panes 5f61d76) and this is not one of them. Kept as a comment
   rather than a const so nothing can mistake it for a gate again.
   FAIL-AGAINST BUILD: e9851b4 */

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

/* ===========================================================================
   THE MONEY ROUND'S OWN FIXTURES (Z1, T-26-5, T-26-6, T-S10-1, T-30-3).
   Kept together and apart from the fixtures above because every one of them
   needs a LINKED AEG TEMPLATE and a posted entry, which none of the store
   fixtures has: this family is about what reaches the general ledger.

   Ports 21140-21159 are this round's.
=========================================================================== */
const PORT_Z1    = 21140;   // Z1       a formula that cannot be worked out
const PORT_Z1KW  = 21141;   // Z1       the same, on the KEYWORD column
const PORT_T265  = 21142;   // T-26-5   a non-numeric cell in a report total
const PORT_T266  = 21143;   // T-26-6   a posted key that becomes duplicated
const PORT_S101  = 21144;   // T-S10-1  two colleagues generating entries
const PORT_T303  = 21145;   // T-30-3   the promotion on a duplicate key

/* Z1's FIXTURE. An FX revaluation: Base is the foreign-currency amount, Rate
   is the rate of the day, and the added `formula` column AED is the
   conversion. 'AED' is already the name of the default AEG template's
   valueColumn AND one of its input columns, so this template links with no
   re-mapping at all - which is the point: nothing here is contrived.
   INV-3's Rate cell is 0, which is a blank or zero rate on one line of an
   extract, and NUM(500)/NUM(0) is Infinity, which Formula._result turns into
   '#ERR'. INV-3 is the LARGEST of the three by Base. */
const Z1_SETUP = `(async function (arg) {
  const [agg] = arg;
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_Z'; t.name = 'FX reval';
  t.columns = ['Invoice','Base','Rate','Reco','ToAccount','Cur','Doc','Desc','Date','Account']
    .map(n => ({ name:n, label:n, formats:[], isValue:n==='Base' }));
  t.primaryKeys = ['Invoice'];
  t.valueColumn = 'Base'; t.docNumberColumn = 'Doc';
  t.displayColumns = t.columns.map(c => c.name);
  t.additionalColumns = [{ name:'AED', type:'formula', formula:'NUM({Base})/NUM({Rate})' }];
  t.enableReporting = true;
  t.reports = [{ name:'R', columns:['Invoice','Base','Rate','AED'], showTotalRow:true, totalColumns:['AED'] }];
  const aegTpl = AppState.aegTemplates[0];
  aegTpl.aggregate = !!agg;
  aegTpl.aggregateBy = agg ? ['Reco','ToAccount'] : [];
  t.aegIntegration = { enabled:true, aegTemplateId: aegTpl.id,
    keywordColumn:'', keywordValues:'', postEntryColumn:'Reco', postEntryValue:'POSTED' };
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_Z');
  RecoTemplate.open(tpl.id);
  const F = ['Invoice','Base','Rate','Reco','ToAccount','Cur','Doc','Desc','Date','Account'];
  const spec = [
    ['INV-1','100','2','R1','ACC1','AED','D1','one','01/01/26','ACC1'],
    ['INV-2','300','3','R1','ACC1','AED','D2','two','01/01/26','ACC1'],
    ['INV-3','500','0','R1','ACC1','AED','D3','three','01/01/26','ACC1']
  ];
  await Reco.ingestData(tpl, spec.map(x => { const o={}; F.forEach((f,i)=>o[f]=x[i]); return o; }), F);
  App.closeModal(); AppState.activeRecoId = tpl.id;
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return true;
})`;

/* The same cell off five surfaces, then the refusal - AND the figure the old
   build posted, measured here by handing Reco._buildEntryLines the very
   source rows the preview builds, so the 150 in this suite's header is a
   measurement and not a quotation. */
const Z1_SURFACES = `(async function () {
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_Z');
  const sess = AppState.recoSessions.TPL_Z;
  const row = sess.data.find(r => r._pk === 'INV-3');
  const ac = tpl.additionalColumns.find(a => a.name === 'AED');
  const out = {};
  App.navigate('reco');
  const tr = document.querySelector('tbody tr[data-rid="' + CSS.escape(row._id) + '"]');
  const td = tr && tr.querySelector('td[data-col="AED"]');
  const inp = td && td.querySelector('input');
  out.grid = inp ? inp.value : (td ? td.textContent.trim() : null);
  Reco._fullPass();
  try { out.ladder = String(Reco._extraValueForRow(tpl, sess, row, ac)); } finally { Reco._fullEnd(); }
  out.reportCell = String((Reco.runReport(tpl, sess, tpl.reports[0]).find(r => r.Invoice === 'INV-3') || {}).AED);
  window.__dl = [];
  const rd = U.download;
  U.download = function (n, txt) { window.__dl.push({ name:n, text:String(txt) }); };
  try { Reco.exportData('csv'); } finally { U.download = rd; }
  const csv = (window.__dl[0] || {}).text || '';
  const head = csv.split(/\\r?\\n/)[0].split(',');
  const line = csv.split(/\\r?\\n/).find(l => l.indexOf('INV-3') !== -1) || '';
  out.csv = (line.split(',')[head.indexOf('AED')] || '');
  const built = await ExcelLink.buildExport(tpl, sess,
    { rows:'all', columns:'asShown', includeComputed:true, protect:'soft', dateFormat:'dd-mmm-yyyy' }, 'S');
  const ci = built.head.columns.findIndex(c => c.key === 'AED');
  const cell = (built.cells.find(l => l[1] === 'INV-3') || [])[ci];
  out.workbook = (cell && typeof cell === 'object') ? cell.v : cell;
  App.closeModal();

  /* WHAT THE OLD BUILD POSTED. The enriched rows are exactly what the AEG
     extras loop produces for a formula column, so this is _buildEntryLines
     reading '#ERR' through U.num - the one line that turned a broken formula
     into a zero. */
  const aegTpl = AppState.aegTemplates.find(x => x.id === tpl.aegIntegration.aegTemplateId);
  const enriched = sess.data.map(r => Reco._rowWithExtras(tpl, sess, r));
  out.aegSourceRows = enriched.map(r => r._pk + '=' + String(r.AED));
  const inputs = enriched.map(r => {
    const o = {};
    aegTpl.inputColumns.forEach(ic => { o[ic.name] = r[ic.name] != null ? r[ic.name] : (r[ic.label] != null ? r[ic.label] : ''); });
    if (o[aegTpl.valueColumn] === '' || o[aegTpl.valueColumn] == null)
      o[aegTpl.valueColumn] = r[tpl.valueColumn] != null && r[tpl.valueColumn] !== '' ? r[tpl.valueColumn] : 0;
    return o;
  });
  const lc = Reco._jvLineCols(aegTpl);
  const val = (l, k) => { const v = l[k]; return U.num(v && typeof v === 'object' ? v.value : v); };
  out.wouldPost = Reco._buildEntryLines(aegTpl, inputs, '', '').reduce((s, l) => s + val(l, lc.dr), 0);

  // ...and now the real door.
  sess.selectedRows = {}; sess.data.forEach(r => { sess.selectedRows[r._id] = true; });
  Reco._pendingEntry = null;
  window.__toasts = [];
  Reco.previewEntryFromSelection(false);
  const pend = Reco._pendingEntry;
  out.pending = pend ? { rows: (pend.sourceRows || []).length, lines: (pend.lines || []).length } : null;
  out.refused = !pend;
  out.toasts = (window.__toasts || []).map(t => t.kind + ': ' + t.msg);
  out.refusal = out.toasts.join(' | ');
  /* AND THE COMMIT IS ATTEMPTED ANYWAY, so Z1e reads entryHistory after a
     real attempt to post rather than inferring it from the refusal. A gate
     that only checks _pendingEntry survives a mutant that removes the
     refusal but changes nothing else. */
  if (pend) Reco.commitEntryFromPreview();
  App.closeModal();
  out.histLen = ((AppState.entryHistory || {}).TPL_Z || []).length;
  await AppState.flush(); if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
  return out;
})`;

/* The control: correct the rate and the same selection posts 250. */
const Z1_FIXRATE = `(async function () {
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_Z');
  const sess = AppState.recoSessions.TPL_Z;
  const row = sess.data.find(r => r._pk === 'INV-3');
  await Reco.applyEdits(tpl, sess, [{ row: row, col: 'Rate', value: '5' }], { source:'grid', trusted:true });
  sess.selectedRows = {}; sess.data.forEach(r => { sess.selectedRows[r._id] = true; });
  Reco._pendingEntry = null;
  window.__toasts = [];
  Reco.previewEntryFromSelection(false);
  const ctx = Reco._pendingEntry;
  const out = { refused: !ctx, toasts: (window.__toasts||[]).map(t => t.kind + ': ' + t.msg) };
  if (ctx) {
    const lc = Reco._jvLineCols(ctx.aegTpl);
    const val = (l, k) => { const v = l[k]; return U.num(v && typeof v === 'object' ? v.value : v); };
    Reco.commitEntryFromPreview();
    const hist = (AppState.entryHistory || {}).TPL_Z || [];
    const e = hist[hist.length - 1];
    out.postedDr = e ? (e.lines || []).reduce((s, l) => s + val(l, lc.dr), 0) : null;
    out.accountingId = e ? e.accountingId : null;
  }
  App.closeModal();
  out.histLen = ((AppState.entryHistory || {}).TPL_Z || []).length;
  await AppState.flush(); if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
  return out;
})`;

/* SCOPE. 'Memo' reads #ERR on every row and the linked AEG template never
   reads it: not an input column, not the value column, not an aggregateBy,
   not an account column, not the keyword column. Refusing on it would change
   what an existing template can post, which is the objection T-26-4 was
   deferred for. */
const Z1_SCOPE = `(async function () {
  RecoTemplate.edit('TPL_Z');
  RecoTemplate._editing.additionalColumns.push(
    { name:'Memo', type:'formula', formula:'NUM({Base})/NUM({NoSuchColumn})' });
  RecoTemplate.saveTemplate();
  App.closeModal();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_Z');
  const sess = AppState.recoSessions.TPL_Z;
  AppState.activeRecoId = 'TPL_Z';
  const out = { memo: String(Reco._rowWithExtras(tpl, sess, sess.data[0]).Memo) };
  sess.selectedRows = {}; sess.data.forEach(r => { sess.selectedRows[r._id] = true; });
  Reco._pendingEntry = null;
  window.__toasts = [];
  Reco.previewEntryFromSelection(false);
  /* T-26-4 PASSES THROUGH THIS UNCHANGED, and that is the point of its
     default. Z1g posted these three rows a moment ago, so T-26-4's warning
     fires here - and the rows are still IN the entry, because dropping them
     by default would have made this section (and run_jv_gen, and
     run_jv_engine) post a quietly smaller entry than the selection. Asserted
     below as out.reposted. */
  const ctx = Reco._pendingEntry;
  out.refused = !ctx;
  out.reposted = !!(ctx && ctx.postedIncluded);
  out.warned = !!(ctx && (ctx.postedRows || []).length);
  out.toasts = (window.__toasts||[]).map(t => t.kind + ': ' + t.msg);
  if (ctx) {
    const lc = Reco._jvLineCols(ctx.aegTpl);
    const val = (l, k) => { const v = l[k]; return U.num(v && typeof v === 'object' ? v.value : v); };
    Reco.commitEntryFromPreview();
    const hist = (AppState.entryHistory || {}).TPL_Z || [];
    const e = hist[hist.length - 1];
    out.postedDr = e ? (e.lines || []).reduce((s, l) => s + val(l, lc.dr), 0) : null;
  }
  App.closeModal();
  out.histLen = ((AppState.entryHistory || {}).TPL_Z || []).length;
  await AppState.flush(); if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
  return out;
})`;

/* THE KEYWORD COLUMN. A computed keyword column - a band, a converted amount,
   a rounded rate - is an ordinary shape, and whatever its values are the
   point is the same: the cell that could NOT be worked out is the cell that
   dropped the row from the filter. A check over the SURVIVING rows can never
   see it. */
const Z1_KEYWORD = `(async function () {
  RecoTemplate.edit('TPL_Z');
  const t = RecoTemplate._editing;
  t.additionalColumns.push({ name:'Band', type:'formula', formula:'NUM({Base})/NUM({Rate})' });
  t.aegIntegration.keywordColumn = 'Band';
  t.aegIntegration.keywordValues = '50,100';
  RecoTemplate.saveTemplate();
  App.closeModal();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_Z');
  const sess = AppState.recoSessions.TPL_Z;
  AppState.activeRecoId = 'TPL_Z';
  const allowed = ['50','100'];
  const bands = sess.data.map(r => String(Reco._rowWithExtras(tpl, sess, r).Band));
  const out = { bands: bands, kwCol: tpl.aegIntegration.keywordColumn,
                droppedByFilter: bands.filter(b => allowed.indexOf(b) === -1).length };
  sess.selectedRows = {}; sess.data.forEach(r => { sess.selectedRows[r._id] = true; });
  Reco._pendingEntry = null;
  window.__toasts = [];
  Reco.previewEntryFromSelection(false);
  out.refused = !Reco._pendingEntry;
  out.toasts = (window.__toasts||[]).map(t => t.kind + ': ' + t.msg);
  out.refusal = out.toasts.join(' | ');
  if (Reco._pendingEntry) Reco.commitEntryFromPreview();
  App.closeModal();
  out.histLen = ((AppState.entryHistory || {}).TPL_Z || []).length;
  return out;
})`;

/* T-26-5's FIXTURE. Two rows worth 40 and 60 - 100 between them - and a third
   whose Net is typed over by hand. */
const T265_SETUP = `(async function () {
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_R'; t.name = 'Totals';
  t.columns = ['Invoice','Base'].map(n => ({ name:n, label:n, formats:[], isValue:n==='Base' }));
  t.primaryKeys = ['Invoice'];
  t.valueColumn = 'Base';
  t.displayColumns = ['Invoice','Base'];
  t.additionalColumns = [{ name:'Net', type:'formula', formula:'NUM({Base})*2', allowOverride:true }];
  t.enableReporting = true;
  t.reports = [{ name:'R', columns:['Invoice','Net'], showTotalRow:true, totalColumns:['Net'] }];
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R');
  RecoTemplate.open(tpl.id);
  await Reco.ingestData(tpl, [{ Invoice:'INV-1', Base:'20' }, { Invoice:'INV-2', Base:'30' },
                              { Invoice:'INV-3', Base:'5' }], ['Invoice','Base']);
  App.closeModal(); AppState.activeRecoId = 'TPL_R';
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return true;
})`;

const T265_TOTAL = `(async function (arg) {
  const [value] = arg;
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R');
  const sess = AppState.recoSessions.TPL_R;
  const row = sess.data.find(r => r._pk === 'INV-3');
  await Reco.setOverride(row._id, 'Net', value);
  const rpt = tpl.reports[0];
  const rows = Reco.runReport(tpl, sess, rpt);
  const out = { cells: rows.map(r => String(r.Net)),
                naive: rows.reduce((s, r) => s + U.num(r.Net), 0) };
  const d = document.createElement('div');
  d.innerHTML = Reco.renderCustomReport(tpl, sess, rpt, 0);
  const td = d.querySelector('td[data-total-col="Net"]');
  const nt = d.querySelector('[data-total-note]');
  out.totalText = td ? td.textContent.trim() : null;
  out.totalSum  = td ? Number(td.getAttribute('data-total-sum')) : null;
  out.excluded  = td ? Number(td.getAttribute('data-total-excluded')) : null;
  out.note = nt ? nt.textContent.replace(/\\s+/g, ' ').trim() : '';
  await Reco.revertOverride(row._id, 'Net');
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return out;
})`;

/* T-26-6's FIXTURE. INV-7 is overridden to 1000 where the formula says 20,
   and the entry is POSTED with the 1000 in it. INV-8 is overridden too and
   is NEVER posted - the control that keeps the new sentence from naming an
   accounting reference that does not exist. */
const T266_SETUP = `(async function () {
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_6'; t.name = 'Posted then duplicated';
  t.columns = ['Invoice','Base','Reco','ToAccount','Cur','Doc','Desc','Date','Account']
    .map(n => ({ name:n, label:n, formats:[], isValue:n==='Base' }));
  t.primaryKeys = ['Invoice'];
  t.valueColumn = 'Base'; t.docNumberColumn = 'Doc';
  t.displayColumns = t.columns.map(c => c.name);
  t.additionalColumns = [{ name:'AED', type:'formula', formula:'NUM({Base})*2', allowOverride:true }];
  const aegTpl = AppState.aegTemplates[0];
  aegTpl.aggregate = true; aegTpl.aggregateBy = ['Reco','ToAccount'];
  t.aegIntegration = { enabled:true, aegTemplateId: aegTpl.id,
    keywordColumn:'', keywordValues:'', postEntryColumn:'Desc', postEntryValue:'POSTED' };
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_6');
  RecoTemplate.open(tpl.id);
  const F = ['Invoice','Base','Reco','ToAccount','Cur','Doc','Desc','Date','Account'];
  const spec = [['INV-7','10','R1','ACC1','AED','D7','seven','01/01/26','ACC1'],
                ['INV-8','10','R2','ACC1','AED','D8','eight','01/01/26','ACC1']];
  await Reco.ingestData(tpl, spec.map(x => { const o={}; F.forEach((f,i)=>o[f]=x[i]); return o; }), F);
  App.closeModal(); AppState.activeRecoId = 'TPL_6';
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return true;
})`;

const T266_RUN = `(async function () {
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_6');
  const sess = AppState.recoSessions.TPL_6;
  const ac = tpl.additionalColumns.find(a => a.name === 'AED');
  const r7 = sess.data.find(r => r._pk === 'INV-7');
  const r8 = sess.data.find(r => r._pk === 'INV-8');
  await Reco.setOverride(r7._id, 'AED', '1000');
  await Reco.setOverride(r8._id, 'AED', '2000');
  const out = {};
  // POST INV-7 ONLY, so INV-8's override is stored and unposted.
  sess.selectedRows = {}; sess.selectedRows[r7._id] = true;
  Reco._pendingEntry = null;
  Reco.previewEntryFromSelection(false);
  const ctx = Reco._pendingEntry;
  if (!ctx) { out.refused = true; return out; }
  const lc = Reco._jvLineCols(ctx.aegTpl);
  const val = (l, k) => { const v = l[k]; return U.num(v && typeof v === 'object' ? v.value : v); };
  Reco.commitEntryFromPreview();
  App.closeModal();
  const hist = (AppState.entryHistory || {}).TPL_6 || [];
  const e = hist[hist.length - 1];
  out.accountingId = e.accountingId;
  out.postedDr = (e.lines || []).reduce((s, l) => s + val(l, lc.dr), 0);
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();

  /* NEXT WEEK'S FILE brings a second line under each invoice number, which is
     the ordinary shape of an AP extract. */
  window.__toasts = [];
  Versioning.dayFile = () => '02.csv';
  const F = ['Invoice','Base','Reco','ToAccount','Cur','Doc','Desc','Date','Account'];
  const more = [['INV-7','10','R1','ACC1','AED','D7b','seven again','02/01/26','ACC1'],
                ['INV-8','10','R2','ACC1','AED','D8b','eight again','02/01/26','ACC1']];
  await Reco.ingestData(tpl, more.map(x => { const o={}; F.forEach((f,i)=>o[f]=x[i]); return o; }), F);
  const body = document.getElementById('appModalBody');
  out.panel = body ? body.innerHTML : '';
  const pb = body && body.querySelector('[data-dup-posted]');
  out.postedBlock = pb ? pb.textContent.replace(/\\s+/g, ' ').trim() : '';
  App.closeModal();
  out.dupCount = Reco._dupPkCountFor(tpl, sess, 'INV-7');
  Reco._fullPass();
  try { out.screenAfter = String(Reco._extraValueForRow(tpl, sess, sess.data.find(r => r._pk === 'INV-7'), ac)); }
  finally { Reco._fullEnd(); }
  const rec = ((AppState.extraValueMaster || {}).TPL_6 || {})['INV-7'] || {};
  out.recStill = rec.AED ? String(rec.AED.v) : null;
  out.unpostedNamed = out.panel.indexOf('INV-8') !== -1;
  out.unpostedRefd  = out.postedBlock.indexOf('INV-8') !== -1;
  return out;
})`;

/* T-S10-1's FIXTURE. Six rows so two pages can post different ones; a
   document number column, because docNumberMaster is the other half of the
   ticket. No added columns at all, so nothing here depends on Z1. */
const S101_SETUP = `(async function () {
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_E'; t.name = 'Two colleagues';
  t.columns = ['Invoice','Base','Reco','ToAccount','Cur','Doc','Desc','Date','Account']
    .map(n => ({ name:n, label:n, formats:[], isValue:n==='Base' }));
  t.primaryKeys = ['Invoice'];
  t.valueColumn = 'Base'; t.docNumberColumn = 'Doc';
  t.displayColumns = t.columns.map(c => c.name);
  t.additionalColumns = [];
  const aegTpl = AppState.aegTemplates[0];
  aegTpl.aggregate = true; aegTpl.aggregateBy = ['Reco','ToAccount'];
  t.aegIntegration = { enabled:true, aegTemplateId: aegTpl.id,
    keywordColumn:'', keywordValues:'', postEntryColumn:'Desc', postEntryValue:'POSTED' };
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_E');
  RecoTemplate.open(tpl.id);
  const F = ['Invoice','Base','Reco','ToAccount','Cur','Doc','Desc','Date','Account'];
  const spec = [];
  for (let i = 1; i <= 6; i++) spec.push(['INV-'+i, String(i*10), 'R1', 'ACC1', 'AED', 'D'+i, 'r'+i, '01/01/26', 'ACC1']);
  await Reco.ingestData(tpl, spec.map(x => { const o={}; F.forEach((f,i)=>o[f]=x[i]); return o; }), F);
  App.closeModal(); AppState.activeRecoId = 'TPL_E';
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return true;
})`;

const S101_POST = `(async function (arg) {
  const [pks] = arg;
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_E');
  const sess = AppState.recoSessions.TPL_E;
  AppState.activeRecoId = 'TPL_E';
  sess.selectedRows = {};
  sess.data.forEach(r => { if (pks.indexOf(r._pk) !== -1) sess.selectedRows[r._id] = true; });
  Reco._pendingEntry = null;
  window.__toasts = [];
  Reco.previewEntryFromSelection(false);
  const ctx = Reco._pendingEntry;
  const out = { refused: !ctx, toasts: (window.__toasts||[]).map(t => t.kind + ': ' + t.msg) };
  if (ctx) {
    const lc = Reco._jvLineCols(ctx.aegTpl);
    const val = (l, k) => { const v = l[k]; return U.num(v && typeof v === 'object' ? v.value : v); };
    Reco.commitEntryFromPreview();
    const hist = (AppState.entryHistory || {}).TPL_E || [];
    const e = hist[hist.length - 1];
    out.accountingId = e ? e.accountingId : null;
    out.dr = e ? (e.lines||[]).reduce((s,l)=>s+val(l,lc.dr),0) : null;
  }
  App.closeModal();
  out.histLen = ((AppState.entryHistory || {}).TPL_E || []).length;
  await AppState.flush();
  if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
  return out;
})`;

/* A document number allocated BY HAND. It mutates an entry INSIDE
   entryHistory, so the merge intent has to re-find that entry on the file it
   has just read rather than mutating a copy the read has already replaced. */
const S101_ALLOC = `(async function () {
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_E');
  AppState.activeRecoId = 'TPL_E';
  const hist = (AppState.entryHistory || {}).TPL_E || [];
  const e = hist[0];
  Reco.openAllocateModal(e.accountingId);
  const inp = document.getElementById('alloc_AED');
  if (inp) inp.value = 'GL-9001';
  Reco.saveAllocation();
  App.closeModal();
  await AppState.flush();
  if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
  return { accountingId: e.accountingId, hadInput: !!inp,
           docNumbers: JSON.parse(JSON.stringify(e.docNumbers || {})) };
})`;

/* T-30-3's FIXTURE. Three templates, because the three answers cannot share
   one: TPL_C is answered YES, TPL_D is answered NO, and TPL_Q has no
   duplicate keys at all and must be asked nothing.
     INV-7  two rows, 'Alice' and 'Bob'   -> a conflict: the promotion cannot pick
     INV-8  one row, 'Carol'              -> promoted, as before
     INV-9  two rows, 'Dave' and 'Dave'   -> NOT a conflict: nothing to pick between */
const T303_SETUP = `(async function () {
  const mk = async (id, name, rows) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = id; t.name = name;
    t.columns = ['Invoice','Base'].map(n => ({ name:n, label:n, formats:[], isValue:n==='Base' }));
    t.primaryKeys = ['Invoice'];
    t.valueColumn = 'Base';
    t.displayColumns = ['Invoice','Base'];
    t.additionalColumns = [{ name:'Vendor', type:'custom' }];
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    RecoTemplate.open(tpl.id);
    await Reco.ingestData(tpl, rows.map(r => ({ Invoice:r[0], Base:r[1] })), ['Invoice','Base']);
    App.closeModal();
    const sess = AppState.recoSessions[id];
    /* THE LEGACY HOME, seeded directly - which is what every one of these
       values is on a share today, because the promotion is the one-time move
       OUT of it. */
    rows.forEach((r, i) => { if (r[2]) sess.manualTags[Reco._tagKey(sess.data[i], 'Vendor')] = r[2]; });
    return tpl;
  };
  const dup = [['INV-7','10','Alice'], ['INV-7','10','Bob'], ['INV-8','10','Carol'],
               ['INV-9','10','Dave'], ['INV-9','10','Dave']];
  await mk('TPL_C', 'Conflict yes', dup);
  await mk('TPL_D', 'Conflict no', dup);
  await mk('TPL_Q', 'No duplicates', [['INV-1','10','Zoe'], ['INV-2','10',''], ['INV-3','10','']]);
  AppState.activeRecoId = 'TPL_C';
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return true;
})`;

const T303_RUN = `(async function (arg) {
  const [tplId, answer] = arg;
  RecoTemplate.edit(tplId);
  RecoTemplate._editing.additionalColumns.find(a => a.name === 'Vendor').carryForward = true;
  const asks = [];
  const real = window.confirm;
  window.confirm = m => { asks.push(String(m)); return !!answer; };
  window.__toasts = [];
  try { RecoTemplate.saveTemplate(); } finally { window.confirm = real; }
  App.closeModal();
  await new Promise(r => setTimeout(r, 60));
  await AppState.flush(); if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
  const tpl = AppState.recoTemplates.find(x => x.id === tplId);
  const sess = AppState.recoSessions[tplId];
  const conflictText = asks.filter(m => /hold two different|different value/i.test(m)).join(' | ');
  return {
    asked: asks.length > 0,
    allAsks: asks,
    conflictText: conflictText,
    promoted: (window.__toasts || []).reduce((n, t) => {
      const m = String(t.msg).match(/^(\\d+) value\\(s\\) already on screen/); return m ? Number(m[1]) : n; }, 0),
    toasts: (window.__toasts || []).map(t => t.kind + ': ' + t.msg),
    rows: sess.data.map(r => {
      const tag = sess.manualTags[Reco._tagKey(r, 'Vendor')];
      const rec = Reco._extraRec(tpl, sess, r, 'Vendor');
      return { pk: r._pk, tag: tag === undefined ? null : String(tag), rec: rec ? String(rec.v) : null };
    })
  };
})`;


/* ===========================================================================
   THE FIX ROUND'S OWN FIXTURES (MR-1, MR-2, MR-4, MR-6, T-S10-10, and the
   re-measurements of T-26-5 / T-26-6 / T-30-3). Ports 21146-21156.
=========================================================================== */
const PORT_MR1OV = 21146;   // MR-1   an override on an '#ERR' cell
const PORT_MR1J8 = 21147;   // MR-1   decision J.8 is still honoured
const PORT_MR1JV = 21148;   // MR-1   the Special JV door
const PORT_MR2  = 21149;   // MR-2  a failed ledger write is retried
const PORT_MR4  = 21150;   // MR-4  the boot latch on the two ledger keys
const PORT_MR6  = 21151;   // MR-6  Generate refused on a latched ledger
const PORT_S109  = 21152;   // T-S10-10 two colleagues, genuinely overlapped
const PORT_DNU   = 21153;   // MR-7  one document number, two entries
const PORT_T266S = 21154;   // T-26-6 the colleague who did not post it

/* ---- MR-1, DOOR ONE. Z1's refusal sends the operator to "correct the data
   the formula reads, or correct the formula" - and the override box is the
   one tool this app gives them for correcting a computed cell by hand. The
   AEG extras loop's override gate runs BEFORE the formula arm, so an
   overridden cell never enters badFx; and RC-8 only fired when rec.prev was
   NUMERIC, which for an '#ERR' cell it is not. Measured before the fix: an
   override of "'500" posted Dr 150 for three rows worth 150 + INV-3, and
   '1.234,50' posted Dr 151.23. */
const MR1_OV = `(async function (arg) {
  const [value] = arg;
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_Z');
  const sess = AppState.recoSessions.TPL_Z;
  AppState.activeRecoId = 'TPL_Z';
  const ac = tpl.additionalColumns.find(a => a.name === 'AED');
  ac.allowOverride = true;
  const row = sess.data.find(r => r._pk === 'INV-3');
  window.__toasts = [];
  await Reco.setOverride(row._id, 'AED', value);
  const out = { override: (((AppState.extraValueMaster||{}).TPL_Z||{})['INV-3']||{}).AED || null };
  Reco._fullPass();
  try { out.cell = String(Reco._extraValueForRow(tpl, sess, row, ac)); } finally { Reco._fullEnd(); }
  sess.selectedRows = {}; sess.data.forEach(r => { sess.selectedRows[r._id] = true; });
  Reco._pendingEntry = null;
  window.__toasts = [];
  Reco.previewEntryFromSelection(false);
  out.refused = !Reco._pendingEntry;
  out.toasts = window.__toasts.map(t => t.kind + ': ' + t.msg);
  if (!out.refused) {
    const lc = Reco._jvLineCols(Reco._pendingEntry.aegTpl);
    const val = (l, k) => { const v = l[k]; return U.num(v && typeof v === 'object' ? v.value : v); };
    Reco.commitEntryFromPreview();
    const hist = (AppState.entryHistory||{}).TPL_Z || [];
    const e = hist[hist.length - 1];
    out.accountingId = e ? e.accountingId : null;
    out.dr = e ? (e.lines||[]).reduce((s,l)=>s+val(l,lc.dr),0) : null;
  }
  App.closeModal();
  out.histLen = ((AppState.entryHistory||{}).TPL_Z || []).length;
  out.stamped = sess.data.filter(r => String(r.Reco) === 'POSTED').map(r => r._pk);
  await Reco.revertOverride(row._id, 'AED');
  await AppState.flush(); if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
  return out;
})`;

/* ---- MR-1, AND WHAT IT MUST NOT DO. Decision J.8: a column that was
   TEXTUAL ALL ALONG is not an amount, and an override on it exports as text
   and does NOT refuse a posting. The relaxation above is scoped to a column
   THIS ENTRY READS, so this template - whose overridden column the linked AEG
   template never reads - must post exactly as it did before. */
const MR1_J8 = `(async function () {
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_J8'; t.name = 'J.8';
  t.columns = ['Invoice','Base','Reco','ToAccount','Cur','Doc','Desc','Date','Account']
    .map(n => ({ name:n, label:n, formats:[], isValue:n==='Base' }));
  t.primaryKeys = ['Invoice']; t.valueColumn = 'Base'; t.docNumberColumn = 'Doc';
  t.displayColumns = t.columns.map(c => c.name);
  /* 'Memo' is not an input column, not the value column, not an aggregateBy,
     not an account column and not the keyword column - the same scope Z1h
     uses. It is a FORMULA column, because an override only exists on a
     formula or a master-lookup column (on a custom column the same write is
     a k:'typed' record), and it works out to something that is NOT a number -
     which is decision J.8's own case: a column whose kind is DERIVED from its
     values and which was textual all along. RC-8 already refuses a
     non-numeric override whose prev WAS numeric, on any column at all, and
     that half is deliberately untouched; MR-1 changed only the other half,
     where prev is not a number either. */
  t.additionalColumns = [{ name:'Memo', type:'formula', formula:'{Desc}', allowOverride: true }];
  const aegTpl = AppState.aegTemplates[0];
  aegTpl.aggregate = true; aegTpl.aggregateBy = ['Reco','ToAccount'];
  t.aegIntegration = { enabled:true, aegTemplateId: aegTpl.id, keywordColumn:'', keywordValues:'',
                       postEntryColumn:'Desc', postEntryValue:'POSTED' };
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_J8');
  RecoTemplate.open(tpl.id);
  const F = ['Invoice','Base','Reco','ToAccount','Cur','Doc','Desc','Date','Account'];
  const mk = a => { const o={}; F.forEach((f,i)=>o[f]=a[i]); return o; };
  await Reco.ingestData(tpl, [mk(['INV-1','100','R1','ACC1','AED','D1','one','01/01/26','ACC1']),
                              mk(['INV-2','300','R1','ACC1','AED','D2','two','01/01/26','ACC1'])], F);
  App.closeModal(); AppState.activeRecoId = 'TPL_J8';
  const sess = AppState.recoSessions.TPL_J8;
  // the cell is not a number; text over text is J.8's own case
  await Reco.setOverride(sess.data[0]._id, 'Memo', 'see email');
  const out = { rec: (((AppState.extraValueMaster||{}).TPL_J8||{})['INV-1']||{}).Memo || null };
  sess.selectedRows = {}; sess.data.forEach(r => { sess.selectedRows[r._id] = true; });
  Reco._pendingEntry = null; window.__toasts = [];
  Reco.previewEntryFromSelection(true);
  out.refused = !Reco._pendingEntry;
  out.toasts = window.__toasts.map(t => t.kind + ': ' + t.msg);
  if (!out.refused) {
    const lc = Reco._jvLineCols(Reco._pendingEntry.aegTpl);
    const val = (l, k) => { const v = l[k]; return U.num(v && typeof v === 'object' ? v.value : v); };
    Reco.commitEntryFromPreview();
    const hist = (AppState.entryHistory||{}).TPL_J8 || [];
    const e = hist[hist.length - 1];
    out.dr = e ? (e.lines||[]).reduce((s,l)=>s+val(l,lc.dr),0) : null;
  }
  App.closeModal();
  await AppState.flush(); if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
  return out;
})`;

/* ---- MR-1, DOOR TWO. A bucketed row's amount is read by its own Special
   JV's inputColumns, never by the AEG template's, and the split that buckets
   it used to happen BELOW both refusals. Measured before the fix: the preview
   refused nothing, Reco handed the JV page "AED":"#ERR", and an aggregating
   JV posted Dr 150 for three rows worth 650 with all three stamped POSTED.
   `jvReads` says whether the JV's spec reads AED, which is the control. */
const MR1_JV = `(async function (arg) {
  const [jvReads] = arg;
  SpecialJV.registry['TCHX'] = { ref:'TCHX', displayName:'TCH exchange',
    htmlPath:'special_jv_templates/TCHX.html', retired:false,
    inputColumns: jvReads ? [{ name:'AED', label:'AED' }, { name:'Invoice', label:'Invoice' }]
                          : [{ name:'Base', label:'Base' }, { name:'Invoice', label:'Invoice' }] };
  if (SpecialJV.resetOptions) SpecialJV.resetOptions();
  const tid = jvReads ? 'TPL_JV1' : 'TPL_JV0';
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = tid; t.name = 'jv door ' + tid;
  t.columns = ['Invoice','Base','Rate','Reco','ToAccount','Cur','Doc'].map(n =>
    ({ name:n, label:n, formats:[], isValue:n==='Base' }));
  t.primaryKeys = ['Invoice']; t.valueColumn = 'Base'; t.docNumberColumn = 'Doc';
  t.displayColumns = t.columns.map(c => c.name);
  t.additionalColumns = [{ name:'AED', type:'formula', formula:'NUM({Base})/NUM({Rate})' }];
  const aegTpl = AppState.aegTemplates[0];
  aegTpl.aggregate = false; aegTpl.aggregateBy = [];
  /* The AEG template does NOT read AED here: strip it, so the ONLY reader of
     AED is the JV. That is exactly the premise Z1h asserts must not refuse. */
  aegTpl.inputColumns = (aegTpl.inputColumns||[]).filter(c => c.name !== 'AED');
  aegTpl.valueColumn = 'Base';
  t.aegIntegration = { enabled:true, aegTemplateId: aegTpl.id, keywordColumn:'', keywordValues:'',
                       postEntryColumn:'Reco', postEntryValue:'POSTED' };
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === tid);
  RecoTemplate.open(tpl.id);
  const F = ['Invoice','Base','Rate','Reco','ToAccount','Cur','Doc'];
  const mk = a => { const o={}; F.forEach((f,i)=>o[f]=a[i]); return o; };
  await Reco.ingestData(tpl, [mk(['INV-1','100','2','','TCHX','AED','D1']),
                              mk(['INV-2','300','3','','TCHX','AED','D2']),
                              mk(['INV-3','500','0','','TCHX','AED','D3'])], F);
  App.closeModal(); AppState.activeRecoId = tid;
  const sess = AppState.recoSessions[tid];
  const out = { cells: sess.data.map(r => r._pk + '=' +
    String(Reco._extraValueForRow(tpl, sess, r, tpl.additionalColumns[0]))) };
  sess.selectedRows = {}; sess.data.forEach(r => { sess.selectedRows[r._id] = true; });
  Reco._pendingEntry = null; window.__toasts = [];
  Reco.previewEntryFromSelection(true);
  out.refused = !Reco._pendingEntry;
  out.toasts = window.__toasts.map(t => t.kind + ': ' + String(t.msg));
  if (!out.refused) {
    out.buckets = Object.keys(Reco._pendingEntry.jvBuckets)
      .map(k => k + '=' + Reco._pendingEntry.jvBuckets[k].length);
    let seen = null;
    const realOpen = SpecialJV.open;
    SpecialJV.open = function (ref, payload, cb) {
      seen = JSON.parse(JSON.stringify(payload));
      const amt = jvReads ? 'AED' : 'Base';
      const tot = payload.reduce((s, p) => s + U.num(p[amt]), 0);
      cb({ type:'jvResult', ref: ref, jvId: 'JV_X',
           lines: [{ Dr: tot.toFixed(2), Cr: '', Cur:'AED', Ref:'ACC1' },
                   { Dr: '', Cr: tot.toFixed(2), Cur:'AED', Ref:'ACC2' }],
           primaryKeys: payload.map(p => p._pk), inputData: payload });
    };
    try { Reco.openSpecialJv('TCHX'); } finally { SpecialJV.open = realOpen; }
    out.payload = (seen || []).map(p => p._pk + '=' + String(p.AED == null ? '' : p.AED));
    Reco.previewEntryFromSelection(true);
    if (Reco._pendingEntry) {
      const lc = Reco._jvLineCols(Reco._pendingEntry.aegTpl);
      const val = (l, k) => { const v = l[k]; return U.num(v && typeof v === 'object' ? v.value : v); };
      Reco.commitEntryFromPreview();
      const hist = (AppState.entryHistory||{})[tid] || [];
      const e = hist[hist.length - 1];
      out.accountingId = e ? e.accountingId : null;
      out.dr = e ? (e.lines||[]).reduce((s,l)=>s+val(l,lc.dr),0) : null;
    }
  }
  App.closeModal();
  out.histLen = ((AppState.entryHistory||{})[tid] || []).length;
  out.stamped = sess.data.filter(r => String(r.Reco) === 'POSTED').map(r => r._pk);
  await AppState.flush(); if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
  return out;
})`;

/* ---- MR-2. A FAILED LEDGER WRITE IS RETRIED. The write-failure path armed
   no timer at all and m.intents is cleared only on success, so a posted
   journal entry stayed buffered for the rest of the session while its rows
   were stamped POSTED on the share. `down` holds the fault for that many ms,
   then the folder answers again and the operator carries on working. */
const MR2_RUN = `(async function (arg) {
  const [down] = arg;
  const api = window.pywebview.api;
  const realWrite = api.write_file;
  let faulting = true;
  api.write_file = function (rel, txt) {
    if (faulting && String(rel) === 'reco/entryHistory.json')
      return Promise.reject(new Error('OSError: the shared folder refused the write'));
    return realWrite.apply(api, arguments);
  };
  const out = {};
  try {
    const r = await (async () => {
      const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_E');
      const sess = AppState.recoSessions.TPL_E;
      AppState.activeRecoId = 'TPL_E';
      sess.selectedRows = {};
      sess.data.forEach(x => { if (['INV-1','INV-2'].indexOf(x._pk) !== -1) sess.selectedRows[x._id] = true; });
      Reco._pendingEntry = null; window.__toasts = [];
      Reco.previewEntryFromSelection(true);
      if (!Reco._pendingEntry) return { refused: true };
      const lc = Reco._jvLineCols(Reco._pendingEntry.aegTpl);
      const val = (l, k) => { const v = l[k]; return U.num(v && typeof v === 'object' ? v.value : v); };
      Reco.commitEntryFromPreview();
      const hist = (AppState.entryHistory||{}).TPL_E || [];
      const e = hist[hist.length - 1];
      App.closeModal();
      await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
      return { accountingId: e.accountingId, dr: (e.lines||[]).reduce((s,l)=>s+val(l,lc.dr),0) };
    })();
    Object.assign(out, r);
    out.whileDown = { lastError: Store.lastError ? Store.lastError.key + ': ' + Store.lastError.message : null,
                      problems: Store.loadProblems.filter(s => /could not be written/.test(s)).length,
                      pending: AppState.pendingCount() };
    await new Promise(r2 => setTimeout(r2, down));
  } finally {
    faulting = false;
    api.write_file = realWrite;
  }
  /* The operator carries on working. Nothing retypes the entry. */
  for (let i = 0; i < 6; i++) {
    const sess = AppState.recoSessions.TPL_E;
    sess.page = (sess.page || 0) + 1;
    AppState.save();
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    await new Promise(r2 => setTimeout(r2, 60));
  }
  await AppState.flush(); if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
  out.after = { pending: AppState.pendingCount(),
                problems: Store.loadProblems.filter(s => /could not be written/.test(s)).length };
  return out;
})`;

/* ---- MR-6. The ledger is latched read-only for the session (a damaged
   reco/entryHistory.json at boot), so this entry can NEVER reach the share.
   Generate used to go ahead and stamp the rows anyway. */
const MR6_RUN = `(async function () {
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_E');
  const sess = AppState.recoSessions.TPL_E;
  AppState.activeRecoId = 'TPL_E';
  sess.selectedRows = {};
  sess.data.forEach(x => { if (['INV-1','INV-2'].indexOf(x._pk) !== -1) sess.selectedRows[x._id] = true; });
  Reco._pendingEntry = null; window.__toasts = [];
  Reco.previewEntryFromSelection(true);
  const out = { previewRefused: !Reco._pendingEntry, latched: !!Store.readOnlyKeys.entryHistory,
                bootProblems: Store.loadProblems.slice(),
                quarantined: 0 };
  if (Reco._pendingEntry) Reco.commitEntryFromPreview();
  out.modal = (document.getElementById('appModalBody') || {}).textContent || '';
  out.histLen = ((AppState.entryHistory||{}).TPL_E || []).length;
  out.stamped = sess.data.filter(r => String(r.Desc) === 'POSTED').map(r => r._pk);
  out.toasts = (window.__toasts||[]).map(t => t.kind + ': ' + t.msg);
  App.closeModal();
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return out;
})`;

/* ---- MR-7. One document number, two entries. Nothing tested whether the
   number typed was already taken, so two colleagues could both be told
   "Document numbers saved" and leave the shared master naming one of them
   while BOTH entries claimed it. */
const DNU_RUN = `(async function (arg) {
  const [which, dn] = arg;
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_E');
  AppState.activeRecoId = 'TPL_E';
  const hist = (AppState.entryHistory||{}).TPL_E || [];
  const e = hist[which] || hist[hist.length - 1];
  window.__toasts = [];
  Reco.openAllocateModal(e.accountingId);
  const inp = document.getElementById('alloc_AED');
  if (inp) inp.value = dn;
  Reco.saveAllocation();          // synchronous on purpose — see MR-7 in Reco.saveAllocation
  App.closeModal();
  await AppState.flush(); if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
  return { accountingId: e.accountingId, hadInput: !!inp,
           docNumbers: JSON.parse(JSON.stringify(e.docNumbers || {})),
           toasts: (window.__toasts||[]).map(t => t.kind + ': ' + t.msg) };
})`;

/* ---- T-S10-10. GENUINELY OVERLAPPED, Promise.all and not await-then-await:
   section [52] drives its two pages one after the other, which is the one
   timing at which the merge cannot lose anything. */
/* ---- T-S10-11's RESIDUE, MADE DETERMINISTIC. The per-window suffix takes a
   same-millisecond collision from 1 in 1 to about 1 in 1,296, which no test
   can wait for. So the mint is PINNED to one string in both windows, which is
   exactly the state the two windows were in before the suffix existed, and the
   question becomes the one that matters: when the reference really is taken,
   is the entry still recorded? The old append answered no — it skipped on the
   reference alone, so the second window's write was a silent no-op. */
const S111_PIN = `(function (arg) {
  const [pinned] = arg;
  U.accountingId = function () { return pinned; };
  return U.accountingId();
})`;

const S109_POST = `(async function (arg) {
  const [pks] = arg;
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_E');
  const sess = AppState.recoSessions.TPL_E;
  AppState.activeRecoId = 'TPL_E';
  sess.selectedRows = {};
  sess.data.forEach(r => { if (pks.indexOf(r._pk) !== -1) sess.selectedRows[r._id] = true; });
  Reco._pendingEntry = null; window.__toasts = [];
  Reco.previewEntryFromSelection(true);
  if (!Reco._pendingEntry) return { refused: true };
  Reco.commitEntryFromPreview();
  const hist = (AppState.entryHistory||{}).TPL_E || [];
  const e = hist[hist.length - 1];
  App.closeModal();
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return { accountingId: e.accountingId };
})`;

/* T-26-6's SHARE FIXTURE: page B boots BEFORE the entry is posted, so its
   in-memory entry history is {} - and B is the one who loads next week's
   extract. */
const T266S_SETUP = `(async function () {
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_6S'; t.name = 'posted then duplicated';
  t.columns = ['Invoice','Base','Reco','ToAccount','Cur','Doc','Desc','Date','Account']
    .map(n => ({ name:n, label:n, formats:[], isValue:n==='Base' }));
  t.primaryKeys = ['Invoice']; t.valueColumn = 'Base'; t.docNumberColumn = 'Doc';
  t.displayColumns = t.columns.map(c => c.name);
  t.additionalColumns = [{ name:'AED', type:'formula', formula:'NUM({Base})*2', allowOverride:true }];
  const aegTpl = AppState.aegTemplates[0];
  aegTpl.aggregate = true; aegTpl.aggregateBy = ['Reco','ToAccount'];
  t.aegIntegration = { enabled:true, aegTemplateId: aegTpl.id, keywordColumn:'', keywordValues:'',
                       postEntryColumn:'Desc', postEntryValue:'POSTED' };
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_6S');
  RecoTemplate.open(tpl.id);
  const F = ['Invoice','Base','Reco','ToAccount','Cur','Doc','Desc','Date','Account'];
  const mk = a => { const o={}; F.forEach((f,i)=>o[f]=a[i]); return o; };
  await Reco.ingestData(tpl, [mk(['INV-7','10','R1','ACC1','AED','D7','seven','01/01/26','ACC1']),
                              mk(['INV-8','10','R1','ACC1','AED','D8','eight','01/01/26','ACC1'])], F);
  App.closeModal(); AppState.activeRecoId = 'TPL_6S';
  const sess = AppState.recoSessions.TPL_6S;
  await Reco.setOverride(sess.data.find(r => r._pk === 'INV-7')._id, 'AED', '1000');
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return true;
})`;

const T266S_POST = `(async function () {
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_6S');
  const sess = AppState.recoSessions.TPL_6S;
  AppState.activeRecoId = 'TPL_6S';
  sess.selectedRows = {};
  sess.data.forEach(r => { if (r._pk === 'INV-7') sess.selectedRows[r._id] = true; });
  Reco._pendingEntry = null; window.__toasts = [];
  Reco.previewEntryFromSelection(true);
  if (!Reco._pendingEntry) return { refused: true, toasts: window.__toasts.map(t=>t.msg) };
  const lc = Reco._jvLineCols(Reco._pendingEntry.aegTpl);
  const val = (l, k) => { const v = l[k]; return U.num(v && typeof v === 'object' ? v.value : v); };
  Reco.commitEntryFromPreview();
  const hist = (AppState.entryHistory||{}).TPL_6S || [];
  const e = hist[hist.length - 1];
  App.closeModal();
  await AppState.flush(); if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
  await new Promise(r => setTimeout(r, 1200));
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return { accountingId: e.accountingId, dr: (e.lines||[]).reduce((s,l)=>s+val(l,lc.dr),0) };
})`;

const T266S_LOAD = `(async function () {
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_6S');
  AppState.activeRecoId = 'TPL_6S';
  Versioning.dayFile = () => '02.csv';
  const F = ['Invoice','Base','Reco','ToAccount','Cur','Doc','Desc','Date','Account'];
  const mk = a => { const o={}; F.forEach((f,i)=>o[f]=a[i]); return o; };
  window.__toasts = [];
  const bootHist = JSON.stringify((AppState.entryHistory||{}).TPL_6S || []);
  await Reco.ingestData(tpl, [mk(['INV-7','10','R1','ACC1','AED','D7b','seven again','02/01/26','ACC1']),
                              mk(['INV-8','10','R1','ACC1','AED','D8b','eight again','02/01/26','ACC1'])], F);
  for (let i = 0; i < 80 && document.querySelector('[data-dup-posted-pending]'); i++)
    await new Promise(r => setTimeout(r, 50));
  const body = document.getElementById('appModalBody');
  const pb = body && body.querySelector('[data-dup-posted]');
  const out = { bootHist: bootHist,
                posted: pb ? pb.textContent.replace(/\\s+/g, ' ').trim() : '' };
  App.closeModal();
  return out;
})`;


const PORT_T303B = 21155;   // T-30-3  declining is recoverable
const PORT_T265B = 21156;   // T-26-5  a column with nothing to add

/* ---- T-30-3. DECLINING IS A REAL DECISION AND A RECOVERABLE ONE. The
   confirm used to be asked from inside the promotion, i.e. AFTER the template
   had been stored, so Cancel saved it with carry-forward ON and - the
   promotion being offered once per column, EVER - was never offered again:
   the operator declined, went and fixed the duplicate rows, came back, and
   the feature they had switched on was silently off for that column for good.
   `again` saves a second time and answers YES. */
const T303B_RUN = `(async function (arg) {
  const [tplId, answer, again] = arg;
  const run = (ans) => {
    RecoTemplate.edit(tplId);
    const col = RecoTemplate._editing.additionalColumns.find(a => a.name === 'Vendor');
    col.carryForward = true;
    const asks = [];
    const real = window.confirm;
    window.confirm = m => { asks.push(String(m)); return !!ans; };
    window.__toasts = [];
    try { RecoTemplate.saveTemplate(); } finally { window.confirm = real; }
    App.closeModal();
    return asks;
  };
  const out = { asks1: run(answer) };
  await new Promise(r => setTimeout(r, 80));
  await AppState.flush(); if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
  const stored = () => {
    const t = AppState.recoTemplates.find(x => x.id === tplId);
    const c = (t.additionalColumns || []).find(a => a.name === 'Vendor');
    return !!(c && c.carryForward === true);
  };
  out.flag1 = stored();
  const rows = () => {
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const sess = AppState.recoSessions[tplId];
    return sess.data.map(r => {
      const rec = Reco._extraRec(tpl, sess, r, 'Vendor');
      return r._pk + '=' + (rec ? String(rec.v) : '-');
    });
  };
  out.rows1 = rows();
  if (again) {
    out.asks2 = run(true);
    await new Promise(r => setTimeout(r, 80));
    await AppState.flush(); if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
    out.flag2 = stored();
    out.rows2 = rows();
    out.toasts2 = (window.__toasts || []).map(t => t.kind + ': ' + t.msg);
  }
  return out;
})`;

/* ---- T-30-3. A conflict NOTHING WOULD HAVE PROMOTED. A (key, column) that
   already has a stored record is short-circuited by Reco._extraRec, so both
   its rows have been reading one record all along and neither legacy value
   was ever a candidate - yet the dialog raised it, and said those keys "are
   therefore being LEFT ALONE" about values that were already not in use. */
const T303C_RUN = `(async function () {
  const tplId = 'TPL_P';
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = tplId; t.name = 'already stored';
  t.columns = ['Invoice','Base'].map(n => ({ name:n, label:n, formats:[], isValue:n==='Base' }));
  t.primaryKeys = ['Invoice']; t.valueColumn = 'Base'; t.displayColumns = ['Invoice','Base'];
  t.additionalColumns = [{ name:'Vendor', type:'custom' }, { name:'Note', type:'custom' }];
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === tplId);
  RecoTemplate.open(tpl.id);
  const rows = [['INV-7','10','Alice'], ['INV-7','10','Bob'], ['INV-8','10','Carol']];
  await Reco.ingestData(tpl, rows.map(r => ({ Invoice:r[0], Base:r[1] })), ['Invoice','Base']);
  App.closeModal();
  const sess = AppState.recoSessions[tplId];
  rows.forEach((r, i) => { sess.manualTags[Reco._tagKey(sess.data[i], 'Vendor')] = r[2]; });
  /* A record already serving BOTH rows of INV-7, planted THROUGH THE REAL
     WRITE so it reaches the share: a record only in memory is dropped by the
     next merge, because for the ids this file owns the share is the authority
     (Store._takeDisk) - which is exactly what made the first version of this
     fixture lie. */
  const rec0 = { k:'typed', v:'ALREADY STORED', ds:'', by:'x', at:'' };
  AppState.extraValueMaster = AppState.extraValueMaster || {};
  AppState.extraValueMaster[tplId] = { 'INV-7': { Vendor: rec0 } };
  Reco._extraValueFlush(tplId, map => {
    (map[tplId] || (map[tplId] = {}))['INV-7'] = { Vendor: rec0 };
  });
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  RecoTemplate.edit(tplId);
  RecoTemplate._editing.additionalColumns.forEach(a => { a.carryForward = true; });
  const asks = [];
  const real = window.confirm;
  window.confirm = m => { asks.push(String(m)); return true; };
  window.__toasts = [];
  try { RecoTemplate.saveTemplate(); } finally { window.confirm = real; }
  App.closeModal();
  await new Promise(r => setTimeout(r, 80));
  await AppState.flush(); if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
  return { asks: asks, toasts: (window.__toasts||[]).map(t => t.kind + ': ' + t.msg),
           rows: sess.data.map(r => { const rec = Reco._extraRec(tpl, sess, r, 'Vendor');
             return r._pk + '=' + (rec ? String(rec.v) : '-'); }) };
})`;

/* ---- T-26-5. A column where EVERY cell was excluded. The total rendered
   "0.00 *" - a number that is not a total of anything - while the Sum card
   for the same column, twenty lines up, already answered the better way. */
const T265B_RUN = `(async function () {
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_N0'; t.name = 'nothing to add';
  t.columns = ['Invoice','Base'].map(n => ({ name:n, label:n, formats:[], isValue:n==='Base' }));
  t.primaryKeys = ['Invoice']; t.valueColumn = 'Base'; t.displayColumns = ['Invoice','Base'];
  t.additionalColumns = [{ name:'Net', type:'formula', formula:'NUM({Base})', allowOverride:true }];
  t.enableReporting = true;
  t.reports = [{ name:'R', columns:['Invoice','Net'], showTotalRow:true, totalColumns:['Net'],
                 summaryCards:[{ col:'Net', func:'Sum' }] }];
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_N0');
  RecoTemplate.open(tpl.id);
  await Reco.ingestData(tpl, [{Invoice:'INV-1',Base:'40'},{Invoice:'INV-2',Base:'60'}], ['Invoice','Base']);
  App.closeModal(); AppState.activeRecoId = 'TPL_N0';
  const sess = AppState.recoSessions.TPL_N0;
  await Reco.setOverride(sess.data[0]._id, 'Net', 'n/a');
  await Reco.setOverride(sess.data[1]._id, 'Net', 'tbc');
  const rpt = tpl.reports[0];
  const rows = Reco.runReport(tpl, sess, rpt);
  const tot = Reco._reportColumnTotal(rows, 'Net');
  const d = document.createElement('div');
  d.innerHTML = Reco.renderCustomReport(tpl, sess, rpt, 0);
  const td = d.querySelector('td[data-total-col="Net"]');
  const nt = d.querySelector('[data-total-note]');
  const card = Array.from(d.querySelectorAll('.card')).map(c => c.textContent.replace(/\\s+/g,' ').trim());
  const out = { cells: rows.map(r => String(r.Net)), total: tot,
                totalText: td ? td.textContent.trim() : null,
                totalSum: td ? td.getAttribute('data-total-sum') : null,
                excluded: td ? td.getAttribute('data-total-excluded') : null,
                note: nt ? nt.textContent.replace(/\\s+/g,' ').trim() : '', cards: card };
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return out;
})`;


/* ===========================================================================
   THE DATA-LOSS ROUND'S FIXTURES (T-S10-7, T-24R2-1, T-S10-5, T-F2-8,
   T-S10-9, T-26-4). Every one of these tickets loses somebody's work
   SILENTLY, so every assertion below reads a FILE or a VALUE — what is on the
   share, what the next upload mints, what the entry posts — and never a toast
   on its own.

   Ports 21240-21259 are this round's.
=========================================================================== */
const PORT_S107  = 21240;   // T-S10-7  two colleagues saving one template
const PORT_S107P = 21241;   // T-S10-7  the skip that fired when the operator had just typed
const PORT_24R21 = 21242;   // T-24R2-1 the key-definition refusal
const PORT_S105  = 21243;   // T-S10-5  a rename AND a reorder in one save
const PORT_F28   = 21244;   // T-F2-8   a row-level edit whose row has gone
const PORT_S109J = 21245;   // T-S10-9  the local journal and its replay
const PORT_S109G = 21246;   // T-S10-9  the replay's per-cell timestamp guard
const PORT_264   = 21247;   // T-26-4   a row that is already in the ledger
const PORT_S109R = 21248;   // T-S10-9  the folder comes back and the journal clears itself

/* T-S10-9's fixture: the same keyed template with FOUR rows, because the
   measurement this closes is four typed values and an empty store. */
const S109_SETUP = `(async function () {
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_R'; t.name = 'Race';
  t.columns = ['Invoice','Amount','Note'].map(n => ({ name:n, label:n, formats:[], isValue:n==='Amount' }));
  t.primaryKeys = ['Invoice'];
  t.valueColumn = 'Amount';
  t.displayColumns = ['Invoice','Amount','Note'];
  t.additionalColumns = [{ name:'Vendor', type:'custom' }];
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R');
  RecoTemplate.open(tpl.id);
  await Reco.ingestData(tpl, [1,2,3,4].map(i => ({ Invoice:'INV-'+i, Amount:String(i*100), Note:'n'+i })),
                        ['Invoice','Amount','Note']);
  App.closeModal();
  AppState.activeRecoId = 'TPL_R';
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return true;
})`;

/* T-S10-9. THE SHARE STOPS ANSWERING READS for the values file - injected at
   the api seam, which is where a dropped network folder really fails, and the
   same injection X1 uses. mergeWrite then REFUSES rather than writes (it will
   not replace a colleague's file with whatever this session holds), so the
   typing stays buffered, is retried four times on a widening gap, and is
   owed when the window closes. */
const S109_TYPE_DOWN = `(async function (arg) {
  const [pairs] = arg;
  const realRead = window.pywebview.api.read_file;
  window.__fault = true;
  window.pywebview.api.read_file = function (rel) {
    if (window.__fault && /extraValue/.test(String(rel)))
      return Promise.reject(new Error('the shared folder did not answer'));
    return realRead.apply(this, arguments);
  };
  window.__toasts = [];
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R');
  const sess = AppState.recoSessions.TPL_R;
  const res = await Reco.applyEdits(tpl, sess,
    pairs.map(([i, v]) => ({ row: sess.data[i], col: 'Vendor', value: v })),
    { source: 'grid', trusted: true });
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  /* EXHAUST THE RETRY BUDGET: _RETRY_MAX 4 at MERGE_DELAY * 2**n =
     300 / 600 / 1,200 / 2,400 ms. Nothing is typed again - the point is that
     what was typed cannot reach the folder by itself. */
  await new Promise(r => setTimeout(r, 5200));
  if (typeof Store.idle === 'function') await Store.idle();
  const out = { applied: res.applied,
    pending: AppState.pendingCount(),
    cells: sess.data.map(r => r._pk + '=' + String((((AppState.extraValueMaster.TPL_R || {})[r._pk] || {}).Vendor || {}).v || '')),
    journal: Store._jrnlRead().map(x => x.pk + '/' + x.col + '=' + String((x.rec || {}).v) + '@' + x.at),
    base: Store._jrnlBase,
    toasts: (window.__toasts || []).map(t => t.kind + ': ' + t.msg) };
  /* THE LEAVE GATE, ANSWERED "LEAVE ANYWAY" — the answer T-S10-6 left open. */
  const asks = [];
  const real = window.confirm;
  window.confirm = m => { asks.push(String(m)); return true; };
  try { out.leftAnyway = App._pendingLeaveOk(); } finally { window.confirm = real; }
  out.gate = asks;
  window.__fault = false;
  window.pywebview.api.read_file = realRead;
  return out;
})`;

/* THE FOLDER COMES BACK BY ITSELF, with nothing typed again. The journal has
   to EMPTY, or the next boot offers values that are already on the share and
   the guard then skips every one of them while naming the operator as the
   colleague who holds the newer value. */
const S109_RECOVER = `(async function (arg) {
  const [pairs] = arg;
  const realRead = window.pywebview.api.read_file;
  window.__fault = true;
  window.pywebview.api.read_file = function (rel) {
    if (window.__fault && /extraValue/.test(String(rel)))
      return Promise.reject(new Error('the shared folder did not answer'));
    return realRead.apply(this, arguments);
  };
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R');
  const sess = AppState.recoSessions.TPL_R;
  await Reco.applyEdits(tpl, sess, pairs.map(([i, v]) => ({ row: sess.data[i], col: 'Vendor', value: v })),
                        { source: 'grid', trusted: true });
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  await new Promise(r => setTimeout(r, 500));          // let the first failure persist
  const out = { down: Store._jrnlRead().map(x => x.pk + '/' + x.col) };
  window.__fault = false;
  window.pywebview.api.read_file = realRead;
  /* NOTHING IS TYPED AGAIN: the retry budget is what has to carry it. */
  for (let i = 0; i < 12 && Store._jrnlRead().length; i++) {
    if (typeof Store.idle === 'function') await Store.idle();
    await new Promise(r => setTimeout(r, 400));
  }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  out.after = Store._jrnlRead().map(x => x.pk + '/' + x.col);
  out.pending = AppState.pendingCount();
  return out;
})`;

/* What the boot made of the journal. App._jrnlReplay is set by
   App._replayJournal before any toast, because openReco installs its toast
   hook AFTER the page has booted and a boot-time toast is not in __toasts. */
const S109_AFTER_BOOT = `(function () {
  const r = App._jrnlReplay || null;
  const sess = AppState.recoSessions.TPL_R;
  return { replay: r && { pending: r.pending, asked: r.asked.slice(0, 120),
                          applied: r.applied, skipped: r.skipped,
                          discarded: r.discarded, declined: r.declined, landed: r.landed },
           journal: Store._jrnlRead().map(x => x.pk + '/' + x.col),
           cells: (sess && sess.data ? sess.data : []).map(r2 => r2._pk),
           mem: Object.keys((AppState.extraValueMaster || {}).TPL_R || {}).sort()
             .map(pk => pk + '=' + String((((AppState.extraValueMaster.TPL_R || {})[pk] || {}).Vendor || {}).v || '')) };
})`;

/* T-S10-5's fixture. The two added columns are created through the REAL
   editor control (RecoTemplate.addExtraCol), because the stable `_cid` the
   pairing needs is minted there and nowhere else; the third is pushed in by
   hand with no `_cid`, which is what a column written by an older build looks
   like and is what the slot rule still has to carry. */
const S105_SETUP = `(async function () {
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_C'; t.name = 'Cids';
  t.columns = ['Invoice','Amount'].map(n => ({ name:n, label:n, formats:[], isValue:n==='Amount' }));
  t.primaryKeys = ['Invoice'];
  t.valueColumn = 'Amount';
  t.displayColumns = ['Invoice','Amount'];
  RecoTemplate.addExtraCol();
  RecoTemplate._editing.additionalColumns[0].name = 'Vendor';
  RecoTemplate.addExtraCol();
  RecoTemplate._editing.additionalColumns[1].name = 'Status';
  RecoTemplate._editing.additionalColumns.push({ name:'Legacy', type:'custom' });
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_C');
  RecoTemplate.open(tpl.id);
  await Reco.ingestData(tpl, [{ Invoice:'INV-1', Amount:'100' },
                              { Invoice:'INV-2', Amount:'200' },
                              { Invoice:'INV-3', Amount:'300' }], ['Invoice','Amount']);
  App.closeModal();
  AppState.activeRecoId = 'TPL_C';
  const sess = AppState.recoSessions.TPL_C;
  await Reco.applyEdits(tpl, sess, [
    { row: sess.data[0], col: 'Vendor', value: 'Acme' },
    { row: sess.data[1], col: 'Vendor', value: 'Bosch' },
    { row: sess.data[2], col: 'Vendor', value: 'Cummins' },
    { row: sess.data[0], col: 'Legacy', value: 'old-1' },
    { row: sess.data[1], col: 'Legacy', value: 'old-2' },
    { row: sess.data[2], col: 'Legacy', value: 'old-3' }
  ], { source: 'grid', trusted: true });
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return (tpl.additionalColumns || []).map(a => a.name + '/' + (a._cid ? 'cid' : 'none'));
})`;

/* Rename a column AND move it in the SAME save — which is what an operator
   who tidies the Additional Columns list does, and what used to read as
   "removed and added". */
const S105_MOVE = `(async function (arg) {
  const [from, to, toIndex] = arg;
  window.__toasts = [];
  const asks = [];
  const real = window.confirm;
  window.confirm = m => { asks.push(String(m)); return false; };   // a removal confirm DECLINED
  try {
    RecoTemplate.edit('TPL_C');
    const arr = RecoTemplate._editing.additionalColumns;
    const i = arr.findIndex(a => a && a.name === from);
    arr[i].name = to;
    const cut = arr.splice(i, 1)[0];
    arr.splice(toIndex, 0, cut);
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch (e) {} }
  } finally { window.confirm = real; }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_C') || {};
  const recs = (AppState.extraValueMaster || {}).TPL_C || {};
  const cell = (pk, col) => ((recs[pk] || {})[col] || {}).v;
  return { asks, toasts: (window.__toasts || []).map(x => x.kind + ': ' + x.msg),
           order: (tpl.additionalColumns || []).map(a => a.name),
           moved: ['INV-1','INV-2','INV-3'].map(pk => pk + '=' + String(cell(pk, to) == null ? '-' : cell(pk, to))),
           left:  ['INV-1','INV-2','INV-3'].map(pk => pk + '=' + String(cell(pk, from) == null ? '-' : cell(pk, from))) };
})`;

/* T-F2-8's probe. The row is addressed by _id, and a reload, a restore, an
   Excel load-back or a template switch between the render and the commit
   genuinely removes it from this pane's data. */
const F28_RUN = `(async function () {
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R');
  const sess = AppState.recoSessions.TPL_R;
  const gone = sess.data[0]._id;
  const keep = sess.data[1]._id;
  const keepPk = sess.data[1]._pk;
  sess.data = sess.data.filter(r => r._id !== gone);
  const out = {};
  const grab = () => (window.__toasts || []).map(t => t.kind + ': ' + t.msg);
  window.__toasts = []; Reco.editCell(0, 'Vendor', 'typed into thin air', null, gone);
  out.edit = grab();
  window.__toasts = []; Reco.manualOffset(0, null, gone);
  out.offset = grab();
  window.__toasts = []; Reco.unmarkOffset(0, null, gone);
  out.unmark = grab();
  /* THE CONTROL: the row that IS there still commits, and nothing is said
     about a missing row. */
  window.__toasts = []; Reco.editCell(0, 'Vendor', 'a real edit', null, keep);
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  out.ctl = grab();
  out.ctlValue = (((AppState.extraValueMaster.TPL_R || {})[keepPk] || {}).Vendor || {}).v;
  out.ctlPk = keepPk;
  return out;
})`;

/* T-26-4's fixture. An AEG-linked template whose post-entry column is a FILE
   column, three open rows, one line per row (aggregate off) so postedPks can
   be read per row. */
const T264_SETUP = `(async function () {
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_P'; t.name = 'Repost';
  t.columns = ['Invoice','Base','Reco','ToAccount','Cur','Doc','Desc','Date','Account']
    .map(n => ({ name:n, label:n, formats:[], isValue:n==='Base' }));
  t.primaryKeys = ['Invoice'];
  t.valueColumn = 'Base'; t.docNumberColumn = 'Doc';
  t.displayColumns = t.columns.map(c => c.name);
  const aegTpl = AppState.aegTemplates[0];
  aegTpl.aggregate = false; aegTpl.aggregateBy = [];
  t.aegIntegration = { enabled:true, aegTemplateId: aegTpl.id,
    keywordColumn:'', keywordValues:'', postEntryColumn:'Desc', postEntryValue:'POSTED' };
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_P');
  RecoTemplate.open(tpl.id);
  const F = ['Invoice','Base','Reco','ToAccount','Cur','Doc','Desc','Date','Account'];
  const spec = [['INV-1','100','R1','ACC1','AED','D1','one','01/01/26','ACC1'],
                ['INV-2','200','R1','ACC1','AED','D2','two','01/01/26','ACC1'],
                ['INV-3','300','R1','ACC1','AED','D3','three','01/01/26','ACC1']];
  await Reco.ingestData(tpl, spec.map(x => { const o={}; F.forEach((f,i)=>o[f]=x[i]); return o; }), F);
  App.closeModal(); AppState.activeRecoId = 'TPL_P';
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return true;
})`;

/* Post exactly the named keys, then reopen the day file from history — which
   is what every colleague does the next morning, and the state F3's probe
   found: the row is in the ledger and the in-row stamp has gone with the
   re-minted _id. */
const T264_POST = `(async function (arg) {
  const [pks] = arg;
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_P');
  const sess = AppState.recoSessions.TPL_P;
  sess.selectedRows = {};
  sess.data.forEach(r => { if (pks.indexOf(r._pk) !== -1) sess.selectedRows[r._id] = true; });
  Reco._pendingEntry = null;
  Reco.previewEntryFromSelection(false);
  if (!Reco._pendingEntry) return { refused: true };
  Reco.commitEntryFromPreview();
  App.closeModal();
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  const hist = (AppState.entryHistory || {}).TPL_P || [];
  const e = hist[hist.length - 1] || {};
  return { accountingId: e.accountingId, postedPks: (e.postedPks || []).slice(), entries: hist.length };
})`;

const T264_RELOAD = `(async function () {
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_P');
  const files = await Versioning.listFiles(tpl);
  const f = files[files.length - 1];
  await Reco.loadVersionedFile(f.fullPath || f.path, tpl.id);
  const sess = AppState.recoSessions.TPL_P;
  return sess.data.map(r => r._pk + '=' + (Reco.isRowPosted(tpl, sess, r) ? 'posted' : 'open'));
})`;

/* Select the named keys and preview. Reads what the PREVIEW holds, not what
   a toast said: ctx.sourceRows is what commitEntryFromPreview posts. */
const T264_PREVIEW = `(async function (arg) {
  const [pks] = arg;
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_P');
  const sess = AppState.recoSessions.TPL_P;
  sess.selectedRows = {};
  sess.data.forEach(r => { if (pks.indexOf(r._pk) !== -1) sess.selectedRows[r._id] = true; });
  window.__toasts = [];
  Reco._pendingEntry = null;
  Reco.previewEntryFromSelection(false);
  const read = () => {
    const ctx = Reco._pendingEntry;
    return { opened: !!ctx,
             source: ctx ? ctx.sourceRows.map(r => r._pk).sort() : [],
             posted: ctx ? (ctx.postedRows || []).map(p => p.pk + '/' + p.ref) : [],
             included: ctx ? !!ctx.postedIncluded : null,
             lines: ctx ? (ctx.lines || []).length : 0,
             body: (document.getElementById('appModalBody') || {}).textContent || '' };
  };
  const out = { first: read(), toasts: (window.__toasts || []).map(t => t.kind + ': ' + t.msg) };
  /* "Leave them out", and then back again — the offered action and its undo,
     through the real control the banner calls. */
  if (Reco._pendingEntry && (Reco._pendingEntry.postedRows || []).length) {
    window.__toasts = [];
    Reco.previewIncludePosted(false);
    out.dropped = read();
    out.droppedToasts = (window.__toasts || []).map(t => t.kind + ': ' + t.msg);
    Reco.previewIncludePosted(true);
    out.back = read();
  }
  return out;
})`;

const T264_COMMIT = `(async function () {
  if (!Reco._pendingEntry) return { refused: true };
  Reco.commitEntryFromPreview();
  App.closeModal();
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  const hist = (AppState.entryHistory || {}).TPL_P || [];
  return { entries: hist.length,
           byEntry: hist.map(e => e.accountingId + ':' + (e.postedPks || []).join('+')) };
})`;

/* Every row in the selection is already in the ledger, so the entry is empty. */
const T264_ALLPOSTED = `(async function () {
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_P');
  const sess = AppState.recoSessions.TPL_P;
  const before = ((AppState.entryHistory || {}).TPL_P || []).length;
  sess.selectedRows = {};
  sess.data.forEach(r => { if (Reco.isRowPosted(tpl, sess, r)) sess.selectedRows[r._id] = true; });
  window.__toasts = [];
  Reco._pendingEntry = null;
  Reco.previewEntryFromSelection(false);
  /* The operator presses the button the banner offers, which is what empties
     the entry: nothing is dropped unless they say so. */
  if (Reco._pendingEntry && (Reco._pendingEntry.postedRows || []).length)
    Reco.previewIncludePosted(false);
  const ctx = Reco._pendingEntry;
  const out = { opened: !!ctx, entriesBefore: before,
                source: ctx ? ctx.sourceRows.map(r => r._pk).sort() : [],
                posted: ctx ? (ctx.postedRows || []).map(p => p.pk) : [] };
  window.__toasts = [];
  Reco.commitEntryFromPreview();
  App.closeModal();
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  out.toasts = (window.__toasts || []).map(t => t.kind + ': ' + t.msg);
  out.entries = ((AppState.entryHistory || {}).TPL_P || []).length;
  return out;
})`;

/* The documented way back: reverse the entry, then the row is open again. */
const T264_REVERSE = `(async function (arg) {
  const [aid] = arg;
  AppState.activeRecoId = 'TPL_P';
  App.closeModal();
  await Reco.openReverseEntryModal(aid);   // async: the plan walks every key the entry closed
  if (Reco._reverseState && Reco._reverseState.mode !== 'reversed') Reco._reverseSetMode('reversed');
  const el = document.getElementById('revReason');
  if (el) { el.value = 'posted to the wrong period'; Reco._reverseValidate(); }
  const real = window.confirm; window.confirm = () => true;
  try { await Reco.reverseEntry(); } finally { window.confirm = real; }
  App.closeModal();
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_P');
  const sess = AppState.recoSessions.TPL_P;
  const hist = (AppState.entryHistory || {}).TPL_P || [];
  return { reversed: !!((hist.find(e => e.accountingId === aid) || {}).reversal),
           rows: sess.data.map(r => r._pk + '=' + (Reco.isRowPosted(tpl, sess, r) ? 'posted' : 'open')) };
})`;

/* T-S10-7's fixture. One keyed template with fields a colleague can move
   independently of each other: a team display order, a correction context,
   a description, and one added custom column to type into. */
const S107_SETUP = `(async function () {
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_R'; t.name = 'Race';
  t.columns = ['Invoice','Amount','Note'].map(n => ({ name:n, label:n, formats:[], isValue:n==='Amount' }));
  t.primaryKeys = ['Invoice'];
  t.valueColumn = 'Amount';
  t.displayColumns = ['Invoice','Amount','Note'];
  t.additionalColumns = [{ name:'Vendor', type:'custom' }];
  t.description = 'first';
  t.enableCorrections = true;
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R');
  RecoTemplate.open(tpl.id);
  await Reco.ingestData(tpl, [{ Invoice:'INV-1', Amount:'100', Note:'a' },
                              { Invoice:'INV-2', Amount:'200', Note:'b' }],
                        ['Invoice','Amount','Note']);
  App.closeModal();
  AppState.activeRecoId = 'TPL_R';
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return true;
})`;

/* Open the editor, set the named fields, save, and settle. Every confirm is
   captured — the reconciliation's question is one of them, and an assertion
   that read a toast could not tell "B was told" from "B was told something
   else". */
const S107_SAVE = `(async function (arg) {
  const [pairs, answer] = arg;
  window.__toasts = [];
  const asks = [];
  const real = window.confirm;
  window.confirm = m => { asks.push(String(m)); return answer; };
  try {
    RecoTemplate.edit('TPL_R');
    (pairs || []).forEach(([f, v]) => { RecoTemplate._editing[f] = v; });
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch (e) {} }
  } finally { window.confirm = real; }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  const t = AppState.recoTemplates.find(x => x.id === 'TPL_R') || {};
  return { asks, toasts: (window.__toasts || []).map(x => x.kind + ': ' + x.msg),
           order: t.displayOrder || null, ctx: t.correctionContextCols || null, desc: t.description };
})`;

/* THE DELETED SKIP. The operator types a cell and saves the template in the
   same tick — no await between them — so AppState.pendingCount() is non-zero
   when saveTemplate asks the folder. That is the state RC-12 would not
   reconcile in, and it is the state an operator who has just typed is in. */
const S107_PEND = `(async function () {
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R');
  const sess = AppState.recoSessions.TPL_R;
  const typing = Reco.applyEdits(tpl, sess, [{ row: sess.data[0], col: 'Vendor', value: 'Acme' }],
                                 { source: 'grid', trusted: true });
  const pendingAtSave = AppState.pendingCount();
  const asks = [];
  const real = window.confirm;
  window.confirm = m => { asks.push(String(m)); return true; };
  try {
    RecoTemplate.edit('TPL_R');
    RecoTemplate._editing.description = 'B typed and saved';
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch (e) {} }
  } finally { window.confirm = real; }
  try { await typing; } catch (e) {}
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  const t = AppState.recoTemplates.find(x => x.id === 'TPL_R') || {};
  return { pendingAtSave, asks, order: t.displayOrder || null, desc: t.description,
           cell: (((AppState.extraValueMaster.TPL_R || {})['INV-1'] || {}).Vendor || {}).v };
})`;

/* T-24R2-1's fixture. The key is an ADDED FORMULA COLUMN, which is #24's
   feature and the shape that makes this ticket expensive: editing the formula
   leaves primaryKeys byte-identical while changing what every row IS. */
const KD_SETUP = `(async function () {
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_KD'; t.name = 'KeyDefs';
  t.columns = ['Doc','Line','Amount'].map(n => ({ name:n, label:n, formats:[], isValue:n==='Amount' }));
  t.additionalColumns = [{ name:'Ref', type:'formula', formula:'CONCAT({Doc})' }];
  t.primaryKeys = ['Ref'];
  t.valueColumn = 'Amount';
  t.displayColumns = ['Doc','Line','Amount'];
  const real = window.confirm; window.confirm = () => true;
  try { RecoTemplate.saveTemplate(); } finally { window.confirm = real; }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return ((AppState.recoTemplates.find(x => x.id === 'TPL_KD') || {}).additionalColumns || [])
    .map(a => a.name + '=' + a.formula);
})`;

const KD_KEYCHANGE = `(async function (arg) {
  const [formula] = arg;
  const asks = [];
  const real = window.confirm;
  window.confirm = m => { asks.push(String(m)); return true; };
  try {
    RecoTemplate.edit('TPL_KD');
    RecoTemplate._editing.additionalColumns.find(a => a.name === 'Ref').formula = formula;
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch (e) {} }
  } finally { window.confirm = real; }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return { asks, extras: ((AppState.recoTemplates.find(x => x.id === 'TPL_KD') || {}).additionalColumns
    || []).map(a => a.name + '=' + a.formula) };
})`;

const KD_SAVE = `(async function (arg) {
  const [pairs, answer] = arg;
  window.__toasts = [];
  const asks = [];
  const real = window.confirm;
  window.confirm = m => { asks.push(String(m)); return answer; };
  try {
    RecoTemplate.edit('TPL_KD');
    (pairs || []).forEach(([f, v]) => { RecoTemplate._editing[f] = v; });
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch (e) {} }
  } finally { window.confirm = real; }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  const t = AppState.recoTemplates.find(x => x.id === 'TPL_KD') || {};
  return { asks, toasts: (window.__toasts || []).map(x => x.kind + ': ' + x.msg),
           name: t.name, extras: (t.additionalColumns || []).map(a => a.name + '=' + a.formula) };
})`;

/* Four business rows, uploaded from whichever page this runs in. The day
   file's _pk column is what the two schemes disagree about. */
const KD_UPLOAD = `(async function () {
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_KD');
  RecoTemplate.open(tpl.id);
  const F = ['Doc','Line','Amount'];
  const spec = [['D1','L1','100'],['D2','L1','200'],['D3','L1','300'],['D4','L1','400']];
  await Reco.ingestData(tpl, spec.map(x => { const o = {}; F.forEach((f,i) => o[f] = x[i]); return o; }), F);
  App.closeModal();
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  if (typeof Versioning.idle === 'function') await Versioning.idle();
  const sess = AppState.recoSessions.TPL_KD;
  return (sess.data || []).map(r => r._pk);
})`;

const PORT_MR8 = 21157;     // MR-8  an intent registered while a write is in flight
const PORT_S111 = 21158;    // T-S10-11 the forced same-reference collision

/* ---- MR-8. A VALUE TYPED WHILE A MERGE WRITE IS IN FLIGHT. Store._mergeJob
   applied m.intents, awaited the write, and then did `m.intents = []` - so
   anything pushed during the await was cleared without ever being applied.
   A write of a shared file is hundreds of milliseconds (600 ms at 50,000
   records on local disk, plus the wire), and mergeWrite had already armed a
   fresh timer for the new intent, so a second job ran, took the disk as the
   authority, and wrote a file without it - AND _takeDisk had replaced memory
   from that disk, so the value was gone from the screen too. No error, no
   toast, no second copy: exactly the class T-S10-1 was filed about.
   Found while chasing a document-number correction that never landed. */
const MR8_RUN = `(async function () {
  const id = 'TPL_E';
  const api = window.pywebview.api;
  const realWrite = api.write_file;
  let slow = 0;
  api.write_file = function (rel) {
    const args = arguments;
    if (slow && String(rel) === 'reco/extraValueMaster.json') {
      const ms = slow;
      return new Promise(res => setTimeout(() => res(realWrite.apply(api, args)), ms));
    }
    return realWrite.apply(api, args);
  };
  const put = (pk, col, v) => {
    const rec = { k:'typed', v: String(v), ds:'', by:'x', at:'' };
    AppState.extraValueMaster = AppState.extraValueMaster || {};
    const byTpl = AppState.extraValueMaster[id] || (AppState.extraValueMaster[id] = {});
    (byTpl[pk] || (byTpl[pk] = {}))[col] = rec;
    Reco._extraValueFlush(id, map => {
      const b = map[id] || (map[id] = {});
      (b[pk] || (b[pk] = {}))[col] = rec;
    });
  };
  const out = {};
  try {
    slow = 500;
    put('INV-1', 'Note', 'first');
    const running = AppState.flush();                 // starts the slow write
    await new Promise(r => setTimeout(r, 250));        // it is mid-write now
    out.inflight = Store.pendingCount() > 0;
    put('INV-2', 'Note', 'second');                   // the intent that used to be dropped
    slow = 0;
    await running;
    await AppState.flush();
    if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
    await new Promise(r => setTimeout(r, 250));
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
  } finally { api.write_file = realWrite; }
  const mem = (AppState.extraValueMaster || {})[id] || {};
  out.mem = { one: ((mem['INV-1']||{}).Note||{}).v || null, two: ((mem['INV-2']||{}).Note||{}).v || null };
  return out;
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
     [3] S7 — decision E. extraValueMaster is NOT in PERSIST_KEYS, and a
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
     [4] S5 — Reco.storeKey's three clauses.
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
     [5] S6 — decision P. Spreadsheet scratch columns must not write
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
     [6] S9 — decision T. Every new reader with sess = null.
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
     [7] S8 — S13 under contention, and under readOnlyKeys.
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
     [8] S3 — THE GATE. Two pages, one share, different keys, both survive.
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
     [9] S11 — the escape hatch of decision G.
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
     [10] S10 — cost. A 2,000-edit burst is ONE write.
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
     [11] Decision U — no new ids, and nothing emitted unconditionally.
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
    /* WHAT A RECORD ON A DUPLICATED KEY DOES WHEN IT IS ALREADY THERE.
       This used to demonstrate the money bug: planted by hand, it was read by
       all three rows and the entry posted 3000. RC-6 made that unreachable -
       Reco._extraOverride stops serving a record whose key no longer names
       ONE loaded row - so what this now pins is the STRONGER statement: even
       with the record in place, every row reads its own formula and the entry
       posts 1030. The write refusal (O2c) and the read suppression are two
       independent guards and this is the second one. Put in by hand, read
       through the real preview, and taken back out again. */
    AppState.extraValueMaster.TPL_DUP = { 'INV-7': { Net: { k: 'override', v: '1000', prev: '30',
      src: 'formula', ds: '', by: 'demo', at: new Date().toISOString() } } };
    out.broadcast = total();
    out.broadcastStored = Object.keys((AppState.extraValueMaster || {}).TPL_DUP || {});
    delete AppState.extraValueMaster.TPL_DUP;
    out.restored = total();
    return out;
  });
  note('O2', { count: o2.count, before: o2.before, after: o2.after, broadcast: o2.broadcast, rejected: o2.rejected });
  check(o2.count === 3, 'O2a the premise: three loaded rows share the key INV-7', o2.count);
  /* THIS FIXTURE IS DEGENERATE AND THE NUMBER CANNOT TELL TWO BEHAVIOURS
     APART. Row 1's own formula value is 1000 and the override's value is also
     1000, so 1030 is reached BOTH by applying the override to the row it was
     typed on AND by suppressing it and letting the formula speak. That makes
     1030 a fine premise and a poor gate. The assertions that DO distinguish
     them are section 37's R3a/R3b, on a fixture whose row-1 formula is 2000:
     there suppression posts 2030, and 2030 is the number the shipped
     behaviour produces. Stated here so nobody reads 1030 as the general
     arithmetic of a duplicated key — it is not, and the handover says so too. */
  check(o2.before.sum === 1030 && o2.before.dr === 1030 && o2.before.cr === 1030 && o2.before.lines === 2,
    'O2b the premise: the journal preview over the three rows posts 1000 + 30 + 0 = 1030 (one aggregated Dr/Cr pair)',
    o2.before);
  check(o2.applied === 0 && o2.rejected.length === 1 && o2.rejected[0].reason === 'dupPk'
        && /\b3\b/.test(o2.rejected[0].message) && /3 of them/.test(o2.rejected[0].message),
    'O2c (THE GATE) the override is REFUSED, not applied, with the COUNT in the message', o2.rejected);
  check(o2.stored.length === 0, 'O2d and nothing at all was written to the store', o2.stored);
  check(o2.after.sum === 1030 && o2.after.dr === 1030,
    'O2e (THE GATE) so the entry still posts 1030', o2.after);
  check(o2.broadcast.sum === 1030 && o2.broadcast.dr === 1030
        && o2.broadcast.nets.join() === '1000,30,0' && o2.broadcastStored.join() === 'INV-7',
    'O2f (RC-6, STRENGTHENED — this asserted the 3000 the bug posted) EVEN WITH THE RECORD IN THE '
    + 'STORE the entry posts 1030 and each row reads its own formula value: a record whose key no '
    + 'longer names one loaded row stops being served, at the one reader every surface shares. The '
    + 'record is STILL THERE (INV-7) - it is suppressed, not deleted, because the key may be unique '
    + 'again in next month\'s file. The write refusal O2c and this read suppression are two '
    + 'independent guards: F1 proved the write guard alone is not enough, because a key that was '
    + 'unique when the override was typed is shared a week later.',
    { broadcast: o2.broadcast, stillStored: o2.broadcastStored });
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
    /* READ AFTER THE SETTLE, not on the line after the synchronous
       saveTemplate(). ROUND 4, findings A1/A2: the promotion, the rename
       migration and the removal's record drop - and the sentences that
       announce them - are STAGED behind the shared folder's answer, because
       they had been running fifty-five lines before the folder could refuse
       the save and had already said so ("3 value(s) ... now belong to
       Supplier" one toast before "Nothing was saved"). "The operator is told
       it happened" can only be said once it has happened. The assertions
       below are unchanged. */
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    const toast1 = (window.__toasts || []).map(x => x.msg);
    const after1 = JSON.parse(JSON.stringify((AppState.extraValueMaster || {}).TPL_Q || {}));
    const legacyAfter1 = Object.keys(sess.manualTags || {}).map(k => k.split('||')[1]).sort();

    /* HALF TWO: a SECOND save with nothing changed. */
    await new Promise(r => setTimeout(r, 20));
    RecoTemplate.edit('TPL_Q');
    window.__toasts = [];
    RecoTemplate.saveTemplate();
    /* THE SAME MOVE, and here it makes the gate STRICTER: C7e now also fails
       if the second save says it promoted something a moment later. */
    await AppState.flush();
    if (typeof Store.idle === 'function') await Store.idle();
    const toast2 = (window.__toasts || []).map(x => x.msg);
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


  /* =======================================================================
     ROUND 2 OF THE FIX — the five BLOCKERS the first fix round did not reach,
     plus the half of F9 its data-set edit left open. Reviewer ids are cited.

     EVERY SECTION BELOW FAILED BEFORE ITS FIX and the failing run is recorded
     in scratchpad/store/fix/f1/out/*.pre.txt (APP_FILE=.../f1/Reco.html.bak,
     which is 29cb95d + the pinned gate, i.e. the tree these were written
     against). Each assertion reads a VALUE - an amount, a cell, a stored
     record - and not a column name: a blocker got through the first review
     here because an assertion read a name where the bug was in the value.
     ======================================================================= */

  /* ---------------------------------------------------------------------
     [35] R1 / finding F3 — AFTER A RELOAD, IS THE NUMBER IN THE LEDGER?
     The post-entry column may be an ADDED column. commitEntryFromPreview
     stamps it as a PLAIN ROW PROPERTY and queues a version row only for a
     TEMPLATE column, so loadVersionedFile - what every colleague does the
     next morning, and what a Clear forces - brings the row back with no
     mark. Reco.isRowPosted then said "open" while Reco._postedRefFor named
     the entry, about the same row; the badge was blank, the posted-JV audit
     reported 0 posted / 0 missing, and the override refusal the user asked
     for could not fire. The fix makes isRowPosted ask the LEDGER's own
     record of the stamp (entry.postedPks + postedCol + postedValue) when the
     column says nothing, so nothing new is written to the share and the
     answer is key-scoped - which is what posted-ness is.
     --------------------------------------------------------------------- */
  section(35, 'R1 (F3) — after a reload the two readers agree, and the override is refused');
  const RT1 = makeRoot('share-r1');
  const brRT1 = await startBridge(RT1.root, PORT_FIX_POST); procs.push(brRT1.proc);
  const pgRT1 = await openReco(browser, brRT1);
  const xRT1 = await pgRT1.page.evaluate(async () => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_R1'; t.name = 'Posted on an added column';
    t.columns = ['Invoice', 'Base', 'Reco', 'ToAccount']
      .map(n => ({ name: n, label: n, formats: [], isValue: n === 'Base' }));
    t.primaryKeys = ['Invoice'];
    t.valueColumn = 'Base'; t.docNumberColumn = '';
    t.displayColumns = t.columns.map(c => c.name);
    /* Workflow is an ADDED custom column AND the post-entry column, which is
       what the picker offers. Net is a separate overridable formula column
       (S11 rightly forbids the post-entry column itself being overridable). */
    t.additionalColumns = [
      { name: 'Net', type: 'formula', formula: 'NUM({Base})*2', allowOverride: true },
      { name: 'AED', type: 'formula', formula: 'NUM({Net})' },
      { name: 'Workflow', type: 'custom' }
    ];
    t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id,
      keywordColumn: '', keywordValues: '', postEntryColumn: 'Workflow', postEntryValue: 'Posted' };
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R1');
    RecoTemplate.open(tpl.id);
    await Reco.ingestData(tpl, [{ Invoice: 'INV-1', Base: '100', Reco: 'R1', ToAccount: 'ACC1' }],
      ['Invoice', 'Base', 'Reco', 'ToAccount']);
    App.closeModal(); AppState.activeRecoId = tpl.id; AppState.activeSubSection = 'reco';
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();

    const read = () => {
      const sess = AppState.recoSessions.TPL_R1;
      const row = sess.data.find(r => r._pk === 'INV-1');
      Reco._fullPass();
      let full; try { full = Reco.rowFull(tpl, sess, row); } finally { Reco._fullEnd(); }
      const ref = Reco._postedRefFor(tpl, row);
      const audit = Reco.postedJvAudit(tpl, sess);
      const set = Reco._setOverride(tpl, sess, row, 'Net', '999999', 'value');
      if (set.ok) Reco._clearOverride(tpl, sess, row, 'Net');
      Reco._fullPass();
      let net; try { net = String(Reco.rowFull(tpl, sess, row).Net); } finally { Reco._fullEnd(); }
      return {
        rowProp: Object.prototype.hasOwnProperty.call(row, 'Workflow') ? String(row.Workflow) : '(absent)',
        isRowPosted: Reco.isRowPosted(tpl, sess, row),
        excelLink: ExcelLink._isPosted(tpl, full, sess),
        refId: ref ? ref.accountingId : null,
        badge: (Reco._postedBadge(tpl, sess, row) || '').replace(/<[^>]*>/g, '').trim(),
        auditPosted: audit.posted, auditLinked: audit.linked, auditMissing: audit.missing,
        overrideOk: set.ok, overrideReason: set.ok ? '' : set.reason,
        overrideMsg: set.ok ? '' : String(set.message || ''),
        netAfter: net
      };
    };

    /* POST IT through the real preview and the real commit. */
    const sess = AppState.recoSessions.TPL_R1;
    sess.selectedRows = {}; sess.data.forEach(r => { sess.selectedRows[r._id] = true; });
    Reco.previewEntryFromSelection(false);
    const hadPreview = !!Reco._pendingEntry;
    const drPosted = ((Reco._pendingEntry || {}).lines || [])
      .reduce((a, l) => a + U.num(l.Dr || l.dr || 0), 0);
    Reco.commitEntryFromPreview();
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    const before = read();
    const files = await Versioning.listFiles(tpl);
    const file = (files[0] && (files[0].fullPath || files[0].path)) || null;

    /* THE RELOAD. */
    sess.data = [];
    await Reco.loadVersionedFile(file, 'TPL_R1');
    const after = read();
    return { hadPreview, drPosted, histId: (AppState.entryHistory.TPL_R1 || []).map(e => e.accountingId)[0],
             postedCol: (AppState.entryHistory.TPL_R1 || [])[0].postedCol,
             postedPks: (AppState.entryHistory.TPL_R1 || [])[0].postedPks,
             before, after, file };
  });
  note('R1 before the reload', xRT1.before);
  note('R1 AFTER the reload', xRT1.after);
  check(xRT1.hadPreview && xRT1.drPosted === 200 && xRT1.before.isRowPosted === true
        && xRT1.before.refId === xRT1.histId,
    'R1 premise: the row really was posted, for 200, and before any reload every reader agrees',
    { dr: xRT1.drPosted, before: xRT1.before, hist: xRT1.histId });
  check(xRT1.after.rowProp === '(absent)' && (xRT1.after.postedPks || xRT1.postedPks).length === 1,
    'R1 premise: after the reload the stamp is NOT on the row - that is the state under test, and '
    + 'the ledger still names the key', { rowProp: xRT1.after.rowProp, pks: xRT1.postedPks });
  check(xRT1.after.isRowPosted === true,
    'R1a (THE GATE) Reco.isRowPosted still says the row is in the general ledger after the reload - '
    + 'it said false while Reco._postedRefFor named the entry about the same row (F3)', xRT1.after);
  check(xRT1.after.refId === xRT1.histId && xRT1.after.excelLink === true,
    'R1b and the three readers give ONE answer: isRowPosted, ExcelLink._isPosted and _postedRefFor '
    + 'all resolve to ' + xRT1.histId, xRT1.after);
  check(xRT1.after.badge.indexOf(xRT1.histId) !== -1,
    'R1c the grid badge names the accounting reference instead of being blank', xRT1.after.badge);
  check(xRT1.after.auditPosted === 1 && xRT1.after.auditLinked === 1 && xRT1.after.auditMissing === 0,
    'R1d the Posted-JV Tracking card counts it 1 posted / 1 linked / 0 missing - it reported 0/0/0 '
    + 'about a row that is in the ledger, so nobody could find it by looking',
    { posted: xRT1.after.auditPosted, linked: xRT1.after.auditLinked, missing: xRT1.after.auditMissing });
  check(xRT1.after.overrideOk === false && xRT1.after.overrideReason === 'posted'
        && xRT1.after.overrideMsg.indexOf(xRT1.histId) !== -1,
    'R1e the override on that row is REFUSED, naming the accounting reference - the user\'s own '
    + 'decision, which was unenforceable in this state', xRT1.after);
  check(xRT1.after.netAfter === '200',
    'R1f AND THE VALUE: the cell still reads the 200 the entry was posted with, not the 999999 a '
    + 'person typed over it', xRT1.after.netAfter);

  /* ---------------------------------------------------------------------
     [36] R2 / finding F10 — THE POSTED-ROW REFUSAL ON THE DELETE ROUTES.
     The refusal lived only at the set site, so the number a journal was
     posted with could not be CHANGED and could be DELETED: applyEdits
     {clear:true}, the Manual Overrides panel's one-click Revert, the Values
     panel's Remove and "Remove all for keys not in the current data" each put
     the formula value back, with a green success toast. The bulk button is the
     worst, because the keys not loaded right now are exactly the periods that
     have already been posted.
     NO CHOKEPOINT COVERS ALL FOUR: the panels have a pk and no row, so this is
     ONE predicate (Reco._postedBlockFor, pk-keyed) asked at N=4 call sites.
     --------------------------------------------------------------------- */
  section(36, 'R2 (F10) — the four delete routes refuse on a row that is in the ledger');
  const RT2 = makeRoot('share-r2');
  const brRT2 = await startBridge(RT2.root, PORT_FIX_SAFE); procs.push(brRT2.proc);
  const pgRT2 = await openReco(browser, brRT2);
  const xRT2 = await pgRT2.page.evaluate(async () => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_R2'; t.name = 'Delete routes';
    t.columns = ['Invoice', 'Base', 'Status', 'ToAccount']
      .map(n => ({ name: n, label: n, formats: [], isValue: n === 'Base' }));
    t.primaryKeys = ['Invoice']; t.valueColumn = 'Base'; t.docNumberColumn = '';
    t.displayColumns = t.columns.map(c => c.name);
    t.additionalColumns = [
      { name: 'Net', type: 'formula', formula: 'NUM({Base})*2', allowOverride: true },
      { name: 'AED', type: 'formula', formula: 'NUM({Net})' },
      { name: 'Note', type: 'custom' }
    ];
    t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id,
      keywordColumn: '', keywordValues: '', postEntryColumn: 'Status', postEntryValue: 'Posted' };
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R2');
    RecoTemplate.open(tpl.id);
    await Reco.ingestData(tpl, [{ Invoice: 'INV-1', Base: '10', Status: '', ToAccount: 'ACC1' },
                                { Invoice: 'INV-9', Base: '55', Status: '', ToAccount: 'ACC1' }],
      ['Invoice', 'Base', 'Status', 'ToAccount']);
    App.closeModal(); AppState.activeRecoId = tpl.id; AppState.activeSubSection = 'reco';
    const sess = AppState.recoSessions.TPL_R2;
    const rowP = sess.data.find(r => r._pk === 'INV-1');   // the posted one
    const rowU = sess.data.find(r => r._pk === 'INV-9');   // never posted: the control
    const out = {};
    /* The preparer disagrees with the formula on INV-1 and types 1000; INV-9
       gets an ordinary typed value and is NEVER posted - the control that
       proves these refusals are about the ledger and not a blanket ban. */
    await Reco.setOverride(rowP._id, 'Net', '1000');
    await Reco.applyEdits(tpl, sess, [{ row: rowU, col: 'Note', value: 'chase' }],
      { source: 'grid', trusted: true, schema: Reco._ovSchema(tpl, sess) });
    await new Promise(x => setTimeout(x, 80));
    /* ONLY INV-1 IS POSTED, through the real preview and commit. */
    sess.selectedRows = {}; sess.selectedRows[rowP._id] = true;
    Reco.previewEntryFromSelection(false);
    out.drPosted = ((Reco._pendingEntry || {}).lines || [])
      .reduce((a, l) => a + U.num(l.Dr || l.dr || 0), 0);
    Reco.commitEntryFromPreview();
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    out.accId = (AppState.entryHistory.TPL_R2 || []).map(e => e.accountingId)[0];
    const netOf = pk => {
      const row = AppState.recoSessions.TPL_R2.data.find(r => r._pk === pk);
      Reco._fullPass();
      try { return String(Reco.rowFull(tpl, AppState.recoSessions.TPL_R2, row).Net); }
      finally { Reco._fullEnd(); }
    };
    const recOf = (pk, col) => !!((((AppState.extraValueMaster || {}).TPL_R2 || {})[pk] || {})[col]);
    out.posted = Reco.isRowPosted(tpl, sess, rowP);
    out.netBefore = netOf('INV-1');

    /* 1. applyEdits {clear:true} — the grid's own revert control. */
    const c = await Reco.applyEdits(tpl, sess, [{ row: rowP, col: 'Net', clear: true }],
      { source: 'grid', trusted: true, schema: Reco._ovSchema(tpl, sess) });
    out.route1 = { applied: c.applied, rejected: c.rejected.map(x => ({ reason: x.reason, msg: String(x.message || '') })),
                   net: netOf('INV-1'), rec: recOf('INV-1', 'Net') };

    /* 2. the Manual Overrides panel's one-click Revert. */
    window.__toasts = [];
    Reco.revertOverrideKey('INV-1', 'Net');
    await new Promise(x => setTimeout(x, 60));
    out.route2 = { toasts: (window.__toasts || []).map(x => x.kind + ': ' + x.msg),
                   net: netOf('INV-1'), rec: recOf('INV-1', 'Net') };
    App.closeModal();

    /* 3. the Values panel's per-record Remove, on the same posted key. */
    window.__toasts = [];
    Reco.removeValueRec('INV-1', 'Net');
    await new Promise(x => setTimeout(x, 60));
    out.route3 = { toasts: (window.__toasts || []).map(x => x.kind + ': ' + x.msg),
                   net: netOf('INV-1'), rec: recOf('INV-1', 'Net') };
    App.closeModal();

    /* 4. "Remove all for keys not in the current data", with BOTH keys off
          screen: INV-1 is in the ledger, INV-9 is not. */
    const keep = sess.data.slice();
    sess.data = [];
    window.__toasts = [];
    const asked = []; const realConfirm = window.confirm;
    window.confirm = m => { asked.push(String(m)); return true; };
    try { Reco.removeValuesNotLoaded(); } finally { window.confirm = realConfirm; }
    await new Promise(x => setTimeout(x, 120));
    if (typeof Store.idle === 'function') await Store.idle();
    sess.data = keep;
    out.route4 = { confirm: asked[0] || '', toasts: (window.__toasts || []).map(x => x.kind + ': ' + x.msg),
                   postedRec: recOf('INV-1', 'Net'), unpostedRec: recOf('INV-9', 'Note'),
                   net: netOf('INV-1') };
    App.closeModal();
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    return out;
  });
  note('R2 route 1 — applyEdits {clear:true}', xRT2.route1);
  note('R2 route 2 — the Overrides panel Revert', xRT2.route2);
  note('R2 route 3 — the Values panel Remove', xRT2.route3);
  note('R2 route 4 — remove all for keys not loaded', xRT2.route4);
  check(xRT2.posted === true && xRT2.drPosted === 1000 && xRT2.netBefore === '1000',
    'R2 premise: the entry really posted the override - 1000, not the formula\'s 20',
    { posted: xRT2.posted, dr: xRT2.drPosted, net: xRT2.netBefore });
  check(xRT2.route1.applied === 0 && (xRT2.route1.rejected[0] || {}).reason === 'posted'
        && String((xRT2.route1.rejected[0] || {}).msg).indexOf(xRT2.accId) !== -1
        && xRT2.route1.rec === true && xRT2.route1.net === '1000',
    'R2a (THE GATE) applyEdits {clear:true} is refused naming ' + xRT2.accId
    + ', the record survives, and the cell still reads the 1000 the ledger holds', xRT2.route1);
  check(xRT2.route2.rec === true && xRT2.route2.net === '1000'
        && xRT2.route2.toasts.some(s => /^error/.test(s) && s.indexOf(xRT2.accId) !== -1),
    'R2b the Overrides panel\'s one-click Revert is refused the same way, with an error toast that '
    + 'names the entry to reverse - it used to say "reverted" in green', xRT2.route2);
  check(xRT2.route3.rec === true && xRT2.route3.net === '1000'
        && xRT2.route3.toasts.some(s => /^error/.test(s) && s.indexOf(xRT2.accId) !== -1),
    'R2c the Values panel\'s Remove is refused the same way', xRT2.route3);
  check(xRT2.route4.postedRec === true && xRT2.route4.net === '1000',
    'R2d the bulk "remove all for keys not in the current data" KEEPS the record on the posted key - '
    + 'those keys are precisely the periods already posted', xRT2.route4);
  check(xRT2.route4.unpostedRec === false,
    'R2e ...and still does its job on the key that is NOT in the ledger, so this is a refusal about '
    + 'the ledger and not a dead button', xRT2.route4);
  check(/ledger|posted/i.test(xRT2.route4.confirm) && /\b1\b/.test(xRT2.route4.confirm),
    'R2f and the confirm SAYS how many were kept because they are in the ledger - it never mentioned '
    + 'the ledger at all', xRT2.route4.confirm);

  /* ---------------------------------------------------------------------
     [37] R3 / finding F1 — A DUPLICATE ARRIVING AFTER THE OVERRIDE.
     The duplicate-key refusal is in _setOverride only, so a key that was
     unique when the override was typed and is shared a week later broadcasts
     the stored value to every row with that key: three AP lines under INV-7,
     one overridden, and the entry posts 3000 where the three rows are worth
     2030. The reader had no test at all.
     THE FIX IS AT THE READER (Reco._extraOverride), which is the ONE
     chokepoint every surface shares - the grid, the reports, the CSV, the
     workbook, the Excel view and the AEG source-row loop - so the screen and
     the journal cannot disagree about it.
     WHAT I NARROWED, SAID PLAINLY: the reviewer called 1030 the correct
     posting (the override on the row it was typed on, the formula on the two
     new ones). The record is keyed on the KEY ALONE and cannot name a row, so
     there is no way to apply it to one of three; the two honest answers are
     to suppress it and say so, or to refuse the load. Suppressed: every
     surface reads the formula, the record is KEPT (the key may be unique
     again next month) and the duplicate-key panel now names it.
     --------------------------------------------------------------------- */
  section(37, 'R3 (F1) — a duplicate arriving by Add Data stops the stored override applying');
  const RT3 = makeRoot('share-r3');
  const brRT3 = await startBridge(RT3.root, PORT_FIX_DUP); procs.push(brRT3.proc);
  const pgRT3 = await openReco(browser, brRT3);
  const xRT3 = await pgRT3.page.evaluate(async () => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_R3'; t.name = 'Duplicate after the override';
    t.columns = ['Invoice', 'Base', 'Reco', 'ToAccount']
      .map(n => ({ name: n, label: n, formats: [], isValue: n === 'Base' }));
    t.primaryKeys = ['Invoice']; t.valueColumn = 'Base'; t.docNumberColumn = '';
    t.displayColumns = t.columns.map(c => c.name);
    t.additionalColumns = [
      { name: 'Net', type: 'formula', formula: 'NUM({Base})*2', allowOverride: true },
      { name: 'AED', type: 'formula', formula: 'NUM({Net})' }
    ];
    t.enableReporting = true; t.reports = [{ name: 'R', columns: ['Invoice', 'Net'] }];
    t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id,
      keywordColumn: '', keywordValues: '', postEntryColumn: '', postEntryValue: '' };
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R3');
    RecoTemplate.open(tpl.id);
    const fields = ['Invoice', 'Base', 'Reco', 'ToAccount'];
    await Reco.ingestData(tpl, [{ Invoice: 'INV-7', Base: '1000', Reco: 'R1', ToAccount: 'ACC1' }], fields);
    App.closeModal(); AppState.activeRecoId = tpl.id; AppState.activeSubSection = 'reco';
    const sess = AppState.recoSessions.TPL_R3;
    const out = {};
    const journal = () => {
      const s = AppState.recoSessions.TPL_R3;
      s.selectedRows = {}; s.data.forEach(r => { s.selectedRows[r._id] = true; });
      Reco.previewEntryFromSelection(false);
      const ctx = Reco._pendingEntry;
      const dr = ((ctx || {}).lines || []).reduce((a, l) => a + U.num(l.Dr || l.dr || 0), 0);
      const inputs = ((ctx || {}).aegInputs || []).map(o => U.num(o.AED));
      App.closeModal(); Reco._pendingEntry = null;
      return { dr: dr, inputs: inputs };
    };
    const nets = () => {
      const s = AppState.recoSessions.TPL_R3;
      Reco._fullPass();
      try { return s.data.map(r => String(Reco.rowFull(tpl, s, r).Net)); } finally { Reco._fullEnd(); }
    };
    /* The key is UNIQUE, so the override is accepted - 2000 becomes 1000. */
    await Reco.setOverride(sess.data[0]._id, 'Net', '1000');
    await new Promise(x => setTimeout(x, 80));
    out.before = { nets: nets(), journal: journal(), dup: Reco._dupPkCountFor(tpl, sess, 'INV-7') };
    /* NEXT WEEK'S FILE brings two more lines under the same invoice number -
       the ordinary shape of an AP extract. */
    window.__toasts = [];
    const asked = []; const realConfirm = window.confirm;
    window.confirm = m => { asked.push(String(m)); return true; };
    const openModal = App.openModal; const modals = [];
    App.openModal = function (title, body, footer) { modals.push({ title: String(title), body: String(body) }); };
    try {
      await Reco.ingestData(tpl, [{ Invoice: 'INV-7', Base: '15', Reco: 'R1', ToAccount: 'ACC1' },
                                  { Invoice: 'INV-7', Base: '0', Reco: 'R1', ToAccount: 'ACC1' }], fields);
    } finally { window.confirm = realConfirm; App.openModal = openModal; }
    await new Promise(x => setTimeout(x, 80));
    out.dupNow = Reco._dupPkCountFor(tpl, AppState.recoSessions.TPL_R3, 'INV-7');
    out.nets = nets();
    out.journal = journal();
    out.rec = !!(((AppState.extraValueMaster.TPL_R3 || {})['INV-7'] || {}).Net);
    /* WHATEVER THE OPERATOR WAS SHOWN: the pre-write question (a confirm) or
       the panel after it. Both are captured because which one fires depends
       on whether the key is derived, and the gap RC-6 closed was that for a
       key of template columns NEITHER did. */
    out.panel = ((modals.find(m => /Duplicate primary keys/.test(m.title)) || {}).body || '')
      + ' ' + asked.join(' ');
    /* Reco.runReport returns the enriched rows themselves (O3 reads it the
       same way), so this is the report's own answer for the column. */
    out.report = Reco.runReport(tpl, AppState.recoSessions.TPL_R3, tpl.reports[0])
      .map(r => String(r.Net));
    /* THE CONTROL: take the two new rows away again and the record applies. */
    const s = AppState.recoSessions.TPL_R3;
    s.data = s.data.slice(0, 1);
    Reco._dupPkMemo = null;
    out.afterFix = { nets: nets(), journal: journal() };
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    return out;
  });
  note('R3 before the duplicate', xRT3.before);
  note('R3 after the duplicate', { dup: xRT3.dupNow, nets: xRT3.nets, journal: xRT3.journal, rec: xRT3.rec });
  note('R3 the duplicate-key panel the operator read', xRT3.panel.replace(/<[^>]*>/g, ' ').slice(0, 400));
  note('R3 the control, with the duplicate rows gone', xRT3.afterFix);
  check(xRT3.before.dup === 1 && xRT3.before.nets.join() === '1000' && xRT3.before.journal.dr === 1000,
    'R3 premise: while the key is unique the override applies and the entry posts 1000',
    xRT3.before);
  check(xRT3.dupNow === 3,
    'R3 premise: next week\'s file makes three rows share INV-7', xRT3.dupNow);
  check(xRT3.nets.join() === '2000,30,0',
    'R3a (THE GATE) every row reads its OWN formula value - the stored override was read by all '
    + 'three rows and showed 1000 on each (F1)', xRT3.nets);
  check(xRT3.journal.dr === 2030 && xRT3.journal.inputs.join() === '2000,30,0',
    'R3b AND THE MONEY: the entry posts 2030 over the three rows, not the 3000 one override '
    + 'multiplied into it', xRT3.journal);
  check(xRT3.report.join() === '2000,30,0',
    'R3c the report reads the same three values, so the screen and the ledger agree', xRT3.report);
  check(xRT3.rec === true,
    'R3d the record is NOT destroyed - the key may be unique again in next month\'s file, which is '
    + 'the whole point of a key-scoped store', xRT3.rec);
  check(/override|typed value/i.test(xRT3.panel) && /INV-7/.test(xRT3.panel),
    'R3e the operator is TOLD: the duplicate-key panel names the values that have stopped applying - '
    + 'it listed "Edits, offsets, corrections and comments" and omitted the two that reach a journal '
    + 'entry', xRT3.panel.replace(/<[^>]*>/g, ' ').slice(0, 300));
  check(xRT3.afterFix.nets.join() === '1000' && xRT3.afterFix.journal.dr === 1000,
    'R3f the control: with the duplicate rows gone the same record applies again and posts 1000, so '
    + 'this suppresses a value it cannot place and does not throw it away', xRT3.afterFix);

  /* ---------------------------------------------------------------------
     [38] R4 / finding F5 — THE ROLE MATRIX ASKS ABOUT RECORDS, NOT A BOX.
     S11 decided from `ac.allowOverride`, and unticking that box is silent and
     leaves every stored record applying (a deliberate decision: silently
     recomputing a number a preparer signed off is worse). So two silent
     template edits - untick, then assign the column as the AEG keyword
     column - put a stale override in charge of whether a row posts at all,
     and the entry posted 1007 where 7 was marked. The AEG loop's own comment
     names that matrix as the only thing making it safe to read the store
     there.
     ONLY THE OVERRIDE ARM GAINS THE RECORD TEST. A k:'typed' record on an
     unflagged column is FILE-SCOPED (it is honoured only on rows of the
     upload it was typed against), so a plain dropdown may still be the
     keyword column - which O14a asserts and which is a settled shape.
     --------------------------------------------------------------------- */
  section(38, 'R4 (F5) — a column that still holds overrides cannot become an AEG control column');
  const RT4 = makeRoot('share-r4');
  const brRT4 = await startBridge(RT4.root, PORT_FIX_ROLE); procs.push(brRT4.proc);
  const pgRT4 = await openReco(browser, brRT4);
  const xRT4 = await pgRT4.page.evaluate(async () => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_R4'; t.name = 'Role matrix vs records';
    t.columns = ['Invoice', 'Base', 'Kind', 'ToAccount']
      .map(n => ({ name: n, label: n, formats: [], isValue: n === 'Base' }));
    t.primaryKeys = ['Invoice']; t.valueColumn = 'Base'; t.docNumberColumn = '';
    t.displayColumns = t.columns.map(c => c.name);
    t.additionalColumns = [
      { name: 'Kw', type: 'formula', formula: '{Kind}', allowOverride: true },
      { name: 'AED', type: 'formula', formula: 'NUM({Base})' }
    ];
    t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id,
      keywordColumn: '', keywordValues: '', postEntryColumn: '', postEntryValue: '' };
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R4');
    RecoTemplate.open(tpl.id);
    await Reco.ingestData(tpl, [{ Invoice: 'INV-1', Base: '1000', Kind: 'SKIP', ToAccount: 'ACC1' },
                                { Invoice: 'INV-2', Base: '7', Kind: 'POST', ToAccount: 'ACC1' }],
      ['Invoice', 'Base', 'Kind', 'ToAccount']);
    App.closeModal(); AppState.activeRecoId = tpl.id; AppState.activeSubSection = 'reco';
    const sess = AppState.recoSessions.TPL_R4;
    const out = {};
    /* 1. With the box ON the matrix already refuses the role. */
    RecoTemplate.edit('TPL_R4');
    out.withBoxOn = RecoTemplate._exclusiveRoleConflict(RecoTemplate._editing, 'Kw', 'aeg.keywordColumn');
    App.closeModal();
    /* 2. Somebody once typed over the formula: SKIP became POST. */
    await Reco.setOverride(sess.data[0]._id, 'Kw', 'POST');
    await new Promise(x => setTimeout(x, 80));
    out.rec = JSON.parse(JSON.stringify((((AppState.extraValueMaster.TPL_R4 || {})['INV-1'] || {}).Kw) || null));
    /* 3. The box is unticked, and then the column is made the keyword column. */
    RecoTemplate.edit('TPL_R4');
    window.__toasts = [];
    RecoTemplate.toggleOverride(0, false);
    out.untickToasts = (window.__toasts || []).map(x => x.kind + ': ' + x.msg);
    out.flagGone = !((RecoTemplate._editing.additionalColumns[0] || {}).allowOverride);
    window.__toasts = [];
    out.setRole = RecoTemplate.setAegRole('keywordColumn', 'Kw');
    out.roleToasts = (window.__toasts || []).map(x => x.kind + ': ' + x.msg);
    out.kwAfter = String(RecoTemplate._editing.aegIntegration.keywordColumn || '');
    /* SAVED, so the next step opens the editor on the state these two edits
       really left behind - the box off and the record still on the share.
       Without the save the draft is thrown away and step 4 would be asking
       about a template that still has the box ticked. */
    RecoTemplate.saveTemplate();
    App.closeModal();
    /* 4. THE WAY FORWARD: clear the records and the role is allowed. The money
          is measured there, over the same two rows. */
    Reco._dropExtraValueRec('TPL_R4', 'INV-1', 'Kw');
    await new Promise(x => setTimeout(x, 80));
    RecoTemplate.edit('TPL_R4');
    out.setRole2 = RecoTemplate.setAegRole('keywordColumn', 'Kw');
    RecoTemplate._editing.aegIntegration.keywordValues = 'POST';
    RecoTemplate.saveTemplate();
    App.closeModal();
    const tpl2 = AppState.recoTemplates.find(x => x.id === 'TPL_R4');
    const s2 = AppState.recoSessions.TPL_R4;
    s2.selectedRows = {}; s2.data.forEach(r => { s2.selectedRows[r._id] = true; });
    Reco.previewEntryFromSelection(false);
    const ctx = Reco._pendingEntry || {};
    out.picked = (ctx.sourceRows || []).map(r => String(r.Invoice) + ':' + String(r.Base));
    out.dr = (ctx.lines || []).reduce((a, l) => a + U.num(l.Dr || l.dr || 0), 0);
    App.closeModal(); Reco._pendingEntry = null;
    out.savedKw = String((tpl2.aegIntegration || {}).keywordColumn || '');
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    return out;
  });
  note('R4 the matrix with the box ON', xRT4.withBoxOn);
  note('R4 the stored record', xRT4.rec);
  note('R4 the untick', { toasts: xRT4.untickToasts, flagGone: xRT4.flagGone });
  note('R4 the role assignment with the box OFF and the record still there',
    { setRole: xRT4.setRole, toasts: xRT4.roleToasts, keywordColumn: xRT4.kwAfter });
  note('R4 after clearing the record', { setRole2: xRT4.setRole2, picked: xRT4.picked, dr: xRT4.dr });
  check(!!xRT4.withBoxOn && xRT4.rec && xRT4.rec.v === 'POST' && xRT4.rec.prev === 'SKIP' && xRT4.flagGone,
    'R4 premise: the matrix refuses the role while the box is on, the override really did turn SKIP '
    + 'into POST, and unticking really does clear the flag',
    { matrix: xRT4.withBoxOn, rec: xRT4.rec, flagGone: xRT4.flagGone });
  check(xRT4.untickToasts.some(s => /\b1\b/.test(s) && /override/i.test(s)),
    'R4a unticking the box now SAYS that 1 stored override keeps applying - it was silent, and the '
    + 'records outlive the box by design', xRT4.untickToasts);
  check(xRT4.setRole === false && xRT4.kwAfter === '',
    'R4b (THE GATE) the column cannot be made the AEG keyword column while it holds override '
    + 'records - two silent edits used to be enough, and the matrix was the only thing making it '
    + 'safe to read the store in the AEG loop (F5)', { setRole: xRT4.setRole, kw: xRT4.kwAfter });
  check(xRT4.roleToasts.some(s => /^error/.test(s) && /\b1\b/.test(s) && /Kw/.test(s)),
    'R4c and the refusal names the column and how many records are still live', xRT4.roleToasts);
  check(xRT4.setRole2 === true && xRT4.savedKw === 'Kw',
    'R4d the way forward works: with the records cleared the same assignment is allowed, so this is '
    + 'a refusal about live records and not a permanent ban', { setRole2: xRT4.setRole2, saved: xRT4.savedKw });
  check(xRT4.picked.join() === 'INV-2:7' && xRT4.dr === 7,
    'R4e AND THE MONEY: the entry posts 7 over the one row the extract marked POST - with the stale '
    + 'record in charge of the filter it posted 1007', { picked: xRT4.picked, dr: xRT4.dr });

  /* ---------------------------------------------------------------------
     [39] R5 / finding F4 — A NON-NUMERIC OVERRIDE AT THE JOURNAL.
     #26 stores a value U.isNumeric rejects VERBATIM rather than refusing it,
     and that is deliberate and stays: decision J.8 is precisely about an
     override turning a numeric column non-numeric, a formula column's kind is
     DERIVED from its values, and a refusal at the write site made J.8
     untestable (the builders' couldNotBuild says so). The reviewer is also
     right: the stated reason - "a dependent formula then says #ERR, which is
     loud" - is false for this app's own NUM() idiom. NUM('1.234,50') is 1.23
     and NUM("'500") is 0, so the ledger received 1.23 for a cell reading
     1.234,50 and NOTHING for a cell reading '500, with no toast anywhere.
     BOTH ARE RIGHT, so the store keeps the value and the REFUSAL GOES WHERE
     IT WOULD REACH A JOURNAL ENTRY: Reco.previewEntryFromSelection refuses a
     selection holding an override that turned a numeric cell non-numeric,
     naming the key, the column and the characters. Nothing is posted and
     nothing is stored differently.
     --------------------------------------------------------------------- */
  section(39, 'R5 (F4) — a non-numeric override is kept verbatim AND refused at the journal');
  const RT5 = makeRoot('share-r5');
  const brRT5 = await startBridge(RT5.root, PORT_FIX_NUM); procs.push(brRT5.proc);
  const pgRT5 = await openReco(browser, brRT5);
  const xRT5 = await pgRT5.page.evaluate(async () => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_R5'; t.name = 'Non-numeric override';
    t.columns = ['Invoice', 'Base', 'Reco', 'ToAccount']
      .map(n => ({ name: n, label: n, formats: [], isValue: n === 'Base' }));
    t.primaryKeys = ['Invoice']; t.valueColumn = 'Base'; t.docNumberColumn = '';
    t.displayColumns = t.columns.map(c => c.name);
    t.additionalColumns = [
      { name: 'Net', type: 'formula', formula: 'NUM({Base})*2', allowOverride: true },
      { name: 'AED', type: 'formula', formula: 'NUM({Net})' }
    ];
    t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id,
      keywordColumn: '', keywordValues: '', postEntryColumn: '', postEntryValue: '' };
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R5');
    RecoTemplate.open(tpl.id);
    await Reco.ingestData(tpl, [{ Invoice: 'INV-1', Base: '10', Reco: 'R1', ToAccount: 'ACC1' },
                                { Invoice: 'INV-2', Base: '20', Reco: 'R1', ToAccount: 'ACC1' },
                                { Invoice: 'INV-3', Base: '30', Reco: 'R1', ToAccount: 'ACC1' }],
      ['Invoice', 'Base', 'Reco', 'ToAccount']);
    App.closeModal(); AppState.activeRecoId = tpl.id; AppState.activeSubSection = 'reco';
    const sess = AppState.recoSessions.TPL_R5;
    const row = sess.data[0];
    const out = { cases: [] };
    const tryPost = async (typed) => {
      await Reco.setOverride(row._id, 'Net', typed);
      await new Promise(x => setTimeout(x, 60));
      const rec = JSON.parse(JSON.stringify((((AppState.extraValueMaster.TPL_R5 || {})['INV-1'] || {}).Net) || null));
      let kind = null;
      try { kind = (XlSchema.build(tpl, sess).byName.get('Net') || {}).kind; } catch (e) { kind = 'ERR'; }
      sess.selectedRows = {}; sess.data.forEach(r => { sess.selectedRows[r._id] = true; });
      window.__toasts = [];
      Reco._pendingEntry = null;
      Reco.previewEntryFromSelection(false);
      const ctx = Reco._pendingEntry;
      const dr = ((ctx || {}).lines || []).reduce((a, l) => a + U.num(l.Dr || l.dr || 0), 0);
      App.closeModal(); Reco._pendingEntry = null;
      const o = { typed: typed, storedV: rec ? rec.v : null, storedTyped: rec ? (rec.typed || null) : null,
                  kind: kind, preview: !!ctx, dr: dr,
                  toasts: (window.__toasts || []).map(x => x.kind + ': ' + x.msg) };
      await Reco.applyEdits(tpl, sess, [{ row: row, col: 'Net', clear: true }],
        { source: 'grid', trusted: true, schema: Reco._ovSchema(tpl, sess) });
      await new Promise(x => setTimeout(x, 60));
      return o;
    };
    /* The two cases the reviewer measured in a ledger, plus the control. */
    out.cases.push(await tryPost('1.234,50'));   // U.num -> 1.2345: the ledger got 1.23
    out.cases.push(await tryPost("'500"));       // U.num -> 0: the 500 contributed nothing
    out.cases.push(await tryPost('abc'));
    out.cases.push(await tryPost('1,234.50'));   // the CONTROL: canonicalises, must still post
    /* And with nothing overridden at all, so the baseline is on the record. */
    sess.selectedRows = {}; sess.data.forEach(r => { sess.selectedRows[r._id] = true; });
    Reco._pendingEntry = null;
    Reco.previewEntryFromSelection(false);
    out.clean = ((Reco._pendingEntry || {}).lines || []).reduce((a, l) => a + U.num(l.Dr || l.dr || 0), 0);
    App.closeModal(); Reco._pendingEntry = null;
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    return out;
  });
  xRT5.cases.forEach(c => note('R5 typed ' + JSON.stringify(c.typed), c));
  note('R5 with no override at all', xRT5.clean);
  const xEuro = xRT5.cases[0], xQuote = xRT5.cases[1], xAbc = xRT5.cases[2], xNumOk = xRT5.cases[3];
  check(xRT5.clean === 120,
    'R5 premise: the three rows are worth 20 + 40 + 60 = 120 with no override', xRT5.clean);
  check(xEuro.storedV === '1.234,50' && xEuro.kind === 'text',
    'R5a the store still keeps it VERBATIM and the column\'s export kind still goes to text - '
    + 'decision J.8 is untouched, which is what the builders could not build any other way',
    { v: xEuro.storedV, kind: xEuro.kind });
  check(xEuro.preview === false && xEuro.dr === 0,
    'R5b (THE GATE) the entry preview REFUSES: no entry is pending and nothing can be committed - '
    + 'the ledger received 1.23 for a cell reading 1.234,50 (F4)', xEuro);
  check(xEuro.toasts.some(s => /^error/.test(s) && /INV-1/.test(s) && /Net/.test(s)
                                && s.indexOf('1.234,50') !== -1),
    'R5c and the refusal names the row key, the column and the characters that were not understood',
    xEuro.toasts);
  check(xQuote.preview === false && xQuote.dr === 0,
    'R5d the silent ZERO goes the same way: "\'500" posted 120 - the 500 contributed nothing at all '
    + 'and no toast said so', xQuote);
  check(xAbc.preview === false && xAbc.dr === 0,
    'R5e ...and so does plain text in a numeric column', xAbc);
  check(xNumOk.preview === true && xNumOk.dr === 1334.5 && xNumOk.storedV === '1234.5',
    'R5f THE CONTROL: an override that IS a number still posts, and posts 1234.5 + 40 + 60 - this is '
    + 'a refusal about values U.isNumeric rejects, not about overrides', xNumOk);

  /* ---------------------------------------------------------------------
     [40] R6 / finding F9, the half the first fix round left open.
     Naming the data set by the upload fixed two uploads in one sitting, but
     the stamp is a COUNT of this session's own dataSetIds and Reco.clearSession
     installs a FRESH session - so after the sanctioned Clear the counter
     restarts at 1 and the next upload is called '#u1' again, which is the name
     the records already on the share were typed against. A DIFFERENT extract
     uploaded after a Clear on the same day therefore came up carrying the
     previous extract's values, with the carry flag off and no mark.
     (Reviewer B's own p11_clearupload.mjs, which still failed after 29cb95d.)
     THE STAMP NOW ALSO CLEARS THE HIGHEST STAMP ANY RECORD ALREADY USES for
     that day file, so a name is never reused while a record names it.
     --------------------------------------------------------------------- */
  section(40, 'R6 (F9) — after a Clear, a DIFFERENT extract the same day comes up blank');
  const RT6 = makeRoot('share-r6');
  const brRT6 = await startBridge(RT6.root, PORT_FIX_CLR); procs.push(brRT6.proc);
  const pgRT6 = await openReco(browser, brRT6);
  const xRT6 = await pgRT6.page.evaluate(async () => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_R6'; t.name = 'Clear then another extract';
    t.columns = ['Invoice', 'Amount'].map(n => ({ name: n, label: n, formats: [], isValue: n === 'Amount' }));
    t.primaryKeys = ['Invoice']; t.valueColumn = 'Amount';
    t.displayColumns = ['Invoice', 'Amount'];
    t.additionalColumns = [{ name: 'Vendor', type: 'custom' }];
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R6');
    RecoTemplate.open(tpl.id);
    const fields = ['Invoice', 'Amount'];
    await Reco.ingestData(tpl, [{ Invoice: 'INV-1', Amount: '100' }, { Invoice: 'INV-2', Amount: '200' }], fields);
    App.closeModal(); AppState.activeRecoId = tpl.id; AppState.activeSubSection = 'reco';
    const out = {};
    const vendors = () => {
      const s = AppState.recoSessions.TPL_R6;
      Reco._fullPass();
      try {
        return s.data.map(r => String(r.Invoice) + '=' + String(Reco.rowFull(tpl, s, r).Vendor));
      } finally { Reco._fullEnd(); }
    };
    const marks = () => {
      const s = AppState.recoSessions.TPL_R6;
      return s.data.map(r => String(r.Invoice) + ':' + !!Reco._extraCarried(tpl, s, r, 'Vendor'));
    };
    let sess = AppState.recoSessions.TPL_R6;
    await Reco.applyEdits(tpl, sess, [{ row: sess.data[0], col: 'Vendor', value: 'SEPT ACME' },
                                      { row: sess.data[1], col: 'Vendor', value: 'SEPT BORAX' }],
      { source: 'grid', trusted: true });
    await new Promise(x => setTimeout(x, 80));
    out.typed = vendors();
    out.ds1 = (sess.dataSetIds || []).slice();
    /* THE SANCTIONED CLEAR, then a DIFFERENT extract on the same calendar day
       (a catch-up, a second period, a corrected file). */
    const realConfirm = window.confirm; window.confirm = () => true;
    try { Reco.clearSession(); } finally { window.confirm = realConfirm; }
    sess = AppState.recoSessions.TPL_R6;
    out.dsCleared = (sess.dataSetIds || []).slice();
    await Reco.ingestData(tpl, [{ Invoice: 'INV-1', Amount: '555' }, { Invoice: 'INV-2', Amount: '666' }], fields);
    App.closeModal();
    sess = AppState.recoSessions.TPL_R6;
    await new Promise(x => setTimeout(x, 80));
    out.ds2 = (sess.dataSetIds || []).slice();
    out.after = vendors();
    out.marks = marks();
    out.recDs = (((AppState.extraValueMaster.TPL_R6 || {})['INV-1'] || {}).Vendor || {}).ds || null;
    /* THE CONTROL: reopening the day file those values were typed into from
       version history still shows them - the route the Clear's confirm is
       about, and the one that must not break. */
    const files = await Versioning.listFiles(tpl);
    const file = (files[0] && (files[0].fullPath || files[0].path)) || null;
    sess.data = [];
    await Reco.loadVersionedFile(file, 'TPL_R6');
    out.reopened = vendors();
    out.reopenedDs = (AppState.recoSessions.TPL_R6.dataSetIds || []).slice();
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    return out;
  });
  note('R6 the values typed into the first extract', xRT6.typed);
  note('R6 the data sets', { beforeClear: xRT6.ds1, afterClear: xRT6.dsCleared, afterSecondUpload: xRT6.ds2,
                             recordWasTypedAgainst: xRT6.recDs });
  note('R6 the second extract\'s cells', xRT6.after);
  note('R6 reopening the day file from history', { cells: xRT6.reopened, ds: xRT6.reopenedDs });
  check(xRT6.typed.join() === 'INV-1=SEPT ACME,INV-2=SEPT BORAX' && xRT6.dsCleared.length === 0,
    'R6 premise: the values are on the first extract\'s rows, and the Clear really does empty the '
    + 'data sets - which is why the stamp counter restarted', { typed: xRT6.typed, cleared: xRT6.dsCleared });
  check(xRT6.after.join() === 'INV-1=,INV-2=',
    'R6a (THE GATE) the DIFFERENT extract uploaded after the Clear comes up BLANK with the carry '
    + 'flag off - it carried SEPT ACME and SEPT BORAX across two extracts (F9)', xRT6.after);
  check(xRT6.ds2[0] !== xRT6.recDs,
    'R6b and the reason is in the name: the new upload is NOT called what the records were typed '
    + 'against', { newUpload: xRT6.ds2[0], record: xRT6.recDs });
  check(xRT6.marks.every(m => /:false$/.test(m)),
    'R6c nothing is marked carried either, because nothing was carried', xRT6.marks);
  check(xRT6.reopened.join() === 'INV-1=SEPT ACME,INV-2=SEPT BORAX',
    'R6d THE CONTROL: reopening the day file those values were typed into from version history still '
    + 'shows them - the scope is the upload while two are on screen, and the file once it is one '
    + 'file again', { cells: xRT6.reopened, ds: xRT6.reopenedDs });

  /* =======================================================================
     ROUND 3 OF THE FIX — fixer 2's findings: the HIGHs and MEDIUMs round 2
     did not reach. Reviewer ids are cited. EVERY SECTION BELOW FAILED BEFORE
     ITS FIX against the working tree as fixer 2 received it, recorded in
     scratchpad/store/fix2/out/*.pre.txt (APP_FILE=.../fix2/Reco.html.bak).
     Every assertion reads a VALUE - a record on the share, a file that does
     or does not exist, the characters in a sentence the operator read - and
     never a function or column name.
     ======================================================================= */

  /* ---------------------------------------------------------------------
     [41] X1 / findings F11 + F19 — A SHARE THAT STOPS ANSWERING IS SAID OUT
     LOUD, AND THE TYPING IS KEPT.

     ONE CAUSE, TWO MOMENTS. `Store._readJsonFile` answers `_UNREADABLE` for
     a read that threw and for a file that would not parse, and
     `Store._mergeJob` turned that into `out.refused` and NOTHING ELSE: no
     toast, no `Store.loadProblems` entry, no retry. The buffered intents sat
     with no timer, and `Store._flushMergeTimers` only fires timers that
     exist, so `AppState.flush()` resolved, the operator closed the app, and
     four typed values were gone - with no second copy anywhere, because
     applyEdits has already deleted the legacy `manualTags` entry for that
     cell. That is F11.
     F19 is the same silence one keystroke earlier: `Store.loadAll` quarantined
     a damaged values file and said "starting it empty", which reads
     recoverable, while the truth is that mergeWrite will refuse every write
     for the session - and the sentence that says so could not fire on the
     first burst, because the latch was set inside the job that burst started.

     THE FIX IS ONE RULE IN THREE PLACES: a file we could not read is never
     written to, the operator is told at the moment it is KNOWN, and what they
     typed is kept and retried rather than dropped.
     --------------------------------------------------------------------- */
  section(41, 'X1 (F11/F19) — the share stops answering: the operator is told, and the typing is kept');
  const SAY = makeRoot('share-say');
  const brSAY = await startBridge(SAY.root, PORT_FIX_SAY); procs.push(brSAY.proc);
  const pgSAY = await openReco(browser, brSAY);
  await pgSAY.page.evaluate(SETUP + '([3])');
  await pgSAY.page.evaluate(TYPE + `(['TPL_K','Vendor',[[2,'SAFELY SAVED']]])`);
  const sayDisk0 = diskJson(SAY.root, 'reco/extraValueMaster.json');
  check(((((sayDisk0 || {}).TPL_K || {})['INV-3'] || {}).Vendor || {}).v === 'SAFELY SAVED',
    'X1 premise: while the folder answers, a typed value reaches the share', sayDisk0);

  const xSAY = await pgSAY.page.evaluate(async () => {
    /* THE SHARE STOPS ANSWERING READS, for this file only - the ordinary
       weather of a network folder, injected at the api seam, which is where a
       dropped share really fails. */
    const realRead = window.pywebview.api.read_file;
    window.__fault = true;
    window.pywebview.api.read_file = function (rel) {
      if (window.__fault && /extraValue/.test(String(rel)))
        return Promise.reject(new Error('the shared folder did not answer'));
      return realRead.apply(this, arguments);
    };
    window.__toasts = [];
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions.TPL_K;
    const res = await Reco.applyEdits(tpl, sess, [
      { row: sess.data[0], col: 'Vendor', value: 'TYPED WHILE THE SHARE WAS DOWN' },
      { row: sess.data[1], col: 'Vendor', value: 'AND THIS ONE TOO' }],
      { source: 'grid', trusted: true });
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    const out = {
      applied: res.applied,
      toasts: (window.__toasts || []).map(t => t.kind + ': ' + t.msg),
      problems: Store.loadProblems.slice(),
      lastErrorKey: Store.lastError ? Store.lastError.key : null,
      pendingWhileDown: AppState.pendingCount()
    };
    /* THE FOLDER COMES BACK. Nothing is typed again: what the operator
       already typed has to reach the share by itself. */
    window.__fault = false;
    if (typeof Store.idle === 'function') await Store.idle();
    await new Promise(r => setTimeout(r, 60));
    if (typeof Store.idle === 'function') await Store.idle();
    out.pendingAfter = AppState.pendingCount();
    window.pywebview.api.read_file = realRead;
    return out;
  });
  const sayDisk1 = diskJson(SAY.root, 'reco/extraValueMaster.json');
  const sayVals = ['INV-1', 'INV-2', 'INV-3'].map(k =>
    k + '=' + String(((((sayDisk1 || {}).TPL_K || {})[k] || {}).Vendor || {}).v || ''));
  note('X1 what the operator was told while the share was down', xSAY.toasts);
  note('X1 Store.loadProblems', xSAY.problems);
  note('X1 the share file after the folder answered again', sayVals);
  note('X1 pendingCount', { whileDown: xSAY.pendingWhileDown, after: xSAY.pendingAfter });
  check(xSAY.toasts.some(t => /^error: /.test(t) && /shared folder/.test(t)),
    'X1a the operator is TOLD that nothing is reaching the shared folder - it was two typed values, '
    + 'applyEdits saying {applied:2}, and not one word (F11)', xSAY.toasts);
  check(xSAY.problems.some(p => /extraValueMaster\.json/.test(String(p))),
    'X1b and it is in Store.loadProblems too, so the state is still readable after the toast has '
    + 'gone', xSAY.problems);
  check(xSAY.pendingWhileDown > 0,
    'X1c THE FACT THE RETRY STANDS ON, and it held before this fix too: the intents are still '
    + 'buffered, so the typing has not been thrown away - it had simply stopped being owned by '
    + 'anything that would try again', xSAY.pendingWhileDown);
  check(sayVals.join() === 'INV-1=TYPED WHILE THE SHARE WAS DOWN,INV-2=AND THIS ONE TOO,INV-3=SAFELY SAVED',
    'X1d (THE MONEY) BOTH typed values reach the share once the folder answers again, WITHOUT the '
    + 'operator typing them a second time, and the record that was already there is still there',
    sayVals);
  check(xSAY.pendingAfter === 0,
    'X1e ...and then nothing is owed: the retry cleared the buffered intents rather than leaving '
    + 'them to the next keystroke', xSAY.pendingAfter);
  await pgSAY.ctx.close();

  /* F19: the SAME file damaged at BOOT. The latch has to be known before the
     first keystroke, because the first keystroke is the one that used to get
     no answer at all. */
  const sayCorrupt = '{"TPL_K":{"INV-1":{"Vend';
  fs.writeFileSync(path.join(SAY.root, 'reco/extraValueMaster.json'), sayCorrupt);
  const pgSAY2 = await openReco(browser, brSAY);
  const xSAY2 = await pgSAY2.page.evaluate(async () => {
    const atBoot = { readOnly: !!Store.readOnlyKeys.extraValueMaster, problems: Store.loadProblems.slice() };
    window.__toasts = [];
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions.TPL_K;
    await Reco.applyEdits(tpl, sess, [{ row: sess.data[0], col: 'Vendor', value: 'THE FIRST KEYSTROKE' }],
      { source: 'grid', trusted: true });
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    const first = (window.__toasts || []).map(t => t.kind + ': ' + t.msg);
    window.__toasts = [];
    await Reco.applyEdits(tpl, sess, [{ row: sess.data[1], col: 'Vendor', value: 'THE SECOND' }],
      { source: 'grid', trusted: true });
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    return { atBoot, first, second: (window.__toasts || []).map(t => t.kind + ': ' + t.msg) };
  });
  const quarantined = fs.existsSync(path.join(SAY.root, 'reco/_corrupt'))
    ? fs.readdirSync(path.join(SAY.root, 'reco/_corrupt')).filter(f => /^extraValueMaster_/.test(f)) : [];
  note('X1 the boot state with a damaged values file', xSAY2.atBoot);
  note('X1 the first keystroke', xSAY2.first);
  note('X1 the quarantine copies', quarantined);
  check(xSAY2.atBoot.readOnly === true,
    'X1f with the values file damaged, the app knows at BOOT that nothing can be saved to it - the '
    + 'latch used to be set inside the job the first keystroke started (F19)', xSAY2.atBoot);
  check(xSAY2.atBoot.problems.some(p => /nothing is being saved/.test(String(p)))
        && !xSAY2.atBoot.problems.some(p => /starting it empty/.test(String(p))),
    'X1g and the boot message is the honest one: not "starting it empty", which reads recoverable, '
    + 'but that nothing is being saved to it this session', xSAY2.atBoot.problems);
  check(xSAY2.first.some(t => /^error: /.test(t) && /nothing is being saved/.test(t)),
    'X1h THE FIRST KEYSTROKE is told, not just the second - that first value is as unsaved as the '
    + 'rest (F19)', xSAY2.first);
  check(quarantined.length === 1,
    'X1i and the damaged file is quarantined ONCE, not again on the first write', quarantined);
  check(fs.readFileSync(path.join(SAY.root, 'reco/extraValueMaster.json'), 'utf8') === sayCorrupt,
    'X1j THE RULE THAT ALREADY HELD, re-asserted here: the damaged file itself is never overwritten',
    fs.readFileSync(path.join(SAY.root, 'reco/extraValueMaster.json'), 'utf8').slice(0, 60));
  await pgSAY2.ctx.close();


  /* ---------------------------------------------------------------------
     [42] X2 / finding F17 — A TEMPLATE WHOSE OWN VALUES FILE CANNOT BE READ
     IS NOT GIVEN A SECOND HOME.

     Decision G's escape hatch routes a template's records to
     reco/extraValues/<tplId>.json, and `Store.loadAll` learns the routing
     from the files it finds. On a file it could not read or parse it pushed a
     loadProblems line and `continue`d - skipping the very line that records
     the routing - so `Reco._extraValueFile` answered "the main file" and the
     template acquired TWO homes. The split file then WINS per cell on the
     next boot (which is deliberate: it is the newer home), so the value typed
     while the share was broken was replaced on screen by the colleague's
     older one.

     NARROWED TO A REFUSAL, which is what this app does where two readings are
     possible: the routing table learns the template is split from the
     FILENAME, and that one FILE is latched read-only, so the write is refused
     and said out loud instead of being accepted into the wrong file. The
     reviewer's own probe (skB/p10_split.mjs P10b) asserts the typed value
     survives, which needs a fix that writes it into a file it could not read;
     X2d says what happens instead, and X2e is the control that proves the
     refusal is scoped to the damaged FILE and not to the feature.
     --------------------------------------------------------------------- */
  section(42, 'X2 (F17) — a damaged reco/extraValues/*.json refuses the write instead of taking a second home');
  const SPL = makeRoot('share-spl');
  const brSPL = await startBridge(SPL.root, PORT_FIX_SPL); procs.push(brSPL.proc);
  const pgSPL0 = await openReco(browser, brSPL);
  await pgSPL0.page.evaluate(SETUP + '([3])');
  await pgSPL0.ctx.close();
  fs.mkdirSync(path.join(SPL.root, 'reco/extraValues'), { recursive: true });
  const splHealthy = JSON.stringify({ TPL_K: { 'INV-1': { Vendor: {
    k: 'typed', v: 'SPLIT ACME', ds: 'split-ds', by: 'Colleague', at: '2026-10-10T09:00:00.000Z' } } } });
  fs.writeFileSync(path.join(SPL.root, 'reco/extraValues/TPL_K.json'), splHealthy);
  const pgSPL1 = await openReco(browser, brSPL);
  const splOk = await pgSPL1.page.evaluate(() => ({
    routed: (Store.extraValueFiles || {}).TPL_K || null,
    v: ((((AppState.extraValueMaster || {}).TPL_K || {})['INV-1'] || {}).Vendor || {}).v || null
  }));
  note('X2 the healthy boot', splOk);
  check(splOk.routed === 'reco/extraValues/TPL_K.json' && splOk.v === 'SPLIT ACME',
    'X2 premise: a healthy split file is read and the template is routed to it', splOk);
  await pgSPL1.ctx.close();

  /* The share half-writes that file - the case the loader already has a
     message for. */
  const splBroken = '{"TPL_K":{"INV-1":{"Vend';
  fs.writeFileSync(path.join(SPL.root, 'reco/extraValues/TPL_K.json'), splBroken);
  const pgSPL2 = await openReco(browser, brSPL);
  const xSPL = await pgSPL2.page.evaluate(async () => {
    const atBoot = {
      routed: (Store.extraValueFiles || {}).TPL_K || null,
      problems: Store.loadProblems.slice()
    };
    window.__toasts = [];
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions.TPL_K;
    const res = await Reco.applyEdits(tpl, sess, [{ row: sess.data[1], col: 'Vendor', value: 'TYPED TODAY' }],
      { source: 'grid', trusted: true });
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    const told = (window.__toasts || []).map(t => t.kind + ': ' + t.msg);
    /* THE CONTROL: a template that is NOT split still saves. One damaged file
       must not stop the whole team typing. */
    const t2 = AppState.recoTemplates.find(x => x.id === 'TPL_2');
    const s2 = AppState.recoSessions.TPL_2;
    await Reco.applyEdits(t2, s2, [{ row: s2.data[0], col: 'Vendor', value: 'ANOTHER TEMPLATE' }],
      { source: 'grid', trusted: true });
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    return { atBoot, applied: res.applied, told };
  });
  const splMain = diskJson(SPL.root, 'reco/extraValueMaster.json');
  note('X2 the boot with the split file damaged', xSPL.atBoot);
  note('X2 what the operator was told when they typed', xSPL.told);
  note('X2 the main file afterwards', splMain);
  check(xSPL.atBoot.routed === 'reco/extraValues/TPL_K.json',
    'X2a the routing table still says where that template\'s records live, read from the FILENAME - '
    + 'it used to forget, which is what sent the writes to the main file (F17)', xSPL.atBoot.routed);
  check(!(((splMain || {}).TPL_K || {})['INV-2']),
    'X2b (THE MONEY) nothing for that template is written into reco/extraValueMaster.json, so one '
    + 'template never has two homes and the older copy cannot win later',
    (splMain || {}).TPL_K);
  check(xSPL.told.some(t => /^error: /.test(t) && /extraValues\/TPL_K\.json/.test(t)),
    'X2c and the operator is told, naming the file that could not be read, instead of a green '
    + 'nothing', xSPL.told);
  check(fs.readFileSync(path.join(SPL.root, 'reco/extraValues/TPL_K.json'), 'utf8') === splBroken,
    'X2d the damaged file is not overwritten either: the value typed while it was broken is '
    + 'REFUSED, not stored somewhere else and not written over a file we could not read',
    fs.readFileSync(path.join(SPL.root, 'reco/extraValues/TPL_K.json'), 'utf8').slice(0, 60));
  check(((((splMain || {}).TPL_2 || {})['INV-1||L1'] || {}).Vendor || {}).v === 'ANOTHER TEMPLATE',
    'X2e THE CONTROL: a template whose own file is fine still saves normally - the refusal is '
    + 'scoped to the one FILE that could not be read, not to the feature', (splMain || {}).TPL_2);
  await pgSPL2.ctx.close();


  /* ---------------------------------------------------------------------
     [43] X3 / finding F12 — THE COLUMN'S NAME IS THE ONLY THING THAT
     CONNECTS A RECORD TO A COLUMN.

     The records are keyed [tplId][pk][colName], so a rename in the editor
     left 400 vendor names stranded under the old name and the operator was
     told "Template saved to database" in green; a removal left them on the
     shared folder for ever; and a column added months later that happened to
     reuse the name arrived PRE-FILLED with values nobody on the team typed
     into it - which, on an AEG keyword or post-entry column, is the same
     mechanism that decides which rows post.

     ONE CAUSE, ONE PLACE: saveTemplate already diffs prevExtras against
     t.additionalColumns for #30's promotion, so the rename and the removal
     are read off that same pair. A rename MIGRATES the records (nothing is
     lost, and it says how many moved); a removal ASKS, naming the count and
     saying it deletes them for everyone, and on yes drops them through S13.
     Reco.ssDeleteCol is the second route and gets the same two sentences,
     because its confirm already promises the values are removed.
     --------------------------------------------------------------------- */
  section(43, 'X3 (F12) — renaming an added column keeps its values; deleting it asks, and takes them');
  const COL = makeRoot('share-col');
  const brCOL = await startBridge(COL.root, PORT_FIX_COL); procs.push(brCOL.proc);
  const pgCOL = await openReco(browser, brCOL);
  await pgCOL.page.evaluate(SETUP + '([3])');
  await pgCOL.page.evaluate(TYPE + `(['TPL_K','Vendor',[[0,'ACME'],[1,'BORAX'],[2,'CERNO']]])`);
  const colStore0 = diskJson(COL.root, 'reco/extraValueMaster.json');
  check(['INV-1', 'INV-2', 'INV-3'].map(k => (((colStore0 || {}).TPL_K || {})[k] || {}).Vendor.v).join()
        === 'ACME,BORAX,CERNO',
    'X3 premise: the three typed values are on the share, keyed by the column NAME', (colStore0 || {}).TPL_K);

  const xREN = await pgCOL.page.evaluate(async () => {
    window.__toasts = [];
    const dialogs = []; const realConfirm = window.confirm;
    window.confirm = m => { dialogs.push(String(m)); return true; };
    RecoTemplate.edit('TPL_K');
    RecoTemplate._editing.additionalColumns.find(a => a.name === 'Vendor').name = 'Supplier';
    RecoTemplate.saveTemplate();
    window.confirm = realConfirm;
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    await new Promise(r => setTimeout(r, 250)); if (typeof Store.idle === 'function') await Store.idle();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions.TPL_K;
    AppState.activeRecoId = 'TPL_K';
    Reco._fullPass();
    let cells; try { cells = sess.data.map(r => r.Invoice + '=' + String(Reco.rowFull(tpl, sess, r).Supplier)); }
    finally { Reco._fullEnd(); }
    return { cells, dialogs, toasts: (window.__toasts || []).map(t => t.kind + ': ' + t.msg),
             cols: (tpl.additionalColumns || []).map(a => a.name) };
  });
  const colStore1 = diskJson(COL.root, 'reco/extraValueMaster.json');
  note('X3 the renamed column\'s cells', xREN.cells);
  note('X3 what the operator was told', xREN.toasts);
  note('X3 the share after the rename', (colStore1 || {}).TPL_K);
  check(xREN.cells.join() === 'INV-1=ACME,INV-2=BORAX,INV-3=CERNO',
    'X3a (THE MONEY) renaming the column KEEPS the three values the team typed into it - they used '
    + 'to go blank behind a green "Template saved" (F12)', xREN.cells);
  check(['INV-1', 'INV-2', 'INV-3'].every(k => {
      const cell = ((colStore1 || {}).TPL_K || {})[k] || {};
      return cell.Supplier && cell.Supplier.v && !cell.Vendor;
    }),
    'X3b and they MOVED on the shared folder, under the new name, rather than being copied or left '
    + 'stranded under the old one', (colStore1 || {}).TPL_K);
  check(xREN.toasts.some(t => /3 value/.test(t) && /Supplier/.test(t)),
    'X3c and the operator is told how many values moved and where', xREN.toasts);

  /* Rename it back, then DELETE it - first CANCELLING, which must keep both
     the column and the values. */
  const xDEL = await pgCOL.page.evaluate(async () => {
    const realConfirm = window.confirm;
    window.confirm = () => true;
    RecoTemplate.edit('TPL_K');
    RecoTemplate._editing.additionalColumns.find(a => a.name === 'Supplier').name = 'Vendor';
    RecoTemplate.saveTemplate();
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    await new Promise(r => setTimeout(r, 250)); if (typeof Store.idle === 'function') await Store.idle();

    /* CANCEL. */
    const saidNo = [];
    window.confirm = m => { saidNo.push(String(m)); return false; };
    RecoTemplate.edit('TPL_K');
    let i = RecoTemplate._editing.additionalColumns.findIndex(a => a.name === 'Vendor');
    RecoTemplate._editing.additionalColumns.splice(i, 1);
    RecoTemplate.saveTemplate();
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    const afterNo = {
      cols: (AppState.recoTemplates.find(x => x.id === 'TPL_K').additionalColumns || []).map(a => a.name),
      recs: Object.keys((AppState.extraValueMaster.TPL_K || {})).filter(
        k => ((AppState.extraValueMaster.TPL_K || {})[k] || {}).Vendor).length
    };

    /* YES. */
    window.__toasts = [];
    const saidYes = [];
    window.confirm = m => { saidYes.push(String(m)); return true; };
    RecoTemplate.edit('TPL_K');
    i = RecoTemplate._editing.additionalColumns.findIndex(a => a.name === 'Vendor');
    RecoTemplate._editing.additionalColumns.splice(i, 1);
    RecoTemplate.saveTemplate();
    window.confirm = realConfirm;
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    await new Promise(r => setTimeout(r, 250)); if (typeof Store.idle === 'function') await Store.idle();

    /* ...and a brand-new column that happens to reuse the name. */
    window.confirm = () => true;
    RecoTemplate.edit('TPL_K');
    RecoTemplate._editing.additionalColumns.push({ name: 'Vendor', type: 'custom' });
    RecoTemplate.saveTemplate();
    window.confirm = realConfirm;
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions.TPL_K;
    Reco._fullPass();
    let fresh; try { fresh = sess.data.map(r => r.Invoice + '=' + String(Reco.rowFull(tpl, sess, r).Vendor)); }
    finally { Reco._fullEnd(); }
    return { saidNo, afterNo, saidYes, fresh };
  });
  const colStore2 = diskJson(COL.root, 'reco/extraValueMaster.json');
  note('X3 the confirm on removing the column', xDEL.saidYes);
  note('X3 after cancelling', xDEL.afterNo);
  note('X3 a brand-new column of the same name', xDEL.fresh);
  note('X3 the share after the removal', (colStore2 || {}).TPL_K);
  check(xDEL.saidYes.some(m => /3 /.test(m) && /everyone/i.test(m)),
    'X3d removing a column ASKS first, naming how many stored values go with it and that they go '
    + 'for everyone - it used to say nothing at all (F12)', xDEL.saidYes);
  check(xDEL.afterNo.cols.indexOf('Vendor') !== -1 && xDEL.afterNo.recs === 3,
    'X3e THE WAY BACK: cancelling that confirm keeps the column AND the three values',
    xDEL.afterNo);
  check(!Object.keys((colStore2 || {}).TPL_K || {}).some(
      k => (((colStore2 || {}).TPL_K || {})[k] || {}).Vendor),
    'X3f on yes the records leave the shared folder with the column, instead of sitting there under '
    + 'a name nothing in the app can show', (colStore2 || {}).TPL_K);
  check(xDEL.fresh.join() === 'INV-1=,INV-2=,INV-3=',
    'X3g (THE MONEY) a brand-new column that reuses the name starts EMPTY - it used to arrive '
    + 'pre-filled with ACME/BORAX/CERNO, values nobody typed into it (F12)', xDEL.fresh);

  /* THE SECOND ROUTE: the spreadsheet header's own delete. */
  const xSS = await pgCOL.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions.TPL_K;
    tpl.additionalColumns.push({ name: 'Scratch', type: 'custom', _ssAdded: true, _ssSingleUse: false });
    await Reco.applyEdits(tpl, sess, [{ row: sess.data[0], col: 'Scratch', value: 'SCRATCH ACME' },
                                      { row: sess.data[1], col: 'Scratch', value: 'SCRATCH BORAX' }],
      { source: 'grid', trusted: true });
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    const before = Object.keys(AppState.extraValueMaster.TPL_K || {}).filter(
      k => ((AppState.extraValueMaster.TPL_K || {})[k] || {}).Scratch).length;
    const asked = []; const realConfirm = window.confirm;
    window.confirm = m => { asked.push(String(m)); return true; };
    Reco.ssDeleteCol('Scratch');
    window.confirm = realConfirm;
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    await new Promise(r => setTimeout(r, 250)); if (typeof Store.idle === 'function') await Store.idle();
    return { before, asked };
  });
  const colStore3 = diskJson(COL.root, 'reco/extraValueMaster.json');
  note('X3 the spreadsheet delete confirm', xSS.asked);
  note('X3 the share after it', (colStore3 || {}).TPL_K);
  check(xSS.before === 2 && xSS.asked.some(m => /2 /.test(m)),
    'X3h the spreadsheet header\'s own delete names the count too - its confirm already promised '
    + 'the values were removed', xSS);
  check(!Object.keys((colStore3 || {}).TPL_K || {}).some(
      k => (((colStore3 || {}).TPL_K || {})[k] || {}).Scratch),
    'X3i ...and it really removes them from the shared folder, which it never did (F12)',
    (colStore3 || {}).TPL_K);
  await pgCOL.ctx.close();


  /* ---------------------------------------------------------------------
     [44] X4 / finding F20 — THE SETTINGS THAT DECIDE WHETHER A DURABLE
     RECORD IS READ ARE CHANGED WITH NO WORD TO THE OPERATOR.

     The one thing on that folder with no second copy - no mirror on the
     session, no row in the CSV - is the one thing the key-change confirm did
     not name, so an operator who read its five items carefully and decided
     the trade-off was acceptable decided it without knowing the typed values
     were in it. Unticking carry changed what every stored record MEANS and
     said nothing. Flipping a column's type made its records unreachable and
     said nothing.
     Round 2 did two of F20's four sentences (the override untick and the
     duplicate-key panel); these are the other two, plus the type change.
     --------------------------------------------------------------------- */
  section(44, 'X4 (F20) — the key change, the carry untick and a type change all say what they do');
  const CONF = makeRoot('share-conf');
  const brCONF = await startBridge(CONF.root, PORT_FIX_CONF); procs.push(brCONF.proc);
  const pgCONF = await openReco(browser, brCONF);
  await pgCONF.page.evaluate(SETUP + '([3])');
  await pgCONF.page.evaluate(TYPE + `(['TPL_K','Vendor',[[0,'ACME'],[1,'BORAX'],[2,'CERNO']]])`);
  await pgCONF.page.evaluate(TYPE + `(['TPL_2','Vendor',[[0,'TWO-KEY ACME']]])`);

  const xCONF = await pgCONF.page.evaluate(async () => {
    const out = {};
    /* 1. THE CARRY UNTICK, with records already written under the flag. */
    window.__toasts = [];
    RecoTemplate.edit('TPL_K');
    let i = RecoTemplate._editing.additionalColumns.findIndex(a => a.name === 'Vendor');
    RecoTemplate.toggleCarry(i, true);
    RecoTemplate.saveTemplate();
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    window.__toasts = [];
    RecoTemplate.edit('TPL_K');
    i = RecoTemplate._editing.additionalColumns.findIndex(a => a.name === 'Vendor');
    RecoTemplate.toggleCarry(i, false);
    out.untick = (window.__toasts || []).map(t => t.kind + ': ' + t.msg);
    RecoTemplate.saveTemplate();
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    out.recsAfterUntick = Object.keys(AppState.extraValueMaster.TPL_K || {}).filter(
      k => ((AppState.extraValueMaster.TPL_K || {})[k] || {}).Vendor).length;

    /* 2. A TYPE CHANGE AWAY FROM custom, with records. Cancel, then accept. */
    const realConfirm = window.confirm;
    const askedNo = [];
    window.confirm = m => { askedNo.push(String(m)); return false; };
    RecoTemplate.edit('TPL_K');
    let ac = RecoTemplate._editing.additionalColumns.find(a => a.name === 'Vendor');
    ac.type = 'formula'; ac.formula = 'NUM({Amount})*2';
    RecoTemplate.saveTemplate();
    window.confirm = realConfirm;
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    out.askedNo = askedNo;
    out.typeAfterNo = (AppState.recoTemplates.find(x => x.id === 'TPL_K').additionalColumns
      .find(a => a.name === 'Vendor') || {}).type;
    const askedYes = [];
    window.confirm = m => { askedYes.push(String(m)); return true; };
    RecoTemplate.edit('TPL_K');
    ac = RecoTemplate._editing.additionalColumns.find(a => a.name === 'Vendor');
    ac.type = 'formula'; ac.formula = 'NUM({Amount})*2';
    RecoTemplate.saveTemplate();
    window.confirm = realConfirm;
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    out.askedYes = askedYes;
    out.typeAfterYes = (AppState.recoTemplates.find(x => x.id === 'TPL_K').additionalColumns
      .find(a => a.name === 'Vendor') || {}).type;

    /* 3. THE KEY CHANGE, on the two-key template that holds one record. */
    const askedKey = [];
    window.confirm = m => { askedKey.push(String(m)); return true; };
    RecoTemplate.edit('TPL_2');
    RecoTemplate._editing.primaryKeys = ['Line'];
    RecoTemplate.saveTemplate();
    window.confirm = realConfirm;
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    out.askedKey = askedKey;

    /* 4. THE CONTROL: the same type change on a column with NO records says
          nothing at all. A save is not the place to interrupt someone about
          something that is not at stake. */
    const askedCtl = [];
    window.confirm = m => { askedCtl.push(String(m)); return true; };
    RecoTemplate.edit('TPL_K');
    const st = RecoTemplate._editing.additionalColumns.find(a => a.name === 'Status');
    st.type = 'formula'; st.formula = '"x"';
    RecoTemplate.saveTemplate();
    window.confirm = realConfirm;
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    out.askedCtl = askedCtl;
    return out;
  });
  note('X4 the carry untick', xCONF.untick);
  note('X4 the type-change confirm', xCONF.askedYes);
  note('X4 the key-change confirm', xCONF.askedKey);
  note('X4 the control (a column with no records)', xCONF.askedCtl);
  check(xCONF.untick.some(t => /3 value/.test(t) && /file/.test(t)) && xCONF.recsAfterUntick === 3,
    'X4a unticking carry says how many records are stored against row keys and that they go back to '
    + 'being honoured only in the file they were typed in - and it clears nothing (F20)',
    { untick: xCONF.untick, recs: xCONF.recsAfterUntick });
  check(xCONF.askedYes.some(m => /3 /.test(m)) && xCONF.typeAfterYes === 'formula',
    'X4b changing a column away from custom ASKS, naming how many typed records stop being shown '
    + '(F20)', { asked: xCONF.askedYes, type: xCONF.typeAfterYes });
  check(xCONF.askedNo.length > 0 && xCONF.typeAfterNo === 'custom',
    'X4c THE WAY BACK: cancelling that confirm leaves the column as it was', xCONF);
  check(xCONF.askedKey.some(m => /typed/.test(m) && /1 /.test(m)),
    'X4d the key-change confirm NAMES the typed values of added columns, with the count, among what '
    + 'stops matching - they are the one thing on that folder with no second copy (F20)',
    xCONF.askedKey);
  check(xCONF.askedCtl.length === 0,
    'X4e THE CONTROL: the same type change on a column with no stored records asks nothing',
    xCONF.askedCtl);
  await pgCONF.ctx.close();


  /* ---------------------------------------------------------------------
     [45] X5 / finding F13 — A COLLEAGUE'S STALE TEMPLATE SAVE UNSET THE TWO
     FLAGS THAT DECIDE WHETHER A DURABLE RECORD IS READ.

     saveTemplate replaces the whole stored object, and AppState.load() runs
     once at boot, so a flag a colleague set at 10:00 was wiped by a save
     going out from a 09:00 clone. The function's own comment names the hazard
     and calls it pre-existing - and it is, for every field - but
     carryForward and allowOverride are the first template fields whose loss
     changes whether a record ALREADY ON THE SHARED FOLDER is read at all:
     Reco._extraTyped falls back to file scope the moment carryForward is not
     true, and the promotion has already deleted the legacy manualTags copy
     those values used to live in.

     THE REVIEWER'S MINIMUM FIX CANNOT WORK, which is why this is not it:
     "merge the two flags from the stored template" reads
     AppState.recoTemplates, and that array is this session's own stale
     object - the code comment says so, and a check against it was written
     and removed for exactly that reason. So the SHARE is read, once per
     save, and for these two flags a value THIS EDITOR DID NOT TOUCH takes
     the folder's answer.
     T-S10-7 HAS SINCE GENERALISED THE MECHANISM to every template field
     (section [63]), so this section is now the two flags' own gate inside
     that merge rather than a special case beside it - which is why X5b reads
     the merge's one question instead of RC-12's toast. X5a, X5c and X5d are
     unchanged, and they are the behaviour that must not move: the flag A set
     survives, B's own edit is still saved, and a flag B DID untick stays
     off.
     --------------------------------------------------------------------- */
  section(45, 'X5 (F13) — a stale save does not silently unset carry-forward or the override flag');
  const STPL = makeRoot('share-stpl');
  const brSTPL = await startBridge(STPL.root, PORT_FIX_STPL); procs.push(brSTPL.proc);
  const pgA5 = await openReco(browser, brSTPL);
  await pgA5.page.evaluate(SETUP + '([2])');
  const pgB5 = await openReco(browser, brSTPL);   // boots with the template as it is NOW
  const a5 = await pgA5.page.evaluate(async () => {
    RecoTemplate.edit('TPL_K');
    const i = RecoTemplate._editing.additionalColumns.findIndex(a => a.name === 'Vendor');
    RecoTemplate.toggleCarry(i, true);
    RecoTemplate.saveTemplate();
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    return (AppState.recoTemplates.find(x => x.id === 'TPL_K').additionalColumns
      .find(a => a.name === 'Vendor') || {}).carryForward;
  });
  const onShareA = diskJson(STPL.root, 'reco/recoTemplates.json');
  check(a5 === true && (((onShareA || []).find(t => t.id === 'TPL_K') || {}).additionalColumns || [])
          .some(a => a.name === 'Vendor' && a.carryForward === true),
    'X5 premise: colleague A\'s carry flag is on the shared folder', a5);

  const b5 = await pgB5.page.evaluate(async () => {
    window.__toasts = [];
    /* T-S10-7 MOVED THE CHANNEL, NOT THE CLAIM. RC-12 announced the kept flag
       in a toast; the general merge asks ONE question naming every field it
       kept, so X5b reads the confirm. The assertion is the same one: B is
       told that somebody else had changed this template, and the column is
       named. */
    const asks = [];
    const real = window.confirm;
    window.confirm = m => { asks.push(String(m)); return true; };
    try {
      RecoTemplate.edit('TPL_K');          // from THIS page's 09:00 clone
      RecoTemplate._editing.description = 'B was here';
      RecoTemplate.saveTemplate();
      if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch (e) {} }
    } finally { window.confirm = real; }
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    const vd = (AppState.recoTemplates.find(x => x.id === 'TPL_K').additionalColumns || [])
      .find(a => a.name === 'Vendor') || {};
    return { carry: vd.carryForward, desc: AppState.recoTemplates.find(x => x.id === 'TPL_K').description,
             asks: asks, toasts: (window.__toasts || []).map(t => t.kind + ': ' + t.msg) };
  });
  const onShareB = diskJson(STPL.root, 'reco/recoTemplates.json');
  const vdB = (((onShareB || []).find(t => t.id === 'TPL_K') || {}).additionalColumns || [])
    .find(a => a.name === 'Vendor') || {};
  note('X5 colleague B\'s save', b5);
  note('X5 the column on the share afterwards', vdB);
  check(vdB.carryForward === true,
    'X5a (THE MONEY) B\'s unrelated save does NOT silently unset the flag A set: the records on the '
    + 'folder go on being read by key, and next month\'s file is not blank (F13)', vdB);
  check(b5.asks.some(t => /someone else/i.test(t) && /Vendor/.test(t)),
    'X5b and B is told that somebody else had changed this template, naming the column - a green '
    + '"Template saved to database" was the only thing said before. T-S10-7 moved this from a '
    + 'toast into the merge\'s one question; the claim is unchanged', { asks: b5.asks, toasts: b5.toasts });
  check(b5.desc === 'B was here',
    'X5c THE CONTROL: what B actually edited is still saved - this keeps the share\'s answer for the '
    + 'two flags, it does not refuse B\'s work', b5.desc);
  const b5b = await pgB5.page.evaluate(async () => {
    /* AND THE OTHER DIRECTION, which the finding names too: B deliberately
       unticks it, with the share saying ON. A field the editor DID touch is
       the operator's decision and must go through. */
    window.__toasts = [];
    RecoTemplate.edit('TPL_K');
    const i = RecoTemplate._editing.additionalColumns.findIndex(a => a.name === 'Vendor');
    RecoTemplate.toggleCarry(i, false);
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch (e) {} }
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    return (AppState.recoTemplates.find(x => x.id === 'TPL_K').additionalColumns
      .find(a => a.name === 'Vendor') || {}).carryForward;
  });
  const onShareC = diskJson(STPL.root, 'reco/recoTemplates.json');
  const vdC = (((onShareC || []).find(t => t.id === 'TPL_K') || {}).additionalColumns || [])
    .find(a => a.name === 'Vendor') || {};
  check(b5b !== true && vdC.carryForward !== true,
    'X5d THE OTHER CONTROL: a flag the operator DID untick here is still turned off - the share wins '
    + 'only for a setting this editor never touched', { memory: b5b, share: vdC });
  await pgA5.ctx.close(); await pgB5.ctx.close();


  /* ---------------------------------------------------------------------
     [46] X6 / finding F18 — THE SPREADSHEET FILL DRAG OVER AN ADDED COLUMN
     DID NOTHING AND SAID "Filled 3 cells".

     T-30-1 filed this as "the drag writes an added column's value straight
     onto the row". It writes an EMPTY STRING onto the row: the source value
     is read as `srcRow[fd.srcCol]`, and applyEdits' tag branch ends with
     `delete s.row[s.col]` (ONE TRUTH PER CELL, pre-existing), so an added
     column has no row property to copy. The operator dragged a vendor name
     down fifty rows, read "Filled 50 cells", and nothing was filled - and the
     shared day CSV, which is the team's audit trail, gained one C-version row
     per key recording a change that never happened.

     A control that reports success having done nothing is worse than one that
     refuses, so: the source value is read through the LADDER (what the
     operator can see), a store-served column's cells go through
     Reco.applyEdits - which is what puts them in the store, obeys every
     refusal typing obeys, and writes no version row for a tag - and a
     COMPUTED column is refused by name instead of being claimed.
     --------------------------------------------------------------------- */
  section(46, 'X6 (F18) — the fill drag over an added column fills it, or says it did not');
  const DRG = makeRoot('share-drag');
  const brDRG = await startBridge(DRG.root, PORT_FIX_DRAG); procs.push(brDRG.proc);
  const pgDRG = await openReco(browser, brDRG);
  await pgDRG.page.evaluate(SETUP + '([4])');
  await pgDRG.page.evaluate(TYPE + `(['TPL_K','Vendor',[[0,'ACME'],[1,'OLD-B'],[2,'OLD-C'],[3,'OLD-D']]])`);
  const drgVer = verFile(DRG.root, 'Keyed');
  const drgRowsBefore = csvRows(drgVer).length;
  const xDRG = await pgDRG.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions.TPL_K;
    AppState.activeRecoId = 'TPL_K';
    sess.spreadsheetMode = true;
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 250));
    window.__toasts = [];
    Reco._ssCommitFill({ srcCol: 'Vendor', curCol: 'Vendor', srcFidx: 0, curFidx: 3 });
    await new Promise(r => setTimeout(r, 600));
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    await Versioning.idle(); await new Promise(r => setTimeout(r, 250));
    Reco._fullPass();
    let cells; try { cells = sess.data.map(r => r.Invoice + '=' + String(Reco.rowFull(tpl, sess, r).Vendor)); }
    finally { Reco._fullEnd(); }
    return { cells, toasts: (window.__toasts || []).map(t => t.kind + ': ' + t.msg),
             rowProps: sess.data.map(r => r.Invoice + '='
               + (Object.prototype.hasOwnProperty.call(r, 'Vendor') ? JSON.stringify(r.Vendor) : '(absent)')) };
  });
  const drgStore = diskJson(DRG.root, 'reco/extraValueMaster.json');
  const drgRowsAfter = csvRows(drgVer).length;
  note('X6 what the screen reads after the drag', xDRG.cells);
  note('X6 what the operator was told', xDRG.toasts);
  note('X6 the share', (drgStore || {}).TPL_K);
  note('X6 version rows appended by the drag', drgRowsAfter - drgRowsBefore);
  check(xDRG.cells.join() === 'INV-1=ACME,INV-2=ACME,INV-3=ACME,INV-4=ACME',
    'X6a (THE MONEY) the drag really fills the three cells it claimed - it used to leave OLD-B, '
    + 'OLD-C and OLD-D exactly where they were and say "Filled 3 cells" (F18)', xDRG.cells);
  check(['INV-1', 'INV-2', 'INV-3', 'INV-4'].map(
      k => ((((drgStore || {}).TPL_K || {})[k] || {}).Vendor || {}).v).join() === 'ACME,ACME,ACME,ACME',
    'X6b and they are on the SHARED FOLDER, so they are still there tomorrow: the drag goes through '
    + 'the same write path as typing, not onto the row', (drgStore || {}).TPL_K);
  check(xDRG.toasts.some(t => /Filled 3 cell/.test(t))
        && xDRG.rowProps.every(p => /=\(absent\)$/.test(p)),
    'X6c the count it reports is the number it actually wrote, and nothing is left ON THE ROW: the '
    + 'store is the one truth for this cell, and the empty string the drag used to write there is '
    + 'what made the whole thing invisible', { toasts: xDRG.toasts, rowProps: xDRG.rowProps });
  check(drgRowsAfter === drgRowsBefore,
    'X6d and NO version row is appended to the shared day CSV for a value that is not in the CSV - '
    + 'the audit trail used to gain one C-row per key recording nothing (F18)',
    { before: drgRowsBefore, after: drgRowsAfter });

  /* A COMPUTED added column: there is nothing to copy, and that has to be
     said rather than counted as a success. */
  const xDRG2 = await pgDRG.page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_K');
    const sess = AppState.recoSessions.TPL_K;
    tpl.additionalColumns.push({ name: 'Net', type: 'formula', formula: 'NUM({Amount})*2' });
    tpl.displayColumns = (tpl.displayColumns || []).concat(['Net']);
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 250));
    window.__toasts = [];
    Reco._ssCommitFill({ srcCol: 'Net', curCol: 'Net', srcFidx: 0, curFidx: 3 });
    await new Promise(r => setTimeout(r, 600));
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    Reco._fullPass();
    let cells; try { cells = sess.data.map(r => r.Invoice + '=' + String(Reco.rowFull(tpl, sess, r).Net)); }
    finally { Reco._fullEnd(); }
    return { cells, toasts: (window.__toasts || []).map(t => t.kind + ': ' + t.msg),
             recs: Object.keys(AppState.extraValueMaster.TPL_K || {}).filter(
               k => ((AppState.extraValueMaster.TPL_K || {})[k] || {}).Net).length };
  });
  note('X6 dragging a COMPUTED column', xDRG2);
  check(xDRG2.cells.join() === 'INV-1=200,INV-2=400,INV-3=600,INV-4=800' && xDRG2.recs === 0,
    'X6e every row still reads its own formula after a drag over a computed column, and no override '
    + 'was invented in bulk', xDRG2);
  check(!xDRG2.toasts.some(t => /Filled/.test(t)) && xDRG2.toasts.some(t => /Net/.test(t)),
    'X6f ...and the operator is told that column was not filled, naming it, instead of reading '
    + '"Filled 3 cells" about cells nothing was written to', xDRG2.toasts);
  await pgDRG.ctx.close();


  /* ---------------------------------------------------------------------
     [47] X7 / finding F6 — ONE ORPHAN RECORD EXPORTED 2,000 GOOD NUMBERS AS
     TEXT.

     Decision J.8 walks the sparse store so that the exported KIND of a
     formula column does not depend on WHERE in the file an override is: the
     row scan stops at 2,000 rows, so an override on row 50,000 would
     otherwise leave the column kind:'value' and write that one cell as forced
     TEXT inside a numeric column. The walk asked EVERY key the template holds
     a record for, with no test against the data being exported - and the
     orphans are kept on purpose (an override of INV-7 applies in November if
     INV-7 comes back). So one stale record from a key nobody has loaded since
     April turned a whole column into text, the colleague's SUM at the bottom
     read 0, and nothing was wrong on screen or in the CSV.

     Scoped to the rows being exported, which is what the kind is ABOUT, and
     NOT by narrowing Reco._overrideValuesFor itself: the role matrix and the
     untick count call it too and must keep counting the orphans, because a
     record on a key that is not loaded is exactly the hazard they guard
     (X7d is the assertion that pins that). The row set is built lazily, so a
     template with no records still walks nothing.
     --------------------------------------------------------------------- */
  section(47, 'X7 (F6) — an orphan override does not export a whole numeric column as text');
  const KND = makeRoot('share-kind');
  const brKND = await startBridge(KND.root, PORT_FIX_KIND); procs.push(brKND.proc);
  const pgKND = await openReco(browser, brKND);
  const xKND = await pgKND.page.evaluate(`(async function () {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = 'TPL_KND'; t.name = 'Kind scan';
    t.columns = ['Invoice', 'Base'].map(n => ({ name: n, label: n, formats: [], isValue: n === 'Base' }));
    t.primaryKeys = ['Invoice'];
    t.valueColumn = 'Base';
    t.displayColumns = ['Invoice', 'Base'];
    t.additionalColumns = [{ name: 'Net', type: 'formula', formula: 'NUM({Base})*2', allowOverride: true }];
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_KND');
    RecoTemplate.open(tpl.id);
    const sess = AppState.recoSessions.TPL_KND;
    Reco.ensureSessionShape(sess);
    /* 2,100 rows, assigned directly as section 18's fixture is: the question
       is about the SCHEMA, and 2,100 is what it takes to have a loaded row
       the 2,000-row scan never reaches. */
    const n = 2100;
    const data = new Array(n);
    for (let i = 0; i < n; i++) data[i] = { _id: 'k' + i, _pk: 'INV-' + (i + 1), _ver: 'upload',
                                            Invoice: 'INV-' + (i + 1), Base: String(i + 1) };
    sess.data = data;
    AppState.activeRecoId = 'TPL_KND';
    App.closeModal();
    const kindOf = () => (XlSchema.build(tpl, sess, {}).byName.get('Net') || {}).kind;
    const out = { rows: n };
    delete AppState.extraValueMaster.TPL_KND;
    out.kindClean = kindOf();
    /* ONE STALE RECORD, on a key that is NOT in the loaded data - which is
       what six months of ordinary overrides leave behind. */
    AppState.extraValueMaster.TPL_KND = { 'INV-LONG-GONE': { Net: { k: 'override', v: 'see email',
      prev: '400', src: 'formula', ds: '', by: 'someone', at: '2026-04-01T00:00:00.000Z' } } };
    out.kindOrphan = kindOf();
    out.countOrphan = Reco._overrideCount(tpl, 'Net');
    out.keyIsLoaded = sess.data.some(r => r._pk === 'INV-LONG-GONE');
    const xo = { rows: 'all', columns: 'asShown', includeComputed: true, protect: 'soft',
                 dateFormat: 'dd-mmm-yyyy' };
    const built = await ExcelLink.buildExport(tpl, sess, xo, 'S');
    const ci = built.head.columns.findIndex(c => c.key === 'Net');
    const cell = (built.cells[0] || [])[ci];
    out.exportedKind = (built.head.columns[ci] || {}).kind;
    out.firstCell = (cell && typeof cell === 'object') ? cell.v : cell;
    out.firstCellType = (cell && typeof cell === 'object') ? typeof cell.v : typeof cell;
    /* THE CONTROL FOR J.8: the same non-numeric override on a LOADED key that
       the 2,000-row scan never reaches. The column MUST still go out as text. */
    AppState.extraValueMaster.TPL_KND['INV-2050'] = { Net: { k: 'override', v: 'see email',
      prev: '4100', src: 'formula', ds: '', by: 'someone', at: '2026-04-01T00:00:00.000Z' } };
    out.kindLoadedPastScan = kindOf();
    out.countBoth = Reco._overrideCount(tpl, 'Net');
    return out;
  })()`);
  note('X7 the kind scan', xKND);
  check(xKND.kindClean === 'value' && xKND.keyIsLoaded === false,
    'X7 premise: with no records the column exports as numbers, and the planted key is NOT in the '
    + 'loaded data', xKND);
  check(xKND.kindOrphan === 'value',
    'X7a (THE MONEY) one orphan record on a key nobody has loaded since April no longer turns the '
    + 'whole column into text (F6)', xKND.kindOrphan);
  check(xKND.exportedKind === 'value' && xKND.firstCellType === 'number' && xKND.firstCell === 2,
    'X7b and the workbook a colleague opens carries the loaded cell as the NUMBER 2, not the string '
    + '"2" - which is why their SUM at the bottom of the column read 0',
    { kind: xKND.exportedKind, cell: xKND.firstCell, type: xKND.firstCellType });
  check(xKND.kindLoadedPastScan === 'text',
    'X7c THE CONTROL, AND IT IS DECISION J.8 ITSELF: a non-numeric override on a LOADED key that the '
    + '2,000-row scan never reaches STILL takes the column to text - the store walk is scoped to the '
    + 'rows being exported, not removed', xKND.kindLoadedPastScan);
  check(xKND.countOrphan === 1 && xKND.countBoth === 2,
    'X7d and the honest count still counts the orphans: the role matrix and the override untick read '
    + 'it to decide whether a column still holds records, and a record on a key that is not loaded is '
    + 'exactly the hazard they guard', { orphan: xKND.countOrphan, both: xKND.countBoth });
  await pgKND.ctx.close();


  /* ---------------------------------------------------------------------
     [48] X8 / finding F15 — THE CEILING IS A STATED LIMIT, NOT SOMETHING A
     TEAM DISCOVERS.

     MEASURED ON THIS BUILD, through the test bridge on local disk, best of 3
     taking the minimum (scratchpad/store/fix2/out/p7_size.post.txt):
       2,000 records    288 KB  (144 B/record)  boot 672 ms   read  12 ms   one merge write   67 ms
       50,000 records   7.3 MB  (147 B/record)  boot 987 ms   read 213 ms   one merge write  600 ms
       200,000 records  29.6 MB (148 B/record)  boot 1,825 ms read 741 ms   one merge write 2,730 ms
     Store._mergeJob reads AND writes the whole file for every 150 ms typing
     burst, so on a shared folder at 10 MB/s a 200,000-record file is about
     6 s of transfer on top of ~3 s of work, per burst, and Store._enqueue
     serialises per file, so bursts queue behind each other and two
     colleagues each move 30 MB. The usable ceiling is about 50,000 records
     per FILE.

     WHAT IS NOT BUILT HERE, deliberately: the Values-panel button that MOVES
     a template's records into their own file (T-S10-3). Moving records
     between two shared files while colleagues may be typing into either is a
     data-moving operation on the one thing on that folder with no second
     copy, and it needs its own review - the reviewer's other suggestion,
     sharding automatically past a threshold, decides where everybody's data
     lives on its own and is worse. What IS built is the sentence, because
     there is already a remedy that needs no new UI: decision G's split file
     is READ at boot and written to from then on (S11a/S11d), so a person
     with folder access can move one template's records into
     reco/extraValues/<tplId>.json by hand today.
     --------------------------------------------------------------------- */
  section(48, 'X8 (F15) — a values file past the measured ceiling says so at boot, with the way out');
  const BIGF = makeRoot('share-bigf');
  const brBIGF = await startBridge(BIGF.root, PORT_FIX_BIGF); procs.push(brBIGF.proc);
  const pgBIGF0 = await openReco(browser, brBIGF);
  await pgBIGF0.page.evaluate(SETUP + '([3])');
  const smallBoot = await pgBIGF0.page.evaluate(() => Store.loadProblems.slice());
  await pgBIGF0.ctx.close();
  /* 60,000 records on one share, which is what a year of two columns on a
     20,000-row monthly file looks like. */
  const bigVals = { TPL_K: {} };
  for (let i = 0; i < 30000; i++) bigVals.TPL_K['INV-' + i] = {
    Vendor: { k: 'typed', v: 'V' + i, ds: 'd', by: 'someone', at: '2026-01-01T00:00:00.000Z' },
    Status: { k: 'typed', v: 'Open', ds: 'd', by: 'someone', at: '2026-01-01T00:00:00.000Z' } };
  fs.writeFileSync(path.join(BIGF.root, 'reco/extraValueMaster.json'), JSON.stringify(bigVals));
  const bigBytes = fs.statSync(path.join(BIGF.root, 'reco/extraValueMaster.json')).size;
  const pgBIGF = await openReco(browser, brBIGF);
  const xBIGF = await pgBIGF.page.evaluate(() => ({
    problems: Store.loadProblems.slice(),
    loaded: Object.keys((AppState.extraValueMaster || {}).TPL_K || {}).length
  }));
  note('X8 the file', { bytes: bigBytes, records: 60000 });
  note('X8 what the boot said', xBIGF.problems);
  note('X8 a small store\'s boot', smallBoot);
  check(xBIGF.loaded === 30000,
    'X8 premise: all 60,000 records on 30,000 keys are loaded at boot, as they always were - this '
    + 'is about the cost, not about losing them', xBIGF.loaded);
  check(xBIGF.problems.some(p => /60000 typed values/.test(String(p))),
    'X8a the boot names the file and the number of values in it, measured not guessed (F15)',
    xBIGF.problems);
  check(xBIGF.problems.some(p => /reco\/extraValues\/TPL_K\.json/.test(String(p))),
    'X8b and it names the way out that works TODAY with no new UI: the split file decision G reads '
    + 'at boot and writes to from then on, and the biggest template in the file', xBIGF.problems);
  check(!smallBoot.some(p => /typed values/.test(String(p))),
    'X8c THE CONTROL: an ordinary share says nothing - the sentence is a limit being reached, not a '
    + 'notice everyone reads every morning', smallBoot);
  await pgBIGF.ctx.close();


  /* =====================================================================
     [49] Z1 — A BROKEN FORMULA POSTED A SILENT ZERO INTO A JOURNAL ENTRY.
     THE MONEY ROUND. This is the oldest deferred defect in the project and
     it had never been reproduced, so it is written down here first:

       an added `formula` column AED = NUM({Base})/NUM({Rate}) — an FC-to-AED
       conversion, and 'AED' is already what the default AEG template's
       valueColumn is called — on a file where ONE row's Rate cell is 0.
       A blank or zero rate on one line of an FX extract is ordinary weather.

     MEASURED on the build before the fix (scratchpad/money/out/
     z1_repro_before.txt), the SAME cell on six surfaces:

       the grid "#ERR" · the read ladder "#ERR" · the report cell "#ERR" ·
       the CSV "#ERR" · the workbook "#ERR" · THE AEG SOURCE ROW "#ERR"
       → POSTED ENTRY AEMVAUQHDL, lines Dr 150.00 / Cr 150.00

     INV-1 is worth 50 and INV-2 is worth 100, so the third invoice — the
     LARGEST of the three by Base — contributed NOTHING to a posted journal
     entry, was stamped POSTED like the other two, and the only thing the
     operator saw was "Entry AEMVAUQHDL generated (2 lines)".

     AND THE TICKET'S OWN MECHANISM IS NOT THE ONE THAT BITES. The loop's
     `catch(e) { r[ac.name] = ''; }` is UNREACHABLE: Formula.evaluate catches
     internally and RETURNS '#ERR' on both of its paths, so the AEG loop was
     already reading the same '#ERR' as the grid. The divergence the comment
     and the ticket both name was never what posted the zero — U.num('#ERR')
     === 0 inside Reco._buildEntryLines was. That is why shape (a) alone
     (make the loop say '#ERR') fixes NOTHING, and why the fix is a REFUSAL
     at the one door into entry history, next to RC-8's.
     ===================================================================== */
  section(49, 'Z1 — a formula that cannot be worked out REFUSES the posting (it used to post a zero)');
  const Z = makeRoot('share-z1');
  const brZ = await startBridge(Z.root, PORT_Z1); procs.push(brZ.proc);
  const pz = await openReco(browser, brZ);
  await pz.page.evaluate(Z1_SETUP + '([true])');

  const z1 = await pz.page.evaluate(Z1_SURFACES + '()');
  note('Z1 the same cell on five surfaces', { grid: z1.grid, ladder: z1.ladder, report: z1.reportCell,
    csv: z1.csv, workbook: z1.workbook });
  note('Z1 the AEG source rows', z1.aegSourceRows);
  note('Z1 what it WOULD have posted', z1.wouldPost);
  note('Z1 toasts', z1.toasts);
  check(z1.grid === '#ERR' && z1.ladder === '#ERR' && z1.reportCell === '#ERR'
        && z1.csv === '#ERR' && z1.workbook === '#ERR',
    'Z1a PREMISE: every reader the operator can see says #ERR for INV-3 / AED', z1);
  check(z1.aegSourceRows.join(' ') === 'INV-1=50 INV-2=100 INV-3=#ERR',
    'Z1b and the AEG source row now says #ERR TOO — shape (a): the loop\'s own answer no longer '
    + 'differs from the grid\'s, so the refusal below has ONE sentinel to key on', z1.aegSourceRows);
  check(z1.wouldPost === 150,
    'Z1c THE FIGURE THE OLD BUILD POSTED, measured in this run and not quoted: _buildEntryLines over '
    + 'those three source rows totals 150 because U.num(\'#ERR\') is 0, where INV-3 is the largest '
    + 'of the three by Base', z1.wouldPost);
  check(z1.refused === true && z1.pending === null,
    'Z1d THE GATE: the posting is REFUSED — Reco._pendingEntry is never set, so commitEntryFromPreview '
    + 'has nothing to commit', { refused: z1.refused, pending: z1.pending });
  check(z1.histLen === 0,
    'Z1e AND NOTHING REACHED THE LEDGER (the value, not the toast): entryHistory is still empty',
    z1.histLen);
  check(/INV-3/.test(z1.refusal) && /AED/.test(z1.refusal)
        && /NUM\(\{Base\}\)\/NUM\(\{Rate\}\)/.test(z1.refusal),
    'Z1f the refusal names the KEY, the COLUMN and the FORMULA that failed, the way RC-8\'s does',
    z1.refusal);

  /* NOT A BLANKET BLOCK. Correct the rate and the same selection posts, with
     the figure the three rows are actually worth. Without this the gate could
     be "refuse everything" and still look green. */
  const z1ok = await pz.page.evaluate(Z1_FIXRATE + '()');
  note('Z1 after the rate is corrected', z1ok);
  check(z1ok.postedDr === 250 && z1ok.histLen === 1,
    'Z1g THE CONTROL: with Rate corrected to 5 on INV-3 the same selection posts 250 — 50 + 100 + 100, '
    + 'all three rows in the figure. The refusal is about a cell that cannot be worked out, not about '
    + 'the template', z1ok);

  /* SCOPE. A broken formula in a column the linked AEG template does not read
     cannot change a posted number, and refusing on it would change what an
     existing template can post — which is the objection T-26-4 was deferred
     for. 'Memo' is not an input column, not the value column, not an
     aggregateBy, not an account column and not the keyword column. */
  const z1scope = await pz.page.evaluate(Z1_SCOPE + '()');
  note('Z1 scope', z1scope);
  check(z1scope.memo === '#ERR' && z1scope.postedDr === 250 && z1scope.histLen === 2,
    'Z1h SCOPE: a column reading #ERR that the AEG template never reads does NOT refuse the posting, '
    + 'and the figure is unchanged', z1scope);
  check(z1scope.warned === true && z1scope.reposted === true,
    'Z1h2 AND T-26-4 LEFT IT ALONE: these three rows were posted by Z1g a moment ago, so the new '
    + 'warning fires - and they are still IN the entry, because dropping them by default would '
    + 'make this posting quietly smaller than the selection, which is the harm and not the remedy',
    { warned: z1scope.warned, included: z1scope.reposted });

  /* THE KEYWORD COLUMN, and it is the one arm that has to be tested BEFORE
     the filter. A broken formula there makes the filter DROP the row, so a
     check over the surviving rows would see nothing wrong and the row would
     silently not post. RC-8's "after the keyword filter, deliberately" is
     right for an override and wrong for the cell that decided the filter. */
  const ZK = makeRoot('share-z1kw');
  const brZK = await startBridge(ZK.root, PORT_Z1KW); procs.push(brZK.proc);
  const pzk = await openReco(browser, brZK);
  await pzk.page.evaluate(Z1_SETUP + '([true])');
  const z1kw = await pzk.page.evaluate(Z1_KEYWORD + '()');
  note('Z1 keyword arm', z1kw);
  check(z1kw.droppedByFilter === 1,
    'Z1i PREMISE: the keyword filter drops the row whose keyword formula says #ERR — it is not in the '
    + 'entry, and nothing said so', z1kw);
  check(z1kw.refused === true && z1kw.histLen === 0 && /INV-3/.test(z1kw.refusal),
    'Z1j THE GATE for the keyword column is PRE-FILTER: the failure is what decided the row\'s fate, '
    + 'so the posting is refused and the key is named', z1kw);
  await pzk.ctx.close();

  /* =====================================================================
     [50] T-26-5 — A NON-NUMERIC OVERRIDE READ AS A NUMBER IN A TOTAL.
     RC-8 refuses it at the journal door, so it can no longer reach the
     ledger. It could still reach a SCREEN total: reviewer A's probe
     (scratchpad/store/fix/p3.out) read REPORT TOTAL 101.2345 for three rows
     worth 100 with Net overridden to '1.234,50'. The shipped total row is
     guarded by U.isNumeric, so the real total was 100 — and SAID NOTHING
     about the cell it had dropped, which is the same defect from the other
     side: the column does not add up to what the column shows.
     ===================================================================== */
  section(50, 'T-26-5 — a cell that is not a number is out of the total AND the total says so');
  const T5 = makeRoot('share-t265');
  const brT5 = await startBridge(T5.root, PORT_T265); procs.push(brT5.proc);
  const pt5 = await openReco(browser, brT5);
  await pt5.page.evaluate(T265_SETUP + '()');

  const t5bad = await pt5.page.evaluate(T265_TOTAL + `(['1.234,50'])`);
  note('T-26-5 with "1.234,50" typed over Net', t5bad);
  check(t5bad.cells.join(' ') === '40 60 1.234,50',
    'T265a PREMISE: the report CELL shows the characters that were typed', t5bad.cells);
  check(t5bad.naive === 101.2345,
    'T265b and the naive reading of that column — U.num on every cell, which is what reviewer A\'s '
    + 'probe did and what every other U.num reader of the column still does — is 101.2345',
    t5bad.naive);
  check(/^100\.00/.test(String(t5bad.totalText)) && t5bad.totalSum === 100,
    'T265c THE TOTAL IS NOT 101.2345: the cell U.isNumeric rejects is out of it', t5bad);
  check(t5bad.excluded === 1,
    'T265d THE GATE, AS A VALUE: the total carries the COUNT of cells that are not in it', t5bad.excluded);
  check(/1 cell/.test(t5bad.note) && /Net/.test(t5bad.note) && /1\.234,50/.test(t5bad.note),
    'T265e and the footnote names the count, the column and the characters, so the operator can see '
    + 'why the column does not add up', t5bad.note);

  const t5ok = await pt5.page.evaluate(T265_TOTAL + `(['1,234.50'])`);
  note('T-26-5 CONTROL with "1,234.50"', t5ok);
  check(t5ok.totalSum === 1334.5 && t5ok.excluded === 0 && t5ok.note === '',
    'T265f THE CONTROL: an override _setOverride canonicalises (1,234.50 -> 1234.5) is FULLY in the '
    + 'total and there is no footnote — the note is a cell that cannot be added, not a cell somebody '
    + 'typed', t5ok);

  const t5blank = await pt5.page.evaluate(T265_TOTAL + `([''])`);
  note('T-26-5 CONTROL with a deliberate blank', t5blank);
  check(t5blank.totalSum === 100 && t5blank.excluded === 0 && t5blank.note === '',
    'T265g THE SECOND CONTROL: an EMPTY override is a deliberate blank, not "not a number" — it has '
    + 'always been out of every total and nobody reads a blank as an amount, so footnoting it would '
    + 'put a warning on every sparse column in the app', t5blank);
  await pt5.ctx.close();

  /* =====================================================================
     [51] T-26-6 — A POSTED ROW WHOSE KEY LATER BECOMES DUPLICATED.
     RC-6 suppresses an override whose key stops naming one row, and that is
     the right call: the alternative multiplies a number into a NEW entry.
     But if the key had already been POSTED with that override, the ledger
     holds the typed value and the screen now shows the computed one — the
     one case where "the screen and the journal cannot disagree" does not
     hold. What was missing is that nothing said so.
     ===================================================================== */
  section(51, 'T-26-6 — the duplicate-key panel names the keys that are POSTED, and the reference');
  const T6 = makeRoot('share-t266');
  const brT6 = await startBridge(T6.root, PORT_T266); procs.push(brT6.proc);
  const pt6 = await openReco(browser, brT6);
  await pt6.page.evaluate(T266_SETUP + '()');
  const t6 = await pt6.page.evaluate(T266_RUN + '()');
  note('T-26-6', { posted: t6.postedDr, entry: t6.accountingId, screenAfter: t6.screenAfter,
    recStill: t6.recStill, dup: t6.dupCount });
  note('T-26-6 the panel', String(t6.panel || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 700));
  check(t6.postedDr === 1000,
    'T266a PREMISE: the entry posted the OVERRIDE — 1000, not the 20 the formula says', t6.postedDr);
  check(t6.screenAfter === '20' && t6.recStill === '1000',
    'T266b and once a duplicate of that key arrives, the screen falls back to the computed 20 while '
    + 'the LEDGER still holds 1000 and the record is still on the share', t6);
  check(/INV-7/.test(t6.postedBlock) && t6.postedBlock.indexOf(t6.accountingId) !== -1,
    'T266c THE GATE: the panel names that key as POSTED and names the ACCOUNTING REFERENCE the ledger '
    + 'holds it under, so the answer is "reverse AEG-… first" rather than "why has my number changed"',
    { block: t6.postedBlock, ref: t6.accountingId });
  check(/general ledger/.test(t6.postedBlock) && /1000/.test(t6.postedBlock),
    'T266d and it says which way round it is — the ledger holds the override, the screen shows the '
    + 'computed value — with the amount the ledger holds', t6.postedBlock);
  check(t6.unpostedNamed === true && t6.unpostedRefd === false,
    'T266e THE CONTROL: a suppressed override on a key that was NEVER posted is still named as '
    + 'suppressed and is NOT given an accounting reference it does not have', t6);
  await pt6.ctx.close();

  /* =====================================================================
     [52] T-S10-1 — entryHistory AND docNumberMaster NOW MERGE-WRITE.
     S13's own comment names three callers: the values store, entryHistory at
     its pre-write re-read site, and docNumberMaster. Phase 1 converted only
     the store, because the other two are in PERSIST_KEYS and membership IS
     the blind overwrite. Two colleagues generating entries minutes apart
     lost one of them: the later writer's whole-file entryHistory write drops
     the entry the earlier one added, while the earlier one's rows keep their
     Posted stamp — a closed row with no accounting record behind it.
     ===================================================================== */
  section(52, 'T-S10-1 — two colleagues generating entries at once BOTH keep their entry');
  const SA = makeRoot('share-s101');
  const brSA = await startBridge(SA.root, PORT_S101); procs.push(brSA.proc);
  const pa = await openReco(browser, brSA);
  await pa.page.evaluate(S101_SETUP + '()');

  const s101keys = await pa.page.evaluate(() => ({
    persist: AppState.PERSIST_KEYS.slice(),
    eh: typeof AppState.entryHistory, dn: typeof AppState.docNumberMaster
  }));
  check(s101keys.persist.indexOf('entryHistory') === -1 && s101keys.persist.indexOf('docNumberMaster') === -1,
    'S101a neither key is in PERSIST_KEYS any more — membership IS the blind overwrite',
    s101keys.persist);
  check(s101keys.eh === 'object' && s101keys.dn === 'object',
    'S101b but both are still assigned in AppState.load and are still objects', s101keys);

  await resetLog(brSA);
  await pa.page.evaluate(async () => {
    const sess = AppState.recoSessions.TPL_E;
    sess.page = (sess.page || 0) + 1;            // an unrelated change
    await AppState.flush(); await Store.idle();
  });
  const logS101 = await callLog(brSA);
  check(writesOf(logS101, 'reco/entryHistory.json') === 0
        && writesOf(logS101, 'reco/docNumberMaster.json') === 0,
    'S101c an AppState.flush() with only an unrelated change writes NEITHER ledger file',
    logS101.filter(c => c.method === 'write_file').map(c => c.arg0));

  /* Page B boots AFTER A's template and rows are on the share and BEFORE A
     posts anything, so its in-memory entryHistory pre-dates A's entry —
     which is the whole condition. */
  const pb = await openReco(browser, brSA);
  const s101bSees = await pb.page.evaluate(() => ({
    rows: (AppState.recoSessions.TPL_E || { data: [] }).data.length,
    hist: JSON.stringify(AppState.entryHistory || {}), dn: JSON.stringify(AppState.docNumberMaster || {})
  }));
  note('page B booted with', s101bSees);

  const s101ea = await pa.page.evaluate(S101_POST + `([['INV-1','INV-2']])`);
  const s101bStill = await pb.page.evaluate(() => JSON.stringify(AppState.entryHistory || {}));
  const s101eb = await pb.page.evaluate(S101_POST + `([['INV-3','INV-4']])`);
  note('A posted', s101ea); note('B posted', s101eb);
  note('B could not have known about A\'s entry', { itsMemoryBefore: s101bStill });

  const s101fileEH = diskJson(SA.root, 'reco/entryHistory.json');
  const s101fileDN = diskJson(SA.root, 'reco/docNumberMaster.json');
  const s101ids = ((s101fileEH || {}).TPL_E || []).map(e => e && e.accountingId);
  note('reco/entryHistory.json holds', s101ids);
  note('reco/docNumberMaster.json holds', (s101fileDN || {}).TPL_E);
  check(s101ids.indexOf(s101ea.accountingId) !== -1,
    'S101d A\'s entry is in reco/entryHistory.json', { want: s101ea.accountingId, got: s101ids });
  check(s101ids.indexOf(s101eb.accountingId) !== -1 && s101ids.length === 2,
    'S101e THE GATE: B\'s entry is there TOO, and there are exactly two — B\'s write re-read the share '
    + 'and merged instead of replacing the file with its own stale copy',
    { want: s101eb.accountingId, got: s101ids });
  const s101dnm = (s101fileDN || {}).TPL_E || {};
  check(s101dnm['D1'] === s101ea.accountingId && s101dnm['D2'] === s101ea.accountingId
        && s101dnm['D3'] === s101eb.accountingId && s101dnm['D4'] === s101eb.accountingId,
    'S101f and all four document numbers are in reco/docNumberMaster.json, each pointing at the entry '
    + 'that actually posted it — which is what the duplicate-document check reads', s101dnm);

  /* A document number allocated by hand goes through the same door: it
     mutates an entry INSIDE entryHistory, so the intent has to re-find the
     entry on the freshly read file rather than mutating a detached copy. */
  const s101alloc = await pa.page.evaluate(S101_ALLOC + `([${JSON.stringify('')}])`);
  note('A allocated', s101alloc);
  const s101fileEH2 = diskJson(SA.root, 'reco/entryHistory.json');
  const s101aEntry = ((s101fileEH2 || {}).TPL_E || []).find(e => e && e.accountingId === s101alloc.accountingId);
  const s101bEntry = ((s101fileEH2 || {}).TPL_E || []).find(e => e && e.accountingId === s101eb.accountingId);
  check(!!(s101aEntry && s101aEntry.docNumbers && s101aEntry.docNumbers.AED === 'GL-9001'),
    'S101g a document number allocated by hand reaches the share ON the entry it belongs to', s101aEntry && s101aEntry.docNumbers);
  check(!!s101bEntry && ((s101fileEH2 || {}).TPL_E || []).length === 2,
    'S101h and B\'s entry is still there afterwards — the allocate write is a merge, not a replacement',
    ((s101fileEH2 || {}).TPL_E || []).map(e => e && e.accountingId));
  check(((diskJson(SA.root, 'reco/docNumberMaster.json') || {}).TPL_E || {})['GL-9001'] === s101alloc.accountingId,
    'S101i and the number is in the document-number master, which is the other file this ticket is about',
    (diskJson(SA.root, 'reco/docNumberMaster.json') || {}).TPL_E);

  /* And an entry written onto the share by a THIRD party between two of our
     writes — a colleague's client this test does not run. */
  const s101outEH = JSON.parse(fs.readFileSync(path.join(SA.root, 'reco/entryHistory.json'), 'utf8'));
  s101outEH.TPL_E.push({ accountingId: 'AE-COLLEAGUE', lines: [], createdBy: 'colleague', docNumbers: {} });
  fs.writeFileSync(path.join(SA.root, 'reco/entryHistory.json'), JSON.stringify(s101outEH));
  const s101outDN = JSON.parse(fs.readFileSync(path.join(SA.root, 'reco/docNumberMaster.json'), 'utf8'));
  s101outDN.TPL_E['D9'] = 'AE-COLLEAGUE';
  fs.writeFileSync(path.join(SA.root, 'reco/docNumberMaster.json'), JSON.stringify(s101outDN));
  const s101ec = await pb.page.evaluate(S101_POST + `([['INV-5','INV-6']])`);
  const s101fileEH3 = diskJson(SA.root, 'reco/entryHistory.json');
  const s101fileDN3 = diskJson(SA.root, 'reco/docNumberMaster.json');
  const s101ids3 = ((s101fileEH3 || {}).TPL_E || []).map(e => e && e.accountingId);
  check(s101ids3.indexOf('AE-COLLEAGUE') !== -1 && s101ids3.indexOf(s101ec.accountingId) !== -1 && s101ids3.length === 4,
    'S101j an entry written onto the share between two of our writes is NOT destroyed by the next one',
    s101ids3);
  check(((s101fileDN3 || {}).TPL_E || {})['D9'] === 'AE-COLLEAGUE',
    'S101k nor is their document number', (s101fileDN3 || {}).TPL_E);
  await pb.ctx.close();
  await pa.ctx.close();

  /* =====================================================================
     [53] T-30-3 — THE ONE-TIME PROMOTION ON A DUPLICATE KEY.
     A duplicate _pk is a tolerated state and a k:'typed' record deliberately
     broadcasts to every row with the key — broadcasting a note is the
     feature. But the promotion walked sess.data in order and wrote ONE
     record per key, so two rows sharing a key with DIFFERENT legacy values
     lost one of them silently: last row wins, and the legacy entry the
     loser came from is deleted in the same pass, so there is no second copy
     and no warning.
     ===================================================================== */
  section(53, 'T-30-3 — a duplicate key with two different legacy values is NAMED, and neither is lost');
  const T3 = makeRoot('share-t303');
  const brT3 = await startBridge(T3.root, PORT_T303); procs.push(brT3.proc);
  const pt3 = await openReco(browser, brT3);
  await pt3.page.evaluate(T303_SETUP + '()');

  /* Rows, in ingest order: INV-7/Alice, INV-7/Bob, INV-8/Carol, INV-9/Dave, INV-9/Dave. */
  const t3yes = await pt3.page.evaluate(T303_RUN + `(['TPL_C', true])`);
  note('T-30-3 answered YES', { asked: t3yes.asked, promoted: t3yes.promoted, rows: t3yes.rows });
  note('T-30-3 toasts', t3yes.toasts);
  check(/INV-7/.test(t3yes.conflictText) && /Alice/.test(t3yes.conflictText) && /Bob/.test(t3yes.conflictText),
    'T303a THE GATE: the conflicting key is NAMED, with both values, in one confirm',
    t3yes.conflictText || t3yes.allAsks);
  check(t3yes.rows[0].tag === 'Alice' && t3yes.rows[1].tag === 'Bob',
    'T303b AND NEITHER VALUE IS DELETED: both legacy entries are still in sess.manualTags, so nothing '
    + 'is gone whichever way the operator answers', t3yes.rows.slice(0, 2));
  check(t3yes.rows[0].rec === null && t3yes.rows[1].rec === null,
    'T303c no record was written for the conflicting key — the promotion cannot pick between two '
    + 'values, and picking is what deleted the loser with no second copy', t3yes.rows.slice(0, 2));
  check(t3yes.rows[2].rec === 'Carol' && t3yes.rows[2].tag === null,
    'T303d the NON-CONFLICTING cells are still promoted, and their legacy entry is cleaned up as '
    + 'before — one truth per cell', t3yes.rows[2]);
  check(t3yes.rows[3].rec === 'Dave' && t3yes.rows[4].rec === 'Dave'
        && t3yes.rows[3].tag === null && t3yes.rows[4].tag === null,
    'T303e and a duplicate key whose two rows hold the SAME value is NOT a conflict: there is nothing '
    + 'to pick between, and broadcasting that one value to both rows is the feature',
    t3yes.rows.slice(3));
  check(t3yes.promoted === 3,
    'T303f the toast counts the cells actually promoted (INV-8 once, INV-9 twice), not the five it '
    + 'walked', { promoted: t3yes.promoted, toasts: t3yes.toasts });

  const t3no = await pt3.page.evaluate(T303_RUN + `(['TPL_D', false])`);
  note('T-30-3 answered NO', { asked: t3no.asked, promoted: t3no.promoted, rows: t3no.rows });
  check(t3no.asked === true && t3no.rows.every(r => r.rec === null),
    'T303g DECLINING THE CONFIRM PROMOTES NOTHING — the confirm has something to decide, which is '
    + 'what makes it a question rather than a notice', t3no.rows);
  check(t3no.rows[2].tag === 'Carol' && t3no.rows[0].tag === 'Alice' && t3no.rows[1].tag === 'Bob',
    'T303h ...AND DELETES NOTHING: every legacy value is exactly where it was', t3no.rows);

  const t3clean = await pt3.page.evaluate(T303_RUN + `(['TPL_Q', true])`);
  note('T-30-3 CONTROL (no duplicate keys)', { asked: t3clean.asked, promoted: t3clean.promoted,
    rows: t3clean.rows, asks: t3clean.allAsks });
  check(t3clean.conflictText === '' && t3clean.rows[0].rec === 'Zoe' && t3clean.promoted === 1,
    'T303i THE CONTROL: a template with no duplicate keys promotes SILENTLY, exactly as it did before '
    + '— the dialog is a conflict, not a new step in saving a template', t3clean);
  await pt3.ctx.close();


  /* =====================================================================
     [54] MR-1 — Z1'S TWO OPEN DOORS. The refusal built last round stopped
     the honest operator and passed the one who did what its own message
     asked. Both doors put the SAME wrong number into the ledger, so both
     are measured here as FIGURES READ OFF reco/entryHistory.json, never as
     the presence of a toast.
     ===================================================================== */
  section(54, 'MR-1 — an override on an ‘#ERR’ cell, and a Special JV bucket, are refused too');
  const R9 = makeRoot('share-rc9ov');
  const brR9 = await startBridge(R9.root, PORT_MR1OV); procs.push(brR9.proc);
  const pr9 = await openReco(browser, brR9);
  await pr9.page.evaluate(Z1_SETUP + '([true])');

  const r9apo = await pr9.page.evaluate(MR1_OV + `([${JSON.stringify("'500")}])`);
  note('MR-1 the Excel text-forcing apostrophe', r9apo);
  check(r9apo.cell === "'500" && r9apo.override && r9apo.override.prev === '#ERR',
    'MR1a PREMISE: the override is stored verbatim and the cell shows it, and what it replaced was '
    + '#ERR — so RC-8\'s `prev` test could never fire for exactly the cell Z1 refuses over', r9apo);
  check(r9apo.refused === true && r9apo.histLen === 0 && r9apo.dr === undefined,
    'MR1b THE GATE: the posting is REFUSED. Before this it posted Dr 150 for three rows worth '
    + '150 + INV-3 — INV-3 contributed nothing, had no journal line and was stamped POSTED',
    { refused: r9apo.refused, histLen: r9apo.histLen, dr: r9apo.dr });
  check(r9apo.stamped.length === 0 && !diskJson(R9.root, 'reco/entryHistory.json'),
    'MR1c and NOTHING was stamped and nothing reached reco/entryHistory.json',
    { stamped: r9apo.stamped, file: diskJson(R9.root, 'reco/entryHistory.json') });
  check(/INV-3/.test(String(r9apo.toasts)) && /AED/.test(String(r9apo.toasts))
        && /not a number/.test(String(r9apo.toasts)) && /read by this journal entry/.test(String(r9apo.toasts)),
    'MR1d the refusal names the key, the column, the characters, and WHY a non-numeric cell whose '
    + 'previous value was also non-numeric still counts here', r9apo.toasts);

  const r9eu = await pr9.page.evaluate(MR1_OV + `([${JSON.stringify('1.234,50')}])`);
  note('MR-1 the European decimal comma', r9eu);
  check(r9eu.refused === true && r9eu.histLen === 0,
    'MR1e the other shape RC-8 was written about is refused too: a cell reading 1.234,50 used to '
    + 'reach the general ledger as Dr 151.23', r9eu);

  const r9ok = await pr9.page.evaluate(MR1_OV + `([${JSON.stringify('250')}])`);
  note('MR-1 CONTROL, the remedy the refusal asks for', r9ok);
  check(r9ok.refused === false && r9ok.dr === 400 && r9ok.histLen === 1,
    'MR1f THE CONTROL: a plain number typed over the broken cell POSTS, and the figure is '
    + '50 + 100 + 250 = 400 — the gate passes the remedy its own message asks for', r9ok);
  const r9file = ((diskJson(R9.root, 'reco/entryHistory.json') || {}).TPL_Z || []);
  check(r9file.length === 1 && r9file[0].accountingId === r9ok.accountingId,
    'MR1g ...and that entry, and only that entry, is on the shared folder',
    r9file.map(e => e && e.accountingId));
  await pr9.ctx.close();

  /* DECISION J.8 IS UNTOUCHED, and this is the test that says what was
     narrowed: the `prev` relaxation applies ONLY to a column this entry
     reads. A column that was textual all along still takes a non-numeric
     override and still posts. */
  const RJ8 = makeRoot('share-rc9j8');
  const brRJ8 = await startBridge(RJ8.root, PORT_MR1J8); procs.push(brRJ8.proc);
  const prj8 = await openReco(browser, brRJ8);
  const r9j8 = await prj8.page.evaluate(MR1_J8 + '()');
  note('MR-1 decision J.8', r9j8);
  check(!!r9j8.rec && r9j8.rec.k === 'override' && r9j8.rec.v === 'see email'
        && !/^-?[\d]/.test(String(r9j8.rec.prev)),
    'MR1h PREMISE: a column that was NOT a number to begin with has been typed over with text — '
    + 'the exact case decision J.8 is about, and the one the `prev` test exists to protect. (RC-8 '
    + 'already refuses a non-numeric override over a NUMERIC previous value, on any column; that '
    + 'half is untouched.)', r9j8.rec);
  check(r9j8.refused === false && r9j8.dr === 400,
    'MR1i THE SCOPE: because the linked AEG template never reads that column, the posting is NOT '
    + 'refused and the figure is unchanged (100 + 300). The relaxation is scoped to a column the '
    + 'journal reads as an amount, not to every non-numeric override', r9j8);
  await prj8.ctx.close();

  const RJV = makeRoot('share-rc9jv');
  const brRJV = await startBridge(RJV.root, PORT_MR1JV); procs.push(brRJV.proc);
  const prjv = await openReco(browser, brRJV);
  const r9jv = await prjv.page.evaluate(MR1_JV + '([true])');
  note('MR-1 the Special JV door', r9jv);
  check(String(r9jv.cells) === 'INV-1=50,INV-2=100,INV-3=#ERR',
    'MR1j PREMISE: AED reads #ERR on INV-3, and the AEG template does not read AED at all — the JV '
    + 'does', r9jv.cells);
  check(r9jv.refused === true && r9jv.histLen === 0 && r9jv.stamped.length === 0,
    'MR1k THE GATE: a row bucketed to a Special JV is judged on THAT JV\'s input columns, so the '
    + 'posting is refused. Before this, Reco handed the JV page "AED":"#ERR" and an aggregating JV '
    + 'posted Dr 150 for three rows worth 650 with all three stamped POSTED', r9jv);
  check(/TCHX/.test(String(r9jv.toasts)) && /INV-3/.test(String(r9jv.toasts)),
    'MR1l and the refusal names the Special JV the row would have been sent to', r9jv.toasts);

  const r9jv0 = await prjv.page.evaluate(MR1_JV + '([false])');
  note('MR-1 CONTROL: a JV that does not read the broken column', r9jv0);
  check(r9jv0.refused === false && r9jv0.dr === 900 && r9jv0.histLen === 1,
    'MR1m THE CONTROL, which is Z1h from the JV side: when neither the AEG template NOR the JV '
    + 'reads AED, the same three rows post, and the figure is the JV\'s own 100 + 300 + 500 = 900. '
    + 'A broken formula in a column nothing reads does not refuse', r9jv0);
  await prjv.ctx.close();

  /* =====================================================================
     [55] MR-2 — A FAILED LEDGER WRITE IS RETRIED, AND THE ERROR SURVIVES.
     Store._mergeJob called _retryLater only in the unreadable-READ branch;
     a failed WRITE armed no timer, and m.intents is cleared only on
     success. So the entry stayed in memory for ever with its rows stamped
     POSTED on the share, and Store._enqueue had already wiped the error.
     ===================================================================== */
  section(55, 'MR-2 — a ledger write that fails is retried, and the failure outlives its toast');
  const R11 = makeRoot('share-rc11');
  const brR11 = await startBridge(R11.root, PORT_MR2); procs.push(brR11.proc);
  const pr11 = await openReco(browser, brR11);
  await pr11.page.evaluate(S101_SETUP + '()');
  const r11 = await pr11.page.evaluate(MR2_RUN + '([400])');
  note('MR-2 while the folder refused the write', r11.whileDown);
  note('MR-2 after it answered again', r11.after);
  check(r11.whileDown.lastError === 'entryHistory: OSError: the shared folder refused the write',
    'MR2a Store.lastError still NAMES the failure after the flush — Store._enqueue used to treat '
    + 'the caught write failure as a success and wipe it, which is why the reversal dialog\'s own '
    + '"The last save error was:" sentence could never appear', r11.whileDown);
  check(r11.whileDown.problems === 1,
    'MR2b and it is in Store.loadProblems, which outlives a four-second toast', r11.whileDown);
  const r11file = ((diskJson(R11.root, 'reco/entryHistory.json') || {}).TPL_E || []);
  check(r11file.length === 1 && r11file[0].accountingId === r11.accountingId,
    'MR2c THE GATE, AS A VALUE ON THE SHARE: the entry reached reco/entryHistory.json once the '
    + 'folder answered, with nobody retyping anything. Before this it never arrived',
    { want: r11.accountingId, got: r11file.map(e => e && e.accountingId) });
  const r11dr = (r11file[0] ? (r11file[0].lines || []) : []).reduce((s, l) => {
    const v = l && l.Dr;
    const n = parseFloat(String((v && typeof v === 'object' ? v.value : v) || '0').replace(/,/g, ''));
    return s + (isFinite(n) ? n : 0);
  }, 0);
  check(r11file.length === 1 && Math.abs(r11dr - r11.dr) < 0.005,
    'MR2d ...and it is the same FIGURE that was previewed, not a re-derived one',
    { previewed: r11.dr, onShare: r11dr });
  check(r11.after.problems === 0,
    'MR2e and the problem line is withdrawn once the write lands, so nothing says "still owed" '
    + 'about a file that has it', r11.after);
  await pr11.ctx.close();

  /* =====================================================================
     [56] MR-4 / MR-6 — THE TWO LEDGER KEYS ARE LATCHED AT BOOT, and
     Generate refuses when they are. readJson's "starting it empty" branch
     is honest for a whole-file PERSIST_KEY because flush() re-creates it;
     these two left PERSIST_KEYS and are written only through mergeWrite, so
     for them nothing is written for the rest of the session.
     ===================================================================== */
  section(56, 'MR-4/MR-6 — a damaged ledger file is latched at boot, and Generate says so');
  const R13 = makeRoot('share-rc13');
  const brR13 = await startBridge(R13.root, PORT_MR4); procs.push(brR13.proc);
  const pr13 = await openReco(browser, brR13);
  await pr13.page.evaluate(S101_SETUP + '()');
  await pr13.ctx.close();
  // a half-written file, the shape a share that dropped mid-write leaves
  fs.writeFileSync(path.join(R13.root, 'reco/entryHistory.json'),
    '{"TPL_E":[{"accountingId":"AEHALFWRIT');
  fs.writeFileSync(path.join(R13.root, 'reco/docNumberMaster.json'), '{"TPL_E":{"D1":');
  const pr13b = await openReco(browser, brR13);
  const r13 = await pr13b.page.evaluate(() => ({
    ehLatched: !!Store.readOnlyKeys.entryHistory,
    dnLatched: !!Store.readOnlyKeys.docNumberMaster,
    problems: Store.loadProblems.slice()
  }));
  note('MR-4 the boot', r13);
  check(r13.ehLatched === true && r13.dnLatched === true,
    'MR4a BOTH ledger keys are latched read-only AT BOOT, exactly as extraValueMaster is (X1f/X1g)',
    r13);
  check(r13.problems.some(s => /entryHistory/.test(s) && /nothing is being saved to it in this session/.test(s))
        && !r13.problems.some(s => /entryHistory/.test(s) && /starting it empty/.test(s)),
    'MR4b and the boot message is the honest one — "nothing is being saved to it in this session", '
    + 'never "starting it empty", which has not been true since the key left PERSIST_KEYS',
    r13.problems);
  const r13q = fs.readdirSync(path.join(R13.root, 'reco/_corrupt'));
  check(r13q.filter(f => /^entryHistory_/.test(f)).length === 1,
    'MR4c and the damaged file is quarantined ONCE, not once by each reader — two copies of one '
    + 'file with two timestamps is its own kind of wrong', r13q);

  const r15 = await pr13b.page.evaluate(MR6_RUN + '()');
  note('MR-6 Generate on a latched ledger', { modal: String(r15.modal).slice(0, 200),
    histLen: r15.histLen, stamped: r15.stamped });
  check(r15.histLen === 0 && r15.stamped.length === 0,
    'MR6a THE GATE: Generate is REFUSED and NO ROW IS STAMPED. Before this the operator was told '
    + '"Entry … generated", the rows were stamped POSTED on the share, and nothing would ever be '
    + 'written to that file', { histLen: r15.histLen, stamped: r15.stamped });
  check(/cannot be written|could not be read when this app started/.test(String(r15.modal)),
    'MR6b and it says why, and what to do about it — the reversal door has refused on exactly '
    + 'this since it was built', String(r15.modal).slice(0, 300));
  const r15sess = diskJson(R13.root, 'reco/recoSessions.json') || {};
  const r15rows = (((r15sess.TPL_E || {}).data) || []).filter(r => String(r.Desc) === 'POSTED');
  check(r15rows.length === 0,
    'MR6c and nothing on the SHARE reads POSTED either', r15rows.map(r => r._pk));
  await pr13b.ctx.close();

  /* =====================================================================
     [57] T-S10-10 — TWO COLLEAGUES, GENUINELY OVERLAPPED. Section [52]
     drives its two pages SEQUENTIALLY, which is the one timing at which the
     per-page merge cannot lose anything. Pressed together, the write is
     still not atomic BETWEEN pages (there is no compare-and-swap in the
     bridge), so the entry is re-read after the dust settles and replayed.
     This is the gate on that window: it reads green here and it read RED at
     a 1,000 ms and a 3,000 ms stagger on 9a597da.
     ===================================================================== */
  section(57, 'T-S10-10 — two colleagues pressing Generate at the same moment keep both entries');
  const S9 = makeRoot('share-s109');
  const brS9 = await startBridge(S9.root, PORT_S109); procs.push(brS9.proc);
  const p9a = await openReco(browser, brS9);
  await p9a.page.evaluate(S101_SETUP + '()');
  const p9b = await openReco(browser, brS9);
  const [s9a, s9b] = await Promise.all([
    p9a.page.evaluate(S109_POST + `([['INV-1','INV-2']])`),
    p9b.page.evaluate(S109_POST + `([['INV-3','INV-4']])`)
  ]);
  note('T-S10-10 both posted', { a: s9a.accountingId, b: s9b.accountingId });
  // past the settle, then one more flush on each page
  await new Promise(r => setTimeout(r, 1600));
  for (const p of [p9a, p9b]) await p.page.evaluate(async () => {
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle(); });
  await new Promise(r => setTimeout(r, 300));
  const s9ids = ((diskJson(S9.root, 'reco/entryHistory.json') || {}).TPL_E || [])
    .map(e => e && e.accountingId);
  const s9dn = (diskJson(S9.root, 'reco/docNumberMaster.json') || {}).TPL_E || {};
  note('T-S10-10 reco/entryHistory.json holds', s9ids);
  note('T-S10-10 reco/docNumberMaster.json holds', s9dn);
  check(s9ids.indexOf(s9a.accountingId) !== -1 && s9ids.indexOf(s9b.accountingId) !== -1,
    'S109a BOTH entries are on the shared folder after two OVERLAPPED Generates (Promise.all). One '
    + 'of them used to be gone, with that colleague\'s rows stamped POSTED and nothing behind them, '
    + 'and their own write having SUCCEEDED so nothing told them',
    { a: s9a.accountingId, b: s9b.accountingId, got: s9ids });
  check(s9dn['D1'] === s9a.accountingId && s9dn['D2'] === s9a.accountingId
        && s9dn['D3'] === s9b.accountingId && s9dn['D4'] === s9b.accountingId,
    'S109b and all four document numbers survive, each pointing at the entry that posted it — '
    + 'losing one means a re-upload of the same data is not flagged as already processed', s9dn);
  /* ---- T-S10-11. THE TWO ASSERTIONS S109a AND S109b CANNOT MAKE, and the
     reason they both read GREEN over a lost entry on 5f61d76: they ask
     whether each id is PRESENT, and when the two windows mint the SAME id
     both lookups hit the same single record. 'AE'+base36(now) is one number
     per millisecond, so a Promise.all at a 0 ms stagger produced
     posted ["AEMVAYN4CT","AEMVAYN4CT"] with the file holding ONE entry —
     one operator's journal entry gone, their rows stamped POSTED, their own
     write having succeeded, and nothing anywhere saying so. Count the file
     and compare the strings. */
  check(s9a.accountingId !== s9b.accountingId,
    'S109c the two accounting references DIFFER. Minted in the same millisecond they used to be '
    + 'the SAME string, which made each window\'s append a no-op against the other\'s record — '
    + 'one entry silently discarded and the two indistinguishable everywhere downstream (the '
    + 'reversal takes the first match, docNumberMaster names one of them, _postedAuditIndex '
    + 'resolves a row to whichever it met first)',
    { a: s9a.accountingId, b: s9b.accountingId });
  check(s9ids.length === 2,
    'S109d and reco/entryHistory.json holds TWO entries, not one wearing two names',
    { n: s9ids.length, ids: s9ids });
  check(/^AE[0-9A-Z]{2,}$/.test(String(s9a.accountingId))
        && String(s9a.accountingId).length === String(s9b.accountingId).length,
    'S109e both references still have the shape people quote — AE + base-36, same length in '
    + 'both windows. The fix lengthens the reference by two characters; it must not make it '
    + 'ragged', { a: s9a.accountingId, b: s9b.accountingId });
  /* ---- AND THE MECHANISM, NOT ONLY THE OUTCOME. S109c/S109d would still
     read green with the suffix removed, because the content test in the
     append re-mints the loser anyway - which is the fix doing its job, and
     exactly why they cannot be the gate on option (a). Two windows colliding
     is a 1-in-1,296 event now, so measuring it across two pages would be a
     coin flip; these two measure the property that MAKES it 1 in 1,296,
     inside one page and with no timing in the answer. */
  const s9tag = await p9a.page.evaluate(() => {
    const t0 = U.accountingId();
    const start = Date.now();
    while (Date.now() === start) { /* cross one millisecond, at most 1 ms */ }
    const t1 = U.accountingId();
    const keep = U._aeTag;
    const tags = new Set();
    for (let i = 0; i < 300; i++) { U._aeTag = ''; tags.add(U.accountingId().slice(-2)); }
    U._aeTag = keep;
    return { t0: t0, t1: t1, tail0: t0.slice(-2), tail1: t1.slice(-2),
             head0: t0.slice(0, -2), head1: t1.slice(0, -2),
             distinct: tags.size, sample: Array.from(tags).slice(0, 6) };
  });
  note('T-S10-11 two mints one millisecond apart', s9tag);
  check(s9tag.tail0 === s9tag.tail1 && s9tag.head0 !== s9tag.head1
        && /^[0-9A-Z]{2}$/.test(s9tag.tail0),
    'S109f the last two characters of the reference are a PER-WINDOW suffix and not more clock: '
    + 'two mints a millisecond apart share them while everything before them changes. Without '
    + 'them the whole reference is one number per millisecond, which is what made two windows '
    + 'mint the same string', s9tag);
  check(s9tag.distinct >= 2,
    'S109g and the suffix is DRAWN per window rather than compiled in: 300 fresh draws produce '
    + 'more than one value. A constant would keep the reference two characters longer and leave '
    + 'the collision at 1 in 1', { distinct: s9tag.distinct, sample: s9tag.sample });
  await p9b.ctx.close();
  await p9a.ctx.close();

  /* =====================================================================
     [57b] T-S10-11 — THE SAME REFERENCE, FORCED. [57] measures that two
     windows minting at the same instant no longer produce the same string;
     this measures what happens when they DO, which is the 1-in-1,296 the
     suffix leaves behind and the state every build before it was in
     permanently. The mint is pinned to one string in both windows and the
     posts are SEQUENTIAL, so there is no timing in the answer: the second
     window reads a file that already holds its reference under somebody
     else's entry, and the only acceptable outcome is two entries on the
     share. On 5f61d76 the second append skipped and the file held one.
     ===================================================================== */
  section('57b', 'T-S10-11 — an entry whose reference is already taken is RE-MINTED, not dropped');
  const SB = makeRoot('share-s111');
  const brSB = await startBridge(SB.root, PORT_S111); procs.push(brSB.proc);
  const pba = await openReco(browser, brSB);
  await pba.page.evaluate(S101_SETUP + '()');
  /* ---- B BOOTS BEFORE ANYTHING IS POSTED, and that ordering IS the section.
     AppState.entryHistory is read once at boot, so a B that opens after A has
     posted already holds A's entry and the in-window uniqueness guard at the
     mint site sidesteps the collision on its own - which is real, and is
     ALREADY what [52] and [57] exercise. The case that reached the append and
     lost an entry is the colleague whose window was open the whole time: the
     reference it meets is on the SHARE and nowhere in its memory. Measured:
     with this line below A's post instead of above it, the section reads
     green against an append that skips on the reference alone. */
  const pbb = await openReco(browser, brSB);
  const pbPin = await pba.page.evaluate(S111_PIN + `(['AEPINNED1'])`);
  await pbb.page.evaluate(S111_PIN + `(['AEPINNED1'])`);
  const sba = await pba.page.evaluate(S109_POST + `([['INV-1','INV-2']])`);
  const pbbBlind = await pbb.page.evaluate(
    () => ((AppState.entryHistory || {}).TPL_E || []).map(e => e && e.accountingId));
  const sbb = await pbb.page.evaluate(S109_POST + `([['INV-3','INV-4']])`);
  await new Promise(r => setTimeout(r, 1600));
  for (const p of [pba, pbb]) await p.page.evaluate(async () => {
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle(); });
  await new Promise(r => setTimeout(r, 300));
  const sbList = (diskJson(SB.root, 'reco/entryHistory.json') || {}).TPL_E || [];
  const sbIds = sbList.map(e => e && e.accountingId);
  const sbDn = (diskJson(SB.root, 'reco/docNumberMaster.json') || {}).TPL_E || {};
  // What each window believes its own entry is called, AFTER the merge.
  const sbaNow = await pba.page.evaluate(() => ((AppState.entryHistory||{}).TPL_E||[]).map(e => e.accountingId));
  const sbbNow = await pbb.page.evaluate(() => ((AppState.entryHistory||{}).TPL_E||[]).map(e => e.accountingId));
  note('T-S10-11 pinned mint returns', pbPin);
  note('T-S10-11 share holds', sbIds);
  note('T-S10-11 A/B believe', { a: sbaNow, b: sbbNow });
  note('T-S10-11 doc numbers', sbDn);
  /* THE PREMISE, AND IT HAS TO BE THE POSTED REFERENCE AND NOT THE STUB'S
     RETURN VALUE: a build whose mint does not go through U.accountingId would
     ignore the pin, post a real reference, meet no collision and read GREEN on
     every assertion below while measuring nothing at all. */
  check(pbPin === 'AEPINNED1' && sba.accountingId === 'AEPINNED1',
    'S111a PREMISE: the pin reached the mint — the first window actually posted under the pinned '
    + 'reference, so the second window really does meet a reference that is already taken',
    { stub: pbPin, posted: sba.accountingId });
  check(pbbBlind.length === 0,
    'S111a2 PREMISE: and the second window cannot SEE that reference — its entry history was read '
    + 'at boot and is empty, so the uniqueness guard at its mint site has nothing to compare '
    + 'against and the collision really does reach the append', pbbBlind);
  check(sbList.length === 2,
    'S111b BOTH entries are on the shared folder even though both windows minted the SAME '
    + 'reference. The append used to skip on the reference alone, so the second window\'s entry '
    + 'was discarded while its operator was told "generated" and its rows were stamped POSTED',
    { n: sbList.length, ids: sbIds });
  check(sbIds.length === 2 && sbIds[0] !== sbIds[1],
    'S111c and the two are under DIFFERENT references, so the reversal, the document-number '
    + 'master and the posted-row index can each name one of them', sbIds);
  check(sbIds.indexOf('AEPINNED1') !== -1,
    'S111d the window that got there first KEEPS the reference it announced — re-minting the '
    + 'wrong one would change a reference that is already quoted', sbIds);
  {
    const nonces = sbList.map(e => e && e.idNonce);
    check(nonces.every(Boolean) && nonces[0] !== nonces[1],
      'S111e each entry carries its own idNonce. That is what tells "my intent replayed" from '
      + '"a stranger took my reference"; without it the append cannot be both idempotent and '
      + 'safe', nonces);
  }
  /* B's memory holds A's entry as well as its own by the time this is read —
     not from boot (it opened before A posted; that is S111a2) but because the
     merge replaces this template's array with the one it just read off the
     share (Store._takeDisk). So the thing being measured is that B's OWN
     entry — the one S109_POST reads back off the end of B's history — carries
     the re-minted reference and is the one on the share. Naming the old one
     here is what would point B's entries tab, its reverse dialog and its
     allocate modal at A's entry. */
  check(sbb.accountingId !== 'AEPINNED1' && sbIds.indexOf(sbb.accountingId) !== -1
        && sbbNow.indexOf(sbb.accountingId) !== -1,
    'S111f the second window\'s own entry names the reference it actually landed under, in its own '
    + 'memory as well as on the share — otherwise its entries tab, its reversal dialog and its '
    + 'allocate modal all point at a colleague\'s entry',
    { own: sbb.accountingId, believes: sbbNow, onShare: sbIds });
  {
    const d3 = sbDn['D3'], d4 = sbDn['D4'];
    check(d3 === sbb.accountingId && d4 === sbb.accountingId,
      'S111g and the document numbers of the re-minted entry follow it. Left pointing at the old '
      + 'reference they would resolve these rows to a colleague\'s GL entry',
      { D3: d3, D4: d4, b: sbb.accountingId });
    check(sbDn['D1'] === 'AEPINNED1' && sbDn['D2'] === 'AEPINNED1',
      'S111h while the first window\'s numbers are untouched', { D1: sbDn['D1'], D2: sbDn['D2'] });
  }
  await pbb.ctx.close();
  await pba.ctx.close();

  /* =====================================================================
     [58] MR-7 — ONE DOCUMENT NUMBER, TWO ENTRIES. Nothing tested whether
     the number typed was already taken.
     ===================================================================== */
  section(58, 'MR-7 — a document number another entry already holds is refused');
  const DU = makeRoot('share-dnu');
  const brDU = await startBridge(DU.root, PORT_DNU); procs.push(brDU.proc);
  const pdua = await openReco(browser, brDU);
  await pdua.page.evaluate(S101_SETUP + '()');
  const dua = await pdua.page.evaluate(S101_POST + `([['INV-1','INV-2']])`);
  const pdub = await openReco(browser, brDU);
  const dub = await pdub.page.evaluate(S101_POST + `([['INV-3','INV-4']])`);
  const duA = await pdua.page.evaluate(DNU_RUN + `([0, 'GL-7000'])`);
  const duB = await pdub.page.evaluate(DNU_RUN + `([1, 'GL-7000'])`);
  note('MR-7 A allocated', duA.toasts); note('MR-7 B allocated', duB.toasts);
  /* THE SHARED MASTER IS THE RESOLVER — Reco._postedRefFor reads ix.dnm, not
     the entry's own field — so it is checked IMMEDIATELY, with no settling. */
  const duDN0 = (diskJson(DU.root, 'reco/docNumberMaster.json') || {}).TPL_E || {};
  const duHold0 = Object.keys(duDN0).filter(k => k === 'GL-7000').map(k => duDN0[k]);
  note('MR-7 the shared master, at once', duDN0);
  check(duHold0.length === 1 && duHold0[0] === dua.accountingId,
    'MR7a THE GATE, AS A VALUE ON THE SHARE: the shared document-number master names exactly ONE '
    + 'entry for GL-7000, and it is the one that got there first. It is the master that resolves a '
    + 'row to an accounting reference, so this is the half that decides whether a number is read '
    + 'as the wrong entry', { master: duDN0['GL-7000'], a: dua.accountingId, b: dub.accountingId });
  /* ...and the ENTRY'S OWN CLAIM follows within one save cycle. The two live
     in different files with a merge queue each, so when B's entryHistory
     write happened to go first it carried a claim the master then refused;
     Reco._dnRefused registers a CORRECTION intent from inside the master's
     own intent, and any further activity in the app lands it. Writing the
     claim from inside that intent instead was tried and is worse: it delays
     the entry's document numbers by a debounce cycle, which made the reverse
     dialog and a re-plan from the share disagree and refused every reversal
     (run_reverse_e2e 254 -> 236). */
  const duClaimants = () => ((diskJson(DU.root, 'reco/entryHistory.json') || {}).TPL_E || [])
    .filter(e => e && e.docNumbers && e.docNumbers.AED === 'GL-7000').map(e => e.accountingId);
  let duClaim = duClaimants(), duCycles = 0;
  /* BOUNDED, and a poll rather than one sleep: "within one further save
     cycle" is the claim, and which cycle depends on whether the entry's merge
     job or the master's happened to run first. A fixed wait made this read
     red about one run in five. */
  while (duClaim.length > 1 && duCycles < 10) {
    duCycles++;
    for (const p of [pdub, pdua]) await p.page.evaluate(async () => {
      await AppState.flush();
      if (typeof Store.idle === 'function') { await Store.idle(); await Store.idle(); }
    });
    await sleep(250);
    duClaim = duClaimants();
  }
  const duDN = (diskJson(DU.root, 'reco/docNumberMaster.json') || {}).TPL_E || {};
  note('MR-7 who claims GL-7000', { master: duDN['GL-7000'], claimants: duClaim, cycles: duCycles });
  check(duClaim.length === 1 && duDN['GL-7000'] === duClaim[0],
    'MR7c and within one further save cycle exactly ONE entry claims GL-7000 on the share, the '
    + 'same one the master names. Before this both entries claimed it for ever while the master '
    + 'named one of them', { master: duDN['GL-7000'], claimants: duClaim,
      a: dua.accountingId, b: dub.accountingId });
  check(/already belongs to entry/.test(String(duB.toasts))
        && /(Nothing was saved|was NOT saved)/.test(String(duB.toasts)),
    'MR7b and the second person is TOLD, and told which entry holds it — they used to be told '
    + '"Document numbers saved". Either wording is accepted because the refusal can come from the '
    + 'in-memory test (immediate) or from inside the merge intent, which is the only test that '
    + 'reads a file nobody has moved since', duB.toasts);
  await pdub.ctx.close();
  await pdua.ctx.close();

  /* =====================================================================
     [59] T-26-6 — THE COLLEAGUE WHO DID NOT POST THE ENTRY. The panel
     resolved against AppState.entryHistory, which is read once, at boot.
     ===================================================================== */
  section(59, 'T-26-6 — the duplicate-key panel asks the SHARED folder, not this window’s copy');
  const T6S = makeRoot('share-t266s');
  const brT6S = await startBridge(T6S.root, PORT_T266S); procs.push(brT6S.proc);
  const p6sa = await openReco(browser, brT6S);
  await p6sa.page.evaluate(T266S_SETUP + '()');
  const p6sb = await openReco(browser, brT6S);     // boots BEFORE anything is posted
  const t6post = await p6sa.page.evaluate(T266S_POST + '()');
  note('T-26-6 A posted the override', t6post);
  check(t6post.dr === 1000,
    'T266Sa PREMISE: A posted INV-7 with the override of 1000 in it, not the computed 20', t6post);
  const t6b = await p6sb.page.evaluate(T266S_LOAD + '()');
  note('T-26-6 B booted with', t6b.bootHist);
  note('T-26-6 B\'s posted block', t6b.posted);
  check(t6b.bootHist === '[]',
    'T266Sb PREMISE: B\'s in-memory entry history is empty — it booted before A posted, which is '
    + 'the ordinary case on a folder several people share', t6b.bootHist);
  check(/POSTED to the general ledger/.test(t6b.posted) && /INV-7/.test(t6b.posted)
        && /1000/.test(t6b.posted) && new RegExp(t6post.accountingId).test(t6b.posted),
    'T266Sc THE GATE: B — the person who actually loads next week\'s extract — is told that the '
    + 'LEDGER holds 1000 under that entry while their screen now shows the computed value. The '
    + 'sentence this ticket exists to add was missing for its main reader', t6b.posted);
  check(!/this window's copy/.test(t6b.posted),
    'T266Sd and it does not carry the "checked against this window\'s copy" caveat, because it was '
    + 'checked against reco/entryHistory.json', t6b.posted);
  await p6sb.ctx.close();
  await p6sa.ctx.close();


  /* =====================================================================
     [60] T-30-3 — DECLINING IS RECOVERABLE, and the dialog is about the
     columns that actually conflict.
     ===================================================================== */
  section(60, 'T-30-3 — declining the conflict leaves the promotion OWED, not abandoned for ever');
  const T3B = makeRoot('share-t303b');
  const brT3B = await startBridge(T3B.root, PORT_T303B); procs.push(brT3B.proc);
  const pt3b = await openReco(browser, brT3B);
  await pt3b.page.evaluate(T303_SETUP + '()');
  const t3bNo = await pt3b.page.evaluate(T303B_RUN + `(['TPL_D', false, true])`);
  note('T-30-3 declined, then saved again and said yes', t3bNo);
  check(t3bNo.asks1.length === 1 && t3bNo.flag1 === false,
    'T303Ba DECLINING ABANDONS THE SAVE, the way the primary-key warning does: carryForward is NOT '
    + 'stored. It used to be stored anyway, which is what made the decline a one-way door',
    { asked: t3bNo.asks1.length, storedFlag: t3bNo.flag1 });
  check(t3bNo.rows1.every(s => /=-$/.test(s)),
    'T303Bb and nothing is promoted — the confirm still has something to decide', t3bNo.rows1);
  check(t3bNo.asks2.length === 1,
    'T303Bc THE GATE: saving again ASKS AGAIN. Before this, nothing was ever asked a second time '
    + 'and the column could never be carried forward without unticking and re-ticking the box',
    t3bNo.asks2);
  check(t3bNo.flag2 === true && t3bNo.rows2.indexOf('INV-8=Carol') !== -1
        && t3bNo.rows2.indexOf('INV-9=Dave') !== -1,
    'T303Bd ...and the clean keys are promoted this time — the values are kept against the row key, '
    + 'which is the whole point of the feature they ticked', t3bNo.rows2);
  check(t3bNo.rows2.filter(s => /^INV-7=/.test(s)).every(s => s === 'INV-7=-'),
    'T303Be while the conflicting key is still left alone, with neither value picked', t3bNo.rows2);
  check(/read blank the next time this file is opened/.test(String(t3bNo.toasts2)),
    'T303Bf and the operator is told what that costs: those cells read BLANK on the next load. '
    + '"Both values stay exactly where they are and nothing is deleted" was true of the FILE and '
    + 'false of the SCREEN', t3bNo.toasts2);

  const t3bPre = await pt3b.page.evaluate(T303C_RUN + '()');
  note('T-30-3 a conflict nothing would have promoted', t3bPre);
  check(t3bPre.asks.length === 0,
    'T303Bg NO QUESTION IS ASKED about a (key, column) that already has a stored record: both rows '
    + 'have been reading that one record all along, so neither legacy value was ever a promotion '
    + 'candidate. A gate that fires when nothing is at stake is how operators learn to click '
    + 'through gates', t3bPre.asks);
  check(t3bPre.rows.filter(s => /^INV-7=/.test(s)).every(s => s === 'INV-7=ALREADY STORED')
        && t3bPre.rows.indexOf('INV-8=Carol') !== -1,
    'T303Bh and the stored record is left exactly as it was, while the clean key is promoted',
    t3bPre.rows);
  await pt3b.ctx.close();

  /* =====================================================================
     [61] T-26-5 — A COLUMN WITH NOTHING TO ADD.
     ===================================================================== */
  section(61, 'T-26-5 — a total of no numbers is not 0.00');
  const T5B = makeRoot('share-t265b');
  const brT5B = await startBridge(T5B.root, PORT_T265B); procs.push(brT5B.proc);
  const pt5b = await openReco(browser, brT5B);
  const t5b = await pt5b.page.evaluate(T265B_RUN + '()');
  note('T-26-5 every cell excluded', t5b);
  check(String(t5b.cells) === 'n/a,tbc' && t5b.total.excluded === 2 && t5b.total.n === 0,
    'T265Ba PREMISE: both cells are non-numeric, so nothing was added at all', t5b.total);
  check(t5b.totalText === '— *' && t5b.totalSum === '0' && t5b.excluded === '2',
    'T265Bb THE FIX: the total cell renders —, the same answer the Sum card gives, instead of '
    + '"0.00 *" — a number that is not a total of anything. The figures are still on the cell as '
    + 'data- attributes for anything that reads them', t5b);
  check(/2 cell\(s\) in Net are not numbers/.test(t5b.note),
    'T265Bc and the footnote still says why, naming the cells', t5b.note);
  check(t5b.cards.some(c => /Sum of Net/.test(c) && /—/.test(c)),
    'T265Bd ...which is what the summary card for the same column on the same screen already said, '
    + 'so the two no longer disagree', t5b.cards);
  await pt5b.ctx.close();


  /* =====================================================================
     [62] MR-8 — AN INTENT REGISTERED WHILE A MERGE WRITE IS IN FLIGHT.
     Not in either review; found by this round while chasing a correction
     intent that never reached the share, and it is the same harm as the one
     T-S10-1 was filed about: a write that drops something with no second
     copy and says nothing.
     ===================================================================== */
  section(62, 'MR-8 — a value written while a merge write is in flight is not dropped');
  const M8 = makeRoot('share-mr8');
  const brM8 = await startBridge(M8.root, PORT_MR8); procs.push(brM8.proc);
  const pm8 = await openReco(browser, brM8);
  await pm8.page.evaluate(S101_SETUP + '()');
  const m8 = await pm8.page.evaluate(MR8_RUN + '()');
  const m8file = (diskJson(M8.root, 'reco/extraValueMaster.json') || {}).TPL_E || {};
  note('MR-8 in memory afterwards', m8.mem);
  note('MR-8 reco/extraValueMaster.json afterwards', m8file);
  check(m8.inflight === true,
    'MR8a PREMISE: the second value really was written while the first write was still in the air',
    m8.inflight);
  check(((m8file['INV-1'] || {}).Note || {}).v === 'first',
    'MR8b the value that was mid-write is on the share', m8file['INV-1']);
  check(((m8file['INV-2'] || {}).Note || {}).v === 'second',
    'MR8c THE GATE: so is the one registered DURING that write. `m.intents = []` used to clear it '
    + 'without applying it, and the job mergeWrite had already armed then took the disk as the '
    + 'authority and wrote a file without it', m8file['INV-2']);
  check(m8.mem.one === 'first' && m8.mem.two === 'second',
    'MR8d ...and it is still on the screen: Store._takeDisk replaces memory from the file it just '
    + 'read, so a value dropped from the write was dropped from the window too', m8.mem);
  await pm8.ctx.close();



  /* =====================================================================
     [63] T-S10-7 — EVERY TEMPLATE FIELD, NOT JUST THE TWO FLAGS.

     RC-12 (section [45] above) asks the share for carryForward and
     allowOverride and keeps the folder's answer for whichever of the two this
     editor did not touch. It does that for those two because they are the
     only template fields whose loss changes whether a record ALREADY ON THE
     FOLDER IS READ. Every other field — the display order, the correction
     context, the AEG roles, the formulas, the column list — was still
     last-writer-wins, so a save from a 09:00 clone reverted a colleague's
     10:00 work with "Template saved to database" the only thing said.
     REPRODUCED BEFORE ANYTHING WAS WRITTEN: build/p1_s107.out.txt — the share
     held ["Note","Amount","Invoice"] and displayOrderBy "Test User" after A's
     save, and displayOrder null after B's.

     AND THE SKIP GOES WITH IT. RC-12 was skipped while
     AppState.pendingCount() !== 0, because a debounced save of our own could
     leave reco/recoTemplates.json holding THIS session's past rather than a
     colleague's present (C6h). pendingCount() counts the typed-value store
     and the version writer too, so the reconciliation sat out exactly the
     case where the operator had just typed — which is most of them. The rule
     is now narrow and correct: the file can only be our own past while a
     write OF THAT FILE is owed, so an owed recoTemplates write is landed
     first and then the file is a statement about the share.
     ===================================================================== */
  section(63, 'T-S10-7 — a stale template save no longer reverts the fields this editor never touched');
  const S7 = makeRoot('share-s107');
  const brS7 = await startBridge(S7.root, PORT_S107); procs.push(brS7.proc);
  const p7a = await openReco(browser, brS7);
  await p7a.page.evaluate(S107_SETUP + '()');
  const p7b = await openReco(browser, brS7);      // boots with the template as it is NOW
  const s7boot = await p7b.page.evaluate(() => {
    const t = AppState.recoTemplates.find(x => x.id === 'TPL_R') || {};
    return { order: t.displayOrder || null, ctx: t.correctionContextCols || null, desc: t.description };
  });
  check(!s7boot.order && !s7boot.ctx && s7boot.desc === 'first',
    'S107 premise: B booted before A changed anything, so its clone carries no team order and no '
    + 'correction context', s7boot);
  const s7a = await p7a.page.evaluate(S107_SAVE + `([[['displayOrder',['Note','Amount','Invoice']],`
    + `['correctionContextCols',['Note']],['description','A was here']], true])`);
  const shA = ((diskJson(S7.root, 'reco/recoTemplates.json') || []).find(t => t.id === 'TPL_R') || {});
  note('T-S10-7 A\'s save', s7a);
  note('T-S10-7 the share after A', { order: shA.displayOrder, ctx: shA.correctionContextCols,
                                      by: shA.displayOrderBy, desc: shA.description });
  check(same(shA.displayOrder, ['Note','Amount','Invoice']) && same(shA.correctionContextCols, ['Note'])
        && !!shA.displayOrderBy,
    'S107a premise: A published a team column order and a correction context, and both are on the '
    + 'shared folder with A named as the publisher',
    { order: shA.displayOrder, ctx: shA.correctionContextCols, by: shA.displayOrderBy });

  const s7b = await p7b.page.evaluate(S107_SAVE + `([[['description','B was here']], true])`);
  const shB = ((diskJson(S7.root, 'reco/recoTemplates.json') || []).find(t => t.id === 'TPL_R') || {});
  note('T-S10-7 B\'s save from its 09:00 clone', s7b);
  note('T-S10-7 the share after B', { order: shB.displayOrder, ctx: shB.correctionContextCols,
                                      by: shB.displayOrderBy, desc: shB.description });
  check(same(shB.displayOrder, ['Note','Amount','Invoice']),
    'S107b (THE MONEY) A\'s team column order is STILL on the shared folder after B\'s unrelated '
    + 'save from an older clone. It used to come back null — and that order is the column order of '
    + 'every CSV and every Excel workbook this template exports, for everyone on the folder',
    { order: shB.displayOrder });
  check(same(shB.correctionContextCols, ['Note']) && shB.displayOrderBy === shA.displayOrderBy,
    'S107c ...and so are A\'s correction context and A\'s publisher stamp. The merge is every '
    + 'field, not the two flags that earned a share read last round',
    { ctx: shB.correctionContextCols, by: shB.displayOrderBy, was: shA.displayOrderBy });
  check(shB.description === 'B was here',
    'S107d THE CONTROL: what B actually edited IS saved. This keeps the folder\'s answer for the '
    + 'fields B left alone; it does not refuse B\'s work', shB.description);
  check(s7b.asks.length === 1 && /someone else|somebody else/i.test(s7b.asks[0])
        && /column order/i.test(s7b.asks[0]) && /correction/i.test(s7b.asks[0]),
    'S107e and B is asked ONE question that names every field left as the folder has it — a green '
    + '"Template saved to database" was the only thing said before', s7b.asks);
  check(same(s7b.order, ['Note','Amount','Invoice']) && same(s7b.ctx, ['Note']),
    'S107f ...and B\'s own window now agrees with the folder, so the next save out of this editor '
    + 'is not a second attempt to revert it', { order: s7b.order, ctx: s7b.ctx });

  const s7b2 = await p7b.page.evaluate(S107_SAVE + `([[['displayOrder',['Amount','Note','Invoice']]], true])`);
  const shB2 = ((diskJson(S7.root, 'reco/recoTemplates.json') || []).find(t => t.id === 'TPL_R') || {});
  note('T-S10-7 B changes the same field on purpose', { asks: s7b2.asks.length, share: shB2.displayOrder });
  check(same(shB2.displayOrder, ['Amount','Note','Invoice']),
    'S107g THE OTHER CONTROL: a field the operator DID change here wins. The folder is kept only '
    + 'for a field this editor never touched', shB2.displayOrder);
  check(s7b2.asks.some(m => /Publish this team column order/.test(m)),
    'S107h ...and it still goes through the publish confirm it always did, so the merge did not '
    + 'swallow the question that names what moves in every exported file', s7b2.asks);
  await p7b.ctx.close(); await p7a.ctx.close();

  /* ---- THE DELETED SKIP, on its own share: the operator has just typed, so
     this session owes the folder a write when the template save goes out.
     That is the state RC-12 refused to reconcile in. */
  const S7P = makeRoot('share-s107p');
  const brS7P = await startBridge(S7P.root, PORT_S107P); procs.push(brS7P.proc);
  const p7pa = await openReco(browser, brS7P);
  await p7pa.page.evaluate(S107_SETUP + '()');
  const p7pb = await openReco(browser, brS7P);
  await p7pa.page.evaluate(S107_SAVE + `([[['displayOrder',['Note','Amount','Invoice']]], true])`);
  const shPa = ((diskJson(S7P.root, 'reco/recoTemplates.json') || []).find(t => t.id === 'TPL_R') || {});
  check(same(shPa.displayOrder, ['Note','Amount','Invoice']),
    'S107i premise: A\'s order is on the folder again, on a share of its own', shPa.displayOrder);
  const s7p = await p7pb.page.evaluate(S107_PEND + '()');
  const shPb = ((diskJson(S7P.root, 'reco/recoTemplates.json') || []).find(t => t.id === 'TPL_R') || {});
  const vPb = ((diskJson(S7P.root, 'reco/extraValueMaster.json') || {}).TPL_R || {});
  note('T-S10-7 B typed and saved in the same tick', s7p);
  note('T-S10-7 the share after that', { order: shPb.displayOrder, desc: shPb.description, cells: vPb });
  check(s7p.pendingAtSave > 0,
    'S107j premise: this session OWED the folder a write when the template save went out, which is '
    + 'the state an operator who has just typed a cell is in', s7p.pendingAtSave);
  check(same(shPb.displayOrder, ['Note','Amount','Invoice']),
    'S107k (THE DELETED SKIP) ...and A\'s order survives anyway. RC-12 skipped the whole '
    + 'reconciliation while pendingCount() !== 0 — i.e. exactly when the operator had just typed, '
    + 'so the one case it was built for was the one case it sat out', shPb.displayOrder);
  check(s7p.desc === 'B typed and saved' && shPb.description === 'B typed and saved',
    'S107l ...and B\'s own edit is still saved, in memory and on the folder',
    { memory: s7p.desc, share: shPb.description });
  check(((vPb['INV-1'] || {}).Vendor || {}).v === 'Acme' && s7p.cell === 'Acme',
    'S107m ...and the value they had just typed still reached the shared folder — landing the owed '
    + 'write is what makes the file a statement about the share, and it does not cost the keystroke',
    { share: vPb['INV-1'], memory: s7p.cell });
  await p7pb.ctx.close(); await p7pa.ctx.close();


  /* =====================================================================
     [64] T-24R2-1 — THE SAME RACE WHERE IT SPLITS ROW IDENTITY, and it gets
     a REFUSAL rather than the merge above.

     WHY NOT THE MERGE. [63]'s merge keeps the folder's value for a field this
     editor did not touch, and for every other field that is the whole answer:
     the operator can see it, and re-edit it. A KEY DEFINITION is not like
     that. B's session was loaded and keyed under the OLD scheme and every
     loaded row carries a frozen _pk from it; silently adopting the folder's
     key rule under a save B believes succeeded means B's NEXT UPLOAD mints
     keys under a scheme B never chose, and one day file then holds two
     incompatible identities for the same business rows. So the key's own
     definition set — primaryKeys plus the definitions of the columns in
     Reco._keyDepNames — is read off the share and a DIFFERENCE REFUSES THE
     SAVE, with the recovery the sentence names: close the editor and open it
     again, which re-clones from the template this refusal has just refreshed
     from the folder.
     ===================================================================== */
  section(64, 'T-24R2-1 — a colleague\'s key-definition change REFUSES the stale save instead of being reverted');
  const KD = makeRoot('share-24r21');
  const brKD = await startBridge(KD.root, PORT_24R21); procs.push(brKD.proc);
  const pkda = await openReco(browser, brKD);
  await pkda.page.evaluate(KD_SETUP + '()');
  const pkdb = await openReco(browser, brKD);     // boots with CONCAT({Doc})
  const kdboot = await pkdb.page.evaluate(() => ((AppState.recoTemplates.find(x => x.id === 'TPL_KD')
    || {}).additionalColumns || []).map(a => a.name + '=' + a.formula));
  check(String(kdboot) === 'Ref=CONCAT({Doc})',
    'S241 premise: B booted with the old key formula', kdboot);
  const kda = await pkda.page.evaluate(KD_KEYCHANGE + `(['CONCAT({Doc},"-X")'])`);
  const kdShA = ((diskJson(KD.root, 'reco/recoTemplates.json') || []).find(t => t.id === 'TPL_KD') || {});
  const kdFormA = ((kdShA.additionalColumns || []).find(a => a.name === 'Ref') || {}).formula;
  note('T-24R2-1 A changed how a row is identified', kda);
  note('T-24R2-1 the share after A', { formula: kdFormA, pk: kdShA.primaryKeys });
  check(kda.asks.some(m => /primary key/i.test(m)) && kdFormA === 'CONCAT({Doc},"-X")',
    'S241a premise: A edited the key formula, was asked about it (#24\'s own confirm, which works '
    + 'for one page), and the new definition is on the shared folder',
    { asked: kda.asks.length, formula: kdFormA });

  const kdb = await pkdb.page.evaluate(KD_SAVE + `([[['name','Renamed by B']], true])`);
  const kdShB = ((diskJson(KD.root, 'reco/recoTemplates.json') || []).find(t => t.id === 'TPL_KD') || {});
  const kdFormB = ((kdShB.additionalColumns || []).find(a => a.name === 'Ref') || {}).formula;
  note('T-24R2-1 B\'s save from its older clone', kdb);
  note('T-24R2-1 the share after B', { formula: kdFormB, name: kdShB.name });
  check(kdb.toasts.some(t => /identifies its rows/i.test(t) && /open it again/i.test(t)),
    'S241b THE REFUSAL: B is told that someone else changed how this reconciliation identifies its '
    + 'rows while this editor was open, and what to do about it. Nothing used to be said at all — '
    + 'B\'s clone and the stored template agreed, so defsMoved was false', kdb.toasts);
  check(kdFormB === 'CONCAT({Doc},"-X")' && kdShB.name !== 'Renamed by B',
    'S241c (THE MONEY, ON THE SHARE) A\'s key definition is still on the shared folder and B\'s '
    + 'save stored NOTHING — not even the field B did edit. A key change is the one field where '
    + 'silently keeping the folder\'s answer under a save the operator believes succeeded is its '
    + 'own trap', { formula: kdFormB, name: kdShB.name });
  check(((kdb.extras || []).join('|')) === 'Ref=CONCAT({Doc},"-X")',
    'S241d ...and this window has been refreshed from the folder, so "open it again" is a recovery '
    + 'and not a loop', kdb.extras);

  /* AND THE MEASUREMENT THE TICKET ASKS FOR: what the next upload MINTS.
     Four business rows uploaded from each page. Under the race the two pages
     mint under two schemes and the day file holds eight keys for four rows. */
  await pkda.page.evaluate(KD_UPLOAD + '()');
  await pkdb.page.evaluate(KD_UPLOAD + '()');
  const kdRows = csvRows(verFile(KD.root, kdShB.dataFolder || 'KeyDefs'));
  const kdKeys = Array.from(new Set(kdRows.map(r => r._pk).filter(Boolean))).sort();
  note('T-24R2-1 the day file', { rows: kdRows.length, keys: kdKeys });
  check(kdKeys.length === 4 && kdKeys.every(k => /-X$/.test(k)),
    'S241e (THE MEASUREMENT) one upload from EACH page writes ONE key scheme into '
    + 'reco_data/<folder>/<MMM-YY>/<DD>.csv — four keys for four business rows, every one of them '
    + 'A\'s. The race this ticket is about gives eight keys for the same four rows, which is how '
    + 'one day file comes to hold two incompatible identities and the open-item total doubles',
    { keys: kdKeys, rows: kdRows.length });

  /* THE CONTROL, and it is what stops this becoming "key changes are refused":
     B reopens the editor — re-cloning from the template the refusal refreshed —
     and the same save goes straight through. */
  const kdb2 = await pkdb.page.evaluate(KD_SAVE + `([[['name','Renamed by B']], true])`);
  const kdShC = ((diskJson(KD.root, 'reco/recoTemplates.json') || []).find(t => t.id === 'TPL_KD') || {});
  note('T-24R2-1 B saves again from a fresh clone', kdb2);
  check(kdShC.name === 'Renamed by B'
        && ((kdShC.additionalColumns || []).find(a => a.name === 'Ref') || {}).formula === 'CONCAT({Doc},"-X")',
    'S241f THE CONTROL: opening the editor again and making the same change saves it — and A\'s key '
    + 'definition is still there underneath. The refusal is about the race, not about key changes',
    { name: kdShC.name, formula: ((kdShC.additionalColumns || []).find(a => a.name === 'Ref') || {}).formula });
  const kdc = await pkda.page.evaluate(KD_KEYCHANGE + `(['CONCAT({Doc},"-Y")'])`);
  const kdShD = ((diskJson(KD.root, 'reco/recoTemplates.json') || []).find(t => t.id === 'TPL_KD') || {});
  check(((kdShD.additionalColumns || []).find(a => a.name === 'Ref') || {}).formula === 'CONCAT({Doc},"-Y")',
    'S241g THE OTHER CONTROL: a page whose clone AGREES with the folder can still change the key '
    + 'definition — that is #24\'s feature and it is untouched',
    { formula: ((kdShD.additionalColumns || []).find(a => a.name === 'Ref') || {}).formula, asks: kdc.asks.length });
  await pkdb.ctx.close(); await pkda.ctx.close();



  /* =====================================================================
     [65] T-S10-5 — A COLUMN THAT IS RENAMED **AND** MOVED IN ONE SAVE.

     F12 pairs prevExtras[idx] with t.additionalColumns[idx] — the same SLOT
     in the editor's list — so renaming "Vendor" to "Supplier" in place
     migrates its stored values (X3a-X3c), and renaming it AND dragging it
     somewhere else in the same save looks exactly like "Vendor was removed
     and Supplier was added". The operator then gets the REMOVAL confirm,
     which offers to delete the values rather than move them, and the records
     stay filed under "Vendor" if they cancel. An added column had no
     identity to pair on; it has one now (_cid, minted when the column is
     created), and the slot rule stays as the fallback for every column
     written before it.
     ===================================================================== */
  section(65, 'T-S10-5 — renaming an added column AND moving it keeps the values');
  const C5 = makeRoot('share-s105');
  const brC5 = await startBridge(C5.root, PORT_S105); procs.push(brC5.proc);
  const pc5 = await openReco(browser, brC5);
  const c5ids = await pc5.page.evaluate(S105_SETUP + '()');
  const c5recs0 = ((diskJson(C5.root, 'reco/extraValueMaster.json') || {}).TPL_C || {});
  note('T-S10-5 the columns as created', c5ids);
  note('T-S10-5 the records before the rename', c5recs0);
  check(String(c5ids) === 'Vendor/cid,Status/cid,Legacy/none',
    'S105 premise: a column created through the editor carries a stable _cid and one pushed in by '
    + 'an older build does not — which is the pair of cases the fix has to serve', c5ids);
  check(['INV-1','INV-2','INV-3'].every(pk => ((c5recs0[pk] || {}).Vendor || {}).v)
        && ['INV-1','INV-2','INV-3'].every(pk => ((c5recs0[pk] || {}).Legacy || {}).v),
    'S105a premise: three values are on the shared folder in each column, filed against the row key',
    c5recs0);

  const c5r = await pc5.page.evaluate(S105_MOVE + `(['Vendor','Supplier',2])`);
  const c5recs = ((diskJson(C5.root, 'reco/extraValueMaster.json') || {}).TPL_C || {});
  note('T-S10-5 the rename-and-move', c5r);
  note('T-S10-5 the records afterwards', c5recs);
  check(c5r.asks.length === 0,
    'S105b NO CONFIRM IS SHOWN. The operator got the removal confirm — "also deletes 3 value(s) '
    + 'people have typed in … they go for EVERYONE and cannot be brought back" — for a column they '
    + 'had renamed, which is the question that teaches people to click through questions', c5r.asks);
  check(['INV-1','INV-2','INV-3'].map(pk => String(((c5recs[pk] || {}).Supplier || {}).v)).join(',')
          === 'Acme,Bosch,Cummins',
    'S105c (THE MONEY, ON THE SHARE) the three values are filed under the NEW name on the shared '
    + 'folder, against the same row keys. This asserts the VALUES and not the column name: the '
    + 'defect this round is about is a value going missing while the name reads right',
    ['INV-1','INV-2','INV-3'].map(pk => ((c5recs[pk] || {}).Supplier || {}).v));
  check(['INV-1','INV-2','INV-3'].every(pk => ((c5recs[pk] || {}).Vendor === undefined)),
    'S105d ...and nothing is left behind under the old name, which is where they stayed when the '
    + 'operator cancelled the removal confirm', ['INV-1','INV-2','INV-3'].map(pk => (c5recs[pk] || {}).Vendor));
  check(String(c5r.order) === 'Status,Legacy,Supplier' && String(c5r.moved) === 'INV-1=Acme,INV-2=Bosch,INV-3=Cummins',
    'S105e ...and the column really did move: it is last in the list now, not where it was',
    { order: c5r.order, cells: c5r.moved });
  check(c5r.toasts.some(t => /3 value/.test(t) && /Supplier/.test(t)),
    'S105f and the migration is reported with the count, the way an in-place rename already was',
    c5r.toasts);

  /* THE FALLBACK, PINNED: a column with no _cid is paired by its SLOT, which
     is the rule every build before this one used. Renamed in place it still
     migrates (X3a-X3c); renamed AND moved it is still read as a removal and
     still ASKS — which is the safe side of the fork and is why this is a
     fallback and not a second fix. */
  const c5L = await pc5.page.evaluate(S105_MOVE + `(['Legacy','Heritage',0])`);
  const c5recsL = ((diskJson(C5.root, 'reco/extraValueMaster.json') || {}).TPL_C || {});
  note('T-S10-5 the same thing on a column with no _cid', c5L);
  check(c5L.asks.length === 1 && /cannot be brought back/.test(c5L.asks[0]),
    'S105g THE FALLBACK: a column written by an older build has no _cid, so it is paired by slot '
    + 'and a rename-plus-move is still read as a removal and still ASKS first. The slot rule had to '
    + 'stay, and this is what pins it', c5L.asks);
  check(['INV-1','INV-2','INV-3'].map(pk => String(((c5recsL[pk] || {}).Legacy || {}).v)).join(',')
          === 'old-1,old-2,old-3',
    'S105h ...and declining that confirm abandoned the save, so its three values are exactly where '
    + 'they were', ['INV-1','INV-2','INV-3'].map(pk => ((c5recsL[pk] || {}).Legacy || {}).v));
  await pc5.ctx.close();


  /* =====================================================================
     [66] T-F2-8 — A ROW-LEVEL EDIT THAT CANNOT FIND ITS ROW SAID NOTHING.

     The row is addressed by _id (A6), and there is a real path where it is
     not in that pane's data any more: a reload, a restore, an Excel load-back
     or a programmatic template switch between the render and the commit. The
     edit is then correctly NOT written — and `if (!row) return;` said nothing,
     so the operator's typing disappeared off the screen with no sentence
     anywhere. B1's lesson was that a silently lost value is as bad as a
     wrongly placed one; applyCorrection has had the sentence since.
     ===================================================================== */
  section(66, 'T-F2-8 — a dropped row-level edit says so');
  const F8 = makeRoot('share-f28');
  const brF8 = await startBridge(F8.root, PORT_F28); procs.push(brF8.proc);
  const pf8 = await openReco(browser, brF8);
  await pf8.page.evaluate(S107_SETUP + '()');
  const f8 = await pf8.page.evaluate(F28_RUN + '()');
  const f8recs = ((diskJson(F8.root, 'reco/extraValueMaster.json') || {}).TPL_R || {});
  note('T-F2-8 the three row-level writers', f8);
  note('T-F2-8 the store afterwards', f8recs);
  check(f8.edit.some(t => /no longer in this pane/.test(t) && /error/.test(t)),
    'F28a editCell on a row that has gone SAYS SO, with the sentence applyCorrection already uses '
    + 'for the same case. The typing used to vanish with nothing said at all', f8.edit);
  check(f8.offset.some(t => /no longer in this pane/.test(t) && /error/.test(t)),
    'F28b and so does manualOffset — the ticket names it as a sibling of the same `if (!row) '
    + 'return;`', f8.offset);
  check(f8.unmark.some(t => /no longer in this pane/.test(t) && /error/.test(t)),
    'F28c and so does unmarkOffset', f8.unmark);
  check(f8.ctl.length === 0 && f8.ctlValue === 'a real edit'
        && ((f8recs[f8.ctlPk] || {}).Vendor || {}).v === 'a real edit',
    'F28d THE CONTROL: a row that IS there still commits — the VALUE is in the store and on the '
    + 'shared folder, and nothing was said about a missing row. editCell runs on every cell commit '
    + 'in the app, so the hot path had to stay silent when it works',
    { said: f8.ctl, memory: f8.ctlValue, share: (f8recs[f8.ctlPk] || {}).Vendor });
  await pf8.ctx.close();


  /* =====================================================================
     [67] T-26-4 — A ROW THAT IS ALREADY IN THE GENERAL LEDGER CAN BE POSTED
     A SECOND TIME.

     Nothing in previewEntryFromSelection asked Reco.isRowPosted, and
     commitEntryFromPreview did not either: select a row that is already in
     the ledger, press Preview Entry, Generate, and entryHistory ends up with
     two entries whose postedPks both name it (reviewer finding F3's probe).
     THE DECISION TAKEN IS WARN AND OFFER TO DROP, NOT A HARD REFUSAL: the
     preview still OPENS, the already-posted rows are named with the
     accounting reference each one is in, and the two ways on are both there —
     because a refusal would change what every existing template can post,
     which is what this ticket was deferred for in the first place.
     ===================================================================== */
  section(67, 'T-26-4 — Preview Entry warns about a row that is already posted and offers to drop it');
  const P4 = makeRoot('share-t264');
  const brP4 = await startBridge(P4.root, PORT_264); procs.push(brP4.proc);
  const pp4 = await openReco(browser, brP4);
  await pp4.page.evaluate(T264_SETUP + '()');
  const p4post = await pp4.page.evaluate(T264_POST + `([['INV-1']])`);
  note('T-26-4 INV-1 posted', p4post);
  check(p4post.accountingId && String(p4post.postedPks) === 'INV-1',
    'T264 premise: INV-1 is in the general ledger under one accounting reference', p4post);
  const p4rel = await pp4.page.evaluate(T264_RELOAD + '()');
  note('T-26-4 after reopening the day file from history', p4rel);
  check(p4rel.indexOf('INV-1=posted') !== -1 && p4rel.indexOf('INV-2=open') !== -1,
    'T264a premise: after the reload every colleague does the next morning, the LEDGER is what '
    + 'still says INV-1 is posted (RC-5) — which is the state F3\'s probe re-posted from', p4rel);

  const p4 = await pp4.page.evaluate(T264_PREVIEW + `([['INV-1','INV-2']])`);
  note('T-26-4 the preview', p4);
  check(p4.first.opened === true,
    'T264b THE PREVIEW STILL OPENS. The user decision taken here is warn-and-offer, not a refusal: '
    + 'no workflow that deliberately re-posts today becomes impossible', p4.first);
  check(String(p4.first.source) === 'INV-1,INV-2' && p4.first.lines === 4
        && p4.first.included === true,
    'T264c WHAT THE ENTRY POSTS IS UNCHANGED UNTIL SOMEBODY DECIDES. The decision taken is warn '
    + 'and OFFER to drop, so both rows are still in Reco._pendingEntry.sourceRows: dropping them '
    + 'by default would post an entry quietly smaller than the selection the operator ticked, '
    + 'which is the harm and not the remedy, and it is what run_jv_gen and run_jv_engine caught '
    + 'when this was built the other way round', { source: p4.first.source, lines: p4.first.lines });
  check(p4.first.posted.length === 1 && p4.first.posted[0] === 'INV-1/' + p4post.accountingId,
    'T264d ...and the row is NAMED with the accounting reference it is already in, the way the '
    + 'override refusal does. Reco._postedRefForPk answers that from the posted index',
    p4.first.posted);
  check(/already posted/i.test(p4.first.body) && new RegExp(p4post.accountingId).test(p4.first.body)
        && /writes a SECOND entry/.test(p4.first.body) && /Leave them out/.test(p4.first.body)
        && /reverse its entry/.test(p4.first.body),
    'T264e ...and the preview itself says so on screen: what generating would do, the button that '
    + 'drops them, and the way back that needs no warning at all', p4.first.body.slice(0, 500));
  check(p4.dropped && /Post them anyway/.test(p4.dropped.body)
        && /Left out of this entry/.test(p4.dropped.body),
    'T264e2 ...and once they are dropped the banner says so and offers the undo',
    p4.dropped && p4.dropped.body.slice(0, 400));
  check(p4.dropped && String(p4.dropped.source) === 'INV-2' && p4.dropped.included === false
        && p4.dropped.lines === 2,
    'T264f (THE MONEY) "Leave them out" DROPS THEM — the already-posted row leaves '
    + 'Reco._pendingEntry.sourceRows, so it is not in the lines Generate writes. That is the offer '
    + 'this ticket exists to add, and nothing in previewEntryFromSelection asked isRowPosted at all '
    + 'before it', p4.dropped);
  check(p4.back && String(p4.back.source) === 'INV-1,INV-2' && p4.back.included === true,
    'T264g ...and "Post them anyway" puts them back, so neither answer is a one-way door and the '
    + 'flag is one press rather than a mode', p4.back);

  /* AND THE LEDGER, which is the assertion that matters: generate from the
     preview with the posted row LEFT OUT and the ledger must still hold one
     entry for that key. The preview is rebuilt dropped first, because the
     probe above left it included. */
  await pp4.page.evaluate(() => Reco.previewIncludePosted(false));
  const p4c = await pp4.page.evaluate(T264_COMMIT + '()');
  note('T-26-4 the ledger after generating with the posted row left out', p4c);
  check(p4c.entries === 2 && p4c.byEntry.filter(s => /INV-1/.test(s)).length === 1,
    'T264h (THE LEDGER) AppState.entryHistory still holds exactly ONE entry naming INV-1 — the '
    + 'second entry posted INV-2 alone. Two entries whose postedPks both named the same row is what '
    + 'this ticket is about, and it is the state F3 measured', p4c.byEntry);

  /* AND THE OTHER END OF IT: a selection where EVERY row is already posted
     opens an empty entry, so Generate has to say so. "The modal closed and
     nothing was written" is the silent shape this whole round is about. */
  const p4all = await pp4.page.evaluate(T264_ALLPOSTED + '()');
  note('T-26-4 Generate with every row left out', p4all);
  check(p4all.opened === true && String(p4all.source) === '' && p4all.entries === p4all.entriesBefore
        && p4all.toasts.some(t => /Nothing was posted/.test(t) && /already in the general ledger/.test(t)),
    'T264l the preview still OPENS on a selection where every row is already posted, and once the '
    + 'operator has pressed "Leave them out" there is nothing left in it — so Generate REFUSES with '
    + 'a sentence instead of closing the modal on an entry that was never written. entryHistory is '
    + 'unchanged', p4all);

  const p4rev = await pp4.page.evaluate(T264_REVERSE + `([${JSON.stringify(1)}])`.replace('1', JSON.stringify(p4post.accountingId)));
  note('T-26-4 after reversing the first entry', p4rev);
  check(p4rev.reversed === true && p4rev.rows.indexOf('INV-1=posted') === -1,
    'T264i premise for the control: reversing the entry releases the row, which is §12\'s whole '
    + 'point', p4rev);
  const p4ctl = await pp4.page.evaluate(T264_PREVIEW + `([['INV-1']])`);
  note('T-26-4 THE CONTROL: previewing a reversed row', p4ctl);
  check(p4ctl.first.opened === true && String(p4ctl.first.source) === 'INV-1'
        && p4ctl.first.posted.length === 0,
    'T264j THE CONTROL: a row whose entry was REVERSED can be posted again with NO warning at all. '
    + 'That is the documented way back (§12), and a gate that fired on it would make the recovery '
    + 'route unusable', p4ctl.first);
  check(!/already posted/i.test(p4ctl.first.body),
    'T264k ...and the banner is not there either — a gate that fires when nothing is at stake is '
    + 'how operators learn to click through gates', p4ctl.first.body.slice(0, 200));
  await pp4.ctx.close();



  /* =====================================================================
     [68] T-S10-9 — THE LAST TYPING OF THE DAY, AND THE REPLAY THAT MUST NOT
     DESTROY A COLLEAGUE'S WORK TO RECOVER YOUR OWN.

     T-S10-6's first half landed: the operator is told while typing, and both
     doors out ask. What was left was the answer YES — the folder is down on
     the last write, the four retries are spent, the operator answers "leave
     anyway", and the typing is gone, because the store keeps ONE TRUTH PER
     CELL and deliberately no second copy. Reviewer B's P3f is the
     measurement: four typed values, cells ["INV-1=","INV-2=","INV-3=",
     "INV-4="], store {}.

     THE CORRECTNESS QUESTION IS NOT THE WRITING, IT IS THE REPLAY. A
     colleague may have typed the same cell while this window was offline, so
     the losing case is tested here as hard as the winning one: a journalled
     intent older than the share's record for that cell MUST NOT be applied,
     or recovering your own work destroys theirs.
     ===================================================================== */
  section(68, 'T-S10-9 — typing the folder could not take is kept on this PC and replayed, newest value wins');
  const J9 = makeRoot('share-s109j');
  const brJ9 = await startBridge(J9.root, PORT_S109J); procs.push(brJ9.proc);
  const pj9 = await openReco(browser, brJ9);
  await pj9.page.evaluate(S109_SETUP + '()');
  const j9down = await pj9.page.evaluate(S109_TYPE_DOWN
    + `([[[0,'Acme'],[1,'Bosch'],[2,'Cummins'],[3,'Denso']]])`);
  const j9disk = ((diskJson(J9.root, 'reco/extraValueMaster.json') || {}).TPL_R || {});
  note('T-S10-9 four values typed while the folder was down', j9down.cells);
  note('T-S10-9 the journal on this PC', j9down.journal);
  note('T-S10-9 the shared folder', j9disk);
  note('T-S10-9 the leave gate', j9down.gate);
  check(j9down.applied === 4 && j9down.pending > 0
        && !['INV-1','INV-2','INV-3','INV-4'].some(pk => ((j9disk[pk] || {}).Vendor || {}).v),
    'S109 premise: four values are typed, the app says applied, and NONE of them is on the shared '
    + 'folder — the retry budget is spent and the write is still owed',
    { applied: j9down.applied, pending: j9down.pending, share: j9disk });
  check(j9down.journal.length === 4
        && ['INV-1','INV-2','INV-3','INV-4'].every(pk => j9down.journal.some(s => s.indexOf(pk + '/Vendor=') === 0)),
    'S109a (THE SECOND COPY) the journal on THIS PC holds all four intents, each with the cell and '
    + 'its own timestamp. The store keeps one truth per cell and no second copy, which is why there '
    + 'was nothing to recover from before this', j9down.journal);
  check(j9down.leftAnyway === true && j9down.gate.length === 1
        && /kept ON THIS PC/.test(j9down.gate[0]) && /newer value/.test(j9down.gate[0]),
    'S109b and the leave gate no longer says "lose them" about values it is keeping. It names the '
    + 'count that IS kept on this PC and promises not to overwrite a colleague\'s newer value — the '
    + 'old wording was true of every pending change and is now false for these', j9down.gate);

  /* THE NEXT BOOT. The page is reloaded in the same browser context, so
     localStorage survives and memory does not, which is what an operator
     does by closing the window and opening it again tomorrow. */
  await pj9.page.reload();
  await pj9.page.waitForSelector('#appMain .panel', { timeout: 30000 });
  const j9boot = await pj9.page.evaluate(S109_AFTER_BOOT + '()');
  await pj9.page.evaluate(async () => { await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle(); });
  const j9disk2 = ((diskJson(J9.root, 'reco/extraValueMaster.json') || {}).TPL_R || {});
  note('T-S10-9 what the boot made of the journal', j9boot.replay);
  note('T-S10-9 the shared folder after the replay', j9disk2);
  check(j9boot.replay && j9boot.replay.pending === 4 && /4 value\(s\) you typed here last time/.test(j9boot.replay.asked),
    'S109c THE BOOT OFFERS THEM BY COUNT and names the cells — never silently, because this window '
    + 'is about to put values onto a folder other people have been using since',
    j9boot.replay && { pending: j9boot.replay.pending, asked: j9boot.replay.asked });
  check(['INV-1','INV-2','INV-3','INV-4'].map(pk => pk + '=' + String(((j9disk2[pk] || {}).Vendor || {}).v))
          .join(',') === 'INV-1=Acme,INV-2=Bosch,INV-3=Cummins,INV-4=Denso',
    'S109d (THE MONEY, ON THE SHARE) accepting puts all four on the shared folder with the values '
    + 'that were typed. P3f measured ["INV-1=","INV-2=","INV-3=","INV-4="] and store {}',
    ['INV-1','INV-2','INV-3','INV-4'].map(pk => ((j9disk2[pk] || {}).Vendor || {}).v));
  check(j9boot.replay.landed === 4 && j9boot.journal.length === 0,
    'S109e ...and the journal is empty afterwards, so nothing is offered twice',
    { landed: j9boot.replay.landed, journal: j9boot.journal });

  await pj9.page.reload();
  await pj9.page.waitForSelector('#appMain .panel', { timeout: 30000 });
  const j9boot2 = await pj9.page.evaluate(S109_AFTER_BOOT + '()');
  note('T-S10-9 the boot after that', j9boot2.replay);
  check(j9boot2.replay && j9boot2.replay.pending === 0 && !j9boot2.replay.asked,
    'S109f A SECOND BOOT REPLAYS NOTHING and asks nothing — a question that comes back every '
    + 'morning is a question people stop reading', j9boot2.replay);
  await pj9.ctx.close();

  /* ---- THE GUARD, on its own share: a colleague typed one of those cells
     while this window was offline. That cell MUST be left alone. */
  const G9 = makeRoot('share-s109g');
  const brG9 = await startBridge(G9.root, PORT_S109G); procs.push(brG9.proc);
  const pg9 = await openReco(browser, brG9);
  await pg9.page.evaluate(S109_SETUP + '()');
  const g9down = await pg9.page.evaluate(S109_TYPE_DOWN
    + `([[[0,'mine-1'],[1,'mine-2'],[2,'mine-3'],[3,'mine-4']]])`);
  check(g9down.journal.length === 4,
    'S109g premise: four intents are on this PC again, on a share of its own', g9down.journal);
  /* A COLLEAGUE'S NEWER RECORD, planted straight onto the share the way
     another window's merge write would leave it. Its `at` is LATER than
     anything this window journalled. */
  const planted = {
    TPL_R: { 'INV-2': { Vendor: { k: 'typed', v: 'theirs, and newer', ds: '',
                                  by: 'Colleague B',
                                  at: new Date(Date.now() + 600000).toISOString() } } } };
  fs.writeFileSync(path.join(G9.root, 'reco/extraValueMaster.json'), JSON.stringify(planted));
  note('T-S10-9 planted on the share before the boot', planted.TPL_R['INV-2']);
  await pg9.page.reload();
  await pg9.page.waitForSelector('#appMain .panel', { timeout: 30000 });
  const g9boot = await pg9.page.evaluate(S109_AFTER_BOOT + '()');
  await pg9.page.evaluate(async () => { await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle(); });
  const g9disk = ((diskJson(G9.root, 'reco/extraValueMaster.json') || {}).TPL_R || {});
  note('T-S10-9 the replay with a newer record in the way', g9boot.replay);
  note('T-S10-9 the shared folder afterwards', g9disk);
  check(((g9disk['INV-2'] || {}).Vendor || {}).v === 'theirs, and newer'
        && ((g9disk['INV-2'] || {}).Vendor || {}).by === 'Colleague B',
    'S109h (THE LOSING CASE, AND IT IS THE POINT) the colleague\'s NEWER value is still on the '
    + 'shared folder. A blind replay would have written "mine-2" over it and called it recovery, '
    + 'which is worse than the loss this feature fixes', (g9disk['INV-2'] || {}).Vendor);
  check((g9boot.replay.skipped || []).some(s => s.why === 'newer' && s.cell === 'INV-2 / Vendor'
          && /Colleague B/.test(String(s.by)) && s.theirs === 'theirs, and newer' && s.mine === 'mine-2'),
    'S109i ...and that cell is NAMED, with who holds the newer value, what it says and what this '
    + 'window had. "4 values recovered" with one of them silently dropped is the same silence in a '
    + 'different coat', g9boot.replay.skipped);
  check(['INV-1','INV-3','INV-4'].map(pk => String(((g9disk[pk] || {}).Vendor || {}).v)).join(',')
          === 'mine-1,mine-3,mine-4',
    'S109j (THE WINNING CASE, IN THE SAME RUN) the other three ARE applied. The guard is per CELL — '
    + 'one stale cell holding back three good ones would be a second way to lose the work',
    ['INV-1','INV-3','INV-4'].map(pk => ((g9disk[pk] || {}).Vendor || {}).v));
  check(g9boot.journal.length === 0,
    'S109k and the journal is cleared either way, skipped cells included — they are not owed to the '
    + 'folder any more, they are decisions for a person', g9boot.journal);
  await pg9.page.reload();
  await pg9.page.waitForSelector('#appMain .panel', { timeout: 30000 });
  const g9boot2 = await pg9.page.evaluate(S109_AFTER_BOOT + '()');
  check(g9boot2.replay && g9boot2.replay.pending === 0,
    'S109l and a second boot replays nothing here either', g9boot2.replay);
  await pg9.ctx.close();

  /* ---- AND THE OTHER END OF THE JOURNAL'S LIFE: the folder comes back on
     its own and the journal has to CLEAR ITSELF. Without that, the next boot
     offers values that are already on the share, the guard skips every one of
     them, and the operator is told that "somebody else" has typed those cells
     since - which is them. */
  const JR = makeRoot('share-s109r');
  const brJR = await startBridge(JR.root, PORT_S109R); procs.push(brJR.proc);
  const pjr = await openReco(browser, brJR);
  await pjr.page.evaluate(S109_SETUP + '()');
  const jr = await pjr.page.evaluate(S109_RECOVER + `([[[0,'back-1'],[1,'back-2']]])`);
  const jrdisk = ((diskJson(JR.root, 'reco/extraValueMaster.json') || {}).TPL_R || {});
  note('T-S10-9 the journal while the folder was down', jr.down);
  note('T-S10-9 the journal after the folder answered again', jr.after);
  note('T-S10-9 the shared folder', jrdisk);
  check(jr.down.length === 2,
    'S109m premise: two intents were journalled while the folder was down', jr.down);
  check(['INV-1','INV-2'].map(pk => String(((jrdisk[pk] || {}).Vendor || {}).v)).join(',')
          === 'back-1,back-2',
    'S109n the retry budget carried both values to the shared folder once it answered again, with '
    + 'nothing typed a second time (F11, unchanged by this round)',
    ['INV-1','INV-2'].map(pk => ((jrdisk[pk] || {}).Vendor || {}).v));
  check(jr.after.length === 0,
    'S109o (THE OTHER END OF THE JOURNAL) ...and the journal CLEARED ITSELF, because journalDone '
    + 'runs on the write that resolved. Without this the next boot would offer values that are '
    + 'already on the share, the per-cell guard would skip every one of them, and the operator '
    + 'would be told that somebody else had typed those cells since \u2014 which is them',
    jr.after);
  await pjr.page.reload();
  await pjr.page.waitForSelector('#appMain .panel', { timeout: 30000 });
  const jrboot = await pjr.page.evaluate(S109_AFTER_BOOT + '()');
  check(jrboot.replay && jrboot.replay.pending === 0 && !jrboot.replay.asked,
    'S109p and the boot after that asks nothing at all', jrboot.replay);
  await pjr.ctx.close();



/* ===========================================================================
   ROUND 4 — THE REVIEW OF THE DATA-LOSS ROUND (sections [69]-[77]).

   Fourteen findings from two reviewers against d1e9509. Every section below
   FAILED on that build and the pre-fix run is recorded in
   scratchpad/dataloss/fix/pre_store.txt. They assert on FILES and VALUES —
   what is on the shared folder, what is on this PC — never on a wall clock
   (§16.4a), and the one performance gate among them counts OPERATIONS.

   Ports 21300-21319, which is this round's own block.
--------------------------------------------------------------------------- */
const PORT_R1A   = 21300;   // R1 the abandoned save has already written the store
const PORT_R1B   = 21301;   // R1 the same, by Cancel rather than the key refusal
const PORT_R1C   = 21302;   // R1 the rename arm: records orphaned under a name nothing has
const PORT_R1D   = 21303;   // R1 the control: a save that SUCCEEDS still migrates
const PORT_R2A   = 21304;   // R2 the swap-to-answer gap, clobbered by ordinary activity
const PORT_R2B   = 21305;   // R2 the same gap with a templates write already owed
const PORT_R3    = 21306;   // R3 the key refusal leaves the loaded rows on the old key
const PORT_R4    = 21307;   // R4 a column the FOLDER removed, resurrected by an older clone
const PORT_R5    = 21308;   // R5 two windows of the app on one PC share one journal
const PORT_R6A   = 21309;   // R6 a journal that belongs to another shared folder
const PORT_R6B   = 21310;   // R6 the same, mixed with three that belong here
const PORT_R7    = 21311;   // R7 journalDone's cost, as an operation count
const PORT_R8    = 21312;   // R8 setTag at a row that has gone
const PORT_R9    = 21313;   // R9 the four silent siblings of T-F2-8
const PORT_R10   = 21314;   // R10 the T-26-4 banner past eight posted rows
const PORT_R3D   = 21340;   // T-S10-16 the doors A4's latch did not guard

/* R1's fixture. The key is an ADDED FORMULA COLUMN ("Ref"), which is what
   makes a colleague's formula edit a key-definition change (T-24R2-1), and
   "Vendor" holds three values people have typed. Both arms of the abandon
   path — the key REFUSAL and the merge CANCEL — are reached from here. */
const R1_SETUP = `(async function () {
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_X'; t.name = 'Abandon';
  t.columns = ['Doc','Line','Amount'].map(n => ({ name:n, label:n, formats:[], isValue:n==='Amount' }));
  t.additionalColumns = [{ name:'Ref', type:'formula', formula:'CONCAT({Doc})' },
                         { name:'Vendor', type:'custom' }];
  t.primaryKeys = ['Ref'];
  t.valueColumn = 'Amount';
  t.displayColumns = ['Doc','Line','Amount'];
  /* ---- T-S10-16'S FIXTURE FIX. Two of the five doors section [71] now
     measures COULD NOT BE REACHED on this template: it carried no tolerance,
     so checkOffsetTolerance refused every single-row offset before
     manualOffset wrote anything ("outside tolerance \u00b1undefined"), and it
     had no editable file column, so editCell had nothing to commit. That is
     why T-S10-16's own probe could only PREDICT that the offset door behaves
     like the correction door - "structurally identical" and unmeasured. A
     value tolerance is what a team sets; R3h asserts the door is REACHABLE,
     so this hole cannot come back quietly. Nothing in [69] reads either
     field. */
  t.toleranceMode = 'value'; t.toleranceValue = 1000;
  t.editableColumns = ['Line'];
  const real = window.confirm; window.confirm = () => true;
  try { RecoTemplate.saveTemplate(); } finally { window.confirm = real; }
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_X');
  RecoTemplate.open(tpl.id);
  await Reco.ingestData(tpl, [{Doc:'D1',Line:'L1',Amount:'100'},{Doc:'D2',Line:'L1',Amount:'200'},
                              {Doc:'D3',Line:'L1',Amount:'300'}], ['Doc','Line','Amount']);
  App.closeModal();
  AppState.activeRecoId = 'TPL_X';
  const sess = AppState.recoSessions.TPL_X;
  for (const [i, v] of [[0,'Acme'],[1,'Bosch'],[2,'Cummins']])
    await Reco.applyEdits(tpl, sess, [{ row: sess.data[i], col:'Vendor', value:v }],
                          { source:'grid', trusted:true });
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return { pks: (sess.data||[]).map(r=>r._pk),
           extras: (tpl.additionalColumns||[]).map(a=>a.name) };
})`;

/* A, on the share, changes the key formula — and is correctly asked #24's own
   confirm about it. */
const R1_A_KEY = `(async function () {
  const asks = []; const real = window.confirm;
  window.confirm = m => { asks.push(String(m)); return true; };
  try {
    RecoTemplate.edit('TPL_X');
    RecoTemplate._editing.additionalColumns.find(a=>a.name==='Ref').formula = 'CONCAT({Doc},"-X")';
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch(e){} }
  } finally { window.confirm = real; }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return { asks: asks.length };
})`;

/* A, on the share, changes an ORDINARY field — enough for B's save to be
   offered the merge question, so Cancel can abandon it. */
const R1_A_DESC = `(async function () {
  const real = window.confirm; window.confirm = () => true;
  try {
    RecoTemplate.edit('TPL_X');
    RecoTemplate._editing.description = 'A was here';
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch(e){} }
  } finally { window.confirm = real; }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return true;
})`;

/* B, booted BEFORE A's save, removes the Vendor column and says YES to the
   "this deletes 3 values for EVERYONE" confirm — then the save is abandoned
   under it, by whichever arm the caller asked for (`answer` false = Cancel on
   the merge question). */
const R1_B_REMOVE = `(async function (arg) {
  const [answer] = arg;
  window.__toasts = [];
  const asks = []; const real = window.confirm;
  window.confirm = m => { asks.push(String(m)); return /Removing /.test(String(m)) ? true : answer; };
  try {
    RecoTemplate.edit('TPL_X');
    RecoTemplate._editing.additionalColumns =
      RecoTemplate._editing.additionalColumns.filter(a => a.name !== 'Vendor');
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch(e){} }
  } finally { window.confirm = real; }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  const t = AppState.recoTemplates.find(x=>x.id==='TPL_X') || {};
  return { asks, toasts: (window.__toasts||[]).map(x=>x.kind+': '+x.msg),
           extrasNow: (t.additionalColumns||[]).map(a=>a.name),
           memValues: JSON.parse(JSON.stringify((AppState.extraValueMaster||{}).TPL_X || {})) };
})`;

/* B RENAMES the column instead. The records migrate; the save is refused. */
const R1_B_RENAME = `(async function () {
  window.__toasts = [];
  const real = window.confirm; window.confirm = () => true;
  try {
    RecoTemplate.edit('TPL_X');
    RecoTemplate._editing.additionalColumns.find(a=>a.name==='Vendor').name = 'Supplier';
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch(e){} }
  } finally { window.confirm = real; }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return { toasts: (window.__toasts||[]).map(x=>x.kind+': '+x.msg) };
})`;

/* THE CONTROL. Nobody else touches the share, so the same rename and the same
   removal must still migrate and still delete — the staging must not turn the
   migrations off, only move them behind the folder's answer. */
const R1_B_OK = `(async function () {
  window.__toasts = [];
  const real = window.confirm; window.confirm = () => true;
  try {
    RecoTemplate.edit('TPL_X');
    RecoTemplate._editing.additionalColumns.find(a=>a.name==='Vendor').name = 'Supplier';
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch(e){} }
  } finally { window.confirm = real; }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return { toasts: (window.__toasts||[]).map(x=>x.kind+': '+x.msg) };
})`;

section(69, 'R1  T-S10-7/T-24R2-1 — AN ABANDONED SAVE MUST NOT HAVE WRITTEN THE STORE ALREADY');
{
  /* ARM 1: the key refusal. B's removal confirm has been answered YES, so the
     records are deleted BEFORE the folder is asked; the folder then refuses
     the save and says "Nothing was saved". The column comes back on the
     template and the three values are gone for everyone. */
  const XA = makeRoot('share-r1a');
  const brXA = await startBridge(XA.root, PORT_R1A); procs.push(brXA.proc);
  const pa1 = await openReco(browser, brXA);
  const setup = await pa1.page.evaluate(R1_SETUP + '()');
  note('R1 fixture', setup);
  const before = diskJson(XA.root, 'reco/extraValueMaster.json') || {};
  const beforeN = Object.keys(before.TPL_X || {}).length;
  check(beforeN === 3, 'R1 premise: three typed Vendor values are on the shared folder', beforeN);

  const pb1 = await openReco(browser, brXA);        // B boots BEFORE A's save
  await pa1.page.evaluate(R1_A_KEY + '()');         // ...then A changes the key formula
  const b1 = await pb1.page.evaluate(R1_B_REMOVE + '([true])');
  note('R1a B toasts', b1.toasts);
  const after1 = diskJson(XA.root, 'reco/extraValueMaster.json') || {};
  const tpl1 = (diskJson(XA.root, 'reco/recoTemplates.json') || []).find(t => t && t.id === 'TPL_X') || {};
  note('R1a SHARE values after the refusal', Object.keys(after1.TPL_X || {}));
  check(b1.toasts.some(s => /Nothing was saved/.test(s)),
    'R1a premise: B\'s save really was REFUSED, with "Nothing was saved"', b1.toasts);
  check((tpl1.additionalColumns || []).map(a => a.name).includes('Vendor'),
    'R1a premise: the refusal put the Vendor column back on the folder\'s template',
    (tpl1.additionalColumns || []).map(a => a.name));
  check(Object.keys(after1.TPL_X || {}).length === 3,
    'R1a (THE BLOCKER) the three typed values are STILL on the shared folder. A save that said '
    + '"Nothing was saved" must not have deleted three people\'s typing for EVERYONE on the folder '
    + 'fifty-five lines earlier — and the removal confirm\'s own promise ("cancel and change its '
    + 'name in place instead — that keeps the values") is only true if cancelling the SAVE cancels '
    + 'the delete', { before: beforeN, after: Object.keys(after1.TPL_X || {}).length });
  check(Object.keys(b1.memValues || {}).length === 3,
    'R1b ...and they are still in B\'s own memory, so B\'s grid does not read blank either',
    b1.memValues);
  await pa1.ctx.close(); await pb1.ctx.close();

  /* ARM 2: no key change at all. Any ordinary colleague field change plus
     Cancel on the merge question reaches the same place. */
  const XB = makeRoot('share-r1b');
  const brXB = await startBridge(XB.root, PORT_R1B); procs.push(brXB.proc);
  const pa2 = await openReco(browser, brXB);
  await pa2.page.evaluate(R1_SETUP + '()');
  const pb2 = await openReco(browser, brXB);
  await pa2.page.evaluate(R1_A_DESC + '()');
  const b2 = await pb2.page.evaluate(R1_B_REMOVE + '([false])');
  note('R1c B toasts', b2.toasts);
  const after2 = diskJson(XB.root, 'reco/extraValueMaster.json') || {};
  check(b2.toasts.some(s => /Nothing more was saved/.test(s)),
    'R1c premise: B pressed Cancel on the merge question and was told "Nothing more was saved"',
    b2.toasts);
  check(Object.keys(after2.TPL_X || {}).length === 3,
    'R1c (THE SAME BLOCKER, NO KEY CHANGE NEEDED) Cancel left the three typed values on the '
    + 'shared folder. The toast says "the template on the shared folder is untouched"; the values '
    + 'file is part of that promise',
    Object.keys(after2.TPL_X || {}));
  await pa2.ctx.close(); await pb2.ctx.close();

  /* ARM 3: the rename. The migration is a MOVE, so nothing is deleted — but
     the records end up filed under a name no column on the folder has, which
     is T-26-11's shape, and the operator is told "3 values now belong to
     Supplier" one toast before "Nothing was saved". */
  const XC = makeRoot('share-r1c');
  const brXC = await startBridge(XC.root, PORT_R1C); procs.push(brXC.proc);
  const pa3 = await openReco(browser, brXC);
  await pa3.page.evaluate(R1_SETUP + '()');
  const pb3 = await openReco(browser, brXC);
  await pa3.page.evaluate(R1_A_KEY + '()');
  const b3 = await pb3.page.evaluate(R1_B_RENAME + '()');
  note('R1d B toasts, in order', b3.toasts);
  const after3 = diskJson(XC.root, 'reco/extraValueMaster.json') || {};
  const tpl3 = (diskJson(XC.root, 'reco/recoTemplates.json') || []).find(t => t && t.id === 'TPL_X') || {};
  const cols3 = Object.keys(after3.TPL_X || {}).map(pk => Object.keys(after3.TPL_X[pk])[0]);
  note('R1d SHARE: the name the records are filed under / the names the template has',
    [cols3, (tpl3.additionalColumns || []).map(a => a.name)]);
  check(b3.toasts.some(s => /Nothing was saved/.test(s)),
    'R1d premise: B\'s rename was refused too', b3.toasts);
  check(cols3.length === 3 && cols3.every(c => c === 'Vendor'),
    'R1d the three records are still filed under "Vendor" — the name the folder\'s template '
    + 'actually has. Filed under "Supplier" they are unreachable: the column reads BLANK on every '
    + 'colleague\'s grid and nothing in the app can show them',
    { filedUnder: cols3, templateHas: (tpl3.additionalColumns || []).map(a => a.name) });
  check(!b3.toasts.some(s => /now belong to/.test(s)),
    'R1e ...and the green "N value(s) now belong to Supplier" was never said, because it is not '
    + 'true. Two toasts that contradict each other inside one second is how an operator learns to '
    + 'ignore both', b3.toasts);
  await pa3.ctx.close(); await pb3.ctx.close();

  /* ARM 4: THE CONTROL. Staging must not switch the migrations off. */
  const XD = makeRoot('share-r1d');
  const brXD = await startBridge(XD.root, PORT_R1D); procs.push(brXD.proc);
  const pd = await openReco(browser, brXD);
  await pd.page.evaluate(R1_SETUP + '()');
  const d1 = await pd.page.evaluate(R1_B_OK + '()');
  const afterD = diskJson(XD.root, 'reco/extraValueMaster.json') || {};
  const colsD = Object.keys(afterD.TPL_X || {}).map(pk => Object.keys(afterD.TPL_X[pk])[0]);
  note('R1f the control: what the records are filed under after a save that SUCCEEDED', colsD);
  check(colsD.length === 3 && colsD.every(c => c === 'Supplier'),
    'R1f CONTROL: with nobody else on the folder the rename still MIGRATES all three records to '
    + 'the new name. Staging the migration behind the folder\'s answer must not turn it off',
    colsD);
  check(d1.toasts.some(s => /now belong to "Supplier"/.test(s)),
    'R1g CONTROL: ...and the operator is still told, once the folder has agreed', d1.toasts);
  await pd.ctx.close();
}

/* R2's fixture: an ordinary keyed template, already on the share. */
const R2_SETUP = `(async function () {
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_G'; t.name = 'Gap';
  t.columns = ['Invoice','Amount','Note'].map(n => ({ name:n, label:n, formats:[], isValue:n==='Amount' }));
  t.primaryKeys = ['Invoice'];
  t.valueColumn = 'Amount';
  t.displayColumns = ['Invoice','Amount','Note'];
  t.additionalColumns = [{ name:'Vendor', type:'custom' }];
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_G');
  RecoTemplate.open(tpl.id);
  await Reco.ingestData(tpl, [1,2].map(i => ({ Invoice:'INV-'+i, Amount:String(i*100), Note:'n'+i })),
                        ['Invoice','Amount','Note']);
  App.closeModal();
  AppState.activeRecoId = 'TPL_G';
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return true;
})`;

/* The colleague publishes a TEAM COLUMN ORDER straight onto the share, which
   is the field T-S10-7 was built for: it is the column order of every CSV and
   every workbook this template exports, for everyone on the folder. */
const R2_COLLEAGUE = `(async function () {
  const list = await window.pywebview.api.read_file('reco/recoTemplates.json');
  const arr = JSON.parse(list || '[]');
  const t = arr.find(x => x && x.id === 'TPL_G');
  t.displayOrder = ['Note','Amount','Invoice'];
  t.displayOrderBy = 'A colleague';
  await window.pywebview.api.write_file('reco/recoTemplates.json', JSON.stringify(arr));
  return t.displayOrder;
})`;

/* B presses Save with the folder read held open, the colleague publishes
   inside the gap, and then ONE ordinary AppState.flush() goes out — what
   every tag, offset and group action reaches 250 ms later. Nothing may
   publish the editor's un-merged clone, and both leave guards have to know
   that a template write is still owed. */
const R2_GAP = `(async function (arg) {
  const [owedFirst] = arg;
  window.__toasts = [];
  const realRead = window.pywebview.api.read_file;
  let holdFor = 0;
  window.pywebview.api.read_file = function (rel) {
    if (holdFor && /recoTemplates/.test(String(rel))) {
      const ms = holdFor;
      return new Promise(r => setTimeout(r, ms)).then(() => realRead.apply(window.pywebview.api, [rel]));
    }
    return realRead.apply(this, arguments);
  };
  const asks = []; const realC = window.confirm;
  window.confirm = m => { asks.push(String(m)); return true; };
  try {
    if (owedFirst) {
      /* TRIGGER (a): leave reco/recoTemplates.json OWED by this session. */
      RecoTemplate.edit('TPL_G');
      RecoTemplate._editing.description = 'B save 1';
      RecoTemplate.saveTemplate();
      if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch(e){} }
    } else {
      await AppState.flush();
    }
    holdFor = 1500;
    RecoTemplate.edit('TPL_G');
    RecoTemplate._editing.description = 'B was here';
    const guard = RecoTemplate.saveTemplate();
    /* THE GAP. The screen has moved; the write has not been decided. */
    await new Promise(r => setTimeout(r, 120));
    const gap = { page: AppState.currentPage || '', pendingCount: AppState.pendingCount(),
                  hubPending: window.__hubPendingWrites(),
                  saidSoFar: (window.__toasts||[]).map(x=>x.kind+': '+x.msg) };
    const askedBefore = asks.length;
    gap.leaveOk = App._pendingLeaveOk();
    gap.leaveAsked = asks.length > askedBefore;
    await window.__collabPublish();                  // the colleague, inside the gap
    await AppState.save();                           // ordinary activity: one flush
    gap.shareInsideGap = JSON.parse(await realRead.apply(window.pywebview.api, ['reco/recoTemplates.json']) || '[]')
      .filter(x => x && x.id === 'TPL_G').map(x => x.displayOrder)[0] || null;
    try { await guard; } catch (e) {}
    holdFor = 0;
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    gap.toasts = (window.__toasts||[]).map(x=>x.kind+': '+x.msg);
    gap.asks = asks;
    return gap;
  } finally {
    window.confirm = realC;
    window.pywebview.api.read_file = realRead;
  }
})`;

section(70, 'R2  T-S10-7 — THE SWAP-TO-ANSWER GAP MUST NOT PUBLISH THE UN-MERGED CLONE');
for (const [label, port, owedFirst] of [['trigger (b), ordinary activity', PORT_R2A, false],
                                        ['trigger (a), a templates write already owed', PORT_R2B, true]]) {
  const G = makeRoot('share-r2-' + port);
  const brG = await startBridge(G.root, port); procs.push(brG.proc);
  const pb = await openReco(browser, brG);
  await pb.page.evaluate(R2_SETUP + '()');
  const pc = await openReco(browser, brG);          // the colleague's window
  await pb.page.evaluate(`window.__collabPublish = () => Promise.resolve(true);`);
  /* The colleague publishes from its OWN context, through the bridge, so the
     share really changes under B rather than B writing its own fixture. */
  await pb.page.exposeFunction('__collabPublishImpl', async () => {
    return pc.page.evaluate(R2_COLLEAGUE + '()');
  });
  await pb.page.evaluate(`window.__collabPublish = () => window.__collabPublishImpl();`);
  const gap = await pb.page.evaluate(R2_GAP + `([${owedFirst}])`);
  note('R2 ' + label + ': in the gap', { page: gap.page, pendingCount: gap.pendingCount,
    hubPending: gap.hubPending, leaveOk: gap.leaveOk, leaveAsked: gap.leaveAsked,
    saidSoFar: gap.saidSoFar });
  note('R2 ' + label + ': the share right after this window\'s own flush', gap.shareInsideGap);
  const end = (diskJson(G.root, 'reco/recoTemplates.json') || []).find(t => t && t.id === 'TPL_G') || {};
  note('R2 ' + label + ': the share at the end',
    { order: end.displayOrder || null, by: end.displayOrderBy || null, desc: end.description || null });
  check(same(gap.shareInsideGap, ['Note','Amount','Invoice']),
    'R2a [' + label + '] the colleague\'s team column order is STILL on the shared folder after '
    + 'this window\'s own flush went out inside the gap. From the swap until the folder answers, '
    + 'AppState.recoTemplates holds the editor\'s UN-MERGED clone, and any write of that key '
    + 'publishes it — reverting the column order of every CSV and every workbook this template '
    + 'exports, for everyone, with nothing said',
    gap.shareInsideGap);
  check(same(end.displayOrder, ['Note','Amount','Invoice']),
    'R2b [' + label + '] ...and it survives to the end of the save, because the merge kept it',
    { order: end.displayOrder || null, by: end.displayOrderBy || null });
  check(end.description === 'B was here',
    'R2c [' + label + '] CONTROL: B\'s own edit is on the share too — the hold defers the write, '
    + 'it does not drop it', end.description);
  check(gap.pendingCount > 0 && gap.hubPending > 0,
    'R2d [' + label + '] both leave guards KNOW a template write is owed while the folder is '
    + 'being asked. The editor has closed and the screen has gone home, so "nothing is owed" is '
    + 'the one answer that loses the edit silently',
    { pendingCount: gap.pendingCount, hubPending: gap.hubPending });
  check(gap.leaveAsked === true,
    'R2e [' + label + '] ...so App._pendingLeaveOk() ASKS instead of waving the operator out. '
    + '(It returns true here because this fixture answers yes to every confirm; what is measured '
    + 'is that the question was put at all.)',
    { leaveOk: gap.leaveOk, leaveAsked: gap.leaveAsked });
  await pb.ctx.close(); await pc.ctx.close();
}

/* R3. After the key-definition refusal the window has been told, in so many
   words, that it is now correct: "this window now carries their key and your
   change can go on top of it." Its LOADED ROWS still carry keys the folder's
   rule no longer computes, so everything typed afterwards goes to the share
   under a dead key — invisible to every colleague and gone from this
   operator's own screen at the next reload. */
const R3_TYPE_AFTER = `(async function () {
  window.__toasts = [];
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_X');
  const sess = AppState.recoSessions.TPL_X;
  const before = JSON.parse(JSON.stringify((AppState.extraValueMaster||{}).TPL_X || {}));
  Reco.setTag(sess.data[0]._id, 'Vendor', 'typed-after-the-refusal', null);
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  await new Promise(r => setTimeout(r, 250));
  if (typeof Store.idle === 'function') await Store.idle();
  return { said: (window.__toasts||[]).map(x=>x.kind+': '+x.msg),
           pkOnScreen: sess.data[0]._pk,
           keyRuleNow: (tpl.additionalColumns||[]).find(a=>a.name==='Ref').formula,
           before: Object.keys(before),
           mem: JSON.parse(JSON.stringify((AppState.extraValueMaster||{}).TPL_X || {})) };
})`;

/* ...and after a RELOAD the same typing must work normally, under the
   folder's own rule. */
const R3_RELOAD_AND_TYPE = `(async function () {
  window.__toasts = [];
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_X');
  RecoTemplate.open(tpl.id);
  await Reco.ingestData(tpl, [{Doc:'D1',Line:'L1',Amount:'100'}], ['Doc','Line','Amount']);
  App.closeModal();
  const sess = AppState.recoSessions.TPL_X;
  const row = sess.data[sess.data.length - 1];
  Reco.setTag(row._id, 'Vendor', 'typed-after-a-reload', null);
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  await new Promise(r => setTimeout(r, 250));
  if (typeof Store.idle === 'function') await Store.idle();
  return { said: (window.__toasts||[]).map(x=>x.kind+': '+x.msg), pk: row._pk };
})`;

section(71, 'R3  T-24R2-1 — THE KEY REFUSAL MUST NOT LEAVE THIS WINDOW TYPING UNDER A DEAD KEY');
{
  const K = makeRoot('share-r3');
  const brK = await startBridge(K.root, PORT_R3); procs.push(brK.proc);
  const pa = await openReco(browser, brK);
  await pa.page.evaluate(R1_SETUP + '()');
  const pb = await openReco(browser, brK);
  /* B HAS THE ROWS OPEN, keyed by the rule that is about to go. That is the
     whole finding: the refusal puts the TEMPLATE back and leaves these. */
  const bOpen = await pb.page.evaluate(`(async function () {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_X');
    RecoTemplate.open(tpl.id);
    AppState.activeRecoId = 'TPL_X';
    const s = AppState.recoSessions.TPL_X;
    return ((s && s.data) || []).map(r => r._pk);
  })()`);
  check(same(bOpen, ['D1','D2','D3']),
    'R3 premise: B has the three rows loaded, keyed under the rule the folder is about to change',
    bOpen);
  await pa.page.evaluate(R1_A_KEY + '()');
  const refused = await pb.page.evaluate(R1_B_REMOVE + '([true])');
  check(refused.toasts.some(s => /Nothing was saved/.test(s)),
    'R3 premise: B\'s save was refused for the key definition', refused.toasts);
  check(refused.toasts.some(s => /reload|Press Load|load the rows again/i.test(s)),
    'R3a the refusal SAYS that the rows on screen are keyed by the old rule and have to be '
    + 'loaded again. "Close the editor and open it again" is only true of the TEMPLATE; the '
    + 'loaded data is the half that is still wrong', refused.toasts);

  const typed = await pb.page.evaluate(R3_TYPE_AFTER + '()');
  note('R3 what the window said when it typed after the refusal', typed.said);
  note('R3 the key on screen / the folder\'s rule', [typed.pkOnScreen, typed.keyRuleNow]);
  const share = diskJson(K.root, 'reco/extraValueMaster.json') || {};
  const keys = Object.keys(share.TPL_X || {});
  note('R3 the shared values file', keys);
  check(typed.said.some(s => /error/.test(s) && /row key|identifies its rows|Press Load/i.test(s)),
    'R3b typing into an added column after that refusal is REFUSED with a sentence. Letting it '
    + 'through writes the share under a key the folder\'s rule no longer computes — the operator '
    + 'reads their own value back fine and no colleague ever sees it',
    typed.said);
  const d1 = String((((share.TPL_X || {})['D1'] || {}).Vendor || {}).v || '');
  note('R3 what the dead key holds on the share', d1);
  check(d1 === 'Acme',
    'R3c (THE VALUE) ...and nothing new reached the shared folder under the dead key: it still '
    + 'holds what was typed while the keys were right', d1);

  const again = await pb.page.evaluate(R3_RELOAD_AND_TYPE + '()');
  const share2 = diskJson(K.root, 'reco/extraValueMaster.json') || {};
  note('R3 after a reload: the key and the file', [again.pk, Object.keys(share2.TPL_X || {})]);
  check(again.pk === 'D1-X',
    'R3d CONTROL: a reload re-mints the keys under the FOLDER\'S rule', again.pk);
  check(String((((share2.TPL_X || {})['D1-X'] || {}).Vendor || {}).v) === 'typed-after-a-reload',
    'R3e CONTROL: ...and typing works normally again, under that key. The refusal is a latch, not '
    + 'a dead end',
    (share2.TPL_X || {})['D1-X']);
  check(!again.said.some(s => /error/.test(s)),
    'R3f CONTROL: ...with nothing said, because there is nothing wrong any more', again.said);
  await pa.ctx.close(); await pb.ctx.close();
}

/* ---- T-S10-16. A4's LATCH GUARDED THREE DOORS, AND THERE ARE FIVE. -----
   Reco._keyStaleBlock was consulted by setTag, setOverride and
   revertOverride. It was NOT consulted by applyCorrection
   (correctionMaster[id][pk][col]), manualOffset / unmarkOffset
   (manualOffsetMaster[id][pk]) or editCell (the version row Versioning writes
   into the day file) - and `pk` in every one of them is Reco.rowKey(tpl, row),
   i.e. the row's FROZEN _pk: exactly the key the refusal has just
   invalidated. Both masters are in AppState.PERSIST_KEYS, so the write is a
   whole-file blind write of a shared file every colleague parses at boot.

   MEASURED on the tree before the fix — scratchpad/dataloss/close/
   repro_before.txt, port 21340, straight after the T-24R2-1 refusal with
   Reco._keyStale.TPL_X === true and the folder's rule computing `D<n>-X`:

     setTag           error, the latch's sentence       nothing
     setOverride      error, "Nothing was overridden"   nothing
     revertOverride   error, "Nothing was reverted"     nothing
     applyCorrection  success: "Correction applied"     correctionMaster.json <- D2
     manualOffset     NOTHING AT ALL                    manualOffsetMaster.json <- D3
     unmarkOffset     success: "Unmarked 1 row(s)"      D5's record DELETED under the dead key
     editCell         NOTHING AT ALL                    day-file version row <- D4

   Two of those three green-or-silent doors say something that is not true and
   the other two say nothing at all, which is the A4 harm in the doors A4's
   fix did not name. The decision taken here is the per-ACTION latch rather
   than a rule inside Reco.rowKey: that function is called by the renderer,
   the status filters, runAutoOffset's restore, the drift badge and the
   machine paths (the Excel load-back and ingestData), none of which has an
   operator at the keyboard to press Load — see handover 18.8. */

/* D1 is offset while the keys on screen are STILL the folder's own, so the
   unmark door has a record of its own to fail to reach afterwards. */
const R3_OFFSET_BEFORE = `(async function () {
  window.__toasts = [];
  const sess = AppState.recoSessions.TPL_X;
  Reco.manualOffset(0, null, sess.data[0]._id);
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return { offsets: Object.keys((AppState.manualOffsetMaster||{}).TPL_X || {}),
           said: (window.__toasts||[]).map(x=>x.kind+': '+x.msg),
           folder: (AppState.recoTemplates.find(x=>x.id==='TPL_X')||{}).dataFolder || '' };
})`;

/* B saves an ORDINARY field and is refused for the colleague's key change. */
const R3_B_REFUSED = `(async function () {
  window.__toasts = [];
  const real = window.confirm; window.confirm = () => true;
  try {
    RecoTemplate.edit('TPL_X');
    RecoTemplate._editing.description = 'B was here';
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch(e){} }
  } finally { window.confirm = real; }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return { toasts: (window.__toasts||[]).map(x=>x.kind+': '+x.msg),
           stale: !!(Reco._keyStale||{}).TPL_X };
})`;

/* THE FOUR UNGUARDED DOORS, each on a row of its own so no door can erase
   another's write, plus the SAME offset action from the selection toolbar -
   which is not one of the function names the ticket lists, and is why this
   fix is a rule about an action rather than a list of functions. */
const R3_DOORS = `(async function () {
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_X');
  const sess = AppState.recoSessions.TPL_X;
  const out = { doors: {} };
  const grab = () => (window.__toasts||[]).map(x=>x.kind+': '+x.msg);
  const door = (name, fn) => {
    window.__toasts = [];
    let threw = null;
    try { fn(); } catch (e) { threw = String(e).slice(0, 160); }
    out.doors[name] = { said: grab(), threw: threw,
      offsets: Object.keys((AppState.manualOffsetMaster||{}).TPL_X || {}),
      corrections: Object.keys((AppState.correctionMaster||{}).TPL_X || {}) };
  };
  door('applyCorrection', () => Reco.applyCorrection(0, 'Amount', '999', null, sess.data[1]._id));
  door('manualOffset',    () => Reco.manualOffset(0, null, sess.data[2]._id));
  door('unmarkOffset',    () => Reco.unmarkOffset(0, null, sess.data[0]._id));
  door('editCell',        () => Reco.editCell(0, 'Line', 'L-after', null, sess.data[2]._id));
  sess.selectedRows = {}; sess.selectedRows[sess.data[1]._id] = true;
  door('offsetSelected',  () => Reco.offsetSelected(null));
  sess.selectedRows = {};
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  await new Promise(r => setTimeout(r, 300));
  if (typeof Store.idle === 'function') await Store.idle();
  return Object.assign(out, {
    pkOnScreen: (sess.data||[]).map(r => r._pk),
    keyRuleNow: (tpl.additionalColumns||[]).find(a=>a.name==='Ref').formula });
})`;

/* THE CONTROL. After a reload both doors work normally and write under the
   FOLDER'S own key. A latch that never lifts is a worse bug than the one it
   fixes. */
const R3_RELOAD_BOTH = `(async function () {
  window.__toasts = [];
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_X');
  RecoTemplate.open(tpl.id);
  await Reco.ingestData(tpl, [{Doc:'D7',Line:'L1',Amount:'700'},{Doc:'D8',Line:'L1',Amount:'800'}],
                        ['Doc','Line','Amount']);
  App.closeModal();
  const sess = AppState.recoSessions.TPL_X;
  const r7 = sess.data[sess.data.length - 2], r8 = sess.data[sess.data.length - 1];
  Reco.applyCorrection(0, 'Amount', '777', null, r7._id);
  Reco.manualOffset(0, null, r8._id);
  Reco.editCell(0, 'Line', 'L-reload', null, r8._id);
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  await new Promise(r => setTimeout(r, 300));
  if (typeof Store.idle === 'function') await Store.idle();
  return { said: (window.__toasts||[]).map(x=>x.kind+': '+x.msg), pks: [r7._pk, r8._pk],
           stale: !!(Reco._keyStale||{}).TPL_X };
})`;

{
  const KD2 = makeRoot('share-r3-doors');
  const brKD2 = await startBridge(KD2.root, PORT_R3D); procs.push(brKD2.proc);
  const pda = await openReco(browser, brKD2);
  await pda.page.evaluate(R1_SETUP + '()');
  const pdb = await openReco(browser, brKD2);
  const dOpen = await pdb.page.evaluate(`(async function () {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_X');
    RecoTemplate.open(tpl.id); AppState.activeRecoId = 'TPL_X';
    return ((AppState.recoSessions.TPL_X||{}).data||[]).map(r => r._pk);
  })()`);
  const pre = await pdb.page.evaluate(R3_OFFSET_BEFORE + '()');
  note('R3 the keys B has loaded / the offset it files while they are right',
    [dOpen, pre.offsets, pre.said]);
  check(same(dOpen, ['D1','D2','D3']) && same(pre.offsets, ['D1']),
    'R3g premise, AND THE FIXTURE HOLE IS CLOSED: B has the three rows loaded under the rule the '
    + 'folder is about to change, and a single-row offset really is REACHABLE on this template. '
    + 'T-S10-16 could only predict this door\'s behaviour because the fixture had no tolerance and '
    + 'every offset was refused before the write',
    { pks: dOpen, offsets: pre.offsets });

  await pda.page.evaluate(R1_A_KEY + '()');
  const dRef = await pdb.page.evaluate(R3_B_REFUSED + '()');
  check(dRef.toasts.some(s => /Nothing was saved/.test(s)) && dRef.stale === true,
    'R3h premise: B\'s save was refused for the key definition and the latch is on', dRef);

  const dd = await pdb.page.evaluate(R3_DOORS + '()');
  note('R3 the keys on screen / the rule the folder now computes', [dd.pkOnScreen, dd.keyRuleNow]);
  for (const k of ['applyCorrection','manualOffset','unmarkOffset','editCell','offsetSelected'])
    note('R3 ' + k, dd.doors[k]);
  const offF = (diskJson(KD2.root, 'reco/manualOffsetMaster.json') || {}).TPL_X || {};
  const corrF = (diskJson(KD2.root, 'reco/correctionMaster.json') || {}).TPL_X || {};
  const dayF = csvRows(verFile(KD2.root, pre.folder || 'Abandon'));
  const deadKeys = ['D1','D2','D3'];
  note('R3 SHARE reco/manualOffsetMaster.json', Object.keys(offF));
  note('R3 SHARE reco/correctionMaster.json', Object.keys(corrF));
  note('R3 the day file rows carrying the file-cell edit',
    dayF.filter(r => /L-after/.test(JSON.stringify(r))).map(r => r._pk));

  const say = k => (dd.doors[k].said || []).join(' | ');
  const latched = k => /identifies its rows/.test(say(k)) && /error/.test(say(k));
  check(latched('applyCorrection') && /Nothing was corrected/.test(say('applyCorrection')),
    'R3i the CORRECTION door is refused with a sentence naming the row key, in its own words '
    + '("corrected"). It said a green "Correction applied" and filed the correction under a key '
    + 'the folder\'s rule no longer computes', dd.doors.applyCorrection.said);
  check(Object.keys(corrF).filter(k => deadKeys.includes(k)).length === 0,
    'R3j (THE FILE) reco/correctionMaster.json holds NOTHING under the dead key. That file is '
    + 'read by every colleague at boot and written whole, so a correction filed under a key the '
    + 'folder cannot compute is both invisible and a permanent passenger',
    Object.keys(corrF));
  check(latched('manualOffset') && /Nothing was offset/.test(say('manualOffset')),
    'R3k the OFFSET door is refused, in its own words ("offset") - MEASURED on this fixture now '
    + 'that a single-row offset is reachable, not inferred from the correction door. It wrote '
    + 'manualOffsetMaster under the dead key and said nothing at all',
    dd.doors.manualOffset.said);
  check(Object.keys(offF).filter(k => deadKeys.includes(k) && k !== 'D1').length === 0,
    'R3l (THE FILE) reco/manualOffsetMaster.json holds nothing new under a dead key',
    Object.keys(offF));
  check(latched('unmarkOffset') && /Nothing was unmarked/.test(say('unmarkOffset')),
    'R3m the UNMARK door is refused, in its own words ("unmarked"). It said a green "Unmarked 1 '
    + 'row(s)" about a delete that cannot reach the record the folder would read',
    dd.doors.unmarkOffset.said);
  check(!!offF.D1,
    'R3n (THE FILE) ...and D1\'s record - filed while the keys were still right - is STILL THERE. '
    + 'An unmark under a dead key deletes this window\'s copy and leaves the folder\'s, so the row '
    + 'comes back offset for everyone including this operator', Object.keys(offF));
  check(latched('editCell') && /Nothing was changed/.test(say('editCell')),
    'R3o the FILE-CELL door is refused, in its own words ("changed"). editCell writes the row\'s '
    + 'version row into the day file under the same frozen _pk, and said nothing at all',
    dd.doors.editCell.said);
  check(dayF.filter(r => /L-after/.test(JSON.stringify(r))).length === 0,
    'R3p (THE FILE) ...and no version row for that edit reached reco_data/<folder>/<MMM-YY>/'
    + '<DD>.csv under the dead key',
    dayF.map(r => r._pk));
  check(latched('offsetSelected') && /Nothing was offset/.test(say('offsetSelected')),
    'R3q the SAME offset action from the selection toolbar is refused too. The ticket names four '
    + 'function names; the offset action has four entry points (the row menu, the bulk toolbar, '
    + 'the selection sum bar and the Excel view), and a fix applied to a list of names rather than '
    + 'to the action is the mistake B4/B6 were about', dd.doors.offsetSelected.said);
  const verbs = ['applyCorrection','manualOffset','unmarkOffset','editCell']
    .map(k => (say(k).match(/Nothing was (\w+)/) || [])[1] || '?');
  check(new Set(verbs).size === 4,
    'R3r each door says what it did not do in its OWN verb - corrected / offset / unmarked / '
    + 'changed. A sentence that reads like another function\'s is how an operator learns to '
    + 'ignore it', verbs);

  const ctrl = await pdb.page.evaluate(R3_RELOAD_BOTH + '()');
  const offF2 = (diskJson(KD2.root, 'reco/manualOffsetMaster.json') || {}).TPL_X || {};
  const corrF2 = (diskJson(KD2.root, 'reco/correctionMaster.json') || {}).TPL_X || {};
  const dayF2 = csvRows(verFile(KD2.root, pre.folder || 'Abandon'));
  note('R3 CONTROL: the keys the reload minted / what was said', [ctrl.pks, ctrl.said, ctrl.stale]);
  note('R3 CONTROL: the two masters afterwards', [Object.keys(offF2), Object.keys(corrF2)]);
  check(same(ctrl.pks, ['D7-X','D8-X']) && ctrl.stale === false,
    'R3s CONTROL: a reload re-mints under the FOLDER\'S rule and lifts the latch', ctrl);
  check(!!(corrF2['D7-X'] || {}).Amount && !!offF2['D8-X'],
    'R3t CONTROL: ...and BOTH doors then work normally and write under the folder\'s own key. A '
    + 'latch that never lifts is a worse bug than the one it fixes',
    { corrections: Object.keys(corrF2), offsets: Object.keys(offF2) });
  check(dayF2.filter(r => /L-reload/.test(JSON.stringify(r))).map(r => r._pk).join('') === 'D8-X',
    'R3u CONTROL: ...and the file-cell edit\'s version row goes into the day file under that same '
    + 'key', dayF2.map(r => r._pk));
  check(!ctrl.said.some(s => /error/.test(s)),
    'R3v CONTROL: ...with nothing said, because there is nothing wrong any more', ctrl.said);
  await pda.ctx.close(); await pdb.ctx.close();
}

/* R4. _mergeShared's structural pass APPENDS a column the folder has that
   neither side saw. There is no mirror for the opposite case, so a column the
   FOLDER REMOVED is silently resurrected by any save from an older clone —
   the same class of silent revert T-S10-7 exists to stop, in the one
   direction the general merge does not cover. */
const R4_A_REMOVE = `(async function () {
  const real = window.confirm; window.confirm = () => true;
  try {
    RecoTemplate.edit('TPL_X');
    RecoTemplate._editing.additionalColumns =
      RecoTemplate._editing.additionalColumns.filter(a => a.name !== 'Vendor');
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch(e){} }
  } finally { window.confirm = real; }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  const t = AppState.recoTemplates.find(x=>x.id==='TPL_X') || {};
  return { extras: (t.additionalColumns||[]).map(a=>a.name) };
})`;

const R4_B_DESC = `(async function (arg) {
  const [answer] = arg;
  window.__toasts = [];
  const asks = []; const real = window.confirm;
  window.confirm = m => { asks.push(String(m)); return answer; };
  try {
    RecoTemplate.edit('TPL_X');
    RecoTemplate._editing.description = 'B was here';
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch(e){} }
  } finally { window.confirm = real; }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  const t = AppState.recoTemplates.find(x=>x.id==='TPL_X') || {};
  return { asks, toasts: (window.__toasts||[]).map(x=>x.kind+': '+x.msg),
           extras: (t.additionalColumns||[]).map(a=>a.name) };
})`;

/* And BOTH SIDES changing the same field: the editor winning is the SETTLED
   decision, the SILENCE is the finding. A changes the description AND the
   offset tolerance; the stale editor changes only the description. The
   tolerance is kept — that is the merge working, and it is what makes the
   question appear at all — so the question that names what it KEPT is also
   the place to name what it REPLACED. */
const R4_A_TWO = `(async function () {
  const real = window.confirm; window.confirm = () => true;
  try {
    RecoTemplate.edit('TPL_X');
    RecoTemplate._editing.description = 'A was here';
    RecoTemplate._editing.toleranceValue = 5;
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch(e){} }
  } finally { window.confirm = real; }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return true;
})`;

const R4_D_SAME_FIELD = `(async function () {
  window.__toasts = [];
  const asks = []; const real = window.confirm;
  window.confirm = m => { asks.push(String(m)); return true; };
  try {
    RecoTemplate.edit('TPL_X');
    RecoTemplate._editing.description = 'D was here';
    RecoTemplate.saveTemplate();
    if (RecoTemplate._flagGuard) { try { await RecoTemplate._flagGuard; } catch(e){} }
  } finally { window.confirm = real; }
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return { asks };
})`;

section(72, 'R4  T-S10-7 — THE MERGE\'S OTHER DIRECTION: A COLUMN THE FOLDER REMOVED');
{
  const M = makeRoot('share-r4');
  const brM = await startBridge(M.root, PORT_R4); procs.push(brM.proc);
  const pa = await openReco(browser, brM);
  await pa.page.evaluate(R1_SETUP + '()');
  const pb = await openReco(browser, brM);          // B boots BEFORE A's removal
  const ar = await pa.page.evaluate(R4_A_REMOVE + '()');
  const tplA = (diskJson(M.root, 'reco/recoTemplates.json') || []).find(t => t && t.id === 'TPL_X') || {};
  check(!(tplA.additionalColumns || []).map(a => a.name).includes('Vendor'),
    'R4 premise: A\'s removal of the added column is on the shared folder',
    (tplA.additionalColumns || []).map(a => a.name));

  const b = await pb.page.evaluate(R4_B_DESC + '([true])');
  note('R4 what B was asked', b.asks);
  const tplB = (diskJson(M.root, 'reco/recoTemplates.json') || []).find(t => t && t.id === 'TPL_X') || {};
  note('R4 the share after B\'s unrelated save', (tplB.additionalColumns || []).map(a => a.name));
  check(!(tplB.additionalColumns || []).map(a => a.name).includes('Vendor'),
    'R4a A\'s deliberate removal survives B\'s unrelated save. Resurrecting it reverts a '
    + 'colleague\'s decision for everyone, and it comes back BLANK because the record delete has '
    + 'already run — so operators learn that removing an added column "does not take"',
    (tplB.additionalColumns || []).map(a => a.name));
  check(b.asks.some(s => /somebody else removed|which somebody else removed/.test(s)),
    'R4b ...and B is TOLD, in the same question that names everything else the folder kept, so '
    + 'Cancel means what it already means', b.asks);
  check(tplB.description === 'B was here',
    'R4c CONTROL: B\'s own edit is still saved', tplB.description);
  await pb.ctx.close();

  const pd = await openReco(browser, brM);          // D's baseline: description 'B was here'
  await pa.page.evaluate(R4_A_TWO + '()');          // A changes the description AND the tolerance
  const c = await pd.page.evaluate(R4_D_SAME_FIELD + '()');
  note('R4 what the stale editor was asked when BOTH sides changed the description', c.asks);
  const tplC = (diskJson(M.root, 'reco/recoTemplates.json') || []).find(t => t && t.id === 'TPL_X') || {};
  note('R4 the share after it', { desc: tplC.description, tol: tplC.toleranceValue });
  check(tplC.description === 'D was here',
    'R4d premise (SETTLED): when both sides changed the same field the EDITOR wins',
    tplC.description);
  check(c.asks.some(s => /offset tolerance/.test(s)),
    'R4 premise: the question really was asked, because the folder\'s tolerance was kept',
    c.asks);
  check(c.asks.some(s => /both changed/.test(s)),
    'R4e ...and the confirm that names everything it KEPT also names what it REPLACED. The one '
    + 'person who could go and ask a colleague about it is the one person who does not know there '
    + 'was anything to ask', c.asks);
  await pa.ctx.close(); await pd.ctx.close();
}

/* R5. TWO WINDOWS OF RECO ON ONE PC — one localStorage origin, which is the
   configuration §18.7 limitation 3 describes and T-S10-11 exists because of.
   Store.journalPersist() writes Array.from(_jrnlMap().values()) with no
   re-read, and _jrnlMap() loads localStorage ONLY when _jrnlMem is null, so a
   window whose map is already live blind-overwrites the other window's owed
   values — the very thing Store.mergeWrite exists to stop, in the one file
   that is the second copy. */
const R5_WARMUP = `(async function () {
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R');
  const sess = AppState.recoSessions.TPL_R;
  await Reco.applyEdits(tpl, sess, [{ row: sess.data[2], col:'Vendor', value:'B-warmup' }],
                        { source:'grid', trusted:true });
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return { memExists: Store._jrnlMem !== null, mem: Store._jrnlMap().size,
           saved: Store._jrnlSaved, disk: Store._jrnlRead().length };
})`;

const R5_TYPE_DOWN_ONE = `(async function (arg) {
  const [idx, val] = arg;
  const realRead = window.pywebview.api.read_file;
  window.__fault = true;
  window.pywebview.api.read_file = function (rel) {
    if (window.__fault && /extraValue/.test(String(rel)))
      return Promise.reject(new Error('the shared folder did not answer'));
    return realRead.apply(this, arguments);
  };
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R');
  const sess = AppState.recoSessions.TPL_R;
  await Reco.applyEdits(tpl, sess, [{ row: sess.data[idx], col:'Vendor', value:val }],
                        { source:'grid', trusted:true });
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  await new Promise(r => setTimeout(r, 600));
  return { mem: Array.from(Store._jrnlMap().values()).map(x => x.pk + '/' + x.col),
           disk: Store._jrnlRead().map(x => x.pk + '/' + x.col + '=' + String((x.rec||{}).v)) };
})`;

const R5_PERSIST = `(function () {
  Store.journalPersist();
  return Store._jrnlRead().map(x => x.pk + '/' + x.col + '=' + String((x.rec||{}).v));
})`;

const R5_HEAL = `(function () { window.__fault = false; return true; })`;

section(73, 'R5  T-S10-9 — TWO WINDOWS ON ONE PC MUST NOT BLIND-OVERWRITE EACH OTHER\'S JOURNAL');
{
  const J = makeRoot('share-r5');
  const brJ = await startBridge(J.root, PORT_R5); procs.push(brJ.proc);
  /* ONE browser context = ONE PC's localStorage origin. Two pages in it are
     the two windows of the app the team is known to run. */
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(brJ.shim);
  const mk = async () => {
    const page = await ctx.newPage();
    page.on('dialog', d => d.accept());
    await page.goto(brJ.url + '/apps/Reco.html');
    await page.waitForSelector('#appMain .panel', { timeout: 30000 });
    await page.evaluate(() => {
      window.__toasts = [];
      const real = U.toast;
      U.toast = function (m, k) { window.__toasts.push({ msg: String(m), kind: k || '' }); return real.apply(U, arguments); };
    });
    return page;
  };
  const pageA = await mk();
  await pageA.evaluate(S109_SETUP + '()');
  const pageB = await mk();
  await pageB.evaluate(`(async function () {
    const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R');
    RecoTemplate.open(tpl.id);
    AppState.activeRecoId = 'TPL_R';
    return (AppState.recoSessions.TPL_R.data||[]).length;
  })()`);
  const warm = await pageB.evaluate(R5_WARMUP + '()');
  note('R5 window B after one ordinary edit on a healthy folder', warm);
  check(warm.memExists && warm.mem === 0 && warm.disk === 0,
    'R5 premise: B\'s journal map is LIVE and empty, and localStorage is untouched — the happy '
    + 'path', warm);

  const a = await pageA.evaluate(R5_TYPE_DOWN_ONE + `([0,'A-typed-this'])`);
  note('R5 window A typed INV-1 while the folder was down', a.disk);
  check(a.disk.length === 1, 'R5 premise: A\'s owed value is on this PC\'s journal', a.disk);
  const b = await pageB.evaluate(R5_TYPE_DOWN_ONE + `([1,'B-typed-this'])`);
  note('R5 window B typed INV-2; the journal on this PC now', b.disk);
  const pa = await pageA.evaluate(R5_PERSIST + '()');
  const pb2 = await pageB.evaluate(R5_PERSIST + '()');
  note('R5 after A\'s exit persist / after B\'s exit persist', [pa, pb2]);
  check(b.disk.length === 2,
    'R5a (THE BLOCKER) the journal on this PC holds BOTH windows\' owed values. journalPersist() '
    + 'writes one window\'s whole in-memory Map with no re-read, so without a merge the second '
    + 'window\'s persist destroys the first\'s — and the per-cell guard that is meant to make two '
    + 'windows safe runs at REPLAY, long after the loss', b.disk);
  check(pb2.length === 2,
    'R5b ...and it still holds both after each window has persisted on its way out (pagehide, the '
    + 'beforeunload guard and the hub leave gate all do this)', pb2);

  await pageA.evaluate(R5_HEAL + '()');
  await pageB.evaluate(R5_HEAL + '()');
  await pageA.close(); await pageB.close();
  const pageC = await mk();
  const boot = await pageC.evaluate(S109_AFTER_BOOT + '()');
  note('R5 the boot after both windows closed', boot.replay);
  const shareJ = (diskJson(J.root, 'reco/extraValueMaster.json') || {}).TPL_R || {};
  const got = ['INV-1','INV-2'].map(pk => pk + '=' + String(((shareJ[pk] || {}).Vendor || {}).v));
  note('R5 THE SHARED FOLDER', got);
  check(boot.replay && boot.replay.pending === 2,
    'R5c the boot offers BOTH values back', boot.replay && boot.replay.pending);
  check(same(got, ['INV-1=A-typed-this', 'INV-2=B-typed-this']),
    'R5d (THE MONEY, ON THE SHARE) both typed values are on the shared folder after the replay. A '
    + 'value missing here was typed, accepted, journalled, promised back by the leave gate — and '
    + 'lost with nothing said', got);
  await ctx.close();
}

/* R6. The replay DELETES the journal of the folder it refuses to replay into.
   journalClear() takes no argument and spares nothing, and the `discarded`
   toast is below the early return, so the all-other-folder case is silent. */
const R6_REBASE = `(function (arg) {
  const [howMany] = arg;
  const OLD = '//fileserver/Finance/RecoShare_OLD';
  const list = Store._jrnlRead();
  list.forEach((x, i) => { if (i < howMany) x.base = OLD; });
  Store._jrnlWrite(list);
  /* AND IN MEMORY. page.reload() fires pagehide, which calls journalPersist()
     - so without this the live map's original stamps are written straight
       back over the rebase and the fixture measures nothing. */
  const mem = Store._jrnlMap();
  let i = 0;
  mem.forEach(v => { if (i++ < howMany) v.base = OLD; });
  return { disk: Store._jrnlRead().map(x => x.pk + ' base=' + String(x.base).slice(-28)),
           base: String(Store._jrnlBase || '').slice(-28) };
})`;

section(74, 'R6  T-S10-9 — THE REPLAY MUST NOT DELETE THE JOURNAL IT REFUSES TO REPLAY');
for (const [label, port, howMany] of [['all four belong to the old folder', PORT_R6A, 4],
                                      ['one of four belongs to the old folder', PORT_R6B, 1]]) {
  const O = makeRoot('share-r6-' + port);
  const brO = await startBridge(O.root, port); procs.push(brO.proc);
  const po = await openReco(browser, brO);
  await po.page.evaluate(S109_SETUP + '()');
  const down = await po.page.evaluate(S109_TYPE_DOWN + `([[[0,'Acme'],[1,'Bosch'],[2,'Cummins'],[3,'Denso']]])`);
  check(down.journal.length === 4,
    'R6 [' + label + '] premise: four intents are on this PC', down.journal.length);
  const reb = await po.page.evaluate(R6_REBASE + `([${howMany}])`);
  note('R6 [' + label + '] the journal\'s base stamps / this PC\'s folder', reb);
  /* The boot's own toasts, hooked BEFORE the boot runs — openReco installs its
     hook after the page has booted, so a boot-time sentence is not in
     __toasts and "nothing was said" could not otherwise be measured. */
  await po.ctx.addInitScript(`window.__bootToasts = [];
    (function () {
      const iv = setInterval(() => {
        if (typeof U !== 'undefined' && U.toast && !U.__bootHooked) {
          U.__bootHooked = true;
          const r = U.toast;
          U.toast = function (m, k) { window.__bootToasts.push((k || '') + ': ' + String(m)); return r.apply(U, arguments); };
          clearInterval(iv);
        }
      }, 1);
    })();`);
  await po.page.reload();
  await po.page.waitForSelector('#appMain .panel', { timeout: 30000 });
  const boot = await po.page.evaluate(S109_AFTER_BOOT + '()');
  const said = await po.page.evaluate(`(window.__bootToasts || []).slice()`);
  note('R6 [' + label + '] what the boot made of it', boot.replay);
  note('R6 [' + label + '] the journal on this PC AFTER the boot', boot.journal);
  const kept = boot.journal.length;
  check(kept === howMany,
    'R6a [' + label + '] the entries typed against the OTHER folder are STILL on this PC. The '
    + 'journal is the only copy — the store keeps one truth per cell — so a boot that deliberately '
    + 'wrote nothing anywhere must not be what destroys them',
    { kept: boot.journal, expected: howMany });
  check((boot.replay.discarded || []).length === howMany,
    'R6b [' + label + '] premise: the boot DID recognise them as the other folder\'s',
    boot.replay.discarded);
  note('R6 [' + label + '] every toast the boot said', said);
  check(said.some(s => /DIFFERENT shared folder/.test(s)),
    'R6c [' + label + '] the operator is TOLD about the entries that were not replayed here. '
    + '\u00a718.5 says such a journal is "discarded AND NAMED rather than replayed into this one"; '
    + 'with all of them belonging elsewhere the `discarded` toast sat below an early return and '
    + 'nothing was said at all', said);
  const shareO = (diskJson(O.root, 'reco/extraValueMaster.json') || {}).TPL_R || {};
  const landed = Object.keys(shareO).filter(pk => ((shareO[pk] || {}).Vendor || {}).v);
  note('R6 [' + label + '] what landed on THIS folder', landed);
  check(landed.length === 4 - howMany,
    'R6d [' + label + '] ...and exactly the entries that DO belong here were replayed onto this '
    + 'folder', landed);
  await po.ctx.close();
}

/* R7. THE PERFORMANCE GATE, AS AN OPERATION COUNT (§16.4a). journalDone(id)
   walked the whole Map once per intent with no early exit, synchronously
   inside Store._mergeJob's queued write job — so a 50,000-cell fill-down went
   from ~0.95 s to 20-30 s with the window frozen, and the per-path queue for
   the shared values file held for all of it by a loop doing no I/O.
   A wall clock cannot gate that (§16.4a); the number of full scans can. */
const R7_COUNT = `(async function (arg) {
  const [n] = arg;
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R');
  const map = Store._jrnlMap();
  let scans = 0;
  const realFE = Map.prototype.forEach;
  map.forEach = function () { scans++; return realFE.apply(this, arguments); };
  const ids = [];
  for (let i = 0; i < n; i++)
    ids.push(Store.journalIntent('TPL_R', 'reco/extraValueMaster.json',
      { pk: 'K' + i, col: 'Vendor', rec: { k:'typed', v:'v'+i, at: new Date().toISOString() } }));
  const sizeBefore = map.size;
  const scansAfterIntents = scans;
  ids.forEach(id => { if (id) Store.journalDone(id); });
  const out = { n: n, sizeBefore: sizeBefore, left: map.size,
                scansDuringIntents: scansAfterIntents,
                scansDuringClear: scans - scansAfterIntents };
  delete map.forEach;
  Store.journalClear();
  return out;
})`;

section(75, 'R7  T-S10-9 — CLEARING THE JOURNAL IS AN OPERATION COUNT, NOT A WALL CLOCK');
{
  const Q = makeRoot('share-r7');
  const brQ = await startBridge(Q.root, PORT_R7); procs.push(brQ.proc);
  const pq = await openReco(browser, brQ);
  await pq.page.evaluate(S109_SETUP + '()');
  for (const n of [1000, 20000]) {
    const r = await pq.page.evaluate(R7_COUNT + `([${n}])`);
    note('R7 journal of ' + n + ' cells', r);
    check(r.sizeBefore === n && r.left === 0,
      'R7 premise [' + n + ']: ' + n + ' intents were journalled and the clear loop emptied the map',
      r);
    check(r.scansDuringClear === 0,
      'R7a [' + n + '] the clear loop Store._mergeJob runs on every write that lands performs '
      + 'ZERO full scans of the journal map. A scan per intent is O(n squared) and it is '
      + 'SYNCHRONOUS inside the queued write job: the window is frozen for the whole of it and the '
      + 'per-path queue for reco/extraValueMaster.json is held by a loop doing no I/O. §18.5 says '
      + 'the owed set was put in a Map precisely to stop the first build\'s quadratic — this is '
      + 'the same quadratic, moved',
      { n: n, scans: r.scansDuringClear });
  }
  await pq.ctx.close();
}

/* R8. setTag is the grid's own onchange for EVERY added column, so it is the
   door most of this round's typing goes through. At a row that has gone it
   wrote the value into the LEGACY sess.manualTags under the dead _id — the
   exact store the whole S10 migration was built to escape, keyed on an id
   U.uid() mints fresh on every load — and AppState.save() put it on the
   shared folder. So of the writers still not speaking, this is the one where
   the edit is LOST rather than merely dropped. */
const R8_GONE = `(async function (arg) {
  const [what] = arg;
  window.__toasts = [];
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R');
  const sess = AppState.recoSessions.TPL_R;
  const row = sess.data[0];
  const goneId = row._id, gonePk = row._pk;
  sess.data = sess.data.slice(1);                 // a reload / restore / load-back / switch
  if (what === 'setTag') Reco.setTag(goneId, 'Vendor', 'typed into thin air', null);
  if (what === 'setOverride') Reco.setOverride(goneId, 'Net', '777.77', null);
  if (what === 'revertOverride') Reco.revertOverride(goneId, 'Net', null);
  if (what === 'confirmCarried') Reco.confirmCarried(goneId, 'Vendor', null);
  if (what === 'singleUse') Reco.ssToggleRowSingleUse(goneId);
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  await new Promise(r => setTimeout(r, 250));
  if (typeof Store.idle === 'function') await Store.idle();
  return { said: (window.__toasts||[]).map(x=>x.kind+': '+x.msg),
           manualTags: JSON.parse(JSON.stringify(sess.manualTags || {})),
           store: (((AppState.extraValueMaster||{}).TPL_R||{})[gonePk]) || null };
})`;

const R8_CONTROL = `(async function () {
  window.__toasts = [];
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R');
  const sess = AppState.recoSessions.TPL_R;
  const row = sess.data[0];
  Reco.setTag(row._id, 'Vendor', 'typed on a row that IS there', null);
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return { said: (window.__toasts||[]).map(x=>x.kind+': '+x.msg),
           manualTags: Object.keys(sess.manualTags || {}),
           store: String(((((AppState.extraValueMaster||{}).TPL_R||{})[row._pk]||{}).Vendor||{}).v) };
})`;

section(76, 'R8  T-F2-8 — setTag IS THE ADDED-COLUMN DOOR, AND A VANISHED ROW MUST NOT BE WRITTEN');
{
  const T = makeRoot('share-r8');
  const brT = await startBridge(T.root, PORT_R8); procs.push(brT.proc);
  const pt = await openReco(browser, brT);
  await pt.page.evaluate(S109_SETUP + '()');
  const g = await pt.page.evaluate(R8_GONE + `(['setTag'])`);
  note('R8 what setTag said', g.said);
  note('R8 sess.manualTags afterwards', g.manualTags);
  const sessFile = diskJson(T.root, 'reco/recoSessions.json') || {};
  const mtShare = ((sessFile.TPL_R || {}).manualTags) || {};
  note('R8 reco/recoSessions.json ON THE SHARED FOLDER, manualTags', mtShare);
  check(g.said.some(s => /no longer in this pane/.test(s)),
    'R8a setTag SAYS SO, with the sentence editCell and applyCorrection already use. It serves '
    + 'every ADDED column (the <select> and the <input> the grid renders), so it is the door most '
    + 'of this round\'s typing actually goes through', g.said);
  check(Object.keys(g.manualTags).length === 0,
    'R8b (THE VALUE) ...and it writes NOTHING. The legacy branch files the value under a dead '
    + '_id: the manualTags READ fallback is keyed on _id, so nobody will ever see it again, and '
    + 'it was never journalled either, so T-S10-9\'s replay cannot recover it',
    g.manualTags);
  check(Object.keys(mtShare).length === 0,
    'R8c ...and nothing about it reached reco/recoSessions.json on the shared folder, which is a '
    + 'whole-file write everyone on the folder loads', mtShare);
  const ctl = await pt.page.evaluate(R8_CONTROL + '()');
  note('R8 the control', ctl);
  check(ctl.store === 'typed on a row that IS there' && !ctl.said.length,
    'R8d CONTROL: the same call at a row that IS there still commits to the pk-keyed store and '
    + 'still says nothing. The hot path is untouched', ctl);
  await pt.ctx.close();
}

/* R9. The four row-level writers T-F2-8's Fix paragraph does not name, but
   its sentence does ("the same in its siblings"). setOverride is the SECOND
   of what Reco._extraValueFlush's own comment calls "the two doors an
   OPERATOR types through"; revertOverride is a DELETE that did not happen,
   which leaves the operator believing an override they wanted gone is gone. */
const R9_SETUP = `(async function () {
  const had = AppState.recoTemplates.find(x => x.id === 'TPL_R');
  if (had) {
    /* RE-ARMED, NOT RE-CREATED: four fresh rows under four distinct keys. A
       second ingest on top of the first gives every key a duplicate, and an
       override on a duplicated key is refused for a reason that has nothing
       to do with what this section measures. */
    RecoTemplate.open(had.id);
    const s0 = AppState.recoSessions.TPL_R;
    if (s0) { s0.data = []; s0.manualTags = {}; s0.selectedRows = {}; }
    await Reco.ingestData(had, [1,2,3,4].map(i => ({ Invoice:'INV-'+i, Amount:String(i*100) })),
                          ['Invoice','Amount']);
    App.closeModal();
    AppState.activeRecoId = 'TPL_R';
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    return (AppState.recoSessions.TPL_R.data||[]).map(r=>r._pk);
  }
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_R'; t.name = 'Siblings';
  t.columns = ['Invoice','Amount'].map(n => ({ name:n, label:n, formats:[], isValue:n==='Amount' }));
  t.primaryKeys = ['Invoice'];
  t.valueColumn = 'Amount';
  t.displayColumns = ['Invoice','Amount'];
  t.additionalColumns = [{ name:'Vendor', type:'custom', carryForward:true },
                         { name:'Net', type:'formula', formula:'{Amount}', allowOverride:true }];
  const real = window.confirm; window.confirm = () => true;
  try { RecoTemplate.saveTemplate(); } finally { window.confirm = real; }
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_R');
  RecoTemplate.open(tpl.id);
  await Reco.ingestData(tpl, [1,2,3,4].map(i => ({ Invoice:'INV-'+i, Amount:String(i*100) })),
                        ['Invoice','Amount']);
  App.closeModal();
  AppState.activeRecoId = 'TPL_R';
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return (AppState.recoSessions.TPL_R.data||[]).map(r=>r._pk);
})`;

section(77, 'R9  T-F2-8 — THE FOUR SIBLINGS THAT WERE NOT DONE');
{
  const S = makeRoot('share-r9');
  const brS = await startBridge(S.root, PORT_R9); procs.push(brS.proc);
  const ps = await openReco(browser, brS);
  await ps.page.evaluate(R9_SETUP + '()');
  const says = {};
  for (const what of ['setOverride', 'revertOverride', 'confirmCarried', 'singleUse']) {
    await ps.page.evaluate(R9_SETUP + '()');
    const r = await ps.page.evaluate(R8_GONE + `(['${what}'])`);
    says[what] = r.said;
    note('R9 ' + what, { said: r.said, store: r.store });
    check(r.said.some(s => /no longer in this pane/.test(s)),
      'R9 ' + what + ' says so when its row has gone. The number on screen goes back to what it '
      + 'was with no explanation, so the operator tries again or decides the feature is broken',
      r.said);
    check(!r.store,
      'R9 ' + what + ' premise: nothing reached the pk-keyed store under the gone row\'s key',
      r.store);
  }
  await ps.page.evaluate(R9_SETUP + '()');
  const ctl = await ps.page.evaluate(`(async function () {
    window.__toasts = [];
    const sess = AppState.recoSessions.TPL_R;
    const row = sess.data[0];
    const res = await Reco.setOverride(row._id, 'Net', '777.77', null);
    await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
    return { said: (window.__toasts||[]).map(x=>x.kind+': '+x.msg),
             rec: ((((AppState.extraValueMaster||{}).TPL_R||{})[row._pk]||{}).Net)||null };
  })()`);
  note('R9 the control', ctl);
  check(ctl.rec && ctl.rec.k === 'override' && !ctl.said.length,
    'R9e CONTROL: the same override on a row that IS there still commits silently', ctl);
  await ps.ctx.close();
}

/* R10. T-26-4's Fix asks the warning to name "the accounting reference of
   each". Past eight rows the banner named the count and not the rows, so
   deciding between "Leave them out" and "Post anyway" meant leaving the
   preview to look them up. The data is already in ctx.postedRows. */
/* R10's fixture. TWELVE rows, so the ten already-posted ones are past the
   banner's cap of eight. */
const R10_SETUP = `(async function (arg) {
  const [n] = arg;
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = 'TPL_P8'; t.name = 'Repost8';
  t.columns = ['Invoice','Base','Reco','ToAccount','Cur','Doc','Desc','Date','Account']
    .map(c => ({ name:c, label:c, formats:[], isValue:c==='Base' }));
  t.primaryKeys = ['Invoice'];
  t.valueColumn = 'Base'; t.docNumberColumn = 'Doc';
  t.displayColumns = t.columns.map(c => c.name);
  const aegTpl = AppState.aegTemplates[0];
  aegTpl.aggregate = false; aegTpl.aggregateBy = [];
  t.aegIntegration = { enabled:true, aegTemplateId: aegTpl.id,
    keywordColumn:'', keywordValues:'', postEntryColumn:'Desc', postEntryValue:'POSTED' };
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_P8');
  RecoTemplate.open(tpl.id);
  const F = ['Invoice','Base','Reco','ToAccount','Cur','Doc','Desc','Date','Account'];
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push({ Invoice:'INV-'+i, Base:String(i*100), Reco:'R1',
    ToAccount:'ACC1', Cur:'AED', Doc:'D'+i, Desc:'row '+i, Date:'01/01/26', Account:'ACC1' });
  await Reco.ingestData(tpl, rows, F);
  App.closeModal(); AppState.activeRecoId = 'TPL_P8';
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  return (AppState.recoSessions.TPL_P8.data||[]).length;
})`;

/* Post the first `n` rows in ONE entry, then reopen the day file from history
   — the state every colleague is in the next morning. */
const R10_POST = `(async function (arg) {
  const [n] = arg;
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_P8');
  const sess = AppState.recoSessions.TPL_P8;
  sess.selectedRows = {};
  sess.data.slice(0, n).forEach(r => { sess.selectedRows[r._id] = true; });
  Reco._pendingEntry = null;
  Reco.previewEntryFromSelection(false);
  if (!Reco._pendingEntry) return { refused: true };
  Reco.commitEntryFromPreview();
  App.closeModal();
  await AppState.flush(); if (typeof Store.idle === 'function') await Store.idle();
  const files = await Versioning.listFiles(tpl);
  const f = files[files.length - 1];
  await Reco.loadVersionedFile(f.fullPath || f.path, tpl.id);
  const hist = (AppState.entryHistory || {}).TPL_P8 || [];
  return { entries: hist.length, ref: (hist[hist.length-1]||{}).accountingId,
           state: AppState.recoSessions.TPL_P8.data
             .map(r => r._pk + '=' + (Reco.isRowPosted(tpl, AppState.recoSessions.TPL_P8, r) ? 'posted' : 'open')) };
})`;

/* Select the first `n` rows and preview. Reads the BANNER off the modal, which
   is what the operator has in front of them when they choose. */
const R10_PREVIEW = `(async function (arg) {
  const [n] = arg;
  const tpl = AppState.recoTemplates.find(x => x.id === 'TPL_P8');
  const sess = AppState.recoSessions.TPL_P8;
  sess.selectedRows = {};
  sess.data.slice(0, n).forEach(r => { sess.selectedRows[r._id] = true; });
  window.__toasts = [];
  Reco._pendingEntry = null;
  Reco.previewEntryFromSelection(false);
  const ctx = Reco._pendingEntry;
  /* The disclosure the fix may use has to be OPENED, the way the operator
     opens it — its text must be reachable, not hidden behind a click that
     reveals nothing. */
  document.querySelectorAll('#appModalBody details').forEach(d => { d.open = true; });
  return { opened: !!ctx,
           posted: ctx ? (ctx.postedRows || []).map(p => p.pk + ' \u2014 ' + p.ref) : [],
           banner: (document.getElementById('appModalBody') || {}).textContent || '',
           toasts: (window.__toasts||[]).map(t => t.kind + ': ' + t.msg) };
})`;

section(78, 'R10 T-26-4 — THE BANNER NAMES EVERY ALREADY-POSTED ROW, NOT THE FIRST EIGHT');
{
  const P = makeRoot('share-r10');
  const brP = await startBridge(P.root, PORT_R10); procs.push(brP.proc);
  const pp = await openReco(browser, brP);
  const made = await pp.page.evaluate(R10_SETUP + '([12])');
  note('R10 fixture rows', made);
  const post = await pp.page.evaluate(R10_POST + '([10])');
  note('R10 ten rows posted in one entry, then reloaded from history',
    { entries: post.entries, ref: post.ref });
  const prev = await pp.page.evaluate(R10_PREVIEW + '([11])');
  note('R10 posted rows the preview holds', prev.posted.length);
  const named = prev.posted.filter(p => prev.banner.indexOf(p) !== -1).length;
  note('R10 how many of them the banner names', named + ' of ' + prev.posted.length);
  check(prev.opened === true,
    'R10 premise: the preview still OPENS (the settled decision is warn-and-offer, never a '
    + 'refusal)', prev.opened);
  check(prev.posted.length === 10,
    'R10 premise: all ten already-posted rows are in Reco._pendingEntry.postedRows, each with its '
    + 'accounting reference', prev.posted.length);
  check(named === prev.posted.length,
    'R10a the banner NAMES every already-posted row with its reference, as the ticket\'s Fix asks '
    + '("the accounting reference of each"). Past eight the operator could see the count but not '
    + 'which rows — and which rows to leave out is the decision in front of them',
    { named: named, of: prev.posted.length, banner: prev.banner.slice(0, 300) });
  check(/Leave them out/.test(prev.banner) && /already posted/.test(prev.banner),
    'R10b CONTROL: both ways on are still offered beside it', prev.banner.slice(0, 160));
  await pp.ctx.close();
}

  const allErrors = [...oa.errors, ...ob.errors].filter(e => !/Could not save|injected fault/.test(e));
  check(allErrors.length === 0, 'U5 no page error across the whole run', allErrors.slice(0, 6));

} finally {
  await browser.close();
  for (const p of procs) { try { p.kill('SIGTERM'); } catch (e) {} }
}

console.log('\n' + (failures ? '✗ ' : '✓ ') + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
