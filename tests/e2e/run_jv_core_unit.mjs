// Unit tests for the Special JV compute core — no browser, no ports, ~1 second.
//
//   node tests/e2e/run_jv_core_unit.mjs
//
// This is the test that gets run most, so it covers the things that must never
// drift:
//   [A]-[E] TCH's own spec produces TCH's own figures, field by field;
//   [F]     the formula parser refuses every hostile and malformed amount, so
//           a future "let's just compile the string, it's faster" fails loudly;
//   [G]     validateSpec catches the mistakes a creator user will really make;
//   [H]     all 22 FilterOps operators plus date_between;
//   [I]-[J] the submit checks and the spec hash;
//   [K]-[M] the repo invariants: no compiled text anywhere in the engine, the
//           generated page carries no script of its own, and the copies of the
//           engine inside apps/Reco.html are byte-identical to the files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const ENGINE_DIR = path.join(REPO, 'special_jv_templates/_engine');
const require = createRequire(import.meta.url);
const C = require(path.join(ENGINE_DIR, 'jv-core-1.0.0.js'));

let ok = 0, bad = 0;
const t = (cond, msg, extra) => {
  if (cond) { ok++; console.log('  ✓ ' + msg); }
  else { bad++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

const DEF = JSON.parse(fs.readFileSync(path.join(REPO, 'special_jv_mapping/TCH.json'), 'utf8'));
const SPEC = DEF.jvSpec;
const clone = o => JSON.parse(JSON.stringify(o));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[A] validateSpec on the real TCH mapping');
const v0 = C.validateSpec(DEF);
t(v0.errors.length === 0, 'no errors', v0.errors);
t(v0.warnings.length === 0, 'no warnings', v0.warnings);
t(C.version === '1.0.0' && C.SPEC_MIN === 1 && C.SPEC_MAX === 1, 'engine 1.0.0 understands spec version 1 only');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[B] the four rows of tests/e2e/run_e2e.mjs, projected the way Reco projects them');
const ROWS = [
  { _pk: 'D1', Date: '06/10/2026', 'Txn Type': 'RAPID', Currency: 'USD', 'FC Amount': '100' },
  { _pk: 'D2', Date: '07/10/2026', 'Txn Type': 'RAPID', Currency: 'EUR', 'FC Amount': '50' },
  { _pk: 'D3', Date: '12/10/2026', 'Txn Type': 'OF01',  Currency: 'RUB', 'FC Amount': '-9000' },
  { _pk: 'D4', Date: '08/10/2026', 'Txn Type': 'RAPID', Currency: 'RUB', 'FC Amount': '5000' }
];
const CLS = ROWS.map(r => C.classify(SPEC, r));
t(CLS.map(c => c.kind).join() === 'rapid,rapid,of,rapid', 'classification rapid,rapid,of,rapid', CLS.map(c => c.kind));
t(CLS[0].label === 'RAPID' && CLS[2].label === 'OF', 'each row carries the row type\'s label', [CLS[0].label, CLS[2].label]);

const P = C.presets(SPEC, ROWS);
t(P.length === 3, 'three slots for the one month in the data', P.map(p => p.label));
t(P[0].label === '1-10 Oct 2026' && P[0].from === '10/01/26' && P[0].to === '10/10/26',
  'preset 0 = "1-10 Oct 2026" 10/01/26 → 10/10/26 (the e2e asserts 10/01/26)', P[0]);
t(P[2].label === '21-31 Oct 2026' && P[2].to === '10/31/26', 'the last slot ends on the real end of month', P[2]);

const S1 = C.newSection(SPEC, 1);
Object.assign(S1.fields, { periodFrom: P[0].from, periodTo: P[0].to, rubEqUsd: '7000', rubEqEur: '5000' });
const ASG = {};
const aa = C.autoAssign(SPEC, ROWS, CLS, [S1], ASG);
t(aa.assigned === 3 && aa.nodate === 0 && ASG[0] === 1 && ASG[1] === 1 && ASG[3] === 1 && !ASG[2],
  'auto-assign puts D1, D2, D4 in section 1 and leaves D3 (12 Oct) out', { aa, ASG });

const AG = C.aggregates(SPEC, ROWS, CLS, ASG, 1).values;
const totals = [AG.rapid_RUB, AG.rapid_USD, AG.rapid_EUR, AG.of_RUB].map(C.fmtNum).join('|');
t(totals === '5,000.00|100.00|50.00|0.00', 'the totals render "5,000.00|100.00|50.00|0.00" — the exact e2e string', totals);
t(AG['@rowsUsed'] === 3, '@rowsUsed counts the three assigned, classified rows', AG['@rowsUsed']);

const B = C.buildAll(DEF, SPEC, ROWS, CLS, ASG, [S1]);
const L = B.lines;
t(L.length === 8, '8 lines', L.length);
t(Object.keys(L[0]).join('|') === C.LINE_ORDER.join('|'), 'the key order is the AEG output column order', Object.keys(L[0]));
t(L[0].Desc === 'Cross Currency Adjustment Entry for 01 Oct - 10 Oct 26', 'the remark uses the real period', L[0].Desc);
t(L[0].Nominal === '17036' && L[0].Dr === '12000.00' && L[1].Nominal === '85001' && L[1].Cr === '12000.00',
  'entry 1 Dr 17036 / Cr 85001 12,000.00', [L[0], L[1]]);
t(L[2].Nominal === '85001' && L[2].Cur === 'USD' && L[2].Dr === '100.00' && L[3].Nominal === '17036' && L[3].Cr === '100.00',
  'entry 2 Dr 85001 / Cr 17036 100.00 USD', [L[2], L[3]]);
t(L[4].Cur === 'EUR' && L[4].Dr === '50.00' && L[5].Cr === '50.00', 'entry 3 EUR 50.00', [L[4], L[5]]);
t(L[6].Nominal === '17036' && L[6].Dr === '17000.00' && L[7].Nominal === '35008' && L[7].RC === '50000' && L[7].Cr === '17000.00',
  'entry 4 is negative → the sides swap (Dr clearing 17036, Cr charges 35008/50000)', [L[6], L[7]]);
t(L.every(l => l.SubNominal === '0' && l['Analysis Key'] === '0' && l.LOB === '51' && l.Reference === '' && l.Doc === ''),
  'the shared account fields are on every line');
t(L.every(l => l.Reco === 'TCH1'), 'Reco defaults to TCH1 when the code is left empty', L[0].Reco);
t(L.every(l => (l.Dr === '') !== (l.Cr === '')), 'every line carries a debit or a credit, never both and never neither');
t(B.primaryKeys.slice().sort().join() === 'D1,D2,D4', 'consumed D1, D2, D4 only', B.primaryKeys);
const bal = C.balances(L);
t(Object.keys(bal).every(c => Math.abs(bal[c].dr - bal[c].cr) < 0.005), 'every currency balances', bal);
t(B.sections.length === 1 && B.sections[0].section === 'T1' && B.sections[0].title === 'TCH 1'
  && B.sections[0].fields.rubNo21 === '', 'the section record carries its token, title and typed fields for the audit trail',
  B.sections[0] && { section: B.sections[0].section, title: B.sections[0].title });

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[C] inputColumns must carry every accepted spelling (Reco sends only those)');
const aliased = clone(DEF);
aliased.jvSpec.columns[0].accept = ['Posting Date', 'Txn Date', 'Transaction Date', 'Value Date'];
aliased.jvSpec.columns[1].accept = ['Transaction Type', 'Type'];
aliased.jvSpec.columns[2].accept = ['Cur', 'CCY'];
aliased.jvSpec.columns[3].accept = ['Amount', 'Amt', 'Value'];
const vAlias = C.validateSpec(aliased);
t(vAlias.errors.some(e => /inputColumns is missing 11 accepted column name/.test(e)),
  'a spec that accepts a spelling the mapping does not declare is REFUSED (it would arrive blank)',
  vAlias.errors.filter(e => /inputColumns/.test(e)));
aliased.inputColumns = [];
[['Date', 'Posting Date', 'Txn Date', 'Transaction Date', 'Value Date'],
 ['Txn Type', 'Transaction Type', 'Type'],
 ['Currency', 'Cur', 'CCY'],
 ['FC Amount', 'Amount', 'Amt', 'Value']].forEach(g => g.forEach(n => aliased.inputColumns.push({ name: n })));
t(C.validateSpec(aliased).errors.length === 0, 'with the union declared it validates', C.validateSpec(aliased).errors);
const ac = C.classify(aliased.jvSpec, { _pk: 'A1', 'Posting Date': '06/10/2026', TxnType: 'RAPID', CCY: 'usd', Amt: '(100)' });
t(ac.kind === 'rapid' && ac.cur === 'USD' && ac.amt === -100,
  '"Posting Date" / "TxnType" / "CCY" / "Amt" and the accounting negative "(100)" all read correctly', ac);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[D] forEachCurrency is a static pre-pass: the compact spec posts the same lines');
const compact = clone(DEF);
compact.jvSpec.entries = [
  compact.jvSpec.entries[0],
  { id: 'cc', label: 'Cross Currency Adjustment {cur}', amount: 'rapid_{cur}', dr: 'crossCcy', cr: 'clearing',
    remark: 'ccAdj', forEachCurrency: ['USD', 'EUR'] },
  compact.jvSpec.entries[3]
];
t(C.validateSpec(compact).errors.length === 0, 'the compact spec validates (expanded before it is linted)', C.validateSpec(compact).errors);
t(C.expandEntries(compact.jvSpec).map(e => e.id).join() === 'e1,cc_USD,cc_EUR,e4', 'the expansion ids are deterministic',
  C.expandEntries(compact.jvSpec).map(e => e.id));
const L2 = C.buildAll(compact, compact.jvSpec, ROWS, CLS, ASG, [S1]).lines;
t(JSON.stringify(L2) === JSON.stringify(L), '3 entry rules produce byte-identical lines to the 4 hand-written ones');
const badLoop = clone(compact);
badLoop.jvSpec.entries[1].forEachCurrency = ['USD', 'GBP'];
t(C.validateSpec(badLoop).errors.some(e => /unknown name "rapid_GBP"/.test(e)),
  'an expanded entry is linted too: rapid_GBP is caught at save time', C.validateSpec(badLoop).errors.slice(0, 2));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[E] a second section, the swap, and the 0.01 floor');
const S2 = C.newSection(SPEC, 2);
Object.assign(S2.fields, { periodFrom: P[1].from, periodTo: P[1].to, recoCode: 'TCHX' });
const ASG2 = Object.assign({}, ASG, { 2: 2 });
const B2 = C.buildAll(DEF, SPEC, ROWS, CLS, ASG2, [S1, S2]);
const sec2 = B2.lines.filter(l => l.Reco === 'TCHX');
t(sec2.length === 2 && sec2[0].Nominal === '35008' && sec2[0].Dr === '9000.00' && sec2[1].Nominal === '17036',
  'section 2: -(-9000) = +9000 Dr charges / Cr clearing', sec2);
t(B2.primaryKeys.slice().sort().join() === 'D1,D2,D3,D4', 'both sections consume their own rows', B2.primaryKeys);
const S3 = C.newSection(SPEC, 9);
Object.assign(S3.fields, { periodFrom: P[0].from, periodTo: P[0].to, recoCode: 'Z', rubEqUsd: '0.004' });
t(C.buildAll(DEF, SPEC, [], [], {}, [S3]).lines.length === 0, 'an amount below 0.01 posts nothing at all');
const handDropped = clone(DEF);
const hdCls = [C.classify(handDropped.jvSpec, { _pk: 'X1', 'Txn Type': 'BANK', Currency: 'AED', 'FC Amount': '10' })];
const hdAsg = { 0: 1 };
const hdS = C.newSection(handDropped.jvSpec, 1);
Object.assign(hdS.fields, { periodFrom: P[0].from, periodTo: P[0].to, rubEqUsd: '100' });
const hd = C.buildAll(handDropped, handDropped.jvSpec, [{ _pk: 'X1', 'Txn Type': 'BANK', Currency: 'AED', 'FC Amount': '10' }], hdCls, hdAsg, [hdS]);
t(hd.primaryKeys.length === 0 && hd.lines.length === 4,
  'a row dropped into a section by hand that no rule classifies is NOT reported as consumed', hd.primaryKeys);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[F] what the amount parser refuses — the whole safety argument for formulas');
const SCOPE = { rubEqUsd: 1, rapid_USD: 2, of_RUB: 3 };
const HOSTILE = [
  ['alert(1)',                       /unknown function "alert"/],
  ['window.top.location',            /unexpected character "\." at 6/],
  ['rubEqUsd; alert(1)',             /unexpected character ";" at 8/],
  ['constructor.constructor("x")()',  /unexpected character "\." at 11/],
  ['rapid_USD[0]',                   /unexpected character "\[" at 9/],
  ['"str"',                          /unexpected character """ at 0/],
  ['__proto__',                      /unknown name "__proto__"/],
  ['this',                           /unknown name "this"/],
  ['1+1)//',                         /trailing input in formula/],
  ['rubEqUsd++',                     /unexpected end of formula/],
  ['process.exit(1)',                /unexpected character "\." at 7/],
  ['x'.repeat(501),                  /formula longer than 500 characters/],
  ['of_RUB/0',                       /division by zero/],
  ['globalThis',                     /unknown name "globalThis"/],
  ['rapid_USD`x`',                   /unexpected character "`" at 9/],
  ['$x',                             /unexpected character "\$" at 0/],
  ['rubEqUsd{}',                     /unexpected character "\{" at 8/],
  ['()',                             /unexpected "\)" in formula/],
  ['',                               /the amount is empty/],
  ['1,2',                            /trailing input in formula/],
  [('1+').repeat(300) + '1',         /formula too complex|formula longer than/],
  ['min()',                          /needs at least one value/],
  ['round2(1,2)',                    /takes at most 1 value/]
];
let refused = 0;
HOSTILE.forEach(([src, re]) => {
  let why = null;
  try { const r = C.Expr.evaluate(src, SCOPE); why = 'EVALUATED to ' + r; }
  catch (e) { why = e.message; }
  if (re.test(why)) refused++;
  else console.log('       ' + JSON.stringify(String(src).slice(0, 26)) + ' → ' + why + '   (wanted ' + re + ')');
});
t(refused === HOSTILE.length, 'all ' + HOSTILE.length + ' hostile or malformed amounts are refused with the right reason', refused);
t((() => { try { C.Expr.evaluate('of_RUB/0', SCOPE); return false; } catch (e) { return true; } })(),
  'division by zero throws instead of silently posting 0 (a silent zero is a wrong posting)');
const legal = [['1 + 2 * 3', 7], ['-(1+2)', -3], ['abs(0-4)', 4], ['min(5,2,9)', 2], ['max(5,2)', 5],
               ['round(2.345, 2)', 2.35], ['round2(2.344)', 2.34], ['neg(3)', -3], ['ifpos(0-2)', 0],
               ['ifneg(0-2)', -2], ['rapid_USD + rubEqUsd', 3], ['(of_RUB - 1) / 2', 1]];
t(legal.every(([src, want]) => Math.abs(C.Expr.evaluate(src, SCOPE) - want) < 1e-9),
  'the ' + legal.length + ' legal forms evaluate correctly', legal.map(([s]) => s + '=' + C.Expr.evaluate(s, SCOPE)));
const inf = clone(DEF);
inf.jvSpec.entries[0].amount = '9'.repeat(309);
let infMsg = '';
try { C.buildAll(inf, inf.jvSpec, ROWS, CLS, ASG, [S1]); } catch (e) { infMsg = e.message; }
t(/Cross Currency Adjustment \(RUB\)/.test(infMsg) && /not a finite number/.test(infMsg),
  'an amount that overflows to infinity throws, naming the entry', infMsg);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[G] validateSpec catches the mistakes a creator user will actually make');
const CASES = [
  ['same account on both sides',   d => { d.jvSpec.entries[1].cr = 'crossCcy'; }, /same account/],
  ['unknown total in an amount',   d => { d.jvSpec.entries[1].amount = 'rapid_GBP'; }, /unknown name "rapid_GBP"/],
  ['undeclared account slot',      d => { d.jvSpec.entries[0].dr = 'nope'; }, /Dr account "nope" is not declared/],
  ['slot with no nominal',         d => { delete d.accounts.charges; }, /slot "charges" has no nominal/],
  ['unknown row type in a rule',   d => { d.jvSpec.classify.rules[1].kind = 'ghost'; }, /unknown row type "ghost"/],
  ['unknown operator in a rule',   d => { d.jvSpec.classify.rules[1].all[0].op = 'sounds_like'; }, /unknown operator "sounds_like"/],
  ['rule tests unknown column',    d => { d.jvSpec.classify.rules[1].all[0].col = 'nope'; }, /tests unknown column "nope"/],
  ['unknown narration',            d => { d.jvSpec.entries[0].remark = 'nope'; }, /unknown narration "nope"/],
  ['no currency on an entry',      d => { delete d.jvSpec.entries[0].cur; }, /no currency/],
  ['traversal ref',                d => { d.ref = '../apps/Reco'; }, /"ref" must be/],
  ['leading underscore ref',       d => { d.ref = '_engine'; }, /"ref" must be/],
  ['reserved device name',         d => { d.ref = 'CON'; }, /reserved Windows device name/],
  ['25-character ref',             d => { d.ref = 'A'.repeat(25); }, /"ref" must be/],
  ['empty ref',                    d => { d.ref = ''; }, /"ref" must be/],
  ['newer spec version',           d => { d.jvSpec.specVersion = 2; }, /spec version 2/],
  ['no entries at all',            d => { d.jvSpec.entries = []; }, /no entries/],
  ['no jvSpec block',              d => { delete d.jvSpec; }, /no "jvSpec" block/],
  ['two columns, one id',          d => { d.jvSpec.columns[1].id = 'date'; }, /share the id "date"/],
  ['bad column type',              d => { d.jvSpec.columns[0].type = 'money'; }, /must be text, number or date/],
  ['two columns claim a role',     d => { d.jvSpec.columns[1].role = 'amount'; }, /claim the role "amount"/],
  ['unknown total function',       d => { d.jvSpec.aggregates[0].fn = 'median'; }, /unknown function "median"/],
  ['total sums unknown column',    d => { d.jvSpec.aggregates[0].of = 'nope'; }, /sums unknown column "nope"/],
  ['total filters unknown type',   d => { d.jvSpec.aggregates[0].where[0].kind = 'ghost'; }, /unknown row type "ghost"/],
  ['field id clashes with a total',d => { d.jvSpec.fields[3].id = 'rapid_RUB'; }, /already used/],
  ['unknown check kind',           d => { d.jvSpec.validate[0].kind = 'vibes'; }, /unknown check "vibes"/],
  ['check names unknown field',    d => { d.jvSpec.validate[0].fields = ['nope']; }, /names unknown field "nope"/],
  ['preset writes unknown field',  d => { d.jvSpec.sections.presets.writes.from = 'nope'; }, /presets writes unknown field "nope"/],
  ['autoAssign on unknown column', d => { d.jvSpec.sections.autoAssign.column = 'nope'; }, /autoAssign reads unknown column "nope"/],
  ['reco field not declared',      d => { d.jvSpec.sections.recoFrom.field = 'nope'; }, /Reco field "nope" is not a declared field/],
  ['byColumn without the column',  d => { d.jvSpec.sections.mode = 'byColumn'; }, /one section per value of/],
  ['"@skip" used as a row type',   d => { d.jvSpec.kinds[0].id = '@skip'; }, /reserved/]
];
CASES.forEach(([name, mutate, re]) => {
  const d = clone(DEF);
  mutate(d);
  const r = C.validateSpec(d);
  t(r.errors.some(e => re.test(e)), 'refused: ' + name, r.errors.slice(0, 3));
});
const warn = clone(DEF);
warn.jvSpec.validate = warn.jvSpec.validate.filter(x => x.kind !== 'balancePerCurrency');
const vw = C.validateSpec(warn);
t(vw.errors.length === 0 && vw.warnings.some(w => /balance check/.test(w)),
  'a missing balance check is a warning, not a refusal (it does not make the maths wrong)', vw.warnings);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[H] all 22 FilterOps operators, plus date_between');
const OPSPEC = {
  columns: [
    { id: 'txt', label: 'Txt', type: 'text', normalize: ['trim', 'upper'] },
    { id: 'amt', label: 'Amt', type: 'number' },
    { id: 'dt',  label: 'Dt',  type: 'date' }
  ]
};
const OROW = { Txt: ' abc ', Amt: '(1,234.50)', Dt: '06/10/2026' };
const cond = (col, op, val, val2) => C.testCond(OPSPEC, OROW, { col, op, val, val2 });
const OPCASES = [
  ['equals',          () => cond('txt', 'equals', 'ABC') && !cond('txt', 'equals', 'abcd')],
  ['not_equals',      () => cond('txt', 'not_equals', 'x') && !cond('txt', 'not_equals', 'abc')],
  ['contains',        () => cond('txt', 'contains', 'b') && !cond('txt', 'contains', 'z')],
  ['not_contains',    () => cond('txt', 'not_contains', 'z')],
  ['starts_with',     () => cond('txt', 'starts_with', 'ab') && !cond('txt', 'starts_with', 'bc')],
  ['not_starts_with', () => cond('txt', 'not_starts_with', 'bc')],
  ['ends_with',       () => cond('txt', 'ends_with', 'bc') && !cond('txt', 'ends_with', 'ab')],
  ['not_ends_with',   () => cond('txt', 'not_ends_with', 'ab')],
  ['greater',         () => cond('amt', 'greater', '-2000') && !cond('amt', 'greater', '0')],
  ['greater_eq',      () => cond('amt', 'greater_eq', '-1234.50')],
  ['less',            () => cond('amt', 'less', '0')],
  ['less_eq',         () => cond('amt', 'less_eq', '-1234.5')],
  ['between',         () => cond('amt', 'between', '-2000', '0') && !cond('amt', 'between', '0', '10')],
  ['not_between',     () => cond('amt', 'not_between', '0', '10')],
  ['before',          () => cond('dt', 'before', '2026-10-07') && !cond('dt', 'before', '2026-10-01')],
  ['after',           () => cond('dt', 'after', '2026-10-01')],
  ['on_or_before',    () => cond('dt', 'on_or_before', '2026-10-06')],
  ['on_or_after',     () => cond('dt', 'on_or_after', '2026-10-06')],
  ['empty',           () => !cond('txt', 'empty') && C.testCond(OPSPEC, {}, { col: 'txt', op: 'empty' })],
  ['not_empty',       () => cond('txt', 'not_empty')],
  ['in_list',         () => cond('txt', 'in_list', 'x,ABC,y') && !cond('txt', 'in_list', 'x,y')],
  ['not_in_list',     () => cond('txt', 'not_in_list', 'x,y')],
  ['date_between',    () => cond('dt', 'date_between', '2026-10-01', '2026-10-10') && !cond('dt', 'date_between', '2026-10-11', '2026-10-20')]
];
OPCASES.forEach(([op, fn]) => t(fn() === true, 'operator ' + op, op));
t(OPCASES.length === 23, '22 FilterOps operators + date_between are covered', OPCASES.length);
t(C.OPS.length === 23 && C.OPS.indexOf('date_between') === 22, 'the engine declares exactly those operators', C.OPS.length);
t((() => { try { cond('txt', 'sounds_like', 'x'); return false; } catch (e) { return /unknown operator/.test(e.message); } })(),
  'an unknown operator throws rather than matching everything');
t(C.testCond(OPSPEC, OROW, { col: 'amt', op: 'in_list', val: '1,234.50, -50' }) === false
  && C.testCond(OPSPEC, { Amt: '1,234.50' }, { col: 'amt', op: 'in_list', val: '1,234.50, -50' }) === true,
  'on an amount column "1,234.50, -50" is two amounts, not four');
t(C.num('(1,234.50)') === -1234.5 && C.num('1,234.50-') === -1234.5 && C.num('1 234.5') === 1234.5 && C.num('abc') === 0,
  'the amount parser handles (x), the trailing minus and spaced thousands');
t(C.parseRowDate('31/02/2026') === null && C.fmtMMDDYY(C.parseRowDate('06/10/2026')) === '10/06/26'
  && C.fmtMMDDYY(C.parseRowDate('45936')) === '10/06/25' && C.fmtMMDDYY(C.parseRowDate('06-Oct-26')) === '10/06/26',
  'row dates: impossible dates refused, day-first, Excel serial as text, DD-MMM-YY');
t(C.fmtMMDDYY(C.parsePeriod('10/06/26')) === '10/06/26', 'a typed period is month-first, as the field declares');
/* The two date conventions, stated once: a value inside a CONDITION is parsed
   the way Reco's own filters parse one (day first), while a period FIELD is
   month-first because that is the format the field declares. Mixing them up
   would silently change which rows a rule matches. */
t(cond('dt', 'equals', '06/10/26') === true && cond('dt', 'equals', '10/06/26') === false,
  'a date in a condition is day-first, exactly as in a Reco report filter');
t(C.fmtMMDDYY(C.parsePeriod('06/10/26')) === '06/10/26', 'while the same text in a period field is month-first');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[I] the checks the page runs before it posts');
const chk = C.runChecks(DEF, SPEC, ROWS, CLS, ASG, [S1]);
t(chk.blocks.length === 0, 'nothing blocks the good case', chk.blocks);
t(chk.confirms.length === 2 && /Reco Code is empty for TCH1/.test(chk.confirms[0]) && /^1 RAPID\/OF row/.test(chk.confirms[1]),
  'two confirmations: the empty Reco Code and the one unassigned row', chk.confirms);
t(chk.built && chk.built.lines.length === 8, 'and the built lines come back with them');
const noPeriod = C.newSection(SPEC, 5);
const cNoPeriod = C.runChecks(DEF, SPEC, [], [], {}, [noPeriod]);
t(cNoPeriod.blocks.some(m => /TCH 1: Period From \/ To is missing or invalid/.test(m)),
  'a missing period blocks, naming the section', cNoPeriod.blocks);
const backwards = C.newSection(SPEC, 6);
Object.assign(backwards.fields, { periodFrom: '10/10/26', periodTo: '10/01/26' });
t(C.runChecks(DEF, SPEC, [], [], {}, [backwards]).blocks.some(m => /Period From is after Period To/.test(m)),
  'a reversed period blocks');
const empty = C.newSection(SPEC, 7);
Object.assign(empty.fields, { periodFrom: P[0].from, periodTo: P[0].to });
t(C.runChecks(DEF, SPEC, [], [], {}, [empty]).blocks.some(m => /No accounting lines to post/.test(m)),
  'a JV that computes to nothing blocks');
const unbal = clone(DEF);
unbal.jvSpec.entries = [{ id: 'x', label: 'One-sided', amount: 'rubEqUsd', dr: 'clearing', cr: 'crossCcy', cur: 'RUB', remark: 'ccAdj' }];
unbal.jvSpec.entryDefaults.swapOnNegative = true;
const unbalSec = C.newSection(unbal.jvSpec, 8);
Object.assign(unbalSec.fields, { periodFrom: P[0].from, periodTo: P[0].to, rubEqUsd: '100' });
const ub = C.runChecks(unbal, unbal.jvSpec, [], [], {}, [unbalSec]);
t(ub.blocks.length === 0, 'a Dr/Cr pair always balances, so the balance check passes by construction', ub.blocks);
const reqd = clone(DEF);
reqd.jvSpec.fields[3].required = true;                      // "RUB Eq for USD"
const rq = C.newSection(reqd.jvSpec, 1);
Object.assign(rq.fields, { periodFrom: P[0].from, periodTo: P[0].to });
t(C.runChecks(reqd, reqd.jvSpec, [], [], {}, [rq]).blocks.some(m => /TCH 1: "RUB Eq for USD" is required/.test(m)),
  'a field marked required is enforced even when no check names it',
  C.runChecks(reqd, reqd.jvSpec, [], [], {}, [rq]).blocks);
rq.fields.rubEqUsd = '1';
t(!C.runChecks(reqd, reqd.jvSpec, [], [], {}, [rq]).blocks.some(m => /is required/.test(m)),
  'and satisfied once it is filled in');

const brokenAmt = clone(DEF);
brokenAmt.jvSpec.entries[0].amount = 'of_RUB / 0';
const ba = C.runChecks(brokenAmt, brokenAmt.jvSpec, ROWS, CLS, ASG, [S1]);
t(ba.blocks.some(m => /division by zero/.test(m)) && !ba.built,
  'an amount that cannot be computed blocks the submit and builds nothing', ba.blocks);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[J] the spec hash: what makes a hand-edited page detectable');
const h1 = C.specHash(DEF);
t(/^fnv1a:[0-9a-f]{16}$/.test(h1), 'the hash is 16 hex digits', h1);
const reordered = JSON.parse(JSON.stringify({ accounts: DEF.accounts, jvSpec: DEF.jvSpec, inputColumns: DEF.inputColumns, displayName: DEF.displayName, ref: DEF.ref }));
t(C.specHash(reordered) === h1, 'key order does not change it (the canonical form sorts keys)');
const auditChanged = clone(DEF);
auditChanged.audit = { builtBy: 'someone else', rev: 99 };
t(C.specHash(auditChanged) === h1, 'who saved it and when does not change it — only the maths does');
const nominalChanged = clone(DEF);
nominalChanged.accounts.clearing.nominal = '99999';
t(C.specHash(nominalChanged) !== h1, 'an edited nominal DOES change it (that is the edit that must be caught)');
const amountChanged = clone(DEF);
amountChanged.jvSpec.entries[0].amount = 'rubEqUsd';
t(C.specHash(amountChanged) !== h1, 'an edited amount changes it');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[K] the engine files compile nothing and can live in a <script> island');
const FILES = ['jv-core-1.0.0.js', 'jv-page-1.0.0.js', 'jv-page-1.0.0.css'];
const TEXT = {};
FILES.forEach(f => { TEXT[f] = fs.readFileSync(path.join(ENGINE_DIR, f), 'utf8'); });
const FORBIDDEN = [
  [/\beval\s*\(/, 'eval('],
  [/new\s+Function/, 'the Function constructor'],
  [/\bFunction\s*\(/, 'Function('],
  [/setTimeout\s*\(\s*['"]/, 'setTimeout with a string'],
  [/setInterval\s*\(\s*['"]/, 'setInterval with a string'],
  [/\bimport\s*\(/, 'dynamic import'],
  [/document\.write/, 'document.write'],
  [/innerHTML\s*\+=/, 'innerHTML +=']
];
FILES.forEach(f => {
  FORBIDDEN.forEach(([re, name]) => t(!re.test(TEXT[f]), f + ' contains no ' + name));
  t(TEXT[f].indexOf('</script') === -1, f + ' contains no "</script" so it can be carried in a text island');
});
t(!/document\./.test(TEXT['jv-core-1.0.0.js']) && !/\bwindow\./.test(TEXT['jv-core-1.0.0.js'].replace(/typeof window/g, '')),
  'the compute core touches no DOM at all (it runs under node, in Reco and in the page)');
t(/document\./.test(TEXT['jv-page-1.0.0.js']), 'the page layer is the only half that touches the DOM');
/* These files exist twice — on the share and inside apps/Reco.html — and are
   compared byte for byte, so a character nobody can see must never get in. */
const INVISIBLE = [0xa0, 0x202f, 0x2028, 0x2029, 0xfeff, 0x200b, 0x200c, 0x200d, 0x00ad];
FILES.forEach(f => {
  const hits = [...TEXT[f]].filter(c => INVISIBLE.indexOf(c.charCodeAt(0)) >= 0).length;
  t(hits === 0, f + ' contains no invisible character (a no-break space, a BOM, a zero-width space)', hits);
});

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[L] the generated page carries no script of its own');
const PAGE = fs.readFileSync(path.join(REPO, 'special_jv_templates/EXAMPLE_TCH.html'), 'utf8');
t(PAGE.indexOf('<script>') === -1, 'no bare <script> block');
t(!/<script\b(?![^>]*\b(src=|type="application\/json"))/.test(PAGE), 'every script tag is either src= or inert JSON');
t(!/\son[a-z]+\s*=/i.test(PAGE), 'no on* attribute anywhere');
t((PAGE.match(/<script\b/g) || []).length === 3, 'exactly three script tags: the island and the two engine files',
  (PAGE.match(/<script[^>]*>/g) || []));
const isl = PAGE.match(/<script type="application\/json" id="jvDef">([\s\S]*?)<\/script>/);
t(!!isl, 'the island is present and closed');
const islandDef = JSON.parse(isl[1]);
t(islandDef.displayName.indexOf('&') >= 0 && islandDef.displayName.indexOf('&amp;') === -1,
  'the island is JSON-escaped, not HTML-escaped: "&" comes back as "&" (entities would corrupt it)', islandDef.displayName);
t(isl[1].indexOf('<') === -1 && isl[1].indexOf('>') === -1,
  'no raw < or > inside the island, so nothing in the data can close the element early');
const metaHash = (PAGE.match(/name="jv-spec-hash" content="([^"]+)"/) || [])[1];
t(metaHash === C.specHash(islandDef), 'the <meta> hash matches the island, so a hand edit is visible without parsing it',
  { metaHash, computed: C.specHash(islandDef) });
t((PAGE.match(/name="jv-ref" content="([^"]+)"/) || [])[1] === islandDef.ref, 'the <meta> ref matches the island');
t(/name="generator" content="Reco JV creator/.test(PAGE), 'the page says what wrote it');
t(C.validateSpec(islandDef).errors.length === 0, 'the island validates', C.validateSpec(islandDef).errors);
t(PAGE.indexOf('_engine/jv-core-1.0.0.js') > 0 && PAGE.indexOf('_engine/jv-page-1.0.0.js') > PAGE.indexOf('_engine/jv-core-1.0.0.js'),
  'the core is loaded before the page layer (classic scripts, so the order is the file order)');
const islandClasses = JSON.parse(JSON.stringify(ROWS)).map(r => C.classify(islandDef.jvSpec, r));
const islandLines = C.buildAll(islandDef, islandDef.jvSpec, ROWS, islandClasses, ASG, [S1]).lines;
t(JSON.stringify(islandLines) === JSON.stringify(L), 'and it computes TCH\'s eight lines, byte for byte');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[M] apps/Reco.html carries the engine text, byte for byte');
const RECO = fs.readFileSync(path.join(REPO, 'apps/Reco.html'), 'utf8');
const ISLANDS = [['jvCoreSrc', 'jv-core-1.0.0.js'], ['jvPageSrc', 'jv-page-1.0.0.js'], ['jvPageCss', 'jv-page-1.0.0.css']];
ISLANDS.forEach(([id, file]) => {
  const re = new RegExp('<script type="text/plain" id="' + id + '">([\\s\\S]*?)</script>');
  const m = RECO.match(re);
  t(!!m, 'Reco.html has the ' + id + ' island');
  if (!m) return;
  const got = m[1], want = TEXT[file];
  if (got !== want) {
    const at = (() => { for (let i = 0; i < Math.max(got.length, want.length); i++) if (got[i] !== want[i]) return i; return -1; })();
    console.log('       first difference at ' + at + ':\n         island: ' + JSON.stringify(got.slice(Math.max(0, at - 40), at + 40))
      + '\n         file:   ' + JSON.stringify(want.slice(Math.max(0, at - 40), at + 40)));
  }
  t(got === want, id + ' is byte-identical to special_jv_templates/_engine/' + file,
    got === want ? '' : { islandBytes: got.length, fileBytes: want.length });
  t(got.indexOf('</script') === -1, id + ' contains no "</script"');
});
t(/const JV_ENGINE_VERSION = '1\.0\.0'/.test(RECO), 'Reco declares JV_ENGINE_VERSION');
t(/const JVCore = /.test(RECO), 'Reco builds JVCore from the island text, so the preview and the page cannot drift');
/* The island-to-filename map is what the creator will write to the share, so
   every name in it has to be a file that actually exists here. */
const named = (RECO.match(/\{ island: '\w+', name: /g) || []);
t(named.length === 3, 'JV_ENGINE_FILES names three files and no more', named.length);
ISLANDS.forEach(([id, file]) => {
  const ext = file.slice(file.lastIndexOf('.'));
  const stem = file.slice(0, file.indexOf('-1.0.0'));
  t(RECO.indexOf("{ island: '" + id + "', name: '" + stem + "-' + JV_ENGINE_VERSION + '" + ext + "' }") > 0,
    'JV_ENGINE_FILES maps ' + id + ' to ' + file);
});

console.log('\n' + ok + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
