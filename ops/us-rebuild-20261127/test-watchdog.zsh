#!/bin/zsh
# Tests the US rebuild watchdog with a fake runner, fake lock, fake guard log (nothing real is read or signalled).
set -u
WD="$(cd "$(dirname "$0")" && pwd)/watchdog.py"
T=$(mktemp -d -t us-rebuild-watchdog-test)
mkdir -p "$T/wt/scripts" "$T/other" "$T/us"
LEADER=""; RUNNER=""; OTHER=""
cleanup() { [ -n "$RUNNER" ] && kill $RUNNER 2>/dev/null; [ -n "$OTHER" ] && kill $OTHER 2>/dev/null; [ -n "$LEADER" ] && kill $LEADER 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT INT TERM
fail=0; ok() { echo "PASS $1"; }; ng() { echo "FAIL $1: $2"; fail=1; }
export WD_LOCK="$T/lock" WD_GUARD_LOG="$T/guard.log" WD_VOLUME=/ WD_US_DIR="$T/us" WD_MARKER="$T/marker" WD_WORKTREE="$T/wt" WD_LABEL=com.stockboard.test-not-loaded
start_runner() { # $1 = cwd. Leader zsh -> python runner whose command line names the runner script.
  ( cd "$1" && exec /bin/zsh -c '/usr/bin/python3 -c "import time; time.sleep(600)" scripts/run-weekly-optimization.ts & wait' ) &
  LEADER=$!; for i in {1..50}; do RUNNER=$(pgrep -P $LEADER -f run-weekly-optimization.ts | head -1); [ -n "$RUNNER" ] && break; sleep 0.1; done
  echo $RUNNER > "$T/lock"; }
stop_runner() { kill $RUNNER 2>/dev/null; wait $LEADER 2>/dev/null; }
guard() { # $1 checkedAt(UTC) $2 expected.jp $3 jp price $4 jp-core state
  printf '{\n  "status": "ok",\n  "checkedAt": "%s",\n  "expected": {"jp": "%s", "us": "x"},\n  "dates": {"jp": {"price": "%s"}},\n  "actions": [{"key": "jp-core", "state": "%s"}]\n}\n' "$1" "$2" "$3" "$4" >> "$T/guard.log"; }
w() { WD_JOB_PID=${JOB:-$LEADER} /usr/bin/python3 -I "$WD" --test-mode "$@" ${INT:-1} 2>&1; }
FREE=$(df -k / | tail -1 | awk '{print int($4/1048576)}'); LOW=1; HIGH=$((FREE+1000))
# Wed 2026-12-02 (weekday). 18:20 JST = 09:20Z.
start_runner "$T/wt"
: > "$T/guard.log"; guard 2026-12-02T09:20:00Z 2026-12-02 2026-12-02 would_trigger
o=$(WD_NOW=202612021835 WD_DRY=1 w $LOW 202612050000); [[ $o == *reasons=-* && ! -e $T/marker ]] && ok "1 price on time -> no signal" || ng 1 "$o"
o=$(WD_NOW=202612021700 WD_DRY=1 w $LOW 202612050000); [[ $o == *reasons=-* ]] && ok "2 before 18:30 nothing checked" || ng 2 "$o"
: > "$T/guard.log"; guard 2026-12-02T09:20:00Z 2026-12-02 2026-12-01 would_trigger
o=$(WD_NOW=202612021835 WD_DRY=1 w $LOW 202612050000); [[ $o == *jp_price_late:2026-12-01*WOULD_TERM && -e $T/marker ]] && ok "3 price late -> fires (dry)" || ng 3 "$o"
o=$(WD_NOW=202612021840 WD_DRY=1 w $LOW 202612050000); [[ $o == *ALREADY_FIRED* ]] && ok "4 fires only once" || ng 4 "$o"; rm -f "$T/marker"
: > "$T/guard.log"; guard 2026-12-02T09:00:00Z 2026-12-02 2026-12-01 would_trigger
o=$(WD_NOW=202612021850 WD_DRY=1 w $LOW 202612050000); [[ $o == *reasons=-* ]] && ok "5 only an old record, before 19:00 -> waits" || ng 5 "$o"
o=$(WD_NOW=202612021900 WD_DRY=1 w $LOW 202612050000); [[ $o == *jp_price_guard_record_missing_since_1815*WOULD_TERM ]] && ok "6 no record since 18:15 by 19:00 on a weekday -> fires" || ng 6 "$o"; rm -f "$T/marker"
o=$(WD_NOW=202611281930 WD_DRY=1 w $LOW 202612050000); [[ $o == *reasons=-* ]] && ok "7 Saturday: missing record does not fire" || ng 7 "$o"
: > "$T/guard.log"; guard 2026-11-28T09:30:00Z 2026-11-27 2026-11-27 fresh
o=$(WD_NOW=202611281835 WD_DRY=1 w $LOW 202612050000); [[ $o == *reasons=-* ]] && ok "8 Saturday (expected=Fri) -> no JP check" || ng 8 "$o"
: > "$T/guard.log"; guard 2026-12-02T09:20:00Z 2026-12-02 2026-12-02 fresh; guard 2026-12-02T13:50:00Z 2026-12-02 2026-12-02 would_trigger
o=$(WD_NOW=202612022305 WD_DRY=1 w $LOW 202612050000); [[ $o == *jp_core_not_fresh:would_trigger*WOULD_TERM ]] && ok "9 jp-core not fresh at 23:05 -> fires" || ng 9 "$o"; rm -f "$T/marker"
: > "$T/guard.log"; guard 2026-12-02T09:20:00Z 2026-12-02 2026-12-02 fresh; guard 2026-12-02T13:50:00Z 2026-12-02 2026-12-02 fresh
o=$(WD_NOW=202612022305 WD_DRY=1 w $LOW 202612050000); [[ $o == *reasons=-* ]] && ok "10 jp-core fresh -> no signal" || ng 10 "$o"
o=$(WD_NOW=202612022305 WD_DRY=1 w $LOW 202612022300); [[ $o == *deadline_202612022300*WOULD_TERM ]] && ok "11 deadline -> fires" || ng 11 "$o"; rm -f "$T/marker"
o=$(WD_NOW=202612021000 WD_DRY=1 w $HIGH 202612050000); [[ $o == *owc_free_below*WOULD_TERM ]] && ok "12 free space below the limit -> fires" || ng 12 "$o"; rm -f "$T/marker"
o=$(INT=100000 WD_NOW=202612021000 WD_DRY=1 w $LOW 202612050000); [[ $o == *internal_free_below_100000_gib*WOULD_TERM ]] && ok "12b internal disk below the limit -> fires" || ng 12b "$o"; rm -f "$T/marker"
o=$(WD_NOW=202612021000 WD_DRY=1 WD_VOLUME=$T/other w $LOW 202612050000); [[ $o == *owc_not_mounted*WOULD_TERM ]] && ok "13 volume not mounted -> fires" || ng 13 "$o"; rm -f "$T/marker"
/bin/sleep 300 & OTHER=$!
o=$(JOB=$OTHER WD_NOW=202612021000 WD_DRY=1 w $HIGH 202612050000); [[ $o == *runner_not_under_job*NO_SIGNAL && ! -e $T/marker ]] && ok "14 runner not under the job -> never signals" || ng 14 "$o"; kill $OTHER; rm -f "$T/marker"
o=$(WD_NOW=202612021000 WD_DRY=1 WD_WORKTREE=$T/other w $HIGH 202612050000); [[ $o == *runner_cwd_mismatch*NO_SIGNAL && ! -e $T/marker ]] && ok "15 runner in another folder -> never signals" || ng 15 "$o"
echo $$ > "$T/lock"; o=$(WD_NOW=202612021000 WD_DRY=1 w $HIGH 202612050000); [[ $o == *lock_pid_not_runner*NO_SIGNAL ]] && ok "16 lock names another process -> never signals" || ng 16 "$o"
rm -f "$T/lock"; o=$(WD_NOW=202612021000 WD_DRY=1 w $HIGH 202612050000); [[ $o == *runner=no_lock*NO_SIGNAL ]] && ok "17 no lock -> never signals" || ng 17 "$o"
echo $RUNNER > "$T/lock"
/bin/sleep 0 & DEAD=$!; wait $DEAD
o=$(WD_KILL_PID=$DEAD WD_NOW=202612021000 w $HIGH 202612050000); [[ $o == *SIGNAL_FAILED_ESRCH* && ! -e $T/marker ]] && kill -0 $RUNNER && ok "17b signal not delivered -> no marker, runner untouched" || ng 17b "$o"
o=$(WD_NOW=202612021000 w $HIGH 202612050000); sleep 0.5
if [[ $o == *SENT_SIGTERM* ]] && ! kill -0 $RUNNER 2>/dev/null && [ -e "$T/marker" ]; then ok "18 real SIGTERM reaches the runner once"; else ng 18 "$o"; fi
stop_runner
echo $LEADER > /dev/null; o=$(WD_NOW=202612021005 w $HIGH 202612050000); [[ $o == *ALREADY_FIRED* ]] && ok "19 after firing: no second signal" || ng 19 "$o"
# launchctl print parsing against a real loaded job (read-only): com.stockboard.web
real=$(launchctl list | awk '$3 == "com.stockboard.web" {print $1}')
got=$(WD_LABEL=com.stockboard.web /usr/bin/python3 -I -c 'import importlib.util,sys; sys.argv.append("--test-mode"); s=importlib.util.spec_from_file_location("wd", sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.job_pid())' "$WD")
[ -n "$real" ] && [ "$real" != "-" ] && [ "$got" = "$real" ] && ok "20 launchctl print pid parsing matches launchctl list ($got)" || ng 20 "real=$real got=$got"
# production mode ignores every WD_* override. Checked in memory only (main() is not run, so no real path is read).
o=$(WD_DRY=1 WD_KILL_PID=1 WD_LOCK="$T/lock" WD_JOB_PID=1 /usr/bin/python3 -I -c 'import importlib.util,sys; sys.argv=["watchdog.py","300","202612022200","15"]; s=importlib.util.spec_from_file_location("wd", "'"$WD"'"); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.TEST_MODE, m.DRY, m.LOCK.endswith("Application Support/StockBoard/weekly-optimization.lock"), m.E("WD_KILL_PID"), m.E("WD_JOB_PID"))' 2>&1)
[ "$o" = "False False True None None" ] && ok "21 without --test-mode every WD_* override is ignored" || ng 21 "$o"
[ $fail = 0 ] && echo WATCHDOG_TESTS_PASS || echo WATCHDOG_TESTS_FAIL
