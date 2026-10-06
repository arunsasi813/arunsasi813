"""
Test bridge: serves a base folder over HTTP and exposes the real LauncherAPI
the way pywebview does (window.pywebview.api.<method>(...) -> Promise).

    python tests/e2e/bridge_server.py <root> <port> [--legacy] [--jv-port N]

GET  /<path>               static file from <root>
GET  /__hub                the hub page (main.HUB_HTML)
GET  /__shim.js            defines window.pywebview.api and fires pywebviewready
POST /__api/<method>       {"args": [...]} -> {"ok": true, "result": ...}
GET  /__log                JSON list of bridge calls made so far
POST /__reset_log

--legacy   expose only the methods an older launcher had (no list_files,
           append_csv_rows, resolve_url, write_file_b64_abs ...)
--jv-port  serve <root> on a second port too; resolve_url() answers with that
           origin so the Special JV iframe is cross-origin, like file:// pages
           are in Chromium (exercises the postMessage handshake).
"""

import json
import os
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2]))
import main  # noqa: E402

LEGACY_METHODS = [
    "read_file", "write_file", "load_master", "save_master", "load_templates", "save_template",
    "delete_template", "list_directories", "list_folder_files", "save_attachment", "read_attachment",
    "delete_attachment", "current_username", "return_to_hub", "path_exists", "show_save_dialog",
    "write_file_abs", "verify_admin_password",
]

root = Path(sys.argv[1]).resolve()
port = int(sys.argv[2])
legacy = "--legacy" in sys.argv
jv_port = int(sys.argv[sys.argv.index("--jv-port") + 1]) if "--jv-port" in sys.argv else None
cfg_path = root.parent / f"cfg_{port}.json"
if not cfg_path.exists():
    cfg_path.write_text(json.dumps({"folder_path": str(root)}))
api = main.LauncherAPI(config_path=cfg_path)
downloads = root.parent / f"downloads_{port}"
downloads.mkdir(exist_ok=True)
calls = []
calls_lock = threading.Lock()
state = {"hub_returns": 0}


def resolve_url(rel):
    for cand in (rel, "apps/" + rel):
        p = root / cand
        if p.is_file():
            host = jv_port or port
            return f"http://127.0.0.1:{host}/{cand}"
    return ""


def show_save_dialog(filename="", file_types=None):
    return str(downloads / (filename or "download.bin"))


def return_to_hub():
    state["hub_returns"] += 1
    return True


OVERRIDES = {"resolve_url": resolve_url, "show_save_dialog": show_save_dialog, "return_to_hub": return_to_hub}


def public_methods():
    names = [n for n in dir(api) if not n.startswith("_") and callable(getattr(api, n))]
    if legacy:
        names = [n for n in names if n in LEGACY_METHODS]
    return sorted(set(names))


SHIM = """
(function () {
  var names = %s;
  var api = {};
  names.forEach(function (n) {
    api[n] = function () {
      var args = Array.prototype.slice.call(arguments);
      return fetch('/__api/' + n, { method: 'POST', body: JSON.stringify({ args: args }) })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (!j.ok) throw new Error(j.error); return j.result; });
    };
  });
  window.pywebview = { api: api };
  setTimeout(function () { window.dispatchEvent(new Event('pywebviewready')); }, 30);
})();
"""


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(root), **kw)

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path == "/__shim.js":
            body = (SHIM % json.dumps(public_methods())).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/__hub":
            body = main.HUB_HTML.replace("<script>", '<script src="/__shim.js"></script><script>', 1).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/__log":
            with calls_lock:
                return self._json({"calls": list(calls), "hub_returns": state["hub_returns"],
                                   "folder": api.folder_path})
        return super().do_GET()

    def do_POST(self):
        if self.path == "/__reset_log":
            with calls_lock:
                calls.clear()
            return self._json({"ok": True})
        if not self.path.startswith("/__api/"):
            return self._json({"ok": False, "error": "not found"}, 404)
        name = self.path[len("/__api/"):]
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        args = payload.get("args", [])
        with calls_lock:
            calls.append({"method": name, "arg0": args[0] if args and isinstance(args[0], str) else None})
        if name not in public_methods():
            return self._json({"ok": False, "error": f"no such bridge method {name}"})
        fn = OVERRIDES.get(name) or getattr(api, name)
        try:
            return self._json({"ok": True, "result": fn(*args)})
        except Exception as exc:  # surfaced to JS as a rejected promise
            return self._json({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


# Bind both sockets before announcing READY, so a busy port fails loudly.
main_srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
if jv_port:
    jv_srv = ThreadingHTTPServer(("127.0.0.1", jv_port), Handler)
    threading.Thread(target=jv_srv.serve_forever, daemon=True).start()
print("READY", flush=True)
main_srv.serve_forever()
