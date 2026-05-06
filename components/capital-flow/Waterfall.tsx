// components/capital-flow/Waterfall.tsx
// ウォーターフォール図: 全体の Δmcap を業種別の寄与に分解する。
// 並びは寄与額の降順（流入が左、流出が右）。最後に「合計」のバーで net を示す。

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
  height?: number
}

function fmtMoney(yen: number): string {
  if (Math.abs(yen) >= 1e12) return `${(yen / 1e12).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}兆`
  if (Math.abs(yen) >= 1e8) return `${Math.round(yen / 1e8).toLocaleString('ja-JP')}億`
  return `${yen.toLocaleString('ja-JP')}`
}

function fmtSigned(yen: number): string {
  return `${yen >= 0 ? '+' : '-'}${fmtMoney(Math.abs(yen))}`
}

export function CapitalFlowWaterfall({ items, height = 360 }: Props) {
  const { bars, total, yMin, yMax } = useMemo(() => {
    const sorted = [...items].sort((a, b) => b.mcapDelta - a.mcapDelta)
    let cumulative = 0
    let lo = 0
    let hi = 0
    const bars = sorted.map((it) => {
      const start = cumulative
      const end = cumulative + it.mcapDelta
      cumulative = end
      lo = Math.min(lo, start, end)
      hi = Math.max(hi, start, end)
      return { ...it, start, end }
    })
    const total = cumulative
    lo = Math.min(lo, 0, total)
    hi = Math.max(hi, 0, total)
    // y 軸に余裕
    const pad = (hi - lo) * 0.05 || 1
    return { bars, total, yMin: lo - pad, yMax: hi + pad }
  }, [items])

  const padL = 80, padR = 16, padT = 16, padB = 60
  const width = 1200
  const innerW = width - padL - padR
  const innerH = height - padT - padB
  const stepW = bars.length > 0 ? innerW / (bars.length + 1) : 0
  const barW = Math.max(8, Math.min(40, stepW * 0.6))

  const yScale = (v: number) => padT + ((yMax - v) / (yMax - yMin)) * innerH
  const y0 = yScale(0)

  // y 軸の刻みを分かりやすく
  const ticks: number[] = useMemo(() => {
    const t: number[] = []
    const range = yMax - yMin
    const stepBase = Math.pow(10, Math.floor(Math.log10(range / 5)))
    const step = range / 5 < stepBase * 2 ? stepBase : stepBase * (range / 5 / stepBase < 2.5 ? 2 : 5)
    const start = Math.ceil(yMin / step) * step
    for (let v = start; v <= yMax; v += step) t.push(v)
    return t
  }, [yMin, yMax])

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ minWidth: 800 }}>
        {/* 0 ライン */}
        <line x1={padL} y1={y0} x2={padL + innerW} y2={y0} stroke="#9ca3af" strokeWidth={1} />
        {/* y 軸の grid */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} y1={yScale(t)} x2={padL + innerW} y2={yScale(t)} stroke="#e5e7eb" strokeDasharray="2 2" />
            <text x={padL - 6} y={yScale(t)} fontSize="10" textAnchor="end" alignmentBaseline="middle" fill="#6b7280" fontFamily="var(--font-mono)">
              {fmtSigned(t)}
            </text>
          </g>
        ))}

        {/* バー */}
        {bars.map((b, i) => {
          const x = padL + stepW * (i + 0.5) - barW / 2
          const yTop = yScale(Math.max(b.start, b.end))
          const yBot = yScale(Math.min(b.start, b.end))
          const barHeight = Math.max(1, yBot - yTop)
          const isUp = b.mcapDelta >= 0
          const fill = isUp ? '#16a34a' : '#dc2626'
          return (
            <g key={b.label}>
              {/* 接続線 */}
              {i > 0 && (
                <line
                  x1={padL + stepW * (i - 0.5) + barW / 2}
                  y1={yScale(bars[i - 1].end)}
                  x2={x}
                  y2={yScale(b.start)}
                  stroke="#9ca3af"
                  strokeDasharray="3 3"
                  strokeWidth={1}
                />
              )}
              <rect x={x} y={yTop} width={barW} height={barHeight} fill={fill} opacity={0.85} />
              {/* 値ラベル */}
              <text
                x={x + barW / 2}
                y={isUp ? yTop - 4 : yBot + 12}
                fontSize="10"
                textAnchor="middle"
                fill={fill}
                fontFamily="var(--font-mono)"
                fontWeight={700}
              >
                {fmtSigned(b.mcapDelta)}
              </text>
              {/* x ラベル */}
              <text
                x={x + barW / 2}
                y={height - padB + 14}
                fontSize="10"
                textAnchor="end"
                fill="#374151"
                transform={`rotate(-35 ${x + barW / 2} ${height - padB + 14})`}
              >
                {b.label.length > 10 ? b.label.slice(0, 9) + '…' : b.label}
              </text>
              <title>
                {`${b.label}\n累計: ${fmtSigned(b.start)} → ${fmtSigned(b.end)}\n寄与: ${fmtSigned(b.mcapDelta)}`}
              </title>
            </g>
          )
        })}

        {/* 合計バー */}
        {bars.length > 0 && (
          <g>
            <rect
              x={padL + stepW * (bars.length + 0.5) - barW / 2}
              y={yScale(Math.max(0, total))}
              width={barW}
              height={Math.max(1, Math.abs(yScale(total) - y0))}
              fill={total >= 0 ? '#0ea5e9' : '#f97316'}
              opacity={0.9}
            />
            <text
              x={padL + stepW * (bars.length + 0.5)}
              y={total >= 0 ? yScale(total) - 4 : yScale(total) + 12}
              fontSize="11"
              textAnchor="middle"
              fontFamily="var(--font-mono)"
              fontWeight={800}
              fill={total >= 0 ? '#0369a1' : '#c2410c'}
            >
              {fmtSigned(total)}
            </text>
            <text
              x={padL + stepW * (bars.length + 0.5)}
              y={height - padB + 14}
              fontSize="10"
              textAnchor="end"
              fontWeight={700}
              transform={`rotate(-35 ${padL + stepW * (bars.length + 0.5)} ${height - padB + 14})`}
              fill="#0c4a6e"
            >
              合計
            </text>
          </g>
        )}
      </svg>
    </div>
  )
}
