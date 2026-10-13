// End-to-end tests for custom reports: what a report FILTER means on each
// kind of column, which operators are offered, how reports and the grid agree,
// summary cards and the total row, the on-screen row cap, and the CSV export.
//
//   node tests/e2e/run_reports_e2e.mjs
//
// Needs: python3, Playwright (Chromium). Exits non-zero on failure.
//
// The dataset is six rows wide enough to pin every column kind down:
//   Doc      text
//   Date     isDate            05/01/2026 · 15/02/2026 · 20/03/2026 ·
//                              10/06/2026 · 01/12/2025 · (blank)
//   Amount   isValue           100 · 200 · (50) · 1,234.50 · 300 · 0
//   TxtDate  text holding dates (untyped, so the filter's own bounds decide)
//   TxtNum   text holding numbers
// plus extras: Dbl (formula), BadCalc (a formula that cannot work),
//              DueDt (a formula producing dates), Acct (master lookup),
//              Tag (free tag); and the _status pseudo-column.

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
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 600) : '')); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Mirrors FilterOps._byKind.date in apps/Reco.html (kept here so the suite
// states the expectation rather than reading it from the code it tests).
const FILTER_KIND_OPS = { date: ['equals','not_equals','before','after','on_or_before','on_or_after',
  'between','not_between','contains','not_contains','empty','not_empty','in_list','not_in_list'] };
function eqCheck(got, expected, msg) { check(same(got, expected), msg, { got, expected }); }

function makeRoot(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-rpt-'));
  const root = path.join(base, name);
  const cp = (src, dst) => { fs.mkdirSync(path.dirname(path.join(root, dst)), { recursive: true }); fs.copyFileSync(path.join(REPO, src), path.join(root, dst)); };
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

/* Build the template + session described at the top of this file. */
async function setUp(page, name) {
  return page.evaluate(async (name) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.name = name;
    t.columns = [
      { name: 'Doc',     label: 'Doc',     formats: [], isValue: false, isDate: false },
      { name: 'Date',    label: 'Date',    formats: [], isValue: false, isDate: true  },
      { name: 'Amount',  label: 'Amount',  formats: [], isValue: true,  isDate: false },
      { name: 'TxtDate', label: 'TxtDate', formats: [], isValue: false, isDate: false },
      { name: 'TxtNum',  label: 'TxtNum',  formats: [], isValue: false, isDate: false },
      { name: 'Ref',     label: 'Ref',     formats: [], isValue: false, isDate: false }
    ];
    t.primaryKeys = ['Doc'];
    t.valueColumn = 'Amount';
    t.displayColumns = t.columns.map(c => c.name);
    t.additionalColumns = [
      { name: 'Dbl',     type: 'formula', formula: 'NUM({Amount})*2' },
      { name: 'BadCalc', type: 'formula', formula: '{Amount}*2' },
      { name: 'DueDt',   type: 'formula', formula: 'ADD_DAYS({Date},30)' },
      { name: 'Acct',    type: 'master',  masterRefColumn: 'Ref', masterValueColumn: 'Account' },
      { name: 'Tag',     type: 'custom' }
    ];
    t.enableReporting = true;
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.name === name);
    RecoTemplate.open(tpl.id);
    AppState.aegMaster = [{ Reference: 'R1', Account: '4000' }, { Reference: 'R2', Account: '5000' }];
    const spec = [
      ['D1', '05/01/2026', '100',      '05/01/2026', '100',    'R1'],
      ['D2', '15/02/2026', '200',      '15/02/2026', '200',    'R2'],
      ['D3', '20/03/2026', '(50)',     '20/03/2026', '-50',    'R1'],
      ['D4', '10/06/2026', '1,234.50', '10/06/2026', '1234.5', 'R3'],
      ['D5', '01/12/2025', '300',      '01/12/2025', '300',    'R2'],
      ['D6', '',           '0',        '',           '0',      ''  ]
    ];
    const fields = ['Doc', 'Date', 'Amount', 'TxtDate', 'TxtNum', 'Ref'];
    Reco.ingestData(tpl, spec.map(x => { const o = {}; fields.forEach((f, i) => o[f] = x[i]); return o; }), fields);
    App.closeModal();
    await AppState.flush();
    const sess = AppState.recoSessions[tpl.id];
    sess.manualTags = {};
    sess.manualTags[sess.data[0]._id + '||Tag'] = 'alpha';
    sess.offsets = {};
    sess.offsets[sess.data[2]._id] = true;          // D3 is offset
    AppState.activeRecoId = tpl.id;
    return tpl.id;
  }, name);
}

/* Which documents a report definition returns. */
const docsOf = (page, id, rpt) => page.evaluate(([id, rpt]) => {
  const tpl = AppState.recoTemplates.find(x => x.id === id);
  return Reco.runReport(tpl, AppState.recoSessions[id], rpt).map(r => r.Doc);
}, [id, rpt]);

const oneFilter = (col, op, val, val2, logic) => ({ name: 'R', columns: ['Doc'], logic, filters: [{ col, op, val, val2 }] });

/* The summary-card values a report renders. */
const cardsOf = (page, id, rpt) => page.evaluate(([id, rpt]) => {
  const tpl = AppState.recoTemplates.find(x => x.id === id);
  const h = Reco.renderCustomReport(tpl, AppState.recoSessions[id], rpt, 0);
  return [...h.matchAll(/card-value"><strong>([^<]*)</g)].map(x => x[1]);
}, [id, rpt]);

/* The table body of a report, as rows of cell text. */
const bodyOf = (page, id, rpt) => page.evaluate(([id, rpt]) => {
  const tpl = AppState.recoTemplates.find(x => x.id === id);
  const h = Reco.renderCustomReport(tpl, AppState.recoSessions[id], rpt, 0);
  const tb = h.slice(h.indexOf('<tbody>'));
  return [...tb.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<td[^>]*>([^<]*)</g)].map(x => x[1]));
}, [id, rpt]);

/* The total row of a report, as cell text. */
const totalOf = (page, id, rpt) => page.evaluate(([id, rpt]) => {
  const tpl = AppState.recoTemplates.find(x => x.id === id);
  const h = Reco.renderCustomReport(tpl, AppState.recoSessions[id], rpt, 0);
  const tr = (h.match(/<tr style="font-weight:bold[\s\S]*?<\/tr>/) || [''])[0];
  return [...tr.matchAll(/<td[^>]*>([^<]*)</g)].map(x => x[1]);
}, [id, rpt]);

/* Drive the real Reco.exportCustomReport and read back what it wrote. */
const csvOf = (page, id, rpt) => page.evaluate(([id, rpt]) => {
  const tpl = AppState.recoTemplates.find(x => x.id === id);
  tpl.reports = [rpt];
  AppState.activeRecoId = id;
  let text = null;
  const dl = U.download;
  U.download = (fn, body) => { text = body; return true; };
  try { Reco.exportCustomReport(0); } finally { U.download = dl; }
  const lines = String(text || '').trim().split(/\r?\n/);
  return { head: lines[0], rows: lines.slice(1), n: lines.length - 1 };
}, [id, rpt]);

const browser = await chromium.launch();
const procs = [];
const watchdog = setTimeout(() => {
  console.error('\nWATCHDOG: reports e2e exceeded 6 minutes; last check: ' + (passes + failures));
  procs.forEach(p => { try { p.kill(); } catch (e) {} });
  process.exit(2);
}, 360000);
const killAll = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });
process.on('exit', killAll);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { killAll(); process.exit(130); }));

try {
  const root = makeRoot('root');
  const B = await startBridge(root, 18926); procs.push(B.proc);
  const { page, errors } = await openReco(browser, B);
  const id = await setUp(page, 'RPT');

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[A] A filter means what the column\'s type implies');
  // The headline defect: 'between' ran through parseFloat, so '05/01/2026'
  // compared as the number 5 and a date range matched every row.
  eqCheck(await docsOf(page, id, oneFilter('Date', 'between', '01/01/2026', '31/03/2026')),
    ['D1', 'D2', 'D3'], 'A1 date range returns only the three rows in the quarter');
  eqCheck(await docsOf(page, id, oneFilter('Date', 'not_between', '01/01/2026', '31/03/2026')),
    ['D4', 'D5', 'D6'], 'A2 the inverse range returns the rest (a blank date is not in the range)');
  eqCheck(await docsOf(page, id, oneFilter('Date', 'between', '31/03/2026', '01/01/2026')),
    ['D1', 'D2', 'D3'], 'A3 bounds the wrong way round still mean the range');
  eqCheck(await docsOf(page, id, oneFilter('Date', 'between', '01/01/2026', '')),
    [], 'A4 a missing bound matches nothing, as a numeric bound always did');
  eqCheck(await docsOf(page, id, oneFilter('Date', 'equals', '2026-02-15')),
    ['D2'], 'A5 a date column compares days, so any notation finds the row');
  eqCheck(await docsOf(page, id, oneFilter('Date', 'in_list', '2026-01-05, 15/02/2026')),
    ['D1', 'D2'], 'A6 in-list on a date column compares days');
  eqCheck(await docsOf(page, id, oneFilter('Date', 'before', '01/01/2026')),
    ['D5'], 'A7 date before');
  eqCheck(await docsOf(page, id, oneFilter('Date', 'on_or_after', '05/01/2026')),
    ['D1', 'D2', 'D3', 'D4'], 'A8 date on or after');
  eqCheck(await docsOf(page, id, oneFilter('Date', 'empty')), ['D6'], 'A9 date is empty');
  // a value column compares amounts, in any notation
  eqCheck(await docsOf(page, id, oneFilter('Amount', 'between', '0', '500')),
    ['D1', 'D2', 'D5', 'D6'], 'A10 amount range unchanged (1,234.50 out, 0 in)');
  eqCheck(await docsOf(page, id, oneFilter('Amount', 'between', '-100', '150')),
    ['D1', 'D3', 'D6'], 'A11 amount range reaches an accounting negative');
  eqCheck(await docsOf(page, id, oneFilter('Amount', 'equals', '-50')),
    ['D3'], 'A12 a value column matches -50 against the stored "(50)"');
  eqCheck(await docsOf(page, id, oneFilter('Amount', 'equals', '1234.5')),
    ['D4'], 'A13 a value column matches 1234.5 against the stored "1,234.50"');
  eqCheck(await docsOf(page, id, oneFilter('Amount', 'equals', '1,234.50')),
    ['D4'], 'A14 the exact text still matches too');
  eqCheck(await docsOf(page, id, oneFilter('Amount', 'in_list', '-50, 1234.5')),
    ['D3', 'D4'], 'A15 in-list on a value column compares amounts');
  // A thousands separator is not a list separator (it split '1,234.50' into
  // 1 and 234.50 and matched the wrong rows).
  eqCheck(await docsOf(page, id, oneFilter('Amount', 'in_list', '1,234.50')),
    ['D4'], 'A15b one amount with a thousands separator is one list item');
  eqCheck(await docsOf(page, id, oneFilter('Amount', 'not_in_list', '1,234.50')),
    ['D1', 'D2', 'D3', 'D5', 'D6'], 'A15c not-in-list excludes exactly that amount');
  eqCheck(await docsOf(page, id, oneFilter('Amount', 'in_list', '1,234.50, -50')),
    ['D3', 'D4'], 'A15d a real list of amounts still splits on the comma');
  // Equality must mean on the same column what a range means (a date operand
  // on an untyped column was honoured by between but not by equals).
  eqCheck(await docsOf(page, id, oneFilter('TxtDate', 'equals', '05/01/2026')),
    await docsOf(page, id, oneFilter('TxtDate', 'between', '05/01/2026', '05/01/2026')),
    'A15e equals and a one-day range agree on a text column holding dates');
  // A date must never be reduced to its day number by a numeric comparison.
  eqCheck(await docsOf(page, id, oneFilter('TxtDate', 'between', '1', '10')),
    [], 'A15f a numeric range matches no date (it used to match the 1st-10th of any month)');
  // an untyped column: the filter's own bounds decide
  eqCheck(await docsOf(page, id, oneFilter('TxtDate', 'between', '01/01/2026', '31/03/2026')),
    ['D1', 'D2', 'D3'], 'A16 a text column holding dates gets a date range');
  eqCheck(await docsOf(page, id, oneFilter('TxtNum', 'between', '100', '300')),
    ['D1', 'D2', 'D5'], 'A17 a text column holding numbers keeps a numeric range');
  // On an untyped column the operand decides, and it must decide the SAME way
  // for every operator: A16 already honours a date range here, so equality
  // honours a date too. One mental model per column is the whole point of this
  // round — two would be the bug we just fixed, in a smaller place.
  eqCheck(await docsOf(page, id, oneFilter('TxtDate', 'equals', '2026-02-15')),
    ['D2'], 'A18 equality on an untyped column honours a date operand, as a range does');
  eqCheck(await docsOf(page, id, oneFilter('TxtDate', 'equals', 'not a date at all')),
    [], 'A18b a non-date operand is still compared as exact text');
  eqCheck(await docsOf(page, id, oneFilter('DueDt', 'between', '01/02/2026', '30/04/2026')),
    ['D1', 'D2', 'D3'], 'A19 a computed column producing dates gets a date range');
  eqCheck(await docsOf(page, id, oneFilter('Dbl', 'greater', '250')),
    ['D2', 'D4', 'D5'], 'A20 a computed numeric column compares as numbers');
  // An extra column carries no type flag, so giving it a date format in the
  // report declares it a date. (A template column's own flags always win.)
  eqCheck(await docsOf(page, id, { name: 'R', columns: ['Doc'],
    filters: [{ col: 'DueDt', op: 'equals', val: '2026-02-04' }] }),
    ['D1'], 'A21 equality on an extra column honours a date operand (same rule as A18)');
  eqCheck(await docsOf(page, id, { name: 'R', columns: ['Doc'], dateFormats: { DueDt: 'MMM-YY' },
    filters: [{ col: 'DueDt', op: 'equals', val: '2026-02-04' }] }),
    ['D1'], 'A21b a date format on an extra column makes its filter compare days');
  // extras and the status pseudo-column
  eqCheck(await docsOf(page, id, oneFilter('Acct', 'equals', '4000')), ['D1', 'D3'], 'A22 master-lookup extra');
  eqCheck(await docsOf(page, id, oneFilter('Tag', 'equals', 'alpha')), ['D1'], 'A23 free-tag extra');
  eqCheck(await docsOf(page, id, oneFilter('_status', 'equals', 'offset')), ['D3'], 'A24 status pseudo-column');
  eqCheck(await docsOf(page, id, oneFilter('_status', 'in_list', 'offset')), ['D3'], 'A25 status in-list');
  // AND / OR
  eqCheck(await docsOf(page, id, { name: 'R', columns: ['Doc'], logic: 'AND', filters: [
    { col: 'Date', op: 'on_or_after', val: '01/01/2026' }, { col: 'Date', op: 'on_or_before', val: '28/02/2026' }] }),
    ['D1', 'D2'], 'A26 two date conditions under AND');
  eqCheck(await docsOf(page, id, { name: 'R', columns: ['Doc'], logic: 'OR', filters: [
    { col: 'Date', op: 'between', val: '01/01/2026', val2: '31/01/2026' }, { col: 'Amount', op: 'greater', val: '1000' }] }),
    ['D1', 'D4'], 'A27 a date range OR an amount condition');
  // a half-finished filter row must not void the report
  eqCheck(await docsOf(page, id, { name: 'R', columns: ['Doc'], logic: 'OR', filters: [
    { col: 'Doc', op: 'equals', val: 'D1' }, { col: '', op: 'equals', val: '' }] }),
    ['D1'], 'A28 an unfinished filter row does not make an OR report match everything');

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[B] Only operators the column can honour are offered');
  const ops = await page.evaluate(() => ({
    date:   FilterOps.opsFor('date').map(o => o.op),
    value:  FilterOps.opsFor('value').map(o => o.op),
    status: FilterOps.opsFor('status').map(o => o.op),
    textN:  FilterOps.opsFor('text').length,
    allN:   FilterOps.list.length,
    kinds:  ['Date', 'Amount', 'Doc', '_status', 'Dbl'].map(c =>
              FilterOps.kindOf(AppState.recoTemplates.find(x => x.name === 'RPT'), c)),
    flagged: FilterOps.opsFor('date', 'greater').filter(o => o.op === 'greater').map(o => o.label),
    beforeLabel: FilterOps.opsFor('date').find(o => o.op === 'before').label
  }));
  check(ops.date.includes('between') && !ops.date.includes('greater'),
    'B1 a date column offers "between" and not ">"', ops.date);
  check(ops.value.includes('greater') && !ops.value.includes('before'),
    'B2 a value column offers ">" and not "date before"', ops.value);
  check(ops.date.includes('contains') && ops.value.includes('contains'),
    'B2b typed columns keep "contains" — it is how people find every March or a reference fragment', ops);
  eqCheck(ops.status, ['equals', 'not_equals', 'in_list', 'not_in_list'],
    'B3 the status column offers only equality and list operators');
  check(ops.textN === ops.allN, 'B4 an untyped text column keeps every operator', ops);
  eqCheck(ops.kinds, ['date', 'value', 'text', 'status', 'text'], 'B5 the kind comes from the template flags');
  check(/not suited/.test(ops.flagged[0] || ''),
    'B6 an operator saved before the column was typed stays visible, flagged', ops.flagged);
  check(ops.beforeLabel === 'before', 'B7 on a date column "date before" reads simply "before"', ops.beforeLabel);

  const menus = await page.evaluate((id) => {
    RecoTemplate.edit(id);
    const t = RecoTemplate._editing;
    t.reports = [{ name: 'R', columns: ['Doc'], filters: [{ col: 'Date', op: 'between', val: '', val2: '' }] }];
    const render = f => RecoTemplate._renderReportFilter(t, 0, 0, f);
    const out = {
      date:   render({ col: 'Date',    op: 'between', val: '', val2: '' }),
      value:  render({ col: 'Amount',  op: 'between', val: '', val2: '' }),
      status: render({ col: '_status', op: 'equals',  val: 'open' })
    };
    // changing the column repoints an operator the new column cannot honour
    t.reports[0].filters = [{ col: 'Doc', op: 'contains', val: 'x', val2: '' }];
    RecoTemplate.setReportFilterCol(0, 0, 'Date');
    out.afterSwitch = t.reports[0].filters[0].op;
    RecoTemplate.setReportFilterCol(0, 0, '_status');
    out.statusVal = t.reports[0].filters[0].val;
    App.closeModal();
    return out;
  }, id);
  check(!/value="greater"/.test(menus.date) && /value="between"/.test(menus.date),
    'B8 the report editor offers no ">" on a date column but keeps "between"');
  check(/dd\/mm\/yyyy/.test(menus.date), 'B9 the report editor hints the date notation');
  check(/value="greater"/.test(menus.value), 'B10 the report editor offers ">" on a value column');
  check(/<option value="offset"/.test(menus.status) && !/placeholder="value"/.test(menus.status),
    'B11 the status filter gets a two-value picker, not a free-text box');
  // 'contains' is valid on a date column (B2b), so switching keeps it. The
  // invariant that matters is that the operator always suits the new column.
  check(menus.afterSwitch && FILTER_KIND_OPS.date.includes(menus.afterSwitch),
    'B12 switching a filter column leaves an operator that suits the new column', menus.afterSwitch);
  check(menus.statusVal === 'open', 'B13 switching to the status column seeds a valid value', menus.statusVal);

  const editor = await page.evaluate((id) => {
    RecoTemplate.edit(id);
    const t = RecoTemplate._editing;
    t.reports = [{ name: 'R', columns: ['Doc'], showTotalRow: true, totalColumns: ['Doc'],
      summaryCards: [{ col: 'Amount', func: 'Sum' }, { col: 'Dropped', func: 'Max' }],
      filters: [{ col: 'Date', op: 'between', val: '01/01/2026', val2: '31/03/2026' }],
      computedCols: [{ name: 'Mon', formula: "MONTH({Date},'MMM-YY')" }] }];
    let html = '', err = null;
    try { html = RecoTemplate.renderStep4(t); } catch (e) { err = e.message; }
    App.closeModal();
    return { err, len: html.length,
      // a card may name any reachable column, not only the displayed ones
      offersAmount: /<option value="Amount" selected>/.test(html),
      offersExtra:  /<option value="Dbl">Dbl \(extra\)<\/option>/.test(html),
      keepsDropped: /Dropped — no longer in this template/.test(html),
      numHint:      /NUM\(\{Amount\}\)\*2/.test(html) };
  }, id);
  check(!editor.err && editor.len > 0, 'B14 the template editor renders a report with cards and filters', editor.err);
  check(editor.offersAmount && editor.offersExtra,
    'B15 a summary card may name any column the report can reach, displayed or not', editor);
  check(editor.keepsDropped, 'B16 a card naming a column the template no longer has says so', editor);
  check(editor.numHint, 'B17 the computed-column help says to wrap a formatted amount in NUM()', editor);

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[C] The grid and the reports cannot drift apart');
  const grid = await page.evaluate((id) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id), sess = AppState.recoSessions[id];
    const run = (cf, cs) => { sess.columnFilters = cf || {}; sess.columnSorts = cs || {};
                              return Reco.applyTableFiltersSort(tpl, sess).map(r => r.Doc); };
    const out = {
      dateRange: run({ Date: [{ op: 'between', val: '01/01/2026', val2: '31/03/2026' }] }),
      amtRange:  run({ Amount: [{ op: 'between', val: '0', val2: '500' }] }),
      dateEq:    run({ Date: [{ op: 'equals', val: '2026-02-15' }] }),
      dueSort:   run(null, { col: 'DueDt', dir: 'asc' }),
      // The menu lists operators only for conditions that exist, so give the
      // column one first — otherwise this check would pass vacuously.
      menu:      (() => { sess.columnFilters = { Date: [{ op: 'between', val: '', val2: '' }] };
                          Reco.toggleColDropdown('Date', document.body, { stopPropagation() {} });
                          const d = document.querySelector('.col-dropdown');
                          const h = d ? d.innerHTML : ''; if (d) d.remove(); return h; })(),
      amtMenu:   (() => { sess.columnFilters = { Amount: [{ op: 'between', val: '', val2: '' }] };
                          Reco.toggleColDropdown('Amount', document.body, { stopPropagation() {} });
                          const d = document.querySelector('.col-dropdown');
                          const h = d ? d.innerHTML : ''; if (d) d.remove(); return h; })()
    };
    sess.columnFilters = {}; sess.columnSorts = {};
    return out;
  }, id);
  eqCheck(grid.dateRange, ['D1', 'D2', 'D3'], 'C1 a date range typed in the grid compares days too');
  eqCheck(grid.amtRange, ['D1', 'D2', 'D5', 'D6'], 'C2 an amount range in the grid is unchanged');
  eqCheck(grid.dateEq, ['D2'], 'C3 the grid accepts any date notation for equality');
  eqCheck(grid.dueSort, ['D5', 'D1', 'D2', 'D3', 'D4', 'D6'],
    'C4 the grid sorts a computed date column as dates, not as text');
  check(/value="between"/.test(grid.menu) && !/value="greater"/.test(grid.menu),
    'C5 the grid column menu for a date column offers "between" and no ">"', grid.menu.slice(0, 300));
  check(/value="greater"/.test(grid.amtMenu) && !/value="before"/.test(grid.amtMenu),
    'C6 the grid column menu for a value column offers ">" and no "date before"', grid.amtMenu.slice(0, 300));

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[D] Sorting, every column kind, both directions, blanks last');
  const sorts = {};
  for (const [k, col, dir] of [['dateAsc','Date','asc'], ['dateDesc','Date','desc'],
                               ['amtAsc','Amount','asc'], ['amtDesc','Amount','desc'],
                               ['docDesc','Doc','desc'], ['dblAsc','Dbl','asc'],
                               ['dueAsc','DueDt','asc'], ['acctDesc','Acct','desc']]) {
    sorts[k] = await docsOf(page, id, { name: 'R', columns: ['Doc'], sortCol: col, sortDir: dir });
  }
  eqCheck(sorts.dateAsc, ['D5', 'D1', 'D2', 'D3', 'D4', 'D6'], 'D1 date ascending, blank last');
  eqCheck(sorts.dateDesc, ['D4', 'D3', 'D2', 'D1', 'D5', 'D6'], 'D2 date descending, blank last');
  eqCheck(sorts.amtAsc, ['D3', 'D6', 'D1', 'D2', 'D5', 'D4'], 'D3 amount ascending, negative first');
  eqCheck(sorts.amtDesc, ['D4', 'D5', 'D2', 'D1', 'D6', 'D3'], 'D4 amount descending');
  eqCheck(sorts.docDesc, ['D6', 'D5', 'D4', 'D3', 'D2', 'D1'], 'D5 text descending');
  eqCheck(sorts.dblAsc, ['D3', 'D6', 'D1', 'D2', 'D5', 'D4'], 'D6 a computed numeric column sorts as numbers');
  eqCheck(sorts.dueAsc, ['D5', 'D1', 'D2', 'D3', 'D4', 'D6'],
    'D7 a computed date column sorts as dates ("04-Feb-26" is not before "31-Dec-25")');
  eqCheck(sorts.acctDesc, ['D2', 'D5', 'D1', 'D3', 'D4', 'D6'], 'D8 a master-lookup column sorts, blanks last');
  eqCheck(await docsOf(page, id, { name: 'R', columns: ['Doc'], sortCol: 'Due2', sortDir: 'asc',
    computedCols: [{ name: 'Due2', formula: 'ADD_DAYS({Date},10)' }] }),
    ['D5', 'D1', 'D2', 'D3', 'D4', 'D6'], 'D9 a report computed column holding dates sorts as dates');
  eqCheck(await docsOf(page, id, { name: 'R', columns: ['Doc'], sortCol: 'Tri', sortDir: 'desc',
    computedCols: [{ name: 'Tri', formula: 'NUM({Amount})*3' }] }),
    ['D4', 'D5', 'D2', 'D1', 'D6', 'D3'], 'D10 a report computed numeric column sorts as numbers');

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[E] Computed columns');
  const vals = (rpt, col) => page.evaluate(([id, rpt, col]) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id);
    return Reco.runReport(tpl, AppState.recoSessions[id], rpt).map(r => String(r[col]));
  }, [id, rpt, col]);
  eqCheck(await vals({ computedCols: [{ name: 'Quad', formula: '{Dbl}*2' }] }, 'Quad'),
    ['400', '800', '-200', '4938', '1200', '0'], 'E1 a computed column can reference an extra');
  eqCheck(await vals({ computedCols: [{ name: 'A', formula: 'NUM({Amount})*2' }, { name: 'Bc', formula: '{A}+1' }] }, 'Bc'),
    ['201', '401', '-99', '2470', '601', '1'], 'E2 a computed column can reference an earlier computed column');
  eqCheck(await vals({ computedCols: [{ name: 'Mon', formula: "MONTH({Date},'MMM-YY')" }] }, 'Mon'),
    ['Jan-26', 'Feb-26', 'Mar-26', 'Jun-26', 'Dec-25', ''], 'E3 MONTH() over the date column');
  eqCheck(await docsOf(page, id, { name: 'R', columns: ['Doc'],
    computedCols: [{ name: 'Mon', formula: "MONTH({Date},'MMM-YY')" }], filters: [{ col: 'Mon', op: 'equals', val: 'Feb-26' }] }),
    ['D2'], 'E4 a filter on a computed column');
  eqCheck(await vals({ columns: ['Doc', 'BadCalc'] }, 'BadCalc'),
    ['200', '400', '#ERR', '#ERR', '600', '0'],
    'E5 a bare token on a formatted amount reads #ERR, not NaN');
  eqCheck(await vals({ computedCols: [{ name: 'Z', formula: '1/0' }] }, 'Z'),
    ['#ERR', '#ERR', '#ERR', '#ERR', '#ERR', '#ERR'], 'E6 divide by zero reads #ERR, not Infinity');

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[F] Summary cards and the total row');
  eqCheck(await cardsOf(page, id, { name: 'R', columns: ['Doc', 'Amount'], summaryCards: [
    { col: 'Amount', func: 'Sum' }, { col: 'Amount', func: 'Count' }, { col: 'Amount', func: 'Avg' },
    { col: 'Amount', func: 'Min' }, { col: 'Amount', func: 'Max' }] }),
    ['1784.50', '6', '297.42', '-50.00', '1234.50'], 'F1 Sum/Count/Avg/Min/Max over amounts');
  eqCheck(await cardsOf(page, id, { name: 'R', columns: ['Doc'], filters: [{ col: 'Doc', op: 'equals', val: 'zz' }],
    summaryCards: [{ col: 'Amount', func: 'Sum' }, { col: 'Amount', func: 'Count' },
                   { col: 'Amount', func: 'Avg' }, { col: 'Amount', func: 'Min' }] }),
    ['0.00', '0', '—', '—'], 'F2 over an empty result: Sum is zero, Avg and Min have no answer');
  eqCheck(await cardsOf(page, id, { name: 'R', columns: ['Doc'], summaryCards: [
    { col: 'TxtDate', func: 'Sum' }, { col: 'TxtDate', func: 'Count' }, { col: 'TxtDate', func: 'Min' }] }),
    ['—', '5', '—'], 'F3 over a column with no numbers: Count still counts, the rest are blank');
  eqCheck(await cardsOf(page, id, { name: 'R', columns: ['Doc'], summaryCards: [
    { col: 'Dbl', func: 'Min' }, { col: 'Dbl', func: 'Max' }] }),
    ['-100.00', '2469.00'], 'F4 Min/Max over a computed column');
  eqCheck(await cardsOf(page, id, { name: 'R', columns: ['Doc'], summaryCards: [{ col: 'Amount', func: 'Sum' }] }),
    ['1784.50'], 'F5 a card works on a column the report does not display');
  eqCheck(await cardsOf(page, id, { name: 'R', columns: ['Doc'], summaryCards: [{ col: 'Gone', func: 'Sum' }] }),
    ['—'], 'F6 a card on a column deleted from the template reads blank, it does not throw');
  eqCheck(await totalOf(page, id, { name: 'R', columns: ['Doc', 'Date', 'Amount'], showTotalRow: true, totalColumns: ['Amount'] }),
    ['Total', '', '1784.50'],
    'F7 the total row includes the accounting negative "(50)" and agrees with the Sum card');
  eqCheck(await totalOf(page, id, { name: 'R', columns: ['Amount', 'Dbl'], showTotalRow: true, totalColumns: ['Amount', 'Dbl'] }),
    ['1784.50', '3569.00'], 'F8 two totalled columns');
  eqCheck(await totalOf(page, id, { name: 'R', columns: ['Doc', 'Amount'], showTotalRow: true,
    totalColumns: ['Amount'], filters: [{ col: 'Date', op: 'between', val: '01/01/2026', val2: '31/03/2026' }] }),
    ['Total', '250.00'], 'F9 the total row covers the filtered set');

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[G] What the table shows, and what the CSV writes');
  eqCheck((await bodyOf(page, id, { name: 'R', columns: ['Doc', 'Date'], dateFormats: { Date: 'MMM-YY' } })).map(r => r[1]),
    ['Jan-26', 'Feb-26', 'Mar-26', 'Jun-26', 'Dec-25', ''], 'G1 a date-format override is applied in the table');
  eqCheck((await bodyOf(page, id, { name: 'R', columns: ['Doc', 'Gone'] })).map(r => r[1]),
    ['', '', '', '', '', ''], 'G2 a column deleted from the template renders blank, not "undefined"');
  eqCheck((await bodyOf(page, id, { name: 'R', columns: ['Doc', 'Dbl', 'Tag'] })).map(r => r[1] + '/' + r[2]),
    ['200/alpha', '400/', '-100/', '2469/', '600/', '0/'], 'G3 extras render in the table');
  eqCheck((await bodyOf(page, id, { name: 'R', columns: [] }))[0].length, 6,
    'G4 a report with no columns chosen falls back to the template columns');
  const csvFmt = await csvOf(page, id, { name: 'R', columns: ['Doc', 'Date'], dateFormats: { Date: 'MMM-YY' } });
  eqCheck(csvFmt.rows[0], 'D1,Jan-26', 'G5 the CSV export shows the same date as the table');
  const csvAll = await csvOf(page, id, { name: 'R', columns: ['Doc'], sortCol: 'Amount', sortDir: 'asc' });
  check(csvAll.n === 6 && csvAll.rows[0] === 'D3', 'G6 the CSV export carries every row, in the report\'s order', csvAll);
  const csvFiltered = await csvOf(page, id, { name: 'R', columns: ['Doc'],
    filters: [{ col: 'Date', op: 'between', val: '01/01/2026', val2: '31/03/2026' }] });
  eqCheck(csvFiltered.rows, ['D1', 'D2', 'D3'], 'G7 the CSV export applies the report\'s date range');
  // an Excel serial stored as text in a date column
  const serial = await page.evaluate((id) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id), sess = AppState.recoSessions[id];
    const keep = sess.data[0].Date; sess.data[0].Date = '46027';     // 05/01/2026
    const cell = f => { const h = Reco.renderCustomReport(tpl, sess, { name: 'R', columns: ['Doc', 'Date'], dateFormats: f }, 0);
                        const tb = h.slice(h.indexOf('<tbody>'));
                        return [...tb.matchAll(/<td[^>]*>([^<]*)</g)].map(x => x[1])[1]; };
    const out = { fmt: cell({ Date: 'DD-MMM-YYYY' }), dflt: cell(null),
      range: Reco.runReport(tpl, sess, { filters: [{ col: 'Date', op: 'between', val: '01/01/2026', val2: '31/03/2026' }] }).map(r => r.Doc) };
    sess.data[0].Date = keep;
    return out;
  }, id);
  check(serial.fmt === '05-Jan-2026', 'G8 a serial date honours the report date format', serial.fmt);
  check(serial.dflt === '05/01/26', 'G9 a serial date in a date column is shown as a date by default', serial.dflt);
  eqCheck(serial.range, ['D1', 'D2', 'D3'], 'G10 a serial date still compares as a date in a range');

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[H] Nothing throws on a report that outlived its template');
  const survived = await page.evaluate((id) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id), sess = AppState.recoSessions[id];
    const safe = rpt => { try { Reco.renderCustomReport(tpl, sess, rpt, 0); return 'ok'; } catch (e) { return 'THREW: ' + e.message; } };
    return {
      filter: Reco.runReport(tpl, sess, { filters: [{ col: 'Gone', op: 'equals', val: 'x' }] }).length,
      sort:   Reco.runReport(tpl, sess, { sortCol: 'Gone', sortDir: 'asc' }).length,
      fmt:    safe({ name: 'R', columns: ['Doc', 'Gone'], dateFormats: { Gone: 'MMM-YY' } }),
      total:  safe({ name: 'R', columns: ['Doc', 'Gone'], showTotalRow: true, totalColumns: ['Gone'] })
    };
  }, id);
  check(survived.filter === 0, 'H1 a filter on a deleted column matches nothing', survived);
  check(survived.sort === 6, 'H2 a sort on a deleted column keeps every row', survived);
  check(survived.fmt === 'ok' && survived.total === 'ok', 'H3 a date format and a total on a deleted column do not throw', survived);
  check(errors.length === 0, 'H4 no page errors across every report above', errors);

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[I] 200,000 rows: the cards must not blow the stack, the cap must be visible');
  const root2 = makeRoot('root2');
  const B2 = await startBridge(root2, 18927); procs.push(B2.proc);
  const S2 = await openReco(browser, B2);
  const id2 = await setUp(S2.page, 'BIG');
  const big = await S2.page.evaluate(([id, N]) => {
    const tpl = AppState.recoTemplates.find(x => x.id === id), sess = AppState.recoSessions[id];
    const extra = [];
    for (let i = 0; i < N; i++) extra.push({ _id: 'x' + i, _pk: 'P' + i, Doc: 'P' + i,
      Date: '0' + (1 + i % 9) + '/0' + (1 + i % 9) + '/2026', Amount: String(i % 997),
      TxtDate: '05/01/2026', TxtNum: String(i % 997), Ref: 'R1' });
    sess.data = sess.data.concat(extra);
    const t0 = performance.now();
    const out = { rows: sess.data.length };
    try {
      const h = Reco.renderCustomReport(tpl, sess, { name: 'Big', columns: ['Doc', 'Amount'],
        summaryCards: [{ col: 'Amount', func: 'Min' }, { col: 'Amount', func: 'Max' },
                       { col: 'Amount', func: 'Sum' }, { col: 'Amount', func: 'Avg' }, { col: 'Amount', func: 'Count' }],
        showTotalRow: true, totalColumns: ['Amount'] }, 0);
      out.ms = Math.round(performance.now() - t0);
      out.cards = [...h.matchAll(/card-value"><strong>([^<]*)</g)].map(x => x[1]);
      out.bodyRows = (h.slice(h.indexOf('<tbody>')).match(/<tr>/g) || []).length;
      out.capTop = /showing the first 5,000 of 200,006 rows/.test(h);
      out.capBottom = /Export CSV<\/b> writes all 200,006/.test(h);
      out.rowCount = /200,006 rows · logic/.test(h);
    } catch (e) { out.err = e.message; }
    // a date range over the whole set
    const t1 = performance.now();
    out.rangeRows = Reco.runReport(tpl, sess, { filters: [{ col: 'Date', op: 'between', val: '01/01/2026', val2: '03/03/2026' }] }).length;
    out.rangeMs = Math.round(performance.now() - t1);
    return out;
  }, [id2, 200000]);
  check(!big.err, 'I1 a 200k-row report with Min/Max cards renders (no "Maximum call stack size exceeded")', big.err);
  eqCheck((big.cards || []).slice(0, 2), ['-50.00', '1234.50'], 'I2 Min and Max are right over 200,006 values');
  check((big.cards || [])[4] === '200,006', 'I3 Count covers every row', big.cards);
  check(big.bodyRows === 5000, 'I4 the table draws the capped 5,000 rows', big.bodyRows);
  check(big.capTop, 'I5 the cap is stated in the toolbar, above the table');
  check(big.capBottom, 'I6 the cap note says the export gives all of them');
  check(big.rowCount, 'I7 the toolbar states the true row count');
  // The generated rows cycle through 01/01 … 09/09; three of those nine dates
  // fall in 01/01–03/03. 200,000 rows over nine dates give 22,223 + 22,223 +
  // 22,222 = 66,668 of them, plus D1 (05/01) and D2 (15/02) — D3 (20/03) is
  // past the upper bound. Before the fix this returned all 200,005 dated rows.
  check(big.rangeRows === 66670,
    'I8 a date range over 200,006 rows returns exactly the 66,670 rows in it', { got: big.rangeRows });
  check(S2.errors.length === 0, 'I9 no page errors on the 200k report', S2.errors);
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
