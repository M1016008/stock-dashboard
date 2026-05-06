// components/hex/HexMap.tsx
// 完全移植: 株式アプリ/HEX-app/frontend/components/HexMap.tsx
// HEX-app の HexMap を stock-dashboard 用に移植。Tailwind v4 で動作。

'use client'
import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import { useRouter } from 'next/navigation'
import { Search, Copy, Check } from 'lucide-react'
import { STAGE_BG_COLORS, STAGE_BORDER_COLORS, STAGE_LABELS } from '@/lib/hex-stage'
import { StageDots } from '@/components/ui/StageDots'

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

  const width = 980, height = 380

  useEffect(() => {
    if (!svgRef.current || !data || data.length === 0) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()
    const g = svg.append('g')

    // 6 ステージを横一列にレイアウト（左→右、Stage 1〜6）。
    // 強気→弱気→強気回帰 の流れを左から右に読むのが自然。
    const padding = 20
    const cellWidth = (width - padding * 2) / 6
    const cellHeight = height - 60 // タイトル領域を引いた残り
    const titleY = 30

    // 銘柄ごとに timeframe に応じた stageA / stageB を決定
    type SimulationNode = Stock & { x: number; y: number; stageA: number; stageB: number }
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
      if (stageA < 1 || stageA > 6) stageA = (idx % 6) + 1
      if (stageB < 1 || stageB > 6) stageB = stageA
      return { ...d, stageA, stageB, x: 0, y: 0 }
    })

    // バブルサイズ（時価総額に応じて）
    const marketCapExtent = d3.extent(data, (d) => d.market_cap) as [number, number]
    const sizeScale = d3.scaleSqrt().domain(marketCapExtent).range([2.5, 9])

    for (let stage = 1; stage <= 6; stage++) {
      const cx = padding + cellWidth * (stage - 1) + cellWidth / 2
      const cellX = padding + cellWidth * (stage - 1)
      const cellInnerW = cellWidth - 8

      // ステージタイル（背景）
      g.append('rect')
        .attr('x', cellX + 4).attr('y', titleY + 30)
        .attr('width', cellInnerW).attr('height', cellHeight - 30)
        .attr('rx', 12).attr('ry', 12)
        .attr('fill', STAGE_BG_COLORS[stage])
        .attr('stroke', STAGE_BORDER_COLORS[stage])
        .attr('stroke-width', 1.5)
        .style('cursor', 'pointer')
        .on('click', () => setSelectedStage((cur) => cur === stage ? 0 : stage))

      // ステージラベル（上）
      g.append('text')
        .attr('x', cx).attr('y', titleY)
        .attr('text-anchor', 'middle')
        .attr('font-size', '18px').attr('font-weight', 700)
        .attr('fill', STAGE_BORDER_COLORS[stage])
        .text(`S${stage}`)
        .style('cursor', 'pointer')
        .on('click', () => setSelectedStage((cur) => cur === stage ? 0 : stage))

      // ステージ名（小さく）
      g.append('text')
        .attr('x', cx).attr('y', titleY + 16)
        .attr('text-anchor', 'middle')
        .attr('font-size', '11px').attr('font-weight', 500)
        .attr('fill', '#374151')
        .text(STAGE_LABELS[stage])

      // 件数（右上バッジ風）
      const count = data.filter((d) => d.stage === stage).length
      g.append('text')
        .attr('x', cellX + cellInnerW).attr('y', titleY + 50)
        .attr('text-anchor', 'end')
        .attr('font-size', '13px').attr('font-weight', 700)
        .attr('fill', STAGE_BORDER_COLORS[stage])
        .text(count.toLocaleString())
        .style('cursor', 'pointer')
        .on('click', () => setSelectedStage((cur) => cur === stage ? 0 : stage))
    }

    // 各セルの内側にバブルを敷き詰める。stageA で属するセル決定、stageB は色の濃淡で示す。
    const stageNodes = new Map<number, SimulationNode[]>()
    nodes.forEach((n) => {
      if (!stageNodes.has(n.stageA)) stageNodes.set(n.stageA, [])
      stageNodes.get(n.stageA)!.push(n)
    })

    stageNodes.forEach((stockList, stage) => {
      const cellX = padding + cellWidth * (stage - 1) + 4
      const cellY = titleY + 60
      const cellW = cellWidth - 8
      const cellH = cellHeight - 60

      stockList.sort((a, b) => b.market_cap - a.market_cap)
      const count = stockList.length

      // 円形配置を諦めてグリッド/ジッタ配置（セル内に均等にちらす）
      const cols = Math.max(8, Math.ceil(Math.sqrt(count * (cellW / cellH))))
      const rows = Math.ceil(count / cols)
      const gx = cellW / cols
      const gy = cellH / Math.max(1, rows)
      stockList.forEach((node, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        const jitterX = (Math.random() - 0.5) * gx * 0.8
        const jitterY = (Math.random() - 0.5) * gy * 0.8
        node.x = cellX + col * gx + gx / 2 + jitterX
        node.y = cellY + row * gy + gy / 2 + jitterY
      })

      // バブル描画。色は stageB の境界色（stageA セル色との対比）
      g.selectAll(`.bubble-${stage}`)
        .data(stockList)
        .enter()
        .append('circle')
        .attr('class', `bubble-${stage}`)
        .attr('cx', (d) => d.x).attr('cy', (d) => d.y)
        .attr('r', (d) => sizeScale(d.market_cap))
        .attr('fill', (d) => STAGE_BORDER_COLORS[d.stageB])
        .attr('fill-opacity', 0.7)
        .attr('stroke', '#fff').attr('stroke-width', 0.6)
        .style('cursor', 'pointer')
        .on('click', (_e, d) => router.push(`/stock/${encodeURIComponent(d.code)}`))
        .on('mouseover', function (event, d) {
          d3.select(this).attr('stroke', '#1f2937').attr('stroke-width', 1.6).attr('fill-opacity', 1)
          setHoveredStock(d)
          setTooltipPos({ x: event.clientX, y: event.clientY })
        })
        .on('mousemove', function (event) {
          setTooltipPos({ x: event.clientX, y: event.clientY })
        })
        .on('mouseout', function () {
          d3.select(this).attr('stroke', '#fff').attr('stroke-width', 0.6).attr('fill-opacity', 0.7)
          setHoveredStock(null)
        })
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

  const visible = stageData.filter((s) => s.code.includes(searchTerm) || s.name.includes(searchTerm))

  const MARKET_CAP_RANGES: { id: string; label: string }[] = [
    { id: 'all',      label: '全て' },
    { id: '-50',      label: '〜50億' },
    { id: '50-100',   label: '50〜100億' },
    { id: '100-300',  label: '100〜300億' },
    { id: '300-1000', label: '300〜1,000億' },
    { id: '1000-',    label: '1,000億〜' },
  ]

  return (
    <div className="flex flex-col gap-4 relative">
      {/* HEX マップ本体（横一列の6ステージ） */}
      <div className="overflow-x-auto -mx-2 px-2">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          className="block w-full h-auto"
          style={{ minWidth: 720, maxWidth: width }}
        />
      </div>

      {/* 検索 + フィルタバー */}
      <div className="flex flex-col gap-2 px-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="コード or 銘柄名で検索..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-white border border-gray-300 rounded-lg text-sm outline-none focus:border-indigo-500"
            />
          </div>
          <span className="text-xs text-gray-500">
            <strong className="text-indigo-600 text-base font-bold">{visible.length}</strong> 件
            {selectedStage !== 0 && <span className="ml-2">/ Stage {selectedStage}</span>}
            {selectedMarketCapRange !== 'all' && (
              <span className="ml-2">/ {MARKET_CAP_RANGES.find(r => r.id === selectedMarketCapRange)?.label}</span>
            )}
          </span>
        </div>

        {/* ステージフィルタ（カラフルなチップで分かりやすく） */}
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[10px] text-gray-500 mr-1">ステージ:</span>
          <button
            onClick={() => setSelectedStage(0)}
            className={`px-3 py-1 text-xs font-mono rounded-full border ${
              selectedStage === 0
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
            }`}
          >
            全て
          </button>
          {[1, 2, 3, 4, 5, 6].map((s) => {
            const active = selectedStage === s
            const bg = STAGE_BG_COLORS[s]
            const border = STAGE_BORDER_COLORS[s]
            return (
              <button
                key={s}
                onClick={() => setSelectedStage(active ? 0 : s)}
                className="px-3 py-1 text-xs font-mono rounded-full border font-bold"
                style={{
                  background: active ? border : bg,
                  color: active ? '#fff' : border,
                  borderColor: border,
                }}
                title={STAGE_LABELS[s]}
              >
                S{s} {STAGE_LABELS[s]}
              </button>
            )
          })}
        </div>

        {/* 時価総額フィルタ */}
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[10px] text-gray-500 mr-1">時価総額:</span>
          {MARKET_CAP_RANGES.map((range) => {
            const active = selectedMarketCapRange === range.id
            return (
              <button
                key={range.id}
                onClick={() => setSelectedMarketCapRange(range.id)}
                className={`px-3 py-1 text-xs font-mono rounded-full border ${
                  active
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                }`}
              >
                {range.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* 銘柄テーブル */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" style={{ minWidth: '1400px', borderCollapse: 'collapse' }}>
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <th className="px-3 py-2 text-left font-medium text-gray-500 whitespace-nowrap">コード</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500 whitespace-nowrap">銘柄名</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500 whitespace-nowrap">セクター</th>
                <th className="px-3 py-2 text-right font-medium text-gray-500 whitespace-nowrap">株価</th>
                <th className="px-3 py-2 text-right font-medium text-gray-500 whitespace-nowrap">時価総額</th>
                <th className="px-3 py-2 text-right font-medium text-gray-500 whitespace-nowrap">日%</th>
                <th className="px-3 py-2 text-right font-medium text-gray-500 whitespace-nowrap">週%</th>
                <th className="px-3 py-2 text-right font-medium text-gray-500 whitespace-nowrap">月%</th>
                <th className="px-3 py-2 text-right font-medium text-gray-500 whitespace-nowrap">3M</th>
                <th className="px-3 py-2 text-right font-medium text-gray-500 whitespace-nowrap">6M</th>
                <th className="px-3 py-2 text-right font-medium text-gray-500 whitespace-nowrap">YTD</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500 whitespace-nowrap">ステージ (日A/B 週A/B 月A/B)</th>
                <th className="px-3 py-2 text-right font-medium text-gray-500 whitespace-nowrap" title="SMA角度（当日 / SMA5/25/75/300）">SMA角度</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <tr
                  key={s.code}
                  onClick={() => router.push(`/stock/${encodeURIComponent(s.code)}`)}
                  className="hover:bg-gray-50 cursor-pointer"
                  style={{ borderBottom: '1px solid #f3f4f6' }}
                >
                  <td className="px-3 py-2 whitespace-nowrap">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        navigator.clipboard.writeText(s.code)
                        setCopiedCode(s.code)
                        setTimeout(() => setCopiedCode(null), 1500)
                      }}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-mono font-medium ${
                        copiedCode === s.code
                          ? 'bg-green-50 border-green-200 text-green-700'
                          : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                      }`}
                      title="コードをコピー"
                    >
                      {copiedCode === s.code ? <Check size={11} /> : <Copy size={11} />}
                      {s.code.replace('.T', '')}
                    </button>
                  </td>
                  <td className="px-3 py-2 font-medium text-gray-900 whitespace-nowrap">{s.name}</td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                    <span>{s.sector_large}</span>
                    {s.sector_small && (
                      <>
                        <span className="text-gray-300 mx-1">/</span>
                        <span>{s.sector_small}</span>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono whitespace-nowrap">{s.price.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right font-mono text-gray-600 whitespace-nowrap">
                    {Math.round(s.market_cap / 1e8).toLocaleString()}<span className="text-[10px] text-gray-400 ml-0.5">億</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono whitespace-nowrap" style={getPercentStyle(s.daily_change)}>{formatPercent(s.daily_change)}</td>
                  <td className="px-3 py-2 text-right font-mono whitespace-nowrap" style={getPercentStyle(s.weekly_change)}>{formatPercent(s.weekly_change)}</td>
                  <td className="px-3 py-2 text-right font-mono whitespace-nowrap" style={getPercentStyle(s.monthly_change)}>{formatPercent(s.monthly_change)}</td>
                  <td className="px-3 py-2 text-right font-mono whitespace-nowrap" style={getPercentStyle(s.months3_change)}>{formatPercent(s.months3_change)}</td>
                  <td className="px-3 py-2 text-right font-mono whitespace-nowrap" style={getPercentStyle(s.months6_change)}>{formatPercent(s.months6_change)}</td>
                  <td className="px-3 py-2 text-right font-mono whitespace-nowrap" style={getPercentStyle(s.ytd_change)}>{formatPercent(s.ytd_change)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <StageDots
                      values={[s.daily_a_stage, s.daily_b_stage, s.weekly_a_stage, s.weekly_b_stage, s.monthly_a_stage, s.monthly_b_stage]}
                      size={18}
                    />
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] whitespace-nowrap" title="SMA5° / SMA25° / SMA75° / SMA300°">
                    {s.sma_angles ? (
                      <span className="inline-flex gap-1.5">
                        <span style={getAngleStyle(s.sma_angles.sma5)}>{formatAngle(s.sma_angles.sma5)}</span>
                        <span className="text-gray-300">/</span>
                        <span style={getAngleStyle(s.sma_angles.sma25)}>{formatAngle(s.sma_angles.sma25)}</span>
                        <span className="text-gray-300">/</span>
                        <span style={getAngleStyle(s.sma_angles.sma75)}>{formatAngle(s.sma_angles.sma75)}</span>
                        <span className="text-gray-300">/</span>
                        <span style={getAngleStyle(s.sma_angles.sma300)}>{formatAngle(s.sma_angles.sma300)}</span>
                      </span>
                    ) : (
                      <span className="text-gray-400">---</span>
                    )}
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={13} className="text-center py-10 text-xs text-gray-400">
                    {searchTerm
                      ? `"${searchTerm}" に一致する銘柄が見つかりませんでした`
                      : '該当する銘柄がありません'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {hoveredStock && (
        <div
          className="fixed z-50 pointer-events-none"
          style={{ left: tooltipPos.x + 15, top: tooltipPos.y + 15, minWidth: '240px', maxWidth: '300px' }}
        >
          <div className="bg-white p-3 rounded-lg shadow-lg border border-gray-200">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-mono font-bold text-gray-700 bg-gray-100 px-2 py-0.5 rounded">
                {hoveredStock.code.replace('.T', '')}
              </span>
              <span
                className="text-[10px] font-bold px-2 py-0.5 rounded-full border"
                style={{
                  background: STAGE_BG_COLORS[hoveredStock.stage],
                  color: STAGE_BORDER_COLORS[hoveredStock.stage],
                  borderColor: STAGE_BORDER_COLORS[hoveredStock.stage],
                }}
              >
                S{hoveredStock.stage} {STAGE_LABELS[hoveredStock.stage]}
              </span>
            </div>
            <h3 className="font-bold text-gray-900 text-sm mb-2 leading-tight">{hoveredStock.name}</h3>
            {(hoveredStock.sector_large || hoveredStock.sector_small) && (
              <div className="text-[10px] text-gray-500 mb-2">
                {hoveredStock.sector_large}
                {hoveredStock.sector_small && <> / {hoveredStock.sector_small}</>}
              </div>
            )}
            <div className="flex items-baseline gap-2 mb-2 border-b border-gray-100 pb-2">
              <span className="text-lg font-bold font-mono text-gray-900">{hoveredStock.price.toLocaleString()}</span>
              <span className="text-xs text-gray-500">{hoveredStock.code.endsWith('.T') ? '円' : '$'}</span>
              <span className="ml-auto text-xs font-mono text-gray-600">
                {Math.round(hoveredStock.market_cap / 1e8).toLocaleString()}<span className="text-[10px] text-gray-400 ml-0.5">億</span>
              </span>
            </div>
            <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-[11px] mb-2">
              {[
                { label: '日', v: hoveredStock.daily_change },
                { label: '週', v: hoveredStock.weekly_change },
                { label: '月', v: hoveredStock.monthly_change },
                { label: '3M', v: hoveredStock.months3_change },
                { label: '6M', v: hoveredStock.months6_change },
                { label: 'YTD', v: hoveredStock.ytd_change },
              ].map((p) => (
                <div key={p.label} className="flex justify-between gap-1">
                  <span className="text-gray-400 text-[10px]">{p.label}</span>
                  <span className="font-mono" style={getPercentStyle(p.v)}>{formatPercent(p.v)}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-400">ステージ</span>
              <StageDots
                values={[
                  hoveredStock.daily_a_stage, hoveredStock.daily_b_stage,
                  hoveredStock.weekly_a_stage, hoveredStock.weekly_b_stage,
                  hoveredStock.monthly_a_stage, hoveredStock.monthly_b_stage,
                ]}
                size={16}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
