// app/page.tsx
import type { Metadata } from 'next'
import { IndexCard } from '@/components/dashboard/IndexCard'
import { IndicesChart } from '@/components/dashboard/IndicesChart'
import { HexStageSummary } from '@/components/dashboard/HexStageSummary'
import { EarningsCalendar } from '@/components/dashboard/EarningsCalendar'

export const metadata: Metadata = {
  title: 'ダッシュボード — StockBoard',
  description: '日本株のスクリーナー、HEXステージ分析、決算カレンダーを一覧表示。',
}

// 日本市場の主要指数。Yahoo Finance で取得可能なものを採用。
//   - 日経225 (^N225): 日本を代表する 225 銘柄の株価平均型指数
//   - TOPIX (^TPX):    東証一部全銘柄を対象とした時価総額加重平均
//   - JPX日経400:      JPX-Nikkei400 連動 ETF (1591.T) を代用
//   - グロース250:     東証グロース市場250 連動 ETF (1563.T) を代用
const INDICES = [
  { label: '日経225',     ticker: '^N225',  note: '指数' },
  { label: 'TOPIX',       ticker: '^TPX',   note: '指数' },
  { label: 'JPX日経400',  ticker: '1591.T', note: 'ETF' },
  { label: 'グロース250', ticker: '1563.T', note: 'ETF' },
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
          日本株専用サマリー
        </p>
      </div>

      {/* インデックスカード行 */}
      <section>
        <div className="section-header">主要指数</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
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

    </div>
  )
}
