import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, execUsAnalyticsGet, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { analyzePhysicsProfile, type PhysicsStatus } from '@/lib/ml/physics-analysis'
import { normalizeMarket, type MarketCode } from '@/lib/markets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ ticker: string }>
}

type FeatureRow = {
  ticker: string
  date: string
  stageCode: string | null
  featureJson: string
  name: string | null
  marketSegment: string | null
  sector17Name: string | null
  sector33Name: string | null
}

type MomentumRow = {
  date: string
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
}

type PriceRow = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type SnapshotRow = {
  date: string
  ma5: number | null
  ma25: number | null
  ma75: number | null
  ma300: number | null
}

type CalibrationRow = {
  statusLabel: string
  targetDirection: 'up' | 'down' | 'wait'
  horizonDays: number
  sampleCount: number
  hitRate: number | null
  baseRate: number | null
  lift: number | null
  confidenceScore: number | null
  medianReturnPct: number | null
  avgReturnPct: number | null
  avgMaxReturnPct: number | null
  avgMinReturnPct: number | null
  adverseRate: number | null
  evaluationDate: string
}

type CandidateRow = {
  asOfDate: string
  direction: 'up' | 'down' | 'wait'
  horizonDays: number
  rank: number
  candidateScore: number
  modelName: string | null
}

type GetFn = <T = Record<string, unknown>>(sql: string, args?: readonly unknown[]) => Promise<T | undefined>
type AllFn = <T = Record<string, unknown>>(sql: string, args?: readonly unknown[]) => Promise<T[]>

type PlanTone = 'positive' | 'negative' | 'neutral' | 'warning'

type PriceLevel = {
  label: string
  value: number | null
  distancePct: number | null
}

type HorizonPriceLevels = {
  baseDate: string
  close: number
  support: PriceLevel
  resistance: PriceLevel
  breakdown: PriceLevel
}

const PLAN_HORIZONS = [
  { label: '短期', days: 5, description: '数日から1週間程度の反応を見る時間軸' },
  { label: '中期', days: 20, description: '約1か月の方向感と押し目/失速を見る時間軸' },
  { label: '長期', days: 60, description: '約3か月の地合い転換と大きな崩れを見る時間軸' },
] as const

type PlanHorizon = typeof PLAN_HORIZONS[number]

function normalizeTicker(value: string, market: MarketCode): string {
  const ticker = value.trim().toUpperCase()
  return market === 'JP' ? ticker.replace(/\.T$/i, '') : ticker
}

function getReader(market: MarketCode): { get: GetFn; all: AllFn; dbMarket: string; isUsAnalytics: boolean } {
  const isUsAnalytics = market === 'US' && hasUsAnalyticsDb()
  return {
    get: (isUsAnalytics ? execUsAnalyticsGet : execGet) as GetFn,
    all: (isUsAnalytics ? execUsAnalyticsAll : execAll) as AllFn,
    dbMarket: market,
    isUsAnalytics,
  }
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function pct(value: number | null | undefined, digits = 1): string {
  if (!finite(value)) return '-'
  return `${(value * 100).toFixed(digits)}%`
}

function pctRaw(value: number | null | undefined, digits = 1): string {
  if (!finite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function parseAsOfDate(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null
}

function roundPrice(value: number | null | undefined): number | null {
  if (!finite(value)) return null
  if (Math.abs(value) >= 1000) return Math.round(value)
  if (Math.abs(value) >= 100) return Math.round(value * 10) / 10
  return Math.round(value * 100) / 100
}

function priceText(value: number | null | undefined, market: MarketCode): string {
  const rounded = roundPrice(value)
  if (!finite(rounded)) return '未判定'
  const formatted = rounded.toLocaleString(market === 'US' ? 'en-US' : 'ja-JP', {
    maximumFractionDigits: rounded >= 1000 ? 0 : 2,
  })
  return market === 'US' ? `$${formatted}` : `${formatted}円`
}

function distancePct(value: number | null | undefined, base: number): number | null {
  if (!finite(value) || !finite(base) || base === 0) return null
  return ((value - base) / base) * 100
}

function directionLabel(direction: 'up' | 'down' | 'wait' | null | undefined): string {
  if (direction === 'up') return '上昇方向'
  if (direction === 'down') return '下落方向'
  if (direction === 'wait') return '見送り優位'
  return '方向未判定'
}

function confidenceLabel(row: CalibrationRow | null): string {
  const confidence = row?.confidenceScore
  const lift = row?.lift
  if (!finite(confidence) || !finite(lift)) return '検証不足'
  if (confidence >= 62 && lift >= 1.15) return '強め'
  if (confidence >= 52 && lift >= 1.05) return '中程度'
  if (confidence >= 42) return '参考'
  return '弱い'
}

function bestCandidate(candidates: CandidateRow[]): CandidateRow | null {
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) => a.rank - b.rank)[0] ?? null
}

function candidateLine(candidates: CandidateRow[]): string {
  if (candidates.length === 0) return '物理ML上位候補には未掲載'
  return candidates
    .sort((a, b) => a.rank - b.rank)
    .map((row) => `${directionLabel(row.direction)}#${row.rank}`)
    .join(' / ')
}

function makeLevel(label: string, value: number | null | undefined, base: number): PriceLevel {
  return {
    label,
    value: roundPrice(value),
    distancePct: distancePct(value, base),
  }
}

function levelText(level: PriceLevel | null | undefined, market: MarketCode): string {
  if (!level || !finite(level.value)) return '価格未判定'
  const distance = finite(level.distancePct) ? ` / ${pctRaw(level.distancePct)}` : ''
  return `${level.label} ${priceText(level.value, market)}${distance}`
}

function levelPriceText(level: PriceLevel | null | undefined, market: MarketCode): string {
  if (!level || !finite(level.value)) return '価格未判定'
  return `${level.label} ${priceText(level.value, market)}`
}

function compactPriceSummary(levels: HorizonPriceLevels | null, market: MarketCode): string {
  if (!levels) return '価格ライン未判定'
  if (finite(levels.support.value) && finite(levels.breakdown.value) && levels.support.value === levels.breakdown.value) {
    return `支持/崩れ ${priceText(levels.support.value, market)} / 抵抗 ${priceText(levels.resistance.value, market)}`
  }
  return `支持 ${priceText(levels.support.value, market)} / 抵抗 ${priceText(levels.resistance.value, market)} / 崩れ ${priceText(levels.breakdown.value, market)}`
}

function windowRows(rows: PriceRow[], days: number): PriceRow[] {
  return rows.slice(Math.max(0, rows.length - days))
}

function minLow(rows: PriceRow[], days: number): number | null {
  const values = windowRows(rows, days).map((row) => row.low).filter(finite)
  return values.length > 0 ? Math.min(...values) : null
}

function maxHigh(rows: PriceRow[], days: number): number | null {
  const values = windowRows(rows, days).map((row) => row.high).filter(finite)
  return values.length > 0 ? Math.max(...values) : null
}

function pickNearestLevel(
  candidates: Array<{ label: string; value: number | null | undefined; priority: number }>,
  close: number,
  side: 'support' | 'resistance',
): PriceLevel {
  const usable = candidates
    .filter((item): item is { label: string; value: number; priority: number } => finite(item.value))
    .filter((item) => side === 'support' ? item.value <= close * 1.002 : item.value >= close * 0.998)
    .sort((a, b) => {
      const distanceA = Math.abs(a.value - close) / close
      const distanceB = Math.abs(b.value - close) / close
      if (Math.abs(distanceA - distanceB) > 0.0025) return distanceA - distanceB
      return a.priority - b.priority
    })

  if (usable.length > 0) return makeLevel(usable[0].label, usable[0].value, close)

  const fallback = candidates
    .filter((item): item is { label: string; value: number; priority: number } => finite(item.value))
    .sort((a, b) => Math.abs(a.value - close) - Math.abs(b.value - close))[0]
  return fallback ? makeLevel(fallback.label, fallback.value, close) : makeLevel(side === 'support' ? '支持未判定' : '抵抗未判定', null, close)
}

function buildHorizonLevels(rows: PriceRow[], snapshot: SnapshotRow | null, horizon: PlanHorizon): HorizonPriceLevels | null {
  const latest = rows[rows.length - 1]
  if (!latest || !finite(latest.close)) return null
  const close = latest.close

  const shortLow = minLow(rows, 10)
  const shortHigh = maxHigh(rows, 10)
  const midLow = minLow(rows, 25)
  const midHigh = maxHigh(rows, 25)
  const longLow = minLow(rows, 75)
  const longHigh = maxHigh(rows, 75)
  const majorLow = minLow(rows, 150)
  const majorHigh = maxHigh(rows, 150)

  const ma5 = snapshot?.ma5 ?? null
  const ma25 = snapshot?.ma25 ?? null
  const ma75 = snapshot?.ma75 ?? null
  const ma300 = snapshot?.ma300 ?? null

  const nearSupportCandidates = [
    { label: '5日線', value: ma5, priority: 1 },
    { label: '10日安値', value: shortLow, priority: 2 },
    { label: '25日線', value: ma25, priority: 3 },
    { label: '25日安値', value: midLow, priority: 4 },
    { label: '75日線', value: ma75, priority: 5 },
    { label: '75日安値', value: longLow, priority: 6 },
    { label: '300日線', value: ma300, priority: 7 },
    { label: '150日安値', value: majorLow, priority: 8 },
  ]

  const breakdownCandidates =
    horizon.days <= 5
      ? [
          { label: '5日線', value: ma5, priority: 1 },
          { label: '10日安値', value: shortLow, priority: 2 },
          { label: '25日線', value: ma25, priority: 3 },
          { label: '25日安値', value: midLow, priority: 4 },
        ]
      : horizon.days <= 20
        ? [
            { label: '25日線', value: ma25, priority: 1 },
            { label: '25日安値', value: midLow, priority: 2 },
            { label: '75日線', value: ma75, priority: 3 },
            { label: '75日安値', value: longLow, priority: 4 },
          ]
        : [
            { label: '75日線', value: ma75, priority: 1 },
            { label: '75日安値', value: longLow, priority: 2 },
            { label: '300日線', value: ma300, priority: 3 },
            { label: '150日安値', value: majorLow, priority: 4 },
          ]

  const resistanceCandidates =
    horizon.days <= 5
      ? [
          { label: '5日線', value: ma5, priority: 1 },
          { label: '10日高値', value: shortHigh, priority: 2 },
          { label: '25日線', value: ma25, priority: 3 },
          { label: '25日高値', value: midHigh, priority: 4 },
        ]
      : horizon.days <= 20
        ? [
            { label: '25日線', value: ma25, priority: 1 },
            { label: '25日高値', value: midHigh, priority: 2 },
            { label: '75日線', value: ma75, priority: 3 },
            { label: '75日高値', value: longHigh, priority: 4 },
          ]
        : [
            { label: '75日線', value: ma75, priority: 1 },
            { label: '75日高値', value: longHigh, priority: 2 },
            { label: '300日線', value: ma300, priority: 3 },
            { label: '150日高値', value: majorHigh, priority: 4 },
          ]

  const support = pickNearestLevel(nearSupportCandidates, close, 'support')
  const resistance = pickNearestLevel(resistanceCandidates, close, 'resistance')
  const breakdown = pickNearestLevel(breakdownCandidates, close, 'support')
  return {
    baseDate: latest.date,
    close: roundPrice(close) ?? close,
    support,
    resistance,
    breakdown,
  }
}

function horizonFocus(horizon: PlanHorizon): {
  focus: string
  upStance: string
  downStance: string
  neutralStance: string
  upChecklist: string[]
  downChecklist: string[]
  neutralChecklist: string[]
  upInvalidation: string
  downInvalidation: string
  neutralInvalidation: string
} {
  if (horizon.days <= 5) {
    return {
      focus: '5日: 初動が続くかだけ確認',
      upStance: '小さく打診。5日線維持が条件',
      downStance: '反発待ち。戻り失敗を確認',
      neutralStance: '方向が出るまで見送り',
      upChecklist: [
        '5日線上を維持',
        'PFSプラス継続',
        '5日線割れなら観察へ戻す',
      ],
      downChecklist: [
        '5日線で戻り失敗',
        'PFSマイナス拡大',
        '5日線回復なら警戒を弱める',
      ],
      neutralChecklist: [
        '5日線の上下どちらに定着するか',
        'PFSの向き待ち',
        '直近高安の抜け方向を確認',
      ],
      upInvalidation: '5日線割れ + PFSマイナス。',
      downInvalidation: '5日線回復 + PFSプラス。',
      neutralInvalidation: '5日線の片側に定着 + PFS同方向。',
    }
  }

  if (horizon.days <= 20) {
    return {
      focus: '20日: 1か月トレンド化を確認',
      upStance: '25日線維持なら押し目候補',
      downStance: '25日線回復失敗なら失速警戒',
      neutralStance: '25日線周辺は判断保留',
      upChecklist: [
        '25日線を維持',
        '日足ステージ改善',
        'PMS低下なら弱める',
      ],
      downChecklist: [
        '25日線回復失敗',
        '日足ステージ悪化',
        '戻り高値切り下げ',
      ],
      neutralChecklist: [
        '25日線の上下定着待ち',
        'PMS/PFSの向き一致待ち',
        '価格節目を優先',
      ],
      upInvalidation: '25日線割れ + PMS低下。',
      downInvalidation: '25日線回復 + ステージ改善。',
      neutralInvalidation: '25日線定着 + PMS/PFS同方向。',
    }
  }

  return {
    focus: '60日: 大局転換か調整か確認',
    upStance: '75日線維持なら大局回復候補',
    downStance: '75日線割れなら大局悪化警戒',
    neutralStance: '週足/月足が揃うまで保留',
    upChecklist: [
      '75日線を維持/回復',
      '週足悪化が停止',
      'PMS改善が継続',
    ],
    downChecklist: [
      '75日線割れ',
      '週足/月足悪化',
      '200日線で戻り失敗',
    ],
    neutralChecklist: [
      '75日線/200日線の抜け方向待ち',
      '週足/月足の一致待ち',
      '上位足を優先',
    ],
    upInvalidation: '75日線割れ + 週足悪化。',
    downInvalidation: '75日線回復 + 週足悪化停止。',
    neutralInvalidation: '週足/月足 + PMSが同方向。',
  }
}

function planFrom(
  status: PhysicsStatus,
  calibration: CalibrationRow | null,
  candidates: CandidateRow[],
  momentum: MomentumRow | null,
  horizon: PlanHorizon,
  levels: HorizonPriceLevels | null,
  market: MarketCode,
): {
  tone: PlanTone
  stance: string
  headline: string
  summary: string
  checklist: string[]
  invalidation: string
} {
  const target = calibration?.targetDirection ?? null
  const confidence = confidenceLabel(calibration)
  const best = bestCandidate(candidates)
  const pfs = momentum?.physicalForceScore ?? null
  const pms = momentum?.physicalMomentumScore ?? null
  const focus = horizonFocus(horizon)
  const priceSummary = compactPriceSummary(levels, market)
  const statLine = [
    finite(calibration?.hitRate) ? `的中率${pct(calibration?.hitRate)}` : null,
    finite(calibration?.lift) ? `lift ${calibration?.lift?.toFixed(2)}` : null,
    finite(calibration?.avgMaxReturnPct) ? `平均順行${pctRaw(calibration?.avgMaxReturnPct)}` : null,
    finite(calibration?.avgMinReturnPct) ? `平均逆行${pctRaw(calibration?.avgMinReturnPct)}` : null,
  ].filter(Boolean).join(' / ')

  if (target === 'down' || status === '下落加速' || status === '失速警戒') {
    const strong = confidence === '強め' || best?.direction === 'down' || (finite(pfs) && pfs <= -0.35)
    return {
      tone: strong ? 'negative' : 'warning',
      stance: strong ? focus.downStance : `${focus.downStance}。ただし統計信頼は${confidence}`,
      headline: `${horizon.label}は下方向の警戒を優先`,
      summary: `${priceSummary}。${statLine || '検証不足'}。`,
      checklist: levels ? [
        `${levelPriceText(levels.resistance, market)}で戻り失敗`,
        `${levelPriceText(levels.breakdown, market)}割れで警戒強め`,
        `${levelPriceText(levels.resistance, market)}回復で警戒弱め`,
      ] : focus.downChecklist,
      invalidation: levels ? `${levelPriceText(levels.resistance, market)}回復 + PFSプラス。` : focus.downInvalidation,
    }
  }

  if (target === 'up' || ['上昇加速', '上昇継続', '押し目形成', '反発準備'].includes(status)) {
    const overheated = status === '過熱注意' || (finite(momentum?.physicalEnergyScore) && (momentum.physicalEnergyScore ?? 0) >= 1.2)
    return {
      tone: overheated ? 'warning' : 'positive',
      stance: overheated ? `追いかけず、${horizon.days <= 5 ? '数日内の押し目' : horizon.days <= 20 ? '25日線付近の押し目' : '週足の押し目'}確認型` : focus.upStance,
      headline: `${horizon.label}は上方向の形を確認`,
      summary: `${priceSummary}。${statLine || '検証不足'}。`,
      checklist: levels ? [
        `${levelPriceText(levels.support, market)}で下げ止まり`,
        `${levelPriceText(levels.resistance, market)}上抜け確認`,
        `${levelPriceText(levels.breakdown, market)}割れで保留`,
      ] : overheated && horizon.days <= 5
          ? ['高値追いではなく、5日線付近まで熱量が冷めるかを見る', 'PESが急低下する場合は短期反落を優先する', '再加速するならPFSがプラスを維持するか確認する']
          : focus.upChecklist,
      invalidation: levels ? `${levelPriceText(levels.breakdown, market)}割れ + PFSマイナス。` : focus.upInvalidation,
    }
  }

  if (status === '過熱注意') {
    return {
      tone: 'warning',
      stance: horizon.days <= 5 ? '短期過熱の冷却待ち' : horizon.days <= 20 ? '25日線までの調整余地を確認' : '上位足で過熱が解消するまで待つ',
      headline: `${horizon.label}は上げ余地より反落余地を確認`,
      summary: `${priceSummary}。PMS ${finite(pms) ? pms.toFixed(2) : '-'} / PFS ${finite(pfs) ? pfs.toFixed(2) : '-'}。`,
      checklist: levels ? [
        `${levelPriceText(levels.resistance, market)}で高値失敗`,
        `${levelPriceText(levels.support, market)}を守れるか`,
        `${levelPriceText(levels.breakdown, market)}割れで過熱終了`,
      ] : horizon.days <= 5
          ? ['5日線割れで急速に失速しないかを見る', '高値更新後にPFSが低下する場合は一段の買い増しを避ける', '短期熱量が冷めても終値が5日線上に残るか確認する']
          : horizon.days <= 20
            ? ['25日線までの調整で止まるかを見る', 'PMSが低下し続ける場合は中期の過熱終了として扱う', '日足ステージが悪化側へ連続しないか確認する']
            : ['週足で上髭や上値抵抗が続かないかを見る', '75日線から離れすぎている場合は平均回帰を警戒する', '月足側の勢いが鈍るなら長期過熱終了として扱う'],
      invalidation: levels ? `${levelPriceText(levels.resistance, market)}上抜け + PFS維持。` : horizon.days <= 5 ? '5日線上で再加速 + PFSプラス。' : focus.upInvalidation,
    }
  }

  return {
    tone: 'neutral',
    stance: focus.neutralStance,
    headline: `${horizon.label}は方向感待ち`,
    summary: `${priceSummary}。${directionLabel(target)}寄りだが確認待ち。`,
    checklist: levels ? [
      `${levelPriceText(levels.support, market)}〜${levelPriceText(levels.resistance, market)}の抜け待ち`,
      `${levelPriceText(levels.resistance, market)}上抜けなら上方向`,
      `${levelPriceText(levels.support, market)}割れなら下方向`,
    ] : focus.neutralChecklist,
    invalidation: levels ? `レンジ抜け + PMS/PFS同方向。` : focus.neutralInvalidation,
  }
}

async function loadLatestFeature(ticker: string, market: MarketCode, asOfDate?: string | null): Promise<FeatureRow | null> {
  const dateFilter = asOfDate ? 'AND f.date <= ?' : ''
  const { get } = getReader(market)
  return (await get<FeatureRow>(
    `
      SELECT
        f.ticker,
        f.date,
        f.stage_code AS stageCode,
        f.feature_json AS featureJson,
        u.name,
        u.market_segment AS marketSegment,
        u.sector17_name AS sector17Name,
        u.sector33_name AS sector33Name
      FROM ml_feature_vectors_v2 f
      LEFT JOIN ticker_universe u ON u.ticker = f.ticker
      WHERE f.feature_set = ?
        AND f.ticker = ?
        ${dateFilter}
      ORDER BY f.date DESC
      LIMIT 1
    `,
    asOfDate ? [ML_PHYSICS_FEATURE_SET, ticker, asOfDate] : [ML_PHYSICS_FEATURE_SET, ticker],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table') || message.includes('US analytics DB not found')) return null
    throw error
  })) ?? null
}

async function loadMomentum(ticker: string, market: MarketCode, asOfDate?: string | null): Promise<MomentumRow | null> {
  const dateFilter = asOfDate ? 'AND date <= ?' : ''
  const { get, isUsAnalytics } = getReader(market)
  const dbMarkets = isUsAnalytics ? ['US', 'JP'] : [market]
  const placeholders = dbMarkets.map(() => '?').join(', ')
  return (await get<MomentumRow>(
    `
      SELECT
        date,
        physical_momentum_score AS physicalMomentumScore,
        physical_force_score AS physicalForceScore,
        physical_energy_score AS physicalEnergyScore
      FROM physical_momentum_metrics
      WHERE market IN (${placeholders})
        AND symbol = ?
        ${dateFilter}
      ORDER BY CASE market WHEN ? THEN 0 ELSE 1 END, date DESC
      LIMIT 1
    `,
    asOfDate ? [...dbMarkets, ticker, asOfDate, market] : [...dbMarkets, ticker, market],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table') || message.includes('US analytics DB not found')) return null
    throw error
  })) ?? null
}

async function loadCalibrations(status: PhysicsStatus, market: MarketCode, asOfDate?: string | null): Promise<Map<number, CalibrationRow>> {
  const dateFilter = asOfDate ? 'AND evaluation_date <= ?' : ''
  const { all } = getReader(market)
  const rows = await all<CalibrationRow>(
    `
      WITH latest AS (
        SELECT horizon_days, MAX(evaluation_date) AS evaluation_date
        FROM ml_physics_status_evaluations
        WHERE feature_set = ?
          AND status_label = ?
          AND sample_count > 0
          AND horizon_days IN (${PLAN_HORIZONS.map(() => '?').join(', ')})
          ${dateFilter}
        GROUP BY horizon_days
      )
      SELECT
        e.status_label AS statusLabel,
        e.target_direction AS targetDirection,
        e.horizon_days AS horizonDays,
        e.sample_count AS sampleCount,
        e.hit_rate AS hitRate,
        e.base_rate AS baseRate,
        e.lift,
        e.confidence_score AS confidenceScore,
        e.median_return_pct AS medianReturnPct,
        e.avg_return_pct AS avgReturnPct,
        e.avg_max_return_pct AS avgMaxReturnPct,
        e.avg_min_return_pct AS avgMinReturnPct,
        e.adverse_rate AS adverseRate,
        e.evaluation_date AS evaluationDate
      FROM ml_physics_status_evaluations e
      INNER JOIN latest l
        ON l.horizon_days = e.horizon_days
       AND l.evaluation_date = e.evaluation_date
      WHERE e.feature_set = ?
        AND e.status_label = ?
        AND e.sample_count > 0
    `,
    asOfDate
      ? [ML_PHYSICS_FEATURE_SET, status, ...PLAN_HORIZONS.map((h) => h.days), asOfDate, ML_PHYSICS_FEATURE_SET, status]
      : [ML_PHYSICS_FEATURE_SET, status, ...PLAN_HORIZONS.map((h) => h.days), ML_PHYSICS_FEATURE_SET, status],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table') || message.includes('US analytics DB not found')) return []
    throw error
  })
  return new Map(rows.map((row) => [Number(row.horizonDays), row]))
}

async function loadCandidates(ticker: string, market: MarketCode, asOfDate?: string | null): Promise<Map<number, CandidateRow[]>> {
  const dateFilter = asOfDate ? 'AND as_of_date <= ?' : ''
  const { all } = getReader(market)
  const rows = await all<CandidateRow>(
    `
      WITH latest AS (
        SELECT horizon_days, MAX(as_of_date) AS as_of_date
        FROM serving_ml_physics_candidates
        WHERE horizon_days IN (${PLAN_HORIZONS.map(() => '?').join(', ')})
          ${dateFilter}
        GROUP BY horizon_days
      )
      SELECT
        c.as_of_date AS asOfDate,
        c.direction,
        c.horizon_days AS horizonDays,
        c.rank,
        c.candidate_score AS candidateScore,
        c.model_name AS modelName
      FROM serving_ml_physics_candidates c
      INNER JOIN latest l
        ON l.horizon_days = c.horizon_days
       AND l.as_of_date = c.as_of_date
      WHERE c.ticker = ?
      ORDER BY c.horizon_days, c.rank
    `,
    asOfDate ? [...PLAN_HORIZONS.map((h) => h.days), asOfDate, ticker] : [...PLAN_HORIZONS.map((h) => h.days), ticker],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table') || message.includes('US analytics DB not found')) return []
    throw error
  })
  const map = new Map<number, CandidateRow[]>()
  for (const row of rows) {
    const list = map.get(row.horizonDays) ?? []
    list.push(row)
    map.set(row.horizonDays, list)
  }
  return map
}

async function loadPriceRows(ticker: string, market: MarketCode, asOfDate?: string | null): Promise<PriceRow[]> {
  const dateFilter = asOfDate ? 'AND date <= ?' : ''
  const { all, isUsAnalytics } = getReader(market)
  const rows = market === 'US' && !isUsAnalytics
    ? await execAll<PriceRow>(
        `
          SELECT date, open, high, low, close, volume
          FROM market_ohlcv_daily
          WHERE market = 'US'
            AND ticker = ?
            ${dateFilter}
          ORDER BY date DESC
          LIMIT 180
        `,
        asOfDate ? [ticker, asOfDate] : [ticker],
      )
    : await all<PriceRow>(
        `
          SELECT date, open, high, low, close, volume
          FROM ohlcv_daily
          WHERE ticker = ?
            ${dateFilter}
          ORDER BY date DESC
          LIMIT 180
        `,
        asOfDate ? [ticker, asOfDate] : [ticker],
      )
  return rows.reverse()
}

async function loadSnapshot(ticker: string, market: MarketCode, asOfDate?: string | null): Promise<SnapshotRow | null> {
  const dateFilter = asOfDate ? 'AND date <= ?' : ''
  const { get, isUsAnalytics } = getReader(market)
  if (market === 'US' && !isUsAnalytics) {
    return (await execGet<SnapshotRow>(
      `
        SELECT
          date,
          ma_5 AS ma5,
          ma_25 AS ma25,
          ma_75 AS ma75,
          ma_300 AS ma300
        FROM market_daily_snapshots
        WHERE market = 'US'
          AND ticker = ?
          ${dateFilter}
        ORDER BY date DESC
        LIMIT 1
      `,
      asOfDate ? [ticker, asOfDate] : [ticker],
    )) ?? null
  }
  return (await get<SnapshotRow>(
    `
      SELECT
        date,
        ma_5 AS ma5,
        ma_25 AS ma25,
        ma_75 AS ma75,
        ma_300 AS ma300
      FROM daily_snapshots
      WHERE ticker = ?
        ${dateFilter}
      ORDER BY date DESC
      LIMIT 1
    `,
    asOfDate ? [ticker, asOfDate] : [ticker],
  )) ?? null
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { ticker: rawTicker } = await context.params
    const market = normalizeMarket(request.nextUrl.searchParams.get('market'))
    const ticker = normalizeTicker(rawTicker, market)
    const asOfDate = parseAsOfDate(request.nextUrl.searchParams.get('date'))
    const feature = await loadLatestFeature(ticker, market, asOfDate)
    if (!feature) {
      return NextResponse.json({
        ok: true,
        market,
        ticker,
        available: false,
        message: '物理ML特徴量が未生成です。',
        horizons: [],
      })
    }

    const profile = parseJson<Record<string, unknown> | null>(feature.featureJson, null)
    const analysis = analyzePhysicsProfile(profile)
    const [momentum, calibrationMap, candidateMap, priceRows, snapshot] = await Promise.all([
      loadMomentum(ticker, market, asOfDate),
      loadCalibrations(analysis.physicsStatus, market, asOfDate),
      loadCandidates(ticker, market, asOfDate),
      loadPriceRows(ticker, market, asOfDate),
      loadSnapshot(ticker, market, asOfDate),
    ])

    const horizons = PLAN_HORIZONS.map((horizon) => {
      const calibration = calibrationMap.get(horizon.days) ?? null
      const candidates = candidateMap.get(horizon.days) ?? []
      const levels = buildHorizonLevels(priceRows, snapshot, horizon)
      const plan = planFrom(analysis.physicsStatus, calibration, candidates, momentum, horizon, levels, market)
      return {
        label: horizon.label,
        horizonDays: horizon.days,
        description: horizon.description,
        statusLabel: analysis.physicsStatus,
        targetDirection: calibration?.targetDirection ?? null,
        hitRate: calibration?.hitRate ?? null,
        baseRate: calibration?.baseRate ?? null,
        lift: calibration?.lift ?? null,
        confidenceScore: calibration?.confidenceScore ?? null,
        confidenceLabel: confidenceLabel(calibration),
        sampleCount: calibration?.sampleCount ?? null,
        adverseRate: calibration?.adverseRate ?? null,
        avgReturnPct: calibration?.avgReturnPct ?? null,
        avgMaxReturnPct: calibration?.avgMaxReturnPct ?? null,
        avgMinReturnPct: calibration?.avgMinReturnPct ?? null,
        medianReturnPct: calibration?.medianReturnPct ?? null,
        evaluationDate: calibration?.evaluationDate ?? null,
        candidates: candidates.map((row) => ({
          asOfDate: row.asOfDate,
          direction: row.direction,
          rank: row.rank,
          score: row.candidateScore,
          modelName: row.modelName,
        })),
        levels,
        suggestion: plan,
      }
    })

    return NextResponse.json({
      ok: true,
      market,
      ticker,
      available: true,
      featureSet: ML_PHYSICS_FEATURE_SET,
      featureAsOfDate: feature.date,
      requestedDate: asOfDate,
      priceAsOfDate: priceRows[priceRows.length - 1]?.date ?? null,
      stock: {
        ticker: feature.ticker,
        name: feature.name,
        marketSegment: feature.marketSegment,
        sector17Name: feature.sector17Name,
        sector33Name: feature.sector33Name,
        stageCode: feature.stageCode,
      },
      physicsAnalysis: analysis,
      momentum,
      horizons,
      note: `この表示は${ML_PHYSICS_FEATURE_SET}の現在形状と、過去検証統計から作る観察メモです。売買を断定するものではありません。`,
      format: {
        hitRateExample: pct(horizons[0]?.hitRate),
        avgReturnExample: pctRaw(horizons[0]?.avgReturnPct),
      },
    })
  } catch (error) {
    console.error('stock physical plan API error:', error)
    return NextResponse.json(
      { ok: false, error: 'stock physical plan failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
