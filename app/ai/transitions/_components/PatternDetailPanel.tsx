'use client'

import { useEffect, useState } from 'react'
import {
  getPatternAllHorizons,
  getSampleCases,
  getPatternTimeline,
  type PatternHorizonRow,
  type SampleCase,
  type TimelinePoint,
} from '@/lib/server/transitions'
import { StageBadge } from '@/components/shared/StageBadge'
import { TickerLink } from '@/components/shared/TickerLink'
import { DistributionHistogram } from './DistributionHistogram'
import { CategoryBars } from './CategoryBars'
import { PatternTimeline } from './PatternTimeline'
import { HexStructureViz } from './HexStructureViz'

interface PatternDetailPanelProps {
  code: string
}

export function PatternDetailPanel({ code }: PatternDetailPanelProps) {
  const [horizons, setHorizons] = useState<PatternHorizonRow[] | null>(null)
  const [samples, setSamples] = useState<SampleCase[] | null>(null)
  const [timeline, setTimeline] = useState<TimelinePoint[] | null>(null)

  useEffect(() => {
    setHorizons(null)
    setSamples(null)
    setTimeline(null)
    let cancelled = false
    Promise.all([
      getPatternAllHorizons(code),
      getSampleCases(code, 30),
      getPatternTimeline(code),
    ]).then(([h, s, t]) => {
      if (cancelled) return
      setHorizons(h)
      setSamples(s)
      setTimeline(t)
    })
    return () => {
      cancelled = true
    }
  }, [code])

  const stages = code.split('').map(Number) as [number, number, number, number, number, number]

  return (
    <div className="space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)] p-4">
      {/* ヘッダ */}
      <header className="space-y-2 border-b border-[var(--color-border-soft)] pb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-semibold tabular-nums">{code}</h2>
          <span className="text-xs text-[var(--color-text-tertiary)]">日A日B週A週B月A月B</span>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          {[
            { label: '日足A', s: stages[0] },
            { label: '日足B', s: stages[1] },
            { label: '週足A', s: stages[2] },
            { label: '週足B', s: stages[3] },
            { label: '月足A', s: stages[4] },
            { label: '月足B', s: stages[5] },
          ].map((x, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded border border-[var(--color-border-soft)] px-2 py-1"
            >
              <span className="text-[var(--color-text-tertiary)]">{x.label}</span>
              <StageBadge stage={x.s} showLabel />
            </div>
          ))}
        </div>
      </header>

      {/* HEX 構造 */}
      <section>
        <h3 className="mb-2 text-sm font-medium">HEX 構造</h3>
        <HexStructureViz stages={stages} />
      </section>

      {/* リターン分布 */}
      <section>
        <h3 className="mb-2 text-sm font-medium">リターン分布</h3>
        {horizons ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {horizons.map(h => (
              <DistributionHistogram
                key={h.horizon_days}
                horizon={h.horizon_days}
                p05={h.p05}
                p25={h.p25}
                p50={h.p50}
                p75={h.p75}
                p95={h.p95}
                count={h.count}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-[var(--color-text-tertiary)]">読み込み中...</p>
        )}
      </section>

      {/* カテゴリ分布 */}
      <section>
        <h3 className="mb-2 text-sm font-medium">カテゴリ分布</h3>
        {horizons ? (
          <CategoryBars horizons={horizons} />
        ) : (
          <p className="text-xs text-[var(--color-text-tertiary)]">読み込み中...</p>
        )}
      </section>

      {/* 時系列 */}
      <section>
        <h3 className="mb-2 text-sm font-medium">過去の出現頻度</h3>
        {timeline ? (
          <PatternTimeline data={timeline} />
        ) : (
          <p className="text-xs text-[var(--color-text-tertiary)]">読み込み中...</p>
        )}
      </section>

      {/* サンプル銘柄 */}
      <section>
        <h3 className="mb-2 text-sm font-medium">直近の該当銘柄 (最新30件)</h3>
        {samples == null ? (
          <p className="text-xs text-[var(--color-text-tertiary)]">読み込み中...</p>
        ) : samples.length === 0 ? (
          <p className="text-xs text-[var(--color-text-tertiary)]">該当ケースなし</p>
        ) : (
          <ul className="grid grid-cols-2 gap-1 text-xs sm:grid-cols-3">
            {samples.map((s, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-2 rounded border border-[var(--color-border-soft)] px-2 py-1"
              >
                <TickerLink ticker={s.ticker} variant="compact" />
                <span className="tabular-nums text-[var(--color-text-tertiary)]">{s.date}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
