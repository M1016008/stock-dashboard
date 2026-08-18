import assert from 'node:assert/strict'

const baseUrl = process.env.STOCKBOARD_BASE_URL ?? 'http://127.0.0.1:3000'

type Signal = {
  signalKind: 'ma' | 'cluster'
  ticker: string
  period: number | null
  absDistancePct: number
  isApproaching: number | boolean
  approachDirection: 'above' | 'below' | 'none'
  approachSpeedPctPerDay: number
  touchAgeSessions: number | null
  lastCrossDirection: 'up' | 'down' | null
  crossAgeSessions: number | null
  isRapidApproach: number | boolean
  approachScore: number
  marketSegment: string | null
  sector17Name: string | null
  sector33Name: string | null
  marginType: string | null
  majorCategory: string | null
  subIndustry: string | null
  dailyAStage: number | null
  dailyBStage: number | null
  weeklyAStage: number | null
  weeklyBStage: number | null
  monthlyAStage: number | null
  monthlyBStage: number | null
  stageCode: string | null
  currentVolume: number | null
  avgVolume30: number | null
  volumeRatio30: number | null
}

type ListResponse = {
  date: string | null
  period: number | 'all'
  periods: number[]
  rows: Signal[]
  total: number
  contactThreshold: number
  volumeWindow: number
  filterOptions: Record<string, Array<{ value: string; parent: string | null; count: number }>>
}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { cache: 'no-store' })
  assert.equal(response.status, 200, `${path} returned ${response.status}`)
  return response.json() as Promise<T>
}

async function list(query: string): Promise<ListResponse> {
  return json<ListResponse>(`/api/ma25m-monitor?limit=200&${query}`)
}

async function main(): Promise<void> {
  const all = await list('period=all')
  assert.ok(all.date)
  assert.deepEqual(all.periods, [3, 5, 10, 15, 20, 25])
  assert.ok(all.total > 0)
  assert.equal(all.volumeWindow, 30)
  assert.ok(all.filterOptions.marketSegments.length > 0)
  assert.ok(all.filterOptions.sector17.length >= 17)
  assert.ok(all.filterOptions.sector33.length >= 33)
  assert.ok(all.filterOptions.marginTypes.some((option) => option.value === '貸借'))
  assert.ok(all.filterOptions.majorCategories.length > 0)
  assert.ok(all.filterOptions.subIndustries.length > 0)
  assert.ok(all.rows.every((row) => row.stageCode == null || /^\d{6}$/.test(row.stageCode)))
  assert.ok(all.rows.every((row) => row.volumeRatio30 == null || row.avgVolume30 != null && row.avgVolume30 > 0))
  assert.ok(all.rows.every((row) => row.signalKind === 'cluster'
    || row.touchAgeSessions != null && row.touchAgeSessions <= 5
    || row.crossAgeSessions != null && row.crossAgeSessions <= 5
    || row.isApproaching
    || row.isRapidApproach
    || row.absDistancePct <= all.contactThreshold))

  for (const period of all.periods) {
    const response = await list(`period=${period}`)
    assert.equal(response.period, period)
    assert.ok(response.total > 0)
    assert.ok(response.rows.every((row) => row.signalKind === 'ma' && row.period === period))
  }

  const predicates: Array<[string, (row: Signal) => boolean]> = [
    ['approaching', (row) => row.signalKind === 'ma' && Boolean(row.isApproaching)],
    ['approaching_above', (row) => row.signalKind === 'ma' && Boolean(row.isApproaching) && row.approachDirection === 'above'],
    ['approaching_below', (row) => row.signalKind === 'ma' && Boolean(row.isApproaching) && row.approachDirection === 'below'],
    ['contact', (row) => row.signalKind === 'ma' && row.absDistancePct <= 2],
    ['touch_today', (row) => row.signalKind === 'ma' && row.touchAgeSessions === 0],
    ['touch_3', (row) => row.signalKind === 'ma' && row.touchAgeSessions != null && row.touchAgeSessions <= 3],
    ['touch_5', (row) => row.signalKind === 'ma' && row.touchAgeSessions != null && row.touchAgeSessions <= 5],
    ['cross_up', (row) => row.signalKind === 'ma' && row.lastCrossDirection === 'up' && row.crossAgeSessions != null && row.crossAgeSessions <= 5],
    ['cross_down', (row) => row.signalKind === 'ma' && row.lastCrossDirection === 'down' && row.crossAgeSessions != null && row.crossAgeSessions <= 5],
    ['rapid', (row) => row.signalKind === 'ma' && Boolean(row.isRapidApproach)],
    ['cluster', (row) => row.signalKind === 'cluster'],
    ['cluster_approaching', (row) => row.signalKind === 'cluster' && Boolean(row.isApproaching)],
    ['cluster_touch_today', (row) => row.signalKind === 'cluster' && row.touchAgeSessions === 0],
    ['cluster_cross_up', (row) => row.signalKind === 'cluster' && row.lastCrossDirection === 'up' && row.crossAgeSessions != null && row.crossAgeSessions <= 5],
    ['cluster_cross_down', (row) => row.signalKind === 'cluster' && row.lastCrossDirection === 'down' && row.crossAgeSessions != null && row.crossAgeSessions <= 5],
  ]
  for (const [status, predicate] of predicates) {
    const response = await list(`period=all&status=${status}`)
    assert.ok(response.rows.every(predicate), `${status} returned a row outside its contract`)
  }

  const impossibleCluster = await list('period=3&status=cluster')
  assert.equal(impossibleCluster.total, 0)
  const narrowContact = await list('period=all&status=contact&contactPct=1')
  assert.ok(narrowContact.rows.every((row) => row.absDistancePct <= 1))
  const highScore = await list('period=all&minScore=90')
  assert.ok(highScore.rows.every((row) => row.approachScore >= 90))
  const near = await list('period=all&maxDistance=3')
  assert.ok(near.rows.every((row) => row.absDistancePct <= 3))
  const tickerSearch = await list('period=all&q=7003')
  assert.ok(tickerSearch.rows.length > 0)
  assert.ok(tickerSearch.rows.every((row) => row.ticker === '7003'))
  assert.ok(tickerSearch.rows.every((row) => row.stageCode === '435241'))
  // Volume is live market data, so assert the API contract rather than a
  // historical point value that changes after every daily refresh.
  assert.ok(tickerSearch.rows.every((row) => row.currentVolume != null && row.currentVolume >= 0))
  assert.ok(tickerSearch.rows.every((row) => row.avgVolume30 != null && row.avgVolume30 > 0))

  const margin = await list(`period=all&marginType=${encodeURIComponent('貸借')}`)
  assert.ok(margin.total > 0)
  assert.ok(margin.rows.every((row) => row.marginType === '貸借'))
  const liquid = await list('period=all&avgVolumeMin=100000')
  assert.ok(liquid.total > 0)
  assert.ok(liquid.rows.every((row) => row.avgVolume30 != null && row.avgVolume30 >= 100_000))
  const activeVolume = await list('period=all&volumeRatioMin=1')
  assert.ok(activeVolume.total > 0)
  assert.ok(activeVolume.rows.every((row) => row.volumeRatio30 != null && row.volumeRatio30 >= 1))
  const dailyStage = await list('period=all&dailyA=4')
  assert.ok(dailyStage.total > 0)
  assert.ok(dailyStage.rows.every((row) => row.dailyAStage === 4))
  const machinery = await list(`period=all&sector33=${encodeURIComponent('機械')}`)
  assert.ok(machinery.total > 0)
  assert.ok(machinery.rows.every((row) => row.sector33Name === '機械'))

  const detail = await json<{
    ticker: string
    date: string | null
    monitors: Array<{ period: number }>
    clusters: unknown[]
    history: unknown[]
  }>('/api/ma25m-monitor/7003?limit=not-a-number')
  assert.equal(detail.ticker, '7003')
  assert.ok(detail.date)
  assert.deepEqual(detail.monitors.map((row) => row.period), [3, 5, 10, 15, 20, 25])
  assert.ok(Array.isArray(detail.clusters))
  assert.ok(detail.history.length <= 30)

  console.log('monthly MA API contract tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
