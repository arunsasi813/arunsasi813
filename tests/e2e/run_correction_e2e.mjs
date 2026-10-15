/* #27 — "correction should have otpiont to display more selected columns when needed".
 *
 *     node tests/e2e/run_correction_e2e.mjs
 *
 * The correction tab can now show chosen CONTEXT COLUMNS beside the bad value,
 * so the operator can decide what the value should be without leaving the tab.
 * The choice has two homes and one resolution order: this person on this PC
 * (localStorage, Reco.userPref, TRI-STATE — absent means "not chosen", []
 * means "explicitly none"), then the team default on the template
 * (tpl.correctionContextCols, written only by an explicit button behind a
 * confirm), then the legacy read-only sess.correctionExtraCols, then nothing.
 *
 * The gates, in the order of how much they matter:
 *
 *   T1  With NOTHING chosen the correction panel is BYTE-IDENTICAL to the build
 *       before this change. The whole panel is diffed against `git show
 *       <rev>:apps/Reco.html` served side by side on the same fixture, and the
 *       diff must be ONE PURE INSERTION — the "Show columns" chrome — with the
 *       error table's <thead> and <tbody> identical byte for byte and the row
 *       count still the WHOLE error list. That is what proves decision B (the
 *       cap applies only once a context column is chosen) and decision D (the
 *       five per-tab count passes are untouched).
 *   T2  Apply on the LAST rendered row while the cap is in force changes THAT
 *       row and no other. The Apply button carries an index into sess.data, so
 *       a cap that slices the array instead of bounding the rendered list
 *       corrects a row 60 places away — into the SHARED correctionMaster,
 *       where it re-applies for every colleague on every future load.
 *  T13  With a split open and BOTH panes on the Correction tab,
 *       Panes.dupIdAudit() is {ok:true} (counted here as well, not only
 *       trusted), each pane's chip row is its own, and Apply in the right pane
 *       corrects the right pane's row in the right pane's template.
 *  T14  The picker lives in the ONE shared #appModal, so clicking inside it
 *       re-focuses no pane. The pane is stamped when it OPENS and Done is
 *       REFUSED with a sentence naming both templates if that pane has moved —
 *       the FindReplace._state / Reco._slicerState idiom.
 *
 * Ports 20200-20219.
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
const PORT = 20201;
const PORT_BASE = 20203;      // T1's baseline build, on its own share
const PORT_PANES = 20205;     // T13 / T14
/* The build T1 compares against: the two-panes commit, which is this feature's
   parent and already carries every shared foundation it uses. Override with
   BASE_REV=<rev>. */
const BASE_REV = process.env.BASE_REV || 'd9957fc';

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

/* THE ONE-REGION DIFF T1 rests on. Trim the common head and the common tail
   and what is left is the single region in which the two strings differ. A
   PURE INSERTION leaves `oldText` EMPTY; anything else — a second insertion
   somewhere else, a replacement, a deletion — leaves unchanged bytes stranded
   inside the region and `oldText` is not empty. So "one pure insertion" is a
   real assertion about the whole string, not a hand-waved subset of it. */
function oneDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let ja = a.length, jb = b.length;
  while (ja > i && jb > i && a[ja - 1] === b[jb - 1]) { ja--; jb--; }
  return { at: i, oldText: a.slice(i, ja), newText: b.slice(i, jb) };
}

const APP_REV = process.env.APP_REV || null;
if (APP_REV) console.log('APP_REV=' + APP_REV + ' — running against that build, not the working tree');

/* `fromRev` builds the root around the app as it was at that commit instead of
   the working tree, so T1 can diff two builds that are otherwise running on
   identical, separate shares. Returns root:null when the revision is gone. */
function makeRoot(name, fromRev) {
  fromRev = fromRev || APP_REV;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-corr-'));
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
  await page.waitForSelector('#appMain .panel', { timeout: 20000 });
  await page.evaluate(() => {
    window.__toasts = [];
    const real = U.toast;
    U.toast = function (msg, kind) { window.__toasts.push({ msg: String(msg), kind: kind || '' }); return real.apply(U, arguments); };
    /* EVERY write that leaves this PC, by path. T6's whole claim is that a
       view preference never reaches the shared folder, and the folder is
       reached through exactly one call. */
    window.__writes = [];
    if (window.pywebview && window.pywebview.api && window.pywebview.api.write_file) {
      const rw = window.pywebview.api.write_file.bind(window.pywebview.api);
      window.pywebview.api.write_file = function (p, text) {
        window.__writes.push(String(p));
        return rw(p, text);
      };
    }
    /* Which additional columns were actually EVALUATED, by name. T4 cannot be
       written as "the 13th extra throws": _extraOwnValue CATCHES a throwing
       formula and returns '#ERR' (verified, apps/Reco.html _extraOwnValue), so
       a missing uptoName would be invisible. Counting is the only signal. */
    window.__evals = {};
    const re = Reco._extraOwnValue;
    Reco._extraOwnValue = function (tpl, sess, accum, row, ac, cx) {
      const n = ac && ac.name;
      if (n) window.__evals[n] = (window.__evals[n] || 0) + 1;
      return re.apply(Reco, arguments);
    };
  });
  return { ctx, page, errors };
}
const readToasts = page => page.evaluate(() => (window.__toasts || []).slice());
const clearToasts = page => page.evaluate(() => { window.__toasts = []; });

/* ---------------------------------------------------------------------------
   THE FIXTURE. One template, seven file columns and THIRTEEN additional
   columns — #1 a plain tag, #2 a master_lookup over docNumbers, #3 a formula
   over a file column, then ten more formulas so T4 has something to NOT
   evaluate. 'Ref' carries the format rule the correction tab works on;
   'Second Ref' carries a second one so T9 can switch tabs. 'Posting Date'
   holds Excel serials and 'Description' holds 400 characters, which are T3's
   and T5's subjects.

   Fixed template id, fixed row _ids, no clock anywhere: the same string is
   evaluated in BOTH builds and must produce the same bytes.
--------------------------------------------------------------------------- */
const SETUP = `(function (arg) {
  const [tplId, nRows, nBad, nExtras, withPk] = arg;
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = tplId;
  t.name = 'CORR ' + tplId;
  t.columns = ['Doc', 'Ref', 'Amount', 'Posting Date', 'Description', 'Centre', 'Second Ref']
    .map(n => ({ name: n, label: n, formats: n === 'Ref' ? ['AA-DDDD'] : (n === 'Second Ref' ? ['DDDD'] : []),
                 isValue: n === 'Amount', isDate: false }));
  t.primaryKeys = withPk ? ['Doc'] : [];
  t.valueColumn = 'Amount';
  t.displayColumns = ['Doc', 'Ref', 'Amount', 'Posting Date', 'Description', 'Centre', 'Second Ref'];
  t.enableCorrections = true;
  const extras = [
    { name: 'Note', type: 'custom' },
    { name: 'Acct', type: 'master_lookup',
      masterCfg: { source: 'docNumbers', matchColumn: 'Doc', matchKey: 'DocNumber', returnKey: 'AccountingId' } },
    { name: 'Calc', type: 'formula', formula: 'NUM({Amount})*2' }
  ];
  for (let i = 4; i <= nExtras; i++) extras.push({ name: 'E' + String(i).padStart(2, '0'), type: 'formula', formula: 'CONCAT("e",{Doc})' });
  t.additionalColumns = extras;
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === tplId);
  RecoTemplate.open(tpl.id);
  App.closeModal();
  const sess = AppState.recoSessions[tplId];
  Reco.ensureSessionShape(sess);
  const long = 'L'.repeat(400);
  const data = new Array(nRows);
  for (let i = 0; i < nRows; i++) {
    data[i] = {
      _id: tplId + '_r' + i, _pk: tplId + 'D' + i, _ver: 'upload',
      Doc: tplId + 'D' + i,
      Ref: i < nBad ? ('bad ref ' + i) : 'AB-1234',
      Amount: String((i + 1) * 10),
      'Posting Date': '45292',
      Description: long + i,
      Centre: 'CTR' + (i % 7),
      'Second Ref': (i % 10 === 0) ? '12345' : '1234'
    };
  }
  sess.data = data;
  sess._autoLoadAttempted = true;
  sess.activeSection = 'correction';
  AppState._correctionCol = 'Ref';
  AppState.docNumberMaster[tplId] = {};
  for (let i = 0; i < nRows; i++) AppState.docNumberMaster[tplId][tplId + 'D' + i] = 'ACC-' + i;
  App.navigate('reco');
  return tplId;
})`;

/* THE ERROR TABLE, told apart from the Master List of Corrections that sits in
   the SAME panel ten lines below it. A bare `panel.querySelector('tbody tr')`
   silently picked up a master-list row the moment the suite's own first Apply
   put one there, and read `Reco.removeCorrection(...)` as the handler under
   test. The corrected-value box is what only the error table has. */
const ERRTBL = `(function (panel) {
  const all = [...panel.querySelectorAll('table')];
  return all.find(t => t.querySelector('input[placeholder="Enter corrected value"]')) || all[0] || null;
})`;

/* The correction panel as it stands, in the pieces every gate needs. */
const SNAP = `(function () {
  const errTbl = ${ERRTBL};
  const area = document.getElementById('recoContentArea');
  const panel = area ? area.querySelector('.panel') : null;
  if (!panel) return { missing: true };
  const tbl = errTbl(panel);
  const body = tbl ? [...tbl.querySelectorAll('tbody tr')] : [];
  return {
    panel: panel.outerHTML,
    thead: tbl ? (tbl.querySelector('thead') || {}).outerHTML || '' : '',
    tbody: tbl ? (tbl.querySelector('tbody') || {}).outerHTML || '' : '',
    rows: body.length,
    ths: tbl ? [...tbl.querySelectorAll('thead th')].map(th => th.textContent) : [],
    ctxCols: tbl ? [...tbl.querySelectorAll('tbody tr:first-child td[data-col]')].map(td => td.dataset.col) : [],
    chips: [...panel.querySelectorAll('.corr-ctx .tag')].map(s => s.textContent.replace(/\\s*×\\s*$/, '').trim()),
    hasShowBtn: !!panel.querySelector('.corr-ctx button'),
    ids: [...panel.querySelectorAll('[id]')].map(e => e.id)
  };
})`;

const watchdog = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 25 * 60 * 1000);
const procs = [];
const browser = await chromium.launch();
try {

  const { root } = makeRoot('shared');
  const bridge = await startBridge(root, PORT);
  procs.push(bridge.proc);
  const S = await openReco(browser, bridge);
  const { page } = S;
  const TPL = 'tpl_corr_fixed';

  /* ====================================================================
     [1] T1 — THE GATE. Nothing chosen: one pure insertion, nothing else.
     ==================================================================== */
  section(1, 'T1: with NOTHING chosen the correction panel is the panel it was');

  await page.evaluate(new Function('arg', 'return ' + SETUP + '(arg)'), [TPL, 300, 260, 13, true]);
  const snapNew = await page.evaluate(new Function('return ' + SNAP + '()'));
  check(!snapNew.missing && snapNew.rows === 260,
    'the premise: 260 unformatted rows offered for correction, ALL of them (no cap with nothing chosen)',
    { rows: snapNew.rows });
  check(snapNew.hasShowBtn, 'the chrome #27 adds is on screen', snapNew.chips);
  check(snapNew.ctxCols.length === 0, 'and NO context cell is rendered, because nothing is chosen', snapNew.ctxCols);

  const baseRoot = makeRoot('baseline', BASE_REV).root;
  if (!baseRoot) {
    check(false, 'T1 NOT RUN: the baseline build ' + BASE_REV + ' could not be checked out');
  } else {
    const bridgeB = await startBridge(baseRoot, PORT_BASE);
    procs.push(bridgeB.proc);
    const B = await openReco(browser, bridgeB);
    await B.page.evaluate(new Function('arg', 'return ' + SETUP + '(arg)'), [TPL, 300, 260, 13, true]);
    const snapOld = await B.page.evaluate(new Function('return ' + SNAP + '()'));

    check(snapOld.rows === snapNew.rows,
      'T1: the SAME NUMBER OF ERROR ROWS is rendered — the cap did not fire with nothing chosen',
      { base: snapOld.rows, now: snapNew.rows });
    check(snapOld.tbody === snapNew.tbody,
      'T1: THE ERROR TABLE <tbody> IS BYTE-IDENTICAL (260 rows, every Apply handler and every idx)',
      snapOld.tbody === snapNew.tbody ? undefined : oneDiff(snapOld.tbody, snapNew.tbody));
    check(snapOld.thead === snapNew.thead, 'T1: the error table <thead> is byte-identical',
      snapOld.thead === snapNew.thead ? undefined : oneDiff(snapOld.thead, snapNew.thead));

    const d = oneDiff(snapOld.panel, snapNew.panel);
    check(d.oldText === '',
      'T1: THE WHOLE PANEL DIFFERS IN EXACTLY ONE PLACE AND IT IS A PURE INSERTION — nothing moved, '
      + 'nothing was replaced, nothing was removed',
      { at: d.at, removed: d.oldText.slice(0, 300), inserted: d.newText.slice(0, 300) });
    /* The minimal diff can start a byte or two inside the inserted block —
       '<div class="' is common to the chrome and to the help line it is
       inserted before — so match on the class and the label, not on the first
       character. `oneDiff` has already proved nothing else moved. */
    check(/class="corr-ctx"/.test(d.newText) && /Show columns/.test(d.newText) && d.newText.length < 1500,
      'T1: and the one inserted block is the "Show columns" chrome, and nothing but it',
      d.newText.slice(0, 300));
    note('inserted ' + d.newText.length + ' bytes at offset ' + d.at + ' of ' + snapOld.panel.length);

    /* The plan's own #27 gate: a correction must still MEAN the same thing. */
    const meaning = async (pg, cols) => pg.evaluate(async (arg) => {
      const [tplId, cols] = arg;
      const tpl = AppState.recoTemplates.find(x => x.id === tplId);
      const sess = AppState.recoSessions[tplId];
      if (cols && typeof Reco.userPref === 'function') Reco.userPref(tplId, 'correctionCols', cols.slice());
      App.navigate('reco');
      await new Promise(r => setTimeout(r, 60));
      const panel = document.querySelector('#recoContentArea .panel');
      const tbl = [...panel.querySelectorAll('table')].find(t => t.querySelector('input[placeholder="Enter corrected value"]'));
      const tr = tbl.querySelector('tbody tr');
      tr.querySelector('input').value = 'ZZ-9999';
      tr.querySelector('button').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      tr.querySelector('button').click();
      await new Promise(r => setTimeout(r, 200));
      const row = sess.data[0];
      const pk = Reco.getRowPK(tpl, row);
      return {
        cell: row.Ref, flag: row['_corrected_Ref'] === true,
        sessCorr: JSON.parse(JSON.stringify((sess.corrections || {})[pk] || null)),
        master: JSON.parse(JSON.stringify((AppState.correctionMaster[tplId] || {})[pk] || null))
      };
    }, [tplId, cols]);
    const tplId = TPL;
    const mOld = await meaning(B.page, null);
    const mNew0 = await meaning(page, null);
    check(same(mOld, mNew0),
      'T1: with ZERO context columns a correction writes EXACTLY what it wrote before — cell, flag, '
      + 'session corrections and the shared correction master', { base: mOld, now: mNew0 });
    await B.ctx.close();
  }

  /* Put the fixture back. T1's own Apply took a row out of the error list and
     put a row into the Master List, and every count below is read from the
     screen — a suite that silently measures 259 where it says 260 is worse
     than one that fails. */
  await page.evaluate((tplId) => {
    const sess = AppState.recoSessions[tplId];
    sess.data[0].Ref = 'bad ref 0';
    delete sess.data[0]['_corrected_Ref'];
    sess.corrections = {};
    delete AppState.correctionMaster[tplId];
  }, TPL);

  /* ====================================================================
     [2] Resolution order, the tri-state, and the stale name
     ==================================================================== */
  section(2, 'the resolution order (T7 tri-state, T12 stale names)');
  /* A SECTION THAT CANNOT RUN AT ALL IS A FAILED SECTION, not a crashed
     suite: the pre-fix run has to report which gates are missing, one line
     each, and that is only possible if a missing helper does not take the
     process out. */
  try {

  const res = await page.evaluate((tplId) => {
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const sess = AppState.recoSessions[tplId];
    const out = {};
    const get = () => {
      const r = Reco.correctionCols(tpl, sess);
      return { cols: r.cols.slice(), dropped: r.dropped, scope: r.scope };
    };
    Reco.userPref(tplId, 'correctionCols', null);
    delete tpl.correctionContextCols;
    sess.correctionExtraCols = [];
    out.nothing = get();

    sess.correctionExtraCols = ['Centre'];
    out.legacyOnly = get();

    tpl.correctionContextCols = ['Centre', 'Amount', 'Calc'];
    out.teamBeatsLegacy = get();

    Reco.userPref(tplId, 'correctionCols', ['Note']);
    out.mineBeatsTeam = get();

    // THE TRI-STATE. [] is a CHOICE — "I do not want any" — and must not fall
    // through to a team default of three columns.
    Reco.userPref(tplId, 'correctionCols', []);
    out.mineEmpty = get();

    // absent again: back to the team default
    Reco.userPref(tplId, 'correctionCols', null);
    out.mineAbsent = get();

    // T12: a name deleted from the template is dropped quietly and COUNTED.
    tpl.correctionContextCols = ['Centre', 'GoneFileCol', 'Calc', 'GoneExtra'];
    out.stale = get();

    tpl.correctionContextCols = ['GoneA', 'GoneB'];
    out.allStale = get();

    delete tpl.correctionContextCols;
    sess.correctionExtraCols = [];
    Reco.userPref(tplId, 'correctionCols', null);
    return out;
  }, TPL);
  check(same(res.nothing.cols, []) && res.nothing.scope === 'none', 'nothing anywhere resolves to []', res.nothing);
  check(same(res.legacyOnly.cols, ['Centre']) && res.legacyOnly.scope === 'legacy',
    'sess.correctionExtraCols is still READ as the bottom fallback', res.legacyOnly);
  check(same(res.teamBeatsLegacy.cols, ['Centre', 'Amount', 'Calc']) && res.teamBeatsLegacy.scope === 'team',
    'the team default on the template outranks the legacy session field', res.teamBeatsLegacy);
  check(same(res.mineBeatsTeam.cols, ['Note']) && res.mineBeatsTeam.scope === 'mine',
    'and this person\'s own choice outranks the team default', res.mineBeatsTeam);
  check(same(res.mineEmpty.cols, []) && res.mineEmpty.scope === 'mine',
    'T7: AN EXPLICIT EMPTY CHOICE IS A CHOICE — it does NOT fall through to the team\'s three columns',
    res.mineEmpty);
  check(same(res.mineAbsent.cols, ['Centre', 'Amount', 'Calc']) && res.mineAbsent.scope === 'team',
    'and clearing the choice away altogether goes back to the team default', res.mineAbsent);
  check(same(res.stale.cols, ['Centre', 'Calc']) && res.stale.dropped === 2,
    'T12: a name no longer in the template is dropped QUIETLY and COUNTED', res.stale);
  check(same(res.allStale.cols, []) && res.allStale.dropped === 2,
    'T12: and a list that prunes to nothing is simply nothing — no throw', res.allStale);

  /* The stale count is on screen, and the panel still renders. */
  const staleView = await page.evaluate(async (tplId) => {
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    tpl.correctionContextCols = ['Centre', 'GoneFileCol'];
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 80));
    const panel = document.querySelector('#recoContentArea .panel');
    const txt = panel ? panel.textContent : '';
    const out = { text: /no longer in this template/i.test(txt), chips: [...panel.querySelectorAll('.corr-ctx .tag')].length,
                  rows: panel.querySelectorAll('tbody tr').length };
    delete tpl.correctionContextCols;
    return out;
  }, TPL);
  check(staleView.text && staleView.chips === 1,
    'T12: the panel says so in one muted line and renders the one column that is left', staleView);

  } catch (e) { check(false, '[2] the resolution order could not be exercised at all',
    String((e && e.message) || e).split('\n')[0].slice(0, 300)); }

  /* ====================================================================
     [3] T3 — values and display go through the ONE display rule
     ==================================================================== */
  section(3, 'T3: an Excel date serial, a master_lookup and a formula render as the grid renders them');

  const vals = await page.evaluate(async (arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    Reco.userPref(tplId, 'correctionCols', ['Posting Date', 'Acct', 'Calc', 'Centre']);
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 120));
    const panel = document.querySelector('#recoContentArea .panel');
    const tr = errTbl(panel).querySelector('tbody tr');
    const cells = {};
    [...tr.querySelectorAll('td[data-col]')].forEach(td => { cells[td.dataset.col] = td.textContent.trim(); });
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const sess = AppState.recoSessions[tplId];
    /* The row the operator is looking at, found the way the renderer finds it
       — the first row whose Ref fails its format and has not been corrected —
       so "what the grid would show" is asked about THAT row and not row 0. */
    const col = tpl.columns.find(c => c.name === 'Ref');
    const row = sess.data.find(r => !FMT.validate(r.Ref, col.formats) && !r['_corrected_Ref']);
    const full = Reco.rowFull(tpl, sess, row);
    /* THE GRID'S OWN RENDERED CELLS. This section's title claims the two
       screens agree about the same cell; asking Reco.displayCellValue on both
       sides compares the implementation with itself and is blind to any step
       the grid applies AFTER it - which is exactly how the per-cell number
       format went missing here for a whole commit (section [F1]). Found by
       the key cell, so it is provably the SAME ROW on both screens. */
    sess.activeSection = 'action';
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 250));
    const gtr = [...document.querySelectorAll('.reco-table-wrap tbody tr')]
      .find(x => { const d = x.querySelector('td[data-col="Doc"]');
                   return d && d.textContent.trim() === row.Doc; });
    const gridDom = {};
    [...(gtr ? gtr.querySelectorAll('td[data-col]') : [])]
      .forEach(td => { gridDom[td.dataset.col] = td.textContent.trim(); });
    sess.activeSection = 'correction';
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 200));
    return { cells, doc: row.Doc, pkShown: tr.children[0].textContent.trim(),
      pkIsCtx: !!tr.children[0].dataset.col, gridDom: gridDom, grid: {
      'Posting Date': String(Reco.displayCellValue(tpl, sess, row, 'Posting Date', full)),
      Acct: String(Reco.displayCellValue(tpl, sess, row, 'Acct', full)),
      Calc: String(Reco.displayCellValue(tpl, sess, row, 'Calc', full)),
      Centre: String(Reco.displayCellValue(tpl, sess, row, 'Centre', full))
    }, raw: row['Posting Date'] };
  }, [TPL, ERRTBL]);
  note('rendered', vals.cells);
  check(vals.raw === '45292' && /^\d\d\/\d\d\/\d\d$/.test(vals.cells['Posting Date'] || ''),
    'T3: an Excel date serial renders as a date (U.formatExcelDate), NOT as the serial 45292',
    { raw: vals.raw, shown: vals.cells['Posting Date'] });
  check(/^ACC-/.test(vals.cells.Acct || ''),
    'T3: a master_lookup column renders the LOOKED-UP value', vals.cells.Acct);
  check(/^\d+$/.test(vals.cells.Calc || '') && vals.cells.Calc === vals.grid.Calc,
    'T3: a formula extra renders its computed value', { shown: vals.cells.Calc, grid: vals.grid.Calc });
  check(same(vals.cells, vals.grid),
    'T3: and every one of them is CHARACTER FOR CHARACTER what Reco.displayCellValue gives the grid',
    { cell: vals.cells, grid: vals.grid });
  const shared = Object.keys(vals.cells).filter(n => Object.prototype.hasOwnProperty.call(vals.gridDom, n));
  note('the grid\'s own rendered cells', vals.gridDom);
  check(shared.indexOf('Posting Date') >= 0 && shared.length >= 2,
    'the premise: the grid really renders the date and at least one more of the chosen columns, so '
    + 'there is something on the other screen to compare against',
    { shared: shared, gridHas: Object.keys(vals.gridDom) });
  check(shared.every(n => vals.cells[n] === vals.gridDom[n]),
    'T3: AND EVERY SHARED COLUMN MATCHES THE GRID\'S RENDERED <td>, character for character - read '
    + 'off the other screen, not asked of the helper under test',
    shared.filter(n => vals.cells[n] !== vals.gridDom[n])
      .map(n => n + ': grid=' + vals.gridDom[n] + ' corr=' + vals.cells[n]));

  /* The PK cell is untouched — decision C. An added column of the same name
     must never be able to shadow the key and print a different value from the
     Master List ten lines below. */
  check(Object.keys(vals.cells).length === 4 && vals.pkShown === vals.doc && !vals.pkIsCtx,
    'decision C: WITH FOUR CONTEXT COLUMNS BESIDE IT the primary-key cell is still U.esc(row[pk]) '
    + 'and is not one of them — an added column of the same name cannot shadow the key',
    { shown: vals.pkShown, doc: vals.doc, isCtx: vals.pkIsCtx, ctx: Object.keys(vals.cells) });

  /* ====================================================================
     [4] T4 — uptoName: the twelve extras after the chosen one are not paid for
     ==================================================================== */
  section(4, 'T4: only the FIRST of thirteen extras is chosen, so twelve are never evaluated');

  const ev = await page.evaluate(async (arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    Reco.userPref(tplId, 'correctionCols', ['Note']);
    window.__evals = {};
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 150));
    const t = errTbl(document.querySelector('#recoContentArea .panel'));
    return { evals: Object.assign({}, window.__evals), rows: t ? t.querySelectorAll('tbody tr').length : 0 };
  }, [TPL, ERRTBL]);
  const after = ['Acct', 'Calc'].concat(Array.from({ length: 10 }, (_, i) => 'E' + String(i + 4).padStart(2, '0')));
  note('evaluations', ev.evals);
  check((ev.evals.Note || 0) >= ev.rows && ev.rows > 0,
    'the premise: the chosen extra IS evaluated, once per rendered row',
    { note: ev.evals.Note, rows: ev.rows });
  /* The premise is part of the assertion on purpose. Before the fix no row was
     enriched at all, so "the other twelve were not evaluated" was true and
     meant nothing — a test that passes before the fix is testing nothing. */
  check((ev.evals.Note || 0) > 0 && after.every(n => !ev.evals[n]),
    'T4: and NONE of the twelve additional columns declared after it was evaluated at all',
    { note: ev.evals.Note, paidFor: after.filter(n => ev.evals[n]).map(n => n + '×' + ev.evals[n]) });

  /* The other half of the same rule: choosing the LAST extra does pay for all
     of them, which is what makes the first half an assertion about uptoName
     rather than about the extras never being walked. */
  const evLast = await page.evaluate(async (tplId) => {
    Reco.userPref(tplId, 'correctionCols', ['E13']);
    window.__evals = {};
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 300));
    return Object.assign({}, window.__evals);
  }, TPL);
  check((evLast.Note || 0) > 0 && (evLast.E13 || 0) > 0,
    'T4: choosing the LAST of the thirteen does walk the whole cascade — the early stop is the chosen set, not an accident',
    { note: evLast.Note, e13: evLast.E13 });

  /* ====================================================================
     [5] T5 — truncation, and Apply still reachable
     ==================================================================== */
  section(5, 'T5: a 400-character context column does not push Apply off the screen');

  const trunc = await page.evaluate(async (arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    Reco.userPref(tplId, 'correctionCols', ['Description']);
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 150));
    const panel = document.querySelector('#recoContentArea .panel');
    const tr = errTbl(panel).querySelector('tbody tr');
    const td = tr.querySelector('td[data-col="Description"]');
    if (!td) return { missing: true };
    const inner = td.firstElementChild;
    const btn = tr.querySelector('button');
    const tbl = errTbl(panel);
    const wrap = tbl.closest('div[style*="overflow-x"]');
    const out = {
      innerWidth: inner ? Math.round(inner.offsetWidth) : -1,
      tdWidth: Math.round(td.offsetWidth),
      tableWidth: Math.round(tbl.offsetWidth),
      hasInner: !!inner && inner.tagName === 'DIV',
      innerOverflow: inner ? getComputedStyle(inner).textOverflow : '',
      innerWhiteSpace: inner ? getComputedStyle(inner).whiteSpace : '',
      tdWhiteSpace: getComputedStyle(td).whiteSpace,
      title: inner ? (inner.getAttribute('title') || '').length : -1,
      shown: inner ? inner.textContent.length : -1,
      hasWrap: !!wrap,
      btnRight: btn ? Math.round(btn.getBoundingClientRect().right) : -1,
      wrapRight: wrap ? Math.round(wrap.getBoundingClientRect().right) : -1
    };
    /* THE MUTATION, because the measure only means something against the
       failure it prevents: take the inner div away and leave the same 400
       characters in the <td>, which is what decision E says ships broken. */
    td.innerHTML = U.esc(inner.getAttribute('title'));
    out.rawTdWidth = Math.round(td.offsetWidth);
    out.rawBtnRight = Math.round(btn.getBoundingClientRect().right);
    out.rawWrapRight = Math.round(wrap.getBoundingClientRect().right);
    return out;
  }, [TPL, ERRTBL]);
  check(!trunc.missing, 'the premise: the 400-character column is rendered as a context cell', trunc);
  /* NOT the <td>: this app's global rule is `table { width: 100% }` (line 71),
     so a table narrower than its container is stretched and the surplus is
     handed round the columns — the <td> ends up ~400px wide while holding a
     180px box, and that number says nothing about truncation. The inner div
     is the box decision E is about and the only one worth measuring. */
  check(trunc.innerWidth > 0 && trunc.innerWidth <= 181,
    'T5: the rendered content box is capped at 180px — the inner div is what table-layout:auto honours',
    { inner: trunc.innerWidth, td: trunc.tdWidth });
  check(trunc.hasInner && trunc.innerOverflow === 'ellipsis' && trunc.innerWhiteSpace === 'nowrap',
    'T5: and the truncation is on an inner DIV, not on the <td>', trunc);
  check(!trunc.missing && trunc.tdWhiteSpace !== 'nowrap',
    'T5: white-space is deliberately left OFF the <td> (decision E)', trunc.tdWhiteSpace);
  check(trunc.title >= 400,
    'T5: the whole value is still readable, on the title attribute', trunc.title);
  check(trunc.hasWrap && trunc.btnRight > 0 && trunc.btnRight <= trunc.wrapRight + 1,
    'T5: AND THE APPLY BUTTON IS STILL INSIDE THE VISIBLE WIDTH of the horizontal scroller',
    { btn: trunc.btnRight, wrap: trunc.wrapRight, table: trunc.tableWidth });
  check(trunc.rawTdWidth > 3 * trunc.innerWidth && trunc.rawBtnRight > trunc.rawWrapRight,
    'T5: and WITHOUT the inner div the same 400 characters blow the column out and push Apply '
    + 'outside the visible width — so the measure is guarding something real',
    { rawTd: trunc.rawTdWidth, rawBtn: trunc.rawBtnRight, rawWrap: trunc.rawWrapRight });

  /* ====================================================================
     [6] T2 — the cap, and Apply on the last rendered row
     ==================================================================== */
  section(6, 'T2: THE GATE — Apply on the LAST rendered row under the cap corrects THAT row');
  try {

  const cap = await page.evaluate(async (arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const sess = AppState.recoSessions[tplId];
    Reco.userPref(tplId, 'correctionCols', ['Centre']);
    Reco._corrMore = {};
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 200));
    const panel = document.querySelector('#recoContentArea .panel');
    const trs = [...errTbl(panel).querySelectorAll('tbody tr')];
    const col = tpl.columns.find(c => c.name === 'Ref');
    const errs = sess.data.filter(r => !FMT.validate(r.Ref, col.formats) && !r['_corrected_Ref']).length;
    return {
      rendered: trs.length, cap: Reco.CORR_ROW_CAP, errs,
      moreBtn: /Show 200 more/.test(panel.textContent),
      saysTotal: new RegExp('Showing 200 of ' + errs).test(panel.textContent),
      lastHandler: trs.length ? trs[trs.length - 1].querySelector('button').getAttribute('onclick') : ''
    };
  }, [TPL, ERRTBL]);
  check(cap.errs > 200 && cap.rendered === 200 && cap.cap === 200,
    'the premise: more error rows than the cap, one context column chosen, 200 rendered', cap);
  check(cap.moreBtn && cap.saysTotal,
    'and the panel offers "Show 200 more" and says how many there are in all', cap);

  const applied = await page.evaluate(async (arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    const sess = AppState.recoSessions[tplId];
    const before = sess.data.map(r => r.Ref);
    const panel = document.querySelector('#recoContentArea .panel');
    const trs = [...errTbl(panel).querySelectorAll('tbody tr')];
    const tr = trs[trs.length - 1];
    /* Which row the operator is looking at, taken from the PRIMARY KEY CELL on
       that very <tr> — not from the handler, because the handler's index is
       exactly what is under test. */
    const pkShown = tr.children[0].textContent.trim();
    tr.querySelector('input').value = 'QQ-7777';
    tr.querySelector('button').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    tr.querySelector('button').click();
    await new Promise(r => setTimeout(r, 300));
    const changed = [];
    sess.data.forEach((r, i) => { if (r.Ref !== before[i]) changed.push({ i, doc: r.Doc, was: before[i], now: r.Ref }); });
    return { pkShown, changed, total: sess.data.length };
  }, [TPL, ERRTBL]);
  note('changed', applied.changed);
  /* The cap being IN FORCE is half of each assertion. Without it the clicked
     row is the 260th and both pass for the wrong reason — which is exactly the
     shape of a test that would not have caught a cap that slices sess.data. */
  check(cap.rendered === 200 && applied.changed.length === 1,
    'T2: WITH THE CAP IN FORCE, EXACTLY ONE ROW CHANGED out of 300 — the cap bounded the rendered '
    + 'list, it did not renumber',
    { rendered: cap.rendered, changed: applied.changed });
  check(cap.rendered === 200 && applied.changed.length === 1
        && applied.changed[0].doc === applied.pkShown && applied.changed[0].now === 'QQ-7777',
    'T2: AND IT IS THE ROW WHOSE BUTTON WAS CLICKED — the primary key on that <tr> is the row that moved',
    { rendered: cap.rendered, clicked: applied.pkShown, changed: applied.changed[0] });

  /* "Show 200 more" raises a module-level counter, and the counter resets when
     the question changes — it is not persisted and it is not on the session. */
  const more = await page.evaluate(async (arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    const rows = () => errTbl(document.querySelector('#recoContentArea .panel')).querySelectorAll('tbody tr').length;
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const sess = AppState.recoSessions[tplId];
    const col = tpl.columns.find(c => c.name === 'Ref');
    const out = { errs: sess.data.filter(r => !FMT.validate(r.Ref, col.formats) && !r['_corrected_Ref']).length };
    Reco.showMoreCorrectionRows();
    await new Promise(r => setTimeout(r, 300));
    out.afterMore = rows();
    out.sessionKeys = Object.keys(sess).filter(k => /corrShown|correctionShown|corrMore/i.test(k));
    // switching the format column resets it
    AppState._correctionCol = 'Second Ref';
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 200));
    AppState._correctionCol = 'Ref';
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 250));
    out.afterTabSwitch = rows();
    return out;
  }, [TPL, ERRTBL]);
  check(more.afterMore === Math.min(more.errs, 400) && more.afterMore > 200,
    '"Show 200 more" raises the cap to 400, so the rest of the list is on screen', more);
  check(more.sessionKeys.length === 0,
    'and the counter is NOT on the session, so it never reaches the share', more.sessionKeys);
  check(more.afterTabSwitch === 200, 'and it resets when the active format column changes', more);

  } catch (e) { check(false, '[6] the cap could not be exercised at all',
    String((e && e.message) || e).split('\n')[0].slice(0, 300)); }

  /* ====================================================================
     [7] T6 / T8 — the scope split: whose choice is it, and what it writes
     ==================================================================== */
  section(7, 'T6: a per-person choice never reaches the shared folder; T8: Clear and the chip × stay local');
  try {

  const scope = await page.evaluate(async (tplId) => {
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    Reco.userPref(tplId, 'correctionCols', null);
    tpl.correctionContextCols = ['Amount', 'Centre', 'Calc'];
    await AppState.flush();
    await new Promise(r => setTimeout(r, 400));
    window.__writes = [];
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 80));
    /* Choose through the real route: the button the operator presses, the
       shared picker, Done. */
    Reco.openCorrectionCols();
    const opened = !!(ColPicker._st && ColPicker._st.mode === 'set');
    ColPicker.toggle('Note', true);
    ColPicker.done();
    await new Promise(r => setTimeout(r, 700));
    return {
      opened,
      mine: Reco.userPref(tplId, 'correctionCols'),
      team: (tpl.correctionContextCols || []).slice(),
      writes: (window.__writes || []).slice(),
      ls: Object.keys(localStorage).filter(k => /correctionCols/.test(k))
    };
  }, TPL);
  check(scope.opened, 'the premise: "Show columns" opens ColPicker in set mode', scope.opened);
  check(same(scope.mine, ['Amount', 'Centre', 'Calc', 'Note']),
    'choosing starts from what is in force and adds to it, in this person\'s own store', scope.mine);
  check(scope.ls.length === 1, 'and that store is localStorage — per person, per PC', scope.ls);
  check(!scope.writes.some(p => /recoSessions\.json|recoTemplates\.json/.test(p)),
    'T6: NOTHING WAS WRITTEN TO THE SHARED FOLDER — not recoSessions.json, not recoTemplates.json',
    scope.writes);
  check(same(scope.team, ['Amount', 'Centre', 'Calc']),
    'T6: and the team default is exactly as it was', scope.team);

  const teamWrite = await page.evaluate(async (tplId) => {
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const out = {};
    // REFUSED without the confirm, and the template is untouched.
    const realConfirm = window.confirm;
    window.confirm = () => false;
    window.__writes = [];
    try { Reco.saveCorrectionColsAsTeam(); } finally { window.confirm = realConfirm; }
    await new Promise(r => setTimeout(r, 600));
    out.afterNo = (tpl.correctionContextCols || []).slice();
    out.writesAfterNo = (window.__writes || []).slice();

    let saw = '';
    window.confirm = (m) => { saw = String(m); return true; };
    window.__writes = [];
    try { Reco.saveCorrectionColsAsTeam(); } finally { window.confirm = realConfirm; }
    await new Promise(r => setTimeout(r, 900));
    out.confirmText = saw;
    out.afterYes = (tpl.correctionContextCols || []).slice();
    out.writesAfterYes = (window.__writes || []).slice();
    out.by = tpl.correctionContextColsBy || '';
    out.at = !!tpl.correctionContextColsAt;
    return out;
  }, TPL);
  check(same(teamWrite.afterNo, ['Amount', 'Centre', 'Calc']) && !teamWrite.writesAfterNo.some(p => /recoTemplates/.test(p)),
    'T6: "Save as the team default" declined at the confirm changes NOTHING and writes nothing', teamWrite);
  check(/colleague/i.test(teamWrite.confirmText) && /\bNote\b/.test(teamWrite.confirmText),
    'T6: the confirm NAMES THE SHARED EFFECT and lists what everyone will see', teamWrite.confirmText.slice(0, 300));
  check(same(teamWrite.afterYes, ['Amount', 'Centre', 'Calc', 'Note']),
    'T6: accepted, it publishes this person\'s list as the team default', teamWrite.afterYes);
  check(teamWrite.writesAfterYes.some(p => /recoTemplates\.json/.test(p)),
    'T6: AND THAT — only that — writes recoTemplates.json to the shared folder', teamWrite.writesAfterYes);
  check(!!teamWrite.by && teamWrite.at,
    'and it is stamped with who published it and when, like the team column order', teamWrite);

  const t8 = await page.evaluate(async (tplId) => {
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const out = { team0: (tpl.correctionContextCols || []).slice() };
    Reco.userPref(tplId, 'correctionCols', ['Note', 'Centre', 'Amount']);
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 80));
    Reco.removeCorrectionCol('Centre');
    await new Promise(r => setTimeout(r, 150));
    out.afterX = Reco.userPref(tplId, 'correctionCols');
    out.teamAfterX = (tpl.correctionContextCols || []).slice();
    Reco.clearCorrectionCols();
    await new Promise(r => setTimeout(r, 150));
    out.afterClear = Reco.userPref(tplId, 'correctionCols');
    out.teamAfterClear = (tpl.correctionContextCols || []).slice();
    out.resolved = Reco.correctionCols(tpl, AppState.recoSessions[tplId]).cols.slice();
    return out;
  }, TPL);
  check(same(t8.afterX, ['Note', 'Amount']) && same(t8.teamAfterX, t8.team0),
    'T8: the chip × removes it from THIS PERSON\'S list and leaves the team default alone', t8);
  check(same(t8.afterClear, []) && same(t8.teamAfterClear, t8.team0),
    'T8: Clear means "I want none" — an explicit empty choice, and the team default SURVIVES it', t8);
  check(same(t8.resolved, []),
    'T8: so the tab shows no context columns, without deleting anyone else\'s choice', t8.resolved);

  } catch (e) { check(false, '[7] the scope split could not be exercised at all',
    String((e && e.message) || e).split('\n')[0].slice(0, 300)); }

  /* ====================================================================
     [8] T9 — the active format column, and a chip row that does not wander
     ==================================================================== */
  section(9, 'T9: the active format column is offered DISABLED, and the chips do not change with the tab');
  try {

  const t9 = await page.evaluate(async (tplId) => {
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    delete tpl.correctionContextCols;
    Reco.userPref(tplId, 'correctionCols', ['Centre', 'Ref']);
    AppState._correctionCol = 'Ref';
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 120));
    const chipsOnRef = [...document.querySelectorAll('#recoContentArea .panel .corr-ctx .tag')]
      .map(s => s.textContent.replace(/\s*×\s*$/, '').trim());
    Reco.openCorrectionCols();
    await new Promise(r => setTimeout(r, 60));
    /* By the name in the checkbox's OWN handler, not by a substring of the
       label: 'Ref' is a substring of 'Second Ref' and the two columns are
       exactly what this test tells apart. */
    const rowFor = (n) => [...document.querySelectorAll('#appModal label.inline')]
      .find(l => { const i = l.querySelector('input');
                   return i && (i.getAttribute('onchange') || '').indexOf("toggle('" + n + "'") >= 0; });
    const refRow = rowFor('Ref');
    const out = {
      chipsOnRef,
      refDisabled: !!(refRow && refRow.querySelector('input').disabled),
      refNote: refRow ? refRow.textContent.replace(/\s+/g, ' ').trim() : '',
      centreDisabled: !!(rowFor('Centre') && rowFor('Centre').querySelector('input').disabled),
      cap: ColPicker._st ? ColPicker._st.cap : 0
    };
    ColPicker.cancel();
    AppState._correctionCol = 'Second Ref';
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 120));
    out.chipsOnSecond = [...document.querySelectorAll('#recoContentArea .panel .corr-ctx .tag')]
      .map(s => s.textContent.replace(/\s*×\s*$/, '').trim());
    AppState._correctionCol = 'Ref';
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 100));
    return out;
  }, TPL);
  check(t9.refDisabled && /already shown as Current Value/i.test(t9.refNote),
    'T9: the active format column is in the picker, DISABLED, with its reason', t9.refNote);
  check(!t9.centreDisabled, 'and every other column is pickable as normal', t9);
  check(t9.cap === 6, 'the picker carries the cap', t9.cap);
  check(same(t9.chipsOnRef, t9.chipsOnSecond) && t9.chipsOnRef.length === 2,
    'T9: THE CHIP ROW IS THE SAME ON BOTH FORMAT TABS — the list is panel-wide, so a chip the '
    + 'operator never removed cannot vanish when they switch tabs',
    { onRef: t9.chipsOnRef, onSecond: t9.chipsOnSecond });


  /* THE ROW ITSELF, which T9 never read. This is exactly the state the
     reviewers' finding F8 names - the stored list holds the column under
     correction, left there by decision F - and it is the class of defect that
     got past review twice, because the names-only assertions above pass while
     the bad value prints in two cells that disagree. The defect itself was
     closed by the delivered F10 fix and then, for the keyless shape, by the
     blocker fix; this is the assertion that was missing, and it reads VALUES. */
  const t9row = await page.evaluate((arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    const panel = document.querySelector('#recoContentArea .panel');
    const tbl = errTbl(panel);
    const tr = tbl.querySelector('tbody tr');
    const ths = [...tbl.querySelectorAll('thead th')].map(th => th.textContent).filter(Boolean);
    const bad = ((tr.querySelector('td.cell-error') || {}).textContent || '').trim();
    return { ths, dupTh: ths.filter((x, i) => ths.indexOf(x) !== i), bad: bad,
      occurrences: [...tr.children].filter(td => td.textContent.trim() === bad).length,
      ctxCols: [...tr.querySelectorAll('td[data-col]')].map(td => td.dataset.col),
      stored: Reco.userPref(tplId, 'correctionCols') };
  }, [TPL, ERRTBL]);
  check((t9row.stored || []).includes('Ref') && t9row.bad === 'bad ref 0' && t9row.occurrences === 1,
    'T9: THE ROW - the bad value is printed in exactly ONE cell although the stored list holds the column '
    + 'under correction (decision F keeps the name; the render prints it once, as Current Value)', t9row);
  check(!t9row.ctxCols.includes('Ref') && !t9row.dupTh.length,
    'T9: and there is no context cell for the column under correction, and no <th> twice', t9row);

  } catch (e) { check(false, '[9] the picker decorations could not be exercised at all',
    String((e && e.message) || e).split('\n')[0].slice(0, 300)); }

  /* ====================================================================
     [9] T10 — a keyless template
     ==================================================================== */
  section(10, 'T10: a keyless template says so, shows three identifying columns, and writes no master');

  const KEYLESS = 'tpl_corr_keyless';
  await page.evaluate(new Function('arg', 'return ' + SETUP + '(arg)'), [KEYLESS, 20, 15, 4, false]);
  const t10 = await page.evaluate(async (arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const sess = AppState.recoSessions[tplId];
    Reco.userPref(tplId, 'correctionCols', null);
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 150));
    const panel = document.querySelector('#recoContentArea .panel');
    const tbl = errTbl(panel);
    const ths = [...tbl.querySelectorAll('thead th')].map(t => t.textContent.trim());
    const tr = tbl.querySelector('tbody tr');
    const idCells = [...tr.querySelectorAll('td[data-idcol]')].map(td => td.dataset.idcol);
    const idVals = {};
    tr.querySelectorAll('td[data-idcol]').forEach(td => { idVals[td.dataset.idcol] = td.textContent.trim(); });
    const ctxCells = [...tr.querySelectorAll('td[data-col]')].map(td => td.dataset.col);
    const curCell = (tr.querySelector('td.cell-error') || {}).textContent || '';
    const dupTh = ths.filter((t, i) => ths.indexOf(t) !== i);
    const before = JSON.parse(JSON.stringify(AppState.correctionMaster[tplId] || null));
    tr.querySelector('input').value = 'KL-1234';
    tr.querySelector('button').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    tr.querySelector('button').click();
    await new Promise(r => setTimeout(r, 250));
    return {
      warn: /no primary key/i.test(panel.textContent), ths, idCells,
      idVals, ctxCells, curCell, dupTh,
      pkNull: Reco.getRowPK(tpl, sess.data[0]) === null,
      cell: sess.data[0].Ref,
      masterBefore: before,
      masterAfter: JSON.parse(JSON.stringify(AppState.correctionMaster[tplId] || null)),
      corrections: JSON.parse(JSON.stringify(sess.corrections || {}))
    };
  }, [KEYLESS, ERRTBL]);
  check(t10.warn, 'T10: the warning line is on screen', t10.ths);
  /* 'Ref' IS THE COLUMN UNDER CORRECTION, so it is not one of them — it is the
     Current Value cell. Before this was fixed, idCols was `.slice(0, 3)` of the
     template with no filter, so a keyless template printed the corrected column
     TWICE, with NOTHING chosen, no picker opened and no click: once as an id cell
     through displayCellValue ('01/01/24') and once raw as Current Value
     ('45292'), three columns apart in the one row the operator is being asked to
     retype. The names-only assertion that used to be here read
     ['Doc', 'Ref', 'Amount'] and PASSED while that was happening, which is why
     this now reads the values too. */
  check(t10.idCells.length === 3 && same(t10.idCells, ['Doc', 'Amount', 'Posting Date']),
    'T10: and three identifying columns are shown so the operator can tell the rows apart — '
    + 'the column under correction NOT among them', t10.idCells);
  check(!t10.idCells.includes('Ref') && !t10.ctxCells.includes('Ref'),
    'T10: ONE NAME, ONE CELL — the corrected column is printed once, as Current Value, and nowhere else',
    { id: t10.idCells, ctx: t10.ctxCells, current: t10.curCell });
  check(!t10.dupTh.length, 'T10: and no column heading appears twice', t10.dupTh);
  check(Object.values(t10.idVals).every(v => v !== t10.curCell.trim()),
    'T10: no identifying cell repeats the value in Current Value — the two prints DISAGREED '
    + '(displayCellValue vs raw), which reads as the app being confused about the cell being fixed',
    { idVals: t10.idVals, current: t10.curCell });
  check(t10.pkNull && t10.cell === 'KL-1234',
    'the premise: no primary key, and the correction did change the row in front of the operator', t10);
  check(!t10.masterAfter && same(t10.corrections, {}),
    'T10: AND IT REACHED NEITHER the shared correctionMaster NOR sess.corrections — which is exactly '
    + 'what the warning line is there to say', { master: t10.masterAfter, corrections: t10.corrections });

  /* ====================================================================
     [10] T11 — the cost, best of three
     ==================================================================== */
  section(11, 'T11: one master_lookup over a 50,000-row master, 200 rendered rows, under 1500ms');

  const t11 = await page.evaluate(async (arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    const m = {};
    const sess = AppState.recoSessions[tplId];
    for (let i = 0; i < 50000; i++) m['tpl_corr_fixedD' + i] = 'ACC-' + i;
    AppState.docNumberMaster[tplId] = m;
    AppState._correctionCol = 'Ref';
    Reco.userPref(tplId, 'correctionCols', ['Acct']);
    Reco._corrMore = {};
    AppState.activeRecoId = tplId;
    sess.activeSection = 'correction';
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    // warm once, then best of three: this is house practice after three
    // knife-edge timing tests failed for machine contention, not regression.
    Reco.renderCorrection(tpl, sess);
    const ms = [];
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      const h = Reco.renderCorrection(tpl, sess);
      ms.push(performance.now() - t0);
      if (!h || h.length < 1000) return { broken: true };
    }
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 400));
    const panel = document.querySelector('#recoContentArea .panel');
    const tbl = errTbl(panel);
    const tr = tbl.querySelector('tbody tr');
    return {
      ms: ms.map(x => Math.round(x)), best: Math.round(Math.min(...ms)),
      rows: tbl.querySelectorAll('tbody tr').length,
      masterRows: Masters.rows('docNumbers', tplId).length,
      acct: tr ? (tr.querySelector('td[data-col="Acct"]') || {}).textContent : ''
    };
  }, [TPL, ERRTBL]);
  note('three runs (ms)', t11.ms);
  check(t11.masterRows === 50000 && t11.rows === 200 && /^ACC-/.test(String(t11.acct || '').trim()),
    'the premise: a 50,000-row master, 200 rendered rows, and the lookup really is resolving', t11);
  check(t11.rows === 200 && /^ACC-/.test(String(t11.acct || '').trim()) && t11.best < 1500,
    'T11: the correction panel renders in under 1500ms (best of three) — one Map per render, not one scan per row',
    { best: t11.best, all: t11.ms });

  /* ====================================================================
     F1 — THE PER-CELL DISPLAY FORMAT. A context cell has to say what the
     grid's cell says, and the only comparison that can show it is the GRID'S
     RENDERED <td> against the CORRECTION'S RENDERED <td>. Section [3] above
     asks displayCellValue what the grid would show, which compares the
     implementation with itself and cannot see a step the grid applies AFTER
     it: sess.cellFormats[rowKey][col].numFmt, written by the Excel view's
     Format… dropdown and living on the SESSION, i.e. on the shared folder, so
     one colleague's formatting is everyone's.
     ==================================================================== */
  section('F1', 'F1: a cell with a per-cell number format reads the SAME in the grid and in the correction tab');
  try {

  const FMTTPL = 'tpl_corr_numfmt';
  const f1 = await page.evaluate(async (arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = tplId; t.name = 'VAT RECON';
    t.columns = ['Doc', 'Ref', 'Amount', 'VAT Rate', 'Posting Date'].map(n => ({
      name: n, label: n, formats: n === 'Ref' ? ['AA-DDDD'] : [], isValue: n === 'Amount', isDate: false }));
    t.primaryKeys = ['Doc']; t.valueColumn = 'Amount';
    t.displayColumns = ['Doc', 'Ref', 'Amount', 'VAT Rate', 'Posting Date'];
    t.enableCorrections = true; t.additionalColumns = [];
    RecoTemplate.saveTemplate(); RecoTemplate.open(tplId); App.closeModal();
    const sess = AppState.recoSessions[tplId];
    Reco.ensureSessionShape(sess);
    sess.data = [{ _id: tplId + '_r0', _pk: 'VD0', _ver: 'upload', Doc: 'VD0', Ref: 'bad ref',
                   Amount: '-1234.5', 'VAT Rate': '0.05', 'Posting Date': '45292' }];
    sess._autoLoadAttempted = true;
    /* EXACTLY THE SHAPE THE EXCEL-VIEW TOOLBAR WRITES (Reco._xlFmt, keyed by
       Reco._ssFmtRowKey = row._pk || row._id). The operator path is: Excel
       View -> select the cells -> Format… -> '12.34%'. */
    sess.cellFormats = { VD0: { 'VAT Rate': { numFmt: 'percent' }, Amount: { numFmt: 'accounting' },
                                'Posting Date': { numFmt: 'date_long' } } };
    AppState.activeRecoId = tplId;
    AppState._correctionCol = 'Ref';
    Reco.userPref(tplId, 'correctionCols', ['VAT Rate', 'Amount', 'Posting Date']);

    sess.activeSection = 'action';
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 250));
    const gtr = document.querySelector('.reco-table-wrap tbody tr');
    const grid = {};
    [...(gtr ? gtr.querySelectorAll('td[data-col]') : [])].forEach(td => { grid[td.dataset.col] = td.textContent; });

    sess.activeSection = 'correction';
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 250));
    const panel = document.querySelector('#recoContentArea .panel');
    const ctr = errTbl(panel).querySelector('tbody tr');
    const corr = {};
    [...ctr.querySelectorAll('td[data-col]')].forEach(td => { corr[td.dataset.col] = td.textContent; });
    return { grid, corr, raw: { 'VAT Rate': sess.data[0]['VAT Rate'], Amount: sess.data[0].Amount,
             'Posting Date': sess.data[0]['Posting Date'] } };
  }, [FMTTPL, ERRTBL]);
  note('grid', f1.grid); note('corr', f1.corr);
  /* The premise is half the assertion: if the GRID stopped formatting, the two
     sides would agree on the raw value and this section would pass while
     saying nothing. */
  check(f1.grid['VAT Rate'] === '5.00%' && f1.grid.Amount === '(1,234.50)'
        && f1.grid['Posting Date'] === '01-Jan-2024',
    'the premise: the grid applies the per-cell number format — 5.00%, (1,234.50), 01-Jan-2024', f1.grid);
  const cmp = ['VAT Rate', 'Amount', 'Posting Date'];
  cmp.forEach(n => {
    check(f1.corr[n] === f1.grid[n],
      'F1: the correction context cell for ' + n + ' is CHARACTER FOR CHARACTER the grid\'s cell',
      { grid: f1.grid[n], corr: f1.corr[n], raw: f1.raw[n] });
  });
  check(f1.corr['VAT Rate'] !== f1.raw['VAT Rate'] && f1.corr.Amount !== f1.raw.Amount,
    'F1: and neither is the RAW stored value — a VAT rate the team reads as 5.00% must not read 0.05 '
    + 'in the one column the operator is using to decide what a wrong value should be',
    { corr: f1.corr, raw: f1.raw });

  } catch (e) { check(false, '[F1] the per-cell format comparison could not be exercised at all',
    String((e && e.message) || e).split('\n')[0].slice(0, 300)); }

  /* ====================================================================
     F2 — "All" in the picker must not store a row the picker DRAWS as
     unpickable, and the row must never print the same column twice.
     ==================================================================== */
  section('F2', 'F2: three clicks — Show columns, All, Done — and the key and the format column are not doubled');
  try {

  const DUPTPL = 'tpl_corr_dup';
  await page.evaluate(async (tplId) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = tplId; t.name = 'DATE RECON';
    t.columns = ['Doc', 'Posting Date', 'Amount', 'Centre'].map(n => ({
      name: n, label: n, formats: n === 'Posting Date' ? ['DD/DD/DDDD'] : [],
      isValue: n === 'Amount', isDate: false }));
    t.primaryKeys = ['Doc']; t.valueColumn = 'Amount';
    t.displayColumns = ['Doc', 'Posting Date', 'Amount', 'Centre'];
    t.enableCorrections = true; t.additionalColumns = [];
    RecoTemplate.saveTemplate(); RecoTemplate.open(tplId); App.closeModal();
    const sess = AppState.recoSessions[tplId];
    Reco.ensureSessionShape(sess);
    sess.data = [{ _id: tplId + '_r0', _pk: 'DD0', _ver: 'upload', Doc: 'DD0',
                   'Posting Date': '45292', Amount: '100', Centre: 'C1' }];
    sess._autoLoadAttempted = true;
    sess.activeSection = 'correction';
    AppState.activeRecoId = tplId;
    AppState._correctionCol = 'Posting Date';
    Reco.userPref(tplId, 'correctionCols', null);
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 200));
  }, DUPTPL);

  /* THREE CLICKS ON VISIBLE BUTTONS, not three function calls: the hole is in
     a toolbar control, so the toolbar is what has to be pressed. */
  await page.click('#recoContentArea .corr-ctx button');
  await page.waitForSelector('#cpPanes label', { timeout: 5000 });
  const picked = await page.evaluate(() => {
    const rowFor = n => [...document.querySelectorAll('#appModal label.inline')]
      .find(l => { const i = l.querySelector('input');
                   return i && (i.getAttribute('onchange') || '').indexOf("toggle('" + n + "'") >= 0; });
    const st = n => { const l = rowFor(n); return l
      ? { disabled: !!l.querySelector('input').disabled, text: l.textContent.replace(/\s+/g, ' ').trim() }
      : null; };
    return { doc: st('Doc'), date: st('Posting Date'), amount: st('Amount') };
  });
  check(picked.date && picked.date.disabled && /already shown as Current Value/i.test(picked.date.text),
    'the premise: the picker draws the ACTIVE FORMAT COLUMN disabled, with its reason (decision F)',
    picked.date);
  check(picked.doc && picked.doc.disabled && /already shown as the key/i.test(picked.doc.text),
    'F2: and it draws the PRIMARY KEY column disabled too — the row already prints it (decision C)',
    picked.doc);
  check(picked.amount && !picked.amount.disabled, 'and an ordinary column is pickable as normal', picked.amount);
  await page.click('#cpTop button[title="Add every column the filter leaves"]');
  await page.click('#appModalFooter button.success');
  await page.waitForTimeout(400);

  const dup = await page.evaluate((arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    const panel = document.querySelector('#recoContentArea .panel');
    const tbl = errTbl(panel);
    const tr = tbl.querySelector('tbody tr');
    return {
      stored: Reco.userPref(tplId, 'correctionCols'),
      ths: [...tbl.querySelectorAll('thead th')].map(th => th.textContent).filter(Boolean),
      tds: [...tr.children].map(td => td.textContent.trim()),
      ctxCols: [...tr.querySelectorAll('td[data-col]')].map(td => td.dataset.col),
      bad: [...tr.children].filter(td => td.textContent.trim() === '45292').length,
      key: [...tr.children].filter(td => td.textContent.trim() === 'DD0').length,
      chips: [...panel.querySelectorAll('.corr-ctx .tag')].map(s => s.textContent.replace(/\s*×\s*$/, '').trim())
    };
  }, [DUPTPL, ERRTBL]);
  note('stored', dup.stored); note('ths', dup.ths); note('tds', dup.tds);
  check(!(dup.stored || []).includes('Posting Date') && !(dup.stored || []).includes('Doc'),
    'F2: "All" STORED NEITHER the disabled active format column NOR the primary key',
    dup.stored);
  check(same(dup.stored, ['Amount', 'Centre']),
    'F2: it stored exactly the columns the picker offered as pickable', dup.stored);
  check(dup.ths.length === new Set(dup.ths).size,
    'F2: EVERY <th> OF THE ERROR TABLE IS DISTINCT — no column is printed twice', dup.ths);
  check(dup.bad === 1,
    'F2: and the bad value appears in EXACTLY ONE cell of the row, so the two prints cannot disagree',
    { occurrences: dup.bad, tds: dup.tds });
  check(dup.key === 1, 'F2: and the key value appears in exactly one cell of the row', dup.tds);

  /* The other half: a stored list that ALREADY holds the key and the active
     column - from a colleague's team default, or from this list before the
     fix - still renders each of them once. The stored list is panel-wide
     (decision F), so the CHIP ROW keeps them: nothing the operator never
     removed may vanish. */
  const dup2 = await page.evaluate(async (arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    Reco.userPref(tplId, 'correctionCols', ['Doc', 'Posting Date', 'Amount', 'Centre']);
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 200));
    const panel = document.querySelector('#recoContentArea .panel');
    const tbl = errTbl(panel);
    const tr = tbl.querySelector('tbody tr');
    return {
      ths: [...tbl.querySelectorAll('thead th')].map(th => th.textContent).filter(Boolean),
      ctxCols: [...tr.querySelectorAll('td[data-col]')].map(td => td.dataset.col),
      bad: [...tr.children].filter(td => td.textContent.trim() === '45292').length,
      key: [...tr.children].filter(td => td.textContent.trim() === 'DD0').length,
      chips: [...panel.querySelectorAll('.corr-ctx .tag')].map(s => s.textContent.replace(/\s*×\s*$/, '').trim())
    };
  }, [DUPTPL, ERRTBL]);
  check(same(dup2.ctxCols, ['Amount', 'Centre']) && dup2.bad === 1 && dup2.key === 1
        && dup2.ths.length === new Set(dup2.ths).size,
    'F2: a stored list that HOLDS the key and the active column renders each of them ONCE', dup2);
  check(same(dup2.chips, ['Doc', 'Posting Date', 'Amount', 'Centre']),
    'F2: and the chip row still shows all four — the stored list stays panel-wide (decision F)', dup2.chips);

  } catch (e) { check(false, '[F2] the duplicate-column sequence could not be exercised at all',
    String((e && e.message) || e).split('\n')[0].slice(0, 300)); }

  /* ====================================================================
     F3 / F4 — the two states the chrome could not express: "I have not
     chosen" (no route back to the team default) and "no team default at all"
     (the un-publish was unreachable).
     ==================================================================== */
  section('F3/F4', 'F3: a route back to the team default, and scope "mine" said out loud; F4: the un-publish is reachable');
  const TRAP = 'tpl_corr_trap';
  let trap = { steps: [] };
  try {

  trap = await page.evaluate(async (arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = tplId; t.name = 'TRAP RECON';
    t.columns = ['Doc', 'Ref', 'Amount', 'Centre', 'Narrative', 'Desc', 'Note2'].map(n => ({
      name: n, label: n, formats: n === 'Ref' ? ['AA-DDDD'] : [], isValue: n === 'Amount', isDate: false }));
    t.primaryKeys = ['Doc']; t.valueColumn = 'Amount';
    t.displayColumns = ['Doc', 'Ref', 'Amount', 'Centre', 'Narrative', 'Desc', 'Note2'];
    t.enableCorrections = true; t.additionalColumns = [];
    RecoTemplate.saveTemplate(); RecoTemplate.open(tplId); App.closeModal();
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const sess = AppState.recoSessions[tplId];
    Reco.ensureSessionShape(sess);
    sess.data = [{ _id: tplId + '_r0', _pk: 'TD0', _ver: 'upload', Doc: 'TD0', Ref: 'bad ref',
                   Amount: '100', Centre: 'C1', Narrative: 'N1', Desc: 'D1', Note2: 'X1' }];
    sess._autoLoadAttempted = true;
    sess.activeSection = 'correction';
    AppState.activeRecoId = tplId;
    AppState._correctionCol = 'Ref';
    const out = { steps: [] };
    const chrome = () => {
      const box = document.querySelector('#recoContentArea .panel .corr-ctx');
      return { text: box.textContent.replace(/\s+/g, ' ').trim(),
        btns: [...box.querySelectorAll('button')].map(b => b.textContent.trim()),
        handlers: [...box.querySelectorAll('button')].map(b => (b.getAttribute('onclick') || '').replace(/\(.*$/, '')),
        chips: [...box.querySelectorAll('.tag')].map(s => s.textContent.replace(/\s*×\s*$/, '').trim()) };
    };
    const nav = async () => { App.navigate('reco'); await new Promise(r => setTimeout(r, 140)); };
    const snap = async label => {
      await nav();
      const r = Reco.correctionCols(tpl, sess);
      const panel = document.querySelector('#recoContentArea .panel');
      const tbl = errTbl(panel);
      out.steps.push({ step: label, cols: r.cols.slice(), scope: r.scope,
        stored: Reco.userPref(tplId, 'correctionCols'), chrome: chrome(),
        ths: [...tbl.querySelectorAll('thead th')].map(th => th.textContent).filter(Boolean) });
    };

    Reco.userPref(tplId, 'correctionCols', null);
    delete tpl.correctionContextCols;
    await snap('0 nobody has ever configured anything');

    tpl.correctionContextCols = ['Centre', 'Narrative'];
    await snap('1 the controller publishes two columns');

    Reco._corrPick = { paneKey: 'p0', tplId: tplId };
    Reco._corrColsDone(['Amount']);
    await snap('2 the operator picks their own one column');

    Reco.clearCorrectionCols('p0');
    await snap('3 the operator presses Clear');

    tpl.correctionContextCols = ['Centre', 'Narrative', 'Amount'];
    await snap('4 the controller republishes with a third column');

    out.hasFollow = typeof Reco.followTeamCorrectionCols === 'function';
    if (out.hasFollow) {
      Reco.followTeamCorrectionCols('p0');
      await new Promise(r => setTimeout(r, 200));
      await snap('5 the operator presses "Follow the team default"');
    }
    return out;
  }, [TRAP, ERRTBL]);
  /* A step the build never reached must FAIL ITS CHECK, not throw and take
     the whole section with it - the pre-fix run has to say which gates are
     missing, one line each. */
  const st = n => trap.steps.find(s => s.step.charAt(0) === String(n))
    || { cols: null, scope: null, stored: undefined, chrome: { text: '', btns: [], handlers: [], chips: [] }, ths: [] };
  trap.steps.forEach(s => note(s.step, { cols: s.cols, scope: s.scope, btns: s.chrome.btns }));
  check(st(3).scope === 'mine' && same(st(3).cols, []) && same(st(3).stored, []),
    'the premise: Clear writes the tri-state\'s explicit empty choice', st(3));
  check(st(3).chrome.text !== st(0).chrome.text,
    'F3: "I chose none" NO LONGER READS EXACTLY LIKE "nobody has ever configured this" — there is '
    + 'something on screen to tell the operator why their tab differs from their colleague\'s',
    { neverConfigured: st(0).chrome.text, afterClear: st(3).chrome.text });
  check(/your own choice/i.test(st(3).chrome.text),
    'F3: and scope "mine" is labelled, the way "team" and "legacy" are', st(3).chrome.text);
  check(trap.hasFollow && st(3).chrome.handlers.some(h => /followTeamCorrectionCols/.test(h)),
    'F3: a "Follow the team default" button is on screen while a team default exists and is being overridden',
    st(3).chrome);
  check(st(5).scope === 'team' && same(st(5).cols, ['Centre', 'Narrative', 'Amount'])
        && st(5).stored === null,
    'F3: PRESSING IT GOES BACK TO THE TEAM DEFAULT — the per-user key is removed, not set to [] — and '
    + 'the republished third column arrives with it', st(5));
  check(same(st(5).chrome.chips, ['Centre', 'Narrative', 'Amount'])
        && /the team default/.test(st(5).chrome.text),
    'F3: and the chip row is the team\'s list again, labelled as the team default', st(5).chrome);
  check(st(4).scope === 'mine' && same(st(4).cols, []),
    'the premise F3 rests on: until that button is pressed the republished default is correctly NOT applied '
    + '— [] is still a choice', st(4));

  const unpub = await page.evaluate(async (tplId) => {
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const out = {};
    /* Priya publishes six, Arun clears for himself: the exact state in which
       the un-publish was unreachable. */
    tpl.correctionContextCols = ['Doc', 'Amount', 'Centre', 'Desc', 'Note2', 'Narrative'];
    Reco.userPref(tplId, 'correctionCols', []);
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 150));
    const box = document.querySelector('#recoContentArea .panel .corr-ctx');
    out.btns = [...box.querySelectorAll('button')].map(b => b.textContent.trim());
    out.teamBtn = [...box.querySelectorAll('button')]
      .filter(b => /saveCorrectionColsAsTeam/.test(b.getAttribute('onclick') || '')).map(b => b.textContent.trim());
    out.teamBefore = (tpl.correctionContextCols || []).slice();
    const realConfirm = window.confirm;
    let saw = '';
    window.confirm = m => { saw = String(m); return true; };
    window.__writes = [];
    try {
      const b = [...box.querySelectorAll('button')]
        .find(x => /saveCorrectionColsAsTeam/.test(x.getAttribute('onclick') || ''));
      out.pressed = !!b;
      if (b) b.click();
    } finally { window.confirm = realConfirm; }
    await new Promise(r => setTimeout(r, 900));
    out.confirmText = saw;
    out.teamAfter = Object.prototype.hasOwnProperty.call(tpl, 'correctionContextCols')
      ? (tpl.correctionContextCols || []).slice() : '(absent)';
    out.writes = (window.__writes || []).filter(p => /recoTemplates\.json/.test(p));
    out.resolved = Reco.correctionCols(tpl, AppState.recoSessions[tplId]).scope;
    return out;
  }, TRAP);
  note('un-publish', { btns: unpub.btns, writes: unpub.writes });
  check(unpub.teamBtn.length === 1,
    'F4: WITH SIX COLUMNS PUBLISHED AND THIS PERSON ON AN EMPTY LIST the team-default button is STILL '
    + 'ON SCREEN — the branch that deletes tpl.correctionContextCols is reachable from a screen',
    { buttons: unpub.btns, teamButton: unpub.teamBtn });
  check(unpub.pressed && /Clear the team default/i.test(unpub.confirmText)
        && /colleague/i.test(unpub.confirmText) && /Doc, Amount, Centre/.test(unpub.confirmText),
    'F4: pressing it confirms, naming the shared effect and the six columns it is about to remove',
    unpub.confirmText.slice(0, 300));
  check(unpub.teamAfter === '(absent)',
    'F4: accepted, the team default is GONE — not replaced with one column, gone', unpub.teamAfter);
  check(unpub.writes.length >= 1,
    'F4: and that — only that — writes recoTemplates.json to the shared folder', unpub.writes);

  } catch (e) { check(false, '[F3/F4] the chrome states could not be exercised at all',
    String((e && e.message) || e).split('\n')[0].slice(0, 300)); }

  /* ====================================================================
     F5 — a per-user list whose names have ALL been deleted is not the
     tri-state's "I want none".
     ==================================================================== */
  section('F5', 'F5: a per-user list that lost every name falls through; an explicitly empty one still does not');
  try {

  const f5 = await page.evaluate(async (tplId) => {
    const tpl = AppState.recoTemplates.find(x => x.id === tplId);
    const sess = AppState.recoSessions[tplId];
    const get = () => { const r = Reco.correctionCols(tpl, sess);
      return { cols: r.cols.slice(), dropped: r.dropped, scope: r.scope }; };
    const out = {};
    tpl.correctionContextCols = ['Centre', 'Narrative'];
    sess.correctionExtraCols = [];

    Reco.userPref(tplId, 'correctionCols', ['GoneA', 'GoneB']);
    out.allDead = get();
    Reco.userPref(tplId, 'correctionCols', ['GoneA', 'Amount']);
    out.oneSurvives = get();
    Reco.userPref(tplId, 'correctionCols', []);
    out.explicitlyNone = get();

    // and with no team default to fall through to, nothing changes either way
    delete tpl.correctionContextCols;
    Reco.userPref(tplId, 'correctionCols', ['GoneA']);
    out.deadAndNoTeam = get();

    // the legacy field is the next rung down when there is no team default
    sess.correctionExtraCols = ['Centre'];
    out.deadFallsToLegacy = get();

    tpl.correctionContextCols = ['Centre', 'Narrative'];
    Reco.userPref(tplId, 'correctionCols', ['GoneA', 'GoneB']);
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 150));
    const box = document.querySelector('#recoContentArea .panel .corr-ctx');
    out.chips = [...box.querySelectorAll('.tag')].map(s => s.textContent.replace(/\s*×\s*$/, '').trim());
    out.saysDropped = /no longer in this template/i.test(box.textContent);
    sess.correctionExtraCols = [];
    Reco.userPref(tplId, 'correctionCols', null);
    delete tpl.correctionContextCols;
    return out;
  }, TRAP);
  note('F5', f5);
  check(same(f5.allDead.cols, ['Centre', 'Narrative']) && f5.allDead.scope === 'team'
        && f5.allDead.dropped === 2,
    'F5: a per-user list whose every name has been deleted FALLS THROUGH to the team default, and the '
    + 'two dead names are still counted', f5.allDead);
  check(same(f5.explicitlyNone.cols, []) && f5.explicitlyNone.scope === 'mine',
    'F5: and an EXPLICITLY empty choice still does not fall through — the tri-state is intact (T7)',
    f5.explicitlyNone);
  check(same(f5.oneSurvives.cols, ['Amount']) && f5.oneSurvives.scope === 'mine' && f5.oneSurvives.dropped === 1,
    'F5: one surviving name is still this person\'s choice, and the dead one is counted', f5.oneSurvives);
  check(same(f5.deadAndNoTeam.cols, []) && f5.deadAndNoTeam.scope === 'mine' && f5.deadAndNoTeam.dropped === 1,
    'F5: with nothing below it to fall through to, a dead list is simply empty — no throw', f5.deadAndNoTeam);
  check(same(f5.deadFallsToLegacy.cols, ['Centre']) && f5.deadFallsToLegacy.scope === 'legacy',
    'F5: and the legacy session field is the next rung down, as the resolution order says', f5.deadFallsToLegacy);
  check(same(f5.chips, ['Centre', 'Narrative']) && f5.saysDropped,
    'F5: on screen the operator gets the team\'s chips AND the muted line saying what was left out',
    { chips: f5.chips, saysDropped: f5.saysDropped });

  } catch (e) { check(false, '[F5] the all-dead per-user list could not be exercised at all',
    String((e && e.message) || e).split('\n')[0].slice(0, 300)); }

  /* ====================================================================
     ROUND 2 — the eight findings the first fix round's brief was cut before
     delivering. They are named by their id in the reviewers' own file
     (F3-F8, F12, F13) and PREFIXED R2 because the sections above are
     labelled F1-F5 for the five findings that round DID handle, which are
     findings F9, F10, F11, F1 and F2 of that same file. R2-Fn here means
     finding Fn there, and nothing else.
     ==================================================================== */

  /* ====================================================================
     R2-F3 — a SESSION-ONLY column must not be publishable as the team
     default. The picker legitimately offers sess.extraColumns, and the
     PER-PERSON list legitimately holds one: it resolves and renders with
     its value. But saveTemplate's prune is built from template names and
     has no session to widen against, so a published session name was
     deleted from the share by the next unrelated template save — with no
     confirm, no toast, and ctx.dropped 0 (the name is REMOVED from the
     array rather than left in it), so the chip row's "N column(s) no
     longer in this template" line could not fire either.

     THE ASSERTION THAT CATCHES IT READS CELL VALUES, before and after that
     save, for a colleague who never chose: a names-only assertion on the
     team array passes while the cell disappears, which is how the prune's
     silence survived the first review.
     ==================================================================== */
  section('R2-F3', 'R2-F3: a session-only column cannot become the team default, and no unrelated save can un-publish one');
  try {

  const F3TPL = 'tpl_r2_f3';
  const r2f3 = await page.evaluate(async (arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = tplId; t.name = 'SCRATCH RECON';
    t.columns = ['Doc', 'Ref', 'Amount', 'Centre'].map(n => ({
      name: n, label: n, formats: n === 'Ref' ? ['AA-DDDD'] : [], isValue: n === 'Amount', isDate: false }));
    t.primaryKeys = ['Doc']; t.valueColumn = 'Amount';
    t.displayColumns = ['Doc', 'Ref', 'Amount', 'Centre'];
    t.enableCorrections = true; t.additionalColumns = [];
    RecoTemplate.saveTemplate(); RecoTemplate.open(tplId); App.closeModal();
    /* saveTemplate REPLACES the object in AppState.recoTemplates, so every
       read of the template after a save has to be a fresh lookup. */
    const live = () => AppState.recoTemplates.find(x => x.id === tplId);
    const sess0 = AppState.recoSessions[tplId];
    Reco.ensureSessionShape(sess0);
    /* EXACTLY THE SHAPE ssCommitAddCol's session-only branch writes. */
    sess0.extraColumns = [{ name: 'Scratch', type: 'custom', _ssAdded: true, _ssSingleUse: false }];
    sess0.data = [0, 1].map(i => ({ _id: tplId + '_r' + i, _pk: 'SD' + i, _ver: 'upload',
      Doc: 'SD' + i, Ref: 'bad ref ' + i, Amount: String((i + 1) * 10),
      Centre: 'CTR' + i, Scratch: 'SCR' + i }));
    sess0._autoLoadAttempted = true;
    sess0.activeSection = 'correction';
    AppState.activeRecoId = tplId;
    AppState._correctionCol = 'Ref';
    delete live().correctionContextCols;

    const nav = async () => { App.navigate('reco'); await new Promise(r => setTimeout(r, 170)); };
    const cells = () => {
      const panel = document.querySelector('#recoContentArea .panel');
      const tr = errTbl(panel).querySelector('tbody tr');
      return tr ? [...tr.querySelectorAll('td[data-col]')].map(td => td.dataset.col + '=' + td.textContent.trim()) : null;
    };
    /* THE RENDERED BUTTON, not the function: the button is what carries the
       pane key, and a programmatic call would not exercise it. */
    const press = async (answer) => {
      const realConfirm = window.confirm;
      let saw = null;
      window.confirm = m => { saw = String(m); return answer; };
      window.__toasts = [];
      try {
        const b = [...document.querySelectorAll('#recoContentArea .panel .corr-ctx button')]
          .find(x => /saveCorrectionColsAsTeam/.test(x.getAttribute('onclick') || ''));
        if (!b) return { pressed: false, confirm: null, toasts: [] };
        b.click();
      } finally { window.confirm = realConfirm; }
      await new Promise(r => setTimeout(r, 500));
      return { pressed: true, confirm: saw, toasts: (window.__toasts || []).map(x => x.msg) };
    };
    const out = {};

    Reco.userPref(tplId, 'correctionCols', ['Centre', 'Scratch']);
    await nav();
    out.mineCells = cells();
    out.publish = await press(true);
    out.teamAfterPublish = JSON.stringify(live().correctionContextCols);

    /* THE COLLEAGUE WHO NEVER CHOSE reads the published list. */
    Reco.userPref(tplId, 'correctionCols', null);
    await nav();
    out.scopeBefore = Reco.correctionCols(live(), AppState.recoSessions[tplId]).scope;
    out.cellsBefore = cells();

    /* ONE UNRELATED TEMPLATE SAVE — a typo in the description. */
    window.__toasts = [];
    RecoTemplate.edit(tplId);
    RecoTemplate._editing.description = 'typo fix';
    RecoTemplate.saveTemplate();
    App.closeModal();
    await new Promise(r => setTimeout(r, 250));
    out.saveToasts = (window.__toasts || []).map(x => x.msg);
    out.teamAfterUnrelatedSave = JSON.stringify(live().correctionContextCols);
    await nav();
    out.cellsAfter = cells();
    out.sessStillHasScratch = (AppState.recoSessions[tplId].extraColumns || [])
      .some(a => a && a.name === 'Scratch');

    /* THE WORDING TRAP: with the session name filtered out the publish is a
       no-op against what is already there, so the "already the team default"
       branch is the one the operator lands on — and it has to say why
       Scratch is not in it, or they are told their click did nothing and
       never learn why. */
    Reco.userPref(tplId, 'correctionCols', ['Centre', 'Scratch']);
    await nav();
    out.already = await press(true);
    out.teamAfterAlready = JSON.stringify(live().correctionContextCols);

    /* AND A CHOSEN LIST THAT IS NOTHING BUT A SESSION COLUMN IS REFUSED: an
       unguarded filter turns it into cols=[], which is the "Clear the team
       default" branch — one click from "publish this one column" to
       deleting the list it cannot replace. */
    Reco.userPref(tplId, 'correctionCols', ['Scratch']);
    await nav();
    out.onlySession = await press(true);
    out.teamAfterOnlySession = JSON.stringify(live().correctionContextCols);

    Reco.userPref(tplId, 'correctionCols', null);
    return out;
  }, [F3TPL, ERRTBL]);
  note('R2-F3 confirm', (r2f3.publish.confirm || '').slice(0, 420));
  note('R2-F3 cells', { mine: r2f3.mineCells, before: r2f3.cellsBefore, after: r2f3.cellsAfter });
  check(same(r2f3.mineCells, ['Centre=CTR0', 'Scratch=SCR0']),
    'the premise: the PER-PERSON list may hold a session-only column and it renders WITH ITS VALUE — so the '
    + 'read must not be narrowed; the publish is what has to be', r2f3.mineCells);
  check(r2f3.publish.pressed && /Scratch/.test(r2f3.publish.confirm || '')
        && /cannot be a team default/i.test(r2f3.publish.confirm || ''),
    'R2-F3: the confirm NAMES the session-only column and says it cannot be a team default',
    (r2f3.publish.confirm || '').slice(0, 420));
  check(r2f3.teamAfterPublish === '["Centre"]',
    'R2-F3: and the publish wrote the TEMPLATE names only — the session name never reached the share',
    r2f3.teamAfterPublish);
  check(r2f3.teamAfterUnrelatedSave === r2f3.teamAfterPublish,
    'R2-F3: so one unrelated template save afterwards changes NOTHING',
    { afterPublish: r2f3.teamAfterPublish, afterSave: r2f3.teamAfterUnrelatedSave });
  check(r2f3.cellsBefore && r2f3.cellsBefore.length > 0 && same(r2f3.cellsBefore, r2f3.cellsAfter),
    'R2-F3: THE GATE — a colleague who never chose reads the same context CELLS, with the same VALUES, '
    + 'before and after that save. The names-only version of this assertion passes while the cell vanishes',
    { before: r2f3.cellsBefore, after: r2f3.cellsAfter });
  check(r2f3.sessStillHasScratch,
    'R2-F3: and the session column itself was never touched — the data was always fine, it was the '
    + 'published list that was being silently edited', r2f3.sessStillHasScratch);
  check(r2f3.already.toasts.some(m => /already the team default/i.test(m)) &&
        r2f3.already.toasts.some(m => /Scratch/.test(m)) && r2f3.teamAfterAlready === '["Centre"]',
    'R2-F3: the wording trap — on the "already the team default" branch the operator is told the click was '
    + 'a no-op AND why Scratch is not in the published list', r2f3.already.toasts);
  check(r2f3.onlySession.confirm === null && r2f3.teamAfterOnlySession === '["Centre"]'
        && r2f3.onlySession.toasts.some(m => /Scratch/.test(m)),
    'R2-F3: and a list that is NOTHING BUT a session column is REFUSED — it must not fall into the '
    + '"Clear the team default" branch and delete a list it cannot replace',
    { confirm: r2f3.onlySession.confirm, team: r2f3.teamAfterOnlySession, toasts: r2f3.onlySession.toasts });

  } catch (e) { check(false, '[R2-F3] the session-only publish could not be exercised at all',
    String((e && e.message) || e).split('\n')[0].slice(0, 300)); }

  /* ====================================================================
     R2-F4 — overwriting a colleague's published list says WHOSE it is, and
     the stamp that says so is deleted beside the field in both places that
     delete the field. Before this the stamp was write-only in the whole
     file AND was written on the branch that had just deleted the list it
     describes, so a template on the share could claim a publisher for a
     list that is not there.
     ==================================================================== */
  section('R2-F4', 'R2-F4: the team default says who published it and when, and the stamp dies with the field');
  try {

  const F4TPL = 'tpl_r2_f4';
  const r2f4 = await page.evaluate(async (tplId) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = tplId; t.name = 'STAMP RECON';
    t.columns = ['Doc', 'Ref', 'Amount', 'Centre', 'Description', 'Note'].map(n => ({
      name: n, label: n, formats: n === 'Ref' ? ['AA-DDDD'] : [], isValue: n === 'Amount', isDate: false }));
    t.primaryKeys = ['Doc']; t.valueColumn = 'Amount';
    t.displayColumns = ['Doc', 'Ref', 'Amount', 'Centre', 'Description', 'Note'];
    t.enableCorrections = true; t.additionalColumns = [];
    RecoTemplate.saveTemplate(); RecoTemplate.open(tplId); App.closeModal();
    const live = () => AppState.recoTemplates.find(x => x.id === tplId);
    const sess = AppState.recoSessions[tplId];
    Reco.ensureSessionShape(sess);
    sess.data = [{ _id: tplId + '_r0', _pk: 'PD0', _ver: 'upload', Doc: 'PD0', Ref: 'bad ref',
                   Amount: '100', Centre: 'C1', Description: 'D1', Note: 'N1' }];
    sess._autoLoadAttempted = true;
    sess.activeSection = 'correction';
    AppState.activeRecoId = tplId;
    AppState._correctionCol = 'Ref';
    const nav = async () => { App.navigate('reco'); await new Promise(r => setTimeout(r, 170)); };
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    /* KEY PRESENCE, not value: that is the difference between a delete and
       an assignment of undefined, and the presence is what
       recoTemplates.json records. */
    const stampOf = () => { const x = live();
      return { has: has(x, 'correctionContextCols'), hasBy: has(x, 'correctionContextColsBy'),
               hasAt: has(x, 'correctionContextColsAt'), by: x.correctionContextColsBy,
               at: x.correctionContextColsAt, cols: JSON.stringify(x.correctionContextCols) }; };
    const press = async (answer) => {
      const realConfirm = window.confirm;
      let saw = null;
      window.confirm = m => { saw = String(m); return answer; };
      window.__toasts = [];
      try {
        const b = [...document.querySelectorAll('#recoContentArea .panel .corr-ctx button')]
          .find(x => /saveCorrectionColsAsTeam/.test(x.getAttribute('onclick') || ''));
        if (!b) return { pressed: false, confirm: null, toasts: [] };
        b.click();
      } finally { window.confirm = realConfirm; }
      await new Promise(r => setTimeout(r, 500));
      return { pressed: true, confirm: saw, toasts: (window.__toasts || []).map(x => x.msg) };
    };
    const PRIYA_AT = '2026-10-01T09:00:00.000Z';
    const setPriya = cols => { const x = live();
      x.correctionContextCols = cols; x.correctionContextColsBy = 'Priya'; x.correctionContextColsAt = PRIYA_AT; };
    const out = {};

    // (1) Arun is about to replace Priya's list, and DECLINES
    setPriya(['Centre', 'Description']);
    Reco.userPref(tplId, 'correctionCols', ['Note']);
    await nav();
    const t0 = Date.now();
    out.declined = await press(false);
    out.afterDecline = stampOf();

    // (2) the same press, accepted
    out.accepted = await press(true);
    out.afterAccept = stampOf();
    const at = Date.parse(out.afterAccept.at || 0);
    out.acceptedWithinRun = !!(at && at >= t0 - 2000 && at <= Date.now() + 2000);

    // (3) THE CLEAR BRANCH: this person wants none and un-publishes
    setPriya(['Centre', 'Description']);
    Reco.userPref(tplId, 'correctionCols', []);
    await nav();
    out.cleared = await press(true);
    out.afterClear = stampOf();

    // (4) THE PRUNE BRANCH: the team's only name is gone from the template
    setPriya(['GhostCol']);
    RecoTemplate.edit(tplId);
    RecoTemplate._editing.description = 'another typo fix';
    RecoTemplate.saveTemplate();
    App.closeModal();
    await new Promise(r => setTimeout(r, 250));
    out.afterPrune = stampOf();

    // (5) the chrome, with the team default in force
    setPriya(['Centre']);
    Reco.userPref(tplId, 'correctionCols', null);
    await nav();
    const panel = document.querySelector('#recoContentArea .panel');
    const box = panel.querySelector('.corr-ctx');
    out.scope = Reco.correctionCols(live(), AppState.recoSessions[tplId]).scope;
    out.chrome = box.textContent.replace(/\s+/g, ' ').trim();
    out.idsInPanel = [...panel.querySelectorAll('[id]')].map(e => e.id);
    /* OFF THE RENDERED TEXT NODES. document.body.textContent includes inline
       <script> source, where a code comment mentioning a name reads as a hit
       — that is the triage's own recorded false positive. */
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    let txt = '', n2;
    while ((n2 = walker.nextNode())) {
      if (!/^(SCRIPT|STYLE)$/.test(n2.parentNode.nodeName)) txt += n2.nodeValue + ' ';
    }
    out.rendered = txt.replace(/\s+/g, ' ').trim();
    Reco.userPref(tplId, 'correctionCols', null);
    return out;
  }, F4TPL);
  note('R2-F4 confirm', (r2f4.declined.confirm || '').slice(0, 420));
  note('R2-F4 chrome', r2f4.chrome);
  check(r2f4.declined.pressed && /Priya/.test(r2f4.declined.confirm || '')
        && /01-Oct-26/.test(r2f4.declined.confirm || ''),
    'R2-F4: the confirm names WHOSE list is about to be overwritten and WHEN they set it, in the format '
    + 'the display order already uses', (r2f4.declined.confirm || '').slice(0, 420));
  check(r2f4.afterDecline.cols === '["Centre","Description"]' && r2f4.afterDecline.by === 'Priya',
    'R2-F4: and declining still writes nothing — not the list, not the stamp', r2f4.afterDecline);
  check(r2f4.afterAccept.by === 'Test User' && r2f4.acceptedWithinRun,
    'R2-F4: accepting stamps this person and this moment', r2f4.afterAccept);
  check(r2f4.afterClear.has === false && r2f4.afterClear.hasBy === false && r2f4.afterClear.hasAt === false,
    'R2-F4: UN-PUBLISHING DELETES THE STAMP WITH THE FIELD — read as key presence, because a template '
    + 'claiming a publisher for a list that is not there is the lie this makes impossible', r2f4.afterClear);
  check(r2f4.afterPrune.has === false && r2f4.afterPrune.hasBy === false && r2f4.afterPrune.hasAt === false,
    'R2-F4: and so does saveTemplate\'s prune, which is the other route that deletes the field',
    r2f4.afterPrune);
  check(r2f4.scope === 'team' && /set by Priya on 01-Oct-26/.test(r2f4.rendered),
    'R2-F4: with the team default in force the chip row SAYS whose it is — the stamp is no longer write-only',
    { scope: r2f4.scope, chrome: r2f4.chrome });
  check(r2f4.idsInPanel.length === 0,
    'R2-F4: and it carries NO id — both panes can sit on this tab, so nothing this screen renders may be '
    + 'id-addressable (PANE_IDS is a fixed, bounded list)', r2f4.idsInPanel);

  } catch (e) { check(false, '[R2-F4] the attribution could not be exercised at all',
    String((e && e.message) || e).split('\n')[0].slice(0, 300)); }

  /* ====================================================================
     R2-F5 — restoring a session backup must not write the legacy
     sess.correctionExtraCols. restoreSession carries the STORED value
     across for the twin field sess.columnOrder, three lines above, for
     exactly this reason; #27 made the other field a display source, so the
     pre-existing wholesale assignment became a route by which a
     hand-edited backup publishes context columns nobody chose to the one
     shared recoSessions.json — labelled only "(legacy)", with no publisher,
     no date, and no route in the app that clears it.
     ==================================================================== */
  section('R2-F5', 'R2-F5: a restored backup cannot publish the legacy correctionExtraCols to the shared folder');
  try {

  const F5TPL = 'tpl_r2_f5';
  const r2f5 = await page.evaluate(async (arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = tplId; t.name = 'LEGACY RECON';
    t.columns = ['Doc', 'Ref', 'Amount', 'Description', 'Centre'].map(n => ({
      name: n, label: n, formats: n === 'Ref' ? ['AA-DDDD'] : [], isValue: n === 'Amount', isDate: false }));
    t.primaryKeys = ['Doc']; t.valueColumn = 'Amount';
    t.displayColumns = ['Doc', 'Ref', 'Amount', 'Description', 'Centre'];
    t.enableCorrections = true; t.additionalColumns = [];
    RecoTemplate.saveTemplate(); RecoTemplate.open(tplId); App.closeModal();
    const live = () => AppState.recoTemplates.find(x => x.id === tplId);
    const sess0 = AppState.recoSessions[tplId];
    Reco.ensureSessionShape(sess0);
    sess0.data = [0, 1].map(i => ({ _id: tplId + '_r' + i, _pk: 'LD' + i, _ver: 'upload',
      Doc: 'LD' + i, Ref: 'bad ref ' + i, Amount: String((i + 1) * 10),
      Description: 'DESC' + i, Centre: 'CTR' + i }));
    sess0._autoLoadAttempted = true;
    sess0.activeSection = 'correction';
    sess0.correctionExtraCols = [];
    sess0.columnOrder = ['Doc', 'Ref'];
    AppState.activeRecoId = tplId;
    AppState._correctionCol = 'Ref';
    delete live().correctionContextCols;
    Reco.userPref(tplId, 'correctionCols', null);
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 170));
    const out = { before: { legacy: JSON.stringify(sess0.correctionExtraCols),
                            order: JSON.stringify(sess0.columnOrder),
                            scope: Reco.correctionCols(live(), sess0).scope } };
    /* THE BACKUP, in exactly the shape Reco.backupSession writes, with a
       hand-edited session — which is the only way this field is ever
       non-empty, since no build has ever written it. */
    const backup = {
      template: JSON.parse(JSON.stringify(live())),
      session: JSON.parse(JSON.stringify(sess0)),
      manualOffsetMaster: {},
      correctionMaster: { LD0: { Description: 'FROM-BACKUP' } },
      docNumberMaster: {}, entryHistory: [], exportedAt: new Date().toISOString()
    };
    backup.session.correctionExtraCols = ['Description', 'Amount'];
    backup.session.columnOrder = ['Centre', 'Amount'];
    /* A REAL File ON A REAL <input type=file>, which is the shape the file
       input hands restoreSession. */
    const input = document.createElement('input');
    input.type = 'file';
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(backup)], 'reco_session_test.json', { type: 'application/json' }));
    input.files = dt.files;
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try {
      Reco.restoreSession({ target: input });
      await new Promise(r => setTimeout(r, 1500));
    } finally { window.confirm = realConfirm; }
    const sess = AppState.recoSessions[tplId];
    out.after = { legacy: JSON.stringify(sess.correctionExtraCols),
                  order: JSON.stringify(sess.columnOrder),
                  scope: Reco.correctionCols(live(), sess).scope,
                  rows: (sess.data || []).length,
                  master: JSON.stringify(AppState.correctionMaster[tplId] || null) };
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 220));
    const panel = document.querySelector('#recoContentArea .panel');
    const tr = errTbl(panel).querySelector('tbody tr');
    out.after.ctxCells = tr ? [...tr.querySelectorAll('td[data-col]')].map(td => td.dataset.col + '=' + td.textContent.trim()) : null;
    out.after.chrome = panel.querySelector('.corr-ctx').textContent.replace(/\s+/g, ' ').trim();
    /* THE SHARED FILE ITSELF, read back off the bridge: this value's whole
       consequence is that recoSessions.json is ONE file on the folder. */
    try {
      await AppState.flush();
      const onDisk = JSON.parse(await window.pywebview.api.read_file('reco/recoSessions.json'))[tplId] || {};
      out.onDisk = onDisk.correctionExtraCols === undefined ? '(absent)' : JSON.stringify(onDisk.correctionExtraCols);
    } catch (e) { out.onDisk = 'READ FAILED: ' + String((e && e.message) || e); }
    return out;
  }, [F5TPL, ERRTBL]);
  note('R2-F5', r2f5);
  check(r2f5.before.legacy === '[]' && r2f5.before.order === '["Doc","Ref"]' && r2f5.before.scope === 'none',
    'the premise: the stored session has the legacy field EMPTY, a stored column order, and nothing in force',
    r2f5.before);
  check(r2f5.after.legacy === '[]',
    'R2-F5: after restoring a backup whose session carried two legacy names the STORED session still has [] '
    + '— a backup cannot publish context columns nobody chose', r2f5.after.legacy);
  check(r2f5.after.order === '["Doc","Ref"]',
    'R2-F5: and the TWIN field keepLegacy already protected is still protected — asserted side by side, so a '
    + 'future edit cannot repair one and forget the other', r2f5.after.order);
  check(r2f5.after.scope === 'none' && same(r2f5.after.ctxCells, []),
    'R2-F5: and the RENDER agrees — no context cell, nothing labelled "(legacy)"',
    { scope: r2f5.after.scope, cells: r2f5.after.ctxCells, chrome: r2f5.after.chrome });
  check(r2f5.onDisk === '[]' || r2f5.onDisk === '(absent)',
    'R2-F5: AND THE SHARED FILE SAYS SO — recoSessions.json read back off the bridge, not trusted in memory',
    r2f5.onDisk);
  check(r2f5.after.rows === 2 && /FROM-BACKUP/.test(r2f5.after.master),
    'R2-F5: and the rest of the backup DID restore, so this is not passing by refusing the restore',
    r2f5.after);

  } catch (e) { check(false, '[R2-F5] the restore could not be exercised at all',
    String((e && e.message) || e).split('\n')[0].slice(0, 300)); }

  /* ====================================================================
     R2-F6R — the residue of F6. The 6-column cap and the de-duplication
     are enforced on the RENDER (the orchestrator's blocker fix) and in the
     picker, but the resolver still returned the unbounded, un-deduped
     list, and the chip row, removeCorrectionCol and the team publish all
     read THAT. So the panel said twelve and the table printed six, with
     nothing on screen to say so, and an over-cap list was sticky: the next
     publish put all of it back on the share.
     ==================================================================== */
  section('R2-F6R', 'R2-F6R: an over-cap, duplicated stored list is bounded and de-duplicated AT THE READ, and the panel says so');
  try {

  const F6TPL = 'tpl_r2_f6';
  await page.evaluate(new Function('arg', 'return ' + SETUP + '(arg)'), [F6TPL, 20, 15, 13, true]);
  const r2f6 = await page.evaluate(async (arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    const live = () => AppState.recoTemplates.find(x => x.id === tplId);
    const nav = async () => { App.navigate('reco'); await new Promise(r => setTimeout(r, 200)); };
    /* TWELVE NAMES, 'Centre' TWICE, and deliberately neither the primary key
       'Doc' nor the column under correction 'Ref' — so the CAP is the only
       thing that can bound it. The shape a hand edit of recoTemplates.json
       (a plain JSON file on the folder) gives. */
    const TWELVE = ['Centre', 'Description', 'Second Ref', 'Note', 'Acct', 'Calc',
                    'E04', 'E05', 'E06', 'E07', 'Posting Date', 'Centre'];
    AppState.activeRecoId = tplId;
    AppState._correctionCol = 'Ref';
    Reco.userPref(tplId, 'correctionCols', null);
    live().correctionContextCols = TWELVE.slice();
    await nav();
    const out = { stored: TWELVE.length };
    const r = Reco.correctionCols(live(), AppState.recoSessions[tplId]);
    out.resolved = { cols: r.cols.slice(), scope: r.scope, dropped: r.dropped, capped: r.capped };
    out.distinct = new Set(r.cols).size;
    const panel = document.querySelector('#recoContentArea .panel');
    out.chips = [...panel.querySelectorAll('.corr-ctx .tag')].map(s => s.textContent.replace(/\s*×\s*$/, '').trim());
    out.chrome = panel.querySelector('.corr-ctx').textContent.replace(/\s+/g, ' ').trim();
    const tbl = errTbl(panel);
    const tr = tbl.querySelector('tbody tr');
    out.cells = [...tr.querySelectorAll('td[data-col]')].map(td => td.dataset.col + '=' + td.textContent.trim());
    out.ths = [...tbl.querySelectorAll('thead th')].map(th => th.textContent).filter(Boolean);
    /* THE STICKINESS HALF: an over-cap list must CONVERGE on the cap, not be
       re-published in full by the next person who presses the button. */
    Reco.removeCorrectionCol('Description', 'p0');
    await new Promise(r2 => setTimeout(r2, 350));
    out.afterChipX = Reco.userPref(tplId, 'correctionCols');
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try { Reco.saveCorrectionColsAsTeam('p0'); await new Promise(r2 => setTimeout(r2, 500)); }
    finally { window.confirm = realConfirm; }
    out.teamAfterPublish = (live().correctionContextCols || []).slice();
    return out;
  }, [F6TPL, ERRTBL]);
  note('R2-F6R', { resolved: r2f6.resolved, chips: r2f6.chips.length, cells: r2f6.cells });
  check(r2f6.resolved.cols.length === 6 && r2f6.distinct === 6
        && same(r2f6.resolved.cols, ['Centre', 'Description', 'Second Ref', 'Note', 'Acct', 'Calc']),
    'R2-F6R: a twelve-name stored list with a repeat resolves to the SIX DISTINCT names the cap allows, in '
    + 'stored order', r2f6.resolved);
  check(r2f6.chips.length === 6,
    'R2-F6R: and the chip row speaks for what is rendered — twelve chips, six of which produce no cell, is '
    + 'the panel describing a list the table is not printing', r2f6.chips);
  /* The wording changed when the cap moved off the resolver and onto the render
     path: the panel now states HOW MANY are held back rather than where the list
     was cut, because the two were not the same number. The assertion is stricter
     than it was — it pins the COUNT (5 of the 11 live names, 6 rendered) as well
     as the cap, so a panel that says "6 more" or omits the sentence both fail. */
  check(/5 more not shown \(up to 6 columns\)/.test(r2f6.chrome),
    'R2-F6R: and the panel says how many the cap held back, beside the line that counts dead names',
    r2f6.chrome);
  check(r2f6.cells.length === 6 && new Set(r2f6.cells).size === 6
        && r2f6.ths.length === new Set(r2f6.ths).size,
    'R2-F6R: six context cells and no entry repeated — read as name=VALUE, so a duplicate printing the same '
    + 'number twice cannot pass as two distinct columns', { cells: r2f6.cells, ths: r2f6.ths });
  check((r2f6.afterChipX || []).length === 5,
    'R2-F6R: one chip × on that list writes FIVE names to this person\'s store, not eleven', r2f6.afterChipX);
  check(r2f6.teamAfterPublish.length === 5,
    'R2-F6R: and the next publish CONVERGES on the cap instead of putting the over-cap list back on the share',
    r2f6.teamAfterPublish);

  /* THE REGRESSION GUARD for the all-dead per-user list (finding F2 of the
     five that were handled, section [F5] above): the tri-state fallthrough
     must keep testing the FILTER result and not the slice. It is a guard,
     not a discriminator — slicing a non-empty list cannot make it empty
     while CORR_CTX_CAP is above zero — and it is here because this is the
     edit that could have broken it. */
  const r2f6c = await page.evaluate(async (tplId) => {
    const live = () => AppState.recoTemplates.find(x => x.id === tplId);
    live().correctionContextCols = ['Centre', 'Note', 'Calc'];
    Reco.userPref(tplId, 'correctionCols', ['Note', 'Calc']);
    RecoTemplate.edit(tplId);
    RecoTemplate._editing.additionalColumns = [];
    RecoTemplate.saveTemplate();
    App.closeModal();
    await new Promise(r => setTimeout(r, 250));
    AppState.activeRecoId = tplId;
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 200));
    const r = Reco.correctionCols(live(), AppState.recoSessions[tplId]);
    const out = { team: (live().correctionContextCols || []).slice(),
                  cols: r.cols.slice(), scope: r.scope, dropped: r.dropped };
    Reco.userPref(tplId, 'correctionCols', null);
    return out;
  }, F6TPL);
  check(r2f6c.scope === 'team' && same(r2f6c.cols, ['Centre']),
    'R2-F6R: a per-user list whose every name was removed from the template the real way STILL falls '
    + 'through to the surviving team name — the slice did not break the tri-state fallthrough', r2f6c);

  } catch (e) { check(false, '[R2-F6R] the over-cap stored list could not be exercised at all',
    String((e && e.message) || e).split('\n')[0].slice(0, 300)); }

  /* ====================================================================
     R2-F7 — the picker said "not shown" about a column this tab shows. The
     note is pickerCatalog's and is true of the GRID (it means "not in
     displayColumns"); the correction tab ignores displayColumns entirely.
     Someone picking columns reads it as "ticking this does nothing" and
     skips the column they wanted — and in the other direction, a column
     deliberately taken off Display Columns can be published to every
     colleague's correction screen while the publisher is being told it will
     not appear.
     ==================================================================== */
  section('R2-F7', 'R2-F7: the picker does not call a column "not shown" when this tab shows it');
  try {

  const F7TPL = 'tpl_r2_f7';
  await page.evaluate(async (tplId) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = tplId; t.name = 'HIDDEN RECON';
    t.columns = ['Doc', 'Ref', 'Hidden1', 'Amount'].map(n => ({
      name: n, label: n, formats: n === 'Ref' ? ['AA-DDDD'] : [], isValue: n === 'Amount', isDate: false }));
    t.primaryKeys = ['Doc']; t.valueColumn = 'Amount';
    /* DELIBERATELY WITHOUT 'Hidden1': Display Columns is what the note is
       about, and this tab does not consult it. */
    t.displayColumns = ['Doc', 'Ref', 'Amount'];
    t.enableCorrections = true; t.additionalColumns = [];
    RecoTemplate.saveTemplate(); RecoTemplate.open(tplId); App.closeModal();
    const sess = AppState.recoSessions[tplId];
    Reco.ensureSessionShape(sess);
    sess.data = [{ _id: tplId + '_r0', _pk: 'HD0', _ver: 'upload', Doc: 'HD0', Ref: 'bad ref',
                   Hidden1: 'H-0', Amount: '100' }];
    sess._autoLoadAttempted = true;
    sess.activeSection = 'correction';
    AppState.activeRecoId = tplId;
    AppState._correctionCol = 'Ref';
    Reco.userPref(tplId, 'correctionCols', null);
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 200));
  }, F7TPL);
  await page.click('#recoContentArea .corr-ctx button');
  await page.waitForSelector('#cpPanes label', { timeout: 5000 });
  const r2f7 = await page.evaluate(() => {
    /* By the name in the checkbox's OWN handler, not by a substring of the
       label, exactly as T9 does. */
    const rowFor = n => [...document.querySelectorAll('#appModal label.inline')]
      .find(l => { const i = l.querySelector('input');
                   return i && (i.getAttribute('onchange') || '').indexOf("toggle('" + n + "'") >= 0; });
    const noteOf = n => { const l = rowFor(n); if (!l) return null;
      const s = l.querySelector('span.text-muted');
      return { note: s ? s.textContent.trim() : '', text: l.textContent.replace(/\s+/g, ' ').trim() }; };
    const tpl = AppState.recoTemplates.find(x => x.id === AppState.activeRecoId);
    const sess = AppState.recoSessions[AppState.activeRecoId];
    return { hidden: noteOf('Hidden1'), active: noteOf('Ref'), amount: noteOf('Amount'),
             gridVisible: Reco.visibleBase(tpl, sess, { includeHidden: true }),
             catalogNote: (Reco.pickerCatalog(tpl, sess).find(c => c.name === 'Hidden1') || {}).note };
  });
  note('R2-F7 picker', r2f7);
  check(r2f7.gridVisible.indexOf('Hidden1') === -1 && r2f7.catalogNote === 'not shown',
    'the premise: the column really is off Display Columns, and pickerCatalog still says so — the two '
    + 'other pickers that read that note are right to show it (run_colorder T12 pins the string)', r2f7);
  check(!!r2f7.hidden && !/not shown/.test(r2f7.hidden.text),
    'R2-F7: the CORRECTION picker does not say "not shown" about a column this tab shows', r2f7.hidden);
  check(!!r2f7.hidden && /shown here/i.test(r2f7.hidden.note),
    'R2-F7: it says what is true on this tab instead', r2f7.hidden);
  check(!!r2f7.active && /already shown as Current Value/i.test(r2f7.active.text),
    'R2-F7: and the two notes this picker already set are untouched', r2f7.active);
  /* A REAL CLICK on the checkbox, then the real Done button. */
  await page.evaluate(() => {
    const l = [...document.querySelectorAll('#appModal label.inline')]
      .find(x => { const i = x.querySelector('input');
                   return i && (i.getAttribute('onchange') || '').indexOf("toggle('Hidden1'") >= 0; });
    l.querySelector('input').click();
  });
  await page.click('#appModalFooter button.success');
  await page.waitForTimeout(450);
  const r2f7b = await page.evaluate((arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    const panel = document.querySelector('#recoContentArea .panel');
    const tr = errTbl(panel).querySelector('tbody tr');
    const cell = tr.querySelector('td[data-col="Hidden1"]');
    const out = { stored: Reco.userPref(tplId, 'correctionCols'), cell: cell ? cell.textContent.trim() : null };
    Reco.userPref(tplId, 'correctionCols', null);
    return out;
  }, [F7TPL, ERRTBL]);
  check(same(r2f7b.stored, ['Hidden1']) && r2f7b.cell === 'H-0',
    'R2-F7: and the column the operator ticked renders WITH ITS VALUE, which is what makes the old note '
    + 'false on this tab', r2f7b);

  } catch (e) { check(false, '[R2-F7] the picker note could not be exercised at all',
    String((e && e.message) || e).split('\n')[0].slice(0, 300)); }

  /* ====================================================================
     R2-F12 — the early stop was matched by NAME, so two added columns
     sharing a name stopped the walk at the FIRST of them, before the chosen
     column, and the context cell rendered BLANK while the grid showed the
     value. An empty "Approved by" beside a bad reference is a different
     decision from "this screen could not work it out", and nothing on
     screen said which it was.

     The fixture is built from the TWO ORDINARY GESTURES that reach the
     shape — a session-only column, then a template column of the same name
     — because saveTemplate has no session and cannot see the collision.
     That is the reachability half, and it is asserted, not assumed.
     ==================================================================== */
  section('R2-F12', 'R2-F12: two added columns sharing a name do not stop the walk before the chosen one');
  try {

  const F12TPL = 'tpl_r2_f12';
  const r2f12 = await page.evaluate(async (arg) => {
    const [tplId, ERRTBL] = arg;
    const errTbl = new Function('return ' + ERRTBL)();
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = tplId; t.name = 'DUPNAME RECON';
    t.columns = ['Doc', 'Ref', 'Amount'].map(n => ({
      name: n, label: n, formats: n === 'Ref' ? ['AA-DDDD'] : [], isValue: n === 'Amount', isDate: false }));
    t.primaryKeys = ['Doc']; t.valueColumn = 'Amount';
    t.displayColumns = ['Doc', 'Ref', 'Amount'];
    t.enableCorrections = true; t.additionalColumns = [];
    RecoTemplate.saveTemplate(); RecoTemplate.open(tplId); App.closeModal();
    const live = () => AppState.recoTemplates.find(x => x.id === tplId);
    const sess0 = AppState.recoSessions[tplId];
    Reco.ensureSessionShape(sess0);
    sess0.data = [{ _id: tplId + '_r0', _pk: 'FD0', _ver: 'upload', Doc: 'FD0', Ref: 'bad ref', Amount: '100' }];
    sess0._autoLoadAttempted = true;
    sess0.activeSection = 'correction';
    AppState.activeRecoId = tplId;
    AppState._correctionCol = 'Ref';
    const out = {};

    /* GESTURE 1 — "+ Col", session-only. */
    window.__toasts = [];
    Reco.ssOpenAddColModal();
    await new Promise(r => setTimeout(r, 140));
    document.getElementById('ssNewColName').value = 'Note';
    const persist = document.getElementById('ssNewColPersist');
    if (persist) persist.checked = false;
    Reco.ssCommitAddCol();
    await new Promise(r => setTimeout(r, 300));
    out.addToasts = (window.__toasts || []).map(x => x.msg);
    out.sessExtras = (AppState.recoSessions[tplId].extraColumns || []).map(a => a.name);

    /* GESTURE 2 — the template editor adds a column of the same name, which
       it cannot see, and one more AFTER it. */
    window.__toasts = [];
    RecoTemplate.edit(tplId);
    RecoTemplate._editing.additionalColumns = [
      { name: 'Note', type: 'custom' },
      { name: 'Reviewer', type: 'formula', formula: 'CONCAT("rev-",{Doc})' }];
    RecoTemplate.saveTemplate();
    App.closeModal();
    await new Promise(r => setTimeout(r, 300));
    out.saveToasts = (window.__toasts || []).map(x => x.msg);
    out.extrasOrder = (live().additionalColumns || []).map(a => a.name)
      .concat((AppState.recoSessions[tplId].extraColumns || []).map(a => a.name));
    out.upto = Reco._corrUpto(live(), AppState.recoSessions[tplId], ['Reviewer']);

    /* THE GRID, so the comparison is against a RENDERED cell. */
    const sess = AppState.recoSessions[tplId];
    AppState.activeRecoId = tplId;
    sess.activeSection = 'action';
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 350));
    const gtr = document.querySelector('.reco-table-wrap tbody tr');
    const grid = {};
    [...(gtr ? gtr.querySelectorAll('td[data-col]') : [])].forEach(td => { grid[td.dataset.col] = td.textContent.trim(); });
    out.grid = grid;

    /* THEN the correction tab with 'Reviewer' chosen. */
    Reco.userPref(tplId, 'correctionCols', ['Reviewer']);
    sess.activeSection = 'correction';
    window.__evals = {};
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 350));
    const panel = document.querySelector('#recoContentArea .panel');
    const rows = [...errTbl(panel).querySelectorAll('tbody tr')];
    out.rendered = rows.length;
    const cell = rows[0].querySelector('td[data-col="Reviewer"]');
    out.corr = cell ? cell.textContent.trim() : null;
    out.evals = JSON.parse(JSON.stringify(window.__evals || {}));

    /* AND THE TYPED VALUE: the same column as the free-text tag "+ Col"
       actually creates, with a value the operator typed. */
    RecoTemplate.edit(tplId);
    RecoTemplate._editing.additionalColumns = [
      { name: 'Note', type: 'custom' }, { name: 'Reviewer', type: 'custom' }];
    RecoTemplate.saveTemplate();
    App.closeModal();
    await new Promise(r => setTimeout(r, 300));
    const sess2 = AppState.recoSessions[tplId];
    sess2.manualTags = sess2.manualTags || {};
    sess2.manualTags[Reco._tagKey(sess2.data[0], 'Reviewer')] = 'Approved by AR';
    sess2.activeSection = 'correction';
    AppState.activeRecoId = tplId;
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 350));
    const tr2 = errTbl(document.querySelector('#recoContentArea .panel')).querySelector('tbody tr');
    const c2 = tr2.querySelector('td[data-col="Reviewer"]');
    out.typed = c2 ? c2.textContent.trim() : null;
    Reco.userPref(tplId, 'correctionCols', null);
    return out;
  }, [F12TPL, ERRTBL]);
  note('R2-F12', { extras: r2f12.extrasOrder, upto: r2f12.upto, grid: r2f12.grid,
                   corr: r2f12.corr, typed: r2f12.typed, evals: r2f12.evals });
  check(same(r2f12.extrasOrder, ['Note', 'Reviewer', 'Note'])
        && r2f12.addToasts.some(m => /session-only/.test(m))
        && r2f12.saveToasts.some(m => /Template saved/.test(m)),
    'R2-F12 REACHABILITY: two ordinary gestures and no file import produce two added columns sharing a '
    + 'name — "+ Col" session-only, then the template editor, which has no session to check against',
    { extras: r2f12.extrasOrder, add: r2f12.addToasts, save: r2f12.saveToasts });
  check(r2f12.grid.Reviewer === 'rev-FD0',
    'the premise: the GRID renders the chosen column\'s value, so a blank context cell is a divergence and '
    + 'not an empty column', r2f12.grid);
  check(r2f12.corr === 'rev-FD0' && r2f12.corr === r2f12.grid.Reviewer,
    'R2-F12: the context cell is CHARACTER FOR CHARACTER the grid\'s cell — the walk is no longer stopped '
    + 'at the first extra that happens to share a name with the one after the chosen column',
    { corr: r2f12.corr, grid: r2f12.grid.Reviewer, upto: r2f12.upto });
  check(r2f12.evals.Reviewer === r2f12.rendered && r2f12.rendered > 0,
    'R2-F12: and it was EVALUATED once per rendered row — counting, because _extraOwnValue catches its own '
    + 'throw and an empty cell from any other cause would otherwise look the same',
    { evals: r2f12.evals, rendered: r2f12.rendered });
  check(r2f12.typed === 'Approved by AR',
    'R2-F12: and a value the operator TYPED into that column reads back in the context cell — an empty '
    + '"Approved by" beside a bad reference says nobody signed it off', r2f12.typed);

  } catch (e) { check(false, '[R2-F12] the duplicate added-column name could not be exercised at all',
    String((e && e.message) || e).split('\n')[0].slice(0, 300)); }

  const toasts = await readToasts(page);
  check(!toasts.some(t => /^Could not save|does not match required format/.test(t.msg) && t.kind === 'error'),
    'no save or format failure anywhere in the single-pane run',
    toasts.filter(t => t.kind === 'error').slice(0, 5));
  check(S.errors.length === 0, 'no page or console errors in the single-pane run', S.errors.slice(0, 5));

  /* ====================================================================
     [11] T13 / T14 — two panes, two templates, one shared modal
     ==================================================================== */
  section(13, 'T13/T14: both panes on the Correction tab, and the picker that lives in the one modal');

  const bridgeP = await startBridge(makeRoot('panes').root, PORT_PANES);
  procs.push(bridgeP.proc);
  const P = await openReco(browser, bridgeP);
  const pg = P.page;
  await pg.evaluate(new Function('arg', 'return ' + SETUP + '(arg)'), ['BANK', 40, 30, 4, true]);
  await pg.evaluate(new Function('arg', 'return ' + SETUP + '(arg)'), ['LEDGER', 40, 30, 4, true]);
  await pg.evaluate(async () => {
    AppState.activeRecoId = 'BANK';
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 200));
    Panes.openSplit();
    await new Promise(r => setTimeout(r, 300));
    Panes.setPaneTemplate('p1', 'LEDGER');
    await new Promise(r => setTimeout(r, 400));
    Panes.eachPane(p => { const v = Panes.viewFor(p.key, p.tplId); if (v) v.activeSection = 'correction'; });
    Panes.repaint();
    await new Promise(r => setTimeout(r, 400));
  });
  const premise = await pg.evaluate(() => ({
    panes: Panes.panes().map(p => p.key + ':' + p.tplId).join(','),
    tabs: Panes.panes().map(p => (Panes.viewFor(p.key, p.tplId) || {}).activeSection),
    boxes: [...document.querySelectorAll('.reco-pane')].map(r => r.querySelectorAll('input[placeholder="Enter corrected value"]').length)
  }));
  check(premise.panes === 'p0:BANK,p1:LEDGER' && same(premise.tabs, ['correction', 'correction'])
        && premise.boxes[0] === 30 && premise.boxes[1] === 30,
    'the premise: two panes, two templates, BOTH on the Correction tab, 30 error rows each', premise);

  /* THE GATE CLAUSE. Counted here as well as asked of the helper: the helper
     is the thing under test as much as the markup is. */
  const audit = await pg.evaluate(() => {
    const n = {}, mine = [];
    document.querySelectorAll('[id]').forEach(el => {
      if (el.closest && el.closest('#appModal')) return;
      n[el.id] = (n[el.id] || 0) + 1;
    });
    Object.keys(n).forEach(k => { if (n[k] > 1) mine.push(k + '×' + n[k]); });
    return { helper: Panes.dupIdAudit(), counted: mine, idsInPanel:
      [...document.querySelectorAll('.reco-pane .panel [id]')].map(e => e.id) };
  });
  check(audit.helper.ok, 'T13: Panes.dupIdAudit() is {ok:true} with both panes on the Correction tab', audit.helper);
  check(audit.counted.length === 0, 'T13: and counting every id in the document myself agrees', audit.counted);
  check(audit.idsInPanel.length === 0,
    'T13: #27 added NO id to the correction panel at all — not per row, not per column, not one',
    audit.idsInPanel);

  try {

  const chipSides = await pg.evaluate(async (ERRTBL) => {
    const errTbl = new Function('return ' + ERRTBL)();
    /* Choose in the RIGHT pane, through the real route, with that pane the
       owner — the gesture that opens the picker is the gesture that sets the
       owner, which is the rule. */
    Panes.focusSlot(1);
    await new Promise(r => setTimeout(r, 100));
    Reco.openCorrectionCols(Panes.owner().key);
    const stamped = Reco._corrPick ? { paneKey: Reco._corrPick.paneKey, tplId: Reco._corrPick.tplId } : null;
    ColPicker.toggle('Centre', true);
    ColPicker.toggle('Amount', true);
    ColPicker.done();
    await new Promise(r => setTimeout(r, 500));
    const chips = [...document.querySelectorAll('.reco-pane')].map(r =>
      [...r.querySelectorAll('.corr-ctx .tag')].map(s => s.textContent.replace(/\s*×\s*$/, '').trim()));
    const ctxCols = [...document.querySelectorAll('.reco-pane')].map(r => {
      const t = errTbl(r);
      return t ? [...t.querySelectorAll('tbody tr:first-child td[data-col]')].map(td => td.dataset.col) : ['<no table>'];
    });
    return { stamped, chips, ctxCols,
      mineBank: Reco.userPref('BANK', 'correctionCols'), mineLedger: Reco.userPref('LEDGER', 'correctionCols'),
      dup: Panes.dupIdAudit() };
  }, ERRTBL);
  check(chipSides.stamped && chipSides.stamped.paneKey === 'p1' && chipSides.stamped.tplId === 'LEDGER',
    'T14: the picker stamps the pane and the template it was OPENED on', chipSides.stamped);
  check(same(chipSides.chips[1], ['Centre', 'Amount']) && same(chipSides.chips[0], []),
    'T13: THE RIGHT PANE\'S CHIP ROW CHANGED AND THE LEFT PANE\'S DID NOT', chipSides.chips);
  check(same(chipSides.ctxCols[1], ['Centre', 'Amount']) && same(chipSides.ctxCols[0], []),
    'T13: and the context cells appear in the right pane\'s table only', chipSides.ctxCols);
  check(same(chipSides.mineLedger, ['Centre', 'Amount']) && chipSides.mineLedger && !chipSides.mineBank,
    'T13: the choice is stored against the RIGHT pane\'s template, not the active one', chipSides);
  check(chipSides.dup.ok, 'T13: still no duplicate id with the chips and the chrome in both panes', chipSides.dup);

  /* Context columns in BOTH panes, then Apply in the right one. */
  await pg.evaluate(async () => {
    Reco.userPref('BANK', 'correctionCols', ['Centre']);
    Panes.repaint();
    await new Promise(r => setTimeout(r, 400));
  });
  for (const b of await pg.$$('.reco-pane[data-pane="0"] input[placeholder="Enter corrected value"]')) await b.fill('XY-1000');
  for (const b of await pg.$$('.reco-pane[data-pane="1"] input[placeholder="Enter corrected value"]')) await b.fill('XY-9000');
  const beforeP = await pg.evaluate(() => ({
    bank: AppState.recoSessionsOwned.BANK.data.map(r => r.Doc + '=' + r.Ref),
    ledger: AppState.recoSessionsOwned.LEDGER.data.map(r => r.Doc + '=' + r.Ref)
  }));
  await clearToasts(pg);
  {
    /* The LAST error row on purpose — the row furthest from the one a bare
       `button:has-text("Apply")` would find. It is below the fold of the
       pane's own scroller, so it has to be brought into view before a real
       pointerdown+click can land on it; clicking its off-screen coordinates
       hits whatever happens to be at that point on screen, which is how this
       assertion first reported "nothing changed". */
    const btn = await pg.$('.reco-pane[data-pane="1"] tbody tr:last-child button');
    await btn.scrollIntoViewIfNeeded();
    const bb = await btn.boundingBox();
    await pg.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await pg.mouse.down();
    await pg.mouse.up();
  }
  await pg.waitForTimeout(500);
  const appliedP = await pg.evaluate(() => ({
    owner: Panes.owner().key,
    toasts: (window.__toasts || []).map(t => t.kind + ': ' + t.msg),
    bank: AppState.recoSessionsOwned.BANK.data.map(r => r.Doc + '=' + r.Ref),
    ledger: AppState.recoSessionsOwned.LEDGER.data.map(r => r.Doc + '=' + r.Ref),
    cmBank: JSON.parse(JSON.stringify(AppState.correctionMaster.BANK || null)),
    cmLedger: JSON.parse(JSON.stringify(AppState.correctionMaster.LEDGER || null))
  }));
  const bankMoved = appliedP.bank.filter((v, i) => v !== beforeP.bank[i]);
  const ledgerMoved = appliedP.ledger.filter((v, i) => v !== beforeP.ledger[i]);
  check(appliedP.owner === 'p1', 'the premise: the pane that was clicked is the owner', appliedP.owner);
  check(ledgerMoved.length === 1 && /=XY-9000$/.test(ledgerMoved[0]),
    'T13: APPLY IN THE RIGHT PANE, WITH CONTEXT COLUMNS CHOSEN IN BOTH, CORRECTS THE RIGHT PANE\'S ROW '
    + 'IN THE RIGHT PANE\'S TEMPLATE',
    { moved: ledgerMoved, was: beforeP.ledger.slice(-2), toasts: appliedP.toasts });
  check(bankMoved.length === 0 && (!appliedP.cmBank || !Object.keys(appliedP.cmBank).length),
    'T13: and the other reconciliation\'s rows and shared correction master were never touched',
    { moved: bankMoved, cm: appliedP.cmBank });

  /* THE "SHOW 200 MORE" COUNTER IS PER PANE. Found by reading the split path
     after the rest of this suite was green: Panes.repaint() renders p0 and
     then p1, so with ONE (signature, count) pair p0's render — a different
     template, a different signature — reset the count p1 had just raised, and
     the button did nothing at all in the right-hand pane. Asserted on
     _corrExtra directly because the thing under test is which pane a raise
     belongs to; the button itself is exercised through the DOM in [6]. */
  const perPane = await pg.evaluate(() => {
    const A = { id: '__paneA' }, B = { id: '__paneB' };   // only tpl.id is read
    Reco._corrMore = {};
    Reco._corrExtra('p1', B, 'Ref', ['Centre']);          // p1's render arms its entry
    Reco._corrMore.p1.n += Reco.CORR_ROW_CAP;             // and the operator asks for more
    const afterAsk = Reco._corrExtra('p1', B, 'Ref', ['Centre']);
    Reco._corrExtra('p0', A, 'Ref', ['Centre']);          // now the OTHER pane renders
    const out = {
      afterAsk: afterAsk,
      stillThere: Reco._corrExtra('p1', B, 'Ref', ['Centre']),
      otherPane: Reco._corrExtra('p0', A, 'Ref', ['Centre']),
      afterNewList: Reco._corrExtra('p1', B, 'Ref', ['Centre', 'Amount'])
    };
    /* AND THE IMPLEMENTATION THIS REPLACED, patched in beside it and asked
       the same questions. It must get the raise right and LOSE it on the
       other pane's render, or the assertion above is guarding nothing. */
    let oldN = 0, oldSig = null;
    const oldExtra = (paneKey, tpl, colName, cols) => {     // the shape it had: no pane key
      const sig = Reco._corrSig(tpl, colName, cols);
      if (oldSig !== sig) { oldSig = sig; oldN = 0; }
      return oldN;
    };
    oldExtra('p1', B, 'Ref', ['Centre']);
    oldN += Reco.CORR_ROW_CAP;
    out.oldAfterAsk = oldExtra('p1', B, 'Ref', ['Centre']);
    oldExtra('p0', A, 'Ref', ['Centre']);
    out.oldStillThere = oldExtra('p1', B, 'Ref', ['Centre']);
    Reco._corrMore = {};
    return out;
  });
  check(perPane.afterAsk === 200 && perPane.stillThere === 200,
    'THE CAP RAISE SURVIVES THE OTHER PANE\'S RENDER — one entry per pane, not one for the document',
    perPane);
  check(perPane.otherPane === 0,
    'and it belongs to the pane that asked for it, not to both', perPane);
  check(perPane.afterNewList === 0,
    'and a different chosen set starts again from 200 (decision B)', perPane);
  check(perPane.oldAfterAsk === 200 && perPane.oldStillThere === 0,
    'and the version this replaced LOSES the raise on the other pane\'s render — so that assertion bites',
    perPane);

  /* T14 — the picker is in the ONE shared modal, so clicking in it focuses no
     pane. Open it on LEDGER, move that pane to BANK behind it, press Done. */
  const t14 = await pg.evaluate(async () => {
    Panes.focusSlot(1);
    await new Promise(r => setTimeout(r, 100));
    Reco.openCorrectionCols(Panes.owner().key);
    const stamped = Object.assign({}, Reco._corrPick);
    Panes.setPaneTemplate('p1', 'BANK');
    await new Promise(r => setTimeout(r, 400));
    const mineBefore = { bank: Reco.userPref('BANK', 'correctionCols'), ledger: Reco.userPref('LEDGER', 'correctionCols') };
    window.__toasts = [];
    ColPicker.toggle('Posting Date', true);
    ColPicker.done();
    await new Promise(r => setTimeout(r, 400));
    return { stamped, mineBefore,
      bank: Reco.userPref('BANK', 'correctionCols'), ledger: Reco.userPref('LEDGER', 'correctionCols'),
      toasts: (window.__toasts || []).map(t => t.msg), paneNow: Panes.byKey('p1').tplId };
  });
  note('refusal', t14.toasts);
  check(t14.paneNow === 'BANK' && t14.stamped.tplId === 'LEDGER',
    'the premise: the picker was opened on LEDGER and that pane now shows BANK', t14);
  check(same(t14.bank, t14.mineBefore.bank) && same(t14.ledger, t14.mineBefore.ledger),
    'T14: DONE WROTE NOTHING — not to the template that happens to be active, not to the one it was opened on',
    { before: t14.mineBefore, after: { bank: t14.bank, ledger: t14.ledger } });
  check(t14.toasts.some(m => /CORR LEDGER|LEDGER/.test(m) && /CORR BANK|BANK/.test(m)),
    'T14: and it is REFUSED with a sentence naming BOTH templates, not a silent no-op', t14.toasts);

  } catch (e) { check(false, '[13] the two-pane half could not be exercised at all',
    String((e && e.message) || e).split('\n')[0].slice(0, 300)); }

  const pToasts = await readToasts(pg);
  check(!pToasts.some(t => /^Could not save/.test(t.msg)), 'no save failure in the split run',
    pToasts.filter(t => t.kind === 'error').slice(0, 5));
  check(P.errors.length === 0, 'no page or console errors in the split run', P.errors.slice(0, 6));

} finally {
  clearTimeout(watchdog);
  await browser.close();
  procs.forEach(p => { try { p.kill(); } catch (e) {} });
}

console.log('\n' + (failures ? '✗ ' : '✓ ') + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
