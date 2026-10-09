import type { Metadata } from 'next'
import Link from 'next/link'
import {
  getSectorAnalysisBoard,
  getSectorConstituents,
  getSectorStructureBoard,
  normalizeSectorConstituentSort,
  resolveSectorStructureParentFromGroup,
  type SectorClassification,
  type SectorConstituentResult,
  type SectorConstituentSortKey,
  type SectorHeatmapClassification,
  type SectorHeatmapRow,
  type SectorPeriod,
  type SectorPeriodSummary,
} from '@/lib/queries/sectors'
import { SectorStructureBoard } from '@/components/sectors/SectorStructureBoard'
import type { SectorStructureTaxonomy } from '@/lib/sector-structure'
import { getMlObjectiveValidation, getMlSectorRankings, type MlSectorRanking } from '@/lib/queries/ml-insights'
import { MlObjectiveValidationBoard } from '@/components/sectors/MlObjectiveValidationBoard'
import { MlSectorRankingBoard } from '@/components/sectors/MlSectorRankingBoard'
import { getUniverseFilterMeta, parseUniverseFilter } from '@/lib/market-universe'
import { MarginBadges } from '@/components/ui/MarginBadges'
import { StageTag } from '@/components/ui/StageTag'
import { StockPreviewTrigger } from '@/components/stock-preview/StockPreviewTrigger'
import { PageTitle } from '@/components/layout/PageTitle'
import { ViewTabs } from '@/components/ui/ViewTabs'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { StatStrip } from '@/components/ui/StatStrip'
import { EmptyState } from '@/components/ui/EmptyState'

export const metadata: Metadata = {
  title: '業種分析 — StockBoard',
  description: 'J-Quants 17業種・33業種で本日、今週、今月の強弱を確認',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function selectMlSectorRankingHighlights(rows: MlSectorRanking[]): MlSectorRanking[] {
  const horizonGroups = [[5, 10, 15], [20, 40, 60], [90, 180, 200]]
  return horizonGroups.flatMap((horizons) => (
    (['17', '33'] as const).flatMap((sectorType) => (
      (['up', 'down'] as const).flatMap((direction) => (
        rows
          .filter((row) => horizons.includes(row.horizonDays) && row.sectorType === sectorType && row.direction === direction)
          .sort((a, b) => b.candidateCount - a.candidateCount || (b.avgScore ?? 0) - (a.avgScore ?? 0))
          .slice(0, 5)
      ))
    ))
  ))
}

function fmtPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function fmtVol(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000).toLocaleString('ja-JP')}K`
  return value.toLocaleString('ja-JP')
}

function fmtScore(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toFixed(2)
}

function toneForPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-secondary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function toneForScore(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-secondary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function colorFor(pct: number): { bg: string; text: string; border: string; accent: string; soft: string } {
  const intensity = Math.min(0.34, Math.max(0.05, Math.abs(pct) / 3 * 0.30))
  if (pct > 0) {
    return {
      bg: `rgba(220,38,38,${intensity})`,
      text: 'var(--color-price-up)',
      border: 'rgba(220,38,38,0.18)',
      accent: 'rgba(220,38,38,0.72)',
      soft: 'rgba(220,38,38,0.08)',
    }
  }
  if (pct < 0) {
    return {
      bg: `rgba(37,99,235,${intensity})`,
      text: 'var(--color-price-down)',
      border: 'rgba(37,99,235,0.18)',
      accent: 'rgba(37,99,235,0.72)',
      soft: 'rgba(37,99,235,0.08)',
    }
  }
  return {
    bg: 'var(--color-surface-muted)',
    text: 'var(--color-text-secondary)',
    border: 'var(--color-border-soft)',
    accent: 'var(--color-border-default)',
    soft: 'var(--color-surface-muted)',
  }
}

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function parseSectorClassification(value: string | null): SectorClassification | null {
  return value === '17' || value === '33' ? value : null
}

function parseSectorPeriod(value: string | null): SectorPeriod {
  return value === 'week' || value === 'month' ? value : 'today'
}

function parseSectorStructureTaxonomy(value: string | null): SectorStructureTaxonomy {
  if (value === '17' || value === '33' || value === 'subIndustry') return value
  return 'major'
}

type HeatmapTaxonomy = 'overview' | SectorHeatmapClassification

function parseHeatmapTaxonomy(value: string | null): HeatmapTaxonomy {
  if (value === '17' || value === '33' || value === 'major' || value === 'subIndustry') return value
  return 'overview'
}

function heatmapLabel(classification: SectorHeatmapClassification): string {
  if (classification === 'major') return '四季報60分類'
  if (classification === 'subIndustry') return '業種細分類'
  return `${classification}業種`
}

function buildSectorsHref(params: Record<string, string | number | null | undefined>) {
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value != null && String(value).trim() !== '') sp.set(key, String(value))
  }
  const query = sp.toString()
  return `/sectors${query ? `?${query}` : ''}#sector-stocks`
}

function StageCode({ code }: { code: string | null | undefined }) {
  if (!code) {
    return <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">------</span>
  }
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`6桁ステージ ${code}`}>
      {code.split('').slice(0, 6).map((digit, index) => {
        const stage = Number(digit)
        return (
          <StageTag
            key={`${digit}-${index}`}
            stage={Number.isFinite(stage) ? stage : null}
            size="xs"
          />
        )
      })}
    </span>
  )
}

function breadthRate(row: SectorHeatmapRow) {
  const total = row.advancing_count + row.declining_count
  if (total <= 0) return 0.5
  return row.advancing_count / total
}

function BreadthBar({ row }: { row: SectorHeatmapRow }) {
  const upRate = breadthRate(row)
  return (
    <div className="mt-2">
      <div className="h-1.5 overflow-hidden rounded-full bg-[rgba(37,99,235,0.18)]">
        <div
          className="h-full rounded-full bg-[rgba(220,38,38,0.72)]"
          style={{ width: `${Math.round(upRate * 100)}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[9px] font-bold text-[var(--color-text-tertiary)] tabular-nums">
        <span className="text-[var(--color-price-up)]">上昇 {row.advancing_count}</span>
        <span className="text-[var(--color-price-down)]">下落 {row.declining_count}</span>
      </div>
    </div>
  )
}

function scoreTone(value: number | null | undefined): 'up' | 'down' | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return value >= 0 ? 'up' : 'down'
}

function pctTone(value: number | null | undefined): 'up' | 'down' | undefined {
  if (value == null || !Number.isFinite(value) || value === 0) return undefined
  return value > 0 ? 'up' : 'down'
}

function HeatmapGrid({
  rows,
  classification,
  selected,
  baseParams,
}: {
  rows: SectorHeatmapRow[]
  classification: SectorHeatmapClassification
  selected: SelectedSector | null
  baseParams: BaseSectorParams
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]"
        title={`${heatmapLabel(classification)}のデータがありません`}
        description="この期間の集計がまだ作成されていません。"
      />
    )
  }
  return (
    <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${
      classification === '17'
        ? 'lg:grid-cols-5 xl:grid-cols-6'
        : classification === '33'
          ? 'lg:grid-cols-6 xl:grid-cols-8'
          : classification === 'major'
            ? 'lg:grid-cols-6 xl:grid-cols-8'
            : 'lg:grid-cols-7 xl:grid-cols-9'
    }`}>
      {rows.map((row) => {
        const c = colorFor(row.avg_change ?? 0)
        const positive = row.avg_change > 0
        const negative = row.avg_change < 0
        const isBuiltInClassification = classification === '17' || classification === '33'
        const isSelected = isBuiltInClassification && selected?.classification === classification && selected.sectorName === row.sector_name
        const href = isBuiltInClassification
          ? buildSectorsHref({
              ...baseParams,
              sectorType: classification,
              sectorName: row.sector_name,
              sectorPeriod: baseParams.sectorPeriod,
              sectorSort: 'changePct',
              sectorDir: 'desc',
              sectorMargin: null,
            })
          : `/screener?${new URLSearchParams({
              ...(baseParams.universe ? { universe: baseParams.universe } : {}),
              ...(classification === 'major'
                ? { majorCategory: row.sector_name }
                : { majorCategory: row.sector_parent_name ?? '', subIndustry: row.sector_name }),
            }).toString()}`
        return (
          <Link
            key={`${classification}-${row.sector_code ?? row.sector_name}`}
            href={href}
            prefetch={false}
            aria-current={isSelected ? 'true' : undefined}
            className={`relative flex min-h-[104px] min-w-0 flex-col justify-between overflow-hidden rounded-[6px] border py-2.5 pl-3.5 pr-3 transition-[border-color,box-shadow] hover:border-[var(--color-border-strong)] hover:shadow-[0_2px_8px_rgba(16,32,52,0.10)] ${
              isSelected ? 'ring-2 ring-[var(--color-brand-700)] ring-offset-1' : ''
            }`}
            style={{ backgroundColor: c.bg, borderColor: c.border }}
          >
            <div className="absolute left-0 top-0 h-full w-1" style={{ backgroundColor: c.accent }} />
            <div className="line-clamp-2 text-[12px] font-bold leading-snug text-[var(--color-text-primary)]">
              {row.sector_name}
            </div>
            {classification === 'subIndustry' && row.sector_parent_name && (
              <div className="mt-0.5 truncate text-[9px] font-bold text-[var(--color-text-tertiary)]" title={row.sector_parent_name}>
                {row.sector_parent_name}
              </div>
            )}
            <div className="mt-3 flex items-end justify-between gap-2">
              <span className="text-[10px] font-bold text-[var(--color-text-tertiary)] tabular-nums">
                {row.n_stocks.toLocaleString()}銘柄
              </span>
              <span className="flex flex-col items-end gap-1">
                <span
                  className="rounded-[4px] px-1.5 py-0.5 text-[16px] font-bold leading-tight tabular-nums"
                  style={{ color: c.text, backgroundColor: positive || negative ? c.soft : 'transparent' }}
                >
                  {fmtPct(row.avg_change)}
                </span>
                <span className={`text-[10px] font-bold tabular-nums ${toneForScore(row.avg_pms)}`}>
                  PMS {fmtScore(row.avg_pms)}
                </span>
              </span>
            </div>
            <BreadthBar row={row} />
          </Link>
        )
      })}
    </div>
  )
}

function RankingTable({
  title,
  rows,
  compact = false,
}: {
  title: string
  rows: SectorHeatmapRow[]
  compact?: boolean
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
        <span className="text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
          {rows.length.toLocaleString()}件
        </span>
      </div>
      <div className="table-scroll">
        <table className="w-full min-w-[440px] text-[12px]">
          <thead>
            <tr className="text-left text-[11px] font-bold">
              <th className="w-10 py-2 pl-3 pr-2">順位</th>
              <th className="py-2 pr-2">業種</th>
              <th className="py-2 pr-2 text-right">騰落率</th>
              <th className="py-2 pr-2 text-right">PMS</th>
              <th className="hidden py-2 pr-2 text-right sm:table-cell">銘柄数</th>
              <th className="py-2 pr-3 text-right">上昇/下落</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            {rows.map((row, index) => {
              const tone = row.avg_change > 0 ? 'text-[var(--color-price-up)]' : row.avg_change < 0 ? 'text-[var(--color-price-down)]' : 'text-[var(--color-text-secondary)]'
              const c = colorFor(row.avg_change ?? 0)
              const upRate = Math.round(breadthRate(row) * 100)
              return (
                <tr key={`${title}-${row.sector_code ?? row.sector_name}`} className="hover:bg-[var(--color-surface-subtle)]">
                  <td className="py-2 pl-3 pr-2 text-[var(--color-text-tertiary)] tabular-nums">
                    {index + 1}
                  </td>
                  <td className="max-w-[260px] py-2 pr-2 font-bold text-[var(--color-text-primary)]">
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <span className="h-4 w-1 shrink-0 rounded-[1px]" style={{ backgroundColor: c.accent }} />
                      <span className="truncate">{row.sector_name}</span>
                    </span>
                  </td>
                  <td className={`py-2 pr-2 text-right font-bold tabular-nums ${tone}`}>
                    {fmtPct(row.avg_change)}
                  </td>
                  <td className={`py-2 pr-2 text-right font-bold tabular-nums ${toneForScore(row.avg_pms)}`}>
                    {fmtScore(row.avg_pms)}
                  </td>
                  <td className="hidden py-2 pr-2 text-right text-[var(--color-text-secondary)] tabular-nums sm:table-cell">
                    {row.n_stocks.toLocaleString()}
                  </td>
                  <td className="py-2 pr-3 text-right text-[var(--color-text-secondary)] tabular-nums">
                    <span className="inline-flex min-w-[96px] flex-col items-stretch gap-1">
                      <span>{row.advancing_count.toLocaleString()} / {row.declining_count.toLocaleString()}</span>
                      <span className="h-1 overflow-hidden rounded-full bg-[rgba(37,99,235,0.18)]">
                        <span
                          className="block h-full rounded-full bg-[rgba(220,38,38,0.72)]"
                          style={{ width: `${upRate}%` }}
                        />
                      </span>
                    </span>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-[var(--color-text-tertiary)]">
                  該当する業種はありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {compact && (
        <div className="border-t border-[var(--color-border-soft)] px-3 py-2 text-[11px] text-[var(--color-text-tertiary)]">
          上昇/下落は、対象期間でプラス / マイナスだった銘柄数です。
        </div>
      )}
    </div>
  )
}

type BaseSectorParams = {
  universe?: string | null
  sectorPeriod: SectorPeriod
}

type SelectedSector = {
  classification: SectorClassification
  sectorName: string
  period: SectorPeriod
}

function ClassificationPeriodCard({
  period,
  classification,
  rows,
  selected,
  baseParams,
}: {
  period: SectorPeriodSummary
  classification: SectorHeatmapClassification
  rows: SectorHeatmapRow[]
  selected: SelectedSector | null
  baseParams: BaseSectorParams
}) {
  const sorted = [...rows].sort((a, b) => b.avg_change - a.avg_change)
  const top10 = sorted.slice(0, 10)
  const bottom10 = [...sorted].reverse().slice(0, 10)
  const positiveSectorCount = rows.filter((row) => row.avg_change > 0).length
  const negativeSectorCount = rows.filter((row) => row.avg_change < 0).length
  const totalStocks = rows.reduce((sum, row) => sum + row.n_stocks, 0)
  const totalAdvancing = rows.reduce((sum, row) => sum + row.advancing_count, 0)
  const totalDeclining = rows.reduce((sum, row) => sum + row.declining_count, 0)
  const pmsValues = rows.map((row) => row.avg_pms).filter((value): value is number => value != null && Number.isFinite(value))
  const pfsValues = rows.map((row) => row.avg_pfs).filter((value): value is number => value != null && Number.isFinite(value))
  const pesValues = rows.map((row) => row.avg_pes).filter((value): value is number => value != null && Number.isFinite(value))
  const avgPms = pmsValues.length > 0 ? pmsValues.reduce((sum, value) => sum + value, 0) / pmsValues.length : null
  const avgPfs = pfsValues.length > 0 ? pfsValues.reduce((sum, value) => sum + value, 0) / pfsValues.length : null
  const avgPes = pesValues.length > 0 ? pesValues.reduce((sum, value) => sum + value, 0) / pesValues.length : null
  return (
    <section className="min-w-0" aria-label={`${heatmapLabel(classification)} ${period.label}`}>
      <SectionHeader
        as="h3"
        title={`${period.label}`}
        description={<span className="tabular-nums">{period.description} · {period.baseDate} → {period.latestDate} · {rows.length.toLocaleString()}分類</span>}
      />

      <StatStrip
        className="mb-3"
        label={`${heatmapLabel(classification)} ${period.label}の集計`}
        items={[
          { label: '上昇業種', value: positiveSectorCount.toLocaleString(), tone: 'up' },
          { label: '下落業種', value: negativeSectorCount.toLocaleString(), tone: 'down' },
          { label: '銘柄数', value: totalStocks.toLocaleString() },
          { label: '上昇 / 下落銘柄', value: `${totalAdvancing.toLocaleString()} / ${totalDeclining.toLocaleString()}` },
          { label: '平均PMS', value: fmtScore(avgPms), tone: scoreTone(avgPms) },
          { label: '平均PFS', value: fmtScore(avgPfs), tone: scoreTone(avgPfs) },
          { label: '平均PES', value: fmtScore(avgPes), tone: scoreTone(avgPes) },
        ]}
      />

      <HeatmapGrid
        rows={sorted}
        classification={classification}
        selected={selected?.period === period.period ? selected : null}
        baseParams={{ ...baseParams, sectorPeriod: period.period }}
      />

      <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2">
        <RankingTable title="上昇トップ10" rows={top10} compact />
        <RankingTable title="下落トップ10" rows={bottom10} compact />
      </div>

      <details className="group mt-3">
        <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-[12px] font-bold text-[var(--color-brand-700)] hover:text-[var(--color-brand-900)] [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="inline-block transition-transform group-open:rotate-90">▸</span>
          全{rows.length.toLocaleString()}分類のランキングを表示
        </summary>
        <div className="mt-2">
          <RankingTable title={`${heatmapLabel(classification)} 全件ランキング`} rows={sorted} />
        </div>
      </details>
    </section>
  )
}

function ClassificationSection({
  title,
  description,
  classification,
  periods,
  selected,
  baseParams,
}: {
  title: string
  description: string
  classification: SectorHeatmapClassification
  periods: SectorPeriodSummary[]
  selected: SelectedSector | null
  baseParams: BaseSectorParams
}) {
  return (
    <section className="min-w-0">
      <SectionHeader level={1} title={title} description={description} />
      <div className="grid grid-cols-1 gap-8">
        {periods.map((period) => (
          <ClassificationPeriodCard
            key={`${classification}-${period.period}`}
            period={period}
            classification={classification}
            rows={
              classification === '17'
                ? period.rows17
                : classification === '33'
                  ? period.rows33
                  : classification === 'major'
                    ? period.rowsMajor
                    : period.rowsSubIndustry
            }
            selected={selected}
            baseParams={baseParams}
          />
        ))}
      </div>
    </section>
  )
}

function SortLink({
  label,
  sortKey,
  current,
  baseParams,
  align = 'left',
}: {
  label: string
  sortKey: SectorConstituentSortKey
  current: SectorConstituentResult
  baseParams: Record<string, string | number | null | undefined>
  align?: 'left' | 'right'
}) {
  const active = current.sortKey === sortKey
  const nextDir = active && current.sortDir === 'desc' ? 'asc' : 'desc'
  return (
    <Link
      href={buildSectorsHref({ ...baseParams, sectorSort: sortKey, sectorDir: nextDir })}
      prefetch={false}
      className={`inline-flex items-center gap-1 hover:text-[var(--color-brand-900)] ${
        active ? 'text-[var(--color-brand-900)]' : 'text-[var(--color-text-tertiary)]'
      } ${align === 'right' ? 'justify-end' : ''}`}
    >
      <span>{label}</span>
      {active && <span className="text-[10px]">{current.sortDir === 'desc' ? '↓' : '↑'}</span>}
    </Link>
  )
}

function MarginFilterLink({
  label,
  value,
  current,
  baseParams,
}: {
  label: string
  value: string | null
  current: SectorConstituentResult
  baseParams: Record<string, string | number | null | undefined>
}) {
  const active = (current.marginType ?? null) === value
  return (
    <Link
      href={buildSectorsHref({ ...baseParams, sectorMargin: value })}
      prefetch={false}
      aria-current={active ? 'true' : undefined}
      className={`inline-flex h-8 items-center rounded-[4px] border px-3 text-[12px] font-semibold tabular-nums ${
        active
          ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-800)] text-white'
          : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)]'
      }`}
    >
      {label}
    </Link>
  )
}

function SectorConstituentBoard({
  result,
  periodLabel,
  baseParams,
}: {
  result: SectorConstituentResult | null
  periodLabel: string
  baseParams: Record<string, string | number | null | undefined>
}) {
  if (!result) {
    return (
      <section id="sector-stocks" className="flex items-start gap-2 rounded-[6px] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-3 text-[13px] text-[var(--color-text-secondary)]">
        <span aria-hidden className="mt-0.5 text-[var(--color-brand-700)]">↓</span>
        <span>下の17業種・33業種ヒートマップで業種を選ぶと、ここに構成銘柄を表示します。騰落率・出来高・6ステージ・貸借区分で並べ替えできます。</span>
      </section>
    )
  }

  const filters = [
    { label: `全て ${result.summary.totalCount}`, value: null },
    ...result.summary.marginTypeCounts.map((item) => ({
      label: `${item.marginType} ${item.count}`,
      value: item.marginType,
    })),
  ]

  return (
    <section id="sector-stocks" className="min-w-0 scroll-mt-36">
      <SectionHeader
        level={1}
        title={`${result.classification}業種「${result.sectorName}」構成銘柄`}
        description={<span className="tabular-nums">{periodLabel} · {result.baseDate} → {result.latestDate} · {result.rows.length.toLocaleString()}件表示</span>}
      />

      <StatStrip
        label="構成銘柄の集計"
        items={[
          { label: '平均騰落率', value: fmtPct(result.summary.avgChangePct), tone: pctTone(result.summary.avgChangePct) },
          { label: '合計出来高', value: fmtVol(result.summary.totalVolume) },
          { label: '30日平均出来高', value: fmtVol(result.summary.avgVolume30) },
          { label: '平均PMS', value: fmtScore(result.summary.avgPms), tone: scoreTone(result.summary.avgPms) },
          { label: '平均PFS', value: fmtScore(result.summary.avgPfs), tone: scoreTone(result.summary.avgPfs) },
          { label: '平均PES', value: fmtScore(result.summary.avgPes), tone: scoreTone(result.summary.avgPes) },
          {
            label: '貸借 / 信用',
            value: result.summary.marginTypeCounts.slice(0, 3).map((item) => `${item.marginType} ${item.count}`).join(' · ') || '—',
          },
        ]}
      />

      <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="貸借区分で絞り込み">
        {filters.map((filter) => (
          <MarginFilterLink
            key={filter.value ?? 'all'}
            label={filter.label}
            value={filter.value}
            current={result}
            baseParams={baseParams}
          />
        ))}
      </div>

      <div className="panel mt-3 hidden md:block">
       <div className="table-scroll">
        <table className="w-full min-w-[1180px] text-[12px]">
          <thead>
            <tr className="text-left text-[11px] font-bold">
              <th className="py-2 pl-2 pr-3"><SortLink label="コード" sortKey="ticker" current={result} baseParams={baseParams} /></th>
              <th className="py-2 pr-3"><SortLink label="銘柄名" sortKey="name" current={result} baseParams={baseParams} /></th>
              <th className="py-2 pr-3"><SortLink label="貸借/信用" sortKey="marginType" current={result} baseParams={baseParams} /></th>
              <th className="py-2 pr-3"><SortLink label="市場" sortKey="marketSegment" current={result} baseParams={baseParams} /></th>
              <th className="py-2 pr-3 text-right"><SortLink label="株価" sortKey="price" current={result} baseParams={baseParams} align="right" /></th>
              <th className="py-2 pr-3 text-right"><SortLink label="騰落率" sortKey="changePct" current={result} baseParams={baseParams} align="right" /></th>
              <th className="py-2 pr-3 text-right"><SortLink label="出来高" sortKey="volume" current={result} baseParams={baseParams} align="right" /></th>
              <th className="py-2 pr-3 text-right"><SortLink label="30日平均" sortKey="avgVolume30" current={result} baseParams={baseParams} align="right" /></th>
              <th className="py-2 pr-3 text-right"><SortLink label="60日平均" sortKey="avgVolume60" current={result} baseParams={baseParams} align="right" /></th>
              <th className="py-2 pr-3 text-right"><SortLink label="PMS" sortKey="pms" current={result} baseParams={baseParams} align="right" /></th>
              <th className="py-2 pr-3 text-right"><SortLink label="PFS" sortKey="pfs" current={result} baseParams={baseParams} align="right" /></th>
              <th className="py-2 pr-3 text-right"><SortLink label="PES" sortKey="pes" current={result} baseParams={baseParams} align="right" /></th>
              <th className="py-2 pr-2"><SortLink label="6ステージ" sortKey="stageCode" current={result} baseParams={baseParams} /></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            {result.rows.map((row) => (
              <tr key={row.ticker} className="hover:bg-[var(--color-surface-subtle)]">
                <td className="py-2 pl-2 pr-3">
                  <span className="inline-flex items-center gap-1">
                    <Link href={`/stock/${row.ticker}`} prefetch={false} className="font-mono font-bold text-[var(--color-brand-900)] hover:text-[var(--color-brand-900)]">{row.ticker}</Link>
                    <StockPreviewTrigger ticker={row.ticker} analysisDate={result.latestDate} context="industry" />
                  </span>
                </td>
                <td className="max-w-[230px] truncate py-2 pr-3 font-semibold text-[var(--color-text-primary)]">
                  {row.name ?? row.ticker}
                </td>
                <td className="py-2 pr-3">
                  <MarginBadges marginType={row.marginType} compact emptyLabel="未設定" />
                </td>
                <td className="py-2 pr-3 text-[var(--color-text-secondary)]">
                  {row.marketSegment ?? '---'}
                </td>
                <td className="py-2 pr-3 text-right font-semibold tabular-nums text-[var(--color-text-primary)]">
                  {fmtPrice(row.price)}
                </td>
                <td className={`py-2 pr-3 text-right font-bold tabular-nums ${toneForPct(row.changePct)}`}>
                  {fmtPct(row.changePct)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">
                  {fmtVol(row.volume)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">
                  {fmtVol(row.avgVolume30)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">
                  {fmtVol(row.avgVolume60)}
                </td>
                <td className={`py-2 pr-3 text-right font-bold tabular-nums ${toneForScore(row.pms)}`}>
                  {fmtScore(row.pms)}
                </td>
                <td className={`py-2 pr-3 text-right font-bold tabular-nums ${toneForScore(row.pfs)}`}>
                  {fmtScore(row.pfs)}
                </td>
                <td className={`py-2 pr-3 text-right font-bold tabular-nums ${toneForScore(row.pes)}`}>
                  {fmtScore(row.pes)}
                </td>
                <td className="py-2 pr-2">
                  <StageCode code={row.stageCode} />
                </td>
              </tr>
            ))}
            {result.rows.length === 0 && (
              <tr>
                <td colSpan={13} className="py-6 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">
                  条件に合う銘柄はありません。
                </td>
              </tr>
            )}
          </tbody>
        </table>
       </div>
      </div>

      <ul className="panel mt-3 divide-y divide-[var(--color-border-soft)] md:hidden" aria-label="構成銘柄">
        {result.rows.map((row) => (
          <li key={row.ticker} className="px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="inline-flex items-center gap-1">
                  <Link href={`/stock/${row.ticker}`} prefetch={false} className="font-mono text-[13px] font-bold text-[var(--color-brand-800)]">{row.ticker}</Link>
                  <StockPreviewTrigger ticker={row.ticker} analysisDate={result.latestDate} context="industry" />
                </span>
                <div className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{row.name ?? row.ticker}</div>
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <div className="text-[13px] font-semibold text-[var(--color-text-primary)]">{fmtPrice(row.price)}</div>
                <div className={`text-[13px] font-bold ${toneForPct(row.changePct)}`}>{fmtPct(row.changePct)}</div>
              </div>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] tabular-nums text-[var(--color-text-secondary)]">
              <StageCode code={row.stageCode} />
              <span>出来高 {fmtVol(row.volume)}</span>
              <span className={toneForScore(row.pms)}>PMS {fmtScore(row.pms)}</span>
              <span className={toneForScore(row.pfs)}>PFS {fmtScore(row.pfs)}</span>
              <MarginBadges marginType={row.marginType} compact emptyLabel="未設定" />
            </div>
          </li>
        ))}
        {result.rows.length === 0 && (
          <li className="px-3 py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">条件に合う銘柄はありません。</li>
        )}
      </ul>
    </section>
  )
}

export default async function SectorsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    universe?: string | string[]
    sectorType?: string | string[]
    sectorName?: string | string[]
    sectorPeriod?: string | string[]
    sectorSort?: string | string[]
    sectorDir?: string | string[]
    sectorMargin?: string | string[]
    view?: string | string[]
    structureTaxonomy?: string | string[]
    structureGroup?: string | string[]
    structureParent?: string | string[]
    date?: string | string[]
    heatmapTaxonomy?: string | string[]
    heatmapPeriod?: string | string[]
  }>
}) {
  const sp = searchParams ? await searchParams : {}
  const universeFilter = parseUniverseFilter(sp.universe)
  const universeMeta = getUniverseFilterMeta(universeFilter)
  const selectedClassification = parseSectorClassification(firstParam(sp.sectorType))
  const selectedSectorName = firstParam(sp.sectorName)
  const selectedPeriod = parseSectorPeriod(firstParam(sp.sectorPeriod))
  const selectedSector: SelectedSector | null = selectedClassification && selectedSectorName
    ? { classification: selectedClassification, sectorName: selectedSectorName, period: selectedPeriod }
    : null
  const selectedSort = normalizeSectorConstituentSort(firstParam(sp.sectorSort), firstParam(sp.sectorDir))
  const selectedMargin = firstParam(sp.sectorMargin)
  const structureView = firstParam(sp.view) === 'structure'
  const structureTaxonomy = parseSectorStructureTaxonomy(firstParam(sp.structureTaxonomy))
  const structureGroup = firstParam(sp.structureGroup)
  const structureParent = firstParam(sp.structureParent)
  const structureDateParam = firstParam(sp.date)
  const structureDate = structureDateParam && /^\d{4}-\d{2}-\d{2}$/.test(structureDateParam)
    ? structureDateParam
    : null
  const heatmapTaxonomy = parseHeatmapTaxonomy(firstParam(sp.heatmapTaxonomy))
  const heatmapPeriod = parseSectorPeriod(firstParam(sp.heatmapPeriod))
  const showBuiltInPanels = heatmapTaxonomy === 'overview' || heatmapTaxonomy === '17' || heatmapTaxonomy === '33'
  const heatmapClassifications = heatmapTaxonomy === 'overview'
    ? ['17', '33'] as const
    : [heatmapTaxonomy] as const
  let resolvedStructureParent = structureParent
  if (structureView && (structureTaxonomy === 'subIndustry' || structureTaxonomy === '33') && !resolvedStructureParent) {
    resolvedStructureParent = await resolveSectorStructureParentFromGroup(structureTaxonomy, structureGroup)
    if (!resolvedStructureParent) {
      const parentTaxonomy = structureTaxonomy === 'subIndustry' ? 'major' : '17'
      const parentBoard = await getSectorStructureBoard(parentTaxonomy, {
        requestedDate: structureDate,
        universeFilter,
      })
      resolvedStructureParent = parentBoard.rows.find((row) => row.groupKey === parentBoard.selectedGroupKey)?.groupName ?? null
    }
  }
  const structureBoard = structureView
    ? await getSectorStructureBoard(structureTaxonomy, {
        selectedGroupKey: structureGroup,
        parentFilter: resolvedStructureParent,
        requestedDate: structureDate,
        universeFilter,
      })
    : null
  const performanceData = structureView
    ? null
    : await Promise.all([
        getSectorAnalysisBoard(universeFilter, {
          classifications: heatmapClassifications,
          periods: heatmapTaxonomy === 'subIndustry' ? [heatmapPeriod] : undefined,
        }),
        showBuiltInPanels ? getMlSectorRankings({ limit: 1000 }) : Promise.resolve({ asOfDate: null, rows: [] }),
        showBuiltInPanels ? getMlObjectiveValidation({ limit: 80 }) : Promise.resolve({ rows: [] }),
      ])
  const board = performanceData?.[0] ?? { latestDate: null, periods: [], universe: universeFilter }
  const mlRankingData = performanceData?.[1] ?? { asOfDate: null, rows: [] }
  const objectiveValidationData = performanceData?.[2] ?? { rows: [] }
  const latestDate = board.latestDate
  const mlRankingHighlights = selectMlSectorRankingHighlights(mlRankingData.rows)
  const selectedPeriodSummary = selectedSector
    ? board.periods.find((period) => period.period === selectedSector.period)
    : null
  const selectedConstituents = selectedSector && selectedPeriodSummary
    ? await getSectorConstituents({
        classification: selectedSector.classification,
        sectorName: selectedSector.sectorName,
        latestDate: selectedPeriodSummary.latestDate,
        baseDate: selectedPeriodSummary.baseDate,
        sortKey: selectedSort.sortKey,
        sortDir: selectedSort.sortDir,
        marginType: selectedMargin,
        universeFilter,
      })
    : null
  const selectedPeriodLabel = selectedPeriodSummary
    ? `${selectedPeriodSummary.label}（${selectedPeriodSummary.description}）`
    : '選択期間'
  const baseSectorParams = {
    universe: universeFilter,
    sectorPeriod: selectedSector?.period ?? 'today',
  } satisfies BaseSectorParams
  const selectedListParams = selectedSector
    ? {
        ...baseSectorParams,
        sectorType: selectedSector.classification,
        sectorName: selectedSector.sectorName,
        sectorPeriod: selectedSector.period,
        sectorSort: selectedSort.sortKey,
        sectorDir: selectedSort.sortDir,
        sectorMargin: selectedMargin,
      }
    : baseSectorParams
  const universeScopeLabel = universeMeta?.label ?? 'JP全上場銘柄'

  return (
    <div className="sb-page">
      <PageTitle
        eyebrow="市場・業種"
        title={structureView ? '業種別ステージ分布' : '業種分析'}
        subtitle={structureView
          ? `${universeScopeLabel}の6ステージ構造を、17/33業種・四季報60分類・細分類ごとに集約して比較します。`
          : `${universeMeta ? `${universeMeta.label}を対象に、` : ''}17/33業種・四季報60分類・業種細分類の強弱を、本日・今週・今月で比較します。`}
        badge={universeMeta?.shortLabel}
        meta={<span>基準日 <strong className="font-semibold text-[var(--color-text-primary)]">{structureView ? structureBoard?.latestDate ?? '—' : latestDate ?? '—'}</strong></span>}
      >
        <ViewTabs
          label="業種分析の表示"
          current={structureView ? 'structure' : 'performance'}
          items={[
            { key: 'performance', label: '騰落率', href: `/sectors${universeFilter ? `?universe=${encodeURIComponent(universeFilter)}` : ''}` },
            {
              key: 'structure',
              label: '構造変化',
              href: `/sectors?${new URLSearchParams({
                view: 'structure',
                structureTaxonomy: 'major',
                ...(universeFilter ? { universe: universeFilter } : {}),
              }).toString()}#sector-structure`,
            },
          ]}
        />
        {!structureView && (
          <ViewTabs
            label="業種分類"
            current={heatmapTaxonomy}
            items={([
              ['overview', '17/33業種'],
              ['major', '四季報60分類'],
              ['subIndustry', '業種細分類'],
            ] as const).map(([key, label]) => ({
              key,
              label,
              href: `/sectors?${new URLSearchParams({
                ...(universeFilter ? { universe: universeFilter } : {}),
                ...(key === 'overview' ? {} : { heatmapTaxonomy: key }),
              }).toString()}#sector-heatmaps`,
            }))}
          />
        )}
        {!structureView && heatmapTaxonomy === 'subIndustry' && (
          <ViewTabs
            label="集計期間"
            current={heatmapPeriod}
            items={([
              ['today', '本日'],
              ['week', '今週'],
              ['month', '今月'],
            ] as const).map(([period, label]) => ({
              key: period,
              label,
              href: `/sectors?${new URLSearchParams({
                ...(universeFilter ? { universe: universeFilter } : {}),
                heatmapTaxonomy: 'subIndustry',
                heatmapPeriod: period,
              }).toString()}#sector-heatmaps`,
            }))}
          />
        )}
        {!structureView && heatmapTaxonomy !== 'subIndustry' && (
          <span className="text-[12px] text-[var(--color-text-tertiary)]">本日・今週・今月を縦に並べて表示</span>
        )}
      </PageTitle>

      {structureView && structureBoard ? (
        <SectorStructureBoard board={structureBoard} />
      ) : board.periods.length === 0 ? (
        <EmptyState
          title="業種データがありません"
          description="上場銘柄情報と株価データの取り込み後に表示されます。"
        />
      ) : (
        <div className="space-y-10">
          {showBuiltInPanels && <>
            <SectorConstituentBoard
              result={selectedConstituents}
              periodLabel={selectedPeriodLabel}
              baseParams={selectedListParams}
            />
            <MlSectorRankingBoard rows={mlRankingHighlights} asOfDate={mlRankingData.asOfDate} />
            <MlObjectiveValidationBoard rows={objectiveValidationData.rows} />
          </>}
          {(heatmapTaxonomy === 'overview' || heatmapTaxonomy === '17') && (
            <ClassificationSection
              title="17業種ヒートマップ・ランキング"
              description="市場全体を17業種にまとめ、本日・今週・今月の大きな資金の向きを確認します。"
              classification="17"
              periods={board.periods}
              selected={selectedSector}
              baseParams={baseSectorParams}
            />
          )}
          {(heatmapTaxonomy === 'overview' || heatmapTaxonomy === '33') && (
            <ClassificationSection
              title="33業種ヒートマップ・ランキング"
              description="33業種でより細かく分解し、どの業種が相対的に強いか、弱いかを確認します。"
              classification="33"
              periods={board.periods}
              selected={selectedSector}
              baseParams={baseSectorParams}
            />
          )}
          <div id="sector-heatmaps" className="scroll-mt-36">
            {heatmapTaxonomy === 'major' && (
              <ClassificationSection
                title="四季報60分類ヒートマップ・ランキング"
                description="個別銘柄ページと同じ四季報60分類で、分類内の平均騰落・上昇下落銘柄数・PMSを比較します。カードから該当分類のスクリーナーを開けます。"
                classification="major"
                periods={board.periods}
                selected={null}
                baseParams={baseSectorParams}
              />
            )}
            {heatmapTaxonomy === 'subIndustry' && (
              <ClassificationSection
                title="業種細分類ヒートマップ・ランキング"
                description="四季報60分類の配下にある細分類を横断し、より早い資金流入・流出を確認します。カードから親分類を保持したスクリーナーを開けます。"
                classification="subIndustry"
                periods={board.periods}
                selected={null}
                baseParams={baseSectorParams}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
