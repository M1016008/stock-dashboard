# ローカルMacでのJ-Quants自動更新

このプロジェクトはローカル SQLite (`data/stockboard.db`) を主データストアにするため、ローカルMacの `launchd` で `npm run batch:update-latest` を定期実行する。

## 推奨スケジュール

J-Quants の日次株価・指数更新後に段階実行する。サイト基準日は17:00までに最新化するため、株価・ステージ・ダッシュボードキャッシュを最優先で更新し、決算・信用・検証serving・MLなどの補助更新は後段で実行する。

- 16:40 JST: 株価・ステージ・ダッシュボードキャッシュの主更新
- 16:55 JST: 17:00前の取りこぼし確認
- 17:20 / 18:10 JST: J-Quants反映遅延に備えた再確認
- 21:10 JST: 補助データと直近60営業日の重いservingを含む夜間更新

登録は以下で行う。

```bash
npm run auto-update:install
```

このコマンドは `~/Library/LaunchAgents/com.stockboard.update-latest.plist` を作成し、`launchctl` に登録する。ログは `~/Library/Logs/StockBoard/update-latest.log` と `~/Library/Logs/StockBoard/update-latest.err` に出力される。

決算予定は専用ジョブで再取得し、個別銘柄servingとダッシュボードへ反映する。

- 07:10 JST: 朝の主更新
- 14:10 JST: 外部APIやネットワーク障害に備えた再試行

## launchd 例

`~/Library/LaunchAgents/com.stockboard.update-latest.plist` に以下を配置する。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.stockboard.update-latest</string>
  <key>WorkingDirectory</key>
  <string>/Users/yoshio/dev/stock-dashboard/.claude/worktrees/gracious-grothendieck-804715</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>npm</string>
    <string>run</string>
    <string>batch:update-latest</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>16</integer><key>Minute</key><integer>40</integer></dict>
    <dict><key>Hour</key><integer>16</integer><key>Minute</key><integer>55</integer></dict>
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>20</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>10</integer></dict>
    <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>10</integer></dict>
  </array>
  <key>StandardOutPath</key>
  <string>/tmp/stockboard-update-latest.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/stockboard-update-latest.err</string>
</dict>
</plist>
```

手動登録:

```bash
npm run auto-update:install
```

停止:

```bash
launchctl unload ~/Library/LaunchAgents/com.stockboard.update-latest.plist
```

`scripts/update-latest.ts` はDBロックを取得してから実行するため、同時刻に手動実行しても重複更新は避けられる。
親オーケストレーターは処理時間を覆う長期leaseを取得し、子バッチがSQLiteへ書いている間はDB heartbeatを行わない。子バッチ間でだけleaseを更新するため、親子自身の書き込み競合を避けられる。親が異常終了した場合も、既知のSQLite writerが残っている間は孤児ロックを解放せず、writer終了後に安全に回収する。任意データ取得が失敗してもOHLCV・snapshot・dashboard_cacheの更新は先に完了する。

## 決算予定と個別銘柄servingの定期同期

`npm run batch:earnings-refresh` は以下を実行する。

1. `scripts/batch-earnings.ts`: J-Quants翌営業日API + JPX公式Excelを取得
2. `scripts/build-dashboard-cache.ts`: ダッシュボードの決算欄へ即時反映
3. `scripts/build-serving-stock.ts`: 個別銘柄用servingを再生成

専用の `earnings_refresh` 排他ロックを使うため、OHLCV、ML、US更新、ニュース取得、DBメンテナンスと同時にSQLiteへ書かない。

`~/Library/LaunchAgents/com.stockboard.earnings-refresh.plist` に以下を配置する。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.stockboard.earnings-refresh</string>
  <key>WorkingDirectory</key>
  <string>/Users/yoshio/dev/stock-dashboard/.claude/worktrees/gracious-grothendieck-804715</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>npm</string>
    <string>run</string>
    <string>batch:earnings-refresh</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>10</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>10</integer></dict>
  </array>
  <key>StandardOutPath</key>
  <string>/tmp/stockboard-earnings-refresh.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/stockboard-earnings-refresh.err</string>
</dict>
</plist>
```

登録:

```bash
launchctl load ~/Library/LaunchAgents/com.stockboard.earnings-refresh.plist
```

停止:

```bash
launchctl unload ~/Library/LaunchAgents/com.stockboard.earnings-refresh.plist
```

## OHLCV取得後の即時反映

`npm run batch:ohlcv` は、J-Quants からOHLCVを取得した直後に以下を連続実行する。

1. `scripts/batch-snapshots.ts`: `daily_snapshots` を最新営業日まで計算
2. `scripts/build-dashboard-cache.ts`: ダッシュボード表示キャッシュを最新営業日で再生成

取得だけを行いたい検証時は、以下を使う。

```bash
npm run batch:ohlcv:fetch-only
```

初回の全履歴取得などで後段更新を意図的に止めたい場合は、以下も使える。

```bash
POST_OHLCV_REFRESH=0 npm run batch:ohlcv
```
