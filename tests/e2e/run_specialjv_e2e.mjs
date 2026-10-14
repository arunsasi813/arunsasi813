// End-to-end tests for the Special JV host: balance validation, posted-JV
// tracking / missing accounting references, and ref validation.
//
//   node tests/e2e/run_specialjv_e2e.mjs
//
// Needs: python3, Playwright (Chromium). Exits non-zero on the first failure.
//
// Most cases drive a FAKE JV page written into the temp root by this file, so
// the test controls exactly which lines come back over the handshake. The real
// special_jv_templates/TCH.html is driven too, so the host changes are proved
// against the page the business actually uses.

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

// ════════════════════════════════════════════════════════════════════════════
// The fake JV page. It reports whatever window.parent._fakeMode asks for, and
// it posts as soon as it has its rows — no click — so the suite also proves
// that an auto-submitting page is still accepted (the user chose to leave that
// behaviour alone) and that an auto-submitting BAD one is still refused.
// ════════════════════════════════════════════════════════════════════════════
const FAKE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>FAKE JV</title></head>
<body><div id="s">fake jv</div><script>
var REF = 'FAKE', inputs = [], mode = 'good';
try { mode = window.parent._fakeMode || 'good'; } catch (e) {}
function L(o) {
  return Object.assign({ Reference:'ACC1', RC:'100', Nominal:'12345', SubNominal:'0',
    'Analysis Key':'0', LOB:'51', Cur:'AED', Reco:'', Dr:'', Cr:'', Doc:'', Desc:'fake jv line' }, o);
}
function build() {
  var pks = inputs.map(function (r) { return r._pk; }), lines = [];
  switch (mode) {
    case 'good':      lines = [L({ Dr:'100.00' }), L({ Cr:'100.00' })]; break;
    case 'unbal':     lines = [L({ Dr:'1000000.00' })]; break;
    case 'bothSides': lines = [L({ Dr:'50.00', Cr:'50.00' }), L({ Cr:'50.00' }), L({ Dr:'50.00' })]; break;
    case 'noSide':    lines = [L({ Dr:'0.00' }), L({ Cr:'0.00' })]; break;
    case 'nonNum':    lines = [L({ Dr:'one hundred' }), L({ Cr:'100.00' })]; break;
    case 'negative':  lines = [L({ Dr:'-100.00' }), L({ Cr:'-100.00' })]; break;
    case 'blankCur':  lines = [L({ Dr:'100.00' }), L({ Cr:'100.00', Cur:'' })]; break;
    case 'noCurAll':  lines = [L({ Dr:'100.00', Cur:'' }), L({ Cr:'100.00', Cur:'' })]; break;
    case 'multiCcy':  lines = [L({ Dr:'100.00', Cur:'USD' }), L({ Cr:'100.00', Cur:'USD' }),
                               L({ Dr:'70.00',  Cur:'EUR' }), L({ Cr:'70.00',  Cur:'EUR' })]; break;
    case 'ccyOut':    lines = [L({ Dr:'100.00', Cur:'USD' }), L({ Cr:'100.00', Cur:'USD' }),
                               L({ Dr:'70.00',  Cur:'EUR' }), L({ Cr:'69.00',  Cur:'EUR' })]; break;
    case 'tol01':     lines = [L({ Dr:'100.01' }), L({ Cr:'100.00' })]; break;
    case 'tol02':     lines = [L({ Dr:'100.02' }), L({ Cr:'100.00' })]; break;
    case 'claim':     lines = [L({ Dr:'100.00' }), L({ Cr:'100.00' })]; pks = ['D5']; break;
    case 'claimMix':  lines = [L({ Dr:'100.00' }), L({ Cr:'100.00' })]; pks = inputs.map(function (r) { return r._pk; }).concat(['D5','D6']); break;
    case 'manyLines':
      for (var i = 0; i < 300; i++) lines.push(L(i % 2 ? { Cr:'10.00' } : { Dr:'10.00' }));
      break;
    case 'noLines':   lines = []; break;
  }
  return { lines: lines, pks: pks };
}
function post() {
  var b = build();
  window.parent.postMessage({ type:'specialJV.complete', ref:REF, jvId:'FAKE_' + mode,
    lines:b.lines, primaryKeys:b.pks, inputData:inputs }, '*');
}
var started = false;
function start() {
  if (started) return; started = true;
  document.getElementById('s').textContent = 'rows:' + inputs.length + ' mode:' + mode;
  setTimeout(post, 30);
}
window.addEventListener('message', function (ev) {
  var d = ev.data; if (!d || d.type !== 'specialJV.init') return;
  inputs = d.inputs || []; start();
});
try { if (window.parent !== window && window.parent._specialJvInputs) { inputs = window.parent._specialJvInputs; start(); } } catch (e) {}
if (!started) {
  var n = 0, iv = setInterval(function () {
    if (started || n++ > 40) { clearInterval(iv); return; }
    window.parent.postMessage({ type:'specialJV.ready', ref:REF }, '*');
  }, 50);
}
<\/script></body></html>`;

/* The same page under another ref. The host drops any message whose ref is not
   the one it opened, so a fake JV has to announce itself correctly. */
const fakePageFor = (ref) => FAKE_PAGE.replace("var REF = 'FAKE'", "var REF = '" + ref + "'");

/* Refs that are also names on Object.prototype. "constructor" is a plain
   string a user can type into To Account, and a hand-written
   special_jv_mapping/constructor.json is the whole of what it takes to
   register one — no creator, no wizard. refProblem() allows them (they are
   letters and nothing else); "__proto__" is refused for its underscore. */
const PROTO_REFS = ['constructor', 'toString', 'valueOf'];

// Mapping files whose refs must be refused, and why.
const BAD_REFS = [
  ['EVIL_TRAVERSAL.json',  '../apps/Reco'],
  ['EVIL_DOTDOT.json',     '..'],
  ['EVIL_SLASH.json',      'a/b'],
  ['EVIL_BACKSLASH.json',  'a\\b'],
  ['EVIL_WINPATH.json',    'C:\\Windows\\x'],
  ['EVIL_DOT.json',        'TCH.backup'],
  ['EVIL_UNDERSCORE.json', '_hidden'],
  ['EVIL_SPACE.json',      'My JV'],
  ['EVIL_PAD.json',        ' TCH '],
  ['EVIL_RESERVED.json',   'con'],
  ['EVIL_EMPTY.json',      '   '],
  ['EVIL_LONG.json',       'A'.repeat(41)],
  ['EVIL_QUERY.json',      'TCH?x=1'],
  ['EVIL_PROTO.json',      '__proto__'],
];

function makeRoot(name, opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-jv-e2e-'));
  const root = path.join(base, name);
  const cp = (src, dst) => {
    fs.mkdirSync(path.dirname(path.join(root, dst)), { recursive: true });
    fs.copyFileSync(path.join(REPO, src), path.join(root, dst));
  };
  cp('apps/Reco.html', 'apps/Reco.html');
  for (const f of fs.readdirSync(path.join(REPO, 'apps/lib'))) cp('apps/lib/' + f, 'apps/lib/' + f);
  cp('special_jv_templates/TCH.html', 'special_jv_templates/TCH.html');
  cp('special_jv_mapping/TCH.json', 'special_jv_mapping/TCH.json');
  fs.mkdirSync(path.join(root, 'master'), { recursive: true });
  fs.writeFileSync(path.join(root, 'master/user.csv'), `ID,Name,Email,reco\r\n${OS_USER},Test User,,1\r\n`);
  fs.writeFileSync(path.join(root, 'master/accounts_master.csv'),
    'Reference,RC,Nominal,SubNominal,AnalysisKey,LOB\r\nACC1,100,12345,0,0,51\r\nBANK,200,11111,0,0,51\r\n');

  // the fake JV, registered properly
  fs.writeFileSync(path.join(root, 'special_jv_templates/FAKE.html'), FAKE_PAGE);
  fs.writeFileSync(path.join(root, 'special_jv_mapping/FAKE.json'), JSON.stringify({
    ref: 'FAKE', displayName: 'Fake JV', inputColumns: [{ name: 'Currency' }, { name: 'FC Amount' }]
  }, null, 2));

  if (opts.badRefs) {
    for (const [file, ref] of BAD_REFS) {
      fs.writeFileSync(path.join(root, 'special_jv_mapping/' + file),
        JSON.stringify({ ref, displayName: 'Bad ' + file, inputColumns: ['Currency'] }, null, 2));
    }
    // a second mapping claiming FAKE: the duplicate must not replace the first
    fs.writeFileSync(path.join(root, 'special_jv_mapping/ZZ_DUP.json'),
      JSON.stringify({ ref: 'FAKE', displayName: 'Impostor', inputColumns: ['Currency'] }, null, 2));
    // refs that ARE safe and must load
    fs.writeFileSync(path.join(root, 'special_jv_mapping/OK_DASH.json'),
      JSON.stringify({ ref: 'JV-2', displayName: 'Dashed', inputColumns: ['Currency'] }, null, 2));
    fs.writeFileSync(path.join(root, 'special_jv_mapping/OK_UNDER.json'),
      JSON.stringify({ ref: 'JV_3x', displayName: 'Undered', inputColumns: ['Currency'] }, null, 2));
  }

  if (opts.protoRefs) {
    for (const ref of PROTO_REFS) {
      fs.writeFileSync(path.join(root, 'special_jv_templates/' + ref + '.html'), fakePageFor(ref));
      fs.writeFileSync(path.join(root, 'special_jv_mapping/' + ref + '.json'), JSON.stringify({
        ref, displayName: 'Proto ' + ref, inputColumns: [{ name: 'Currency' }, { name: 'FC Amount' }]
      }, null, 2));
    }
  }
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
  return { ctx, page, errors };
}

const ROWS = [
  { Doc: 'D1', Date: '06/10/2026', 'Txn Type': 'RAPID', Currency: 'USD', 'FC Amount': '100',   AED: '367',  ToAccount: 'FAKE', Status: '' },
  { Doc: 'D2', Date: '07/10/2026', 'Txn Type': 'RAPID', Currency: 'EUR', 'FC Amount': '50',    AED: '200',  ToAccount: 'FAKE', Status: '' },
  { Doc: 'D3', Date: '12/10/2026', 'Txn Type': 'OF01',  Currency: 'RUB', 'FC Amount': '-9000', AED: '-400', ToAccount: 'FAKE', Status: '' },
  { Doc: 'D4', Date: '08/10/2026', 'Txn Type': 'RAPID', Currency: 'RUB', 'FC Amount': '5000',  AED: '220',  ToAccount: 'FAKE', Status: '' },
  { Doc: 'D5', Date: '09/10/2026', 'Txn Type': 'BANK',  Currency: 'AED', 'FC Amount': '10',    AED: '10',   ToAccount: 'ACC1', Status: '' },
  { Doc: 'D6', Date: '10/10/2026', 'Txn Type': 'BANK',  Currency: 'AED', 'FC Amount': '20',    AED: '20',   ToAccount: 'ACC1', Status: '' },
];
const TCH_ROWS = ROWS.map(r => Object.assign({}, r, { ToAccount: r.ToAccount === 'FAKE' ? 'TCH' : r.ToAccount }));
// One row per Object.prototype ref: D1 → constructor, D2 → toString, D3 → valueOf.
const PROTO_ROWS = PROTO_REFS.map((ref, i) => Object.assign({}, ROWS[i], { ToAccount: ref }));
const FIELDS = Object.keys(ROWS[0]);

async function createTemplate(page, name, rows) {
  return page.evaluate(([name, fields, rows]) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.name = name;
    t.columns = fields.map(n => ({ name: n, label: n, formats: [], isValue: n === 'AED', isDate: n === 'Date' }));
    t.primaryKeys = ['Doc'];
    t.valueColumn = 'AED';
    t.docNumberColumn = 'Doc';
    t.editableColumns = ['ToAccount', 'Status'];
    t.displayColumns = t.columns.map(c => c.name);
    t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id, keywordColumn: '',
                         keywordValues: '', postEntryColumn: 'Status', postEntryValue: 'Posted' };
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.name === name);
    RecoTemplate.open(tpl.id);
    Reco.ingestData(tpl, rows, fields);
    return { id: tpl.id };
  }, [name, FIELDS, rows]);
}

const browser = await chromium.launch();
const procs = [];
const watchdog = setTimeout(() => {
  console.error('\nWATCHDOG: specialjv e2e exceeded 5 minutes; last check: ' + (passes + failures));
  procs.forEach(p => p.kill());
  process.exit(2);
}, 300000);
const killAll = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });
process.on('exit', killAll);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { killAll(); process.exit(130); }));

try {
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[1] SpecialJV.load refuses an unsafe or duplicate ref');
  const rootA = makeRoot('rootA', { badRefs: true });
  const BA = await startBridge(rootA, 18961); procs.push(BA.proc);
  let { page, errors, ctx } = await openReco(browser, BA);

  const reg = await page.evaluate(() => ({
    keys: Object.keys(SpecialJV.registry).sort(),
    problems: Store.loadProblems.slice(),
    fakeName: (SpecialJV.get('FAKE') || {}).displayName,
    traversal: SpecialJV.isJvRef('../apps/Reco'),
    proto: SpecialJV.isJvRef('__proto__'),
    ctor: SpecialJV.isJvRef('constructor'),
    hasOwn: SpecialJV.isJvRef('hasOwnProperty'),
    toStr: SpecialJV.isJvRef('toString'),
    paths: Object.keys(SpecialJV.registry).map(k => SpecialJV.registry[k].htmlPath)
  }));
  check(reg.keys.join() === 'FAKE,JV-2,JV_3x,TCH', 'only safe refs register; every bad one is refused', reg.keys);
  check(!reg.traversal, 'ref "../apps/Reco" does not register, so the modal cannot frame apps/Reco.html');
  check(reg.fakeName === 'Fake JV', 'a duplicate ref does not replace the mapping that loaded first', reg.fakeName);
  check(reg.paths.every(p => /^special_jv_templates\/[A-Za-z0-9][A-Za-z0-9_-]{0,39}\.html$/.test(p)),
    'every registered htmlPath is one safe segment under special_jv_templates/', reg.paths);
  check(!reg.proto && !reg.ctor && !reg.hasOwn && !reg.toStr,
    'Object.prototype names are not JV refs (a To Account of "constructor" resolves to nothing)', reg);

  // every bad mapping is named in the boot dialog, with a reason
  const named = await page.evaluate((files) => files.map(f => ({
    f, told: Store.loadProblems.some(p => p.indexOf(f) >= 0 && /was not loaded/.test(p))
  })), BAD_REFS.map(b => b[0]).concat(['ZZ_DUP.json']));
  check(named.every(x => x.told), 'each refused mapping file is reported through Store.loadProblems',
    named.filter(x => !x.told).map(x => x.f));
  check(reg.problems.some(p => /ZZ_DUP\.json/.test(p) && /already used by/.test(p)),
    'the duplicate ref is reported as a duplicate, naming the file that holds it',
    reg.problems.filter(p => /ZZ_DUP/.test(p)));
  check(reg.problems.some(p => /EVIL_RESERVED\.json/.test(p) && /reserved Windows device name/i.test(p)),
    'a reserved Windows device name is refused with that reason');
  check(await page.isVisible('#appModalTitle:has-text("could not be loaded")'),
    'the user is shown the refused mappings at boot');
  await page.evaluate(() => App.closeModal());

  // refProblem is the single gate, and _resolveSrc will not build a path around it
  const gate = await page.evaluate(async () => {
    const bad = ['../x', 'a/b', 'a\\b', '..', '.', 'x.y', '_x', 'x y', '', 'con', 'LPT3', 'A'.repeat(41), 'x?y', 'x%2e%2e'];
    const good = ['TCH', 'JV-2', 'JV_3x', 'A', '0', 'A'.repeat(40)];
    let threwBadRef = false, threwAltered = false;
    try { await SpecialJV._resolveSrc({ ref: '../apps/Reco', htmlPath: 'special_jv_templates/../apps/Reco.html' }); }
    catch (e) { threwBadRef = /not a safe name/.test(e.message); }
    try { await SpecialJV._resolveSrc({ ref: 'TCH', htmlPath: '../../etc/passwd' }); }
    catch (e) { threwAltered = /was altered/.test(e.message); }
    return { bad: bad.filter(r => !SpecialJV.refProblem(r)), good: good.filter(r => SpecialJV.refProblem(r)), threwBadRef, threwAltered };
  });
  check(!gate.bad.length, 'refProblem rejects every unsafe ref shape', gate.bad);
  check(!gate.good.length, 'refProblem accepts the safe ones', gate.good);
  check(gate.threwBadRef, '_resolveSrc refuses to build a path from an unsafe ref');
  check(gate.threwAltered, '_resolveSrc refuses an htmlPath that does not match its own ref');

  check(errors.length === 0, 'no JavaScript errors while loading the mappings', errors);
  await ctx.close();

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[2] A JV whose lines do not balance never becomes a pending JV');
  const rootB = makeRoot('rootB');
  const BB = await startBridge(rootB, 18962); procs.push(BB.proc);
  ({ page, errors, ctx } = await openReco(browser, BB));
  const tpl = await createTemplate(page, 'JV Host', ROWS);

  // Open the preview for the FAKE rows, then run the fake page in one mode.
  async function openJv(mode, docs = ['D1', 'D2']) {
    // Leave no modal behind, so a build that fails one case still runs the rest.
    await page.evaluate((id) => {
      if (typeof SpecialJV !== 'undefined' && SpecialJV._activeHandler) SpecialJV._cancel();
      App.closeModal();
      AppState.pendingSpecialJV[id] = [];
    }, tpl.id);
    await page.evaluate(([id, docs]) => {
      const s = AppState.recoSessions[id];
      s.selectedRows = {};
      s.data.filter(r => docs.includes(r.Doc)).forEach(r => s.selectedRows[r._id] = true);
      Reco.previewEntryFromSelection(true);
    }, [tpl.id, docs]);
    await page.evaluate((m) => { window._fakeMode = m; }, mode);
    await page.click('#appModalBody button:has-text("Complete")');
    await sleep(900);
  }
  // State after a fake JV ran: is the modal still the JV, what was refused,
  // and did anything reach pendingSpecialJV?
  const after = async () => page.evaluate((id) => ({
    title: (document.getElementById('appModalTitle') || {}).textContent || '',
    problems: (document.getElementById('specialJvProblems') || {}).textContent || '',
    frame: !!document.getElementById('specialJvFrame'),
    pend: (AppState.pendingSpecialJV[id] || []).length
  }), tpl.id);
  const closeJv = async () => {
    await page.evaluate(() => { if (SpecialJV._activeHandler) SpecialJV._cancel(); });
    await sleep(200);
    await page.evaluate(() => App.closeModal());
  };

  const cases = [
    ['unbal',     /out by 1000000\.00/,                      'a one-line Dr 1,000,000 with no credit'],
    ['bothSides', /carries both a debit .* and a credit/,    'a line carrying both a debit and a credit'],
    ['noSide',    /carries neither a debit nor a credit/,    'a line carrying neither side (0.00 both ways)'],
    ['nonNum',    /debit that is not a number/,              'a non-numeric amount'],
    ['negative',  /negative debit/,                          'a negative amount'],
    ['blankCur',  /no currency/,                             'a blank currency beside lines that have one'],
    ['ccyOut',    /EUR is out by 1\.00/,                     'one currency out while another balances'],
    ['tol02',     /out by 0\.02/,                            'two cents out'],
    ['tol01',     /out by 0\.01/,                            'one cent out — an allocation that does not add up'],
  ];
  for (const [mode, re, what] of cases) {
    await openJv(mode);
    const st = await after();
    check(st.pend === 0 && /Special JV/.test(st.title) && st.frame && re.test(st.problems),
      'refused: ' + what, { mode, pend: st.pend, title: st.title, problems: st.problems.slice(0, 200) });
    await closeJv();
  }
  // The iframe must be the SAME element after a refusal: re-rendering the modal
  // body would recreate it and throw away whatever the user had typed.
  await openJv('unbal');
  const keep = await page.evaluate(() => {
    const f = document.getElementById('specialJvFrame');
    f.dataset.probe = 'kept';                       // survives only if the element does
    return { src: f.getAttribute('src') };
  });
  await after();
  const kept = await page.evaluate(() => {
    const f = document.getElementById('specialJvFrame');
    return { same: !!f && f.dataset.probe === 'kept', src: f ? f.getAttribute('src') : null,
             problems: (document.getElementById('specialJvProblems') || {}).textContent || '' };
  });
  check(kept.same && kept.src === keep.src && /out by/.test(kept.problems),
    'the JV modal and its iframe stay open on refusal, so the page keeps the user\'s work', kept);
  await closeJv();

  // ...and the sets that must be accepted
  const accepted = [
    ['good',      'a balanced two-line JV'],
    ['multiCcy',  'two currencies that each balance'],
    ['noCurAll',  'no currency on any line (an AEG template need not map one)'],
    ['manyLines', '300 lines — no line cap was introduced'],
  ];
  for (const [mode, what] of accepted) {
    await openJv(mode);
    const st = await page.evaluate((id) => ({
      title: (document.getElementById('appModalTitle') || {}).textContent || '',
      pend: (AppState.pendingSpecialJV[id] || []).length,
      lines: ((AppState.pendingSpecialJV[id] || [])[0] || {}).lines
    }), tpl.id);
    check(st.pend === 1 && /Entry Preview/.test(st.title), 'accepted: ' + what, { mode, pend: st.pend, title: st.title });
    if (mode === 'manyLines') check((st.lines || []).length === 300, '300 lines captured in full', (st.lines || []).length);
    await page.evaluate((id) => { AppState.pendingSpecialJV[id] = []; App.closeModal(); }, tpl.id);
  }
  // An empty line set is still treated as a cancel, as it always was.
  await openJv('noLines');
  const noLines = await page.evaluate((id) => ({
    title: (document.getElementById('appModalTitle') || {}).textContent || '',
    pend: (AppState.pendingSpecialJV[id] || []).length
  }), tpl.id);
  check(noLines.pend === 0 && /Entry Preview/.test(noLines.title),
    'a JV returning no lines is still a cancel, not a refusal', noLines);
  await page.evaluate(() => App.closeModal());

  // checkLines on its own
  const cl = await page.evaluate(() => {
    const C = (lines, cols) => SpecialJV.checkLines(lines, cols);
    const bal = C([{ Cur: 'AED', Dr: '10.00', Cr: '' }, { Cur: 'AED', Dr: '', Cr: '10.00' }]);
    const cell = C([{ Cur: { value: 'AED' }, Dr: { value: '10.00' }, Cr: '' }, { Cur: 'AED', Dr: '', Cr: '10.00' }]);
    const named = C([{ CCY: 'AED', Debit: '10.00' }, { CCY: 'AED', Credit: '10.00' }], { dr: 'Debit', cr: 'Credit', cur: 'CCY' });
    const nullCur = C([{ Dr: '10.00' }, { Cr: '10.00' }], { dr: 'Dr', cr: 'Cr', cur: null });
    return { bal: bal.ok, totals: bal.totals, cell: cell.ok, named: named.ok, nullCur: nullCur.ok,
             empty: C([]).ok, emptyWhy: C([]).problems[0], text: SpecialJV.totalsText(bal.totals) };
  });
  check(cl.bal && cl.cell && cl.named && cl.nullCur, 'checkLines reads {value} cells and template-named columns', cl);
  check(!cl.empty && /no accounting lines/.test(cl.emptyWhy), 'checkLines reports an empty line set', cl.emptyWhy);
  check(cl.totals.length === 1 && cl.totals[0].cur === 'AED' && cl.totals[0].dr === 10 && cl.totals[0].ok,
    'checkLines returns per-currency Dr/Cr totals', cl.totals);
  check(/AED Dr 10\.00 \/ Cr 10\.00/.test(cl.text), 'totalsText renders the per-currency figures', cl.text);

  // ── the preview shows the numbers beside Generate, and blocks on a bad JV ──
  await openJv('multiCcy');
  const prev = await page.evaluate(() => {
    const body = document.getElementById('appModalBody').textContent;
    const btn = [...document.querySelectorAll('#appModalFooter button')].find(b => /Generate/.test(b.textContent));
    return { body, disabled: btn.disabled };
  });
  check(/USD: Dr 100\.00 \/ Cr 100\.00/.test(prev.body) && /EUR: Dr 70\.00 \/ Cr 70\.00/.test(prev.body),
    'the preview banner shows each currency\'s Dr/Cr next to the Generate button', prev.body.slice(0, 400));
  check(prev.disabled === false, 'Generate is enabled for a balanced JV');
  await page.evaluate(() => App.closeModal());

  // ── a pending written by an OLD build (never validated) ───────────────────
  const old = await page.evaluate((id) => {
    const s = AppState.recoSessions[id];
    const pks = s.data.filter(r => ['D1', 'D2'].includes(r.Doc)).map(r => r._pk);
    AppState.pendingSpecialJV[id] = [{
      jvId: 'OLD_JV_1', ref: 'FAKE',
      lines: [{ Reference: 'ACC1', RC: '100', Nominal: '12345', Cur: 'AED', Dr: '1000000.00', Cr: '', Desc: 'old unbalanced' }],
      primaryKeys: pks, sentPks: pks, inputData: [], meta: null, ts: '2026-01-01T00:00:00.000Z'
    }];
    s.selectedRows = {};
    s.data.filter(r => ['D1', 'D2'].includes(r.Doc)).forEach(r => s.selectedRows[r._id] = true);
    Reco.previewEntryFromSelection(true);
    const btn = [...document.querySelectorAll('#appModalFooter button')].find(b => /Generate/.test(b.textContent));
    return { body: document.getElementById('appModalBody').textContent, disabled: btn.disabled, title: btn.title };
  }, tpl.id);
  check(old.disabled === true && /does not balance/.test(old.title),
    'an unbalanced pending from an older build blocks Generate, and the button says why', old.title);
  check(/out by 1000000\.00/.test(old.body) && /will not post|does not balance/.test(old.body),
    'the preview explains which JV is out and by how much, without crashing', old.body.slice(0, 500));
  check(errors.length === 0, 'rendering a preview around a bad legacy pending raises no JS error', errors);

  // commitEntryFromPreview is the only door into entry history — it checks too
  const forced = await page.evaluate((id) => {
    Reco.commitEntryFromPreview();
    return { hist: (AppState.entryHistory[id] || []).length, pend: (AppState.pendingSpecialJV[id] || []).length };
  }, tpl.id);
  check(forced.hist === 0 && forced.pend === 1,
    'calling commitEntryFromPreview directly still refuses the unbalanced JV', forced);

  // the user can get rid of it
  await page.evaluate(() => Reco._removePendingJv('OLD_JV_1'));
  const gone = await page.evaluate((id) => {
    const btn = [...document.querySelectorAll('#appModalFooter button')].find(b => /Generate/.test(b.textContent));
    return { pend: (AppState.pendingSpecialJV[id] || []).length, disabled: btn ? btn.disabled : null };
  }, tpl.id);
  check(gone.pend === 0, 'Discard removes the bad legacy pending', gone);
  await page.evaluate(() => App.closeModal());
  check(errors.length === 0, 'no JavaScript errors in the balance phase', errors);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[3] A JV can only post the rows it was sent');
  await page.evaluate((id) => {
    AppState.pendingSpecialJV[id] = []; AppState.entryHistory[id] = [];
    AppState.docNumberMaster[id] = {};
    AppState.recoSessions[id].data.forEach(r => r.Status = '');
  }, tpl.id);

  await openJv('claim', ['D1', 'D2']);       // sent D1+D2, reports only D5
  const claim = await page.evaluate((id) => {
    const p = (AppState.pendingSpecialJV[id] || [])[0] || {};
    return { pks: p.primaryKeys, notSent: p.claimedNotSent, sent: p.sentPks,
             body: document.getElementById('appModalBody').textContent };
  }, tpl.id);
  check(claim.sent.join() === 'D1,D2' && claim.pks.join() === '' && claim.notSent.join() === 'D5',
    'a key the JV was never sent is dropped from primaryKeys and kept in claimedNotSent', claim);
  check(/never sent/.test(claim.body) && /D5/.test(claim.body),
    'the preview tells the user the JV page reported rows it was not given', claim.body.slice(0, 400));
  await page.click('#appModalFooter button:has-text("Generate")');
  await sleep(500);
  const stamp = await page.evaluate((id) => {
    const s = AppState.recoSessions[id];
    const e = (AppState.entryHistory[id] || [])[0] || {};
    return { status: Object.fromEntries(s.data.map(r => [r.Doc, r.Status])),
             jvPks: (e.specialJvs || []).map(j => j.primaryKeys.join('|')),
             jvNotSent: (e.specialJvs || []).map(j => (j.claimedNotSent || []).join('|')) };
  }, tpl.id);
  check(stamp.status.D5 !== 'Posted', 'D5 is NOT marked Posted by a JV that never received it', stamp.status);
  check(stamp.jvPks.join() === '' && stamp.jvNotSent.join() === 'D5',
    'entry history records the audited key set, and the rejected claim alongside it', stamp);
  await page.evaluate(() => App.closeModal());

  // a JV that reports some real keys and some invented ones
  await page.evaluate((id) => {
    AppState.pendingSpecialJV[id] = []; AppState.entryHistory[id] = [];
    AppState.recoSessions[id].data.forEach(r => r.Status = '');
  }, tpl.id);
  await openJv('claimMix', ['D1', 'D2']);
  await page.click('#appModalFooter button:has-text("Generate")');
  await sleep(500);
  const mix = await page.evaluate((id) => {
    const s = AppState.recoSessions[id];
    return { status: Object.fromEntries(s.data.map(r => [r.Doc, r.Status])),
             jv: ((AppState.entryHistory[id] || [])[0].specialJvs || [])[0] };
  }, tpl.id);
  check(mix.status.D1 === 'Posted' && mix.status.D2 === 'Posted' && mix.status.D5 !== 'Posted' && mix.status.D6 !== 'Posted',
    'the rows it WAS sent are posted; the invented ones are not', mix.status);
  check(mix.jv.primaryKeys.join() === 'D1,D2' && mix.jv.claimedNotSent.sort().join() === 'D5,D6',
    'the intersection is what goes into history', mix.jv);
  await page.evaluate(() => App.closeModal());

  // the defensive intersection also protects a legacy pending
  const legacy = await page.evaluate((id) => {
    const p = { jvId: 'L1', ref: 'FAKE', lines: [], primaryKeys: ['D1', 'D5', 'D9'], sentPks: ['D1', 'D2'] };
    const noSent = { jvId: 'L2', ref: 'FAKE', lines: [], primaryKeys: ['D1', 'D5'] };
    return { consumed: Reco._jvConsumedPks(p), unsent: Reco._jvUnsentClaims(p),
             noSentConsumed: Reco._jvConsumedPks(noSent), noSentUnsent: Reco._jvUnsentClaims(noSent) };
  });
  check(legacy.consumed.join() === 'D1' && legacy.unsent.join() === 'D5,D9',
    '_jvConsumedPks narrows an old unfiltered primaryKeys to what was sent', legacy);
  check(legacy.noSentConsumed.join() === 'D1,D5' && legacy.noSentUnsent.length === 0,
    'a record with no sentPks at all is left as it is (nothing to intersect against)', legacy);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[4] Posted-row tracking and missing accounting references');
  // Rebuild a clean story: one JV entry over D1+D2, D5 posted via a document
  // number, D6 stamped Posted by hand with nothing behind it.
  await page.evaluate((id) => {
    AppState.pendingSpecialJV[id] = []; AppState.entryHistory[id] = [];
    AppState.docNumberMaster[id] = {};
    AppState.recoSessions[id].data.forEach(r => r.Status = '');
  }, tpl.id);
  await openJv('good', ['D1', 'D2']);
  await page.click('#appModalFooter button:has-text("Generate")');
  await sleep(500);
  await page.evaluate(() => App.closeModal());
  const aid = await page.evaluate((id) => (AppState.entryHistory[id] || [])[0].accountingId, tpl.id);

  // a standard entry over D5 (no JV) so its row links through sourceRowIds,
  // and a document number for it
  await page.evaluate(([id, aid]) => {
    const s = AppState.recoSessions[id];
    s.selectedRows = {};
    s.data.filter(r => r.Doc === 'D5').forEach(r => s.selectedRows[r._id] = true);
    Reco.previewEntryFromSelection(true);
  }, [tpl.id, aid]);
  await page.click('#appModalFooter button:has-text("Generate")');
  await sleep(500);
  await page.evaluate(() => App.closeModal());
  // D6: posted by hand, no entry anywhere
  await page.evaluate((id) => {
    const s = AppState.recoSessions[id];
    s.data.find(r => r.Doc === 'D6').Status = 'Posted';
    Reco._postedIdxReset();
  }, tpl.id);

  const audit = await page.evaluate((id) => {
    const tplo = AppState.recoTemplates.find(x => x.id === id);
    const s = AppState.recoSessions[id];
    const a = Reco.postedJvAudit(tplo, s);
    const refOf = d => {
      const row = s.data.find(r => r.Doc === d);
      const h = Reco._postedRefFor(tplo, row);
      return h ? { aid: h.accountingId, via: h.via } : null;
    };
    return { posted: a.posted, linked: a.linked, exceptions: a.exceptions, byJv: a.byJv,
             d1: refOf('D1'), d5: refOf('D5'), d6: refOf('D6'),
             dnm: AppState.docNumberMaster[id] };
  }, tpl.id);
  check(audit.posted === 4 && audit.linked === 3 && audit.exceptions.length === 1,
    '4 rows marked Posted, 3 trace to an entry, 1 does not', { posted: audit.posted, linked: audit.linked, exc: audit.exceptions.length });
  check(audit.exceptions[0].pk === 'D6' && /no entry, document number or Special JV/.test(audit.exceptions[0].reason),
    'the hand-stamped row is the exception, with the reason spelled out', audit.exceptions[0]);
  check(audit.d1 && /Special JV FAKE/.test(audit.d1.via) && audit.d1.aid === audit.byJv[0].accountingId,
    'a JV row resolves through entry.specialJvs[].primaryKeys and names the JV', audit.d1);
  check(audit.d5 && audit.d5.aid && /posted by this entry|entry source row|document number/.test(audit.d5.via),
    'a standard posted row resolves through the entry that produced it', audit.d5);
  check(audit.d5 && audit.d5.via === 'posted by this entry',
    'and it resolves by KEY, the only link that survives a reload', audit.d5);

  // The false positive that matters: session _ids are regenerated when the
  // extract is loaded again, so a link held only as an _id turns every
  // correctly posted row into an exception.
  const reload = await page.evaluate((id) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    const sess = AppState.recoSessions[id];
    sess.data = sess.data.map(r => Object.assign({}, r, { _id: U.uid() }));   // as a re-ingest does
    Reco._postedIdxReset();
    const a = Reco.postedJvAudit(tpl, sess);
    return { posted: a.posted, linked: a.linked, missing: a.missing };
  }, tpl.id);
  check(reload.posted === 4 && reload.linked === 3 && reload.missing === 1,
    'after a reload the posted rows still trace — the exception list does not fill with correctly posted rows', reload);
  check(audit.d6 === null, 'the hand-stamped row has no accounting reference at all', audit.d6);
  check(audit.byJv.length === 1 && audit.byJv[0].ref === 'FAKE' && audit.byJv[0].pks.sort().join() === 'D1,D2',
    'the JV map says which JV posted which rows, under which accounting id', audit.byJv[0]);

  // resolution by document number alone (the key-based link that survives a reload)
  const byDoc = await page.evaluate((id) => {
    const tplo = AppState.recoTemplates.find(x => x.id === id);
    const s = AppState.recoSessions[id];
    const row = s.data.find(r => r.Doc === 'D6');
    AppState.docNumberMaster[id]['D6'] = 'AE_MANUAL_1';
    Reco._postedIdxReset();
    const h = Reco._postedRefFor(tplo, row);
    const a = Reco.postedJvAudit(tplo, s);
    delete AppState.docNumberMaster[id]['D6'];
    Reco._postedIdxReset();
    return { hit: h, exceptions: a.exceptions.length };
  }, tpl.id);
  check(byDoc.hit && byDoc.hit.accountingId === 'AE_MANUAL_1' && /document number D6/.test(byDoc.hit.via),
    'a document number in docNumberMaster is a valid accounting reference', byDoc.hit);
  check(byDoc.exceptions === 0, 'once it has a reference the row leaves the exception list', byDoc.exceptions);

  // ── the grid badge: where the user actually meets this ───────────────────
  await page.evaluate((id) => { AppState.recoSessions[id].activeSection = 'action'; App.navigate('reco'); }, tpl.id);
  await page.waitForSelector('.reco-table-wrap tbody tr', { timeout: 8000 });
  const badges = await page.evaluate(([id, aid]) => {
    const out = {};
    document.querySelectorAll('.reco-table-wrap tbody tr[data-pk]').forEach(tr => {
      const cell = tr.querySelector('td.status-cell');
      out[tr.getAttribute('data-pk')] = {
        ref: !!cell.querySelector('.badge.posted-ref'),
        noref: !!cell.querySelector('.badge.posted-noref'),
        text: cell.textContent.trim()
      };
    });
    return out;
  }, [tpl.id, aid]);
  check(badges.D1 && badges.D1.ref && badges.D1.text.includes(aid),
    'a posted row carries its accounting reference as a badge in the grid', badges.D1);
  check(badges.D6 && badges.D6.noref && /no GL ref/.test(badges.D6.text),
    'a posted row with no accounting reference is badged as an exception', badges.D6);
  check(badges.D3 && !badges.D3.ref && !badges.D3.noref, 'an unposted row gets no badge at all', badges.D3);

  // ── the Manage card and the modal ───────────────────────────────────────
  await page.evaluate((id) => { AppState.recoSessions[id].activeSection = 'manage'; App.navigate('reco'); }, tpl.id);
  const card = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#recoContentArea .card')]
      .find(c => /Posted-JV Tracking/.test(c.textContent));
    return { found: !!el, text: el ? el.textContent : '', opens: el ? /openPostedJvAuditModal/.test(el.getAttribute('onclick') || '') : false };
  });
  check(card.found && /missing one/.test(card.text) && card.opens,
    'Manage has a Posted-JV Tracking card that counts the exceptions and opens the list', card);

  await page.evaluate(() => Reco.openPostedJvAuditModal());
  const modal = await page.evaluate(() => document.getElementById('appModalBody').textContent);
  check(/Posted without an accounting reference \(1\)/.test(modal) && /D6/.test(modal),
    'the modal lists the exception', modal.slice(0, 300));
  check(/Which Special JV posted which rows \(1\)/.test(modal) && /FAKE/.test(modal),
    'the modal shows the JV dimension the user asked for', modal.slice(0, 600));

  // exports reach the disk through the save dialog
  const dl = path.join(path.dirname(rootB), 'downloads_18962');
  await page.evaluate(() => Reco.exportPostedJvExceptions());
  await sleep(600);
  await page.evaluate(() => Reco.exportPostedJvMap());
  await sleep(600);
  const files = fs.existsSync(dl) ? fs.readdirSync(dl) : [];
  const excF = files.find(f => /^posted_without_reference_/.test(f));
  const mapF = files.find(f => /^posted_jv_map_/.test(f));
  const excCsv = excF ? fs.readFileSync(path.join(dl, excF), 'utf8') : '';
  check(excF && /^PrimaryKey,DocumentNumberColumn,DocumentNumber,PostedColumn,PostedValue,AmountColumn,Amount,Reason/.test(excCsv)
    && /^D6,/m.test(excCsv) && /no entry, document number or Special JV/.test(excCsv),
    'the exception list exports to CSV with fixed headers and the reason', excCsv.split('\n').slice(0, 2));
  const mapCsv = mapF ? fs.readFileSync(path.join(dl, mapF), 'utf8') : '';
  check(mapF && /JvId,JvTemplate,AccountingId/.test(mapCsv) && /FAKE,/.test(mapCsv) && mapCsv.includes(aid),
    'the JV → rows → accounting id map exports to CSV', mapF);
  await page.evaluate(() => App.closeModal());

  // a template that does not stamp anything has nothing to track
  const unconf = await page.evaluate((id) => {
    const tplo = AppState.recoTemplates.find(x => x.id === id);
    const keep = tplo.aegIntegration.postEntryColumn;
    tplo.aegIntegration.postEntryColumn = '';
    const a = Reco.postedJvAudit(tplo, AppState.recoSessions[id]);
    Reco.openPostedJvAuditModal();
    const body = document.getElementById('appModalBody').textContent;
    App.closeModal();
    tplo.aegIntegration.postEntryColumn = keep;
    Reco._postedIdxReset();
    return { configured: a.configured, posted: a.posted, body };
  }, tpl.id);
  check(!unconf.configured && unconf.posted === 0 && /nothing to track/.test(unconf.body),
    'with no post-entry column the audit is empty and says so instead of guessing', unconf);

  // it survives a reload from the shared folder
  await page.evaluate(() => AppState.flush());
  await page.reload();
  await page.waitForSelector('#appMain .panel');
  const reloaded = await page.evaluate((id) => {
    const tplo = AppState.recoTemplates.find(x => x.id === id);
    const a = Reco.postedJvAudit(tplo, AppState.recoSessions[id]);
    return { posted: a.posted, linked: a.linked, exc: a.exceptions.map(x => x.pk), byJv: a.byJv.length };
  }, tpl.id);
  check(reloaded.posted === 4 && reloaded.linked === 3 && reloaded.exc.join() === 'D6' && reloaded.byJv === 1,
    'the audit reads the same after a reload (the links are key-based)', reloaded);
  check(errors.length === 0, 'no JavaScript errors in the tracking phase', errors);
  await ctx.close();

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[5] The real TCH page still works end to end');
  const rootC = makeRoot('rootC');
  const BC = await startBridge(rootC, 18963); procs.push(BC.proc);
  ({ page, errors, ctx } = await openReco(browser, BC));
  const tplT = await createTemplate(page, 'TCH Host', TCH_ROWS);
  await page.evaluate((id) => {
    const s = AppState.recoSessions[id];
    s.selectedRows = {};
    s.data.filter(r => ['D1', 'D2', 'D3', 'D4'].includes(r.Doc)).forEach(r => s.selectedRows[r._id] = true);
    Reco.previewEntryFromSelection(true);
  }, tplT.id);
  await page.click('#appModalBody button:has-text("Complete")');
  const jv = page.frameLocator('#specialJvFrame');
  await jv.locator('#rowsTable tbody tr').first().waitFor({ timeout: 10000 });
  check(await jv.locator('#rowsTable tbody tr').count() === 4, 'TCH still receives its 4 rows through the handshake');
  await jv.locator('.tch-card select').first().selectOption('0');
  await jv.locator('button:has-text("Auto-assign by period")').click();
  const sale = jv.locator('td.input input').first();
  await sale.click();
  await sale.pressSequentially('7000');
  await jv.locator('td.input input').nth(1).fill('5000');
  await jv.locator('button:has-text("Generate Lines")').click();
  await page.waitForSelector('#appModalBody .badge.offset', { timeout: 10000 });
  const tchPend = await page.evaluate((id) => {
    const p = (AppState.pendingSpecialJV[id] || [])[0] || {};
    const btn = [...document.querySelectorAll('#appModalFooter button')].find(b => /Generate/.test(b.textContent));
    return { n: (AppState.pendingSpecialJV[id] || []).length, lines: (p.lines || []).length,
             pks: (p.primaryKeys || []).slice().sort().join(), notSent: (p.claimedNotSent || []).length,
             disabled: btn.disabled, body: document.getElementById('appModalBody').textContent };
  }, tplT.id);
  check(tchPend.n === 1 && tchPend.lines === 8, 'the real TCH page still produces its 8 lines', tchPend);
  check(tchPend.pks === 'D1,D2,D4' && tchPend.notSent === 0,
    'TCH consumes D1, D2, D4 and claims nothing it was not sent', tchPend);
  check(tchPend.disabled === false, 'TCH lines balance, so Generate is enabled', tchPend.disabled);
  // TCH posts in RUB, USD and EUR; each bucket must show its own Dr/Cr and a tick.
  const tchCcy = (tchPend.body.match(/[A-Z]{3}: Dr \d+\.\d\d \/ Cr \d+\.\d\d ✓/g) || []);
  check(tchCcy.length >= 3 && !/out by/.test(tchPend.body),
    'the preview shows TCH\'s own per-currency totals, each balanced', tchCcy);
  const tchChk = await page.evaluate((id) => {
    const tplo = AppState.recoTemplates.find(x => x.id === id);
    const aegTpl = AppState.aegTemplates.find(t => t.id === tplo.aegIntegration.aegTemplateId);
    const p = AppState.pendingSpecialJV[id][0];
    const r = SpecialJV.checkLines(p.lines, Reco._jvLineCols(aegTpl));
    return { ok: r.ok, problems: r.problems, totals: r.totals };
  }, tplT.id);
  check(tchChk.ok && !tchChk.problems.length, 'checkLines passes the real TCH output unchanged', tchChk);

  await page.click('#appModalFooter button:has-text("Generate")');
  await page.waitForSelector('#appModalTitle:has-text("Allocate")', { timeout: 5000 });
  const tchEnt = await page.evaluate((id) => {
    const s = AppState.recoSessions[id];
    const tplo = AppState.recoTemplates.find(x => x.id === id);
    const e = (AppState.entryHistory[id] || [])[0];
    const a = Reco.postedJvAudit(tplo, s);
    return { lines: e.lines.length, status: Object.fromEntries(s.data.map(r => [r.Doc, r.Status])),
             jv: e.specialJvs[0], posted: a.posted, linked: a.linked, exc: a.exceptions.length };
  }, tplT.id);
  check(tchEnt.lines === 8 && tchEnt.status.D1 === 'Posted' && tchEnt.status.D4 === 'Posted' && tchEnt.status.D3 !== 'Posted',
    'the TCH entry posts only the rows TCH consumed (D3 was sent but unassigned)', tchEnt.status);
  check(tchEnt.jv.ref === 'TCH' && tchEnt.jv.primaryKeys.slice().sort().join() === 'D1,D2,D4',
    'entry history records TCH\'s audited key set', tchEnt.jv);
  check(tchEnt.posted === 3 && tchEnt.linked === 3 && tchEnt.exc === 0,
    'every row TCH posted has an accounting reference — no exceptions', tchEnt);
  await page.evaluate(() => App.closeModal());
  check(errors.length === 0, 'no JavaScript errors driving the real TCH page', errors);
  await ctx.close();

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[6] A JV short code that is also a name on Object.prototype');
  /* The check at [1] only says these names do not resolve when nothing claims
     them. They are legal refs, so a hand-written special_jv_mapping/
     constructor.json registers one, and then every map keyed by the ref is
     being indexed with "constructor". The entry path's own jvBuckets was a
     plain {}, so jvBuckets["constructor"] answered with Object, .push was not
     a function, and Preview Entry did NOTHING — no modal, no toast, the only
     diagnostic an uncaught TypeError in a console a finance user in a WebView2
     window cannot open. */
  const rootD = makeRoot('rootD', { protoRefs: true });
  const BD = await startBridge(rootD, 19640); procs.push(BD.proc);
  ({ page, errors, ctx } = await openReco(browser, BD));
  const tplP = await createTemplate(page, 'Proto Host', PROTO_ROWS);
  const regP = await page.evaluate(() => ({
    keys: Object.keys(SpecialJV.registry).sort(),
    resolves: ['constructor', 'toString', 'valueOf'].map(r => SpecialJV.isJvRef(r)),
    problems: Store.loadProblems.slice()
  }));
  check(regP.keys.join() === 'FAKE,TCH,constructor,toString,valueOf' && regP.resolves.every(Boolean),
    'a mapping may legitimately be named "constructor", "toString" or "valueOf"', regP);
  check(regP.problems.length === 0, 'and none of them is refused at load', regP.problems);
  /* get() already guards with hasOwnProperty, so the registry losing its null
     prototype changes nothing anyone can observe — which is exactly why it is
     asserted here and not inferred from behaviour. */
  check(await page.evaluate(() => Object.getPrototypeOf(SpecialJV.registry) === null),
    'the registry they are keyed into is built with no prototype');
  await page.evaluate(() => App.closeModal());

  // The real button, in the grid, with nothing selected — all three open rows.
  await page.evaluate((id) => { AppState.recoSessions[id].activeSection = 'action'; App.navigate('reco'); }, tplP.id);
  await page.waitForSelector('.reco-table-wrap tbody tr', { timeout: 8000 });
  await page.click('button.small.primary:has-text("Preview Entry")');
  await sleep(900);
  const proto = await page.evaluate(() => {
    const pe = Reco._pendingEntry || {};
    const b = pe.jvBuckets || {};
    return {
      title: (document.getElementById('appModalTitle') || {}).textContent || '',
      body: (document.getElementById('appModalBody') || {}).textContent || '',
      refs: Object.keys(b).sort(),
      pks: Object.keys(b).sort().map(k => (Array.isArray(b[k]) ? b[k].map(r => r._pk).join('+') : 'NOT AN ARRAY')),
      bare: !!pe.jvBuckets && Object.getPrototypeOf(pe.jvBuckets) === null
    };
  });
  check(/Entry Preview/.test(proto.title), 'Preview Entry opens its modal instead of doing nothing at all', proto.title);
  check(proto.refs.join() === 'constructor,toString,valueOf' && proto.pks.join() === 'D1,D2,D3',
    'each row is bucketed to the JV its To Account names', proto);
  check(PROTO_REFS.every(r => proto.body.indexOf('Proto ' + r) >= 0) && /1 selected row\(s\) target this JV/.test(proto.body),
    'and all three are listed as outstanding Special JV requirements', proto.body.slice(0, 400));
  // Belt and braces: the map has no prototype at all, so a ref nobody thought
  // of cannot come back as something inherited either.
  check(proto.bare, 'the bucket map is built with no prototype, not as a plain {}', proto.bare);

  // ...and the JV actually runs: Complete, and the lines come back under that ref.
  await page.evaluate(() => { window._fakeMode = 'good'; });
  await page.click('#appModalBody button:has-text("Complete Proto constructor")');
  await sleep(900);
  const ctorDone = await page.evaluate((id) => {
    const p = (AppState.pendingSpecialJV[id] || [])[0] || {};
    return { n: (AppState.pendingSpecialJV[id] || []).length, ref: p.ref, lines: (p.lines || []).length,
             pks: (p.primaryKeys || []).join(), title: (document.getElementById('appModalTitle') || {}).textContent || '' };
  }, tplP.id);
  check(ctorDone.n === 1 && ctorDone.ref === 'constructor' && ctorDone.lines === 2 && ctorDone.pks === 'D1',
    'the JV named "constructor" completes and its lines are held under that ref', ctorDone);
  check(/Entry Preview/.test(ctorDone.title) && errors.length === 0,
    'the whole round trip raises no JavaScript error', errors);
  await page.evaluate(() => App.closeModal());
  await ctx.close();

} finally {
  clearTimeout(watchdog);
  await browser.close();
  killAll();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
