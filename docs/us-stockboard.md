# US StockBoard / Tiingo 運用メモ

米国株は日本株の `ohlcv_daily` / `daily_snapshots` に混ぜず、`market_*` テーブルで市場コード `US` を付けて保持します。これにより、既存の日本株機能を壊さずに、Tiingo EOD を原本とした米国株ワークスペースを並走できます。

## 環境変数

`.env.local` に以下を設定します。

```bash
TIINGO_API_KEY=...
```

US業種分類をSEC EDGARから補完する場合、SEC向けのUser-Agentを設定しておくと安定します。秘密情報ではありません。

```bash
SEC_USER_AGENT="StockBoard/1.0 contact@example.com"
```

必要に応じて外部SSD上のUS専用分析DBを指定できます。

```bash
US_ANALYTICS_DB_PATH=/Volumes/<SSD名>/stockboard/stockboard-us.db
```

## 初回同期

```bash
npm run batch:us-full
```

内訳:

- `batch:us-universe`: Tiingoの対応銘柄を `market_universe(market='US')` に保存
- `batch:us-classifications`: SEC SIC分類を `market_classifications` に保存し、USのSector/Industry表示へ反映
- `batch:us-ohlcv`: Tiingo EODを `market_ohlcv_daily(market='US')` に保存
- `batch:us-snapshots`: US用ステージ/MAを `market_daily_snapshots(market='US')` に生成
- `batch:us-analytics-db`: 既存MLパイプライン互換のUS専用SQLiteを生成

上場廃止銘柄を含む取得可能な全期間バックフィルは以下を使います。

```bash
npm run batch:us-backfill-all
```

`batch:us-backfill-all` は `US_INCLUDE_INACTIVE=1` と `US_HISTORY_FROM=1900-01-01` を指定し、Tiingoの対応銘柄リストで日付レンジがある米国市場銘柄を対象にします。途中で止まっても、`market_ohlcv_daily` の各銘柄最終取得日から再開します。既に直近だけ取得済みの銘柄がある場合も、最初の取得日より前の期間を埋めます。ステージは `US_SNAPSHOT_REBUILD=1` で再構築します。

## US MLフル学習

```bash
npm run batch:us-ml-full
```

このコマンドはUS専用SQLiteを作ったうえで、既存の `batch:ml-full` を `STOCKBOARD_DB_PATH` でUS DBへ向けます。日本株DBとは分離されるため、JP版の学習データや画面表示には影響しません。

## 日次自動更新

米国株も日本株と同じく、ローカルMacの `launchd` で差分取得と日次ML更新を自動実行できます。

```bash
npm run auto-update-us:install
```

登録されるジョブは `npm run batch:us-update-latest` を実行します。処理順は以下です。

1. TiingoのUS銘柄ユニバース更新
2. Tiingo EOD差分取得
3. `market_daily_snapshots` のUSステージ/MA更新
4. US専用分析DB (`US_ANALYTICS_DB_PATH` または `data/stockboard-us.db`) への差分反映
5. US専用DBを使った `batch:ml-daily`

初回フルバックフィルや全期間MLなどの重い処理が動いている場合、日次更新は自動でスキップします。データが既に最新候補日まで入っている場合もTiingo取得はスキップし、必要な後続処理だけを確認します。

推奨スケジュールはJST `09:30 / 12:30 / 15:30` の3回です。米国市場のEOD反映タイミングに揺れがあるため、朝の初回取得に失敗しても昼・午後で取りこぼしを拾います。ログは `~/Library/Logs/StockBoard/us-update-latest.log` と `~/Library/Logs/StockBoard/us-update-latest.err` に出ます。

手動実行:

```bash
npm run batch:us-update-latest
```

日次MLだけを止めたい場合:

```bash
US_SKIP_DAILY_ML=1 npm run batch:us-update-latest
```

## 画面

- `/us`: USデータ状態
- `/us/screener`: USスクリーナー
- `/us/stock/AAPL`: US個別銘柄ページ

US向けの決算、貸借/信用、J-Quants固有の業種分類は現時点では対象外です。米国株の追加データソースを使う場合は、別途方針確認してから導入します。

## US業種分類

Tiingoの標準メタデータにはSector/Industryが含まれないため、初期分類はSEC EDGARのSICを使います。分類は `market_universe` に直接固定せず、差し替え可能な `market_classifications` に保存します。

- 初期taxonomy: `US_SEC_SIC`
- 大分類: SICレンジから作るStockBoard用Sector
- 小分類: SECの `sicDescription`
- 未取得銘柄: `Unknown` 扱い。MLや画面を止めない
- 将来: GICS/ICB/有料分類へ切替可能

分類だけ再取得する場合:

```bash
npm run batch:us-classifications
```

全件再取得する場合:

```bash
US_CLASSIFICATION_REFRESH=1 US_INCLUDE_INACTIVE=1 npm run batch:us-classifications
```
