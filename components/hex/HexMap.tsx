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

type CellKey = string // "b-a"
type Selections = Record<Timeframe, Set<CellKey>>

const emptySelections = (): Selections => ({
  daily: new Set(),
  weekly: new Set(),
  monthly: new Set(),
})

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
  const [selections, setSelections] = useState<Selections>(emptySelections)
  const [selectedMarketCapRange, setSelectedMarketCapRange] = useState<string>('all')

  // 選択数の合計（任意のセルが1つでも選ばれているか）
  const totalSelectedCells = selections.daily.size + selections.weekly.size + selections.monthly.size
  const hasSelection = totalSelectedCells > 0

  // 各 TF の選択（OR 条件）に全て該当する銘柄集合を計算する。
  // タイムフレーム間は AND（その TF に選択が無ければ無視）。
  const filteredTickers = useMemo<Set<string>>(() => {
    if (!hasSelection) return new Set(data.map((d) => d.code))
    const tfs: Timeframe[] = ['daily', 'weekly', 'monthly']
    const result = new Set<string>()
    for (const d of data) {
      let pass = true
      for (const tf of tfs) {
        const sel = selections[tf]
        if (sel.size === 0) continue
        const a = d[`${tf}_a_stage` as keyof Stock] as number | null | undefined
        const b = d[`${tf}_b_stage` as keyof Stock] as number | null | undefined
        if (a == null || b == null) { pass = false; break }
        if (!sel.has(`${b}-${a}`)) { pass = false; break }
      }
      if (pass) result.add(d.code)
    }
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selections, hasSelection])
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

  // ステージ選択 + 時価総額 + 検索 すべてで絞り込み、時価総額降順でソート
  const visible = useMemo(() => {
    return data
      .filter((s) => {
        if (hasSelection && !filteredTickers.has(s.code)) return false
        if (!filterByMarketCap(s)) return false
        if (searchTerm && !s.code.includes(searchTerm) && !s.name.includes(searchTerm)) return false
        return true
      })
      .sort((a, b) => b.market_cap - a.market_cap)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, filteredTickers, hasSelection, selectedMarketCapRange, searchTerm])

  const toggleCell = (tf: Timeframe, b: number, a: number, count: number) => {
    if (count === 0) return
    const key = `${b}-${a}`
    setSelections((cur) => {
      const nextSet = new Set(cur[tf])
      if (nextSet.has(key)) nextSet.delete(key)
      else nextSet.add(key)
      return { ...cur, [tf]: nextSet }
    })
  }

  const clearAllSelections = () => setSelections(emptySelections())
  const clearTimeframeSelections = (tf: Timeframe) =>
    setSelections((cur) => ({ ...cur, [tf]: new Set<CellKey>() }))

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
            selectedCells={selections[tf.key]}
            filteredTickers={filteredTickers}
            anySelection={hasSelection}
            onCellClick={(b, a, count) => toggleCell(tf.key, b, a, count)}
            onClearTimeframe={() => clearTimeframeSelections(tf.key)}
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
          <span className="text-xs text-gray-500 flex items-center flex-wrap gap-2">
            <span className="whitespace-nowrap">
              <strong className="text-indigo-600 text-base font-bold">{visible.length.toLocaleString()}</strong> 件該当
            </span>
            {hasSelection && (
              <>
                <span className="text-gray-300">|</span>
                {(['daily', 'weekly', 'monthly'] as Timeframe[]).map((tf) => {
                  const n = selections[tf].size
                  if (n === 0) return null
                  const label = TIMEFRAMES.find((t) => t.key === tf)?.label
                  return (
                    <span
                      key={tf}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full whitespace-nowrap"
                    >
                      {label} <strong>{n}</strong>
                    </span>
                  )
                })}
                <button
                  onClick={clearAllSelections}
                  className="px-2 py-0.5 text-[10px] border border-gray-300 rounded-full hover:bg-gray-50"
                >
                  × 全クリア
                </button>
              </>
            )}
            {selectedMarketCapRange !== 'all' && (
              <>
                <span className="text-gray-300">|</span>
                <span>{MARKET_CAP_RANGES.find((r) => r.id === selectedMarketCapRange)?.label}</span>
              </>
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
  data, timeframe, label, selectedCells, filteredTickers, anySelection, onCellClick, onClearTimeframe,
}: {
  data: Stock[]
  timeframe: Timeframe
  label: string
  /** このタイムフレームで選択されているセルの "b-a" キー集合 */
  selectedCells: Set<CellKey>
  /** 全タイムフレーム条件を AND した結果のティッカー集合 */
  filteredTickers: Set<string>
  /** いずれかの TF にセル選択があるか */
  anySelection: boolean
  onCellClick: (b: number, a: number, count: number) => void
  onClearTimeframe: () => void
}) {
  // matrix[b][a] = { count: そのセルの全銘柄数, sel: フィルタ通過銘柄のうちこのセルに入る数 }
  const { matrix, total } = useMemo(() => {
    const m: { count: number; sel: number }[][] =
      Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => ({ count: 0, sel: 0 })))
    let t = 0
    const aField = `${timeframe}_a_stage` as keyof Stock
    const bField = `${timeframe}_b_stage` as keyof Stock
    for (const d of data) {
      const a = d[aField] as number | null | undefined
      const b = d[bField] as number | null | undefined
      if (a == null || b == null) continue
      if (a < 1 || a > 6 || b < 1 || b > 6) continue
      m[b][a].count++
      t++
      if (filteredTickers.has(d.code)) m[b][a].sel++
    }
    return { matrix: m, total: t }
  }, [data, timeframe, filteredTickers])

  return (
    <section className="bg-white border border-gray-200 rounded-lg p-3">
      <header className="flex items-center justify-between mb-3 flex-wrap gap-x-4 gap-y-2">
        {/* 左: タイトル + 選択状態チップ */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-baseline gap-1.5">
            <h3 className="text-base font-bold text-gray-900">{label}</h3>
            <span className="text-[10px] text-gray-400 font-mono">B × A</span>
          </div>
          {selectedCells.size > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-500"
                aria-hidden
              />
              {selectedCells.size} セル選択中
              <button
                onClick={onClearTimeframe}
                className="text-indigo-400 hover:text-indigo-700 -mr-0.5 px-1"
                title={`${label} の選択をクリア`}
              >
                ×
              </button>
            </span>
          ) : anySelection ? (
            <span className="text-[11px] text-gray-500 bg-gray-50 border border-gray-200 px-2 py-0.5 rounded-full">
              連動表示
            </span>
          ) : null}
        </div>

        {/* 右: 銘柄合計 */}
        <span className="text-[11px] text-gray-500 whitespace-nowrap">
          <strong className="text-indigo-600 font-mono text-sm">{data.length.toLocaleString()}</strong> 銘柄
          {total < data.length && (
            <span
              className="ml-1.5 text-gray-400"
              title={`${data.length - total} 銘柄は ${label} のステージが計算できないため除外`}
            >
              （分類可 {total.toLocaleString()}）
            </span>
          )}
        </span>
      </header>

      {/* 横スクロール可能な内側ラッパ。狭幅の画面でも A1〜A6 が切れず表示される */}
      <div className="overflow-x-auto">
      <div style={{ minWidth: '760px' }}>

      {/* A-Stage ヘッダ行 */}
      <div className="grid gap-1 mb-1" style={{ gridTemplateColumns: '90px repeat(6, minmax(96px, 1fr))' }}>
        <div></div>
        {[1, 2, 3, 4, 5, 6].map((a) => (
          <div key={a} className="text-center text-[10px] font-mono whitespace-nowrap">
            <span className="font-bold" style={{ color: STAGE_BORDER_COLORS[a] }}>A{a}</span>
            <span className="text-gray-400 ml-1">{STAGE_LABELS[a]}</span>
          </div>
        ))}
      </div>

      {/* B-Stage 行 */}
      <div className="flex flex-col gap-1">
        {[1, 2, 3, 4, 5, 6].map((b) => (
          <div
            key={b}
            className="grid gap-1"
            style={{
              gridTemplateColumns: '90px repeat(6, minmax(96px, 1fr))',
              background: STAGE_BG_COLORS[b],
              border: `1.5px solid ${STAGE_BORDER_COLORS[b]}`,
              borderRadius: '6px',
              padding: '3px',
            }}
          >
            {/* B-stage ラベル（左の "大きい長方形" の名札部分） */}
            <div
              className="flex flex-col items-center justify-center text-xs font-mono leading-tight"
              style={{ color: STAGE_BORDER_COLORS[b], padding: '4px 2px' }}
            >
              <span className="font-bold text-base">B{b}</span>
              <span className="text-[10px] text-gray-700 mt-0.5 text-center">{STAGE_LABELS[b]}</span>
            </div>

            {/* A1..A6 の細長いセル */}
            {[1, 2, 3, 4, 5, 6].map((a) => {
              const cell = matrix[b][a]
              const count = cell.count
              const sel = cell.sel
              const key: CellKey = `${b}-${a}`
              const isSelected = selectedCells.has(key)
              const empty = count === 0
              const baseColor = STAGE_BORDER_COLORS[a]

              // 表示モード:
              //  empty       : 灰色
              //  isSelected  : 強調（baseColor で塗りつぶし、白文字）
              //  anySelection: 連動モード — sel > 0 を強調、sel = 0 を薄く
              //  通常        : セル色＋件数のみ
              let bg = '#fff'
              let fg: string = baseColor
              let borderColor: string = baseColor
              let opacity = 1
              if (empty) {
                bg = '#fafafa'; fg = '#d1d5db'; borderColor = '#e5e7eb'
              } else if (isSelected) {
                bg = baseColor; fg = '#fff'; borderColor = baseColor
              } else if (anySelection && sel === 0) {
                opacity = 0.3
              } else if (anySelection && sel > 0) {
                bg = STAGE_BG_COLORS[a]
              }

              const titleParts: string[] = [`B${b} × A${a}: ${count} 銘柄`]
              if (anySelection) titleParts.push(`条件該当: ${sel} 銘柄`)

              return (
                <button
                  key={a}
                  onClick={() => onCellClick(b, a, count)}
                  disabled={empty}
                  title={titleParts.join(' / ')}
                  style={{
                    background: bg,
                    color: fg,
                    border: `1px solid ${borderColor}`,
                    borderRadius: '4px',
                    padding: '6px 4px',
                    fontFamily: 'var(--font-mono)',
                    cursor: empty ? 'default' : 'pointer',
                    transition: 'box-shadow 0.1s, opacity 0.15s',
                    boxShadow: isSelected ? `0 2px 8px ${baseColor}66, inset 0 0 0 2px ${baseColor}` : 'none',
                    opacity,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0px',
                    lineHeight: 1.0,
                    minHeight: '46px',
                  }}
                >
                  {anySelection && !isSelected && !empty ? (
                    sel > 0 ? (
                      <>
                        <span style={{ fontSize: '20px', fontWeight: 800 }}>{sel}</span>
                        <span style={{ fontSize: '10px', opacity: 0.65 }}>/ {count}</span>
                      </>
                    ) : (
                      // 0件の場合は数字を出さず、薄く - のみ表示してノイズを減らす
                      <span style={{ fontSize: '14px', fontWeight: 600, opacity: 0.5 }}>—</span>
                    )
                  ) : (
                    <span style={{ fontSize: '22px', fontWeight: 800 }}>{count}</span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      </div>
      </div>
    </section>
  )
}
