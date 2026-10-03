// Design Lab 専用の静的Fixture。API・DB・計算ロジックには触れない。
// 型だけ Production Contract に合わせ、値は決定的な擬似乱数で生成する。

export type LabState = 'initial' | 'results' | 'loading' | 'empty' | 'error'
export const LAB_STATES: readonly LabState[] = ['initial', 'results', 'loading', 'empty', 'error']

export type LabStatus = 'IN_ZONE' | 'NEAR' | 'APPROACHING' | 'BELOW_ZONE'

export interface LabRow {
  ticker: string
  companyName: string
  market: string
  price: number
  status: LabStatus
  score: number
  breakdown: { proximity: number; approach: number; maTrend: number; stageStructure: number; liquidity: number }
  zoneDistancePct: number
  ma1DistancePct: number
  ma2DistancePct: number
  averageTradingValue: number
  averageVolume: number
  stages: Array<number | null>
  stale: { priceDate: string; sessions: number } | null
  chart: { close: number[]; ma1: number[]; ma2: number[] }
  watched: boolean
}

export const LAB_META = {
  latestAsOf: '2026-10-02',
  requestedAsOf: '2026-09-27',
  requestedAsOfLabel: '2026-09-27（日）',
  resolvedAsOf: '2026-09-25',
  resolvedAsOfLabel: '2026-09-25（金）',
  timeframe: '月足',
  ma1: 20,
  ma2: 25,
  maxDistance: 5,
  nearDistance: 2,
  pitUniverseCount: 3894,
  currentPriceCount: 3811,
  staleAcceptedCount: 63,
  triggerEvaluatedCount: 3874,
  triggerMatchedCount: 152,
  matchedCount: 137,
  returnedCount: 100,
  page: 1,
  pageSize: 100,
  totalPages: 2,
  statusCounts: { ALL: 137, APPROACHING: 66, NEAR: 38, IN_ZONE: 25, BELOW_ZONE: 8 },
} as const

export const LAB_CRITERIA_CHIPS: Array<{ label: string; fixed?: boolean }> = [
  { label: 'Trigger距離 5%' },
  { label: 'Near 2%' },
  { label: '2本とも上向き', fixed: true },
  { label: '上から接近', fixed: true },
  { label: '市場 プライム / スタンダード' },
  { label: '売買代金 1億円以上' },
  { label: 'Zone下抜け 3%まで' },
  { label: 'Stage条件 2軸' },
]

export const LAB_DEFAULT_CHIPS: Array<{ label: string; fixed?: boolean }> = [
  { label: 'Trigger距離 5%' },
  { label: 'Near 2%' },
  { label: '2本とも上向き', fixed: true },
  { label: '上から接近', fixed: true },
  { label: '全市場' },
]

export const LAB_SAVED_TRIGGERS = [
  { id: 's1', name: '押し目 20/25 月足', timeframe: '月足', note: '最終使用 昨日' },
  { id: 's2', name: '流動性重視 20/25 月足', timeframe: '月足', note: '最終使用 3日前' },
  { id: 's3', name: '短期 10/20 2週足', timeframe: '2週足', note: '最終使用 先週' },
]

export const LAB_MARKETS = [
  { label: 'プライム', count: 1612, selected: true },
  { label: 'スタンダード', count: 1594, selected: true },
  { label: 'グロース', count: 612, selected: false },
  { label: '市場区分なし', count: 76, selected: false },
]

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NAME_HEAD = ['東洋', '日本', '大和', '三友', '関東', '北陸', '中部', '西日本', '太平洋', '明星', '新栄', '丸山', '光洋', '富士見', '千代田', '昭和', '平成', '旭', '東海', '近畿']
const NAME_MID = ['精密', '電子', '化学', '製鋼', '食品', '運輸', '建設', '機械', '薬品', '通信', '商事', '不動産', '繊維', '紙パルプ', '情報', '計測', '工業', '素材']
const NAME_TAIL = ['工業', 'ホールディングス', '', '製作所', 'テクノ', 'システムズ', '']
const MARKETS = ['プライム', 'プライム', 'スタンダード', 'スタンダード', 'グロース']

function round(value: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

function sma(values: number[], window: number): number[] {
  return values.map((_, index) => {
    const from = Math.max(0, index - window + 1)
    const slice = values.slice(from, index + 1)
    return slice.reduce((sum, v) => sum + v, 0) / slice.length
  })
}

export function buildLabRows(count = 100): LabRow[] {
  const rand = mulberry32(20260927)
  const statuses: LabStatus[] = []
  const plan: Array<[LabStatus, number]> = [['APPROACHING', 48], ['NEAR', 27], ['IN_ZONE', 18], ['BELOW_ZONE', 7]]
  for (const [status, n] of plan) for (let i = 0; i < n; i += 1) statuses.push(status)
  for (let i = statuses.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[statuses[i], statuses[j]] = [statuses[j], statuses[i]]
  }
  const usedTickers = new Set<string>()
  const rows: LabRow[] = []
  for (let index = 0; index < count; index += 1) {
    const status = statuses[index % statuses.length]
    let ticker = String(1300 + Math.floor(rand() * 8600))
    while (usedTickers.has(ticker)) ticker = String(1300 + Math.floor(rand() * 8600))
    usedTickers.add(ticker)
    const companyName = `${NAME_HEAD[Math.floor(rand() * NAME_HEAD.length)]}${NAME_MID[Math.floor(rand() * NAME_MID.length)]}${NAME_TAIL[Math.floor(rand() * NAME_TAIL.length)]}`
    const spread = 2 + rand() * 7
    let zone: number
    let ma1: number
    let ma2: number
    if (status === 'APPROACHING') {
      zone = 2.05 + rand() * 2.9
      ma1 = zone
      ma2 = (1 + zone / 100) * (1 + spread / 100) * 100 - 100
    } else if (status === 'NEAR') {
      zone = 0.15 + rand() * 1.8
      ma1 = zone
      ma2 = (1 + zone / 100) * (1 + spread / 100) * 100 - 100
    } else if (status === 'IN_ZONE') {
      zone = 0
      ma1 = -rand() * spread * 0.9 - 0.05
      ma2 = (1 + ma1 / 100) * (1 + spread / 100) * 100 - 100
    } else {
      const below = 0.2 + rand() * 2.7
      zone = -below
      ma2 = -below
      ma1 = -below - spread * (0.6 + rand() * 0.4)
    }
    const price = Math.round((300 + rand() ** 2 * 12000) / 5) * 5
    const closeness = status === 'IN_ZONE' ? 1 : status === 'NEAR' ? 0.82 - zone * 0.08 : status === 'APPROACHING' ? 0.6 - zone * 0.06 : 0.35
    const stages = Array.from({ length: 6 }, () => (rand() < 0.06 ? null : 1 + Math.floor(rand() * 6)))
    const proximity = round(Math.max(0, closeness) * 30, 1)
    const approach = round(10 + rand() * 15, 1)
    const maTrend = round(12 + rand() * 13, 1)
    const stageStructure = round(6 + rand() * 14, 1)
    const liquidity = round(2 + rand() * 8, 1)
    const total = Math.min(99, Math.round(proximity + approach + maTrend + stageStructure + liquidity))
    const stale = rand() < 0.05 ? { priceDate: '2026-09-24', sessions: 1 + Math.floor(rand() * 2) } : null
    const base = price * (0.8 + rand() * 0.1)
    const closes: number[] = []
    let value = base
    for (let k = 0; k < 45; k += 1) {
      const drift = k < 32 ? 0.012 : -0.016
      value *= 1 + drift + (rand() - 0.5) * 0.04
      closes.push(value)
    }
    rows.push({
      ticker,
      companyName,
      market: MARKETS[Math.floor(rand() * MARKETS.length)],
      price,
      status,
      score: total,
      breakdown: { proximity, approach, maTrend, stageStructure, liquidity },
      zoneDistancePct: round(zone),
      ma1DistancePct: round(ma1),
      ma2DistancePct: round(ma2),
      averageTradingValue: Math.round((1.2 + rand() ** 2 * 80) * 1e8),
      averageVolume: Math.round((40 + rand() ** 2 * 3000) * 1000),
      stages,
      stale,
      chart: { close: closes.slice(9).map((v) => round(v, 1)), ma1: sma(closes, 5).slice(9).map((v) => round(v, 1)), ma2: sma(closes, 9).slice(9).map((v) => round(v, 1)) },
      watched: rand() < 0.08,
    })
  }
  return rows.sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker))
}

export function formatPercent(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

export function formatAmount(value: number): string {
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(1)}億`
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(1)}万`
  return value.toLocaleString('ja-JP')
}

export const STATUS_LABEL: Record<LabStatus, string> = {
  IN_ZONE: 'ゾーン内',
  NEAR: '近接',
  APPROACHING: '接近中',
  BELOW_ZONE: '下方',
}

export const STAGE_AXES = ['日A', '日B', '週A', '週B', '月A', '月B'] as const
