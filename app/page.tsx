// app/page.tsx
import Link from 'next/link'
import type { Metadata } from 'next'
import { IndexCard } from '@/components/dashboard/IndexCard'
import { IndicesChart } from '@/components/dashboard/IndicesChart'
import { HexStageSummary } from '@/components/dashboard/HexStageSummary'
import { HighLowPreview } from '@/components/dashboard/HighLowPreview'
import { EarningsCalendar } from '@/components/dashboard/EarningsCalendar'

export const metadata: Metadata = {
  title: 'ダッシュボード — StockBoard',
  description: '日本株・米国株のリアルタイム分析。インデックス、HEXステージ分布、新高値・新安値を一覧表示。',
}

const INDICES = [
  { label: '日経225', ticker: '^N225', note: 'JPX' },
  { label: 'TOPIX', ticker: '^TOPX', note: 'JPX' },
  { label: 'S&P 500', ticker: '^GSPC', note: 'NYSE' },
  { label: 'NASDAQ', ticker: '^IXIC', note: 'NASDAQ' },
] as const

export default function DashboardPage() {
  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* ページヘッダー */}
      <div style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '12px' }}>
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '16px',
          fontWeight: 700,
          color: 'var(--text-primary)',
          letterSpacing: '0.02em',
        }}>
          ダッシュボード
        </h1>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          日本株・米国株の総合サマリー
        </p>
      </div>

      {/* インデックスカード行 */}
      <section>
        <div className="section-header">主要指数</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
          {INDICES.map((idx) => (
            <IndexCard key={idx.ticker} {...idx} />
          ))}
        </div>
      </section>

      {/* 主要指数チャート */}
      <section>
        <div className="section-header">指数チャート（日/週/月/年足、移動平均切替可）</div>
        <IndicesChart />
      </section>

      {/* HEXステージ分布 */}
      <section>
        <div className="section-header">HEXステージ分布</div>
        <HexStageSummary />
      </section>

      {/* 決算カレンダー */}
      <section>
        <div className="section-header">決算カレンダー</div>
        <EarningsCalendar defaultDays={14} />
      </section>

      {/* 新高値・新安値 */}
      <section>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <div>
            <div className="section-header">
              📈 本日の新高値（年初来＋上場来）
              <Link href="/high-low" style={{ float: 'right', color: 'var(--accent-primary)', fontSize: '10px', textDecoration: 'none' }}>
                もっと見る→
              </Link>
            </div>
            <HighLowPreview type="high" />
          </div>
          <div>
            <div className="section-header">
              📉 本日の新安値（年初来＋上場来）
              <Link href="/high-low" style={{ float: 'right', color: 'var(--accent-primary)', fontSize: '10px', textDecoration: 'none' }}>
                もっと見る→
              </Link>
            </div>
            <HighLowPreview type="low" />
          </div>
        </div>
      </section>

    </div>
  )
}
