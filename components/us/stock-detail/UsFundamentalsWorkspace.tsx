'use client'

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  BadgeCheck,
  Banknote,
  CalendarClock,
  ChevronRight,
  CircleOff,
  Database,
  FileText,
  HandCoins,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Percent,
  Scale,
  ShieldCheck,
  TrendingUp,
  WalletCards,
  type LucideIcon,
} from 'lucide-react'
import { Notice } from '@/components/ui/EmptyState'
import {
  DefinitionTip,
  ErrorBlock,
  LoadingBlock,
  PanelSection,
  TabSwitch,
} from '@/components/stock/fundamentals/primitives'
import type {
  UsDividendYear,
  UsFundamentalValue,
  UsFundamentalsModel,
  UsPerformancePeriod,
} from '@/lib/us-fundamentals'

/* ------------------------------------------------------------------ */
/* Views / data                                                        */
/* ------------------------------------------------------------------ */

export type UsFundamentalView = 'summary' | 'performance' | 'financial' | 'valuation' | 'returns'

export const US_FUNDAMENTAL_VIEWS: Array<{ id: UsFundamentalView; label: string; icon: LucideIcon }> = [
  { id: 'summary', label: 'サマリー', icon: LayoutDashboard },
  { id: 'performance', label: '業績', icon: TrendingUp },
  { id: 'financial', label: '財務', icon: Landmark },
  { id: 'valuation', label: 'バリュエーション', icon: Scale },
  { id: 'returns', label: '株主還元', icon: WalletCards },
]

const VIEW_LABEL: Record<UsFundamentalView, string> = Object.fromEntries(
  US_FUNDAMENTAL_VIEWS.map((view) => [view.id, view.label]),
) as Record<UsFundamentalView, string>

/** 同一オリジンの契約APIだけを読む。過去分析モードでは as_of を付ける。 */
export function usFundamentalsUrl(ticker: string, analysisDate: string | null): string {
  return `/api/us/fundamentals/${encodeURIComponent(ticker)}${analysisDate ? `?as_of=${encodeURIComponent(analysisDate)}` : ''}`
}

const inFlight = new Map<string, Promise<UsFundamentalsModel>>()

/** 読み込み中のリクエストだけを共有する(StrictMode の二重実行でも1回)。完了後は保持しない。 */
function loadUsFundamentals(url: string): Promise<UsFundamentalsModel> {
  const existing = inFlight.get(url)
  if (existing) return existing

  const request = fetch(url, { cache: 'no-store' })
    .then((response) => response.ok ? response.json() as Promise<UsFundamentalsModel> : Promise.reject(new Error(`HTTP ${response.status}`)))
    .then((model) => model?.contractVersion === 'us-fundamentals-v1' ? model : Promise.reject(new Error('unexpected contract')))
    .finally(() => {
      if (inFlight.get(url) === request) inFlight.delete(url)
    })
  inFlight.set(url, request)
  return request
}

type Remote = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: UsFundamentalsModel }

/* ------------------------------------------------------------------ */
/* Display vocabulary (表示だけ。値の再計算はしない)                     */
/* ------------------------------------------------------------------ */

type ValueState = 'value' | 'missing' | 'not_meaningful' | 'not_applicable'
type Display = { text: string; state: ValueState; reason: string | null }

const STATE_TEXT: Record<Exclude<ValueState, 'value'>, string> = {
  missing: 'データなし',
  not_meaningful: 'N/M',
  not_applicable: '対象外',
}

function usdCompact(value: number): string {
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`
  return `${sign}$${abs.toFixed(0)}`
}

function perShare(value: number): string {
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`
}

function numberText(value: number, unit: UsFundamentalValue['unit'], signed: boolean): string {
  switch (unit) {
    case 'USD':
      return usdCompact(value)
    case 'USD_PER_SHARE':
      return perShare(value)
    case 'PERCENT': {
      const rounded = Number(value.toFixed(1))
      return `${signed && rounded > 0 ? '+' : ''}${(rounded === 0 ? 0 : rounded).toFixed(1)}%`
    }
    case 'MULTIPLE':
      return `${value.toFixed(1)}倍`
    case 'COUNT':
      return `${value.toFixed(0)}回`
    case 'SHARES':
      return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
  }
}

function display(value: UsFundamentalValue | null | undefined, signed = false): Display {
  if (!value) return { text: STATE_TEXT.missing, state: 'missing', reason: null }
  if (value.availability !== 'available' || value.value == null || !Number.isFinite(value.value)) {
    const state = value.availability === 'available' ? 'missing' : value.availability
    return { text: STATE_TEXT[state], state, reason: value.reason }
  }
  return { text: numberText(value.value, value.unit, signed), state: 'value', reason: null }
}

function numeric(value: UsFundamentalValue | null | undefined): number | null {
  return value?.availability === 'available' && value.value != null && Number.isFinite(value.value) ? value.value : null
}

/** 表示上の符号。百分率は表示精度(小数1桁)で 0 になるなら 0 とみなす。 */
function displayedSign(value: UsFundamentalValue | null | undefined): -1 | 0 | 1 | null {
  const raw = numeric(value)
  if (raw == null || !value) return null
  const shown = value.unit === 'PERCENT' ? Number(raw.toFixed(1)) : raw
  return shown > 0 ? 1 : shown < 0 ? -1 : 0
}

function dateOnly(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null
}

/* ------------------------------------------------------------------ */
/* Small primitives                                                    */
/* ------------------------------------------------------------------ */

/** N/M・データなし・対象外は数値と別の形で出す。0 は数値として出る。 */
function StateTag({ state }: { state: Exclude<ValueState, 'value'> }) {
  const style = state === 'not_meaningful'
    ? 'border-solid border-[var(--color-border-strong)] bg-white text-[var(--color-text-secondary)]'
    : state === 'not_applicable'
      ? 'border-dotted border-[var(--color-border-strong)] bg-white text-[var(--color-text-tertiary)]'
      : 'border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[var(--color-text-tertiary)]'
  return (
    <span className={`inline-flex shrink-0 items-center whitespace-nowrap border px-1.5 py-px text-[11px] font-bold leading-4 ${style}`} style={{ borderRadius: 'var(--radius-tag)' }}>
      {STATE_TEXT[state]}
    </span>
  )
}

function ValueText({ value, size = 'md' }: { value: Display; size?: 'lg' | 'md' | 'sm' }) {
  if (value.state !== 'value') return <StateTag state={value.state} />
  const sizeClass = size === 'lg' ? 'text-[20px] leading-6' : size === 'md' ? 'text-[15px] leading-5' : 'text-[12px] leading-4'
  return <span className={`whitespace-nowrap font-mono font-bold tabular-nums text-[var(--color-text-primary)] ${sizeClass}`}>{value.text}</span>
}

/** 罫線で区切るだけの指標グリッド。カードを入れ子にしない。 */
function MetricGrid({ children, columns }: { children: ReactNode; columns: string }) {
  return (
    <div className="min-w-0 overflow-hidden">
      <div className={`-mb-px -mr-px grid min-w-0 grid-cols-2 ${columns}`}>{children}</div>
    </div>
  )
}

const CELL = 'flex min-w-0 flex-col gap-1 border-b border-r border-[var(--color-border-soft)] bg-white px-3 py-2.5 sm:px-4'

function MetricCell({
  label,
  basis,
  value,
  signed = false,
  note,
  tip,
}: {
  label: string
  basis: string
  value: UsFundamentalValue
  signed?: boolean
  note?: string | null
  tip?: ReactNode
}) {
  const shown = display(value, signed)
  return (
    <div className={CELL}>
      <div className="flex min-w-0 items-center gap-0.5 text-[11px] font-bold leading-4 text-[var(--color-text-secondary)]">
        <span className="min-w-0 break-words">{label}</span>
        {tip}
      </div>
      <div className="flex min-h-6 items-center"><ValueText value={shown} size="lg" /></div>
      <div className="break-words text-[11px] leading-4 text-[var(--color-text-tertiary)]">
        {basis}
        {value.periodEnd && <span className="font-mono"> · {value.periodEnd}</span>}
      </div>
      {shown.reason && <div className="break-words text-[11px] font-medium leading-4 text-[var(--color-text-secondary)]">{shown.reason}</div>}
      {note && <div className="break-words text-[11px] font-medium leading-4 text-[var(--color-text-secondary)]">{note}</div>}
    </div>
  )
}

interface BarItem {
  key: string
  label: string
  sub?: string | null
  value: UsFundamentalValue
  tip?: ReactNode
}

/** 同じ尺度の横棒。signed は0中心、value は0起点。正=ブランド色 / 負=グレー(価格の上昇下落色は使わない)。 */
function BarRows({ items, mode, label }: { items: BarItem[]; mode: 'signed' | 'value'; label: string }) {
  const max = Math.max(0, ...items.map((item) => Math.abs(numeric(item.value) ?? 0)))
  return (
    <ul className="m-0 list-none divide-y divide-[var(--color-border-soft)] p-0" aria-label={label}>
      {items.map((item) => {
        const raw = numeric(item.value)
        const shown = display(item.value)
        const negative = raw != null && raw < 0
        const ratio = raw != null && max > 0 ? Math.abs(raw) / max : 0
        const width = raw == null || max === 0 || (mode === 'value' && raw <= 0) ? 0 : Math.max(1.5, ratio * (mode === 'signed' ? 50 : 100))
        const color = negative ? 'var(--color-text-secondary)' : 'var(--color-brand-700)'
        return (
          <li key={item.key} className="grid min-h-11 grid-cols-[minmax(84px,128px)_minmax(0,1fr)_minmax(68px,auto)] items-center gap-2 py-1.5 sm:gap-3">
            <span className="min-w-0">
              <span className="flex items-center gap-0.5 text-[12px] font-bold leading-4 text-[var(--color-text-primary)]">
                <span className="min-w-0 break-words">{item.label}</span>
                {item.tip}
              </span>
              {item.sub && <span className="block break-words text-[11px] leading-4 text-[var(--color-text-tertiary)]">{item.sub}</span>}
              {shown.reason && <span className="block break-words text-[11px] font-medium leading-4 text-[var(--color-text-secondary)]">{shown.reason}</span>}
            </span>
            <span className="relative block h-2.5 min-w-0 bg-[var(--color-surface-subtle)]" aria-hidden="true">
              {mode === 'signed' && <span className="absolute inset-y-[-3px] left-1/2 w-px bg-[var(--color-border-strong)]" />}
              {width > 0 && (
                <span
                  className="absolute inset-y-0"
                  style={{ width: `${width}%`, background: color, ...(mode === 'signed' ? (negative ? { right: '50%' } : { left: '50%' }) : { left: 0 }) }}
                />
              )}
            </span>
            <span className="flex justify-end"><ValueText value={shown} size="sm" /></span>
          </li>
        )
      })}
    </ul>
  )
}

interface ColumnPoint {
  key: string
  label: string
  sub?: string | null
  value: number | null
  shown: Display
  partial?: boolean
}

/** 時系列の縦棒。0線を基準に正負を描き、欠損は破線枠で数値と分ける。 */
function ColumnChart({
  points,
  label,
  secondary,
}: {
  points: ColumnPoint[]
  label: string
  secondary?: { label: string; cells: Display[] }
}) {
  const values = points.map((point) => point.value).filter((value): value is number => value != null && Number.isFinite(value))
  const maxPositive = Math.max(0, ...values)
  const maxNegative = Math.max(0, ...values.map((value) => -value))
  const span = maxPositive + maxNegative
  const zeroAt = span > 0 ? (maxPositive / span) * 100 : 100
  const template = { gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }
  // 7本以上は狭い画面で値ラベルが重なるため、sm 未満では棒だけにする(値は併記の表で読む)
  const crowded = points.length > 6
  const ariaSummary = points.map((point) => `${point.label} ${point.shown.text}${point.partial ? '(途中)' : ''}`).join('、')
  return (
    <figure className="m-0 min-w-0">
      <div role="img" aria-label={`${label}: ${ariaSummary}`} className="grid gap-x-1 sm:gap-x-3" style={template}>
        {points.map((point) => {
          const valid = point.value != null && Number.isFinite(point.value) && span > 0
          const height = valid ? Math.max(1.5, (Math.abs(point.value as number) / span) * 100) : 0
          const negative = valid && (point.value as number) < 0
          const fill = negative ? 'var(--color-text-secondary)' : point.partial ? 'var(--color-brand-300)' : 'var(--color-brand-700)'
          return (
            <div key={point.key} className="flex min-w-0 flex-col">
              <div className={`h-4 overflow-hidden text-ellipsis whitespace-nowrap text-center font-mono text-[11px] font-bold leading-4 text-[var(--color-text-primary)] ${crowded ? 'invisible sm:visible' : ''}`} title={point.shown.text}>
                {point.shown.state === 'value' ? point.shown.text : ''}
              </div>
              <div className="relative mt-1 h-28">
                <span className="absolute inset-x-0 h-px bg-[var(--color-border-strong)]" style={{ top: `${zeroAt}%` }} />
                {valid && (
                  <span
                    className="absolute inset-x-[16%]"
                    style={{ top: `${negative ? zeroAt : zeroAt - height}%`, height: `${height}%`, background: fill }}
                  />
                )}
                {point.shown.state !== 'value' && (
                  <span className="absolute inset-x-0 inset-y-2 grid place-items-center border border-dashed border-[var(--color-border-default)] px-0.5 text-center">
                    <StateTag state={point.shown.state} />
                  </span>
                )}
              </div>
              <div className="mt-1 truncate text-center font-mono text-[11px] font-bold leading-4 text-[var(--color-text-secondary)]">{point.label}</div>
              {point.sub && <div className={`truncate text-center text-[11px] leading-4 text-[var(--color-text-tertiary)] ${crowded ? 'hidden sm:block' : ''}`}>{point.sub}</div>}
            </div>
          )
        })}
      </div>
      {secondary && (
        <div className="mt-2 border-t border-[var(--color-border-soft)] pt-1.5">
          <div className="text-[11px] font-bold leading-4 text-[var(--color-text-secondary)]">{secondary.label}</div>
          <div className="mt-0.5 grid gap-x-1 sm:gap-x-3" style={template}>
            {secondary.cells.map((cell, index) => (
              <div key={points[index]?.key ?? index} className="flex min-w-0 justify-center overflow-hidden" title={cell.reason ?? undefined}>
                <ValueText value={cell} size="sm" />
              </div>
            ))}
          </div>
        </div>
      )}
    </figure>
  )
}

/* ------------------------------------------------------------------ */
/* Workspace                                                           */
/* ------------------------------------------------------------------ */

export function UsFundamentalsWorkspace({
  ticker,
  analysisDate,
  view,
  onViewChange,
}: {
  ticker: string
  analysisDate: string | null
  view: UsFundamentalView
  onViewChange: (view: UsFundamentalView) => void
}) {
  const url = usFundamentalsUrl(ticker, analysisDate)
  const [attempt, setAttempt] = useState(0)
  const [remote, setRemote] = useState<Remote>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setRemote({ status: 'loading' })
    loadUsFundamentals(url)
      .then((data) => {
        if (!cancelled) setRemote({ status: 'ready', data })
      })
      .catch(() => {
        if (!cancelled) setRemote({ status: 'error' })
      })
    return () => { cancelled = true }
  }, [url, attempt])

  const model = remote.status === 'ready' ? remote.data : null
  const panelId = `us-fundamental-panel-${view}`

  return (
    <section className="flex min-w-0 flex-col gap-4 pb-2" aria-labelledby="us-fundamental-workspace-title">
      <div className="flex min-w-0 flex-col gap-3">
        <header className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <h2 id="us-fundamental-workspace-title" className="text-[17px] font-bold text-[var(--color-text-primary)]">ファンダメンタル</h2>
            <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">SEC開示の実績と基準日終値だけで、成長・収益性・財務・株価水準・還元を確認します。</p>
          </div>
          <span className="font-mono text-[12px] tabular-nums text-[var(--color-text-tertiary)]">基準日 {model?.asOf ?? analysisDate ?? '最新'}</span>
        </header>
        <FundamentalViewTabs active={view} onSelect={onViewChange} />
      </div>

      {remote.status === 'loading' && <LoadingBlock label={`${ticker} のファンダメンタルを読み込んでいます…`} />}
      {remote.status === 'error' && (
        <ErrorBlock label="米国株ファンダメンタルを取得できませんでした。" onRetry={() => setAttempt((value) => value + 1)} />
      )}
      {model && (
        <>
          <CoverageStrip model={model} />
          <div id={panelId} role="tabpanel" aria-labelledby={`us-fundamental-tab-${view}`} className="flex min-w-0 flex-col gap-4">
            {view === 'summary' && <SummaryView model={model} onViewChange={onViewChange} />}
            {view === 'performance' && <PerformanceView model={model} />}
            {view === 'financial' && <FinancialView model={model} />}
            {view === 'valuation' && <ValuationView model={model} />}
            {view === 'returns' && <ReturnsView model={model} />}
          </div>
        </>
      )}
    </section>
  )
}

function FundamentalViewTabs({ active, onSelect }: { active: UsFundamentalView; onSelect: (view: UsFundamentalView) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  useEffect(() => {
    refs.current[active]?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' })
  }, [active])

  // WAI-ARIA tabs: 左右・Home・End で移動し、そのまま選択する
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = US_FUNDAMENTAL_VIEWS.findIndex((view) => view.id === active)
    const last = US_FUNDAMENTAL_VIEWS.length - 1
    const next = event.key === 'ArrowRight' ? (index + 1) % (last + 1)
      : event.key === 'ArrowLeft' ? (index - 1 + last + 1) % (last + 1)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? last
            : null
    if (next == null) return
    event.preventDefault()
    const target = US_FUNDAMENTAL_VIEWS[next].id
    onSelect(target)
    refs.current[target]?.focus()
  }

  return (
    <nav className="view-tabs self-start" aria-label="ファンダメンタル分析" role="tablist">
      {US_FUNDAMENTAL_VIEWS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          ref={(node) => { refs.current[id] = node }}
          id={`us-fundamental-tab-${id}`}
          type="button"
          onClick={() => onSelect(id)}
          onKeyDown={onKeyDown}
          className="view-tab h-11 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-brand-700)] sm:h-9"
          role="tab"
          aria-selected={active === id}
          aria-controls={active === id ? `us-fundamental-panel-${id}` : undefined}
          tabIndex={active === id ? 0 : -1}
          data-active={active === id}
        >
          <Icon size={14} aria-hidden="true" />
          {label}
        </button>
      ))}
    </nav>
  )
}

/* ------------------------------------------------------------------ */
/* Coverage / source                                                   */
/* ------------------------------------------------------------------ */

const COVERAGE_LABEL: Record<UsFundamentalsModel['coverage']['status'], { text: string; tone: 'brand' | 'warning' }> = {
  READY: { text: '全区分取得済み', tone: 'brand' },
  PARTIAL: { text: '一部区分に欠損', tone: 'warning' },
  UNAVAILABLE: { text: '財務fact未取得', tone: 'warning' },
}

type SectionCoverage = UsFundamentalsModel['coverage']['sections'][keyof UsFundamentalsModel['coverage']['sections']]

const SECTION_COVERAGE_ROWS: Array<{ key: keyof UsFundamentalsModel['coverage']['sections']; label: string }> = [
  { key: 'performance', label: '業績' },
  { key: 'financialPosition', label: '財政状態' },
  { key: 'cashFlow', label: 'キャッシュフロー' },
  { key: 'capital', label: '株式・資本' },
  { key: 'shareholderReturn', label: '株主還元' },
]

const SECTION_STATUS_TEXT: Record<SectionCoverage['status'], string> = {
  READY: '取得済み',
  PARTIAL: '一部欠損',
  UNAVAILABLE: '未取得',
}

const MISSING_METRIC_LABEL: Record<string, string> = {
  revenue: '売上高',
  operating_profit: '営業利益',
  net_income: '純利益',
  eps: 'EPS',
  assets: '総資産',
  liabilities: '負債合計',
  equity: '純資産',
  cash: '現金同等物',
  current_assets: '流動資産',
  current_liabilities: '流動負債',
  current_debt: '短期有利子負債',
  noncurrent_debt: '長期有利子負債',
  operating_cash_flow: '営業CF',
  investing_cash_flow: '投資CF',
  financing_cash_flow: '財務CF',
  capital_expenditure: '設備投資',
  shares_outstanding: '発行済株式数',
  weighted_average_shares: '加重平均株式数',
  diluted_eps: '希薄化EPS',
  cash_dividends_paid: '現金配当支払',
  share_repurchases: '自社株買い',
}

/** 区分別の取得状況。全体READYと混同しないよう、色で良否を示さず罫線の形だけで分ける。 */
function SectionStatusTag({ status }: { status: SectionCoverage['status'] }) {
  const style = status === 'READY'
    ? 'border-solid border-[var(--color-border-strong)] text-[var(--color-text-secondary)]'
    : status === 'PARTIAL'
      ? 'border-dashed border-[var(--color-border-strong)] text-[var(--color-text-secondary)]'
      : 'border-dotted border-[var(--color-border-strong)] text-[var(--color-text-tertiary)]'
  return (
    <span className={`inline-flex shrink-0 items-center whitespace-nowrap border bg-white px-1.5 py-px text-[11px] font-bold leading-4 ${style}`} style={{ borderRadius: 'var(--radius-tag)' }}>
      {SECTION_STATUS_TEXT[status]}
    </span>
  )
}

function CoverageStrip({ model }: { model: UsFundamentalsModel }) {
  const coverage = COVERAGE_LABEL[model.coverage.status]
  const latestPublished = dateOnly(model.coverage.latestPublishedAt)
  const items: Array<{ key: string; icon: LucideIcon; label: string; value: ReactNode; sub: string | null }> = [
    {
      key: 'sec',
      icon: FileText,
      label: 'SEC Companyfacts',
      value: `${model.coverage.sourceFacts.toLocaleString('en-US')} facts`,
      sub: latestPublished ? `最新開示 ${latestPublished}` : '基準日までの開示なし',
    },
    {
      key: 'eod',
      icon: Database,
      label: 'Tiingo EOD',
      value: model.price != null && Number.isFinite(model.price) ? perShare(model.price) : <StateTag state="missing" />,
      sub: model.priceDate ? `終値 ${model.priceDate}` : '基準日終値なし',
    },
    { key: 'as-of', icon: CalendarClock, label: '基準日', value: model.asOf, sub: '開示日・価格日がこの日以前の値のみ' },
    { key: 'forecast', icon: CircleOff, label: '会社予想', value: '未提供', sub: model.coverage.forecastReason },
    { key: 'peer', icon: CircleOff, label: '同業比較', value: '未提供', sub: model.valuation.peerReason },
  ]
  return (
    <section className="min-w-0 border-y border-[var(--color-border-soft)] bg-white" aria-label="データ範囲と出典">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--color-border-soft)] px-3 py-2 sm:px-4">
        <span className="status-tag" data-tone={coverage.tone}>{coverage.text}</span>
        <span className="text-[11px] font-bold text-[var(--color-text-secondary)]">{model.source}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
          <StateTag state="not_meaningful" /> 算出不能(赤字・負の分母)
          <StateTag state="missing" /> 必要な入力なし
          <span className="font-mono font-bold text-[var(--color-text-secondary)]">0</span> 観測値
        </span>
      </div>
      <MetricGrid columns="md:grid-cols-3 xl:grid-cols-5">
        {items.map(({ key, icon: Icon, label, value, sub }) => (
          <div key={key} className={`${CELL} py-2`}>
            <div className="flex items-center gap-1 text-[11px] font-bold leading-4 text-[var(--color-text-secondary)]">
              <Icon size={12} aria-hidden="true" className="shrink-0 text-[var(--color-brand-700)]" />
              <span className="min-w-0 break-words">{label}</span>
            </div>
            <div className="font-mono text-[13px] font-bold leading-5 text-[var(--color-text-primary)]">{value}</div>
            {sub && <div className="break-words text-[11px] leading-4 text-[var(--color-text-tertiary)]">{sub}</div>}
          </div>
        ))}
      </MetricGrid>
      {model.coverage.sections && (
        <div className="border-t border-[var(--color-border-soft)]">
          <h3 className="px-3 pt-2 text-[11px] font-bold leading-4 text-[var(--color-text-secondary)] sm:px-4">区分別の取得状況</h3>
          <MetricGrid columns="md:grid-cols-3 xl:grid-cols-5">
            {SECTION_COVERAGE_ROWS.map(({ key, label }) => {
              const section = model.coverage.sections[key]
              const missingLabels = section.missingMetrics.map((metric) => MISSING_METRIC_LABEL[metric] ?? metric)
              return (
                <div key={key} className={`${CELL} py-2`}>
                  <div className="min-w-0 break-words text-[11px] font-bold leading-4 text-[var(--color-text-secondary)]">{label}</div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                    <SectionStatusTag status={section.status} />
                    <span className="font-mono text-[12px] font-bold tabular-nums leading-4 text-[var(--color-text-primary)]">{section.available}/{section.expected}</span>
                  </div>
                  <div className="break-words text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                    {missingLabels.length > 0 ? `欠損 ${missingLabels.length}: ${missingLabels.join('、')}` : '欠損なし'}
                  </div>
                </div>
              )
            })}
          </MetricGrid>
        </div>
      )}
      {model.coverage.sourceFacts === 0 ? (
        <Notice tone="warning" className="m-3 sm:mx-4">
          基準日時点で使える SEC Companyfacts の財務factがありません。業績・財務・倍率は「データなし」とし、Tiingo EOD の株価・配当由来の値だけを表示します。
        </Notice>
      ) : model.coverage.status === 'PARTIAL' ? (
        <Notice tone="info" className="m-3 sm:mx-4">
          一部の区分でSEC factが未取得です。区分別の取得状況で欠損項目を確認してください。依存する指標は「データなし」になります。
        </Notice>
      ) : null}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

interface Axis {
  id: string
  label: string
  icon: LucideIcon
  basis: string
  value: UsFundamentalValue
  signed?: boolean
  view: UsFundamentalView
}

/** 観測値の符号をそのまま言葉にしたもの。良し悪し・強弱は付けない。 */
interface ObservedFact {
  key: string
  label: string
  value: Display
  fact: string
}

interface CheckItem {
  key: string
  label: string
  reason: string | null
}

type SignWords = { positive: string; zero: string; negative: string }

function buildSummaryFacts(model: UsFundamentalsModel): {
  observed: ObservedFact[]
  notMeaningful: CheckItem[]
  missing: CheckItem[]
  notApplicable: CheckItem[]
} {
  const { summary, financials, valuation, shareholderReturn } = model
  const cf: SignWords = { positive: 'プラス', zero: 'ゼロ', negative: 'マイナス' }
  const rows: Array<{ key: string; label: string; value: UsFundamentalValue; signed?: boolean; words: SignWords }> = [
    { key: 'growth', label: '売上高 LTM前年比', value: summary.revenueGrowth, signed: true, words: { positive: '増収', zero: '横ばい', negative: '減収' } },
    { key: 'margin', label: '営業利益率 LTM', value: summary.operatingMargin, words: { positive: '営業黒字', zero: '営業損益ゼロ', negative: '営業赤字' } },
    { key: 'roe', label: 'ROE LTM', value: summary.roe, words: { positive: '純利益', zero: '純損益ゼロ', negative: '純損失' } },
    { key: 'equity', label: '自己資本比率', value: summary.equityRatio, words: { positive: '純資産プラス', zero: '純資産ゼロ', negative: '純資産マイナス' } },
    { key: 'ocf', label: '営業CF', value: financials.operatingCashFlow, words: cf },
    { key: 'fcf', label: 'FCF', value: financials.freeCashFlow, words: cf },
    { key: 'dps', label: '1株配当 直近1年', value: shareholderReturn.trailingDividendPerShare, words: { positive: '支払い記録あり', zero: '支払い記録なし', negative: 'マイナス' } },
    { key: 'buyback', label: '自社株買い', value: shareholderReturn.shareRepurchases, words: { positive: '実施額あり', zero: '実施額0', negative: 'マイナス' } },
  ]
  const observed: ObservedFact[] = []
  for (const row of rows) {
    const sign = displayedSign(row.value)
    if (sign == null) continue
    const fact = sign === 1 ? row.words.positive : sign === -1 ? row.words.negative : row.words.zero
    observed.push({ key: row.key, label: row.label, value: display(row.value, row.signed), fact })
  }

  const tracked: Array<[string, UsFundamentalValue]> = [
    ['売上成長率', summary.revenueGrowth],
    ['営業利益率', summary.operatingMargin],
    ['ROE', summary.roe],
    ['自己資本比率', summary.equityRatio],
    ['実績PER', valuation.trailingPer],
    ['PBR', valuation.pbr],
    ['PSR', valuation.psr],
    ['時価総額', valuation.marketCap],
    ['総資産', financials.totalAssets],
    ['営業CF', financials.operatingCashFlow],
    ['FCF', financials.freeCashFlow],
    ['1株配当', shareholderReturn.trailingDividendPerShare],
    ['配当性向', shareholderReturn.payoutRatio],
    ['自社株買い', shareholderReturn.shareRepurchases],
  ]
  const byState = (state: UsFundamentalValue['availability']) => tracked
    .filter(([, value]) => value.availability === state)
    .map(([label, value]) => ({ key: `${state}-${label}`, label, reason: value.reason }))
  return {
    observed,
    notMeaningful: byState('not_meaningful'),
    missing: byState('missing'),
    notApplicable: byState('not_applicable'),
  }
}

function SummaryView({ model, onViewChange }: { model: UsFundamentalsModel; onViewChange: (view: UsFundamentalView) => void }) {
  const { summary } = model
  const axes: Axis[] = [
    { id: 'growth', label: '成長', icon: TrendingUp, basis: '売上高 LTM 前年比', value: summary.revenueGrowth, signed: true, view: 'performance' },
    { id: 'profitability', label: '収益性', icon: BadgeCheck, basis: '営業利益率 LTM', value: summary.operatingMargin, view: 'performance' },
    { id: 'efficiency', label: '資本効率', icon: Percent, basis: 'ROE LTM純利益/期首・期末平均純資産', value: summary.roe, view: 'financial' },
    { id: 'safety', label: '財務安全性', icon: ShieldCheck, basis: '自己資本比率 直近期末', value: summary.equityRatio, view: 'financial' },
    { id: 'valuation', label: '株価水準', icon: Scale, basis: '実績PER LTM EPS', value: summary.trailingPer, view: 'valuation' },
    { id: 'returns', label: '株主還元', icon: WalletCards, basis: '配当利回り 直近1年', value: summary.trailingDividendYield, view: 'returns' },
  ]
  const facts = buildSummaryFacts(model)
  const checkCount = facts.notMeaningful.length + facts.missing.length + facts.notApplicable.length
  const periods = model.performance.periods

  return (
    <>
      <section className="min-w-0 border-y border-[var(--color-border-soft)] bg-white" aria-labelledby="us-fundamental-axes">
        <h3 id="us-fundamental-axes" className="sr-only">6つの分析軸</h3>
        <MetricGrid columns="md:grid-cols-3 xl:grid-cols-6">
          {axes.map((axis) => {
            const shown = display(axis.value, axis.signed)
            const Icon = axis.icon
            return (
              <button
                key={axis.id}
                type="button"
                onClick={() => onViewChange(axis.view)}
                className={`${CELL} items-start py-3 text-left hover:bg-[var(--color-surface-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-brand-700)]`}
              >
                <span className="flex items-center gap-1.5 text-[12px] font-bold leading-4 text-[var(--color-text-primary)]">
                  <Icon size={14} aria-hidden="true" className="shrink-0 text-[var(--color-brand-700)]" />
                  {axis.label}
                </span>
                <span className="flex min-h-7 items-center"><ValueText value={shown} size="lg" /></span>
                <span className="break-words text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                  {axis.basis}
                  {axis.value.periodEnd && <span className="font-mono"> · {axis.value.periodEnd}</span>}
                </span>
                {shown.reason && <span className="break-words text-[11px] font-medium leading-4 text-[var(--color-text-secondary)]">{shown.reason}</span>}
                <span className="mt-auto inline-flex items-center gap-0.5 pt-1 text-[11px] font-bold text-[var(--color-brand-700)]">
                  {VIEW_LABEL[axis.view]}
                  <ChevronRight size={12} aria-hidden="true" />
                </span>
              </button>
            )
          })}
        </MetricGrid>
      </section>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <PanelSection
          icon={ListChecks}
          id="us-fundamental-findings"
          title="開示値から読める事実"
          lead="観測値の符号と算出可否だけを記載。水準の良し悪しは判定しません。"
        >
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <FactGroup title="観測事実" icon={FileText} count={facts.observed.length}>
              {facts.observed.length > 0 ? (
                <ul className="m-0 flex list-none flex-col p-0">
                  {facts.observed.map((item) => (
                    <li key={item.key} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-[var(--color-border-soft)] py-1 last:border-b-0">
                      <span className="min-w-0 flex-1 break-words text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">{item.label}</span>
                      <ValueText value={item.value} size="sm" />
                      <span className="status-tag">{item.fact}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11px] text-[var(--color-text-tertiary)]">符号を確認できる開示値なし</p>
              )}
            </FactGroup>
            <FactGroup title="確認事項" icon={CircleOff} count={checkCount}>
              {checkCount > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[11px] leading-4">
                  {facts.notMeaningful.map((item) => (
                    <li key={item.key} className="min-w-0">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <StateTag state="not_meaningful" />
                        <span className="min-w-0 break-words text-[12px] font-bold text-[var(--color-text-primary)]">{item.label}</span>
                      </span>
                      {item.reason && <span className="mt-0.5 block break-words text-[var(--color-text-secondary)]">{item.reason}</span>}
                    </li>
                  ))}
                  {([['missing', facts.missing], ['not_applicable', facts.notApplicable]] as const).map(([state, items]) => items.length > 0 && (
                    <li key={state} className="flex min-w-0 flex-wrap items-center gap-1.5 text-[var(--color-text-secondary)]">
                      <StateTag state={state} />
                      <span className="min-w-0 break-words">{items.map((item) => item.label).join('、')}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11px] text-[var(--color-text-tertiary)]">N/M・データなしの指標なし</p>
              )}
            </FactGroup>
          </div>
        </PanelSection>

        <PanelSection
          icon={TrendingUp}
          id="us-fundamental-trend"
          title="売上高の推移"
          lead="SEC 10-K の実績FYのみ。会社予想は表示しません。"
          aside={<span className="status-tag">実績</span>}
        >
          {periods.length > 0 ? (
            <ColumnChart
              label="売上高 実績FY"
              points={periods.map((period) => ({
                key: String(period.fiscalYear),
                label: `FY${period.fiscalYear}`,
                value: numeric(period.revenue),
                shown: display(period.revenue),
              }))}
              secondary={{ label: '営業利益率', cells: periods.map((period) => display(period.operatingMargin)) }}
            />
          ) : (
            <EmptyLine>基準日までに SEC Companyfacts のFY売上高実績がありません。</EmptyLine>
          )}
        </PanelSection>
      </div>
    </>
  )
}

function FactGroup({ title, icon: Icon, count, children }: { title: string; icon: LucideIcon; count: number; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <h4 className="flex items-center gap-1 border-b border-[var(--color-border-soft)] pb-1 text-[12px] font-bold text-[var(--color-text-primary)]">
        <Icon size={13} aria-hidden="true" className="shrink-0 text-[var(--color-brand-700)]" />
        {title}
        <span className="ml-auto font-mono text-[11px] text-[var(--color-text-tertiary)]">{count}</span>
      </h4>
      <div className="mt-1.5 min-w-0">{children}</div>
    </div>
  )
}

/** 空状態の1行。marker は既定で「データなし」。観測された0は数値の marker を渡す。 */
function EmptyLine({ children, marker = <StateTag state="missing" /> }: { children: ReactNode; marker?: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 border-l-2 border-[var(--color-border-strong)] bg-[var(--color-surface-subtle)] px-2.5 py-1.5 text-[11px] font-medium leading-4 text-[var(--color-text-secondary)]">
      {marker}
      <span className="min-w-0 break-words">{children}</span>
    </p>
  )
}

/* ------------------------------------------------------------------ */
/* Performance                                                         */
/* ------------------------------------------------------------------ */

type PerformanceMetric = 'revenue' | 'operatingProfit' | 'netIncome' | 'eps' | 'operatingMargin' | 'revenueGrowth'

const PERFORMANCE_ROWS: Array<{ key: PerformanceMetric; label: string; signed?: boolean }> = [
  { key: 'revenue', label: '売上高' },
  { key: 'revenueGrowth', label: '売上成長率', signed: true },
  { key: 'operatingProfit', label: '営業利益' },
  { key: 'operatingMargin', label: '営業利益率' },
  { key: 'netIncome', label: '純利益' },
  { key: 'eps', label: 'EPS(基本)' },
]

function PerformanceView({ model }: { model: UsFundamentalsModel }) {
  const [metric, setMetric] = useState<PerformanceMetric>('revenue')
  const periods = model.performance.periods
  const selected = PERFORMANCE_ROWS.find((row) => row.key === metric) ?? PERFORMANCE_ROWS[0]

  return (
    <>
      <PanelSection
        icon={TrendingUp}
        id="us-fundamental-performance"
        title="業績推移(実績FY)"
        lead="SEC 10-K の通期実績のみ。会社予想・コンセンサスの列は設けません。"
        aside={<span className="status-tag">実績のみ</span>}
        bleed
      >
        {periods.length > 0 ? (
          <>
            <TabSwitch
              label="表示する指標"
              options={PERFORMANCE_ROWS.map((row) => ({ value: row.key, label: row.label }))}
              value={metric}
              onChange={setMetric}
            />
            <div className="px-4 py-3.5 sm:px-5">
              <ColumnChart
                label={`${selected.label} 実績FY`}
                points={periods.map((period) => ({
                  key: String(period.fiscalYear),
                  label: `FY${period.fiscalYear}`,
                  sub: period.periodEnd.slice(0, 7),
                  value: numeric(period[metric]),
                  shown: display(period[metric], selected.signed),
                }))}
              />
            </div>
            <PerformanceTable periods={periods} />
          </>
        ) : (
          <div className="px-4 py-3.5 sm:px-5">
            <EmptyLine>基準日までに SEC Companyfacts のFY売上高実績がありません。</EmptyLine>
          </div>
        )}
      </PanelSection>
      <ForecastNote reason={model.coverage.forecastReason} />
    </>
  )
}

function PerformanceTable({ periods }: { periods: UsPerformancePeriod[] }) {
  return (
    <div className="min-w-0 overflow-x-auto overscroll-x-contain border-t border-[var(--color-border-soft)]">
      <table className="w-full border-collapse text-[12px]" style={{ minWidth: 120 + periods.length * 92 }}>
        <caption className="sr-only">FY実績の推移(SEC 10-K、会社予想なし)</caption>
        <thead>
          <tr className="border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]">
            <th scope="col" className="sticky left-0 z-[1] bg-[var(--color-surface-subtle)] px-3 py-2 text-left text-[11px] font-bold text-[var(--color-text-secondary)] sm:px-5">項目</th>
            {periods.map((period) => (
              <th key={period.fiscalYear} scope="col" className="px-2 py-2 text-right align-bottom">
                <span className="block font-mono text-[12px] font-bold text-[var(--color-text-primary)]">FY{period.fiscalYear}</span>
                <span className="block text-[11px] font-semibold text-[var(--color-text-tertiary)]">実績 <span className="font-mono">{period.periodEnd}</span></span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-soft)]">
          {PERFORMANCE_ROWS.map((row) => (
            <tr key={row.key}>
              <th scope="row" className="sticky left-0 z-[1] bg-white px-3 py-2 text-left text-[12px] font-bold text-[var(--color-text-primary)] sm:px-5">{row.label}</th>
              {periods.map((period) => {
                const shown = display(period[row.key], row.signed)
                return (
                  <td key={period.fiscalYear} className="px-2 py-2 text-right" title={shown.reason ?? undefined}>
                    <ValueText value={shown} size="sm" />
                  </td>
                )
              })}
            </tr>
          ))}
          <tr>
            <th scope="row" className="sticky left-0 z-[1] bg-white px-3 py-2 text-left text-[11px] font-bold text-[var(--color-text-secondary)] sm:px-5">開示日</th>
            {periods.map((period) => (
              <td key={period.fiscalYear} className="px-2 py-2 text-right font-mono text-[11px] text-[var(--color-text-tertiary)]">{dateOnly(period.publishedAt)}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function ForecastNote({ reason }: { reason: string }) {
  return (
    <p className="flex items-start gap-1.5 border-l-2 border-[var(--color-border-strong)] bg-[var(--color-surface-subtle)] px-2.5 py-1.5 text-[11px] font-medium leading-4 text-[var(--color-text-secondary)]">
      <CircleOff size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words"><strong className="font-bold">会社予想: 未提供</strong> — {reason}</span>
    </p>
  )
}

/* ------------------------------------------------------------------ */
/* Financial                                                           */
/* ------------------------------------------------------------------ */

function FinancialView({ model }: { model: UsFundamentalsModel }) {
  const { financials, summary } = model
  const periodSub = (value: UsFundamentalValue) => value.periodEnd ? `期末 ${value.periodEnd}` : null
  const flowSub = (value: UsFundamentalValue) => {
    const sign = displayedSign(value)
    const word = sign === 1 ? 'プラス' : sign === -1 ? 'マイナス' : sign === 0 ? 'ゼロ' : null
    return [value.periodEnd ? `期間末 ${value.periodEnd}` : null, word].filter(Boolean).join(' · ') || null
  }
  const { capital } = model
  return (
    <>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <PanelSection icon={Landmark} id="us-fundamental-balance" title="財政状態" lead="直近期末の貸借対照表(SEC)。同じ尺度で並べています。">
          <BarRows
            label="財政状態"
            mode="value"
            items={[
              { key: 'assets', label: '総資産', sub: periodSub(financials.totalAssets), value: financials.totalAssets },
              { key: 'liabilities', label: '負債合計', sub: periodSub(financials.totalLiabilities), value: financials.totalLiabilities },
              { key: 'equity', label: '純資産', sub: periodSub(financials.equity), value: financials.equity },
              { key: 'cash', label: '現金同等物', sub: periodSub(financials.cash), value: financials.cash },
              { key: 'current-assets', label: '流動資産', sub: periodSub(financials.currentAssets), value: financials.currentAssets },
              { key: 'current-liabilities', label: '流動負債', sub: periodSub(financials.currentLiabilities), value: financials.currentLiabilities },
              { key: 'total-debt', label: '有利子負債', sub: periodSub(financials.totalDebt), value: financials.totalDebt },
            ]}
          />
          <div className="-mx-4 -mb-3.5 mt-3 border-t border-[var(--color-border-soft)] sm:-mx-5">
            <MetricGrid columns="">
              <MetricCell label="自己資本比率" basis="純資産 ÷ 総資産" value={summary.equityRatio} />
              <MetricCell
                label="ROE"
                basis="LTM純利益 ÷ 期首・期末平均純資産"
                value={summary.roe}
                tip={(
                  <DefinitionTip term="ROE(自己資本利益率)">
                    LTM純利益 ÷ LTM期間の期首と期末の純資産の平均。どちらかの純資産がなければデータなし、平均が0以下ならN/M。
                  </DefinitionTip>
                )}
              />
              <MetricCell label="流動比率" basis="流動資産 ÷ 流動負債" value={financials.currentRatio} />
              <MetricCell label="有利子負債比率" basis="有利子負債 ÷ 純資産" value={financials.debtToEquity} />
            </MetricGrid>
          </div>
        </PanelSection>

        <PanelSection icon={Banknote} id="us-fundamental-cashflow" title="キャッシュフロー" lead="LTM、なければ直近FY。0線の右がプラス、左がマイナス。設備投資は取得支出を負の値に正規化(FCF = 営業CF + 設備投資)。">
          <BarRows
            label="キャッシュフロー"
            mode="signed"
            items={[
              { key: 'ocf', label: '営業CF', sub: flowSub(financials.operatingCashFlow), value: financials.operatingCashFlow },
              {
                key: 'fcf',
                label: 'FCF',
                sub: flowSub(financials.freeCashFlow),
                value: financials.freeCashFlow,
                tip: (
                  <DefinitionTip term="FCF(フリーキャッシュフロー)">
                    営業CF + 設備投資。設備投資はSECの有形固定資産の取得支出を負のキャッシュフロー値に正規化したもので、引き算はしません。どちらかのSEC factがなければデータなし。
                  </DefinitionTip>
                ),
              },
              { key: 'icf', label: '投資CF', sub: flowSub(financials.investingCashFlow), value: financials.investingCashFlow },
              { key: 'fincf', label: '財務CF', sub: flowSub(financials.financingCashFlow), value: financials.financingCashFlow },
              {
                key: 'capex',
                label: '設備投資',
                sub: flowSub(financials.capitalExpenditure),
                value: financials.capitalExpenditure,
                tip: (
                  <DefinitionTip term="設備投資(正規化後の符号)">
                    SECの有形固定資産の取得支出(流出)を、キャッシュフローとして負の値に正規化して表示します。FCFは営業CFにこの負の値を足して求めます。
                  </DefinitionTip>
                ),
              },
            ]}
          />
        </PanelSection>
      </div>

      <PanelSection icon={FileText} id="us-fundamental-capital" title="株式・資本" lead="SEC開示の株式数と希薄化後EPS。基準日までの最新値です。" bleed>
        <MetricGrid columns="md:grid-cols-3">
          <MetricCell label="発行済株式数" basis="直近開示(株)" value={capital.sharesOutstanding} />
          <MetricCell label="加重平均株式数" basis="直近開示(株)" value={capital.weightedAverageShares} />
          <MetricCell label="希薄化後EPS" basis="LTM、なければFY(SEC)" value={capital.dilutedEps} />
        </MetricGrid>
      </PanelSection>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Valuation                                                           */
/* ------------------------------------------------------------------ */

function ValuationView({ model }: { model: UsFundamentalsModel }) {
  const { valuation } = model
  return (
    <>
      <PanelSection
        icon={Scale}
        id="us-fundamental-multiples"
        title="倍率(実績ベース)"
        lead="基準日終値と SEC 開示の実績から算出。予想ベースの倍率はありません。"
        aside={(
          <span className="font-mono text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            {model.price != null ? `終値 ${perShare(model.price)}` : '終値なし'}{model.priceDate ? ` · ${model.priceDate}` : ''}
          </span>
        )}
        bleed
      >
        <MetricGrid columns="lg:grid-cols-4">
          <MetricCell
            label="実績PER"
            basis="株価 ÷ LTM EPS"
            value={valuation.trailingPer}
            tip={<DefinitionTip term="実績PER">LTM EPS が 0 以下のときは倍率に意味がないため N/M とします。</DefinitionTip>}
          />
          <MetricCell label="PBR" basis="株価 ÷ 1株純資産" value={valuation.pbr} />
          <MetricCell label="PSR" basis="時価総額 ÷ LTM売上高" value={valuation.psr} />
          <MetricCell label="時価総額" basis="株価 × SEC発行済株式数" value={valuation.marketCap} />
        </MetricGrid>
      </PanelSection>

      <PanelSection icon={CircleOff} id="us-fundamental-comparison" title="比較基準" lead="比較基準がないため、倍率の高低は評価しません。">
        <dl className="m-0 grid min-w-0 gap-x-4 gap-y-2.5 text-[12px] sm:grid-cols-[max-content_minmax(0,1fr)]">
          <dt className="flex items-center gap-1.5 font-bold text-[var(--color-text-primary)]">同業比較 <span className="status-tag">未提供</span></dt>
          <dd className="m-0 break-words leading-5 text-[var(--color-text-secondary)]">{valuation.peerReason}</dd>
          <dt className="flex items-center gap-1.5 font-bold text-[var(--color-text-primary)]">自社過去レンジ <span className="status-tag">未提供</span></dt>
          <dd className="m-0 break-words leading-5 text-[var(--color-text-secondary)]">このAPIは基準日時点の倍率のみを返し、倍率の時系列を含みません。</dd>
        </dl>
      </PanelSection>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Shareholder returns                                                 */
/* ------------------------------------------------------------------ */

function ReturnsView({ model }: { model: UsFundamentalsModel }) {
  const returns = model.shareholderReturn
  const zeroDividend = displayedSign(returns.trailingDividendPerShare) === 0
  return (
    <>
      <PanelSection icon={HandCoins} id="us-fundamental-returns" title="株主還元(直近1年)" lead="配当は Tiingo EOD の支払記録、自社株買い・配当性向は SEC 開示。" bleed>
        <MetricGrid columns="md:grid-cols-3 xl:grid-cols-5">
          <MetricCell
            label="1株配当"
            basis="基準日までの1年 支払日ベース"
            value={returns.trailingDividendPerShare}
            note={zeroDividend ? '期間内の配当支払い記録なし(0は観測値)' : null}
          />
          <MetricCell label="配当利回り" basis="1株配当 ÷ 株価" value={returns.trailingDividendYield} />
          <MetricCell label="配当性向" basis="現金配当 ÷ LTM純利益" value={returns.payoutRatio} />
          <MetricCell label="自社株買い" basis="LTM、なければFY(SEC)" value={returns.shareRepurchases} />
          <MetricCell label="自社株買い利回り" basis="自社株買い ÷ 時価総額" value={returns.buybackYield} />
        </MetricGrid>
      </PanelSection>

      <PanelSection icon={WalletCards} id="us-fundamental-dividends" title="配当履歴" lead="暦年・支払日ベースの1株配当。基準日の年は途中経過。">
        <DividendHistory history={returns.dividendHistory} asOf={model.asOf} coverage={returns.trailingDividendPerShare} />
      </PanelSection>
    </>
  )
}

/** 直近1年の配当 coverage を契約値の availability から読む(再計算しない)。 */
type DividendCoverage = 'observed_zero' | 'covered' | 'unconfirmed'

function dividendCoverage(trailing: UsFundamentalValue): DividendCoverage {
  if (trailing.availability !== 'available') return 'unconfirmed'
  return displayedSign(trailing) === 0 ? 'observed_zero' : 'covered'
}

/** 空の履歴を「支払いなし」と書けるのは、coverage 確認済みで観測値が0のときだけ。 */
function DividendHistory({ history, asOf, coverage }: { history: UsDividendYear[]; asOf: string; coverage: UsFundamentalValue }) {
  const state = dividendCoverage(coverage)
  const unconfirmedTag = <StateTag state={coverage.availability === 'available' ? 'missing' : coverage.availability} />
  const reason = coverage.reason ? ` ${coverage.reason}` : ''

  if (history.length === 0) {
    if (state === 'observed_zero') {
      return (
        <EmptyLine marker={<span className="shrink-0 font-mono text-[12px] font-bold leading-4 text-[var(--color-text-primary)]">{perShare(0)}</span>}>
          配当データの取得範囲(直近1年を含む)に Tiingo EOD の支払い記録はありません。0は観測値です。
        </EmptyLine>
      )
    }
    if (state === 'unconfirmed') {
      return <EmptyLine marker={unconfirmedTag}>配当データのcoverageを確認できないため、配当の有無は未確認です。{reason}</EmptyLine>
    }
    return <EmptyLine>暦年に集計できる Tiingo EOD の配当支払い記録がありません。</EmptyLine>
  }

  const asOfYear = Number(asOf.slice(0, 4))
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {state === 'unconfirmed' && (
        <EmptyLine marker={unconfirmedTag}>直近1年の配当データcoverageを確認できないため、履歴に欠けている期間がある可能性があります。{reason}</EmptyLine>
      )}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
        <ColumnChart
          label="1株配当 暦年"
          points={history.map((row) => {
            const partial = row.year === asOfYear
            return {
              key: String(row.year),
              label: String(row.year),
              sub: `${row.payments}回${partial ? '・途中' : ''}`,
              value: row.cashPerShare,
              shown: { text: perShare(row.cashPerShare), state: 'value' as const, reason: null },
              partial,
            }
          })}
        />
        <table className="w-full min-w-0 border-collapse self-start text-[12px]">
          <caption className="sr-only">暦年の1株配当と支払回数</caption>
          <thead>
            <tr className="border-b border-[var(--color-border-soft)] text-[11px] text-[var(--color-text-secondary)]">
              <th scope="col" className="py-1 text-left font-bold">年</th>
              <th scope="col" className="py-1 text-right font-bold">1株配当</th>
              <th scope="col" className="py-1 text-right font-bold">回数</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            {[...history].reverse().map((row) => (
              <tr key={row.year}>
                <th scope="row" className="py-1 text-left font-mono font-bold text-[var(--color-text-primary)]">
                  {row.year}
                  {row.year === asOfYear && <span className="ml-1 font-sans text-[11px] font-semibold text-[var(--color-text-tertiary)]">途中</span>}
                </th>
                <td className="py-1 text-right font-mono font-bold tabular-nums text-[var(--color-text-primary)]">{perShare(row.cashPerShare)}</td>
                <td className="py-1 text-right font-mono tabular-nums text-[var(--color-text-secondary)]">{row.payments}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
