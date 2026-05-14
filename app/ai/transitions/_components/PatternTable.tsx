'use client'

import { useMemo, useState } from 'react'
import type { PatternListRow } from '@/lib/server/transitions'

type SortKey = 'count' | 'p50' | 'p25' | 'p75' | 'pattern_code'
type SortDir = 'asc' | 'desc'

interface PatternTableProps {
  patterns: PatternListRow[]
  selectedCode: string | null
  onSelect: (code: string) => void
  horizon: number
}

export function PatternTable({
  patterns,
  selectedCode,
  onSelect,
  horizon,
}: PatternTableProps) {
  const [minCount, setMinCount] = useState(30)
  const [partial, setPartial] = useState('')  // 6 桁 ('?' or '_' or 1-6)
  const [sortKey, setSortKey] = useState<SortKey>('count')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const filtered = useMemo(() => {
    return patterns.filter(p => {
      if (p.count < minCount) return false
      if (partial.length === 6) {
        for (let i = 0; i < 6; i++) {
          const ch = partial[i]
          if (ch !== '?' && ch !== '_' && ch !== p.pattern_code[i]) return false
        }
      }
      return true
    })
  }, [patterns, minCount, partial])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    arr.sort((a, b) => {
      const av = (a[sortKey] ?? -Infinity) as number | string
      const bv = (b[sortKey] ?? -Infinity) as number | string
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'desc' ? -cmp : cmp
    })
    return arr
  }, [filtered, sortKey, sortDir])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)]">
      {/* フィルタ */}
      <div className="space-y-2 border-b border-[var(--color-border-soft)] p-3">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="text-[var(--color-text-secondary)]">最小件数</label>
          <input
            type="number"
            min={1}
            value={minCount}
            onChange={e => setMinCount(parseInt(e.target.value) || 1)}
            className="w-20 rounded border border-[var(--color-border-default)] bg-[var(--color-surface-base)] px-2 py-1 tabular-nums"
          />
          <label className="text-[var(--color-text-secondary)]">
            部分一致 (?でワイルド、6桁)
          </label>
          <input
            type="text"
            value={partial}
            onChange={e => setPartial(e.target.value)}
            placeholder="例: 1?????"
            maxLength={6}
            className="w-28 rounded border border-[var(--color-border-default)] bg-[var(--color-surface-base)] px-2 py-1 tabular-nums"
          />
          <span className="ml-auto tabular-nums text-[var(--color-text-tertiary)]">
            {sorted.length.toLocaleString()} 件
          </span>
        </div>
      </div>

      {/* ヘッダ */}
      <div className="grid grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)] gap-2 border-b border-[var(--color-border-soft)] px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)]">
        <button
          onClick={() => toggleSort('pattern_code')}
          className="text-left hover:text-[var(--color-text-primary)]"
        >
          パターン{sortArrow('pattern_code')}
        </button>
        <button
          onClick={() => toggleSort('count')}
          className="text-right hover:text-[var(--color-text-primary)]"
        >
          件数{sortArrow('count')}
        </button>
        <button
          onClick={() => toggleSort('p50')}
          className="text-right hover:text-[var(--color-text-primary)]"
        >
          {horizon}日中央値{sortArrow('p50')}
        </button>
        <button
          onClick={() => toggleSort('p25')}
          className="text-right hover:text-[var(--color-text-primary)]"
        >
          25%-75%
        </button>
        <span>カテゴリ分布</span>
      </div>

      {/* 本体 */}
      <ul className="max-h-[600px] divide-y divide-[var(--color-border-soft)] overflow-y-auto">
        {sorted.length === 0 ? (
          <li className="px-3 py-6 text-center text-xs text-[var(--color-text-tertiary)]">
            条件に一致するパターンがありません
          </li>
        ) : (
          sorted.map(p => (
            <li
              key={p.pattern_code}
              onClick={() => onSelect(p.pattern_code)}
              className={`grid cursor-pointer grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)] gap-2 px-3 py-2 text-sm hover:bg-[var(--color-surface-muted)] ${
                selectedCode === p.pattern_code
                  ? 'bg-[var(--color-brand-50)]'
                  : ''
              }`}
            >
              <span className="font-medium tabular-nums">{p.pattern_code}</span>
              <span className="text-right tabular-nums">
                {p.count.toLocaleString()}
              </span>
              <span
                className={`text-right font-medium tabular-nums ${
                  (p.p50 ?? 0) > 0
                    ? 'text-[var(--color-price-up)]'
                    : (p.p50 ?? 0) < 0
                      ? 'text-[var(--color-price-down)]'
                      : ''
                }`}
              >
                {p.p50 != null
                  ? `${p.p50 >= 0 ? '+' : ''}${p.p50.toFixed(2)}%`
                  : '—'}
              </span>
              <span className="text-right text-xs tabular-nums text-[var(--color-text-tertiary)]">
                {p.p25 != null && p.p75 != null
                  ? `${p.p25.toFixed(1)}〜${p.p75.toFixed(1)}`
                  : '—'}
              </span>
              <CategoryMiniBar breakdown={p.category_breakdown} />
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

function CategoryMiniBar({
  breakdown,
}: {
  breakdown: PatternListRow['category_breakdown']
}) {
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0)
  if (total === 0) return null
  const segments = [
    { key: 'very_up', count: breakdown.very_up, color: 'var(--color-price-up)', opacity: 1 },
    { key: 'up',       count: breakdown.up,       color: 'var(--color-price-up)', opacity: 0.5 },
    { key: 'flat',     count: breakdown.flat,     color: 'var(--color-text-tertiary)', opacity: 0.4 },
    { key: 'down',     count: breakdown.down,     color: 'var(--color-price-down)', opacity: 0.5 },
    { key: 'very_down',count: breakdown.very_down,color: 'var(--color-price-down)', opacity: 1 },
  ]
  return (
    <div className="flex h-3 self-center overflow-hidden rounded-sm border border-[var(--color-border-soft)]">
      {segments.map(s =>
        s.count > 0 ? (
          <div
            key={s.key}
            style={{
              width: `${(s.count / total) * 100}%`,
              backgroundColor: s.color,
              opacity: s.opacity,
            }}
            title={`${s.key}: ${s.count.toLocaleString()}件`}
          />
        ) : null,
      )}
    </div>
  )
}
