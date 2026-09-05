import { execAll, execBatch, execGet, execRun, type Args } from '@/lib/db/client'
import {
  deriveFinancialFacts,
  normalizeAsOf,
  normalizeJQuantsFinancialRows,
  selectForecastsAsOf,
  type FinancialForecastSnapshot,
  type NormalizedFinancialFact,
} from '@/lib/financial-foundation'
import { calculateFinancialMetrics, type CalculatedFinancialMetric } from '@/lib/financial-metrics'
import type { JFinsSummaryRow } from '@/lib/jquants'

const WRITE_CHUNK = 250
const READ_CHUNK = 300

export interface FinancialFoundationWriteResult {
  disclosures: number
  facts: number
  derivedFacts: number
  forecasts: number
  calculatedMetrics: number
}

export interface FinancialFoundationWriteOptions {
  deferDerivedAndMetrics?: boolean
}

export interface FinancialFoundationRebuildResult {
  ticker: string
  sourceFacts: number
  derivedFacts: number
  calculatedMetrics: number
  metricsAsOf: string | null
}

async function writeChunks(statements: Array<{ sql: string; args: Args }>): Promise<void> {
  for (let index = 0; index < statements.length; index += WRITE_CHUNK) {
    await execBatch(statements.slice(index, index + WRITE_CHUNK))
  }
}

function factInsert(fact: NormalizedFinancialFact, importedAt: number) {
  return {
    sql: `
      INSERT INTO normalized_financial_facts (
        fact_id, event_id, ticker, published_at, period_start, period_end,
        fiscal_year_start, fiscal_year_end, target_fiscal_year,
        period_kind, accumulation_kind, value_kind, metric, value, unit, currency,
        consolidation_scope, accounting_standard, correction_status,
        source, source_field, disclosure_id, is_derived, derivation_method,
        input_fact_ids_json, definition_version, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fact_id) DO UPDATE SET
        published_at = excluded.published_at,
        value = excluded.value,
        correction_status = excluded.correction_status,
        derivation_method = excluded.derivation_method,
        input_fact_ids_json = excluded.input_fact_ids_json,
        definition_version = excluded.definition_version,
        imported_at = excluded.imported_at
    `,
    args: [
      fact.factId, fact.eventId, fact.ticker, fact.publishedAt, fact.periodStart, fact.periodEnd,
      fact.fiscalYearStart, fact.fiscalYearEnd, fact.targetFiscalYear,
      fact.periodKind, fact.accumulationKind, fact.valueKind, fact.metric, fact.value,
      fact.unit, fact.currency, fact.consolidationScope, fact.accountingStandard,
      fact.correctionStatus, fact.source, fact.sourceField, fact.disclosureId,
      fact.isDerived ? 1 : 0, fact.derivationMethod, JSON.stringify(fact.inputFactIds),
      fact.definitionVersion, importedAt,
    ],
  }
}

function metricInsert(metric: CalculatedFinancialMetric, computedAt: number) {
  return {
    sql: `
      INSERT INTO calculated_financial_metrics (
        value_id, ticker, as_of, period_start, period_end, metric, value, unit,
        consolidation_scope, accounting_standard, definition_version,
        derivation_method, input_fact_ids_json, source, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'calculated', ?)
      ON CONFLICT(value_id) DO UPDATE SET
        value = excluded.value,
        period_start = excluded.period_start,
        period_end = excluded.period_end,
        input_fact_ids_json = excluded.input_fact_ids_json,
        derivation_method = excluded.derivation_method,
        computed_at = excluded.computed_at
    `,
    args: [
      metric.valueId, metric.ticker, metric.asOf, metric.periodStart, metric.periodEnd,
      metric.metric, metric.value, metric.unit, metric.consolidationScope,
      metric.accountingStandard, metric.definitionVersion, metric.derivationMethod,
      JSON.stringify(metric.inputFactIds), computedAt,
    ],
  }
}

export async function upsertCalculatedFinancialMetrics(
  metrics: CalculatedFinancialMetric[],
  computedAt = Math.floor(Date.now() / 1000),
): Promise<void> {
  await writeChunks(metrics.map((metric) => metricInsert(metric, computedAt)))
}

function normalizedFactFromRow(row: Record<string, unknown>): NormalizedFinancialFact {
  return {
    factId: String(row.fact_id),
    eventId: String(row.event_id),
    ticker: String(row.ticker),
    publishedAt: String(row.published_at),
    periodStart: row.period_start == null ? null : String(row.period_start),
    periodEnd: String(row.period_end),
    fiscalYearStart: row.fiscal_year_start == null ? null : String(row.fiscal_year_start),
    fiscalYearEnd: row.fiscal_year_end == null ? null : String(row.fiscal_year_end),
    targetFiscalYear: row.target_fiscal_year == null ? null : Number(row.target_fiscal_year),
    periodKind: String(row.period_kind) as NormalizedFinancialFact['periodKind'],
    accumulationKind: String(row.accumulation_kind) as NormalizedFinancialFact['accumulationKind'],
    valueKind: String(row.value_kind) as NormalizedFinancialFact['valueKind'],
    metric: String(row.metric),
    value: Number(row.value),
    unit: String(row.unit),
    currency: row.currency == null ? null : String(row.currency),
    consolidationScope: String(row.consolidation_scope) as NormalizedFinancialFact['consolidationScope'],
    accountingStandard: String(row.accounting_standard) as NormalizedFinancialFact['accountingStandard'],
    correctionStatus: String(row.correction_status),
    source: String(row.source) as NormalizedFinancialFact['source'],
    sourceField: row.source_field == null ? null : String(row.source_field),
    disclosureId: String(row.disclosure_id),
    isDerived: Number(row.is_derived) === 1,
    derivationMethod: row.derivation_method == null ? null : String(row.derivation_method),
    inputFactIds: JSON.parse(String(row.input_fact_ids_json ?? '[]')) as string[],
    definitionVersion: row.definition_version == null ? null : String(row.definition_version),
  }
}

function forecastSnapshotFromRow(row: Record<string, unknown>): FinancialForecastSnapshot {
  return {
    snapshotId: String(row.snapshot_id),
    eventId: String(row.event_id),
    ticker: String(row.ticker),
    publishedAt: String(row.published_at),
    targetFiscalYear: Number(row.target_fiscal_year),
    targetPeriodStart: row.target_period_start == null ? null : String(row.target_period_start),
    targetPeriodEnd: String(row.target_period_end),
    forecastScope: String(row.forecast_scope) as FinancialForecastSnapshot['forecastScope'],
    forecastPeriod: String(row.forecast_period) as FinancialForecastSnapshot['forecastPeriod'],
    metric: String(row.metric),
    value: Number(row.value),
    unit: String(row.unit),
    currency: row.currency == null ? null : String(row.currency),
    consolidationScope: String(row.consolidation_scope) as FinancialForecastSnapshot['consolidationScope'],
    accountingStandard: String(row.accounting_standard) as FinancialForecastSnapshot['accountingStandard'],
    source: 'jquants',
    sourceField: String(row.source_field),
    disclosureId: String(row.disclosure_id),
  }
}

export async function loadNormalizedFinancialFactsForTickers(
  tickers: string[],
  options: {
    asOf?: string | null
    metrics?: string[]
    periodEndFrom?: string | null
    sources?: string[]
    accumulationKinds?: string[]
  } = {},
): Promise<NormalizedFinancialFact[]> {
  const unique = [...new Set(tickers)].filter(Boolean)
  if (unique.length === 0) return []
  const output: NormalizedFinancialFact[] = []
  for (let offset = 0; offset < unique.length; offset += READ_CHUNK) {
    const chunk = unique.slice(offset, offset + READ_CHUNK)
    const metricSql = options.metrics?.length ? `AND metric IN (${options.metrics.map(() => '?').join(',')})` : ''
    const cutoffSql = options.asOf ? 'AND published_at <= ?' : ''
    const periodSql = options.periodEndFrom ? 'AND period_end >= ?' : ''
    const sourceSql = options.sources?.length ? `AND source IN (${options.sources.map(() => '?').join(',')})` : ''
    const accumulationSql = options.accumulationKinds?.length
      ? `AND accumulation_kind IN (${options.accumulationKinds.map(() => '?').join(',')})`
      : ''
    const rows = await execAll<Record<string, unknown>>(`
      SELECT * FROM normalized_financial_facts
      WHERE ticker IN (${chunk.map(() => '?').join(',')})
        ${metricSql}
        ${cutoffSql}
        ${periodSql}
        ${sourceSql}
        ${accumulationSql}
      ORDER BY ticker, published_at, period_end, fact_id
    `, [
      ...chunk,
      ...(options.metrics ?? []),
      ...(options.asOf ? [normalizeAsOf(options.asOf)] : []),
      ...(options.periodEndFrom ? [options.periodEndFrom] : []),
      ...(options.sources ?? []),
      ...(options.accumulationKinds ?? []),
    ])
    for (const row of rows) output.push(normalizedFactFromRow(row))
  }
  return output
}

export async function loadNormalizedFinancialFacts(ticker: string): Promise<NormalizedFinancialFact[]> {
  return loadNormalizedFinancialFactsForTickers([ticker])
}

export async function loadFinancialForecastSnapshotsForTickers(
  tickers: string[],
  options: { asOf?: string | null; metrics?: string[] } = {},
): Promise<FinancialForecastSnapshot[]> {
  const unique = [...new Set(tickers)].filter(Boolean)
  if (unique.length === 0) return []
  const output: FinancialForecastSnapshot[] = []
  for (let offset = 0; offset < unique.length; offset += READ_CHUNK) {
    const chunk = unique.slice(offset, offset + READ_CHUNK)
    const metricSql = options.metrics?.length ? `AND metric IN (${options.metrics.map(() => '?').join(',')})` : ''
    const cutoffSql = options.asOf ? 'AND published_at <= ?' : ''
    const rows = await execAll<Record<string, unknown>>(`
      SELECT * FROM financial_forecast_snapshots
      WHERE ticker IN (${chunk.map(() => '?').join(',')})
        ${metricSql}
        ${cutoffSql}
      ORDER BY ticker, published_at, snapshot_id
    `, [
      ...chunk,
      ...(options.metrics ?? []),
      ...(options.asOf ? [normalizeAsOf(options.asOf)] : []),
    ])
    for (const row of rows) output.push(forecastSnapshotFromRow(row))
  }
  return output
}

export async function loadFinancialForecastSnapshots(ticker: string): Promise<FinancialForecastSnapshot[]> {
  return loadFinancialForecastSnapshotsForTickers([ticker])
}

export async function getForecastSnapshotsAsOf(
  ticker: string,
  asOf: string,
): Promise<FinancialForecastSnapshot[]> {
  const rows = await execAll<Record<string, unknown>>(`
    SELECT * FROM financial_forecast_snapshots
    WHERE ticker = ? AND published_at <= ?
    ORDER BY published_at, snapshot_id
  `, [ticker, normalizeAsOf(asOf)])
  const snapshots = rows.map(forecastSnapshotFromRow)
  return selectForecastsAsOf(snapshots, asOf)
}

async function calculateAndStoreLatestMetrics(
  ticker: string,
  computedAt: number,
): Promise<{ count: number; asOf: string | null }> {
  const [price, sector, facts, forecasts] = await Promise.all([
    execGet<{ date: string; close: number }>(`
      SELECT date, close FROM ohlcv_daily
      WHERE ticker = ? ORDER BY date DESC LIMIT 1
    `, [ticker]),
    execGet<{ sector17_name: string | null; sector33_name: string | null }>(`
      SELECT sector17_name, sector33_name FROM ticker_universe WHERE ticker = ?
    `, [ticker]),
    loadNormalizedFinancialFacts(ticker),
    loadFinancialForecastSnapshots(ticker),
  ])
  const asOf = price?.date ?? facts.map((fact) => fact.publishedAt.slice(0, 10)).sort().at(-1)
  if (!asOf) return { count: 0, asOf: null }
  const sectorName = `${sector?.sector17_name ?? ''} ${sector?.sector33_name ?? ''}`
  const metrics = calculateFinancialMetrics({
    ticker,
    asOf,
    facts,
    forecasts,
    price: price ? { value: Number(price.close), date: price.date, inputId: `price:JP:${ticker}:${price.date}` } : null,
    isFinancialSector: /銀行|保険|証券|金融/.test(sectorName),
  })
  const metricKeys = [...new Set(metrics.map((metric) => metric.metric))]
  if (metricKeys.length > 0) {
    await execRun(`
      DELETE FROM calculated_financial_metrics
      WHERE ticker = ? AND as_of = ?
        AND metric IN (${metricKeys.map(() => '?').join(',')})
    `, [ticker, asOf, ...metricKeys])
  }
  await writeChunks(metrics.map((metric) => metricInsert(metric, computedAt)))
  return { count: metrics.length, asOf }
}

export async function rebuildFinancialFoundationForTicker(
  ticker: string,
  computedAt = Math.floor(Date.now() / 1000),
): Promise<FinancialFoundationRebuildResult> {
  const facts = await loadNormalizedFinancialFacts(ticker)
  const sourceFacts = facts.filter((fact) => !fact.isDerived)
  const derivedFacts = deriveFinancialFacts(sourceFacts)

  // Derived rows are reproducible outputs. Replacing only those rows prevents
  // stale derivations from surviving a definition change while preserving every
  // source disclosure and correction snapshot.
  await execRun(`
    DELETE FROM normalized_financial_facts
    WHERE ticker = ? AND is_derived = 1
  `, [ticker])
  await writeChunks(derivedFacts.map((fact) => factInsert(fact, computedAt)))
  const metrics = await calculateAndStoreLatestMetrics(ticker, computedAt)
  return {
    ticker,
    sourceFacts: sourceFacts.length,
    derivedFacts: derivedFacts.length,
    calculatedMetrics: metrics.count,
    metricsAsOf: metrics.asOf,
  }
}

export async function upsertFinancialFoundationRows(
  rows: JFinsSummaryRow[],
  importedAt = Math.floor(Date.now() / 1000),
  options: FinancialFoundationWriteOptions = {},
): Promise<FinancialFoundationWriteResult> {
  const normalized = normalizeJQuantsFinancialRows(rows)

  await writeChunks(normalized.disclosures.map((event) => ({
    sql: `
      INSERT INTO financial_disclosures (
        event_id, ticker, published_at, source, disclosure_id, document_type,
        accounting_standard, correction_status, metadata_json, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        published_at = excluded.published_at,
        document_type = excluded.document_type,
        accounting_standard = excluded.accounting_standard,
        correction_status = excluded.correction_status,
        metadata_json = excluded.metadata_json,
        imported_at = excluded.imported_at
    `,
    args: [
      event.eventId, event.ticker, event.publishedAt, event.source, event.disclosureId,
      event.documentType, event.accountingStandard, event.correctionStatus,
      event.metadataJson, importedAt,
    ],
  })))
  await writeChunks(normalized.facts.map((fact) => factInsert(fact, importedAt)))
  await writeChunks(normalized.forecasts.map((snapshot) => ({
    sql: `
      INSERT INTO financial_forecast_snapshots (
        snapshot_id, event_id, ticker, published_at, target_fiscal_year,
        target_period_start, target_period_end, forecast_scope, forecast_period,
        metric, value, unit, currency, consolidation_scope, accounting_standard,
        source, source_field, disclosure_id, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_id) DO UPDATE SET
        published_at = excluded.published_at,
        value = excluded.value,
        target_period_start = excluded.target_period_start,
        target_period_end = excluded.target_period_end,
        accounting_standard = excluded.accounting_standard,
        imported_at = excluded.imported_at
    `,
    args: [
      snapshot.snapshotId, snapshot.eventId, snapshot.ticker, snapshot.publishedAt,
      snapshot.targetFiscalYear, snapshot.targetPeriodStart, snapshot.targetPeriodEnd,
      snapshot.forecastScope, snapshot.forecastPeriod, snapshot.metric, snapshot.value,
      snapshot.unit, snapshot.currency, snapshot.consolidationScope,
      snapshot.accountingStandard, snapshot.source, snapshot.sourceField,
      snapshot.disclosureId, importedAt,
    ],
  })))

  let derivedFacts = 0
  let calculatedMetrics = 0
  const tickers = [...new Set(normalized.disclosures.map((event) => event.ticker))]
  if (!options.deferDerivedAndMetrics) {
    for (const ticker of tickers) {
      const rebuilt = await rebuildFinancialFoundationForTicker(ticker, importedAt)
      derivedFacts += rebuilt.derivedFacts
      calculatedMetrics += rebuilt.calculatedMetrics
    }
  }
  return {
    disclosures: normalized.disclosures.length,
    facts: normalized.facts.length,
    derivedFacts,
    forecasts: normalized.forecasts.length,
    calculatedMetrics,
  }
}
