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


def test_admin_password_is_not_reachable_through_the_file_bridge(api, root):
    """pwd.txt gates the base-folder change. If page JS could read it, the gate
    would be worthless, so the generic file bridge must refuse it."""
    (root / "pwd.txt").write_text("superSecret123")
    for call in (lambda: api.read_file("pwd.txt"),
                 lambda: api.read_file("./pwd.txt"),
                 lambda: api.read_file("PWD.TXT"),
                 lambda: api.write_file("pwd.txt", "hijacked")):
        with pytest.raises(ValueError):
            call()
    assert api.verify_admin_password("superSecret123")        # the real check still works
    assert (root / "pwd.txt").read_text() == "superSecret123"


def test_relative_paths_may_not_contain_dotdot(api, root):
    # The jail already blocks escaping ROOT; '..' inside it would still let a
    # crafted name (e.g. a Special JV ref) reach a sibling folder.
    (root / "apps").mkdir(exist_ok=True)
    with pytest.raises(ValueError):
        api.write_file("special_jv_mapping/../apps/Reco.html", "clobbered")
    assert api.read_file("apps/Reco.html") == "<html></html>"
    with pytest.raises(ValueError):
        api.read_file("reco/../pwd.txt")


def test_absolute_write_needs_a_save_dialog(api, monkeypatch, tmp_path):
    # write_file_abs exists for the native Save-as flow. Nothing may write an
    # arbitrary path without the user having pointed a dialog at it.
    victim = tmp_path / "outside.txt"
    with pytest.raises(ValueError):
        api.write_file_abs(str(victim), "no dialog")
    with pytest.raises(ValueError):
        api.write_file_b64_abs(str(victim), base64.b64encode(b"no dialog").decode())
    assert not victim.exists()
    _fake_webview(monkeypatch, True)
    api._set_window(_FakeWindow(str(victim)))
    assert api.show_save_dialog("outside.txt").endswith("outside.txt")
    assert api.write_file_abs(str(victim), "chosen by the user")
    assert victim.read_text() == "chosen by the user"
    # a second write to the same chosen path is fine (retry), a different one is not
    assert api.write_file_abs(str(victim), "again")
    with pytest.raises(ValueError):
        api.write_file_abs(str(tmp_path / "other.txt"), "x")


def test_save_dialog_returns_plain_path(api, monkeypatch, tmp_path):
    _fake_webview(monkeypatch, True)
    api._set_window(_FakeWindow(str(tmp_path / "out.csv")))   # some platforms return a str
    assert api.show_save_dialog("out.csv").endswith("out.csv")
    api._set_window(_FakeWindow(None))                          # cancelled
    assert api.show_save_dialog("out.csv") == ""


# ──────────────────────────────────────────────────────────────────────────────
# T-S10-10 / T-S10-28. Writes that are safe between PROCESSES.
#
# LauncherAPI._writing is a per-path lock inside ONE process, and two colleagues
# are two processes on two machines. Both tickets were measured losing committed
# work with BOTH writers reporting success, so the cases that matter here are
# the cross-process ones and they are run with subprocess, not threads: a
# threaded version of either test passes on the old code and proves nothing.
# ──────────────────────────────────────────────────────────────────────────────

# A BARRIER, because without one the two processes' startup jitter is longer
# than the thing being measured and the test passes on the broken code. Each
# worker touches <gate>.<who>.ready and then waits for <gate>.go, so both are
# inside LauncherAPI before either writes.
_WORKER = r'''
import json, os, sys, time
sys.path.insert(0, %r)
import main
cfg, rel, who, hold, mode, gate = sys.argv[1:7]
api = main.LauncherAPI(config_path=cfg)
open(gate + "." + who + ".ready", "wb").close()
while not os.path.exists(gate + ".go"):
    time.sleep(0.002)
out = {"who": who, "refused": 0, "ok": False}
if mode == "csv":
    time.sleep(float(hold))
    fields = json.loads(sys.argv[7])
    out["n"] = api.append_csv_rows(rel, fields, [{"_pk": who, "_ver": "C1", "Doc": who}])
    out["ok"] = True
else:
    for attempt in range(12):
        got = api.read_file_with_token(rel)
        hist = json.loads(got["text"]) if got["text"].strip() else []
        if attempt == 0:
            time.sleep(float(hold))          # the window both pages sit in
        hist.append({"accountingId": who})
        res = api.write_file_if_unchanged(rel, json.dumps(hist), got["token"])
        if res.get("ok"):
            out["ok"] = True
            break
        out["refused"] += 1
        out["reason"] = res.get("reason")
print(json.dumps(out))
'''


def _two_processes(tmp_path, root, rel, mode, hold, extra=None):
    """Run two LauncherAPIs against one file in two real processes."""
    import subprocess
    import time as _time
    w = tmp_path / "worker.py"
    w.write_text(_WORKER % str(Path(__file__).resolve().parents[1]))
    cfg = tmp_path / "wcfg.json"
    cfg.write_text(json.dumps({"folder_path": str(root)}))
    gate = tmp_path / ("gate_" + mode)
    who2 = ("A-ENTRY", "B-ENTRY")
    procs = []
    for i, who in enumerate(who2):
        argv = [sys.executable, "-I", str(w), str(cfg), rel, who,
                str(hold if i else 0.0), mode, str(gate)]
        if extra:
            argv.append(extra[i])
        procs.append(subprocess.Popen(argv, stdout=subprocess.PIPE, text=True))
    deadline = _time.monotonic() + 60
    while _time.monotonic() < deadline:
        if all(Path(str(gate) + "." + w2 + ".ready").exists() for w2 in who2):
            break
        _time.sleep(0.005)
    Path(str(gate) + ".go").write_bytes(b"")
    return [json.loads(p.communicate()[0].strip() or "{}") for p in procs]


def test_content_token_is_the_bytes_and_not_the_clock(api, root):
    rel = "reco/tok.json"
    assert api.file_token(rel) == ""            # absent is its own answer
    api.write_file(rel, '{"a":1}')
    t1 = api.file_token(rel)
    assert t1.startswith("h1:") and len(t1) == 67
    # Re-writing the SAME bytes leaves the token alone: it describes content,
    # so a save that changed nothing cannot refuse a colleague's next write.
    api.write_file(rel, '{"a":1}')
    assert api.file_token(rel) == t1
    # ...and a change of the same LENGTH moves it, which mtime+size would not
    # reliably see on a share.
    api.write_file(rel, '{"a":2}')
    assert api.file_token(rel) != t1
    got = api.read_file_with_token(rel)
    assert got["text"] == '{"a":2}' and got["token"] == api.file_token(rel)


def test_write_file_if_unchanged_refuses_a_stale_token(api, root):
    rel = "reco/cas.json"
    first = api.write_file_if_unchanged(rel, "[]", "")      # "" = expect no file
    assert first["ok"] and first["token"] == api.file_token(rel)
    stale = first["token"]
    assert api.write_file_if_unchanged(rel, '["mine"]', stale)["ok"]
    # Somebody else's write moved it; the stale token must now be refused and
    # the refusal must hand back what the file HOLDS, so the caller can re-read.
    res = api.write_file_if_unchanged(rel, '["clobber"]', stale)
    assert res["ok"] is False and res["reason"] == "changed"
    assert res["token"] == api.file_token(rel)
    assert json.loads(api.read_file(rel)) == ["mine"]
    # An empty token against a file that EXISTS is refused too, so a first
    # writer cannot clobber a second one that got there first.
    assert api.write_file_if_unchanged(rel, "[]", "")["ok"] is False


def test_the_ledger_clobber_between_two_processes(api, root, tmp_path):
    """T-S10-10. Two pages pressing Generate together keep both entries."""
    rel = "reco/entryHistory.json"
    api.write_file(rel, json.dumps([{"accountingId": "AE%05d" % i} for i in range(200)]))
    said = _two_processes(tmp_path, root, rel, "ledger", 0.25)
    hist = json.loads(api.read_file(rel))
    ids = {e.get("accountingId") for e in hist}
    assert all(s["ok"] for s in said), said
    assert {"A-ENTRY", "B-ENTRY"} <= ids, said
    assert len(hist) == 202
    # ...and the retry really happened, so this is not passing because the two
    # processes never overlapped. Exactly one of them had to re-read.
    assert sum(s["refused"] for s in said) >= 1, said


def test_a_colleagues_append_survives_the_widening_rewrite(api, root, tmp_path):
    """T-S10-28. append_csv_rows' `header + missing` branch rewrites the whole
    file; an append landing inside that rewrite used to be lost."""
    rel = "reco_data/T/Oct-26/19.csv"
    pre = ["_pk", "_ver", "_ts", "Doc"]
    body = io.StringIO()
    w = csv.writer(body, lineterminator="\r\n")
    w.writerow(pre)
    # Big enough that the whole-file rewrite is the longest thing happening:
    # at 4,000 rows it finished inside the processes' own startup jitter and
    # this test PASSED on the broken code, which is worse than no test.
    for i in range(60000):
        w.writerow(["K%d" % i, "upload", "2026-10-19T08:00:00.000Z", "D%d" % i])
    (root / rel).parent.mkdir(parents=True, exist_ok=True)
    (root / rel).write_text(body.getvalue(), encoding="utf-8", newline="")
    # A widens the header (a new control column); B appends against the old one.
    said = _two_processes(tmp_path, root, rel, "csv", 0.0,
                          extra=[json.dumps(pre + ["_pksig"]), json.dumps(pre)])
    rows = list(csv.DictReader(io.StringIO(api.read_file(rel))))
    got = {r["_pk"] for r in rows if r["_ver"] == "C1"}
    assert all(s["ok"] for s in said), said
    assert got == {"A-ENTRY", "B-ENTRY"}, said
    assert len(rows) == 60002


def test_a_share_that_cannot_lock_still_saves(api, root, monkeypatch):
    """The degradation is deliberate: unlocked is no worse than before this
    change, and refusing to save onto such a share would be much worse."""
    import errno as _errno

    def cannot_lock(*a, **kw):
        raise OSError(_errno.ENOLCK, "no locks on this filesystem")

    monkeypatch.setattr(main, "_fcntl", type("F", (), {
        "flock": staticmethod(cannot_lock), "LOCK_EX": 2, "LOCK_NB": 4, "LOCK_UN": 8})())
    rel = "reco/nolock.json"
    assert api.write_file(rel, '{"a":1}') is True
    res = api.write_file_if_unchanged(rel, '{"a":2}', api.file_token(rel))
    assert res["ok"] and res["locked"] is False
    assert json.loads(api.read_file(rel)) == {"a": 2}


def test_the_locks_live_in_one_hidden_folder_and_not_beside_the_data(api, root):
    """The first version of this round put a `.<name>.lock` sidecar beside each
    file, which doubled the file count in every folder the app writes to - and
    this shared folder is browsed by people. One hidden folder instead, named
    by the hash of the path relative to ROOT."""
    rel = "reco_data/T/Nov-26/01.csv"
    api.append_csv_rows(rel, ["_pk"], [{"_pk": "1"}])
    # nothing new beside the data, through list_files OR the real filesystem
    assert [f["name"] for f in api.list_files("reco_data/T/Nov-26")] == ["01.csv"]
    assert sorted(c.name for c in (root / rel).parent.iterdir()) == ["01.csv"]
    # ...and exactly one lock, under ROOT/.locks
    locks = sorted(c.name for c in (root / main.LOCK_DIR).iterdir())
    assert locks == [main._lock_file_for(root, root / rel).name]
    assert len(locks[0]) == 25 and locks[0].endswith(".lock")   # 20 hex + ".lock"
    # The NAME is the hash of the relative path, so two files that differ only
    # by a separator-looking character cannot share a lock.
    a = main._lock_file_for(root, root / "reco_data/A__B/x.csv")
    b = main._lock_file_for(root, root / "reco_data/A/B/x.csv")
    assert a != b


def test_a_busy_lock_is_its_own_answer_and_not_a_throw(api, root, monkeypatch):
    """The lock WAIT running out is the one OSError that becomes an answer, and
    it is decided by the exception's CLASS: deciding it by searching the text of
    a message is how a reworded message quietly becomes an unhandled failure."""
    rel = "reco/busy.json"
    api.write_file(rel, "{}")
    tok = api.file_token(rel)

    def always_busy(*a, **kw):
        raise main.LockBusy("Another window is still writing busy.json (waited 10s).")

    monkeypatch.setattr(main, "_cross_process_lock", always_busy)
    res = api.write_file_if_unchanged(rel, '{"a":1}', tok)
    assert res == {"ok": False, "token": "", "reason": "busy",
                   "detail": "Another window is still writing busy.json (waited 10s)."}
    assert json.loads(api.read_file(rel)) == {}          # nothing was written

    # ...and any OTHER OSError still goes on past the caller.
    def other_error(*a, **kw):
        raise OSError("the share went away")

    monkeypatch.setattr(main, "_cross_process_lock", other_error)
    with pytest.raises(OSError, match="the share went away"):
        api.write_file_if_unchanged(rel, '{"a":2}', tok)
