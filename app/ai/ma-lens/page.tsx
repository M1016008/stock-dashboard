import Link from 'next/link'
import { PageTitle } from '@/components/layout/PageTitle'
import { Card, CardHeader } from '@/components/ui/Card'
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
    WITH latest AS (SELECT MAX(as_of_date) AS date FROM serving_ml_candidates)
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

async function loadModels(): Promise<ModelRow[]> {
  return execAll<ModelRow>(
    `
    SELECT m.model_name, m.model_type, m.direction, m.horizon_days,
           m.feature_names_json, m.weights_json, m.intercept, m.metrics_json, m.trained_at
    FROM ml_models m
    INNER JOIN (
      SELECT direction, horizon_days, MAX(trained_at) AS trained_at
      FROM ml_models
      GROUP BY direction, horizon_days
    ) latest
      ON latest.direction = m.direction
     AND latest.horizon_days = m.horizon_days
     AND latest.trained_at = m.trained_at
    ORDER BY m.horizon_days ASC, CASE m.direction WHEN 'up' THEN 0 ELSE 1 END
    LIMIT 12
    `,
  )
}

async function loadPullbackLens(models: ModelRow[]): Promise<PullbackLensRow[]> {
  const upModel = latestModel(models, 'up', 40)
  const downModel = latestModel(models, 'down', 40)
  const rows = await execAll<PullbackFeatureRow>(
    `
    WITH latest AS (SELECT MAX(date) AS date FROM ml_feature_vectors)
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
    WITH latest AS (SELECT MAX(evaluation_date) AS date FROM ml_model_evaluations)
    SELECT evaluation_date, model_name, direction, horizon_days, sample_count,
           precision_at_20, precision_at_50, precision_at_80, hit_rate,
           median_return_pct, avg_return_pct
    FROM ml_model_evaluations e
    INNER JOIN latest l ON l.date = e.evaluation_date
    ORDER BY horizon_days ASC, CASE direction WHEN 'up' THEN 0 ELSE 1 END
    LIMIT 8
    `,
  )
}

async function loadSimilarRows(): Promise<SimilarRow[]> {
  return execAll<SimilarRow>(
    `
    WITH latest AS (SELECT MAX(as_of_date) AS date FROM serving_current_similars)
    SELECT s.as_of_date, s.base_ticker, s.rank, s.similar_ticker, s.similarity_score,
           s.base_direction, s.similar_direction, s.payload_json, s.reason_json
    FROM serving_current_similars s
    INNER JOIN latest l ON l.date = s.as_of_date
    WHERE s.rank = 1
    ORDER BY s.similarity_score DESC
    LIMIT 10
    `,
  )
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
  ]
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SimilarPanel({ rows }: { rows: SimilarRow[] }) {
  if (rows.length === 0) {
    return <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">現在のMA形状類似データはまだ生成されていません。</div>
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

export default async function MaLensPage() {
  const [status, candidates, models, evaluations, similars] = await Promise.all([
    loadStatus(),
    loadCandidates(),
    loadModels(),
    loadEvaluations(),
    loadSimilarRows(),
  ])
  const pullbackRows = await loadPullbackLens(models)

  const upCandidates = candidates.filter((candidate) => candidate.direction === 'up')
  const downCandidates = candidates.filter((candidate) => candidate.direction === 'down')
  const focusModels = models.filter((model) => model.horizon_days === 40).slice(0, 2)
  const fallbackModels = focusModels.length > 0 ? focusModels : models.slice(0, 2)

  return (
    <div className="space-y-5">
      <PageTitle
        title="AI Lens"
        subtitle="6桁ステージと移動平均線の角度・距離・位置を、機械学習がどう読んでいるかを可視化します。"
        badge={`ML基準日 ${fmtDate(status.latestCandidateDate ?? status.latestFeatureDate)}`}
      />

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <StatTile label="特徴量期間" value={`${fmtDate(status.firstFeatureDate)}〜${fmtDate(status.latestFeatureDate)}`} sub="2008年以降のML入力" />
        <StatTile label="最新特徴量" value={fmtCount(status.featureRowsLatest)} sub="最新日に生成済みの銘柄数" />
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

      <PullbackLensPanel rows={pullbackRows} />

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

      <Card size="lg">
        <CardHeader
          title="モデル精度の確認"
          hint="候補抽出は過去データの検証結果とセットで確認します。数値は売買判断ではなく、モデルの現在地です。"
        />
        <EvaluationTable rows={evaluations} />
      </Card>
    </div>
  )
}
