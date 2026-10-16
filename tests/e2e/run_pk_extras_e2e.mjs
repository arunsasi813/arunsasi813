/* #24 — "added columns can also be used for primary key section".
 *
 *     node tests/e2e/run_pk_extras_e2e.mjs
 *
 * A primary-key component may now be an added column, but only one whose
 * value is a DETERMINISTIC FUNCTION of template columns: a formula over
 * template columns and earlier eligible extras, or a master_lookup into the
 * Accounts Master. The value is computed ONCE, when the data is loaded, and
 * frozen into row._pk; nothing recomputes it. Columns the user types into
 * (custom, dropdown) may not be key components, and the picker says why.
 *
 * The gates, in the order of how much they matter:
 *
 *   G1  THE MIGRATION IS A NO-OP, and that is the acceptance bar. For an
 *       existing template and session with a template-column key, every
 *       surface is byte-identical to the build before this change: the grid
 *       markup, the CSV an edit writes, the CSV export, a report, and the
 *       manual-offset and correction masters on the share. The baseline build
 *       (`git show <BASE_REV>:apps/Reco.html`) is served from its own temp
 *       share and diffed.
 *   G2  A key extra that depends on a NON-key extra DECLARED ABOVE IT mints
 *       the right _pk. Formula.substituteTokens turns a missing reference into
 *       '' silently, so a key built from an unmaterialised extra mints '-1',
 *       '-2'… — thousands of rows sharing one _pk, after which
 *       collapseToActive keeps one row per key and a 200k-row day file reopens
 *       as a few dozen rows. The row count after a reload is asserted for
 *       exactly that reason.
 *   G3  A two-component key with ONE EMPTY component is refused BEFORE
 *       appendUpload writes the day file. getRowPK joins with '||', so
 *       'INV-7||' is TRUTHY: the _auto_ fallback never runs and a whole day's
 *       history detaches silently. Asserted on the bridge call log, not on a
 *       modal: `Versioning.appendUpload(tpl, mapped).then(…)` has already
 *       fired before any modal could appear.
 *   G4  A keyless template's offset and correction write NOTHING to
 *       manualOffsetMaster or correctionMaster — read off the share, not out
 *       of memory. This is what breaks if a key reader ever returns row._pk
 *       before testing primaryKeys.length.
 *   G5  '#ERR' counted with '' and refused above the threshold.
 *   G6  Eligibility, with a reason the operator can act on: custom and
 *       dropdown refused; master_lookup on accounts allowed; docNumbers,
 *       corrections, custom:* and the legacy `master` each refused with their
 *       own reason.
 *   G7  The grammar whitelist, both directions: CONCAT({Doc},"-",Date.now())
 *       REFUSED and ROUND(AVERAGE({A},{B}),2) ALLOWED.
 *   G8  The displayed value does not diverge from the frozen key: after the
 *       accounts master changes under a loaded session the key cell still
 *       prints the frozen component, the "⚠ recalculated" marker appears, and
 *       the grid, the export, a report and the version file all agree.
 *   G9  tplSignature hashes a key extra's DEFINITION, and the
 *       definition-change confirm fires on a formula edit.
 *   G10 Untick and retick a key component: no confirm, primaryKeys
 *       byte-identical, canonical order held.
 *   G11 S11's role matrix refuses the same column as both a key component and
 *       the AEG post-entry column, in both editors and both directions.
 *   G12 The Excel "match by visible key" fallback is refused, by name, when
 *       any component is an extra.
 *   G13 Cost: the mint pass at 500,000 rows, best of 3 taking the MINIMUM
 *       (house practice after three knife-edge timing tests failed for
 *       machine contention, not regression), with the progress feedback
 *       asserted to have appeared.
 *   G14 Two panes: Panes.dupIdAudit() is {ok:true} on the template editor and
 *       on the grid. With no split the markup is byte-identical — G1's diff
 *       covers that.
 *
 * Round 2, after two reviewers read the build. Each of these FAILED on it:
 *
 *   G15 A MANY-TO-ONE derived key (an accounts lookup is many-to-one by
 *       construction) is refused BEFORE appendUpload, not told about 35 lines
 *       after it. 60 rows reopened as 3.
 *   G16 A two-component key with EVERY component blank mints the TRUTHY '||',
 *       so 25 bank lines collapsed onto one key. Counted and refused.
 *   G17 An unmatched DERIVED component is counted; a blank FILE column on a
 *       bank extract is still silent, because those rows keep their own uids.
 *   G18 '_auto_' is not a business key: rowKey and storeKey answer null, and
 *       nothing reaches manualOffsetMaster / correctionMaster / groupMaster /
 *       commentMaster on the share. data-pk goes back to ''.
 *   G19 A row typed in with + Row HAS a business key, so its offset,
 *       correction and group are recorded instead of silently dropped — and
 *       still writes nothing to the day file, because + Row is not
 *       + Persistent Row and four version writers are guarded by nothing but
 *       `if (row._pk)`.
 *   G20 The master refusal follows the key's DEPENDENCY CLOSURE — and an
 *       unrelated added column with an empty master refuses nothing.
 *   G21 A master_lookup key component may not match on a column the user
 *       types in, nor on one declared below it, nor on one that is not there.
 *   G22 The definition hash and the confirm follow the closure too, and the
 *       confirm names the column that actually moved.
 *   G23 The freeze is on the ONE choke point filters, slicers, sort and
 *       find-and-replace share.
 *   G24 A component whose value contains '||' is counted at ingest and marked
 *       in the grid — the marker could not fire on it before.
 *   G25 When the save drops a key component the confirm NAMES it and gives
 *       the reason.
 *   G26 S11 is gated in the AEG editor too, in both directions.
 *   G27 _pkEligible is memoised per call tree: a chain of 16 formula extras
 *       is milliseconds, not 3^16.
 *
 * Ports 20700-20719.
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
const PORT = 20701;
const PORT_BIG = 20702;
const PORT_BASE = 20703;
/* The build G1 compares against: HEAD, i.e. the build before this feature.
   Override with BASE_REV=<rev>.

   PINNED, AND IT MUST STAY PINNED. This defaulted to 'HEAD', which was the
   commit before #24 on the day the suite was written and silently stopped
   being so the moment #24 was committed: by the time #26 landed, the
   "baseline" build CONTAINED the change the gate exists to measure, so G1
   compared the build against itself and then failed on the one assertion that
   says the old build carries no override title. A byte-identity gate whose
   baseline moves with the branch tests nothing and then fails for the wrong
   reason. 3047f82 is the commit immediately before #24. */
const BASE_REV = process.env.BASE_REV || '3047f82';
const BIG = Number(process.env.PK_BIG || 500000);
/* G13's budget for the mint pass over BIG rows with three formula extras,
   best of three taking the minimum. Generous on purpose: this gate is here to
   catch an accidental per-row master scan or a per-row row copy, not to pin a
   machine. */
const MINT_BUDGET_MS = Number(process.env.PK_MINT_BUDGET_MS || 60000);

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
   That is how these assertions were shown to FAIL on the build before the fix
   each one guards (APP_REV=HEAD, before anything was written). */
const APP_REV = process.env.APP_REV || null;
if (APP_REV) console.log('APP_REV=' + APP_REV + ' — running against that build, not the working tree');

function makeRoot(name, fromRev) {
  fromRev = fromRev || APP_REV;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-pkx-'));
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
    'Reference,RC,Nominal,SubNominal,AnalysisKey,LOB\r\n'
    + 'V1,100,VEND-33,0,0,51\r\nV2,200,VEND-44,0,0,52\r\nV3,300,VEND-55,0,0,53\r\n');
  return { root };
}

async function startBridge(root, port) {
  const proc = spawn('python3', [path.join(HERE, 'bridge_server.py'), root, String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => {
    proc.stdout.on('data', d => { if (String(d).includes('READY')) res(); });
    proc.on('exit', c => rej(new Error('bridge exited ' + c)));
  });
  const shim = await (await fetch(`http://127.0.0.1:${port}/__shim.js`)).text();
  return { proc, shim, url: `http://127.0.0.1:${port}`, port, root };
}
const bridgeLog = async b => (await (await fetch(b.url + '/__log')).json()).calls;
const resetLog = async b => { await fetch(b.url + '/__reset_log', { method: 'POST' }); };

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
  /* Native dialogs are accepted by default so a setup save is not blocked;
     every assertion that cares about a confirm overrides window.confirm
     itself and reads __confirms, which is the only way to know WHAT was
     asked and to answer No. */
  page.on('dialog', d => d.accept());
  await page.goto(bridge.url + '/apps/' + (file || 'Reco.html'));
  await page.waitForSelector('#appMain .panel', { timeout: 20000 });
  await page.evaluate(() => {
    window.__toasts = [];
    const real = U.toast;
    U.toast = function (msg, kind) { window.__toasts.push({ msg: String(msg), kind: kind || '' }); return real.apply(U, arguments); };
    window.__dl = [];
    const rd = U.download;
    U.download = function (name, text, mime) { window.__dl.push({ name, text: String(text) }); return rd ? undefined : undefined; };
    /* Every confirm this run asks, and the answer we gave. window.confirm is
       what the app uses everywhere (there is no App.confirm), so this is the
       one hook. */
    window.__confirms = [];
    window.__confirmAnswer = true;
    window.confirm = function (msg) { window.__confirms.push(String(msg)); return window.__confirmAnswer; };
    /* G13 asserts the progress feedback appeared. Reco._busy is the one
       painter (it writes #recoBusyText / #recoBusyBar). */
    window.__busy = [];
    const rb = Reco._busy;
    Reco._busy = function (text, pct) { window.__busy.push({ text: String(text), pct }); return rb.apply(Reco, arguments); };
  });
  return { ctx, page, errors };
}
const readToasts = page => page.evaluate(() => (window.__toasts || []).slice());
const readConfirms = page => page.evaluate(() => (window.__confirms || []).slice());
const armConfirms = (page, answer) => page.evaluate(a => { window.__confirms = []; window.__confirmAnswer = a; }, answer);

/* ---------------------------------------------------------------------------
   ONE fixture builder, evaluated in both builds so nothing may differ but the
   build under it. It saves the template through RecoTemplate.saveTemplate, so
   the keyable-set filter is exercised rather than bypassed: on the build
   before this change a key extra is PRUNED here, which is what makes G2, G5,
   G6 and G8 fail for the right reason.
--------------------------------------------------------------------------- */
const SETUP = `(function (cfg) {
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = cfg.tplId;
  t.name = cfg.name || cfg.tplId;
  t.columns = (cfg.cols || []).map(n => ({
    name: n, label: n, formats: (cfg.formats || {})[n] || [],
    isValue: n === (cfg.valueColumn || 'Amount'), isDate: n === 'Date'
  }));
  t.primaryKeys = (cfg.pk || []).slice();
  t.valueColumn = cfg.valueColumn || 'Amount';
  t.docNumberColumn = cfg.docNumberColumn || '';
  t.editableColumns = (cfg.editable || []).slice();
  /* A manual offset goes through checkOffsetTolerance, which refuses any
     non-zero sum at the default tolerance of 0 — and a refused offset writes
     nothing, which would make G1's and G4's offset-master assertions pass for
     the wrong reason. */
  t.toleranceMode = cfg.toleranceMode || 'amount';
  t.toleranceValue = cfg.toleranceValue != null ? cfg.toleranceValue : 0;
  t.displayColumns = (cfg.cols || []).slice();
  t.additionalColumns = JSON.parse(JSON.stringify(cfg.extras || []));
  t.enableReporting = true;
  t.enableCorrections = true;
  if (cfg.aeg) t.aegIntegration = Object.assign({ enabled: true, aegTemplateId: '',
    keywordColumn: '', keywordValues: '', postEntryColumn: '', postEntryValue: '' }, cfg.aeg);
  const prev = window.__confirmAnswer; window.__confirmAnswer = true;
  try { RecoTemplate.saveTemplate(); } finally { window.__confirmAnswer = prev; }
  const tpl = AppState.recoTemplates.find(x => x.id === cfg.tplId);
  if (!tpl) return { error: 'template was not saved' };
  RecoTemplate.open(tpl.id);
  const sess = AppState.recoSessions[tpl.id];
  Reco.ensureSessionShape(sess);
  sess._autoLoadAttempted = true;
  return { pk: (tpl.primaryKeys || []).slice(), extras: (tpl.additionalColumns || []).map(a => a.name) };
})`;

/* Load rows through the real ingest path so _pk is minted the way production
   mints it. Returns what the mint produced plus the row count. */
const INGEST = `(async function (arg) {
  const [tplId, rows, fields] = arg;
  const tpl = AppState.recoTemplates.find(x => x.id === tplId);
  const r = Reco.ingestData(tpl, rows, fields);
  if (r && typeof r.then === 'function') await r;
  await new Promise(res => setTimeout(res, 60));
  const sess = AppState.recoSessions[tplId];
  return { n: sess.data.length, pks: sess.data.map(x => x._pk) };
})`;

/* Deterministic _ids, so two builds produce the same bytes. U.uid() is
   random, and the row handlers carry row._id. */
const FIXIDS = `(function (tplId) {
  const sess = AppState.recoSessions[tplId];
  sess.data.forEach((r, i) => { r._id = 'r' + i; });
  /* Reco._rowById is backed by an _id -> index map cached against the data
     ARRAY, and rewriting _ids in place changes neither its identity nor its
     length. Without this, every later Reco.manualOffset / applyCorrection in
     this fixture resolves to no row and returns silently. */
  Reco._invalidateIdx(sess);
  App.navigate('reco');
  return sess.data.length;
})`;

const SNAP = `(function () {
  const wrap = document.querySelector('.reco-table-wrap');
  if (!wrap) return { missing: true };
  const ths = [...wrap.querySelectorAll('thead th')];
  const body = [...wrap.querySelectorAll('tbody tr')];
  return {
    headerCols: ths.map(th => th.dataset.col || th.className),
    thead: ths.map(th => th.outerHTML).join('\\n'),
    tbody: body.map(tr => tr.outerHTML).join('\\n'),
    rows: body.length
  };
})`;

const EXPORT_CSV = `(function () {
  window.__dl = [];
  Reco.exportData('csv');
  const d = (window.__dl || [])[0] || { text: '' };
  return d.text;
})`;

const REPORT_ROWS = `(function (tplId) {
  const tpl = AppState.recoTemplates.find(x => x.id === tplId);
  const sess = AppState.recoSessions[tplId];
  const cols = (tpl.columns || []).map(c => c.name).concat((tpl.additionalColumns || []).map(a => a.name));
  const rpt = { name: 'R', columns: cols, filters: [], groupBy: [], sortBy: '', sortDir: 'asc' };
  return Reco.runReport(tpl, sess, rpt).map(r => cols.map(c => String(r[c] == null ? '' : r[c])));
})`;

/* The day file as the share holds it, with the ISO stamps blanked: _ts is
   wall-clock and differs between two runs of the same build. */
function readDayCsv(root, folder) {
  const base = path.join(root, 'reco_data', folder);
  if (!fs.existsSync(base)) return null;
  const out = [];
  for (const mon of fs.readdirSync(base).sort()) {
    const md = path.join(base, mon);
    if (!fs.statSync(md).isDirectory()) continue;
    for (const f of fs.readdirSync(md).sort()) {
      out.push(mon + '/' + f + '\n' + fs.readFileSync(path.join(md, f), 'utf8'));
    }
  }
  return out.join('\n====\n').replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, '<TS>');
}
function readJsonFile(root, key) {
  const p = path.join(root, 'reco', key + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { _unparseable: String(e) }; }
}
/* recoId values carry Date.now(), so they cannot be compared across builds;
   the SHAPE (which pk, which flags) is what G1 and G4 are about. */
function normOffsets(o) {
  if (!o || typeof o !== 'object') return o;
  const out = {};
  Object.keys(o).sort().forEach(t => {
    out[t] = {};
    Object.keys(o[t] || {}).sort().forEach(pk => {
      const v = o[t][pk] || {};
      out[t][pk] = { recoId: typeof v.recoId === 'string' ? '<RID>' : v.recoId, byUser: v.byUser };
    });
  });
  return out;
}

const watchdog = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 40 * 60 * 1000);
const procs = [];
const browser = await chromium.launch();
try {

  const { root } = makeRoot('shared');
  const bridge = await startBridge(root, PORT);
  procs.push(bridge.proc);
  const S = await openReco(browser, bridge);
  const { page } = S;

  /* ====================================================================
     G1 — THE MIGRATION IS A NO-OP (the gate, and the acceptance bar)
     ==================================================================== */
  section(1, 'G1: an existing template and session with a template-column key is byte-identical');

  const G1_TPL = 'tpl_pkx_g1';
  const G1_CFG = {
    tplId: G1_TPL, name: 'G1',
    cols: ['Doc', 'Date', 'Amount', 'Status', 'Vend'],
    pk: ['Doc'], valueColumn: 'Amount', docNumberColumn: 'Doc', editable: ['Status'],
    toleranceValue: 1e9,
    extras: [
      { name: 'Note', type: 'custom' },
      { name: 'Grade', type: 'dropdown', options: ['A', 'B'] },
      { name: 'Calc', type: 'formula', formula: 'NUM({Amount})*2' },
      { name: 'VLook', type: 'master_lookup', masterCfg: { source: 'accounts', matchColumn: 'Vend', matchKey: 'Reference', returnKey: 'Nominal' } }
    ]
  };
  const G1_ROWS = [];
  for (let i = 0; i < 12; i++) G1_ROWS.push({
    Doc: 'D' + i, Date: String(1 + (i % 28)).padStart(2, '0') + '/01/2026',
    Amount: String((i + 1) * 100), Status: i % 3 ? 'Open' : 'Cleared', Vend: 'V' + (1 + (i % 3))
  });
  const G1_FIELDS = ['Doc', 'Date', 'Amount', 'Status', 'Vend'];

  /* Everything G1 compares, produced by one function so the two builds run
     identical code. The edit, the offset and the correction are all driven
     through the real handlers. */
  const G1_RUN = `(async function (arg) {
    const [cfg, rows, fields] = arg;
    const setup = (${SETUP})(cfg);
    if (setup.error) return { error: setup.error };
    const tplId = cfg.tplId;
    await (${INGEST})([tplId, rows, fields]);
    (${FIXIDS})(tplId);
    const snap = (${SNAP})();
    const csv = (${EXPORT_CSV})();
    const report = (${REPORT_ROWS})(tplId);
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const sess = AppState.recoSessions[tplId];
    /* An edit on a versioned template column: this is what writes a Cn row
       into the day file. */
    const res = await Reco.applyEdits(tpl, sess, [{ row: sess.data[2], col: 'Status', value: 'Edited' }], { trusted: true });
    /* An offset and a correction: the two shared-folder stores guarded only
       by a bare if (pk). */
    window.__toasts = [];
    Reco.manualOffset(4, 'p0', sess.data[4]._id);
    Reco.applyCorrection(5, 'Status', 'Fixed', 'p0', sess.data[5]._id);
    await AppState.flush();
    return {
      snap, csv, report,
      pks: sess.data.map(r => r._pk),
      keys: sess.data.map(r => Reco.getRowPK(tpl, r)),
      wrote: Object.keys(res.versions || {}).length,
      folder: tpl.dataFolder,
      /* The in-memory shape as well as the file, so a vacuous pass (the
         offset was refused, so nothing was written, so "identical") is
         visible rather than green. */
      memOffsets: JSON.parse(JSON.stringify(AppState.manualOffsetMaster[tplId] || null)),
      memCorr: JSON.parse(JSON.stringify(AppState.correctionMaster[tplId] || null)),
      storeToasts: (window.__toasts || []).slice()
    };
  })`;

  const g1New = await page.evaluate(new Function('arg', 'return (' + G1_RUN + ')(arg)'), [G1_CFG, G1_ROWS, G1_FIELDS]);
  check(!g1New.error && g1New.snap && g1New.snap.rows === 12, 'the G1 fixture drew 12 rows in this build', {
    error: g1New.error, rows: g1New.snap && g1New.snap.rows
  });
  check(same(g1New.pks, g1New.keys), 'the premise: on a template-column key, _pk and the recomputed key agree', {
    pks: (g1New.pks || []).slice(0, 3), keys: (g1New.keys || []).slice(0, 3)
  });
  check(g1New.memOffsets && Object.keys(g1New.memOffsets).length === 1
     && g1New.memCorr && Object.keys(g1New.memCorr).length === 1,
    'the premise: the offset and the correction really did write to the two shared masters', {
      offsets: g1New.memOffsets, corrections: g1New.memCorr, toasts: g1New.storeToasts
    });
  const g1NewFiles = {
    day: readDayCsv(root, g1New.folder),
    offsets: normOffsets(readJsonFile(root, 'manualOffsetMaster')),
    corrections: readJsonFile(root, 'correctionMaster')
  };

  const baseRoot = makeRoot('baseline', BASE_REV).root;
  if (!baseRoot) {
    check(false, 'G1 NOT RUN: the baseline build ' + BASE_REV + ' could not be checked out');
  } else {
    const bridgeB = await startBridge(baseRoot, PORT_BASE);
    procs.push(bridgeB.proc);
    const B = await openReco(browser, bridgeB);
    const g1Old = await B.page.evaluate(new Function('arg', 'return (' + G1_RUN + ')(arg)'), [G1_CFG, G1_ROWS, G1_FIELDS]);
    const g1OldFiles = {
      day: readDayCsv(baseRoot, g1Old.folder),
      offsets: normOffsets(readJsonFile(baseRoot, 'manualOffsetMaster')),
      corrections: readJsonFile(baseRoot, 'correctionMaster')
    };
    check(!g1Old.error, 'the baseline build ran the same fixture', g1Old.error);
    check(g1New.snap.thead === g1Old.snap.thead, 'THE HEADER IS BYTE-IDENTICAL to the build before this change');
    /* #26 (the manual override) adds ONE difference to the grid body, and it
       is the only one: a computed added column's cell used to render as a bare
       locked <td> with NO `title` at all, so a user double-clicked, typed and
       nothing happened with no explanation anywhere on the screen. Since
       `allowOverride` defaults false, every template that exists today
       renders that cell - including both of this fixture's computed extras.
       Normalised out of the NEW text only, and then asserted positively below
       so this cannot become "identical apart from anything I ignore". */
    const OV_TITLE = / title="Computed in Reco\. To let people type their own value here[^"]*"/g;
    const OV_CURSOR = / cursor:not-allowed;/g;
    const nOvTitle = (g1New.snap.tbody.match(OV_TITLE) || []).length;
    const nOvCursor = (g1New.snap.tbody.match(OV_CURSOR) || []).length;
    const newBody = g1New.snap.tbody.replace(OV_TITLE, '').replace(OV_CURSOR, '');
    check(newBody === g1Old.snap.tbody,
      'THE <tbody> IS BYTE-IDENTICAL to the build before this change, apart from #26\'s one declared '
      + 'insertion - the locked computed cell\'s title and cursor', {
      newLen: newBody.length, oldLen: g1Old.snap.tbody.length,
      firstDiff: (() => {
        const a = newBody, b = g1Old.snap.tbody;
        for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return { at: i, got: a.slice(i, i + 90), want: b.slice(i, i + 90) };
        return null;
      })()
    });
    const nComputedTd = (g1Old.snap.tbody.match(/<td data-col="(Calc|VLook)"/g) || []).length;
    check(nOvTitle > 0 && nOvTitle === nComputedTd && nOvCursor === nComputedTd,
      'and the normalisation removed EXACTLY one title and one cursor per computed-extra cell, so the '
      + 'comparison above is not hiding a second change',
      { titles: nOvTitle, cursors: nOvCursor, computedCells: nComputedTd });
    check(!/title="Computed in Reco\./.test(g1Old.snap.tbody)
          && /title="Computed in Reco\./.test(g1New.snap.tbody),
      'and the declared difference is exactly that: the locked computed cell now says how to turn typing '
      + 'on, where the build before carried no title there at all');
    check(g1New.csv === g1Old.csv, 'THE CSV EXPORT IS BYTE-IDENTICAL', { newHead: (g1New.csv || '').split('\n')[0], oldHead: (g1Old.csv || '').split('\n')[0] });
    check(same(g1New.report, g1Old.report), 'A REPORT IS BYTE-IDENTICAL');
    check(g1NewFiles.day === g1OldFiles.day && g1NewFiles.day != null,
      'THE DAY FILE WRITTEN BY AN EDIT IS BYTE-IDENTICAL (ISO stamps normalised)', {
        newNull: g1NewFiles.day == null, oldNull: g1OldFiles.day == null,
        newLen: (g1NewFiles.day || '').length, oldLen: (g1OldFiles.day || '').length
      });
    check(same(g1NewFiles.offsets, g1OldFiles.offsets) && g1NewFiles.offsets != null,
      'THE MANUAL-OFFSET MASTER ON THE SHARE IS IDENTICAL', { now: g1NewFiles.offsets, was: g1OldFiles.offsets });
    check(same(g1NewFiles.corrections, g1OldFiles.corrections) && g1NewFiles.corrections != null,
      'THE CORRECTION MASTER ON THE SHARE IS IDENTICAL', { now: g1NewFiles.corrections, was: g1OldFiles.corrections });
    await B.ctx.close();
  }

  /* ====================================================================
     G2 — the dependency closure (the gate)
     ==================================================================== */
  section(2, 'G2: a key extra over a NON-key extra declared above it mints the right _pk');

  const G2_TPL = 'tpl_pkx_g2';
  const G2_EXTRAS = [
    { name: 'Base', type: 'formula', formula: 'CONCAT("B-",{Doc})' },
    { name: 'Line', type: 'formula', formula: 'CONCAT("L",{Seq})' },
    { name: 'Key', type: 'formula', formula: 'CONCAT({Base},"-",{Line})' }
  ];
  const g2Setup = await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G2_TPL, name: 'G2', cols: ['Doc', 'Seq', 'Amount'], pk: ['Key'],
    valueColumn: 'Amount', extras: G2_EXTRAS
  });
  check(same(g2Setup.pk, ['Key']), 'saveTemplate KEPT the added column as the key — the keyable set is widened', g2Setup);

  const G2_ROWS = [];
  for (let i = 0; i < 40; i++) G2_ROWS.push({ Doc: 'DOC' + (i % 8), Seq: String(i), Amount: String(i * 10) });
  const g2 = await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'), [G2_TPL, G2_ROWS, ['Doc', 'Seq', 'Amount']]);
  const g2Want = G2_ROWS.map(r => 'B-' + r.Doc + '-L' + r.Seq);
  check(same(g2.pks, g2Want), 'every row minted _pk = CONCAT({Base},"-",{Line}) — the closure WAS materialised', {
    got: (g2.pks || []).slice(0, 4), want: g2Want.slice(0, 4)
  });
  /* Distinctness ALONE proves nothing: an _auto_ fallback key is distinct
     too. So: distinct AND no row fell back to a minted uid. */
  check(new Set(g2.pks || []).size === G2_ROWS.length
     && !(g2.pks || []).some(k => /^_auto_|^_added_/.test(String(k))),
    'all 40 keys are distinct AND none fell back to an _auto_ uid', {
      distinct: new Set(g2.pks || []).size, rows: G2_ROWS.length,
      fallbacks: (g2.pks || []).filter(k => /^_auto_|^_added_/.test(String(k))).length
    });
  /* THE FAILURE MODE THIS GATE EXISTS FOR: duplicate keys collapse in
     collapseToActive, so a day file reopens with a fraction of its rows. */
  const g2Reload = await page.evaluate(async tplId => {
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const files = await Versioning.listFiles(tpl);
    if (!files || !files.length) return { error: 'no version files' };
    const latest = files[files.length - 1];
    await Reco.loadVersionedFile(latest.fullPath, tplId);
    const sess = AppState.recoSessions[tplId];
    return { n: sess.data.length, distinct: new Set(sess.data.map(r => r._pk)).size,
             pks: sess.data.map(r => r._pk).sort() };
  }, G2_TPL);
  check(g2Reload.n === G2_ROWS.length,
    'THE ROW COUNT SURVIVES A RELOAD — collapseToActive did not fold 40 rows onto a handful of keys',
    { n: g2Reload.n, distinct: g2Reload.distinct });
  check(same(g2Reload.pks, g2Want.slice().sort()),
    'and every reloaded row carries the SAME derived key it was minted with', (g2Reload.pks || []).slice(0, 4));

  /* ====================================================================
     G3 — one empty component, refused BEFORE appendUpload (the gate)
     ==================================================================== */
  section(3, 'G3: a two-component key with one empty component is refused before the file is written');

  const G3_TPL = 'tpl_pkx_g3';
  const g3Setup = await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G3_TPL, name: 'G3', cols: ['Doc', 'Ref', 'Amount'], pk: ['Doc', 'Ref'], valueColumn: 'Amount'
  });
  check(same(g3Setup.pk, ['Doc', 'Ref']), 'the G3 fixture has a two-component template key', g3Setup);
  const G3_ROWS = [];
  for (let i = 0; i < 30; i++) G3_ROWS.push({ Doc: 'INV-' + i, Ref: '', Amount: '10' });

  await resetLog(bridge);
  await armConfirms(page, false);          // the operator says No
  const g3 = await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'), [G3_TPL, G3_ROWS, ['Doc', 'Ref', 'Amount']]);
  await sleep(300);
  const g3Confirms = await readConfirms(page);
  const g3Calls = await bridgeLog(bridge);
  const g3Folder = await page.evaluate(id => (AppState.recoTemplates.find(x => x.id === id) || {}).dataFolder, G3_TPL);
  const g3Writes = g3Calls.filter(c => (c.method === 'append_csv_rows' || c.method === 'write_file')
    && c.arg0 && String(c.arg0).indexOf('reco_data/' + g3Folder + '/') === 0);
  check(g3Confirms.some(m => /empt/i.test(m) && /key/i.test(m)),
    'a BLOCKING confirm named the empty key component', g3Confirms.slice(0, 2));
  check(g3Writes.length === 0,
    'THE BRIDGE RECEIVED NO append_csv_rows / write_file FOR THE DAY FILE — the refusal is before the write, not after it',
    g3Writes.slice(0, 4));
  check(g3.n === 0, 'and nothing was added to the session either', g3);
  await armConfirms(page, true);

  /* ====================================================================
     G4 — a keyless template writes nothing to the two shared masters
     ==================================================================== */
  section(4, 'G4: a keyless template writes NOTHING to manualOffsetMaster / correctionMaster');

  const G4_TPL = 'tpl_pkx_g4';
  await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G4_TPL, name: 'G4', cols: ['Doc', 'Status', 'Amount'], pk: [], valueColumn: 'Amount',
    editable: ['Status'], toleranceValue: 1e9
  });
  await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'),
    [G4_TPL, [{ Doc: 'A', Status: 'Open', Amount: '1' }, { Doc: 'B', Status: 'Open', Amount: '2' }], ['Doc', 'Status', 'Amount']]);
  const g4 = await page.evaluate(async tplId => {
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const sess = AppState.recoSessions[tplId];
    window.__toasts = [];
    Reco.manualOffset(0, 'p0', sess.data[0]._id);
    Reco.applyCorrection(1, 'Status', 'Fixed', 'p0', sess.data[1]._id);
    await AppState.flush();
    return {
      rowKey: typeof Reco.rowKey === 'function' ? Reco.rowKey(tpl, sess.data[0]) : 'NO rowKey',
      /* S4's stricter sibling. Nothing in the product calls it yet (#26 and
         #30 are its first callers), so without this it would ship verified by
         nothing at all. Three cases: keyless, a real key, and the truthy-'||'
         row a two-column key with both cells blank produces. */
      storeKeyless: typeof Reco.storeKey === 'function' ? Reco.storeKey(tpl, sess.data[0]) : 'NO storeKey',
      storeKeyed: typeof Reco.storeKey === 'function'
        ? Reco.storeKey({ primaryKeys: ['A'] }, { _pk: 'K1' }) : 'NO storeKey',
      storeAllBlank: typeof Reco.storeKey === 'function'
        ? Reco.storeKey({ primaryKeys: ['A', 'B'] }, { _pk: '||' }) : 'NO storeKey',
      rowKeyAllBlank: typeof Reco.rowKey === 'function'
        ? Reco.rowKey({ primaryKeys: ['A', 'B'] }, { _pk: '||' }) : 'NO rowKey',
      hasPk: !!sess.data[0]._pk,
      /* The premise both "NOTHING reached the share" assertions depend on: the
         offset and the correction actually RAN. A refused offset writes
         nothing either, and would make them green for the wrong reason. */
      offsetRan: !!sess.offsets[sess.data[0]._id],
      corrRan: !!sess.data[1]['_corrected_Status'],
      toasts: (window.__toasts || []).slice(),
      memOffsets: AppState.manualOffsetMaster[tplId] || null,
      memCorr: AppState.correctionMaster[tplId] || null
    };
  }, G4_TPL);
  check(g4.hasPk, 'the premise: a keyless row still carries a truthy storage _pk', g4);
  check(g4.offsetRan && g4.corrRan, 'the premise: the offset and the correction both RAN on the keyless template', {
    offsetRan: g4.offsetRan, corrRan: g4.corrRan, toasts: g4.toasts
  });
  check(g4.rowKey === null, 'Reco.rowKey returns NULL on a keyless template — it tests primaryKeys.length first and never mints', g4);
  const g4Off = readJsonFile(root, 'manualOffsetMaster') || {};
  const g4Corr = readJsonFile(root, 'correctionMaster') || {};
  check(!g4Off[G4_TPL] || !Object.keys(g4Off[G4_TPL]).length,
    'NOTHING reached manualOffsetMaster.json ON THE SHARE for the keyless template', g4Off[G4_TPL]);
  check(!g4Corr[G4_TPL] || !Object.keys(g4Corr[G4_TPL]).length,
    'NOTHING reached correctionMaster.json ON THE SHARE for the keyless template', g4Corr[G4_TPL]);
  check(g4.storeKeyless === null && g4.storeKeyed === 'K1', 'Reco.storeKey: null when keyless, the key otherwise', g4);
  check(g4.rowKeyAllBlank === '||' && g4.storeAllBlank === null,
    "and storeKey ALONE refuses the truthy '||' a two-column key with both cells blank produces — rowKey keeps returning it, "
    + 'so the migration stays a no-op', { rowKey: g4.rowKeyAllBlank, storeKey: g4.storeAllBlank });

  /* ====================================================================
     G5 — '#ERR' counted with ''
     ==================================================================== */
  section(5, "G5: '#ERR' as a key component is counted with '' and refused above the threshold");

  const G5_TPL = 'tpl_pkx_g5';
  const g5Setup = await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G5_TPL, name: 'G5', cols: ['Doc', 'Amount'], pk: ['Bad'], valueColumn: 'Amount',
    /* A division that is not finite: Formula._result maps NaN/Infinity to
       '#ERR' for every row. NOT wrapped in ROUND — ROUND does `+n||0`, which
       turns NaN into a perfectly good 0 and the fixture then tests nothing. */
    extras: [{ name: 'Bad', type: 'formula', formula: 'NUM({Doc})/0' }]
  });
  check(same(g5Setup.pk, ['Bad']), 'the G5 fixture keeps the formula extra as the key', g5Setup);
  const G5_ROWS = [];
  for (let i = 0; i < 25; i++) G5_ROWS.push({ Doc: 'X' + i, Amount: '1' });
  await resetLog(bridge);
  await armConfirms(page, false);
  const g5 = await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'), [G5_TPL, G5_ROWS, ['Doc', 'Amount']]);
  await sleep(250);
  const g5Confirms = await readConfirms(page);
  const g5Folder = await page.evaluate(id => (AppState.recoTemplates.find(x => x.id === id) || {}).dataFolder, G5_TPL);
  const g5Writes = (await bridgeLog(bridge)).filter(c => (c.method === 'append_csv_rows' || c.method === 'write_file')
    && c.arg0 && String(c.arg0).indexOf('reco_data/' + g5Folder + '/') === 0);
  check(g5Confirms.some(m => /#ERR/.test(m)), "the confirm counted '#ERR' by name", g5Confirms.slice(0, 2));
  check(g5Writes.length === 0, "'#ERR' above the threshold refused the mint before the day file was written", g5Writes.slice(0, 3));
  check(g5.n === 0, 'and nothing reached the session', g5);
  await armConfirms(page, true);

  /* ====================================================================
     G6 — eligibility, with a reason per refusal
     ==================================================================== */
  section(6, 'G6: eligibility — the type AND the source are whitelisted, each refusal with its own reason');

  const G6_TPL = 'tpl_pkx_g6';
  const G6_EXTRAS = [
    { name: 'Typed', type: 'custom' },
    { name: 'Picked', type: 'dropdown', options: ['a', 'b'] },
    { name: 'AcctLook', type: 'master_lookup', masterCfg: { source: 'accounts', matchColumn: 'Vend', matchKey: 'Reference', returnKey: 'Nominal' } },
    { name: 'DocLook', type: 'master_lookup', masterCfg: { source: 'docNumbers', matchColumn: 'Doc', matchKey: 'DocNumber', returnKey: 'AccountingId' } },
    { name: 'CorrLook', type: 'master_lookup', masterCfg: { source: 'corrections', matchColumn: 'Doc', matchKey: 'PrimaryKey', returnKey: 'NewValue' } },
    { name: 'CustLook', type: 'master_lookup', masterCfg: { source: 'custom:0', matchColumn: 'Doc', matchKey: 'K', returnKey: 'V' } },
    { name: 'LegacyLook', type: 'master', masterRefColumn: 'Vend', masterValueColumn: 'Nominal' },
    { name: 'Partial', type: 'master_lookup', masterCfg: { source: 'accounts', matchColumn: 'Vend' } },
    { name: 'Calc', type: 'formula', formula: 'CONCAT({Doc},"-",{Vend})' }
  ];
  await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G6_TPL, name: 'G6', cols: ['Doc', 'Vend', 'Amount'], pk: ['Doc'], valueColumn: 'Amount', extras: G6_EXTRAS
  });
  const g6 = await page.evaluate(tplId => {
    const t = AppState.recoTemplates.find(x => x.id === tplId);
    if (typeof RecoTemplate._pkEligible !== 'function') return { missing: true };
    const out = {};
    ['Doc', 'Typed', 'Picked', 'AcctLook', 'DocLook', 'CorrLook', 'CustLook', 'LegacyLook', 'Partial', 'Calc']
      .forEach(n => { out[n] = RecoTemplate._pkEligible(t, n); });
    return out;
  }, G6_TPL);
  check(!g6.missing, 'RecoTemplate._pkEligible exists');
  if (!g6.missing) {
    check(g6.Doc && g6.Doc.ok, 'a template column is eligible', g6.Doc);
    check(g6.Calc && g6.Calc.ok, 'a formula over template columns is eligible', g6.Calc);
    check(g6.AcctLook && g6.AcctLook.ok, 'a master_lookup into the ACCOUNTS master is eligible', g6.AcctLook);
    const refused = { Typed: /type|edit/i, Picked: /type|edit|dropdown/i, DocLook: /document number/i,
                      CorrLook: /correction/i, CustLook: /custom master/i, LegacyLook: /older|legacy|re-?pick|reconfigure/i,
                      Partial: /incomplete|not finished|complete/i };
    Object.keys(refused).forEach(n => {
      const e = g6[n] || {};
      check(e.ok === false && refused[n].test(String(e.reason || '')),
        n + ' is refused with its OWN reason, not a generic one', e);
    });
    /* custom and dropdown share one reason BY DESIGN — they are one category
       ("you type this column in") and splitting the sentence would say the
       same thing twice. The five that must differ are the five different
       causes. */
    const reasons = new Set(['Typed', 'DocLook', 'CorrLook', 'CustLook', 'LegacyLook'].map(n => String((g6[n] || {}).reason || '')));
    check(reasons.size === 5, 'the five different causes give five DIFFERENT reasons', [...reasons]);
    check(String(g6.Typed.reason) === String(g6.Picked.reason),
      'custom and dropdown share one reason, because they are one cause', { typed: g6.Typed, picked: g6.Picked });
  }
  /* And the save filter drops an ineligible name, so a template cannot be
     persisted with a key the mint cannot freeze. */
  const g6Save = await page.evaluate(tplId => {
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    RecoTemplate.edit(tplId);
    const t = RecoTemplate._editing;
    t.primaryKeys = ['Doc', 'Typed', 'AcctLook', 'DocLook'];
    const prev = window.__confirmAnswer; window.__confirmAnswer = true;
    try { RecoTemplate.saveTemplate(); } finally { window.__confirmAnswer = prev; }
    return (AppState.recoTemplates.find(x => x.id === tplId) || {}).primaryKeys;
  }, G6_TPL);
  check(same(g6Save, ['Doc', 'AcctLook']), "saveTemplate's filter kept the eligible components and dropped the rest", g6Save);

  /* ====================================================================
     G7 — the grammar whitelist, both directions
     ==================================================================== */
  section(7, 'G7: the grammar is whitelisted, not the names — both directions');

  const g7 = await page.evaluate(() => {
    if (typeof RecoTemplate._pkEligible !== 'function') return { missing: true };
    const mk = formula => ({
      id: 'g7probe', name: 'g7', columns: [{ name: 'Doc' }, { name: 'A' }, { name: 'B' }],
      primaryKeys: [], additionalColumns: [{ name: 'F', type: 'formula', formula }]
    });
    const at = f => RecoTemplate._pkEligible(mk(f), 'F');
    return {
      clockInline: at('CONCAT({Doc},"-",Date.now())'),
      today: at('CONCAT({Doc},TODAY())'),
      age: at('AGE({Doc})'),
      bucket: at('AGEING_BUCKET({Doc})'),
      average: at('ROUND(AVERAGE({A},{B}),2)'),
      plainConcat: at('CONCAT({Doc},"-",{A})'),
      literalOnly: at('CONCAT({Doc},"Date.now()")'),
      mathGlobal: at('Math.random()+{A}'),
      arithmetic: at('NUM({A})+NUM({B})*2')
    };
  });
  check(!g7.missing, 'RecoTemplate._pkEligible is reachable for the grammar probes');
  if (!g7.missing) {
    /* The reason names `Date`, not a clock: the identifier whitelist catches
       it before any clock rule could, which is the point of decision C — a
       name blacklist would have let it through entirely. */
    check(g7.clockInline.ok === false && /\bDate\b|JavaScript|clock/i.test(String(g7.clockInline.reason)),
      'CONCAT({Doc},"-",Date.now()) is REFUSED — the evaluator is a JS evaluator, not a formula interpreter', g7.clockInline);
    check(g7.mathGlobal.ok === false, 'Math.random()+{A} is REFUSED — any identifier outside Formula._helpers', g7.mathGlobal);
    check(g7.today.ok === false && /clock|today|time/i.test(String(g7.today.reason)), 'TODAY() is refused', g7.today);
    check(g7.age.ok === false, 'AGE() is refused', g7.age);
    check(g7.bucket.ok === false, 'AGEING_BUCKET() is refused', g7.bucket);
    check(g7.average.ok === true,
      'ROUND(AVERAGE({A},{B}),2) is ALLOWED — a substring test for AGE would have refused it with a nonsense reason', g7.average);
    check(g7.plainConcat.ok === true, 'CONCAT({Doc},"-",{A}) is allowed', g7.plainConcat);
    check(g7.literalOnly.ok === true, 'Date.now() inside a STRING LITERAL is allowed — literals are stripped before the scan', g7.literalOnly);
    check(g7.arithmetic.ok === true, 'arithmetic over helper calls is allowed', g7.arithmetic);
  }

  /* ====================================================================
     G8 — the displayed value may not diverge from the frozen key
     ==================================================================== */
  section(8, 'G8: after the accounts master changes, every surface still shows the FROZEN component');

  const G8_TPL = 'tpl_pkx_g8';
  const g8Setup = await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G8_TPL, name: 'G8', cols: ['Doc', 'Vend', 'Amount'], pk: ['VKey'], valueColumn: 'Amount',
    extras: [{ name: 'VKey', type: 'master_lookup', masterCfg: { source: 'accounts', matchColumn: 'Vend', matchKey: 'Reference', returnKey: 'Nominal' } }]
  });
  check(same(g8Setup.pk, ['VKey']), 'the G8 fixture keys on an accounts lookup', g8Setup);
  const g8Mint = await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'),
    [G8_TPL, [{ Doc: 'A', Vend: 'V1', Amount: '10' }, { Doc: 'B', Vend: 'V2', Amount: '20' }], ['Doc', 'Vend', 'Amount']]);
  check(same(g8Mint.pks, ['VEND-33', 'VEND-44']), 'the mint froze the lookup value into _pk', g8Mint);

  const g8 = await page.evaluate(async tplId => {
    /* A colleague edits the shared accounts master under the loaded session. */
    const m = (AppState.aegMaster || []).find(x => String(x.Reference) === 'V1');
    if (m) m.Nominal = 'VEND-99';
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const sess = AppState.recoSessions[tplId];
    const row = sess.data[0];
    App.navigate('reco');
    const cell = document.querySelector('.reco-table-wrap tbody tr [data-col="VKey"]');
    window.__dl = [];
    Reco.exportData('csv');
    const csv = ((window.__dl || [])[0] || { text: '' }).text;
    const rpt = { name: 'R', columns: ['Doc', 'VKey'], filters: [], groupBy: [], sortBy: '', sortDir: 'asc' };
    const report = Reco.runReport(tpl, sess, rpt).map(r => String(r.VKey == null ? '' : r.VKey));
    const files = await Versioning.listFiles(tpl);
    const verRows = files && files.length ? await Versioning.readFile(files[files.length - 1].fullPath) : [];
    return {
      pk: row._pk,
      keyCell: typeof Reco.keyCellValue === 'function' ? Reco.keyCellValue(tpl, sess, row, 'VKey') : 'NO keyCellValue',
      drift: typeof Reco.keyDrift === 'function' ? Reco.keyDrift(tpl, sess, row) : 'NO keyDrift',
      cellText: cell ? cell.textContent : 'NO CELL',
      cellHtml: cell ? cell.innerHTML : '',
      /* ROUND 2: through _extraComputedValue, not _extraValueForRow. That
         function is now ONE of the readers that answers with the frozen
         component (G23 is why: the filters, the slicers, the sort and
         find-and-replace all come through it), so asking it what the lookup
         says NOW would be asking the wrong function and this premise would
         assert that the fix for G23 is a bug. */
      recomputed: Reco._extraComputedValue(tpl, sess, row, Reco._extraDef(tpl, 'VKey')),
      full: Reco.rowFull(tpl, sess, row).VKey,
      csvHasFrozen: csv.indexOf('VEND-33') !== -1, csvHasNew: csv.indexOf('VEND-99') !== -1,
      report, verPks: (verRows || []).map(r => r._pk)
    };
  }, G8_TPL);
  check(g8.pk === 'VEND-33', 'the frozen _pk did not move when the master changed', g8);
  check(g8.recomputed === 'VEND-99', 'the premise: recomputing the lookup now gives a DIFFERENT value', g8);
  check(g8.keyCell === 'VEND-33', 'Reco.keyCellValue returns the FROZEN component', g8);
  check(g8.full === 'VEND-33', 'the enriched row (rowFull) carries the frozen value, so every reader agrees', g8);
  check(String(g8.cellText).indexOf('VEND-33') !== -1 && String(g8.cellText).indexOf('VEND-99') === -1,
    'THE GRID CELL PRINTS THE FROZEN VALUE', { text: g8.cellText });
  check(/recalculated/.test(String(g8.cellHtml)), 'and carries the "⚠ recalculated" marker', { html: String(g8.cellHtml).slice(0, 200) });
  check(g8.drift && g8.drift.drifted === true && (g8.drift.cols || []).indexOf('VKey') !== -1,
    'Reco.keyDrift reports the drift and names the column', g8.drift);
  check(g8.csvHasFrozen && !g8.csvHasNew, 'THE EXPORT agrees on the frozen value', { frozen: g8.csvHasFrozen, recomputed: g8.csvHasNew });
  check(same(g8.report, ['VEND-33', 'VEND-44']), 'A REPORT agrees on the frozen value', g8.report);
  check((g8.verPks || []).indexOf('VEND-33') !== -1, 'THE VERSION FILE agrees on the frozen value', g8.verPks);
  const g8Count = await page.evaluate(id => (typeof Reco.keyDriftCount === 'function' ? Reco.keyDriftCount(id) : 'NO keyDriftCount'), G8_TPL);
  check(typeof g8Count === 'number' && g8Count >= 1, 'a session drift COUNT is kept', g8Count);

  /* ====================================================================
     G9 — tplSignature and the definition-change confirm
     ==================================================================== */
  section(9, "G9: a key extra's DEFINITION is hashed, and editing it confirms");

  const g9 = await page.evaluate(tplId => {
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const before = XlSchema.tplSignature(tpl);
    RecoTemplate.edit(tplId);
    const t = RecoTemplate._editing;
    const ac = (t.additionalColumns || []).find(a => a.name === 'VKey');
    ac.masterCfg = Object.assign({}, ac.masterCfg, { returnKey: 'SubNominal' });
    window.__confirms = []; window.__confirmAnswer = true;
    RecoTemplate.saveTemplate();
    const asked = (window.__confirms || []).slice();
    const after = XlSchema.tplSignature(AppState.recoTemplates.find(x => x.id === tplId));
    return { before, after, asked, pkUnchanged: same((AppState.recoTemplates.find(x => x.id === tplId) || {}).primaryKeys, ['VKey']) };

    function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  }, G8_TPL);
  check(g9.pkUnchanged, 'the premise: primaryKeys is byte-identical across the edit — only the DEFINITION moved', g9.pkUnchanged);
  check(g9.asked.some(m => /primary key|row key|version history/i.test(m)),
    'THE DEFINITION-CHANGE CONFIRM FIRED on a key extra config edit', g9.asked.slice(0, 2));
  check(g9.before !== g9.after,
    'tplSignature CHANGED — a workbook exported before the edit no longer matches, so there is no silent rowNotInCurrentData flood', g9);

  /* ====================================================================
     G10 — untick and retick is a genuine no-op
     ==================================================================== */
  section(10, 'G10: untick and retick a key component — no confirm, canonical order held');

  const G10_TPL = 'tpl_pkx_g10';
  await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G10_TPL, name: 'G10', cols: ['Doc', 'Seq', 'Amount'], pk: ['Doc', 'Seq'], valueColumn: 'Amount',
    extras: [{ name: 'Calc', type: 'formula', formula: 'CONCAT({Doc},"/",{Seq})' }]
  });
  const g10 = await page.evaluate(tplId => {
    /* PART 1 — TEMPLATE COLUMNS ONLY, so this half of the gate bites on the
       build before the change too: ticking Doc again pushes it to the END,
       primaryKeys becomes ["Seq","Doc"], and the full "rows will no longer
       match their version history" confirm fires on a NO-OP. */
    RecoTemplate.edit(tplId);
    RecoTemplate._editing.primaryKeys = ['Doc', 'Seq'];
    window.__confirmAnswer = true;
    RecoTemplate.saveTemplate();
    const base = (AppState.recoTemplates.find(x => x.id === tplId) || {}).primaryKeys.slice();

    RecoTemplate.edit(tplId);
    RecoTemplate.togglePK('Doc', false);
    RecoTemplate.togglePK('Doc', true);
    const editingTpl = (RecoTemplate._editing.primaryKeys || []).slice();
    window.__confirms = [];
    RecoTemplate.saveTemplate();
    const askedTpl = (window.__confirms || []).slice();
    const afterTpl = (AppState.recoTemplates.find(x => x.id === tplId) || {}).primaryKeys.slice();

    /* PART 2 — the mixed key the feature introduces. */
    RecoTemplate.edit(tplId);
    RecoTemplate._editing.primaryKeys = ['Doc', 'Calc'];
    window.__confirmAnswer = true;
    RecoTemplate.saveTemplate();
    const settled = (AppState.recoTemplates.find(x => x.id === tplId) || {}).primaryKeys.slice();

    RecoTemplate.edit(tplId);
    RecoTemplate.togglePK('Calc', false);
    RecoTemplate.togglePK('Calc', true);
    const editing = (RecoTemplate._editing.primaryKeys || []).slice();
    window.__confirms = [];
    RecoTemplate.saveTemplate();
    const asked = (window.__confirms || []).slice();
    const after = (AppState.recoTemplates.find(x => x.id === tplId) || {}).primaryKeys.slice();

    /* PART 3 — a key given out of order settles into the canonical one. */
    RecoTemplate.edit(tplId);
    RecoTemplate._editing.primaryKeys = ['Calc', 'Seq', 'Doc'];
    window.__confirmAnswer = true;
    RecoTemplate.saveTemplate();
    const canon = (AppState.recoTemplates.find(x => x.id === tplId) || {}).primaryKeys.slice();
    return { base, editingTpl, askedTpl, afterTpl, settled, editing, asked, after, canon };
  }, G10_TPL);
  check(same(g10.base, ['Doc', 'Seq']), 'the fixture starts from a two-column template key', g10.base);
  check(same(g10.editingTpl, ['Doc', 'Seq']),
    'untick-and-retick a TEMPLATE key column leaves the canonical order, not ["Seq","Doc"] by push order', g10.editingTpl);
  check(same(g10.afterTpl, ['Doc', 'Seq']), 'and the saved key is byte-identical', g10.afterTpl);
  check(!g10.askedTpl.some(m => /no longer match their version history/i.test(m)),
    'NO "rows will no longer match their version history" CONFIRM FIRED for that no-op', g10.askedTpl.slice(0, 2));
  check(same(g10.settled, ['Doc', 'Calc']), 'a mixed key settles in canonical order', g10.settled);
  check(same(g10.editing, ['Doc', 'Calc']),
    'untick-and-retick the EXTRA component is a no-op too', g10.editing);
  check(same(g10.after, g10.settled), 'and the saved mixed key is byte-identical', { after: g10.after, was: g10.settled });
  check(!g10.asked.some(m => /no longer match their version history/i.test(m)),
    'and no confirm fired for it either', g10.asked.slice(0, 2));
  check(same(g10.canon, ['Doc', 'Seq', 'Calc']),
    'the canonical order is template columns in t.columns order, then extras in declaration order', g10.canon);

  /* ====================================================================
     G11 — S11, the role matrix, both editors and both directions
     ==================================================================== */
  section(11, 'G11: S11 refuses one column as both a key component and the AEG post-entry column');

  const G11_TPL = 'tpl_pkx_g11';
  await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G11_TPL, name: 'G11', cols: ['Doc', 'Posted', 'Amount'], pk: ['Doc'], valueColumn: 'Amount',
    aeg: { enabled: true, postEntryColumn: 'Posted', postEntryValue: 'Y' }
  });
  const g11 = await page.evaluate(tplId => {
    if (typeof RecoTemplate._exclusiveRoleConflict !== 'function') return { missing: true };
    RecoTemplate.edit(tplId);
    const t = RecoTemplate._editing;
    // direction 1: the column is already the AEG post-entry column; make it a key
    const conflictPkWay = RecoTemplate._exclusiveRoleConflict(t, 'Posted', 'pk');
    window.__toasts = [];
    RecoTemplate.togglePK('Posted', true);
    const pkAfter = (t.primaryKeys || []).slice();
    const toast1 = (window.__toasts || []).slice();
    // direction 2: the column is already a key component; make it the post-entry column
    const conflictAegWay = RecoTemplate._exclusiveRoleConflict(t, 'Doc', 'aeg.postEntryColumn');
    window.__toasts = [];
    const set = typeof RecoTemplate.setAegRole === 'function'
      ? RecoTemplate.setAegRole('postEntryColumn', 'Doc') : 'NO setAegRole';
    const aegAfter = (t.aegIntegration || {}).postEntryColumn;
    const toast2 = (window.__toasts || []).slice();
    // a column holding no other role is fine, in both editors
    const free = RecoTemplate._exclusiveRoleConflict(t, 'Amount', 'pk');
    return { conflictPkWay, pkAfter, toast1, conflictAegWay, set, aegAfter, toast2, free };
  }, G11_TPL);
  check(!g11.missing, 'RecoTemplate._exclusiveRoleConflict exists');
  if (!g11.missing) {
    check(typeof g11.conflictPkWay === 'string' && /post.?entry/i.test(g11.conflictPkWay),
      'the matrix names the AEG post-entry role when asked about a key component', g11.conflictPkWay);
    check(g11.pkAfter.indexOf('Posted') === -1, 'togglePK REFUSED it — primaryKeys did not gain the column', g11.pkAfter);
    check((g11.toast1 || []).some(t => /post.?entry/i.test(t.msg)), 'and said why', g11.toast1);
    /* BOTH halves of the sentence: the generic "a column can only be one of
       …" is true but does not name what this refusal protected, and that is
       how a refusal reads as a bug. */
    check(typeof g11.conflictAegWay === 'string' && /row key/i.test(g11.conflictAegWay)
       && /post.?entry/i.test(g11.conflictAegWay),
      'and the OTHER direction: the reason names BOTH the key and the post-entry write', g11.conflictAegWay);
    check(g11.aegAfter === 'Posted', 'the AEG editor REFUSED it — postEntryColumn was not moved onto the key column', g11.aegAfter);
    check((g11.toast2 || []).some(t => /key/i.test(t.msg)), 'and said why', g11.toast2);
    check(g11.free === null, 'a column holding no other role is not refused', g11.free);
  }

  /* ====================================================================
     G12 — the Excel visible-key fallback
     ==================================================================== */
  section(12, 'G12: the Excel "match by visible key" fallback is refused when a component is an extra');

  const g12 = await page.evaluate(() => {
    if (typeof ExcelLink._visibleKeyRefusal !== 'function') return { missing: true };
    const mk = pk => ({ id: 'g12', columns: [{ name: 'Doc' }, { name: 'Seq' }], primaryKeys: pk,
      additionalColumns: [{ name: 'Calc', type: 'formula', formula: 'CONCAT({Doc},{Seq})' }] });
    return {
      tplOnly: ExcelLink._visibleKeyRefusal(mk(['Doc', 'Seq'])),
      withExtra: ExcelLink._visibleKeyRefusal(mk(['Doc', 'Calc'])),
      keyless: ExcelLink._visibleKeyRefusal(mk([]))
    };
  });
  check(!g12.missing, 'ExcelLink._visibleKeyRefusal exists');
  if (!g12.missing) {
    check(g12.tplOnly === null, 'a key of template columns only still offers the visible-key match', g12.tplOnly);
    check(typeof g12.withExtra === 'string' && /Calc/.test(g12.withExtra),
      'a key with an extra component is REFUSED BY NAME — not "this row is not in Reco"', g12.withExtra);
  }

  /* ====================================================================
     G14 — two panes (run before G13 so the big fixture does not sit in memory)
     ==================================================================== */
  section(14, 'G14: two panes, no duplicate ids on the template editor or the grid');

  const g14 = await page.evaluate(async (ids) => {
    const [a, b] = ids;
    App.navigate('reco');
    AppState.activeRecoId = a;
    const opened = Panes.openSplit(b);
    await new Promise(r => setTimeout(r, 60));
    const grid = Panes.dupIdAudit();
    // Both panes on the template editor screen
    RecoTemplate.edit(a);
    await new Promise(r => setTimeout(r, 40));
    const editor = Panes.dupIdAudit();
    App.closeModal();
    Panes.closeSplit('p1');
    await new Promise(r => setTimeout(r, 40));
    return { opened, grid, editor, single: Panes.dupIdAudit() };
  }, [G2_TPL, G10_TPL]);
  check(g14.opened === true, 'the second pane opened', g14.opened);
  check(g14.grid && g14.grid.ok === true, 'Panes.dupIdAudit() is {ok:true} with both panes on the grid', g14.grid);
  check(g14.editor && g14.editor.ok === true, 'Panes.dupIdAudit() is {ok:true} with the template editor up', g14.editor);
  check(g14.single && g14.single.ok === true, 'and after closing the split', g14.single);

  /* ====================================================================
     ROUND 2 — the review findings. Every gate below FAILED on the build
     the reviewers read (two reviewers, nineteen findings); each one names
     the finding it guards and asserts on VALUES, not on names.
     ==================================================================== */

  /* The three-row accounts master the shared root boots with, written out in
     full rather than captured: G8 edits V1's Nominal on purpose, so whatever
     is in memory by the time this block starts is not the fixture.
     A gate that changes the master hands the next one back exactly this. */
  const RESTORE_MASTER = `(function (rows) { AppState.aegMaster = JSON.parse(JSON.stringify(rows)); })`;
  const MASTER0 = [
    { Reference: 'V1', RC: '100', Nominal: 'VEND-33', SubNominal: '0', AnalysisKey: '0', LOB: '51' },
    { Reference: 'V2', RC: '200', Nominal: 'VEND-44', SubNominal: '0', AnalysisKey: '0', LOB: '52' },
    { Reference: 'V3', RC: '300', Nominal: 'VEND-55', SubNominal: '0', AnalysisKey: '0', LOB: '53' }
  ];
  const restoreMaster = () => page.evaluate(new Function('r', 'return (' + RESTORE_MASTER + ')(r)'), MASTER0);
  await restoreMaster();
  /* The day-file writes one ingest made, read off the BRIDGE and not out of a
     modal: appendUpload has already fired by the time a modal could appear,
     which is the whole point of decision E. */
  const dayWrites = async (tplId) => {
    const folder = await page.evaluate(id => (AppState.recoTemplates.find(x => x.id === id) || {}).dataFolder, tplId);
    return (await bridgeLog(bridge)).filter(c => (c.method === 'append_csv_rows' || c.method === 'write_file')
      && c.arg0 && String(c.arg0).indexOf('reco_data/' + folder + '/') === 0).map(c => c.method + ' ' + c.arg0);
  };

  /* ====================================================================
     G15 — a MANY-TO-ONE derived key is refused BEFORE the share write
     Reviewer A, finding 1 (BLOCKER): an accounts lookup is many-to-one by
     construction, the duplicate-key modal is 35 lines AFTER appendUpload,
     and 60 rows reopened as 3 with no question asked.
     ==================================================================== */
  section(15, 'G15: a many-to-one derived key is refused BEFORE the day file is written');

  const G15_TPL = 'tpl_pkx_g15';
  const g15Setup = await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G15_TPL, name: 'G15', cols: ['Doc', 'Ref', 'Amount'], pk: ['AcctKey'], valueColumn: 'Amount',
    extras: [{ name: 'AcctKey', type: 'master_lookup',
      masterCfg: { source: 'accounts', matchColumn: 'Ref', matchKey: 'Reference', returnKey: 'Nominal' } }]
  });
  check(same(g15Setup.pk, ['AcctKey']), 'the G15 fixture keeps the accounts-lookup extra as the key', g15Setup);
  const G15_ROWS = [];
  for (let i = 0; i < 60; i++) G15_ROWS.push({ Doc: 'D' + i, Ref: 'V' + (1 + i % 3), Amount: '1' });
  await resetLog(bridge);
  await armConfirms(page, false);
  const g15 = await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'), [G15_TPL, G15_ROWS, ['Doc', 'Ref', 'Amount']]);
  await sleep(250);
  const g15Confirms = await readConfirms(page);
  const g15Writes = await dayWrites(G15_TPL);
  check(g15Confirms.length === 1 && /60 row\(s\)/.test(g15Confirms[0]) && /57/.test(g15Confirms[0]),
    'the operator is asked BEFORE the write, and the question counts the rows that share a key (57 of 60)', g15Confirms);
  check(/VEND-33/.test(g15Confirms[0] || ''), 'and names an example key, so the operator can see WHICH key collapsed', (g15Confirms[0] || '').slice(0, 300));
  check(g15Writes.length === 0, 'answering No wrote NOTHING to the share — not one append_csv_rows', g15Writes);
  check(g15.n === 0, 'and nothing reached the session', g15);
  /* The negative control: the same lookup, one master row per extract row, is
     a unique key and must load in silence. A refusal that fires on a sound
     key is worse than none. */
  await page.evaluate(() => { AppState.aegMaster = [];
    for (let i = 0; i < 12; i++) AppState.aegMaster.push({ Reference: 'U' + i, RC: '1', Nominal: 'N' + i, SubNominal: '0', AnalysisKey: '0', LOB: '1' }); });
  const G15_OK = [];
  for (let i = 0; i < 12; i++) G15_OK.push({ Doc: 'E' + i, Ref: 'U' + i, Amount: '1' });
  await resetLog(bridge);
  await armConfirms(page, false);
  const g15b = await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'), [G15_TPL, G15_OK, ['Doc', 'Ref', 'Amount']]);
  const g15bConfirms = await readConfirms(page);
  const g15bWrites = await dayWrites(G15_TPL);
  check(g15bConfirms.length === 0 && g15b.n === 12 && g15bWrites.length === 1,
    'CONTROL: a one-to-one lookup key loads 12 rows in silence and writes the day file once',
    { confirms: g15bConfirms, n: g15b.n, writes: g15bWrites });
  await restoreMaster();
  await armConfirms(page, true);

  /* ====================================================================
     G16 — a two-component key with BOTH cells blank
     Reviewer A, finding 2 (BLOCKER): parts.join('||') is '||', which is
     TRUTHY, so the _auto_ fallback never fires and 25 bank lines collapse
     onto one key — 30 rows reopened as 6.
     ==================================================================== */
  section(16, "G16: a two-component key with EVERY component blank is refused before the write");

  const G16_TPL = 'tpl_pkx_g16';
  await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G16_TPL, name: 'G16', cols: ['Doc', 'Ref', 'Amount', 'Narr'], pk: ['Doc', 'Ref'], valueColumn: 'Amount'
  });
  const G16_ROWS = [];
  for (let i = 0; i < 5; i++) G16_ROWS.push({ Doc: 'D' + i, Ref: 'R' + i, Amount: '1', Narr: 'good' });
  for (let i = 0; i < 25; i++) G16_ROWS.push({ Doc: '', Ref: '', Amount: '1', Narr: 'bank line ' + i });
  await resetLog(bridge);
  await armConfirms(page, false);
  const g16 = await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'), [G16_TPL, G16_ROWS, ['Doc', 'Ref', 'Amount', 'Narr']]);
  await sleep(250);
  const g16Confirms = await readConfirms(page);
  const g16Writes = await dayWrites(G16_TPL);
  check(g16Confirms.length === 1 && /25 row\(s\)/.test(g16Confirms[0]),
    'the operator is asked, and the question counts the 25 rows whose whole key is blank', g16Confirms);
  check(g16Writes.length === 0 && g16.n === 0,
    'answering No loaded nothing and wrote nothing', { writes: g16Writes, n: g16.n });
  /* The mint's own counter, read directly: 25 all-blank rows on a
     two-component key, and they are the rows that matter. */
  const g16Acc = await page.evaluate(id => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push({ Doc: 'D' + i, Ref: 'R' + i });
    for (let i = 0; i < 25; i++) rows.push({ Doc: '', Ref: '' });
    const a = Reco._mintKeysSync(tpl, AppState.recoSessions[id], rows);
    return { partial: a.partial, allBlank: a.allBlank, badBlank: a.badBlank,
             pkOfBlank: rows[29]._pk, distinct: a.distinct, keyed: a.keyed };
  }, G16_TPL);
  check(g16Acc.allBlank === 25 && g16Acc.badBlank === 25,
    "the mint counts all-blank rows AND counts them as BAD on a multi-component key (the '||' collapse)", g16Acc);
  await armConfirms(page, true);

  /* ====================================================================
     G17 — a single-component DERIVED key whose lookup misses
     Reviewer B, finding 4 (HIGH). And the CONTROL that the floor was
     narrowed to protect: a single TEMPLATE-column key with blank cells on a
     bank extract stays silent, because each such row gets its own _auto_
     uid and nothing collapses.
     ==================================================================== */
  section(17, 'G17: an unmatched DERIVED key component is counted; a blank FILE column is still silent');

  const G17_TPL = 'tpl_pkx_g17';
  await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G17_TPL, name: 'G17', cols: ['Doc', 'Vend', 'Amount'], pk: ['Look'], valueColumn: 'Amount',
    extras: [{ name: 'Look', type: 'master_lookup',
      masterCfg: { source: 'accounts', matchColumn: 'Vend', matchKey: 'Reference', returnKey: 'Nominal' } }]
  });
  await page.evaluate(() => { AppState.aegMaster = [{ Reference: 'V1', RC: '1', Nominal: 'VEND-33', SubNominal: '0', AnalysisKey: '0', LOB: '1' }]; });
  const G17_ROWS = [];
  for (let i = 0; i < 10; i++) G17_ROWS.push({ Doc: 'D' + i, Vend: i < 2 ? 'V1' : 'Z' + i, Amount: '1' });
  await resetLog(bridge);
  await armConfirms(page, false);
  const g17 = await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'), [G17_TPL, G17_ROWS, ['Doc', 'Vend', 'Amount']]);
  const g17Confirms = await readConfirms(page);
  const g17Writes = await dayWrites(G17_TPL);
  check(g17Confirms.length === 1 && /Look/.test(g17Confirms[0]) && /8 row\(s\)/.test(g17Confirms[0]),
    'the 8 rows whose lookup found nothing are counted, and the component is named', g17Confirms);
  check(g17Writes.length === 0 && g17.n === 0, 'No loaded nothing and wrote nothing', { writes: g17Writes, n: g17.n });
  await restoreMaster();

  const G17B_TPL = 'tpl_pkx_g17b';
  await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G17B_TPL, name: 'G17b', cols: ['Doc', 'Amount', 'Narr'], pk: ['Doc'], valueColumn: 'Amount'
  });
  const G17B_ROWS = [{ Doc: 'INV-1', Amount: '1', Narr: 'a' }];
  for (let i = 0; i < 9; i++) G17B_ROWS.push({ Doc: '', Amount: '1', Narr: 'bank ' + i });
  await resetLog(bridge);
  await armConfirms(page, false);
  const g17b = await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'), [G17B_TPL, G17B_ROWS, ['Doc', 'Amount', 'Narr']]);
  const g17bConfirms = await readConfirms(page);
  const g17bWrites = await dayWrites(G17B_TPL);
  check(g17bConfirms.length === 0 && g17b.n === 10 && g17bWrites.length === 1,
    'CONTROL: a single FILE-column key with 9 blank cells still loads in silence — each row keeps its own _auto_ uid',
    { confirms: g17bConfirms, n: g17b.n, writes: g17bWrites });
  check(g17b.pks.filter(p => String(p).indexOf('_auto_') === 0).length === 9
    && new Set(g17b.pks).size === 10, 'and those 9 rows have NINE different storage keys, so none of them collapses', {
      distinct: new Set(g17b.pks).size, autos: g17b.pks.filter(p => String(p).indexOf('_auto_') === 0).length });
  await armConfirms(page, true);

  /* ====================================================================
     G18 — '_auto_' is NOT a business key
     Reviewer B, finding 1 (BLOCKER): rowKey handed the throwaway uid to the
     twenty converted readers, so manualOffsetMaster, correctionMaster,
     groupMaster and commentMaster on the SHARE filled with a new unreachable
     uid on every load. Reviewer B, finding 9 (LOW): data-pk with it.
     ==================================================================== */
  section(18, "G18: a blank key cell gives no business key — nothing reaches the four shared files");

  const G18_TPL = 'tpl_pkx_g18';
  await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G18_TPL, name: 'G18', cols: ['Doc', 'Amount', 'Status'], pk: ['Doc'], valueColumn: 'Amount',
    editable: ['Status'], toleranceValue: 1e9
  });
  await armConfirms(page, true);
  await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'), [G18_TPL,
    [{ Doc: 'INV-1', Amount: '1', Status: '' }, { Doc: '', Amount: '2', Status: '' },
     { Doc: 'INV-3', Amount: '3', Status: '' }, { Doc: '', Amount: '4', Status: '' }],
    ['Doc', 'Amount', 'Status']]);
  const g18 = await page.evaluate(async (id) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    sess.data.forEach((r, i) => { r._id = 'g18r' + i; });
    Reco._invalidateIdx(sess);
    App.navigate('reco');
    const blank = sess.data[1], blank2 = sess.data[3];
    window.__toasts = [];
    Reco.manualOffset(1, 'p0', blank._id);
    Reco.applyCorrection(3, 'Status', 'Fixed', 'p0', blank2._id);
    sess.selectedRows = {}; sess.selectedRows[blank._id] = true;
    const sel = Reco._selectedPks('p0');
    await AppState.flush();
    return { pkOnRow: blank._pk, rowKey: Reco.rowKey(tpl, blank), storeKey: Reco.storeKey(tpl, blank),
      keyed: Reco.rowKey(tpl, sess.data[0]), sel: sel,
      dataPk: [...document.querySelectorAll('.reco-table-wrap tbody tr')].map(tr => tr.getAttribute('data-pk')),
      offsetRan: !!sess.offsets[blank._id], corrRan: !!blank2['_corrected_Status'],
      toasts: (window.__toasts || []).map(t => t.msg) };
  }, G18_TPL);
  check(String(g18.pkOnRow).indexOf('_auto_') === 0, 'the premise: the blank-Doc row carries an _auto_ storage key', g18);
  check(g18.offsetRan && g18.corrRan, 'the premise: the offset and the correction both RAN', g18);
  check(g18.rowKey === null && g18.storeKey === null,
    'rowKey and storeKey both answer NULL for an _auto_ key — it means "this row has no business key", which is what getRowPK\'s "" meant', g18);
  check(g18.keyed === 'INV-1', 'and a row WITH a key still answers with it', g18);
  check(same(g18.sel, []), '_selectedPks offers no uid to Groups or Comments', g18.sel);
  check(same(g18.dataPk, ['INV-1', '', 'INV-3', '']),
    'data-pk is empty on those rows, so the tbody is byte-identical to the older build again (decision O)', g18.dataPk);
  const g18Off = readJsonFile(root, 'manualOffsetMaster') || {};
  const g18Corr = readJsonFile(root, 'correctionMaster') || {};
  check(!g18Off[G18_TPL] || !Object.keys(g18Off[G18_TPL]).length,
    'NOTHING reached manualOffsetMaster.json ON THE SHARE', g18Off[G18_TPL]);
  check(!g18Corr[G18_TPL] || !Object.keys(g18Corr[G18_TPL]).length,
    'NOTHING reached correctionMaster.json ON THE SHARE', g18Corr[G18_TPL]);

  /* ====================================================================
     G19 — a row typed into the grid DOES have a storage identity
     Reviewer A, finding 7 / reviewer B, finding 10: _ssBlankRow set no _pk,
     so "Correction applied" was a lie and Create Group answered
     "Select rows first" about a row the operator had selected.
     ==================================================================== */
  section(19, 'G19: a row typed in with + Row HAS a business key, and still writes nothing to the day file');

  await resetLog(bridge);
  const g19 = await page.evaluate(async (id) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    window.prompt = (q, d) => (/name/i.test(String(q)) ? 'G19' : '');
    Reco.ssAddRow(false);
    const row = sess.data[sess.data.length - 1];
    row.Doc = 'TYPED-1'; row.Amount = '0';
    Reco._invalidateIdx(sess);
    window.__toasts = [];
    Reco.manualOffset(0, 'p0', row._id);
    Reco.applyCorrection(0, 'Status', 'Fixed', 'p0', row._id);
    sess.selectedRows = {}; sess.selectedRows[row._id] = true;
    const sel = Reco._selectedPks('p0');
    Reco.createGroupFromSelection('p0');
    /* The spreadsheet-mode cell writers are guarded by a bare
       `if (row._pk)` and nothing else, so a session row that carried one
       would start appending change rows for itself to the SHARED day file -
       which is the whole difference between + Row and + Persistent Row. */
    sess.activeCell = null;
    await AppState.flush();
    return { pk: row._pk === undefined ? '(undefined)' : row._pk,
      rowKey: Reco.rowKey(tpl, row), sel: sel, id: row._id,
      toasts: (window.__toasts || []).map(t => t.msg),
      memOff: (AppState.manualOffsetMaster[id] || {}),
      memCorr: (AppState.correctionMaster[id] || {}) };
  }, G18_TPL);
  check(g19.pk === '(undefined)',
    'the session row still has NO storage identity — + Row is not + Persistent Row, and four version writers are guarded by `if (row._pk)` alone', g19);
  check(g19.rowKey === 'TYPED-1' && same(g19.sel, ['TYPED-1']),
    'rowKey answers with the key the operator typed — the same key Reco.applyEdits writes its history under — and _selectedPks offers it',
    { rowKey: g19.rowKey, sel: g19.sel });
  check(!!g19.memOff['TYPED-1'] && !!(g19.memCorr['TYPED-1'] || {}).Status
    && g19.memCorr['TYPED-1'].Status.newVal === 'Fixed',
    'the offset and the correction are both recorded under it — "Correction applied" is no longer a lie', {
      off: g19.memOff['TYPED-1'], corr: g19.memCorr['TYPED-1'] });
  check(g19.toasts.some(t => /created with 1 member/.test(t)) && !g19.toasts.some(t => /Select rows first/.test(t)),
    'and Create Group from Selection makes the group instead of saying "Select rows first"', g19.toasts);
  const g19Writes = await dayWrites(G18_TPL);
  check(g19Writes.length === 0,
    'and NOTHING was appended to the day file on the share for a session-only row', g19Writes);
  /* And the point of using the typed key rather than a session uid: the
     correction reaches the invoice when the extract next contains it. */
  await armConfirms(page, true);
  const g19b = await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'),
    [G18_TPL, [{ Doc: 'TYPED-1', Amount: '9', Status: '' }], ['Doc', 'Amount', 'Status']]);
  const g19c = await page.evaluate(id => {
    const sess = AppState.recoSessions[id];
    const r = sess.data[sess.data.length - 1];
    return { pk: r._pk, status: r.Status, flagged: !!r['_corrected_Status'] };
  }, G18_TPL);
  check(g19c.pk === 'TYPED-1' && g19c.status === 'Fixed' && g19c.flagged,
    'the correction filed on the hand-added row is APPLIED to the uploaded row with that key', { g19b: g19b.pks, g19c });

  /* ====================================================================
     G20 — the master refusal follows the DEPENDENCY, not the key set
     Reviewer A, finding 3 (HIGH): a key FORMULA reading a non-key lookup was
     minted from an empty accounts master with no question asked.
     ==================================================================== */
  section(20, 'G20: a master a key component DEPENDS on is checked too — and an unrelated one is not');

  const G20_TPL = 'tpl_pkx_g20';
  const g20Setup = await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G20_TPL, name: 'G20', cols: ['Doc', 'Ref', 'Amount'], pk: ['Key'], valueColumn: 'Amount',
    extras: [
      { name: 'Look', type: 'master_lookup', masterCfg: { source: 'accounts', matchColumn: 'Ref', matchKey: 'Reference', returnKey: 'Nominal' } },
      { name: 'Key', type: 'formula', formula: 'CONCAT({Doc},"-",{Look})' }
    ]
  });
  check(same(g20Setup.pk, ['Key']), 'the G20 fixture keys on a formula over a NON-key lookup', g20Setup);
  await page.evaluate(() => { AppState.aegMaster = []; });
  await resetLog(bridge);
  await armConfirms(page, true);
  const g20 = await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'),
    [G20_TPL, [{ Doc: 'D1', Ref: 'V1', Amount: '1' }, { Doc: 'D2', Ref: 'V2', Amount: '2' }], ['Doc', 'Ref', 'Amount']]);
  const g20Writes = await dayWrites(G20_TPL);
  const g20Problem = await page.evaluate(id => Reco._keyMasterProblem(AppState.recoTemplates.find(x => x.id === id)), G20_TPL);
  const g20Toasts = await readToasts(page);
  check(Array.isArray(g20Problem) && g20Problem.length === 1 && /Look/.test(g20Problem[0]),
    '_keyMasterProblem names the lookup the key is built FROM, not only the key columns', g20Problem);
  check(g20.n === 0 && g20Writes.length === 0 && g20Toasts.some(t => /Nothing was loaded/.test(t.msg)),
    'the ingest is HARD-refused: nothing loaded, nothing written', { n: g20.n, writes: g20Writes });
  /* The control that keeps the refusal honest: an extra that is NOT in the
     key's dependency closure, whose master is empty, must not refuse
     anything. A document-number master is empty at the start of every month. */
  const G20B_TPL = 'tpl_pkx_g20b';
  await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G20B_TPL, name: 'G20b', cols: ['Doc', 'Line', 'Amount'], pk: ['Key'], valueColumn: 'Amount',
    extras: [
      { name: 'Unrelated', type: 'master_lookup', masterCfg: { source: 'docNumbers', matchColumn: 'Doc', matchKey: 'DocNumber', returnKey: 'AccountingId' } },
      { name: 'Key', type: 'formula', formula: 'CONCAT({Doc},"-",{Line})' }
    ]
  });
  await resetLog(bridge);
  const g20b = await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'),
    [G20B_TPL, [{ Doc: 'D1', Line: '1', Amount: '1' }, { Doc: 'D2', Line: '2', Amount: '2' }], ['Doc', 'Line', 'Amount']]);
  const g20bProblem = await page.evaluate(id => Reco._keyMasterProblem(AppState.recoTemplates.find(x => x.id === id)), G20B_TPL);
  const g20bWrites = await dayWrites(G20B_TPL);
  check(g20bProblem === null && same(g20b.pks, ['D1-1', 'D2-2']) && g20bWrites.length === 1,
    'CONTROL: an added column the key does NOT read, with an empty master, refuses nothing',
    { problem: g20bProblem, pks: g20b.pks, writes: g20bWrites });
  await restoreMaster();

  /* ====================================================================
     G21 — a lookup key may not match on a column the user types in
     Reviewer A, finding 4 (HIGH): the master_lookup arm checked the source
     and the completeness and never looked at matchColumn, so a key could
     match on a dropdown — always '' at mint time, so every row fell to
     _auto_ while the grid printed a populated key column.
     ==================================================================== */
  section(21, 'G21: a master_lookup key component must match on a column that is itself key-eligible');

  const g21 = await page.evaluate(() => {
    const base = { columns: [{ name: 'Doc' }, { name: 'Vend' }], primaryKeys: ['AK'] };
    const mk = extras => Object.assign({}, base, { additionalColumns: extras });
    const look = (match) => ({ name: 'AK', type: 'master_lookup',
      masterCfg: { source: 'accounts', matchColumn: match, matchKey: 'Reference', returnKey: 'Nominal' } });
    return {
      typed: RecoTemplate._pkEligible(mk([{ name: 'Pick', type: 'dropdown', options: ['V1'] }, look('Pick')]), 'AK'),
      below: RecoTemplate._pkEligible(mk([look('Later'), { name: 'Later', type: 'formula', formula: 'CONCAT({Doc})' }]), 'AK'),
      missing: RecoTemplate._pkEligible(mk([look('Nope')]), 'AK'),
      fileCol: RecoTemplate._pkEligible(mk([look('Vend')]), 'AK'),
      earlierOk: RecoTemplate._pkEligible(mk([{ name: 'Up', type: 'formula', formula: 'CONCAT({Doc})' }, look('Up')]), 'AK')
    };
  });
  check(g21.typed.ok === false && /by hand/.test(g21.typed.reason),
    'a lookup matching on a DROPDOWN is refused, and the reason says the match column is typed in by hand', g21.typed);
  check(g21.below.ok === false && /declared after|above/.test(g21.below.reason),
    'a lookup matching on a column declared BELOW it is refused and told to move it up', g21.below);
  check(g21.missing.ok === false && /no column/.test(g21.missing.reason),
    'a lookup matching on a column that does not exist is refused by name', g21.missing);
  check(g21.fileCol.ok === true && g21.earlierOk.ok === true,
    'CONTROL: matching on a file column, or on an earlier eligible formula, is still allowed', g21);
  /* and end to end: saveTemplate drops it rather than minting 2 rows of uid */
  const G21_TPL = 'tpl_pkx_g21';
  const g21Setup = await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G21_TPL, name: 'G21', cols: ['Doc', 'Amount'], pk: ['AK'], valueColumn: 'Amount',
    extras: [{ name: 'Pick', type: 'dropdown', options: ['V1', 'V2'] },
             { name: 'AK', type: 'master_lookup', masterCfg: { source: 'accounts', matchColumn: 'Pick', matchKey: 'Reference', returnKey: 'Nominal' } }]
  });
  check(same(g21Setup.pk, []), 'and saveTemplate no longer keeps such a key', g21Setup);

  /* ====================================================================
     G22 — the definition hash and the confirm follow the DEPENDENCY CLOSURE
     Reviewer B, finding 2 (BLOCKER): editing the NON-key extra a key extra
     is built from re-keyed every row with no confirm and an IDENTICAL
     signature. Reviewer B, finding 6 (MEDIUM): the confirm named the first
     key extra, never the one that moved.
     ==================================================================== */
  section(22, "G22: editing what a key extra is BUILT FROM confirms, moves the signature, and names the right column");

  const G22_TPL = 'tpl_pkx_g22';
  const g22Setup = await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G22_TPL, name: 'G22', cols: ['Doc', 'Line', 'Amount'], pk: ['Key'], valueColumn: 'Amount',
    extras: [{ name: 'Base', type: 'formula', formula: 'CONCAT({Doc},"-",{Line})' },
             { name: 'Key', type: 'formula', formula: 'CONCAT({Base},"/",{Line})' }]
  });
  check(same(g22Setup.pk, ['Key']), 'the G22 fixture keys on a formula over a non-key formula', g22Setup);
  await armConfirms(page, true);
  const g22a = await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'),
    [G22_TPL, [{ Doc: 'D0', Line: '0', Amount: '1' }, { Doc: 'D1', Line: '1', Amount: '1' }], ['Doc', 'Line', 'Amount']]);
  check(same(g22a.pks, ['D0-0/0', 'D1-1/1']), 'day one mints through the closure', g22a.pks);
  const g22 = await page.evaluate(id => {
    const sig1 = XlSchema.tplSignature(AppState.recoTemplates.find(x => x.id === id));
    RecoTemplate.edit(id);
    RecoTemplate._editing.additionalColumns[0].formula = 'CONCAT({Doc},"~",{Line})';
    window.__confirms = []; window.__confirmAnswer = true;
    RecoTemplate.saveTemplate();
    const sig2 = XlSchema.tplSignature(AppState.recoTemplates.find(x => x.id === id));
    return { sig1, sig2, confirms: window.__confirms.slice() };
  }, G22_TPL);
  check(g22.confirms.length === 1 && /Base/.test(g22.confirms[0]) && !/Key/.test(g22.confirms[0]),
    'the confirm fires and names Base — the column that actually moved — not the first key extra', g22.confirms);
  check(g22.sig1 !== g22.sig2,
    'and tplSignature MOVES, so Monday\'s workbook loads back flagged stale instead of raising rowNotInCurrentData', g22);
  /* the no-op bar: a template with no key extras must hash exactly as before */
  const g22sig = await page.evaluate(() => {
    const t = { id: 'x', columns: [{ name: 'Doc' }, { name: 'Amount', isValue: true }], primaryKeys: ['Doc'],
      editableColumns: [], additionalColumns: [{ name: 'Note', type: 'custom' },
        { name: 'Calc', type: 'formula', formula: 'NUM({Amount})*2' }] };
    const a = XlSchema.tplSignature(t);
    t.additionalColumns[1].formula = 'NUM({Amount})*3';
    return { a, b: XlSchema.tplSignature(t) };
  });
  check(g22sig.a === g22sig.b,
    'CONTROL: for a template-column key, editing an unrelated added column still does NOT move the signature (no workbook is marked stale by this change)', g22sig);

  /* ====================================================================
     G23 — the freeze is on the ONE chokepoint every reader shares
     Reviewer A, finding 5 (MEDIUM): filters, slicers, sort and
     find-and-replace read the recomputed value, so the key column could not
     be filtered to the value it printed.
     ==================================================================== */
  section(23, 'G23: after the master moves, a filter and a slicer still match the value the grid prints');

  const G23_TPL = 'tpl_pkx_g23';
  await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G23_TPL, name: 'G23', cols: ['Doc', 'Ref', 'Amount'], pk: ['VK'], valueColumn: 'Amount',
    extras: [{ name: 'VK', type: 'master_lookup', masterCfg: { source: 'accounts', matchColumn: 'Ref', matchKey: 'Reference', returnKey: 'Nominal' } }]
  });
  await armConfirms(page, true);
  await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'),
    [G23_TPL, [{ Doc: 'D1', Ref: 'V1', Amount: '1' }, { Doc: 'D2', Ref: 'V2', Amount: '2' }], ['Doc', 'Ref', 'Amount']]);
  const g23 = await page.evaluate(async (id) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    AppState.aegMaster.find(x => x.Reference === 'V1').Nominal = 'VEND-99';   // a colleague saves the master
    App.navigate('reco');
    const grid = [...document.querySelectorAll('.reco-table-wrap tbody tr')].map(tr => tr.textContent.replace(/\s+/g, ' ').trim());
    const ac = Reco._extraDef(tpl, 'VK');
    const evr = Reco._extraValueForRow(tpl, sess, sess.data[0], ac);
    sess.columnFilters = { VK: [{ op: 'equals', val: 'VEND-33', enabled: true }] };
    const nFrozen = Reco.applyTableFiltersSort(tpl, sess).length;
    sess.columnFilters = { VK: [{ op: 'equals', val: 'VEND-99', enabled: true }] };
    const nMoved = Reco.applyTableFiltersSort(tpl, sess).length;
    sess.columnFilters = {};
    const slic = await Reco._slicerDistinct(tpl, sess, 'VK');
    const vals = (slic && slic.values ? slic.values : slic || []).map(v => (v && v.value !== undefined) ? v.value : v);
    return { pks: sess.data.map(r => r._pk), grid, evr, nFrozen, nMoved, vals, drift: Reco.keyDrift(tpl, sess, sess.data[0]) };
  }, G23_TPL);
  check(g23.evr === 'VEND-33',
    '_extraValueForRow — the one choke point filters, slicers, sort and find-and-replace share — returns the FROZEN component', g23);
  check(g23.nFrozen === 1 && g23.nMoved === 0,
    'so a filter on the value the grid prints (VEND-33) finds the row, and one on the value nothing prints finds none',
    { frozen: g23.nFrozen, moved: g23.nMoved });
  check(g23.vals.indexOf('VEND-33') !== -1 && g23.vals.indexOf('VEND-99') === -1,
    'and the slicer offers VEND-33, not the value no row shows', g23.vals);
  check(g23.drift.drifted === true && same(g23.drift.cols, ['VK']),
    'the drift marker still fires — the freeze did not silence it', g23.drift);
  await restoreMaster();

  /* ====================================================================
     G24 — a key component whose value contains the separator
     Reviewer A, finding 6 (MEDIUM): the split guard inverted decision G
     exactly where it was needed — the cell printed the RECOMPUTED value and
     the marker was structurally unable to fire.
     ==================================================================== */
  section(24, "G24: a key component containing '||' is counted at ingest and marked in the grid");

  const G24_TPL = 'tpl_pkx_g24';
  await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G24_TPL, name: 'G24', cols: ['Doc', 'Ref', 'Amount'], pk: ['Doc', 'VK'], valueColumn: 'Amount',
    extras: [{ name: 'VK', type: 'master_lookup', masterCfg: { source: 'accounts', matchColumn: 'Ref', matchKey: 'Reference', returnKey: 'Nominal' } }]
  });
  await page.evaluate(() => {
    AppState.aegMaster = [{ Reference: 'V1', RC: '1', Nominal: 'A||B', SubNominal: '0', AnalysisKey: '0', LOB: '1' },
                          { Reference: 'V2', RC: '2', Nominal: 'PLAIN', SubNominal: '0', AnalysisKey: '0', LOB: '2' }];
  });
  await resetLog(bridge);
  await armConfirms(page, false);
  const g24a = await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'),
    [G24_TPL, [{ Doc: 'D1', Ref: 'V1', Amount: '1' }, { Doc: 'D2', Ref: 'V2', Amount: '2' }], ['Doc', 'Ref', 'Amount']]);
  const g24Confirms = await readConfirms(page);
  const g24Writes = await dayWrites(G24_TPL);
  check(g24Confirms.length === 1 && /\|\|/.test(g24Confirms[0]) && /VK/.test(g24Confirms[0]),
    "the operator is asked before the write, and the question names the component whose value holds '||'", g24Confirms);
  check(g24Writes.length === 0 && g24a.n === 0, 'answering No loaded nothing and wrote nothing', { writes: g24Writes, n: g24a.n });
  await armConfirms(page, true);
  const g24 = await page.evaluate(new Function('arg', 'return (' + INGEST + ')(arg)'),
    [G24_TPL, [{ Doc: 'D1', Ref: 'V1', Amount: '1' }, { Doc: 'D2', Ref: 'V2', Amount: '2' }], ['Doc', 'Ref', 'Amount']]);
  check(same(g24.pks, ['D1||A||B', 'D2||PLAIN']), 'accepted, the keys mint as they always did (no migration, no escaping)', g24.pks);
  const g24b = await page.evaluate(id => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    AppState.aegMaster.find(x => x.Reference === 'V1').Nominal = 'MOVED';
    AppState.aegMaster.find(x => x.Reference === 'V2').Nominal = 'MOVED2';
    App.navigate('reco');
    const trs = [...document.querySelectorAll('.reco-table-wrap tbody tr')];
    return sess.data.map((r, i) => ({ pk: r._pk, frozen: Reco.keyCellValue(tpl, sess, r, 'VK'),
      cols: Reco.keyDrift(tpl, sess, r).cols,
      marked: trs[i] ? /recalculated/.test(trs[i].textContent) : null }));
  }, G24_TPL);
  check(same(g24b[0].cols, ['VK']) && g24b[0].marked === true,
    "the row whose component holds '||' IS marked — the value on screen is a recalculation and the grid says so", g24b[0]);
  check(same(g24b[1].cols, ['VK']) && g24b[1].marked === true && g24b[1].frozen === 'PLAIN',
    'and the ordinary drifted row behaves exactly as it did: frozen value, marker shown', g24b[1]);
  await restoreMaster();

  /* ====================================================================
     G25 — the prune says what it dropped and why
     Reviewer B, finding 3 (HIGH) / reviewer A, finding 8 / reviewer B,
     finding 11: one arrow mis-click turned a keyed reconciliation into a
     keyless one under a confirm that named neither the column nor the reason.
     ==================================================================== */
  section(25, 'G25: when the save drops a key component, the confirm names it and says why');

  const G25_TPL = 'tpl_pkx_g25';
  await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G25_TPL, name: 'G25', cols: ['Doc', 'Line', 'Amount'], pk: ['Doc', 'Ref'], valueColumn: 'Amount',
    extras: [{ name: 'Base', type: 'formula', formula: 'CONCAT({Doc},"-",{Line})' },
             { name: 'Ref', type: 'formula', formula: 'CONCAT({Base},"/",{Line})' }]
  });
  const g25 = await page.evaluate(id => {
    RecoTemplate.edit(id);
    RecoTemplate._editing.additionalColumns.reverse();        // the Eval arrow
    window.__confirms = []; window.__confirmAnswer = false;
    RecoTemplate.saveTemplate();
    const refused = AppState.recoTemplates.find(x => x.id === id);
    return { confirms: window.__confirms.slice(), pkAfterNo: (refused.primaryKeys || []).slice(),
             orderAfterNo: (refused.additionalColumns || []).map(a => a.name) };
  }, G25_TPL);
  check(g25.confirms.length === 1 && /\bRef\b/.test(g25.confirms[0]) && /declared after/.test(g25.confirms[0]),
    'the confirm NAMES Ref and gives _pkEligible\'s own reason for dropping it', g25.confirms);
  check(/\bDoc\b/.test(g25.confirms[0] || ''), 'and says what the key will be left with', (g25.confirms[0] || '').slice(0, 400));
  check(same(g25.pkAfterNo, ['Doc', 'Ref']) && same(g25.orderAfterNo, ['Base', 'Ref']),
    'and answering No leaves the stored template alone — the key and the column order are untouched', g25);

  /* ====================================================================
     G26 — S11 is gated in BOTH editors
     Reviewer B, finding 7 (MEDIUM): the AEG editor assigned every role in
     the matrix with no check, and the builder's report said otherwise.
     ==================================================================== */
  section(26, 'G26: the AEG editor refuses a Reco key component as the To Account input column');

  const g26 = await page.evaluate(() => {
    /* Built from AEG.makeDefaultTemplate, because the refusal re-renders the
       editor (a <select> still showing a refused column reads as a saved
       setting) and a hand-rolled stub would make AEG.openEditor throw. */
    const at = AEG.makeDefaultTemplate('AEG G26');
    at.id = 'aeg_g26';
    at.inputColumns = [{ name: 'Doc', label: 'Doc' }, { name: 'Other', label: 'Other' }];
    at.variables = []; at.currencyColumn = 'Other'; at.rcColumn = 'Other'; at.valueColumn = 'Other';
    at.aggregateBy = [];
    at.fromAccount = { mode: 'input', inputColumn: 'Other', options: [] };
    at.toAccount = { mode: 'input', inputColumn: 'Other', options: [] };
    at.outputColumns = [{ name: 'Doc', mapping: { type: 'input', inputColumn: 'Doc' } }];
    AppState.aegTemplates = (AppState.aegTemplates || []).filter(x => x.id !== at.id).concat([at]);
    return (AppState.aegTemplates || []).map(x => x.id).indexOf('aeg_g26') !== -1;
  });
  check(g26, 'the G26 fixture has an AEG template with two input columns', g26);
  const G26_TPL = 'tpl_pkx_g26';
  const g26Setup = await page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G26_TPL, name: 'G26', cols: ['Doc', 'Other', 'Amount'], pk: ['Doc'], valueColumn: 'Amount',
    aeg: { enabled: true, aegTemplateId: 'aeg_g26' }
  });
  check(same(g26Setup.pk, ['Doc']), 'and a Reco template keyed on Doc, linked to it', g26Setup);
  const g26r = await page.evaluate(() => {
    AEG.editingTemplate = JSON.parse(JSON.stringify(AppState.aegTemplates.find(x => x.id === 'aeg_g26')));
    window.__toasts = [];
    AEG.setEditingPath('toAccount.inputColumn', 'Doc');
    const toAcc = { val: AEG.editingTemplate.toAccount.inputColumn, toasts: (window.__toasts || []).map(t => t.msg) };
    window.__toasts = [];
    AEG.setEditingPath('fromAccount.inputColumn', 'Doc');
    const fromAcc = { val: AEG.editingTemplate.fromAccount.inputColumn, toasts: (window.__toasts || []).map(t => t.msg) };
    window.__toasts = [];
    AEG.setEditingPath('toAccount.inputColumn', 'Other');
    const ok = { val: AEG.editingTemplate.toAccount.inputColumn, toasts: (window.__toasts || []).map(t => t.msg) };
    App.closeModal();
    return { toAcc, fromAcc, ok };
  });
  check(g26r.toAcc.val === 'Other' && g26r.toAcc.toasts.length === 1 && /row key/.test(g26r.toAcc.toasts[0]),
    'the AEG editor REFUSES it, leaves the field alone, and says why', g26r.toAcc);
  check(g26r.fromAcc.val === 'Doc' && g26r.fromAcc.toasts.length === 0,
    'CONTROL: the From Account column is READ, not written, so a key component may still be one (the matrix, not a blanket ban)', g26r.fromAcc);
  check(g26r.ok.val === 'Other' && g26r.ok.toasts.length === 0, 'CONTROL: an ordinary column is assigned with no complaint', g26r.ok);

  /* ====================================================================
     G27 — the picker cannot hang the template editor
     Reviewer B, finding 8 (MEDIUM): _pkEligible recursed with no memo, 3^N
     in the length of a chain of formula extras — 2,325 ms at N=14 and
     unbounded above it, on the one screen with no busy overlay.
     ==================================================================== */
  section(27, 'G27: _pkEligible over a chain of 16 formula extras, three rounds taking the minimum');

  const g27 = await page.evaluate(() => {
    const N = 16;
    const t = { columns: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], primaryKeys: [], additionalColumns: [] };
    t.additionalColumns.push({ name: 'X0', type: 'formula', formula: 'CONCAT({A},{B},{C})' });
    for (let i = 1; i < N; i++) t.additionalColumns.push({ name: 'X' + i, type: 'formula',
      formula: 'CONCAT({X' + (i - 1) + '},{X' + (i - 1) + '},{X' + (i - 1) + '})' });
    t.primaryKeys = ['X' + (N - 1)];
    const times = []; let last = null;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      last = RecoTemplate._pkEligible(t, 'X' + (N - 1));
      times.push(performance.now() - t0);
    }
    /* what renderStep2 actually pays: one call per added column */
    const t1 = performance.now();
    t.additionalColumns.forEach(a => RecoTemplate._pkEligible(t, a.name));
    const whole = performance.now() - t1;
    return { N, times, min: Math.min.apply(null, times), whole, ok: last.ok, reason: last.reason };
  });
  note('_pkEligible over a chain of ' + g27.N + ', three rounds (ms)', g27.times.map(t => Math.round(t)));
  check(g27.min < 250, 'one call takes ' + Math.round(g27.min) + 'ms, not the minutes the un-memoised recursion took', g27);
  check(g27.whole < 250, 'and the whole picker block (one call per added column) takes ' + Math.round(g27.whole) + 'ms', { whole: g27.whole });
  check(g27.ok === true, 'and the answer is still right: a chain of eligible formulas is eligible', g27);

  /* ====================================================================
     G13 — cost at 500,000 rows
     ==================================================================== */
  section(13, 'G13: the mint pass at ' + BIG.toLocaleString('en-US') + ' rows, best of 3 taking the minimum');

  const bigRoot = makeRoot('big').root;
  const bridgeBig = await startBridge(bigRoot, PORT_BIG);
  procs.push(bridgeBig.proc);
  const BIGS = await openReco(browser, bridgeBig);
  const G13_TPL = 'tpl_pkx_g13';
  await BIGS.page.evaluate(new Function('arg', 'return (' + SETUP + ')(arg)'), {
    tplId: G13_TPL, name: 'G13', cols: ['Doc', 'Seq', 'Amount', 'Ref', 'Vend'], pk: ['Key'], valueColumn: 'Amount',
    extras: [
      { name: 'Base', type: 'formula', formula: 'CONCAT("B-",{Doc})' },
      { name: 'Line', type: 'formula', formula: 'CONCAT("L",{Seq})' },
      { name: 'Key', type: 'formula', formula: 'CONCAT({Base},"-",{Line})' }
    ]
  });
  const g13 = await BIGS.page.evaluate(async (arg) => {
    const [tplId, n] = arg;
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const sess = AppState.recoSessions[tplId];
    if ((tpl.primaryKeys || []).length !== 1) return { error: 'the fixture key was pruned: ' + JSON.stringify(tpl.primaryKeys) };
    if (typeof Reco._mintKeys !== 'function') return { error: 'NO Reco._mintKeys' };
    const times = [];
    let last = null, busy = 0;
    for (let k = 0; k < 3; k++) {
      const rows = new Array(n);
      for (let i = 0; i < n; i++) rows[i] = { _id: 'i' + i, Doc: 'D' + (i % 9973), Seq: String(i),
        Amount: String(i % 997), Ref: 'R' + i, Vend: 'V' + (1 + (i % 3)) };
      window.__busy = [];
      const t0 = performance.now();
      last = await Reco._mintKeys(tpl, sess, rows);
      times.push(performance.now() - t0);
      busy = Math.max(busy, (window.__busy || []).length);
      // Spot-check one row per round, so a fast-but-wrong pass cannot pass.
      if (rows[n - 1]._pk !== 'B-D' + ((n - 1) % 9973) + '-L' + (n - 1)) return { error: 'wrong _pk: ' + rows[n - 1]._pk };
    }
    return { times, min: Math.min.apply(null, times), busy, result: last && { minted: last.minted } };
  }, [G13_TPL, BIG]);
  if (g13.error) check(false, 'G13 could not run: ' + g13.error);
  else {
    note('mint pass over ' + BIG + ' rows, three rounds (ms)', g13.times.map(t => Math.round(t)));
    check(g13.min < MINT_BUDGET_MS,
      'the mint pass over ' + BIG + ' rows took ' + Math.round(g13.min) + 'ms (min of 3), under the ' + MINT_BUDGET_MS + 'ms budget', g13.times);
    check(g13.busy > 0, 'the progress feedback APPEARED — the pass is chunked, not one blocking loop', { busyCalls: g13.busy });
    check(g13.result && g13.result.minted === BIG, 'every row was minted', g13.result);
  }
  await BIGS.ctx.close();

  /* ---------------------------------------------------------------- */
  /* ====================================================================
     [29] G29 — THE MIGRATION PROMISE, on the arm round 2 widened
     ==================================================================== */
  section(29, 'G29: duplicates are questioned BEFORE the write only on a DERIVED key, never on a '
    + 'key made of template columns');

  const g29 = await (async () => {
    const out = {};
    /* (a) The ordinary shape this must not disturb: an AP extract keyed on a
       document number with several lines per document. Nine rows, three docs.
       Round 2 asked "Load them anyway?" FIRST and loaded nothing on Cancel —
       on a template nobody had changed. */
    await page.evaluate(new Function('cfg', 'return ' + SETUP + '(cfg)'),
      { tplId: 'tpl_g29_plain', pk: ['Doc'], cols: ['Doc', 'Ref', 'Amount'] });
    out.plain = await page.evaluate(new Function('arg', 'return ' + `(async function (arg) {
      const [tplId] = arg;
      const tpl = AppState.recoTemplates.find(x => x.id === tplId);
      const rows = [];
      for (let i = 0; i < 9; i++) rows.push({ Doc: 'D' + (i % 3), Ref: 'R' + i, Amount: '10' });
      const seen = [];
      const oc = window.confirm;
      window.confirm = (m) => { seen.push(String(m)); return false; };   // CANCEL
      try {
        const r = Reco.ingestData(tpl, rows, ['Doc', 'Ref', 'Amount']);
        if (r && typeof r.then === 'function') await r;
      } finally { window.confirm = oc; }
      await new Promise(res => setTimeout(res, 80));
      const sess = AppState.recoSessions[tplId];
      return { confirms: seen, rows: sess.data.length,
               dupPanel: /Duplicate primary key/i.test(document.body.textContent) };
    })` + '(arg)'), ['tpl_g29_plain']);

    /* (b) A DERIVED key, same duplicate shape. Here the duplicate IS new
       information — the formula collapsed rows that arrived distinct — so it
       must still be asked before anything is written. */
    await page.evaluate(new Function('cfg', 'return ' + SETUP + '(cfg)'),
      { tplId: 'tpl_g29_derived', pk: ['K'], cols: ['Doc', 'Ref', 'Amount'],
        extras: [{ name: 'K', type: 'formula', formula: 'CONCAT("K-",{Doc})' }] });
    out.derived = await page.evaluate(new Function('arg', 'return ' + `(async function (arg) {
      const [tplId] = arg;
      const tpl = AppState.recoTemplates.find(x => x.id === tplId);
      const rows = [];
      for (let i = 0; i < 9; i++) rows.push({ Doc: 'D' + (i % 3), Ref: 'R' + i, Amount: '10' });
      const seen = [];
      const oc = window.confirm;
      window.confirm = (m) => { seen.push(String(m)); return false; };
      try {
        const r = Reco.ingestData(tpl, rows, ['Doc', 'Ref', 'Amount']);
        if (r && typeof r.then === 'function') await r;
      } finally { window.confirm = oc; }
      await new Promise(res => setTimeout(res, 80));
      return { confirms: seen, rows: AppState.recoSessions[tplId].data.length };
    })` + '(arg)'), ['tpl_g29_derived']);

    /* (c) The arms that must still fire on a TEMPLATE-COLUMN key, because each
       reports something silently wrong on today's data too. Two components,
       one blank on every row: the key becomes the truthy '||'. */
    await page.evaluate(new Function('cfg', 'return ' + SETUP + '(cfg)'),
      { tplId: 'tpl_g29_blank', pk: ['Doc', 'Ref'], cols: ['Doc', 'Ref', 'Amount'] });
    out.blank = await page.evaluate(new Function('arg', 'return ' + `(async function (arg) {
      const [tplId] = arg;
      const tpl = AppState.recoTemplates.find(x => x.id === tplId);
      const rows = [{ Doc: '', Ref: '', Amount: '1' }, { Doc: '', Ref: '', Amount: '2' }];
      const seen = [];
      const oc = window.confirm;
      window.confirm = (m) => { seen.push(String(m)); return false; };
      try {
        const r = Reco.ingestData(tpl, rows, ['Doc', 'Ref', 'Amount']);
        if (r && typeof r.then === 'function') await r;
      } finally { window.confirm = oc; }
      await new Promise(res => setTimeout(res, 80));
      return { confirms: seen, rows: AppState.recoSessions[tplId].data.length };
    })` + '(arg)'), ['tpl_g29_blank']);
    /* This section cancels three ingests deliberately and asserts the outcome
       of each above, so its own 'Nothing was loaded' toasts are expected.
       Remove exactly those from the shared log — section 28 must keep refusing
       that toast anywhere it was NOT asked for, so widening its allowance
       instead would hide the next real one. */
    out.cleared = await page.evaluate(() => {
      const before = (window.__toasts || []).length;
      window.__toasts = (window.__toasts || []).filter(t => t.msg !== 'Nothing was loaded');
      return before - window.__toasts.length;
    });
    return out;
  })();

  /* THE ASSERTION THAT WOULD HAVE CAUGHT IT. Reading the CONFIRM TEXT, not a
     count: round 2's version asked a question whose wording named the
     duplicates, and a rows-only assertion passes either way once the operator
     says yes. */
  check(g29.plain.confirms.length === 0,
    'G29: nine rows over three document numbers on a TEMPLATE-COLUMN key are not questioned at all — '
    + 'the shape of an ordinary AP extract, on a template nobody has changed',
    g29.plain.confirms);
  check(g29.plain.rows === 9,
    'G29: and all nine are loaded, exactly as before this feature — a Cancel the operator was never '
    + 'asked for cannot lose them', g29.plain);
  check(g29.derived.confirms.some(m => /share a row key/i.test(m)),
    'G29: the same duplicate shape on a DERIVED key IS questioned before the write — there the '
    + 'formula collapsed rows that arrived distinct, which is new information',
    g29.derived.confirms);
  check(g29.derived.rows === 0,
    'G29: and Cancel on the derived key writes nothing', g29.derived);
  check(g29.blank.confirms.some(m => /row key/i.test(m)) && g29.blank.rows === 0,
    'G29: an all-blank two-part key on a TEMPLATE-COLUMN key is STILL refused — it collapses onto '
    + "the truthy '||' and that is silently wrong on today's templates too", g29.blank);
  check(g29.cleared === 2,
    'G29: and exactly TWO cancels happened — the derived key and the all-blank key, not the plain '
    + 'one. This is the same fact as the first check, read from the toast log instead of the '
    + 'confirm log, so a build that asks the question without recording it still fails',
    { cleared: g29.cleared });

  section(28, 'no errors anywhere in the run');
  const toasts = await readToasts(page);
  check(!toasts.some(t => t.kind === 'error' && !/key|empt|#ERR|refus/i.test(t.msg)),
    'no unexpected error toast', toasts.filter(t => t.kind === 'error').slice(0, 6));
  check(S.errors.length === 0, 'no page or console errors', S.errors.slice(0, 6));
  check(BIGS.errors.length === 0, 'no page or console errors in the 500k run', BIGS.errors.slice(0, 6));

} finally {
  clearTimeout(watchdog);
  await browser.close();
  procs.forEach(p => { try { p.kill(); } catch (e) {} });
}

console.log('\n' + (failures ? '✗ ' : '✓ ') + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
