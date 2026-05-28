import Link from 'next/link'
import { PageTitle } from '@/components/layout/PageTitle'
import { Card, CardHeader } from '@/components/ui/Card'
import { getUsStatusSummary } from '@/lib/us-status'

export const dynamic = 'force-dynamic'
export const revalidate = 0

function fmt(value: number | null | undefined) {
  return Number(value ?? 0).toLocaleString('ja-JP')
}

export default async function UsHomePage() {
  const status = await getUsStatusSummary()
  return (
    <div className="mx-auto flex w-full max-w-[1420px] flex-col gap-5">
      <PageTitle
        title="US StockBoard"
        subtitle="Tiingo EODを原本に、米国株の価格・ステージ・ML横展開を行う市場別ワークスペース"
        badge="US / Tiingo"
      />
      <section className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader title="ユニバース" hint="market_universe / US" />
          <div className="text-[24px] font-bold text-[var(--color-brand-900)]">{fmt(status.universe.active)}</div>
          <div className="mt-1 text-[12px] font-semibold text-[var(--color-text-secondary)]">登録 {fmt(status.universe.total)} 銘柄</div>
        </Card>
        <Card>
          <CardHeader title="OHLCV" hint="market_ohlcv_daily / Tiingo" />
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
        <CardHeader title="US機能" hint="JP版を壊さず、市場別ルートで並走します。" />
        <div className="grid gap-3 md:grid-cols-3">
          <Link className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-4 text-[13px] font-bold text-[var(--color-brand-900)] hover:bg-white" href="/us/screener">
            USスクリーナー
          </Link>
          <Link className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-4 text-[13px] font-bold text-[var(--color-brand-900)] hover:bg-white" href="/us/stock/AAPL">
            個別銘柄サンプル AAPL
          </Link>
          <Link className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-4 text-[13px] font-bold text-[var(--color-brand-900)] hover:bg-white" href="/ai/ma-lens">
            AI Lens
          </Link>
        </div>
      </Card>
    </div>
  )
}
