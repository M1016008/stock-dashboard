// components/hex/HexMap.tsx
// 完全移植: 株式アプリ/HEX-app/frontend/components/HexMap.tsx
// HEX-app の HexMap を stock-dashboard 用に移植。Tailwind v4 で動作。

'use client'
import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import { useRouter } from 'next/navigation'
import { Search, TrendingUp, BarChart3, Copy, Check } from 'lucide-react'

interface Stock {
  code: string
  name: string
  sector_large: string
  market_cap: number
  stage: number
  stage_a?: number | null
  stage_b?: number | null
  sector_small?: string | null
  price: number
  daily_change?: number
  weekly_change?: number
  monthly_change?: number
  months3_change?: number
  months6_change?: number
  ytd_change?: number
  daily_a_stage?: number | null
  daily_b_stage?: number | null
  weekly_a_stage?: number | null
  weekly_b_stage?: number | null
  monthly_a_stage?: number | null
  monthly_b_stage?: number | null
  prev_daily_a_stage?: number | null
  prev_daily_b_stage?: number | null
  prev_weekly_a_stage?: number | null
  prev_weekly_b_stage?: number | null
  prev_monthly_a_stage?: number | null
  prev_monthly_b_stage?: number | null
  prev_prev_daily_a_stage?: number | null
  prev_prev_daily_b_stage?: number | null
  prev_prev_weekly_a_stage?: number | null
  prev_prev_weekly_b_stage?: number | null
  prev_prev_monthly_a_stage?: number | null
  prev_prev_monthly_b_stage?: number | null
  sma_angles?: { sma5: number | null; sma25: number | null; sma75: number | null; sma300: number | null }
  prev_sma_angles?: { sma5: number | null; sma25: number | null; sma75: number | null; sma300: number | null }
  prev_prev_sma_angles?: { sma5: number | null; sma25: number | null; sma75: number | null; sma300: number | null }
}

const formatPercent = (val?: number) => {
  if (val === undefined || val === null) return '-'
  return `${val > 0 ? '+' : ''}${val.toFixed(2)}%`
}

const getPercentStyle = (val?: number | string): React.CSSProperties => {
  if (val === undefined || val === null || val === '') return { color: '#9ca3af' }
  const num = Number(val)
  if (isNaN(num)) return { color: '#9ca3af' }
  if (num > 0) return { color: '#16a34a', fontWeight: 'bold' }
  if (num < 0) return { color: '#ef4444', fontWeight: 'bold' }
  return { color: '#6b7280' }
}

const formatAngle = (angle: number | null | undefined) => {
  if (angle === null || angle === undefined) return '―'
  return `${angle > 0 ? '+' : ''}${angle}°`
}

const getAngleStyle = (angle: number | null | undefined): React.CSSProperties => {
  if (angle === null || angle === undefined) return { color: '#9ca3af' }
  if (angle > 0) return { color: '#16a34a', fontWeight: 'bold' }
  if (angle < 0) return { color: '#ef4444', fontWeight: 'bold' }
  return { color: '#6b7280' }
}

export default function HexMap({
  data,
  timeframe = 'daily',
}: {
  data: Stock[]
  timeframe?: 'daily' | 'weekly' | 'monthly'
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const router = useRouter()
  const [copiedCode, setCopiedCode] = useState<string | null>(null)
  const [selectedStage, setSelectedStage] = useState<number>(0)
  const [searchTerm, setSearchTerm] = useState('')
  const [hoveredStock, setHoveredStock] = useState<Stock | null>(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })

  const width = 650, height = 600

  useEffect(() => {
    if (!svgRef.current || !data || data.length === 0) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()
    const g = svg.append('g')

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.4, 3])
      .on('zoom', (event) => g.attr('transform', event.transform))
    svg.call(zoom)
    svg.call(zoom.transform, d3.zoomIdentity.translate(25, 25).scale(0.85))

    const centerX = width / 2, centerY = height / 2
    const stageRadius = 160, circleRadius = 72

    const stagePositions = new Map<number, { x: number; y: number }>()
    for (let stage = 1; stage <= 6; stage++) {
      const angle = (-90 + (stage - 1) * 60) * (Math.PI / 180)
      stagePositions.set(stage, {
        x: centerX + stageRadius * Math.cos(angle),
        y: centerY + stageRadius * Math.sin(angle),
      })
    }

    const sectorList = Array.from(new Set(data.map((d) => d.sector_large).filter(Boolean)))
    const colors = d3.range(sectorList.length).map((i) => {
      const hue = (i / Math.max(1, sectorList.length)) * 360
      return d3.hsl(hue, 0.7, 0.6).hex()
    })
    const colorScale = d3.scaleOrdinal<string>().domain(sectorList).range(colors)

    const sectorAngles = [-60, 0, 60, 120, 180, -120]
    const stageBgColor = '#f0f4ff'
    const stageBorderColor = '#667eea'

    stagePositions.forEach((pos, stage) => {
      g.append('circle')
        .attr('cx', pos.x).attr('cy', pos.y).attr('r', circleRadius)
        .attr('fill', stageBgColor).attr('stroke', stageBorderColor)
        .attr('stroke-width', 2).attr('opacity', 0.9)
        .style('cursor', 'pointer').on('click', () => setSelectedStage(stage))

      for (let sectorIdx = 0; sectorIdx < 6; sectorIdx++) {
        const startAngle = (sectorIdx * 60 - 90) * (Math.PI / 180)
        const x1 = pos.x + Math.cos(startAngle) * circleRadius
        const y1 = pos.y + Math.sin(startAngle) * circleRadius
        g.append('line')
          .attr('x1', pos.x).attr('y1', pos.y).attr('x2', x1).attr('y2', y1)
          .attr('stroke', '#2563eb').attr('stroke-width', 1.5).attr('opacity', 0.6)
      }

      sectorAngles.forEach((angle, idx) => {
        const labelAngle = angle * (Math.PI / 180)
        const labelDist = circleRadius * 0.65
        const labelX = pos.x + Math.cos(labelAngle) * labelDist
        const labelY = pos.y + Math.sin(labelAngle) * labelDist
        g.append('text')
          .attr('x', labelX).attr('y', labelY).attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'middle').attr('font-size', '18px')
          .attr('font-weight', 'bold').attr('fill', '#667eea').attr('opacity', 0.4)
          .text(idx + 1)
      })

      g.append('text').attr('x', pos.x).attr('y', pos.y)
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
        .attr('font-size', '14px').attr('font-weight', 'bold').attr('fill', '#333')
        .text(`S${stage}`).style('cursor', 'pointer').on('click', () => setSelectedStage(stage))

      const count = data.filter((d) => d.stage === stage).length
      g.append('text').attr('x', pos.x).attr('y', pos.y - circleRadius - 5)
        .attr('text-anchor', 'middle').attr('font-size', '11px')
        .attr('font-weight', 'bold').attr('fill', stageBorderColor)
        .text(count)
        .style('cursor', 'pointer').on('click', () => setSelectedStage(stage))
    })

    // データ量に応じてバブルサイズを自動調整
    const marketCapExtent = d3.extent(data, (d) => d.market_cap) as [number, number]
    const baseSize = data.length > 500 ? 1.3 : (data.length > 200 ? 1.7 : 2.2)
    const maxSize = data.length > 500 ? 3.5 : (data.length > 200 ? 5 : 8)
    const sizeScale = d3.scaleSqrt().domain(marketCapExtent).range([baseSize, maxSize])

    type SimulationNode = Stock & { x: number; y: number; stageB: number; sector: number }

    const sectorNodesMap = new Map<string, SimulationNode[]>()

    const nodes: SimulationNode[] = data.map((d, idx) => {
      let stageA: number
      let stageB: number

      if (timeframe === 'daily') {
        stageA = d.daily_a_stage || d.stage
        stageB = d.daily_b_stage || d.stage
      } else if (timeframe === 'weekly') {
        stageA = d.weekly_a_stage || d.stage
        stageB = d.weekly_b_stage || d.stage
      } else {
        stageA = d.monthly_a_stage || d.stage
        stageB = d.monthly_b_stage || d.stage
      }

      const sector = stageA >= 1 && stageA <= 6 ? stageA : (idx % 6) + 1
      const key = `${stageB}-${sector}`
      if (!sectorNodesMap.has(key)) sectorNodesMap.set(key, [])

      const node: SimulationNode = { ...d, stageB, sector, x: 0, y: 0 }
      sectorNodesMap.get(key)!.push(node)
      return node
    })

    sectorNodesMap.forEach((nodesInSector, key) => {
      const [stageB, sector] = key.split('-').map(Number)
      const pos = stagePositions.get(stageB)
      if (!pos) return
      const sectorAngleDeg = sectorAngles[sector - 1]

      nodesInSector.sort((a, b) => b.market_cap - a.market_cap)
      const count = nodesInSector.length

      nodesInSector.forEach((node, i) => {
        const minDist = 18
        const maxDist = circleRadius - 9
        const distRatio = Math.sqrt((i + 1) / count)
        const randomDist = 0.8 * distRatio + 0.2 * Math.random()
        const distance = minDist + randomDist * (maxDist - minDist)

        const spreadFactor = 22
        const randomAngleOffset = (Math.random() - 0.5) * 2 * spreadFactor
        const angleDeg = sectorAngleDeg + randomAngleOffset
        const angleRad = angleDeg * (Math.PI / 180)

        node.x = pos.x + distance * Math.cos(angleRad)
        node.y = pos.y + distance * Math.sin(angleRad)
      })
    })

    g.selectAll('.bubble').data(nodes).enter().append('circle')
      .attr('class', 'bubble').attr('cx', (d) => d.x).attr('cy', (d) => d.y)
      .attr('r', (d) => sizeScale(d.market_cap))
      .attr('fill', (d) => colorScale(d.sector_large || 'その他'))
      .attr('fill-opacity', 0.85).attr('stroke', '#fff').attr('stroke-width', 0.8)
      .style('cursor', 'pointer')
      .on('click', (_e, d) => router.push(`/stock/${encodeURIComponent(d.code)}`))
      .on('mouseover', function (event, d) {
        d3.select(this)
          .attr('stroke', '#333')
          .attr('stroke-width', 2)
          .attr('filter', 'drop-shadow(0px 4px 8px rgba(0,0,0,0.2))')
        setHoveredStock(d)
        setTooltipPos({ x: event.clientX, y: event.clientY })
      })
      .on('mousemove', function (event) {
        setTooltipPos({ x: event.clientX, y: event.clientY })
      })
      .on('mouseout', function () {
        d3.select(this).attr('stroke', '#fff').attr('stroke-width', 0.8).attr('filter', null)
        setHoveredStock(null)
      })
  }, [data, router, timeframe])

  const [selectedMarketCapRange, setSelectedMarketCapRange] = useState<string>('all')

  const filterByMarketCap = (stock: Stock) => {
    const val = stock.market_cap / 100000000
    switch (selectedMarketCapRange) {
      case '-50': return val < 50
      case '50-100': return val >= 50 && val < 100
      case '100-300': return val >= 100 && val < 300
      case '300-1000': return val >= 300 && val < 1000
      case '1000-': return val >= 1000
      default: return true
    }
  }

  const stageData = data
    .filter((d) => (selectedStage === 0 || d.stage === selectedStage) && filterByMarketCap(d))
    .sort((a, b) => b.market_cap - a.market_cap)

  return (
    <>
      <div className="flex gap-4 items-start relative">
        <div>
          <svg ref={svgRef} width={width} height={height} className="bg-white rounded-lg border border-gray-200" />
        </div>
        <div className="flex-1 min-w-[384px] max-w-[600px]" style={{ height: '600px' }}>
          <div className="h-full bg-white/90 backdrop-blur-xl rounded-2xl border border-white/20 shadow grid grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden">
            <div className="p-5 border-b border-gray-100 shrink-0">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg ring-1 ring-indigo-100">
                    <TrendingUp className="w-4 h-4" />
                  </div>
                  <h2 className="text-base font-bold text-gray-900 leading-tight">
                    {selectedStage === 0 ? 'All Stages' : `Stage ${selectedStage}`}
                  </h2>
                </div>
                <span className="flex items-center gap-1.5 text-xs font-bold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full border border-indigo-100">
                  <BarChart3 className="w-3 h-3" />
                  {stageData.length}
                </span>
              </div>

              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="銘柄を検索..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-9 pr-4 py-2.5 bg-gray-50 hover:bg-white border border-gray-200 rounded-xl text-sm focus:bg-white focus:border-indigo-500 outline-none placeholder:text-gray-400"
                />
              </div>
            </div>

            <div className="px-3 pt-3 pb-1 bg-gray-50/30 shrink-0">
              <div className="flex bg-gray-100 p-1 rounded-xl gap-0.5">
                {[
                  { id: 'all', label: '全銘柄' },
                  { id: '-50', label: '-50' },
                  { id: '50-100', label: '50-100' },
                  { id: '100-300', label: '100-300' },
                  { id: '300-1000', label: '300-1000' },
                  { id: '1000-', label: '1000-' },
                ].map((range) => {
                  const isSelected = selectedMarketCapRange === range.id
                  return (
                    <button
                      key={range.id}
                      onClick={() => setSelectedMarketCapRange(range.id)}
                      className={`flex-1 py-1.5 text-[11px] font-bold rounded-lg ${
                        isSelected
                          ? 'bg-white text-indigo-600 shadow ring-1 ring-black/5'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {range.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="px-3 pt-1 pb-3 bg-gray-50/30 border-b border-gray-100 shrink-0">
              <div className="flex bg-gray-100 p-1 rounded-xl gap-0.5">
                <button
                  onClick={() => setSelectedStage(0)}
                  className={`flex-1 py-1.5 text-[11px] font-bold rounded-lg ${
                    selectedStage === 0
                      ? 'bg-white text-indigo-600 shadow ring-1 ring-black/5'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  ALL
                </button>
                {[1, 2, 3, 4, 5, 6].map((s) => (
                  <button
                    key={s}
                    onClick={() => setSelectedStage(s)}
                    className={`flex-1 py-1.5 text-[11px] font-bold rounded-lg ${
                      selectedStage === s
                        ? 'bg-white text-indigo-600 shadow ring-1 ring-black/5'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    S{s}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-3 space-y-2" style={{ height: 'calc(600px - 200px)', overflowY: 'auto' }}>
              {stageData
                .filter((s) => s.code.includes(searchTerm) || s.name.includes(searchTerm))
                .map((s) => (
                  <div
                    key={s.code}
                    onClick={() => router.push(`/stock/${encodeURIComponent(s.code)}`)}
                    className="px-4 py-3 bg-white border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                  >
                    <div className="flex justify-between items-start">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <div
                            onClick={(e) => {
                              e.stopPropagation()
                              navigator.clipboard.writeText(s.code)
                              setCopiedCode(s.code)
                              setTimeout(() => setCopiedCode(null), 2000)
                            }}
                            className={`flex items-center gap-2 px-3 py-1.5 border text-xs font-medium rounded-full cursor-pointer transition-all ${
                              copiedCode === s.code
                                ? 'bg-slate-100 border-slate-200 text-slate-600'
                                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            {copiedCode === s.code ? (
                              <>
                                <Check size={13} className="text-slate-500" />
                                <span>Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy size={13} className="text-gray-400" />
                                <span>{s.code.replace('.T', '')}</span>
                              </>
                            )}
                          </div>
                          <span className="font-bold text-gray-800 text-sm">{s.name}</span>
                        </div>
                        <div className="text-[11px] text-gray-400 pl-0.5 flex items-center gap-1">
                          <span>{s.sector_large}</span>
                          {s.sector_small && (
                            <>
                              <span className="text-gray-300">/</span>
                              <span>{s.sector_small}</span>
                            </>
                          )}
                        </div>

                        {s.sma_angles && (
                          <div className="mt-2.5 flex flex-col gap-1">
                            {[
                              { label: '当日(T-3)', a: s.sma_angles },
                              { label: '10日前', a: s.prev_sma_angles },
                              { label: '20日前', a: s.prev_prev_sma_angles },
                            ].map(({ label, a }) => (
                              <div key={label} className="flex items-center gap-1.5 text-[11px] text-gray-600 bg-slate-50 border border-slate-100 rounded-lg pl-2 pr-1.5 py-2">
                                <span className="text-gray-500 text-[10px] mr-1">{label}</span>
                                {[
                                  { name: '5', v: a?.sma5 },
                                  { name: '25', v: a?.sma25 },
                                  { name: '75', v: a?.sma75 },
                                  { name: '300', v: a?.sma300 },
                                ].map((m) => (
                                  <div key={m.name} className="flex items-center gap-1 px-1">
                                    <span className="text-gray-400 text-[10px]">SMA{m.name}</span>
                                    <span style={getAngleStyle(m.v)}>{formatAngle(m.v)}</span>
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-col items-end gap-2.5 shrink-0">
                        <span className="text-xl font-bold text-gray-900 leading-none">
                          {s.price.toLocaleString()}
                        </span>
                        <div className="flex flex-wrap items-center justify-end gap-y-2 text-xs font-medium bg-gray-50 rounded-lg border border-gray-200 px-1 py-1.5">
                          {[
                            { label: '日', v: s.daily_change },
                            { label: '週', v: s.weekly_change },
                            { label: '月', v: s.monthly_change },
                            { label: '3M', v: s.months3_change },
                            { label: '6M', v: s.months6_change },
                            { label: '年', v: s.ytd_change },
                          ].map((p) => (
                            <div key={p.label} className="flex items-center gap-1.5 px-2 border-r border-gray-200 last:border-0">
                              <span className="text-gray-500 font-normal text-[10px]">{p.label}：</span>
                              <span style={getPercentStyle(p.v)}>{formatPercent(p.v)}</span>
                            </div>
                          ))}
                        </div>

                        <div className="flex items-center justify-between text-xs font-medium bg-gray-50 rounded-lg border border-gray-200 px-3 py-2 w-full">
                          <div className="flex items-center gap-3">
                            <span className="text-gray-500 text-[10px]">日A:</span>
                            <span className="text-indigo-600 font-bold">{s.daily_a_stage ?? '-'}</span>
                            <span className="text-gray-500 text-[10px]">日B:</span>
                            <span className="text-indigo-600 font-bold">{s.daily_b_stage ?? '-'}</span>
                          </div>
                          <div className="w-[2px] h-4 bg-black rounded-full" />
                          <div className="flex items-center gap-3">
                            <span className="text-gray-500 text-[10px]">週A:</span>
                            <span className="text-indigo-600 font-bold">{s.weekly_a_stage ?? '-'}</span>
                            <span className="text-gray-500 text-[10px]">週B:</span>
                            <span className="text-indigo-600 font-bold">{s.weekly_b_stage ?? '-'}</span>
                          </div>
                          <div className="w-[2px] h-4 bg-black rounded-full" />
                          <div className="flex items-center gap-3">
                            <span className="text-gray-500 text-[10px]">月A:</span>
                            <span className="text-indigo-600 font-bold">{s.monthly_a_stage ?? '-'}</span>
                            <span className="text-gray-500 text-[10px]">月B:</span>
                            <span className="text-indigo-600 font-bold">{s.monthly_b_stage ?? '-'}</span>
                          </div>
                        </div>

                        <span className="font-bold text-gray-800 text-sm">
                          {Math.round(s.market_cap / 1e8).toLocaleString()}
                          <span className="text-[10px] font-normal text-gray-500 ml-0.5">億</span>
                        </span>
                      </div>
                    </div>
                  </div>
                ))}

              {stageData.filter((s) => s.code.includes(searchTerm) || s.name.includes(searchTerm)).length === 0 && (
                <div className="text-center py-10 px-4">
                  <p className="text-xs text-gray-400 font-medium">
                    "{searchTerm}" に一致する銘柄は見つかりませんでした
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {hoveredStock && (
        <div
          className="fixed z-50 pointer-events-none"
          style={{ left: tooltipPos.x + 15, top: tooltipPos.y + 15, minWidth: '220px' }}
        >
          <div className="bg-white/95 backdrop-blur-md p-4 rounded-xl shadow-lg border border-white/20">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                {hoveredStock.code.replace('.T', '')}
              </span>
              <span className="text-[10px] font-bold text-white bg-indigo-500 px-2 py-0.5 rounded-full">
                Stage {hoveredStock.stage}
              </span>
            </div>
            <h3 className="font-bold text-gray-900 text-sm mb-1">{hoveredStock.name}</h3>
            <div className="flex items-baseline gap-2 mb-3">
              <span className="text-lg font-bold text-gray-900">{hoveredStock.price.toLocaleString()}</span>
              <span className="text-xs text-gray-500">{hoveredStock.code.endsWith('.T') ? '円' : '$'}</span>
            </div>
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-500">時価総額</span>
                <span className="font-medium text-gray-900">
                  {(hoveredStock.market_cap / 1e8).toLocaleString()}
                  <span className="text-[10px] text-gray-400 ml-1">億</span>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex justify-between">
                  <span className="text-gray-400">前日比</span>
                  <span style={getPercentStyle(hoveredStock.daily_change)}>{formatPercent(hoveredStock.daily_change)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">週次</span>
                  <span style={getPercentStyle(hoveredStock.weekly_change)}>{formatPercent(hoveredStock.weekly_change)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">月次</span>
                  <span style={getPercentStyle(hoveredStock.monthly_change)}>{formatPercent(hoveredStock.monthly_change)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">年初来</span>
                  <span style={getPercentStyle(hoveredStock.ytd_change)}>{formatPercent(hoveredStock.ytd_change)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
