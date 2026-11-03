"""What is actually in a Nuitka build — run it on Windows after building.

    python buildsize.py build\app.dist
    python buildsize.py build\app.dist --prune      (delete the safe-to-drop files)

Only <output-dir>\app.dist ships. Its sibling app.build holds the generated C and
object files and is scratch: it is often larger than the program itself, so a
"1.5 GB build folder" is usually a few hundred MB of program plus scratch.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

# folders inside app.dist that ColSift never touches at runtime. Each is
# (path fragment, why) — the fragment matches anywhere in the relative path.
PRUNABLE = [
    ("polars/_cli", "polars command line tool"),
    ("polars/docs", "docstring data"),
    ("tcl", "Tk — ColSift's window is pywebview/Edge, not Tk"),
    ("tk8", "Tk"), ("tcl8", "Tk"),
    ("_tkinter", "Tk"),
    ("share/doc", "package documentation"),
    ("dist-info", "wheel metadata"),
    ("egg-info", "wheel metadata"),
    ("__pycache__", "byte-code caches"),
]
PRUNE_EXT = {".pyi": "type stubs", ".pdb": "debug symbols", ".c": "generated source",
             ".h": "generated headers", ".obj": "object files", ".lib": "link libraries",
             ".exp": "export files", ".a": "static libraries"}
# things that look droppable but are not
KEEP_NOTE = {"webview": "pywebview's JS and HTML live here — dropping it breaks the window",
             "clr_loader": "needed for the .NET/WinForms backend on Windows",
             "pythonnet": "same",
             "fastexcel": "the Excel reader",
             "polars": "the engine (the big .pyd is the Rust core — it cannot be trimmed)"}


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:,.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024
    return str(n)


def walk(root: Path) -> list[tuple[Path, int]]:
    out = []
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            p = Path(dirpath) / f
            try:
                out.append((p, p.stat().st_size))
            except OSError:
                pass
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    root = Path(sys.argv[1]).resolve()
    if not root.exists():
        print(f"{root} doesn't exist")
        return 2
    prune = "--prune" in sys.argv
    if root.name != "app.dist" and (root / "app.dist").exists():
        sib = root / "app.build"
        print(f"NOTE: {root} holds both app.dist (ships) and app.build (scratch).")
        if sib.exists():
            print(f"      app.build is {human(sum(s for _, s in walk(sib)))} and can be deleted after a build.\n")
        root = root / "app.dist"

    files = walk(root)
    total = sum(s for _, s in files)
    print(f"{root}\n{len(files):,} files, {human(total)}\n")

    tops: dict[str, int] = {}
    for p, s in files:
        rel = p.relative_to(root)
        tops[rel.parts[0] if len(rel.parts) > 1 else "(loose files)"] = \
            tops.get(rel.parts[0] if len(rel.parts) > 1 else "(loose files)", 0) + s
    print("Biggest parts:")
    for name, size in sorted(tops.items(), key=lambda x: -x[1])[:18]:
        note = next((v for k, v in KEEP_NOTE.items() if k in name.lower()), "")
        print(f"  {human(size):>10}  {size / total:5.1%}  {name}" + (f"   — {note}" if note else ""))

    print("\nBiggest single files:")
    for p, s in sorted(files, key=lambda x: -x[1])[:12]:
        print(f"  {human(s):>10}  {p.relative_to(root)}")

    hits: list[tuple[Path, int, str]] = []
    for p, s in files:
        rel = str(p.relative_to(root)).replace("\\", "/").lower()
        why = next((w for frag, w in PRUNABLE if frag in rel), None) or PRUNE_EXT.get(p.suffix.lower())
        if why:
            hits.append((p, s, why))
    if not hits:
        print("\nNothing obviously droppable — the size is real code.")
    else:
        by_why: dict[str, int] = {}
        for _p, s, why in hits:
            by_why[why] = by_why.get(why, 0) + s
        print(f"\nSafe to drop ({human(sum(s for _, s, _ in hits))} over {len(hits):,} files):")
        for why, size in sorted(by_why.items(), key=lambda x: -x[1]):
            print(f"  {human(size):>10}  {why}")
        if prune:
            freed = 0
            for p, s, _why in hits:
                try:
                    if p.is_dir():
                        shutil.rmtree(p, ignore_errors=True)
                    else:
                        p.unlink()
                    freed += s
                except OSError as exc:
                    print(f"  could not remove {p.name}: {exc}")
            print(f"\nRemoved {human(freed)} — now {human(total - freed)}.")
            print("Run ColSift.exe once to confirm it still starts.")
        else:
            print("\nRe-run with --prune to delete those, then start the exe once to check.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
