'use client'

import { useEffect, useState } from 'react'
import { BacktestHighlightChart, type HighlightChartPoint } from '@/components/charts/BacktestHighlightChart'

type Move = {
  direction: 'up' | 'down'
  rank: number
  startDate: string
  endDate: string
  startPrice: number | null
  endPrice: number | null
  returnPct: number | null
  tradingDays: number | null
  stagePath: Array<{ date: string; code: string }>
  chartSeries: HighlightChartPoint[]
  volumeSummary: {
    comment: string
    periodAverage: number | null
    maxVolume: number | null
    maxVolumeDate: string | null
  } | null
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function fmtNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return Math.round(value).toLocaleString('ja-JP')
}

function stagePathText(path: Array<{ date: string; code: string }>): string {
  if (path.length === 0) return '-'
  return path.map((item) => item.code).join(' → ')
}

export function StockMovePeriods({ ticker }: { ticker: string }) {
  const [moves, setMoves] = useState<Move[]>([])
  const [openKey, setOpenKey] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/stock-move-periods/${encodeURIComponent(ticker)}?limit=8`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        setMoves(Array.isArray(data.moves) ? data.moves : [])
      })
      .catch(() => { if (!cancelled) setMoves([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [ticker])

  if (loading) {
    return <div className="card stock-move-card">過去の上昇・下落局面を読込中...</div>
  }
  if (moves.length === 0) return null

  return (
    <div className="card stock-move-card">
      <div className="stock-move-head">
        <div>
          <h2>過去の上昇・下落局面</h2>
          <p>大きく動いた期間と、その間の出来高・6桁ステージ遷移を確認します。</p>
        </div>
      </div>
      <div className="stock-move-list">
        {moves.map((move) => {
          const key = `${move.direction}-${move.rank}`
          const isOpen = openKey === key
          return (
            <div className="stock-move-item" key={key}>
              <button type="button" onClick={() => setOpenKey(isOpen ? '' : key)}>
                <span data-direction={move.direction}>{move.direction === 'up' ? '上昇' : '下落'}</span>
                <strong>{move.startDate}〜{move.endDate}</strong>
                <b className={move.direction === 'up' ? 'price-up' : 'price-down'}>{fmtPct(move.returnPct)}</b>
                <small>{move.tradingDays ?? '-'}営業日</small>
              </button>
              {isOpen && (
                <div className="stock-move-detail">
                  <p>
                    {move.startDate}から{move.endDate}までに、株価が{fmtPct(move.returnPct)}動きました。
                    開始価格は{fmtNum(move.startPrice)}円、終了価格は{fmtNum(move.endPrice)}円です。
                  </p>
                  <dl>
                    <div><dt>出来高</dt><dd>{move.volumeSummary?.comment ?? '-'}</dd></div>
                    <div><dt>期間平均出来高</dt><dd>{fmtNum(move.volumeSummary?.periodAverage)}</dd></div>
                    <div><dt>最大出来高</dt><dd>{fmtNum(move.volumeSummary?.maxVolume)} / {move.volumeSummary?.maxVolumeDate ?? '-'}</dd></div>
                    <div><dt>ステージ遷移</dt><dd>{stagePathText(move.stagePath)}</dd></div>
                  </dl>
                  <BacktestHighlightChart
                    series={move.chartSeries}
                    highlightStart={move.startDate}
                    highlightEnd={move.endDate}
                    direction={move.direction}
                    startPrice={move.startPrice}
                    endPrice={move.endPrice}
                    returnPct={move.returnPct}
                    height={240}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
