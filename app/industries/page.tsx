// app/industries/page.tsx
// Phase 4 F: 業界別 (業種細分類) — 476 業界の検索/絞り込みと銘柄一覧

import type { Metadata } from 'next'
import { PageTitle } from '@/components/layout/PageTitle'
import { IndustriesFilter } from '@/components/industries/IndustriesFilter'
import { IndustriesList } from '@/components/industries/IndustriesList'
import { IndustryStocksPanel } from '@/components/industries/IndustryStocksPanel'
import { getIndustryList, getMajorList, getIndustryStocks } from '@/lib/queries/industries'

export const metadata: Metadata = {
  title: '業界別 — StockBoard',
  description: '業種細分類 (AI / クラウド / バイオ / 半導体 等) で深掘り',
}

export const revalidate = 300

export default async function IndustriesPage({
  searchParams,
}: {
  searchParams: Promise<{ selected?: string; major?: string; q?: string; sort?: string }>
}) {
  const sp = await searchParams
  const selected = sp.selected ?? null
  const major = sp.major ?? null
  const q = sp.q ?? ''
  const sort = sp.sort ?? 'change_desc'

  const [{ rows, classificationCount }, majorList, stocks] = await Promise.all([
    getIndustryList({ q, major: major ?? undefined, sort }),
    getMajorList(),
    selected ? getIndustryStocks(selected, 80) : Promise.resolve([]),
  ])

  const sourceLabel = classificationCount > 0
    ? `${rows.length} 業界 · Yoshio 独自 ${classificationCount} 銘柄 + JPX フォールバック`
    : `${rows.length} 業界 (JPX Sector33 のみ)`

  return (
    <div className="flex flex-col gap-3.5">
      <PageTitle
        title="業界別 (業種細分類)"
        subtitle="独自分類 (Excel) を優先し、未掲載銘柄は JPX Sector33 → その他 でフォールバック"
        badge={sourceLabel}
      />
      <IndustriesFilter q={q} majorFilter={major} sort={sort} majorList={majorList} />
      <IndustriesList rows={rows} source={classificationCount > 0 ? 'classification + JPX' : 'JPX'} />
      {selected && <IndustryStocksPanel industry={selected} rows={stocks} />}
    </div>
  )
}
