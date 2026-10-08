// components/hex/stage-screener/StageMatrixPanel.tsx
// B × A ステージ行列（日足 / 週足 / 月足）。選択 semantics は従来どおり:
//   - セルクリックでトグル（件数 0 のセルは選択不可）
//   - 同一時間軸内の複数セルは OR、時間軸間は AND（選択の無い時間軸は無視）
//   - いずれかに選択があると、他セルは「条件該当数 / 全数」の連動表示、該当 0 は減光
// 表現のみ再設計: ≥1024 は 3 行列を横並びで同時比較、未満はタブで 1 行列ずつ。
// セルの濃さ = 件数の相対密度（行列内最大値比）。Stage の色は B 行・A 列の見出しにだけ使う。

'use client'

import { X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { STAGE_BORDER_COLORS, STAGE_LABELS } from '@/lib/hex-stage'
import type { HexMapStock } from '../HexMap'
import s from './screener.module.css'

export type Timeframe = 'daily' | 'weekly' | 'monthly'
export type CellKey = string // "b-a"
export type Selections = Record<Timeframe, Set<CellKey>>

export const TIMEFRAMES: { key: Timeframe; label: string }[] = [
  { key: 'daily', label: '日足' },
  { key: 'weekly', label: '週足' },
  { key: 'monthly', label: '月足' },
]

const STAGES = [1, 2, 3, 4, 5, 6] as const

const STAGE_INK: Record<number, string> = {
  1: '#15803d',
  2: '#a16207',
  3: '#b91c1c',
  4: '#be185d',
  5: '#1d4ed8',
  6: '#7e22ce',
}

interface PanelProps {
  data: HexMapStock[]
  selections: Selections
  filteredTickers: Set<string>
  anySelection: boolean
  onToggle: (tf: Timeframe, b: number, a: number, count: number) => void
  onClearTimeframe: (tf: Timeframe) => void
}

export default function StageMatrixPanel({ data, selections, filteredTickers, anySelection, onToggle, onClearTimeframe }: PanelProps) {
  const [activeTf, setActiveTf] = useState<Timeframe>('daily')
  return (
    <section className={s.mPanel} aria-label="B×A ステージ行列">
      <div className={s.mTabs} role="group" aria-label="表示する時間軸">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf.key}
            type="button"
            className={s.mTab}
            aria-pressed={activeTf === tf.key}
            onClick={() => setActiveTf(tf.key)}
          >
            {tf.label}
            {selections[tf.key].size > 0 && <span className={s.mTabBadge}>{selections[tf.key].size}</span>}
          </button>
        ))}
      </div>
      <div className={s.mList}>
        {TIMEFRAMES.map((tf) => (
          <StageMatrix
            key={tf.key}
            active={activeTf === tf.key}
            data={data}
            timeframe={tf.key}
            label={tf.label}
            selectedCells={selections[tf.key]}
            filteredTickers={filteredTickers}
            anySelection={anySelection}
            onCellClick={(b, a, count) => onToggle(tf.key, b, a, count)}
            onClear={() => onClearTimeframe(tf.key)}
          />
        ))}
      </div>
    </section>
  )
}

function StageMatrix({
  active, data, timeframe, label, selectedCells, filteredTickers, anySelection, onCellClick, onClear,
}: {
  active: boolean
  data: HexMapStock[]
  timeframe: Timeframe
  label: string
  selectedCells: Set<CellKey>
  filteredTickers: Set<string>
  anySelection: boolean
  onCellClick: (b: number, a: number, count: number) => void
  onClear: () => void
}) {
  // matrix[b][a] = { count: セル全銘柄数, sel: 全条件通過銘柄のうちこのセルに入る数 }
  const { matrix, total, maxCount, maxSel } = useMemo(() => {
    const m: { count: number; sel: number }[][] =
      Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => ({ count: 0, sel: 0 })))
    let t = 0
    const aField = `${timeframe}_a_stage` as keyof HexMapStock
    const bField = `${timeframe}_b_stage` as keyof HexMapStock
    for (const d of data) {
      const a = d[aField] as number | null | undefined
      const b = d[bField] as number | null | undefined
      if (a == null || b == null) continue
      if (a < 1 || a > 6 || b < 1 || b > 6) continue
      m[b][a].count++
      t++
      if (filteredTickers.has(d.code)) m[b][a].sel++
    }
    let mc = 0
    let ms = 0
    for (const b of STAGES) for (const a of STAGES) {
      mc = Math.max(mc, m[b][a].count)
      ms = Math.max(ms, m[b][a].sel)
    }
    return { matrix: m, total: t, maxCount: mc, maxSel: ms }
  }, [data, timeframe, filteredTickers])

  const density = (n: number, max: number) => (n > 0 && max > 0 ? 0.05 + 0.3 * Math.sqrt(n / max) : 0)

  return (
    <article className={s.matrix} data-active={active} aria-label={`${label} B×A 行列`}>
      <header className={s.mHead}>
        <span className={s.mTitleWrap}>
          <h3 className={s.mTitle}>{label}</h3>
          {selectedCells.size > 0 ? (
            <span className={s.mSel}>
              {selectedCells.size} セル選択
              <button type="button" className={s.mSelX} onClick={onClear} aria-label={`${label} の選択をクリア`} title={`${label} の選択をクリア`}>
                <X size={11} aria-hidden />
              </button>
            </span>
          ) : anySelection ? (
            <span className={s.mLinked}>連動表示</span>
          ) : null}
        </span>
        <span className={s.mTotal}>
          <strong>{data.length.toLocaleString()}</strong> 銘柄
          {total < data.length && (
            <span title={`${data.length - total} 銘柄は ${label} のステージが計算できないため除外`}>
              {' '}· 分類可 {total.toLocaleString()}
            </span>
          )}
        </span>
      </header>

      <div className={s.mGrid} role="group" aria-label={`${label}: 行 = B ステージ、列 = A ステージ`}>
        <span className={s.mCorner} aria-hidden>B＼A</span>
        {STAGES.map((a) => (
          <span
            key={`a${a}`}
            className={s.aHead}
            style={{ color: STAGE_INK[a], borderBottomColor: STAGE_BORDER_COLORS[a] }}
            title={`A${a} ${STAGE_LABELS[a]}`}
          >
            A{a}
          </span>
        ))}

        {STAGES.map((b) => (
          <Row
            key={`b${b}`}
            b={b}
            matrix={matrix}
            selectedCells={selectedCells}
            anySelection={anySelection}
            maxCount={maxCount}
            maxSel={maxSel}
            density={density}
            onCellClick={onCellClick}
          />
        ))}
      </div>
    </article>
  )
}

function Row({
  b, matrix, selectedCells, anySelection, maxCount, maxSel, density, onCellClick,
}: {
  b: number
  matrix: { count: number; sel: number }[][]
  selectedCells: Set<CellKey>
  anySelection: boolean
  maxCount: number
  maxSel: number
  density: (n: number, max: number) => number
  onCellClick: (b: number, a: number, count: number) => void
}) {
  return (
    <>
      <span className={s.bHead} style={{ color: STAGE_INK[b], borderLeftColor: STAGE_BORDER_COLORS[b] }} title={`B${b} ${STAGE_LABELS[b]}`}>
        B{b}
        <span className={s.bLong}>{STAGE_LABELS[b]}</span>
      </span>
      {STAGES.map((a) => {
        const { count, sel } = matrix[b][a]
        const key: CellKey = `${b}-${a}`
        const isSelected = selectedCells.has(key)
        const empty = count === 0
        const linked = anySelection && !isSelected && !empty

        let background: string | undefined
        if (isSelected) background = 'var(--color-brand-800)'
        else if (linked) background = sel > 0 ? `rgba(0, 91, 172, ${density(sel, maxSel).toFixed(3)})` : undefined
        else if (!empty) background = `rgba(0, 91, 172, ${density(count, maxCount).toFixed(3)})`

        const title = [`B${b} ${STAGE_LABELS[b]} × A${a} ${STAGE_LABELS[a]}: ${count} 銘柄`]
        if (anySelection) title.push(`条件該当: ${sel} 銘柄`)

        return (
          <button
            key={a}
            type="button"
            className={s.cell}
            onClick={() => onCellClick(b, a, count)}
            disabled={empty}
            aria-pressed={isSelected}
            data-faded={(linked && sel === 0) || undefined}
            style={{ background }}
            title={title.join(' / ')}
            aria-label={title.join(' / ')}
          >
            {empty ? '·' : linked ? (
              sel > 0 ? (
                <>
                  <span>{sel}</span>
                  <span className={s.cellSub}>/{count}</span>
                </>
              ) : '—'
            ) : count}
          </button>
        )
      })}
    </>
  )
}
