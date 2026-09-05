import {
  getStageTransitionDirection,
  STAGE_STRUCTURE_STRENGTH,
  type StageLevel,
  type StageTransitionDirection,
} from '@/lib/hex-stage'
import {
  SECTOR_STRUCTURE_AXES,
  type SectorStructureAxisKey,
} from '@/lib/sector-structure'
import type { SectorStructureRow } from '@/lib/queries/sectors'

export type HexSelectorDirection = 'up' | 'down'
export type HexSelectorMode = 'emerging' | 'continuation'

export type HexSelectorStages = Record<SectorStructureAxisKey, number | null>

export type HexSelectorCandidateInput = {
  ticker: string
  name: string | null
  marketSegment: string | null
  marketCap: number | null
  price: number | null
  changePct: number | null
  volume: number | null
  stages: HexSelectorStages
  previousStages: HexSelectorStages
  ma: { ma5: number | null; ma25: number | null; ma75: number | null; ma300: number | null }
  previousMa: { ma5: number | null; ma25: number | null; ma75: number | null; ma300: number | null }
  physicalMomentumScore: number | null
  mlUpRank: number | null
  mlDownRank: number | null
}

export type HexSelectorCriterion = {
  key: 'sector' | 'transition' | 'higher' | 'ma' | 'evidence'
  label: string
  detail: string
  passed: boolean
}

export type HexSelectorCandidate = HexSelectorCandidateInput & {
  stageCode: string | null
  matchCount: number
  transitionMatches: number
  higherAlignment: number
  maMatches: number
  relevantMlRank: number | null
  criteria: HexSelectorCriterion[]
  reasons: string[]
  warnings: string[]
}

const HIGHER_AXES: SectorStructureAxisKey[] = ['weeklyA', 'weeklyB', 'monthlyA', 'monthlyB']

export function parseHexSelectorDirection(value: string | null | undefined): HexSelectorDirection {
  return value === 'down' ? 'down' : 'up'
}

export function parseHexSelectorMode(value: string | null | undefined): HexSelectorMode {
  return value === 'continuation' ? 'continuation' : 'emerging'
}

function signed(value: number | null | undefined, direction: HexSelectorDirection) {
  return (value ?? 0) * (direction === 'up' ? 1 : -1)
}

function transitionMatchesDirection(
  transition: StageTransitionDirection,
  direction: HexSelectorDirection,
) {
  return direction === 'up'
    ? transition === 'improve' || transition === 'jump_improve'
    : transition === 'deteriorate' || transition === 'jump_deteriorate'
}

function stageBias(stage: number | null) {
  if (stage == null || !(stage in STAGE_STRUCTURE_STRENGTH)) return 0
  return (STAGE_STRUCTURE_STRENGTH[stage as StageLevel] - 50) / 50
}

function directionalStageAlignment(stages: HexSelectorStages, direction: HexSelectorDirection) {
  const values = HIGHER_AXES
    .map((axis) => stageBias(stages[axis]))
    .filter((value) => Number.isFinite(value))
  if (values.length === 0) return 0
  const average = values.reduce((sum, value) => sum + value, 0) / values.length
  return Math.round(Math.max(0, Math.min(1, direction === 'up' ? (average + 1) / 2 : (1 - average) / 2)) * 100)
}

function maSlope(current: number | null, previous: number | null) {
  if (current == null || previous == null || previous <= 0) return null
  return 100 * (current - previous) / previous
}

function fmtSigned(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '未計算'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`
}

function sectorSampleReliability(nStocks: number) {
  return Math.max(0.25, Math.min(1, nStocks / 12))
}

function sectorRankingMetric(
  row: SectorStructureRow,
  mode: HexSelectorMode,
  direction: HexSelectorDirection,
) {
  const raw = mode === 'emerging'
    ? signed(row.transitionChangeScore, direction)
    : direction === 'up'
      ? (row.trendStructureScore ?? row.strengthScore ?? 50) - 50
      : 50 - (row.trendStructureScore ?? row.strengthScore ?? 50)
  const reliability = sectorSampleReliability(row.nStocks)

  // Small groups stay visible, but a sharp move in only a few stocks should not
  // outrank a similarly directional move backed by a broader industry sample.
  return raw >= 0 ? raw * reliability : raw / reliability
}

export function rankSelectorSectors(
  rows: SectorStructureRow[],
  mode: HexSelectorMode,
  direction: HexSelectorDirection,
) {
  return [...rows].sort((a, b) => {
    const aPrimary = sectorRankingMetric(a, mode, direction)
    const bPrimary = sectorRankingMetric(b, mode, direction)
    if (bPrimary !== aPrimary) return bPrimary - aPrimary

    const aPropagation = a.propagationDirection === (direction === 'up' ? 'improving' : 'deteriorating')
      ? a.propagationPhase
      : 0
    const bPropagation = b.propagationDirection === (direction === 'up' ? 'improving' : 'deteriorating')
      ? b.propagationPhase
      : 0
    if (bPropagation !== aPropagation) return bPropagation - aPropagation

    const momentum = signed(b.momentum10d, direction) - signed(a.momentum10d, direction)
    if (momentum !== 0) return momentum
    return b.nStocks - a.nStocks || a.groupName.localeCompare(b.groupName, 'ja-JP')
  })
}

export function analyzeHexSelectorCandidate(
  input: HexSelectorCandidateInput,
  sector: Pick<
    SectorStructureRow,
    'strengthScore' | 'trendStructureScore' | 'transitionChangeScore' | 'momentum10d' | 'propagationDirection' | 'nStocks'
  >,
  mode: HexSelectorMode,
  direction: HexSelectorDirection,
): HexSelectorCandidate {
  const matchingTransitions = SECTOR_STRUCTURE_AXES.filter((axis) => (
    transitionMatchesDirection(
      getStageTransitionDirection(input.previousStages[axis.key], input.stages[axis.key]),
      direction,
    )
  ))
  const higherAlignment = directionalStageAlignment(input.stages, direction)
  const slopes = [
    maSlope(input.ma.ma5, input.previousMa.ma5),
    maSlope(input.ma.ma25, input.previousMa.ma25),
    maSlope(input.ma.ma75, input.previousMa.ma75),
    maSlope(input.ma.ma300, input.previousMa.ma300),
  ]
  const maMatches = slopes.filter((value) => value != null && (direction === 'up' ? value > 0.04 : value < -0.04)).length
  const relevantMlRank = direction === 'up' ? input.mlUpRank : input.mlDownRank
  const pmsMatches = input.physicalMomentumScore != null
    && (direction === 'up' ? input.physicalMomentumScore > 0 : input.physicalMomentumScore < 0)
  const evidenceMatches = pmsMatches || (relevantMlRank != null && relevantMlRank <= 160)
  const expectedPropagation = direction === 'up' ? 'improving' : 'deteriorating'
  const sectorMatches = mode === 'emerging'
    ? signed(sector.transitionChangeScore, direction) > 0 || sector.propagationDirection === expectedPropagation
    : direction === 'up'
      ? (sector.trendStructureScore ?? sector.strengthScore ?? 0) >= 60 && signed(sector.momentum10d, direction) >= 0
      : (sector.trendStructureScore ?? sector.strengthScore ?? 100) <= 40 && signed(sector.momentum10d, direction) >= 0
  const transitionMatches = matchingTransitions.length > 0
  const higherMatches = higherAlignment >= 58
  const maConfirms = maMatches >= 2

  const criteria: HexSelectorCriterion[] = [
    {
      key: 'sector',
      label: '業種構造',
      detail: mode === 'emerging'
        ? `構造変化 ${fmtSigned(sector.transitionChangeScore)}`
        : `トレンド構造 ${fmtSigned(sector.trendStructureScore ?? sector.strengthScore)}`,
      passed: sectorMatches,
    },
    {
      key: 'transition',
      label: 'ステージ遷移',
      detail: `${matchingTransitions.length}/6軸が${direction === 'up' ? '改善' : '悪化'}方向`,
      passed: transitionMatches,
    },
    {
      key: 'higher',
      label: '上位足整合',
      detail: `${higherAlignment}%`,
      passed: higherMatches,
    },
    {
      key: 'ma',
      label: 'MA確認',
      detail: `${maMatches}/4本が${direction === 'up' ? '上向き' : '下向き'}`,
      passed: maConfirms,
    },
    {
      key: 'evidence',
      label: '補助根拠',
      detail: relevantMlRank != null
        ? `ML ${direction === 'up' ? '上昇' : '下降'} ${relevantMlRank}位`
        : `PMS ${fmtSigned(input.physicalMomentumScore, 2)}`,
      passed: evidenceMatches,
    },
  ]

  const reasons = criteria.filter((item) => item.passed).map((item) => `${item.label}: ${item.detail}`)
  const warnings = criteria
    .filter((item) => !item.passed)
    .map((item) => `${item.label}は未確認`)
  if (sector.nStocks < 8) warnings.push(`業種標本 ${sector.nStocks}銘柄`)
  if ((input.volume ?? 0) <= 0) warnings.push('出来高未確認')

  const stageValues = SECTOR_STRUCTURE_AXES.map((axis) => input.stages[axis.key])
  const stageCode = stageValues.every((stage) => stage != null)
    ? stageValues.join('')
    : null

  return {
    ...input,
    stageCode,
    matchCount: criteria.filter((item) => item.passed).length,
    transitionMatches: matchingTransitions.length,
    higherAlignment,
    maMatches,
    relevantMlRank,
    criteria,
    reasons,
    warnings,
  }
}

export function sortHexSelectorCandidates(
  rows: HexSelectorCandidate[],
  mode: HexSelectorMode,
  direction: HexSelectorDirection,
) {
  const pms = (row: HexSelectorCandidate) => signed(row.physicalMomentumScore, direction)
  return [...rows].sort((a, b) => {
    if (mode === 'emerging' && b.transitionMatches !== a.transitionMatches) {
      return b.transitionMatches - a.transitionMatches
    }
    if (mode === 'continuation' && b.higherAlignment !== a.higherAlignment) {
      return b.higherAlignment - a.higherAlignment
    }
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount
    if (b.maMatches !== a.maMatches) return b.maMatches - a.maMatches
    if (pms(b) !== pms(a)) return pms(b) - pms(a)
    const aRank = a.relevantMlRank ?? Number.MAX_SAFE_INTEGER
    const bRank = b.relevantMlRank ?? Number.MAX_SAFE_INTEGER
    return aRank - bRank || a.ticker.localeCompare(b.ticker)
  })
}
