import type { Metadata } from 'next'
import { InvestorDetailClient } from '@/components/large-holders/InvestorDetailClient'

export const metadata: Metadata = { title: '大口投資家の保有明細 | StockBoard' }

export default async function LargeHolderInvestorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <InvestorDetailClient id={id} />
}
