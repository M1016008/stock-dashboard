import { execAll, execGet } from '@/lib/db/client'
import {
  normalizeAsOf,
  selectForecastsAsOf,
  type FinancialForecastSnapshot,
  type NormalizedFinancialFact,
} from '@/lib/financial-foundation'
import {
  calculateAdvancedFinancialMetrics,
  calculateFinancialMetrics,
  METRIC_DEFINITION_REGISTRY,
  type CalculatedFinancialMetric,
  type FinancialMetricKey,
} from '@/lib/financial-metrics'
import {
  type DividendDirection,
  type DividendForecastRevision,
  type DividendHistoryRow,
  type DividendSplitAdjustment,
  type ForecastRevisionDirection,
  type ShareCountHistoryRow,
  type ShareholderReturnAvailability,
  type ShareholderReturnsReadModel,
  type ShareholderReturnValue,
} from '@/lib/shareholder-returns'
import { loadDetailedFinancialFacts } from '@/lib/server/detailed-financial-foundation-store'
import {
  loadFinancialForecastSnapshotsForTickers,
  loadNormalizedFinancialFactsForTickers,
} from '@/lib/server/financial-foundation-store'

interface PriceRow {
  date: string
  close: number
}

interface TickerProfile {
  name: string | null
  sector17_name: string | null
  sector33_name: string | null
}

interface AnnualFacts {
  fiscalYear: number
  periodEnd: string
  dps?: NormalizedFinancialFact
  eps?: NormalizedFinancialFact
  payoutRatio?: NormalizedFinancialFact
  issuedShares?: NormalizedFinancialFact
  treasuryShares?: NormalizedFinancialFact
}

const FINANCIAL_SECTOR_PATTERN = /銀行|保険|証券|金融/
const KNOWN_SHARE_FACTORS = [0.1, 0.2, 0.25, 0.5, 2, 3, 4, 5, 10] as const
const CACHE_TTL_MS = 60_000
const modelCache = new Map<string, { expiresAt: number; value: ShareholderReturnsReadModel }>()

function unavailable(
  reason: string,
  availability: Exclude<ShareholderReturnAvailability, 'available'> = 'missing',
): ShareholderReturnValue {
  return {
    value: null,
    unit: null,
    availability,
    reason,
    periodEnd: null,
    publishedAt: null,
    definitionVersion: null,
    inputIds: [],
  }
}

function available(
  value: number,
  unit: string,
  options: {
    periodEnd?: string | null
    publishedAt?: string | null
    definitionVersion?: string | null
    inputIds?: string[]
  } = {},
): ShareholderReturnValue {
  return {
    value,
    unit,
    availability: 'available',
    reason: null,
    periodEnd: options.periodEnd ?? null,
    publishedAt: options.publishedAt ?? null,
    definitionVersion: options.definitionVersion ?? null,
    inputIds: options.inputIds ?? [],
  }
}

function fromFact(
  fact: NormalizedFinancialFact | undefined,
  options: { value?: number; unit?: string; definitionVersion?: string | null } = {},
): ShareholderReturnValue {
  if (!fact) return unavailable('該当する実績factがありません。')
  return available(options.value ?? fact.value, options.unit ?? fact.unit, {
    periodEnd: fact.periodEnd,
    publishedAt: fact.publishedAt,
    definitionVersion: options.definitionVersion ?? fact.definitionVersion,
    inputIds: fact.inputFactIds.length > 0 ? fact.inputFactIds : [fact.factId],
  })
}

function fromForecast(snapshot: FinancialForecastSnapshot | undefined): ShareholderReturnValue {
  if (!snapshot) return unavailable('指定日時点で利用できる会社予想DPSがありません。')
  return available(snapshot.value, snapshot.unit, {
    periodEnd: snapshot.targetPeriodEnd,
    publishedAt: snapshot.publishedAt,
    inputIds: [snapshot.snapshotId],
  })
}

function fromMetric(
  metric: CalculatedFinancialMetric | undefined,
  missingReason: string,
  availability: Exclude<ShareholderReturnAvailability, 'available'> = 'missing',
): ShareholderReturnValue {
  if (!metric) return unavailable(missingReason, availability)
  return available(metric.value, metric.unit, {
    periodEnd: metric.periodEnd,
    definitionVersion: metric.definitionVersion,
    inputIds: metric.inputFactIds,
  })
}

function correctionRank(status: string): number {
  if (status === 'restated') return 2
  if (status === 'corrected') return 1
  return 0
}

function latestPreferredFact(candidates: NormalizedFinancialFact[]): NormalizedFinancialFact | undefined {
  if (candidates.length === 0) return undefined
  const consolidated = candidates.filter((fact) => fact.consolidationScope === 'consolidated')
  return [...(consolidated.length > 0 ? consolidated : candidates)].sort((left, right) => (
    right.publishedAt.localeCompare(left.publishedAt)
    || correctionRank(right.correctionStatus) - correctionRank(left.correctionStatus)
    || right.factId.localeCompare(left.factId)
  ))[0]
}

function annualFacts(facts: NormalizedFinancialFact[]): AnnualFacts[] {
  const years = [...new Set(facts
    .filter((fact) => fact.targetFiscalYear != null && fact.periodKind === 'FY')
    .map((fact) => fact.targetFiscalYear!))]
    .sort((a, b) => a - b)
  return years.map((fiscalYear) => {
    const sameYear = facts.filter((fact) => fact.targetFiscalYear === fiscalYear && fact.periodKind === 'FY')
    const pick = (metric: string, accumulationKind?: string) => latestPreferredFact(sameYear.filter((fact) => (
      fact.metric === metric && (!accumulationKind || fact.accumulationKind === accumulationKind)
    )))
    const dps = pick('dividend_per_share_annual', 'FY')
    const eps = pick('eps_basic', 'FY')
    const payoutRatio = pick('payout_ratio', 'FY')
    const issuedShares = pick('shares_outstanding', 'INSTANT')
    const treasuryShares = pick('treasury_shares', 'INSTANT')
    const periodEnd = dps?.periodEnd
      ?? eps?.periodEnd
      ?? issuedShares?.periodEnd
      ?? sameYear.map((fact) => fact.periodEnd).sort().at(-1)
      ?? `${fiscalYear}-12-31`
    return { fiscalYear, periodEnd, dps, eps, payoutRatio, issuedShares, treasuryShares }
  })
}

function factorDistance(value: number, target: number): number {
  return Math.abs(Math.log(value / target))
}

function nearestKnownFactor(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  const factor = KNOWN_SHARE_FACTORS.reduce((best, candidate) => (
    factorDistance(value, candidate) < factorDistance(value, best) ? candidate : best
  ))
  return factorDistance(value, factor) <= Math.log(1.03) ? factor : null
}

function detectSplitAdjustments(rows: AnnualFacts[]): DividendSplitAdjustment[] {
  const shareRows = rows.filter((row) => row.issuedShares && row.treasuryShares)
  const adjustments: DividendSplitAdjustment[] = []
  for (let index = 1; index < shareRows.length; index += 1) {
    const previous = shareRows[index - 1]
    const current = shareRows[index]
    if (current.fiscalYear !== previous.fiscalYear + 1) continue
    const previousIssued = previous.issuedShares!.value
    const currentIssued = current.issuedShares!.value
    const previousNet = previousIssued - previous.treasuryShares!.value
    const currentNet = currentIssued - current.treasuryShares!.value
    if (previousIssued <= 0 || currentIssued <= 0 || previousNet <= 0 || currentNet <= 0) continue
    const factor = nearestKnownFactor(currentIssued / previousIssued)
    if (!factor || factor === 1 || factorDistance(currentNet / previousNet, factor) > Math.log(1.06)) continue
    adjustments.push({
      fromFiscalYear: previous.fiscalYear,
      toFiscalYear: current.fiscalYear,
      factor,
      evidence: `発行済株式数 ${previousIssued.toLocaleString('ja-JP')}→${currentIssued.toLocaleString('ja-JP')}、自己株控除後株式数も${factor}倍近傍`,
    })
  }
  return adjustments
}

function adjustmentFactorForYear(fiscalYear: number, adjustments: DividendSplitAdjustment[]): number {
  return adjustments
    .filter((adjustment) => adjustment.fromFiscalYear >= fiscalYear)
    .reduce((product, adjustment) => product * adjustment.factor, 1)
}

function latestPriceOnOrBefore(prices: PriceRow[], date: string): PriceRow | undefined {
  let low = 0
  let high = prices.length - 1
  let match: PriceRow | undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const row = prices[middle]
    if (row.date <= date) {
      match = row
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return match
}

function completedFiscalYear(facts: NormalizedFinancialFact[]): number | null {
  const years = facts
    .filter((fact) => fact.accumulationKind === 'FY' && fact.targetFiscalYear != null)
    .map((fact) => fact.targetFiscalYear!)
  return years.length > 0 ? Math.max(...years) : null
}

function nearestForecast(
  forecasts: FinancialForecastSnapshot[],
  metric: string,
  completedYear: number | null,
): FinancialForecastSnapshot | undefined {
  const candidates = forecasts.filter((snapshot) => (
    snapshot.metric === metric
    && snapshot.forecastPeriod === 'FY'
    && (completedYear == null || snapshot.targetFiscalYear > completedYear)
  ))
  const year = candidates.map((snapshot) => snapshot.targetFiscalYear).sort((a, b) => a - b)[0]
  if (year == null) return undefined
  const target = candidates.filter((snapshot) => snapshot.targetFiscalYear === year)
  const consolidated = target.filter((snapshot) => snapshot.consolidationScope === 'consolidated')
  return [...(consolidated.length > 0 ? consolidated : target)]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.snapshotId.localeCompare(a.snapshotId))[0]
}

function directionFor(current: number | null, previous: number | null): DividendDirection {
  if (current == null) return 'unknown'
  if (current === 0) return 'no_dividend'
  if (previous == null) return 'unknown'
  if (previous === 0 && current > 0) return 'resumed'
  const tolerance = Math.max(Math.abs(previous), Math.abs(current), 1) * 1e-8
  if (current > previous + tolerance) return 'increase'
  if (current < previous - tolerance) return 'decrease'
  return 'unchanged'
}

function countConsecutive(rows: DividendHistoryRow[], allowUnchanged: boolean): ShareholderReturnValue {
  const actual = rows.filter((row) => row.actualDps.availability === 'available').sort((a, b) => a.fiscalYear - b.fiscalYear)
  const latest = actual.at(-1)
  if (!latest) return unavailable('実績DPS履歴がありません。')
  let count = 0
  let current = latest
  for (let index = actual.length - 2; index >= 0; index -= 1) {
    const previous = actual[index]
    if (previous.fiscalYear !== current.fiscalYear - 1) break
    const currentValue = current.actualDps.value!
    const previousValue = previous.actualDps.value!
    const passes = allowUnchanged ? currentValue >= previousValue : currentValue > previousValue
    if (!passes) break
    count += 1
    current = previous
  }
  return available(count, 'YEARS', {
    periodEnd: latest.periodEnd,
    definitionVersion: allowUnchanged ? 'dps-consecutive-nondecrease-split-adjusted-v1' : 'dps-consecutive-increase-split-adjusted-v1',
    inputIds: actual.slice(Math.max(0, actual.length - count - 1)).flatMap((row) => row.actualDps.inputIds),
  })
}

function cutsLastFiveYears(rows: DividendHistoryRow[]): ShareholderReturnValue {
  const actual = rows.filter((row) => row.actualDps.availability === 'available').sort((a, b) => a.fiscalYear - b.fiscalYear)
  const latest = actual.at(-1)
  if (!latest) return unavailable('実績DPS履歴がありません。')
  const fromYear = latest.fiscalYear - 5
  const windowRows = actual.filter((row) => row.fiscalYear >= fromYear)
  let cuts = 0
  let comparisons = 0
  for (let index = 1; index < windowRows.length; index += 1) {
    const previous = windowRows[index - 1]
    const current = windowRows[index]
    if (current.fiscalYear !== previous.fiscalYear + 1) continue
    comparisons += 1
    if (current.actualDps.value! < previous.actualDps.value!) cuts += 1
  }
  if (comparisons === 0) return unavailable('過去5年内に連続年度で比較できるDPSがありません。')
  return available(cuts, 'COUNT', {
    periodEnd: latest.periodEnd,
    definitionVersion: 'dps-cuts-last-5y-split-adjusted-v1',
    inputIds: windowRows.flatMap((row) => row.actualDps.inputIds),
  })
}

function dpsCagr(rows: DividendHistoryRow[], years: 3 | 5): ShareholderReturnValue {
  const actual = rows.filter((row) => row.actualDps.availability === 'available')
  const latest = [...actual].sort((a, b) => a.fiscalYear - b.fiscalYear).at(-1)
  const base = latest ? actual.find((row) => row.fiscalYear === latest.fiscalYear - years) : undefined
  if (!latest || !base) return unavailable(`${years}年前と最新FYの実績DPSが揃っていません。`)
  if (latest.actualDps.value! <= 0 || base.actualDps.value! <= 0) {
    return unavailable('起点または終点が無配のためCAGRはN/Mです。', 'not_meaningful')
  }
  return available((Math.pow(latest.actualDps.value! / base.actualDps.value!, 1 / years) - 1) * 100, 'PERCENT', {
    periodEnd: latest.periodEnd,
    definitionVersion: `dps-cagr-${years}y-split-adjusted-v1`,
    inputIds: [...base.actualDps.inputIds, ...latest.actualDps.inputIds],
  })
}

function likelyBasisChange(previous: number, current: number, splitFactors: number[]): boolean {
  if (previous <= 0 || current <= 0 || splitFactors.length === 0) return false
  const ratio = current / previous
  return splitFactors.some((factor) => (
    factorDistance(ratio, factor) <= Math.log(1.03)
    || factorDistance(ratio, 1 / factor) <= Math.log(1.03)
  ))
}

function forecastRevisions(
  snapshots: FinancialForecastSnapshot[],
  adjustments: DividendSplitAdjustment[],
): DividendForecastRevision[] {
  const dividends = snapshots.filter((snapshot) => (
    snapshot.metric === 'dividend_per_share_annual' && snapshot.forecastPeriod === 'FY'
  ))
  const preferred = dividends.filter((snapshot) => {
    const target = dividends.filter((candidate) => candidate.targetFiscalYear === snapshot.targetFiscalYear)
    return !target.some((candidate) => candidate.consolidationScope === 'consolidated')
      || snapshot.consolidationScope === 'consolidated'
  }).sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.snapshotId.localeCompare(b.snapshotId))
  const previousByTarget = new Map<string, FinancialForecastSnapshot>()
  const rows: DividendForecastRevision[] = []
  for (const snapshot of preferred) {
    const groupKey = [snapshot.targetFiscalYear, snapshot.consolidationScope, snapshot.accountingStandard].join('|')
    const previous = previousByTarget.get(groupKey)
    const basisChange = previous
      ? likelyBasisChange(previous.value, snapshot.value, adjustments.map((adjustment) => adjustment.factor))
      : false
    const changeAmount = previous && !basisChange ? snapshot.value - previous.value : null
    const changePercent = previous && !basisChange && previous.value !== 0
      ? ((snapshot.value - previous.value) / Math.abs(previous.value)) * 100
      : null
    let direction: ForecastRevisionDirection = 'initial'
    if (previous && basisChange) direction = 'basis_change'
    else if (changeAmount != null && Math.abs(changeAmount) <= 1e-9) direction = 'unchanged'
    else if (changeAmount != null && changeAmount > 0) direction = 'increase'
    else if (changeAmount != null && changeAmount < 0) direction = 'decrease'
    rows.push({
      key: snapshot.snapshotId,
      publishedAt: snapshot.publishedAt,
      targetFiscalYear: snapshot.targetFiscalYear,
      forecastScope: snapshot.forecastScope,
      consolidationScope: snapshot.consolidationScope,
      accountingStandard: snapshot.accountingStandard,
      value: snapshot.value,
      previousValue: previous?.value ?? null,
      changeAmount,
      changePercent,
      direction,
      disclosureId: snapshot.disclosureId,
      snapshotId: snapshot.snapshotId,
      previousSnapshotId: previous?.snapshotId ?? null,
    })
    previousByTarget.set(groupKey, snapshot)
  }
  return rows.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.key.localeCompare(a.key))
}

function shareCountHistory(rows: AnnualFacts[], adjustments: DividendSplitAdjustment[]): ShareCountHistoryRow[] {
  const output = rows.filter((row) => row.issuedShares && row.treasuryShares).map((row) => {
    const issuedShares = row.issuedShares!.value
    const treasuryShares = row.treasuryShares!.value
    const netShares = issuedShares - treasuryShares
    const splitAdjustmentFactor = adjustmentFactorForYear(row.fiscalYear, adjustments)
    return {
      fiscalYear: row.fiscalYear,
      periodEnd: row.periodEnd,
      issuedShares,
      treasuryShares,
      netShares,
      splitAdjustedNetShares: netShares * splitAdjustmentFactor,
      netShareChangePercent: null,
      splitAdjustmentFactor,
      inputIds: [row.issuedShares!.factId, row.treasuryShares!.factId],
    }
  }).filter((row) => row.netShares > 0)
  return output.map((row, index) => {
    const previous = output[index - 1]
    const comparable = previous && row.fiscalYear === previous.fiscalYear + 1 && previous.splitAdjustedNetShares > 0
    return {
      ...row,
      netShareChangePercent: comparable
        ? ((row.splitAdjustedNetShares / previous.splitAdjustedNetShares) - 1) * 100
        : null,
    }
  })
}

function buildHistory(
  annual: AnnualFacts[],
  forecasts: FinancialForecastSnapshot[],
  prices: PriceRow[],
  adjustments: DividendSplitAdjustment[],
): DividendHistoryRow[] {
  const actualRows: DividendHistoryRow[] = annual
    .filter((row) => row.dps || row.eps || row.payoutRatio)
    .map((row) => {
      const factor = adjustmentFactorForYear(row.fiscalYear, adjustments)
      const adjustedDps = row.dps ? row.dps.value / factor : null
      const adjustedEps = row.eps ? row.eps.value / factor : null
      const periodPrice = latestPriceOnOrBefore(prices, row.periodEnd)
      const dividendYield = adjustedDps != null && periodPrice?.close && periodPrice.close > 0
        ? available((adjustedDps / periodPrice.close) * 100, 'PERCENT', {
          periodEnd: periodPrice.date,
          publishedAt: row.dps?.publishedAt,
          definitionVersion: 'historical-dividend-yield-fy-end-adjusted-v1',
          inputIds: [row.dps!.factId, `price:JP:${row.dps!.ticker}:${periodPrice.date}`],
        })
        : unavailable('実績DPSまたは期末以前の株価がありません。')
      return {
        key: `actual:${row.fiscalYear}`,
        fiscalYear: row.fiscalYear,
        periodEnd: row.periodEnd,
        publishedAt: row.dps?.publishedAt ?? row.eps?.publishedAt ?? row.payoutRatio?.publishedAt ?? '',
        actualDps: row.dps
          ? fromFact(row.dps, { value: adjustedDps!, definitionVersion: 'dps-latest-share-basis-v1' })
          : unavailable('実績DPSがありません。'),
        rawActualDps: row.dps?.value ?? null,
        forecastDps: unavailable('実績年度です。'),
        forecastScope: null,
        eps: row.eps
          ? fromFact(row.eps, { value: adjustedEps!, definitionVersion: 'eps-latest-share-basis-v1' })
          : unavailable('実績EPSがありません。'),
        payoutRatio: row.payoutRatio
          ? fromFact(row.payoutRatio, { value: row.payoutRatio.value * 100, unit: 'PERCENT' })
          : unavailable('実績配当性向がありません。'),
        dividendYield,
        direction: 'unknown' as DividendDirection,
        splitAdjustmentFactor: factor,
      }
    })
  for (let index = 0; index < actualRows.length; index += 1) {
    const current = actualRows[index]
    const previous = actualRows[index - 1]
    current.direction = previous && previous.fiscalYear === current.fiscalYear - 1
      ? directionFor(current.actualDps.value, previous.actualDps.value)
      : directionFor(current.actualDps.value, null)
  }

  const latestActualYear = actualRows.filter((row) => row.actualDps.availability === 'available')
    .map((row) => row.fiscalYear).sort((a, b) => b - a)[0] ?? null
  const forecastRows = forecasts
    .filter((snapshot) => (
      snapshot.metric === 'dividend_per_share_annual'
      && snapshot.forecastPeriod === 'FY'
      && (latestActualYear == null || snapshot.targetFiscalYear > latestActualYear)
    ))
  const years = [...new Set(forecastRows.map((snapshot) => snapshot.targetFiscalYear))].sort((a, b) => a - b)
  const futureRows = years.map((fiscalYear): DividendHistoryRow => {
    const candidates = forecastRows.filter((snapshot) => snapshot.targetFiscalYear === fiscalYear)
    const consolidated = candidates.filter((snapshot) => snapshot.consolidationScope === 'consolidated')
    const snapshot = [...(consolidated.length > 0 ? consolidated : candidates)]
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.snapshotId.localeCompare(a.snapshotId))[0]
    return {
      key: `forecast:${snapshot.snapshotId}`,
      fiscalYear,
      periodEnd: snapshot.targetPeriodEnd,
      publishedAt: snapshot.publishedAt,
      actualDps: unavailable('会社予想年度です。'),
      rawActualDps: null,
      forecastDps: fromForecast(snapshot),
      forecastScope: snapshot.forecastScope,
      eps: unavailable('会社予想DPS行では実績EPSを表示しません。'),
      payoutRatio: unavailable('会社予想DPS行では実績配当性向を表示しません。'),
      dividendYield: unavailable('現在の予想配当利回りは上部に表示します。'),
      direction: 'unknown',
      splitAdjustmentFactor: 1,
    }
  })
  return [...actualRows, ...futureRows].sort((a, b) => a.fiscalYear - b.fiscalYear || a.key.localeCompare(b.key))
}

function metricMap(metrics: CalculatedFinancialMetric[]): Map<FinancialMetricKey, CalculatedFinancialMetric> {
  return new Map(metrics.map((metric) => [metric.metric, metric]))
}

async function buildReadModel(ticker: string, requestedAsOf?: string | null): Promise<ShareholderReturnsReadModel> {
  const latestPrice = requestedAsOf ? null : await execGet<PriceRow>(`
    SELECT date, close FROM ohlcv_daily WHERE ticker = ? ORDER BY date DESC LIMIT 1
  `, [ticker])
  const asOf = (requestedAsOf ?? latestPrice?.date ?? new Date().toISOString().slice(0, 10)).slice(0, 10)
  const cutoff = normalizeAsOf(asOf)
  const [profile, prices, facts, allForecasts, detailedFacts] = await Promise.all([
    execGet<TickerProfile>(`
      SELECT name, sector17_name, sector33_name FROM ticker_universe WHERE ticker = ?
    `, [ticker]),
    execAll<PriceRow>(`
      SELECT date, close FROM ohlcv_daily
      WHERE ticker = ? AND date <= ? ORDER BY date
    `, [ticker, asOf]),
    loadNormalizedFinancialFactsForTickers([ticker], { asOf }),
    loadFinancialForecastSnapshotsForTickers([ticker], { asOf }),
    loadDetailedFinancialFacts(ticker, asOf),
  ])
  const price = prices.at(-1)
  const isFinancialSector = FINANCIAL_SECTOR_PATTERN.test(`${profile?.sector17_name ?? ''} ${profile?.sector33_name ?? ''}`)
  const forecasts = selectForecastsAsOf(allForecasts, asOf)
  const baseMetrics = calculateFinancialMetrics({
    ticker,
    asOf,
    facts,
    forecasts,
    price: price ? { value: Number(price.close), date: price.date, inputId: `price:JP:${ticker}:${price.date}` } : null,
    isFinancialSector,
    inputsPreparedForAsOf: true,
  })
  const advancedMetrics = calculateAdvancedFinancialMetrics({
    ticker,
    asOf,
    facts,
    forecasts,
    detailedFacts,
    price: price ? { value: Number(price.close), date: price.date, inputId: `price:JP:${ticker}:${price.date}` } : null,
    isFinancialSector,
    inputsPreparedForAsOf: true,
  })
  const metrics = metricMap([...baseMetrics, ...advancedMetrics])
  const annual = annualFacts(facts)
  const adjustments = detectSplitAdjustments(annual)
  const historyRows = buildHistory(annual, forecasts, prices, adjustments)
  const currentForecast = nearestForecast(forecasts, 'dividend_per_share_annual', completedFiscalYear(facts))
  const actualRows = historyRows.filter((row) => row.actualDps.availability === 'available')
  const latestActualRow = actualRows.at(-1)
  const previousActualRow = latestActualRow
    ? actualRows.find((row) => row.fiscalYear === latestActualRow.fiscalYear - 1)
    : undefined
  const dpsYoY = latestActualRow && previousActualRow && previousActualRow.actualDps.value! > 0
    ? available(((latestActualRow.actualDps.value! / previousActualRow.actualDps.value!) - 1) * 100, 'PERCENT', {
      periodEnd: latestActualRow.periodEnd,
      publishedAt: latestActualRow.publishedAt,
      definitionVersion: 'dps-yoy-split-adjusted-v1',
      inputIds: [...previousActualRow.actualDps.inputIds, ...latestActualRow.actualDps.inputIds],
    })
    : unavailable('連続する2期の正の実績DPSが揃っていません。')

  const latestAnnual = latestActualRow
    ? annual.find((row) => row.fiscalYear === latestActualRow.fiscalYear)
    : undefined
  const issued = latestAnnual?.issuedShares
  const treasury = latestAnnual?.treasuryShares
  const netShares = issued && treasury ? issued.value - treasury.value : null
  const annualDividendTotal = latestAnnual?.dps && netShares != null && netShares > 0
    ? available(latestAnnual.dps.value * netShares, 'JPY', {
      periodEnd: latestAnnual.periodEnd,
      publishedAt: latestAnnual.dps.publishedAt,
      definitionVersion: 'annual-dividend-total-dps-times-period-end-net-shares-v1',
      inputIds: [latestAnnual.dps.factId, issued!.factId, treasury!.factId],
    })
    : unavailable('実績DPS、発行済株式数、自己株式数のいずれかがありません。')
  const standardFcf = isFinancialSector
    ? unavailable('金融業では通常企業用の標準FCFを適用しません。', 'not_applicable')
    : fromMetric(metrics.get('standard_fcf'), '標準FCFの入力が揃っていません。')
  const fcfYield = isFinancialSector
    ? unavailable('金融業では通常企業用のFCF Yieldを適用しません。', 'not_applicable')
    : fromMetric(metrics.get('fcf_yield'), '標準FCFまたは時価総額の入力が揃っていません。')
  const fcfCoverage = standardFcf.value != null && annualDividendTotal.value != null && annualDividendTotal.value > 0
    ? available(standardFcf.value / annualDividendTotal.value, 'MULTIPLE', {
      periodEnd: standardFcf.periodEnd,
      definitionVersion: 'standard-fcf-dividend-coverage-v1',
      inputIds: [...standardFcf.inputIds, ...annualDividendTotal.inputIds],
    })
    : isFinancialSector
      ? unavailable('金融業では通常企業用の標準FCF比較を適用しません。', 'not_applicable')
      : unavailable('標準FCFまたは概算年間配当総額がありません。')
  const payoutRatio = latestActualRow?.payoutRatio.availability === 'available'
    ? latestActualRow.payoutRatio
    : latestActualRow?.eps.value != null && latestActualRow.eps.value <= 0
      ? unavailable('直近FYのEPSが正数ではないため配当性向はN/Mです。', 'not_meaningful')
      : unavailable('直近実績DPSと同じ年度の配当性向がありません。')
  const forecastDividendYield = fromMetric(metrics.get('dividend_yield'), '指定日時点の予想DPSまたは株価がありません。')
  const revisions = forecastRevisions(
    allForecasts.filter((snapshot) => snapshot.publishedAt <= cutoff),
    adjustments,
  )
  const shareHistory = shareCountHistory(annual, adjustments)
  const sustainabilityFacts: string[] = []
  const latestEps = latestActualRow?.eps.value
  if (latestEps != null && latestEps < 0) sustainabilityFacts.push('直近実績EPSは赤字です。')
  if (standardFcf.value != null && standardFcf.value < 0) sustainabilityFacts.push('直近LTMの標準FCFは負です。')
  if (standardFcf.availability === 'missing') sustainabilityFacts.push('標準FCFの計算入力が不足しています。')
  if (currentForecast == null) sustainabilityFacts.push('指定日時点で会社予想DPSは確認できません。')
  if (sustainabilityFacts.length === 0) sustainabilityFacts.push('赤字・負のFCF・主要入力不足は検出されていません。')
  const unavailableBuyback = unavailable('自己株式取得額を示す構造化データが現DBにありません。')
  const unavailableTotalReturn = unavailable('自社株買い金額がないため総還元を推測しません。')

  return {
    contractVersion: 'shareholder-returns-v1',
    ticker,
    asOf,
    priceDate: price?.date ?? null,
    isFinancialSector,
    current: {
      forecastDps: fromForecast(currentForecast),
      forecastDividendYield,
      payoutRatio,
      actualDps: latestActualRow?.actualDps ?? unavailable('実績DPSがありません。'),
      dpsYoY,
      fcfYield,
    },
    history: {
      rows: historyRows,
      adjustments,
      adjustmentMethod: '発行済株式数と自己株控除後株式数が既知の分割・併合比率に一致した境界だけを採用し、過去DPS/EPSを最新株式単位へ換算。判定不能な変化は補正しません。',
    },
    direction: {
      consecutiveIncreaseYears: countConsecutive(historyRows, false),
      consecutiveNonDecreaseYears: countConsecutive(historyRows, true),
      cutsLast5Years: cutsLastFiveYears(historyRows),
      dpsCagr3y: dpsCagr(historyRows, 3),
      dpsCagr5y: dpsCagr(historyRows, 5),
    },
    forecastRevisions: revisions,
    sustainability: {
      payoutRatio,
      annualDividendTotal,
      standardFcf,
      fcfYield,
      fcfDividendCoverage: fcfCoverage,
      facts: sustainabilityFacts,
    },
    buybacks: {
      availability: shareHistory.length > 0 ? 'share_counts_only' : 'unavailable',
      reason: shareHistory.length > 0
        ? '発行済株式数・自己株式数の期末推移は取得できますが、自己株式取得額・消却額は構造化保存されていません。株式数減少を自社株買い金額へ換算しません。'
        : '自己株式取得額と比較可能な株式数履歴がありません。',
      annualBuybackAmount: unavailableBuyback,
      marketCapRatio: unavailableBuyback,
      shareCountHistory: shareHistory,
    },
    totalReturns: {
      availability: 'unavailable',
      reason: '自己株式取得額の履歴が不完全なため、総還元額・総還元性向・総還元利回りは算定しません。',
      totalPayout: unavailableTotalReturn,
      totalPayoutRatio: unavailableTotalReturn,
      totalPayoutYield: unavailableTotalReturn,
    },
    definitions: {
      dividendYield: METRIC_DEFINITION_REGISTRY.dividend_yield,
      payoutRatio: METRIC_DEFINITION_REGISTRY.payout_ratio,
      standardFcf: METRIC_DEFINITION_REGISTRY.standard_fcf,
      fcfYield: METRIC_DEFINITION_REGISTRY.fcf_yield,
      dpsCagr: {
        formula: '(latest split-adjusted DPS / split-adjusted DPS N years earlier)^(1/N) - 1',
        version: 'dps-cagr-split-adjusted-v1',
      },
      annualDividendTotal: {
        formula: 'Reported annual DPS × (period-end issued shares - period-end treasury shares)',
        version: 'annual-dividend-total-dps-times-period-end-net-shares-v1',
      },
    },
    coverage: {
      facts: facts.length,
      actualDividendYears: actualRows.length,
      forecastSnapshots: allForecasts.length,
      forecastRevisionRows: revisions.length,
      payoutRatioYears: historyRows.filter((row) => row.payoutRatio.availability === 'available').length,
      shareCountYears: shareHistory.length,
      splitAdjustments: adjustments.length,
      buybackAmountAvailable: false,
    },
  }
}

export async function getShareholderReturnsReadModel(
  ticker: string,
  requestedAsOf?: string | null,
): Promise<ShareholderReturnsReadModel> {
  const normalizedTicker = ticker.replace(/\.T$/i, '')
  const cacheKey = `${normalizedTicker}:${requestedAsOf?.slice(0, 10) ?? 'latest'}`
  const cached = modelCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const value = await buildReadModel(normalizedTicker, requestedAsOf)
  modelCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value })
  return value
}
