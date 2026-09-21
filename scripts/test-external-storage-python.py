"""Isolated fatal-state simulation; never touches the external SSD."""

import errno
import json
import os
from pathlib import Path
import sqlite3
import tempfile

from external_storage_guard import GuardedConnection, StorageFatal, StorageGuard, is_storage_error


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
        assert guard.state == "STORAGE_FATAL"
        for _ in range(2):
            try:
                guard.run(lambda: writes.__setitem__(0, writes[0] + 1))
                raise AssertionError("write after fatal unexpectedly succeeded")
            except StorageFatal:
                pass
        assert writes[0] == (1 if incident == "EIO" else 0), incident
        (Path(temporary) / "FAILED_SAFE").unlink()

    incidents = (Path(temporary) / "incidents.ndjson").read_text().splitlines()
    assert len(incidents) == 5
    assert all(json.loads(line)["actionTaken"] == "FAILED_SAFE_NO_RETRY_NO_DB_WRITE" for line in incidents)
    assert "STOCK_DATA_VOLUME_UUID" not in "\n".join(incidents)
    assert is_storage_error(sqlite3.OperationalError("disk I/O error"))
    assert is_storage_error(OSError(errno.ENOSPC, "synthetic full"))
    print("Python storage fatal simulation: PASS (five failures, no retry/write, internal incident log)")
