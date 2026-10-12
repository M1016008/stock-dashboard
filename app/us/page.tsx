import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense, cache } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  ChevronRight,
  Database,
  ListFilter,
} from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { StageTag } from '@/components/ui/StageTag'
import { UsAnalysisNav } from '@/components/us/UsAnalysisNav'
import { UsDashboardDateSelector, UsDashboardShell } from '@/components/us/UsDashboardShell'
import { UsHistoricalBanner } from '@/components/us/UsHistoricalBanner'
import {
  US_DASHBOARD_SECTION_META,
  UsDashboardSectionFallback,
  type UsDashboardSectionId,
} from '@/components/us/UsDashboardSkeletons'
import { DashboardWorkspace } from '@/components/dashboard/DashboardWorkspace'
import { DashboardTradeSignalTable, loadDashboardTradeSignals } from '@/components/dashboard/DashboardTradeSignalTable'
import { DashboardHistoricalUnavailable } from '@/components/dashboard/DashboardHistoricalUnavailable'
import { AgendaSkeleton, MarketStateSkeleton } from '@/components/dashboard/DashboardSectionFallback'
import {
  GroupLabel,
  MeterBar,
  TONE_FILL,
  TONE_TEXT,
  signedTextClass,
  type DashboardTone,
} from '@/components/dashboard/DashboardPrimitives'
import { StockPreviewTrigger } from '@/components/stock-preview/StockPreviewTrigger'
import { STAGE_LABELS } from '@/lib/hex-stage'
import { execAll } from '@/lib/db/client'
import { execUsAnalyticsAll, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { getUsDashboardAsOfState } from '@/lib/queries/dashboard-as-of'
import { getUsStatusSummary } from '@/lib/us-status'
import { getUsSecondaryName } from '@/lib/us-symbol-aliases'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export const metadata: Metadata = {
  title: '米国株ダッシュボード — StockBoard',
  description: '米国株の価格、ステージ、ランキング、ML連携状況を確認します。',
}

function fmt(value: number | null | undefined) {
  return Number(value ?? 0).toLocaleString('ja-JP')
}

function fmtMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

function fmtPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtRatio(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value.toFixed(1)}%`
}

function fmtScore(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`
}

/** 出来高は日本株の一覧と同じく万・億で縮める (単位は株) */
function fmtVolume(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}億`
  if (value >= 10_000) return `${Math.round(value / 10_000).toLocaleString('ja-JP')}万`
  return Math.round(value).toLocaleString('ja-JP')
}

function ratio(count: number, total: number): number | null {
  return total > 0 ? (count / total) * 100 : null
}

/** 表示している日付を引き継いでスクリーナーを開く (最新表示のときは日付を付けない) */
function usScreenerHref(params: Record<string, string>, date: string | null): string {
  const search = new URLSearchParams(params)
  if (date) search.set('date', date)
  return `/us/screener?${search.toString().replace(/%2C/g, ',')}`
}

function usStockHref(ticker: string, date: string | null, hash = ''): string {
  return `/us/stock/${encodeURIComponent(ticker)}${date ? `?date=${encodeURIComponent(date)}` : ''}${hash}`
}

type RankingRow = {
  ticker: string
  name: string | null
  exchange: string | null
  price: number | null
  change_pct: number | null
  volume: number | null
  stage_code: string | null
}

type StageSummaryRow = {
  label: string
  count: number
}

type MlCandidateRow = {
  ticker: string
  name: string | null
  rank: number
  candidate_score: number
  physical_momentum_score: number | null
  physical_force_score: number | null
  stage_code: string | null
  as_of_date: string | null
}

type PmsSummaryRow = {
  total: number
  positive: number
  negative: number
  average_pms: number | null
  average_pfs: number | null
  date: string | null
}

async function getUsDashboardRows(date: string | null) {
  if (!date) {
    return {
      gainers: [] as RankingRow[],
      losers: [] as RankingRow[],
      volume: [] as RankingRow[],
      stageSummary: [] as StageSummaryRow[],
      mlUp: [] as MlCandidateRow[],
      mlDown: [] as MlCandidateRow[],
      pmsSummary: null as PmsSummaryRow | null,
    }
  }
  const rankingSql = (orderBy: string) => `
    WITH prev_date AS (
      SELECT MAX(date) AS date
      FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx
      WHERE market = 'US' AND date < ?
    ),
    ranked AS (
      SELECT
        cur.ticker,
        COALESCE(cur.adj_close, cur.close) AS price,
        COALESCE(cur.adj_volume, cur.volume) AS volume,
        CASE
          WHEN COALESCE(cur.adj_volume, cur.volume) > 0
           AND COALESCE(prev.adj_volume, prev.volume) > 0
           AND COALESCE(prev.adj_close, prev.close) > 0
          THEN 100.0 * (
            COALESCE(cur.adj_close, cur.close) - COALESCE(prev.adj_close, prev.close)
          ) / COALESCE(prev.adj_close, prev.close)
        END AS change_pct
      FROM market_ohlcv_daily cur INDEXED BY market_ohlcv_market_date_ticker_idx
      LEFT JOIN market_ohlcv_daily prev INDEXED BY market_ohlcv_market_ticker_date_idx
        ON prev.market = 'US'
       AND prev.ticker = cur.ticker
       AND prev.date = (SELECT date FROM prev_date)
      WHERE cur.market = 'US'
        AND cur.date = ?
        AND COALESCE(cur.adj_close, cur.close) >= 0.1
        AND COALESCE(cur.adj_volume, cur.volume) > 0
        AND COALESCE(prev.adj_close, prev.close) > 0
        AND ABS(100.0 * (
          COALESCE(cur.adj_close, cur.close) - COALESCE(prev.adj_close, prev.close)
        ) / COALESCE(prev.adj_close, prev.close)) <= 100
        AND EXISTS (
          SELECT 1
          FROM market_universe quality_universe
          WHERE quality_universe.market = 'US'
            AND quality_universe.ticker = cur.ticker
            AND COALESCE(quality_universe.asset_type, 'Stock') = 'Stock'
            AND ${usInvestableSymbolSql('quality_universe.ticker')}
            AND NOT (
              LENGTH(quality_universe.ticker) >= 5
              AND SUBSTR(quality_universe.ticker, -1, 1) IN ('W', 'U', 'R')
            )
        )
      ORDER BY ${orderBy}, cur.ticker ASC
      LIMIT 8
    )
    SELECT
      r.ticker,
      COALESCE(u.name, r.ticker) AS name,
      u.exchange,
      r.price,
      r.volume,
      r.change_pct,
      s.daily_a_stage || s.daily_b_stage || s.weekly_a_stage || s.weekly_b_stage || s.monthly_a_stage || s.monthly_b_stage AS stage_code
    FROM ranked r
    LEFT JOIN market_universe u ON u.market = 'US' AND u.ticker = r.ticker
    LEFT JOIN market_daily_snapshots s INDEXED BY market_snapshots_market_date_ticker_idx
      ON s.market = 'US'
     AND s.date = ?
     AND s.ticker = r.ticker
  `
  const candidateSql = `
    WITH latest_candidate AS (
      SELECT MAX(as_of_date) AS date FROM serving_ml_physics_candidates WHERE as_of_date <= ?
    ),
    latest_metric AS (
      SELECT MAX(date) AS date FROM physical_momentum_metrics WHERE market = 'US' AND date <= ?
    )
    SELECT
      c.ticker,
      COALESCE(c.name, u.name, c.ticker) AS name,
      c.rank,
      c.candidate_score,
      pm.physical_momentum_score,
      pm.physical_force_score,
      f.stage_code,
      c.as_of_date AS as_of_date
    FROM serving_ml_physics_candidates c
    INNER JOIN ticker_universe u
      ON u.ticker = c.ticker
     AND u.active = 1
    LEFT JOIN physical_momentum_metrics pm
      ON pm.market = 'US'
     AND pm.symbol = c.ticker
     AND pm.date = (SELECT date FROM latest_metric)
    LEFT JOIN ml_feature_vectors_v2 f
      ON f.ticker = c.ticker
     AND f.date = c.as_of_date
     AND f.feature_set = 'ma_physics_v4'
    WHERE c.as_of_date = (SELECT date FROM latest_candidate)
      AND c.horizon_days = 20
      AND c.direction = ?
      AND ${usInvestableSymbolSql('c.ticker')}
    ORDER BY c.rank ASC
    LIMIT 8
  `
  const [gainers, losers, volume, stageSummary, mlUp, mlDown, pmsSummary] = await Promise.all([
    execAll<RankingRow>(rankingSql('change_pct DESC NULLS LAST'), [date, date, date]),
    execAll<RankingRow>(rankingSql('change_pct ASC NULLS LAST'), [date, date, date]),
    execAll<RankingRow>(rankingSql('volume DESC NULLS LAST'), [date, date, date]),
    execAll<StageSummaryRow>(
      `
        SELECT CAST(daily_a_stage AS TEXT) AS label, COUNT(*) AS count
        FROM market_daily_snapshots INDEXED BY market_snapshots_market_date_idx
        WHERE market = 'US'
          AND date = ?
          AND daily_a_stage BETWEEN 1 AND 6
        GROUP BY daily_a_stage
        ORDER BY daily_a_stage
      `,
      [date],
    ),
    hasUsAnalyticsDb() ? execUsAnalyticsAll<MlCandidateRow>(candidateSql, [date, date, 'up']) : Promise.resolve([]),
    hasUsAnalyticsDb() ? execUsAnalyticsAll<MlCandidateRow>(candidateSql, [date, date, 'down']) : Promise.resolve([]),
    hasUsAnalyticsDb()
      ? execUsAnalyticsAll<PmsSummaryRow>(
          `
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN physical_momentum_score > 0 THEN 1 ELSE 0 END) AS positive,
            SUM(CASE WHEN physical_momentum_score < 0 THEN 1 ELSE 0 END) AS negative,
            AVG(physical_momentum_score) AS average_pms,
            AVG(physical_force_score) AS average_pfs,
            MAX(date) AS date
          FROM physical_momentum_metrics
          WHERE market = 'US'
            AND date = (
              SELECT MAX(date)
              FROM physical_momentum_metrics
              WHERE market = 'US' AND date <= ?
            )
            AND physical_momentum_score IS NOT NULL
          `,
          [date],
        ).then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ])
  const withDisplayNames = (rows: RankingRow[]) => rows.map((row) => ({
    ...row,
    name: getUsSecondaryName(row.ticker, row.name),
  }))
  const withCandidateNames = (rows: MlCandidateRow[]) => rows.map((row) => ({
    ...row,
    name: getUsSecondaryName(row.ticker, row.name),
  }))
  return {
    gainers: withDisplayNames(gainers),
    losers: withDisplayNames(losers),
    volume: withDisplayNames(volume),
    stageSummary,
    mlUp: withCandidateNames(mlUp),
    mlDown: withCandidateNames(mlDown),
    pmsSummary,
  }
}

/** 今日の市場・各セクションが同じ結果を共有する (取得は 1 リクエストにつき 1 回) */
const loadUsDashboard = cache((date: string) => getUsDashboardRows(date))

type UsDashboardData = Awaited<ReturnType<typeof getUsDashboardRows>>

/** 日足Aステージの構成と全体判定。判定の基準は従来どおり (差が10ポイント未満は方向感を確認) */
function readStructure(stageSummary: StageSummaryRow[]) {
  const stageCounts = new Map(stageSummary.map((row) => [Number(row.label), Number(row.count)]))
  const stageTotal = Array.from({ length: 6 }, (_, index) => stageCounts.get(index + 1) ?? 0).reduce((sum, count) => sum + count, 0)
  const constructiveCount = (stageCounts.get(1) ?? 0) + (stageCounts.get(6) ?? 0)
  const cautionCount = (stageCounts.get(3) ?? 0) + (stageCounts.get(4) ?? 0)
  const constructivePct = stageTotal > 0 ? (constructiveCount / stageTotal) * 100 : 0
  const cautionPct = stageTotal > 0 ? (cautionCount / stageTotal) * 100 : 0
  const marketTone = constructivePct >= cautionPct + 10
    ? '上昇構造が優勢'
    : cautionPct >= constructivePct + 10
      ? '下落構造を警戒'
      : '方向感を確認'
  const tone: DashboardTone = marketTone === '上昇構造が優勢' ? 'up' : marketTone === '下落構造を警戒' ? 'down' : 'neutral'
  return { stageCounts, stageTotal, constructiveCount, cautionCount, constructivePct, cautionPct, marketTone, tone }
}

const STAGE_POSITION_LABELS = ['日A', '日B', '週A', '週B', '月A', '月B'] as const

/** 6ステージ (日A 日B 週A 週B 月A 月B) を並びだけで示す。日本株の一覧と同じ並び */
function StageCodeTags({ code }: { code: string | null | undefined }) {
  const digits = (code ?? '').split('')
  const values = STAGE_POSITION_LABELS.map((label, index) => {
    const value = Number(digits[index])
    return { label, value: Number.isInteger(value) && value >= 1 && value <= 6 ? value : null }
  })
  return (
    <span
      className="inline-flex shrink-0 items-center gap-px"
      aria-label={`6ステージ ${values.map((item) => `${item.label} ${item.value ?? '未算出'}`).join(' / ')}`}
    >
      {values.map((item, index) => (
        <span key={item.label} className={`inline-flex ${index === 2 || index === 4 ? 'ml-1' : ''}`} title={`${item.label}: ${item.value ?? '未算出'}`}>
          <StageTag stage={item.value} size="xs" />
        </span>
      ))}
    </span>
  )
}

function SectionError({ text }: { text: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 border-y border-[var(--color-border-soft)] px-1 py-4 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
      <AlertTriangle size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-[#b45309]" />
      <span>{text}。時間をおいて再読み込みしてください。</span>
    </p>
  )
}

async function readDashboard(date: string): Promise<UsDashboardData | null> {
  try {
    return await loadUsDashboard(date)
  } catch (error) {
    console.error('US dashboard query failed:', error)
    return null
  }
}

/* ---------- 今日の市場 / この日の市場 ---------- */

function UsMarketBrief({
  resolvedDate,
  linkDate,
  scenarioInterval,
  historical,
}: {
  resolvedDate: string
  /** 過去日表示のときだけ日付が入る (リンク先へ引き継ぐ) */
  linkDate: string | null
  scenarioInterval: string | null
  historical: boolean
}) {
  return (
    <section
      aria-labelledby="us-market-brief-heading"
      className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-default)] border-t-[3px] border-t-[var(--color-brand-900)] bg-white"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-[var(--color-border-soft)] px-4 py-2">
        <h2 id="us-market-brief-heading" className="text-[14px] font-bold text-[var(--color-brand-900)]">
          {historical ? 'この日の市場' : '今日の市場'}
        </h2>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
          <span>
            表示基準日 <span className="font-mono font-bold tabular-nums text-[var(--color-text-primary)]">{resolvedDate}</span> 米国終値
          </span>
          <span className={historical ? 'font-bold text-[#b45309]' : ''}>{historical ? '過去日表示' : '最新データ'}</span>
          <span>米国株全体 · 日付は米国時間</span>
        </div>
      </header>

      <Suspense fallback={<MarketStateSkeleton />}>
        <UsMarketState date={resolvedDate} linkDate={linkDate} historical={historical} />
      </Suspense>

      <div className="border-t border-[var(--color-border-default)] bg-[var(--color-surface-subtle)]">
        <h3 className="sr-only">{historical ? 'この日の確認事項' : '今日の確認事項'}</h3>
        <div className="grid md:grid-cols-3">
          <Suspense fallback={<AgendaSkeleton />}>
            <SignalsAgenda date={linkDate} scenarioInterval={scenarioInterval} />
          </Suspense>
          <Suspense fallback={<AgendaSkeleton bordered />}>
            <MlAgenda date={resolvedDate} linkDate={linkDate} />
          </Suspense>
          {historical ? <HiddenItemsAgenda /> : <NextAnalysisAgenda />}
        </div>
      </div>
    </section>
  )
}

async function UsMarketState({ date, linkDate, historical }: { date: string; linkDate: string | null; historical: boolean }) {
  const data = await readDashboard(date)
  if (!data) {
    return (
      <div className="px-4 py-3">
        <SectionError text="市場構造を取得できませんでした" />
      </div>
    )
  }
  const structure = readStructure(data.stageSummary)
  const pms = data.pmsSummary
  const pmsTotal = Number(pms?.total ?? 0)
  const pmsPositive = Number(pms?.positive ?? 0)
  const pmsNegative = Number(pms?.negative ?? 0)
  const pmsDateMismatch = pms?.date != null && pms.date !== date
  const breadth: Array<{ label: string; hint: string; value: number | null; count: number; total: number; tone: DashboardTone; mid: boolean }> = [
    { label: '上昇構造', hint: 'S1・S6', value: structure.stageTotal > 0 ? structure.constructivePct : null, count: structure.constructiveCount, total: structure.stageTotal, tone: 'up', mid: false },
    { label: '警戒構造', hint: 'S3・S4', value: structure.stageTotal > 0 ? structure.cautionPct : null, count: structure.cautionCount, total: structure.stageTotal, tone: 'down', mid: false },
    { label: 'PMSプラス', hint: 'PMS > 0', value: ratio(pmsPositive, pmsTotal), count: pmsPositive, total: pmsTotal, tone: 'up', mid: true },
    { label: 'PMSマイナス', hint: 'PMS < 0', value: ratio(pmsNegative, pmsTotal), count: pmsNegative, total: pmsTotal, tone: 'down', mid: true },
  ]

  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)]">
      {/* 1. 全体判定 + 構成比 */}
      <div className="min-w-0 px-4 pb-4 pt-3 md:col-span-2 lg:col-span-1">
        <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">全体判定（日足Aステージの構成）</div>
        {structure.stageTotal > 0 ? (
          <>
            <div className="mt-1 flex items-center gap-2.5">
              <span aria-hidden="true" className="h-[22px] w-[5px] shrink-0 rounded-[1px]" style={{ background: TONE_FILL[structure.tone] }} />
              <p className={`text-[24px] font-bold leading-none sm:text-[28px] ${TONE_TEXT[structure.tone]}`}>{structure.marketTone}</p>
            </div>
            <p className="mt-2 max-w-[48ch] text-[12px] font-medium leading-relaxed text-[var(--color-text-secondary)]">
              上昇構造(S1・S6) <b className="font-mono tabular-nums text-[var(--color-price-up)]">{structure.constructivePct.toFixed(1)}%</b>
              {' '}／ 警戒構造(S3・S4) <b className="font-mono tabular-nums text-[var(--color-price-down)]">{structure.cautionPct.toFixed(1)}%</b>。
              差が10ポイント未満のときは方向感を確認とします。
            </p>
          </>
        ) : (
          <p className="mt-2 text-[12px] font-semibold text-[var(--color-text-tertiary)]">この日付の6ステージはまだ生成されていません。</p>
        )}

        <dl className="mt-3 grid gap-y-[7px]">
          {breadth.map((item) => (
            <div key={item.label} className="grid grid-cols-[7.25rem_minmax(0,1fr)_3.25rem_4.75rem] items-center gap-x-3 max-sm:gap-x-2">
              <dt className="min-w-0 truncate text-[11px] font-semibold text-[var(--color-text-secondary)]">
                {item.label}
                <span className="ml-1 font-mono text-[9px] text-[var(--color-text-tertiary)]">{item.hint}</span>
              </dt>
              <dd className="contents">
                <MeterBar value={item.value} tone={item.tone} midTick={item.mid} />
                <span className={`text-right font-mono text-[13px] font-bold tabular-nums ${TONE_TEXT[item.tone]}`}>{fmtRatio(item.value)}</span>
                <span className="text-right font-mono text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
                  {fmt(item.count)}/{fmt(item.total)}
                </span>
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-2.5 text-[10px] font-semibold leading-relaxed tabular-nums text-[var(--color-text-tertiary)]">
          日足A {fmt(structure.stageTotal)}銘柄 · PMS基準日 <span className="font-mono font-bold text-[var(--color-text-secondary)]">{pms?.date ?? '未生成'}</span>
          {' '}· 平均PMS <span className={`font-mono font-bold ${signedTextClass(pms?.average_pms)}`}>{fmtScore(pms?.average_pms)}</span>
          {' '}· 平均PFS <span className={`font-mono font-bold ${signedTextClass(pms?.average_pfs)}`}>{fmtScore(pms?.average_pfs)}</span>
          {pmsDateMismatch && <span className="ml-1 font-bold text-[#b45309]">（PMSは表示基準日より前の値）</span>}
        </div>
      </div>

      {/* 2. ステージ構成 (日足A)。行を選ぶとスクリーナーで該当銘柄を開く */}
      <div className="min-w-0 border-t border-[var(--color-border-soft)] px-4 pb-4 pt-3 lg:border-l lg:border-t-0">
        <GroupLabel meta="日足A · 選ぶと該当銘柄" className="mb-1.5">ステージ構成</GroupLabel>
        {structure.stageTotal > 0 && (
          <div
            className="mb-2 flex h-2 w-full overflow-hidden rounded-[2px] bg-[var(--color-surface-muted)]"
            role="img"
            aria-label={`ステージ構成比 ${Array.from({ length: 6 }, (_, i) => `S${i + 1} ${fmt(structure.stageCounts.get(i + 1) ?? 0)}`).join('、')}`}
          >
            {Array.from({ length: 6 }, (_, index) => index + 1).map((stage) => {
              const count = structure.stageCounts.get(stage) ?? 0
              if (count === 0) return null
              return <span key={stage} style={{ width: `${(count / structure.stageTotal) * 100}%`, background: `var(--color-stage-${stage}-text)` }} />
            })}
          </div>
        )}
        <ol className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
          {Array.from({ length: 6 }, (_, index) => index + 1).map((stage) => {
            const count = structure.stageCounts.get(stage) ?? 0
            const share = ratio(count, structure.stageTotal)
            return (
              <li key={stage}>
                <Link
                  href={usScreenerHref({ daily_a: String(stage), sort: 'pms', dir: 'desc' }, linkDate)}
                  prefetch={false}
                  className="grid grid-cols-[6.75rem_minmax(0,1fr)_3.25rem_3.75rem] items-center gap-x-3 py-[5px] transition-colors hover:bg-[var(--color-surface-subtle)] max-sm:gap-x-2"
                  aria-label={`日足A S${stage} ${STAGE_LABELS[stage]}の銘柄をスクリーナーで見る`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <StageTag stage={stage} size="sm" />
                    <span className="min-w-0 truncate text-[11px] font-semibold text-[var(--color-text-primary)]">{STAGE_LABELS[stage]}</span>
                  </span>
                  <span aria-hidden="true" className="relative block h-[6px] overflow-hidden rounded-[2px] bg-[var(--color-surface-muted)]">
                    <span
                      className="absolute inset-y-0 left-0 rounded-[2px]"
                      style={{ width: `${Math.max(0, Math.min(100, share ?? 0))}%`, background: `var(--color-stage-${stage}-text)`, opacity: 0.85 }}
                    />
                  </span>
                  <span className="text-right font-mono text-[12px] font-bold tabular-nums text-[var(--color-text-primary)]">{fmtRatio(share)}</span>
                  <span className="text-right font-mono text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">{fmt(count)}</span>
                </Link>
              </li>
            )
          })}
        </ol>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Link href={usScreenerHref({ daily_a: '1,6', sort: 'pms', dir: 'desc' }, linkDate)} prefetch={false} className="btn" data-size="sm">
            上昇構造 S1・S6 <ChevronRight size={13} aria-hidden />
          </Link>
          <Link href={usScreenerHref({ daily_a: '3,4', sort: 'pms', dir: 'asc' }, linkDate)} prefetch={false} className="btn" data-size="sm">
            警戒構造 S3・S4 <ChevronRight size={13} aria-hidden />
          </Link>
        </div>
      </div>

      {/* 3. 値動きの上下端 */}
      <div className="min-w-0 border-t border-[var(--color-border-soft)] px-4 pb-4 pt-3 md:border-l lg:border-t-0">
        <GroupLabel meta="前営業日比 · 株式" className="mb-1.5">{historical ? 'この日の変化' : '今日の変化'}</GroupLabel>
        <dl className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
          <ChangeRow label="上昇" hint="上昇率 上位" tone="up">
            <TickerList rows={data.gainers.slice(0, 3)} date={linkDate} metric="pct" />
          </ChangeRow>
          <ChangeRow label="下落" hint="下落率 上位" tone="down">
            <TickerList rows={data.losers.slice(0, 3)} date={linkDate} metric="pct" />
          </ChangeRow>
          <ChangeRow label="出来高" hint="当日 上位" tone="neutral">
            <TickerList rows={data.volume.slice(0, 3)} date={linkDate} metric="volume" />
          </ChangeRow>
        </dl>
        <a href="#dashboard-section-us-movers" className="mt-2 inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-brand-700)] hover:underline">
          値動きの上位8銘柄を見る
          <ArrowDown size={12} aria-hidden="true" />
        </a>
      </div>
    </div>
  )
}

function ChangeRow({
  label,
  hint,
  tone,
  children,
}: {
  label: string
  hint: string
  tone: DashboardTone
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 py-1.5">
      <dt className="min-w-0">
        <div className={`text-[12px] font-bold ${TONE_TEXT[tone]}`}>{label}</div>
        <div className="text-[9px] font-semibold text-[var(--color-text-tertiary)]">{hint}</div>
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function TickerList({ rows, date, metric }: { rows: RankingRow[]; date: string | null; metric: 'pct' | 'volume' }) {
  if (rows.length === 0) {
    return <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">該当なし</span>
  }
  return (
    <ul className="grid gap-0.5">
      {rows.map((row) => (
        <li key={row.ticker} className="grid grid-cols-[3.5rem_minmax(0,1fr)_4rem] items-baseline gap-x-2">
          <Link href={usStockHref(row.ticker, date)} prefetch={false} className="truncate font-mono text-[11px] font-bold text-[var(--color-brand-800)] hover:underline">
            {row.ticker}
          </Link>
          <span className="min-w-0 truncate text-[11px] font-semibold text-[var(--color-text-primary)]" title={row.name ?? undefined}>{row.name ?? row.ticker}</span>
          {metric === 'volume' ? (
            <span className="text-right font-mono text-[10px] font-bold tabular-nums text-[var(--color-text-secondary)]">{fmtVolume(row.volume)}</span>
          ) : (
            <span className={`text-right font-mono text-[10px] font-bold tabular-nums ${signedTextClass(row.change_pct)}`}>{fmtPct(row.change_pct)}</span>
          )}
        </li>
      ))}
    </ul>
  )
}

/* ---------- 確認事項 (下段) ---------- */

function AgendaCell({
  title,
  meta,
  href,
  linkLabel,
  bordered = false,
  children,
}: {
  title: string
  meta?: React.ReactNode
  href?: string
  linkLabel?: string
  bordered?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={`min-w-0 px-4 py-2.5 ${bordered ? 'border-t border-[var(--color-border-soft)] md:border-l md:border-t-0' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-[12px] font-bold text-[var(--color-brand-900)]">{title}</span>
          {meta != null && <span className="truncate text-[10px] font-semibold text-[var(--color-text-tertiary)]">{meta}</span>}
        </div>
        {href && linkLabel && (
          <a href={href} className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-bold text-[var(--color-brand-700)] hover:underline">
            {linkLabel}
            <ArrowDown size={11} aria-hidden="true" />
          </a>
        )}
      </div>
      <div className="mt-1 flex min-h-[38px] flex-wrap items-end gap-x-5 gap-y-1">{children}</div>
    </div>
  )
}

function AgendaFigure({ label, value, tone }: { label: string; value: number; tone: DashboardTone }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`font-mono text-[18px] font-bold leading-tight tabular-nums ${value > 0 ? TONE_TEXT[tone] : 'text-[var(--color-text-tertiary)]'}`}>
        {value.toLocaleString('ja-JP')}
      </div>
    </div>
  )
}

async function SignalsAgenda({ date, scenarioInterval }: { date: string | null; scenarioInterval: string | null }) {
  try {
    // 一覧 (DashboardTradeSignalTable) と同じ引数なので、取得は React cache で 1 回にまとまる
    const data = await loadDashboardTradeSignals(date, null, scenarioInterval, 'US')
    const rows = data.rows.filter((row) => row.market === 'US')
    const buy = rows.filter((row) => row.side === 'buy').length
    const sell = rows.filter((row) => row.side === 'sell').length
    const high = rows.filter((row) => row.confidenceBand === 'high').length
    return (
      <AgendaCell title="売買候補" meta={`${data.scenarioIntervalLabel}シナリオ`} href="#trade-signals" linkLabel="一覧">
        <AgendaFigure label="買う" value={buy} tone="up" />
        <AgendaFigure label="売る" value={sell} tone="down" />
        <AgendaFigure label="高確度" value={high} tone="neutral" />
      </AgendaCell>
    )
  } catch {
    return (
      <AgendaCell title="売買候補" href="#trade-signals" linkLabel="一覧">
        <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">件数を取得できませんでした</span>
      </AgendaCell>
    )
  }
}

async function MlAgenda({ date, linkDate }: { date: string; linkDate: string | null }) {
  const data = await readDashboard(date)
  const asOf = data?.mlUp[0]?.as_of_date ?? data?.mlDown[0]?.as_of_date ?? null
  const leaders = [
    { label: '上昇候補 1位', row: data?.mlUp[0] ?? null, tone: 'up' as DashboardTone },
    { label: '下落警戒 1位', row: data?.mlDown[0] ?? null, tone: 'down' as DashboardTone },
  ]
  return (
    <AgendaCell title="物理ML" meta={asOf ? `ML基準日 ${asOf}` : '20営業日先'} href="#dashboard-section-us-ml" linkLabel="候補" bordered>
      {!data ? (
        <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">候補を取得できませんでした</span>
      ) : (
        leaders.map((item) => (
          <div key={item.label} className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">{item.label}</div>
            {item.row ? (
              <div className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
                <Link href={usStockHref(item.row.ticker, linkDate, '#ml')} prefetch={false} className={`shrink-0 font-mono font-bold hover:underline ${TONE_TEXT[item.tone]}`}>
                  {item.row.ticker}
                </Link>
                <span className="min-w-0 truncate font-semibold text-[var(--color-text-primary)]">{item.row.name ?? item.row.ticker}</span>
              </div>
            ) : (
              <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">未生成</div>
            )}
          </div>
        ))
      )}
    </AgendaCell>
  )
}

function NextAnalysisAgenda() {
  const links = [
    { href: '/us/analysis/ml-lens', label: 'US AI Lens' },
    { href: '/ai/research?market=US', label: 'AI銘柄リサーチ' },
    { href: '/chart-drill?market=US', label: 'チャートドリル' },
    { href: '/us/stage-screener', label: 'ステージスクリーナー' },
  ]
  return (
    <AgendaCell title="次の分析" meta="現在の情報で確認" bordered>
      <div className="flex flex-wrap gap-1.5">
        {links.map((link) => (
          <Link key={link.href} href={link.href} prefetch={false} className="btn" data-size="sm" data-variant="ghost">
            {link.label}
            <ChevronRight size={12} aria-hidden />
          </Link>
        ))}
      </div>
    </AgendaCell>
  )
}

function HiddenItemsAgenda() {
  return (
    <div className="border-t border-[var(--color-border-soft)] px-4 py-2.5 md:border-l md:border-t-0">
      <div className="text-[12px] font-bold text-[var(--color-brand-900)]">この日付で表示しない項目</div>
      <p className="mt-1 text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">
        業種分類・時価総額は当時の値がないため、AIリサーチ・データ状況は現在の情報のため表示しません。
      </p>
    </div>
  )
}

/* ---------- 01 値動き ---------- */

async function UsMoversSection({ date, linkDate }: { date: string; linkDate: string | null }) {
  const data = await readDashboard(date)
  if (!data) return <SectionError text="値動きランキングを取得できませんでした" />
  // 資産種別は現在の登録値しかなく、過去日のスクリーナーでは使えない (PIT 契約で拒否される)
  const stockOnly: Record<string, string> = linkDate ? {} : { assetType: 'Stock' }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-y-5 md:grid-cols-2 md:gap-x-6 lg:grid-cols-3">
      <MoverLane
        title="上昇率"
        basis="前日比 上位"
        rows={data.gainers}
        metric="pct"
        tone="up"
        href={usScreenerHref({ ...stockOnly, sort: 'changePct', dir: 'desc' }, linkDate)}
        linkDate={linkDate}
      />
      <MoverLane
        title="下落率"
        basis="前日比 下位"
        rows={data.losers}
        metric="pct"
        tone="down"
        href={usScreenerHref({ ...stockOnly, sort: 'changePct', dir: 'asc' }, linkDate)}
        linkDate={linkDate}
      />
      {/* md では 3 本目だけ全幅にし、8 行を 2 列 (1〜4 / 5〜8) に並べて余白を作らない */}
      <MoverLane
        title="出来高"
        basis="当日出来高 上位（株）"
        rows={data.volume}
        metric="volume"
        tone="neutral"
        href={usScreenerHref({ ...stockOnly, sort: 'volume', dir: 'desc' }, linkDate)}
        linkDate={linkDate}
        wide
      />
    </div>
  )
}

function MoverLane({
  title,
  basis,
  rows,
  metric,
  tone,
  href,
  linkDate,
  wide = false,
}: {
  title: string
  basis: string
  rows: RankingRow[]
  metric: 'pct' | 'volume'
  tone: DashboardTone
  href: string
  /** 過去日表示のときだけ日付が入る (詳細ページ・クイックプレビューへ引き継ぐ) */
  linkDate: string | null
  wide?: boolean
}) {
  return (
    <section className={`min-w-0 ${wide ? 'md:col-span-2 lg:col-span-1' : ''}`} aria-label={title}>
      <header className="flex min-w-0 items-baseline justify-between gap-2 border-t-2 border-[var(--color-brand-900)] py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className={`shrink-0 text-[13px] font-bold ${TONE_TEXT[tone]}`}>{title}</h3>
          <span className="min-w-0 truncate text-[10px] font-semibold text-[var(--color-text-tertiary)]">{basis}</span>
        </div>
        <Link
          href={href}
          prefetch={false}
          className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-bold text-[var(--color-brand-700)] hover:underline"
          aria-label={`${title}の順にスクリーナーで全件を見る`}
        >
          全件
          <ArrowUpRight size={11} aria-hidden="true" />
        </Link>
      </header>
      {rows.length === 0 ? (
        <p className="border-t border-[var(--color-border-soft)] py-4 text-center text-[11px] font-semibold text-[var(--color-text-tertiary)]">
          この基準日のランキングはありません
        </p>
      ) : (
        <ol className={wide ? 'md:grid md:grid-flow-col md:grid-rows-4 md:gap-x-6 lg:block' : ''}>
          {rows.map((row, index) => (
            <li
              key={row.ticker}
              className={`grid min-w-0 grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2 border-t border-[var(--color-border-soft)] py-1.5 ${index >= 5 ? 'max-md:hidden' : ''}`}
            >
              <span className="pt-px text-right font-mono text-[10px] font-bold tabular-nums text-[var(--color-text-tertiary)]">{index + 1}</span>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Link
                    href={usStockHref(row.ticker, linkDate)}
                    prefetch={false}
                    className="shrink-0 font-mono text-[12px] font-bold text-[var(--color-brand-800)] hover:underline"
                  >
                    {row.ticker}
                  </Link>
                  <span className="min-w-0 truncate text-[11px] font-semibold text-[var(--color-text-primary)]" title={row.name ?? undefined}>
                    {row.name ?? '名称未登録'}
                  </span>
                  <StockPreviewTrigger ticker={row.ticker} market="US" analysisDate={linkDate} context="home" />
                </div>
                <div className="mt-1 flex min-w-0 items-center gap-2">
                  <StageCodeTags code={row.stage_code} />
                  <span className="min-w-0 truncate text-[10px] font-semibold text-[var(--color-text-tertiary)]">{row.exchange ?? 'US'}</span>
                </div>
              </div>
              <div className="text-right">
                {metric === 'volume' ? (
                  <>
                    <div className="font-mono text-[13px] font-bold tabular-nums text-[var(--color-text-primary)]">{fmtVolume(row.volume)}</div>
                    <div className={`font-mono text-[10px] font-bold tabular-nums ${signedTextClass(row.change_pct)}`}>{fmtPct(row.change_pct)}</div>
                  </>
                ) : (
                  <>
                    <div className={`font-mono text-[13px] font-bold tabular-nums ${signedTextClass(row.change_pct)}`}>{fmtPct(row.change_pct)}</div>
                    <div className="font-mono text-[10px] font-bold tabular-nums text-[var(--color-text-secondary)]">{fmtMoney(row.price)}</div>
                  </>
                )}
              </div>
            </li>
          ))}
          {rows.length > 5 && (
            <li className="border-t border-[var(--color-border-soft)] py-1.5 text-[10px] font-semibold text-[var(--color-text-tertiary)] md:hidden">
              6位以降は「全件」で確認できます
            </li>
          )}
        </ol>
      )}
    </section>
  )
}

/* ---------- 03 物理ML候補 ---------- */

async function UsMlSection({ date, linkDate }: { date: string; linkDate: string | null }) {
  const data = await readDashboard(date)
  if (!data) return <SectionError text="物理MLの候補を取得できませんでした" />
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-6 md:grid-cols-2">
        <MlCandidateList title="上昇候補" rows={data.mlUp} direction="up" linkDate={linkDate} resolvedDate={date} />
        <MlCandidateList title="下落警戒" rows={data.mlDown} direction="down" linkDate={linkDate} resolvedDate={date} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
        <span>統計的な観測であり売買推奨ではありません。PMS/PFS は表示基準日までの直近値です。</span>
        <Link href="/us/analysis/ml-lens" prefetch={false} className="inline-flex items-center gap-0.5 font-bold text-[var(--color-brand-700)] hover:underline">
          US AI Lens で検証結果を見る
          <ChevronRight size={12} aria-hidden="true" />
        </Link>
      </div>
    </div>
  )
}

function MlCandidateList({
  title,
  rows,
  direction,
  linkDate,
  resolvedDate,
}: {
  title: string
  rows: MlCandidateRow[]
  direction: 'up' | 'down'
  /** 過去日表示のときだけ日付が入る (詳細ページ・クイックプレビューへ引き継ぐ) */
  linkDate: string | null
  resolvedDate: string
}) {
  const Icon = direction === 'up' ? ArrowUpRight : ArrowDownRight
  const tone: DashboardTone = direction === 'up' ? 'up' : 'down'
  const asOf = rows[0]?.as_of_date ?? null
  const olderThanView = asOf != null && asOf < resolvedDate
  return (
    <section className="min-w-0" aria-label={title}>
      <header className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t-2 border-[var(--color-brand-900)] py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon size={14} aria-hidden="true" className={`shrink-0 ${TONE_TEXT[tone]}`} />
          <h3 className={`shrink-0 text-[13px] font-bold ${TONE_TEXT[tone]}`}>{title}</h3>
          <span className="min-w-0 truncate text-[10px] font-semibold text-[var(--color-text-tertiary)]">20営業日先の候補順位</span>
        </div>
        <span className="text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
          ML基準日 <span className="font-mono font-bold text-[var(--color-text-secondary)]">{asOf ?? '---'}</span>
          {olderThanView && <span className="ml-1 font-bold text-[#b45309]">（表示基準日より前の生成分）</span>}
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="border-t border-[var(--color-border-soft)] py-4 text-center text-[11px] font-semibold text-[var(--color-text-tertiary)]">
          この基準日までに生成された候補はありません
        </p>
      ) : (
        <>
          <div
            aria-hidden="true"
            className="hidden grid-cols-[1.75rem_minmax(0,1fr)_3.5rem_3.5rem_3.75rem] gap-x-2 border-t border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-1 py-1 text-[10px] font-bold text-[var(--color-text-tertiary)] sm:grid"
          >
            <span className="text-right">順位</span>
            <span>銘柄 · 6ステージ</span>
            <span className="text-right">PMS</span>
            <span className="text-right">PFS</span>
            <span className="text-right">スコア</span>
          </div>
          <ol>
            {rows.map((row) => (
              <li
                key={row.ticker}
                className="grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)_auto] items-start gap-x-2 border-t border-[var(--color-border-soft)] px-1 py-1.5 sm:grid-cols-[1.75rem_minmax(0,1fr)_3.5rem_3.5rem_3.75rem] sm:items-center"
              >
                <span className="pt-px text-right font-mono text-[10px] font-bold tabular-nums text-[var(--color-text-tertiary)] sm:pt-0">
                  <span className="sr-only">順位 </span>{row.rank}
                </span>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Link
                      href={usStockHref(row.ticker, linkDate, '#ml')}
                      prefetch={false}
                      className="shrink-0 font-mono text-[12px] font-bold text-[var(--color-brand-800)] hover:underline"
                    >
                      {row.ticker}
                    </Link>
                    <span className="min-w-0 truncate text-[11px] font-semibold text-[var(--color-text-primary)]" title={row.name ?? undefined}>
                      {row.name ?? '名称未登録'}
                    </span>
                    <StockPreviewTrigger ticker={row.ticker} market="US" analysisDate={linkDate} context="home" />
                  </div>
                  <div className="mt-1">
                    <StageCodeTags code={row.stage_code} />
                  </div>
                </div>
                {/* 390: スコアを主に、PMS/PFS は下段に小さく */}
                <div className="text-right sm:hidden">
                  <div className="font-mono text-[13px] font-bold tabular-nums text-[var(--color-text-primary)]">
                    <span className="mr-1 font-sans text-[9px] font-semibold text-[var(--color-text-tertiary)]">スコア</span>
                    {Number.isFinite(row.candidate_score) ? row.candidate_score.toFixed(3) : '-'}
                  </div>
                  <div className="font-mono text-[10px] font-bold tabular-nums">
                    <span className="font-sans font-semibold text-[var(--color-text-tertiary)]">PMS </span>
                    <span className={signedTextClass(row.physical_momentum_score)}>{fmtScore(row.physical_momentum_score)}</span>
                    <span className="font-sans font-semibold text-[var(--color-text-tertiary)]"> · PFS </span>
                    <span className={signedTextClass(row.physical_force_score)}>{fmtScore(row.physical_force_score)}</span>
                  </div>
                </div>
                <span className={`hidden text-right font-mono text-[12px] font-bold tabular-nums sm:block ${signedTextClass(row.physical_momentum_score)}`}>
                  {fmtScore(row.physical_momentum_score)}
                </span>
                <span className={`hidden text-right font-mono text-[12px] font-bold tabular-nums sm:block ${signedTextClass(row.physical_force_score)}`}>
                  {fmtScore(row.physical_force_score)}
                </span>
                <span className="hidden text-right font-mono text-[12px] font-bold tabular-nums text-[var(--color-text-primary)] sm:block">
                  {Number.isFinite(row.candidate_score) ? row.candidate_score.toFixed(3) : '-'}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  )
}

/* ---------- 売買候補 ---------- */

async function UsTradeSignals({ date, scenarioInterval }: { date: string | null; scenarioInterval: string | null }) {
  try {
    // 一覧と同じ引数で先に取得し、失敗したときはこのセクションだけを閉じる
    await loadDashboardTradeSignals(date, null, scenarioInterval, 'US')
  } catch (error) {
    console.error('US dashboard trade signals failed:', error)
    return <SectionError text="売買候補を取得できませんでした" />
  }
  return <DashboardTradeSignalTable date={date} scenarioInterval={scenarioInterval} market="US" />
}

/* ---------- データ基盤 (最新表示のみ) ---------- */

async function UsDataHealth() {
  const status = await getUsStatusSummary().catch(() => null)
  if (!status) return null
  return (
    <details className="rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-4 text-[13px] font-semibold text-[var(--color-text-secondary)]">
        <Database size={14} aria-hidden />
        データ基盤の健全性
        <span className="ml-auto font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">最新 {status.snapshots.latestDate ?? '-'}</span>
      </summary>
      <dl className="grid gap-px border-t border-[var(--color-border-soft)] bg-[var(--color-border-soft)] md:grid-cols-3">
        {[
          { label: '稼働全資産', value: `${fmt(status.universe.active)}銘柄`, sub: `運用対象 ${fmt(status.universe.productionActive)} / 登録 ${fmt(status.universe.total)}` },
          { label: 'OHLCV', value: `${fmt(status.ohlcv.tickers)}銘柄`, sub: `${status.ohlcv.firstDate ?? '-'} 〜 ${status.ohlcv.latestDate ?? '-'}` },
          { label: '6ステージ', value: `${fmt(status.snapshots.tickers)}銘柄`, sub: `最新 ${status.snapshots.latestDate ?? '-'}` },
        ].map((item) => (
          <div key={item.label} className="min-w-0 bg-white px-4 py-3">
            <dt className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-text-tertiary)]">
              <BarChart3 size={13} aria-hidden />
              {item.label}
            </dt>
            <dd className="m-0 mt-1 font-mono text-[18px] font-bold tabular-nums text-[var(--color-text-primary)]">{item.value}</dd>
            <dd className="m-0 mt-0.5 text-[12px] tabular-nums text-[var(--color-text-secondary)]">{item.sub}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

/* ---------- ページ ---------- */

// 表示日は getUsDashboardAsOfState の結果だけを正とする (日本株 Dashboard と同じ方針)。
// - latest: 今日の市場 + 01 値動き / 02 売買候補 / 03 物理ML候補 + データ基盤
// - historical: 同じ構成を当時の値で表示し、当時の値がない項目 (業種分類・時価総額) と
//   現在の情報 (AIリサーチ・データ基盤) は出さず、AS OF 帯で理由を示す
// - unavailable: 範囲外・不正な日付では最新データを代わりに出さず、表示できる期間を案内する
export default async function UsHomePage({
  searchParams,
}: {
  searchParams?: Promise<{ date?: string | string[]; scenarioInterval?: string | string[] }>
}) {
  const sp = searchParams ? await searchParams : {}
  // 複数指定 (?date=a&date=b) は不正な日付として扱い、黙って最新に落とさない
  const rawDate = Array.isArray(sp.date) ? sp.date.join(',') : sp.date
  const requested = rawDate?.trim() ? rawDate.trim() : null
  const scenarioInterval = typeof sp.scenarioInterval === 'string' ? sp.scenarioInterval : null
  const asOf = await getUsDashboardAsOfState(requested)
  const { mode, resolvedDate } = asOf
  const historical = mode === 'historical'
  const historicalDate = historical ? resolvedDate : null

  const subtitle = mode === 'unavailable'
    ? asOf.availability === 'no_data' ? 'データ未取り込み' : '指定した日付のデータは表示できません'
    : `${resolvedDate} 米国終値基準${historical ? '（過去日表示）' : ''}。日足Aステージの市場構造を起点に、値動き・売買候補・物理MLの候補を確認します。`
  const badgeLabel = mode === 'unavailable' ? '表示できません' : historical ? '過去日表示' : '最新データ反映'
  const initialDates = [
    asOf.latestDate ? { date: asOf.latestDate } : null,
    resolvedDate && resolvedDate !== asOf.latestDate ? { date: resolvedDate } : null,
  ].filter((date): date is { date: string } => date != null)

  const header = (
    <PageTitle
      eyebrow="米国株"
      title="米国株ダッシュボード"
      subtitle={subtitle}
      badge={badgeLabel}
      badgeTone={mode === 'unavailable' ? 'danger' : historical ? 'warning' : 'positive'}
      rightSlot={(
        <Link href={usScreenerHref({ sort: 'changePct', dir: 'desc' }, historicalDate)} prefetch={false} className="btn" data-variant="primary">
          <ListFilter size={14} aria-hidden />
          スクリーナーで絞り込む
        </Link>
      )}
    >
      <UsAnalysisNav current="/us" />
    </PageTitle>
  )
  const selector = (
    <UsDashboardDateSelector
      dates={initialDates}
      requestedDate={asOf.requestedDate}
      resolvedDate={resolvedDate}
      latestDate={asOf.latestDate}
      earliestDate={asOf.earliestDate}
      mode={mode}
    />
  )

  let body: React.ReactNode
  if (mode === 'unavailable' || !resolvedDate) {
    body = <DashboardHistoricalUnavailable state={asOf} />
  } else {
    const meta = (id: UsDashboardSectionId) => ({
      id,
      label: US_DASHBOARD_SECTION_META[id].label,
      description: US_DASHBOARD_SECTION_META[id].description,
    })
    body = (
      <>
        {historical && asOf.requestedDate && (
          <UsHistoricalBanner
            requestedDate={asOf.requestedDate}
            resolvedDate={resolvedDate}
            adjusted={asOf.adjustedToPriorSession}
            latestDate={asOf.latestDate}
          />
        )}
        <UsMarketBrief
          resolvedDate={resolvedDate}
          linkDate={historicalDate}
          scenarioInterval={scenarioInterval}
          historical={historical}
        />
        <DashboardWorkspace
          sections={[
            {
              ...meta('us-movers'),
              content: (
                <Suspense fallback={<UsDashboardSectionFallback section="us-movers" />}>
                  <UsMoversSection date={resolvedDate} linkDate={historicalDate} />
                </Suspense>
              ),
            },
            {
              ...meta('us-signals'),
              content: (
                <Suspense fallback={<UsDashboardSectionFallback section="us-signals" />}>
                  <UsTradeSignals date={historicalDate} scenarioInterval={scenarioInterval} />
                </Suspense>
              ),
            },
            {
              ...meta('us-ml'),
              content: (
                <Suspense fallback={<UsDashboardSectionFallback section="us-ml" />}>
                  <UsMlSection date={resolvedDate} linkDate={historicalDate} />
                </Suspense>
              ),
            },
          ]}
        />
        {!historical && (
          <Suspense fallback={null}>
            <UsDataHealth />
          </Suspense>
        )}
      </>
    )
  }

  return (
    <UsDashboardShell
      header={header}
      selector={selector}
      contentKey={`${mode}:${asOf.requestedDate ?? 'latest'}:${resolvedDate ?? 'none'}`}
    >
      {body}
    </UsDashboardShell>
  )
}
