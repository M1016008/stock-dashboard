import { client, ensureReady } from '@/lib/db/client'
import type { DetailedFinancialFact } from '@/lib/detailed-financial-foundation'

const READ_CHUNK = 300

function text(value: unknown): string {
  return String(value ?? '')
}

function nullableText(value: unknown): string | null {
  return value == null ? null : String(value)
}

function numberValue(value: unknown): number {
  return Number(value)
}

function rowToFact(row: Record<string, unknown>): DetailedFinancialFact {
  return {
    factId: text(row.fact_id),
    eventId: text(row.event_id),
    ticker: text(row.ticker),
    publishedAt: text(row.published_at),
    periodStart: nullableText(row.period_start),
    periodEnd: text(row.period_end),
    valueKind: text(row.value_kind) as DetailedFinancialFact['valueKind'],
    metric: text(row.metric) as DetailedFinancialFact['metric'],
    value: numberValue(row.value),
    unit: text(row.unit),
    currency: nullableText(row.currency),
    consolidationScope: text(row.consolidation_scope) as DetailedFinancialFact['consolidationScope'],
    accountingStandard: text(row.accounting_standard) as DetailedFinancialFact['accountingStandard'],
    correctionStatus: text(row.correction_status) as DetailedFinancialFact['correctionStatus'],
    source: text(row.source) as DetailedFinancialFact['source'],
    sourceConcept: text(row.source_concept),
    sourceNamespace: nullableText(row.source_namespace),
    contextRef: text(row.context_ref),
    dimensions: JSON.parse(text(row.dimensions_json) || '[]'),
    disclosureId: text(row.disclosure_id),
    documentId: nullableText(row.document_id),
    sourcePriority: numberValue(row.source_priority),
    derivationMethod: nullableText(row.derivation_method),
    inputFactIds: JSON.parse(text(row.input_fact_ids_json) || '[]'),
    definitionVersion: nullableText(row.definition_version),
  }
}

export async function saveDetailedFinancialFacts(
  facts: DetailedFinancialFact[],
  metadata: { documentType?: string | null; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  if (facts.length === 0) return
  await ensureReady()
  const first = facts[0]
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = [{
    sql: `DELETE FROM detailed_financial_facts WHERE document_id = ?`,
    args: [first.documentId],
  }, {
    sql: `
      INSERT INTO financial_disclosures (
        event_id, ticker, published_at, source, disclosure_id, document_type,
        accounting_standard, correction_status, metadata_json, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(event_id) DO UPDATE SET
        published_at = excluded.published_at,
        document_type = excluded.document_type,
        accounting_standard = excluded.accounting_standard,
        correction_status = excluded.correction_status,
        metadata_json = excluded.metadata_json,
        imported_at = excluded.imported_at
    `,
    args: [
      first.eventId, first.ticker, first.publishedAt, first.source, first.disclosureId,
      metadata.documentType ?? null, first.accountingStandard, first.correctionStatus,
      JSON.stringify(metadata.metadata ?? {}),
    ],
  }]
  for (const fact of facts) {
    statements.push({
      sql: `
        INSERT INTO detailed_financial_facts (
          fact_id, event_id, ticker, published_at, period_start, period_end,
          value_kind, metric, value, unit, currency, consolidation_scope,
          accounting_standard, correction_status, source, source_concept,
          source_namespace, context_ref, dimensions_json, disclosure_id,
          document_id, source_priority, derivation_method, input_fact_ids_json,
          definition_version, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(fact_id) DO UPDATE SET
          value = excluded.value,
          unit = excluded.unit,
          currency = excluded.currency,
          source_priority = excluded.source_priority,
          derivation_method = excluded.derivation_method,
          input_fact_ids_json = excluded.input_fact_ids_json,
          definition_version = excluded.definition_version,
          imported_at = excluded.imported_at
      `,
      args: [
        fact.factId, fact.eventId, fact.ticker, fact.publishedAt, fact.periodStart, fact.periodEnd,
        fact.valueKind, fact.metric, fact.value, fact.unit, fact.currency, fact.consolidationScope,
        fact.accountingStandard, fact.correctionStatus, fact.source, fact.sourceConcept,
        fact.sourceNamespace, fact.contextRef, JSON.stringify(fact.dimensions), fact.disclosureId,
        fact.documentId, fact.sourcePriority, fact.derivationMethod, JSON.stringify(fact.inputFactIds),
        fact.definitionVersion,
      ],
    })
  }
  for (let offset = 0; offset < statements.length; offset += 100) {
    await client.batch(statements.slice(offset, offset + 100))
  }
}

export async function loadDetailedFinancialFacts(
  ticker: string,
  asOf?: string,
): Promise<DetailedFinancialFact[]> {
  await ensureReady()
  const cutoff = asOf ? (asOf.length === 10 ? `${asOf}T23:59:59` : asOf) : null
  const result = await client.execute({
    sql: `
      SELECT * FROM detailed_financial_facts
      WHERE ticker = ? ${cutoff ? 'AND published_at <= ?' : ''}
      ORDER BY period_end, published_at, metric
    `,
    args: cutoff ? [ticker, cutoff] : [ticker],
  })
  return result.rows.map((row) => rowToFact({ ...row }))
}

export async function loadDetailedFinancialFactsForTickers(
  tickers: string[],
  options: { asOf?: string | null; metrics?: string[] } = {},
): Promise<DetailedFinancialFact[]> {
  await ensureReady()
  const unique = [...new Set(tickers)].filter(Boolean)
  if (unique.length === 0) return []
  const cutoff = options.asOf
    ? (options.asOf.length === 10 ? `${options.asOf}T23:59:59` : options.asOf)
    : null
  const output: DetailedFinancialFact[] = []
  for (let offset = 0; offset < unique.length; offset += READ_CHUNK) {
    const chunk = unique.slice(offset, offset + READ_CHUNK)
    const metricSql = options.metrics?.length ? `AND metric IN (${options.metrics.map(() => '?').join(',')})` : ''
    const cutoffSql = cutoff ? 'AND published_at <= ?' : ''
    const result = await client.execute({
      sql: `
        SELECT * FROM detailed_financial_facts
        WHERE ticker IN (${chunk.map(() => '?').join(',')})
          ${metricSql}
          ${cutoffSql}
        ORDER BY ticker, period_end, published_at, metric
      `,
      args: [
        ...chunk,
        ...(options.metrics ?? []),
        ...(cutoff ? [cutoff] : []),
      ],
    })
    for (const row of result.rows) output.push(rowToFact({ ...row }))
  }
  return output
}

export async function detailedFinancialDocumentExists(documentId: string): Promise<boolean> {
  await ensureReady()
  const result = await client.execute({
    sql: `SELECT 1 FROM detailed_financial_facts WHERE document_id = ? LIMIT 1`,
    args: [documentId],
  })
  return result.rows.length > 0
}
