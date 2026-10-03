// lib/watchlist-store.ts
// ウォッチリスト（お気に入り銘柄）の永続ストア。localStorage で保存。

'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface WatchlistStore {
  tickers: string[]
  usTickers: string[]
  add: (ticker: string) => void
  remove: (ticker: string) => void
  toggle: (ticker: string) => void
  has: (ticker: string) => boolean
  clear: () => void
  addUs: (ticker: string) => void
  removeUs: (ticker: string) => void
  toggleUs: (ticker: string) => void
  hasUs: (ticker: string) => boolean
  clearUs: () => void
  clearAll: () => void
}

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/\.T$/i, '')
}

export const useWatchlistStore = create<WatchlistStore>()(
  persist(
    (set, get) => ({
      tickers: [],
      usTickers: [],
      add: (ticker) =>
        set((s) => {
          const normalized = normalizeTicker(ticker)
          return s.tickers.includes(normalized)
            ? s
            : { tickers: [...s.tickers, normalized] }
        }),
      remove: (ticker) =>
        set((s) => {
          const normalized = normalizeTicker(ticker)
          return { tickers: s.tickers.filter((t) => t !== normalized) }
        }),
      toggle: (ticker) =>
        set((s) => {
          const normalized = normalizeTicker(ticker)
          return s.tickers.includes(normalized)
            ? { tickers: s.tickers.filter((t) => t !== normalized) }
            : { tickers: [...s.tickers, normalized] }
        }),
      has: (ticker) => get().tickers.includes(normalizeTicker(ticker)),
      clear: () => set({ tickers: [] }),
      addUs: (ticker) =>
        set((s) => {
          const normalized = normalizeTicker(ticker)
          return s.usTickers.includes(normalized)
            ? s
            : { usTickers: [...s.usTickers, normalized] }
        }),
      removeUs: (ticker) =>
        set((s) => {
          const normalized = normalizeTicker(ticker)
          return { usTickers: s.usTickers.filter((t) => t !== normalized) }
        }),
      toggleUs: (ticker) =>
        set((s) => {
          const normalized = normalizeTicker(ticker)
          return s.usTickers.includes(normalized)
            ? { usTickers: s.usTickers.filter((t) => t !== normalized) }
            : { usTickers: [...s.usTickers, normalized] }
        }),
      hasUs: (ticker) => get().usTickers.includes(normalizeTicker(ticker)),
      clearUs: () => set({ usTickers: [] }),
      clearAll: () => set({ tickers: [], usTickers: [] }),
    }),
    { name: 'stockboard-watchlist' },
  ),
)
