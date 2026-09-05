import { createHash } from 'node:crypto'
import { client, ensureReady, execAll, execGet } from '@/lib/db/client'
import type { DetailedFinancialFact } from '@/lib/detailed-financial-foundation'
import {
  normalizeAsOf,
  selectForecastsAsOf,
  type FinancialForecastSnapshot,
  type NormalizedFinancialFact,
} from '@/lib/financial-foundation'
import {
  calculateAdvancedFinancialMetrics,
  calculateFinancialMetrics,
  evaluateEvEbitda,
  METRIC_DEFINITION_REGISTRY,
  type CalculatedFinancialMetric,
  type FinancialMetricKey,
} from '@/lib/financial-metrics'
import { loadDetailedFinancialFactsForTickers } from '@/lib/server/detailed-financial-foundation-store'
import {
  loadFinancialForecastSnapshotsForTickers,
  loadNormalizedFinancialFactsForTickers,
} from '@/lib/server/financial-foundation-store'

const WRITE_CHUNK = Math.max(50, Number(process.env.VALUATION_SERVING_WRITE_CHUNK ?? 400))
const PRICE_BASIS_METRICS = new Set<FinancialMetricKey>([
  'per', 'forward_per', 'pbr', 'psr', 'enterprise_value', 'ev_ebitda',
])
const INVERSE_PRICE_METRICS = new Set<FinancialMetricKey>(['dividend_yield', 'fcf_yield'])
const PEER_LTM_FACT_METRICS = new Set([
  'net_income_attributable', 'weighted_average_shares', 'revenue', 'operating_profit', 'operating_cash_flow',
])
const PEER_INSTANT_FACT_METRICS = new Set([
  'equity_attributable', 'bps', 'shares_outstanding', 'treasury_shares',
])
const PEER_DETAIL_METRICS = new Set([
  'cash_and_cash_equivalents', 'interest_bearing_debt', 'non_controlling_interests',
  'depreciation_amortization', 'capex',
])

export const VALUATION_SERVING_METRICS = [
  'per',
  'forward_per',
  'pbr',
  'psr',
  'fcf_yield',
  'ev_ebitda',
  'net_debt',
  'dividend_yield',
  'roe',
  'revenue_growth',
  'enterprise_value',
  'ebitda',
] as const satisfies readonly FinancialMetricKey[]

export type ValuationServingMetric = typeof VALUATION_SERVING_METRICS[number]

type TransformKind = 'constant' | 'linear_price' | 'inverse_price'

export interface ValuationMetricTransform {
  kind: TransformKind
  usesPrice: boolean
  priceInputIndex: number | null
  coefficient: number
  intercept: number
  unit: string
  periodEnd: string | null
  inputFactIds: string[]
  forecastSnapshotId: string | null
  definitionVersion: string
}

export interface ValuationMetricBasis {
  basisId: string
  ticker: string
  effectiveDate: string
  transforms: Partial<Record<ValuationServingMetric, ValuationMetricTransform>>
  peerTransforms: Partial<Record<ValuationServingMetric, ValuationMetricTransform>>
  inputFactIds: string[]
  definitionVersions: Partial<Record<ValuationServingMetric, string>>
  forecastSnapshotId: string | null
}

export interface ValuationServingRow {
  ticker: string
  valuationDate: string
  priceDate: string
  price: number
  isTradingDay: boolean
  per: number | null
  forwardPer: number | null
  pbr: number | null
  psr: number | null
  fcfYield: number | null
  evEbitda: number | null
  netDebt: number | null
  dividendYield: number | null
  roe: number | null
  revenueGrowth: number | null
  enterpriseValue: number | null
  ebitda: number | null
  peerForwardPer: number | null
  peerPbr: number | null
  peerFcfYield: number | null
  peerRoe: number | null
  peerRevenueGrowth: number | null
  peerEvEbitda: number | null
  basisId: string
  forecastSnapshotId: string | null
}

type PriceRow = { ticker: string; date: string; close: number }
type ProfileRow = { sector17Name: string | null; sector33Name: string | null }

interface CheckpointRow {
  ticker: string
  status: string
  historyStartDate: string | null
  latestValuationDate: string | null
  latestPriceDate: string | null
  sourceImportedAt: number
  sourceRowCount: number
  definitionSignature: string
  persistedRows: number
}

interface SourceState {
  importedAt: number
  rowCount: number
  latestPublishedDate: string | null
}

export interface ValuationServingBuildResult {
  ticker: string
  status: 'completed' | 'skipped' | 'no_price'
  historyStartDate: string | null
  recomputeStartDate: string | null
  latestValuationDate: string | null
  latestPriceDate: string | null
  rows: number
  bases: number
  elapsedMs: number
}

function asNumber(value: unknown): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function subtractYears(date: string, years: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCFullYear(value.getUTCFullYear() - years)
  return value.toISOString().slice(0, 10)
}

function publishedDateJst(publishedAt: string): string {
  const timestamp = Date.parse(publishedAt)
  if (!Number.isFinite(timestamp)) return publishedAt.slice(0, 10)
  return new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function financialSector(profile: ProfileRow | undefined): boolean {
  return /銀行|保険|証券|金融/.test(`${profile?.sector17Name ?? ''} ${profile?.sector33Name ?? ''}`)
}

function definitionSignature(): string {
  return createHash('sha256')
    .update(`valuation-serving-v2|${VALUATION_SERVING_METRICS.map((metric) => `${metric}:${METRIC_DEFINITION_REGISTRY[metric].version}`).join('|')}`)
    .digest('hex')
}

export const VALUATION_SERVING_DEFINITION_SIGNATURE = definitionSignature()

function mapMetrics(metrics: CalculatedFinancialMetric[]): Map<FinancialMetricKey, CalculatedFinancialMetric> {
  return new Map(metrics.map((metric) => [metric.metric, metric]))
}

function calculateAtBasisPrice(
  ticker: string,
  date: string,
  price: number,
  facts: NormalizedFinancialFact[],
  forecasts: FinancialForecastSnapshot[],
  detailedFacts: DetailedFinancialFact[],
  isFinancialSector: boolean,
): Map<FinancialMetricKey, CalculatedFinancialMetric> {
  const context = {
    ticker,
    asOf: date,
    facts,
    forecasts,
    price: { value: price, date, inputId: 'price:valuation-serving-basis' },
    isFinancialSector,
    inputsPreparedForAsOf: true,
  }
  return mapMetrics([
    ...calculateFinancialMetrics(context),
    ...calculateAdvancedFinancialMetrics({ ...context, detailedFacts }),
  ])
}

function buildBasis(
  ticker: string,
  date: string,
  facts: NormalizedFinancialFact[],
  forecasts: FinancialForecastSnapshot[],
  detailedFacts: DetailedFinancialFact[],
  isFinancialSector: boolean,
): ValuationMetricBasis {
  const atOne = calculateAtBasisPrice(ticker, date, 1, facts, forecasts, detailedFacts, isFinancialSector)
  const atTwo = calculateAtBasisPrice(ticker, date, 2, facts, forecasts, detailedFacts, isFinancialSector)
  const peerPeriodStart = subtractYears(date, 3)
  const peerFacts = facts.filter((fact) => (
    fact.periodEnd >= peerPeriodStart
    && (
      (fact.source === 'calculated' && fact.accumulationKind === 'LTM' && PEER_LTM_FACT_METRICS.has(fact.metric))
      || (fact.source === 'jquants' && fact.accumulationKind === 'INSTANT' && PEER_INSTANT_FACT_METRICS.has(fact.metric))
    )
  ))
  const peerDetails = detailedFacts.filter((fact) => PEER_DETAIL_METRICS.has(fact.metric))
  const peerAtOne = calculateAtBasisPrice(ticker, date, 1, peerFacts, forecasts, peerDetails, isFinancialSector)
  const peerAtTwo = calculateAtBasisPrice(ticker, date, 2, peerFacts, forecasts, peerDetails, isFinancialSector)
  const snapshotIds = new Set(forecasts.map((snapshot) => snapshot.snapshotId))
  const toTransforms = (
    firstMetrics: Map<FinancialMetricKey, CalculatedFinancialMetric>,
    secondMetrics: Map<FinancialMetricKey, CalculatedFinancialMetric>,
  ): Partial<Record<ValuationServingMetric, ValuationMetricTransform>> => {
    const output: Partial<Record<ValuationServingMetric, ValuationMetricTransform>> = {}
    for (const metric of VALUATION_SERVING_METRICS) {
      const first = firstMetrics.get(metric)
      if (!first) continue
      const second = secondMetrics.get(metric)
      let kind: TransformKind = 'constant'
      let coefficient = first.value
      let intercept = 0
      if (PRICE_BASIS_METRICS.has(metric) && second) {
        kind = 'linear_price'
        coefficient = second.value - first.value
        intercept = first.value - coefficient
      } else if (INVERSE_PRICE_METRICS.has(metric)) {
        kind = 'inverse_price'
        coefficient = first.value
      }
      const priceInputIndex = first.inputFactIds.indexOf('price:valuation-serving-basis')
      const inputFactIds = first.inputFactIds.filter((id) => id !== 'price:valuation-serving-basis')
      output[metric] = {
        kind,
        usesPrice: priceInputIndex >= 0,
        priceInputIndex: priceInputIndex >= 0 ? priceInputIndex : null,
        coefficient,
        intercept,
        unit: first.unit,
        periodEnd: first.periodEnd,
        inputFactIds,
        forecastSnapshotId: inputFactIds.find((id) => snapshotIds.has(id)) ?? null,
        definitionVersion: first.definitionVersion,
      }
    }
    const enterpriseValue = output.enterprise_value
    const ebitda = output.ebitda
    if (!output.ev_ebitda && enterpriseValue && ebitda?.kind === 'constant' && ebitda.coefficient > 0) {
      output.ev_ebitda = {
        kind: 'linear_price',
        usesPrice: enterpriseValue.usesPrice,
        priceInputIndex: enterpriseValue.usesPrice ? 0 : null,
        coefficient: enterpriseValue.coefficient / ebitda.coefficient,
        intercept: enterpriseValue.intercept / ebitda.coefficient,
        unit: 'MULTIPLE',
        periodEnd: ebitda.periodEnd,
        inputFactIds: [...new Set([...enterpriseValue.inputFactIds, ...ebitda.inputFactIds])],
        forecastSnapshotId: null,
        definitionVersion: METRIC_DEFINITION_REGISTRY.ev_ebitda.version,
      }
    }
    return output
  }
  const transforms = toTransforms(atOne, atTwo)
  const peerTransforms = toTransforms(peerAtOne, peerAtTwo)
  const serializable = VALUATION_SERVING_METRICS.map((metric) => [
    metric,
    transforms[metric] ?? null,
    peerTransforms[metric] ?? null,
  ])
  const basisId = `valuation-basis:${ticker}:${createHash('sha256').update(JSON.stringify(serializable)).digest('hex')}`
  const inputFactIds = [...new Set(Object.values(transforms).flatMap((transform) => transform?.inputFactIds ?? []))].sort()
  const definitionVersions = Object.fromEntries(Object.entries(transforms).map(([metric, transform]) => [metric, transform!.definitionVersion]))
  return {
    basisId,
    ticker,
    effectiveDate: date,
    transforms,
    peerTransforms,
    inputFactIds,
    definitionVersions,
    forecastSnapshotId: transforms.forward_per?.forecastSnapshotId ?? null,
  }
}

function transformValue(transform: ValuationMetricTransform | undefined, price: number): number | null {
  if (!transform || !Number.isFinite(price) || price <= 0) return null
  if (transform.kind === 'linear_price') return transform.coefficient * price + transform.intercept
  if (transform.kind === 'inverse_price') return transform.coefficient / price
  return transform.coefficient
}

function materializeRow(
  ticker: string,
  valuationDate: string,
  price: PriceRow,
  isTradingDay: boolean,
  basis: ValuationMetricBasis,
): ValuationServingRow {
  const value = (metric: ValuationServingMetric) => transformValue(basis.transforms[metric], Number(price.close))
  const peerValue = (metric: ValuationServingMetric) => transformValue(basis.peerTransforms[metric], Number(price.close))
  const enterpriseValue = value('enterprise_value')
  const ebitda = value('ebitda')
  const peerEnterpriseValue = peerValue('enterprise_value')
  const peerEbitda = peerValue('ebitda')
  return {
    ticker,
    valuationDate,
    priceDate: price.date,
    price: Number(price.close),
    isTradingDay,
    per: value('per'),
    forwardPer: value('forward_per'),
    pbr: value('pbr'),
    psr: value('psr'),
    fcfYield: value('fcf_yield'),
    evEbitda: evaluateEvEbitda(enterpriseValue, ebitda).value,
    netDebt: value('net_debt'),
    dividendYield: value('dividend_yield'),
    roe: value('roe'),
    revenueGrowth: value('revenue_growth'),
    enterpriseValue,
    ebitda,
    peerForwardPer: peerValue('forward_per'),
    peerPbr: peerValue('pbr'),
    peerFcfYield: peerValue('fcf_yield'),
    peerRoe: peerValue('roe'),
    peerRevenueGrowth: peerValue('revenue_growth'),
    peerEvEbitda: evaluateEvEbitda(peerEnterpriseValue, peerEbitda).value,
    basisId: basis.basisId,
    forecastSnapshotId: basis.forecastSnapshotId,
  }
}

function rowFromSql(row: Record<string, unknown>): ValuationServingRow {
  return {
    ticker: String(row.ticker),
    valuationDate: String(row.valuation_date),
    priceDate: String(row.price_date),
    price: Number(row.price),
    isTradingDay: Number(row.is_trading_day) === 1,
    per: asNumber(row.per),
    forwardPer: asNumber(row.forward_per),
    pbr: asNumber(row.pbr),
    psr: asNumber(row.psr),
    fcfYield: asNumber(row.fcf_yield),
    evEbitda: asNumber(row.ev_ebitda),
    netDebt: asNumber(row.net_debt),
    dividendYield: asNumber(row.dividend_yield),
    roe: asNumber(row.roe),
    revenueGrowth: asNumber(row.revenue_growth),
    enterpriseValue: asNumber(row.enterprise_value),
    ebitda: asNumber(row.ebitda),
    peerForwardPer: asNumber(row.peer_forward_per),
    peerPbr: asNumber(row.peer_pbr),
    peerFcfYield: asNumber(row.peer_fcf_yield),
    peerRoe: asNumber(row.peer_roe),
    peerRevenueGrowth: asNumber(row.peer_revenue_growth),
    peerEvEbitda: asNumber(row.peer_ev_ebitda),
    basisId: String(row.basis_id),
    forecastSnapshotId: row.forecast_snapshot_id == null ? null : String(row.forecast_snapshot_id),
  }
}

function basisFromSql(row: Record<string, unknown>): ValuationMetricBasis {
  const payload = JSON.parse(String(row.transforms_json)) as {
    display?: ValuationMetricBasis['transforms']
    peer?: ValuationMetricBasis['peerTransforms']
  } & ValuationMetricBasis['transforms']
  return {
    basisId: String(row.basis_id),
    ticker: String(row.ticker),
    effectiveDate: String(row.effective_date),
    transforms: payload.display ?? payload,
    peerTransforms: payload.peer ?? {},
    inputFactIds: JSON.parse(String(row.input_fact_ids_json)) as string[],
    definitionVersions: JSON.parse(String(row.metric_definition_versions_json)) as ValuationMetricBasis['definitionVersions'],
    forecastSnapshotId: row.forecast_snapshot_id == null ? null : String(row.forecast_snapshot_id),
  }
}

async function sourceState(ticker: string): Promise<SourceState> {
  const row = await execGet<{ importedAt: number | null; rowCount: number; latestPublishedDate: string | null }>(`
    SELECT
      MAX(imported_at) AS importedAt,
      COUNT(*) AS rowCount,
      MAX(substr(published_at, 1, 10)) AS latestPublishedDate
    FROM (
      SELECT imported_at, published_at FROM normalized_financial_facts WHERE ticker = ?
      UNION ALL
      SELECT imported_at, published_at FROM financial_forecast_snapshots WHERE ticker = ?
      UNION ALL
      SELECT imported_at, published_at FROM detailed_financial_facts WHERE ticker = ?
    ) source_rows
  `, [ticker, ticker, ticker])
  return {
    importedAt: Number(row?.importedAt ?? 0),
    rowCount: Number(row?.rowCount ?? 0),
    latestPublishedDate: row?.latestPublishedDate ?? null,
  }
}

async function changedSourceStart(ticker: string, importedAt: number): Promise<string | null> {
  const row = await execGet<{ date: string | null }>(`
    SELECT MIN(substr(published_at, 1, 10)) AS date
    FROM (
      SELECT published_at FROM normalized_financial_facts WHERE ticker = ? AND imported_at >= ?
      UNION ALL
      SELECT published_at FROM financial_forecast_snapshots WHERE ticker = ? AND imported_at >= ?
      UNION ALL
      SELECT published_at FROM detailed_financial_facts WHERE ticker = ? AND imported_at >= ?
    ) changed_rows
  `, [ticker, importedAt, ticker, importedAt, ticker, importedAt])
  return row?.date ?? null
}

async function checkpointFor(ticker: string): Promise<CheckpointRow | undefined> {
  return execGet<CheckpointRow>(`
    SELECT
      ticker,
      status,
      history_start_date AS historyStartDate,
      latest_valuation_date AS latestValuationDate,
      latest_price_date AS latestPriceDate,
      source_imported_at AS sourceImportedAt,
      source_row_count AS sourceRowCount,
      definition_signature AS definitionSignature,
      persisted_rows AS persistedRows
    FROM valuation_serving_checkpoints WHERE ticker = ?
  `, [ticker])
}

async function persistCheckpoint(
  result: ValuationServingBuildResult,
  source: SourceState,
  errorMessage: string | null = null,
): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO valuation_serving_checkpoints (
        ticker, status, history_start_date, latest_valuation_date, latest_price_date,
        source_imported_at, source_row_count, definition_signature, persisted_rows,
        error_message, calculated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      ON CONFLICT(ticker) DO UPDATE SET
        status = excluded.status,
        history_start_date = excluded.history_start_date,
        latest_valuation_date = excluded.latest_valuation_date,
        latest_price_date = excluded.latest_price_date,
        source_imported_at = excluded.source_imported_at,
        source_row_count = excluded.source_row_count,
        definition_signature = excluded.definition_signature,
        persisted_rows = excluded.persisted_rows,
        error_message = excluded.error_message,
        calculated_at = excluded.calculated_at,
        updated_at = excluded.updated_at
    `,
    args: [
      result.ticker,
      errorMessage ? 'failed' : result.status,
      result.historyStartDate,
      result.latestValuationDate,
      result.latestPriceDate,
      source.importedAt,
      source.rowCount,
      VALUATION_SERVING_DEFINITION_SIGNATURE,
      result.rows,
      errorMessage,
    ],
  })
}

async function persistBases(bases: ValuationMetricBasis[], calculatedAt: number): Promise<void> {
  const unique = [...new Map(bases.map((basis) => [basis.basisId, basis])).values()]
  for (let offset = 0; offset < unique.length; offset += WRITE_CHUNK) {
    await client.batch(unique.slice(offset, offset + WRITE_CHUNK).map((basis) => ({
      sql: `
        INSERT INTO valuation_metric_bases (
          basis_id, ticker, effective_date, transforms_json, input_fact_ids_json,
          metric_definition_versions_json, forecast_snapshot_id, calculated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(basis_id) DO UPDATE SET calculated_at = excluded.calculated_at
      `,
      args: [
        basis.basisId,
        basis.ticker,
        basis.effectiveDate,
        JSON.stringify({ display: basis.transforms, peer: basis.peerTransforms }),
        JSON.stringify(basis.inputFactIds),
        JSON.stringify(basis.definitionVersions),
        basis.forecastSnapshotId,
        calculatedAt,
      ],
    })))
  }
}

async function persistRows(rows: ValuationServingRow[], calculatedAt: number): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += WRITE_CHUNK) {
    await client.batch(rows.slice(offset, offset + WRITE_CHUNK).map((row) => ({
      sql: `
        INSERT INTO valuation_daily_serving (
          ticker, valuation_date, price_date, price, is_trading_day,
          per, forward_per, pbr, psr, fcf_yield, ev_ebitda, net_debt,
          dividend_yield, roe, revenue_growth, enterprise_value, ebitda,
          peer_forward_per, peer_pbr, peer_fcf_yield, peer_roe,
          peer_revenue_growth, peer_ev_ebitda,
          basis_id, forecast_snapshot_id, calculated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker, valuation_date) DO UPDATE SET
          price_date = excluded.price_date,
          price = excluded.price,
          is_trading_day = excluded.is_trading_day,
          per = excluded.per,
          forward_per = excluded.forward_per,
          pbr = excluded.pbr,
          psr = excluded.psr,
          fcf_yield = excluded.fcf_yield,
          ev_ebitda = excluded.ev_ebitda,
          net_debt = excluded.net_debt,
          dividend_yield = excluded.dividend_yield,
          roe = excluded.roe,
          revenue_growth = excluded.revenue_growth,
          enterprise_value = excluded.enterprise_value,
          ebitda = excluded.ebitda,
          peer_forward_per = excluded.peer_forward_per,
          peer_pbr = excluded.peer_pbr,
          peer_fcf_yield = excluded.peer_fcf_yield,
          peer_roe = excluded.peer_roe,
          peer_revenue_growth = excluded.peer_revenue_growth,
          peer_ev_ebitda = excluded.peer_ev_ebitda,
          basis_id = excluded.basis_id,
          forecast_snapshot_id = excluded.forecast_snapshot_id,
          calculated_at = excluded.calculated_at
      `,
      args: [
        row.ticker,
        row.valuationDate,
        row.priceDate,
        row.price,
        row.isTradingDay ? 1 : 0,
        row.per,
        row.forwardPer,
        row.pbr,
        row.psr,
        row.fcfYield,
        row.evEbitda,
        row.netDebt,
        row.dividendYield,
        row.roe,
        row.revenueGrowth,
        row.enterpriseValue,
        row.ebitda,
        row.peerForwardPer,
        row.peerPbr,
        row.peerFcfYield,
        row.peerRoe,
        row.peerRevenueGrowth,
        row.peerEvEbitda,
        row.basisId,
        row.forecastSnapshotId,
        calculatedAt,
      ],
    })))
  }
}

export async function buildValuationServingForTicker(
  ticker: string,
  options: { years?: number; force?: boolean } = {},
): Promise<ValuationServingBuildResult> {
  const startedAt = performance.now()
  await ensureReady()
  const years = Math.max(0, options.years ?? 0)
  const [profile, latestPrice, source, checkpoint] = await Promise.all([
    execGet<ProfileRow>(`
      SELECT sector17_name AS sector17Name, sector33_name AS sector33Name
      FROM ticker_universe WHERE ticker = ?
    `, [ticker]),
    execGet<PriceRow>(`
      SELECT ticker, date, close FROM ohlcv_daily WHERE ticker = ? ORDER BY date DESC LIMIT 1
    `, [ticker]),
    sourceState(ticker),
    checkpointFor(ticker),
  ])
  if (!latestPrice) {
    const result: ValuationServingBuildResult = {
      ticker,
      status: 'no_price',
      historyStartDate: null,
      recomputeStartDate: null,
      latestValuationDate: null,
      latestPriceDate: null,
      rows: 0,
      bases: 0,
      elapsedMs: performance.now() - startedAt,
    }
    await persistCheckpoint(result, source)
    return result
  }

  const earliestPrice = years === 0
    ? await execGet<{ date: string }>('SELECT MIN(date) AS date FROM ohlcv_daily WHERE ticker = ?', [ticker])
    : null
  const historyStartDate = years === 0
    ? earliestPrice?.date ?? latestPrice.date
    : subtractYears(latestPrice.date, years)
  const unchanged = !options.force
    && checkpoint?.status === 'completed'
    && checkpoint.definitionSignature === VALUATION_SERVING_DEFINITION_SIGNATURE
    && checkpoint.historyStartDate === historyStartDate
    && checkpoint.latestPriceDate === latestPrice.date
    && Number(checkpoint.sourceImportedAt) === source.importedAt
    && Number(checkpoint.sourceRowCount) === source.rowCount
  if (unchanged) {
    return {
      ticker,
      status: 'skipped',
      historyStartDate,
      recomputeStartDate: null,
      latestValuationDate: checkpoint.latestValuationDate,
      latestPriceDate: latestPrice.date,
      rows: 0,
      bases: 0,
      elapsedMs: performance.now() - startedAt,
    }
  }

  let recomputeStartDate = historyStartDate
  const compatibleCheckpoint = !options.force
    && checkpoint?.definitionSignature === VALUATION_SERVING_DEFINITION_SIGNATURE
    && checkpoint.historyStartDate === historyStartDate
  if (compatibleCheckpoint) {
    const candidates: string[] = []
    if (checkpoint.latestPriceDate && checkpoint.latestPriceDate < latestPrice.date) {
      const nextPrice = await execGet<{ date: string | null }>(`
        SELECT MIN(date) AS date FROM ohlcv_daily WHERE ticker = ? AND date > ?
      `, [ticker, checkpoint.latestPriceDate])
      if (nextPrice?.date) candidates.push(nextPrice.date)
    }
    if (Number(checkpoint.sourceImportedAt) !== source.importedAt || Number(checkpoint.sourceRowCount) !== source.rowCount) {
      const changed = await changedSourceStart(ticker, Number(checkpoint.sourceImportedAt))
      if (changed) candidates.push(changed)
    }
    if (candidates.length > 0) recomputeStartDate = candidates.sort()[0]
  }

  const [prices, facts, forecasts, detailedFacts] = await Promise.all([
    execAll<PriceRow>(`
      SELECT ticker, date, close FROM ohlcv_daily
      WHERE ticker = ? AND date BETWEEN ? AND ? ORDER BY date
    `, [ticker, historyStartDate, latestPrice.date]),
    loadNormalizedFinancialFactsForTickers([ticker]),
    loadFinancialForecastSnapshotsForTickers([ticker]),
    loadDetailedFinancialFactsForTickers([ticker]),
  ])
  const latestSourceDate = [
    ...facts.map((fact) => publishedDateJst(fact.publishedAt)),
    ...forecasts.map((forecast) => publishedDateJst(forecast.publishedAt)),
    ...detailedFacts.map((fact) => publishedDateJst(fact.publishedAt)),
  ].sort().at(-1) ?? null
  const latestValuationDate = [latestPrice.date, latestSourceDate ?? ''].sort().at(-1)!
  const priceByDate = new Map(prices.map((price) => [price.date, price]))
  const timeline = [...new Set([
    ...prices.map((price) => price.date),
    ...facts.map((fact) => publishedDateJst(fact.publishedAt)),
    ...forecasts.map((forecast) => publishedDateJst(forecast.publishedAt)),
    ...detailedFacts.map((fact) => publishedDateJst(fact.publishedAt)),
  ])].filter((date) => date >= recomputeStartDate && date <= latestValuationDate).sort()

  const sortedFacts = [...facts].sort((left, right) => left.publishedAt.localeCompare(right.publishedAt))
  const sortedForecasts = [...forecasts].sort((left, right) => left.publishedAt.localeCompare(right.publishedAt))
  const sortedDetailed = [...detailedFacts].sort((left, right) => left.publishedAt.localeCompare(right.publishedAt))
  const activeFacts: NormalizedFinancialFact[] = []
  const activeForecasts: FinancialForecastSnapshot[] = []
  const activeDetailed: DetailedFinancialFact[] = []
  let factIndex = 0
  let forecastIndex = 0
  let detailIndex = 0
  let selectedForecasts: FinancialForecastSnapshot[] = []
  let currentPrice: PriceRow | null = prices.filter((price) => price.date <= recomputeStartDate).at(-1) ?? null
  let currentBasis: ValuationMetricBasis | null = null
  const bases: ValuationMetricBasis[] = []
  const rows: ValuationServingRow[] = []
  const isFinancialSector = financialSector(profile)

  for (const date of timeline) {
    const price = priceByDate.get(date)
    if (price) currentPrice = price
    const cutoff = normalizeAsOf(date)
    let basisChanged = currentBasis == null
    while (factIndex < sortedFacts.length && sortedFacts[factIndex].publishedAt <= cutoff) {
      activeFacts.push(sortedFacts[factIndex++])
      basisChanged = true
    }
    let forecastChanged = false
    while (forecastIndex < sortedForecasts.length && sortedForecasts[forecastIndex].publishedAt <= cutoff) {
      activeForecasts.push(sortedForecasts[forecastIndex++])
      forecastChanged = true
      basisChanged = true
    }
    while (detailIndex < sortedDetailed.length && sortedDetailed[detailIndex].publishedAt <= cutoff) {
      activeDetailed.push(sortedDetailed[detailIndex++])
      basisChanged = true
    }
    if (!currentPrice) continue
    if (forecastChanged) selectedForecasts = selectForecastsAsOf(activeForecasts, date)
    if (basisChanged) {
      currentBasis = buildBasis(
        ticker,
        date,
        activeFacts,
        selectedForecasts,
        activeDetailed,
        isFinancialSector,
      )
      bases.push(currentBasis)
    }
    if (!currentBasis) continue
    rows.push(materializeRow(ticker, date, currentPrice, Boolean(price), currentBasis))
  }

  const calculatedAt = Math.floor(Date.now() / 1000)
  await persistBases(bases, calculatedAt)
  await persistRows(rows, calculatedAt)
  const result: ValuationServingBuildResult = {
    ticker,
    status: 'completed',
    historyStartDate,
    recomputeStartDate,
    latestValuationDate,
    latestPriceDate: latestPrice.date,
    rows: rows.length,
    bases: new Set(bases.map((basis) => basis.basisId)).size,
    elapsedMs: performance.now() - startedAt,
  }
  await persistCheckpoint(result, source)
  return result
}

export async function loadValuationServingHistory(
  ticker: string,
  from: string,
  to: string,
): Promise<{ rows: ValuationServingRow[]; bases: Map<string, ValuationMetricBasis> }> {
  const rows = (await execAll<Record<string, unknown>>(`
    SELECT * FROM valuation_daily_serving
    WHERE ticker = ? AND valuation_date BETWEEN ? AND ? AND is_trading_day = 1
    ORDER BY valuation_date
  `, [ticker, from, to])).map(rowFromSql)
  return { rows, bases: await loadValuationMetricBases(rows.map((row) => row.basisId)) }
}

export async function loadLatestValuationServingRows(
  tickers: string[],
  asOf: string,
): Promise<ValuationServingRow[]> {
  const unique = [...new Set(tickers)].filter(Boolean)
  if (unique.length === 0) return []
  const tickerValues = unique.map(() => '(?)').join(',')
  const rows = await execAll<Record<string, unknown>>(`
    WITH requested_tickers(ticker) AS (VALUES ${tickerValues})
    SELECT serving.*
    FROM requested_tickers requested
    INNER JOIN valuation_daily_serving serving
      ON serving.ticker = requested.ticker
     AND serving.valuation_date = (
       SELECT latest.valuation_date
       FROM valuation_daily_serving latest
       WHERE latest.ticker = requested.ticker
         AND latest.valuation_date <= ?
       ORDER BY latest.valuation_date DESC
       LIMIT 1
     )
  `, [...unique, asOf])
  return rows.map(rowFromSql)
}

export async function loadValuationMetricBases(
  basisIds: string[],
): Promise<Map<string, ValuationMetricBasis>> {
  const unique = [...new Set(basisIds)].filter(Boolean)
  if (unique.length === 0) return new Map()
  const output = new Map<string, ValuationMetricBasis>()
  for (let offset = 0; offset < unique.length; offset += 500) {
    const chunk = unique.slice(offset, offset + 500)
    const rows = await execAll<Record<string, unknown>>(`
      SELECT * FROM valuation_metric_bases
      WHERE basis_id IN (${chunk.map(() => '?').join(',')})
    `, chunk)
    for (const row of rows) {
      const basis = basisFromSql(row)
      output.set(basis.basisId, basis)
    }
  }
  return output
}

export function servingMetricValue(
  row: ValuationServingRow,
  metric: ValuationServingMetric,
): number | null {
  const field: Record<ValuationServingMetric, keyof ValuationServingRow> = {
    per: 'per',
    forward_per: 'forwardPer',
    pbr: 'pbr',
    psr: 'psr',
    fcf_yield: 'fcfYield',
    ev_ebitda: 'evEbitda',
    net_debt: 'netDebt',
    dividend_yield: 'dividendYield',
    roe: 'roe',
    revenue_growth: 'revenueGrowth',
    enterprise_value: 'enterpriseValue',
    ebitda: 'ebitda',
  }
  return row[field[metric]] as number | null
}

export function servingPeerMetricValue(
  row: ValuationServingRow,
  metric: Extract<ValuationServingMetric, 'forward_per' | 'pbr' | 'fcf_yield' | 'roe' | 'revenue_growth' | 'ev_ebitda'>,
): number | null {
  const field = {
    forward_per: row.peerForwardPer,
    pbr: row.peerPbr,
    fcf_yield: row.peerFcfYield,
    roe: row.peerRoe,
    revenue_growth: row.peerRevenueGrowth,
    ev_ebitda: row.peerEvEbitda,
  }
  return field[metric]
}

export function servingMetricProvenance(
  row: ValuationServingRow,
  basis: ValuationMetricBasis | undefined,
  metric: ValuationServingMetric,
): Pick<ValuationMetricTransform, 'inputFactIds' | 'forecastSnapshotId' | 'definitionVersion' | 'periodEnd'> | null {
  const transform = basis?.transforms[metric]
  if (!transform) return null
  return {
    inputFactIds: transform.usesPrice
      ? [
        ...transform.inputFactIds.slice(0, transform.priceInputIndex ?? 0),
        `price:JP:${row.ticker}:${row.priceDate}`,
        ...transform.inputFactIds.slice(transform.priceInputIndex ?? 0),
      ]
      : transform.inputFactIds,
    forecastSnapshotId: transform.forecastSnapshotId,
    definitionVersion: transform.definitionVersion,
    periodEnd: transform.periodEnd,
  }
}
