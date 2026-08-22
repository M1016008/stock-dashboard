'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, ExternalLink, Hexagon, LoaderCircle, Search } from 'lucide-react'
import { StageTag } from '@/components/ui/StageTag'
import { STAGE_BORDER_COLORS, type StageLevel } from '@/lib/hex-stage'
import {
  SECTOR_STRUCTURE_AXES,
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

type TickerLookup = {
  query: string
  groupKeys: string[]
  stockName: string | null
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
}: {
  taxonomy: SectorStructureTaxonomy
  groupKey?: string | null
  parent?: string | null
  universe?: SectorStructureBoardData['universe']
}) {
  const params = new URLSearchParams({ view: 'structure', structureTaxonomy: taxonomy })
  if (groupKey) params.set('structureGroup', groupKey)
  if (parent) params.set('structureParent', parent)
  if (universe) params.set('universe', universe)
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

function changeTone(value: number | null | undefined) {
  if ((value ?? 0) > 0) return 'text-[var(--color-price-up)]'
  if ((value ?? 0) < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-tertiary)]'
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
  selectedCell,
  selectedRow,
  page,
  loading,
  loadingMore,
  error,
  onLoadMore,
}: {
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
          <h3 className="truncate text-[13px] font-bold text-[var(--color-brand-900)]">該当銘柄</h3>
          <p className="mt-0.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
            {selectedCell ? `${selectedRow.groupName} / ${axis?.label} / Stage ${selectedCell.stage}` : 'セルを選択してください'}
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
                href={`/stock/${encodeURIComponent(item.ticker)}`}
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
            <div className="px-4 py-8 text-center text-[12px] font-semibold text-[var(--color-text-tertiary)]">該当銘柄はありません。</div>
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
    const localMatches = needle
      ? board.rows
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
      : board.rows
    const matches = needle && localMatches.length === 0 && tickerLookup?.query === needle
      ? board.rows.filter((row) => tickerLookup.groupKeys.includes(row.groupKey))
      : localMatches
    if (needle || !board.selectedGroupKey) return matches
    return [
      ...matches.filter((row) => row.groupKey === board.selectedGroupKey),
      ...matches.filter((row) => row.groupKey !== board.selectedGroupKey),
    ]
  }, [board.rows, board.selectedGroupKey, search, tickerLookup])
  const visibleRows = filteredRows.slice(0, visibleLimit)

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
    setTickerLookup({ query: needle, groupKeys: [], stockName: null, loading: true })
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/sector-master/${encodeURIComponent(ticker)}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        const data = await response.json() as SectorMasterLookup
        const master = response.ok ? data.master : null
        setTickerLookup({
          query: needle,
          groupKeys: master ? tickerGroupKeys(board.taxonomy, master) : [],
          stockName: master?.name ?? null,
          loading: false,
        })
      } catch (lookupError) {
        if (lookupError instanceof DOMException && lookupError.name === 'AbortError') return
        setTickerLookup({ query: needle, groupKeys: [], stockName: null, loading: false })
      }
    }, 250)

    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [board.rows, board.taxonomy, search])

  useEffect(() => {
    requestRef.current?.abort()
    tickerLookupRef.current?.abort()
    setSearch('')
    setVisibleLimit(GROUP_BATCH_SIZE)
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
    if (!append) {
      requestRef.current?.abort()
      requestRef.current = new AbortController()
      setLoading(true)
    } else {
      setLoadingMore(true)
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
        signal: append ? undefined : requestRef.current?.signal,
      })
      if (!response.ok) throw new Error('銘柄一覧を取得できませんでした。')
      const nextPage = await response.json() as SectorStageConstituentPage
      setPage((current) => append && current
        ? { ...nextPage, items: [...current.items, ...nextPage.items] }
        : nextPage)
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      setError(cause instanceof Error ? cause.message : '銘柄一覧を取得できませんでした。')
    } finally {
      if (append) setLoadingMore(false)
      else setLoading(false)
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
            <h2 className="text-[var(--color-brand-900)]">6ステージ分布</h2>
            <p className="mt-0.5 text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">日足・週足・月足のA/Bを固定6軸で比較</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-0.5">
              {([['major', '四季報'], ['17', 'J-Quants']] as const).map(([taxonomy, label]) => (
                <Link
                  key={taxonomy}
                  href={structureHref({ taxonomy, universe: board.universe })}
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
                    href={structureHref({ taxonomy, parent: childParent, universe: board.universe })}
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
        <nav aria-label="業種階層" className="mt-3 flex min-w-0 flex-wrap items-center gap-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
          <span>業種構造</span><ChevronRight size={12} />
          <span>{taxonomyMeta.familyLabel}</span><ChevronRight size={12} />
          <span>{taxonomyMeta.levelLabel}</span>
          {breadcrumbParent && <><ChevronRight size={12} /><span>{breadcrumbParent}</span></>}
          <ChevronRight size={12} /><span className="font-bold text-[var(--color-brand-900)]">{selectedRow.groupName}</span>
        </nav>
      </header>

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
            <p className="mt-1.5 text-[9px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
              {tickerLookup?.loading
                ? '銘柄の所属業種を検索中'
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
                  href={structureHref({ taxonomy: board.taxonomy, groupKey: row.groupKey, parent: board.parentFilter, universe: board.universe })}
                  prefetch={false}
                  className={`grid grid-cols-[minmax(0,1fr)_78px] items-center gap-2 border-b border-[var(--color-border-soft)] px-3 py-2.5 ${selected ? 'bg-white shadow-[inset_3px_0_0_var(--color-brand-700)]' : 'hover:bg-white'}`}
                >
                  <span className="min-w-0">
                    <span className={`block truncate text-[11px] font-bold ${selected ? 'text-[var(--color-brand-900)]' : 'text-[var(--color-text-primary)]'}`}>{row.groupName}</span>
                    <span className="mt-1 flex items-center justify-between gap-2">
                      <DominantChange row={row} />
                      <span className="text-[9px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">{row.nStocks}</span>
                    </span>
                  </span>
                  <TinyDistribution row={row} />
                </Link>
              )
            })}
            {visibleRows.length === 0 && (
              <div className="flex items-center justify-center gap-2 px-3 py-8 text-center text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                {tickerLookup?.loading && <LoaderCircle size={14} className="animate-spin" />}
                {tickerLookup?.loading ? '所属業種を検索しています。' : '一致する業種はありません。'}
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
                <Link href={`/screener?${screenerParams.toString()}`} prefetch={false} title="スクリーナーで開く" className="shrink-0 text-[var(--color-brand-700)] hover:text-[var(--color-market-red)]"><ExternalLink size={14} /></Link>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                <span>銘柄数 <b className="text-[var(--color-text-primary)]">{selectedRow.nStocks}</b></span>
                <span>構造強度 <b className="text-[var(--color-text-primary)]">{fmt(selectedRow.strengthScore)}</b></span>
                <span>10日変化 <b className={changeTone(selectedRow.momentum10d)}>{selectedRow.momentum10d && selectedRow.momentum10d > 0 ? '+' : ''}{fmt(selectedRow.momentum10d)}</b></span>
                <span>{selectedRow.propagationLabel}</span>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Link href={`/hex-stage?${hexSelectorParams.toString()}`} prefetch={false} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[6px] border border-[var(--color-brand-600)] bg-[var(--color-brand-800)] px-3 text-[10px] font-bold text-white hover:bg-[var(--color-brand-900)]">
                <Hexagon size={13} />HEXで選別
              </Link>
              {drillDown && (
                <Link href={structureHref({ taxonomy: drillDown.taxonomy, parent: drillDown.parent, universe: board.universe })} prefetch={false} className="inline-flex h-8 items-center justify-center gap-1 rounded-[6px] border border-[var(--color-border-default)] px-3 text-[10px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]">
                  {drillDown.label}<ChevronRight size={13} />
                </Link>
              )}
            </div>
          </div>

          <div className="grid min-w-0 2xl:grid-cols-[minmax(720px,1fr)_minmax(330px,0.42fr)]">
            <DistributionHeatmap row={selectedRow} previousDate={board.previousDate} selectedCell={selectedCell} onSelect={selectCell} />
            <ConstituentList
              selectedCell={selectedCell}
              selectedRow={selectedRow}
              page={page}
              loading={loading}
              loadingMore={loadingMore}
              error={error}
              onLoadMore={() => selectedCell && page?.nextCursor && void fetchConstituents(selectedCell, page.nextCursor, true)}
            />
          </div>
        </div>
      </div>
    </section>
  )
}
