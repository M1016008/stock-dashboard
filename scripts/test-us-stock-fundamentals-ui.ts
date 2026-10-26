import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)

async function source(path: string) {
  return readFile(new URL(path, root), 'utf8')
}

async function main() {
  const client = await source('app/us/stock/[ticker]/UsStockDetailClient.tsx')
  const workspace = await source('components/us/stock-detail/UsFundamentalsWorkspace.tsx')

  // ---- Top-level tab wiring ----
  assert.match(client, /type UsStockDetailTab = 'overview' \| 'chart' \| 'fundamental' \| 'scenario' \| 'ml'/)
  for (const label of ['概要', 'チャート・6ステージ', 'ファンダメンタル', 'シナリオ', '類似・ML']) {
    assert.match(client, new RegExp(`label: '${label}'`), `top-level tab ${label} must exist`)
  }
  const tabOrder = ['overview', 'chart', 'fundamental', 'scenario', 'ml'].map((id) => client.indexOf(`{ id: '${id}' as const`))
  assert.ok(tabOrder.every((index, i) => index > 0 && (i === 0 || index > tabOrder[i - 1])), 'tab order must match JP: 概要 → チャート → ファンダメンタル → シナリオ → 類似・ML')
  assert.match(client, /analysisParamsReady && activeTab === 'fundamental' && \(\s*<UsFundamentalsWorkspace/)
  assert.match(client, /<UsFundamentalsWorkspace[\s\S]*?analysisDate=\{analysisDate\}[\s\S]*?view=\{fundamentalView\}[\s\S]*?onViewChange=\{selectFundamentalView\}/)
  assert.match(client, /hash === 'fundamental'/)
  assert.match(client, /hash === 'performance' \|\| hash === 'financial' \|\| hash === 'valuation' \|\| hash === 'returns'/)
  assert.match(client, /url\.hash = view === 'summary' \? 'fundamental' : US_FUNDAMENTAL_HASHES\[view\]/)
  // 既存タブの挙動は維持: モメンタムは概要・チャートでのみ取得
  assert.match(client, /analysisParamsReady && \(activeTab === 'overview' \|\| activeTab === 'chart'\)/)
  assert.equal((client.match(/<UsFundamentalsWorkspace/g) ?? []).length, 1, 'workspace must be mounted once')

  // ---- Fetch contract: same-origin, as_of in historical mode, single request path ----
  assert.match(workspace, /`\/api\/us\/fundamentals\/\$\{encodeURIComponent\(ticker\)\}/)
  assert.match(workspace, /analysisDate \? `\?as_of=\$\{encodeURIComponent\(analysisDate\)\}` : ''/)
  for (const text of [client, workspace]) {
    assert.doesNotMatch(text, /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/, 'no hardcoded absolute localhost URL')
    assert.doesNotMatch(text, /fetch\(\s*['"`]https?:/, 'fetch must stay same-origin')
  }
  assert.equal((workspace.match(/\bfetch\(/g) ?? []).length, 1, 'exactly one fetch call site')
  assert.match(workspace, /const inFlight = new Map/)
  assert.match(workspace, /inFlight\.delete\(url\)/)
  assert.match(workspace, /contractVersion === 'us-fundamentals-v1'/)

  // ---- Five subviews, accessible tabs ----
  const views = [
    ["'summary'", 'サマリー'],
    ["'performance'", '業績'],
    ["'financial'", '財務'],
    ["'valuation'", 'バリュエーション'],
    ["'returns'", '株主還元'],
  ]
  let last = -1
  for (const [id, label] of views) {
    const index = workspace.indexOf(`{ id: ${id}, label: '${label}'`)
    assert.ok(index > last, `subview ${label} must be declared in order`)
    last = index
  }
  for (const view of ['SummaryView', 'PerformanceView', 'FinancialView', 'ValuationView', 'ReturnsView']) {
    assert.match(workspace, new RegExp(`<${view} model=\\{model\\}`), `${view} must render`)
  }
  assert.match(workspace, /role="tablist"/)
  assert.match(workspace, /role="tab"/)
  assert.match(workspace, /aria-selected=\{active === id\}/)
  assert.match(workspace, /role="tabpanel"/)
  assert.match(workspace, /event\.key === 'ArrowRight'/)
  assert.match(workspace, /focus-visible:outline/)
  assert.match(workspace, /<caption className="sr-only">/)

  // ---- Forecast / peer unavailable disclosure, no implied judgment ----
  assert.match(workspace, /model\.coverage\.forecastReason/)
  assert.match(workspace, /label: '会社予想', value: '未提供'/)
  assert.match(workspace, /valuation\.peerReason/)
  assert.match(workspace, /label: '同業比較', value: '未提供'/)
  assert.match(workspace, /比較基準がないため、倍率の高低は評価しません。/)
  assert.doesNotMatch(workspace, /割安|割高/, 'no cheap/expensive verdict without a comparison basis')
  assert.doesNotMatch(workspace, /forecast: true|予想FY|今期予想/, 'no forecast slot')
  assert.match(workspace, /実績のみ/)
  assert.doesNotMatch(workspace, /\bgrade\b|ランク|[ABCDS]評価/, 'no fake grades')

  // ---- Missing / N/M / zero semantics ----
  assert.match(workspace, /missing: 'データなし'/)
  assert.match(workspace, /not_meaningful: 'N\/M'/)
  assert.match(workspace, /0は観測値/)
  assert.match(workspace, /model\.coverage\.sourceFacts === 0/)

  // ---- Summary: neutral observed facts, no unsupported value judgment ----
  assert.match(workspace, /title="観測事実"/)
  assert.match(workspace, /title="確認事項"/)
  assert.doesNotMatch(workspace, /強み|弱み|注意点|好調|不調|良好|悪化/, 'sign of a value is an observed fact, not a strength/weakness verdict')
  assert.doesNotMatch(workspace, /strengths|cautions/, 'no strength/caution buckets keyed on sign')
  for (const word of ['増収', '減収', '営業黒字', '営業赤字', '支払い記録あり', '支払い記録なし']) {
    assert.match(workspace, new RegExp(`'${word}'`), `neutral sign word ${word}`)
  }
  assert.match(workspace, /水準の良し悪しは判定しません。/)
  assert.match(workspace, /byState\('not_meaningful'\)/)
  assert.match(workspace, /byState\('missing'\)/)

  // ---- ROE basis: LTM net income over average opening/closing equity ----
  assert.match(workspace, /basis: 'ROE LTM純利益\/期首・期末平均純資産'/)
  assert.match(workspace, /basis="LTM純利益 ÷ 期首・期末平均純資産"/)
  assert.match(workspace, /期首と期末の純資産の平均/)
  assert.doesNotMatch(workspace, /純利益\s*[÷/]\s*純資産/, 'ROE copy must not describe a point-in-time equity denominator')

  // ---- Dividend history: observed zero vs unconfirmed coverage ----
  assert.match(workspace, /coverage=\{returns\.trailingDividendPerShare\}/, 'history receives the contract coverage state')
  assert.match(workspace, /if \(trailing\.availability !== 'available'\) return 'unconfirmed'/)
  assert.match(workspace, /displayedSign\(trailing\) === 0 \? 'observed_zero'/)
  assert.match(workspace, /state === 'observed_zero'[\s\S]*?支払い記録はありません。0は観測値です。/)
  assert.match(workspace, /state === 'unconfirmed'[\s\S]*?配当の有無は未確認です。/)
  assert.doesNotMatch(workspace, /history\.length === 0\) \{\s*return <EmptyLine>/, 'empty history must branch on coverage before claiming no dividends')
  // React は契約値を再計算しない(描画スケール以外の算術を .value に掛けない)
  assert.doesNotMatch(workspace, /\.value\s*[*/+-]\s/, 'no arithmetic on contract values')

  // ---- Section coverage: neutral, never read as whole-board READY ----
  assert.match(workspace, /model\.coverage\.sections\[key\]/)
  for (const key of ['performance', 'financialPosition', 'cashFlow', 'capital', 'shareholderReturn']) {
    assert.match(workspace, new RegExp(`key: '${key}'`), `section coverage row ${key}`)
  }
  assert.match(workspace, /区分別の取得状況/)
  assert.match(workspace, /section\.available\}\/\{section\.expected/)
  assert.match(workspace, /欠損 \$\{missingLabels\.length\}/)
  assert.match(workspace, /READY: '取得済み'[\s\S]*?PARTIAL: '一部欠損'[\s\S]*?UNAVAILABLE: '未取得'/)
  assert.doesNotMatch(workspace, /主要fact取得済み/, 'overall READY must not read as a blanket completeness claim')
  assert.match(workspace, /READY: \{ text: '全区分取得済み'/)

  // ---- Financial view: extended balance sheet / cash flow / capital, computed values only ----
  for (const field of [
    'totalLiabilities', 'currentAssets', 'currentLiabilities', 'totalDebt', 'currentRatio', 'debtToEquity',
    'investingCashFlow', 'financingCashFlow', 'capitalExpenditure',
  ]) {
    assert.match(workspace, new RegExp(`financials\\.${field}\\b`), `financial view must render ${field}`)
  }
  for (const field of ['sharesOutstanding', 'weightedAverageShares', 'dilutedEps']) {
    assert.match(workspace, new RegExp(`capital\\.${field}\\b`), `capital block must render ${field}`)
  }
  assert.match(workspace, /id="us-fundamental-capital"/)
  assert.match(workspace, /title="株式・資本"/)
  assert.doesNotMatch(workspace, /financials\.currentAssets\.value|financials\.currentLiabilities\.value|financials\.totalDebt\.value/, 'ratios come from the contract, not recomputed in React')
  assert.doesNotMatch(workspace, /GICS|コンセンサス予想|業界平均/, 'no GICS or forecast/peer implication')

  // ---- Responsive guards / visual constraints ----
  assert.ok((workspace.match(/min-w-0/g) ?? []).length >= 15, 'min-w-0 guards on flex/grid children')
  assert.match(workspace, /overflow-x-auto overscroll-x-contain/, 'wide FY table scrolls inside its own container')
  assert.match(workspace, /grid-cols-2/, 'mobile metric grid uses two columns')
  assert.doesNotMatch(workspace, /\bw-\[(?:[4-9]\d{2}|\d{4,})px\]|min-w-\[(?:39[1-9]|[4-9]\d{2}|\d{4,})px\]/, 'no fixed width wider than 390px outside scroll containers')
  assert.doesNotMatch(workspace, /<svg/, 'use lucide icons, no custom SVG')
  assert.doesNotMatch(workspace, /gradient/i, 'no gradients')
  assert.doesNotMatch(workspace, /purple|violet/, 'no purple dominance')
  assert.match(workspace, /from 'lucide-react'/)

  // ---- Pure helper behaviour ----
  const { usFundamentalsUrl, US_FUNDAMENTAL_VIEWS } = await import('../components/us/stock-detail/UsFundamentalsWorkspace')
  assert.equal(usFundamentalsUrl('AAPL', null), '/api/us/fundamentals/AAPL')
  assert.equal(usFundamentalsUrl('BRK.B', '2024-03-29'), '/api/us/fundamentals/BRK.B?as_of=2024-03-29')
  assert.deepEqual(US_FUNDAMENTAL_VIEWS.map((view) => view.label), ['サマリー', '業績', '財務', 'バリュエーション', '株主還元'])

  console.log('US stock fundamentals UI tests: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
