"""
Base-folder management for the Automation Hub launcher.

Everything the hub needs to *set*, *switch* or *migrate* the shared base
folder (the "ROOT" that holds apps/, master/, reco/, reco_data/, ...):

  inspect_folder(path)        quick facts about a candidate folder
  preflight(src, dst, ...)    scan + validate a migration before it starts
  MigrationJob                copies every file src -> dst on a worker thread,
                              verifies the copy, optionally removes the
                              originals, and reports progress / cancel
  write_pointer / read_pointer
                              MIGRATED_TO.txt left in the old folder so other
                              users' launchers can follow the move
  init_skeleton(root, ...)    create the standard folder layout (never
                              overwrites anything that already exists)

This module has no pywebview dependency so it can be unit tested and reused
from another launcher.
"""

from __future__ import annotations

import csv
import datetime as _dt
import getpass
import hashlib
import io
import os
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Iterable

POINTER_FILE = "MIGRATED_TO.txt"

# Sub-folders that identify a Reco / Automation Hub base folder.
ROOT_MARKERS = ("apps", "master", "reco", "reco_data", "aegtemplates",
                "special_jv_mapping", "special_jv_templates")

# Standard layout created by init_skeleton().
SKELETON_DIRS = ("apps", "apps/lib", "apps/icon", "master", "aegtemplates", "reco",
                 "reco_data", "reco_attachments", "special_jv_mapping",
                 "special_jv_templates")

ACCOUNTS_MASTER_HEADER = "Reference,RC,Nominal,SubNominal,AnalysisKey,LOB\r\n"

CONFLICT_POLICIES = ("abort", "skip", "overwrite")


# ──────────────────────────────────────────────────────────────────────────────
# Path helpers
# ──────────────────────────────────────────────────────────────────────────────

def norm(path: str | os.PathLike) -> str:
    """Absolute, normalised path string (keeps UNC prefixes intact)."""
    p = os.path.expandvars(os.path.expanduser(str(path).strip().strip('"')))
    return os.path.normpath(os.path.abspath(p))


def _key(path: str) -> str:
    """Comparison key: case-insensitive on Windows, no trailing separator."""
    return os.path.normcase(norm(path)).rstrip("\\/")


def same_path(a: str, b: str) -> bool:
    return _key(a) == _key(b)


def is_inside(child: str, parent: str) -> bool:
    """True when *child* is strictly inside *parent*."""
    c, p = _key(child), _key(parent)
    return c != p and c.startswith(p + os.sep)


def overlaps(a: str, b: str) -> bool:
    """True when the two folders are the same or one contains the other."""
    return same_path(a, b) or is_inside(a, b) or is_inside(b, a)


def _long(path: str) -> str:
    """Windows long-path prefix so deep reco_data trees (>260 chars) still copy."""
    if os.name != "nt":
        return path
    p = norm(path)
    if p.startswith("\\\\?\\"):
        return p
    if p.startswith("\\\\"):
        return "\\\\?\\UNC\\" + p[2:]
    return "\\\\?\\" + p


def human_size(n: int | float) -> str:
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def _now_iso() -> str:
    return _dt.datetime.now().replace(microsecond=0).isoformat()


def _os_user() -> str:
    try:
        return getpass.getuser()
    except Exception:  # pragma: no cover - getpass can fail in odd shells
        return os.environ.get("USERNAME") or os.environ.get("USER") or "unknown"


# ──────────────────────────────────────────────────────────────────────────────
# Inspection
# ──────────────────────────────────────────────────────────────────────────────

def is_writable(path: str) -> bool:
    """Real write test (ACLs on network shares make os.access unreliable)."""
    probe = os.path.join(path, f".hub_write_test_{uuid.uuid4().hex}")
    try:
        with open(_long(probe), "w", encoding="utf-8") as fh:
            fh.write("ok")
        os.remove(_long(probe))
        return True
    except OSError:
        return False


def inspect_folder(path: str) -> dict:
    """Cheap, non-recursive facts about a candidate base folder."""
    info = {
        "path": norm(path) if path else "",
        "exists": False,
        "is_dir": False,
        "writable": False,
        "empty": False,
        "looks_like_root": False,
        "markers": [],
        "entries": 0,
        "pointer": None,
        "error": "",
    }
    if not path:
        info["error"] = "No folder given."
        return info
    p = info["path"]
    try:
        info["exists"] = os.path.exists(p)
        info["is_dir"] = os.path.isdir(p)
        if not info["exists"]:
            info["error"] = "Folder does not exist or is not reachable."
            return info
        if not info["is_dir"]:
            info["error"] = "Path is a file, not a folder."
            return info
        names = os.listdir(p)
        info["entries"] = len(names)
        info["empty"] = len(names) == 0
        lower = {n.lower() for n in names}
        info["markers"] = [m for m in ROOT_MARKERS if m in lower]
        info["looks_like_root"] = bool({"apps", "master", "reco"} & lower)
        info["pointer"] = read_pointer(p)
        info["writable"] = is_writable(p)
    except OSError as exc:
        info["error"] = f"{type(exc).__name__}: {exc}"
    return info


def iter_files(root: str, exclude_top: Iterable[str] = (POINTER_FILE,)):
    """Yield (relative_path, size, mtime) for every file under *root*."""
    root = norm(root)
    exclude = {e.lower() for e in exclude_top}
    for dirpath, dirnames, filenames in os.walk(_long(root), followlinks=False):
        dirnames.sort()
        rel_dir = os.path.relpath(dirpath, _long(root))
        rel_dir = "" if rel_dir == "." else rel_dir
        for name in sorted(filenames):
            if not rel_dir and name.lower() in exclude:
                continue
            # Skip our own in-flight temp files from an interrupted copy.
            if name.startswith(".hubcopy-") and name.endswith(".tmp"):
                continue
            # Excel owner files (~$Book.xlsx) are locked while a workbook is open.
            if name.startswith("~$"):
                continue
            full = os.path.join(dirpath, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            yield (os.path.join(rel_dir, name) if rel_dir else name, st.st_size, st.st_mtime)


def scan(root: str, progress: Callable[[int, int], None] | None = None,
         cancel: threading.Event | None = None) -> list[tuple[str, int, float]]:
    out = []
    total = 0
    for item in iter_files(root):
        if cancel is not None and cancel.is_set():
            break
        out.append(item)
        total += item[1]
        if progress and len(out) % 200 == 0:
            progress(len(out), total)
    if progress:
        progress(len(out), total)
    return out


# ──────────────────────────────────────────────────────────────────────────────
# Migration pointer (left behind in the old folder)
# ──────────────────────────────────────────────────────────────────────────────

def write_pointer(old_root: str, new_root: str, user: str | None = None) -> bool:
    text = (
        "This Reco / Automation Hub base folder has been moved.\r\n"
        "Launchers that open this folder will offer to switch automatically.\r\n"
        "\r\n"
        f"new_folder={norm(new_root)}\r\n"
        f"migrated_at={_now_iso()}\r\n"
        f"migrated_by={user or _os_user()}\r\n"
    )
    try:
        with open(_long(os.path.join(norm(old_root), POINTER_FILE)), "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        return True
    except OSError:
        return False


def read_pointer(root: str) -> dict | None:
    path = os.path.join(norm(root), POINTER_FILE)
    try:
        with open(_long(path), "r", encoding="utf-8-sig") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return None
    data = {}
    for line in lines:
        if "=" in line:
            k, v = line.split("=", 1)
            data[k.strip()] = v.strip()
    if not data.get("new_folder"):
        return None
    return {
        "new_folder": data.get("new_folder", ""),
        "migrated_at": data.get("migrated_at", ""),
        "migrated_by": data.get("migrated_by", ""),
    }


def remove_pointer(root: str) -> None:
    try:
        os.remove(_long(os.path.join(norm(root), POINTER_FILE)))
    except OSError:
        pass


# ──────────────────────────────────────────────────────────────────────────────
# Skeleton
# ──────────────────────────────────────────────────────────────────────────────

def init_skeleton(root: str, user_id: str | None = None, user_name: str = "",
                  app_keys: Iterable[str] = ("reco",)) -> list[str]:
    """Create the standard folder layout. Returns the list of items created.

    Existing files are never touched. master/user.csv is only created when it
    is missing, with the given user granted access to *app_keys*.
    """
    root = norm(root)
    created = []
    for d in SKELETON_DIRS:
        full = os.path.join(root, *d.split("/"))
        if not os.path.isdir(full):
            os.makedirs(_long(full), exist_ok=True)
            created.append(d + "/")
    user_csv = os.path.join(root, "master", "user.csv")
    if not os.path.exists(user_csv):
        keys = [k.lower() for k in app_keys if k]
        uid = user_id or _os_user()
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\r\n")
        w.writerow(["ID", "Name", "Email"] + keys)
        w.writerow([uid, user_name or uid, ""] + ["1"] * len(keys))
        with open(_long(user_csv), "w", encoding="utf-8", newline="") as fh:
            fh.write(buf.getvalue())
        created.append("master/user.csv")
    master_csv = os.path.join(root, "master", "accounts_master.csv")
    if not os.path.exists(master_csv):
        with open(_long(master_csv), "w", encoding="utf-8", newline="") as fh:
            fh.write(ACCOUNTS_MASTER_HEADER)
        created.append("master/accounts_master.csv")
    return created


# ──────────────────────────────────────────────────────────────────────────────
# Preflight
# ──────────────────────────────────────────────────────────────────────────────

def _free_bytes(path: str) -> int | None:
    probe = norm(path)
    while probe and not os.path.exists(probe):
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent
    try:
        return shutil.disk_usage(probe).free
    except OSError:
        return None


def preflight(src: str, dst: str, conflict: str = "abort",
              files: list[tuple[str, int, float]] | None = None) -> dict:
    """Validate a migration and describe what it will do. Never writes data."""
    src_n, dst_n = norm(src), norm(dst) if dst else ""
    result = {
        "ok": False, "errors": [], "warnings": [],
        "src": src_n, "dst": dst_n, "conflict": conflict,
        "total_files": 0, "total_bytes": 0,
        "conflicts": 0, "conflict_examples": [],
        "bytes_to_copy": 0, "free_bytes": None,
        "dst_exists": False, "dst_empty": True,
    }
    errs, warns = result["errors"], result["warnings"]
    if conflict not in CONFLICT_POLICIES:
        errs.append(f"Unknown conflict policy '{conflict}'.")
        return result
    if not dst:
        errs.append("Choose a destination folder.")
        return result
    if not os.path.isdir(src_n):
        errs.append("The current base folder is not reachable, so its files cannot be copied.")
        return result
    if same_path(src_n, dst_n):
        errs.append("The destination is the current base folder.")
        return result
    if is_inside(dst_n, src_n):
        errs.append("The destination is inside the current base folder; it would copy into itself.")
        return result
    if is_inside(src_n, dst_n):
        errs.append("The current base folder is inside the destination. Pick a separate folder.")
        return result

    result["dst_exists"] = os.path.isdir(dst_n)
    if os.path.exists(dst_n) and not result["dst_exists"]:
        errs.append("The destination path is a file.")
        return result
    if result["dst_exists"]:
        try:
            result["dst_empty"] = not os.listdir(dst_n)
        except OSError as exc:
            errs.append(f"Cannot read destination: {exc}")
            return result
        if not is_writable(dst_n):
            errs.append("The destination folder is not writable for your account.")
            return result
    else:
        parent = os.path.dirname(dst_n)
        if not os.path.isdir(parent):
            errs.append(f"Parent folder does not exist: {parent}")
            return result
        if not is_writable(parent):
            errs.append(f"Cannot create folders in: {parent}")
            return result

    files = files if files is not None else scan(src_n)
    result["total_files"] = len(files)
    result["total_bytes"] = sum(f[1] for f in files)
    if not files:
        warns.append("The current base folder has no files; nothing to copy.")

    to_copy = 0
    if result["dst_exists"] and not result["dst_empty"]:
        for rel, size, _m in files:
            target = os.path.join(dst_n, rel)
            if os.path.exists(_long(target)):
                result["conflicts"] += 1
                if len(result["conflict_examples"]) < 10:
                    result["conflict_examples"].append(rel)
                if conflict == "overwrite":
                    to_copy += size
            else:
                to_copy += size
    else:
        to_copy = result["total_bytes"]
    result["bytes_to_copy"] = to_copy

    if result["conflicts"]:
        if conflict == "abort":
            errs.append(f"{result['conflicts']} file(s) already exist in the destination. "
                        "Choose 'keep existing' or 'overwrite', or pick an empty folder.")
        elif conflict == "skip":
            warns.append(f"{result['conflicts']} file(s) already exist in the destination and will be kept as they are.")
        else:
            warns.append(f"{result['conflicts']} file(s) in the destination will be replaced.")
    elif result["dst_exists"] and not result["dst_empty"]:
        warns.append("The destination is not empty; existing files there are left untouched.")

    free = _free_bytes(dst_n)
    result["free_bytes"] = free
    if free is not None and to_copy > free:
        errs.append(f"Not enough free space: need {human_size(to_copy)}, have {human_size(free)}.")

    result["ok"] = not errs
    return result


# ──────────────────────────────────────────────────────────────────────────────
# Migration job
# ──────────────────────────────────────────────────────────────────────────────

def _sha256(path: str, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(_long(path), "rb") as fh:
        while True:
            b = fh.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


class MigrationCancelled(Exception):
    pass


class MigrationJob:
    """Copy every file from *src* to *dst*, verify, then call *on_success*.

    The job never deletes anything unless ``remove_source`` is set, and then
    only source files whose copy was verified by SHA-256.
    """

    def __init__(self, src: str, dst: str, conflict: str = "abort",
                 remove_source: bool = False, verify_hash: bool | None = None,
                 on_success: Callable[["MigrationJob"], None] | None = None,
                 user: str | None = None):
        self.src = norm(src)
        self.dst = norm(dst)
        self.conflict = conflict
        self.remove_source = bool(remove_source)
        # Hash verification is mandatory when we are going to delete originals.
        self.verify_hash = True if self.remove_source else bool(verify_hash)
        self.on_success = on_success
        self.user = user or _os_user()

        self.id = uuid.uuid4().hex[:12]
        self.state = "pending"     # pending|scanning|copying|verifying|removing|done|failed|cancelled
        self.message = ""
        self.total_files = 0
        self.total_bytes = 0
        self.done_files = 0
        self.done_bytes = 0
        self.copied_files = 0
        self.skipped_files = 0
        self.verified_files = 0
        self.removed_files = 0
        self.current = ""
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.started_at = ""
        self.finished_at = ""
        self.switched = False
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    # ---- public API ----------------------------------------------------------
    def start(self) -> "MigrationJob":
        self._thread = threading.Thread(target=self.run, name=f"migrate-{self.id}", daemon=True)
        self._thread.start()
        return self

    def cancel(self) -> None:
        self._cancel.set()

    def join(self, timeout: float | None = None) -> None:
        if self._thread:
            self._thread.join(timeout)

    @property
    def finished(self) -> bool:
        return self.state in ("done", "failed", "cancelled")

    def to_dict(self) -> dict:
        with self._lock:
            pct = 0.0
            if self.total_bytes:
                pct = min(100.0, 100.0 * self.done_bytes / self.total_bytes)
            elif self.total_files:
                pct = min(100.0, 100.0 * self.done_files / self.total_files)
            if self.state == "done":
                pct = 100.0
            return {
                "id": self.id, "state": self.state, "message": self.message,
                "src": self.src, "dst": self.dst, "conflict": self.conflict,
                "remove_source": self.remove_source, "verify_hash": self.verify_hash,
                "total_files": self.total_files, "total_bytes": self.total_bytes,
                "done_files": self.done_files, "done_bytes": self.done_bytes,
                "copied_files": self.copied_files, "skipped_files": self.skipped_files,
                "verified_files": self.verified_files, "removed_files": self.removed_files,
                "percent": round(pct, 1), "current": self.current,
                "errors": self.errors[:50], "error_count": len(self.errors),
                "warnings": self.warnings[:50],
                "started_at": self.started_at, "finished_at": self.finished_at,
                "switched": self.switched, "finished": self.finished,
            }

    # ---- worker --------------------------------------------------------------
    def _set(self, **kw) -> None:
        with self._lock:
            for k, v in kw.items():
                setattr(self, k, v)

    def _check_cancel(self) -> None:
        if self._cancel.is_set():
            raise MigrationCancelled()

    def run(self) -> None:
        self._set(started_at=_now_iso(), state="scanning", message="Scanning files…")
        try:
            files = scan(self.src, progress=lambda n, b: self._set(total_files=n, total_bytes=b,
                                                                   message=f"Scanning… {n} files"),
                         cancel=self._cancel)
            self._check_cancel()
            pre = preflight(self.src, self.dst, self.conflict, files=files)
            if not pre["ok"]:
                self._fail("; ".join(pre["errors"]))
                return
            self.warnings.extend(pre["warnings"])
            self._set(total_files=len(files), total_bytes=sum(f[1] for f in files))
            os.makedirs(_long(self.dst), exist_ok=True)

            # 1. copy
            self._set(state="copying", message="Copying files…")
            kept_existing = set()
            for rel, size, _mtime in files:
                self._check_cancel()
                self._set(current=rel)
                src_f = os.path.join(self.src, rel)
                dst_f = os.path.join(self.dst, rel)
                try:
                    if os.path.exists(_long(dst_f)) and self.conflict == "skip":
                        kept_existing.add(rel)
                        with self._lock:
                            self.skipped_files += 1
                    else:
                        self._copy_one(src_f, dst_f)
                        with self._lock:
                            self.copied_files += 1
                except OSError as exc:
                    self.errors.append(f"{rel}: {exc.strerror or exc}")
                with self._lock:
                    self.done_files += 1
                    self.done_bytes += size
            if self.errors:
                self._fail(f"{len(self.errors)} file(s) could not be copied. "
                           "Nothing was switched; close programs that lock those files and try again.")
                return

            # 2. verify
            self._set(state="verifying", message="Verifying copy…", done_files=0, done_bytes=0)
            verified = []
            for rel, size, _mtime in files:
                self._check_cancel()
                self._set(current=rel)
                src_f = os.path.join(self.src, rel)
                dst_f = os.path.join(self.dst, rel)
                try:
                    dst_size = os.path.getsize(_long(dst_f))
                    if rel in kept_existing:
                        if dst_size != size:
                            self.warnings.append(f"Kept existing (differs from source): {rel}")
                    elif dst_size != size:
                        self.errors.append(f"{rel}: size mismatch after copy ({dst_size} vs {size})")
                    elif self.verify_hash and _sha256(src_f) != _sha256(dst_f):
                        self.errors.append(f"{rel}: checksum mismatch after copy")
                    else:
                        verified.append(rel)
                except OSError as exc:
                    self.errors.append(f"{rel}: cannot verify ({exc.strerror or exc})")
                with self._lock:
                    self.done_files += 1
                    self.done_bytes += size
                    self.verified_files = len(verified)
            if self.errors:
                self._fail(f"Verification failed for {len(self.errors)} file(s). Nothing was switched.")
                return

            # 3. switch (caller updates launcher config)
            self._set(current="", message="Switching base folder…")
            if self.on_success:
                self.on_success(self)
                self._set(switched=True)

            # 4. optionally remove originals that were verified byte-for-byte
            if self.remove_source:
                self._set(state="removing", message="Removing original files…")
                self._remove_sources(verified)

            write_pointer(self.src, self.dst, self.user)
            msg = f"Migrated {self.copied_files} file(s) ({human_size(self.total_bytes)})"
            if self.skipped_files:
                msg += f", kept {self.skipped_files} existing"
            if self.remove_source:
                msg += f", removed {self.removed_files} original(s)"
            self._set(state="done", message=msg + ".", finished_at=_now_iso(), current="")
        except MigrationCancelled:
            self._set(state="cancelled", finished_at=_now_iso(), current="",
                      message="Cancelled. The base folder was not changed; partially copied files remain in the destination.")
        except Exception as exc:  # pragma: no cover - defensive
            self._fail(f"Unexpected error: {type(exc).__name__}: {exc}")

    def _fail(self, message: str) -> None:
        self._set(state="failed", message=message, finished_at=_now_iso(), current="")

    def _copy_one(self, src_f: str, dst_f: str) -> None:
        os.makedirs(_long(os.path.dirname(dst_f)), exist_ok=True)
        tmp = os.path.join(os.path.dirname(dst_f), f".hubcopy-{uuid.uuid4().hex[:8]}.tmp")
        try:
            shutil.copy2(_long(src_f), _long(tmp))
            for attempt in range(5):
                try:
                    os.replace(_long(tmp), _long(dst_f))
                    break
                except PermissionError:
                    if attempt == 4:
                        raise
                    time.sleep(0.2 * (attempt + 1))
        finally:
            if os.path.exists(_long(tmp)):
                try:
                    os.remove(_long(tmp))
                except OSError:
                    pass

    def _remove_sources(self, verified: list[str]) -> None:
        for rel in verified:
            try:
                os.remove(_long(os.path.join(self.src, rel)))
                with self._lock:
                    self.removed_files += 1
            except OSError as exc:
                self.warnings.append(f"Could not remove original {rel}: {exc.strerror or exc}")
        # Remove now-empty folders bottom-up, never the root itself.
        for dirpath, _dirs, _files in sorted(os.walk(_long(self.src)), key=lambda t: -len(t[0])):
            if _key(dirpath.replace("\\\\?\\UNC\\", "\\\\").replace("\\\\?\\", "")) == _key(self.src):
                continue
            try:
                if not os.listdir(dirpath):
                    os.rmdir(dirpath)
            except OSError:
                pass
