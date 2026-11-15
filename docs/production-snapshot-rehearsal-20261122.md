# 11/22（日）14:15 OWC での複製のリハーサル：当日のコマンド

2026-11-15 作成。**実施にはオーナーの承認が要る**（下の「承認が要る操作」）。12/6 の Backup と P1 の控えで使う部品
（`lib/storage/locked-sqlite-snapshot.ts`、`scripts/run-locked-sqlite-snapshot.ts`）を、本番の DB に対して 1 回だけ動かし、
鍵を持つ時間と複製の時間、OWC の空きを測る。作った複製は、その場で消す（`--remove-after`）。SanDisk には触れない。

## 承認が要る操作

- (a) 複製の部品を OWC に置く：`StockBoard Development/tools/apfs-clone-file-20261122/apfs-clone-file`（新しいフォルダ）。
- (b) 本番の日本株・米国株の DB に、書き込みの鍵（`BEGIN IMMEDIATE`）を取る。何も書かない。最長 60 秒。
- (c) OWC に `StockBoard Development/weekly-backup-staging/`（新しいフォルダ）を作り、その下に一時的な複製を作って、すぐ消す。

定期処理は止めない。Web・類似の検索も止めない。

## 指紋

| 対象 | 値 |
|---|---|
| ブランチの commit | 承認依頼に書く（この文書を含む commit） |
| `scripts/native/apfs-clone-file.c` | `b42cf59d552c3f0718f3548f9d5c8fa41949430173972a22a1bdb8b04dd59786` |
| 作った部品（同じ元から 2 回作って同じ値になることを確認済み、Apple clang 17.0.0） | `a1b39de6655a320ce67efc86f2a5c04cebf8853525ea0fef8b4266a1f7164f55` |
| 固定の sqlite3 3.54.1 | `9a538234fe523a7bda07d526950c53f7054e5c41401510d1af3d7adf9ba2026d` |
| `scripts/run-locked-sqlite-snapshot.ts`・`lib/storage/locked-sqlite-snapshot.ts` | 承認依頼に書く |

## 鍵を持っている間に、ほかの処理がどうなるか

- 読み取り（Web・類似の検索・gateway の表示、各定期処理の読み取り）は、待たされない。DB は WAL 方式で、書き込みの鍵は読み取りを止めない。
- 書き込み：
  - **定期処理**（trigger-historical-scan を含め、すべて Node の DB の部品を使う）：1 回の待ちが 60 秒（trigger-historical-scan は
    plist で 60 秒・やり直し 3 回、ほかは既定の 60 秒・やり直し 8 回）。鍵が最長の 60 秒でも、待ってから書けるので、
    エラーにならない。db-maintenance（sqlite3 を直接使う）は 12:30 と 15:30 で、重ならない。
  - **Web・類似の検索**：1 回の待ちが 5 秒、やり直し 3 回（plist の値）で、合わせて約 21 秒まで待つ。
    - 鍵が約 20 秒未満：待ってから書ける（その画面の表示が少し遅れるだけ）。
    - 鍵が約 20〜60 秒：ダッシュボードのキャッシュ（`dashboard_cache`）を作り直す画面の 1 回分がエラーになる。
      決算と売買の合図のキャッシュは、書き込みを飛ばして警告を出すだけ。
    - 日曜は、最新日のキャッシュが earnings-refresh（14:10）で作られた後なので、Web が書くこと自体が少ない。
  - **エラーの後に残るもの**：無い。失敗した書き込みは SQLite が取り消すので、途中の行は残らない。鍵の処理は終わる
    （終わらなければ止める）ので、鍵も残らない。次の回（次の画面の表示、定期処理の次の実行）は普通に動く。
- 見込みの鍵の時間：試験の環境では 0.4〜0.7 秒。本番の DB（各 550 GB、書き換えが多い）での複製の時間は未測定で、
  それを測るのがこのリハーサルの目的。

## 四季報の取り直し（08:00〜、約 5 時間 40 分）との関係

- 四季報のツールは、自分のキャッシュ（`~/Downloads/scrape_data_mac` の中の sqlite）と OWC の CSV にだけ書き、
  本番の DB は開かない（ツールのコードを読んで確認。ツールは変えていない）。重なっても、互いに影響しない。
- 気をつけるのは、CSV ができた後の取り込み（classification-sync）。取り込みは本番の DB に長く書くので、その最中に
  鍵を取ろうとすると最大 30 秒待って失敗する（何も作らずに終わる）。
- **決まり**：
  - 四季報のツールが動いていても、下の開始の条件がすべて満たされていれば始める。
  - classification-sync・earnings-refresh など、定期処理が動いている間は始めない。5 分ごとに確かめ直す。
  - 15:15 までに条件がそろわなければ、その日はやめて相談する（15:30 の db-maintenance、16:05 からの classification-sync の前に終える）。

## 実行者と立ち会い

- 実行は Claude Code（各手順は数秒〜数十秒で終わる）。
- オーナーの立ち会いは不要。始める前と終わった後に報告する。想定と違う結果が出たら、先へ進まずに止めて相談する。

## コマンド

### (0) 準備

```bash
cd /Users/yoshio/dev/stock-dashboard/.claude/worktrees/weekly-backup-cli
OWC="/Volumes/OWC Express 1M2 80G"; T="$OWC/StockBoard Development/tools"; Q="$T/sqlite-3.54.1/sqlite3"; H="$T/apfs-clone-file-20261122/apfs-clone-file"; JP="$OWC/stock-dashboard/stockboard.db"; US="$OWC/stockboard-data/us/stockboard-us.db"; STG="$OWC/StockBoard Development/weekly-backup-staging"
```

### (1) 14:00 ごろ　コードの確認

```bash
git rev-parse HEAD; git status --short; shasum -a 256 scripts/native/apfs-clone-file.c scripts/run-locked-sqlite-snapshot.ts lib/storage/locked-sqlite-snapshot.ts "$Q"
```

- HEAD と各値が、承認依頼の値と同じ。`git status --short` は何も出さない。

### (2) 14:05 ごろ　部品を置く（承認 (a)）

```bash
test ! -e "$T/apfs-clone-file-20261122" && mkdir -m 700 "$T/apfs-clone-file-20261122" && cc -O2 -Wall -Werror -o "$H" scripts/native/apfs-clone-file.c && shasum -a 256 "$H"
```

- 最後の値が `a1b39de6655a320ce67efc86f2a5c04cebf8853525ea0fef8b4266a1f7164f55`。違えば止める（部品は使わない）。

### (3) 14:15　開始の条件（すべて満たすこと）

```bash
launchctl list | grep com.stockboard | awk '$1!="-"{print $1, $3}'; pgrep -fl 'sync-classification-csv|refresh-earnings|update-latest|update-us-latest|maintenance-db|run-weekly-backup|run-locked-sqlite' ; lsof -nP "$JP" "$US" 2>/dev/null | awk 'NR>1{print $1, $2}' | sort -u
```

- 1 つ目：PID が出るのは web・analog-search・friend-readonly-gateway・trigger-historical-scan（と、出ていれば dev-capacity-monitor・web-health）だけ。
- 2 つ目（pgrep）：何も出さない。
- 3 つ目：DB を開いているのは、上の web・analog-search・trigger-historical-scan の PID の `node` だけ。

```bash
node --import tsx scripts/run-locked-sqlite-snapshot.ts --staging="$STG/rehearsal-20261122" --db=JP="$JP" --db=US="$US" --sqlite3="$Q" --sqlite3-sha256=9a538234fe523a7bda07d526950c53f7054e5c41401510d1af3d7adf9ba2026d --clone-binary="$H" --clone-binary-sha256=a1b39de6655a320ce67efc86f2a5c04cebf8853525ea0fef8b4266a1f7164f55 --min-free-bytes=1000000000000 --max-lock-ms=60000
```

- `"mode": "observe"`、`freeBytes` が 1,000,000,000,000 以上、JP・US の `bytes` が 11/15 の値（552,900,132,864・552,775,794,688）に近い。
- 1 つでも違えば、5 分後にやり直す。15:15 を過ぎたらやめて相談する。

### (4) 実行（承認 (b)(c)。1 行のまま）

```bash
test -d "$STG" || mkdir -m 700 "$STG"; node --import tsx scripts/run-locked-sqlite-snapshot.ts --staging="$STG/rehearsal-20261122" --db=JP="$JP" --db=US="$US" --sqlite3="$Q" --sqlite3-sha256=9a538234fe523a7bda07d526950c53f7054e5c41401510d1af3d7adf9ba2026d --clone-binary="$H" --clone-binary-sha256=a1b39de6655a320ce67efc86f2a5c04cebf8853525ea0fef8b4266a1f7164f55 --min-free-bytes=1000000000000 --max-lock-ms=60000 --remove-after --confirm=WRITE_APPROVED_LOCKED_SNAPSHOT > ~/stockboard-snapshot-rehearsal-20261122.json 2>&1; echo "rc=$?"; cat ~/stockboard-snapshot-rehearsal-20261122.json
```

期待する値：
- `rc=0`、`"mode": "execute"`、`"removed": true`。
- `snapshot.files` が `JP db`・`JP wal`・`US db`・`US wal` の 4 つ（米国株の WAL が無い場合も、鍵の処理が空の WAL を作るので 4 つ）。
- `snapshot.lockHeldMs` が 60,000 未満（見込みは数秒以下）。
- `after.freeBytes` と `freeBytesAfterRemoval` が、`before.freeBytes` から数 GB 以内。
- `[locked-snapshot] FAILED` で終わった場合：`SNAPSHOT_LOCK_FAILED` なら 5 分後に 1 回だけやり直す。それ以外は、やり直さずに (5) をして相談する。

### (5) 終わった後の確認

```bash
ls -la "$STG"; pgrep -fl 'sqlite-3.54.1/sqlite3|apfs-clone-file'; curl -s http://127.0.0.1:3000/api/health | head -c 120; echo; curl -s http://127.0.0.1:3105/api/health | head -c 120; echo; grep -hE 'database is locked|SQLITE_BUSY|cache write skipped' ~/Library/Logs/StockBoard/web.log ~/Library/Logs/StockBoard/analog-search.log ~/Library/Logs/StockBoard/trigger-historical-scan.log 2>/dev/null | tail -5
```

- `$STG` の中は空（`rehearsal-20261122` が無い）。
- pgrep は何も出さない。
- 2 つの health に `"status":"ok"`。
- 最後の grep：鍵の時間が 20 秒未満なら、何も出ないのが期待。出たら、その行を報告する（残るものは無く、次の回は普通に動く）。

## 止めるとき

- `kill -9` は使わない。
- CLI が 2 分たっても終わらないときは、`kill -INT <CLI の node の PID>`（端末で動かしている場合は `Ctrl-C`）。
  CLI は終わり、鍵の sqlite3 は入力が閉じたのを見て取り消して終わる（
  `no_ckpt_on_close` を設定済みなので書き戻さない。11/15 に作業用の場所で試し、DB と WAL が変わらないことを確かめた）。
  ただし、その時に動いていた複製の部品は最後まで動き、鍵の無い複製を 1 つ残すことがある（本番は読むだけで、害は無い）。
  `pgrep -fl 'sqlite-3.54.1/sqlite3|apfs-clone-file'` が何も出さなくなるのを待ち、
  `$STG/rehearsal-20261122` が残っていれば、手順書（`docs/production-weekly-backup-runbook.md`）の「Leftover snapshot」のとおり、
  その中の複製だけを消す（消す前に一覧を報告する）。
