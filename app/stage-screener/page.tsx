import type { Metadata } from 'next'
import { Suspense } from 'react'
import HexStageMapView from '@/components/hex/HexStageMapView'
import { PageTitle } from '@/components/layout/PageTitle'
import { getUniverseFilterMeta, parseUniverseFilter } from '@/lib/market-universe'

export const metadata: Metadata = {
  title: 'ステージスクリーナー — StockBoard',
  description: '日足・週足・月足のHEXステージ行列から銘柄を絞り込む',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function LoadingStageMap() {
  return (
    <div role="status" aria-busy="true" className="flex min-h-[360px] animate-pulse items-center justify-center rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[12px] text-[var(--color-text-tertiary)]">
      ステージ行列を読み込み中…
    </div>
  )
}

export default async function StageScreenerPage({
  searchParams,
}: {
  searchParams?: Promise<{ universe?: string | string[] }>
}) {
  const sp = searchParams ? await searchParams : {}
  const activeUniverse = parseUniverseFilter(sp.universe)
  const activeUniverseMeta = getUniverseFilterMeta(activeUniverse)

  return (
    <div className="sb-page">
      <PageTitle
        eyebrow="銘柄探索"
        title="ステージスクリーナー"
        subtitle="日足・週足・月足のB×Aステージ行列から、市場全体の銘柄をクリックで絞り込みます。"
        badge={activeUniverseMeta ? `${activeUniverseMeta.shortLabel}に絞り込み中` : undefined}
      />

      <div className="sb-section">
        <Suspense fallback={<LoadingStageMap />}>
          <HexStageMapView />
        </Suspense>
      </div>
    </div>
  )
}
