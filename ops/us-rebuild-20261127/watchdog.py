#!/usr/bin/python3 -I
# US rebuild watchdog (2026-11-27). launchd runs it every 5 minutes. It only reads, except:
#   - appends one line per run to its log (stdout, set by the plist),
#   - on the first crossed limit, writes the "fired" marker and sends SIGTERM once to the rebuild runner.
# It never sends a second signal and never uses SIGKILL. The runner then stops its steps and rolls back (PR #88).
# Limits: OWC free space, internal-disk free space, a fixed deadline, and the JP daily update (price by 18:30, jp-core fresh by 23:00 JST
# on JP trading days, read from the data-freshness-guard log).
import datetime as dt
import json
import os
import signal
import subprocess
import sys

JST = dt.timezone(dt.timedelta(hours=9))
HOME = os.path.expanduser('~')
# WD_* overrides exist only for test-watchdog.zsh. They are ignored unless WD_TEST_MODE=1, and the log line says mode=test
# when they are honoured; U2 and U-EXT require mode=prod.
TEST_MODE = os.environ.get('WD_TEST_MODE') == '1'


def E(name, default=None):
    return os.environ.get(name, default) if TEST_MODE else default

LABEL = E('WD_LABEL', 'com.stockboard.us-rebuild-20261127')
WORKTREE = E('WD_WORKTREE', '/Users/yoshio/dev/stock-dashboard/.claude/worktrees/us-rebuild-ebd9fe7')
LOCK = E('WD_LOCK', HOME + '/Library/Application Support/StockBoard/weekly-optimization.lock')
GUARD_LOG = E('WD_GUARD_LOG', HOME + '/Library/Logs/StockBoard/data-freshness-guard.log')
VOLUME = E('WD_VOLUME', '/Volumes/OWC Express 1M2 80G')
US_DIR = E('WD_US_DIR', VOLUME + '/stockboard-data/us')
INTERNAL = E('WD_INTERNAL', '/System/Volumes/Data')  # the internal disk (/tmp, TMPDIR, logs)
JP_DB = E('WD_JP_DB', VOLUME + '/stock-dashboard/stockboard.db')
MARKER = E('WD_MARKER', HOME + '/Library/Application Support/StockBoard/us-rebuild-20261127-watchdog-fired.json')
DRY = E('WD_DRY') == '1'  # tests only: never signal


def now_jst():
    fixed = E('WD_NOW')  # tests only: YYYYmmddHHMM JST
    return dt.datetime.strptime(fixed, '%Y%m%d%H%M').replace(tzinfo=JST) if fixed else dt.datetime.now(JST)


def run(args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return ''


def process_table():
    rows = {}
    for line in run(['/bin/ps', '-axo', 'pid=,ppid=,command=']).splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            rows[int(parts[0])] = (int(parts[1]), parts[2])
    return rows


def job_pid():
    for line in run(['/bin/launchctl', 'print', 'gui/%d/%s' % (os.getuid(), LABEL)]).splitlines():
        key, _, value = line.strip().partition(' = ')
        if key == 'pid' and value.isdigit():
            return int(value)
    return None


def find_runner():
    """(pid, None) when the lock names our runner; (None, note) otherwise. Never guesses."""
    try:
        pid = int(open(LOCK).read().strip())
    except FileNotFoundError:
        return None, 'no_lock'
    except Exception:
        return None, 'lock_unreadable'
    table = process_table()
    if pid not in table:
        return None, 'lock_pid_dead:%d' % pid
    if 'scripts/run-weekly-optimization.ts' not in table[pid][1]:
        return None, 'lock_pid_not_runner:%d' % pid
    cwd = ''
    for line in run(['/usr/sbin/lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn']).splitlines():
        if line.startswith('n'):
            cwd = line[1:]
    if not cwd or os.path.realpath(cwd) != os.path.realpath(WORKTREE):
        return None, 'runner_cwd_mismatch:%d:%s' % (pid, cwd or '-')
    leader = int(E('WD_JOB_PID')) if E('WD_JOB_PID') else job_pid()  # WD_JOB_PID: tests only
    seen, cur = set(), pid
    while cur and cur not in seen and cur != leader:
        seen.add(cur)
        cur = table.get(cur, (0, ''))[0]
    if leader is None or cur != leader:
        return None, 'runner_not_under_job:%d:%s' % (pid, leader)
    return pid, None


def guard_records():
    try:
        with open(GUARD_LOG, 'rb') as handle:
            handle.seek(0, 2)
            handle.seek(max(0, handle.tell() - 4_000_000))
            text = '\n' + handle.read().decode('utf8', 'replace')  # a record may start the file
    except Exception:
        return []
    records, start = [], text.find('\n{\n  "status"')
    while start >= 0:
        end = text.find('\n}\n', start)
        if end < 0:
            break
        try:
            records.append(json.loads(text[start + 1:end + 2]))
        except Exception:
            pass
        start = text.find('\n{\n  "status"', end)
    return records


def checked_at(record):
    try:
        return dt.datetime.fromisoformat(record['checkedAt'].replace('Z', '+00:00')).astimezone(JST)
    except Exception:
        return None


def jp_daily_reasons(now, records):
    today = now.strftime('%Y-%m-%d')
    reasons = []
    # (check time, earliest record accepted, give-up time when no such record exists)
    for name, check, since, missing in (('jp_price', '1830', '1815', '1900'), ('jp_core', '2300', '2245', '2330')):
        if now.strftime('%H%M') < check:
            continue
        floor = dt.datetime.strptime(today + since, '%Y-%m-%d%H%M').replace(tzinfo=JST)
        recent = [r for r in records if (checked_at(r) or floor - dt.timedelta(1)) >= floor]
        if not recent:
            if now.strftime('%H%M') >= missing and now.weekday() < 5:  # Mon-Fri: the guard writes every 15 min
                reasons.append('%s_guard_record_missing_since_%s' % (name, since))
            continue
        latest = recent[-1]
        if (latest.get('expected') or {}).get('jp') != today:
            continue  # not a JP trading day
        if name == 'jp_price':
            price = ((latest.get('dates') or {}).get('jp') or {}).get('price')
            if price != today:
                reasons.append('jp_price_late:%s' % price)
        else:
            core = [a.get('state') for a in latest.get('actions') or [] if a.get('key') == 'jp-core']
            if core != ['fresh']:
                reasons.append('jp_core_not_fresh:%s' % (core[0] if core else '-'))
    return reasons, (records[-1].get('checkedAt') if records else '-')


def size_gib(path):
    try:
        return '%.1f' % (os.stat(path).st_size / 2**30)
    except OSError:
        return '-'


def main():
    min_free_gib, deadline = float(sys.argv[1]), dt.datetime.strptime(sys.argv[2], '%Y%m%d%H%M').replace(tzinfo=JST)
    min_internal_gib = float(sys.argv[3])
    now = now_jst()
    head = now.strftime('%Y-%m-%dT%H:%M%z')
    if os.path.exists(MARKER):
        print(head, 'ALREADY_FIRED', flush=True)
        return
    pid, note = find_runner()
    reasons = []
    if os.path.ismount(VOLUME):
        stat = os.statvfs(VOLUME)
        free = stat.f_bavail * stat.f_frsize / 2**30
        if free < min_free_gib:
            reasons.append('owc_free_below_%g_gib:%.1f' % (min_free_gib, free))
    else:
        free = -1.0
        reasons.append('owc_not_mounted')
    stat = os.statvfs(INTERNAL)
    internal = stat.f_bavail * stat.f_frsize / 2**30
    if internal < min_internal_gib:
        reasons.append('internal_free_below_%g_gib:%.1f' % (min_internal_gib, internal))
    if now >= deadline:
        reasons.append('deadline_%s' % sys.argv[2])
    jp, guard_at = jp_daily_reasons(now, guard_records())
    reasons += jp
    shadow = US_DIR + '/stockboard-us.db.tiingo_adj_ohlc_ratio_v1.building'
    sizes = 'shadow=%s shadow_wal=%s analog_shadow=%s main_wal=%s' % (
        size_gib(shadow), size_gib(shadow + '-wal'),
        size_gib(US_DIR + '/analog-sequence-us-v2.db.tiingo_adj_ohlc_ratio_v1.building'),
        size_gib(US_DIR + '/stockboard-us.db-wal')) + ' jp_wal=%s' % size_gib(JP_DB + '-wal')
    line = '%s mode=%s runner=%s free_gib=%.1f internal_gib=%.1f %s guard_at=%s reasons=%s' % (
        head, 'test' if TEST_MODE else 'prod', pid or note, free, internal, sizes, guard_at, ','.join(reasons) or '-')
    if not reasons or pid is None:
        print(line + (' NO_SIGNAL' if reasons else ''), flush=True)
        return
    if DRY:
        write_marker(head, pid, reasons)
        print(line + ' WOULD_TERM', flush=True)
        return
    again, note = find_runner()  # re-check right before the signal
    if again != pid:
        print(line + ' NO_SIGNAL runner_changed:%s' % (again or note), flush=True)
        return
    try:
        os.kill(int(E('WD_KILL_PID') or pid), signal.SIGTERM)  # WD_KILL_PID: tests only
    except ProcessLookupError:
        print(line + ' SIGNAL_FAILED_ESRCH (no marker; checked again next run)', flush=True)
        return
    write_marker(head, pid, reasons)  # only after a delivered signal; a second TERM would be ignored by the runner anyway
    print(line + ' SENT_SIGTERM', flush=True)


def write_marker(head, pid, reasons):
    fd = os.open(MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump({'at': head, 'runner': pid, 'reasons': reasons, 'dry': DRY}, handle)


if __name__ == '__main__':
    main()
