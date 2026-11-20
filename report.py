"""A run report: one HTML page per run — by hand or scheduled — kept with the run
history (profiles\\runs). What ran, with which parameters, which files were read and
how many rows each gave, what was written (with sizes), the checks, warnings and errors,
how long it took and how much memory it used. Self-contained and printable: something
to keep, or send, as the record of a month-end run."""

from __future__ import annotations

import html
from datetime import datetime
from pathlib import Path

CSS = """
:root{--ink:#0e1418;--muted:#5d6b70;--line:#d6dbd8;--soft:#f3f5f4;--ok:#0a564f;--bad:#9c2f2f;--warn:#8a5a00}
*{box-sizing:border-box}body{font:13px/1.45 "Segoe UI",system-ui,sans-serif;color:var(--ink);margin:28px auto;max-width:980px;padding:0 18px}
h1{font-size:20px;margin:0 0 2px}h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:22px 0 6px}
.sub{color:var(--muted);margin-bottom:14px}table{width:100%;border-collapse:collapse;margin:4px 0}
th{text-align:left;font-weight:600;color:var(--muted);font-size:11.5px;border-bottom:1px solid var(--line);padding:4px 6px}
td{border-bottom:1px solid #e9ecea;padding:4px 6px;vertical-align:top}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.kv td:first-child{color:var(--muted);width:170px}.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}
.warn{color:var(--warn);font-weight:600}.pill{display:inline-block;padding:1px 9px;border-radius:9px;font-weight:600}
.pill.ok{background:#e0efed}.pill.bad{background:#fbeceb}.pill.warn{background:#fdf1de}code{font:12px Consolas,monospace}
ul{margin:4px 0;padding-left:20px}.foot{color:var(--muted);font-size:11px;margin-top:26px}
@media print{body{margin:0}}
"""


def _e(x) -> str:
    return html.escape("" if x is None else str(x))


def _size(n: int | None) -> str:
    if n is None:
        return ""
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:,.0f} {unit}" if unit in ("B", "KB") else f"{n:,.1f} {unit}"
        n /= 1024
    return str(n)


def _rows(n) -> str:
    return "" if n is None else f"{int(n):,}"


def _secs(s) -> str:
    try:
        s = float(s)
    except (TypeError, ValueError):
        return ""
    return f"{s:.1f} s" if s < 60 else f"{int(s // 60)} min {int(s % 60)} s"


def page(entry: dict, setup: dict, res: dict) -> str:
    """The report as HTML. `entry` is the history line, `setup` what ran, `res` the result."""
    import engine as E
    from version import VERSION

    ok, stopped = bool(entry.get("ok")), bool(entry.get("stopped"))
    verdict = ('<span class="pill ok">Done</span>' if ok else '<span class="pill warn">Stopped by a check</span>'
               if stopped else '<span class="pill bad">Failed</span>')
    name = entry.get("setup") or setup.get("name") or "(not saved)"
    how = "scheduled" if entry.get("source") != "manual" else "by hand"
    out = setup.get("output") or {}
    parts = [f"<!doctype html><html lang='en'><head><meta charset='utf-8'><title>Run report — {_e(name)}</title>"
             f"<style>{CSS}</style></head><body>",
             f"<h1>Run report — {_e(name)}</h1><div class='sub'>{verdict} &nbsp; {_e(entry.get('start'))} · {how}</div>",
             "<table class='kv'>",
             f"<tr><td>Started</td><td>{_e(entry.get('start'))}</td></tr>",
             f"<tr><td>Took</td><td>{_secs(entry.get('seconds'))}</td></tr>",
             f"<tr><td>Rows written</td><td>{_rows(res.get('rows'))}</td></tr>"]
    if res.get("peak_memory") or entry.get("peak_memory"):
        parts.append(f"<tr><td>Peak memory</td><td>{_size(res.get('peak_memory') or entry.get('peak_memory'))}</td></tr>")
    parts.append(f"<tr><td>Output</td><td>{_e((out.get('format') or 'csv').upper())} → <code>{_e(out.get('folder'))}</code></td></tr>")
    if not ok and (entry.get("error") or res.get("error")):
        parts.append(f"<tr><td>Why</td><td class='bad'>{_e(entry.get('error') or res.get('error'))}</td></tr>")
    parts.append("</table>")

    try:
        vals = E.param_values(setup)
    except Exception:  # noqa: BLE001 — a report never fails over parameters
        vals = {}
    if vals:
        parts.append("<h2>Parameters</h2><table class='kv'>" +
                     "".join(f"<tr><td>{{{_e(k)}}}</td><td>{_e(v)}</td></tr>" for k, v in vals.items()) + "</table>")

    groups = setup.get("groups") or []
    if groups:
        parts.append("<h2>What it does</h2><table><tr><th>Group</th><th>Columns kept</th><th>Filters</th></tr>")
        for g in groups:
            st = g.get("setup") or {}
            cols = [c.get("alias") or c.get("name") for c in st.get("columns") or [] if c.get("include", True)]
            try:
                filt = E.describe_filters(st.get("filters"))
            except Exception:  # noqa: BLE001
                filt = ""
            shown = ", ".join(str(c) for c in cols[:24]) + (f" … +{len(cols) - 24}" if len(cols) > 24 else "")
            parts.append(f"<tr><td>{_e(g.get('name'))}</td><td>{len(cols)}: {_e(shown) or '<i>every column</i>'}</td>"
                         f"<td>{_e(filt) or '<i>none</i>'}</td></tr>")
        steps = setup.get("steps") or []
        if steps:
            parts.append("<tr><td colspan='3'>Combine: " + _e(", ".join(f"{s.get('name')} ({s.get('kind')})" for s in steps)) + "</td></tr>")
        parts.append("</table>")

    files = res.get("files") or []
    if files:
        total = sum(int(f.get("rows") or 0) for f in files)
        parts.append(f"<h2>Files read — {len(files):,}, {total:,} rows</h2><table><tr><th>File</th><th class='n'>Rows</th><th></th></tr>")
        for f in files:
            state = f"<span class='bad'>{_e(f.get('error'))}</span>" if f.get("error") else _e(f.get("note") or "")
            parts.append(f"<tr><td>{_e(f.get('file'))}</td><td class='n'>{_rows(f.get('rows'))}</td><td>{state}</td></tr>")
        parts.append("</table>")

    tables = res.get("tables") or []
    written = [str(w) for w in res.get("written") or entry.get("written") or []]
    if written or tables:
        parts.append("<h2>Written</h2><table><tr><th>File</th><th>Folder</th><th class='n'>Size</th></tr>")
        for w in written:
            p = Path(w)
            try:
                size = p.stat().st_size
            except OSError:
                size = None
            parts.append(f"<tr><td>{_e(p.name)}</td><td><code>{_e(p.parent)}</code></td><td class='n'>{_size(size)}</td></tr>")
        parts.append("</table>")
        if tables:
            parts.append("<table><tr><th>Table / sheet</th><th class='n'>Rows</th></tr>" +
                         "".join(f"<tr><td>{_e(t.get('sheet') or t.get('table'))}</td><td class='n'>{_rows(t.get('rows'))}</td></tr>"
                                 for t in tables) + "</table>")

    checks = res.get("checks") or []
    if checks:
        parts.append("<h2>Checks</h2><table><tr><th>Check</th><th>Result</th><th>Detail</th></tr>")
        for c in checks:
            st = c.get("status") or ("pass" if c.get("ok") else "fail")
            cls = "ok" if st == "pass" else "bad" if c.get("on_fail") == "stop" else "warn"
            parts.append(f"<tr><td>{_e(c.get('name'))}</td><td class='{cls}'>{_e(st)}</td><td>{_e(c.get('detail'))}</td></tr>")
        parts.append("</table>")
    for title, items, cls in (("Warnings", res.get("warnings") or [], "warn"), ("Errors", res.get("errors") or [], "bad")):
        if items:
            parts.append(f"<h2>{title}</h2><ul>" + "".join(f"<li class='{cls}'>{_e(x)}</li>" for x in items) + "</ul>")
    parts.append(f"<div class='foot'>ColSift {_e(VERSION)} · report written {datetime.now():%Y-%m-%d %H:%M:%S}"
                 + (f" · log: <code>{_e(entry.get('log'))}</code>" if entry.get("log") else "") + "</div></body></html>")
    return "\n".join(parts)


def write(entry: dict, setup: dict, res: dict) -> str | None:
    """Write the report beside the run history; its path, or None when it can't be."""
    try:
        import scheduling as SC
        stamp = str(entry.get("start") or datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        stamp = stamp.replace("-", "").replace(":", "").replace(" ", "-")
        path = SC.runs_dir() / f"{SC.task_name(entry.get('setup') or 'run')}_{stamp}_report.html"
        path.write_text(page(entry, setup, res), encoding="utf-8")
        return str(path)
    except Exception:  # noqa: BLE001 — a report never fails a run
        import traceback
        traceback.print_exc()
        return None
