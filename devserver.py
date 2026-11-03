"""
Run the ColSift interface in an ordinary browser — for development and testing.

    python devserver.py                 (opens http://127.0.0.1:8765/?t=<token>)
    python devserver.py --port 9000 --no-browser

The page is the same ui.html the desktop app shows; its calls to window.pywebview.api
go over HTTP to the same Api class app.py uses. Progress callbacks are queued and
the page polls for them. Folder and save dialogs have no browser equivalent: type
the folder into the box, and saves go to --save-dir (default: a "saved" folder
beside this file).

Listens on 127.0.0.1 only and every request must carry the random token in the
URL, because the API reads and writes files. Not part of the desktop build.
"""

from __future__ import annotations

import argparse
import json
import secrets
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    import webview  # noqa: F401 — app.py imports it; the dev server never opens a window
except ImportError:          # no GUI toolkit here: a stand-in is enough for the Api class
    import sys
    import types
    sys.modules["webview"] = types.SimpleNamespace(windows=[])

import app

HERE = Path(__file__).resolve().parent
_EVENTS: list[dict] = []
_LOCK = threading.Lock()
TOKEN = secrets.token_urlsafe(16)
SAVE_DIR = HERE / "saved"

SHIM = """<script>
(() => {
  const T = new URLSearchParams(location.search).get("t") || "";
  const call = (name, args) => fetch(`/api/${name}?t=${T}`, {method: "POST", body: JSON.stringify(args)})
      .then(r => r.json());
  window.pywebview = {api: new Proxy({}, {get: (_, name) => (...args) => call(name, args)})};
  async function poll(){
    try {
      const ev = await (await fetch(`/events?t=${T}`)).json();
      for (const e of ev) { try { window[e.fn] && window[e.fn](e.payload); } catch (x) { console.error(x); } }
    } catch (x) {}
    setTimeout(poll, 250);
  }
  window.addEventListener("load", () => { window.dispatchEvent(new Event("pywebviewready")); poll(); });
})();
</script>"""


def _push(fn: str, payload) -> None:
    with _LOCK:
        _EVENTS.append({"fn": fn, "payload": json.loads(json.dumps(payload, default=str))})


class DevApi(app.Api):
    """The desktop Api, with the three native dialogs replaced."""

    def pick_folder(self, start: str = "") -> dict:
        return {"ok": True, "folder": ""}

    def save_dialog(self, p: dict) -> dict:
        SAVE_DIR.mkdir(exist_ok=True)
        return {"ok": True, "path": str(SAVE_DIR / (p.get("filename") or f"file_{int(time.time())}"))}

    def open_dialog(self, p: dict) -> dict:
        return {"ok": True, "paths": [str(x) for x in sorted(SAVE_DIR.glob("*.json"))] if SAVE_DIR.exists() else []}

    def open_path(self, path: str) -> dict:
        return {"ok": True}

    def open_file(self, path: str) -> dict:
        return {"ok": True}


API = DevApi()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _ok_token(self) -> bool:
        q = parse_qs(urlparse(self.path).query)
        if (q.get("t") or [""])[0] != TOKEN:
            self.send_error(403)
            return False
        return True

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._ok_token():
            return
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            html = (HERE / "ui.html").read_text(encoding="utf-8")
            html = html.replace("</head>", '<link rel="icon" href="data:,">\n</head>', 1)
            html = html.replace("<script>", SHIM + "\n<script>", 1)
            self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
        elif path == "/events":
            with _LOCK:
                out, _EVENTS[:] = list(_EVENTS), []
            self._send(200, json.dumps(out).encode("utf-8"), "application/json")
        else:
            self.send_error(404)

    def do_POST(self):
        if not self._ok_token():
            return
        name = urlparse(self.path).path.rsplit("/", 1)[-1]
        fn = getattr(API, name, None)
        if name.startswith("_") or not callable(fn):
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length") or 0)
        args = json.loads(self.rfile.read(n) or b"[]")
        res = fn(*args)
        self._send(200, json.dumps(res, default=str).encode("utf-8"), "application/json")


def main() -> None:
    global SAVE_DIR
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--save-dir", default=str(SAVE_DIR))
    ap.add_argument("--token", default="", help="fixed token (tests)")
    a = ap.parse_args()
    global TOKEN
    if a.token:
        TOKEN = a.token
    SAVE_DIR = Path(a.save_dir)
    app._js = _push                                   # progress and run results -> the poll queue
    threading.Thread(target=app._load_modules, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    url = f"http://127.0.0.1:{a.port}/?t={TOKEN}"
    print(f"ColSift dev server: {url}", flush=True)
    if not a.no_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
