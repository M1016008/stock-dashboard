'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { BadgeCheck, ChevronRight, CircleDollarSign, HandCoins, ShieldCheck, TrendingUp, type LucideIcon } from 'lucide-react'
import {
  formatFinancialSummaryValue,
  type FinancialSummaryFormat,
} from '@/lib/stock-decision-summary'
import type { FinancialOverviewReadModel, FinancialOverviewValue } from '@/lib/server/financial-overview-read-model'
import type { FinancialDetailReadModel, FinancialDetailValue } from '@/lib/financial-detail'
import type { ValuationDetailReadModel, ValuationHistoryMetric, ValuationPeerMetric } from '@/lib/valuation-detail'
import type { ShareholderReturnsReadModel, ShareholderReturnValue } from '@/lib/shareholder-returns'
import {
  compareDisplayed,
  directionFromMedianComparison,
  directionOfSigned,
  DIRECTION_WORD,
  displaySummary,
  formatUnitValue,
  UNAVAILABLE_LEGEND,
  type Direction,
  type FundamentalTabId,
} from './format'
import {
  BarLadder,
  Fact,
  PeerBand,
  RangeRuler,
  ReadingLine,
  ShareMeter,
  TabBanner,
  UnavailableNote,
  type BarRow,
} from './primitives'

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

type Remote<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T }

function useRemote<T>(url: string): Remote<T> {
  const [state, setState] = useState<Remote<T>>({ status: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    fetch(url, { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((data: T) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' })
      })
    return () => controller.abort()
  }, [url])
  return state
}

function detailUrl(base: string, ticker: string, analysisDate: string | null): string {
  return `${base}/${encodeURIComponent(ticker)}${analysisDate ? `?as_of=${encodeURIComponent(analysisDate)}` : ''}`
}

function availableNumber(point: FinancialOverviewValue | null | undefined): number | null {
  return point?.availability === 'available' && point.value != null && Number.isFinite(point.value) ? point.value : null
}

function overviewText(
  point: FinancialOverviewValue | null | undefined,
  format: FinancialSummaryFormat,
  options: { forecast?: boolean; signed?: boolean } = {},
) {
  return displaySummary(formatFinancialSummaryValue(point, format, options))
}

function overviewBar(
  key: string,
  label: string,
  point: FinancialOverviewValue | null | undefined,
  format: FinancialSummaryFormat,
  options: { forecast?: boolean; signed?: boolean; scale?: string; basis?: string } = {},
): BarRow {
  const formatted = formatFinancialSummaryValue(point, format, { forecast: options.forecast, signed: options.signed })
  return {
    key,
    label,
    basis: options.basis,
    value: formatted.availability === 'available' ? point?.value ?? null : null,
    text: displaySummary(formatted).text,
    note: formatted.reason,
    forecast: options.forecast,
    scale: options.scale,
  }
}

function detailText(value: FinancialDetailValue | null | undefined) {
  if (!value) return { text: '—', unavailable: true }
  return formatUnitValue(value.value, value.unit, value.availability)
}

function detailBar(key: string, label: string, value: FinancialDetailValue): BarRow {
  return {
    key,
    label,
    value: value.value,
    text: detailText(value).text,
    note: value.reason,
  }
}

function returnText(value: ShareholderReturnValue | null | undefined) {
  if (!value) return { text: '—', unavailable: true }
  return formatUnitValue(value.value, value.unit, value.availability)
}

function relation(subject: string, object: string, direction: Direction): string {
  return direction === 'same' ? `${subject}は${object}と同水準` : `${subject}は${object}を${DIRECTION_WORD[direction]}`
}

interface Reading {
  key: string
  direction: Direction | null
  text: string
}

function compareReading(
  key: string,
  subjectPoint: FinancialOverviewValue | null | undefined,
  objectPoint: FinancialOverviewValue | null | undefined,
  precision: number,
  subject: string,
  object: string,
): Reading[] {
  const left = availableNumber(subjectPoint)
  const right = availableNumber(objectPoint)
  if (left == null || right == null) return []
  const direction = compareDisplayed(left, right, precision)
  return [{ key, direction, text: relation(subject, object, direction) }]
}

function medianWord(direction: Direction): string {
  return direction === 'same' ? 'と同水準' : direction === 'higher' ? 'より高い' : 'より低い'
}

/* ------------------------------------------------------------------ */
/* Board                                                               */
/* ------------------------------------------------------------------ */

type AxisId = 'growth' | 'profitability' | 'safety' | 'valuation' | 'returns'

interface GlanceItem {
  id: AxisId
  label: string
  icon: LucideIcon
  value: string
  unavailable: boolean
  sub: string
}

export function FundamentalSummaryBoard({
  ticker,
  analysisDate,
  financial,
  loading,
  failed,
  financialAsOf,
  onSelectTab,
}: {
  ticker: string
  analysisDate: string | null
  financial: FinancialOverviewReadModel | null
  loading: boolean
  failed: boolean
  financialAsOf: string
  onSelectTab?: (tab: FundamentalTabId) => void
}) {
  const detail = useRemote<FinancialDetailReadModel>(detailUrl('/api/financial-detail', ticker, analysisDate))
  const valuation = useRemote<ValuationDetailReadModel>(detailUrl('/api/valuation-detail', ticker, analysisDate))
  const returns = useRemote<ShareholderReturnsReadModel>(detailUrl('/api/shareholder-returns', ticker, analysisDate))

  const growth = financial?.performanceAndGrowth
  const currentFy = financial?.forecasts.currentFy
  const nextFy = financial?.forecasts.nextFy
  const overviewReturns = financial?.shareholderReturns
  const pending = loading && !financial

  // ---- 成長 ----
  const growthReference = availableNumber(growth?.revenueCagr3y) != null ? growth?.revenueCagr3y : growth?.revenueCagr5y
  const growthReferenceLabel = availableNumber(growth?.revenueCagr3y) != null ? '3年CAGR' : '5年CAGR'
  const growthReads: Reading[] = [
    ...compareReading('pace', growth?.ltmRevenueGrowth, growthReference, 0.1, '直近1年の売上成長', growthReferenceLabel),
    ...compareReading('rev-forecast', currentFy?.revenue, growth?.ltmRevenue, 1e7, '今期会社予想の売上高', 'LTM'),
  ]
  const profitReads: Reading[] = compareReading('op-forecast', currentFy?.operatingProfit, growth?.ltmOperatingProfit, 1e7, '今期会社予想の営業利益', 'LTM')

  // ---- 財務安全性 ----
  const safetyModel = detail.status === 'ready' ? detail.data : null
  const health = safetyModel?.summary.financialHealth
  const cashFlow = safetyModel?.summary.cashFlow
  const safetyReads: Reading[] = []
  if (cashFlow) {
    const operating = directionOfSigned(cashFlow.operatingCashFlow.value)
    if (operating) safetyReads.push({ key: 'ocf', direction: operating, text: `営業CFは${operating === 'higher' ? 'プラス' : operating === 'lower' ? 'マイナス' : 'ゼロ'}` })
    const fcf = directionOfSigned(cashFlow.simpleFcf.value)
    if (fcf) safetyReads.push({ key: 'fcf', direction: fcf, text: `簡易FCFは${fcf === 'higher' ? 'プラス' : fcf === 'lower' ? 'マイナス' : 'ゼロ'}` })
  }

  // ---- 株価の位置 ----
  const valuationModel = valuation.status === 'ready' ? valuation.data : null
  const valuationMetric: (ValuationHistoryMetric & ValuationPeerMetric) | null = valuationModel
    ? (['forward_per', 'pbr'] as const).find((metric) => valuationModel.history[metric].statistics['5y'].current != null) ?? null
    : null
  const history = valuationModel && valuationMetric ? valuationModel.history[valuationMetric] : null
  const stats = history ? history.statistics['5y'] : null
  const peer = valuationModel && valuationMetric ? valuationModel.peers.sector33.metrics[valuationMetric] : null
  const historyDirection = stats ? directionFromMedianComparison(stats.medianComparison) : null
  const peerDirection = peer && peer.displayable ? directionFromMedianComparison(peer.medianComparison) : null
  const valuationReads: Reading[] = []
  if (history && stats && historyDirection) {
    valuationReads.push({ key: 'own', direction: historyDirection, text: `${history.label}は自社過去5年の中央値${medianWord(historyDirection)}` })
  }
  if (history && peer && peerDirection) {
    valuationReads.push({ key: 'peer', direction: peerDirection, text: `${history.label}は33業種の中央値${medianWord(peerDirection)}` })
  }

  // ---- 株主還元 ----
  const returnsModel = returns.status === 'ready' ? returns.data : null
  const cuts = returnsModel?.direction.cutsLast5Years
  const returnReads: Reading[] = compareReading('dps', overviewReturns?.currentForecastDps, overviewReturns?.actualDps, 0.1, '今期予想DPS', '実績')
  if (cuts && cuts.value != null) {
    returnReads.push({
      key: 'cuts',
      direction: cuts.value === 0 ? 'same' : 'lower',
      text: cuts.value === 0 ? '直近5年に減配なし' : `直近5年の減配は${cuts.value.toFixed(0)}回`,
    })
  }

  const percentOf = (value: number | null | undefined) => (value == null ? null : `過去5年の${value.toFixed(0)}%水準`)

  const glance: GlanceItem[] = [
    (() => {
      const v = overviewText(growth?.ltmRevenueGrowth, 'percent', { signed: true })
      return { id: 'growth' as const, label: '成長', icon: TrendingUp, value: pending ? '読み込み中' : v.text, unavailable: pending || v.unavailable, sub: '売上 直近1年(LTM)' }
    })(),
    (() => {
      const v = overviewText(growth?.operatingMargin, 'percent')
      return { id: 'profitability' as const, label: '収益性', icon: BadgeCheck, value: pending ? '読み込み中' : v.text, unavailable: pending || v.unavailable, sub: '営業利益率' }
    })(),
    (() => {
      const v = detailText(health?.equityRatio)
      const wait = detail.status === 'loading'
      return {
        id: 'safety' as const,
        label: '財務安全性',
        icon: ShieldCheck,
        value: wait ? '読み込み中' : detail.status === 'error' ? '取得不可' : v.text,
        unavailable: wait || detail.status === 'error' || v.unavailable,
        sub: '自己資本比率',
      }
    })(),
    (() => {
      const v = overviewText(financial?.valuation.forwardPer, 'multiple', { forecast: true })
      return {
        id: 'valuation' as const,
        label: '株価の位置',
        icon: CircleDollarSign,
        value: pending ? '読み込み中' : v.text,
        unavailable: pending || v.unavailable,
        sub: percentOf(stats?.percentile) ?? '予想PER',
      }
    })(),
    (() => {
      const v = overviewText(overviewReturns?.dividendYield, 'percent', { forecast: true })
      return { id: 'returns' as const, label: '株主還元', icon: HandCoins, value: pending ? '読み込み中' : v.text, unavailable: pending || v.unavailable, sub: '予想配当利回り' }
    })(),
  ]

  const jump = (id: AxisId) => {
    document.getElementById(`fundamental-axis-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <section
      className="overflow-hidden border-y border-[var(--color-border-soft)] bg-white"
      aria-labelledby="fundamental-summary-title-fundamental"
      data-section="Fundamental Summary"
    >
      <TabBanner
        icon={TrendingUp}
        id="fundamental-summary-title-fundamental"
        title="財務サマリー"
        lead="成長・収益性・財務安全性・株価の位置・株主還元の5軸で、いまの立ち位置を確認します。"
        meta={<span>財務 {financialAsOf}</span>}
        flow={['現在地(5軸)', '根拠の数値', '各タブで詳細']}
      />

      {failed && !loading && (
        <div role="alert" className="border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-2 text-[12px] font-bold text-[var(--color-text-secondary)] sm:px-5">
          財務サマリーを取得できませんでした。成長・収益性・株価の位置・株主還元の一部が表示できません。
        </div>
      )}

      <div className="grid grid-cols-2 gap-px border-b border-[var(--color-border-soft)] bg-[var(--color-border-soft)] sm:grid-cols-5" aria-label="5軸の現在地">
        {glance.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onClick={() => jump(item.id)}
            className={`flex min-h-[84px] min-w-0 flex-col items-start gap-0.5 bg-white px-3 py-2.5 text-left hover:bg-[var(--color-surface-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-brand-700)] sm:px-4 ${index === glance.length - 1 ? 'col-span-2 sm:col-span-1' : ''}`}
            aria-label={`${item.label} ${item.value} ${item.sub}の詳細へ移動`}
          >
            <span className="inline-flex items-center gap-1 text-[12px] font-bold text-[var(--color-text-secondary)]">
              <item.icon size={13} className="text-[var(--color-brand-700)]" aria-hidden="true" />{item.label}
            </span>
            <span className={`font-mono leading-tight ${item.unavailable ? 'text-[13px] font-semibold text-[var(--color-text-tertiary)]' : 'text-[20px] font-semibold text-[var(--color-text-primary)]'}`}>{item.value}</span>
            <span className="text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">{item.sub}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-px bg-[var(--color-border-soft)] lg:grid-cols-2">
        <AxisPanel
          id="growth"
          icon={TrendingUp}
          title="成長"
          role="売上の長期成長率と直近の伸びを、同じ%目盛りで比較"
          tab="performance"
          tabLabel="業績で推移を見る"
          onSelectTab={onSelectTab}
          reads={growthReads}
          pending={pending}
        >
          <BarLadder
            title="売上成長率 長期→直近(0中心)"
            mode="signed"
            rows={[
              overviewBar('rev-5y', '売上', growth?.revenueCagr5y, 'percent', { signed: true, basis: '5年CAGR' }),
              overviewBar('rev-3y', '売上', growth?.revenueCagr3y, 'percent', { signed: true, basis: '3年CAGR' }),
              overviewBar('rev-ltm', '売上', growth?.ltmRevenueGrowth, 'percent', { signed: true, basis: 'LTM' }),
              overviewBar('eps', 'EPS成長', growth?.epsGrowth, 'percent', { signed: true }),
            ]}
          />
          <FactRow>
            <Fact label="LTM売上高" {...factOf(overviewText(growth?.ltmRevenue, 'currency'))} />
            <Fact label="今期会社予想 売上高" {...factOf(overviewText(currentFy?.revenue, 'currency', { forecast: true }))} />
          </FactRow>
        </AxisPanel>

        <AxisPanel
          id="profitability"
          icon={BadgeCheck}
          title="収益性"
          role="売上・資本・資産に対する利益の水準"
          tab="financial"
          tabLabel="財務で指標を見る"
          onSelectTab={onSelectTab}
          reads={profitReads}
          pending={pending}
        >
          <BarLadder
            title="利益率・資本効率(0中心)"
            mode="signed"
            rows={[
              overviewBar('margin', '営業利益率', growth?.operatingMargin, 'percent', { signed: true }),
              overviewBar('roe', 'ROE', financial?.quality.roe, 'percent', { signed: true }),
              overviewBar('roa', 'ROA', financial?.quality.roa, 'percent', { signed: true }),
              overviewBar('roic', 'ROIC', financial?.quality.roic, 'percent', { signed: true }),
            ]}
          />
          <FactRow>
            <Fact label="LTM営業利益" {...factOf(overviewText(growth?.ltmOperatingProfit, 'currency'))} />
            <Fact label="今期会社予想 営業利益" {...factOf(overviewText(currentFy?.operatingProfit, 'currency', { forecast: true }))} />
          </FactRow>
        </AxisPanel>

        <AxisPanel
          id="safety"
          icon={ShieldCheck}
          title="財務安全性"
          role="自己資本の厚みと、営業・投資・財務キャッシュフローの向き"
          tab="financial"
          tabLabel="財務でB/S・C/Fを見る"
          onSelectTab={onSelectTab}
          reads={safetyReads}
          pending={detail.status === 'loading'}
          failed={detail.status === 'error' ? '財務詳細を取得できませんでした。' : null}
        >
          {safetyModel && health && cashFlow && (
            <>
              <ShareMeter
                label="自己資本比率"
                value={health.equityRatio.value}
                text={detailText(health.equityRatio).text}
                max={100}
              />
              <BarLadder
                title="キャッシュフロー(0中心・同じ円目盛り)"
                mode="signed"
                rows={[
                  detailBar('ocf', '営業CF', cashFlow.operatingCashFlow),
                  detailBar('icf', '投資CF', cashFlow.investingCashFlow),
                  detailBar('fcf-fin', '財務CF', cashFlow.financingCashFlow),
                  detailBar('sfcf', '簡易FCF', cashFlow.simpleFcf),
                ]}
              />
              <FactRow>
                <Fact label="総資産" {...factOf(detailText(health.totalAssets))} />
                <Fact label="自己資本" {...factOf(detailText(health.equity))} />
              </FactRow>
            </>
          )}
        </AxisPanel>

        <AxisPanel
          id="valuation"
          icon={CircleDollarSign}
          title="株価の位置"
          role="いまの倍率が自社の過去と同業の中でどこにあるか(割安・割高の判定はしません)"
          tab="valuation"
          tabLabel="バリュエーションで詳しく見る"
          onSelectTab={onSelectTab}
          reads={valuationReads}
          pending={pending}
          readsPending={valuation.status === 'loading'}
        >
          <div className="grid grid-cols-3 gap-3">
            <Fact label="予想PER" {...factOf(overviewText(financial?.valuation.forwardPer, 'multiple', { forecast: true }))} />
            <Fact label="実績PER" {...factOf(overviewText(financial?.valuation.per, 'multiple'))} />
            <Fact label="PBR" {...factOf(overviewText(financial?.valuation.pbr, 'multiple'))} />
          </div>
          {valuationModel && history && stats ? (
            <>
              <div>
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-[11px] font-bold text-[var(--color-text-secondary)]">
                  <span>自社過去5年のレンジ内({history.label})</span>
                  <span className="font-mono font-semibold text-[var(--color-text-tertiary)]">{percentOf(stats.percentile) ?? 'データなし'}</span>
                </div>
                <RangeRuler
                  low={stats.displayMinimum}
                  high={stats.displayMaximum}
                  current={stats.current}
                  median={stats.median}
                  lowText={`5%点 ${metricText(stats.displayMinimum, history.unit)}`}
                  highText={`95%点 ${metricText(stats.displayMaximum, history.unit)}`}
                  medianText={`中央値 ${metricText(stats.median, history.unit)}`}
                  currentText={metricText(stats.current, history.unit)}
                  ariaLabel={`${history.label} 現在 ${metricText(stats.current, history.unit)}、過去5年の5%点から95%点のレンジ内の位置`}
                />
              </div>
              {peer && peer.displayable ? (
                <div>
                  <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-[11px] font-bold text-[var(--color-text-secondary)]">
                    <span>33業種 {valuationModel.peers.sector33.groupName ?? '未分類'} の中({history.label})</span>
                    <span className="font-mono font-semibold text-[var(--color-text-tertiary)]">対象{peer.validCount}/{peer.peerCount}銘柄</span>
                  </div>
                  <PeerBand
                    label={history.label}
                    p25={peer.percentile25}
                    median={peer.median}
                    p75={peer.percentile75}
                    target={peer.target.value}
                    targetText={metricText(peer.target.value, peer.unit)}
                    medianText={metricText(peer.median, peer.unit)}
                  />
                </div>
              ) : (
                <UnavailableNote>同業比較は有効な母数が不足しているため表示しません。</UnavailableNote>
              )}
            </>
          ) : valuation.status === 'ready' ? (
            <UnavailableNote>予想PER・PBRの過去履歴がないため、レンジ位置は表示できません。</UnavailableNote>
          ) : valuation.status === 'error' ? (
            <UnavailableNote>バリュエーション詳細を取得できなかったため、過去・同業との位置は表示できません。</UnavailableNote>
          ) : (
            <p className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">過去レンジ・同業比較を読み込んでいます…</p>
          )}
        </AxisPanel>

        <div className="bg-white lg:col-span-2">
          <AxisPanel
            id="returns"
            icon={HandCoins}
            title="株主還元"
            role="配当の水準と、続けてきた実績(連続性)・利益に対する割合"
            tab="returns"
            tabLabel="株主還元で配当履歴を見る"
            onSelectTab={onSelectTab}
            reads={returnReads}
            pending={pending}
          >
            <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
              <div className="min-w-0 space-y-3">
                <BarLadder
                  title="DPS(円/株) 実績→会社予想"
                  mode="value"
                  rows={[
                    overviewBar('dps-a', 'DPS', overviewReturns?.actualDps, 'per_share', { scale: 'dps', basis: '実績' }),
                    overviewBar('dps-f', 'DPS', overviewReturns?.currentForecastDps, 'per_share', { forecast: true, scale: 'dps', basis: '今期予想' }),
                    overviewBar('dps-n', 'DPS', nextFy?.dps, 'per_share', { forecast: true, scale: 'dps', basis: '来期予想' }),
                  ]}
                />
                <div className="border-y border-[var(--color-border-soft)]">
                  <ShareMeter
                    label="配当性向(実績)"
                    value={availableNumber(overviewReturns?.payoutRatio)}
                    text={overviewText(overviewReturns?.payoutRatio, 'percent').text}
                    max={150}
                    boundary={100}
                    boundaryLabel="100%"
                  />
                </div>
              </div>
              <div className="min-w-0 space-y-3">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                  <Fact label="予想配当利回り" {...factOf(overviewText(overviewReturns?.dividendYield, 'percent', { forecast: true }))} />
                  <Fact label="連続増配" {...factOf(returnText(returnsModel?.direction.consecutiveIncreaseYears), returns.status)} />
                  <Fact label="連続非減配" {...factOf(returnText(returnsModel?.direction.consecutiveNonDecreaseYears), returns.status)} />
                  <Fact label="FCF配当カバー" {...factOf(returnText(returnsModel?.sustainability.fcfDividendCoverage), returns.status)} />
                </div>
                {returns.status === 'error' && <UnavailableNote>株主還元の詳細を取得できなかったため、連続性は表示できません。</UnavailableNote>}
              </div>
            </div>
          </AxisPanel>
        </div>
      </div>

      <footer className="border-t border-[var(--color-border-soft)] px-4 py-2.5 text-[11px] font-medium leading-5 text-[var(--color-text-tertiary)] sm:px-5">
        出典:J-Quants財務。LTM=直近12か月、斜線の棒=会社予想、矢印は文中の2値の向き(同じ単位どうしのみ・表示精度で比較)。{UNAVAILABLE_LEGEND}。
      </footer>
    </section>
  )
}

function metricText(value: number | null | undefined, unit: string | null | undefined): string {
  return formatUnitValue(value, unit, 'missing', { digits: 2 }).text
}

function factOf(
  display: { text: string; unavailable: boolean },
  status?: 'loading' | 'error' | 'ready',
): { value: string; unavailable: boolean } {
  if (status === 'loading') return { value: '読み込み中', unavailable: true }
  if (status === 'error') return { value: '取得不可', unavailable: true }
  return { value: display.text, unavailable: display.unavailable }
}

function FactRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>
}

function AxisPanel({
  id,
  icon: Icon,
  title,
  role,
  tab,
  tabLabel,
  onSelectTab,
  reads,
  pending,
  failed,
  readsPending,
  children,
}: {
  id: AxisId
  icon: LucideIcon
  title: string
  role: string
  tab: FundamentalTabId
  tabLabel: string
  onSelectTab?: (tab: FundamentalTabId) => void
  reads: Reading[]
  pending: boolean
  failed?: string | null
  /** 読み取り行だけが別のデータ待ちのとき */
  readsPending?: boolean
  children: ReactNode
}) {
  return (
    <section
      id={`fundamental-axis-${id}`}
      className="scroll-mt-24 min-w-0 bg-white px-4 py-4 sm:px-5"
      aria-labelledby={`fundamental-axis-title-${id}`}
      data-axis={id}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h3 id={`fundamental-axis-title-${id}`} className="flex items-center gap-1.5 text-[14px] font-bold text-[var(--color-text-primary)]">
            <Icon size={15} className="text-[var(--color-brand-700)]" aria-hidden="true" />{title}
          </h3>
          <p className="mt-0.5 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">{role}</p>
        </div>
        {onSelectTab && (
          <button
            type="button"
            onClick={() => onSelectTab(tab)}
            className="inline-flex min-h-11 shrink-0 items-center gap-0.5 px-1 text-[12px] font-bold text-[var(--color-brand-700)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-700)] sm:min-h-8"
          >
            {tabLabel}<ChevronRight size={13} aria-hidden="true" />
          </button>
        )}
      </header>
      <ul className="mb-3 mt-1.5 space-y-0.5" aria-label={`${title}の読み取り`}>
        {reads.length > 0 ? (
          reads.map((read) => <ReadingLine key={read.key} direction={read.direction}>{read.text}</ReadingLine>)
        ) : (
          <li className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            {(readsPending ?? pending) ? '読み込み中' : failed ?? '比較できる値がありません'}
          </li>
        )}
      </ul>
      <div className="space-y-3">
        {failed && reads.length > 0 && <UnavailableNote>{failed}</UnavailableNote>}
        {pending ? <p className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">データを読み込んでいます…</p> : (
          failed ? <UnavailableNote>{failed}</UnavailableNote> : children
        )}
      </div>
    </section>
  )
}
