import { execGet } from '@/lib/db/client'
import {
  normalizeAsOf,
  type ConsolidationScope,
  type FinancialForecastSnapshot,
  type NormalizedFinancialFact,
} from '@/lib/financial-foundation'
import {
  FINANCIAL_PERFORMANCE_DETAIL_METRICS,
  type FinancialForecastRevisionDirection,
  type FinancialForecastRevisionMetric,
  type FinancialForecastRevisionRow,
  type FinancialPerformanceAvailability,
  type FinancialPerformanceDetailMetric,
  type FinancialPerformanceDetailPeriod,
  type FinancialPerformanceDetailReadModel,
  type FinancialPerformanceSummaryValue,
} from '@/lib/financial-performance-detail'
import {
  type FinancialTimelineMode,
  type FinancialTimelinePeriod,
  type FinancialTimelineValue,
} from '@/lib/financial-performance-timeline'
import { buildFinancialPerformanceTimeline } from '@/lib/server/financial-performance-timeline-read-model'
import {
  loadFinancialForecastSnapshots,
  loadNormalizedFinancialFacts,
} from '@/lib/server/financial-foundation-store'

const MODES: FinancialTimelineMode[] = ['FY', 'YTD', 'STANDALONE', 'LTM']
const FINANCIAL_SECTOR_PATTERN = /銀行|保険|証券|金融/

interface TickerProfile {
  sector17_name: string | null
  sector33_name: string | null
}

function unavailable(
  reason: string,
  availability: Exclude<FinancialPerformanceAvailability, 'available'> = 'missing',
): FinancialPerformanceSummaryValue {
  return {
    value: null,
    unit: null,
    availability,
    reason,
    periodLabel: null,
    inputIds: [],
  }
}

function available(
  value: number,
  unit: string,
  periodLabel: string,
  inputIds: string[],
): FinancialPerformanceSummaryValue {
  return {
    value,
    unit,
    availability: 'available',
    reason: null,
    periodLabel,
    inputIds,
  }
}

function correctionRank(status: string): number {
  if (status === 'restated') return 2
  if (status === 'corrected') return 1
  return 0
}

function latestFact(candidates: NormalizedFinancialFact[]): NormalizedFinancialFact | undefined {
  return [...candidates].sort((a, b) => (
    b.publishedAt.localeCompare(a.publishedAt)
    || correctionRank(b.correctionStatus) - correctionRank(a.correctionStatus)
    || b.factId.localeCompare(a.factId)
  ))[0]
}

function modeAccumulation(mode: FinancialTimelineMode): NormalizedFinancialFact['accumulationKind'] {
  if (mode === 'FY') return 'FY'
  if (mode === 'YTD') return 'YTD'
  if (mode === 'STANDALONE') return 'STANDALONE'
  return 'LTM'
}

function matchingActualFact(
  facts: NormalizedFinancialFact[],
  period: FinancialTimelinePeriod,
  mode: FinancialTimelineMode,
  metric: string,
): NormalizedFinancialFact | undefined {
  return latestFact(facts.filter((fact) => (
    fact.metric === metric
    && fact.accumulationKind === modeAccumulation(mode)
    && fact.periodEnd === period.periodEnd
    && fact.periodKind === period.periodKind
    && fact.targetFiscalYear === period.targetFiscalYear
    && fact.consolidationScope === period.consolidationScope
    && fact.accountingStandard === period.accountingStandard
  )))
}

function valueFromFact(fact: NormalizedFinancialFact): FinancialTimelineValue {
  return {
    value: fact.value,
    unit: fact.unit,
    publishedAt: fact.publishedAt,
    source: fact.source,
    inputIds: fact.inputFactIds.length > 0 ? fact.inputFactIds : [fact.factId],
    definitionVersion: fact.definitionVersion,
    yoyPercent: null,
    revision: null,
  }
}

function previousForecast(
  snapshots: FinancialForecastSnapshot[],
  snapshot: FinancialForecastSnapshot,
): FinancialForecastSnapshot | undefined {
  return snapshots
    .filter((candidate) => (
      candidate.snapshotId !== snapshot.snapshotId
      && candidate.metric === snapshot.metric
      && candidate.targetFiscalYear === snapshot.targetFiscalYear
      && candidate.forecastPeriod === snapshot.forecastPeriod
      && candidate.consolidationScope === snapshot.consolidationScope
      && candidate.accountingStandard === snapshot.accountingStandard
      && candidate.publishedAt < snapshot.publishedAt
    ))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.snapshotId.localeCompare(a.snapshotId))[0]
}

function valueFromForecast(
  snapshots: FinancialForecastSnapshot[],
  snapshot: FinancialForecastSnapshot,
): FinancialTimelineValue {
  const previous = previousForecast(snapshots, snapshot)
  return {
    value: snapshot.value,
    unit: snapshot.unit,
    publishedAt: snapshot.publishedAt,
    source: 'jquants',
    inputIds: [snapshot.snapshotId],
    definitionVersion: null,
    yoyPercent: null,
    revision: previous ? {
      previousValue: previous.value,
      previousPublishedAt: previous.publishedAt,
      ratePercent: previous.value === 0
        ? null
        : ((snapshot.value - previous.value) / Math.abs(previous.value)) * 100,
    } : null,
  }
}

function matchingForecast(
  snapshots: FinancialForecastSnapshot[],
  period: FinancialTimelinePeriod,
  metric: string,
): FinancialForecastSnapshot | undefined {
  return snapshots
    .filter((snapshot) => (
      snapshot.metric === metric
      && snapshot.forecastPeriod === 'FY'
      && snapshot.targetFiscalYear === period.targetFiscalYear
      && snapshot.forecastScope === period.forecastScope
      && snapshot.consolidationScope === period.consolidationScope
      && snapshot.accountingStandard === period.accountingStandard
    ))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.snapshotId.localeCompare(a.snapshotId))[0]
}

function previousDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() - 1)
  return parsed.toISOString().slice(0, 10)
}

function latestBalanceBefore(
  facts: NormalizedFinancialFact[],
  metric: string,
  beforeOrAt: string,
  scope: ConsolidationScope,
  accountingStandard: string,
): NormalizedFinancialFact | undefined {
  const candidates = facts.filter((fact) => (
    fact.metric === metric
    && fact.valueKind === 'instant'
    && fact.periodEnd <= beforeOrAt
    && fact.consolidationScope === scope
    && fact.accountingStandard === accountingStandard
  ))
  const latestPeriodEnd = candidates.map((fact) => fact.periodEnd).sort().at(-1)
  return latestPeriodEnd
    ? latestFact(candidates.filter((fact) => fact.periodEnd === latestPeriodEnd))
    : undefined
}

function ratioValue(
  numerator: FinancialTimelineValue | null,
  denominator: FinancialTimelineValue | null,
  periodLabel: string,
  label: string,
): FinancialPerformanceSummaryValue {
  if (!numerator || !denominator || denominator.value <= 0) {
    return unavailable(`${label}に必要な同一期間の正の売上高と利益が揃っていません。`)
  }
  return available(
    (numerator.value / denominator.value) * 100,
    'PERCENT',
    periodLabel,
    [...numerator.inputIds, ...denominator.inputIds],
  )
}

function returnOnBalance(
  facts: NormalizedFinancialFact[],
  anchor: NormalizedFinancialFact | undefined,
  metric: 'equity_attributable' | 'total_assets',
  periodLabel: string,
): FinancialPerformanceSummaryValue {
  if (!anchor?.periodStart) return unavailable('期間利益または期首日がないため算定できません。')
  const beginning = latestBalanceBefore(
    facts,
    metric,
    previousDay(anchor.periodStart),
    anchor.consolidationScope,
    anchor.accountingStandard,
  )
  const ending = latestBalanceBefore(
    facts,
    metric,
    anchor.periodEnd,
    anchor.consolidationScope,
    anchor.accountingStandard,
  )
  if (!beginning || !ending) return unavailable('同一会計基準・連結区分の期首期末残高が揃っていません。')
  const average = (beginning.value + ending.value) / 2
  if (average <= 0) return unavailable('平均残高が正数ではないため算定できません。', 'not_meaningful')
  return available(
    (anchor.value / average) * 100,
    'PERCENT',
    periodLabel,
    [anchor.factId, beginning.factId, ending.factId],
  )
}

function profitabilityForPeriod(
  facts: NormalizedFinancialFact[],
  period: FinancialPerformanceDetailPeriod,
  mode: FinancialTimelineMode,
  anchorNet: NormalizedFinancialFact | undefined,
  isFinancialSector: boolean,
): FinancialPerformanceDetailPeriod['profitability'] {
  const revenue = period.metrics.revenue
  const operatingProfit = period.metrics.operating_profit
  const netIncome = period.metrics.net_income_attributable
  const grossProfit = period.pointType === 'actual'
    ? matchingActualFact(facts, period as unknown as FinancialTimelinePeriod, mode, 'gross_profit')
    : undefined
  const grossMargin = grossProfit
    ? ratioValue(valueFromFact(grossProfit), revenue, period.label, '粗利率')
    : unavailable('正規化済み財務factに粗利益がないため表示できません。')
  const financialReason = '金融業では一般事業会社と同じ売上高・利益率定義で比較しないため適用外です。'
  const operatingMargin = isFinancialSector
    ? unavailable(financialReason, 'not_applicable')
    : ratioValue(operatingProfit, revenue, period.label, '営業利益率')
  const netMargin = isFinancialSector
    ? unavailable(financialReason, 'not_applicable')
    : ratioValue(netIncome, revenue, period.label, '純利益率')
  const returnUnavailable = period.pointType !== 'actual'
    ? unavailable('会社予想には期首・期末残高予想がないため算定しません。')
    : null
  return {
    grossMargin,
    operatingMargin,
    netMargin,
    roe: returnUnavailable ?? returnOnBalance(facts, anchorNet, 'equity_attributable', period.label),
    roa: returnUnavailable ?? returnOnBalance(facts, anchorNet, 'total_assets', period.label),
  }
}

function previousPeriod(
  periods: FinancialPerformanceDetailPeriod[],
  period: FinancialPerformanceDetailPeriod,
  mode: FinancialTimelineMode,
  metric: FinancialPerformanceDetailMetric,
): FinancialPerformanceDetailPeriod | undefined {
  const candidates = periods.filter((candidate) => candidate.key !== period.key && candidate.metrics[metric])
  if (mode !== 'LTM' && period.targetFiscalYear != null) {
    return candidates.find((candidate) => (
      candidate.targetFiscalYear === period.targetFiscalYear! - 1
      && (mode === 'FY' || candidate.periodKind === period.periodKind)
    ))
  }
  const current = Date.parse(`${period.periodEnd}T00:00:00Z`)
  return candidates
    .map((candidate) => ({
      candidate,
      gap: (current - Date.parse(`${candidate.periodEnd}T00:00:00Z`)) / 86_400_000,
    }))
    .filter(({ gap }) => gap >= 300 && gap <= 430)
    .sort((a, b) => Math.abs(a.gap - 365) - Math.abs(b.gap - 365))[0]?.candidate
}

function addYoy(
  periods: FinancialPerformanceDetailPeriod[],
  mode: FinancialTimelineMode,
): FinancialPerformanceDetailPeriod[] {
  return periods.map((period) => ({
    ...period,
    metrics: Object.fromEntries(FINANCIAL_PERFORMANCE_DETAIL_METRICS.map((metric) => {
      const current = period.metrics[metric]
      if (!current) return [metric, null]
      const previous = previousPeriod(periods, period, mode, metric)?.metrics[metric]
      const yoyPercent = previous && previous.value > 0
        ? ((current.value / previous.value) - 1) * 100
        : null
      return [metric, { ...current, yoyPercent }]
    })) as FinancialPerformanceDetailPeriod['metrics'],
  }))
}

function buildDetailPeriods(
  basePeriods: FinancialTimelinePeriod[],
  mode: FinancialTimelineMode,
  facts: NormalizedFinancialFact[],
  forecasts: FinancialForecastSnapshot[],
  isFinancialSector: boolean,
): FinancialPerformanceDetailPeriod[] {
  const periods = basePeriods.map((period) => {
    const actualNet = period.pointType === 'actual'
      ? matchingActualFact(facts, period, mode, 'net_income_attributable')
      : undefined
    const forecastNet = period.pointType !== 'actual'
      ? matchingForecast(forecasts, period, 'net_income_attributable')
      : undefined
    const netIncome = actualNet
      ? valueFromFact(actualNet)
      : forecastNet ? valueFromForecast(forecasts, forecastNet) : null
    const detailPeriod: FinancialPerformanceDetailPeriod = {
      ...period,
      metrics: {
        revenue: period.metrics.revenue,
        operating_profit: period.metrics.operating_profit,
        net_income_attributable: netIncome,
        eps_basic: period.metrics.eps_basic,
      },
      profitability: {
        grossMargin: unavailable('算定前'),
        operatingMargin: unavailable('算定前'),
        netMargin: unavailable('算定前'),
        roe: unavailable('算定前'),
        roa: unavailable('算定前'),
      },
    }
    detailPeriod.profitability = profitabilityForPeriod(facts, detailPeriod, mode, actualNet, isFinancialSector)
    return detailPeriod
  })
  return addYoy(periods, mode)
}

function summaryFromValue(
  value: FinancialTimelineValue | null,
  periodLabel: string | null,
  reason: string,
): FinancialPerformanceSummaryValue {
  return value && periodLabel
    ? available(value.value, value.unit, periodLabel, value.inputIds)
    : unavailable(reason)
}

function cagrValue(
  periods: FinancialPerformanceDetailPeriod[],
  metric: 'revenue' | 'eps_basic',
  years: 3 | 5,
): FinancialPerformanceSummaryValue {
  const actual = periods.filter((period) => period.pointType === 'actual' && period.targetFiscalYear != null)
  const latest = [...actual].reverse().find((period) => period.metrics[metric])
  if (!latest?.targetFiscalYear) return unavailable(`${years}年CAGRの最新FY値がありません。`)
  const base = actual.find((period) => period.targetFiscalYear === latest.targetFiscalYear! - years)
  const latestValue = latest.metrics[metric]
  const baseValue = base?.metrics[metric]
  if (!latestValue || !baseValue) return unavailable(`${years}年前と最新FYの値が揃っていません。`)
  if (latestValue.value <= 0 || baseValue.value <= 0) {
    return unavailable('起点または終点が正数ではないためCAGRはN/Mです。', 'not_meaningful')
  }
  return available(
    (Math.pow(latestValue.value / baseValue.value, 1 / years) - 1) * 100,
    'PERCENT',
    `${base.label}→${latest.label}`,
    [...baseValue.inputIds, ...latestValue.inputIds],
  )
}

function forecastRevisionMetric(
  snapshots: FinancialForecastSnapshot[],
  snapshot: FinancialForecastSnapshot | undefined,
): FinancialForecastRevisionMetric | null {
  if (!snapshot) return null
  const previous = previousForecast(snapshots, snapshot)
  return {
    value: snapshot.value,
    unit: snapshot.unit,
    previousValue: previous?.value ?? null,
    previousPublishedAt: previous?.publishedAt ?? null,
    revisionPercent: previous
      ? previous.value === 0 ? null : ((snapshot.value - previous.value) / Math.abs(previous.value)) * 100
      : null,
  }
}

function revisionDirection(
  metrics: Record<FinancialPerformanceDetailMetric, FinancialForecastRevisionMetric | null>,
): FinancialForecastRevisionDirection {
  const deltas = Object.values(metrics)
    .filter((metric): metric is FinancialForecastRevisionMetric => metric?.previousValue != null)
    .map((metric) => metric.value - metric.previousValue!)
  if (deltas.length === 0) return 'initial'
  const up = deltas.some((delta) => delta > 0)
  const down = deltas.some((delta) => delta < 0)
  if (up && down) return 'mixed'
  if (up) return 'up'
  if (down) return 'down'
  return 'unchanged'
}

function buildForecastHistory(snapshots: FinancialForecastSnapshot[]): FinancialForecastRevisionRow[] {
  const candidates = snapshots.filter((snapshot) => (
    snapshot.forecastPeriod === 'FY'
    && FINANCIAL_PERFORMANCE_DETAIL_METRICS.includes(snapshot.metric as FinancialPerformanceDetailMetric)
  ))
  const scoped = candidates.filter((snapshot) => {
    const sameYear = candidates.filter((candidate) => candidate.targetFiscalYear === snapshot.targetFiscalYear)
    const preferredScope: ConsolidationScope = sameYear.some((candidate) => candidate.consolidationScope === 'consolidated')
      ? 'consolidated'
      : 'standalone'
    return snapshot.consolidationScope === preferredScope
  })
  const groups = new Map<string, FinancialForecastSnapshot[]>()
  for (const snapshot of scoped) {
    const key = [
      snapshot.eventId,
      snapshot.targetFiscalYear,
      snapshot.forecastScope,
      snapshot.consolidationScope,
      snapshot.accountingStandard,
    ].join('|')
    groups.set(key, [...(groups.get(key) ?? []), snapshot])
  }
  return [...groups.entries()].map(([key, group]) => {
    const selected = Object.fromEntries(FINANCIAL_PERFORMANCE_DETAIL_METRICS.map((metric) => {
      const snapshot = group
        .filter((candidate) => candidate.metric === metric)
        .sort((a, b) => b.snapshotId.localeCompare(a.snapshotId))[0]
      return [metric, forecastRevisionMetric(scoped, snapshot)]
    })) as Record<FinancialPerformanceDetailMetric, FinancialForecastRevisionMetric | null>
    const representative = [...group].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0]
    return {
      key,
      publishedAt: representative.publishedAt,
      targetFiscalYear: representative.targetFiscalYear,
      forecastScope: representative.forecastScope,
      consolidationScope: representative.consolidationScope,
      accountingStandard: representative.accountingStandard,
      disclosureId: representative.disclosureId,
      direction: revisionDirection(selected),
      metrics: selected,
    }
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.key.localeCompare(a.key))
}

export function buildFinancialPerformanceDetail(
  ticker: string,
  asOf: string,
  allFacts: NormalizedFinancialFact[],
  allForecasts: FinancialForecastSnapshot[],
  isFinancialSector: boolean,
): FinancialPerformanceDetailReadModel {
  const cutoff = normalizeAsOf(asOf)
  const facts = allFacts.filter((fact) => fact.ticker === ticker && fact.publishedAt <= cutoff)
  const forecasts = allForecasts.filter((snapshot) => snapshot.ticker === ticker && snapshot.publishedAt <= cutoff)
  const base = buildFinancialPerformanceTimeline(ticker, asOf, facts, forecasts)
  const modes = Object.fromEntries(MODES.map((mode) => [mode, {
    mode,
    label: base.modes[mode].label,
    note: base.modes[mode].note,
    periods: buildDetailPeriods(base.modes[mode].periods, mode, facts, forecasts, isFinancialSector),
  }])) as FinancialPerformanceDetailReadModel['modes']
  const latestLtm = [...modes.LTM.periods].reverse().find((period) => period.pointType === 'actual')
  const latestFy = [...modes.FY.periods].reverse().find((period) => period.pointType === 'actual')
  const anchor = latestLtm ?? latestFy
  const forecastHistory = buildForecastHistory(forecasts)
  const noLatest = '最新LTMまたはFYの正規化済みfactがありません。'

  return {
    contractVersion: 'financial-performance-detail-v1',
    ticker,
    asOf: normalizeAsOf(asOf).slice(0, 10),
    isFinancialSector,
    summary: {
      scale: {
        revenue: summaryFromValue(anchor?.metrics.revenue ?? null, anchor?.label ?? null, noLatest),
        operatingProfit: summaryFromValue(anchor?.metrics.operating_profit ?? null, anchor?.label ?? null, noLatest),
        netIncome: summaryFromValue(anchor?.metrics.net_income_attributable ?? null, anchor?.label ?? null, noLatest),
        eps: summaryFromValue(anchor?.metrics.eps_basic ?? null, anchor?.label ?? null, noLatest),
      },
      profitability: {
        operatingMargin: anchor?.profitability.operatingMargin ?? unavailable(noLatest),
        roe: anchor?.profitability.roe ?? unavailable(noLatest),
        roa: anchor?.profitability.roa ?? unavailable(noLatest),
      },
      growth: {
        revenueCagr3y: cagrValue(modes.FY.periods, 'revenue', 3),
        revenueCagr5y: cagrValue(modes.FY.periods, 'revenue', 5),
        epsCagr3y: cagrValue(modes.FY.periods, 'eps_basic', 3),
        epsCagr5y: cagrValue(modes.FY.periods, 'eps_basic', 5),
      },
    },
    modes,
    forecastHistory,
    coverage: {
      facts: facts.length,
      forecastSnapshots: forecasts.length,
      forecastHistoryRows: forecastHistory.length,
    },
  }
}

export async function getFinancialPerformanceDetailReadModel(
  ticker: string,
  requestedAsOf?: string | null,
): Promise<FinancialPerformanceDetailReadModel> {
  const [latestPrice, profile, facts, forecasts] = await Promise.all([
    execGet<{ date: string }>('SELECT date FROM ohlcv_daily WHERE ticker = ? ORDER BY date DESC LIMIT 1', [ticker]),
    execGet<TickerProfile>('SELECT sector17_name, sector33_name FROM ticker_universe WHERE ticker = ?', [ticker]),
    loadNormalizedFinancialFacts(ticker),
    loadFinancialForecastSnapshots(ticker),
  ])
  const asOf = requestedAsOf || latestPrice?.date || new Date().toISOString().slice(0, 10)
  const sectorText = `${profile?.sector17_name ?? ''} ${profile?.sector33_name ?? ''}`
  return buildFinancialPerformanceDetail(
    ticker,
    asOf,
    facts,
    forecasts,
    FINANCIAL_SECTOR_PATTERN.test(sectorText),
  )
}
