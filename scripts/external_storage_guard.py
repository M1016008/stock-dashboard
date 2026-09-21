"""Fail-closed SQLite writer guard for the Python shadow jobs.

Shares STOCK_DATA_* configuration with the Node guard. Local test databases
remain independent; production and external-volume writes require identity.
"""

import errno
import json
import os
from pathlib import Path
import plistlib
import re
import sqlite3
import subprocess
import sys
import time
import uuid


FATAL_ERRNOS = {errno.EIO, errno.ENODEV, errno.ENOENT, errno.EROFS, errno.ENOSPC}
FATAL_SQLITE = {sqlite3.SQLITE_IOERR, sqlite3.SQLITE_CANTOPEN,
                sqlite3.SQLITE_READONLY, sqlite3.SQLITE_FULL}
_guards = {}


class StorageFatal(RuntimeError):
    pass


class ProbeUncertain(RuntimeError):
    def __init__(self, stage, cause, started_at=None):
        super().__init__(f"{stage} probe did not complete")
        self.stage = stage
        self.cause = cause
        self.started_at = started_at if started_at is not None else time.time()
        self.duration_ms = round((time.time() - self.started_at) * 1000)
        self.exit_status = getattr(cause, "returncode", None)
        self.signal = getattr(cause, "signal", None)
        raw_stderr = getattr(cause, "stderr", None)
        stderr = raw_stderr.decode("utf-8", "replace") if isinstance(raw_stderr, bytes) else str(raw_stderr or "")
        self.stderr = re.sub(r"(token|secret|password|authorization|api[_-]?key)\s*[:=]\s*\S+",
                             r"\1=[redacted]", stderr, flags=re.IGNORECASE)[:160] or None


def incident_dir():
    candidate = Path(os.environ.get("STOCK_DATA_INCIDENT_DIR", "")) if os.environ.get("STOCK_DATA_INCIDENT_DIR") else Path.home() / "Library/Application Support/StockBoard/storage-incidents"
    if str(candidate.absolute()).startswith("/Volumes/") or (candidate.exists() and str(candidate.resolve()).startswith("/Volumes/")):
        return Path.home() / "Library/Application Support/StockBoard/storage-incidents"
    return candidate


def requires_guard(target):
    if os.environ.get("NODE_ENV") == "production" and os.environ.get("EXTERNAL_STORAGE_REQUIRED") == "false":
        raise StorageFatal("production cannot disable external storage protection")
    return (os.environ.get("NODE_ENV") == "production"
            or os.environ.get("EXTERNAL_STORAGE_REQUIRED") == "true"
            or str(Path(target).absolute()).startswith("/Volumes/"))


def volume_info(mount):
    if sys.platform != "darwin":
        raise StorageFatal("volume identity is unavailable on this platform")
    started_at = time.time()
    try:
        result = subprocess.run(["/usr/sbin/diskutil", "info", "-plist", str(mount)],
                                capture_output=True, timeout=2, check=True)
    except OSError as error:
        if error.errno in FATAL_ERRNOS:
            raise
        raise ProbeUncertain("DISKUTIL_INFO", error, started_at) from error
    except subprocess.SubprocessError as error:
        raise ProbeUncertain("DISKUTIL_INFO", error, started_at) from error
    started_at = time.time()
    try:
        return plistlib.loads(result.stdout)
    except (ValueError, TypeError) as error:
        raise ProbeUncertain("PLUTIL_PARSE", error, started_at) from error


def is_storage_error(error):
    if isinstance(error, StorageFatal):
        return True
    if isinstance(error, OSError) and error.errno in FATAL_ERRNOS:
        return True
    if isinstance(error, sqlite3.Error):
        code = getattr(error, "sqlite_errorcode", None)
        if code is not None and (code & 0xff) in FATAL_SQLITE:
            return True
        return any(s in str(error).lower() for s in
                   ("disk i/o error", "database or disk is full", "readonly database", "unable to open database file"))
    return False


def companion_requires_full_probe(companion, real_mount, mount_dev):
    if not companion.exists():
        return False
    try:
        real_companion = companion.resolve(strict=True)
        companion_dev = companion.stat().st_dev
    except FileNotFoundError:
        if companion.exists():
            raise
        return True
    if not real_companion.is_relative_to(real_mount) or companion_dev != mount_dev:
        raise StorageFatal("SQLite companion is outside expected volume")
    return False


class StorageGuard:
    def __init__(self, target, *, probe=volume_info, clock=time.monotonic, wait=time.sleep):
        self.target = Path(target).absolute()
        self.mount = Path(os.environ.get("STOCK_DATA_MOUNT_PATH", "")).absolute()
        self.expected_uuid = os.environ.get("STOCK_DATA_VOLUME_UUID", "").strip()
        self.min_free_bytes = int(os.environ.get("STOCK_DATA_MIN_FREE_BYTES", str(50 * 1024 ** 3)))
        self.min_free_percent = float(os.environ.get("STOCK_DATA_MIN_FREE_PERCENT", "5"))
        self.probe = probe
        self.clock = clock
        self.wait = wait
        self.last_identity = None
        self.last_stat = None
        self.device = None
        self.mount_real = None
        self.state = "UNCHECKED"
        self.connection = None
        self.recovered_transient_count = 0
        self.uncertain_marker = incident_dir() / f"PROBE_UNCERTAIN-{os.getpid()}"

    def record_probe_event(self, event, error):
        directory = incident_dir()
        try:
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            with (directory / "probe-events.ndjson").open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({
                    "event": event, "timestamp": time.time(), "pid": os.getpid(),
                    "jobType": "python-shadow-writer", "probeStage": error.stage,
                    "startedAt": error.started_at, "durationMs": error.duration_ms,
                    "exitStatus": error.exit_status, "signal": error.signal, "stderr": error.stderr,
                }) + "\n")
        except OSError:
            print("[storage-guard] probe event log unavailable", file=sys.stderr)

    def fatal(self, error):
        if self.state != "FAILED_SAFE":
            self.state = "FAILED_SAFE"
            incident = {
                "incidentId": str(uuid.uuid4()), "timestamp": time.time(), "pid": os.getpid(),
                "jobType": "python-shadow-writer", "errorCode": type(error).__name__,
                "probeStage": error.stage if isinstance(error, ProbeUncertain) else None,
                "probeDurationMs": error.duration_ms if isinstance(error, ProbeUncertain) else None,
                "actionTaken": "FAILED_SAFE_NO_RETRY_NO_DB_WRITE",
            }
            directory = incident_dir()
            latch_created = False
            try:
                directory.mkdir(parents=True, exist_ok=True, mode=0o700)
                (directory / "FAILED_SAFE").write_text("manual storage review required\n")
                latch_created = True
                with (directory / "incidents.ndjson").open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(incident) + "\n")
            except OSError:
                print("[storage-guard] internal incident log unavailable", file=sys.stderr)
            if self.connection:
                try:
                    self.connection.close()
                except sqlite3.Error:
                    pass
            if latch_created:
                try:
                    self.uncertain_marker.unlink(missing_ok=True)
                except OSError:
                    print("[storage-guard] uncertain marker could not be removed", file=sys.stderr)
        raise StorageFatal("STORAGE_UNAVAILABLE: writer has entered irreversible FAILED_SAFE") from error

    def _check(self, identity):
        if not self.expected_uuid or not str(self.mount).startswith("/Volumes/"):
            raise StorageFatal("expected external mount and UUID must be configured")
        if not self.mount.is_dir() or self.mount.is_symlink():
            raise StorageFatal("expected volume is not mounted")
        if self.probe is volume_info and not os.path.ismount(self.mount):
            raise StorageFatal("expected volume is absent from mount table")
        real_mount = self.mount.resolve(strict=True)
        if not self.target.is_relative_to(self.mount):
            raise StorageFatal("DB is outside expected volume")
        ancestor = self.target if self.target.exists() else self.target.parent
        while not ancestor.exists() and ancestor != self.mount:
            ancestor = ancestor.parent
        real_ancestor = ancestor.resolve(strict=True)
        if not real_ancestor.is_relative_to(real_mount):
            raise StorageFatal("DB parent resolves outside expected volume")
        mount_dev = real_mount.stat().st_dev
        if mount_dev != real_ancestor.stat().st_dev or (self.device is not None and mount_dev != self.device):
            raise StorageFatal("mount or DB device identity changed")
        if self.target.exists() and (not self.target.is_file() or self.target.stat().st_dev != mount_dev):
            raise StorageFatal("DB is not a file on the expected device")
        for suffix in ("-wal", "-shm"):
            companion = Path(str(self.target) + suffix)
            if companion_requires_full_probe(companion, real_mount, mount_dev):
                identity = True
        if identity:
            info = self.probe(self.mount)
            if info.get("MountPoint") != str(self.mount) or not info.get("VolumeUUID"):
                raise StorageFatal("expected volume is not mounted at this path")
            if str(info["VolumeUUID"]).upper() != self.expected_uuid.upper():
                raise StorageFatal("volume UUID mismatch")
            if info.get("WritableVolume") is not True:
                raise StorageFatal("volume is read-only")
            stats = os.statvfs(real_mount)
            free = stats.f_bavail * stats.f_frsize
            total = stats.f_blocks * stats.f_frsize
            if free < self.min_free_bytes or free / max(total, 1) * 100 < self.min_free_percent:
                raise StorageFatal("insufficient storage")
            self.mount_real = real_mount
        elif (self.mount_real is not None and self.mount_real != real_mount) or not os.access(real_mount, os.W_OK):
            raise StorageFatal("mount identity or writability changed")
        self.device = mount_dev

    def assert_writable(self, force=False):
        if self.state == "FAILED_SAFE":
            raise StorageFatal("STORAGE_UNAVAILABLE: writer is permanently failed safe")
        if self.state == "PROBE_UNCERTAIN":
            raise StorageFatal("STORAGE_UNAVAILABLE: identity confirmation is in progress")
        if (incident_dir() / "FAILED_SAFE").exists():
            self.state = "FAILED_SAFE"
            raise StorageFatal("STORAGE_UNAVAILABLE: manual storage review required")
        for marker in incident_dir().glob("PROBE_UNCERTAIN-*"):
            if not marker.name.removeprefix("PROBE_UNCERTAIN-").isdigit():
                continue
            owner = int(marker.name.removeprefix("PROBE_UNCERTAIN-"))
            try:
                os.kill(owner, 0)
            except ProcessLookupError as error:
                self.fatal(StorageFatal("probe owner exited before confirmation"))
            except PermissionError:
                pass
            raise StorageFatal("STORAGE_UNAVAILABLE: identity confirmation is in progress")
        now = self.clock()
        identity = force or self.last_identity is None or now - self.last_identity >= 300
        try:
            if identity or self.last_stat is None or now - self.last_stat >= 1:
                self._check(identity)
                self.last_stat = self.clock()
                if identity:
                    self.last_identity = self.last_stat
                self.state = "HEALTHY"
        except ProbeUncertain as error:
            self.state = "PROBE_UNCERTAIN"
            try:
                self.uncertain_marker.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with self.uncertain_marker.open("x", encoding="utf-8") as marker:
                    marker.write(f"{time.time()}\n")
            except OSError as marker_error:
                self.fatal(marker_error)
            self.record_probe_event("PROBE_UNCERTAIN", error)
            for delay in (1, 2):
                try:
                    self._check(False)
                    self.wait(delay)
                    self._check(True)
                    self.uncertain_marker.unlink()
                    self.state = "HEALTHY"
                    self.last_identity = self.clock()
                    self.last_stat = self.last_identity
                    self.recovered_transient_count += 1
                    self.record_probe_event("TRANSIENT_PROBE_FAILURE_RECOVERED", error)
                    return
                except ProbeUncertain:
                    continue
                except (OSError, subprocess.SubprocessError, ValueError, StorageFatal) as fatal_error:
                    self.fatal(fatal_error)
            self.fatal(error)
        except (OSError, subprocess.SubprocessError, ValueError, StorageFatal) as error:
            self.fatal(error)

    def run(self, operation, *args, **kwargs):
        self.assert_writable()
        try:
            return operation(*args, **kwargs)
        except (sqlite3.Error, OSError) as error:
            if is_storage_error(error):
                self.fatal(error)
            raise


class GuardedConnection(sqlite3.Connection):
    def __init__(self, *args, guard, **kwargs):
        super().__init__(*args, **kwargs)
        self._storage_guard = guard

    def execute(self, *args, **kwargs):
        return self._storage_guard.run(super().execute, *args, **kwargs)

    def executemany(self, *args, **kwargs):
        return self._storage_guard.run(super().executemany, *args, **kwargs)

    def executescript(self, *args, **kwargs):
        return self._storage_guard.run(super().executescript, *args, **kwargs)

    def commit(self):
        return self._storage_guard.run(super().commit)

    def cursor(self, *args, **kwargs):
        self._storage_guard.assert_writable()
        kwargs.setdefault("factory", GuardedCursor)
        cursor = super().cursor(*args, **kwargs)
        cursor._storage_guard = self._storage_guard
        return cursor


class GuardedCursor(sqlite3.Cursor):
    _storage_guard = None

    def execute(self, *args, **kwargs):
        return self._storage_guard.run(super().execute, *args, **kwargs)

    def executemany(self, *args, **kwargs):
        return self._storage_guard.run(super().executemany, *args, **kwargs)

    def executescript(self, *args, **kwargs):
        return self._storage_guard.run(super().executescript, *args, **kwargs)


def connect_writer(target, **kwargs):
    if not requires_guard(target):
        return sqlite3.connect(target, **kwargs)
    key = str(Path(target).absolute())
    guard = _guards.setdefault(key, StorageGuard(target))
    guard.assert_writable(force=True)
    try:
        connection = sqlite3.connect(target, factory=lambda *a, **kw: GuardedConnection(*a, guard=guard, **kw), **kwargs)
    except (sqlite3.Error, OSError) as error:
        if is_storage_error(error):
            guard.fatal(error)
        raise
    guard.connection = connection
    return connection
