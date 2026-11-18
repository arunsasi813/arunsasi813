"""Windows PowerShell and schtasks, started with no window, for the parts of ColSift
that use what Windows already has (OCR, Task Scheduler). Elsewhere they say so."""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys

NO_WINDOW = 0x08000000          # CREATE_NO_WINDOW
TIMEOUT = 600


def windows() -> bool:
    return sys.platform.startswith("win")


def _decode(raw: bytes) -> str:
    """schtasks writes in the console's (OEM) code page."""
    if windows():
        try:
            import ctypes
            return raw.decode(f"cp{ctypes.windll.kernel32.GetOEMCP()}", "replace")
        except (AttributeError, LookupError, OSError):
            pass
    return raw.decode("utf-8", "replace")


def ps_quote(s: str) -> str:
    """A PowerShell single-quoted string."""
    return "'" + str(s).replace("'", "''") + "'"


def _first_error(err: str, default: str) -> str:
    lines = [x.strip() for x in err.splitlines()]
    msg = next((x for x in lines if x and not x.startswith(("At line", "+", "CategoryInfo", "FullyQualifiedErrorId"))), "")
    return (msg or default)[:400]


def powershell(script: str, what: str = "This", timeout: int = TIMEOUT) -> dict:
    """Run a Windows PowerShell script and read the JSON object it prints."""
    if not windows():
        return {"ok": False, "available": False, "error": f"{what} uses what is built into Windows — it runs in the Windows app."}
    exe = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    enc = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    try:
        cp = subprocess.run([exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
                            capture_output=True, timeout=timeout, creationflags=NO_WINDOW)
    except FileNotFoundError:
        return {"ok": False, "available": False, "error": f"Windows PowerShell was not found, so {what} can't run."}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"{what} took too long and was stopped."}
    out = cp.stdout.decode("utf-8", "replace").strip()
    if cp.returncode != 0 or not out:
        return {"ok": False, "error": _first_error(cp.stderr.decode("utf-8", "replace"), f"{what} failed")}
    try:
        return json.loads(out[out.index("{"):])
    except ValueError:
        return {"ok": False, "error": f"{what} answered something unexpected: {out[:200]}"}


def command(args: list[str], what: str = "This", timeout: int = 120) -> dict:
    """A Windows command (schtasks): {ok, out, error}."""
    if not windows():
        return {"ok": False, "error": f"{what} uses what is built into Windows — it runs in the Windows app."}
    try:
        cp = subprocess.run(args, capture_output=True, timeout=timeout, creationflags=NO_WINDOW)
    except FileNotFoundError:
        return {"ok": False, "error": f"{args[0]} was not found."}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"{what} took too long and was stopped."}
    out, err = _decode(cp.stdout).strip(), _decode(cp.stderr).strip()
    if cp.returncode != 0:
        return {"ok": False, "out": out, "error": _first_error(err or out, f"{what} failed")}
    return {"ok": True, "out": out}
