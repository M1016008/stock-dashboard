// app/ai/transitions/page.tsx
// Phase 4 D: パターン遷移分析 (Server Component)

import type { Metadata } from 'next'
import { PageTitle } from '@/components/layout/PageTitle'
import { PatternSearch } from '@/components/ai/PatternSearch'
import { PatternHero } from '@/components/ai/PatternHero'
import { HorizonStats } from '@/components/ai/HorizonStats'
import { ReturnDistributionChart } from '@/components/ai/ReturnDistributionChart'
import { SectorBreakdown } from '@/components/ai/SectorBreakdown'
import { SampleCases } from '@/components/ai/SampleCases'
import {
  getDefaultPatternCode,
  getPatternMeta,
  getHorizonStats,
  getTopPatterns,
  getReturnDistribution,
  getSectorBreakdown,
  getSampleCases,
} from '@/lib/queries/transitions'

export const metadata: Metadata = {
  title: 'パターン遷移分析 — StockBoard',
  description: '6 タイムスケールの組み合わせから過去の類似ケースを統計的に観察',
}

export const revalidate = 300

export default async function TransitionsPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; horizon?: string }>
}) {
  const sp = await searchParams
  const fallback = await getDefaultPatternCode()
  const code = /^\d{6}$/.test(sp.code ?? '') ? sp.code! : (fallback ?? '111111')
  const horizonDays = sp.horizon && /^\d+$/.test(sp.horizon) ? parseInt(sp.horizon, 10) : 60

  const [meta, horizonRows, top, dist, sectors, samples] = await Promise.all([
    getPatternMeta(code),
    getHorizonStats(code),
    getTopPatterns(12),
    getReturnDistribution(code, horizonDays),
    getSectorBreakdown(code, 7),
    getSampleCases(code, 10),
  ])

  return (
    <div className="flex flex-col gap-3.5">
      <PageTitle
        title="パターン遷移分析"
        subtitle="6 タイムスケールの組み合わせから過去の類似ケースを統計的に観察します"
      />
      <PatternSearch currentCode={code} topPatterns={top} />
      <PatternHero meta={meta} />
      <HorizonStats rows={horizonRows} />
      <div className="grid grid-cols-2 gap-3.5">
        <ReturnDistributionChart dist={dist} horizonDays={horizonDays} />
        <SectorBreakdown rows={sectors} />
      </div>
      <SampleCases rows={samples} total={meta?.count_60d ?? 0} />
    </div>
  )
}
