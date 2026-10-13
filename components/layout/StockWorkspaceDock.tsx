'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, GitCompareArrows, Trash2 } from 'lucide-react'
import {
  clearComparedSymbols,
  getCompareSymbols,
  symbolHref,
  WORKSPACE_EVENT,
  type WorkspaceSymbol,
} from '@/lib/client/stock-workspace'

export function StockWorkspaceDock() {
  const [symbols, setSymbols] = useState<WorkspaceSymbol[]>([])
  const [minimized, setMinimized] = useState(false)

  useEffect(() => {
    const sync = () => setSymbols(getCompareSymbols())
    sync()
    window.addEventListener(WORKSPACE_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(WORKSPACE_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const formulaHref = useMemo(() => {
    if (symbols.length === 0) return '/custom-charts'
    const tokens = symbols.map((item) => (
      item.market === 'US' ? `US:${item.ticker}` : item.ticker
    ))
    const formula = tokens.length === 1 ? tokens[0] : `(${tokens.join(' + ')}) / ${tokens.length}`
    const params = new URLSearchParams({
      formula,
      mode: 'normalized',
      name: `比較 ${symbols.map((item) => item.ticker).join(' / ')}`,
    })
    if (new Set(symbols.map((item) => item.market)).size > 1) params.set('currency', 'JPY')
    return `/custom-charts?${params.toString()}`
  }, [symbols])

  if (symbols.length === 0) return null

  return (
    <>
      {/* Normal-flow spacer so the fixed dock never covers the final page content. */}
      <div aria-hidden className="h-[100px] lg:h-14" />
      <aside
        className="fixed left-3 z-40 w-[min(720px,calc(100vw-80px))] border border-[var(--color-border-strong)] bg-white shadow-[0_16px_36px_rgba(16,32,52,0.24)] xl:left-1/2 xl:-translate-x-1/2"
        style={{ bottom: 'max(12px, env(safe-area-inset-bottom))' }}
      >
        <div className="flex min-h-10 flex-wrap items-center gap-x-2 px-3 lg:flex-nowrap">
          <GitCompareArrows size={15} className="shrink-0 text-[var(--color-brand-700)]" />
          <strong className="shrink-0 text-[11px] text-[var(--color-brand-900)]">
            比較 {symbols.length}/4
          </strong>
          {!minimized && (
            <div className="order-last flex min-w-0 basis-full items-center gap-1 overflow-x-auto border-t border-[var(--color-border-soft)] py-1.5 lg:order-none lg:flex-1 lg:basis-auto lg:border-t-0 lg:py-1">
              {symbols.map((symbol) => (
                <Link
                  key={`${symbol.market}:${symbol.ticker}`}
                  href={symbolHref(symbol)}
                  className="shrink-0 border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2 py-1 font-mono text-[10px] font-bold text-[var(--color-brand-900)]"
                >
                  {symbol.market}:{symbol.ticker}
                </Link>
              ))}
            </div>
          )}
          <Link
            href={formulaHref}
            className="ml-auto shrink-0 bg-[var(--color-brand-700)] px-2.5 py-2 text-[10px] font-black text-white hover:bg-[var(--color-brand-800)] lg:py-1.5"
          >
            合成チャート
          </Link>
          <button
            type="button"
            onClick={() => {
              clearComparedSymbols()
              setSymbols([])
            }}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-subtle)] lg:h-7 lg:w-7"
            title="比較をすべて解除"
            aria-label="比較をすべて解除"
          >
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            onClick={() => setMinimized((current) => !current)}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-subtle)] lg:h-7 lg:w-7"
            title={minimized ? '比較銘柄を表示' : '比較銘柄を隠す'}
            aria-label={minimized ? '比較銘柄を表示' : '比較銘柄を隠す'}
            aria-expanded={!minimized}
          >
            {minimized ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </aside>
    </>
  )
}
