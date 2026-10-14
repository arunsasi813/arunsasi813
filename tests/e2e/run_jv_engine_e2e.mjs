// End-to-end tests for the spec-driven Special JV engine
// (special_jv_templates/_engine/) through the REAL Reco, against the real
// Python LauncherAPI (tests/e2e/bridge_server.py stands in for pywebview).
//
//   node tests/e2e/run_jv_engine_e2e.mjs
//
// The headline test is deliberately a copy of the TCH block of
// tests/e2e/run_e2e.mjs: the same four rows, the same clicks, the same
// assertions — but driving special_jv_templates/EXAMPLE_TCH.html, a generated
// page with no script of its own, whose maths is a JSON spec. If the two
// agree, a Special JV can be a JSON record instead of new JavaScript on a
// shared network folder.
//
// Needs: python3, Playwright (Chromium). Exits non-zero on the first failure.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

let pw;
try { pw = await import('playwright'); }
catch { pw = await import('/opt/node22/lib/node_modules/playwright/index.mjs'); }
const { chromium } = pw;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const OS_USER = os.userInfo().username;
const require = createRequire(import.meta.url);
const JVCore = require(path.join(REPO, 'special_jv_templates/_engine/jv-core-1.0.0.js'));

const PORT = 19100, JVPORT = 19101;
let failures = 0, passes = 0;
function check(cond, msg, extra) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── the test share ─────────────────────────────────────────────────────────
   Built the way run_e2e.mjs builds its root, plus the _engine folder and the
   generated example page. The example's mapping is written from the page's own
   JSON island, which is also the proof that the island round-trips: if the
   escaping were wrong the mapping would not parse. */
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-engine-e2e-'));
const root = path.join(base, 'root');
const cp = (src, dst) => {
  fs.mkdirSync(path.dirname(path.join(root, dst)), { recursive: true });
  fs.copyFileSync(path.join(REPO, src), path.join(root, dst));
};
cp('apps/Reco.html', 'apps/Reco.html');
for (const f of fs.readdirSync(path.join(REPO, 'apps/lib'))) cp('apps/lib/' + f, 'apps/lib/' + f);
cp('special_jv_templates/TCH.html', 'special_jv_templates/TCH.html');
cp('special_jv_mapping/TCH.json', 'special_jv_mapping/TCH.json');
cp('special_jv_templates/EXAMPLE_TCH.html', 'special_jv_templates/EXAMPLE_TCH.html');
cp('special_jv_templates/_engine/jv-core-1.0.0.js', 'special_jv_templates/_engine/jv-core-1.0.0.js');
cp('special_jv_templates/_engine/jv-page-1.0.0.js', 'special_jv_templates/_engine/jv-page-1.0.0.js');
cp('special_jv_templates/_engine/jv-page-1.0.0.css', 'special_jv_templates/_engine/jv-page-1.0.0.css');
fs.mkdirSync(path.join(root, 'master'), { recursive: true });
fs.writeFileSync(path.join(root, 'master/user.csv'), `ID,Name,Email,reco\r\n${OS_USER},Test User,,1\r\n`);
fs.writeFileSync(path.join(root, 'master/accounts_master.csv'),
  'Reference,RC,Nominal,SubNominal,AnalysisKey,LOB\r\nACC1,100,12345,0,0,51\r\nBANK,200,11111,0,0,51\r\n');

const ISLAND_RE = /<script type="application\/json" id="jvDef">([\s\S]*?)<\/script>/;
const EXAMPLE_HTML = fs.readFileSync(path.join(root, 'special_jv_templates/EXAMPLE_TCH.html'), 'utf8');
const EXAMPLE_DEF = JSON.parse(EXAMPLE_HTML.match(ISLAND_RE)[1]);
fs.writeFileSync(path.join(root, 'special_jv_mapping/EXAMPLE_TCH.json'), JSON.stringify(EXAMPLE_DEF, null, 2));

/* The same escaping the generator uses (D13/V4): JSON escapes, never HTML
   entities, so '&' survives and the element cannot be terminated early. */
const islandText = obj => JSON.stringify(obj, null, 2)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
/* A sibling JV, from the same shell: a new ref, a mutated definition. Used to
   exercise the ways a spec can be wrong without touching the example itself. */
function makeJv(ref, mutate, opts) {
  const def = JSON.parse(JSON.stringify(EXAMPLE_DEF));
  def.ref = ref;
  def.displayName = ref;
  mutate(def);
  const pageDef = (opts && opts.pageDef) ? opts.pageDef(JSON.parse(JSON.stringify(def))) : def;
  const html = EXAMPLE_HTML
    .replace(/<meta name="jv-ref" content="[^"]*" \/>/, '<meta name="jv-ref" content="' + ref + '" />')
    .replace(ISLAND_RE, () => '<script type="application/json" id="jvDef">' + islandText(pageDef) + '</script>');
  fs.writeFileSync(path.join(root, 'special_jv_templates/' + ref + '.html'), html);
  if (!(opts && opts.noMapping)) {
    fs.writeFileSync(path.join(root, 'special_jv_mapping/' + ref + '.json'), JSON.stringify(def, null, 2));
  }
  return def;
}

// A spec whose amount names a total that does not exist.
makeJv('BROKENJV', d => { d.jvSpec.entries[0].amount = 'rubEqUsd + rapid_GBP'; });
// A spec written by a newer Reco than this one.
makeJv('NEWERJV', d => { d.jvSpec.specVersion = 2; });
// A page whose embedded copy was edited by hand after it was generated.
makeJv('DRIFTJV', d => {}, { pageDef: d => { d.accounts.clearing.nominal = '99999'; return d; } });
// Narration carrying markup: it must round-trip through the island and render
// as text, with no element injected (R-01).
const HOSTILE = 'Charges </script><img src=x onerror=window.__pwned=1> for <A & B>';
makeJv('XSSJV', d => {
  d.jvSpec.remarks.templates.ccAdj = HOSTILE;
  d.jvSpec.remarks.templates.bsp = HOSTILE;
});

/* A minimal stand-in for Reco, same-origin with the JV page, used to prove the
   page refuses a definition addressed to another JV. */
fs.writeFileSync(path.join(root, 'special_jv_templates/_harness.html'),
  '<!DOCTYPE html><html><body><script>\n'
  + 'window._specialJvRef = "OTHERJV";\n'
  + 'window._specialJvInputs = [];\n'
  + 'window._specialJvDef = ' + JSON.stringify({ ref: 'OTHERJV', displayName: 'Other', inputColumns: [], accounts: {}, jvSpec: EXAMPLE_DEF.jvSpec }) + ';\n'
  + 'document.write(\'<iframe id="f" src="EXAMPLE_TCH.html" style="width:99%;height:600px"></iframe>\');\n'
  + '</script></body></html>\n');

const procs = [];
const killAll = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });
process.on('exit', killAll);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { killAll(); process.exit(130); }));
const watchdog = setTimeout(() => {
  console.error('\nWATCHDOG: run exceeded 4 minutes; last check: ' + (passes + failures));
  killAll();
  process.exit(2);
}, 240000);

const proc = spawn('python3', [path.join(HERE, 'bridge_server.py'), root, String(PORT), '--jv-port', String(JVPORT)],
  { stdio: ['ignore', 'pipe', 'inherit'] });
procs.push(proc);
await new Promise((res, rej) => {
  proc.stdout.on('data', d => { if (String(d).includes('READY')) res(); });
  proc.on('exit', c => rej(new Error('bridge exited ' + c)));
});

const browser = await chromium.launch();
const ctx = await browser.newContext();
const shim = await (await fetch(`http://127.0.0.1:${PORT}/__shim.js`)).text();
await ctx.addInitScript(shim);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
page.on('dialog', d => d.accept());

const ROWS = [
  { Doc: 'D1', Date: '06/10/2026', 'Txn Type': 'RAPID', Currency: 'USD', 'FC Amount': '100',   AED: '367',  ToAccount: 'EXAMPLE_TCH', Status: '' },
  { Doc: 'D2', Date: '07/10/2026', 'Txn Type': 'RAPID', Currency: 'EUR', 'FC Amount': '50',    AED: '200',  ToAccount: 'EXAMPLE_TCH', Status: '' },
  { Doc: 'D3', Date: '12/10/2026', 'Txn Type': 'OF01',  Currency: 'RUB', 'FC Amount': '-9000', AED: '-400', ToAccount: 'EXAMPLE_TCH', Status: '' },
  { Doc: 'D4', Date: '08/10/2026', 'Txn Type': 'RAPID', Currency: 'RUB', 'FC Amount': '5000',  AED: '220',  ToAccount: 'EXAMPLE_TCH', Status: '' }
];
const FIELDS = Object.keys(ROWS[0]);

try {
  await page.goto(`http://127.0.0.1:${PORT}/apps/Reco.html`);
  await page.waitForSelector('#appMain .panel', { timeout: 20000 });

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[1] registration: a JV is a filename and a JSON file, nothing else');
  const reg = await page.evaluate(() => Object.keys(SpecialJV.registry).sort());
  check(reg.join() === 'BROKENJV,DRIFTJV,EXAMPLE_TCH,NEWERJV,TCH,XSSJV',
        'the generated pages register beside TCH with no change to Reco', reg);
  const refChecks = await page.evaluate(() => ({
    underscore: SpecialJV.refProblem('_EXAMPLE_TCH'),
    engine: SpecialJV.refProblem('_engine'),
    example: SpecialJV.refProblem('EXAMPLE_TCH')
  }));
  check(!!refChecks.underscore && !!refChecks.engine && refChecks.example === null,
        'a ref may not start with "_" (which is why the example page is EXAMPLE_TCH.html, not _EXAMPLE_TCH.html)', refChecks);
  const loadProblems = await page.evaluate(() => Store.loadProblems.slice());
  check(loadProblems.length === 0, 'no mapping was refused at load', loadProblems);

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[2] the same four rows, the same clicks, the same figures as TCH');
  const tpl = await page.evaluate(([rows, fields]) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.name = 'JV Engine';
    t.columns = fields.map(n => ({ name: n, label: n, formats: [], isValue: n === 'AED', isDate: n === 'Date' }));
    t.primaryKeys = ['Doc'];
    t.valueColumn = 'AED';
    t.editableColumns = ['ToAccount', 'Status'];
    t.displayColumns = t.columns.map(c => c.name);
    t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id, keywordColumn: '',
                         keywordValues: '', postEntryColumn: 'Status', postEntryValue: 'Posted' };
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.name === 'JV Engine');
    RecoTemplate.open(tpl.id);
    Reco.ingestData(tpl, rows, fields);
    return tpl.id;
  }, [ROWS, FIELDS]);

  await page.evaluate((id) => {
    const s = AppState.recoSessions[id];
    s.selectedRows = {};
    s.data.forEach(r => s.selectedRows[r._id] = true);
    Reco.previewEntryFromSelection(true);
  }, tpl);
  check(await page.isDisabled('#appModalFooter button:has-text("Generate")'), 'Generate blocked until the JV is completed');
  await page.click('#appModalBody button:has-text("Complete")');

  let jv = page.frameLocator('#specialJvFrame');
  await jv.locator('#rowsTable tbody tr').first().waitFor({ timeout: 15000 });
  check(await jv.locator('#rowsTable tbody tr').count() === 4,
        'the generated page received 4 rows through the postMessage handshake (parent not readable)');
  const notes = await jv.locator('#rowsTable tbody td.note').allTextContents();
  check(notes.join('|') === 'RAPID|RAPID|OF|RAPID', 'each row is labelled with the row type the spec classified it as', notes);

  await jv.locator('.tch-card select').first().selectOption('0');          // 1-10 Oct 2026
  const periodFrom = await jv.locator('.tch-card input[placeholder="MM/DD/YY"]').first().inputValue();
  check(periodFrom === '10/01/26', 'preset fills MM/DD/YY period', periodFrom);
  await jv.locator('button:has-text("Auto-assign by period")').click();
  const sale = jv.locator('td.input input').first();
  await sale.click();
  await sale.pressSequentially('7000');                                     // focus must survive each keystroke
  await jv.locator('td.input input').nth(1).fill('5000');
  check(await sale.inputValue() === '7000', 'typing in Sale Data keeps focus (value 7000)');
  const t1 = await jv.locator('td.computed').allTextContents();
  check(t1.join('|') === '5,000.00|100.00|50.00|0.00',
        'Rapid RUB/USD/EUR and OF totals from auto-assigned rows (D3 outside period)', t1);
  const badge = await jv.locator('.rows-badge').first().textContent();
  check(/^3 row\(s\) assigned$/.test(badge.trim()), 'the section badge counts the rows it used', badge);

  await jv.locator('button:has-text("Generate Lines")').click();            // confirm() for unassigned D3 auto-accepted
  await page.waitForSelector('#appModalBody .badge.offset', { timeout: 15000 });
  const pend = await page.evaluate((id) => AppState.pendingSpecialJV[id], tpl);
  check(pend.length === 1 && pend[0].lines.length === 8, 'completed JV stored with 8 lines', pend && pend.map(p => p.lines.length));
  const L = pend[0].lines;
  check(L[0].Desc === 'Cross Currency Adjustment Entry for 01 Oct - 10 Oct 26',
        'remark uses the real period (MM/DD parsed correctly)', L[0].Desc);
  check(L[0].Nominal === '17036' && L[0].Dr === '12000.00' && L[1].Nominal === '85001' && L[1].Cr === '12000.00',
        'entry 1 Dr 17036 / Cr 85001 12,000', L.slice(0, 2));
  check(L[2].Nominal === '85001' && L[2].Cur === 'USD' && L[2].Dr === '100.00', 'entry 2 Dr 85001 100.00 USD', L[2]);
  check(L[4].Cur === 'EUR' && L[4].Dr === '50.00', 'entry 3 EUR 50.00', L[4]);
  check(L[6].Nominal === '17036' && L[6].Dr === '17000.00' && L[7].Nominal === '35008' && L[7].RC === '50000',
        'entry 4 negative → sides swapped (Dr clearing, Cr charges)', L.slice(6));
  check(L.every(l => l.SubNominal === '0' && l['Analysis Key'] === '0' && l.LOB === '51' && l.Reference === '' && l.Doc === ''),
        'the shared account fields are on every line');
  check(L.every(l => l.Reco === 'TCH1'), 'Reco defaults to TCH1 when the code is left empty', L[0].Reco);
  check(L.every(l => Object.keys(l).join('|') === JVCore.LINE_ORDER.join('|')),
        'every line carries the 12 AEG keys in the output order', Object.keys(L[0]));
  check(pend[0].primaryKeys.slice().sort().join() === 'D1,D2,D4', 'JV consumed D1, D2, D4 only', pend[0].primaryKeys);
  check(pend[0].meta && pend[0].meta.engine === '1.0.0' && /^fnv1a:[0-9a-f]{16}$/.test(pend[0].meta.specHash || ''),
        'meta records the engine version and the hash of the spec that produced the figures',
        pend[0].meta && { engine: pend[0].meta.engine, specHash: pend[0].meta.specHash, drift: pend[0].meta.drift });
  check(pend[0].meta.specHash === JVCore.specHash(EXAMPLE_DEF) && pend[0].meta.declaredSpecHash === pend[0].meta.specHash,
        'the hash computed in the page matches the file on disk and the hash the page claims',
        { got: pend[0].meta.specHash, want: JVCore.specHash(EXAMPLE_DEF) });

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[3] commit: the lines become an entry like any other');
  check(!(await page.isDisabled('#appModalFooter button:has-text("Generate")')), 'Generate enabled after completion');
  await page.click('#appModalFooter button:has-text("Generate")');
  await page.waitForSelector('#appModalTitle:has-text("Allocate")', { timeout: 10000 });
  const ent = await page.evaluate((id) => {
    const s = AppState.recoSessions[id];
    const h = (AppState.entryHistory[id] || []);
    return { hist: h.length, lines: (h[0] || {}).lines ? h[0].lines.length : 0,
             jvRef: ((h[0] || {}).specialJvs || [{}])[0].ref,
             postedPks: ((h[0] || {}).postedPks || []).slice().sort(),
             status: Object.fromEntries(s.data.map(r => [r._pk, r.Status])),
             pend: (AppState.pendingSpecialJV[id] || []).length };
  }, tpl);
  check(ent.hist === 1 && ent.lines === 8 && ent.pend === 0 && ent.jvRef === 'EXAMPLE_TCH',
        'one entryHistory record with the JV lines; pending cleared', ent);
  check(ent.status.D1 === 'Posted' && ent.status.D4 === 'Posted' && ent.status.D3 !== 'Posted',
        'the post-entry value lands only on the rows the JV consumed', ent.status);
  check(ent.postedPks.join() === 'D1,D2,D4', 'the entry records which keys the JV closed', ent.postedPks);
  await page.evaluate(() => App.closeModal());

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[4] a spec that cannot run fails closed, with a sentence');
  async function openJv(ref) {
    await page.evaluate(([id, ref]) => {
      AppState.pendingSpecialJV[id] = [];
      const s = AppState.recoSessions[id];
      s.data.forEach(r => { r.ToAccount = ref; r.Status = ''; });
      s.selectedRows = {};
      s.data.forEach(r => s.selectedRows[r._id] = true);
      Reco.previewEntryFromSelection(true);
    }, [tpl, ref]);
    await page.click('#appModalBody button:has-text("Complete")');
    return page.frameLocator('#specialJvFrame');
  }
  let f = await openJv('BROKENJV');
  await f.locator('.jv-fatal').waitFor({ timeout: 15000 });
  const brokenText = await f.locator('.jv-fatal').textContent();
  check(/unknown name "rapid_GBP"/.test(brokenText), 'a bad amount names itself and no form is drawn', brokenText.replace(/\s+/g, ' ').trim().slice(0, 160));
  check(await f.locator('td.computed').count() === 0 && await f.locator('td.input input').count() === 0,
        'the refusing page offers no inputs at all — there is nothing to submit');
  check(await page.evaluate((id) => (AppState.pendingSpecialJV[id] || []).length, tpl) === 0, 'the broken JV recorded nothing');
  await page.evaluate(() => SpecialJV._cancel());

  f = await openJv('NEWERJV');
  await f.locator('.jv-fatal').waitFor({ timeout: 15000 });
  const newerText = await f.locator('.jv-fatal').textContent();
  check(/spec version 2/.test(newerText) && /Update Reco/.test(newerText),
        'a JV from a newer Reco says so instead of guessing', newerText.replace(/\s+/g, ' ').trim().slice(0, 160));
  await page.evaluate(() => SpecialJV._cancel());

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[5] a hand-edited page is detected, and the mapping wins');
  f = await openJv('DRIFTJV');
  await f.locator('#summary').waitFor({ timeout: 15000 });
  const warn = (await f.locator('.jv-warn').count()) ? await f.locator('.jv-warn').textContent() : '';
  check(/differ/.test(warn), 'the engine compares the embedded island with the mapping and warns', warn.trim());
  const accText = await f.locator('#summary').textContent();
  check(/clearing 17036/.test(accText) && !/99999/.test(accText),
        'the hand-edited nominal in the page is ignored; the mapping JSON is used', accText.replace(/\s+/g, ' ').trim());
  await page.evaluate(() => SpecialJV._cancel());

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[6] markup in the data renders as text, and injects nothing');
  f = await openJv('XSSJV');
  await f.locator('#rowsTable tbody tr').first().waitFor({ timeout: 15000 });
  await f.locator('.tch-card select').first().selectOption('0');
  await f.locator('button:has-text("Auto-assign by period")').click();
  await f.locator('td.input input').first().fill('7000');
  await f.locator('td.input input').nth(1).fill('5000');
  await f.locator('button:has-text("Show Preview")').click();
  const inj = await page.evaluate(() => {
    const fr = document.getElementById('specialJvFrame');
    return { pwned: !!window.__pwned, canSee: !!(fr && fr.contentDocument) };
  });
  const imgs = await f.locator('img').count();
  const previewText = await f.locator('#previewPane').textContent();
  check(imgs === 0 && !inj.pwned, 'no element was injected by the narration', { imgs, inj });
  check(previewText.indexOf(HOSTILE) >= 0, 'the narration is shown verbatim, as text', previewText.slice(0, 120));
  await f.locator('button:has-text("Generate Lines")').click();
  await page.waitForSelector('#appModalBody .badge.offset', { timeout: 15000 });
  const xss = await page.evaluate((id) => AppState.pendingSpecialJV[id][0].lines[0].Desc, tpl);
  check(xss === HOSTILE, 'the host receives the same bytes the spec declared', xss);
  const hostImgs = await page.evaluate(() => document.querySelectorAll('#appModalBody img').length);
  check(hostImgs === 0 && !(await page.evaluate(() => !!window.__pwned)), 'and nothing is injected into Reco either', hostImgs);
  await page.evaluate(() => SpecialJV._cancel());

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[7] a page addressed to another JV refuses to compute');
  const harness = await ctx.newPage();
  const hErrors = [];
  harness.on('pageerror', e => hErrors.push(e.message));
  await harness.goto(`http://127.0.0.1:${PORT}/special_jv_templates/_harness.html`);
  const hf = harness.frameLocator('#f');
  await hf.locator('.jv-fatal').waitFor({ timeout: 15000 });
  const hText = await hf.locator('.jv-fatal').textContent();
  check(/This page is EXAMPLE_TCH/.test(hText) && /OTHERJV/.test(hText),
        'EXAMPLE_TCH.html cannot be made to run OTHERJV\'s maths', hText.replace(/\s+/g, ' ').trim().slice(0, 140));
  check(!hErrors.length, 'and it does so without a script error', hErrors);
  await harness.close();

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[8] the page on its own, and with the engine missing');
  const solo = await ctx.newPage();
  const soloErr = [];
  solo.on('pageerror', e => soloErr.push(e.message));
  solo.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) soloErr.push(m.text()); });
  await solo.goto(`http://127.0.0.1:${JVPORT}/special_jv_templates/EXAMPLE_TCH.html`);
  await solo.waitForSelector('#summary', { timeout: 15000 });
  const soloText = await solo.textContent('#summary');
  check(/No rows received from Reco/.test(soloText) && !soloErr.length,
        'opened from the folder it renders a usable, empty form from its own island',
        { soloText: soloText.replace(/\s+/g, ' ').trim().slice(0, 100), soloErr });
  check(await solo.locator('td.input input').count() === 5, 'the typed fields come from the embedded spec, with no network fetch',
        await solo.locator('td.input input').count());
  check(/Example — TCH JV/.test(await solo.textContent('h2')), 'the title comes from the spec', await solo.textContent('h2'));
  await solo.close();

  const noeng = await ctx.newPage();
  await noeng.route('**/_engine/jv-core-1.0.0.js', r => r.abort());
  await noeng.goto(`http://127.0.0.1:${JVPORT}/special_jv_templates/EXAMPLE_TCH.html`);
  await noeng.waitForTimeout(900);
  const missing = await noeng.textContent('#jvRoot');
  check(/jv-core-1\.0\.0\.js/.test(missing) && /missing/.test(missing),
        'with the engine missing the static shell text names the file', missing.replace(/\s+/g, ' ').trim().slice(0, 140));
  await noeng.close();

  const nopage = await ctx.newPage();
  await nopage.route('**/_engine/jv-page-1.0.0.js', r => r.abort());
  await nopage.goto(`http://127.0.0.1:${JVPORT}/special_jv_templates/EXAMPLE_TCH.html`);
  await nopage.waitForTimeout(900);
  check(/jv-core-1\.0\.0\.js/.test(await nopage.textContent('#jvRoot')),
        'with the page layer missing the shell still says something readable');
  await nopage.close();

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[9] the real TCH page still behaves exactly as before');
  f = await openJv('TCH');
  await f.locator('#rowsTable tbody tr').first().waitFor({ timeout: 15000 });
  await f.locator('.tch-card select').first().selectOption('0');
  await f.locator('button:has-text("Auto-assign by period")').click();
  await f.locator('td.input input').first().fill('7000');
  await f.locator('td.input input').nth(1).fill('5000');
  const tchTotals = await f.locator('td.computed').allTextContents();
  check(tchTotals.join('|') === '5,000.00|100.00|50.00|0.00', 'TCH.html reads the mapping with the new jvSpec block unchanged', tchTotals);
  const tchCols = await f.locator('#rowsTable thead th').allTextContents();
  check(tchCols.join('|') === 'TCH|Date|Txn Type|Currency|FC Amount|Note',
        'and its rows table still shows exactly the four declared input columns', tchCols);
  await f.locator('button:has-text("Generate Lines")').click();
  await page.waitForSelector('#appModalBody .badge.offset', { timeout: 15000 });
  const tchLines = await page.evaluate((id) => AppState.pendingSpecialJV[id][0].lines, tpl);
  check(JSON.stringify(tchLines) === JSON.stringify(L),
        'the hand-written TCH page and the generated example produce byte-identical lines',
        tchLines.length === L.length ? 'same length, different content' : { tch: tchLines.length, gen: L.length });
  await page.evaluate(() => SpecialJV._cancel());

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[10] Reco carries the engine, and reads conditions the way its own filters do');
  const inReco = await page.evaluate(() => ({
    version: window.JVCore && JVCore.version,
    engineVersion: typeof JV_ENGINE_VERSION === 'string' ? JV_ENGINE_VERSION : null,
    files: typeof JV_ENGINE_FILES !== 'undefined' ? JV_ENGINE_FILES.map(f => f.name) : null,
    sameText: typeof JV_ENGINE_FILES !== 'undefined'
      && JV_ENGINE_FILES.every(f => jvEngineSource(f.island).length > 100)
  }));
  check(inReco.version === '1.0.0' && inReco.engineVersion === '1.0.0' && inReco.sameText
        && inReco.files.join() === 'jv-core-1.0.0.js,jv-page-1.0.0.js,jv-page-1.0.0.css',
        'MODULE 2d gives Reco a working JVCore and the three files it must write to the share', inReco);
  /* The engine reproduces FilterOps' algorithm because the calculator page has
     no Reco to borrow it from. Here both exist, so they can be compared. */
  const parity = await page.evaluate(() => {
    const COLS = [{ id: 'txt', label: 'Txt', type: 'text' },
                  { id: 'amt', label: 'Amt', type: 'number' },
                  { id: 'dt', label: 'Dt', type: 'date' }];
    const KIND = { txt: 'text', amt: 'value', dt: 'date' };
    const VALUES = { txt: ['abc', 'ABC', '', 'OF01', '1,234.50', '06/10/2026'],
                     amt: ['100', '(1,234.50)', '1,234.50-', '0', '', 'abc'],
                     dt: ['06/10/2026', '2026-10-06', '45936', '', '31/02/2026', '06-Oct-26'] };
    const OPERANDS = { txt: ['abc', 'ABC', 'OF', '', 'abc,xyz', '100'],
                       amt: ['100', '1,234.50', '-1234.5', '0', '', '1,234.50, -50'],
                       dt: ['06/10/2026', '2026-10-06', '10/06/26', '', '45936'] };
    const out = { n: 0, diff: [] };
    JVCore.OPS.forEach(op => {
      if (op === 'date_between') return;              // FilterOps has no such op
      COLS.forEach(col => {
        VALUES[col.id].forEach(v => {
          OPERANDS[col.id].forEach(q => {
            OPERANDS[col.id].forEach(q2 => {
              const row = {}; row[col.label] = v;
              let mine, theirs;
              try { mine = JVCore.testCond({ columns: COLS }, row, { col: col.id, op, val: q, val2: q2 }); }
              catch (e) { mine = 'throw:' + e.message; }
              try { theirs = FilterOps.evaluate(v, op, q, q2, KIND[col.id]); }
              catch (e) { theirs = 'throw:' + e.message; }
              out.n++;
              if (mine !== theirs && out.diff.length < 8) out.diff.push({ op, col: col.id, v, q, q2, mine, theirs });
            });
          });
        });
      });
    });
    return out;
  });
  check(parity.diff.length === 0,
        'the engine and Reco\'s own FilterOps agree on all ' + parity.n + ' operator/value combinations', parity.diff);

  console.log('\nconsole/page errors: ' + JSON.stringify(errors.slice(0, 6)));
  check(errors.length === 0, 'no console or page errors in Reco throughout', errors.slice(0, 4));
} catch (e) {
  failures++;
  console.log('  ✗ EXCEPTION: ' + (e && e.stack || e));
}

clearTimeout(watchdog);
await browser.close();
killAll();
console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
