// app/stock/[ticker]/StockDetailClient.tsx
'use client'

import { useEffect, useState } from 'react'
import { MarketBadge } from '@/components/ui/MarketBadge'
import { PriceDisplay } from '@/components/ui/PriceDisplay'
import { TradingViewChart } from '@/components/charts/TradingViewChart'
import { AddHoldingModal } from '@/components/portfolio/AddHoldingModal'
import { PerformanceCard } from '@/components/stock/PerformanceCard'
import { StageTimeline } from '@/components/stock/StageTimeline'
import { findTicker } from '@/lib/master/tickers'
import type { StockQuote, Fundamentals } from '@/types/stock'

interface StockDetailClientProps {
  ticker: string
}

export function StockDetailClient({ ticker }: StockDetailClientProps) {
  const [quote, setQuote] = useState<StockQuote | null>(null)
  const [fundamentals, setFundamentals] = useState<Fundamentals | null>(null)
  const [loading, setLoading] = useState(true)
  const [showPortfolioModal, setShowPortfolioModal] = useState(false)

  const master = findTicker(ticker)

  useEffect(() => {
    let cancelled = false
    async function fetchData() {
      setLoading(true)
      try {
        const [quoteRes, fundamentalRes] = await Promise.all([
          fetch(`/api/quote/${encodeURIComponent(ticker)}`),
          fetch(`/api/fundamentals/${encodeURIComponent(ticker)}`),
        ])
        if (cancelled) return
        if (quoteRes.ok) setQuote(await quoteRes.json())
        if (fundamentalRes.ok) setFundamentals(await fundamentalRes.json())
      } catch (error) {
        console.error('Failed to fetch stock data:', error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchData()
    return () => { cancelled = true }
  }, [ticker])

  const isJP = ticker.endsWith('.T')
  const market = isJP ? 'JP' : 'US'
  const displayCode = ticker.replace('.T', '')
  const name = master?.name ?? quote?.name ?? '---'

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* ヘッダー */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        borderBottom: '1px solid var(--border-subtle)',
        paddingBottom: '12px',
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '22px',
            fontWeight: 700,
            color: 'var(--accent-primary)',
          }}>
            {displayCode}
          </span>
          <MarketBadge market={market} />
        </div>

        <span style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 600 }}>
          {name}
        </span>

        {master && (
          <div style={{ display: 'flex', gap: '6px' }}>
            <Pill label={master.sectorLarge} />
            <Pill label={master.marketSegment} />
            {master.marginType && <Pill label={master.marginType} accent />}
          </div>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px' }}>
          {quote && (
            <PriceDisplay
              value={quote.price}
              change={quote.change}
              changePercent={quote.changePercent}
              currency={quote.currency}
              size="lg"
            />
          )}
          {loading && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>読込中...</span>}
          <button onClick={() => setShowPortfolioModal(true)} style={{
            padding: '6px 12px',
            background: 'var(--accent-primary)',
            color: '#fff',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            cursor: 'pointer',
          }}>
            + ポートフォリオに追加
          </button>
        </div>
      </div>

      {/* 基本情報 + 直近変化率 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '12px' }}>
        <BasicInfoCard
          ticker={ticker}
          quote={quote}
          fundamentals={fundamentals}
          market={market}
        />
        <PerformanceCard ticker={ticker} />
      </div>

      {/* TradingView チャート（メイン） */}
      <div>
        <div className="section-header">株価チャート（TradingView）</div>
        <TradingViewChart
          ticker={ticker}
          market={market}
          height={520}
          maLines={[5, 25, 75]}
        />
      </div>

      {/* ステージ変遷 */}
      <div>
        <div className="section-header">ステージ変遷（週ごと）</div>
        <StageTimeline ticker={ticker} />
      </div>

      <AddHoldingModal
        open={showPortfolioModal}
        onClose={() => setShowPortfolioModal(false)}
        fixedTicker={ticker}
        fixedName={quote?.name ?? master?.name}
        fixedMarket={market}
      />
    </div>
  )
}

function Pill({ label, accent }: { label: string; accent?: boolean }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      fontSize: '10px',
      fontFamily: 'var(--font-mono)',
      background: accent ? 'var(--accent-dim)' : 'var(--bg-elevated)',
      color: accent ? 'var(--accent-primary)' : 'var(--text-secondary)',
      border: `1px solid ${accent ? 'var(--accent-primary)' : 'var(--border-base)'}`,
      borderRadius: 'var(--radius-sm)',
    }}>
      {label}
    </span>
  )
}

function BasicInfoCard({
  ticker,
  quote,
  fundamentals,
  market,
}: {
  ticker: string
  quote: StockQuote | null
  fundamentals: Fundamentals | null
  market: 'JP' | 'US'
}) {
  const items = [
    { label: '時価総額', value: quote?.marketCap ? `${(quote.marketCap / 1e8).toLocaleString('ja-JP', { maximumFractionDigits: 0 })} 億${market === 'JP' ? '円' : 'USD'}` : '---' },
    { label: '出来高', value: quote?.volume ? quote.volume.toLocaleString('ja-JP') : '---' },
    { label: '52週高値', value: quote?.fiftyTwoWeekHigh != null ? quote.fiftyTwoWeekHigh.toLocaleString('ja-JP') : '---' },
    { label: '52週安値', value: quote?.fiftyTwoWeekLow != null ? quote.fiftyTwoWeekLow.toLocaleString('ja-JP') : '---' },
    { label: 'PER', value: fundamentals?.per != null ? `${fundamentals.per.toFixed(1)}x` : '---' },
    { label: 'PBR', value: fundamentals?.pbr != null ? `${fundamentals.pbr.toFixed(2)}x` : '---' },
    { label: 'ROE', value: fundamentals?.roe != null ? `${fundamentals.roe.toFixed(1)}%` : '---' },
    { label: '配当利回り', value: fundamentals?.dividendYield != null ? `${fundamentals.dividendYield.toFixed(2)}%` : '---' },
  ]

  return (
    <div className="card" style={{ padding: '12px' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px' }}>基本情報</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '4px 8px' }}>
        {items.map(({ label, value }) => (
          <div key={label} style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            padding: '4px 0',
            borderBottom: '1px solid var(--border-subtle)',
          }}>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{label}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-primary)' }}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
