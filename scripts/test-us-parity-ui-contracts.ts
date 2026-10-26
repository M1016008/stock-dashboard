import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const source = (path: string) => readFileSync(resolve(root, path), 'utf8')

const maMonitor = source('app/us/ma25m-monitor/page.tsx')
assert.match(maMonitor, /const requestSequence = useRef\(0\)/)
assert.match(maMonitor, /const sequence = \+\+requestSequence\.current/)
assert.match(maMonitor, /setData\(null\)/)
assert.match(maMonitor, /sequence === requestSequence\.current/)
assert.match(maMonitor, /!controller\.signal\.aborted && sequence === requestSequence\.current/)
assert.match(maMonitor, /\{!error && <section className="panel"/)

const earnings = source('app/us/earnings/page.tsx')
assert.match(earnings, /Array\.isArray\(value\)[\s\S]*valid: false/)
assert.match(earnings, /from > to/)
assert.match(earnings, /result\?\.status === 'unavailable'/)
assert.match(earnings, /result && result\.rows\.length === 0/)
assert.match(earnings, /role="alert"/)

const sectorBoard = source('app/us/sector-etfs/page.tsx')
assert.match(sectorBoard, /metric\.dataStatus === 'price_missing'/)
assert.match(sectorBoard, /aria-disabled="true"/)
assert.match(sectorBoard, /詳細データなし/)

const sectorDetail = source('app/us/sector-etfs/[ticker]/page.tsx')
assert.match(sectorDetail, /if \(!detail\) \{[\s\S]*価格データがありません/)

const dailyClose = source('app/us/daily-close/page.tsx')
assert.match(dailyClose, /report\.market\.adjustedTurnoverUsd/)
assert.match(dailyClose, /label: '変わらず'[\s\S]*report\.market\.unchanged/)
assert.match(dailyClose, /label: '前日値欠損'[\s\S]*report\.market\.unobserved/)
assert.match(dailyClose, /before_open: '寄付前'/)
assert.match(dailyClose, /EARNINGS_TIME_LABELS\[row\.timeBucket\]/)
assert.match(dailyClose, /report\.earnings\.status === 'unavailable'/)
assert.match(dailyClose, /履歴時点の決算予定は利用できません/)
assert.match(dailyClose, /調整済み優先: 終値 × 出来高/)

const tradeWorkbench = source('app/us/trade/workbench/page.tsx')
assert.match(tradeWorkbench, /Array\.isArray\(sp\.horizon\)/)
assert.match(tradeWorkbench, /boundedInteger\(first\(sp\.budgetUsd\), 5_000, 100, 1_000_000\)/)
assert.match(tradeWorkbench, /boundedInteger\(first\(sp\.limit\), 40, 1, 120\)/)
assert.match(tradeWorkbench, /!HORIZONS\.some/)
assert.match(tradeWorkbench, /role="alert"/)

const periodExplorer = source('app/period-explorer/PeriodExplorerClient.tsx')
assert.match(periodExplorer, /stripUnavailableHistoricalUsParams/)
assert.match(periodExplorer, /disabled=\{historicalUs && item\.key === 'industry'\}/)
assert.match(periodExplorer, /!historicalUs && <MarketFilterMenu/)
assert.match(periodExplorer, /turnoverObservations/)

const loading = source('app/us/loading.tsx')
assert.match(loading, /米国株ページを読み込んでいます/)
assert.doesNotMatch(loading, /ダッシュボード/)

console.log('US parity UI contracts: PASS')
