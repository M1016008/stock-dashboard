import type { Metadata } from 'next'
import { Suspense } from 'react'
import HexStageMapView from '@/components/hex/HexStageMapView'
import { PageTitle } from '@/components/layout/PageTitle'
import { UsAnalysisNav } from '@/components/us/UsAnalysisNav'

export const metadata: Metadata = {
  title: 'USステージスクリーナー — StockBoard',
  description: '米国株を日足・週足・月足のHEXステージ行列から絞り込みます。',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function LoadingStageMap() {
  return (
    <div
      className="flex min-h-[360px] items-center justify-center rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[13px] text-[var(--color-text-tertiary)]"
      role="status"
      aria-live="polite"
    >
      ステージ行列を読み込んでいます…
    </div>
  )
}

export default function UsStageScreenerPage() {
  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageTitle
        eyebrow="米国株"
        title="USステージスクリーナー"
        subtitle="米国株の日足・週足・月足のB×Aステージ行列から、セルをクリックして銘柄を絞り込みます。"
      >
        <UsAnalysisNav current="/us/stage-screener" />
      </PageTitle>

      <Suspense fallback={<LoadingStageMap />}>
        <HexStageMapView market="US" />
      </Suspense>
    </div>
  )
}
