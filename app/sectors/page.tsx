import type { Metadata } from 'next'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import {
  getSectorAnalysisBoard,
  getSectorConstituents,
  normalizeSectorConstituentSort,
  type SectorClassification,
  type SectorConstituentResult,
  type SectorConstituentSortKey,
  type SectorHeatmapRow,
  type SectorPeriod,
  type SectorPeriodSummary,
} from '@/lib/queries/sectors'
import { getMlObjectiveValidation, getMlSectorRankings } from '@/lib/queries/ml-insights'
import { MlObjectiveValidationBoard } from '@/components/sectors/MlObjectiveValidationBoard'
import { MlSectorRankingBoard } from '@/components/sectors/MlSectorRankingBoard'
import { getUniverseFilterMeta, parseUniverseFilter } from '@/lib/market-universe'
import { MarginBadges } from '@/components/ui/MarginBadges'
import { StageTag } from '@/components/ui/StageTag'

export const metadata: Metadata = {
  title: '業種分析 — StockBoard',
  description: 'J-Quants 17業種・33業種で本日、今週、今月の強弱を確認',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

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

function toneForPct(value: number | null | undefined) {
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

function SectorStatPill({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'up' | 'down' | 'neutral'
}) {
  const cls =
    tone === 'up'
      ? 'border-[rgba(220,38,38,0.22)] bg-[rgba(220,38,38,0.07)] text-[var(--color-price-up)]'
      : tone === 'down'
        ? 'border-[rgba(37,99,235,0.22)] bg-[rgba(37,99,235,0.07)] text-[var(--color-price-down)]'
        : 'border-[var(--color-border-soft)] bg-white text-[var(--color-text-secondary)]'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold ${cls}`}>
      <span className="text-[var(--color-text-tertiary)]">{label}</span>
      <span className="tabular-nums">{value}</span>
    </span>
  )
}

function HeatmapGrid({
  rows,
  classification,
  selected,
  baseParams,
}: {
  rows: SectorHeatmapRow[]
  classification: '17' | '33'
  selected: SelectedSector | null
  baseParams: BaseSectorParams
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-8 text-center text-[13px] font-semibold text-[var(--color-text-tertiary)]">
        {classification}業種データなし
      </div>
    )
  }
  return (
    <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${classification === '17' ? 'lg:grid-cols-5 xl:grid-cols-6' : 'lg:grid-cols-6 xl:grid-cols-8'}`}>
      {rows.map((row) => {
        const c = colorFor(row.avg_change ?? 0)
        const positive = row.avg_change > 0
        const negative = row.avg_change < 0
        const isSelected = selected?.classification === classification && selected.sectorName === row.sector_name
        const href = buildSectorsHref({
          ...baseParams,
          sectorType: classification,
          sectorName: row.sector_name,
          sectorPeriod: baseParams.sectorPeriod,
          sectorSort: 'changePct',
          sectorDir: 'desc',
          sectorMargin: null,
        })
        return (
          <Link
            key={`${classification}-${row.sector_code ?? row.sector_name}`}
            href={href}
            prefetch={false}
            className={`relative flex min-h-[104px] flex-col justify-between overflow-hidden rounded-[8px] border px-3 py-3 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${
              isSelected ? 'ring-2 ring-[var(--color-brand-700)] ring-offset-1' : ''
            }`}
            style={{ backgroundColor: c.bg, borderColor: c.border }}
          >
            <div className="absolute left-0 top-0 h-full w-1" style={{ backgroundColor: c.accent }} />
            <div className="line-clamp-2 text-[12px] font-bold leading-snug text-[var(--color-text-primary)]">
              {row.sector_name}
            </div>
            <div className="mt-3 flex items-end justify-between gap-2">
              <span className="text-[10px] font-bold text-[var(--color-text-tertiary)] tabular-nums">
                {row.n_stocks.toLocaleString()}銘柄
              </span>
              <span
                className="rounded-full px-2 py-0.5 text-[16px] font-bold tabular-nums"
                style={{ color: c.text, backgroundColor: positive || negative ? c.soft : 'transparent' }}
              >
                {fmtPct(row.avg_change)}
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
    <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-white">
      <div className="flex items-center justify-between border-b border-[var(--color-border-soft)] px-3 py-2">
        <h3 className="text-[13px] font-bold text-[var(--color-text-primary)]">{title}</h3>
        <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">
          {rows.length.toLocaleString()}件
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[12px]">
          <thead>
            <tr className="text-left text-[10px] font-bold text-[var(--color-text-tertiary)]">
              <th className="py-2 pl-3 pr-2">順位</th>
              <th className="py-2 pr-2">業種</th>
              <th className="py-2 pr-2 text-right">騰落率</th>
              <th className="py-2 pr-2 text-right">銘柄数</th>
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
                      <span className="h-5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: c.accent }} />
                      <span className="truncate">{row.sector_name}</span>
                    </span>
                  </td>
                  <td className={`py-2 pr-2 text-right font-bold tabular-nums ${tone}`}>
                    {fmtPct(row.avg_change)}
                  </td>
                  <td className="py-2 pr-2 text-right text-[var(--color-text-secondary)] tabular-nums">
                    {row.n_stocks.toLocaleString()}
                  </td>
                  <td className="py-2 pr-3 text-right text-[var(--color-text-secondary)] tabular-nums">
                    <span className="inline-flex min-w-[120px] flex-col items-stretch gap-1">
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
                <td colSpan={5} className="py-4 text-center text-[var(--color-text-tertiary)]">
                  データなし
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {compact && (
        <div className="border-t border-[var(--color-border-soft)] px-3 py-2 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
          上昇/下落は、対象期間でプラスだった銘柄数 / マイナスだった銘柄数です。
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
  classification: '17' | '33'
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
  return (
    <section className="rounded-[10px] border border-[var(--color-border-default)] bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b-2 border-[var(--color-brand-700)] bg-[var(--color-surface-subtle)] px-3 py-2">
        <div className="min-w-0 border-l-4 border-[var(--color-market-red)] pl-2">
          <h2 className="text-[14px] font-bold text-[var(--color-brand-900)]">
            {classification}業種・{period.label}ヒートマップ
          </h2>
          <p className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            {period.description} / {period.baseDate} → {period.latestDate}
          </p>
        </div>
        <span className="rounded-full border border-[var(--color-border-default)] bg-white px-2.5 py-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
          {rows.length.toLocaleString()} 業種
        </span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SectorStatPill label="上昇業種" value={`${positiveSectorCount}`} tone="up" />
        <SectorStatPill label="下落業種" value={`${negativeSectorCount}`} tone="down" />
        <SectorStatPill label="銘柄数" value={totalStocks.toLocaleString()} />
        <SectorStatPill label="上昇/下落" value={`${totalAdvancing.toLocaleString()} / ${totalDeclining.toLocaleString()}`} />
      </div>

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

      <details className="mt-4 rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]">
        <summary className="cursor-pointer px-3 py-2 text-[12px] font-bold text-[var(--color-brand-800)]">
          全件ランキングを表示
        </summary>
        <div className="p-3">
          <RankingTable title={`${classification}業種 全件ランキング`} rows={sorted} />
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
  classification: '17' | '33'
  periods: SectorPeriodSummary[]
  selected: SelectedSector | null
  baseParams: BaseSectorParams
}) {
  return (
    <div className="space-y-4">
      <div className="sb-page-title">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="grid grid-cols-1 gap-4">
        {periods.map((period) => (
          <ClassificationPeriodCard
            key={`${classification}-${period.period}`}
            period={period}
            classification={classification}
            rows={classification === '17' ? period.rows17 : period.rows33}
            selected={selected}
            baseParams={baseParams}
          />
        ))}
      </div>
    </div>
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
      className={`inline-flex h-7 items-center rounded-full border px-3 text-[11px] font-bold ${
        active
          ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white'
          : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:border-[var(--color-brand-300)]'
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
      <section id="sector-stocks" className="rounded-[8px] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-3 text-[12px] font-semibold text-[var(--color-text-tertiary)]">
        17業種・33業種のヒートマップカードをクリックすると、ここに構成銘柄一覧を表示します。貸借/信用、出来高、6ステージ、騰落率で確認できます。
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
    <section id="sector-stocks" className="rounded-[10px] border border-[var(--color-border-default)] bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-[var(--color-brand-700)] bg-[var(--color-surface-subtle)] px-3 py-2">
        <div className="min-w-0 border-l-4 border-[var(--color-market-red)] pl-2">
          <h2 className="text-[15px] font-bold text-[var(--color-brand-900)]">
            {result.classification}業種「{result.sectorName}」構成銘柄
          </h2>
          <p className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            {periodLabel} / {result.baseDate} → {result.latestDate}
          </p>
        </div>
        <span className="rounded-full border border-[var(--color-border-default)] bg-white px-2.5 py-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
          {result.rows.length.toLocaleString()}件表示
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">平均騰落率</div>
          <div className={`mt-1 text-[18px] font-bold tabular-nums ${toneForPct(result.summary.avgChangePct)}`}>
            {fmtPct(result.summary.avgChangePct)}
          </div>
        </div>
        <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">合計出来高</div>
          <div className="mt-1 text-[18px] font-bold tabular-nums text-[var(--color-brand-900)]">
            {fmtVol(result.summary.totalVolume)}
          </div>
        </div>
        <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">30日平均出来高</div>
          <div className="mt-1 text-[18px] font-bold tabular-nums text-[var(--color-brand-900)]">
            {fmtVol(result.summary.avgVolume30)}
          </div>
        </div>
        <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">貸借/信用</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {result.summary.marginTypeCounts.slice(0, 3).map((item) => (
              <span key={item.marginType} className="rounded-full border border-[var(--color-border-soft)] bg-white px-2 py-0.5 text-[11px] font-bold text-[var(--color-text-secondary)]">
                {item.marginType} {item.count}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
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

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[1120px] text-[12px]">
          <thead>
            <tr className="text-left text-[10px] font-bold text-[var(--color-text-tertiary)]">
              <th className="py-2 pl-2 pr-3"><SortLink label="コード" sortKey="ticker" current={result} baseParams={baseParams} /></th>
              <th className="py-2 pr-3"><SortLink label="銘柄名" sortKey="name" current={result} baseParams={baseParams} /></th>
              <th className="py-2 pr-3"><SortLink label="貸借/信用" sortKey="marginType" current={result} baseParams={baseParams} /></th>
              <th className="py-2 pr-3"><SortLink label="市場" sortKey="marketSegment" current={result} baseParams={baseParams} /></th>
              <th className="py-2 pr-3 text-right"><SortLink label="株価" sortKey="price" current={result} baseParams={baseParams} align="right" /></th>
              <th className="py-2 pr-3 text-right"><SortLink label="騰落率" sortKey="changePct" current={result} baseParams={baseParams} align="right" /></th>
              <th className="py-2 pr-3 text-right"><SortLink label="出来高" sortKey="volume" current={result} baseParams={baseParams} align="right" /></th>
              <th className="py-2 pr-3 text-right"><SortLink label="30日平均" sortKey="avgVolume30" current={result} baseParams={baseParams} align="right" /></th>
              <th className="py-2 pr-3 text-right"><SortLink label="60日平均" sortKey="avgVolume60" current={result} baseParams={baseParams} align="right" /></th>
              <th className="py-2 pr-2"><SortLink label="6ステージ" sortKey="stageCode" current={result} baseParams={baseParams} /></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            {result.rows.map((row) => (
              <tr key={row.ticker} className="hover:bg-[var(--color-surface-subtle)]">
                <td className="py-2 pl-2 pr-3">
                  <Link href={`/stock/${row.ticker}`} prefetch={false} className="inline-flex items-center gap-1 font-mono font-bold text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]">
                    {row.ticker}
                    <ExternalLink size={11} />
                  </Link>
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
                <td className="py-2 pr-2">
                  <StageCode code={row.stageCode} />
                </td>
              </tr>
            ))}
            {result.rows.length === 0 && (
              <tr>
                <td colSpan={10} className="py-6 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">
                  条件に合う銘柄はありません。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
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
  const [board, mlRankingData, objectiveValidationData] = await Promise.all([
    getSectorAnalysisBoard(universeFilter),
    getMlSectorRankings({ limit: 1000 }),
    getMlObjectiveValidation({ limit: 80 }),
  ])
  const latestDate = board.latestDate
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

  return (
    <div className="sb-page">
      <div className="sb-page-title">
        <h1>業種分析（17業種・33業種）</h1>
        <p>
          J-Quantsの17業種分類・33業種分類を使い、本日・今週・今月の業種別の強弱を一覧で確認できます。
        </p>
      </div>

      <div className="sb-section" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span className="sb-tab sb-on">17業種</span>
        <span className="sb-tab sb-on">33業種</span>
        <span className="sb-tab sb-on">本日</span>
        <span className="sb-tab sb-on">今週</span>
        <span className="sb-tab sb-on">今月</span>
        {universeMeta && <span className="sb-tab sb-on">{universeMeta.shortLabel}</span>}
        <span className="sb-t" style={{ marginLeft: 'auto', fontSize: 11 }}>
          基準日: {latestDate ?? '---'}
        </span>
      </div>

      {board.periods.length === 0 ? (
        <div className="sb-section" style={{ textAlign: 'center', color: 'var(--color-text-tertiary)', fontWeight: 700 }}>
          業種データがありません。J-Quantsの上場銘柄情報と株価データを取得してください。
        </div>
      ) : (
        <div className="space-y-7">
          <SectorConstituentBoard
            result={selectedConstituents}
            periodLabel={selectedPeriodLabel}
            baseParams={selectedListParams}
          />
          <MlSectorRankingBoard rows={mlRankingData.rows} asOfDate={mlRankingData.asOfDate} />
          <MlObjectiveValidationBoard rows={objectiveValidationData.rows} />
          <ClassificationSection
            title="17業種ヒートマップ・ランキング"
            description="市場全体を17業種にまとめ、本日・今週・今月の大きな資金の向きを確認します。"
            classification="17"
            periods={board.periods}
            selected={selectedSector}
            baseParams={baseSectorParams}
          />
          <ClassificationSection
            title="33業種ヒートマップ・ランキング"
            description="33業種でより細かく分解し、どの業種が相対的に強いか、弱いかを確認します。"
            classification="33"
            periods={board.periods}
            selected={selectedSector}
            baseParams={baseSectorParams}
          />
        </div>
      )}
    </div>
  )
}
