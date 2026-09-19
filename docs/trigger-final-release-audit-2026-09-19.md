# Trigger Discovery Final Release Audit (2026-09-19 JST)

## 判定

**日常利用への移行: YES / Final Audit: PASS (P0=0, P1=0)。**
月足・2週足の検索、単日時点・期間検証、Outcome、保存条件、評価・Lifecycle、および通知の送信前段までを横断確認した。Gmail実送信は行っていない。以下のP2/P3と測定上の限界を残す。新機能は追加していない。

| 領域 | 判定 | 根拠 |
| --- | --- | --- |
| Current / Historical Monthly・Biweekly | PASS | Golden 5条件、休日解決、PIT、実ブラウザ検索 |
| MA / Trigger / Spread OFF互換 | PASS | Engine・Read Model回帰、OFF/ON候補集合hash |
| Universe・流動性・Stage・Score | PASS | 検索/DB/mini chartの5銘柄照合、Stage独立JOIN |
| Sort・Filter・Pagination・Mini Chart | PASS | 実画面操作、API回帰、右端OHLCV/MA照合 |
| Period Scan・Event・dailyCounts | PASS | 月足/2週足Job、日付/NEAR/Zoneフィルタ、baseline除外 |
| Job recovery / cancel / singleton | PASS | fresh heartbeat orphan、graceful restart、SIGKILL、RUNNING+QUEUED、cancel restart |
| Outcome・censoring | PASS | 実Event30件、eligible98 horizon、censored22の原データ再計算 |
| Segmentation・Episode・Robustness | PASS | 実データ49セル、648 episodes、52 anchor spot checks、各回帰 |
| Saved Trigger・Evaluation・Lifecycle | PASS | 保存/読込/同日再利用/重複防止、各イベント・通知構成の回帰 |
| Production browser 390–1920 / smoke | PASS | E2E月足・2週足、横overflowなし、smoke 142/142 |
| DB・Gmail side effects | PASS | scoped integrity/FK、QA行のみ撤去、outbox/attempts不変、送信0 |

## 発見して修正したP1

**月足の疎な日次取引履歴を持つ銘柄でPeriod ScanとSingle-day Searchが不一致。** 2025-02-28、03-03、03-04にそれぞれ3件の候補差。ETF等の取引のない日が多い銘柄（2523、1479、2560）では、暦日ベースの履歴開始点だけで切るとMAの必要観測本数に足りず、期間検証から候補が落ちていた。`ohlcv_daily`から対象tickerの実観測を必要本数まで限定的に遡り、計算後の表示/評価日をPIT基準日に戻した。Stage/MA/Trigger定義そのものは変更なし。月足20営業日 (2025-02-03〜03-04) の候補集合と価格・MA・Score・Stage・流動性は全日Single-dayと一致。修正前は17/20日のみ一致。疎履歴の3日は修正後309/301/320件。

旧定義で計算された保存済みHistorical/Outcome artifactは最新結果として再利用・表示しないよう、request signatureに`monthlySparseHistoryVersion: 2`を含めた。旧ユーザーJob・ファイルは物理削除せず保持。旧Job statusはHTTP 200で`resultAvailable=false`、result/segmentation/robustnessはHTTP 410。正しい結果を見るには同条件で再実行する。将来データで旧結果を補完しない。

## GoldenとPIT照合

Golden hashはticker、status、score、price、MA期間・距離、zone distance、流動性、6軸Stage、spread diagnosticsの正規化比較。Search DTOに生MA値は含まれないため、生MA1/MA2は別途Mini Chart/API/DBで照合した。月足/2週足、20/25のSpread OFF/ON、月足20/50について変更前後の候補集合と主要値が一致した。

| 条件 (2026-09-07) | 候補 | SHA-256 |
| --- | ---: | --- |
| 月足20/25 Spread OFF | 174 | `714d806d758ba6fb31c6b22548c2aea32dafc8dc6991af88c08d63b3e8d6a662` |
| 月足20/25 Spread ON | 1 | `a46253eb6635ae5f53f03f21f37aa25580d6f317902df912c860444fac98a85a` |
| 月足20/50 Spread OFF | 171 | `01bf77a77b34278c5535c659564ffa20bfbd0b56a2157ea4d5c9d2b4268070bc` |
| 2週足20/25 Spread OFF | 238 | `863c08883867d79cd6e8162c019fdb91b954831fd9216fdf6d1c0800fe72521b` |
| 2週足20/25 Spread ON | 89 | `7afb39a6b19f3a9f2facd361296d9af84ca914bf04c742e5de4b13415d104be6` |

Spread OFFの旧条件との候補・スコア互換もEngine/保存条件回帰で確認。月足20日と2週足20日について、Period Scan対同日Single-dayを実データで照合。2週足 (2026-08-03〜08-31) は20日、4,623候補、実質差分0。4,000弱のフィールドで10^-13桁程度のMA浮動小数点差があり、相対許容誤差1e-9で比較した。件数、ticker、Status、Score、Stageは一致。休日2025-08-24は評価日2025-08-22へ解決。画面のPIT時点、mini chart右端、daily_snapshots Stageを照合し、未来足・未来Stage混入なし。

2026-09-07月足の1301/1633/2031/2206/2256をUI→Search/Mini Chart API→`ohlcv_daily`・`monthly_ma_monitor_daily`・`daily_snapshots`で照合した。price、MA1/MA2、6軸Stageは元値一致（表示丸めを除く）。Score内訳合計はtotalと一致。市場・価格・平均出来高・平均売買代金、MA上向き/上から接近/距離・Spreadの各条件、Sort→Filter→Pagination、Saved Triggerの旧config Spread missing→OFFは関連回帰で確認。

## Scan / Outcome / Episode

- QA用月足4日Job: 2025-02-27〜03-04、unique405、ENTERED137、RE_ENTRY22、STATUS_CHANGED214、EXITED107、NEAR入り109、最大候補320、平均299.5。2週足4日Job: unique178、ENTERED30、RE_ENTRY6、STATUS_CHANGED155、EXITED53、Zone入り73、最大148、平均140.5。初日の既存候補はbaselineでありNEW Eventではない。
- 30 Eventのanchor priceと20/60/120/245日終値を`ohlcv_daily`から独立再計算。98 eligible outcome、22 censored。return/MFE/MAE一致、Event当日のHigh/Lowはextremaへ含めず、未来不足は0%ではなくN/A。株式分割等の既存調整contractは維持。
- 実保存データ: 1006 Event observations、648 episodes、571 ticker。52 anchor spot checksで最初の対象Eventを採用し、最大Score Eventへの取り替えなし。mapping missing/ambiguous/sequence anomalyはすべて0。Score/Stage/Spreadの各group合計はoverall events/eligibleに一致。WeekA×MonthAは49セル、UNKNOWNと小母数表示を確認。EpisodeとEvent、左右censoringの回帰もPASS。
- QA月足/2週足のOutcomeを同期間/同selector/同horizon/同cutoffで比較API・ブラウザから照合。比較はOPERATIONAL_SCAN_COMPARISONと明示され、timeframe/MA期間差を表示。3か月後の月足NEAR入り109 Event/eligible100、2週足58 Event/eligible55、中央値+1.26%/-0.26%。因果比較や投資推奨ではない。
- Saved Triggerは既存ユーザー定義の読込を確認。QA定義でSave→Load→Search、一日再実行のCompleted result再利用、members/events重複なしを回帰。LifecycleのNEW/RE_ENTRY/STATUS_CHANGED/REBOUNDED/BROKE_BELOW_ZONE/exit系、Spreadによる離脱、Digest/Alertの時間軸・MA・Spread・link・ラベルをfixtureで確認。送信機能は実行していない。

## Browser E2E / responsive

production `:3000`で月足20/25 Spread OFF→ON→休日As-of→4日期間検証→NEAR入り→候補数chartの日付選択/解除→3か月Outcome→Score帯→WeekA×MonthA→Spread→Observation/episode→月足vs2週足比較まで操作。2週足も検索OFF/ON→期間検証→Zone入り→Outcome・比較を操作。月足最新OFF/ONは232/29、2週足259/88件 (2026-09-18)。現場でのJS例外・失敗APIなし。完成Jobの無限poll/重複request stormは観測なし。

390/768/1024/1280/1440/1920pxでdocument横overflowなし。390pxでは表/Matrixが内部scroll、1920pxのmain幅1680px、390pxでは358px。mini chart50行にSVG100要素、6 Stage/Score/市場/平均出来高維持。Meiryo UI fallback維持。保存画像: `/tmp/trigger-final-results-390.png`, `/tmp/trigger-final-results-1920.png`, `/tmp/trigger-final-period-390.png`, `/tmp/trigger-final-period-1280.png`。keyboard focus、tab、chart以外の日付入力/解除は動作確認。全matrixセルのスクリーンリーダー実機評価は未実施。

## 性能 (実測、キャッシュ/DB状態に依存)

| 処理 | cold | warm |
| --- | ---: | ---: |
| 2026-09-07月足20/25 OFF Search | 5.43s (DB 5.36s、5 queries) | 15ms未満 |
| 月足20/25 ON | 約1.5s | 15ms未満 |
| 月足20/50 generic | 約13s | 15ms未満 |
| 2週足20/25 OFF / ON | 約10.2s / 7.2s | 15ms未満 |
| 2025年4営業日scan 月足 / 2週足 | 16s / 13s (async) | 保存済み結果参照 |
| 3か月 / 1年 direct period scan | 64日 約19.67s / 243日 約43.53s | async |
| Outcome score/stage/matrix/spread/robustness/comparison | 165/37/28/37/115/72ms | 26/27/19/17/92/20ms |

1年の比較API outlierの再計測は、同一条件の有効な1年Outcome対を保持していないため未実施。過去に報告された外れ値が再現しないと断定しない。DB/FS cacheと同時負荷の差が大きいため、この測定を固定SLAとは扱わない。

## Production / storage / 副作用

- 適用Build ID: `CjJDvob32W-YxHVjI_8Y5`。`127.0.0.1:3000` listener PID 30022、Historical Worker PID 29975 (1 process)。production buildと型検査PASS、正式`npm run web:deploy`成功、smoke 142/142。web/worker processの再起動後に実HTTP/ブラウザで再確認。
- Worker recoveryのfresh heartbeat orphan、graceful restart、SIGKILL fixture、A RUNNING/B QUEUED、cancel restart PASS。終了時RUNNING=0/CANCEL_REQUESTED=0、orphan=0。TTL 7日、manifest/NDJSON、partial `.tmp`の扱いを確認。旧ユーザーJobの行/artifactは保持。
- `PRAGMA integrity_check('historical_trigger_scan_jobs')`およびoutcome対象、対象テーブルの`foreign_key_check`はPASS。509GiBのDB全体のfull integrity scanは安全のため未実施。DB schema/migration変更なし。`db:ensure-schema`は既存deploy処理で実施。
- QA専用Historical Job 2件、Outcome Job 2件と対応artifact 10ファイルのみ削除。元からあったHistorical `6e833147-5f87-4b8b-b98c-a57391cd9f04`、Outcome `4ea44a97-12b4-4253-a96d-4d3d9bf15497`、Saved Triggerは保持。終了時、Historical/Outcome各COMPLETED1件。通知outbox 5→5、delivery attempts 5→5、**Gmail sends 0**。既存FAILED/DELIVERY_UNKNOWNの送信再試行なし。
- 既存dirty worktreeは保全し、commit/push/reset/restore/cleanなし。この監査での変更は上記P1の原因修正、旧結果参照ガード、専用回帰テスト、および本レポートのみ。以前からの大量の未コミット差分を整理・巻き戻ししていない。

## 残課題と境界

| Severity | 内容・影響 | 回避策 / 今後 |
| --- | --- | --- |
| P0 | なし | — |
| P1 | なし (疎履歴不一致は本監査で修正) | — |
| P2 | 大きな同業/汎用MAのcold検索は約5〜13秒。非同期1年scanは約44秒。瞬時の検索が必要な運用では待機が発生する。 | cache hitは15ms未満。性能改善は別Issueで計測条件を揃えて検討。 |
| P2 | 旧保存済みPeriod/Outcome結果は修正前の計算定義で作成されており、現在は結果APIが410。履歴行は残るが分析結果を参照できない。 | ユーザーが同条件で期間検証/Outcomeを再実行。DBの旧成果物は削除せず、未来データで代替しない。 |
| P3 | 旧定義での無効化をUIが「期限切れ」と表示し、TTL満了と区別できない。 | 再実行で解消。文言分離は別途小修正が必要。 |
| P3 | 高度分析の一部metadata/比較ラベルは9〜10pxで、小画面では読みにくい。 | 表/Matrix内部scrollを維持。文字サイズの調整は別UI課題。 |

## 最終検証と制約

関連のEngine、Read Model、Historical/Job/Worker、Outcome、Segmentation、Robustness、Spread、Saved Definition、Evaluation/Lifecycle/Notificationの回帰PASS。`npx tsc --noEmit`、production build、`npm run test:site-smoke`、`git diff --check` PASS。修正を正式deploy済み。既存dirty変更を含むため、git diff全体は本監査のみの変更ではない。1年のpaired comparison負荷再現、全509GiB DB integrity scan、外部Gmail配送は監査対象外/未実行と明示してPASS判定する。Gmail接続・実送信は別途明示的な運用判断が必要。
