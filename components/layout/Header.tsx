'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Activity, BarChart3, Database, Settings } from 'lucide-react'

const NAV_ITEMS = [
  { href: '/', label: 'ダッシュボード' },
  { href: '/hex-stage', label: 'HEX' },
  { href: '/sectors', label: '業種' },
  { href: '/industries', label: '業界' },
  { href: '/ai/transitions', label: 'パターン' },
  { href: '/screener', label: 'スクリーナー' },
  { href: '/capital-flow', label: '資金フロー' },
  { href: '/watchlist', label: 'ウォッチ' },
] as const

const ADMIN_ITEMS = [
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
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border-soft)] bg-white px-3 py-1.5 tabular-nums">
      <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">{label}</span>
      <span
        className="text-[12px] font-semibold text-[var(--color-text-secondary)]"
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
    <header className="sticky top-0 z-30 border-b border-[var(--color-border-soft)] bg-white/95 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-3 px-5 py-3.5 lg:px-10">
        <div className="flex items-center justify-between gap-5">
          <Link href="/" prefetch={false} className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-brand-500)] text-white shadow-sm">
              <BarChart3 size={19} strokeWidth={2.4} />
            </div>
            <div className="leading-tight">
              <div className="text-[18px] font-bold">StockBoard</div>
              <div className="hidden text-[11px] font-semibold text-[var(--color-text-tertiary)] sm:block">J-Quants Market Console</div>
            </div>
          </Link>

          <div className="hidden items-center gap-2 lg:flex">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border-soft)] bg-white px-3 py-1.5 text-[12px] font-semibold text-[var(--color-text-secondary)] shadow-sm">
              <Activity size={12} />
              東証
              <span
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
            <span
              className="rounded-full border border-[var(--color-border-soft)] bg-white px-3 py-1.5 text-[12px] font-semibold text-[var(--color-text-secondary)] shadow-sm tabular-nums"
              suppressHydrationWarning
            >
              {clocks.date || '----/--/--'}
            </span>
            <ClockChip label="TYO" time={clocks.jst} />
            <ClockChip label="LDN" time={clocks.ldn} />
            <ClockChip label="NYC" time={clocks.nyc} />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 overflow-x-auto border-t border-[var(--color-border-soft)] pt-3">
          <nav className="flex min-w-max items-center gap-5">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              className={`relative py-1 text-[13px] font-bold transition-colors ${
                isActive(item.href)
                  ? 'text-[var(--color-brand-700)] after:absolute after:-bottom-3 after:left-0 after:h-[3px] after:w-full after:rounded-full after:bg-[var(--color-brand-500)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              {item.label}
            </Link>
          ))}
          </nav>

          <div className="flex shrink-0 items-center gap-1">
            {ADMIN_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-bold transition-colors ${
                  isActive(item.href)
                    ? 'bg-[var(--color-text-primary)] text-white'
                    : 'text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-subtle)] hover:text-[var(--color-text-secondary)]'
                }`}
              >
                {item.href.includes('db') ? <Database size={13} /> : <Settings size={13} />}
                {item.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </header>
  )
}
