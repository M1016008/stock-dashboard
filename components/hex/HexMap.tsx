// components/hex/HexMap.tsx
// HEX ステージマップ。日足 / 週足 / 月足 の 6×6 (Bステージ × Aステージ) マトリクスを縦に並べ、
// セルをクリックすると下のテーブルがその (timeframe, B, A) 組合せの銘柄に絞り込まれる。

'use client'

import { useMemo, useState } from 'react'
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

type Timeframe = 'daily' | 'weekly' | 'monthly'

const TIMEFRAMES: { key: Timeframe; label: string }[] = [
  { key: 'daily',   label: '日足' },
  { key: 'weekly',  label: '週足' },
  { key: 'monthly', label: '月足' },
]

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

interface CellSelection {
  tf: Timeframe
  b: number
  a: number
}

const MARKET_CAP_RANGES: { id: string; label: string }[] = [
  { id: 'all',      label: '全て' },
  { id: '-50',      label: '〜50億' },
  { id: '50-100',   label: '50〜100億' },
  { id: '100-300',  label: '100〜300億' },
  { id: '300-1000', label: '300〜1,000億' },
  { id: '1000-',    label: '1,000億〜' },
]

export default function HexMap({ data }: { data: Stock[]; timeframe?: Timeframe }) {
  const router = useRouter()
  const [copiedCode, setCopiedCode] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedCell, setSelectedCell] = useState<CellSelection | null>(null)
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

  // セル選択 + 時価総額 + 検索 すべてで絞り込み、時価総額降順でソート
  const visible = useMemo(() => {
    return data
      .filter((s) => {
        if (selectedCell) {
          const aField = `${selectedCell.tf}_a_stage` as keyof Stock
          const bField = `${selectedCell.tf}_b_stage` as keyof Stock
          if (s[aField] !== selectedCell.a) return false
          if (s[bField] !== selectedCell.b) return false
        }
        if (!filterByMarketCap(s)) return false
        if (searchTerm && !s.code.includes(searchTerm) && !s.name.includes(searchTerm)) return false
        return true
      })
      .sort((a, b) => b.market_cap - a.market_cap)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selectedCell, selectedMarketCapRange, searchTerm])

  const onCellClick = (tf: Timeframe, b: number, a: number, count: number) => {
    if (count === 0) return
    setSelectedCell((cur) =>
      cur && cur.tf === tf && cur.b === b && cur.a === a ? null : { tf, b, a }
    )
  }

  return (
    <div className="flex flex-col gap-5 relative">
      {/* 3つのタイムフレーム別マトリクスを縦に積む */}
      <div className="flex flex-col gap-4">
        {TIMEFRAMES.map((tf) => (
          <StageMatrix
            key={tf.key}
            data={data}
            timeframe={tf.key}
            label={tf.label}
            selected={selectedCell?.tf === tf.key ? selectedCell : null}
            onCellClick={(b, a, count) => onCellClick(tf.key, b, a, count)}
          />
        ))}
      </div>

      {/* フィルタバー: 検索 + 時価総額 + 選択セルクリア */}
      <div className="flex flex-col gap-2 px-2 pt-2 border-t border-gray-200">
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
            {selectedCell && (
              <>
                <span className="ml-2">
                  / {TIMEFRAMES.find((t) => t.key === selectedCell.tf)?.label} B{selectedCell.b}-A{selectedCell.a}
                </span>
                <button
                  onClick={() => setSelectedCell(null)}
                  className="ml-2 px-2 py-0.5 text-[10px] border border-gray-300 rounded hover:bg-gray-50"
                >
                  × 解除
                </button>
              </>
            )}
            {selectedMarketCapRange !== 'all' && (
              <span className="ml-2">
                / {MARKET_CAP_RANGES.find((r) => r.id === selectedMarketCapRange)?.label}
              </span>
            )}
          </span>
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
                <th className="px-3 py-2 text-right font-medium text-gray-500 whitespace-nowrap" title="SMA角度（SMA5/25/75/300）">SMA角度</th>
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
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────
 * StageMatrix
 * 1 つのタイムフレームについて、Bステージ(縦) × Aステージ(横) の 6×6 マトリクス。
 * 各 B 行は「大きい長方形」のラベル＋6つの細長い長方形（A1〜A6 のセル）から成る。
 * セル内の数値はその (B, A) 組合せに該当する銘柄数。クリックで下のテーブルを絞り込む。
 * ────────────────────────────────────────────────────────────── */
function StageMatrix({
  data, timeframe, label, selected, onCellClick,
}: {
  data: Stock[]
  timeframe: Timeframe
  label: string
  selected: CellSelection | null
  onCellClick: (b: number, a: number, count: number) => void
}) {
  // matrix[b][a] = count. インデックスは 1..6 を使う
  const { matrix, total } = useMemo(() => {
    const m: number[][] = Array.from({ length: 7 }, () => Array(7).fill(0))
    let t = 0
    const aField = `${timeframe}_a_stage` as keyof Stock
    const bField = `${timeframe}_b_stage` as keyof Stock
    for (const d of data) {
      const a = d[aField] as number | null | undefined
      const b = d[bField] as number | null | undefined
      if (a == null || b == null) continue
      if (a < 1 || a > 6 || b < 1 || b > 6) continue
      m[b][a]++
      t++
    }
    return { matrix: m, total: t }
  }, [data, timeframe])

  return (
    <section className="bg-white border border-gray-200 rounded-lg p-3">
      <header className="flex items-baseline justify-between mb-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-base font-bold text-gray-900">{label}</h3>
          <span className="text-[11px] text-gray-500">B-Stage × A-Stage</span>
        </div>
        <span className="text-[11px] text-gray-500">
          <strong className="text-indigo-600 font-mono">{total.toLocaleString()}</strong> 銘柄
        </span>
      </header>

      {/* A-Stage ヘッダ行 */}
      <div className="grid gap-1 mb-1" style={{ gridTemplateColumns: '110px repeat(6, 1fr)' }}>
        <div></div>
        {[1, 2, 3, 4, 5, 6].map((a) => (
          <div key={a} className="text-center text-[10px] font-mono">
            <span className="font-bold" style={{ color: STAGE_BORDER_COLORS[a] }}>A{a}</span>
            <span className="text-gray-400 ml-1">{STAGE_LABELS[a]}</span>
          </div>
        ))}
      </div>

      {/* B-Stage 行 */}
      <div className="flex flex-col gap-1">
        {[1, 2, 3, 4, 5, 6].map((b) => {
          const rowTotal = matrix[b].slice(1, 7).reduce((s, n) => s + n, 0)
          return (
            <div
              key={b}
              className="grid gap-1"
              style={{
                gridTemplateColumns: '110px repeat(6, 1fr)',
                background: STAGE_BG_COLORS[b],
                border: `1.5px solid ${STAGE_BORDER_COLORS[b]}`,
                borderRadius: '6px',
                padding: '4px',
              }}
            >
              {/* B-stage ラベル（左の "大きい長方形" の名札部分） */}
              <div
                className="flex flex-col items-center justify-center text-xs font-mono leading-tight"
                style={{ color: STAGE_BORDER_COLORS[b], padding: '6px 4px' }}
              >
                <span className="font-bold text-base">B{b}</span>
                <span className="text-[10px] text-gray-700 mt-0.5">{STAGE_LABELS[b]}</span>
                <span className="text-[10px] text-gray-500 mt-0.5">{rowTotal} 銘柄</span>
              </div>

              {/* A1..A6 の細長いセル */}
              {[1, 2, 3, 4, 5, 6].map((a) => {
                const count = matrix[b][a]
                const isActive = !!selected && selected.b === b && selected.a === a
                const empty = count === 0
                return (
                  <button
                    key={a}
                    onClick={() => onCellClick(b, a, count)}
                    disabled={empty}
                    title={`B${b} × A${a}: ${count} 銘柄`}
                    style={{
                      background: isActive
                        ? STAGE_BORDER_COLORS[a]
                        : empty
                          ? '#fafafa'
                          : '#fff',
                      color: isActive
                        ? '#fff'
                        : empty
                          ? '#d1d5db'
                          : STAGE_BORDER_COLORS[a],
                      border: `1px solid ${empty ? '#e5e7eb' : STAGE_BORDER_COLORS[a]}`,
                      borderRadius: '4px',
                      padding: '12px 4px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '15px',
                      fontWeight: 700,
                      cursor: empty ? 'default' : 'pointer',
                      transition: 'transform 0.1s, box-shadow 0.1s',
                      boxShadow: isActive ? `0 2px 8px ${STAGE_BORDER_COLORS[a]}55` : 'none',
                    }}
                  >
                    {count}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    </section>
  )
}
