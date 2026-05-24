// components/hex/TransitionDetailTableMock.tsx
// ステージ変化銘柄を、6ステージ・MAの流れ・ML/シグナル示唆まで一行で読める形にする。

import Link from 'next/link'
import { getTransitionDetail, type Timescale, type Period, type TransitionDetailRow } from '@/lib/queries/hex'

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

const PERIOD_LABEL: Record<Period, string> = { today: '本日', week: '今週', month: '今月' }

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

function pctChange(current: number | null, previous: number | null) {
  if (current == null || previous == null || previous <= 0) return null
  return ((current - previous) / previous) * 100
}

function gapPct(shortMa: number | null, longMa: number | null) {
  if (shortMa == null || longMa == null || longMa <= 0) return null
  return ((shortMa - longMa) / longMa) * 100
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

function safeParseJson<T>(raw: string | null): T | null {
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

function buildAnalysis(row: TransitionDetailRow) {
  const stageDelta = stageScore(row.to_stage) - stageScore(row.from_stage)
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

  const gap5To25 = gapPct(row.ma_5, row.ma_25)
  const prevGap5To25 = gapPct(row.prev_ma_5, row.prev_ma_25)
  const gap25To75 = gapPct(row.ma_25, row.ma_75)
  const prevGap25To75 = gapPct(row.prev_ma_25, row.prev_ma_75)

  const positive = [slope5, slope25, slope75].filter((v) => v != null && v > 0.08).length
  const negative = [slope5, slope25, slope75].filter((v) => v != null && v < -0.08).length
  const maBias = positive - negative
  const distanceNotes = [
    distanceWord(gap5To25, prevGap5To25, '5-25MA'),
    distanceWord(gap25To75, prevGap25To75, '25-75MA'),
  ]

  let label = '要確認'
  let tone: 'up' | 'down' | 'neutral' | 'watch' = 'neutral'
  let sub = 'ステージ変化とMAの流れを合わせて確認'
  if (stageDelta > 0 && maBias >= 1) {
    label = '好転'
    tone = 'up'
    sub = 'ステージ改善とMA上向きが同時に出ています'
  } else if (stageDelta > 0) {
    label = '好転候補'
    tone = 'watch'
    sub = 'ステージは改善、MAの追随待ちです'
  } else if (stageDelta < 0 && maBias <= -1) {
    label = '悪化'
    tone = 'down'
    sub = 'ステージ悪化とMA下向きが重なっています'
  } else if (stageDelta < 0 && maBias >= 1) {
    label = '一時調整'
    tone = 'watch'
    sub = 'ステージは悪化もMAはまだ崩れていません'
  } else if (stageDelta < 0) {
    label = '悪化注意'
    tone = 'down'
    sub = 'ステージ悪化後の戻りを確認したい形です'
  }

  const upExplanation = safeParseJson<ExplanationJson>(row.ml_up_explanation_json)
  const downExplanation = safeParseJson<ExplanationJson>(row.ml_down_explanation_json)
  const labels = signalLabels(row.signal_codes)

  let mlTitle = 'ML候補外'
  let insight = '現在はML候補の上位には入っていません。MAの傾きが揃うか、次のステージ変化を確認します。'
  if (row.ml_up_rank != null) {
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
    upExplanation?.watchPoints?.[0] ??
    downExplanation?.riskNotes?.[0] ??
    (maBias >= 2
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
  }
}

export async function TransitionDetailTableMock({ timescale, period }: { timescale: Timescale; period: Period }) {
  const rows = await getTransitionDetail(timescale, period, 30)
  const total = rows.length

  return (
    <div>
      <div className="sb-hd">
        <h2>{PERIOD_LABEL[period]}のステージ変化 詳細</h2>
        <span>{timescale} · 最大 {total.toLocaleString()} 銘柄表示</span>
      </div>
      <div className="sb-card">
        <div className="overflow-x-auto">
          <table className="sb-tbl" style={{ minWidth: 1260 }}>
            <thead>
              <tr>
                <th style={{ width: 82 }}>コード</th>
                <th style={{ width: 185 }}>銘柄名</th>
                <th style={{ width: 230 }}>
                  6タイムスケール現在ステージ
                  <br />
                  <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                    日A 日B 週A 週B 月A 月B
                  </span>
                </th>
                <th style={{ width: 92, textAlign: 'center' }}>変化</th>
                <th style={{ width: 132 }}>判定</th>
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
    <div className="flex flex-wrap gap-1.5 py-1">
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
