import { execGet } from '@/lib/db/client'
import {
  normalizeAsOf,
  type ConsolidationScope,
  type FinancialForecastSnapshot,
  type NormalizedFinancialFact,
} from '@/lib/financial-foundation'
import {
  FINANCIAL_TIMELINE_METRICS,
  FINANCIAL_TIMELINE_MODE_LABELS,
  type FinancialPerformanceTimelineReadModel,
  type FinancialTimelineMetric,
  type FinancialTimelineMode,
  type FinancialTimelineModeSeries,
  type FinancialTimelinePeriod,
  type FinancialTimelineValue,
} from '@/lib/financial-performance-timeline'
import {
  loadFinancialForecastSnapshots,
  loadNormalizedFinancialFacts,
} from '@/lib/server/financial-foundation-store'

const TIMELINE_MODES: FinancialTimelineMode[] = ['FY', 'YTD', 'STANDALONE', 'LTM']
const QUARTERS = new Set(['Q1', 'Q2', 'Q3', 'Q4', 'H1'])
const EPS_INPUT_METRICS = new Set(['net_income_attributable', 'weighted_average_shares'])

interface PeriodIdentity {
  periodEnd: string
  targetFiscalYear: number | null
  periodKind: NormalizedFinancialFact['periodKind']
}

function matchesMode(fact: NormalizedFinancialFact, mode: FinancialTimelineMode): boolean {
  if (mode === 'FY') return fact.accumulationKind === 'FY' && fact.periodKind === 'FY'
  if (mode === 'YTD') return fact.accumulationKind === 'YTD' && QUARTERS.has(fact.periodKind)
  if (mode === 'STANDALONE') return fact.accumulationKind === 'STANDALONE' && QUARTERS.has(fact.periodKind)
  return fact.accumulationKind === 'LTM' && fact.periodKind === 'LTM'
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
    || Number(b.accountingStandard !== 'UNKNOWN') - Number(a.accountingStandard !== 'UNKNOWN')
    || b.factId.localeCompare(a.factId)
  ))[0]
}

function preferredScope(
  facts: NormalizedFinancialFact[],
  mode: FinancialTimelineMode,
): ConsolidationScope | null {
  const candidates = facts.filter((fact) => (
    matchesMode(fact, mode)
    && (FINANCIAL_TIMELINE_METRICS.includes(fact.metric as FinancialTimelineMetric) || EPS_INPUT_METRICS.has(fact.metric))
  ))
  if (candidates.some((fact) => fact.consolidationScope === 'consolidated')) return 'consolidated'
  if (candidates.some((fact) => fact.consolidationScope === 'standalone')) return 'standalone'
  return null
}

function identityKey(identity: PeriodIdentity): string {
  return [identity.periodEnd, identity.periodKind, identity.targetFiscalYear ?? ''].join('|')
}

function factMatchesIdentity(fact: NormalizedFinancialFact, identity: PeriodIdentity): boolean {
  return fact.periodEnd === identity.periodEnd
    && fact.periodKind === identity.periodKind
    && fact.targetFiscalYear === identity.targetFiscalYear
}

function actualValue(fact: NormalizedFinancialFact): FinancialTimelineValue {
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

function derivedEpsValue(
  facts: NormalizedFinancialFact[],
  identity: PeriodIdentity,
  scope: ConsolidationScope,
): FinancialTimelineValue | null {
  const netCandidates = facts.filter((fact) => (
    fact.metric === 'net_income_attributable'
    && fact.consolidationScope === scope
    && factMatchesIdentity(fact, identity)
  ))
  const pairs = netCandidates.flatMap((net) => facts
    .filter((shares) => (
      shares.metric === 'weighted_average_shares'
      && shares.consolidationScope === scope
      && shares.accountingStandard === net.accountingStandard
      && shares.periodEnd === net.periodEnd
      && shares.periodKind === net.periodKind
      && shares.targetFiscalYear === net.targetFiscalYear
      && shares.accumulationKind === net.accumulationKind
      && shares.value > 0
    ))
    .map((shares) => ({ net, shares })))
    .sort((a, b) => {
      const aPublishedAt = [a.net.publishedAt, a.shares.publishedAt].sort().at(-1)!
      const bPublishedAt = [b.net.publishedAt, b.shares.publishedAt].sort().at(-1)!
      return bPublishedAt.localeCompare(aPublishedAt) || b.net.factId.localeCompare(a.net.factId)
    })
  const pair = pairs[0]
  if (!pair) return null
  return {
    value: pair.net.value / pair.shares.value,
    unit: 'JPY_PER_SHARE',
    publishedAt: [pair.net.publishedAt, pair.shares.publishedAt].sort().at(-1)!,
    source: 'calculated',
    inputIds: [pair.net.factId, pair.shares.factId],
    definitionVersion: 'timeline-eps-period-net-income-v1',
    yoyPercent: null,
    revision: null,
  }
}

function periodLabel(identity: PeriodIdentity, mode: FinancialTimelineMode): string {
  const year = identity.targetFiscalYear ?? Number(identity.periodEnd.slice(0, 4))
  if (mode === 'FY') return `FY${year}`
  if (mode === 'LTM') return `LTM ${identity.periodEnd.slice(2, 7).replace('-', '/')}`
  const suffix = mode === 'YTD' ? '累計' : ''
  return `FY${year} ${identity.periodKind}${suffix}`
}

function buildActualPeriods(
  facts: NormalizedFinancialFact[],
  mode: FinancialTimelineMode,
): { periods: FinancialTimelinePeriod[]; scope: ConsolidationScope | null } {
  const scope = preferredScope(facts, mode)
  if (!scope) return { periods: [], scope: null }
  const candidates = facts.filter((fact) => matchesMode(fact, mode) && fact.consolidationScope === scope)
  const identities = new Map<string, PeriodIdentity>()
  for (const fact of candidates) {
    if (!FINANCIAL_TIMELINE_METRICS.includes(fact.metric as FinancialTimelineMetric) && !EPS_INPUT_METRICS.has(fact.metric)) continue
    const identity = {
      periodEnd: fact.periodEnd,
      targetFiscalYear: fact.targetFiscalYear,
      periodKind: fact.periodKind,
    }
    identities.set(identityKey(identity), identity)
  }

  return {
    scope,
    periods: [...identities.values()].map((identity) => {
      const metricValues = Object.fromEntries(FINANCIAL_TIMELINE_METRICS.map((metric) => {
        const direct = latestFact(candidates.filter((fact) => fact.metric === metric && factMatchesIdentity(fact, identity)))
        const value = direct
          ? actualValue(direct)
          : metric === 'eps_basic' ? derivedEpsValue(candidates, identity, scope) : null
        return [metric, value]
      })) as Record<FinancialTimelineMetric, FinancialTimelineValue | null>
      const sourceFacts = candidates.filter((fact) => factMatchesIdentity(fact, identity))
      const accountingStandard = latestFact(sourceFacts)?.accountingStandard ?? 'UNKNOWN'
      const publishedAt = Object.values(metricValues)
        .flatMap((value) => value?.publishedAt ?? [])
        .sort()
        .at(-1) ?? ''
      return {
        key: `actual:${mode}:${identityKey(identity)}`,
        label: periodLabel(identity, mode),
        periodEnd: identity.periodEnd,
        targetFiscalYear: identity.targetFiscalYear,
        periodKind: identity.periodKind,
        pointType: 'actual' as const,
        forecastScope: null,
        publishedAt,
        consolidationScope: scope,
        accountingStandard,
        metrics: metricValues,
      }
    })
      .filter((period) => Object.values(period.metrics).some(Boolean))
      .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.periodKind.localeCompare(b.periodKind)),
  }
}

function latestSnapshot(candidates: FinancialForecastSnapshot[]): FinancialForecastSnapshot | undefined {
  return [...candidates].sort((a, b) => (
    b.publishedAt.localeCompare(a.publishedAt) || b.snapshotId.localeCompare(a.snapshotId)
  ))[0]
}

function forecastValue(
  snapshot: FinancialForecastSnapshot,
  snapshots: FinancialForecastSnapshot[],
): FinancialTimelineValue {
  const previous = latestSnapshot(snapshots.filter((candidate) => (
    candidate.snapshotId !== snapshot.snapshotId
    && candidate.metric === snapshot.metric
    && candidate.targetFiscalYear === snapshot.targetFiscalYear
    && candidate.forecastPeriod === snapshot.forecastPeriod
    && candidate.consolidationScope === snapshot.consolidationScope
    && candidate.accountingStandard === snapshot.accountingStandard
    && candidate.publishedAt < snapshot.publishedAt
  )))
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
      ratePercent: previous.value === 0 ? null : ((snapshot.value - previous.value) / Math.abs(previous.value)) * 100,
    } : null,
  }
}

function buildForecastPeriods(
  facts: NormalizedFinancialFact[],
  snapshots: FinancialForecastSnapshot[],
): FinancialTimelinePeriod[] {
  const completedFiscalYear = facts
    .filter((fact) => fact.accumulationKind === 'FY' && fact.targetFiscalYear != null)
    .map((fact) => fact.targetFiscalYear!)
    .sort((a, b) => b - a)[0] ?? null
  const future = snapshots.filter((snapshot) => (
    snapshot.forecastPeriod === 'FY'
    && FINANCIAL_TIMELINE_METRICS.includes(snapshot.metric as FinancialTimelineMetric)
    && (completedFiscalYear == null || snapshot.targetFiscalYear > completedFiscalYear)
  ))
  const scope: ConsolidationScope | null = future.some((snapshot) => snapshot.consolidationScope === 'consolidated')
    ? 'consolidated'
    : future.some((snapshot) => snapshot.consolidationScope === 'standalone') ? 'standalone' : null
  if (!scope) return []
  const scoped = future.filter((snapshot) => snapshot.consolidationScope === scope)
  const years = [...new Set(scoped.map((snapshot) => snapshot.targetFiscalYear))].sort((a, b) => a - b).slice(0, 2)

  return years.map((year) => {
    const selected = FINANCIAL_TIMELINE_METRICS.map((metric) => latestSnapshot(scoped.filter((snapshot) => (
      snapshot.metric === metric && snapshot.targetFiscalYear === year
    ))))
    const available = selected.filter((snapshot): snapshot is FinancialForecastSnapshot => Boolean(snapshot))
    const latest = [...available].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0]
    const forecastScope = latest?.forecastScope ?? 'current_fy'
    const metrics = Object.fromEntries(FINANCIAL_TIMELINE_METRICS.map((metric, index) => [
      metric,
      selected[index] ? forecastValue(selected[index]!, scoped) : null,
    ])) as Record<FinancialTimelineMetric, FinancialTimelineValue | null>
    return {
      key: `forecast:${year}:${forecastScope}`,
      label: `FY${year} ${forecastScope === 'next_fy' ? '翌期予想' : '会社予想'}`,
      periodEnd: latest?.targetPeriodEnd ?? `${year}-12-31`,
      targetFiscalYear: year,
      periodKind: 'FY' as const,
      pointType: forecastScope === 'next_fy' ? 'next_forecast' as const : 'current_forecast' as const,
      forecastScope,
      publishedAt: latest?.publishedAt ?? '',
      consolidationScope: scope,
      accountingStandard: latest?.accountingStandard ?? 'UNKNOWN',
      metrics,
    }
  }).filter((period) => Object.values(period.metrics).some(Boolean))
}

function previousComparable(
  periods: FinancialTimelinePeriod[],
  period: FinancialTimelinePeriod,
  mode: FinancialTimelineMode,
  metric: FinancialTimelineMetric,
): FinancialTimelineValue | null {
  const candidates = periods.filter((candidate) => candidate.key !== period.key && candidate.metrics[metric])
  if (mode !== 'LTM' && period.targetFiscalYear != null) {
    return candidates.find((candidate) => (
      candidate.targetFiscalYear === period.targetFiscalYear! - 1
      && (mode === 'FY' || candidate.periodKind === period.periodKind)
    ))?.metrics[metric] ?? null
  }
  const current = Date.parse(`${period.periodEnd}T00:00:00Z`)
  return candidates
    .map((candidate) => ({ candidate, gap: (current - Date.parse(`${candidate.periodEnd}T00:00:00Z`)) / 86_400_000 }))
    .filter(({ gap }) => gap >= 300 && gap <= 430)
    .sort((a, b) => Math.abs(a.gap - 365) - Math.abs(b.gap - 365))[0]
    ?.candidate.metrics[metric] ?? null
}

function addYoy(
  periods: FinancialTimelinePeriod[],
  mode: FinancialTimelineMode,
): FinancialTimelinePeriod[] {
  return periods.map((period) => ({
    ...period,
    metrics: Object.fromEntries(FINANCIAL_TIMELINE_METRICS.map((metric) => {
      const current = period.metrics[metric]
      const previous = current ? previousComparable(periods, period, mode, metric) : null
      const yoyPercent = current && previous && previous.value > 0
        ? ((current.value / previous.value) - 1) * 100
        : null
      return [metric, current ? { ...current, yoyPercent } : null]
    })) as Record<FinancialTimelineMetric, FinancialTimelineValue | null>,
  }))
}

export function buildFinancialPerformanceTimeline(
  ticker: string,
  asOf: string,
  allFacts: NormalizedFinancialFact[],
  allForecasts: FinancialForecastSnapshot[],
): FinancialPerformanceTimelineReadModel {
  const cutoff = normalizeAsOf(asOf)
  const facts = allFacts.filter((fact) => fact.ticker === ticker && fact.publishedAt <= cutoff)
  const forecasts = allForecasts.filter((snapshot) => snapshot.ticker === ticker && snapshot.publishedAt <= cutoff)
  const modes = Object.fromEntries(TIMELINE_MODES.map((mode) => {
    const actual = buildActualPeriods(facts, mode)
    const forecastPeriods = mode === 'FY' ? buildForecastPeriods(facts, forecasts) : []
    const periods = addYoy([...actual.periods, ...forecastPeriods].sort((a, b) => (
      a.periodEnd.localeCompare(b.periodEnd) || a.pointType.localeCompare(b.pointType)
    )), mode)
    const series: FinancialTimelineModeSeries = {
      mode,
      label: FINANCIAL_TIMELINE_MODE_LABELS[mode],
      consolidationScope: actual.scope,
      periods,
      note: mode === 'FY' ? null : '会社予想は通期値のためFY表示で確認できます。',
    }
    return [mode, series]
  })) as Record<FinancialTimelineMode, FinancialTimelineModeSeries>
  const allPeriods = Object.values(modes).flatMap((mode) => mode.periods)
  return {
    contractVersion: 'financial-performance-timeline-v1',
    ticker,
    asOf: normalizeAsOf(asOf).slice(0, 10),
    modes,
    coverage: {
      facts: facts.length,
      forecastSnapshots: forecasts.length,
      actualPeriods: allPeriods.filter((period) => period.pointType === 'actual').length,
      forecastPeriods: modes.FY.periods.filter((period) => period.pointType !== 'actual').length,
    },
  }
}

export async function getFinancialPerformanceTimelineReadModel(
  ticker: string,
  requestedAsOf?: string | null,
): Promise<FinancialPerformanceTimelineReadModel> {
  const [latestPrice, facts, forecasts] = await Promise.all([
    execGet<{ date: string }>('SELECT date FROM ohlcv_daily WHERE ticker = ? ORDER BY date DESC LIMIT 1', [ticker]),
    loadNormalizedFinancialFacts(ticker),
    loadFinancialForecastSnapshots(ticker),
  ])
  const asOf = requestedAsOf || latestPrice?.date || new Date().toISOString().slice(0, 10)
  return buildFinancialPerformanceTimeline(ticker, asOf, facts, forecasts)
}
