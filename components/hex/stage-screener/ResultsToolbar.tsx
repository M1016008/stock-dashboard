// components/hex/stage-screener/ResultsToolbar.tsx
// Command bar — 結果一覧と同じ面の上端に接続する操作帯（カードの入れ子にしない）。
//   上段: 検索 · 列挙型の条件（時価総額 / 市場区分 / 信用区分 / データ状態）· 並び替え
//   下段: 方向性の条件（日次騰落 / MA方向 / ML候補）をワンクリックの segmented で · 件数 · 解除
// mobile では条件群を「条件」ボタンで開閉し、検索・並び替え・件数を常時表示する。

'use client'

import { ArrowDown, ArrowUp, ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react'
import { useId, useState } from 'react'
import {
  SORT_OPTIONS,
  type ChangeDir,
  type ExtraFilters,
  type MaDir,
  type MlFilter,
  type SortKey,
  type SortOrder,
  type StatusFilter,
} from './filters'
import s from './screener.module.css'

export interface CellChip {
  key: string
  label: string
  count: number
}

interface Props {
  isUs: boolean
  searchTerm: string
  onSearch: (v: string) => void
  marketCap: string
  marketCapRanges: { id: string; label: string }[]
  hasMarketCapData: boolean
  onMarketCap: (v: string) => void
  sortKey: SortKey
  sortOrder: SortOrder
  onSort: (key: SortKey) => void
  onToggleOrder: () => void
  extra: ExtraFilters
  onExtra: (patch: Partial<ExtraFilters>) => void
  segmentOptions: [string, number][]
  marginOptions: [string, number][]
  cellChips: CellChip[]
  onClearCell: (key: string) => void
  resultCount: number
  totalCount: number
  onClearAll: () => void
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`${s.field} ${className}`}>
      <span className={s.fieldLabel}>{label}</span>
      {children}
    </label>
  )
}

function Seg<T extends string>({
  label, value, options, onChange,
}: { label: string; value: T; options: { v: T; text: React.ReactNode; aria?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className={s.seg} role="group" aria-label={label}>
      <span className={s.segLabel} aria-hidden>{label}</span>
      {options.map((o) => (
        <button
          key={o.v || 'all'}
          type="button"
          className={s.segBtn}
          aria-pressed={value === o.v}
          aria-label={o.aria}
          onClick={() => onChange(o.v)}
        >
          {o.text}
        </button>
      ))}
    </div>
  )
}

const UP = 'var(--color-price-up)'
const DOWN = 'var(--color-price-down)'

export default function ResultsToolbar(p: Props) {
  const panelId = useId()
  const { extra } = p

  const activeExtra =
    [extra.segment, extra.margin, extra.change, extra.ma, extra.ml, extra.status].filter(Boolean).length +
    (p.marketCap !== 'all' ? 1 : 0)
  const [open, setOpen] = useState(activeExtra > 0)
  const hasActive = activeExtra > 0 || p.cellChips.length > 0 || p.searchTerm.trim() !== ''
  const sortLabel = SORT_OPTIONS.find((o) => o.key === p.sortKey)?.label ?? ''

  const pressedColor = (v: string, cur: string, color: string) => (v === cur ? undefined : color)

  return (
    <section aria-label="検索・絞り込み・並び替え" className={s.bar}>
      {/* 上段 */}
      <div className={s.barRow}>
        <span className={s.search}>
          <Search aria-hidden size={14} className={s.searchIcon} />
          <input
            type="search"
            value={p.searchTerm}
            onChange={(e) => p.onSearch(e.target.value)}
            placeholder="コード・銘柄名で検索"
            aria-label="コードまたは銘柄名で検索"
            className={s.searchInput}
          />
        </span>

        <button
          type="button"
          className={s.toggleBtn}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={panelId}
        >
          <SlidersHorizontal size={14} aria-hidden />
          条件
          {activeExtra > 0 && <span className={s.badge}>{activeExtra}</span>}
          <ChevronDown size={14} aria-hidden style={{ transform: open ? 'rotate(180deg)' : undefined }} />
        </button>

        <div id={panelId} className={`${s.filterSet} ${s.filterLast}`} data-open={open}>
          <Field label="時価総額">
            <select value={p.marketCap} onChange={(e) => p.onMarketCap(e.target.value)} className={s.fieldSelect}>
              {p.marketCapRanges.map((r) => (
                <option key={r.id} value={r.id} disabled={r.id !== 'all' && !p.hasMarketCapData}>
                  {r.id === 'all' ? '指定なし' : r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="市場">
            <select value={extra.segment} onChange={(e) => p.onExtra({ segment: e.target.value })} className={s.fieldSelect}>
              <option value="">指定なし</option>
              {p.segmentOptions.map(([v, n]) => <option key={v} value={v}>{v}（{n.toLocaleString()}）</option>)}
            </select>
          </Field>
          {!p.isUs && (
            <Field label="信用">
              <select value={extra.margin} onChange={(e) => p.onExtra({ margin: e.target.value })} className={s.fieldSelect}>
                <option value="">指定なし</option>
                {p.marginOptions.map(([v, n]) => <option key={v} value={v}>{v}（{n.toLocaleString()}）</option>)}
              </select>
            </Field>
          )}
          {p.isUs && (
            <Field label="データ">
              <select value={extra.status} onChange={(e) => p.onExtra({ status: e.target.value as StatusFilter })} className={s.fieldSelect}>
                <option value="">指定なし</option>
                <option value="ready">算出済み</option>
                <option value="pending">更新待ち・蓄積中</option>
              </select>
            </Field>
          )}
        </div>

        <span className={s.spacer} />

        <Field label="並び" className={s.sortField}>
          <select
            value={p.sortKey}
            onChange={(e) => p.onSort(e.target.value as SortKey)}
            className={s.fieldSelect}
            aria-label="並び替えの基準"
          >
            {SORT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              p.onToggleOrder()
            }}
            className={s.orderBtn}
            aria-label={`${sortLabel}を${p.sortOrder === 'desc' ? '降順' : '昇順'}で表示中。クリックで切替`}
            title={p.sortOrder === 'desc' ? '降順（大きい順）' : '昇順（小さい順）'}
          >
            {p.sortOrder === 'desc' ? <ArrowDown size={14} aria-hidden /> : <ArrowUp size={14} aria-hidden />}
          </button>
        </Field>
      </div>

      {/* 下段 */}
      <div className={s.barRow}>
        <div className={s.filterSet} data-open={open}>
          <Seg<ChangeDir>
            label="日次"
            value={extra.change}
            onChange={(v) => p.onExtra({ change: v })}
            options={[
              { v: '', text: 'すべて', aria: '日次の騰落: 指定なし' },
              { v: 'up', text: <><span style={{ color: pressedColor('up', extra.change, UP) }}>▲</span>上昇</>, aria: '日次の騰落: 上昇' },
              { v: 'down', text: <><span style={{ color: pressedColor('down', extra.change, DOWN) }}>▼</span>下落</>, aria: '日次の騰落: 下落' },
            ]}
          />
          <Seg<MaDir>
            label="MA"
            value={extra.ma}
            onChange={(v) => p.onExtra({ ma: v })}
            options={[
              { v: '', text: 'すべて', aria: 'MA方向: 指定なし' },
              { v: 'up', text: <><span style={{ color: pressedColor('up', extra.ma, UP) }}>↑</span>上向き</>, aria: 'MA方向: 上向き（優勢・揃い）' },
              { v: 'down', text: <><span style={{ color: pressedColor('down', extra.ma, DOWN) }}>↓</span>下向き</>, aria: 'MA方向: 下向き（優勢・揃い）' },
            ]}
          />
          <Seg<MlFilter>
            label="ML"
            value={extra.ml}
            onChange={(v) => p.onExtra({ ml: v })}
            options={[
              { v: '', text: 'すべて', aria: 'ML候補: 指定なし' },
              { v: 'any', text: '候補', aria: 'ML候補: 候補あり' },
              { v: 'up', text: <><span style={{ color: pressedColor('up', extra.ml, UP) }}>↑</span>上昇</>, aria: 'ML候補: 上昇候補' },
              { v: 'down', text: <><span style={{ color: pressedColor('down', extra.ml, DOWN) }}>↓</span>警戒</>, aria: 'ML候補: 下落警戒' },
            ]}
          />
        </div>

        <span className={s.spacer} />

        <div className={s.status}>
          {p.cellChips.map((c) => (
            <span key={c.key} className={s.chip}>
              {c.label} {c.count}セル
              <button
                type="button"
                className={s.chipX}
                onClick={() => p.onClearCell(c.key)}
                aria-label={`${c.label} のステージ選択を解除`}
              >
                <X size={11} aria-hidden />
              </button>
            </span>
          ))}
          {hasActive && (
            <button type="button" className={s.linkBtn} onClick={p.onClearAll}>すべてクリア</button>
          )}
          <span className={s.count} aria-live="polite">
            <span className={s.countNum}>{p.resultCount.toLocaleString()}</span>
            <span>件</span>
            {p.resultCount !== p.totalCount && <span className={s.countSub}>/ {p.totalCount.toLocaleString()}</span>}
          </span>
        </div>
      </div>

      {p.isUs && !p.hasMarketCapData && (
        <span className={s.note}>発行済株式数が未連携のため時価総額条件は無効</span>
      )}
    </section>
  )
}
