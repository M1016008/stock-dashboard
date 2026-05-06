// components/capital-flow/Waterfall.tsx
// 横バー型ウォーターフォール。各業種を1行で縦に並べ、累積位置から左右に伸びるバーで Δmcap を示す。
// 文字回転が無いので業種名と値が常に水平に読める。

'use client'

import { useMemo } from 'react'

interface Item {
  label: string
  mcapDelta: number
  mcapDeltaPct: number | null
  countTickers: number
}

interface Props {
  items: Item[]
  rowHeight?: number
}

function fmtMoney(yen: number): string {
  if (Math.abs(yen) >= 1e12) return `${(yen / 1e12).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}兆`
  if (Math.abs(yen) >= 1e8) return `${Math.round(yen / 1e8).toLocaleString('ja-JP')}億`
  return `${yen.toLocaleString('ja-JP')}`
}

function fmtSigned(yen: number): string {
  return `${yen >= 0 ? '+' : '-'}${fmtMoney(Math.abs(yen))}`
}

function fmtPct(pct: number | null | undefined): string {
  if (pct == null) return '—'
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(2)}%`
}

export function CapitalFlowWaterfall({ items, rowHeight = 28 }: Props) {
  const { rows, total, xMin, xMax } = useMemo(() => {
    const sorted = [...items].sort((a, b) => b.mcapDelta - a.mcapDelta)
    let cum = 0
    let lo = 0
    let hi = 0
    const rows = sorted.map((it) => {
      const start = cum
      const end = cum + it.mcapDelta
      cum = end
      lo = Math.min(lo, start, end)
      hi = Math.max(hi, start, end)
      return { ...it, start, end }
    })
    const total = cum
    lo = Math.min(lo, 0, total)
    hi = Math.max(hi, 0, total)
    const pad = (hi - lo) * 0.05 || 1
    return { rows, total, xMin: lo - pad, xMax: hi + pad }
  }, [items])

  const labelW = 220
  const valueW = 200
  const trackW = 760
  const totalW = labelW + trackW + valueW
  const headerH = 30
  const totalH = headerH + (rows.length + 1) * rowHeight + 12
  const xScale = (v: number) => labelW + ((v - xMin) / (xMax - xMin)) * trackW

  const ticks = useMemo(() => {
    const t: number[] = []
    const range = xMax - xMin
    if (range <= 0) return [0]
    const stepBase = Math.pow(10, Math.floor(Math.log10(range / 5)))
    const step = range / 5 < stepBase * 2 ? stepBase : stepBase * (range / 5 / stepBase < 2.5 ? 2 : 5)
    const start = Math.ceil(xMin / step) * step
    for (let v = start; v <= xMax; v += step) t.push(v)
    return t
  }, [xMin, xMax])

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${totalW} ${totalH}`} width="100%" height={totalH} style={{ minWidth: 720 }}>
        {/* ヘッダ */}
        <text x={12} y={20} fontSize="11" fontWeight={700} fill="#374151">業種</text>
        <text x={labelW + trackW + valueW - 12} y={20} fontSize="11" fontWeight={700} fill="#374151" textAnchor="end">寄与額（累積）</text>

        {/* 主要グリッド + tick ラベル */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={xScale(t)} y1={headerH - 4} x2={xScale(t)} y2={totalH - 4} stroke={t === 0 ? '#9ca3af' : '#e5e7eb'} strokeWidth={t === 0 ? 1.2 : 1} strokeDasharray={t === 0 ? '' : '2 2'} />
            <text x={xScale(t)} y={headerH - 8} fontSize="9" textAnchor="middle" fill="#6b7280" fontFamily="var(--font-mono)">
              {fmtSigned(t)}
            </text>
          </g>
        ))}

        {/* 各行 */}
        {rows.map((r, i) => {
          const y = headerH + i * rowHeight
          const x1 = xScale(Math.min(r.start, r.end))
          const x2 = xScale(Math.max(r.start, r.end))
          const w = Math.max(2, x2 - x1)
          const isUp = r.mcapDelta >= 0
          const fill = isUp ? '#16a34a' : '#dc2626'
          return (
            <g key={r.label}>
              {i % 2 === 1 && (
                <rect x={0} y={y} width={totalW} height={rowHeight} fill="#f9fafb" />
              )}
              <text x={12} y={y + rowHeight / 2 + 4} fontSize="11" fill="#1f2937" fontWeight={500}>
                {r.label.length > 22 ? r.label.slice(0, 21) + '…' : r.label}
              </text>
              <text x={labelW - 12} y={y + rowHeight / 2 + 4} fontSize="9" textAnchor="end" fill="#9ca3af" fontFamily="var(--font-mono)">
                {r.countTickers}社
              </text>
              {i > 0 && (
                <line
                  x1={xScale(rows[i - 1].end)}
                  y1={y - rowHeight + rowHeight / 2 + 4}
                  x2={xScale(r.start)}
                  y2={y + rowHeight / 2 - 4}
                  stroke="#9ca3af"
                  strokeDasharray="2 2"
                  strokeWidth={1}
                />
              )}
              <rect x={x1} y={y + 6} width={w} height={rowHeight - 12} fill={fill} opacity={0.85} rx={2} />
              <text x={labelW + trackW + 10} y={y + rowHeight / 2 + 4} fontSize="11" fill={fill} fontFamily="var(--font-mono)" fontWeight={700}>
                {fmtSigned(r.mcapDelta)}
              </text>
              <text x={labelW + trackW + valueW - 12} y={y + rowHeight / 2 + 4} fontSize="10" fill={fill} textAnchor="end" fontFamily="var(--font-mono)" opacity={0.7}>
                {fmtPct(r.mcapDeltaPct)}
              </text>
              <title>
                {`${r.label}: ${fmtSigned(r.mcapDelta)} (${fmtPct(r.mcapDeltaPct)})\n累積: ${fmtSigned(r.start)} → ${fmtSigned(r.end)}`}
              </title>
            </g>
          )
        })}

        {/* 合計バー */}
        {rows.length > 0 && (() => {
          const y = headerH + rows.length * rowHeight + 4
          const x1 = xScale(Math.min(0, total))
          const x2 = xScale(Math.max(0, total))
          const w = Math.max(2, x2 - x1)
          const fill = total >= 0 ? '#0ea5e9' : '#f97316'
          return (
            <g>
              <line x1={0} y1={y - 2} x2={totalW} y2={y - 2} stroke="#9ca3af" strokeWidth={1} />
              <text x={12} y={y + rowHeight / 2 + 4} fontSize="11" fontWeight={800} fill="#0c4a6e">合計（純増減）</text>
              <rect x={x1} y={y + 4} width={w} height={rowHeight - 8} fill={fill} opacity={0.95} rx={2} />
              <text x={labelW + trackW + 10} y={y + rowHeight / 2 + 4} fontSize="12" fill={total >= 0 ? '#0369a1' : '#c2410c'} fontFamily="var(--font-mono)" fontWeight={800}>
                {fmtSigned(total)}
              </text>
            </g>
          )
        })()}
      </svg>
    </div>
  )
}
