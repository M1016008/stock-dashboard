'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { GitCompareArrows, Trash2, X } from 'lucide-react'
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
    if (symbols.length < 2) return '/custom-charts'
    const formula = symbols.map((item) => (
      item.market === 'US' ? `US:${item.ticker}` : item.ticker
    )).join(' + ')
    return `/custom-charts?formula=${encodeURIComponent(`(${formula}) / ${symbols.length}`)}`
  }, [symbols])

  if (symbols.length === 0) return null

  return (
    <aside
      className="fixed left-1/2 z-40 w-[min(720px,calc(100vw-80px))] -translate-x-1/2 border border-[var(--color-border-strong)] bg-white shadow-[0_16px_36px_rgba(16,32,52,0.24)]"
      style={{ bottom: 'max(12px, env(safe-area-inset-bottom))' }}
    >
      <div className="flex min-h-10 items-center gap-2 px-3">
        <GitCompareArrows size={15} className="shrink-0 text-[var(--color-brand-700)]" />
        <strong className="shrink-0 text-[11px] text-[var(--color-brand-900)]">
          比較 {symbols.length}/4
        </strong>
        {!minimized && (
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
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
          className="ml-auto shrink-0 bg-[var(--color-brand-700)] px-2.5 py-1.5 text-[10px] font-black text-white hover:bg-[var(--color-brand-800)]"
        >
          合成チャート
        </Link>
        <button
          type="button"
          onClick={() => {
            clearComparedSymbols()
            setSymbols([])
          }}
          className="inline-flex h-7 w-7 items-center justify-center text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-subtle)]"
          title="比較をすべて解除"
          aria-label="比較をすべて解除"
        >
          <Trash2 size={14} />
        </button>
        <button
          type="button"
          onClick={() => setMinimized((current) => !current)}
          className="inline-flex h-7 w-7 items-center justify-center text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-subtle)]"
          title={minimized ? '比較銘柄を表示' : '比較銘柄を隠す'}
          aria-label={minimized ? '比較銘柄を表示' : '比較銘柄を隠す'}
        >
          <X size={14} className={minimized ? 'rotate-45' : ''} />
        </button>
      </div>
    </aside>
  )
}
