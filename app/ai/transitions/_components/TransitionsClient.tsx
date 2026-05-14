'use client'

import { use, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  getPatternList,
  type PatternListRow,
  type Horizon,
} from '@/lib/server/transitions'
import { PatternTable } from './PatternTable'
import { PatternDetailPanel } from './PatternDetailPanel'
import { StageTransitionsSection } from './StageTransitionMatrix'

interface Props {
  searchParams: Promise<{ code?: string; horizon?: string }>
}

const HORIZONS: Horizon[] = [30, 60, 90, 180]

function parseHorizon(value: string | undefined): Horizon {
  const n = value ? parseInt(value) : 60
  return HORIZONS.includes(n as Horizon) ? (n as Horizon) : 60
}

export function TransitionsClient({ searchParams }: Props) {
  const sp = use(searchParams)
  const router = useRouter()
  const urlParams = useSearchParams()

  const [horizon, setHorizon] = useState<Horizon>(parseHorizon(sp.horizon))
  const [patterns, setPatterns] = useState<PatternListRow[] | null>(null)
  const [selectedCode, setSelectedCode] = useState<string | null>(sp.code ?? null)

  useEffect(() => {
    setPatterns(null)
    getPatternList({ horizon, minCount: 1 }).then(setPatterns)
  }, [horizon])

  const handleSelect = (code: string) => {
    setSelectedCode(code)
    const newParams = new URLSearchParams(urlParams.toString())
    newParams.set('code', code)
    newParams.set('horizon', String(horizon))
    router.replace(`/ai/transitions?${newParams.toString()}`, { scroll: false })
  }

  const handleHorizonChange = (h: Horizon) => {
    setHorizon(h)
    const newParams = new URLSearchParams(urlParams.toString())
    newParams.set('horizon', String(h))
    if (selectedCode) newParams.set('code', selectedCode)
    router.replace(`/ai/transitions?${newParams.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-8">
      {/* horizon 切替 */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-[var(--color-text-secondary)]">
          中央値の Horizon:
        </span>
        {HORIZONS.map(h => (
          <button
            key={h}
            onClick={() => handleHorizonChange(h)}
            className={`rounded-md px-3 py-1 text-xs transition-colors ${
              horizon === h
                ? 'bg-[var(--color-brand-600)] text-white'
                : 'bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border-soft)]'
            }`}
          >
            {h}日
          </button>
        ))}
      </div>

      {/* パターン → 結果 (2 ペイン) */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          {patterns ? (
            <PatternTable
              patterns={patterns}
              selectedCode={selectedCode}
              onSelect={handleSelect}
              horizon={horizon}
            />
          ) : (
            <p className="text-xs text-[var(--color-text-tertiary)]">読み込み中...</p>
          )}
        </div>
        <div>
          {selectedCode ? (
            <PatternDetailPanel code={selectedCode} />
          ) : (
            <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-default)] p-8 text-center text-sm text-[var(--color-text-tertiary)]">
              左のテーブルからパターンを選択してください
            </div>
          )}
        </div>
      </section>

      {/* ステージ遷移セクション */}
      <StageTransitionsSection />
    </div>
  )
}
