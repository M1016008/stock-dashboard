# Builds the one-off rebuild and watchdog plists from the weekly-optimization plist.
# --check: rebuild them in memory and compare with the files here (prints PLISTS_MATCH or exits 1).
import plistlib, sys, os
SRC = os.path.expanduser('~/Library/LaunchAgents/com.stockboard.weekly-optimization.plist')
OUT = '/Users/yoshio/dev/stock-dashboard/.claude/worktrees/us-rebuild-ebd9fe7/ops/us-rebuild-20261127'
REL = '/Users/yoshio/dev/stock-dashboard-release-7df6c23'
WT = '/Users/yoshio/dev/stock-dashboard/.claude/worktrees/us-rebuild-ebd9fe7'
LOGS = '/Users/yoshio/Library/Logs/StockBoard'
TMP = '/Volumes/OWC Express 1M2 80G/stockboard-data/us/.us-rebuild-20261127-tmp'
w = plistlib.load(open(SRC, 'rb'))
cmd = w['ProgramArguments'][2]
assert cmd.count(f'cd "{REL}"') == 1 and cmd.endswith(' && npm run batch:weekly-optimize')
cmd = cmd.replace(f'cd "{REL}"', f'cd "{WT}"').replace(
    ' && npm run batch:weekly-optimize',
    f' && export US_PROMOTED_BACKUP_RETENTION=1 && export SQLITE_TMPDIR="{TMP}" && export US_SIGNAL_RETURN_TMPDIR="{TMP}"'
    ' && npm run batch:weekly-optimize')
r = {
    'Label': 'com.stockboard.us-rebuild-20261127',
    'EnvironmentVariables': dict(w['EnvironmentVariables']),
    'LowPriorityIO': True, 'Nice': 10, 'ProcessType': 'Background',
    'ProgramArguments': ['/bin/zsh', '-lc', cmd],
    'RunAtLoad': False,
    'StandardErrorPath': f'{LOGS}/us-rebuild-20261127.err',
    'StandardOutPath': f'{LOGS}/us-rebuild-20261127.log',
    'WorkingDirectory': WT,
}
assert (w['LowPriorityIO'], w['Nice'], w['ProcessType']) == (True, 10, 'Background')
CHECK = '--check' in sys.argv
mismatch = []
def emit(obj, name):
    data = plistlib.dumps(obj)
    if CHECK:
        if open(f'{OUT}/{name}', 'rb').read() != data:
            mismatch.append(name)
    else:
        open(f'{OUT}/{name}', 'wb').write(data)
emit(r, 'com.stockboard.us-rebuild-20261127.plist')
d = {
    'Label': 'com.stockboard.us-rebuild-watchdog-20261127',
    # Through /bin/zsh -lc like the other StockBoard jobs (the same launchd/TCC path that already reaches the OWC).
    'ProgramArguments': ['/bin/zsh', '-lc', f'exec /usr/bin/python3 -I "{OUT}/watchdog.py" 300 202612022200 15'],
    'StartInterval': 300, 'RunAtLoad': True, 'Nice': 5,
    'StandardOutPath': f'{LOGS}/us-rebuild-watchdog-20261127.log',
    'StandardErrorPath': f'{LOGS}/us-rebuild-watchdog-20261127.err',
    'WorkingDirectory': '/private/tmp',
}
emit(d, 'com.stockboard.us-rebuild-watchdog-20261127.plist')
d['ProgramArguments'][2] = d['ProgramArguments'][2].replace(' 202612022200 ', ' 202612042200 ')
assert '202612042200' in d['ProgramArguments'][2]
emit(d, 'com.stockboard.us-rebuild-watchdog-20261127-ext.plist')
if CHECK:
    print('PLISTS_MATCH' if not mismatch else 'PLISTS_DIFFER ' + ' '.join(mismatch))
    sys.exit(1 if mismatch else 0)
print('written')
