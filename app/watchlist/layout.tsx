import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'ウォッチリスト — StockBoard',
  description: '保存した監視銘柄の価格と変化を一覧表示します。',
}

export default function WatchlistLayout({ children }: { children: React.ReactNode }) {
  return children
}
