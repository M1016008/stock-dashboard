// components/capital-flow/SankeyFlow.tsx
// 「流出側 ⇒ 市場 ⇒ 流入側」を擬似 Sankey 風に描く。
// 個々のリボン幅は |Δmcap| の絶対値に比例。流出と流入の流量差が「市場全体の純増減」になる。

'use client'

import { useMemo } from 'react'

interface Item {
  label: string
  mcapDelta: number
  countTickers: number
}

interface Props {
  items: Item[]
  maxBands?: number
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

export function CapitalFlowSankey({ items, maxBands = 12, height = 460 }: Props) {
  const { outflows, inflows, sumIn, sumOut, net, scale } = useMemo(() => {
    const sortedDesc = [...items].filter((i) => i.mcapDelta > 0).sort((a, b) => b.mcapDelta - a.mcapDelta)
    const sortedAsc  = [...items].filter((i) => i.mcapDelta < 0).sort((a, b) => a.mcapDelta - b.mcapDelta)
    const inflows  = sortedDesc.slice(0, maxBands)
    const outflows = sortedAsc.slice(0, maxBands)
    const sumIn  = inflows.reduce((s, x) => s + x.mcapDelta, 0)
    const sumOut = -outflows.reduce((s, x) => s + x.mcapDelta, 0) // 正の値
    const total = Math.max(sumIn, sumOut, 1)
    return { outflows, inflows, sumIn, sumOut, net: sumIn - sumOut, scale: total }
  }, [items, maxBands])

  // SVG レイアウト
  const width = 1100
  const padX = 16, padY = 24
  const innerW = width - padX * 2
  const innerH = height - padY * 2
  const colW = 160
  const labelGap = 8
  const middleX1 = padX + colW
  const middleX2 = width - padX - colW
  const trunkW = (middleX2 - middleX1) / 2
  const trunkPad = 24

  // 各バンドの厚みを計算（Σ厚み が innerH に収まるように）
  const sideHeight = innerH - 40 // 上下にラベル空間
  function bandHeight(absDelta: number, totalAbs: number): number {
    return totalAbs > 0 ? (absDelta / totalAbs) * sideHeight : 0
  }
  const totalLeft  = sumOut
  const totalRight = sumIn

  // 流出側（左カラム）の縦位置
  let leftY = padY + 20
  const leftBands = outflows.map((it) => {
    const h = bandHeight(Math.abs(it.mcapDelta), totalLeft)
    const top = leftY
    leftY += h + 2
    return { ...it, top, h }
  })

  // 流入側（右カラム）の縦位置
  let rightY = padY + 20
  const rightBands = inflows.map((it) => {
    const h = bandHeight(it.mcapDelta, totalRight)
    const top = rightY
    rightY += h + 2
    return { ...it, top, h }
  })

  // 中央の市場ノード（左/右流量を集約する垂直バー）
  const trunkX = (middleX1 + middleX2) / 2
  const trunkLeftH  = sideHeight  // 流出側集約バー（左半分）
  const trunkRightH = sideHeight  // 流入側集約バー（右半分）
  const trunkY = padY + 20

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ minWidth: 800 }}>
        {/* 中央 市場ノード */}
        <rect
          x={trunkX - 12}
          y={trunkY}
          width={24}
          height={sideHeight}
          fill="#374151"
          rx={4}
        />
        <text
          x={trunkX}
          y={trunkY - 6}
          fontSize="11"
          textAnchor="middle"
          fontWeight={700}
          fill="#374151"
        >
          市場
        </text>
        <text
          x={trunkX}
          y={trunkY + sideHeight + 16}
          fontSize="10"
          textAnchor="middle"
          fontFamily="var(--font-mono)"
          fill={net >= 0 ? '#16a34a' : '#dc2626'}
          fontWeight={700}
        >
          純増減 {fmtSigned(net)}
        </text>

        {/* 左カラム見出し */}
        <text x={padX} y={padY + 14} fontSize="11" fontWeight={700} fill="#dc2626">
          📉 流出 {fmtMoney(sumOut)}
        </text>
        {/* 右カラム見出し */}
        <text x={width - padX} y={padY + 14} fontSize="11" fontWeight={700} fill="#16a34a" textAnchor="end">
          📈 流入 {fmtMoney(sumIn)}
        </text>

        {/* 流出側のバンド + リボン */}
        {leftBands.map((b) => {
          const xLeft = padX + colW
          const cy = b.top + b.h / 2
          const trunkPortion = (b.h / sideHeight) * trunkLeftH
          const trunkTop = trunkY + ((b.top - (padY + 20)) / sideHeight) * trunkLeftH
          const ribbonPath = makeRibbon(xLeft, b.top, b.h, trunkX - 12, trunkTop, trunkPortion)
          return (
            <g key={`L-${b.label}`}>
              {/* バンド本体 */}
              <rect x={padX} y={b.top} width={colW - labelGap} height={b.h} fill="#dc2626" opacity={0.85} rx={2} />
              <text
                x={padX + 6}
                y={cy + 3}
                fontSize={Math.min(11, Math.max(9, b.h - 4))}
                fill="#fff"
                fontWeight={600}
              >
                {b.label.length > 10 ? b.label.slice(0, 10) + '…' : b.label}
              </text>
              <text
                x={padX + colW - labelGap - 4}
                y={cy + 3}
                fontSize={Math.min(11, Math.max(9, b.h - 4))}
                fill="#fff"
                textAnchor="end"
                fontFamily="var(--font-mono)"
                fontWeight={700}
              >
                {fmtSigned(b.mcapDelta)}
              </text>
              {/* リボン */}
              <path d={ribbonPath} fill="#dc2626" opacity={0.25} />
              <title>
                {`${b.label}: ${fmtSigned(b.mcapDelta)}（${b.countTickers}銘柄）`}
              </title>
            </g>
          )
        })}

        {/* 流入側のバンド + リボン */}
        {rightBands.map((b) => {
          const xRight = width - padX - colW
          const cy = b.top + b.h / 2
          const trunkPortion = (b.h / sideHeight) * trunkRightH
          const trunkTop = trunkY + ((b.top - (padY + 20)) / sideHeight) * trunkRightH
          const ribbonPath = makeRibbon(trunkX + 12, trunkTop, trunkPortion, xRight, b.top, b.h, true)
          return (
            <g key={`R-${b.label}`}>
              <rect x={xRight + labelGap} y={b.top} width={colW - labelGap} height={b.h} fill="#16a34a" opacity={0.85} rx={2} />
              <text
                x={xRight + labelGap + 6}
                y={cy + 3}
                fontSize={Math.min(11, Math.max(9, b.h - 4))}
                fill="#fff"
                fontWeight={600}
              >
                {b.label.length > 10 ? b.label.slice(0, 10) + '…' : b.label}
              </text>
              <text
                x={xRight + colW - 4}
                y={cy + 3}
                fontSize={Math.min(11, Math.max(9, b.h - 4))}
                fill="#fff"
                textAnchor="end"
                fontFamily="var(--font-mono)"
                fontWeight={700}
              >
                {fmtSigned(b.mcapDelta)}
              </text>
              <path d={ribbonPath} fill="#16a34a" opacity={0.25} />
              <title>
                {`${b.label}: ${fmtSigned(b.mcapDelta)}（${b.countTickers}銘柄）`}
              </title>
            </g>
          )
        })}
      </svg>
      <div style={{ fontSize: '10px', color: 'var(--text-muted)', textAlign: 'center', marginTop: '6px' }}>
        各リボンの太さは |Δ時価総額| に比例（上位 {maxBands} 業種ずつ表示）
      </div>
    </div>
  )

  // 端 (x1,y1, h1) と中央 (x2,y2, h2) を曲線で結ぶリボン
  function makeRibbon(x1: number, y1: number, h1: number, x2: number, y2: number, h2: number, reverse = false): string {
    if (h1 <= 0 || h2 <= 0) return ''
    const cp = (x1 + x2) / 2
    const top    = `M ${x1} ${y1} C ${cp} ${y1}, ${cp} ${y2}, ${x2} ${y2}`
    const bottom = `L ${x2} ${y2 + h2} C ${cp} ${y2 + h2}, ${cp} ${y1 + h1}, ${x1} ${y1 + h1} Z`
    return reverse ? top + ' ' + bottom : top + ' ' + bottom
  }
}
