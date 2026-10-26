import { addUniverseToHref, type UniverseFilterValue } from '@/lib/market-universe'
import { PAGE_CATALOG, type HeaderArea, type PageId } from './navigation'

export type MarketSwitchOption = {
  area: HeaderArea
  label: string
  shortLabel: string
  homePageId: PageId
}

export const MARKET_SWITCH_OPTIONS = [
  { area: 'jp', label: '日本株', shortLabel: 'JP', homePageId: 'dashboard' },
  { area: 'us', label: '米国株', shortLabel: 'US', homePageId: 'usDashboard' },
  { area: 'commodities', label: 'コモディティ', shortLabel: 'COM', homePageId: 'commoditiesDashboard' },
] as const satisfies readonly MarketSwitchOption[]

export type MarketCounterpart = Partial<Record<HeaderArea, PageId>>

/**
 * Pages that perform the same analytical task in more than one market.
 * The market switch keeps the user on the same task only through this table;
 * every other page lands on the target market's home.
 * Ticker detail pages are never mapped: a JP code and a US symbol are unrelated.
 */
export const MARKET_COUNTERPARTS = [
  { jp: 'dashboard', us: 'usDashboard', commodities: 'commoditiesDashboard' },
  { jp: 'marketMomentum', us: 'usMarketMomentum' },
  { jp: 'sectors', us: 'usSectors' },
  { jp: 'sectorEtfs', us: 'usSectorEtfs' },
  { jp: 'earnings', us: 'usEarnings' },
  { jp: 'mtfCloseCalendar', us: 'usMtfCloseCalendar' },
  { jp: 'screener', us: 'usScreener', commodities: 'commoditiesScreener' },
  { jp: 'periodExplorer', us: 'usPeriodExplorer' },
  { jp: 'stageScreener', us: 'usStageScreener' },
  { jp: 'triggerDiscovery', us: 'usTriggerDiscovery' },
  { jp: 'aiResearch', us: 'usAiResearch' },
  { jp: 'maLens', us: 'usMlLens' },
  { jp: 'transitions', us: 'usTransitions' },
  { jp: 'backtest', us: 'usBacktest' },
  { jp: 'tradeWorkbench', us: 'usTradeWorkbench' },
  { jp: 'chartDrill', us: 'usChartDrill' },
  { jp: 'ma25mMonitor', us: 'usMa25mMonitor' },
] as const satisfies readonly MarketCounterpart[]

/** Navigation pages that intentionally have no equivalent in another market. */
export const MARKET_SPECIFIC_PAGE_IDS = {
  jp: [
    'themes',
    'materials',
    'hexStage',
    'largeHolders',
  ],
  us: [],
  commodities: [],
} as const satisfies Record<HeaderArea, readonly PageId[]>

/**
 * Market-agnostic pages listed under several markets. They have no market
 * query, so a market switch from them goes home instead of appending one.
 */
export const SHARED_PAGE_IDS = ['watchlist', 'customCharts'] as const satisfies readonly PageId[]

export function hrefPath(href: string): string {
  return href.split(/[?#]/)[0] || '/'
}

function isUnder(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`)
}

/**
 * Which market a URL belongs to. `market` is only honoured on the shared
 * routes whose pages read it (/ai/*, /chart-drill); elsewhere it is a page
 * filter (e.g. JP market segment on /period-explorer) and must be ignored.
 */
export function resolveHeaderArea(pathname: string, marketParam: string | null | undefined): HeaderArea {
  if (isUnder(pathname, '/commodities') || (pathname.startsWith('/ai/') && marketParam === 'COMMODITY')) {
    return 'commodities'
  }
  if (
    isUnder(pathname, '/us')
    || (pathname.startsWith('/ai/') && marketParam === 'US')
    || (pathname === '/chart-drill' && marketParam?.toUpperCase() === 'US')
  ) {
    return 'us'
  }
  return 'jp'
}

export function findCounterpart(pathname: string, area: HeaderArea): MarketCounterpart | null {
  return MARKET_COUNTERPARTS.find((group: MarketCounterpart) => {
    const pageId = group[area]
    return pageId !== undefined && hrefPath(PAGE_CATALOG[pageId].href) === pathname
  }) ?? null
}

export type MarketSwitchDestination = 'current' | 'counterpart' | 'home'

export type MarketSwitchLink = {
  area: HeaderArea
  label: string
  shortLabel: string
  href: string
  active: boolean
  destination: MarketSwitchDestination
  title: string
}

export function buildMarketSwitchLinks({
  pathname,
  marketParam,
  universe = null,
}: {
  pathname: string
  marketParam: string | null | undefined
  universe?: UniverseFilterValue
}): MarketSwitchLink[] {
  const currentArea = resolveHeaderArea(pathname, marketParam)
  const counterpart = findCounterpart(pathname, currentArea)

  return MARKET_SWITCH_OPTIONS.map((option) => {
    const active = option.area === currentArea
    const targetPageId: PageId | undefined = active ? undefined : counterpart?.[option.area]
    const pageId = targetPageId ?? option.homePageId
    const destination: MarketSwitchDestination = active ? 'current' : targetPageId ? 'counterpart' : 'home'
    const baseHref = PAGE_CATALOG[pageId].href
    // The Nikkei 225 universe is a JP-only filter; it never crosses markets.
    const href = option.area === 'jp' && active ? addUniverseToHref(baseHref, universe) : baseHref
    const title = destination === 'current'
      ? `表示中の市場: ${option.label}（${option.label}ホームへ）`
      : destination === 'counterpart'
        ? `${option.label}の「${PAGE_CATALOG[pageId].label}」へ切り替え`
        : `${option.label}ホームへ切り替え（この画面に対応する${option.label}ページはありません）`

    return {
      area: option.area,
      label: option.label,
      shortLabel: option.shortLabel,
      href,
      active,
      destination,
      title,
    }
  })
}
