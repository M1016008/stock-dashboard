'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

type SimilarInsight = {
  rank: number
  similarTicker: string
  similarityScore: number
  similarDirection: 'up' | 'down' | null
  payload: {
    similar?: {
      name?: string | null
      stageCode?: string | null
      maOrder?: string | null
      sector17Name?: string | null
      sector33Name?: string | null
    }
  }
  reason: Record<string, string>
}

type ApiResponse = {
  asOfDate: string | null
  similars: SimilarInsight[]
  predictions: Array<{
    asOfDate: string
    horizonDays: number
    direction: 'up' | 'down'
    rank: number
    score: number
    modelName: string | null
    outcome: {
      returnPct: number | null
      maxReturnPct: number | null
      minReturnPct: number | null
      hitLabel: boolean
    } | null
  }>
}

function fmtPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

export function StockMlInsights({ ticker }: { ticker: string }) {
  const [data, setData] = useState<ApiResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    const code = encodeURIComponent(ticker.replace(/\.T$/i, ''))
    Promise.all([
      fetch(`/api/ml/current-similars?ticker=${code}&limit=6`, { cache: 'no-store' }).then((res) => res.json()),
      fetch(`/api/ml/prediction-history?ticker=${code}&limit=8`, { cache: 'no-store' }).then((res) => res.json()),
    ])
      .then(([similarJson, historyJson]) => {
        if (!cancelled) {
          setData({
            asOfDate: similarJson.asOfDate ?? null,
            similars: Array.isArray(similarJson.similars) ? similarJson.similars : [],
            predictions: Array.isArray(historyJson.rows) ? historyJson.rows : [],
          })
        }
      })
      .catch(() => {
        if (!cancelled) setData({ asOfDate: null, similars: [], predictions: [] })
      })
    return () => { cancelled = true }
  }, [ticker])

  const rows = data?.similars ?? []
  const predictions = data?.predictions ?? []
  if (data && rows.length === 0 && predictions.length === 0) return null

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="section-header" style={{ marginBottom: 8 }}>
        ML類似候補
      </div>
      <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        最新データ上で、6桁ステージと5/25/75/200日MAの角度・距離感が近い銘柄です。
        {data?.asOfDate ? ` 基準日: ${data.asOfDate}` : ''}
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {!data && Array.from({ length: 3 }).map((_, index) => (
          <div key={index} style={{ minHeight: 56, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--surface-muted)' }} />
        ))}
        {data && rows.map((row) => {
          const direction = row.similarDirection === 'up' ? '上昇候補' : row.similarDirection === 'down' ? '下落警戒' : '近似形状'
          return (
            <div
              key={`${row.similarTicker}-${row.rank}`}
              style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 8,
                background: 'white',
                padding: 10,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <div>
                  <Link href={`/stock/${row.similarTicker}`} style={{ fontWeight: 800, color: 'var(--accent-primary)' }}>
                    {row.similarTicker} {row.payload.similar?.name ?? ''}
                  </Link>
                  <div style={{ marginTop: 3, fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
                    {direction} / 類似度 {Math.round(row.similarityScore * 100)}% / {row.payload.similar?.stageCode ?? '------'}
                  </div>
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
                  {row.payload.similar?.sector17Name ?? '業種なし'}
                </div>
              </div>
              <div style={{ marginTop: 8, display: 'grid', gap: 4, fontSize: 11, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
                {['stage', 'maAngle', 'maDistance', 'pricePosition'].map((key) => (
                  row.reason[key] ? <span key={key}>{row.reason[key]}</span> : null
                ))}
              </div>
            </div>
          )
        })}
        {predictions.length > 0 && (
          <div style={{ marginTop: 4, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8 }}>
              過去のML予測と実績
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {predictions.slice(0, 4).map((row) => (
                <div
                  key={`${row.asOfDate}-${row.horizonDays}-${row.direction}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(86px, 1fr) minmax(70px, auto) minmax(70px, auto)',
                    gap: 8,
                    alignItems: 'center',
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span>{row.asOfDate} / {row.horizonDays}日</span>
                  <span>{row.direction === 'up' ? '上昇候補' : '下落警戒'} #{row.rank}</span>
                  <span>
                    {row.outcome
                      ? `${row.outcome.hitLabel ? '的中' : '未達'} / ${fmtPct(row.outcome.returnPct)}`
                      : '結果待ち'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
