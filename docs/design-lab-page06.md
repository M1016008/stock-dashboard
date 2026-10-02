# Page 06 Design Lab — 60分類 MOMENTUM MATRIX

Daily Close Report の Page 06（現行「60分類 1M & ACCELERATION」）を作り直すための Design Lab。
**Production には接続していない**（`components/reports/DailyCloseReportView.tsx` / builder / API は未変更）。

- branch: `claude/narrative-bridge-phase1`（base `c69ed6f`）
- 実データ検証日: 2026-10-02

## ページの役割

60分類について、1M（20営業日）の強さと直近1W（5営業日）の勢いの変化を並べ、
上位維持 / 急浮上 / 高位失速 / 下位改善 を 20〜30 秒で判別できるようにする。

- Momentum Shift = `rank1M - rank1W`（正 = 1W で順位上昇）。**リターンの加速度ではない**ので
  ページ上で「Acceleration」とは表記しない。
- 順位は 60 分類の平均リターン順位（既存 `aggregateClassifications60`）。

## レイヤー構成（編集箇所の目安）

| 層 | ファイル | 内容 |
|---|---|---|
| データ | `scripts/lib/readonly-daily-close-report.ts` | 本番 SQLite を `sqlite3 -readonly` + `query_only=ON` で読み、`lib/server/daily-close-report.ts` と同一ロジックで DailyCloseReport を組み立てる。移植元とのソース照合付き（不一致なら中止） |
| 判定ロジック / ViewModel | `lib/daily-close-momentum-matrix.ts` | 状態判定（しきい値 `MOMENTUM_THRESHOLDS`）、LOW SAMPLE / 平均主導フラグ、状態別リスト・注目分類の選定、表示フォーマット |
| Narrative（pure） | `lib/daily-close-page06-narrative-content.ts` | Claude 入力 JSON、出力検証（文字数・入力外の数値・注目外の分類名・禁止語）、deterministic fallback 文章 |
| Narrative（Claude 呼び出し） | `lib/server/daily-close-page06-narrative.ts` | `--json-schema` とシステムプロンプト。`lib/server/claude-code-adapter.ts` 経由で subscription のみ |
| レイアウト定数 | `components/reports/design-lab/page06/layout.ts` | ページ寸法・余白、Matrix 寸法・点・ラベル間隔、リスト列幅、フォントサイズ、色 |
| スタイル | `components/reports/design-lab/page06/styles.ts` | `layout.ts` から CSS を生成 |
| Matrix 描画 | `components/reports/design-lab/page06/MomentumMatrixChart.tsx` | 座標変換、状態ゾーン、ラベル配置（`placeLabels`） |
| 右側リスト | `components/reports/design-lab/page06/MomentumStateList.tsx` | 状態別 上位3件（1M→1W / Shift / 1W平均 / 中央値 / 勝率 / フラグ）と LOW SAMPLE 一覧 |
| Narrative 表示 | `components/reports/design-lab/page06/NarrativePanel.tsx` | headline 行、事実 / 解釈 / 注意点 |
| ページ構成 | `components/reports/design-lab/page06/Page06MomentumMatrix.tsx` | 上段・中段・下段・脚注の組み立て |
| レンダリング | `scripts/lib/design-lab-page06-render.ts` | snapshot → HTML → PDF / PNG（Chrome headless。既存 Daily Close PDF と同じ起動条件） |
| CLI | `scripts/design-lab-page06.ts` | `generate` / `render` |
| テスト | `scripts/test-daily-close-momentum-matrix.ts` | 判定境界、選定、検証、fallback、描画 |

## 状態判定（Phase 1）

| 状態 | 条件（60分類の順位、1 = 最上位） |
|---|---|
| 上位維持 | 1M ≤ 15 かつ 1W ≤ 15 |
| 急浮上 | 1M > 30 かつ 1W ≤ 15 |
| 高位失速 | 1M ≤ 15 かつ 1W > 30 |
| 下位改善 | 1M > 45 かつ Shift ≥ 15（急浮上を除く） |
| その他 | 上記以外 |

信頼性フラグ（状態とは独立）:
- `LOW SAMPLE`: 1W または 1M の対象が 5 銘柄未満。Matrix には破線○で表示、注目・ラベル・Claude 入力からは除外。
- `平均主導`: 1W 平均 > 0 かつ（中央値 ≤ 0 または勝率 < 50%）。

## コマンド

通常の再描画は **render のみで足りる**（DB・Claude に触れない）。資料デザインの変更依頼は、
Codex が `page_design_build` profile を呼び、Claude Code がこのDesign Lab内で実装・テスト・PDF/PNG生成・再調整まで行う。
Codex は実行後のdiff、typecheck、regression、PDF page count、overflow/overlap、Production未変更を確認する。

```bash
# CodexからのDesign Lab build依頼（stdin JSON、Claude subscription経路）
printf '%s' '{"task":"page_design_build","input":{"project":"page06","request":"表を大きくし、余白を減らす"}}' \
  | npm run --silent claude:dispatch
```

`page_design_build` の編集allowlist:
- `components/reports/design-lab/page06/`
- `scripts/lib/design-lab-page06-render.ts`
- 実行ごとに新規作成される `MAIL-REPORT-2-QA/page06-design-lab-build/runs/<run-id>/`

Readは専用worktreeと固定snapshot/outputに限定し、BashはPage 06 test、typecheck、固定snapshotからのrenderだけを許可する。
Production統合、DB、Gmail、Scheduler、launchd、Git操作、既存PDF上書きは許可しない。

手動の再描画:

```bash
# 再描画（snapshot から HTML / PDF / PNG）
TSX_DISABLE_CACHE=1 ./node_modules/.bin/tsx scripts/design-lab-page06.ts render <snapshot.json> [outDir]

# テスト / 型
TSX_DISABLE_CACHE=1 ./node_modules/.bin/tsx scripts/test-daily-close-momentum-matrix.ts
./node_modules/.bin/tsc --noEmit --incremental false -p tsconfig.json

# データから作り直す（本番 SQLite を read-only で読む。Claude を 1 回呼ぶ）
CLAUDE_DESIGN_LAB=1 READONLY_SQLITE_DB_PATH="<STOCKBOARD_DB_PATH of LaunchAgent>" TSX_DISABLE_CACHE=1 \
  ./node_modules/.bin/tsx scripts/design-lab-page06.ts generate <outDir> 2026-10-02

# 既存の Claude 文章を再利用して作り直す（Claude を呼ばない。文章は再検証される）
READONLY_SQLITE_DB_PATH="..." TSX_DISABLE_CACHE=1 \
  ./node_modules/.bin/tsx scripts/design-lab-page06.ts generate <outDir> 2026-10-02 --narrative-json <file>
```

- `<outDir>` はリポジトリ外のみ（スクリプトで強制）。
- 出力: `page06-momentum-matrix-<date>.{html,pdf,png}`（Claude 版）、`-deterministic.{html,pdf,png}`（fallback 版）、`.snapshot.json`。
- PDF: A4 landscape（297 × 210 mm）、`@page { margin: 0 }`、ヘッダ/フッタなし。PNG: 1123 × 794 viewport × 2。

## 安全条件（変更しないこと）

- 本番 DB をアプリの DB クライアント（`lib/db/client`）経由で開かない。external-storage-guard を起動しない。
- `READONLY_SQLITE_DB_PATH` は推測しない（LaunchAgent plist の `STOCKBOARD_DB_PATH` を確認）。
- Claude は `lib/server/claude-code-adapter.ts` 経由のみ（`/Users/yoshio/.local/bin/claude`、`--model sonnet`、tools なし、subscription 以外は拒否）。API key 経路を追加しない。
- Large Holder は UNAVAILABLE 固定、Watchlist は空（read-only 組み立ての制約）。
- Production の Page 06 / PDF / メール / Scheduler には接続しない。

## 既知の論点（Phase 2 候補）

- 順位は相対値のため、全面安の日は「急浮上」でも 1W 平均がマイナスになりうる（2026-10-02 の電力: 1M#56→1W#13、1W平均 -1.0%）。
- 平均リターン順位は外れ値に影響される。中央値順位との併記を検討。
- 前日順位・20営業日推移（`mail-report-v2` の v2 データ）は未使用。
