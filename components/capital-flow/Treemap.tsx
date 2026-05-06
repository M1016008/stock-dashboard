// components/capital-flow/Treemap.tsx
// Bloomberg 風の Treemap。エリア面積 = 時価総額(to)、色 = Δ% (緑〜赤の発散カラースケール)。

'use client'

import { useEffect, useRef } from 'react'
import * as d3 from 'd3'

interface TreemapItem {
  label: string
  countTickers: number
  mcapTo: number
  mcapDelta: number
  mcapDeltaPct: number | null
}

interface TreemapProps {
  items: TreemapItem[]
  height?: number
  onClickItem?: (label: string) => void
}

/** Δ% を緑(+)〜赤(-)の連続色にマップ。±5% で飽和。 */
function deltaColor(pct: number | null | undefined): string {
  if (pct == null) return '#9ca3af'
  const x = Math.max(-5, Math.min(5, pct)) / 5 // -1..1
  if (x === 0) return '#e5e7eb'
  if (x > 0) {
    // 0..1 を 緑階調に
    const t = x
    const g = d3.interpolateRgb('#dcfce7', '#16a34a')(t)
    return g
  } else {
    const t = -x
    const r = d3.interpolateRgb('#fee2e2', '#dc2626')(t)
    return r
  }
}

/** ラベル/数値が読めるかどうか（最低サイズ）の閾値 */
function fits(w: number, h: number): { showLabel: boolean; showValue: boolean; small: boolean } {
  return {
    showLabel: w > 60 && h > 26,
    showValue: w > 90 && h > 38,
    small: w < 70 || h < 32,
  }
}

function fmtMoney(yen: number): string {
  if (Math.abs(yen) >= 1e12) return `${(yen / 1e12).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}兆`
  if (Math.abs(yen) >= 1e8) return `${Math.round(yen / 1e8).toLocaleString('ja-JP')}億`
  return `${yen.toLocaleString('ja-JP')}`
}

function fmtPct(pct: number | null | undefined): string {
  if (pct == null) return '—'
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(2)}%`
}

export function CapitalFlowTreemap({ items, height = 520, onClickItem }: TreemapProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.innerHTML = ''
    const width = el.clientWidth || 800
    if (items.length === 0 || width === 0) return

    const root = d3
      .hierarchy<{ children: TreemapItem[] }>({ children: items.filter((i) => i.mcapTo > 0) } as any)
      .sum((d) => (d as any).mcapTo ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))

    d3.treemap<{ children: TreemapItem[] }>()
      .size([width, height])
      .paddingInner(2)
      .paddingOuter(2)
      .round(true)(root as any)

    const svg = d3
      .select(el)
      .append('svg')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('width', '100%')
      .attr('height', height)
      .style('display', 'block')

    const node = svg
      .selectAll('g')
      .data(root.leaves())
      .enter()
      .append('g')
      .attr('transform', (d: any) => `translate(${d.x0},${d.y0})`)
      .style('cursor', onClickItem ? 'pointer' : 'default')
      .on('click', function (_e, d: any) {
        if (onClickItem) onClickItem(d.data.label)
      })

    node
      .append('rect')
      .attr('width', (d: any) => d.x1 - d.x0)
      .attr('height', (d: any) => d.y1 - d.y0)
      .attr('fill', (d: any) => deltaColor(d.data.mcapDeltaPct))
      .attr('stroke', '#fff')
      .attr('stroke-width', 1)

    // ホバーで枠を強調
    node
      .on('mouseover', function () { d3.select(this).select('rect').attr('stroke', '#1f2937').attr('stroke-width', 2) })
      .on('mouseout',  function () { d3.select(this).select('rect').attr('stroke', '#fff').attr('stroke-width', 1) })

    // ラベル
    node.each(function (d: any) {
      const w = d.x1 - d.x0
      const h = d.y1 - d.y0
      const cap = fits(w, h)
      const g = d3.select(this)
      const dataPct: number | null = d.data.mcapDeltaPct ?? null
      const fontColor =
        dataPct == null
          ? '#374151'
          : Math.abs(dataPct) > 2.5
            ? '#fff'
            : '#1f2937'

      if (cap.showLabel) {
        g.append('text')
          .attr('x', 6)
          .attr('y', 16)
          .attr('font-size', cap.small ? '10px' : '12px')
          .attr('font-weight', 700)
          .attr('fill', fontColor)
          .text(d.data.label.length > Math.floor(w / 8) ? d.data.label.slice(0, Math.max(2, Math.floor(w / 8) - 1)) + '…' : d.data.label)
      }
      if (cap.showValue) {
        g.append('text')
          .attr('x', 6)
          .attr('y', 32)
          .attr('font-size', '11px')
          .attr('font-family', 'var(--font-mono)')
          .attr('font-weight', 600)
          .attr('fill', fontColor)
          .text(fmtPct(dataPct))
        g.append('text')
          .attr('x', 6)
          .attr('y', 46)
          .attr('font-size', '10px')
          .attr('font-family', 'var(--font-mono)')
          .attr('opacity', 0.85)
          .attr('fill', fontColor)
          .text(fmtMoney(d.data.mcapTo))
      }

      // ツールチップ
      g.append('title').text(
        `${d.data.label}\n` +
        `時価総額: ${fmtMoney(d.data.mcapTo)}\n` +
        `変化額: ${d.data.mcapDelta >= 0 ? '+' : ''}${fmtMoney(d.data.mcapDelta)}\n` +
        `変化率: ${fmtPct(dataPct)}\n` +
        `銘柄数: ${d.data.countTickers}`,
      )
    })
  }, [items, height, onClickItem])

  return (
    <div>
      <div ref={ref} style={{ width: '100%', minHeight: height }} />
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', justifyContent: 'center', marginTop: '8px', fontSize: '10px', color: 'var(--text-muted)' }}>
        <span>−5%以下</span>
        <div style={{ width: '160px', height: '8px', borderRadius: '2px', background: 'linear-gradient(to right, #dc2626, #fee2e2, #e5e7eb, #dcfce7, #16a34a)' }} />
        <span>+5%以上</span>
        <span style={{ marginLeft: 12 }}>面積 = 時価総額（最新日）</span>
      </div>
    </div>
  )
}
