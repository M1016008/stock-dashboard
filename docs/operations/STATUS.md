# StockBoard STATUS

運用上の未完了事項と、後で必ず戻る必要がある項目を記録する。秘密情報は書かない。
更新したら日付を付ける。

## 未完了の作業項目

### P1 (main と Production Runtime の統一)
- **large-holder-update の PATH 回避策を撤去する** (記録日: 2026-11-09)
  - EDINET 正規化では、large-holder-update を release ツリー (`034310b`) に付け替える。
    release ツリーには `4cc1e8f` (子プロセスを `process.execPath --import tsx` で起動する修正) が無いため、
    plist の `EnvironmentVariables` に `PATH=/usr/local/bin:...` を設定し、`#!/usr/bin/env node` が
    `/usr/local/bin/node` を見つけられるようにする暫定対応を行う。
  - `4cc1e8f` は PR #77 で main に取り込む。P1 で release ツリーが新しい main に揃ったら、この PATH 設定は不要。
    P1 の Deploy 後に plist から外し、large-holder の更新が成功することを確認する。
- **update-latest も J-Quants 専用の env ファイルを読むように揃える** (記録日: 2026-11-09)
  - 現在、J-Quants キーは `config/runtime.env` と `config/jquants.env` の2か所にある
    (earnings-refresh が `jquants.env` を使うため)。PR #75 のインストーラは、インストールのたびに
    `runtime.env` から `jquants.env` へ同期する。

### Backup 初回取得 (11/15) の後に検討する (今は着手しない)
- **sqlite3_rsync のスナップショット一貫性を確認し、検出処理の単純化を検討する** (記録日: 2026-11-09)
  - sqlite3_rsync が、コピー元が使用中でも一貫したスナップショットを写すかを、SQLite の公式ドキュメントで確認する。
  - 正しければ、PR #76 の Writer 停止中の書込み検出処理 (両市場の状態の記録と比較、コピー中の毎秒の監視) を
    単純化できないか検討する。
- **Writer を止めずに Backup を取る方式を検討する** (記録日: 2026-11-09)
  - Writer Hold は、Writer を処理の途中で止めるリスクそのものを生んでいる。
  - sqlite3_rsync が使用中の DB でも一貫したスナップショットを写すなら、Writer を止めずに Backup を取る方式を検討する。
  - その場合の論点は、JP と US の時点のずれをどこまで許容するか。
- **上の2項目の単純化では、PR #76 の行数を減らすことも目標にする** (記録日: 2026-11-09)
  - 2026-11-09 時点で PR #76 は origin/main に対して追加約 830 行 (本体 470・テスト 159・文書 199)。

### 調査項目 (今は着手しない)
- **10/27 (火) に batch-earnings の記録が無い理由** (記録日: 2026-11-10)
  - 10/27 の update-latest は 10/28 04:56 に実行され success だが、その実行では batch-earnings (earnings_calendar) の
    batch_runs 行が無い。optional 処理を飛ばす条件 (`UPDATE_LATEST_CRITICAL_ONLY` や時間帯の判定) が関係したかを確認する。

### 別の作業として検討する (11/15 の後)
- **J-Quants `/fins/earnings-date` で JPX 公式 Excel を置き換える** (記録日: 2026-11-10)
  - 現在の `/equities/earnings-calendar` は、翌営業日に発表する 3月期・9月期決算の会社だけを返す (J-Quants 公式仕様)。
    全上場会社分は JPX 公式 Excel (J-Quants 以外のデータ源) で補っている。
  - `/fins/earnings-date` は、決算期によらず全上場銘柄 (REIT 等を含む) の予定日と、変更・未定の履歴を返す。
  - 最初に、契約中の J-Quants プランでこのアプリからこの API を呼べるか (参照可能期間を含む) を確認する。
    その後、件数と JPX 公式 Excel との差を比べてから置き換えを判断する。

### オーナーの判断待ち
- `~/.codex/config.toml` の既定値 (`sandbox_mode = "danger-full-access"`、`approval_policy = "never"`) の見直し。
  Claude Code のレビュー実行は毎回 read-only で上書きしている (CLAUDE.md の Codex 独立レビュー節を参照)。

## 補完ソースの状態 (方針と用途は AGENTS.md。ここには日々変わる状態だけを書く)
状態は確認日時点のもの。変わったら日付を付けて更新する。

| 取得元 | キーの設定状況 (契約の有無は未記録) | Production での動作 | 確認日 |
| --- | --- | --- | --- |
| Finnhub | `FINNHUB_API_KEY` は、確認した Production 用 env ファイル (`config/runtime.env`・`production.env`・`jquants.env`) には未設定 | 停止中。キー未設定のため US 決算取得は無効 | 2026-11-09 |
| Kabutan | キー不要 | 稼働中 (`kabutan-themes` / `kabutan-material-news`、exit 0、鮮度 OK) | 2026-11-09 |
| JPX | キー不要 | (1) 決算発表予定: 平日 21:10 の update-latest 内の batch-earnings で取得 (10/23〜11/9 の確認範囲で、10/27 を除き batch_runs に成功の記録あり)。earnings-refresh 単独の実行 (07:10・14:10・16:30) は 10/23〜11/9 に失敗していたが、2026-11-09 23:56 の env 適用後の実行で成功 (下の「記録の訂正」参照)。(2)(3) 定期実行なし (手動の監査スクリプトのみ。実行は都度オーナーの判断) | 2026-11-10 |
| FMP | `FMP_API_KEY` は未設定。表示用のゲート `FMP_DISPLAY_LICENSE_APPROVED` も未設定 | 未使用 (Production から呼ぶ処理なし)。有効化には、キーの設置、表示ゲートの設定、Production 構成の変更について個別の承認が必要 | 2026-11-09 |

## 記録の訂正
- **決算カレンダーの停止は誤り。止まっていたのは earnings-refresh 単独の実行だけ** (記録日: 2026-11-10)
  - 訂正前の記述 (2026-11-09 の最初の監査): 「earnings-refresh は 10/23 から止まっており、決算カレンダーが16日古い」。
  - 実際 (batch_runs の読み取りで確認):
    - earnings-refresh 単独の実行 (07:10・14:10・16:30) は、10/23 13:48 から 11/9 16:40 まで毎回失敗していた
      (`JQUANTS_API_KEY が未設定`)。2026-11-09 23:56 の env 適用後の実行で成功した。
    - 一方、平日 21:10 の update-latest が内部で呼ぶ batch-earnings は、runtime.env のキーで動き、
      10/23・10/26・10/28〜10/30・11/2〜11/6・11/9 に成功していた (J-Quants と JPX の両方を取得)。
    - 例外: 10/27 (火) は batch-earnings の成功記録が無い。10/27 の update-latest は 10/28 04:56 に実行されたが、
      その実行では batch-earnings が記録されていない。理由は未調査。
  - 確認できた実行状況: batch_runs の記録では、10/23〜11/9 の平日のうち 10/27 を除く日に、夜間の update-latest 内で
    batch-earnings が成功している。日中 3 回の earnings-refresh 単独の実行は、この期間すべて失敗している。
    実データの鮮度や画面への影響の範囲は確認していない (batch_runs の記録だけでは判断できない)。

## 所在の記録 (削除しない)
- 名前の誤った env ファイル `.env.loca` (2026-05-23 作成、秘密情報を含む):
  `/Volumes/OWC Express 1M2 80G/StockBoard Development/git-worktrees/claude/gracious-grothendieck-804715/.env.loca`
  - 2026-11-09 に権限を 600 に変更済み。削除はオーナーの判断まで行わない。
- 研究資産「15,890 行」: 所在未特定 (AGENTS.md の封印節を参照)。
