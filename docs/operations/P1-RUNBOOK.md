# P1 手順書 (main と本番の統一)

記録日: 2026-11-11。実施予定: 2026-11-28 (土) 08:00〜12:00 (Backup が 1 週ずれた場合は 12/5)。
本番への操作は、すべてオーナーの実行または明示の承認の後に行う。秘密情報・キーの値はここに書かない。

- release ディレクトリ: `/Users/yoshio/dev/stock-dashboard-release-7df6c23` (今は `034310b`)
- 配置の記録: `~/Library/Application Support/StockBoard/release-state`
- DB: `/Volumes/OWC Express 1M2 80G/stock-dashboard/stockboard.db`、`/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db`

## 1. P1 の前の週までに済ませること

| 項目 | 内容 | 実行 |
|---|---|---|
| PR #115 | P1 の後に main から最初の Web 配置ができるようにする修正を main に入れる | Claude Code (Merge は承認後) |
| SMA の照合 | 実データ (Backup の写し) で、SMA の計算結果が本番の今の表示と一致することを確かめる (STATUS の確認項目) | Claude Code |
| 表を作る処理の試行 | 下の 1-1 | Claude Code |
| 実行環境の束 | main の `package-lock.json` から実行環境の束を作り、`runtime-manifest.json` の `baselineSha` を `034310b` にする (切り替えの時点では release ディレクトリが `034310b` のため) | Claude Code |
| 予行 (a) | 練習用の場所で、入れ替え → 確認 → 戻しを通す (下の 6-1)。日時は前もって承認を得る | Claude Code |
| 配置の証明を作る道具 | `scripts/create-sma-release-preflight-proof.ts` (10/29 に repo の外で使ったものを元にした)。束は `scripts/create-release-runtime-bundle.ts`。11/27 に確かめるだけの動かし方 (b) で本番に向けて試す (下の 6-2) | Claude Code |
| 前の成果物の写し | 今の `.next-live` (と `SMA_RELEASE_MANIFEST.json`) の写しを release ディレクトリの外に作る。確定後に戻すときの候補にする | Claude Code |

### 1-1. Backup の写しで main の表を作る処理を試す
- 11/15 の Backup の写し (読み取り専用) から、本番以外の場所に作業用の複製を作る (`cp -c`)。写しそのものには書かない。
- `.env.local` の無い main の作業用ディレクトリで、行き先を複製に固定して表を作る処理 (`lib/db/migrate.ts`) を 1 回動かし、前後の `sqlite_master` を比べる:
  `USE_LOCAL_DB=1 STOCKBOARD_DB_PATH=<複製の絶対パス> STOCK_DATA_MOUNT_PATH=<複製を置いたボリューム> STOCK_DATA_VOLUME_UUID=<そのボリュームの UUID> node --import tsx scripts/ensure-local-schema.ts`
  (外部ボリュームの DB には、ボリュームの確認 (Storage Guard) がかかるため、置いた場所のボリュームを明示する。UUID は `diskutil info` で確かめる)
  (`npm run db:ensure-schema` は `.env.local` を読み、本番の DB を指すおそれがあるため使わない)。本番の DB の更新時刻が変わらないことも確かめる。
- 確かめること: 増えるのは表 `stock_shikiho_rivals` と、その索引 2 つ (明示の `idx_shikiho_rivals_rival` と、主キーの自動の索引 `sqlite_autoindex_stock_shikiho_rivals_1`) だけ。既存の表・列・索引に変更がない。
  2 回目を動かしても何も増えない。
- 終わったら作業用の複製を消す (本番の DB とは別のファイル)。

## 2. `034310b` から main までの DB の変更

コードの中の CREATE・ALTER・DROP の文をすべて比べた (2026-11-11)。

| 変更 | 内容 | 戻した後の古いコード |
|---|---|---|
| 追加: 表 `stock_shikiho_rivals` と索引 1 つ (と主キーの自動の索引) (PR #107) | `lib/db/migrate.ts` の通常の準備で作られる | 動く。古いコードはこの表を読まない |
| 作る文の削除: `custom_charts`・`fx_rates_daily` (機能の削除) | DROP の文はなく、表は DB に残る | 動く |
| `market_universe` への列の追加 | 性能試験用のスクリプトだけ。本番では動かない | 関係なし |

- 結論: 本番の DB への変更は表が 1 つ増えることだけで、すべて追加。戻すときに DB の操作は要らない。
- DB 以外: 分類の同期の記録ファイルの形が版 4 から版 5 に変わる (PR #107)。戻すと古いコードは 1 回だけ取り込みをやり直す。害はない。

## 3. 当日の手順

### 3-1. 止める定期処理 (15 本)
- release ディレクトリのソースで動く 14 本: update-latest、us-update-latest、classification-sync、data-freshness-guard、
  db-maintenance、earnings-refresh、kabutan-material-news、kabutan-themes、large-holder-update、ml-freshness-guard、
  ml-learning、trigger-historical-scan、trigger-ml-frozen-monitor、weekly-optimization
- web-health (毎分 Web を確かめ、切り替えの途中に Web を再起動するおそれがあるため)
- Web と類似の検索は止めない (配置の仕組みが入れ替える)。friend-readonly-gateway・dev-capacity-monitor も止めない。

当日 08:00〜12:00 にかかる予定: 09:00 trigger-ml-frozen-monitor、10:30 us-update-latest、一定間隔の
data-freshness-guard (15 分)・trigger-historical-scan (5 分)・kabutan-material-news (1 時間)・web-health (毎分)。
前: 06:30 の us-update-latest。後: 12:30 db-maintenance、14:10 earnings-refresh。

### 3-2. 時刻表

| 時刻 | 操作 | 実行 |
|---|---|---|
| 07:50 | 06:30 の us-update-latest が終わり、常駐の trigger-historical-scan 以外の定期処理が動いていないことを `pgrep` で確かめる (trigger-historical-scan は待ち受けを続ける常駐の処理なので、07:55 の停止で止める) | Claude Code |
| 07:55 | 15 本を `launchctl bootout`。`launchctl print` で止まったことを確かめる | オーナー |
| 08:00 | Web・類似の検索・friend-readonly-gateway も止め (Web も表示用のキャッシュを DB に書くため)、DB の控えを取り (下の 4.)、3 本を戻して `/api/health` が ok になるのを待つ。止まるのは数分 | 停止・再開はオーナー、控えは Claude Code (承認後) |
| 08:15 | 配置の証明を作り (有効 15 分)、Web と類似の検索を切り替える。`STOCKBOARD_RELEASE_BASELINE_COMMIT=034310b…` | オーナー (実行) |
| 08:30 | **終了コードが 0 で、出力が `"status":"SUCCESS"` のときだけ次へ進む。** `PRECHECK_FAILED`・`ROLLED_BACK_UNHEALTHY` なら、release ディレクトリは `034310b` のまま、3-3 の順で戻して終える。`HOLD` なら定期処理も止めたまま手を止めて相談する (3-4) | オーナー・Claude Code |
| 08:35 | Web・類似の検索の `/api/health` が ok、主な画面が開くことを確かめる | Claude Code |
| 08:40 | release ディレクトリを main の commit に合わせる (`git checkout --detach <main の commit>`)。`git status` が `?? .node_modules-release-prev` だけであることを確かめる | オーナー |
| 08:50 | release ディレクトリで型検査 (`./node_modules/.bin/tsc --noEmit -p .`。束に tsc があることは予行で確かめる) だけを行う。定期処理の入口は実行しない (`--help` を受け付けずに本処理が動く入口があるため) | Claude Code |
| 09:30 | 下の 3-3 の順で戻す。weekly-optimization は戻さない (P1 の直後の日曜を飛ばす。STATUS の日程どおり、12/6 の Backup の後に戻す。1 週ずれた場合は 12/13 の Backup の後) | オーナー |
| 後日 | large-holder-update の plist から PATH の回避策を外し、更新の成功を確かめる (STATUS の項目) | オーナー |

### 3-3. 定期処理を戻す順
- 戻すとすぐ動く (RunAtLoad) ものが 9 本ある。書き込みが重ならないよう、次の順に 1 本ずつ戻し、動いたものは終わるのを待つ。
  1. すぐには動かないもの: update-latest、us-update-latest、db-maintenance、ml-freshness-guard、ml-learning
  2. web-health (Web を確かめるだけ)
  3. すぐ動いて書くもの: classification-sync (main で初めて動き、比較会社の表を作り、記録ファイルの版 5 への切り替えで 1 回取り込み直す)、
     earnings-refresh、large-holder-update、kabutan-themes、kabutan-material-news、trigger-ml-frozen-monitor
  4. trigger-historical-scan (常駐の処理。終わるのは待たず、動き続けていることと、ログに待ち受けの開始が出ることを確かめる)
  5. data-freshness-guard を最後に戻す (データが古いと判断すると、更新の処理を自分で起動するため)。起動したものがあれば終わるまで待つ
- trigger-ml-frozen-monitor は戻したときに 1 回動く (09:00 の分の代わり)。ログで動いたことを確かめ、動いていなければ手で `launchctl kickstart` する。
- us-update-latest は戻しても動かないため、最後に手で 1 回実行する (10:30 の分の代わり。土曜の決まりどおり)。

### 3-4. 戻し方
- 切り替えの途中の失敗: 配置の仕組みが自動で前の Web・類似の検索と実行環境に戻す。結果が `HOLD` のときは手を止めて相談する。
- 確定の後に戻す: (1) 定期処理を止める。(2) release ディレクトリを `034310b` に戻す。(3) 前の成果物の写しと前の束
  (`c9fb796-node24.11.1-next16.4.3-release`) を候補として、`STOCKBOARD_RELEASE_BASELINE_COMMIT=034310b…` で配置し直す。
  この手順は予行で 1 回通しておく。(4) 定期処理を戻す。DB は追加だけなので操作しない。DB が壊れた場合だけ、下の控えに戻す。

## 4. DB の控え (P1 の直前)

APFS の複製 (`cp -c`。同じ OWC の上に一瞬で複製を作り、書き換わった分だけ容量が増える)。

- 対象: 日本株の DB (514 GiB)、米国株の DB (514 GiB)、表示用のキャッシュの DB (60 MB)、類似の索引 2 つ (1.3 GB・5.2 GB)。
- DB を開くものをすべて止めてから複製する (定期処理 15 本に加え、Web・類似の検索・friend-readonly-gateway)。`-wal` が残っていれば
  一緒に複製し、`-shm` は複製しない (開いているものの間で使う一時的な情報のため)。本番の DB には書かない (WAL の書き戻しもしない)。
- 時間: 複製は数秒、Web が止まるのは数分。容量: 作った時点ではほぼ 0。OWC の空きは 2.0 TB (11/11)。
- 当日の午後に、複製に対して読み取りだけの `quick_check` を行う (本番の DB には触れない)。
- 戻し (オーナーの承認の後): 定期処理 15 本・Web・類似の検索・friend-readonly-gateway を止め、DB・`-wal`・`-shm` を開いているものが無いことを
  `lsof` で確かめる。今の DB・`-wal`・`-shm` は 3 つ一組で別の名前に移し (消さない)、複製の DB と (あれば) `-wal` を元の名前に戻す。`-shm` は戻さない。
- 注意: 同じディスクの上の控えなので、ディスクの故障には備えられない。故障への備えは 11/15・12/6 の正式な Backup。
- **片付けの期限: 遅くとも 12/3 (米国株の作り直しの前。1 週ずれた場合は 12/10)。** 作り直しで米国株の DB がほぼ全部書き換わり、複製が OWC を約 514 GB
  使うため。片付けはオーナーの承認の後に行う。

## 5. P1 の後に最初に Web を配置するとき
- release ディレクトリは main、今の実行環境の束には `034310b` の印が残る。
  `STOCKBOARD_RELEASE_BASELINE_COMMIT=<main の commit>` に加えて `STOCKBOARD_RELEASE_PRIOR_BASELINE_COMMIT=034310b…` を渡す (PR #115)。

## 6. P1 の前の試し (本番を変えない)

### 6-1. (a) 練習用の場所での入れ替えと戻し (案: 11/24 (火) 12:00〜16:00、だめなら 11/25 (水) 同じ時間)
- 場所: OWC の `StockBoard Development/release-rehearsal/20261124/` (内蔵ディスクは使わない)。練習用のサーバーは 127.0.0.1:3200 (Web) と :3205 (類似の検索)。
- 本番の :3000・:3105、launchd、本番の DB、release-state には触れない。練習用のサーバーは隔離の実行モード (preview) で動き、DB は練習用の場所の中の小さな試験用の DB (`isolation/data/`)。キーは渡さない。
- 本番から読むもの: 今の `.next-live` (写すだけ) と、今の束 `c9fb796…` (練習用の release ディレクトリから link するだけ。束は読み取り専用)。
  練習用の release ディレクトリは repo を OWC の上に複製して作る (元の repo に worktree を登録しない)。
- 練習用のサーバーへの停止・再開の信号は、記録した PID が練習用の port で待ち受け、作業フォルダが練習用の場所であるときだけ送る (別のプロセスには送らない)。
- 手順 (すべて Claude Code。日次更新の時間 (平日 16:40〜21:10) と米国の 06:30・10:30 を避ける):
  1. 候補の束: `npm run release:runtime-bundle -- --commit=<main> --baseline=034310b… --out=<練習用の場所>/runtime-<main の短い commit>` (`/usr/local/bin/node` で動かす)。
  2. 候補のビルド: 練習用の場所に main の作業用フォルダを作り、`node_modules` を 1. の束に link して、`NEXT_DIST_DIR=.next-live npm run build`。
     `.next-live` を `candidate-artifact` に写し、`STOCKBOARD_RELEASE_BASELINE_COMMIT=034310b… npm run release:sma-manifest -- <candidate-artifact>`。
  3. `npm run release:rehearse -- prepare --root=<練習用の場所>/rehearsal --baseline=034310b… --live-source=<本番の .next-live> --runtime=<今の束>`
  4. `release:rehearse -- start` (3200・3205 で起動し、`/api/health` が ok になるのを待つ)
  5. `release:rehearse -- run --direction=forward --artifact=<candidate-artifact> --candidate-runtime=<1. の束>` (入れ替え → 確認 → 確定)
  6. `release:rehearse -- run --direction=back` (前の世代の写しと今の束に戻す)
  7. `release:rehearse -- run --direction=fail --artifact=... --candidate-runtime=...` (確認の失敗を起こし、自動で戻ることを確かめる)
  8. `release:rehearse -- stop`。結果: `rehearsal-log.jsonl` と、練習用の `release-state` の記録 (`committed-*` 2 つ、`rolled-back-*` 1 つ)。
- 片付け: 練習用の場所 (候補の束とビルドを含め数 GB) は、P1 に同じ候補を使うため P1 の確認まで残す。消すのは承認の後。

### 6-2. (b) 本番に向けた、確かめるだけの動かし方 (11/27 (金) 12:00〜16:00)
- `npm run release:preflight-proof -- --check --release-root=/Users/yoshio/dev/stock-dashboard-release-7df6c23 --artifact=<候補のビルド> --runtime=<候補の束> --baseline=034310b…`
- 書くもの: なし。結果は画面に出すだけ。ファイルを書く処理は、すべて `--check` で戻った後 (`--write` のときだけ) にあり、その順番はテストで確かめている。
- 本番に対して行うこと: ファイルと記録の読み取り (release ディレクトリの git の状態、`.next-live`、束の記録、鮮度の見張りのログ、ロックが無いこと) と `ps` だけ。
  git は index を更新しない設定 (`GIT_OPTIONAL_LOCKS=0`)、`npm ls` (候補の束の中で動かす。本番の束ではない) は記録ファイルを書かない設定で動かす。
- Web・類似の検索への GET は `--check` では行わない。`/api/health` は、Storage Guard の確認の記録 (本番の App Support の中) を書くため
  (毎分の web-health と同じ動き)。P1 当日の `--write` では行う。前日に GET も試すなら `--check --with-http` を使い、別に承認を得る。
- 当日の P1 では、同じ道具を `--write --out=<新しいフォルダ>` で動かし、証明を作る。書く先は本番の場所 (release ディレクトリ・release-state・
  StockBoard の App Support・本番の DB のフォルダ・LaunchAgents) の外の新しいフォルダだけ (コードで止める)。
- 注意: 今 (11/11) の鮮度の見張りの記録では、米国の取り込みが `partial` (再取得が必要) で、この道具の確認は止まる。P1 の前日に同じなら、その理由を確かめて報告する。

### 6-3. 道具を作る中で見つかった、P1 を止める点 (2026-11-12、読み取りだけで確認)
- 本番の release ディレクトリでは、`node_modules` と `.node_modules-release-prev` が同じ束 (`c9fb796…`) を指している (10/29 の配置で束を変えなかったため)。
- この状態では、配置の仕組みの最初の確認が `release_runner_owned_rollback_runtime_matches_active_runtime` で止まる (読み取り専用で確かめた)。P1 の配置も、証明を作る道具も、ここで止まる。
- 直し方の案: P1 の前 (または当日の切り替えの前) に、オーナーが本番の release ディレクトリの `.node_modules-release-prev` (シンボリックリンク) を消す。
  - 指している先は今の束そのもので、別の戻し先ではない。消しても束は消えず、今の Web にも影響しない (link を 1 つ消すだけ)。
  - 消すと git の状態がきれいになり、確認は「前回の確定の記録の照合」を行わずに進む。戻し先は今の束 (`node_modules` の先) と `.next-live` になる。
- 本番のファイルの変更なので、オーナーの承認と実行が要る。練習 (a) では、同じ状態を作らないよう、候補の束が今の束と同じなら止める。

