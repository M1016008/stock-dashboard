// components/earnings/EarningsCalendarPanel.tsx
// 決算発表予定銘柄を、株価・平均出来高・6ステージ込みの一覧で表示する。

import Link from 'next/link'
import { Fragment } from 'react'
import { EmptyState } from '@/components/ui/EmptyState'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { StatStrip } from '@/components/ui/StatStrip'
import { EarningsStockChartDisclosure } from '@/components/earnings/EarningsStockChartDisclosure'
import { IndustryBadges } from '@/components/ui/IndustryBadges'
import { MarginBadges } from '@/components/ui/MarginBadges'
import { StageDots } from '@/components/ui/StageDots'
import {
  getEarningsCalendarDashboard,
  type EarningsCalendarFilters,
  type EarningsSortDir,
  type EarningsSortKey,
} from '@/lib/queries/dashboard'
import {
  earningsPredictionConfidenceLabel,
  earningsTimeBucketLabel,
  type EarningsPredictionConfidence,
  type EarningsTimeBucket,
} from '@/lib/earnings-time'

type EarningsDashboard = Awaited<ReturnType<typeof getEarningsCalendarDashboard>>
type EarningsRows = EarningsDashboard['rows']
type EarningsFilterOptions = EarningsDashboard['filterOptions']

const SORT_OPTIONS: Array<{ value: EarningsSortKey; label: string }> = [
  { value: 'daysLeft', label: '発表日が近い順' },
  { value: 'announceDate', label: '発表日' },
  { value: 'announcementTime', label: '発表時刻' },
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

function runStatusLabel(status: string | null | undefined) {
  if (!status) return '---'
  if (status === 'success' || status === 'ok' || status === 'completed') return '正常'
  if (status === 'failed' || status === 'error') return '失敗'
  if (status === 'running') return '実行中'
  return status
}

function DataStatusLine({ data }: { data: EarningsDashboard }) {
  return (
    <span className="block text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
      登録 {data.totalRows.toLocaleString()}件 · 最終取得 {fmtRunTime(data.latestImportedAt)} · 前回更新 {runStatusLabel(data.lastRun?.status)}（{(data.lastRun?.rowsInserted ?? 0).toLocaleString()}件・{fmtRunTime(data.lastRun?.finishedAt)}）
    </span>
  )
}

function dayLabel(daysLeft: number) {
  if (daysLeft === 0) return '本日'
  if (daysLeft > 0) return `+${daysLeft}d`
  return `${Math.abs(daysLeft)}日前`
}

function dayBucket(rows: EarningsRows) {
  const groups = [
    { key: 'today', label: '本日', tone: 'bg-[var(--color-price-up)]', rows: [] as EarningsRows },
    { key: 'soon', label: '1〜3日以内', tone: 'bg-[var(--color-brand-700)]', rows: [] as EarningsRows },
    { key: 'week', label: '1週間以内', tone: 'bg-[var(--color-brand-300)]', rows: [] as EarningsRows },
    { key: 'twoWeeks', label: '2週間以内', tone: 'bg-[var(--color-border-strong)]', rows: [] as EarningsRows },
    { key: 'later', label: 'それ以降', tone: 'bg-[var(--color-border-default)]', rows: [] as EarningsRows },
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

function announcementTimeDisplay(row: EarningsRows[number]) {
  if (row.kind === 'completed' && row.actualDisclosedTime) {
    return {
      time: row.actualDisclosedTime,
      badge: '実績',
      detail: row.scheduledTime ? `予定 ${row.scheduledTime}` : null,
      predicted: false,
    }
  }
  if (row.scheduledTime) {
    return {
      time: row.scheduledTime,
      badge: row.scheduledTimeKind === 'confirmed' ? '確定予定' : '予定',
      detail: null,
      predicted: false,
    }
  }
  if (row.predictedTime) {
    const confidence = earningsPredictionConfidenceLabel(
      row.predictionConfidence as EarningsPredictionConfidence | null,
    )
    return {
      time: `${row.predictedTime}頃`,
      badge: '予想',
      detail: row.predictionSampleCount != null && row.predictionModeCount != null
        ? `${row.predictionModeCount}/${row.predictionSampleCount}回・信頼度${confidence}`
        : `信頼度${confidence}`,
      predicted: true,
    }
  }
  return { time: '未定', badge: '未公表', detail: null, predicted: false }
}

function signalTone(label: string) {
  if (label === '上昇候補' || label === 'ブレイク直前' || label === '高値継続') {
    return 'border-transparent bg-[var(--color-price-up-bg)] text-[var(--color-price-up)]'
  }
  if (label === '下落警戒' || label === 'MA下抜け') {
    return 'border-transparent bg-[var(--color-price-down-bg)] text-[var(--color-price-down)]'
  }
  if (label.startsWith('MA')) {
    return 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]'
  }
  return 'border-transparent bg-[var(--color-brand-50)] text-[var(--color-brand-800)]'
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
          className={`rounded-[3px] border px-1.5 py-[2px] text-[10px] font-semibold leading-[1.15] whitespace-nowrap ${signalTone(label)}`}
        >
          {label}
        </span>
      ))}
    </div>
  )
}

function MlInsightNote({ insight }: { insight: EarningsRows[number]['mlInsight'] | undefined }) {
  if (!insight) return null
  const tone = insight.direction === 'up' ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'
  const label = insight.direction === 'up' ? '上昇候補' : '下落警戒'
  return (
    <div className="mt-2 max-w-[340px] border-l-2 border-[var(--color-border-default)] pl-2 text-[10px] leading-relaxed text-[var(--color-text-secondary)]">
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

function stageValues(row: EarningsRows[number]) {
  return [
    row.daily_a_stage,
    row.daily_b_stage,
    row.weekly_a_stage,
    row.weekly_b_stage,
    row.monthly_a_stage,
    row.monthly_b_stage,
  ]
}

function stagePairLabel(a: number | null, b: number | null) {
  return `${a ?? '-'}${b ?? '-'}`
}

function stageCodeLabel(row: EarningsRows[number]) {
  const values = stageValues(row)
  if (values.every((value) => typeof value === 'number')) return values.join('')
  return '------'
}

function SixStageCell({ row }: { row: EarningsRows[number] }) {
  return (
    <div className="min-w-[150px] space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] font-bold tabular-nums text-[var(--color-text-primary)]">
          {stageCodeLabel(row)}
        </span>
      </div>
      <StageDots values={stageValues(row)} size={18} />
      <div className="flex flex-wrap gap-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
        <span>日 {stagePairLabel(row.daily_a_stage, row.daily_b_stage)}</span>
        <span>週 {stagePairLabel(row.weekly_a_stage, row.weekly_b_stage)}</span>
        <span>月 {stagePairLabel(row.monthly_a_stage, row.monthly_b_stage)}</span>
      </div>
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
    ['marginType', filters.marginType],
    ['stageCode', filters.stageCode],
    ['dailyPattern', filters.dailyPattern],
    ['volume', filters.volumeCondition],
    ['avgVolumeWindow', filters.avgVolumeWindow],
    ['avgVolumeMin', filters.avgVolumeMin],
    ['avgVolumeMax', filters.avgVolumeMax],
    ['priceMin', filters.priceMin],
    ['priceMax', filters.priceMax],
    ['signal', filters.signal],
    ['timeBucket', filters.timeBucket],
    ['sort', filters.sortBy],
    ['dir', filters.sortDir],
    ['limit', limit ?? filters.limit],
    ['completed', filters.completed ? '1' : null],
    ['universe', filters.universe],
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
    <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
      {label}
      <select
        name={name}
        defaultValue={value ?? ''}
        className="h-9 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] text-[var(--color-text-primary)]"
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
    <div className="flex flex-col gap-3">
      <StatStrip
        label="決算一覧の件数"
        items={[
          { label: '対象日', value: scope.scopeDate ?? '最新基準' },
          { label: '全体', value: `${scope.totalCount.toLocaleString()}件` },
          { label: '絞り込み後', value: `${scope.filteredCount.toLocaleString()}件` },
          { label: '表示中', value: `${scope.displayedCount.toLocaleString()}件` },
        ]}
      />

      <form action="/earnings" className="grid gap-3 rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-3">
        {date && <input type="hidden" name="date" value={date} />}
        {month && <input type="hidden" name="month" value={month} />}
        {filters.completed && <input type="hidden" name="completed" value="1" />}
        {filters.universe && <input type="hidden" name="universe" value={filters.universe} />}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-10">
          <SelectField label="市場区分" name="market" value={filters.marketSegment} options={options.marketSegments} />
          <SelectField label="17業種" name="sector17" value={filters.sector17} options={options.sector17} />
          <SelectField label="33業種" name="sector33" value={filters.sector33} options={options.sector33} />
          <SelectField label="貸借/信用" name="marginType" value={filters.marginType} options={options.marginTypes} />
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            6桁ステージ
            <input
              name="stageCode"
              list="earnings-stage-code-options"
              defaultValue={filters.stageCode ?? ''}
              placeholder="例: 111111"
              className="h-9 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] text-[var(--color-text-primary)]"
            />
            <datalist id="earnings-stage-code-options">
              {options.stageCodes.map((option) => <option key={option.value} value={option.value}>{option.count}件</option>)}
            </datalist>
          </label>
          <SelectField label="日足A/B" name="dailyPattern" value={filters.dailyPattern} options={options.dailyPatterns} />
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            出来高
            <select
              name="volume"
              defaultValue={filters.volumeCondition ?? ''}
              className="h-9 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] text-[var(--color-text-primary)]"
            >
              <option value="">すべて</option>
              <option value="volume_spike">出来高急増</option>
              <option value="above_avg">平均出来高以上</option>
              <option value="volume_10k">1万株以上</option>
              <option value="volume_100k">10万株以上</option>
            </select>
          </label>
          <SelectField label="シグナル" name="signal" value={filters.signal} options={options.signals} />
          <SelectField label="発表時間帯" name="timeBucket" value={filters.timeBucket} options={options.timeBuckets} />
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            並び替え
            <select
              name="sort"
              defaultValue={filters.sortBy ?? 'daysLeft'}
              className="h-9 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] text-[var(--color-text-primary)]"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            順序
            <select
              name="dir"
              defaultValue={filters.sortDir ?? 'asc'}
              className="h-9 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] text-[var(--color-text-primary)]"
            >
              <option value="asc">昇順</option>
              <option value="desc">降順</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            表示件数
            <select
              name="limit"
              defaultValue={String(scope.displayLimit)}
              className="h-9 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] text-[var(--color-text-primary)]"
            >
              {[20, 40, 80, 160, 320, 640, 1000].map((value) => (
                <option key={value} value={value}>{value}件</option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-[repeat(5,minmax(0,160px))_1fr]">
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            平均出来高期間
            <select
              name="avgVolumeWindow"
              defaultValue={String(filters.avgVolumeWindow ?? 30)}
              className="h-9 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] text-[var(--color-text-primary)]"
            >
              <option value="10">10日平均</option>
              <option value="30">30日平均</option>
              <option value="60">60日平均</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            平均出来高下限
            <input
              name="avgVolumeMin"
              inputMode="numeric"
              defaultValue={filters.avgVolumeMin ?? ''}
              placeholder="以上"
              className="h-9 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] text-[var(--color-text-primary)]"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            平均出来高上限
            <input
              name="avgVolumeMax"
              inputMode="numeric"
              defaultValue={filters.avgVolumeMax ?? ''}
              placeholder="以下"
              className="h-9 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] text-[var(--color-text-primary)]"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            株価下限
            <input
              name="priceMin"
              inputMode="numeric"
              defaultValue={filters.priceMin ?? ''}
              placeholder="以上"
              className="h-9 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] text-[var(--color-text-primary)]"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            株価上限
            <input
              name="priceMax"
              inputMode="numeric"
              defaultValue={filters.priceMax ?? ''}
              placeholder="以下"
              className="h-9 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] text-[var(--color-text-primary)]"
            />
          </label>
          <div className="col-span-2 flex flex-wrap items-end justify-end gap-2 md:col-span-3 xl:col-span-1">
            <Link href={resetHref} className="btn" data-variant="ghost" prefetch={false}>
              リセット
            </Link>
            <button type="submit" className="btn" data-variant="primary">
              絞り込む
            </button>
            {scope.hasMore && (
              <Link href={moreHref} className="btn" prefetch={false}>
                表示件数を20件増やす
              </Link>
            )}
          </div>
        </div>
        {scope.hasMore && (
          <p className="text-[11px] text-[var(--color-text-tertiary)]">
            件数が多い日は初期表示を絞っています。表示件数を増やすか、条件で絞り込んでください。
          </p>
        )}
      </form>
    </div>
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
        className={`inline-flex items-center gap-1 rounded-[4px] px-1 py-0.5 hover:bg-white ${active ? 'text-[var(--color-brand-800)]' : ''}`}
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
  const colSpan = completed ? 13 : 12
  const hiddenNote = hiddenCount > 0
    ? `初期表示は ${maxRows} 件です。全 ${rows.length.toLocaleString()} 件中、残り ${hiddenCount.toLocaleString()} 件は表示件数を増やすか条件を絞って確認してください。`
    : null
  return (
    <>
    <ul className="divide-y divide-[var(--color-border-soft)] lg:hidden">
      {visibleRows.map((row) => {
        const announcementTime = announcementTimeDisplay(row)
        return (
          <li key={row.ticker + row.announce_date} className="flex flex-col gap-2 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <Link href={`/stock/${row.ticker}`} className="font-mono text-[13px] font-bold tabular-nums text-[var(--color-brand-800)] hover:underline">
                    {row.ticker}
                  </Link>
                  <span className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{row.name ?? row.ticker}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                  <span className={row.daysLeft === 0 ? 'font-bold text-[var(--color-price-up)]' : 'text-[var(--color-text-secondary)]'}>
                    {dayLabel(row.daysLeft)}
                  </span>
                  <span>{row.announce_date.slice(5)}</span>
                  <span className={announcementTime.predicted ? 'font-semibold text-amber-700' : 'font-semibold text-[var(--color-text-secondary)]'}>
                    {announcementTime.time}（{announcementTime.badge}）
                  </span>
                  <span>{sourceLabel(row.source)}</span>
                </div>
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <div className="text-[13px] font-semibold text-[var(--color-text-primary)]">{fmtPrice(row.price)}</div>
                <div className={`text-[11px] font-semibold ${tone(row.changePct)}`}>{fmtPct(row.changePct)}</div>
                {completed && (
                  <div className={`mt-0.5 text-[11px] font-bold ${tone(row.postEarningsChangePct)}`}>
                    決算後 {fmtPct(row.postEarningsChangePct)}
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <StageDots values={stageValues(row)} size={14} />
              <span className="font-mono text-[11px] font-bold tabular-nums text-[var(--color-text-secondary)]">{stageCodeLabel(row)}</span>
              <span className="text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                平均出来高 {fmtVol(row.avgVolume10)} / {fmtVol(row.avgVolume30)} / {fmtVol(row.avgVolume60)}
              </span>
            </div>
            <SignalBadges labels={row.signalLabels} codes={row.signalCodes} />
            <EarningsStockChartDisclosure ticker={row.ticker} name={row.name} announceDate={row.announce_date} />
          </li>
        )
      })}
      {hiddenNote && (
        <li className="py-3 text-center text-[11px] text-[var(--color-text-tertiary)]">{hiddenNote}</li>
      )}
    </ul>
    <div className="table-scroll hidden lg:block">
      <table className={`w-full text-[12px] ${completed ? 'min-w-[1830px]' : 'min-w-[1730px]'}`}>
        <thead>
          <tr className="text-left text-[11px] font-bold text-[var(--color-text-tertiary)]">
            <SortableTh label="発表" sortKey="daysLeft" date={date} month={month} filters={filters} className="py-2 pl-2 pr-3" />
            <SortableTh label="時刻" sortKey="announcementTime" date={date} month={month} filters={filters} className="py-2 pr-3" />
            <SortableTh label="銘柄名" sortKey="ticker" date={date} month={month} filters={filters} className="py-2 pr-3" />
            <th className="py-2 pr-3">貸借/信用</th>
            <SortableTh label="J-Quants業種" sortKey="sector33" date={date} month={month} filters={filters} className="py-2 pr-3" />
            <SortableTh label="シグナル" sortKey="signalCount" date={date} month={month} filters={filters} className="py-2 pr-4" />
            {completed && <SortableTh label="決算後" sortKey="postEarningsChangePct" date={date} month={month} filters={filters} className="py-2 pr-3" align="right" />}
            <SortableTh label="現在株価" sortKey="price" date={date} month={month} filters={filters} className="py-2 pr-3" align="right" />
            <SortableTh label="前日比" sortKey="changePct" date={date} month={month} filters={filters} className="py-2 pr-3" align="right" />
            <SortableTh label="10日平均" sortKey="avgVolume10" date={date} month={month} filters={filters} className="py-2 pr-3" align="right" />
            <SortableTh label="30日平均" sortKey="avgVolume30" date={date} month={month} filters={filters} className="py-2 pr-3" align="right" />
            <SortableTh label="60日平均" sortKey="avgVolume60" date={date} month={month} filters={filters} className="py-2 pr-3" align="right" />
            <SortableTh label="6ステージ" sortKey="stageCode" date={date} month={month} filters={filters} className="py-2 pr-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-soft)]">
          {visibleRows.map((row) => {
            const announcementTime = announcementTimeDisplay(row)
            return (
            <Fragment key={row.ticker + row.announce_date}>
              <tr className="hover:bg-[var(--color-surface-subtle)]">
                <td className={`py-3 pl-2 pr-3 tabular-nums ${row.daysLeft === 0 ? 'font-bold text-[var(--color-price-up)]' : 'text-[var(--color-text-secondary)]'}`}>
                  <div>{dayLabel(row.daysLeft)}</div>
                  <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{row.announce_date.slice(5)}</div>
                  <div className="mt-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">{sourceLabel(row.source)}</div>
                </td>
                <td className="py-3 pr-3 align-top">
                  <div className={`font-mono text-[12px] font-bold tabular-nums ${announcementTime.predicted ? 'text-amber-700' : 'text-[var(--color-text-primary)]'}`}>
                    {announcementTime.time}
                  </div>
                  <div className={`mt-1 inline-flex rounded-[3px] border px-1.5 py-0.5 text-[9px] font-bold ${announcementTime.predicted ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]'}`}>
                    {announcementTime.badge}
                  </div>
                  <div className="mt-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                    {earningsTimeBucketLabel(row.timeBucket as EarningsTimeBucket | null)}
                  </div>
                  {announcementTime.detail && (
                    <div className="mt-1 max-w-[120px] text-[9px] font-semibold leading-snug text-[var(--color-text-tertiary)]">
                      {announcementTime.detail}
                    </div>
                  )}
                </td>
                <td className="py-3 pr-3">
                  <Link href={`/stock/${row.ticker}`} className="font-bold tabular-nums text-[var(--color-brand-800)] hover:underline">{row.ticker}</Link>
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
                <td className="py-3 pr-2">
                  <SixStageCell row={row} />
                </td>
              </tr>
              <EarningsStockChartDisclosure
                ticker={row.ticker}
                name={row.name}
                announceDate={row.announce_date}
                colSpan={colSpan}
              />
            </Fragment>
            )
          })}
          {hiddenNote && (
            <tr>
              <td colSpan={colSpan} className="py-3 text-center text-[11px] text-[var(--color-text-tertiary)]">
                {hiddenNote}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
    </>
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
  const completedHref = earningsHref({ date, month, filters: { ...data.filters, completed: true }, limit: data.filters.limit ?? null })
  return (
    <section className="flex min-w-0 flex-col gap-4" aria-labelledby="earnings-list-title">
      <SectionHeader
        id="earnings-list-title"
        level={1}
        title="決算発表銘柄"
        description={data.windowStart && data.windowEnd ? `${data.windowStart}〜${data.windowEnd} · J-Quants + JPX公式` : 'J-Quants + JPX公式'}
      />
      {rows.length === 0 && data.scope.totalCount === 0 ? (
        <EmptyState
          title={data.status === 'error' ? 'データを取得できませんでした' : data.status === 'stale' ? '決算カレンダーが更新されていません' : data.status === 'empty' ? '決算データがまだありません' : '該当銘柄はありません'}
          description={
            <>
              <span className="block">{data.message}</span>
              {data.latestAnnounceDate && (
                <span className="mt-1 block">登録済みの最新決算日: {data.latestAnnounceDate}</span>
              )}
              <span className="mt-1 block"><DataStatusLine data={data} /></span>
            </>
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-1 border-l-2 border-[var(--color-border-default)] pl-3">
            <p className="text-[12px] leading-relaxed text-[var(--color-text-secondary)]">{data.message}</p>
            <DataStatusLine data={data} />
          </div>
          <EarningsScopeControls data={data} date={date} month={month} />
          <div className="flex flex-col gap-5">
            {upcomingGroups.map((group) => (
              <section key={group.key} className="min-w-0" aria-label={group.label}>
                <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-default)] pb-2">
                  <h3 className="flex items-center gap-2 text-[14px] font-bold text-[var(--color-text-primary)]">
                    <span className={`h-3 w-1 rounded-[1px] ${group.tone}`} aria-hidden />
                    {group.label}
                  </h3>
                  <span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
                    {group.rows.length.toLocaleString()}銘柄
                  </span>
                </div>
                <EarningsTable
                  rows={group.rows}
                  maxRows={data.scope.displayLimit}
                  date={date}
                  month={month}
                  filters={data.filters}
                />
              </section>
            ))}
            {data.scope.filteredCount === 0 && data.scope.totalCount > 0 && (
              <EmptyState title="条件に該当する銘柄はありません" description="条件をゆるめるか、リセットしてください。" />
            )}
          </div>
        </>
      )}
      {rows.length === 0 && data.referenceRows.length > 0 && (
        <section className="min-w-0" aria-label="最新取得分（参考）">
          <h3 className="border-b border-[var(--color-border-default)] pb-2 text-[14px] font-bold text-[var(--color-text-primary)]">
            最新取得分（参考）
          </h3>
          <EarningsTable rows={data.referenceRows} maxRows={20} date={date} month={month} filters={data.filters} />
        </section>
      )}
      {completedRows.length > 0 && (
        <section className="mt-2 min-w-0" aria-labelledby="earnings-completed-title">
          <SectionHeader
            id="earnings-completed-title"
            level={1}
            title="発表後2週間の値動き"
            description="決算発表後、最初に取引があった終値を基準に、最新株価までの変化を追跡します。"
            actions={<span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">{completedRows.length.toLocaleString()}銘柄</span>}
          />
          <EarningsTable rows={completedRows} mode="completed" maxRows={30} date={date} month={month} filters={data.filters} />
        </section>
      )}
      {!includeCompleted && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-y border-[var(--color-border-soft)] py-3">
          <div className="min-w-0">
            <h3 className="text-[14px] font-bold text-[var(--color-text-primary)]">発表後2週間の値動き</h3>
            <p className="mt-0.5 text-[12px] text-[var(--color-text-tertiary)]">
              表示を軽くするため、必要な時だけ読み込みます。
            </p>
          </div>
          <Link href={completedHref} prefetch={false} className="btn">
            発表後データを読み込む
          </Link>
        </div>
      )}
    </section>
  )
}
