import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '業種マスター管理 — StockBoard',
  description: 'J-Quants銘柄マスターの市場区分と業種分類を診断します。',
}

export default function SectorMasterAdminLayout({ children }: { children: React.ReactNode }) {
  return children
}
