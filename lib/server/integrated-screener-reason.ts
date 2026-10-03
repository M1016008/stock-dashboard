import { execGet } from '@/lib/db/client'
import {
  SCREENING_METRIC_MAP,
  type IntegratedScreeningRow,
  type ScreeningCondition,
  type ScreeningMetricKey,
} from '@/lib/integrated-screener'
import {
  type ScreenerReasonActualValue,
  type ScreenerReasonComparison,
  type ScreenerReasonContract,
  type ScreenerReasonItem,
} from '@/lib/screener-reason'
import { todayInTokyo } from '@/lib/date-time'
import { getIntegratedScreeningReasonData } from '@/lib/server/integrated-screener-serving'

const REASON_CACHE_TTL_MS = 60_000
const reasonCache = new Map<string, { expiresAt: number; value: ScreenerReasonContract }>()

type AuxiliaryFact = {
  value: number
  published_at: string
  source: string
  source_field: string | null
  source_id: string
}

type ScoredReason = { score: number; item: ScreenerReasonItem }

function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isoDate(value: string | null | undefined): string {
  const clean = value?.trim().slice(0, 10)
  if (clean && /^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean
  return todayInTokyo()
}

function round(value: number | null, digits = 4): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const power = 10 ** digits
  return Math.round(value * power) / power
}

function compactCurrency(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1e12) return `${(value / 1e12).toFixed(2)}兆円`
  if (absolute >= 1e8) return `${(value / 1e8).toFixed(1)}億円`
  if (absolute >= 1e4) return `${(value / 1e4).toFixed(1)}万円`
  return `${value.toLocaleString('ja-JP', { maximumFractionDigits: 0 })}円`
}

export function formatMetric(metric: ScreeningMetricKey, value: number | string | boolean | null): string {
  if (value == null || value === '') return '—'
  const definition = SCREENING_METRIC_MAP.get(metric)
  if (!definition) return String(value)
  if (definition.valueType === 'currency') return compactCurrency(Number(value))
  if (definition.valueType === 'percent') return `${Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}%`
  if (definition.valueType === 'stage') return `Stage ${value}`
  if (definition.valueType === 'boolean') return value ? 'あり' : 'なし'
  if (definition.valueType === 'number') return `${Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 2 })}${definition.unit ?? ''}`
  return String(value)
}

function actualValue(metric: ScreeningMetricKey, value: unknown): ScreenerReasonActualValue {
  const definition = SCREENING_METRIC_MAP.get(metric)!
  const normalized = definition.valueType === 'boolean'
    ? (value == null ? null : Boolean(value))
    : definition.valueType === 'text'
      ? (value == null || value === '' ? null : String(value))
      : asNumber(value)
  return {
    metric,
    label: definition.label,
    value: normalized,
    formatted: formatMetric(metric, normalized),
    status: normalized == null ? 'missing' : 'available',
    unit: definition.unit,
  }
}

export function operatorSymbol(operator: ScreeningCondition['operator']): string {
  return { gte: '>=', gt: '>', lte: '<=', lt: '<', eq: '=', between: 'between', in: 'in', has_data: 'データあり' }[operator]
}

export function conditionTargetText(condition: ScreeningCondition): string {
  const definition = SCREENING_METRIC_MAP.get(condition.metric)!
  if (condition.operator === 'has_data') return 'データあり'
  if (condition.operator === 'between') {
    return `${formatMetric(condition.metric, asNumber(condition.value))}〜${formatMetric(condition.metric, asNumber(condition.valueTo))}`
  }
  if (condition.operator === 'in') {
    const values = Array.isArray(condition.value) ? condition.value : [condition.value]
    return values.map((value) => formatMetric(condition.metric, value as string | number)).join(' / ')
  }
  return formatMetric(condition.metric, condition.value as string | number | boolean | null)
}

export function conditionPassed(row: IntegratedScreeningRow, condition: ScreeningCondition): boolean {
  const value = row[condition.metric as keyof IntegratedScreeningRow]
  if (condition.operator === 'has_data') return value != null && value !== ''
  if (value == null || value === '') return false
  if (condition.operator === 'in') {
    const targets = Array.isArray(condition.value) ? condition.value : [condition.value]
    return targets.some((target) => String(target) === String(value))
  }
  if (condition.operator === 'between') {
    const actual = asNumber(value)
    const first = asNumber(condition.value)
    const second = asNumber(condition.valueTo)
    return actual != null && first != null && second != null && actual >= Math.min(first, second) && actual <= Math.max(first, second)
  }
  if (condition.operator === 'eq') return String(value) === String(condition.value)
  const actual = asNumber(value)
  const target = asNumber(condition.value)
  if (actual == null || target == null) return false
  if (condition.operator === 'gte') return actual >= target
  if (condition.operator === 'gt') return actual > target
  if (condition.operator === 'lte') return actual <= target
  return actual < target
}

function conditionMargin(condition: ScreeningCondition, value: unknown): { value: number | null; formatted: string | null } {
  const actual = asNumber(value)
  const target = asNumber(condition.value)
  if (actual == null || target == null || !['gte', 'gt', 'lte', 'lt'].includes(condition.operator)) return { value: null, formatted: null }
  const margin = condition.operator === 'lte' || condition.operator === 'lt' ? target - actual : actual - target
  const definition = SCREENING_METRIC_MAP.get(condition.metric)!
  const absolute = Math.abs(margin)
  const number = absolute.toLocaleString('ja-JP', { maximumFractionDigits: definition.valueType === 'currency' ? 0 : 2 })
  if (definition.valueType === 'percent') return { value: round(margin), formatted: `${number}pt余裕` }
  if (definition.valueType === 'currency') return { value: round(margin), formatted: `${compactCurrency(absolute)}余裕` }
  return { value: round(margin), formatted: `${number}${definition.unit ?? ''}余裕` }
}

function servingSource(row: IntegratedScreeningRow, metric: ScreeningMetricKey): ScreenerReasonItem['source'] {
  const category = SCREENING_METRIC_MAP.get(metric)?.category
  const sourceDate = category === 'structure' || category === 'margin' ? row.snapshotDate
    : category === 'valuation' ? row.valuationDate
      : null
  return {
    source: 'stock_screening_serving', sourceMetric: metric, asOf: row.asOf,
    sourceDate, sourceId: `${row.ticker}:${row.asOf}`,
  }
}

function matchedConditionItem(row: IntegratedScreeningRow, condition: ScreeningCondition): ScreenerReasonItem | null {
  if (!conditionPassed(row, condition)) return null
  const definition = SCREENING_METRIC_MAP.get(condition.metric)
  if (!definition) return null
  const value = row[condition.metric as keyof IntegratedScreeningRow]
  const actual = actualValue(condition.metric, value)
  const margin = conditionMargin(condition, value)
  const symbol = operatorSymbol(condition.operator)
  const expression = condition.operator === 'between' || condition.operator === 'in' || condition.operator === 'has_data'
    ? conditionTargetText(condition)
    : `${symbol} ${conditionTargetText(condition)}`
  const message = `${definition.label} ${actual.formatted} / 条件 ${expression}${margin.formatted ? ` / ${margin.formatted}` : ''}`
  return {
    id: `condition:${condition.id}`,
    kind: 'condition_match', metric: condition.metric, message, actual,
    condition: {
      operator: condition.operator, value: condition.value, valueTo: condition.valueTo,
      expression, margin: margin.value, marginFormatted: margin.formatted,
    },
    comparison: null,
    source: servingSource(row, condition.metric),
  }
}

function quantile(values: number[], probability: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function peerComparison(
  row: IntegratedScreeningRow,
  metric: ScreeningMetricKey,
  sectorPeers: IntegratedScreeningRow[],
  majorPeers: IntegratedScreeningRow[],
): ScreenerReasonComparison | null {
  const actual = asNumber(row[metric as keyof IntegratedScreeningRow])
  if (actual == null) return null
  const choose = (peers: IntegratedScreeningRow[], label: string, basis: ScreenerReasonComparison['basis']) => {
    const values = peers.map((peer) => asNumber(peer[metric as keyof IntegratedScreeningRow])).filter((value): value is number => value != null)
    if (values.length < 5) return null
    const median = quantile(values, 0.5)
    if (median == null) return null
    const definition = SCREENING_METRIC_MAP.get(metric)!
    const delta = actual - median
    const deltaFormatted = definition.valueType === 'percent'
      ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pt`
      : `${delta >= 0 ? '+' : ''}${delta.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}${definition.unit ?? ''}`
    return {
      basis, label, value: round(median), formatted: formatMetric(metric, median), delta: round(delta), deltaFormatted,
      percentile: round(100 * values.filter((value) => value <= actual).length / values.length, 1), sampleSize: values.length,
    } satisfies ScreenerReasonComparison
  }
  return choose(sectorPeers, `33業種中央値（${row.sector33}）`, 'sector33_median')
    ?? choose(majorPeers, `独自分類中央値（${row.majorCategory}）`, 'major_category_median')
}

function comparisonItem(
  row: IntegratedScreeningRow,
  metric: ScreeningMetricKey,
  comparison: ScreenerReasonComparison,
  message: string,
  kind: 'supporting_fact' | 'caution',
  idSuffix = '',
): ScreenerReasonItem {
  return {
    id: `${kind}:${metric}${idSuffix}`,
    kind, metric, message, actual: actualValue(metric, row[metric as keyof IntegratedScreeningRow]),
    condition: null, comparison, source: servingSource(row, metric),
  }
}

async function loadAuxiliaryFacts(ticker: string, asOf: string): Promise<{ actualEps: AuxiliaryFact | null; forecastEps: AuxiliaryFact | null }> {
  const cutoff = `${asOf}T23:59:59+09:00`
  const [actualEps, forecastEps] = await Promise.all([
    execGet<AuxiliaryFact>(`
      SELECT value, published_at, source, source_field, fact_id AS source_id
      FROM normalized_financial_facts
      WHERE ticker=? AND metric='eps_basic' AND period_kind='FY' AND accumulation_kind='FY' AND published_at<=?
      ORDER BY period_end DESC, published_at DESC, fact_id DESC LIMIT 1
    `, [ticker, cutoff]),
    execGet<AuxiliaryFact>(`
      SELECT value, published_at, source, source_field, snapshot_id AS source_id
      FROM financial_forecast_snapshots
      WHERE ticker=? AND metric='eps_basic' AND forecast_scope='current_fy' AND forecast_period='FY' AND published_at<=?
      ORDER BY target_fiscal_year DESC, published_at DESC, snapshot_id DESC LIMIT 1
    `, [ticker, cutoff]),
  ])
  return { actualEps: actualEps ?? null, forecastEps: forecastEps ?? null }
}

function auxiliaryItem(
  row: IntegratedScreeningRow,
  fact: AuxiliaryFact,
  metric: 'actual_eps' | 'forecast_eps',
  label: string,
  message: string,
): ScreenerReasonItem {
  return {
    id: `caution:${metric}`, kind: 'caution', metric, message,
    actual: { metric, label, value: Number(fact.value), formatted: `${Number(fact.value).toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円`, status: 'available', unit: '円' },
    condition: null,
    comparison: { basis: 'zero', label: '0円', value: 0, formatted: '0円', delta: round(Number(fact.value)), deltaFormatted: null, percentile: null, sampleSize: null },
    source: {
      source: metric === 'actual_eps' ? 'normalized_financial_facts' : 'financial_forecast_snapshots',
      sourceMetric: fact.source_field ?? 'eps_basic', asOf: row.asOf, sourceDate: fact.published_at, sourceId: fact.source_id,
    },
  }
}

function supportingFacts(
  row: IntegratedScreeningRow,
  sectorPeers: IntegratedScreeningRow[],
  majorPeers: IntegratedScreeningRow[],
  excluded: Set<ScreeningMetricKey>,
  sectorCount: number,
): ScreenerReasonItem[] {
  const candidates: ScoredReason[] = []
  for (const metric of ['revenueGrowth', 'epsGrowth', 'roe', 'fcfYield'] as ScreeningMetricKey[]) {
    if (excluded.has(metric)) continue
    const comparison = peerComparison(row, metric, sectorPeers, majorPeers)
    if (!comparison || comparison.delta == null || comparison.delta < 0.05) continue
    candidates.push({ score: 75 + Math.min(20, comparison.percentile ?? 0) / 5, item: comparisonItem(
      row, metric, comparison,
      `${SCREENING_METRIC_MAP.get(metric)!.label} ${formatMetric(metric, row[metric as keyof IntegratedScreeningRow] as number)} / ${comparison.label}より${comparison.deltaFormatted}`,
      'supporting_fact',
    ) })
  }
  for (const [metric, percentileMetric] of [['per', 'perPercentile5y'], ['pbr', 'pbrPercentile5y']] as const) {
    if (excluded.has(metric) || excluded.has(percentileMetric)) continue
    const value = asNumber(row[metric])
    const percentileValue = asNumber(row[percentileMetric])
    if (value == null || percentileValue == null || percentileValue > 25) continue
    const comparison: ScreenerReasonComparison = {
      basis: 'self_5y_percentile', label: '自社5年分布', value: null, formatted: null,
      delta: null, deltaFormatted: null, percentile: round(percentileValue, 1), sampleSize: null,
    }
    candidates.push({ score: 88 - percentileValue / 5, item: comparisonItem(
      row, metric, comparison, `${SCREENING_METRIC_MAP.get(metric)!.label} ${formatMetric(metric, value)} / 自社5年分布の${percentileValue.toFixed(1)} percentile`, 'supporting_fact', ':self',
    ) })
  }
  if (!excluded.has('latestForecastRevisionRate') && row.latestForecastRevisionDirection === 'up' && row.latestForecastRevisionRate != null) {
    const comparison: ScreenerReasonComparison = {
      basis: 'forecast_revision', label: '前回会社予想', value: null, formatted: null,
      delta: round(row.latestForecastRevisionRate), deltaFormatted: `+${row.latestForecastRevisionRate.toFixed(1)}%`, percentile: null, sampleSize: null,
    }
    candidates.push({ score: 92, item: comparisonItem(row, 'latestForecastRevisionRate', comparison, `最新会社予想は前回比 +${row.latestForecastRevisionRate.toFixed(1)}%`, 'supporting_fact') })
  }
  if (!excluded.has('consecutiveIncreaseYears') && row.consecutiveIncreaseYears != null && row.consecutiveIncreaseYears >= 3) {
    const comparison: ScreenerReasonComparison = {
      basis: 'zero', label: '連続増配', value: 0, formatted: null, delta: row.consecutiveIncreaseYears,
      deltaFormatted: `${row.consecutiveIncreaseYears}年`, percentile: null, sampleSize: null,
    }
    candidates.push({ score: 82 + Math.min(row.consecutiveIncreaseYears, 10), item: comparisonItem(row, 'consecutiveIncreaseYears', comparison, `${row.consecutiveIncreaseYears}年連続でDPSが増加`, 'supporting_fact') })
  }
  if (!excluded.has('sectorRank') && row.sectorRank != null && sectorCount > 0 && row.sectorRank <= Math.max(3, Math.ceil(sectorCount * 0.25))) {
    const comparison: ScreenerReasonComparison = {
      basis: 'sector_rank', label: '33業種構造順位', value: row.sectorRank, formatted: `${row.sectorRank}位`,
      delta: null, deltaFormatted: null, percentile: round(100 * row.sectorRank / sectorCount, 1), sampleSize: sectorCount,
    }
    candidates.push({ score: 80, item: comparisonItem(row, 'sectorRank', comparison, `33業種の構造順位 ${row.sectorRank}位 / ${sectorCount}業種`, 'supporting_fact') })
  }
  for (const metric of ['pms', 'pfs'] as const) {
    if (excluded.has(metric)) continue
    const comparison = peerComparison(row, metric, sectorPeers, majorPeers)
    if (!comparison || comparison.delta == null || comparison.delta < 0.005) continue
    candidates.push({ score: 70, item: comparisonItem(row, metric, comparison, `${metric.toUpperCase()} ${formatMetric(metric, row[metric])} / ${comparison.label}より${comparison.deltaFormatted}`, 'supporting_fact') })
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 3).map((candidate) => candidate.item)
}

function cautions(
  row: IntegratedScreeningRow,
  sectorPeers: IntegratedScreeningRow[],
  majorPeers: IntegratedScreeningRow[],
  auxiliary: { actualEps: AuxiliaryFact | null; forecastEps: AuxiliaryFact | null },
  sectorCount: number,
): ScreenerReasonItem[] {
  const candidates: ScoredReason[] = []
  if (auxiliary.actualEps && Number(auxiliary.actualEps.value) <= 0) {
    candidates.push({ score: 100, item: auxiliaryItem(row, auxiliary.actualEps, 'actual_eps', '実績EPS', `直近FYの実績EPSは${Number(auxiliary.actualEps.value).toFixed(2)}円（0円以下）`) })
  }
  if (auxiliary.forecastEps && Number(auxiliary.forecastEps.value) <= 0) {
    candidates.push({ score: 98, item: auxiliaryItem(row, auxiliary.forecastEps, 'forecast_eps', '会社予想EPS', `当期会社予想EPSは${Number(auxiliary.forecastEps.value).toFixed(2)}円のためForward PERはN/M`) })
  }
  if (row.standardFcf != null && row.standardFcf < 0) {
    const comparison: ScreenerReasonComparison = { basis: 'zero', label: '0円', value: 0, formatted: '0円', delta: round(row.standardFcf), deltaFormatted: compactCurrency(row.standardFcf), percentile: null, sampleSize: null }
    candidates.push({ score: 94, item: comparisonItem(row, 'standardFcf', comparison, `LTM標準FCFは${compactCurrency(row.standardFcf)}（負のFCF）`, 'caution') })
  }
  if (row.netDebt != null && row.marketCap != null && row.marketCap > 0) {
    const ratio = 100 * row.netDebt / row.marketCap
    const peers = sectorPeers.length >= 5 ? sectorPeers : majorPeers
    const peerRatios = peers.map((peer) => peer.netDebt != null && peer.marketCap != null && peer.marketCap > 0 ? 100 * peer.netDebt / peer.marketCap : null).filter((value): value is number => value != null)
    const p75 = quantile(peerRatios, 0.75)
    if (p75 != null && ratio > p75 && ratio > 0) {
      candidates.push({ score: 78, item: {
        id: 'caution:net-debt-market-cap', kind: 'caution', metric: 'net_debt_to_market_cap',
        message: `Net Debtは時価総額の${ratio.toFixed(1)}%、比較群の75 percentile（${p75.toFixed(1)}%）を上回る`,
        actual: { metric: 'net_debt_to_market_cap', label: 'Net Debt / 時価総額', value: round(ratio), formatted: `${ratio.toFixed(1)}%`, status: 'available', unit: '%' },
        condition: null,
        comparison: { basis: sectorPeers.length >= 5 ? 'sector33_median' : 'major_category_median', label: '比較群75 percentile', value: round(p75), formatted: `${p75.toFixed(1)}%`, delta: round(ratio - p75), deltaFormatted: `+${(ratio - p75).toFixed(1)}pt`, percentile: null, sampleSize: peerRatios.length },
        source: servingSource(row, 'netDebt'),
      } })
    }
  }
  if (row.pms != null && row.pms < -0.005) {
    const comparison: ScreenerReasonComparison = { basis: 'zero', label: '中立値 0', value: 0, formatted: '0', delta: round(row.pms), deltaFormatted: row.pms.toFixed(2), percentile: null, sampleSize: null }
    candidates.push({ score: 84, item: comparisonItem(row, 'pms', comparison, `PMS ${row.pms.toFixed(2)}（0未満）`, 'caution') })
  }
  if (row.sectorRank != null && sectorCount >= 4 && row.sectorRank > Math.floor(sectorCount * 0.75)) {
    const comparison: ScreenerReasonComparison = { basis: 'sector_rank', label: '33業種構造順位', value: row.sectorRank, formatted: `${row.sectorRank}位`, delta: null, deltaFormatted: null, percentile: round(100 * row.sectorRank / sectorCount, 1), sampleSize: sectorCount }
    candidates.push({ score: 72, item: comparisonItem(row, 'sectorRank', comparison, `33業種の構造順位は${row.sectorRank}位 / ${sectorCount}業種`, 'caution') })
  }
  if (row.latestForecastRevisionDirection === 'down' && row.latestForecastRevisionRate != null) {
    const comparison: ScreenerReasonComparison = { basis: 'forecast_revision', label: '前回会社予想', value: null, formatted: null, delta: round(row.latestForecastRevisionRate), deltaFormatted: `${row.latestForecastRevisionRate.toFixed(1)}%`, percentile: null, sampleSize: null }
    candidates.push({ score: 90, item: comparisonItem(row, 'latestForecastRevisionRate', comparison, `最新会社予想は前回比 ${row.latestForecastRevisionRate.toFixed(1)}%`, 'caution') })
  }
  const payoutComparison = peerComparison(row, 'payoutRatio', sectorPeers, majorPeers)
  if (payoutComparison?.percentile != null && payoutComparison.percentile >= 75 && row.payoutRatio != null && row.payoutRatio > 0) {
    candidates.push({ score: 68, item: comparisonItem(row, 'payoutRatio', payoutComparison, `配当性向 ${row.payoutRatio.toFixed(1)}%、比較群の上位25%`, 'caution') })
  }
  for (const [metric, percentileMetric] of [['per', 'perPercentile5y'], ['pbr', 'pbrPercentile5y']] as const) {
    const value = asNumber(row[metric])
    const percentileValue = asNumber(row[percentileMetric])
    if (value == null || percentileValue == null || percentileValue < 75) continue
    const comparison: ScreenerReasonComparison = { basis: 'self_5y_percentile', label: '自社5年分布', value: null, formatted: null, delta: null, deltaFormatted: null, percentile: round(percentileValue, 1), sampleSize: null }
    candidates.push({ score: 64 + percentileValue / 10, item: comparisonItem(row, metric, comparison, `${SCREENING_METRIC_MAP.get(metric)!.label} ${formatMetric(metric, value)} / 自社5年分布の${percentileValue.toFixed(1)} percentile`, 'caution', ':self') })
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 3).map((candidate) => candidate.item)
}

export async function getScreenerReason(input: {
  ticker: string
  asOf?: string | null
  conditions: ScreeningCondition[]
}): Promise<ScreenerReasonContract | null> {
  const startedAt = Date.now()
  const ticker = input.ticker.trim()
  const conditions = input.conditions.slice(0, 40)
  const requestedAsOf = isoDate(input.asOf)
  const cacheKey = JSON.stringify({ ticker, asOf: requestedAsOf, conditions })
  const cached = reasonCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value, elapsedMs: Date.now() - startedAt, cacheHit: true }
  const data = await getIntegratedScreeningReasonData(ticker, requestedAsOf)
  if (!data) return null
  const auxiliary = await loadAuxiliaryFacts(ticker, data.serving.asOf)
  const matchedConditions = conditions.map((condition) => matchedConditionItem(data.row, condition)).filter((item): item is ScreenerReasonItem => item != null)
  const excluded = new Set(conditions.map((condition) => condition.metric))
  const contract: ScreenerReasonContract = {
    contractVersion: 'screener-reason-v1', ticker: data.row.ticker, name: data.row.name,
    asOf: data.serving.asOf, snapshotDate: data.row.snapshotDate, valuationDate: data.row.valuationDate,
    classifications: { sector33: data.row.sector33, majorCategory: data.row.majorCategory, subIndustry: data.row.subIndustry },
    matchedConditions,
    supportingFacts: supportingFacts(data.row, data.sector33Peers, data.majorCategoryPeers, excluded, data.sectorCount),
    cautions: cautions(data.row, data.sector33Peers, data.majorCategoryPeers, auxiliary, data.sectorCount),
    generatedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, cacheHit: false,
    disclaimer: '構造化データに基づく事実説明です。投資推奨、売買判断、目標株価ではありません。',
  }
  reasonCache.set(cacheKey, { expiresAt: Date.now() + REASON_CACHE_TTL_MS, value: contract })
  return contract
}
