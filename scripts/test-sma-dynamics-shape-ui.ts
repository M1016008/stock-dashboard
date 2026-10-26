// SMA Dynamics Lab: shape / crossing panels, custom periods, shock presets and link notice,
// rendered to static markup from synthetic fixtures. No browser, database or network.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { findSmaDynamicsFixture } from '@/lib/sma-dynamics-fixtures'
import { computeSmaLab, smaLabMaxHorizonBars, SMA_LAB_COLORS } from '@/lib/sma-dynamics-lab'
import { SMA_LAB_TIMEFRAMES } from '@/lib/sma-dynamics-timeframes'
import { emptyScenario, evaluateScenario, forwardBase, presetShock, scenarioFromCloses } from '@/lib/sma-dynamics-scenario'
import { parseSmaDynamicsLink } from '@/lib/sma-dynamics-link'
import { SMA_DYNAMICS_DEFAULT_SETTINGS, SMA_DYNAMICS_PREMISE, SmaDynamicsView, LinkOriginNotice, type SmaDynamicsSettings } from '@/components/stock/sma-dynamics/SmaDynamicsView'
import { crossingGoalTitle, describeRequirement } from '@/components/stock/sma-dynamics/SmaCrossingPanel'

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

function render(fixtureId: string, settings: Partial<SmaDynamicsSettings>, linkIntent: ReturnType<typeof parseSmaDynamicsLink> = null) {
  const fixture = findSmaDynamicsFixture(fixtureId)!
  assert.ok(fixture, fixtureId)
  return renderToStaticMarkup(createElement(SmaDynamicsView, {
    security: { market: fixture.market, ticker: fixture.ticker, name: fixture.name },
    analysisDate: fixture.analysisDate,
    load: { status: 'ready', rows: fixture.rows },
    dataSource: { label: 'テスト', priceBasis: '合成データ' },
    initialSettings: { ...SMA_DYNAMICS_DEFAULT_SETTINGS, ...settings },
    linkIntent,
  }))
}

// Every timeframe x mode renders both panels (or says why not) without throwing.
for (const id of ['jp-rising', 'us-falling']) {
  for (const timeframe of SMA_LAB_TIMEFRAMES) {
    for (const analysis of ['freeze', 'scenario', 'solver'] as const) {
      const horizon = Math.min(5, smaLabMaxHorizonBars(timeframe.id))
      const markup = render(id, { timeframe: timeframe.id, analysis, horizon })
      const label = `${id}/${timeframe.id}/${analysis}`
      assert.match(markup, /data-sma-dynamics-shape/, `${label}: shape section`)
      assert.match(markup, /data-sma-dynamics-crossing/, `${label}: crossing section`)
      assert.ok(/data-sma-shape-panel|data-sma-shape-empty/.test(markup), `${label}: shape panel or its empty reason`)
      assert.ok(/data-sma-crossing-panel|data-sma-crossing-empty/.test(markup), `${label}: crossing panel or its empty reason`)
    }
  }
}

// Shape panel content under price freeze.
{
  const markup = render('jp-rising', { periods: [5, 25, 75] })
  const visible = text(markup)
  for (const word of ['傾き (%/本)', '曲率', 'SMA間の差', '収束', '終値 vs SMA25', 'SMAの並び', '交差 (SMA同士・終値とSMA)']) assert.ok(visible.includes(word), word)
  assert.match(markup, /data-sma-pair-table/)
  assert.match(markup, /data-sma-position-strip/)
  assert.match(markup, /data-source="価格固定"/)
  assert.equal((markup.match(/data-sma-shape-plot=/g) ?? []).length, 3, 'slope, curvature and pair plots')
  assert.doesNotMatch(visible.replace(SMA_DYNAMICS_PREMISE, ''), /予測|予想|買い|売り|シグナル/, 'neutral wording')
  assert.equal((markup.match(/aria-live=/g) ?? []).length, 0)
}

// Custom periods: SMA7 and SMA120 are computed and drawn like presets.
{
  const markup = render('jp-long-history', { periods: [5, 7, 120] })
  const visible = text(markup)
  assert.ok(visible.includes('SMA7') && visible.includes('SMA120'), 'custom SMAs in tables')
  assert.match(markup, /data-sma-custom-periods/)
  assert.match(markup, /data-sma-custom-period-chips/, 'custom periods can be removed again')
  const fixture = findSmaDynamicsFixture('jp-long-history')!
  const result = computeSmaLab({ rows: fixture.rows, market: fixture.market, timeframe: '1D', horizon: 5, analysisDate: fixture.analysisDate, periods: [7, 120] })
  assert.equal(result.status, 'available')
  if (result.status === 'available') {
    assert.deepEqual(result.periods.map((item) => item.period), [3, 5, 7, 10, 13, 25, 50, 75, 100, 120, 150, 200, 300])
    assert.ok(result.periods.find((item) => item.period === 120)!.status === 'ok')
    assert.equal(SMA_LAB_COLORS[7], undefined, 'custom periods have no preset color (a stable derived one is used)')
  }
}

// Crossing panel starts from the link's pair; the link banner names its origin and flags a date mismatch.
{
  const intent = parseSmaDynamicsLink('?smalab=1&smasrc=six-stage-current&smaasof=2026-10-23&smagen=gen-1&smapair=25-75&smap=5,25,75')!
  const markup = render('jp-rising', { periods: [5, 25, 75] }, intent)
  assert.match(markup, /data-sma-link-origin="six-stage-current"/)
  assert.ok(text(markup).includes('6ステージの現在候補'))
  assert.match(markup, /<option value="25" selected="">SMA25<\/option>/, 'short SMA of the pair is the moving line')
  assert.match(markup, /<option value="75" selected="">SMA75<\/option>/, 'long SMA of the pair is the reference')
  assert.match(markup, /<details[^>]*open=""[^>]*data-sma-dynamics-crossing/, 'crossing section opens for a pair link')
  assert.match(markup, /<details[^>]*open=""[^>]*data-sma-dynamics-shape/, 'shape section opens for a pair link')
  assert.doesNotMatch(render('jp-rising', { periods: [5, 25, 75] }), /<details[^>]*open=""[^>]*data-sma-dynamics-crossing/, 'closed without a link')
  const notice = renderToStaticMarkup(createElement(LinkOriginNotice, { intent, latestDate: '2026-10-16' }))
  assert.match(notice, /data-sma-link-asof-mismatch/)
  assert.ok(text(notice).includes('2026-10-23') && text(notice).includes('2026-10-16'))
  const same = renderToStaticMarkup(createElement(LinkOriginNotice, { intent, latestDate: '2026-10-23' }))
  assert.doesNotMatch(same, /data-sma-link-asof-mismatch/)
  assert.equal(renderToStaticMarkup(createElement(LinkOriginNotice, { intent: { ...intent, origin: null }, latestDate: null })), '')
}

// Shock presets (rise / fall are the constant-rate examples) and their effect on the SMA.
{
  const fixture = findSmaDynamicsFixture('jp-rising')!
  const result = computeSmaLab({ rows: fixture.rows, market: fixture.market, timeframe: '1D', horizon: 6, analysisDate: fixture.analysisDate })
  assert.equal(result.status, 'available')
  if (result.status !== 'available') throw new Error('unavailable')
  const base = forwardBase(result)
  const draft = emptyScenario(base.horizon, 'pct')
  const down = evaluateScenario(base, presetShock(base, draft, -10, 2, 'hold'))
  assert.deepEqual(down.cells.map((cell) => cell.pctFromAnchor), [0, -10, -10, -10, -10, -10])
  const revert = evaluateScenario(base, presetShock(base, draft, 10, 2, 'revert'))
  assert.deepEqual(revert.cells.map((cell) => cell.pctFromAnchor), [0, 10, 7.5, 5, 2.5, 0])
  const atEnd = evaluateScenario(base, presetShock(base, draft, 5, 99, 'revert'))
  assert.equal(atEnd.cells.at(-1)!.pctFromAnchor, 5, 'a shock at the last bar has nothing to revert')
  assert.equal(atEnd.cells[0].pctFromAnchor, 0)
  assert.equal(down.state, 'complete')
  // A shock changes the SMA exactly as the same closes typed by hand would.
  const typed = evaluateScenario(base, scenarioFromCloses(base, down.closes, 'price'))
  assert.deepEqual(typed.sma[5], down.sma[5])
  assert.notDeepEqual(down.sma[5], result.projection.sma[5], 'differs from price freeze')
  const markup = render('jp-rising', { analysis: 'scenario' })
  assert.match(markup, /data-sma-shock-example="up"/)
  assert.match(markup, /data-sma-shock-example="down"/)
  assert.match(markup, /data-sma-shock-tool/)
  assert.match(markup, /data-sma-scenario-comparison/)
  for (const label of ['横ばい', '上昇', '下落', '急騰', '急落', '入力中']) assert.ok(text(markup).includes(label), `scenario comparison: ${label}`)
}

// Wording helpers.
{
  const timing = (k: number) => (k === 1 ? '次の日足' : `${k}本後`)
  assert.equal(crossingGoalTitle({ kind: 'cross', subject: { kind: 'sma', period: 5 }, reference: 25, within: 3, direction: 'up' }, timing), '3本以内に SMA5 が SMA25 を下から上へ抜ける')
  assert.equal(crossingGoalTitle({ kind: 'touch', subject: { kind: 'close' }, reference: 75, bar: 1 }, timing), '次の日足に 終値 が SMA75 にちょうど触れる')
  const fmt = (value: number | null | undefined) => (value == null ? '—' : value.toFixed(2))
  const strict = describeRequirement({ k: 1, status: 'feasible', issue: null, threshold: 97.5, op: '>', bound: { value: 97.5, attained: false }, neighbours: null, pctFromAnchor: 8, sideBefore: -1 }, fmt, '円')
  assert.ok(strict.includes('97.50円 を超える終値') && strict.includes('ちょうどは含まない'))
  const ticked = describeRequirement({ k: 1, status: 'feasible', issue: null, threshold: 97.5, op: '>', bound: { value: 98, attained: true }, neighbours: null, pctFromAnchor: 8, sideBefore: -1 }, fmt, '円')
  assert.ok(ticked.includes('98.00円 以上'))
}

console.log('test-sma-dynamics-shape-ui: ok')
