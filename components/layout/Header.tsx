'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  BarChart3,
  ChevronDown,
  Clock3,
  Globe2,
  ListFilter,
  Search,
  X,
  type LucideIcon,
} from 'lucide-react'
import { COMMODITY_INSTRUMENTS } from '@/lib/commodities'
import {
  getRecentSymbols,
  symbolHref,
  WORKSPACE_EVENT,
  type WorkspaceSymbol,
} from '@/lib/client/stock-workspace'
import {
  addUniverseToHref,
  getUniverseFilterMeta,
  parseUniverseFilter,
  UNIVERSE_FILTER_PARAM,
  type UniverseFilterId,
} from '@/lib/market-universe'
import { isValidTickerForMarket } from '@/lib/markets'
import {
  NAVIGATION_BY_AREA,
  PAGE_CATALOG,
  PAGE_CATALOG_ENTRIES,
  QUICK_COMMAND_PAGE_IDS_BY_AREA,
  type HeaderArea,
  type NavigationEntry,
  type PageId,
} from '@/components/layout/navigation'

interface ClockData {
  date: string
  shortDate: string
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

function fmtShortDate(now: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    timeZone: 'Asia/Tokyo',
  }).format(now)
}

function useClocks(): ClockData {
  const [data, setData] = useState<ClockData>({ date: '', shortDate: '', jst: '', ldn: '', nyc: '' })
  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setData({
        date: fmtDate(now),
        shortDate: fmtShortDate(now),
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
  majorCategory?: string | null
  subIndustry?: string | null
  exchange?: string | null
  sectorName?: string | null
  industryName?: string | null
  assetType?: string | null
}

type QuickSearchResult = {
  key: string
  ticker: string
  name: string
  market: 'JP' | 'US' | 'COMMODITY' | 'COMMAND'
  href: string
  badge: string
  meta?: string | null
  searchText?: string
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

const COMMAND_SEARCH_RESULTS: QuickSearchResult[] = PAGE_CATALOG_ENTRIES.map(([pageId, page]) => ({
  key: `command:${pageId}`,
  ticker: page.commandVerb,
  name: page.label,
  market: 'COMMAND',
  href: page.href,
  badge: page.commandBadge,
  meta: page.description,
  searchText: page.searchTerms,
}))

const COMMAND_SEARCH_RESULTS_BY_PAGE_ID = new Map<PageId, QuickSearchResult>(
  PAGE_CATALOG_ENTRIES.map(([pageId]) => [
    pageId,
    COMMAND_SEARCH_RESULTS.find((result) => result.key === `command:${pageId}`)!,
  ]),
)

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
  return [
    result.marketSegment,
    result.majorCategory ? `60分類: ${result.majorCategory}` : null,
    result.subIndustry ? `細分類: ${result.subIndustry}` : null,
    result.sector17Name,
    result.marginType,
  ].filter(Boolean).join(' / ') || null
}

function areaPriority(area: HeaderArea, result: QuickSearchResult): number {
  if (result.market === 'COMMAND') return 0
  if (area === 'commodities') return result.market === 'COMMODITY' ? 0 : result.market === 'JP' ? 1 : 2
  if (area === 'us') return result.market === 'US' ? 0 : result.market === 'COMMODITY' ? 1 : 2
  return result.market === 'JP' ? 0 : result.market === 'COMMODITY' ? 1 : 2
}

function commandMatches(query: string): QuickSearchResult[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []
  return COMMAND_SEARCH_RESULTS.filter((result) => (
    `${result.name} ${result.meta ?? ''} ${result.searchText ?? ''} ${result.ticker}`.toLowerCase().includes(normalized)
  ))
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
  if (isValidTickerForMarket(normalized, 'JP')) return `/stock/${encodeURIComponent(normalized)}`
  if (isValidTickerForMarket(normalized, 'US')) return `/us/stock/${encodeURIComponent(normalized)}`
  return null
}

function TickerQuickSearch({ area }: { area: HeaderArea }) {
  const router = useRouter()
  const rootRef = useRef<HTMLDivElement>(null)
  const desktopInputRef = useRef<HTMLInputElement>(null)
  const mobileInputRef = useRef<HTMLInputElement>(null)
  const requestIdRef = useRef(0)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<QuickSearchResult[]>([])
  const [recentSymbols, setRecentSymbols] = useState<WorkspaceSymbol[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [open, setOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setMobileOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  useEffect(() => {
    const syncRecent = () => setRecentSymbols(getRecentSymbols())
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(true)
        if (window.matchMedia('(max-width: 639px)').matches) {
          setMobileOpen(true)
          window.requestAnimationFrame(() => mobileInputRef.current?.focus())
        } else {
          desktopInputRef.current?.focus()
        }
      }
    }
    syncRecent()
    window.addEventListener(WORKSPACE_EVENT, syncRecent)
    window.addEventListener('storage', syncRecent)
    window.addEventListener('keydown', onShortcut)
    return () => {
      window.removeEventListener(WORKSPACE_EVENT, syncRecent)
      window.removeEventListener('storage', syncRecent)
      window.removeEventListener('keydown', onShortcut)
    }
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
        setResults(sortQuickSearchResults(area, normalized, [
          ...commandMatches(normalized),
          ...commodityRows,
          ...mappedRows,
        ]))
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
    setMobileOpen(false)
    setQuery('')
    setResults([])
    router.push(href)
  }

  const recentResults: QuickSearchResult[] = recentSymbols.map((symbol) => ({
    key: `recent:${symbol.market}:${symbol.ticker}`,
    ticker: symbol.ticker,
    name: symbol.name || symbol.ticker,
    market: symbol.market,
    href: symbolHref(symbol),
    badge: symbol.market,
    meta: '最近見た銘柄',
  }))
  const quickCommands = QUICK_COMMAND_PAGE_IDS_BY_AREA[area]
    .map((pageId) => COMMAND_SEARCH_RESULTS_BY_PAGE_ID.get(pageId))
    .filter((result): result is QuickSearchResult => Boolean(result))
  const visibleResults = query.trim() ? results : [...recentResults, ...quickCommands].slice(0, 8)

  const submitCurrent = () => {
    const target = visibleResults[activeIndex] ?? visibleResults[0]
    if (target) {
      navigateTo(target.href)
      return
    }
    const fallback = fallbackSearchHref(query, area)
    if (fallback) navigateTo(fallback)
  }

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((current) => Math.min(current + 1, Math.max(visibleResults.length - 1, 0)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Escape') {
      setOpen(false)
      setMobileOpen(false)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      submitCurrent()
    }
  }

  const renderResultPanel = (mobile = false) => (
    <div
      className={mobile
        ? 'max-h-[min(70vh,560px)] overflow-y-auto border-t border-[var(--color-border-default)] bg-white'
        : 'absolute left-0 right-0 top-[calc(100%+6px)] z-[70] overflow-hidden rounded-[5px] border border-[var(--color-border-strong)] bg-white shadow-[0_18px_42px_rgba(16,32,52,0.22)]'}
    >
      <div className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[10px] font-bold text-[var(--color-text-tertiary)]">
        {query.trim() ? '銘柄・分類・機能を検索 / Enterで移動' : '最近見た銘柄・よく使う機能'}
      </div>
      {loading && (
        <div className="px-3 py-3 text-[12px] font-semibold text-[var(--color-text-secondary)]">検索中...</div>
      )}
      {!loading && error && (
        <div className="px-3 py-3 text-[12px] font-semibold text-[var(--color-price-down)]">{error}</div>
      )}
      {!loading && !error && visibleResults.length === 0 && (
        <div className="px-3 py-3 text-[12px] font-semibold text-[var(--color-text-secondary)]">
          候補が見つかりません
        </div>
      )}
      {!loading &&
        !error &&
        visibleResults.map((result, index) => (
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
  )

  return (
    <div ref={rootRef} className="header-quick-search relative shrink-0 sm:min-w-[220px] sm:flex-1 md:max-w-[380px] xl:max-w-[460px]">
      <div className="hidden sm:block">
        <form
          role="search"
          className="relative"
          onSubmit={(event) => {
            event.preventDefault()
            submitCurrent()
          }}
        >
          <Search size={14} strokeWidth={2.3} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
          <input
            ref={desktopInputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onSearchKeyDown}
            placeholder="銘柄・分類・機能を検索 ⌘K"
            aria-label="銘柄・分類・機能検索"
            aria-expanded={open && visibleResults.length > 0}
            className="h-8 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white py-1 pl-8 pr-3 text-[12px] font-semibold text-[var(--color-text-primary)] outline-none transition-colors placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-brand-700)] focus:ring-2 focus:ring-[rgba(37,99,235,0.16)]"
          />
        </form>
        {open && (query.trim() || visibleResults.length > 0) && renderResultPanel()}
      </div>

      <button
        type="button"
        className="inline-flex h-8 w-8 items-center justify-center rounded-[3px] border border-[var(--color-border-default)] bg-white text-[var(--color-brand-800)] sm:hidden"
        aria-label="銘柄・分類・機能を検索"
        aria-expanded={mobileOpen}
        onClick={() => {
          setMobileOpen(true)
          setOpen(true)
          window.requestAnimationFrame(() => mobileInputRef.current?.focus())
        }}
      >
        <Search size={16} strokeWidth={2.3} />
      </button>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-[90] bg-[rgba(16,32,52,0.36)] p-3 sm:hidden"
          onClick={() => {
            setMobileOpen(false)
            setOpen(false)
          }}
        >
          <div
            className="overflow-hidden rounded-[5px] border border-[var(--color-border-strong)] bg-white shadow-[0_18px_42px_rgba(16,32,52,0.28)]"
            onClick={(event) => event.stopPropagation()}
          >
            <form
              role="search"
              className="flex items-center gap-2 p-2"
              onSubmit={(event) => {
                event.preventDefault()
                submitCurrent()
              }}
            >
              <div className="relative min-w-0 flex-1">
                <Search size={15} strokeWidth={2.3} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
                <input
                  ref={mobileInputRef}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setOpen(true)
                  }}
                  onKeyDown={onSearchKeyDown}
                  placeholder="銘柄・分類・機能を検索"
                  aria-label="銘柄・分類・機能検索"
                  aria-expanded={visibleResults.length > 0}
                  className="h-10 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white py-1 pl-8 pr-3 text-[13px] font-semibold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-700)] focus:ring-2 focus:ring-[rgba(37,99,235,0.16)]"
                />
              </div>
              <button
                type="button"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[3px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]"
                aria-label="検索を閉じる"
                onClick={() => {
                  setMobileOpen(false)
                  setOpen(false)
                }}
              >
                <X size={18} />
              </button>
            </form>
            {renderResultPanel(true)}
          </div>
        </div>
      )}
    </div>
  )
}

export function Header() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const requestedMarket = searchParams.get('market')
  const area = pathname.startsWith('/commodities')
    || (pathname.startsWith('/ai/') && requestedMarket === 'COMMODITY')
    ? 'commodities'
    : pathname.startsWith('/us')
      || (pathname.startsWith('/ai/') && requestedMarket === 'US')
      ? 'us'
      : 'jp'
  const isUsArea = area === 'us'
  const isCommodityArea = area === 'commodities'
  const navItems: readonly NavigationEntry[] = NAVIGATION_BY_AREA[area]
  const navRef = useRef<HTMLDivElement>(null)
  const clockRef = useRef<HTMLDivElement>(null)
  const menuPanelRef = useRef<HTMLDivElement>(null)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [clocksOpen, setClocksOpen] = useState(false)
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
      if (!clockRef.current?.contains(event.target as Node)) setClocksOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenu(null)
        setClocksOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  useEffect(() => {
    setOpenMenu(null)
    setClocksOpen(false)
  }, [pathname, requestedMarket])

  const isActive = (href: string) => {
    const path = hrefPath(href)
    if (path === '/') return pathname === '/'
    if (path === '/us') return pathname === '/us'
    return pathname === path || pathname.startsWith(`${path}/`)
  }

  const isEntryActive = (entry: NavigationEntry) => {
    if (entry.kind === 'menu') {
      return entry.sections.some((section) => section.pageIds.some((pageId) => isActive(PAGE_CATALOG[pageId].href)))
    }
    return isActive(PAGE_CATALOG[entry.pageId].href)
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

  const focusFirstMenuItem = () => {
    window.requestAnimationFrame(() => {
      menuPanelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    })
  }

  const renderNavEntry = (entry: NavigationEntry) => {
    const active = isEntryActive(entry)
    const baseClasses = `header-nav-entry inline-flex h-10 min-w-0 items-center justify-center gap-1 rounded-[2px] border px-1 text-[11px] font-bold leading-none transition-colors sm:h-9 sm:flex-none sm:gap-2.5 sm:px-4 sm:text-[13px] ${
      active
        ? 'border-[var(--color-market-red-dark)] bg-[var(--color-market-red)] text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.16)]'
        : 'border-[#2a71b8] bg-[#075aa7] text-white hover:border-[#9fc0e5] hover:bg-[#0c67bd]'
    }`

    if (entry.kind === 'link') {
      const page = PAGE_CATALOG[entry.pageId]
      return (
        <Link
          key={entry.pageId}
          href={scopedHref(page.href)}
          prefetch={false}
          className={baseClasses}
          onClick={() => setOpenMenu(null)}
        >
          <NavIcon icon={entry.icon} active={active} />
          <span className="whitespace-nowrap sm:hidden">{entry.shortLabel}</span>
          <span className="hidden whitespace-nowrap sm:inline">{entry.label}</span>
        </Link>
      )
    }

    const menuOpen = openMenu === entry.id
    return (
      <button
        key={entry.id}
        type="button"
        className={baseClasses}
        data-testid={`nav-menu-${entry.id}`}
        aria-haspopup="menu"
        aria-controls={`nav-menu-panel-${entry.id}`}
        aria-expanded={menuOpen}
        onMouseEnter={() => {
          if (window.matchMedia('(min-width: 640px) and (hover: hover)').matches) setOpenMenu(entry.id)
        }}
        onClick={() => {
          const desktopHover = window.matchMedia('(min-width: 640px) and (hover: hover)').matches
          setOpenMenu((current) => desktopHover ? entry.id : current === entry.id ? null : entry.id)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpenMenu(entry.id)
            focusFirstMenuItem()
          }
        }}
      >
        <NavIcon icon={entry.icon} active={active || menuOpen} />
        <span className="whitespace-nowrap sm:hidden">{entry.shortLabel}</span>
        <span className="hidden whitespace-nowrap sm:inline">{entry.label}</span>
        <ChevronDown
          size={14}
          strokeWidth={2.4}
          className={`hidden transition-transform sm:block ${menuOpen ? 'rotate-180' : ''}`}
        />
      </button>
    )
  }

  const openMenuEntry = navItems.find((entry): entry is Extract<NavigationEntry, { kind: 'menu' }> => (
    entry.kind === 'menu' && entry.id === openMenu
  ))
  const openMenuColumns = openMenuEntry
    ? ([1, 2] as const)
        .map((column) => openMenuEntry.sections.filter((section) => (section.column ?? 1) === column))
        .filter((sections) => sections.length > 0)
    : []

  const onMenuPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(menuPanelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Home') items[0].focus()
    else if (event.key === 'End') items[items.length - 1].focus()
    else if (event.key === 'ArrowDown') items[(current + 1 + items.length) % items.length].focus()
    else items[(current - 1 + items.length) % items.length].focus()
  }

  return (
    <header className="relative z-30 border-b border-[var(--color-border-strong)] bg-white shadow-[0_1px_3px_rgba(16,32,52,0.12)]">
      <div className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)]">
        <div className="header-top-row mx-auto flex min-h-10 w-full max-w-[1480px] flex-wrap items-center justify-between gap-2 px-3 py-1 sm:px-8 sm:py-1.5 lg:px-10 xl:px-12">
          <Link
            href={isCommodityArea ? '/commodities' : isUsArea ? '/us' : scopedHref('/')}
            prefetch={false}
            aria-label="StockBoard ホーム"
            className="flex shrink-0 items-center gap-2.5"
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-[3px] bg-[var(--color-brand-800)] text-white shadow-sm">
              <BarChart3 size={16} strokeWidth={2.5} />
            </div>
            <div className="header-brand-copy leading-tight">
              <div className="text-[16px] font-bold tracking-normal text-[var(--color-brand-900)]">StockBoard</div>
              <div className="hidden text-[10px] font-bold text-[var(--color-text-tertiary)] sm:block">
                {isCommodityArea ? 'Commodity ETF Console' : isUsArea ? 'US Market Console' : 'J-Quants Market Console'}
              </div>
            </div>
          </Link>

          <div className="header-market-switcher shrink-0 items-center gap-1 rounded-[4px] border border-[var(--color-border-default)] bg-white p-1">
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
              className={`hidden h-8 shrink-0 items-center gap-1.5 rounded-[4px] border px-2.5 text-[11px] font-bold transition-colors lg:inline-flex ${
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

          <div className="header-market-switcher-compact shrink-0 items-center gap-1 rounded-[4px] border border-[var(--color-border-default)] bg-white p-1">
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
                className={`hidden rounded-[3px] px-2 py-1 text-[11px] font-bold ${
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

          <div ref={clockRef} className="header-market-context relative shrink-0 items-center gap-1.5">
            <span className="inline-flex h-6 items-center gap-1 rounded-[3px] border border-[var(--color-border-default)] bg-white px-1.5 text-[10px] font-bold text-[var(--color-text-secondary)] sm:gap-1.5 sm:px-2 sm:text-[11px]">
              <Activity size={12} className="header-market-status-icon" />
              <span className="header-market-short-label">{isCommodityArea ? 'COM' : isUsArea ? 'US' : 'JP'}</span>
              <span className="header-market-long-label">{isCommodityArea ? '商品ETF' : isUsArea ? 'NYSE' : '東証'}</span>
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
              className="inline-flex h-6 items-center rounded-[3px] border border-[var(--color-border-default)] bg-white px-1.5 text-[10px] font-semibold text-[var(--color-text-primary)] tabular-nums sm:px-2 sm:text-[11px]"
              suppressHydrationWarning
            >
              <span className="header-market-short-label">{clocks.shortDate || '--/--'}</span>
              <span className="header-market-long-label">{clocks.date || '----/--/--'}</span>
            </span>
            <div className="header-clock-inline items-center gap-1.5">
              <ClockChip label="TYO" time={clocks.jst} />
              <ClockChip label="LDN" time={clocks.ldn} />
              <ClockChip label="NYC" time={clocks.nyc} />
            </div>
            <button
              type="button"
              className="header-clock-toggle h-6 w-6 items-center justify-center rounded-[3px] border border-[var(--color-border-default)] bg-white text-[var(--color-brand-800)]"
              aria-label="市場時計を表示"
              aria-expanded={clocksOpen}
              onClick={() => setClocksOpen((current) => !current)}
            >
              <Clock3 size={12} />
            </button>
            {clocksOpen && (
              <div className="header-clock-popover absolute right-0 top-[calc(100%+5px)] z-[75] items-center gap-1.5 rounded-[4px] border border-[var(--color-border-strong)] bg-white p-2 shadow-[0_12px_28px_rgba(16,32,52,0.22)]">
                <ClockChip label="TYO" time={clocks.jst} />
                <ClockChip label="LDN" time={clocks.ldn} />
                <ClockChip label="NYC" time={clocks.nyc} />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-[var(--color-brand-800)]">
        <div
          ref={navRef}
          className="relative mx-auto flex min-h-12 w-full max-w-[1480px] items-center justify-between gap-4 px-3 py-1 sm:px-8 sm:py-1.5 lg:px-10 xl:px-12"
        >
          <nav aria-label="主要ナビゲーション" className="header-primary-nav min-w-0 flex-1 items-center gap-1 overflow-visible sm:gap-2">
            {navItems.map((item) => renderNavEntry(item))}
          </nav>

          {openMenuEntry && (
            <div
              ref={menuPanelRef}
              id={`nav-menu-panel-${openMenuEntry.id}`}
              role="menu"
              data-testid={`nav-menu-panel-${openMenuEntry.id}`}
              aria-label={openMenuEntry.label}
              className={`header-nav-panel absolute left-3 right-3 top-[calc(100%+30px)] z-50 max-h-[calc(100vh-142px)] overflow-y-auto rounded-[5px] border border-[var(--color-border-strong)] bg-white p-2 text-[var(--color-text-primary)] shadow-[0_16px_38px_rgba(16,32,52,0.25)] sm:left-8 sm:right-auto sm:max-w-[calc(100vw-64px)] sm:p-3 lg:left-10 xl:left-12 ${openMenuColumns.length === 1 ? 'sm:w-[420px]' : 'sm:w-[720px]'}`}
              onKeyDown={onMenuPanelKeyDown}
            >
              {area === 'jp' && openMenuEntry.id === 'market' && (
                <div className="mb-2 flex items-center justify-between gap-3 border-b border-[var(--color-border-default)] pb-2 sm:hidden">
                  <span className="text-[10px] font-bold text-[var(--color-text-tertiary)]">表示対象</span>
                  <Link
                    href={universeToggleHref('nikkei225')}
                    prefetch={false}
                    aria-pressed={activeUniverse === 'nikkei225'}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-[3px] border px-2.5 text-[11px] font-bold ${
                      activeUniverse === 'nikkei225'
                        ? 'border-[var(--color-market-red)] bg-[var(--color-market-red)] text-white'
                        : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'
                    }`}
                    onClick={() => setOpenMenu(null)}
                  >
                    <ListFilter size={13} />
                    日経225だけ表示
                  </Link>
                </div>
              )}
              <div className={`grid grid-cols-1 gap-2 sm:gap-3 ${openMenuColumns.length > 1 ? 'sm:grid-cols-2' : ''}`}>
                {openMenuColumns.map((sections, columnIndex) => (
                  <div key={columnIndex} className="min-w-0 space-y-2">
                    {sections.map((section) => (
                      <section key={section.id} aria-labelledby={`nav-section-${section.id}`} className="min-w-0">
                        <div
                          id={`nav-section-${section.id}`}
                          className="border-b border-[var(--color-border-default)] px-2 pb-1.5 pt-1 text-[10px] font-black text-[var(--color-brand-800)]"
                        >
                          {section.label}
                        </div>
                        <div className="mt-1 space-y-0.5">
                          {section.pageIds.map((pageId) => {
                            const page = PAGE_CATALOG[pageId]
                            const ItemIcon = page.icon
                            const itemActive = isActive(page.href)
                            return (
                              <Link
                                key={pageId}
                                href={scopedHref(page.href)}
                                prefetch={false}
                                role="menuitem"
                                className={`flex min-h-[50px] items-center gap-3 rounded-[3px] border px-2.5 py-2 text-left transition-colors ${
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
                                  <span className="block text-[13px] font-black leading-tight">{page.label}</span>
                                  <span className="mt-1 block text-[11px] font-semibold leading-snug text-[var(--color-text-tertiary)]">
                                    {page.description}
                                  </span>
                                </span>
                              </Link>
                            )
                          })}
                        </div>
                      </section>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
