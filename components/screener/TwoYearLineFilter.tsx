'use client'

import type { TwoYearLineFilter, TwoYearLinePatternFilter } from '@/lib/two-year-line-registry'

const OPTIONS: Array<{ value: TwoYearLineFilter; label: string }> = [
  { value: 'none', label: '指定なし' },
  { value: 'confirmed', label: '確定ラインあり' },
  { value: 'provisional', label: '暫定ラインあり' },
  { value: 'either', label: '確定・暫定のいずれか' },
]

const PATTERN_OPTIONS: Array<{ value: TwoYearLinePatternFilter; label: string }> = [
  { value: 'either', label: '3本型・4本型' },
  { value: 'three', label: '3本型' },
  { value: 'four', label: '4本型' },
]

export function TwoYearLineFilterControl({
  value,
  onChange,
  pattern = 'either',
  onPatternChange,
  angleMin = '',
  angleMax = '',
  onAngleMinChange,
  onAngleMaxChange,
}: {
  value: TwoYearLineFilter
  onChange: (value: TwoYearLineFilter) => void
  pattern?: TwoYearLinePatternFilter
  onPatternChange?: (value: TwoYearLinePatternFilter) => void
  angleMin?: string
  angleMax?: string
  onAngleMinChange?: (value: string) => void
  onAngleMaxChange?: (value: string) => void
}) {
  const disabled = value === 'none'
  return (
    <div className="grid min-w-0 gap-2 text-[11px] font-bold text-[var(--color-text-secondary)] sm:grid-cols-[minmax(180px,1.2fr)_minmax(130px,0.8fr)_minmax(92px,0.6fr)_minmax(92px,0.6fr)]">
      <label className="flex min-w-0 flex-col gap-1">
        ライン状態
        <select
          data-testid="two-year-line-filter"
          value={value}
          onChange={(event) => onChange(event.target.value as TwoYearLineFilter)}
          className="min-h-11 w-full min-w-0 rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 text-xs font-semibold text-[var(--color-text-primary)] sm:min-h-9"
        >
          {OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label className="flex min-w-0 flex-col gap-1">
        パターン
        <select
          value={pattern}
          disabled={disabled}
          onChange={(event) => onPatternChange?.(event.target.value as TwoYearLinePatternFilter)}
          className="min-h-11 w-full min-w-0 rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 text-xs font-semibold text-[var(--color-text-primary)] disabled:bg-[var(--color-surface-subtle)] disabled:text-[var(--color-text-tertiary)] sm:min-h-9"
        >
          {PATTERN_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <AngleInput label="角度 下限" value={angleMin} disabled={disabled} onChange={onAngleMinChange} />
      <AngleInput label="角度 上限" value={angleMax} disabled={disabled} onChange={onAngleMaxChange} />
      <span className="font-normal leading-4 text-[var(--color-text-tertiary)] sm:col-span-4">
        条件判定はページ分割前に全適格銘柄へ適用します。標準化角度は年20%上昇で45°です。
      </span>
    </div>
  )
}

function AngleInput({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: string
  disabled: boolean
  onChange?: (value: string) => void
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      {label}
      <div className="relative">
        <input
          type="number"
          min="0"
          max="90"
          step="1"
          inputMode="decimal"
          placeholder="指定なし"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange?.(event.target.value)}
          className="min-h-11 w-full rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 pr-7 text-xs font-semibold text-[var(--color-text-primary)] disabled:bg-[var(--color-surface-subtle)] disabled:text-[var(--color-text-tertiary)] sm:min-h-9"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-normal text-[var(--color-text-tertiary)]">°</span>
      </div>
    </label>
  )
}

export function TwoYearLineResultBadge({
  status,
  pattern,
  periods,
  startClose,
  endClose,
  angleDeg,
  lastCandleRisePct,
  confirmedDistancePct,
  asOfDate,
  priceBasisVersion,
}: {
  status?: 'confirmed' | 'provisional' | null
  pattern?: 'three' | 'four' | null
  periods?: readonly number[] | null
  startClose?: number | null
  endClose?: number | null
  angleDeg?: number | null
  lastCandleRisePct?: number | null
  confirmedDistancePct?: number | null
  asOfDate?: string | null
  priceBasisVersion?: string | null
}) {
  if (!status) return null
  const label = status === 'confirmed' ? '2年線 確定' : '2年線 暫定'
  const patternLabel = pattern === 'four' ? '4本型' : pattern === 'three' ? '3本型' : ''
  const periodLabel = periods ? periods.join('→') : ''
  const closeLabel = Number.isFinite(startClose) && Number.isFinite(endClose)
    ? `始点 ${Number(startClose).toLocaleString()} → 終点 ${Number(endClose).toLocaleString()}`
    : ''
  const metricLabel = [
    Number.isFinite(angleDeg) ? `角度 ${Number(angleDeg).toFixed(1)}°` : '',
    Number.isFinite(lastCandleRisePct) ? `上昇率 ${formatSigned(Number(lastCandleRisePct))}%` : '',
    Number.isFinite(confirmedDistancePct) ? `確定ライン比 ${formatSigned(Number(confirmedDistancePct))}%` : '',
  ].filter(Boolean).join(' / ')
  const detail = [patternLabel, periodLabel, closeLabel, metricLabel, asOfDate ? `基準 ${asOfDate}` : ''].filter(Boolean).join(' / ')
  const basisLabel = priceBasisVersion ? `価格basis ${priceBasisVersion}` : ''
  return (
    <span
      className={status === 'confirmed'
        ? 'inline-flex max-w-full flex-col items-start rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold leading-4 text-emerald-800'
        : 'inline-flex max-w-full flex-col items-start rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold leading-4 text-amber-800'}
      title={[detail, priceBasisVersion ? `価格basis: ${priceBasisVersion}` : ''].filter(Boolean).join(' / ') || undefined}
      aria-label={[label, detail, basisLabel].filter(Boolean).join('、')}
    >
      <span>{label}{patternLabel ? `・${patternLabel}` : ''}{periodLabel ? ` ${periodLabel}` : ''}</span>
      {(metricLabel || closeLabel || asOfDate) && <span className="font-medium opacity-80">{[metricLabel, closeLabel, asOfDate].filter(Boolean).join(' / ')}</span>}
    </span>
  )
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`
}
