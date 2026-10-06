import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import folder_manager as fm  # noqa: E402


def make_root(base: Path) -> Path:
    root = base / "old_root"
    files = {
        "apps/Reco.html": "<html>reco</html>",
        "apps/lib/papaparse.min.js": "x" * 5000,
        "master/user.csv": "ID,Name,Email,reco\r\nalice,Alice,,1\r\n",
        "master/accounts_master.csv": fm.ACCOUNTS_MASTER_HEADER,
        "reco/recoSessions.json": '{"a": 1}',
        "reco_data/BSP_RUB/Oct-26/06.csv": "_pk,_ver,_ts,Amt\r\n1,upload,t,5\r\n",
        "reco_attachments/tpl1/A1_invoice.pdf": "%PDF-1.4 binary-ish",
        "special_jv_mapping/TCH.json": '{"ref":"TCH"}',
        "special_jv_templates/TCH.html": "<html>tch</html>",
        "pwd.txt": "s3cret",
    }
    for rel, content in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    return root


def all_files(root: Path) -> dict:
    return {str(p.relative_to(root)).replace("\\", "/"): p.read_bytes()
            for p in root.rglob("*") if p.is_file()}


def test_inspect_folder(tmp_path):
    root = make_root(tmp_path)
    info = fm.inspect_folder(str(root))
    assert info["exists"] and info["is_dir"] and info["writable"]
    assert info["looks_like_root"]
    assert "apps" in info["markers"] and "master" in info["markers"]
    missing = fm.inspect_folder(str(tmp_path / "nope"))
    assert not missing["exists"] and missing["error"]


def test_overlap_rules(tmp_path):
    a = str(tmp_path / "a")
    assert fm.same_path(a, a + os.sep)
    assert fm.is_inside(str(tmp_path / "a" / "b"), a)
    assert not fm.is_inside(str(tmp_path / "ab"), a)  # prefix but not a child
    assert fm.overlaps(a, str(tmp_path / "a" / "x"))


def test_preflight_rejects_nested_and_same(tmp_path):
    root = make_root(tmp_path)
    assert not fm.preflight(str(root), str(root))["ok"]
    r = fm.preflight(str(root), str(root / "inside"))
    assert not r["ok"] and "inside" in r["errors"][0]
    r = fm.preflight(str(root), str(tmp_path))
    assert not r["ok"]


def test_preflight_counts_and_conflicts(tmp_path):
    root = make_root(tmp_path)
    dst = tmp_path / "new_root"
    r = fm.preflight(str(root), str(dst))
    assert r["ok"], r["errors"]
    assert r["total_files"] == 10
    (dst / "master").mkdir(parents=True)
    (dst / "master" / "user.csv").write_text("other")
    r = fm.preflight(str(root), str(dst), "abort")
    assert not r["ok"] and r["conflicts"] == 1
    assert fm.preflight(str(root), str(dst), "skip")["ok"]
    assert fm.preflight(str(root), str(dst), "overwrite")["ok"]


def test_migration_copies_everything_and_verifies(tmp_path):
    root = make_root(tmp_path)
    dst = tmp_path / "new_root"
    switched = []
    job = fm.MigrationJob(str(root), str(dst), verify_hash=True, on_success=lambda j: switched.append(j.dst))
    job.run()
    d = job.to_dict()
    assert d["state"] == "done", d
    assert d["copied_files"] == 10 and d["verified_files"] == 10
    assert all_files(dst) == {k: v for k, v in all_files(root).items() if k != fm.POINTER_FILE}
    assert switched == [fm.norm(str(dst))]
    ptr = fm.read_pointer(str(root))
    assert ptr and fm.same_path(ptr["new_folder"], str(dst))
    # originals untouched by default
    assert (root / "reco" / "recoSessions.json").exists()
    # no temp files left behind
    assert not list(dst.rglob("*.tmp"))


def test_migration_skip_keeps_existing_files(tmp_path):
    root = make_root(tmp_path)
    dst = tmp_path / "new_root"
    (dst / "master").mkdir(parents=True)
    (dst / "master" / "user.csv").write_text("keep me")
    job = fm.MigrationJob(str(root), str(dst), conflict="skip")
    job.run()
    assert job.state == "done", job.message
    assert (dst / "master" / "user.csv").read_text() == "keep me"
    assert job.skipped_files == 1
    assert any("Kept existing" in w for w in job.warnings)


def test_migration_move_removes_only_verified_sources(tmp_path):
    root = make_root(tmp_path)
    dst = tmp_path / "new_root"
    job = fm.MigrationJob(str(root), str(dst), remove_source=True)
    assert job.verify_hash  # forced on for moves
    job.run()
    assert job.state == "done", job.message
    left = all_files(root)
    assert list(left) == [fm.POINTER_FILE]  # only the pointer note remains
    assert len(all_files(dst)) == 10


def test_migration_cancel_does_not_switch(tmp_path):
    root = make_root(tmp_path)
    dst = tmp_path / "new_root"
    switched = []
    job = fm.MigrationJob(str(root), str(dst), on_success=lambda j: switched.append(1))
    job.cancel()
    job.run()
    assert job.state == "cancelled"
    assert not switched
    assert fm.read_pointer(str(root)) is None


def test_migration_into_nonempty_abort_fails_cleanly(tmp_path):
    root = make_root(tmp_path)
    dst = tmp_path / "new_root"
    (dst / "reco").mkdir(parents=True)
    (dst / "reco" / "recoSessions.json").write_text("{}")
    job = fm.MigrationJob(str(root), str(dst), conflict="abort")
    job.run()
    assert job.state == "failed"
    assert (dst / "reco" / "recoSessions.json").read_text() == "{}"


def test_init_skeleton_never_overwrites(tmp_path):
    root = tmp_path / "fresh"
    root.mkdir()
    created = fm.init_skeleton(str(root), "bob", "Bob", ["reco", "other"])
    assert "master/user.csv" in created
    text = (root / "master" / "user.csv").read_text()
    assert text.splitlines()[0] == "ID,Name,Email,reco,other"
    assert text.splitlines()[1] == "bob,Bob,,1,1"
    (root / "master" / "user.csv").write_text("custom")
    assert fm.init_skeleton(str(root), "bob") == []
    assert (root / "master" / "user.csv").read_text() == "custom"


def test_pointer_roundtrip(tmp_path):
    fm.write_pointer(str(tmp_path), str(tmp_path / "x"), "admin")
    p = fm.read_pointer(str(tmp_path))
    assert p["migrated_by"] == "admin" and p["new_folder"].endswith("x")
    fm.remove_pointer(str(tmp_path))
    assert fm.read_pointer(str(tmp_path)) is None


@pytest.mark.parametrize("n,expected", [(0, "0 B"), (1536, "1.5 KB"), (5 * 1024 ** 3, "5.0 GB")])
def test_human_size(n, expected):
    assert fm.human_size(n) == expected
