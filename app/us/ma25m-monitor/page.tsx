'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowDownToLine, ArrowUpFromLine, ChevronLeft, ChevronRight, LoaderCircle, RotateCcw } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { StageDots } from '@/components/ui/StageDots'
import { StatStrip } from '@/components/ui/StatStrip'

type MonitorRow = {
  ticker: string
  name: string
  exchange: string | null
  sector: string | null
  industry: string | null
  period: number
  date: string
  close: number
  maValue: number
  distancePct: number
  absDistancePct: number
  distance5dPct: number | null
  distance10dPct: number | null
  isApproaching: boolean
  approachDirection: 'above' | 'below' | 'none'
  approachSpeedPctPerDay: number
  isTouch: boolean
  lastTouchDate: string | null
  touchAgeSessions: number | null
  lastCrossDate: string | null
  lastCrossDirection: 'up' | 'down' | null
  crossAgeSessions: number | null
  approachScore: number
  isRapidApproach: boolean
  currentVolume: number | null
  avgVolume20: number | null
  volumeRatio20: number | null
  dailyAStage: number | null
  dailyBStage: number | null
  weeklyAStage: number | null
  weeklyBStage: number | null
  monthlyAStage: number | null
  monthlyBStage: number | null
  historyWindowStartDate: string
  historyWindowSessions: number
  historyTruncated: boolean
}

type MonitorResponse = {
  market: 'US'
  date: string
  periods: number[]
  unavailablePeriods: number[]
  rows: MonitorRow[]
  total: number
  offset: number
  limit: number
  contactThreshold: number
  summary: {
    monitored: number
    signals: number
    approaching: number
    contact: number
    touch5: number
    cross5: number
    rapid: number
  }
  filterOptions: { exchanges: string[]; sectors: string[] }
  coverage: {
    activeUniverse: number
    sourceTickers: number
    eligibleTickers: number
    missingTickers: number
    missingByPeriod: Record<string, number>
    historyStartDate: string | null
    historySessions: number
  }
  source: {
    definitionVersion: string
    priceBasis: string
    sourceGeneration: number | null
    sourceNames: string[]
    calendar: string
    classificationBasis: string
  }
  limitations: string[]
}

const PERIODS = [
  ['all', 'すべて'],
  ['3', '3M'],
  ['5', '5M'],
  ['10', '10M'],
  ['15', '15M'],
  ['20', '20M'],
  ['25', '25M'],
] as const

const STATUSES = [
  ['signals', '重要シグナル'],
  ['all', '全観測'],
  ['approaching', '接近中'],
  ['contact', '接触圏'],
  ['touch_5', '5日以内タッチ'],
  ['cross_up', '5日以内上抜け'],
  ['cross_down', '5日以内下抜け'],
  ['rapid', '急接近'],
] as const

const SORTS = [
  ['score', '接近スコア'],
  ['distance', '距離が近い'],
  ['speed', '接近速度'],
  ['ticker', 'Ticker'],
] as const

function price(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 10 ? 2 : 0,
    maximumFractionDigits: value < 10 ? 4 : 2,
  }).format(value)
}

function pct(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function compact(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function age(value: number | null): string {
  if (value == null) return '範囲内なし'
  return value === 0 ? '本日' : `${value}営業日前`
}

function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  children: React.ReactNode
}) {
  return (
    <label className="grid min-w-0 gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
      {label}
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className="h-9 min-w-0 px-2 text-[12px]">
        {children}
      </select>
    </label>
  )
}

function StageCell({ row }: { row: MonitorRow }) {
  const groups = [
    ['日', row.dailyAStage, row.dailyBStage],
    ['週', row.weeklyAStage, row.weeklyBStage],
    ['月', row.monthlyAStage, row.monthlyBStage],
  ] as const
  return (
    <div className="flex flex-wrap gap-2">
      {groups.map(([label, first, second]) => (
        <div key={label}>
          <div className="mb-0.5 text-[9px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
          <StageDots values={[first, second]} size={16} />
        </div>
      ))}
    </div>
  )
}

function SignalBadges({ row, contactThreshold }: { row: MonitorRow; contactThreshold: number }) {
  const badges: string[] = []
  if (row.crossAgeSessions === 0) badges.push(row.lastCrossDirection === 'up' ? '上抜け' : '下抜け')
  if (row.touchAgeSessions === 0) badges.push('本日タッチ')
  if (row.absDistancePct <= contactThreshold) badges.push(`±${contactThreshold}%圏`)
  if (row.isApproaching) badges.push(row.approachDirection === 'above' ? '上から接近' : '下から接近')
  if (row.isRapidApproach) badges.push('急接近')
  if (!badges.length) badges.push('観測')
  return (
    <div className="flex flex-wrap gap-1">
      {badges.map((badge) => (
        <span key={badge} className="inline-flex h-5 items-center rounded-[3px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-1.5 text-[9px] font-bold text-[var(--color-text-secondary)]">
          {badge}
        </span>
      ))}
    </div>
  )
}

export default function UsMonthlyMaMonitorPage() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [data, setData] = useState<MonitorResponse | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [pending, startTransition] = useTransition()
  const requestSequence = useRef(0)
  const queryString = searchParams.toString()
  const period = PERIODS.some(([value]) => value === searchParams.get('period')) ? searchParams.get('period')! : 'all'
  const status = STATUSES.some(([value]) => value === searchParams.get('status')) ? searchParams.get('status')! : 'signals'
  const exchange = searchParams.get('exchange') ?? ''
  const sector = searchParams.get('sector') ?? ''
  const sort = SORTS.some(([value]) => value === searchParams.get('sort')) ? searchParams.get('sort')! : 'score'
  const q = searchParams.get('q') ?? ''
  const offset = Math.floor(Math.max(0, Number(searchParams.get('offset') ?? 0) || 0))
  const [queryDraft, setQueryDraft] = useState(q)

  useEffect(() => setQueryDraft(q), [q])
  useEffect(() => {
    const controller = new AbortController()
    const sequence = ++requestSequence.current
    setLoading(true)
    setError('')
    setData(null)
    fetch(`/api/us/ma25m-monitor?${queryString}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json()
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
        return payload as MonitorResponse
      })
      .then((payload) => {
        if (sequence === requestSequence.current) setData(payload)
      })
      .catch((reason) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) return
        setData(null)
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!controller.signal.aborted && sequence === requestSequence.current) setLoading(false)
      })
    return () => controller.abort()
  }, [queryString])

  const update = (changes: Record<string, string | null>, resetOffset = true) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(changes)) {
      if (value == null || value === '' || value === 'all' || (key === 'status' && value === 'signals')) next.delete(key)
      else next.set(key, value)
    }
    if (resetOffset) next.delete('offset')
    startTransition(() => router.replace(next.size ? `${pathname}?${next}` : pathname, { scroll: false }))
  }

  const summary = useMemo(() => [
    { label: '監視銘柄', value: data?.summary.monitored.toLocaleString() ?? '—' },
    { label: '重要シグナル', value: data?.summary.signals.toLocaleString() ?? '—' },
    { label: '接近中', value: data?.summary.approaching.toLocaleString() ?? '—' },
    { label: '接触圏', value: data?.summary.contact.toLocaleString() ?? '—' },
    { label: '5日タッチ', value: data?.summary.touch5.toLocaleString() ?? '—' },
    { label: '5日クロス', value: data?.summary.cross5.toLocaleString() ?? '—' },
  ], [data])
  const rows = data?.rows ?? []
  const limit = data?.limit ?? 100
  const total = data?.total ?? 0
  const busy = loading || pending

  return (
    <div className="page-shell section-stack">
      <PageTitle
        eyebrow="米国株・テクニカル"
        title="月足MAモニター"
        subtitle="調整済み日足と米国営業日列から、月足MAへの接近・接触・クロスを確認します。"
        badge="US"
        meta={data ? `基準日 ${data.date} · Generation ${data.source.sourceGeneration ?? '未確認'} · ${data.source.priceBasis}` : '読込中'}
        rightSlot={<Link href="/ma25m-monitor" className="btn">日本株版</Link>}
      />

      <Notice tone="neutral" title="15か月線の計算基準">
        3・5・10・15・20・25か月線を表示します。15か月線は当日Snapshotの10か月線と10か月前の完了月末Snapshotの5か月線から算出します。当月は形成中として当日の調整終値を含み、必要な値が欠ける場合は補完せず未計算にします。
      </Notice>

      <StatStrip items={summary} label="月足MA監視サマリー" />

      <section className="panel p-3" aria-label="絞り込み">
        <form
          className="grid gap-3 lg:grid-cols-[minmax(180px,1.4fr)_110px_150px_150px_180px_auto]"
          onSubmit={(event) => { event.preventDefault(); update({ q: queryDraft }) }}
        >
          <label className="grid gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            Ticker・社名
            <input value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} placeholder="AAPL / Apple" className="h-9 px-2 text-[12px]" />
          </label>
          <SelectField label="月足MA" value={period} onChange={(value) => update({ period: value })}>
            {PERIODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </SelectField>
          <SelectField label="状態" value={status} onChange={(value) => update({ status: value })}>
            {STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </SelectField>
          <SelectField label="取引所" value={exchange} onChange={(value) => update({ exchange: value })}>
            <option value="">すべて</option>
            {(data?.filterOptions.exchanges ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
          </SelectField>
          <SelectField label="Sector" value={sector} onChange={(value) => update({ sector: value })}>
            <option value="">すべて</option>
            {(data?.filterOptions.sectors ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
          </SelectField>
          <div className="flex items-end gap-2">
            <button type="submit" className="btn btn-primary">検索</button>
            <button type="button" className="btn" onClick={() => { setQueryDraft(''); update({ q: null, period: null, status: null, exchange: null, sector: null, sort: null }) }} aria-label="条件をリセット">
              <RotateCcw size={14} aria-hidden />
            </button>
          </div>
        </form>
        <div className="mt-3 w-full max-w-[220px]">
          <SelectField label="並び順" value={sort} onChange={(value) => update({ sort: value })}>
            {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </SelectField>
        </div>
      </section>

      {error && <Notice tone="error" role="alert" title="米国株MAデータを読み込めませんでした">{error}</Notice>}

      <section className="panel" aria-label="米国株月足MA監視結果">
        <div className="flex min-h-11 items-center justify-between gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]" aria-live="polite">
          <span className="inline-flex items-center gap-1.5">
            {busy && <LoaderCircle size={14} className="animate-spin" aria-hidden />}
            {busy ? '更新中…' : total ? `${offset + 1}–${Math.min(offset + limit, total)} / ${total.toLocaleString()}件` : '0件'}
          </span>
          <span className="text-[11px]">履歴開始 {data?.coverage.historyStartDate ?? '—'} · {data?.coverage.historySessions ?? 0}営業日</span>
        </div>

        <div className="hidden table-scroll lg:block">
          <table className="w-full min-w-[1050px] table-fixed border-collapse text-[11px]">
            <thead>
              <tr>
                {['銘柄', '6ステージ', '月足MA', '終値・乖離', '接近', '出来高', 'タッチ・クロス', 'スコア'].map((label) => (
                  <th key={label} className="border-b border-[var(--color-border-default)] px-2 py-2 text-left">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.ticker}-${row.period}`} className="border-b border-[var(--color-border-soft)] align-top hover:bg-[var(--color-surface-subtle)]">
                  <td className="px-2 py-2">
                    <Link href={`/us/stock/${encodeURIComponent(row.ticker)}#chart`} className="font-mono text-[12px] font-bold text-[var(--color-brand-700)] hover:underline">{row.ticker}</Link>
                    <div className="max-w-[180px] truncate font-semibold" title={row.name}>{row.name}</div>
                    <div className="max-w-[180px] truncate text-[10px] text-[var(--color-text-tertiary)]">{[row.exchange, row.sector].filter(Boolean).join(' · ') || '分類未登録'}</div>
                  </td>
                  <td className="px-2 py-2"><StageCell row={row} /></td>
                  <td className="px-2 py-2"><strong className="font-mono text-[12px]">{row.period}M</strong><div>{price(row.maValue)}</div></td>
                  <td className="px-2 py-2 text-right"><strong>{price(row.close)}</strong><div className={row.distancePct >= 0 ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'}>{pct(row.distancePct)}</div><small>5日 {pct(row.distance5dPct)} / 10日 {pct(row.distance10dPct)}</small></td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-1 font-semibold">{row.isApproaching ? row.approachDirection === 'above' ? <ArrowDownToLine size={13} aria-hidden /> : <ArrowUpFromLine size={13} aria-hidden /> : null}{row.isApproaching ? row.approachDirection === 'above' ? '上から' : '下から' : '方向なし'}</div>
                    <div className="font-mono text-[10px]">{pct(row.approachSpeedPctPerDay, 3)}/日</div>
                    <SignalBadges row={row} contactThreshold={data?.contactThreshold ?? 2} />
                  </td>
                  <td className="px-2 py-2 text-right"><strong>{compact(row.currentVolume)}</strong><div className="text-[10px]">20日 {compact(row.avgVolume20)}</div><div>{row.volumeRatio20 == null ? '—' : `${row.volumeRatio20.toFixed(2)}倍`}</div></td>
                  <td className="px-2 py-2"><div>タッチ {age(row.touchAgeSessions)}</div><div>{row.lastCrossDirection === 'up' ? '上抜け' : row.lastCrossDirection === 'down' ? '下抜け' : 'クロス'} {age(row.crossAgeSessions)}</div></td>
                  <td className="px-2 py-2 text-center"><span className="inline-flex h-9 min-w-11 items-center justify-center rounded-[4px] bg-[var(--color-brand-800)] px-1 font-mono text-[14px] font-bold text-white">{row.approachScore.toFixed(1)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ul className="m-0 list-none divide-y divide-[var(--color-border-soft)] p-0 lg:hidden">
          {rows.map((row) => (
            <li key={`${row.ticker}-${row.period}-mobile`} className="px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/us/stock/${encodeURIComponent(row.ticker)}#chart`} className="font-mono text-[13px] font-bold text-[var(--color-brand-700)]">{row.ticker}</Link>
                  <div className="truncate text-[13px] font-semibold">{row.name}</div>
                  <div className="truncate text-[10px] text-[var(--color-text-tertiary)]">{row.sector ?? '分類未登録'}</div>
                </div>
                <span className="rounded-[4px] bg-[var(--color-brand-800)] px-2 py-1 font-mono font-bold text-white">{row.approachScore.toFixed(1)}</span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                <div><small>{row.period}M MA</small><strong className="block">{price(row.maValue)}</strong></div>
                <div className="text-right"><small>終値</small><strong className="block">{price(row.close)}</strong></div>
                <div className="text-right"><small>乖離</small><strong className="block">{pct(row.distancePct)}</strong></div>
              </div>
              <div className="mt-2"><StageCell row={row} /></div>
              <div className="mt-2"><SignalBadges row={row} contactThreshold={data?.contactThreshold ?? 2} /></div>
            </li>
          ))}
        </ul>

        {!busy && rows.length === 0 && <EmptyState title="該当銘柄はありません" description="状態や月足MAの条件を変更してください。" />}
        <nav aria-label="ページ送り" className="flex items-center justify-between border-t border-[var(--color-border-soft)] px-3 py-2">
          <button type="button" className="btn" disabled={offset <= 0} onClick={() => update({ offset: String(Math.max(0, offset - limit)) }, false)}><ChevronLeft size={14} aria-hidden />前へ</button>
          <span className="font-mono text-[12px]">{total ? `${offset + 1}–${Math.min(offset + limit, total)} / ${total}` : '0件'}</span>
          <button type="button" className="btn" disabled={offset + limit >= total} onClick={() => update({ offset: String(offset + limit) }, false)}>次へ<ChevronRight size={14} aria-hidden /></button>
        </nav>
      </section>

      {data && (
        <Notice tone="neutral" title="Coverage・Lineage">
          Active {data.coverage.activeUniverse.toLocaleString()} / 計算可能 {data.coverage.eligibleTickers.toLocaleString()}銘柄。Source: {data.source.sourceNames.join(', ') || '未確認'}、Calendar: {data.source.calendar}。{data.limitations.join(' ')}
        </Notice>
      )}
    </div>
  )
}

