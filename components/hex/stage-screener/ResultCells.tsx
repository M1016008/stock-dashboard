// components/hex/stage-screener/ResultCells.tsx
// Scan Ledger の表示専用セル。既存 payload の値を整形・配色するだけで、計算・閾値・意味は変更しない。
// 列ラベルは見出し側が担い、行内の .micro ラベルは mobile（見出しが無い幅）でのみ表示される。

import { ArrowDown, ArrowRight, ArrowUp, Minus } from 'lucide-react'
import { STAGE_BG_COLORS, STAGE_BORDER_COLORS, STAGE_LABELS } from '@/lib/hex-stage'
import { angleFlow, maAlignment, type Dir, type FlowTone, type MaSource } from './ma-flow'
import type { SortKey } from './filters'
import type { HexMapStock } from '../HexMap'
import s from './screener.module.css'

export const TONE_COLOR: Record<FlowTone, string> = {
  up: 'var(--color-price-up)',
  down: 'var(--color-price-down)',
  flat: 'var(--color-text-tertiary)',
}

/** 小さな文字でも判読できる濃度の Stage 文字色（背景は既存 STAGE_BG_COLORS）。 */
const STAGE_INK: Record<number, string> = {
  1: '#15803d',
  2: '#a16207',
  3: '#b91c1c',
  4: '#be185d',
  5: '#1d4ed8',
  6: '#7e22ce',
}

export function formatPercent(val?: number | null) {
  if (val === undefined || val === null || !Number.isFinite(val)) return '-'
  return `${val > 0 ? '+' : ''}${val.toFixed(2)}%`
}

export function formatPrice(price: number | null, isUs: boolean) {
  if (price == null) return '-'
  return isUs ? `$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : price.toLocaleString()
}

export function formatMarketCap(cap: number, isUs: boolean) {
  if (isUs) {
    if (!(cap > 0)) return '-'
    if (cap >= 1e12) return `$${(cap / 1e12).toFixed(2)}T`
    if (cap >= 1e9) return `$${(cap / 1e9).toFixed(1)}B`
    return `$${(cap / 1e6).toFixed(0)}M`
  }
  return `${Math.round(cap / 1e8).toLocaleString()}億`
}

/* ───────────────────────── Performance ───────────────────────── */

type ChangeField = 'daily_change' | 'weekly_change' | 'monthly_change' | 'months3_change' | 'months6_change' | 'ytd_change'

/**
 * scale は「背景の濃さ」を決める表示専用の目安幅（%）。値・符号・並び順・フィルタには一切関与しない。
 * 時間軸ごとに値幅が大きく違うため、各列の中で濃淡が比較できるよう列ごとに設定する。
 */
export const PERF_GROUPS: { caption: string; cols: { key: SortKey; field: ChangeField; label: string; name: string; scale: number }[] }[] = [
  {
    caption: '短期',
    cols: [
      { key: 'daily', field: 'daily_change', label: '日', name: '日次騰落率', scale: 5 },
      { key: 'weekly', field: 'weekly_change', label: '週', name: '週次騰落率', scale: 10 },
      { key: 'monthly', field: 'monthly_change', label: '月', name: '月次騰落率', scale: 20 },
    ],
  },
  {
    caption: '中長期',
    cols: [
      { key: 'months3', field: 'months3_change', label: '3M', name: '3ヶ月騰落率', scale: 30 },
      { key: 'months6', field: 'months6_change', label: '6M', name: '6ヶ月騰落率', scale: 50 },
      { key: 'ytd', field: 'ytd_change', label: 'YTD', name: '年初来騰落率', scale: 50 },
    ],
  },
]

function heat(value: number, scale: number) {
  if (value === 0) return undefined
  const t = Math.min(Math.abs(value) / scale, 1)
  const alpha = (0.035 + 0.13 * t).toFixed(3)
  return value > 0 ? `rgba(217, 0, 0, ${alpha})` : `rgba(0, 91, 172, ${alpha})`
}

export function PerfCell({
  value, label, name, scale, sorted,
}: { value?: number | null; label: string; name: string; scale: number; sorted: boolean }) {
  const valid = value != null && Number.isFinite(value)
  const color = !valid ? undefined : value > 0 ? TONE_COLOR.up : value < 0 ? TONE_COLOR.down : TONE_COLOR.flat
  return (
    <span
      className={s.perfCell}
      data-sorted={sorted || undefined}
      style={valid ? { background: heat(value, scale) } : undefined}
      title={`${name} ${formatPercent(value)}`}
    >
      <span className={s.micro} aria-hidden>{label}</span>
      <span className="sr-only">{name}</span>
      <span className={`${s.perfValue} ${valid ? '' : s.perfMissing}`} style={{ color }}>{formatPercent(value)}</span>
    </span>
  )
}

export function PerfStrip({ stock, sortKey }: { stock: HexMapStock; sortKey: SortKey }) {
  return (
    <div className={s.perf}>
      {PERF_GROUPS.map((g) => (
        <div key={g.caption} className={s.perfGroup} role="group" aria-label={`${g.caption}騰落率`}>
          {g.cols.map((c) => (
            <PerfCell
              key={c.key}
              value={stock[c.field]}
              label={c.label}
              name={c.name}
              scale={c.scale}
              sorted={sortKey === c.key}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/* ───────────────────────── Stage ───────────────────────── */

export const TF_GROUPS = [
  { tf: '日', a: 'daily_a_stage', b: 'daily_b_stage', name: '日足' },
  { tf: '週', a: 'weekly_a_stage', b: 'weekly_b_stage', name: '週足' },
  { tf: '月', a: 'monthly_a_stage', b: 'monthly_b_stage', name: '月足' },
] as const

function StageSquare({ v, axis, name }: { v: number | null | undefined; axis: 'A' | 'B'; name: string }) {
  const known = v != null && v >= 1 && v <= 6
  return (
    <span
      role="img"
      className={s.stageSq}
      data-empty={!known || undefined}
      style={known ? {
        background: STAGE_BG_COLORS[v],
        color: STAGE_INK[v],
        boxShadow: `inset 0 0 0 1px ${STAGE_BORDER_COLORS[v]}59`,
      } : undefined}
      title={`${name} ${axis}${known ? `${v} ${STAGE_LABELS[v]}` : ' 不明'}`}
      aria-label={`${name} ${axis}ステージ ${known ? v : '不明'}`}
    >
      {known ? v : '–'}
    </span>
  )
}

/** 日/週/月 × A/B の 6 軸。順序（日→週→月、各 A→B）は見出しと一致させる。 */
export function StageStrip({ stock }: { stock: HexMapStock }) {
  return (
    <span className={s.stageStrip} role="group" aria-label="日足・週足・月足の A/B ステージ">
      {TF_GROUPS.map((g) => (
        <span key={g.tf} className={s.stagePair}>
          <span className={s.micro} aria-hidden>{g.tf}</span>
          <StageSquare v={stock[g.a]} axis="A" name={g.name} />
          <StageSquare v={stock[g.b]} axis="B" name={g.name} />
        </span>
      ))}
    </span>
  )
}

/* ───────────────────────── Trend (MA / ML) ───────────────────────── */

function DirIcon({ dir }: { dir: Dir }) {
  const p = { size: 13, strokeWidth: 2.5, 'aria-hidden': true } as const
  if (dir === 'up') return <ArrowUp {...p} />
  if (dir === 'down') return <ArrowDown {...p} />
  if (dir === 'flat') return <ArrowRight {...p} />
  return <Minus {...p} />
}

/** angleFlow の分類語から加速/鈍化を抜き出す（分類そのものは変更しない）。 */
function accelMark(label: string) {
  if (label.includes('加速')) return '加速'
  if (label.includes('鈍化')) return '鈍化'
  return ''
}

export const MA_ITEMS = [
  ['5', 'sma5', '5日'],
  ['25', 'sma25', '25日'],
  ['75', 'sma75', '75日'],
  ['300', 'sma300', '300日'],
] as const

export function TrendCell({ stock }: { stock: MaSource }) {
  const alignment = maAlignment(stock)
  return (
    <div className={s.trend} title={`MA: ${alignment.label}`}>
      <span className={s.align} style={{ color: TONE_COLOR[alignment.tone] }}>{alignment.short}</span>
      <span className={s.maSlots} role="group" aria-label="移動平均の傾き">
        {MA_ITEMS.map(([short, key, name]) => {
          const flow = angleFlow(stock.sma_angles?.[key], stock.prev_sma_angles?.[key])
          const mark = accelMark(flow.label)
          return (
            <span
              key={key}
              className={s.maSlot}
              style={{ color: TONE_COLOR[flow.tone] }}
              title={`${name}MA ${flow.label}（傾き ${flow.pct}）`}
              aria-label={`${name}移動平均 ${flow.label}`}
            >
              <span className={s.micro} aria-hidden>{short}</span>
              <DirIcon dir={flow.dir} />
              {mark && <span className={s.maMark} aria-hidden>{mark}</span>}
            </span>
          )
        })}
      </span>
    </div>
  )
}

export function mlInfo(stock: HexMapStock) {
  const rank = stock.ml_candidate_rank != null ? ` #${stock.ml_candidate_rank}` : ''
  if (stock.ml_candidate_direction === 'up') {
    return { text: `ML↑${rank}`, label: `ML上昇候補${rank}`, tone: 'up' as FlowTone }
  }
  if (stock.ml_candidate_direction === 'down') {
    return { text: `ML↓${rank}`, label: `ML下落警戒${rank}`, tone: 'down' as FlowTone }
  }
  return null
}

export function MlMark({ stock }: { stock: HexMapStock }) {
  const ml = mlInfo(stock)
  if (!ml) {
    return (
      <span className={`${s.ml} ${s.mlNone}`} aria-label="ML候補外">
        <span className={s.micro} aria-hidden>ML </span>—
      </span>
    )
  }
  return (
    <span
      className={s.ml}
      style={{ color: TONE_COLOR[ml.tone] }}
      title={[ml.label, stock.ml_candidate_summary].filter(Boolean).join(' / ')}
      aria-label={ml.label}
    >
      {ml.text}
    </span>
  )
}

export function dataStatusLabel(status: HexMapStock['data_status']) {
  if (status === 'price_pending') return '当日価格待ち'
  if (status === 'snapshot_pending') return 'Stage生成待ち'
  if (status === 'partial_stage') return '履歴蓄積中'
  return null
}
