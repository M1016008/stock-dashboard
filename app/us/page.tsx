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
        SELECT 'Stage1' AS label, SUM(CASE WHEN daily_a_stage = 1 THEN 1 ELSE 0 END) AS count
        FROM market_daily_snapshots INDEXED BY market_snapshots_market_date_idx WHERE market = 'US' AND date = ?
        UNION ALL
        SELECT 'Stage4' AS label, SUM(CASE WHEN daily_a_stage = 4 THEN 1 ELSE 0 END) AS count
        FROM market_daily_snapshots INDEXED BY market_snapshots_market_date_idx WHERE market = 'US' AND date = ?
        UNION ALL
        SELECT 'Stage6' AS label, SUM(CASE WHEN daily_a_stage = 6 THEN 1 ELSE 0 END) AS count
        FROM market_daily_snapshots INDEXED BY market_snapshots_market_date_idx WHERE market = 'US' AND date = ?
      `,
      [date, date, date],
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
  return (
    <div className="mx-auto flex w-full max-w-[1420px] flex-col gap-5">
      <PageTitle
        title="米国株ダッシュボード"
        subtitle="日本株ページと同じ分析体験へ寄せるためのUS市場ワークスペース。価格、6ステージ、スクリーニング、シナリオ分析を横断します。"
        badge="US Market"
      />
      <section className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader title="ユニバース" hint="market_universe / US" />
          <div className="text-[24px] font-bold text-[var(--color-brand-900)]">{fmt(status.universe.active)}</div>
          <div className="mt-1 text-[12px] font-semibold text-[var(--color-text-secondary)]">登録 {fmt(status.universe.total)} 銘柄</div>
        </Card>
        <Card>
          <CardHeader title="OHLCV" hint="米国株の日次価格データ" />
          <div className="text-[24px] font-bold text-[var(--color-brand-900)]">{fmt(status.ohlcv.tickers)}</div>
          <div className="mt-1 text-[12px] font-semibold text-[var(--color-text-secondary)]">
            {status.ohlcv.firstDate ?? '-'} 〜 {status.ohlcv.latestDate ?? '-'} / {fmt(status.ohlcv.rows)} 行{status.ohlcv.rowsApproximate ? '（概算）' : ''}
          </div>
        </Card>
        <Card>
          <CardHeader title="ステージ" hint="market_daily_snapshots / US" />
          <div className="text-[24px] font-bold text-[var(--color-brand-900)]">{fmt(status.snapshots.tickers)}</div>
          <div className="mt-1 text-[12px] font-semibold text-[var(--color-text-secondary)]">
            最新 {status.snapshots.latestDate ?? '-'}
          </div>
        </Card>
      </section>
      <Card size="lg">
        <CardHeader title="US機能" hint="個別銘柄は上部検索から直接開けます。固定サンプル銘柄は置きません。" />
        <div className="grid gap-3 md:grid-cols-4">
          <Link className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-4 text-[13px] font-bold text-[var(--color-brand-900)] hover:bg-white" href="/us/screener?sort=changePct&dir=desc">
            USスクリーナー
          </Link>
          <Link className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-4 text-[13px] font-bold text-[var(--color-brand-900)] hover:bg-white" href="/us/screener?sort=stageCode&dir=asc">
            US 6ステージ一覧
          </Link>
          <Link className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-4 text-[13px] font-bold text-[var(--color-brand-900)] hover:bg-white" href="/ai/research?market=US">
            AI銘柄リサーチ
          </Link>
          <Link className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-4 text-[13px] font-bold text-[var(--color-brand-900)] hover:bg-white" href="/chart-drill?market=US">
            チャートドリル
          </Link>
        </div>
      </Card>

      <section className="grid gap-4 xl:grid-cols-3">
        <RankingList title="US 上昇ランキング" rows={dashboard.gainers} tone="up" />
        <RankingList title="US 下落ランキング" rows={dashboard.losers} tone="down" />
        <RankingList title="US 出来高ランキング" rows={dashboard.volume} tone="volume" />
      </section>

      <Card>
        <CardHeader title="USステージ分布" hint="日足Aの現在ステージ。詳細はUSスクリーナーで6桁ステージを確認します。" />
        <div className="grid gap-3 sm:grid-cols-3">
          {dashboard.stageSummary.map((row) => (
            <div key={row.label} className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-4">
              <div className="text-[11px] font-black text-[var(--color-text-tertiary)]">{row.label}</div>
              <div className="mt-1 text-[24px] font-black text-[var(--color-brand-900)]">{fmt(row.count)}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
