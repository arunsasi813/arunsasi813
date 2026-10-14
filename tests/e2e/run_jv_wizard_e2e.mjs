// End-to-end tests for the Special JV creator's wizard (MODULE 9c of
// apps/Reco.html: JvWizard) against the real Python LauncherAPI
// (tests/e2e/bridge_server.py stands in for pywebview).
//
//   node tests/e2e/run_jv_wizard_e2e.mjs
//
// The headline test rebuilds TCH THROUGH THE WIZARD — typing in boxes and
// clicking controls, never writing JSON — starting from "Start blank",
// publishes it as TCHW, and then opens TCHW through the real SpecialJV.open
// and asserts, field by field, every figure tests/e2e/run_e2e.mjs asserts for
// the real hand-written TCH page. That is the whole claim of this feature: a
// finance user can re-create the JV they depend on, and what comes out passes
// the same checks.
//
// After that: "Start from TCH" is an exact copy of TCH's maths under a new
// code; the live test-run recomputes on a keystroke; "Check against the real
// TCH page" diffs clean; and a JV that does not balance cannot be published.
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

const PORT = 19142, JVPORT = 19143;
let failures = 0, passes = 0;
function check(cond, msg, extra) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* ── the test share ───────────────────────────────────────────────────────── */
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-wiz-e2e-'));
const root = path.join(base, 'root');
const cp = (src, dst) => {
  fs.mkdirSync(path.dirname(path.join(root, dst)), { recursive: true });
  fs.copyFileSync(path.join(REPO, src), path.join(root, dst));
};
const abs = rel => path.join(root, rel);
const read = rel => (fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel), 'utf8') : null);
const exists = rel => fs.existsSync(abs(rel));

cp('apps/Reco.html', 'apps/Reco.html');
for (const f of fs.readdirSync(path.join(REPO, 'apps/lib'))) cp('apps/lib/' + f, 'apps/lib/' + f);
cp('special_jv_templates/TCH.html', 'special_jv_templates/TCH.html');
cp('special_jv_mapping/TCH.json', 'special_jv_mapping/TCH.json');
fs.mkdirSync(abs('master'), { recursive: true });
fs.writeFileSync(abs('master/user.csv'), `ID,Name,Email,reco\r\n${OS_USER},Test User,,1\r\n`);
/* The three accounts TCH posts to, so the wizard's "From the Accounts Master"
   path is the one exercised rather than typing codes in by hand. */
fs.writeFileSync(abs('master/accounts_master.csv'),
  'Reference,RC,Nominal,SubNominal,AnalysisKey,LOB\r\n'
  + 'TCH-CLEARING,78061,17036,0,0,51\r\nTCH-CROSSCCY,78061,85001,0,0,51\r\nTCH-CHARGES,50000,35008,0,0,51\r\n');
fs.writeFileSync(abs('pwd.txt'), 'sharePass1\n');

const TCH_HTML_BEFORE = read('special_jv_templates/TCH.html');
const TCH_JSON_BEFORE = read('special_jv_mapping/TCH.json');

const procs = [];
const killAll = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });
process.on('exit', killAll);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { killAll(); process.exit(130); }));
const watchdog = setTimeout(() => {
  console.error('\nWATCHDOG: run exceeded 8 minutes; last check: ' + (passes + failures));
  killAll();
  process.exit(2);
}, 480000);

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

/* The four rows tests/e2e/run_e2e.mjs drives TCH with. */
const ROWS = [
  { Doc: 'D1', Date: '06/10/2026', 'Txn Type': 'RAPID', Currency: 'USD', 'FC Amount': '100',   AED: '367',  ToAccount: '', Status: '' },
  { Doc: 'D2', Date: '07/10/2026', 'Txn Type': 'RAPID', Currency: 'EUR', 'FC Amount': '50',    AED: '200',  ToAccount: '', Status: '' },
  { Doc: 'D3', Date: '12/10/2026', 'Txn Type': 'OF01',  Currency: 'RUB', 'FC Amount': '-9000', AED: '-400', ToAccount: '', Status: '' },
  { Doc: 'D4', Date: '08/10/2026', 'Txn Type': 'RAPID', Currency: 'RUB', 'FC Amount': '5000',  AED: '220',  ToAccount: '', Status: '' }
];
const FIELDS = Object.keys(ROWS[0]);

/* ── small helpers over the wizard's own controls ─────────────────────────── */
const flush = () => page.evaluate(() => JvWizard._touchNow());
const stepTo = async n => {
  await page.click('#jvwChip' + n);
  await page.waitForSelector('#jvwStep', { timeout: 10000 });
};
const sel = (id, v) => page.selectOption('#' + id, v);
const fill = (id, v) => page.fill('#' + id, v);
const spec = () => page.evaluate(() => JSON.parse(JSON.stringify(JvWizard._st.def)));
const wstate = () => page.evaluate(() => ({
  step: JvWizard._st.step,
  rows: JvWizard._st.rows.length,
  kinds: JvWizard._st.classes.map(c => c.kind),
  why: JvWizard._st.classes.map(c => c.why),
  lines: JvWizard._st.built ? JvWizard._st.built.lines.length : 0,
  balanced: JvWizard._st.balanced,
  computed: JvWizard._st.computed,
  errors: JvWizard._st.valid.errors.slice(),
  blocks: (JvWizard._st.checks.blocks || []).slice(),
  can: JvWizard._canPublish()
}));

try {
  await page.goto(`http://127.0.0.1:${PORT}/apps/Reco.html`);
  await page.waitForSelector('#appMain .panel', { timeout: 20000 });

  /* A Reco template with the four rows selected, so the wizard's default
     test-row source is "the rows I have selected" — the real case. */
  const tpl = await page.evaluate(([rows, fields]) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.name = 'TCH Feed';
    t.columns = fields.map(n => ({ name: n, label: n, formats: [], isValue: n === 'AED', isDate: n === 'Date' }));
    t.primaryKeys = ['Doc'];
    t.valueColumn = 'AED';
    t.currencyColumn = 'Currency';
    t.editableColumns = ['ToAccount', 'Status'];
    t.displayColumns = t.columns.map(c => c.name);
    t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id, keywordColumn: '',
                         keywordValues: '', postEntryColumn: 'Status', postEntryValue: 'Posted' };
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.name === 'TCH Feed');
    RecoTemplate.open(tpl.id);
    Reco.ingestData(tpl, rows, fields);
    const s = AppState.recoSessions[tpl.id];
    s.selectedRows = {};
    s.data.forEach(r => { s.selectedRows[r._id] = true; });
    return tpl.id;
  }, [ROWS, FIELDS]);

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[1] the way in, and the four places to start from');
  await page.evaluate(() => App.navigate('home'));
  await page.waitForSelector('#appMain .panel', { timeout: 10000 });
  check(/Available Special JVs/.test(await page.textContent('#appMain'))
        && await page.isVisible('#appMain button:has-text("+ New Special JV")'),
        'Home always shows the Special JV panel with a way into the creator');
  await page.evaluate(() => { App.navigate('aeg'); AEG.switchTab('specialjv'); });
  await page.waitForSelector('#jvNewBtn', { timeout: 10000 });
  await page.click('#jvNewBtn');
  await page.waitForSelector('#jvwStartBlank', { timeout: 10000 });
  const chooser = (await page.textContent('#appModalBody')).replace(/\s+/g, ' ');
  check(await page.isVisible('#jvwStartTch') && /Copies TCH's row types \(RAPID \/ OF\)/.test(chooser),
        'the chooser offers "Start from TCH", and says what copying it brings');
  check(/Copy one of ours/.test(chooser) && /Start blank/.test(chooser) && /Import a JV file/.test(chooser),
        'and the other three starting points of the design');
  check(/Twelve clicks to a working JV/.test(chooser), '"Start blank" says what it costs');

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[2] rebuilding TCH through the wizard — clicks and typing only, no JSON');
  await page.click('#jvwStartBlank');
  await page.waitForSelector('#jvwChips', { timeout: 10000 });
  const fresh = await wstate();
  check(fresh.step === 9 && fresh.rows === 4,
        'it opens on the live test-run, already loaded with the rows selected in Reco', fresh);
  check(fresh.kinds.join() === '@skip,@skip,@skip,@skip',
        'a blank JV classifies nothing yet, and says so rather than pretending', fresh.kinds);

  /* ---- step 1: the name and the columns Reco must send ------------------ */
  await stepTo(1);
  await fill('jvwRef', 'tchw');
  check(await page.inputValue('#jvwRef') === 'TCHW', 'the short code is upper-cased as it is typed');
  const paths = await page.textContent('[data-live="paths"]');
  check(/special_jv_mapping\/TCHW\.json/.test(paths) && /special_jv_templates\/TCHW\.html/.test(paths),
        'and it says which two files it will create', paths.trim());
  await fill('jvwName', 'TCHW JV — Cross Currency & Charges');
  check(/⚡ TCHW JV — Cross Currency & Charges \(Special JV\)/.test(await page.textContent('[data-live="nameecho"]')),
        'the name is echoed as the To Account dropdown will read it');
  await fill('jvwTitle', 'TCH JV — Cross Currency Adjustment & TCH Charges');
  await fill('jvwDesc', 'Rebuilt from TCH through the creator.');
  /* The three columns a blank JV starts with are Date, Currency and Amount;
     TCH's amount is called "FC Amount" and it needs a fourth column. */
  await fill('jvwCol_2', 'FC Amount');
  await fill('jvwColAccept_2', 'Amount, Amt, Value');
  await page.click('#jvwStep button:has-text("+ Add column")');
  await fill('jvwCol_3', 'Txn Type');
  check(await page.inputValue('#jvwColAccept_3') === 'Transaction Type, Type',
        'naming a column the extract really has fills its other spellings from the alias table');
  await flush();
  const count = await page.textContent('[data-live="inputcount"]');
  check(/15/.test(count) && /Transaction Date/.test(count) && /CCY/.test(count),
        'and the screen says exactly how many column names Reco will be asked for', count.replace(/\s+/g, ' ').trim());

  /* ---- step 2: row types, and how a row is sorted ---------------------- */
  await stepTo(2);
  await fill('jvwKind_0', 'RAPID');
  await page.click('#jvwStep button:has-text("+ Add row type")');
  await fill('jvwKind_1', 'OF');
  await page.selectOption('#jvwStep table tbody tr:nth-child(2) select', 'amber');
  const kindIds = await page.evaluate(() => JvWizard._st.def.jvSpec.kinds.map(k => k.id + ':' + k.label + ':' + k.style));
  check(kindIds.join(' ') === 'main:RAPID:blue type_2:OF:amber', 'two row types, named and coloured', kindIds);

  /* TCH's five rules, in TCH's order: the narrow ones above the broad ones. */
  for (let i = 0; i < 5; i++) await page.click('#jvwStep button:has-text("+ Add rule")');
  // rule 1 — no Txn Type at all: ignore
  await sel('jvwRuleKind_0', '@skip');
  await sel('jvwCondOp_rule0_0', 'empty');
  await fill('jvwRuleWhy_0', 'no Txn Type');
  // rule 2 — RAPID in one of the three currencies we use
  await sel('jvwRuleKind_1', 'main');
  await fill('jvwCondVal_rule1_0', 'RAPID');
  await page.click('#jvwRule_1 button:has-text("+ condition")');
  await sel('jvwCondCol_rule1_1', 'currency');
  await sel('jvwCondOp_rule1_1', 'in_list');
  await fill('jvwCondVal_rule1_1', 'RUB,USD,EUR');
  // rule 3 — any other RAPID: ignore, and say which currency it was in
  await sel('jvwRuleKind_2', '@skip');
  await fill('jvwCondVal_rule2_0', 'RAPID');
  await fill('jvwRuleWhy_2', 'RAPID in {currency|no currency}');
  // rule 4 — OF in RUB
  await sel('jvwRuleKind_3', 'type_2');
  await sel('jvwCondOp_rule3_0', 'starts_with');
  await fill('jvwCondVal_rule3_0', 'OF');
  await page.click('#jvwRule_3 button:has-text("+ condition")');
  await sel('jvwCondCol_rule3_1', 'currency');
  await fill('jvwCondVal_rule3_1', 'RUB');
  // rule 5 — any other OF: ignore
  await sel('jvwRuleKind_4', '@skip');
  await sel('jvwCondOp_rule4_0', 'starts_with');
  await fill('jvwCondVal_rule4_0', 'OF');
  await fill('jvwRuleWhy_4', 'OF in {currency|no currency} (only RUB is used)');
  await fill('jvwFallback', 'Txn Type {txn}');
  await flush();
  const sorted = await wstate();
  check(sorted.kinds.join() === 'main,main,type_2,main',
        'the four test rows now sort RAPID, RAPID, OF, RAPID — the classification TCH makes', sorted.kinds);
  const ops = await page.evaluate(() => {
    /* point one condition at each kind of column and read the menu it offers */
    const read = () => Array.from(document.querySelectorAll('#jvwCondOp_rule1_1 option')).map(o => o.value);
    const out = { text: read() };
    JvWizard.cond('rule:1', 1, 'col', 'amount');
    out.amount = read();
    JvWizard.cond('rule:1', 1, 'col', 'date');
    out.date = read();
    JvWizard.cond('rule:1', 1, 'col', 'currency');
    JvWizard.cond('rule:1', 1, 'op', 'in_list');
    JvWizard.cond('rule:1', 1, 'val', 'RUB,USD,EUR');
    return out;
  });
  check(ops.text.length === 22 && ops.amount.indexOf('greater') >= 0 && ops.amount.indexOf('before') < 0
        && ops.date.indexOf('before') >= 0 && ops.date.indexOf('greater') < 0,
        'the operator menu comes from Reco\'s own FilterOps: all 22 on an untyped text column, the numeric ones on '
        + 'an amount, the date ones on a date', { text: ops.text.length, amount: ops.amount.length, date: ops.date.length });

  /* ---- step 3: one section per period, with TCH's 10-day slots --------- */
  await stepTo(3);
  await fill('jvwNoun', 'TCH');
  const echo = await page.textContent('#jvwNounEcho');
  check(/“TCH 1”/.test(echo) && /T1/.test(echo) && /\+ Add TCH Section/.test(echo) && /TCH1/.test(echo),
        'one noun, and the card title, the row label, the button and the Reco code all follow it', echo.replace(/\s+/g, ' ').trim());
  await page.check('#jvwPresets');
  await page.waitForSelector('[data-live="presets"]', { timeout: 10000 });
  const pre = await page.textContent('[data-live="presets"]');
  check(/1-10 Oct 2026 \(10\/01\/26 → 10\/10\/26\)/.test(pre) && /21-31 Oct 2026/.test(pre),
        'the preset slots are shown against the real test data, dates and all', pre.replace(/\s+/g, ' ').trim());
  check(await page.isChecked('#jvwAutoAssign'), 'the "Auto-assign by period" button comes with them');

  /* ---- step 4: the five Sale Data boxes -------------------------------- */
  await stepTo(4);
  const boxes = ['RUB Eq for USD', 'RUB Eq for EUR', 'RUB (no 2.1)', 'RUB Total (no 2)', 'TCH Charges'];
  for (let i = 0; i < boxes.length; i++) await page.click('#jvwStep button:has-text("+ Add box")');
  for (let i = 0; i < boxes.length; i++) {
    await fill('jvwField_' + (3 + i), boxes[i]);
    await fill('jvwFieldGroup_' + (3 + i), 'Sale Data — manual entry');
  }
  await flush();
  const fieldIds = await page.evaluate(() => JvWizard._st.def.jvSpec.fields.map(f => f.id + ':' + f.type));
  check(fieldIds.join(' ') === 'periodFrom:period periodTo:period recoCode:text figure_4:amount figure_5:amount '
        + 'figure_6:amount figure_7:amount figure_8:amount',
        'eight boxes: the period and the Reco code the presets needed, and the five figures typed each time', fieldIds);
  const recoChecked = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input[name="jvwReco"]')).findIndex(r => r.checked));
  check(recoChecked === 2, 'the Reco code box is the one the lines take their Reco value from', recoChecked);

  /* ---- step 5: the four totals, in two clicks -------------------------- */
  await stepTo(5);
  await page.click('#jvwStep button:has-text("+ One total per currency…")');
  await page.waitForSelector('#jvwPcCurs', { timeout: 10000 });
  await sel('jvwPcKind', 'main');
  await fill('jvwPcCurs', 'RUB, USD, EUR');
  await fill('jvwPcGroup', 'Rapid (net Dr) — auto from rows');
  await page.click('#appModalFooter button:has-text("Add them")');
  await page.waitForSelector('#jvwChips', { timeout: 10000 });
  await page.click('#jvwStep button:has-text("+ One total per currency…")');
  await page.waitForSelector('#jvwPcCurs', { timeout: 10000 });
  await sel('jvwPcKind', 'type_2');
  await fill('jvwPcCurs', 'RUB');
  await fill('jvwPcGroup', 'OF (net Cr) — auto');
  await page.click('#appModalFooter button:has-text("Add them")');
  await page.waitForSelector('#jvwChips', { timeout: 10000 });
  await flush();
  const aggs = await page.evaluate(() => JvWizard._st.def.jvSpec.aggregates.map(a =>
    a.id + '=' + a.label + '/' + a.fn + '/' + a.of + '/' + JSON.stringify(a.where)));
  check(aggs.length === 4 && aggs[0].indexOf('main_RUB=RUB/sum/amount/[{"kind":"main"},{"col":"currency","op":"equals","val":"RUB"}]') === 0
        && aggs[3].indexOf('type_2_RUB=RUB/sum/amount/[{"kind":"type_2"}') === 0,
        'two clicks wrote all four of TCH\'s totals, each filtered by row type and currency', aggs);
  const live = await page.textContent('[data-live="agg:main_RUB"]');
  check(/= 0\.00/.test(live),
        'each total shows its value against the test rows — 0.00 so far, because no row is in a section yet', live.trim());

  /* ---- step 6: the three accounts, from the Accounts Master ------------ */
  await stepTo(6);
  const slots = [['clearing', 'TCH clearing', 'TCH-CLEARING'],
                 ['crossCcy', 'Cross-currency adjustment', 'TCH-CROSSCCY'],
                 ['charges', 'BSP TCH charges (expense)', 'TCH-CHARGES']];
  for (let i = 0; i < slots.length; i++) await page.click('#jvwStep button:has-text("+ Add account")');
  for (let i = 0; i < slots.length; i++) {
    await fill('jvwSlotId_' + i, slots[i][0]);
    await fill('jvwSlot_' + i, slots[i][1]);
    await page.selectOption('#jvwStep table tbody tr:nth-child(' + (i + 1) + ') select', slots[i][2]);
  }
  await fill('jvwShared_lob', '51');
  await flush();
  const accounts = await page.evaluate(() => JSON.parse(JSON.stringify(JvWizard._st.def.accounts)));
  check(accounts.clearing.nominal === '17036' && accounts.clearing.rc === '78061'
        && accounts.crossCcy.nominal === '85001' && accounts.charges.nominal === '35008'
        && accounts.charges.rc === '50000',
        'picking a Reference from the Accounts Master filled the nominal and the RC', accounts);
  check(accounts.subNominal === '0' && accounts.analysisKey === '0' && accounts.lob === '51'
        && accounts.reference === '' && accounts.doc === '',
        'and the five fields that go on every line are TCH\'s', accounts);
  check(!/is not in the Accounts Master/.test(await page.textContent('#jvwStep')),
        'no "not in the master" warning, because all three codes came from it');

  /* ---- step 7: the four entry rules ------------------------------------ */
  await stepTo(7);
  // entry 1 — Cross Currency Adjustment (RUB) = rubEqUsd + rubEqEur
  await page.click('#jvwStep button:has-text("+ Add entry")');
  await fill('jvwEntryLabel_e1', 'Cross Currency Adjustment (RUB)');
  await page.selectOption('#jvwEntry_e1 .toolbar select:nth-of-type(1)', { index: 0 });   // keep "+ add"
  await page.selectOption('#jvwEntry_e1 select[onchange*="setTermSrc"]', 'figure_4');
  await page.click('#jvwEntry_e1 button:has-text("+ add another")');
  await page.selectOption('#jvwEntry_e1 select[onchange*="setTermSrc(\'e1\',1"]', 'figure_5');
  await page.selectOption('#jvwEntry_e1 select[onchange*="\'dr\'"]', 'clearing');
  await page.selectOption('#jvwEntry_e1 select[onchange*="\'cr\'"]', 'crossCcy');
  await page.fill('#jvwEntry_e1 input[placeholder="RUB"]', 'RUB');
  await fill('jvwNarr_e1', 'Cross Currency Adjustment Entry for {range}');
  await flush();
  const amt1 = await page.textContent('[data-live="amt:e1"]');
  check(/= 0\.00/.test(amt1) && /below 0\.01, this entry posts nothing/.test(amt1),
        'entry 1 says plainly that it posts nothing until the two figures are typed', amt1.trim());

  // entry 2 — one line per currency, reading the per-currency total
  await page.click('#jvwStep button:has-text("+ Add: one entry per currency")');
  await fill('jvwEntryLabel_e2', 'Cross Currency Adjustment {cur}');
  await page.fill('#jvwEntry_e2 input[placeholder="USD, EUR"]', 'USD, EUR');
  await page.selectOption('#jvwEntry_e2 select[onchange*="\'dr\'"]', 'crossCcy');
  await page.selectOption('#jvwEntry_e2 select[onchange*="\'cr\'"]', 'clearing');
  await fill('jvwNarr_e2', 'Cross Currency Adjustment Entry for {range}');
  await flush();
  const e2 = await page.evaluate(() => {
    const en = JvWizard._entry('e2');
    return { amount: en.amount, cur: en.cur, per: en.forEachCurrency };
  });
  check(e2.amount === 'main_{cur}' && e2.cur === '{cur}' && e2.per.join() === 'USD,EUR',
        'one rule becomes one line pair per currency, reading main_USD and main_EUR', e2);

  // entry 3 — the balancing figure, which is TCH's charges entry
  await page.click('#jvwStep button:has-text("+ Add: balancing figure")');
  await fill('jvwEntryLabel_e3', 'BSP TCH Charges');
  const started = await page.evaluate(() => JvWizard._entry('e3').amount);
  check(/^-\(/.test(started), 'the balancing button starts from the flip-the-sign shape', started);
  for (const [k, v] of [[0, 'type_2_RUB'], [1, 'figure_4'], [2, 'figure_5'], [3, 'main_RUB']]) {
    await page.selectOption('#jvwEntry_e3 select[onchange*="setTermSrc(\'e3\',' + k + '"]', v);
  }
  await page.selectOption('#jvwEntry_e3 select[onchange*="\'dr\'"]', 'charges');
  await page.selectOption('#jvwEntry_e3 select[onchange*="\'cr\'"]', 'clearing');
  await page.fill('#jvwEntry_e3 input[placeholder="RUB"]', 'RUB');
  await fill('jvwNarr_e3', 'BSP TCH Charges for {range}');
  await flush();
  const e3 = await page.evaluate(() => JvWizard._entry('e3').amount);
  check(e3 === '-(type_2_RUB + figure_4 + figure_5 + main_RUB)',
        'and the four term rows read exactly what TCH\'s charges entry adds up', e3);
  const amt3 = await page.textContent('[data-live="amt:e3"]');
  check(/= 0\.00/.test(amt3) && /posts nothing/.test(amt3),
        'and with nothing assigned and nothing typed it is honest about computing to zero', amt3.trim());

  /* ---- step 8: the checks were written as the JV was built ------------- */
  await stepTo(8);
  const checksOn = await page.evaluate(() => JvWizard._st.def.jvSpec.validate.map(v => v.kind + ':' + v.level));
  check(checksOn.join(' ') === 'fieldValid:block fieldOrder:block fieldEmpty:confirm unassignedRows:confirm '
        + 'noLines:block balancePerCurrency:block',
        'all six of TCH\'s checks are on, in the one order the creator writes them', checksOn);
  check(await page.isDisabled('#jvwCheck_balancePerCurrency') && await page.isChecked('#jvwCheck_balancePerCurrency'),
        'the per-currency balance check is on and cannot be switched off');

  /* ---- step 9: the live test-run, then publish ------------------------- */
  await stepTo(9);
  const beforeFill = await wstate();
  check(beforeFill.blocks.some(b => /No accounting lines to post/.test(b)) && !!beforeFill.can,
        'with nothing assigned the test-run refuses, and Publish is refused with it', beforeFill.blocks);
  check(await page.isDisabled('#jvwPublish'), 'and the Publish button is actually disabled');

  await page.selectOption('#jvwPanelSections .tch-card select', '0');
  await page.waitForTimeout(80);
  await page.click('#jvwPanelRows ~ * >> nth=0').catch(() => {});       // no-op if the layout moves
  await page.click('button:has-text("Auto-assign by period")');
  await page.waitForTimeout(80);
  const assigned = await page.evaluate(() => JvWizard._st.assignments.slice());
  check(assigned.join() === '1,1,0,1', 'the preset and Auto-assign put D1, D2 and D4 in TCH 1 and leave D3 out', assigned);

  const saleBoxes = page.locator('#jvwPanelSections td.input input');
  await saleBoxes.nth(0).click();
  await saleBoxes.nth(0).pressSequentially('7000');
  check(await saleBoxes.nth(0).inputValue() === '7000', 'typing into a Sale Data box keeps the caret in it');
  await saleBoxes.nth(1).fill('5000');
  await flush();
  const totals = (await page.locator('#jvwPanelSections td.computed').allTextContents()).join('|');
  check(totals === '5,000.00|100.00|50.00|0.00',
        'the four totals read 5,000.00 | 100.00 | 50.00 | 0.00 — the figures run_e2e.mjs asserts for TCH', totals);
  const bal = await page.textContent('#jvwBalance');
  check(/RUB: Dr 29,000.00 \/ Cr 29,000.00 ✓/.test(bal) && /USD: Dr 100.00 \/ Cr 100.00 ✓/.test(bal)
        && /EUR: Dr 50.00 \/ Cr 50.00 ✓/.test(bal),
        'and every currency balances on screen before anything can be saved: RUB 12,000 + 17,000 on each side',
        bal.replace(/\s+/g, ' ').trim());
  const ready = await wstate();
  check(ready.lines === 8 && ready.balanced && ready.can === '',
        'eight lines, balanced, and nothing left stopping a save', ready);

  /* The figures reach every screen, not just this one: the same numbers are
     beside the totals on step 5 and beside the amount on step 7, which is
     what makes a wrong filter or a wrong term visible where it was made. */
  await stepTo(5);
  const liveAggs = await Promise.all(['main_RUB', 'main_USD', 'main_EUR', 'type_2_RUB']
    .map(id => page.textContent('[data-live="agg:' + id + '"]')));
  check(liveAggs.map(t => t.trim()).join(' ') === '= 5,000.00 = 100.00 = 50.00 = 0.00',
        'step 5 shows each total\'s real value from the test rows', liveAggs);
  await stepTo(7);
  const amt1b = (await page.textContent('[data-live="amt:e1"]')).trim();
  const amt3b = (await page.textContent('[data-live="amt:e3"]')).trim();
  const narr1 = (await page.textContent('[data-live="narr:e1"]')).trim();
  check(/= 12,000\.00/.test(amt1b) && /\(Dr TCH clearing \/ Cr Cross-currency adjustment\)/.test(amt1b),
        'step 7 shows entry 1 at 12,000.00 and which way round it posts', amt1b);
  check(/= -17,000\.00/.test(amt3b) && /negative → sides swap: Dr TCH clearing \/ Cr BSP TCH charges/.test(amt3b),
        'and entry 4 at −17,000.00, saying the sides will swap and where they end up', amt3b);
  check(/Cross Currency Adjustment Entry for 01 Oct - 10 Oct 26/.test(narr1),
        'and the narration rendered with the period that is actually on the section', narr1);
  await stepTo(9);

  await page.click('#jvwPublish');
  await page.waitForFunction(() => !document.getElementById('appModal').classList.contains('show'), null, { timeout: 30000 });
  check(exists('special_jv_mapping/TCHW.json') && exists('special_jv_templates/TCHW.html'),
        'TCHW is on the shared folder: a mapping and a calculator page');
  const defW = JSON.parse(read('special_jv_mapping/TCHW.json'));
  const htmlW = read('special_jv_templates/TCHW.html');
  check(htmlW.indexOf('<script>') === -1 && (htmlW.match(/<script/g) || []).length === 3
        && !/\son[a-z]+\s*=/.test(htmlW.replace(/<!--[\s\S]*?-->/g, ' ')),
        'the page the wizard wrote carries no program of its own', (htmlW.match(/<script[^>]*>/g) || []));
  check(defW.audit.rev === 1 && defW.audit.builtBy === 'creator'
        && defW.audit.specHash === JVCore.specHash(defW),
        'and the mapping records who built it and the hash of its own spec', defW.audit);
  const vW = JVCore.validateSpec(defW);
  check(vW.errors.length === 0, 'the published spec passes validateSpec outright', vW.errors);
  const gotNames = defW.inputColumns.map(c => c.name);
  const tchNames = JSON.parse(TCH_JSON_BEFORE).inputColumns.map(c => c.name);
  check(gotNames.length === 15 && tchNames.every(n => gotNames.indexOf(n) >= 0),
        'it asks Reco for 15 column names, TCH\'s own four among them', { got: gotNames.length, tch: tchNames });
  check(['Posting Date', 'Txn Date', 'Transaction Date', 'Value Date', 'Transaction Type', 'Type',
         'Cur', 'CCY', 'Amount', 'Amt', 'Value'].every(n => gotNames.indexOf(n) >= 0),
        'and the other eleven are the alternative spellings — Reco sends only the names listed, so an extract whose '
        + 'header says "Posting Date" still works', gotNames);

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[3] TCHW through the real Reco: the eight lines TCH posts');
  async function openJv(ref) {
    await page.evaluate(([id, ref]) => {
      AppState.pendingSpecialJV[id] = [];
      const s = AppState.recoSessions[id];
      s.data.forEach(r => { r.ToAccount = ref; r.Status = ''; });
      s.selectedRows = {};
      s.data.forEach(r => { s.selectedRows[r._id] = true; });
      Reco.previewEntryFromSelection(true);
    }, [tpl, ref]);
    await page.click('#appModalBody button:has-text("Complete")');
    return page.frameLocator('#specialJvFrame');
  }
  async function runTch(ref) {
    const jv = await openJv(ref);
    await jv.locator('#rowsTable tbody tr').first().waitFor({ timeout: 15000 });
    await jv.locator('.tch-card select').first().selectOption('0');
    await jv.locator('button:has-text("Auto-assign by period")').click();
    const sale = jv.locator('td.input input').first();
    await sale.click();
    await sale.pressSequentially('7000');
    await jv.locator('td.input input').nth(1).fill('5000');
    const totals = (await jv.locator('td.computed').allTextContents()).join('|');
    const focus = await sale.inputValue();
    await jv.locator('button:has-text("Generate Lines")').click();
    await page.waitForSelector('#appModalBody .badge.offset', { timeout: 15000 });
    const pend = await page.evaluate(id => AppState.pendingSpecialJV[id][0], tpl);
    return { totals, focus, pend };
  }
  const run = await runTch('TCHW');
  check(run.totals === '5,000.00|100.00|50.00|0.00' && run.focus === '7000',
        'the generated calculator behaves like TCH: presets, auto-assign, and typing keeps focus',
        { totals: run.totals, focus: run.focus });
  const L = run.pend.lines;
  check(L.length === 8, 'eight accounting lines', L.length);
  check(L[0].Desc === 'Cross Currency Adjustment Entry for 01 Oct - 10 Oct 26',
        'the narration uses the real period', L[0].Desc);
  check(L[0].Nominal === '17036' && L[0].Dr === '12000.00' && L[1].Nominal === '85001' && L[1].Cr === '12000.00',
        'entry 1 Dr 17036 / Cr 85001 12,000.00 RUB', L.slice(0, 2));
  check(L[2].Nominal === '85001' && L[2].Cur === 'USD' && L[2].Dr === '100.00', 'entry 2 Dr 85001 100.00 USD', L[2]);
  check(L[4].Cur === 'EUR' && L[4].Dr === '50.00', 'entry 3 EUR 50.00', L[4]);
  check(L[6].Nominal === '17036' && L[6].Dr === '17000.00' && L[7].Nominal === '35008' && L[7].RC === '50000',
        'entry 4 is negative, so the sides swapped', L.slice(6));
  check(L.every(l => l.SubNominal === '0' && l['Analysis Key'] === '0' && l.LOB === '51'
        && l.Reference === '' && l.Doc === ''), 'the shared account fields are on every line');
  check(L.every(l => l.Reco === 'TCH1'), 'Reco defaults to TCH1 when the code is left empty', L[0].Reco);
  check(L.every(l => Object.keys(l).join('|') === JVCore.LINE_ORDER.join('|')),
        'every line carries the 12 AEG keys in the output order', Object.keys(L[0]));
  check(run.pend.primaryKeys.slice().sort().join() === 'D1,D2,D4', 'it consumed D1, D2, D4 only', run.pend.primaryKeys);
  check(run.pend.meta.engine === '1.0.0' && run.pend.meta.specHash === defW.audit.specHash,
        'and recorded which engine and which version of the maths produced the figures',
        { engine: run.pend.meta.engine, hash: run.pend.meta.specHash });
  await page.click('#appModalFooter button:has-text("Generate")');
  await page.waitForSelector('#appModalTitle:has-text("Allocate")', { timeout: 10000 });
  const ent = await page.evaluate(id => {
    const s = AppState.recoSessions[id];
    const h = AppState.entryHistory[id] || [];
    return { hist: h.length, lines: (h[0] || {}).lines ? h[0].lines.length : 0,
             ref: ((h[0] || {}).specialJvs || [{}])[0].ref,
             postedPks: ((h[0] || {}).postedPks || []).slice().sort(),
             status: Object.fromEntries(s.data.map(r => [r._pk, r.Status])) };
  }, tpl);
  check(ent.hist === 1 && ent.lines === 8 && ent.ref === 'TCHW' && ent.postedPks.join() === 'D1,D2,D4'
        && ent.status.D1 === 'Posted' && ent.status.D3 !== 'Posted',
        'the lines commit as an entry like any other, closing only the rows the JV used', ent);
  await page.evaluate(() => App.closeModal());

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[4] the live test-run recomputes on a keystroke');
  await page.evaluate(() => { App.navigate('aeg'); AEG.switchTab('specialjv'); });
  await page.waitForSelector('#aegContent .card-grid', { timeout: 10000 });
  await page.click('#aegContent .card:has-text("Ref TCHW") button:has-text("Edit")');
  await page.waitForSelector('#jvwChips', { timeout: 15000 });
  await page.evaluate(() => JvWizard.go(9));
  await page.waitForSelector('#jvwPanelSections', { timeout: 10000 });
  await page.selectOption('#jvwPanelSections .tch-card select', '0');
  await page.click('button:has-text("Auto-assign by period")');
  await page.waitForTimeout(80);
  const boxA = page.locator('#jvwPanelSections td.input input').first();
  await boxA.fill('1000');
  await page.waitForFunction(() => {
    const t = document.getElementById('jvwPanelLines');
    return t && /1,000\.00|1000\.00/.test(t.textContent);
  }, null, { timeout: 5000 });
  const after1 = await page.textContent('#jvwPanelLines');
  check(/1000\.00/.test(after1), 'typing 1000 into a Sale Data box changed the lines, with no other click', /1000\.00/.test(after1));
  await boxA.fill('4000');
  await page.waitForFunction(() => {
    const t = document.getElementById('jvwPanelLines');
    return t && /4000\.00/.test(t.textContent);
  }, null, { timeout: 5000 });
  const after2 = await page.evaluate(() => ({
    lines: JvWizard._st.built.lines.filter(l => l.Cur === 'RUB' && l.Dr).map(l => l.Nominal + ' ' + l.Dr),
    cell: document.querySelector('#jvwPanelSections td.computed[data-k="main_RUB"]').textContent
  }));
  /* Only the first Sale Data box was typed into, so the figures are
     4,000 (entry 1 = 4,000 + 0) and 9,000 (entry 4 = −(0 + 4,000 + 0 + 5,000),
     sides swapped), both Dr on the clearing account. The aggregate beside
     them is read off the rows and does not move. */
  check(after2.lines.join(' | ') === '17036 4000.00 | 17036 9000.00' && after2.cell === '5,000.00',
        'and again on the next keystroke: both Dr lines recomputed, the aggregate cell untouched', after2);
  const editTitle = await page.textContent('#appModalTitle');
  check(/Edit Special JV — TCHW/.test(editTitle), 'editing an existing JV says which one', editTitle);
  check(/1 posted entry/.test((await page.textContent('#appModalBody')).replace(/\s+/g, ' ')),
        'and carries the blast radius: one entry has already been posted from it');
  check(await page.isDisabled('#jvwChip1') === false, 'the step chips are clickable on a JV that arrives filled in');
  await stepTo(1);
  check(await page.isDisabled('#jvwRef'),
        'the short code cannot be changed — it is the registry key, the file name and the To Account value');
  await page.evaluate(() => JvWizard.close());

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[5] "Start from TCH" is TCH\'s maths under a new code');
  await page.click('#jvNewBtn');
  await page.waitForSelector('#jvwStartTch', { timeout: 10000 });
  await page.click('#jvwStartTch');
  await page.waitForSelector('#jvwChips', { timeout: 10000 });
  await stepTo(1);
  await fill('jvwRef', 'TCH3');
  await fill('jvwName', 'TCH3 — a copy of TCH');
  await stepTo(9);
  await page.selectOption('#jvwPanelSections .tch-card select', '0');
  await page.click('button:has-text("Auto-assign by period")');
  await page.waitForTimeout(80);
  const s3 = page.locator('#jvwPanelSections td.input input');
  await s3.nth(0).fill('7000');
  await s3.nth(1).fill('5000');
  await flush();
  const t3 = (await page.locator('#jvwPanelSections td.computed').allTextContents()).join('|');
  check(t3 === '5,000.00|100.00|50.00|0.00', 'a copy of TCH computes TCH\'s totals straight away', t3);
  await page.click('#jvwPublish');
  await page.waitForFunction(() => !document.getElementById('appModal').classList.contains('show'), null, { timeout: 30000 });
  const def3 = JSON.parse(read('special_jv_mapping/TCH3.json'));
  const tchDef = JSON.parse(TCH_JSON_BEFORE);
  const tchSpec = JSON.parse(JSON.stringify(tchDef.jvSpec));
  delete tchSpec._comment;                       /* TCH's comment is about TCH's own hand-written page */
  check(JVCore.canonical(def3.jvSpec) === JVCore.canonical(tchSpec),
        'the spec it published is TCH\'s spec, unchanged',
        { mine: JVCore.canonical(def3.jvSpec).length, tch: JVCore.canonical(tchSpec).length });
  check(JSON.stringify(def3.accounts) === JSON.stringify(tchDef.accounts),
        'with TCH\'s account codes verbatim — they live in exactly one place');
  check(JSON.stringify(def3.inputColumns) === JSON.stringify(tchDef.inputColumns),
        'and the same input column names in the same order — a copy asks Reco for exactly what TCH asks for',
        def3.inputColumns.map(c => c.name));
  check(def3.ref === 'TCH3' && def3.displayName === 'TCH3 — a copy of TCH'
        && def3.audit.copiedFrom === 'TCH' && def3.audit.rev === 1,
        'only the code, the name and the history are its own', def3.audit);
  check(read('special_jv_templates/TCH.html') === TCH_HTML_BEFORE
        && read('special_jv_mapping/TCH.json') === TCH_JSON_BEFORE,
        'and neither of TCH\'s own files was touched');

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[6] "Check against the real TCH page" — the only honest test of a rebuild');
  await page.evaluate(() => { App.navigate('aeg'); AEG.switchTab('specialjv'); });
  await page.waitForSelector('#aegContent .card-grid', { timeout: 10000 });
  await page.waitForFunction(() => /Hand-written/.test((document.getElementById('jvBadges_TCH') || {}).textContent || ''),
    null, { timeout: 15000 });
  await page.click('#aegContent .card:has-text("Ref TCHW") button:has-text("Edit")');
  await page.waitForSelector('#jvwChips', { timeout: 15000 });
  await page.evaluate(() => JvWizard.go(9));
  await page.waitForSelector('#jvwPanelSections', { timeout: 10000 });
  await page.selectOption('#jvwPanelSections .tch-card select', '0');
  await page.click('button:has-text("Auto-assign by period")');
  await page.waitForTimeout(80);
  const s4 = page.locator('#jvwPanelSections td.input input');
  await s4.nth(0).fill('7000');
  await s4.nth(1).fill('5000');
  await flush();
  check(await page.isVisible('#jvwDiff_TCH'),
        'the button is offered for TCH, whose page the creator cannot manage and will not touch');
  await page.click('#jvwDiff_TCH');
  const jvReal = page.frameLocator('#specialJvFrame');
  await jvReal.locator('#rowsTable tbody tr').first().waitFor({ timeout: 15000 });
  await jvReal.locator('.tch-card select').first().selectOption('0');
  await jvReal.locator('button:has-text("Auto-assign by period")').click();
  await jvReal.locator('td.input input').nth(0).fill('7000');
  await jvReal.locator('td.input input').nth(1).fill('5000');
  await jvReal.locator('button:has-text("Generate Lines")').click();
  await page.waitForSelector('#jvwDiffResult', { timeout: 20000 });
  const diff = await page.evaluate(() => JvWizard._st.diff);
  check(diff && diff.same === true && diff.notes.length === 0 && diff.mine === 8 && diff.theirs === 8,
        'the rebuilt JV and the real TCH page produced the same eight lines, field by field, and would close the same rows',
        diff);
  check(/Identical/.test(await page.textContent('#jvwDiffResult')), 'and the screen says so in one word');
  await page.evaluate(() => JvWizard.close());

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[7] what the creator refuses');
  /* A hand-written page opens read-only and can only be copied (R-15). */
  await page.evaluate(() => JvWizard.edit('TCH'));
  await page.waitForSelector('#jvwChips', { timeout: 15000 });
  const ro = (await page.textContent('#appModalBody')).replace(/\s+/g, ' ');
  check(/Read-only/.test(ro) && /written by hand/.test(ro)
        && !(await page.isVisible('#jvwPublish'))
        && await page.isVisible('#appModalFooter button:has-text("Save as a new JV…")'),
        'TCH opens read-only in the wizard: no Publish button at all, only "Save as a new JV…"');
  await page.evaluate(() => JvWizard.saveAsNew());
  await page.waitForSelector('#jvwRef', { timeout: 10000 });
  check(await page.inputValue('#jvwRef') === '' && await page.isEnabled('#jvwRef'),
        '"Save as a new JV…" keeps the work and asks for a code of its own');
  await page.evaluate(() => JvWizard.close());
  check(read('special_jv_templates/TCH.html') === TCH_HTML_BEFORE, 'and TCH.html is still byte for byte what it was');

  /* An unbalanced JV cannot be published, whatever else is right. */
  const refused = await page.evaluate(async () => {
    JvWizard.startFrom('TCH');
    JvWizard._st.def.ref = 'BADJV';
    JvWizard._st.def.displayName = 'Deliberately unbalanced';
    /* one extra entry with nothing on the other side of it */
    const s = JvWizard._st.def.jvSpec;
    s.entries.push({ id: 'ex', label: 'Unbalanced', amount: 'rapid_USD', dr: 'charges', cr: 'charges', cur: 'USD', remark: 'bsp' });
    JvWizard._recompute();
    const why = JvWizard._canPublish();
    const r = await JvWizard.publish();
    return { why: why, errors: (r && r.errors) || [], ok: !!(r && r.ok) };
  });
  check(!refused.ok && /Dr and Cr are the same account/.test(refused.why + ' ' + refused.errors.join(' ')),
        'an entry that posts to one account on both sides is refused before anything is written, and the refusal '
        + 'names the entry', refused);
  check(!exists('special_jv_mapping/BADJV.json') && !exists('special_jv_templates/BADJV.html'),
        'and nothing was written for it');
  await page.evaluate(() => JvWizard.close());

  /* The formula box reads the hostile corpus with the engine's own parser. */
  const hostile = await page.evaluate(() => {
    JvWizard.startFrom('TCH');
    /* a plain object cannot hold "__proto__" as a key, so the results are
       keyed by position — the corpus itself is what matters */
    const corpus = ['alert(1)', 'window.top.location', 'rubEqUsd; alert(1)', 'constructor.constructor("x")()',
      'rapid_USD[0]', '"str"', '__proto__', 'this', '1+1)//', 'rubEqUsd++', 'process.exit(1)',
      'rapid_GBP', 'x'.repeat(501)];
    const out = corpus.map(src => {
      JvWizard.setFormula('e1', src);
      return { src: src.length > 30 ? src.slice(0, 12) + '…(' + src.length + ')' : src,
               msg: JvWizard._formulaMsg(src).replace(/<[^>]*>/g, '').slice(0, 70) };
    });
    /* division by zero parses; it is refused when the amount is worked out */
    JvWizard.setFormula('e1', 'of_RUB/0');
    const byZero = JvWizard._amountLine(JvWizard._entry('e1')).replace(/<[^>]*>/g, '');
    return { out: out, byZero: byZero };
  });
  check(hostile.out.every(x => /unexpected|unknown|formula longer|trailing input|must be text|is empty/.test(x.msg)),
        'every item of the hostile-formula corpus is refused inline by the engine\'s own parser, with the reason',
        hostile.out.filter(x => !/unexpected|unknown|formula longer|trailing input|must be text|is empty/.test(x.msg)));
  check(/unknown name/.test(hostile.out.find(x => x.src === 'rapid_GBP').msg)
        && /unknown name/.test(hostile.out.find(x => x.src === '__proto__').msg),
        'a name the spec does not declare — "__proto__" included — is refused as a name, not evaluated');
  check(/division by zero/.test(hostile.byZero),
        'and "of_RUB/0" parses but is refused when the amount is worked out: it never posts a silent zero',
        hostile.byZero.trim());
  check(!(await page.evaluate(() => !!window.__pwned)), 'nothing in that corpus ran');
  await page.evaluate(() => JvWizard.close());

  /* A draft is data only: no page, not registered. */
  const draft = await page.evaluate(async () => {
    JvWizard.startFrom('TCH');
    JvWizard._st.def.ref = 'DRAFT1';
    JvWizard._st.def.displayName = 'A draft';
    await JvWizard.saveDraft();
    return JvWizard._st.result.replace(/<[^>]*>/g, '');
  });
  check(exists('special_jv_drafts/DRAFT1.json') && !exists('special_jv_templates/DRAFT1.html')
        && /not registered/.test(draft),
        'a draft writes one JSON file into special_jv_drafts and no page at all', draft.slice(0, 90));
  check(!(await page.evaluate(() => !!SpecialJV.get('DRAFT1'))), 'and nothing registers it');
  await page.evaluate(() => JvWizard.close());
  /* A draft that could be written and never reopened would be a trap. */
  await page.evaluate(() => { AEG.switchTab('specialjv'); });
  await page.waitForSelector('#jvDraftOpen_DRAFT1', { timeout: 15000 });
  check(/Drafts — not published, nobody else sees them/.test(await page.textContent('#jvDrafts')),
        'the tab lists the drafts, saying plainly that nobody else sees them');
  await page.click('#jvDraftOpen_DRAFT1');
  await page.waitForSelector('#jvwChips', { timeout: 15000 });
  const resumed = await page.evaluate(() => ({
    ref: JvWizard._st.def.ref, isNew: JvWizard._st.isNew,
    entries: (JvWizard._st.def.jvSpec.entries || []).length
  }));
  check(resumed.ref === 'DRAFT1' && resumed.isNew === true && resumed.entries === 4,
        'and "Carry on with it" reopens the draft where it was left, as a JV that is not published yet', resumed);
  await page.evaluate(() => JvWizard.close());

  /* §8.1 applies to the creator's own screens too, not only to the page it
     writes: everything on them is data someone typed. */
  const inj = await page.evaluate(() => {
    const hostile = '</h2><img src=x onerror=window.__pwned=1><script>window.__pwned=1</' + 'script>';
    JvWizard.startFrom('TCH');
    JvWizard._st.def.ref = 'INJ';
    JvWizard._st.def.displayName = hostile;
    JvWizard._st.def.description = hostile;
    const s = JvWizard._st.def.jvSpec;
    s.title = hostile;
    s.kinds[0].label = hostile;
    s.classify.rules[0].reason = hostile;
    s.fields[3].label = hostile;
    s.fields[3].group = hostile;
    s.aggregates[0].label = hostile;
    s.aggregates[0].group = hostile;
    s.slots[0].label = hostile;
    s.entries[0].label = hostile;
    s.remarks.templates.ccAdj = hostile;
    s.columns[1].label = hostile;
    const seen = { imgs: 0, scripts: 0 };
    for (let n = 1; n <= 9; n++) {
      JvWizard.go(n);
      const body = document.getElementById('appModalBody');
      seen.imgs += body.querySelectorAll('img').length;
      seen.scripts += body.querySelectorAll('script').length;
    }
    /* and the hostile text really is on the screen, as text */
    JvWizard.go(1);
    const shown = document.getElementById('jvwName').value === hostile;
    const echo = document.querySelector('[data-live="nameecho"]').textContent;
    return { imgs: seen.imgs, scripts: seen.scripts, pwned: !!window.__pwned, shown: shown, echo: echo };
  });
  check(inj.imgs === 0 && inj.scripts === 0 && !inj.pwned,
        'markup typed into any label, heading, narration or column name of the creator injects nothing into its own '
        + 'nine screens', inj);
  check(inj.shown && /<img src=x onerror=/.test(inj.echo),
        'and it is still shown back, as text, so the user can see what they typed', inj.echo.slice(0, 80));
  await page.evaluate(() => JvWizard.close());

  /* No engine, no creator: every screen here computes with the real JVCore. */
  const noEngine = await page.evaluate(() => {
    const was = window.JVCore;
    let opened = false;
    try {
      /* JVCore is a module-scope const, so the guard is exercised through the
         one function that reads it */
      const real = JvWizard._engineOrComplain();
      opened = real === true;
    } finally { window.JVCore = was; }
    return { guard: typeof JvWizard._engineOrComplain === 'function', opened: opened };
  });
  check(noEngine.guard && noEngine.opened,
        'the creator checks the engine is there before it opens anything, and says so when it is not', noEngine);

  /* The term builder is one stored form with two editors. */
  const terms = await page.evaluate(() => {
    const out = {};
    ['a + b - c', '-(a + b + c)', 'a', '-(a)', 'abs(a)', 'round2(a * 2)', 'ifpos(a - b)', 'a / 3', 'round(a, 3)',
     'min(a, b)', 'a * b'].forEach(src => {
      const m = JvWizard.parseTerms(src);
      out[src] = m.ok ? JvWizard.serialTerms(m) : 'opens in the formula box';
    });
    return out;
  });
  const sums = ['a + b - c', '-(a + b + c)', 'a', '-(a)', 'abs(a)', 'round2(a * 2)', 'ifpos(a - b)', 'a / 3', 'round(a, 3)'];
  check(sums.every(s => terms[s] === s),
        'every shape the term builder can show round-trips to the same text it came from', terms);
  /* The three traps a half-typed box sets. */
  const traps = await page.evaluate(() => {
    JvWizard.startFrom('TCH');
    const out = {};
    JvWizard.setTermOpt('e1', 'mul', 'abc');
    out.lettersInMul = JvWizard._entry('e1').amount;
    JvWizard.setTermOpt('e1', 'mul', '');
    out.clearedMul = JvWizard._entry('e1').amount;
    JvWizard.setTermOpt('e1', 'mul', '2');
    out.realMul = JvWizard._entry('e1').amount;
    JvWizard.setEd('minAbs', '');
    out.emptyFloor = JvWizard._st.def.jvSpec.entryDefaults.minAbs;
    JvWizard.setEd('round', '');
    out.emptyRound = JvWizard._st.def.jvSpec.entryDefaults.round;
    /* "— choose —" on the preset select must not fill the period with slot 0 */
    JvWizard.applyPreset(0, '0');
    const filled = JvWizard._st.sections[0].fields.periodFrom;
    JvWizard.applyPreset(0, '');
    out.preset = { filled: filled, afterChoose: JvWizard._st.sections[0].fields.periodFrom,
                   mark: JvWizard._st.sections[0].preset };
    return out;
  });
  check(traps.lettersInMul === 'rubEqUsd + rubEqEur' && traps.clearedMul === 'rubEqUsd + rubEqEur'
        && traps.realMul === '(rubEqUsd + rubEqEur) * 2',
        'letters typed into "then ×" are not a factor of zero — the amount is left alone until the number is real', traps);
  check(traps.emptyFloor === 0.01 && traps.emptyRound === 2,
        'clearing the smallest-amount or decimal-places box falls back to the default, not to zero', traps);
  check(traps.preset.filled === '10/01/26' && traps.preset.afterChoose === '10/01/26' && traps.preset.mark === '',
        'and choosing "— choose —" on the preset select clears the mark without rewriting the period', traps.preset);
  await page.evaluate(() => JvWizard.close());
  check(terms['min(a, b)'] === 'opens in the formula box' && terms['a * b'] === 'opens in the formula box',
        'and anything that is no longer a plain signed sum opens in the formula box instead', terms);

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[8] the share at the end of the run');
  const all = fs.readdirSync(abs('special_jv_mapping')).sort();
  const left = all.filter(f => !f.startsWith('.')).join(' ');
  check(left === 'TCH.json TCH3.json TCHW.json', 'three mappings: TCH untouched, plus the two the creator published', left);
  const locks = all.filter(f => f.startsWith('.lock_'));
  check(locks.length === 2 && locks.every(f => read('special_jv_mapping/' + f).trim() === '{}'),
        'the advisory locks were released rather than left held — they are dotfiles, so the registry never sees them',
        locks.map(f => f + '=' + read('special_jv_mapping/' + f).trim()));
  check(fs.readdirSync(abs('special_jv_templates')).filter(f => f.endsWith('.html')).sort().join(' ')
        === 'TCH.html TCH3.html TCHW.html', 'and three pages');
  const engineFiles = fs.readdirSync(abs('special_jv_templates/_engine')).sort();
  check(engineFiles.join(' ') === 'jv-core-1.0.0.js jv-page-1.0.0.css jv-page-1.0.0.js',
        'the engine was seeded once and only once', engineFiles);
  check(errors.length === 0, 'no page error and no console error in the whole run', errors.slice(0, 5));

} catch (e) {
  failures++;
  console.error('\nFATAL: ' + (e && e.stack || e));
} finally {
  clearTimeout(watchdog);
  try { await browser.close(); } catch (e) {}
  killAll();
}

console.log('\n' + (failures ? '✗ ' : '✓ ') + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
