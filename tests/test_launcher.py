import base64
import csv
import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import folder_manager as fm  # noqa: E402
import main  # noqa: E402


@pytest.fixture
def root(tmp_path, monkeypatch):
    r = tmp_path / "root"
    (r / "apps").mkdir(parents=True)
    (r / "apps" / "Reco.html").write_text("<html></html>")
    (r / "apps" / "Secret.html").write_text("<html></html>")
    (r / "master").mkdir()
    (r / "master" / "user.csv").write_text("ID,Name,Email,reco,secret\r\ntester,Test User,t@x.com,1,0\r\n")
    monkeypatch.setattr(main, "_os_user", lambda: "tester")
    return r


@pytest.fixture
def api(root, tmp_path):
    cfg = tmp_path / "launcher_config.json"
    cfg.write_text(json.dumps({"folder_path": str(root)}))
    return main.LauncherAPI(config_path=cfg)


def test_legacy_config_keys(tmp_path, root):
    cfg = tmp_path / "c.json"
    cfg.write_text(json.dumps({"folder": str(root)}))
    a = main.LauncherAPI(config_path=cfg)
    assert fm.same_path(a.folder_path, str(root))
    assert a.data_root == a.folder_path  # attachment code used data_root


def test_init_app_auto_login_and_access(api):
    s = api.init_app()
    assert s["configured"] and s["folder_ok"]
    assert s["user"]["name"] == "Test User"
    assert [a["key"] for a in s["apps"]] == ["reco"]
    assert s["hidden_apps"] == 1
    assert api.current_username() == "Test User"
    assert not api.open_app("secret")["ok"]
    assert api.open_app("reco")["ok"]


def test_current_username_without_hub(api):
    # An app reloaded on its own still gets the signed-in name, not the OS login.
    assert api.current_username() == "Test User"


def test_switch_user_disables_auto_login(api):
    api.init_app()
    s = api.logout()
    assert s["user"] is None
    assert api.init_app()["user"] is None
    assert api.login("t@x.com")["ok"]


def test_paths_cannot_escape_root(api, root):
    with pytest.raises(ValueError):
        api.read_file("../launcher_config.json")
    with pytest.raises(ValueError):
        api.write_file("../evil.txt", "x")
    with pytest.raises(ValueError):
        api.write_file("C:/Windows/evil.txt", "x")
    assert api.write_file("/reco/a.json", "{}")  # leading slash = ROOT-relative
    assert (root / "reco" / "a.json").exists()


def test_write_read_roundtrip_atomic(api, root):
    assert api.write_file("reco/recoSessions.json", '{"x": "é"}')
    assert api.read_file("reco/recoSessions.json") == '{"x": "é"}'
    assert not list(root.rglob("*.tmp"))
    assert api.read_file("reco/missing.json") == ""


def test_read_file_raises_when_share_unreachable(api, root, tmp_path):
    # A missing file is "" (start empty); an unreachable share must raise so the
    # app does not later overwrite the real file with an empty copy.
    api.folder_path = str(tmp_path / "offline_share")
    with pytest.raises(OSError):
        api.read_file("reco/recoSessions.json")


def test_list_return_types(api, root):
    (root / "reco_data" / "T" / "Oct-26").mkdir(parents=True)
    (root / "reco_data" / "T" / "Oct-26" / "06.csv").write_text("a\r\n")
    assert api.list_directories("reco_data/T") == ["Oct-26"]
    files = api.list_files("reco_data/T/Oct-26")
    assert files[0]["name"] == "06.csv" and files[0]["ext"] == "csv"
    legacy = api.list_folder_files("reco_data/T/Oct-26")
    assert isinstance(legacy, str) and json.loads(legacy)[0]["name"] == "06.csv"
    assert api.list_directories("does/not/exist") == []


def test_append_csv_rows(api, root):
    rel = "reco_data/T/Oct-26/06.csv"
    assert api.append_csv_rows(rel, ["_pk", "_ver", "Amt"], [{"_pk": "1", "_ver": "upload", "Amt": 5}]) == 1
    assert api.append_csv_rows(rel, ["_pk", "_ver", "Amt"], [{"_pk": "1", "_ver": "C1", "Amt": 6.5}]) == 1
    rows = list(csv.DictReader(io.StringIO(api.read_file(rel))))
    assert [r["_ver"] for r in rows] == ["upload", "C1"]
    assert rows[1]["Amt"] == "6.5"
    # A new column triggers one rewrite with the union header; nothing is lost.
    api.append_csv_rows(rel, ["_pk", "_ver", "Amt", "Note"], [{"_pk": "2", "_ver": "upload", "Amt": 1, "Note": "a,b"}])
    rows = list(csv.DictReader(io.StringIO(api.read_file(rel))))
    assert len(rows) == 3 and rows[0]["Note"] == "" and rows[2]["Note"] == "a,b"
    # File without a trailing newline (e.g. written by Papa.unparse) still appends cleanly.
    p = root / rel
    p.write_text("_pk,_ver,Amt\r\n1,upload,5", encoding="utf-8", newline="")
    api.append_csv_rows(rel, ["_pk", "_ver", "Amt"], [{"_pk": "1", "_ver": "C1", "Amt": 7}])
    rows = list(csv.DictReader(io.StringIO(api.read_file(rel))))
    assert [r["Amt"] for r in rows] == ["5", "7"]


def test_attachments_use_relative_paths(api, root):
    b64 = base64.b64encode(b"hello pdf").decode()
    rec = api.save_attachment("tpl/1", "inv:oice?.pdf", b64)
    assert rec["storedPath"].startswith("reco_attachments/tpl_1/")
    assert not Path(rec["storedPath"]).is_absolute()
    assert rec["size"] == 9
    assert base64.b64decode(api.read_attachment(rec["storedPath"])) == b"hello pdf"
    # Legacy absolute path inside ROOT still readable
    assert api.read_attachment(str(root / rec["storedPath"]))
    assert api.delete_attachment(rec["storedPath"])
    assert api.read_attachment(rec["storedPath"]) is None


def test_templates_and_master(api):
    api.save_template("t1", json.dumps({"id": "t1", "name": "One"}))
    api.save_template("t2", json.dumps({"id": "t2", "name": "Two"}))
    assert [t["id"] for t in api.load_templates()] == ["t1", "t2"]
    api.delete_template("t1")
    assert [t["id"] for t in api.load_templates()] == ["t2"]
    api.save_master("Reference,RC\r\nA,1\r\n")
    assert api.load_master().startswith("Reference,RC")


def test_resolve_url_checks_root_and_apps(api, root):
    (root / "special_jv_templates").mkdir()
    (root / "special_jv_templates" / "TCH.html").write_text("x")
    assert api.resolve_url("special_jv_templates/TCH.html").startswith("file:")
    (root / "apps" / "special_jv_templates").mkdir()
    (root / "apps" / "special_jv_templates" / "ABC.html").write_text("x")
    assert api.resolve_url("special_jv_templates/ABC.html").endswith("/apps/special_jv_templates/ABC.html")
    assert api.resolve_url("special_jv_templates/NONE.html") == ""


def test_admin_password(api, root):
    assert api.verify_admin_password("admin123")  # default when pwd.txt is absent
    (root / "pwd.txt").write_text("s3cret\n")
    assert not api.verify_admin_password("admin123")
    assert api.verify_admin_password("s3cret")


def test_set_base_folder(api, root, tmp_path):
    other = tmp_path / "other"
    other.mkdir()
    r = api.set_base_folder(str(other), "wrong")
    assert not r["ok"] and "password" in r["error"]
    r = api.set_base_folder(str(other), "admin123")
    assert not r["ok"] and r["needs_init"]
    r = api.set_base_folder(str(other), "admin123", True)
    assert r["ok"] and "master/user.csv" in r["created"]
    assert fm.same_path(api.folder_path, str(other))
    cfg = json.loads((tmp_path / "launcher_config.json").read_text())
    assert fm.same_path(cfg["folder_path"], str(other))
    assert any(fm.same_path(f, str(root)) for f in cfg["recent_folders"])
    # new user.csv grants the OS user every app found in apps/ (none here -> reco)
    assert "reco" in (other / "master" / "user.csv").read_text()


def test_migration_via_bridge_switches_and_leaves_pointer(api, root, tmp_path):
    api.write_file("reco/recoSessions.json", '{"s": 1}')
    api.save_attachment("tpl", "a.txt", base64.b64encode(b"att").decode())
    dest = tmp_path / "moved"
    pre = api.preflight_migration(str(dest), "admin123")
    assert pre["ok"] and pre["total_files"] >= 5
    r = api.start_migration(str(dest), "admin123", {"conflict": "abort"})
    assert r["ok"], r
    api._migration.join(10)
    st = api.migration_status()
    assert st["state"] == "done" and st["switched"], st
    assert fm.same_path(api.folder_path, str(dest))
    # Relative attachment paths keep working after the move.
    att = [p for p in (dest / "reco_attachments" / "tpl").iterdir()][0]
    assert api.read_attachment("reco_attachments/tpl/" + att.name)
    assert api.read_file("reco/recoSessions.json") == '{"s": 1}'
    # Another launcher still pointing at the old folder is offered the new one.
    other = main.LauncherAPI(config_path=tmp_path / "other_cfg.json")
    other.folder_path = str(root)
    assert other.init_app()["pointer"]["new_folder"]
    assert other.follow_pointer()["ok"]
    assert fm.same_path(other.folder_path, str(dest))


def test_migration_requires_password(api, tmp_path):
    r = api.start_migration(str(tmp_path / "x"), "nope", {})
    assert not r["ok"]


def test_hub_html_is_self_contained():
    html = main.HUB_HTML
    assert "pywebviewready" in html and "start_migration" in html and "set_base_folder" in html
    assert "http://" not in html and "https://" not in html  # works offline


class _FakeWindow:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def create_file_dialog(self, dialog_type, **kw):
        self.calls.append((dialog_type, kw))
        return self.result


def _fake_webview(monkeypatch, with_enum):
    import types
    wv = types.ModuleType("webview")
    if with_enum:
        wv.FileDialog = types.SimpleNamespace(FOLDER="folder-enum", SAVE="save-enum", OPEN="open-enum")
    else:
        wv.FOLDER_DIALOG, wv.SAVE_DIALOG = 20, 30
    monkeypatch.setitem(sys.modules, "webview", wv)


@pytest.mark.parametrize("with_enum,expected", [(True, "folder-enum"), (False, 20)])
def test_browse_folder_dialog_constants(api, root, monkeypatch, with_enum, expected):
    _fake_webview(monkeypatch, with_enum)
    win = _FakeWindow((str(root),))
    api._set_window(win)
    assert fm.same_path(api.browse_folder(), str(root))
    assert win.calls[0][0] == expected


def test_save_dialog_returns_plain_path(api, monkeypatch, tmp_path):
    _fake_webview(monkeypatch, True)
    api._set_window(_FakeWindow(str(tmp_path / "out.csv")))   # some platforms return a str
    assert api.show_save_dialog("out.csv").endswith("out.csv")
    api._set_window(_FakeWindow(None))                          # cancelled
    assert api.show_save_dialog("out.csv") == ""
