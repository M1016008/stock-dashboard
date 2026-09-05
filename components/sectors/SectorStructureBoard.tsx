'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ChevronDown, ChevronRight, ExternalLink, Filter, Hexagon, LoaderCircle, RotateCcw, Search, SlidersHorizontal } from 'lucide-react'
import { StageTag } from '@/components/ui/StageTag'
import { StockPreviewTrigger } from '@/components/stock-preview/StockPreviewTrigger'
import { STAGE_BORDER_COLORS, type StageLevel } from '@/lib/hex-stage'
import {
  SECTOR_STRUCTURE_AXES,
  TREND_STRUCTURE_BANDS,
  trendStructureBand,
  type TrendStructureBand,
  type SectorStructureAxisKey,
  type SectorStructureTaxonomy,
} from '@/lib/sector-structure'
import { SECTOR_STAGE_LEVELS } from '@/lib/sector-stage-distribution'
import type {
  SectorStageConstituentItem,
  SectorStageConstituentPage,
} from '@/lib/queries/sector-stage-distribution'
import type {
  SectorStructureBoard as SectorStructureBoardData,
  SectorStructureRow,
} from '@/lib/queries/sectors'
import {
  SECTOR_DECISION_PRESETS,
  SECTOR_CONSTITUENT_PRESETS,
  type SectorConstituentPreset,
  type SectorFilteredConstituent,
  type SectorFilteredConstituentPage,
  type SectorMaDirection,
  type SectorMaOrder,
} from '@/lib/sector-constituents'

const GROUP_BATCH_SIZE = 60

const TAXONOMY_META: Record<
  SectorStructureTaxonomy,
  { family: 'shikiho' | 'jquants'; familyLabel: string; levelLabel: string }
> = {
  major: { family: 'shikiho', familyLabel: '四季報', levelLabel: '大分類' },
  subIndustry: { family: 'shikiho', familyLabel: '四季報', levelLabel: '細分類' },
  '17': { family: 'jquants', familyLabel: 'J-Quants', levelLabel: '17業種' },
  '33': { family: 'jquants', familyLabel: 'J-Quants', levelLabel: '33業種' },
}

type SelectedCell = { axis: SectorStructureAxisKey; stage: StageLevel }
type StructureRankMode = 'strong' | 'weak' | 'improving' | 'deteriorating'
type StageFilters = Partial<Record<SectorStructureAxisKey, StageLevel[]>>

type SectorMasterLookup = {
  eligible?: boolean
  master?: {
    name?: string | null
    sector17_code?: string | null
    sector17_name?: string | null
    sector33_code?: string | null
    sector33_name?: string | null
    major_category?: string | null
    sub_industry?: string | null
  } | null
}

type TickerLookup = {
  query: string
  groupKeys: string[]
  stockName: string | null
  outsideUniverse: boolean
  loading: boolean
}

function rowMatchesSearch(row: SectorStructureRow, needle: string) {
  return row.groupName.toLocaleLowerCase('ja-JP').includes(needle)
    || row.groupKey.toLocaleLowerCase('ja-JP').includes(needle)
    || row.parentGroup?.toLocaleLowerCase('ja-JP').includes(needle)
}

function tickerGroupKeys(taxonomy: SectorStructureTaxonomy, master: NonNullable<SectorMasterLookup['master']>) {
  const values = taxonomy === '17'
    ? [master.sector17_code, master.sector17_name]
    : taxonomy === '33'
      ? [master.sector33_code, master.sector33_name]
      : taxonomy === 'major'
        ? [master.major_category]
        : [
            master.major_category && master.sub_industry
              ? `${master.major_category}\u001f${master.sub_industry}`
              : null,
            master.sub_industry,
          ]
  return values.filter((value): value is string => Boolean(value))
}

function structureHref({
  taxonomy,
  groupKey,
  parent,
  universe,
  date,
}: {
  taxonomy: SectorStructureTaxonomy
  groupKey?: string | null
  parent?: string | null
  universe?: SectorStructureBoardData['universe']
  date?: string | null
}) {
  const params = new URLSearchParams({ view: 'structure', structureTaxonomy: taxonomy })
  if (groupKey) params.set('structureGroup', groupKey)
  if (parent) params.set('structureParent', parent)
  if (universe) params.set('universe', universe)
  if (date) params.set('date', date)
  return `/sectors?${params.toString()}#sector-structure`
}

function fmt(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toFixed(digits)
}

function fmtPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function fmtChange(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function boundedInputValue(value: string, min = -Infinity, max = Infinity) {
  const trimmed = value.trim()
  if (!trimmed) return null
  const numeric = Number(trimmed)
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : null
}

function changeTone(value: number | null | undefined) {
  if ((value ?? 0) > 0) return 'text-[var(--color-price-up)]'
  if ((value ?? 0) < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-tertiary)]'
}

function trendBandTone(band: TrendStructureBand | null | undefined) {
  if (band === 'strong_up' || band === 'up') return 'border-[var(--color-price-up)] text-[var(--color-price-up)]'
  if (band === 'strong_down' || band === 'down') return 'border-[var(--color-price-down)] text-[var(--color-price-down)]'
  return 'border-[var(--color-border-default)] text-[var(--color-text-secondary)]'
}

function TrendStructureBadge({ score, compact = false }: { score: number | null | undefined; compact?: boolean }) {
  const band = trendStructureBand(score)
  return (
    <span className={`inline-flex items-center rounded-[4px] border bg-white font-bold ${trendBandTone(band?.key)} ${compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-1 text-[10px]'}`}>
      {band?.shortLabel ?? '算出待ち'}{score != null ? ` ${score.toFixed(1)}` : ''}
    </span>
  )
}

function TrendStructureMeter({ score }: { score: number | null | undefined }) {
  const bounded = score == null ? null : Math.max(0, Math.min(100, score))
  return (
    <div className="min-w-[210px]">
      <div className="relative h-2 overflow-hidden rounded-[3px] bg-[linear-gradient(90deg,var(--color-price-down)_0%,#dbe4ef_42%,#f4f5f7_50%,#f5d8d6_58%,var(--color-price-up)_100%)]">
        {bounded != null && (
          <span className="absolute top-1/2 h-3 w-1 -translate-x-1/2 -translate-y-1/2 rounded-[1px] bg-[var(--color-brand-950)] shadow-sm" style={{ left: `${bounded}%` }} />
        )}
      </div>
      <div className="mt-1 flex justify-between text-[8px] font-bold text-[var(--color-text-tertiary)]">
        <span>強い下落</span><span>中立</span><span>強い上昇</span>
      </div>
    </div>
  )
}

function MarketEnvironmentStrip({ board }: { board: SectorStructureBoardData }) {
  const environment = board.marketEnvironment
  const tone = environment.tone === 'positive'
    ? 'border-[var(--color-price-up)] text-[var(--color-price-up)]'
    : environment.tone === 'negative'
      ? 'border-[var(--color-price-down)] text-[var(--color-price-down)]'
      : 'border-[var(--color-border-default)] text-[var(--color-brand-800)]'
  return (
    <div className="grid grid-cols-2 border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] sm:grid-cols-[minmax(180px,1.2fr)_repeat(3,minmax(120px,0.7fr))]">
      <div className="col-span-2 flex items-center gap-3 border-b border-[var(--color-border-soft)] px-4 py-3 sm:col-span-1 sm:border-b-0 sm:border-r">
        <Activity size={17} className="shrink-0 text-[var(--color-brand-700)]" />
        <div className="min-w-0">
          <div className="text-[9px] font-bold text-[var(--color-text-tertiary)]">市場環境</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2"><span className={`inline-flex rounded-[4px] border bg-white px-2 py-1 text-[12px] font-bold ${tone}`}>{environment.label}</span><Link href="/market-momentum" className="inline-flex items-center gap-0.5 text-[9px] font-bold text-[var(--color-brand-700)] hover:text-[var(--color-market-red)]">市場詳細<ChevronRight size={11} /></Link></div>
          <div className="mt-1 text-[8px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
            {environment.pmsDate ? `PMS/PFS ${environment.pmsDate} / ${environment.sampleCount}銘柄` : 'PMS/PFS 算出待ち'}
          </div>
        </div>
      </div>
      {[
        ['市場構造', environment.structureScore, 'pt'],
        ['PMSプラス', environment.pmsPositiveRatio, '%'],
        ['PFSプラス', environment.pfsPositiveRatio, '%'],
      ].map(([label, value, suffix]) => (
        <div key={String(label)} className="border-b border-r border-[var(--color-border-soft)] px-4 py-3 last:border-r-0 sm:border-b-0">
          <div className="text-[9px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
          <div className="mt-1 text-[17px] font-bold tabular-nums text-[var(--color-text-primary)]">{typeof value === 'number' ? `${value.toFixed(1)}${suffix}` : '---'}</div>
        </div>
      ))}
    </div>
  )
}

type StructureQuadrant = 'strongImproving' | 'weakImproving' | 'strongDeteriorating' | 'weakDeteriorating'

function structureQuadrant(row: SectorStructureRow): StructureQuadrant {
  const strong = (row.trendStructureScore ?? 50) >= 50
  const improving = (row.momentum10d ?? 0) >= 0
  if (strong && improving) return 'strongImproving'
  if (!strong && improving) return 'weakImproving'
  if (strong) return 'strongDeteriorating'
  return 'weakDeteriorating'
}

const QUADRANT_META: Record<StructureQuadrant, { label: string; action: string }> = {
  strongImproving: { label: '強い × 改善', action: '上昇継続・加速' },
  weakImproving: { label: '弱い × 改善', action: '反転候補' },
  strongDeteriorating: { label: '強い × 悪化', action: '失速警戒' },
  weakDeteriorating: { label: '弱い × 悪化', action: '下落継続' },
}

function IndustryPositionMap({ board, selectedRow }: { board: SectorStructureBoardData; selectedRow: SectorStructureRow }) {
  const maxMomentum = Math.max(1, ...board.rows.map((row) => Math.abs(row.momentum10d ?? 0)))
  const plottedRows = [...board.rows]
    .sort((a, b) => b.nStocks - a.nStocks || Math.abs(b.momentum10d ?? 0) - Math.abs(a.momentum10d ?? 0))
    .slice(0, 60)
  const counts = board.rows.reduce<Record<StructureQuadrant, number>>((result, row) => {
    result[structureQuadrant(row)] += 1
    return result
  }, { strongImproving: 0, weakImproving: 0, strongDeteriorating: 0, weakDeteriorating: 0 })

  return (
    <section className="border-b border-[var(--color-border-default)] bg-white">
      <div className="flex flex-col gap-2 border-b border-[var(--color-border-soft)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-[12px] font-bold text-[var(--color-brand-900)]">業種の現在地</h3>
          <p className="mt-0.5 text-[9px] font-semibold text-[var(--color-text-tertiary)]">横: トレンド構造 / 縦: 10日改善度 / 円: 構成銘柄数</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(QUADRANT_META) as StructureQuadrant[]).map((key) => (
            <span key={key} className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2 py-1 text-[9px] font-bold text-[var(--color-text-secondary)]">{QUADRANT_META[key].action} {counts[key]}</span>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto p-3 sm:p-4">
        <div className="relative h-[300px] min-w-[620px] overflow-hidden rounded-[6px] border border-[var(--color-border-default)] bg-[linear-gradient(90deg,rgba(37,99,235,0.035)_0_50%,rgba(220,38,38,0.035)_50%_100%)]">
          <span className="absolute left-1/2 top-0 h-full border-l border-dashed border-[var(--color-border-default)]" />
          <span className="absolute left-0 top-1/2 w-full border-t border-dashed border-[var(--color-border-default)]" />
          <span className="absolute left-3 top-2 text-[9px] font-bold text-[var(--color-text-tertiary)]">反転候補</span>
          <span className="absolute right-3 top-2 text-[9px] font-bold text-[var(--color-text-tertiary)]">上昇継続・加速</span>
          <span className="absolute bottom-2 left-3 text-[9px] font-bold text-[var(--color-text-tertiary)]">下落継続</span>
          <span className="absolute bottom-2 right-3 text-[9px] font-bold text-[var(--color-text-tertiary)]">失速警戒</span>
          {plottedRows.map((row) => {
            const left = 4 + Math.max(0, Math.min(100, row.trendStructureScore ?? 50)) * 0.92
            const top = 50 - Math.max(-1, Math.min(1, (row.momentum10d ?? 0) / maxMomentum)) * 42
            const size = 18 + Math.min(20, Math.sqrt(Math.max(1, row.nStocks)) * 2.2)
            const positive = (row.trendStructureScore ?? 50) >= 50
            const selected = row.groupKey === selectedRow.groupKey
            return (
              <Link
                key={row.groupKey}
                href={structureHref({ taxonomy: board.taxonomy, groupKey: row.groupKey, parent: board.parentFilter, universe: board.universe, date: board.requestedDate })}
                prefetch={false}
                title={`${row.groupName}: 構造${fmt(row.trendStructureScore)} / 10日${fmt(row.momentum10d)} / ${row.nStocks}銘柄`}
                aria-label={`${row.groupName}を選択`}
                className={`absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border text-[8px] font-bold shadow-sm transition-transform hover:z-20 hover:scale-110 ${selected ? 'z-10 border-[var(--color-brand-950)] ring-2 ring-[var(--color-brand-500)] ring-offset-1' : positive ? 'border-[var(--color-price-up)]' : 'border-[var(--color-price-down)]'}`}
                style={{ left: `${left}%`, top: `${top}%`, width: size, height: size, backgroundColor: positive ? 'rgba(220,38,38,0.72)' : 'rgba(37,99,235,0.68)', color: 'white' }}
              >
                {selected ? row.groupName.slice(0, 4) : ''}
              </Link>
            )
          })}
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[8px] font-bold text-[var(--color-text-tertiary)]">弱い ← トレンド構造 → 強い</div>
          <div className="absolute left-1 top-1/2 -translate-y-1/2 -rotate-90 text-[8px] font-bold text-[var(--color-text-tertiary)]">悪化 ← 10日変化 → 改善</div>
        </div>
      </div>
    </section>
  )
}

function deltaLabel(value: number) {
  if (value > 0) return `▲ +${value}`
  if (value < 0) return `▼ ${value}`
  return '±0'
}

function stageBackground(stage: StageLevel, share: number, compact = false) {
  const hex = STAGE_BORDER_COLORS[stage]
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  const alpha = compact
    ? 0.08 + Math.min(1, share) * 0.72
    : 0.055 + Math.min(1, share) * 0.52
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`
}

function axisTotal(row: SectorStructureRow, axis: SectorStructureAxisKey) {
  return SECTOR_STAGE_LEVELS.reduce((sum, stage) => sum + row.composition[axis][stage], 0)
}

function TinyDistribution({ row }: { row: SectorStructureRow }) {
  return (
    <div className="grid w-[78px] grid-cols-6 gap-[2px]" aria-hidden="true">
      {SECTOR_STRUCTURE_AXES.flatMap((axis) => {
        const total = axisTotal(row, axis.key)
        return SECTOR_STAGE_LEVELS.map((stage) => {
          const count = row.composition[axis.key][stage]
          return (
            <span
              key={`${axis.key}-${stage}`}
              className="h-[7px] rounded-[1px]"
              style={{ backgroundColor: stageBackground(stage, total > 0 ? count / total : 0, true) }}
            />
          )
        })
      })}
    </div>
  )
}

function DominantChange({ row }: { row: SectorStructureRow }) {
  const change = row.dominantChange
  if (!change) {
    return <span className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">最大変化 ±0</span>
  }
  return (
    <span className={`text-[10px] font-bold tabular-nums ${changeTone(change.delta)}`}>
      {change.axisLabel} S{change.stage} {deltaLabel(change.delta)}
    </span>
  )
}

function StageCode({ code }: { code: string | null | undefined }) {
  if (!code) return <span className="text-[10px] font-bold text-[var(--color-text-tertiary)]">------</span>
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`6桁ステージ ${code}`}>
      {code.split('').slice(0, 6).map((digit, index) => (
        <StageTag key={`${digit}-${index}`} stage={Number(digit)} size="xs" />
      ))}
    </span>
  )
}

function ConstituentList({
  board,
  selectedCell,
  selectedRow,
  page,
  loading,
  loadingMore,
  error,
  onLoadMore,
}: {
  board: SectorStructureBoardData
  selectedCell: SelectedCell | null
  selectedRow: SectorStructureRow
  page: SectorStageConstituentPage | null
  loading: boolean
  loadingMore: boolean
  error: string | null
  onLoadMore: () => void
}) {
  const axis = selectedCell
    ? SECTOR_STRUCTURE_AXES.find((item) => item.key === selectedCell.axis)
    : null

  return (
    <aside className="min-w-0 border-t border-[var(--color-border-default)] bg-white 2xl:border-l 2xl:border-t-0">
      <div className="flex min-h-[72px] items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-bold text-[var(--color-brand-900)]">
            {selectedCell ? `${axis?.label} Stage ${selectedCell.stage} の銘柄` : 'ヒートマップから銘柄を見る'}
          </h3>
          <p className="mt-0.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
            {selectedCell ? `${selectedRow.groupName}で選択したセルの構成銘柄` : '確認したい時間軸とStageのセルを選択'}
          </p>
        </div>
        {page && <span className="shrink-0 text-[11px] font-bold tabular-nums text-[var(--color-text-secondary)]">{page.total}銘柄</span>}
      </div>

      {!selectedCell && (
        <div className="flex min-h-[220px] items-center justify-center px-5 text-center text-[12px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">
          ヒートマップのセルを選ぶと、該当する銘柄だけを取得して表示します。
        </div>
      )}
      {loading && (
        <div className="flex min-h-[220px] items-center justify-center gap-2 text-[12px] font-bold text-[var(--color-text-secondary)]">
          <LoaderCircle size={16} className="animate-spin" />読み込み中
        </div>
      )}
      {error && !loading && (
        <div className="m-4 rounded-[6px] border border-[var(--color-price-down)] bg-[rgba(37,99,235,0.05)] px-3 py-4 text-[12px] font-semibold text-[var(--color-price-down)]">
          {error}
        </div>
      )}
      {page && !loading && !error && (
        <div>
          <div className="divide-y divide-[var(--color-border-soft)]">
            {page.items.map((item: SectorStageConstituentItem) => (
              <Link
                key={item.ticker}
                href={sectorStockHref(item.ticker, board, selectedRow)}
                className="block px-4 py-2.5 hover:bg-[var(--color-surface-subtle)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-bold tabular-nums text-[var(--color-brand-800)]">{item.ticker}</span>
                      <span className="truncate text-[11px] font-semibold text-[var(--color-text-primary)]">{item.name ?? '名称未登録'}</span>
                    </div>
                    <div className="mt-1"><StageCode code={item.stageCode} /></div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[11px] font-bold tabular-nums text-[var(--color-text-primary)]">{fmtPrice(item.price)}</div>
                    <div className={`mt-0.5 text-[10px] font-bold tabular-nums ${changeTone(item.changePct)}`}>{fmtChange(item.changePct)}</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
          {page.items.length === 0 && (
            <div className="px-4 py-8 text-center text-[12px] font-semibold text-[var(--color-text-tertiary)]">選択した業種・時間軸・Stageに属する銘柄はありません。</div>
          )}
          {page.nextCursor && (
            <div className="border-t border-[var(--color-border-soft)] p-3">
              <button
                type="button"
                onClick={onLoadMore}
                disabled={loadingMore}
                className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-[6px] border border-[var(--color-border-default)] bg-white text-[11px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)] disabled:opacity-50"
              >
                {loadingMore && <LoaderCircle size={14} className="animate-spin" />}
                次の50件を表示
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  )
}

const MA_ORDER_LABELS: Record<Exclude<SectorMaOrder, 'all'>, string> = {
  bullish: '上昇順行',
  bearish: '下降逆行',
  converging: '収束',
  other: 'その他',
}

function shortTermBadgeTone(tone: SectorFilteredConstituent['shortTermCheckTone']) {
  if (tone === 'bullish' || tone === 'positive') return 'border-[var(--color-price-up)] text-[var(--color-price-up)]'
  if (tone === 'bearish' || tone === 'weak') return 'border-[var(--color-price-down)] text-[var(--color-price-down)]'
  return 'border-[var(--color-border-default)] text-[var(--color-text-secondary)]'
}

function sectorStockHref(ticker: string, board: SectorStructureBoardData, selectedRow: SectorStructureRow) {
  const params = new URLSearchParams({
    sectorTaxonomy: board.taxonomy,
    sectorGroup: selectedRow.groupKey,
  })
  if (board.latestDate) params.set('sectorDate', board.latestDate)
  if (board.requestedDate && board.latestDate) params.set('date', board.latestDate)
  if (board.universe) params.set('universe', board.universe)
  return `/stock/${encodeURIComponent(ticker)}?${params.toString()}#overview`
}

function SectorConstituentExplorer({
  board,
  selectedRow,
}: {
  board: SectorStructureBoardData
  selectedRow: SectorStructureRow
}) {
  const [preset, setPreset] = useState<SectorConstituentPreset>('all')
  const [stages, setStages] = useState<StageFilters>({})
  const [maDirection, setMaDirection] = useState<SectorMaDirection>('all')
  const [maMinCount, setMaMinCount] = useState(2)
  const [maOrder, setMaOrder] = useState<SectorMaOrder>('all')
  const [scoreMin, setScoreMin] = useState('')
  const [scoreMax, setScoreMax] = useState('')
  const [changeMin, setChangeMin] = useState('')
  const [changeMax, setChangeMax] = useState('')
  const [marketCapMinOku, setMarketCapMinOku] = useState('')
  const [volumeMin, setVolumeMin] = useState('')
  const [sort, setSort] = useState<'strategyMatch' | 'trendScore' | 'changePct' | 'marketCap' | 'ticker'>('strategyMatch')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [page, setPage] = useState<SectorFilteredConstituentPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const filterKey = JSON.stringify({
    preset,
    stages,
    maDirection,
    maMinCount,
    maOrder,
    scoreMin,
    scoreMax,
    changeMin,
    changeMax,
    marketCapMinOku,
    volumeMin,
    sort,
    sortDir,
  })

  function buildParams(offset = 0) {
    const params = new URLSearchParams({
      taxonomy: board.taxonomy,
      groupKey: selectedRow.groupKey,
      preset,
      maDirection,
      maMinCount: String(maMinCount),
      maOrder,
      sort,
      sortDir,
      offset: String(offset),
    })
    if (board.latestDate) params.set('date', board.latestDate)
    if (board.universe) params.set('universe', board.universe)
    if (selectedRow.trendStructureScore != null) params.set('sectorScore', String(selectedRow.trendStructureScore))
    if (selectedRow.momentum10d != null) params.set('sectorMomentum10d', String(selectedRow.momentum10d))
    if (board.marketTrendStructureScore != null) params.set('marketScore', String(board.marketTrendStructureScore))
    for (const [axis, selected] of Object.entries(stages)) {
      if (selected && selected.length > 0) params.set(axis, selected.join(','))
    }
    const numericFilters = {
      scoreMin: boundedInputValue(scoreMin, 0, 100),
      scoreMax: boundedInputValue(scoreMax, 0, 100),
      changeMin: boundedInputValue(changeMin, -1000, 1000),
      changeMax: boundedInputValue(changeMax, -1000, 1000),
      marketCapMinOku: boundedInputValue(marketCapMinOku, 0),
      volumeMin: boundedInputValue(volumeMin, 0),
    }
    if (numericFilters.scoreMin != null) params.set('scoreMin', String(numericFilters.scoreMin))
    if (numericFilters.scoreMax != null) params.set('scoreMax', String(numericFilters.scoreMax))
    if (numericFilters.changeMin != null) params.set('changeMin', String(numericFilters.changeMin))
    if (numericFilters.changeMax != null) params.set('changeMax', String(numericFilters.changeMax))
    if (numericFilters.marketCapMinOku != null) params.set('marketCapMin', String(numericFilters.marketCapMinOku * 100_000_000))
    if (numericFilters.volumeMin != null) params.set('volumeMin', String(numericFilters.volumeMin))
    return params
  }

  async function load(offset = 0, append = false) {
    if (!board.latestDate) return
    const effectiveScoreMin = boundedInputValue(scoreMin, 0, 100)
    const effectiveScoreMax = boundedInputValue(scoreMax, 0, 100)
    const effectiveChangeMin = boundedInputValue(changeMin, -1000, 1000)
    const effectiveChangeMax = boundedInputValue(changeMax, -1000, 1000)
    if ((effectiveScoreMin != null && effectiveScoreMax != null && effectiveScoreMin > effectiveScoreMax)
      || (effectiveChangeMin != null && effectiveChangeMax != null && effectiveChangeMin > effectiveChangeMax)) {
      requestRef.current?.abort()
      requestRef.current = null
      setPage(null)
      setLoading(false)
      setLoadingMore(false)
      setError('絞り込みの下限は上限以下にしてください。')
      return
    }
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    if (append) setLoadingMore(true)
    else {
      setLoading(true)
      setLoadingMore(false)
    }
    setError(null)
    try {
      const response = await fetch(`/api/sectors/constituents?${buildParams(offset).toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('業種内銘柄を取得できませんでした。')
      const nextPage = await response.json() as SectorFilteredConstituentPage
      if (requestRef.current !== controller) return
      setPage((current) => append && current
        ? { ...nextPage, items: [...current.items, ...nextPage.items] }
        : nextPage)
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      setError(cause instanceof Error ? cause.message : '業種内銘柄を取得できませんでした。')
    } finally {
      if (requestRef.current === controller) {
        if (append) setLoadingMore(false)
        else setLoading(false)
        requestRef.current = null
      }
    }
  }

  useEffect(() => {
    setPage(null)
    const timer = window.setTimeout(() => { void load(0, false) }, 180)
    return () => {
      window.clearTimeout(timer)
      requestRef.current?.abort()
    }
    // filterKey is a stable serialization of all server-side filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.latestDate, board.taxonomy, board.universe, selectedRow.groupKey, filterKey])

  function toggleStage(axis: SectorStructureAxisKey, stage: StageLevel) {
    setStages((current) => {
      const selected = current[axis] ?? []
      const next = selected.includes(stage) ? selected.filter((value) => value !== stage) : [...selected, stage].sort()
      return { ...current, [axis]: next }
    })
  }

  function resetFilters() {
    setPreset('all')
    setStages({})
    setMaDirection('all')
    setMaMinCount(2)
    setMaOrder('all')
    setScoreMin('')
    setScoreMax('')
    setChangeMin('')
    setChangeMax('')
    setMarketCapMinOku('')
    setVolumeMin('')
    setSort('strategyMatch')
    setSortDir('desc')
  }

  const stageConditionCount = Object.values(stages).filter((values) => values && values.length > 0).length
  const stageConditionDescriptions = SECTOR_STRUCTURE_AXES.flatMap((axis) => {
    const selected = stages[axis.key]
    return selected && selected.length > 0
      ? [`${axis.label} S${selected.join('/S')}`]
      : []
  })
  const maOrderLabels: Record<Exclude<SectorMaOrder, 'all'>, string> = {
    bullish: '上昇順行',
    bearish: '下降逆行',
    converging: '収束',
    other: 'その他',
  }
  const numericFilters = {
    scoreMin: boundedInputValue(scoreMin, 0, 100),
    scoreMax: boundedInputValue(scoreMax, 0, 100),
    changeMin: boundedInputValue(changeMin, -1000, 1000),
    changeMax: boundedInputValue(changeMax, -1000, 1000),
    marketCapMinOku: boundedInputValue(marketCapMinOku, 0),
    volumeMin: boundedInputValue(volumeMin, 0),
  }
  const changePeriodLabel = board.requestedDate ? '当日騰落率' : '本日騰落率'
  const marketCapLabel = board.requestedDate ? '時価総額概算' : '時価総額'
  const manualConditionDescriptions = [
    ...stageConditionDescriptions,
    maDirection !== 'all' ? `MA${maDirection === 'up' ? '上向き' : '下向き'}${maMinCount}本以上` : null,
    maOrder !== 'all' ? `MA並び ${maOrderLabels[maOrder]}` : null,
    numericFilters.scoreMin != null || numericFilters.scoreMax != null ? `構造スコア ${numericFilters.scoreMin ?? '下限なし'}〜${numericFilters.scoreMax ?? '上限なし'}` : null,
    numericFilters.changeMin != null || numericFilters.changeMax != null ? `${changePeriodLabel} ${numericFilters.changeMin ?? '下限なし'}%〜${numericFilters.changeMax ?? '上限なし'}%` : null,
    numericFilters.marketCapMinOku != null ? `${marketCapLabel} ${numericFilters.marketCapMinOku}億円以上` : null,
    numericFilters.volumeMin != null ? `出来高 ${numericFilters.volumeMin}株以上` : null,
  ].filter((value): value is string => Boolean(value))
  const activeConditionDescriptions = [
    preset !== 'all' || manualConditionDescriptions.length === 0
      ? SECTOR_CONSTITUENT_PRESETS[preset].description
      : null,
    ...manualConditionDescriptions,
  ].filter((value): value is string => Boolean(value))
  const screenerParams = new URLSearchParams(
    board.taxonomy === '17'
      ? { sector17: selectedRow.groupName }
      : board.taxonomy === '33'
        ? { sector33: selectedRow.groupName }
        : board.taxonomy === 'major'
          ? { majorCategory: selectedRow.groupName }
          : { majorCategory: selectedRow.parentGroup ?? '', subIndustry: selectedRow.groupName },
  )
  const screenerAxisParams: Record<SectorStructureAxisKey, string> = {
    dailyA: 'daily_a', dailyB: 'daily_b', weeklyA: 'weekly_a', weeklyB: 'weekly_b', monthlyA: 'monthly_a', monthlyB: 'monthly_b',
  }
  for (const [axis, selected] of Object.entries(stages)) {
    if (selected && selected.length > 0) screenerParams.set(screenerAxisParams[axis as SectorStructureAxisKey], selected.join(','))
  }
  if (board.latestDate) screenerParams.set('date', board.latestDate)
  if (board.universe) screenerParams.set('universe', board.universe)
  const inputClass = 'h-8 w-full rounded-[5px] border border-[var(--color-border-default)] bg-white px-2 text-[10px] font-semibold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-600)]'

  return (
    <section className="border-t border-[var(--color-border-default)] bg-white">
      <header className="flex flex-col gap-2 border-b border-[var(--color-border-default)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Filter size={14} className="text-[var(--color-brand-700)]" />
            <h3 className="truncate text-[13px] font-bold text-[var(--color-brand-900)]">{selectedRow.groupName}の銘柄を絞り込む</h3>
          </div>
          <p className="mt-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
            抽出条件: {activeConditionDescriptions.join(' / ')} / 軸内OR・軸間AND
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link href={`/screener?${screenerParams.toString()}`} prefetch={false} className="inline-flex h-8 items-center gap-1 rounded-[5px] border border-[var(--color-border-default)] px-2.5 text-[10px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]" title="分類と6軸ステージを引き継いで開く">
            詳細スクリーナー<ExternalLink size={12} />
          </Link>
          <button type="button" onClick={resetFilters} className="inline-flex h-8 items-center gap-1 rounded-[5px] border border-[var(--color-border-default)] px-2.5 text-[10px] font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]">
            <RotateCcw size={12} />リセット
          </button>
        </div>
      </header>

      <div className="border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-3">
        <div className="flex gap-1.5 overflow-x-auto pb-1" aria-label="投資戦略で候補銘柄を切り替え">
          {SECTOR_DECISION_PRESETS.map((value) => {
            const meta = SECTOR_CONSTITUENT_PRESETS[value]
            return (
              <button key={value} type="button" onClick={() => { setPreset(value); setSort('strategyMatch') }} aria-pressed={preset === value} className={`shrink-0 rounded-[5px] border px-3 py-2 text-left ${preset === value ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-800)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:border-[var(--color-brand-500)]'}`}>
                <span className="block text-[10px] font-bold">{meta.label}</span>
                <span className={`mt-0.5 block text-[8px] font-semibold ${preset === value ? 'text-white/75' : 'text-[var(--color-text-tertiary)]'}`}>{meta.description}</span>
              </button>
            )
          })}
        </div>
        <button type="button" onClick={() => setShowAdvanced((value) => !value)} aria-expanded={showAdvanced} className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-[5px] border border-[var(--color-border-default)] bg-white px-2.5 text-[9px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]">
          <SlidersHorizontal size={12} />詳細条件{manualConditionDescriptions.length > 0 ? ` (${manualConditionDescriptions.length})` : ''}<ChevronDown size={12} className={showAdvanced ? 'rotate-180' : ''} />
        </button>

        {showAdvanced && (
          <div className="mt-3 border-t border-[var(--color-border-soft)] pt-3">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7">
              <label className="text-[9px] font-bold text-[var(--color-text-tertiary)]">MA方向<select value={maDirection} onChange={(event) => setMaDirection(event.target.value as SectorMaDirection)} className={`mt-1 ${inputClass}`}><option value="all">指定なし</option><option value="up">上向き</option><option value="down">下向き</option></select></label>
              <label className="text-[9px] font-bold text-[var(--color-text-tertiary)]">MA本数<select value={maMinCount} disabled={maDirection === 'all'} onChange={(event) => setMaMinCount(Number(event.target.value))} className={`mt-1 ${inputClass} disabled:opacity-45`}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}本以上</option>)}</select></label>
              <label className="text-[9px] font-bold text-[var(--color-text-tertiary)]">MA並び<select value={maOrder} onChange={(event) => setMaOrder(event.target.value as SectorMaOrder)} className={`mt-1 ${inputClass}`}><option value="all">指定なし</option><option value="bullish">上昇順行</option><option value="bearish">下降逆行</option><option value="converging">収束</option><option value="other">その他</option></select></label>
              <label className="text-[9px] font-bold text-[var(--color-text-tertiary)]">構造スコア<span className="mt-1 grid grid-cols-2 gap-1"><input type="number" min="0" max="100" value={scoreMin} onChange={(event) => setScoreMin(event.target.value)} inputMode="decimal" placeholder="下限" className={inputClass} /><input type="number" min="0" max="100" value={scoreMax} onChange={(event) => setScoreMax(event.target.value)} inputMode="decimal" placeholder="上限" className={inputClass} /></span></label>
              <label className="text-[9px] font-bold text-[var(--color-text-tertiary)]">{changePeriodLabel}<span className="mt-1 grid grid-cols-2 gap-1"><input type="number" min="-1000" max="1000" value={changeMin} onChange={(event) => setChangeMin(event.target.value)} inputMode="decimal" placeholder="下限%" className={inputClass} /><input type="number" min="-1000" max="1000" value={changeMax} onChange={(event) => setChangeMax(event.target.value)} inputMode="decimal" placeholder="上限%" className={inputClass} /></span></label>
              <label className="text-[9px] font-bold text-[var(--color-text-tertiary)]" title={board.requestedDate ? '基準日の株価と現在登録されている発行済株式数による概算です。' : undefined}>{marketCapLabel}下限<input type="number" min="0" value={marketCapMinOku} onChange={(event) => setMarketCapMinOku(event.target.value)} inputMode="numeric" placeholder="億円" className={`mt-1 ${inputClass}`} /></label>
              <label className="text-[9px] font-bold text-[var(--color-text-tertiary)]">出来高下限<input type="number" min="0" value={volumeMin} onChange={(event) => setVolumeMin(event.target.value)} inputMode="numeric" placeholder="株" className={`mt-1 ${inputClass}`} /></label>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
              {SECTOR_STRUCTURE_AXES.map((axis) => (
                <fieldset key={axis.key} className="min-w-0">
                  <legend className="mb-1 text-[9px] font-bold text-[var(--color-text-tertiary)]">{axis.label}</legend>
                  <div className="grid grid-cols-6 gap-1">{SECTOR_STAGE_LEVELS.map((stage) => { const selected = stages[axis.key]?.includes(stage) ?? false; return <button key={stage} type="button" onClick={() => toggleStage(axis.key, stage)} aria-pressed={selected} className={`h-7 rounded-[4px] border text-[9px] font-bold ${selected ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-800)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:border-[var(--color-brand-500)]'}`}>{stage}</button> })}</div>
                </fieldset>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[9px] font-semibold text-[var(--color-text-tertiary)]">
              <span>{stageConditionCount > 0 ? `${stageConditionCount}軸にステージ条件` : 'ステージ指定なし'}</span>
              <span className="flex items-center gap-1">並び順<select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="h-7 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 font-bold text-[var(--color-text-secondary)]"><option value="strategyMatch">戦略一致数</option><option value="trendScore">構造スコア</option><option value="changePct">騰落率</option><option value="marketCap">{marketCapLabel}</option><option value="ticker">コード</option></select><select value={sortDir} onChange={(event) => setSortDir(event.target.value as 'asc' | 'desc')} className="h-7 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 font-bold text-[var(--color-text-secondary)]"><option value="desc">降順</option><option value="asc">昇順</option></select></span>
            </div>
          </div>
        )}
      </div>

      <div className="flex min-h-[42px] items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-4 py-2">
        <div className="min-w-0">
          <span className="block text-[10px] font-semibold text-[var(--color-text-tertiary)]">戦略一致5条件: 業種構造 / ステージ変化 / 上位足 / MA構造 / 短期・物理状態。ML類似は補助情報として分離表示</span>
          {page && <span className="mt-0.5 block text-[8px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">物理特徴 {page.physicsFeatureDate ?? '---'} / 信頼評価 {page.physicsCalibrationDate ?? '---'}</span>}
          {board.requestedDate && <span className="mt-0.5 block text-[8px] font-semibold text-[var(--color-text-tertiary)]">時価総額概算 = 基準日の株価 × 現在登録の発行済株式数</span>}
        </div>
        <span className="shrink-0 text-[11px] font-bold tabular-nums text-[var(--color-brand-900)]">{loading ? '集計中' : `${page?.total ?? 0}銘柄`}</span>
      </div>

      {loading && <div className="flex min-h-[180px] items-center justify-center gap-2 text-[12px] font-bold text-[var(--color-text-secondary)]"><LoaderCircle size={16} className="animate-spin" />絞り込み中</div>}
      {error && !loading && <div className="m-4 rounded-[6px] border border-[var(--color-price-down)] px-3 py-4 text-[12px] font-semibold text-[var(--color-price-down)]">{error}</div>}
      {page && !loading && !error && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] table-fixed border-collapse">
            <thead className="bg-[var(--color-surface-subtle)] text-left text-[9px] font-bold text-[var(--color-text-tertiary)]">
              <tr><th className="w-[165px] px-4 py-2">銘柄</th><th className="w-[150px] px-2 py-2">戦略一致</th><th className="w-[255px] px-2 py-2">注目理由</th><th className="w-[220px] px-2 py-2">最大リスク</th><th className="w-[180px] px-2 py-2">短期・物理状態</th><th className="w-[145px] px-2 py-2">6軸 / MA</th><th className="w-[100px] px-2 py-2 text-right">{board.requestedDate ? '基準値' : '現在値'}</th><th className="w-[90px] px-4 py-2 text-right">{board.requestedDate ? '当日' : '本日'}</th></tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {page.items.map((item: SectorFilteredConstituent) => (
                <tr key={item.ticker} className="hover:bg-[var(--color-surface-subtle)]">
                  <td className="px-4 py-2.5"><div className="flex min-w-0 items-center gap-1"><div className="min-w-0 flex-1"><Link href={sectorStockHref(item.ticker, board, selectedRow)} className="block text-[11px] font-bold tabular-nums text-[var(--color-brand-800)] hover:text-[var(--color-market-red)]">{item.ticker}</Link><Link href={sectorStockHref(item.ticker, board, selectedRow)} className="mt-0.5 block truncate text-[10px] font-semibold text-[var(--color-text-primary)]">{item.name ?? '名称未登録'}</Link></div><StockPreviewTrigger ticker={item.ticker} analysisDate={board.requestedDate ? board.latestDate : null} context="industry" /></div></td>
                  <td className="px-2 py-2.5"><span className="inline-flex rounded-[4px] border border-[var(--color-brand-700)] bg-white px-2 py-1 text-[10px] font-bold text-[var(--color-brand-900)]">{item.strategyEvaluation.label} {item.strategyEvaluation.matchCount}/5</span><span className="mt-1 block"><TrendStructureBadge score={item.trendStructureScore} compact /></span></td>
                  <td className="px-2 py-2.5 text-[9px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{item.strategyEvaluation.reasons.length > 0 ? item.strategyEvaluation.reasons.map((reason) => <span key={reason} className="block">・{reason}</span>) : <span className="text-[var(--color-text-tertiary)]">一致条件なし</span>}</td>
                  <td className="px-2 py-2.5 text-[9px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{item.strategyEvaluation.primaryRisk}</td>
                  <td className="px-2 py-2.5"><span className={`inline-flex rounded-[4px] border bg-white px-1.5 py-0.5 text-[9px] font-bold ${shortTermBadgeTone(item.shortTermCheckTone)}`}>{item.shortTermCheckLabel}</span><span className="ml-1 inline-flex rounded-[4px] border border-[var(--color-border-default)] bg-white px-1.5 py-0.5 text-[9px] font-bold text-[var(--color-text-secondary)]">{item.physicsStatus}</span><span className="mt-1 block text-[8px] font-semibold text-[var(--color-text-tertiary)]">{item.pullbackVerdict}{item.physicsStatusConfidence != null ? ` / 信頼${item.physicsStatusConfidence.toFixed(0)}%` : ''}</span><span className="mt-0.5 block text-[8px] font-semibold text-[var(--color-text-tertiary)]">ML補助: {item.mlSimilarCount > 0 ? `${item.mlSimilarCount}件 / 最高${item.mlTopSimilarity == null ? '---' : `${Math.round(item.mlTopSimilarity * 100)}%`}` : '高類似なし'}</span></td>
                  <td className="px-2 py-2.5"><StageCode code={item.stageCode} /><span className="mt-1 block text-[8px] font-semibold text-[var(--color-text-tertiary)]">{MA_ORDER_LABELS[item.maOrder]} / ↑{item.maUpCount} ↓{item.maDownCount}</span></td>
                  <td className="px-2 py-2.5 text-right text-[11px] font-bold tabular-nums text-[var(--color-text-primary)]">{fmtPrice(item.price)}</td>
                  <td className={`px-4 py-2.5 text-right text-[11px] font-bold tabular-nums ${changeTone(item.changePct)}`}>{fmtChange(item.changePct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {page.items.length === 0 && <div className="px-4 py-10 text-center text-[12px] font-semibold text-[var(--color-text-tertiary)]">指定条件に一致する銘柄はありません。</div>}
          {page.nextOffset != null && (
            <div className="border-t border-[var(--color-border-soft)] p-3">
              <button type="button" onClick={() => void load(page.nextOffset ?? 0, true)} disabled={loadingMore} className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-[5px] border border-[var(--color-border-default)] text-[10px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)] disabled:opacity-50">
                {loadingMore && <LoaderCircle size={13} className="animate-spin" />}次の50件を表示
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function DistributionHeatmap({
  row,
  previousDate,
  selectedCell,
  onSelect,
}: {
  row: SectorStructureRow
  previousDate: string | null
  selectedCell: SelectedCell | null
  onSelect: (cell: SelectedCell) => void
}) {
  return (
    <div className="min-w-0 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] table-fixed border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 w-[112px] border-b border-r border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-left text-[10px] font-bold text-[var(--color-text-tertiary)]">
                時間軸
              </th>
              {SECTOR_STAGE_LEVELS.map((stage) => (
                <th
                  key={stage}
                  className="sticky top-0 z-20 border-b border-r border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2 py-2 text-center"
                >
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-text-primary)]">
                    <StageTag stage={stage} size="xs" /> Stage {stage}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SECTOR_STRUCTURE_AXES.map((axis, axisIndex) => {
              const total = axisTotal(row, axis.key)
              const beginsTimeframe = axisIndex === 2 || axisIndex === 4
              return (
                <tr key={axis.key} className={beginsTimeframe ? '[&>*]:border-t-4 [&>*]:border-t-white' : ''}>
                  <th className="sticky left-0 z-10 border-b border-r border-[var(--color-border-default)] bg-white px-3 py-2 text-left">
                    <span className="block text-[12px] font-bold text-[var(--color-brand-900)]">{axis.label}</span>
                    <span className="mt-0.5 block text-[9px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">有効 {total}</span>
                  </th>
                  {SECTOR_STAGE_LEVELS.map((stage) => {
                    const count = row.composition[axis.key][stage]
                    const share = total > 0 ? count / total : 0
                    const delta = row.stageDeltas?.[axis.key][stage] ?? 0
                    const selected = selectedCell?.axis === axis.key && selectedCell.stage === stage
                    return (
                      <td key={stage} className="border-b border-r border-[var(--color-border-default)] p-1.5">
                        <button
                          type="button"
                          onClick={() => onSelect({ axis: axis.key, stage })}
                          aria-pressed={selected}
                          aria-label={`${axis.label} Stage ${stage}: ${count}銘柄、構成比${(share * 100).toFixed(1)}%、前日差${delta}`}
                          className={`relative h-[74px] w-full rounded-[5px] border text-left transition-[outline,box-shadow] hover:brightness-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-700)] ${selected ? 'border-[var(--color-brand-900)] outline outline-2 outline-[var(--color-brand-700)] outline-offset-[-2px] shadow-sm' : 'border-transparent'}`}
                          style={{ backgroundColor: stageBackground(stage, share) }}
                        >
                          <span className={`absolute left-2 top-1.5 text-[9px] font-bold tabular-nums ${changeTone(delta)}`}>
                            {previousDate ? deltaLabel(delta) : '--'}
                          </span>
                          <span className="absolute inset-0 flex items-center justify-center text-[20px] font-bold tabular-nums text-[var(--color-text-primary)]">{count}</span>
                          <span className="absolute bottom-1.5 right-2 text-[9px] font-bold tabular-nums text-[var(--color-text-secondary)]">{(share * 100).toFixed(1)}%</span>
                        </button>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--color-border-soft)] px-4 py-2 text-[9px] font-semibold text-[var(--color-text-tertiary)]">
        <span>中央: 銘柄数</span><span>右下: 構成比</span><span>左上: {previousDate ? `${previousDate}比` : '前日差なし'}</span>
        <span>▲ 増加 / ▼ 減少 / ±0 変化なし</span>
      </div>
    </div>
  )
}

export function SectorStructureBoard({ board }: { board: SectorStructureBoardData }) {
  const [search, setSearch] = useState('')
  const [visibleLimit, setVisibleLimit] = useState(GROUP_BATCH_SIZE)
  const [rankMode, setRankMode] = useState<StructureRankMode>('strong')
  const [bandFilter, setBandFilter] = useState<TrendStructureBand | 'all'>('all')
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null)
  const [page, setPage] = useState<SectorStageConstituentPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tickerLookup, setTickerLookup] = useState<TickerLookup | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const tickerLookupRef = useRef<AbortController | null>(null)

  const selectedRow = board.rows.find((row) => row.groupKey === board.selectedGroupKey) ?? board.rows[0] ?? null
  const taxonomyMeta = TAXONOMY_META[board.taxonomy]
  const searchPlaceholder = taxonomyMeta.family === 'jquants'
    ? '業種名・業種コード・銘柄コードで検索'
    : board.taxonomy === 'subIndustry'
      ? '大分類・細分類・銘柄コードで検索'
      : '大分類名・銘柄コードで検索'
  const filteredRows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('ja-JP')
    const scopedRows = board.rows.filter((row) => (
      bandFilter === 'all' || trendStructureBand(row.trendStructureScore)?.key === bandFilter
    ))
    const rankedRows = [...scopedRows].sort((a, b) => {
      if (rankMode === 'weak') return (a.trendStructureScore ?? Infinity) - (b.trendStructureScore ?? Infinity) || b.nStocks - a.nStocks
      if (rankMode === 'improving') return b.transitionChangeScore - a.transitionChangeScore || b.nStocks - a.nStocks
      if (rankMode === 'deteriorating') return a.transitionChangeScore - b.transitionChangeScore || b.nStocks - a.nStocks
      return (b.trendStructureScore ?? -Infinity) - (a.trendStructureScore ?? -Infinity) || b.nStocks - a.nStocks
    })
    const localMatches = needle
      ? rankedRows
        .map((row, index) => {
          const name = row.groupName.toLocaleLowerCase('ja-JP')
          const key = row.groupKey.toLocaleLowerCase('ja-JP')
          const parent = row.parentGroup?.toLocaleLowerCase('ja-JP') ?? ''
          const matched = rowMatchesSearch(row, needle)
          const rank = name === needle || key === needle
            ? 0
            : name.startsWith(needle) || key.startsWith(needle)
              ? 1
              : parent === needle
                ? 2
                : parent.startsWith(needle)
                  ? 3
                  : 4
          return { row, index, matched, rank }
        })
        .filter((item) => item.matched)
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map((item) => item.row)
      : rankedRows
    const matches = needle && localMatches.length === 0 && tickerLookup?.query === needle
      ? rankedRows.filter((row) => tickerLookup.groupKeys.includes(row.groupKey))
      : localMatches
    return matches
  }, [bandFilter, board.rows, rankMode, search, tickerLookup])
  const visibleRows = filteredRows.slice(0, visibleLimit)
  const bandCounts = useMemo(() => Object.fromEntries(TREND_STRUCTURE_BANDS.map((band) => [
    band.key,
    board.rows.filter((row) => trendStructureBand(row.trendStructureScore)?.key === band.key).length,
  ])) as Record<TrendStructureBand, number>, [board.rows])

  useEffect(() => {
    const needle = search.trim().toLocaleLowerCase('ja-JP')
    const ticker = needle.toUpperCase().replace(/\.T$/, '')
    const hasLocalMatch = Boolean(needle) && board.rows.some((row) => rowMatchesSearch(row, needle))
    tickerLookupRef.current?.abort()
    if (!/^\d{3}[0-9A-Z]$/.test(ticker) || hasLocalMatch) {
      setTickerLookup(null)
      return
    }

    const controller = new AbortController()
    tickerLookupRef.current = controller
    setTickerLookup({ query: needle, groupKeys: [], stockName: null, outsideUniverse: false, loading: true })
    const timeout = window.setTimeout(async () => {
      try {
        const lookupParams = new URLSearchParams()
        if (board.universe) lookupParams.set('universe', board.universe)
        const response = await fetch(`/api/sector-master/${encodeURIComponent(ticker)}${lookupParams.size > 0 ? `?${lookupParams.toString()}` : ''}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        const data = await response.json() as SectorMasterLookup
        const outsideUniverse = response.ok && data.eligible === false
        const master = response.ok && !outsideUniverse ? data.master : null
        setTickerLookup({
          query: needle,
          groupKeys: master ? tickerGroupKeys(board.taxonomy, master) : [],
          stockName: master?.name ?? null,
          outsideUniverse,
          loading: false,
        })
      } catch (lookupError) {
        if (lookupError instanceof DOMException && lookupError.name === 'AbortError') return
        setTickerLookup({ query: needle, groupKeys: [], stockName: null, outsideUniverse: false, loading: false })
      }
    }, 250)

    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [board.rows, board.taxonomy, board.universe, search])

  useEffect(() => {
    requestRef.current?.abort()
    tickerLookupRef.current?.abort()
    setSearch('')
    setVisibleLimit(GROUP_BATCH_SIZE)
    setBandFilter('all')
    setSelectedCell(null)
    setPage(null)
    setError(null)
    setLoading(false)
    setLoadingMore(false)
    setTickerLookup(null)
  }, [board.taxonomy, board.parentFilter, board.selectedGroupKey])

  useEffect(() => () => {
    requestRef.current?.abort()
    tickerLookupRef.current?.abort()
  }, [])

  async function fetchConstituents(cell: SelectedCell, cursor?: string | null, append = false) {
    if (!selectedRow || !board.latestDate) return
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    if (append) setLoadingMore(true)
    else {
      setLoading(true)
      setLoadingMore(false)
    }
    setError(null)
    try {
      const params = new URLSearchParams({
        taxonomy: board.taxonomy,
        groupKey: selectedRow.groupKey,
        axis: cell.axis,
        stage: String(cell.stage),
        date: board.latestDate,
      })
      if (board.universe) params.set('universe', board.universe)
      if (cursor) params.set('cursor', cursor)
      const response = await fetch(`/api/sectors/stage-distribution?${params.toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('銘柄一覧を取得できませんでした。')
      const nextPage = await response.json() as SectorStageConstituentPage
      if (requestRef.current !== controller) return
      setPage((current) => append && current
        ? { ...nextPage, items: [...current.items, ...nextPage.items] }
        : nextPage)
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      setError(cause instanceof Error ? cause.message : '銘柄一覧を取得できませんでした。')
    } finally {
      if (requestRef.current === controller) {
        if (append) setLoadingMore(false)
        else setLoading(false)
        requestRef.current = null
      }
    }
  }

  function selectCell(cell: SelectedCell) {
    setSelectedCell(cell)
    setPage(null)
    void fetchConstituents(cell)
  }

  const drillDown = selectedRow && board.taxonomy === 'major'
    ? { taxonomy: 'subIndustry' as const, parent: selectedRow.groupName, label: '細分類を見る' }
    : selectedRow && board.taxonomy === '17'
      ? { taxonomy: '33' as const, parent: selectedRow.groupName, label: '33業種を見る' }
      : null

  if (!selectedRow) {
    return (
      <section id="sector-structure" className="border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-10 text-center text-[13px] font-semibold text-[var(--color-text-tertiary)]">
        構造集計がまだありません。日次更新後に自動作成されます。
      </section>
    )
  }

  const screenerParams = new URLSearchParams(
    board.taxonomy === '17'
      ? { sector17: selectedRow.groupName }
      : board.taxonomy === '33'
        ? { sector33: selectedRow.groupName }
        : board.taxonomy === 'major'
          ? { majorCategory: selectedRow.groupName }
          : { majorCategory: selectedRow.parentGroup ?? '', subIndustry: selectedRow.groupName },
  )
  const hexSelectorParams = new URLSearchParams({
    view: 'selector',
    taxonomy: board.taxonomy,
    group: selectedRow.groupKey,
    mode: 'emerging',
    direction: 'up',
    ...(board.parentFilter ? { parent: board.parentFilter } : {}),
    ...(board.latestDate ? { date: board.latestDate } : {}),
    ...(board.universe ? { universe: board.universe } : {}),
  })
  const breadcrumbParent = board.parentFilter ?? selectedRow.parentGroup

  return (
    <section id="sector-structure" className="overflow-hidden rounded-[8px] border border-[var(--color-border-default)] bg-white shadow-[var(--shadow-card)]">
      <header className="border-b border-[var(--color-border-default)] bg-white px-4 py-3 sm:px-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
              <h2 className="text-[var(--color-brand-900)]">業種トレンド構造</h2>
              <p className="mt-0.5 text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">強弱の現在地、改善・悪化、6ステージ分布から業種と銘柄を選別</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-0.5">
              {([['major', '四季報'], ['17', 'J-Quants']] as const).map(([taxonomy, label]) => (
                <Link
                  key={taxonomy}
                  href={structureHref({ taxonomy, universe: board.universe, date: board.requestedDate })}
                  prefetch={false}
                  className={`rounded-[4px] px-3 py-1.5 text-[11px] font-bold ${taxonomyMeta.family === TAXONOMY_META[taxonomy].family ? 'bg-white text-[var(--color-brand-900)] shadow-sm' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-brand-900)]'}`}
                >
                  {label}
                </Link>
              ))}
            </div>
            <div className="inline-flex rounded-[6px] border border-[var(--color-border-default)] p-0.5">
              {(taxonomyMeta.family === 'shikiho'
                ? ([['major', '大分類'], ['subIndustry', '細分類']] as const)
                : ([['17', '17業種'], ['33', '33業種']] as const)
              ).map(([taxonomy, label]) => {
                const childParent = taxonomy === 'subIndustry'
                  ? (board.taxonomy === 'major' ? selectedRow.groupName : board.parentFilter ?? selectedRow.parentGroup)
                  : taxonomy === '33'
                    ? (board.taxonomy === '17' ? selectedRow.groupName : board.parentFilter ?? selectedRow.parentGroup)
                    : null
                return (
                  <Link
                    key={taxonomy}
                    href={structureHref({ taxonomy, parent: childParent, universe: board.universe, date: board.requestedDate })}
                    prefetch={false}
                    className={`rounded-[4px] px-2.5 py-1.5 text-[10px] font-bold ${board.taxonomy === taxonomy ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'}`}
                  >
                    {label}
                  </Link>
                )
              })}
            </div>
          </div>
        </div>
        <div className="mt-3 flex min-w-0 gap-1 overflow-x-auto pb-0.5" aria-label="トレンド構造状態で絞り込み">
          <button type="button" onClick={() => setBandFilter('all')} aria-pressed={bandFilter === 'all'} className={`shrink-0 rounded-[4px] border px-2.5 py-1.5 text-[9px] font-bold ${bandFilter === 'all' ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-800)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'}`}>
            全業種 {board.rows.length}
          </button>
          {TREND_STRUCTURE_BANDS.map((band) => (
            <button key={band.key} type="button" onClick={() => setBandFilter(band.key)} aria-pressed={bandFilter === band.key} className={`shrink-0 rounded-[4px] border px-2.5 py-1.5 text-[9px] font-bold ${bandFilter === band.key ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-800)] text-white' : `${trendBandTone(band.key)} bg-white`}`}>
              {band.shortLabel} {bandCounts[band.key]}
            </button>
          ))}
        </div>
        <nav aria-label="業種階層" className="mt-3 flex min-w-0 flex-wrap items-center gap-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
          <span>業種構造</span><ChevronRight size={12} />
          <span>{taxonomyMeta.familyLabel}</span><ChevronRight size={12} />
          <span>{taxonomyMeta.levelLabel}</span>
          {breadcrumbParent && <><ChevronRight size={12} /><span>{breadcrumbParent}</span></>}
          <ChevronRight size={12} /><span className="font-bold text-[var(--color-brand-900)]">{selectedRow.groupName}</span>
        </nav>
      </header>

      <MarketEnvironmentStrip board={board} />
      <IndustryPositionMap board={board} selectedRow={selectedRow} />

      <div className="grid min-w-0 xl:grid-cols-[286px_minmax(0,1fr)]">
        <aside className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] xl:border-b-0 xl:border-r">
          <div className="border-b border-[var(--color-border-soft)] p-3">
            <label className="relative block">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
              <input
                value={search}
                onChange={(event) => { setSearch(event.target.value); setVisibleLimit(GROUP_BATCH_SIZE) }}
                placeholder={searchPlaceholder}
                className="h-8 w-full rounded-[6px] border border-[var(--color-border-default)] bg-white pl-8 pr-2 text-[11px] font-semibold text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-brand-500)]"
              />
            </label>
            <label className="mt-2 flex items-center justify-between gap-2 text-[9px] font-bold text-[var(--color-text-tertiary)]">
              並び順
              <select value={rankMode} onChange={(event) => setRankMode(event.target.value as StructureRankMode)} className="h-7 min-w-[128px] rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[9px] font-bold text-[var(--color-text-secondary)] outline-none focus:border-[var(--color-brand-600)]">
                <option value="strong">強い順</option><option value="weak">弱い順</option><option value="improving">改善順</option><option value="deteriorating">悪化順</option>
              </select>
            </label>
            <p className="mt-1.5 text-[9px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
              {tickerLookup?.loading
                ? '銘柄の所属業種を検索中'
                : tickerLookup?.outsideUniverse
                  ? '選択ユニバースの対象外'
                : tickerLookup?.stockName && filteredRows.length > 0
                  ? `${tickerLookup.stockName}の所属業種 / 36セル要約`
                  : `${filteredRows.length}業種 / 36セル要約`}
            </p>
          </div>
          <div className="max-h-[240px] overflow-y-auto xl:max-h-[660px]">
            {visibleRows.map((row) => {
              const selected = row.groupKey === selectedRow.groupKey
              return (
                <Link
                  key={row.groupKey}
                  href={structureHref({ taxonomy: board.taxonomy, groupKey: row.groupKey, parent: board.parentFilter, universe: board.universe, date: board.requestedDate })}
                  prefetch={false}
                  className={`grid grid-cols-[minmax(0,1fr)_78px] items-center gap-2 border-b border-[var(--color-border-soft)] px-3 py-2.5 ${selected ? 'bg-white shadow-[inset_3px_0_0_var(--color-brand-700)]' : 'hover:bg-white'}`}
                >
                  <span className="min-w-0">
                    <span className={`block truncate text-[11px] font-bold ${selected ? 'text-[var(--color-brand-900)]' : 'text-[var(--color-text-primary)]'}`}>{row.groupName}</span>
                    <span className="mt-1 flex items-center justify-between gap-2">
                      <TrendStructureBadge score={row.trendStructureScore} compact />
                      <span className="text-[9px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">{row.nStocks}銘柄</span>
                    </span>
                    <span className="mt-1 block"><DominantChange row={row} /></span>
                  </span>
                  <TinyDistribution row={row} />
                </Link>
              )
            })}
            {visibleRows.length === 0 && (
              <div className="flex items-center justify-center gap-2 px-3 py-8 text-center text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                {tickerLookup?.loading && <LoaderCircle size={14} className="animate-spin" />}
                {tickerLookup?.loading
                  ? '所属業種を検索しています。'
                  : tickerLookup?.outsideUniverse
                    ? 'この銘柄は選択中のユニバースに含まれていません。'
                    : '一致する業種はありません。'}
              </div>
            )}
          </div>
          {visibleRows.length < filteredRows.length && (
            <div className="border-t border-[var(--color-border-soft)] p-3">
              <button
                type="button"
                onClick={() => setVisibleLimit((value) => value + GROUP_BATCH_SIZE)}
                className="h-8 w-full rounded-[6px] border border-[var(--color-border-default)] bg-white text-[10px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]"
              >
                さらに{Math.min(GROUP_BATCH_SIZE, filteredRows.length - visibleRows.length)}業種を表示
              </button>
            </div>
          )}
        </aside>

        <div className="min-w-0">
          <div className="flex flex-col gap-3 border-b border-[var(--color-border-default)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className="truncate font-bold text-[var(--color-brand-900)]">{selectedRow.groupName}</h3>
                <TrendStructureBadge score={selectedRow.trendStructureScore} />
                <Link href={`/screener?${screenerParams.toString()}`} prefetch={false} title="スクリーナーで開く" className="shrink-0 text-[var(--color-brand-700)] hover:text-[var(--color-market-red)]"><ExternalLink size={14} /></Link>
              </div>
              <div className="mt-2"><TrendStructureMeter score={selectedRow.trendStructureScore} /></div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                <span>銘柄数 <b className="text-[var(--color-text-primary)]">{selectedRow.nStocks}</b></span>
                <span>市場差 <b className={changeTone((selectedRow.trendStructureScore ?? 0) - (board.marketTrendStructureScore ?? 0))}>{selectedRow.trendStructureScore != null && board.marketTrendStructureScore != null ? `${selectedRow.trendStructureScore - board.marketTrendStructureScore > 0 ? '+' : ''}${fmt(selectedRow.trendStructureScore - board.marketTrendStructureScore)}pt` : '---'}</b></span>
                <span>ステージ構成 <b className="text-[var(--color-text-primary)]">{fmt(selectedRow.strengthScore)}</b></span>
                <span>MA上向き <b className="text-[var(--color-text-primary)]">{selectedRow.maUpBreadth != null ? `${fmt(selectedRow.maUpBreadth)}%` : '---'}</b></span>
                <span>上向き銘柄 <b className="text-[var(--color-text-primary)]">{selectedRow.upwardStockRatio != null ? `${fmt(selectedRow.upwardStockRatio)}%` : '---'}</b></span>
                <span>構造改善度(10日) <b className={changeTone(selectedRow.momentum10d)}>{selectedRow.momentum10d && selectedRow.momentum10d > 0 ? '+' : ''}{fmt(selectedRow.momentum10d)}</b></span>
                <span>{selectedRow.propagationLabel}</span>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Link href={`/hex-stage?${hexSelectorParams.toString()}`} prefetch={false} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[6px] border border-[var(--color-brand-600)] bg-[var(--color-brand-800)] px-3 text-[10px] font-bold text-white hover:bg-[var(--color-brand-900)]">
                <Hexagon size={13} />HEXで選別
              </Link>
              {drillDown && (
                <Link href={structureHref({ taxonomy: drillDown.taxonomy, parent: drillDown.parent, universe: board.universe, date: board.requestedDate })} prefetch={false} className="inline-flex h-8 items-center justify-center gap-1 rounded-[6px] border border-[var(--color-border-default)] px-3 text-[10px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]">
                  {drillDown.label}<ChevronRight size={13} />
                </Link>
              )}
            </div>
          </div>

          <div className="grid min-w-0 2xl:grid-cols-[minmax(720px,1fr)_minmax(330px,0.42fr)]">
            <DistributionHeatmap row={selectedRow} previousDate={board.previousDate} selectedCell={selectedCell} onSelect={selectCell} />
            <ConstituentList
              board={board}
              selectedCell={selectedCell}
              selectedRow={selectedRow}
              page={page}
              loading={loading}
              loadingMore={loadingMore}
              error={error}
              onLoadMore={() => selectedCell && page?.nextCursor && void fetchConstituents(selectedCell, page.nextCursor, true)}
            />
          </div>
          <SectorConstituentExplorer board={board} selectedRow={selectedRow} />
        </div>
      </div>
    </section>
  )
}
