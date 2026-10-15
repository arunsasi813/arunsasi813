/* #25 — "display as column order needed to be set".
 *
 *     node tests/e2e/run_colorder_e2e.mjs
 *
 * The order the grid shows columns in is now settable in three places and
 * read in one: a team order on the template (tpl.displayOrder), a per-person
 * order on this PC (localStorage, via Reco.userPref), and the definition
 * order underneath both. Everything on screen walks ONE descriptor list
 * (Reco.effectiveColumnDescs) so the header, the body and the virtual scroll
 * handler cannot disagree.
 *
 * The three gates, in the order of how much they matter:
 *
 *   T1  With no displayOrder and no per-user order, the grid is BYTE-IDENTICAL
 *       to the build before this change. Section 1 renders the same 60-column
 *       fixture in this build and in the baseline build (`git show
 *       <rev>:apps/Reco.html`, served side by side) and diffs the markup.
 *   T6  A dependent added column RENDERED ABOVE the column its formula reads
 *       still computes correctly. The cascade is evaluated in
 *       tpl.additionalColumns order and only RENDERED in display order; get
 *       that wrong and IF({Ageing Days}>90,…) sees '' and prints "0-90" for
 *       every row, with no #ERR and no console error, while the export, the
 *       report, the Excel view and the grid's own sort on that same column all
 *       read "90+".
 *   T9  At 200,000 rows the header and the body still agree after a virtual
 *       scroll — the column signature in _virtStateFor.
 *
 * Plus: a person's own order must never reach the shared folder, and every
 * export must follow the TEAM order only (a colleague's drag must not move a
 * number into a different column of a file that feeds a macro).
 *
 * Ports 20000-20019.
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
const PORT = 20001;
const PORT_BIG = 20002;
/* The build T1 compares against: the commit that carries the shared
   foundations and nothing of this feature. Override with BASE_REV=<rev>. */
const BASE_REV = process.env.BASE_REV || '76dffed';
const BIG = 200000;

let failures = 0, passes = 0;
function check(cond, msg, extra) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 900) : '')); }
  return !!cond;
}
function note(msg, extra) {
  console.log('    · ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* `fromRev` builds the root around the app as it was at that commit instead
   of the working tree, so T1 can diff two builds that are otherwise running
   on identical, separate shares. Returns root:null when the revision is not
   available. */
function makeRoot(name, fromRev) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-colorder-'));
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
    window.__dl = [];
    const rd = U.download;
    U.download = function (name, text, mime) { window.__dl.push({ name, text: String(text) }); return rd ? undefined : undefined; };
  });
  return { ctx, page, errors };
}
const readToasts = page => page.evaluate(() => (window.__toasts || []).slice());

/* ---------------------------------------------------------------------------
   THE WIDE FIXTURE, used by T1 and by most of the order assertions.
   60 file columns, only 40 of them in displayColumns (so the "include the
   hidden ones" schema path is exercised too), three added columns — one free
   text, one dropdown, one formula over a file column — and 12 rows with fixed
   _ids so the markup is reproducible. The template id is fixed as well, so
   the same fixture in two different builds produces the same bytes.
   The code is ONE string evaluated in both builds; nothing may differ but the
   build under it.
--------------------------------------------------------------------------- */
const WIDE_SETUP = `(function (arg) {
  const [name, tplId, nRows] = arg;
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = tplId;
  t.name = name;
  const names = [];
  for (let i = 1; i <= 60; i++) names.push('C' + String(i).padStart(2, '0'));
  t.columns = names.map(n => ({
    name: n, label: n, formats: [],
    isValue: n === 'C03' || n === 'C07',
    isDate: n === 'C02'
  }));
  t.primaryKeys = ['C01'];
  t.valueColumn = 'C03';
  t.docNumberColumn = 'C04';
  t.editableColumns = ['C05'];
  // 40 of 60, deliberately not the first 40 and not in column order
  t.displayColumns = names.filter((n, i) => i % 3 !== 2).slice(0, 40);
  t.additionalColumns = [
    { name: 'Note',  type: 'custom' },
    { name: 'Grade', type: 'dropdown', options: ['A', 'B', 'C'] },
    { name: 'Calc',  type: 'formula', formula: 'NUM({C03})*2' }
  ];
  t.enableReporting = true;
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === tplId);
  RecoTemplate.open(tpl.id);
  const sess = AppState.recoSessions[tpl.id];
  Reco.ensureSessionShape(sess);
  const data = new Array(nRows);
  for (let r = 0; r < nRows; r++) {
    const row = { _id: 'r' + r, _pk: 'K' + r, _ver: 'upload' };
    for (let i = 1; i <= 60; i++) {
      const n = 'C' + String(i).padStart(2, '0');
      if (n === 'C02') row[n] = String(1 + (r % 28)).padStart(2, '0') + '/01/2026';
      else if (n === 'C03') row[n] = String((r + 1) * 100);
      else if (n === 'C07') row[n] = String((r + 1) * 7);
      else row[n] = n + '-' + r;
    }
    row.C01 = 'K' + r;
    data[r] = row;
  }
  sess.data = data;
  sess._autoLoadAttempted = true;
  App.navigate('reco');
  return tpl.id;
})`;

/* What the grid actually drew, in the pieces T1 needs to be able to tell
   "nothing moved" from "the extras header gained a resize handle". */
const SNAP = `(function () {
  const wrap = document.querySelector('.reco-table-wrap');
  if (!wrap) return { missing: true };
  const ths = [...wrap.querySelectorAll('thead th')];
  const body = [...wrap.querySelectorAll('tbody tr')];
  const extraNames = new Set((() => {
    const t = AppState.recoTemplates.find(x => x.id === AppState.activeRecoId);
    const s = AppState.recoSessions[AppState.activeRecoId];
    return (t.additionalColumns || []).concat(s.extraColumns || []).map(a => a.name);
  })());
  return {
    headerCols: ths.map(th => th.dataset.col || th.className),
    tplTh: ths.filter(th => th.dataset.col && !extraNames.has(th.dataset.col)).map(th => th.outerHTML),
    extraTh: ths.filter(th => th.dataset.col && extraNames.has(th.dataset.col)).map(th => th.outerHTML),
    tbody: body.map(tr => tr.outerHTML).join('\\n'),
    bodyCols: body.length ? [...body[0].querySelectorAll('[data-col]')].map(td => td.dataset.col) : [],
    rows: body.length
  };
})`;

/* T9's fixture. Ten file columns, not sixty: 200,000 x 60 string fields is
   ~2 GB of row objects and takes the browser out before it ever renders, and
   T9 is about the header and the body agreeing, which ten columns and three
   added ones put just as sharply. */
const BIG_SETUP = `(function (arg) {
  const [name, tplId, nRows] = arg;
  RecoTemplate.create();
  const t = RecoTemplate._editing;
  t.id = tplId;
  t.name = name;
  const names = ['Doc', 'Date', 'Amount', 'Status', 'Ref', 'Cur', 'B01', 'B02', 'B03', 'B04'];
  t.columns = names.map(n => ({ name: n, label: n, formats: [], isValue: n === 'Amount', isDate: n === 'Date' }));
  t.primaryKeys = ['Doc'];
  t.valueColumn = 'Amount';
  t.editableColumns = ['Status'];
  t.displayColumns = names.slice(0, 8);
  t.additionalColumns = [
    { name: 'Note',  type: 'custom' },
    { name: 'Grade', type: 'dropdown', options: ['A', 'B'] },
    { name: 'Calc',  type: 'formula', formula: 'NUM({Amount})*2' }
  ];
  RecoTemplate.saveTemplate();
  const tpl = AppState.recoTemplates.find(x => x.id === tplId);
  RecoTemplate.open(tpl.id);
  const sess = AppState.recoSessions[tpl.id];
  Reco.ensureSessionShape(sess);
  const cur = ['USD', 'EUR', 'AED', 'RUB'];
  const data = new Array(nRows);
  for (let i = 0; i < nRows; i++) data[i] = {
    _id: 'i' + i, _pk: 'P' + i, _ver: 'upload', Doc: 'P' + i,
    Date: String(1 + (i % 28)).padStart(2, '0') + '/01/2026',
    Amount: String((i % 9991) + 1), Status: i % 3 ? 'Open' : 'Cleared',
    Ref: 'R' + i, Cur: cur[i % 4], B01: 'b' + i, B02: 'c' + i, B03: 'd' + i, B04: 'e' + i
  };
  sess.data = data;
  sess._autoLoadAttempted = true;
  App.navigate('reco');
  return tpl.id;
})`;

const EXPORT_HEADER = `(function () {
  window.__dl = [];
  Reco.exportData('csv');
  const d = (window.__dl || [])[0] || { text: '' };
  const lines = d.text.split(/\\r?\\n/);
  return { header: (lines[0] || '').split(','), first: (lines[1] || '').split(','), n: lines.length };
})`;

const watchdog = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 20 * 60 * 1000);
const procs = [];
const browser = await chromium.launch();
try {

  const { root } = makeRoot('shared');
  const bridge = await startBridge(root, PORT);
  procs.push(bridge.proc);
  const S = await openReco(browser, bridge);
  const { page } = S;
  const TPL = 'tpl_colorder_fixed';

  /* ====================================================================
     [1] T1 — byte-identical to the previous build with no order set
     ==================================================================== */
  console.log('\n[1] T1: with no displayOrder and no per-user order, nothing moved');

  await page.evaluate(new Function('arg', 'return ' + WIDE_SETUP + '(arg)'), ['WIDE', TPL, 12]);
  const snapNew = await page.evaluate(new Function('return ' + SNAP + '()'));
  const expNew  = await page.evaluate(new Function('return ' + EXPORT_HEADER + '()'));
  const schemaNew = await page.evaluate(() => {
    const t = AppState.recoTemplates.find(x => x.id === AppState.activeRecoId);
    const s = AppState.recoSessions[t.id];
    return {
      vis: XlSchema.build(t, s, { scope: 'template', showExtras: 'all' }).cols.map(d => d.name),
      all: XlSchema.build(t, s, { scope: 'template', showExtras: 'all', includeHidden: true }).cols.map(d => d.name),
      cat: Reco.columnCatalog(t, s).map(d => d.name)
    };
  });
  check(snapNew.rows === 12 && snapNew.headerCols.length === 2 + 43, 'the fixture drew 12 rows and 43 columns + 2 fixed', {
    rows: snapNew.rows, cols: snapNew.headerCols.length
  });

  /* The baseline build, on its own share so nothing one build writes can
     reach the other. Same fixture, same template id, same day. */
  const baseRoot = makeRoot('baseline', BASE_REV).root;
  if (!baseRoot) {
    check(false, 'T1 NOT RUN: the baseline build ' + BASE_REV + ' could not be checked out');
  } else {
    const bridgeB = await startBridge(baseRoot, PORT + 2);
    procs.push(bridgeB.proc);
    const B = await openReco(browser, bridgeB);
    await B.page.evaluate(new Function('arg', 'return ' + WIDE_SETUP + '(arg)'), ['WIDE', TPL, 12]);
    const snapOld = await B.page.evaluate(new Function('return ' + SNAP + '()'));
    const expOld  = await B.page.evaluate(new Function('return ' + EXPORT_HEADER + '()'));
    const schemaOld = await B.page.evaluate(() => {
      const t = AppState.recoTemplates.find(x => x.id === AppState.activeRecoId);
      const s = AppState.recoSessions[t.id];
      return {
        vis: XlSchema.build(t, s, { scope: 'template', showExtras: 'all' }).cols.map(d => d.name),
        all: XlSchema.build(t, s, { scope: 'template', showExtras: 'all', includeHidden: true }).cols.map(d => d.name),
        cat: Reco.columnCatalog(t, s).map(d => d.name)
      };
    });

    check(same(snapOld.headerCols, snapNew.headerCols), 'T1: the header column sequence is unchanged', {
      old: snapOld.headerCols.slice(0, 8), now: snapNew.headerCols.slice(0, 8)
    });
    check(snapOld.tbody === snapNew.tbody, 'T1: EVERY BODY ROW IS BYTE-IDENTICAL (all 12 rows, all 43 cells each)',
      snapOld.tbody === snapNew.tbody ? undefined : firstDiff(snapOld.tbody, snapNew.tbody));
    check(same(snapOld.tplTh, snapNew.tplTh), 'T1: every file-column <th> is byte-identical',
      same(snapOld.tplTh, snapNew.tplTh) ? undefined : { old: snapOld.tplTh[0], now: snapNew.tplTh[0] });
    check(same(snapOld.bodyCols, snapNew.bodyCols), 'T1: the per-cell data-col sequence is unchanged');
    check(same(expOld.header, expNew.header) && same(expOld.first, expNew.first),
      'T1: the CSV export header and first row are unchanged', { old: expOld.header.slice(0, 6), now: expNew.header.slice(0, 6) });
    check(same(schemaOld.vis, schemaNew.vis), 'T1: the Excel-link schema column order is unchanged (visible columns)',
      { old: schemaOld.vis.slice(0, 6), now: schemaNew.vis.slice(0, 6) });
    check(same(schemaOld.all, schemaNew.all), 'T1: the schema column order is unchanged with includeHidden',
      { oldTail: schemaOld.all.slice(-6), nowTail: schemaNew.all.slice(-6) });
    check(same(schemaOld.cat, schemaNew.cat), 'T1: the column catalog order is unchanged',
      { oldTail: schemaOld.cat.slice(-6), nowTail: schemaNew.cat.slice(-6) });

    /* The ONE declared difference: an added column's <th> is now draggable,
       takes sess.columnWidths and carries a resize handle, because it can be
       positioned now. Asserted as a difference so it cannot drift further. */
    const changed = !same(snapOld.extraTh, snapNew.extraTh);
    check(changed, 'T1: the added-column <th>s are the ONLY markup that changed (declared)');
    check(snapNew.extraTh.every(h => /col-draggable/.test(h) && /draggable="true"/.test(h) && /col-resize-handle/.test(h))
       && snapOld.extraTh.every(h => !/col-draggable/.test(h)),
      'T1: and the difference is exactly drag + width + resize handle on the extras', {
        old: snapOld.extraTh[0], now: snapNew.extraTh[0]
      });
    check(B.errors.length === 0 && S.errors.length === 0, 'neither build logged an error rendering the fixture',
      { base: B.errors, now: S.errors });
    await B.ctx.close();
  }

  function firstDiff(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return { at: i, old: a.slice(Math.max(0, i - 60), i + 90), now: b.slice(Math.max(0, i - 60), i + 90) };
  }

  /* ====================================================================
     [2] _mergeOrder, the one merge rule
     ==================================================================== */
  console.log('\n[2] _mergeOrder and the precedence rule');
  const mg = await page.evaluate(() => {
    const base = ['a', 'b', 'c', 'd'];
    return {
      nullIsIdentity: Reco._mergeOrder(base, null) === base,
      emptyIsIdentity: Reco._mergeOrder(base, []) === base,
      listedFirst: Reco._mergeOrder(base, ['c', 'a']),
      unknownIgnored: Reco._mergeOrder(base, ['zz', 'd']),
      dupCollapsed: Reco._mergeOrder(base, ['b', 'b', 'a']),
      everything: Reco._mergeOrder(base, ['d', 'c', 'b', 'a']),
      baseUntouched: base.join()
    };
  });
  check(mg.nullIsIdentity && mg.emptyIsIdentity, 'T1 core: _mergeOrder(base, null) returns base ITSELF, not a copy', mg);
  check(same(mg.listedFirst, ['c', 'a', 'b', 'd']), 'listed names first, in listed order; the rest in base order', mg.listedFirst);
  check(same(mg.unknownIgnored, ['d', 'a', 'b', 'c']), 'a name that is not a column is ignored, not invented', mg.unknownIgnored);
  check(same(mg.dupCollapsed, ['b', 'a', 'c', 'd']), 'a name listed twice is placed once', mg.dupCollapsed);
  check(mg.baseUntouched === 'a,b,c,d', '_mergeOrder does not mutate the base list', mg.baseUntouched);

  /* ====================================================================
     [3] The team order moves the grid for everyone; the per-user order wins
     ==================================================================== */
  console.log('\n[3] team order, per-user order, precedence');
  const t3 = await page.evaluate(() => {
    const t = AppState.recoTemplates.find(x => x.id === AppState.activeRecoId);
    const s = AppState.recoSessions[t.id];
    const head = () => [...document.querySelectorAll('.reco-table-wrap thead th[data-col]')].map(th => th.dataset.col);
    const before = head();
    // The team order, as the template editor writes it: file columns AND
    // added columns in one list.
    t.displayOrder = ['Calc', 'C05', 'Note', 'C01'];
    AppState.save();
    App.navigate('reco');
    const team = head();
    // …and this person's own order, which must win over it.
    Reco.setUserOrder(t, s, ['C08', 'Grade']);
    App.navigate('reco');
    const mine = head();
    const body = [...document.querySelectorAll('.reco-table-wrap tbody tr:not(.virt-spacer-top):not(.virt-spacer-bot)')][0];
    return { before, team, mine, bodyCols: body ? [...body.querySelectorAll('[data-col]')].map(td => td.dataset.col) : [] };
  });
  check(same(t3.team.slice(0, 4), ['Calc', 'C05', 'Note', 'C01']),
    'the team order puts named columns first, added columns among file columns', t3.team.slice(0, 6));
  check(t3.team.length === t3.before.length, 'the team order adds and drops nothing', [t3.before.length, t3.team.length]);
  check(same(t3.mine.slice(0, 2), ['C08', 'Grade']), 'this person’s own order beats the team order', t3.mine.slice(0, 6));
  check(same(t3.mine, t3.bodyCols), 'the body cells follow the header exactly', { head: t3.mine.slice(0, 5), body: t3.bodyCols.slice(0, 5) });

  /* An EXPORT follows the team order and never this person's — in the two
     blocks the export header has always had: file columns, then added
     columns. So a team order can reorder the file columns of a workbook a
     macro pastes against, but can never push a computed column in among
     them. (The grid interleaves; a file does not.) */
  const t3e = await page.evaluate(new Function('return ' + EXPORT_HEADER + '()'));
  check(t3e.header[0] === 'Status' && t3e.header[1] === 'RecoId'
     && same(t3e.header.slice(2, 4), ['C05', 'C01']),
    'the CSV export follows the TEAM order within the file-column block', t3e.header.slice(0, 8));
  const extrasAt = ['Note', 'Grade', 'Calc'].map(n => t3e.header.indexOf(n));
  check(Math.min(...extrasAt) === t3e.header.length - 3 && t3e.header[t3e.header.length - 3] === 'Calc'
     && t3e.header[t3e.header.length - 2] === 'Note',
    'the added columns stay in their own block at the end, team-ordered inside it', t3e.header.slice(-4));
  check(t3e.header.indexOf('C08') > 4, 'and the per-user order changes nothing in the file (C08 is not pulled forward)', t3e.header.slice(0, 8));

  const t3x = await page.evaluate(() => {
    const t = AppState.recoTemplates.find(x => x.id === AppState.activeRecoId);
    const s = AppState.recoSessions[t.id];
    const cols = ExcelLink.schemaFor(t, s, 'allTemplate').cols;
    return {
      team: cols.map(d => d.name).filter(n => n !== '_status_').slice(0, 2),
      extraFirst: cols.filter(d => d.role === 'computed' || d.role === 'tag')[0],
      fp: ExcelLink._fpCols(t, cols)
    };
  });
  check(same(t3x.team, ['C05', 'C01']), 'the Excel-link workbook schema follows the team order too', t3x.team);
  check(t3x.extraFirst && t3x.extraFirst.name === 'Calc', 'and orders the added columns inside their own block', t3x.extraFirst && t3x.extraFirst.name);
  check(!t3x.fp.includes('C08'), 'and _fpCols’ identity columns do not move with one person’s drag', t3x.fp);

  /* ====================================================================
     [4] A person's order must not reach the shared folder
     ==================================================================== */
  console.log('\n[4] the per-user order stays on this PC');
  await page.evaluate(() => AppState.save());
  await page.waitForFunction(() => AppState.pendingCount() === 0, null, { timeout: 8000 }).catch(() => {});
  await sleep(400);
  const sessJson = fs.existsSync(path.join(root, 'reco/recoSessions.json'))
    ? fs.readFileSync(path.join(root, 'reco/recoSessions.json'), 'utf8') : '';
  const tplJson = fs.existsSync(path.join(root, 'reco/recoTemplates.json'))
    ? fs.readFileSync(path.join(root, 'reco/recoTemplates.json'), 'utf8') : '';
  check(sessJson.length > 0, 'recoSessions.json is on the share', sessJson.length);
  const sessObj = sessJson ? (JSON.parse(sessJson)[TPL] || {}) : {};
  check(!Array.isArray(sessObj.columnOrder) || !sessObj.columnOrder.length,
    'the shared session file carries NO column order', sessObj.columnOrder);
  check(!/C08/.test(JSON.stringify(sessObj.columnOrder || null)), 'the dragged column is not in the shared file', sessObj.columnOrder);
  check(/"displayOrder"\s*:\s*\[/.test(tplJson), 'the TEAM order is on the template, where everyone reads it',
    (tplJson.match(/"displayOrder":[^\]]*\]/) || [''])[0]);
  const lsSeen = await page.evaluate((id) => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.indexOf('reco.view.v1.') === 0) out[k] = localStorage.getItem(k);
    }
    return out;
  }, TPL);
  check(JSON.stringify(lsSeen).includes('C08'), 'it is in localStorage instead', lsSeen);

  /* A colleague on the same folder, in a fresh profile: same share, own
     localStorage. They must see the TEAM order, not the drag. */
  const C = await openReco(browser, bridge);
  const t4 = await C.page.evaluate((id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    if (!t) return { noTpl: true };
    RecoTemplate.open(t.id);
    const s = AppState.recoSessions[t.id];
    return { order: Reco.effectiveDisplayCols(t, s).slice(0, 4), mine: Reco.userPref(t.id, 'columnOrder') };
  }, TPL);
  check(same(t4.order, ['Calc', 'C05', 'Note', 'C01']),
    'a colleague opening the same template sees the TEAM order, not the drag', t4);
  await C.ctx.close();

  /* ====================================================================
     [5] T6 — THE BLOCKER. A dependent added column rendered ABOVE the one
     its formula reads.
     ==================================================================== */
  console.log('\n[5] T6: the cascade is evaluated in declaration order, rendered in display order');
  const AGE = 'tpl_ageing_fixed';
  await page.evaluate((id) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.id = id;
    t.name = 'AGEING';
    t.columns = ['Doc', 'Posting Date', 'Amount'].map(n => ({
      name: n, label: n, formats: [], isValue: n === 'Amount', isDate: n === 'Posting Date'
    }));
    t.primaryKeys = ['Doc'];
    t.valueColumn = 'Amount';
    t.displayColumns = ['Doc', 'Posting Date', 'Amount'];
    /* DECLARATION order: Days first, because Bucket reads it. The engine's
       own day-count helper is AGEING(date) (the plan wrote DAYS(TODAY(),…),
       which this formula engine does not have). */
    t.additionalColumns = [
      { name: 'Ageing Days',   type: 'formula', formula: 'AGEING({Posting Date})' },
      { name: 'Ageing Bucket', type: 'formula', formula: 'IF({Ageing Days}>90,"90+","0-90")' }
    ];
    t.enableReporting = true;
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    RecoTemplate.open(tpl.id);
    const sess = AppState.recoSessions[tpl.id];
    Reco.ensureSessionShape(sess);
    const old = new Date(Date.now() - 285 * 864e5);
    const young = new Date(Date.now() - 10 * 864e5);
    const dd = d => String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
    sess.data = [
      { _id: 'a1', _pk: 'OLD', _ver: 'upload', Doc: 'OLD', 'Posting Date': dd(old), Amount: '100' },
      { _id: 'a2', _pk: 'NEW', _ver: 'upload', Doc: 'NEW', 'Posting Date': dd(young), Amount: '200' }
    ];
    sess._autoLoadAttempted = true;
    /* RENDER the bucket FIRST — above the Days column it depends on, and
       above the date that feeds it. This is the arrangement that breaks a
       naive display-order cascade. */
    tpl.displayOrder = ['Ageing Bucket', 'Doc', 'Ageing Days'];
    AppState.save();
    App.navigate('reco');
  }, AGE);

  const t6 = await page.evaluate(() => {
    const t = AppState.recoTemplates.find(x => x.id === AppState.activeRecoId);
    const s = AppState.recoSessions[t.id];
    const cellOf = (rid, col) => {
      const tr = [...document.querySelectorAll('.reco-table-wrap tbody tr')].find(x => x.dataset.rid === rid);
      const td = tr ? tr.querySelector('[data-col="' + CSS.escape(col) + '"]') : null;
      return td ? td.textContent.trim() : null;
    };
    const head = [...document.querySelectorAll('.reco-table-wrap thead th[data-col]')].map(th => th.dataset.col);
    window.__dl = [];
    Reco.exportData('csv');
    const csvText = (window.__dl[0] || { text: '' }).text;
    const parsed = Papa.parse(csvText.trim(), { header: true }).data;
    const exp = doc => (parsed.find(r => r.Doc === doc) || {})['Ageing Bucket'];
    const rpt = Reco.runReport(t, s, { columns: ['Doc', 'Ageing Days', 'Ageing Bucket'], filters: [] });
    return {
      head,
      activeId: AppState.activeRecoId,
      csvHeader: (csvText.split(/\r?\n/)[0] || '').slice(0, 120),
      gridOld: cellOf('a1', 'Ageing Bucket'),
      gridNew: cellOf('a2', 'Ageing Bucket'),
      daysOld: cellOf('a1', 'Ageing Days'),
      exportOld: exp('OLD'),
      exportNew: exp('NEW'),
      reportOld: (rpt.find(r => r.Doc === 'OLD') || {})['Ageing Bucket'],
      full: Reco.rowFull(t, s, s.data[0])['Ageing Bucket'],
      xlView: (() => {
        const S2 = XlSchema.build(t, s, { scope: 'template', showExtras: 'all' });
        const d = S2.byName.get('Ageing Bucket');
        return XlSchema.currentValue(d, s.data[0], Reco.rowFull(t, s, s.data[0]), s);
      })()
    };
  });
  check(same(t6.head.slice(0, 3), ['Ageing Bucket', 'Doc', 'Ageing Days']),
    'the bucket really is rendered above the days column it reads', t6.head);
  check(t6.gridOld === '90+', 'T6: THE GRID CELL READS 90+ (a naive display-order cascade prints 0-90 here)', t6);
  check(t6.gridNew === '0-90', 'T6: and the 10-day-old row still reads 0-90', t6.gridNew);
  check(Number(t6.daysOld) >= 284, 'the dependency itself is right', t6.daysOld);
  check(t6.exportOld === '90+' && t6.exportNew === '0-90', 'T6: the CSV export agrees with the grid', [t6.exportOld, t6.exportNew]);
  check(t6.reportOld === '90+', 'T6: the report agrees with the grid', t6.reportOld);
  check(t6.xlView === '90+', 'T6: the Excel view / link resolver agrees with the grid', t6.xlView);

  /* …and the grid's own SORT on that column, which reads through the shared
     resolver, must put the same string in the same cell. */
  const t6s = await page.evaluate(() => {
    const t = AppState.recoTemplates.find(x => x.id === AppState.activeRecoId);
    const s = AppState.recoSessions[t.id];
    s.columnSorts = { col: 'Ageing Bucket', dir: 'desc' };
    App.navigate('reco');
    const rows = [...document.querySelectorAll('.reco-table-wrap tbody tr')];
    return rows.map(tr => {
      const td = tr.querySelector('[data-col="' + CSS.escape('Ageing Bucket') + '"]');
      return { rid: tr.dataset.rid, bucket: td ? td.textContent.trim() : null };
    });
  });
  check(t6s.length === 2 && t6s[0].rid === 'a1' && t6s[0].bucket === '90+',
    'T6: sorting BY the bucket puts 90+ first and the cell still says 90+', t6s);

  /* The invariant in the other direction: moving a column on screen must not
     change ANY value. Same fixture, order reversed, every cell compared. */
  const t6inv = await page.evaluate(() => {
    const t = AppState.recoTemplates.find(x => x.id === AppState.activeRecoId);
    const s = AppState.recoSessions[t.id];
    s.columnSorts = null;
    /* Sorted pairs, not an object: the cells come out of the DOM in display
       order, so an object would differ by KEY ORDER even when every value is
       the same — which is the opposite of what this asserts. */
    const valuesIn = (order) => {
      t.displayOrder = order;
      App.navigate('reco');
      const out = [];
      document.querySelectorAll('.reco-table-wrap tbody tr').forEach(tr => {
        tr.querySelectorAll('[data-col]').forEach(td => { out.push(tr.dataset.rid + '|' + td.dataset.col + '=' + td.textContent.trim()); });
      });
      return out.sort();
    };
    /* The enriched row itself, which is what the AEG entry preview, the
       Special JV payload, the reports and the exports all read. If a display
       order could reach THIS, a reordered screen could change a posted
       number. */
    const fullIn = (order) => {
      t.displayOrder = order;
      Reco._fullPass();
      try { return JSON.stringify(s.data.map(r => Reco.rowFull(t, s, r))); }
      finally { Reco._fullEnd(); }
    };
    const fa = fullIn(['Ageing Bucket', 'Doc', 'Ageing Days']);
    const fb = fullIn(['Ageing Days', 'Amount', 'Ageing Bucket', 'Doc']);
    const fc = fullIn(null);
    const a = valuesIn(['Ageing Bucket', 'Doc', 'Ageing Days']);
    const b = valuesIn(['Ageing Days', 'Amount', 'Ageing Bucket', 'Doc']);
    const c = valuesIn(null);
    return { a, b, c, sameAB: a.join('\n') === b.join('\n'), sameAC: a.join('\n') === c.join('\n'),
             fullSame: fa === fb && fa === fc, fullSample: fa.slice(0, 160) };
  });
  check(t6inv.sameAB && t6inv.sameAC,
    'T6: every cell holds the same value whatever the display order', { a: t6inv.a, b: t6inv.b });
  check(t6inv.fullSame,
    'T6: and the enriched row the JV, the AEG preview and the reports read is identical whatever the display order',
    t6inv.fullSample);

  /* ====================================================================
     [6] Hidden columns keep their position; a hidden extra is now hidden
     ==================================================================== */
  console.log('\n[6] hiding a column no longer erases where it was');
  const t7 = await page.evaluate((id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    RecoTemplate.open(t.id);
    const s = AppState.recoSessions[t.id];
    t.displayOrder = null;
    Reco.setUserOrder(t, s, []);
    s.hiddenCols = [];
    App.navigate('reco');
    const start = Reco.effectiveDisplayCols(t, s).slice(0, 6);
    // Hide a column in the middle, then "drag" one header — which is what
    // used to rewrite the order with every hidden column left out.
    s.hiddenCols = ['C04'];
    App.navigate('reco');
    const order = Reco.effectiveDisplayCols(t, s, { includeHidden: true }).slice();
    const moved = order.filter(n => n !== 'C08');
    moved.splice(0, 0, 'C08');
    Reco.setUserOrder(t, s, moved);
    App.navigate('reco');
    const withHidden = [...document.querySelectorAll('.reco-table-wrap thead th[data-col]')].map(th => th.dataset.col);
    s.hiddenCols = [];
    App.navigate('reco');
    const afterUnhide = [...document.querySelectorAll('.reco-table-wrap thead th[data-col]')].map(th => th.dataset.col);
    return { start, withHidden, afterUnhide, stored: Reco.userPref(t.id, 'columnOrder') };
  }, TPL);
  check(!t7.withHidden.includes('C04'), 'the hidden column is off screen', t7.withHidden.slice(0, 6));
  check(t7.stored.includes('C04'), 'but it is still IN the stored order (built from the includeHidden base)', t7.stored.slice(0, 6));
  check(t7.afterUnhide[0] === 'C08' && t7.afterUnhide.indexOf('C04') === t7.start.indexOf('C04') + 1,
    'unhiding returns it to its own place, not to the far right',
    { start: t7.start, after: t7.afterUnhide.slice(0, 6) });

  const t7b = await page.evaluate((id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    const s = AppState.recoSessions[t.id];
    s.hiddenCols = ['Grade'];
    App.navigate('reco');
    const head = [...document.querySelectorAll('.reco-table-wrap thead th[data-col]')].map(th => th.dataset.col);
    const bodyCells = [...document.querySelectorAll('.reco-table-wrap tbody tr')][0];
    s.hiddenCols = [];
    App.navigate('reco');
    return { head, hasCell: bodyCells ? !!bodyCells.querySelector('[data-col="Grade"]') : null };
  }, TPL);
  check(!t7b.head.includes('Grade') && t7b.hasCell === false,
    'DECLARED CHANGE: hiding an ADDED column now hides it (the grid used to ignore hiddenCols for extras, so "Hide this column" did nothing)',
    t7b.head.slice(-4));

  /* ====================================================================
     [7] A stored cell selection is positional: clear it on reorder
     ==================================================================== */
  console.log('\n[7] sheet-mode selection cleared on reorder');
  const t8 = await page.evaluate((id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    const s = AppState.recoSessions[t.id];
    s.spreadsheetMode = true;
    s.activeCell = { fidx: 0, col: 'C05' };
    s.selRange = { startFidx: 0, endFidx: 1, startCol: 'C05', endCol: 'C08' };
    Reco.setUserOrder(t, s, ['C08', 'C05']);
    return { activeCell: s.activeCell, selRange: s.selRange };
  }, TPL);
  check(t8.activeCell === null && t8.selRange === null,
    'activeCell and selRange are cleared when the order changes (they are names resolved by POSITION)', t8);

  /* ====================================================================
     [8] ColPicker — the component, and its one contractual rule
     ==================================================================== */
  console.log('\n[8] ColPicker: two modes, section-local redraw');
  const t9 = await page.evaluate((id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    const s = AppState.recoSessions[t.id];
    const out = {};
    let done = null;
    ColPicker.openOrdered({
      title: 'T', catalog: Reco.pickerCatalog(t, s), chosen: ['C01', 'C05', 'C08'],
      onDone(names) { done = names; }
    });
    out.modalOpen = document.getElementById('appModal').classList.contains('show');
    out.panes = !!document.getElementById('cpPanes');
    const bodyBefore = document.getElementById('appModalBody');
    const filterBefore = document.getElementById('cpFilter');
    // A redraw must touch the panes and NOTHING else: same body element, same
    // filter input element, text and caret intact.
    filterBefore.value = 'C0';
    filterBefore.focus();
    ColPicker._onFilter('C0');
    out.sameBody = document.getElementById('appModalBody') === bodyBefore;
    out.sameFilterEl = document.getElementById('cpFilter') === filterBefore;
    out.filterKept = document.getElementById('cpFilter').value;
    out.focusKept = document.activeElement === filterBefore;
    // the position box moves a column to an arbitrary place
    ColPicker.moveTo(2, 1);
    out.afterMoveTo = ColPicker._st.chosen.slice();
    ColPicker.nudge(0, 1);
    out.afterNudge = ColPicker._st.chosen.slice();
    // All / None act on the FILTERED subset only
    ColPicker._onFilter('C1');
    ColPicker.allFiltered(true);
    out.addedOnlyMatches = ColPicker._st.chosen.filter(n => !/^C1/.test(n)).length;
    out.hasC10 = ColPicker._st.chosen.includes('C10');
    ColPicker.allFiltered(false);
    out.noneLeftOnlyFiltered = ColPicker._st.chosen.some(n => /^C1/.test(n));
    out.keptUnfiltered = ColPicker._st.chosen.includes('C08');
    ColPicker._onFilter('');
    ColPicker.sortAZ();
    out.sortedAZ = ColPicker._st.chosen.slice(0, 3);
    ColPicker.done();
    out.done = done;
    out.closed = !document.getElementById('appModal').classList.contains('show');
    return out;
  }, TPL);
  check(t9.modalOpen && t9.panes, 'openOrdered puts up the two-pane picker', t9);
  check(t9.sameBody && t9.sameFilterEl && t9.filterKept === 'C0' && t9.focusKept,
    'CONTRACT: a redraw is section-local — the modal body and the filter box, its text and its focus all survive', t9);
  check(same(t9.afterMoveTo, ['C08', 'C01', 'C05']), 'the position box moves a column to an arbitrary position', t9.afterMoveTo);
  check(same(t9.afterNudge, ['C01', 'C08', 'C05']), 'the arrows move it one step', t9.afterNudge);
  check(t9.addedOnlyMatches === 3 && t9.hasC10, 'All adds only what the filter leaves', t9);
  check(!t9.noneLeftOnlyFiltered && t9.keptUnfiltered, 'None removes only what the filter leaves', t9);
  check(t9.sortedAZ[0] < t9.sortedAZ[1] && t9.sortedAZ[1] < t9.sortedAZ[2], 'A to Z sorts by the name the grid renders', t9.sortedAZ);
  check(Array.isArray(t9.done) && t9.closed, 'Done hands the list to the caller and closes', t9.done);

  const t9b = await page.evaluate((id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    const s = AppState.recoSessions[t.id];
    const out = {};
    ColPicker.openSet({ title: 'Set', catalog: Reco.pickerCatalog(t, s), chosen: ['C01'], cap: 3 });
    out.checkboxes = document.querySelectorAll('#cpPanes input[type=checkbox]').length > 0;
    ColPicker.toggle('C02', true); ColPicker.toggle('C03', true);
    out.atCap = ColPicker._st.chosen.length;
    ColPicker.toggle('C06', true);
    out.capHeld = ColPicker._st.chosen.length;
    out.disabledShown = [...document.querySelectorAll('#cpPanes input[type=checkbox]')].some(b => b.disabled);
    ColPicker.toggle('C01', false);
    out.afterClear = ColPicker._st.chosen.length;
    ColPicker.cancel();
    return out;
  }, TPL);
  check(t9b.checkboxes && t9b.atCap === 3 && t9b.capHeld === 3 && t9b.disabledShown && t9b.afterClear === 2,
    'openSet is a capped checkbox list (ready for the correction context columns)', t9b);

  /* The grid's own "⇄ Columns" button: the same picker, writing THIS
     PERSON's order. The keyboard-only route, and the one that still works at
     600 columns where dragging does not. */
  const t9g = await page.evaluate((id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    const s = AppState.recoSessions[id];
    RecoTemplate.open(t.id);
    t.displayOrder = null;
    Reco.setUserOrder(t, s, []);
    App.navigate('reco');
    Reco.openOrderPicker();
    const prefilled = ColPicker._st.chosen.slice(0, 3);
    ColPicker.moveTo(2, 1);                       // third column to the front
    const want = ColPicker._st.chosen.slice(0, 3);
    ColPicker.done();
    const head = [...document.querySelectorAll('.reco-table-wrap thead th[data-col]')].map(th => th.dataset.col).slice(0, 3);
    return { prefilled, want, head, stored: (Reco.userPref(t.id, 'columnOrder') || []).slice(0, 3),
             onShare: s.columnOrder };
  }, TPL);
  check(t9g.prefilled.length === 3 && t9g.prefilled[0] !== t9g.want[0],
    'the grid’s picker opens pre-filled with the order on screen', t9g);
  check(same(t9g.head, t9g.want) && same(t9g.stored, t9g.want),
    'Done applies it to the grid and stores it for this person only', t9g);
  check(t9g.onShare == null, 'and nothing of it reaches the shared session', t9g.onShare);

  /* The template editor's own order section, which is where the TEAM order is
     published, and which must come back without losing the editor. */
  const t9c = await page.evaluate((id) => {
    RecoTemplate.edit(id);
    RecoTemplate._step = 3;
    RecoTemplate.renderEditor();
    const hasSection = /Display Order/.test(document.getElementById('appModalBody').textContent);
    RecoTemplate.openOrderPicker();
    const picker = !!document.getElementById('cpPanes');
    ColPicker.add('C09');
    ColPicker.done();
    const backInEditor = /Display Order/.test(document.getElementById('appModalBody').textContent);
    const order = RecoTemplate._editing.displayOrder;
    RecoTemplate.saveTemplate();
    const saved = AppState.recoTemplates.find(x => x.id === id).displayOrder;
    return { hasSection, picker, backInEditor, order, saved };
  }, TPL);
  check(t9c.hasSection && t9c.picker, 'the editor has a Display Order section that opens the picker', t9c);
  check(t9c.backInEditor && same(t9c.order, ['C09']), 'Done returns to the editor with the order set', t9c);
  check(same(t9c.saved, ['C09']), 'Save Template publishes it to the team', t9c.saved);

  /* The prune: a name that no longer exists is dropped on save, and an added
     column in the order SURVIVES (the obvious copy of the primaryKeys prune
     would have deleted it). */
  const t9d = await page.evaluate((id) => {
    RecoTemplate.edit(id);
    RecoTemplate._editing.displayOrder = ['Calc', 'C09', 'GONE', 'Note'];
    RecoTemplate.saveTemplate();
    const t = AppState.recoTemplates.find(x => x.id === id);
    return { saved: t.displayOrder };
  }, TPL);
  check(same(t9d.saved, ['Calc', 'C09', 'Note']),
    'saveTemplate prunes dead names and KEEPS added columns in the order', t9d.saved);

  const t9e = await page.evaluate((id) => {
    RecoTemplate.edit(id);
    RecoTemplate._editing.displayOrder = ['GONE', 'ALSO GONE'];
    RecoTemplate.saveTemplate();
    return AppState.recoTemplates.find(x => x.id === id).displayOrder;
  }, TPL);
  check(t9e === null, 'an order that prunes to nothing becomes null, so nothing is reordered at all', t9e);

  /* ====================================================================
     [9] _repaintRow — the row the edit touched, and the pre-existing bug
     ==================================================================== */
  console.log('\n[9] _repaintRow: the grid repaints the row after an edit');
  const t10 = await page.evaluate((id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    RecoTemplate.open(t.id);
    const s = AppState.recoSessions[t.id];
    t.displayOrder = ['Calc', 'C03'];        // the formula column FIRST, before its input
    Reco.setUserOrder(t, s, []);
    App.navigate('reco');
    const cell = (rid, col) => {
      const tr = [...document.querySelectorAll('.reco-table-wrap tbody tr')].find(x => x.dataset.rid === rid);
      const td = tr ? tr.querySelector('[data-col="' + CSS.escape(col) + '"]') : null;
      return td ? td.textContent.trim() : null;
    };
    const before = cell('r0', 'Calc');
    // The edit path a user takes: the editable cell's onchange.
    const idx = s.data.findIndex(r => r._id === 'r0');
    Reco.editCell(idx, 'C03', '999');
    const after = cell('r0', 'Calc');
    const otherRow = cell('r1', 'Calc');
    const rowCount = document.querySelectorAll('.reco-table-wrap tbody tr:not(.virt-spacer-top):not(.virt-spacer-bot)').length;
    return { before, after, otherRow, rowCount, raw: s.data[idx].C03 };
  }, TPL);
  check(t10.before === '200' && t10.raw === '999',
    'the fixture starts at 200 and the edit landed', t10);
  check(t10.after === '1998',
    'the formula column over the edited cell repaints immediately — and it is rendered ABOVE the column it reads', t10);
  check(t10.otherRow === '400' && t10.rowCount === 12, 'only that row was repainted; the rest of the body is untouched', t10);

  const t10b = await page.evaluate(() => {
    const out = {};
    const tr = [...document.querySelectorAll('.reco-table-wrap tbody tr')].find(x => x.dataset.rid === 'r2');
    const inp = tr.querySelector('[data-col="C05"] input');
    inp.focus();
    out.focusedBefore = document.activeElement === inp;
    const sess = AppState.recoSessions[AppState.activeRecoId];
    out.repainted = Reco._repaintRow(sess.data.find(r => r._id === 'r2'));
    const tr2 = [...document.querySelectorAll('.reco-table-wrap tbody tr')].find(x => x.dataset.rid === 'r2');
    out.newEl = document.activeElement !== inp;
    out.focusKept = document.activeElement === tr2.querySelector('[data-col="C05"] input');
    return out;
  });
  check(t10b.repainted && t10b.newEl && t10b.focusKept,
    'a repaint keeps the caret in the cell the user is in (so Tab through a row still works)', t10b);

  const t10c = await page.evaluate(() => {
    const sess = AppState.recoSessions[AppState.activeRecoId];
    const row = sess.data[0];
    App.navigate('home');
    const offGrid = Reco._repaintRow(row);
    App.navigate('reco');
    return { offGrid, missing: Reco._repaintRow('no_such_row_id') };
  });
  check(t10c.offGrid === false && t10c.missing === false,
    '_repaintRow refuses rather than half-repainting when the grid is not what is on screen', t10c);

  /* ====================================================================
     [10] Legacy sess.columnOrder: migrated once, never written again
     ==================================================================== */
  console.log('\n[10] the legacy shared order migrates into this PC, once');
  const t11 = await page.evaluate((id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    const s = AppState.recoSessions[t.id];
    // Wipe this PC's preference and plant what an older build left on the
    // share: the order whichever colleague dragged last.
    localStorage.removeItem(Reco._prefKey(t.id, 'columnOrder'));
    delete Reco._prefMem[Reco._prefKey(t.id, 'columnOrder')];
    s.columnOrder = ['C07', 'C02'];
    const first = Reco._userOrder(t, s).slice();
    const stored = Reco.userPref(t.id, 'columnOrder');
    // a second read must not re-migrate, and the legacy field is untouched
    s.columnOrder = ['SOMETHING', 'ELSE'];
    const second = Reco._userOrder(t, s).slice();
    // after a reset, the legacy field must NOT come back
    Reco.setUserOrder(t, s, []);
    const afterReset = Reco._userOrder(t, s);
    return { first, stored, second, afterReset, legacyStillOnSession: s.columnOrder };
  }, TPL);
  check(same(t11.first, ['C07', 'C02']) && same(t11.stored, ['C07', 'C02']),
    'the legacy shared order is adopted once, into localStorage', t11);
  check(same(t11.second, ['C07', 'C02']), 'a later change to the shared field is ignored', t11.second);
  check(t11.afterReset === null, 'and after Reset View the legacy field is not migrated back', t11.afterReset);
  check(same(t11.legacyStillOnSession, ['SOMETHING', 'ELSE']),
    'the legacy field itself is left alone, so an older build keeps working', t11.legacyStillOnSession);

  const t11b = await page.evaluate((id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    const s = AppState.recoSessions[t.id];
    s.columnOrder = null;
    Reco.setUserOrder(t, s, ['C09', 'C01']);
    const spy = [];
    const real = Store.serialize;
    Store.serialize = function (key, val) { spy.push(key); return real.apply(Store, arguments); };
    Reco.setUserOrder(t, s, ['C01', 'C09']);
    Store.serialize = real;
    return { spy, onShare: s.columnOrder };
  }, TPL);
  check(t11b.spy.length === 0 && t11b.onShare === null,
    'setting an order serialises nothing at all — no 85 MiB recoSessions write for a view preference', t11b);

  /* ====================================================================
     [11] Reset View goes back to the template's order
     ==================================================================== */
  console.log('\n[11] Reset View');
  const t12 = await page.evaluate((id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    const s = AppState.recoSessions[t.id];
    t.displayOrder = ['C05', 'C02'];
    Reco.setUserOrder(t, s, ['C08', 'C01']);
    App.navigate('reco');
    const mine = [...document.querySelectorAll('.reco-table-wrap thead th[data-col]')].map(th => th.dataset.col).slice(0, 2);
    /* C09 is a real column of the file but is NOT ticked in Display
       Columns, so positioning it must not drag it onto the screen: which
       columns are shown is displayColumns' decision, and the order only
       orders them. The picker labels such a column "not shown". */
    Reco.setUserOrder(t, s, ['C09', 'C08']);
    App.navigate('reco');
    const withUnshown = [...document.querySelectorAll('.reco-table-wrap thead th[data-col]')].map(th => th.dataset.col);
    Reco.setUserOrder(t, s, ['C08', 'C01']);
    App.navigate('reco');
    window.__toasts = [];
    Reco.resetTableView();
    const after = [...document.querySelectorAll('.reco-table-wrap thead th[data-col]')].map(th => th.dataset.col).slice(0, 2);
    const cat = Reco.pickerCatalog(t, s);
    return { mine, after, withUnshown, toast: (window.__toasts[0] || {}).msg, pref: Reco.userPref(t.id, 'columnOrder'),
             note: (cat.find(c => c.name === 'C09') || {}).note, noteShown: (cat.find(c => c.name === 'C08') || {}).note };
  }, TPL);
  check(same(t12.mine, ['C08', 'C01']), 'my order is in force first', t12.mine);
  check(t12.withUnshown[0] === 'C08' && !t12.withUnshown.includes('C09'),
    'positioning a column that Display Columns does not tick does not put it on screen', t12.withUnshown.slice(0, 3));
  check(t12.note === 'not shown' && t12.noteShown === '',
    'and the picker says "not shown" against it, so nobody positions it and wonders why', t12);
  check(same(t12.after, ['C05', 'C02']), 'Reset View falls back to the template’s order', t12);
  check(/template/i.test(t12.toast || '') && same(t12.pref, []), 'and says so', t12);

  /* ====================================================================
     [12] T9 — 200,000 rows: header and body still agree after a scroll
     ==================================================================== */
  console.log('\n[12] T9: 200,000 rows, virtual scroll, header vs body');
  const bigRoot = makeRoot('big').root;
  const bridge2 = await startBridge(bigRoot, PORT_BIG);
  procs.push(bridge2.proc);
  const BS = await openReco(browser, bridge2);
  const BIGTPL = 'tpl_big_fixed';
  await BS.page.evaluate(new Function('arg', 'return ' + BIG_SETUP + '(arg)'), ['BIG', BIGTPL, BIG]);
  await BS.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

  const t13 = await BS.page.evaluate(async (id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    const s = AppState.recoSessions[id];
    const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const wrap = document.querySelector('.reco-table-wrap');
    const head = () => [...wrap.querySelectorAll('thead th[data-col]')].map(th => th.dataset.col);
    const firstBody = () => {
      const tr = [...wrap.querySelectorAll('tbody tr:not(.virt-spacer-top):not(.virt-spacer-bot)')][0];
      return tr ? [...tr.querySelectorAll('[data-col]')].map(td => td.dataset.col) : [];
    };
    const out = { rows: s.data.length, pageSize: s.pageSize };
    out.headTop = head();
    out.bodyTop = firstBody();
    // scroll well past the first virtual window
    wrap.scrollTop = 4000;
    await raf(); await raf();
    out.headScrolled = head();
    out.bodyScrolled = firstBody();
    out.cacheHit = !!Reco._virtStateFor(t, s);

    /* The signature case: the order changes with NO re-render of the table,
       then a scroll repaints the body. Before the signature, the body kept
       the old layout while the <thead> showed the new one and every value
       was one column out. */
    Reco.setUserOrder(t, s, ['Ref', 'Calc', 'Doc']);
    out.staleAfterOrderChange = !Reco._virtStateFor(t, s);
    App.navigate('reco');
    await raf();
    const wrap2 = document.querySelector('.reco-table-wrap');
    wrap2.scrollTop = 9000;
    await raf(); await raf();
    out.headReordered = [...wrap2.querySelectorAll('thead th[data-col]')].map(th => th.dataset.col);
    const tr2 = [...wrap2.querySelectorAll('tbody tr:not(.virt-spacer-top):not(.virt-spacer-bot)')][0];
    out.bodyReordered = tr2 ? [...tr2.querySelectorAll('[data-col]')].map(td => td.dataset.col) : [];
    out.valueMatchesHeader = (() => {
      if (!tr2) return false;
      const cols = [...tr2.querySelectorAll('[data-col]')];
      const rid = tr2.dataset.rid;
      const row = s.data.find(r => r._id === rid);
      const full = Reco.rowFull(t, s, row);
      // every READ-ONLY cell must hold the value of the column its header names
      return cols.every(td => {
        const n = td.dataset.col;
        if (td.querySelector('input,select')) return true;
        const want = full[n] == null ? '' : String(full[n]);
        return td.textContent.trim() === want.trim();
      });
    })();
    return out;
  }, BIGTPL);
  check(t13.rows === BIG, 'the big fixture really is 200,000 rows', t13.rows);
  check(same(t13.headTop, t13.bodyTop), 'T9: header and body agree before scrolling', { h: t13.headTop.slice(0, 4), b: t13.bodyTop.slice(0, 4) });
  check(t13.cacheHit, 'a pure scroll still reuses the layout the render published (no re-filter)', t13.cacheHit);
  check(same(t13.headScrolled, t13.bodyScrolled), 'T9: HEADER AND BODY AGREE AFTER A VIRTUAL SCROLL', {
    h: t13.headScrolled.slice(0, 4), b: t13.bodyScrolled.slice(0, 4)
  });
  check(t13.staleAfterOrderChange, 'T9: a column-order change invalidates the published layout (the column signature)', t13);
  check(same(t13.headReordered, t13.bodyReordered) && t13.headReordered[0] === 'Ref',
    'T9: after a reorder AND a scroll the body still matches the header', {
      h: t13.headReordered.slice(0, 4), b: t13.bodyReordered.slice(0, 4)
    });
  check(t13.valueMatchesHeader, 'T9: and every value is under the header that names it', t13.valueMatchesHeader);

  /* Two sessions keep their own window — the WeakMap, not one slot. */
  const t13b = await BS.page.evaluate((id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    const s1 = AppState.recoSessions[id];
    const s2 = Reco.makeSession();
    s2.data = s1.data.slice(0, 10);
    Reco._virtPublish(s2, { tplId: t.id, data: s2.data, page: 0, pageSize: 200, filtered: s2.data,
                            slice: s2.data, descs: [], idxMap: new Map(), colSig: Reco._colSigFor(t, s2) });
    return { one: !!Reco._virtStateFor(t, s1), two: !!Reco._virtStateFor(t, s2) };
  }, BIGTPL);
  check(t13b.one && t13b.two, 'two sessions each keep their own virtual window (S15: a WeakMap keyed by the session)', t13b);

  const perf = await BS.page.evaluate(async (id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    const s = AppState.recoSessions[id];
    Reco.setUserOrder(t, s, []);
    const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      App.navigate('reco');
      await raf();
      best = Math.min(best, Math.round(performance.now() - t0));
    }
    return { ms: best, cells: document.querySelectorAll('.reco-table-wrap tbody td').length };
  }, BIGTPL);
  check(perf.ms < 6000, 'a 200,000-row render still comes up inside budget (' + perf.ms + 'ms, budget 6000ms)', perf);
  check(BS.errors.length === 0, 'nothing logged an error at 200,000 rows', BS.errors.slice(0, 3));
  await BS.ctx.close();

  /* ====================================================================
     [13] Every suite's standing guard: the day file never churns
     ==================================================================== */
  console.log('\n[13] the archive does not churn when a display order is set');
  const t14 = await page.evaluate(async (id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    RecoTemplate.open(t.id);
    const s = AppState.recoSessions[id];
    t.displayOrder = ['Calc', 'C09', 'C01'];
    AppState.save();
    App.navigate('reco');
    const idx = s.data.findIndex(r => r._id === 'r3');
    Reco.editCell(idx, 'C05', 'changed-by-test');
    await new Promise(r => setTimeout(r, 300));
    await Versioning.idle();
    return { folder: t.dataFolder };
  }, TPL);
  await sleep(600);
  const dayFiles = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p); else if (/\.csv$/i.test(f.name)) dayFiles.push(p);
    }
  })(path.join(root, 'reco_data'));
  const hdrs = dayFiles.map(p => fs.readFileSync(p, 'utf8').split(/\r?\n/)[0]);
  const wantHead = ['_pk', '_ver', '_ts', '_src', '_by'];
  check(dayFiles.length > 0, 'a day file was written', dayFiles.map(p => path.basename(p)));
  check(hdrs.every(h => {
    const cols = h.split(',');
    return same(cols.slice(0, 5), wantHead) && cols.length === 65 && cols[5] === 'C01' && cols[6] === 'C02';
  }), 'the day CSV header is still _pk,_ver,_ts,_src,_by + tpl.columns ORDER — the display order never reaches the archive', hdrs);

  const toasts = await readToasts(page);
  check(!toasts.some(t => t.kind === 'error'), 'no error toast anywhere in the run',
    toasts.filter(t => t.kind === 'error').slice(0, 4));
  check(S.errors.length === 0, 'no page or console errors', S.errors.slice(0, 5));

} finally {
  clearTimeout(watchdog);
  await browser.close();
  procs.forEach(p => { try { p.kill(); } catch (e) {} });
}

console.log('\n' + (failures ? '✗ ' : '✓ ') + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
