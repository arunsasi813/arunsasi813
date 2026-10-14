/* Opening a reco must show the data that is already on the shared folder.
 *
 *     node tests/e2e/run_autoload_e2e.mjs
 *
 * The bug this suite exists for, in the user's words: "once the reco is opened
 * its first shown just not loading the data and only when clicking only its
 * loading the data".
 *
 * Root cause: `_autoLoadAttempted` is an ordinary session property and the
 * recoSessions serializer strips only `_fillDrag`, so the "already tried" latch
 * is written to reco/recoSessions.json on the SHARED folder and read back on
 * every later start. Two ways in: Clear Loaded Data sets it deliberately (to
 * suppress an immediate reload) and it then never expires; and opening a
 * template before the day's extract lands latches an attempt that found
 * nothing. Either way that template opens empty for ever, for everyone on the
 * folder, while the CSV sits there — and fills the instant the user clicks
 * Open Existing.
 *
 * Every section below asserts the FIXED behaviour, so the whole suite fails
 * before the fix. Sections 9 and 10 are the opposite: they pass today and must
 * keep passing, because the obvious "fix" of relaxing the repaint guard would
 * reintroduce a worse bug (a slow read for one template painting over the
 * template the user has since moved to).
 *
 * Ports 19500-19519.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pw;
try { pw = await import('playwright'); }
catch { pw = await import('/opt/node22/lib/node_modules/playwright/index.mjs'); }
const { chromium } = pw;

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OS_USER = os.userInfo().username;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0, passes = 0;
function check(cond, msg, extra) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
  return !!cond;
}
function note(msg, extra) {
  console.log('    · ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
}

const COLS = ['Doc', 'Date', 'Amount', 'Status'];

function makeRoot(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-autoload-'));
  const root = path.join(base, name);
  const cp = (src, dst) => {
    fs.mkdirSync(path.dirname(path.join(root, dst)), { recursive: true });
    fs.copyFileSync(path.join(REPO, src), path.join(root, dst));
  };
  cp('apps/Reco.html', 'apps/Reco.html');
  for (const f of fs.readdirSync(path.join(REPO, 'apps/lib'))) cp('apps/lib/' + f, 'apps/lib/' + f);
  for (const d of ['master', 'reco', 'reco_data', 'attachments']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'master/user.csv'), `ID,Name,Email,reco\r\n${OS_USER},Test User,,1\r\n`);
  fs.writeFileSync(path.join(root, 'master/accounts_master.csv'),
    'Reference,RC,Nominal,SubNominal,AnalysisKey,LOB\r\nACC1,100,12345,0,0,51\r\n');
  return root;
}

async function startBridge(root, port, extra = []) {
  const proc = spawn('python3', [path.join(REPO, 'tests/e2e/bridge_server.py'), root, String(port), ...extra],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => {
    proc.stdout.on('data', d => { if (String(d).includes('READY')) res(); });
    proc.on('exit', c => rej(new Error('bridge exited ' + c)));
  });
  const shim = await (await fetch(`http://127.0.0.1:${port}/__shim.js`)).text();
  return { proc, shim, url: `http://127.0.0.1:${port}`, port };
}

async function openReco(browser, bridge) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(bridge.shim);
  const page = await ctx.newPage();
  const errors = [];
  const toasts = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    // Sections 6a/6b inject read failures on purpose; Versioning logs them, as it
    // should. Anything else reaching console.error is a real defect.
    if (m.type() === 'error' && !/favicon|Failed to load resource|injected fault/.test(t)) errors.push('console: ' + t);
  });
  page.on('dialog', d => d.accept());
  await page.goto(bridge.url + '/apps/Reco.html');
  await page.waitForSelector('#appMain .panel', { timeout: 20000 });
  // Collect every toast, because several assertions below are about what the
  // app TELLS the user, not only about what it loads.
  await page.evaluate(() => {
    window.__toasts = [];
    const real = U.toast;
    U.toast = function (msg, kind) { window.__toasts.push({ msg: String(msg), kind: kind || '' }); return real.apply(U, arguments); };
  });
  return { ctx, page, errors, toasts };
}

const readToasts = page => page.evaluate(() => (window.__toasts || []).slice());
const clearToasts = page => page.evaluate(() => { window.__toasts = []; });

/* The path Versioning.pathFor builds: reco_data/<folder>/MMM-YY/DD.csv */
function versionFile(root, folder, d) {
  d = d || new Date();
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
    + '-' + String(d.getFullYear()).slice(-2);
  return path.join(root, 'reco_data', folder, mon, String(d.getDate()).padStart(2, '0') + '.csv');
}

/* A versioned upload CSV written straight onto the share, the way a colleague's
   upload or yesterday's run leaves it. `ts` controls the upload timestamp,
   which is what the clearedAt watermark compares against. */
function writeUploadCsv(root, folder, n, opts = {}) {
  const f = opts.file || versionFile(root, folder);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const head = ['_pk', '_ver', '_ts', '_src', '_by'].concat(COLS).join(',');
  const ts = opts.ts || new Date().toISOString();
  const lines = [head];
  for (let i = 1; i <= n; i++) {
    const pk = opts.blankPk ? '' : (opts.pkPrefix || 'P') + i;
    lines.push([pk, 'upload', ts, '', '', (opts.docPrefix || 'D') + i,
                '0' + (i % 9 + 1) + '/10/2026', String(i * 100), 'Open'].join(','));
  }
  fs.writeFileSync(f, lines.join('\r\n') + '\r\n');
  return f;
}

async function createTemplate(page, name) {
  return page.evaluate(([name, cols]) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.name = name;
    t.columns = cols.map(n => ({ name: n, label: n, formats: [], isValue: n === 'Amount', isDate: n === 'Date' }));
    t.primaryKeys = ['Doc'];
    t.valueColumn = 'Amount';
    t.editableColumns = ['Status'];
    t.displayColumns = t.columns.map(c => c.name);
    t.enableReporting = true;
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.name === name);
    return { id: tpl.id, dataFolder: tpl.dataFolder };
  }, [name, COLS]);
}

/* What the user actually sees on the Reconciliation screen. */
async function uiSnapshot(page) {
  return page.evaluate(() => {
    const main = document.getElementById('appMain');
    const empty = main.querySelector('.reco-content-area .empty') || main.querySelector('.empty');
    const wrap = main.querySelector('.reco-table-wrap');
    const id = AppState.activeRecoId;
    const sess = AppState.recoSessions[id] || {};
    const run = (typeof Reco._runState === 'function') ? Reco._runState(id) : null;
    return {
      page: AppState.currentPage,
      activeRecoId: id,
      emptyText: empty ? empty.textContent.trim() : null,
      bodyRows: wrap ? wrap.querySelectorAll('tbody tr:not(.virt-spacer-top):not(.virt-spacer-bot)').length : 0,
      sessRows: (sess.data || []).length,
      docs: (sess.data || []).slice(0, 8).map(r => r.Doc),
      sessLatch: sess._autoLoadAttempted === true,
      runLatch: run ? run.autoLoadTried === true : null,
      runFailed: run ? run.autoLoadFailed === true : null,
      runLoading: run ? run.autoLoading === true : null,
      hasRunState: !!run,
      clearedAt: sess.clearedAt || null,
      activeVersionFile: sess.activeVersionFile || null,
      busy: !!main.querySelector('[aria-busy="true"]'),
      saysReading: /reading the latest saved data/i.test(main.textContent),
      sectionTabs: Array.from(main.querySelectorAll('.section-tab')).map(t => t.textContent.trim()),
      disabled: Array.from(main.querySelectorAll('.reco-topbar button'))
        .filter(b => b.disabled).map(b => b.textContent.trim())
    };
  });
}

const latchOnDisk = (root, tplId) => {
  const p = path.join(root, 'reco', 'recoSessions.json');
  if (!fs.existsSync(p)) return { exists: false };
  const raw = fs.readFileSync(p, 'utf8');
  const s = JSON.parse(raw)[tplId];
  return {
    exists: true,
    latch: s ? s._autoLoadAttempted : undefined,
    clearedAt: s ? s.clearedAt : undefined,
    rawHasLatch: raw.includes('_autoLoadAttempted')
  };
};

const waitRows = (page, id, n, ms = 12000) =>
  page.waitForFunction(([id, n]) => (AppState.recoSessions[id].data || []).length >= n, [id, n], { timeout: ms })
    .then(() => true, () => false);

const reboot = async (page) => {
  await page.reload();
  await page.waitForSelector('#appMain .panel', { timeout: 20000 });
  await page.waitForFunction(() => AppState.recoTemplates.length > 0, null, { timeout: 15000 });
  await page.evaluate(() => {
    window.__toasts = [];
    const real = U.toast;
    U.toast = function (msg, kind) { window.__toasts.push({ msg: String(msg), kind: kind || '' }); return real.apply(U, arguments); };
  });
};

const procs = [];
const killAll = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });
process.on('exit', killAll);
const watchdog = setTimeout(() => { console.error('WATCHDOG'); killAll(); process.exit(2); }, 600000);

const browser = await chromium.launch();
try {
  /* ───────────── 1. the baseline: auto-load works at all ───────────── */
  console.log('\n[1] a template whose data is on the share opens with the data');
  const rootA = makeRoot('shareA');
  const BA = await startBridge(rootA, 19500); procs.push(BA.proc);
  const SA = await openReco(browser, BA);

  const t1 = await createTemplate(SA.page, 'BSP RUB');
  await SA.page.evaluate(() => AppState.flush());
  writeUploadCsv(rootA, t1.dataFolder, 5);
  await SA.page.evaluate(id => RecoTemplate.open(id), t1.id);
  await waitRows(SA.page, t1.id, 5);
  let s = await uiSnapshot(SA.page);
  check(s.sessRows === 5 && s.bodyRows > 0, '1.1 opening the template auto-loads the 5 rows', s);
  check(s.hasRunState, '1.2 the auto-load latch lives in per-run state (Reco._runState), not on the session', s);

  /* ───────────── 2. the latch must never reach the share ───────────── */
  console.log('\n[2] the "already tried" latch never reaches the shared folder');
  await SA.page.evaluate(() => AppState.flush());
  let d = latchOnDisk(rootA, t1.id);
  check(d.rawHasLatch === false,
    '2.1 reco/recoSessions.json contains no _autoLoadAttempted at all', d);

  await SA.page.evaluate(() => Reco.clearSession());
  await SA.page.evaluate(() => AppState.flush());
  s = await uiSnapshot(SA.page);
  check(s.sessRows === 0, '2.2 Clear Loaded Data empties the grid', s);
  check(s.runLatch === true, '2.3 ...and suppresses the reload for the rest of this sitting', s);
  d = latchOnDisk(rootA, t1.id);
  check(d.rawHasLatch === false,
    '2.4 ...without writing the latch to the share, even after Clear Data', d);
  check(typeof d.clearedAt === 'string' && d.clearedAt.length > 0,
    '2.5 what IS persisted is clearedAt, a watermark rather than a dead switch', d);

  // Still suppressed within the sitting: re-opening must not pull it back in.
  await SA.page.evaluate(() => App.navigate('home'));
  await SA.page.evaluate(id => RecoTemplate.open(id), t1.id);
  await sleep(1200);
  s = await uiSnapshot(SA.page);
  check(s.sessRows === 0, '2.6 re-opening it in the same sitting leaves it cleared', s);

  /* ───────── 3. Clear Data expires: a restart auto-loads again ───────── */
  console.log('\n[3] Clear Data stays cleared for that file, not for ever');
  await SA.page.evaluate(() => AppState.flush());
  await reboot(SA.page);
  check(await SA.page.evaluate(id => AppState.recoSessions[id]._autoLoadAttempted === undefined, t1.id),
    '3.1 nothing comes back off disk to suppress the next sitting');

  await SA.page.evaluate(id => RecoTemplate.open(id), t1.id);
  await sleep(1500);
  s = await uiSnapshot(SA.page);
  check(s.sessRows === 0 && typeof s.clearedAt === 'string' && s.clearedAt.length > 0,
    '3.2 the file the user deliberately cleared is still not reloaded, and clearedAt is why', s);

  // ...but a genuinely newer upload loads by itself.
  writeUploadCsv(rootA, t1.dataFolder, 4, { docPrefix: 'NEW', pkPrefix: 'N' });
  await SA.page.evaluate(() => App.navigate('home'));
  await SA.page.evaluate(id => RecoTemplate.open(id), t1.id);
  const got = await waitRows(SA.page, t1.id, 4);
  s = await uiSnapshot(SA.page);
  check(got && s.sessRows === 4 && s.docs.every(x => /^NEW/.test(x)),
    '3.3 a genuinely newer upload appears by itself, with no click', s);

  /* ───── 4. opened before the extract landed, then a colleague uploads ───── */
  console.log('\n[4] opened before the day\'s extract landed');
  const t2 = await createTemplate(SA.page, 'Payroll');
  await SA.page.evaluate(() => AppState.flush());
  check(!fs.existsSync(versionFile(rootA, t2.dataFolder)), '4.1 no data file for this template yet');

  await SA.page.evaluate(id => RecoTemplate.open(id), t2.id);
  await sleep(1200);
  s = await uiSnapshot(SA.page);
  check(s.sessRows === 0, '4.2 it opens empty, correctly — there is nothing to load');
  await SA.page.evaluate(() => { App.navigate('home'); return AppState.flush(); });
  d = latchOnDisk(rootA, t2.id);
  check(d.rawHasLatch === false,
    '4.3 a fruitless attempt writes no latch to the share', d);

  writeUploadCsv(rootA, t2.dataFolder, 3);
  note('colleague uploads 3 rows');
  await SA.page.evaluate(id => RecoTemplate.open(id), t2.id);
  const got2 = await waitRows(SA.page, t2.id, 3);
  s = await uiSnapshot(SA.page);
  check(got2 && s.sessRows === 3,
    '4.4 re-opening it in the same sitting now finds the colleague\'s upload', s);

  await SA.page.evaluate(() => AppState.flush());
  await reboot(SA.page);
  await SA.page.evaluate(id => RecoTemplate.open(id), t2.id);
  const got3 = await waitRows(SA.page, t2.id, 3);
  s = await uiSnapshot(SA.page);
  check(got3 && s.sessRows === 3, '4.5 and after a restart it still loads by itself', s);

  /* ───────────── 5. the screen says it is reading ───────────── */
  console.log('\n[5] a slow share: the screen says it is reading, and does not look finished');
  const rootB = makeRoot('shareB');
  const BB = await startBridge(rootB, 19502, ['--slow-read', '700']); procs.push(BB.proc);
  const SB = await openReco(browser, BB);
  const t3 = await createTemplate(SB.page, 'Slow');
  await SB.page.evaluate(() => AppState.flush());
  writeUploadCsv(rootB, t3.dataFolder, 6);

  await SB.page.evaluate(id => RecoTemplate.open(id), t3.id);
  await sleep(350);   // mid-read: listFiles alone costs 700ms per call here
  s = await uiSnapshot(SB.page);
  check(s.saysReading, '5.1 mid-read the screen says it is reading the latest saved data', s);
  check(!/No data loaded/.test(s.emptyText || ''),
    '5.2 ...instead of the finished-looking "No data loaded. Upload a CSV/XLSX file"', s);
  check(s.busy, '5.3 the region is marked aria-busy while the read is in flight', s);
  check(s.runLoading === true, '5.4 the in-flight flag is per-run state, so a crash cannot persist it', s);
  check(s.disabled.some(x => /Add Data/.test(x)) && s.disabled.some(x => /Open Existing/.test(x)),
    '5.5 Add Data and Open Existing are disabled while the read is in flight', s);

  const arrived = await waitRows(SB.page, t3.id, 6, 30000);
  s = await uiSnapshot(SB.page);
  check(arrived && s.sessRows === 6, '5.6 the rows arrive without the user clicking anything', s);
  check(s.hasRunState && s.runLoading === false && !s.saysReading && !s.busy && s.disabled.length === 0,
    '5.7 the reading state clears when the read finishes', s);

  /* ───────────── 6. a read that fails says so, and does not latch ───────────── */
  console.log('\n[6] a dropped share is reported, and the next visit retries');
  const rootC = makeRoot('shareC');
  const BC = await startBridge(rootC, 19504); procs.push(BC.proc);
  const SC = await openReco(browser, BC);
  const t4 = await createTemplate(SC.page, 'Flaky');
  await SC.page.evaluate(() => AppState.flush());
  writeUploadCsv(rootC, t4.dataFolder, 5);

  const fault = (on, method) => fetch(`http://127.0.0.1:19504/__fault`,
    { method: 'POST', body: JSON.stringify({ [method]: !!on }) }).then(r => r.json());

  // 6a. the file read itself fails
  await fault(true, 'read_file');
  await clearToasts(SC.page);
  await SC.page.evaluate(id => RecoTemplate.open(id), t4.id);
  await sleep(1500);
  let toasts = await readToasts(SC.page);
  s = await uiSnapshot(SC.page);
  check(toasts.some(t => /could not read the saved data/i.test(t.msg)),
    '6.1 a failed read tells the user it could not be read', toasts);
  check(!toasts.some(t => /file empty/i.test(t.msg)),
    '6.2 ...and does not claim the file is empty, which it is not', toasts);
  check(s.hasRunState && s.runFailed === true,
    '6.3 a failed read is recorded as a failure, not as "nothing to load"', s);

  await fault(false, 'read_file');
  await SC.page.evaluate(() => App.navigate('home'));
  await SC.page.evaluate(id => RecoTemplate.open(id), t4.id);
  const retried = await waitRows(SC.page, t4.id, 5);
  check(retried, '6.4 and the next visit does retry, with no click and no restart');

  // 6b. the listing fails
  await SC.page.evaluate(() => Reco.clearSession());
  await SC.page.evaluate(() => {
    if (typeof Reco._runState === 'function') Reco._runState(AppState.activeRecoId).autoLoadTried = false;
  });
  await fault(true, 'list_folder_files');
  await fault(true, 'list_directories');
  await clearToasts(SC.page);
  await SC.page.evaluate(() => App.navigate('home'));
  await SC.page.evaluate(id => RecoTemplate.open(id), t4.id);
  await sleep(1500);
  toasts = await readToasts(SC.page);
  s = await uiSnapshot(SC.page);
  check(toasts.some(t => /could not read|could not list/i.test(t.msg)),
    '6.5 a failed listing is reported too, instead of looking like "no data exists"', toasts);
  check(s.hasRunState && s.runFailed === true, '6.6 a failed listing is recorded as a failure too', s);
  await fault(false, 'list_folder_files');
  await fault(false, 'list_directories');

  // 6c. a file Reco did not write: rows present, no _pk
  const rootD = makeRoot('shareD');
  const BD = await startBridge(rootD, 19506); procs.push(BD.proc);
  const SD = await openReco(browser, BD);
  const t5 = await createTemplate(SD.page, 'NoKeys');
  await SD.page.evaluate(() => AppState.flush());
  writeUploadCsv(rootD, t5.dataFolder, 6, { blankPk: true });
  await clearToasts(SD.page);
  await SD.page.evaluate(id => RecoTemplate.open(id), t5.id);
  await sleep(1800);
  toasts = await readToasts(SD.page);
  check(!toasts.some(t => t.kind === 'success' && /loaded 0 active rows/i.test(t.msg)),
    '6.7 "6 rows but none usable" is not reported as a green success', toasts);
  check(toasts.some(t => /_pk|key/i.test(t.msg) && t.kind !== 'success'),
    '6.8 ...it names the missing key column as the reason', toasts);

  /* ───── 7. an upload during an in-flight read is not clobbered ───── */
  console.log('\n[7] the user gives up and uploads: their upload must win');
  const rootE = makeRoot('shareE');
  const BE = await startBridge(rootE, 19508, ['--slow-read', '900']); procs.push(BE.proc);
  const SE = await openReco(browser, BE);
  const t6 = await createTemplate(SE.page, 'Race');
  await SE.page.evaluate(() => AppState.flush());
  writeUploadCsv(rootE, t6.dataFolder, 5, { docPrefix: 'OLD', pkPrefix: 'O' });

  await SE.page.evaluate(id => RecoTemplate.open(id), t6.id);
  await sleep(500);   // the auto-load read chain is in flight
  await SE.page.evaluate(() => {
    const tpl = AppState.recoTemplates.find(x => x.id === AppState.activeRecoId);
    Reco.ingestData(tpl, [
      { Doc: 'MINE1', Date: '01/10/2026', Amount: '10', Status: 'Open' },
      { Doc: 'MINE2', Date: '02/10/2026', Amount: '20', Status: 'Open' }
    ], ['Doc', 'Date', 'Amount', 'Status']);
  });
  await sleep(4000);  // let the slow auto-load resolve on top of it
  s = await uiSnapshot(SE.page);
  check(s.sessRows === 2 && s.docs.every(x => /^MINE/.test(x)),
    '7.1 the in-flight auto-load does not replace the rows the user just uploaded', s);
  toasts = await readToasts(SE.page);
  check(!toasts.some(t => t.kind === 'success' && /loaded 5 active rows/i.test(t.msg)),
    '7.2 ...and does not report a green success for data it discarded', toasts);

  /* ───── 8. the empty state is honest, and does not swallow the screen ───── */
  console.log('\n[8] the empty state when saved files exist');
  const rootF = makeRoot('shareF');
  const BF = await startBridge(rootF, 19510); procs.push(BF.proc);
  const SF = await openReco(browser, BF);
  const t7 = await createTemplate(SF.page, 'Cleared');
  await SF.page.evaluate(() => AppState.flush());
  writeUploadCsv(rootF, t7.dataFolder, 5);
  await SF.page.evaluate(id => RecoTemplate.open(id), t7.id);
  await waitRows(SF.page, t7.id, 5);
  await SF.page.evaluate(() => Reco.clearSession());
  await sleep(400);
  s = await uiSnapshot(SF.page);
  check(/saved file/i.test(s.emptyText || ''),
    '8.1 the empty state says saved data exists on the folder, rather than "upload a file"', s);
  check(s.sectionTabs.length > 1,
    '8.2 the section tabs still render when the grid is empty, so Manage is reachable', s);

  const beforeTabs = s.sectionTabs.join('|');
  await SF.page.evaluate(() => Reco.setSection('reports'));
  await sleep(300);
  s = await uiSnapshot(SF.page);
  check(s.sectionTabs.join('|') === beforeTabs,
    '8.3 switching to Reports on an empty grid does not blank the screen', s);

  /* ───── 9. the repaint guard still does its job (regression) ───── */
  console.log('\n[9] a slow read for one template must not paint over another');
  const rootG = makeRoot('shareG');
  const BG = await startBridge(rootG, 19512, ['--slow-read', '900']); procs.push(BG.proc);
  const SG = await openReco(browser, BG);
  const alpha = await createTemplate(SG.page, 'Alpha');
  const beta = await createTemplate(SG.page, 'Beta');
  await SG.page.evaluate(() => AppState.flush());
  writeUploadCsv(rootG, alpha.dataFolder, 4, { docPrefix: 'A', pkPrefix: 'A' });
  writeUploadCsv(rootG, beta.dataFolder, 7, { docPrefix: 'B', pkPrefix: 'B' });

  await SG.page.evaluate(id => RecoTemplate.open(id), alpha.id);
  await sleep(500);                                   // Alpha's read in flight
  await SG.page.evaluate(id => RecoTemplate.open(id), beta.id);
  await waitRows(SG.page, beta.id, 7, 30000);
  await sleep(2500);                                  // Alpha's read resolves now
  s = await uiSnapshot(SG.page);
  check(s.activeRecoId === beta.id && s.docs.every(x => /^B/.test(x)),
    '9.1 the screen still shows Beta, not Alpha\'s late-arriving rows', s);
  check(await SG.page.evaluate(id => (AppState.recoSessions[id].data || []).length === 4, alpha.id),
    '9.2 Alpha\'s rows went into Alpha\'s own session, not Beta\'s');
  await SG.page.evaluate(id => RecoTemplate.open(id), alpha.id);
  await sleep(400);
  s = await uiSnapshot(SG.page);
  check(s.sessRows === 4 && s.bodyRows > 0,
    '9.3 going back to Alpha paints its rows at once, with no second read', s);

  /* ───── 10. navigate() keeps activeRecoId honest ───── */
  console.log('\n[10] navigate(\'reco\', id) and activeRecoId cannot disagree');
  const agrees = await SG.page.evaluate(([a, b]) => {
    AppState.activeRecoId = b;
    App.navigate('reco', a);
    return { activeRecoId: AppState.activeRecoId, wanted: a };
  }, [alpha.id, beta.id]);
  check(agrees.activeRecoId === agrees.wanted,
    '10.1 navigating to a template with a param also makes it the active one', agrees);

  const allErrors = [...SA.errors, ...SB.errors, ...SC.errors, ...SD.errors, ...SE.errors, ...SF.errors, ...SG.errors];
  console.log('\npage errors: ' + JSON.stringify(allErrors));
  check(allErrors.length === 0, '10.2 no JavaScript errors across the whole run', allErrors);
} finally {
  clearTimeout(watchdog);
  await browser.close();
  killAll();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
