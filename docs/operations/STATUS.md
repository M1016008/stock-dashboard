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

### オーナーの判断待ち
- `~/.codex/config.toml` の既定値 (`sandbox_mode = "danger-full-access"`、`approval_policy = "never"`) の見直し。
  Claude Code のレビュー実行は毎回 read-only で上書きしている (CLAUDE.md の Codex 独立レビュー節を参照)。

## 所在の記録 (削除しない)
- 名前の誤った env ファイル `.env.loca` (2026-05-23 作成、秘密情報を含む):
  `/Volumes/OWC Express 1M2 80G/StockBoard Development/git-worktrees/claude/gracious-grothendieck-804715/.env.loca`
  - 2026-11-09 に権限を 600 に変更済み。削除はオーナーの判断まで行わない。
- 研究資産「15,890 行」: 所在未特定 (AGENTS.md の封印節を参照)。
