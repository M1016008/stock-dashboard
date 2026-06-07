'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  BarChart3,
  Building2,
  CalendarDays,
  ChartCandlestick,
  ChevronDown,
  FlaskConical,
  Globe2,
  Hexagon,
  LayoutDashboard,
  Search,
  Star,
  type LucideIcon,
} from 'lucide-react'

type NavLinkItem = {
  href: string
  label: string
  description?: string
  icon: LucideIcon
  includeInGroupActive?: boolean
}

type NavEntry =
  | (NavLinkItem & { kind: 'link' })
  | {
      kind: 'menu'
      id: string
      label: string
      icon: LucideIcon
      items: readonly NavLinkItem[]
    }

const NAV_ITEMS = [
  { kind: 'link', href: '/', label: 'ダッシュボード', icon: LayoutDashboard },
  {
    kind: 'menu',
    id: 'discover',
    label: '探す',
    icon: Search,
    items: [
      { href: '/screener', label: 'スクリーナー', description: '条件で銘柄を抽出', icon: Search },
      { href: '/hex-stage', label: 'HEXステージ', description: '6ステージの分布と遷移', icon: Hexagon },
      { href: '/sectors', label: '業種分析', description: '17/33業種の強弱', icon: Building2 },
      {
        href: '/ai/ma-lens#historical-pattern-search',
        label: '過去パターン検索',
        description: '過去の形に近い現在銘柄',
        icon: ChartCandlestick,
        includeInGroupActive: false,
      },
    ],
  },
  {
    kind: 'menu',
    id: 'ai-analysis',
    label: 'AI分析',
    icon: Activity,
    items: [
      { href: '/ai/ma-lens', label: 'AI Lens', description: 'MA形状・物理特徴量・類似候補', icon: Activity },
      { href: '/ai/transitions', label: 'パターン遷移', description: '過去パターンの遷移分析', icon: ChartCandlestick },
      { href: '/backtest', label: '過去検証', description: 'シグナルと期待値を検証', icon: FlaskConical },
    ],
  },
  { kind: 'link', href: '/earnings', label: '決算', icon: CalendarDays },
  { kind: 'link', href: '/watchlist', label: 'ウォッチ', icon: Star },
] as const satisfies readonly NavEntry[]

const US_NAV_ITEMS = [
  { href: '/us', label: 'US概要', icon: LayoutDashboard },
  { href: '/us/screener', label: 'USスクリーナー', icon: Search },
  { href: '/us/stock/AAPL', label: 'AAPL', icon: ChartCandlestick },
  { href: '/ai/ma-lens', label: 'AI Lens', icon: Activity },
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

function getNyseStatus(): 'open' | 'closed' {
  const now = new Date()
  const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const hour = ny.getHours()
  const min = ny.getMinutes()
  const day = ny.getDay()
  const total = hour * 60 + min
  const isWeekday = day >= 1 && day <= 5
  return isWeekday && total >= 9 * 60 + 30 && total < 16 * 60 ? 'open' : 'closed'
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

function hrefPath(href: string): string {
  return href.split(/[?#]/)[0] || '/'
}

export function Header() {
  const pathname = usePathname()
  const isUsArea = pathname.startsWith('/us')
  const navItems = isUsArea ? US_NAV_ITEMS : NAV_ITEMS
  const navRef = useRef<HTMLDivElement>(null)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [marketStatus, setMarketStatus] = useState<'open' | 'closed'>('closed')
  const clocks = useClocks()

  useEffect(() => {
    const getStatus = isUsArea ? getNyseStatus : getTseStatus
    setMarketStatus(getStatus())
    const t = setInterval(() => setMarketStatus(getStatus()), 60000)
    return () => clearInterval(t)
  }, [isUsArea])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) setOpenMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const isActive = (href: string) => {
    const path = hrefPath(href)
    if (path === '/') return pathname === '/'
    if (path === '/us') return pathname === '/us'
    return pathname === path || pathname.startsWith(`${path}/`)
  }

  const isEntryActive = (entry: NavEntry | (typeof US_NAV_ITEMS)[number]) => {
    if ('kind' in entry && entry.kind === 'menu') {
      return entry.items.some((item) => item.includeInGroupActive !== false && isActive(item.href))
    }
    return isActive(entry.href)
  }

  const renderNavEntry = (entry: NavEntry | (typeof US_NAV_ITEMS)[number], compact = false) => {
    const active = isEntryActive(entry)
    const baseClasses = `inline-flex h-9 shrink-0 items-center gap-2.5 rounded-[2px] border ${compact ? 'px-3.5 text-[12px]' : 'px-4 text-[13px]'} font-bold leading-none transition-colors ${
      active
        ? 'border-[var(--color-market-red-dark)] bg-[var(--color-market-red)] text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.16)]'
        : 'border-[#2a71b8] bg-[#075aa7] text-white hover:border-[#9fc0e5] hover:bg-[#0c67bd]'
    }`

    if (!('kind' in entry) || entry.kind === 'link') {
      return (
        <Link
          key={entry.href}
          href={entry.href}
          prefetch={false}
          className={baseClasses}
          onClick={() => setOpenMenu(null)}
        >
          <NavIcon icon={entry.icon} active={active} />
          <span className="whitespace-nowrap">{entry.label}</span>
        </Link>
      )
    }

    const menuOpen = openMenu === entry.id
    return (
      <div
        key={entry.id}
        className="relative shrink-0"
        onMouseEnter={() => setOpenMenu(entry.id)}
        onMouseLeave={() => setOpenMenu(null)}
      >
        <button
          type="button"
          className={baseClasses}
          data-testid={`nav-menu-${entry.id}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setOpenMenu(menuOpen ? null : entry.id)}
        >
          <NavIcon icon={entry.icon} active={active || menuOpen} />
          <span className="whitespace-nowrap">{entry.label}</span>
          <ChevronDown
            size={14}
            strokeWidth={2.4}
            className={`transition-transform ${menuOpen ? 'rotate-180' : ''}`}
          />
        </button>

        {menuOpen && (
          <div
            role="menu"
            data-testid={`nav-menu-panel-${entry.id}`}
            className="absolute left-0 top-full z-50 w-[280px] rounded-[4px] border border-[var(--color-border-strong)] bg-white p-1.5 text-[var(--color-text-primary)] shadow-[0_14px_36px_rgba(16,32,52,0.24)]"
          >
            {entry.items.map((item) => {
              const itemActive = isActive(item.href)
              const ItemIcon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch={false}
                  role="menuitem"
                  className={`flex min-h-[54px] items-center gap-3 rounded-[3px] border px-3 py-2 text-left transition-colors ${
                    itemActive
                      ? 'border-[var(--color-market-red)] bg-[var(--color-surface-subtle)] text-[var(--color-brand-900)]'
                      : 'border-transparent hover:border-[var(--color-border-default)] hover:bg-[var(--color-surface-subtle)]'
                  }`}
                  onClick={() => setOpenMenu(null)}
                >
                  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[3px] border border-[var(--color-border-default)] bg-white text-[var(--color-brand-800)]">
                    <ItemIcon size={16} strokeWidth={2.3} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-black leading-tight">{item.label}</span>
                    {item.description && (
                      <span className="mt-1 block text-[11px] font-semibold leading-snug text-[var(--color-text-tertiary)]">
                        {item.description}
                      </span>
                    )}
                  </span>
                </Link>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--color-border-strong)] bg-white shadow-[0_1px_3px_rgba(16,32,52,0.12)]">
      <div className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)]">
        <div className="mx-auto flex min-h-10 w-full max-w-[1480px] items-center justify-between gap-3 px-5 sm:px-8 lg:px-10 xl:px-12">
          <Link href={isUsArea ? '/us' : '/'} prefetch={false} className="flex shrink-0 items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-[3px] bg-[var(--color-brand-800)] text-white shadow-sm">
              <BarChart3 size={16} strokeWidth={2.5} />
            </div>
            <div className="leading-tight">
              <div className="text-[16px] font-bold tracking-normal text-[var(--color-brand-900)]">StockBoard</div>
              <div className="hidden text-[10px] font-bold text-[var(--color-text-tertiary)] sm:block">
                {isUsArea ? 'Tiingo US Market Console' : 'J-Quants Market Console'}
              </div>
            </div>
          </Link>

          <div className="hidden shrink-0 items-center gap-1 rounded-[4px] border border-[var(--color-border-default)] bg-white p-1 md:flex">
            <Globe2 size={13} className="ml-1 text-[var(--color-text-tertiary)]" />
            <Link
              href="/"
              prefetch={false}
              className={`rounded-[3px] px-2 py-1 text-[11px] font-bold ${!isUsArea ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'}`}
            >
              日本株
            </Link>
            <Link
              href="/us"
              prefetch={false}
              className={`rounded-[3px] px-2 py-1 text-[11px] font-bold ${isUsArea ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'}`}
            >
              米国株
            </Link>
          </div>

          <div className="flex shrink-0 items-center gap-1 rounded-[4px] border border-[var(--color-border-default)] bg-white p-1 md:hidden">
            <Link
              href="/"
              prefetch={false}
              className={`rounded-[3px] px-2 py-1 text-[11px] font-bold ${!isUsArea ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-text-secondary)]'}`}
            >
              JP
            </Link>
            <Link
              href="/us"
              prefetch={false}
              className={`rounded-[3px] px-2 py-1 text-[11px] font-bold ${isUsArea ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-text-secondary)]'}`}
            >
              US
            </Link>
          </div>

          <div className="hidden shrink-0 items-center gap-1.5 lg:flex">
            <span className="inline-flex h-6 items-center gap-1.5 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-text-secondary)]">
              <Activity size={12} />
              {isUsArea ? 'NYSE' : '東証'}
              <span
                style={{
                  color:
                    marketStatus === 'open'
                      ? 'var(--color-pattern-600)'
                      : 'var(--color-price-down)',
                }}
              >
                {marketStatus === 'open' ? '開場' : '閉場'}
              </span>
            </span>
            <span
              className="inline-flex h-6 items-center rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-semibold text-[var(--color-text-primary)] tabular-nums"
              suppressHydrationWarning
            >
              {clocks.date || '----/--/--'}
            </span>
            <ClockChip label="TYO" time={clocks.jst} />
            <div className="flex items-center gap-1.5">
              <ClockChip label="LDN" time={clocks.ldn} />
              <ClockChip label="NYC" time={clocks.nyc} />
            </div>
          </div>
        </div>
      </div>

      <div className="bg-[var(--color-brand-800)]">
        <div ref={navRef} className="mx-auto flex min-h-12 w-full max-w-[1480px] items-center justify-between gap-4 px-5 py-1.5 sm:px-8 lg:px-10 xl:px-12">
          <nav className="hidden min-w-0 flex-1 items-center gap-2 overflow-visible lg:flex">
            {navItems.map((item) => renderNavEntry(item))}
          </nav>

          <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-2 overflow-visible lg:hidden">
            {navItems.map((item) => renderNavEntry(item, true))}
          </nav>
        </div>
      </div>
    </header>
  )
}
