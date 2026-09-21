'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Search, X } from 'lucide-react'
import { EVENT_LABEL, RANKING_LABEL, date, exactYen, pct, positionUnits, yen,
  type ActivityRow, type BasisFilter,
  type OverviewResponse, type PagedResponse, type PeriodFilter, type RankingRow,
  type RankingType } from '@/lib/large-holders/ui'
import { AsOfLine, CLASS_OPTIONS, ClassBadge, CompletenessBadge, HolderDisclaimer, HolderError,
  HolderFetchError, HolderPageHeader, HolderSkeleton, Segmented, TablePager, TableScroll,
  holderFetch, numeric, td, th } from './LargeHoldersShared'

const RANKING_OPTIONS: { value: RankingType; label: string }[] = [
  { value: 'TOTAL_VALUE', label: '推定時価保有総額' }, { value: 'RECENT_INCREASE', label: '最近の買増' },
  { value: 'NEW_5PCT', label: '新規5%' }, { value: 'DECREASE', label: '保有減少' },
]
const PERIOD_OPTIONS: { value: PeriodFilter; label: string }[] = [
  { value: '7D', label: '7日' }, { value: '30D', label: '30日' },
  { value: '90D', label: '90日' }, { value: '1Y', label: '1年' },
]
const selectClass = 'min-h-9 max-w-full border border-[var(--border-subtle)] bg-white px-2 text-[13px]'
const labelClass = 'flex min-w-0 flex-col gap-1 text-[12px] text-[var(--color-text-secondary)]'

function safeEnum<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback
}

export function LargeHoldersClient({ mode }: { mode: 'dashboard' | 'rankings' | 'activity' }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const query = searchParams.toString()
  const investorClass = safeEnum(searchParams.get('investorClass'),
    ['ALL', 'INDIVIDUAL', 'INSTITUTIONAL', 'OTHER', 'UNCLASSIFIED'] as const, 'ALL')
  const rankingType = safeEnum(searchParams.get('rankingType'),
    ['TOTAL_VALUE', 'RECENT_INCREASE', 'NEW_5PCT', 'DECREASE'] as const, 'TOTAL_VALUE')
  const basis = safeEnum(searchParams.get('basis'),
    ['OWNERSHIP', 'INVESTMENT_AUTHORITY'] as const, 'OWNERSHIP')
  const period = safeEnum(searchParams.get('period'), ['7D', '30D', '90D', '1Y'] as const, '30D')
  const page = Number(searchParams.get('page')) > 0 ? Number(searchParams.get('page')) : 1
  const pageSize = safeEnum(searchParams.get('pageSize'), ['20', '50', '100'] as const, '50')
  const completeness = safeEnum(searchParams.get('completeness'),
    ['ALL', 'COMPLETE', 'PARTIAL', 'NONE'] as const, 'ALL')
  const [overview, setOverview] = useState<OverviewResponse | null>(null)
  const [data, setData] = useState<PagedResponse<RankingRow> | PagedResponse<ActivityRow> | null>(null)
  const [error, setError] = useState<HolderFetchError | Error | null>(null)
  const [overviewError, setOverviewError] = useState<HolderFetchError | Error | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [searchDraft, setSearchDraft] = useState(searchParams.get('search') ?? '')
  const [suggestions, setSuggestions] = useState<RankingRow[]>([])
  const [selectedActivity, setSelectedActivity] = useState<ActivityRow | null>(null)

  const update = useCallback((changes: Record<string, string | null>) => {
    const next = new URLSearchParams(query)
    for (const [key, value] of Object.entries(changes)) {
      if (value == null || value === '') next.delete(key)
      else next.set(key, value)
    }
    if (!('page' in changes)) next.delete('page')
    router.push(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false })
  }, [pathname, query, router])

  useEffect(() => { setSearchDraft(searchParams.get('search') ?? '') }, [searchParams])

  useEffect(() => {
    const term = searchDraft.trim()
    if (term.length < 2) { setSuggestions([]); return }
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      holderFetch<PagedResponse<RankingRow>>(`/api/large-holders/investors?search=${encodeURIComponent(term)}&pageSize=5`, controller.signal)
        .then((result) => { if (!controller.signal.aborted) setSuggestions(result.rows) })
        .catch(() => { if (!controller.signal.aborted) setSuggestions([]) })
    }, 250)
    return () => { window.clearTimeout(timeout); controller.abort() }
  }, [searchDraft])

  useEffect(() => {
    const controller = new AbortController()
    holderFetch<OverviewResponse>('/api/large-holders/overview', controller.signal)
      .then((result) => { setOverview(result); setOverviewError(null) })
      .catch((cause: unknown) => { if (!controller.signal.aborted) { setOverview(null); setOverviewError(cause as Error) } })
    return () => controller.abort()
  }, [retryKey])

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams(query)
    const endpoint = mode === 'activity' ? '/api/large-holders/activity' : '/api/large-holders/rankings'
    setData(null)
    setError(null)
    holderFetch<PagedResponse<RankingRow> | PagedResponse<ActivityRow>>(`${endpoint}?${params}`, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setData(result) })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause as Error) })
    return () => controller.abort()
  }, [mode, query, retryKey])

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    update({ search: searchDraft.trim() })
  }
  const meta = data ?? overview
  const isActivity = mode === 'activity'
  const activityResponse = isActivity ? data as PagedResponse<ActivityRow> | null : null
  const rankingResponse = !isActivity ? data as PagedResponse<RankingRow> | null : null

  return <div className="min-w-0 space-y-5">
    <HolderPageHeader title={mode === 'dashboard' ? '大口投資家 Intelligence'
      : mode === 'rankings' ? '大口投資家ランキング' : '保有変化'}
      subtitle="大量保有報告書から、直近開示の保有状況と変化を確認" />

    {overviewError ? <HolderError error={overviewError} retry={() => setRetryKey((key) => key + 1)} />
      : overview && <section className="space-y-3">
        <AsOfLine meta={overview} />
        {mode === 'dashboard' && <div className="flex flex-wrap gap-x-8 gap-y-2 border-b border-[var(--border-subtle)] pb-3">
          <SummaryNumber label="公開評価可能Position" value={overview.publicCurrentValuationReadyCount} />
          <SummaryNumber label="投資家" value={overview.investorCount} />
          <SummaryNumber label="個人" value={overview.investorClassCounts.INDIVIDUAL} />
          <SummaryNumber label="機関" value={overview.investorClassCounts.INSTITUTIONAL} />
          <span className="self-end text-[12px] text-[var(--color-text-secondary)]">NEW {overview.activityCounts.NEW_5PCT} / 買増 {overview.activityCounts.INCREASE} / 減少 {overview.activityCounts.DECREASE}</span>
        </div>}
      </section>}

    <section className="space-y-3" aria-label="表示条件">
      <Segmented label="投資家種別" value={investorClass} options={CLASS_OPTIONS}
        onChange={(next) => update({ investorClass: next, basis: next === 'INDIVIDUAL' ? 'OWNERSHIP' : basis })} />
      {!isActivity && <Segmented label="ランキング種別" value={rankingType} options={RANKING_OPTIONS}
        onChange={(next) => update({ rankingType: next })} />}
      <div className="flex flex-wrap items-end gap-3">
        {investorClass === 'INSTITUTIONAL' && !isActivity && <Segmented label="評価の法的基準" value={basis}
          options={[{ value: 'OWNERSHIP', label: '所有等ベース' }, { value: 'INVESTMENT_AUTHORITY', label: '運用権限ベース' }]}
          onChange={(next) => update({ basis: next })} />}
        {(!isActivity && rankingType !== 'TOTAL_VALUE' || isActivity) && <label className={labelClass}>期間
          <select className={selectClass} value={isActivity ? searchParams.get('period') ?? '30D' : period}
            onChange={(event) => update({ period: event.target.value })}>
            {PERIOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            {isActivity && <option value="ALL">全期間</option>}
          </select></label>}
        {isActivity && <label className={labelClass}>変化
          <select className={selectClass} value={searchParams.get('eventType') ?? 'ALL'} onChange={(event) => update({ eventType: event.target.value })}>
            {[['ALL', 'すべて'], ['NEW_5PCT', 'NEW 5%'], ['INCREASE', '買増'], ['DECREASE', '減少'], ['EXIT_5PCT', '5%割れ']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>}
        {mode === 'rankings' && <>
          <label className={labelClass}>算定状況
            <select className={selectClass} value={completeness} onChange={(event) => update({ completeness: event.target.value })}>
              {[['ALL', 'すべて'], ['COMPLETE', '完全算定'], ['PARTIAL', '一部算定'], ['NONE', '算定不可']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
          <label className={labelClass}>並び順
            <select className={selectClass} value={searchParams.get('sort') ?? 'value_desc'} onChange={(event) => update({ sort: event.target.value })}>
              {[['value_desc', '金額の大きい順'], ['value_asc', '金額の小さい順'], ['name_asc', '名前順'], ['latest_filing_desc', '報告が新しい順']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
        </>}
        {isActivity && <label className={labelClass}>並び順
          <select className={selectClass} value={searchParams.get('sort') ?? 'obligation_desc'} onChange={(event) => update({ sort: event.target.value })}>
            <option value="obligation_desc">義務日が新しい順</option><option value="filing_desc">提出日が新しい順</option><option value="value_desc">時価換算の大きい順</option>
          </select></label>}
        {mode !== 'dashboard' && overview && <>
          <Facet label="市場" name="market" values={overview.markets} current={searchParams.get('market')} update={update} />
          <Facet label="17業種" name="industry17" values={overview.industries17} current={searchParams.get('industry17')} update={update} />
          <Facet label="33業種" name="industry33" values={overview.industries33} current={searchParams.get('industry33')} update={update} />
        </>}
        <form onSubmit={submitSearch} className="relative flex items-end gap-1">
          <label className={labelClass}>{isActivity ? '投資家名・銘柄検索' : '投資家名検索'}
            <input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="投資家名"
              className={`${selectClass} w-44`} maxLength={100} /></label>
          <button type="submit" aria-label="検索" title="検索" className="flex h-9 w-9 items-center justify-center border border-[var(--border-subtle)]"><Search size={16} /></button>
          {suggestions.length > 0 && <div aria-label="投資家候補" className="absolute left-0 top-full z-30 mt-1 w-[min(320px,calc(100vw-32px))] border border-[var(--border-subtle)] bg-white shadow-md">
            {suggestions.map((suggestion) => <Link key={suggestion.investorEntityId} href={`/large-holders/investors/${encodeURIComponent(suggestion.investorEntityId)}`}
              className="block border-b border-[var(--border-subtle)] px-3 py-2 text-[13px] hover:bg-slate-50">{suggestion.displayName}</Link>)}
          </div>}
        </form>
        {mode !== 'dashboard' && <label className={labelClass}>表示件数
          <select className={selectClass} value={pageSize} onChange={(event) => update({ pageSize: event.target.value })}>
            <option value="20">20</option><option value="50">50</option><option value="100">100</option>
          </select></label>}
      </div>
      {investorClass === 'INSTITUTIONAL' && basis === 'INVESTMENT_AUTHORITY' && !isActivity && <p className="text-[12px] text-[var(--color-text-secondary)]">運用権限に基づく推定時価であり、当該機関の自己資金による投資額を示すものではありません。</p>}
    </section>

    <section className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[17px] font-semibold">{isActivity ? '開示による保有変化' : RANKING_LABEL[rankingType]}</h2>
        {mode === 'dashboard' && <Link href={`/large-holders/rankings${query ? `?${query}` : ''}`} className="text-[13px] text-[var(--color-brand-600)]">詳しい条件で見る →</Link>}
      </div>
      {!isActivity && <p className="text-[12px] text-[var(--color-text-secondary)]">{basis === 'OWNERSHIP' ? '所有等ベース' : '運用権限ベース'} · 算定可能な認定Positionのみ</p>}
      {error ? <HolderError error={error} retry={() => setRetryKey((key) => key + 1)} />
        : !data ? <HolderSkeleton />
          : data.total === 0 ? <p className="border-y border-[var(--border-subtle)] py-10 text-center text-[13px] text-[var(--color-text-secondary)]">
            {isActivity ? 'この条件に該当する大量保有報告はありません' : 'この条件に該当する投資家はいません'}
          </p>
            : isActivity ? <><div className="md:hidden"><MobileActivityList rows={activityResponse!.rows} select={setSelectedActivity} /></div>
                <div className="hidden md:block"><ActivityTable rows={activityResponse!.rows} select={setSelectedActivity} /></div></>
              : <><div className="md:hidden"><MobileRankingList rows={rankingResponse!.rows} rankingType={rankingType} /></div>
                <div className="hidden md:block"><RankingTable rows={rankingResponse!.rows} rankingType={rankingType} basis={basis} page={data.page} pageSize={data.pageSize} /></div></>}
      {data && data.total > 0 && <TablePager page={data.page} totalPages={data.totalPages} total={data.total} go={(next) => update({ page: String(next) })} />}
      {meta && <AsOfLine meta={meta} />}
    </section>
    <HolderDisclaimer />
    {selectedActivity && <ActivityDrawer event={selectedActivity} close={() => setSelectedActivity(null)} />}
  </div>
}

function SummaryNumber({ label, value }: { label: string; value: number }) {
  return <div className="min-w-24"><div className="text-[12px] text-[var(--color-text-secondary)]">{label}</div><div className="text-[20px] font-semibold tabular-nums">{value.toLocaleString('ja-JP')}</div></div>
}

function Facet({ label, name, values, current, update }: { label: string; name: string; values: string[];
  current: string | null; update: (changes: Record<string, string | null>) => void }) {
  return <label className={labelClass}>{label}<select className={selectClass} value={current ?? ''}
    onChange={(event) => update({ [name]: event.target.value })}>
    <option value="">すべて</option>{values.map((value) => <option key={value} value={value}>{value}</option>)}
  </select></label>
}

function RankingTable({ rows, rankingType, basis, page, pageSize }: {
  rows: RankingRow[]; rankingType: RankingType; basis: BasisFilter; page: number; pageSize: number
}) {
  const total = rankingType === 'TOTAL_VALUE'
  const newFive = rankingType === 'NEW_5PCT'
  return <TableScroll><table className="min-w-[900px] w-full border-collapse text-left">
    <thead><tr>{(total ? ['順位', '投資家', '種別', '推定時価保有総額', '算定状況', '保有銘柄数', '最大保有銘柄', '最大単一銘柄時価', '最大保有比率', '直近報告', '最近の動き']
      : newFive ? ['順位', '投資家', '種別', '銘柄', '新規保有比率', '保有株数/口数', '推定現在時価', '報告日']
        : ['順位', '投資家', '種別', '対象銘柄数', '件数', rankingType === 'DECREASE' ? '減少株式の現在時価換算' : '増加株式の現在時価換算', '直近日']).map((label) => <th key={label} className={th}>{label}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={row.investorEntityId + (row.documentId ?? '')} className="hover:bg-slate-50">
      <td className={`${td} text-[var(--color-text-secondary)]`}>{total && row.rankingValue == null ? '—' : (page - 1) * pageSize + index + 1}</td>
      <td className={td}><Link className="font-semibold text-[var(--color-brand-600)] hover:underline" href={`/large-holders/investors/${encodeURIComponent(row.investorEntityId)}`}>{row.displayName ?? row.investorName}</Link></td>
      <td className={td}><ClassBadge investorClass={row.investorClass} investorType={row.investorType} /></td>
      {total ? <>
        <td className={`${td} ${numeric} font-semibold`} title={exactYen(row.rankingValue)}>{yen(row.rankingValue)}</td>
        <td className={td}><CompletenessBadge completeness={row.selectedPortfolioCompleteness ?? row.portfolioCompleteness}
          valued={row.selectedValuedPositionCount ?? row.valuedPositionCount} total={row.selectedPositionCount ?? row.totalRelevantPositionCount} /></td>
        <td className={`${td} ${numeric}`}>{row.selectedPositionCount ?? row.totalRelevantPositionCount}</td>
        <td className={td}>{row.rankingLargestPositionTicker ? <Link href={`/stock/${row.rankingLargestPositionTicker}`} className="text-[var(--color-brand-600)]">{row.rankingLargestPositionTicker}</Link> : '—'}</td>
        <td className={`${td} ${numeric}`}>{yen(row.rankingLargestPositionValue)}</td>
        <td className={`${td} ${numeric}`}>{pct(row.largestHoldingPct)}</td>
        <td className={td}>{date(row.latestFilingDate)}</td>
        <td className={td}>{row.latestActivityType ? `${EVENT_LABEL[row.latestActivityType]} ${date(row.latestActivityDate)}` : '—'}</td>
      </> : newFive ? <>
        <td className={td}><Link href={`/stock/${row.ticker}`} className="text-[var(--color-brand-600)]">{row.ticker} {row.issuerName}</Link></td>
        <td className={`${td} ${numeric}`}>{pct(row.reportedHoldingPct)}</td>
        <td className={`${td} ${numeric}`}>{row.reportedShares == null ? '—' : positionUnits(row.reportedShares, { ticker: row.ticker ?? '', issuerName: row.issuerName ?? null })}</td>
        <td className={`${td} ${numeric}`} title={exactYen(row.estimatedCurrentValue)}>{yen(row.estimatedCurrentValue)}</td>
        <td className={td}>{date(row.filingDate)}</td>
      </> : <>
        <td className={`${td} ${numeric}`}>{row.tickerCount ?? '—'}</td>
        <td className={`${td} ${numeric}`}>{row.activityCount ?? '—'}</td>
        <td className={`${td} ${numeric} font-semibold`} title={exactYen(row.currentValueEquivalent)}>{yen(row.currentValueEquivalent)}</td>
        <td className={td}>{date(row.latestActivityDate)}</td>
      </>}
    </tr>)}</tbody>
  </table>{basis === 'INVESTMENT_AUTHORITY' && total && <p className="px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">運用権限ベース。所有等ベースとは合算していません。</p>}</TableScroll>
}

function ActivityTable({ rows, select }: { rows: ActivityRow[]; select: (event: ActivityRow) => void }) {
  return <TableScroll><table className="min-w-[1030px] w-full border-collapse text-left">
    <thead><tr>{['義務日', '変化', '投資家', '種別', '銘柄', '保有比率', '前回', '差', '保有数量', '数量差', '現在時価換算', '元報告'].map((label) => <th key={label} className={th}>{label}</th>)}</tr></thead>
    <tbody>{rows.map((row) => <tr key={`${row.documentId}:${row.investorEntityId}:${row.ticker}`} className="cursor-pointer hover:bg-slate-50" onClick={() => select(row)}>
      <td className={td}>{date(row.obligationDate)}</td><td className={td}><span className="font-semibold">{EVENT_LABEL[row.eventType]}</span></td>
      <td className={td}><Link onClick={(event) => event.stopPropagation()} className="text-[var(--color-brand-600)]" href={`/large-holders/investors/${encodeURIComponent(row.investorEntityId)}`}>{row.investorName}</Link></td>
      <td className={td}><ClassBadge investorClass={row.investorClass} investorType={row.investorType} /></td>
      <td className={td}><Link onClick={(event) => event.stopPropagation()} className="text-[var(--color-brand-600)]" href={`/stock/${row.ticker}`}>{row.ticker} {row.issuerName}</Link></td>
      <td className={`${td} ${numeric}`}>{pct(row.reportedHoldingPct)}</td>
      <td className={`${td} ${numeric}`}>{pct(row.previousHoldingPct)}</td>
      <td className={`${td} ${numeric}`}>{pct(row.holdingPctDelta)}</td>
      <td className={`${td} ${numeric}`}>{positionUnits(row.reportedShares, row)}</td>
      <td className={`${td} ${numeric}`}>{positionUnits(row.sharesDelta, row)}</td>
      <td className={`${td} ${numeric}`} title={exactYen(row.currentValueEquivalent)}>{yen(row.currentValueEquivalent)}</td>
      <td className={td}><button type="button" onClick={(event) => { event.stopPropagation(); select(row) }} className="text-[var(--color-brand-600)] hover:underline">理由を見る</button></td>
    </tr>)}</tbody>
  </table></TableScroll>
}

function MobileRankingList({ rows, rankingType }: { rows: RankingRow[]; rankingType: RankingType }) {
  return <div className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)] bg-white">
    {rows.map((row) => {
      const value = rankingType === 'TOTAL_VALUE' ? row.rankingValue
        : rankingType === 'NEW_5PCT' ? row.estimatedCurrentValue : row.currentValueEquivalent
      return <div key={row.investorEntityId + (row.documentId ?? '')} className="px-2 py-2.5">
        <div className="flex items-start justify-between gap-2"><Link className="min-w-0 break-words font-semibold text-[var(--color-brand-600)]" href={`/large-holders/investors/${encodeURIComponent(row.investorEntityId)}`}>{row.displayName ?? row.investorName}</Link>
          <span className="shrink-0 text-right font-semibold tabular-nums" title={exactYen(value)}>{yen(value)}</span></div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--color-text-secondary)]"><ClassBadge investorClass={row.investorClass} investorType={row.investorType} />
          {rankingType === 'TOTAL_VALUE' ? <><span>{row.totalRelevantPositionCount}銘柄</span><CompletenessBadge completeness={row.portfolioCompleteness} valued={row.valuedPositionCount} total={row.totalRelevantPositionCount} />
            {row.latestActivityType && <span>{EVENT_LABEL[row.latestActivityType]}</span>}</>
            : <><span>{row.ticker ?? `${row.tickerCount ?? 0}銘柄`}</span><span>{date(row.filingDate ?? row.latestActivityDate)}</span></>}
        </div>
      </div>
    })}
  </div>
}

function MobileActivityList({ rows, select }: { rows: ActivityRow[]; select: (event: ActivityRow) => void }) {
  return <div className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)] bg-white">
    {rows.map((row) => <button key={`${row.documentId}:${row.investorEntityId}:${row.ticker}`} type="button" onClick={() => select(row)} className="block w-full px-2 py-2.5 text-left">
      <div className="flex items-start justify-between gap-2"><span className="min-w-0 break-words font-semibold">{row.investorName}</span><span className="shrink-0 font-semibold tabular-nums">{yen(row.currentValueEquivalent)}</span></div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-[var(--color-text-secondary)]"><span>{EVENT_LABEL[row.eventType]}</span><span>{row.ticker} {row.issuerName}</span><span>{pct(row.reportedHoldingPct)}</span><span>{date(row.obligationDate)}</span></div>
    </button>)}
  </div>
}

function ActivityDrawer({ event, close }: { event: ActivityRow; close: () => void }) {
  useEffect(() => {
    const onKey = (keyboardEvent: KeyboardEvent) => { if (keyboardEvent.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])
  return <div className="fixed inset-0 z-[80] flex justify-end bg-black/30" onClick={close}>
    <aside role="dialog" aria-modal="true" aria-label="保有変化の詳細" onClick={(event_) => event_.stopPropagation()}
      className="h-full w-full max-w-[480px] overflow-y-auto bg-white p-5 shadow-xl">
      <div className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
        <div><div className="text-[12px] font-semibold text-[var(--color-text-secondary)]">{EVENT_LABEL[event.eventType]}</div><h2 className="text-[19px] font-semibold">{event.investorName}</h2><p className="text-[13px]">{event.ticker} {event.issuerName}</p></div>
        <button type="button" onClick={close} aria-label="閉じる"><X size={20} /></button>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
        <Datum label="前回保有比率" value={pct(event.previousHoldingPct)} /><Datum label="今回保有比率" value={pct(event.reportedHoldingPct)} />
        <Datum label="保有比率差" value={pct(event.holdingPctDelta)} /><Datum label="保有数量" value={positionUnits(event.reportedShares, event)} />
        <Datum label="数量差" value={positionUnits(event.sharesDelta, event)} /><Datum label="保有の法的基準" value={event.holdingBasis === 'OWNERSHIP' ? '所有等' : event.holdingBasis === 'INVESTMENT_AUTHORITY' ? '運用権限' : 'その他'} />
        <Datum label="現在時価換算" value={yen(event.currentValueEquivalent)} /><Datum label="提出日" value={date(event.filingDate)} />
        <Datum label="報告義務日" value={date(event.obligationDate)} /><Datum label="同一書類の他主体" value={event.fellowNames.length ? event.fellowNames.join('、') : 'なし'} />
      </dl>
      <section className="mt-6 border-t border-[var(--border-subtle)] pt-4 text-[13px]"><h3 className="font-semibold">開示原本</h3>
        <p className="mt-2">EDINET {event.documentId} · {event.sourceVerified ? '原本照合済み' : '確認中'}</p>
        {event.filingSourceUrl && <a href={event.filingSourceUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-[var(--color-brand-600)] hover:underline">元報告を開く ↗</a>}
      </section>
    </aside>
  </div>
}

function Datum({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[12px] text-[var(--color-text-secondary)]">{label}</dt><dd className="mt-0.5 font-medium tabular-nums">{value}</dd></div>
}
