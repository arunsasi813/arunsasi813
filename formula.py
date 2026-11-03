"""
Excel-style formulas for ColSift, compiled to polars expressions.

    =IF(AMOUNT > 100, "HIGH", "LOW")
    =LEFT(DOC_NO, 3) & "-" & TEXT(DATEVALUE(ISSUE_DATE), "yyyy-mm")
    =ROUND(GROSS * 5%, 2)
    =COLSUM(AMOUNT, TKT_NO)            total per ticket, repeated on each of its rows

Everything in an extract is text, so values convert on use the way Excel does it:
arithmetic reads text as a number (blank counts as 0; "1,234.50", "(250)" and "5%"
parse; "abc" becomes an error), & reads everything as text, and = compares text
without regard to case. A row whose value can't be computed comes out blank, like
Excel's #VALUE! — a formula never stops a run. Mistakes in the formula itself
(unknown column, wrong number of arguments, a missing bracket) raise FormulaError
with the character position, before any data is read.
"""

from __future__ import annotations

import difflib
import re
from datetime import date
from typing import Any, Callable

import polars as pl


class FormulaError(ValueError):
    def __init__(self, message: str, pos: int | None = None):
        super().__init__(message)
        self.pos = pos


# ==========================================================================
# shared helpers — the engine uses these for filters and output formats too
# ==========================================================================

EXCEL_EPOCH_OFFSET = 25569          # days from 1899-12-30 to 1970-01-01
# Each layout is paired with its exact shape: chrono's %Y happily reads "26" as the
# year 0026, so "01JUL26" must never reach a four-digit-year pattern.
AUTO_DATE_FORMATS = [
    (r"^\d{4}-\d{1,2}-\d{1,2}$", "%Y-%m-%d"), (r"^\d{1,2}/\d{1,2}/\d{4}$", "%d/%m/%Y"),
    (r"^\d{1,2}-\d{1,2}-\d{4}$", "%d-%m-%Y"), (r"^\d{1,2}\.\d{1,2}\.\d{4}$", "%d.%m.%Y"),
    (r"^\d{1,2}-[A-Za-z]{3}-\d{4}$", "%d-%b-%Y"), (r"^\d{1,2}-[A-Za-z]{3}-\d{2}$", "%d-%b-%y"),
    (r"^\d{1,2} [A-Za-z]{3} \d{4}$", "%d %b %Y"), (r"^\d{1,2}[A-Za-z]{3}\d{4}$", "%d%b%Y"),
    (r"^\d{1,2}[A-Za-z]{3}\d{2}$", "%d%b%y"), (r"^\d{8}$", "%Y%m%d"),
    (r"^\d{4}/\d{1,2}/\d{1,2}$", "%Y/%m/%d"), (r"^\d{1,2}/\d{1,2}/\d{2}$", "%d/%m/%y"),
]
AUTO_DATETIME_FORMATS = ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M",
                         "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d-%m-%Y %H:%M:%S",
                         "%d-%b-%Y %H:%M:%S", "%d-%b-%Y %H:%M"]
_TIME_TAIL = r"[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[AaPp][Mm])?$"


def clean_number(e: pl.Expr) -> pl.Expr:
    """Text -> Float64. '1,234.50', ' 12 ', '(250)' and '5%' parse; anything else is null."""
    s = (e.cast(pl.String).str.strip_chars()
         .str.replace_all(r"[,\s]", "").str.replace(r"^\((.*)\)$", r"-$1"))
    n = s.str.strip_suffix("%").cast(pl.Float64, strict=False)
    return pl.when(s.str.ends_with("%")).then(n / 100).otherwise(n)


def _serial_to_date(s: pl.Expr) -> pl.Expr:
    return (s.cast(pl.Float64, strict=False).floor() - EXCEL_EPOCH_OFFSET).cast(pl.Int32).cast(pl.Date)


def has_time(fmt: str) -> bool:
    return bool(re.search(r"%-?[HIMSp]", fmt))


def parse_date(e: pl.Expr, fmt: str | None = None) -> pl.Expr:
    """Text -> Date. With no format it tries the common layouts (day before month),
    drops any time part, and reads 5-digit Excel serials. Unreadable -> null."""
    s = e.cast(pl.String).str.strip_chars()
    if fmt and fmt.strip().lower() not in ("", "auto"):
        f = to_strftime(fmt)
        return s.str.to_datetime(f, strict=False).dt.date() if has_time(f) else s.str.to_date(f, strict=False)
    d = s.str.replace(_TIME_TAIL, "")
    tries = [pl.when(d.str.contains(rx)).then(d.str.to_date(f, strict=False)) for rx, f in AUTO_DATE_FORMATS]
    tries.append(pl.when(s.str.contains(r"^\d{5}(?:\.\d+)?$")).then(_serial_to_date(s)))
    return pl.coalesce(tries)


def parse_datetime(e: pl.Expr, fmt: str | None = None) -> pl.Expr:
    """Text -> Datetime(us). Date-only values land on midnight."""
    s = e.cast(pl.String).str.strip_chars()
    if fmt and fmt.strip().lower() not in ("", "auto"):
        f = to_strftime(fmt)
        return (s.str.to_datetime(f, strict=False, time_unit="us") if has_time(f)
                else s.str.to_date(f, strict=False).cast(pl.Datetime("us")))
    tries = [s.str.to_datetime(f, strict=False, time_unit="us") for f in AUTO_DATETIME_FORMATS]
    serial = s.cast(pl.Float64, strict=False)
    tries.append(pl.when(s.str.contains(r"^\d{5}(?:\.\d+)?$")).then(
        ((serial - EXCEL_EPOCH_OFFSET) * 86_400_000_000).round(0).cast(pl.Int64).cast(pl.Datetime("us"))))
    tries.append(parse_date(s).cast(pl.Datetime("us")))
    return pl.coalesce(tries)


def to_serial(e: pl.Expr, kind: str = "date") -> pl.Expr:
    """Date / Datetime -> Excel serial number (what an .xlsx date cell stores)."""
    if kind == "date":
        return (e.cast(pl.Int32) + EXCEL_EPOCH_OFFSET).cast(pl.Float64)
    return e.dt.epoch("us").cast(pl.Float64) / 86_400_000_000 + EXCEL_EPOCH_OFFSET


def _strip_literals(code: str) -> str:
    return re.sub(r'"[^"]*"|\[[^\]]*\]|\\.', "", code)


def is_date_code(code: str) -> bool:
    c = (code or "").strip()
    if not c or c.lower() == "general":
        return False
    if "%" in c and re.search(r"%-?[a-zA-Z]", c):
        return True
    return bool(re.search(r"[yYmMdDhHsS]", _strip_literals(c)))


def to_strftime(code: str) -> str:
    """Excel date code -> strftime. 'dd-mmm-yyyy hh:mm' -> '%d-%b-%Y %H:%M'.
    A code that already contains % is passed through untouched."""
    if "%" in code:
        return code
    toks: list[tuple[str, Any]] = []
    i, n = 0, len(code)
    while i < n:
        c = code[i]
        if c == '"':
            j = code.find('"', i + 1)
            j = n if j < 0 else j
            toks.append(("lit", code[i + 1:j]))
            i = j + 1
            continue
        if c == "\\" and i + 1 < n:
            toks.append(("lit", code[i + 1]))
            i += 2
            continue
        if code[i:i + 5].upper() == "AM/PM":
            toks.append(("ampm", 0)); i += 5; continue
        if code[i:i + 3].upper() == "A/P":
            toks.append(("ampm", 0)); i += 3; continue
        low = c.lower()
        if low in "ymdhs":
            j = i
            while j < n and code[j].lower() == low:
                j += 1
            toks.append((low, j - i))
            i = j
            continue
        toks.append(("lit", c))
        i += 1
    ampm = any(k == "ampm" for k, _ in toks)
    out = []
    for idx, (k, v) in enumerate(toks):
        if k == "lit":
            out.append(str(v).replace("%", "%%"))
        elif k == "ampm":
            out.append("%p")
        elif k == "y":
            out.append("%Y" if v >= 3 else "%y")
        elif k == "d":
            out.append({1: "%-d", 2: "%d", 3: "%a"}.get(v, "%A"))
        elif k == "h":
            out.append(("%I" if v >= 2 else "%-I") if ampm else ("%H" if v >= 2 else "%-H"))
        elif k == "s":
            out.append("%S")
        elif k == "m":
            prev = next((t for t, _ in reversed(toks[:idx]) if t in "ymdhs"), None)
            nxt = next((t for t, _ in toks[idx + 1:] if t in "ymdhs"), None)
            if v <= 2 and (prev == "h" or nxt == "s"):
                out.append("%M")
            else:
                out.append({1: "%-m", 2: "%m", 3: "%b"}.get(v, "%B"))
    return "".join(out)


def fmt_general(n: pl.Expr) -> pl.Expr:
    """Number -> text the way a General cell shows it: 5 not 5.0, 0.3 not 0.30000000000000004."""
    whole = (n == n.round(0)) & (n.abs() < 1e15)
    return (pl.when(n.is_null() | n.is_nan() | n.is_infinite()).then(None)
            .when(whole).then(n.cast(pl.Int64, strict=False).cast(pl.String))
            .otherwise(n.round_sig_figs(15).cast(pl.String)))


def _group3(s: pl.Expr) -> pl.Expr:
    return s.str.reverse().str.replace_all(r"(\d{3})", "$1,").str.reverse().str.strip_chars_start(",")


def _split_sections(code: str) -> list[str]:
    out, cur, q = [], "", False
    for ch in code:
        if ch == '"':
            q = not q
        if ch == ";" and not q:
            out.append(cur); cur = ""
        else:
            cur += ch
    out.append(cur)
    return out


def _parse_section(sec: str) -> dict:
    sec = re.sub(r"\[[^\]]*\]", "", sec)                 # [Red], [$-409] ...
    core = re.search(r"[0#?][0#?,]*(?:\.[0#?]*)?|\.[0#?]+", sec)
    if not core:
        return {"prefix": sec.replace('"', ""), "suffix": "", "dec": 0, "thou": False,
                "pad": 1, "pct": "%" in _strip_literals(sec)}
    body = core.group(0)
    whole, _, frac = body.partition(".")
    lit = lambda t: re.sub(r'"([^"]*)"', r"\1", t).replace("\\", "")  # noqa: E731
    return {"prefix": lit(sec[:core.start()]), "suffix": lit(sec[core.end():]),
            "dec": len(frac), "thou": "," in whole, "pad": max(1, whole.count("0")),
            "pct": "%" in _strip_literals(sec)}


def _num_body(n: pl.Expr, s: dict, signed: bool) -> pl.Expr:
    v = n * 100 if s["pct"] else n
    d = s["dec"]
    scaled = (v.abs() * (10 ** d) + 0.5 + 1e-9).floor()            # half away from zero, like Excel
    ip = (scaled // (10 ** d)).cast(pl.Int64, strict=False).cast(pl.String)
    if s["pad"] > 1:
        ip = ip.str.zfill(s["pad"])
    if s["thou"]:
        ip = _group3(ip)
    body = ip if d == 0 else pl.concat_str([ip, pl.lit("."),
                                            (scaled % (10 ** d)).cast(pl.Int64, strict=False).cast(pl.String).str.zfill(d)])
    sign = pl.when((v < 0) & (scaled > 0)).then(pl.lit("-")).otherwise(pl.lit("")) if signed else pl.lit("")
    return pl.concat_str([sign, pl.lit(s["prefix"]), body, pl.lit(s["suffix"])])


def fmt_number(n: pl.Expr, code: str) -> pl.Expr:
    """Float -> text through an Excel number code: '#,##0.00', '0.0%', '0000',
    '"AED "#,##0.00', '#,##0.00;(#,##0.00)'. Colours and conditions are ignored."""
    code = (code or "").strip()
    if not code or code.lower() == "general":
        return fmt_general(n)
    secs = _split_sections(code)
    pos = _parse_section(secs[0])
    if len(secs) > 1 and secs[1].strip():
        neg = _parse_section(secs[1])
        out = pl.when(n < 0).then(_num_body(n.abs(), neg, False)).otherwise(_num_body(n, pos, False))
    else:
        out = _num_body(n, pos, True)
    return pl.when(n.is_null() | n.is_nan() | n.is_infinite()).then(None).otherwise(out)


# ==========================================================================
# tokenizer and parser
# ==========================================================================

_TOKEN = re.compile(r"""
    (?P<ws>\s+)
  | (?P<num>(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?)
  | (?P<str>"(?:[^"]|"")*")
  | (?P<bcol>\[[^\]]*\])
  | (?P<name>[A-Za-z_][A-Za-z0-9_.]*)
  | (?P<op><>|<=|>=|[-+*/^&=<>%(),;])
""", re.VERBOSE)


def _tokens(text: str) -> list[tuple[str, Any, int]]:
    out, i = [], 0
    while i < len(text):
        m = _TOKEN.match(text, i)
        if not m:
            if text[i] == '"':
                raise FormulaError("Text is missing its closing quote", i)
            if text[i] == "[":
                raise FormulaError("Column name is missing its closing ]", i)
            raise FormulaError(f"Unexpected character “{text[i]}”", i)
        kind = m.lastgroup
        if kind != "ws":
            v = m.group(kind)
            if kind == "str":
                v = v[1:-1].replace('""', '"')
            elif kind == "bcol":
                v = v[1:-1]
            elif kind == "op" and v == ";":
                v = ","                     # some locales separate arguments with ;
            out.append((kind, v, i))
        i = m.end()
    out.append(("end", None, len(text)))
    return out


class _Parser:
    # Excel precedence, loosest first: comparison, &, + -, * /, ^, unary -, %
    def __init__(self, text: str):
        self.t = _tokens(text)
        self.i = 0

    def peek(self):
        return self.t[self.i]

    def take(self, kind=None, value=None):
        tok = self.t[self.i]
        if (kind and tok[0] != kind) or (value is not None and tok[1] != value):
            want = value or kind
            got = "the end of the formula" if tok[0] == "end" else f"“{tok[1]}”"
            raise FormulaError(f"Expected {want} but found {got}", tok[2])
        self.i += 1
        return tok

    def parse(self):
        if self.peek()[0] == "end":
            raise FormulaError("The formula is empty", 0)
        node = self.compare()
        tok = self.peek()
        if tok[0] != "end":
            raise FormulaError(f"Unexpected “{tok[1]}” — is an operator or comma missing?", tok[2])
        return node

    def _binary(self, sub, ops):
        node = sub()
        while self.peek()[0] == "op" and self.peek()[1] in ops:
            _, op, pos = self.take()
            node = ("bin", op, node, sub(), pos)
        return node

    def compare(self):
        return self._binary(self.concat, ("=", "<>", "<", ">", "<=", ">="))

    def concat(self):
        return self._binary(self.add, ("&",))

    def add(self):
        return self._binary(self.mul, ("+", "-"))

    def mul(self):
        return self._binary(self.power, ("*", "/"))

    def power(self):
        return self._binary(self.unary, ("^",))

    def unary(self):
        tok = self.peek()
        if tok[0] == "op" and tok[1] in ("-", "+"):
            self.take()
            inner = self.unary()
            return ("neg", inner, tok[2]) if tok[1] == "-" else inner
        return self.postfix()

    def postfix(self):
        node = self.primary()
        while self.peek()[0] == "op" and self.peek()[1] == "%":
            node = ("pct", node, self.take()[2])
        return node

    def primary(self):
        kind, v, pos = self.peek()
        if kind == "num":
            self.take()
            return ("num", float(v), pos)
        if kind == "str":
            self.take()
            return ("str", v, pos)
        if kind == "bcol":
            self.take()
            return ("col", v, pos, True)
        if kind == "name":
            self.take()
            if self.peek()[0] == "op" and self.peek()[1] == "(":
                self.take()
                args = []
                if not (self.peek()[0] == "op" and self.peek()[1] == ")"):
                    while True:
                        args.append(self.compare())
                        if self.peek()[0] == "op" and self.peek()[1] == ",":
                            self.take()
                            continue
                        break
                self.take("op", ")")
                return ("call", v.upper(), args, pos)
            if v.upper() in ("TRUE", "FALSE"):
                return ("bool", v.upper() == "TRUE", pos)
            return ("col", v, pos, False)
        if kind == "op" and v == "(":
            self.take()
            node = self.compare()
            self.take("op", ")")
            return node
        if kind == "end":
            raise FormulaError("The formula ends too early — a value is missing", pos)
        raise FormulaError(f"Unexpected “{v}”", pos)


# ==========================================================================
# typed values and conversions
# ==========================================================================

_NOLIT = object()


class Val:
    """An expression plus what it holds: num, text, bool, date, or any (a raw column)."""
    __slots__ = ("e", "t", "lit")

    def __init__(self, e: pl.Expr, t: str, lit: Any = _NOLIT):
        self.e, self.t, self.lit = e, t, lit


def as_num(v: Val) -> pl.Expr:
    if v.t == "num":
        return v.e
    if v.t == "bool":
        return v.e.cast(pl.Float64)
    if v.t == "date":
        return to_serial(v.e)
    s = v.e.cast(pl.String)
    blank = s.is_null() | (s.str.strip_chars() == "")
    return pl.when(blank).then(pl.lit(0.0)).otherwise(clean_number(s))   # Excel: blank counts as 0


def as_num_strict(v: Val) -> pl.Expr:
    """Like as_num, but blank stays null — for ISNUMBER and dynamic comparisons."""
    return v.e if v.t == "num" else clean_number(v.e) if v.t in ("text", "any") else as_num(v)


def as_text(v: Val) -> pl.Expr:
    if v.t in ("text", "any"):
        return v.e.cast(pl.String).fill_null("")
    if v.t == "num":
        return fmt_general(v.e).fill_null("")
    if v.t == "bool":
        return pl.when(v.e.is_null()).then(pl.lit("")).when(v.e).then(pl.lit("TRUE")).otherwise(pl.lit("FALSE"))
    return v.e.dt.strftime("%Y-%m-%d").fill_null("")


def as_bool(v: Val) -> pl.Expr:
    if v.t == "bool":
        return v.e.fill_null(False)
    if v.t == "num":
        return (v.e != 0).fill_null(False)
    if v.t == "date":
        return v.e.is_not_null()
    s = v.e.cast(pl.String).str.strip_chars().str.to_uppercase()
    return (s == "TRUE") | (clean_number(s).fill_null(0) != 0)


def as_date(v: Val) -> pl.Expr:
    if v.t == "date":
        return v.e
    if v.t == "num":
        return (v.e.floor() - EXCEL_EPOCH_OFFSET).cast(pl.Int32).cast(pl.Date)
    return parse_date(v.e)


def _output(v: Val) -> pl.Expr:
    """Final text for a formula column: blank where Excel would show an error."""
    if v.t == "num":
        return fmt_general(v.e)
    if v.t == "date":
        return v.e.dt.strftime("%Y-%m-%d")
    if v.t == "bool":
        return pl.when(v.e.is_null()).then(None).when(v.e).then(pl.lit("TRUE")).otherwise(pl.lit("FALSE"))
    return v.e.cast(pl.String)


def _unify(a: Val, b: Val) -> tuple[pl.Expr, pl.Expr, str]:
    if a.t == b.t:
        return a.e, b.e, a.t
    return as_text(a), as_text(b), "text"


def _cmp(op: str, x: pl.Expr, y: pl.Expr) -> pl.Expr:
    return {"=": x == y, "<>": x != y, "<": x < y, ">": x > y, "<=": x <= y, ">=": x >= y}[op]


def _compare(op: str, a: Val, b: Val) -> pl.Expr:
    kinds = {a.t, b.t}
    if "date" in kinds:
        return _cmp(op, as_date(a), as_date(b)).fill_null(False)
    if "bool" in kinds:
        return _cmp(op, as_bool(a), as_bool(b)).fill_null(False)
    if "num" in kinds:
        return _cmp(op, as_num(a), as_num(b)).fill_null(False)
    lo = lambda v: as_text(v).str.to_lowercase()  # noqa: E731 — Excel's = ignores case
    if "text" in kinds:
        return _cmp(op, lo(a), lo(b)).fill_null(False)
    # column against column: numbers when both sides read as numbers, text otherwise
    na, nb = as_num_strict(a), as_num_strict(b)
    return (pl.when(na.is_not_null() & nb.is_not_null()).then(_cmp(op, na, nb))
            .otherwise(_cmp(op, lo(a), lo(b)))).fill_null(False)


# ==========================================================================
# function library — each entry is also a line of the in-app reference
# ==========================================================================

_FUNCS: dict[str, dict] = {}


def _fn(name: str, lo: int, hi: int | None, cat: str, syntax: str, desc: str, example: str):
    def deco(f: Callable):
        _FUNCS[name] = {"f": f, "lo": lo, "hi": hi, "cat": cat, "syntax": syntax,
                        "desc": desc, "example": example}
        return f
    return deco


def _litval(v: Val, what: str, pos: int):
    if v.lit is _NOLIT:
        raise FormulaError(f"{what} has to be typed in directly, not taken from a column", pos)
    return v.lit


def _N(e):
    return Val(e, "num")


def _T(e):
    return Val(e, "text")


def _B(e):
    return Val(e, "bool")


def _D(e):
    return Val(e, "date")


# ---- logical ---------------------------------------------------------------

@_fn("IF", 2, 3, "Logical", "IF(condition, value_if_true, [value_if_false])",
     "Picks one of two values. With no third argument the cell is left blank.",
     'IF(AMOUNT > 1000, "REVIEW", "OK")')
def _if(a, ctx, pos):
    cond = as_bool(a[0])
    if len(a) == 2:
        return Val(pl.when(cond).then(a[1].e), a[1].t)
    x, y, t = _unify(a[1], a[2])
    return Val(pl.when(cond).then(x).otherwise(y), t)


@_fn("IFS", 2, None, "Logical", "IFS(condition1, value1, [condition2, value2], …)",
     "The value next to the first true condition. Use TRUE as the last condition for a default.",
     'IFS(AMOUNT >= 1000, "L", AMOUNT >= 100, "M", TRUE, "S")')
def _ifs(a, ctx, pos):
    if len(a) % 2:
        raise FormulaError("IFS needs pairs: condition, value, condition, value …", pos)
    vals = [a[i + 1] for i in range(0, len(a), 2)]
    t = vals[0].t if all(v.t == vals[0].t for v in vals) else "text"
    pick = (lambda v: v.e) if t != "text" or all(v.t == "text" for v in vals) else as_text
    chain = pl.when(as_bool(a[0])).then(pick(vals[0]))
    for i in range(2, len(a), 2):
        chain = chain.when(as_bool(a[i])).then(pick(a[i + 1]))
    return Val(chain, t)


@_fn("SWITCH", 3, None, "Logical", "SWITCH(value, match1, result1, [match2, result2], …, [default])",
     "Compares a value against a list and returns the matching result (text ignores case).",
     'SWITCH(TAX_CODE, "YQ", "Fuel", "YR", "Carrier", "Other")')
def _switch(a, ctx, pos):
    subject, rest = a[0], a[1:]
    default = rest.pop() if len(rest) % 2 else None
    results = [rest[i + 1] for i in range(0, len(rest), 2)] + ([default] if default else [])
    t = results[0].t if all(r.t == results[0].t for r in results) else "text"
    pick = (lambda v: v.e) if t != "text" or all(r.t == "text" for r in results) else as_text
    chain = None
    for i in range(0, len(rest), 2):
        test = _compare("=", subject, rest[i])
        chain = pl.when(test).then(pick(rest[i + 1])) if chain is None else chain.when(test).then(pick(rest[i + 1]))
    return Val(chain.otherwise(pick(default)) if default else chain, t)


@_fn("AND", 1, None, "Logical", "AND(test1, [test2], …)", "TRUE when every test is true.",
     'AND(AMOUNT > 0, CURRENCY = "AED")')
def _and(a, ctx, pos):
    return _B(pl.all_horizontal([as_bool(v) for v in a]))


@_fn("OR", 1, None, "Logical", "OR(test1, [test2], …)", "TRUE when any test is true.",
     'OR(TAX_CODE = "YQ", TAX_CODE = "YR")')
def _or(a, ctx, pos):
    return _B(pl.any_horizontal([as_bool(v) for v in a]))


@_fn("NOT", 1, 1, "Logical", "NOT(test)", "Flips TRUE and FALSE.", "NOT(ISBLANK(REMARKS))")
def _not(a, ctx, pos):
    return _B(~as_bool(a[0]))


@_fn("IFERROR", 2, 2, "Logical", "IFERROR(value, value_if_error)",
     "The value, or the fallback when it can't be worked out (not a number, bad date, divide by zero).",
     "IFERROR(GROSS / PAX_COUNT, 0)")
def _iferror(a, ctx, pos):
    x, y, t = _unify(a[0], a[1])
    return Val(pl.coalesce([x, y]), t)


@_fn("ISBLANK", 1, 1, "Logical", "ISBLANK(value)", "TRUE when the value is empty or only spaces.",
     'IF(ISBLANK(REMARKS), "none", REMARKS)')
def _isblank(a, ctx, pos):
    v = a[0]
    if v.t in ("text", "any"):
        return _B(v.e.is_null() | (v.e.cast(pl.String).str.strip_chars() == ""))
    return _B(v.e.is_null())


@_fn("ISNUMBER", 1, 1, "Logical", "ISNUMBER(value)", "TRUE when the value reads as a number.",
     "ISNUMBER(TKT_NO)")
def _isnumber(a, ctx, pos):
    return _B(as_num_strict(a[0]).is_not_null())


@_fn("ISDATE", 1, 1, "Logical", "ISDATE(value)", "TRUE when the value reads as a date.",
     "ISDATE(ISSUE_DATE)")
def _isdate(a, ctx, pos):
    return _B(as_date(a[0]).is_not_null())


@_fn("COALESCE", 1, None, "Logical", "COALESCE(value1, value2, …)",
     "The first value that is not blank.", 'COALESCE(NET_FARE, GROSS_FARE, "0")')
def _coalesce(a, ctx, pos):
    t = a[0].t if all(v.t == a[0].t for v in a) else "text"
    if t in ("text", "any"):
        parts = [pl.when(as_text(v).str.strip_chars() != "").then(as_text(v)) for v in a]
    else:
        parts = [v.e for v in a]
    return Val(pl.coalesce(parts), t)


@_fn("IN", 2, None, "Logical", "IN(value, option1, option2, …)",
     "TRUE when the value equals any of the options (text ignores case).",
     'IN(TAX_CODE, "YQ", "YR", "ZR")')
def _in(a, ctx, pos):
    return _B(pl.any_horizontal([_compare("=", a[0], o) for o in a[1:]]))


# ---- text ------------------------------------------------------------------

def _count(v: Val | None, default: int) -> pl.Expr:
    return pl.lit(default) if v is None else as_num(v).cast(pl.Int64, strict=False)


@_fn("LEFT", 1, 2, "Text", "LEFT(text, [count])", "The first characters of the text (1 if no count).",
     "LEFT(DOC_NO, 3)")
def _left(a, ctx, pos):
    return _T(as_text(a[0]).str.head(_count(a[1] if len(a) > 1 else None, 1)))


@_fn("RIGHT", 1, 2, "Text", "RIGHT(text, [count])", "The last characters of the text (1 if no count).",
     "RIGHT(TKT_NO, 4)")
def _right(a, ctx, pos):
    return _T(as_text(a[0]).str.tail(_count(a[1] if len(a) > 1 else None, 1)))


@_fn("MID", 3, 3, "Text", "MID(text, start, count)", "Characters from the middle, counting from 1.",
     "MID(TKT_NO, 4, 7)")
def _mid(a, ctx, pos):
    start = (as_num(a[1]).cast(pl.Int64, strict=False) - 1).clip(lower_bound=0)
    return _T(as_text(a[0]).str.slice(start, _count(a[2], 0)))


@_fn("LEN", 1, 1, "Text", "LEN(text)", "Number of characters.", "LEN(TKT_NO)")
def _len(a, ctx, pos):
    return _N(as_text(a[0]).str.len_chars().cast(pl.Float64))


@_fn("UPPER", 1, 1, "Text", "UPPER(text)", "Capital letters.", "UPPER(PAX_NAME)")
def _upper(a, ctx, pos):
    return _T(as_text(a[0]).str.to_uppercase())


@_fn("LOWER", 1, 1, "Text", "LOWER(text)", "Small letters.", "LOWER(EMAIL)")
def _lower(a, ctx, pos):
    return _T(as_text(a[0]).str.to_lowercase())


@_fn("PROPER", 1, 1, "Text", "PROPER(text)", "Capital first letter of each word.", "PROPER(PAX_NAME)")
def _proper(a, ctx, pos):
    return _T(as_text(a[0]).str.to_titlecase())


@_fn("TRIM", 1, 1, "Text", "TRIM(text)", "Removes outer spaces and squeezes inner runs to one space.",
     "TRIM(REMARKS)")
def _trim(a, ctx, pos):
    return _T(as_text(a[0]).str.replace_all(r"\s+", " ").str.strip_chars())


@_fn("CLEAN", 1, 1, "Text", "CLEAN(text)", "Removes non-printing control characters.", "CLEAN(REMARKS)")
def _clean(a, ctx, pos):
    return _T(as_text(a[0]).str.replace_all(r"[\x00-\x1F\x7F]", ""))


@_fn("SUBSTITUTE", 3, 3, "Text", "SUBSTITUTE(text, find, replace_with)",
     "Replaces every occurrence of find (exact text, case matters).",
     'SUBSTITUTE(AMOUNT, ",", "")')
def _substitute(a, ctx, pos):
    old = _litval(a[1], "SUBSTITUTE's find text", pos)
    return _T(as_text(a[0]).str.replace_all(str(old), as_text(a[2]), literal=True))


@_fn("REPLACE", 4, 4, "Text", "REPLACE(text, start, count, new_text)",
     "Swaps count characters starting at start for new_text.", 'REPLACE(TKT_NO, 1, 3, "XXX")')
def _replace(a, ctx, pos):
    t = as_text(a[0])
    start = (as_num(a[1]).cast(pl.Int64, strict=False) - 1).clip(lower_bound=0)
    n = _count(a[2], 0)
    return _T(pl.concat_str([t.str.head(start), as_text(a[3]), t.str.slice(start + n)]))


def _find(a, pos, fold: bool):
    hay = as_text(a[1])
    if fold:
        hay = hay.str.to_lowercase()
    start = (as_num(a[2]).cast(pl.Int64, strict=False) - 1).clip(lower_bound=0) if len(a) > 2 else pl.lit(0)
    lit = _litval(a[0], "The text to find", pos)
    hit = hay.str.slice(start).str.find(str(lit).lower() if fold else str(lit), literal=True)
    return _N((hit + start + 1).cast(pl.Float64))


@_fn("FIND", 2, 3, "Text", "FIND(find_text, text, [start])",
     "Position of find_text (case matters). Blank when not found.", 'FIND("-", ROUTE)')
def _findf(a, ctx, pos):
    return _find(a, pos, False)


@_fn("SEARCH", 2, 3, "Text", "SEARCH(find_text, text, [start])",
     "Position of find_text, ignoring case. Blank when not found.", 'SEARCH("adj", REMARKS)')
def _search(a, ctx, pos):
    return _find(a, pos, True)


@_fn("CONCAT", 1, None, "Text", "CONCAT(text1, text2, …)", "Joins values end to end. Same as &.",
     'CONCAT(DOC_NO, "-", COUPON)')
def _concat(a, ctx, pos):
    return _T(pl.concat_str([as_text(v) for v in a]))


_FUNCS["CONCATENATE"] = {**_FUNCS["CONCAT"], "syntax": "CONCATENATE(text1, text2, …)",
                         "desc": "Older name for CONCAT.", "example": 'CONCATENATE(A, " ", B)'}


@_fn("TEXTJOIN", 3, None, "Text", "TEXTJOIN(separator, skip_blanks, text1, text2, …)",
     "Joins values with a separator; TRUE as the second argument leaves out blanks.",
     'TEXTJOIN("/", TRUE, ORIGIN, VIA, DESTINATION)')
def _textjoin(a, ctx, pos):
    sep = str(_litval(a[0], "TEXTJOIN's separator", pos))
    skip = a[1].lit if a[1].lit is not _NOLIT else True
    parts = [as_text(v) for v in a[2:]]
    if skip:
        parts = [pl.when(p.str.strip_chars() != "").then(p) for p in parts]
        return _T(pl.concat_str(parts, separator=sep, ignore_nulls=True))
    return _T(pl.concat_str(parts, separator=sep))


@_fn("TEXT", 2, 2, "Text", "TEXT(value, format)",
     'Formats a number or date with an Excel format code: "#,##0.00", "0%", "dd/mm/yyyy", "mmm-yy".',
     'TEXT(AMOUNT, "#,##0.00")   ·   TEXT(ISSUE_DATE, "yyyy-mm")')
def _text(a, ctx, pos):
    code = str(_litval(a[1], "TEXT's format", pos))
    if is_date_code(code):
        f = to_strftime(code)
        d = parse_datetime(as_text(a[0])) if a[0].t in ("text", "any") else (
            as_date(a[0]).cast(pl.Datetime("us")))
        return _T(d.dt.strftime(f) if has_time(f) else d.dt.date().dt.strftime(f))
    return _T(fmt_number(as_num_strict(a[0]) if a[0].t in ("text", "any") else as_num(a[0]), code))


@_fn("VALUE", 1, 1, "Text", "VALUE(text)", "Reads text as a number.", 'VALUE(SUBSTITUTE(FARE, "AED", ""))')
def _value(a, ctx, pos):
    return _N(as_num_strict(a[0]))


@_fn("EXACT", 2, 2, "Text", "EXACT(text1, text2)", "TRUE when both are identical, case included.",
     "EXACT(CODE, UPPER(CODE))")
def _exact(a, ctx, pos):
    return _B(as_text(a[0]) == as_text(a[1]))


@_fn("LPAD", 2, 3, "Text", "LPAD(text, width, [pad_char])",
     'Pads on the left to a fixed width — "0" by default.', 'LPAD(COUPON, 3)  →  "007"')
def _lpad(a, ctx, pos):
    ch = str(a[2].lit)[:1] if len(a) > 2 and a[2].lit is not _NOLIT else "0"
    return _T(as_text(a[0]).str.pad_start(int(_litval(a[1], "LPAD's width", pos)), ch))


@_fn("RPAD", 2, 3, "Text", "RPAD(text, width, [pad_char])",
     "Pads on the right to a fixed width — a space by default.", "RPAD(CODE, 8)")
def _rpad(a, ctx, pos):
    ch = str(a[2].lit)[:1] if len(a) > 2 and a[2].lit is not _NOLIT else " "
    return _T(as_text(a[0]).str.pad_end(int(_litval(a[1], "RPAD's width", pos)), ch))


@_fn("CONTAINS", 2, 2, "Text", "CONTAINS(text, find_text)",
     "TRUE when find_text appears anywhere, ignoring case.", 'CONTAINS(REMARKS, "refund")')
def _contains(a, ctx, pos):
    return _B(as_text(a[0]).str.to_lowercase().str.contains(as_text(a[1]).str.to_lowercase(), literal=True))


@_fn("STARTSWITH", 2, 2, "Text", "STARTSWITH(text, prefix)", "TRUE when the text begins with prefix, ignoring case.",
     'STARTSWITH(TKT_NO, "176")')
def _startswith(a, ctx, pos):
    return _B(as_text(a[0]).str.to_lowercase().str.starts_with(as_text(a[1]).str.to_lowercase()))


@_fn("ENDSWITH", 2, 2, "Text", "ENDSWITH(text, suffix)", "TRUE when the text ends with suffix, ignoring case.",
     'ENDSWITH(FILE, ".pdf")')
def _endswith(a, ctx, pos):
    return _B(as_text(a[0]).str.to_lowercase().str.ends_with(as_text(a[1]).str.to_lowercase()))


@_fn("SPLIT", 3, 3, "Text", "SPLIT(text, separator, part)",
     "One piece of the text cut at each separator. Part 1 is the first; -1 is the last.",
     'SPLIT(ROUTE, "-", 2)   →  "DXB" from "LHR-DXB"')
def _split(a, ctx, pos):
    sep = str(_litval(a[1], "SPLIT's separator", pos))
    n = int(_litval(a[2], "SPLIT's part number", pos))
    if n == 0:
        raise FormulaError("SPLIT's part number starts at 1 (or -1 for the last)", pos)
    return _T(as_text(a[0]).str.split(sep, inclusive=False).list.get(n - 1 if n > 0 else n, null_on_oob=True))


@_fn("REGEXMATCH", 2, 2, "Text", "REGEXMATCH(text, pattern)", "TRUE when the pattern matches (?i) for no case.",
     r'REGEXMATCH(TKT_NO, "^176\d{7}$")')
def _rmatch(a, ctx, pos):
    return _B(as_text(a[0]).str.contains(str(_litval(a[1], "The pattern", pos))))


@_fn("REGEXEXTRACT", 2, 3, "Text", "REGEXEXTRACT(text, pattern, [group])",
     "The part the pattern matches — or its numbered ( ) group.", r'REGEXEXTRACT(REMARKS, "PNR[: ]*(\w{6})", 1)')
def _rextract(a, ctx, pos):
    pat = str(_litval(a[1], "The pattern", pos))
    g = int(a[2].lit) if len(a) > 2 and a[2].lit is not _NOLIT else (1 if "(" in pat else 0)
    return _T(as_text(a[0]).str.extract(pat if g else f"({pat})", g or 1))


@_fn("REGEXREPLACE", 3, 3, "Text", "REGEXREPLACE(text, pattern, replacement)",
     "Replaces every match; $1 in the replacement puts back group 1.", r'REGEXREPLACE(PHONE, "\D", "")')
def _rreplace(a, ctx, pos):
    return _T(as_text(a[0]).str.replace_all(str(_litval(a[1], "The pattern", pos)),
                                            str(_litval(a[2], "The replacement", pos))))


# ---- numbers ---------------------------------------------------------------

def _digits(a, i):
    return int(_litval(a[i], "The number of digits", 0)) if len(a) > i else 0


def _scale_round(n: pl.Expr, d: int, how: str) -> pl.Expr:
    f = 10.0 ** d
    x = n * f
    if how == "round":
        r = (x.abs() + 0.5 + 1e-9).floor() * x.sign()
    elif how == "up":
        r = (x.abs() - 1e-9).ceil() * x.sign()
    else:
        r = (x.abs() + 1e-9).floor() * x.sign()
    return r / f


@_fn("ROUND", 1, 2, "Numbers", "ROUND(number, [digits])", "Rounds half away from zero, like Excel.",
     "ROUND(AMOUNT * 1.05, 2)")
def _round(a, ctx, pos):
    return _N(_scale_round(as_num(a[0]), _digits(a, 1), "round"))


@_fn("ROUNDUP", 1, 2, "Numbers", "ROUNDUP(number, [digits])", "Rounds away from zero.", "ROUNDUP(NIGHTS / 7, 0)")
def _roundup(a, ctx, pos):
    return _N(_scale_round(as_num(a[0]), _digits(a, 1), "up"))


@_fn("ROUNDDOWN", 1, 2, "Numbers", "ROUNDDOWN(number, [digits])", "Rounds toward zero.", "ROUNDDOWN(AMOUNT, 0)")
def _rounddown(a, ctx, pos):
    return _N(_scale_round(as_num(a[0]), _digits(a, 1), "down"))


@_fn("INT", 1, 1, "Numbers", "INT(number)", "Rounds down to a whole number.", "INT(AMOUNT)")
def _int(a, ctx, pos):
    return _N(as_num(a[0]).floor())


@_fn("ABS", 1, 1, "Numbers", "ABS(number)", "Drops the minus sign.", "ABS(VARIANCE)")
def _abs(a, ctx, pos):
    return _N(as_num(a[0]).abs())


@_fn("SIGN", 1, 1, "Numbers", "SIGN(number)", "1, 0 or -1.", "SIGN(VARIANCE)")
def _sign(a, ctx, pos):
    return _N(as_num(a[0]).sign())


@_fn("MOD", 2, 2, "Numbers", "MOD(number, divisor)", "The remainder, with the sign of the divisor like Excel.",
     "MOD(COUPON, 2)")
def _mod(a, ctx, pos):
    x, y = as_num(a[0]), as_num(a[1])
    return _N(pl.when(y == 0).then(None).otherwise(x - y * (x / y).floor()))


@_fn("POWER", 2, 2, "Numbers", "POWER(number, power)", "Same as ^.", "POWER(1 + RATE, YEARS)")
def _power(a, ctx, pos):
    return _N(as_num(a[0]).pow(as_num(a[1])))


@_fn("SQRT", 1, 1, "Numbers", "SQRT(number)", "Square root; blank for negatives.", "SQRT(AREA)")
def _sqrt(a, ctx, pos):
    x = as_num(a[0])
    return _N(pl.when(x < 0).then(None).otherwise(x.sqrt()))


@_fn("CEILING", 1, 2, "Numbers", "CEILING(number, [step])", "Rounds up to the nearest multiple of step.",
     "CEILING(AMOUNT, 5)")
def _ceiling(a, ctx, pos):
    s = as_num(a[1]) if len(a) > 1 else pl.lit(1.0)
    return _N(pl.when(s == 0).then(pl.lit(0.0)).otherwise((as_num(a[0]) / s - 1e-9).ceil() * s))


@_fn("FLOOR", 1, 2, "Numbers", "FLOOR(number, [step])", "Rounds down to the nearest multiple of step.",
     "FLOOR(AMOUNT, 5)")
def _floor(a, ctx, pos):
    s = as_num(a[1]) if len(a) > 1 else pl.lit(1.0)
    return _N(pl.when(s == 0).then(pl.lit(0.0)).otherwise((as_num(a[0]) / s + 1e-9).floor() * s))


@_fn("SUM", 1, None, "Numbers", "SUM(number1, number2, …)",
     "Adds the values in this row. For a column total use COLSUM.", "SUM(FARE, TAX, FEE)")
def _sum(a, ctx, pos):
    return _N(pl.sum_horizontal([as_num(v) for v in a]))


@_fn("MIN", 1, None, "Numbers", "MIN(number1, number2, …)", "Smallest of the values in this row.", "MIN(A, B)")
def _min(a, ctx, pos):
    return _N(pl.min_horizontal([as_num_strict(v) if v.t in ("text", "any") else as_num(v) for v in a]))


@_fn("MAX", 1, None, "Numbers", "MAX(number1, number2, …)", "Largest of the values in this row.", "MAX(A, 0)")
def _max(a, ctx, pos):
    return _N(pl.max_horizontal([as_num_strict(v) if v.t in ("text", "any") else as_num(v) for v in a]))


@_fn("AVERAGE", 1, None, "Numbers", "AVERAGE(number1, number2, …)", "Mean of the values in this row, skipping blanks.",
     "AVERAGE(Q1, Q2, Q3)")
def _average(a, ctx, pos):
    return _N(pl.mean_horizontal([as_num_strict(v) if v.t in ("text", "any") else as_num(v) for v in a]))


# ---- whole-column (per file) ----------------------------------------------

def _grouped(e: pl.Expr, a: list[Val], i: int) -> pl.Expr:
    return e.over([as_text(v) for v in a[i:]]) if len(a) > i else e


@_fn("COLSUM", 1, None, "Column totals", "COLSUM(column, [group_by1], …)",
     "Total of a column over the whole file — or over the rows sharing the group values.",
     "AMOUNT / COLSUM(AMOUNT, TKT_NO)   (share of the ticket total)")
def _colsum(a, ctx, pos):
    return _N(_grouped(as_num_strict(a[0]).sum(), a, 1))


@_fn("COLCOUNT", 0, None, "Column totals", "COLCOUNT([group_by1], …)",
     "Rows in the file — or rows sharing the group values. >1 means a duplicate.",
     'IF(COLCOUNT(DOC_NO) > 1, "DUP", "")')
def _colcount(a, ctx, pos):
    return _N(_grouped(pl.len(), a, 0).cast(pl.Float64))


@_fn("COLMIN", 1, None, "Column totals", "COLMIN(column, [group_by1], …)", "Smallest value in the column (or group).",
     "COLMIN(AMOUNT, TKT_NO)")
def _colmin(a, ctx, pos):
    return _N(_grouped(as_num_strict(a[0]).min(), a, 1))


@_fn("COLMAX", 1, None, "Column totals", "COLMAX(column, [group_by1], …)", "Largest value in the column (or group).",
     "COLMAX(AMOUNT, TKT_NO)")
def _colmax(a, ctx, pos):
    return _N(_grouped(as_num_strict(a[0]).max(), a, 1))


@_fn("COLAVG", 1, None, "Column totals", "COLAVG(column, [group_by1], …)", "Average of the column (or group).",
     "AMOUNT - COLAVG(AMOUNT)")
def _colavg(a, ctx, pos):
    return _N(_grouped(as_num_strict(a[0]).mean(), a, 1))


@_fn("ROW", 0, 0, "Context", "ROW()", "Row number in this file's output, after filters.", 'ROW() & "/" & COLCOUNT()')
def _row(a, ctx, pos):
    return _N(pl.int_range(1, pl.len() + 1, dtype=pl.Int64).cast(pl.Float64))


@_fn("FILENAME", 0, 0, "Context", "FILENAME()", "Name of the source file.", "FILENAME()")
def _filename(a, ctx, pos):
    return Val(pl.lit(ctx.get("filename", "")), "text", ctx.get("filename", ""))


@_fn("SHEETNAME", 0, 0, "Context", "SHEETNAME()", "Sheet the rows came from (blank for text files).", "SHEETNAME()")
def _sheetname(a, ctx, pos):
    return Val(pl.lit(ctx.get("sheet", "") or ""), "text", ctx.get("sheet", "") or "")


# ---- dates -----------------------------------------------------------------

@_fn("TODAY", 0, 0, "Dates", "TODAY()", "The date of the run.", "DAYS(TODAY(), ISSUE_DATE)")
def _today(a, ctx, pos):
    return _D(pl.lit(ctx.get("today") or date.today()))


@_fn("DATE", 3, 3, "Dates", "DATE(year, month, day)", "Builds a date from numbers.", "DATE(2026, 7, 31)")
def _date(a, ctx, pos):
    i = lambda v: as_num(v).cast(pl.Int32, strict=False)  # noqa: E731
    return _D(pl.date(i(a[0]), i(a[1]), i(a[2])))


@_fn("DATEVALUE", 1, 2, "Dates", "DATEVALUE(text, [format])",
     'Reads text as a date. Without a format it tries 31/07/2026, 2026-07-31, 31-Jul-2026, 31JUL26 and Excel serials — day before month.',
     'DATEVALUE(ISSUE_DATE, "mm/dd/yyyy")')
def _datevalue(a, ctx, pos):
    if len(a) > 1:
        return _D(parse_date(as_text(a[0]), str(_litval(a[1], "DATEVALUE's format", pos))))
    return _D(as_date(a[0]))


@_fn("YEAR", 1, 1, "Dates", "YEAR(date)", "The year.", "YEAR(ISSUE_DATE)")
def _year(a, ctx, pos):
    return _N(as_date(a[0]).dt.year().cast(pl.Float64))


@_fn("MONTH", 1, 1, "Dates", "MONTH(date)", "The month, 1–12.", "MONTH(ISSUE_DATE)")
def _month(a, ctx, pos):
    return _N(as_date(a[0]).dt.month().cast(pl.Float64))


@_fn("DAY", 1, 1, "Dates", "DAY(date)", "The day of the month.", "DAY(ISSUE_DATE)")
def _day(a, ctx, pos):
    return _N(as_date(a[0]).dt.day().cast(pl.Float64))


@_fn("WEEKDAY", 1, 1, "Dates", "WEEKDAY(date)", "Day of the week, Sunday = 1 … Saturday = 7, like Excel.",
     "WEEKDAY(FLIGHT_DATE)")
def _weekday(a, ctx, pos):
    return _N((as_date(a[0]).dt.weekday() % 7 + 1).cast(pl.Float64))


@_fn("EOMONTH", 2, 2, "Dates", "EOMONTH(date, months)", "Last day of the month, months away (0 = this month).",
     "EOMONTH(ISSUE_DATE, 0)")
def _eomonth(a, ctx, pos):
    m = as_num(a[1]).cast(pl.Int64, strict=False)
    return _D(as_date(a[0]).dt.offset_by(pl.format("{}mo", m)).dt.month_end())


@_fn("EDATE", 2, 2, "Dates", "EDATE(date, months)", "The same day, months away.", "EDATE(START_DATE, 12)")
def _edate(a, ctx, pos):
    m = as_num(a[1]).cast(pl.Int64, strict=False)
    return _D(as_date(a[0]).dt.offset_by(pl.format("{}mo", m)))


@_fn("DAYS", 2, 2, "Dates", "DAYS(end_date, start_date)", "Days between two dates.", "DAYS(TODAY(), ISSUE_DATE)")
def _days(a, ctx, pos):
    return _N((as_date(a[0]) - as_date(a[1])).dt.total_days().cast(pl.Float64))


# ==========================================================================
# compiler
# ==========================================================================

_UNSUPPORTED = {
    **dict.fromkeys(("VLOOKUP", "HLOOKUP", "XLOOKUP", "LOOKUP", "INDEX", "MATCH", "XMATCH"),
                    "lookups need a second table — use a Lookup column (Add columns) for code → description maps"),
    **dict.fromkeys(("SUMIF", "SUMIFS"), "use COLSUM(value, group_column) for totals per key"),
    **dict.fromkeys(("COUNTIF", "COUNTIFS", "COUNTA", "COUNT"), "use COLCOUNT(group_column) for counts per key"),
    **dict.fromkeys(("AVERAGEIF", "AVERAGEIFS"), "use COLAVG(value, group_column)"),
    "NOW": "use TODAY()", "INDIRECT": "not available", "OFFSET": "not available",
    "DATEDIF": "use DAYS(end, start), or YEAR/MONTH differences",
}


def _resolve(name: str, cols: list[str], pos: int, bracketed: bool) -> str:
    if name in cols:
        return name
    folded = [c for c in cols if c.lower() == name.lower()]
    if len(folded) == 1:
        return folded[0]
    near = difflib.get_close_matches(name, cols, n=1, cutoff=0.6) or \
        difflib.get_close_matches(name.upper(), [c.upper() for c in cols], n=1, cutoff=0.6)
    hint = ""
    if near:
        match = next((c for c in cols if c.upper() == near[0].upper()), near[0])
        hint = f" — did you mean {match if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.]*', match) else '[' + match + ']'}?"
    elif not bracketed and re.search(r"\s", name):
        hint = " — put names with spaces in [brackets]"
    raise FormulaError(f"Unknown column {name}{hint}", pos)


def _compile(node, cols: list[str], ctx: dict, refs: set[str]) -> Val:
    kind = node[0]
    if kind == "num":
        return Val(pl.lit(node[1]), "num", node[1])
    if kind == "str":
        return Val(pl.lit(node[1]), "text", node[1])
    if kind == "bool":
        return Val(pl.lit(node[1]), "bool", node[1])
    if kind == "col":
        name = _resolve(node[1], cols, node[2], node[3])
        refs.add(name)
        return Val(pl.col(name), "any")
    if kind == "neg":
        v = _compile(node[1], cols, ctx, refs)
        return Val(-as_num(v), "num", -v.lit if isinstance(v.lit, float) else _NOLIT)
    if kind == "pct":
        v = _compile(node[1], cols, ctx, refs)
        return Val(as_num(v) / 100, "num", v.lit / 100 if isinstance(v.lit, float) else _NOLIT)
    if kind == "bin":
        _, op, l, r, pos = node
        a, b = _compile(l, cols, ctx, refs), _compile(r, cols, ctx, refs)
        if op in ("=", "<>", "<", ">", "<=", ">="):
            return _B(_compare(op, a, b))
        if op == "&":
            return _T(pl.concat_str([as_text(a), as_text(b)]))
        if op in ("+", "-") and "date" in (a.t, b.t):
            if a.t == "date" and b.t == "date" and op == "-":
                return _N((a.e - b.e).dt.total_days().cast(pl.Float64))
            d, n = (a, b) if a.t == "date" else (b, a)
            days = as_num(n).cast(pl.Int64, strict=False)
            return _D((d.e + pl.duration(days=days if op == "+" else -days)).cast(pl.Date))
        x, y = as_num(a), as_num(b)
        if op == "+":
            return _N(x + y)
        if op == "-":
            return _N(x - y)
        if op == "*":
            return _N(x * y)
        if op == "/":
            return _N(pl.when(y == 0).then(None).otherwise(x / y))
        if op == "^":
            return _N(x.pow(y))
    if kind == "call":
        _, name, args, pos = node
        spec = _FUNCS.get(name)
        if spec is None and name in _UNSUPPORTED:
            raise FormulaError(f"{name} isn't available here — {_UNSUPPORTED[name]}", pos)
        if spec is None:
            near = difflib.get_close_matches(name, list(_FUNCS), n=1, cutoff=0.6)
            raise FormulaError(f"Unknown function {name}" + (f" — did you mean {near[0]}?" if near else ""), pos)
        lo, hi = spec["lo"], spec["hi"]
        if len(args) < lo or (hi is not None and len(args) > hi):
            want = f"{lo}" if lo == hi else f"{lo} or more" if hi is None else f"{lo} to {hi}"
            raise FormulaError(f"{name} takes {want} argument{'s' if (hi or lo) != 1 else ''}, got {len(args)}. "
                               f"Syntax: {spec['syntax']}", pos)
        return spec["f"]([_compile(a, cols, ctx, refs) for a in args], ctx, pos)
    raise FormulaError("Could not understand the formula", 0)


def compile_formula(text: str, columns: list[str], context: dict | None = None) -> tuple[Val, set[str]]:
    src = (text or "").strip()
    src = src[1:] if src.startswith("=") else src
    refs: set[str] = set()
    try:
        node = _Parser(src).parse()
    except FormulaError as exc:
        spaced = next((c for c in columns if " " in c and c in src and f"[{c}]" not in src), None)
        if spaced:
            raise FormulaError(f"{exc} — column names with spaces go in brackets: [{spaced}]", exc.pos) from None
        raise
    val = _compile(node, list(columns), dict(context or {}), refs)
    return val, refs


def text_expr(text: str, columns: list[str], context: dict | None = None) -> pl.Expr:
    """A formula column: its value rendered as text, blank where it can't be worked out."""
    return _output(compile_formula(text, columns, context)[0])


def num_expr(text: str, columns: list[str], context: dict | None = None) -> pl.Expr:
    """A formula used as a number — what the analysis aggregates work on."""
    return as_num(compile_formula(text, columns, context)[0])


def bool_expr(text: str, columns: list[str], context: dict | None = None) -> pl.Expr:
    """A formula filter: TRUE keeps the row; anything that isn't TRUE drops it."""
    return as_bool(compile_formula(text, columns, context)[0]).fill_null(False)


def referenced(text: str, columns: list[str]) -> set[str]:
    try:
        return compile_formula(text, columns)[1]
    except FormulaError:
        return set()


def check(text: str, columns: list[str]) -> dict:
    """What the UI's Check button reports — offsets are 0-based into the text as typed."""
    lead = len(text) - len((text or "").lstrip())
    lead += 1 if (text or "").strip().startswith("=") else 0
    try:
        val, refs = compile_formula(text, columns)
        return {"ok": True, "type": {"num": "number", "text": "text", "bool": "TRUE / FALSE",
                                     "date": "date", "any": "text"}[val.t], "columns": sorted(refs)}
    except FormulaError as exc:
        return {"ok": False, "error": str(exc), "pos": None if exc.pos is None else exc.pos + lead}


SYNTAX_NOTES = [
    ("Columns", "AMOUNT, TAX_CODE — or [Pax Name] when a name has spaces or symbols. Case doesn't matter."),
    ("Text", 'In double quotes: "AED". A quote inside text is doubled: "5"" wide".'),
    ("Operators", "+  -  *  /  ^ (power)  & (join text)  % (5% = 0.05)"),
    ("Comparisons", "=  <>  <  >  <=  >=   — text compares without regard to case"),
    ("Numbers from text", 'Blank counts as 0; "1,234.50", "(250)" and "5%" are read as numbers.'),
    ("Dates", "DATEVALUE reads text; date + 30 adds days; date − date gives days."),
    ("Errors", "A row that can't be worked out (bad number, divide by zero) is left blank."),
    ("Per file", "COLSUM / COLCOUNT and friends look at the whole file being processed."),
]


def reference() -> dict:
    order = ["Logical", "Text", "Numbers", "Dates", "Column totals", "Context"]
    funcs = sorted(({"name": k, "category": v["cat"], "syntax": v["syntax"], "description": v["desc"],
                     "example": v["example"]} for k, v in _FUNCS.items()),
                   key=lambda r: (order.index(r["category"]) if r["category"] in order else 99, r["name"]))
    return {"functions": funcs, "notes": [{"topic": t, "text": x} for t, x in SYNTAX_NOTES]}
