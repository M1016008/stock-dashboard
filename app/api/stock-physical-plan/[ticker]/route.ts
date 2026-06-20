import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { analyzePhysicsProfile, type PhysicsStatus } from '@/lib/ml/physics-analysis'

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

type PlanTone = 'positive' | 'negative' | 'neutral' | 'warning'

const PLAN_HORIZONS = [
  { label: '短期', days: 5, description: '数日から1週間程度の反応を見る時間軸' },
  { label: '中期', days: 20, description: '約1か月の方向感と押し目/失速を見る時間軸' },
  { label: '長期', days: 60, description: '約3か月の地合い転換と大きな崩れを見る時間軸' },
] as const

function normalizeTicker(value: string): string {
  return value.trim().toUpperCase().replace(/\.T$/i, '')
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

function planFrom(
  status: PhysicsStatus,
  calibration: CalibrationRow | null,
  candidates: CandidateRow[],
  momentum: MomentumRow | null,
  horizonLabel: string,
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
  const evidence = [
    `${status}`,
    `${directionLabel(target)} / 信頼${confidence}`,
    candidateLine(candidates),
  ]

  if (target === 'down' || status === '下落加速' || status === '失速警戒') {
    const strong = confidence === '強め' || best?.direction === 'down' || (finite(pfs) && pfs <= -0.35)
    return {
      tone: strong ? 'negative' : 'warning',
      stance: strong ? '買い急がず、下落リスク管理を優先' : '戻りの弱さを確認してから判断',
      headline: `${horizonLabel}は下方向の警戒を優先`,
      summary: `現在の物理状態は、過去検証では${directionLabel(target)}として扱われやすい形です。${evidence.join('、')}。`,
      checklist: [
        '終値が5日線/25日線を回復できるかを確認する',
        'PFSがマイナス圏から戻るまで新規の強気判断を急がない',
        '戻りが弱く、短期線が再び下向く場合は下落継続シナリオを優先する',
      ],
      invalidation: '5日線と25日線を終値で回復し、PFSがプラス圏へ戻る場合は下落警戒を弱めます。',
    }
  }

  if (target === 'up' || ['上昇加速', '上昇継続', '押し目形成', '反発準備'].includes(status)) {
    const overheated = status === '過熱注意' || (finite(momentum?.physicalEnergyScore) && (momentum.physicalEnergyScore ?? 0) >= 1.2)
    return {
      tone: overheated ? 'warning' : 'positive',
      stance: overheated ? '追いかけず、押し目確認型' : '打診候補。ただし確認条件つき',
      headline: `${horizonLabel}は上方向の形を確認`,
      summary: `現在の物理状態は、過去検証では${directionLabel(target)}として扱われやすい形です。${evidence.join('、')}。`,
      checklist: [
        '5日線と25日線の上向きが維持されるかを確認する',
        'PFSがプラスを保ち、PMSが低下に転じないかを見る',
        overheated ? '高値追いではなく、短期過熱の縮小後に再加速するかを見る' : '直近高値更新時に出来高とPESが落ちないかを見る',
      ],
      invalidation: '25日線を明確に割り、PFSがマイナス化する場合は強気シナリオを保留します。',
    }
  }

  if (status === '過熱注意') {
    return {
      tone: 'warning',
      stance: '過熱縮小待ち',
      headline: `${horizonLabel}は上げ余地より反落余地を確認`,
      summary: `PMS ${finite(pms) ? pms.toFixed(2) : '-'}、PFS ${finite(pfs) ? pfs.toFixed(2) : '-'}。上方向の熱量はありますが、短期の伸び切りを警戒します。`,
      checklist: [
        '5日線割れで急速に失速しないかを見る',
        '高値更新後にPFSが低下する場合は一段の買い増しを避ける',
        '押し目で25日線を維持できるか確認する',
      ],
      invalidation: '過熱縮小後に5日線上で再加速し、PFSがプラスを維持する場合は上方向の見方を戻します。',
    }
  }

  return {
    tone: 'neutral',
    stance: '見送り・条件待ち',
    headline: `${horizonLabel}は方向感待ち`,
    summary: `過去検証では${directionLabel(target)}寄りですが、現時点では決め打ちより確認条件を待つ形です。${evidence.join('、')}。`,
    checklist: [
      '5日線/25日線のどちら側で終値が安定するかを見る',
      'PFSが明確にプラス/マイナスへ傾くまで待つ',
      '6ステージが改善または悪化へ連続するか確認する',
    ],
    invalidation: 'PMSとPFSが同じ方向へ傾き、物理ML候補にも掲載される場合は見送りから方向判断へ移します。',
  }
}

async function loadLatestFeature(ticker: string): Promise<FeatureRow | null> {
  return (await execGet<FeatureRow>(
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
      ORDER BY f.date DESC
      LIMIT 1
    `,
    [ML_PHYSICS_FEATURE_SET, ticker],
  )) ?? null
}

async function loadMomentum(ticker: string): Promise<MomentumRow | null> {
  return (await execGet<MomentumRow>(
    `
      SELECT
        date,
        physical_momentum_score AS physicalMomentumScore,
        physical_force_score AS physicalForceScore,
        physical_energy_score AS physicalEnergyScore
      FROM physical_momentum_metrics
      WHERE market = 'JP'
        AND symbol = ?
      ORDER BY date DESC
      LIMIT 1
    `,
    [ticker],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table')) return null
    throw error
  })) ?? null
}

async function loadCalibrations(status: PhysicsStatus): Promise<Map<number, CalibrationRow>> {
  const rows = await execAll<CalibrationRow>(
    `
      WITH latest AS (
        SELECT horizon_days, MAX(evaluation_date) AS evaluation_date
        FROM ml_physics_status_evaluations
        WHERE feature_set = ?
          AND status_label = ?
          AND horizon_days IN (${PLAN_HORIZONS.map(() => '?').join(', ')})
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
    `,
    [ML_PHYSICS_FEATURE_SET, status, ...PLAN_HORIZONS.map((h) => h.days), ML_PHYSICS_FEATURE_SET, status],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table')) return []
    throw error
  })
  return new Map(rows.map((row) => [Number(row.horizonDays), row]))
}

async function loadCandidates(ticker: string): Promise<Map<number, CandidateRow[]>> {
  const rows = await execAll<CandidateRow>(
    `
      WITH latest AS (
        SELECT horizon_days, MAX(as_of_date) AS as_of_date
        FROM serving_ml_physics_candidates
        WHERE horizon_days IN (${PLAN_HORIZONS.map(() => '?').join(', ')})
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
    [...PLAN_HORIZONS.map((h) => h.days), ticker],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table')) return []
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

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { ticker: rawTicker } = await context.params
    const ticker = normalizeTicker(rawTicker)
    const feature = await loadLatestFeature(ticker)
    if (!feature) {
      return NextResponse.json({
        ok: true,
        ticker,
        available: false,
        message: '物理ML特徴量が未生成です。',
        horizons: [],
      })
    }

    const profile = parseJson<Record<string, unknown> | null>(feature.featureJson, null)
    const analysis = analyzePhysicsProfile(profile)
    const [momentum, calibrationMap, candidateMap] = await Promise.all([
      loadMomentum(ticker),
      loadCalibrations(analysis.physicsStatus),
      loadCandidates(ticker),
    ])

    const horizons = PLAN_HORIZONS.map((horizon) => {
      const calibration = calibrationMap.get(horizon.days) ?? null
      const candidates = candidateMap.get(horizon.days) ?? []
      const plan = planFrom(analysis.physicsStatus, calibration, candidates, momentum, horizon.label)
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
        suggestion: plan,
      }
    })

    return NextResponse.json({
      ok: true,
      ticker,
      available: true,
      featureSet: ML_PHYSICS_FEATURE_SET,
      featureAsOfDate: feature.date,
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
