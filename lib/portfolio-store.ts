// lib/portfolio-store.ts
'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PortfolioHolding } from '@/types/stock'

interface PortfolioStore {
  holdings: PortfolioHolding[]
  watchlist: string[]
  addHolding: (holding: Omit<PortfolioHolding, 'id'>) => void
  removeHolding: (id: string) => void
  updateHolding: (id: string, shares: number, avgCost: number) => void
  addToWatchlist: (ticker: string) => void
  removeFromWatchlist: (ticker: string) => void
}

export const usePortfolioStore = create<PortfolioStore>()(
  persist(
    (set) => ({
      holdings: [],
      watchlist: ['7203.T', '6758.T', '9984.T', 'AAPL', 'TSLA', 'NVDA'],

      addHolding: (holding) =>
        set((state) => ({
          holdings: [
            ...state.holdings,
            { ...holding, id: crypto.randomUUID() },
          ],
        })),

      removeHolding: (id) =>
        set((state) => ({
          holdings: state.holdings.filter((h) => h.id !== id),
        })),

      updateHolding: (id, shares, avgCost) =>
        set((state) => ({
          holdings: state.holdings.map((h) =>
            h.id === id ? { ...h, shares, avgCost } : h
          ),
        })),

      addToWatchlist: (ticker) =>
        set((state) => ({
          watchlist: state.watchlist.includes(ticker)
            ? state.watchlist
            : [...state.watchlist, ticker].slice(0, 10),
        })),

      removeFromWatchlist: (ticker) =>
        set((state) => ({
          watchlist: state.watchlist.filter((t) => t !== ticker),
        })),
    }),
    {
      name: 'stockboard-portfolio',
    }
  )
)
