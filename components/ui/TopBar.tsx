// components/ui/TopBar.tsx
'use client'

import { useEffect, useState } from 'react'

interface ClockData {
  date: string
  jst: string
  ldn: string
  nyc: string
}

function fmtTime(now: Date, timeZone: string): string {
  return now.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone,
  })
}

function fmtDate(now: Date): string {
  // 日本時間ベースの日付。例: 2026-05-05 (火)
  const d = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    timeZone: 'Asia/Tokyo',
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => { acc[p.type] = p.value; return acc }, {})
  return `${d.year}-${d.month}-${d.day} (${d.weekday})`
}

function useClocks(): ClockData {
  const [data, setData] = useState<ClockData>(() => {
    const now = new Date()
    return {
      date: fmtDate(now),
      jst: fmtTime(now, 'Asia/Tokyo'),
      ldn: fmtTime(now, 'Europe/London'),
      nyc: fmtTime(now, 'America/New_York'),
    }
  })

  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setData({
        date: fmtDate(now),
        jst: fmtTime(now, 'Asia/Tokyo'),
        ldn: fmtTime(now, 'Europe/London'),
        nyc: fmtTime(now, 'America/New_York'),
      })
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [])

  return data
}

// 東証の開場判定
function getTseStatus(): 'open' | 'closed' {
  const now = new Date()
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  const jstHour = jst.getHours()
  const jstMin = jst.getMinutes()
  const jstDay = jst.getDay()
  const jstTotal = jstHour * 60 + jstMin

  const isWeekday = jstDay >= 1 && jstDay <= 5
  return isWeekday && jstTotal >= 9 * 60 && jstTotal < 15 * 60 + 30 ? 'open' : 'closed'
}

function ClockChip({ label, time }: { label: string; time: string }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: '4px',
      fontFamily: 'var(--font-mono)',
      fontSize: '11px',
      lineHeight: 1,
    }}>
      <span style={{ color: 'var(--text-muted)', fontSize: '10px', letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ color: 'var(--text-secondary)' }}>{time}</span>
    </span>
  )
}

export function TopBar() {
  const [tseStatus, setTseStatus] = useState<'open' | 'closed'>('closed')
  const clocks = useClocks()

  useEffect(() => {
    setTseStatus(getTseStatus())
    const timer = setInterval(() => setTseStatus(getTseStatus()), 60000)
    return () => clearInterval(timer)
  }, [])

  return (
    <header style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      height: '36px',
      background: 'var(--bg-surface)',
      borderBottom: '1px solid var(--border-subtle)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      gap: '14px',
      zIndex: 1000,
    }}>
      {/* ロゴ */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        <span style={{
          fontFamily: 'var(--font-display)',
          fontSize: '14px',
          fontWeight: 700,
          color: 'var(--accent-primary)',
          letterSpacing: '-0.02em',
        }}>SB</span>
        <span style={{ fontSize: '11px', color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>
          StockBoard
        </span>
      </div>

      {/* セパレータ */}
      <div style={{ width: '1px', height: '16px', background: 'var(--border-base)' }} />

      {/* 東証ステータス */}
      <span style={{ fontSize: '10px', color: 'var(--text-muted)', lineHeight: 1 }}>
        東証{' '}
        <span style={{ color: tseStatus === 'open' ? 'var(--price-up)' : 'var(--price-down)' }}>
          {tseStatus === 'open' ? '開場' : '閉場'}
        </span>
      </span>

      {/* スペーサー */}
      <div style={{ flex: 1 }} />

      {/* 日付 + 3地点時計 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1 }}>
          {clocks.date}
        </span>
        <span style={{ width: '1px', height: '12px', background: 'var(--border-base)' }} />
        <ClockChip label="TYO" time={clocks.jst} />
        <ClockChip label="LDN" time={clocks.ldn} />
        <ClockChip label="NYC" time={clocks.nyc} />
      </div>
    </header>
  )
}
