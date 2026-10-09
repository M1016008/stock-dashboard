<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## データソース方針 (Phase 3.5 以降)

このプロジェクトは**すべての株式データを J-Quants API から取得する**。

- **第一参照**: J-Quants API (Premium プラン契約)
- **補完**: J-Quants で取得できないデータに限り別ソースを使う。**ただし都度判断・相談**
  (勝手に Yahoo Finance 等にフォールバックしない)
- **Yahoo Finance は使用しない** (Phase 3.5 で完全廃止、lib/yahoo-finance.ts も削除済み)

## 認証

J-Quants v2 の **API キー方式** (`x-api-key` ヘッダ) を使う。

- 環境変数: `JQUANTS_API_KEY` のみ
- API キーは**有効期限なし** (再発行・削除はダッシュボードで可能)
- v1 のリフレッシュトークン / メアド+パスワード認証は **v2 アカウントでは使えない** ので実装しない

## DB 構成

- **ローカル SQLite (`./data/stockboard.db`)**: Phase 2 以降の大規模データ
  (ohlcv_daily, daily_snapshots, feature_snapshots, forward_returns,
  pattern_stats, stage_transitions, ticker_universe, batch_runs)
- **Turso クラウド**: 既存テーブル (tv_daily_snapshots, sector_master 等) のみ。
  Phase 3 以降の重いデータは Turso クォータ超過のためローカル運用。

バッチスクリプトは `USE_LOCAL_DB=1` でローカル DB を強制する (詳細は `lib/db/client.ts`)。

## 開発完了・統合確認・Worktree整理

CodexとClaude Codeは `docs/development-completion-workflow.md` を共通の正本として使う。

- Node 22.x / npm 10.9.9を使う。完了報告前に `npm run workflow:verify -- --select-tests` を実行する。このCLIは
  diff check、TypeScript、既存違反baselineに対する新規ESLint違反、必須・変更領域別回帰テスト、production buildを実行し、署名付き検証証跡をGit共通dirへ記録する。
- Claude Codeで開発完了を報告する最終応答には`[stockboard-development-complete]`を含める。通常応答の`Stop`はブロックせず、このmarker付き完了報告と`TaskCompleted`だけを検証証跡でgateする。
- PR、CI、main統合は `npm run workflow:integration` で確認する。このコマンドはfetchしない。
- Worktree判定はデフォルトdry-runの `npm run worktree:audit` を使う。
- mainへのmerge、push、本番deploy、Worktree削除は利用者の明示承認なしに実行しない。
- Worktree削除はmacOS厳格監査とGitHub統合証明後に、利用者が信頼済みterminalで`worktree:approve`を実行して期限付き・一回限り承認を発行し、別の対話的`worktree:remove`でのみ行う。agentは承認発行・削除を代行しない。
- local terminal確認は本人認証ではない。同一OS user権限を持つ攻撃者からは保護できないため、非対話の自動削除は禁止する。
- `rm -rf`、`git clean`、強制Worktree削除、暗黙のbranch削除、暗黙のpruneは禁止する。
- `.env*`、credential、OAuth token、DB、outbox、既存stashをGitへ追加せず、値をログへ出さない。
- 稼働プロセス、LaunchAgent、外部symlink、Git外資産、未統合commit、未commit変更が1つでもあれば削除しない。
