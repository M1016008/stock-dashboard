import type { Metadata } from 'next'
import Link from 'next/link'
import { PageTitle } from '@/components/layout/PageTitle'
import { Card, CardHeader } from '@/components/ui/Card'
import { StageTag } from '@/components/ui/StageTag'
import { execAll } from '@/lib/db/client'
import { getUsStatusSummary } from '@/lib/us-status'
import { getUsDisplayName } from '@/lib/us-symbol-aliases'

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

async function getUsDashboardRows(date: string | null) {
  if (!date) {
    return {
      gainers: [] as RankingRow[],
      losers: [] as RankingRow[],
      volume: [] as RankingRow[],
      stageSummary: [] as StageSummaryRow[],
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
        cur.close AS price,
        cur.volume,
        CASE
          WHEN cur.volume > 0 AND prev.volume > 0 AND prev.close > 0 THEN 100.0 * (cur.close - prev.close) / prev.close
        END AS change_pct
      FROM market_ohlcv_daily cur INDEXED BY market_ohlcv_market_date_ticker_idx
      LEFT JOIN market_ohlcv_daily prev INDEXED BY market_ohlcv_market_ticker_date_idx
        ON prev.market = 'US'
       AND prev.ticker = cur.ticker
       AND prev.date = (SELECT date FROM prev_date)
      WHERE cur.market = 'US'
        AND cur.date = ?
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
  const [gainers, losers, volume, stageSummary] = await Promise.all([
    execAll<RankingRow>(rankingSql('change_pct DESC NULLS LAST'), [date, date, date]),
    execAll<RankingRow>(rankingSql('change_pct ASC NULLS LAST'), [date, date, date]),
    execAll<RankingRow>(rankingSql('cur.volume DESC NULLS LAST'), [date, date, date]),
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
  ])
  const withDisplayNames = (rows: RankingRow[]) => rows.map((row) => ({
    ...row,
    name: getUsDisplayName(row.ticker, row.name),
  }))
  return {
    gainers: withDisplayNames(gainers),
    losers: withDisplayNames(losers),
    volume: withDisplayNames(volume),
    stageSummary,
  }
}

function StageCode({ code }: { code: string | null | undefined }) {
  if (!code) return <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">------</span>
  return (
    <span className="inline-flex gap-0.5">
      {code.split('').slice(0, 6).map((digit, index) => (
        <StageTag key={`${digit}-${index}`} stage={Number(digit)} size="xs" />
      ))}
    </span>
  )
}

function RankingList({ title, rows, tone }: { title: string; rows: RankingRow[]; tone: 'up' | 'down' | 'volume' }) {
  const color = tone === 'down' ? 'text-blue-700' : tone === 'up' ? 'text-red-700' : 'text-[var(--color-brand-900)]'
  return (
    <Card>
      <CardHeader title={title} hint="クリックで個別銘柄へ" />
      <div className="grid gap-2">
        {rows.map((row) => (
          <Link
            key={row.ticker}
            href={`/us/stock/${encodeURIComponent(row.ticker)}`}
            className="grid grid-cols-[72px_1fr_auto] items-center gap-2 rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 hover:bg-white"
          >
            <span className="font-mono text-[13px] font-black text-[var(--color-brand-900)]">{row.ticker}</span>
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-bold text-[var(--color-text-primary)]">{row.name ?? row.ticker}</span>
              <span className="mt-0.5 flex items-center gap-2 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                {row.exchange ?? 'US'} <StageCode code={row.stage_code} />
              </span>
            </span>
            <span className="text-right">
              <span className="block text-[12px] font-black text-[var(--color-brand-900)]">{fmtMoney(row.price)}</span>
              <span className={`block text-[11px] font-black ${color}`}>
                {tone === 'volume' ? row.volume?.toLocaleString('en-US') ?? '-' : fmtPct(row.change_pct)}
              </span>
            </span>
          </Link>
        ))}
        {rows.length === 0 && <p className="py-4 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">データなし</p>}
      </div>
    </Card>
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
  return (
    <div className="mx-auto flex w-full max-w-[1420px] flex-col gap-5">
      <PageTitle
        title="米国株ダッシュボード"
        subtitle="6ステージの市場構造から、いま確認すべき銘柄と分析画面へ最短で移動します。"
        badge="US Market"
      />
      <Card size="lg">
        <CardHeader title="今日の市場構造" hint={`基準日 ${status.snapshots.latestDate ?? '-'} / 日足Aステージ`} />
        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr_1fr]">
          <div className="border-l-4 border-[var(--color-brand-900)] bg-[var(--color-surface-subtle)] px-4 py-3">
            <div className="text-[11px] font-black text-[var(--color-text-tertiary)]">現在の判断</div>
            <div className="mt-1 text-[22px] font-black text-[var(--color-brand-900)]">{marketTone}</div>
            <p className="mt-1 text-[12px] font-semibold leading-5 text-[var(--color-text-secondary)]">
              上昇構造 {constructivePct.toFixed(1)}% / 警戒構造 {cautionPct.toFixed(1)}%。ランキングと6ステージを併せて確認してください。
            </p>
          </div>
          <Link
            href="/us/screener?sort=stageCode&dir=asc"
            className="border border-[var(--color-border-default)] bg-white px-4 py-3 hover:bg-[var(--color-surface-subtle)]"
          >
            <div className="text-[11px] font-black text-[var(--color-text-tertiary)]">上昇構造 Stage 1・6</div>
            <div className="mt-1 text-[24px] font-black text-red-700">{fmt(constructiveCount)}</div>
            <div className="mt-1 text-[11px] font-bold text-[var(--color-brand-900)]">該当銘柄を開く →</div>
          </Link>
          <Link
            href="/us/screener?sort=stageCode&dir=desc"
            className="border border-[var(--color-border-default)] bg-white px-4 py-3 hover:bg-[var(--color-surface-subtle)]"
          >
            <div className="text-[11px] font-black text-[var(--color-text-tertiary)]">警戒構造 Stage 3・4</div>
            <div className="mt-1 text-[24px] font-black text-blue-700">{fmt(cautionCount)}</div>
            <div className="mt-1 text-[11px] font-bold text-[var(--color-brand-900)]">下落構造を確認 →</div>
          </Link>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {[
            ['/us/screener?sort=changePct&dir=desc', 'スクリーナー'],
            ['/ai/research?market=US', 'AI銘柄リサーチ'],
            ['/chart-drill?market=US', 'チャートドリル'],
            ['/watchlist', 'ウォッチリスト'],
          ].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[12px] font-black text-[var(--color-brand-900)] hover:bg-white"
            >
              {label}
            </Link>
          ))}
        </div>
      </Card>

      <section className="grid gap-4 xl:grid-cols-3">
        <RankingList title="US 上昇ランキング" rows={dashboard.gainers} tone="up" />
        <RankingList title="US 下落ランキング" rows={dashboard.losers} tone="down" />
        <RankingList title="US 出来高ランキング" rows={dashboard.volume} tone="volume" />
      </section>

      <Card>
        <CardHeader title="US 6ステージ分布" hint="日足Aの現在地。各ステージから該当銘柄へ絞り込めます。" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, index) => index + 1).map((stage) => (
            <Link
              key={stage}
              href={`/us/screener?stageCode=${stage}&sort=stageCode&dir=asc`}
              className="border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3 hover:bg-white"
            >
              <div className="flex items-center justify-between gap-2">
                <StageTag stage={stage} size="sm" />
                <span className="text-[10px] font-black text-[var(--color-text-tertiary)]">Stage {stage}</span>
              </div>
              <div className="mt-2 text-[22px] font-black text-[var(--color-brand-900)]">{fmt(stageCounts.get(stage) ?? 0)}</div>
            </Link>
          ))}
        </div>
      </Card>

      <details className="border border-[var(--color-border-default)] bg-white">
        <summary className="cursor-pointer px-4 py-3 text-[12px] font-black text-[var(--color-brand-900)]">
          データ基盤の健全性
        </summary>
        <div className="grid gap-3 border-t border-[var(--color-border-default)] p-4 md:grid-cols-3">
          <div>
            <div className="text-[11px] font-black text-[var(--color-text-tertiary)]">ユニバース</div>
            <div className="mt-1 text-[20px] font-black text-[var(--color-brand-900)]">{fmt(status.universe.active)} 銘柄</div>
            <div className="text-[11px] font-semibold text-[var(--color-text-secondary)]">登録 {fmt(status.universe.total)}</div>
          </div>
          <div>
            <div className="text-[11px] font-black text-[var(--color-text-tertiary)]">OHLCV</div>
            <div className="mt-1 text-[20px] font-black text-[var(--color-brand-900)]">{fmt(status.ohlcv.tickers)} 銘柄</div>
            <div className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
              {status.ohlcv.firstDate ?? '-'} 〜 {status.ohlcv.latestDate ?? '-'}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-black text-[var(--color-text-tertiary)]">6ステージ</div>
            <div className="mt-1 text-[20px] font-black text-[var(--color-brand-900)]">{fmt(status.snapshots.tickers)} 銘柄</div>
            <div className="text-[11px] font-semibold text-[var(--color-text-secondary)]">最新 {status.snapshots.latestDate ?? '-'}</div>
          </div>
        </div>
      </details>
    </div>
  )
}
