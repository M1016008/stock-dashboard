import {
  SCREENING_METRIC_MAP,
  SCREENING_PRESETS,
  type ScreeningCondition,
  type ScreeningMetricKey,
  type ScreeningOperator,
} from '@/lib/integrated-screener'

export type ScreenerNaturalLanguageSource = 'openai' | 'fallback'
export type ScreenerNaturalLanguageStatus = 'proposal' | 'clarification' | 'unsupported'

export interface ScreenerNaturalLanguageAssumption {
  term: string
  interpretation: string
  conditionMetrics: ScreeningMetricKey[]
}

export interface ScreenerUnsupportedConcept {
  text: string
  reason: string
}

export interface ScreenerConditionValidationError {
  index: number
  metric: string | null
  reason: string
}

export interface ScreenerNaturalLanguageProposal {
  contractVersion: 'screener-natural-language-v1'
  query: string
  status: ScreenerNaturalLanguageStatus
  conditions: ScreeningCondition[]
  assumptions: ScreenerNaturalLanguageAssumption[]
  unsupportedConcepts: ScreenerUnsupportedConcept[]
  clarificationQuestions: string[]
  matchedPresetIds: string[]
  validationErrors: ScreenerConditionValidationError[]
  source: ScreenerNaturalLanguageSource
  model: string | null
  elapsedMs: number
  disclaimer: string
}

export interface RawNaturalLanguageCondition {
  metric?: unknown
  operator?: unknown
  value?: unknown
  valueTo?: unknown
}

export interface RawNaturalLanguageInterpretation {
  conditions?: unknown
  assumptions?: unknown
  unsupportedConcepts?: unknown
  clarificationQuestions?: unknown
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && Math.abs(parsed) <= 1e18 ? parsed : null
}

function normalizedScalar(metric: ScreeningMetricKey, value: unknown): string | number | boolean | null {
  const definition = SCREENING_METRIC_MAP.get(metric)!
  if (definition.valueType === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 1 || value === 'true') return true
    if (value === 0 || value === 'false') return false
    return null
  }
  if (definition.valueType === 'text') {
    const text = typeof value === 'string' ? value.trim().slice(0, 120) : ''
    return text || null
  }
  const number = finiteNumber(value)
  if (number == null) return null
  if (definition.valueType === 'stage' && (!Number.isInteger(number) || number < 1 || number > 6)) return null
  return number
}

function optionAllowed(metric: ScreeningMetricKey, value: string | number | boolean): boolean {
  const options = SCREENING_METRIC_MAP.get(metric)?.options
  return !options || options.some((option) => String(option.value) === String(value))
}

export function validateNaturalLanguageConditions(value: unknown): {
  conditions: ScreeningCondition[]
  errors: ScreenerConditionValidationError[]
} {
  if (!Array.isArray(value)) return { conditions: [], errors: [{ index: -1, metric: null, reason: 'conditions must be an array' }] }
  const conditions: ScreeningCondition[] = []
  const errors: ScreenerConditionValidationError[] = []
  const seen = new Set<string>()
  for (const [index, item] of value.slice(0, 20).entries()) {
    if (!item || typeof item !== 'object') {
      errors.push({ index, metric: null, reason: 'condition must be an object' })
      continue
    }
    const raw = item as RawNaturalLanguageCondition
    const metric = typeof raw.metric === 'string' ? raw.metric as ScreeningMetricKey : null
    const definition = metric ? SCREENING_METRIC_MAP.get(metric) : null
    if (!metric || !definition) {
      errors.push({ index, metric: typeof raw.metric === 'string' ? raw.metric : null, reason: 'unknown metric' })
      continue
    }
    const operator = typeof raw.operator === 'string' ? raw.operator as ScreeningOperator : null
    if (!operator || !definition.operators.includes(operator)) {
      errors.push({ index, metric, reason: 'operator is not allowed for this metric' })
      continue
    }
    let condition: ScreeningCondition
    if (operator === 'has_data') {
      condition = { id: `nl-${index + 1}`, metric, operator }
    } else if (operator === 'between') {
      const first = normalizedScalar(metric, raw.value)
      const second = finiteNumber(raw.valueTo)
      if (typeof first !== 'number' || second == null) {
        errors.push({ index, metric, reason: 'between requires two numeric values' })
        continue
      }
      condition = { id: `nl-${index + 1}`, metric, operator, value: Math.min(first, second), valueTo: Math.max(first, second) }
    } else if (operator === 'in') {
      const rawValues = Array.isArray(raw.value) ? raw.value : []
      const values = rawValues.map((entry) => normalizedScalar(metric, entry)).filter((entry): entry is string | number => (typeof entry === 'string' || typeof entry === 'number') && optionAllowed(metric, entry))
      if (values.length === 0) {
        errors.push({ index, metric, reason: 'in requires at least one valid value' })
        continue
      }
      condition = { id: `nl-${index + 1}`, metric, operator, value: [...new Set(values)] }
    } else {
      const normalized = normalizedScalar(metric, raw.value)
      if (normalized == null || !optionAllowed(metric, normalized)) {
        errors.push({ index, metric, reason: 'value does not match the metric type or enum' })
        continue
      }
      condition = { id: `nl-${index + 1}`, metric, operator, value: normalized }
    }
    const signature = JSON.stringify({ metric: condition.metric, operator: condition.operator, value: condition.value, valueTo: condition.valueTo })
    if (seen.has(signature)) continue
    seen.add(signature)
    conditions.push(condition)
  }
  return { conditions, errors }
}

export function isCompleteScreeningCondition(condition: ScreeningCondition): boolean {
  return validateNaturalLanguageConditions([{ metric: condition.metric, operator: condition.operator, value: condition.value, valueTo: condition.valueTo }]).conditions.length === 1
}

function conditionSignature(condition: Omit<ScreeningCondition, 'id'> | ScreeningCondition): string {
  return JSON.stringify({ metric: condition.metric, operator: condition.operator, value: condition.value, valueTo: condition.valueTo })
}

export function matchedPresetIds(conditions: ScreeningCondition[]): string[] {
  const signatures = new Set(conditions.map(conditionSignature))
  return SCREENING_PRESETS.filter((preset) => preset.conditions.every((condition) => signatures.has(conditionSignature(condition)))).map((preset) => preset.id)
}

function cleanTextList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => typeof item === 'string' ? item.trim().slice(0, 180) : '').filter(Boolean).slice(0, limit)
}

function normalizeAssumptions(value: unknown, conditions: ScreeningCondition[]): ScreenerNaturalLanguageAssumption[] {
  if (!Array.isArray(value)) return []
  const validMetrics = new Set(conditions.map((condition) => condition.metric))
  return value.map((item): ScreenerNaturalLanguageAssumption | null => {
    if (!item || typeof item !== 'object') return null
    const raw = item as Record<string, unknown>
    const term = typeof raw.term === 'string' ? raw.term.trim().slice(0, 80) : ''
    const interpretation = typeof raw.interpretation === 'string' ? raw.interpretation.trim().slice(0, 180) : ''
    const conditionMetrics = Array.isArray(raw.conditionMetrics)
      ? raw.conditionMetrics.filter((metric): metric is ScreeningMetricKey => typeof metric === 'string' && validMetrics.has(metric as ScreeningMetricKey)).slice(0, 6)
      : []
    return term && interpretation ? { term, interpretation, conditionMetrics } : null
  }).filter((item): item is ScreenerNaturalLanguageAssumption => item != null).slice(0, 8)
}

function normalizeUnsupported(value: unknown): ScreenerUnsupportedConcept[] {
  if (!Array.isArray(value)) return []
  return value.map((item): ScreenerUnsupportedConcept | null => {
    if (!item || typeof item !== 'object') return null
    const raw = item as Record<string, unknown>
    const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, 100) : ''
    const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 180) : ''
    return text && reason ? { text, reason } : null
  }).filter((item): item is ScreenerUnsupportedConcept => item != null).slice(0, 6)
}

export function normalizeNaturalLanguageInterpretation(input: {
  query: string
  raw: RawNaturalLanguageInterpretation
  source: ScreenerNaturalLanguageSource
  model: string | null
  elapsedMs: number
}): ScreenerNaturalLanguageProposal {
  const validation = validateNaturalLanguageConditions(input.raw.conditions)
  const assumptions = normalizeAssumptions(input.raw.assumptions, validation.conditions)
  const unsupportedConcepts = normalizeUnsupported(input.raw.unsupportedConcepts)
  const clarificationQuestions = cleanTextList(input.raw.clarificationQuestions, 3)
  const status: ScreenerNaturalLanguageStatus = validation.conditions.length > 0
    ? 'proposal'
    : unsupportedConcepts.length > 0
      ? 'unsupported'
      : 'clarification'
  return {
    contractVersion: 'screener-natural-language-v1', query: input.query, status,
    conditions: validation.conditions, assumptions, unsupportedConcepts,
    clarificationQuestions: status === 'clarification' && clarificationQuestions.length === 0
      ? ['数値、業績、Valuation、配当、市場構造のうち、どの条件を重視しますか？']
      : clarificationQuestions,
    matchedPresetIds: matchedPresetIds(validation.conditions), validationErrors: validation.errors,
    source: input.source, model: input.model, elapsedMs: input.elapsedMs,
    disclaimer: '自然言語は条件候補の作成だけに使用します。検索は条件を確認して「この条件で検索」を押すまで実行されません。',
  }
}

type DraftCondition = Omit<ScreeningCondition, 'id'>

export function interpretNaturalLanguageLocally(query: string): RawNaturalLanguageInterpretation {
  const text = query.trim()
  const conditions: DraftCondition[] = []
  const assumptions: ScreenerNaturalLanguageAssumption[] = []
  const unsupportedConcepts: ScreenerUnsupportedConcept[] = []
  const seenMetrics = new Set<ScreeningMetricKey>()
  const add = (condition: DraftCondition) => {
    if (seenMetrics.has(condition.metric)) return
    seenMetrics.add(condition.metric)
    conditions.push(condition)
  }
  const assume = (term: string, interpretation: string, metrics: ScreeningMetricKey[]) => assumptions.push({ term, interpretation, conditionMetrics: metrics })
  const explicit = (pattern: RegExp): { value: number; context: string } | null => {
    const match = text.match(pattern)
    const value = match ? finiteNumber(match[1]) : null
    if (!match || value == null) return null
    const start = match.index ?? 0
    return { value, context: text.slice(start, start + match[0].length + 8) }
  }
  const comparisonOperator = (context: string, defaultOperator: 'gte' | 'lte'): 'gte' | 'lte' => {
    if (/以下|未満|以内/.test(context)) return 'lte'
    if (/以上|超|より高/.test(context)) return 'gte'
    return defaultOperator
  }

  const roe = explicit(/ROE[^0-9]{0,10}(\d+(?:\.\d+)?)\s*%?/i)
  if (roe) add({ metric: 'roe', operator: comparisonOperator(roe.context, 'gte'), value: roe.value })
  else if (/ROE.*(?:高|良)|高ROE/i.test(text)) {
    add({ metric: 'roe', operator: 'gte', value: 10 })
    assume('ROEが高い', 'ROE >= 10%を推奨閾値として提案', ['roe'])
  }

  const forwardPer = explicit(/(?:Forward|予想)\s*PER[^0-9]{0,8}(\d+(?:\.\d+)?)\s*倍?/i)
  const barePer = forwardPer == null ? explicit(/(?<!Forward\s)(?<!予想)PER[^0-9]{0,8}(\d+(?:\.\d+)?)\s*倍?/i) : null
  if (forwardPer) add({ metric: 'forwardPer', operator: comparisonOperator(forwardPer.context, 'lte'), value: forwardPer.value })
  if (barePer) add({ metric: 'per', operator: comparisonOperator(barePer.context, 'lte'), value: barePer.value })
  const pbr = explicit(/PBR[^0-9]{0,8}(\d+(?:\.\d+)?)\s*倍?/i)
  if (pbr) add({ metric: 'pbr', operator: comparisonOperator(pbr.context, 'lte'), value: pbr.value })
  if (/割安/.test(text)) {
    const added: ScreeningMetricKey[] = []
    if (!seenMetrics.has('forwardPer') && !seenMetrics.has('per')) { add({ metric: 'forwardPer', operator: 'lte', value: 15 }); added.push('forwardPer') }
    if (!seenMetrics.has('pbr')) { add({ metric: 'pbr', operator: 'lte', value: 1.5 }); added.push('pbr') }
    if (added.length > 0) assume('割安', 'Forward PER <= 15倍、PBR <= 1.5倍を候補として提案', added)
  }

  const marketCapOku = explicit(/時価総額[^0-9]{0,10}(\d+(?:\.\d+)?)\s*億円?/)
  if (marketCapOku) add({ metric: 'marketCap', operator: comparisonOperator(marketCapOku.context, 'gte'), value: marketCapOku.value * 1e8 })
  else if (/大型株|大型銘柄/.test(text)) {
    add({ metric: 'marketCap', operator: 'gte', value: 5e11 })
    assume('大型株', '時価総額 >= 5,000億円を推奨閾値として提案', ['marketCap'])
  }

  const revenueGrowth = explicit(/(?:売上|売上高)[^0-9]{0,12}(\d+(?:\.\d+)?)\s*%/)
  if (revenueGrowth) add({ metric: 'revenueGrowth', operator: comparisonOperator(revenueGrowth.context, 'gte'), value: revenueGrowth.value })
  else if (/(?:売上|売上高).*(?:伸|成長)/.test(text)) {
    add({ metric: 'revenueGrowth', operator: 'gte', value: 10 })
    assume('売上が伸びている', 'LTM売上成長率 >= 10%を推奨閾値として提案', ['revenueGrowth'])
  } else if (/成長(?:株|して|企業|銘柄)?/.test(text)) {
    add({ metric: 'revenueGrowth', operator: 'gte', value: 10 })
    add({ metric: 'epsGrowth', operator: 'gte', value: 10 })
    assume('成長', '成長株プリセットの売上成長率・EPS成長率 >= 10%を提案', ['revenueGrowth', 'epsGrowth'])
  }

  const dividendYield = explicit(/(?:配当(?:利回り)?)[^0-9]{0,8}(\d+(?:\.\d+)?)\s*%/)
  if (dividendYield) add({ metric: 'forecastDividendYield', operator: comparisonOperator(dividendYield.context, 'gte'), value: dividendYield.value })
  else if (/高配当/.test(text)) {
    add({ metric: 'forecastDividendYield', operator: 'gte', value: 3 })
    assume('高配当', '予想配当利回り >= 3%を推奨閾値として提案', ['forecastDividendYield'])
  }
  const increaseYears = explicit(/(\d+(?:\.\d+)?)\s*年以上[^。]*増配/)
    ?? explicit(/連続増配[^0-9]{0,8}(\d+(?:\.\d+)?)\s*年/)
  if (increaseYears) add({ metric: 'consecutiveIncreaseYears', operator: 'gte', value: Math.floor(increaseYears.value) })

  if (/週足.*(?:上向|上昇|好転)|週A.*(?:Stage\s*)?2/i.test(text)) {
    add({ metric: 'weeklyAStage', operator: 'eq', value: 2 })
    if (!/Stage\s*2|週A\s*=/.test(text)) assume('週足構造が上向き', '週A = Stage 2を構造初動の候補として提案', ['weeklyAStage'])
  }
  if (/業種構造.*(?:強|上昇)|構造が強い|構造上昇/.test(text)) {
    add({ metric: 'sectorStructureScore', operator: 'gte', value: 70 })
    add({ metric: 'pms', operator: 'gt', value: 0 })
    assume('業種構造が強い', '構造上昇プリセットの業種構造スコア >= 70、PMS > 0を提案', ['sectorStructureScore', 'pms'])
  }
  if (/Quality|クオリティ/i.test(text)) {
    add({ metric: 'roe', operator: 'gte', value: 10 })
    add({ metric: 'operatingMargin', operator: 'gte', value: 8 })
    add({ metric: 'standardFcf', operator: 'gt', value: 0 })
    assume('Quality', 'Quality株プリセットのROE、営業利益率、標準FCF条件を提案', ['roe', 'operatingMargin', 'standardFcf'])
  }

  for (const unsupported of [
    { pattern: /社長|経営者/, text: '経営者・社長の評価' },
    { pattern: /ブランド力|ブランドが(?:高|強)/, text: 'ブランド力' },
    { pattern: /優秀/, text: '人物・企業の優秀さ' },
  ]) {
    if (unsupported.pattern.test(text)) unsupportedConcepts.push({ text: unsupported.text, reason: '現在の構造化スクリーナーでは直接条件化できません。' })
  }
  const clarificationQuestions = conditions.length === 0 && unsupportedConcepts.length === 0
    ? ['ROE、成長率、PER、配当、市場構造など、重視する数値または状態を教えてください。']
    : []
  return { conditions, assumptions, unsupportedConcepts, clarificationQuestions }
}
