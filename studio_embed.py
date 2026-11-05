"""Make ColSift's studio.html from a Measure Studio file.

    python studio_embed.py measure-studio.html          writes studio.html beside this script

Measure Studio builds HTML visuals (and the DAX measure behind them, for Power BI's
HTML Content visual) from blocks: KPI cards, bar lists, column and line charts,
donuts, gauges, waterfalls, notes and tables. ColSift ships it as studio.html and
uses it twice: as the designer of a dashboard's Studio cards, and — hidden — as
their renderer. This script adds what that needs, leaving the studio itself as it is
(it still works on its own, and its DAX is unchanged):

  * live values: when the host hands it values, a block evaluates its own
    expressions ([Revenue], DIVIDE([A], [B]), [@cm] - [@pm] …) against them instead
    of the preview samples — scalars from LIVE.values, rows from LIVE.ctx[block id];
  * no localStorage writes while embedded, so the stand-alone studio's own work in
    progress is never overwritten;
  * a postMessage bridge: load / live / render / dax in, ready / save / close /
    html / dax out.

Every patch is checked to apply exactly once; a studio version that moved one of
these lines makes the script stop and say which.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

PATCHES = [
    # 1. scalars: a block's value expression, evaluated against ColSift's values
    ("    val(name, expr, sample) { return M.def(name, V(String(expr || 'BLANK()'), sval(sample))); },",
     "    val(name, expr, sample) { if (!dax && LIVE.on && String(expr || '').trim()) return M.def(name, V(String(expr), liveEval(expr, null))); /* ColSift */\n"
     "      return M.def(name, V(String(expr || 'BLANK()'), sval(sample))); },"),
    # 2. rows: bar, column, line, donut, notes
    ("    grid() { return parseGrid(b.sample); },",
     "    grid() { return (!dax && liveRows(b)) || parseGrid(b.sample); }, /* ColSift */"),
    # 3. rows: table
    ("      rows = parseGrid(b.sample).map((r, i) => {",
     "      rows = (liveRows(b) || parseGrid(b.sample)).map((r, i) => { /* ColSift */"),
    # 4. a KPI's sparkline: one point per period ColSift sends
    ("        let ys = String(s.spark || '').split(/[;,\\s]+/).map(parseNum).filter((x) => x !== null);\n"
     "        if (ys.length < 2) ys = genSeries(hashStr(b.id + (b.value || '')), 12, num(sval(s.v)) || 100);",
     "        let ys = String(s.spark || '').split(/[;,\\s]+/).map(parseNum).filter((x) => x !== null);\n"
     "        const lsp = LIVE.on && LIVE.ctx[b.id]; /* ColSift */\n"
     "        if (lsp) { ys = lsp.map((c) => num(liveEval(meas, c))); if (ys.length < 2) ys = [ys[0] || 0, ys[0] || 0]; }\n"
     "        else if (ys.length < 2) ys = genSeries(hashStr(b.id + (b.value || '')), 12, num(sval(s.v)) || 100);"),
    # 4b. a dashboard (strict) shows no sparkline for a card that has no periods bound
    ("    if (b.spark && b.spark.on) {",
     "    if (b.spark && b.spark.on && !(LIVE.on && LIVE.strict && !M.dax && !LIVE.ctx[b.id])) { /* ColSift */"),
    # 5. waterfall: start value and steps
    ("      pv.s = sm ? num(parseNum(sm[1])) : 1000;\n"
     "      const g = parseGrid(txt.replace(/^\\s*start\\s*=.*$/m, '')).filter((r) => !nul(r.v));",
     "      const lwf = liveRows(b); /* ColSift */\n"
     "      pv.s = lwf ? num(liveEval(b.start, null)) : sm ? num(parseNum(sm[1])) : 1000;\n"
     "      const g = (lwf || parseGrid(txt.replace(/^\\s*start\\s*=.*$/m, ''))).filter((r) => !nul(r.v));"),
    # 6. {{ templates }} in titles and captions
    ("        sample(expr, iter) {\n          const key = String(expr).trim();",
     "        sample(expr, iter) {\n          const key = String(expr).trim();\n"
     "          if (LIVE.on) { const lv = liveTry(key); if (lv.ok) return lv.v; } /* ColSift */"),
    # 7. embedded: leave the stand-alone studio's saved work alone
    ("function persist() { try {", "function persist() { if (window.__MS_EMBED) return; try {"),
    ("function restore() { try {", "function restore() { if (window.__MS_EMBED) return null; try {"),
]

LIVE_JS = r"""
/* ==========================================================================
   ColSift live data. Inside ColSift the host hands the studio real values:
   LIVE.values — each bound measure over the dashboard's data — and, per block,
   LIVE.ctx[id]: one context per row (a group's label, its column value and every
   measure for that group, or a record's columns). Blocks then evaluate their own
   expressions against those instead of the preview samples; the DAX is unchanged.
   ========================================================================== */
const LIVE = { on: false, strict: false, values: {}, ctx: {}, vars: null };   // strict: a dashboard — no sample rows
function liveLookup(map, name) {
  const s = String(name).trim();
  const m = s.match(/^(?:'((?:[^']|'')*)'|([A-Za-z_][\w ]*))?\[([^\]]+)\]$/);
  const key = (m ? m[3] : s).trim().toLowerCase(), col = !!(m && (m[1] || m[2]));
  if (map) for (const k of Object.keys(map)) if (k.toLowerCase() === key) return { hit: true, v: map[k], col };
  return { hit: false, col };
}
function liveEnv(row) {
  const env = {
    ref(name) {
      const at = String(name).match(/^\[@([A-Za-z0-9_]+)\]$/);
      if (at) return row && at[1] in row ? row[at[1]] : null;
      if (row) {
        const r = liveLookup(row, name);
        if (r.hit) return r.v;
        if (r.col && '__label' in row) return row.__label;      // 'Dim'[Category] = the group's label
      }
      const g = liveLookup(LIVE.values, name);
      if (g.hit) return g.v;
      throw new Error('No ColSift value for ' + name);
    },
    v(name) {
      const list = LIVE.vars || (UI.P && UI.P.vars) || [];
      const vv = list.find((x) => String(x.name).toLowerCase() === String(name).toLowerCase());
      if (!vv) throw new Error('Unknown variable ' + name);
      return evalDax(vv.expr, env);
    },
  };
  return env;
}
function liveEval(expr, row) {
  if (!String(expr || '').trim()) return null;
  try {
    const v = evalDax(String(expr), liveEnv(row));
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return typeof v === 'number' && !isFinite(v) ? null : v;
  } catch (e) { return null; }
}
function liveTry(expr) {
  try { const v = evalDax(String(expr), liveEnv(null)); return { ok: v !== null && v !== undefined, v: v instanceof Date ? v.toISOString().slice(0, 10) : v }; }
  catch (e) { return { ok: false }; }
}
const liveSeries = (b, c, i) => Object.assign({ l: c.__label, o: c.__order ?? i },
  ...(b.series || []).map((s, k) => ({ ['y' + (k + 1)]: liveEval(s.expr, c) })));
const LIVE_ROW = {
  bar: (b, c, i) => ({ l: c.__label, v: liveEval(b.value, c), m: (b.marker || '').trim() ? liveEval(b.marker, c) : null, o: c.__order ?? i }),
  donut: (b, c) => ({ l: c.__label, v: liveEval(b.value, c) }),
  col: liveSeries, line: liveSeries,
  wf: (b, c, i) => ({ l: c.__label, v: liveEval(b.delta, c), o: c.__order ?? i }),
  notes: (b, c) => ({ t: liveEval(b.ttl, c) ?? c.__label ?? '', b: liveEval(b.body, c) ?? '',
                      m: (b.meta || '').trim() ? liveEval(b.meta, c) ?? '' : '', k: (b.badge || '').trim() ? liveEval(b.badge, c) ?? '' : '' }),
  table: (b, c, i) => {
    const T = tbPlan(b), o = {};
    T.cols.forEach((col) => { if (T.lvl[col.key] === 0 && col.type !== 'spark') o[col.key] = liveEval(col.expr, c); });
    if (T.grpOn) o.g = liveEval(b.group.expr, c) ?? '';
    if (T.sortCustom) o.o = liveEval(b.sort.expr, c) ?? i;
    return o;
  },
};
function liveRows(b) {
  if (!LIVE.on) return null;
  const ctx = LIVE.ctx[b.id], f = LIVE_ROW[b.type];
  if (!f) return null;
  if (!ctx) return LIVE.strict ? [] : null;      // nothing bound: no rows on a dashboard, samples in the designer
  return ctx.map((c, i) => f(b, c, i));
}

"""

BRIDGE_JS = r"""
<script>
/* ColSift bridge — only when the host set window.__MS_EMBED ('edit' or 'render') */
(function () {
  const mode = window.__MS_EMBED;
  if (!mode) return;
  const send = (m) => window.parent.postMessage(Object.assign({ ms: true }, m), '*');
  const setLive = (live, P) => {
    LIVE.on = !!(live && (live.values || live.ctx));
    LIVE.strict = !!(live && live.strict);
    LIVE.values = (live && live.values) || {};
    LIVE.ctx = (live && live.ctx) || {};
    LIVE.vars = P ? (P.vars || []) : null;
  };
  /* the host's measures as fields, so the rail offers them and {{ }} finds them */
  const mergeFields = (P, fields) => {
    const lines = String(P.fields || '').split(/\r?\n/), seen = new Set();
    const out = lines.map((l) => {
      const m = l.match(/^\s*\[([^\]]+)\]\s*(=|\t)?/);
      if (!m) return l;
      const f = fields.find((x) => x.name.toLowerCase() === m[1].trim().toLowerCase());
      if (!f) return l;
      seen.add(f.name.toLowerCase());
      return `[${f.name}] = ${f.sample ?? ''}`;
    });
    fields.filter((f) => !seen.has(f.name.toLowerCase())).forEach((f) => out.push(`[${f.name}] = ${f.sample ?? ''}`));
    P.fields = out.filter((l, i) => l.trim() || i < out.length - 1).join('\n');
  };
  const render = (project, live) => {
    const keep = Object.assign({}, LIVE);
    const P = normalizeProject(clone(project || defaultProject()));
    if (live && live.strict) P.settings.anim = 'none';     // a dashboard redraws often: no entrance animations
    setLive(live, P);
    let html;
    try { html = buildMeasure(P, { dax: false }).html; } finally { Object.assign(LIVE, keep); }
    if (P.settings.edition !== 'regular') html = sanitizeLite(html, { allowUrls: P.settings.allowUrls }).html;
    return html;
  };
  /* [Name] references that are measures, not 'Table'[Column] or [@key] */
  const refs = (P) => {
    const text = JSON.stringify([(P && P.blocks) || [], ((P && P.vars) || []).map((v) => v.expr)]);
    const out = new Map();
    for (const m of text.matchAll(/(^|[^\w'\]])\[([^\]@\[\\"][^\]\\"]*)\]/g)) {
      const n = m[2].trim();
      if (n && !out.has(n.toLowerCase())) out.set(n.toLowerCase(), n);
    }
    return [...out.values()];
  };
  /* what ColSift can feed: blocks that draw rows, KPIs with a sparkline */
  const blocks = (P) => ((P && P.blocks) || []).filter((b) => TYPES[b.type]).map((b) => ({
    id: b.id, type: b.type, kind: TYPES[b.type].name, title: String(b.title || '').replace(/\{\{[^}]*\}\}/g, '…').trim(),
    rows: !!LIVE_ROW[b.type], spark: b.type === 'kpi' && !!(b.spark && b.spark.on), records: b.type === 'notes' || b.type === 'table',
    hidden: !!b.hide }));
  /* a first design from a card's measures: a header, KPI cards, a bar list */
  const starter = (o) => {
    const P = normalizeProject(defaultProject());
    P.settings.name = o.name || 'ColSift visual';
    P.vars = [];
    P.blocks = [];
    const ms = (o.measures || []).filter(Boolean);
    P.blocks.push(newBlock(P, 'header', { title: o.name || 'Dashboard', subtitle: o.subtitle || '', chips: '' }));
    const n = Math.min(4, ms.length) || 1;
    ms.slice(0, 4).forEach((name) => P.blocks.push(newBlock(P, 'kpi', {
      span: Math.max(3, Math.floor(12 / n)), title: name, value: `[${name}]`, fmt: '#,0', cmp: '', cmpLabel: '', target: '',
      spark: Object.assign(TYPES.kpi.make().spark, { on: false }) })));
    if (ms.length && o.by) P.blocks.push(newBlock(P, 'bar', {
      span: 12, title: `${ms[0]} by ${o.by}`, subtitle: '', src: `VALUES('Data'[${o.by}])`, label: `'Data'[${o.by}]`,
      value: `[${ms[0]}]`, fmt: '#,0', marker: '', top: '10' }));
    P.fields = ms.map((name) => `[${name}] = `).join('\n');
    return P;
  };
  window.msColSift = { render, dax: (P) => buildMeasure(normalizeProject(clone(P)), { dax: true }).dax, refs, blocks, starter };
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || !m.ms) return;
    try {
      if (m.type === 'render') {
        send({ type: 'html', id: m.id, html: render(m.project, m.live) });
      } else if (m.type === 'dax') {
        send({ type: 'dax', id: m.id, dax: buildMeasure(normalizeProject(clone(m.project)), { dax: true }).dax });
      } else if (m.type === 'load') {
        UI.P = normalizeProject(clone(m.project || defaultProject()));
        if (m.fields && m.fields.length) mergeFields(UI.P, m.fields);
        if (m.name) UI.P.settings.name = m.name;
        setLive(m.live, null);
        UI.sel = UI.P.blocks.length ? { k: 'block', id: UI.P.blocks[0].id } : { k: 'canvas' };
        UI.undo = []; UI.redo = []; UI.lastSnap = JSON.stringify(UI.P);
        renderEverything();
      } else if (m.type === 'live') {
        setLive(m.live, null);
        schedule(0);
      }
    } catch (err) {
      send({ type: 'error', id: m.id, error: String((err && err.message) || err) });
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    if (mode === 'edit') {
      const acts = document.querySelector('.top .acts');
      if (acts) {
        const mk = (label, cls, fn) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b; };
        acts.prepend(mk('Cancel', '', () => send({ type: 'close' })));
        acts.appendChild(mk('Use in ColSift', 'primary', () => send({ type: 'save', project: UI.P })));
      }
    }
    send({ type: 'ready', mode });
  });
})();
</script>
"""


def build(src: Path, dst: Path) -> None:
    s = src.read_text(encoding="utf-8")
    if "ColSift live data" in s:
        raise SystemExit(f"{src.name} already has the ColSift hooks — give the original Measure Studio file")
    for old, new in PATCHES:
        n = s.count(old)
        if n != 1:
            raise SystemExit(f"Patch not applied ({n} matches) — this Measure Studio version moved:\n  {old[:110]}")
        s = s.replace(old, new)
    anchor = "function mkM(b, dax, env) {"
    if s.count(anchor) != 1:
        raise SystemExit("Could not find mkM() to add the live-data helpers before")
    s = s.replace(anchor, LIVE_JS.lstrip("\n") + anchor)
    end = s.rfind("</body>")          # the page's own; the studio's scripts hold others in strings
    if end < 0:
        raise SystemExit("Could not find </body>")
    s = s[:end] + BRIDGE_JS.lstrip("\n") + s[end:]
    dst.write_text(s, encoding="utf-8")
    print(f"Wrote {dst} ({dst.stat().st_size / 1024:,.0f} KB)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    build(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "studio.html")
