// End-to-end tests for "📗 Edit in Excel" (Excel link): export → edit the
// workbook with openpyxl (tests/e2e/xl_edit.py, standing in for Excel) →
// save detection → Load back → review → apply, against the real Python
// LauncherAPI (tests/e2e/bridge_server.py stands in for pywebview; it sets
// RECO_XL_NO_LAUNCH=1 so Excel is never started).
//
//   node tests/e2e/run_xllink_e2e.mjs
//
// Needs: python3 + openpyxl, Playwright (Chromium). Exits non-zero on failure.

import { spawn, spawnSync } from 'node:child_process';
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

let failures = 0, passes = 0;
function check(cond, msg, extra) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 600) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeRoot(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-xl-'));
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

async function openReco(browser, bridge) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.addInitScript(bridge.shim);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto(bridge.url + '/apps/Reco.html');
  await page.waitForSelector('#appMain .panel', { timeout: 15000 });
  return { ctx, page, errors };
}
const post = (bridge, p, body) => fetch(bridge.url + p, { method: 'POST', body: JSON.stringify(body || {}) });
const calls = async (bridge) => (await (await fetch(bridge.url + '/__log')).json());
const resetLog = async (bridge) => post(bridge, '/__reset_log');

function xlEdit(file, ops) {
  const opsFile = file + '.ops.json';
  fs.writeFileSync(opsFile, JSON.stringify(ops));
  const r = spawnSync('python3', [path.join(HERE, 'xl_edit.py'), file, opsFile], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('xl_edit failed: ' + r.stderr + r.stdout);
  return r.stdout;
}
function versionFile(root, folder) {
  const d = new Date();
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + '-' + String(d.getFullYear()).slice(-2);
  return path.join(root, 'reco_data', folder, mon, String(d.getDate()).padStart(2, '0') + '.csv');
}
function parseCsv(text) {
  // small quoted-CSV parser (values here may contain commas)
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

const FIELDS = ['Doc', 'Status', 'Remarks', 'When', 'Amount', 'Ref'];
function makeRows(n) {
  const whens = ['06/10/2026', '2026-10-07', '12/10/2026', '15/10/2026', '16/10/2026', '17/10/2026'];
  const amts = ['1,234.50', '(10)', '20', '30', '40', '50'];
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({ Doc: 'D' + i, Status: 'Open', Remarks: i >= 7 ? 'init' : '', When: whens[(i - 1) % whens.length], Amount: amts[(i - 1) % amts.length], Ref: 'R' + i });
  }
  return out;
}

async function createTemplate(page, name, opts) {
  return page.evaluate(([name, opts]) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.name = name;
    t.columns = opts.cols.map(n => ({ name: n, label: n, formats: [], isValue: n === 'Amount', isDate: n === 'When' }));
    t.primaryKeys = ['Doc'];
    t.valueColumn = 'Amount';
    t.editableColumns = opts.editable;
    t.editableColumnConfig = opts.editable.includes('Status') ? { Status: { editType: 'dropdown', optionsSource: 'manual', manualOptions: ['Open', 'Cleared'] } } : {};
    t.additionalColumns = opts.extras ? [{ name: 'Note', type: 'custom' }, { name: 'Flag', type: 'dropdown', optionsSource: 'manual', options: ['A', 'B'] }] : [];
    t.displayColumns = t.columns.map(c => c.name);
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.name === name);
    return { id: tpl.id, dataFolder: tpl.dataFolder };
  }, [name, opts]);
}
async function loadRows(page, tplId, rows) {
  await page.evaluate(([id, rows, fields]) => { RecoTemplate.open(id); Reco.ingestData(AppState.recoTemplates.find(t => t.id === id), rows, fields); App.closeModal(); }, [tplId, rows, FIELDS]);
  await page.evaluate(() => AppState.flush());
}
const ridOf = (page, tplId, doc) => page.evaluate(([id, doc]) => AppState.recoSessions[id].data.find(r => r.Doc === doc)._id, [tplId, doc]);
const rowOf = (page, tplId, doc) => page.evaluate(([id, doc]) => { const r = AppState.recoSessions[id].data.find(r => r.Doc === doc); return Object.assign({}, r); }, [tplId, doc]);

/* Export through the dialog with its defaults; returns {exportId, file, head}. */
async function exportViaDialog(page, root, tplId, before) {
  const prev = await page.evaluate((id) => ExcelLink._active[id] ? ExcelLink._active[id].exportId : '', tplId);
  await page.click('#xlEditInExcelBtn');
  // An open link with unloaded saves asks first: "Load it back first / Open it again / Create a new one"
  await page.waitForSelector('#xlCreateBtn, #appModalFooter button:has-text("Create a new one")', { timeout: 10000 });
  if (await page.$('#appModalFooter button:has-text("Create a new one")')) {
    await page.click('#appModalFooter button:has-text("Create a new one")');
    await page.waitForSelector('#xlCreateBtn', { timeout: 10000 });
  }
  if (before) await before();
  await page.click('#xlCreateBtn');
  await page.waitForFunction(([id, prev]) => ExcelLink._active[id] && ExcelLink._active[id].exportId !== prev && !ExcelLink._busy, [tplId, prev], { timeout: 30000 });
  const exportId = await page.evaluate((id) => ExcelLink._active[id].exportId, tplId);
  const df = await page.evaluate((id) => Versioning.folderFor(AppState.recoTemplates.find(t => t.id === id)), tplId);
  const headPath = path.join(root, 'reco_excel', df, '_links', exportId + '.json');
  const head = fs.existsSync(headPath) ? JSON.parse(fs.readFileSync(headPath, 'utf8')) : null;
  const file = head && head.file && head.file.rel ? path.join(root, head.file.rel) : null;
  return { exportId, head, headPath, file, basePath: path.join(root, 'reco_excel', df, '_links', exportId + '.base.json') };
}
async function waitSaved(page, tplId, timeout = 20000) {
  await page.waitForFunction((id) => { const a = ExcelLink._active[id]; return a && a.status && a.status.state === 'saved' && a.status.newSinceLastImport; }, tplId, { timeout });
}
/* Load back (review modal open) → summary of the plan. */
async function loadBack(page, source) {
  await page.evaluate((src) => { ExcelLink.load(src); }, source);
  await page.waitForFunction(() => !ExcelLink._busy && document.getElementById('appModal').classList.contains('show')
    && (document.getElementById('xlApplyBtn') || /Load back/.test(document.getElementById('appModalTitle').textContent)), null, { timeout: 30000 });
  return page.evaluate(() => {
    const p = ExcelLink._plan;
    if (!p) return { refused: document.getElementById('appModalBody').textContent };
    const s = x => ({ col: x.col, rid: x.rid, B: x.B, C: x.C, E: x.E, tick: x.tick, take: x.take, badges: x.badges, code: x.code, doc: x.row ? x.row.Doc : null });
    return { changes: p.changes.map(s), conflicts: p.conflicts.map(s), problems: p.problems.map(s), info: p.info, banners: p.banners.map(b => b.text),
      pulled: p.pulledByPk, baseline: p.baselineSource, kept: p.previouslyKept.length };
  });
}
async function applyReview(page) {
  await page.click('#xlApplyBtn');
  await page.waitForFunction(() => !ExcelLink._busy && !ExcelLink._plan, null, { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => AppState.flush());
}

const browser = await chromium.launch();
const procs = [];
const watchdog = setTimeout(() => {
  console.error('\nWATCHDOG: Excel link e2e exceeded 6 minutes; last check: ' + (passes + failures));
  procs.forEach(p => p.kill());
  process.exit(2);
}, 360000);
const killAll = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });
process.on('exit', killAll);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { killAll(); process.exit(130); }));

try {
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[E] Excel link on the new launcher (openpyxl engine)');
  const root = makeRoot('root');
  const B = await startBridge(root, 18761); procs.push(B.proc);
  const { page, errors } = await openReco(browser, B);
  const caps = await page.evaluate(() => ExcelLink.caps());
  check(caps && caps.openpyxl && caps.api === 1, 'capabilities: openpyxl engine available (tier P)', caps);

  // E16 — no editable columns: button disabled
  const t0 = await createTemplate(page, 'XL None', { cols: FIELDS, editable: [], extras: false });
  await loadRows(page, t0.id, makeRows(3));
  await page.evaluate((id) => { AppState.activeSubSection = 'reco'; RecoTemplate.open(id); }, t0.id);
  await page.waitForSelector('#xlEditInExcelBtn');
  check(await page.isDisabled('#xlEditInExcelBtn'), 'E16 "Edit in Excel" is disabled without editable columns');
  check(/No editable columns/.test(await page.getAttribute('#xlEditInExcelBtn', 'title')), 'E16 tooltip explains why');

  // Main template
  const tpl = await createTemplate(page, 'XL Test', { cols: FIELDS, editable: ['Status', 'Remarks', 'When'], extras: true });
  await loadRows(page, tpl.id, makeRows(70));
  await page.evaluate((id) => RecoTemplate.open(id), tpl.id);
  await page.waitForSelector('#xlEditInExcelBtn:not([disabled])');

  // E1 — export
  await resetLog(B);
  let X = await exportViaDialog(page, root, tpl.id, async () => {
    const chips = await page.textContent('#xlEditChips');
    check(/Status/.test(chips) && /Remarks/.test(chips) && /When/.test(chips) && /Note/.test(chips) && !/Amount/.test(chips), 'E1 dialog lists the editable columns', chips);
  });
  check(X.head && X.file && fs.existsSync(X.file), 'E1 workbook written to the shared folder', X.file);
  check(fs.existsSync(X.basePath), 'E1 baseline manifest written', X.basePath);
  check(X.head && X.head.status === 'open' && X.head.session.exportedRows === 70, 'E1 manifest head records the export', X.head && X.head.session);
  const log = (await calls(B)).calls.map(c => c.method);
  check(log.includes('excel_link_open'), 'E1 Excel was asked to open the workbook');
  await page.waitForFunction((id) => ExcelLink._active[id] && ExcelLink._active[id].status, tpl.id, { timeout: 10000 });
  check(/not saved yet/.test(await page.textContent('#xlLinkBanner')), 'E1 banner: linked, not saved yet', await page.textContent('#xlLinkBanner'));

  // E2 — round trip
  const rid = {};
  for (const d of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D10']) rid[d] = await ridOf(page, tpl.id, d);
  xlEdit(X.file, [
    { op: 'set', rid: rid.D1, col: 'Status', value: 'Cleared' },
    { op: 'set', rid: rid.D2, col: 'Remarks', value: 'x' },
    { op: 'set', rid: rid.D3, col: 'When', value: '2026-11-01', type: 'date' },
    { op: 'set', rid: rid.D1, col: 'Note', value: 'n1' }
  ]);
  await waitSaved(page, tpl.id);
  check(/Saved in Excel/.test(await page.textContent('#xlLinkBanner')), 'E2 banner notices the save in Excel');
  await page.click('#xlLinkBanner button:has-text("Load back")');
  await page.waitForSelector('#xlApplyBtn', { timeout: 20000 });
  let P = await page.evaluate(() => ({ changes: ExcelLink._plan.changes.map(x => x.col + ':' + x.row.Doc + ':' + x.tick).sort(), conflicts: ExcelLink._plan.conflicts.length, elided: ExcelLink._plan.info.elided }));
  check(P.changes.join() === 'Note:D1:true,Remarks:D2:true,Status:D1:true,When:D3:true' && P.conflicts === 0, 'E2 review: 4 ticked changes, 0 conflicts', P);
  check(P.elided >= 60, 'E2 unchanged rows were skipped by the reader (row signatures)', P.elided);
  const vf = versionFile(root, tpl.dataFolder);
  const beforeLen = parseCsv(fs.readFileSync(vf, 'utf8')).length;
  await applyReview(page);
  let r1 = await rowOf(page, tpl.id, 'D1'), r2 = await rowOf(page, tpl.id, 'D2'), r3 = await rowOf(page, tpl.id, 'D3');
  const tags = await page.evaluate((id) => AppState.recoSessions[id].manualTags, tpl.id);
  check(r1.Status === 'Cleared' && r2.Remarks === 'x', 'E2 session rows updated', { s: r1.Status, r: r2.Remarks });
  check(r3.When === '01/11/2026', 'E2 date written back in the row\'s own style (DD/MM/YYYY)', r3.When);
  check(tags[rid.D1 + '||Note'] === 'n1' && !('Note' in r1), 'E2 tag column written to manualTags (not the row)', { tag: tags[rid.D1 + '||Note'], row: r1.Note });
  const vrows = parseCsv(fs.readFileSync(vf, 'utf8'));
  const added = vrows.slice(beforeLen);
  check(added.length === 3 && added.every(r => /^C\d+$/.test(r._ver)) && new Set(added.map(r => r._pk)).size === 3, 'E2 one Cn per changed key (D1, D2, D3)', added.map(r => r._pk + ':' + r._ver));
  check(added.every(r => r._src === 'excel:' + X.exportId && r._by === 'Test User'), 'E2 history rows carry _src and _by', added.map(r => [r._src, r._by]));
  const headAfter = JSON.parse(fs.readFileSync(X.headPath, 'utf8'));
  check(Object.keys(headAfter.rebased).length === 4 && headAfter.imports.length === 1 && headAfter.lastImport, 'E2 manifest rebased and import logged', headAfter.rebased);
  check(/loaded/.test(await page.textContent('#xlLinkBanner')), 'E2 banner shows the import', await page.textContent('#xlLinkBanner'));

  // E3 — idempotent
  P = await loadBack(page, { exportId: X.exportId });
  check(P.changes.length === 0 && P.conflicts.length === 0, 'E3 loading the same file again: nothing to apply', P.changes);
  check(P.banners.some(b => /already loaded/.test(b)), 'E3 banner: this exact file was loaded before', P.banners);
  await page.evaluate(() => ExcelLink.closeReview());

  // E14 — revert after import is detected (rebased rows are never elided)
  xlEdit(X.file, [{ op: 'set', rid: rid.D1, col: 'Status', value: 'Open' }]);
  P = await loadBack(page, { exportId: X.exportId });
  check(P.changes.length === 1 && P.changes[0].col === 'Status' && P.changes[0].E === 'Open' && P.changes[0].B === 'Cleared', 'E14 revert in Excel shows as a change Cleared → Open', P.changes);
  await page.evaluate(() => ExcelLink.closeReview());
  xlEdit(X.file, [{ op: 'set', rid: rid.D1, col: 'Status', value: 'Cleared' }]);

  // E4 — conflict (edited in Reco and in Excel)
  const d4idx = await page.evaluate((id) => AppState.recoSessions[id].data.findIndex(r => r.Doc === 'D4'), tpl.id);
  await page.evaluate((i) => Reco.editCell(i, 'Remarks', 'reco-side'), d4idx);
  await page.evaluate(() => Versioning.flushQueue());
  xlEdit(X.file, [{ op: 'set', rid: rid.D4, col: 'Remarks', value: 'excel' }]);
  P = await loadBack(page, { exportId: X.exportId });
  check(P.conflicts.length === 1 && P.conflicts[0].C === 'reco-side' && P.conflicts[0].E === 'excel' && P.conflicts[0].take === false, 'E4 conflict detected, default Keep Reco', P.conflicts);
  await page.evaluate(() => ExcelLink._rvTab('conflicts'));
  await page.check('#appModalBody input[type=radio][onchange*="true"]');
  await applyReview(page);
  check((await rowOf(page, tpl.id, 'D4')).Remarks === 'excel', 'E4 "Take Excel" applied the Excel value');
  P = await loadBack(page, { exportId: X.exportId });
  check(P.conflicts.length === 0 && P.changes.length === 0, 'E4 re-import: nothing left to decide', { c: P.conflicts, ch: P.changes });
  await page.evaluate(() => ExcelLink.closeReview());

  // E5 — a colleague's history row is pulled in, not reverted
  const hdr = fs.readFileSync(vf, 'utf8').split(/\r?\n/)[0].split(',');
  const d5 = await rowOf(page, tpl.id, 'D5');
  const rec = { _pk: 'D5', _ver: 'C9', _ts: new Date(Date.now() + 1000).toISOString(), Doc: 'D5', Status: 'Open', Remarks: 'colleague', When: d5.When, Amount: d5.Amount, Ref: d5.Ref };
  fs.appendFileSync(vf, hdr.map(h => { const v = rec[h] == null ? '' : String(rec[h]); return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',') + '\r\n');
  xlEdit(X.file, [{ op: 'set', rid: rid.D5, col: 'Status', value: 'Cleared' }]);
  P = await loadBack(page, { exportId: X.exportId });
  check(P.changes.some(c => c.col === 'Status' && c.doc === 'D5' && c.tick), 'E5 Excel change for D5 is ticked', P.changes);
  check(P.pulled.D5 && P.pulled.D5.some(d => d.col === 'Remarks' && d.value === 'colleague'), 'E5 colleague value listed as pulled from history', P.pulled);
  await applyReview(page);
  const v5 = parseCsv(fs.readFileSync(vf, 'utf8')).filter(r => r._pk === 'D5').pop();
  check(v5.Status === 'Cleared' && v5.Remarks === 'colleague' && v5._ver === 'C10', 'E5 new Cn keeps the colleague\'s Remarks', v5);
  check((await rowOf(page, tpl.id, 'D5')).Remarks === 'colleague', 'E5 session row refreshed from history');

  // E6 + E7 — invalid dropdown value, read-only edit
  xlEdit(X.file, [{ op: 'set', rid: rid.D6, col: 'Status', value: 'Bogus' }, { op: 'set', rid: rid.D6, col: 'Ref', value: 'changed' }]);
  P = await loadBack(page, { exportId: X.exportId });
  check(P.problems.some(p => p.code === 'notInList' && p.col === 'Status'), 'E6 value outside the dropdown is a problem', P.problems);
  check(P.info.readOnly.Ref === 1 && !P.changes.some(c => c.col === 'Ref'), 'E7 read-only edit ignored and counted', P.info.readOnly);
  await page.evaluate(() => ExcelLink.closeReview());
  // A changed identity column (the value column) means the row was pasted over / sorted apart
  xlEdit(X.file, [{ op: 'set', rid: rid.D6, col: 'Amount', value: 999, type: 'number' }]);
  P = await loadBack(page, { exportId: X.exportId });
  check(P.problems.some(p => p.code === 'rowMisaligned' && p.rid === rid.D6), 'E7b changed identity column → rowMisaligned, row skipped', P.problems);
  await page.evaluate(() => ExcelLink.closeReview());
  xlEdit(X.file, [{ op: 'set', rid: rid.D6, col: 'Amount', value: 50, type: 'number' }, { op: 'set', rid: rid.D6, col: 'Ref', value: 'R6' }]);

  // E11 — bulk clear guard
  const clearRids = [];
  for (let i = 7; i <= 66; i++) clearRids.push(await ridOf(page, tpl.id, 'D' + i));
  xlEdit(X.file, [{ op: 'set_many', col: 'Remarks', value: null, rids: clearRids }]);
  P = await loadBack(page, { exportId: X.exportId });
  const cleared = P.changes.filter(c => c.col === 'Remarks' && c.badges.includes('cleared'));
  check(cleared.length === 60 && cleared.every(c => !c.tick), 'E11 60 cleared cells are unticked', cleared.length);
  check(P.banners.some(b => /cleared in "Remarks"/.test(b)), 'E11 bulk-clear banner', P.banners);
  await page.evaluate(() => ExcelLink.closeReview());

  // E13 — history write fails: nothing changes
  xlEdit(X.file, [{ op: 'set_many', col: 'Remarks', value: 'init', rids: clearRids }, { op: 'set', rid: rid.D10, col: 'Remarks', value: 'fault-test' }]);
  await post(B, '/__fault', { append_csv_rows: true });
  P = await loadBack(page, { exportId: X.exportId });
  const tagsBefore = JSON.stringify(await page.evaluate((id) => AppState.recoSessions[id].manualTags, tpl.id));
  await page.click('#xlApplyBtn');
  await page.waitForFunction(() => /Nothing was changed/.test(document.getElementById('appModalBody').textContent), null, { timeout: 10000 }).catch(() => {});
  check(/Nothing was changed/.test(await page.textContent('#appModalBody')), 'E13 history failure reported');
  check((await rowOf(page, tpl.id, 'D10')).Remarks === 'init', 'E13 session row unchanged');
  check(JSON.stringify(await page.evaluate((id) => AppState.recoSessions[id].manualTags, tpl.id)) === tagsBefore, 'E13 tags unchanged');
  check(!Object.keys(JSON.parse(fs.readFileSync(X.headPath, 'utf8')).rebased).some(k => k.startsWith(rid.D10)), 'E13 manifest not rebased');
  await post(B, '/__fault', { append_csv_rows: false });
  await page.evaluate(() => App.closeModal());

  // E12 — offset after export → change unticked
  await page.evaluate((r) => { const id = AppState.activeRecoId; AppState.recoSessions[id].offsets[r] = true; }, rid.D10);
  P = await loadBack(page, { exportId: X.exportId });
  const c10 = P.changes.find(c => c.doc === 'D10');
  check(c10 && !c10.tick && c10.badges.includes('offsetSinceExport'), 'E12 row offset since export: change unticked with a badge', c10);
  await page.evaluate(() => ExcelLink.closeReview());
  await page.evaluate((r) => { const id = AppState.activeRecoId; delete AppState.recoSessions[id].offsets[r]; }, rid.D10);

  // E10 — duplicated row
  xlEdit(X.file, [{ op: 'dup_row', rid: rid.D2 }, { op: 'set', row: 72, col: 'Remarks', value: 'copy' }]);
  P = await loadBack(page, { exportId: X.exportId });
  check(P.problems.filter(p => p.code === 'duplicateRowId').length === 2, 'E10 copied row → duplicateRowId for both rows', P.problems.map(p => p.code));
  await page.evaluate(() => ExcelLink.closeReview());

  // E8 — full sort keeps matching; a partial (column) shuffle is refused
  const X2 = await exportViaDialog(page, root, tpl.id);
  xlEdit(X2.file, [{ op: 'sort', col: 'Doc', reverse: true }, { op: 'set', rid: rid.D3, col: 'Remarks', value: 'after-sort' }]);
  P = await loadBack(page, { exportId: X2.exportId });
  check(P.changes.length === 1 && P.changes[0].doc === 'D3' && P.changes[0].E === 'after-sort', 'E8 rows sorted in Excel still match by hidden id', P.changes);
  await page.evaluate(() => ExcelLink.closeReview());
  xlEdit(X2.file, [{ op: 'shuffle_cols_from', col_index: 4 }]);
  P = await loadBack(page, { exportId: X2.exportId });
  check(P.problems.some(p => p.code === 'rowMisaligned') && !P.changes.some(c => c.tick && c.doc !== null && c.col === 'Status'), 'E8 partial sort detected (rowMisaligned)', P.problems.slice(0, 3));
  await page.evaluate(() => ExcelLink.closeReview());

  // E9 — data reopened after export: rows re-matched by key
  const X3 = await exportViaDialog(page, root, tpl.id);
  await page.evaluate((id) => Reco.loadVersionedFile(AppState.recoSessions[id].activeVersionFile, id), tpl.id);
  await page.waitForFunction(() => !document.getElementById('appModal').classList.contains('show') || true);
  await page.evaluate(() => AppState.flush());
  xlEdit(X3.file, [{ op: 'set', rid: rid.D6, col: 'Remarks', value: 'reopened' }]);
  P = await loadBack(page, { exportId: X3.exportId });
  const c6 = P.changes.find(c => c.doc === 'D6');
  check(c6 && c6.badges.includes('rematchedByKey') && c6.tick, 'E9 reopened data: change re-matched by key', c6);
  await applyReview(page);
  check((await rowOf(page, tpl.id, 'D6')).Remarks === 'reopened', 'E9 applied to the reopened row');

  // E17 — workbook of another template is refused
  const t2 = await createTemplate(page, 'XL Other', { cols: FIELDS, editable: ['Status'], extras: false });
  await loadRows(page, t2.id, makeRows(3));
  await page.evaluate((id) => RecoTemplate.open(id), t2.id);
  await post(B, '/__pick', { path: X3.file });
  await page.evaluate(() => ExcelLink.pickAndLoad());
  await page.waitForFunction(() => /belongs to template/.test(document.getElementById('appModalBody').textContent), null, { timeout: 15000 }).catch(() => {});
  check(/belongs to template "XL Test"/.test(await page.textContent('#appModalBody')), 'E17 workbook of another template refused');
  await page.evaluate(() => App.closeModal());

  // Links panel + close link
  await page.evaluate((id) => RecoTemplate.open(id), tpl.id);
  await page.evaluate(() => ExcelLink.openLinksPanel({ who: 'all', status: '' }));
  await page.waitForSelector('#appModalBody .xl-rv-table');
  const panelRows = await page.$$eval('#appModalBody .xl-rv-table tbody tr', trs => trs.length);
  check(panelRows >= 3, 'Excel links panel lists the exports', panelRows);
  await page.evaluate(() => App.closeModal());
  await page.evaluate((x) => ExcelLink.closeLink(x, true), X2.exportId);
  check(JSON.parse(fs.readFileSync(X2.headPath, 'utf8')).status === 'closed', 'Close link marks the manifest closed');

  const unexpected = errors.filter(e => !/injected fault/.test(e));   // E13 logs its injected failure on purpose
  check(unexpected.length === 0, 'no page errors (new launcher)', unexpected);

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[S] Excel link on an older launcher (SheetJS fallback)');
  const rootS = makeRoot('rootS');
  const BS = await startBridge(rootS, 18763, ['--legacy']); procs.push(BS.proc);
  const S = await openReco(browser, BS);
  const tierS = await S.page.evaluate(() => ExcelLink.tier());
  check(tierS === 'S', 'E15 older launcher → SheetJS tier', tierS);
  const ts = await createTemplate(S.page, 'XL Legacy', { cols: FIELDS, editable: ['Status', 'Remarks'], extras: false });
  await loadRows(S.page, ts.id, makeRows(5));
  await S.page.evaluate((id) => RecoTemplate.open(id), ts.id);
  await S.page.click('#xlEditInExcelBtn');
  await S.page.waitForSelector('#xlCreateBtn');
  check(/cannot add dropdowns/.test(await S.page.textContent('#appModalBody')), 'E15 dialog warns about the fallback');
  const [dl] = await Promise.all([S.page.waitForEvent('download', { timeout: 20000 }), S.page.click('#xlCreateBtn')]);
  const dlPath = path.join(path.dirname(rootS), dl.suggestedFilename());
  await dl.saveAs(dlPath);
  check(fs.existsSync(dlPath) && /\.xlsx$/.test(dlPath), 'E15 workbook downloaded', dl.suggestedFilename());
  const ridS = await ridOf(S.page, ts.id, 'D2');
  xlEdit(dlPath, [{ op: 'set', rid: ridS, col: 'Remarks', value: 'from legacy' }]);
  await S.page.evaluate(() => ExcelLink.pickAndLoad());
  await S.page.setInputFiles('#xlLoadFileInput', dlPath);
  await S.page.waitForSelector('#xlApplyBtn', { timeout: 20000 });
  const PS = await S.page.evaluate(() => ({ changes: ExcelLink._plan.changes.map(x => x.row.Doc + ':' + x.col + ':' + x.E), baseline: ExcelLink._plan.baselineSource }));
  check(PS.changes.join() === 'D2:Remarks:from legacy' && PS.baseline !== 'none', 'E15 SheetJS read → review with a baseline', PS);
  await applyReview(S.page);
  check((await rowOf(S.page, ts.id, 'D2')).Remarks === 'from legacy', 'E15 change applied on the older launcher');
  check(S.errors.length === 0, 'no page errors (older launcher)', S.errors);
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
