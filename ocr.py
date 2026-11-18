"""OCR with the engine Windows already has (Windows.Media.Ocr) — nothing to install,
nothing added to the exe. Windows PowerShell reaches the WinRT engine; one PowerShell
process reads a batch of images.

    available()              {"ok", "available", "languages": ["en-US", …], "error"}
    read(paths, lang=None)   {"ok", "pages": [{"width", "height", "lang", "angle",
                              "lines": [{"text", "words": [{"t", "x", "y", "w", "h"}]}]}]}

Coordinates are pixels of the image, from its top-left corner. Elsewhere than Windows,
or with no OCR language installed, `available` says so and `read` returns the reason.
Tests replace `_run` with a stand-in.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys

TIMEOUT = 600

_PRELUDE = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $task.Wait(-1)
  $task.Result
}
"""

_INFO = _PRELUDE + r"""
$langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
[ordered]@{ ok = $true; available = ($langs.Count -gt 0); languages = $langs;
            max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension } | ConvertTo-Json -Compress
"""

_READ = _PRELUDE + r"""
if ($lang) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($lang)) }
else { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw 'No OCR language is installed: Settings > Time & language > Language, add a language with its optical character recognition feature.' }
$pages = foreach ($path in $paths) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @(foreach ($l in $result.Lines) {
    [ordered]@{ text = $l.Text; words = @(foreach ($w in $l.Words) {
      $r = $w.BoundingRect; [ordered]@{ t = $w.Text; x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height } }) } })
  $stream.Dispose()
  [ordered]@{ width = $bitmap.PixelWidth; height = $bitmap.PixelHeight; lang = $engine.RecognizerLanguage.LanguageTag;
              angle = $result.TextAngle; lines = $lines }
}
[ordered]@{ ok = $true; pages = @($pages) } | ConvertTo-Json -Depth 8 -Compress
"""


def _ps_quote(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def _run(script: str) -> dict:
    """Run a Windows PowerShell script, no window, and read the JSON it prints."""
    if not sys.platform.startswith("win"):
        return {"ok": False, "available": False,
                "error": "OCR uses the engine built into Windows — it runs in the Windows app."}
    exe = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    enc = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    try:
        cp = subprocess.run([exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
                            capture_output=True, timeout=TIMEOUT, creationflags=0x08000000)   # CREATE_NO_WINDOW
    except FileNotFoundError:
        return {"ok": False, "available": False, "error": "Windows PowerShell was not found, so the Windows OCR engine can't be reached."}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "OCR took too long and was stopped."}
    out = cp.stdout.decode("utf-8", "replace").strip()
    if cp.returncode != 0 or not out:
        err = cp.stderr.decode("utf-8", "replace").strip().splitlines()
        msg = next((x for x in err if x.strip() and not x.startswith(("At line", "+", "    +"))), "") or "OCR failed"
        return {"ok": False, "error": msg.strip()[:400]}
    try:
        return json.loads(out[out.index("{"):])
    except ValueError:
        return {"ok": False, "error": f"OCR answered something unexpected: {out[:200]}"}


def available() -> dict:
    r = _run(_INFO)
    if r.get("ok") and not r.get("available"):
        r["error"] = ("Windows has no OCR language installed: Settings > Time & language > Language — add a language "
                      "and its optical character recognition feature.")
    return r


def read(paths: list[str], lang: str | None = None) -> dict:
    paths = [str(p) for p in paths or []]
    if not paths:
        return {"ok": True, "pages": []}
    head = f"$paths = @({', '.join(_ps_quote(p) for p in paths)})\n$lang = {_ps_quote(lang) if lang else '$null'}\n"
    r = _run(head + _READ)
    if r.get("ok"):
        pages = r.get("pages") or []
        r["pages"] = pages if isinstance(pages, list) else [pages]
        for pg in r["pages"]:
            ls = pg.get("lines") or []
            pg["lines"] = ls if isinstance(ls, list) else [ls]
            for ln in pg["lines"]:
                ws = ln.get("words") or []
                ln["words"] = ws if isinstance(ws, list) else [ws]
    return r
