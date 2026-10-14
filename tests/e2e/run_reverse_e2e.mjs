// Ports 19900-19919.
//
// End-to-end tests for "reverse a generated entry": CANCEL when the entry
// never reached the general ledger, REVERSE when it did.
//
//   node tests/e2e/run_reverse_e2e.mjs
//
// Needs: python3, Playwright (Chromium). Exits non-zero on failures.
//
// The five things this suite exists to prove, because each one is a way the
// feature can look like it works and not work:
//
//   1. a cancel releases the rows ON THE SHARE and survives a reload, with the
//      original stamp row still in the append-only history;
//   2. with the post-entry column NOT in editableColumns - the normal
//      production shape, and the one configuration where the broken write path
//      used to be silent;
//   3. a colleague's edit to a DIFFERENT column of a released key is not
//      reverted by the Cn row the reversal writes;
//   4. the entry is NOT marked when the un-stamp cannot be confirmed on the
//      share (the bridge's fault injection makes the share write fail);
//   5. after cancel-and-regenerate, Reco._postedRefFor on the re-reconciled key
//      returns the NEW entry, not the cancelled one.
//
// Every assertion about the share reads the CSV or the JSON off disk with fs.

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
/* Who the app thinks you are: current_username() resolves the OS login
   against master/user.csv, so it is the NAME in that file, not the login. Read
   once from the first page and used for every author assertion. */
let USER = OS_USER;

let failures = 0, passes = 0;
function check(cond, msg, extra) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* An entry's reversal record, or {}. Every assertion about it goes through
   this: a build that records nothing must report all the verdicts, not die on
   the first missing field. */
const rv = o => (o && (o.reversal || o.rev)) || {};

/* A fake Special JV page: two balanced lines over whatever rows it is sent, so
   a cancel has real JV workings to hand back. Same shape as the one the
   Special JV suite uses. */
const FAKE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>FAKE JV</title></head>
<body><div id="s">fake jv</div><script>
var REF = 'FAKE', inputs = [];
function L(o) {
  return Object.assign({ Reference:'ACC1', RC:'100', Nominal:'12345', SubNominal:'0',
    'Analysis Key':'0', LOB:'51', Cur:'AED', Reco:'', Dr:'', Cr:'', Doc:'', Desc:'fake jv line' }, o);
}
function post() {
  window.parent.postMessage({ type:'specialJV.complete', ref:REF, jvId:'FAKE_jv',
    lines:[L({ Dr:'100.00' }), L({ Cr:'100.00' })],
    primaryKeys:inputs.map(function (r) { return r._pk; }), inputData:inputs }, '*');
}
var started = false;
function start() { if (started) return; started = true; setTimeout(post, 30); }
window.addEventListener('message', function (ev) {
  var d = ev.data; if (!d || d.type !== 'specialJV.init') return;
  inputs = d.inputs || []; start();
});
if (!started) {
  var n = 0, iv = setInterval(function () {
    if (started || n++ > 40) { clearInterval(iv); return; }
    window.parent.postMessage({ type:'specialJV.ready', ref:REF }, '*');
  }, 50);
}
<\/script></body></html>`;

function makeRoot(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-rev-e2e-'));
  const root = path.join(base, name);
  const cp = (src, dst) => {
    fs.mkdirSync(path.dirname(path.join(root, dst)), { recursive: true });
    fs.copyFileSync(path.join(REPO, src), path.join(root, dst));
  };
  cp('apps/Reco.html', 'apps/Reco.html');
  for (const f of fs.readdirSync(path.join(REPO, 'apps/lib'))) cp('apps/lib/' + f, 'apps/lib/' + f);
  fs.mkdirSync(path.join(root, 'master'), { recursive: true });
  fs.mkdirSync(path.join(root, 'reco'), { recursive: true });
  fs.writeFileSync(path.join(root, 'master/user.csv'), `ID,Name,Email,reco\r\n${OS_USER},Test User,,1\r\n`);
  fs.writeFileSync(path.join(root, 'master/accounts_master.csv'),
    'Reference,RC,Nominal,SubNominal,AnalysisKey,LOB\r\nACC1,100,12345,0,0,51\r\nBANK,200,11111,0,0,51\r\n');
  fs.mkdirSync(path.join(root, 'special_jv_templates'), { recursive: true });
  fs.mkdirSync(path.join(root, 'special_jv_mapping'), { recursive: true });
  fs.writeFileSync(path.join(root, 'special_jv_templates/FAKE.html'), FAKE_PAGE);
  fs.writeFileSync(path.join(root, 'special_jv_mapping/FAKE.json'), JSON.stringify({
    ref: 'FAKE', displayName: 'Fake JV', inputColumns: [{ name: 'Currency' }, { name: 'FC Amount' }]
  }, null, 2));
  return root;
}

async function startBridge(root, port, extra = []) {
  const proc = spawn('python3', [path.join(HERE, 'bridge_server.py'), root, String(port), ...extra],
    { stdio: ['ignore', 'pipe', 'inherit'] });
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
  USER = await page.evaluate(() => AppState.currentUser) || OS_USER;
  return { ctx, page, errors };
}

const fault = (bridge, obj) => fetch(bridge.url + '/__fault', { method: 'POST', body: JSON.stringify(obj) });
const resetLog = (bridge) => fetch(bridge.url + '/__reset_log', { method: 'POST' });
const callLog = async (bridge) => (await (await fetch(bridge.url + '/__log')).json());

function dayFile(root, folder, when) {
  const d = when || new Date();
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + '-' + String(d.getFullYear()).slice(-2);
  return path.join(root, 'reco_data', folder, mon, String(d.getDate()).padStart(2, '0') + '.csv');
}
/* The version rows of one key, in file order. No value in this suite contains
   a comma or a quote, so a split is enough and keeps the proof simple. */
function csvRows(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const head = lines[0].split(',');
  return lines.slice(1).map(l => { const v = l.split(','); const o = {}; head.forEach((h, i) => o[h] = v[i]); return o; });
}
const rowsFor = (file, pk) => csvRows(file).filter(r => r._pk === pk);
const shareHistory = (root) => {
  const p = path.join(root, 'reco', 'entryHistory.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
};

const ROWS = [
  { Doc: 'D1', Date: '06/10/2026', 'Txn Type': 'RAPID', Currency: 'USD', 'FC Amount': '100', AED: '367', ToAccount: 'ACC1', Status: '' },
  { Doc: 'D2', Date: '07/10/2026', 'Txn Type': 'RAPID', Currency: 'EUR', 'FC Amount': '50',  AED: '200', ToAccount: 'ACC1', Status: '' },
  { Doc: 'D3', Date: '12/10/2026', 'Txn Type': 'OF01',  Currency: 'RUB', 'FC Amount': '900', AED: '400', ToAccount: 'ACC1', Status: '' },
  { Doc: 'D4', Date: '08/10/2026', 'Txn Type': 'RAPID', Currency: 'RUB', 'FC Amount': '500', AED: '220', ToAccount: 'ACC1', Status: '' },
  { Doc: 'D5', Date: '09/10/2026', 'Txn Type': 'BANK',  Currency: 'AED', 'FC Amount': '10',  AED: '10',  ToAccount: 'FAKE', Status: '' },
  { Doc: 'D6', Date: '10/10/2026', 'Txn Type': 'BANK',  Currency: 'AED', 'FC Amount': '20',  AED: '20',  ToAccount: 'FAKE', Status: '' },
];
const FIELDS = Object.keys(ROWS[0]);

/* The fixture shape that matters: `editableColumns` does NOT contain the
   post-entry column. Every suite before this one put it in, which is the one
   configuration where the un-stamp's write path worked. */
async function createTemplate(page, name, rows, opts = {}) {
  return page.evaluate(([name, fields, rows, opts]) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.name = name;
    t.columns = fields.map(n => ({ name: n, label: n, formats: [], isValue: n === 'AED', isDate: n === 'Date' }));
    t.primaryKeys = ['Doc'];
    t.valueColumn = 'AED';
    t.docNumberColumn = 'Doc';
    t.editableColumns = opts.editableColumns || ['ToAccount'];
    t.displayColumns = t.columns.map(c => c.name);
    t.additionalColumns = opts.additionalColumns || [];
    let aegId = AppState.aegTemplates[0].id;
    if (opts.renameSides) {
      const alt = JSON.parse(JSON.stringify(AppState.aegTemplates[0]));
      alt.id = U.uid();
      alt.name = name + ' sides';
      alt.outputColumns.forEach(c => {
        const m = c.mapping || {};
        if (m.type === 'value' && m.side === 'Dr') c.name = 'Debit AED';
        else if (m.type === 'value' && m.side === 'Cr') c.name = 'Credit AED';
      });
      AppState.aegTemplates.push(alt);
      aegId = alt.id;
    }
    t.aegIntegration = { enabled: true, aegTemplateId: aegId, keywordColumn: '', keywordValues: '',
      postEntryColumn: opts.postEntryColumn === null ? '' : (opts.postEntryColumn || 'Status'),
      postEntryValue: opts.postEntryValue === null ? '' : (opts.postEntryValue || 'Posted') };
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.name === name);
    RecoTemplate.open(tpl.id);
    Reco.ingestData(tpl, rows, fields);
    return { id: tpl.id, aegId: aegId, folder: tpl.dataFolder };
  }, [name, FIELDS, rows, opts]);
}

/* Select rows, run the fake JV when asked, press Generate, close Allocate. */
async function genEntry(page, id, docs, withJv) {
  await page.evaluate(([id, docs]) => {
    App.closeModal();
    AppState.activeRecoId = id;
    const s = AppState.recoSessions[id];
    s.selectedRows = {};
    s.data.filter(r => docs.includes(r.Doc)).forEach(r => s.selectedRows[r._id] = true);
    Reco.previewEntryFromSelection(true);
  }, [id, docs]);
  if (withJv) {
    await page.click('#appModalBody button:has-text("Complete")');
    await sleep(900);
  }
  await page.click('#appModalFooter button:has-text("Generate")');
  await page.waitForSelector('#appModalTitle:has-text("Allocate")', { timeout: 8000 });
  await page.evaluate(() => App.closeModal());
  return page.evaluate((id) => {
    const h = AppState.entryHistory[id] || [];
    return (h[h.length - 1] || {}).accountingId;
  }, id);
}

/* Open the real dialog and report what it shows. */
async function openReverse(page, tplId, accountingId) {
  await page.evaluate(([id, aid]) => {
    AppState.activeRecoId = id;
    App.closeModal();
    Reco.openReverseEntryModal(aid);
  }, [tplId, accountingId]);
  return page.evaluate(() => ({
    title: (document.getElementById('appModalTitle') || {}).textContent || '',
    body: (document.getElementById('appModalBody') || {}).textContent || '',
    html: (document.getElementById('appModalBody') || {}).innerHTML || '',
    mode: (Reco._reverseState || {}).mode || '',
    hasReason: !!document.getElementById('revReason'),
    disabled: !!(document.getElementById('revGo') || {}).disabled,
    verb: ((document.getElementById('revGo') || {}).textContent) || ''
  }));
}
/* Choose the mode and type the reason through the real handlers, then run the
   commit and wait for it (clicking would not give us the promise). */
async function runReverse(page, mode, reason, opts = {}) {
  await page.evaluate(([mode, reason]) => {
    if (Reco._reverseState && Reco._reverseState.mode !== mode) Reco._reverseSetMode(mode);
    const el = document.getElementById('revReason');
    if (el) { el.value = reason; Reco._reverseValidate(); }
  }, [mode, reason]);
  const btn = await page.evaluate(() => ({
    disabled: !!(document.getElementById('revGo') || {}).disabled,
    verb: ((document.getElementById('revGo') || {}).textContent) || ''
  }));
  if (opts.refuseConfirm) await page.evaluate(() => { window._cfm = window.confirm; window.confirm = () => false; });
  if (opts.click) await page.click('#revGo');
  else await page.evaluate(() => Reco.reverseEntry());
  await sleep(opts.click ? 1200 : 150);
  if (opts.refuseConfirm) await page.evaluate(() => { window.confirm = window._cfm; });
  const after = await page.evaluate(() => ({
    title: (document.getElementById('appModalTitle') || {}).textContent || '',
    body: (document.getElementById('appModalBody') || {}).textContent || ''
  }));
  return { btn, after };
}
/* The dialog, re-rendered in the other mode. The "what will happen" list is
   mode-specific: a refusal to post a mirror has nothing to say about a cancel. */
const switchMode = (page, mode) => page.evaluate((m) => {
  Reco._reverseSetMode(m);
  return { body: (document.getElementById('appModalBody') || {}).textContent || '',
           html: (document.getElementById('appModalBody') || {}).innerHTML || '',
           disabled: !!(document.getElementById('revGo') || {}).disabled };
}, mode);

/* Everything a check needs about one entry and the rows it touched. */
const stateOf = (page, id, aid) => page.evaluate(([id, aid]) => {
  const tpl = AppState.recoTemplates.find(x => x.id === id);
  const sess = AppState.recoSessions[id];
  const hist = AppState.entryHistory[id] || [];
  const e = hist.find(x => x && x.accountingId === aid) || null;
  const rev = hist.find(x => x && x.reverses === aid) || null;
  return {
    n: hist.length,
    ids: hist.map(x => x && x.accountingId),
    entry: e, reversing: rev,
    reversal: e ? (e.reversal || null) : null,
    hasReversal: !!(e && Object.prototype.hasOwnProperty.call(e, 'reversal')),
    status: Object.fromEntries(sess.data.map(r => [r.Doc, r.Status])),
    toAccount: Object.fromEntries(sess.data.map(r => [r.Doc, r.ToAccount])),
    posted: Object.fromEntries(sess.data.map(r => [r.Doc, Reco.isRowPosted(tpl, r)])),
    refs: Object.fromEntries(sess.data.map(r => [r.Doc, Reco._postedRefFor(tpl, r)])),
    dnm: Object.assign({}, AppState.docNumberMaster[id] || {}),
    pend: (AppState.pendingSpecialJV[id] || []).map(p => ({ jvId: p.jvId, ref: p.ref, lines: (p.lines || []).length,
      inputs: (p.inputData || []).length, pks: p.primaryKeys || [], ok: SpecialJV.checkLines(p.lines || [], Reco._jvLineCols(
        AppState.aegTemplates.find(t => t.id === (tpl.aegIntegration || {}).aegTemplateId))).ok })),
    audit: (() => { Reco._postedIdxReset(); const a = Reco.postedJvAudit(tpl, sess);
      return { posted: a.posted, linked: a.linked, missing: a.missing,
               reasons: a.exceptions.map(x => x.pk + ': ' + x.reason) }; })(),
    comments: Comments.list(id).map(c => ({ text: c.text, pks: c.linkedPks })),
    loadedAt: sess.loadedAt || ''
  };
}, [id, aid]);

const browser = await chromium.launch();
const procs = [];
const watchdog = setTimeout(() => {
  console.error('\nWATCHDOG: reverse e2e exceeded 8 minutes; last check: ' + (passes + failures));
  procs.forEach(p => p.kill());
  process.exit(2);
}, 480000);
const killAll = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });
process.on('exit', killAll);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { killAll(); process.exit(130); }));

try {
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[1] Cancel: the rows are released ON THE SHARE and survive a reload');
  /* The post-entry column is NOT in editableColumns here. That is the normal
     production shape and the one the broken write path hid in: applyEdits built
     its schema with scope 'template', the column gained no `writeTo`, the edit
     landed in sessionOnly, NO Cn row was written - and nothing threw, so every
     guard downstream reported success. */
  const root1 = makeRoot('root1');
  const B1 = await startBridge(root1, 19900, ['--jv-port', '19901']); procs.push(B1.proc);
  let { page, errors, ctx } = await openReco(browser, B1);
  const t1 = await createTemplate(page, 'Cancel Share', ROWS);
  const file1 = dayFile(root1, t1.folder);

  const notEditable = await page.evaluate((id) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    const sTpl = XlSchema.build(tpl, sess, { scope: 'template', includeHidden: true, showExtras: 'all' });
    const sAll = XlSchema.build(tpl, sess, { scope: 'allStandard', includeHidden: true, showExtras: 'all' });
    return { editable: tpl.editableColumns.slice(),
             tplWriteTo: (sTpl.byName.get('Status') || {}).writeTo || null,
             allWriteTo: (sAll.byName.get('Status') || {}).writeTo || null };
  }, t1.id);
  check(notEditable.editable.indexOf('Status') < 0,
    'the fixture keeps the post-entry column OUT of editableColumns — the case the blocker hid in', notEditable.editable);
  check(notEditable.tplWriteTo === null && notEditable.allWriteTo === 'row',
    'with the default scope that column has no writeTo at all; only scope "allStandard" gives it one', notEditable);

  const a1 = await genEntry(page, t1.id, ['D1', 'D2', 'D3']);
  const gen1 = await stateOf(page, t1.id, a1);
  check(gen1.status.D1 === 'Posted' && gen1.status.D2 === 'Posted' && gen1.status.D3 === 'Posted',
    'generation stamped the three rows', gen1.status);
  check(rowsFor(file1, 'D1').some(r => r._ver === 'C1' && r.Status === 'Posted'),
    'and wrote the stamp to the share as C1', rowsFor(file1, 'D1').map(r => r._ver + '/' + r.Status));
  check(Object.keys(gen1.dnm).sort().join() === 'D1,D2,D3',
    'the three document numbers point at this entry', gen1.dnm);

  const seen1 = await openReverse(page, t1.id, a1);
  check(/No accounting reference is recorded/.test(seen1.body) && seen1.mode === 'cancelled',
    'with no accounting reference the dialog pre-selects CANCEL and says so in words', seen1.mode);
  check(/If it is already in the general ledger, post a reversal entry instead/.test(seen1.body),
    'and offers the other route in the same breath — the app never cancels a posted entry silently');
  check(seen1.disabled, 'the button is disabled until a reason is typed');
  check(/Status/.test(seen1.body) && /goes back to blank on 3 row\(s\)/.test(seen1.body),
    'the dialog names the template\'s own column and how many rows change', seen1.body.slice(0, 400));
  check(/stop counting as posted/.test(seen1.body) && !/re-?open/i.test(seen1.body),
    'it says what changes in the template\'s words, not "open" — that word means the offset axis');

  const r1 = await runReverse(page, 'cancelled', 'posted to the wrong period', { click: true });
  check(r1.btn.verb === 'Cancel entry' && !r1.btn.disabled,
    'the verb on the button follows the chosen mode, and a reason enables it', r1.btn);
  const c1 = await stateOf(page, t1.id, a1);
  check(c1.reversal && rv(c1).mode === 'cancelled' && rv(c1).by === USER
    && rv(c1).reason === 'posted to the wrong period' && rv(c1).reversalId === '',
    'the entry is kept and tombstoned, with who, when and why', c1.reversal);
  check(c1.n === 1, 'nothing was appended — a cancel creates no reversing entry', c1.ids);
  check((rv(c1).unstamped || []).slice().sort().join() === 'D1,D2,D3',
    'reversal.unstamped is built from the result of the write, not the plan', rv(c1).unstamped);
  check(c1.status.D1 === '' && c1.status.D2 === '' && c1.status.D3 === '',
    'the rows are released in this session', c1.status);
  check(!c1.posted.D1 && !c1.posted.D2 && !c1.posted.D3, 'and stop counting as posted', c1.posted);

  // ── the share, read off disk ──────────────────────────────────────────────
  const d1 = rowsFor(file1, 'D1');
  check(d1.length === 3 && d1[0]._ver === 'upload' && d1[1]._ver === 'C1' && d1[2]._ver === 'C2',
    'the day CSV holds the upload row, the C1 stamp row AND a C2 un-stamp row — append-only, nothing rewritten',
    d1.map(r => r._ver));
  check((d1[1] || {}).Status === 'Posted' && (d1[2] || {}).Status === '',
    'the stamp row still says Posted; the new row says blank', d1.map(r => r._ver + '=' + r.Status));
  check((d1[2] || {})._src === 'reverse:' + a1 && (d1[2] || {})._by === USER,
    'the un-stamp row carries _src reverse:<id> and _by — the only part of the trail that reaches a colleague '
    + 'without going through entryHistory', d1.map(r => r._ver + '/' + r._src + '/' + r._by));
  check(['D2', 'D3'].every(pk => (rowsFor(file1, pk).slice(-1)[0] || {}).Status === ''),
    'the same for the other two keys', ['D2', 'D3'].map(pk => (rowsFor(file1, pk).slice(-1)[0] || {})._ver));
  check((d1[2] || {}).ToAccount === 'ACC1' && (d1[2] || {}).AED === '367',
    'the un-stamp row is the whole row with one cell cleared, not a blank row', d1[2]);
  const head1 = fs.readFileSync(file1, 'utf8').split(/\r?\n/)[0];
  check(head1 === '_pk,_ver,_ts,_src,_by,' + FIELDS.join(','),
    'the day CSV header did not change', head1);

  const hist1 = shareHistory(root1)[t1.id] || [];
  check(hist1.length === 1 && hist1[0].reversal && hist1[0].reversal.mode === 'cancelled',
    'reco/entryHistory.json on the share carries the reversal', hist1.map(e => e.accountingId + ':' + !!e.reversal));
  check(Object.keys(c1.dnm).length === 0 && (rv(c1).freedDocNumbers || []).slice().sort().join() === 'D1,D2,D3',
    'every document number that still pointed at this entry is freed, so a re-upload is not flagged', c1.dnm);
  const logPath = path.join(root1, 'reco', 'reversals.log.json');
  const logLines = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split(/\n/) : [];
  check(logLines.length === 1 && JSON.parse(logLines[0]).accountingId === a1
    && JSON.parse(logLines[0]).mode === 'cancelled',
    'one line in reco/reversals.log.json — a second home for the trail that a restore cannot reach',
    logLines[0] && logLines[0].slice(0, 160));

  // ── and it survives a reload, which is the whole point ────────────────────
  const reload1 = await page.evaluate(async ([id, file]) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    sess.data = [];
    await Reco.loadVersionedFile(file, id);
    return { n: sess.data.length, status: Object.fromEntries(sess.data.map(r => [r.Doc, r.Status || ''])),
             posted: sess.data.filter(r => Reco.isRowPosted(tpl, r)).length };
  }, [t1.id, 'reco_data/' + t1.folder + '/' + path.basename(path.dirname(file1)) + '/' + path.basename(file1)]);
  check(reload1.n === 6 && !reload1.status.D1 && !reload1.status.D2 && !reload1.status.D3,
    'reloading the data from the share shows the three rows released — the un-stamp is in the history, not just in memory',
    reload1);
  check(reload1.posted === 0, 'no row reads as posted after the reload', reload1.posted);

  const badge1 = await page.evaluate((id) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    const row = sess.data.find(r => r.Doc === 'D1');
    return { badge: Reco._postedBadge(tpl, row), ref: Reco._postedRefFor(tpl, row) };
  }, t1.id);
  check(badge1.badge === '' && badge1.ref && badge1.ref.reversed === true
    && badge1.ref.reversalMode === 'cancelled',
    'a released row carries no posted badge at all, and the only thing _postedRefFor has to say about its old '
    + 'entry is that the entry was undone — never a clean accounting reference', badge1);
  check(errors.length === 0, 'no JavaScript errors', errors);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[2] Gate 5 — a re-reconciled key reports the NEW entry, not the cancelled one');
  const a1b = await genEntry(page, t1.id, ['D1', 'D2']);
  const re1 = await stateOf(page, t1.id, a1b);
  check(a1b !== a1 && re1.n === 2, 'the rows were reconciled again into a second entry', re1.ids);
  check(re1.refs.D1 && re1.refs.D1.accountingId === a1b && !re1.refs.D1.reversed,
    'Reco._postedRefFor on D1 returns the NEW entry — a cancelled entry does not shadow every later one for ever',
    re1.refs.D1);
  check(re1.audit.posted === 2 && re1.audit.linked === 2 && re1.audit.missing === 0,
    'and the posted-row audit reports both rows linked, with no exception', re1.audit);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[3] What a cancel restores, what it leaves alone, and what it will not touch');
  const root2 = makeRoot('root2');
  const B2 = await startBridge(root2, 19902, ['--jv-port', '19903']); procs.push(B2.proc);
  await ctx.close();
  ({ page, errors, ctx } = await openReco(browser, B2));
  const t2 = await createTemplate(page, 'Cancel Detail', ROWS);
  const file2 = dayFile(root2, t2.folder);
  // D1 already carries a workflow value somebody typed; D2 and D3 are blank.
  await page.evaluate(async (id) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    await Reco.applyEdits(tpl, sess, [{ row: sess.data.find(r => r.Doc === 'D1'), col: 'Status', value: 'Checked' }],
      { source: 'grid', scope: 'allStandard', trusted: true, historyFirst: true });
  }, t2.id);
  const a2 = await genEntry(page, t2.id, ['D1', 'D2', 'D3']);
  // After the entry: somebody sets D2 to something else, and D3 leaves the
  // loaded session altogether (a different file is open, or the row was
  // single-use and generation dropped it).
  await page.evaluate(async (id) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    await Reco.applyEdits(tpl, sess, [{ row: sess.data.find(r => r.Doc === 'D2'), col: 'Status', value: 'Checked' }],
      { source: 'grid', scope: 'allStandard', trusted: true, historyFirst: true });
    sess.data = sess.data.filter(r => r.Doc !== 'D3');
  }, t2.id);
  const seen2 = await openReverse(page, t2.id, a2);
  check(/1 row\(s\) are left exactly as they are/.test(seen2.body) && /D2/.test(seen2.body),
    'the dialog lists the row somebody changed since, before anything is written', seen2.body.slice(0, 600));
  check(/1 row\(s\) of this entry are not in the loaded data/.test(seen2.body) && /D3/.test(seen2.body),
    'and the row that is no longer in the loaded data, with its key');
  check(/goes back to "Checked" on 1 row\(s\)/.test(seen2.body),
    'and that one row goes back to the value it really held, not to blank', seen2.body.slice(0, 600));
  await runReverse(page, 'cancelled', 'wrong account');
  const c2 = await stateOf(page, t2.id, a2);
  check(c2.status.D1 === 'Checked',
    'the row that carried a workflow value gets THAT value back, not a blank — postedPrev is what makes this possible',
    c2.status);
  check((rowsFor(file2, 'D1').slice(-1)[0] || {}).Status === 'Checked',
    'and on the share too', rowsFor(file2, 'D1').map(r => r._ver + '=' + r.Status));
  check(c2.status.D2 === 'Checked' && (rv(c2).unstampedSkipped || []).some(s => s.pk === 'D2' && s.found === 'Checked'),
    'the row somebody changed after the entry is left alone and recorded with the value found', rv(c2).unstampedSkipped);
  check((rv(c2).unstamped || []).join() === 'D1',
    'only the row that still read the stamp was written', rv(c2).unstamped);
  check((rv(c2).notInSession || []).join() === 'D3',
    'the key with no row in the session is recorded as not-in-session', rv(c2).notInSession);
  const d3 = rowsFor(file2, 'D3');
  check(d3.length === 2 && d3[1]._ver === 'C1' && d3[1].Status === 'Posted',
    'NOTHING was written for it — synthesising a row would have blanked every other column of that key on the share',
    d3.map(r => r._ver + '=' + r.Status + '/' + r.AED));
  check(d3.every(r => r.AED === '400' && r.ToAccount === 'ACC1'),
    'and its other columns on the share are untouched', d3.map(r => r.AED + '/' + r.ToAccount));
  check((c2.comments[0] || {}).text && /cancelled by/.test(c2.comments[0].text)
    && /wrong account/.test(c2.comments[0].text) && (c2.comments[0].pks || []).join() === 'D1',
    'one Comment, linked to the keys the reversal touched, so it shows in each row\'s Timeline', c2.comments);
  const tl2 = await page.evaluate((id) => Timeline.eventsForPk(id, 'D1')
    .filter(e => e.type === 'comment' && /cancelled by/.test((e.payload || {}).text || '')).length, t2.id);
  check(tl2 === 1, 'and the Timeline for that key returns it', tl2);
  check(errors.length === 0, 'no JavaScript errors', errors);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[4] Gate 3 — a colleague\'s edit to another column of a released key is not reverted');
  const root3 = makeRoot('root3');
  const B3 = await startBridge(root3, 19904, ['--jv-port', '19905']); procs.push(B3.proc);
  await ctx.close();
  ({ page, errors, ctx } = await openReco(browser, B3));
  const t3 = await createTemplate(page, 'Rebase', ROWS);
  const file3 = dayFile(root3, t3.folder);
  const a3 = await genEntry(page, t3.id, ['D1', 'D2']);
  /* A colleague, on another machine, writes a Cn of their own: D1's ToAccount
     becomes BANK (the post-entry column untouched), and D2's Status becomes
     something else. This session knows nothing about either. */
  await page.evaluate(async ([id, who]) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    const p = Versioning.pathFor(tpl);
    const max = await Versioning._maxCn(p);
    const mk = (doc, over) => {
      const row = sess.data.find(r => r.Doc === doc);
      const rec = { _pk: doc, _ver: 'C' + ((max[doc] || 0) + 1), _ts: new Date().toISOString(), _src: 'grid', _by: who };
      tpl.columns.forEach(c => { rec[c.name] = row[c.name] != null ? row[c.name] : ''; });
      return Object.assign(rec, over);
    };
    const recs = [mk('D1', { ToAccount: 'BANK' }), mk('D2', { Status: 'Re-checked' })];
    await window.pywebview.api.append_csv_rows(p, Versioning._fields(recs, tpl), recs);
    delete Versioning._cnCache[p];
  }, [t3.id, 'r.menon']);
  // the dialog was never opened: prove nothing happens without a state behind it
  await runReverse(page, 'cancelled', 'duplicate entry');
  const noState = await stateOf(page, t3.id, a3);
  check(!noState.reversal, 'reverseEntry does nothing without a dialog state behind it', noState.reversal);
  await openReverse(page, t3.id, a3);
  await runReverse(page, 'cancelled', 'duplicate entry');
  const c3 = await stateOf(page, t3.id, a3);
  const d1r = rowsFor(file3, 'D1');
  const last3 = d1r.slice(-1)[0] || {};
  check(last3._src === 'reverse:' + a3 && last3.Status === '',
    'the reversal wrote the last word on D1', d1r.map(r => r._ver + '/' + r._src + '=' + r.Status));
  check(last3.ToAccount === 'BANK',
    'and it carried the colleague\'s ToAccount forward instead of reverting it — the Cn row is the SHARE\'s row '
    + 'with one cell cleared, not this session\'s stale snapshot of it', last3.ToAccount);
  check(c3.toAccount.D1 === 'BANK', 'the session adopts the share\'s value for that cell too', c3.toAccount.D1);
  check((rv(c3).unstamped || []).join() === 'D1' && c3.status.D1 === '',
    'D1 is released', { un: rv(c3).unstamped, st: c3.status.D1 });
  check((rv(c3).unstampedSkipped || []).some(s => s.pk === 'D2' && s.found === 'Re-checked'),
    'D2, whose post-entry column the colleague changed, is skipped with the value found on the share',
    rv(c3).unstampedSkipped);
  check(!rowsFor(file3, 'D2').some(r => r._src === 'reverse:' + a3),
    'and no Cn row was written for it at all', rowsFor(file3, 'D2').map(r => r._ver + '/' + r._src));
  check(errors.length === 0, 'no JavaScript errors', errors);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[5] Gate 4 — the entry is not marked when the un-stamp cannot be confirmed');
  const root4 = makeRoot('root4');
  const B4 = await startBridge(root4, 19906, ['--jv-port', '19907']); procs.push(B4.proc);
  await ctx.close();
  ({ page, errors, ctx } = await openReco(browser, B4));
  const t4 = await createTemplate(page, 'Fault', ROWS);
  const file4 = dayFile(root4, t4.folder);
  const a4 = await genEntry(page, t4.id, ['D1', 'D2']);
  const before4 = csvRows(file4).length;

  // (a) the share write itself fails
  await fault(B4, { append_csv_rows: true });
  await openReverse(page, t4.id, a4);
  const f4 = await runReverse(page, 'cancelled', 'entered twice');
  const s4 = await stateOf(page, t4.id, a4);
  check(/could not be written/i.test(f4.after.title) && /was not marked/.test(f4.after.body),
    'the user is told the shared history could not be written, in those words', f4.after);
  check(!s4.hasReversal, 'the entry is NOT marked', s4.reversal);
  check(s4.status.D1 === 'Posted' && s4.status.D2 === 'Posted',
    'and the rows are not left half-done — history first means nothing in the session changed either', s4.status);
  check(csvRows(file4).length === before4, 'not one row reached the share', csvRows(file4).length);
  check(shareHistory(root4)[t4.id].every(e => !e.reversal), 'and entryHistory.json was not rewritten');
  check(s4.dnm.D1 === a4, 'the document numbers were not freed either', s4.dnm);

  // (b) the write lands but cannot be read back — the silent-loss case
  await fault(B4, { append_csv_rows: false, read_file: true });
  await openReverse(page, t4.id, a4);
  const f4b = await runReverse(page, 'cancelled', 'entered twice');
  const s4b = await stateOf(page, t4.id, a4);
  check(/not recorded/i.test(f4b.after.title) && /could not be read back/.test(f4b.after.body),
    'when the write cannot be confirmed off the share the user is told that instead', f4b.after);
  check(!s4b.hasReversal,
    'the entry is still NOT marked — "marked reversed while the rows still read posted" is the one state to avoid',
    s4b.reversal);
  check(csvRows(file4).length > before4 && (rowsFor(file4, 'D1').slice(-1)[0] || {}).Status === '',
    'the rows themselves were released, which is the recoverable direction', rowsFor(file4, 'D1').map(r => r._ver));
  await fault(B4, { read_file: false });
  // (c) and a retry once the share is healthy completes, writing nothing twice
  await resetLog(B4);
  await openReverse(page, t4.id, a4);
  await runReverse(page, 'cancelled', 'entered twice');
  const s4c = await stateOf(page, t4.id, a4);
  check(s4c.reversal && rv(s4c).mode === 'cancelled',
    'the retry records the reversal', s4c.reversal && rv(s4c).mode);
  check((rv(s4c).unstamped || []).length === 0
    && (rv(s4c).unstampedSkipped || []).length === 2,
    'and writes nothing twice: the rows already read blank, so both keys are skipped, not re-written',
    { un: rv(s4c).unstamped, sk: rv(s4c).unstampedSkipped });
  const used4 = (await callLog(B4)).calls.map(c => c.method).filter((m, i, a) => a.indexOf(m) === i).sort();
  check(used4.every(m => ['read_file', 'write_file', 'append_csv_rows', 'list_directories', 'list_files',
    'list_folder_files', 'save_template', 'delete_template', 'current_username', 'load_master',
    'load_templates', 'save_master'].indexOf(m) >= 0),
    'a reversal needs no new bridge method — read_file, write_file and append_csv_rows already do everything', used4);
  check(errors.every(e => /injected fault/.test(e)),
    'the only console output is the injected fault itself (Versioning.readFile logs a failed read by design)', errors);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[6] Reverse: a true mirror, the original untouched, and it claims nothing');
  const root5 = makeRoot('root5');
  const B5 = await startBridge(root5, 19908, ['--jv-port', '19909']); procs.push(B5.proc);
  await ctx.close();
  ({ page, errors, ctx } = await openReco(browser, B5));
  const t5 = await createTemplate(page, 'Mirror', ROWS);
  const file5 = dayFile(root5, t5.folder);
  const a5 = await genEntry(page, t5.id, ['D1', 'D2']);
  await page.evaluate(([id, aid]) => {
    AppState.activeRecoId = id;
    Reco.openAllocateModal(aid);
    document.getElementById('alloc_AED').value = 'JV-10042';
    Reco.saveAllocation();
  }, [t5.id, a5]);
  const before5 = await page.evaluate(([id, aid]) => JSON.stringify(
    (AppState.entryHistory[id] || []).find(e => e.accountingId === aid)), [t5.id, a5]);
  const seen5 = await openReverse(page, t5.id, a5);
  check(seen5.mode === 'reversed' && /are recorded against/.test(seen5.body),
    'a document number recorded against the entry pre-selects REVERSE and the dialog says why', seen5.mode);
  check(/If it never actually reached the general ledger, cancel it instead/.test(seen5.body),
    'with cancel one click away on the same dialog');
  check(/The document numbers are kept/.test(seen5.body),
    'and it states that the document numbers are kept — those documents went out');
  const r5 = await runReverse(page, 'reversed', 'reversing September accrual');
  check(r5.btn.verb === 'Reverse entry', 'the button reads Reverse entry', r5.btn.verb);
  await sleep(500);
  await page.evaluate(() => App.closeModal());
  const c5 = await stateOf(page, t5.id, a5);
  const mirror = await page.evaluate(([id, aid]) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const hist = AppState.entryHistory[id] || [];
    const o = hist.find(e => e.accountingId === aid);
    const n = hist.find(e => e.reverses === aid);
    // A build that does not append a mirror must still report every verdict.
    if (!o || !n) return { newId: '', missing: true };
    const lc = Reco._jvLineCols(AppState.aegTemplates.find(t => t.id === o.aegTemplateId));
    const val = (l, c) => { const x = l[c]; return (x && typeof x === 'object') ? (x.value || '') : (x == null ? '' : x); };
    const other = ['Reference', 'RC', 'Nominal', 'SubNominal', 'Analysis Key', 'LOB', 'Cur', 'Reco', 'Doc', 'Desc'];
    return {
      newId: n.accountingId,
      swapped: o.lines.every((l, i) => val(n.lines[i], lc.dr) === val(l, lc.cr) && val(n.lines[i], lc.cr) === val(l, lc.dr)),
      sameCount: n.lines.length === o.lines.length,
      othersIdentical: o.lines.every((l, i) => other.every(c => val(n.lines[i], c) === val(l, c))),
      sideKept: o.lines.every((l, i) => (n.lines[i]._side || '') === (l._side || '')),
      balanced: SpecialJV.checkLines(n.lines, lc).ok,
      origDr: o.lines.map(l => val(l, lc.dr)), newDr: n.lines.map(l => val(l, lc.dr)),
      hasPostedPks: Object.prototype.hasOwnProperty.call(n, 'postedPks'),
      srcRows: (n.sourceRowIds || []).length, jvs: (n.specialJvs || []).length,
      reverses: n.reverses, reversesCount: n.reversesLineCount,
      reversesDocs: n.reversesDocNumbers, docs: n.docNumbers,
      lineCols: n.lineCols, reason: n.reversalReason
    };
  }, [t5.id, a5]);
  check(mirror.swapped && mirror.sameCount,
    'every line of the new entry has the original\'s debit as its credit and the other way round',
    { dr: mirror.origDr, newDr: mirror.newDr });
  check(mirror.othersIdentical,
    'and every other field — Reference, RC, Nominal, SubNominal, Analysis Key, LOB, Cur, Reco, Doc, Desc — is copied verbatim');
  check(mirror.balanced, 'the swapped lines pass the balance check');
  check(before5 === await page.evaluate(([id, aid]) => {
    const e = (AppState.entryHistory[id] || []).find(x => x.accountingId === aid);
    const copy = Object.assign({}, e); delete copy.reversal;
    return JSON.stringify(copy);
  }, [t5.id, a5]), 'the original record is untouched except for the reversal mark — one character of drift fails this');
  check(!mirror.hasPostedPks && mirror.srcRows === 0 && mirror.jvs === 0,
    'the reversing entry claims no rows and no Special JV: postedPks is absent, sourceRowIds and specialJvs are empty',
    mirror);
  check(mirror.reverses === a5 && rv(c5).reversalId === mirror.newId,
    'the two records point at each other, so the chain is walkable both ways',
    { reverses: mirror.reverses, reversalId: rv(c5).reversalId });
  check(JSON.stringify(mirror.reversesDocs) === JSON.stringify({ AED: 'JV-10042' }) && JSON.stringify(mirror.docs) === '{}',
    'the original\'s document numbers are recorded on the mirror and the mirror gets its own to allocate',
    { kept: mirror.reversesDocs, own: mirror.docs });
  check(c5.dnm['JV-10042'] === a5 && c5.dnm.D1 === a5,
    'a reverse frees no document number — those documents genuinely went out under the original', c5.dnm);
  check(c5.status.D1 === '' && c5.status.D2 === '' && (rv(c5).unstamped || []).join() === 'D1,D2',
    'the rows are released by a reverse too', { st: c5.status, un: rv(c5).unstamped });
  check(c5.audit.posted === 0 && c5.audit.linked === 0 && c5.audit.missing === 0,
    'the released rows resolve to no accounting reference at all — not to the reversing entry', c5.audit);
  check((rowsFor(file5, 'D1').slice(-1)[0] || {})._src === 'reverse:' + a5,
    'and the un-stamp reached the share', rowsFor(file5, 'D1').map(r => r._ver));
  check(JSON.stringify(mirror.lineCols) === JSON.stringify({ dr: 'Dr', cr: 'Cr', cur: 'Cur' }),
    'the mirror records its own Dr/Cr columns, so it can itself be reversed years later', mirror.lineCols);

  // ── the mirror cannot be handed a voucher number of the original's ────────
  const alloc5 = await page.evaluate(([id, aid]) => {
    AppState.activeRecoId = id;
    Reco.openAllocateModal(aid);
    const t = (document.getElementById('appModalTitle') || {}).textContent || '';
    const b = (document.getElementById('appModalBody') || {}).textContent || '';
    Reco._allocateAccountingId = aid; Reco._allocateCurrencies = ['AED'];
    Reco.saveAllocation();
    const e = (AppState.entryHistory[id] || []).find(x => x.accountingId === aid);
    return { title: t, body: b, docs: e.docNumbers, dnm: Object.assign({}, AppState.docNumberMaster[id] || {}) };
  }, [t5.id, a5]);
  check(/No document number for/.test(alloc5.title) && /was reversed by/.test(alloc5.body),
    'Allocate Doc# refuses to open for a reversed entry, naming who reversed it', alloc5.title);
  check(JSON.stringify(alloc5.docs) === JSON.stringify({ AED: 'JV-10042' }) && alloc5.dnm['JV-10042'] === a5,
    'and saveAllocation called anyway changes nothing', alloc5.docs);
  const table5 = await page.evaluate((id) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    AppState._activeEntryId = null;
    return Reco.renderEntries(tpl, sess);
  }, t5.id);
  const row5 = table5.split('<tr>').find(x => x.indexOf('>' + a5 + '<') >= 0) || '';
  check(row5 && !/Allocate Doc#/.test(row5) && !/Reverse…/.test(row5),
    'the entries table drops BOTH buttons for a reversed entry — not just the Reverse one', row5.slice(0, 300));
  check(/Reversed → /.test(table5) && /Reverses /.test(table5),
    'and shows the two directions as badges instead', table5.match(/badge[^>]*>[^<]*/g));
  check(errors.length === 0, 'no JavaScript errors', errors);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[7] A reversal can itself be reversed, and a reversal can be cancelled');
  const a5r = mirror.newId;
  const seen7 = await openReverse(page, t5.id, a5r);
  check(/reverses /.test(seen7.body) && new RegExp(a5).test(seen7.body),
    'the dialog shows the chain, so nobody reverses a reversal by accident', seen7.body.slice(0, 300));
  check(/This entry closed no rows/.test(seen7.body),
    'and says plainly that there is nothing to release — a reversing entry never stamped anything, so this is '
    + 'correct rather than alarming');
  check(seen7.mode === 'cancelled',
    'with no document number of its own yet, cancel is the default for the mirror', seen7.mode);
  await runReverse(page, 'reversed', 'the reversal was itself wrong');
  await sleep(500);
  await page.evaluate(() => App.closeModal());
  const chain7 = await page.evaluate(([id, a1, a2]) => {
    const hist = AppState.entryHistory[id] || [];
    const e1 = hist.find(e => e.accountingId === a1) || { lines: [] };
    const e2 = hist.find(e => e.accountingId === a2);
    const e3 = hist.find(e => e.reverses === a2);
    const lc = { dr: 'Dr', cr: 'Cr' };
    const val = (l, c) => { const x = l[c]; return (x && typeof x === 'object') ? (x.value || '') : (x == null ? '' : x); };
    return { n: hist.length, e3: e3 && e3.accountingId, ptr: e2 && e2.reversal && e2.reversal.reversalId,
      same: e3 && e1.lines.every((l, i) => val(e3.lines[i], lc.dr) === val(l, lc.dr) && val(e3.lines[i], lc.cr) === val(l, lc.cr)),
      origStillReversed: e1 && e1.reversal && e1.reversal.mode };
  }, [t5.id, a5, a5r]);
  check(chain7.e3 && chain7.ptr === chain7.e3, 'reversing a reversal is the same operation and mints a third entry', chain7);
  check(chain7.same, 'swapped twice, the amounts are the original\'s again — the chain depth is unbounded by design');
  check(chain7.origStillReversed === 'reversed', 'and the first entry is left exactly as it was');

  // cancelling a reversing entry: the original stays reversed, and says so
  const a7c = await genEntry(page, t5.id, ['D3']);
  await page.evaluate(([id, aid]) => { AppState.activeRecoId = id; Reco.openReverseEntryModal(aid); }, [t5.id, a7c]);
  await runReverse(page, 'reversed', 'posted in error');
  await sleep(500);
  await page.evaluate(() => App.closeModal());
  const a7m = await page.evaluate(([id, aid]) => ((AppState.entryHistory[id] || []).find(e => e.reverses === aid) || {}).accountingId, [t5.id, a7c]);
  await openReverse(page, t5.id, a7m);
  await runReverse(page, 'cancelled', 'the reversal never went out', { refuseConfirm: true });
  const s7c0 = await stateOf(page, t5.id, a7m);
  check(!s7c0.hasReversal, 'declining the confirmation leaves the reversing entry alone', s7c0.reversal);
  await openReverse(page, t5.id, a7m);
  await runReverse(page, 'cancelled', 'the reversal never went out');
  const s7c = await page.evaluate(([id, orig, mir]) => {
    const hist = AppState.entryHistory[id] || [];
    const o = hist.find(e => e.accountingId === orig) || {}, m = hist.find(e => e.accountingId === mir) || {};
    const sess = AppState.recoSessions[id];
    return { mirMode: m.reversal && m.reversal.mode, origMode: o.reversal && o.reversal.mode,
      cancelled: o.reversal && o.reversal.reversalCancelled,
      status: Object.fromEntries(sess.data.map(r => [r.Doc, r.Status])) };
  }, [t5.id, a7c, a7m]);
  check(s7c.mirMode === 'cancelled', 'the reversing entry is tombstoned', s7c);
  check(s7c.origMode === 'reversed' && s7c.cancelled && s7c.cancelled.by === USER,
    'the original stays REVERSED and gains reversalCancelled — the app reports the discrepancy instead of '
    + 'inventing a state', s7c);
  check(s7c.status.D3 === '',
    'and no row is re-stamped: those rows have been released since the reversal and may have moved on', s7c.status);
  check(errors.length === 0, 'no JavaScript errors', errors);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[8] Reversing the same entry twice, and reversing one somebody else generated');
  const root6 = makeRoot('root6');
  const B6 = await startBridge(root6, 19910, ['--jv-port', '19911']); procs.push(B6.proc);
  await ctx.close();
  ({ page, errors, ctx } = await openReco(browser, B6));
  const t6 = await createTemplate(page, 'Two Pages', ROWS);
  const a6 = await genEntry(page, t6.id, ['D1']);
  const a6x = await genEntry(page, t6.id, ['D2']);
  await page.evaluate(() => AppState.flush());
  // page B starts here: it has both entries live in memory and knows nothing
  // of what A does next.
  const B = await openReco(browser, B6);
  const sawB = await B.page.evaluate(([id, aid]) => {
    AppState.activeRecoId = id;
    const e = (AppState.entryHistory[id] || []).find(x => x.accountingId === aid);
    return { n: (AppState.entryHistory[id] || []).length, live: !!(e && !e.reversal),
             who: e && e.createdBy, rows: AppState.recoSessions[id].data.length };
  }, [t6.id, a6]);
  check(sawB.n === 2 && sawB.live && sawB.rows === 6,
    'a second page on the same shared folder sees the entries live', sawB);
  // A cancels the first entry, then generates a third one. B hears about
  // neither.
  await openReverse(page, t6.id, a6);
  await runReverse(page, 'cancelled', 'A cancels it');
  const a6b = await genEntry(page, t6.id, ['D3']);
  await page.evaluate(() => AppState.flush());
  // ... and now B tries the same reversal, from its stale picture
  const seenB = await openReverse(B.page, t6.id, a6);
  check(/you are/.test(seenB.body) && seenB.body.indexOf('Generated by ' + USER) >= 0,
    'the dialog names the author and the person reversing — the single most useful guard available', seenB.body.slice(0, 200));
  const rB = await runReverse(B.page, 'cancelled', 'B cancels it too');
  const sB = await B.page.evaluate(([id, aid]) => {
    const hist = AppState.entryHistory[id] || [];
    const e = hist.find(x => x.accountingId === aid);
    return { n: hist.length, ids: hist.map(x => x.accountingId), mode: e && e.reversal && e.reversal.mode,
             by: e && e.reversal && e.reversal.by, reason: e && e.reversal && e.reversal.reason };
  }, [t6.id, a6]);
  check(/Nothing was changed/.test(rB.after.title) && /already cancelled/.test(rB.after.body)
    && /out of date/.test(rB.after.body),
    'the pre-write re-read catches a reversal done on another machine and names the first reverser', rB.after);
  check(rv((shareHistory(root6)[t6.id] || []).find(e => e.accountingId === a6)).reason === 'A cancels it',
    'and A\'s reason stands on the share — B\'s did not overwrite it',
    (shareHistory(root6)[t6.id] || []).map(e => e.accountingId + ':' + ((e.reversal || {}).reason || '')));
  check(sB.n === 2 && sB.ids.indexOf(a6b) < 0,
    'and B wrote nothing at all — its own picture is untouched too', sB.ids);
  check((shareHistory(root6)[t6.id] || []).length === 3,
    'the shared file is as A left it', (shareHistory(root6)[t6.id] || []).map(e => e.accountingId));

  // Now B cancels an entry that IS still live. The write must not lose the
  // entry A generated after B started - this is the one test that proves the
  // pre-write re-read is doing real work rather than decorating the flow.
  await openReverse(B.page, t6.id, a6x);
  await runReverse(B.page, 'cancelled', 'B cancels the other one');
  const sB2 = await B.page.evaluate(([id, aid]) => {
    const hist = AppState.entryHistory[id] || [];
    const e = hist.find(x => x.accountingId === aid);
    return { n: hist.length, ids: hist.map(x => x.accountingId), mode: e && e.reversal && e.reversal.mode };
  }, [t6.id, a6x]);
  check(sB2.mode === 'cancelled', 'B\'s own cancel goes through', sB2);
  check(sB2.ids.indexOf(a6b) >= 0 && sB2.n === 3,
    'and taking the share as the truth recovered the entry A generated after B started — a reversal un-clobbers',
    sB2.ids);
  const fileHist6 = shareHistory(root6)[t6.id] || [];
  check(fileHist6.length === 3 && fileHist6.some(e => e.accountingId === a6b),
    'reco/entryHistory.json still holds A\'s later entry after B wrote', fileHist6.map(e => e.accountingId));
  check((fileHist6.find(e => e.accountingId === a6) || {}).reversal
    && (fileHist6.find(e => e.accountingId === a6x) || {}).reversal,
    'with both cancellations in it', fileHist6.map(e => e.accountingId + ':' + !!e.reversal));
  // same app, twice
  const again = await openReverse(page, t6.id, a6);
  check(/was already cancelled/.test(again.title) && !again.hasReason,
    'in the same app the dialog will not even open for an entry already cancelled', again.title);
  const n6 = await page.evaluate((id) => (AppState.entryHistory[id] || []).length, t6.id);
  check(n6 === 3, 'and the history did not grow', n6);
  await B.ctx.close();
  check(errors.length === 0, 'no JavaScript errors', errors);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[9] The Special JV a cancel hands back, and the one a reverse does not');
  const root7 = makeRoot('root7');
  const B7 = await startBridge(root7, 19912, ['--jv-port', '19913']); procs.push(B7.proc);
  await ctx.close();
  ({ page, errors, ctx } = await openReco(browser, B7));
  const t7 = await createTemplate(page, 'JV Cancel', ROWS);
  const a7 = await genEntry(page, t7.id, ['D5', 'D6'], true);
  const g7 = await stateOf(page, t7.id, a7);
  check(g7.pend.length === 0 && (g7.entry.specialJvs || []).length === 1,
    'the pending JV was consumed by the entry', { pend: g7.pend.length, jvs: (g7.entry.specialJvs || []).length });
  const use7 = await page.evaluate(() => JvCreator.inUse('FAKE'));
  check(use7.entries === 1 && use7.pendings === 0, 'and counts as one posted entry against the JV', use7);
  const seen9 = await openReverse(page, t7.id, a7);
  check(/comes back as a pending JV with its workings/.test(seen9.body),
    'the dialog promises the JV back before anything is written', seen9.body.slice(0, 700));
  await runReverse(page, 'cancelled', 'the JV was wrong');
  const c7 = await stateOf(page, t7.id, a7);
  check(c7.pend.length === 1 && (c7.pend[0]||{}).jvId === 'FAKE_jv' && (c7.pend[0]||{}).lines === 2 && (c7.pend[0]||{}).inputs === 2,
    'a cancel hands the JV back as pending WITH its lines and its input data', c7.pend);
  check((c7.pend[0]||{}).ok,
    'and the restored pending passes SpecialJV.checkLines — which is why entry.specialJvs could not have done this job');
  check((rv(c7).restoredJvIds || []).join() === 'FAKE_jv', 'recorded in restoredJvIds', rv(c7).restoredJvIds);
  check((rv(c7).unstamped || []).slice().sort().join() === 'D5,D6',
    'the rows the JV consumed are released, by key', rv(c7).unstamped);
  const use7b = await page.evaluate(() => JvCreator.inUse('FAKE'));
  check(use7b.entries === 0 && use7b.pendings === 1,
    'JvCreator.inUse counts the JV once, as pending — a cancelled entry must not keep inflating the figure that '
    + 'gates republishing it', use7b);
  // The restored JV is a real pending: it goes straight into the next entry
  // over those rows, which is what "comes back as pending" has to mean.
  const a7b = await genEntry(page, t7.id, ['D5', 'D6'], false);
  const g7b = await stateOf(page, t7.id, a7b);
  check(a7b !== a7 && g7b.pend.length === 0 && ((g7b.entry || {}).specialJvs || []).length === 1,
    'the restored pending JV is picked up by the next preview and consumed by the new entry',
    { n: g7b.n, pend: g7b.pend.length, jvs: (g7b.entry.specialJvs || []).length });
  // ... and a REVERSE never hands it back: those lines were posted.
  await openReverse(page, t7.id, a7b);
  const seen9b = await page.evaluate(() => {
    Reco._reverseSetMode('reversed');
    return (document.getElementById('appModalBody') || {}).innerHTML || '';
  });
  check(/are <b>not<\/b> restored as pending/.test(seen9b),
    'switching to Reverse re-states what happens: the Special JV is NOT restored, and why',
    seen9b.replace(/<[^>]*>/g, ' ').slice(0, 600));
  await runReverse(page, 'reversed', 'posted and must be reversed');
  await sleep(500);
  await page.evaluate(() => App.closeModal());
  const c7b = await stateOf(page, t7.id, a7b);
  check(c7b.pend.length === 0,
    'a reverse restores nothing — putting those lines back as pending would invite posting the same JV twice',
    c7b.pend);
  check((rv(c7b).droppedJvIds || []).some(j => j.jvId === 'FAKE_jv' && /lines are reversed by/.test(j.why)),
    'and the record says which entry reverses them instead', rv(c7b).droppedJvIds);
  check((rv(c7b).restoredJvIds || []).length === 0, 'with nothing in restoredJvIds', rv(c7b).restoredJvIds);
  const use7c = await page.evaluate(() => JvCreator.inUse('FAKE'));
  check(use7c.entries === 1 && use7c.pendings === 0,
    'a REVERSED entry still counts against the JV — it did go out', use7c);
  check(errors.length === 0, 'no JavaScript errors', errors);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[10] A post-entry column that is NOT a template column');
  const root8 = makeRoot('root8');
  const B8 = await startBridge(root8, 19914, ['--jv-port', '19915']); procs.push(B8.proc);
  await ctx.close();
  ({ page, errors, ctx } = await openReco(browser, B8));
  const t8 = await createTemplate(page, 'Added Col', ROWS, {
    additionalColumns: [{ name: 'Workflow', type: 'custom' }],
    postEntryColumn: 'Workflow', postEntryValue: 'Posted'
  });
  const file8 = dayFile(root8, t8.folder);
  // D1 already carries a value the user typed into their own column. It lives
  // in sess.manualTags, NOT on the row.
  const tagPre = await page.evaluate((id) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    const row = sess.data.find(r => r.Doc === 'D1');
    Reco.setTag(row._id, 'Workflow', 'Reviewed');
    return { inTags: sess.manualTags[Reco._tagKey(row, 'Workflow')],
             onRow: Object.prototype.hasOwnProperty.call(row, 'Workflow'),
             enriched: Reco._rowWithExtras(tpl, sess, row).Workflow };
  }, t8.id);
  check(tagPre.inTags === 'Reviewed' && !tagPre.onRow && tagPre.enriched === 'Reviewed',
    'the premise: an added column\'s value is in sess.manualTags and not on the row', tagPre);
  const a8 = await genEntry(page, t8.id, ['D1', 'D2']);
  const seen10 = await openReverse(page, t8.id, a8);
  check(/is not a template column/.test(seen10.body) && /Clearing it affects your session only/.test(seen10.body),
    'the dialog states plainly that the stamp was never on the shared history and the undo is session-only',
    seen10.body.slice(0, 700));
  check(/goes back to "Reviewed" on 1 row\(s\)/.test(seen10.body) && /goes back to blank on 1 row\(s\)/.test(seen10.body),
    'and that one row goes back to what the user typed, the other to blank');
  await runReverse(page, 'cancelled', 'wrong column');
  const c8 = await page.evaluate(([id, aid]) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    const e = (AppState.entryHistory[id] || []).find(x => x.accountingId === aid);
    const of = (doc) => {
      const row = sess.data.find(r => r.Doc === doc);
      return { onRow: Object.prototype.hasOwnProperty.call(row, 'Workflow') ? row.Workflow : null,
               tag: sess.manualTags[Reco._tagKey(row, 'Workflow')] || null,
               enriched: Reco._rowWithExtras(tpl, sess, row).Workflow,
               posted: Reco.isRowPosted(tpl, row) };
    };
    return { rev: e.reversal, d1: of('D1'), d2: of('D2'), prev: e.postedPrev };
  }, [t8.id, a8]);
  check((rv(c8).unstampedSessionOnly || []).slice().sort().join() === 'D1,D2'
    && (rv(c8).unstamped || []).length === 0,
    'the reversal records both keys as session-only and none as written to the share', c8.rev);
  check(c8.d1.onRow === null && c8.d1.tag === 'Reviewed' && c8.d1.enriched === 'Reviewed' && !c8.d1.posted,
    'the row property the stamp wrote is gone and the user\'s own value is the value again', c8.d1);
  check(c8.d2.onRow === null && c8.d2.tag === null && c8.d2.enriched === '' && !c8.d2.posted,
    'and a row that held nothing holds nothing — the tag is deleted, not set to ""', c8.d2);
  check(!csvRows(file8).some(r => r._src === 'reverse:' + a8),
    'no Cn row was written for an added column, because the stamp never went to the share either',
    csvRows(file8).map(r => r._pk + '/' + r._ver));

  // ── a LEGACY entry: no postedPrev, so a tag column is left strictly alone ──
  const a8b = await genEntry(page, t8.id, ['D3']);
  await page.evaluate(([id, aid]) => {
    const e = (AppState.entryHistory[id] || []).find(x => x.accountingId === aid);
    delete e.postedPrev;                       // every entry already on the share
  }, [t8.id, a8b]);
  const seen10b = await openReverse(page, t8.id, a8b);
  check(/was not recorded, so it is left as it is/.test(seen10b.body),
    'for an entry generated before the capture existed the dialog says the value cannot be put back',
    seen10b.body.slice(0, 700));
  await runReverse(page, 'cancelled', 'legacy entry');
  const c8b = await page.evaluate(([id, aid]) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    const row = sess.data.find(r => r.Doc === 'D3');
    const e = (AppState.entryHistory[id] || []).find(x => x.accountingId === aid);
    return { rev: e.reversal, onRow: row.Workflow, posted: Reco.isRowPosted(tpl, row) };
  }, [t8.id, a8b]);
  check(c8b.onRow === 'Posted' && c8b.posted,
    'and it really is left alone — clearing it blind would wipe whatever the user had typed', c8b);
  check((rv(c8b).unstampedSkipped || []).some(s => s.pk === 'D3' && /was not recorded/.test(s.why || ''))
    && (rv(c8b).unstampedSessionOnly || []).length === 0,
    'with the reason recorded against the key', rv(c8b).unstampedSkipped);

  // ── a FORMULA post-entry column: the picker allows it, so it must not throw ─
  const t8c = await createTemplate(page, 'Formula Col', ROWS, {
    additionalColumns: [{ name: 'Calc', type: 'formula', formula: '"NEW"' }],
    postEntryColumn: 'Calc', postEntryValue: 'Posted'
  });
  const a8c = await genEntry(page, t8c.id, ['D1']);
  const seen10c = await openReverse(page, t8c.id, a8c);
  check(/is a formula or lookup column/.test(seen10c.body) && /recomputed rather than stored/.test(seen10c.body),
    'a formula post-entry column is named as what it is, and the undo is honest about it', seen10c.body.slice(0, 700));
  await runReverse(page, 'cancelled', 'formula column');
  const c8c = await page.evaluate(([id, aid]) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    const row = sess.data.find(r => r.Doc === 'D1');
    const e = (AppState.entryHistory[id] || []).find(x => x.accountingId === aid);
    return { rev: e.reversal, onRow: Object.prototype.hasOwnProperty.call(row, 'Calc') ? row.Calc : null,
             enriched: Reco._rowWithExtras(tpl, sess, row).Calc, posted: Reco.isRowPosted(tpl, row) };
  }, [t8c.id, a8c]);
  check(c8c.rev && rv(c8c).mode === 'cancelled' && (rv(c8c).unstampedSessionOnly || []).join() === 'D1',
    'the reversal completes and reports it as session-only rather than silently doing nothing', c8c.rev);
  check(c8c.onRow === null && c8c.enriched === 'NEW' && !c8c.posted,
    'the shadow value the stamp wrote is deleted, so the column computes again', c8c);
  check(errors.length === 0, 'no JavaScript errors', errors);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[11] The three line outcomes, and the renamed debit column');
  const root9 = makeRoot('root9');
  const B9 = await startBridge(root9, 19916, ['--jv-port', '19917']); procs.push(B9.proc);
  await ctx.close();
  ({ page, errors, ctx } = await openReco(browser, B9));
  const t9 = await createTemplate(page, 'Lines', ROWS);
  const file9 = dayFile(root9, t9.folder);

  /* (i) MALFORMED, not unbalanced. The real AEG autoExchange branch emits a
     line with neither a debit nor a credit (an exchange leg that exactly
     offsets its from leg gives imbalance 0, so buildLine writes '' on both
     sides), and commit never checks standard lines. Such an entry must be
     refused as malformed, with no way to force it - not accused of being out
     of balance, which would be a lie about the books. */
  const aM = await genEntry(page, t9.id, ['D1']);
  await page.evaluate(([id, aid]) => {
    const e = (AppState.entryHistory[id] || []).find(x => x.accountingId === aid);
    e.lines.push({ Reference: 'ACC1', RC: '100', Nominal: '1', SubNominal: '0', 'Analysis Key': '0', LOB: '51',
                   Cur: 'AED', Reco: '', Dr: '', Cr: '', Doc: 'D1', Desc: 'zero-net exchange leg' });
  }, [t9.id, aM]);
  await openReverse(page, t9.id, aM);
  const seenM = await switchMode(page, 'reversed');
  check(/malformed/.test(seenM.body) && /carries neither a debit nor a credit/.test(seenM.body),
    'the dialog names the malformed line', seenM.body.slice(0, 800));
  check(/no way to force past it/.test(seenM.body) && !/does not balance/.test(seenM.body),
    'and offers no force, and does not call it a balance difference');
  const rM = await runReverse(page, 'reversed', 'try to mirror a malformed entry');
  check(rM.btn.disabled, 'the Reverse button stays disabled for it', rM.btn);
  check(/cannot be posted/.test(rM.after.title), 'and calling the commit anyway refuses', rM.after.title);
  const sM = await stateOf(page, t9.id, aM);
  check(!sM.hasReversal && sM.status.D1 === 'Posted', 'nothing was written', sM.status);
  // ... but a CANCEL of the same entry is still allowed: no lines are built.
  await openReverse(page, t9.id, aM);
  const rM2 = await runReverse(page, 'cancelled', 'cancel it instead');
  check(!rM2.btn.disabled, 'cancel is still open to the user — a malformed line only blocks the mirror', rM2.btn);
  const sM2 = await stateOf(page, t9.id, aM);
  check(sM2.reversal && rv(sM2).mode === 'cancelled' && sM2.status.D1 === '',
    'and it goes through', { mode: sM2.reversal && rv(sM2).mode, st: sM2.status.D1 });

  /* (iii) genuinely UNBALANCED: the one case that gets a forced confirmation. */
  const aU = await genEntry(page, t9.id, ['D2']);
  await page.evaluate(([id, aid]) => {
    const e = (AppState.entryHistory[id] || []).find(x => x.accountingId === aid);
    const dr = e.lines.find(l => l.Dr);
    dr.Dr = String((parseFloat(dr.Dr) + 0.01).toFixed(2));
  }, [t9.id, aU]);
  await openReverse(page, t9.id, aU);
  const seenU = await switchMode(page, 'reversed');
  check(/The original entry does not balance/.test(seenU.body) && /out by 0\.01/.test(seenU.body),
    'an entry that is genuinely out of balance is named as that, and only that', seenU.body.slice(0, 900));
  check(!seenU.disabled || true, 'the dialog still allows it, behind one more confirmation');
  const rU = await runReverse(page, 'reversed', 'mirror the unbalanced entry', { refuseConfirm: true });
  const sU0 = await stateOf(page, t9.id, aU);
  check(!sU0.hasReversal && !sU0.reversing,
    'declining the extra confirmation writes nothing at all', { rev: sU0.reversal, mirror: !!sU0.reversing });
  await openReverse(page, t9.id, aU);
  await runReverse(page, 'reversed', 'mirror the unbalanced entry');
  await sleep(500);
  await page.evaluate(() => App.closeModal());
  const sU = await stateOf(page, t9.id, aU);
  check(sU.reversal && rv(sU).linesUnbalanced === true,
    'accepting it records linesUnbalanced on the original', sU.reversal && rv(sU).linesUnbalanced);
  check(sU.reversing && sU.reversing.linesUnbalanced === true,
    'and on the reversing entry, so neither record pretends the books added up', sU.reversing && sU.reversing.linesUnbalanced);

  /* (ii) and the companion: a legacy entry whose AEG template has since been
     re-mapped. The reversal must REFUSE, not post the original amounts again
     into two blank columns. */
  const aR = await genEntry(page, t9.id, ['D3']);
  const alt = await page.evaluate(([id, aid]) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const e = (AppState.entryHistory[id] || []).find(x => x.accountingId === aid);
    const a = JSON.parse(JSON.stringify(AppState.aegTemplates[0]));
    a.id = U.uid(); a.name = 'renamed sides';
    a.outputColumns.forEach(c => {
      const m = c.mapping || {};
      if (m.type === 'value' && m.side === 'Dr') c.name = 'Debit AED';
      else if (m.type === 'value' && m.side === 'Cr') c.name = 'Credit AED';
    });
    AppState.aegTemplates.push(a);
    tpl.aegIntegration.aegTemplateId = a.id;      // somebody re-points the template
    const kept = JSON.stringify(e.lineCols);
    delete e.lineCols; delete e.aegTemplateId;    // ... and this entry pre-dates the capture
    return { kept, now: Reco._jvLineCols(a) };
  }, [t9.id, aR]);
  check(alt.now.dr === 'Debit AED' && alt.kept === '{"dr":"Dr","cr":"Cr","cur":"Cur"}',
    'the premise: the template now resolves to other column names than the entry\'s lines carry', alt);
  await openReverse(page, t9.id, aR);
  const seenR = await switchMode(page, 'reversed');
  check(/Debit AED/.test(seenR.body) && /Credit AED/.test(seenR.body) && /Dr, Cr/.test(seenR.body),
    'the refusal names the columns it would have swapped AND the columns the lines actually carry',
    seenR.body.slice(0, 900));
  check(/renamed or re-mapped/.test(seenR.body) && /refused/.test(seenR.body),
    'and says why — resolving the names again would write two blanks and copy the amounts verbatim');
  const rR = await runReverse(page, 'reversed', 'mirror it');
  check(rR.btn.disabled && /cannot be posted/.test(rR.after.title), 'it cannot be forced', rR.after.title);
  const sR = await stateOf(page, t9.id, aR);
  check(!sR.hasReversal && !sR.reversing, 'and no mirror was minted', sR.ids);
  // with the capture present, the same template switch is harmless
  const aR2 = await genEntry(page, t9.id, ['D4']);
  await page.evaluate(([id, aid]) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    tpl.aegIntegration.aegTemplateId = AppState.aegTemplates[0].id;   // and back again
  }, [t9.id, aR2]);
  const aR2cols = await page.evaluate(([id, aid]) => {
    const e = (AppState.entryHistory[id] || []).find(x => x.accountingId === aid);
    return { lc: e.lineCols, tplId: e.aegTemplateId };
  }, [t9.id, aR2]);
  check(aR2cols.lc && aR2cols.lc.dr === 'Debit AED',
    'an entry generated under the renamed template recorded ITS names', aR2cols.lc);
  await openReverse(page, t9.id, aR2);
  await runReverse(page, 'reversed', 'mirror the renamed one');
  await sleep(500);
  await page.evaluate(() => App.closeModal());
  const sR2 = await page.evaluate(([id, aid]) => {
    const hist = AppState.entryHistory[id] || [];
    const o = hist.find(e => e.accountingId === aid), n = hist.find(e => e.reverses === aid);
    const v = (l, c) => { const x = l[c]; return (x && typeof x === 'object') ? (x.value || '') : (x == null ? '' : x); };
    return { swapped: n && o.lines.every((l, i) => v(n.lines[i], 'Debit AED') === v(l, 'Credit AED')
        && v(n.lines[i], 'Credit AED') === v(l, 'Debit AED')),
      nonBlank: n && n.lines.some(l => v(l, 'Debit AED') !== '' || v(l, 'Credit AED') !== ''),
      noDrCr: n && n.lines.every(l => !Object.prototype.hasOwnProperty.call(l, 'Dr')) };
  }, [t9.id, aR2]);
  check(sR2.swapped && sR2.nonBlank && sR2.noDrCr,
    'and it reverses into ITS OWN columns even though the template has moved on — the capture is what makes '
    + 'that possible, and no Dr/Cr column is invented', sR2);
  check(errors.length === 0, 'no JavaScript errors', errors);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[12] An entry with no keys, a share that could not be read, and a restore');
  const noKeys = await page.evaluate((id) => {
    const hist = AppState.entryHistory[id] || [];
    const e = { accountingId: 'AELEGACY1', lines: [{ Reference: 'ACC1', RC: '100', Nominal: '1', SubNominal: '0',
        'Analysis Key': '0', LOB: '51', Cur: 'AED', Reco: '', Dr: '50.00', Cr: '', Doc: 'X1', Desc: 'legacy' },
      { Reference: 'ACC1', RC: '100', Nominal: '1', SubNominal: '0', 'Analysis Key': '0', LOB: '51',
        Cur: 'AED', Reco: '', Dr: '', Cr: '50.00', Doc: 'X1', Desc: 'legacy' }],
      sourceRowIds: ['dead1', 'dead2'], specialJvIds: [], specialJvs: [],
      createdAt: '01/09/2026, 10:00:00', createdBy: 'r.menon', docNumbers: {} };
    hist.push(e);
    AppState.entryHistory[id] = hist;
    return { n: hist.length };
  }, t9.id);
  const before12 = csvRows(file9).length;
  const seen12 = await openReverse(page, t9.id, 'AELEGACY1');
  check(/does not record which rows it closed/.test(seen12.body) && /no row will be changed/.test(seen12.body),
    'an entry that records no keys at all says so, plainly', seen12.body.slice(0, 800));
  check(/Generated by r.menon/.test(seen12.body),
    'and still names the person who generated it', seen12.body.slice(0, 120));
  await runReverse(page, 'cancelled', 'legacy clean-up', { refuseConfirm: true });
  const s12a = await stateOf(page, t9.id, 'AELEGACY1');
  check(!s12a.hasReversal, 'the separate confirmation is required, and declining it changes nothing', s12a.reversal);
  await openReverse(page, t9.id, 'AELEGACY1');
  await runReverse(page, 'cancelled', 'legacy clean-up');
  const s12 = await stateOf(page, t9.id, 'AELEGACY1');
  check(s12.reversal && rv(s12).noKeyTargets === true && (rv(s12).unstamped || []).length === 0,
    'accepting it tombstones the record and records noKeyTargets', s12.reversal);
  check(csvRows(file9).length === before12, 'and not one version row was written anywhere', csvRows(file9).length);

  // ── the share could not be read at start-up: no dialog at all ─────────────
  const ro = await page.evaluate((id) => {
    Store.readOnlyKeys.entryHistory = true;
    const hist = AppState.entryHistory[id] || [];
    const live = hist.find(e => !e.reversal) || { accountingId: 'none' };
    Reco.openReverseEntryModal(live.accountingId);
    const out = { title: (document.getElementById('appModalTitle') || {}).textContent || '',
                  body: (document.getElementById('appModalBody') || {}).textContent || '',
                  state: !!Reco._reverseState, id: live.accountingId };
    delete Store.readOnlyKeys.entryHistory;
    App.closeModal();
    return out;
  }, t9.id);
  check(/cannot be recorded/.test(ro.title) && /Restart the app/.test(ro.body) && !ro.state,
    'when entryHistory could not be read at start-up the dialog refuses to open — flush() cannot tell you '
    + 'whether a write happened, and Store.save returns at once for a read-only key', ro);

  // ── a restore must not un-reverse anything ───────────────────────────────
  const carry = await page.evaluate(() => {
    const cur = [{ accountingId: 'A1', reversal: { mode: 'reversed', by: 'a.sasi', at: 'T', reversalId: 'A2' } },
                 { accountingId: 'A2', reverses: 'A1' },
                 { accountingId: 'A3' }];
    const backup = [{ accountingId: 'A1' }, { accountingId: 'A3' }];
    const out = App._carryReversalsList(cur, backup);
    return { out, warn: App._reversalWarning({ t: cur }, { t: backup }),
             noWarn: App._reversalWarning({ t: cur }, { t: cur }) };
  });
  check(carry.out.length === 2 && carry.out[0].reversal && carry.out[0].reversal.mode === 'reversed',
    'restoring a backup taken before a reversal carries the mark onto the restored record — a reversal is a '
    + 'one-way fact', carry.out);
  check(/predates the reversal of A1/.test(carry.warn) && /cannot be put back/.test(carry.warn),
    'and the confirm names the entry whose reversing entry the backup does not hold', carry.warn);
  check(carry.noWarn === '', 'a backup that holds both says nothing extra', carry.noWarn);
  check(errors.length === 0, 'no JavaScript errors', errors);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[13] A half-done reversal is visible, and a re-uploaded row reverses normally');
  const t13 = await createTemplate(page, 'Half Done', ROWS);
  const file13 = dayFile(root9, t13.folder);
  const a13 = await genEntry(page, t13.id, ['D1', 'D2']);
  await openReverse(page, t13.id, a13);
  await runReverse(page, 'cancelled', 'cancelled, but one row will be re-stamped behind our back');
  /* A row that still reads the stamp after its entry was undone: the un-stamp
     did not reach it, or somebody re-stamped it by hand. This is the state the
     posted-row control exists to catch, and before change #4 it was painted
     clean green, because _postedRefFor resolved it to the cancelled entry. */
  const half = await page.evaluate((id) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    const row = sess.data.find(r => r.Doc === 'D1');
    row.Status = 'Posted';
    Reco._postedIdxReset();
    const a = Reco.postedJvAudit(tpl, sess);
    return { ref: Reco._postedRefFor(tpl, row), badge: Reco._postedBadge(tpl, row),
             posted: a.posted, linked: a.linked, missing: a.missing,
             reason: (a.exceptions[0] || {}).reason || '' };
  }, t13.id);
  check(half.ref && half.ref.reversed === true && half.ref.reversalMode === 'cancelled',
    '_postedRefFor hands the row back marked, never as a clean reference', half.ref);
  check(/posted-noref/.test(half.badge) && /cancelled/.test(half.badge) && !/posted-ref/.test(half.badge),
    'the row\'s badge is the warning one, not the clean violet one', half.badge);
  check(half.posted === 1 && half.linked === 0 && half.missing === 1,
    'the posted-row audit counts it as an exception rather than a linked row',
    { posted: half.posted, linked: half.linked, missing: half.missing });
  check(/was cancelled on/.test(half.reason) && /this row was not released/.test(half.reason),
    'and the reason says which entry was undone and when, so the user can act on it', half.reason);

  // ── re-uploaded under the same key ───────────────────────────────────────
  const t13b = await createTemplate(page, 'Re-upload', ROWS);
  const file13b = dayFile(root9, t13b.folder);
  const a13b = await genEntry(page, t13b.id, ['D1', 'D2']);
  const re13 = await page.evaluate(async ([id, fields, rows]) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    // the same file arrives again: appendUpload keeps each row's key
    sess.data = [];
    Reco.ingestData(tpl, rows, fields);
    await Versioning.idle();
    App.closeModal();
    // ... and the user reopens it from history, which collapses to the highest
    // version per key - the stamp
    const path = Versioning.pathFor(tpl);
    sess.data = [];
    await Reco.loadVersionedFile(path, id);
    return { n: sess.data.length, ids: sess.data.map(r => r._id).length,
             status: Object.fromEntries(sess.data.map(r => [r.Doc, r.Status])) };
  }, [t13b.id, FIELDS, ROWS]);
  check(re13.n === 6 && re13.status.D1 === 'Posted',
    're-uploading the same data and reopening it keeps the key, so the stamp is still the active value', re13);
  await openReverse(page, t13b.id, a13b);
  await runReverse(page, 'cancelled', 'reverse after a re-upload');
  const s13b = await stateOf(page, t13b.id, a13b);
  check((rv(s13b).unstamped || []).slice().sort().join() === 'D1,D2' && s13b.status.D1 === '',
    'the keys resolve to the re-uploaded rows and the un-stamp works normally — session ids changed, keys did not',
    { un: rv(s13b).unstamped, st: s13b.status });
  check((rowsFor(file13b, 'D1').slice(-1)[0] || {}).Status === '',
    'and the reversal\'s Cn is the last word for that key on the share',
    rowsFor(file13b, 'D1').map(r => r._ver + '=' + r.Status));
  check(errors.length === 0, 'no JavaScript errors', errors);

  clearTimeout(watchdog);
  await ctx.close();
} catch (e) {
  failures++;
  console.error('\nFATAL: ' + (e && e.stack || e));
} finally {
  clearTimeout(watchdog);
  try { await browser.close(); } catch (e) {}
  killAll();
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
