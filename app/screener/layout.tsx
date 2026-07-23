import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'スクリーナー — StockBoard',
  description: '日本株を市場、業種、出来高、ステージ、物理特徴量で絞り込みます。',
}

export default function ScreenerLayout({ children }: { children: React.ReactNode }) {
  return children
}
