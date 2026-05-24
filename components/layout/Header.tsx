'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  Activity,
  BarChart3,
  Building2,
  CalendarDays,
  ChartCandlestick,
  FlaskConical,
  Hexagon,
  LayoutDashboard,
  Search,
  Star,
  type LucideIcon,
} from 'lucide-react'

const NAV_ITEMS = [
  { href: '/', label: 'ダッシュボード', icon: LayoutDashboard },
  { href: '/hex-stage', label: 'HEX', icon: Hexagon },
  { href: '/sectors', label: '業種', icon: Building2 },
  { href: '/ai/transitions', label: 'パターン', icon: ChartCandlestick },
  { href: '/backtest', label: '検証', icon: FlaskConical },
  { href: '/ai/ma-lens', label: 'AI Lens', icon: Activity },
  { href: '/earnings', label: '決算', icon: CalendarDays },
  { href: '/screener', label: 'スクリーナー', icon: Search },
  { href: '/watchlist', label: 'ウォッチ', icon: Star },
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
    <span className="inline-flex h-6 items-center gap-1.5 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 tabular-nums">
      <span className="text-[10px] font-bold text-[var(--color-brand-700)]">{label}</span>
      <span
        className="text-[11px] font-semibold text-[var(--color-text-primary)]"
        suppressHydrationWarning
      >
        {time || '--:--:--'}
      </span>
    </span>
  )
}

function NavIcon({ icon: Icon, active }: { icon: LucideIcon; active: boolean }) {
  return (
    <span
      className={`inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[2px] border bg-white ${
        active
          ? 'border-white text-[var(--color-market-red)]'
          : 'border-[#b4c9e6] text-[var(--color-brand-700)]'
      }`}
    >
      <Icon size={14} strokeWidth={2.25} />
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
    <header className="sticky top-0 z-30 border-b border-[var(--color-border-strong)] bg-white shadow-[0_1px_3px_rgba(16,32,52,0.12)]">
      <div className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)]">
        <div className="mx-auto flex min-h-10 w-full max-w-[1480px] items-center justify-between gap-3 px-5 sm:px-8 lg:px-10 xl:px-12">
          <Link href="/" prefetch={false} className="flex shrink-0 items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-[3px] bg-[var(--color-brand-800)] text-white shadow-sm">
              <BarChart3 size={16} strokeWidth={2.5} />
            </div>
            <div className="leading-tight">
              <div className="text-[16px] font-bold tracking-normal text-[var(--color-brand-900)]">StockBoard</div>
              <div className="hidden text-[10px] font-bold text-[var(--color-text-tertiary)] sm:block">J-Quants Market Console</div>
            </div>
          </Link>

          <div className="hidden shrink-0 items-center gap-1.5 lg:flex">
            <span className="inline-flex h-6 items-center gap-1.5 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-text-secondary)]">
              <Activity size={12} />
              東証
              <span
                style={{
                  color:
                    tseStatus === 'open'
                      ? 'var(--color-pattern-600)'
                      : 'var(--color-price-down)',
                }}
              >
                {tseStatus === 'open' ? '開場' : '閉場'}
              </span>
            </span>
            <span
              className="inline-flex h-6 items-center rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-semibold text-[var(--color-text-primary)] tabular-nums"
              suppressHydrationWarning
            >
              {clocks.date || '----/--/--'}
            </span>
            <ClockChip label="TYO" time={clocks.jst} />
            <div className="hidden items-center gap-1.5 xl:flex">
              <ClockChip label="LDN" time={clocks.ldn} />
              <ClockChip label="NYC" time={clocks.nyc} />
            </div>
          </div>
        </div>
      </div>

      <div className="bg-[var(--color-brand-800)]">
        <div className="mx-auto flex min-h-12 w-full max-w-[1480px] items-center justify-between gap-4 px-5 py-1.5 sm:px-8 lg:px-10 xl:px-12">
          <nav className="hidden min-w-0 flex-1 items-center gap-2 overflow-x-auto lg:flex">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch={false}
                  className={`inline-flex h-9 shrink-0 items-center gap-2.5 rounded-[2px] border px-4 text-[13px] font-bold leading-none transition-colors ${
                    active
                      ? 'border-[var(--color-market-red-dark)] bg-[var(--color-market-red)] text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.16)]'
                      : 'border-[#2a71b8] bg-[#075aa7] text-white hover:border-[#9fc0e5] hover:bg-[#0c67bd]'
                  }`}
                >
                  <NavIcon icon={item.icon} active={active} />
                  <span className="whitespace-nowrap">{item.label}</span>
                </Link>
              )
            })}
          </nav>

          <nav className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto lg:hidden">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch={false}
                  className={`inline-flex h-9 shrink-0 items-center gap-2.5 rounded-[2px] border px-3.5 text-[12px] font-bold leading-none transition-colors ${
                    active
                      ? 'border-[var(--color-market-red-dark)] bg-[var(--color-market-red)] text-white'
                      : 'border-[#2a71b8] bg-[#075aa7] text-white hover:border-[#9fc0e5] hover:bg-[#0c67bd]'
                  }`}
                >
                  <NavIcon icon={item.icon} active={active} />
                  <span className="whitespace-nowrap">{item.label}</span>
                </Link>
              )
            })}
          </nav>
        </div>
      </div>
    </header>
  )
}
