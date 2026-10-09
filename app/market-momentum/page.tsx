import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { ViewTabs } from '@/components/ui/ViewTabs'
import { StatStrip } from '@/components/ui/StatStrip'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { StageTag } from '@/components/ui/StageTag'
import { execAll, execGet } from '@/lib/db/client'
import {
  MARKET_MOMENTUM_GROUP_ORDER,
  MARKET_MOMENTUM_GROUPS,
  marketMomentumRankingHref,
  marketMomentumGroupSql,
  marketMomentumHref,
  parseMarketMomentumGroup,
  parseMarketMomentumRank,
  screenerHrefForMarketMomentumGroup,
  type MarketMomentumGroupId,
  type MarketMomentumRankId,
} from '@/lib/market-momentum-groups'

export const metadata: Metadata = {
  title: '市場モメンタム詳細 — StockBoard',
  description: '日経225、プライム、スタンダード、グロース別に初動・強い勢い・弱含み銘柄を確認',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type SummaryRow = {
  date: string | null
  count: number
  positivePms: number
  negativePms: number
  strongPms: number
  weakPms: number
  positivePfs: number
  highPes: number
}

type StockMomentumRow = {
  ticker: string
  name: string | null
  marketSegment: string | null
  marginType: string | null
  sector17Name: string | null
  sector33Name: string | null
  price: number | null
  changePct: number | null
  volume: number | null
  pms: number | null
  pfs: number | null
  pes: number | null
  dailyAStage: number | null
  dailyBStage: number | null
  weeklyAStage: number | null
  weeklyBStage: number | null
  monthlyAStage: number | null
  monthlyBStage: number | null
}

const STOCK_LIST_PAGE_SIZE = 100
const STOCK_LIST_MAX_ROWS = 500

function ratio(part: number | null | undefined, total: number | null | undefined): number | null {
  if (part == null || total == null || !Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null
  return (part / total) * 100
}

function fmtRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value.toFixed(1)}%`
}

function fmtScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toFixed(2)
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function fmtVolume(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000).toLocaleString('ja-JP')}K`
  return value.toLocaleString('ja-JP')
}

function scoreColor(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-tertiary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function statusFor(row: StockMomentumRow): { label: string; tone: 'up' | 'down' | 'warning' | 'neutral' } {
  const pms = row.pms ?? 0
  const pfs = row.pfs ?? 0
  if (pfs >= 1 && pms >= 0) return { label: '初動あり', tone: 'warning' }
  if (pms >= 1) return { label: '強い勢い', tone: 'up' }
  if (pms > 0 && pfs < 0) return { label: '失速', tone: 'down' }
  if (pms <= -1 || pfs <= -0.8) return { label: '下落警戒', tone: 'down' }
  if (pfs > 0 && pms > 0) return { label: '前向き', tone: 'up' }
  return { label: '中立', tone: 'neutral' }
}

const TONE_MARK: Record<'up' | 'down' | 'warning', string> = {
  up: 'var(--color-price-up)',
  down: 'var(--color-price-down)',
  warning: '#d97706',
}

function statusClass(tone: 'up' | 'down' | 'warning' | 'neutral'): string {
  if (tone === 'up') return 'border-[rgba(185,28,28,0.24)] bg-[var(--color-price-up-bg)] text-[var(--color-price-up)]'
  if (tone === 'down') return 'border-[rgba(30,64,175,0.24)] bg-[var(--color-price-down-bg)] text-[var(--color-price-down)]'
  if (tone === 'warning') return 'border-[rgba(217,119,6,0.24)] bg-[#fff7ed] text-[#b45309]'
  return 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]'
}

function rankMeta(rank: MarketMomentumRankId): {
  label: string
  description: string
  orderBy: string
  score: 'PFS' | 'PMS'
  tone: 'up' | 'down' | 'warning'
} {
  if (rank === 'continuation' || rank === 'strong') {
    return {
      label: '継続ランキング全件',
      description: 'PMS順。すでに勢いがあり、PFSも崩れていない銘柄を上から確認します。',
      orderBy: 'pm.physical_momentum_score DESC, pm.physical_force_score DESC, pm.symbol',
      score: 'PMS',
      tone: 'up',
    }
  }
  if (rank === 'stall') {
    return {
      label: '失速ランキング全件',
      description: 'PMSは残っていても、PFSが悪化し始めた銘柄を確認します。',
      orderBy: 'pm.physical_force_score ASC, pm.physical_momentum_score DESC, pm.symbol',
      score: 'PFS',
      tone: 'down',
    }
  }
  if (rank === 'drop' || rank === 'weak') {
    return {
      label: '下落警戒ランキング全件',
      description: 'PMS/PFS逆順。弱含み・下落警戒候補を上から確認します。',
      orderBy: 'pm.physical_momentum_score ASC, pm.physical_force_score ASC, pm.symbol',
      score: 'PMS',
      tone: 'down',
    }
  }
  return {
    label: '動き出しランキング全件',
    description: 'PFS順。短期の力が出始めている候補を上から確認します。',
    orderBy: 'pm.physical_force_score DESC, pm.physical_momentum_score DESC, pm.symbol',
    score: 'PFS',
    tone: 'warning',
  }
}

function validDateParam(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null
}

function compareDesc(a: number | null | undefined, b: number | null | undefined): number {
  const av = finiteOrNull(a)
  const bv = finiteOrNull(b)
  if (av == null && bv == null) return 0
  if (av == null) return 1
  if (bv == null) return -1
  return bv - av
}

function compareAsc(a: number | null | undefined, b: number | null | undefined): number {
  const av = finiteOrNull(a)
  const bv = finiteOrNull(b)
  if (av == null && bv == null) return 0
  if (av == null) return 1
  if (bv == null) return -1
  return av - bv
}

function byTicker(a: StockMomentumRow, b: StockMomentumRow): number {
  return a.ticker.localeCompare(b.ticker, 'ja')
}

function rankedRows(rows: StockMomentumRow[], rank: MarketMomentumRankId): StockMomentumRow[] {
  return [...rows].sort((a, b) => {
    if (rank === 'continuation' || rank === 'strong') {
      return compareDesc(a.pms, b.pms) || compareDesc(a.pfs, b.pfs) || byTicker(a, b)
    }
    if (rank === 'stall') {
      return compareAsc(a.pfs, b.pfs) || compareDesc(a.pms, b.pms) || byTicker(a, b)
    }
    if (rank === 'drop' || rank === 'weak') {
      return compareAsc(a.pms, b.pms) || compareAsc(a.pfs, b.pfs) || byTicker(a, b)
    }
    return compareDesc(a.pfs, b.pfs) || compareDesc(a.pms, b.pms) || byTicker(a, b)
  })
}

function buildSummary(date: string | null, rows: StockMomentumRow[]): SummaryRow {
  return rows.reduce<SummaryRow>(
    (acc, row) => {
      const pms = finiteOrNull(row.pms)
      const pfs = finiteOrNull(row.pfs)
      const pes = finiteOrNull(row.pes)
      acc.count += 1
      if (pms != null && pms > 0) acc.positivePms += 1
      if (pms != null && pms < 0) acc.negativePms += 1
      if (pms != null && pms >= 1) acc.strongPms += 1
      if (pms != null && pms <= -1) acc.weakPms += 1
      if (pfs != null && pfs > 0) acc.positivePfs += 1
      if (pes != null && pes >= 1) acc.highPes += 1
      return acc
    },
    {
      date,
      count: 0,
      positivePms: 0,
      negativePms: 0,
      strongPms: 0,
      weakPms: 0,
      positivePfs: 0,
      highPes: 0,
    },
  )
}

async function getMarketMomentumData(group: MarketMomentumGroupId, rank: MarketMomentumRankId, date: string | null, requestedPage: number) {
  const groupSql = marketMomentumGroupSql(
    group,
    'pm.symbol',
    "COALESCE(NULLIF(tu.market_segment, ''), '未分類')",
  )
  const dateParams = date ? [date] : []

  const latest = await execGet<{ date: string | null }>(
    `
      SELECT MAX(date) AS date
      FROM physical_momentum_metrics
      WHERE market = 'JP'
        ${date ? 'AND date <= ?' : ''}
    `,
    dateParams,
  )
  const latestDate = latest?.date ?? null
  if (!latestDate) {
    return {
      summary: buildSummary(null, []),
      initialRows: [],
      continuationRows: [],
      stallRows: [],
      dropRows: [],
      allRows: [],
      listTotal: 0,
      listPage: 1,
      listPageCount: 1,
    }
  }

  const previous = await execGet<{ date: string | null }>(
    'SELECT MAX(date) AS date FROM ohlcv_daily WHERE date < ?',
    [latestDate],
  )
  const previousDate = previous?.date ?? null

  const rows = await execAll<StockMomentumRow>(
    `
    SELECT
      pm.symbol AS ticker,
      tu.name AS name,
      tu.market_segment AS marketSegment,
      tu.margin_type AS marginType,
      tu.sector17_name AS sector17Name,
      tu.sector33_name AS sector33Name,
      cur.close AS price,
      cur.volume AS volume,
      CASE WHEN prev.close > 0 THEN 100.0 * (cur.close - prev.close) / prev.close END AS changePct,
      pm.physical_momentum_score AS pms,
      pm.physical_force_score AS pfs,
      pm.physical_energy_score AS pes,
      ds.daily_a_stage AS dailyAStage,
      ds.daily_b_stage AS dailyBStage,
      ds.weekly_a_stage AS weeklyAStage,
      ds.weekly_b_stage AS weeklyBStage,
      ds.monthly_a_stage AS monthlyAStage,
      ds.monthly_b_stage AS monthlyBStage
    FROM physical_momentum_metrics pm
    LEFT JOIN ticker_universe tu ON tu.ticker = pm.symbol
    LEFT JOIN ohlcv_daily cur ON cur.ticker = pm.symbol AND cur.date = ?
    LEFT JOIN ohlcv_daily prev ON prev.ticker = pm.symbol AND prev.date = ?
    LEFT JOIN daily_snapshots ds ON ds.ticker = pm.symbol AND ds.date = ?
    WHERE pm.market = 'JP'
      AND pm.date = ?
      AND pm.physical_momentum_score IS NOT NULL
      AND ${groupSql.sql}
    `,
    [latestDate, previousDate, latestDate, latestDate, ...groupSql.params],
  )

  const initialRows = rankedRows(rows, 'initial').slice(0, 12)
  const continuationRows = rankedRows(rows, 'continuation').slice(0, 12)
  const stallRows = rankedRows(
    rows.filter((row) => (row.pms ?? 0) > 0 && (row.pfs ?? 0) < 0),
    'stall',
  ).slice(0, 12)
  const dropRows = rankedRows(rows, 'drop').slice(0, 12)
  const ranked = rankedRows(rows, rank).slice(0, STOCK_LIST_MAX_ROWS)
  const listTotal = ranked.length
  const listPageCount = Math.max(1, Math.ceil(listTotal / STOCK_LIST_PAGE_SIZE))
  const listPage = Math.min(Math.max(1, requestedPage), listPageCount)
  const listOffset = (listPage - 1) * STOCK_LIST_PAGE_SIZE
  const allRows = ranked.slice(listOffset, listOffset + STOCK_LIST_PAGE_SIZE)

  return {
    summary: buildSummary(latestDate, rows),
    initialRows,
    continuationRows,
    stallRows,
    dropRows,
    allRows,
    listTotal,
    listPage,
    listPageCount,
  }
}

function StageStrip({ row }: { row: StockMomentumRow }) {
  const stages = [
    { label: '日A', value: row.dailyAStage },
    { label: '日B', value: row.dailyBStage },
    { label: '週A', value: row.weeklyAStage },
    { label: '週B', value: row.weeklyBStage },
    { label: '月A', value: row.monthlyAStage },
    { label: '月B', value: row.monthlyBStage },
  ]
  return (
    <div className="flex items-center gap-0.5 whitespace-nowrap" aria-label="6ステージ">
      {stages.map((stage) => (
        <span key={stage.label} className="inline-flex shrink-0 flex-col items-center" title={stage.label}>
          <StageTag stage={stage.value} size="xs" />
        </span>
      ))}
    </div>
  )
}

function RankingPanel({
  title,
  badge,
  rows,
  scoreKey,
  scoreLabel,
  tone,
  href,
}: {
  title: string
  badge: string
  rows: StockMomentumRow[]
  scoreKey: 'pms' | 'pfs' | 'pes'
  scoreLabel: string
  tone: 'up' | 'down' | 'warning'
  href: string
}) {
  return (
    <section className="panel flex min-w-0 flex-col">
      <div className="panel-head">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: TONE_MARK[tone] }} />
            {title}
          </h2>
          <p>{badge}</p>
        </div>
        <span className="text-[11px] tabular-nums text-[var(--color-text-tertiary)]">上位{rows.length}件</span>
      </div>
      <div className="flex-1 divide-y divide-[var(--color-border-soft)]">
        {rows.map((row, index) => {
          const status = statusFor(row)
          return (
            <div key={`${title}-${row.ticker}`} className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2">
              <div className="font-mono text-[12px] tabular-nums text-[var(--color-text-tertiary)]">{index + 1}</div>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <Link href={`/stock/${encodeURIComponent(row.ticker)}`} prefetch={false} className="font-mono text-[12px] font-bold text-[var(--color-brand-700)] hover:underline">
                    {row.ticker}
                  </Link>
                  <span className="truncate text-[12px] font-semibold text-[var(--color-text-primary)]">{row.name ?? row.ticker}</span>
                </div>
                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-[var(--color-text-tertiary)]">
                  <span className={`rounded-[3px] border px-1 py-px font-semibold ${statusClass(status.tone)}`}>{status.label}</span>
                  <span className="truncate">{row.sector17Name ?? '業種未分類'}</span>
                  <span>{row.marginType ?? '貸借未設定'}</span>
                </div>
              </div>
              <div className="text-right tabular-nums">
                <div className={`font-mono text-[14px] font-bold leading-tight ${scoreColor(row[scoreKey])}`}>{fmtScore(row[scoreKey])}</div>
                <div className="text-[10px] text-[var(--color-text-tertiary)]">
                  {scoreLabel} · <span className={scoreColor(row.changePct)}>{fmtPct(row.changePct)}</span>
                </div>
              </div>
            </div>
          )
        })}
        {rows.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">対象銘柄がありません</div>
        )}
      </div>
      <Link href={href} prefetch={false} className="flex min-h-9 items-center justify-center gap-1 border-t border-[var(--color-border-soft)] text-[12px] font-semibold text-[var(--color-brand-700)] hover:bg-[var(--color-surface-subtle)]">
        全件を一覧で見る
        <ChevronRight size={13} aria-hidden />
      </Link>
    </section>
  )
}

function StockListTable({ rows }: { rows: StockMomentumRow[] }) {
  return (
    <>
      <div className="panel hidden lg:block">
        <div className="table-scroll">
          <table className="w-full min-w-[1040px] border-collapse text-[12px]">
            <thead className="text-[11px]">
              <tr>
                <th className="px-3 py-2 text-left font-bold">銘柄</th>
                <th className="px-3 py-2 text-left font-bold">状態</th>
                <th className="px-3 py-2 text-left font-bold">業種</th>
                <th className="px-3 py-2 text-left font-bold">貸借</th>
                <th className="px-3 py-2 text-right font-bold">価格</th>
                <th className="px-3 py-2 text-right font-bold">日次</th>
                <th className="px-3 py-2 text-right font-bold">出来高</th>
                <th className="px-3 py-2 text-right font-bold">PMS</th>
                <th className="px-3 py-2 text-right font-bold">PFS</th>
                <th className="px-3 py-2 text-right font-bold">PES</th>
                <th className="px-3 py-2 text-left font-bold">6ステージ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {rows.map((row) => {
                const status = statusFor(row)
                return (
                  <tr key={row.ticker} className="hover:bg-[#fff8e6]">
                    <td className="px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Link href={`/stock/${encodeURIComponent(row.ticker)}`} prefetch={false} className="font-mono font-bold text-[var(--color-brand-700)] hover:underline">
                          {row.ticker}
                        </Link>
                        <span className="max-w-[200px] truncate font-semibold text-[var(--color-text-primary)]">{row.name ?? row.ticker}</span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-[var(--color-text-tertiary)]">{row.marketSegment ?? '市場未分類'}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex rounded-[3px] border px-1.5 py-0.5 text-[10px] font-bold ${statusClass(status.tone)}`}>{status.label}</span>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-[var(--color-text-secondary)]">
                      <div>{row.sector17Name ?? '---'}</div>
                      <div className="mt-0.5 text-[10px] text-[var(--color-text-tertiary)]">{row.sector33Name ?? ''}</div>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-[var(--color-text-secondary)]">{row.marginType ?? '---'}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtPrice(row.price)}</td>
                    <td className={`px-3 py-2 text-right font-mono font-bold ${scoreColor(row.changePct)}`}>{fmtPct(row.changePct)}</td>
                    <td className="px-3 py-2 text-right font-mono text-[var(--color-text-secondary)]">{fmtVolume(row.volume)}</td>
                    <td className={`px-3 py-2 text-right font-mono font-bold ${scoreColor(row.pms)}`}>{fmtScore(row.pms)}</td>
                    <td className={`px-3 py-2 text-right font-mono font-bold ${scoreColor(row.pfs)}`}>{fmtScore(row.pfs)}</td>
                    <td className={`px-3 py-2 text-right font-mono font-bold ${scoreColor(row.pes)}`}>{fmtScore(row.pes)}</td>
                    <td className="px-3 py-2"><StageStrip row={row} /></td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-3 py-8 text-center text-[12px] text-[var(--color-text-tertiary)]">
                    対象銘柄がありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ul className="panel m-0 list-none divide-y divide-[var(--color-border-soft)] p-0 lg:hidden" aria-label="銘柄一覧">
        {rows.map((row) => {
          const status = statusFor(row)
          return (
            <li key={`${row.ticker}-m`} className="px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <Link href={`/stock/${encodeURIComponent(row.ticker)}`} prefetch={false} className="font-mono text-[13px] font-bold text-[var(--color-brand-700)]">
                      {row.ticker}
                    </Link>
                    <span className={`rounded-[3px] border px-1 py-px text-[10px] font-bold ${statusClass(status.tone)}`}>{status.label}</span>
                  </div>
                  <div className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{row.name ?? row.ticker}</div>
                  <div className="truncate text-[11px] text-[var(--color-text-tertiary)]">{row.sector17Name ?? '---'} · {row.marginType ?? '---'}</div>
                </div>
                <div className="shrink-0 text-right font-mono tabular-nums">
                  <div className="text-[13px]">{fmtPrice(row.price)}</div>
                  <div className={`text-[12px] font-bold ${scoreColor(row.changePct)}`}>{fmtPct(row.changePct)}</div>
                </div>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums">
                <StageStrip row={row} />
                <span className={scoreColor(row.pms)}>PMS {fmtScore(row.pms)}</span>
                <span className={scoreColor(row.pfs)}>PFS {fmtScore(row.pfs)}</span>
                <span className={scoreColor(row.pes)}>PES {fmtScore(row.pes)}</span>
              </div>
            </li>
          )
        })}
        {rows.length === 0 && (
          <li className="px-3 py-8 text-center text-[12px] text-[var(--color-text-tertiary)]">対象銘柄がありません</li>
        )}
      </ul>
    </>
  )
}

function stockListPageHref(
  group: MarketMomentumGroupId,
  rank: MarketMomentumRankId,
  date: string | null,
  page: number,
): string {
  const base = marketMomentumRankingHref(group, rank, date).replace('#stock-list', '')
  return `${base}${base.includes('?') ? '&' : '?'}page=${page}#stock-list`
}

function StockListPagination({
  group,
  rank,
  date,
  page,
  pageCount,
}: {
  group: MarketMomentumGroupId
  rank: MarketMomentumRankId
  date: string | null
  page: number
  pageCount: number
}) {
  if (pageCount <= 1) return null
  return (
    <nav aria-label="銘柄一覧ページ" className="mt-3 flex items-center justify-center gap-2">
      <Link
        href={stockListPageHref(group, rank, date, Math.max(1, page - 1))}
        prefetch={false}
        aria-disabled={page <= 1}
        className={`btn ${page <= 1 ? 'pointer-events-none' : ''}`}
      >
        <ChevronLeft size={14} aria-hidden />
        前へ
      </Link>
      <span className="min-w-[72px] text-center font-mono text-[12px] tabular-nums text-[var(--color-text-secondary)]">
        {page} / {pageCount}
      </span>
      <Link
        href={stockListPageHref(group, rank, date, Math.min(pageCount, page + 1))}
        prefetch={false}
        aria-disabled={page >= pageCount}
        className={`btn ${page >= pageCount ? 'pointer-events-none' : ''}`}
      >
        次へ
        <ChevronRight size={14} aria-hidden />
      </Link>
    </nav>
  )
}

export default async function MarketMomentumPage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string | string[]; rank?: string | string[]; date?: string | string[]; page?: string | string[] }>
}) {
  const sp = await searchParams
  const groupId = parseMarketMomentumGroup(sp.group)
  const rankId = parseMarketMomentumRank(sp.rank)
  const requestedDate = validDateParam(sp.date)
  const rawPage = Array.isArray(sp.page) ? sp.page[0] : sp.page
  const requestedPage = Math.max(1, Number.parseInt(rawPage ?? '1', 10) || 1)
  const group = MARKET_MOMENTUM_GROUPS[groupId]
  const activeRank = rankMeta(rankId)
  const { summary, initialRows, continuationRows, stallRows, dropRows, allRows, listTotal, listPage, listPageCount } = await getMarketMomentumData(groupId, rankId, requestedDate, requestedPage)
  const count = Number(summary?.count ?? 0)
  const pmsPlus = ratio(summary?.positivePms ?? 0, count)
  const pfsPlus = ratio(summary?.positivePfs ?? 0, count)
  const strong = ratio(summary?.strongPms ?? 0, count)
  const weak = ratio(summary?.weakPms ?? 0, count)
  const first = listTotal > 0 ? (listPage - 1) * STOCK_LIST_PAGE_SIZE + 1 : 0
  const last = listTotal > 0 ? first + allRows.length - 1 : 0
  const activeRankKey = rankId === 'strong' ? 'continuation' : rankId === 'weak' ? 'drop' : rankId

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageTitle
        eyebrow="市場・業種"
        title={`${group.label}のモメンタム`}
        subtitle={group.description}
        meta={<>
          <span>基準日 <strong className="font-semibold text-[var(--color-text-primary)]">{summary?.date ?? '—'}</strong> 大引け</span>
          <span>対象 <strong className="font-semibold text-[var(--color-text-primary)]">{count.toLocaleString('ja-JP')}</strong>銘柄（PMS算出済み）</span>
        </>}
        rightSlot={<>
          <Link href={screenerHrefForMarketMomentumGroup(groupId, { date: requestedDate, sort: 'physicalForceScore', dir: 'desc', pfsMin: 0 })} prefetch={false} className="btn">
            スクリーナーで開く
          </Link>
          <Link href={`/hex-stage${requestedDate ? `?date=${requestedDate}` : ''}`} prefetch={false} className="btn">
            6ステージで見る
          </Link>
          <Link href="/" prefetch={false} className="btn" data-variant="ghost">
            ダッシュボードへ
          </Link>
        </>}
      >
        <ViewTabs
          label="市場区分"
          current={groupId}
          items={MARKET_MOMENTUM_GROUP_ORDER.filter((id) => id !== 'unclassified').map((id) => ({
            key: id,
            label: MARKET_MOMENTUM_GROUPS[id].shortLabel,
            href: marketMomentumHref(id, requestedDate),
          }))}
        />
      </PageTitle>

      <div>
        <StatStrip
          label="モメンタムの分布"
          items={[
            { label: 'PMSプラス', value: fmtRatio(pmsPlus), sub: `${(summary?.positivePms ?? 0).toLocaleString('ja-JP')} / ${count.toLocaleString('ja-JP')}銘柄`, tone: 'up' },
            { label: '初動プラス（PFS > 0）', value: fmtRatio(pfsPlus), sub: `${(summary?.positivePfs ?? 0).toLocaleString('ja-JP')}銘柄` },
            { label: '強い勢い（PMS ≥ +1）', value: fmtRatio(strong), sub: `${(summary?.strongPms ?? 0).toLocaleString('ja-JP')}銘柄`, tone: 'up' },
            { label: '弱い・失速（PMS ≤ −1）', value: fmtRatio(weak), sub: `${(summary?.weakPms ?? 0).toLocaleString('ja-JP')}銘柄`, tone: 'down' },
          ]}
        />
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">
          初動はPFS、勢いはPMS、値動きの熱量はPESで見ます。売買判断ではなく、次にチャートで確認する銘柄を絞り込むための一覧です。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-4">
        <RankingPanel
          title="初動あり"
          badge="PFS順 · 力が出始めた候補"
          rows={initialRows}
          scoreKey="pfs"
          scoreLabel="PFS"
          tone="warning"
          href={marketMomentumRankingHref(groupId, 'initial', requestedDate)}
        />
        <RankingPanel
          title="継続"
          badge="PMS順 · 勢いが続く候補"
          rows={continuationRows}
          scoreKey="pms"
          scoreLabel="PMS"
          tone="up"
          href={marketMomentumRankingHref(groupId, 'continuation', requestedDate)}
        />
        <RankingPanel
          title="失速"
          badge="PFS悪化 · 勢いの鈍化候補"
          rows={stallRows}
          scoreKey="pfs"
          scoreLabel="PFS"
          tone="down"
          href={marketMomentumRankingHref(groupId, 'stall', requestedDate)}
        />
        <RankingPanel
          title="下落警戒"
          badge="PMS逆順 · 弱含み・警戒候補"
          rows={dropRows}
          scoreKey="pms"
          scoreLabel="PMS"
          tone="down"
          href={marketMomentumRankingHref(groupId, 'drop', requestedDate)}
        />
      </div>

      <section id="stock-list" className="min-w-0 scroll-mt-36">
        <SectionHeader
          level={1}
          title={activeRank.label}
          description={activeRank.description}
          actions={
            <span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
              {first.toLocaleString()}–{last.toLocaleString()} / {listTotal.toLocaleString()}件（上位最大{STOCK_LIST_MAX_ROWS}件）
            </span>
          }
        />
        <ViewTabs
          className="mb-3"
          label="ランキングの種類"
          current={activeRankKey}
          items={([
            ['initial', '動き出し'],
            ['continuation', '継続'],
            ['stall', '失速'],
            ['drop', '下落警戒'],
          ] as const).map(([key, label]) => ({
            key,
            label,
            href: marketMomentumRankingHref(groupId, key, requestedDate),
          }))}
        />
        <StockListTable rows={allRows} />
        <StockListPagination group={groupId} rank={rankId} date={requestedDate} page={listPage} pageCount={listPageCount} />
      </section>
    </div>
  )
}
