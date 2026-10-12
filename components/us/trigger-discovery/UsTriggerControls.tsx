'use client'

// components/us/trigger-discovery/UsTriggerControls.tsx
//
// /us/trigger-discovery 内で使う小さな部品。
// - 入力欄は高さ 36px 固定 (ラベル行も min-h 固定) で、値の長さで行がずれない
// - Score は共有の TriggerScoreCell を使わない (円表記の説明を含むため)。内訳はサーバー値を表示するだけ

import { type ReactNode, useId } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, CircleHelp } from 'lucide-react'
import { DataPopover } from '@/components/shared/DataPopover'
import { StageTag } from '@/components/ui/StageTag'
import {
  TRIGGER_DISCOVERY_STAGE_AXES,
  type TriggerDiscoverySearchRequest,
  type TriggerDiscoverySearchRow,
  type TriggerDiscoverySortKey,
} from '@/lib/trigger-discovery-contract'
import type { TriggerStatus } from '@/lib/trigger-discovery-engine'
import {
  STAGE_AXIS_LABELS,
  STATUS_LABELS,
  STATUS_STYLES,
  fmtUsdCompact,
} from '@/components/us/trigger-discovery/usTriggerDiscoveryShared'

export const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]'
export const FIELD_LABEL = 'text-[11px] font-medium text-[var(--color-text-secondary)]'

export function HelpPopover({ title, children, align = 'center' }: {
  title: string
  children: ReactNode
  align?: 'start' | 'center' | 'end'
}) {
  return (
    <DataPopover
      trigger={<CircleHelp size={13} aria-hidden />}
      title={title}
      align={align}
      triggerAriaLabel={`${title}の説明`}
      triggerTitle={`${title}の説明`}
      triggerClassName="h-5 w-5 shrink-0 justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]"
      showPatternBadge={false}
      openOnHover
      className="max-w-[calc(100vw-24px)] text-[11px] leading-5"
    >
      <div className="space-y-2 text-[11px] leading-5 text-[var(--color-text-secondary)]">
        {children}
      </div>
    </DataPopover>
  )
}

export function Field({
  label,
  value,
  onChange,
  prefix,
  suffix,
  type = 'text',
  inputMode,
  min,
  max,
  step,
  help,
  action,
  placeholder,
  describedBy,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  prefix?: string
  suffix?: string
  type?: 'text' | 'number' | 'date'
  inputMode?: 'decimal' | 'numeric'
  min?: number | string
  max?: number | string
  step?: number | string
  help?: ReactNode
  action?: ReactNode
  placeholder?: string
  describedBy?: string
}) {
  const inputId = useId()
  return (
    <div className="block min-w-0">
      <span className={`mb-1 flex min-h-5 items-center justify-between gap-1 ${FIELD_LABEL}`}>
        <span className="flex min-w-0 items-center gap-0.5">
          <label htmlFor={inputId} className="truncate">{label}</label>
          {help}
        </span>
        {action}
      </span>
      <span className="flex h-9 items-center rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 focus-within:border-[var(--color-brand-500)] focus-within:ring-1 focus-within:ring-[var(--color-brand-100)]">
        {prefix && <span className="mr-1 shrink-0 text-[11px] text-[var(--color-text-tertiary)]" aria-hidden>{prefix}</span>}
        <input
          id={inputId}
          type={type}
          value={value}
          min={min}
          max={max}
          step={step}
          inputMode={inputMode}
          placeholder={placeholder}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={`h-full min-w-0 flex-1 rounded-none !border-0 !bg-transparent p-0 font-mono text-[13px] tabular-nums text-[var(--color-text-primary)] !shadow-none !outline-none !ring-0 placeholder:font-sans placeholder:text-[var(--color-text-tertiary)] focus:!border-0 focus:!bg-transparent focus:!shadow-none focus:!outline-none focus:!ring-0 focus-visible:!outline-none ${type === 'date' ? '' : 'appearance-none'}`}
        />
        {suffix && <span className="ml-1 shrink-0 whitespace-nowrap text-[10px] text-[var(--color-text-tertiary)]" aria-hidden>{suffix}</span>}
      </span>
    </div>
  )
}

/** native <details> 用の summary。キーボード開閉はブラウザ標準に任せる */
export function DisclosureSummary({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <summary className={`inline-flex max-w-full cursor-pointer list-none flex-wrap items-center gap-x-1.5 gap-y-1 rounded-[3px] py-1 pr-1 text-[11px] font-medium text-[var(--color-brand-700)] hover:text-[var(--color-brand-800)] [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}>
      <ChevronRight size={13} className="shrink-0 transition-transform group-open:rotate-90" aria-hidden />
      <span className="whitespace-nowrap">{children}</span>
      {meta}
    </summary>
  )
}

export function MetaBadge({ children, tone = 'brand' }: { children: ReactNode; tone?: 'brand' | 'amber' }) {
  return (
    <span className={`whitespace-nowrap rounded-[3px] px-1.5 py-0.5 text-[9px] font-semibold ${tone === 'amber' ? 'bg-amber-50 text-amber-800' : 'bg-[var(--color-brand-50)] text-[var(--color-brand-800)]'}`}>
      {children}
    </span>
  )
}

export function SortButton({
  label,
  sortKey,
  activeSort,
  onSort,
  ariaLabel,
  align = 'start',
  disabled,
}: {
  label: ReactNode
  sortKey: TriggerDiscoverySortKey
  activeSort: TriggerDiscoverySearchRequest['sort']
  onSort: (key: TriggerDiscoverySortKey) => void
  ariaLabel: string
  align?: 'start' | 'center' | 'end'
  disabled?: boolean
}) {
  const active = activeSort?.key === sortKey
  const alignment = align === 'end' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSort(sortKey)}
      className={`inline-flex min-h-6 w-full items-center ${alignment} gap-0.5 whitespace-nowrap rounded-[2px] transition-colors disabled:cursor-wait ${FOCUS_RING} ${active ? 'font-semibold text-[var(--color-brand-800)]' : 'font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-brand-700)]'}`}
      aria-label={`${ariaLabel}で並べ替え${active ? `（現在${activeSort?.direction === 'asc' ? '昇順' : '降順'}）` : ''}`}
    >
      {label}
      {active && activeSort?.direction === 'asc'
        ? <ArrowUp size={12} className="shrink-0 text-[var(--color-brand-700)]" aria-hidden />
        : active && activeSort?.direction === 'desc'
          ? <ArrowDown size={12} className="shrink-0 text-[var(--color-brand-700)]" aria-hidden />
          : <span className="w-[11px] shrink-0 text-center text-[9px] text-[var(--color-text-tertiary)] opacity-50" aria-hidden>↕</span>}
    </button>
  )
}

export function StatusPill({ status }: { status: TriggerStatus }) {
  return (
    <span className={`inline-flex h-5 items-center whitespace-nowrap rounded-[3px] border px-1.5 text-[10px] font-semibold ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  )
}

export function StageCells({ row }: { row: TriggerDiscoverySearchRow }) {
  const label = TRIGGER_DISCOVERY_STAGE_AXES.map((axis) => `${STAGE_AXIS_LABELS[axis]}${row[axis] ?? '不明'}`).join(' ')
  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap" role="img" aria-label={`6ステージ ${label}`} title={label}>
      {TRIGGER_DISCOVERY_STAGE_AXES.map((axis) => <StageTag key={axis} stage={row[axis]} size="xs" />)}
    </span>
  )
}

/**
 * Trigger Score (0–100) と内訳。値はサーバーの決定的エンジンが算出したもの。
 * 流動性の説明文はサーバー側が円表記で作るため使わず、USD の平均売買代金を添える。
 */
export function UsTriggerScore({ row }: { row: TriggerDiscoverySearchRow }) {
  const breakdown = row.scoreBreakdown
  const detail = [
    ['近さ', breakdown.proximity, breakdown.maximums.proximity, breakdown.explanations.proximity],
    ['接近', breakdown.approach, breakdown.maximums.approach, breakdown.explanations.approach],
    ['MA上向き', breakdown.maTrend, breakdown.maximums.maTrend, breakdown.explanations.maTrend],
    ['Stage構造', breakdown.stageStructure, breakdown.maximums.stageStructure, breakdown.explanations.stageStructure],
    ['流動性', breakdown.liquidity, breakdown.maximums.liquidity, `平均売買代金 ${fmtUsdCompact(row.averageTradingValue)}`],
  ] as const
  const score = Math.round(row.triggerScore)
  return (
    <DataPopover
      trigger={(
        <span className="inline-flex items-baseline">
          <span className="text-[13px] font-semibold tabular-nums text-[var(--color-text-primary)]">{score}</span>
          <span className="ml-0.5 text-[9px] font-normal text-[var(--color-text-tertiary)]">/100</span>
        </span>
      )}
      title={`${row.ticker} の Trigger Score`}
      align="start"
      triggerAriaLabel={`Trigger Score ${score}点。内訳を表示`}
      triggerClassName="h-6 rounded-[3px] px-1 hover:bg-[var(--color-surface-subtle)] focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)] outline-none"
      showPatternBadge={false}
      openOnHover
      className="!w-[264px] max-w-[calc(100vw-24px)]"
    >
      <div className="flex items-baseline justify-between border-b border-[var(--color-border-soft)] pb-2">
        <span className="text-[10px] font-semibold text-[var(--color-text-secondary)]">Trigger条件への適合度</span>
        <strong className="text-[18px] tabular-nums text-[var(--color-text-primary)]">{score}<span className="ml-0.5 text-[10px] font-normal text-[var(--color-text-tertiary)]">/ 100</span></strong>
      </div>
      <ul className="mt-2 space-y-1.5">
        {detail.map(([label, value, maximum, explanation]) => (
          <li key={label} className="text-[10px]">
            <span className="flex items-center justify-between gap-3">
              <span className="text-[var(--color-text-secondary)]">{label}</span>
              <span className="tabular-nums text-[var(--color-text-primary)]">{value.toFixed(1)} / {maximum}</span>
            </span>
            <span className="block text-[9px] leading-4 text-[var(--color-text-tertiary)]">{explanation}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 border-t border-[var(--color-border-soft)] pt-2 text-[9px] leading-4 text-[var(--color-text-tertiary)]">
        条件にどれだけ合っているかの目安で、将来の値動きの予測ではありません。
      </p>
    </DataPopover>
  )
}
