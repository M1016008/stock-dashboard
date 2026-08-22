'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  GitCompareArrows,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { SelectorAdvancedHexMap } from '@/components/hex/SelectorAdvancedHexMap'
import { StageDots } from '@/components/ui/StageDots'
import {
  rankSelectorSectors,
  type HexSelectorCandidate,
  type HexSelectorDirection,
  type HexSelectorMode,
} from '@/lib/hex-selector'
import { STAGE_BORDER_COLORS, type StageLevel } from '@/lib/hex-stage'
import {
  SECTOR_STRUCTURE_AXES,
  type SectorStructureAxisKey,
  type SectorStructureTaxonomy,
} from '@/lib/sector-structure'
import { SECTOR_STAGE_LEVELS } from '@/lib/sector-stage-distribution'
import type { HexSelectorCandidateResult } from '@/lib/queries/hex-selector'
import type { SectorStructureBoard, SectorStructureRow } from '@/lib/queries/sectors'

const TAXONOMY_META: Record<
  SectorStructureTaxonomy,
  { family: 'shikiho' | 'jquants'; familyLabel: string; levelLabel: string }
> = {
  major: { family: 'shikiho', familyLabel: '四季報', levelLabel: '大分類' },
  subIndustry: { family: 'shikiho', familyLabel: '四季報', levelLabel: '細分類' },
  '17': { family: 'jquants', familyLabel: 'J-Quants', levelLabel: '17業種' },
  '33': { family: 'jquants', familyLabel: 'J-Quants', levelLabel: '33業種' },
}

type SectorMasterLookup = {
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

function stageValues(candidate: HexSelectorCandidate) {
  return SECTOR_STRUCTURE_AXES.map((axis) => candidate.stages[axis.key])
}

function fmt(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toFixed(digits)
}

function fmtSigned(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`
}

function fmtPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function fmtMarketCap(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return '---'
  const oku = value / 100_000_000
  if (oku >= 10_000) return `${(oku / 10_000).toFixed(1)}兆円`
  return `${Math.round(oku).toLocaleString('ja-JP')}億円`
}

function tone(value: number | null | undefined) {
  if ((value ?? 0) > 0) return 'text-[var(--color-price-up)]'
  if ((value ?? 0) < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-tertiary)]'
}

function stageBackground(stage: StageLevel, share: number) {
  const hex = STAGE_BORDER_COLORS[stage]
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${(0.05 + Math.min(1, share) * 0.5).toFixed(3)})`
}

function axisTotal(row: SectorStructureRow, axis: SectorStructureAxisKey) {
  return SECTOR_STAGE_LEVELS.reduce((sum, stage) => sum + row.composition[axis][stage], 0)
}

function TinyDistribution({ row }: { row: SectorStructureRow }) {
  return (
    <div className="grid w-[72px] grid-cols-6 gap-[2px]" aria-hidden="true">
      {SECTOR_STRUCTURE_AXES.flatMap((axis) => {
        const total = axisTotal(row, axis.key)
        return SECTOR_STAGE_LEVELS.map((stage) => {
          const share = total > 0 ? row.composition[axis.key][stage] / total : 0
          return (
            <span
              key={`${axis.key}-${stage}`}
              className="h-[6px] rounded-[1px]"
              style={{ backgroundColor: stageBackground(stage, share) }}
            />
          )
        })
      })}
    </div>
  )
}

function MarketRelativeHeatmap({
  row,
  baseline,
  previousDate,
}: {
  row: SectorStructureRow
  baseline: SectorStructureBoard['marketBaseline']
  previousDate: string | null
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[700px] table-fixed border-separate border-spacing-0">
        <thead>
          <tr>
            <th className="sticky left-0 z-20 w-[96px] border-b border-r border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-left text-[10px] font-bold text-[var(--color-text-tertiary)]">
              時間軸
            </th>
            {SECTOR_STAGE_LEVELS.map((stage) => (
              <th key={stage} className="border-b border-r border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2 py-2 text-center text-[10px] font-bold text-[var(--color-text-primary)]">
                Stage {stage}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SECTOR_STRUCTURE_AXES.map((axis, index) => {
            const total = axisTotal(row, axis.key)
            return (
              <tr key={axis.key} className={index === 2 || index === 4 ? '[&>*]:border-t-4 [&>*]:border-t-white' : ''}>
                <th className="sticky left-0 z-10 border-b border-r border-[var(--color-border-default)] bg-white px-3 py-2 text-left">
                  <span className="block text-[11px] font-bold text-[var(--color-brand-900)]">{axis.label}</span>
                  <span className="text-[9px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">有効 {total}</span>
                </th>
                {SECTOR_STAGE_LEVELS.map((stage) => {
                  const count = row.composition[axis.key][stage]
                  const share = total > 0 ? count / total : 0
                  const marketDiff = 100 * (share - baseline[axis.key][stage])
                  const dayDelta = row.stageDeltas?.[axis.key][stage] ?? 0
                  return (
                    <td key={stage} className="border-b border-r border-[var(--color-border-default)] p-1">
                      <div className="relative h-[62px] rounded-[4px]" style={{ backgroundColor: stageBackground(stage, share) }}>
                        <span className={`absolute left-1.5 top-1 text-[8px] font-bold tabular-nums ${tone(dayDelta)}`}>
                          {previousDate ? `${dayDelta > 0 ? '▲ +' : dayDelta < 0 ? '▼ ' : '±'}${dayDelta}` : '--'}
                        </span>
                        <span className="absolute inset-0 flex items-center justify-center text-[17px] font-bold tabular-nums text-[var(--color-text-primary)]">{count}</span>
                        <span className="absolute bottom-1 left-1.5 text-[8px] font-bold tabular-nums text-[var(--color-text-secondary)]">{(share * 100).toFixed(1)}%</span>
                        <span className={`absolute bottom-1 right-1.5 text-[8px] font-bold tabular-nums ${tone(marketDiff)}`}>
                          市場差 {marketDiff > 0 ? '+' : ''}{marketDiff.toFixed(1)}pt
                        </span>
                      </div>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function CandidateComparison({
  candidates,
  onRemove,
}: {
  candidates: HexSelectorCandidate[]
  onRemove: (ticker: string) => void
}) {
  if (candidates.length === 0) return null
  return (
    <div className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-bold text-[var(--color-brand-900)]">
        <GitCompareArrows size={14} />候補比較 <span className="text-[var(--color-text-tertiary)]">{candidates.length}/5</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {candidates.map((candidate) => (
          <div key={candidate.ticker} className="relative border-l-2 border-[var(--color-brand-600)] bg-white px-3 py-2">
            <button type="button" onClick={() => onRemove(candidate.ticker)} title="比較から外す" className="absolute right-1.5 top-1.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">
              <X size={13} />
            </button>
            <Link href={`/stock/${encodeURIComponent(candidate.ticker)}`} className="pr-4 text-[11px] font-bold text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]">
              {candidate.ticker} {candidate.name ?? ''}
            </Link>
            <div className="mt-1.5"><StageDots values={stageValues(candidate)} size={18} /></div>
            <div className="mt-2 flex justify-between text-[9px] font-bold text-[var(--color-text-tertiary)]">
              <span>{candidate.matchCount}/5条件</span>
              <span>上位足 {candidate.higherAlignment}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function CandidateRows({
  result,
  compared,
  onToggleCompare,
}: {
  result: HexSelectorCandidateResult
  compared: Set<string>
  onToggleCompare: (candidate: HexSelectorCandidate) => void
}) {
  if (result.candidates.length === 0) {
    return <div className="px-4 py-10 text-center text-[12px] font-semibold text-[var(--color-text-tertiary)]">この条件に合う候補はありません。</div>
  }
  return (
    <>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full min-w-[1040px] border-collapse">
          <thead>
            <tr className="bg-[var(--color-surface-subtle)] text-left text-[9px] font-bold text-[var(--color-text-tertiary)]">
              <th className="border-b px-3 py-2">候補</th>
              <th className="border-b px-3 py-2">6桁ステージ</th>
              <th className="border-b px-3 py-2">選別理由</th>
              <th className="border-b px-3 py-2">警戒点</th>
              <th className="border-b px-3 py-2 text-right">現在値</th>
              <th className="border-b px-3 py-2 text-right">PMS / ML</th>
              <th className="border-b px-3 py-2 text-center">比較</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            {result.candidates.map((candidate, index) => (
              <tr key={candidate.ticker} className="hover:bg-[var(--color-surface-subtle)]">
                <td className="px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <span className="w-5 text-[9px] font-bold tabular-nums text-[var(--color-text-tertiary)]">{index + 1}</span>
                    <div className="min-w-0">
                      <Link href={`/stock/${encodeURIComponent(candidate.ticker)}`} className="text-[11px] font-bold text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]">
                        {candidate.ticker} {candidate.name ?? '名称未登録'}
                      </Link>
                      <div className="mt-0.5 text-[9px] text-[var(--color-text-tertiary)]">{candidate.marketSegment ?? '市場区分未取得'} · {fmtMarketCap(candidate.marketCap)}</div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2.5"><StageDots values={stageValues(candidate)} size={19} /></td>
                <td className="max-w-[300px] px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {candidate.reasons.slice(0, 3).map((reason) => <span key={reason} className="rounded-[3px] bg-[rgba(22,163,74,0.08)] px-1.5 py-1 text-[9px] font-bold text-[var(--color-price-up)]">{reason}</span>)}
                  </div>
                  <div className="mt-1 text-[9px] font-bold text-[var(--color-text-secondary)]">{candidate.matchCount}/5条件一致</div>
                </td>
                <td className="max-w-[220px] px-3 py-2.5">
                  {candidate.warnings.slice(0, 2).map((warning) => <div key={warning} className="flex items-center gap-1 text-[9px] font-semibold text-[var(--color-text-tertiary)]"><AlertTriangle size={10} />{warning}</div>)}
                </td>
                <td className="px-3 py-2.5 text-right text-[10px] font-bold tabular-nums">
                  <div>{fmtPrice(candidate.price)}</div>
                  <div className={tone(candidate.changePct)}>{fmtSigned(candidate.changePct, 2)}%</div>
                </td>
                <td className="px-3 py-2.5 text-right text-[9px] font-bold tabular-nums text-[var(--color-text-secondary)]">
                  <div>PMS {fmtSigned(candidate.physicalMomentumScore, 2)}</div>
                  <div>{candidate.relevantMlRank ? `ML ${candidate.relevantMlRank}位` : 'ML ---'}</div>
                </td>
                <td className="px-3 py-2.5 text-center">
                  <button type="button" onClick={() => onToggleCompare(candidate)} title={compared.has(candidate.ticker) ? '比較から外す' : '比較に追加'} className={`inline-flex h-7 w-7 items-center justify-center rounded-[4px] border ${compared.has(candidate.ticker) ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-800)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-brand-700)] hover:bg-[var(--color-surface-subtle)]'}`}>
                    <GitCompareArrows size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="divide-y divide-[var(--color-border-soft)] lg:hidden">
        {result.candidates.map((candidate, index) => (
          <div key={candidate.ticker} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[9px] font-bold text-[var(--color-text-tertiary)]">候補 {index + 1}</div>
                <Link href={`/stock/${encodeURIComponent(candidate.ticker)}`} className="mt-0.5 block truncate text-[12px] font-bold text-[var(--color-brand-900)]">{candidate.ticker} {candidate.name}</Link>
              </div>
              <button type="button" onClick={() => onToggleCompare(candidate)} className={`inline-flex h-8 items-center gap-1 rounded-[5px] border px-2 text-[10px] font-bold ${compared.has(candidate.ticker) ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-800)] text-white' : 'border-[var(--color-border-default)] text-[var(--color-brand-700)]'}`}>
                <GitCompareArrows size={12} />比較
              </button>
            </div>
            <div className="mt-2"><StageDots values={stageValues(candidate)} size={20} /></div>
            <div className="mt-2 flex flex-wrap gap-1">
              {candidate.reasons.slice(0, 3).map((reason) => <span key={reason} className="rounded-[3px] bg-[rgba(22,163,74,0.08)] px-1.5 py-1 text-[9px] font-bold text-[var(--color-price-up)]">{reason}</span>)}
            </div>
            <div className="mt-2 flex justify-between text-[10px] font-bold tabular-nums text-[var(--color-text-secondary)]">
              <span>{candidate.matchCount}/5条件一致</span>
              <span>{fmtPrice(candidate.price)} <span className={tone(candidate.changePct)}>{fmtSigned(candidate.changePct, 2)}%</span></span>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function tickerGroupKeys(taxonomy: SectorStructureTaxonomy, master: NonNullable<SectorMasterLookup['master']>) {
  const values = taxonomy === '17'
    ? [master.sector17_code, master.sector17_name]
    : taxonomy === '33'
      ? [master.sector33_code, master.sector33_name]
      : taxonomy === 'major'
        ? [master.major_category]
        : [master.major_category && master.sub_industry ? `${master.major_category}\u001f${master.sub_industry}` : null]
  return values.filter((value): value is string => Boolean(value))
}

export function HexSectorSelector({
  board,
  candidates,
  mode,
  direction,
  universe,
}: {
  board: SectorStructureBoard
  candidates: HexSelectorCandidateResult | null
  mode: HexSelectorMode
  direction: HexSelectorDirection
  universe: string | null
}) {
  const searchParams = useSearchParams()
  const [search, setSearch] = useState('')
  const [tickerGroups, setTickerGroups] = useState<string[] | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [compared, setCompared] = useState<Set<string>>(new Set())
  const rankedRows = useMemo(() => rankSelectorSectors(board.rows, mode, direction), [board.rows, direction, mode])
  const selectedRow = board.rows.find((row) => row.groupKey === board.selectedGroupKey) ?? rankedRows[0] ?? null
  const taxonomyMeta = TAXONOMY_META[board.taxonomy]

  function href(changes: Record<string, string | null>, resetCells = false) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('view', 'selector')
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value)
      else params.delete(key)
    }
    if (resetCells) {
      params.delete('dailyCells')
      params.delete('weeklyCells')
      params.delete('monthlyCells')
    }
    return `/hex-stage?${params.toString()}`
  }

  useEffect(() => {
    const needle = search.trim().toLocaleLowerCase('ja-JP')
    const ticker = needle.toUpperCase().replace(/\.T$/, '')
    const localMatch = board.rows.some((row) => row.groupName.toLocaleLowerCase('ja-JP').includes(needle) || row.groupKey.toLocaleLowerCase('ja-JP').includes(needle))
    if (!/^\d{3}[0-9A-Z]$/.test(ticker) || localMatch) {
      setTickerGroups(null)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      fetch(`/api/sector-master/${encodeURIComponent(ticker)}`, { cache: 'no-store', signal: controller.signal })
        .then((response) => response.json())
        .then((data: SectorMasterLookup) => setTickerGroups(data.master ? tickerGroupKeys(board.taxonomy, data.master) : []))
        .catch((cause) => {
          if (!(cause instanceof DOMException && cause.name === 'AbortError')) setTickerGroups([])
        })
    }, 220)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [board.rows, board.taxonomy, search])

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('ja-JP')
    if (!needle) return rankedRows
    const local = rankedRows.filter((row) => row.groupName.toLocaleLowerCase('ja-JP').includes(needle)
      || row.groupKey.toLocaleLowerCase('ja-JP').includes(needle)
      || row.parentGroup?.toLocaleLowerCase('ja-JP').includes(needle))
    return local.length > 0 || tickerGroups == null
      ? local
      : rankedRows.filter((row) => tickerGroups.includes(row.groupKey))
  }, [rankedRows, search, tickerGroups])
  const normalizedTicker = search.trim().toUpperCase().replace(/\.T$/, '')
  const hasLocalSearchMatch = rankedRows.some((row) => {
    const needle = search.trim().toLocaleLowerCase('ja-JP')
    return row.groupName.toLocaleLowerCase('ja-JP').includes(needle)
      || row.groupKey.toLocaleLowerCase('ja-JP').includes(needle)
      || row.parentGroup?.toLocaleLowerCase('ja-JP').includes(needle)
  })
  const tickerLookupPending = /^\d{3}[0-9A-Z]$/.test(normalizedTicker)
    && !hasLocalSearchMatch
    && tickerGroups == null

  function toggleCompare(candidate: HexSelectorCandidate) {
    setCompared((current) => {
      const next = new Set(current)
      if (next.has(candidate.ticker)) next.delete(candidate.ticker)
      else if (next.size < 5) next.add(candidate.ticker)
      return next
    })
  }

  if (!selectedRow || !board.latestDate) {
    return <div className="sb-section px-4 py-10 text-center text-[12px] font-semibold text-[var(--color-text-tertiary)]">業種構造データがありません。</div>
  }

  const comparedCandidates = candidates?.candidates.filter((candidate) => compared.has(candidate.ticker)) ?? []
  const sectorHref = `/sectors?${new URLSearchParams({
    view: 'structure',
    structureTaxonomy: board.taxonomy,
    structureGroup: selectedRow.groupKey,
    ...(board.parentFilter ? { structureParent: board.parentFilter } : {}),
    ...(universe ? { universe } : {}),
  }).toString()}#sector-structure`
  const drillDown = board.taxonomy === 'major'
    ? { taxonomy: 'subIndustry', parent: selectedRow.groupName, label: '細分類で絞る' }
    : board.taxonomy === '17'
      ? { taxonomy: '33', parent: selectedRow.groupName, label: '33業種で絞る' }
      : null

  return (
    <div className="space-y-3">
      <section className="overflow-hidden rounded-[8px] border border-[var(--color-border-default)] bg-white shadow-[var(--shadow-card)]">
        <header className="border-b border-[var(--color-border-default)] px-4 py-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <h2 className="text-[14px] font-bold text-[var(--color-brand-900)]">業種から銘柄を選ぶ</h2>
              <p className="mt-0.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">市場差、構造変化、上位足、MA、ML根拠を順に照合</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-0.5">
                {([['up', '上昇'], ['down', '下降']] as const).map(([value, label]) => (
                  <Link key={value} href={href({ direction: value })} className={`rounded-[4px] px-3 py-1.5 text-[10px] font-bold ${direction === value ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-text-secondary)] hover:bg-white'}`}>{label}</Link>
                ))}
              </div>
              <div className="inline-flex rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-0.5">
                {([['emerging', '初動'], ['continuation', '継続']] as const).map(([value, label]) => (
                  <Link key={value} href={href({ mode: value })} className={`rounded-[4px] px-3 py-1.5 text-[10px] font-bold ${mode === value ? 'bg-white text-[var(--color-brand-900)] shadow-sm' : 'text-[var(--color-text-secondary)]'}`}>{label}</Link>
                ))}
              </div>
              <div className="inline-flex rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-0.5">
                {([['major', '四季報'], ['17', 'J-Quants']] as const).map(([value, label]) => (
                  <Link key={value} href={href({ taxonomy: value, group: null, parent: null }, true)} className={`rounded-[4px] px-3 py-1.5 text-[10px] font-bold ${taxonomyMeta.family === TAXONOMY_META[value].family ? 'bg-white text-[var(--color-brand-900)] shadow-sm' : 'text-[var(--color-text-secondary)]'}`}>{label}</Link>
                ))}
              </div>
              <div className="inline-flex rounded-[6px] border border-[var(--color-border-default)] p-0.5">
                {(taxonomyMeta.family === 'shikiho'
                  ? ([['major', '大分類'], ['subIndustry', '細分類']] as const)
                  : ([['17', '17業種'], ['33', '33業種']] as const)
                ).map(([value, label]) => {
                  const childParent = value === 'subIndustry'
                    ? (board.taxonomy === 'major' ? selectedRow.groupName : board.parentFilter ?? selectedRow.parentGroup)
                    : value === '33'
                      ? (board.taxonomy === '17' ? selectedRow.groupName : board.parentFilter ?? selectedRow.parentGroup)
                      : null
                  return (
                    <Link key={value} href={href({ taxonomy: value, group: null, parent: childParent }, true)} className={`rounded-[4px] px-2.5 py-1.5 text-[10px] font-bold ${board.taxonomy === value ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-text-secondary)]'}`}>{label}</Link>
                  )
                })}
              </div>
            </div>
          </div>
        </header>

        <div className="grid min-w-0 xl:grid-cols-[292px_minmax(0,1fr)]">
          <aside className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] xl:border-b-0 xl:border-r">
            <div className="border-b border-[var(--color-border-soft)] p-3">
              <label className="relative block">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="業種名・コード・銘柄コード" className="h-8 w-full rounded-[6px] border border-[var(--color-border-default)] bg-white pl-8 pr-2 text-[11px] font-semibold outline-none focus:border-[var(--color-brand-500)]" />
              </label>
              <p className="mt-1.5 text-[9px] font-semibold text-[var(--color-text-tertiary)]">{filteredRows.length}業種 · {direction === 'up' ? '上昇' : '下降'}{mode === 'emerging' ? '初動' : '継続'}順</p>
            </div>
            <div className="max-h-[270px] overflow-y-auto xl:max-h-[660px]">
              {filteredRows.map((row, index) => {
                const selected = row.groupKey === selectedRow.groupKey
                const primary = mode === 'emerging'
                  ? `構造変化 ${fmtSigned(row.transitionChangeScore)}`
                  : `構造強度 ${fmt(row.strengthScore)}`
                return (
                  <Link key={row.groupKey} href={href({ group: row.groupKey, parent: board.parentFilter }, true)} className={`grid grid-cols-[20px_minmax(0,1fr)_72px] items-center gap-2 border-b border-[var(--color-border-soft)] px-3 py-2.5 ${selected ? 'bg-white shadow-[inset_3px_0_0_var(--color-brand-700)]' : 'hover:bg-white'}`}>
                    <span className="text-[9px] font-bold tabular-nums text-[var(--color-text-tertiary)]">{index + 1}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-[11px] font-bold text-[var(--color-text-primary)]">{row.groupName}</span>
                      <span className="mt-1 flex items-center justify-between gap-2 text-[9px] font-bold text-[var(--color-text-tertiary)]">
                        <span>{primary}</span>
                        <span className="inline-flex items-center gap-1">
                          {row.nStocks < 8 && <span className="rounded-[3px] bg-[rgba(217,119,6,0.10)] px-1 py-0.5 text-[8px] text-[#92400e]">少数標本</span>}
                          <span>{row.nStocks}銘柄</span>
                        </span>
                      </span>
                    </span>
                    <TinyDistribution row={row} />
                  </Link>
                )
              })}
              {tickerLookupPending && <div className="px-3 py-8 text-center text-[11px] font-semibold text-[var(--color-text-tertiary)]">銘柄の所属業種を確認中...</div>}
              {!tickerLookupPending && filteredRows.length === 0 && <div className="px-3 py-8 text-center text-[11px] font-semibold text-[var(--color-text-tertiary)]">一致する業種はありません。</div>}
            </div>
          </aside>

          <div className="min-w-0">
            <div className="flex flex-col gap-3 border-b border-[var(--color-border-default)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h3 className="truncate text-[13px] font-bold text-[var(--color-brand-900)]">{selectedRow.groupName}</h3>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[9px] font-semibold text-[var(--color-text-tertiary)]">
                  <span>銘柄数 <b className="text-[var(--color-text-primary)]">{selectedRow.nStocks}</b></span>
                  <span>構造強度 <b className="text-[var(--color-text-primary)]">{fmt(selectedRow.strengthScore)}</b></span>
                  <span>構造変化 <b className={tone(selectedRow.transitionChangeScore)}>{fmtSigned(selectedRow.transitionChangeScore)}</b></span>
                  <span>10日 <b className={tone(selectedRow.momentum10d)}>{fmtSigned(selectedRow.momentum10d)}</b></span>
                  <span>{selectedRow.propagationLabel}</span>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {drillDown && <Link href={href({ taxonomy: drillDown.taxonomy, parent: drillDown.parent, group: null }, true)} className="inline-flex h-8 items-center gap-1 rounded-[5px] border border-[var(--color-border-default)] px-2.5 text-[10px] font-bold text-[var(--color-brand-800)]">{drillDown.label}<ChevronRight size={12} /></Link>}
                <Link href={sectorHref} className="inline-flex h-8 items-center gap-1 rounded-[5px] border border-[var(--color-border-default)] px-2.5 text-[10px] font-bold text-[var(--color-brand-800)]">業種構造を詳しく見る<ExternalLink size={12} /></Link>
              </div>
            </div>
            {selectedRow.nStocks < 8 && <div className="flex items-center gap-2 border-b border-[var(--color-border-soft)] bg-[rgba(217,119,6,0.06)] px-4 py-2 text-[10px] font-bold text-[#92400e]"><AlertTriangle size={13} />標本が少ない業種です。順位より個別銘柄の根拠を優先してください。</div>}
            <MarketRelativeHeatmap row={selectedRow} baseline={board.marketBaseline} previousDate={board.previousDate} />
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-[8px] border border-[var(--color-border-default)] bg-white shadow-[var(--shadow-card)]">
        <header className="flex flex-col gap-2 border-b border-[var(--color-border-default)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-[13px] font-bold text-[var(--color-brand-900)]">条件に合う候補銘柄</h2>
            <p className="mt-0.5 text-[9px] font-semibold text-[var(--color-text-tertiary)]">{candidates ? `${candidates.total}候補の上位${candidates.candidates.length}件` : '候補を計算できませんでした'} · 単一スコアではなく5条件を個別照合</p>
          </div>
          <button type="button" onClick={() => setAdvancedOpen((value) => !value)} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[5px] border border-[var(--color-border-default)] px-3 text-[10px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]">
            <SlidersHorizontal size={13} />{advancedOpen ? '高度なHEX条件を閉じる' : '高度なHEX条件を調整'}
          </button>
        </header>
        <CandidateComparison candidates={comparedCandidates} onRemove={(ticker) => setCompared((current) => { const next = new Set(current); next.delete(ticker); return next })} />
        {candidates && <CandidateRows result={candidates} compared={compared} onToggleCompare={toggleCompare} />}
      </section>

      {advancedOpen && (
        <section className="overflow-hidden rounded-[8px] border border-[var(--color-border-default)] bg-white shadow-[var(--shadow-card)]">
          <header className="border-b border-[var(--color-border-default)] px-4 py-3">
            <h2 className="text-[13px] font-bold text-[var(--color-brand-900)]">{selectedRow.groupName}のB×A HEX条件</h2>
            <p className="mt-0.5 text-[9px] font-semibold text-[var(--color-text-tertiary)]">同じ時間軸内はOR、日足・週足・月足の間はANDで絞り込みます。</p>
          </header>
          <div className="overflow-x-auto p-3">
            <SelectorAdvancedHexMap taxonomy={board.taxonomy} groupKey={selectedRow.groupKey} groupName={selectedRow.groupName} date={board.latestDate} universe={universe} />
          </div>
        </section>
      )}
    </div>
  )
}
