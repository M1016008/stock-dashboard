'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  Check,
  ChevronRight,
  GitCompareArrows,
  LoaderCircle,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react'
import {
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { STAGE_BG_COLORS, STAGE_BORDER_COLORS } from '@/lib/hex-stage'
import {
  PEER_ZONE_LABELS,
  PeerPositionRow,
  peerZone,
  type PeerBandPoint,
  type PeerZone,
} from '@/components/stock/StockAnalysisVisuals'
import type {
  ComparisonCompany,
  ComparisonDistribution,
  ComparisonMetricKey,
  ComparisonValue,
  SimilarityCandidate,
  SimilarityCandidateKind,
  SimilarityComparisonReadModel,
} from '@/lib/similarity-comparison'

interface SimilarityComparisonDetailProps {
  ticker: string
  analysisDate?: string | null
}

type MetricFormat = 'currency' | 'percent' | 'multiple' | 'score'

type MetricRow = {
  key: ComparisonMetricKey
  label: string
  format: MetricFormat
}

type MetricSection = {
  label: string
  rows: MetricRow[]
}

const CANDIDATE_KINDS: Array<{ kind: SimilarityCandidateKind; short: string }> = [
  { kind: 'sector33', short: '同業' },
  { kind: 'custom', short: '独自分類' },
  { kind: 'financial', short: '財務類似' },
  { kind: 'structure', short: 'MA構造' },
]

const METRIC_SECTIONS: MetricSection[] = [
  {
    label: '業績・成長',
    rows: [
      { key: 'revenue', label: '売上高', format: 'currency' },
      { key: 'revenueGrowth', label: '売上成長率', format: 'percent' },
      { key: 'epsGrowth', label: 'EPS成長率', format: 'percent' },
    ],
  },
  {
    label: '収益性・財務の質',
    rows: [
      { key: 'operatingMargin', label: '営業利益率', format: 'percent' },
      { key: 'roe', label: 'ROE', format: 'percent' },
      { key: 'roa', label: 'ROA', format: 'percent' },
      { key: 'standardFcf', label: '標準FCF', format: 'currency' },
    ],
  },
  {
    label: '割安度・評価指標',
    rows: [
      { key: 'forwardPer', label: '予想PER', format: 'multiple' },
      { key: 'pbr', label: 'PBR', format: 'multiple' },
      { key: 'fcfYield', label: 'FCF利回り', format: 'percent' },
      { key: 'evEbitda', label: 'EV/EBITDA', format: 'multiple' },
    ],
  },
  {
    label: '株主還元',
    rows: [
      { key: 'dividendYield', label: '予想配当利回り', format: 'percent' },
      { key: 'payoutRatio', label: '配当性向', format: 'percent' },
      { key: 'dpsCagr5y', label: 'DPS 5年CAGR', format: 'percent' },
    ],
  },
  {
    label: '市場構造',
    rows: [
      { key: 'pms', label: 'PMS', format: 'score' },
      { key: 'pfs', label: 'PFS', format: 'score' },
      { key: 'sectorStructureScore', label: '業種構造スコア', format: 'score' },
    ],
  },
]

const SCATTER_OPTIONS = [
  { id: 'roe-pbr', label: 'ROE × PBR', x: 'roe' as const, y: 'pbr' as const, xLabel: 'ROE', yLabel: 'PBR', xFormat: 'percent' as const, yFormat: 'multiple' as const },
  { id: 'growth-forward', label: '成長 × 予想PER', x: 'revenueGrowth' as const, y: 'forwardPer' as const, xLabel: '売上成長率', yLabel: '予想PER', xFormat: 'percent' as const, yFormat: 'multiple' as const },
  { id: 'fcf-roe', label: 'FCF利回り × ROE', x: 'fcfYield' as const, y: 'roe' as const, xLabel: 'FCF利回り', yLabel: 'ROE', xFormat: 'percent' as const, yFormat: 'percent' as const },
  { id: 'structure-forward', label: '構造 × 予想PER', x: 'sectorStructureScore' as const, y: 'forwardPer' as const, xLabel: '業種構造', yLabel: '予想PER', xFormat: 'score' as const, yFormat: 'multiple' as const },
]

function fmtNumber(value: number, format: MetricFormat, compact = false): string {
  if (format === 'currency') {
    const abs = Math.abs(value)
    if (abs >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(compact ? 1 : 2)}兆円`
    if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(compact ? 0 : 1)}億円`
    if (abs >= 10_000) return `${(value / 10_000).toFixed(0)}万円`
    return `${value.toLocaleString('ja-JP', { maximumFractionDigits: 0 })}円`
  }
  if (format === 'percent') return `${value.toFixed(1)}%`
  if (format === 'multiple') return `${value.toFixed(1)}x`
  return value.toFixed(1)
}

function fmtValue(value: ComparisonValue, format: MetricFormat): string {
  if (value.value != null && value.availability === 'available') return fmtNumber(value.value, format)
  if (value.availability === 'not_applicable') return 'N/A'
  if (value.availability === 'not_meaningful') return 'N/M'
  return '—'
}

function StageStrip({ company }: { company: ComparisonCompany }) {
  const axes = [
    ['日A', company.stages.dailyA], ['日B', company.stages.dailyB],
    ['週A', company.stages.weeklyA], ['週B', company.stages.weeklyB],
    ['月A', company.stages.monthlyA], ['月B', company.stages.monthlyB],
  ] as const
  return (
    <div className="mt-1.5 flex items-center justify-center gap-0.5" title={company.stageCode ? `6ステージ ${company.stageCode}` : '6ステージ未取得'}>
      {axes.map(([label, stage]) => (
        <span
          key={label}
          className="inline-flex h-5 w-5 items-center justify-center border font-mono text-[9px] font-black"
          style={stage ? { background: STAGE_BG_COLORS[stage], borderColor: STAGE_BORDER_COLORS[stage] } : undefined}
          aria-label={`${label} ${stage ? `Stage ${stage}` : '未取得'}`}
        >
          {stage ?? '-'}
        </span>
      ))}
    </div>
  )
}

function stageMatch(base: string | null | undefined, other: string | null | undefined): { same: number; total: number } | null {
  if (!base || !other) return null
  let same = 0
  let total = 0
  for (let index = 0; index < Math.min(base.length, other.length); index += 1) {
    if (!/\d/.test(base[index]) || !/\d/.test(other[index])) continue
    total += 1
    if (base[index] === other[index]) same += 1
  }
  return total > 0 ? { same, total } : null
}

interface PositionRow {
  metric: MetricRow
  p25: number
  median: number
  p75: number
  target: PeerBandPoint
  peers: PeerBandPoint[]
  zone: PeerZone
  /** 中央値からの距離をP25–P75幅で割った値。指標どうしの並べ替えにだけ使う */
  scaled: number
}

function SummaryList({
  title,
  tone,
  rows,
  empty,
}: {
  title: string
  tone: string
  rows: PositionRow[]
  empty: string
}) {
  return (
    <div className="min-w-0 border-t-2 bg-white px-2.5 py-2" style={{ borderTopColor: tone }}>
      <div className="text-[10px] font-black text-[var(--color-text-secondary)]">{title}</div>
      {rows.length === 0 ? (
        <div className="mt-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">{empty}</div>
      ) : (
        <ul className="m-0 mt-1 grid gap-0.5 p-0">
          {rows.map((row) => (
            <li key={row.metric.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2 text-[10px] leading-4">
              <span className="truncate font-bold text-[var(--color-text-primary)]">{row.metric.label}</span>
              <span className="whitespace-nowrap font-mono">
                <b className="text-[var(--color-market-red)]">{row.target.text}</b>
                <span className="ml-1 text-[9px] font-semibold text-[var(--color-text-tertiary)]">中央 {fmtNumber(row.median, row.metric.format, true)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CandidateButton({
  candidate,
  selected,
  disabled,
  baseStageCode,
  onToggle,
}: {
  candidate: SimilarityCandidate
  selected: boolean
  disabled: boolean
  baseStageCode: string | null
  onToggle: () => void
}) {
  const match = stageMatch(baseStageCode, candidate.stageCode)
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled && !selected}
      className={`group min-w-[178px] flex-1 border px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50 ${
        selected
          ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-50)]'
          : 'border-[var(--color-border-default)] bg-white hover:bg-[var(--color-surface-subtle)]'
      }`}
      aria-pressed={selected}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="font-mono text-[11px] font-black text-[var(--color-brand-800)]">{candidate.ticker}</span>
          <span className="ml-1.5 text-[10px] font-bold text-[var(--color-text-primary)]">{candidate.name ?? '名称未取得'}</span>
        </span>
        <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${selected ? 'bg-[var(--color-brand-700)] text-white' : 'border border-[var(--color-border-default)] text-[var(--color-text-tertiary)]'}`}>
          {selected ? <Check size={12} /> : <Plus size={12} />}
        </span>
      </span>
      <span className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-1.5 gap-y-0.5 text-[9px] leading-4">
        <span className="font-black text-[var(--color-brand-800)]">似ている点</span>
        <span className="font-semibold text-[var(--color-text-secondary)]">{candidate.reason}</span>
        {match && (
          <>
            <span className="font-black text-[var(--color-text-tertiary)]">Stage</span>
            <span className="font-mono font-semibold text-[var(--color-text-tertiary)]">基準と一致 {match.same}/{match.total}軸</span>
          </>
        )}
      </span>
      <span className="mt-1.5 flex items-center justify-between gap-2 border-t border-[var(--color-border-soft)] pt-1 font-mono text-[9px] font-bold text-[var(--color-text-secondary)]">
        <span>{candidate.score == null ? '分類一致' : `類似 ${candidate.score.toFixed(1)}`}</span>
        <span>{candidate.coveragePercent == null ? candidate.stageCode ?? '------' : `指標カバー率 ${candidate.coveragePercent.toFixed(0)}%`}</span>
      </span>
    </button>
  )
}

function DistributionCell({ distribution, format }: { distribution: ComparisonDistribution | undefined; format: MetricFormat }) {
  if (!distribution || distribution.median == null) return <span className="text-[var(--color-text-tertiary)]">—</span>
  return (
    <div className="min-w-[132px] text-left leading-4">
      <div className="font-mono text-[10px] font-black text-[var(--color-text-primary)]">中央値 {fmtNumber(distribution.median, format, true)}</div>
      <div className="font-mono text-[8px] font-semibold text-[var(--color-text-tertiary)]">
        P25 {distribution.percentile25 == null ? '—' : fmtNumber(distribution.percentile25, format, true)} / P75 {distribution.percentile75 == null ? '—' : fmtNumber(distribution.percentile75, format, true)}
      </div>
      <div className="text-[8px] font-semibold text-[var(--color-text-tertiary)]">n={distribution.validCount}/{distribution.peerCount}</div>
    </div>
  )
}

export function SimilarityComparisonDetail({ ticker, analysisDate = null }: SimilarityComparisonDetailProps) {
  const [model, setModel] = useState<SimilarityComparisonReadModel | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [activeKind, setActiveKind] = useState<SimilarityCandidateKind>('sector33')
  const [scatterId, setScatterId] = useState(SCATTER_OPTIONS[0].id)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const selectedKey = selected.join(',')

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams()
    if (analysisDate) params.set('as_of', analysisDate)
    if (selected.length > 0) params.set('selected', selected.join(','))
    setLoading(true)
    setError(null)
    fetch(`/api/similarity-comparison/${encodeURIComponent(ticker)}?${params.toString()}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json() as SimilarityComparisonReadModel & { error?: string }
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
        return body
      })
      .then((body) => {
        if (controller.signal.aborted) return
        setModel(body)
        if (selected.length === 0) setSelected(body.selectedTickers)
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '比較データを取得できませんでした。')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
    // selectedKey is intentionally the stable request identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisDate, selectedKey, ticker])

  const activeGroup = model?.candidateGroups.find((group) => group.kind === activeKind) ?? null
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const scatterOption = SCATTER_OPTIONS.find((option) => option.id === scatterId) ?? SCATTER_OPTIONS[0]
  const scatterData = useMemo(() => (model?.companies ?? []).flatMap((company) => {
    const x = company.metrics[scatterOption.x].value
    const y = company.metrics[scatterOption.y].value
    return x == null || y == null ? [] : [{
      ticker: company.isBase ? `対象 ${company.ticker}` : company.ticker,
      name: company.name ?? company.ticker,
      x,
      y,
      isBase: company.isBase,
    }]
  }), [model, scatterOption])

  const baseCompany = model?.companies.find((company) => company.isBase) ?? null
  const bandSections = useMemo(() => {
    if (!model || !baseCompany) return []
    const peers = model.companies.filter((company) => !company.isBase)
    return METRIC_SECTIONS.map((section) => ({
      label: section.label,
      rows: section.rows.flatMap((metric): PositionRow[] => {
        const distribution = model.sectorDistribution.metrics[metric.key]
        const baseValue = baseCompany.metrics[metric.key]
        if (
          !distribution ||
          distribution.percentile25 == null ||
          distribution.median == null ||
          distribution.percentile75 == null ||
          distribution.percentile75 <= distribution.percentile25 ||
          baseValue.availability !== 'available' ||
          baseValue.value == null
        ) return []
        const point = (key: string, label: string, value: number): PeerBandPoint => ({ key, label, value, text: fmtNumber(value, metric.format) })
        return [{
          metric,
          p25: distribution.percentile25,
          median: distribution.median,
          p75: distribution.percentile75,
          target: point(baseCompany.ticker, baseCompany.ticker, baseValue.value),
          peers: peers.flatMap((company) => {
            const value = company.metrics[metric.key]
            return value.availability === 'available' && value.value != null ? [point(company.ticker, company.ticker, value.value)] : []
          }),
          zone: peerZone(baseValue.value, distribution.percentile25, distribution.median, distribution.percentile75),
          scaled: (baseValue.value - distribution.median) / (distribution.percentile75 - distribution.percentile25),
        }]
      }),
    })).filter((section) => section.rows.length > 0)
  }, [model, baseCompany])
  const positionSummary = useMemo(() => {
    const rows = bandSections.flatMap((section) => section.rows)
    return {
      high: rows.filter((row) => row.zone === 'above').sort((a, b) => b.scaled - a.scaled).slice(0, 3),
      low: rows.filter((row) => row.zone === 'below').sort((a, b) => a.scaled - b.scaled).slice(0, 3),
      typical: rows.filter((row) => row.zone === 'lower' || row.zone === 'upper').sort((a, b) => Math.abs(a.scaled) - Math.abs(b.scaled)).slice(0, 3),
      total: rows.length,
    }
  }, [bandSections])
  // 近い銘柄は既存の候補順位(財務類似の類似度順)をそのまま上位3社表示する
  const closestGroup = model?.candidateGroups.find((group) => group.kind === 'financial' && group.candidates.length > 0)
    ?? model?.candidateGroups.find((group) => group.candidates.length > 0)
    ?? null
  const closestPeers = closestGroup?.candidates.slice(0, 3) ?? []
  const stageMatchByTicker = new Map((model?.companies ?? []).flatMap((company) => {
    if (company.isBase) return []
    const match = stageMatch(baseCompany?.stageCode, company.stageCode)
    return match ? [[company.ticker, match] as const] : []
  }))

  const toggleCandidate = (candidate: SimilarityCandidate) => {
    setSelected((current) => {
      if (current.includes(candidate.ticker)) return current.filter((code) => code === ticker || code !== candidate.ticker)
      if (current.length >= 8) return current
      return [...current, candidate.ticker]
    })
  }

  return (
    <section className="border border-[var(--color-border-default)] bg-white" aria-labelledby="similarity-comparison-title">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border-default)] bg-[var(--color-brand-50)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <GitCompareArrows size={17} className="mt-0.5 shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />
          <div>
            <h2 id="similarity-comparison-title" className="text-[13px] font-black text-[var(--color-brand-900)]">① 同業・財務の比較</h2>
            {baseCompany && (
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] font-bold text-[var(--color-text-secondary)]">
                <span className="inline-flex h-5 items-center bg-[var(--color-market-red)] px-1.5 text-[9px] font-black text-white">対象</span>
                <span className="font-mono font-black text-[var(--color-text-primary)]">{baseCompany.ticker}</span>
                <span>{baseCompany.name}</span>
                <span className="text-[var(--color-text-tertiary)]">／ 33業種 {model?.sectorDistribution.groupName ?? '分類なし'}の分布と比較</span>
              </p>
            )}
          </div>
        </div>
        <span className="font-mono text-[9px] font-bold text-[var(--color-text-tertiary)]">基準日 {model?.asOf ?? analysisDate ?? '---'}</span>
      </header>

      {error && <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-[10px] font-bold text-red-800">{error}</div>}
      {!model && loading && (
        <div className="flex min-h-32 items-center justify-center gap-2 text-[11px] font-bold text-[var(--color-text-tertiary)]">
          <LoaderCircle size={15} className="animate-spin" />読み込み中…
        </div>
      )}

      {model && (
        <>
          <section className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-3 sm:px-4" aria-labelledby="similarity-summary-title">
            <h3 id="similarity-summary-title" className="mb-2 text-[11px] font-black text-[var(--color-text-primary)]">
              要約 <span className="font-semibold text-[var(--color-text-tertiary)]">業種分布(P25・中央値・P75)に対する対象の位置 ・ 比較できた指標 {positionSummary.total}</span>
            </h3>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <SummaryList title="業種内で高い側(P75超)" tone="var(--color-brand-700)" rows={positionSummary.high} empty="P75を超える指標はありません" />
              <SummaryList title="業種内で低い側(P25未満)" tone="var(--color-text-secondary)" rows={positionSummary.low} empty="P25を下回る指標はありません" />
              <SummaryList title="業種並み(中央値に近い順)" tone="var(--color-border-default)" rows={positionSummary.typical} empty="P25–P75内の指標はありません" />
              <div className="min-w-0 border-t-2 border-[var(--color-market-red)] bg-white px-2.5 py-2">
                <div className="text-[10px] font-black text-[var(--color-text-secondary)]">近い銘柄 <span className="font-semibold text-[var(--color-text-tertiary)]">{closestGroup?.label ?? ''}</span></div>
                {closestPeers.length === 0 ? (
                  <div className="mt-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">候補はありません</div>
                ) : (
                  <ol className="m-0 mt-1 grid gap-0.5 p-0">
                    {closestPeers.map((candidate) => {
                      const match = stageMatch(baseCompany?.stageCode, candidate.stageCode)
                      return (
                        <li key={candidate.ticker} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2 text-[10px] leading-4">
                          <span className="min-w-0 truncate">
                            <span className="font-mono font-black text-[var(--color-brand-800)]">{candidate.ticker}</span>
                            <span className="ml-1 font-bold text-[var(--color-text-primary)]">{candidate.name ?? '名称未取得'}</span>
                          </span>
                          <span className="whitespace-nowrap font-mono text-[9px] font-bold text-[var(--color-text-secondary)]">
                            {candidate.score == null ? '分類一致' : `類似 ${candidate.score.toFixed(1)}`}
                            {match && <span className="ml-1 text-[var(--color-text-tertiary)]">Stage {match.same}/{match.total}</span>}
                          </span>
                        </li>
                      )
                    })}
                  </ol>
                )}
              </div>
            </div>
          </section>

          <section className="border-b border-[var(--color-border-default)] px-3 py-3 sm:px-4" aria-labelledby="peer-band-title">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <h3 id="peer-band-title" className="text-[11px] font-black text-[var(--color-text-primary)]">
                指標ごとの位置 <span className="font-semibold text-[var(--color-text-tertiary)]">{model.sectorDistribution.groupName ?? '分類なし'}</span>
              </h3>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] font-semibold text-[var(--color-text-tertiary)]" aria-label="凡例">
                <span className="inline-flex items-center gap-1"><i className="inline-block h-3 w-[3px] bg-[var(--color-market-red)]" />対象 {baseCompany?.ticker ?? ticker.replace('.T', '')}</span>
                <span className="inline-flex items-center gap-1"><i className="inline-block h-2.5 w-4 bg-[var(--color-brand-100)]" />P25–P75</span>
                <span className="inline-flex items-center gap-1"><i className="inline-block h-3 w-px bg-[var(--color-brand-900)]" />中央値</span>
                <span className="inline-flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-[var(--color-text-tertiary)]" />比較銘柄</span>
                <span className="inline-flex items-center gap-1">◀▶ 目盛り外</span>
              </div>
            </div>
            {bandSections.length === 0 ? (
              <div className="border border-dashed border-[var(--color-border-default)] px-3 py-4 text-center text-[10px] font-semibold text-[var(--color-text-tertiary)]">分布と比べられる指標がありません</div>
            ) : (
              <div className="grid gap-x-8 gap-y-3 lg:grid-cols-2">
                {bandSections.map((section) => (
                  <div key={section.label} className="min-w-0">
                    <div className="mb-0.5 text-[9px] font-black text-[var(--color-brand-900)]">{section.label}</div>
                    <div className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
                      {section.rows.map((row) => (
                        <PeerPositionRow
                          key={row.metric.key}
                          label={row.metric.label}
                          p25={row.p25}
                          median={row.median}
                          p75={row.p75}
                          target={row.target}
                          peers={row.peers}
                          medianText={fmtNumber(row.median, row.metric.format, true)}
                          summary={`対象${row.target.text}(${PEER_ZONE_LABELS[row.zone]})、P25 ${fmtNumber(row.p25, row.metric.format)}、中央値 ${fmtNumber(row.median, row.metric.format)}、P75 ${fmtNumber(row.p75, row.metric.format)}`}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="border-b border-[var(--color-border-default)] px-3 py-3 sm:px-4">
            <div className="mb-2 text-[11px] font-black text-[var(--color-text-primary)]">比較銘柄を選ぶ</div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="類似候補の種類">
                {CANDIDATE_KINDS.map((item) => {
                  const count = model.candidateGroups.find((group) => group.kind === item.kind)?.candidates.length ?? 0
                  return (
                    <button
                      key={item.kind}
                      type="button"
                      onClick={() => setActiveKind(item.kind)}
                      className={`h-8 shrink-0 border px-3 text-[10px] font-black ${activeKind === item.kind ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'}`}
                      role="tab"
                      aria-selected={activeKind === item.kind}
                    >
                      {item.short} <span className="font-mono opacity-75">{count}</span>
                    </button>
                  )
                })}
              </div>
              <span className="shrink-0 text-[9px] font-semibold text-[var(--color-text-tertiary)]">選択 {selected.length}/8</span>
            </div>
            <p className="mt-2 text-[9px] font-semibold text-[var(--color-text-tertiary)]">{activeGroup?.description}</p>
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
              {activeGroup?.candidates.map((candidate) => (
                <CandidateButton
                  key={candidate.ticker}
                  candidate={candidate}
                  selected={selectedSet.has(candidate.ticker)}
                  disabled={selected.length >= 8}
                  baseStageCode={baseCompany?.stageCode ?? null}
                  onToggle={() => toggleCandidate(candidate)}
                />
              ))}
              {activeGroup?.candidates.length === 0 && <div className="py-3 text-[10px] font-semibold text-[var(--color-text-tertiary)]">この基準日に該当する候補はありません</div>}
            </div>
          </div>

          <div className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 sm:px-4">
            <div className="flex items-center gap-1.5 overflow-x-auto">
              <span className="shrink-0 text-[9px] font-black text-[var(--color-text-tertiary)]">比較中</span>
              {model.companies.map((company) => (
                <span key={company.ticker} className={`inline-flex h-7 shrink-0 items-center gap-1 border px-2 text-[9px] font-bold ${company.isBase ? 'border-[var(--color-market-red)] bg-white text-[var(--color-text-primary)]' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'}`}>
                  {company.isBase && <span className="bg-[var(--color-market-red)] px-1 text-[8px] font-black text-white">対象</span>}
                  <span className="font-mono font-black">{company.ticker}</span>
                  <span className="max-w-24 truncate">{company.name}</span>
                  {!company.isBase && stageMatchByTicker.has(company.ticker) && (
                    <span className="font-mono text-[8px] text-[var(--color-text-tertiary)]" title="対象と6ステージが一致した軸数">
                      Stage {stageMatchByTicker.get(company.ticker)?.same}/{stageMatchByTicker.get(company.ticker)?.total}
                    </span>
                  )}
                  {!company.isBase && (
                    <button type="button" onClick={() => setSelected((current) => current.filter((code) => code !== company.ticker))} title="比較から外す" aria-label={`${company.ticker}を比較から外す`}>
                      <X size={11} />
                    </button>
                  )}
                </span>
              ))}
              <button type="button" onClick={() => setSelected(model.recommendations)} className="inline-flex h-7 shrink-0 items-center gap-1 px-2 text-[9px] font-bold text-[var(--color-text-tertiary)] hover:bg-white">
                <RotateCcw size={11} />初期選択に戻す
              </button>
              {loading && <LoaderCircle size={13} className="ml-1 animate-spin text-[var(--color-brand-700)]" />}
            </div>
          </div>

          <details className="group border-b border-[var(--color-border-default)]">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-[11px] font-black text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-brand-700)] sm:px-4 [&::-webkit-details-marker]:hidden">
              <ChevronRight size={13} className="transition-transform group-open:rotate-90" aria-hidden="true" />
              数値表(全指標・全銘柄)
              <span className="ml-auto font-mono text-[9px] font-semibold text-[var(--color-text-tertiary)]">{model.companies.length}社</span>
            </summary>
          <div className="overflow-x-auto border-t border-[var(--color-border-soft)]" aria-label="銘柄比較表">
            <table className="min-w-max border-collapse text-[10px]">
              <thead className="sticky top-0 z-10 bg-white">
                <tr>
                  <th className="sticky left-0 z-20 min-w-32 border-b border-r border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-left text-[9px] font-black text-[var(--color-text-secondary)]">比較指標</th>
                  {model.companies.map((company) => (
                    <th key={company.ticker} className={`min-w-36 border-b border-r border-[var(--color-border-default)] px-3 py-2 text-center ${company.isBase ? 'border-t-[3px] border-t-[var(--color-market-red)] bg-[var(--color-brand-50)]' : 'bg-white'}`}>
                      {company.isBase && <span className="mb-0.5 inline-block bg-[var(--color-market-red)] px-1 text-[8px] font-black text-white">対象</span>}
                      <Link href={`/stock/${company.ticker}${analysisDate ? `?date=${encodeURIComponent(analysisDate)}` : ''}#ml`} className="font-mono text-[11px] font-black text-[var(--color-brand-800)] hover:underline">
                        {company.ticker} <ChevronRight size={10} className="inline" />
                      </Link>
                      <div className="mt-0.5 max-w-32 truncate text-[9px] font-bold text-[var(--color-text-primary)]">{company.name}</div>
                      <StageStrip company={company} />
                    </th>
                  ))}
                  <th className="min-w-40 border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-left">
                    <span className="block text-[9px] font-black text-[var(--color-text-secondary)]">33業種分布</span>
                    <span className="block max-w-36 truncate text-[8px] font-semibold text-[var(--color-text-tertiary)]">{model.sectorDistribution.groupName ?? '分類なし'}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {METRIC_SECTIONS.map((section) => [
                  <tr key={`${section.label}-heading`}>
                    <th colSpan={model.companies.length + 2} className="border-y border-[var(--color-border-default)] bg-[var(--color-brand-50)] px-3 py-1.5 text-left text-[9px] font-black text-[var(--color-brand-900)]">{section.label}</th>
                  </tr>,
                  ...section.rows.map((metric) => (
                    <tr key={metric.key} className="hover:bg-[var(--color-surface-subtle)]">
                      <th className="sticky left-0 z-[5] border-b border-r border-[var(--color-border-soft)] bg-white px-3 py-2 text-left font-bold text-[var(--color-text-secondary)]">{metric.label}</th>
                      {model.companies.map((company) => {
                        const value = company.metrics[metric.key]
                        return (
                          <td key={company.ticker} className={`border-b border-r border-[var(--color-border-soft)] px-3 py-2 text-right font-mono font-black ${company.isBase ? 'bg-[var(--color-brand-50)] text-[var(--color-brand-900)]' : 'text-[var(--color-text-primary)]'}`} title={value.reason ?? `${value.source} / ${value.asOf ?? model.asOf}`}>
                            {fmtValue(value, metric.format)}
                          </td>
                        )
                      })}
                      <td className="border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-1.5">
                        <DistributionCell distribution={model.sectorDistribution.metrics[metric.key]} format={metric.format} />
                      </td>
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          </div>
          </details>

          <div className="grid">
            <div className="min-w-0 px-3 py-3 sm:px-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <BarChart3 size={14} className="text-[var(--color-brand-700)]" />
                  <h3 className="text-[11px] font-black text-[var(--color-text-primary)]">関係を見る</h3>
                </div>
                <div className="flex max-w-full gap-1 overflow-x-auto" role="tablist" aria-label="散布図指標">
                  {SCATTER_OPTIONS.map((option) => (
                    <button key={option.id} type="button" onClick={() => setScatterId(option.id)} role="tab" aria-selected={scatterId === option.id} className={`h-7 shrink-0 border px-2 text-[9px] font-bold ${scatterId === option.id ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'}`}>
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="h-[230px] min-w-0">
                {scatterData.length >= 2 ? (
                  <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={180}>
                    <ScatterChart margin={{ top: 18, right: 18, bottom: 12, left: 4 }}>
                      <CartesianGrid stroke="var(--color-border-soft)" strokeDasharray="3 3" />
                      <XAxis type="number" dataKey="x" name={scatterOption.xLabel} tick={{ fontSize: 9 }} tickFormatter={(value) => fmtNumber(Number(value), scatterOption.xFormat, true)} />
                      <YAxis type="number" dataKey="y" name={scatterOption.yLabel} tick={{ fontSize: 9 }} tickFormatter={(value) => fmtNumber(Number(value), scatterOption.yFormat, true)} width={52} />
                      <Tooltip cursor={{ strokeDasharray: '3 3' }} formatter={(value, name) => fmtNumber(Number(value), name === 'x' ? scatterOption.xFormat : scatterOption.yFormat, true)} labelFormatter={(_, payload) => payload?.[0]?.payload?.name ?? ''} />
                      <Scatter data={scatterData}>
                        {scatterData.map((point) => <Cell key={point.ticker} fill={point.isBase ? 'var(--color-market-red)' : 'var(--color-text-tertiary)'} stroke={point.isBase ? 'var(--color-market-red)' : 'white'} strokeWidth={point.isBase ? 4 : 1.5} />)}
                        <LabelList dataKey="ticker" position="top" fontSize={9} fontWeight={800} fill="var(--color-text-secondary)" />
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-full items-center justify-center border border-dashed border-[var(--color-border-default)] text-[10px] font-semibold text-[var(--color-text-tertiary)]">この組合せを描ける銘柄が2社未満です。</div>
                )}
              </div>
            </div>
          </div>
          <footer
            className="flex flex-wrap gap-x-4 gap-y-0.5 border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-1.5 font-mono text-[9px] font-semibold text-[var(--color-text-tertiary)] sm:px-4"
            title="財務類似は共有できた指標だけで計算し、欠損を0に置き換えません"
          >
            <span>基準日 {model.asOf}</span>
            <span>評価 {model.valuationDate ?? '—'}</span>
            <span>構造 {model.structureDate ?? '—'}</span>
            <span>財務候補 {model.coverage.financialFeatureUniverse.toLocaleString()}社</span>
            <span>同業母数 {model.coverage.sectorPeers}社</span>
          </footer>
        </>
      )}
    </section>
  )
}
