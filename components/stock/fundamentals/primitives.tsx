'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, Info, type LucideIcon } from 'lucide-react'
import { peerZone, PEER_ZONE_LABELS } from '@/components/stock/StockAnalysisVisuals'
import { clampPercent, positionInRange, type Direction } from './format'

/* ------------------------------------------------------------------ */
/* Section scaffolding                                                 */
/* ------------------------------------------------------------------ */

/** 各サブタブ先頭の見出し。結論 → 根拠 → 詳細 → 定義 の読み順を最初に宣言する。 */
export function TabBanner({
  icon: Icon,
  id,
  title,
  lead,
  meta,
  flow,
}: {
  icon: LucideIcon
  id: string
  title: string
  lead: string
  meta?: ReactNode
  /** 読み順ガイド (例: 結論 → 根拠 → 詳細) */
  flow?: string[]
}) {
  return (
    <header className="border-y border-[var(--color-border-soft)] bg-white px-4 py-3.5 sm:px-5" data-fundamental-banner>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-start gap-2">
          <Icon size={18} className="mt-0.5 shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id={id} className="text-[16px] font-bold leading-tight text-[var(--color-text-primary)]">{title}</h2>
            <p className="mt-1 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">{lead}</p>
          </div>
        </div>
        {meta && <div className="text-right font-mono text-[11px] font-semibold leading-4 text-[var(--color-text-tertiary)]">{meta}</div>}
      </div>
      {flow && flow.length > 0 && (
        <ol className="mt-2.5 flex flex-wrap items-center gap-x-1 gap-y-1 text-[11px] font-bold text-[var(--color-text-tertiary)]" aria-label="読む順番">
          {flow.map((step, index) => (
            <li key={step} className="inline-flex items-center gap-1">
              <span className="inline-flex h-4 w-4 items-center justify-center bg-[var(--color-brand-900)] font-mono text-[11px] leading-none text-white">{index + 1}</span>
              <span className="text-[var(--color-text-secondary)]">{step}</span>
              {index < flow.length - 1 && <ChevronRight size={12} aria-hidden="true" className="mx-0.5" />}
            </li>
          ))}
        </ol>
      )}
    </header>
  )
}

export function PanelSection({
  icon: Icon,
  id,
  title,
  lead,
  aside,
  children,
  bleed = false,
}: {
  icon?: LucideIcon
  id: string
  title: string
  lead?: string
  aside?: ReactNode
  children: ReactNode
  /** true のとき本文を余白なしで流す(表・グラフ用) */
  bleed?: boolean
}) {
  return (
    <section className="overflow-hidden border-y border-[var(--color-border-soft)] bg-white" aria-labelledby={id}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--color-border-soft)] px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-start gap-2">
          {Icon && <Icon size={15} className="mt-0.5 shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />}
          <div className="min-w-0">
            <h3 id={id} className="text-[14px] font-bold leading-tight text-[var(--color-text-primary)]">{title}</h3>
            {lead && <p className="mt-0.5 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">{lead}</p>}
          </div>
        </div>
        {aside}
      </div>
      <div className={bleed ? '' : 'px-4 py-3.5 sm:px-5'}>{children}</div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Status / states                                                     */
/* ------------------------------------------------------------------ */

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="grid min-h-40 place-items-center border-y border-[var(--color-border-soft)] bg-white px-4 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">
      {label}
    </div>
  )
}

export function ErrorBlock({ label, onRetry }: { label: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex min-h-32 flex-col items-center justify-center gap-2 border-y border-[var(--color-border-soft)] bg-white px-4 py-6 text-center">
      <p className="text-[12px] font-bold text-[var(--color-text-secondary)]">{label}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-11 items-center border border-[var(--color-border-default)] bg-white px-4 text-[12px] font-bold text-[var(--color-brand-700)] hover:bg-[var(--color-surface-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-700)] sm:min-h-9"
        >
          再読込
        </button>
      )}
    </div>
  )
}

/** データなし・対象外・算出不能の小さな状態表示。大きな空ブロックは作らない。 */
export function UnavailableNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 border-l-2 border-[var(--color-border-strong)] bg-[var(--color-surface-subtle)] px-2.5 py-1.5 text-[11px] font-medium leading-4 text-[var(--color-text-secondary)]">
      <Info size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

export function Pill({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode
  tone?: 'neutral' | 'brand' | 'notice'
  title?: string
}) {
  const style = tone === 'brand'
    ? 'border-[var(--color-brand-100)] bg-[var(--color-brand-50)] text-[var(--color-brand-900)]'
    : tone === 'notice'
      ? 'border-[var(--color-market-amber)] bg-[var(--color-surface-subtle)] text-[var(--color-text-primary)]'
      : 'border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]'
  return (
    <span title={title} className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px] font-bold leading-4 ${style}`} style={{ borderRadius: 'var(--radius-tag)' }}>
      {children}
    </span>
  )
}

/** 向きは形(矢印)で示し、価格の上昇/下落色は使わない。 */
export function DirectionMark({ direction, size = 13 }: { direction: Direction | null; size?: number }) {
  if (direction == null) return null
  const Icon = direction === 'higher' ? ArrowUpRight : direction === 'lower' ? ArrowDownRight : ArrowRight
  return <Icon size={size} aria-hidden="true" className="shrink-0 text-[var(--color-brand-700)]" />
}

export function ReadingLine({ direction, children }: { direction: Direction | null; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-1.5 text-[12px] font-bold leading-5 text-[var(--color-text-primary)]">
      <span className="mt-[3px]"><DirectionMark direction={direction} /></span>
      <span>{children}</span>
    </li>
  )
}

/* ------------------------------------------------------------------ */
/* Definitions (touch friendly)                                        */
/* ------------------------------------------------------------------ */

/** ホバーに頼らない定義表示。タップ/Enterで開き、外側タップ・Escで閉じる。 */
export function DefinitionTip({ term, children }: { term: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement | null>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
  return (
    <span ref={ref} className="relative inline-flex align-middle">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${term}の定義`}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-6 w-6 items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-brand-700)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-brand-700)] pointer-coarse:h-9 pointer-coarse:w-9"
      >
        <Info size={13} aria-hidden="true" />
      </button>
      {open && (
        <span
          id={id}
          role="note"
          className="absolute left-0 top-full z-30 mt-0.5 block w-64 max-w-[calc(100vw-2.5rem)] border border-[var(--color-border-default)] bg-white p-2.5 text-left text-[11px] font-medium leading-5 text-[var(--color-text-secondary)] shadow-lg"
        >
          <strong className="block text-[12px] font-bold text-[var(--color-text-primary)]">{term}</strong>
          {children}
        </span>
      )}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Compact data visualisation                                          */
/* ------------------------------------------------------------------ */

export interface BarRow {
  key: string
  label: string
  basis?: string
  value: number | null
  text: string
  note?: string | null
  forecast?: boolean
  /** 同じ尺度で比べる行を同じグループにする */
  scale?: string
  /** 定義のタップ表示(DefinitionTip)など、ラベル末尾に置く補助要素 */
  tip?: ReactNode
}

/**
 * 0中心(signed)または0起点(value)の横棒。価格の上昇/下落色は使わず、
 * 正=ブランド色 / 負=濃いグレー、会社予想=斜線で区別する。
 */
export function BarLadder({
  title,
  rows,
  mode,
}: {
  title?: string
  rows: BarRow[]
  mode: 'signed' | 'value'
}) {
  const scaleMax = new Map<string, number>()
  for (const row of rows) {
    if (row.value == null || !Number.isFinite(row.value)) continue
    const group = row.scale ?? 'default'
    const magnitude = mode === 'signed' ? Math.abs(row.value) : Math.max(0, row.value)
    scaleMax.set(group, Math.max(scaleMax.get(group) ?? 0, magnitude))
  }
  return (
    <div className="min-w-0">
      {title && <div className="mb-1 text-[11px] font-bold text-[var(--color-text-secondary)]">{title}</div>}
      <ul className="m-0 list-none divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)] p-0">
        {rows.map((row) => {
          const max = scaleMax.get(row.scale ?? 'default') ?? 0
          const valid = row.value != null && Number.isFinite(row.value) && max > 0
          const ratio = valid ? Math.min(1, Math.abs(row.value as number) / max) : 0
          const negative = valid && (row.value as number) < 0
          const width = valid && (mode === 'signed' || (row.value as number) > 0)
            ? Math.max(2, ratio * (mode === 'signed' ? 50 : 100))
            : 0
          const color = negative ? 'var(--color-text-secondary)' : 'var(--color-brand-700)'
          return (
            <li
              key={row.key}
              className="grid min-h-8 grid-cols-[minmax(76px,96px)_minmax(0,1fr)_minmax(64px,auto)] items-center gap-2 py-1"
              title={row.note ?? undefined}
            >
              <span className="min-w-0 text-[11px] font-semibold leading-4 text-[var(--color-text-secondary)]">
                {row.label}
                {row.basis && <span className="ml-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">{row.basis}</span>}
                {row.tip}
              </span>
              <span className="relative block h-2.5 bg-[var(--color-surface-subtle)]" aria-hidden="true">
                {mode === 'signed' && <span className="absolute inset-y-[-2px] left-1/2 w-px bg-[var(--color-border-strong)]" />}
                {width > 0 && (
                  <span
                    className="absolute inset-y-0"
                    style={{
                      width: `${width}%`,
                      ...(mode === 'signed' ? (negative ? { right: '50%' } : { left: '50%' }) : { left: 0 }),
                      ...(row.forecast
                        ? { background: `repeating-linear-gradient(135deg, ${color} 0 3px, transparent 3px 5px)`, boxShadow: `inset 0 0 0 1px ${color}` }
                        : { background: color }),
                    }}
                  />
                )}
              </span>
              <strong className={`text-right font-mono text-[12px] font-bold leading-4 ${valid ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-tertiary)]'}`}>{row.text}</strong>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** 0〜100%などの上限が決まった比率を1本で示す。 */
export function ShareMeter({
  label,
  value,
  text,
  max = 100,
  boundary,
  boundaryLabel,
}: {
  label: string
  value: number | null
  text: string
  max?: number
  boundary?: number
  boundaryLabel?: string
}) {
  const valid = value != null && Number.isFinite(value)
  const width = valid ? clampPercent((value / max) * 100) : 0
  const boundaryAt = boundary != null ? clampPercent((boundary / max) * 100) : null
  return (
    <div className="grid min-h-9 grid-cols-[minmax(76px,96px)_minmax(0,1fr)_minmax(64px,auto)] items-center gap-2">
      <span className="text-[11px] font-semibold leading-4 text-[var(--color-text-secondary)]">{label}</span>
      <span className="relative block h-2.5 bg-[var(--color-surface-subtle)]" role="img" aria-label={`${label} ${text}${boundaryLabel ? `、${boundaryLabel}に境界線` : ''}`}>
        {width > 0 && <span className="absolute inset-y-0 left-0 bg-[var(--color-brand-700)]" style={{ width: `${width}%` }} />}
        {boundaryAt != null && <span className="absolute inset-y-[-3px] w-px bg-[var(--color-text-secondary)]" style={{ left: `${boundaryAt}%` }} />}
      </span>
      <strong className={`text-right font-mono text-[12px] font-bold leading-4 ${valid ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-tertiary)]'}`}>{text}</strong>
    </div>
  )
}

/**
 * 自社の過去レンジ(5〜95%表示帯)の中の現在位置。中央値を目盛りで示す。
 * 帯の外にあるときは端に寄せて矢印を出す。
 */
export function RangeRuler({
  low,
  high,
  current,
  median,
  lowText,
  highText,
  currentText,
  medianText,
  ariaLabel,
}: {
  low: number | null
  high: number | null
  current: number | null
  median?: number | null
  lowText: string
  highText: string
  currentText: string
  medianText?: string
  ariaLabel: string
}) {
  const currentAt = positionInRange(current, low, high)
  const medianAt = positionInRange(median, low, high)
  return (
    <div className="min-w-0">
      <div className="relative h-8" role="img" aria-label={ariaLabel}>
        <span className="absolute inset-x-0 top-[13px] h-2 bg-[var(--color-surface-muted)]" />
        <span className="absolute inset-x-0 top-[13px] h-2 bg-[var(--color-brand-100)]" />
        {medianAt && (
          <span className="absolute top-[9px] h-4 w-px bg-[var(--color-text-secondary)]" style={{ left: `${medianAt.left}%` }} />
        )}
        {currentAt && (
          <span
            className="absolute top-[5px] h-5 w-[5px] -translate-x-1/2 border border-white bg-[var(--color-brand-900)]"
            style={{ left: `${currentAt.left}%` }}
          />
        )}
        {currentAt?.clipped && (
          <span
            className={`absolute top-0 text-[var(--color-brand-900)] ${currentAt.clipped === 'low' ? 'left-1' : 'right-1'}`}
            aria-hidden="true"
          >
            {currentAt.clipped === 'low' ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </div>
      <div className="flex items-start justify-between gap-2 font-mono text-[11px] font-semibold leading-4 text-[var(--color-text-tertiary)]">
        <span>{lowText}</span>
        {medianText && <span className="text-center text-[var(--color-text-secondary)]">{medianText}</span>}
        <span className="text-right">{highText}</span>
      </div>
      {currentAt?.clipped && (
        <p className="mt-0.5 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
          現在値({currentText})は{currentAt.clipped === 'low' ? '5%点' : '95%点'}の{currentAt.clipped === 'low' ? '下側' : '上側'}にあり、端に寄せて表示しています。
        </p>
      )}
    </div>
  )
}

/** P25〜P75の帯(25%〜75%の位置)に、中央値と対象銘柄を置く。比較は同一指標内だけ。 */
export function PeerBand({
  label,
  p25,
  median,
  p75,
  target,
  targetText,
  medianText,
}: {
  label: string
  p25: number | null
  median: number | null
  p75: number | null
  target: number | null
  targetText: string
  medianText: string
}) {
  const valid = p25 != null && median != null && p75 != null && target != null && p75 > p25
    && [p25, median, p75, target].every(Number.isFinite)
  if (!valid) {
    return <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">帯を描けません</span>
  }
  const place = (value: number) => {
    const raw = 25 + ((value - (p25 as number)) / ((p75 as number) - (p25 as number))) * 50
    if (raw < 2) return { left: 2, clipped: 'low' as const }
    if (raw > 98) return { left: 98, clipped: 'high' as const }
    return { left: raw, clipped: null }
  }
  const medianAt = place(median as number)
  const targetAt = place(target as number)
  const zone = peerZone(target as number, p25 as number, median as number, p75 as number)
  return (
    <div className="min-w-0">
      <div className="relative h-7" role="img" aria-label={`${label} 対象 ${targetText}、中央値 ${medianText}、${PEER_ZONE_LABELS[zone]}`}>
        <span className="absolute inset-x-0 top-1/2 h-px bg-[var(--color-border-default)]" />
        <span className="absolute top-2 h-3 bg-[var(--color-brand-100)]" style={{ left: '25%', width: '50%' }} />
        <span className="absolute top-1.5 h-4 w-px bg-[var(--color-text-secondary)]" style={{ left: `${medianAt.left}%` }} />
        <span className="absolute top-0.5 h-6 w-[5px] -translate-x-1/2 border border-white bg-[var(--color-brand-900)]" style={{ left: `${targetAt.left}%` }} />
        {targetAt.clipped && (
          <span className={`absolute top-1/2 -translate-y-1/2 text-[var(--color-brand-900)] ${targetAt.clipped === 'low' ? 'left-[calc(2%+5px)]' : 'right-[calc(2%+5px)]'}`} aria-hidden="true">
            {targetAt.clipped === 'low' ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-2 text-[11px] font-semibold leading-4 text-[var(--color-text-tertiary)]">
        <span>25%点</span>
        <span className="font-bold text-[var(--color-text-secondary)]">{PEER_ZONE_LABELS[zone]}</span>
        <span>75%点</span>
      </div>
    </div>
  )
}

/** ラベル+値+補足の最小単位。 */
export function Fact({
  label,
  value,
  sub,
  unavailable = false,
  emphasis = false,
  title,
  tip,
}: {
  label: string
  value: string
  sub?: string | null
  unavailable?: boolean
  emphasis?: boolean
  title?: string
  tip?: ReactNode
}) {
  return (
    <div className="min-w-0" title={title}>
      <div className="flex items-center gap-0.5 text-[11px] font-semibold leading-4 text-[var(--color-text-tertiary)]">
        <span className="min-w-0 break-words">{label}</span>
        {tip}
      </div>
      <div
        className={`font-mono leading-tight ${
          unavailable
            ? 'text-[12px] font-semibold text-[var(--color-text-tertiary)]'
            : `${emphasis ? 'text-[20px] font-semibold' : 'text-[15px] font-bold'} text-[var(--color-text-primary)]`
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 break-words text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">{sub}</div>}
    </div>
  )
}

/** セグメント切替(44pxタップ領域はモバイルで確保)。 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-[11px] font-bold text-[var(--color-text-tertiary)]">{label}</span>
      <div className="flex min-w-0 flex-wrap border border-[var(--color-border-default)] bg-white" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={`h-10 shrink-0 border-r border-[var(--color-border-default)] px-3 text-[12px] font-bold last:border-r-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-brand-700)] sm:h-8 sm:px-2.5 sm:text-[11px] ${
              value === option.value ? 'bg-[var(--color-brand-900)] text-white' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 下線タブ風のスイッチ(指標選択)。横スクロールではなく折り返す。 */
export function TabSwitch<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-x-1 border-b border-[var(--color-border-soft)] px-3 sm:px-5" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={`min-h-11 border-b-2 px-3 text-[12px] font-bold focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-brand-700)] sm:min-h-10 ${
            value === option.value
              ? 'border-[var(--color-brand-700)] text-[var(--color-brand-900)]'
              : 'border-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
