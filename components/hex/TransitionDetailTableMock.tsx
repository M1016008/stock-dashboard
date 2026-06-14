// components/hex/TransitionDetailTableMock.tsx
// ステージ変化銘柄を、6ステージ・MAの流れ・ML/シグナル示唆まで一行で読める形にする。

import Link from 'next/link'
import { calculateAngle } from '@/lib/hex-stage'
import { getPhysicsHorizonForPeriod, getTransitionDetail, type Timescale, type Period, type TransitionDetailRow } from '@/lib/queries/hex'
import type { UniverseFilterValue } from '@/lib/market-universe'

const AXIS_ORDER: Array<{
  key: Timescale
  col: 'daily_a' | 'daily_b' | 'weekly_a' | 'weekly_b' | 'monthly_a' | 'monthly_b'
  label: string
}> = [
  { key: 'daily_a',   col: 'daily_a',   label: '日A' },
  { key: 'daily_b',   col: 'daily_b',   label: '日B' },
  { key: 'weekly_a',  col: 'weekly_a',  label: '週A' },
  { key: 'weekly_b',  col: 'weekly_b',  label: '週B' },
  { key: 'monthly_a', col: 'monthly_a', label: '月A' },
  { key: 'monthly_b', col: 'monthly_b', label: '月B' },
]

const PERIOD_LABEL: Record<Period, string> = { today: '本日', week: '今週', month: '今月', to_latest: '現在まで' }

const SIGNAL_LABELS: Record<string, string> = {
  pullback_candidate: '押し目',
  pre_breakout: 'ブレイク前',
  volatility_squeeze: 'ボラ収縮',
  stage_improvement_setup: '好転予兆',
  higher_timeframe_alignment: '上位足一致',
  high_breakout_continuation: '高値継続',
}

function fmtVol(v: number | null) {
  if (v == null) return '-'
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M'
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'K'
  return v.toLocaleString()
}

function fmtPct(v: number | null | undefined, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '-'
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`
}

function fmtRate(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return '-'
  return `${(v * 100).toFixed(1)}%`
}

function pctChange(current: number | null, previous: number | null) {
  if (current == null || previous == null || previous <= 0) return null
  return ((current - previous) / previous) * 100
}

function gapPct(shortMa: number | null, longMa: number | null) {
  if (shortMa == null || longMa == null || longMa <= 0) return null
  return ((shortMa - longMa) / longMa) * 100
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

function num(v: number | null | undefined) {
  return v == null || !Number.isFinite(v) ? null : Number(v)
}

function rankScore(rank: number | null | undefined, limit = 80) {
  if (rank == null || !Number.isFinite(rank) || rank <= 0 || rank > limit) return 0
  return clamp((limit - rank + 1) / limit, 0, 1)
}

function stageScore(stage: number | null) {
  if (stage == null) return 0
  const score: Record<number, number> = { 1: 3, 6: 2, 2: 1, 5: 0, 3: -1, 4: -2 }
  return score[stage] ?? 0
}

function flowWord(current: number | null, previous: number | null) {
  if (current == null) return { label: '未計算', tone: 'neutral' as const }
  const delta = previous == null ? null : current - previous
  const direction = current > 0.08 ? '上向き' : current < -0.08 ? '下向き' : '横ばい'
  if (delta == null || Math.abs(delta) < 0.04) {
    return {
      label: direction === '横ばい' ? '横ばい維持' : `${direction}維持`,
      tone: direction === '下向き' ? 'down' as const : direction === '上向き' ? 'up' as const : 'neutral' as const,
    }
  }
  if (delta > 0) {
    return {
      label: direction === '下向き' ? '下げ鈍化' : direction === '横ばい' ? '上向き化' : '上向き加速',
      tone: direction === '下向き' ? 'neutral' as const : 'up' as const,
    }
  }
  return {
    label: direction === '上向き' ? '上げ鈍化' : direction === '横ばい' ? '下向き化' : '下向き加速',
    tone: direction === '上向き' ? 'neutral' as const : 'down' as const,
  }
}

function distanceWord(currentGap: number | null, previousGap: number | null, pairLabel: string) {
  if (currentGap == null || previousGap == null) return `${pairLabel}は未計算`
  const delta = currentGap - previousGap
  if (Math.abs(delta) < 0.15) return `${pairLabel}の距離は横ばい`
  if (currentGap >= 0 && delta > 0) return `${pairLabel}の上方乖離が拡大`
  if (currentGap >= 0 && delta < 0) return `${pairLabel}の上方乖離が縮小`
  if (currentGap < 0 && delta > 0) return `${pairLabel}の下方乖離が縮小`
  return `${pairLabel}の下方乖離が拡大`
}

function bundleWidthPct(values: Array<number | null>) {
  const valid = values.filter((v): v is number => v != null && Number.isFinite(v) && v > 0)
  if (valid.length < 3) return null
  const base = valid.reduce((sum, v) => sum + v, 0) / valid.length
  if (base <= 0) return null
  return ((Math.max(...valid) - Math.min(...valid)) / base) * 100
}

function safeParseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function signalLabels(raw: string | null) {
  if (!raw) return []
  return raw
    .split(',')
    .map((code) => SIGNAL_LABELS[code] ?? (code.startsWith('ma_cross_up') ? 'MA上抜け' : code.startsWith('ma_cross_down') ? 'MA下抜け' : null))
    .filter((v): v is string => Boolean(v))
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 4)
}

interface ExplanationJson {
  summary?: string
  watchPoints?: string[]
  riskNotes?: string[]
  confidenceLabel?: string
}

interface ObjectiveMetricsJson {
  targetPct?: number
  split?: string
  baseline?: {
    hitRate?: number
  }
  top60?: {
    hitRate?: number
    adverseRate?: number
    avgReturnPct?: number
    avgDirectionalReturnPct?: number
  }
  liftTop60VsBaseline?: number
}

interface ObjectiveEvidence {
  direction: 'up' | 'down'
  evaluationDate: string | null
  sampleCount: number | null
  top20HitRate: number | null
  top60HitRate: number | null
  baselineHitRate: number | null
  adverseRate: number | null
  avgDirectionalReturnPct: number | null
  lift: number | null
  targetPct: number | null
}

function readNumber(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function objectiveEvidence(row: TransitionDetailRow, direction: 'up' | 'down'): ObjectiveEvidence {
  const raw = direction === 'up' ? row.objective_up_metrics_json : row.objective_down_metrics_json
  const metrics = safeParseJson<ObjectiveMetricsJson>(raw)
  const baseline = metrics?.baseline && typeof metrics.baseline === 'object' ? metrics.baseline as Record<string, unknown> : undefined
  const top60 = metrics?.top60 && typeof metrics.top60 === 'object' ? metrics.top60 as Record<string, unknown> : undefined
  return {
    direction,
    evaluationDate: direction === 'up' ? row.objective_up_evaluation_date : row.objective_down_evaluation_date,
    sampleCount: num(direction === 'up' ? row.objective_up_sample_count : row.objective_down_sample_count),
    top20HitRate: num(direction === 'up' ? row.objective_up_precision_at_20 : row.objective_down_precision_at_20),
    top60HitRate: readNumber(top60, 'hitRate') ?? num(direction === 'up' ? row.objective_up_precision_at_50 : row.objective_down_precision_at_50),
    baselineHitRate: readNumber(baseline, 'hitRate') ?? num(direction === 'up' ? row.objective_up_hit_rate : row.objective_down_hit_rate),
    adverseRate: readNumber(top60, 'adverseRate'),
    avgDirectionalReturnPct: readNumber(top60, 'avgDirectionalReturnPct') ?? readNumber(top60, 'avgReturnPct'),
    lift: readNumber(metrics as unknown as Record<string, unknown>, 'liftTop60VsBaseline'),
    targetPct: readNumber(metrics as unknown as Record<string, unknown>, 'targetPct'),
  }
}

function objectiveScore(evidence: ObjectiveEvidence) {
  const lift = evidence.lift ?? (
    evidence.top60HitRate != null && evidence.baselineHitRate != null && evidence.baselineHitRate > 0
      ? evidence.top60HitRate / evidence.baselineHitRate
      : null
  )
  const hitBonus = evidence.top60HitRate == null ? 0 : clamp((evidence.top60HitRate - 0.35) * 22, 0, 10)
  const liftBonus = lift == null ? 0 : clamp((lift - 1) * 14, -4, 14)
  const adversePenalty = evidence.adverseRate == null ? 0 : clamp((evidence.adverseRate - 0.28) * 12, 0, 6)
  return clamp(hitBonus + liftBonus - adversePenalty, -6, 18)
}

function objectiveDriver(evidence: ObjectiveEvidence) {
  if (evidence.top60HitRate == null && evidence.lift == null) return null
  const label = evidence.direction === 'up' ? '上昇モデル' : '下落モデル'
  const liftText = evidence.lift == null ? '' : ` lift ${evidence.lift.toFixed(2)}`
  const hitText = evidence.top60HitRate == null ? '' : ` top60 ${fmtRate(evidence.top60HitRate)}`
  return `${label}${liftText || hitText}`
}

function physicsRankDriver(direction: 'up' | 'down' | 'wait', rank: number | null, horizon: number | null) {
  if (rank == null) return null
  const label = direction === 'up' ? '物理ML上昇' : direction === 'down' ? '物理ML下落' : '物理ML待機'
  return `${label}#${rank}${horizon ? `/${horizon}日` : ''}`
}

function buildAnalysis(row: TransitionDetailRow) {
  const horizon = row.physics_horizon_days ?? null
  const stageDelta = stageScore(row.to_stage) - stageScore(row.from_stage)
  const currentStages = [row.daily_a, row.daily_b, row.weekly_a, row.weekly_b, row.monthly_a, row.monthly_b]
  const multiStageScore = currentStages.reduce<number>((sum, stage) => sum + stageScore(stage), 0)
  const stageRiskCount = currentStages.filter((stage) => stage === 3 || stage === 4).length
  const stageBullCount = currentStages.filter((stage) => stage === 1 || stage === 6).length
  const slope5 = pctChange(row.ma_5, row.prev_ma_5)
  const slope25 = pctChange(row.ma_25, row.prev_ma_25)
  const slope75 = pctChange(row.ma_75, row.prev_ma_75)
  const slope300 = pctChange(row.ma_300, row.prev_ma_300)
  const prevSlope5 = pctChange(row.prev_ma_5, row.prev2_ma_5)
  const prevSlope25 = pctChange(row.prev_ma_25, row.prev2_ma_25)
  const prevSlope75 = pctChange(row.prev_ma_75, row.prev2_ma_75)
  const prevSlope300 = pctChange(row.prev_ma_300, row.prev2_ma_300)
  const flow5 = flowWord(slope5, prevSlope5)
  const flow25 = flowWord(slope25, prevSlope25)
  const flow75 = flowWord(slope75, prevSlope75)
  const flow300 = flowWord(slope300, prevSlope300)
  const angle5 = calculateAngle(row.ma_5, row.prev_ma_5, 1)
  const angle25 = calculateAngle(row.ma_25, row.prev_ma_25, 1)
  const angle75 = calculateAngle(row.ma_75, row.prev_ma_75, 1)
  const angle300 = calculateAngle(row.ma_300, row.prev_ma_300, 1)
  const prevAngle5 = calculateAngle(row.prev_ma_5, row.prev2_ma_5, 1)
  const prevAngle25 = calculateAngle(row.prev_ma_25, row.prev2_ma_25, 1)
  const angleAccel5 = angle5 != null && prevAngle5 != null ? angle5 - prevAngle5 : null
  const angleAccel25 = angle25 != null && prevAngle25 != null ? angle25 - prevAngle25 : null

  const gap5To25 = gapPct(row.ma_5, row.ma_25)
  const prevGap5To25 = gapPct(row.prev_ma_5, row.prev_ma_25)
  const gap25To75 = gapPct(row.ma_25, row.ma_75)
  const prevGap25To75 = gapPct(row.prev_ma_25, row.prev_ma_75)
  const bundleWidth = bundleWidthPct([row.ma_5, row.ma_25, row.ma_75, row.ma_300])
  const prevBundleWidth = bundleWidthPct([row.prev_ma_5, row.prev_ma_25, row.prev_ma_75, row.prev_ma_300])
  const bundleVelocity = bundleWidth != null && prevBundleWidth != null ? bundleWidth - prevBundleWidth : null

  const positive = [slope5, slope25, slope75].filter((v) => v != null && v > 0.08).length
  const negative = [slope5, slope25, slope75].filter((v) => v != null && v < -0.08).length
  const maBias = positive - negative
  const angleValues = [angle5, angle25, angle75, angle300]
  const angleBias = angleValues.filter((v) => v != null && v > 3).length -
    angleValues.filter((v) => v != null && v < -3).length
  const upAcceleration = [angleAccel5, angleAccel25].filter((v) => v != null && v > 2).length
  const downAcceleration = [angleAccel5, angleAccel25].filter((v) => v != null && v < -2).length
  const isExpansion = bundleVelocity != null && bundleVelocity > 0.15
  const isCompression = bundleVelocity != null && bundleVelocity < -0.15
  const bullishExpansion = isExpansion && maBias > 0 && (gap5To25 ?? 0) > 0
  const bearishExpansion = isExpansion && maBias < 0 && (gap5To25 ?? 0) < 0
  const distanceNotes = [
    bundleVelocity == null
      ? 'MA束幅は未計算'
      : isExpansion
        ? `MA束は拡散中 (${fmtPct(bundleVelocity, 2)}pt)`
        : isCompression
          ? `MA束は収縮中 (${fmtPct(bundleVelocity, 2)}pt)`
          : 'MA束幅は横ばい',
    distanceWord(gap5To25, prevGap5To25, '5-25MA'),
    distanceWord(gap25To75, prevGap25To75, '25-75MA'),
  ]

  const upExplanation = safeParseJson<ExplanationJson>(row.ml_up_explanation_json)
  const downExplanation = safeParseJson<ExplanationJson>(row.ml_down_explanation_json)
  const physicsUpExplanation = safeParseJson<ExplanationJson>(row.physics_up_explanation_json)
  const physicsDownExplanation = safeParseJson<ExplanationJson>(row.physics_down_explanation_json)
  const physicsWaitExplanation = safeParseJson<ExplanationJson>(row.physics_wait_explanation_json)
  const labels = signalLabels(row.signal_codes)
  const objectiveUp = objectiveEvidence(row, 'up')
  const objectiveDown = objectiveEvidence(row, 'down')
  const physicsUpScore = rankScore(row.physics_up_rank, 80) * 26
  const physicsDownScore = rankScore(row.physics_down_rank, 80) * 30
  const physicsWaitScore = rankScore(row.physics_wait_rank, 80) * 8
  const classicUpScore = rankScore(row.ml_up_rank, 80) * 8
  const classicDownScore = rankScore(row.ml_down_rank, 80) * 8
  const stageUpScore = Math.max(0, stageDelta) * 7 + Math.max(0, multiStageScore) * 1.2 + stageBullCount * 2
  const stageDownScore = Math.max(0, -stageDelta) * 7 + Math.max(0, -multiStageScore) * 1.2 + stageRiskCount * 3
  const physicalUpScore =
    Math.max(0, maBias) * 6 +
    Math.max(0, angleBias) * 5 +
    upAcceleration * 4 +
    (bullishExpansion ? 7 : isCompression && maBias >= 0 ? 3 : 0)
  const physicalDownScore =
    Math.max(0, -maBias) * 6 +
    Math.max(0, -angleBias) * 5 +
    downAcceleration * 4 +
    (bearishExpansion ? 8 : isCompression && maBias <= 0 ? 3 : 0)
  const objectiveUpScore = objectiveScore(objectiveUp)
  const objectiveDownScore = objectiveScore(objectiveDown)
  const upForce = clamp(
    30 + stageUpScore + physicalUpScore + physicsUpScore + classicUpScore + objectiveUpScore -
      physicsDownScore * 0.55 - classicDownScore * 0.45 - objectiveDownScore * 0.45 - physicalDownScore * 0.25 - physicsWaitScore,
    0,
    100,
  )
  const downForce = clamp(
    30 + stageDownScore + physicalDownScore + physicsDownScore + classicDownScore + objectiveDownScore -
      physicsUpScore * 0.5 - classicUpScore * 0.35 - objectiveUpScore * 0.4 - physicalUpScore * 0.25 - physicsWaitScore * 0.5,
    0,
    100,
  )
  const forceGap = upForce - downForce

  let label = '中立'
  let tone: 'up' | 'down' | 'neutral' | 'watch' = 'neutral'
  if (downForce >= 72 && (row.physics_down_rank != null || forceGap <= 6)) {
    label = '下落警戒'
    tone = 'down'
  } else if (downForce >= 66 && forceGap < 10) {
    label = '強い悪化'
    tone = 'down'
  } else if (upForce >= 72 && forceGap >= -4) {
    label = '強い好転'
    tone = 'up'
  } else if (upForce >= 58 && forceGap >= -8) {
    label = '好転'
    tone = 'up'
  } else if (stageDelta > 0 || upForce >= 50) {
    label = '好転候補'
    tone = 'watch'
  } else if (stageDelta < 0 && maBias >= 1) {
    label = '一時調整'
    tone = 'watch'
  } else if (downForce >= 50 || stageDelta < 0) {
    label = '悪化注意'
    tone = 'down'
  }

  const dominantDirection: 'up' | 'down' | 'wait' =
    row.physics_down_rank != null && downForce >= upForce
      ? 'down'
      : row.physics_up_rank != null && upForce >= downForce
        ? 'up'
        : row.physics_wait_rank != null
          ? 'wait'
          : forceGap >= 0
            ? 'up'
            : 'down'
  const drivers = [
    stageDelta > 0 ? 'ステージ改善' : stageDelta < 0 ? 'ステージ悪化' : null,
    angleBias > 0 ? 'SMA角度上向き' : angleBias < 0 ? 'SMA角度下向き' : null,
    upAcceleration > 0 && dominantDirection === 'up' ? '上向き加速' : downAcceleration > 0 && dominantDirection === 'down' ? '下向き加速' : null,
    bullishExpansion ? 'MA束上方拡散' : bearishExpansion ? 'MA束下方拡散' : isCompression ? 'MA束収縮' : null,
    dominantDirection === 'up' ? physicsRankDriver('up', row.physics_up_rank, horizon) : null,
    dominantDirection === 'down' ? physicsRankDriver('down', row.physics_down_rank, horizon) : null,
    dominantDirection === 'wait' ? physicsRankDriver('wait', row.physics_wait_rank, horizon) : null,
    dominantDirection === 'up' ? objectiveDriver(objectiveUp) : objectiveDriver(objectiveDown),
  ].filter((v): v is string => Boolean(v))
  const sub = drivers.slice(0, 4).join(' + ') || 'ステージ・SMA角度・物理状態を総合確認'

  let mlTitle = 'ML候補外'
  let insight = '現在はML候補の上位には入っていません。MAの傾きが揃うか、次のステージ変化を確認します。'
  if (dominantDirection === 'down' && row.physics_down_rank != null) {
    mlTitle = `物理ML 下落 #${row.physics_down_rank}`
    insight = physicsDownExplanation?.summary ??
      (objectiveDown.top60HitRate != null
        ? `物理特徴量ベースの下落候補です。${horizon ?? '-'}営業日モデルのtop60的中率は${fmtRate(objectiveDown.top60HitRate)}です。`
        : 'SMA角度・距離・加速度を含む物理特徴量では下落警戒側に近い形です。')
  } else if (dominantDirection === 'up' && row.physics_up_rank != null) {
    mlTitle = `物理ML 上昇 #${row.physics_up_rank}`
    insight = physicsUpExplanation?.summary ??
      (objectiveUp.top60HitRate != null
        ? `物理特徴量ベースの上昇候補です。${horizon ?? '-'}営業日モデルのtop60的中率は${fmtRate(objectiveUp.top60HitRate)}です。`
        : 'SMA角度・距離・加速度を含む物理特徴量では上昇側に近い形です。')
  } else if (row.physics_wait_rank != null) {
    mlTitle = `物理ML 待機 #${row.physics_wait_rank}`
    insight = physicsWaitExplanation?.summary ?? '物理特徴量では方向感よりも待機・様子見に近い形です。'
  } else if (row.ml_up_rank != null) {
    mlTitle = `上昇候補 #${row.ml_up_rank}`
    insight = upExplanation?.summary ?? '過去のMA形状・6ステージの学習結果では上昇候補として抽出されています。'
  } else if (row.ml_down_rank != null) {
    mlTitle = `下落警戒 #${row.ml_down_rank}`
    insight = downExplanation?.summary ?? '過去のMA形状・6ステージの学習結果では下落警戒として抽出されています。'
  } else if (labels.includes('押し目')) {
    mlTitle = '押し目確認'
    insight = '既存シグナルでは押し目候補です。5日MAの上を維持できるかを確認します。'
  } else if (labels.includes('ブレイク前')) {
    mlTitle = 'ブレイク前'
    insight = '既存シグナルではブレイク直前候補です。直近高値を超えられるかが焦点です。'
  }

  const watchPoint =
    physicsDownExplanation?.riskNotes?.[0] ??
    physicsUpExplanation?.watchPoints?.[0] ??
    upExplanation?.watchPoints?.[0] ??
    downExplanation?.riskNotes?.[0] ??
    (label === '下落警戒' || label === '強い悪化'
      ? '反発時の踏み上げ、25日MA回復、下方拡散の鈍化を確認します。'
      : label === '強い好転' || label === '好転'
        ? '上向き角度とMA束の拡散が継続するかを確認します。'
        : maBias >= 2
      ? '短期・中期線の上向きが続くかを確認します。'
      : maBias <= -2
        ? '5日MAと25日MAが下向きのまま広がらないかを確認します。'
        : '次の更新で25日MAの方向がどちらへ傾くかを確認します。')

  return {
    label,
    tone,
    sub,
    flows: [
      { name: '5日', value: slope5, ...flow5 },
      { name: '25日', value: slope25, ...flow25 },
      { name: '75日', value: slope75, ...flow75 },
      { name: '300日', value: slope300, ...flow300 },
    ],
    distanceNotes,
    mlTitle,
    insight,
    watchPoint,
    labels,
    upForce,
    downForce,
  }
}

export async function TransitionDetailTableMock({
  timescale,
  period,
  universe = null,
  asOfDate = null,
}: {
  timescale: Timescale
  period: Period
  universe?: UniverseFilterValue
  asOfDate?: string | null
}) {
  const rows = await getTransitionDetail(timescale, period, universe, 30, asOfDate)
  const total = rows.length

  return (
    <div>
      <div className="sb-hd">
        <h2>{PERIOD_LABEL[period]}のステージ変化 詳細</h2>
        <span>{timescale} · 物理ML {getPhysicsHorizonForPeriod(period)}営業日 · 最大 {total.toLocaleString()} 銘柄表示</span>
      </div>
      <div className="sb-card">
        <div className="overflow-x-auto">
          <table className="sb-tbl" style={{ minWidth: 1480 }}>
            <thead>
              <tr>
                <th style={{ width: 82 }}>コード</th>
                <th style={{ width: 185 }}>銘柄名</th>
                <th style={{ width: 300, whiteSpace: 'nowrap' }}>
                  <span className="inline-flex items-baseline gap-2 whitespace-nowrap">
                    <span>6タイムスケール現在ステージ</span>
                    <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                      日A 日B 週A 週B 月A 月B
                    </span>
                  </span>
                </th>
                <th style={{ width: 92, textAlign: 'center' }}>変化</th>
                <th style={{ width: 200 }}>判定</th>
                <th style={{ width: 270 }}>MAの流れ</th>
                <th>ML / 確認ポイント</th>
                <th style={{ width: 76, textAlign: 'right' }}>株価</th>
                <th style={{ width: 70, textAlign: 'right' }}>前日比</th>
                <th style={{ width: 72, textAlign: 'right' }}>出来高</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const analysis = buildAnalysis(r)
                const tone = r.changePct == null ? '' : r.changePct > 0 ? 'sb-r' : r.changePct < 0 ? 'sb-b' : ''
                return (
                  <tr key={r.ticker} style={{ verticalAlign: 'top' }}>
                    <td className="sb-t" style={{ paddingTop: 13 }}>{r.ticker}</td>
                    <td style={{ paddingTop: 12 }}>
                      <Link href={`/stock/${r.ticker}`} style={{ color: 'inherit', fontWeight: 600 }}>
                        {r.name ?? r.ticker}
                      </Link>
                      {analysis.labels.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {analysis.labels.map((label) => (
                            <span key={label} className="rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-1.5 py-[1px] text-[10px] text-[var(--color-text-secondary)]">
                              {label}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      <StageStrip row={r} selected={timescale} />
                    </td>
                    <td style={{ textAlign: 'center', paddingTop: 11 }}>
                      <span className={`sb-tag ${r.from_stage ? `sb-s${r.from_stage}` : ''}`} style={{ fontSize: 12, padding: '3px 7px' }}>
                        {r.from_stage ?? '-'}
                      </span>{' '}
                      <span style={{ color: 'var(--color-text-tertiary)' }}>→</span>{' '}
                      <span className={`sb-tag ${r.to_stage ? `sb-s${r.to_stage}` : ''}`} style={{ fontSize: 12, padding: '3px 7px' }}>
                        {r.to_stage ?? '-'}
                      </span>
                    </td>
                    <td style={{ paddingTop: 10 }}>
                      <AssessmentBadge label={analysis.label} tone={analysis.tone} />
                      <div className="mt-1 text-[10px] leading-4 text-[var(--color-text-secondary)]">{analysis.sub}</div>
                      <div className="mt-1 text-[10px] leading-4 text-[var(--color-text-tertiary)]">
                        上昇力 {analysis.upForce.toFixed(0)} / 下落力 {analysis.downForce.toFixed(0)}
                      </div>
                    </td>
                    <td style={{ paddingTop: 10 }}>
                      <div className="grid grid-cols-2 gap-1">
                        {analysis.flows.map((flow) => (
                          <FlowChip key={flow.name} name={flow.name} label={flow.label} tone={flow.tone} value={flow.value} />
                        ))}
                      </div>
                      <div className="mt-2 space-y-1 text-[10px] leading-4 text-[var(--color-text-secondary)]">
                        {analysis.distanceNotes.map((note) => <div key={note}>{note}</div>)}
                      </div>
                    </td>
                    <td style={{ paddingTop: 10 }}>
                      <div className="flex flex-col gap-1.5">
                        <span className="w-fit rounded-full border border-[var(--color-border-default)] bg-white px-2 py-[2px] text-[10px] font-semibold text-[var(--color-text-primary)]">
                          {analysis.mlTitle}
                        </span>
                        <div className="text-[11px] leading-5 text-[var(--color-text-primary)]">{analysis.insight}</div>
                        <div className="text-[10px] leading-4 text-[var(--color-text-secondary)]">次に見る点: {analysis.watchPoint}</div>
                      </div>
                    </td>
                    <td className="right" style={{ fontWeight: 600, paddingTop: 12 }}>{r.price?.toLocaleString() ?? '-'}</td>
                    <td className={`right ${tone}`} style={{ paddingTop: 12 }}>
                      {r.changePct == null ? '-' : (r.changePct > 0 ? '+' : '') + r.changePct.toFixed(2)}
                    </td>
                    <td className="right sb-t" style={{ paddingTop: 12 }}>{fmtVol(r.volume)}</td>
                  </tr>
                )
              })}
              {total === 0 && (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'center', padding: 18, color: 'var(--color-text-tertiary)' }}>
                    該当銘柄なし
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function StageStrip({ row, selected }: { row: TransitionDetailRow; selected: Timescale }) {
  return (
    <div className="flex flex-nowrap gap-1.5 py-1">
      {AXIS_ORDER.map((axis) => {
        const stage = (row as unknown as Record<string, number | null>)[axis.col]
        const cls = stage == null ? '' : `sb-s${stage}`
        const isSelected = axis.key === selected
        return (
          <span
            key={axis.key}
            className={`inline-flex min-w-[31px] flex-col items-center rounded-[6px] border px-1.5 py-1 text-center ${cls}`}
            style={{
              borderColor: isSelected ? 'var(--color-text-primary)' : 'var(--color-border-soft)',
              boxShadow: isSelected ? 'inset 0 0 0 1px var(--color-text-primary)' : undefined,
            }}
          >
            <span className="text-[9px] leading-none opacity-70">{axis.label}</span>
            <span className="mt-0.5 text-[15px] font-bold leading-none">{stage ?? '-'}</span>
          </span>
        )
      })}
    </div>
  )
}

function AssessmentBadge({ label, tone }: { label: string; tone: 'up' | 'down' | 'neutral' | 'watch' }) {
  const style: Record<typeof tone, string> = {
    up: 'border-green-200 bg-green-50 text-green-700',
    down: 'border-red-200 bg-red-50 text-red-700',
    watch: 'border-amber-200 bg-amber-50 text-amber-700',
    neutral: 'border-gray-200 bg-gray-50 text-gray-600',
  }
  return (
    <span className={`inline-flex rounded-full border px-2 py-1 text-[11px] font-bold ${style[tone]}`}>
      {label}
    </span>
  )
}

function FlowChip({
  name,
  label,
  tone,
  value,
}: {
  name: string
  label: string
  tone: 'up' | 'down' | 'neutral'
  value: number | null
}) {
  const style: Record<typeof tone, string> = {
    up: 'border-green-200 bg-green-50 text-green-700',
    down: 'border-red-200 bg-red-50 text-red-700',
    neutral: 'border-gray-200 bg-gray-50 text-gray-600',
  }
  return (
    <span className={`rounded-[6px] border px-2 py-1 text-[10px] leading-4 ${style[tone]}`} title={`${name}MA変化率 ${fmtPct(value, 2)}`}>
      <b>{name}</b> {label}
    </span>
  )
}
