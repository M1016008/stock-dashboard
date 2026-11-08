'use client'

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { StageTimelineSnapshot } from '@/components/stock/StageTimeline'
import { STAGE_BG_COLORS, STAGE_BORDER_COLORS, STAGE_LABELS } from '@/lib/hex-stage'
import { describePhysicalScore } from '@/lib/physical-momentum-view'
import { formatTechnicalSnapshotDateLabel } from '@/lib/stock-decision-summary'
import { ScoreThresholdBar } from './ScoreThresholdBar'
import {
  angleDirectionColor,
  angleDirectionLabel,
  fmtDeg,
  formatDelta,
  MA_ANGLE_KEYS,
  MA_FIELD_THRESHOLD_DEG,
  maFieldInputs,
  nearestBoundaryText,
  PHYSICAL_BOUNDARIES,
  STAGE_TIMEFRAME_LABELS,
  type MaAngleSet,
  type TechnicalMomentumSnapshot,
} from './technical-view'

// JP/US 個別銘柄「チャート・6ステージ」タブの現在構造(結論・MAの傾き・3スコア・6ステージ)。
// 市場差は market で分ける: 見出しIDの接頭辞(US は us-)と、3スコアの比較対象の文言・スコア鮮度の注記。
type TechnicalMarket = 'JP' | 'US'

function technicalId(market: TechnicalMarket, id: string): string {
  return market === 'US' ? `us-${id}` : id
}

const CHART_STAGE_AXES: Array<{
  key: keyof NonNullable<StageTimelineSnapshot['stages']>
  label: string
}> = [
  { key: 'dailyA', label: '日A' },
  { key: 'dailyB', label: '日B' },
  { key: 'weeklyA', label: '週A' },
  { key: 'weeklyB', label: '週B' },
  { key: 'monthlyA', label: '月A' },
  { key: 'monthlyB', label: '月B' },
]

/** チャート高さは画面幅に合わせる(狭い画面でローソクが十分見え、広い画面で縦に伸びすぎない)。表示専用 */
export function useChartHeight(): number {
  const [height, setHeight] = useState(460)
  useEffect(() => {
    const phone = window.matchMedia('(max-width: 480px)')
    const tablet = window.matchMedia('(max-width: 1023px)')
    const wide = window.matchMedia('(min-width: 1280px)')
    const update = () => setHeight(phone.matches ? 320 : tablet.matches ? 400 : wide.matches ? 480 : 460)
    update()
    const lists = [phone, tablet, wide]
    lists.forEach((list) => list.addEventListener('change', update))
    return () => lists.forEach((list) => list.removeEventListener('change', update))
  }, [])
  return height
}

export function TechnicalChartSnapshot({
  market,
  stage,
  momentum,
  analysisDate,
  chart,
}: {
  market: TechnicalMarket
  stage: StageTimelineSnapshot
  momentum: TechnicalMomentumSnapshot
  analysisDate: string | null
  chart: ReactNode
}) {
  const stageCode = stage.stages
    ? CHART_STAGE_AXES.map(({ key }) => stage.stages?.[key] ?? '-').join('')
    : '------'
  const referenceDateLabel = formatTechnicalSnapshotDateLabel({
    stageDate: stage.date,
    scoreDate: momentum.scoreDate,
    maDate: momentum.maDate,
    analysisDate,
  })
  const stageMessage = stage.status === 'loading'
    ? '6ステージを読み込み中'
    : stage.status === 'error'
      ? `6ステージを取得できませんでした(${stage.message ?? '詳細不明'})`
      : stage.status === 'missing'
        ? stage.message ?? '6ステージの履歴がありません'
        : '6ステージの値を取得できませんでした'
  const momentumReady = momentum.status === 'available'
  const stateColor = momentumReady ? momentum.maColor ?? 'var(--text-muted)' : 'var(--text-muted)'
  const stateTitle = momentumReady
    ? momentum.maStructure ?? 'MA力場は未判定'
    : momentum.status === 'loading'
      ? '読み込み中'
      : momentum.status === 'error'
        ? 'MA力場を取得できませんでした'
        : 'MA力場は未算出'
  const stateDescription = momentumReady
    ? momentum.maDescription
    : momentum.status === 'loading'
      ? '移動平均の角度を読み込んでいます。'
      : momentum.message ?? '移動平均の角度から状態を判定できませんでした。'

  // 結論(全幅) → チャート ┬ 根拠レール(MA・3スコア) → 6ステージ(全幅の1帯)。DOM順=読み順。
  // xl のレールにはMAと3スコアだけを置き、チャート列との高さ差で余白が生まれないよう6ステージは列の外に出す。各ブロックは内容なりの高さ
  return (
    <section className="bg-white" aria-labelledby={technicalId(market, 'technical-snapshot-title')} data-section="Technical snapshot" data-stage-code={stageCode}>
      <div className="space-y-3 p-3 sm:p-4">
        <TechnicalStateHero color={stateColor} title={stateTitle} description={stateDescription} />
        <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(400px,440px)] xl:gap-x-5">
          <div className="min-w-0">{chart}</div>
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <h2 id={technicalId(market, 'technical-snapshot-title')} className="m-0 text-[14px] font-bold text-[var(--color-text-primary)]">現在の技術構造</h2>
              <span className="font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]">{referenceDateLabel}</span>
            </div>
            <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-1">
              <TechnicalMaEvidence market={market} momentum={momentum} />
              <TechnicalScorePanel market={market} momentum={momentum} className="border-t border-[var(--color-border-soft)] pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0 xl:border-l-0 xl:border-t xl:pl-0 xl:pt-3" />
            </div>
          </div>
        </div>
        <TechnicalStageMap market={market} stage={stage} stageCode={stageCode} stageMessage={stageMessage} />
      </div>
    </section>
  )
}

type MaSignal = 'up' | 'down' | 'flat'

/** Current State(buildMaFieldInsight)と同じ ±MA_FIELD_THRESHOLD_DEG で向きを分ける */
function maSignalOf(deg: number | null | undefined): MaSignal | null {
  if (deg == null || !Number.isFinite(deg)) return null
  if (deg > MA_FIELD_THRESHOLD_DEG) return 'up'
  if (deg < -MA_FIELD_THRESHOLD_DEG) return 'down'
  return 'flat'
}

function maSignalColor(signal: MaSignal | null): string {
  if (signal === 'up') return 'var(--price-up)'
  if (signal === 'down') return 'var(--price-down)'
  return signal === 'flat' ? 'var(--text-secondary)' : 'var(--text-muted)'
}

function maSignalGlyph(signal: MaSignal | null): string {
  if (signal === 'up') return '↗'
  if (signal === 'down') return '↘'
  return signal === 'flat' ? '→' : '—'
}

/** 本数・平均は maFieldInputs、多数派と逆向きの判定は同じ MA_FIELD_THRESHOLD_DEG を再利用する */
function summarizeMaEvidence(angles: MaAngleSet) {
  const inputs = maFieldInputs(angles)
  const majority: 'up' | 'down' | null = inputs.up > inputs.down ? 'up' : inputs.down > inputs.up ? 'down' : null
  const contrary = MA_ANGLE_KEYS.filter(({ key }) => {
    const signal = maSignalOf(angles[key])
    return majority != null && signal != null && signal !== 'flat' && signal !== majority
  })
  return { inputs, majority, contrary, flat: inputs.total - inputs.up - inputs.down }
}

/** このタブ唯一の主結論(20px)。他の結論(運動状態など)は15px以下にして競合させない */
function TechnicalStateHero({ color, title, description }: { color: string; title: string; description: string | null }) {
  const glyph = color === 'var(--price-up)' ? '↗' : color === 'var(--price-down)' ? '↘' : color === 'var(--text-secondary)' ? '→' : '—'
  return (
    <div
      className="flex min-w-0 items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-white px-3 py-2"
      style={{ borderLeftWidth: 3, borderLeftColor: color }}
      data-technical-current-state
    >
      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center text-[28px] font-extrabold leading-none" style={{ color }}>{glyph}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] font-bold text-[var(--color-text-tertiary)]">
          <span>現在の状態 ・ MA力場</span>
          <span className="font-medium">移動平均の角度から判定</span>
        </div>
        {/* 広い画面では結論と説明を1行に並べ、狭い画面では説明が結論の下に回る */}
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
          <h3 className="m-0 text-[20px] font-extrabold leading-tight [text-wrap:pretty]" style={{ color }}>{title}</h3>
          {description && <p className="m-0 min-w-0 flex-1 basis-[22rem] text-[12px] font-medium leading-5 text-[var(--color-text-secondary)] [text-wrap:pretty]">{description}</p>}
        </div>
      </div>
    </div>
  )
}

const TECHNICAL_MA_GROUPS = [
  { title: '短期', caption: '5・25MA', keys: ['ma5', 'ma25'], avg: 'shortAvg' },
  { title: '長期', caption: '75・200MA', keys: ['ma75', 'ma200'], avg: 'longAvg' },
] as const

/** 角度どおりに傾けた矢印(表示専用。破線は水平) */
function MaTiltArrow({ deg, color }: { deg: number | null; color: string }) {
  if (deg == null) return <span aria-hidden="true" className="w-7 text-center font-mono text-[14px] font-black" style={{ color }}>—</span>
  const tilt = Math.max(-75, Math.min(75, deg))
  return (
    <svg aria-hidden="true" focusable="false" width="28" height="24" viewBox="0 0 28 24" className="shrink-0 overflow-visible">
      <line x1="1" y1="12" x2="27" y2="12" stroke="var(--color-border-default)" strokeWidth="1" strokeDasharray="2 2" />
      <g transform={`rotate(${-tilt} 14 12)`} stroke={color} fill={color}>
        <line x1="4" y1="12" x2="21" y2="12" strokeWidth="2" strokeLinecap="round" />
        <path d="M27 12 L19 7.5 L19 16.5 Z" stroke="none" />
      </g>
    </svg>
  )
}

function TechnicalMaEvidence({ market, momentum, className = '' }: { market: TechnicalMarket; momentum: TechnicalMomentumSnapshot; className?: string }) {
  const angles = momentum.maAngles
  const evidence = angles ? summarizeMaEvidence(angles) : null
  const statusNote = momentum.status === 'loading'
    ? 'MAの角度を読み込み中'
    : momentum.status === 'error'
      ? `MAの角度を取得できませんでした${momentum.message ? `(${momentum.message})` : ''}`
      : momentum.status === 'missing'
        ? momentum.message ?? 'MAの角度は未算出です'
        : 'MAの角度を表示できません'
  const spread = momentum.maSpreadDeg
  const spreadChange = momentum.maSpreadChangeDeg
  const titleId = technicalId(market, 'technical-ma-evidence-title')

  return (
    <section className={`min-w-0 ${className}`} aria-labelledby={titleId} data-technical-ma-evidence>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 id={titleId} className="m-0 text-[12px] font-bold text-[var(--color-text-primary)]">MAの傾き</h3>
        <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">この銘柄自身の絶対角度</span>
        {spread != null && (
          <span className="ml-auto font-mono text-[11px] font-semibold text-[var(--color-text-secondary)]" title="4本のMA角度の最大と最小の差。前回比は直前の営業日との差です">
            角度幅 <b className="text-[var(--color-text-primary)]">{spread.toFixed(1)}°</b>
            {spreadChange != null && <> 前回比 <b className="text-[var(--color-text-primary)]">{fmtDeg(spreadChange)}</b>({spreadChange > 0 ? '拡大' : spreadChange < 0 ? '縮小' : '不変'})</>}
          </span>
        )}
      </div>
      {evidence ? (
        <p className="m-0 mt-1 text-[12px] font-semibold leading-5 text-[var(--color-text-primary)]">
          {evidence.inputs.total}本のMAのうち、上向き<b className="font-mono" style={{ color: 'var(--price-up)' }}>{evidence.inputs.up}</b>本・下向き<b className="font-mono" style={{ color: 'var(--price-down)' }}>{evidence.inputs.down}</b>本
          <span className="font-medium text-[var(--color-text-tertiary)]">(±{MA_FIELD_THRESHOLD_DEG}°超)</span>
          {evidence.flat > 0 && <span className="font-medium text-[var(--color-text-secondary)]">・横ばい{evidence.flat}本</span>}
          {evidence.contrary.length > 0 && evidence.majority && (
            <>。<b>{evidence.contrary.map(({ label }) => label).join('・')}</b>は多数派({evidence.majority === 'up' ? '上向き' : '下向き'})と逆向き</>
          )}
        </p>
      ) : (
        <p className="m-0 mt-1 text-[11px] font-medium leading-5 text-[var(--color-text-tertiary)]">{statusNote}</p>
      )}
      <div className="mt-2 space-y-2">
        {TECHNICAL_MA_GROUPS.map((group) => {
          const avg = evidence ? evidence.inputs[group.avg] : null
          const avgSignal = maSignalOf(avg)
          const avgColor = maSignalColor(avgSignal)
          return (
            <div key={group.title} role="group" aria-label={`${group.title}(${group.caption})`} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-bold text-[var(--color-text-secondary)]">
                  {group.title} <span className="font-mono font-medium text-[var(--color-text-tertiary)]">{group.caption}</span>
                </span>
                <span className="whitespace-nowrap font-mono text-[11px] font-bold tabular-nums" style={{ color: avgColor }}>
                  <span className="font-sans font-medium text-[var(--color-text-tertiary)]">平均 </span>
                  <span aria-hidden="true">{maSignalGlyph(avgSignal)} </span>{fmtDeg(avg)}
                </span>
              </div>
              <div role="list" className="mt-0.5 divide-y divide-[var(--color-border-soft)]">
                {group.keys.map((key) => {
                  const label = MA_ANGLE_KEYS.find((item) => item.key === key)?.label ?? key
                  const deg = angles?.[key] ?? null
                  const color = angleDirectionColor(deg)
                  const word = angleDirectionLabel(deg)
                  const isContrary = evidence?.contrary.some((item) => item.key === key) ?? false
                  return (
                    <div
                      key={key}
                      role="listitem"
                      aria-label={`${label} ${word}${deg == null ? '' : ` ${fmtDeg(deg)}`}${isContrary ? ' 多数派と逆向き' : ''}`}
                      className="grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)_3.75rem_3.5rem] items-center gap-x-2 py-1 sm:grid-cols-[5.5rem_1.75rem_minmax(0,1fr)_3.75rem_3.5rem]"
                      title={`${label} ${word}${deg == null ? '' : ` ${fmtDeg(deg)}`}。矢印は角度どおりの傾きで、チャート上の見た目の傾きとは異なります`}
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-x-1 text-[12px] font-bold text-[var(--color-text-secondary)]">
                        {label}
                        {isContrary && <span className="border border-dashed border-[var(--color-text-secondary)] px-1 text-[11px] font-bold leading-4 text-[var(--color-text-primary)]">逆向き</span>}
                      </span>
                      <span className="flex justify-center max-sm:hidden"><MaTiltArrow deg={deg} color={color} /></span>
                      <MaAngleBar deg={deg} color={color} />
                      <strong className="whitespace-nowrap text-right font-mono text-[13px] font-bold tabular-nums" style={{ color }}>{deg == null ? '—' : fmtDeg(deg)}</strong>
                      <span className="whitespace-nowrap text-[11px] font-semibold" style={{ color }}>{word}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <p className="m-0 mt-1.5 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
        バーは±{MA_BAR_SCALE_DEG}°で頭打ち ・ 縦線=±{MA_STRONG_DEG}°(強)
      </p>
    </section>
  )
}

const MA_BAR_SCALE_DEG = 45
const MA_STRONG_DEG = 3

/** 角度の正負・大きさを0中心で示す表示専用バー。±MA_STRONG_DEG(「強」の表示基準)に縦線を引く。強い側は濃く、弱い側は淡く塗る */
function MaAngleBar({ deg, color }: { deg: number | null; color: string }) {
  const numeric = deg != null && Number.isFinite(deg) ? deg : null
  const ratio = numeric != null ? Math.min(1, Math.abs(numeric) / MA_BAR_SCALE_DEG) : 0
  const strong = numeric != null && Math.abs(numeric) >= MA_STRONG_DEG
  const tick = (MA_STRONG_DEG / MA_BAR_SCALE_DEG) * 50
  return (
    <span aria-hidden="true" className="relative block h-3 min-w-0 bg-[var(--color-surface-subtle)]">
      {numeric != null && ratio > 0 && (
        <span
          className="absolute inset-y-0"
          style={{
            width: `${Math.max(2, ratio * 50)}%`,
            ...(numeric < 0 ? { right: '50%' } : { left: '50%' }),
            background: color,
            opacity: strong ? 1 : 0.45,
          }}
        />
      )}
      <span className="absolute inset-y-0 w-px bg-black/20" style={{ left: `${50 - tick}%` }} />
      <span className="absolute inset-y-0 w-px bg-black/20" style={{ left: `${50 + tick}%` }} />
      <span className="absolute inset-y-[-2px] left-1/2 w-px bg-[var(--color-border-strong)]" />
    </span>
  )
}

/** 既存の6軸の値だけから、最頻ステージと多数派から異なる軸を表示用に集約する */
function summarizeStageAxes(stages: NonNullable<StageTimelineSnapshot['stages']>) {
  const known = CHART_STAGE_AXES.flatMap(({ key, label }) => {
    const value = stages[key]
    return value == null ? [] : [{ label, value }]
  })
  if (known.length === 0) return null
  const counts: Record<number, number> = {}
  known.forEach(({ value }) => { counts[value] = (counts[value] ?? 0) + 1 })
  const ranked = Object.entries(counts)
    .map(([value, count]) => [Number(value), count] as const)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
  const [topStage, topCount] = ranked[0]
  const tied = ranked.length > 1 && ranked[1][1] === topCount
  return {
    known: known.length,
    ranked,
    topStage,
    topCount,
    tied,
    exceptions: tied ? [] : known.filter(({ value }) => value !== topStage),
  }
}

function TechnicalStageMap({
  market,
  stage,
  stageCode,
  stageMessage,
}: {
  market: TechnicalMarket
  stage: StageTimelineSnapshot
  stageCode: string
  stageMessage: string
}) {
  const summary = stage.stages ? summarizeStageAxes(stage.stages) : null
  const missingCount = summary ? CHART_STAGE_AXES.length - summary.known : 0
  const titleId = technicalId(market, 'technical-stage-title')
  return (
    <section className="min-w-0 border-t border-[var(--color-border-soft)] pt-3" aria-labelledby={titleId} data-technical-stage-map>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
        <h3 id={titleId} className="m-0 text-[12px] font-bold text-[var(--color-text-primary)]">
          6ステージ <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">日・週・月のMAの並び(短期→長期)</span>
        </h3>
        {summary ? (
          <p className="m-0 text-[12px] font-semibold leading-5 text-[var(--color-text-primary)]">
            {summary.tied ? (
              <>{summary.ranked.map(([value, count]) => `S${value} ${STAGE_LABELS[value]} ${count}軸`).join('・')}に分かれています</>
            ) : summary.exceptions.length === 0 ? (
              <>{summary.known}軸すべてが S{summary.topStage} {STAGE_LABELS[summary.topStage]}</>
            ) : (
              <>
                {summary.known}軸中{summary.topCount}軸が S{summary.topStage} {STAGE_LABELS[summary.topStage]}
                <span className="font-medium text-[var(--color-text-secondary)]">
                  ・多数派と異なる軸 {summary.exceptions.map(({ label, value }) => `${label} S${value} ${STAGE_LABELS[value]}`).join('・')}
                </span>
              </>
            )}
            {missingCount > 0 && <span className="font-medium text-[var(--color-text-tertiary)]">・未取得{missingCount}軸</span>}
          </p>
        ) : (
          <p className="m-0 text-[11px] font-medium leading-5 text-[var(--color-text-tertiary)]">{stageMessage}</p>
        )}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5 sm:gap-2" aria-label={`6ステージ ${stageCode}`}>
        {[0, 2, 4].map((start) => (
          <div key={start} role="group" aria-label={STAGE_TIMEFRAME_LABELS[start / 2]} className="min-w-0">
            <span className="mb-1 block text-[11px] font-bold text-[var(--color-text-secondary)]">{STAGE_TIMEFRAME_LABELS[start / 2]}</span>
            <div role="list" className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {CHART_STAGE_AXES.slice(start, start + 2).map(({ key, label }) => {
                const value = stage.stages?.[key] ?? null
                const isException = value != null && summary != null && summary.exceptions.some((item) => item.label === label)
                return (
                  <div
                    key={key}
                    role="listitem"
                    aria-label={value ? `${label} S${value} ${STAGE_LABELS[value]}${isException ? ' 多数派と異なる軸' : ''}` : `${label} 未取得`}
                    data-stage-axis={label}
                    className="flex min-w-0 flex-wrap items-baseline justify-center gap-x-1.5 border px-1.5 py-1 text-center leading-tight"
                    style={{
                      background: value ? STAGE_BG_COLORS[value] : 'var(--color-surface-subtle)',
                      borderColor: value ? STAGE_BORDER_COLORS[value] : 'var(--color-border-default)',
                      borderWidth: isException ? 2 : 1,
                      borderStyle: isException ? 'dashed' : 'solid',
                    }}
                    title={value ? `${label} S${value}: ${STAGE_LABELS[value]}` : stageMessage}
                  >
                    <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">{label}</span>
                    <strong className="font-mono text-[14px] leading-tight text-[var(--color-text-primary)]">{value ? `S${value}` : '—'}</strong>
                    {isException && <b className="text-[11px] font-bold text-[var(--color-text-primary)]">異なる軸</b>}
                    {value && <span className="break-words text-[11px] font-semibold leading-tight text-[var(--color-text-secondary)]">{STAGE_LABELS[value]}</span>}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      {stage.status !== 'available' && summary && <div className="mt-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">{stageMessage}</div>}
    </section>
  )
}

const TECHNICAL_SCORE_ROWS = [
  { kind: 'pms', code: 'PMS', label: '総合の強さ', neutral: false },
  { kind: 'pfs', code: 'PFS', label: '足元の力の向き', neutral: false },
  { kind: 'pes', code: 'PES', label: '値動きの熱量', neutral: true },
] as const

function TechnicalScorePanel({ market, momentum, className = '' }: { market: TechnicalMarket; momentum: TechnicalMomentumSnapshot; className?: string }) {
  const values = { pms: momentum.pms, pfs: momentum.pfs, pes: momentum.pes }
  const statusDetail = momentum.status === 'loading' ? '読み込み中' : momentum.status === 'error' ? '取得できません' : '未算出'
  const rowGrid = 'grid-cols-[6.5rem_minmax(0,1fr)]'
  const titleId = technicalId(market, 'technical-score-title')
  return (
    <section className={`min-w-0 ${className}`} aria-labelledby={titleId} data-technical-scores>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 id={titleId} className="m-0 text-[12px] font-bold text-[var(--color-text-primary)]">3スコア</h3>
        <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{market === 'US' ? 'US市場全体との差(日足)' : '市場全体との差(日足)'}</span>
      </div>
      <div className="mt-2 space-y-1">
        <div className={`grid gap-x-2 ${rowGrid}`} aria-hidden="true">
          <span />
          <span className="grid grid-cols-[auto_minmax(0,1fr)_auto] pr-[3.25rem] font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]" title="バーは-2.5〜+2.5で頭打ちです">
            <span className="whitespace-nowrap">-2.5</span>
            <span className="whitespace-nowrap text-center">0=市場平均</span>
            <span className="whitespace-nowrap">+2.5</span>
          </span>
        </div>
        {TECHNICAL_SCORE_ROWS.map(({ kind, code, label, neutral }) => {
          const value = values[kind]
          const marks = PHYSICAL_BOUNDARIES.find((item) => item.code === code)?.marks ?? []
          return (
            <div
              key={code}
              className={`grid min-w-0 items-center gap-x-2 gap-y-0.5 ${rowGrid}`}
              data-score={code}
              title={momentum.status === 'available' ? `${label} ${code} ・ 判定境界まで ${nearestBoundaryText(value, marks)}` : undefined}
            >
              <span className="min-w-0 leading-tight">
                <span className="block text-[12px] font-bold text-[var(--color-text-primary)]">{label}</span>
                <span className="font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]">{code}</span>
              </span>
              <ScoreThresholdBar label={`${label} ${code}`} value={value} text={formatDelta(value)} neutral={neutral} marks={marks} />
              <span className="col-start-2 text-[11px] font-medium leading-4 text-[var(--color-text-secondary)]">
                {momentum.status === 'available' ? describePhysicalScore(kind, value) : statusDetail}
              </span>
            </div>
          )
        })}
      </div>
      <p className="m-0 mt-1.5 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
        縦線=判定の境界({PHYSICAL_BOUNDARIES.map(({ code, marks }) => `${code} ${marks.map(formatDelta).join('/')}`).join(' ・ ')})。熱量(PES)は方向ではなく活動量です。
      </p>
      {momentum.status !== 'available' ? (
        <div className="mt-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">
          {momentum.status === 'loading' ? 'PMS/PFS/PESを読み込み中' : momentum.message ?? 'PMS/PFS/PESは表示できません'}
        </div>
      ) : market === 'US' ? (
        // US: スコアがMAより古い・標準化前のときは、その旨を注意色で示す
        (momentum.message || (momentum.isScoreFresh === false && momentum.scoreDate)) ? (
          <div className="mt-1 text-[11px] font-medium text-amber-800">
            {momentum.message ?? `スコア算出日 ${momentum.scoreDate}(MAは ${momentum.maDate})`}
          </div>
        ) : momentum.isScoreFresh === false && !momentum.scoreDate ? (
          <div className="mt-1 text-[11px] font-medium text-amber-800">標準化済みスコアはまだありません</div>
        ) : null
      ) : (momentum.message || (momentum.isScoreFresh === false && momentum.scoreDate)) && (
        <div className="mt-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">
          {momentum.message ?? `スコア算出日 ${momentum.scoreDate}`}
        </div>
      )}
    </section>
  )
}
