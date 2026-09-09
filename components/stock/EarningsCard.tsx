// components/stock/EarningsCard.tsx
'use client'

import { useEffect, useState } from 'react'
import {
  earningsPredictionConfidenceLabel,
  earningsTimeBucketLabel,
  type EarningsPredictionConfidence,
  type EarningsTimeBucket,
  type EarningsTimeKind,
} from '@/lib/earnings-time'

interface SnapshotInfo {
  ticker: string
  date: string | null
  earningsLastDate: string | null
  earningsNextDate: string | null
  earningsLastSource?: string | null
  earningsLastFiscalPeriod?: string | null
  earningsLastActualDate?: string | null
  earningsLastActualTime?: string | null
  earningsLastActualSource?: string | null
  earningsLastScheduledTime?: string | null
  earningsNextSource?: string | null
  earningsNextFiscalPeriod?: string | null
  earningsNextDateKind?: 'confirmed' | 'estimated' | 'cached' | 'not_announced' | 'not_applicable' | 'no_history' | null
  earningsNextNote?: string | null
  earningsNextTime?: string | null
  earningsNextTimeKind?: EarningsTimeKind | null
  earningsNextTimeBucket?: EarningsTimeBucket | null
  earningsNextScheduledTime?: string | null
  earningsNextScheduledTimeKind?: string | null
  earningsNextScheduledTimeSource?: string | null
  earningsNextPredictedTime?: string | null
  earningsNextPredictionConfidence?: EarningsPredictionConfidence | null
  earningsNextPredictionSampleCount?: number | null
  earningsNextPredictionModeCount?: number | null
  earningsCalendarLatestKnownDate?: string | null
  earningsCalendarLatestImportedAt?: number | null
  earningsScheduleLatestKnownDate?: string | null
  earningsScheduleLatestImportedAt?: number | null
}

interface Props {
  ticker: string
  compact?: boolean
}

export function EarningsCard({ ticker, compact = false }: Props) {
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
      <div className={compact ? '' : 'card'} style={{ padding: compact ? 0 : '12px', fontSize: '11px', color: 'var(--text-muted)' }}>
        決算情報読込中…
      </div>
    )
  }

  if (!data || (!data.earningsLastDate && !data.earningsNextDate)) {
    return compact ? <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">決算日情報は未取得です。</div> : null
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
  const lastDisplayDate = data.earningsLastActualDate ?? data.earningsLastDate
  const timeKind = data.earningsNextTimeKind ?? 'unknown'
  const timeLabel = timeKind === 'predicted'
    ? `${data.earningsNextTime ?? '--:--'}頃`
    : data.earningsNextTime ?? '時刻未定'
  const timeBadge = timeKind === 'confirmed'
    ? '確定予定時刻'
    : timeKind === 'scheduled'
      ? '予定時刻'
      : timeKind === 'predicted'
        ? '予想時刻'
        : '時刻未定'
  const predictionEvidence =
    timeKind === 'predicted' &&
    data.earningsNextPredictionSampleCount != null &&
    data.earningsNextPredictionModeCount != null
      ? `過去${data.earningsNextPredictionSampleCount}回のうち${data.earningsNextPredictionModeCount}回が${data.earningsNextPredictedTime}前後に開示`
      : null

  if (compact) {
    return (
      <section aria-label="決算日" className="grid gap-2 sm:grid-cols-[60px_minmax(0,1fr)_minmax(0,1.35fr)] sm:items-center sm:gap-4">
        <div className="order-1 text-[11px] font-bold text-[var(--color-text-primary)]">決算</div>
        <div className="order-3 min-w-0 border-t border-[var(--color-border-soft)] pt-2 sm:order-2 sm:border-0 sm:pt-0">
          <div className="text-[9px] font-medium text-[var(--color-text-tertiary)]">前回発表</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[12px] font-semibold text-[var(--color-text-primary)]">
            <span>{formatJapaneseDate(lastDisplayDate)}</span>
            {data.earningsLastActualTime && <span>{data.earningsLastActualTime}</span>}
            {daysSinceLast != null && daysSinceLast >= 0 && (
              <span className="font-sans text-[9px] font-medium text-[var(--color-text-tertiary)]">{daysSinceLast}日前</span>
            )}
          </div>
        </div>
        <div className="order-2 min-w-0 sm:order-3">
          <div className="flex flex-wrap items-center gap-1.5 text-[9px] font-medium text-[var(--color-text-tertiary)]">
            <span>{nextKind === 'estimated' ? '次回予想' : '次回予定'}</span>
            {nextKind && (
              <span
                className="rounded-[3px] border px-1.5 py-0.5 text-[9px] font-bold"
                style={{ borderColor: nextTone.border, background: nextTone.bg, color: nextTone.color }}
              >
                {nextKind === 'confirmed' ? '確定' : nextKind === 'estimated' ? '推定' : nextKind === 'cached' ? '参考' : '未発表'}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[13px] font-black" style={{ color: nextTone.color }}>
            <span>{formatJapaneseDate(data.earningsNextDate)}</span>
            {data.earningsNextDate && timeKind !== 'unknown' && <span className="text-[11px]">{timeLabel}</span>}
            {daysToNext != null && (
              <span className="font-sans text-[9px] font-black">
                {daysToNext === 0 ? '本日' : daysToNext > 0 ? `あと${daysToNext}日` : `${-daysToNext}日経過`}
              </span>
            )}
          </div>
        </div>
      </section>
    )
  }

  return (
    <div className="card" style={{ padding: '12px', display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
      <div style={{ minWidth: '260px' }}>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>前回決算発表</div>
        <div style={{ fontSize: '14px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-primary)' }}>
          {formatJapaneseDate(lastDisplayDate)}
          {data.earningsLastActualTime && ` ${data.earningsLastActualTime}`}
          {(data.earningsLastActualSource || data.earningsLastSource) && (
            <SourceBadge source={data.earningsLastActualSource ?? data.earningsLastSource} fiscalPeriod={data.earningsLastFiscalPeriod} />
          )}
          {daysSinceLast != null && daysSinceLast >= 0 && (
            <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--text-secondary)' }}>
              前回決算から: {daysSinceLast}日経過
            </span>
          )}
        </div>
        {data.earningsLastActualTime && (
          <div style={{ marginTop: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}>
            実際の開示時刻：{data.earningsLastActualTime}
            {data.earningsLastScheduledTime && (
              <span style={{ marginLeft: '10px' }}>予定時刻：{data.earningsLastScheduledTime}</span>
            )}
          </div>
        )}
      </div>
      <div style={{ minWidth: '280px', flex: '1 1 320px' }}>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>
          {nextKind === 'estimated' ? '次回決算発表予想' : '次回決算発表予定'}
        </div>
        <div style={{ fontSize: '14px', fontFamily: 'var(--font-mono)', fontWeight: 700, color: nextTone.color }}>
          {formatJapaneseDate(data.earningsNextDate)}
          {data.earningsNextDate && (
            <span style={{ marginLeft: '6px' }}>
              {timeKind === 'unknown' ? '（時刻未定）' : timeLabel}
            </span>
          )}
          {data.earningsNextDate && <TimeKindBadge kind={timeKind} label={timeBadge} />}
          {data.earningsNextSource && (
            <SourceBadge source={data.earningsNextSource} fiscalPeriod={data.earningsNextFiscalPeriod} kind={nextKind} />
          )}
          {daysToNext != null && (
            <span style={{ marginLeft: '8px', fontSize: '11px', color: daysToNext <= 7 ? 'var(--price-down, #ef4444)' : 'var(--text-secondary)' }}>
              決算まで: {daysToNext === 0 ? '本日' : daysToNext > 0 ? `あと${daysToNext}日` : `${-daysToNext}日経過`}
            </span>
          )}
        </div>
        {data.earningsNextDate && (
          <div style={{ marginTop: '5px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontSize: '11px' }}>
            <span style={{ color: 'var(--text-secondary)' }}>
              {earningsTimeBucketLabel(data.earningsNextTimeBucket)}
            </span>
            {predictionEvidence && (
              <span style={{ color: '#b45309' }}>{predictionEvidence}</span>
            )}
            {timeKind === 'predicted' && data.earningsNextPredictionConfidence && (
              <span style={{ color: '#b45309', fontWeight: 700 }}>
                予想信頼度：{earningsPredictionConfidenceLabel(data.earningsNextPredictionConfidence)}
              </span>
            )}
          </div>
        )}
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

function TimeKindBadge({ kind, label }: { kind: EarningsTimeKind; label: string }) {
  const predicted = kind === 'predicted'
  const confirmed = kind === 'confirmed'
  return (
    <span style={{
      display: 'inline-flex',
      marginLeft: '8px',
      border: `1px solid ${confirmed ? 'rgba(22,163,74,0.35)' : predicted ? 'rgba(245,158,11,0.36)' : 'var(--border-subtle)'}`,
      borderRadius: '3px',
      background: confirmed ? 'rgba(22,163,74,0.08)' : predicted ? 'rgba(245,158,11,0.10)' : 'var(--bg-elevated)',
      color: confirmed ? '#15803d' : predicted ? '#b45309' : 'var(--text-muted)',
      fontFamily: 'var(--font-sans)',
      fontSize: '10px',
      fontWeight: 700,
      padding: '2px 5px',
    }}>
      {label}
    </span>
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
