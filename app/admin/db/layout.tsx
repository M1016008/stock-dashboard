import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '運用ステータス — StockBoard',
  description: 'StockBoardのデータベースと定期バッチの運用状態を確認します。',
}

export default function DbAdminLayout({ children }: { children: React.ReactNode }) {
  return children
}
