<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## データソース方針 (Phase 3.5 以降)

このプロジェクトは市場ごとに承認済みの一次ソースを固定する。

- **日本株の第一参照**: J-Quants API (Premium プラン契約)
- **米国株の第一参照**: Tiingo EOD。企業開示・SIC分類は SEC EDGAR / Companyfacts
- **承認済みの補完ソース** (2026-11-09 オーナー確認。各社の承認取得済み。用途は現行実装の範囲に限る)
  - Finnhub: 米国株の決算カレンダー (`lib/finnhub.ts`, `FINNHUB_API_KEY`)
  - Kabutan: テーマ・材料ニュース (`com.stockboard.kabutan-themes` / `kabutan-material-news`)
  - JPX 公式: 決算発表日・市場カレンダー等の公式資料
  - FMP: アダプタ (`lib/fmp.ts`)。新しい用途に使う場合は事前相談
- **上記以外の補完**: 各市場の一次ソースで取得できないデータに限り別ソースを使う。**ただし都度判断・相談**
  (勝手に Yahoo Finance 等にフォールバックしない)
- **Yahoo Finance は使用しない** (Phase 3.5 で完全廃止、lib/yahoo-finance.ts も削除済み)

## 認証

日本株は J-Quants v2 の **API キー方式** (`x-api-key` ヘッダ) を使う。

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

## 研究資産の封印 (2026-11-09 オーナー指示)

研究の公正性と株価データ品質を守るため、以下を封印・停止している。通常の機能開発、
データ表示、Production 修復は封印研究の再開とは別扱いで、ここに触れずに進める。

### 停止・封印中のもの

- **A. V6 の実株価 Outcome / Rank Sign 関連処理**: PIT、Corporate Action、Lineage の問題が
  解消するまで、生成・再計算・研究評価を無断で再開しない。
- **B. Validation / Holdout 期間**: Validation = 2023〜2024 年、Holdout = 2025 年以降。
  Discovery の結果を見て条件を変えること、結果を先読みすることは禁止
  (一次資料: `docs/phase-15d-evaluation-plan.json` の pre-2025 Validation /
  2025-01-06 以降の final test、`research/6stage/event-path-research/README.md` の
  Discovery cutoff 2022-12-30)。
- **C. 封印研究データと成果物**: 既存の研究 DB、Manifest、Receipt、Hash、検証成果物を変更・削除・
  上書きしない。保全確認済みの研究資産 15,890 行も含む (所在は未特定。特定できるまでは
  研究系の DB / Manifest / Receipt をすべて対象とみなす)。
  - 既知の所在: `/Volumes/OWC Express 1M2 80G/stockboard-research/six-stage/`
    (E039/E043 event-path store、`v5-max-r016` F1 feature store。
    `lib/research/six-stage-real-data-contract.ts` が hash を照合)、
    Phase 15D の封印モデル (`docs/phase-15f-operations.md`)。
  - 保護はファイル権限ではなく読み込み時の hash 照合に依存している。誤って書き込まないこと。

### 許可されているもの

- 封印資産を変更しない読み取り専用の参照 (既存の hash 照合付き研究 API など)。
- 封印と無関係な StockBoard の機能開発、データ表示、Production 修復。

### 封印解除に必要な条件 (すべて必要)

1. 株価ソースの PIT 整合性の確認。
2. Corporate Action が過去時点で正しく適用されていることの証明。
3. Ticker 変更・再利用、企業 ID、銘柄履歴などの Lineage の確認。
4. データの取得時点・公開時点・Revision / Vintage の確認。
5. 承認済み Source Contract と事前登録済み研究条件との整合性確認。
6. JP / US それぞれの品質 Gate を満たすこと。
7. 封印期間へのアクセス・評価について、オーナーの別途明示承認。

正確な研究契約、評価基準、時点条件は、過去の Manifest と事前登録記録を一次資料として照合する。
技術検証の PASS は封印解除の承認ではない。
