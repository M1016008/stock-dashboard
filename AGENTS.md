<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## データソース方針 (Phase 3.5 以降)

このプロジェクトは市場ごとに承認済みの一次ソースを固定する。

- **日本株の第一参照**: J-Quants API (Premium プラン契約)
- **米国株の第一参照**: Tiingo EOD。企業開示・SIC分類は SEC EDGAR / Companyfacts
- **補完ソース: 下表の 4 取得元はオーナー申告により各社から承認取得済み (2026-11-09。証拠の所在は未記載)**。
  契約書やメール等の証拠の所在は、オーナーから提示された時点で追記する。
  - 承認範囲: 外部閲覧 (friend-readonly-gateway) について、極少人数 (上司 1 名) への表示を各社から承認済み。
  - 承認範囲外: それ以外の公開・再配信。新しい有料契約、追加課金とあわせて、オーナーの明示承認が必要。
  - キー・契約の有無や Production での稼働状況は日々変わるため、ここには書かず `docs/operations/STATUS.md` に記録する。

  | 取得元 | 用途と Endpoint の範囲 (現行実装) |
  | --- | --- |
  | Finnhub | 米国株の決算カレンダー。`/api/v1/calendar/earnings` のみ (`lib/finnhub.ts`) |
  | Kabutan | テーマ: アクセスランキング `/info/accessranking/3_2` から各テーマ `/themes/...` を取得 (`scripts/batch-kabutan-themes.ts`)。材料ニュース: `/news/marketnews/?category=...` と記事 `/news/marketnews/?b=...` を取得 (`scripts/batch-kabutan-material-news.ts`)。銘柄ページ (`/stock/?code=...`) はリンクとして解析・表示するだけで取得しない |
  | JPX | JPX 公式サイトからの直接取得 (J-Quants 経由とは別): (1) 決算発表予定 `/listing/event-schedules/financial-announcement/` (`lib/jpx-earnings.ts`)、(2) 上場銘柄一覧 `/markets/statistics-equities/misc/.../data_j.xlsx` (`scripts/audit-large-holder-instruments.ts`)、(3) `scripts/audit-large-holder-regulatory-current.ts --phase-16a8` 実行時のみ、REIT 銘柄一覧ページ `/equities/products/reits/issues/`、優先株 PDF `/equities/products/preferred-stocks/issues/...pdf`、`www2.jpx.co.jp/disc/...pdf` を規制範囲の証拠として取得。それ以外の ETF/ETN 銘柄一覧ページなどは出典リンクとして表示するだけで取得しない |
  | FMP | 次回決算日 (`earnings-calendar`) と Sector/Industry (`profile`) のアダプタ (`lib/fmp.ts`、`/stable`)。表示はゲート `FMP_DISPLAY_LICENSE_APPROVED` で制御する |

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

## 研究資産の封印 (2026-11-09 オーナー指示、2026-11-10 改定)

研究の公正性と株価データ品質を守るため、以下を封印・停止している。通常の機能開発、
データ表示、Production 修復は封印研究の再開とは別扱いで、ここに触れずに進める。

**経緯 (2026-11-10)**: 旧「A. V6 の実株価 Outcome / Rank Sign 関連処理」は、V6 の実体 (コード・成果物・文書) が
見つからず、オーナーにも記憶がないため、オーナーの判断で廃止し、下の「実株価の過去の結果を使う研究・表示」に置き換えた。

### 実株価の過去の結果を使う研究・表示 (2026-11-10 オーナー指示)

1. 研究データのうち、Discovery 期間 (2022-12-30 まで) の過去の値動きは、読む・集計する・画面に表示することができる。
2. 使うのは、データ品質を確認できた市場・銘柄だけとする。
   - 日本株は、分割・併合の補正の確認を終えてから使う。
   - 米国株は、分割の係数の問題を直すまで使わない。
   - 品質に疑いのある銘柄・イベントは除外する。
3. 画面には「配当を含まない株価の値動き」「過去の参考値であり予測ではない」と必ず明記する。
4. データを見ながら行う分析 (X→Y→X 型の集計など) は「探索」と明記する。
   探索で見つけた仮説を検証する場合は、検証の条件を事前に固定する。
5. Rank Sign は定義が不明なため、作らないことを既定とする。必要になれば改めて定義し、オーナーが判断する。

### 封印中のもの

- **B. Validation / Holdout 期間**: Validation = 2023〜2024 年、Holdout = 2025 年以降。封印を継続し、
  開封にはオーナーの明示承認が必要。Discovery の結果を見て条件を変えること、結果を先読みすることは禁止
  (一次資料: `docs/phase-15d-evaluation-plan.json` の pre-2025 Validation /
  2025-01-06 以降の final test、`research/6stage/event-path-research/README.md` の
  Discovery cutoff 2022-12-30)。
- **C. 事前登録済み研究条件と、その照合に使う資産**: 研究 Contract が参照する研究 DB、Manifest、
  Receipt、Hash を、無断で変更・上書きしない。
  - Contract が参照している既知の資産: `/Volumes/OWC Express 1M2 80G/stockboard-research/six-stage/`
    の E039/E043 event-path store と `v5-max-r016` F1 feature store
    (`lib/research/six-stage-real-data-contract.ts` が hash を照合)、
    Phase 15D の封印モデル (`docs/phase-15f-operations.md`)。
  - 読み込み時の検査は、Manifest に記録された hash 値と期待値の一致、event store のファイルサイズ、
    F1 Manifest ファイルの hash だけ。SQLite 本体の hash は検査しておらず、ファイル権限による保護もない。
    同じサイズのまま中身が変わっても検出できないので、誤って書き込まないこと。
  - **未確認事項**: 「保全確認済みの研究資産 15,890 行」は、2026-11-09 時点で所在と実体を特定できていない。
    推測で場所を記載しない。

### 封印は永久保存ではない

研究処理の封印継続と、研究データの保存・削除は別の判断として扱う。不要な研究データ、失敗した
実験結果、重複 Artifact、再生成可能な中間ファイルは、整理・削除の対象になる。
削除の前に、研究 Contract、Manifest、Receipt、DB の参照関係を確認する。再現できない唯一の
重要資産を削除する場合は、対象を限定してオーナーの承認を得る。

### 許可されているもの

- 封印資産を変更しない読み取り専用の参照 (既存の hash 照合付き研究 API など)。
- 封印と無関係な StockBoard の機能開発、データ表示、Production 修復。
- 上記の手順に沿った、不要な研究データの削除可能性の評価。

### 封印 B の解除に必要な条件 (すべて必要)

1. 株価ソースの PIT 整合性の確認。
2. Corporate Action が過去時点で正しく適用されていることの証明。
3. Ticker 変更・再利用、企業 ID、銘柄履歴などの Lineage の確認。
4. データの取得時点・公開時点・Revision / Vintage の確認。
5. 承認済み Source Contract と事前登録済み研究条件との整合性確認。
6. JP / US それぞれの品質 Gate を満たすこと。
7. 封印期間へのアクセス・評価について、オーナーの別途明示承認。

正確な研究契約、評価基準、時点条件は、過去の Manifest と事前登録記録を一次資料として照合する。
技術検証の PASS は封印解除の承認ではない。
