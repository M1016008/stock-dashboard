'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  BarChart3,
  Building2,
  CalendarDays,
  ChartCandlestick,
  ChevronDown,
  FlaskConical,
  Gem,
  Globe2,
  Hexagon,
  LayoutDashboard,
  ListFilter,
  MessageSquareText,
  Search,
  Star,
  type LucideIcon,
} from 'lucide-react'
import { COMMODITY_INSTRUMENTS } from '@/lib/commodities'
import {
  addUniverseToHref,
  getUniverseFilterMeta,
  parseUniverseFilter,
  UNIVERSE_FILTER_PARAM,
  type UniverseFilterId,
} from '@/lib/market-universe'

type HeaderArea = 'jp' | 'us' | 'commodities'

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
      { href: '/stage-screener', label: 'ステージスクリーナー', description: '日足・週足・月足の行列で抽出', icon: Hexagon },
      { href: '/hex-stage', label: 'HEXステージ', description: '6ステージの分布と遷移', icon: Hexagon },
      { href: '/sectors', label: '業種分析', description: '17/33業種の強弱', icon: Building2 },
      { href: '/sector-etfs', label: '業界ETF分析', description: 'ETFで業界・テーマを確認', icon: ChartCandlestick },
      { href: '/themes', label: 'テーマ', description: '株探人気テーマと関連銘柄', icon: ListFilter },
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
      { href: '/ai/research', label: 'AI銘柄リサーチ', description: '会話で条件化しDB根拠で候補表示', icon: MessageSquareText },
      { href: '/ai/ma-lens', label: 'AI Lens', description: 'MA形状・物理特徴量・類似候補', icon: Activity },
      { href: '/ai/transitions', label: 'パターン遷移', description: '過去パターンの遷移分析', icon: ChartCandlestick },
      { href: '/backtest', label: '過去検証', description: 'シグナルと期待値を検証', icon: FlaskConical },
      { href: '/chart-drill', label: 'チャートドリル', description: '初動察知を反復練習', icon: ChartCandlestick },
      { href: '/trade/workbench', label: '売買候補', description: '根拠つき注文案の下書き', icon: FlaskConical },
    ],
  },
  { kind: 'link', href: '/earnings', label: '決算', icon: CalendarDays },
  {
    kind: 'menu',
    id: 'watch',
    label: 'ウォッチ',
    icon: Star,
    items: [
      { href: '/watchlist', label: 'ウォッチリスト', description: '保存した監視銘柄', icon: Star },
      { href: '/custom-charts', label: '合成チャート', description: '数式で独自チャートを作成', icon: ChartCandlestick },
    ],
  },
] as const satisfies readonly NavEntry[]

const US_NAV_ITEMS = [
  { kind: 'link', href: '/us', label: 'US概要', icon: LayoutDashboard },
  {
    kind: 'menu',
    id: 'us-discover',
    label: '探す',
    icon: Search,
    items: [
      { href: '/us/screener', label: 'USスクリーナー', description: '米国株を条件で抽出', icon: Search },
      { href: '/ai/research?market=US', label: 'AI銘柄リサーチ', description: '米国株も自然言語で探索', icon: MessageSquareText },
      { href: '/chart-drill?market=US', label: 'チャートドリル', description: 'US過去チャートで初動練習', icon: ChartCandlestick },
    ],
  },
  {
    kind: 'menu',
    id: 'us-analysis',
    label: '分析',
    icon: Activity,
    items: [
      { href: '/ai/ma-lens', label: 'AI Lens', description: 'MA形状・物理特徴量を横断確認', icon: Activity },
      { href: '/ai/transitions', label: 'パターン遷移', description: '過去パターンの推移分析', icon: ChartCandlestick },
      { href: '/backtest', label: '過去検証', description: 'シグナルと期待値を確認', icon: FlaskConical },
    ],
  },
  {
    kind: 'menu',
    id: 'us-watch',
    label: 'ウォッチ',
    icon: Star,
    items: [
      { href: '/watchlist', label: 'ウォッチリスト', description: '保存した監視銘柄', icon: Star },
      { href: '/custom-charts', label: '合成チャート', description: '数式で独自チャートを作成', icon: ChartCandlestick },
    ],
  },
] as const satisfies readonly NavEntry[]

const COMMODITY_NAV_ITEMS = [
  { href: '/commodities', label: '概要', icon: LayoutDashboard },
  { href: '/commodities/screener', label: 'スクリーナー', icon: Search },
  { href: '/commodities/jp/1540', label: '金 JP', icon: Gem },
  { href: '/commodities/jp/1671', label: '原油 JP', icon: ChartCandlestick },
  { href: '/commodities/us/GLD', label: 'Gold US', icon: ChartCandlestick },
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

type SearchApiResult = {
  ticker: string
  name: string
  market: 'JP' | 'US'
  sector17Name?: string | null
  sector33Name?: string | null
  marketSegment?: string | null
  marginType?: string | null
  exchange?: string | null
  sectorName?: string | null
  industryName?: string | null
  assetType?: string | null
}

type QuickSearchResult = {
  key: string
  ticker: string
  name: string
  market: 'JP' | 'US' | 'COMMODITY'
  href: string
  badge: string
  meta?: string | null
}

const COMMODITY_SEARCH_RESULTS: QuickSearchResult[] = COMMODITY_INSTRUMENTS.map((item) => ({
  key: `COMMODITY:${item.marketSlug}:${item.ticker}`,
  ticker: item.ticker,
  name: item.shortName || item.name,
  market: 'COMMODITY',
  href: `/commodities/${item.marketSlug}/${encodeURIComponent(item.ticker)}`,
  badge: item.market === 'JP' ? '商品JP' : '商品US',
  meta: `${item.commodity} / ${item.productType}`,
}))

function normalizeTickerQuery(value: string): string {
  return value.trim().replace(/\.T$/i, '').toUpperCase()
}

function searchResultHref(result: SearchApiResult): string {
  const ticker = encodeURIComponent(result.ticker)
  return result.market === 'US' ? `/us/stock/${ticker}` : `/stock/${ticker}`
}

function searchResultBadge(result: SearchApiResult): string {
  return result.market === 'US' ? 'US' : 'JP'
}

function searchResultMeta(result: SearchApiResult): string | null {
  if (result.market === 'US') {
    return [result.exchange, result.sectorName, result.industryName].filter(Boolean).join(' / ') || null
  }
  return [result.marketSegment, result.sector17Name, result.marginType].filter(Boolean).join(' / ') || null
}

function areaPriority(area: HeaderArea, result: QuickSearchResult): number {
  if (area === 'commodities') return result.market === 'COMMODITY' ? 0 : result.market === 'JP' ? 1 : 2
  if (area === 'us') return result.market === 'US' ? 0 : result.market === 'COMMODITY' ? 1 : 2
  return result.market === 'JP' ? 0 : result.market === 'COMMODITY' ? 1 : 2
}

function sortQuickSearchResults(area: HeaderArea, query: string, results: QuickSearchResult[]): QuickSearchResult[] {
  const normalized = normalizeTickerQuery(query)
  return [...results]
    .sort((a, b) => {
      const aExact = normalizeTickerQuery(a.ticker) === normalized ? 0 : 1
      const bExact = normalizeTickerQuery(b.ticker) === normalized ? 0 : 1
      if (aExact !== bExact) return aExact - bExact
      const aPrefix = normalizeTickerQuery(a.ticker).startsWith(normalized) ? 0 : 1
      const bPrefix = normalizeTickerQuery(b.ticker).startsWith(normalized) ? 0 : 1
      if (aPrefix !== bPrefix) return aPrefix - bPrefix
      const aArea = areaPriority(area, a)
      const bArea = areaPriority(area, b)
      if (aArea !== bArea) return aArea - bArea
      return a.ticker.localeCompare(b.ticker)
    })
    .slice(0, 8)
}

function fallbackSearchHref(query: string, area: HeaderArea): string | null {
  const normalized = normalizeTickerQuery(query)
  if (!normalized) return null

  const commodity = COMMODITY_SEARCH_RESULTS.find((result) => normalizeTickerQuery(result.ticker) === normalized)
  if (area === 'commodities' && commodity) return commodity.href
  if (/^\d{4}[A-Z]?$/.test(normalized)) return `/stock/${encodeURIComponent(normalized)}`
  if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(normalized)) return `/us/stock/${encodeURIComponent(normalized)}`
  return null
}

function TickerQuickSearch({ area }: { area: HeaderArea }) {
  const router = useRouter()
  const rootRef = useRef<HTMLDivElement>(null)
  const requestIdRef = useRef(0)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<QuickSearchResult[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  useEffect(() => {
    const normalized = query.trim()
    const currentRequestId = requestIdRef.current + 1
    requestIdRef.current = currentRequestId

    if (!normalized) {
      setResults([])
      setLoading(false)
      setError(null)
      setActiveIndex(0)
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ q: normalized })
        const [jpResponse, usResponse] = await Promise.all([
          fetch(`/api/search?${params.toString()}`, { cache: 'no-store', signal: controller.signal }),
          fetch(`/api/us/search?${params.toString()}`, { cache: 'no-store', signal: controller.signal }),
        ])

        const jpRows = jpResponse.ok ? ((await jpResponse.json()) as SearchApiResult[]) : []
        const usRows = usResponse.ok ? ((await usResponse.json()) as SearchApiResult[]) : []
        const commodityRows = COMMODITY_SEARCH_RESULTS.filter((result) => {
          const q = normalized.toLowerCase()
          return (
            result.ticker.toLowerCase().includes(q) ||
            result.name.toLowerCase().includes(q) ||
            (result.meta ?? '').toLowerCase().includes(q)
          )
        })
        const mappedRows: QuickSearchResult[] = [...jpRows, ...usRows].map((row) => ({
          key: `${row.market}:${row.ticker}`,
          ticker: row.ticker,
          name: row.name ?? row.ticker,
          market: row.market,
          href: searchResultHref(row),
          badge: searchResultBadge(row),
          meta: searchResultMeta(row),
        }))

        if (requestIdRef.current !== currentRequestId) return
        setResults(sortQuickSearchResults(area, normalized, [...commodityRows, ...mappedRows]))
        setActiveIndex(0)
      } catch (fetchError) {
        if ((fetchError as Error).name === 'AbortError') return
        if (requestIdRef.current !== currentRequestId) return
        setResults([])
        setError('検索に失敗しました')
      } finally {
        if (requestIdRef.current === currentRequestId) setLoading(false)
      }
    }, 180)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [area, query])

  const navigateTo = (href: string) => {
    setOpen(false)
    setQuery('')
    setResults([])
    router.push(href)
  }

  const submitCurrent = () => {
    const target = results[activeIndex] ?? results[0]
    if (target) {
      navigateTo(target.href)
      return
    }
    const fallback = fallbackSearchHref(query, area)
    if (fallback) navigateTo(fallback)
  }

  return (
    <div ref={rootRef} className="relative order-last w-full sm:order-none sm:min-w-[220px] sm:flex-1 md:max-w-[380px] xl:max-w-[460px]">
      <form
        role="search"
        className="relative"
        onSubmit={(event) => {
          event.preventDefault()
          submitCurrent()
        }}
      >
        <Search
          size={14}
          strokeWidth={2.3}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]"
        />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              setActiveIndex((current) => Math.min(current + 1, Math.max(results.length - 1, 0)))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex((current) => Math.max(current - 1, 0))
            } else if (event.key === 'Escape') {
              setOpen(false)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              submitCurrent()
            }
          }}
          placeholder="コード/銘柄名で検索"
          aria-label="銘柄コード検索"
          aria-expanded={open && !!query.trim()}
          className="h-8 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white py-1 pl-8 pr-3 text-[12px] font-semibold text-[var(--color-text-primary)] outline-none transition-colors placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-brand-700)] focus:ring-2 focus:ring-[rgba(37,99,235,0.16)]"
        />
      </form>

      {open && query.trim() && (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-[70] overflow-hidden rounded-[5px] border border-[var(--color-border-strong)] bg-white shadow-[0_18px_42px_rgba(16,32,52,0.22)]">
          <div className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[10px] font-bold text-[var(--color-text-tertiary)]">
            Enterで候補へ移動
          </div>
          {loading && (
            <div className="px-3 py-3 text-[12px] font-semibold text-[var(--color-text-secondary)]">検索中...</div>
          )}
          {!loading && error && (
            <div className="px-3 py-3 text-[12px] font-semibold text-[var(--color-price-down)]">{error}</div>
          )}
          {!loading && !error && results.length === 0 && (
            <div className="px-3 py-3 text-[12px] font-semibold text-[var(--color-text-secondary)]">
              候補が見つかりません
            </div>
          )}
          {!loading &&
            !error &&
            results.map((result, index) => (
              <button
                key={result.key}
                type="button"
                className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors ${
                  index === activeIndex ? 'bg-[var(--color-surface-subtle)]' : 'bg-white hover:bg-[var(--color-surface-subtle)]'
                }`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => navigateTo(result.href)}
              >
                <span className="inline-flex h-6 min-w-12 items-center justify-center rounded-[3px] border border-[var(--color-border-default)] bg-white px-1.5 text-[11px] font-black text-[var(--color-brand-900)]">
                  {result.ticker}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-bold text-[var(--color-text-primary)]">{result.name}</span>
                  {result.meta && (
                    <span className="mt-0.5 block truncate text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                      {result.meta}
                    </span>
                  )}
                </span>
                <span className="shrink-0 rounded-[3px] bg-[var(--color-brand-50)] px-1.5 py-0.5 text-[10px] font-black text-[var(--color-brand-800)]">
                  {result.badge}
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  )
}

export function Header() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const area = pathname.startsWith('/commodities') ? 'commodities' : pathname.startsWith('/us') ? 'us' : 'jp'
  const isUsArea = area === 'us'
  const isCommodityArea = area === 'commodities'
  const navItems = isCommodityArea ? COMMODITY_NAV_ITEMS : isUsArea ? US_NAV_ITEMS : NAV_ITEMS
  const navRef = useRef<HTMLDivElement>(null)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [marketStatus, setMarketStatus] = useState<'open' | 'closed'>('closed')
  const clocks = useClocks()
  const activeUniverse = area === 'jp' ? parseUniverseFilter(searchParams.get(UNIVERSE_FILTER_PARAM)) : null
  const activeUniverseMeta = getUniverseFilterMeta(activeUniverse)

  useEffect(() => {
    const getStatus = () => {
      if (area === 'us') return getNyseStatus()
      if (area === 'commodities') return getTseStatus() === 'open' || getNyseStatus() === 'open' ? 'open' : 'closed'
      return getTseStatus()
    }
    setMarketStatus(getStatus())
    const t = setInterval(() => setMarketStatus(getStatus()), 60000)
    return () => clearInterval(t)
  }, [area])

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

  const isEntryActive = (entry: NavEntry | (typeof US_NAV_ITEMS)[number] | (typeof COMMODITY_NAV_ITEMS)[number]) => {
    if ('kind' in entry && entry.kind === 'menu') {
      return entry.items.some((item) => {
        const includeInGroupActive = 'includeInGroupActive' in item ? item.includeInGroupActive : undefined
        return includeInGroupActive !== false && isActive(item.href)
      })
    }
    return isActive(entry.href)
  }

  const scopedHref = (href: string) => {
    return area === 'jp' ? addUniverseToHref(href, activeUniverse) : href
  }

  const universeToggleHref = (filter: UniverseFilterId) => {
    const params = new URLSearchParams(searchParams.toString())
    const current = parseUniverseFilter(params.get(UNIVERSE_FILTER_PARAM))
    if (current === filter) params.delete(UNIVERSE_FILTER_PARAM)
    else params.set(UNIVERSE_FILTER_PARAM, filter)
    const query = params.toString()
    return query ? `${pathname}?${query}` : pathname
  }

  const renderNavEntry = (entry: NavEntry | (typeof US_NAV_ITEMS)[number] | (typeof COMMODITY_NAV_ITEMS)[number], compact = false) => {
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
          href={scopedHref(entry.href)}
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
                  href={scopedHref(item.href)}
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
        <div className="mx-auto flex min-h-10 w-full max-w-[1480px] flex-wrap items-center justify-between gap-2 px-5 py-1.5 sm:px-8 lg:flex-nowrap lg:px-10 xl:px-12">
          <Link href={isCommodityArea ? '/commodities' : isUsArea ? '/us' : scopedHref('/')} prefetch={false} className="flex shrink-0 items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-[3px] bg-[var(--color-brand-800)] text-white shadow-sm">
              <BarChart3 size={16} strokeWidth={2.5} />
            </div>
            <div className="leading-tight">
              <div className="text-[16px] font-bold tracking-normal text-[var(--color-brand-900)]">StockBoard</div>
              <div className="hidden text-[10px] font-bold text-[var(--color-text-tertiary)] sm:block">
                {isCommodityArea ? 'Commodity ETF Console' : isUsArea ? 'Tiingo US Market Console' : 'J-Quants Market Console'}
              </div>
            </div>
          </Link>

          <div className="hidden shrink-0 items-center gap-1 rounded-[4px] border border-[var(--color-border-default)] bg-white p-1 md:flex">
            <Globe2 size={13} className="ml-1 text-[var(--color-text-tertiary)]" />
            <Link
              href={scopedHref('/')}
              prefetch={false}
              className={`rounded-[3px] px-2 py-1 text-[11px] font-bold ${area === 'jp' ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'}`}
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
            <Link
              href="/commodities"
              prefetch={false}
              className={`rounded-[3px] px-2 py-1 text-[11px] font-bold ${isCommodityArea ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'}`}
            >
              コモディティ
            </Link>
          </div>

          <TickerQuickSearch area={area} />

          {area === 'jp' && (
            <Link
              href={universeToggleHref('nikkei225')}
              prefetch={false}
              aria-pressed={activeUniverse === 'nikkei225'}
              className={`hidden h-8 shrink-0 items-center gap-1.5 rounded-[4px] border px-2.5 text-[11px] font-bold transition-colors md:inline-flex ${
                activeUniverse === 'nikkei225'
                  ? 'border-[var(--color-market-red)] bg-white text-[var(--color-market-red)] shadow-sm'
                  : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
              }`}
              title={activeUniverseMeta ? `${activeUniverseMeta.label}フィルターを解除` : '日経225採用銘柄だけに絞り込み'}
            >
              <ListFilter size={13} strokeWidth={2.4} />
              <span>{activeUniverseMeta?.shortLabel ?? '日経225'}</span>
            </Link>
          )}

          <div className="flex shrink-0 items-center gap-1 rounded-[4px] border border-[var(--color-border-default)] bg-white p-1 md:hidden">
            <Link
              href={scopedHref('/')}
              prefetch={false}
              className={`rounded-[3px] px-2 py-1 text-[11px] font-bold ${area === 'jp' ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-text-secondary)]'}`}
            >
              JP
            </Link>
            {area === 'jp' && (
              <Link
                href={universeToggleHref('nikkei225')}
                prefetch={false}
                aria-pressed={activeUniverse === 'nikkei225'}
                className={`rounded-[3px] px-2 py-1 text-[11px] font-bold ${
                  activeUniverse === 'nikkei225'
                    ? 'bg-[var(--color-market-red)] text-white'
                    : 'text-[var(--color-text-secondary)]'
                }`}
                title={activeUniverseMeta ? `${activeUniverseMeta.label}フィルターを解除` : '日経225採用銘柄だけに絞り込み'}
              >
                N225
              </Link>
            )}
            <Link
              href="/us"
              prefetch={false}
              className={`rounded-[3px] px-2 py-1 text-[11px] font-bold ${isUsArea ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-text-secondary)]'}`}
            >
              US
            </Link>
            <Link
              href="/commodities"
              prefetch={false}
              className={`rounded-[3px] px-2 py-1 text-[11px] font-bold ${isCommodityArea ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-text-secondary)]'}`}
            >
              COM
            </Link>
          </div>

          <div className="hidden shrink-0 items-center gap-1.5 lg:flex">
            <span className="inline-flex h-6 items-center gap-1.5 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-text-secondary)]">
              <Activity size={12} />
              {isCommodityArea ? '商品ETF' : isUsArea ? 'NYSE' : '東証'}
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
