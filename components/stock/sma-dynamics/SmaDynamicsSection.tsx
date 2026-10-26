'use client'

// Stock-detail integration shared by every JP and US security page. Nothing is
// fetched until the user opens the lab; the history adapter is injectable so the
// dev preview runs the same component on fixtures without any network access.
import { useEffect, useState } from 'react'
import { ChevronDown, Maximize2 } from 'lucide-react'
import type { SmaDynamicsMarket } from '@/lib/sma-dynamics'
import type { SmaLabRawRow } from '@/lib/sma-dynamics-timeframes'
import { linkIntentToSettingsPatch, type SmaLinkIntent } from '@/lib/sma-dynamics-link'
import {
  SMA_DYNAMICS_DEFAULT_SETTINGS,
  SMA_DYNAMICS_LAUNCHER_SUBTITLE,
  SMA_DYNAMICS_TITLE,
  securityLabel,
  SmaDynamicsView,
  type SmaDynamicsLoadState,
  type SmaDynamicsSecurity,
  type SmaDynamicsSettings,
  type SmaExternalScenarioInput,
} from './SmaDynamicsView'

// Long SMAs on weekly/monthly/quarterly bars and past analysis dates need the full
// history, so read it all once (same route and price basis as the main chart).
export const SMA_DYNAMICS_HISTORY_PERIOD = 'all'
export const SMA_DYNAMICS_OPEN_PREF_KEY = 'stockboard:sma-dynamics-lab:open'
const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX_ENTRIES = 6

/** What identifies a price history: the display name is deliberately not part of it. */
export type SmaHistoryIdentity = Pick<SmaDynamicsSecurity, 'market' | 'ticker'>

export interface SmaDynamicsHistorySource {
  /** Part of the cache key, so different sources never share rows. */
  id: string
  label: string
  priceBasis: (market: SmaDynamicsMarket) => string
  load: (security: SmaHistoryIdentity, signal: AbortSignal) => Promise<ReadonlyArray<SmaLabRawRow>>
}

/** Existing history routes used by the main chart (JP: /api/history, US: /api/us/history). */
export const STOCK_HISTORY_API_SOURCE: SmaDynamicsHistorySource = {
  id: 'stock-history-api',
  label: '日足履歴API (メインチャートと同じ)',
  priceBasis: (market) => (market === 'US' ? '調整済み日足 (メインチャートと同じ)' : 'J-Quants日足・分割推定補正 (メインチャートと同じ)'),
  load: async (security, signal) => {
    const basePath = security.market === 'US' ? '/api/us/history' : '/api/history'
    const res = await fetch(`${basePath}/${encodeURIComponent(security.ticker)}?period=${SMA_DYNAMICS_HISTORY_PERIOD}`, { cache: 'no-store', signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const rows: unknown = await res.json()
    if (!Array.isArray(rows)) throw new Error('unexpected response')
    return rows as SmaLabRawRow[]
  },
}

export function smaHistoryCacheKey(source: SmaDynamicsHistorySource, security: SmaHistoryIdentity): string {
  return `${source.id}|${security.market}|${security.ticker}`
}

const historyCache = new Map<string, { rows: ReadonlyArray<SmaLabRawRow>; at: number }>()

export function clearSmaHistoryCache() {
  historyCache.clear()
}

function readCache(key: string, now: number) {
  const hit = historyCache.get(key)
  if (!hit) return null
  if (now - hit.at > CACHE_TTL_MS) {
    historyCache.delete(key)
    return null
  }
  historyCache.delete(key)
  historyCache.set(key, hit)
  return hit.rows
}

function writeCache(key: string, rows: ReadonlyArray<SmaLabRawRow>, now: number) {
  historyCache.set(key, { rows, at: now })
  while (historyCache.size > CACHE_MAX_ENTRIES) historyCache.delete(historyCache.keys().next().value as string)
}

/**
 * Loads one security's history and reports states until cancelled. After cancel()
 * no callback fires, so a slow response for the previous security can never reach
 * the next one.
 */
export function subscribeSmaHistory(
  source: SmaDynamicsHistorySource | null,
  security: SmaHistoryIdentity,
  onState: (state: SmaDynamicsLoadState) => void,
  now: () => number = Date.now,
): () => void {
  if (!source) {
    onState({ status: 'unconnected', message: 'この画面では価格履歴に接続していません (実データ未接続)。' })
    return () => {}
  }
  const key = smaHistoryCacheKey(source, security)
  const cached = readCache(key, now())
  if (cached) {
    onState({ status: 'ready', rows: cached })
    return () => {}
  }
  let active = true
  const controller = new AbortController()
  onState({ status: 'loading' })
  source.load(security, controller.signal).then(
    (rows) => {
      if (!active) return
      writeCache(key, rows, now())
      onState({ status: 'ready', rows })
    },
    (error: unknown) => {
      if (!active) return
      onState({ status: 'error', message: error instanceof Error && error.message ? error.message : 'fetch failed' })
    },
  )
  return () => {
    active = false
    controller.abort()
  }
}

export function SmaDynamicsSection({
  market,
  ticker,
  name,
  analysisDate,
  source = STOCK_HISTORY_API_SOURCE,
  defaultOpen = false,
  defaultMaximized = false,
  initialSettings = SMA_DYNAMICS_DEFAULT_SETTINGS,
  externalScenarios,
  linkIntent = null,
}: {
  market: SmaDynamicsMarket
  ticker: string
  name: string | null
  analysisDate: string | null
  /** null renders the explicit "not connected" state. */
  source?: SmaDynamicsHistorySource | null
  defaultOpen?: boolean
  defaultMaximized?: boolean
  initialSettings?: SmaDynamicsSettings
  /** Phase 3B scenario evidence; supplied only by the dev fixture preview for now. */
  externalScenarios?: SmaExternalScenarioInput
  /** A validated link (lib/sma-dynamics-link): opens the lab with the requested view. */
  linkIntent?: SmaLinkIntent | null
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [startMaximized, setStartMaximized] = useState(defaultMaximized)
  // View settings carry over between securities; loaded rows and results never do.
  const [settings, setSettings] = useState<SmaDynamicsSettings>(initialSettings)
  const security: SmaDynamicsSecurity = { market, ticker, name }

  // A link opens the lab once per distinct request, with the settings it names layered on the current ones.
  const linkKey = linkIntent ? JSON.stringify(linkIntent) : null
  useEffect(() => {
    if (!linkIntent) return
    setSettings((current) => ({ ...current, ...linkIntentToSettingsPatch(linkIntent) }))
    setOpen(true)
    // linkKey carries the whole intent; the object identity may change on every parse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkKey])

  useEffect(() => {
    if (defaultOpen) return
    try {
      if (window.localStorage.getItem(SMA_DYNAMICS_OPEN_PREF_KEY) === '1') setOpen(true)
    } catch {
      // Storage may be unavailable (private mode); the launcher stays closed.
    }
  }, [defaultOpen])

  const setOpenPreference = (next: boolean, maximize = false) => {
    setOpen(next)
    setStartMaximized(maximize)
    try {
      window.localStorage.setItem(SMA_DYNAMICS_OPEN_PREF_KEY, next ? '1' : '0')
    } catch {
      // Preference only.
    }
  }

  if (!open) {
    return (
      <section
        className="rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white"
        aria-label={`${SMA_DYNAMICS_TITLE} ${securityLabel(security)}`}
        data-section="SMA dynamics"
        data-sma-dynamics-launcher
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-3 sm:px-4">
          <div className="min-w-0">
            <h2 className="m-0 text-[14px] font-bold text-[var(--color-text-primary)]">{SMA_DYNAMICS_TITLE}</h2>
            <p className="m-0 mt-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">
              {SMA_DYNAMICS_LAUNCHER_SUBTITLE}。1D〜3Mのローソク足・SMA3〜300・価格固定/シナリオ/逆算。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={() => setOpenPreference(true)}>
              <ChevronDown size={13} aria-hidden="true" />
              開く
            </button>
            <button type="button" className="btn" data-size="sm" onClick={() => setOpenPreference(true, true)} title="最大化して開く">
              <Maximize2 size={13} aria-hidden="true" />
              <span className="max-sm:sr-only">最大化で開く</span>
            </button>
          </div>
        </div>
      </section>
    )
  }

  return (
    <SmaDynamicsLoader
      key={`${source ? smaHistoryCacheKey(source, security) : `none|${market}|${ticker}`}|${linkKey ?? ''}`}
      security={security}
      analysisDate={analysisDate}
      source={source}
      settings={settings}
      onSettingsChange={setSettings}
      initialMaximized={startMaximized}
      onCollapse={() => setOpenPreference(false)}
      externalScenarios={externalScenarios}
      linkIntent={linkIntent}
    />
  )
}

/** Keyed by source + market + ticker: a new security always starts from an empty state. */
function SmaDynamicsLoader({
  security,
  analysisDate,
  source,
  settings,
  onSettingsChange,
  initialMaximized,
  onCollapse,
  externalScenarios,
  linkIntent,
}: {
  security: SmaDynamicsSecurity
  analysisDate: string | null
  source: SmaDynamicsHistorySource | null
  settings: SmaDynamicsSettings
  onSettingsChange: (settings: SmaDynamicsSettings) => void
  initialMaximized: boolean
  onCollapse: () => void
  externalScenarios?: SmaExternalScenarioInput
  linkIntent: SmaLinkIntent | null
}) {
  const [load, setLoad] = useState<SmaDynamicsLoadState>({ status: 'loading' })
  const { market, ticker } = security

  useEffect(() => subscribeSmaHistory(source, { market, ticker }, setLoad), [source, market, ticker])

  return (
    <SmaDynamicsView
      security={security}
      analysisDate={analysisDate}
      load={load}
      dataSource={source
        ? { label: source.label, priceBasis: source.priceBasis(security.market) }
        : { label: '未接続', priceBasis: '—' }}
      initialSettings={settings}
      onSettingsChange={onSettingsChange}
      initialMaximized={initialMaximized}
      onCollapse={onCollapse}
      externalScenarios={externalScenarios}
      linkIntent={linkIntent}
    />
  )
}
