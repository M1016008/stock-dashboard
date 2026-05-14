'use client'

import { useEffect, useState } from 'react'
import { getStageTransitionMatrices } from '@/lib/server/transitions'
import { STAGE_BORDER_COLORS } from '@/lib/hex-stage'

const AXIS_NAMES = ['daily_a', 'daily_b', 'weekly_a', 'weekly_b', 'monthly_a', 'monthly_b'] as const
const AXIS_LABELS: Record<(typeof AXIS_NAMES)[number], string> = {
  daily_a: '日足A',
  daily_b: '日足B',
  weekly_a: '週足A',
  weekly_b: '週足B',
  monthly_a: '月足A',
  monthly_b: '月足B',
}

export function StageTransitionsSection() {
  const [matrices, setMatrices] = useState<Record<string, number[][]> | null>(null)

  useEffect(() => {
    getStageTransitionMatrices().then(setMatrices)
  }, [])

  if (!matrices) {
    return <p className="text-xs text-[var(--color-text-tertiary)]">読み込み中...</p>
  }

  return (
    <section className="space-y-3">
      <header>
        <h2 className="text-lg font-semibold">ステージ遷移確率</h2>
        <p className="text-xs text-[var(--color-text-secondary)]">
          前日のステージから翌日のステージへの遷移確率。対角線が大きいほど同ステージに滞在しやすいことを示します。
        </p>
      </header>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {AXIS_NAMES.map(axis => (
          <MatrixCard key={axis} axis={axis} label={AXIS_LABELS[axis]} matrix={matrices[axis]} />
        ))}
      </div>
    </section>
  )
}

function MatrixCard({
  label,
  matrix,
}: {
  axis: string
  label: string
  matrix: number[][]
}) {
  const rowSums = matrix.map(row => row.reduce((a, b) => a + b, 0))
  const max = Math.max(...matrix.flat())

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)] p-3">
      <h3 className="mb-2 text-sm font-medium">{label}</h3>
      <div className="grid grid-cols-[auto_repeat(6,1fr)] gap-px text-[10px]">
        <div className="px-1 py-0.5 text-[var(--color-text-tertiary)]">from\to</div>
        {[1, 2, 3, 4, 5, 6].map(s => (
          <div
            key={s}
            className="px-1 py-0.5 text-center font-medium"
            style={{ color: STAGE_BORDER_COLORS[s] }}
          >
            {s}
          </div>
        ))}
        {matrix.map((row, i) => (
          <FragmentRow
            key={i}
            fromStage={i + 1}
            row={row}
            rowSum={rowSums[i]}
            globalMax={max}
          />
        ))}
      </div>
    </div>
  )
}

function FragmentRow({
  fromStage,
  row,
  rowSum,
  globalMax,
}: {
  fromStage: number
  row: number[]
  rowSum: number
  globalMax: number
}) {
  return (
    <>
      <div
        className="px-1 py-0.5 text-center font-medium"
        style={{ color: STAGE_BORDER_COLORS[fromStage] }}
      >
        {fromStage}
      </div>
      {row.map((count, j) => {
        const pct = rowSum > 0 ? (count / rowSum) * 100 : 0
        const intensity = globalMax > 0 ? count / globalMax : 0
        return (
          <div
            key={j}
            className="px-1 py-0.5 text-center tabular-nums"
            style={{
              backgroundColor:
                count > 0
                  ? `rgba(8, 145, 178, ${Math.max(0.05, intensity * 0.8)})`
                  : 'transparent',
              color: intensity > 0.5 ? 'white' : 'var(--color-text-secondary)',
            }}
            title={`${fromStage} → ${j + 1}: ${count.toLocaleString()}件 (${pct.toFixed(1)}%)`}
          >
            {pct.toFixed(0)}%
          </div>
        )
      })}
    </>
  )
}
