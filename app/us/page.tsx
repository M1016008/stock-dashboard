import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowDownRight, ArrowUpRight, BarChart3, ChevronRight, Database, ListFilter } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { StageTag } from '@/components/ui/StageTag'
import { StatStrip } from '@/components/ui/StatStrip'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { UsAnalysisNav } from '@/components/us/UsAnalysisNav'
import { STAGE_LABELS } from '@/lib/hex-stage'
import { execAll } from '@/lib/db/client'
import { execUsAnalyticsAll, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
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
      SELECT MAX(as_of_date) AS date FROM serving_ml_physics_candidates
    ),
    latest_metric AS (
      SELECT MAX(date) AS date FROM physical_momentum_metrics WHERE market = 'US'
    )
    SELECT
      c.ticker,
      COALESCE(c.name, u.name, c.ticker) AS name,
      c.rank,
      c.candidate_score,
      pm.physical_momentum_score,
      pm.physical_force_score,
      f.stage_code
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
    hasUsAnalyticsDb() ? execUsAnalyticsAll<MlCandidateRow>(candidateSql, ['up']) : Promise.resolve([]),
    hasUsAnalyticsDb() ? execUsAnalyticsAll<MlCandidateRow>(candidateSql, ['down']) : Promise.resolve([]),
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
            AND date = (SELECT MAX(date) FROM physical_momentum_metrics WHERE market = 'US')
            AND physical_momentum_score IS NOT NULL
          `,
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

function StageCode({ code }: { code: string | null | undefined }) {
  if (!code) return <span className="font-mono text-[11px] text-[var(--color-text-tertiary)]">------</span>
  return (
    <span className="inline-flex gap-0.5" aria-label={`6ステージ ${code}`}>
      {code.split('').slice(0, 6).map((digit, index) => (
        <StageTag key={`${digit}-${index}`} stage={Number(digit)} size="xs" />
      ))}
    </span>
  )
}

function toneClass(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value === 0) return 'text-[var(--color-text-secondary)]'
  return value > 0 ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'
}

function RankingPanel({ title, hint, rows, tone }: { title: string; hint: string; rows: RankingRow[]; tone: 'up' | 'down' | 'volume' }) {
  return (
    <section className="panel" aria-label={title}>
      <div className="panel-head">
        <div className="min-w-0">
          <h3>{title}</h3>
          <p>{hint}</p>
        </div>
        <span className="text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{rows.length}件</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-[13px] text-[var(--color-text-tertiary)]">この基準日のランキングはありません</p>
      ) : (
        <ol className="divide-y divide-[var(--color-border-soft)]">
          {rows.map((row, index) => (
            <li key={row.ticker}>
              <Link
                href={`/us/stock/${encodeURIComponent(row.ticker)}`}
                prefetch={false}
                className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2 hover:bg-[var(--color-surface-subtle)]"
              >
                <span className="text-right font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{index + 1}</span>
                <span className="min-w-0">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 font-mono text-[13px] font-bold text-[var(--color-brand-800)]">{row.ticker}</span>
                    <span className="min-w-0 truncate text-[12px] text-[var(--color-text-secondary)]">{row.name ?? '名称未登録'}</span>
                  </span>
                  <span className="mt-1 flex items-center gap-2 text-[11px] text-[var(--color-text-tertiary)]">
                    <span className="w-12 shrink-0 truncate">{row.exchange ?? 'US'}</span>
                    <StageCode code={row.stage_code} />
                  </span>
                </span>
                <span className="text-right font-mono tabular-nums">
                  <span className="block text-[13px] font-semibold text-[var(--color-text-primary)]">{fmtMoney(row.price)}</span>
                  {tone === 'volume' ? (
                    <span className="block text-[12px] text-[var(--color-text-secondary)]">{row.volume?.toLocaleString('en-US') ?? '-'}</span>
                  ) : (
                    <span className={`block text-[12px] font-semibold ${toneClass(row.change_pct)}`}>{fmtPct(row.change_pct)}</span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function MlCandidatePanel({ title, rows, direction }: { title: string; rows: MlCandidateRow[]; direction: 'up' | 'down' }) {
  const Icon = direction === 'up' ? ArrowUpRight : ArrowDownRight
  return (
    <section className="panel" aria-label={title}>
      <div className="panel-head">
        <div className="flex min-w-0 items-center gap-2">
          <Icon size={16} aria-hidden className={direction === 'up' ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'} />
          <div className="min-w-0">
            <h3>{title}</h3>
            <p>物理ML・20営業日の候補順位</p>
          </div>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-[13px] text-[var(--color-text-tertiary)]">候補データがまだ生成されていません</p>
      ) : (
        <div className="table-scroll">
          <table className="w-full min-w-[440px] text-[12px]">
            <thead>
              <tr className="border-b border-[var(--color-border-default)] text-left text-[11px] text-[var(--color-text-tertiary)]">
                <th className="w-12 px-4 py-2 font-semibold">順位</th>
                <th className="px-2 py-2 font-semibold">銘柄</th>
                <th className="px-2 py-2 text-right font-semibold">PMS</th>
                <th className="px-2 py-2 text-right font-semibold">PFS</th>
                <th className="px-4 py-2 text-right font-semibold">スコア</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {rows.map((row) => (
                <tr key={row.ticker} className="hover:bg-[var(--color-surface-subtle)]">
                  <td className="px-4 py-2 font-mono tabular-nums text-[var(--color-text-tertiary)]">{row.rank}</td>
                  <td className="max-w-0 px-2 py-2">
                    <Link href={`/us/stock/${encodeURIComponent(row.ticker)}#ml`} prefetch={false} className="flex min-w-0 items-baseline gap-2 hover:underline">
                      <span className="shrink-0 font-mono text-[13px] font-bold text-[var(--color-brand-800)]">{row.ticker}</span>
                      <span className="truncate text-[var(--color-text-secondary)]">{row.name ?? '名称未登録'}</span>
                    </Link>
                  </td>
                  <td className={`px-2 py-2 text-right font-mono tabular-nums ${toneClass(row.physical_momentum_score)}`}>{row.physical_momentum_score?.toFixed(2) ?? '-'}</td>
                  <td className={`px-2 py-2 text-right font-mono tabular-nums ${toneClass(row.physical_force_score)}`}>{row.physical_force_score?.toFixed(2) ?? '-'}</td>
                  <td className="px-4 py-2 text-right font-mono font-semibold tabular-nums text-[var(--color-text-primary)]">{row.candidate_score.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default async function UsHomePage() {
  const status = await getUsStatusSummary()
  const dashboard = await getUsDashboardRows(status.snapshots.latestDate)
  const stageCounts = new Map(dashboard.stageSummary.map((row) => [Number(row.label), Number(row.count)]))
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
  const pms = dashboard.pmsSummary
  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageTitle
        eyebrow="米国株"
        title="米国株ダッシュボード"
        subtitle="日足Aステージの市場構造を起点に、値動きの大きい銘柄と物理MLの候補を確認します。"
        meta={<>
          <span>価格基準日 {status.snapshots.latestDate ?? '未取得'}</span>
          <span>PMS基準日 {pms?.date ?? '未生成'}</span>
        </>}
        rightSlot={(
          <Link href="/us/screener?sort=changePct&dir=desc" prefetch={false} className="btn" data-variant="primary">
            <ListFilter size={14} aria-hidden />
            スクリーナーで絞り込む
          </Link>
        )}
      >
        <UsAnalysisNav current="/us" />
      </PageTitle>

      {/* 結論: 市場構造の判断と、その根拠になる構成比・PMS の要約 */}
      <section aria-labelledby="us-structure-title" className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          id="us-structure-title"
          level={1}
          title="今日の市場構造"
          description={`日足Aステージ ${fmt(stageTotal)}銘柄の構成比`}
        />
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="flex min-w-0 flex-col justify-center gap-1">
            <span className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">現在の判断</span>
            <strong className="text-[24px] font-bold leading-tight text-[var(--color-text-primary)]">{marketTone}</strong>
            <p className="m-0 text-[13px] leading-6 text-[var(--color-text-secondary)]">
              上昇構造(S1・S6) <b className="font-mono tabular-nums text-[var(--color-price-up)]">{constructivePct.toFixed(1)}%</b>
              {' '}／ 警戒構造(S3・S4) <b className="font-mono tabular-nums text-[var(--color-price-down)]">{cautionPct.toFixed(1)}%</b>。
              差が10ポイント未満のときは方向感を確認とします。
            </p>
          </div>
          <div className="min-w-0">
            {stageTotal > 0 ? (
              <div
                className="flex h-3 w-full overflow-hidden rounded-[3px] bg-[var(--color-surface-muted)]"
                role="img"
                aria-label={`ステージ構成比 ${Array.from({ length: 6 }, (_, i) => `S${i + 1} ${fmt(stageCounts.get(i + 1) ?? 0)}`).join('、')}`}
              >
                {Array.from({ length: 6 }, (_, index) => index + 1).map((stage) => {
                  const count = stageCounts.get(stage) ?? 0
                  if (count === 0) return null
                  return <span key={stage} style={{ width: `${(count / stageTotal) * 100}%`, background: `var(--color-stage-${stage}-text)` }} />
                })}
              </div>
            ) : null}
            <ul className="mt-2 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-border-soft)] sm:grid-cols-3 xl:grid-cols-6">
              {Array.from({ length: 6 }, (_, index) => index + 1).map((stage) => {
                const count = stageCounts.get(stage) ?? 0
                return (
                  <li key={stage} className="min-w-0 bg-white">
                    <Link
                      href={`/us/screener?stageCode=${stage}&sort=stageCode&dir=asc`}
                      prefetch={false}
                      className="flex h-full min-w-0 flex-col gap-1 px-3 py-2 hover:bg-[var(--color-surface-subtle)]"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <StageTag stage={stage} size="sm" />
                        <span className="truncate text-[11px] text-[var(--color-text-tertiary)]">{STAGE_LABELS[stage]}</span>
                      </span>
                      <span className="font-mono text-[17px] font-bold tabular-nums text-[var(--color-text-primary)]">{fmt(count)}</span>
                      <span className="text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{stageTotal > 0 ? `${((count / stageTotal) * 100).toFixed(1)}%` : '-'}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
        <StatStrip
          label="US市場 PMS"
          items={[
            { label: 'PMSプラス', value: `${fmt(pms?.positive)}銘柄`, tone: 'up' },
            { label: 'PMSマイナス', value: `${fmt(pms?.negative)}銘柄`, tone: 'down' },
            { label: '平均PMS', value: pms?.average_pms?.toFixed(2) ?? '-', sub: '市場全体との差の平均' },
            { label: '平均PFS', value: pms?.average_pfs?.toFixed(2) ?? '-', sub: '足元の力の向き' },
          ]}
        />
        <div className="flex flex-wrap gap-2">
          <Link href="/us/screener?sort=stageCode&dir=asc" prefetch={false} className="btn" data-size="sm">上昇構造の銘柄 <ChevronRight size={13} aria-hidden /></Link>
          <Link href="/us/screener?sort=stageCode&dir=desc" prefetch={false} className="btn" data-size="sm">警戒構造の銘柄 <ChevronRight size={13} aria-hidden /></Link>
          <Link href="/us/screener?sort=pms&dir=desc" prefetch={false} className="btn" data-size="sm">PMS順で確認 <ChevronRight size={13} aria-hidden /></Link>
          <Link href="/ai/research?market=US" prefetch={false} className="btn" data-size="sm" data-variant="ghost">AI銘柄リサーチ</Link>
          <Link href="/chart-drill?market=US" prefetch={false} className="btn" data-size="sm" data-variant="ghost">チャートドリル</Link>
        </div>
      </section>

      <section aria-labelledby="us-ranking-title" className="flex min-w-0 flex-col gap-3">
        <SectionHeader id="us-ranking-title" level={1} title="値動きランキング" description="前営業日比。極端な値・ワラント等は除外" />
        <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <RankingPanel title="上昇率" hint="前日比の上位" rows={dashboard.gainers} tone="up" />
          <RankingPanel title="下落率" hint="前日比の下位" rows={dashboard.losers} tone="down" />
          <RankingPanel title="出来高" hint="当日出来高の上位" rows={dashboard.volume} tone="volume" />
        </div>
      </section>

      <section aria-labelledby="us-ml-title" className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          id="us-ml-title"
          level={1}
          title="物理MLの候補"
          description="統計的な観測であり売買推奨ではありません"
          actions={<Link href="/us/analysis/ml-lens" prefetch={false} className="btn" data-size="sm" data-variant="ghost">US AI Lens <ChevronRight size={13} aria-hidden /></Link>}
        />
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <MlCandidatePanel title="上昇候補" rows={dashboard.mlUp} direction="up" />
          <MlCandidatePanel title="下落警戒" rows={dashboard.mlDown} direction="down" />
        </div>
      </section>

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
    </div>
  )
}
