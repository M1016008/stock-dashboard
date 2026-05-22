# ローカルMacでのJ-Quants自動更新

このプロジェクトはローカル SQLite (`data/stockboard.db`) を主データストアにするため、ローカルMacの `launchd` で `npm run batch:update-latest` を定期実行する。

## 推奨スケジュール

J-Quants の日次株価・指数更新後に段階実行する。

- 16:45 JST: 株価・指数の更新確認
- 17:45 JST: 上場銘柄マスタ更新後の取りこぼし確認
- 18:15 JST: 決算予定などを含めた最終同期

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
