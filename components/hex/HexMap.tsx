// components/hex/HexMap.tsx
// HEX ステージスクリーナー。日足 / 週足 / 月足 の 6×6 (Bステージ × Aステージ) 行列で絞り込み、
// 下の Scan Ledger（銘柄 | 価格 | 騰落 | Stage | トレンド）で比較する。
// このファイルは状態と絞り込みの orchestration のみを持ち、表示は stage-screener/ 配下が担う。

'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { replaceCurrentUrlFilters } from '@/lib/client/url-filter-state'
import ResultsLedger from '@/components/hex/stage-screener/ResultsTable'
import ResultsToolbar, { type CellChip } from '@/components/hex/stage-screener/ResultsToolbar'
import StageMatrixPanel, {
  TIMEFRAMES,
  type CellKey,
  type Selections,
  type Timeframe,
} from '@/components/hex/stage-screener/StageMatrixPanel'
import ledger from '@/components/hex/stage-screener/screener.module.css'
import {
  compareStocks,
  EMPTY_EXTRA,
  matchesExtra,
  parseOrder,
  parseSortKey,
  pick,
  DEFAULT_ORDER,
  DEFAULT_SORT,
  type ExtraFilters,
  type SortKey,
  type SortOrder,
} from '@/components/hex/stage-screener/filters'

export interface HexMapStock {
  code: string
  name: string
  sector_large: string
  market_cap: number
  stage: number | null
  sector_small?: string | null
  sector17_name?: string | null
  sector33_name?: string | null
  market_segment?: string | null
  margin_type?: string | null
  price: number | null
  daily_change?: number | null
  weekly_change?: number | null
  monthly_change?: number | null
  months3_change?: number | null
  months6_change?: number | null
  ytd_change?: number | null
  data_status?: 'ready' | 'partial_stage' | 'snapshot_pending' | 'price_pending'
  daily_a_stage?: number | null
  daily_b_stage?: number | null
  weekly_a_stage?: number | null
  weekly_b_stage?: number | null
  monthly_a_stage?: number | null
  monthly_b_stage?: number | null
  sma_angles?: { sma5: number | null; sma25: number | null; sma75: number | null; sma300: number | null }
  prev_sma_angles?: { sma5: number | null; sma25: number | null; sma75: number | null; sma300: number | null }
  ml_candidate_direction?: 'up' | 'down' | null
  ml_candidate_rank?: number | null
  ml_candidate_summary?: string | null
}

const emptySelections = (): Selections => ({
  daily: new Set(),
  weekly: new Set(),
  monthly: new Set(),
})

const CELL_FILTER_PARAMS: Record<Timeframe, string> = {
  daily: 'dailyCells',
  weekly: 'weeklyCells',
  monthly: 'monthlyCells',
}

function parseCellSelection(value: string | null): Set<CellKey> {
  if (!value) return new Set()
  return new Set(value.split(',').filter((key) => /^[1-6]-[1-6]$/.test(key)))
}

function initialSelections(searchParams: ReturnType<typeof useSearchParams>): Selections {
  return {
    daily: parseCellSelection(searchParams.get(CELL_FILTER_PARAMS.daily)),
    weekly: parseCellSelection(searchParams.get(CELL_FILTER_PARAMS.weekly)),
    monthly: parseCellSelection(searchParams.get(CELL_FILTER_PARAMS.monthly)),
  }
}

const MARKET_CAP_RANGES: { id: string; label: string }[] = [
  { id: 'all',      label: '全て' },
  { id: '-50',      label: '〜50億' },
  { id: '50-100',   label: '50〜100億' },
  { id: '100-300',  label: '100〜300億' },
  { id: '300-1000', label: '300〜1,000億' },
  { id: '1000-',    label: '1,000億〜' },
]
const US_MARKET_CAP_RANGES: { id: string; label: string }[] = [
  { id: 'all', label: '全て' },
  { id: '-300m', label: '〜$300M' },
  { id: '300m-2b', label: '$300M〜$2B' },
  { id: '2b-10b', label: '$2B〜$10B' },
  { id: '10b-200b', label: '$10B〜$200B' },
  { id: '200b-', label: '$200B〜' },
]

// 銘柄テーブルの初期表示件数 /「もっと見る」増分。4,000+ 行の一括描画を避ける。
const ROW_STEP = 100

export default function HexMap({ data, market = 'JP' }: { data: HexMapStock[]; timeframe?: Timeframe; market?: 'JP' | 'US' }) {
  const isUs = market === 'US'
  const router = useRouter()
  const searchParams = useSearchParams()
  const marketCapRanges = isUs ? US_MARKET_CAP_RANGES : MARKET_CAP_RANGES
  const [copiedCode, setCopiedCode] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState(() => searchParams.get('q') ?? '')
  const [selections, setSelections] = useState<Selections>(() => initialSelections(searchParams))
  const [selectedMarketCapRange, setSelectedMarketCapRange] = useState<string>(() => {
    const value = searchParams.get('marketCap') ?? 'all'
    return marketCapRanges.some((range) => range.id === value) ? value : 'all'
  })
  const [extra, setExtra] = useState<ExtraFilters>(() => ({
    segment: searchParams.get('seg') ?? '',
    margin: isUs ? '' : searchParams.get('margin') ?? '',
    change: pick(searchParams.get('chg'), ['', 'up', 'down'] as const, ''),
    ma: pick(searchParams.get('ma'), ['', 'up', 'down'] as const, ''),
    ml: pick(searchParams.get('ml'), ['', 'any', 'up', 'down'] as const, ''),
    status: isUs ? pick(searchParams.get('status'), ['', 'ready', 'pending'] as const, '') : '',
  }))
  const [sortKey, setSortKey] = useState<SortKey>(() => parseSortKey(searchParams.get('sort')))
  const [sortOrder, setSortOrder] = useState<SortOrder>(() => parseOrder(searchParams.get('order')))
  const [rowLimit, setRowLimit] = useState(ROW_STEP)
  const hasMarketCapData = data.some((stock) => stock.market_cap > 0)

  useEffect(() => {
    replaceCurrentUrlFilters({
      seg: extra.segment,
      margin: extra.margin,
      chg: extra.change,
      ma: extra.ma,
      ml: extra.ml,
      status: extra.status,
      sort: sortKey === DEFAULT_SORT ? null : sortKey,
      order: sortOrder === DEFAULT_ORDER && sortKey !== 'code' ? null : sortOrder,
    })
  }, [extra, sortKey, sortOrder])

  useEffect(() => {
    replaceCurrentUrlFilters({
      q: searchTerm.trim(),
      marketCap: selectedMarketCapRange === 'all' ? null : selectedMarketCapRange,
      [CELL_FILTER_PARAMS.daily]: Array.from(selections.daily).sort().join(','),
      [CELL_FILTER_PARAMS.weekly]: Array.from(selections.weekly).sort().join(','),
      [CELL_FILTER_PARAMS.monthly]: Array.from(selections.monthly).sort().join(','),
    })
  }, [searchTerm, selectedMarketCapRange, selections])

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
        const a = d[`${tf}_a_stage` as keyof HexMapStock] as number | null | undefined
        const b = d[`${tf}_b_stage` as keyof HexMapStock] as number | null | undefined
        if (a == null || b == null) { pass = false; break }
        if (!sel.has(`${b}-${a}`)) { pass = false; break }
      }
      if (pass) result.add(d.code)
    }
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selections, hasSelection])
  const filterByMarketCap = (stock: HexMapStock) => {
    if (isUs) {
      const val = stock.market_cap
      switch (selectedMarketCapRange) {
        case '-300m': return val > 0 && val < 300e6
        case '300m-2b': return val >= 300e6 && val < 2e9
        case '2b-10b': return val >= 2e9 && val < 10e9
        case '10b-200b': return val >= 10e9 && val < 200e9
        case '200b-': return val >= 200e9
        default: return true
      }
    }
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

  const segmentOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of data) if (s.market_segment) counts.set(s.market_segment, (counts.get(s.market_segment) ?? 0) + 1)
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [data])
  const marginOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of data) if (s.margin_type) counts.set(s.margin_type, (counts.get(s.margin_type) ?? 0) + 1)
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [data])

  // ステージ選択 + 時価総額 + 検索 + 追加条件 すべてで絞り込み、選択した軸で並び替え（既定: 時価総額降順）
  const visible = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    return data
      .filter((s) => {
        if (hasSelection && !filteredTickers.has(s.code)) return false
        if (!filterByMarketCap(s)) return false
        if (term && !s.code.toLowerCase().includes(term) && !s.name.toLowerCase().includes(term)) return false
        if (!matchesExtra(s, extra)) return false
        return true
      })
      .sort((a, b) => compareStocks(a, b, sortKey, sortOrder))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, filteredTickers, hasSelection, selectedMarketCapRange, searchTerm, extra, sortKey, sortOrder])

  // フィルタ変更で結果が変わったら表示件数を初期値に戻す
  useEffect(() => { setRowLimit(ROW_STEP) }, [visible])

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

  const clearTimeframeSelections = (tf: Timeframe) =>
    setSelections((cur) => ({ ...cur, [tf]: new Set<CellKey>() }))
  const clearEverything = () => {
    setSelections(emptySelections())
    setSearchTerm('')
    setSelectedMarketCapRange('all')
    setExtra(EMPTY_EXTRA)
  }
  const cellChips: CellChip[] = (['daily', 'weekly', 'monthly'] as Timeframe[])
    .filter((tf) => selections[tf].size > 0)
    .map((tf) => ({ key: tf, label: TIMEFRAMES.find((t) => t.key === tf)?.label ?? tf, count: selections[tf].size }))
  const handleCopy = (code: string) => {
    navigator.clipboard?.writeText(code)
    setCopiedCode(code)
    setTimeout(() => setCopiedCode((cur) => (cur === code ? null : cur)), 1500)
  }
  const handleSort = (key: SortKey) => {
    setSortKey(key)
    setSortOrder(key === 'code' ? 'asc' : 'desc')
  }
  // 見出しクリック: 同じ列なら昇降を反転、別の列なら既定の向きで並び替え
  const handleHeaderSort = (key: SortKey) => {
    if (key === sortKey) setSortOrder((o) => (o === 'desc' ? 'asc' : 'desc'))
    else handleSort(key)
  }

  return (
    <div className="flex flex-col gap-4">
      {/* B×A ステージ行列（≥1024 は 3 時間軸を横並びで同時比較） */}
      <StageMatrixPanel
        data={data}
        selections={selections}
        filteredTickers={filteredTickers}
        anySelection={hasSelection}
        onToggle={toggleCell}
        onClearTimeframe={clearTimeframeSelections}
      />

      {/* 結果面: command bar → ledger header → rows を 1 枚の面で接続 */}
      <div className={ledger.surface}>
        <ResultsToolbar
          isUs={isUs}
          searchTerm={searchTerm}
          onSearch={setSearchTerm}
          marketCap={selectedMarketCapRange}
          marketCapRanges={marketCapRanges}
          hasMarketCapData={hasMarketCapData}
          onMarketCap={setSelectedMarketCapRange}
          sortKey={sortKey}
          sortOrder={sortOrder}
          onSort={handleSort}
          onToggleOrder={() => setSortOrder((o) => (o === 'desc' ? 'asc' : 'desc'))}
          extra={extra}
          onExtra={(patch) => setExtra((cur) => ({ ...cur, ...patch }))}
          segmentOptions={segmentOptions}
          marginOptions={marginOptions}
          cellChips={cellChips}
          onClearCell={(key) => clearTimeframeSelections(key as Timeframe)}
          resultCount={visible.length}
          totalCount={data.length}
          onClearAll={clearEverything}
        />

        {visible.length > 0 ? (
          <ResultsLedger
            rows={visible.slice(0, rowLimit)}
            isUs={isUs}
            copiedCode={copiedCode}
            onCopy={handleCopy}
            onOpen={(code) => router.push(`${isUs ? '/us/stock' : '/stock'}/${encodeURIComponent(code)}`)}
            sortKey={sortKey}
            sortOrder={sortOrder}
            onHeaderSort={handleHeaderSort}
          />
        ) : (
          <div role="status" className={ledger.empty}>
            <span>
              {searchTerm.trim()
                ? `"${searchTerm.trim()}" に一致する銘柄が見つかりませんでした`
                : '該当する銘柄がありません'}
            </span>
            <button type="button" onClick={clearEverything} className={ledger.emptyBtn}>
              条件をすべてクリア
            </button>
          </div>
        )}
        {visible.length > rowLimit && (
          <button type="button" onClick={() => setRowLimit((n) => n + ROW_STEP)} className={ledger.more}>
            さらに表示（{rowLimit.toLocaleString()} / {visible.length.toLocaleString()} 件 · 残り {(visible.length - rowLimit).toLocaleString()} 件）
          </button>
        )}
      </div>
    </div>
  )
}
