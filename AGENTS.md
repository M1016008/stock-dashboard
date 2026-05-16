<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
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
