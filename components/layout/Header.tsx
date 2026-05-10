'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

const NAV_ITEMS = [
  { href: '/', label: 'ダッシュボード' },
  { href: '/hex-stage', label: 'HEX ステージ' },
  { href: '/screener', label: 'スクリーナー' },
  { href: '/capital-flow', label: '資金フロー' },
  { href: '/watchlist', label: 'ウォッチリスト' },
] as const

const ADMIN_ITEMS = [
  { href: '/admin/import', label: 'データ取込' },
  { href: '/admin/sector-master', label: 'セクター' },
  { href: '/admin/db', label: 'DB' },
] as const

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
  const d = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    timeZone: 'Asia/Tokyo',
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value
      return acc
    }, {})
  return `${d.year}-${d.month}-${d.day} (${d.weekday})`
}

function useClocks(): ClockData {
  const [data, setData] = useState<ClockData>({ date: '', jst: '', ldn: '', nyc: '' })
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
    <span className="inline-flex items-baseline gap-1 tabular-nums">
      <span className="text-[10px] tracking-wider text-[var(--color-text-tertiary)]">{label}</span>
      <span
        className="text-[11px] text-[var(--color-text-secondary)]"
        suppressHydrationWarning
      >
        {time || '--:--:--'}
      </span>
    </span>
  )
}

export function Header() {
  const pathname = usePathname()
  const [tseStatus, setTseStatus] = useState<'open' | 'closed'>('closed')
  const clocks = useClocks()

  useEffect(() => {
    setTseStatus(getTseStatus())
    const t = setInterval(() => setTseStatus(getTseStatus()), 60000)
    return () => clearInterval(t)
  }, [])

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/'
    return pathname.startsWith(href)
  }

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--color-border-soft)] bg-[var(--color-surface-base)]/90 backdrop-blur">
      {/* 上段: ロゴ + メインナビ + 管理ナビ */}
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-6 py-3">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-brand-600)] text-white">
            <span className="text-sm font-bold">SB</span>
          </div>
          <span className="text-sm font-semibold tracking-tight">StockBoard</span>
        </Link>

        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                isActive(item.href)
                  ? 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)] font-medium'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-1">
          {ADMIN_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                isActive(item.href)
                  ? 'font-medium text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </div>
      </div>

      {/* 下段: 東証ステータス + 時計 */}
      <div className="border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-6 py-1.5">
          <span className="text-[10px] tracking-wider text-[var(--color-text-tertiary)]">
            東証{' '}
            <span
              className="font-medium"
              style={{
                color:
                  tseStatus === 'open'
                    ? 'var(--color-price-up)'
                    : 'var(--color-price-down)',
              }}
            >
              {tseStatus === 'open' ? '開場' : '閉場'}
            </span>
          </span>

          <div className="flex items-center gap-3">
            <span
              className="tabular-nums text-[11px] text-[var(--color-text-secondary)]"
              suppressHydrationWarning
            >
              {clocks.date || '----/--/--'}
            </span>
            <span className="h-3 w-px bg-[var(--color-border-default)]" />
            <ClockChip label="TYO" time={clocks.jst} />
            <ClockChip label="LDN" time={clocks.ldn} />
            <ClockChip label="NYC" time={clocks.nyc} />
          </div>
        </div>
      </div>
    </header>
  )
}
