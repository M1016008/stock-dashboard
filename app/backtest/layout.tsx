import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '過去検証・シグナル分析 — StockBoard',
  description: '過去シグナル、類似局面、ML候補の期待値を検証します。',
}

export default function BacktestLayout({ children }: { children: React.ReactNode }) {
  return children
}
