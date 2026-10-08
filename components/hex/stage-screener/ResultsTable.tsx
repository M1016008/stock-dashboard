// components/hex/stage-screener/ResultsTable.tsx
// Scan Ledger — 結果一覧。table ではなく、見出しと行が同じ grid 解剖を共有する分析行。
//   銘柄 | 価格 | 騰落（短期｜中長期） | Stage 6 軸 | トレンド（MA 配列 + ML）
// 見出しは行の 2 行構造をそのまま写し、並び替え可能な列は見出しから直接ソートできる。

'use client'

import { Check, Copy } from 'lucide-react'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import type { HexMapStock } from '../HexMap'
import type { SortKey, SortOrder } from './filters'
import {
  dataStatusLabel,
  formatMarketCap,
  formatPrice,
  MA_ITEMS,
  MlMark,
  PERF_GROUPS,
  PerfStrip,
  StageStrip,
  TF_GROUPS,
  TrendCell,
} from './ResultCells'
import s from './screener.module.css'

interface Props {
  rows: HexMapStock[]
  isUs: boolean
  copiedCode: string | null
  onCopy: (code: string) => void
  onOpen: (code: string) => void
  sortKey: SortKey
  sortOrder: SortOrder
  onHeaderSort: (key: SortKey) => void
}

function displayCode(code: string) {
  return code.replace('.T', '')
}

function subline(st: HexMapStock, isUs: boolean) {
  const sector = st.sector33_name ?? st.sector_small ?? st.sector17_name ?? st.sector_large
  return [st.market_segment, st.margin_type && !isUs ? st.margin_type : null, sector].filter(Boolean).join(' · ')
}

function sublineTitle(st: HexMapStock, isUs: boolean) {
  return [
    st.market_segment,
    st.margin_type,
    `${isUs ? 'Sector' : '17業種'}: ${st.sector17_name ?? st.sector_large}`,
    st.sector33_name ?? st.sector_small ? `${isUs ? 'Industry' : '33業種'}: ${st.sector33_name ?? st.sector_small}` : null,
  ].filter(Boolean).join(' / ')
}

function SortBtn({
  k, active, order, onSort, label, children,
}: { k: SortKey; active: SortKey; order: SortOrder; onSort: (k: SortKey) => void; label: string; children: ReactNode }) {
  const on = k === active
  return (
    <button
      type="button"
      className={s.sortBtn}
      data-active={on || undefined}
      onClick={() => onSort(k)}
      aria-label={`${label}で並び替え${on ? `（現在 ${order === 'desc' ? '降順' : '昇順'}、クリックで反転）` : ''}`}
    >
      {children}
      {on && <span className={s.sortArrow} aria-hidden>{order === 'desc' ? '▼' : '▲'}</span>}
    </button>
  )
}

function LedgerHead({ sortKey, sortOrder, onHeaderSort }: Pick<Props, 'sortKey' | 'sortOrder' | 'onHeaderSort'>) {
  const sp = { active: sortKey, order: sortOrder, onSort: onHeaderSort }
  return (
    <div className={`${s.grid} ${s.head}`}>
      <div className={s.idCell}>
        <span className={s.hLab}>銘柄</span>
        <span className={s.hCap}>
          <SortBtn k="code" label="コード" {...sp}>コード</SortBtn> · 市場 · 業種
        </span>
      </div>
      <div className={s.pxCell}>
        <span className={s.hLab}><SortBtn k="price" label="現在値" {...sp}>現在値</SortBtn></span>
        <span className={s.hCap}><SortBtn k="cap" label="時価総額" {...sp}>時価総額</SortBtn></span>
      </div>
      <div className={s.perf}>
        {PERF_GROUPS.map((g) => (
          <div key={g.caption} className={`${s.perfGroup} ${s.headPerfGroup}`}>
            <span className={s.hCap}>{g.caption}</span>
            {g.cols.map((c) => (
              <span key={c.key} className={s.hLab}>
                <SortBtn k={c.key} label={c.name} {...sp}>{c.label}</SortBtn>
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className={s.stageCell}>
        <div className={s.headStage}>
          {TF_GROUPS.map((g) => <span key={g.tf} className={s.hCap}>{g.name}</span>)}
          {TF_GROUPS.map((g) => (
            <span key={g.tf} className={`${s.hLab} ${s.headAB}`} title={`${g.name}: A ステージ / B ステージ`}>
              <span>A</span><span>B</span>
            </span>
          ))}
        </div>
      </div>
      <div className={s.trendCell}>
        <div className={`${s.hCap} ${s.headTrendTop}`}>
          <span title="5/25/75日MAの向きの揃い方">MA 配列</span>
          <span title="機械学習候補の方向と順位">ML 候補</span>
        </div>
        <div className={s.headMa} title="各移動平均の傾き方向。加速/鈍化は前日比の傾き変化">
          {MA_ITEMS.map(([short]) => <span key={short} className={s.hLab}>{short}</span>)}
        </div>
      </div>
    </div>
  )
}

function CodeButton({ code, copied, onCopy }: { code: string; copied: boolean; onCopy: (code: string) => void }) {
  return (
    <button
      type="button"
      className={s.code}
      data-copied={copied || undefined}
      onClick={(e: MouseEvent) => {
        e.stopPropagation()
        onCopy(code)
      }}
      onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
      title="コードをコピー"
      aria-label={`${displayCode(code)} をコピー`}
    >
      {displayCode(code)}
      {copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden style={{ opacity: 0.45 }} />}
    </button>
  )
}

export default function ResultsLedger({ rows, isUs, copiedCode, onCopy, onOpen, sortKey, sortOrder, onHeaderSort }: Props) {
  const onKey = (code: string) => (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(code)
    }
  }

  return (
    <>
      <LedgerHead sortKey={sortKey} sortOrder={sortOrder} onHeaderSort={onHeaderSort} />
      <ul className={s.rows} aria-label="ステージスクリーナー結果">
        {rows.map((st) => {
          const status = isUs ? dataStatusLabel(st.data_status) : null
          return (
            <li
              key={st.code}
              className={`${s.grid} ${s.row}`}
              onClick={() => onOpen(st.code)}
              onKeyDown={onKey(st.code)}
              tabIndex={0}
              role="link"
              aria-label={`${st.name} の詳細を開く`}
            >
              <div className={s.idCell}>
                <div className={s.nameLine}>
                  <span className={s.name} title={st.name}>{st.name}</span>
                  {status && <span className={s.statusTag}>{status}</span>}
                </div>
                <div className={s.metaLine}>
                  <CodeButton code={st.code} copied={copiedCode === st.code} onCopy={onCopy} />
                  <span className={s.meta} title={sublineTitle(st, isUs)}>{subline(st, isUs)}</span>
                </div>
              </div>

              <div className={s.pxCell}>
                <span className={s.price} data-sorted={sortKey === 'price' || undefined}>
                  <span className="sr-only">現在値 </span>{formatPrice(st.price, isUs)}
                </span>
                <span className={s.cap} data-sorted={sortKey === 'cap' || undefined}>
                  <span className="sr-only">時価総額 </span>{formatMarketCap(st.market_cap, isUs)}
                </span>
              </div>

              <PerfStrip stock={st} sortKey={sortKey} />

              <div className={s.stageCell}><StageStrip stock={st} /></div>

              <div className={s.trendCell}><TrendCell stock={st} /></div>
              <div className={s.mlCell}><MlMark stock={st} /></div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
