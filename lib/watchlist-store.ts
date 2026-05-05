// lib/watchlist-store.ts
// ウォッチリスト（お気に入り銘柄）の永続ストア。localStorage で保存。

'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface WatchlistStore {
  tickers: string[]
  add: (ticker: string) => void
  remove: (ticker: string) => void
  toggle: (ticker: string) => void
  has: (ticker: string) => boolean
  clear: () => void
}

export const useWatchlistStore = create<WatchlistStore>()(
  persist(
    (set, get) => ({
      tickers: [],
      add: (ticker) =>
        set((s) =>
          s.tickers.includes(ticker)
            ? s
            : { tickers: [...s.tickers, ticker] },
        ),
      remove: (ticker) =>
        set((s) => ({ tickers: s.tickers.filter((t) => t !== ticker) })),
      toggle: (ticker) =>
        set((s) =>
          s.tickers.includes(ticker)
            ? { tickers: s.tickers.filter((t) => t !== ticker) }
            : { tickers: [...s.tickers, ticker] },
        ),
      has: (ticker) => get().tickers.includes(ticker),
      clear: () => set({ tickers: [] }),
    }),
    { name: 'stockboard-watchlist' },
  ),
)
