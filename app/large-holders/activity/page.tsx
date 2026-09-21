import { Suspense } from 'react'
import type { Metadata } from 'next'
import { LargeHoldersClient } from '@/components/large-holders/LargeHoldersClient'
import { HolderSkeleton } from '@/components/large-holders/LargeHoldersShared'

export const metadata: Metadata = { title: '大口投資家の保有変化 | StockBoard' }

export default function LargeHolderActivityPage() {
  return <Suspense fallback={<HolderSkeleton />}><LargeHoldersClient mode="activity" /></Suspense>
}
