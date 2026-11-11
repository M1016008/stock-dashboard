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
| 予行 | 本番と同じ形の練習用ディレクトリで、切り替えと戻しを 1 回ずつ通す | Claude Code |
| 配置の証明を作る道具 | **未決。** 配置の仕組みは証明 (有効 15 分、14 項目の照合) を求めるが、それを作る道具と束を作る道具は main にも本番のソースにも無い (10/29 は手作業で作った)。案と行数を別に示して承認を得る | Claude Code |
| 前の成果物の写し | 今の `.next-live` (と `SMA_RELEASE_MANIFEST.json`) の写しを release ディレクトリの外に作る。確定後に戻すときの候補にする | Claude Code |

### 1-1. Backup の写しで main の表を作る処理を試す
- 11/15 の Backup の写し (読み取り専用) から、本番以外の場所に作業用の複製を作る (`cp -c`)。写しそのものには書かない。
- 複製に向けて main の `npm run db:ensure-schema` (`lib/db/migrate.ts`) を 1 回動かし、前後の `sqlite_master` を比べる。
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
| 07:50 | 06:30 の us-update-latest が終わり、定期処理が 1 本も動いていないことを `pgrep` で確かめる | Claude Code |
| 07:55 | 15 本を `launchctl bootout`。`launchctl print` で止まったことを確かめる | オーナー |
| 08:00 | Web・類似の検索・friend-readonly-gateway も止め (Web も表示用のキャッシュを DB に書くため)、DB の控えを取り (下の 4.)、3 本を戻して `/api/health` が ok になるのを待つ。止まるのは数分 | 停止・再開はオーナー、控えは Claude Code (承認後) |
| 08:15 | 配置の証明を作り (有効 15 分)、Web と類似の検索を切り替える。`STOCKBOARD_RELEASE_BASELINE_COMMIT=034310b…` | オーナー (実行) |
| 08:30 | **終了コードが 0 で、出力が `"status":"SUCCESS"` のときだけ次へ進む。** `PRECHECK_FAILED`・`ROLLED_BACK_UNHEALTHY` なら、release ディレクトリは `034310b` のまま、3-3 の順で戻して終える。`HOLD` なら定期処理も止めたまま手を止めて相談する (3-4) | オーナー・Claude Code |
| 08:35 | Web・類似の検索の `/api/health` が ok、主な画面が開くことを確かめる | Claude Code |
| 08:40 | release ディレクトリを main の commit に合わせる (`git checkout --detach <main の commit>`)。`git status` が `?? .node_modules-release-prev` だけであることを確かめる | オーナー |
| 08:50 | release ディレクトリで型検査 (`tsc --noEmit`) だけを行う。定期処理の入口は実行しない (`--help` を受け付けずに本処理が動く入口があるため) | Claude Code |
| 09:30 | 下の 3-3 の順で戻す。weekly-optimization は戻さない (11/29 の日曜を飛ばす。STATUS の日程どおり。12/6 の Backup の後に戻す) | オーナー |
| 後日 | large-holder-update の plist から PATH の回避策を外し、更新の成功を確かめる (STATUS の項目) | オーナー |

### 3-3. 定期処理を戻す順
- 戻すとすぐ動く (RunAtLoad) ものが 9 本ある。書き込みが重ならないよう、次の順に 1 本ずつ戻し、動いたものは終わるのを待つ。
  1. すぐには動かないもの: update-latest、us-update-latest、db-maintenance、ml-freshness-guard、ml-learning
  2. 読むだけのもの: web-health、data-freshness-guard
  3. すぐ動いて書くもの: classification-sync (main で初めて動き、比較会社の表を作り、記録ファイルの版 5 への切り替えで 1 回取り込み直す)、
     earnings-refresh、large-holder-update、kabutan-themes、kabutan-material-news、trigger-historical-scan、trigger-ml-frozen-monitor
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
- 戻し: 定期処理と Web を止めて、複製を元の名前に戻す (オーナーの承認の後)。
- 注意: 同じディスクの上の控えなので、ディスクの故障には備えられない。故障への備えは 11/15・12/6 の正式な Backup。
- **片付けの期限: 遅くとも 12/3 (米国株の作り直しの前)。** 作り直しで米国株の DB がほぼ全部書き換わり、複製が OWC を約 514 GB
  使うため。片付けはオーナーの承認の後に行う。

## 5. P1 の後に最初に Web を配置するとき
- release ディレクトリは main、今の実行環境の束には `034310b` の印が残る。
  `STOCKBOARD_RELEASE_BASELINE_COMMIT=<main の commit>` に加えて `STOCKBOARD_RELEASE_PRIOR_BASELINE_COMMIT=034310b…` を渡す (PR #115)。
