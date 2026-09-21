"""Isolated fatal-state simulation; never touches the external SSD."""

import errno
import json
import os
from pathlib import Path
import sqlite3
import tempfile

from external_storage_guard import GuardedConnection, ProbeUncertain, StorageFatal, StorageGuard, companion_requires_full_probe, is_storage_error


with tempfile.TemporaryDirectory(prefix="storage-guard-python-") as temporary:
    os.environ["STOCK_DATA_INCIDENT_DIR"] = temporary
    for incident in ("EIO", "MOUNT_LOST", "UUID_MISMATCH", "READ_ONLY", "DISK_FULL"):
        now = [0.0]
        guard = StorageGuard(Path(temporary) / "fixture.db", clock=lambda: now[0])
        condition = [None]

        def check(identity):
            if condition[0]:
                raise condition[0]

        guard._check = check
        guard.assert_writable(force=True)
        connection = sqlite3.connect(":memory:", factory=lambda *a, **kw: GuardedConnection(*a, guard=guard, **kw))
        guard.connection = connection
        connection.execute("CREATE TABLE sample (value INTEGER)")
        connection.execute("INSERT INTO sample VALUES (1)")
        assert connection.execute("SELECT COUNT(*) FROM sample").fetchone()[0] == 1
        writes = [0]
        if incident == "EIO":
            def failing_write():
                writes[0] += 1
                raise OSError(errno.EIO, "synthetic disk I/O error")
            try:
                guard.run(failing_write)
            except StorageFatal:
                pass
        else:
            condition[0] = StorageFatal(incident)
            now[0] = 2.0
            try:
                guard.assert_writable()
            except StorageFatal:
                pass
        assert guard.state == "FAILED_SAFE"
        for _ in range(2):
            try:
                guard.run(lambda: writes.__setitem__(0, writes[0] + 1))
                raise AssertionError("write after fatal unexpectedly succeeded")
            except StorageFatal:
                pass
        assert writes[0] == (1 if incident == "EIO" else 0), incident
        (Path(temporary) / "FAILED_SAFE").unlink()

    attempts = [0]
    uncertain_writes = [0]
    recovered = StorageGuard(Path(temporary) / "fixture.db", clock=lambda: 10.0, wait=lambda _: (
        assert_uncertain(recovered, uncertain_writes)))

    def flaky_check(identity):
        if identity:
            attempts[0] += 1
            if attempts[0] == 1:
                raise ProbeUncertain("DISKUTIL_INFO", TimeoutError("synthetic timeout"))

    def assert_uncertain(guard, writes):
        assert guard.state == "PROBE_UNCERTAIN"
        assert guard.uncertain_marker.exists()
        try:
            guard.run(lambda: writes.__setitem__(0, writes[0] + 1))
        except StorageFatal:
            pass
        else:
            raise AssertionError("write during uncertain probe")
        peer = StorageGuard(Path(temporary) / "fixture.db", clock=lambda: 10.0)
        try:
            peer.assert_writable()
        except StorageFatal:
            pass
        else:
            raise AssertionError("peer writer admitted during uncertain probe")

    recovered._check = flaky_check
    recovered.assert_writable(force=True)
    assert recovered.state == "HEALTHY" and recovered.recovered_transient_count == 1
    assert attempts[0] == 2 and uncertain_writes[0] == 0
    assert not recovered.uncertain_marker.exists()
    assert not (Path(temporary) / "FAILED_SAFE").exists()

    class DisappearingCompanion:
        def __init__(self):
            self.present = True

        def exists(self):
            return self.present

        def resolve(self, strict=False):
            self.present = False
            raise FileNotFoundError("WAL was removed after existence check")

    assert companion_requires_full_probe(DisappearingCompanion(), Path(temporary), 42)

    parse_guard = StorageGuard(Path(temporary) / "fixture.db", clock=lambda: 15.0, wait=lambda _: None)
    parse_attempts = [0]

    def parse_check(identity):
        if identity:
            parse_attempts[0] += 1
            if parse_attempts[0] == 1:
                raise ProbeUncertain("PLUTIL_PARSE", ValueError("synthetic malformed plist"))

    parse_guard._check = parse_check
    parse_guard.assert_writable(force=True)
    assert parse_guard.state == "HEALTHY" and parse_attempts[0] == 2
    assert not (Path(temporary) / "FAILED_SAFE").exists()

    repeated = StorageGuard(Path(temporary) / "fixture.db", clock=lambda: 20.0, wait=lambda _: None)
    repeated_attempts = [0]

    def repeated_check(identity):
        if identity:
            repeated_attempts[0] += 1
            raise ProbeUncertain("PLUTIL_PARSE", ValueError("synthetic parse failure"))

    repeated._check = repeated_check
    try:
        repeated.assert_writable(force=True)
    except StorageFatal:
        pass
    assert repeated.state == "FAILED_SAFE" and repeated_attempts[0] == 3
    (Path(temporary) / "FAILED_SAFE").unlink()

    incidents = (Path(temporary) / "incidents.ndjson").read_text().splitlines()
    assert len(incidents) == 6
    assert all(json.loads(line)["actionTaken"] == "FAILED_SAFE_NO_RETRY_NO_DB_WRITE" for line in incidents)
    assert "STOCK_DATA_VOLUME_UUID" not in "\n".join(incidents)
    assert is_storage_error(sqlite3.OperationalError("disk I/O error"))
    assert is_storage_error(OSError(errno.ENOSPC, "synthetic full"))
    stale_marker = Path(temporary) / "PROBE_UNCERTAIN-999999999"
    stale_marker.write_text("fixture\n")
    stale_guard = StorageGuard(Path(temporary) / "fixture.db", clock=lambda: 30.0)
    try:
        stale_guard.assert_writable()
    except StorageFatal:
        pass
    else:
        raise AssertionError("stale probe owner did not fail closed")
    assert stale_guard.state == "FAILED_SAFE"
    stale_marker.unlink()
    (Path(temporary) / "FAILED_SAFE").unlink()
    print("Python storage guard simulation: PASS (transient recovery, confirmed fatal, no retry/write)")
