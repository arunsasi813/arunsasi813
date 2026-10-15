// End-to-end tests for the in-app Excel view (jspreadsheet CE 5, spec §6 / §7.2
// J1–J14) against the real Python LauncherAPI (tests/e2e/bridge_server.py
// stands in for pywebview).
//
//   node tests/e2e/run_xlview_e2e.mjs
//
// Needs: python3, Playwright (Chromium). Uses ports 18801-18809.
// Exits non-zero when a check fails.

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
const PORT = 18801;

let failures = 0, passes = 0;
function check(cond, msg, extra) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 700) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeRoot(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-xv-'));
  const root = path.join(base, name);
  const cp = (src, dst) => { fs.mkdirSync(path.dirname(path.join(root, dst)), { recursive: true }); fs.copyFileSync(path.join(REPO, src), path.join(root, dst)); };
  cp('apps/Reco.html', 'apps/Reco.html');
  for (const f of fs.readdirSync(path.join(REPO, 'apps/lib'))) cp('apps/lib/' + f, 'apps/lib/' + f);
  for (const f of ['jspreadsheet.js', 'jspreadsheet.css', 'jsuites.js', 'jsuites.css']) cp('tests/e2e/vendor/' + f, 'apps/lib/' + f);
  fs.mkdirSync(path.join(root, 'master'), { recursive: true });
  fs.writeFileSync(path.join(root, 'master/user.csv'), `ID,Name,Email,reco\r\n${OS_USER},Test User,,1\r\n`);
  return root;
}

async function startBridge(root, port, extra = []) {
  const proc = spawn('python3', [path.join(HERE, 'bridge_server.py'), root, String(port), ...extra], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => {
    proc.stdout.on('data', d => { if (String(d).includes('READY')) res(); });
    proc.on('exit', c => rej(new Error('bridge exited ' + c)));
  });
  const shim = await (await fetch(`http://127.0.0.1:${port}/__shim.js`)).text();
  return { proc, shim, url: `http://127.0.0.1:${port}` };
}

/* Page helpers, available as window.__xv in the app. */
const PAGE_HELPERS = `
window.__xv = {
  ws() { return Reco._xlWorksheet; },
  x(name) { const ws = Reco._xlWorksheet; return ws ? ws.options.columns.findIndex(c => c && c.name === name) : -1; },
  y(doc) {
    const ws = Reco._xlWorksheet, C = Reco._xlCtx;
    if (!ws || !C) return -1;
    return ws.options.data.findIndex(r => { const row = Reco._xlById.get(r[C.ridX]); return row && row.Doc === doc; });
  },
  td(doc, name) { const ws = Reco._xlWorksheet, y = this.y(doc), x = this.x(name); return (y < 0 || x < 0) ? null : ws.records[y][x].element; },
  sess() { return AppState.recoSessions[AppState.activeRecoId]; },
  tpl() { return AppState.recoTemplates.find(t => t.id === AppState.activeRecoId); },
  row(doc) { return this.sess().data.find(r => r.Doc === doc); },
  names() { return Reco._xlWorksheet.options.columns.map(c => c.name); },
  toasts: [],
};
(function () {
  const wrap = () => {
    if (typeof U === 'undefined' || U.__xvWrapped) return;
    const t0 = U.toast;
    U.toast = function (m, k) { window.__xv.toasts.push([String(m), k || '']); return t0.apply(U, arguments); };
    U.__xvWrapped = true;
  };
  document.addEventListener('DOMContentLoaded', wrap);
  window.addEventListener('load', wrap);
})();
`;

async function openReco(browser, bridge) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(bridge.shim);
  await ctx.addInitScript(PAGE_HELPERS);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message + ' | ' + (e.stack||'').split('\n').slice(0,4).join(' << ')));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto(bridge.url + '/apps/Reco.html');
  await page.waitForSelector('#appMain .panel', { timeout: 15000 });
  return { ctx, page, errors };
}

function versionFile(root, folder) {
  const d = new Date();
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + '-' + String(d.getFullYear()).slice(-2);
  return path.join(root, 'reco_data', folder, mon, String(d.getDate()).padStart(2, '0') + '.csv');
}
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const head = rows[0];
  return rows.slice(1).filter(r => r.length > 1).map(r => { const o = {}; head.forEach((h, i) => o[h] = r[i]); return o; });
}

/* Property names of the top-level object literal `const <name> = {…}` in a
   script, with a small tokenizer (strings, templates, comments, regexes). */
function objectKeys(src, name) {
  const m = new RegExp('(^|\\n)const ' + name + ' = \\{').exec(src);
  if (!m) return null;
  let i = src.indexOf('{', m.index);
  const keys = [];
  let depth = 0, expectKey = false, prev = '', prevWord = '';
  const isIdStart = c => /[A-Za-z_$]/.test(c);
  const isId = c => /[A-Za-z0-9_$]/.test(c);
  const skipString = (j, q) => { j++; while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; } return j; };
  const skipTemplate = (j) => {
    j++;
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') {
        let d = 1; j += 2;
        while (j < src.length && d) {
          const c = src[j];
          if (c === '"' || c === "'") j = skipString(j, c);
          else if (c === '`') j = skipTemplate(j);
          else if (c === '{') d++;
          else if (c === '}') d--;
          if (d) j++;
        }
        j++;
        continue;
      }
      j++;
    }
    return j;
  };
  const skipRegex = (j) => {
    j++; let cls = false;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '[') cls = true; else if (c === ']') cls = false;
      else if (c === '/' && !cls) break;
      else if (c === '\n') break;
      j++;
    }
    j++;
    while (j < src.length && /[a-z]/.test(src[j])) j++;
    return j - 1;
  };
  const regexAfter = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw']);
  for (; i < src.length; i++) {
    const c = src[i];
    if (/\s/.test(c)) continue;
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'") {
      const e = skipString(i, c);
      if (depth === 1 && expectKey) { keys.push(src.slice(i + 1, e)); expectKey = false; }
      i = e; prev = 'a'; prevWord = ''; continue;
    }
    if (c === '`') { i = skipTemplate(i); prev = 'a'; prevWord = ''; continue; }
    if (c === '/') {
      if (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || regexAfter.has(prevWord)) { i = skipRegex(i); prev = 'a'; prevWord = ''; continue; }
      prev = '/'; prevWord = ''; continue;
    }
    if (isIdStart(c)) {
      let j = i; while (j < src.length && isId(src[j])) j++;
      const w = src.slice(i, j);
      if (depth === 1 && expectKey) {
        let k = j; while (/\s/.test(src[k])) k++;
        if ((w === 'async' || w === 'get' || w === 'set') && isIdStart(src[k])) { i = j - 1; continue; }
        keys.push(w); expectKey = false;
      }
      i = j - 1; prev = 'a'; prevWord = w; continue;
    }
    if (/[0-9]/.test(c)) { let j = i; while (j < src.length && /[0-9.a-fA-FxXn_]/.test(src[j])) j++; i = j - 1; prev = 'a'; prevWord = ''; continue; }
    if (c === '{' || c === '(' || c === '[') { depth++; if (depth === 1) expectKey = true; prev = c; prevWord = ''; continue; }
    if (c === '}' || c === ')' || c === ']') { depth--; if (depth === 0) break; prev = c === '}' ? ';' : 'a'; prevWord = ''; continue; }
    if (c === ',' && depth === 1) expectKey = true;
    prev = c; prevWord = '';
  }
  return keys;
}

const FIELDS = ['Doc', 'Status', 'Remarks', 'When', 'Amount', 'Ref'];
const ROWS = [
  { Doc: 'D1', Status: 'Open', Remarks: '',  When: '45936',      Amount: '300',      Ref: 'R1' },
  { Doc: 'D2', Status: 'Open', Remarks: 'b', When: '06/10/26',   Amount: '(10)',     Ref: 'R2' },
  { Doc: 'D3', Status: 'Open', Remarks: '',  When: '06-Oct-26',  Amount: '1,234.50', Ref: 'R3' },
  { Doc: 'D4', Status: 'Open', Remarks: '',  When: '2026-10-07', Amount: '20',       Ref: 'bad!' },
  { Doc: 'D5', Status: 'Open', Remarks: 'c', When: '08/10/2026', Amount: '5',        Ref: 'R5' },
  { Doc: 'D6', Status: 'Open', Remarks: '',  When: '09/10/2026', Amount: '7',        Ref: 'R6' },
];

async function createTemplate(page, name) {
  return page.evaluate(([name, fields]) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.name = name;
    t.columns = fields.map(n => ({ name: n, label: n, formats: n === 'Ref' ? ['AN'] : [], isValue: n === 'Amount', isDate: n === 'When' }));
    t.primaryKeys = ['Doc'];
    t.valueColumn = 'Amount';
    t.toleranceValue = 0;
    t.editableColumns = ['Status', 'Remarks', 'When'];
    t.editableColumnConfig = { Status: { editType: 'dropdown', optionsSource: 'manual', manualOptions: ['Open', 'Cleared'] }, Remarks: { editType: 'free' }, When: { editType: 'free' } };
    t.additionalColumns = [{ name: 'Note', type: 'custom' }, { name: 'Flag', type: 'dropdown', optionsSource: 'manual', options: ['A', 'B'] }];
    t.displayColumns = t.columns.map(c => c.name);
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.name === name);
    return { id: tpl.id, dataFolder: tpl.dataFolder };
  }, [name, FIELDS]);
}

/* Open the template in the Excel view and wait for a NEW worksheet. */
async function openView(page, tplId, how = 'open') {
  await page.evaluate(([id, how]) => {
    window.__xvPrevWs = Reco._xlWorksheet || null;
    AppState.activeSubSection = 'excel';
    if (how === 'open') RecoTemplate.open(id); else App.navigate('reco');
  }, [tplId, how]);
  await page.waitForFunction((id) => Reco._xlCtx && Reco._xlCtx.ws && Reco._xlCtx.tplId === id && Reco._xlWorksheet !== window.__xvPrevWs
    && document.querySelector('#excelViewHost .jss_worksheet'), tplId, { timeout: 10000 });
  await sleep(60);
}
async function rebuildWait(page) {
  await page.waitForFunction(() => Reco._xlCtx && Reco._xlCtx.ws && Reco._xlWorksheet !== window.__xvPrevWs
    && document.querySelector('#excelViewHost .jss_worksheet'), null, { timeout: 10000 });
  await sleep(60);
}
const tdSel = async (page, doc, col) => {
  const xy = await page.evaluate(([doc, col]) => [__xv.x(col), __xv.y(doc)], [doc, col]);
  if (xy[0] < 0 || xy[1] < 0) throw new Error('no cell ' + doc + '/' + col);
  return `#excelViewHost td[data-x="${xy[0]}"][data-y="${xy[1]}"]`;
};
const rowOf = (page, doc) => page.evaluate((doc) => Object.assign({}, __xv.row(doc)), doc);
const flush = (page) => page.evaluate(async () => { await Versioning.flushQueue(); await AppState.flush(); });
const cnRows = (root, folder, pk) => {
  const f = versionFile(root, folder);
  if (!fs.existsSync(f)) return [];
  return parseCsv(fs.readFileSync(f, 'utf8')).filter(r => r._pk === pk && /^C\d+$/.test(r._ver));
};
/* Type into a cell with the real keyboard (opens jss's editor) and press Enter. */
async function typeInto(page, doc, col, text) {
  const sel = await tdSel(page, doc, col);
  await page.click(sel);
  await page.keyboard.type(text, { delay: 15 });
  await page.keyboard.press('Enter');
  await sleep(80);
}

const browser = await chromium.launch();
const procs = [];
const watchdog = setTimeout(() => {
  console.error('\nWATCHDOG: Excel view e2e exceeded 4 minutes; last check: ' + (passes + failures));
  procs.forEach(p => { try { p.kill(); } catch (e) {} });
  process.exit(2);
}, 240000);
const killAll = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });
process.on('exit', killAll);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { killAll(); process.exit(130); }));

try {
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[0] Source checks');
  const src = fs.readFileSync(path.join(REPO, 'apps/Reco.html'), 'utf8');
  const keys = objectKeys(src, 'Reco') || [];
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  check(keys.length > 250 && keys.includes('renderExcelView') && keys.includes('_xlInit') && keys.includes('applyEdits'),
    'Reco object literal parsed (' + keys.length + ' keys)', keys.length);
  check(dup.length === 0, 'no duplicate keys in the Reco object (a later duplicate would silently win)', dup);
  check(!/openJssSpike|_jssInit|🆗 Spreadsheet/.test(src), 'spreadsheet spike and its button are gone');
  check(!/type:\s*'calendar'/.test(src.slice(src.indexOf('XL_DEFAULTS'), src.indexOf('_xlDestroy()'))), 'Excel view never uses the calendar column type');

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[1] Excel view on the new launcher');
  const root = makeRoot('root');
  const B = await startBridge(root, PORT); procs.push(B.proc);
  const { page, errors, ctx } = await openReco(browser, B);
  const tpl = await createTemplate(page, 'XV Test');
  await page.evaluate(([id, rows, fields]) => {
    RecoTemplate.open(id);
    Reco.ingestData(AppState.recoTemplates.find(t => t.id === id), rows, fields);
    App.closeModal();
    const s = AppState.recoSessions[id];
    s.offsets = {};
    s.data.forEach(r => { delete r._recoId; delete r._manualOffset; });
    const d1 = s.data.find(r => r.Doc === 'D1'); d1.When = 45936;                 // a serial number
    const d4 = s.data.find(r => r.Doc === 'D4'); d4.Amount = 20;                  // a number row
    const d5 = s.data.find(r => r.Doc === 'D5'); d5._corrected_Remarks = true;    // corrected cell
    const d6 = s.data.find(r => r.Doc === 'D6'); s.offsets[d6._id] = true;        // offset row
    AppState.save();
  }, [tpl.id, ROWS, FIELDS]);
  await flush(page);
  await openView(page, tpl.id);
  const vf = versionFile(root, tpl.dataFolder);
  check(fs.existsSync(vf), 'upload rows written to the version file');

  // ── J1 ──────────────────────────────────────────────────────────────────
  const j1 = await page.evaluate(() => {
    const ws = Reco._xlWorksheet;
    return { ws: !!ws, isArrayEl: Array.isArray(ws), inst: !!Reco._xlInstance && Reco._xlInstance === ws.parent,
      names: __xv.names(), ridLast: ws.options.columns[ws.options.columns.length - 1].name === '_rid',
      ridHidden: ws.options.columns[ws.options.columns.length - 1].type === 'hidden', rowDrag: ws.options.rowDrag,
      parseFormulas: ws.parent.config.parseFormulas, autoInc: ws.parent.config.autoIncrement,
      registry: jspreadsheet.spreadsheet.length };
  });
  check(j1.ws && !j1.isArrayEl && j1.inst, 'J1: Reco._xlWorksheet is the worksheet (not null, not the array); _xlInstance is its spreadsheet', j1);
  check(j1.ridLast && j1.ridHidden && j1.rowDrag === false, 'hidden last _rid column, rowDrag off', j1);
  check(j1.parseFormulas === false && j1.autoInc === false, 'parseFormulas off (no formula engine), autoIncrement off', j1);
  check(JSON.stringify(j1.names) === JSON.stringify(['_status_', 'Doc', 'Status', 'Remarks', 'When', 'Amount', 'Ref', 'Note', 'Flag', '_rid']),
    'columns: status, template columns, extras, _rid', j1.names);
  await page.click(await tdSel(page, 'D2', 'Remarks'));
  await page.click('.excel-view-toolbar button[title="Bold"]');
  const j1b = await page.evaluate(() => {
    const s = __xv.sess(), r = __xv.row('D2');
    return { fmt: (s.cellFormats[r._pk] || {}).Remarks, weight: __xv.td('D2', 'Remarks').style.fontWeight };
  });
  check(j1b.fmt && j1b.fmt.bold === true && j1b.weight === '700', 'J1: toolbar B writes sess.cellFormats[_pk][col] and paints the cell', j1b);
  await openView(page, tpl.id, 'navigate');
  const j1c = await page.evaluate(() => __xv.td('D2', 'Remarks').style.fontWeight);
  check(j1c === '700', 'J1: bold survives a rebuild', j1c);

  // ── J8 read-only columns under template scope ─────────────────────────────
  const j8 = await page.evaluate(() => {
    const ws = Reco._xlWorksheet, col = n => ws.options.columns[__xv.x(n)];
    return { doc: col('Doc').readOnly, ref: col('Ref').readOnly, amt: col('Amount').readOnly, status: col('Status').readOnly,
      remarks: col('Remarks').readOnly, when: col('When').readOnly, note: col('Note').readOnly, flag: col('Flag').readOnly,
      st: col('_status_').readOnly, docTd: __xv.td('D1', 'Doc').classList.contains('readonly'),
      statusType: col('Status').type, flagType: col('Flag').type, whenType: typeof col('When').type, amtType: col('Amount').type,
      amtAlign: col('Amount').align, amtEmpty: col('Amount').allowEmpty, mask: col('Amount').mask || null };
  });
  check(j8.doc && j8.ref && j8.amt && j8.st && j8.docTd, 'J8: PK Doc, non-editable Ref, value Amount and status are read-only', j8);
  check(!j8.status && !j8.remarks && !j8.when && !j8.note && !j8.flag, 'J8: editable template columns and tag columns are editable', j8);
  check(j8.statusType === 'dropdown' && j8.flagType === 'dropdown' && j8.whenType === 'object' && j8.amtType === 'numeric'
    && j8.amtAlign === 'right' && j8.amtEmpty === true && !j8.mask, 'editors: dropdown lists, custom date editor, numeric (allowEmpty, no mask)', j8);
  const docBefore = (await rowOf(page, 'D1')).Doc;
  await page.click(await tdSel(page, 'D1', 'Doc'));
  await page.keyboard.type('ZZ');
  await page.keyboard.press('Enter');
  await page.evaluate(() => { const ws = Reco._xlWorksheet; ws.setValueFromCoords(__xv.x('Ref'), __xv.y('D1'), 'X9'); });
  await sleep(100);
  const j8b = await page.evaluate(() => ({ doc: __xv.row('D1').Doc, ref: __xv.row('D1').Ref, cell: __xv.td('D1', 'Doc').textContent }));
  check(j8b.doc === docBefore && j8b.ref === 'R1' && j8b.cell === 'D1', 'J8: typing into Doc / setting Ref changes nothing', j8b);

  // ── J11 / keyboard edit / J4 undo ─────────────────────────────────────────
  await typeInto(page, 'D1', 'Remarks', '=SALARY oct');
  await flush(page);
  const j11 = await page.evaluate(() => ({ cell: __xv.td('D1', 'Remarks').textContent, row: __xv.row('D1').Remarks }));
  check(j11.row === '=SALARY oct', 'keyboard edit through the jss editor is written to the Reco row', j11);
  check(j11.cell === '=SALARY oct', 'J11: "=SALARY oct" displays literally (no #ERROR)', j11);
  const cnD1a = cnRows(root, tpl.dataFolder, 'D1');
  check(cnD1a.length === 1 && cnD1a[0].Remarks === '=SALARY oct', 'the edit is versioned (one Cn for D1)', cnD1a);
  check(await page.isEnabled('#xlUndoBtn'), 'Undo button enabled after an edit');
  await page.click(await tdSel(page, 'D3', 'Remarks'));
  await page.keyboard.press('Control+z');
  await sleep(150);
  await flush(page);
  const j4 = await page.evaluate(() => ({ row: __xv.row('D1').Remarks, cell: __xv.td('D1', 'Remarks').textContent }));
  const cnD1b = cnRows(root, tpl.dataFolder, 'D1');
  check(j4.row === '' && j4.cell === '', 'J4: Ctrl+Z restores row[col]', j4);
  check(cnD1b.length === 2 && cnD1b[1].Remarks === '', 'J4: undo appends a compensating Cn', cnD1b.map(r => r._ver + ':' + r.Remarks));
  await page.keyboard.press('Control+y');
  await sleep(150);
  await flush(page);
  const redo = await page.evaluate(() => __xv.row('D1').Remarks);
  check(redo === '=SALARY oct' && cnRows(root, tpl.dataFolder, 'D1').length === 3, 'redo re-applies through applyEdits (one more Cn)', redo);

  // ── J2 sort then edit visual row 0 via the dropdown editor ────────────────
  await page.evaluate(() => Reco._xlWorksheet.orderBy(__xv.x('Amount'), 1));   // descending: D3 (1,234.50) first
  await sleep(100);
  const top = await page.evaluate(() => { const ws = Reco._xlWorksheet, C = Reco._xlCtx; return Reco._xlById.get(ws.options.data[0][C.ridX]).Doc; });
  check(top === 'D3', 'sorting by Amount (desc) puts D3 (1,234.50) on top', top);
  const sortSaved = await page.evaluate(() => __xv.sess().columnSorts);
  check(sortSaved && sortSaved.col === 'Amount' && sortSaved.dir === 'desc', 'sort persisted to sess.columnSorts', sortSaved);
  const stY0 = await page.evaluate(() => `#excelViewHost td[data-x="${__xv.x('Status')}"][data-y="0"]`);
  await page.dblclick(stY0);
  await page.waitForSelector('.jdropdown-item', { timeout: 5000 });
  await page.click('.jdropdown-item:has-text("Cleared")');
  await sleep(150);
  await flush(page);
  const j2 = await page.evaluate(() => Object.fromEntries(__xv.sess().data.map(r => [r.Doc, r.Status])));
  check(j2.D3 === 'Cleared' && Object.keys(j2).filter(k => j2[k] === 'Cleared').length === 1, 'J2: after a sort the edit of visual row 0 hits D3 only', j2);
  const cnD3 = cnRows(root, tpl.dataFolder, 'D3');
  check(cnD3.length === 1 && cnD3[0].Status === 'Cleared' && cnRows(root, tpl.dataFolder, 'D1').length === 3, 'J2: the Cn goes to the right PK', cnD3);
  // toolbar Undo / Redo buttons (the sheet keeps its selection: jss_object)
  await page.click('#xlUndoBtn');
  await sleep(120);
  await flush(page);
  const tbUndo = await page.evaluate(() => __xv.row('D3').Status);
  await page.click('#xlRedoBtn');
  await sleep(120);
  await flush(page);
  const tbRedo = await page.evaluate(() => __xv.row('D3').Status);
  check(tbUndo === 'Open' && tbRedo === 'Cleared' && cnRows(root, tpl.dataFolder, 'D3').length === 3, 'toolbar ↶ / ↷ undo and redo through applyEdits', [tbUndo, tbRedo]);

  // ── J3 column drag then edit under the Remarks header ──────────────────────
  /* The drag is spied on, and the spy OUTLASTS THE DEBOUNCE on purpose.
     #25 keeps the column order out of the shared session file, and the point
     of that is partly cost: _xlPersistOrder used to end in an unconditional
     AppState.save(), which arms a 250 ms timer and then serialises every
     persisted key — 0.8-1.4 s of main-thread JSON.stringify on a 200k-row
     session, for a write that had nothing in it to write. A spy read in the
     same task as the drag cannot see that save at all, which is exactly how
     it got past the gate. This is the live sheet drag, not a stand-in. */
  const dragSpy = await page.evaluate(async () => {
    await AppState.flush();
    const spy = [];
    const real = Store.serialize;
    Store.serialize = function (k) { spy.push(k); return real.apply(Store, arguments); };
    try {
      const ws = Reco._xlWorksheet;
      ws.moveColumn(__xv.x('Remarks'), __xv.x('Amount'));
      await new Promise(r => setTimeout(r, AppState.SAVE_DELAY * 3));
      return spy;
    } finally { Store.serialize = real; }
  });
  check(!dragSpy.includes('recoSessions'),
    'J3: a sheet column drag does not serialise the shared session, debounce included', dragSpy);
  await sleep(80);
  /* #25 moved the column order out of the shared session file: it is this
     person's view preference now, kept in localStorage, so a colleague
     dragging a column cannot rearrange anyone else's grid. Same assertion,
     read from where the order actually lives. */
  const order3 = await page.evaluate(() => ({ names: __xv.names(),
    saved: Reco.userPref(__xv.tpl().id, 'columnOrder'), onShare: __xv.sess().columnOrder }));
  check(order3.names.indexOf('Remarks') === order3.names.indexOf('Amount') + 1, 'Remarks moved to the right of Amount', order3.names);
  check(Array.isArray(order3.saved) && order3.saved.join() === order3.names.filter(n => n !== '_status_' && n !== '_rid').join(), 'column order persisted to this user’s view preference', order3.saved);
  check(order3.onShare == null, 'and NOT to the shared session file', order3.onShare);
  const statusBefore = await page.evaluate(() => Object.fromEntries(__xv.sess().data.map(r => [r.Doc, r.Status])));
  await typeInto(page, 'D4', 'Remarks', 'moved ok');
  await flush(page);
  const j3 = await page.evaluate(() => ({ r: __xv.row('D4').Remarks, st: Object.fromEntries(__xv.sess().data.map(r => [r.Doc, r.Status])) }));
  check(j3.r === 'moved ok' && JSON.stringify(j3.st) === JSON.stringify(statusBefore), 'J3: edit under the dragged Remarks header changes Remarks, not Status', j3);

  // ── J12 tag column ──────────────────────────────────────────────────────
  await typeInto(page, 'D2', 'Note', 'n1');
  await flush(page);
  const j12 = await page.evaluate(() => {
    const s = __xv.sess(), r = __xv.row('D2');
    return { tag: (s.manualTags || {})[r._id + '||Note'], own: Object.prototype.hasOwnProperty.call(r, 'Note'), cell: __xv.td('D2', 'Note').textContent };
  });
  check(j12.tag === 'n1' && !j12.own && j12.cell === 'n1', 'J12: editing tag Note writes sess.manualTags (row.Note absent)', j12);
  check(cnRows(root, tpl.dataFolder, 'D2').length === 0, 'tag edits are session-only (no Cn)');
  // dropdown tag: a value outside the list is refused
  await page.evaluate(() => { __xv.toasts.length = 0; Reco._xlWorksheet.setValueFromCoords(__xv.x('Flag'), __xv.y('D2'), 'Q'); Reco._xlWorksheet.setValueFromCoords(__xv.x('Flag'), __xv.y('D3'), 'b'); });
  await sleep(100);
  const flag = await page.evaluate(() => { const s = __xv.sess(); return { d2: s.manualTags[__xv.row('D2')._id + '||Flag'], d3: s.manualTags[__xv.row('D3')._id + '||Flag'], toasts: __xv.toasts.slice() }; });
  check(flag.d2 === undefined && flag.d3 === 'B' && flag.toasts.some(t => /not one of the allowed values/.test(t[0])), 'dropdown tag: "Q" refused, "b" stored as the option spelling "B"', flag);

  // ── J6 dates ────────────────────────────────────────────────────────────
  const j6 = await page.evaluate(() => ({ d1: __xv.td('D1', 'When').textContent, d2: __xv.td('D2', 'When').textContent, d3: __xv.td('D3', 'When').textContent,
    d1raw: __xv.row('D1').When }));
  check(j6.d1 === '06/10/2025' && j6.d2 === '06/10/2026' && j6.d3 === '06/10/2026', 'J6: serial 45936, 06/10/26 and 06-Oct-26 display as dates', j6);
  const cnD2before = cnRows(root, tpl.dataFolder, 'D2').length;
  await page.dblclick(await tdSel(page, 'D2', 'When'));
  await page.waitForSelector('#excelViewHost td.editor input.xl-editor[type="date"]', { timeout: 3000 });
  const isoInEditor = await page.inputValue('#excelViewHost td.editor input.xl-editor');
  await page.click(await tdSel(page, 'D5', 'Doc'));
  await sleep(100);
  await page.dblclick(await tdSel(page, 'D2', 'When'));
  await page.waitForSelector('#excelViewHost td.editor input.xl-editor', { timeout: 3000 });
  await page.keyboard.press('Escape');
  await sleep(100);
  await flush(page);
  const j6b = await page.evaluate(() => ({ raw: __xv.row('D2').When, cell: __xv.td('D2', 'When').textContent, ed: !!Reco._xlWorksheet.edition }));
  check(isoInEditor === '2026-10-06', 'J6: the date editor opens on the ISO date', isoInEditor);
  check(j6b.raw === '06/10/26' && j6b.cell === '06/10/2026' && !j6b.ed && cnRows(root, tpl.dataFolder, 'D2').length === cnD2before,
    'J6: opening and closing the date editor without picking leaves the value unchanged', j6b);
  await page.dblclick(await tdSel(page, 'D2', 'When'));
  await page.waitForSelector('#excelViewHost td.editor input.xl-editor', { timeout: 3000 });
  await page.fill('#excelViewHost td.editor input.xl-editor', '2026-11-01');
  await page.keyboard.press('Enter');
  await sleep(120);
  await flush(page);
  const j6c = await page.evaluate(() => ({ raw: __xv.row('D2').When, cell: __xv.td('D2', 'When').textContent }));
  check(j6c.raw === '01/11/26' && j6c.cell === '01/11/2026', 'a picked date is stored in the row\'s own style (DD/MM/YY)', j6c);
  await page.evaluate(() => { __xv.toasts.length = 0; Reco._xlWorksheet.setValueFromCoords(__xv.x('When'), __xv.y('D4'), 'not a date'); });
  await sleep(80);
  const badDate = await page.evaluate(() => ({ raw: __xv.row('D4').When, toasts: __xv.toasts.slice() }));
  check(badDate.raw === '2026-10-07' && badDate.toasts.some(t => /not a date/.test(t[0])), 'text in a date column is refused with a toast', badDate);

  // ── J5 paste ────────────────────────────────────────────────────────────
  // order now: _status_, Doc, Status, When, Amount, Remarks, Ref, … → a 3×3 block from Status covers Status / When / Amount
  const pasteCols = await page.evaluate(() => __xv.names().slice(__xv.x('Status'), __xv.x('Status') + 3));
  check(pasteCols.join() === 'Status,When,Amount', '3×3 paste covers Status, When, Amount', pasteCols);
  const before5 = {};
  for (const d of ['D4', 'D5', 'D6']) before5[d] = cnRows(root, tpl.dataFolder, d).length;
  await page.click(await tdSel(page, 'D4', 'Status'));
  const yStart = await page.evaluate(() => __xv.y('D4'));
  const docsInPaste = await page.evaluate((y) => [0, 1, 2].map(k => { const ws = Reco._xlWorksheet; return Reco._xlById.get(ws.options.data[y + k][Reco._xlCtx.ridX]).Doc; }), yStart);
  const pre5 = await page.evaluate((docs) => Object.fromEntries(docs.map(d => { const r = __xv.row(d); return [d, { Status: r.Status, When: r.When, Amount: r.Amount }]; })), docsInPaste);
  await page.evaluate(() => { __xv.toasts.length = 0; });
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Cleared\t2026-12-01\tabc\r\nZZ\t2026-12-02\tabc\r\nCleared\t2026-12-03\tabc');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await sleep(200);
  await flush(page);
  const j5 = await page.evaluate((docs) => ({ rows: docs.map(d => { const r = __xv.row(d); return { doc: d, Status: r.Status, When: r.When, Amount: r.Amount }; }),
    toasts: __xv.toasts.filter(t => t[1] === 'error') }), docsInPaste);
  const r5 = Object.fromEntries(j5.rows.map(r => [r.doc, r]));
  const [p0, p1, p2] = docsInPaste;
  check(r5[p0].Status === 'Cleared' && r5[p2].Status === 'Cleared' && r5[p1].Status === pre5[p1].Status,
    'J5: valid Status values pasted; "ZZ" refused (cell unchanged)', [pre5, j5.rows]);
  check(j5.rows.every(r => r.Amount === pre5[r.doc].Amount), 'J5: "abc" never reaches the read-only Amount (cells unchanged)', [pre5, j5.rows]);
  const cells5 = await page.evaluate((docs) => docs.map(d => [__xv.td(d, 'Status').textContent, __xv.td(d, 'Amount').textContent]), docsInPaste);
  check(cells5[1][0] === pre5[p1].Status && cells5.every(c => c[1] !== 'abc'), 'J5: the sheet shows the unchanged values', cells5);
  check(j5.toasts.length === 1 && /skipped \(read-only\)/.test(j5.toasts[0][0]) && /not one of the allowed values/.test(j5.toasts[0][0]),
    'J5: one toast for the burst (refused + read-only skipped)', j5.toasts);
  const after5 = docsInPaste.map(d => cnRows(root, tpl.dataFolder, d).length - before5[d]);
  check(after5.every(n => n === 1), 'J5: one Cn per PK for the paste', after5);
  const iso5 = await page.evaluate((docs) => docs.map(d => U.fmtDate(U.parseDate(__xv.row(d).When), 'YYYY-MM-DD')), docsInPaste);
  check(iso5.join() === '2026-12-01,2026-12-02,2026-12-03', 'J5: dates in the same paste were applied (also on the row whose Status was refused)', iso5);

  // ── J14 decoration ──────────────────────────────────────────────────────
  const j14 = await page.evaluate(() => ({
    err: __xv.td('D4', 'Ref').classList.contains('jss-err'), okRef: __xv.td('D1', 'Ref').classList.contains('jss-err'),
    corr: __xv.td('D5', 'Remarks').classList.contains('jss-corr'),
    off: ['Doc', 'Amount', 'Remarks'].every(c => __xv.td('D6', c).classList.contains('jss-row-offset')),
    notOff: __xv.td('D5', 'Doc').classList.contains('jss-row-offset'),
    badge6: __xv.td('D6', '_status_').innerHTML, badge5: __xv.td('D5', '_status_').innerHTML }));
  check(j14.err && !j14.okRef, 'J14: format-error cell has jss-err', j14);
  check(j14.corr, 'J14: corrected cell has jss-corr', j14);
  check(j14.off && !j14.notOff, 'J14: offset rows have jss-row-offset', j14);
  check(/badge offset/.test(j14.badge6) && /badge open/.test(j14.badge5), 'status column shows Reco badges', j14);
  // group / comment badges (counted like Comments.forPk: direct + through a group)
  await page.evaluate(() => {
    const t = __xv.tpl(), id = t.id, pk3 = __xv.row('D3')._pk, pk4 = __xv.row('D4')._pk;
    t.groupsEnabled = true;
    const g = Groups.create(id, 'G1', '');
    Groups.addMembers(id, g.id, [pk3, pk4]);
    Comments.create(id, 'direct', { linkedPks: [pk3] });
    Comments.create(id, 'via group', { linkedGroups: [g.id] });
    AppState.save();
  });
  await openView(page, tpl.id, 'navigate');
  const badges = await page.evaluate(() => {
    const t = __xv.tpl();
    return ['D3', 'D4', 'D1'].map(d => ({ d, html: __xv.td(d, '_status_').textContent, forPk: Comments.forPk(t.id, __xv.row(d)._pk).length }));
  });
  check(/📁 1/.test(badges[0].html) && /💬 2/.test(badges[0].html) && badges[0].forPk === 2 && /💬 1/.test(badges[1].html) && badges[1].forPk === 1
    && !/💬/.test(badges[2].html), 'status badges: groups and comments counted like Comments.forPk', badges);
  check(await page.isDisabled('#xlUndoBtn') && await page.isDisabled('#xlRedoBtn'), 'Undo / Redo disabled after a rebuild (history is new)');

  // ── J7 amounts (template default editScope allStandard) ────────────────────
  const j7a = await page.evaluate(() => ({ d2: __xv.td('D2', 'Amount').textContent, neg: __xv.td('D2', 'Amount').classList.contains('neg'),
    d3: __xv.td('D3', 'Amount').textContent, d4: __xv.td('D4', 'Amount').textContent }));
  check(j7a.d2 === '(10.00)' && j7a.neg && j7a.d3 === '1,234.50' && j7a.d4 === '20.00', 'J7: "(10)" displays (10.00) in red; accounting format', j7a);
  await page.evaluate((id) => { const t = AppState.recoTemplates.find(x => x.id === id); t.excelView = { editScope: 'allStandard' }; AppState.save(); }, tpl.id);
  await openView(page, tpl.id, 'navigate');
  const amtRo = await page.evaluate(() => ({ amt: Reco._xlWorksheet.options.columns[__xv.x('Amount')].readOnly, doc: Reco._xlWorksheet.options.columns[__xv.x('Doc')].readOnly }));
  check(amtRo.amt === false && amtRo.doc === true, 'editScope allStandard: Amount editable, PK still read-only', amtRo);
  await typeInto(page, 'D4', 'Amount', '2,500.75');
  await typeInto(page, 'D3', 'Amount', '2,500.75');
  await flush(page);
  const j7 = await page.evaluate(() => ({ d4: __xv.row('D4').Amount, d4t: typeof __xv.row('D4').Amount, d3: __xv.row('D3').Amount,
    c4: __xv.td('D4', 'Amount').textContent, c3: __xv.td('D3', 'Amount').textContent }));
  check(j7.d4 === 2500.75 && j7.d4t === 'number', 'J7: typing 2,500.75 into a number row stores the number 2500.75', j7);
  check(j7.d3 === '2,500.75' && j7.c3 === '2,500.75' && j7.c4 === '2,500.75', 'J7: … and "2,500.75" in a thousands-style row', j7);
  await typeInto(page, 'D5', 'Amount', 'abc');
  const j7b = await page.evaluate(() => __xv.row('D5').Amount);
  check(j7b === '5', 'a non-number in Amount is refused', j7b);
  await page.click(await tdSel(page, 'D5', 'Amount'));
  await page.keyboard.press('Delete');
  await sleep(100);
  await flush(page);
  const j7c = await page.evaluate(() => ({ raw: __xv.row('D5').Amount, cell: __xv.td('D5', 'Amount').textContent }));
  check(j7c.raw === '' && j7c.cell === '', 'clearing an amount stores "" (not 0)', j7c);
  await page.evaluate((id) => { const t = AppState.recoTemplates.find(x => x.id === id); t.excelView = {}; AppState.save(); }, tpl.id);

  // ── J9 layout persistence ─────────────────────────────────────────────────
  await openView(page, tpl.id, 'navigate');
  await page.evaluate(() => Reco._xlWorksheet.setWidth(__xv.x('Ref'), 211));
  await page.evaluate(() => Reco._xlWorksheet.orderBy(__xv.x('When'), 0));
  await sleep(100);
  // order: per-user now (see J3) — widths and sort are still session state.
  const j9a = await page.evaluate(() => ({ w: __xv.sess().columnWidths.Ref, sort: __xv.sess().columnSorts,
    order: (Reco.userPref(__xv.tpl().id, 'columnOrder') || []).slice() }));
  check(j9a.w === 211 && j9a.sort.col === 'When' && j9a.sort.dir === 'asc', 'J9: width and sort saved to sess', j9a);
  await page.evaluate(() => App.navigate('home'));
  const goneHome = await page.waitForFunction(() => jspreadsheet.spreadsheet.length === 0 && !Reco._xlWorksheet, null, { timeout: 2000 }).then(() => true, () => false);
  check(goneHome, 'going to Home releases the jspreadsheet instance', await page.evaluate(() => jspreadsheet.spreadsheet.length));
  await openView(page, tpl.id, 'open');
  const j9b = await page.evaluate(() => {
    const ws = Reco._xlWorksheet, C = Reco._xlCtx;
    const docs = ws.options.data.map(r => Reco._xlById.get(r[C.ridX]).Doc);
    return { w: ws.getWidth(__xv.x('Ref')), names: __xv.names().filter(n => n !== '_status_' && n !== '_rid'), docs,
      arrow: ws.headers[__xv.x('When')].classList.contains('arrow-down') };
  });
  check(j9b.w === 211, 'J9: column width reapplied after navigation', j9b.w);
  check(j9b.names.join() === j9a.order.join(), 'J9: column order reapplied after navigation', j9b.names);
  const expectOrder = await page.evaluate(() => { const s = __xv.sess(), t = __xv.tpl(); return Reco.applyTableFiltersSort(t, s).map(r => r.Doc); });
  check(j9b.docs.join() === expectOrder.join() && j9b.arrow, 'J9: sort reapplied (rows in Reco order, header arrow)', [j9b.docs, expectOrder]);

  // ── J10 registry ────────────────────────────────────────────────────────
  for (let k = 0; k < 4; k++) await openView(page, tpl.id, 'navigate');
  await sleep(100);
  const reg = await page.evaluate(() => jspreadsheet.spreadsheet.length);
  check(reg === 1, 'J10: jspreadsheet.spreadsheet registry stays at 1 across 4 navigations', reg);
  await page.evaluate(() => { AppState.activeSubSection = 'reco'; App.navigate('reco'); });
  await sleep(100);
  const regAway = await page.evaluate(() => ({ n: jspreadsheet.spreadsheet.length, ws: Reco._xlWorksheet }));
  check(regAway.n === 0 && regAway.ws === null, 'leaving the Excel view destroys the instance', regAway);
  const grid = await page.evaluate(() => {
    const tr = Array.from(document.querySelectorAll('.reco-table-wrap tbody tr')).find(tr => tr.textContent.includes('D2'));
    if (!tr) return null;
    return { text: tr.textContent, inputs: Array.from(tr.querySelectorAll('input, select')).map(i => i.value) };
  });
  check(grid && (grid.inputs.includes('n1') || grid.text.includes('n1')), 'J12: the grid shows the tag value edited in the view', grid);

  // ── J13 ⚙ View modal, preferences, clamping ───────────────────────────────
  await openView(page, tpl.id, 'navigate');
  await page.click('.excel-view-toolbar button:has-text("⚙ View")');
  await page.waitForSelector('#xlopt_wordWrap');
  check(await page.isVisible('#appModalFooter button:has-text("Save as template default")') && await page.isVisible('#appModalFooter button:has-text("Reset")')
    && await page.isVisible('#appModalFooter button:has-text("Cancel")'), 'J13: ⚙ modal has Save / Save as template default / Reset / Cancel');
  const groups = await page.$$eval('#appModalBody fieldset legend', ls => ls.map(l => l.textContent));
  check(groups.join() === 'Display,Editing,Rendering,Numbers & dates', 'J13: option groups', groups);
  await page.check('#xlopt_wordWrap');
  await page.selectOption('#xlopt_freezeColumns', { label: '2' });
  await page.evaluate(() => { window.__xvPrevWs = Reco._xlWorksheet; });
  await page.click('#appModalFooter button.primary:has-text("Save")');
  await rebuildWait(page);
  const j13 = await page.evaluate((id) => {
    let ls = null; try { ls = JSON.parse(localStorage.getItem('reco.xlview.v1.' + id)); } catch (e) {}
    const ws = Reco._xlWorksheet;
    return { ls, wrap: ws.options.wordWrap, freeze: ws.options.freezeColumns, tv: AppState.recoTemplates.find(t => t.id === id).excelView };
  }, tpl.id);
  check(j13.ls && j13.ls.wordWrap === true && j13.ls.freezeColumns === 2, 'J13: personal preferences saved in localStorage', j13.ls);
  check(j13.wrap === true && j13.freeze === 2, 'J13: rebuilt with wordWrap and 2 frozen columns', j13);
  check(!j13.tv || !Object.keys(j13.tv).length, 'personal Save does not touch tpl.excelView', j13.tv);
  const clamp = await page.evaluate((id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    const out = {};
    localStorage.setItem('reco.xlview.v1.' + id, JSON.stringify({ editScope: 'allStandard', allowPkEdit: true, decimals: 99, bogus: 1, wordWrap: true }));
    const o1 = Reco.xlOptions(t);
    out.a = { editScope: o1.editScope, allowPkEdit: o1.allowPkEdit, decimals: o1.decimals, bogus: 'bogus' in o1, wordWrap: o1.wordWrap };
    localStorage.setItem('reco.xlview.v1.' + id, JSON.stringify({ editScope: 'readonly' }));
    out.b = Reco.xlOptions(t).editScope;
    t.excelView = { editScope: 'allStandard', allowPkEdit: true };
    localStorage.setItem('reco.xlview.v1.' + id, JSON.stringify({ editScope: 'template', allowPkEdit: false }));
    const o3 = Reco.xlOptions(t);
    out.c = { editScope: o3.editScope, allowPkEdit: o3.allowPkEdit };
    t.excelView = { editScope: 'template', rowHeight: -5, defaultColWidth: 'abc' };
    const o4 = Reco.xlOptions(t, {});
    out.d = { rowHeight: o4.rowHeight, w: o4.defaultColWidth };
    t.excelView = {};
    localStorage.setItem('reco.xlview.v1.' + id, JSON.stringify({ editScope: 'allStandard', wordWrap: true }));
    return out;
  }, tpl.id);
  check(clamp.a.editScope === 'template' && clamp.a.allowPkEdit === false && clamp.a.decimals === 6 && !clamp.a.bogus && clamp.a.wordWrap === true,
    'J13: a personal editScope:allStandard is clamped to the template\'s "template"; allowPkEdit template-only; numbers clamped; unknown keys dropped', clamp.a);
  check(clamp.b === 'readonly' && clamp.c.editScope === 'template' && clamp.c.allowPkEdit === true, 'a personal preference may narrow editScope (readonly / template)', clamp);
  check(clamp.d.rowHeight === 0 && clamp.d.w === 120, 'template values are clamped too (negative height → 0, bad width → default)', clamp.d);
  await openView(page, tpl.id, 'navigate');
  const clampView = await page.evaluate(() => ({ amt: Reco._xlWorksheet.options.columns[__xv.x('Amount')].readOnly, scope: Reco._xlCtx.o.editScope }));
  check(clampView.amt === true && clampView.scope === 'template', 'J13: after a rebuild the clamped scope keeps Amount read-only', clampView);
  // Save as template default
  await page.click('.excel-view-toolbar button:has-text("⚙ View")');
  await page.waitForSelector('#xlopt_negativeRed');
  await page.uncheck('#xlopt_negativeRed');
  await page.evaluate(() => { window.__xvPrevWs = Reco._xlWorksheet; });
  await page.click('#appModalFooter button:has-text("Save as template default")');
  await rebuildWait(page);
  const tdef = await page.evaluate((id) => {
    let ls = 'x'; try { ls = localStorage.getItem('reco.xlview.v1.' + id); } catch (e) {}
    const t = AppState.recoTemplates.find(x => x.id === id);
    return { ev: t.excelView, ls, neg: __xv.td('D2', 'Amount').classList.contains('neg') };
  }, tpl.id);
  check(tdef.ev && tdef.ev.negativeRed === false && tdef.ev.editScope === 'template' && tdef.ev.wordWrap === true && tdef.ls === null && !tdef.neg,
    'Save as template default writes tpl.excelView (and clears personal preferences)', tdef);
  // Reset shows the template values; Cancel closes without changes
  await page.click('.excel-view-toolbar button:has-text("⚙ View")');
  await page.waitForSelector('#xlopt_negativeRed');
  await page.check('#xlopt_negativeRed');
  await page.click('#appModalFooter button:has-text("Reset")');
  const afterReset = await page.isChecked('#xlopt_negativeRed');
  await page.click('#appModalFooter button:has-text("Cancel")');
  check(afterReset === false, 'Reset puts the template values back in the form', afterReset);
  // Toolbar wrap toggle is a personal preference, applied with a rebuild
  await page.evaluate(() => { window.__xvPrevWs = Reco._xlWorksheet; });
  await page.click('.excel-view-toolbar button[title="Wrap text"]');
  await rebuildWait(page);
  const wrapPref = await page.evaluate((id) => ({ ls: JSON.parse(localStorage.getItem('reco.xlview.v1.' + id) || 'null'), wrap: Reco._xlWorksheet.options.wordWrap }), tpl.id);
  check(wrapPref.ls && wrapPref.ls.wordWrap === false && wrapPref.wrap === false, 'Wrap toggle stores a personal preference and rebuilds', wrapPref);
  // live option: row numbers
  await page.evaluate(() => Reco._xlSetPref('showRowNumbers', false));
  const idx = await page.evaluate(() => ({ same: Reco._xlWorksheet === window.__xvPrevWs || true, hidden: getComputedStyle(document.querySelector('#excelViewHost thead td.jss_selectall') || document.body).display }));
  check(idx.hidden === 'none', 'showRowNumbers off is applied live (index column hidden)', idx);
  await page.evaluate(() => Reco._xlSetPref('showRowNumbers', true));

  // ── sheet mode must not reach into the Excel view ───────────────────────
  // Sheet mode keeps an active grid cell. Its Delete handler used to fire in
  // the Excel view and blank that stale cell — a primary key included —
  // behind applyEdits' back.
  const hijack = await page.evaluate(async (id) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    sess.spreadsheetMode = true;
    AppState.activeSubSection = 'reco';
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 120));
    const fidx = Reco.applyTableFiltersSort(tpl, sess).findIndex(r => r.Doc === 'D2');
    Reco._ssSetActiveCell(fidx, 'Doc', false);              // a cell in the grid
    AppState.activeSubSection = 'excel';
    App.navigate('reco');
    await new Promise(r => setTimeout(r, 400));
    const before = sess.data.find(r => r.Doc === 'D2');
    const pkBefore = before ? before.Doc : null;
    // Call the grid's own key handler, the way a real Delete reaches it. (A
    // synthetic keydown dispatched on `document` also lands in jspreadsheet's
    // handler, which expects a real element as the target.)
    const ev = { key: 'Delete', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
                 target: document.body, preventDefault() {}, stopPropagation() {} };
    Reco._ssOnKey(ev);
    await new Promise(r => setTimeout(r, 200));
    const grid = !!document.querySelector('.reco-table-wrap');
    sess.spreadsheetMode = false;
    return { pkBefore, grid, pkAfter: (sess.data.find(r => r._id === (before || {})._id) || {}).Doc };
  }, tpl.id);
  check(hijack.pkBefore === 'D2' && hijack.pkAfter === 'D2' && hijack.grid === false,
    'Delete in the Excel view does not blank the grid\'s stale active cell', hijack);
  await page.evaluate((id) => { AppState.activeSubSection = 'excel'; App.navigate('reco'); }, tpl.id);
  await page.waitForFunction(() => !!Reco._xlWorksheet, null, { timeout: 15000 });

  // ── toolbar: Open in Excel, CSV ──────────────────────────────────────────
  const tb = await page.$$eval('.excel-view-toolbar button, .excel-view-toolbar select', els => els.map(e => (e.textContent || '').trim()));
  check(tb.some(t => t === '📗 Open in Excel') && tb.some(t => t === '⬇ CSV') && !tb.some(t => /xlsx/i.test(t)) && !tb.some(t => t === 'fx'),
    'toolbar: 📗 Open in Excel and ⬇ CSV (no ⬇ xlsx, no fx)', tb);
  const od = await page.evaluate(async () => {
    const calls = [], ex = [];
    const o1 = ExcelLink.openDialog, o2 = Reco.exportData;
    ExcelLink.openDialog = (id) => { calls.push(id); };
    Reco.exportData = (k) => { ex.push(k); };
    try {
      Array.from(document.querySelectorAll('.excel-view-toolbar button')).find(b => b.textContent.trim() === '📗 Open in Excel').click();
      Array.from(document.querySelectorAll('.excel-view-toolbar button')).find(b => b.textContent.trim() === '⬇ CSV').click();
    } finally { ExcelLink.openDialog = o1; Reco.exportData = o2; }
    return { calls, ex, id: AppState.activeRecoId };
  });
  check(od.calls.length === 1 && od.calls[0] === od.id, '"📗 Open in Excel" calls ExcelLink.openDialog(<template id>)', od);
  check(od.ex.join() === 'csv', '"⬇ CSV" calls Reco.exportData("csv")', od.ex);

  // ── selection bar ─────────────────────────────────────────────────────────
  await page.evaluate(() => { const ws = Reco._xlWorksheet; ws.updateSelectionFromCoords(__xv.x('Amount'), 0, __xv.x('Amount'), 1); });
  await page.waitForFunction(() => document.getElementById('xlSelSumBar').classList.contains('show'), null, { timeout: 3000 });
  const bar = await page.evaluate(() => ({ text: document.getElementById('xlSelSumBar').textContent, ids: Reco._xlSelIds.length }));
  check(/Rows: 2/.test(bar.text) && /Σ Amount/.test(bar.text) && bar.ids === 2, 'selection bar: rows, Σ value column, selected ids kept in Reco._xlSelIds', bar);
  check(!/onclick="Reco\._xlOffsetSelectedRows\(\[/.test(await page.innerHTML('#xlSelSumBar')), 'no inline JSON of row ids in the selection bar');

  // ── a paste wider than the columns left is cut, not piled into the last column
  await page.click(await tdSel(page, 'D1', 'Note'));
  await page.evaluate(() => {
    __xv.toasts.length = 0;
    const dt = new DataTransfer();
    dt.setData('text/plain', 'wide\tB\tZZ\tQQ');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await sleep(150);
  const wide = await page.evaluate(() => { const s = __xv.sess(), r = __xv.row('D1'); return { note: s.manualTags[r._id + '||Note'], flag: s.manualTags[r._id + '||Flag'],
    rid: Reco._xlWorksheet.options.data[__xv.y('D1')][Reco._xlCtx.ridX] === r._id, toasts: __xv.toasts.filter(t => t[1] === 'error') }; });
  check(wide.note === 'wide' && wide.flag === 'B' && wide.rid && wide.toasts.length === 0, 'a 4-wide paste at the second-last column fills Note and Flag only', wide);

  // ── copy gives clean values ───────────────────────────────────────────────
  const copied = await page.evaluate(() => { const ws = Reco._xlWorksheet, y = __xv.y('D2');
    return Reco._xlOnCopy(ws, [__xv.x('When'), y, __xv.x('Amount'), y]); });
  check(copied === '2026-11-01\t-10', 'copy: ISO date and plain number (not the display text)', copied);

  // ── context menu ──────────────────────────────────────────────────────────
  await page.click(await tdSel(page, 'D3', 'Status'), { button: 'right' });
  await page.waitForSelector('.jss_contextmenu .jcontextmenu-item, .jss_contextmenu div', { timeout: 3000 }).catch(() => {});
  const menu = await page.evaluate(() => Array.from(document.querySelectorAll('.jss_contextmenu > div')).map(d => d.textContent.trim()).filter(Boolean));
  check(menu.some(t => /^Copy/.test(t)) && menu.some(t => /^Paste/.test(t)) && menu.some(t => /Sort A → Z/.test(t)) && menu.some(t => /Filter by this value/.test(t))
    && menu.some(t => /Hide column/.test(t)) && menu.some(t => /Freeze up to here/.test(t)) && menu.some(t => /Timeline/.test(t)) && !menu.some(t => /About|Save as|Rename/i.test(t)),
    'context menu: Copy, Paste, Sort, Filter, Hide, Freeze, Timeline (no About / Save as / Rename)', menu);
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);

  // ── search box option + Ctrl+F ────────────────────────────────────────────
  await page.evaluate(() => { window.__xvPrevWs = Reco._xlWorksheet; Reco._xlSetPref('search', true); });
  await rebuildWait(page);
  await page.click(await tdSel(page, 'D3', 'Doc'));
  await page.keyboard.press('Control+f');
  const focused = await page.evaluate(() => !!Reco._xlWorksheet.searchInput && document.activeElement === Reco._xlWorksheet.searchInput);
  check(focused, 'search option shows the jss search box; Ctrl+F focuses it', focused);
  await page.evaluate(() => { window.__xvPrevWs = Reco._xlWorksheet; Reco._xlSetPref('search', false); });
  await rebuildWait(page);

  // ── unsaved editor is saved on navigation (§8 #62) ────────────────────────
  await page.click(await tdSel(page, 'D6', 'Remarks'));
  await page.keyboard.type('half typed', { delay: 10 });
  await page.evaluate(() => { AppState.activeSubSection = 'reco'; App.navigate('reco'); });
  await sleep(100);
  const saved62 = await rowOf(page, 'D6');
  check(saved62.Remarks === 'half typed', 'navigating away with an editor open saves the typed text', saved62.Remarks);

  await flush(page);
  check(errors.length === 0, 'no JavaScript errors on the page', errors);
  await ctx.close();

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[2] Storage blocked: the view still works');
  const ctx2 = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx2.addInitScript(B.shim);
  await ctx2.addInitScript(PAGE_HELPERS);
  await ctx2.addInitScript(() => {
    const deny = () => { throw new DOMException('blocked', 'SecurityError'); };
    try { Object.defineProperty(window, 'localStorage', { get: deny, configurable: true }); } catch (e) {}
  });
  const page2 = await ctx2.newPage();
  const errors2 = [];
  page2.on('pageerror', e => errors2.push('pageerror: ' + e.message));
  page2.on('dialog', d => d.accept());
  await page2.goto(B.url + '/apps/Reco.html');
  await page2.waitForSelector('#appMain .panel', { timeout: 15000 });
  await openView(page2, tpl.id, 'open');
  const st2 = await page2.evaluate(() => {
    Reco._xlSetPref('negativeRed', true);
    return { ws: !!Reco._xlWorksheet, o: Reco.xlOptions(__xv.tpl()).negativeRed };
  });
  check(st2.ws && st2.o === true, 'without localStorage the view renders and preferences are kept in memory', st2);
  check(errors2.filter(e => !/reco_user|localStorage/i.test(e)).length === 0, 'no view errors without localStorage', errors2);
  await ctx2.close();
} catch (e) {
  failures++;
  console.error('\nFATAL', e);
} finally {
  clearTimeout(watchdog);
  await browser.close();
  procs.forEach(p => { try { p.kill(); } catch (e) {} });
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
