"""
PDF reports for ColSift — the dashboard and the summaries, without a PDF library.

A PDF is a handful of numbered objects and some drawing operators; the only
things a table-and-chart report needs are text in the two built-in Helvetica
faces, filled and stroked rectangles, lines and a few Bézier curves. Writing
them directly keeps the build free of reportlab / fpdf / Pillow (tens of MB for
three buttons) and costs about 600 lines. zlib is the one import beyond str.

What it draws
  * a page header (title, subtitle, filters) and a footer with page x of y
  * KPI tiles — value, caption, target and change against the previous period
  * column, bar, line, area, pie, donut, stacked and clustered charts, with a
    legend when there is more than one series
  * tables: header rows repeated on every page, subtotal and grand rows bold
    and shaded, numbers right-aligned, a heat map on request, and a pivot
    wider than the page carried on across pages with its row labels repeated

Limits worth knowing
  * The built-in fonts cover Windows-1252 — English and Western European text.
    Anything else (Arabic, Cyrillic, CJK) prints as "?". Use the Excel export
    for those columns; it carries every character.
  * Charts are vector drawings of what the app shows, not live chart objects.
"""

from __future__ import annotations

import math
import re
import zlib
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

# --------------------------------------------------------------------------
# font metrics — Adobe's AFM widths for the standard 14 fonts, ASCII 32..126
# --------------------------------------------------------------------------

_HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
         556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
         1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
         667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
         333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
         556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]
_HELV_B = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
           556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
           975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
           667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
           333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
           611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584]


def _enc(s: Any) -> bytes:
    """Text -> the bytes a WinAnsi Helvetica string holds. Unmappable -> '?'."""
    return str("" if s is None else s).replace("\r", " ").replace("\n", " ").replace("\t", " ") \
        .encode("cp1252", errors="replace")


def text_width(s: Any, size: float, bold: bool = False) -> float:
    table = _HELV_B if bold else _HELV
    w = 0
    for b in _enc(s):
        if 32 <= b <= 126:
            w += table[b - 32]
        elif b == 0x85:              # …
            w += 1000
        else:
            w += 556
    return w * size / 1000.0


def fit(s: Any, size: float, max_w: float, bold: bool = False) -> str:
    """Cut text to a width, ending in … when it had to be cut."""
    s = str("" if s is None else s)
    if text_width(s, size, bold) <= max_w:
        return s
    ell = text_width("…", size, bold)
    lo, hi = 0, len(s)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if text_width(s[:mid], size, bold) + ell <= max_w:
            lo = mid
        else:
            hi = mid - 1
    return s[:lo].rstrip() + "…" if lo else ""


def _esc(b: bytes) -> bytes:
    return b.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _rgb(c: str | tuple | None) -> tuple[float, float, float]:
    if c is None:
        return (0.0, 0.0, 0.0)
    if isinstance(c, tuple):
        return c
    c = c.lstrip("#")
    return tuple(int(c[i:i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore[return-value]


def _n(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


INK, MUTED, FAINT, LINE, LINE2 = "#0e1418", "#5d6b70", "#8a979c", "#c9d0cc", "#e3e7e4"
TEAL, TEAL2, TEAL_SOFT, AMBER, RED = "#0d6e66", "#0a564f", "#e0efed", "#b26a00", "#9c2f2f"
HEAD_FILL, SUB_FILL = "#eef1ef", "#f6f8f7"
PALETTE = ["#0d6e66", "#b26a00", "#5b6f8c", "#8a5a8c", "#3f8f4f", "#c0504d", "#2a7ab0",
           "#7a7a2a", "#a0522d", "#4d4d99", "#6b8e23", "#8c6d31"]

PAGE_SIZES = {"A4": (595.28, 841.89), "A3": (841.89, 1190.55), "Letter": (612.0, 792.0)}


# --------------------------------------------------------------------------
# the document
# --------------------------------------------------------------------------

class PDF:
    def __init__(self, size: str = "A4", landscape: bool = True, margin: float = 34.0):
        w, h = PAGE_SIZES.get(size, PAGE_SIZES["A4"])
        self.W, self.H = (h, w) if landscape else (w, h)
        self.M = margin
        self.pages: list[list[bytes]] = []
        self.y = 0.0
        self.title = ""
        self.subtitle = ""
        self.header_cb = None
        self._sink: list[bytes] | None = None     # redirect drawing (the footer)

    # -- geometry ----------------------------------------------------------
    @property
    def left(self) -> float:
        return self.M

    @property
    def right(self) -> float:
        return self.W - self.M

    @property
    def width(self) -> float:
        return self.W - 2 * self.M

    @property
    def bottom(self) -> float:
        return self.H - self.M - 16          # room for the footer

    def room(self) -> float:
        return self.bottom - self.y

    def ensure(self, h: float) -> bool:
        """Start a new page unless h points still fit. True when it broke."""
        if self.pages and self.y + h <= self.bottom:
            return False
        self.new_page()
        return True

    def new_page(self) -> None:
        self.pages.append([])
        self.y = self.M
        if self.header_cb:
            self.header_cb(self)

    # -- primitives (y grows downward, like the screen) ---------------------
    def _op(self, s: str | bytes) -> None:
        if self._sink is not None:
            self._sink.append(s if isinstance(s, bytes) else s.encode("latin-1"))
            return
        if not self.pages:
            self.new_page()
        self.pages[-1].append(s if isinstance(s, bytes) else s.encode("latin-1"))

    def text(self, x: float, y: float, s: Any, size: float = 9, bold: bool = False,
             color: Any = INK, align: str = "left", max_w: float | None = None) -> float:
        s = str("" if s is None else s)
        if max_w is not None:
            s = fit(s, size, max_w, bold)
        if not s:
            return 0.0
        w = text_width(s, size, bold)
        if align == "right":
            x -= w
        elif align == "center":
            x -= w / 2
        r, g, b = _rgb(color)
        base = self.H - y - size * 0.78        # y is the top of the line box
        self._op(b"BT /" + (b"F2" if bold else b"F1") + f" {_n(size)} Tf {_n(r)} {_n(g)} {_n(b)} rg "
                 f"{_n(x)} {_n(base)} Td (".encode("latin-1") + _esc(_enc(s)) + b") Tj ET\n")
        return w

    def rect(self, x: float, y: float, w: float, h: float, fill: Any = None, stroke: Any = None,
             lw: float = 0.5) -> None:
        ops = []
        if fill is not None:
            ops.append("{} {} {} rg".format(*map(_n, _rgb(fill))))
        if stroke is not None:
            ops.append("{} {} {} RG {} w".format(*map(_n, _rgb(stroke)), _n(lw)))
        ops.append(f"{_n(x)} {_n(self.H - y - h)} {_n(w)} {_n(h)} re")
        ops.append("B" if fill is not None and stroke is not None else "f" if fill is not None else "S")
        self._op(" ".join(ops) + "\n")

    def line(self, x1: float, y1: float, x2: float, y2: float, color: Any = LINE, lw: float = 0.5,
             dash: bool = False) -> None:
        r, g, b = _rgb(color)
        d = "[2 2] 0 d " if dash else ""
        self._op(f"{_n(r)} {_n(g)} {_n(b)} RG {_n(lw)} w {d}{_n(x1)} {_n(self.H - y1)} m "
                 f"{_n(x2)} {_n(self.H - y2)} l S" + (" [] 0 d" if dash else "") + "\n")

    def poly(self, pts: list[tuple[float, float]], stroke: Any = None, fill: Any = None,
             lw: float = 1.0, close: bool = False) -> None:
        if len(pts) < 2:
            return
        ops = []
        if fill is not None:
            ops.append("{} {} {} rg".format(*map(_n, _rgb(fill))))
        if stroke is not None:
            ops.append("{} {} {} RG {} w 1 j".format(*map(_n, _rgb(stroke)), _n(lw)))
        ops.append(f"{_n(pts[0][0])} {_n(self.H - pts[0][1])} m")
        ops += [f"{_n(x)} {_n(self.H - y)} l" for x, y in pts[1:]]
        if close:
            ops.append("h")
        ops.append("B" if fill is not None and stroke is not None else "f" if fill is not None else "S")
        self._op(" ".join(ops) + "\n")

    def wedge(self, cx: float, cy: float, r: float, a0: float, a1: float, fill: Any,
              inner: float = 0.0) -> None:
        """A pie slice from angle a0 to a1 (radians, clockwise from 12 o'clock)."""
        if a1 - a0 <= 1e-6:
            return
        def pt(a, rad):
            return cx + rad * math.sin(a), cy - rad * math.cos(a)
        def arc(rad, s, e):     # Bézier segments of at most 90°
            out, n = [], max(1, math.ceil(abs(e - s) / (math.pi / 2)))
            step = (e - s) / n
            for i in range(n):
                t0, t1 = s + i * step, s + (i + 1) * step
                k = 4 / 3 * math.tan((t1 - t0) / 4) * rad
                p0, p3 = pt(t0, rad), pt(t1, rad)
                c1 = (p0[0] + k * math.cos(t0), p0[1] + k * math.sin(t0))
                c2 = (p3[0] - k * math.cos(t1), p3[1] - k * math.sin(t1))
                out.append((c1, c2, p3))
            return out
        r_, g_, b_ = _rgb(fill)
        ops = [f"{_n(r_)} {_n(g_)} {_n(b_)} rg 1 1 1 RG 0.8 w"]
        start = pt(a0, r)
        ops.append(f"{_n(start[0])} {_n(self.H - start[1])} m")
        for c1, c2, p in arc(r, a0, a1):
            ops.append(f"{_n(c1[0])} {_n(self.H - c1[1])} {_n(c2[0])} {_n(self.H - c2[1])} {_n(p[0])} {_n(self.H - p[1])} c")
        if inner > 0:
            p = pt(a1, inner)
            ops.append(f"{_n(p[0])} {_n(self.H - p[1])} l")
            for c1, c2, q in arc(inner, a1, a0):
                ops.append(f"{_n(c1[0])} {_n(self.H - c1[1])} {_n(c2[0])} {_n(self.H - c2[1])} {_n(q[0])} {_n(self.H - q[1])} c")
        else:
            ops.append(f"{_n(cx)} {_n(self.H - cy)} l")
        ops.append("h B")
        self._op(" ".join(ops) + "\n")

    # -- output ---------------------------------------------------------------
    def to_bytes(self, footer: str = "") -> bytes:
        if not self.pages:
            self.new_page()
        n = len(self.pages)
        objs: list[bytes] = []

        def add(b: bytes) -> int:
            objs.append(b)
            return len(objs)

        add(b"")                                  # 1: catalog, filled in below
        add(b"")                                  # 2: page tree
        f1 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
        f2 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
        kids = []
        for i, ops in enumerate(self.pages):
            foot: list[bytes] = []
            if footer or n > 1:          # drawn now, when the page count is known
                y = self.H - self.M + 4
                self._sink = foot
                self.line(self.M, y - 4, self.W - self.M, y - 4, LINE2, 0.5)
                self.text(self.M, y, footer, 7, color=FAINT, max_w=self.width - 80)
                self.text(self.W - self.M, y, f"Page {i + 1} of {n}", 7, color=FAINT, align="right")
                self._sink = None
            data = zlib.compress(b"".join(ops + foot), 6)
            cs = add(b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(data) + data + b"\nendstream")
            kids.append(add(("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %s %s] /Resources << /Font << "
                             "/F1 %d 0 R /F2 %d 0 R >> >> /Contents %d 0 R >>" %
                             (_n(self.W), _n(self.H), f1, f2, cs)).encode("latin-1")))
        objs[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
        objs[1] = ("<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join(f"{k} 0 R" for k in kids), n)).encode()
        title = (self.title or "ColSift report").encode("utf-16-be").hex().upper()
        info = add(("<< /Title <FEFF%s> /Producer (ColSift) /CreationDate (D:%s) >>" %
                    (title, datetime.now().strftime("%Y%m%d%H%M%S"))).encode("latin-1"))
        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offs = []
        for i, b in enumerate(objs, 1):
            offs.append(len(out))
            out += b"%d 0 obj\n" % i + b + b"\nendobj\n"
        xref = len(out)
        out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
        out += b"".join(b"%010d 00000 n \n" % o for o in offs)
        out += b"trailer\n<< /Size %d /Root 1 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, info, xref)
        return bytes(out)

    def save(self, path: str | Path, footer: str = "") -> Path:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".part")
        tmp.write_bytes(self.to_bytes(footer))
        tmp.replace(p)
        return p


# --------------------------------------------------------------------------
# number helpers
# --------------------------------------------------------------------------

def short_num(v: float) -> str:
    a = abs(v)
    for div, suf in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if a >= div:
            x = v / div
            return f"{x:.1f}".rstrip("0").rstrip(".") + suf
    if a >= 100 or a == int(a):
        return f"{v:,.0f}"
    return f"{v:.2f}".rstrip("0").rstrip(".")


def nice_ticks(lo: float, hi: float, n: int = 4) -> list[float]:
    if hi == lo:
        hi = lo + 1
    raw = (hi - lo) / n
    mag = 10 ** math.floor(math.log10(raw)) if raw > 0 else 1
    step = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw)
    start = math.floor(lo / step) * step
    ticks, t = [], start
    while t <= hi + step * 1e-9:
        ticks.append(round(t, 10))
        t += step
    if ticks[-1] < hi:
        ticks.append(round(t, 10))
    return ticks


_NUMLIKE = re.compile(r"^\(?-?[\d,]*\.?\d+\)?%?$")


def _is_num_text(s: str) -> bool:
    return bool(_NUMLIKE.match(str(s).strip().replace(" ", "")))


# --------------------------------------------------------------------------
# building blocks
# --------------------------------------------------------------------------

def page_header(pdf: PDF, title: str, subtitle: str = "", note: str = "") -> None:
    def draw(p: PDF) -> None:
        p.text(p.left, p.y, title, 13, bold=True, color=INK, max_w=p.width)
        p.y += 17
        line = " · ".join(x for x in (subtitle, note) if x)
        if line:
            p.text(p.left, p.y, line, 7.5, color=MUTED, max_w=p.width)
            p.y += 11
        p.line(p.left, p.y + 1, p.right, p.y + 1, TEAL, 1.0)
        p.y += 10
    pdf.header_cb = draw


def section_title(pdf: PDF, text: str, sub: str = "", keep_with: float = 40) -> None:
    """keep_with: room the first block after the title needs, so a title never sits
    alone at the foot of a page."""
    pdf.ensure(28 + keep_with)
    pdf.text(pdf.left, pdf.y, text, 10.5, bold=True, color=INK, max_w=pdf.width)
    pdf.y += 14
    if sub:
        pdf.text(pdf.left, pdf.y, sub, 7.5, color=FAINT, max_w=pdf.width)
        pdf.y += 11


def kpi_tiles(pdf: PDF, tiles: list[dict]) -> None:
    """Up to four tiles a row: caption, value, and a line each for target and change."""
    if not tiles:
        return
    per = 4 if pdf.width > 600 else 2
    gap = 10
    tw = (pdf.width - gap * (per - 1)) / per
    th = 66
    for i in range(0, len(tiles), per):
        pdf.ensure(th + 10)
        for j, t in enumerate(tiles[i:i + per]):
            x = pdf.left + j * (tw + gap)
            y = pdf.y
            pdf.rect(x, y, tw, th, fill="#fbfcfb", stroke=LINE2, lw=0.6)
            pdf.rect(x, y, 3, th, fill=TEAL)
            pdf.text(x + 10, y + 7, t.get("name") or "", 7.5, bold=True, color=MUTED, max_w=tw - 16)
            if t.get("error"):
                pdf.text(x + 10, y + 24, t["error"], 7.5, color=RED, max_w=tw - 16)
                continue
            k = t.get("kpi") or {}
            pdf.text(x + 10, y + 19, k.get("value") or "–", 17, bold=True, color=TEAL2, max_w=tw - 16)
            yy = y + 41
            if k.get("target"):
                pct = k.get("pct")
                pdf.text(x + 10, yy, f"Target {k['target']}" + (f" · {pct:.0%} of it" if pct is not None else ""),
                         7, color=MUTED, max_w=tw - 16)
                yy += 10
            if k.get("change") is not None:
                ch = k["change"]
                pdf.text(x + 10, yy, f"{'+' if ch >= 0 else '-'}{abs(ch):.1%} vs "
                         f"{(k.get('prev') or {}).get('label', 'previous')}",
                         7, bold=True, color=TEAL2 if ch >= 0 else RED, max_w=tw - 16)
            elif k.get("caption") and not k.get("target") and k["caption"] != t.get("name"):
                pdf.text(x + 10, yy, k["caption"], 7, color=FAINT, max_w=tw - 16)
        pdf.y += th + 10


def legend(pdf: PDF, names: list[str], x: float, y: float, max_w: float) -> float:
    """One row (wrapping) of coloured keys. Returns the height used."""
    cx, cy, h = x, y, 10
    for i, nm in enumerate(names):
        w = min(text_width(nm, 7) + 16, max_w)
        if cx + w > x + max_w and cx > x:
            cx, cy = x, cy + 11
            h += 11
        pdf.rect(cx, cy + 1.5, 7, 7, fill=PALETTE[i % len(PALETTE)])
        pdf.text(cx + 10, cy + 1, nm, 7, color=MUTED, max_w=w - 12)
        cx += w + 6
    return h


def chart(pdf: PDF, kind: str, labels: list[str], series: list[dict], height: float = 170,
          width: float | None = None) -> None:
    """Draw one chart at the cursor. series: [{name, values}]; values may hold None."""
    series = [s for s in series if any(v is not None for v in s.get("values") or [])]
    if not labels or not series or kind in (None, "", "none", "heatmap"):
        return
    width = width or pdf.width
    names = [s["name"] for s in series]
    leg_h = 0.0
    if kind in ("pie", "donut"):
        pdf.ensure(height + 10)
        _pie(pdf, kind, labels, series[0], height, width)
        return
    need_legend = len(series) > 1
    pdf.ensure(height + (24 if need_legend else 8))
    x0, y0 = pdf.left, pdf.y
    if need_legend:
        leg_h = legend(pdf, names, x0, y0, width)
        y0 += leg_h + 4
    if kind == "hbar":
        _hbar(pdf, labels, series[0], x0, y0, width, height)
    else:
        _xy(pdf, kind, labels, series, x0, y0, width, height)
    pdf.y = y0 + height + 8


def _vals(series: list[dict], stacked: bool) -> tuple[float, float]:
    if stacked:
        n = max(len(s["values"]) for s in series)
        pos = [sum(max(0.0, s["values"][i] or 0.0) for s in series if i < len(s["values"])) for i in range(n)]
        neg = [sum(min(0.0, s["values"][i] or 0.0) for s in series if i < len(s["values"])) for i in range(n)]
        return min(neg + [0.0]), max(pos + [0.0])
    vals = [v for s in series for v in s["values"] if v is not None]
    return min(vals + [0.0]), max(vals + [0.0])


def _xy(pdf: PDF, kind: str, labels: list[str], series: list[dict], x0: float, y0: float,
        width: float, height: float) -> None:
    stacked = kind == "stacked"
    lo, hi = _vals(series, stacked)
    ticks = nice_ticks(lo, hi)
    lo, hi = ticks[0], ticks[-1]
    axis_w = max(text_width(short_num(t), 6.5) for t in ticks) + 6
    px, pw = x0 + axis_w, width - axis_w
    py, ph = y0, height - 16
    ymap = lambda v: py + ph - (v - lo) / ((hi - lo) or 1) * ph  # noqa: E731
    for t in ticks:
        yy = ymap(t)
        pdf.line(px, yy, px + pw, yy, LINE2 if t else LINE, 0.4)
        pdf.text(px - 4, yy - 3.5, short_num(t), 6.5, color=FAINT, align="right")
    n = len(labels)
    slot = pw / max(1, n)
    zero = ymap(0.0)
    if kind in ("bar", "clustered", "stacked"):
        k = 1 if stacked else len(series)
        bw = min(slot * 0.78, 42 * k)
        acc_pos = [0.0] * n
        acc_neg = [0.0] * n
        for si, s in enumerate(series):
            col = PALETTE[si % len(PALETTE)]
            for i, v in enumerate(s["values"][:n]):
                if v is None:
                    continue
                cx = px + slot * i + slot / 2
                if stacked:
                    base = acc_pos[i] if v >= 0 else acc_neg[i]
                    top = base + v
                    if v >= 0:
                        acc_pos[i] = top
                    else:
                        acc_neg[i] = top
                    y1, y2 = ymap(max(base, top)), ymap(min(base, top))
                    pdf.rect(cx - bw / 2, y1, bw, max(0.6, y2 - y1), fill=col)
                else:
                    w = bw / k
                    bx = cx - bw / 2 + si * w
                    y1, y2 = sorted((ymap(v), zero))
                    pdf.rect(bx + 0.4, y1, max(0.8, w - 0.8), max(0.6, y2 - y1), fill=col)
    else:
        for si, s in enumerate(series):
            col = PALETTE[si % len(PALETTE)]
            pts = [(px + slot * i + slot / 2, ymap(v)) for i, v in enumerate(s["values"][:n]) if v is not None]
            if kind == "area" and len(pts) > 1:
                pdf.poly([(pts[0][0], zero)] + pts + [(pts[-1][0], zero)], fill=_mix(col, 0.72), close=True)
            pdf.poly(pts, stroke=col, lw=1.4)
            if len(pts) <= 40:
                for x, y in pts:
                    pdf.rect(x - 1.4, y - 1.4, 2.8, 2.8, fill=col)
    step = max(1, math.ceil(n / max(1, pw / 46)))
    for i, lab in enumerate(labels):
        if i % step:
            continue
        pdf.text(px + slot * i + slot / 2, py + ph + 4, lab, 6.5, color=MUTED, align="center",
                 max_w=max(20, slot * step - 2))


def _hbar(pdf: PDF, labels: list[str], s: dict, x0: float, y0: float, width: float, height: float) -> None:
    texts = s.get("texts") or [""] * len(labels)
    trip = [(lab, v, texts[i] if i < len(texts) else "") for i, (lab, v) in enumerate(zip(labels, s["values"]))
            if v is not None][:24]
    if not trip:
        return
    pairs = [(a, b) for a, b, _ in trip]
    lab_w = min(width * 0.32, max(text_width(p[0], 7) for p in pairs) + 8)
    lo, hi = min([0.0] + [v for _, v in pairs]), max([0.0] + [v for _, v in pairs])
    bx, bw = x0 + lab_w, width - lab_w - 48
    rh = min(16.0, height / len(pairs))
    zero = bx + (0 - lo) / ((hi - lo) or 1) * bw
    for i, (lab, v, txt) in enumerate(trip):
        y = y0 + i * rh
        pdf.text(bx - 5, y + rh / 2 - 4, lab, 7, color=MUTED, align="right", max_w=lab_w - 6)
        x1 = bx + (min(v, 0) - lo) / ((hi - lo) or 1) * bw
        x2 = bx + (max(v, 0) - lo) / ((hi - lo) or 1) * bw
        pdf.rect(x1, y + rh * 0.18, max(0.8, x2 - x1), rh * 0.64, fill=PALETTE[0])
        pdf.text(x2 + 4, y + rh / 2 - 4, txt or short_num(v), 6.5, color=INK)
    pdf.line(zero, y0, zero, y0 + len(pairs) * rh, LINE, 0.5)


def _pie(pdf: PDF, kind: str, labels: list[str], s: dict, height: float, width: float) -> None:
    pairs = [(lab, v) for lab, v in zip(labels, s["values"]) if v is not None and v > 0]
    if not pairs:
        return
    pairs.sort(key=lambda p: -p[1])
    if len(pairs) > 9:
        rest = sum(v for _, v in pairs[8:])
        pairs = pairs[:8] + [("Other", rest)]
    total = sum(v for _, v in pairs) or 1.0
    r = min(height, width / 2) / 2 - 4
    cx, cy = pdf.left + r + 10, pdf.y + r + 4
    a = 0.0
    for i, (_, v) in enumerate(pairs):
        span = v / total * 2 * math.pi
        pdf.wedge(cx, cy, r, a, a + span, PALETTE[i % len(PALETTE)], inner=r * 0.55 if kind == "donut" else 0)
        a += span
    lx, ly = cx + r + 24, pdf.y + 6
    lw = min(260.0, width - (lx - pdf.left))
    for i, (lab, v) in enumerate(pairs):
        pdf.rect(lx, ly + 1.5, 7, 7, fill=PALETTE[i % len(PALETTE)])
        pdf.text(lx + 11, ly, lab, 7.5, color=INK, max_w=lw - 60)
        pdf.text(lx + lw, ly, f"{v / total:.1%}", 7.5, color=MUTED, align="right")
        ly += 12
    pdf.y += max(2 * r + 12, ly - pdf.y + 4)


def _mix(c: str, t: float) -> tuple[float, float, float]:
    r, g, b = _rgb(c)
    return (r + (1 - r) * t, g + (1 - g) * t, b + (1 - b) * t)


def table(pdf: PDF, table: dict, heat: bool = False, max_rows: int = 20000, font: float = 7.5) -> None:
    """A pivot / grid table. Header rows repeat on every page; value columns that do
    not fit the width carry on in further blocks with the row labels repeated."""
    head = [list(h) for h in table.get("head") or []]
    rows = list(table.get("rows") or [])[:max_rows]
    ncol = max([len(h) for h in head] + [len(r.get("cells") or []) for r in rows] + [0])
    if not ncol:
        return
    rf = table.get("row_fields") or []
    # a pivot always has a label column ("Value" when it has no row fields); a plain
    # grid of rows has none, so its columns all page across freely
    nlab = max(1, len(rf)) if (rf or table.get("colinfo")) else 0
    pad, rh = 4.0, font + 5.5

    def cell(r: list, i: int) -> str:
        return str(r[i]) if i < len(r) and r[i] is not None else ""

    widths = []
    for c in range(ncol):
        texts = [cell(h, c) for h in head] + [cell(r.get("cells") or [], c) for r in rows[:4000]]
        w = max([text_width(t, font, True) for t in texts if t] + [18.0]) + 2 * pad
        widths.append(min(w, 190.0 if c < max(1, nlab) else 150.0))
    lab_cols = list(range(min(nlab, ncol)))
    val_cols = [c for c in range(ncol) if c not in lab_cols]
    lab_w = sum(widths[c] for c in lab_cols)
    if lab_w > pdf.width * 0.6:              # squeeze label columns on a narrow page
        k = pdf.width * 0.6 / lab_w
        for c in lab_cols:
            widths[c] *= k
        lab_w = pdf.width * 0.6
    blocks, cur, used = [], [], lab_w
    for c in val_cols:
        if cur and used + widths[c] > pdf.width:
            blocks.append(cur)
            cur, used = [], lab_w
        cur.append(c)
        used += widths[c]
    blocks.append(cur)

    nums_all = [[x for x in (r.get("nums") or [])] for r in rows]
    heat_rng: dict[int, tuple[float, float]] = {}
    if heat:
        for c in val_cols:
            vals = [n[c] for n, r in zip(nums_all, rows) if c < len(n) and isinstance(n[c], (int, float))
                    and r.get("kind") == "data"]
            if vals:
                heat_rng[c] = (min(vals), max(vals))

    for bi, block in enumerate(blocks):
        cols = lab_cols + block
        if bi and len(blocks) > 1:
            pdf.ensure(rh * 3)
            pdf.text(pdf.left, pdf.y, f"(continued — columns {bi + 1} of {len(blocks)})", 7, color=FAINT)
            pdf.y += 10

        def draw_head() -> None:
            for h in head:
                x = pdf.left
                pdf.rect(pdf.left, pdf.y, sum(widths[c] for c in cols), rh, fill=HEAD_FILL)
                for c in cols:
                    t = cell(h, c)
                    right = c not in lab_cols
                    pdf.text(x + widths[c] - pad if right else x + pad, pdf.y + 2.8, t, font - 0.5, bold=True,
                             color=MUTED, align="right" if right else "left", max_w=widths[c] - 2 * pad)
                    x += widths[c]
                pdf.y += rh
            pdf.line(pdf.left, pdf.y, pdf.left + sum(widths[c] for c in cols), pdf.y, LINE, 0.6)

        pdf.ensure(rh * (len(head) + 2))
        draw_head()
        for ri, r in enumerate(rows):
            if pdf.y + rh > pdf.bottom:
                pdf.new_page()
                draw_head()
            kind = r.get("kind") or "data"
            bold = kind in ("subtotal", "grand")
            tw = sum(widths[c] for c in cols)
            if kind == "grand":
                pdf.rect(pdf.left, pdf.y, tw, rh, fill=TEAL_SOFT)
                pdf.line(pdf.left, pdf.y, pdf.left + tw, pdf.y, LINE, 0.6)
            elif kind == "subtotal":
                pdf.rect(pdf.left, pdf.y, tw, rh, fill=SUB_FILL)
            x = pdf.left
            cells = r.get("cells") or []
            nums = nums_all[ri]
            for c in cols:
                t = cell(cells, c)
                num = nums[c] if c < len(nums) else None
                right = c not in lab_cols and (isinstance(num, (int, float)) or _is_num_text(t))
                if heat and c in heat_rng and isinstance(num, (int, float)) and kind == "data":
                    lo, hi = heat_rng[c]
                    f = 0.0 if hi == lo else (num - lo) / (hi - lo)
                    pdf.rect(x, pdf.y, widths[c], rh, fill=_mix(TEAL, 1 - 0.55 * f - 0.05))
                indent = 8 * int(r.get("level") or 0) if c == 0 and kind == "data" and len(lab_cols) == 1 else 0
                pdf.text(x + widths[c] - pad if right else x + pad + indent, pdf.y + 2.8, t, font, bold=bold,
                         color=INK, align="right" if right else "left", max_w=widths[c] - 2 * pad - indent)
                x += widths[c]
            pdf.y += rh
            if kind == "data":
                pdf.line(pdf.left, pdf.y, pdf.left + tw, pdf.y, "#f0f2f0", 0.3)
        pdf.y += 8
    if len(table.get("rows") or []) > max_rows:
        pdf.text(pdf.left, pdf.y, f"First {max_rows:,} rows of {len(table['rows']):,} shown.", 7, color=FAINT)
        pdf.y += 10


# --------------------------------------------------------------------------
# the two reports
# --------------------------------------------------------------------------

def _stamp() -> str:
    return datetime.now().strftime("%d %b %Y %H:%M")


def _series_of(item: dict) -> tuple[list[str], list[dict]]:
    if item.get("series"):
        return item.get("labels") or [], item["series"]
    pts = item.get("points") or []
    return [p["label"] for p in pts], [{"name": "", "values": [p["value"] for p in pts],
                                        "texts": [p.get("text", "") for p in pts]}]


def draw_dashboard(pdf: PDF, items: list[dict], filter_text: str = "") -> None:
    items = [i for i in items or [] if i.get("kind") != "slicer"]
    if filter_text:
        pdf.ensure(20)
        pdf.rect(pdf.left, pdf.y, pdf.width, 15, fill="#fdf1de")
        pdf.text(pdf.left + 6, pdf.y + 3.5, f"Filtered: {filter_text}", 7.5, color="#7a4a00", max_w=pdf.width - 12)
        pdf.y += 22
    kpis = [i for i in items if i.get("kind") == "kpi"]
    kpi_tiles(pdf, kpis)
    for it in items:
        if it.get("kind") == "kpi":
            continue
        tab = it.get("table") or {}
        sub = ""
        if tab.get("n_total") is not None:
            sub = f"{len(tab.get('rows') or []):,} of {tab['n_total']:,} rows"
        ch = it.get("chart") or "none"
        charted = ch not in ("none", "heatmap") and not it.get("error")
        section_title(pdf, it.get("name") or "Item", sub, keep_with=170 if charted else 60)
        if it.get("error"):
            pdf.text(pdf.left, pdf.y, it["error"], 8, color=RED, max_w=pdf.width)
            pdf.y += 16
            continue
        if charted:
            labels, series = _series_of(it)
            chart(pdf, ch, labels, series, height=150 if ch not in ("pie", "donut") else 140)
        if tab:
            table(pdf, tab, heat=ch == "heatmap")
        pdf.y += 6


def draw_summaries(pdf: PDF, tabs: list[dict]) -> None:
    first = True
    for t in tabs or []:
        if not first:
            pdf.new_page()
        first = False
        tab = t.get("table") or {}
        sub = f"{tab.get('n_rows', 0):,} rows × {tab.get('n_cols', 0)} columns" if tab else ""
        ch = t.get("chart") or "none"
        charted = bool(t.get("series")) and ch not in ("none", "heatmap") and not t.get("error")
        section_title(pdf, t.get("name") or "Summary", sub, keep_with=190 if charted else 60)
        if t.get("error"):
            pdf.text(pdf.left, pdf.y, t["error"], 8, color=RED, max_w=pdf.width)
            pdf.y += 16
            continue
        if charted:
            chart(pdf, ch, t.get("labels") or [], t["series"], height=160)
        table(pdf, tab, heat=bool(t.get("heat")) or ch == "heatmap")


def analysis_pdf(path: str | Path, result: dict, parts: Iterable[str] = ("dashboard", "summaries"),
                 title: str = "ColSift analysis", subtitle: str = "", size: str = "A4",
                 landscape: bool = True) -> Path:
    """result is what analysis.analyse() returns (or the UI holds): items and tabs."""
    parts = set(parts)
    pdf = PDF(size, landscape)
    pdf.title = title
    note = f"Generated {_stamp()}"
    page_header(pdf, title, subtitle, note)
    drew = False
    if "dashboard" in parts and [i for i in result.get("items") or [] if i.get("kind") != "slicer"]:
        pdf.new_page()
        draw_dashboard(pdf, result.get("items") or [], result.get("filter_text") or "")
        drew = True
    if "summaries" in parts and result.get("tabs"):
        if drew:
            page_header(pdf, title, subtitle, note)
        pdf.new_page()
        draw_summaries(pdf, result.get("tabs") or [])
        drew = True
    if not drew:
        pdf.new_page()
        pdf.text(pdf.left, pdf.y, "Nothing to show — the dashboard and summaries are empty.", 9, color=MUTED)
    return pdf.save(path, footer=f"{title} · ColSift · {_stamp()}")
