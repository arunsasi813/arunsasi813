// End-to-end tests for the Special JV generator and its publish path
// (MODULE 9b of apps/Reco.html: JvGen + JvCreator) against the real Python
// LauncherAPI (tests/e2e/bridge_server.py stands in for pywebview).
//
//   node tests/e2e/run_jv_gen_e2e.mjs
//
// The headline test creates TCH2 by copying TCH *through the creator's own UI*
// — the Special JVs tab, the Duplicate dialog, the Publish button — and then
// opens the result through the real SpecialJV.open and asserts the eight lines
// tests/e2e/run_jv_engine_e2e.mjs asserts for the hand-written TCH page. The
// rest of the run is one test per safety rule of the specification's §8.3,
// §8.4 and §8.4b, cited by number (R-xx) so a failure names the rule it broke.
//
// The share starts with NO special_jv_templates/_engine/ folder, because that
// is the real case: folder_manager.init_skeleton creates the folders and
// copies no app files. Seeding it is part of publishing.
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

const PORT = 19120, JVPORT = 19121;
const ADMIN_PWD = 'sharePass1';
let failures = 0, passes = 0;
function check(cond, msg, extra) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── the test share ───────────────────────────────────────────────────────── */
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-gen-e2e-'));
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
fs.writeFileSync(abs('master/accounts_master.csv'),
  'Reference,RC,Nominal,SubNominal,AnalysisKey,LOB\r\nACC1,100,12345,0,0,51\r\nBANK,200,11111,0,0,51\r\n');
/* The admin password of this share. It is a plain file inside the jail — a
   guard against accidents, not an authorisation boundary — and it is no longer
   readable through the file bridge, which [R-26] asserts below. */
fs.writeFileSync(abs('pwd.txt'), ADMIN_PWD + '\n');
/* A file at a page path with no mapping beside it: the stray-file case (R-12). */
fs.writeFileSync(abs('special_jv_templates/ORPHAN.html'), '<!DOCTYPE html><html><body>left over</body></html>\n');

const TCH_HTML_BEFORE = read('special_jv_templates/TCH.html');
const TCH_JSON_BEFORE = read('special_jv_mapping/TCH.json');
const ENGINE_FILES = ['jv-core-1.0.0.js', 'jv-page-1.0.0.js', 'jv-page-1.0.0.css'];

/* The creator module, as the repo ships it: some rules are about the source. */
const RECO_SRC = fs.readFileSync(path.join(REPO, 'apps/Reco.html'), 'utf8');
const MOD_START = RECO_SRC.indexOf('   MODULE 9b — JV CREATOR');
const MOD_END = RECO_SRC.indexOf('   BOOT\n', MOD_START);
const MODULE_9B = RECO_SRC.slice(MOD_START, MOD_END);

const procs = [];
const killAll = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });
process.on('exit', killAll);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { killAll(); process.exit(130); }));
const watchdog = setTimeout(() => {
  console.error('\nWATCHDOG: run exceeded 5 minutes; last check: ' + (passes + failures));
  killAll();
  process.exit(2);
}, 300000);

const proc = spawn('python3', [path.join(HERE, 'bridge_server.py'), root, String(PORT), '--jv-port', String(JVPORT)],
  { stdio: ['ignore', 'pipe', 'inherit'] });
procs.push(proc);
await new Promise((res, rej) => {
  proc.stdout.on('data', d => { if (String(d).includes('READY')) res(); });
  proc.on('exit', c => rej(new Error('bridge exited ' + c)));
});

const resetLog = () => fetch(`http://127.0.0.1:${PORT}/__reset_log`, { method: 'POST' });
const callLog = async () => (await (await fetch(`http://127.0.0.1:${PORT}/__log`)).json()).calls;

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
  { Doc: 'D1', Date: '06/10/2026', 'Txn Type': 'RAPID', Currency: 'USD', 'FC Amount': '100',   AED: '367',  ToAccount: 'TCH2', Status: '' },
  { Doc: 'D2', Date: '07/10/2026', 'Txn Type': 'RAPID', Currency: 'EUR', 'FC Amount': '50',    AED: '200',  ToAccount: 'TCH2', Status: '' },
  { Doc: 'D3', Date: '12/10/2026', 'Txn Type': 'OF01',  Currency: 'RUB', 'FC Amount': '-9000', AED: '-400', ToAccount: 'TCH2', Status: '' },
  { Doc: 'D4', Date: '08/10/2026', 'Txn Type': 'RAPID', Currency: 'RUB', 'FC Amount': '5000',  AED: '220',  ToAccount: 'TCH2', Status: '' }
];
const FIELDS = Object.keys(ROWS[0]);

/* publish() from the page, with a short lock settle so the suite is not
   dominated by it. One publish below uses the real one-second default. */
const publish = (def, opts) => page.evaluate(([def, opts]) =>
  JvCreator.publish(def, Object.assign({ lockWait: 30 }, opts || {})), [def, opts || {}]);
const inspect = ref => page.evaluate(ref => JvCreator.inspect(ref), ref);

try {
  await page.goto(`http://127.0.0.1:${PORT}/apps/Reco.html`);
  await page.waitForSelector('#appMain .panel', { timeout: 20000 });

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[1] the two texts: escaping, and a page that cannot carry a program');
  const esc = await page.evaluate(() => {
    const hostile = 'Charges </script><img src=x onerror=window.__pwned=1> for <A & B>';
    const def = JSON.parse(JSON.stringify(SpecialJV.get('TCH')));
    def.ref = 'ESCTEST';
    def.displayName = '</title><script>window.__pwned=1</script> & more';
    def.jvSpec.remarks.templates.ccAdj = hostile;
    delete def.audit;
    def.audit = { specHash: JVCore.specHash(def) };
    const island = JvGen.island(def);
    const html = JvGen.page(def);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const islandBack = JSON.parse(doc.getElementById('jvDef').textContent);
    return {
      hostile,
      rawLt: island.indexOf('<') >= 0,
      entity: island.indexOf('&amp;') >= 0,
      roundTrip: islandBack.jvSpec.remarks.templates.ccAdj === hostile,
      ampRoundTrip: islandBack.displayName === def.displayName,
      scripts: Array.from(doc.querySelectorAll('script')).map(s => s.getAttribute('src') || s.getAttribute('type')),
      titleText: doc.title,
      titleEscaped: html.indexOf('<title>&lt;/title&gt;&lt;script&gt;') === 0 || /<title>&lt;\/title&gt;/.test(html),
      imgs: doc.querySelectorAll('img').length,
      pwned: !!window.__pwned,
      problems: JvGen.pageProblems(html),
      metaRef: doc.querySelector('meta[name="jv-ref"]').getAttribute('content'),
      metaHash: doc.querySelector('meta[name="jv-spec-hash"]').getAttribute('content'),
      hash: JVCore.specHash(def),
      negatives: {
        inline: JvGen.pageProblems('<html><script>alert(1)</script></html>').join(' | '),
        handler: JvGen.pageProblems('<html><body onload="x()"></body></html>').join(' | '),
        url: JvGen.pageProblems('<html><a href="javascript:x()">x</a></html>').join(' | '),
        srcBody: JvGen.pageProblems('<html><script src="x.js">alert(1)</script></html>').join(' | ')
      }
    };
  });
  check(!esc.rawLt && !esc.entity && esc.roundTrip && esc.ampRoundTrip,
        'R-01/R-02 the island is JSON-escaped, never entity-escaped: "</script>", "&" and markup round-trip byte for byte', esc);
  check(esc.scripts.join('|') === 'application/json|_engine/jv-core-1.0.0.js|_engine/jv-page-1.0.0.js',
        'R-04 the generated page carries exactly three script tags: one inert JSON block and the two engine files', esc.scripts);
  check(esc.problems.length === 0
        && /inline script/.test(esc.negatives.inline) && /bare script block/.test(esc.negatives.inline)
        && /inline event handler/.test(esc.negatives.handler)
        && /javascript: URL/.test(esc.negatives.url)
        && /both a src and a body/.test(esc.negatives.srcBody),
        'R-04 pageProblems() passes the generated page and catches an inline script, an on* handler, a javascript: URL and a src tag with a body',
        { problems: esc.problems, negatives: esc.negatives });
  check(esc.imgs === 0 && !esc.pwned && esc.scripts.length === 3 && esc.titleEscaped
        && esc.titleText === '</title><script>window.__pwned=1</script> & more',
        'R-03 a displayName of "</title><script>…" is escaped into the title as text: 3 script elements, 0 images, nothing injected',
        { title: esc.titleText, escaped: esc.titleEscaped, scripts: esc.scripts.length, imgs: esc.imgs });
  check(esc.metaRef === 'ESCTEST' && esc.metaHash === esc.hash,
        'the page declares its own ref and the hash of the spec it carries', esc);

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[2] paths and names are checked before anything is built');
  const refs = await page.evaluate(() => {
    const bad = {};
    ['../apps/Reco', '_engine', 'CON', 'com1', 'tch/../x', 'A'.repeat(25), '', ' TCH ', 'TCH.json', 'TCH 2', '2TCH', 'tch\\x']
      .forEach(r => { bad[r] = JvCreator.refProblem(r); });
    let threw = '';
    try { JvCreator._paths('../apps/Reco'); } catch (e) { threw = e.message; }
    return { bad, threw, ok: JvCreator.refProblem('TCH2'), paths: JvCreator._paths('TCH2'),
             archive: JvCreator._archiveDir('TCH2', '20261014-101112', 'DOMAIN\\user name') };
  });
  check(Object.keys(refs.bad).every(k => !!refs.bad[k]) && refs.ok === null,
        'R-10 a traversal, a leading underscore, a device name, 25 characters, an empty code, spaces, a dot and a backslash are each refused with a reason',
        refs.bad);
  check(/not a safe file name/.test(refs.bad['../apps/Reco']) && /reserved for the engine folder/.test(refs.bad._engine)
        && /reserved Windows device name/.test(refs.bad.CON),
        'R-10 and each refusal says which rule it broke', { t: refs.bad['../apps/Reco'], e: refs.bad._engine, c: refs.bad.CON });
  check(!!refs.threw, 'R-14 _paths() throws for a ref that would not pass, so a bad ref can never become a path', refs.threw);
  check(refs.paths.mapping === 'special_jv_mapping/TCH2.json'
        && refs.paths.page === 'special_jv_templates/TCH2.html'
        && refs.paths.draft === 'special_jv_drafts/TCH2.json'
        && refs.paths.lock === 'special_jv_mapping/.lock_TCH2.json',
        'R-14 every creator path is relative, under one of the four JV folders, and built only from the validated ref', refs.paths);
  check(refs.archive === 'special_jv_archive/TCH2/20261014-101112_DOMAIN_user_name',
        'R-14 a user name is reduced to one safe segment before it becomes an archive folder', refs.archive);
  const bridgeCalls = Array.from(new Set(Array.from(MODULE_9B.matchAll(/api\.([a-z_0-9]+)\s*\(/g)).map(m => m[1]))).sort();
  check(!/write_file_abs\s*\(/.test(MODULE_9B) && MODULE_9B.indexOf('U.download') > 0,
        'R-13 the creator never calls write_file_abs — the one export path is U.download, which opens the Save-as dialog first');
  check(bridgeCalls.join() === 'path_exists,path_exists_json,read_file,verify_admin_password,write_file',
        'R-14/R-13 and the only bridge calls in the module are the four jailed file calls plus the password check', bridgeCalls);
  const pwdRead = await page.evaluate(async () => {
    try { return { ok: true, text: await window.pywebview.api.read_file('pwd.txt') }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  check(pwdRead.ok === false && /not readable|writable/i.test(pwdRead.error),
        'R-26 pwd.txt is no longer readable through the file bridge, so verify_admin_password is the only way to check it', pwdRead);

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[3] the share as it really starts: no engine folder, TCH hand-written');
  check(!exists('special_jv_templates/_engine'), 'the share has never held the engine (init_skeleton copies no app files)');
  const tchEv = await inspect('TCH');
  check(tchEv.kind === 'handWritten' && tchEv.readOnly === true && tchEv.publishable === false,
        'R-15 TCH is classified hand-written from the evidence in the file, not from a flag', { kind: tchEv.kind, why: tchEv.why });
  const tchPub = await publish(await page.evaluate(() => {
    const d = JSON.parse(JSON.stringify(SpecialJV.get('TCH'))); delete d.htmlPath; delete d._file; return d;
  }));
  check(!tchPub.ok && /written by hand/.test(tchPub.errors.join(' ')) && tchPub.written.length === 0,
        'R-15 publishing TCH is refused outright — there is no code path that writes a page without the generator tag', tchPub.errors);
  check(read('special_jv_templates/TCH.html') === TCH_HTML_BEFORE && read('special_jv_mapping/TCH.json') === TCH_JSON_BEFORE,
        'R-15 and neither of TCH\'s files was touched');

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[4] TCH2, created by copying TCH through the creator\'s own UI');
  await page.evaluate(() => { App.navigate('aeg'); AEG.switchTab('specialjv'); });
  await page.waitForSelector('#aegContent .card-grid', { timeout: 10000 });
  await page.waitForFunction(() => /Hand-written/.test(document.getElementById('jvBadges_TCH').textContent), null, { timeout: 10000 });
  const tabText = await page.textContent('#aegContent');
  check(/Special JVs/.test(await page.textContent('#appMain .tabs')) && /Ref TCH/.test(tabText),
        'the Entry Generator has a Special JVs tab listing every registered JV');
  check(/Hand-written/.test(await page.textContent('#jvBadges_TCH')),
        'TCH is badged Hand-written in the listing, from reading the file on the share');
  await page.click('#aegContent .card:has-text("Ref TCH") button:has-text("Duplicate")');
  await page.waitForSelector('#jvDupRef', { timeout: 10000 });
  await page.fill('#jvDupRef', 'tch2');
  const pathHint = await page.textContent('#jvDupPaths');
  check(/special_jv_mapping\/TCH2\.json/.test(pathHint) && /special_jv_templates\/TCH2\.html/.test(pathHint),
        'the dialog upper-cases the code as it is typed and says which two files it will create', pathHint.trim());
  await page.fill('#jvDupName', 'TCH2 — copy of the TCH calculator');
  await resetLog();
  await page.click('#jvDupGo');                                    // the real 1 s lock settle
  await page.waitForFunction(() => !document.getElementById('appModal').classList.contains('show'), null, { timeout: 25000 });
  const log = (await callLog()).filter(c => c.method === 'write_file').map(c => c.arg0);
  check(exists('special_jv_mapping/TCH2.json') && exists('special_jv_templates/TCH2.html'),
        'both files are on the share', log);
  check(ENGINE_FILES.every(f => exists('special_jv_templates/_engine/' + f)),
        'the three engine files were seeded onto a share that had never held them', ENGINE_FILES.map(f => exists('special_jv_templates/_engine/' + f)));
  check(ENGINE_FILES.every(f => read('special_jv_templates/_engine/' + f)
        === fs.readFileSync(path.join(REPO, 'special_jv_templates/_engine/' + f), 'utf8')),
        'and each seeded file is byte-identical to the one in the app, because Reco writes the same text it runs');
  const pageIdx = log.indexOf('special_jv_templates/TCH2.html');
  const mapIdx = log.indexOf('special_jv_mapping/TCH2.json');
  check(pageIdx >= 0 && mapIdx > pageIdx,
        'R-20 the page is written before the mapping, so a half-written JV is never registered', log);
  check(log.filter(p => /^special_jv_archive/.test(p)).length === 0,
        'R-19 nothing is archived for a code that did not exist', log);
  const reg = await page.evaluate(() => ({
    refs: Object.keys(SpecialJV.registry).sort(),
    opts: SpecialJV.buildToAccountOptions().filter(o => o.kind === 'jv').map(o => o.value).sort(),
    problems: Store.loadProblems.slice()
  }));
  check(reg.refs.join() === 'TCH,TCH2' && reg.opts.join() === 'TCH,TCH2' && reg.problems.length === 0,
        'TCH2 is registered and in the To Account dropdown, with no load problem', reg);
  const def2 = JSON.parse(read('special_jv_mapping/TCH2.json'));
  const html2 = read('special_jv_templates/TCH2.html');
  /* Who Reco thinks is using it: master/user.csv's Name, not the OS id. */
  const WHO = await page.evaluate(() => AppState.currentUser);
  check(def2.audit.rev === 1 && def2.audit.builtBy === 'creator' && def2.audit.copiedFrom === 'TCH'
        && !!WHO && def2.audit.createdBy === WHO && def2.audit.updatedBy === WHO
        && def2.audit.engine === '1.0.0' && def2.audit.specHash === JVCore.specHash(def2),
        'the mapping records who made it, from what, with which engine, and the hash of its own spec', def2.audit);
  const tchSpec = JSON.parse(TCH_JSON_BEFORE).jvSpec;
  delete tchSpec._comment;
  check(JVCore.canonical(def2.jvSpec) === JVCore.canonical(tchSpec),
        'the copy carries TCH\'s spec unchanged apart from the comment',
        { mine: JVCore.canonical(def2.jvSpec).length, tch: JVCore.canonical(tchSpec).length });
  check(JSON.stringify(def2.accounts) === JSON.stringify(JSON.parse(TCH_JSON_BEFORE).accounts),
        'and TCH\'s accounts block verbatim — the account codes live in exactly one place');
  check(html2.indexOf('<script>') === -1 && (html2.match(/<script/g) || []).length === 3,
        'the page on the share carries no inline script', (html2.match(/<script[^>]*>/g) || []));
  check(JVCore.specHash(JSON.parse(html2.match(/<script type="application\/json" id="jvDef">([\s\S]*?)<\/script>/)[1]))
        === def2.audit.specHash,
        'R-21 the JSON block in the page on the share is the spec that was published');

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[5] TCH2 through the real SpecialJV.open: the same eight lines as TCH');
  const tpl = await page.evaluate(([rows, fields]) => {
    RecoTemplate.create();
    const t = RecoTemplate._editing;
    t.name = 'JV Gen';
    t.columns = fields.map(n => ({ name: n, label: n, formats: [], isValue: n === 'AED', isDate: n === 'Date' }));
    t.primaryKeys = ['Doc'];
    t.valueColumn = 'AED';
    t.editableColumns = ['ToAccount', 'Status'];
    t.displayColumns = t.columns.map(c => c.name);
    t.aegIntegration = { enabled: true, aegTemplateId: AppState.aegTemplates[0].id, keywordColumn: '',
                         keywordValues: '', postEntryColumn: 'Status', postEntryValue: 'Posted' };
    RecoTemplate.saveTemplate();
    const tpl = AppState.recoTemplates.find(x => x.name === 'JV Gen');
    RecoTemplate.open(tpl.id);
    Reco.ingestData(tpl, rows, fields);
    return tpl.id;
  }, [ROWS, FIELDS]);

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
    return { jv, totals, focus, pend };
  }

  const run = await runTch('TCH2');
  check(run.totals === '5,000.00|100.00|50.00|0.00' && run.focus === '7000',
        'the generated calculator behaves like TCH: presets, auto-assign, and typing keeps focus', { totals: run.totals, focus: run.focus });
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
  check(L.every(l => l.SubNominal === '0' && l['Analysis Key'] === '0' && l.LOB === '51' && l.Reference === '' && l.Doc === ''),
        'the shared account fields are on every line');
  check(L.every(l => l.Reco === 'TCH1'), 'Reco defaults to TCH1 when the code is left empty', L[0].Reco);
  check(L.every(l => Object.keys(l).join('|') === JVCore.LINE_ORDER.join('|')),
        'every line carries the 12 AEG keys in the output order', Object.keys(L[0]));
  check(run.pend.primaryKeys.slice().sort().join() === 'D1,D2,D4', 'it consumed D1, D2, D4 only', run.pend.primaryKeys);
  check(run.pend.meta.engine === '1.0.0' && run.pend.meta.specHash === def2.audit.specHash,
        'and recorded which engine and which version of the maths produced the figures',
        { engine: run.pend.meta.engine, hash: run.pend.meta.specHash, want: def2.audit.specHash });
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
  check(ent.hist === 1 && ent.lines === 8 && ent.ref === 'TCH2' && ent.postedPks.join() === 'D1,D2,D4'
        && ent.status.D1 === 'Posted' && ent.status.D3 !== 'Posted',
        'the lines commit as an entry like any other, closing only the rows the JV used', ent);
  await page.evaluate(() => App.closeModal());

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[6] a code that is already taken, in any of the ways it can be');
  const mkDef = (ref, name) => page.evaluate(([ref, name]) => JvCreator.duplicateDef('TCH', ref, name || ref), [ref, name]);
  const caseClash = await publish(await mkDef('tch2'));
  check(!caseClash.ok && /differs only by capitals/.test(caseClash.errors.join(' ')),
        'R-11 a code that differs from an existing one only by case is refused: on a Windows share they are one file', caseClash.errors);
  check(!exists('special_jv_mapping/tch2.json') || read('special_jv_mapping/tch2.json') === read('special_jv_mapping/TCH2.json'),
        'R-11 and nothing was written under the other spelling');
  const stray = await publish(await mkDef('ORPHAN'));
  check(!stray.ok && /a file already exists/.test(stray.errors.join(' ')) && stray.written.length === 0,
        'R-12 a stray page with no mapping blocks the code, with no registry entry to warn from', stray.errors);
  check(read('special_jv_templates/ORPHAN.html') === '<!DOCTYPE html><html><body>left over</body></html>\n',
        'R-12 and the stray file is left exactly as it was');
  const traversal = await page.evaluate(async () => {
    const d = await JvCreator.duplicateDef('TCH', 'TCH3', 'x');
    d.ref = '../apps/Reco';
    return JvCreator.publish(d, { lockWait: 30 });
  });
  check(!traversal.ok && /not a safe file name/.test(traversal.errors.join(' ')) && traversal.written.length === 0,
        'R-10 a traversal ref is refused by publish itself, before any path is built', traversal.errors);
  check(!fs.existsSync(path.join(root, 'apps/Reco.json')) && !fs.existsSync(path.join(base, 'Reco.html')),
        'R-10 and nothing was written beside the app or outside the share');

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[7] someone else changed the file while this copy was being edited');
  const before = { json: read('special_jv_mapping/TCH2.json'), html: read('special_jv_templates/TCH2.html') };
  const noBase = await publish(await page.evaluate(() => {
    const d = JSON.parse(JSON.stringify(SpecialJV.get('TCH2'))); delete d.htmlPath; delete d._file; return d;
  }));
  check(!noBase.ok && noBase.needs === 'conflict' && noBase.written.length === 0,
        'R-17 a save that cannot say which revision it started from is refused rather than guessed at', noBase.errors);
  const conflict = await page.evaluate(async () => {
    const live = JSON.parse(JSON.stringify(SpecialJV.get('TCH2')));
    delete live.htmlPath; delete live._file;
    const started = { rev: live.audit.rev, at: live.audit.updatedAt };
    /* A colleague saves while this copy is being edited. */
    const theirs = JSON.parse(JSON.stringify(live));
    theirs.audit = Object.assign({}, theirs.audit, { rev: 7, updatedBy: 'R. Menon', updatedAt: '2026-10-14T14:22:00Z' });
    await window.pywebview.api.write_file('special_jv_mapping/TCH2.json', JSON.stringify(theirs, null, 2) + '\n');
    live.displayName = 'mine';
    const res = await JvCreator.publish(live, { baseRev: started.rev, baseUpdatedAt: started.at, lockWait: 30 });
    return { res, started };
  });
  check(!conflict.res.ok && conflict.res.needs === 'conflict' && /R\. Menon changed "TCH2" at 2026-10-14/.test(conflict.res.errors.join(' ')),
        'R-17 a revision that moved on the share stops the save and names who moved it', conflict.res.errors);
  check(conflict.res.written.length === 0 && read('special_jv_templates/TCH2.html') === before.html
        && JSON.parse(read('special_jv_mapping/TCH2.json')).audit.rev === 7,
        'R-17 and NOTHING was written: not the page, not the mapping, not an archive folder',
        { written: conflict.res.written, rev: JSON.parse(read('special_jv_mapping/TCH2.json')).audit.rev });
  const archiveDirs = () => (fs.existsSync(abs('special_jv_archive/TCH2'))
    ? fs.readdirSync(abs('special_jv_archive/TCH2')) : []);
  check(archiveDirs().length === 0, 'R-19 a refused publish leaves no archive folder behind', archiveDirs());

  /* R-24 — TCH2 has one posted entry on this PC after section [5]. */
  const inUse = await publish(await page.evaluate(() => {
    const d = JSON.parse(JSON.stringify(SpecialJV.get('TCH2'))); delete d.htmlPath; delete d._file;
    d.displayName = 'TCH2 — without typing the code'; return d;
  }), { baseRev: 7, baseUpdatedAt: JSON.parse(fs.readFileSync(path.join(root, 'special_jv_mapping/TCH2.json'), 'utf8')).audit.updatedAt });
  check(!inUse.ok && inUse.needs === 'typedRef' && /1 posted entry/.test(inUse.errors.join(' '))
        && inUse.written.length === 0,
        'R-24 updating a JV that has already posted entries needs the short code typed back — no password, but not one click either',
        { needs: inUse.needs, errors: inUse.errors, inUse: inUse.inUse });

  const wrongPwd = await publish(await page.evaluate(() => {
    const d = JSON.parse(JSON.stringify(SpecialJV.get('TCH2'))); delete d.htmlPath; delete d._file;
    d.displayName = 'forced with the wrong password'; return d;
  }), { force: true, confirmedRef: 'TCH2', adminPassword: 'not-the-password' });
  check(!wrongPwd.ok && wrongPwd.needs === 'admin' && wrongPwd.written.length === 0
        && JSON.parse(read('special_jv_mapping/TCH2.json')).audit.rev === 7,
        'R-25 a forced overwrite with the wrong admin password leaves both files untouched', wrongPwd.errors);
  const forced = await publish(await page.evaluate(() => {
    const d = JSON.parse(JSON.stringify(SpecialJV.get('TCH2'))); delete d.htmlPath; delete d._file;
    d.displayName = 'TCH2 — forced'; return d;
  }), { force: true, confirmedRef: 'TCH2', adminPassword: ADMIN_PWD });
  check(forced.ok && JSON.parse(read('special_jv_mapping/TCH2.json')).audit.rev === 8,
        'R-25 with the right password the overwrite goes through, and the revision moves on from theirs',
        { ok: forced.ok, errors: forced.errors, rev: JSON.parse(read('special_jv_mapping/TCH2.json')).audit.rev });
  check(archiveDirs().length === 1 && fs.readdirSync(abs('special_jv_archive/TCH2/' + archiveDirs()[0])).sort().join() === 'TCH2.html,TCH2.json',
        'R-19 the version it replaced was archived first, page and mapping together', archiveDirs());
  const arch = abs('special_jv_archive/TCH2/' + archiveDirs()[0]);
  check(fs.readFileSync(path.join(arch, 'TCH2.html'), 'utf8') === before.html
        && JSON.parse(fs.readFileSync(path.join(arch, 'TCH2.json'), 'utf8')).audit.rev === 7,
        'R-19 and the archived bytes are the ones that were on the share, which is the only rollback the bridge allows');
  check(/^\d{8}-\d{6}_/.test(archiveDirs()[0]) && archiveDirs()[0].endsWith(WHO.replace(/[^A-Za-z0-9_-]+/g, '_')),
        'R-19 the archive folder is stamped with the time and the user', { dir: archiveDirs()[0], who: WHO });
  check(forced.engine.wrote.length === 0 && forced.engine.present.length === 3,
        'the engine files are left alone once they are on the share — the version is in the filename, so a write could only ever add',
        forced.engine);

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[8] a write that does not read back, and a write that fails');
  const beforeRestore = { json: read('special_jv_mapping/TCH2.json'), html: read('special_jv_templates/TCH2.html') };
  const tamper = await page.evaluate(async () => {
    const api = window.pywebview.api;
    api.__read = api.__read || api.read_file;
    api.__write = api.__write || api.write_file;
    let armed = false;
    api.write_file = function (rel, data) {
      if (rel === 'special_jv_templates/TCH2.html') armed = true;
      return api.__write(rel, data);
    };
    /* Only the verification read is tampered with: a share that acknowledges a
       write and then serves something else. */
    api.read_file = async function (rel) {
      const txt = await api.__read(rel);
      if (rel === 'special_jv_templates/TCH2.html' && armed) return String(txt).replace('</body>', '<!-- tampered --></body>');
      return txt;
    };
    const live = JSON.parse(JSON.stringify(SpecialJV.get('TCH2')));
    delete live.htmlPath; delete live._file;
    const base = { rev: live.audit.rev, at: live.audit.updatedAt };
    live.displayName = 'TCH2 — should never land';
    const res = await JvCreator.publish(live, { baseRev: base.rev, baseUpdatedAt: base.at,
      confirmedRef: 'TCH2', lockWait: 30 });
    api.read_file = api.__read;
    api.write_file = api.__write;
    return res;
  });
  check(!tamper.ok && /did not read back as it was written/.test(tamper.errors.join(' ')),
        'R-21 the page is read back and compared, so a share that acknowledges a write it did not make is caught', tamper.errors);
  check(read('special_jv_templates/TCH2.html') === beforeRestore.html,
        'R-21 and the previous page was put back, byte for byte');
  check(read('special_jv_mapping/TCH2.json') === beforeRestore.json,
        'R-21 the mapping was never written, so the registered JV is still the one that works');
  check(/was put back/.test(tamper.errors.join(' ')), 'R-21 and the failure says what it restored', tamper.errors);

  const mapFail = await page.evaluate(async () => {
    const api = window.pywebview.api;
    api.__write2 = api.__write2 || api.write_file;
    api.write_file = function (rel, data) {
      if (rel === 'special_jv_mapping/NEWJV1.json') return Promise.reject(new Error('injected: the share went read-only'));
      return api.__write2(rel, data);
    };
    const d = JvCreator.duplicateDef('TCH', 'NEWJV1', 'Never registered');
    const res = await JvCreator.publish(d, { newOnly: true, lockWait: 30 });
    api.write_file = api.__write2;
    await SpecialJV.load();
    return { res, refs: Object.keys(SpecialJV.registry).sort(), opts: SpecialJV.buildToAccountOptions().map(o => o.value) };
  });
  check(!mapFail.res.ok && /is not registered/.test(mapFail.res.errors.join(' ')),
        'R-20 when the mapping write fails the JV is reported as not registered', mapFail.res.errors);
  check(mapFail.refs.indexOf('NEWJV1') === -1 && mapFail.opts.indexOf('NEWJV1') === -1,
        'R-20 and it is absent from the registry and the To Account dropdown — the mapping IS the registration', mapFail.refs);
  check(!exists('special_jv_mapping/NEWJV1.json') && exists('special_jv_templates/NEWJV1.html'),
        'the page is on the share with no mapping, which is the invisible half, not the dangerous half');
  const placeholder = read('special_jv_templates/NEWJV1.html');
  check(/jv-abandoned/.test(placeholder) && /was not published/.test(placeholder)
        && (placeholder.match(/<script/g) || []).length === 0,
        'and since the bridge cannot delete, it was replaced with a placeholder that explains itself and runs nothing');
  /* The hardest restore: a brand-new code whose MAPPING is the file that will
     not read back. There is no previous version to put back and nothing can be
     deleted, so both halves have to end up in a state that registers nothing. */
  const mapTamper = await page.evaluate(async () => {
    const api = window.pywebview.api;
    api.__read3 = api.__read3 || api.read_file;
    api.__write3 = api.__write3 || api.write_file;
    let armed = false;
    api.write_file = function (rel, data) {
      if (rel === 'special_jv_mapping/NEWJV2.json') armed = true;
      return api.__write3(rel, data);
    };
    api.read_file = async function (rel) {
      const txt = await api.__read3(rel);
      if (rel === 'special_jv_mapping/NEWJV2.json' && armed) return '{ "ref": "NEWJV2", "truncated"';
      return txt;
    };
    const before = Store.loadProblems.length;
    const res = await JvCreator.publish(JvCreator.duplicateDef('TCH', 'NEWJV2', 'Never verified'),
      { newOnly: true, lockWait: 30 });
    api.read_file = api.__read3;
    api.write_file = api.__write3;
    await SpecialJV.load();
    return { res, registered: !!SpecialJV.get('NEWJV2'), problems: Store.loadProblems.slice(before) };
  });
  check(!mapTamper.res.ok && /did not read back/.test(mapTamper.res.errors.join(' ')),
        'R-21 the mapping is read back too, and a copy that is not valid JSON is caught', mapTamper.res.errors);
  check(!mapTamper.registered && /NEWJV2\.json/.test(mapTamper.problems.join(' ')),
        'R-21 with no previous version to restore, the mapping becomes a placeholder with no "ref" — refused by the registry and reported, never offered as a JV',
        { registered: mapTamper.registered, problems: mapTamper.problems });
  check(/_abandoned/.test(read('special_jv_mapping/NEWJV2.json'))
        && /jv-abandoned/.test(read('special_jv_templates/NEWJV2.html')),
        'R-21 and both files say in writing that this JV was not published');
  const recovered = await page.evaluate(() => JvCreator.publish(
    JvCreator.duplicateDef('TCH', 'NEWJV2', 'Published after the failure'), { newOnly: true, lockWait: 30 }));
  check(recovered.ok && !!JSON.parse(read('special_jv_mapping/NEWJV2.json')).jvSpec,
        'R-21 and the code is not bricked: publishing again replaces both placeholders', recovered.errors);

  const retry = await page.evaluate(async () => {
    const ev = await JvCreator.inspect('NEWJV1');
    const d = JvCreator.duplicateDef('TCH', 'NEWJV1', 'Published on the second go');
    const res = await JvCreator.publish(d, { lockWait: 30 });
    return { kind: ev.kind, res };
  });
  check(retry.kind === 'abandoned' && retry.res.ok && exists('special_jv_mapping/NEWJV1.json'),
        'the placeholder is recognised for what it is, so publishing again simply replaces it', retry);

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[9] a page edited by hand after it was generated');
  const good = read('special_jv_templates/TCH2.html');
  fs.writeFileSync(abs('special_jv_templates/TCH2.html'), good.replace('"nominal": "17036"', '"nominal": "99999"'));
  const edited = await inspect('TCH2');
  check(edited.kind === 'handEdited' && /edited by hand/.test(edited.why),
        'R-16 the creator compares the JSON block in the page with the mapping and sees the hand edit', { kind: edited.kind, why: edited.why });
  const refusedEdit = await publish(await page.evaluate(() => {
    const d = JSON.parse(JSON.stringify(SpecialJV.get('TCH2'))); delete d.htmlPath; delete d._file;
    d.displayName = 'TCH2 — over the top of a hand edit'; return d;
  }), { baseRev: JSON.parse(read('special_jv_mapping/TCH2.json')).audit.rev,
        baseUpdatedAt: JSON.parse(read('special_jv_mapping/TCH2.json')).audit.updatedAt });
  check(!refusedEdit.ok && refusedEdit.needs === 'handEdits' && refusedEdit.written.length === 0,
        'R-16 publishing over it needs a second, explicit confirmation — one refusal is not a dialog to click past', refusedEdit.errors);
  check(/99999/.test(read('special_jv_templates/TCH2.html')), 'R-16 and the hand edit is still there, unharmed');
  const warn = await openJv('TCH2');
  await warn.locator('#summary').waitFor({ timeout: 15000 });
  const warnText = (await warn.locator('.jv-warn').count()) ? await warn.locator('.jv-warn').textContent() : '';
  const summary = await warn.locator('#summary').textContent();
  check(/differ/.test(warnText), 'R-16 the engine warns the operator at run time that the two copies disagree', warnText.trim().slice(0, 120));
  check(/clearing 17036/.test(summary) && !/99999/.test(summary),
        'R-16 and it uses the mapping, not the edited copy in the page', summary.replace(/\s+/g, ' ').trim().slice(0, 120));
  await page.evaluate(() => SpecialJV._cancel());
  /* The other way a page can be hand-edited: the JSON block itself removed or
     broken. The creator writes one every time, so its absence is evidence. */
  const handEdited = read('special_jv_templates/TCH2.html');
  fs.writeFileSync(abs('special_jv_templates/TCH2.html'),
    handEdited.replace(/<script type="application\/json" id="jvDef">[\s\S]*?<\/script>/, ''));
  const noIsland = await inspect('TCH2');
  check(noIsland.kind === 'handEdited' && noIsland.islandFound === false,
        'R-16 a page whose JSON block has been removed is a hand edit too, not a page to overwrite quietly',
        { kind: noIsland.kind, islandFound: noIsland.islandFound });
  fs.writeFileSync(abs('special_jv_templates/TCH2.html'), handEdited);

  const overwrote = await publish(await page.evaluate(() => {
    const d = JSON.parse(JSON.stringify(SpecialJV.get('TCH2'))); delete d.htmlPath; delete d._file;
    d.displayName = 'TCH2 — republished over the hand edit'; return d;
  }), { overwriteHandEdits: true, confirmedRef: 'TCH2',
        baseRev: JSON.parse(read('special_jv_mapping/TCH2.json')).audit.rev,
        baseUpdatedAt: JSON.parse(read('special_jv_mapping/TCH2.json')).audit.updatedAt });
  const after = await inspect('TCH2');
  check(overwrote.ok && after.kind === 'generated' && !/99999/.test(read('special_jv_templates/TCH2.html')),
        'with the confirmation it is republished, and the page matches the mapping again',
        { ok: overwrote.ok, errors: overwrote.errors, kind: after.kind });
  check(archiveDirs().length >= 2 && fs.readFileSync(abs('special_jv_archive/TCH2/' + archiveDirs().sort().slice(-1)[0] + '/TCH2.html'), 'utf8').indexOf('99999') > 0,
        'R-19 and the hand-edited page is in the archive, so the edit can still be read back', archiveDirs());

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[10] two people saving at once, and retiring without deleting');
  const locked = await page.evaluate(async () => {
    await window.pywebview.api.write_file('special_jv_mapping/.lock_TCH2.json',
      JSON.stringify({ user: 'R. Menon', at: new Date().toISOString(), token: 'theirs' }));
    const d = JSON.parse(JSON.stringify(SpecialJV.get('TCH2')));
    delete d.htmlPath; delete d._file;
    d.displayName = 'mine, while theirs is open';
    const res = await JvCreator.publish(d, { baseRev: d.audit.rev, baseUpdatedAt: d.audit.updatedAt,
      confirmedRef: 'TCH2', lockWait: 30 });
    /* And an abandoned lock does not block anybody for ever. */
    await window.pywebview.api.write_file('special_jv_mapping/.lock_TCH2.json',
      JSON.stringify({ user: 'R. Menon', at: new Date(Date.now() - 11 * 60000).toISOString(), token: 'stale' }));
    const res2 = await JvCreator.publish(d, { baseRev: d.audit.rev, baseUpdatedAt: d.audit.updatedAt,
      confirmedRef: 'TCH2', lockWait: 30 });
    return { res, res2 };
  });
  check(!locked.res.ok && /R\. Menon started saving/.test(locked.res.errors.join(' ')) && locked.res.written.length === 0,
        'R-18 a fresh lock belonging to someone else stops the save and says whose it is', locked.res.errors);
  check(locked.res2.ok, 'R-18 a lock older than ten minutes is treated as abandoned, so nobody is locked out for ever',
        locked.res2.errors);
  const lockFiles = fs.readdirSync(abs('special_jv_mapping'));
  check(lockFiles.indexOf('.lock_TCH2.json') >= 0 && read('special_jv_mapping/.lock_TCH2.json') === '{}',
        'R-18 the lock is released by emptying it (nothing can be deleted) and never shows up as a JV because list_files skips dotfiles',
        lockFiles);
  const listed = await page.evaluate(() => Store.listFiles('special_jv_mapping').then(f => f.map(x => x.name).sort()));
  check(listed.indexOf('.lock_TCH2.json') === -1, 'and the registry listing does not see it', listed);

  const retired = await page.evaluate(() => JvCreator.setRetired('TCH2', true, { lockWait: 30 }));
  const afterRetire = await page.evaluate(() => ({
    registered: !!SpecialJV.get('TCH2'),
    opts: SpecialJV.buildToAccountOptions().map(o => o.value),
    retired: (SpecialJV.get('TCH2').audit || {}).retired
  }));
  check(retired.ok && afterRetire.retired === true && afterRetire.registered === true
        && afterRetire.opts.indexOf('TCH2') === -1,
        'R-22 a retired JV disappears from the To Account dropdown and stays in the registry, so a pending JV can still be finished',
        { ok: retired.ok, errors: retired.errors, afterRetire });
  check(exists('special_jv_mapping/TCH2.json') && exists('special_jv_templates/TCH2.html'),
        'R-22 and nothing on the share was deleted');
  const brought = await page.evaluate(() => JvCreator.setRetired('TCH2', false, { lockWait: 30 }));
  const afterBack = await page.evaluate(() => SpecialJV.buildToAccountOptions().map(o => o.value));
  check(brought.ok && afterBack.indexOf('TCH2') >= 0, 'R-22 and it can be brought back', { ok: brought.ok, errors: brought.errors });

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[11] the republished TCH2 still posts the same eight lines');
  const again = await runTch('TCH2');
  check(again.totals === '5,000.00|100.00|50.00|0.00' && JSON.stringify(again.pend.lines) === JSON.stringify(L),
        'after three republishes, a forced overwrite and a retire, the lines are byte-identical to the first run',
        again.pend.lines.length === L.length ? 'same length, different content' : { now: again.pend.lines.length, first: L.length });
  check(again.pend.meta.specHash === JSON.parse(read('special_jv_mapping/TCH2.json')).audit.specHash,
        'and the recorded spec hash is the one on the share now', again.pend.meta.specHash);
  await page.evaluate(() => App.closeModal());

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n[12] a read-only share: the files are handed over instead');
  await page.evaluate(() => { App.navigate('aeg'); AEG.switchTab('specialjv'); });
  await page.waitForSelector('#aegContent .card-grid', { timeout: 10000 });
  await page.click('#aegContent .card:has-text("Ref TCH2") button:has-text("Duplicate")');
  await page.waitForSelector('#jvDupRef', { timeout: 10000 });
  await page.fill('#jvDupRef', 'HANDOVER');
  await resetLog();
  await page.click('#jvDupSave');
  await page.waitForSelector('#jvDupResult .doc-banner', { timeout: 15000 });
  const handoverCalls = await callLog();
  const handover = handoverCalls.map(c => c.method);
  /* Reco's own state saves (reco/*.json) can land at any moment, so what
     matters is that nothing was written into the JV folders. */
  const jvWrites = handoverCalls.filter(c => c.method === 'write_file' && /^special_jv_/.test(String(c.arg0 || '')))
    .map(c => c.arg0);
  const dl = path.join(base, 'downloads_' + PORT);
  const dlFiles = fs.existsSync(dl) ? fs.readdirSync(dl).sort() : [];
  check(dlFiles.join() === 'HANDOVER.html,HANDOVER.json',
        'R-13 "Download the files instead" writes the pair through the Save-as dialog', dlFiles);
  check(handover.indexOf('show_save_dialog') >= 0 && handover.indexOf('write_file_abs') > handover.indexOf('show_save_dialog')
        && jvWrites.length === 0,
        'R-13 and write_file_abs is reached only after the dialog, never on the share itself',
        { order: handover.filter(m => /save_dialog|write_file/.test(m)), jvWrites });
  check(!exists('special_jv_mapping/HANDOVER.json') && !exists('special_jv_templates/HANDOVER.html'),
        'R-13 nothing was written to the shared folder by that path');
  const handoverHtml = fs.readFileSync(path.join(dl, 'HANDOVER.html'), 'utf8');
  check(handoverHtml.indexOf('<script>') === -1 && /jv-spec-hash/.test(handoverHtml)
        && JVCore.specHash(JSON.parse(fs.readFileSync(path.join(dl, 'HANDOVER.json'), 'utf8')))
           === /jv-spec-hash" content="([^"]+)"/.exec(handoverHtml)[1],
        'and the handed-over pair is the same data-only page and matching mapping');
  await page.evaluate(() => App.closeModal());

  check(read('special_jv_templates/TCH.html') === TCH_HTML_BEFORE,
        'R-15 after everything, special_jv_templates/TCH.html is byte-identical to the file this run started with');
  check(read('special_jv_mapping/TCH.json') === TCH_JSON_BEFORE,
        'and so is special_jv_mapping/TCH.json');

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
