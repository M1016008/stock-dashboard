'use client'

import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import HexMap, { type HexMapStock } from '@/components/hex/HexMap'
import type { SectorStructureTaxonomy } from '@/lib/sector-structure'

type HexPayload = {
  data?: HexMapStock[]
  count?: number
  date?: string | null
  error?: string
  message?: string
}

export function SelectorAdvancedHexMap({
  taxonomy,
  groupKey,
  groupName,
  date,
  universe,
}: {
  taxonomy: SectorStructureTaxonomy
  groupKey: string
  groupName: string
  date: string
  universe: string | null
}) {
  const [data, setData] = useState<HexMapStock[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({
      timeframe: 'daily',
      taxonomy,
      group: groupKey,
      date,
    })
    if (universe) params.set('universe', universe)
    setLoading(true)
    setError(null)
    fetch(`/api/hex?${params.toString()}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as HexPayload
        if (!response.ok) throw new Error(payload.error ?? payload.message ?? 'HEX条件を取得できませんでした。')
        setData(payload.data ?? [])
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setError(cause instanceof Error ? cause.message : 'HEX条件を取得できませんでした。')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [date, groupKey, taxonomy, universe])

  if (loading) {
    return (
      <div className="flex min-h-[180px] items-center justify-center gap-2 text-[12px] font-bold text-[var(--color-text-secondary)]">
        <LoaderCircle size={16} className="animate-spin" />{groupName}のHEX条件を読み込み中
      </div>
    )
  }
  if (error) {
    return <div className="px-4 py-8 text-center text-[12px] font-bold text-[var(--color-price-down)]">{error}</div>
  }
  if (data.length === 0) {
    return <div className="px-4 py-8 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">対象銘柄がありません。</div>
  }
  return <HexMap data={data} market="JP" />
}
