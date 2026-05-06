// components/charts/TradingViewChart.tsx
'use client'

import { useEffect, useRef, useState } from 'react'

interface TradingViewChartProps {
  ticker: string
  height?: number
  maLines?: number[]
}

function toTradingViewSymbol(ticker: string): string {
  const code = ticker.replace('.T', '')
  return `TSE:${code}`
}

const MA_COLORS: Record<number, string> = {
  5: 'rgb(255, 255, 255)',
  25: 'rgb(245, 166, 35)',
  75: 'rgb(64, 128, 255)',
  200: 'rgb(168, 85, 247)',
}

export function TradingViewChart({
  ticker,
  height = 500,
  maLines = [5, 25, 75],
}: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetRef = useRef<TradingViewWidgetInstance | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedMAs, setSelectedMAs] = useState<number[]>(maLines)

  const containerId = `tv-chart-${ticker.replace(/[^a-zA-Z0-9]/g, '_')}`
  const symbol = toTradingViewSymbol(ticker)

  useEffect(() => {
    if (typeof window === 'undefined') return

    let script: HTMLScriptElement | null = null
    let mounted = true

    const initWidget = () => {
      if (!mounted || !containerRef.current) return

      // コンテナをクリア
      if (containerRef.current) {
        containerRef.current.innerHTML = ''
        const widgetContainer = document.createElement('div')
        widgetContainer.id = containerId
        containerRef.current.appendChild(widgetContainer)
      }

      const widget = new window.TradingView.widget({
        symbol,
        interval: 'D',
        timezone: 'Asia/Tokyo',
        theme: 'dark',
        style: '1',
        locale: 'ja',
        toolbar_bg: '#0d1520',
        enable_publishing: false,
        hide_top_toolbar: false,
        hide_legend: false,
        save_image: false,
        height,
        width: '100%',
        container_id: containerId,
        autosize: false,
      })

      widgetRef.current = widget

      widget.onChartReady(() => {
        if (!mounted) return
        selectedMAs.forEach((period) => {
          widget.activeChart().createStudy(
            'Moving Average',
            false,
            false,
            { length: period },
            { 'Plot.color': MA_COLORS[period] ?? 'rgb(255,255,255)' }
          )
        })
        setLoading(false)
      })
    }

    // TradingViewスクリプトが既に読み込まれているか確認
    if (window.TradingView) {
      initWidget()
    } else {
      script = document.createElement('script')
      script.src = 'https://s3.tradingview.com/tv.js'
      script.async = true
      script.onload = initWidget
      document.head.appendChild(script)
    }

    return () => {
      mounted = false
      if (widgetRef.current) {
        try {
          widgetRef.current.remove()
        } catch {}
        widgetRef.current = null
      }
    }
  }, [ticker, selectedMAs, containerId, symbol, height])

  const toggleMA = (period: number) => {
    setSelectedMAs(prev =>
      prev.includes(period) ? prev.filter(p => p !== period) : [...prev, period]
    )
  }

  return (
    <div>
      {/* MAチェックボックス */}
      <div style={{
        display: 'flex',
        gap: '12px',
        alignItems: 'center',
        padding: '8px 0',
        marginBottom: '8px',
      }}>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>MA:</span>
        {[5, 25, 75, 200].map(period => (
          <label key={period} style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            cursor: 'pointer',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
          }}>
            <input
              type="checkbox"
              checked={selectedMAs.includes(period)}
              onChange={() => toggleMA(period)}
              style={{ accentColor: MA_COLORS[period] }}
            />
            <span style={{ color: MA_COLORS[period] }}>{period}</span>
          </label>
        ))}
      </div>

      {/* チャートコンテナ */}
      <div style={{ position: 'relative', height }}>
        {loading && (
          <div style={{
            position: 'absolute',
            inset: 0,
            background: 'var(--bg-surface)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1,
            animation: 'pulse 2s infinite',
          }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
              チャート読込中... {symbol}
            </span>
          </div>
        )}
        <div ref={containerRef} style={{ height }} />
      </div>
    </div>
  )
}
