'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  CircleDollarSign,
  History,
  Info,
  Repeat2,
  ShieldCheck,
  Table2,
  WalletCards,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { MeasuredChartFrame } from '@/components/charts/MeasuredChartFrame'
import type {
  DividendDirection,
  DividendForecastRevision,
  DividendHistoryRow,
  ShareholderReturnsReadModel,
  ShareholderReturnValue,
} from '@/lib/shareholder-returns'
import {
  formatUnitValue,
  UNAVAILABLE_LEGEND,
  unavailableLabel,
  type Direction,
} from '@/components/stock/fundamentals/format'
import {
  DirectionMark,
  ErrorBlock,
  Fact,
  LoadingBlock,
  PanelSection,
  Segmented,
  ShareMeter,
  TabBanner,
  UnavailableNote,
} from '@/components/stock/fundamentals/primitives'

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
const WINDOW_OPTIONS = WINDOWS.map((item) => ({ value: item.id, label: item.label }))

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

function valueText(value: ShareholderReturnValue): string {
  if (value.value == null) return unavailableLabel(value.availability)
  if (value.unit === 'JPY') return compactCurrency(value.value)
  return formatUnitValue(value.value, value.unit, value.availability, { digits: value.unit === 'MULTIPLE' ? 2 : 1 }).text
}

function isUnavailable(value: ShareholderReturnValue): boolean {
  return value.value == null
}

function signedValue(value: number | null, suffix = ''): string {
  if (value == null) return unavailableLabel('missing')
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

function directionOf(direction: DividendDirection): Direction | null {
  if (direction === 'increase' || direction === 'resumed') return 'higher'
  if (direction === 'decrease') return 'lower'
  if (direction === 'unchanged') return 'same'
  return null
}

/** 連続性の帯の色。増配系=ブランド色、減配=濃いグレー。価格の上昇/下落色は使わない。 */
function directionBar(direction: DividendDirection): string {
  if (direction === 'increase' || direction === 'resumed') return 'var(--color-brand-700)'
  if (direction === 'unchanged') return 'var(--color-brand-100)'
  if (direction === 'decrease') return 'var(--color-text-secondary)'
  return 'var(--color-border-default)'
}

function revisionLabel(row: DividendForecastRevision): string {
  if (row.direction === 'increase') return '上方修正'
  if (row.direction === 'decrease') return '下方修正'
  if (row.direction === 'unchanged') return '据え置き'
  if (row.direction === 'basis_change') return '株式単位変更の可能性'
  return '初回予想'
}

function revisionDirection(row: DividendForecastRevision): Direction | null {
  if (row.direction === 'increase') return 'higher'
  if (row.direction === 'decrease') return 'lower'
  if (row.direction === 'unchanged') return 'same'
  return null
}

function yen(value: number): string {
  return `¥${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}`
}

export function ShareholderReturnsDetail({ ticker, analysisDate }: ShareholderReturnsDetailProps) {
  const [model, setModel] = useState<ShareholderReturnsReadModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
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
  }, [analysisDate, ticker, reloadKey])

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

  if (loading) return <LoadingBlock label="株主還元を読み込んでいます..." />
  if (error || !model) {
    return <ErrorBlock label="株主還元データを取得できませんでした。" onRetry={() => setReloadKey((value) => value + 1)} />
  }

  return (
    <section className="space-y-5 bg-white" aria-labelledby="shareholder-returns-title">
      <TabBanner
        icon={WalletCards}
        id="shareholder-returns-title"
        title="株主還元"
        lead="配当を続けてきたか(継続性)と、利益・キャッシュで賄えているか(余力)を、現在の水準とあわせて確認します。"
        meta={(
          <>
            <div>分析基準日 {model.asOf}</div>
            <div>価格日 {model.priceDate ?? '—'}</div>
          </>
        )}
        flow={['現在の還元', '継続性', '余力', '配当履歴', '予想修正・定義']}
      />

      <CurrentReturns model={model} />
      <DividendContinuity model={model} />
      <DividendCapacity model={model} />
      <DividendHistory model={model} rows={visibleRows} window={window} onWindowChange={setWindow} />
      <ForecastRevisionHistory
        rows={model.forecastRevisions}
        showAll={showAllRevisions}
        onToggle={() => setShowAllRevisions((value) => !value)}
      />
      <DefinitionNotes model={model} />
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 1. 現在の還元                                                        */
/* ------------------------------------------------------------------ */

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
    <PanelSection
      icon={CircleDollarSign}
      id="current-returns-title"
      title="現在の還元"
      lead="予想と実績を混同せず、欠損はゼロ補完しない"
      bleed
    >
      <div className="grid grid-cols-1 gap-px bg-[var(--color-border-soft)] sm:grid-cols-3">
        {primary.map(([label, value, note], index) => (
          <article key={label} className="min-w-0 bg-white px-4 py-3 sm:px-5">
            <Fact
              label={label}
              value={valueText(value)}
              unavailable={isUnavailable(value)}
              emphasis={index === 0}
              sub={value.value == null ? value.reason : note}
            />
          </article>
        ))}
      </div>
      <dl className="m-0 grid grid-cols-3 border-t border-[var(--color-border-soft)]">
        {secondary.map(([label, value]) => (
          <div key={label} className="min-w-0 border-r border-[var(--color-border-soft)] px-3 py-2.5 last:border-r-0 sm:px-5">
            <dt className="text-[11px] font-semibold leading-4 text-[var(--color-text-tertiary)]">{label}</dt>
            <dd className={`m-0 font-mono ${isUnavailable(value) ? 'text-[12px] font-semibold text-[var(--color-text-tertiary)]' : 'text-[14px] font-bold text-[var(--color-text-primary)]'}`}>{valueText(value)}</dd>
          </div>
        ))}
      </dl>
      {model.isFinancialSector && (
        <div className="border-t border-[var(--color-border-soft)] px-4 py-2.5 sm:px-5">
          <UnavailableNote>金融業では配当指標を表示し、通常企業用の標準FCF・FCF Yieldは「対象外」としています。</UnavailableNote>
        </div>
      )}
    </PanelSection>
  )
}

/* ------------------------------------------------------------------ */
/* 2. 継続性                                                            */
/* ------------------------------------------------------------------ */

function DividendContinuity({ model }: { model: ShareholderReturnsReadModel }) {
  const actualRows = model.history.rows.filter((row) => row.actualDps.availability === 'available').slice(-10)
  const values: Array<[string, ShareholderReturnValue]> = [
    ['連続増配', model.direction.consecutiveIncreaseYears],
    ['連続非減配', model.direction.consecutiveNonDecreaseYears],
    ['直近5年の減配', model.direction.cutsLast5Years],
    ['DPS 3年CAGR', model.direction.dpsCagr3y],
    ['DPS 5年CAGR', model.direction.dpsCagr5y],
  ]
  return (
    <PanelSection
      icon={Repeat2}
      id="dividend-direction-title"
      title="継続性(配当の向き)"
      lead="株式分割を補正した実績DPSで、年ごとの増配・据え置き・減配を判定"
    >
      <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
        {values.map(([label, value], index) => (
          <div key={label} className="min-w-0">
            <dt className="text-[11px] font-semibold leading-4 text-[var(--color-text-tertiary)]">{label}</dt>
            <dd className={`m-0 font-mono ${isUnavailable(value) ? 'text-[12px] font-semibold text-[var(--color-text-tertiary)]' : `${index < 2 ? 'text-[20px] font-semibold' : 'text-[16px] font-bold'} text-[var(--color-text-primary)]`}`}>{valueText(value)}</dd>
          </div>
        ))}
      </dl>
      {actualRows.length > 0 ? (
        <div className="mt-3.5">
          <div className="mb-1.5 text-[11px] font-bold text-[var(--color-text-secondary)]">年ごとの向き(直近{actualRows.length}期・新しい期が右)</div>
          <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(76px,1fr))] gap-px bg-[var(--color-border-soft)] p-0" aria-label="年ごとの配当の向き">
            {actualRows.map((row) => (
              <li key={row.key} className="min-w-0 bg-white" data-dividend-direction={row.direction}>
                <span className="block h-[3px]" style={{ background: directionBar(row.direction) }} aria-hidden="true" />
                <div className="px-2 py-1.5">
                  <div className="font-mono text-[11px] font-semibold leading-4 text-[var(--color-text-tertiary)]">FY{row.fiscalYear}</div>
                  <div className="flex items-center gap-0.5 text-[12px] font-bold leading-4 text-[var(--color-text-primary)]">
                    <DirectionMark direction={directionOf(row.direction)} size={12} />{directionLabel(row.direction)}
                  </div>
                  <div className="font-mono text-[11px] font-medium leading-4 text-[var(--color-text-secondary)]">{valueText(row.actualDps)}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="mt-3"><UnavailableNote>実績DPSの履歴がないため、年ごとの向きは表示できません。</UnavailableNote></div>
      )}
      {model.history.adjustments.length > 0 && (
        <p className="mt-3 border-l-2 border-[var(--color-border-strong)] bg-[var(--color-surface-subtle)] px-2.5 py-1.5 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">
          株式分割の補正を検出: {model.history.adjustments.map((item) => `FY${item.fromFiscalYear}→FY${item.toFiscalYear} ${item.factor}倍`).join(' / ')}
        </p>
      )}
    </PanelSection>
  )
}

/* ------------------------------------------------------------------ */
/* 3. 余力(持続可能性)+ 自社株買い                                      */
/* ------------------------------------------------------------------ */

function DividendCapacity({ model }: { model: ShareholderReturnsReadModel }) {
  const sustainability = model.sustainability
  const payout = sustainability.payoutRatio
  const facts: Array<[string, ShareholderReturnValue, string]> = [
    ['FCF配当カバー', sustainability.fcfDividendCoverage, '標準FCF ÷ 概算年間配当総額'],
    ['標準FCF', sustainability.standardFcf, 'LTM営業CF − Capex'],
    ['FCF Yield', sustainability.fcfYield, '標準FCF ÷ 時価総額'],
    ['年間配当総額(概算)', sustainability.annualDividendTotal, 'DPS × 期末自己株控除後株式数'],
  ]
  const recentShares = model.buybacks.shareCountHistory.slice(-5).reverse()
  return (
    <PanelSection
      icon={ShieldCheck}
      id="sustainability-title"
      title="余力(利益とキャッシュで賄えているか)"
      lead="利益ベース(配当性向)とキャッシュベース(FCF)の事実を分けて確認"
    >
      <div className="grid gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="min-w-0 space-y-2">
          <div className="border-y border-[var(--color-border-soft)]">
            <ShareMeter
              label="配当性向(直近FY)"
              value={payout.value}
              text={valueText(payout)}
              max={150}
              boundary={100}
              boundaryLabel="100%"
            />
          </div>
          <p className="text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
            {payout.value == null ? payout.reason ?? 'データなし' : '利益に対する配当の割合。縦線=100%(利益と同額)'}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
          {facts.map(([label, value, note]) => (
            <Fact
              key={label}
              label={label}
              value={valueText(value)}
              unavailable={isUnavailable(value)}
              sub={value.value == null ? value.reason : note}
            />
          ))}
        </div>
      </div>
      {sustainability.facts.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-[var(--color-border-soft)] pt-2.5">
          {sustainability.facts.map((fact) => (
            <p key={fact} className="flex items-start gap-1.5 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">
              <Info size={12} className="mt-1 shrink-0" aria-hidden="true" />
              {fact}
            </p>
          ))}
        </div>
      )}

      <div className="mt-3.5 border-t border-[var(--color-border-soft)] pt-3" data-section="buybacks">
        <h4 className="text-[12px] font-bold text-[var(--color-text-secondary)]">自社株買い・総還元</h4>
        {model.buybacks.annualBuybackAmount.value != null ? (
          <div className="mt-1.5 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
            <Fact label="年間自社株買い額" value={valueText(model.buybacks.annualBuybackAmount)} />
            <Fact label="時価総額比" value={valueText(model.buybacks.marketCapRatio)} unavailable={isUnavailable(model.buybacks.marketCapRatio)} />
            <Fact label="総還元額" value={valueText(model.totalReturns.totalPayout)} unavailable={isUnavailable(model.totalReturns.totalPayout)} />
            <Fact label="総還元利回り" value={valueText(model.totalReturns.totalPayoutYield)} unavailable={isUnavailable(model.totalReturns.totalPayoutYield)} />
          </div>
        ) : (
          <div className="mt-1.5">
            <UnavailableNote>
              自社株買い額・総還元利回りは<strong className="font-bold">データなし</strong>(構造化データ未保存のため未算定)。配当だけで還元を判断しないよう、株式数の推移を参考として表示します。
            </UnavailableNote>
          </div>
        )}
        <p className="mt-1 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">{model.buybacks.reason} {model.totalReturns.reason}</p>
        {recentShares.length > 0 && (
          <details className="mt-1.5">
            <summary className="flex min-h-11 cursor-pointer items-center text-[12px] font-bold text-[var(--color-brand-700)] sm:min-h-8">
              自己株式控除後の株式数の推移(直近{recentShares.length}期)
            </summary>
            <ul className="m-0 list-none divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)] p-0">
              {recentShares.map((row) => (
                <li key={row.fiscalYear} className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-2 py-1.5 text-[12px]">
                  <span className="font-mono font-black text-[var(--color-text-primary)]">FY{row.fiscalYear}</span>
                  <span className="truncate font-mono text-[var(--color-text-secondary)]">{Math.round(row.splitAdjustedNetShares).toLocaleString('ja-JP')}株</span>
                  <span className="font-mono font-bold text-[var(--color-text-secondary)]">{row.netShareChangePercent == null ? unavailableLabel('missing') : signedValue(row.netShareChangePercent, '%')}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </PanelSection>
  )
}

/* ------------------------------------------------------------------ */
/* 4. 配当履歴                                                          */
/* ------------------------------------------------------------------ */

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
  // 実績と予想が同じ年度に並ぶことがなければ、同じstackIdに載せて棒をカテゴリ中央に揃える(値は変えない)。
  const overlap = chartData.some((datum) => datum.actualDps != null && datum.forecastDps != null)
  return (
    <PanelSection
      icon={History}
      id="dividend-history-title"
      title="配当履歴"
      lead="実績DPSは塗り、会社予想DPSは白抜きの破線"
      bleed
      aside={<Segmented label="表示年数" options={WINDOW_OPTIONS} value={window} onChange={onWindowChange} />}
    >
      {rows.length === 0 ? (
        <div className="px-4 py-3 sm:px-5"><UnavailableNote>この期間に表示できる配当データがありません。</UnavailableNote></div>
      ) : (
        <>
          <MeasuredChartFrame className="h-60 px-1 pt-3 sm:h-72 sm:px-4">
            {({ width, height }) => (
              <BarChart width={width} height={height} data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }} barCategoryGap="24%">
                <CartesianGrid stroke="var(--color-border-soft)" vertical={false} />
                <XAxis dataKey="fiscalYear" tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)', fontWeight: 600 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} tickLine={false} axisLine={false} width={42} />
                <Tooltip
                  formatter={(value, name) => [yen(Number(value)), name === 'actualDps' ? '実績DPS' : '会社予想DPS']}
                  labelStyle={{ fontSize: 11, fontWeight: 800 }}
                  contentStyle={{ fontSize: 11, borderRadius: 0, borderColor: 'var(--color-border-default)' }}
                />
                <Legend wrapperStyle={{ fontSize: 11, fontWeight: 700 }} formatter={(value) => value === 'actualDps' ? '実績DPS' : '会社予想DPS'} />
                <Bar dataKey="actualDps" fill="var(--color-brand-700)" maxBarSize={34} stackId={overlap ? undefined : 'dps'} />
                <Bar dataKey="forecastDps" fill="white" stroke="var(--color-brand-700)" strokeWidth={2} strokeDasharray="4 2" maxBarSize={34} stackId={overlap ? undefined : 'dps'} />
              </BarChart>
            )}
          </MeasuredChartFrame>

          <details className="group border-t border-[var(--color-border-default)]" open>
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 text-[12px] font-bold text-[var(--color-brand-900)] sm:px-5 [&::-webkit-details-marker]:hidden">
              <span className="inline-flex items-center gap-1.5"><Table2 size={13} aria-hidden="true" />年度別の表</span>
              <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">グラフと同じ年度</span>
            </summary>
            <ul className="m-0 list-none divide-y divide-[var(--color-border-soft)] border-t border-[var(--color-border-soft)] p-0 md:hidden" aria-label="年度別の配当(カード表示)">
              {rows.map((row) => <HistoryCard key={row.key} row={row} />)}
            </ul>
            <div className="hidden overflow-x-auto border-t border-[var(--color-border-soft)] md:block">
              <table className="w-full min-w-[760px] border-collapse text-left">
                <thead className="bg-[var(--color-surface-subtle)] text-[12px] font-bold text-[var(--color-text-secondary)]">
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
                <tbody className="divide-y divide-[var(--color-border-soft)] text-[12px]">
                  {rows.map((row) => {
                    const forecast = row.forecastDps.availability === 'available'
                    return (
                      <tr key={row.key} className={forecast ? 'bg-[var(--color-brand-50)]' : 'bg-white'}>
                        <td className="px-3 py-2 font-mono font-black text-[var(--color-text-primary)]">FY{row.fiscalYear}</td>
                        <td className="px-3 py-2 text-right font-mono font-black">{forecast ? `${valueText(row.forecastDps)} 予想` : valueText(row.actualDps)}</td>
                        <td className="px-3 py-2 font-bold text-[var(--color-text-secondary)]">
                          {forecast ? (row.forecastScope === 'next_fy' ? '翌期予想' : '当期予想') : (
                            <span className="inline-flex items-center gap-1"><DirectionMark direction={directionOf(row.direction)} size={12} />{directionLabel(row.direction)}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{valueText(row.eps)}</td>
                        <td className="px-3 py-2 text-right font-mono">{valueText(row.payoutRatio)}</td>
                        <td className="px-3 py-2 text-right font-mono">{valueText(row.dividendYield)}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-[var(--color-text-tertiary)]">{row.publishedAt ? row.publishedAt.slice(0, 10) : unavailableLabel('missing')}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      <p className="border-t border-[var(--color-border-soft)] px-4 py-2 text-[11px] font-medium leading-5 text-[var(--color-text-tertiary)] sm:px-5">
        {model.history.adjustmentMethod} 期末株価ベース利回りは比較用の実績値で、現在の予想利回りとは定義が異なります。{UNAVAILABLE_LEGEND}。
      </p>
    </PanelSection>
  )
}

function HistoryCard({ row }: { row: DividendHistoryRow }) {
  const forecast = row.forecastDps.availability === 'available'
  return (
    <li className={`px-4 py-2.5 ${forecast ? 'bg-[var(--color-brand-50)]' : 'bg-white'}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-[13px] font-black text-[var(--color-text-primary)]">FY{row.fiscalYear}</span>
        <span className="inline-flex items-center gap-1 text-[12px] font-bold text-[var(--color-text-secondary)]">
          {forecast ? (row.forecastScope === 'next_fy' ? '翌期予想' : '当期予想') : (
            <><DirectionMark direction={directionOf(row.direction)} size={12} />{directionLabel(row.direction)}</>
          )}
        </span>
      </div>
      <dl className="m-0 mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
        <HistoryCell label="DPS" value={forecast ? `${valueText(row.forecastDps)} 予想` : valueText(row.actualDps)} strong />
        <HistoryCell label="EPS" value={valueText(row.eps)} />
        <HistoryCell label="配当性向" value={valueText(row.payoutRatio)} />
        <HistoryCell label="期末株価ベース利回り" value={valueText(row.dividendYield)} />
      </dl>
    </li>
  )
}

function HistoryCell({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{label}</dt>
      <dd className={`m-0 font-mono ${strong ? 'text-[14px] font-black' : 'text-[13px] font-bold'} text-[var(--color-text-primary)]`}>{value}</dd>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 5. 予想修正・定義                                                    */
/* ------------------------------------------------------------------ */

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
    <details className="overflow-hidden border-y border-[var(--color-border-soft)] bg-white">
      <summary id="forecast-revision-title" className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 px-4 py-1.5 text-[13px] font-bold text-[var(--color-text-secondary)] sm:px-5">
        <span>PIT配当予想の修正履歴</span>
        <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">公表日ごとの当期・翌期予想 / {rows.length}件</span>
      </summary>
      <div className="border-t border-[var(--color-border-default)]">
        {visible.length === 0 ? (
          <div className="px-4 py-3 sm:px-5"><UnavailableNote>指定日時点で配当予想履歴はありません。</UnavailableNote></div>
        ) : (
          <>
            <ul className="m-0 list-none divide-y divide-[var(--color-border-soft)] p-0 md:hidden" aria-label="配当予想の修正(カード表示)">
              {visible.map((row) => (
                <li key={row.key} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-mono text-[12px] text-[var(--color-text-tertiary)]">{row.publishedAt.slice(0, 10)}</span>
                    <span className="inline-flex items-center gap-1 text-[12px] font-bold text-[var(--color-text-secondary)]"><DirectionMark direction={revisionDirection(row)} size={12} />{revisionLabel(row)}</span>
                  </div>
                  <div className="mt-0.5 text-[13px] font-bold text-[var(--color-text-primary)]">FY{row.targetFiscalYear} {row.forecastScope === 'next_fy' ? '翌期' : '当期'}予想</div>
                  <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 font-mono text-[12px] text-[var(--color-text-secondary)]">
                    <span>{row.previousValue == null ? '前回なし' : yen(row.previousValue)} → <b className="text-[var(--color-text-primary)]">{yen(row.value)}</b></span>
                    <span>{row.changeAmount == null ? unavailableLabel('missing') : signedValue(row.changeAmount, '円')} ({row.changePercent == null ? unavailableLabel('missing') : signedValue(row.changePercent, '%')})</span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[760px] border-collapse text-left">
                <thead className="bg-[var(--color-surface-subtle)] text-[12px] font-bold text-[var(--color-text-secondary)]">
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
                <tbody className="divide-y divide-[var(--color-border-soft)] text-[12px]">
                  {visible.map((row) => (
                    <tr key={row.key}>
                      <td className="px-3 py-2 font-mono">{row.publishedAt.slice(0, 10)}</td>
                      <td className="px-3 py-2 font-mono font-black">FY{row.targetFiscalYear}</td>
                      <td className="px-3 py-2">{row.forecastScope === 'next_fy' ? '翌期' : '当期'}</td>
                      <td className="px-3 py-2 text-right font-mono">{row.previousValue == null ? unavailableLabel('missing') : yen(row.previousValue)}</td>
                      <td className="px-3 py-2 text-right font-mono font-black">{yen(row.value)}</td>
                      <td className="px-3 py-2 text-right font-mono">{row.changeAmount == null ? unavailableLabel('missing') : signedValue(row.changeAmount, '円')}</td>
                      <td className="px-3 py-2 text-right font-mono">{row.changePercent == null ? unavailableLabel('missing') : signedValue(row.changePercent, '%')}</td>
                      <td className="px-3 py-2 font-bold text-[var(--color-text-secondary)]"><span className="inline-flex items-center gap-1"><DirectionMark direction={revisionDirection(row)} size={12} />{revisionLabel(row)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {rows.length > 12 && (
          <button type="button" onClick={onToggle} className="min-h-11 w-full border-t border-[var(--color-border-default)] py-2 text-[12px] font-black text-[var(--color-brand-700)]">
            {showAll ? '最新12件に戻す' : `全${rows.length}件を表示`}
          </button>
        )}
      </div>
    </details>
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
    <details className="border-y border-[var(--color-border-soft)] bg-white">
      <summary className="flex min-h-11 cursor-pointer items-center px-4 text-[12px] font-bold text-[var(--color-text-secondary)] sm:px-5">指標定義・PIT・株式分割補正</summary>
      <div className="space-y-2.5 border-t border-[var(--color-border-default)] px-4 py-3 sm:px-5">
        {definitions.map((definition) => (
          <div key={definition.key}>
            <div className="text-[12px] font-bold text-[var(--color-text-primary)]">{definition.displayName} <span className="font-mono text-[11px] text-[var(--color-text-tertiary)]">{definition.version}</span></div>
            <div className="text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">{definition.formula}</div>
          </div>
        ))}
        <div className="text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">
          会社予想・実績・EPS・FCFはすべて公表日時が分析基準日以前のものだけを使用します。DPS CAGR は {model.definitions.dpsCagr.formula}。株式数の機械的補正は表示単位を揃えるためのもので、将来の配当情報を補完するものではありません。
        </div>
        <p className="text-[11px] font-medium leading-5 text-[var(--color-text-tertiary)]">{UNAVAILABLE_LEGEND}。</p>
      </div>
    </details>
  )
}
