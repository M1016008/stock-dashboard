// components/ui/TopBar.tsx
'use client'

import { useEffect, useState } from 'react'

function Clock() {
  const [time, setTime] = useState('')

  useEffect(() => {
    const update = () => {
      const now = new Date()
      setTime(
        now.toLocaleTimeString('ja-JP', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZone: 'Asia/Tokyo',
        }) + ' JST'
      )
    }
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-secondary)' }}>
      {time}
    </span>
  )
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

export function TopBar() {
  const [tseStatus, setTseStatus] = useState<'open' | 'closed'>('closed')

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
      gap: '16px',
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
      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
        東証:{' '}
        <span style={{ color: tseStatus === 'open' ? 'var(--price-up)' : 'var(--price-down)' }}>
          {tseStatus === 'open' ? '開場' : '閉場'}
        </span>
      </span>

      {/* スペーサー */}
      <div style={{ flex: 1 }} />

      {/* 時計 */}
      <Clock />
    </header>
  )
}
