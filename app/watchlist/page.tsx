'use client'

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  Download,
  GitCompareArrows,
  RefreshCw,
  Star,
  Trash2,
} from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { EmptyState } from '@/components/ui/EmptyState'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { StatStrip } from '@/components/ui/StatStrip'
import { WatchlistButton } from '@/components/ui/WatchlistButton'
import { StockPreviewTrigger } from '@/components/stock-preview/StockPreviewTrigger'
import { useWatchlistStore } from '@/lib/watchlist-store'
import {
  getCompareSymbols,
  toggleComparedSymbol,
  type WorkspaceMarket,
  type WorkspaceSymbol,
} from '@/lib/client/stock-workspace'
import { findTicker } from '@/lib/master/tickers'
import {
  getUniverseFilterMeta,
  isTickerInUniverse,
  parseUniverseFilter,
  UNIVERSE_FILTER_PARAM,
} from '@/lib/market-universe'
import { buildTvWatchlistText, toTvSymbol } from '@/lib/tv-format'
import type { StockQuote } from '@/types/stock'

type MarketView = 'ALL' | WorkspaceMarket

interface WatchRow {
  market: WorkspaceMarket
  ticker: string
  quote: StockQuote | null | undefined
}

export default function WatchlistPage() {
  const searchParams = useSearchParams()
  const activeUniverse = parseUniverseFilter(searchParams.get(UNIVERSE_FILTER_PARAM))
  const activeUniverseMeta = getUniverseFilterMeta(activeUniverse)
  const [mounted, setMounted] = useState(false)
  const [marketView, setMarketView] = useState<MarketView>('ALL')
  const [quotes, setQuotes] = useState<Record<string, StockQuote | null>>({})
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const tickers = useWatchlistStore((state) => state.tickers)
  const usTickers = useWatchlistStore((state) => state.usTickers)
  const clearAll = useWatchlistStore((state) => state.clearAll)

  const visibleJpTickers = useMemo(
    () => tickers.filter((ticker) => isTickerInUniverse(ticker, activeUniverse)),
    [activeUniverse, tickers],
  )
  const allRows = useMemo<WatchRow[]>(() => [
    ...visibleJpTickers.map((ticker) => ({
      market: 'JP' as const,
      ticker,
      quote: quotes[`JP:${ticker}`],
    })),
    ...usTickers.map((ticker) => ({
      market: 'US' as const,
      ticker,
      quote: quotes[`US:${ticker}`],
    })),
  ], [quotes, usTickers, visibleJpTickers])
  const alertCount = useMemo(
    () => allRows.filter((row) => getAlertLabel(row.quote) != null).length,
    [allRows],
  )

  useEffect(() => {
    setMounted(true)
  }, [])

  const fetchQuotes = useCallback(async () => {
    if (!mounted) return
    const symbols: WorkspaceSymbol[] = [
      ...visibleJpTickers.map((ticker) => ({ market: 'JP' as const, ticker })),
      ...usTickers.map((ticker) => ({ market: 'US' as const, ticker })),
    ]
    if (symbols.length === 0) {
      setQuotes({})
      return
    }

    setLoading(true)
    try {
      const entries = await Promise.all(symbols.map(async (symbol) => {
        const key = `${symbol.market}:${symbol.ticker}`
        const endpoint = symbol.market === 'US'
          ? `/api/us/quote/${encodeURIComponent(symbol.ticker)}`
          : `/api/quote/${encodeURIComponent(symbol.ticker)}`
        try {
          const response = await fetch(endpoint, { cache: 'no-store' })
          if (!response.ok) return [key, null] as const
          return [key, await response.json() as StockQuote] as const
        } catch {
          return [key, null] as const
        }
      }))
      setQuotes(Object.fromEntries(entries))
    } finally {
      setLoading(false)
    }
  }, [mounted, usTickers, visibleJpTickers])

  useEffect(() => {
    void fetchQuotes()
    const intervalId = window.setInterval(() => void fetchQuotes(), 60_000)
    return () => window.clearInterval(intervalId)
  }, [fetchQuotes])

  const toggleSelection = (market: WorkspaceMarket, ticker: string) => {
    const key = `${market}:${ticker}`
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else if (next.size < 4) next.add(key)
      return next
    })
  }

  const addSelectedToComparison = () => {
    const compared = getCompareSymbols()
    const existing = new Set(compared.map((symbol) => `${symbol.market}:${symbol.ticker}`))
    let slots = Math.max(0, 4 - compared.length)
    for (const row of allRows) {
      const key = `${row.market}:${row.ticker}`
      if (!selected.has(key) || existing.has(key) || slots === 0) continue
      toggleComparedSymbol({
        market: row.market,
        ticker: row.ticker,
        name: row.quote?.name,
      })
      existing.add(key)
      slots -= 1
    }
    setSelected(new Set())
  }

  const downloadTvWatchlist = () => {
    const symbols = visibleJpTickers.map((ticker) => {
      const master = findTicker(ticker)
      return toTvSymbol(ticker, master?.marketSegment)
    })
    const today = new Date().toISOString().split('T')[0]
    const sectionName = `Watchlist_${today}`
    const blob = new Blob(
      [buildTvWatchlistText(symbols, sectionName)],
      { type: 'text/plain;charset=utf-8' },
    )
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${sectionName}.txt`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }

  const showJp = marketView !== 'US'
  const showUs = marketView !== 'JP'
  const savedCount = tickers.length + usTickers.length

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageTitle
        eyebrow="監視"
        title="ウォッチリスト"
        subtitle="日本株・米国株の監視銘柄、急変の確認、銘柄比較をまとめて扱います。価格は60秒ごとに自動更新します。"
        badge={activeUniverseMeta?.shortLabel}
        rightSlot={
          <button type="button" onClick={() => void fetchQuotes()} disabled={loading} className="btn">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden />
            {loading ? '更新中' : '今すぐ更新'}
          </button>
        }
      />

      <StatStrip
        label="ウォッチリスト集計"
        items={[
          { label: '登録銘柄', value: `${savedCount}銘柄` },
          { label: '日本株', value: `${tickers.length}銘柄` },
          { label: '米国株', value: `${usTickers.length}銘柄` },
          { label: '要確認', value: <span className={alertCount > 0 ? 'text-amber-700' : undefined}>{alertCount}件</span>, sub: '取得失敗・品質注意・±5%以上' },
        ]}
      />

      <div className="toolbar flex flex-wrap items-center justify-between gap-2">
        <div className="view-tabs" role="group" aria-label="市場の切替">
          {([
            ['ALL', 'すべて', savedCount],
            ['JP', '日本株', tickers.length],
            ['US', '米国株', usTickers.length],
          ] as const).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMarketView(value)}
              className="view-tab"
              data-active={marketView === value}
              aria-pressed={marketView === value}
            >
              {label}
              <span className="view-tab__count">{count}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {selected.size > 0 && (
            <button type="button" onClick={addSelectedToComparison} className="btn" data-variant="primary">
              <GitCompareArrows size={14} aria-hidden />
              {selected.size}銘柄を比較
            </button>
          )}
          {visibleJpTickers.length > 0 && (
            <button
              type="button"
              onClick={downloadTvWatchlist}
              className="btn"
              title="日本株をTradingView形式でダウンロード"
            >
              <Download size={14} aria-hidden />
              TradingView用に保存
            </button>
          )}
          {savedCount > 0 && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm('JP・USのウォッチリストを全て削除しますか？')) clearAll()
              }}
              className="btn"
              data-variant="ghost"
            >
              <Trash2 size={14} aria-hidden />
              全クリア
            </button>
          )}
        </div>
      </div>

      {!mounted ? (
        <EmptyState title="ウォッチリストを読み込んでいます" description="保存済み銘柄を確認中です。" icon={<RefreshCw size={20} className="animate-spin" aria-hidden />} />
      ) : savedCount === 0 ? (
        <EmptyState
          title="ウォッチリストは空です"
          description="個別銘柄ページやスクリーナーの星ボタンから追加できます。"
          icon={<Star size={20} aria-hidden />}
        />
      ) : (
        <>
          {showJp && (
            <WatchSection
              market="JP"
              rows={allRows.filter((row) => row.market === 'JP')}
              selected={selected}
              onToggleSelection={toggleSelection}
              note={activeUniverseMeta
                ? `${activeUniverseMeta.shortLabel}表示中 · 保存済み ${tickers.length}銘柄`
                : 'J-Quants日次データ'}
              emptyDetail={activeUniverseMeta
                ? `${activeUniverseMeta.shortLabel}に該当する日本株はありません。`
                : '日本株の個別銘柄ページから追加できます。'}
            />
          )}
          {showUs && (
            <WatchSection
              market="US"
              rows={allRows.filter((row) => row.market === 'US')}
              selected={selected}
              onToggleSelection={toggleSelection}
              note="米国株日次データ"
              emptyDetail="米国株の個別銘柄ページから追加できます。"
            />
          )}
        </>
      )}
    </div>
  )
}

function WatchSection({
  market,
  rows,
  selected,
  onToggleSelection,
  note,
  emptyDetail,
}: {
  market: WorkspaceMarket
  rows: WatchRow[]
  selected: Set<string>
  onToggleSelection: (market: WorkspaceMarket, ticker: string) => void
  note: string
  emptyDetail: string
}) {
  const items = rows.map((row) => {
    const key = `${row.market}:${row.ticker}`
    const quote = row.quote
    const href = row.market === 'US'
      ? `/us/stock/${encodeURIComponent(row.ticker)}`
      : `/stock/${encodeURIComponent(row.ticker)}`
    const name = quote?.name ?? (row.market === 'JP' ? findTicker(row.ticker)?.name : null) ?? '取得待ち'
    return { row, key, quote, href, name, alertLabel: getAlertLabel(quote) }
  })
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <SectionHeader
        title={market === 'US' ? '米国株' : '日本株'}
        description={note}
        actions={<span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">{rows.length}銘柄</span>}
      />

      {rows.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">{emptyDetail}</p>
      ) : (
        <>
          <ul className="divide-y divide-[var(--color-border-soft)] rounded-[6px] border border-[var(--color-border-soft)] bg-white md:hidden">
            {items.map(({ row, key, quote, href, name, alertLabel }) => (
              <li key={key} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 px-3 py-2.5">
                <div className="flex flex-col items-center gap-1 pt-0.5">
                  <WatchlistButton ticker={row.ticker} market={row.market} size="sm" />
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    onChange={() => onToggleSelection(row.market, row.ticker)}
                    aria-label={`${row.ticker}を比較対象に選択`}
                    disabled={!selected.has(key) && selected.size >= 4}
                    className="h-4 w-4 accent-[var(--color-brand-700)]"
                  />
                </div>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Link href={href} prefetch={false} className="shrink-0 font-mono text-[13px] font-bold text-[var(--color-brand-800)] hover:underline">
                      {row.ticker}
                    </Link>
                    <span className="min-w-0 truncate text-[13px] text-[var(--color-text-primary)]">{name}</span>
                    <StockPreviewTrigger ticker={row.ticker} market={row.market} context="watchlist" />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                    <span>出来高 {formatNumber(quote?.volume)}</span>
                    <span>{quote?.priceDate ?? '-'}</span>
                    <AlertCell quote={quote} alertLabel={alertLabel} />
                  </div>
                </div>
                <div className="text-right font-mono tabular-nums">
                  <div className="text-[14px] font-bold text-[var(--color-text-primary)]">{formatPrice(quote?.price, row.market)}</div>
                  <div className="text-[11px] font-semibold" style={{ color: percentColor(quote?.changePercent) }}>
                    {formatPercent(quote?.changePercent)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div className="table-scroll hidden rounded-[6px] border border-[var(--color-border-soft)] bg-white md:block">
            <table className="w-full min-w-[840px] border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]">
                  <th scope="col" style={{ ...th, width: 38 }} aria-label="比較選択" />
                  <th scope="col" style={{ ...th, width: 38 }} aria-label="ウォッチ操作" />
                  <th scope="col" style={th}>コード</th>
                  <th scope="col" style={th}>銘柄名</th>
                  <th scope="col" style={thR}>価格</th>
                  <th scope="col" style={thR}>変化額</th>
                  <th scope="col" style={thR}>変化率</th>
                  <th scope="col" style={thR}>出来高</th>
                  <th scope="col" style={th}>価格日</th>
                  <th scope="col" style={th}>確認</th>
                </tr>
              </thead>
              <tbody>
                {items.map(({ row, key, quote, href, name, alertLabel }) => (
                  <tr key={key} className="border-b border-[var(--color-border-soft)] last:border-b-0 hover:bg-[#fff8e6]">
                    <td style={td}>
                      <input
                        type="checkbox"
                        checked={selected.has(key)}
                        onChange={() => onToggleSelection(row.market, row.ticker)}
                        aria-label={`${row.ticker}を比較対象に選択`}
                        disabled={!selected.has(key) && selected.size >= 4}
                        className="h-3.5 w-3.5 accent-[var(--color-brand-700)]"
                      />
                    </td>
                    <td style={td}>
                      <WatchlistButton ticker={row.ticker} market={row.market} size="sm" />
                    </td>
                    <td style={td}>
                      <span className="inline-flex items-center gap-1">
                        <Link
                          href={href}
                          prefetch={false}
                          className="font-mono font-bold text-[var(--color-brand-800)] no-underline hover:underline"
                        >
                          {row.ticker}
                        </Link>
                        <StockPreviewTrigger ticker={row.ticker} market={row.market} context="watchlist" />
                      </span>
                    </td>
                    <td style={td} className="max-w-[240px] truncate">{name}</td>
                    <td style={tdR}>{formatPrice(quote?.price, row.market)}</td>
                    <td style={{ ...tdR, color: percentColor(quote?.change) }}>
                      {formatChange(quote?.change, row.market)}
                    </td>
                    <td style={{ ...tdR, color: percentColor(quote?.changePercent) }}>
                      {formatPercent(quote?.changePercent)}
                    </td>
                    <td style={tdR}>{formatNumber(quote?.volume)}</td>
                    <td style={td}>{quote?.priceDate ?? '-'}</td>
                    <td style={td}><AlertCell quote={quote} alertLabel={alertLabel} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function AlertCell({ quote, alertLabel }: { quote: StockQuote | null | undefined; alertLabel: string | null }) {
  if (quote === undefined) {
    return <span className="text-[11px] text-[var(--color-text-tertiary)]">更新中</span>
  }
  if (alertLabel) {
    return (
      <span className="inline-flex items-center gap-1 rounded-[3px] bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800">
        <AlertTriangle size={12} aria-hidden />
        {alertLabel}
      </span>
    )
  }
  return <span className="text-[11px] text-[var(--color-text-tertiary)]">平常</span>
}

function getAlertLabel(quote: StockQuote | null | undefined): string | null {
  if (quote === undefined) return null
  if (!quote) return '取得失敗'
  if (quote.priceQualityWarning) return '品質注意'
  if (quote.changePercent >= 5) return '上昇急変'
  if (quote.changePercent <= -5) return '下落急変'
  return null
}

function formatPrice(value: number | undefined, market: WorkspaceMarket): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return new Intl.NumberFormat(market === 'US' ? 'en-US' : 'ja-JP', {
    style: 'currency',
    currency: market === 'US' ? 'USD' : 'JPY',
    maximumFractionDigits: market === 'US' ? 2 : 0,
  }).format(value)
}

function formatChange(value: number | undefined, market: WorkspaceMarket): string {
  if (value == null || !Number.isFinite(value)) return '-'
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  const symbol = market === 'US' ? '$' : '¥'
  return `${sign}${symbol}${Math.abs(value).toLocaleString(market === 'US' ? 'en-US' : 'ja-JP', {
    maximumFractionDigits: market === 'US' ? 2 : 0,
  })}`
}

function formatPercent(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatNumber(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toLocaleString('ja-JP')
}

function percentColor(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'var(--color-text-tertiary)'
  if (value > 0) return 'var(--color-price-up)'
  if (value < 0) return 'var(--color-price-down)'
  return 'var(--color-text-secondary)'
}

const th: CSSProperties = {
  padding: '8px 10px',
  textAlign: 'left',
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  fontSize: '11px',
  whiteSpace: 'nowrap',
}
const thR: CSSProperties = { ...th, textAlign: 'right' }
const td: CSSProperties = {
  padding: '8px 10px',
  color: 'var(--color-text-primary)',
  whiteSpace: 'nowrap',
}
const tdR: CSSProperties = {
  ...td,
  textAlign: 'right',
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums',
}
