# ローカルMacでのJ-Quants自動更新

このプロジェクトはローカル SQLite (`data/stockboard.db`) を主データストアにするため、ローカルMacの `launchd` で `npm run batch:update-latest` を定期実行する。

## 推奨スケジュール

J-Quants の日次株価・指数更新後に段階実行する。

- 16:45 JST: 株価・指数の更新確認
- 17:45 JST: 上場銘柄マスタ更新後の取りこぼし確認
- 18:15 JST: 決算予定などを含めた最終同期

JPX公式の決算発表予定ページは毎営業日17時頃に更新されるため、決算予定だけは軽量バッチで追加確認する。

- 17:20 JST: JPX公式Excelの更新確認
- 19:20 JST: J-Quants翌営業日API更新後の再確認
- 21:00 JST: 夜間の取りこぼし確認

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
    <dict><key>Hour</key><integer>16</integer><key>Minute</key><integer>45</integer></dict>
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>45</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>15</integer></dict>
  </array>
  <key>StandardOutPath</key>
  <string>/tmp/stockboard-update-latest.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/stockboard-update-latest.err</string>
</dict>
</plist>
```

登録:

```bash
launchctl load ~/Library/LaunchAgents/com.stockboard.update-latest.plist
```

停止:

```bash
launchctl unload ~/Library/LaunchAgents/com.stockboard.update-latest.plist
```

`scripts/update-latest.ts` はDBロックを取得してから実行するため、同時刻に手動実行しても重複更新は避けられる。

## JPX公式決算予定だけの軽量定期同期

`npm run batch:earnings-refresh` は以下だけを実行する。

1. `scripts/batch-earnings.ts`: J-Quants翌営業日API + JPX公式Excelを取得
2. `scripts/build-dashboard-cache.ts`: ダッシュボードの決算欄へ即時反映

フル更新より軽く、`update_latest` ロックを使うため、OHLCV更新や全体更新と同時に走った場合は重複実行を避ける。

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
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>20</integer></dict>
    <dict><key>Hour</key><integer>19</integer><key>Minute</key><integer>20</integer></dict>
    <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>0</integer></dict>
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
