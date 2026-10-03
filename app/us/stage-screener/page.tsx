import type { Metadata } from 'next'
import { Suspense } from 'react'
import HexStageMapView from '@/components/hex/HexStageMapView'
import { PageTitle } from '@/components/layout/PageTitle'

export const metadata: Metadata = {
  title: 'USステージスクリーナー — StockBoard',
  description: '米国株を日足・週足・月足のHEXステージ行列から絞り込みます。',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function LoadingStageMap() {
  return (
    <div className="flex min-h-[360px] items-center justify-center rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[12px] font-semibold text-[var(--color-text-tertiary)]">
      読込中...
    </div>
  )
}

export default function UsStageScreenerPage() {
  return (
    <div className="sb-page">
      <PageTitle
        title="USステージスクリーナー"
        subtitle="米国株の日足・週足・月足のB×Aステージ行列から、銘柄をクリックで絞り込みます。"
        badge="US HEX"
      />

      <div className="sb-section">
        <Suspense fallback={<LoadingStageMap />}>
          <HexStageMapView market="US" />
        </Suspense>
      </div>
    </div>
  )
}
