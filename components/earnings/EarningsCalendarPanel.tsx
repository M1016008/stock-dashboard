// components/earnings/EarningsCalendarPanel.tsx
// 決算発表予定銘柄を、株価・平均出来高・6軸ステージ込みの一覧で表示する。

import Link from 'next/link'
import { Fragment } from 'react'
import { Card, CardHeader } from '@/components/ui/Card'
import { EarningsStockChartDisclosure } from '@/components/earnings/EarningsStockChartDisclosure'
import { IndustryBadges } from '@/components/ui/IndustryBadges'
import { MarginBadges } from '@/components/ui/MarginBadges'
import { StageTag } from '@/components/ui/StageTag'
import {
  getEarningsCalendarDashboard,
  type EarningsCalendarFilters,
  type EarningsSortDir,
  type EarningsSortKey,
} from '@/lib/queries/dashboard'

type EarningsDashboard = Awaited<ReturnType<typeof getEarningsCalendarDashboard>>
type EarningsRows = EarningsDashboard['rows']
type EarningsFilterOptions = EarningsDashboard['filterOptions']

const SORT_OPTIONS: Array<{ value: EarningsSortKey; label: string }> = [
  { value: 'daysLeft', label: '発表日が近い順' },
  { value: 'announceDate', label: '発表日' },
  { value: 'ticker', label: 'コード' },
  { value: 'name', label: '銘柄名' },
  { value: 'market', label: '市場区分' },
  { value: 'sector17', label: '17業種' },
  { value: 'sector33', label: '33業種' },
  { value: 'stageCode', label: '6桁ステージ' },
  { value: 'signalCount', label: 'シグナル数' },
  { value: 'price', label: '現在株価' },
  { value: 'changePct', label: '前日比' },
  { value: 'avgVolume10', label: '10日平均出来高' },
  { value: 'avgVolume30', label: '30日平均出来高' },
  { value: 'avgVolume60', label: '60日平均出来高' },
  { value: 'postEarningsChangePct', label: '決算後騰落' },
]

function fmtVol(v: number | null) {
  if (v == null) return '---'
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M'
  return Math.round(v / 1_000).toLocaleString() + 'K'
}

function fmtPrice(v: number | null) {
  if (v == null) return '---'
  return v.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function fmtPct(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return '---'
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`
}

function fmtRate(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return null
  return `${Math.round(v * 100)}%`
}

function fmtSignalDate(v: string | null | undefined) {
  if (!v) return '発生日未確認'
  return `${v.slice(5, 7)}/${v.slice(8, 10)}発生`
}

function tone(v: number | null) {
  if (v == null) return ''
  return v > 0 ? 'text-[var(--color-price-up)]' : v < 0 ? 'text-[var(--color-price-down)]' : ''
}

function fmtRunTime(value: string | number | null | undefined) {
  if (value == null) return '---'
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function dayLabel(daysLeft: number) {
  if (daysLeft === 0) return '本日'
  if (daysLeft > 0) return `+${daysLeft}d`
  return `${Math.abs(daysLeft)}日前`
}

function dayBucket(rows: EarningsRows) {
  const groups = [
    { key: 'today', label: '本日', tone: 'bg-[var(--color-price-up-bg)] text-[var(--color-price-up)]', rows: [] as EarningsRows },
    { key: 'soon', label: '1〜3日以内', tone: 'bg-[var(--color-brand-50)] text-[var(--color-brand-800)]', rows: [] as EarningsRows },
    { key: 'week', label: '1週間以内', tone: 'bg-[var(--color-pattern-50)] text-[var(--color-pattern-700)]', rows: [] as EarningsRows },
    { key: 'twoWeeks', label: '2週間以内', tone: 'bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]', rows: [] as EarningsRows },
    { key: 'later', label: 'それ以降', tone: 'bg-white text-[var(--color-text-tertiary)]', rows: [] as EarningsRows },
  ]
  for (const row of rows) {
    if (row.daysLeft <= 0) groups[0].rows.push(row)
    else if (row.daysLeft <= 3) groups[1].rows.push(row)
    else if (row.daysLeft <= 7) groups[2].rows.push(row)
    else if (row.daysLeft <= 14) groups[3].rows.push(row)
    else groups[4].rows.push(row)
  }
  return groups.filter((group) => group.rows.length > 0)
}

function sourceLabel(source: string | null) {
  if (source === 'jpx') return 'JPX公式'
  if (source === 'jquants') return 'J-Quants'
  return '取得済み'
}

function signalTone(label: string) {
  if (label === '上昇候補' || label === 'ブレイク直前' || label === '高値継続') {
    return 'border-[rgba(22,163,74,0.22)] bg-[rgba(22,163,74,0.08)] text-[var(--color-price-up)]'
  }
  if (label === '下落警戒' || label === 'MA下抜け') {
    return 'border-[rgba(220,38,38,0.22)] bg-[rgba(220,38,38,0.08)] text-[var(--color-price-down)]'
  }
  if (label.startsWith('MA')) {
    return 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]'
  }
  return 'border-[rgba(37,99,235,0.18)] bg-[var(--color-brand-50)] text-[var(--color-brand-800)]'
}

function SignalBadges({ labels, codes }: { labels: string[] | undefined; codes: string[] | undefined }) {
  const all = labels ?? []
  if (all.length === 0) {
    return <span className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">---</span>
  }
  return (
    <div className="flex max-w-[340px] flex-wrap gap-1" title={(codes ?? []).join(', ')}>
      {all.map((label) => (
        <span
          key={label}
          className={`rounded-full border px-1.5 py-[2px] text-[10px] font-bold leading-[1.15] whitespace-nowrap ${signalTone(label)}`}
        >
          {label}
        </span>
      ))}
    </div>
  )
}

function SignalStatChip({ stat }: { stat: EarningsRows[number]['signalDetails'][number]['stats'][number] }) {
  if (stat.source === 'missing' || stat.count == null) {
    return (
      <span className="rounded-[4px] border border-[var(--color-border-soft)] bg-white px-1.5 py-[2px] text-[10px] font-bold text-[var(--color-text-tertiary)]">
        {stat.periodLabel} 統計未生成
      </span>
    )
  }

  const upRate = fmtRate(stat.upRate)
  const downRate = fmtRate(stat.downRate)
  const bearish = stat.downRate != null && stat.upRate != null && stat.downRate > stat.upRate
  const direction = bearish ? `下落${downRate}` : upRate ? `上昇${upRate}` : '中央値'
  const color = bearish ? 'text-[var(--color-price-down)]' : 'text-[var(--color-price-up)]'
  return (
    <span
      className="rounded-[4px] border border-[var(--color-border-soft)] bg-white px-1.5 py-[2px] text-[10px] font-bold tabular-nums text-[var(--color-text-secondary)]"
      title={`N=${stat.count.toLocaleString()} / ${stat.horizonDays}営業日後`}
    >
      {stat.periodLabel} <span className={color}>{direction}</span> / {fmtPct(stat.medianReturnPct)}
    </span>
  )
}

function SignalDetails({ details }: { details: EarningsRows[number]['signalDetails'] | undefined }) {
  const rows = (details ?? []).filter((detail) => detail.label !== 'ボラ収縮' && detail.label !== 'MA上タッチ')
  if (rows.length === 0) return null
  return (
    <div className="mt-2 space-y-1.5">
      {rows.map((detail) => (
        <div
          key={`${detail.label}-${detail.code}`}
          className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2 py-1.5"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-bold leading-snug">
            <span className="text-[var(--color-text-primary)]">{detail.label}</span>
            <span className="tabular-nums text-[var(--color-text-tertiary)]">
              {fmtSignalDate(detail.triggerDate)}
              {detail.elapsedTradingDays == null ? '' : `・${detail.elapsedTradingDays}営業日経過`}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {detail.stats.map((stat) => (
              <SignalStatChip key={`${detail.code}-${stat.horizonDays}`} stat={stat} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function MlInsightNote({ insight }: { insight: EarningsRows[number]['mlInsight'] | undefined }) {
  if (!insight) return null
  const tone = insight.direction === 'up' ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'
  const label = insight.direction === 'up' ? '上昇候補' : '下落警戒'
  return (
    <div className="mt-2 rounded-[6px] border border-[var(--color-border-soft)] bg-white px-2 py-1.5 text-[10px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
      <div className={`mb-1 font-bold ${tone}`}>
        ML: {label} / {insight.confidenceLabel}
      </div>
      <p>{insight.summary}</p>
      {insight.watchPoints.length > 0 && (
        <p className="mt-1 text-[var(--color-text-tertiary)]">
          確認: {insight.watchPoints.slice(0, 2).join(' / ')}
        </p>
      )}
    </div>
  )
}

function compactFilterValue(value: string | number | null | undefined): string | null {
  if (value == null) return null
  const text = String(value).trim()
  return text ? text : null
}

function earningsHref({
  date,
  month,
  filters,
  limit,
}: {
  date?: string | null
  month?: string | null
  filters: EarningsCalendarFilters
  limit?: number | null
}) {
  const sp = new URLSearchParams()
  if (date) sp.set('date', date)
  if (month) sp.set('month', month)
  const pairs: Array<[string, string | number | null | undefined]> = [
    ['market', filters.marketSegment],
    ['sector17', filters.sector17],
    ['sector33', filters.sector33],
    ['stageCode', filters.stageCode],
    ['dailyPattern', filters.dailyPattern],
    ['volume', filters.volumeCondition],
    ['priceMin', filters.priceMin],
    ['priceMax', filters.priceMax],
    ['signal', filters.signal],
    ['sort', filters.sortBy],
    ['dir', filters.sortDir],
    ['limit', limit ?? filters.limit],
    ['completed', filters.completed ? '1' : null],
  ]
  for (const [key, value] of pairs) {
    const text = compactFilterValue(value)
    if (text) sp.set(key, text)
  }
  const query = sp.toString()
  return query ? `/earnings?${query}` : '/earnings'
}

function SelectField({
  label,
  name,
  value,
  options,
}: {
  label: string
  name: string
  value: string | null | undefined
  options: EarningsFilterOptions[keyof EarningsFilterOptions]
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
      {label}
      <select
        name={name}
        defaultValue={value ?? ''}
        className="h-9 rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-semibold text-[var(--color-text-primary)]"
      >
        <option value="">すべて</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}（{option.count}）
          </option>
        ))}
      </select>
    </label>
  )
}

function EarningsScopeControls({
  data,
  date,
  month,
}: {
  data: EarningsDashboard
  date?: string | null
  month?: string | null
}) {
  const filters = data.filters
  const scope = data.scope
  const options = data.filterOptions
  const nextLimit = Math.min(scope.displayLimit + 20, Math.max(scope.filteredCount, scope.displayLimit + 20))
  const resetHref = earningsHref({ date, month, filters: {}, limit: null })
  const moreHref = earningsHref({ date, month, filters, limit: nextLimit })

  return (
    <section className="mb-4 rounded-[8px] border border-[var(--color-border-default)] bg-white p-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <div className="rounded-[7px] bg-[var(--color-surface-subtle)] px-3 py-2">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">対象日</div>
          <div className="mt-1 text-[15px] font-bold tabular-nums text-[var(--color-brand-900)]">{scope.scopeDate ?? '最新基準'}</div>
        </div>
        <div className="rounded-[7px] bg-[var(--color-surface-subtle)] px-3 py-2">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">全体件数</div>
          <div className="mt-1 text-[15px] font-bold tabular-nums text-[var(--color-brand-900)]">{scope.totalCount.toLocaleString()}件</div>
        </div>
        <div className="rounded-[7px] bg-[var(--color-surface-subtle)] px-3 py-2">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">絞り込み後</div>
          <div className="mt-1 text-[15px] font-bold tabular-nums text-[var(--color-brand-900)]">{scope.filteredCount.toLocaleString()}件</div>
        </div>
        <div className="rounded-[7px] bg-[var(--color-surface-subtle)] px-3 py-2">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">表示中</div>
          <div className="mt-1 text-[15px] font-bold tabular-nums text-[var(--color-brand-900)]">{scope.displayedCount.toLocaleString()}件</div>
        </div>
      </div>

      <form action="/earnings" className="mt-3 grid gap-3">
        {date && <input type="hidden" name="date" value={date} />}
        {month && <input type="hidden" name="month" value={month} />}
        {filters.completed && <input type="hidden" name="completed" value="1" />}
        <div className="grid gap-2 md:grid-cols-4 xl:grid-cols-8">
          <SelectField label="市場区分" name="market" value={filters.marketSegment} options={options.marketSegments} />
          <SelectField label="17業種" name="sector17" value={filters.sector17} options={options.sector17} />
          <SelectField label="33業種" name="sector33" value={filters.sector33} options={options.sector33} />
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            6桁ステージ
            <input
              name="stageCode"
              list="earnings-stage-code-options"
              defaultValue={filters.stageCode ?? ''}
              placeholder="例: 111111"
              className="h-9 rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-semibold text-[var(--color-text-primary)]"
            />
            <datalist id="earnings-stage-code-options">
              {options.stageCodes.map((option) => <option key={option.value} value={option.value}>{option.count}件</option>)}
            </datalist>
          </label>
          <SelectField label="日足A/B" name="dailyPattern" value={filters.dailyPattern} options={options.dailyPatterns} />
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            出来高
            <select
              name="volume"
              defaultValue={filters.volumeCondition ?? ''}
              className="h-9 rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-semibold text-[var(--color-text-primary)]"
            >
              <option value="">すべて</option>
              <option value="volume_spike">出来高急増</option>
              <option value="above_avg">平均出来高以上</option>
              <option value="volume_10k">1万株以上</option>
              <option value="volume_100k">10万株以上</option>
            </select>
          </label>
          <SelectField label="シグナル" name="signal" value={filters.signal} options={options.signals} />
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            並び替え
            <select
              name="sort"
              defaultValue={filters.sortBy ?? 'daysLeft'}
              className="h-9 rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-semibold text-[var(--color-text-primary)]"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            順序
            <select
              name="dir"
              defaultValue={filters.sortDir ?? 'asc'}
              className="h-9 rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-semibold text-[var(--color-text-primary)]"
            >
              <option value="asc">昇順</option>
              <option value="desc">降順</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            表示件数
            <select
              name="limit"
              defaultValue={String(scope.displayLimit)}
              className="h-9 rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-semibold text-[var(--color-text-primary)]"
            >
              {[20, 40, 80, 160, 320, 640, 1000].map((value) => (
                <option key={value} value={value}>{value}件</option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid gap-2 md:grid-cols-[repeat(2,minmax(0,160px))_1fr]">
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            株価下限
            <input
              name="priceMin"
              inputMode="numeric"
              defaultValue={filters.priceMin ?? ''}
              placeholder="以上"
              className="h-9 rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-semibold text-[var(--color-text-primary)]"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            株価上限
            <input
              name="priceMax"
              inputMode="numeric"
              defaultValue={filters.priceMax ?? ''}
              placeholder="以下"
              className="h-9 rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-semibold text-[var(--color-text-primary)]"
            />
          </label>
          <div className="flex flex-wrap items-end justify-end gap-2">
            <Link
              href={resetHref}
              className="inline-flex h-9 items-center rounded-[6px] border border-[var(--color-border-default)] bg-white px-3 text-[12px] font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]"
              prefetch={false}
            >
              リセット
            </Link>
            <button
              type="submit"
              className="inline-flex h-9 items-center rounded-[6px] border border-[var(--color-brand-800)] bg-[var(--color-brand-800)] px-4 text-[12px] font-bold text-white"
            >
              絞り込む
            </button>
            {scope.hasMore && (
              <Link
                href={moreHref}
                className="inline-flex h-9 items-center rounded-[6px] border border-[var(--color-brand-200)] bg-[var(--color-brand-50)] px-3 text-[12px] font-bold text-[var(--color-brand-800)] hover:bg-white"
                prefetch={false}
              >
                表示件数を20件増やす
              </Link>
            )}
          </div>
        </div>
        {scope.hasMore && (
          <div className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            件数が多い日は初期表示を絞っています。必要に応じて表示件数を増やすか、条件で絞り込んでください。
          </div>
        )}
      </form>
    </section>
  )
}

function nextSortDir(filters: EarningsCalendarFilters, key: EarningsSortKey): EarningsSortDir {
  const currentKey = filters.sortBy ?? 'daysLeft'
  const currentDir = filters.sortDir ?? 'asc'
  if (currentKey === key && currentDir === 'asc') return 'desc'
  return 'asc'
}

function SortableTh({
  label,
  sortKey,
  date,
  month,
  filters,
  className = '',
  align = 'left',
}: {
  label: string
  sortKey: EarningsSortKey
  date?: string | null
  month?: string | null
  filters: EarningsCalendarFilters
  className?: string
  align?: 'left' | 'right'
}) {
  const active = (filters.sortBy ?? 'daysLeft') === sortKey
  const dir = active ? (filters.sortDir ?? 'asc') : 'asc'
  const href = earningsHref({
    date,
    month,
    filters: { ...filters, sortBy: sortKey, sortDir: nextSortDir(filters, sortKey) },
    limit: filters.limit ?? null,
  })
  const arrow = active ? (dir === 'asc' ? '↑' : '↓') : '↕'
  return (
    <th className={`${className} ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <Link
        href={href}
        className={`inline-flex items-center gap-1 rounded-[4px] px-1 py-0.5 hover:bg-[var(--color-surface-subtle)] ${active ? 'text-[var(--color-brand-800)]' : ''}`}
        prefetch={false}
        title={`${label}で並び替え`}
      >
        <span>{label}</span>
        <span className="text-[10px]">{arrow}</span>
      </Link>
    </th>
  )
}

function EarningsTable({
  rows,
  mode = 'upcoming',
  maxRows = 40,
  date,
  month,
  filters,
}: {
  rows: EarningsRows
  mode?: 'upcoming' | 'completed'
  maxRows?: number
  date?: string | null
  month?: string | null
  filters: EarningsCalendarFilters
}) {
  const completed = mode === 'completed'
  const visibleRows = rows.slice(0, maxRows)
  const hiddenCount = Math.max(0, rows.length - visibleRows.length)
  const colSpan = completed ? 14 : 13
  return (
    <div className="overflow-x-auto">
      <table className={`w-full text-[12px] ${completed ? 'min-w-[1960px]' : 'min-w-[1860px]'}`}>
        <thead>
          <tr className="text-left text-[11px] font-bold text-[var(--color-text-tertiary)]">
            <SortableTh label="発表" sortKey="daysLeft" date={date} month={month} filters={filters} className="pb-3 pl-2 pr-3" />
            <SortableTh label="銘柄名" sortKey="ticker" date={date} month={month} filters={filters} className="pb-3 pr-3" />
            <th className="pb-3 pr-3">貸借/信用</th>
            <SortableTh label="J-Quants業種" sortKey="sector33" date={date} month={month} filters={filters} className="pb-3 pr-3" />
            <SortableTh label="シグナル" sortKey="signalCount" date={date} month={month} filters={filters} className="pb-3 pr-4" />
            {completed && <SortableTh label="決算後" sortKey="postEarningsChangePct" date={date} month={month} filters={filters} className="pb-3 pr-3" align="right" />}
            <SortableTh label="現在株価" sortKey="price" date={date} month={month} filters={filters} className="pb-3 pr-3" align="right" />
            <SortableTh label="前日比" sortKey="changePct" date={date} month={month} filters={filters} className="pb-3 pr-3" align="right" />
            <SortableTh label="10日平均" sortKey="avgVolume10" date={date} month={month} filters={filters} className="pb-3 pr-3" align="right" />
            <SortableTh label="30日平均" sortKey="avgVolume30" date={date} month={month} filters={filters} className="pb-3 pr-3" align="right" />
            <SortableTh label="60日平均" sortKey="avgVolume60" date={date} month={month} filters={filters} className="pb-3 pr-3" align="right" />
            <SortableTh label="日足A/B" sortKey="stageCode" date={date} month={month} filters={filters} className="pb-3 pr-3" />
            <th className="pb-3 pr-3">週足A/B</th>
            <th className="pb-3 pr-2">月足A/B</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-soft)]">
          {visibleRows.map((row) => (
            <Fragment key={row.ticker + row.announce_date}>
              <tr className="hover:bg-[var(--color-surface-subtle)]">
                <td className={`py-3 pl-2 pr-3 tabular-nums ${row.daysLeft === 0 ? 'font-bold text-[var(--color-price-up)]' : 'text-[var(--color-text-secondary)]'}`}>
                  <div>{dayLabel(row.daysLeft)}</div>
                  <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{row.announce_date.slice(5)}</div>
                  <div className="mt-1 text-[10px] font-bold text-[var(--color-brand-700)]">{sourceLabel(row.source)}</div>
                </td>
                <td className="py-3 pr-3">
                  <Link href={`/stock/${row.ticker}`} className="font-bold tabular-nums hover:underline">{row.ticker}</Link>
                  <div className="mt-1 max-w-[260px] truncate font-semibold">{row.name ?? row.ticker}</div>
                </td>
                <td className="py-3 pr-3">
                  <MarginBadges
                    marginType={row.marginType}
                    creditRatio={row.creditRatio}
                    shortRatio={row.shortRatio}
                    compact={completed}
                  />
                </td>
                <td className="py-3 pr-3">
                  <IndustryBadges
                    sector17={row.sector17Name}
                    sector33={row.sector33Name}
                    marketSegment={row.marketSegment}
                    compact
                  />
                </td>
                <td className="py-3 pr-4 align-top">
                  <SignalBadges labels={row.signalLabels} codes={row.signalCodes} />
                  <SignalDetails details={row.signalDetails} />
                  <MlInsightNote insight={row.mlInsight} />
                </td>
                {completed && (
                  <td className={`py-3 pr-3 text-right tabular-nums font-bold ${tone(row.postEarningsChangePct)}`}>
                    <div>{fmtPct(row.postEarningsChangePct)}</div>
                    <div className="mt-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                      {row.postEarningsBaseDate ? `${row.postEarningsBaseDate.slice(5)}比` : '基準なし'}
                      {row.postEarningsTradingDays != null ? ` / ${row.postEarningsTradingDays}営業日` : ''}
                    </div>
                    <div className="mt-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                      基準 {fmtPrice(row.postEarningsBasePrice)}
                    </div>
                  </td>
                )}
                <td className="py-3 pr-3 text-right tabular-nums font-semibold">{fmtPrice(row.price)}</td>
                <td className={`py-3 pr-3 text-right tabular-nums font-semibold ${tone(row.changePct)}`}>
                  {row.changePct == null ? '---' : (row.changePct > 0 ? '+' : '') + row.changePct.toFixed(2) + '%'}
                </td>
                <td className="py-3 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">{fmtVol(row.avgVolume10)}</td>
                <td className="py-3 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">{fmtVol(row.avgVolume30)}</td>
                <td className="py-3 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">{fmtVol(row.avgVolume60)}</td>
                <td className="py-3 pr-3">
                  <div className="flex items-center gap-1"><StageTag stage={row.daily_a_stage} size="xs" /><StageTag stage={row.daily_b_stage} size="xs" /></div>
                </td>
                <td className="py-3 pr-3">
                  <div className="flex items-center gap-1"><StageTag stage={row.weekly_a_stage} size="xs" /><StageTag stage={row.weekly_b_stage} size="xs" /></div>
                </td>
                <td className="py-3 pr-2">
                  <div className="flex items-center gap-1"><StageTag stage={row.monthly_a_stage} size="xs" /><StageTag stage={row.monthly_b_stage} size="xs" /></div>
                </td>
              </tr>
              <EarningsStockChartDisclosure
                ticker={row.ticker}
                name={row.name}
                announceDate={row.announce_date}
                colSpan={colSpan}
              />
            </Fragment>
          ))}
          {hiddenCount > 0 && (
            <tr>
              <td colSpan={colSpan} className="py-3 text-center text-[11px] font-bold text-[var(--color-text-tertiary)]">
                初期表示は {maxRows} 件です。全 {rows.length.toLocaleString()} 件中、残り {hiddenCount.toLocaleString()} 件は表示件数を増やすか条件を絞って確認してください。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export async function EarningsCalendarPanel({
  date,
  month,
  preferLatestImport = true,
  filters,
  includeCompleted = false,
}: {
  date?: string | null
  month?: string | null
  preferLatestImport?: boolean
  filters?: EarningsCalendarFilters
  includeCompleted?: boolean
}) {
  const effectiveFilters = { ...(filters ?? {}), completed: includeCompleted }
  const data = await getEarningsCalendarDashboard(14, date, {
    preferLatestImport,
    filters: effectiveFilters,
    includeCompleted,
  })
  const rows = data.rows
  const upcomingGroups = dayBucket(rows)
  const completedRows = data.completedRows
  return (
    <Card>
      <CardHeader
        title="決算発表銘柄"
        hint={data.windowStart && data.windowEnd ? `${data.windowStart}〜${data.windowEnd} / J-Quants + JPX公式` : 'J-Quants + JPX公式'}
      />
      {rows.length === 0 && data.scope.totalCount === 0 ? (
        <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-6 text-center">
          <div className="text-[13px] font-bold text-[var(--color-text-secondary)]">
            {data.status === 'error' ? 'データ取得失敗' : data.status === 'stale' ? '決算カレンダー未更新' : data.status === 'empty' ? 'データ未取り込み' : '該当銘柄なし'}
          </div>
          <div className="mx-auto mt-2 max-w-[720px] text-[12px] font-medium leading-relaxed text-[var(--color-text-tertiary)]">
            {data.message}
          </div>
          {data.latestAnnounceDate && (
            <div className="mt-2 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
              DB内の最新決算日: {data.latestAnnounceDate}
            </div>
          )}
          <div className="mt-2 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            DB件数: {data.totalRows.toLocaleString()}件 / 最新取得: {fmtRunTime(data.latestImportedAt)} / 最終バッチ: {data.lastRun?.status ?? '---'}・{data.lastRun?.rowsInserted ?? 0}件・{fmtRunTime(data.lastRun?.finishedAt)}
          </div>
        </div>
      ) : (
        <>
          <div className="mb-3 rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-3 text-[12px] font-medium leading-relaxed text-[var(--color-text-secondary)]">
            <div>{data.message}</div>
            <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
              DB件数: {data.totalRows.toLocaleString()}件 / 最新取得: {fmtRunTime(data.latestImportedAt)} / 最終バッチ: {data.lastRun?.status ?? '---'}・{data.lastRun?.rowsInserted ?? 0}件・{fmtRunTime(data.lastRun?.finishedAt)}
            </div>
          </div>
          <EarningsScopeControls data={data} date={date} month={month} />
          <div className="space-y-4">
            {upcomingGroups.map((group) => (
              <section key={group.key} className="rounded-[8px] border border-[var(--color-border-soft)] bg-white">
                <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-3 py-2">
                  <div className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${group.tone}`}>
                    {group.label}
                  </div>
                  <div className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                  {group.rows.length.toLocaleString()}銘柄
                  </div>
                </div>
                <div className="p-3">
                  <EarningsTable
                    rows={group.rows}
                    maxRows={data.scope.displayLimit}
                    date={date}
                    month={month}
                    filters={data.filters}
                  />
                </div>
              </section>
            ))}
            {data.scope.filteredCount === 0 && data.scope.totalCount > 0 && (
              <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-8 text-center text-[13px] font-bold text-[var(--color-text-tertiary)]">
                現在の絞り込み条件に該当する銘柄はありません。
              </div>
            )}
          </div>
        </>
      )}
      {rows.length === 0 && data.referenceRows.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[12px] font-bold text-[var(--color-text-secondary)]">
            最新取得分（参考）
          </div>
          <EarningsTable rows={data.referenceRows} maxRows={20} date={date} month={month} filters={data.filters} />
        </div>
      )}
      {completedRows.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-bold text-[var(--color-text-primary)]">発表後2週間の値動き</div>
              <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                決算発表後、最初に取引があった終値を基準に、最新株価までの変化を追跡します。
              </div>
            </div>
            <span className="rounded-full bg-[var(--color-surface-subtle)] px-2.5 py-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
              {completedRows.length.toLocaleString()}銘柄
            </span>
          </div>
          <EarningsTable rows={completedRows} mode="completed" maxRows={30} date={date} month={month} filters={data.filters} />
        </div>
      )}
      {!includeCompleted && (
        <div className="mt-5 rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-bold text-[var(--color-text-primary)]">発表後2週間の値動き</div>
              <div className="mt-1 text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">
                初期表示を軽くするため、この詳細テーブルは必要な時だけ読み込みます。
              </div>
            </div>
            <Link
              href={earningsHref({ date, month, filters: { ...data.filters, completed: true }, limit: data.filters.limit ?? null })}
              prefetch={false}
              className="inline-flex h-9 items-center rounded-[6px] border border-[var(--color-brand-200)] bg-white px-3 text-[12px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-brand-50)]"
            >
              発表後データを読み込む
            </Link>
          </div>
        </div>
      )}
    </Card>
  )
}
