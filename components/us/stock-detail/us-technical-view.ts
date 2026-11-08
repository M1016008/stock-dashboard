// US個別銘柄だけが使う表示ヘルパー(US API の応答型・USD表記・US版の短期チェック根拠)。
// JP と同一の式は components/stock/technical-view.ts を共有する。
import {
  buildMaFieldInsight,
  directionColor,
  directionGlyph,
  directionWord,
  EMPTY_MOMENTUM_SNAPSHOT,
  fmtPct,
  formatDelta,
  maAngleSet,
  previousMomentumRow,
  SHORT_TERM_CHANGE_THRESHOLD,
  SHORT_TERM_LEAN_PCT,
  SHORT_TERM_PFS_THRESHOLD,
  SHORT_TERM_PMS_LEVEL,
  SHORT_TERM_STRONG_PCT,
  shortTermSideReading,
  stagePairText,
  stageSide,
  tallyDirection,
  thresholdDirection,
  upperStageText,
  type EvidenceDirection,
  type ShortTermEvidenceItem,
  type ShortTermEvidenceSide,
  type StageEntry,
  type TechnicalMomentumSnapshot,
} from '@/components/stock/technical-view'
import type { PhysicalPlanDecision } from '@/lib/physical-plan'
import type { ShortTermCheckResult } from '@/lib/short-term-check'
import { selectPhysicalMomentumScoreRow } from '@/lib/stock-decision-summary'

export interface UsPhysicalMomentumRow {
  date: string
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
  velocity: number | null
  acceleration: number | null
  momentum?: number | null
  force: number | null
  ma5Angle?: number | null
  ma25Angle?: number | null
  ma75Angle?: number | null
  ma200Angle?: number | null
  maAngleAvg?: number | null
  energy: number | null
}

export interface UsPhysicalMomentumTimeframeView {
  interval: 'D' | '2D' | 'W' | 'M'
  label: string
  basis: string
  latestDate: string | null
  scoreSource: 'market_z' | 'local_timeframe_z'
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
  trend: 'rising' | 'falling' | 'flat' | null
}

export interface UsPhysicalMomentumResponse {
  latest: UsPhysicalMomentumRow | null
  history: UsPhysicalMomentumRow[]
  rank: number | null
  totalRanked: number
  trend: 'rising' | 'falling' | 'flat' | null
  source?: 'main' | 'us_analytics'
  requestedDate?: string | null
  latestScoredDate?: string | null
  isScoreFresh?: boolean
  scoreSource?: 'stored' | 'runtime_raw' | null
  timeframeViews?: UsPhysicalMomentumTimeframeView[]
}

export interface UsPhysicalPlanLevel {
  label: string
  value: number | null
  distancePct: number | null
}

export interface UsPhysicalPlanLevels {
  baseDate: string
  close: number
  support: UsPhysicalPlanLevel
  resistance: UsPhysicalPlanLevel
  breakdown: UsPhysicalPlanLevel
}

export interface UsPhysicalPlanCandidate {
  direction: 'up' | 'down' | 'wait'
  rank: number
  score: number
  asOfDate: string
}

export interface UsPhysicalPlanHorizon {
  label: string
  horizonDays: number
  description: string
  statusLabel: string
  targetDirection: 'up' | 'down' | 'wait' | null
  hitRate: number | null
  baseRate: number | null
  lift: number | null
  avgMaxReturnPct: number | null
  avgMinReturnPct: number | null
  sampleCount: number | null
  evaluationDate: string | null
  confidenceLabel: string
  candidates: UsPhysicalPlanCandidate[]
  levels: UsPhysicalPlanLevels | null
  suggestion: {
    tone: 'positive' | 'negative' | 'neutral' | 'warning'
    stance: string
    headline: string
    summary: string
    checklist: string[]
    conditionLabel: string
    invalidation: string
    decision: PhysicalPlanDecision
  }
}

export interface UsPhysicalPlanResponse {
  ok: boolean
  available: boolean
  market?: string
  ticker: string
  featureAsOfDate?: string | null
  priceAsOfDate?: string | null
  note?: string
  horizons: UsPhysicalPlanHorizon[]
}

// ---------- 数値の表示(USD) ----------

export function fmtUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  // $1未満の銘柄が「$0」にならないよう桁を増やす
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(value) >= 1 ? 2 : 4 })}`
}

export function fmtMoney(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`
  return `$${Math.round(value).toLocaleString('en-US')}`
}

export function fmtCount(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return Math.round(value).toLocaleString('en-US')
}

export function tradePlanToneColor(tone: UsPhysicalPlanHorizon['suggestion']['tone']): string {
  if (tone === 'positive') return 'var(--price-up)'
  if (tone === 'negative') return 'var(--price-down)'
  if (tone === 'warning') return '#b45309'
  return 'var(--text-secondary)'
}

// ---------- チャートタブの現在構造スナップショット ----------

export function technicalMomentumSnapshot(
  status: 'idle' | 'loading' | 'ready' | 'error',
  payload: UsPhysicalMomentumResponse | null,
  error: string,
): TechnicalMomentumSnapshot {
  if (status === 'idle' || status === 'loading') return { ...EMPTY_MOMENTUM_SNAPSHOT, status: 'loading', message: null }
  if (status === 'error') return { ...EMPTY_MOMENTUM_SNAPSHOT, status: 'error', message: error || null }
  const latest = payload?.latest ?? null
  if (!payload || !latest) {
    return { ...EMPTY_MOMENTUM_SNAPSHOT, status: 'missing', message: 'このUS銘柄のPMSはまだ算出されていません' }
  }
  const field = buildMaFieldInsight(latest, previousMomentumRow(payload))
  const { scoreDate, scoreRow } = selectPhysicalMomentumScoreRow({
    latest,
    history: payload.history ?? [],
    latestScoredDate: payload.latestScoredDate,
    isScoreFresh: payload.isScoreFresh,
  })
  return {
    status: 'available',
    scoreDate,
    maDate: latest.date,
    pms: scoreRow?.physicalMomentumScore ?? null,
    pfs: scoreRow?.physicalForceScore ?? null,
    pes: scoreRow?.physicalEnergyScore ?? null,
    isScoreFresh: payload.isScoreFresh ?? (scoreDate === latest.date),
    maStructure: field.label,
    maDescription: field.description,
    maColor: field.color,
    maAngles: maAngleSet(latest),
    maSpreadDeg: field.spreadDeg,
    maSpreadChangeDeg: field.spreadChangeDeg,
    message: scoreDate && !scoreRow ? 'PMS/PFS/PESのスコア行を確認できません' : null,
  }
}

// ---------- 短期チェックの根拠(JP buildShortTermEvidence から、US版に無い類似銘柄・物理分類を除いたもの) ----------

/** 短期チェックの入力(Stage・PMS・PFS・日次騰落)を短期/中期に分け、向きと一致・不一致、判定が変わる境界を並べる */
export function buildUsShortTermEvidence(
  stage: StageEntry | null,
  latest: UsPhysicalMomentumRow | null,
  changePercent: number | null,
  decision: ShortTermCheckResult | null,
) {
  const shortItems: ShortTermEvidenceItem[] = [
    {
      label: '日足Stage A・B',
      name: '日足Stage',
      value: stage ? stagePairText(stage.daily_a_stage, stage.daily_b_stage) : '—',
      direction: stage ? tallyDirection([stageSide(stage.daily_a_stage), stageSide(stage.daily_b_stage)]) : null,
    },
    {
      label: 'PFS 足元の力',
      name: 'PFS',
      value: formatDelta(latest?.physicalForceScore),
      direction: thresholdDirection(latest?.physicalForceScore, SHORT_TERM_PFS_THRESHOLD),
    },
    {
      label: '日次騰落',
      name: '日次騰落',
      value: changePercent == null ? '—' : fmtPct(changePercent),
      direction: thresholdDirection(changePercent, SHORT_TERM_CHANGE_THRESHOLD),
    },
  ]
  const mediumItems: ShortTermEvidenceItem[] = [
    {
      label: '週足Stage A・B',
      name: '週足Stage',
      value: stage ? stagePairText(stage.weekly_a_stage, stage.weekly_b_stage) : '—',
      direction: stage ? tallyDirection([stageSide(stage.weekly_a_stage), stageSide(stage.weekly_b_stage)]) : null,
    },
    {
      label: '月足Stage A・B',
      name: '月足Stage',
      value: stage ? stagePairText(stage.monthly_a_stage, stage.monthly_b_stage) : '—',
      direction: stage ? tallyDirection([stageSide(stage.monthly_a_stage), stageSide(stage.monthly_b_stage)]) : null,
    },
    {
      label: 'PMS 20営業日',
      name: 'PMS',
      value: formatDelta(latest?.physicalMomentumScore),
      direction: thresholdDirection(latest?.physicalMomentumScore, SHORT_TERM_PMS_LEVEL),
    },
  ]
  const side = (key: ShortTermEvidenceSide['key'], label: string, items: ShortTermEvidenceItem[]): ShortTermEvidenceSide => ({
    key,
    label,
    items,
    up: items.filter((item) => item.direction === 'up').length,
    down: items.filter((item) => item.direction === 'down').length,
    direction: tallyDirection(items.map((item) => item.direction)),
  })
  const shortSide = side('short', '短期 日足・足元', shortItems)
  const mediumSide = side('medium', stage ? `中期 週・月足(上位足 ${upperStageText(stage)})` : '中期 週・月足', mediumItems)

  const agreement = shortSide.direction == null || mediumSide.direction == null
    ? { label: '判定材料なし', color: 'var(--color-text-tertiary)' }
    : shortSide.direction === mediumSide.direction && shortSide.direction !== 'flat'
      ? { label: `一致(ともに${directionWord(shortSide.direction)})`, color: directionColor(shortSide.direction) }
      : shortSide.direction !== 'flat' && mediumSide.direction !== 'flat'
        ? { label: `不一致(短期${directionGlyph(shortSide.direction)} 中期${directionGlyph(mediumSide.direction)})`, color: '#b45309' }
        : { label: `片方が中立(短期${directionGlyph(shortSide.direction)} 中期${directionGlyph(mediumSide.direction)})`, color: 'var(--color-text-secondary)' }

  const boundary: Record<string, string> = {
    強気優勢: `上昇強度が${SHORT_TERM_STRONG_PCT}%未満で「好転候補」`,
    好転候補: `上昇強度${SHORT_TERM_STRONG_PCT}%以上で「強気優勢」、${SHORT_TERM_LEAN_PCT}%未満で「中立」`,
    中立: `上昇強度${SHORT_TERM_LEAN_PCT}%以上で「好転候補」、下落圧力${SHORT_TERM_LEAN_PCT}%以上で「弱含み注意」`,
    弱含み注意: `下落圧力${SHORT_TERM_STRONG_PCT}%以上で「下落警戒」、${SHORT_TERM_LEAN_PCT}%未満で「中立」`,
    下落警戒: `下落圧力が${SHORT_TERM_STRONG_PCT}%未満で「弱含み注意」`,
  }
  const conditions: string[] = []
  if (decision && boundary[decision.label]) conditions.push(boundary[decision.label])
  const bearish = decision?.label === '弱含み注意' || decision?.label === '下落警戒'
  const bullish = decision?.label === '強気優勢' || decision?.label === '好転候補'
  if (bearish || bullish) {
    const aligned: EvidenceDirection = bearish ? 'down' : 'up'
    const daily = shortItems[0]
    const pfs = shortItems[1]
    if (daily.direction === aligned) conditions.push(`日足Stageが${bearish ? 'S3/S4' : 'S1/S6'}から外れる`)
    if (pfs.direction === aligned) {
      conditions.push(`PFS ${pfs.value}が${bearish ? `-${SHORT_TERM_PFS_THRESHOLD}を上回る` : `+${SHORT_TERM_PFS_THRESHOLD}を下回る`}`)
    }
  }

  const reading = shortSide.direction == null || mediumSide.direction == null
    ? null
    : `${shortTermSideReading('短期', shortSide)}。${shortTermSideReading('中期', mediumSide)}。`

  return { sides: [shortSide, mediumSide], agreement, reading, conditions: conditions.slice(0, 3) }
}

export function shortTermToneColor(tone: ShortTermCheckResult['tone']): string {
  if (tone === 'bullish') return 'var(--price-up)'
  if (tone === 'positive') return '#0f766e'
  if (tone === 'bearish') return 'var(--price-down)'
  if (tone === 'weak') return '#1d4ed8'
  return 'var(--text-secondary)'
}
