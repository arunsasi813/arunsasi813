/* ============================================================================
   jv-core-1.0.0.js — the Special JV compute core.

   One generic interpreter for a declarative JV spec (the "jvSpec" block of
   special_jv_mapping/<REF>.json). It is the ONLY place the maths of a
   creator-built Special JV lives, so a new JV is a JSON record rather than new
   JavaScript on a shared network folder.

   Three rules govern this file, and a test asserts each of them:
     1. No DOM. It runs in the generated calculator page, inside Reco (so the
        creator's preview is the same arithmetic the page will do) and under
        node (so the fast unit tests need no browser).
     2. No compiling of text. Amounts are a closed grammar parsed by hand
        (Expr, below): no eval, no compiled functions, no property paths, no
        strings. A spec can never run code on a colleague's machine.
     3. Fail closed. A malformed, unknown-version or self-contradicting spec
        produces errors from validateSpec and nothing is computed; a formula
        that cannot be evaluated throws with the entry's label in the message.
        Never a silently wrong posting.

   The value helpers (num, parseRowDate, parsePeriod, fmtMMDDYY, fmtNum) are
   lifted from special_jv_templates/TCH.html so a spec-driven JV and the
   hand-written reference calculator read the same spreadsheet identically.

   Version: the filename carries it. 1.1.0 lands beside 1.0.0 and never
   overwrites it, so a JV keeps running on the engine it was validated against.
   ========================================================================= */
(function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var SPEC_MIN = 1, SPEC_MAX = 1;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* The AEG output column order. Every line carries exactly these 12 keys in
     exactly this order, so a JV's lines drop into the entry preview beside
     generated ones without reordering. */
  var LINE_ORDER = ['Reference', 'RC', 'Nominal', 'SubNominal', 'Analysis Key',
                    'LOB', 'Cur', 'Reco', 'Dr', 'Cr', 'Doc', 'Desc'];

  var AGG_FNS = ['sum', 'absSum', 'count', 'min', 'max'];
  var CHECK_KINDS = ['fieldValid', 'fieldOrder', 'fieldEmpty', 'unassignedRows',
                     'noLines', 'balancePerCurrency'];
  var COL_TYPES = ['text', 'number', 'date'];
  var REF_RE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
  var RESERVED_REF = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  var has = function (o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); };
  var str = function (v) { return String(v == null ? '' : v); };
  /* Array or nothing. Every list in a spec comes out of a JSON file a person
     can hand-edit on the share, so a shape that is neither falsy nor an array
     has to degrade to "empty" and be reported, not throw. */
  var arr = function (v) { return Array.isArray(v) ? v : []; };

  /* ── numbers ───────────────────────────────────────────────────────────────
     1,234.50 · (1,234.50) accounting negative · 1,234.50- trailing minus (SAP)
     · spaces and no-break spaces as thousands separators. */
  function num(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var s = String(v).trim(), neg = false;
    if (!s) return 0;
    if (s.length > 2 && s.charAt(0) === '(' && s.charAt(s.length - 1) === ')') { neg = true; s = s.slice(1, -1).trim(); }
    if (s.length > 1 && s.charAt(s.length - 1) === '-' && s.charAt(0) !== '-') { neg = !neg; s = s.slice(0, -1).trim(); }
    var n = parseFloat(s.replace(/[,\s]/g, ''));   /* \s covers the no-break spaces too */
    if (isNaN(n) || !isFinite(n)) return 0;
    return neg ? -n : n;
  }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function roundN(n, d) {
    var f = Math.pow(10, d | 0);
    return Math.round((Number(n) || 0) * f) / f;
  }
  /* 1,234.50 — grouped by hand so the digits never change with the machine's
     locale (toLocaleString was the one place a European Windows differed). */
  function fmtNum(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    var neg = v < 0;
    var s = Math.abs(v).toFixed(2);
    var dot = s.indexOf('.');
    var whole = s.slice(0, dot), frac = s.slice(dot);
    return (neg ? '-' : '') + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + frac;
  }
  function fmtInt(n) {
    var v = Math.round(Number(n));
    if (!isFinite(v)) return '0';
    return (v < 0 ? '-' : '') + Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  /* True when a value looks like a number — the same test Reco's FilterOps
     uses, so a condition means the same thing in both places. */
  function isNumeric(v) {
    if (v == null) return false;
    if (typeof v === 'number') return isFinite(v);
    var s = String(v).trim();
    return /^\(?[-+]?[\d,\s]*\.?\d+\)?-?$/.test(s) && /\d/.test(s);
  }

  /* ── dates ──────────────────────────────────────────────────────────────── */
  function mkDate(y, m, d) {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    var dt = new Date(y, m - 1, d);
    return (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) ? dt : null;
  }
  function excelSerial(n) {
    if (!isFinite(n)) return null;
    var d = new Date(1899, 11, 30);
    d.setDate(d.getDate() + Math.floor(n));
    return isNaN(d.getTime()) ? null : d;
  }
  /* A date in a source row: day-first like Reco (DD/MM/YY), falling back to
     MM/DD when the first part cannot be a day; ISO; DD-MMM-YY; Excel serials,
     including a serial that came back from a CSV as text. Impossible dates
     (31/02) are null rather than rolling into March. Deliberately strict: it
     never guesses with the platform date parser, so "is this a date?" has one
     answer everywhere. */
  function parseRowDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') return excelSerial(v);
    var s = String(v).trim(), m;
    if (!s) return null;
    if (/^\d{5}(\.\d+)?$/.test(s)) { var n = parseFloat(s); if (n > 20000 && n < 80000) return excelSerial(n); }
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return mkDate(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (m) { var y = +m[3]; if (y < 100) y += 2000; return mkDate(y, +m[2], +m[1]) || mkDate(y, +m[1], +m[2]); }
    m = s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3})[A-Za-z]*\.?[\s\-\/,]+(\d{2,4})$/);
    if (m) {
      var mi = -1;
      for (var i = 0; i < 12; i++) if (MONTHS[i].toLowerCase() === m[2].toLowerCase()) mi = i;
      if (mi >= 0) { var y2 = +m[3]; if (y2 < 100) y2 += 2000; return mkDate(y2, mi + 1, +m[1]); }
    }
    return null;
  }
  /* The looser parse Reco's U.parseDate performs, used ONLY by date
     conditions so that `op: 'before'` here and in a Reco report filter agree
     on exotic notations too. Row arithmetic (classification, auto-assign,
     presets) uses parseRowDate, which is what TCH.html does. */
  function parseAnyDate(v) {
    var d = parseRowDate(v);
    if (d) return d;
    if (v == null || v === '' || typeof v === 'number' || v instanceof Date) return null;
    var g = new Date(String(v).trim());
    return isNaN(g.getTime()) ? null : g;
  }
  /* Strict sniffer, matching Reco's U.looksLikeDate: true only for the
     notations parseRowDate recognises explicitly. */
  function looksLikeDate(v) {
    if (v == null || v === '') return false;
    if (v instanceof Date) return !isNaN(v.getTime());
    if (typeof v === 'number') return v > 20000 && v < 80000;
    var s = String(v).trim();
    if (!s) return false;
    if (/^\d{5}(\.\d+)?$/.test(s)) { var n = parseFloat(s); return n > 20000 && n < 80000; }
    if (!/^\d{4}-\d{1,2}-\d{1,2}/.test(s)
        && !/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(s)
        && !/^\d{1,2}[\s\-\/][A-Za-z]{3}[A-Za-z]*\.?[\s\-\/,]+\d{2,4}$/.test(s)) return false;
    return !!parseRowDate(s);
  }
  /* What the user types into a period field: MM/DD/YY (what the presets
     write), or ISO. Month-first, unlike a row date — this is the declared
     format of the field, not a guess about someone's spreadsheet. */
  function parsePeriod(v, fmt) {
    var s = str(v).trim(), m;
    if (!s) return null;
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return mkDate(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
    if (m) {
      var y = +m[3]; if (y < 100) y += 2000;
      if (fmt === 'DD/MM/YY') return mkDate(y, +m[2], +m[1]);
      return mkDate(y, +m[1], +m[2]);
    }
    return null;
  }
  function p2(n) { var s = String(n); return s.length < 2 ? '0' + s : s; }
  function fmtMMDDYY(d) {
    return d ? p2(d.getMonth() + 1) + '/' + p2(d.getDate()) + '/' + String(d.getFullYear()).slice(-2) : '';
  }
  function fmtDateFmt(d, fmt) {
    if (!d) return '';
    if (fmt === 'DD/MM/YY') return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(-2);
    if (fmt === 'YYYY-MM-DD') return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    return fmtMMDDYY(d);
  }
  /* "DD MMM YY" style patterns for narration. */
  function fmtDatePattern(d, pat) {
    if (!d) return '';
    return str(pat).replace(/YYYY|MMM|DD|YY/g, function (t) {
      if (t === 'DD') return p2(d.getDate());
      if (t === 'MMM') return MONTHS[d.getMonth()];
      if (t === 'YYYY') return String(d.getFullYear());
      return String(d.getFullYear()).slice(-2);
    });
  }
  function lastDay(y, mi) { return new Date(y, mi + 1, 0).getDate(); }

  /* ── Expr — the formula language ────────────────────────────────────────────
     expr    := term (('+'|'-') term)*
     term    := unary (('*'|'/') unary)*
     unary   := ('-'|'+')? primary
     primary := number | '(' expr ')' | fn '(' args ')' | NAME
     NAME    := [A-Za-z_][A-Za-z0-9_]*     -- no dots, no brackets, no strings
     fn      := abs min max round round2 neg ifpos ifneg

     A NAME is resolved against a scope built from the spec's own declarations
     (every aggregate id, every field id, @rowsUsed). An unknown name is an
     error at save time (validateSpec walks Expr.refs) and again at run time.
     There is no way to reach a host object, a property or a string from here,
     which is the whole safety argument for letting a user type an amount. */
  var FUNCS = {
    abs:    function (a) { return Math.abs(a[0]); },
    min:    function (a) { return Math.min.apply(null, a); },
    max:    function (a) { return Math.max.apply(null, a); },
    round:  function (a) { return roundN(a[0], a.length > 1 ? a[1] : 0); },
    round2: function (a) { return round2(a[0]); },
    neg:    function (a) { return -a[0]; },
    ifpos:  function (a) { return a[0] > 0 ? a[0] : 0; },
    ifneg:  function (a) { return a[0] < 0 ? a[0] : 0; }
  };
  var FUNC_ARITY = { abs: 1, min: 0, max: 0, round: 2, round2: 1, neg: 1, ifpos: 1, ifneg: 1 };
  var MAX_FORMULA = 500, MAX_TOKENS = 400;

  var Expr = {
    funcs: Object.keys(FUNCS),
    tokenize: function (src) {
      if (typeof src !== 'string') throw new Error('the amount must be text');
      if (!src.trim()) throw new Error('the amount is empty');
      if (src.length > MAX_FORMULA) throw new Error('formula longer than ' + MAX_FORMULA + ' characters');
      var out = [], i = 0;
      var re = /\s+|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([+\-*/(),])/g;
      while (i < src.length) {
        re.lastIndex = i;
        var m = re.exec(src);
        if (!m || m.index !== i) throw new Error('unexpected character "' + src.charAt(i) + '" at ' + i);
        i = re.lastIndex;
        if (m[1] != null) out.push({ t: 'num', v: parseFloat(m[1]) });
        else if (m[2] != null) out.push({ t: 'id', v: m[2] });
        else if (m[3] != null) out.push({ t: m[3] });
        if (out.length > MAX_TOKENS) throw new Error('formula too complex (over ' + MAX_TOKENS + ' tokens)');
      }
      return out;
    },
    parse: function (src) {
      var tk = Expr.tokenize(src), p = 0;
      function peek() { return tk[p]; }
      function eat(t) { if (!tk[p] || tk[p].t !== t) throw new Error('expected "' + t + '"'); return tk[p++]; }
      function expr() {
        var n = term();
        while (peek() && (peek().t === '+' || peek().t === '-')) { var op = tk[p++].t; n = { op: op, l: n, r: term() }; }
        return n;
      }
      function term() {
        var n = unary();
        while (peek() && (peek().t === '*' || peek().t === '/')) { var op = tk[p++].t; n = { op: op, l: n, r: unary() }; }
        return n;
      }
      function unary() {
        if (peek() && (peek().t === '-' || peek().t === '+')) { var op = tk[p++].t; return { op: op === '-' ? 'neg' : 'pos', l: unary() }; }
        return primary();
      }
      function primary() {
        var t = peek();
        if (!t) throw new Error('unexpected end of formula');
        if (t.t === 'num') { p++; return { op: 'num', v: t.v }; }
        if (t.t === '(') { p++; var n = expr(); eat(')'); return n; }
        if (t.t === 'id') {
          p++;
          if (peek() && peek().t === '(') {
            var fn = t.v;
            if (!has(FUNCS, fn)) throw new Error('unknown function "' + fn + '"');
            p++;
            var args = [];
            if (peek() && peek().t !== ')') {
              args.push(expr());
              while (peek() && peek().t === ',') { p++; args.push(expr()); }
            }
            eat(')');
            if (!args.length) throw new Error('"' + fn + '" needs at least one value');
            if (FUNC_ARITY[fn] && args.length > FUNC_ARITY[fn]) throw new Error('"' + fn + '" takes at most ' + FUNC_ARITY[fn] + ' value(s)');
            return { op: 'call', fn: fn, args: args };
          }
          return { op: 'ref', v: t.v };
        }
        throw new Error('unexpected "' + t.t + '" in formula');
      }
      var node = expr();
      if (p !== tk.length) throw new Error('trailing input in formula');
      return node;
    },
    /* Every name the formula mentions, without evaluating it: this is what
       validateSpec checks against the spec's own declarations. */
    refs: function (n, out) {
      out = out || [];
      if (!n) return out;
      if (n.op === 'ref') out.push(n.v);
      if (n.l) Expr.refs(n.l, out);
      if (n.r) Expr.refs(n.r, out);
      for (var i = 0; i < (n.args || []).length; i++) Expr.refs(n.args[i], out);
      return out;
    },
    evalNode: function (n, scope) {
      switch (n.op) {
        case 'num': return n.v;
        case 'neg': return -Expr.evalNode(n.l, scope);
        case 'pos': return +Expr.evalNode(n.l, scope);
        case '+': return Expr.evalNode(n.l, scope) + Expr.evalNode(n.r, scope);
        case '-': return Expr.evalNode(n.l, scope) - Expr.evalNode(n.r, scope);
        case '*': return Expr.evalNode(n.l, scope) * Expr.evalNode(n.r, scope);
        case '/': {
          var d = Expr.evalNode(n.r, scope);
          /* A silently-zero charge line is a wrong posting, which is worse
             than a refusal. */
          if (d === 0) throw new Error('division by zero');
          return Expr.evalNode(n.l, scope) / d;
        }
        case 'call': {
          var args = [];
          for (var i = 0; i < n.args.length; i++) args.push(Expr.evalNode(n.args[i], scope));
          return FUNCS[n.fn](args);
        }
        case 'ref': {
          if (!has(scope, n.v)) throw new Error('unknown name "' + n.v + '"');
          var v = scope[n.v];
          return typeof v === 'number' ? v : num(v);
        }
      }
      throw new Error('bad formula node');
    },
    evaluate: function (src, scope) { return Expr.evalNode(Expr.parse(src), scope); }
  };

  /* ── reading a column off a row ─────────────────────────────────────────── */
  var normKey = function (s) { return String(s).toLowerCase().replace(/[\s_\-]/g, ''); };
  function colDef(spec, id) {
    var cols = (spec && spec.columns) || [];
    for (var i = 0; i < cols.length; i++) if (cols[i].id === id) return cols[i];
    return null;
  }
  /* Every spelling this column accepts. ALL of them must also be in the
     mapping's inputColumns, because Reco projects only the names declared
     there — an alias that is missing arrives blank (validateSpec refuses it). */
  function names(c) {
    var out = [];
    if (c && c.label) out.push(c.label);
    arr(c && c.accept).forEach(function (n) { if (n) out.push(n); });
    return out;
  }
  function raw(row, c) {
    var cand = names(c), i, k;
    for (i = 0; i < cand.length; i++) if (row[cand[i]] != null && row[cand[i]] !== '') return row[cand[i]];
    var keys = Object.keys(row || {});
    for (i = 0; i < cand.length; i++) {
      var want = normKey(cand[i]);
      for (k = 0; k < keys.length; k++) {
        if (normKey(keys[k]) === want && row[keys[k]] != null && row[keys[k]] !== '') return row[keys[k]];
      }
    }
    return '';
  }
  function normalizeText(c, v) {
    var s = str(v);
    arr(c && c.normalize).forEach(function (n) {
      if (n === 'trim') s = s.trim();
      else if (n === 'upper') s = s.toUpperCase();
      else if (n === 'lower') s = s.toLowerCase();
    });
    return s;
  }
  /* The typed value: a number for a number column, a Date (or null) for a date
     column, the normalized string otherwise. */
  function cell(spec, row, id) {
    var c = colDef(spec, id);
    if (!c) return '';
    var v = raw(row, c);
    if (c.type === 'number') return num(v);
    if (c.type === 'date') return parseRowDate(v);
    return normalizeText(c, v);
  }
  /* The same value as text, for the condition evaluator and for display. */
  function cellText(spec, row, id) {
    var c = colDef(spec, id);
    if (!c) return '';
    var v = raw(row, c);
    if (c.type === 'text') return normalizeText(c, v);
    return str(v).trim();
  }
  function kindOfCol(c) { return !c ? 'text' : (c.type === 'number' ? 'value' : (c.type === 'date' ? 'date' : 'text')); }

  /* ── conditions: FilterOps' 22 operators, same semantics ────────────────────
     Reco's FilterOps (MODULE 2c) is the single source of truth for what an
     operator means; it cannot be loaded here (the page has no Reco), so its
     algorithm is reproduced: the declared column type decides whether a
     comparison is a date, an amount or text, exactly as FilterOps.kindOf +
     _cmpMode do. A test drives this core and the real FilterOps over the same
     corpus and asserts they agree. */
  function cmpMode(kind, a, b) {
    if (kind === 'date') return 'date';
    if (kind === 'value') return 'num';
    var given = [], i;
    [a, b].forEach(function (x) { if (x != null && String(x).trim() !== '') given.push(x); });
    if (!given.length) return 'num';
    for (i = 0; i < given.length; i++) if (isNumeric(given[i]) || !looksLikeDate(given[i])) return 'num';
    return 'date';
  }
  function nOf(x) {
    if (x == null || String(x).trim() === '') return NaN;
    return isNumeric(x) ? num(x) : parseFloat(x);
  }
  function cmp(v, q, kind, test) {
    if (cmpMode(kind, q) === 'date') {
      var a = parseAnyDate(v), b = parseAnyDate(q);
      return a && b ? test(a.getTime(), b.getTime()) : false;
    }
    if (!isNumeric(v) && looksLikeDate(v)) return false;
    return test(nOf(v), nOf(q));
  }
  function between(v, lo, hi, kind) {
    if (cmpMode(kind, lo, hi) === 'date') {
      var a = parseAnyDate(v), l = parseAnyDate(lo), h = parseAnyDate(hi);
      if (!a || !l || !h) return false;
      var t = a.getTime();
      return t >= Math.min(l.getTime(), h.getTime()) && t <= Math.max(l.getTime(), h.getTime());
    }
    if (!isNumeric(v) && looksLikeDate(v)) return false;
    var an = nOf(v), ln = nOf(lo), hn = nOf(hi);
    return an >= Math.min(ln, hn) && an <= Math.max(ln, hn);
  }
  function eq(v, q, kind) {
    var dateish = function (x) { return !isNumeric(x) && looksLikeDate(x); };
    if (kind === 'date' || (kind !== 'value' && dateish(v) && dateish(q))) {
      var a = parseAnyDate(v), b = parseAnyDate(q);
      if (a && b) return a.getTime() === b.getTime();
    } else if (kind === 'value') {
      if (isNumeric(v) && isNumeric(q)) return num(v) === num(q);
    }
    return str(v).toLowerCase() === str(q).toLowerCase();
  }
  function inList(v, val, kind) {
    var raws = str(val);
    /* On an amount column a comma can be a thousands separator OR a list
       separator: '1,234.50' is one amount, '1,234.50, -50' is two. */
    var parts = (kind === 'value' ? raws.split(/,(?!\d{3}(?:\D|$))/) : raws.split(','));
    for (var i = 0; i < parts.length; i++) {
      var q = parts[i].trim();
      if (q && eq(v, q, kind)) return true;
    }
    return false;
  }
  var OPS = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'not_starts_with',
             'ends_with', 'not_ends_with', 'greater', 'greater_eq', 'less', 'less_eq',
             'between', 'not_between', 'before', 'after', 'on_or_before', 'on_or_after',
             'empty', 'not_empty', 'in_list', 'not_in_list', 'date_between'];
  /* One condition against one row. {kind}/{kindIn} conditions are the
     classification filter and are handled by the caller (they do not read a
     column), so they answer true here. */
  function testCond(spec, row, cond) {
    if (!cond) return true;
    if (cond.kind != null || cond.kindIn) return true;
    var c = colDef(spec, cond.col);
    if (!c) throw new Error('condition names unknown column "' + str(cond.col) + '"');
    var kind = kindOfCol(c);
    var v = cellText(spec, row || {}, cond.col);
    var a = cond.val, a2 = cond.val2;
    var lv = v.toLowerCase(), lq = str(a).toLowerCase();
    switch (cond.op) {
      case 'equals':           return eq(v, a, kind);
      case 'not_equals':       return !eq(v, a, kind);
      case 'contains':         return lv.indexOf(lq) >= 0;
      case 'not_contains':     return lv.indexOf(lq) < 0;
      case 'starts_with':      return lv.lastIndexOf(lq, 0) === 0;
      case 'not_starts_with':  return lv.lastIndexOf(lq, 0) !== 0;
      case 'ends_with':        return lq.length <= lv.length && lv.indexOf(lq, lv.length - lq.length) !== -1;
      case 'not_ends_with':    return !(lq.length <= lv.length && lv.indexOf(lq, lv.length - lq.length) !== -1);
      case 'greater':          return cmp(v, a, kind, function (x, y) { return x > y; });
      case 'greater_eq':       return cmp(v, a, kind, function (x, y) { return x >= y; });
      case 'less':             return cmp(v, a, kind, function (x, y) { return x < y; });
      case 'less_eq':          return cmp(v, a, kind, function (x, y) { return x <= y; });
      case 'between':          return between(v, a, a2, kind);
      case 'not_between':      return !between(v, a, a2, kind);
      case 'before':           { var d1 = parseAnyDate(v), b1 = parseAnyDate(a); return !!(d1 && b1) && d1.getTime() < b1.getTime(); }
      case 'after':            { var d2 = parseAnyDate(v), b2 = parseAnyDate(a); return !!(d2 && b2) && d2.getTime() > b2.getTime(); }
      case 'on_or_before':     { var d3 = parseAnyDate(v), b3 = parseAnyDate(a); return !!(d3 && b3) && d3.getTime() <= b3.getTime(); }
      case 'on_or_after':      { var d4 = parseAnyDate(v), b4 = parseAnyDate(a); return !!(d4 && b4) && d4.getTime() >= b4.getTime(); }
      case 'empty':            return !v;
      case 'not_empty':        return !!v;
      case 'in_list':          return inList(v, a, kind);
      case 'not_in_list':      return !inList(v, a, kind);
      case 'date_between':     return between(v, a, a2, 'date');
    }
    throw new Error('unknown operator "' + str(cond.op) + '"');
  }

  /* "{currency|no currency}" — a column value, or the fallback when it is
     empty. Used by the ignore reasons, which the user writes. */
  function fillRowTokens(spec, tpl, row) {
    return str(tpl).replace(/\{([A-Za-z0-9_]+)(\|([^}]*))?\}/g, function (m, id, _x, fb) {
      var c = colDef(spec, id);
      if (!c) return m;
      var v = cell(spec, row, id);
      if (c.type === 'date') v = v ? fmtMMDDYY(v) : '';
      if (v === '' || v == null || (typeof v === 'number' && !isFinite(v))) return fb != null ? fb : '';
      return String(v);
    });
  }

  /* ── classification: a flat ordered rule list, first match wins ─────────── */
  function classify(spec, row) {
    var cols = (spec && spec.columns) || [], i;
    var curCol = null, amtCol = null;
    for (i = 0; i < cols.length; i++) {
      if (cols[i].role === 'currency' && !curCol) curCol = cols[i];
      if (cols[i].role === 'amount' && !amtCol) amtCol = cols[i];
    }
    var cur = curCol ? str(cell(spec, row, curCol.id)) : '';
    var amt = amtCol ? num(cell(spec, row, amtCol.id)) : 0;
    var rules = ((spec && spec.classify) || {}).rules || [];
    for (i = 0; i < rules.length; i++) {
      var r = rules[i], all = r.all || [], ok = true;
      for (var j = 0; j < all.length; j++) { if (!testCond(spec, row, all[j])) { ok = false; break; } }
      if (!ok) continue;
      if (r.kind === '@skip') {
        return { kind: '@skip', why: fillRowTokens(spec, r.reason || 'ignored', row), rule: r.id || null, cur: cur, amt: amt };
      }
      return { kind: r.kind, label: kindLabel(spec, r.kind), why: '', rule: r.id || null, cur: cur, amt: amt };
    }
    var fb = ((spec && spec.classify) || {}).fallbackReason || 'no rule matched';
    return { kind: '@skip', why: fillRowTokens(spec, fb, row), rule: null, cur: cur, amt: amt };
  }
  function kindLabel(spec, id) {
    var ks = (spec && spec.kinds) || [];
    for (var i = 0; i < ks.length; i++) if (ks[i].id === id) return ks[i].label || ks[i].id;
    return id;
  }
  function kindStyle(spec, id) {
    var ks = (spec && spec.kinds) || [];
    for (var i = 0; i < ks.length; i++) if (ks[i].id === id) return ks[i].style || '';
    return '';
  }

  /* ── presets: date slots per month found in the data ───────────────────── */
  function presets(spec, rows) {
    var p = ((spec && spec.sections) || {}).presets;
    if (!p || p.kind !== 'dateSlots') return [];
    var seen = {}, keys = [];
    (rows || []).forEach(function (r) {
      var d = cell(spec, r, p.column);
      if (d) { var k = d.getFullYear() + '-' + d.getMonth(); if (!seen[k]) { seen[k] = 1; keys.push(k); } }
    });
    keys = keys.map(function (s) { var a = s.split('-'); return [+a[0], +a[1]]; })
               .sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); });
    var out = [];
    keys.forEach(function (ym) {
      var y = ym[0], mi = ym[1], eom = lastDay(y, mi);
      arr(p.slots).forEach(function (sl) {
        var end = sl.end === 'eom' ? eom : sl.end;
        var start = sl.start === 'eom' ? eom : sl.start;
        var slot = str(sl.label).split('{eom}').join(String(eom));
        out.push({
          label: str(p.optionLabel || '{slot} {MMM} {YYYY}')
                   .split('{slot}').join(slot)
                   .split('{MMM}').join(MONTHS[mi])
                   .split('{YYYY}').join(String(y)),
          from: fmtDateFmt(new Date(y, mi, start), p.valueFormat),
          to: fmtDateFmt(new Date(y, mi, end), p.valueFormat)
        });
      });
    });
    return out;
  }

  function newSection(spec, n) {
    var fields = {};
    arr(spec && spec.fields).forEach(function (f) { fields[f.id] = f['default'] != null ? str(f['default']) : ''; });
    return { id: n, n: n, group: '', preset: '', fields: fields };
  }

  /* The "Auto-assign by period" button: every classified row goes into the
     section whose period contains its date. Rows with no readable date are
     left where they are and counted, so nothing moves silently. */
  function autoAssign(spec, rows, classes, sections, assignments) {
    var a = ((spec && spec.sections) || {}).autoAssign;
    if (!a) return { assigned: 0, nodate: 0 };
    var fmt = (((spec.sections || {}).presets) || {}).valueFormat;
    var ranges = [];
    (sections || []).forEach(function (s) {
      var f = parsePeriod(s.fields[a.from], fmt), t = parsePeriod(s.fields[a.to], fmt);
      if (f && t) ranges.push({ id: s.id, f: f, t: t });
    });
    if (!ranges.length) return { noRange: true, assigned: 0, nodate: 0 };
    var assigned = 0, nodate = 0;
    (rows || []).forEach(function (row, i) {
      if (classes[i].kind === '@skip') return;
      var d = cell(spec, row, a.column);
      if (!d) { nodate++; return; }
      var hit = null;
      for (var k = 0; k < ranges.length; k++) if (d >= ranges[k].f && d <= ranges[k].t) { hit = ranges[k]; break; }
      assignments[i] = hit ? hit.id : 0;
      if (hit) assigned++;
    });
    return { assigned: assigned, nodate: nodate };
  }
  /* Takes the spec it does not read yet, so every entry point here has the
     same shape; eligibility is "a rule classified it", which classes says. */
  function assignAll(spec, rows, classes, assignments, sectionId) {
    var n = 0;
    (rows || []).forEach(function (row, i) {
      if (classes[i].kind === '@skip') return;
      assignments[i] = sectionId || 0; n++;
    });
    return n;
  }

  /* ── aggregates: the figures computed from the rows, per section ────────── */
  function matchWhere(spec, row, cls, where) {
    var w = where || [];
    for (var i = 0; i < w.length; i++) {
      var c = w[i];
      if (c.kind != null) { if (cls.kind !== c.kind) return false; continue; }
      if (c.kindIn) { if (c.kindIn.indexOf(cls.kind) < 0) return false; continue; }
      if (!testCond(spec, row, c)) return false;
    }
    return true;
  }
  function aggregates(spec, rows, classes, assignments, sectionId) {
    var out = {}, used = [];
    (rows || []).forEach(function (row, i) {
      if (assignments[i] === sectionId && classes[i].kind !== '@skip') used.push(i);
    });
    arr(spec && spec.aggregates).forEach(function (ag) {
      var vals = [];
      used.forEach(function (i) {
        if (matchWhere(spec, rows[i], classes[i], ag.where)) vals.push(ag.of ? num(cell(spec, rows[i], ag.of)) : 1);
      });
      var v = 0, k;
      switch (ag.fn) {
        case 'sum':    for (k = 0; k < vals.length; k++) v += vals[k]; break;
        case 'absSum': for (k = 0; k < vals.length; k++) v += Math.abs(vals[k]); break;
        case 'count':  v = vals.length; break;
        case 'min':    v = vals.length ? Math.min.apply(null, vals) : 0; break;
        case 'max':    v = vals.length ? Math.max.apply(null, vals) : 0; break;
        default: throw new Error('unknown aggregate function "' + str(ag.fn) + '"');
      }
      out[ag.id] = v;
    });
    out['@rowsUsed'] = used.length;
    return { values: out, rowIdx: used };
  }

  /* ── narration ─────────────────────────────────────────────────────────── */
  function remark(spec, name, section, ctx) {
    var t = (((spec && spec.remarks) || {}).templates || {})[name];
    if (t == null) throw new Error('unknown narration "' + str(name) + '"');
    var s = str(t);
    var ranges = ((spec.remarks || {}).ranges) || {};
    var fmt = (((spec.sections || {}).presets) || {}).valueFormat;
    Object.keys(ranges).forEach(function (rid) {
      var r = ranges[rid];
      var f = parsePeriod(section.fields[r.from], fmt), to = parsePeriod(section.fields[r.to], fmt);
      var txt = r.invalid != null ? r.invalid : '<period>';
      if (f && to) {
        txt = str(r.pattern)
          .replace(/\{from:([^}]+)\}/g, function (m, p) { return fmtDatePattern(f, p); })
          .replace(/\{to:([^}]+)\}/g, function (m, p) { return fmtDatePattern(to, p); });
      }
      s = s.split('{' + rid + '}').join(txt);
    });
    s = s.replace(/\{([A-Za-z0-9_@]+)\}/g, function (m, k) {
      if (k === 'n') return String(ctx.n);
      if (k === 'section') return ctx.sectionTitle;
      if (k === 'token') return ctx.token;
      if (k === 'reco') return ctx.reco;
      if (k === 'cur') return ctx.cur || '';
      if (has(section.fields, k)) return str(section.fields[k]);
      if (has(ctx.agg, k)) return fmtNum(ctx.agg[k]);
      return m;
    });
    return s;
  }

  /* ── entry expansion: forEachCurrency is a STATIC pre-pass ──────────────────
     One entry becomes N entries before anything is evaluated or linted, so the
     creator can lint and preview a fixed set of postings. A variable number of
     lines discovered at run time could be neither. */
  function expandEntries(spec) {
    var out = [];
    arr(spec && spec.entries).forEach(function (en) {
      var list = en.forEachCurrency;
      if (!Array.isArray(list) || !list.length) { out.push(en); return; }
      list.forEach(function (cur) {
        var sub = function (s) { return str(s).split('{cur}').join(cur); };
        var copy = {};
        Object.keys(en).forEach(function (k) { copy[k] = en[k]; });
        copy.id = en.id + '_' + cur;
        copy.label = sub(en.label);
        copy.amount = sub(en.amount);
        copy.dr = sub(en.dr);
        copy.cr = sub(en.cr);
        copy.cur = cur;
        copy._from = en.id;
        delete copy.forEachCurrency;
        out.push(copy);
      });
    });
    return out;
  }

  /* ── lines ─────────────────────────────────────────────────────────────── */
  function slotOf(def, id) {
    var a = (def && def.accounts) || {};
    var s = has(a, id) ? a[id] : null;
    if (!s || !s.nominal) throw new Error('account slot "' + str(id) + '" has no nominal in the mapping\'s "accounts" block');
    return { nominal: str(s.nominal), rc: str(s.rc) };
  }
  function mkLine(def, acct, cur, dr, cr, reco, desc) {
    var a = (def && def.accounts) || {};
    var o = {};
    o.Reference = str(a.reference);
    o.RC = acct.rc;
    o.Nominal = acct.nominal;
    o.SubNominal = str(a.subNominal);
    o['Analysis Key'] = str(a.analysisKey);
    o.LOB = str(a.lob);
    o.Cur = cur;
    o.Reco = reco;
    o.Dr = dr;
    o.Cr = cr;
    o.Doc = str(a.doc);
    o.Desc = desc;
    return o;
  }
  /* The whole posting contract, in one place:
       1. the section's aggregates, plus every field as a number, plus
          @rowsUsed, make the scope a formula may read.
       2. each expanded entry's amount is parsed and evaluated; a parse, name
          or arithmetic error throws with the entry's label.
       3. |amount| is rounded, and an entry below minAbs posts NOTHING.
       4. a negative amount swaps the two accounts (swapOnNegative).
       5. two lines are pushed, with the 12 AEG keys in order.
       6. primaryKeys = the rows assigned to this section that a rule actually
          classified. A row dropped into a section by hand that the rules
          ignore contributes nothing, so it is NOT reported as used — the docs
          say only rows a JV actually used may be closed. */
  function buildSection(def, spec, rows, classes, assignments, section, idx) {
    var ed = (spec && spec.entryDefaults) || {};
    var dp = ed.round == null ? 2 : (ed.round | 0);
    var minAbs = ed.minAbs == null ? 0.01 : Number(ed.minAbs);
    var ag = aggregates(spec, rows, classes, assignments, section.id);
    var n = idx + 1;
    var sec = (spec && spec.sections) || {};
    var rf = sec.recoFrom || {};
    var reco = str(section.fields[rf.field]).trim() || str(rf['default']).split('{n}').join(String(n));
    var scope = {};
    Object.keys(ag.values).forEach(function (k) { scope[k] = ag.values[k]; });
    arr(spec && spec.fields).forEach(function (f) { scope[f.id] = num(section.fields[f.id]); });
    var ctx = {
      n: n,
      sectionTitle: str(sec.title || '{n}').split('{n}').join(String(n)),
      token: str(sec.token || 'T{n}').split('{n}').join(String(n)),
      reco: reco,
      agg: ag.values
    };
    var lines = [];
    expandEntries(spec).forEach(function (en) {
      var amt;
      try { amt = Expr.evalNode(Expr.parse(en.amount), scope); }
      catch (e) { throw new Error('entry "' + str(en.label || en.id) + '": ' + e.message); }
      if (typeof amt !== 'number' || !isFinite(amt)) throw new Error('entry "' + str(en.label || en.id) + '": the amount is not a finite number');
      var a = roundN(Math.abs(amt), dp);
      if (!(a >= minAbs)) return;
      var swap = (ed.swapOnNegative !== false) && amt < 0;
      var drS = slotOf(def, swap ? en.cr : en.dr);
      var crS = slotOf(def, swap ? en.dr : en.cr);
      var txt = a.toFixed(dp);
      var desc = remark(spec, en.remark, section, { n: ctx.n, sectionTitle: ctx.sectionTitle, token: ctx.token, reco: ctx.reco, agg: ctx.agg, cur: en.cur });
      lines.push(mkLine(def, drS, en.cur, txt, '', reco, desc));
      lines.push(mkLine(def, crS, en.cur, '', txt, reco, desc));
    });
    var pks = [], seen = {};
    (rows || []).forEach(function (r, i) {
      if (assignments[i] === section.id && classes[i].kind !== '@skip' && r && r._pk && !seen[r._pk]) {
        seen[r._pk] = 1; pks.push(r._pk);
      }
    });
    var fields = {};
    Object.keys(section.fields || {}).forEach(function (k) { fields[k] = section.fields[k]; });
    return { lines: lines, primaryKeys: pks, aggregates: ag.values, reco: reco, n: n,
             section: ctx.token, title: ctx.sectionTitle, fields: fields };
  }
  function buildAll(def, spec, rows, classes, assignments, sections) {
    var lines = [], pks = [], seen = Object.create(null), out = [];
    /* Every figure in a section is selected by `assignments[i] === section.id`,
       so distinct ids are the invariant the whole build rests on - and nothing
       stated it. Two sections sharing one id post each of its rows twice, as
       balanced pairs, so no balance check can notice. Refuse instead. */
    var ids = Object.create(null);
    arr(sections).forEach(function (s) {
      var id = s && s.id;
      if (id == null) throw new Error('a section has no id');
      if (ids[id]) throw new Error('two sections share the id "' + str(id)
        + '" - every amount assigned to it would be posted twice');
      ids[id] = 1;
    });
    arr(sections).forEach(function (s, i) {
      var r = buildSection(def, spec, rows, classes, assignments, s, i);
      r.lines.forEach(function (l) { lines.push(l); });
      r.primaryKeys.forEach(function (p) { if (!seen[p]) { seen[p] = 1; pks.push(p); } });
      out.push(r);
    });
    return { lines: lines, primaryKeys: pks, sections: out };
  }
  function balances(lines) {
    var b = {};
    (lines || []).forEach(function (l) {
      var c = l.Cur || '';
      if (!b[c]) b[c] = { dr: 0, cr: 0 };
      b[c].dr += num(l.Dr);
      b[c].cr += num(l.Cr);
    });
    return b;
  }

  /* ── the checks the page runs before it posts back ──────────────────────── */
  function fieldDef(spec, id) {
    var fs = arr(spec && spec.fields);
    for (var i = 0; i < fs.length; i++) if (fs[i].id === id) return fs[i];
    return null;
  }
  function sectionTitle(spec, idx) {
    return str(((spec && spec.sections) || {}).title || '{n}').split('{n}').join(String(idx + 1));
  }
  function defaultReco(spec, idx) {
    var rf = ((spec && spec.sections) || {}).recoFrom || {};
    return str(rf['default']).split('{n}').join(String(idx + 1));
  }
  /* -> { blocks:[msg], confirms:[msg], built }
     blocks stop the submit (the page shows the first one); confirms are asked
     in order and any "no" abandons the submit. The checks run in the order the
     spec declares them, which is the order the hand-written TCH page uses. */
  function runChecks(def, spec, rows, classes, assignments, sections) {
    var blocks = [], confirms = [], built = null, buildError = null;
    var fmt = (((spec.sections || {}).presets) || {}).valueFormat;
    function ensureBuilt() {
      if (built || buildError) return built;
      try { built = buildAll(def, spec, rows, classes, assignments, sections); }
      catch (e) { buildError = e; blocks.push('This JV could not be computed:\n' + e.message); }
      return built;
    }
    function push(level, msg) { (level === 'confirm' ? confirms : blocks).push(msg); }

    /* A field marked required is enforced whether or not the spec also
       declares a fieldValid check for it: the flag has to mean something, or
       the creator's star beside the label is a lie. */
    (sections || []).forEach(function (s, idx) {
      arr(spec && spec.fields).forEach(function (f) {
        if (!f.required || str(s.fields[f.id]).trim()) return;
        blocks.push(sectionTitle(spec, idx) + ': "' + str(f.label || f.id) + '" is required.');
      });
    });

    arr(spec && spec.validate).forEach(function (v) {
      var level = v.level === 'confirm' ? 'confirm' : 'block';
      var msg = str(v.message);
      if (v.kind === 'fieldValid') {
        (sections || []).forEach(function (s, idx) {
          (v.fields || []).forEach(function (fid) {
            var f = fieldDef(spec, fid);
            var raws = str(s.fields[fid]).trim();
            var bad = (f && (f.type === 'period' || f.type === 'date')) ? !parsePeriod(raws, fmt) : !raws;
            if (bad) push(level, msg.split('{section}').join(sectionTitle(spec, idx))
                                   .split('{field}').join(str((f && f.label) || fid)));
          });
        });
      } else if (v.kind === 'fieldOrder') {
        (sections || []).forEach(function (s, idx) {
          var a = parsePeriod(s.fields[v.from], fmt), b = parsePeriod(s.fields[v.to], fmt);
          if (a && b && a > b) push(level, msg.split('{section}').join(sectionTitle(spec, idx)));
        });
      } else if (v.kind === 'fieldEmpty') {
        var list = [];
        (sections || []).forEach(function (s, idx) { if (!str(s.fields[v.field]).trim()) list.push(defaultReco(spec, idx) || sectionTitle(spec, idx)); });
        if (list.length) push(level, msg.split('{list}').join(list.join(', ')).split('{n}').join(String(list.length)));
      } else if (v.kind === 'unassignedRows') {
        var un = 0;
        (rows || []).forEach(function (r, i) { if (classes[i].kind !== '@skip' && !assignments[i]) un++; });
        if (un) push(level, msg.split('{n}').join(String(un)));
      } else if (v.kind === 'noLines') {
        var b1 = ensureBuilt();
        if (b1 && !b1.lines.length) push(level, msg);
      } else if (v.kind === 'balancePerCurrency') {
        var b2 = ensureBuilt();
        if (b2) {
          var tol = v.tolerance == null ? 0.01 : Number(v.tolerance);
          var bal = balances(b2.lines);
          Object.keys(bal).forEach(function (c) {
            var diff = Math.round((bal[c].dr - bal[c].cr) * 100) / 100;
            if (Math.abs(diff) > tol) {
              push(level, msg.split('{cur}').join(c || '(no currency)')
                             .split('{dr}').join(fmtNum(bal[c].dr))
                             .split('{cr}').join(fmtNum(bal[c].cr))
                             .split('{diff}').join(fmtNum(diff)));
            }
          });
        }
      }
    });
    if (!built && !buildError) ensureBuilt();
    return { blocks: blocks, confirms: confirms, built: built };
  }

  /* ── spec validation: run at save time by the creator AND at boot by the
     page, so a mapping edited by hand on the share still cannot post. ────── */
  function validateSpec(def) {
    var errors = [], warnings = [];
    var spec = def && def.jvSpec;
    if (!def || typeof def !== 'object') return { errors: ['the JV definition is missing'], warnings: warnings };
    if (!spec) return { errors: ['the mapping has no "jvSpec" block — it is not a spec-driven JV'], warnings: warnings };
    var sv = spec.specVersion;
    if (!(sv >= SPEC_MIN && sv <= SPEC_MAX)) {
      return { errors: ['this JV needs spec version ' + str(sv) + '; this calculator understands '
                        + SPEC_MIN + '–' + SPEC_MAX + '. Update Reco on this PC.'], warnings: warnings };
    }
    var refStr = str(def.ref);
    if (!REF_RE.test(refStr)) errors.push('"ref" must be 1–24 characters of letters, digits, _ or -, starting with a letter (got "' + refStr + '")');
    else if (RESERVED_REF.test(refStr)) errors.push('"ref" is a reserved Windows device name ("' + refStr + '")');

    /* A container of the wrong shape reads as empty, which would otherwise be
       indistinguishable from "the author declared none". Say so for each. */
    [['columns', spec.columns, 'no column would be read'],
     ['kinds', spec.kinds, 'no row type would exist'],
     ['classify.rules', ((spec.classify) || {}).rules, 'no row would be classified'],
     ['fields', spec.fields, 'no section field would appear'],
     ['aggregates', spec.aggregates, 'every total would be missing'],
     ['slots', spec.slots, 'no account would be declared'],
     ['entries', spec.entries, 'the JV would post nothing'],
     ['validate', spec.validate, 'every check this JV declares would be skipped, '
                                 + 'including the per-currency balance']
    ].forEach(function (t) {
      if (t[1] != null && !Array.isArray(t[1])) {
        errors.push('"' + t[0] + '" is not a list, so ' + t[2]);
      }
    });
    var colIds = Object.create(null), kinds = Object.create(null), aggIds = Object.create(null),
        fieldIds = Object.create(null), slotIds = Object.create(null);
    kinds['@skip'] = 1;
    var roles = Object.create(null);
    arr(spec.columns).forEach(function (c) {
      if (!c || !c.id || !c.label) { errors.push('every column needs an id and a label'); return; }
      if (colIds[c.id]) errors.push('two columns share the id "' + c.id + '"');
      colIds[c.id] = 1;
      if (COL_TYPES.indexOf(c.type) < 0) errors.push('column "' + c.id + '": type must be text, number or date');
      if (c.role) {
        if (roles[c.role]) errors.push('two columns claim the role "' + c.role + '"');
        roles[c.role] = 1;
      }
    });
    if (!roles.amount) warnings.push('no column is marked as the amount, so the row amounts cannot be shown');
    arr(spec.kinds).forEach(function (k) {
      if (!k || !k.id) { errors.push('every row type needs an id'); return; }
      if (k.id === '@skip') errors.push('"@skip" is reserved and cannot be a row type id');
      kinds[k.id] = 1;
    });
    arr(((spec.classify) || {}).rules).forEach(function (r, i) {
      var where = 'rule ' + (i + 1);
      if (!kinds[r.kind]) errors.push(where + ' targets unknown row type "' + str(r.kind) + '"');
      if (r.kind === '@skip' && !r.reason) warnings.push(where + ' ignores rows without saying why');
      if (!arr(r.all).length) warnings.push(where + ' has no conditions, so it matches every row');
      if (r.all != null && !Array.isArray(r.all)) errors.push(where + ': "all" must be a list of conditions');
      arr(r.all).forEach(function (c) {
        if (!colIds[c.col]) errors.push(where + ' tests unknown column "' + str(c.col) + '"');
        else if (OPS.indexOf(c.op) < 0) errors.push(where + ': unknown operator "' + str(c.op) + '"');
      });
    });
    arr(spec.fields).forEach(function (f) {
      if (!f || !f.id) { errors.push('every section field needs an id'); return; }
      if (fieldIds[f.id] || colIds[f.id]) errors.push('field id "' + f.id + '" is already used');
      fieldIds[f.id] = 1;
    });
    arr(spec.aggregates).forEach(function (a) {
      if (!a || !a.id) { errors.push('every total needs an id'); return; }
      if (aggIds[a.id] || fieldIds[a.id] || colIds[a.id]) errors.push('total id "' + a.id + '" is already used');
      aggIds[a.id] = 1;
      if (AGG_FNS.indexOf(a.fn) < 0) errors.push('total "' + a.id + '": unknown function "' + str(a.fn) + '"');
      if (a.fn !== 'count' && !colIds[a.of]) errors.push('total "' + a.id + '" sums unknown column "' + str(a.of) + '"');
      if (a.where != null && !Array.isArray(a.where)) errors.push('total "' + a.id + '": "where" must be a list of conditions');
      arr(a.where).forEach(function (c) {
        if (c.kind != null && !kinds[c.kind]) errors.push('total "' + a.id + '" filters on unknown row type "' + str(c.kind) + '"');
        if (c.kindIn) (c.kindIn || []).forEach(function (k) { if (!kinds[k]) errors.push('total "' + a.id + '" filters on unknown row type "' + str(k) + '"'); });
        if (c.kind == null && !c.kindIn) {
          if (!colIds[c.col]) errors.push('total "' + a.id + '" tests unknown column "' + str(c.col) + '"');
          else if (OPS.indexOf(c.op) < 0) errors.push('total "' + a.id + '": unknown operator "' + str(c.op) + '"');
        }
      });
    });
    arr(spec.slots).forEach(function (s) {
      if (!s || !s.id) { errors.push('every account slot needs an id'); return; }
      slotIds[s.id] = 1;
      var acc = (def.accounts || {})[s.id];
      /* Account codes live in exactly one place: the mapping's own "accounts"
         block, so the chart of accounts is changed there and nowhere else. */
      if (!acc || !acc.nominal) errors.push('account slot "' + s.id + '" has no nominal in the mapping\'s "accounts" block');
    });
    var scopeNames = Object.create(null);
    Object.keys(aggIds).forEach(function (k) { scopeNames[k] = 1; });
    Object.keys(fieldIds).forEach(function (k) { scopeNames[k] = 1; });
    scopeNames['@rowsUsed'] = 1;

    var sec = spec.sections || {};
    if (sec.mode && ['manual', 'byColumn', 'single'].indexOf(sec.mode) < 0) errors.push('sections.mode must be manual, byColumn or single');
    if (sec.mode === 'byColumn' && !colIds[sec.valueColumn]) errors.push('sections: "one section per value of" names unknown column "' + str(sec.valueColumn) + '"');
    if (sec.recoFrom && sec.recoFrom.field && !fieldIds[sec.recoFrom.field]) errors.push('sections: the Reco field "' + str(sec.recoFrom.field) + '" is not a declared field');
    if (sec.presets) {
      if (!colIds[sec.presets.column]) errors.push('sections.presets reads unknown column "' + str(sec.presets.column) + '"');
      // presets() reads this list long after the spec is saved, when the first
      // rows arrive, so a wrong shape here would otherwise surface as a period
      // dropdown that is simply empty - with nothing anywhere saying why.
      if (sec.presets.slots != null && !Array.isArray(sec.presets.slots)) {
        errors.push('sections.presets: "slots" must be a list, so no period option would be offered');
      } else if (sec.presets.kind === 'dateSlots' && !arr(sec.presets.slots).length) {
        warnings.push('sections.presets offers no period options');
      }
      var w = sec.presets.writes || {};
      ['from', 'to'].forEach(function (k) { if (w[k] && !fieldIds[w[k]]) errors.push('sections.presets writes unknown field "' + str(w[k]) + '"'); });
    }
    if (sec.autoAssign) {
      if (!colIds[sec.autoAssign.column]) errors.push('sections.autoAssign reads unknown column "' + str(sec.autoAssign.column) + '"');
      ['from', 'to'].forEach(function (k) { if (sec.autoAssign[k] && !fieldIds[sec.autoAssign[k]]) errors.push('sections.autoAssign names unknown field "' + str(sec.autoAssign[k]) + '"'); });
    }

    var entries = [];
    try { entries = expandEntries(spec); }
    catch (e) { errors.push('the entries could not be read: ' + e.message); }
    if (!entries.length) errors.push('the JV has no entries — it would post nothing');
    var seenEntry = Object.create(null);
    entries.forEach(function (en, i) {
      var where = 'entry ' + (i + 1) + ' (' + str(en.label || en.id) + ')';
      if (!en.id) errors.push(where + ': every entry needs an id');
      else {
        if (seenEntry[en.id]) errors.push(where + ': two entries share the id "' + str(en.id)
          + '" - the posting would be made twice');
        seenEntry[en.id] = 1;
      }
      try {
        Expr.refs(Expr.parse(en.amount)).forEach(function (r) {
          if (!scopeNames[r]) errors.push(where + ': the amount uses unknown name "' + r + '"');
        });
      } catch (e) { errors.push(where + ': ' + e.message); }
      if (!slotIds[en.dr]) errors.push(where + ': Dr account "' + str(en.dr) + '" is not declared');
      if (!slotIds[en.cr]) errors.push(where + ': Cr account "' + str(en.cr) + '" is not declared');
      if (en.dr && en.dr === en.cr) errors.push(where + ': Dr and Cr are the same account — the entry would cancel itself');
      if (!en.cur) errors.push(where + ': no currency');
      if (!(((spec.remarks || {}).templates || {})[en.remark])) errors.push(where + ': unknown narration "' + str(en.remark) + '"');
    });

    arr(spec.validate).forEach(function (v) {
      if (CHECK_KINDS.indexOf(v.kind) < 0) { errors.push('unknown check "' + str(v.kind) + '"'); return; }
      if (v.fields != null && !Array.isArray(v.fields)) errors.push('check "' + str(v.kind) + '": "fields" must be a list');
      var named = arr(v.fields).slice();
      if (v.field) named.push(v.field);
      if (v.from) named.push(v.from);
      if (v.to) named.push(v.to);
      named.forEach(function (f) { if (!fieldIds[f]) errors.push('check "' + v.kind + '" names unknown field "' + str(f) + '"'); });
    });
    var hasBalance = false;
    arr(spec.validate).forEach(function (v) { if (v.kind === 'balancePerCurrency') hasBalance = true; });
    if (!hasBalance) warnings.push('no per-currency balance check — strongly recommended');

    /* Reco projects ONLY the names in inputColumns, so a spelling the spec
       accepts but the mapping does not declare would arrive blank and the
       maths would silently read zero. Refuse, rather than post that. */
    var declared = {}, missing = [];
    arr(spec.columns).forEach(function (c) { names(c).forEach(function (n) { declared[normKey(n)] = n; }); });
    arr(def.inputColumns).forEach(function (ic) { delete declared[normKey(ic && ic.name)]; });
    Object.keys(declared).forEach(function (k) { missing.push(declared[k]); });
    if (missing.length) {
      errors.push('inputColumns is missing ' + missing.length + ' accepted column name(s) — Reco only sends the columns listed there: '
                  + missing.join(', '));
    }
    return { errors: errors, warnings: warnings };
  }

  /* ── canonical form + hash: what makes a hand-edited page detectable ────── */
  function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    var keys = Object.keys(v).sort();
    var parts = [];
    keys.forEach(function (k) {
      if (v[k] === undefined) return;
      parts.push(JSON.stringify(k) + ':' + canonical(v[k]));
    });
    return '{' + parts.join(',') + '}';
  }
  function canonicalDef(def) {
    var copy = {};
    Object.keys(def || {}).forEach(function (k) { if (k !== 'audit' && k !== 'htmlPath' && k !== '_file') copy[k] = def[k]; });
    return canonical(copy);
  }
  /* 64-bit FNV-1a over the canonical JSON, as 16 hex digits. Not a security
     hash — a fingerprint that answers "is this page still the one the creator
     wrote?" without parsing the island. */
  function specHash(def) {
    var s = canonicalDef(def);
    var h1 = 0x811c9dc5, h2 = 0xcbf29ce4;          // low, high halves
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = (h1 ^ (c & 0xff)) >>> 0;
      h2 = (h2 ^ ((c >>> 8) & 0xff)) >>> 0;
      h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = Math.imul(h2, 16777619) >>> 0;
    }
    var hex = function (n) { var x = (n >>> 0).toString(16); while (x.length < 8) x = '0' + x; return x; };
    return 'fnv1a:' + hex(h2) + hex(h1);
  }

  var JVCore = {
    version: VERSION,
    SPEC_MIN: SPEC_MIN,
    SPEC_MAX: SPEC_MAX,
    LINE_ORDER: LINE_ORDER,
    MONTHS: MONTHS,
    OPS: OPS,
    REF_RE: REF_RE,
    /* values */
    num: num, round2: round2, roundN: roundN, fmtNum: fmtNum, fmtInt: fmtInt, isNumeric: isNumeric,
    /* dates */
    parseRowDate: parseRowDate, parseAnyDate: parseAnyDate, parsePeriod: parsePeriod,
    looksLikeDate: looksLikeDate, fmtMMDDYY: fmtMMDDYY, fmtDateFmt: fmtDateFmt,
    fmtDatePattern: fmtDatePattern, excelSerial: excelSerial,
    /* rows */
    colDef: colDef, names: names, raw: raw, cell: cell, cellText: cellText,
    testCond: testCond, fillRowTokens: fillRowTokens,
    classify: classify, kindLabel: kindLabel, kindStyle: kindStyle,
    /* sections */
    presets: presets, newSection: newSection, autoAssign: autoAssign, assignAll: assignAll,
    fieldDef: fieldDef, sectionTitle: sectionTitle, defaultReco: defaultReco,
    /* maths */
    aggregates: aggregates, Expr: Expr, expandEntries: expandEntries, remark: remark,
    slotOf: slotOf, buildSection: buildSection, buildAll: buildAll, balances: balances,
    runChecks: runChecks,
    /* integrity */
    validateSpec: validateSpec, canonical: canonical, canonicalDef: canonicalDef, specHash: specHash
  };

  root.JVCore = JVCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = JVCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
