'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { StageTag } from '@/components/ui/StageTag'
import { formatShortTermStrength } from '@/lib/short-term-check'
import type {
  DashboardScenarioInterval,
  DashboardTradeSignalMarket,
  DashboardTradeSignalResult,
  DashboardTradeSignalRow,
  DashboardTradeSignalSide,
} from '@/lib/queries/dashboard-trade-signals'

type SideFilter = DashboardTradeSignalSide
type MarketFilter = DashboardTradeSignalMarket
type IndustryLevel = '17' | '33'
type SortKey = 'confidence' | 'avgVolume' | 'industry' | 'changePct' | 'pms' | 'pfs' | 'physicalStatus'

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'confidence', label: '確度スコア' },
  { value: 'avgVolume', label: '平均出来高' },
  { value: 'industry', label: '業種' },
  { value: 'changePct', label: '騰落率' },
  { value: 'pms', label: 'PMS' },
  { value: 'pfs', label: 'PFS' },
  { value: 'physicalStatus', label: '物理状態' },
]

const SCENARIO_INTERVAL_OPTIONS: Array<{
  value: DashboardScenarioInterval
  label: string
  detail: string
}> = [
  { value: 'D', label: '1日', detail: '日足 / 5営業日先' },
  { value: '2D', label: '2日', detail: '2日足 / 10営業日先' },
  { value: 'W', label: '1週間', detail: '週足 / 20営業日先' },
  { value: '2W', label: '2週間', detail: '2週足 / 40営業日先' },
  { value: 'M', label: '1か月', detail: '月足 / 60営業日先' },
  { value: '2M', label: '2か月', detail: '2ヶ月足 / 120営業日先' },
]

function scenarioHref(currentSearch: string, interval: DashboardScenarioInterval): string {
  const params = new URLSearchParams(currentSearch)
  params.set('scenarioInterval', interval)
  const query = params.toString()
  return `/${query ? `?${query}` : ''}#trade-signals`
}

function fmtNumber(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: digits })
}

function fmtCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}億`
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 0 })
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtPrice(value: number | null | undefined, market: DashboardTradeSignalMarket): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (market === 'US') return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  return `${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}円`
}

function sideLabel(side: DashboardTradeSignalSide): string {
  return side === 'buy' ? '買う' : '売る'
}

function sideToneClass(side: DashboardTradeSignalSide): string {
  return side === 'buy'
    ? 'border-[rgba(220,38,38,0.22)] bg-[rgba(254,226,226,0.72)] text-[var(--color-price-up)]'
    : 'border-[rgba(37,99,235,0.24)] bg-[rgba(219,234,254,0.76)] text-[var(--color-price-down)]'
}

function scoreClass(score: number): string {
  if (score >= 75) return 'bg-[var(--color-brand-900)] text-white'
  return 'bg-[var(--color-surface-subtle)] text-[var(--color-brand-900)]'
}

function signedClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-tertiary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function industryValue(row: DashboardTradeSignalRow, level: IndustryLevel): string {
  return level === '17' ? row.industry17 : row.industry33
}

function sortValue(row: DashboardTradeSignalRow, sort: SortKey, industryLevel: IndustryLevel): number | string {
  switch (sort) {
    case 'avgVolume': return row.avgVolume ?? -Infinity
    case 'industry': return industryValue(row, industryLevel)
    case 'changePct': return row.changePct ?? -Infinity
    case 'pms': return row.pms ?? -Infinity
    case 'pfs': return row.pfs ?? -Infinity
    case 'physicalStatus': return row.physicalStatusScore ?? -Infinity
    case 'confidence':
    default:
      return row.confidenceScore
  }
}

function compareRows(a: DashboardTradeSignalRow, b: DashboardTradeSignalRow, sort: SortKey, industryLevel: IndustryLevel): number {
  const av = sortValue(a, sort, industryLevel)
  const bv = sortValue(b, sort, industryLevel)
  if (typeof av === 'string' || typeof bv === 'string') {
    const cmp = String(av).localeCompare(String(bv), 'ja')
    if (cmp !== 0) return cmp
    return b.confidenceScore - a.confidenceScore
  }
  if (av !== bv) return Number(bv) - Number(av)
  return a.ticker.localeCompare(b.ticker)
}

function StageStrip({ row }: { row: DashboardTradeSignalRow }) {
  const stages = [
    ['日A', row.stages.dailyA],
    ['日B', row.stages.dailyB],
    ['週A', row.stages.weeklyA],
    ['週B', row.stages.weeklyB],
    ['月A', row.stages.monthlyA],
    ['月B', row.stages.monthlyB],
  ] as const
  return (
    <div className="flex items-center gap-1 whitespace-nowrap">
      {stages.map(([label, stage]) => (
        <span key={label} className="inline-flex items-center gap-0.5 rounded-full border border-[var(--color-border-soft)] bg-white px-1 py-0.5">
          <span className="text-[8px] font-black text-[var(--color-text-tertiary)]">{label}</span>
          <StageTag stage={stage} size="xs" />
        </span>
      ))}
    </div>
  )
}

function scenarioDirectionClass(direction: 'up' | 'down' | 'range' | 'mixed'): string {
  if (direction === 'up') return 'bg-[rgba(254,226,226,0.78)] text-[var(--color-price-up)]'
  if (direction === 'down') return 'bg-[rgba(219,234,254,0.84)] text-[var(--color-price-down)]'
  if (direction === 'range') return 'bg-[rgba(254,243,199,0.82)] text-[#b45309]'
  return 'bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]'
}

function scenarioDirectionLabel(direction: 'up' | 'down' | 'range' | 'mixed'): string {
  if (direction === 'up') return '上昇優勢'
  if (direction === 'down') return '下落優勢'
  if (direction === 'range') return '横ばい優勢'
  return '拮抗'
}

function scenarioDecisionClass(tone: string): string {
  if (tone === 'constructive') {
    return 'border-[rgba(220,38,38,0.22)] bg-[rgba(254,226,226,0.62)] text-[var(--color-price-up)]'
  }
  if (tone === 'caution') {
    return 'border-[rgba(37,99,235,0.24)] bg-[rgba(219,234,254,0.68)] text-[var(--color-price-down)]'
  }
  if (tone === 'conflict') {
    return 'border-[rgba(245,158,11,0.28)] bg-[rgba(254,243,199,0.78)] text-[#b45309]'
  }
  return 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]'
}

function ScenarioCell({ row }: { row: DashboardTradeSignalRow }) {
  const scenario = row.scenario
  if (!scenario) {
    return (
      <div className="text-[11px] font-bold leading-relaxed text-[var(--color-text-tertiary)]">
        シナリオ生成データ不足
      </div>
    )
  }
  return (
    <div className="grid min-w-[230px] gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${scenarioDirectionClass(scenario.leader)}`}>
          {scenarioDirectionLabel(scenario.leader)}
        </span>
        <span className="rounded-full bg-[var(--color-brand-900)] px-2 py-0.5 font-mono text-[10px] font-black text-white">
          {scenario.scenarioScore}
        </span>
        <span className="font-mono text-[10px] font-black text-[var(--color-text-tertiary)]">
          {scenario.intervalLabel} / {scenario.horizonDays}営業日 / {scenario.baseDate}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1 font-mono text-[10px] font-black">
        <span className="rounded bg-[rgba(254,226,226,0.58)] px-1.5 py-0.5 text-[var(--color-price-up)]">上 {scenario.upWeightPct.toFixed(1)}%</span>
        <span className="rounded bg-[rgba(219,234,254,0.72)] px-1.5 py-0.5 text-[var(--color-price-down)]">下 {scenario.downWeightPct.toFixed(1)}%</span>
        <span className="rounded bg-[rgba(254,243,199,0.72)] px-1.5 py-0.5 text-[#b45309]">横 {scenario.rangeWeightPct.toFixed(1)}%</span>
      </div>
      <div className="text-[11px] font-black text-[var(--color-text-primary)]">
        #1 {scenario.topLabel} / {scenario.topScore}
      </div>
      <div className={`rounded-[7px] border px-2 py-1.5 text-[11px] font-bold leading-relaxed ${scenarioDecisionClass(scenario.decisionTone)}`}>
        <div className="mb-1 text-[10px] font-black opacity-70">判断材料</div>
        <div className="grid gap-0.5">
          {(scenario.decisionPoints?.length ? scenario.decisionPoints : [scenario.decisionSummary]).map((point) => (
            <div key={point} className="grid grid-cols-[auto_1fr] gap-1">
              <span aria-hidden="true">・</span>
              <span>{point}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-1 font-mono text-[10px] font-black text-[var(--color-text-secondary)]">
        <span>目標 {fmtPrice(scenario.targetPrice, row.market)}</span>
        <span>撤退 {fmtPrice(scenario.stopPrice, row.market)}</span>
      </div>
      {scenario.invalidation && (
        <div className="line-clamp-2 text-[10px] font-bold leading-relaxed text-[var(--color-text-tertiary)]">
          崩れる条件: {scenario.invalidation}
        </div>
      )}
    </div>
  )
}

function shapeEvidenceSentence(chip: string): string {
  if (chip.startsWith('総合:')) return chip.replace('総合:', '総合は')
  if (chip === '日足: 5/25日線上') return '日足は5日線・25日線の上で推移'
  if (chip === '日足: 5/25日線下') return '日足は5日線・25日線を下回る'
  if (chip === '日足: 5日線上抜け') return '日足は5日線を上抜け'
  if (chip === '日足: 5日線下抜け') return '日足は5日線を下抜け'
  if (chip === '日足: 25日線上抜け') return '日足は25日線を上抜け'
  if (chip === '日足: 25日線下抜け') return '日足は25日線を下抜け'
  if (chip === '日足: MA束収縮') return '日足のMA束は収縮。次の拡散方向を確認'
  if (chip === '日足: MA束拡散') return '日足のMA束は拡散。方向性が出ている'
  if (chip === '週足: 5/13週線上') return '週足は5週線・13週線の上'
  if (chip === '週足: 5/13週線下') return '週足は5週線・13週線を下回る'
  if (chip === '週足: 5週線上向き') return '週足5週線は上向き'
  if (chip === '週足: 5週線下向き') return '週足5週線は下向き'
  if (chip === '2日足: 5/25本線上') return '2日足は5本線・25本線の上'
  if (chip === '2日足: 5/25本線下') return '2日足は5本線・25本線を下回る'
  if (chip === '2週足: 5/13本線上') return '2週足は5本線・13本線の上'
  if (chip === '2週足: 5/13本線下') return '2週足は5本線・13本線を下回る'
  if (chip === '物理: 上昇加速') return '物理状態は上昇加速'
  if (chip === '物理: 下落加速') return '物理状態は下落加速'
  if (chip === '物理: 反落警戒') return '物理状態は反落警戒'
  if (chip === '物理: 反発兆候') return '物理状態は反発兆候'
  if (chip.startsWith('日A: S')) return chip.replace('日A:', '日足ステージ')
  if (chip.startsWith('週A: S')) return chip.replace('週A:', '週足ステージ')
  if (chip.startsWith('物理ML上昇#')) return `${chip}が買い側を補強`
  if (chip.startsWith('物理ML下落#')) return `${chip}が売り側を補強`
  if (chip.startsWith('ML上昇#')) return `${chip}が買い側を補強`
  if (chip.startsWith('ML下落#')) return `${chip}が売り側を補強`
  if (chip.startsWith('シナリオ上昇')) return chip.replace('シナリオ', 'シナリオは')
  if (chip.startsWith('シナリオ下落')) return chip.replace('シナリオ', 'シナリオは')
  if (chip.startsWith('シナリオ横ばい')) return chip.replace('シナリオ', 'シナリオは')
  if (chip.startsWith('#1 ')) return `最上位シナリオは${chip.replace('#1 ', '')}`
  if (chip.startsWith('物理状態: ')) return chip.replace('物理状態: ', '物理状態は')
  if (chip.startsWith('注意: ')) return chip
  return chip.replace(/: /g, 'は')
}

function evidencePointClass(point: string): string {
  if (/下|割|警戒|失速|売り|売る|鈍化|弱|注意/.test(point)) return 'text-[var(--color-price-down)]'
  if (/上|突破|反発|好転|強|加速|継続|支持|買い|買う/.test(point)) return 'text-[var(--color-price-up)]'
  if (/収縮|拡散|横|拮抗|過熱|確認/.test(point)) return 'text-[#b45309]'
  return 'text-[var(--color-text-secondary)]'
}

function shapeEvidencePoints(row: DashboardTradeSignalRow): string[] {
  const raw = [
    `総合:${row.primaryLabel}。物理状態は${row.physicalStatusLabel}`,
    `短期:${row.shortTermCheckLabel} / ${formatShortTermStrength(row.shortTermCheckLabel, row.shortTermCheckScore)}`,
    ...row.technicalChips,
    ...row.evidenceChips,
    ...row.riskChips.map((chip) => `注意: ${chip}`),
  ]
  return Array.from(new Set(raw.map(shapeEvidenceSentence))).slice(0, 7)
}

function SignalRow({ row, index }: { row: DashboardTradeSignalRow; index: number }) {
  const evidencePoints = shapeEvidencePoints(row)
  return (
    <tr className="border-b border-[var(--color-border-soft)] last:border-0 hover:bg-[rgba(248,250,252,0.86)]">
      <td className="w-[92px] px-3 py-3 align-top">
        <div className={`inline-flex min-w-[52px] justify-center rounded-full px-2.5 py-1.5 font-mono text-[15px] font-black ${scoreClass(row.confidenceScore)}`}>
          {row.confidenceScore}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-black ${sideToneClass(row.side)}`}>
            {sideLabel(row.side)}
          </span>
          <span className="rounded-full bg-[var(--color-surface-subtle)] px-1.5 py-0.5 text-[9px] font-black text-[var(--color-text-tertiary)]">
            {row.market}
          </span>
        </div>
        <div className="mt-2 font-mono text-[10px] font-black text-[var(--color-text-tertiary)]">#{index + 1}</div>
      </td>
      <td className="min-w-[280px] px-3 py-3 align-top">
        <div className="flex min-w-0 items-center gap-2">
          <Link href={row.href} prefetch={false} className="font-mono text-[15px] font-black text-[var(--color-brand-800)] hover:underline">
            {row.ticker}
          </Link>
          <span className="line-clamp-1 text-[12px] font-bold text-[var(--color-text-primary)]">{row.name}</span>
        </div>
        <div className="mt-2 grid grid-cols-[auto_auto_1fr] items-end gap-x-2 gap-y-1">
          <div className="font-mono text-[14px] font-black text-[var(--color-text-primary)]">{fmtPrice(row.price, row.market)}</div>
          <div className={`font-mono text-[12px] font-black ${signedClass(row.changePct)}`}>{fmtPct(row.changePct)}</div>
          <div className="text-right text-[9px] font-bold text-[var(--color-text-tertiary)]">{row.date ?? '日付なし'}</div>
          <div className="col-span-3 text-[10px] font-bold text-[var(--color-text-tertiary)]">
            平均出来高 {fmtCompact(row.avgVolume)} / {row.avgVolumeLabel}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          <span className="rounded-full bg-[var(--color-surface-subtle)] px-2 py-0.5 text-[10px] font-bold text-[var(--color-text-secondary)]">
            {row.marketSegment ?? '市場未分類'}
          </span>
          {row.marginType && (
            <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-[var(--color-text-secondary)] ring-1 ring-[var(--color-border-soft)]">
              {row.marginType}
            </span>
          )}
          <span className="rounded-full bg-[var(--color-surface-subtle)] px-2 py-0.5 text-[10px] font-bold text-[var(--color-text-secondary)]">
            17: {row.industry17}
          </span>
          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-[var(--color-text-primary)] ring-1 ring-[var(--color-border-soft)]">
            33: {row.industry33}
          </span>
        </div>
      </td>
      <td className="min-w-[360px] px-3 py-3 align-top">
        <ScenarioCell row={row} />
      </td>
      <td className="min-w-[330px] px-3 py-3 align-top">
        <div className="rounded-[7px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2.5 py-2">
          <div className="mb-1 text-[10px] font-black text-[var(--color-text-tertiary)]">形状根拠</div>
          <div className="grid gap-1">
            {evidencePoints.map((point) => (
              <div key={point} className={`grid grid-cols-[auto_1fr] gap-1 rounded-[5px] px-1 py-0.5 text-[11px] font-bold leading-relaxed ${evidencePointClass(point)}`}>
                <span aria-hidden="true">・</span>
                <span>{point}</span>
              </div>
            ))}
          </div>
        </div>
      </td>
      <td className="min-w-[240px] px-3 py-3 align-top">
        <StageStrip row={row} />
        <div className="mt-2 grid grid-cols-3 gap-1 rounded-[7px] bg-[var(--color-surface-subtle)] p-2 font-mono text-[10px] font-black">
          <span className={signedClass(row.pms)}>PMS {fmtNumber(row.pms, 2)}</span>
          <span className={signedClass(row.pfs)}>PFS {fmtNumber(row.pfs, 2)}</span>
          <span className={signedClass(row.pes)}>PES {fmtNumber(row.pes, 2)}</span>
        </div>
        <div className="mt-2 grid gap-1">
          {row.evidenceChips.slice(0, 3).map((chip) => (
            <span key={chip} className="line-clamp-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">
              {chip}
            </span>
          ))}
        </div>
      </td>
    </tr>
  )
}

export function DashboardTradeSignalTableClient({ data }: { data: DashboardTradeSignalResult }) {
  const searchParams = useSearchParams()
  const [side, setSide] = useState<SideFilter>('buy')
  const [market, setMarket] = useState<MarketFilter>('JP')
  const [industryLevel, setIndustryLevel] = useState<IndustryLevel>('17')
  const [industry, setIndustry] = useState('all')
  const [minVolume, setMinVolume] = useState('0')
  const [sort, setSort] = useState<SortKey>('confidence')

  const industries = useMemo(() => {
    const values = new Set<string>()
    for (const row of data.rows) {
      if (row.market !== market) continue
      values.add(industryValue(row, industryLevel))
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b, 'ja'))
  }, [data.rows, industryLevel, market])

  useEffect(() => {
    setIndustry('all')
  }, [industryLevel, market])

  const filteredRows = useMemo(() => {
    const min = Number(minVolume)
    return data.rows
      .filter((row) => row.side === side)
      .filter((row) => row.market === market)
      .filter((row) => industry === 'all' || industryValue(row, industryLevel) === industry)
      .filter((row) => !Number.isFinite(min) || min <= 0 || (row.avgVolume ?? 0) >= min)
      .sort((a, b) => compareRows(a, b, sort, industryLevel))
  }, [data.rows, industry, industryLevel, market, minVolume, side, sort])
  const visibleRows = filteredRows.slice(0, 60)

  const buyCount = data.rows.filter((row) => row.side === 'buy').length
  const sellCount = data.rows.filter((row) => row.side === 'sell').length
  const highCount = data.rows.filter((row) => row.confidenceBand === 'high').length
  const search = searchParams?.toString() ?? ''

  return (
    <section id="trade-signals" className="rounded-[8px] border border-[var(--color-border-default)] bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-bold text-[var(--color-brand-900)]">シナリオ集約 売買候補</h2>
            <span className="rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2 py-0.5 text-[10px] font-black text-[var(--color-text-secondary)]">
              シナリオ: {data.scenarioIntervalLabel}
            </span>
            <span className="rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2 py-0.5 text-[10px] font-black text-[var(--color-text-secondary)]">
              {data.scenarioHorizonDays}営業日先
            </span>
          </div>
          <p className="mt-1 max-w-[820px] text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">
            個別銘柄ページのシナリオチャートを期間別に集約し、上昇/下落/横ばいの重み、目標・撤退条件、判断材料を一覧化します。表示候補は全件シナリオ生成します。10営業日先は「2日」、20営業日先は「1週間」で確認できます。買う/売るはデータ上の方向感であり、売買助言ではありません。
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px] font-black">
          <span className="rounded-full bg-[rgba(254,226,226,0.75)] px-2.5 py-1 text-[var(--color-price-up)]">買う {buyCount}</span>
          <span className="rounded-full bg-[rgba(219,234,254,0.82)] px-2.5 py-1 text-[var(--color-price-down)]">売る {sellCount}</span>
          <span className="rounded-full bg-[var(--color-brand-900)] px-2.5 py-1 text-white">高確度 {highCount}</span>
        </div>
      </div>

      <div className="mb-3 rounded-[8px] border border-[var(--color-border-soft)] bg-white p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[11px] font-black text-[var(--color-brand-900)]">シナリオ前提</div>
            <div className="mt-0.5 text-[10px] font-bold text-[var(--color-text-tertiary)]">
              10営業日先を見るなら「2日」、20営業日先を見るなら「1週間」。選択した期間のシナリオチャートを表示候補全件へ適用します。
            </div>
          </div>
          <div className="text-[10px] font-black text-[var(--color-text-tertiary)]">
            ML補助順位は {data.horizonDays}営業日目線
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {SCENARIO_INTERVAL_OPTIONS.map((option) => {
            const active = data.scenarioInterval === option.value
            return (
              <Link
                key={option.value}
                href={scenarioHref(search, option.value)}
                prefetch={false}
                scroll={false}
                aria-current={active ? 'true' : undefined}
                className={[
                  'rounded-[7px] border px-3 py-2 text-left transition-colors',
                  active
                    ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-900)] text-white'
                    : 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-primary)] hover:border-[var(--color-brand-300)] hover:bg-white',
                ].join(' ')}
              >
                <div className="text-[13px] font-black">{option.label}</div>
                <div className={`mt-0.5 text-[10px] font-bold ${active ? 'text-white/78' : 'text-[var(--color-text-tertiary)]'}`}>
                  {option.detail}
                </div>
              </Link>
            )
          })}
        </div>
      </div>

      <div className="mb-3 grid gap-2 rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-3 md:grid-cols-6">
        <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
          候補
          <select value={side} onChange={(event) => setSide(event.target.value as SideFilter)} className="rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 py-2 text-[12px] font-bold text-[var(--color-text-primary)]">
            <option value="buy">買う</option>
            <option value="sell">売る</option>
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
          市場
          <select value={market} onChange={(event) => setMarket(event.target.value as MarketFilter)} className="rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 py-2 text-[12px] font-bold text-[var(--color-text-primary)]">
            <option value="JP">JP</option>
            <option value="US">US</option>
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
          業種分類
          <select value={industryLevel} onChange={(event) => setIndustryLevel(event.target.value as IndustryLevel)} className="rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 py-2 text-[12px] font-bold text-[var(--color-text-primary)]">
            <option value="17">17業種</option>
            <option value="33">33業種</option>
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
          業種
          <select value={industry} onChange={(event) => setIndustry(event.target.value)} className="rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 py-2 text-[12px] font-bold text-[var(--color-text-primary)]">
            <option value="all">すべて</option>
            {industries.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
          平均出来高下限
          <select value={minVolume} onChange={(event) => setMinVolume(event.target.value)} className="rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 py-2 text-[12px] font-bold text-[var(--color-text-primary)]">
            <option value="0">指定なし</option>
            <option value="100000">10万株以上</option>
            <option value="300000">30万株以上</option>
            <option value="1000000">100万株以上</option>
            <option value="3000000">300万株以上</option>
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
          並び替え
          <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} className="rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 py-2 text-[12px] font-bold text-[var(--color-text-primary)]">
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[10px] font-bold text-[var(--color-text-tertiary)]">
        <span>表示 {visibleRows.length.toLocaleString('ja-JP')}件 / 候補 {filteredRows.length.toLocaleString('ja-JP')}件 / JP {data.jpDate ?? '-'} / US {data.usDate ?? '-'}</span>
        <span>{market}の{industryLevel}業種を表示中。売る候補は下落/弱含み側の監視候補です。</span>
      </div>

      <div className="overflow-x-auto rounded-[8px] border border-[var(--color-border-soft)]">
        <table className="min-w-[1180px] w-full border-collapse bg-white text-left">
          <thead className="bg-[var(--color-surface-subtle)] text-[10px] font-black uppercase tracking-wide text-[var(--color-text-tertiary)]">
            <tr>
              <th className="px-3 py-2">確度</th>
              <th className="px-3 py-2">銘柄 / 価格</th>
              <th className="px-3 py-2">シナリオ判断</th>
              <th className="px-3 py-2">ラベル / 形状根拠</th>
              <th className="px-3 py-2">6ステージ / 指標</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => (
              <SignalRow key={row.id} row={row} index={index} />
            ))}
          </tbody>
        </table>
        {filteredRows.length === 0 && (
          <div className="bg-white px-4 py-8 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">
            条件に合う候補がありません。
          </div>
        )}
      </div>
    </section>
  )
}
