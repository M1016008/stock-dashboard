// components/ui/StatusDot.tsx
'use client'

import { useEffect, useState } from 'react'

interface StatusDotProps {
  status: 'live' | 'delayed' | 'offline'
  label?: string
}

export function StatusDot({ status, label }: StatusDotProps) {
  const [blink, setBlink] = useState(true)

  useEffect(() => {
    if (status !== 'live') return
    const timer = setInterval(() => setBlink(b => !b), 800)
    return () => clearInterval(timer)
  }, [status])

  const colorMap = {
    live: 'var(--price-up)',
    delayed: 'var(--accent-primary)',
    offline: 'var(--price-down)',
  }

  const color = colorMap[status]

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
      <span style={{
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        backgroundColor: color,
        opacity: status === 'live' ? (blink ? 1 : 0.3) : 1,
        transition: 'opacity 0.3s',
        flexShrink: 0,
      }} />
      {label && (
        <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
          {label}
        </span>
      )}
    </span>
  )
}
