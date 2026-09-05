'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  CircleDollarSign,
  History,
  Info,
  Repeat2,
  ShieldCheck,
  WalletCards,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type {
  DividendDirection,
  DividendForecastRevision,
  DividendHistoryRow,
  ShareholderReturnsReadModel,
  ShareholderReturnValue,
} from '@/lib/shareholder-returns'

interface ShareholderReturnsDetailProps {
  ticker: string
  analysisDate: string | null
}

type HistoryWindow = '3y' | '5y' | '10y' | 'all'

const WINDOWS: Array<{ id: HistoryWindow; label: string; years: number | null }> = [
  { id: '3y', label: '3年', years: 3 },
  { id: '5y', label: '5年', years: 5 },
  { id: '10y', label: '10年', years: 10 },
  { id: 'all', label: '全期間', years: null },
]

function returnsUrl(ticker: string, analysisDate: string | null): string {
  return `/api/shareholder-returns/${encodeURIComponent(ticker)}${analysisDate ? `?as_of=${encodeURIComponent(analysisDate)}` : ''}`
}

function compactCurrency(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1e12) return `${(value / 1e12).toFixed(2)}兆円`
  if (absolute >= 1e8) return `${(value / 1e8).toFixed(1)}億円`
  if (absolute >= 1e4) return `${(value / 1e4).toFixed(0)}万円`
  return `${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}円`
}

function unavailableText(value: ShareholderReturnValue): string {
  if (value.availability === 'not_applicable') return 'N/A'
  if (value.availability === 'not_meaningful') return 'N/M'
  return '—'
}

function valueText(value: ShareholderReturnValue): string {
  if (value.value == null) return unavailableText(value)
  if (value.unit === 'PERCENT') return `${value.value.toFixed(1)}%`
  if (value.unit === 'JPY_PER_SHARE') return `¥${value.value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}`
  if (value.unit === 'MULTIPLE') return `${value.value.toFixed(2)}x`
  if (value.unit === 'YEARS') return `${value.value.toFixed(0)}年`
  if (value.unit === 'COUNT') return `${value.value.toFixed(0)}回`
  if (value.unit === 'JPY') return compactCurrency(value.value)
  return value.value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function signedValue(value: number | null, suffix = ''): string {
  if (value == null) return '—'
  return `${value > 0 ? '+' : ''}${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}${suffix}`
}

function directionLabel(direction: DividendDirection): string {
  if (direction === 'increase') return '増配'
  if (direction === 'unchanged') return '据え置き'
  if (direction === 'decrease') return '減配'
  if (direction === 'no_dividend') return '無配'
  if (direction === 'resumed') return '復配'
  return '判定なし'
}

function directionMark(direction: DividendDirection): string {
  if (direction === 'increase') return '▲'
  if (direction === 'decrease') return '▼'
  if (direction === 'resumed') return '↗'
  if (direction === 'no_dividend') return '—'
  if (direction === 'unchanged') return '→'
  return '·'
}

function revisionLabel(row: DividendForecastRevision): string {
  if (row.direction === 'increase') return '上方修正'
  if (row.direction === 'decrease') return '下方修正'
  if (row.direction === 'unchanged') return '据え置き'
  if (row.direction === 'basis_change') return '株式単位変更の可能性'
  return '初回予想'
}

export function ShareholderReturnsDetail({ ticker, analysisDate }: ShareholderReturnsDetailProps) {
  const [model, setModel] = useState<ShareholderReturnsReadModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [window, setWindow] = useState<HistoryWindow>('5y')
  const [showAllRevisions, setShowAllRevisions] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    fetch(returnsUrl(ticker, analysisDate), { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((payload: ShareholderReturnsReadModel) => {
        if (!controller.signal.aborted) setModel(payload)
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [analysisDate, ticker])

  const visibleRows = useMemo(() => {
    if (!model) return []
    const option = WINDOWS.find((item) => item.id === window)!
    if (!option.years) return model.history.rows
    const latestActualYear = model.history.rows
      .filter((row) => row.actualDps.availability === 'available')
      .map((row) => row.fiscalYear)
      .sort((a, b) => b - a)[0]
    if (!latestActualYear) return model.history.rows
    const fromYear = latestActualYear - option.years + 1
    return model.history.rows.filter((row) => (
      row.fiscalYear >= fromYear || row.forecastDps.availability === 'available'
    ))
  }, [model, window])

  if (loading) {
    return <div className="grid min-h-72 place-items-center border border-[var(--color-border-default)] bg-white text-[11px] font-bold text-[var(--color-text-tertiary)]">株主還元を読み込んでいます...</div>
  }
  if (error || !model) {
    return <div className="grid min-h-48 place-items-center border border-[var(--color-border-default)] bg-white px-4 text-center text-[11px] font-bold text-[var(--color-text-tertiary)]">株主還元データを取得できませんでした。</div>
  }

  return (
    <section className="space-y-3" aria-labelledby="shareholder-returns-title">
      <header className="flex flex-wrap items-start justify-between gap-2 border border-[var(--color-border-default)] bg-[var(--color-brand-50)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <WalletCards size={17} className="shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />
          <div>
            <h2 id="shareholder-returns-title" className="text-[13px] font-black text-[var(--color-brand-900)]">株主還元</h2>
            <p className="text-[9px] font-semibold text-[var(--color-text-tertiary)]">配当の推移・会社予想・持続可能性を同じ基準日で確認</p>
          </div>
        </div>
        <div className="text-right font-mono text-[9px] font-bold text-[var(--color-text-tertiary)]">
          <div>分析基準日 {model.asOf}</div>
          <div>価格日 {model.priceDate ?? '—'}</div>
        </div>
      </header>

      <CurrentReturns model={model} />
      <DividendDirectionSummary model={model} />
      <DividendHistory model={model} rows={visibleRows} window={window} onWindowChange={setWindow} />
      <ForecastRevisionHistory
        rows={model.forecastRevisions}
        showAll={showAllRevisions}
        onToggle={() => setShowAllRevisions((value) => !value)}
      />
      <div className="grid gap-3 xl:grid-cols-2">
        <Sustainability model={model} />
        <BuybacksAndTotalReturns model={model} />
      </div>
      <DefinitionNotes model={model} />
    </section>
  )
}

function CurrentReturns({ model }: { model: ShareholderReturnsReadModel }) {
  const primary: Array<[string, ShareholderReturnValue, string]> = [
    ['予想配当利回り', model.current.forecastDividendYield, '会社予想DPS ÷ 基準日株価'],
    ['予想DPS', model.current.forecastDps, '指定日時点の直近会社予想'],
    ['配当性向', model.current.payoutRatio, '直近FY実績'],
  ]
  const secondary: Array<[string, ShareholderReturnValue]> = [
    ['直近実績DPS', model.current.actualDps],
    ['DPS前年比', model.current.dpsYoY],
    ['FCF Yield', model.current.fcfYield],
  ]
  return (
    <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="current-returns-title">
      <SectionHeading icon={CircleDollarSign} id="current-returns-title" title="現在の還元" subtitle="予想と実績を混同せず、欠損はゼロ補完しない" />
      <div className="grid grid-cols-3 gap-px bg-[var(--color-border-soft)]">
        {primary.map(([label, value, note]) => (
          <article key={label} className="min-w-0 bg-white px-2.5 py-3 sm:px-4">
            <div className="truncate text-[8px] font-black text-[var(--color-text-secondary)] sm:text-[9px]">{label}</div>
            <div className="mt-1 font-mono text-[15px] font-black text-[var(--color-text-primary)] sm:text-[19px]">{valueText(value)}</div>
            <div className="mt-1 line-clamp-2 text-[7px] font-semibold leading-3 text-[var(--color-text-tertiary)] sm:text-[8px]">{value.value == null ? value.reason : note}</div>
          </article>
        ))}
      </div>
      <div className="grid grid-cols-3 border-t border-[var(--color-border-default)] bg-[var(--color-surface-subtle)]">
        {secondary.map(([label, value]) => (
          <div key={label} className="min-w-0 border-r border-[var(--color-border-soft)] px-2.5 py-2 last:border-r-0 sm:px-4">
            <div className="truncate text-[7px] font-bold text-[var(--color-text-tertiary)] sm:text-[8px]">{label}</div>
            <div className="mt-0.5 truncate font-mono text-[11px] font-black text-[var(--color-text-primary)] sm:text-[12px]">{valueText(value)}</div>
          </div>
        ))}
      </div>
      {model.isFinancialSector && (
        <p className="border-t border-[var(--color-border-default)] px-4 py-2 text-[8px] font-semibold text-[var(--color-text-secondary)]">
          金融業では配当指標を表示し、通常企業用の標準FCF・FCF YieldはN/Aとしています。
        </p>
      )}
    </section>
  )
}

function DividendDirectionSummary({ model }: { model: ShareholderReturnsReadModel }) {
  const values: Array<[string, ShareholderReturnValue]> = [
    ['連続増配', model.direction.consecutiveIncreaseYears],
    ['連続非減配', model.direction.consecutiveNonDecreaseYears],
    ['5年減配回数', model.direction.cutsLast5Years],
    ['DPS 3年CAGR', model.direction.dpsCagr3y],
    ['DPS 5年CAGR', model.direction.dpsCagr5y],
  ]
  return (
    <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="dividend-direction-title">
      <SectionHeading icon={Repeat2} id="dividend-direction-title" title="配当の方向性" subtitle="株式分割を補正した実績DPSで判定" />
      <div className="grid grid-cols-2 gap-px bg-[var(--color-border-soft)] sm:grid-cols-5">
        {values.map(([label, value]) => (
          <div key={label} className="bg-white px-3 py-2.5">
            <div className="text-[8px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
            <div className="mt-0.5 font-mono text-[14px] font-black text-[var(--color-text-primary)]">{valueText(value)}</div>
          </div>
        ))}
      </div>
      {model.history.adjustments.length > 0 && (
        <div className="border-t border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[8px] font-semibold text-[var(--color-text-secondary)]">
          補正検出: {model.history.adjustments.map((item) => `FY${item.fromFiscalYear}→FY${item.toFiscalYear} ${item.factor}倍`).join(' / ')}
        </div>
      )}
    </section>
  )
}

function DividendHistory({
  model,
  rows,
  window,
  onWindowChange,
}: {
  model: ShareholderReturnsReadModel
  rows: DividendHistoryRow[]
  window: HistoryWindow
  onWindowChange: (window: HistoryWindow) => void
}) {
  const chartData = rows.map((row) => ({
    fiscalYear: `FY${row.fiscalYear}`,
    actualDps: row.actualDps.value ?? undefined,
    forecastDps: row.forecastDps.value ?? undefined,
  }))
  return (
    <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="dividend-history-title">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <History size={15} className="text-[var(--color-brand-700)]" aria-hidden="true" />
          <div>
            <h3 id="dividend-history-title" className="text-[11px] font-black text-[var(--color-text-primary)]">配当履歴</h3>
            <p className="text-[8px] font-semibold text-[var(--color-text-tertiary)]">実績DPSは塗り、会社予想DPSは白抜きの破線</p>
          </div>
        </div>
        <div className="inline-flex border border-[var(--color-border-default)] bg-white">
          {WINDOWS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onWindowChange(option.id)}
              className={`h-7 border-r border-[var(--color-border-default)] px-2 text-[9px] font-black last:border-r-0 ${window === option.id ? 'bg-[var(--color-brand-900)] text-white' : 'text-[var(--color-text-secondary)]'}`}
              aria-pressed={window === option.id}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="h-56 min-w-0 px-1 pt-3 sm:h-64 sm:px-4">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={0}
          initialDimension={{ width: 320, height: 224 }}
        >
          <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }} barCategoryGap="24%">
            <CartesianGrid stroke="var(--color-border-soft)" vertical={false} />
            <XAxis dataKey="fiscalYear" tick={{ fontSize: 8, fill: 'var(--color-text-tertiary)', fontWeight: 700 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 8, fill: 'var(--color-text-tertiary)' }} tickLine={false} axisLine={false} width={38} />
            <Tooltip
              formatter={(value, name) => [`¥${Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}`, name === 'actualDps' ? '実績DPS' : '会社予想DPS']}
              labelStyle={{ fontSize: 10, fontWeight: 800 }}
              contentStyle={{ fontSize: 9, borderRadius: 0, borderColor: 'var(--color-border-default)' }}
            />
            <Legend wrapperStyle={{ fontSize: 9, fontWeight: 700 }} formatter={(value) => value === 'actualDps' ? '実績DPS' : '会社予想DPS'} />
            <Bar dataKey="actualDps" fill="var(--color-brand-700)" maxBarSize={34} />
            <Bar dataKey="forecastDps" fill="white" stroke="var(--color-market-red)" strokeWidth={2} strokeDasharray="4 2" maxBarSize={34} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="overflow-x-auto border-t border-[var(--color-border-default)]">
        <table className="w-full min-w-[760px] border-collapse text-left">
          <thead className="bg-[var(--color-surface-subtle)] text-[8px] font-black text-[var(--color-text-secondary)]">
            <tr>
              <th className="px-3 py-2">年度</th>
              <th className="px-3 py-2 text-right">DPS</th>
              <th className="px-3 py-2">方向</th>
              <th className="px-3 py-2 text-right">EPS</th>
              <th className="px-3 py-2 text-right">配当性向</th>
              <th className="px-3 py-2 text-right">期末株価ベース利回り</th>
              <th className="px-3 py-2">公表日</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)] text-[9px]">
            {rows.map((row) => {
              const forecast = row.forecastDps.availability === 'available'
              return (
                <tr key={row.key} className={forecast ? 'bg-[var(--color-price-up-bg)]' : 'bg-white'}>
                  <td className="px-3 py-2 font-mono font-black text-[var(--color-text-primary)]">FY{row.fiscalYear}</td>
                  <td className="px-3 py-2 text-right font-mono font-black">
                    {forecast ? `${valueText(row.forecastDps)} 予想` : valueText(row.actualDps)}
                  </td>
                  <td className="px-3 py-2 font-bold text-[var(--color-text-secondary)]">
                    {forecast ? (row.forecastScope === 'next_fy' ? '翌期予想' : '当期予想') : `${directionMark(row.direction)} ${directionLabel(row.direction)}`}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{valueText(row.eps)}</td>
                  <td className="px-3 py-2 text-right font-mono">{valueText(row.payoutRatio)}</td>
                  <td className="px-3 py-2 text-right font-mono">{valueText(row.dividendYield)}</td>
                  <td className="px-3 py-2 font-mono text-[8px] text-[var(--color-text-tertiary)]">{row.publishedAt ? row.publishedAt.slice(0, 10) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-[var(--color-border-default)] px-3 py-2 text-[7px] font-semibold text-[var(--color-text-tertiary)]">
        {model.history.adjustmentMethod} 期末株価ベース利回りは比較用の実績値で、現在の予想利回りとは定義が異なります。
      </p>
    </section>
  )
}

function ForecastRevisionHistory({
  rows,
  showAll,
  onToggle,
}: {
  rows: DividendForecastRevision[]
  showAll: boolean
  onToggle: () => void
}) {
  const visible = showAll ? rows : rows.slice(0, 12)
  return (
    <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="forecast-revision-title">
      <SectionHeading icon={History} id="forecast-revision-title" title="PIT配当予想の修正履歴" subtitle="公表日ごとの予想を保持し、当期・翌期を区別" />
      {visible.length === 0 ? (
        <div className="px-4 py-6 text-center text-[9px] font-semibold text-[var(--color-text-tertiary)]">指定日時点で配当予想履歴はありません。</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead className="bg-[var(--color-surface-subtle)] text-[8px] font-black text-[var(--color-text-secondary)]">
              <tr>
                <th className="px-3 py-2">公表日</th>
                <th className="px-3 py-2">対象年度</th>
                <th className="px-3 py-2">区分</th>
                <th className="px-3 py-2 text-right">前回予想</th>
                <th className="px-3 py-2 text-right">今回予想</th>
                <th className="px-3 py-2 text-right">修正額</th>
                <th className="px-3 py-2 text-right">修正率</th>
                <th className="px-3 py-2">判定</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)] text-[9px]">
              {visible.map((row) => (
                <tr key={row.key}>
                  <td className="px-3 py-2 font-mono">{row.publishedAt.slice(0, 10)}</td>
                  <td className="px-3 py-2 font-mono font-black">FY{row.targetFiscalYear}</td>
                  <td className="px-3 py-2">{row.forecastScope === 'next_fy' ? '翌期' : '当期'}</td>
                  <td className="px-3 py-2 text-right font-mono">{row.previousValue == null ? '—' : `¥${row.previousValue.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}`}</td>
                  <td className="px-3 py-2 text-right font-mono font-black">¥{row.value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}</td>
                  <td className="px-3 py-2 text-right font-mono">{row.changeAmount == null ? '—' : signedValue(row.changeAmount, '円')}</td>
                  <td className="px-3 py-2 text-right font-mono">{row.changePercent == null ? '—' : signedValue(row.changePercent, '%')}</td>
                  <td className="px-3 py-2 font-bold text-[var(--color-text-secondary)]">{revisionLabel(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 12 && (
        <button type="button" onClick={onToggle} className="w-full border-t border-[var(--color-border-default)] py-2 text-[9px] font-black text-[var(--color-brand-700)]">
          {showAll ? '最新12件に戻す' : `全${rows.length}件を表示`}
        </button>
      )}
    </section>
  )
}

function Sustainability({ model }: { model: ShareholderReturnsReadModel }) {
  const values: Array<[string, ShareholderReturnValue, string]> = [
    ['配当性向', model.sustainability.payoutRatio, '直近FY'],
    ['年間配当総額（概算）', model.sustainability.annualDividendTotal, 'DPS × 期末自己株控除後株式数'],
    ['標準FCF', model.sustainability.standardFcf, 'LTM営業CF − Capex'],
    ['FCF Yield', model.sustainability.fcfYield, '標準FCF ÷ 時価総額'],
    ['FCF配当カバー', model.sustainability.fcfDividendCoverage, '標準FCF ÷ 概算年間配当総額'],
  ]
  return (
    <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="sustainability-title">
      <SectionHeading icon={ShieldCheck} id="sustainability-title" title="持続可能性" subtitle="利益とキャッシュフローの事実を分けて確認" />
      <div className="grid grid-cols-2 gap-px bg-[var(--color-border-soft)] sm:grid-cols-3">
        {values.map(([label, value, note]) => (
          <div key={label} className="bg-white px-3 py-2.5">
            <div className="text-[8px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
            <div className="mt-0.5 font-mono text-[13px] font-black text-[var(--color-text-primary)]">{valueText(value)}</div>
            <div className="mt-0.5 text-[7px] font-semibold leading-3 text-[var(--color-text-tertiary)]">{value.value == null ? value.reason : note}</div>
          </div>
        ))}
      </div>
      <div className="border-t border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2">
        {model.sustainability.facts.map((fact) => (
          <p key={fact} className="flex items-start gap-1.5 text-[8px] font-semibold text-[var(--color-text-secondary)]">
            <Info size={10} className="mt-0.5 shrink-0" aria-hidden="true" />
            {fact}
          </p>
        ))}
      </div>
    </section>
  )
}

function BuybacksAndTotalReturns({ model }: { model: ShareholderReturnsReadModel }) {
  const recent = model.buybacks.shareCountHistory.slice(-5).reverse()
  return (
    <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="buyback-title">
      <SectionHeading icon={Repeat2} id="buyback-title" title="自社株買い・総還元" subtitle="取得できる事実だけを表示" />
      <div className="px-4 py-3">
        <div className="text-[9px] font-black text-[var(--color-text-primary)]">自己株式控除後株式数の推移</div>
        <p className="mt-0.5 text-[8px] font-semibold leading-4 text-[var(--color-text-tertiary)]">{model.buybacks.reason}</p>
        {recent.length > 0 && (
          <div className="mt-2 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
            {recent.map((row) => (
              <div key={row.fiscalYear} className="grid grid-cols-[52px_1fr_auto] items-center gap-2 py-1.5 text-[8px]">
                <span className="font-mono font-black text-[var(--color-text-primary)]">FY{row.fiscalYear}</span>
                <span className="truncate font-mono text-[var(--color-text-secondary)]">{Math.round(row.splitAdjustedNetShares).toLocaleString('ja-JP')}株</span>
                <span className="font-mono font-bold text-[var(--color-text-secondary)]">{row.netShareChangePercent == null ? '—' : signedValue(row.netShareChangePercent, '%')}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-px border-t border-[var(--color-border-default)] bg-[var(--color-border-soft)]">
        <div className="bg-[var(--color-surface-subtle)] px-3 py-2.5">
          <div className="text-[8px] font-bold text-[var(--color-text-tertiary)]">年間自社株買い額</div>
          <div className="mt-0.5 font-mono text-[12px] font-black text-[var(--color-text-primary)]">—</div>
          <div className="mt-0.5 text-[7px] font-semibold text-[var(--color-text-tertiary)]">構造化データ未保存</div>
        </div>
        <div className="bg-[var(--color-surface-subtle)] px-3 py-2.5">
          <div className="text-[8px] font-bold text-[var(--color-text-tertiary)]">総還元利回り</div>
          <div className="mt-0.5 font-mono text-[12px] font-black text-[var(--color-text-primary)]">—</div>
          <div className="mt-0.5 text-[7px] font-semibold text-[var(--color-text-tertiary)]">自社株買い額不足のため未算定</div>
        </div>
      </div>
      <p className="border-t border-[var(--color-border-default)] px-3 py-2 text-[7px] font-semibold text-[var(--color-text-tertiary)]">{model.totalReturns.reason}</p>
    </section>
  )
}

function DefinitionNotes({ model }: { model: ShareholderReturnsReadModel }) {
  const definitions = [
    model.definitions.dividendYield,
    model.definitions.payoutRatio,
    model.definitions.standardFcf,
    model.definitions.fcfYield,
  ]
  return (
    <details className="border border-[var(--color-border-default)] bg-white">
      <summary className="cursor-pointer px-4 py-2.5 text-[9px] font-black text-[var(--color-text-secondary)]">指標定義・PIT・株式分割補正</summary>
      <div className="space-y-2 border-t border-[var(--color-border-default)] px-4 py-3">
        {definitions.map((definition) => (
          <div key={definition.key}>
            <div className="text-[8px] font-black text-[var(--color-text-primary)]">{definition.displayName} <span className="font-mono text-[7px] text-[var(--color-text-tertiary)]">{definition.version}</span></div>
            <div className="text-[8px] font-semibold text-[var(--color-text-secondary)]">{definition.formula}</div>
          </div>
        ))}
        <div className="text-[8px] font-semibold leading-4 text-[var(--color-text-secondary)]">
          会社予想・実績・EPS・FCFはすべて公表日時が分析基準日以前のものだけを使用します。DPS CAGRは {model.definitions.dpsCagr.formula}。株式数の機械的補正は表示単位を揃えるためのもので、将来の配当情報を補完するものではありません。
        </div>
      </div>
    </details>
  )
}

function SectionHeading({
  icon: Icon,
  id,
  title,
  subtitle,
}: {
  icon: typeof WalletCards
  id: string
  title: string
  subtitle: string
}) {
  return (
    <header className="flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-2.5">
      <Icon size={15} className="shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />
      <div>
        <h3 id={id} className="text-[11px] font-black text-[var(--color-text-primary)]">{title}</h3>
        <p className="text-[8px] font-semibold text-[var(--color-text-tertiary)]">{subtitle}</p>
      </div>
    </header>
  )
}
