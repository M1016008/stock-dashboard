// components/stock/NewsSection.tsx
'use client'

import { useEffect, useState } from 'react'

interface NewsItem {
  title: string
  url: string
  source: string
  publishedAt: string
  imageUrl?: string
  summary?: string
}

interface NewsResponse {
  items: NewsItem[]
  sources: { yahoo: number; googleNews: number }
}

interface Props {
  ticker: string
}

export function NewsSection({ ticker }: Props) {
  const [data, setData] = useState<NewsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    fetch(`/api/news/${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        setData(d as NewsResponse)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [ticker])

  if (loading) {
    return (
      <div className="card" style={{ padding: '24px', textAlign: 'center' }}>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>ニュース読込中…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--price-down)' }}>
        <p style={{ fontSize: '12px', color: 'var(--price-down)', margin: 0 }}>
          ニュース取得エラー: {error}
        </p>
      </div>
    )
  }

  if (!data || data.items.length === 0) {
    return (
      <div className="card" style={{ padding: '24px', textAlign: 'center' }}>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>関連ニュースが見つかりませんでした</p>
      </div>
    )
  }

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--border-subtle)',
        fontSize: '11px',
        color: 'var(--text-muted)',
        display: 'flex',
        gap: '12px',
        flexWrap: 'wrap',
      }}>
        <span>{data.items.length}件</span>
        {data.sources.yahoo > 0 && <span>Yahoo: {data.sources.yahoo}</span>}
        {data.sources.googleNews > 0 && <span>Google News: {data.sources.googleNews}</span>}
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {data.items.map((n, i) => (
          <li
            key={n.url}
            style={{
              borderBottom: i < data.items.length - 1 ? '1px solid var(--border-subtle)' : 'none',
              padding: '12px',
            }}
          >
            <a
              href={n.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                gap: '12px',
                alignItems: 'flex-start',
                textDecoration: 'none',
                color: 'inherit',
              }}
            >
              {n.imageUrl && (
                <img
                  src={n.imageUrl}
                  alt=""
                  loading="lazy"
                  style={{
                    width: '88px',
                    height: '64px',
                    objectFit: 'cover',
                    borderRadius: 'var(--radius-sm)',
                    flexShrink: 0,
                    background: 'var(--bg-elevated)',
                  }}
                />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  marginBottom: '4px',
                  lineHeight: 1.4,
                }}>
                  {n.title}
                </div>
                {n.summary && (
                  <div style={{
                    fontSize: '11px',
                    color: 'var(--text-secondary)',
                    marginBottom: '4px',
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }}>
                    {n.summary}
                  </div>
                )}
                <div style={{
                  fontSize: '10px',
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)',
                  display: 'flex',
                  gap: '8px',
                }}>
                  <span>{n.source}</span>
                  <span>·</span>
                  <span>{formatDate(n.publishedAt)}</span>
                </div>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMin = Math.floor(diffMs / 60_000)
    const diffHour = Math.floor(diffMin / 60)
    const diffDay = Math.floor(diffHour / 24)
    if (diffMin < 60) return `${diffMin}分前`
    if (diffHour < 24) return `${diffHour}時間前`
    if (diffDay < 7) return `${diffDay}日前`
    return d.toISOString().split('T')[0]
  } catch {
    return iso
  }
}
