// SMA Dynamics Lab UI contract: JP/US stock-detail placement, identity hand-off,
// lazy history adapter and per-security isolation, chart library usage, copy,
// rendered states, dev-only fixture preview. Static render + source checks only.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { findSmaDynamicsFixture } from '@/lib/sma-dynamics-fixtures'
import { describeSmaLabUnavailable, SMA_LAB_PERIODS } from '@/lib/sma-dynamics-lab'
import { SMA_LAB_TIMEFRAMES } from '@/lib/sma-dynamics-timeframes'
import {
  SMA_DYNAMICS_DEFAULT_SETTINGS,
  SMA_DYNAMICS_PREMISE,
  SMA_MODE_SUBTITLE,
  SMA_DYNAMICS_TITLE,
  SmaDynamicsView,
  type SmaDynamicsLoadState,
  type SmaDynamicsSettings,
} from '@/components/stock/sma-dynamics/SmaDynamicsView'
import {
  clearSmaHistoryCache,
  SmaDynamicsSection,
  smaHistoryCacheKey,
  STOCK_HISTORY_API_SOURCE,
  subscribeSmaHistory,
  type SmaDynamicsHistorySource,
} from '@/components/stock/sma-dynamics/SmaDynamicsSection'
import { parsePreviewQuery } from '@/app/dev/sma-dynamics/SmaDynamicsPreviewClient'
import { isSmaDynamicsFixturePreviewPath } from '@/lib/sma-dynamics-preview-path'

const read = (path: string) => readFileSync(path, 'utf8')
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ---------------------------------------------------------------------------
// Copy
assert.equal(SMA_DYNAMICS_TITLE, 'SMA Dynamics Lab')
assert.equal(SMA_MODE_SUBTITLE.freeze, '株価が今のままなら、移動平均線はどう動く？')
assert.match(SMA_DYNAMICS_PREMISE, /基準日の終値が将来も変わらないと仮定/)
assert.match(SMA_DYNAMICS_PREMISE, /現在の傾きの延長ではなく、株価予測でもありません/)

// ---------------------------------------------------------------------------
// Placement and identity: right after "価格と移動平均", before StageTimeline, in both markets.
{
  const jp = read('app/stock/[ticker]/StockDetailClient.tsx')
  const workspace = jp.slice(jp.indexOf('function ChartWorkspace'), jp.indexOf('function useChartHeight'))
  const chartTitle = workspace.indexOf('id="main-chart-title"')
  const chartSectionEnd = workspace.indexOf('</section>', chartTitle)
  const tag = '<SmaDynamicsSection market="JP" ticker={ticker.replace(\'.T\', \'\')} name={companyName} analysisDate={analysisDate} linkIntent={smaLinkIntent} />'
  const section = workspace.indexOf(tag)
  const stage = workspace.indexOf('<StageTimeline\n')
  assert.ok(chartTitle > 0 && section > chartSectionEnd && stage > section, 'JP: chart section -> SMA lab -> StageTimeline')
  assert.equal(workspace.slice(chartSectionEnd + '</section>'.length, section).trim(), '', 'JP: lab immediately follows the chart')
  assert.equal((workspace.match(/<SmaDynamicsSection/g) ?? []).length, 1)
  assert.ok(workspace.includes(`      <StageTimeline
        ticker={ticker}
        analysisDate={analysisDate}
        onSnapshotChange={handleStageSnapshot}
      />`), 'JP StageTimeline props unchanged')
  assert.ok(workspace.includes('maLinesByInterval={{ M: [3, 5, 10, 15, 20, 25] }}'), 'JP main chart MA config unchanged')
  assert.ok(workspace.includes('revealAfterAnalysis={showActual}'), 'JP main chart reveal behavior unchanged')
  assert.match(jp, /companyName=\{name === '---' \? null : name\}/, 'JP page hands the security name to the workspace')

  const us = read('components/us/stock-detail/UsChartWorkspace.tsx')
  const usWorkspace = us.slice(us.indexOf('export function UsChartWorkspace'), us.indexOf('function useChartHeight'))
  const usTitle = usWorkspace.indexOf('id="us-main-chart-title"')
  const usSectionEnd = usWorkspace.indexOf('</section>', usTitle)
  const usSection = usWorkspace.indexOf('<SmaDynamicsSection market="US" ticker={ticker} name={companyName} analysisDate={analysisDate} linkIntent={smaLinkIntent} />')
  const usStage = usWorkspace.indexOf('<StageTimeline\n')
  assert.ok(usTitle > 0 && usSection > usSectionEnd && usStage > usSection, 'US: chart section -> SMA lab -> StageTimeline')
  assert.ok(workspace.includes('useSmaLinkIntent(`JP:${ticker}`)') && usWorkspace.includes('useSmaLinkIntent(`US:${ticker}`)'), 'both detail pages read the shared link contract')
  assert.equal(usWorkspace.slice(usSectionEnd + '</section>'.length, usSection).trim(), '')
  assert.ok(usWorkspace.includes(`      <StageTimeline
        ticker={ticker}
        market="US"
        analysisDate={analysisDate}
        onSnapshotChange={handleStageSnapshot}
      />`), 'US StageTimeline props unchanged')
  assert.ok(usWorkspace.includes('<UsPhysicalMomentumSection ticker={ticker} analysisDate={analysisDate} momentum={momentum} />'))
  assert.match(read('app/us/stock/[ticker]/UsStockDetailClient.tsx'), /companyName=\{quote\.name \?\? null\}/, 'US page hands the security name')

  for (const source of [workspace, usWorkspace]) {
    assert.doesNotMatch(source.match(/<SmaDynamicsSection[^>]*>/)?.[0] ?? '', /showActual|reveal/, 'reveal never reaches the lab (PIT always enforced)')
  }
}

// ---------------------------------------------------------------------------
// Data access: one adapter, existing routes, nothing else fetches.
{
  const section = read('components/stock/sma-dynamics/SmaDynamicsSection.tsx')
  assert.match(section, /security\.market === 'US' \? '\/api\/us\/history' : '\/api\/history'/)
  assert.match(section, /SMA_DYNAMICS_HISTORY_PERIOD = 'all'/)
  assert.equal((section.match(/fetch\(/g) ?? []).length, 1, 'single fetch inside the API adapter')
  assert.match(section, /key=\{`\$\{source \? smaHistoryCacheKey\(source, security\)/, 'loader keyed per source + market + ticker (+ link)')
  for (const file of ['SmaDynamicsView.tsx', 'SmaDynamicsChart.tsx', 'SmaDynamicsControls.tsx', 'SmaDynamicsPanels.tsx']) {
    const source = read(`components/stock/sma-dynamics/${file}`)
    assert.doesNotMatch(source, /fetch\(|\/api\/|@\/lib\/db|@\/lib\/queries/, `${file} is fetch-free`)
    assert.doesNotMatch(source, /sma-dynamics-fixtures|SMA_DYNAMICS_FIXTURES/, `${file}: fixtures never reach the normal UI`)
    assert.doesNotMatch(source, /showActual|reveal/i)
  }
  assert.doesNotMatch(section, /sma-dynamics-fixtures|SMA_DYNAMICS_FIXTURES/)
  for (const route of ['app/api/history/[ticker]/route.ts', 'app/api/us/history/[ticker]/route.ts']) {
    assert.doesNotMatch(read(route), /sma-dynamics/i, `${route} contract untouched`)
  }
}

// ---------------------------------------------------------------------------
// Chart library: TradingView Lightweight Charts, loaded lazily, attribution kept.
{
  const chart = stripComments(read('components/stock/sma-dynamics/SmaDynamicsChart.tsx'))
  assert.match(chart, /import type \{[\s\S]*?\} from 'lightweight-charts'/)
  assert.doesNotMatch(chart, /^import \{[^}]*\} from 'lightweight-charts'/m, 'no eager value import')
  assert.match(chart, /import\('lightweight-charts'\)/, 'dynamic import: loads only when the lab opens')
  assert.match(chart, /attributionLogo: true/)
  assert.match(chart, /handleScroll: \{ mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false \}/, 'drag/pan; vertical swipes still scroll the page')
  assert.match(chart, /handleScale: \{ mouseWheel: true, pinch: true/, 'wheel and pinch zoom')
  assert.match(chart, /crosshair: \{ mode: lwc\.CrosshairMode\.Normal \}/)
  assert.match(chart, /autoSize: true/, 'responsive')
  assert.match(chart, /lineStyle: lwc\.LineStyle\.Solid/, 'actual SMA solid')
  assert.match(chart, /lineStyle: lwc\.LineStyle\.Dotted/, 'assumed SMA dotted')
  assert.match(chart, /lineStyle: lwc\.LineStyle\.LargeDashed/, 'assumed close dashed')
  assert.match(chart, /priceScale\('right'\)\.applyOptions\(\{ autoScale: true \}\)/, 'reset restores price auto-scale')
  const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> }
  assert.ok(pkg.dependencies['lightweight-charts'], 'existing dependency, no new package')
}

// Solver comparison paths obey the same user-entered price domain as the solver.
{
  const view = read('components/stock/sma-dynamics/SmaDynamicsView.tsx')
  const solver = read('components/stock/sma-dynamics/SmaSolverPanel.tsx')
  assert.match(view, /comparedScenario\.closes, priceDomain\(parsedConstraints\.constraints\)/, 'scenario comparison uses the solver price domain')
  assert.match(solver, /if \(!check\.inDomain\) return '制約外'/, 'out-of-domain comparison paths are not labeled as satisfied')
}

// ---------------------------------------------------------------------------
// History subscription: cache, isolation between securities, explicit states.
async function historyContract() {
  clearSmaHistoryCache()
  const pending = new Map<string, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void; signal: AbortSignal }>()
  let calls = 0
  const source: SmaDynamicsHistorySource = {
    id: 'test',
    label: 'test',
    priceBasis: () => 'test',
    load: (identity, signal) => new Promise((resolve, reject) => {
      calls += 1
      pending.set(`${identity.market}:${identity.ticker}`, { resolve: resolve as (rows: unknown[]) => void, reject, signal })
    }),
  }
  const statesA: string[] = []
  const statesB: SmaDynamicsLoadState[] = []
  const cancelA = subscribeSmaHistory(source, { market: 'JP', ticker: 'AAAA' }, (state) => statesA.push(state.status))
  cancelA() // user navigates to another security before A arrives
  assert.ok(pending.get('JP:AAAA')!.signal.aborted, 'previous request aborted')
  const cancelB = subscribeSmaHistory(source, { market: 'US', ticker: 'AAAA' }, (state) => statesB.push(state))
  pending.get('US:AAAA')!.resolve([{ date: '2026-10-16', close: 2 }])
  pending.get('JP:AAAA')!.resolve([{ date: '2026-10-16', close: 1 }])
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(statesA, ['loading'], 'a late response for the previous security is dropped')
  assert.deepEqual(statesB.map((state) => state.status), ['loading', 'ready'])
  assert.deepEqual(statesB[1].status === 'ready' && statesB[1].rows, [{ date: '2026-10-16', close: 2 }], 'US rows only')
  cancelB()
  assert.notEqual(smaHistoryCacheKey(source, { market: 'JP', ticker: 'AAAA' }), smaHistoryCacheKey(source, { market: 'US', ticker: 'AAAA' }), 'same ticker in two markets never shares a cache entry')

  const cached: SmaDynamicsLoadState[] = []
  subscribeSmaHistory(source, { market: 'US', ticker: 'AAAA' }, (state) => cached.push(state))
  assert.equal(calls, 2, 'cache hit: no second load')
  assert.deepEqual(cached.map((state) => state.status), ['ready'])
  const expired: string[] = []
  subscribeSmaHistory(source, { market: 'US', ticker: 'AAAA' }, (state) => expired.push(state.status), () => Date.now() + 11 * 60 * 1000)
  assert.deepEqual(expired, ['loading'], 'cache entries expire after 10 minutes')

  const failed: SmaDynamicsLoadState[] = []
  subscribeSmaHistory(source, { market: 'JP', ticker: 'BBBB' }, (state) => failed.push(state))
  pending.get('JP:BBBB')!.reject(new Error('HTTP 500'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(failed.at(-1), { status: 'error', message: 'HTTP 500' })
  const retry: string[] = []
  subscribeSmaHistory(source, { market: 'JP', ticker: 'BBBB' }, (state) => retry.push(state.status))
  assert.deepEqual(retry, ['loading'], 'errors are not cached')

  const none: SmaDynamicsLoadState[] = []
  subscribeSmaHistory(null, { market: 'JP', ticker: 'CCCC' }, (state) => none.push(state))
  assert.equal(none[0].status, 'unconnected', 'no adapter: explicit not-connected state')
  clearSmaHistoryCache()
}

// ---------------------------------------------------------------------------
// Rendered states
const BANNED = /買い|売り|予測|予想|確率|勝率|強さ|スコア|シグナル|推奨|forecast|predict|probabilit|\bbuy\b|\bsell\b|\bscore\b|\bML\b|機械学習/i
const visibleText = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
const assertNeutral = (markup: string, label: string) => assert.doesNotMatch(visibleText(markup).replace(SMA_DYNAMICS_PREMISE, ''), BANNED, `${label}: neutral copy`)
const dataSource = { label: 'テスト', priceBasis: '合成データ' }

function render(load: SmaDynamicsLoadState, options: { market?: 'JP' | 'US'; analysisDate?: string | null; settings?: Partial<SmaDynamicsSettings> } = {}) {
  return renderToStaticMarkup(createElement(SmaDynamicsView, {
    security: { market: options.market ?? 'JP', ticker: 'FXJ1', name: '合成 上昇基調' },
    analysisDate: options.analysisDate ?? null,
    load,
    dataSource,
    initialSettings: { ...SMA_DYNAMICS_DEFAULT_SETTINGS, ...options.settings },
  }))
}
function fixtureLoad(id: string) {
  const fixture = findSmaDynamicsFixture(id)
  assert.ok(fixture, id)
  return { fixture, load: { status: 'ready', rows: fixture.rows } as SmaDynamicsLoadState }
}
const disabledCount = (markup: string) => (markup.match(/disabled=""/g) ?? []).length
const CONTROL_BUTTONS = SMA_LAB_TIMEFRAMES.length + SMA_LAB_PERIODS.length + 8 + 6 + 3 + 3 + 2 + 2 // timeframe + SMA + range + 5 quick horizons + more-horizon select + purposes + chart focus + compare toggles (Phase 2.1) + custom period input and its add button

{
  const loading = render({ status: 'loading' })
  for (const copy of [SMA_DYNAMICS_TITLE, SMA_MODE_SUBTITLE.freeze, SMA_DYNAMICS_PREMISE, '価格履歴を読み込み中', 'JP FXJ1 合成 上昇基調']) assert.ok(loading.includes(copy), `loading: ${copy}`)
  assert.match(loading, /aria-busy="true"/)
  assert.equal(disabledCount(loading), CONTROL_BUTTONS, 'loading: controls disabled')
  assertNeutral(loading, 'loading')

  const error = render({ status: 'error', message: 'HTTP 500' })
  assert.ok(error.includes('価格履歴を取得できませんでした (HTTP 500)'))
  assert.doesNotMatch(error, /data-sma-dynamics-table|data-sma-dynamics-chart/)
  assert.equal(disabledCount(error), CONTROL_BUTTONS)

  const unconnected = render({ status: 'unconnected', message: 'この画面では価格履歴に接続していません (実データ未接続)。' })
  assert.ok(unconnected.includes('実データ未接続'))
  assert.doesNotMatch(unconnected, /data-sma-dynamics-chart/)

  const { load: risingLoad } = fixtureLoad('jp-rising')
  const markup = render(risingLoad)
  const compareGroup = markup.slice(markup.indexOf('data-sma-dynamics-compare'), markup.indexOf('</div>', markup.indexOf('data-sma-dynamics-compare')))
  assert.equal(disabledCount(compareGroup), 2, 'Phase 2: scenario/solver comparison toggles wait for data')
  assert.equal(disabledCount(markup), 2, 'controls enabled once data is available')
  assert.match(markup, /data-section="SMA dynamics"/)
  assert.match(markup, /<h2 id="[^"]+-title"[^>]*>SMA Dynamics Lab<\/h2>/)
  assert.match(markup, /aria-pressed="true"[^>]*>1D</, 'default 1D')
  for (const label of ['2D', '3D', '5D', '1W', '2W', '1M', '3M']) assert.match(markup, new RegExp(`aria-pressed="false"[^>]*>${label}<`))
  assert.match(markup, /aria-pressed="true"[^>]*>3か月</, 'beginner default display range 3 months')
  for (const label of ['1週間', '2週間', '1か月', '6か月', '1年', '3年', '全期間']) assert.match(markup, new RegExp(`aria-pressed="false"[^>]*>${label}<`))
  assert.match(markup, /aria-pressed="true"[^>]*>5本</, 'beginner default horizon 5 bars')
  for (const label of ['1本', '3本', '10本', '20本']) assert.match(markup, new RegExp(`aria-pressed="false"[^>]*>${label}<`))
  // Phase 2.2: Freeze quick horizons are exactly 1/3/5/10/20; arbitrary 1..20 (+ daily 60) live in the "more" select.
  const freezeHorizons = markup.slice(markup.indexOf('何本先まで見る？'), markup.indexOf('data-sma-horizon-select') + 600)
  assert.equal((freezeHorizons.match(/aria-pressed="(?:true|false)"[^>]*>\d+本</g) ?? []).length, 5, 'Freeze: 5 quick horizon buttons')
  assert.ok(freezeHorizons.includes('data-sma-horizon-select'), 'Freeze: more-horizon select present')
  const moreSelectMarkup = markup.slice(markup.indexOf('data-sma-horizon-select'), markup.indexOf('</select>', markup.indexOf('data-sma-horizon-select')))
  for (const n of [2, 4, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 60]) assert.match(moreSelectMarkup, new RegExp(`<option value="${n}">${n}本</option>`), `Freeze 1D: arbitrary ${n} selectable`)
  for (const tfId of ['2D', '3D', '5D', '1W', '2W', '1M', '3M'] as const) {
    const tfMarkup = render(risingLoad, { settings: { timeframe: tfId, horizon: 5 } })
    const select = tfMarkup.slice(tfMarkup.indexOf('data-sma-horizon-select'), tfMarkup.indexOf('</select>', tfMarkup.indexOf('data-sma-horizon-select')))
    for (const n of [2, 4, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19]) assert.match(select, new RegExp(`<option value="${n}">${n}本</option>`), `${tfId}: Freeze arbitrary ${n} selectable`)
    assert.doesNotMatch(select, /<option value="60">/, `${tfId}: 60 stays daily-only`)
    for (const n of [1, 3, 5, 10, 20]) assert.match(tfMarkup, new RegExp(`aria-pressed="(?:true|false)"[^>]*>${n}本<`), `${tfId}: quick ${n}`)
  }
  // Scenario shares the same horizon step.
  const scenarioMarkup = render(risingLoad, { settings: { analysis: 'scenario' } })
  assert.equal(((scenarioMarkup.slice(scenarioMarkup.indexOf('何本先まで見る？'), scenarioMarkup.indexOf('data-sma-horizon-select')).match(/aria-pressed="(?:true|false)"[^>]*>\d+本</g)) ?? []).length, 5, 'Scenario: 5 quick horizon buttons')
  assert.match(scenarioMarkup, /<option value="7">7本<\/option>/, 'Scenario: arbitrary 7 selectable')
  assert.match(scenarioMarkup, /<option value="60">60本<\/option>/, 'Scenario 1D: 60 kept')
  assert.ok(markup.includes('5本 = 5営業日'), 'horizon unit stated')
  for (const period of SMA_LAB_PERIODS) {
    const pressed = [5, 25, 75].includes(period)
    assert.match(markup, new RegExp(`<button type="button" aria-pressed="${pressed}"[^>]*data-period="${period}"`), `SMA${period} chip ${pressed ? 'on' : 'off'}`)
  }
  for (const label of ['過去＋将来', '過去を拡大', '将来を拡大', '縮小 (−)', '拡大 (+)', '表示範囲をリセット', '最大化']) assert.ok(markup.includes(label), `chart control ${label}`)
  // Phase 2.1: purpose-first guided panel; internal mode ids stay A/B/C-independent.
  for (const label of ['株価が変わらなかったら？', '株価を自由に動かしてみる', 'SMAの向きを調べる', '何を調べますか？', '詳細設定', 'もっと選ぶ']) assert.ok(markup.includes(label), `guided panel: ${label}`)
  assert.doesNotMatch(visibleText(markup), /\bA 価格固定|\bB 価格シナリオ|\bC SMA逆算/, 'no user-facing A/B/C labels')
  assert.match(markup, /data-mode="freeze"[^>]*>|aria-pressed="true"[^>]*data-mode="freeze"/, 'internal mode ids unchanged')
  assert.match(markup, /data-sma-conclusion-mode="freeze"/, 'plain-language conclusion rendered')
  assert.match(markup, /data-sma-dynamics-chart="true"/)
  assert.ok(markup.includes('チャートを準備中'), 'library loads client-side')
  assert.match(markup, /data-sma-dynamics-future-region="true"/)
  assert.match(markup, /data-sma-dynamics-boundary="true"/)
  assert.ok(markup.includes('実線: 実績SMA (確定足の終値)') && markup.includes('点線: 価格固定を仮定したSMA') && markup.includes('破線: 仮定した将来終値'), 'legend explains actual vs assumption')
  assert.match(markup, /data-sma-dynamics-readout="true"/)
  assert.ok(markup.includes('>実績<'), 'readout chip marks actual data')
  assert.match(markup, /<table[^>]*data-sma-dynamics-table/)
  assert.ok(markup.includes('T+5 (仮定)'))
  assert.match(markup, /data-sma-dynamics-future-values="true"/)
  assert.match(markup, /data-sma-dynamics-source="true"/)
  assert.ok(markup.includes('東証カレンダー'))
  assert.doesNotMatch(markup, /data-sma-dynamics-issues|data-sma-dynamics-few-bars/)
  assert.equal((markup.match(/aria-live=/g) ?? []).length, 0, 'no chatty live regions')
  assertNeutral(markup, 'jp-rising')

  const { load: usLoad } = fixtureLoad('us-falling')
  const weekly = render(usLoad, { market: 'US', settings: { timeframe: '1W', horizon: 5 } })
  assert.ok(weekly.includes('>未確定足<'), 'forming bar labelled')
  assert.ok(weekly.includes('暫定SMA'), 'provisional SMA labelled separately')
  assert.match(weekly, /title="未確定足の現在値を含む参考値">暫定</, 'separate provisional column')
  assert.ok(weekly.includes('5本 = 週足×5（基準日の後 20営業日・現在の未確定足を含む）'))
  assert.ok(weekly.includes('米国取引所カレンダー'))
  assert.match(weekly, /基準日 <b[^>]*>2026-11-25<\/b>/)
  assertNeutral(weekly, 'us-falling 1W')

  const quarterly = render(risingLoad, { settings: { timeframe: '3M', range: '3m', horizon: 5 } })
  assert.match(quarterly, /data-sma-dynamics-few-bars="true"/)
  assert.ok(quarterly.includes('表示期間「3か月」に含まれる四半期足は 2本です。時間軸は変更していません。'))
  assert.match(quarterly, /aria-pressed="true"[^>]*>3M</, 'timeframe untouched')

  const { load: longLoad } = fixtureLoad('jp-long-history')
  const fiveYearSolver = render(longLoad, { settings: { timeframe: '5Y', horizon: 8, analysis: 'solver' } })
  const solverTiming = fiveYearSolver.slice(fiveYearSolver.indexOf('data-sma-solver-timing'), fiveYearSolver.indexOf('data-sma-timing-caption'))
  assert.doesNotMatch(solverTiming, /data-timing-k="(?:10|20)"/, '5Y solver does not offer bars beyond its 8-bar projection limit')
  assert.match(solverTiming, /<option value="8">/, '5Y solver keeps its final supported bar selectable')

  const { load: shortLoad } = fixtureLoad('jp-short-history')
  const short = render(shortLoad, { settings: { periods: [5, 200, 300] } })
  assert.ok(short.includes('履歴不足: 日足あと20本 (180/200)'))
  assert.ok(short.includes('履歴不足: 日足あと120本 (180/300)'))
  assert.match(short, /data-sma-dynamics-period-notes="true"/)

  const { load: invalidLoad } = fixtureLoad('jp-invalid-data')
  const invalid = render(invalidLoad)
  assert.match(invalid, /role="status"[^>]*data-sma-dynamics-issues/)
  for (const copy of ['同じ日付の重複行', '終値が0以下の日', '始値・高値・安値が不正な日']) assert.ok(invalid.includes(copy), copy)

  const { load: anchorLoad } = fixtureLoad('jp-anchor-invalid')
  const unavailable = render(anchorLoad)
  assert.ok(unavailable.includes(describeSmaLabUnavailable('anchor_invalid', '2026-10-16')))
  assert.doesNotMatch(unavailable, /data-sma-dynamics-table/)

  const { fixture: pit, load: pitLoad } = fixtureLoad('jp-pit-boundary')
  const pitMarkup = render(pitLoad, { analysisDate: pit.analysisDate })
  assert.match(pitMarkup, /基準日 <b[^>]*>2026-06-30<\/b>/)
  assert.ok(pitMarkup.includes('分析基準日 2026-06-30 より後の価格は使用しません'))

  const empty = render({ status: 'ready', rows: [] })
  assert.ok(empty.includes(describeSmaLabUnavailable('no_rows', null)))
}

// Stock-detail launcher: collapsed by default, nothing loaded until opened.
{
  const launcher = renderToStaticMarkup(createElement(SmaDynamicsSection, { market: 'US', ticker: 'AAPL', name: 'Apple Inc.', analysisDate: null }))
  assert.match(launcher, /data-sma-dynamics-launcher="true"/)
  assert.match(launcher, /aria-label="SMA Dynamics Lab US AAPL Apple Inc\."/, 'identity in the launcher')
  assert.ok(launcher.includes('開く') && launcher.includes('最大化で開く'))
  assert.doesNotMatch(launcher, /data-sma-dynamics-controls/, 'lab body not mounted (no history request) until opened')
  const opened = renderToStaticMarkup(createElement(SmaDynamicsSection, { market: 'JP', ticker: '7203', name: null, analysisDate: null, source: null, defaultOpen: true }))
  assert.match(opened, /data-sma-dynamics-controls/)
  assert.ok(opened.includes('JP 7203'))
  assert.equal(STOCK_HISTORY_API_SOURCE.id, 'stock-history-api')
  assert.match(STOCK_HISTORY_API_SOURCE.priceBasis('US'), /メインチャートと同じ/)
}

// ---------------------------------------------------------------------------
// Dev-only preview: fixtures only, 404 in production and share mode, fixtures in a collapsed panel.
{
  const page = read('app/dev/sma-dynamics/page.tsx')
  assert.match(page, /if \(process\.env\.NODE_ENV === 'production' \|\| process\.env\.STOCKBOARD_SHARE_MODE === '1'\) notFound\(\)/)
  assert.match(page, /robots: \{ index: false, follow: false \}/)
  const preview = read('app/dev/sma-dynamics/SmaDynamicsPreviewClient.tsx')
  assert.doesNotMatch(preview, /fetch\(|\/api\/|STOCK_HISTORY_API_SOURCE/, 'preview never touches the API adapter')
  assert.match(preview, /source=\{FIXTURE_SOURCES\[mode\]\}/, 'real Section with an injected fixture adapter')
  const panel = preview.slice(preview.indexOf('<details'), preview.indexOf('</details>'))
  assert.match(panel, /data-preview-developer-panel/)
  assert.match(panel, /<select/, 'fixture selector lives in the developer panel')
  assert.equal((preview.match(/<select/g) ?? []).length, 1, 'no fixture selector outside the panel')
  assert.match(panel, /<select\s+aria-label="Fixture[^"]+"/, 'fixture selector has an accessible name')
  assert.match(preview, /<details className=[^>]*data-preview-developer-panel>/, 'collapsed by default (no open attribute)')

  const query = parsePreviewQuery('?fixture=us-falling&tf=1W&range=3y&horizon=10&focus=future&sma=5,13,999&max=1&mode=error')
  assert.deepEqual(query, {
    fixtureId: 'us-falling',
    mode: 'error',
    maximized: true,
    scenarioId: null,
    linkIntent: null,
    settings: { timeframe: '1W', periods: [5, 13], range: '3y', horizon: 10, focus: 'future', analysis: 'freeze', compare: ['freeze'] },
  })
  assert.equal(parsePreviewQuery('?lab=solver').settings.analysis, 'solver', 'Phase 2 deep link to a mode')
  assert.equal(parsePreviewQuery('?lab=nope').settings.analysis, 'freeze')
  const fallback = parsePreviewQuery('?tf=9X&horizon=60')
  assert.equal(fallback.settings.timeframe, '1D')
  assert.equal(fallback.settings.horizon, 60)
  assert.equal(parsePreviewQuery('?tf=1W&horizon=60').settings.horizon, 5, 'invalid horizon for the timeframe falls back')

  const statusBar = read('components/layout/DataStatusBar.tsx')
  assert.match(statusBar, /if \(fixtureOnlyPreview\) return[\s\S]+void load\(\)/, 'dev preview exits before status polling')
  assert.match(read('components/layout/Header.tsx'), /if \(fixtureOnlyPreview\) return null/)
  assert.match(read('components/assistant/AssistantDrawer.tsx'), /isSmaDynamicsFixturePreviewPath\(pathname\)/)
  for (const file of ['components/layout/Header.tsx', 'components/layout/DataStatusBar.tsx']) {
    assert.match(read(file), /fixtureOnlyPreview = isSmaDynamicsFixturePreviewPath\(pathname\)/, `${file} uses the exact-path helper`)
  }
  // The bypass is exact-path, non-production and never in share mode; other /dev pages keep the guard.
  const proxy = read('proxy.ts')
  const devBypass = proxy.indexOf("isSmaDynamicsFixturePreviewPath(pathname) && process.env.NODE_ENV !== 'production' && !isShareMode()")
  assert.ok(devBypass >= 0 && devBypass < proxy.indexOf('anyStorageFatal() || anyStorageUncertain()'), 'dev preview bypasses storage state before latch checks')
  assert.doesNotMatch(proxy, /startsWith\('\/dev\/'\)/, 'no blanket /dev/ bypass')
  for (const file of ['components/layout/Header.tsx', 'components/layout/DataStatusBar.tsx', 'components/assistant/AssistantDrawer.tsx']) {
    assert.doesNotMatch(read(file), /startsWith\('\/dev\/'\)/, `${file} has no blanket /dev/ exemption`)
  }
  assert.equal(isSmaDynamicsFixturePreviewPath('/dev/sma-dynamics'), true)
  assert.equal(isSmaDynamicsFixturePreviewPath('/dev/sma-dynamics/'), true)
  for (const other of ['/dev/six-stage-event-paths', '/dev/two-year-chart', '/dev/sma-dynamics-x', '/dev/sma-dynamics/extra', '/stock/7203', '', null, undefined]) {
    assert.equal(isSmaDynamicsFixturePreviewPath(other), false, String(other))
  }
}

historyContract().then(
  () => console.log('test-sma-dynamics-ui: ok'),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
