// components/stock/EarningsCard.tsx
'use client'

import { useEffect, useState } from 'react'

interface SnapshotInfo {
  ticker: string
  date: string | null
  earningsLastDate: string | null
  earningsNextDate: string | null
  earningsLastSource?: string | null
  earningsLastFiscalPeriod?: string | null
  earningsNextSource?: string | null
  earningsNextFiscalPeriod?: string | null
  earningsNextDateKind?: 'confirmed' | 'estimated' | 'cached' | 'not_announced' | 'not_applicable' | 'no_history' | null
  earningsNextNote?: string | null
  earningsCalendarLatestKnownDate?: string | null
  earningsCalendarLatestImportedAt?: number | null
  earningsScheduleLatestKnownDate?: string | null
  earningsScheduleLatestImportedAt?: number | null
}

interface Props {
  ticker: string
}

export function EarningsCard({ ticker }: Props) {
  const [data, setData] = useState<SnapshotInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/stock-snapshot/${encodeURIComponent(ticker)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setData(d) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [ticker])

  if (loading) {
    return (
      <div className="card" style={{ padding: '12px', fontSize: '11px', color: 'var(--text-muted)' }}>
        決算情報読込中…
      </div>
    )
  }

  if (!data || (!data.earningsLastDate && !data.earningsNextDate)) {
    return null
  }

  const today = todayIsoJst()
  const daysToNext = data.earningsNextDate ? daysBetween(today, data.earningsNextDate) : null
  const daysSinceLast = data.earningsLastDate ? daysBetween(data.earningsLastDate, today) : null
  const nextKind = data.earningsNextDateKind
    ?? (data.earningsNextSource === 'estimated_from_previous_earnings' ? 'estimated' : data.earningsNextDate ? 'confirmed' : null)
  const nextTone = nextKind === 'confirmed'
    ? { color: 'var(--accent-primary)', bg: 'rgba(37,99,235,0.08)', border: 'rgba(37,99,235,0.24)' }
    : nextKind === 'estimated' || nextKind === 'cached'
      ? { color: '#b45309', bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.32)' }
      : { color: 'var(--text-muted)', bg: 'var(--bg-elevated)', border: 'var(--border-subtle)' }

  return (
    <div className="card" style={{ padding: '12px', display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
      <div>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>前回決算日</div>
        <div style={{ fontSize: '14px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-primary)' }}>
          {formatJapaneseDate(data.earningsLastDate)}
          {data.earningsLastSource && (
            <SourceBadge source={data.earningsLastSource} fiscalPeriod={data.earningsLastFiscalPeriod} />
          )}
          {daysSinceLast != null && daysSinceLast >= 0 && (
            <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--text-secondary)' }}>
              前回決算から: {daysSinceLast}日経過
            </span>
          )}
        </div>
      </div>
      <div style={{ minWidth: '280px', flex: '1 1 320px' }}>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>次回決算日</div>
        <div style={{ fontSize: '14px', fontFamily: 'var(--font-mono)', fontWeight: 700, color: nextTone.color }}>
          {formatJapaneseDate(data.earningsNextDate)}
          {data.earningsNextSource && (
            <SourceBadge source={data.earningsNextSource} fiscalPeriod={data.earningsNextFiscalPeriod} kind={nextKind} />
          )}
          {daysToNext != null && (
            <span style={{ marginLeft: '8px', fontSize: '11px', color: daysToNext <= 7 ? 'var(--price-down, #ef4444)' : 'var(--text-secondary)' }}>
              決算まで: {daysToNext === 0 ? '本日' : daysToNext > 0 ? `あと${daysToNext}日` : `${-daysToNext}日経過`}
            </span>
          )}
        </div>
        {(data.earningsNextNote || nextKind === 'estimated' || nextKind === 'not_announced') && (
          <div style={{
            marginTop: '6px',
            border: `1px solid ${nextTone.border}`,
            background: nextTone.bg,
            borderRadius: '6px',
            padding: '6px 8px',
            fontSize: '11px',
            lineHeight: 1.55,
            color: nextTone.color,
          }}>
            {data.earningsNextNote ?? '公式予定が未発表のため、推定日を表示しています。'}
          </div>
        )}
      </div>
      {data.date && (
        <div style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--text-muted)' }}>
          <div>{data.date} 時点</div>
          {data.earningsScheduleLatestImportedAt != null && (
            <div>予定DB更新 {formatImportedAt(data.earningsScheduleLatestImportedAt)}</div>
          )}
          {data.earningsScheduleLatestKnownDate && (
            <div>公式予定最大 {formatJapaneseDate(data.earningsScheduleLatestKnownDate)}</div>
          )}
        </div>
      )}
    </div>
  )
}

function SourceBadge({
  source,
  fiscalPeriod,
  kind,
}: {
  source: string | null | undefined
  fiscalPeriod: string | null | undefined
  kind?: SnapshotInfo['earningsNextDateKind']
}) {
  const label =
    source === 'jpx' ? 'JPX公式'
      : source === 'jquants' ? 'J-Quants予定'
        : source === 'jquants_fins_summary' ? 'JQ実績'
          : source === 'estimated_from_previous_earnings' ? '推定目安'
            : kind === 'cached' ? '旧キャッシュ'
            : source
  const isEstimated = source === 'estimated_from_previous_earnings' || kind === 'estimated'
  const isCached = kind === 'cached'
  return (
    <span
      title={fiscalPeriod ?? undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        marginLeft: '8px',
        border: `1px solid ${isEstimated || isCached ? 'rgba(245,158,11,0.36)' : 'var(--border-subtle)'}`,
        borderRadius: '999px',
        background: isEstimated || isCached ? 'rgba(245,158,11,0.10)' : 'var(--bg-elevated)',
        color: isEstimated || isCached ? '#b45309' : 'var(--text-muted)',
        fontFamily: 'var(--font-mono)',
        fontSize: '10px',
        fontWeight: 700,
        padding: '2px 6px',
      }}
    >
      {label ?? '取得'}
    </span>
  )
}

function todayIsoJst(): string {
  const now = new Date()
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  return [
    jst.getFullYear(),
    String(jst.getMonth() + 1).padStart(2, '0'),
    String(jst.getDate()).padStart(2, '0'),
  ].join('-')
}

function daysBetween(a: string, b: string): number | null {
  try {
    const ms = new Date(b).getTime() - new Date(a).getTime()
    return Math.round(ms / (1000 * 60 * 60 * 24))
  } catch {
    return null
  }
}

function formatJapaneseDate(date: string | null): string {
  if (!date) return '---'
  const [year, month, day] = date.split('-').map(Number)
  if (!year || !month || !day) return date
  return `${year}年${month}月${day}日`
}

function formatImportedAt(value: number): string {
  if (!Number.isFinite(value)) return '---'
  const date = new Date(value * 1000)
  return date.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
