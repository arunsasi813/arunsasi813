// End-to-end tests for the reconciliation grid at scale: what it costs to
// open a slicer on a near-unique column, whether a click that changes one
// thing re-renders everything, whether a long operation says so, how a user
// gets around a thousand pages, and whether the faster sort still puts the
// rows in exactly the order the old one did.
//
//   node tests/e2e/run_grid_scale_e2e.mjs
//
// Needs: python3, Playwright (Chromium). Exits non-zero on failure.
//
// Timing assertions are deliberately loose — several times what the operation
// costs now, but far below what it cost before — so they survive a slow CI
// box while still failing if the old behaviour comes back. Each one says both
// numbers in its message.

import { spawn } from 'node:child_process';
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
const PORT = 18936;
const BIG = 200000;

let failures = 0, passes = 0;
function check(cond, msg, extra) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 700) : '')); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function eqCheck(got, expected, msg) { check(same(got, expected), msg, { got, expected }); }
/* Bounded time: `was` is what the operation cost before the fix, quoted so a
   reader of a failure can see what the budget is protecting. */
function under(ms, budget, msg, was) {
  check(typeof ms === 'number' && ms < budget, msg + ' (' + ms + 'ms, budget ' + budget + 'ms, was ~' + was + 'ms)', { ms });
}

function makeRoot(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-grid-'));
  const root = path.join(base, name);
  const cp = (src, dst) => {
    fs.mkdirSync(path.dirname(path.join(root, dst)), { recursive: true });
    fs.copyFileSync(path.join(REPO, src), path.join(root, dst));
  };
  cp('apps/Reco.html', 'apps/Reco.html');
  for (const f of fs.readdirSync(path.join(REPO, 'apps/lib'))) cp('apps/lib/' + f, 'apps/lib/' + f);
  for (const f of ['jspreadsheet.js', 'jspreadsheet.css', 'jsuites.js', 'jsuites.css']) cp('tests/e2e/vendor/' + f, 'apps/lib/' + f);
  fs.mkdirSync(path.join(root, 'master'), { recursive: true });
  fs.writeFileSync(path.join(root, 'master/user.csv'), `ID,Name,Email,reco\r\n${OS_USER},Test User,,1\r\n`);
  return root;
}

async function startBridge(root, port) {
  const proc = spawn('python3', [path.join(HERE, 'bridge_server.py'), root, String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => {
    proc.stdout.on('data', d => { if (String(d).includes('READY')) res(); });
    proc.on('exit', c => rej(new Error('bridge exited ' + c)));
  });
  const shim = await (await fetch(`http://127.0.0.1:${port}/__shim.js`)).text();
  return { proc, shim, url: `http://127.0.0.1:${port}` };
}

async function openReco(browser, bridge) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(bridge.shim);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto(bridge.url + '/apps/Reco.html');
  await page.waitForSelector('#appMain .panel', { timeout: 20000 });
  return { ctx, page, errors };
}

/* A template with a date column, a value column, a four-value column, a
   near-unique reference column, a formula extra and a free tag — then N rows
   loaded straight into the session, the way a bank extract arrives. */
async function setUp(page, name, n) {
  return page.evaluate(async ([name, n]) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.name = name;
    t.columns = ['Doc', 'Date', 'Amount', 'Status', 'Ref', 'Cur']
      .map(c => ({ name: c, label: c, formats: [], isValue: c === 'Amount', isDate: c === 'Date' }));
    t.primaryKeys = ['Doc']; t.valueColumn = 'Amount'; t.editableColumns = ['Status'];
    t.displayColumns = t.columns.map(c => c.name);
    t.additionalColumns = [{ name: 'Calc', type: 'formula', formula: '{Amount}*2' }, { name: 'Tag', type: 'custom' }];
    t.enableCorrections = true; t.enableReporting = true;
    t.toleranceValue = 1e12;              // so the selection bar reports "within"
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.name === name);
    RecoTemplate.open(tpl.id);
    const sess = AppState.recoSessions[tpl.id];
    Reco.ensureSessionShape(sess);
    const cur = ['USD', 'EUR', 'AED', 'RUB'];
    const data = new Array(n);
    for (let i = 0; i < n; i++) data[i] = {
      _id: 'i' + i, _pk: 'P' + i, Doc: 'P' + i,
      Date: String(1 + (i % 28)).padStart(2, '0') + '/' + String(1 + (i % 12)).padStart(2, '0') + '/202' + (4 + i % 3),
      Amount: String((i % 99991) / 100), Status: i % 3 ? 'Open' : 'Cleared',
      Ref: 'R' + i, Cur: cur[i % 4], _ver: 'upload'
    };
    sess.data = data;
    sess._autoLoadAttempted = true;
    App.navigate('reco');
    await new Promise(r => requestAnimationFrame(r));
    return tpl.id;
  }, [name, n]);
}

const watchdog = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15 * 60 * 1000);
const procs = [];
const killAll = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });

const browser = await chromium.launch();
try {
  const root = makeRoot('shared');
  const bridge = await startBridge(root, PORT);
  procs.push(bridge.proc);
  const S = await openReco(browser, bridge);
  const { page } = S;

  const tplId = await setUp(page, 'GRID', BIG);

  /* ====================================================================
     [1] Slicer on a 200,000-distinct column
     ==================================================================== */
  console.log('\n[1] Slicer on a column with 200,000 distinct values');
  const sl = await page.evaluate(async () => {
    const o = {};
    const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    let t = performance.now();
    await Reco.openSlicer('Ref');
    await raf();
    o.openMs = Math.round(performance.now() - t);
    o.nodes = document.querySelectorAll('#slicerItems .slicer-item').length;
    o.htmlLen = document.getElementById('slicerItems').innerHTML.length;
    o.countLine = document.getElementById('slicerCount').textContent;
    o.cap = Reco.SLICER_CAP;
    o.hasSearchBox = !!document.getElementById('slicerSearch');
    // per-value counts are on screen
    o.firstItemText = (document.querySelector('#slicerItems .slicer-item') || {}).textContent || '';

    // search narrows to the real matches
    t = performance.now();
    Reco._slicerSearch('R12345');
    await new Promise(r => setTimeout(r, 140));
    o.searchMs = Math.round(performance.now() - t);
    o.searchNodes = document.querySelectorAll('#slicerItems .slicer-item').length;
    o.searchLine = document.getElementById('slicerCount').textContent;
    o.searchVals = [...document.querySelectorAll('#slicerItems .slicer-item')].map(e => e.dataset.val).sort();

    // "Select matching" takes every match, then Apply
    Reco._slicerSelectMatching();
    o.selSize = Reco._slicerState.sel.size;
    Reco._slicerApply();
    await raf();
    const tpl = AppState.recoTemplates.find(x => x.name === 'GRID');
    const sess = AppState.recoSessions[tpl.id];
    o.slicedRows = Reco.applyTableFiltersSort(tpl, sess).length;
    o.savedSel = (sess.slicers.Ref || []).length;
    return o;
  });
  under(sl.openMs, 1500, '1.1 the slicer opens on a 200k-distinct column', 5819);
  check(sl.nodes === sl.cap, '1.2 the list is capped, not one node per distinct value', { nodes: sl.nodes, cap: sl.cap, wasNodes: BIG });
  check(sl.htmlLen < 500000, '1.3 the markup stays small', { htmlLen: sl.htmlLen, wasHtmlLen: 19177812 });
  check(/200,000 distinct values/.test(sl.countLine), '1.4 it states the true number of distinct values', sl.countLine);
  check(/showing the first 500/.test(sl.countLine) && /type to narrow/.test(sl.countLine),
    '1.5 it says plainly that it is showing a subset, and how to see more', sl.countLine);
  check(sl.hasSearchBox, '1.6 the capped list is searchable');
  check(/\b1\b/.test(sl.firstItemText), '1.7 each value shows how many rows have it', sl.firstItemText);
  under(sl.searchMs, 600, '1.8 searching the list responds', 1901);
  eqCheck(sl.searchVals,
    ['R12345', 'R123450', 'R123451', 'R123452', 'R123453', 'R123454', 'R123455', 'R123456', 'R123457', 'R123458', 'R123459'],
    '1.9 the search finds every matching value out of 200,000 and nothing else');
  check(sl.selSize === 11, '1.10 "Select matching" takes every match, not just what is rendered', sl.selSize);
  check(sl.savedSel === 11, '1.11 Apply saves all 11 picked values', sl.savedSel);
  check(sl.slicedRows === 11, '1.12 the grid is filtered to exactly those rows', sl.slicedRows);

  // A value a user picked before opening the modal must survive the cap.
  const keep = await page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.name === 'GRID');
    const sess = AppState.recoSessions[tpl.id];
    // "R99999" sorts far past the first 500 values, so it is not rendered.
    sess.slicers.Ref = ['R99999'];
    await Reco.openSlicer('Ref');
    const shown = [...document.querySelectorAll('#slicerItems .slicer-item')].map(e => e.dataset.val);
    const o = { renderedCount: shown.length, selectedIsShownFirst: shown[0] === 'R99999' };
    Reco._slicerSearch('R100');                      // search away from it
    await new Promise(r => setTimeout(r, 140));
    Reco._slicerApply();                             // Apply while it is off screen
    o.afterApply = (sess.slicers.Ref || []).slice();
    delete sess.slicers.Ref;
    App.closeModal();
    return o;
  });
  check(keep.selectedIsShownFirst, '1.13 an already-picked value is pulled to the front of the capped list', keep);
  eqCheck(keep.afterApply, ['R99999'],
    '1.14 a picked value that is off screen when Apply is pressed is not silently dropped');

  const low = await page.evaluate(async () => {
    const t = performance.now();
    await Reco.openSlicer('Cur');
    const o = { ms: Math.round(performance.now() - t) };
    o.nodes = document.querySelectorAll('#slicerItems .slicer-item').length;
    o.line = document.getElementById('slicerCount').textContent;
    o.counts = [...document.querySelectorAll('#slicerItems .slicer-item')].map(e => e.title);
    App.closeModal();
    return o;
  });
  // Every value the slicer offers must be one the grid's own slicer matcher
  // can match. They coerce a value to text separately, so if they ever drift
  // a user picks a value and gets an empty table.
  const coerce = await page.evaluate(async () => {
    const tpl = AppState.recoTemplates.find(x => x.name === 'GRID');
    const sess = AppState.recoSessions[tpl.id];
    // A formula extra that yields the number 0 on a third of the rows, and
    // blanks on some, is the case where the two sides can disagree.
    tpl.additionalColumns.push({ name: 'Zeroish', type: 'formula', formula: '{Amount}*0' });
    const got = await Reco._slicerDistinct(tpl, sess, 'Zeroish');
    const o = { values: got.values.slice(0, 4) };
    // Pick every value offered; every one of them must select some rows.
    o.unmatchable = [];
    for (const v of got.values) {
      sess.slicers = { Zeroish: [v] };
      if (Reco.applyTableFiltersSort(tpl, sess).length === 0) o.unmatchable.push(v);
    }
    sess.slicers = {};
    tpl.additionalColumns = tpl.additionalColumns.filter(c => c.name !== 'Zeroish');
    return o;
  });
  eqCheck(coerce.unmatchable, [],
    '1.14b every value the slicer offers matches at least one row (the list and the filter agree on blanks and zeros)');
  check(low.nodes === 4, '1.15 a four-value column still lists all four, uncapped', low.nodes);
  check(!/showing the first/.test(low.line) && /4 distinct values/.test(low.line),
    '1.16 and does not claim to be showing a subset', low.line);
  check(low.counts.every(t => /50,000 rows/.test(t)), '1.17 the row count per value is right', low.counts);
  under(low.ms, 600, '1.18 a low-cardinality slicer opens without a progress detour', 31);

  /* ====================================================================
     [2] A click that changes one thing does not re-render everything
     ==================================================================== */
  console.log('\n[2] Surgical updates: selection, paging, slicer chips');
  const surg = await page.evaluate(async () => {
    const o = {};
    const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tpl = AppState.recoTemplates.find(x => x.name === 'GRID');
    const sess = AppState.recoSessions[tpl.id];
    sess.slicers = {}; sess.columnFilters = {}; sess.columnSorts = null; sess.page = 0;
    App.navigate('reco'); await raf();

    // A marker in the topbar survives a surgical update and dies in a full render.
    const plant = () => {
      const bar = document.querySelector('.reco-topbar');
      const m = document.createElement('span'); m.id = 'survivorMark';
      bar.appendChild(m);
    };
    const alive = () => !!document.getElementById('survivorMark');

    plant();
    let t = performance.now();
    Reco.toggleRowSelect(sess.data[0]._id, true);
    await raf();
    o.oneRowMs = Math.round(performance.now() - t);
    o.oneRowSurvived = alive();
    o.oneRowTicked = !!document.querySelector('.reco-table-wrap tbody tr[data-rid="i0"]').classList.contains('selected');
    o.barAfterOne = document.getElementById('selSumBar').textContent;
    o.headerPartial = document.getElementById('recoSelectAll').indeterminate;

    t = performance.now();
    await Reco.toggleAllRows(true);
    await raf();
    o.allMs = Math.round(performance.now() - t);
    o.allSurvived = alive();
    o.allCount = Object.keys(sess.selectedRows).length;
    o.allVisibleTicked = [...document.querySelectorAll('.reco-table-wrap tbody tr[data-rid]')]
      .every(tr => tr.classList.contains('selected'));
    o.barAfterAll = document.getElementById('selSumBar').textContent;
    o.headerAllTicked = document.getElementById('recoSelectAll').checked;

    t = performance.now();
    Reco.clearSelection();
    await raf();
    o.clearMs = Math.round(performance.now() - t);
    o.clearSurvived = alive();
    o.clearNoneTicked = [...document.querySelectorAll('.reco-table-wrap tbody tr[data-rid]')]
      .every(tr => !tr.classList.contains('selected'));
    o.barHidden = !document.getElementById('selSumBar').classList.contains('show');
    o.headerEmpty = !document.getElementById('recoSelectAll').checked
                 && !document.getElementById('recoSelectAll').indeterminate;

    t = performance.now();
    Reco.setPage(500);
    await raf();
    o.pageMs = Math.round(performance.now() - t);
    o.pageSurvived = alive();
    o.pagerText = document.querySelector('.page-info').textContent;
    // The page must start at its first row. Keeping the previous offset left
    // the first rows of the new page above the viewport, silently unread.
    const pw = document.querySelector('.reco-table-wrap');
    o.pageScrollTop = pw ? pw.scrollTop : -1;
    const firstTr = document.querySelector('.reco-table-wrap tbody tr[data-frow]');
    o.pageFirstFrow = firstTr ? Number(firstTr.dataset.frow) : -1;

    // A slicer chip's × refreshes the chip strip and the table, nothing else.
    sess.slicers = { Cur: ['USD', 'EUR'] }; sess.page = 0;
    App.navigate('reco'); await raf();
    plant();
    t = performance.now();
    Reco.toggleSlicer('Cur', 'EUR');
    await raf();
    o.chipMs = Math.round(performance.now() - t);
    o.chipSurvived = alive();
    o.chipsLeft = document.querySelectorAll('#recoSlicerBar .slicer-panel .tag').length;
    o.rowsAfterChip = Reco.applyTableFiltersSort(tpl, sess).length;
    sess.slicers = {}; App.navigate('reco'); await raf();
    return o;
  });
  check(surg.oneRowSurvived, '2.1 ticking one row does not re-render the whole screen');
  check(surg.oneRowTicked, '2.2 the ticked row is highlighted');
  check(/Selected: 1/.test(surg.barAfterOne), '2.3 the selection bar updates', surg.barAfterOne);
  under(surg.oneRowMs, 150, '2.4 ticking one row of 200,000', 221);
  check(surg.allSurvived, '2.5 select-all does not re-render the whole screen');
  check(surg.allCount === BIG, '2.6 select-all still selects every filtered row', surg.allCount);
  check(surg.allVisibleTicked, '2.7 every row on screen shows as selected');
  check(/Selected: 200000/.test(surg.barAfterAll.replace(/,/g, '')), '2.8 the bar totals the whole selection', surg.barAfterAll);
  check(surg.clearSurvived, '2.9 clearing the selection does not re-render the whole screen');
  check(surg.clearNoneTicked && surg.barHidden, '2.10 clearing unticks the visible rows and hides the bar', surg);
  check(surg.headerPartial && surg.headerAllTicked && surg.headerEmpty,
    '2.10b the header box reads empty / half / full to match the real selection', surg);
  under(surg.clearMs, 100, '2.11 clearing a 200,000-row selection', 120);  // new 33-84ms (variance), old 120ms+
  check(surg.pageSurvived, '2.12 turning the page re-renders the grid, not the screen');
  // Not a timing check. Turning the page costs about what the old full
  // re-render did (95-136ms measured here): the saving from redrawing only the
  // grid is spent re-rendering the virtual window from row 0, which is the
  // point — 2.12 covers the grid-only redraw, and these cover landing at the
  // top of the page. A loose ceiling still catches a catastrophic regression.
  check(surg.pageScrollTop === 0, '2.13 the new page starts at its first row', surg.pageScrollTop);
  check(surg.pageFirstFrow === 500 * 200, '2.13b and the first row rendered is the page\'s first row', surg.pageFirstFrow);
  under(surg.pageMs, 600, '2.13c jumping to page 501 of 1,000 stays responsive', 117);
  check(surg.chipSurvived, '2.14 removing a slicer chip does not re-render the whole screen');
  check(surg.chipsLeft === 1, '2.15 the chip strip is refreshed in place', surg.chipsLeft);
  check(surg.rowsAfterChip === BIG / 4, '2.16 and the table follows the remaining chip', surg.rowsAfterChip);

  /* ====================================================================
     [3] Long operations say what they are doing
     ==================================================================== */
  console.log('\n[3] Progress instead of a dead window');
  const prog = await page.evaluate(async () => {
    const o = {};
    const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    // applySort paints the overlay, yields, then sorts — so the overlay is on
    // screen while the work happens.
    const p = Reco.applySort('Ref', 'asc');
    await new Promise(r => setTimeout(r, 0));
    o.modalShown = document.getElementById('appModal').classList.contains('show');
    o.text = (document.getElementById('recoBusyText') || {}).textContent || '';
    o.hasBar = !!document.getElementById('recoBusyBar');
    await p; await raf();
    o.modalGone = !document.getElementById('appModal').classList.contains('show');
    o.sorted = (() => {
      const tpl = AppState.recoTemplates.find(x => x.name === 'GRID');
      const sess = AppState.recoSessions[tpl.id];
      return sess.columnSorts && sess.columnSorts.col === 'Ref';
    })();
    // The chunked distinct scan hands the frame back on a big extract.
    const tpl = AppState.recoTemplates.find(x => x.name === 'GRID');
    const sess = AppState.recoSessions[tpl.id];
    let ticks = 0, lastDone = 0, lastTotal = 0;
    await Reco._slicerDistinct(tpl, sess, 'Calc', (done, total) => { ticks++; lastDone = done; lastTotal = total; });
    o.scanTicks = ticks; o.lastDone = lastDone; o.lastTotal = lastTotal;
    return o;
  });
  check(prog.modalShown, '3.1 sorting 200,000 rows puts a progress panel up before it blocks');
  check(/Sorting 200,000 rows by Ref/.test(prog.text), '3.2 the panel names the work and the size', prog.text);
  check(prog.hasBar, '3.3 with a progress bar');
  check(prog.modalGone, '3.4 and takes it down when the sort is done');
  check(prog.sorted, '3.5 the sort was actually applied');
  check(prog.scanTicks > 0, '3.6 a per-row value scan over 200,000 rows yields to the browser', prog);
  check(prog.lastTotal === BIG && prog.lastDone > 0 && prog.lastDone < BIG,
    '3.7 and reports honest progress against the real total', prog);

  const quiet = await page.evaluate(async () => {
    // Below the threshold nothing flashes: a small session sorts silently.
    const id = await (async () => {
      RecoTemplate.create(); const t = RecoTemplate._editing; t.name = 'SMALL';
      t.columns = [{ name: 'Doc', label: 'Doc', formats: [] }, { name: 'Amount', label: 'Amount', formats: [], isValue: true }];
      t.primaryKeys = ['Doc']; t.valueColumn = 'Amount'; t.displayColumns = ['Doc', 'Amount'];
      RecoTemplate.saveTemplate();
      const tp = AppState.recoTemplates.find(x => x.name === 'SMALL');
      RecoTemplate.open(tp.id);
      const s = AppState.recoSessions[tp.id]; Reco.ensureSessionShape(s);
      s.data = Array.from({ length: 2000 }, (_, i) => ({ _id: 's' + i, _pk: 'S' + i, Doc: 'S' + i, Amount: String(i) }));
      s._autoLoadAttempted = true;
      App.navigate('reco');
      await new Promise(r => requestAnimationFrame(r));
      return tp.id;
    })();
    const p = Reco.applySort('Amount', 'asc');
    await new Promise(r => setTimeout(r, 0));
    const flashed = document.getElementById('appModal').classList.contains('show');
    await p;
    return { flashed, id };
  });
  check(!quiet.flashed, '3.8 a 2,000-row sort does not flash a progress panel');

  /* ====================================================================
     [4] Getting around 200,000 rows
     ==================================================================== */
  console.log('\n[4] Navigation at scale');
  const nav = await page.evaluate(async () => {
    const o = {};
    const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    AppState.activeRecoId = AppState.recoTemplates.find(x => x.name === 'GRID').id;
    const tpl = AppState.recoTemplates.find(x => x.name === 'GRID');
    const sess = AppState.recoSessions[tpl.id];
    sess.columnSorts = null; sess.page = 0; sess.pageSize = 200;
    App.navigate('reco'); await raf();

    o.pager = document.querySelector('.page-info').textContent;
    o.sticky = getComputedStyle(document.querySelector('.reco-table-wrap thead th')).position;

    // jump to a page
    const pbox = document.getElementById('recoGotoPage');
    o.hasPageBox = !!pbox;
    pbox.value = '742'; Reco.gotoPageInput(pbox); await raf();
    o.jumpedPage = sess.page;
    o.jumpedPager = document.querySelector('.page-info').textContent;
    // out of range is refused and does not move
    document.querySelectorAll('.toast').forEach(t => t.remove());
    document.getElementById('recoGotoPage').value = '99999';
    Reco.gotoPageInput(document.getElementById('recoGotoPage')); await raf();
    o.refusedPage = sess.page;
    o.refusalToast = [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ');

    // jump to a row
    const rbox = document.getElementById('recoGotoRow');
    o.hasRowBox = !!rbox;
    rbox.value = '148230'; Reco.gotoRowInput(rbox);
    await raf(); await new Promise(r => setTimeout(r, 60));
    o.rowPage = sess.page;
    o.rowInWindow = !!document.querySelector('.reco-table-wrap tbody tr[data-frow="148229"]');
    o.rowFlashed = !!document.querySelector('.reco-table-wrap tbody tr.row-flash');

    // keyboard paging
    sess.page = 10; App.navigate('reco'); await raf();
    const key = (k, mods) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, mods || {})));
    key('PageDown'); await raf(); o.afterPageDown = sess.page;
    key('PageUp');   await raf(); o.afterPageUp = sess.page;
    key('End', { ctrlKey: true }); await raf(); o.afterCtrlEnd = sess.page;
    key('Home', { ctrlKey: true }); await raf(); o.afterCtrlHome = sess.page;
    // a keystroke inside a text box is left alone
    sess.page = 5; App.navigate('reco'); await raf();
    const inp = document.getElementById('recoGotoPage');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    await raf();
    o.pageAfterTyping = sess.page;

    // an ordinary keystroke must not cost a filter+sort pass over 200k rows
    sess.columnSorts = { col: 'Date', dir: 'asc' };
    App.navigate('reco'); await raf();
    const real = Reco.applyTableFiltersSort;
    let calls = 0;
    Reco.applyTableFiltersSort = function (...a) { calls++; return real.apply(this, a); };
    let t = performance.now();
    for (const k of ['a', 'ArrowDown', 'Shift', 'x', 'Escape', 'Tab']) key(k);
    o.idleKeyMs = Math.round(performance.now() - t);
    o.idleKeyPipeline = calls;
    // and paging from the keyboard reuses what the render already computed
    calls = 0; key('PageDown'); await raf();
    o.pageKeyPipeline = calls;
    Reco.applyTableFiltersSort = real;
    sess.columnSorts = null; sess.page = 0; App.navigate('reco'); await raf();

    // "All rows" page size
    Reco.setPageSize(Reco.PAGE_ALL); await raf();
    o.allPager = document.querySelector('.page-info').textContent;
    o.allDomRows = document.querySelectorAll('.reco-table-wrap tbody tr[data-rid]').length;
    o.allOptionLabel = [...document.querySelectorAll('.pager select option')].map(x => x.textContent).pop();
    Reco.setPageSize(200); await raf();
    return o;
  });
  check(/Page 1 \/ 1,000/.test(nav.pager) && /Rows 1–200 of 200,000/.test(nav.pager),
    '4.1 the pager states the page, the rows on screen and the true total, grouped', nav.pager);
  check(nav.sticky === 'sticky', '4.2 the header stays put while the body scrolls', nav.sticky);
  check(nav.hasPageBox && nav.jumpedPage === 741, '4.3 typing a page number jumps straight there', nav);
  check(/Page 742 \/ 1,000/.test(nav.jumpedPager), '4.4 and the pager agrees', nav.jumpedPager);
  check(nav.refusedPage === 741 && /only 1,000 pages/.test(nav.refusalToast),
    '4.5 a page past the end is refused with the real number of pages, and nothing moves', nav);
  check(nav.hasRowBox && nav.rowPage === Math.floor(148229 / 200), '4.6 "go to row" turns to the page holding that row', nav);
  check(nav.rowInWindow, '4.7 and scrolls the virtual window onto it', nav);
  check(nav.rowFlashed, '4.8 and marks it so the jump is visible', nav);
  check(nav.afterPageDown === 11 && nav.afterPageUp === 10, '4.9 PageDown / PageUp move one page', nav);
  check(nav.afterCtrlEnd === 999 && nav.afterCtrlHome === 0, '4.10 Ctrl+End / Ctrl+Home go to the last and first page', nav);
  check(nav.pageAfterTyping === 5, '4.11 PageDown typed inside a box is left to the box', nav);
  check(nav.idleKeyPipeline === 0 && nav.idleKeyMs < 50,
    '4.11b an ordinary keystroke on the grid costs nothing', nav);
  check(nav.pageKeyPipeline <= 1,
    '4.11c keyboard paging reuses the list the render already produced', nav.pageKeyPipeline);
  check(/Page 1 \/ 1 /.test(nav.allPager) && /of 200,000/.test(nav.allPager),
    '4.12 "All rows" shows everything as one page', nav.allPager);
  check(nav.allDomRows > 0 && nav.allDomRows <= 130,
    '4.13 and still keeps only the visible window in the DOM', nav.allDomRows);
  check(/All rows/.test(nav.allOptionLabel), '4.14 the page-size list offers it by name', nav.allOptionLabel);

  /* ====================================================================
     [5] The faster sort gives the same order
     ==================================================================== */
  console.log('\n[5] Sorting: same order, less work');
  const sort = await page.evaluate(async () => {
    const o = {};
    // The comparator as it was before the keys were cached, used here as the
    // reference: the new sort must agree with it exactly, on every column
    // kind, or a user's rows have silently moved.
    const refCompare = (va, vb, isDate, dir) => {
      dir = dir || 1;
      const ea = va == null || va === '', eb = vb == null || vb === '';
      if (ea || eb) return ea === eb ? 0 : (ea ? 1 : -1);
      if (isDate) {
        const da = U.parseDate(va), db = U.parseDate(vb);
        if (da && db) return (da - db) * dir;
      }
      if (U.isNumeric(va) && U.isNumeric(vb)) return (U.num(va) - U.num(vb)) * dir;
      return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * dir;
    };
    const refSort = (vals, isDate, dir) =>
      vals.map((v, i) => ({ v, i })).sort((a, b) => refCompare(a.v, b.v, isDate, dir) || (a.i - b.i)).map(k => k.v);
    const newSort = (vals, isDate, dir) => {
      const keyed = vals.map((v, i) => ({ v, i }));
      Reco._sortKeyed(keyed, isDate, dir);
      // stable tie-break applied the same way, so only the ordering rule is compared
      return keyed.map(k => k.v);
    };
    const cases = {
      dates:    { vals: ['31/12/2025', '04/02/2026', '', '01/01/2024', '15/02/2026', null, '04/02/2026'], isDate: true },
      amounts:  { vals: ['1,234.50', '(50)', '0', '', '100', '-7', '1234.5'], isDate: false },
      natural:  { vals: ['R2', 'R10', 'R1', 'r10', 'R100', '', 'R20'], isDate: false },
      mixed:    { vals: ['10', 'abc', '2', '', 'ABC', '0.5', 'zz'], isDate: false },
      dateText: { vals: ['04-Feb-26', '31-Dec-25', '01-Jan-24', ''], isDate: true },
      blanks:   { vals: ['', null, '', 'x'], isDate: false }
    };
    o.agree = {};
    for (const k of Object.keys(cases)) {
      const c = cases[k];
      o.agree[k] = [1, -1].every(dir => {
        const a = refSort(c.vals.slice(), c.isDate, dir);
        const b = newSort(c.vals.slice(), c.isDate, dir);
        // compare as text so null/'' print the same
        return JSON.stringify(a.map(String)) === JSON.stringify(b.map(String));
      });
    }

    const tpl = AppState.recoTemplates.find(x => x.name === 'GRID');
    const sess = AppState.recoSessions[tpl.id];
    sess.slicers = {}; sess.columnFilters = {}; sess.page = 0;
    const timeSort = col => {
      sess.columnSorts = { col, dir: 'asc' };
      const t = performance.now();
      const rows = Reco.applyTableFiltersSort(tpl, sess);
      return { ms: Math.round(performance.now() - t), first: rows[0], last: rows[rows.length - 1], n: rows.length };
    };
    const d = timeSort('Date');   o.dateMs = d.ms; o.dateFirst = d.first.Date; o.dateLast = d.last.Date; o.dateN = d.n;
    const r = timeSort('Ref');    o.refMs = r.ms;  o.refFirst = r.first.Ref;   o.refLast = r.last.Ref;
    const a = timeSort('Amount'); o.amtMs = a.ms;  o.amtFirst = a.first.Amount;
    const c = timeSort('Calc');   o.calcMs = c.ms;
    // Count the formula evaluations a sort costs: the keyed sort must evaluate
    // each row once, where the old comparator evaluated per comparison.
    const realEval = Formula.evaluate;
    let evals = 0;
    Formula.evaluate = function (f, row) { evals++; return realEval.call(Formula, f, row); };
    try {
      sess.columnSorts = { col: 'Calc', dir: 'asc' };
      const n = Reco.applyTableFiltersSort(tpl, sess).length;
      o.calcEvalsPerRow = Math.round((evals / Math.max(1, n)) * 100) / 100;
    } finally { Formula.evaluate = realEval; }
    sess.columnSorts = null;
    return o;
  });
  for (const k of Object.keys(sort.agree)) {
    check(sort.agree[k], '5.1 the cached-key sort matches the original comparator exactly — ' + k, sort.agree);
  }
  under(sort.dateMs, 800, '5.2 sorting 200,000 rows by a date column', 1747);
  under(sort.refMs, 700, '5.3 sorting 200,000 rows by a text column', 1623);
  under(sort.amtMs, 150, '5.4 sorting 200,000 rows by a value column', 176);   // new ~93ms, old 176ms
  // A formula column cannot gain from key caching (Formula.evaluate dominates).
  // What the keyed sort guarantees is one evaluation per row, not one per
  // comparison — ~200k instead of ~3.4M — so assert the call count.
  check(sort.calcEvalsPerRow != null && sort.calcEvalsPerRow <= 1.05,
    '5.5 a formula column is evaluated once per row, not once per comparison', sort.calcEvalsPerRow);
  check(sort.dateN === BIG, '5.6 nothing is lost in the sort', sort.dateN);
  check(sort.dateFirst === '01/01/2024', '5.7 dates sort as dates, oldest first', sort.dateFirst);
  // Natural order puts R199999 last; code-point order would end on R99999.
  check(sort.refFirst === 'R0' && sort.refLast === 'R199999',
    '5.8 text still sorts naturally (R2 before R10), not by code point', sort);
  check(sort.amtFirst === '0', '5.9 amounts sort as numbers', sort.amtFirst);

  /* ====================================================================
     [6] Scrolling the virtual window
     ==================================================================== */
  console.log('\n[6] Scrolling');
  const scr = await page.evaluate(async () => {
    const o = {};
    const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tpl = AppState.recoTemplates.find(x => x.name === 'GRID');
    const sess = AppState.recoSessions[tpl.id];
    sess.page = 0; sess.pageSize = 1000; sess.columnSorts = null;
    App.navigate('reco'); await raf();
    const real = Reco.applyTableFiltersSort;
    let calls = 0;
    Reco.applyTableFiltersSort = function (...a) { calls++; return real.apply(this, a); };
    const wrap = document.querySelector('.reco-table-wrap');
    const t = performance.now();
    for (let k = 1; k <= 12; k++) { wrap.scrollTop = k * 900; await raf(); }
    o.ms = Math.round(performance.now() - t);
    o.pipelineCalls = calls;
    Reco.applyTableFiltersSort = real;
    o.domRows = document.querySelectorAll('.reco-table-wrap tbody tr[data-rid]').length;
    o.topSpacer = !!document.querySelector('.virt-spacer-top');
    wrap.scrollTop = 0; sess.pageSize = 200; App.navigate('reco'); await raf();
    return o;
  });
  check(scr.pipelineCalls === 0,
    '6.1 scrolling does not re-run the filter/sort pipeline (it used to, on every frame)', scr.pipelineCalls);
  check(scr.domRows > 0 && scr.domRows <= 130, '6.2 the window stays about 110 rows', scr.domRows);
  check(scr.topSpacer, '6.3 virtualisation still holds the scroll height');

  /* ====================================================================
     [7] Nothing else broke
     ==================================================================== */
  console.log('\n[7] The rest of the grid still works');
  const feat = await page.evaluate(async () => {
    const o = {};
    const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tpl = AppState.recoTemplates.find(x => x.name === 'GRID');
    const sess = AppState.recoSessions[tpl.id];
    sess.slicers = {}; sess.columnFilters = {}; sess.columnSorts = null; sess.page = 0; sess.selectedRows = {};
    App.navigate('reco'); await raf();

    // column filter through the menu
    Reco.addColFilter('Cur');
    await new Promise(r => setTimeout(r, 30));
    o.menuReopened = !!document.querySelector('.col-dropdown');
    Reco.updateColFilter('Cur', 0, 'op', 'equals');
    Reco.updateColFilter('Cur', 0, 'val', 'USD');
    Reco.applyColFilters(); await raf();
    o.filteredRows = Reco.applyTableFiltersSort(tpl, sess).length;
    o.headerMarked = !!document.querySelector('th[data-col="Cur"] .col-filter-btn.active');
    Reco.clearColFilters('Cur'); await raf();
    o.afterClear = Reco.applyTableFiltersSort(tpl, sess).length;

    // hide / unhide a column
    Reco.hideCol('Ref'); await raf();
    o.hidden = !document.querySelector('th[data-col="Ref"]');
    Reco.unhideAllCols(); await raf();
    o.unhidden = !!document.querySelector('th[data-col="Ref"]');

    // drag-select a few rows, then end the drag
    Reco.startDragSelect({ button: 0, target: { tagName: 'TD' }, currentTarget: document.querySelector('tr[data-rid="i0"]'), ctrlKey: false }, 'i0');
    Reco.dragOver({ currentTarget: document.querySelector('tr[data-rid="i1"]') }, 'i1');
    Reco.dragOver({ currentTarget: document.querySelector('tr[data-rid="i2"]') }, 'i2');
    Reco.endDragSelect(); await raf();
    o.dragSelected = Object.keys(sess.selectedRows).length;
    o.dragBar = document.getElementById('selSumBar').textContent;

    // bulk offset over a large selection — the indexed lookup path
    sess.selectedRows = {};
    for (let i = 0; i < 20000; i++) sess.selectedRows['i' + i] = true;
    let t = performance.now();
    Reco.bulkMarkOffset(true); await raf();
    o.bulkMs = Math.round(performance.now() - t);
    o.offsetCount = Object.keys(sess.offsets).filter(k => sess.offsets[k]).length;
    t = performance.now();
    o.tolCheck = !!Reco.checkOffsetTolerance(tpl, sess, Object.keys(sess.selectedRows));
    o.tolMs = Math.round(performance.now() - t);
    sess.offsets = {}; sess.selectedRows = {};
    AppState.manualOffsetMaster[tpl.id] = {};
    App.navigate('reco'); await raf();

    // sheet mode, find & replace, filter sets
    Reco.toggleSpreadsheetMode(); await raf();
    o.sheetBar = !!document.querySelector('.reco-table-wrap') && !!document.getElementById('formulaInput');
    Reco.toggleSpreadsheetMode(); await raf();
    FindReplace.open();
    o.findOpen = document.getElementById('appModal').classList.contains('show');
    App.closeModal();
    o.filterSetCount = FilterSets.list(tpl).length >= 0;

    // sub-section switches
    AppState.activeSubSection = 'excel'; App.navigate('reco'); await raf();
    o.excelView = !!document.querySelector('#xlViewHost, .xl-view-host, #recoContentArea');
    AppState.activeSubSection = 'reco'; App.navigate('reco'); await raf();
    o.backToGrid = !!document.querySelector('.reco-table-wrap tbody tr[data-rid]');

    // editing a cell still writes through
    const idx = 7;
    Reco.editCell(idx, 'Status', 'Zed'); await raf();
    o.edited = sess.data[idx].Status;

    // dragging a column to a new place redraws the grid, not the screen
    const plant = () => {
      const m = document.createElement('span'); m.id = 'survivorMark2';
      document.querySelector('.reco-topbar').appendChild(m);
    };
    plant();
    Reco._dragCol = 'Cur';
    Reco.onColDrop({ preventDefault() {}, clientX: 0,
      currentTarget: Object.assign(document.querySelector('th[data-col="Doc"]'),
        { }) }, 'Doc');
    await raf();
    o.dragSurvived = !!document.getElementById('survivorMark2');
    o.newOrder = [...document.querySelectorAll('.reco-table-wrap thead th[data-col]')].map(x => x.dataset.col).slice(0, 3);
    Reco.resetTableView(); await raf();

    // sheet mode: arrow keys crossing a page boundary redraw the grid only
    sess.page = 0; sess.pageSize = 200;
    Reco.toggleSpreadsheetMode(); await raf();
    plant();
    Reco._ssEnsureVisible(250);
    await raf();
    o.ssPage = sess.page;
    o.ssSurvived = !!document.getElementById('survivorMark2');
    o.ssBarStillThere = !!document.getElementById('formulaInput');
    Reco.toggleSpreadsheetMode(); await raf();

    // the Correction tab's marker stops at the first bad cell
    const t0 = performance.now();
    o.anyErrFalse = Reco.anyFormatErrors(tpl, sess);
    o.anyErrCleanMs = Math.round(performance.now() - t0);
    const col = tpl.columns.find(c => c.name === 'Doc');
    col.formats = ['N'];                       // Doc holds "P123", never numeric
    const t1 = performance.now();
    o.anyErrTrue = Reco.anyFormatErrors(tpl, sess);
    o.anyErrDirtyMs = Math.round(performance.now() - t1);
    col.formats = [];
    return o;
  });
  check(feat.menuReopened, '7.1 the column menu stays open after adding a filter condition');
  check(feat.filteredRows === BIG / 4, '7.2 a column filter narrows the grid', feat.filteredRows);
  check(feat.headerMarked, '7.3 the filtered column is marked in the header');
  check(feat.afterClear === BIG, '7.4 clearing it brings every row back', feat.afterClear);
  check(feat.hidden && feat.unhidden, '7.5 hiding and unhiding a column still works', feat);
  check(feat.dragSelected === 3, '7.6 drag-select still selects the rows it crossed', feat.dragSelected);
  check(/Selected: 3/.test(feat.dragBar), '7.7 and the bar totals them when the drag ends', feat.dragBar);
  check(feat.offsetCount === 20000, '7.8 marking 20,000 of 200,000 rows offset works', feat.offsetCount);
  under(feat.bulkMs, 4000, '7.9 marking 20,000 of 200,000 rows offset is not quadratic', 'minutes');
  under(feat.tolMs, 1500, '7.10 the tolerance check over 20,000 ids is not quadratic', 'minutes');
  check(feat.sheetBar, '7.11 sheet mode still opens with its formula bar');
  check(feat.findOpen, '7.12 Find & Replace still opens');
  check(feat.excelView && feat.backToGrid, '7.13 the Excel view and the grid still swap', feat);
  check(feat.edited === 'Zed', '7.14 editing a cell still writes through', feat.edited);
  check(feat.dragSurvived, '7.15 reordering a column redraws the grid, not the screen');
  check(feat.newOrder[0] === 'Cur', '7.16 and the column actually moved', feat.newOrder);
  check(feat.ssPage === 1 && feat.ssSurvived && feat.ssBarStillThere,
    '7.17 sheet-mode arrows crossing a page boundary redraw the grid and keep the formula bar', feat);
  check(feat.anyErrFalse === false && feat.anyErrTrue === true,
    '7.18 the format-error marker is right both ways', feat);
  under(feat.anyErrDirtyMs, 50,
    '7.19 and stops at the first bad cell instead of validating 200,000 rows', feat.anyErrCleanMs);

  check(S.errors.length === 0, '7.20 no JavaScript errors across the whole run', S.errors.slice(0, 5));
} catch (e) {
  failures++;
  console.error('FATAL', e);
} finally {
  clearTimeout(watchdog);
  await browser.close();
  killAll();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
