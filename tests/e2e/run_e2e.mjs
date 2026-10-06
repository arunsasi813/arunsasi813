// End-to-end tests for Reco.html + TCH.html + the hub, against the real
// Python LauncherAPI (tests/e2e/bridge_server.py stands in for pywebview).
//
//   node tests/e2e/run_e2e.mjs
//
// Needs: python3, Playwright (Chromium). Exits non-zero on the first failure.

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

let failures = 0, passes = 0;
function check(cond, msg, extra) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeRoot(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-e2e-'));
  const root = path.join(base, name);
  const cp = (src, dst) => { fs.mkdirSync(path.dirname(path.join(root, dst)), { recursive: true }); fs.copyFileSync(path.join(REPO, src), path.join(root, dst)); };
  cp('apps/Reco.html', 'apps/Reco.html');
  for (const f of fs.readdirSync(path.join(REPO, 'apps/lib'))) cp('apps/lib/' + f, 'apps/lib/' + f);
  cp('special_jv_templates/TCH.html', 'special_jv_templates/TCH.html');
  cp('special_jv_mapping/TCH.json', 'special_jv_mapping/TCH.json');
  fs.mkdirSync(path.join(root, 'master'), { recursive: true });
  fs.writeFileSync(path.join(root, 'master/user.csv'), `ID,Name,Email,reco\r\n${OS_USER},Test User,,1\r\n`);
  fs.writeFileSync(path.join(root, 'master/accounts_master.csv'),
    'Reference,RC,Nominal,SubNominal,AnalysisKey,LOB\r\nACC1,100,12345,0,0,51\r\nBANK,200,11111,0,0,51\r\n');
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
  const ctx = await browser.newContext();
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

const calls = async (bridge) => (await (await fetch(bridge.url + '/__log')).json());
const resetLog = async (bridge) => fetch(bridge.url + '/__reset_log', { method: 'POST' });

function versionFile(root, folder) {
  const d = new Date();
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + '-' + String(d.getFullYear()).slice(-2);
  return path.join(root, 'reco_data', folder, mon, String(d.getDate()).padStart(2, '0') + '.csv');
}
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(',');
  return lines.slice(1).map(l => { const v = l.split(','); const o = {}; head.forEach((h, i) => o[h] = v[i]); return o; });
}

const ROWS = [
  { Doc: 'D1', Date: '06/10/2026', 'Txn Type': 'RAPID', Currency: 'USD', 'FC Amount': '100',   AED: '367',  ToAccount: 'TCH',  Status: '' },
  { Doc: 'D2', Date: '07/10/2026', 'Txn Type': 'RAPID', Currency: 'EUR', 'FC Amount': '50',    AED: '200',  ToAccount: 'TCH',  Status: '' },
  { Doc: 'D3', Date: '12/10/2026', 'Txn Type': 'OF01',  Currency: 'RUB', 'FC Amount': '-9000', AED: '-400', ToAccount: 'TCH',  Status: '' },
  { Doc: 'D4', Date: '08/10/2026', 'Txn Type': 'RAPID', Currency: 'RUB', 'FC Amount': '5000',  AED: '220',  ToAccount: 'TCH',  Status: '' },
  { Doc: 'D5', Date: '09/10/2026', 'Txn Type': 'BANK',  Currency: 'AED', 'FC Amount': '10',    AED: '(10)', ToAccount: 'ACC1', Status: '' },
];
const FIELDS = Object.keys(ROWS[0]);

async function createTemplate(page, name, extra) {
  return page.evaluate(([name, extra]) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.name = name;
    t.columns = extra.cols.map(n => ({ name: n, label: n, formats: [], isValue: n === extra.value, isDate: n === 'Date' }));
    t.primaryKeys = extra.pks;
    t.valueColumn = extra.value;
    t.editableColumns = extra.editable || [];
    t.displayColumns = t.columns.map(c => c.name);
    if (extra.aeg) t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id, keywordColumn: '', keywordValues: '', postEntryColumn: 'Status', postEntryValue: 'Posted' };
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.name === name);
    return { id: tpl.id, dataFolder: tpl.dataFolder };
  }, [name, extra]);
}

const browser = await chromium.launch();
const procs = [];
// Never hang CI: give up (and clean up the bridge servers) after 4 minutes.
const watchdog = setTimeout(() => {
  console.error('\nWATCHDOG: e2e run exceeded 4 minutes; last check: ' + (passes + failures));
  procs.forEach(p => p.kill());
  process.exit(2);
}, 240000);
const killAll = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });
process.on('exit', killAll);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { killAll(); process.exit(130); }));
try {
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[1] Reco on the new launcher (JV page served cross-origin, like file://)');
  const root = makeRoot('root');
  const B = await startBridge(root, 18731, ['--jv-port', '18732']); procs.push(B.proc);
  let { page, errors, ctx } = await openReco(browser, B);

  const u = await page.evaluate(() => ({
    paren: U.num('(1,234.50)'), trailing: U.num('1,234.50-'), spaced: U.num('1 234.5'), text: U.num('abc'),
    feb31: U.parseDate('31/02/2026'), mmdd: U.fmtDate(U.parseDate('10/21/26'), 'YYYY-MM-DD'),
    serialText: U.fmtDate(U.parseDate('45936'), 'YYYY-MM-DD'), mmm: U.fmtDate(U.parseDate('06-Oct-26'), 'YYYY-MM-DD'),
    negMinus: Formula.evaluate('{A}-{B}', { A: '5', B: '-3' }), concat: Formula.evaluate('CONCAT({A}, "-", {B})', { A: 'x', B: 'y' }),
    quoted: Formula.evaluate("'{A}'", { A: 'q' }),
    jsq: U.jsq("O'Brien\\x"), libs: !!(window.Papa && window.XLSX),
    unparseUnion: Versioning._fields([{ a: 1 }, { a: 2, b: 3 }]).join(',')
  }));
  check(u.paren === -1234.5 && u.trailing === -1234.5 && u.spaced === 1234.5 && u.text === 0, 'U.num handles (x), trailing minus, spaces', u);
  check(u.feb31 === null && u.mmdd === '2026-10-21' && u.serialText === '2025-10-06' && u.mmm === '2026-10-06', 'U.parseDate rejects 31/02, MM/DD fallback, serial text, DD-MMM-YY', u);
  check(u.negMinus === 8 && u.concat === 'x-y', 'Formula: {A}-{B} with negative B and CONCAT', u);
  check(u.quoted === '"q"', 'Formula: token inside a string literal keeps the old substitution behaviour', u.quoted);
  check(u.jsq === "O\\&#39;Brien\\\\x", 'U.jsq escapes for JS then HTML', u.jsq);
  check(u.libs, 'PapaParse + SheetJS load from apps/lib (no CDN)');
  check(u.unparseUnion === '_pk,_ver,_ts,a,b', 'version CSV header is the union of all row keys', u.unparseUnion);
  check(await page.evaluate(() => Object.keys(SpecialJV.registry).join()) === 'TCH', 'Special JV registry loaded TCH');

  const tpl = await createTemplate(page, 'BSP RUB', { cols: FIELDS, pks: ['Doc'], value: 'AED', editable: ['ToAccount', 'Status'], aeg: true });
  check(tpl.dataFolder === 'BSP_RUB', 'new template gets a fixed dataFolder', tpl);

  await page.evaluate((id) => RecoTemplate.open(id), tpl.id);
  await page.evaluate(([id, rows, fields]) => Reco.ingestData(AppState.recoTemplates.find(t => t.id === id), rows, fields), [tpl.id, ROWS, FIELDS]);
  await page.evaluate(() => AppState.flush());
  const vf = versionFile(root, 'BSP_RUB');
  check(fs.existsSync(vf), 'upload written to reco_data/BSP_RUB/<MMM-YY>/<DD>.csv');
  const sessPks = await page.evaluate((id) => AppState.recoSessions[id].data.map(r => r._pk).join(), tpl.id);
  check(parseCsv(fs.readFileSync(vf, 'utf8')).map(r => r._pk).join() === sessPks, 'stored _pk matches the session _pk', sessPks);
  const sumAed = await page.evaluate((id) => { const s = AppState.recoSessions[id]; return s.data.reduce((a, r) => a + U.num(r.AED), 0); }, tpl.id);
  check(sumAed === 367 + 200 - 400 + 220 - 10, '"(10)" counted as -10 in totals', sumAed);

  // burst of edits → one Cn per PK and few session writes
  await resetLog(B);
  await page.evaluate((id) => {
    const s = AppState.recoSessions[id];
    for (let i = 0; i < 5; i++) Reco.editCell(0, 'Status', 'review ' + i);
    Reco.editCell(1, 'Status', 'ok');
  }, tpl.id);
  await page.evaluate(() => AppState.flush());
  const vrows = parseCsv(fs.readFileSync(vf, 'utf8'));
  const d1 = vrows.filter(r => r._pk === 'D1');
  check(d1.length === 2 && d1[1]._ver === 'C1' && d1[1].Status === 'review 4', 'five quick edits of one row → a single C1 with the final value', d1);
  const log1 = (await calls(B)).calls;
  const sessWrites = log1.filter(c => c.method === 'write_file' && c.arg0 === 'reco/recoSessions.json').length;
  check(sessWrites === 1, 'recoSessions.json written once for the whole burst (debounced)', sessWrites);
  check(log1.some(c => c.method === 'append_csv_rows'), 'edits appended via append_csv_rows (no full rewrite)');
  check(!log1.some(c => c.method === 'save_master'), 'unchanged Accounts Master is not rewritten');

  // context menu (crashed before: `sess` undefined)
  await page.click('.reco-table-wrap tbody tr[data-frow="0"] td.status-cell', { button: 'right' });
  check(await page.$('.row-ctx-menu') !== null, 'row right-click menu opens');
  await page.mouse.click(5, 5);

  // Find & Replace finds every match (global-regex lastIndex bug)
  const nFound = await page.evaluate(() => {
    FindReplace.open();
    document.getElementById('frFind').value = 'u';
    document.getElementById('frColumn').value = 'Currency';
    FindReplace._runSearch();
    const n = FindReplace._state.matches.length; App.closeModal(); return n;
  });
  check(nFound === 4, 'Find "u" in Currency finds USD, EUR, RUB, RUB', nFound);

  // attachments reach the disk, path is relative
  const att = await page.evaluate(async (id) => {
    const f = new File(['hello'], "inv'oice.txt", { type: 'text/plain' });
    const rec = await Attachments.upload(id, f, { linkedPks: ['D1'] });
    return rec && rec.storedPath;
  }, tpl.id);
  check(att && att.startsWith('reco_attachments/') && fs.existsSync(path.join(root, att)), 'attachment saved to disk with a relative path', att);

  // export through the save dialog
  await page.evaluate(() => Reco.exportData('csv'));
  await sleep(500);
  const dl = path.join(path.dirname(root), 'downloads_18731');
  const exp = fs.readdirSync(dl).find(f => f.endsWith('.csv'));
  check(exp && fs.readFileSync(path.join(dl, exp), 'utf8').startsWith('Status,RecoId,Doc'), 'CSV export saved via show_save_dialog/write_file_abs', exp);

  // ── Special JV: cancel first ─────────────────────────────────────────────
  await page.evaluate((id) => {
    const s = AppState.recoSessions[id];
    s.selectedRows = {};
    s.data.slice(0, 4).forEach(r => s.selectedRows[r._id] = true);   // D1..D4 → TCH
    Reco.previewEntryFromSelection(true);
  }, tpl.id);
  check(await page.isDisabled('#appModalFooter button:has-text("Generate")'), 'Generate blocked until the JV is completed');
  await page.click('#appModalBody button:has-text("Complete")');
  let jv = page.frameLocator('#specialJvFrame');
  await jv.locator('#rowsTable tbody tr').first().waitFor({ timeout: 10000 });
  check(await jv.locator('#rowsTable tbody tr').count() === 4, 'TCH received 4 rows through the postMessage handshake (parent not readable)');
  await jv.locator('button:has-text("Cancel")').first().click();
  await page.waitForSelector('#appModalTitle:has-text("Entry Preview")');
  const afterCancel = await page.evaluate((id) => ({ pend: (AppState.pendingSpecialJV[id] || []).length, handler: !!SpecialJV._activeHandler }), tpl.id);
  check(afterCancel.pend === 0 && !afterCancel.handler, 'cancelled JV records nothing and leaves no listener', afterCancel);
  check(await page.isDisabled('#appModalFooter button:has-text("Generate")'), 'Generate still blocked after cancel');

  // ── Special JV: complete ────────────────────────────────────────────────
  await page.click('#appModalBody button:has-text("Complete")');
  jv = page.frameLocator('#specialJvFrame');
  await jv.locator('#rowsTable tbody tr').first().waitFor({ timeout: 10000 });
  await jv.locator('.tch-card select').first().selectOption('0');          // 1-10 Oct 2026
  const periodFrom = await jv.locator('.tch-card input[placeholder="MM/DD/YY"]').first().inputValue();
  check(periodFrom === '10/01/26', 'preset fills MM/DD/YY period', periodFrom);
  await jv.locator('button:has-text("Auto-assign by period")').click();
  const sale = jv.locator('td.input input').first();
  await sale.click();
  await sale.pressSequentially('7000');                                     // focus used to be lost after 1 char
  await jv.locator('td.input input').nth(1).fill('5000');
  check(await sale.inputValue() === '7000', 'typing in Sale Data keeps focus (value 7000)');
  const t1 = await jv.locator('td.computed').allTextContents();
  check(t1.join('|') === '5,000.00|100.00|50.00|0.00', 'Rapid RUB/USD/EUR and OF totals from auto-assigned rows (D3 outside period)', t1);
  await jv.locator('button:has-text("Generate Lines")').click();            // confirm() for unassigned D3 auto-accepted
  await page.waitForSelector('#appModalBody .badge.offset', { timeout: 10000 });
  const pend = await page.evaluate((id) => AppState.pendingSpecialJV[id], tpl.id);
  check(pend.length === 1 && pend[0].lines.length === 8, 'completed JV stored with 8 lines', pend && pend.map(p => p.lines.length));
  const L = pend[0].lines;
  check(L[0].Desc === 'Cross Currency Adjustment Entry for 01 Oct - 10 Oct 26', 'remark uses the real period (MM/DD parsed correctly)', L[0].Desc);
  check(L[0].Nominal === '17036' && L[0].Dr === '12000.00' && L[1].Nominal === '85001' && L[1].Cr === '12000.00', 'entry 1 Dr 17036 / Cr 85001 12,000', L.slice(0, 2));
  check(L[6].Nominal === '17036' && L[6].Dr === '17000.00' && L[7].Nominal === '35008' && L[7].RC === '50000', 'entry 4 negative → sides swapped (Dr clearing, Cr charges)', L.slice(6));
  check(pend[0].primaryKeys.sort().join() === 'D1,D2,D4', 'JV consumed D1, D2, D4 only', pend[0].primaryKeys);
  check(!(await page.isDisabled('#appModalFooter button:has-text("Generate")')), 'Generate enabled after completion');
  await page.click('#appModalFooter button:has-text("Generate")');
  await page.waitForSelector('#appModalTitle:has-text("Allocate")', { timeout: 5000 });
  const ent = await page.evaluate((id) => {
    const s = AppState.recoSessions[id];
    return { hist: (AppState.entryHistory[id] || []).length, lines: (AppState.entryHistory[id] || [])[0].lines.length,
             status: Object.fromEntries(s.data.map(r => [r._pk, r.Status])), pend: (AppState.pendingSpecialJV[id] || []).length };
  }, tpl.id);
  check(ent.hist === 1 && ent.lines === 8 && ent.pend === 0, 'entry generated with the JV lines; pending cleared', ent);
  check(ent.status.D1 === 'Posted' && ent.status.D4 === 'Posted' && ent.status.D3 !== 'Posted', 'post-entry value only on rows the JV consumed (D3 was sent but unassigned)', ent.status);
  await page.evaluate(() => { App.closeModal(); return AppState.flush(); });
  check(parseCsv(fs.readFileSync(vf, 'utf8')).some(r => r._pk === 'D4' && r.Status === 'Posted'), 'post-entry classification versioned in the CSV');

  // reload: everything comes back from disk
  await page.evaluate(() => AppState.flush());
  await page.reload();
  await page.waitForSelector('#appMain .panel');
  const back = await page.evaluate((id) => ({ rows: AppState.recoSessions[id].data.length, entries: (AppState.entryHistory[id] || []).length, user: AppState.currentUser }), tpl.id);
  check(back.rows === 5 && back.entries === 1, 'session and entry history reload from the shared folder', back);
  check(back.user === 'Test User', 'current user comes from the launcher (not shared aegSettings)', back.user);

  // Clear Loaded Data must not pull the latest file straight back in
  await page.evaluate((id) => { RecoTemplate.open(id); Reco.clearSession(); }, tpl.id);
  await sleep(800);
  check(await page.evaluate((id) => AppState.recoSessions[id].data.length, tpl.id) === 0, 'Clear Loaded Data stays cleared');

  // rename keeps history; open existing applies later-day edits
  await page.evaluate((id) => { RecoTemplate.edit(id); RecoTemplate._editing.name = 'BSP RUB renamed'; RecoTemplate.saveTemplate(); }, tpl.id);
  const histFiles = await page.evaluate(async (id) => (await Versioning.listFiles(AppState.recoTemplates.find(t => t.id === id))).length, tpl.id);
  check(histFiles === 1, 'renamed template still finds its version files', histFiles);

  fs.mkdirSync(path.join(root, 'reco_data/HIST/Sep-26'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reco_data/HIST/Sep-26/01.csv'), '_pk,_ver,_ts,P,Amt\r\nP1,upload,t,P1,10\r\nP2,upload,t,P2,20\r\n');
  fs.mkdirSync(path.join(root, 'reco_data/HIST/Oct-26'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reco_data/HIST/Oct-26/02.csv'), '_pk,_ver,_ts,P,Amt\r\nP1,C1,t,P1,15\r\n');
  const hist = await createTemplate(page, 'HIST', { cols: ['P', 'Amt'], pks: ['P'], value: 'Amt' });
  await page.evaluate((id) => RecoTemplate.open(id), hist.id);
  await page.waitForFunction((id) => (AppState.recoSessions[id] || { data: [] }).data.length === 2, hist.id, { timeout: 5000 });
  const histRows = await page.evaluate((id) => AppState.recoSessions[id].data.map(r => r.P + '=' + r.Amt).join(), hist.id);
  check(histRows === 'P1=15,P2=20', 'auto-load picks the newest upload file and applies later edits', histRows);

  // compaction
  fs.writeFileSync(path.join(root, 'reco_data/HIST/Oct-26/02.csv'), '_pk,_ver,_ts,P,Amt\r\nP1,upload,t,P1,1\r\nP1,C1,t,P1,2\r\nP1,C2,t,P1,3\r\nP1,C3,t,P1,4\r\n');
  const comp = await page.evaluate(async (id) => {
    const t = AppState.recoTemplates.find(x => x.id === id);
    return Versioning.compactFile(t, 'reco_data/HIST/Oct-26/02.csv', true);
  }, hist.id);
  const compacted = parseCsv(fs.readFileSync(path.join(root, 'reco_data/HIST/Oct-26/02.csv'), 'utf8'));
  check(comp.before === 4 && comp.after === 2 && compacted.map(r => r._ver).join() === 'upload,C3' && comp.archived && fs.existsSync(path.join(root, comp.archived)),
        'compaction keeps upload + latest edit and archives the full file', comp);

  // corrupt JSON is preserved, not overwritten
  await page.evaluate(() => AppState.flush());
  fs.writeFileSync(path.join(root, 'reco/customMasters.json'), '[{"name": "half-writ');
  await page.reload();
  await page.waitForSelector('#appMain .panel');
  const corrupt = fs.readdirSync(path.join(root, 'reco/_corrupt')).filter(f => f.startsWith('customMasters_'));
  check(corrupt.length === 1, 'damaged JSON copied to reco/_corrupt/ before anything overwrites it', corrupt);
  check(await page.isVisible('#appModalTitle:has-text("could not be loaded")'), 'user is told which file was damaged');

  check(errors.length === 0, 'no JavaScript errors on the page', errors);
  await ctx.close();

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[2] Reco on an older launcher (no list_files / append_csv_rows / resolve_url)');
  const root2 = makeRoot('root2');
  const B2 = await startBridge(root2, 18741, ['--legacy']); procs.push(B2.proc);
  ({ page, errors, ctx } = await openReco(browser, B2));
  check(await page.evaluate(() => Object.keys(SpecialJV.registry).join()) === 'TCH', 'registry loads from list_folder_files (JSON string)');
  const t2 = await createTemplate(page, 'Legacy', { cols: FIELDS, pks: ['Doc'], value: 'AED', editable: ['Status'], aeg: true });
  await page.evaluate(([id, rows, fields]) => { RecoTemplate.open(id); Reco.ingestData(AppState.recoTemplates.find(t => t.id === id), rows, fields); }, [t2.id, ROWS, FIELDS]);
  await page.evaluate(() => { Reco.editCell(0, 'Status', 'a'); Reco.editCell(0, 'Status', 'b'); Reco.editCell(2, 'Status', 'c'); });
  await page.evaluate(() => AppState.flush());
  const lrows = parseCsv(fs.readFileSync(versionFile(root2, 'Legacy'), 'utf8'));
  check(lrows.length === 7 && lrows.filter(r => r._ver === 'C1').length === 2, 'read-modify-write fallback: 5 uploads + one C1 per edited PK', lrows.map(r => r._pk + ':' + r._ver));
  await page.evaluate((id) => {
    const s = AppState.recoSessions[id]; s.selectedRows = {}; s.data.slice(0, 2).forEach(r => s.selectedRows[r._id] = true);
    Reco.previewEntryFromSelection();
  }, t2.id);
  await page.click('#appModalBody button:has-text("Complete")');
  jv = page.frameLocator('#specialJvFrame');
  await jv.locator('#rowsTable tbody tr').first().waitFor({ timeout: 10000 });
  const src = await page.getAttribute('#specialJvFrame', 'src');
  check(src.startsWith('../special_jv_templates/TCH.html'), 'old launcher: JV page found at ROOT/special_jv_templates via path_exists', src);
  check(await jv.locator('#rowsTable tbody tr').count() === 2, 'TCH reads its rows from window.parent (same origin)');
  await jv.locator('button:has-text("Cancel")').first().click();
  check(errors.length === 0, 'no JavaScript errors on the page', errors);
  await ctx.close();

  // TCH opened on its own (no Reco parent) shows an empty, usable form
  const solo = await browser.newPage();
  const soloErr = [];
  solo.on('pageerror', e => soloErr.push(e.message));
  await solo.goto(B2.url + '/special_jv_templates/TCH.html');
  await solo.waitForSelector('.tch-card', { timeout: 6000 });
  check((await solo.textContent('#summary')).includes('No rows received') && soloErr.length === 0, 'TCH standalone: empty form, clear message, no errors', soloErr);
  await solo.close();

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[2b] Smoke: every screen and the changed code paths render without errors');
  const root4 = makeRoot('root4');
  const B4 = await startBridge(root4, 18761); procs.push(B4.proc);
  ({ page, errors, ctx } = await openReco(browser, B4));
  const t4 = await createTemplate(page, "Smoke's Tpl", { cols: FIELDS, pks: ['Doc', 'Txn Type'], value: 'AED', editable: ['Status', 'ToAccount'], aeg: true });
  const smoke = await page.evaluate(async ([id, rows, fields]) => {
    const out = {};
    const tpl = AppState.recoTemplates.find(t => t.id === id);
    Object.assign(tpl, { enableReporting: true, enableCorrections: true, groupsEnabled: true, pivotEnabled: true,
      pivotValueCol: 'AED', pivotRowCols: ['Currency'], pivotColCols: ['Lookup RC'] });
    tpl.columns.find(c => c.name === 'Doc').formats = ['TD'];
    tpl.additionalColumns = [
      { name: 'Lookup RC', type: 'master_lookup', masterCfg: { source: 'accounts', matchColumn: 'ToAccount', matchKey: 'Reference', returnKey: 'RC' } },
      { name: 'Twice', type: 'formula', formula: "NUM({AED}) * 2" },
      { name: "Tag's", type: 'custom' }
    ];
    tpl.reports = [{ id: 'r1', name: 'R1', columns: ['Doc', 'AED', 'Lookup RC'], filters: [{ col: 'AED', op: 'greater', val: '1,00' }], logic: 'AND',
      sortCol: 'AED', sortDir: 'desc', computedCols: [{ name: 'RCx', formula: "{Lookup RC} + '!'" }],
      showHeader: true, showTotalRow: true, totalColumns: ['AED'],
      summaryCards: [{ col: 'AED', func: 'Sum', displayName: '' }, { col: 'Doc', func: 'Count', displayName: 'Docs' }, { col: 'AED', func: 'Avg' }], dateFormats: {} }];
    RecoTemplate.open(id);
    Reco.ingestData(tpl, rows, fields);
    App.closeModal();
    const sess = AppState.recoSessions[id];
    for (const sec of ['action', 'correction', 'reports', 'entries', 'manage']) { Reco.setSection(sec); }
    Reco.setSection('reports'); Reco.showReport('custom_0');
    out.cards = Array.from(document.querySelectorAll('.report-cards .card')).map(c => c.textContent.replace(/\s+/g, ' ').trim());
    out.reportRows = document.querySelectorAll('#recoContentArea table tbody tr').length;
    Reco.showReport('summary'); Reco.showReport('aging');
    Reco.setSection('action');
    AppState.activeSubSection = 'pivot'; App.navigate('reco');
    out.pivotCols = Array.from(document.querySelectorAll('#recoContentArea thead th')).map(th => th.textContent);
    AppState.activeSubSection = 'reco'; App.navigate('reco');
    out.lookup = Reco._extraValueForRow(tpl, sess, sess.data[4], tpl.additionalColumns[0]);
    out.twice = Reco._extraValueForRow(tpl, sess, sess.data[4], tpl.additionalColumns[1]);
    // template wizard, every step
    for (let st = 1; st <= 5; st++) { RecoTemplate.edit(id); RecoTemplate._step = st; RecoTemplate.renderEditor(); }
    App.closeModal();
    // manage panels
    Reco.setSection('manage');
    await Reco.openVersionHistoryModal(); out.vh = document.querySelectorAll('#appModalBody table tbody tr').length; App.closeModal();
    Reco.viewManualOffsetMaster(); Reco.viewCorrectionMaster(); Reco.viewDocNumberMaster();
    Reco.openAttachmentMasterModal(); Reco.openCommentMasterModal(); Reco.openGroupMasterModal(); App.closeModal();
    // groups + timeline + comments (PKs with quotes / pipes)
    const g = Groups.create(id, "Grp 'A'", '');
    Groups.addMembers(id, g.id, [sess.data[0]._pk, sess.data[1]._pk]);
    await Reco.openGroupDetails(g.id); out.groupRows = document.querySelectorAll('#appModalBody tbody tr').length;
    Comments.create(id, 'hello', { linkedGroups: [g.id] });
    Timeline.open(id, sess.data[0]._pk); out.timeline = document.querySelectorAll('.tl-event').length; App.closeModal();
    // offsets, selection bar, find/replace with a literal "$&"
    Reco.setSection('action');
    sess.selectedRows = {}; [3, 4].forEach(i => sess.selectedRows[sess.data[i]._id] = true);
    App.navigate('reco'); Reco.updateSelSumBar(); out.selBar = document.getElementById('selSumBar').textContent;
    FindReplace.open(); document.getElementById('frFind').value = 'TCH'; document.getElementById('frReplace').value = '$&-x';
    document.getElementById('frColumn').value = 'ToAccount'; await FindReplace._replaceAll(); App.closeModal();
    out.replaced = sess.data[0].ToAccount;
    // sheet mode + fill column
    Reco.toggleSpreadsheetMode(); sess.activeCell = { fidx: 0, col: 'Status' }; App.navigate('reco');
    document.getElementById('formulaInput').value = 'filled'; Reco._ssCommit(true); Reco.toggleSpreadsheetMode();
    out.filled = sess.data.every(r => r.Status === 'filled');
    // exports
    await Reco.exportData('xlsx');
    await App.exportBackup();
    // AEG module
    App.navigate('aeg'); ['templates', 'master', 'process'].forEach(t => AEG.switchTab(t));
    AEG.currentTemplateId = AppState.aegTemplates[0].id; AEG.inputData = [{ Date: '1/1/26', Reco: 'R0', Account: 'ACC1', Cur: 'AED', Fc: '', AED: '0', Doc: 'x', Desc: 'd', ToAccount: 'BANK' },
      { Date: '1/1/26', Reco: 'R', Account: 'ACC1', Cur: 'AED', Fc: '', AED: '10', Doc: 'x', Desc: 'd', ToAccount: 'BANK' }];
    AEG.generateEntries(); out.aegLines = AEG.output.lines.length;
    AEG.editTemplate(AppState.aegTemplates[0].id); App.closeModal();
    App.navigate('home');
    await AppState.flush();
    return out;
  }, [t4.id, ROWS, FIELDS]);
  check(smoke.cards.length === 3 && smoke.cards[0].includes('Sum of AED') && smoke.cards[1].includes('Docs') && smoke.cards[2].includes('Avg of AED'),
        'report summary cards: titles + Sum/Count/Avg', smoke.cards);
  check(smoke.reportRows >= 4, 'custom report renders rows (filter "> 1,00" parsed as 100)', smoke.reportRows);
  check(smoke.pivotCols.includes('100') && smoke.pivotCols.includes('Total'), 'pivot uses master_lookup extra column', smoke.pivotCols);
  check(smoke.lookup === '100' && smoke.twice === -20, 'extra columns: master lookup + formula on "(10)"', [smoke.lookup, smoke.twice]);
  check(smoke.vh === 1, 'version history panel lists the day file', smoke.vh);
  check(smoke.groupRows === 2 && smoke.timeline === 1, 'group details + inherited group comment on the timeline', smoke);
  check(/Outside tolerance|Within tolerance/.test(smoke.selBar), 'selection bar renders', smoke.selBar);
  check(smoke.replaced === '$&-x', 'plain-text replace inserts "$&" literally', smoke.replaced);
  check(smoke.filled, 'sheet mode: fill column');
  check(smoke.aegLines === 2, 'AEG generator skips the zero group, builds 2 lines', smoke.aegLines);
  const dl4 = fs.readdirSync(path.join(path.dirname(root4), 'downloads_18761'));
  check(dl4.some(f => f.endsWith('.xlsx')) && dl4.some(f => f.startsWith('reco_suite_backup_')), 'XLSX export and backup saved via the save dialog', dl4);
  const xl = fs.readFileSync(path.join(path.dirname(root4), 'downloads_18761', dl4.find(f => f.endsWith('.xlsx'))));
  check(xl.slice(0, 2).toString() === 'PK', 'XLSX file is a real zip workbook (binary written intact)');
  // a column whose name contains an apostrophe: its header menu must still open
  await page.evaluate((id) => { RecoTemplate.open(id); AppState.recoSessions[id].hiddenCols = []; App.navigate('reco'); }, t4.id);
  await page.click('th[data-col="Tag\'s"] .col-filter-btn');
  check(await page.isVisible('.col-dropdown'), "header menu opens for a column named \"Tag's\" (quoting fix)");
  check(errors.length === 0, 'no JavaScript errors across all screens', errors);
  await ctx.close();

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[3] Hub: sign-in, app tiles, migrate the base folder');
  const root3 = makeRoot('root3');
  fs.writeFileSync(path.join(root3, 'pwd.txt'), 'secret');
  fs.mkdirSync(path.join(root3, 'reco_attachments/t1'), { recursive: true });
  fs.writeFileSync(path.join(root3, 'reco_attachments/t1/A1_x.pdf'), 'pdf');
  const B3 = await startBridge(root3, 18751); procs.push(B3.proc);
  const hctx = await browser.newContext();
  const hub = await hctx.newPage();
  const herr = [];
  hub.on('pageerror', e => herr.push(e.message));
  hub.on('dialog', d => d.accept());
  await hub.goto(B3.url + '/__hub');
  await hub.waitForSelector('.tile', { timeout: 10000 });
  check((await hub.textContent('.tile .nm')) === 'Reco', 'OS user auto-signed-in; Reco tile shown');
  await hub.click('button:has-text("Base folder")');
  await hub.fill('#admPwd', 'wrong');
  await hub.click('button:has-text("Continue")');
  await hub.waitForSelector('#admMsg .note.err');
  check(true, 'wrong admin password refused');
  await hub.fill('#admPwd', 'secret');
  await hub.click('button:has-text("Continue")');
  await hub.waitForSelector('#tabMigrate');
  await hub.click('#tabMigrate');
  const dest = path.join(path.dirname(root3), 'moved_root');
  await hub.fill('#mgPath', dest);
  await hub.click('#mFoot button:has-text("Check")');
  await hub.waitForSelector('#mgPre .note.ok, #mgPre .note.warn, #mgPre .note.err');
  const preTxt = await hub.textContent('#mgPre');
  check(/\d+ file\(s\)/.test(preTxt), 'preflight shows file count and size', preTxt);
  await hub.click('#mgStart');
  await hub.waitForSelector('#mFoot button:has-text("Open the new folder")', { timeout: 20000 });
  const st = await calls(B3);
  check(st.folder === dest, 'hub switched to the new folder after the verified copy', st.folder);
  check(fs.existsSync(path.join(dest, 'apps/Reco.html')) && fs.existsSync(path.join(dest, 'reco_attachments/t1/A1_x.pdf')) && fs.existsSync(path.join(dest, 'master/user.csv')),
        'all files (apps, masters, attachments) copied');
  check(fs.existsSync(path.join(root3, 'MIGRATED_TO.txt')) && fs.existsSync(path.join(root3, 'apps/Reco.html')), 'old folder kept, with a MIGRATED_TO.txt note');
  await hub.click('#mFoot button:has-text("Open the new folder")');
  const switched = await hub.waitForFunction(() => document.getElementById('hdrInfo').textContent.includes('moved_root'), null, { timeout: 5000 }).then(() => true, () => false);
  check(switched && await hub.isVisible('.tile'), 'hub reloads on the new base folder (header + tiles)', await hub.textContent('#hdrInfo'));
  check(herr.length === 0, 'no JavaScript errors in the hub', herr);
  await hctx.close();
} catch (e) {
  failures++;
  console.error('\nFATAL', e);
} finally {
  clearTimeout(watchdog);
  await browser.close();
  procs.forEach(p => p.kill());
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
