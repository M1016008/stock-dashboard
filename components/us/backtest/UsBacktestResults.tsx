'use client'

// components/us/backtest/UsBacktestResults.tsx
//
// 検証結果の一覧。1024px 以上は table-fixed の表 (横スクロールなし)、未満は 1 銘柄 1 行のリスト。
// - 列: 銘柄 / 6ステージ / シグナル / 基準日 (終値・出来高倍率) / 結果 (期間騰落・到達) / 最大上昇・下落 / 到達日数
// - 行の「詳細」で detail を展開 (aria-expanded / aria-controls)。表とリストは同時に描かない
// - 再取得中は直前の結果を薄く残し、高さを保ったまま更新する

import Link from 'next/link'
import { Fragment, useId, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { fmtUsd, usStockHref } from '@/components/us/UsMarketMomentumParts'
import { HitFlags, Missing, SignalChips, SignedPct, StageRow } from '@/components/us/backtest/UsBacktestParts'
import { UsBacktestDetail } from '@/components/us/backtest/UsBacktestDetail'
import {
  CONTROL,
  FOCUS_RING,
  MUTED_TEXT,
  SORT_OPTIONS,
  STAGE_AXIS_LABELS,
  fmtCount,
  fmtRatio,
  type UsBacktestMove,
  type UsBacktestQueryResponse,
  type UsBacktestResult,
  type UsBacktestSort,
} from '@/components/us/backtest/usBacktestShared'

const DESKTOP_QUERY = '(min-width: 1024px)'

function subscribeDesktop(onChange: () => void) {
  const media = window.matchMedia(DESKTOP_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP_QUERY).matches, () => true)
}

export function UsBacktestResults({
  data,
  loading,
  error,
  onRetry,
  sort,
  onSortChange,
  onPageChange,
  expanded,
  onToggle,
  detailMove,
  hasFilters,
  onResetFilters,
}: {
  data: UsBacktestQueryResponse | null
  loading: boolean
  error: string | null
  onRetry: () => void
  sort: UsBacktestSort
  onSortChange: (sort: UsBacktestSort) => void
  onPageChange: (page: number) => void
  expanded: string | null
  onToggle: (ticker: string) => void
  detailMove: UsBacktestMove
  hasFilters: boolean
  onResetFilters: () => void
}) {
  const titleId = useId()
  const sortId = useId()
  const isDesktop = useIsDesktop()
  const pagination = data?.pagination
  const from = pagination && pagination.total > 0 ? (pagination.page - 1) * pagination.pageSize + 1 : 0
  const to = pagination ? Math.min(pagination.total, pagination.page * pagination.pageSize) : 0
  const rows = data?.results ?? []

  return (
    <section className="panel" aria-labelledby={titleId}>
      <div className="panel-head">
        <div className="min-w-0">
          <h3 id={titleId}>検証結果</h3>
          <p className="font-mono tabular-nums">
            {data?.date
              ? <>基準日 {data.date} · {data.horizon}営業日 · {fmtCount(pagination?.total ?? 0)}件{pagination && pagination.total > 0 ? `中 ${fmtCount(from)}–${fmtCount(to)}` : ''}</>
              : <span className="font-sans">基準日を選ぶと結果を表示します</span>}
          </p>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className={`min-w-[52px] text-right text-[11px] ${MUTED_TEXT}`} role="status" aria-live="polite">{loading ? '更新中…' : ''}</span>
          <label htmlFor={sortId} className={`whitespace-nowrap text-[11px] ${MUTED_TEXT}`}>並び順</label>
          <select id={sortId} value={sort} onChange={(event) => onSortChange(event.target.value as UsBacktestSort)} className={`${CONTROL} w-[156px]`}>
            {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </div>

      {error ? (
        <div className="p-3">
          <Notice
            tone="error"
            role="alert"
            title="検証結果を取得できませんでした"
            action={<button type="button" onClick={onRetry} className={`btn ${FOCUS_RING}`} data-size="sm">再試行</button>}
          >
            {error}
          </Notice>
        </div>
      ) : data == null ? (
        <SkeletonRows />
      ) : rows.length === 0 ? (
        <EmptyState
          className="py-10"
          title={hasFilters ? '条件に一致する銘柄はありません' : 'この基準日の検証結果はありません'}
          description={hasFilters ? '条件を緩めるか、別の基準日・検証期間を選んでください。' : '別の基準日または検証期間を選んでください。'}
          action={hasFilters ? <button type="button" onClick={onResetFilters} className={`btn ${FOCUS_RING}`} data-size="sm">条件をリセット</button> : undefined}
        />
      ) : (
        <div className={`transition-opacity ${loading ? 'opacity-55' : ''}`} aria-busy={loading}>
          {isDesktop
            ? <ResultsTable rows={rows} expanded={expanded} onToggle={onToggle} detailMove={detailMove} />
            : <ResultsList rows={rows} expanded={expanded} onToggle={onToggle} detailMove={detailMove} />}
        </div>
      )}

      {!error && pagination && pagination.totalPages > 1 && (
        <nav aria-label="ページ送り" className="flex items-center justify-between gap-2 border-t border-[var(--color-border-soft)] px-3 py-2 text-[11px] sm:px-4">
          <span className={`font-mono tabular-nums ${MUTED_TEXT}`}>{pagination.page} / {pagination.totalPages} ページ</span>
          <span className="flex items-center gap-1">
            <PageButton disabled={loading || pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)}>
              <ChevronLeft size={14} aria-hidden />前へ
            </PageButton>
            <PageButton disabled={loading || pagination.page >= pagination.totalPages} onClick={() => onPageChange(pagination.page + 1)}>
              次へ<ChevronRight size={14} aria-hidden />
            </PageButton>
          </span>
        </nav>
      )}
    </section>
  )
}

type ListProps = {
  rows: UsBacktestResult[]
  expanded: string | null
  onToggle: (ticker: string) => void
  detailMove: UsBacktestMove
}

const TH = 'px-2 py-1.5 align-bottom text-[11px] font-semibold'

function detailId(row: UsBacktestResult): string {
  return `us-bt-detail-${row.ticker.replace(/[^A-Za-z0-9]/g, '_')}`
}

function ResultsTable({ rows, expanded, onToggle, detailMove }: ListProps) {
  return (
    <table className="w-full table-fixed border-collapse text-[12px]">
      <caption className="sr-only">検証結果。各行の「詳細」でチャートとシグナル根拠を表示します。</caption>
      <thead className="border-b border-[var(--color-border-default)] text-[var(--color-text-secondary)]">
        <tr>
          <th scope="col" className={`${TH} pl-3 text-left`}>銘柄</th>
          <th scope="col" className={`${TH} w-[132px] text-left`}>
            <span className="block">6ステージ</span>
            <span className="mt-0.5 flex gap-0.5 text-[9px] font-normal text-[var(--color-text-tertiary)]" aria-hidden>
              {STAGE_AXIS_LABELS.map((axis) => <span key={axis} className="w-[18px] text-center">{axis}</span>)}
            </span>
          </th>
          <th scope="col" className={`${TH} w-[160px] text-left xl:w-[220px]`}>シグナル</th>
          <th scope="col" className={`${TH} w-[96px] text-right`}>
            <span className="block">基準日終値</span>
            <span className="block text-[9px] font-normal text-[var(--color-text-tertiary)]">出来高倍率</span>
          </th>
          <th scope="col" className={`${TH} w-[124px] text-right`}>
            <span className="block">期間騰落</span>
            <span className="block text-[9px] font-normal text-[var(--color-text-tertiary)]">+10/20/40% 到達</span>
          </th>
          <th scope="col" className={`${TH} w-[104px] text-right`}>
            <span className="block">最大上昇</span>
            <span className="block">最大下落</span>
          </th>
          <th scope="col" className={`${TH} w-[92px] text-right`}>
            <span className="block">到達日数</span>
            <span className="block text-[9px] font-normal text-[var(--color-text-tertiary)]">営業日</span>
          </th>
          <th scope="col" className={`${TH} w-[76px] pr-3 text-right`}><span className="sr-only">詳細</span></th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[var(--color-border-soft)]">
        {rows.map((row) => {
          const open = expanded === row.ticker
          return (
            <Fragment key={row.ticker}>
              <tr className={`align-middle ${open ? 'bg-[var(--color-brand-50)]' : 'hover:bg-[var(--color-surface-subtle)]'}`}>
                <td className="min-w-0 py-1.5 pl-3 pr-2"><TickerCell row={row} /></td>
                <td className="px-2 py-1.5"><StageRow stages={row.stages} /></td>
                <td className="min-w-0 px-2 py-1.5"><SignalChips codes={row.signalCodes} max={3} /></td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                  <span className="block text-[var(--color-text-primary)]">{row.close == null ? <Missing /> : fmtUsd(row.close)}</span>
                  <span className={`block text-[10px] ${MUTED_TEXT}`}>{fmtRatio(row.volumeRatio20) ?? <Missing />}</span>
                </td>
                <td className="px-2 py-1.5 text-right">
                  <SignedPct value={row.returnPct} className="block font-semibold" />
                  <span className="mt-0.5 block"><HitFlags hits={[[10, row.hit10], [20, row.hit20], [40, row.hit40]]} /></span>
                </td>
                <td className="px-2 py-1.5 text-right">
                  <Excursion label="上" value={row.maxReturnPct} />
                  <Excursion label="下" value={row.minReturnPct} />
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                  <Timing label="上" days={row.daysToMax} date={row.maxReturnDate} />
                  <Timing label="下" days={row.daysToMin} date={row.minReturnDate} />
                </td>
                <td className="py-1.5 pl-2 pr-3 text-right">
                  <DetailButton row={row} open={open} onToggle={onToggle} />
                </td>
              </tr>
              {open && (
                <tr>
                  <td colSpan={8} className="border-t border-[var(--color-brand-100)] p-0">
                    <UsBacktestDetail row={row} initialMove={detailMove} id={detailId(row)} />
                  </td>
                </tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function ResultsList({ rows, expanded, onToggle, detailMove }: ListProps) {
  return (
    <ol className="m-0 list-none divide-y divide-[var(--color-border-soft)] p-0" aria-label="検証結果">
      {rows.map((row) => {
        const open = expanded === row.ticker
        return (
          <li key={row.ticker} className="min-w-0">
            <div className={`flex min-w-0 flex-col gap-2 px-3 py-2.5 sm:px-4 ${open ? 'bg-[var(--color-brand-50)]' : ''}`}>
              <div className="flex min-w-0 items-start justify-between gap-2">
                <TickerCell row={row} />
                <DetailButton row={row} open={open} onToggle={onToggle} />
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <StageRow stages={row.stages} />
                <SignalChips codes={row.signalCodes} max={3} />
              </div>
              <dl className="m-0 grid min-w-0 grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-4">
                <CardFact label="基準日終値">
                  <span className="block font-mono tabular-nums text-[var(--color-text-primary)]">{row.close == null ? <Missing /> : fmtUsd(row.close)}</span>
                  <span className={`block font-mono text-[10px] tabular-nums ${MUTED_TEXT}`}>出来高 {fmtRatio(row.volumeRatio20) ?? <Missing />}</span>
                </CardFact>
                <CardFact label={`期間騰落（${row.horizonDays}営業日）`}>
                  <SignedPct value={row.returnPct} className="block font-semibold" />
                  <span className="mt-0.5 block"><HitFlags hits={[[10, row.hit10], [20, row.hit20], [40, row.hit40]]} /></span>
                </CardFact>
                <CardFact label="最大上昇">
                  <SignedPct value={row.maxReturnPct} className="block" />
                  <span className={`block font-mono text-[10px] tabular-nums ${MUTED_TEXT}`}>{row.daysToMax == null ? '日数 —' : `${row.daysToMax}営業日目`}</span>
                </CardFact>
                <CardFact label="最大下落">
                  <SignedPct value={row.minReturnPct} className="block" />
                  <span className={`block font-mono text-[10px] tabular-nums ${MUTED_TEXT}`}>{row.daysToMin == null ? '日数 —' : `${row.daysToMin}営業日目`}</span>
                </CardFact>
              </dl>
            </div>
            {open && (
              <div className="border-t border-[var(--color-brand-100)]">
                <UsBacktestDetail row={row} initialMove={detailMove} id={detailId(row)} />
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function TickerCell({ row }: { row: UsBacktestResult }) {
  return (
    <Link
      href={usStockHref(row.ticker, row.date)}
      prefetch={false}
      className={`group block min-w-0 rounded-[2px] leading-tight ${FOCUS_RING}`}
    >
      <span className="block font-mono text-[13px] font-bold text-[var(--color-brand-700)] group-hover:underline">{row.ticker}</span>
      <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-secondary)]" title={row.name ?? undefined}>
        {row.name ?? <span className={MUTED_TEXT}>名称未取得</span>}
      </span>
    </Link>
  )
}

function DetailButton({ row, open, onToggle }: { row: UsBacktestResult; open: boolean; onToggle: (ticker: string) => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? detailId(row) : undefined}
      aria-label={`${row.ticker} の詳細を${open ? '閉じる' : '開く'}`}
      onClick={() => onToggle(row.ticker)}
      className={`inline-flex h-7 shrink-0 items-center gap-0.5 rounded-[4px] border px-2 text-[11px] font-semibold ${FOCUS_RING} ${
        open
          ? 'border-[var(--color-brand-700)] bg-white text-[var(--color-brand-800)]'
          : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)]'
      }`}
    >
      <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      {open ? '閉じる' : '詳細'}
    </button>
  )
}

function Excursion({ label, value }: { label: '上' | '下'; value: number | null }) {
  return (
    <span className="flex items-baseline justify-end gap-1">
      <span className={`text-[9px] ${MUTED_TEXT}`} aria-hidden>{label}</span>
      <span className="sr-only">{label === '上' ? '最大上昇' : '最大下落'}</span>
      <SignedPct value={value} />
    </span>
  )
}

function Timing({ label, days, date }: { label: '上' | '下'; days: number | null; date: string | null }) {
  return (
    <span className="flex items-baseline justify-end gap-1" title={date ? `${label === '上' ? '最大上昇' : '最大下落'}日 ${date}` : undefined}>
      <span className={`font-sans text-[9px] ${MUTED_TEXT}`} aria-hidden>{label}</span>
      <span className="sr-only">{label === '上' ? '最大上昇まで' : '最大下落まで'}</span>
      {days == null ? <Missing /> : <span className="text-[var(--color-text-primary)]">{days}</span>}
    </span>
  )
}

function CardFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={`truncate text-[10px] ${MUTED_TEXT}`}>{label}</dt>
      <dd className="m-0 min-w-0 text-[12px]">{children}</dd>
    </div>
  )
}

function PageButton({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-0.5 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
    >
      {children}
    </button>
  )
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-[var(--color-border-soft)]" aria-hidden>
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex h-[52px] items-center gap-4 px-3">
          <span className="h-3 w-24 animate-pulse rounded-[3px] bg-[var(--color-surface-muted)]" />
          <span className="h-3 w-28 animate-pulse rounded-[3px] bg-[var(--color-surface-muted)]" />
          <span className="h-3 flex-1 animate-pulse rounded-[3px] bg-[var(--color-surface-muted)]" />
        </div>
      ))}
    </div>
  )
}
