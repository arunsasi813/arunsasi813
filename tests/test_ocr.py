"""ocr.py: what it asks Windows PowerShell, and how it reads the answer. The engine itself
is Windows' own (checked by the exe's self-test on Windows); here `_run` is a stand-in."""

import base64
import sys

import pytest

import ocr


def test_elsewhere_than_windows_it_says_so(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    r = ocr.available()
    assert r["ok"] is False and r["available"] is False and "Windows" in r["error"]
    assert ocr.read(["a.png"])["ok"] is False


def test_no_images_no_powershell(monkeypatch):
    monkeypatch.setattr(ocr, "_run", lambda s: pytest.fail("PowerShell started for nothing"))
    assert ocr.read([]) == {"ok": True, "pages": []}


def test_paths_and_language_are_quoted_for_powershell(monkeypatch):
    seen = {}

    def run(script):
        seen["script"] = script
        return {"ok": True, "pages": []}
    monkeypatch.setattr(ocr, "_run", run)
    ocr.read([r"C:\Temp\it's here.png", r"D:\b.png"], "en-GB")
    head = seen["script"].splitlines()[:2]
    assert head == [r"$paths = @('C:\Temp\it''s here.png', 'D:\b.png')", "$lang = 'en-GB'"]
    ocr.read(["x.png"])
    assert seen["script"].splitlines()[1] == "$lang = $null"
    assert "RecognizeAsync" in seen["script"]


def test_single_items_come_back_as_lists(monkeypatch):
    # ConvertTo-Json writes a one-item array as the item itself
    one = {"ok": True, "pages": {"width": 10, "height": 20, "lines": {"text": "A1", "words": {"t": "A1", "x": 1, "y": 2, "w": 3, "h": 4}}}}
    monkeypatch.setattr(ocr, "_run", lambda s: one)
    r = ocr.read(["a.png"])
    assert r["pages"][0]["lines"][0]["words"] == [{"t": "A1", "x": 1, "y": 2, "w": 3, "h": 4}]
    monkeypatch.setattr(ocr, "_run", lambda s: {"ok": True, "pages": [{"width": 1, "height": 1, "lines": None}]})
    assert ocr.read(["a.png"])["pages"][0]["lines"] == []


def test_no_language_installed_is_explained(monkeypatch):
    monkeypatch.setattr(ocr, "_run", lambda s: {"ok": True, "available": False, "languages": []})
    r = ocr.available()
    assert r["available"] is False and "optical character recognition" in r["error"]


def test_powershell_gets_an_encoded_script_and_no_window(monkeypatch):
    import subprocess
    calls = {}

    class Done:
        returncode = 0
        stdout = b'WARNING: noise\r\n{"ok": true, "available": true, "languages": ["en-US"], "max": 10000}'
        stderr = b""

    def fake_run(args, **kw):
        calls["args"], calls["kw"] = args, kw
        return Done()
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(subprocess, "run", fake_run)
    r = ocr.available()
    assert r == {"ok": True, "available": True, "languages": ["en-US"], "max": 10000}
    args = calls["args"]
    assert args[0].lower().endswith("powershell.exe") and args[-2] == "-EncodedCommand"
    assert "OcrEngine" in base64.b64decode(args[-1]).decode("utf-16-le")
    assert calls["kw"]["creationflags"] == 0x08000000


def test_a_powershell_error_is_reported(monkeypatch):
    import subprocess

    class Failed:
        returncode = 1
        stdout = b""
        stderr = b"Exception calling \"Invoke\": The file is not an image.\r\nAt line:12 char:3\r\n+ ...\r\n"
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: Failed())
    r = ocr.read(["a.png"])
    assert r["ok"] is False and "not an image" in r["error"]


def test_the_app_deletes_its_page_images(tmp_path, monkeypatch):
    import tempfile

    import app
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(ocr, "_run", lambda s: {"ok": True, "pages": [{"width": 1, "height": 1, "lines": []}]})
    api = app.Api()
    b = api.file_save_begin({"temp": True, "filename": "../../page.png"})
    assert b["ok"] and b["path"] == str(tmp_path / "colsift-ocr" / "page.png")
    api.file_save_chunk({"token": b["token"], "b64": base64.b64encode(b"\x89PNG").decode()})
    path = api.file_save_end({"token": b["token"]})["path"]
    other = tmp_path / "keep.png"
    other.write_bytes(b"x")
    r = api.ocr_read({"paths": [path, str(other)], "cleanup": True})
    assert r["ok"] and not (tmp_path / "colsift-ocr" / "page.png").exists() and other.exists()
