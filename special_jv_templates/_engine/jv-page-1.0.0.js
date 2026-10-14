/* ============================================================================
   jv-page-1.0.0.js — the page half of the generic Special JV calculator.

   A generated special_jv_templates/<REF>.html carries NO script of its own:
   a title, a stylesheet link, a mount <div>, an inert
   <script type="application/json" id="jvDef"> copy of its mapping, and two
   <script src> tags — the core, then this file. Everything on screen is built
   here, from the spec, at run time.

   What this file is responsible for:
     · the handshake with Reco (same-origin globals when they are readable,
       postMessage when the host page is isolated, as file:// pages are);
     · refusing to start when the engine core is missing, or when the spec is
       malformed, of an unknown version, or addressed to another JV — always
       with a sentence on screen and never a half-working form;
     · the DOM, using the same hooks and class names the hand-written
       special_jv_templates/TCH.html exposes, so the TCH end-to-end test drives
       a generated page unchanged;
     · posting the finished lines back with the engine version and the spec
       hash that produced them.

   It never computes an amount itself: every figure comes from JVCore.
   It compiles nothing and reads nothing from the network.
   ========================================================================= */
(function (W) {
  'use strict';

  var ENGINE_VERSION = '1.0.0';
  var ROOT_ID = 'jvRoot', ISLAND_ID = 'jvDef';

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    });
  }
  function post(m) { try { W.parent.postMessage(m, '*'); } catch (e) { /* no host */ } }

  /* ── the core has to be there ───────────────────────────────────────────────
     The shell's two script tags are plain and in order, so if this file runs
     and the core did not, the core file is missing from the share. Say which
     file, and offer the one button that still means something. */
  function pageRef() {
    var last = (location.pathname.split('/').pop() || '');
    try { last = decodeURIComponent(last); } catch (e) { /* keep it raw */ }
    return last.replace(/\.html?$/i, '');
  }
  var PAGE_REF = pageRef();

  var C = W.JVCore;
  if (!C || typeof C.buildAll !== 'function') {
    var showMissing = function () {
      var r = el(ROOT_ID);
      if (!r) return;
      r.className = '';
      r.innerHTML = '<div class="jv-fatal"><b>This Special JV cannot run: the calculator engine is missing.</b>'
        + '<pre>special_jv_templates/_engine/jv-core-' + esc(ENGINE_VERSION) + '.js did not load.\n'
        + 'It ships with Reco and is copied to the shared folder the first time a JV is saved.\n'
        + 'Ask whoever set up the shared folder to put the _engine folder back, then reopen this JV.</pre></div>'
        + '<div class="actions"><button data-act="cancel">Close</button></div>';
      r.onclick = function (ev) {
        var t = ev.target;
        if (t && t.getAttribute && t.getAttribute('data-act') === 'cancel') {
          post({ type: 'specialJV.cancel', ref: PAGE_REF, lines: [], primaryKeys: [] });
        }
      };
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showMissing);
    else showMissing();
    return;
  }

  var S = {
    ref: PAGE_REF, def: null, spec: null, island: null, islandBad: '',
    inputs: [], cls: [], presets: [], sections: [], nextId: 1, assign: {},
    fatal: '', errors: [], warnings: [], drift: '', started: false, previewOpen: false
  };

  /* ── boot ──────────────────────────────────────────────────────────────── */
  function readIsland() {
    var node = el(ISLAND_ID);
    if (!node) return null;
    var txt = node.textContent || '';
    if (!txt.trim()) return null;
    try { return JSON.parse(txt); }
    catch (e) {
      /* Only fatal when there is nothing else to run from: with a definition
         from Reco the page works, and the operator is told the file is damaged. */
      S.islandBad = 'the copy of the mapping embedded in this page is not valid JSON (' + e.message + ')';
      return null;
    }
  }
  /* Same-origin: Reco exposes the inputs on its own window. Reading it throws
     when the browser isolates the two pages (every file:// pair), which is the
     normal case and not an error — the postMessage handshake takes over. */
  function readParent() {
    try {
      var p = W.parent;
      if (!p || p === W || !p._specialJvRef) return false;
      S.inputs = p._specialJvInputs || [];
      S.ref = p._specialJvRef;
      S.def = p._specialJvDef || null;
      return true;
    } catch (e) { return false; }
  }

  function start() {
    if (S.started) return;
    S.started = true;
    S.island = readIsland();

    /* A host can never make this page compute another JV's maths. */
    if (S.def && String(S.def.ref) !== PAGE_REF && PAGE_REF) {
      S.fatal = 'This page is ' + PAGE_REF + ', but Reco asked it to run "' + String(S.def.ref) + '". Nothing was computed.';
      return render();
    }
    var live = S.def || S.island;
    if (!live) {
      S.fatal = S.islandBad
        ? ('No JV definition reached this page: special_jv_mapping/' + PAGE_REF
           + '.json was not sent by Reco, and ' + S.islandBad + '.')
        : ('No JV definition reached this page: special_jv_mapping/' + PAGE_REF
           + '.json was not sent by Reco and this page carries no embedded copy.');
      return render();
    }
    if (S.islandBad) S.drift = 'This page\'s own embedded copy of the mapping is damaged — ' + S.islandBad
      + '. The mapping JSON from Reco is being used.';
    /* The mapping JSON is the source of truth. When the page's own embedded
       copy disagrees, someone edited one of them — say so and carry on with
       the mapping, because that is the file the chart of accounts is kept in. */
    if (S.def && S.island && C.canonicalDef(S.def) !== C.canonicalDef(S.island)) {
      S.drift = 'The mapping JSON and the copy embedded in this page differ (someone edited one of them). '
        + 'The mapping JSON is being used.';
    }
    S.def = live;
    S.ref = S.ref || String(live.ref || PAGE_REF);
    S.spec = live.jvSpec || null;

    var v = C.validateSpec(live);
    S.warnings = v.warnings || [];
    if (v.errors && v.errors.length) { S.errors = S.errors.concat(v.errors); return render(); }

    S.cls = S.inputs.map(function (r) { return C.classify(S.spec, r); });
    S.presets = C.presets(S.spec, S.inputs);
    initSections();
    render();
  }

  function initSections() {
    var sec = S.spec.sections || {};
    if (sec.mode === 'byColumn' && sec.valueColumn) {
      var seen = {}, order = [];
      S.inputs.forEach(function (r, i) {
        if (S.cls[i].kind === '@skip') return;
        var v = String(C.cellText(S.spec, r, sec.valueColumn) || '');
        if (!v || seen[v]) return;
        seen[v] = 1; order.push(v);
      });
      order.forEach(function (v) { var s = C.newSection(S.spec, S.nextId++); s.group = v; S.sections.push(s); });
      S.inputs.forEach(function (r, i) {
        if (S.cls[i].kind === '@skip') return;
        var v = String(C.cellText(S.spec, r, sec.valueColumn) || '');
        for (var k = 0; k < S.sections.length; k++) if (S.sections[k].group === v) { S.assign[i] = S.sections[k].id; return; }
      });
    }
    var want = sec.mode === 'single' ? 1 : Math.max(1, sec.startWith == null ? 1 : (sec.startWith | 0));
    while (S.sections.length < want) S.sections.push(C.newSection(S.spec, S.nextId++));
  }

  /* ── the layout of a section's table ───────────────────────────────────────
     One column group per declared heading, aggregates first then typed fields,
     in the order the spec declares them. Headings the spec lists in
     layout.sectionTable.groups come first, so the creator controls the order
     without repeating it per cell. */
  function groupPlan() {
    var order = ((S.spec.layout || {}).sectionTable || {}).groups || [];
    var map = {}, names = [];
    function slot(g) {
      var key = g == null ? '' : String(g);
      if (!map[key]) { map[key] = { name: key, cells: [] }; names.push(key); }
      return map[key];
    }
    order.forEach(function (g) { slot(g); });
    (S.spec.aggregates || []).forEach(function (a) {
      slot(a.group).cells.push({ t: 'agg', id: a.id, label: a.label || a.id });
    });
    (S.spec.fields || []).forEach(function (f) {
      if (f.group === '@head') return;
      slot(f.group).cells.push({ t: 'field', id: f.id, label: f.label || f.id, f: f });
    });
    var out = [];
    names.forEach(function (n) { if (map[n].cells.length) out.push(map[n]); });
    return out;
  }
  function headFields() {
    return (S.spec.fields || []).filter(function (f) { return f.group === '@head'; });
  }
  function sectionIdx(id) {
    for (var i = 0; i < S.sections.length; i++) if (S.sections[i].id === id) return i;
    return -1;
  }
  function sectionById(id) { var i = sectionIdx(id); return i < 0 ? null : S.sections[i]; }
  function withN(s, i) { return String(s == null ? '' : s).split('{n}').join(String(i + 1)); }
  function tok(i) { return withN((S.spec.sections || {}).token || 'T{n}', i); }

  /* ── render ────────────────────────────────────────────────────────────── */
  function render() {
    var root = el(ROOT_ID);
    if (!root) return;
    root.className = '';
    if (S.fatal || S.errors.length) { renderFatal(root); return; }

    var sec = S.spec.sections || {};
    var h = '';
    h += '<h2>' + esc(S.spec.title || S.def.displayName || S.ref) + '</h2>';
    h += '<div id="summary" class="summary"></div>';
    if (S.drift) h += '<div class="jv-warn">' + esc(S.drift) + '</div>';
    if (S.warnings.length) {
      h += '<details class="jv-notes"><summary>' + S.warnings.length + ' note(s) about this JV definition</summary><ul>'
        + S.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></details>';
    }
    h += '<div id="sectionsWrap"></div>';
    if (sec.mode !== 'single') {
      h += '<button class="add-tch" data-act="add">' + esc(sec.addLabel || ('+ Add ' + (S.spec.sectionNoun || 'Section'))) + '</button>';
    }
    h += '<div class="rows-head"><h3>Source Rows · assign each to a '
      + esc(S.spec.sectionNoun || 'section') + ' section</h3><div class="spacer"></div>';
    if (sec.autoAssign) {
      h += '<button class="small" data-act="auto">' + esc(sec.autoAssign.label || 'Auto-assign by period') + '</button>';
    }
    if (sec.assignAll) h += '<select id="assignAllSel" data-act="assignAll" style="min-width:140px;"></select>';
    h += '</div>';
    h += '<div class="rows-wrap"><table class="rows-table" id="rowsTable"><thead></thead><tbody></tbody></table></div>';
    h += '<div id="previewPane" class="preview-pane" style="display:none;"></div>';
    h += '<div class="actions"><button data-act="cancel">Cancel</button>'
      + '<button class="small" id="previewBtn" data-act="preview">Show Preview</button>'
      + '<div class="spacer"></div><span id="assignInfo"></span>'
      + '<button class="primary" data-act="submit">Generate Lines &amp; Return</button></div>';
    root.innerHTML = h;
    wire(root);
    renderSummary();
    renderSections();
    renderRows();
    refresh();
  }

  function renderFatal(root) {
    var list = S.errors.length ? S.errors : [S.fatal];
    root.innerHTML = '<div class="jv-fatal"><b>This Special JV cannot run.</b>'
      + '<pre>' + esc(S.ref || PAGE_REF) + ' — nothing has been computed and nothing will be posted.</pre>'
      + '<ul>' + list.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>'
      + '<pre>Fix special_jv_mapping/' + esc(S.ref || PAGE_REF) + '.json (or reopen the JV in Reco → '
      + 'Entry Generator → Special JVs) and try again.</pre></div>'
      + '<div class="actions"><button data-act="cancel">Cancel</button></div>';
    wire(root);
  }

  function renderSummary() {
    var e = el('summary');
    if (!e) return;
    var counts = {}, skipped = 0;
    S.cls.forEach(function (c) {
      if (c.kind === '@skip') { skipped++; return; }
      counts[c.kind] = (counts[c.kind] || 0) + 1;
    });
    var kindBits = (S.spec.kinds || []).map(function (k) {
      return ' · ' + C.fmtInt(counts[k.id] || 0) + ' ' + esc(k.label || k.id);
    }).join('');
    var months = {}, nMonths = 0;
    var dateCol = null;
    (S.spec.columns || []).forEach(function (c) { if (c.role === 'date' && !dateCol) dateCol = c; });
    if (dateCol) {
      S.inputs.forEach(function (r) {
        var d = C.cell(S.spec, r, dateCol.id);
        if (d) { var k = d.getFullYear() + '-' + d.getMonth(); if (!months[k]) { months[k] = 1; nMonths++; } }
      });
    }
    var accBits = (S.spec.slots || []).map(function (s) {
      var a = (S.def.accounts || {})[s.id] || {};
      return esc(s.short || s.label || s.id) + ' ' + esc(a.nominal || '?') + '/' + esc(a.rc == null ? '' : a.rc);
    }).join(' · ');
    var h = '';
    h += '<div><b>JV:</b> ' + esc(S.ref) + ' <span class="muted">spec v' + esc(S.spec.specVersion)
       + ' · engine ' + esc(C.version) + '</span></div>';
    h += '<div><b>Inputs:</b> ' + C.fmtInt(S.inputs.length) + ' row(s)' + kindBits
       + (skipped ? ' · ' + C.fmtInt(skipped) + ' ignored' : '') + '</div>';
    if (dateCol) h += '<div><b>Months detected:</b> ' + C.fmtInt(nMonths) + '</div>';
    if (accBits) h += '<div><b>Accounts:</b> ' + accBits + ' · LOB ' + esc((S.def.accounts || {}).lob) + '</div>';
    if (!S.inputs.length) {
      h += '<div class="err">No rows received from Reco — check the To Account column and the mapping\'s inputColumns.</div>';
    }
    e.innerHTML = h;
  }

  function fieldInput(sec, f, idx) {
    var val = sec.fields[f.id] == null ? '' : sec.fields[f.id];
    var ph = withN(f.placeholder, idx);
    var attrs = ' data-s="' + sec.id + '" data-f="' + esc(f.id) + '"';
    if (f.type === 'choice') {
      return '<select' + attrs + '><option value=""></option>'
        + (f.options || []).map(function (o) {
            return '<option value="' + esc(o) + '"' + (String(val) === String(o) ? ' selected' : '') + '>' + esc(o) + '</option>';
          }).join('') + '</select>';
    }
    if (f.type === 'yesno') {
      return '<select' + attrs + '><option value=""></option>'
        + ['Yes', 'No'].map(function (o) {
            return '<option value="' + esc(o) + '"' + (String(val) === o ? ' selected' : '') + '>' + o + '</option>';
          }).join('') + '</select>';
    }
    var numeric = (f.type === 'amount' || f.type === 'number');
    var bad = '';
    if ((f.type === 'period' || f.type === 'date') && String(val).trim() && !C.parsePeriod(val, presetFormat())) bad = ' class="bad"';
    return '<input type="' + (numeric ? 'number' : 'text') + '"' + (numeric ? ' step="0.01"' : '') + bad + attrs
      + (ph ? ' placeholder="' + esc(ph) + '"' : (numeric ? ' placeholder="0.00"' : ''))
      + ' value="' + esc(val) + '" />';
  }
  function presetFormat() { return ((S.spec.sections || {}).presets || {}).valueFormat; }

  function renderSections() {
    var wrap = el('sectionsWrap');
    if (!wrap) return;
    var sec = S.spec.sections || {};
    var plan = groupPlan(), heads = headFields();
    var html = '';
    S.sections.forEach(function (s, idx) {
      html += '<div class="tch-card" data-s="' + s.id + '">';
      html += '<div class="head"><div class="title">' + esc(C.sectionTitle(S.spec, idx))
        + (s.group ? ' — ' + esc(s.group) : '')
        + ' <span class="muted">(token: ' + esc(tok(idx)) + ')</span></div><div>'
        + (S.sections.length > 1 ? '<button class="small danger" data-del="' + s.id + '">Remove</button>' : '')
        + '</div></div>';
      html += '<div class="top-row">';
      heads.forEach(function (f) {
        html += '<label><span class="lbl">' + esc(f.label || f.id) + (f.required ? ' *' : '') + '</span>'
          + fieldInput(s, f, idx) + '</label>';
      });
      if (S.presets.length) {
        html += '<label><span class="lbl">' + esc((sec.presets && sec.presets.label) || 'Range Preset') + '</span>'
          + '<select data-preset="' + s.id + '"><option value="">— pick a slot —</option>'
          + S.presets.map(function (p, pi) {
              return '<option value="' + pi + '"' + (String(s.preset) === String(pi) ? ' selected' : '') + '>'
                + esc(p.label) + ' (' + esc(p.from) + ' → ' + esc(p.to) + ')</option>';
            }).join('') + '</select></label>';
      }
      html += '<span class="rows-badge" data-rows="' + s.id + '"></span>';
      html += '</div>';

      if (plan.length) {
        html += '<table class="tch-data-table"><thead><tr class="h1">';
        plan.forEach(function (g) {
          html += '<th colspan="' + g.cells.length + '">' + (g.name ? esc(g.name) : '&nbsp;') + '</th>';
        });
        html += '</tr><tr class="h2">';
        plan.forEach(function (g) {
          g.cells.forEach(function (c) {
            html += '<th>' + esc(c.label)
              + (c.t === 'field' && c.f.memoOnly ? '<span class="memo">recorded, not posted</span>' : '')
              + '</th>';
          });
        });
        html += '</tr></thead><tbody><tr>';
        plan.forEach(function (g) {
          g.cells.forEach(function (c) {
            if (c.t === 'agg') html += '<td class="computed" data-s="' + s.id + '" data-k="' + esc(c.id) + '"></td>';
            else html += '<td class="input">' + fieldInput(s, c.f, idx) + '</td>';
          });
        });
        html += '</tr></tbody></table>';
      }
      html += '</div>';
    });
    wrap.innerHTML = html;
  }

  function renderRows() {
    var tbl = el('rowsTable');
    if (!tbl) return;
    var layout = (S.spec.layout || {}).rowsTable || {};
    var cols = (S.def.inputColumns || []).map(function (c) { return c.name; });
    var assignHead = layout.assignColumn || (S.spec.sectionNoun || 'Section');
    var head = '<tr><th style="width:74px;">' + esc(assignHead) + '</th>'
      + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('')
      + (layout.noteColumn === false ? '' : '<th>Note</th>') + '</tr>';
    tbl.querySelector('thead').innerHTML = head;

    var body = S.inputs.map(function (row, i) {
      var c = S.cls[i];
      var cls = c.kind === '@skip' ? 'row-skip' : ('row-' + (C.kindStyle(S.spec, c.kind) || 'grey'));
      var opts = '<option value="0">—</option>' + S.sections.map(function (s, idx) {
        return '<option value="' + s.id + '"' + (S.assign[i] === s.id ? ' selected' : '') + '>' + esc(tok(idx)) + '</option>';
      }).join('');
      /* Exact column name first, then the same name ignoring case, spaces and
         underscores — the lookup the core uses, so what is shown is what the
         maths read. */
      var tds = cols.map(function (col) {
        return '<td>' + esc(C.raw(row, { label: col })) + '</td>';
      }).join('');
      return '<tr class="' + cls + '"><td class="tch-cell"><select data-row="' + i + '">' + opts + '</select></td>'
        + tds
        + (layout.noteColumn === false ? ''
            : '<td class="note">' + (c.kind === '@skip' ? 'ignored: ' + esc(c.why) : esc(c.label || c.kind)) + '</td>')
        + '</tr>';
    }).join('');
    if (!S.inputs.length) {
      body = '<tr><td colspan="' + (cols.length + (layout.noteColumn === false ? 1 : 2))
        + '" class="err" style="text-align:center; padding:14px;">No input rows received from host.</td></tr>';
    }
    tbl.querySelector('tbody').innerHTML = body;

    var all = el('assignAllSel');
    if (all) {
      all.innerHTML = '<option value="">Assign all rows to…</option><option value="0">— (clear)</option>'
        + S.sections.map(function (s, idx) { return '<option value="' + s.id + '">' + esc(tok(idx)) + '</option>'; }).join('');
    }
  }

  /* Typing only refreshes the computed cells and the preview. Rebuilding the
     DOM on every keystroke loses the caret, which is the bug the hand-written
     page had to fix and the end-to-end test watches for. */
  function refresh() {
    S.sections.forEach(function (s) {
      var vals;
      try { vals = C.aggregates(S.spec, S.inputs, S.cls, S.assign, s.id).values; }
      catch (e) { vals = {}; }
      var cells = document.querySelectorAll('td.computed[data-s="' + s.id + '"]');
      Array.prototype.forEach.call(cells, function (td) {
        var k = td.getAttribute('data-k');
        td.textContent = C.fmtNum(vals[k]);
      });
      var badge = document.querySelector('.rows-badge[data-rows="' + s.id + '"]');
      if (badge) badge.textContent = C.fmtInt(vals['@rowsUsed'] || 0) + ' row(s) assigned';
    });
    var un = 0;
    S.inputs.forEach(function (r, i) { if (S.cls[i].kind !== '@skip' && !S.assign[i]) un++; });
    var info = el('assignInfo');
    if (info) info.textContent = un ? C.fmtInt(un) + ' row(s) not assigned' : '';
    if (S.previewOpen) renderPreview();
  }

  function build() {
    return C.buildAll(S.def, S.spec, S.inputs, S.cls, S.assign, S.sections);
  }

  function renderPreview() {
    var p = el('previewPane');
    if (!p) return;
    var built;
    try { built = build(); }
    catch (e) { p.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; return; }
    if (!built.lines.length) {
      p.innerHTML = '<div class="err">No lines yet — assign rows and/or fill the typed figures.</div>';
      return;
    }
    var bal = C.balances(built.lines);
    var balHtml = Object.keys(bal).sort().map(function (c) {
      var diff = Math.round((bal[c].dr - bal[c].cr) * 100) / 100;
      /* Zero, not "within a cent": this is the rule Reco's own
         SpecialJV.checkLines applies when the lines arrive, so what the
         operator sees here is what the host will accept. */
      var okb = diff === 0;
      return '<span class="' + (okb ? 'balanced' : 'unbalanced') + '">' + esc(c || '(no currency)')
        + ': Dr ' + C.fmtNum(bal[c].dr) + ' / Cr ' + C.fmtNum(bal[c].cr) + (okb ? ' ✓' : ' ✗') + '</span>';
    }).join('');
    var h = '<h4>Preview — ' + C.fmtInt(built.lines.length) + ' line(s) across '
      + C.fmtInt(S.sections.length) + ' section(s)</h4><div style="margin-bottom:6px;">' + balHtml + '</div>';
    h += '<table><thead><tr><th>Reco</th><th>Cur</th><th>RC</th><th>Nominal</th><th>SubNom</th><th>AK</th>'
      + '<th>LOB</th><th>Dr</th><th>Cr</th><th>Desc</th></tr></thead><tbody>';
    built.lines.forEach(function (l) {
      h += '<tr><td>' + esc(l.Reco) + '</td><td>' + esc(l.Cur) + '</td><td>' + esc(l.RC) + '</td><td>' + esc(l.Nominal)
        + '</td><td>' + esc(l.SubNominal) + '</td><td>' + esc(l['Analysis Key']) + '</td><td>' + esc(l.LOB) + '</td><td>'
        + (l.Dr ? C.fmtNum(l.Dr) : '') + '</td><td>' + (l.Cr ? C.fmtNum(l.Cr) : '') + '</td><td>' + esc(l.Desc) + '</td></tr>';
    });
    h += '</tbody></table>';
    p.innerHTML = h;
  }

  /* ── events: every handler is delegated from the mount div, so the
     generated HTML carries no on* attribute and no inline handler. ───────── */
  function wire(root) {
    root.onclick = function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var act = t.getAttribute('data-act');
      if (act === 'cancel') { post({ type: 'specialJV.cancel', ref: S.ref, lines: [], primaryKeys: [] }); return; }
      if (act === 'submit') { submit(); return; }
      if (act === 'add') { S.sections.push(C.newSection(S.spec, S.nextId++)); renderSections(); renderRows(); refresh(); return; }
      if (act === 'auto') { autoAssign(); return; }
      if (act === 'preview') {
        var p = el('previewPane');
        S.previewOpen = !S.previewOpen;
        p.style.display = S.previewOpen ? 'block' : 'none';
        t.textContent = S.previewOpen ? 'Hide Preview' : 'Show Preview';
        if (S.previewOpen) renderPreview();
        return;
      }
      var del = t.getAttribute('data-del');
      if (del) {
        if (S.sections.length <= 1) return;
        var id = +del;
        S.sections = S.sections.filter(function (s) { return s.id !== id; });
        Object.keys(S.assign).forEach(function (k) { if (S.assign[k] === id) S.assign[k] = 0; });
        renderSections(); renderRows(); refresh();
      }
    };
    root.oninput = function (ev) { onFieldEdit(ev.target); };
    root.onchange = function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      if (t.getAttribute('data-act') === 'assignAll') {
        if (t.value === '') return;
        C.assignAll(S.spec, S.inputs, S.cls, S.assign, +t.value || 0);
        t.value = '';
        renderRows(); refresh();
        return;
      }
      if (t.getAttribute('data-row') != null) { S.assign[+t.getAttribute('data-row')] = +t.value || 0; refresh(); return; }
      var pre = t.getAttribute('data-preset');
      if (pre) { applyPreset(+pre, t.value); return; }
      onFieldEdit(t);
    };
  }
  function onFieldEdit(t) {
    if (!t || !t.getAttribute) return;
    var sid = t.getAttribute('data-s'), fid = t.getAttribute('data-f');
    if (!sid || !fid) return;
    var s = sectionById(+sid);
    if (!s) return;
    s.fields[fid] = t.value;
    var f = C.fieldDef(S.spec, fid);
    if (f && f.clearsPreset) {
      s.preset = '';
      var sel = document.querySelector('select[data-preset="' + s.id + '"]');
      if (sel) sel.value = '';
    }
    if (f && (f.type === 'period' || f.type === 'date')) {
      var bad = String(t.value).trim() && !C.parsePeriod(t.value, presetFormat());
      t.className = bad ? 'bad' : '';
    }
    refresh();
  }
  function applyPreset(sid, pi) {
    if (pi === '') return;
    var p = S.presets[+pi];
    var s = sectionById(sid);
    if (!p || !s) return;
    var w = ((S.spec.sections || {}).presets || {}).writes || {};
    if (w.from) s.fields[w.from] = p.from;
    if (w.to) s.fields[w.to] = p.to;
    s.preset = String(pi);
    renderSections(); renderRows(); refresh();
  }
  function autoAssign() {
    var a = (S.spec.sections || {}).autoAssign || {};
    var r = C.autoAssign(S.spec, S.inputs, S.cls, S.sections, S.assign);
    if (r.noRange) {
      W.alert(a.noRangeMessage || 'Set a valid period on at least one section first.');
      return;
    }
    renderRows(); refresh();
    if (r.nodate) W.alert(String(a.noDateMessage || '{n} row(s) have no readable date and were left as they were.').split('{n}').join(String(r.nodate)));
  }

  /* ── submit ────────────────────────────────────────────────────────────── */
  function submit() {
    var r;
    try { r = C.runChecks(S.def, S.spec, S.inputs, S.cls, S.assign, S.sections); }
    catch (e) { W.alert('This JV could not be computed:\n' + e.message); return; }
    if (r.blocks.length) { W.alert(r.blocks[0]); return; }
    for (var i = 0; i < r.confirms.length; i++) if (!W.confirm(r.confirms[i])) return;
    var built = r.built;
    if (!built) {
      try { built = build(); }
      catch (e2) { W.alert('This JV could not be computed:\n' + e2.message); return; }
    }
    /* A spec need not declare the noLines check, but an empty line set reads
       to the host as a cancel, which would silently discard the user's work. */
    if (!built.lines.length) {
      W.alert('No accounting lines to post — every entry computes to zero.');
      return;
    }
    post({
      type: 'specialJV.complete',
      ref: S.ref,
      jvId: 'JV_' + String(S.ref).replace(/[^A-Za-z0-9]/g, '') + '_' + Date.now().toString(36),
      lines: built.lines,
      primaryKeys: built.primaryKeys,
      inputData: S.inputs,
      meta: {
        sections: built.sections,
        accounts: S.def.accounts,
        engine: C.version,
        page: ENGINE_VERSION,
        specVersion: S.spec.specVersion,
        /* The hash of the definition that actually produced these numbers,
           beside the one the file claims: together they say which maths wrote
           the figures now sitting in Reco's entry history. */
        specHash: C.specHash(S.def),
        declaredSpecHash: String((S.def.audit || {}).specHash || ''),
        drift: S.drift ? true : false,
        ref: S.ref
      }
    });
  }

  function boot() {
    if (readParent()) { start(); return; }
    W.addEventListener('message', function (ev) {
      var d = ev.data;
      if (ev.source !== W.parent || !d || d.type !== 'specialJV.init') return;
      S.inputs = Array.isArray(d.inputs) ? d.inputs : [];
      S.ref = d.ref || PAGE_REF;
      S.def = d.def || null;
      start();
    });
    post({ type: 'specialJV.ready', ref: PAGE_REF });
    /* Opened outside Reco, or by a Reco too old to answer: show the form from
       the embedded copy so the page is still readable on its own. */
    setTimeout(start, 2500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  W.JVPage = { version: ENGINE_VERSION, _state: S, _build: build, _refresh: refresh };
})(typeof window !== 'undefined' ? window : this);
