import type { Metadata } from 'next'
import Link from 'next/link'
import { CalendarDays } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { Card } from '@/components/ui/Card'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { StageDots } from '@/components/ui/StageDots'
import { StatStrip } from '@/components/ui/StatStrip'
import {
  isUsDailyCloseDate,
  loadUsDailyCloseReport,
  type UsDailyCloseTickerRow,
} from '@/lib/server/us-daily-close-report'

export const metadata: Metadata = {
  title: 'US Daily Close — StockBoard',
  description: '米国株の引け後概況、6ステージ変化、セクター、決算予定を既存Servingデータで確認',
}
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function money(value: number | null): string {
  return value == null ? '---' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function compactUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value)
}

const EARNINGS_TIME_LABELS = {
  before_open: '寄付前',
  market_hours: '取引時間中',
  after_close: '引け後',
  unknown: '時刻不明',
} as const

function percent(value: number | null): string {
  return value == null ? '---' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function tone(value: number | null): string {
  if (value == null || value === 0) return 'text-[var(--color-text-secondary)]'
  return value > 0 ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'
}

function LeaderTable({ title, rows, metric }: {
  title: string
  rows: UsDailyCloseTickerRow[]
  metric: 'dailyReturn' | 'volumeRatio'
}) {
  return (
    <Card size="lg" className="overflow-hidden p-0">
      <div className="border-b border-[var(--color-border-soft)] px-3 py-2 text-[12px] font-black">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[340px] text-[12px]">
          <thead className="bg-[var(--color-surface-subtle)] text-[10px] text-[var(--color-text-tertiary)]">
            <tr><th className="px-3 py-2 text-left">銘柄</th><th className="px-3 py-2 text-right">価格</th><th className="px-3 py-2 text-right">{metric === 'volumeRatio' ? '出来高倍率' : '日次'}</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.ticker} className="border-t border-[var(--color-border-soft)]">
                <td className="px-3 py-2"><Link className="font-black text-[var(--color-brand-800)] hover:underline" href={`/us/stock/${encodeURIComponent(row.ticker)}`}>{row.ticker}</Link><div className="max-w-[170px] truncate text-[10px] text-[var(--color-text-tertiary)]">{row.name}</div></td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{money(row.price)}</td>
                <td className={`px-3 py-2 text-right font-mono font-bold tabular-nums ${metric === 'dailyReturn' ? tone(row.dailyReturn) : ''}`}>{metric === 'volumeRatio' ? (row.volumeRatio == null ? '---' : `${row.volumeRatio.toFixed(2)}x`) : percent(row.dailyReturn)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export default async function UsDailyClosePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const keys = Object.keys(params)
  const rawDate = params.date
  const date = typeof rawDate === 'string' ? rawDate : null
  const invalidQuery = keys.some((key) => key !== 'date')
    || Array.isArray(rawDate)
    || (rawDate != null && !isUsDailyCloseDate(date))
  let report = null
  let loadFailed = false
  if (!invalidQuery) {
    try {
      report = await loadUsDailyCloseReport(date)
    } catch (error) {
      console.error('[us/daily-close] report unavailable', error)
      loadFailed = true
    }
  }

  return (
    <div className="sb-page">
      <PageTitle
        eyebrow="米国株・引け後"
        title="US Daily Close"
        subtitle="既存US Servingデータだけで、市場内部・6ステージ変化・セクター・決算予定を同じ基準日へ揃えます。"
        badge={report?.current ? '最新価格' : report?.asOfDate ? '指定日' : undefined}
        badgeTone={report?.current ? 'positive' : 'warning'}
        meta={report?.asOfDate ? <>
          <span>基準日 <strong>{report.asOfDate}</strong></span>
          <span>価格 <strong>調整済み優先</strong></span>
          <span>分類 <strong>Current reference</strong></span>
        </> : undefined}
        rightSlot={<Link className="btn" href="/reports/daily-close">日本株Daily Close</Link>}
      />

      <form action="/us/daily-close" className="flex flex-wrap items-end gap-2 border-b border-[var(--color-border-default)] pb-4" method="get">
        <label className="flex min-w-[190px] flex-col gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
          基準日
          <input className="input h-10" defaultValue={date ?? report?.asOfDate ?? ''} name="date" type="date" />
        </label>
        <button className="btn" data-variant="primary" type="submit">表示</button>
        {date && <Link className="btn" href="/us/daily-close">最新へ戻す</Link>}
      </form>

      {invalidQuery && <Notice role="alert" tone="error" title="クエリを読み取れません">実在する日付をYYYY-MM-DDで1つだけ指定してください。未知の条件や重複値は受け付けません。</Notice>}
      {loadFailed && <Notice
        role="alert"
        tone="error"
        title="US Daily Closeを読み込めません"
        action={<Link className="btn" data-size="sm" href={date ? `/us/daily-close?date=${encodeURIComponent(date)}` : '/us/daily-close'} prefetch={false}>再試行</Link>}
      >既存Servingデータを確認できませんでした。別ソースや推定値へフォールバックしません。</Notice>}
      {!invalidQuery && !loadFailed && report?.status === 'empty' && <EmptyState title="対象日のUS市場データがありません" description="別日へ自動置換せず、空結果として表示しています。" />}

      {report?.status === 'ready' && <>
        <StatStrip label="US市場内部" items={[
          { label: '上昇', value: report.market.advances.toLocaleString(), tone: 'up' },
          { label: '下落', value: report.market.declines.toLocaleString(), tone: 'down' },
          { label: '変わらず', value: report.market.unchanged.toLocaleString() },
          { label: '前日値欠損', value: report.market.unobserved.toLocaleString(), sub: '騰落率は未算定' },
          { label: '価格Coverage', value: `${report.coverage.pricedRows.toLocaleString()} / ${report.coverage.observedRows.toLocaleString()}` },
          { label: 'Stage完備', value: report.coverage.stagedRows.toLocaleString() },
          { label: '売買代金', value: compactUsd(report.market.adjustedTurnoverUsd), sub: '調整済み優先: 終値 × 出来高' },
        ]} />

        <section>
          <SectionHeader level={1} title="米国市場ベンチマーク" description="指数そのものではなく、既存US OHLCVにある代表ETFの調整済み終値です。" />
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {report.benchmarks.map((row) => <Card key={row.ticker} size="sm"><div className="text-[11px] text-[var(--color-text-tertiary)]">{row.label}</div><div className="mt-1 flex items-baseline justify-between gap-2"><span className="text-[16px] font-black">{row.ticker}</span><span className="font-mono text-[14px] tabular-nums">{money(row.price)}</span></div><div className={`text-right font-mono text-[12px] font-bold ${tone(row.changePct)}`}>{percent(row.changePct)}</div></Card>)}
          </div>
        </section>

        <section>
          <SectionHeader level={1} title="値動きと出来高" description="同じ基準日の母集団から上位12件を表示します。件数を減らして母集団を再定義しません。" />
          <div className="grid min-w-0 gap-3 xl:grid-cols-3">
            <LeaderTable title="上昇率" rows={report.leaders.gainers} metric="dailyReturn" />
            <LeaderTable title="下落率" rows={report.leaders.decliners} metric="dailyReturn" />
            <LeaderTable title="出来高倍率" rows={report.leaders.volumeSpikes} metric="volumeRatio" />
          </div>
        </section>

        <section>
          <SectionHeader level={1} title="6ステージ改善" description={`Stage基準日 ${report.snapshotDate ?? '未取得'}。価格基準日と異なる場合は補完せず、その日付を表示します。`} />
          {report.leaders.stageImproving.length ? <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{report.leaders.stageImproving.map((row) => <Card key={row.ticker} size="sm"><div className="flex items-start justify-between gap-2"><div><Link className="font-black text-[var(--color-brand-800)]" href={`/us/stock/${encodeURIComponent(row.ticker)}`}>{row.ticker}</Link><div className="max-w-[220px] truncate text-[10px] text-[var(--color-text-tertiary)]">{row.name}</div></div><StageDots values={Object.values(row.stages)} size={17} /></div><div className="mt-2 text-[11px] font-semibold text-[var(--color-text-secondary)]">{row.changes.join(' / ')}</div></Card>)}</div> : <EmptyState title="Stage改善はありません" description="算定可能なSnapshot間で改善方向の変化は観測されませんでした。" />}
        </section>

        <section>
          <SectionHeader level={1} title="セクター・ローテーション" description={report.current ? 'SEC SICから導出したStockBoard業種区分（SIC）の現行参照分類です。過去日の分類履歴ではありません。' : '過去日の業種分類は当時の履歴を保存していないため、集計を行いません。'} />
          {report.sectors.length ? <Card size="lg" className="overflow-hidden p-0"><div className="overflow-x-auto"><table className="w-full min-w-[620px] text-[12px]"><thead className="bg-[var(--color-surface-subtle)] text-[10px] text-[var(--color-text-tertiary)]"><tr><th className="px-3 py-2 text-left">業種区分（SIC）</th><th className="px-3 py-2 text-right">1D</th><th className="px-3 py-2 text-right">5D</th><th className="px-3 py-2 text-right">順位変化</th><th className="px-3 py-2 text-right">Coverage</th></tr></thead><tbody>{report.sectors.map((row) => <tr key={row.name} className="border-t border-[var(--color-border-soft)]"><td className="px-3 py-2 font-semibold">{row.name}</td><td className={`px-3 py-2 text-right font-mono ${tone(row.return1D)}`}>{percent(row.return1D)}</td><td className={`px-3 py-2 text-right font-mono ${tone(row.return5D)}`}>{percent(row.return5D)}</td><td className="px-3 py-2 text-right font-mono">{row.rankChange == null ? '---' : `${row.rankChange > 0 ? '+' : ''}${row.rankChange}`}</td><td className="px-3 py-2 text-right font-mono">{row.eligibleCount}/{row.totalCount}</td></tr>)}</tbody></table></div></Card> : <EmptyState title={report.current ? '分類済みのセクター集計はありません' : '過去日のセクター分類は利用できません'} description={report.current ? '分類済み銘柄が不足しているため、推定で補完していません。' : '現在の分類を過去日へ当てはめると当時と異なる結果になるため、別日の分類で補完せず集計を停止しています。'} />}
        </section>

        <section>
          <SectionHeader level={1} title="今後14日間の決算" description="正式に同期済みのFinnhub行だけを表示します。" />
          {report.earnings.status === 'unavailable' ? (
            <Notice tone="warning" title={report.current ? '決算予定を利用できません' : '履歴時点の決算予定は利用できません'}>
              {report.current
                ? 'Finnhub決算予定の同期範囲または鮮度を確認できません。予定なしとして扱わず表示を停止しています。'
                : '過去日時点で既知だったimported_atを証明できないため、現在の予定で補完せず表示を停止しています。'}
            </Notice>
          ) : report.earnings.rows.length ? <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{report.earnings.rows.map((row) => <Card key={`${row.ticker}-${row.reportDate}`} size="sm"><div className="flex items-center justify-between gap-2"><Link className="font-black text-[var(--color-brand-800)]" href={`/us/stock/${encodeURIComponent(row.ticker)}`}>{row.ticker}</Link><span className="font-mono text-[11px]">{row.reportDate}</span></div><div className="mt-1 truncate text-[10px] text-[var(--color-text-tertiary)]">{row.name ?? row.ticker} / {EARNINGS_TIME_LABELS[row.timeBucket]}</div></Card>)}</div> : <EmptyState icon={<CalendarDays size={22} />} title="同期済み決算予定はありません" description="予定を推定して補完しません。" />}
        </section>

        <div className="grid gap-3 md:grid-cols-2">
          <Notice tone="warning" title="US Ownership: UNAVAILABLE">{report.unavailable.ownership.reason}</Notice>
          <Notice tone="warning" title="US Materials / News: UNAVAILABLE">{report.unavailable.news.reason}</Notice>
        </div>

        <Notice tone="info" title="データ境界">{report.limitations.join(' ')}</Notice>
      </>}
    </div>
  )
}
