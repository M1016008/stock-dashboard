'use client'

import { useEffect, useState } from 'react'
import type { MarketCode } from '@/lib/markets'
import type { MaTrajectoryProjectionResponse } from '@/lib/ma-trajectory/core'
import { MaTrajectoryProjectionChart } from '@/components/stock/MaTrajectoryProjectionChart'
import { ScenarioProjectionChart } from '@/components/stock/ScenarioProjectionChart'

type Props = {
  ticker: string
  name: string
  analysisDate?: string | null
  showActual?: boolean
  market?: MarketCode
  onUseLatest?: () => void
}

export function FutureScenarioPanel(props: Props) {
  const market = props.market === 'US' ? 'US' : 'JP'
  const [projection, setProjection] = useState<MaTrajectoryProjectionResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'ma' | 'price'>('ma')

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const params = new URLSearchParams({ market, horizon: '60' })
    if (props.analysisDate) params.set('date', props.analysisDate)
    setLoading(true)
    fetch(`/api/ma-trajectory-projections/${encodeURIComponent(props.ticker)}?${params}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then((response) => response.json() as Promise<MaTrajectoryProjectionResponse>)
      .then((response) => {
        if (active) setProjection(response)
      })
      .catch((error) => {
        if (active && (error as Error).name !== 'AbortError') {
          console.error('MA trajectory projection fetch failed:', error)
          setProjection(null)
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [market, props.analysisDate, props.ticker])

  if (loading) {
    return (
      <div aria-live="polite" style={loadingPanelStyle}>
        将来シナリオを読み込み中
      </div>
    )
  }

  if (!projection?.available) return <ScenarioProjectionChart {...props} />

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14, minWidth: 0 }}>
      <div role="tablist" aria-label="将来シナリオ表示" style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)' }}>
        <button type="button" role="tab" aria-selected={tab === 'ma'} onClick={() => setTab('ma')} style={{ ...tabStyle, ...(tab === 'ma' ? selectedTabStyle : {}) }}>
          MA軌道
        </button>
        <button type="button" role="tab" aria-selected={tab === 'price'} onClick={() => setTab('price')} style={{ ...tabStyle, ...(tab === 'price' ? selectedTabStyle : {}) }}>
          従来価格
        </button>
      </div>
      {tab === 'ma' ? (
        <MaTrajectoryProjectionChart
          ticker={props.ticker}
          market={market}
          analysisDate={props.analysisDate}
          initialData={projection}
        />
      ) : (
        <ScenarioProjectionChart {...props} />
      )}
    </div>
  )
}

const tabStyle: React.CSSProperties = {
  border: 0,
  borderBottom: '2px solid transparent',
  background: 'transparent',
  color: 'var(--text-secondary)',
  fontWeight: 600,
  padding: '8px 14px',
  cursor: 'pointer',
}

const selectedTabStyle: React.CSSProperties = {
  borderBottomColor: '#111827',
  color: 'var(--text-primary)',
}

const loadingPanelStyle: React.CSSProperties = {
  display: 'grid',
  minHeight: 96,
  placeItems: 'center',
  color: 'var(--text-secondary)',
  fontSize: 13,
}
