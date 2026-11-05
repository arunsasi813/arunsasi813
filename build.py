"""Build ColSift into a small, fast-starting executable with Nuitka.

    python build.py                     one compressed ColSift.exe (default)
    python build.py --mode standalone   a folder: fastest start, larger on disk
    python build.py --cli               also colsift-cli.exe for scheduled runs
    python build.py --lean              drop the openpyxl fallback too (~10 MB less)
    python build.py --check             only check the environment, build nothing
    python build.py --company "Acme Ltd"   the publisher name shown in the exe's properties

Signing (so Windows SmartScreen shows a publisher instead of "unrecognised app";
see README "Sharing the exe"): set one of these before building and every exe is
signed when it is built —
    COLSIFT_SIGN_PFX=C:\certs\code.pfx  COLSIFT_SIGN_PASSWORD=...   signtool with a .pfx
    COLSIFT_SIGN_CMD=<command with {file}>   any signing tool, e.g. a cloud HSM's CLI
    COLSIFT_SIGN_TIMESTAMP=<url>             timestamp server (default DigiCert's)

build.bat runs this inside a clean virtual environment, which is the single biggest
size saving: Nuitka follows every import it can see, and a Python that also has
pandas, pyarrow, numpy, matplotlib or Qt installed hands it hundreds of MB to follow.

What makes the result small
  * --onefile compresses the whole program with zstd into one exe (roughly a third
    of the folder's size); first start unpacks it once into a cache folder, later
    starts reuse that copy.
  * The packages ColSift never imports are excluded by name (the list depscan.py
    measures), and pywebview's Qt / GTK / macOS backends are never followed.
  * --remove-output deletes Nuitka's scratch folder (<name>.build: C files, objects),
    which is routinely larger than the program and was most of a "1.5 GB build".
  * xlsxwriter is not shipped — ColSift writes .xlsx itself. openpyxl stays as the
    reader of last resort for odd workbooks unless --lean.

Everything else in the build folder is the program: polars' Rust core (~100 MB
before compression) is irreducible.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
VERSION = "2.2.0"

# never imported by ColSift (depscan.py measures this; re-run it after adding features)
EXCLUDE = ["pandas", "pyarrow", "numpy", "matplotlib", "scipy", "IPython", "PIL", "sqlalchemy",
           "connectorx", "deltalake", "dask", "numba", "altair", "great_tables", "xlsx2csv",
           "fsspec", "cloudpickle", "pytest", "setuptools", "pip", "tkinter", "unittest",
           "pydoc_data", "lib2to3", "distutils", "xlsxwriter", "hvplot", "plotly", "torch",
           "jax", "pydantic", "gevent", "adbc_driver_manager", "pyiceberg", "boto3", "botocore",
           "google", "azure", "s3fs", "gcsfs", "adlfs", "polars.testing", "polars.ml",
           # GUI toolkits pywebview can use elsewhere — never on Windows, and Qt alone is ~100 MB.
           # Its own webview.platforms.* modules are left to Nuitka's pywebview plugin, which
           # drops the unused ones itself and refuses a build that names them here too.
           "PyQt5", "PyQt6", "PySide2", "PySide6", "qtpy", "gi", "cefpython3"]
HEAVY_INSTALLED = ["pandas", "pyarrow", "numpy", "matplotlib", "scipy", "PyQt5", "PyQt6", "PySide6"]
MODULES = ["engine", "formula", "xlsxfast", "analysis", "workspace", "checks", "pdfout", "worker"]


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:,.1f} {unit}"
        n /= 1024
    return str(n)


def size_of(p: Path) -> int:
    if p.is_file():
        return p.stat().st_size
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def nuitka_version() -> tuple[int, ...] | None:
    try:
        out = subprocess.run([sys.executable, "-m", "nuitka", "--version"], capture_output=True, text=True,
                             timeout=120).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    first = (out.strip().splitlines() or [""])[0].strip()
    try:
        return tuple(int(x) for x in first.split(".")[:3])
    except ValueError:
        return None


def check(lean: bool, gui: bool) -> list[str]:
    """Problems that would break the build, and warnings that would bloat it."""
    problems, warn = [], []
    if sys.version_info < (3, 9):
        problems.append("Python 3.9 or newer is needed.")
    need = ["polars", "fastexcel"] + (["webview"] if gui else []) + ([] if lean else ["openpyxl"])
    for mod in need:
        if importlib.util.find_spec(mod) is None:
            problems.append(f"{mod} is not installed in this Python — pip install -r requirements.txt")
    if nuitka_version() is None:
        problems.append("Nuitka is not installed — pip install -r requirements-build.txt")
    heavy = [m for m in HEAVY_INSTALLED if importlib.util.find_spec(m) is not None]
    if heavy:
        warn.append("Installed here but not needed: " + ", ".join(heavy) + ". They are excluded, "
                    "but a clean environment (build.bat does it) is the safer way to a small build.")
    if sys.platform.startswith("win") and gui and importlib.util.find_spec("clr_loader") is None:
        problems.append("pywebview's Windows backend (pythonnet / clr_loader) is missing — pip install pywebview")
    for w in warn:
        print(f"  note: {w}")
    return problems


def nuitka_cmd(target: str, mode: str, out: Path, name: str, gui: bool, lean: bool, jobs: int | None,
               company: str = "ColSift") -> list[str]:
    v = nuitka_version() or (0,)
    cmd = [sys.executable, "-m", "nuitka"]
    cmd += [f"--mode={mode}"] if v >= (2, 5) else (["--standalone"] + (["--onefile"] if mode == "onefile" else []))
    cmd += ["--assume-yes-for-downloads", "--remove-output", f"--output-dir={out}", f"--output-filename={name}",
            "--python-flag=no_asserts"]
    if jobs:
        cmd.append(f"--jobs={jobs}")
    cmd += [f"--include-module={m}" for m in MODULES]
    if "_json" not in sys.builtin_module_names:
        # Nuitka's anti-bloat leaves the C json speedups out where they are a separate
        # extension; every result crosses the window bridge as JSON, so keep them
        cmd.append("--include-module=_json")
    cmd += ["--include-package=fastexcel"]
    excl = list(EXCLUDE) + (["openpyxl", "et_xmlfile"] if lean else [])
    if not gui:
        excl += ["webview", "clr_loader", "pythonnet", "bottle", "proxy_tools"]
    cmd += [f"--nofollow-import-to={m}" for m in excl]
    cmd += ["--noinclude-pytest-mode=nofollow", "--noinclude-setuptools-mode=nofollow",
            "--noinclude-IPython-mode=nofollow", "--noinclude-unittest-mode=nofollow"]
    if gui:
        cmd += ["--include-data-files=ui.html=ui.html", "--include-data-files=studio.html=studio.html",
                "--include-package-data=webview"]
        if sys.platform.startswith("win"):
            cmd += ["--windows-console-mode=disable", "--include-package=clr_loader",
                    "--include-package-data=clr_loader", "--include-package-data=pythonnet"]
    elif sys.platform.startswith("win"):
        cmd += ["--windows-console-mode=force"]
    if mode == "onefile":
        # a fixed unpack folder per version: the first start unpacks, later ones reuse it
        cmd += ["--onefile-tempdir-spec={CACHE_DIR}/ColSift/" + VERSION + ("" if gui else "-cli")]
    if sys.platform.startswith("win"):
        cmd += [f"--company-name={company}", "--product-name=ColSift", f"--file-version={VERSION}",
                f"--product-version={VERSION}", f"--copyright=© {time.strftime('%Y')} {company}",
                "--file-description=" + ("Column extractor for large text and Excel extracts" if gui
                                         else "ColSift command line")]
        if (HERE / "colsift.ico").exists():
            cmd.append("--windows-icon-from-ico=colsift.ico")
    cmd.append(target)
    return cmd


def signtool() -> str | None:
    """signtool.exe: on PATH, or the newest Windows SDK's."""
    found = shutil.which("signtool")
    if found:
        return found
    kits = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Windows Kits" / "10" / "bin"
    tools = sorted(kits.glob("10.*/x64/signtool.exe")) if kits.is_dir() else []
    return str(tools[-1]) if tools else None


def sign(exe: Path) -> str:
    """Authenticode-sign one exe when the environment says how; returns what happened."""
    cmd_tpl = os.environ.get("COLSIFT_SIGN_CMD", "").strip()
    pfx = os.environ.get("COLSIFT_SIGN_PFX", "").strip()
    stamp = os.environ.get("COLSIFT_SIGN_TIMESTAMP", "").strip() or "http://timestamp.digicert.com"
    if cmd_tpl:
        subprocess.run(cmd_tpl.replace("{file}", str(exe)), shell=True, check=True)
        return "signed (COLSIFT_SIGN_CMD)"
    if pfx:
        tool = signtool()
        if not tool:
            raise SystemExit("COLSIFT_SIGN_PFX is set but signtool.exe was not found (install the Windows SDK)")
        cmd = [tool, "sign", "/fd", "SHA256", "/tr", stamp, "/td", "SHA256", "/f", pfx]
        if os.environ.get("COLSIFT_SIGN_PASSWORD"):
            cmd += ["/p", os.environ["COLSIFT_SIGN_PASSWORD"]]
        subprocess.run(cmd + [str(exe)], check=True)
        return "signed (signtool)"
    return "not signed"


def build(target: str, mode: str, out: Path, name: str, gui: bool, lean: bool, jobs: int | None,
          company: str = "ColSift") -> Path:
    cmd = nuitka_cmd(target, mode, out, name, gui, lean, jobs, company)
    print("\n$ " + " ".join(cmd) + "\n", flush=True)
    t0 = time.time()
    subprocess.run(cmd, cwd=str(HERE), check=True)
    stem = Path(target).stem
    for leftover in (out / f"{stem}.build", out / f"{stem}.onefile-build"):
        shutil.rmtree(leftover, ignore_errors=True)          # older Nuitka ignores --remove-output for these
    result = out / name if mode == "onefile" else out / f"{stem}.dist"
    if mode == "onefile" and not result.exists():
        result = next((p for p in out.iterdir() if p.name.startswith(Path(name).stem) and p.is_file()), result)
    print(f"\nBuilt {result} in {time.time() - t0:,.0f}s — {human(size_of(result))}", flush=True)
    if sys.platform.startswith("win"):
        exe = result if result.is_file() else result / name
        if exe.exists():
            print(f"{exe.name}: {sign(exe)}", flush=True)
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--mode", choices=["onefile", "standalone"], default="onefile")
    ap.add_argument("--cli", action="store_true", help="also build colsift-cli for scheduled runs")
    ap.add_argument("--cli-only", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--lean", action="store_true", help="drop openpyxl (reader of last resort)")
    ap.add_argument("--out", default="dist")
    ap.add_argument("--jobs", type=int, default=None)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--company", default=os.environ.get("COLSIFT_COMPANY") or "ColSift",
                    help="publisher name in the exe's properties (or COLSIFT_COMPANY)")
    a = ap.parse_args()
    exe = ".exe" if sys.platform.startswith("win") else ""
    out = HERE / a.out
    print(f"ColSift {VERSION} build — Python {sys.version.split()[0]}, Nuitka "
          f"{'.'.join(map(str, nuitka_version() or ('missing',)))}, {a.mode}")
    problems = check(a.lean, gui=not a.cli_only)
    if problems:
        print("\nCannot build:\n  " + "\n  ".join(problems))
        return 2
    if a.check:
        print("Environment looks fine.")
        return 0
    out.mkdir(exist_ok=True)
    made = []
    if not a.cli_only:
        made.append(build("app.py", a.mode, out, f"ColSift{exe}", True, a.lean, a.jobs, a.company))
    if a.cli or a.cli_only:
        made.append(build("engine.py", a.mode, out, f"colsift-cli{exe}", False, a.lean, a.jobs, a.company))
    print("\nDone:")
    for m in made:
        print(f"  {human(size_of(m)):>10}  {m}")
    if a.mode == "standalone":
        print("\nShip the whole .dist folder. `python buildsize.py <folder>` shows what is inside.")
    else:
        print("\nOne file to hand around. The first start unpacks into %LOCALAPPDATA%\\ColSift\\" + VERSION +
              " (a few seconds); later starts reuse it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
