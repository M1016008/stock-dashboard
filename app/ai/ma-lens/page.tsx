import Link from 'next/link'
import { Suspense } from 'react'
import { PageTitle } from '@/components/layout/PageTitle'
import { Card, CardHeader } from '@/components/ui/Card'
import { HistoricalPatternSearchPanel } from '@/components/ai/HistoricalPatternSearchPanel'
import { execAll, execGet } from '@/lib/db/client'
import {
  dot,
  featureVector,
  heuristicScore,
  sigmoid,
  type CandidateExplanation,
  type CandidateReason,
  type MlFeatureProfile,
} from '@/lib/backtest/ml'
import {
  ML_PHYSICS_FEATURE_SET,
  type PhysicsCandidateExplanation,
  type PhysicsCandidateReason,
  type PhysicsDirection,
  type PhysicsFeatureProfile,
} from '@/lib/backtest/ml-physics'
import { MIN_DISPLAY_SIMILARITY_SCORE } from '@/lib/ml/similarity-threshold'
import {
  analyzePhysicsProfile,
  physicsStatusTone,
  type PhysicsAnalysis,
  type PhysicsStatus as PhysicsStatusLabel,
  type PullbackVerdict,
} from '@/lib/ml/physics-analysis'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type Direction = 'up' | 'down'
type MaKey = 'sma5' | 'sma25' | 'sma75' | 'sma200'

type Status = {
  firstFeatureDate: string | null
  latestFeatureDate: string | null
  latestLabelDate: string | null
  latestCandidateDate: string | null
  featureRowsLatest: number
  labelRowsLatest: number
  candidateRowsLatest: number
  modelCount: number
}

type CandidateRow = {
  as_of_date: string
  direction: Direction
  rank: number
  ticker: string
  name: string | null
  sector_large: string | null
  candidate_score: number
  model_name: string | null
  feature_json: string
  reason_json: string
  explanation_json: string
}

type ModelRow = {
  model_name: string
  model_type: string
  direction: Direction
  horizon_days: number
  feature_names_json: string
  weights_json: string
  intercept: number
  metrics_json: string
  trained_at: number
}

type EvaluationRow = {
  evaluation_date: string
  model_name: string | null
  direction: Direction
  horizon_days: number
  sample_count: number
  precision_at_20: number | null
  precision_at_50: number | null
  precision_at_80: number | null
  hit_rate: number | null
  median_return_pct: number | null
  avg_return_pct: number | null
  max_drawdown_pct: number | null
}

type SimilarRow = {
  as_of_date: string
  base_ticker: string
  rank: number
  similar_ticker: string
  similarity_score: number
  base_direction: Direction | null
  similar_direction: Direction | null
  payload_json: string
  reason_json: string
}

type PhysicsCandidateRow = {
  as_of_date: string
  direction: PhysicsDirection
  horizon_days: number
  rank: number
  ticker: string
  name: string | null
  sector_large: string | null
  candidate_score: number
  model_name: string | null
  feature_json: string
  reason_json: string
  explanation_json: string
}

type ParsedPhysicsCandidate = PhysicsCandidateRow & {
  profile: PhysicsFeatureProfile | null
  reason: Partial<PhysicsCandidateReason>
  explanation: Partial<PhysicsCandidateExplanation>
  analysis: PhysicsAnalysis
}

type PhysicsDataStatus = {
  latestDate: string | null
  rowsLatest: number
  candidateDate: string | null
  candidateRowsLatest: number
}

type PhysicsFeatureRow = {
  ticker: string
  date: string
  feature_json: string
  name: string | null
  sector_large: string | null
}

type ParsedPhysicsFlowRow = PhysicsFeatureRow & {
  profile: PhysicsFeatureProfile | null
  analysis: PhysicsAnalysis
}

type SimilarPayload = {
  base?: {
    name?: string | null
    stageCode?: string | null
  }
  similar?: {
    name?: string | null
    stageCode?: string | null
  }
}

type FeatureImportance = {
  feature: string
  label: string
  weight: number
  effect: string
}

type ParsedCandidate = CandidateRow & {
  profile: MlFeatureProfile | null
  reason: Partial<CandidateReason>
  explanation: Partial<CandidateExplanation>
}

type PullbackKind = 'healthy' | 'falling'

type PullbackFeatureRow = {
  ticker: string
  date: string
  feature_json: string
  vector_json: string | null
  name: string | null
  sector_large: string | null
}

type PullbackLensRow = {
  ticker: string
  name: string | null
  sector_large: string | null
  date: string
  kind: PullbackKind
  shapeScore: number
  upScore: number
  downScore: number
  verdict: Direction | 'neutral'
  profile: MlFeatureProfile
  reasons: string[]
  watchPoints: string[]
}

type MarginRow = {
  ticker: string
  margin_type: string | null
  long_margin: number | null
  short_margin: number | null
  long_change: number | null
  short_change: number | null
  credit_ratio: number | null
  short_ratio: number | null
}

type LongShortDecisionRow = {
  ticker: string
  name: string | null
  sector_large: string | null
  profile: MlFeatureProfile | null
  up: ParsedCandidate | null
  down: ParsedCandidate | null
  margin: MarginRow | null
  longEdge: number
  shortEdge: number
  decision: 'long' | 'short' | 'wait'
  expectation: string
  entryTrigger: string
  invalidation: string
  profitPlan: string
  stopPlan: string
  squeezeRisk: '低' | '中' | '高'
  squeezeReason: string
}

const MA_KEYS: MaKey[] = ['sma5', 'sma25', 'sma75', 'sma200']

const FEATURE_LABELS: Record<string, string> = {
  stageDailyA: '日足Aステージ',
  stageDailyB: '日足Bステージ',
  stageWeeklyA: '週足Aステージ',
  stageWeeklyB: '週足Bステージ',
  stageMonthlyA: '月足Aステージ',
  stageMonthlyB: '月足Bステージ',
  stageTrend: '6桁ステージの改善/悪化',
  maOrderBullish: 'MA並び: 短期線優位',
  maOrderBearish: 'MA並び: 長期線優位',
  sma5Slope5: '5日MAの5営業日変化率',
  sma25Slope5: '25日MAの5営業日変化率',
  sma75Slope5: '75日MAの5営業日変化率',
  sma200Slope5: '200日MAの5営業日変化率',
  sma5Slope10: '5日MAの10営業日変化率',
  sma25Slope10: '25日MAの10営業日変化率',
  sma75Slope10: '75日MAの10営業日変化率',
  sma200Slope10: '200日MAの10営業日変化率',
  gap5To25: '5日MAと25日MAの距離',
  gap25To75: '25日MAと75日MAの距離',
  gap75To200: '75日MAと200日MAの距離',
  priceToSma5: '株価と5日MAの位置',
  priceToSma25: '株価と25日MAの位置',
  priceToSma75: '株価と75日MAの位置',
  priceToSma200: '株価と200日MAの位置',
  daysAboveSma5: '5日MA上の維持日数',
  distanceToRecentHigh: '直近高値までの距離',
  brokeRecentHigh: '直近高値更新',
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return '未生成'
  return value.replaceAll('-', '/')
}

function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function fmtRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${Math.round(value * 100)}%`
}

function fmtScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toFixed(2)
}

function fmtShares(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}億株`
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(1)}万株`
  return `${Math.round(value).toLocaleString('ja-JP')}株`
}

function fmtCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return Math.round(value).toLocaleString('ja-JP')
}

function fmtUnix(seconds: number | null | undefined): string {
  if (!seconds) return '未生成'
  return new Date(seconds * 1000).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  })
}

function directionLabel(direction: Direction | null | undefined): string {
  return direction === 'down' ? '下落警戒' : '上昇候補'
}

function physicsDirectionLabel(direction: PhysicsDirection | null | undefined): string {
  if (direction === 'down') return '下落候補'
  if (direction === 'wait') return '見送り候補'
  return '上昇候補'
}

function physicsTone(direction: PhysicsDirection | null | undefined): 'red' | 'blue' | 'neutral' {
  if (direction === 'down') return 'blue'
  if (direction === 'wait') return 'neutral'
  return 'red'
}

function slopeText(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '不明'
  if (value >= 3) return `強い上向き ${fmtPct(value)}`
  if (value >= 0.5) return `上向き ${fmtPct(value)}`
  if (value <= -3) return `強い下向き ${fmtPct(value)}`
  if (value <= -0.5) return `下向き ${fmtPct(value)}`
  return `横ばい ${fmtPct(value)}`
}

function slopeTone(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'border-slate-200 bg-slate-50 text-slate-500'
  if (value >= 0.5) return 'border-red-200 bg-red-50 text-red-700'
  if (value <= -0.5) return 'border-blue-200 bg-blue-50 text-blue-700'
  return 'border-slate-200 bg-white text-slate-600'
}

function gapInterpretation(profile: MlFeatureProfile | null): string {
  if (!profile) return 'MA距離は未生成です。'
  const shortSlope = profile.slopes10.sma5
  const midSlope = profile.slopes10.sma25
  const gap = profile.gaps.sma5To25Pct
  if (gap == null || shortSlope == null || midSlope == null) return '5日-25日MAの距離は算出待ちです。'
  if (gap > 0 && shortSlope > midSlope) return '短期線が中期線の上で離れ始めており、上方向への勢いを確認する形です。'
  if (gap > 0 && shortSlope < midSlope) return '短期線は中期線の上ですが、距離は縮小しやすい形です。'
  if (gap < 0 && shortSlope > midSlope) return '短期線は中期線の下ですが、下から戻し始めている形です。'
  return '短期線が中期線の下で、戻りの弱さを確認する形です。'
}

function slopeValue(value: number | null | undefined): number {
  return finite(value) ? value : 0
}

function signedDistance(value: number | null | undefined): number {
  return finite(value) ? value : 0
}

function isBullishMa(profile: MlFeatureProfile | null): boolean {
  if (!profile) return false
  return profile.maOrder.replace(/\s/g, '').startsWith('5日>25日')
}

function isBearishMa(profile: MlFeatureProfile | null): boolean {
  if (!profile) return false
  return profile.maOrder.replace(/\s/g, '').startsWith('200日>75日') || profile.maOrder.replace(/\s/g, '').endsWith('25日>5日')
}

function maMomentum(profile: MlFeatureProfile | null): number {
  if (!profile) return 0
  return (
    slopeValue(profile.slopes10.sma5) * 0.34 +
    slopeValue(profile.slopes10.sma25) * 0.32 +
    slopeValue(profile.slopes10.sma75) * 0.22 +
    slopeValue(profile.slopes10.sma200) * 0.12
  ) / 10
}

function longEdgeScore(up: ParsedCandidate | null, down: ParsedCandidate | null, profile: MlFeatureProfile | null): number {
  const upScore = up?.candidate_score ?? 0
  const downScore = down?.candidate_score ?? 0
  const upsideRoom = profile?.distanceToRecentHighPct != null && profile.distanceToRecentHighPct < 0
    ? clamp(Math.abs(profile.distanceToRecentHighPct) / 40, 0, 0.28)
    : 0
  const maBonus = isBullishMa(profile) ? 0.14 : 0
  const supportBonus = profile && signedDistance(profile.pricePosition.sma25) >= -3 ? 0.06 : 0
  return clamp(upScore - downScore * 0.55 + maMomentum(profile) * 0.18 + upsideRoom + maBonus + supportBonus, -1, 1)
}

function shortEdgeScore(up: ParsedCandidate | null, down: ParsedCandidate | null, profile: MlFeatureProfile | null, margin: MarginRow | null): number {
  const upScore = up?.candidate_score ?? 0
  const downScore = down?.candidate_score ?? 0
  const maBonus = isBearishMa(profile) ? 0.16 : 0
  const weakPrice = profile && signedDistance(profile.pricePosition.sma25) < -2 ? 0.1 : 0
  const squeezePenalty = squeezeRiskScore(profile, margin) * 0.22
  return clamp(downScore - upScore * 0.55 - maMomentum(profile) * 0.18 + maBonus + weakPrice - squeezePenalty, -1, 1)
}

function squeezeRiskScore(profile: MlFeatureProfile | null, margin: MarginRow | null): number {
  const shortRatio = margin?.short_ratio ?? 0
  const shortChange = margin?.short_change ?? 0
  const longChange = margin?.long_change ?? 0
  const recoveringShortMa = profile ? signedDistance(profile.pricePosition.sma5) > 0 && slopeValue(profile.slopes5.sma5) > 0 : false
  const midSlopeImproving = profile ? slopeValue(profile.slopes10.sma25) > -0.2 : false
  const crowdedShort = shortRatio >= 45 || shortChange > Math.max(50_000, Math.abs(longChange) * 1.2)
  return clamp((crowdedShort ? 0.38 : 0) + (recoveringShortMa ? 0.34 : 0) + (midSlopeImproving ? 0.18 : 0) + (isBullishMa(profile) ? 0.1 : 0), 0, 1)
}

function squeezeRiskLabel(score: number): '低' | '中' | '高' {
  if (score >= 0.62) return '高'
  if (score >= 0.32) return '中'
  return '低'
}

function pullbackVerdictLabel(verdict: PullbackLensRow['verdict']): string {
  if (verdict === 'up') return '上昇寄り'
  if (verdict === 'down') return '下落寄り'
  return '要観察'
}

function pullbackVerdictClass(verdict: PullbackLensRow['verdict']): string {
  if (verdict === 'up') return 'border-red-200 bg-red-50 text-red-700'
  if (verdict === 'down') return 'border-blue-200 bg-blue-50 text-blue-700'
  return 'border-amber-200 bg-amber-50 text-amber-700'
}

function scoreProfileWithModel(profile: MlFeatureProfile, vector: number[], model: ModelRow | null, direction: Direction): number {
  if (!model) return heuristicScore(profile, direction)
  const weights = parseJson<number[]>(model.weights_json, [])
  if (weights.length === 0) return heuristicScore(profile, direction)
  return sigmoid(Number(model.intercept ?? 0) + dot(weights, vector))
}

function latestModel(models: ModelRow[], direction: Direction, horizonDays = 40): ModelRow | null {
  return (
    models
      .filter((model) => model.direction === direction)
      .sort((a, b) => {
        const horizonDistance = Math.abs(a.horizon_days - horizonDays) - Math.abs(b.horizon_days - horizonDays)
        if (horizonDistance !== 0) return horizonDistance
        return b.trained_at - a.trained_at
      })[0] ?? null
  )
}

function classifyPullbackShape(profile: MlFeatureProfile): Pick<PullbackLensRow, 'kind' | 'shapeScore' | 'reasons' | 'watchPoints'> | null {
  const priceTo5 = profile.pricePosition.sma5
  const priceTo25 = profile.pricePosition.sma25
  const priceTo75 = profile.pricePosition.sma75
  const priceTo200 = profile.pricePosition.sma200
  const gap5To25 = profile.gaps.sma5To25Pct
  const gap25To75 = profile.gaps.sma25To75Pct
  const slope5 = slopeValue(profile.slopes5.sma5)
  const slope25 = slopeValue(profile.slopes10.sma25)
  const slope75 = slopeValue(profile.slopes10.sma75)
  const slope200 = slopeValue(profile.slopes10.sma200)
  const nearShort = finite(priceTo5) && Math.abs(priceTo5) <= 6
  const nearMid = finite(priceTo25) && Math.abs(priceTo25) <= 8
  const aboveLongSupport = (!finite(priceTo75) || priceTo75 >= -4) && (!finite(priceTo200) || priceTo200 >= -10)
  const midLongSupport = slope25 >= -0.6 && slope75 >= -0.45 && slope200 >= -0.25
  const bearishOrder = profile.maOrder.replace(/\s/g, '').startsWith('200日>75日')
  const weakDistance = (finite(gap5To25) && gap5To25 < -5) || (finite(gap25To75) && gap25To75 < -4)
  const bearishBackDrop = bearishOrder || slope25 <= -0.9 || slope75 <= -0.6 || (weakDistance && finite(priceTo25) && priceTo25 < -4)
  const pullbackLike = nearShort || nearMid || (finite(priceTo5) && priceTo5 >= -3 && priceTo5 <= 10)

  if (!pullbackLike) return null

  if (midLongSupport && aboveLongSupport && !bearishBackDrop) {
    const score =
      0.32 +
      (nearShort ? 0.18 : 0) +
      (nearMid ? 0.14 : 0) +
      (slope25 > 0 ? 0.12 : 0) +
      (slope75 > 0 ? 0.1 : 0) +
      (finite(gap5To25) && gap5To25 >= -3 && gap5To25 <= 8 ? 0.1 : 0) +
      (finite(profile.daysHeldAboveSma5) && profile.daysHeldAboveSma5 >= 2 ? 0.04 : 0)
    return {
      kind: 'healthy',
      shapeScore: clamp(score, 0, 1),
      reasons: [
        `株価は5日MA比${fmtPct(priceTo5)}、25日MA比${fmtPct(priceTo25)}で、短期線または中期線の近くまで戻しています。`,
        `25日MAは${slopeText(profile.slopes10.sma25)}、75日MAは${slopeText(profile.slopes10.sma75)}で、中期から長期の土台が大きく崩れていません。`,
        `5日-25日MAの距離は${fmtPct(gap5To25)}で、過熱しすぎた上放れよりも押し目確認に近い形です。`,
      ],
      watchPoints: [
        '5日MAの上を維持し、25日MAが下向きに転じないかを確認します。',
        '直近高値まで戻る過程で、6桁ステージが悪化しないかを見ます。',
        '25日MAを明確に割り込む場合は、押し目ではなく下落への切り替えとして扱います。',
      ],
    }
  }

  if (bearishBackDrop || (finite(priceTo5) && priceTo5 > -2 && (slope5 < -0.5 || weakDistance))) {
    const score =
      0.28 +
      (bearishOrder ? 0.18 : 0) +
      (slope25 < -0.4 ? 0.14 : 0) +
      (slope75 < -0.3 ? 0.12 : 0) +
      (weakDistance ? 0.14 : 0) +
      (nearShort ? 0.08 : 0) +
      (finite(priceTo25) && priceTo25 < -4 ? 0.06 : 0)
    return {
      kind: 'falling',
      shapeScore: clamp(score, 0, 1),
      reasons: [
        `株価は5日MA付近に戻していますが、25日MA比は${fmtPct(priceTo25)}で、中期線の下に残る形です。`,
        `25日MAは${slopeText(profile.slopes10.sma25)}、75日MAは${slopeText(profile.slopes10.sma75)}で、押し目に見えても上位の流れは弱めです。`,
        `5日-25日MAの距離は${fmtPct(gap5To25)}、25日-75日MAの距離は${fmtPct(gap25To75)}で、短期反発が中期線に押し返されやすい形です。`,
      ],
      watchPoints: [
        '5日MA回復だけで判断せず、25日MAを回復して維持できるかを確認します。',
        '75日MAが下向きのままなら、反発より戻り売りになりやすい形として扱います。',
        '6桁ステージが改善しない場合は、下落継続の候補として注意します。',
      ],
    }
  }

  return null
}

function stageDigitClass(digit: string): string {
  const map: Record<string, string> = {
    '1': 'border-red-200 bg-red-50 text-red-700',
    '2': 'border-orange-200 bg-orange-50 text-orange-700',
    '3': 'border-amber-200 bg-amber-50 text-amber-700',
    '4': 'border-sky-200 bg-sky-50 text-sky-700',
    '5': 'border-blue-200 bg-blue-50 text-blue-700',
    '6': 'border-violet-200 bg-violet-50 text-violet-700',
  }
  return map[digit] ?? 'border-slate-200 bg-slate-50 text-slate-500'
}

function StageCode({ code }: { code: string | null | undefined }) {
  const value = code && code.length >= 6 ? code : '------'
  return (
    <span className="inline-flex items-center gap-1" aria-label={`6桁ステージ ${value}`}>
      {value.split('').slice(0, 6).map((digit, index) => (
        <span
          key={`${digit}-${index}`}
          className={`inline-flex h-6 w-6 items-center justify-center rounded-[3px] border text-[11px] font-bold ${stageDigitClass(digit)}`}
        >
          {digit}
        </span>
      ))}
    </span>
  )
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 py-2 shadow-sm">
      <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 text-[17px] font-bold tabular-nums text-[var(--color-brand-900)]">{value}</div>
      {sub && <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">{sub}</div>}
    </div>
  )
}

function Pill({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'red' | 'blue' | 'neutral' }) {
  const cls =
    tone === 'red'
      ? 'border-red-200 bg-red-50 text-red-700'
      : tone === 'blue'
        ? 'border-blue-200 bg-blue-50 text-blue-700'
        : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'
  return <span className={`inline-flex items-center rounded-[3px] border px-2 py-1 text-[11px] font-bold ${cls}`}>{children}</span>
}

function physicsBadgeClass(status: PhysicsStatusLabel | PullbackVerdict | null | undefined): string {
  if (!status) return 'border-slate-200 bg-slate-50 text-slate-600'
  const tone = physicsStatusTone(status as PhysicsStatusLabel)
  if (status === '上昇加速' || status === '上昇継続' || status === '押し目形成' || status === '反発準備' || status === '本物の押し目に近い') {
    return 'border-red-200 bg-red-50 text-red-700'
  }
  if (status === '下落加速' || status === '失速警戒' || status === '下落途中の一時反発' || status === '反発は弱い') {
    return 'border-blue-200 bg-blue-50 text-blue-700'
  }
  if (status === '過熱注意' || tone === 'amber') return 'border-amber-200 bg-amber-50 text-amber-700'
  return 'border-slate-200 bg-slate-50 text-slate-600'
}

function PhysicsBadge({ children, status }: { children: React.ReactNode; status: PhysicsStatusLabel | PullbackVerdict | null | undefined }) {
  return (
    <span className={`inline-flex items-center rounded-[3px] border px-2 py-1 text-[11px] font-bold ${physicsBadgeClass(status)}`}>
      {children}
    </span>
  )
}

function PhysicsMiniMetric({ label, value }: { label: string; value: number | null | undefined }) {
  const cls = !finite(value)
    ? 'text-[var(--color-text-tertiary)]'
    : value > 0
      ? 'text-red-700'
      : value < 0
        ? 'text-blue-700'
        : 'text-[var(--color-text-secondary)]'
  return (
    <div className="rounded-[4px] border border-[var(--color-border-default)] bg-white px-2.5 py-2">
      <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-1 text-[13px] font-bold tabular-nums ${cls}`}>{fmtPct(value)}</div>
    </div>
  )
}

function physicsStrength(row: ParsedPhysicsFlowRow): number {
  const m = row.analysis.metrics
  return (
    slopeValue(m.sma5Velocity5) * 0.34 +
    slopeValue(m.sma25Velocity5) * 0.24 +
    slopeValue(m.sma5Acceleration5) * 0.22 +
    slopeValue(m.gap5To25Velocity5) * 0.14 +
    slopeValue(m.gap25To75Velocity5) * 0.06
  )
}

function PhysicsFlowMiniCard({ row }: { row: ParsedPhysicsFlowRow }) {
  const m = row.analysis.metrics
  return (
    <div className="rounded-[4px] border border-[var(--color-border-default)] bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <PhysicsBadge status={row.analysis.physicsStatus}>{row.analysis.physicsStatus}</PhysicsBadge>
            <PhysicsBadge status={row.analysis.pullbackVerdict}>{row.analysis.pullbackVerdict}</PhysicsBadge>
          </div>
          <Link href={`/stock/${row.ticker}`} prefetch={false} className="mt-2 inline-flex text-[15px] font-bold text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]">
            {row.ticker} {row.name ?? ''}
          </Link>
          <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{row.sector_large ?? '業種未設定'} / {fmtDate(row.date)}</div>
        </div>
        <StageCode code={row.profile?.stageCode} />
      </div>
      <p className="mt-3 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{row.analysis.summary}</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <PhysicsMiniMetric label="5SMA速度" value={m.sma5Velocity5} />
        <PhysicsMiniMetric label="5SMA加速度" value={m.sma5Acceleration5} />
        <PhysicsMiniMetric label="5-25距離" value={m.gap5To25Pct} />
        <PhysicsMiniMetric label="距離変化" value={m.gap5To25Velocity5} />
      </div>
    </div>
  )
}

async function latestColumnDate(table: string, column: string): Promise<string | null> {
  const row = await execGet<{ date: string | null }>(
    `SELECT ${column} AS date FROM ${table} WHERE ${column} IS NOT NULL ORDER BY ${column} DESC LIMIT 1`,
  )
  return row?.date ?? null
}

async function firstFeatureDate(): Promise<string | null> {
  const row = await execGet<{ date: string | null }>(
    `SELECT date FROM ml_feature_vectors WHERE date IS NOT NULL ORDER BY date ASC LIMIT 1`,
  )
  return row?.date ?? null
}

async function countRows(sql: string, args: Array<string | number> = []): Promise<number> {
  const row = await execGet<{ count: number }>(sql, args)
  return Number(row?.count ?? 0)
}

async function loadStatus(): Promise<Status> {
  const latestFeatureDate = await latestColumnDate('ml_feature_vectors', 'date')
  const latestLabelDate = await latestColumnDate('ml_training_labels', 'date')
  const latestCandidateDate = await latestColumnDate('serving_ml_candidates', 'as_of_date')
  const [first, featureRowsLatest, labelRowsLatest, candidateRowsLatest, modelCount] = await Promise.all([
    firstFeatureDate(),
    latestFeatureDate
      ? countRows(`SELECT COUNT(*) AS count FROM ml_feature_vectors WHERE date = ?`, [latestFeatureDate])
      : Promise.resolve(0),
    latestLabelDate
      ? countRows(`SELECT COUNT(*) AS count FROM ml_training_labels WHERE date = ? AND horizon_days = 40`, [latestLabelDate])
      : Promise.resolve(0),
    latestCandidateDate
      ? countRows(`SELECT COUNT(*) AS count FROM serving_ml_candidates WHERE as_of_date = ?`, [latestCandidateDate])
      : Promise.resolve(0),
    countRows(`SELECT COUNT(*) AS count FROM ml_models`),
  ])
  return {
    firstFeatureDate: first,
    latestFeatureDate,
    latestLabelDate,
    latestCandidateDate,
    featureRowsLatest,
    labelRowsLatest,
    candidateRowsLatest,
    modelCount,
  }
}

async function loadCandidates(): Promise<ParsedCandidate[]> {
  const rows = await execAll<CandidateRow>(
    `
    WITH latest AS (SELECT as_of_date AS date FROM serving_ml_candidates WHERE as_of_date IS NOT NULL ORDER BY as_of_date DESC LIMIT 1)
    SELECT c.as_of_date, c.direction, c.rank, c.ticker, c.name, c.sector_large,
           c.candidate_score, c.model_name, c.feature_json, c.reason_json, c.explanation_json
    FROM serving_ml_candidates c
    INNER JOIN latest l ON l.date = c.as_of_date
    WHERE c.rank <= 6
    ORDER BY CASE c.direction WHEN 'up' THEN 0 ELSE 1 END, c.rank ASC
    `,
  )
  return rows.map((row) => ({
    ...row,
    profile: parseJson<MlFeatureProfile | null>(row.feature_json, null),
    reason: parseJson<Partial<CandidateReason>>(row.reason_json, {}),
    explanation: parseJson<Partial<CandidateExplanation>>(row.explanation_json, {}),
  }))
}

async function loadCandidatePool(): Promise<ParsedCandidate[]> {
  const rows = await execAll<CandidateRow>(
    `
    WITH latest AS (SELECT as_of_date AS date FROM serving_ml_candidates WHERE as_of_date IS NOT NULL ORDER BY as_of_date DESC LIMIT 1)
    SELECT c.as_of_date, c.direction, c.rank, c.ticker, c.name, c.sector_large,
           c.candidate_score, c.model_name, c.feature_json, c.reason_json, c.explanation_json
    FROM serving_ml_candidates c
    INNER JOIN latest l ON l.date = c.as_of_date
    WHERE c.rank <= 8
    ORDER BY c.ticker ASC, CASE c.direction WHEN 'up' THEN 0 ELSE 1 END
    `,
  )
  return rows.map((row) => ({
    ...row,
    profile: parseJson<MlFeatureProfile | null>(row.feature_json, null),
    reason: parseJson<Partial<CandidateReason>>(row.reason_json, {}),
    explanation: parseJson<Partial<CandidateExplanation>>(row.explanation_json, {}),
  }))
}

async function loadMarginRows(tickers: string[]): Promise<Map<string, MarginRow>> {
  const unique = Array.from(new Set(tickers.filter(Boolean)))
  if (unique.length === 0) return new Map()
  const placeholders = unique.map(() => '?').join(',')
  const rows = await execAll<MarginRow>(
    `
    SELECT ticker, margin_type, long_margin, short_margin, long_change, short_change,
           credit_ratio, short_ratio
    FROM serving_margin_latest
    WHERE ticker IN (${placeholders})
    `,
    unique,
  )
  return new Map(rows.map((row) => [row.ticker, row]))
}

async function loadModels(): Promise<ModelRow[]> {
  return execAll<ModelRow>(
    `
    SELECT m.model_name, m.model_type, m.direction, m.horizon_days,
           m.feature_names_json, m.weights_json, m.intercept, m.metrics_json, m.trained_at
    FROM ml_models m
    INNER JOIN (
      SELECT direction, horizon_days, MAX(trained_at) AS trained_at
      FROM ml_models
      WHERE model_type = 'logistic_regression_v1'
        AND direction IN ('up', 'down')
      GROUP BY direction, horizon_days
    ) latest
      ON latest.direction = m.direction
     AND latest.horizon_days = m.horizon_days
     AND latest.trained_at = m.trained_at
    WHERE m.model_type = 'logistic_regression_v1'
      AND m.direction IN ('up', 'down')
    ORDER BY m.horizon_days ASC, CASE m.direction WHEN 'up' THEN 0 ELSE 1 END
    LIMIT 12
    `,
  )
}

async function loadPhysicsStatus(): Promise<PhysicsDataStatus> {
  const latestDate = (await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM ml_feature_vectors_v2 WHERE feature_set = ?`,
    [ML_PHYSICS_FEATURE_SET],
  ))?.date ?? null
  const candidateDate = await latestColumnDate('serving_ml_physics_candidates', 'as_of_date')
  const [rowsLatest, candidateRowsLatest] = await Promise.all([
    latestDate
      ? countRows(`SELECT COUNT(*) AS count FROM ml_feature_vectors_v2 WHERE feature_set = ? AND date = ?`, [ML_PHYSICS_FEATURE_SET, latestDate])
      : Promise.resolve(0),
    candidateDate
      ? countRows(`SELECT COUNT(*) AS count FROM serving_ml_physics_candidates WHERE as_of_date = ?`, [candidateDate])
      : Promise.resolve(0),
  ])
  return { latestDate, rowsLatest, candidateDate, candidateRowsLatest }
}

async function loadPhysicsCandidates(horizonDays = 10): Promise<ParsedPhysicsCandidate[]> {
  const rows = await execAll<PhysicsCandidateRow>(
    `
    WITH latest AS (SELECT as_of_date AS date FROM serving_ml_physics_candidates WHERE as_of_date IS NOT NULL ORDER BY as_of_date DESC LIMIT 1)
    SELECT c.as_of_date, c.direction, c.horizon_days, c.rank, c.ticker, c.name, c.sector_large,
           c.candidate_score, c.model_name, c.feature_json, c.reason_json, c.explanation_json
    FROM serving_ml_physics_candidates c
    INNER JOIN latest l ON l.date = c.as_of_date
    WHERE c.horizon_days = ?
      AND c.rank <= 8
    ORDER BY CASE c.direction WHEN 'up' THEN 0 WHEN 'down' THEN 1 ELSE 2 END, c.rank ASC
    `,
    [horizonDays],
  )
  return rows.map((row) => {
    const profile = parseJson<PhysicsFeatureProfile | null>(row.feature_json, null)
    return {
      ...row,
      profile,
      reason: parseJson<Partial<PhysicsCandidateReason>>(row.reason_json, {}),
      explanation: parseJson<Partial<PhysicsCandidateExplanation>>(row.explanation_json, {}),
      analysis: analyzePhysicsProfile(profile),
    }
  })
}

async function loadPhysicsFlowRows(): Promise<ParsedPhysicsFlowRow[]> {
  const rows = await execAll<PhysicsFeatureRow>(
    `
    WITH latest AS (
      SELECT date
      FROM ml_feature_vectors_v2
      WHERE feature_set = ?
        AND date IS NOT NULL
      ORDER BY date DESC
      LIMIT 1
    )
    SELECT f.ticker, f.date, f.feature_json,
           COALESCE(u.name, sm.name) AS name,
           COALESCE(u.sector17_name, sm.sector_large) AS sector_large
    FROM ml_feature_vectors_v2 f
    INNER JOIN latest l ON l.date = f.date
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    LEFT JOIN sector_master sm ON sm.ticker = f.ticker
    WHERE f.feature_set = ?
      AND f.feature_json IS NOT NULL
    `,
    [ML_PHYSICS_FEATURE_SET, ML_PHYSICS_FEATURE_SET],
  )
  return rows.map((row) => {
    const profile = parseJson<PhysicsFeatureProfile | null>(row.feature_json, null)
    return {
      ...row,
      profile,
      analysis: analyzePhysicsProfile(profile),
    }
  })
}

async function loadPullbackLens(models: ModelRow[]): Promise<PullbackLensRow[]> {
  const upModel = latestModel(models, 'up', 40)
  const downModel = latestModel(models, 'down', 40)
  const rows = await execAll<PullbackFeatureRow>(
    `
    WITH latest AS (SELECT date FROM ml_feature_vectors WHERE date IS NOT NULL ORDER BY date DESC LIMIT 1)
    SELECT f.ticker, f.date, f.feature_json, f.vector_json,
           COALESCE(u.name, sm.name) AS name,
           COALESCE(u.sector17_name, sm.sector_large) AS sector_large
    FROM ml_feature_vectors f
    INNER JOIN latest l ON l.date = f.date
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    LEFT JOIN sector_master sm ON sm.ticker = f.ticker
    WHERE f.feature_json IS NOT NULL
    `,
  )

  const candidates: PullbackLensRow[] = []
  for (const row of rows) {
    const profile = parseJson<MlFeatureProfile | null>(row.feature_json, null)
    if (!profile) continue
    const shape = classifyPullbackShape(profile)
    if (!shape) continue
    const storedVector = parseJson<number[] | null>(row.vector_json, null)
    const vector = storedVector && storedVector.length > 0 ? storedVector : featureVector(profile)
    const upScore = scoreProfileWithModel(profile, vector, upModel, 'up')
    const downScore = scoreProfileWithModel(profile, vector, downModel, 'down')
    const margin = upScore - downScore
    const verdict: PullbackLensRow['verdict'] = margin >= 0.08 ? 'up' : margin <= -0.08 ? 'down' : 'neutral'
    candidates.push({
      ticker: row.ticker,
      name: row.name,
      sector_large: row.sector_large,
      date: row.date,
      kind: shape.kind,
      shapeScore: shape.shapeScore,
      upScore,
      downScore,
      verdict,
      profile,
      reasons: shape.reasons,
      watchPoints: shape.watchPoints,
    })
  }

  const healthy = candidates
    .filter((candidate) => candidate.kind === 'healthy')
    .sort((a, b) => b.upScore - a.upScore || b.shapeScore - a.shapeScore || a.ticker.localeCompare(b.ticker))
    .slice(0, 8)
  const falling = candidates
    .filter((candidate) => candidate.kind === 'falling')
    .sort((a, b) => b.downScore - a.downScore || b.shapeScore - a.shapeScore || a.ticker.localeCompare(b.ticker))
    .slice(0, 8)
  return [...healthy, ...falling]
}

async function loadEvaluations(): Promise<EvaluationRow[]> {
  return execAll<EvaluationRow>(
    `
    WITH latest AS (SELECT evaluation_date AS date FROM ml_model_evaluations WHERE evaluation_date IS NOT NULL ORDER BY evaluation_date DESC LIMIT 1)
    SELECT evaluation_date, model_name, direction, horizon_days, sample_count,
           precision_at_20, precision_at_50, precision_at_80, hit_rate,
           median_return_pct, avg_return_pct, max_drawdown_pct
    FROM ml_model_evaluations e
    INNER JOIN latest l ON l.date = e.evaluation_date
    ORDER BY horizon_days ASC, CASE direction WHEN 'up' THEN 0 ELSE 1 END
    LIMIT 8
    `,
  )
}

async function loadEvaluationTimeline(): Promise<EvaluationRow[]> {
  return execAll<EvaluationRow>(
    `
    SELECT evaluation_date, model_name, direction, horizon_days, sample_count,
           precision_at_20, precision_at_50, precision_at_80, hit_rate,
           median_return_pct, avg_return_pct, max_drawdown_pct
    FROM ml_model_evaluations
    ORDER BY evaluation_date DESC, horizon_days ASC, CASE direction WHEN 'up' THEN 0 ELSE 1 END
    LIMIT 24
    `,
  )
}

async function loadSimilarRows(): Promise<SimilarRow[]> {
  return execAll<SimilarRow>(
    `
    WITH latest AS (SELECT as_of_date AS date FROM serving_current_similars WHERE as_of_date IS NOT NULL ORDER BY as_of_date DESC LIMIT 1)
    SELECT s.as_of_date, s.base_ticker, s.rank, s.similar_ticker, s.similarity_score,
           s.base_direction, s.similar_direction, s.payload_json, s.reason_json
    FROM serving_current_similars s
    INNER JOIN latest l ON l.date = s.as_of_date
    WHERE s.rank = 1
      AND s.similarity_score >= ?
    ORDER BY s.similarity_score DESC
    LIMIT 10
    `,
    [MIN_DISPLAY_SIMILARITY_SCORE],
  )
}

function byTickerAndDirection(candidates: ParsedCandidate[]): Map<string, { up: ParsedCandidate | null; down: ParsedCandidate | null }> {
  const map = new Map<string, { up: ParsedCandidate | null; down: ParsedCandidate | null }>()
  for (const candidate of candidates) {
    const current = map.get(candidate.ticker) ?? { up: null, down: null }
    if (candidate.direction === 'up') current.up = candidate
    else current.down = candidate
    map.set(candidate.ticker, current)
  }
  return map
}

function representativeProfile(up: ParsedCandidate | null, down: ParsedCandidate | null): MlFeatureProfile | null {
  return up?.profile ?? down?.profile ?? null
}

function entryTrigger(direction: Direction, profile: MlFeatureProfile | null): string {
  if (!profile) return '特徴量生成後に判定します。'
  if (direction === 'up') {
    if (signedDistance(profile.pricePosition.sma5) < 0) return '終値で5日MAを回復し、翌日も5日MA上を維持できるかを確認します。'
    if (signedDistance(profile.pricePosition.sma25) < 0) return '25日MA回復、または25日MAを抵抗線にしない値動きを確認します。'
    if (profile.distanceToRecentHighPct != null && profile.distanceToRecentHighPct > -5) return '直近高値を更新し、5日MAの上で引けるかを確認します。'
    return '5日MA上を維持しながら、25日MAの角度が上向きを保つかを確認します。'
  }
  if (signedDistance(profile.pricePosition.sma5) > 0) return '終値で5日MAを再び下回り、戻りが失敗したことを確認します。'
  if (signedDistance(profile.pricePosition.sma25) > -2) return '25日MA付近で上値が止まり、5日MAが下向きに戻るかを確認します。'
  return '5日MAを回復できず、25日MAとの差が縮まらないことを確認します。'
}

function invalidationRule(direction: Direction, profile: MlFeatureProfile | null): string {
  if (!profile) return '特徴量未生成のため未判定です。'
  if (direction === 'up') {
    if (signedDistance(profile.pricePosition.sma25) >= 0) return '終値で25日MAを明確に割る場合は、買い優勢の前提を外します。'
    return '5日MA回復に失敗し、25日MAも下向きへ変わる場合は見送りにします。'
  }
  if (signedDistance(profile.pricePosition.sma25) <= 0) return '終値で25日MAを回復して維持する場合は、空売り前提を外します。'
  return '5日MAと25日MAを同時に回復する場合は、踏み上げリスクを優先します。'
}

function profitPlan(direction: Direction, profile: MlFeatureProfile | null): string {
  if (!profile) return '価格目標は特徴量生成後に判定します。'
  if (direction === 'up') {
    if (profile.recentHigh != null && profile.distanceToRecentHighPct != null && profile.distanceToRecentHighPct < 0) {
      return `第1目標は直近高値${Math.round(profile.recentHigh).toLocaleString('ja-JP')}円付近、余力があれば高値更新後の5日MA維持を見ます。`
    }
    return '直近高値更新後、5日MAを割らない限り利益を伸ばし、25日MAの角度鈍化で一部利確を検討します。'
  }
  if (signedDistance(profile.pricePosition.sma25) > 0 && profile.sma.sma25 != null) {
    return `第1目標は25日MA${Math.round(profile.sma.sma25).toLocaleString('ja-JP')}円付近、割り込めば75日MA方向を確認します。`
  }
  if (profile.sma.sma75 != null) return `第1目標は75日MA${Math.round(profile.sma.sma75).toLocaleString('ja-JP')}円付近、戻りが弱ければ下落継続を見ます。`
  return '5日MAを回復できない間は下落継続を見ます。'
}

function stopPlan(direction: Direction, profile: MlFeatureProfile | null): string {
  if (!profile) return '撤退条件は特徴量生成後に判定します。'
  if (direction === 'up') {
    if (profile.sma.sma25 != null) return `終値で25日MA${Math.round(profile.sma.sma25).toLocaleString('ja-JP')}円を明確に下回る場合は撤退を検討します。`
    return '終値で5日MAを割り、翌日も回復できない場合は撤退を検討します。'
  }
  if (profile.sma.sma25 != null) return `終値で25日MA${Math.round(profile.sma.sma25).toLocaleString('ja-JP')}円を回復する場合は買い戻しを検討します。`
  return '終値で5日MAを回復し、5日MAが上向きへ転じる場合は買い戻しを検討します。'
}

function squeezeReason(profile: MlFeatureProfile | null, margin: MarginRow | null, risk: '低' | '中' | '高'): string {
  if (!profile && !margin) return '貸借/信用またはMA特徴量が不足しているため、踏み上げリスクは保守的に確認します。'
  const parts: string[] = []
  if (margin?.short_ratio != null) parts.push(`売残比率${fmtPct(margin.short_ratio, 0)}`)
  if (margin?.short_change != null) parts.push(`売残増減${fmtShares(margin.short_change)}`)
  if (profile && signedDistance(profile.pricePosition.sma5) > 0) parts.push('株価が5日MA上')
  if (profile && slopeValue(profile.slopes5.sma5) > 0) parts.push('5日MAが上向き')
  if (parts.length === 0) return `踏み上げリスクは${risk}です。売残集中と短期MA回復を継続確認します。`
  return `踏み上げリスクは${risk}です。${parts.join('、')}を確認しています。`
}

function buildLongShortRows(candidates: ParsedCandidate[], marginMap: Map<string, MarginRow>): LongShortDecisionRow[] {
  const grouped = byTickerAndDirection(candidates)
  return Array.from(grouped.entries()).map(([ticker, pair]) => {
    const profile = representativeProfile(pair.up, pair.down)
    const margin = marginMap.get(ticker) ?? null
    const longEdge = longEdgeScore(pair.up, pair.down, profile)
    const shortEdge = shortEdgeScore(pair.up, pair.down, profile, margin)
    const decision: LongShortDecisionRow['decision'] =
      longEdge >= shortEdge + 0.18 && longEdge > 0.25
        ? 'long'
        : shortEdge >= longEdge + 0.18 && shortEdge > 0.25
          ? 'short'
          : 'wait'
    const squeezeScore = squeezeRiskScore(profile, margin)
    const squeezeRisk = squeezeRiskLabel(squeezeScore)
    const direction: Direction = decision === 'short' ? 'down' : 'up'
    return {
      ticker,
      name: pair.up?.name ?? pair.down?.name ?? null,
      sector_large: pair.up?.sector_large ?? pair.down?.sector_large ?? null,
      profile,
      up: pair.up,
      down: pair.down,
      margin,
      longEdge,
      shortEdge,
      decision,
      expectation:
        decision === 'long'
          ? '買い期待が売りリスクを上回ります。5日/25日MAの維持を条件に上昇側を優先して確認します。'
          : decision === 'short'
            ? '売り期待が買い戻しリスクを上回ります。短期MAを回復できない戻り売り形状として確認します。'
            : '買いと売りの根拠が拮抗しています。条件成立まで待つ前提で扱います。',
      entryTrigger: entryTrigger(direction, profile),
      invalidation: invalidationRule(direction, profile),
      profitPlan: profitPlan(direction, profile),
      stopPlan: stopPlan(direction, profile),
      squeezeRisk,
      squeezeReason: squeezeReason(profile, margin, squeezeRisk),
    }
  }).filter((row) => row.profile || row.up || row.down)
    .sort((a, b) => Math.max(b.longEdge, b.shortEdge) - Math.max(a.longEdge, a.shortEdge) || (a.up?.rank ?? a.down?.rank ?? 999) - (b.up?.rank ?? b.down?.rank ?? 999))
}

function featureImportance(model: ModelRow): FeatureImportance[] {
  const features = parseJson<string[]>(model.feature_names_json, [])
  const weights = parseJson<number[]>(model.weights_json, [])
  return features
    .map((feature, index) => {
      const weight = Number(weights[index] ?? 0)
      return {
        feature,
        label: FEATURE_LABELS[feature] ?? feature,
        weight,
        effect:
          weight >= 0
            ? `${directionLabel(model.direction)}の判定を押し上げる`
            : `${directionLabel(model.direction)}では慎重に見る`,
      }
    })
    .filter((item) => Number.isFinite(item.weight))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, 6)
}

function FeatureInputGrid() {
  const groups = [
    {
      title: '6桁ステージ',
      body: '日足A・日足B・週足A・週足B・月足A・月足Bを1セットにし、前回から改善したか悪化したかも特徴量にします。',
    },
    {
      title: 'MA角度',
      body: '5/25/75/200日MAについて、直近5営業日と10営業日の変化率を見ます。点ではなく、線の向きとして扱います。',
    },
    {
      title: 'MA距離',
      body: '5-25、25-75、75-200日MAの乖離率を見ます。距離が広がる局面、縮む局面、反発しやすい局面を分けます。',
    },
    {
      title: '株価位置',
      body: '終値が各MAのどちら側にいるか、5日MAの上を何日維持したか、直近高値までの距離を組み合わせます。',
    },
    {
      title: '地合い/業種',
      body: '市場全体の短期トレンド、17業種/33業種の強弱、業種内順位を補助軸にし、同じ形でも追い風か逆風かを分けます。',
    },
    {
      title: '時間経過/リスク',
      body: 'ステージ継続日数、5日SMA上抜けからの経過、最大下落率や失敗パターンを使い、初動か伸び切りかを確認します。',
    },
  ]
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {groups.map((group) => (
        <div key={group.title} className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
          <div className="text-[13px] font-bold text-[var(--color-brand-900)]">{group.title}</div>
          <p className="mt-2 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{group.body}</p>
        </div>
      ))}
    </div>
  )
}

function MaFlowGrid({ profile }: { profile: MlFeatureProfile | null }) {
  if (!profile) return <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">特徴量は未生成です。</div>
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {MA_KEYS.map((key) => (
        <div key={key} className={`rounded-[4px] border px-2.5 py-2 ${slopeTone(profile.slopes10[key])}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold">{key.replace('sma', '')}日MA</span>
            <span className="text-[11px] font-bold tabular-nums">{slopeText(profile.slopes10[key])}</span>
          </div>
          <div className="mt-1 text-[10px] font-semibold opacity-80">
            株価位置 {fmtPct(profile.pricePosition[key])}
          </div>
        </div>
      ))}
    </div>
  )
}

function CandidateCard({ candidate }: { candidate: ParsedCandidate }) {
  const tone = candidate.direction === 'up' ? 'red' : 'blue'
  const profile = candidate.profile
  return (
    <Card size="sm" className="h-full">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={tone}>{directionLabel(candidate.direction)}</Pill>
            <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">#{candidate.rank}</span>
          </div>
          <Link href={`/stock/${candidate.ticker}`} prefetch={false} className="mt-2 inline-flex text-[17px] font-bold text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]">
            {candidate.ticker} {candidate.name ?? ''}
          </Link>
          <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{candidate.sector_large ?? '業種未設定'}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">候補強度</div>
          <div className="text-[18px] font-bold tabular-nums text-[var(--color-brand-900)]">{fmtRatio(candidate.candidate_score)}</div>
        </div>
      </div>

      <div className="mt-3">
        <StageCode code={profile?.stageCode} />
      </div>

      <div className="mt-3 space-y-3">
        <MaFlowGrid profile={profile} />
        <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
          <div className="text-[12px] font-bold text-[var(--color-brand-900)]">MA距離の読み</div>
          <p className="mt-1 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{gapInterpretation(profile)}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Pill>5-25 {fmtPct(profile?.gaps.sma5To25Pct)}</Pill>
            <Pill>25-75 {fmtPct(profile?.gaps.sma25To75Pct)}</Pill>
            <Pill>75-200 {fmtPct(profile?.gaps.sma75To200Pct)}</Pill>
          </div>
        </div>
        {candidate.explanation.summary && (
          <p className="text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{candidate.explanation.summary}</p>
        )}
        <div className="grid gap-2">
          {(['stage', 'maAngle', 'maDistance', 'pricePosition', 'mlEvidence'] as const).map((key) => (
            candidate.reason[key] ? (
              <div key={key} className="rounded-[4px] border border-[var(--color-border-default)] bg-white px-2.5 py-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
                {candidate.reason[key]}
              </div>
            ) : null
          ))}
        </div>
      </div>
    </Card>
  )
}

function ScoreBar({ label, value, tone }: { label: string; value: number; tone: 'red' | 'blue' | 'neutral' }) {
  const color =
    tone === 'red'
      ? 'bg-red-500'
      : tone === 'blue'
        ? 'bg-blue-500'
        : 'bg-slate-400'
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-bold text-[var(--color-text-secondary)]">
        <span>{label}</span>
        <span className="tabular-nums">{fmtRatio(value)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${clamp(value, 0, 1) * 100}%` }} />
      </div>
    </div>
  )
}

function PullbackLensCard({ row }: { row: PullbackLensRow }) {
  const isHealthy = row.kind === 'healthy'
  const headline = isHealthy ? '押し目候補' : '押し目風の下落注意'
  const kindTone = isHealthy ? 'red' : 'blue'
  return (
    <Card size="sm" className="h-full">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={kindTone}>{headline}</Pill>
            <span className={`inline-flex items-center rounded-[3px] border px-2 py-1 text-[11px] font-bold ${pullbackVerdictClass(row.verdict)}`}>
              {pullbackVerdictLabel(row.verdict)}
            </span>
          </div>
          <Link href={`/stock/${row.ticker}`} prefetch={false} className="mt-2 inline-flex text-[17px] font-bold text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]">
            {row.ticker} {row.name ?? ''}
          </Link>
          <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{row.sector_large ?? '業種未設定'} / 基準日 {fmtDate(row.date)}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">形状一致</div>
          <div className="text-[18px] font-bold tabular-nums text-[var(--color-brand-900)]">{fmtRatio(row.shapeScore)}</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StageCode code={row.profile.stageCode} />
        <Pill>{row.profile.maOrder || 'MA並び未生成'}</Pill>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <ScoreBar label="ML上昇寄り" value={row.upScore} tone="red" />
        <ScoreBar label="ML下落寄り" value={row.downScore} tone="blue" />
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Pill>株価-5日 {fmtPct(row.profile.pricePosition.sma5)}</Pill>
        <Pill>株価-25日 {fmtPct(row.profile.pricePosition.sma25)}</Pill>
        <Pill>5-25 {fmtPct(row.profile.gaps.sma5To25Pct)}</Pill>
        <Pill>25-75 {fmtPct(row.profile.gaps.sma25To75Pct)}</Pill>
      </div>

      <div className="mt-3 rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
        <div className="text-[12px] font-bold text-[var(--color-brand-900)]">物理的な読み</div>
        <div className="mt-2 grid gap-1.5">
          {row.reasons.map((reason) => (
            <p key={reason} className="text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
              {reason}
            </p>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <div className="text-[12px] font-bold text-[var(--color-brand-900)]">次に見る点</div>
        <div className="mt-2 grid gap-1.5">
          {row.watchPoints.map((point) => (
            <div key={point} className="rounded-[4px] border border-[var(--color-border-default)] bg-white px-2.5 py-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
              {point}
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}

function PullbackLensPanel({ rows }: { rows: PullbackLensRow[] }) {
  const healthyRows = rows.filter((row) => row.kind === 'healthy')
  const fallingRows = rows.filter((row) => row.kind === 'falling')
  if (rows.length === 0) {
    return (
      <Card size="lg">
        <CardHeader
          title="押し目 Lens"
          hint="最新日の全銘柄から、押し目に見えるMA形状を探します。"
        />
        <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">
          最新特徴量からは、押し目候補として十分なMA形状がまだ見つかっていません。
        </div>
      </Card>
    )
  }
  return (
    <Card size="lg">
      <CardHeader
        title="押し目 Lens"
        hint="最新日の全銘柄を対象に、MAの角度・並び・距離・株価位置から、押し目に見える形を上昇寄り/下落寄りに仕分けします。"
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-3">
          <div>
            <div className="text-[14px] font-bold text-red-700">上昇につながりやすい押し目</div>
            <p className="mt-1 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
              中期・長期MAの土台が崩れず、株価が短期線や25日線付近まで戻した形です。過去モデルでは、再上昇に向かうかを確認する候補として扱います。
            </p>
          </div>
          <div className="grid gap-3">
            {healthyRows.map((row) => <PullbackLensCard key={`${row.kind}-${row.ticker}`} row={row} />)}
          </div>
        </div>
        <div className="space-y-3">
          <div>
            <div className="text-[14px] font-bold text-blue-700">押し目に見える下落継続注意</div>
            <p className="mt-1 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
              短期的には反発して見えても、25日・75日MAの向きや距離が弱く、戻り売りになりやすい形です。見た目の押し目と本当の押し目を分けて確認します。
            </p>
          </div>
          <div className="grid gap-3">
            {fallingRows.map((row) => <PullbackLensCard key={`${row.kind}-${row.ticker}`} row={row} />)}
          </div>
        </div>
      </div>
    </Card>
  )
}

function DecisionBadge({ decision }: { decision: LongShortDecisionRow['decision'] }) {
  if (decision === 'long') return <Pill tone="red">買い優勢</Pill>
  if (decision === 'short') return <Pill tone="blue">売り優勢</Pill>
  return <Pill>見送り</Pill>
}

function EdgeMeter({ label, value, tone }: { label: string; value: number; tone: 'red' | 'blue' }) {
  const normalized = clamp((value + 1) / 2, 0, 1)
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-bold text-[var(--color-text-secondary)]">
        <span>{label}</span>
        <span className="tabular-nums">{fmtScore(value)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${tone === 'red' ? 'bg-red-500' : 'bg-blue-500'}`} style={{ width: `${normalized * 100}%` }} />
      </div>
    </div>
  )
}

function DecisionMiniCard({ row, mode }: { row: LongShortDecisionRow; mode: 'expectation' | 'entry' | 'exit' | 'squeeze' }) {
  const direction: Direction = row.decision === 'short' || mode === 'squeeze' ? 'down' : 'up'
  return (
    <div className="rounded-[4px] border border-[var(--color-border-default)] bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <DecisionBadge decision={row.decision} />
            {mode === 'squeeze' && (
              <span className={`inline-flex items-center rounded-[3px] border px-2 py-1 text-[11px] font-bold ${
                row.squeezeRisk === '高'
                  ? 'border-blue-300 bg-blue-50 text-blue-700'
                  : row.squeezeRisk === '中'
                    ? 'border-amber-300 bg-amber-50 text-amber-700'
                    : 'border-slate-200 bg-slate-50 text-slate-600'
              }`}>
                踏み上げ{row.squeezeRisk}
              </span>
            )}
          </div>
          <Link href={`/stock/${row.ticker}`} prefetch={false} className="mt-2 inline-flex text-[15px] font-bold text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]">
            {row.ticker} {row.name ?? ''}
          </Link>
          <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{row.sector_large ?? '業種未設定'}</div>
        </div>
        <StageCode code={row.profile?.stageCode} />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <EdgeMeter label="買い期待" value={row.longEdge} tone="red" />
        <EdgeMeter label="売り期待" value={row.shortEdge} tone="blue" />
      </div>

      <div className="mt-3 grid gap-2 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
        {mode === 'expectation' && <p>{row.expectation}</p>}
        {mode === 'entry' && (
          <>
            <p><span className="font-bold text-[var(--color-brand-900)]">待ち条件:</span> {row.entryTrigger}</p>
            <p><span className="font-bold text-[var(--color-brand-900)]">無効条件:</span> {row.invalidation}</p>
          </>
        )}
        {mode === 'exit' && (
          <>
            <p><span className="font-bold text-[var(--color-brand-900)]">{direction === 'up' ? '利確目安' : '買い戻し目安'}:</span> {row.profitPlan}</p>
            <p><span className="font-bold text-[var(--color-brand-900)]">撤退条件:</span> {row.stopPlan}</p>
          </>
        )}
        {mode === 'squeeze' && (
          <>
            <p>{row.squeezeReason}</p>
            <div className="flex flex-wrap gap-1.5">
              <Pill>信用倍率 {row.margin?.credit_ratio == null ? '-' : `${row.margin.credit_ratio.toFixed(2)}倍`}</Pill>
              <Pill>売残 {fmtShares(row.margin?.short_margin)}</Pill>
              <Pill>売残増減 {fmtShares(row.margin?.short_change)}</Pill>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ExpectedValuePanel({ rows }: { rows: LongShortDecisionRow[] }) {
  const longRows = rows.filter((row) => row.decision === 'long').sort((a, b) => b.longEdge - a.longEdge).slice(0, 6)
  const shortRows = rows.filter((row) => row.decision === 'short').sort((a, b) => b.shortEdge - a.shortEdge).slice(0, 6)
  return (
    <Card size="lg">
      <CardHeader
        title="期待値ランキング"
        hint="上昇候補と下落警戒を同じ土俵で比較し、勝率だけでなく逆方向リスクとMA形状を含めて並べます。"
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <div>
          <div className="mb-2 text-[14px] font-bold text-red-700">買い期待値 上位</div>
          <div className="grid gap-2">
            {longRows.length > 0 ? longRows.map((row) => <DecisionMiniCard key={`long-ev-${row.ticker}`} row={row} mode="expectation" />) : (
              <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">買い優勢が明確な候補はありません。</div>
            )}
          </div>
        </div>
        <div>
          <div className="mb-2 text-[14px] font-bold text-blue-700">空売り期待値 上位</div>
          <div className="grid gap-2">
            {shortRows.length > 0 ? shortRows.map((row) => <DecisionMiniCard key={`short-ev-${row.ticker}`} row={row} mode="expectation" />) : (
              <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">売り優勢が明確な候補はありません。</div>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}

function EntryWaitPanel({ rows }: { rows: LongShortDecisionRow[] }) {
  const selected = rows
    .filter((row) => row.decision !== 'wait' || Math.max(row.longEdge, row.shortEdge) > 0.2)
    .sort((a, b) => Math.max(b.longEdge, b.shortEdge) - Math.max(a.longEdge, a.shortEdge))
    .slice(0, 8)
  return (
    <Card size="lg">
      <CardHeader
        title="エントリー待ち条件"
        hint="候補をすぐ売買するのではなく、5日/25日MAと直近高値・安値の条件成立を待つための確認リストです。"
      />
      <div className="grid gap-2 lg:grid-cols-2">
        {selected.map((row) => <DecisionMiniCard key={`entry-${row.ticker}`} row={row} mode="entry" />)}
      </div>
    </Card>
  )
}

function ExitOptimizerPanel({ rows }: { rows: LongShortDecisionRow[] }) {
  const selected = rows
    .filter((row) => row.decision !== 'wait')
    .sort((a, b) => Math.max(b.longEdge, b.shortEdge) - Math.max(a.longEdge, a.shortEdge))
    .slice(0, 8)
  return (
    <Card size="lg">
      <CardHeader
        title="利確・損切り最適化"
        hint="過去ML候補の方向性に対して、直近高値・主要MAを使った出口条件を明示します。"
      />
      <div className="grid gap-2 lg:grid-cols-2">
        {selected.map((row) => <DecisionMiniCard key={`exit-${row.ticker}`} row={row} mode="exit" />)}
      </div>
    </Card>
  )
}

function SqueezeRiskPanel({ rows }: { rows: LongShortDecisionRow[] }) {
  const selected = rows
    .filter((row) => row.down || row.decision === 'short')
    .sort((a, b) => {
      const riskOrder = { 高: 2, 中: 1, 低: 0 } as const
      return riskOrder[b.squeezeRisk] - riskOrder[a.squeezeRisk] || b.shortEdge - a.shortEdge
    })
    .slice(0, 8)
  return (
    <Card size="lg">
      <CardHeader
        title="踏み上げリスク判定"
        hint="空売り候補に対し、売残の偏りと短期MA回復を組み合わせ、急反発リスクを分けて表示します。"
      />
      <div className="grid gap-2 lg:grid-cols-2">
        {selected.map((row) => <DecisionMiniCard key={`squeeze-${row.ticker}`} row={row} mode="squeeze" />)}
      </div>
    </Card>
  )
}

function LongShortComparisonPanel({ rows }: { rows: LongShortDecisionRow[] }) {
  const selected = rows.slice(0, 16)
  return (
    <Card size="lg">
      <CardHeader
        title="ロング / ショート比較"
        hint="同一銘柄を買い目線・売り目線の両方で評価し、買い優勢・売り優勢・見送りに分けます。"
      />
      <div className="overflow-x-auto">
        <table className="min-w-[880px] w-full border-collapse text-left text-[12px]">
          <thead>
            <tr className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[11px] font-bold text-[var(--color-text-secondary)]">
              <th className="px-3 py-2">銘柄</th>
              <th className="px-3 py-2">判定</th>
              <th className="px-3 py-2">6桁</th>
              <th className="px-3 py-2 text-right">買い期待</th>
              <th className="px-3 py-2 text-right">売り期待</th>
              <th className="px-3 py-2">MA並び</th>
              <th className="px-3 py-2">確認ポイント</th>
            </tr>
          </thead>
          <tbody>
            {selected.map((row) => (
              <tr key={`ls-${row.ticker}`} className="border-b border-[var(--color-border-subtle)] align-top">
                <td className="px-3 py-2">
                  <Link href={`/stock/${row.ticker}`} prefetch={false} className="font-bold text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]">
                    {row.ticker} {row.name ?? ''}
                  </Link>
                  <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{row.sector_large ?? '業種未設定'}</div>
                </td>
                <td className="px-3 py-2"><DecisionBadge decision={row.decision} /></td>
                <td className="px-3 py-2"><StageCode code={row.profile?.stageCode} /></td>
                <td className="px-3 py-2 text-right font-bold tabular-nums text-red-700">{fmtScore(row.longEdge)}</td>
                <td className="px-3 py-2 text-right font-bold tabular-nums text-blue-700">{fmtScore(row.shortEdge)}</td>
                <td className="px-3 py-2 font-semibold">{row.profile?.maOrder ?? '-'}</td>
                <td className="px-3 py-2 font-semibold leading-relaxed text-[var(--color-text-secondary)]">
                  {row.decision === 'short' ? row.entryTrigger : row.decision === 'long' ? row.entryTrigger : row.expectation}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function regimeText(value: string | null | undefined): string {
  const map: Record<string, string> = {
    up_acceleration: '上昇加速',
    up_deceleration: '上昇鈍化',
    down_acceleration: '下落加速',
    down_deceleration: '下落鈍化',
    sideways: '横ばい',
    compression: '収縮',
    up_expansion: '上方向拡散',
    down_expansion: '下方向拡散',
    neutral: '中立',
    bullish_turn: '上向き転換',
    bearish_turn: '下向き転換',
    rebound_watch: '反発候補',
    breakdown_watch: '崩れ候補',
    none: '転換なし',
  }
  return value ? map[value] ?? value : '-'
}

function PhysicsCandidateCard({ candidate }: { candidate: ParsedPhysicsCandidate }) {
  const profile = candidate.profile
  const tone = physicsTone(candidate.direction)
  return (
    <Card size="sm" className="h-full">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={tone}>{physicsDirectionLabel(candidate.direction)}</Pill>
            <Pill>{candidate.horizon_days}営業日</Pill>
            <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">#{candidate.rank}</span>
          </div>
          <Link href={`/stock/${candidate.ticker}`} prefetch={false} className="mt-2 inline-flex text-[16px] font-bold text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]">
            {candidate.ticker} {candidate.name ?? ''}
          </Link>
          <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{candidate.sector_large ?? '業種未設定'} / {fmtDate(candidate.as_of_date)}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">短期形状</div>
          <div className="text-[18px] font-bold tabular-nums text-[var(--color-brand-900)]">{fmtRatio(candidate.candidate_score)}</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StageCode code={profile?.stageCode} />
        <Pill>{profile?.maOrder ?? 'MA並び未生成'}</Pill>
        <PhysicsBadge status={candidate.analysis.physicsStatus}>{candidate.analysis.physicsStatus}</PhysicsBadge>
        <PhysicsBadge status={candidate.analysis.pullbackVerdict}>{candidate.analysis.pullbackVerdict}</PhysicsBadge>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2.5 py-2">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">流れ</div>
          <div className="mt-1 text-[12px] font-bold text-[var(--color-brand-900)]">{regimeText(profile?.regimes.trend)}</div>
        </div>
        <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2.5 py-2">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">距離</div>
          <div className="mt-1 text-[12px] font-bold text-[var(--color-brand-900)]">{regimeText(profile?.regimes.spread)}</div>
        </div>
        <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2.5 py-2">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">転換</div>
          <div className="mt-1 text-[12px] font-bold text-[var(--color-brand-900)]">{regimeText(profile?.regimes.turn)}</div>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Pill>5SMA速度 {fmtPct(profile?.velocities.sma5.d5)}</Pill>
        <Pill>5SMA加速度 {fmtPct(profile?.accelerations.sma5.d5)}</Pill>
        <Pill>5-25距離 {fmtPct(profile?.gaps.sma5To25Pct)}</Pill>
        <Pill>距離変化 {fmtPct(profile?.gapVelocity.sma5To25D5)}</Pill>
      </div>

      {candidate.explanation.summary && (
        <p className="mt-3 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{candidate.explanation.summary}</p>
      )}
      <div className="mt-3 rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
        <div className="text-[12px] font-bold text-[var(--color-brand-900)]">物理ステータスの読み</div>
        <p className="mt-1 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{candidate.analysis.summary}</p>
      </div>

      <div className="mt-3 grid gap-1.5">
        {(['velocity', 'acceleration', 'distance', 'pricePosition', 'regime', 'context', 'timing', 'risk'] as const).map((key) => (
          candidate.reason[key] ? (
            <div key={key} className="rounded-[4px] border border-[var(--color-border-default)] bg-white px-2.5 py-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
              {candidate.reason[key]}
            </div>
          ) : null
        ))}
      </div>
    </Card>
  )
}

function PhysicsLensPanel({ status, rows }: { status: PhysicsDataStatus; rows: ParsedPhysicsCandidate[] }) {
  const groups: Array<{ direction: PhysicsDirection; title: string; body: string }> = [
    { direction: 'up', title: '短期上昇候補', body: 'SMA速度・加速度・距離拡大が上方向に揃いやすい形です。' },
    { direction: 'down', title: '短期下落候補', body: 'SMA下向き加速、戻り失敗、距離の下方向拡大を重視します。' },
    { direction: 'wait', title: '見送り候補', body: '方向感より横ばい・収縮・逆行リスクが強く、条件待ちに寄せる形です。' },
  ]
  return (
    <Card size="lg">
      <CardHeader
        title="チャート物理 v2"
        hint={`SMAの速度・加速度・距離変化で1〜2週間の形状を読む短期MLです。特徴量 ${fmtCount(status.rowsLatest)}件 / 候補 ${fmtCount(status.candidateRowsLatest)}件`}
      />
      {rows.length === 0 ? (
        <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3 text-[12px] font-semibold text-[var(--color-text-secondary)]">
          ma_physics_v2 の候補はまだ生成されていません。`npm run batch:ml-physics-features && npm run batch:ml-short-labels && npm run batch:ml-physics-train && npm run batch:ml-physics-candidates` で生成できます。
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-3">
          {groups.map((group) => {
            const items = rows.filter((row) => row.direction === group.direction).slice(0, 4)
            return (
              <div key={group.direction} className="space-y-3">
                <div>
                  <div className={`text-[14px] font-bold ${group.direction === 'down' ? 'text-blue-700' : group.direction === 'wait' ? 'text-slate-700' : 'text-red-700'}`}>{group.title}</div>
                  <p className="mt-1 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{group.body}</p>
                </div>
                <div className="grid gap-3">
                  {items.map((candidate) => <PhysicsCandidateCard key={`${candidate.direction}-${candidate.horizon_days}-${candidate.ticker}`} candidate={candidate} />)}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

const PHYSICS_STATUS_ORDER: PhysicsStatusLabel[] = [
  '上昇加速',
  '上昇継続',
  '押し目形成',
  '反発準備',
  '過熱注意',
  '失速警戒',
  '下落加速',
  '見送り',
  '算出待ち',
]

function isPositivePhysicsStatus(status: PhysicsStatusLabel): boolean {
  return status === '上昇加速' || status === '上昇継続' || status === '押し目形成' || status === '反発準備'
}

function isRiskPhysicsStatus(status: PhysicsStatusLabel): boolean {
  return status === '過熱注意' || status === '失速警戒' || status === '下落加速'
}

function topRowsForStatus(rows: ParsedPhysicsFlowRow[], status: PhysicsStatusLabel, limit = 3): ParsedPhysicsFlowRow[] {
  return rows
    .filter((row) => row.analysis.physicsStatus === status)
    .sort((a, b) => {
      const aScore = physicsStrength(a)
      const bScore = physicsStrength(b)
      if (isPositivePhysicsStatus(status)) return bScore - aScore || a.ticker.localeCompare(b.ticker)
      if (isRiskPhysicsStatus(status)) return aScore - bScore || a.ticker.localeCompare(b.ticker)
      return Math.abs(bScore) - Math.abs(aScore) || a.ticker.localeCompare(b.ticker)
    })
    .slice(0, limit)
}

function PhysicsFlowMapPanel({ rows }: { rows: ParsedPhysicsFlowRow[] }) {
  const total = rows.length
  return (
    <Card size="lg">
      <CardHeader
        title="MA Flow Map"
        hint="最新日の全銘柄を、SMAの速度・加速度・距離変化・6桁ステージから物理状態へ分類します。"
      />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {PHYSICS_STATUS_ORDER.map((status) => {
          const count = rows.filter((row) => row.analysis.physicsStatus === status).length
          const pct = total > 0 ? count / total : 0
          const examples = topRowsForStatus(rows, status)
          return (
            <div key={status} className={`rounded-[4px] border p-3 ${physicsBadgeClass(status)}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[14px] font-bold">{status}</div>
                  <div className="mt-1 text-[11px] font-semibold opacity-80">
                    {fmtCount(count)}件 / {fmtRatio(pct)}
                  </div>
                </div>
                <div className="text-right text-[10px] font-bold opacity-70">物理状態</div>
              </div>
              <div className="mt-3 grid gap-1.5">
                {examples.length > 0 ? examples.map((row) => (
                  <Link
                    key={`${status}-${row.ticker}`}
                    href={`/stock/${row.ticker}`}
                    prefetch={false}
                    className="flex items-center justify-between gap-2 rounded-[3px] bg-white/70 px-2 py-1 text-[11px] font-bold hover:bg-white"
                  >
                    <span className="truncate">{row.ticker} {row.name ?? ''}</span>
                    <span className="tabular-nums">{fmtPct(row.analysis.metrics.sma5Velocity5)}</span>
                  </Link>
                )) : (
                  <div className="rounded-[3px] bg-white/70 px-2 py-1 text-[11px] font-bold opacity-70">該当なし</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function PhysicsPullbackQualityPanel({ rows }: { rows: ParsedPhysicsFlowRow[] }) {
  const healthy = rows
    .filter((row) => row.analysis.pullbackVerdict === '本物の押し目に近い')
    .sort((a, b) => physicsStrength(b) - physicsStrength(a))
    .slice(0, 8)
  const falsePullback = rows
    .filter((row) => row.analysis.pullbackVerdict === '下落途中の一時反発' || row.analysis.pullbackVerdict === '反発は弱い')
    .sort((a, b) => physicsStrength(a) - physicsStrength(b))
    .slice(0, 8)
  return (
    <Card size="lg">
      <CardHeader
        title="押し目の本物/偽物判定"
        hint="押し目に見える形を、25日SMAの向き、5日SMAの再加速、MA距離の縮小/再拡大から分けます。"
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <div>
          <div className="mb-2 text-[14px] font-bold text-red-700">本物の押し目に近い</div>
          <div className="grid gap-2">
            {healthy.length > 0 ? healthy.map((row) => <PhysicsFlowMiniCard key={`healthy-${row.ticker}`} row={row} />) : (
              <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">条件に合う銘柄はありません。</div>
            )}
          </div>
        </div>
        <div>
          <div className="mb-2 text-[14px] font-bold text-blue-700">押し目風の下落注意</div>
          <div className="grid gap-2">
            {falsePullback.length > 0 ? falsePullback.map((row) => <PhysicsFlowMiniCard key={`false-${row.ticker}`} row={row} />) : (
              <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">条件に合う銘柄はありません。</div>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}

function PhysicsAccelerationPanel({ rows }: { rows: ParsedPhysicsFlowRow[] }) {
  const up = rows
    .filter((row) => row.analysis.physicsStatus === '上昇加速' || row.analysis.physicsStatus === '反発準備')
    .sort((a, b) => physicsStrength(b) - physicsStrength(a))
    .slice(0, 10)
  const down = rows
    .filter((row) => row.analysis.physicsStatus === '下落加速' || row.analysis.physicsStatus === '失速警戒')
    .sort((a, b) => physicsStrength(a) - physicsStrength(b))
    .slice(0, 10)
  return (
    <Card size="lg">
      <CardHeader
        title="加速度・失速ランキング"
        hint="短期SMAの急な角度変化とMA距離の拡大/縮小から、流れが強まった銘柄と弱まった銘柄を並べます。"
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-2">
          <div className="text-[14px] font-bold text-red-700">上向き加速</div>
          {up.map((row) => <PhysicsFlowMiniCard key={`accel-up-${row.ticker}`} row={row} />)}
        </div>
        <div className="space-y-2">
          <div className="text-[14px] font-bold text-blue-700">失速・下落加速</div>
          {down.map((row) => <PhysicsFlowMiniCard key={`accel-down-${row.ticker}`} row={row} />)}
        </div>
      </div>
    </Card>
  )
}

function PhysicsDistanceRiskPanel({ rows }: { rows: ParsedPhysicsFlowRow[] }) {
  const overheat = rows
    .filter((row) => row.analysis.physicsStatus === '過熱注意')
    .sort((a, b) => Math.abs(slopeValue(b.analysis.metrics.gap5To25Pct)) - Math.abs(slopeValue(a.analysis.metrics.gap5To25Pct)))
    .slice(0, 6)
  const wait = rows
    .filter((row) => row.analysis.physicsStatus === '見送り' || row.analysis.physicsStatus === '算出待ち')
    .sort((a, b) => Math.abs(physicsStrength(a)) - Math.abs(physicsStrength(b)))
    .slice(0, 6)
  return (
    <section className="grid gap-5 xl:grid-cols-2">
      <Card size="lg">
        <CardHeader
          title="過熱・反落リスク"
          hint="5日SMAと25日SMAの距離が広がりすぎ、距離変化が急な銘柄を先に確認します。"
        />
        <div className="grid gap-2">
          {overheat.length > 0 ? overheat.map((row) => <PhysicsFlowMiniCard key={`overheat-${row.ticker}`} row={row} />) : (
            <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">過熱注意に該当する銘柄はありません。</div>
          )}
        </div>
      </Card>
      <Card size="lg">
        <CardHeader
          title="見送り・条件待ち"
          hint="方向感が弱い、またはSMA距離が収束中で、無理に候補化しない方がよい銘柄です。"
        />
        <div className="grid gap-2">
          {wait.length > 0 ? wait.map((row) => <PhysicsFlowMiniCard key={`wait-${row.ticker}`} row={row} />) : (
            <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">見送り分類の銘柄はありません。</div>
          )}
        </div>
      </Card>
    </section>
  )
}

function PhysicsLearningGuidePanel() {
  const items = [
    ['速度', 'SMAそのものがどちらへ動いているかを見ます。5日だけでなく25日も同じ方向なら、短期の動きが中期へ伝わり始めています。'],
    ['加速度', 'SMAの角度が急に変わったかを見ます。短期SMAの加速度が先に変わり、次に25日SMAへ波及するかを確認します。'],
    ['距離', '5-25、25-75、75-200の距離で、上方向の拡散、収束、過熱、下方向の拡散を分けます。'],
    ['6桁ステージ', '日足A/B・週足A/B・月足A/Bを1セットにし、短期だけの反発か、上位足も支える形かを確認します。'],
    ['地合い', '同じ形でも市場全体・業種の追い風があるかで結果が変わるため、物理特徴量に補助軸として含めます。'],
    ['失敗パターン', '押し目に見えても25日SMAが下向き、5-25距離が下方向に広がる形は下落途中の反発として警戒します。'],
    ['次の行動', '候補は売買指示ではなく、5日SMA維持、25日SMAの向き、距離の再拡大/急縮小を確認するための優先順位です。'],
  ] as const
  return (
    <Card size="lg">
      <CardHeader
        title="AIが学習しているチャート物理"
        hint="予測結果だけではなく、なぜその形を候補・警戒・見送りに分けたのかを7つの軸で確認します。"
      />
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-7">
        {items.map(([title, body], index) => (
          <div key={title} className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
            <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">#{index + 1}</div>
            <div className="mt-1 text-[13px] font-bold text-[var(--color-brand-900)]">{title}</div>
            <p className="mt-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{body}</p>
          </div>
        ))}
      </div>
    </Card>
  )
}

async function PhysicsFlowSection() {
  const rows = await loadPhysicsFlowRows()
  return (
    <>
      <PhysicsLearningGuidePanel />
      <PhysicsFlowMapPanel rows={rows} />
      <section className="grid gap-5 2xl:grid-cols-2">
        <PhysicsPullbackQualityPanel rows={rows} />
        <PhysicsAccelerationPanel rows={rows} />
      </section>
      <PhysicsDistanceRiskPanel rows={rows} />
    </>
  )
}

function ModelCard({ model }: { model: ModelRow }) {
  const metrics = parseJson<Record<string, unknown>>(model.metrics_json, {})
  const items = featureImportance(model)
  return (
    <Card size="sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={model.direction === 'up' ? 'red' : 'blue'}>{directionLabel(model.direction)}</Pill>
            <Pill>{model.horizon_days}営業日</Pill>
          </div>
          <div className="mt-2 text-[13px] font-bold text-[var(--color-brand-900)]">{model.model_name}</div>
          <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">学習: {fmtUnix(model.trained_at)}</div>
        </div>
        <div className="text-right text-[11px] font-bold text-[var(--color-text-secondary)]">
          <div>サンプル {fmtCount(Number(metrics.samples ?? 0))}</div>
          <div>正解率 {fmtRatio(Number(metrics.accuracy ?? 0))}</div>
        </div>
      </div>
      <div className="mt-3 grid gap-2">
        {items.map((item) => (
          <div key={`${model.model_name}-${item.feature}`} className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2.5 py-2">
            <div className="flex items-start justify-between gap-3">
              <div className="text-[12px] font-bold text-[var(--color-brand-900)]">{item.label}</div>
              <div className={`text-[11px] font-bold tabular-nums ${item.weight >= 0 ? 'text-red-700' : 'text-blue-700'}`}>
                {item.weight >= 0 ? '+' : ''}{item.weight.toFixed(2)}
              </div>
            </div>
            <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">{item.effect}</div>
          </div>
        ))}
      </div>
    </Card>
  )
}

function EvaluationTable({ rows }: { rows: EvaluationRow[] }) {
  if (rows.length === 0) {
    return <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">ウォークフォワード評価はまだ未生成です。</div>
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-[760px] w-full border-collapse text-left text-[12px]">
        <thead>
          <tr className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[11px] font-bold text-[var(--color-text-secondary)]">
            <th className="px-3 py-2">方向</th>
            <th className="px-3 py-2">期間</th>
            <th className="px-3 py-2">評価日</th>
            <th className="px-3 py-2 text-right">件数</th>
            <th className="px-3 py-2 text-right">Precision@20</th>
            <th className="px-3 py-2 text-right">Hit Rate</th>
            <th className="px-3 py-2 text-right">中央値</th>
            <th className="px-3 py-2 text-right">平均</th>
            <th className="px-3 py-2 text-right">最大逆行</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.evaluation_date}-${row.direction}-${row.horizon_days}`} className="border-b border-[var(--color-border-subtle)]">
              <td className="px-3 py-2 font-bold text-[var(--color-brand-900)]">{directionLabel(row.direction)}</td>
              <td className="px-3 py-2 font-semibold">{row.horizon_days}営業日</td>
              <td className="px-3 py-2 font-semibold">{fmtDate(row.evaluation_date)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtCount(row.sample_count)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtRatio(row.precision_at_20)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtRatio(row.hit_rate)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtPct(row.median_return_pct)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtPct(row.avg_return_pct)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtPct(row.max_drawdown_pct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ModelMonitoringPanel({ rows }: { rows: EvaluationRow[] }) {
  if (rows.length === 0) {
    return (
      <Card size="lg">
        <CardHeader title="モデル精度の時系列モニタリング" hint="日次予測の答え合わせを蓄積し、モデル劣化を検知します。" />
        <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">評価履歴はまだ生成されていません。</div>
      </Card>
    )
  }
  const dates = Array.from(new Set(rows.map((row) => row.evaluation_date)))
  const latestDate = dates[0]
  const hasTimeline = dates.length >= 2
  const latestRows = rows.filter((row) => row.evaluation_date === latestDate)
  const priorRows = rows.filter((row) => row.evaluation_date !== latestDate)
  return (
    <Card size="lg">
      <CardHeader
        title="モデル精度の時系列モニタリング"
        hint="買いモデルと空売りモデルを別々に答え合わせし、精度低下時は候補の信頼度を下げて扱います。"
      />
      <div className="grid gap-3 lg:grid-cols-3">
        {latestRows.map((row) => (
          <div key={`monitor-${row.evaluation_date}-${row.direction}-${row.horizon_days}`} className="rounded-[4px] border border-[var(--color-border-default)] bg-white p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={row.direction === 'up' ? 'red' : 'blue'}>{directionLabel(row.direction)}</Pill>
              <Pill>{row.horizon_days}営業日</Pill>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] font-bold text-[var(--color-text-secondary)]">
              <div>
                <div className="text-[10px] text-[var(--color-text-tertiary)]">Precision@20</div>
                <div className="text-[18px] tabular-nums text-[var(--color-brand-900)]">{fmtRatio(row.precision_at_20)}</div>
              </div>
              <div>
                <div className="text-[10px] text-[var(--color-text-tertiary)]">中央値</div>
                <div className={`text-[18px] tabular-nums ${(row.median_return_pct ?? 0) >= 0 ? 'text-red-700' : 'text-blue-700'}`}>{fmtPct(row.median_return_pct)}</div>
              </div>
              <div>
                <div className="text-[10px] text-[var(--color-text-tertiary)]">Hit Rate</div>
                <div className="text-[16px] tabular-nums text-[var(--color-brand-900)]">{fmtRatio(row.hit_rate)}</div>
              </div>
              <div>
                <div className="text-[10px] text-[var(--color-text-tertiary)]">最大逆行</div>
                <div className="text-[16px] tabular-nums text-blue-700">{fmtPct(row.max_drawdown_pct)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
        {hasTimeline
          ? `評価日は${dates.length}点あります。直近のPrecision@20や中央値リターンが過去評価から悪化していないかを確認し、悪化時は候補の採用数を絞ります。`
          : '現時点では評価日が1点のみです。日次予測と答え合わせが蓄積されると、モデル劣化や相場環境別の得意不得意を時系列で確認できます。'}
        {priorRows.length > 0 && ` 過去評価履歴は${priorRows.length}行あります。`}
      </div>
      <div className="mt-3">
        <EvaluationTable rows={rows.slice(0, 12)} />
      </div>
    </Card>
  )
}

function SimilarPanel({ rows }: { rows: SimilarRow[] }) {
  if (rows.length === 0) {
    return <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">類似度80%以上のMA形状類似データはありません。</div>
  }
  return (
    <div className="grid gap-2 lg:grid-cols-2">
      {rows.map((row) => {
        const payload = parseJson<SimilarPayload>(row.payload_json, {})
        const reason = parseJson<Record<string, string>>(row.reason_json, {})
        const base = payload.base ?? {}
        const similar = payload.similar ?? {}
        return (
          <div key={`${row.base_ticker}-${row.similar_ticker}`} className="rounded-[4px] border border-[var(--color-border-default)] bg-white p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 text-[13px] font-bold text-[var(--color-brand-900)]">
                {row.base_ticker} {base.name ?? ''} <span className="text-[var(--color-text-tertiary)]">→</span> {row.similar_ticker} {similar.name ?? ''}
              </div>
              <Pill>{Math.round(row.similarity_score * 100)}%類似</Pill>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StageCode code={base.stageCode} />
              <span className="text-[12px] font-bold text-[var(--color-text-tertiary)]">→</span>
              <StageCode code={similar.stageCode} />
            </div>
            <p className="mt-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{reason.maAngle ?? reason.pricePosition ?? 'MA形状と6桁ステージの近さで抽出しました。'}</p>
          </div>
        )
      })}
    </div>
  )
}

function LazySectionFallback({ title }: { title: string }) {
  return (
    <Card size="lg">
      <CardHeader title={title} hint="表示に必要なデータを分割して読み込んでいます。" />
      <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-4 text-[12px] font-semibold text-[var(--color-text-secondary)]">
        読み込み中...
      </div>
    </Card>
  )
}

async function PullbackLensSection() {
  const models = await loadModels()
  const pullbackRows = await loadPullbackLens(models)
  return <PullbackLensPanel rows={pullbackRows} />
}

async function DecisionPanelsSection() {
  const candidatePool = await loadCandidatePool()
  const marginMap = await loadMarginRows(candidatePool.map((candidate) => candidate.ticker))
  const decisionRows = buildLongShortRows(candidatePool, marginMap)
  return (
    <>
      <ExpectedValuePanel rows={decisionRows} />

      <section className="grid gap-5 xl:grid-cols-2">
        <EntryWaitPanel rows={decisionRows} />
        <ExitOptimizerPanel rows={decisionRows} />
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <SqueezeRiskPanel rows={decisionRows} />
        <LongShortComparisonPanel rows={decisionRows} />
      </section>
    </>
  )
}

async function ModelKnowledgeSection() {
  const [models, evaluations, evaluationTimeline, similars] = await Promise.all([
    loadModels(),
    loadEvaluations(),
    loadEvaluationTimeline(),
    loadSimilarRows(),
  ])
  const focusModels = models.filter((model) => model.horizon_days === 40).slice(0, 2)
  const fallbackModels = focusModels.length > 0 ? focusModels : models.slice(0, 2)
  return (
    <>
      <Card size="lg">
        <CardHeader
          title="モデルが重視している特徴"
          hint="ロジスティック回帰モデルの重みから、上昇候補・下落警戒の判定で効いている特徴を表示します。"
        />
        <div className="grid gap-3 lg:grid-cols-2">
          {fallbackModels.map((model) => <ModelCard key={model.model_name} model={model} />)}
        </div>
      </Card>

      <Card size="lg">
        <CardHeader
          title="現在のMA形状が近い銘柄"
          hint="最新日の候補銘柄同士を、6桁ステージ・MA角度・MA距離・株価位置の特徴量距離で比較します。"
        />
        <SimilarPanel rows={similars} />
      </Card>

      <ModelMonitoringPanel rows={evaluationTimeline.length > 0 ? evaluationTimeline : evaluations} />
    </>
  )
}

export default async function MaLensPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = searchParams ? await searchParams : {}
  const detailMode = (Array.isArray(sp.deep) ? sp.deep[0] : sp.deep) === '1'
  const [status, candidates, physicsStatus, physicsCandidates] = await Promise.all([
    loadStatus(),
    detailMode ? loadCandidates() : Promise.resolve([]),
    loadPhysicsStatus(),
    loadPhysicsCandidates(10),
  ])

  const upCandidates = candidates.filter((candidate) => candidate.direction === 'up').slice(0, 8)
  const downCandidates = candidates.filter((candidate) => candidate.direction === 'down').slice(0, 8)

  return (
    <div className="space-y-5">
      <PageTitle
        title="AI Lens"
        subtitle="6桁ステージと移動平均線の角度・距離・位置を、機械学習がどう読んでいるかを可視化します。"
        badge={`ML基準日 ${fmtDate(status.latestCandidateDate ?? status.latestFeatureDate)}`}
      />

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <StatTile label="特徴量期間" value={`${fmtDate(status.firstFeatureDate)}〜${fmtDate(status.latestFeatureDate)}`} sub="2008年以降のML入力" />
        <StatTile label="最新特徴量" value={fmtCount(status.featureRowsLatest)} sub="最新日に生成済みの銘柄数" />
        <StatTile label="物理特徴量" value={fmtCount(physicsStatus.rowsLatest)} sub={`ma_physics_v2 ${fmtDate(physicsStatus.latestDate)}`} />
        <StatTile label="教師ラベル" value={fmtDate(status.latestLabelDate)} sub={`${fmtCount(status.labelRowsLatest)}件 / 40営業日`} />
        <StatTile label="最新候補" value={fmtCount(status.candidateRowsLatest)} sub="上昇候補・下落警戒" />
        <StatTile label="モデル世代" value={fmtCount(status.modelCount)} sub="保存済みモデル数" />
      </section>

      <Card size="lg">
        <CardHeader
          title="AIが見ている入力データ"
          hint="一時点の価格だけではなく、MAの角度・距離・株価位置を時系列の流れとして特徴量化します。"
        />
        <FeatureInputGrid />
      </Card>

      <Card size="lg">
        <CardHeader
          title="過去パターン検索"
          hint="任意期間のMA形状と6桁ステージの流れを基準に、現在市場の類似銘柄を探します。"
        />
        <HistoricalPatternSearchPanel latestFeatureDate={physicsStatus.latestDate} />
      </Card>

      {!detailMode && (
        <Card size="lg">
          <CardHeader
            title="詳細分析を開く"
            hint="初期表示を軽くするため、全銘柄フロー・押し目Lens・期待値詳細・モデル知識は必要な時に読み込みます。"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-[760px] text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
              この画面の基本情報と最新候補はすぐ確認できます。全銘柄を横断する重い分析を確認する場合だけ、詳細モードに切り替えてください。
            </p>
            <Link
              href="/ai/ma-lens?deep=1"
              prefetch={false}
              className="rounded-full border border-[var(--color-border-soft)] bg-white px-4 py-2 text-[12px] font-bold text-[var(--color-brand-900)] hover:bg-[var(--color-surface-subtle)]"
            >
              詳細分析を表示
            </Link>
          </div>
        </Card>
      )}

      {detailMode && (
        <Suspense fallback={<LazySectionFallback title="チャート物理インテリジェンス" />}>
          <PhysicsFlowSection />
        </Suspense>
      )}

      {detailMode && (
        <Suspense fallback={<LazySectionFallback title="押し目 Lens" />}>
          <PullbackLensSection />
        </Suspense>
      )}

      <PhysicsLensPanel status={physicsStatus} rows={physicsCandidates} />

      {detailMode && (
        <Suspense fallback={<LazySectionFallback title="期待値・エントリー/出口条件" />}>
          <DecisionPanelsSection />
        </Suspense>
      )}

      {detailMode && (
        <section className="grid gap-5 xl:grid-cols-2">
          <div className="space-y-3">
            <CardHeader title="現在の上昇候補" hint="最新データ上で、MA形状と6桁ステージが上向き候補として抽出された銘柄です。" />
            <div className="grid gap-3">
              {upCandidates.map((candidate) => <CandidateCard key={`${candidate.direction}-${candidate.ticker}`} candidate={candidate} />)}
            </div>
          </div>
          <div className="space-y-3">
            <CardHeader title="現在の下落警戒" hint="短期線の崩れ、MA距離の縮小、株価位置の弱さなどを含めて抽出された銘柄です。" />
            <div className="grid gap-3">
              {downCandidates.map((candidate) => <CandidateCard key={`${candidate.direction}-${candidate.ticker}`} candidate={candidate} />)}
            </div>
          </div>
        </section>
      )}

      {detailMode && (
        <Suspense fallback={<LazySectionFallback title="モデル知識・類似形状・精度モニタリング" />}>
          <ModelKnowledgeSection />
        </Suspense>
      )}
    </div>
  )
}
