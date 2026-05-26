'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { StageTag } from '@/components/ui/StageTag'
import { BacktestHighlightChart, type HighlightChartPoint, type StageMarkerPoint } from '@/components/charts/BacktestHighlightChart'

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

type CaseStudy = {
  rank: number
  ticker: string
  name: string | null
  caseDate: string
  similarityScore: number
  stageCode: string | null
  maOrder: string | null
  sector17Name: string | null
  sector33Name: string | null
  pattern: string
  stagePath: string[]
  summary: string
  maComment: string
  hint: string
  returns: {
    week1: number | null
    week2: number | null
    week3: number | null
    maxWeek3: number | null
    minWeek3: number | null
  }
  chart?: {
    series: HighlightChartPoint[]
    highlightStart: string
    highlightEnd: string | null
    direction: 'up' | 'down'
    startPrice: number | null
    endPrice: number | null
    returnPct: number | null
    stagePath: StageMarkerPoint[]
  }
  evolution: Array<{
    afterDays: number
    date: string
    close: number | null
    stageCode: string | null
    maOrder: string | null
    sma5Velocity5: number | null
    sma25Velocity5: number | null
    sma75Velocity5: number | null
    gap5To25Pct: number | null
    gap25To75Pct: number | null
    trend: string | null
  }>
}

type ApiResponse = {
  asOfDate: string | null
  featureAsOfDate: string | null
  source: string | null
  similars: SimilarInsight[]
  caseStudies: CaseStudy[]
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

function fmtPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return Math.round(value).toLocaleString('ja-JP')
}

function stageTags(code: string | null | undefined) {
  if (!code) return <span style={{ color: 'var(--text-muted)' }}>------</span>
  return (
    <span style={{ display: 'inline-flex', gap: 2, verticalAlign: 'middle' }}>
      {code.split('').slice(0, 6).map((char, index) => (
        <StageTag key={`${char}-${index}`} stage={Number(char)} size="xs" />
      ))}
    </span>
  )
}

function trendLabel(value: string | null | undefined) {
  switch (value) {
    case 'up_acceleration': return '上向き加速'
    case 'up_deceleration': return '上向き鈍化'
    case 'down_acceleration': return '下向き加速'
    case 'down_deceleration': return '下向き鈍化'
    case 'sideways': return '横ばい'
    default: return '-'
  }
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
            featureAsOfDate: similarJson.featureAsOfDate ?? similarJson.asOfDate ?? null,
            source: similarJson.source ?? null,
            similars: Array.isArray(similarJson.similars) ? similarJson.similars : [],
            caseStudies: Array.isArray(similarJson.caseStudies) ? similarJson.caseStudies : [],
            predictions: Array.isArray(historyJson.rows) ? historyJson.rows : [],
          })
        }
      })
      .catch(() => {
        if (!cancelled) setData({ asOfDate: null, featureAsOfDate: null, source: null, similars: [], caseStudies: [], predictions: [] })
      })
    return () => { cancelled = true }
  }, [ticker])

  const rows = data?.similars ?? []
  const caseStudies = data?.caseStudies ?? []
  const predictions = data?.predictions ?? []

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="section-header" style={{ marginBottom: 8 }}>
        ML類似候補
      </div>
      <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        最新データ上で、6桁ステージと5/25/75/200日MAの角度・距離感が近い銘柄です。
        {data?.featureAsOfDate ? ` ML特徴量基準日: ${data.featureAsOfDate}` : data?.asOfDate ? ` 基準日: ${data.asOfDate}` : ''}
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {!data && Array.from({ length: 3 }).map((_, index) => (
          <div key={index} style={{ minHeight: 56, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--surface-muted)' }} />
        ))}
        {data && rows.length === 0 && (
          <div style={{
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            background: 'var(--surface-muted)',
            padding: 10,
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--text-muted)',
          }}>
            類似度90%以上のML類似候補は現在ありません。ML特徴量が未生成、または十分に近いMA形状がない場合は表示しません。
          </div>
        )}
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
                    {direction} / 類似度 {Math.round(row.similarityScore * 100)}% / {stageTags(row.payload.similar?.stageCode)}
                  </div>
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
                  {row.payload.similar?.sector17Name ?? '業種なし'}
                </div>
              </div>
              <div style={{ marginTop: 8, display: 'grid', gap: 4, fontSize: 11, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
                {['stage', 'maAngle', 'maAcceleration', 'maDistance', 'maDistanceFlow', 'pricePosition', 'context', 'risk'].map((key) => (
                  row.reason[key] ? <span key={key}>{row.reason[key]}</span> : null
                ))}
              </div>
            </div>
          )
        })}
        {caseStudies.length > 0 && (
          <div style={{ marginTop: 4, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)' }}>
                過去ケーススタディ
              </div>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)' }}>
                同じMA形状がその後どう動いたか
              </div>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {caseStudies.map((study) => (
                <div
                  key={`${study.ticker}-${study.caseDate}-${study.rank}`}
                  style={{
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 8,
                    background: 'var(--surface-muted)',
                    padding: 10,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <div>
                      <Link href={`/stock/${study.ticker}`} style={{ fontSize: 12, fontWeight: 900, color: 'var(--accent-primary)' }}>
                        {study.ticker} {study.name ?? ''}
                      </Link>
                      <div style={{ marginTop: 3, fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                        {study.caseDate} / {study.pattern} / 類似度 {Math.round(study.similarityScore * 100)}%
                      </div>
                    </div>
                    <div style={{ display: 'grid', gap: 3, justifyItems: 'end', fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>
                      <span>{stageTags(study.stageCode)}</span>
                      <span>{study.sector17Name ?? '業種なし'}</span>
                    </div>
                  </div>
                  <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                    <p style={{ margin: 0, fontSize: 11, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{study.summary}</p>
                    <p style={{ margin: 0, fontSize: 11, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{study.maComment}</p>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 10, fontWeight: 800 }}>
                      <span style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '3px 7px', background: 'white' }}>1週 {fmtPct(study.returns.week1)}</span>
                      <span style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '3px 7px', background: 'white' }}>2週 {fmtPct(study.returns.week2)}</span>
                      <span style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '3px 7px', background: 'white' }}>3週 {fmtPct(study.returns.week3)}</span>
                      <span style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '3px 7px', background: 'white' }}>最大 {fmtPct(study.returns.maxWeek3)}</span>
                      <span style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '3px 7px', background: 'white' }}>最小 {fmtPct(study.returns.minWeek3)}</span>
                    </div>
                    {study.chart && study.chart.series.length > 0 && (
                      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'white', padding: 8 }}>
                        <BacktestHighlightChart
                          series={study.chart.series}
                          highlightStart={study.chart.highlightStart}
                          highlightEnd={study.chart.highlightEnd}
                          direction={study.chart.direction}
                          stagePath={study.chart.stagePath}
                          startPrice={study.chart.startPrice}
                          endPrice={study.chart.endPrice}
                          returnPct={study.chart.returnPct}
                          height={220}
                        />
                      </div>
                    )}
                    {study.evolution.length > 0 && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 6 }}>
                        {study.evolution.map((point) => (
                          <div key={`${study.ticker}-${point.date}-${point.afterDays}`} style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'white', padding: 8 }}>
                            <div style={{ fontSize: 10, fontWeight: 900, color: 'var(--text-primary)' }}>
                              {point.afterDays === 0 ? '発生日' : `${point.afterDays}営業日後`}
                            </div>
                            <div style={{ marginTop: 3, fontSize: 10, color: 'var(--text-muted)', fontWeight: 700 }}>{point.date}</div>
                            <div style={{ marginTop: 5, display: 'grid', gap: 3, fontSize: 10, color: 'var(--text-secondary)', fontWeight: 700 }}>
                              <span>{stageTags(point.stageCode)}</span>
                              <span>終値 {fmtPrice(point.close)}円</span>
                              <span>5日MA {fmtPct(point.sma5Velocity5)}</span>
                              <span>25日MA {fmtPct(point.sma25Velocity5)}</span>
                              <span>5-25距離 {fmtPct(point.gap5To25Pct)}</span>
                              <span>{trendLabel(point.trend)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {study.stagePath.length > 0 && (
                      <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-secondary)', fontWeight: 700 }}>
                        ステージ遷移: {study.stagePath.join(' → ')}
                      </div>
                    )}
                    <p style={{ margin: 0, fontSize: 11, lineHeight: 1.6, color: 'var(--text-primary)', fontWeight: 700 }}>
                      {study.hint}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
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
