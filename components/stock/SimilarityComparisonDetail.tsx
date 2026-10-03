'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  Check,
  ChevronRight,
  GitCompareArrows,
  Info,
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
    label: 'Quality',
    rows: [
      { key: 'operatingMargin', label: '営業利益率', format: 'percent' },
      { key: 'roe', label: 'ROE', format: 'percent' },
      { key: 'roa', label: 'ROA', format: 'percent' },
      { key: 'standardFcf', label: '標準FCF', format: 'currency' },
    ],
  },
  {
    label: 'Valuation',
    rows: [
      { key: 'forwardPer', label: 'Forward PER', format: 'multiple' },
      { key: 'pbr', label: 'PBR', format: 'multiple' },
      { key: 'fcfYield', label: 'FCF Yield', format: 'percent' },
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
  { id: 'growth-forward', label: '成長 × Forward PER', x: 'revenueGrowth' as const, y: 'forwardPer' as const, xLabel: '売上成長率', yLabel: 'Forward PER', xFormat: 'percent' as const, yFormat: 'multiple' as const },
  { id: 'fcf-roe', label: 'FCF Yield × ROE', x: 'fcfYield' as const, y: 'roe' as const, xLabel: 'FCF Yield', yLabel: 'ROE', xFormat: 'percent' as const, yFormat: 'percent' as const },
  { id: 'structure-forward', label: '構造 × Forward PER', x: 'sectorStructureScore' as const, y: 'forwardPer' as const, xLabel: '業種構造', yLabel: 'Forward PER', xFormat: 'score' as const, yFormat: 'multiple' as const },
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

function CandidateButton({
  candidate,
  selected,
  disabled,
  onToggle,
}: {
  candidate: SimilarityCandidate
  selected: boolean
  disabled: boolean
  onToggle: () => void
}) {
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
      <span className="mt-1 block text-[9px] font-semibold text-[var(--color-text-tertiary)]">{candidate.reason}</span>
      <span className="mt-1 flex items-center justify-between gap-2 font-mono text-[9px] font-bold text-[var(--color-text-secondary)]">
        <span>{candidate.score == null ? '分類一致' : `類似 ${candidate.score.toFixed(1)}`}</span>
        <span>{candidate.coveragePercent == null ? candidate.stageCode ?? '------' : `比較 ${candidate.coveragePercent.toFixed(0)}%`}</span>
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
    return x == null || y == null ? [] : [{ ticker: company.ticker, name: company.name ?? company.ticker, x, y, isBase: company.isBase }]
  }), [model, scatterOption])

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
            <h2 id="similarity-comparison-title" className="text-[13px] font-black text-[var(--color-brand-900)]">類似・比較</h2>
            <p className="mt-0.5 text-[9px] font-semibold text-[var(--color-text-tertiary)]">似ている理由を分けて、同じ基準日で横比較</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] font-bold text-[var(--color-text-tertiary)]">基準日 {model?.asOf ?? analysisDate ?? '---'}</span>
          <button
            type="button"
            onClick={() => model && setSelected(model.recommendations)}
            disabled={!model || loading}
            className="inline-flex h-8 items-center gap-1.5 bg-[var(--color-brand-700)] px-3 text-[10px] font-black text-white hover:bg-[var(--color-brand-800)] disabled:opacity-60"
          >
            <GitCompareArrows size={13} />この銘柄を基準に比較
          </button>
        </div>
      </header>

      {error && <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-[10px] font-bold text-red-800">{error}</div>}
      {!model && loading && (
        <div className="flex min-h-32 items-center justify-center gap-2 text-[11px] font-bold text-[var(--color-text-tertiary)]">
          <LoaderCircle size={15} className="animate-spin" />候補と比較指標を準備中
        </div>
      )}

      {model && (
        <>
          <div className="border-b border-[var(--color-border-default)] px-3 py-3 sm:px-4">
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
                  onToggle={() => toggleCandidate(candidate)}
                />
              ))}
              {activeGroup?.candidates.length === 0 && <div className="py-3 text-[10px] font-semibold text-[var(--color-text-tertiary)]">この基準日で表示できる候補はありません。</div>}
            </div>
          </div>

          <div className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 sm:px-4">
            <div className="flex items-center gap-1.5 overflow-x-auto">
              {model.companies.map((company) => (
                <span key={company.ticker} className={`inline-flex h-7 shrink-0 items-center gap-1 border px-2 text-[9px] font-bold ${company.isBase ? 'border-[var(--color-brand-700)] bg-white text-[var(--color-brand-900)]' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'}`}>
                  <span className="font-mono font-black">{company.ticker}</span>
                  <span className="max-w-24 truncate">{company.name}</span>
                  {!company.isBase && (
                    <button type="button" onClick={() => setSelected((current) => current.filter((code) => code !== company.ticker))} title="比較から外す" aria-label={`${company.ticker}を比較から外す`}>
                      <X size={11} />
                    </button>
                  )}
                </span>
              ))}
              <button type="button" onClick={() => setSelected(model.recommendations)} className="inline-flex h-7 shrink-0 items-center gap-1 px-2 text-[9px] font-bold text-[var(--color-text-tertiary)] hover:bg-white">
                <RotateCcw size={11} />推奨へ戻す
              </button>
              {loading && <LoaderCircle size={13} className="ml-1 animate-spin text-[var(--color-brand-700)]" />}
            </div>
          </div>

          <div className="overflow-x-auto" aria-label="銘柄比較表">
            <table className="min-w-max border-collapse text-[10px]">
              <thead className="sticky top-0 z-10 bg-white">
                <tr>
                  <th className="sticky left-0 z-20 min-w-32 border-b border-r border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-left text-[9px] font-black text-[var(--color-text-secondary)]">比較指標</th>
                  {model.companies.map((company) => (
                    <th key={company.ticker} className={`min-w-36 border-b border-r border-[var(--color-border-default)] px-3 py-2 text-center ${company.isBase ? 'bg-[var(--color-brand-50)]' : 'bg-white'}`}>
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

          <div className="grid border-t border-[var(--color-border-default)] lg:grid-cols-[minmax(0,1fr)_230px]">
            <div className="min-w-0 px-3 py-3 sm:px-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <BarChart3 size={14} className="text-[var(--color-brand-700)]" />
                  <h3 className="text-[11px] font-black text-[var(--color-text-primary)]">関係を見る</h3>
                </div>
                <div className="flex max-w-full gap-1 overflow-x-auto" role="tablist" aria-label="散布図指標">
                  {SCATTER_OPTIONS.map((option) => (
                    <button key={option.id} type="button" onClick={() => setScatterId(option.id)} className={`h-7 shrink-0 border px-2 text-[9px] font-bold ${scatterId === option.id ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'}`}>
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
                        {scatterData.map((point) => <Cell key={point.ticker} fill={point.isBase ? 'var(--color-market-red)' : 'var(--color-brand-600)'} stroke="white" strokeWidth={1.5} />)}
                        <LabelList dataKey="ticker" position="top" fontSize={9} fontWeight={800} fill="var(--color-text-secondary)" />
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-full items-center justify-center border border-dashed border-[var(--color-border-default)] text-[10px] font-semibold text-[var(--color-text-tertiary)]">この組合せを描ける銘柄が2社未満です。</div>
                )}
              </div>
            </div>
            <aside className="border-t border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-3 lg:border-l lg:border-t-0">
              <h3 className="text-[10px] font-black text-[var(--color-text-primary)]">比較条件</h3>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[9px]">
                <dt className="font-semibold text-[var(--color-text-tertiary)]">基準日</dt><dd className="font-mono font-bold text-[var(--color-text-secondary)]">{model.asOf}</dd>
                <dt className="font-semibold text-[var(--color-text-tertiary)]">Valuation</dt><dd className="font-mono font-bold text-[var(--color-text-secondary)]">{model.valuationDate ?? '—'}</dd>
                <dt className="font-semibold text-[var(--color-text-tertiary)]">構造</dt><dd className="font-mono font-bold text-[var(--color-text-secondary)]">{model.structureDate ?? '—'}</dd>
                <dt className="font-semibold text-[var(--color-text-tertiary)]">財務候補</dt><dd className="font-mono font-bold text-[var(--color-text-secondary)]">{model.coverage.financialFeatureUniverse.toLocaleString()}社</dd>
                <dt className="font-semibold text-[var(--color-text-tertiary)]">同業母数</dt><dd className="font-mono font-bold text-[var(--color-text-secondary)]">{model.coverage.sectorPeers}社</dd>
              </dl>
              <p className="mt-3 flex gap-1.5 text-[8px] font-semibold leading-4 text-[var(--color-text-tertiary)]"><Info size={11} className="mt-0.5 shrink-0" />財務類似は共有できた指標だけで計算し、欠損を0に置き換えません。「比較%」は使えた重みの割合です。</p>
            </aside>
          </div>
        </>
      )}
    </section>
  )
}
