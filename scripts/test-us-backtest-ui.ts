import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const source = (file: string) => readFile(new URL(file, root), 'utf8')

async function main() {
  const [page, explorer, controls, results, detail, chart, shared, server] = await Promise.all([
    source('app/us/analysis/backtest/page.tsx'),
    source('components/us/backtest/UsBacktestExplorer.tsx'),
    source('components/us/backtest/UsBacktestControls.tsx'),
    source('components/us/backtest/UsBacktestResults.tsx'),
    source('components/us/backtest/UsBacktestDetail.tsx'),
    source('components/us/backtest/UsBacktestOutcomeChart.tsx'),
    source('components/us/backtest/usBacktestShared.ts'),
    source('lib/server/us-backtest.ts'),
  ])

  assert.match(page, /<UsBacktestExplorer/)
  assert.match(page, /モデル・方策の評価/)
  assert.match(page, /MLモデル評価/)
  assert.match(page, /物理状態別の事後成績/)
  assert.match(page, /RL方策評価/)
  assert.match(page, /類似局面評価/)

  assert.match(explorer, /AbortController/)
  assert.match(explorer, /Historical Outcome Explorer/)
  assert.match(explorer, /過去時点の分類を保証できない/)
  assert.match(controls, /6桁Stage/)
  assert.match(controls, /シグナル（完全一致）/)
  assert.match(controls, /結果確定済み基準日/)
  assert.match(results, /useSyncExternalStore/)
  assert.match(results, /min-width: 1024px/)
  assert.match(results, /<ResultsTable/)
  assert.match(results, /<ResultsList/)
  assert.match(detail, /generatedNarrative=false/)
  assert.match(detail, /シグナル根拠/)
  assert.match(chart, /ResizeObserver/)
  assert.match(chart, /矢印キー/)

  assert.match(shared, /value == null/)
  assert.match(shared, /return value > 0 \? UP_TEXT : DOWN_TEXT/)
  assert.doesNotMatch(shared, /sector=/)
  assert.doesNotMatch(shared, /industry=/)
  assert.doesNotMatch(shared, /exchange=/)

  assert.match(server, /OMITTED_HISTORICAL_PIT_UNAVAILABLE/)
  assert.match(server, /generatedNarrative: false/)
  assert.match(server, /r\.min_return_pct IS NULL ASC/)
  assert.doesNotMatch(server, /ticker_universe/)
  assert.doesNotMatch(server, /market_classifications/)

  console.log('US backtest UI contract tests: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
