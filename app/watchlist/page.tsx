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
import { WatchlistButton } from '@/components/ui/WatchlistButton'
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
    <main className="mx-auto flex w-full max-w-[1480px] flex-col gap-4 px-3 py-4 sm:px-4">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
        <div>
          <h1 className="flex items-center gap-2 font-[var(--font-display)] text-[18px] font-bold text-[var(--text-primary)]">
            <Star size={18} fill="currentColor" className="text-[var(--color-brand-600)]" />
            ウォッチワークスペース
          </h1>
          <p className="mt-1 text-[11px] font-semibold text-[var(--text-muted)]">
            JP・USの監視、急変確認、銘柄比較を一か所で管理します。価格は60秒ごとに自動更新されます。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchQuotes()}
          disabled={loading}
          className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[var(--border-base)] bg-white px-3 text-[11px] font-bold text-[var(--text-secondary)] disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {loading ? '更新中' : '今すぐ更新'}
        </button>
      </header>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="ウォッチリスト集計">
        <SummaryMetric label="登録銘柄" value={`${savedCount}`} unit="銘柄" />
        <SummaryMetric label="日本株" value={`${tickers.length}`} unit="銘柄" />
        <SummaryMetric label="米国株" value={`${usTickers.length}`} unit="銘柄" />
        <SummaryMetric label="要確認" value={`${alertCount}`} unit="件" warning={alertCount > 0} />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2 border-y border-[var(--border-subtle)] py-2">
        <div className="inline-flex rounded-[4px] border border-[var(--border-base)] bg-[var(--bg-elevated)] p-0.5">
          {([
            ['ALL', `すべて ${savedCount}`],
            ['JP', `JP ${tickers.length}`],
            ['US', `US ${usTickers.length}`],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMarketView(value)}
              className={`h-7 rounded-[3px] px-3 text-[11px] font-bold ${
                marketView === value
                  ? 'bg-white text-[var(--color-brand-700)] shadow-sm'
                  : 'text-[var(--text-muted)]'
              }`}
              aria-pressed={marketView === value}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {selected.size > 0 && (
            <button
              type="button"
              onClick={addSelectedToComparison}
              className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[var(--color-brand-600)] bg-[var(--color-brand-600)] px-3 text-[11px] font-bold text-white"
            >
              <GitCompareArrows size={14} />
              {selected.size}銘柄を比較
            </button>
          )}
          {visibleJpTickers.length > 0 && (
            <button
              type="button"
              onClick={downloadTvWatchlist}
              className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[var(--border-base)] bg-white px-3 text-[11px] font-bold text-[var(--text-secondary)]"
              title="JP銘柄をTradingView形式でダウンロード"
            >
              <Download size={14} />
              JP TVリスト
            </button>
          )}
          {savedCount > 0 && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm('JP・USのウォッチリストを全て削除しますか？')) clearAll()
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[var(--border-base)] bg-white px-3 text-[11px] font-bold text-[var(--text-secondary)]"
            >
              <Trash2 size={14} />
              全クリア
            </button>
          )}
        </div>
      </div>

      {!mounted ? (
        <EmptyState title="ウォッチリストを読み込んでいます" detail="保存済み銘柄を確認中です。" />
      ) : savedCount === 0 ? (
        <EmptyState
          title="ウォッチリストは空です"
          detail="JP・USの個別銘柄ページやスクリーナーにある星ボタンから追加できます。"
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
                ? `${activeUniverseMeta.shortLabel}表示中 / 保存済みJP ${tickers.length}銘柄`
                : 'J-Quants日次データ'}
              emptyDetail={activeUniverseMeta
                ? `${activeUniverseMeta.shortLabel}に該当するJPウォッチ銘柄はありません。`
                : 'JP個別銘柄ページから追加できます。'}
            />
          )}
          {showUs && (
            <WatchSection
              market="US"
              rows={allRows.filter((row) => row.market === 'US')}
              selected={selected}
              onToggleSelection={toggleSelection}
              note="US日次データ"
              emptyDetail="US個別銘柄ページから追加できます。"
            />
          )}
        </>
      )}
    </main>
  )
}

function SummaryMetric({
  label,
  value,
  unit,
  warning = false,
}: {
  label: string
  value: string
  unit: string
  warning?: boolean
}) {
  return (
    <div className="border border-[var(--border-subtle)] bg-white px-3 py-2.5">
      <div className="text-[10px] font-bold text-[var(--text-muted)]">{label}</div>
      <div className={`mt-1 font-[var(--font-mono)] text-[18px] font-bold ${warning ? 'text-amber-700' : 'text-[var(--text-primary)]'}`}>
        {value}
        <span className="ml-1 text-[10px] font-semibold text-[var(--text-muted)]">{unit}</span>
      </div>
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
  return (
    <section className="overflow-hidden border border-[var(--border-subtle)] bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className={`rounded-[3px] px-2 py-1 text-[10px] font-black ${
            market === 'US'
              ? 'bg-sky-50 text-sky-700'
              : 'bg-rose-50 text-rose-700'
          }`}>
            {market}
          </span>
          <h2 className="text-[13px] font-bold text-[var(--text-primary)]">
            {market === 'US' ? '米国株' : '日本株'}
          </h2>
          <span className="font-[var(--font-mono)] text-[11px] text-[var(--text-muted)]">{rows.length}銘柄</span>
        </div>
        <span className="text-[10px] font-semibold text-[var(--text-muted)]">{note}</span>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-[11px] font-semibold text-[var(--text-muted)]">
          {emptyDetail}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[840px] border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
                <th scope="col" style={{ ...th, width: 38 }} aria-label="比較選択" />
                <th scope="col" style={{ ...th, width: 38 }} aria-label="ウォッチ操作" />
                <th scope="col" style={th}>銘柄</th>
                <th scope="col" style={th}>名称</th>
                <th scope="col" style={thR}>価格</th>
                <th scope="col" style={thR}>変化額</th>
                <th scope="col" style={thR}>変化率</th>
                <th scope="col" style={thR}>出来高</th>
                <th scope="col" style={th}>価格日</th>
                <th scope="col" style={th}>確認</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const key = `${row.market}:${row.ticker}`
                const quote = row.quote
                const href = row.market === 'US'
                  ? `/us/stock/${encodeURIComponent(row.ticker)}`
                  : `/stock/${encodeURIComponent(row.ticker)}`
                const name = quote?.name ?? (row.market === 'JP' ? findTicker(row.ticker)?.name : null) ?? '取得待ち'
                const alertLabel = getAlertLabel(quote)
                return (
                  <tr key={key} className="border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-elevated)]">
                    <td style={td}>
                      <input
                        type="checkbox"
                        checked={selected.has(key)}
                        onChange={() => onToggleSelection(row.market, row.ticker)}
                        aria-label={`${row.ticker}を比較対象に選択`}
                        disabled={!selected.has(key) && selected.size >= 4}
                        className="h-3.5 w-3.5 accent-[var(--color-brand-600)]"
                      />
                    </td>
                    <td style={td}>
                      <WatchlistButton ticker={row.ticker} market={row.market} size="sm" />
                    </td>
                    <td style={td}>
                      <Link
                        href={href}
                        prefetch={false}
                        className="font-[var(--font-mono)] font-bold text-[var(--color-brand-700)] no-underline hover:text-[var(--color-market-red)]"
                      >
                        {row.ticker}
                      </Link>
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
                    <td style={td}>
                      {quote === undefined ? (
                        <span className="text-[10px] font-semibold text-[var(--text-muted)]">更新中</span>
                      ) : alertLabel ? (
                        <span className="inline-flex items-center gap-1 rounded-[3px] bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-800">
                          <AlertTriangle size={12} />
                          {alertLabel}
                        </span>
                      ) : (
                        <span className="text-[10px] font-semibold text-emerald-700">平常</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="border border-[var(--border-subtle)] bg-white px-4 py-10 text-center">
      <div className="text-[13px] font-bold text-[var(--text-secondary)]">{title}</div>
      <div className="mt-2 text-[11px] font-semibold text-[var(--text-muted)]">{detail}</div>
    </div>
  )
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
  if (value == null || !Number.isFinite(value)) return 'var(--text-muted)'
  if (value > 0) return 'var(--price-up, #16a34a)'
  if (value < 0) return 'var(--price-down, #dc2626)'
  return 'var(--text-secondary)'
}

const th: CSSProperties = {
  padding: '8px 10px',
  textAlign: 'left',
  fontFamily: 'var(--font-mono)',
  fontWeight: 600,
  color: 'var(--text-muted)',
  fontSize: '10px',
  whiteSpace: 'nowrap',
}
const thR: CSSProperties = { ...th, textAlign: 'right' }
const td: CSSProperties = {
  padding: '8px 10px',
  color: 'var(--text-primary)',
  whiteSpace: 'nowrap',
}
const tdR: CSSProperties = {
  ...td,
  textAlign: 'right',
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums',
}
