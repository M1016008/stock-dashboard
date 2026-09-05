import { ASSISTANT_REQUEST_TIMEOUT_MS, getAssistantOpenAIConfig } from '@/lib/assistant/config'
import { SCREENING_METRICS, SCREENING_PRESETS } from '@/lib/integrated-screener'
import {
  interpretNaturalLanguageLocally,
  normalizeNaturalLanguageInterpretation,
  type RawNaturalLanguageInterpretation,
  type ScreenerNaturalLanguageProposal,
} from '@/lib/screener-natural-language'

const MAX_OUTPUT_TOKENS = 1_400

function usableApiKey(value: string | null): value is string {
  return value != null && /^sk-[\x21-\x7e]+$/.test(value)
}

function extractOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as { output_text?: unknown; output?: Array<{ content?: Array<{ text?: unknown }> }> }
  if (typeof root.output_text === 'string') return root.output_text.trim()
  const parts: string[] = []
  for (const item of root.output ?? []) {
    for (const content of item.content ?? []) if (typeof content.text === 'string') parts.push(content.text)
  }
  return parts.join('\n').trim() || null
}

function fallbackProposal(query: string, startedAt: number): ScreenerNaturalLanguageProposal {
  return normalizeNaturalLanguageInterpretation({
    query,
    raw: interpretNaturalLanguageLocally(query),
    source: 'fallback',
    model: null,
    elapsedMs: Date.now() - startedAt,
  })
}

function metricCatalog(): string {
  return JSON.stringify(SCREENING_METRICS.map((metric) => ({
    metric: metric.key,
    label: metric.label,
    category: metric.category,
    valueType: metric.valueType,
    unit: metric.unit ?? null,
    operators: metric.operators,
    options: metric.options?.map((option) => option.value) ?? null,
  })))
}

function presetCatalog(): string {
  return JSON.stringify(SCREENING_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    conditions: preset.conditions,
  })))
}

export async function interpretScreenerNaturalLanguage(query: string, options?: { forceFallback?: boolean }): Promise<ScreenerNaturalLanguageProposal> {
  const startedAt = Date.now()
  const normalizedQuery = query.trim().slice(0, 500)
  const config = getAssistantOpenAIConfig()
  if (options?.forceFallback || !usableApiKey(config.apiKey) || !config.model) return fallbackProposal(normalizedQuery, startedAt)

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(ASSISTANT_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: config.model,
        store: false,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        input: [
          {
            role: 'system',
            content: [{
              type: 'input_text',
              text: [
                'あなたはStockBoard統合スクリーナーの条件候補作成器です。自然言語を登録済み条件へ変換することだけを担当します。',
                '銘柄検索、財務計算、PIT判定、ランキング、理由生成、投資判断は絶対に行いません。',
                '出力した条件はまだ検索されません。ユーザーが画面で確認・修正してから実行します。',
                'metric、operator、enumは下記カタログに存在するものだけを使ってください。存在しない概念を近い指標へ置換しないでください。',
                '「高い」「割安」「大型」「成長」「高配当」「構造が強い」などの曖昧語は、推奨閾値を条件候補として出し、assumptionsに用語と解釈を必ず明記してください。',
                '推奨解釈: ROEが高い=roe >= 10、割安=forwardPer <= 15かつpbr <= 1.5、大型株=marketCap >= 500000000000、成長=revenueGrowth >= 10かつepsGrowth >= 10、高配当=forecastDividendYield >= 3、業種構造が強い=sectorStructureScore >= 70かつpms > 0、週足上向き=weeklyAStage = 2。',
                'ユーザーが明示した数値は推奨閾値より優先してください。%指標は10%=10、時価総額は円、Stageは1〜6で出力してください。',
                '「社長が優秀」「ブランド力」など未対応概念はconditionsへ入れず、unsupportedConceptsに「現在の構造化スクリーナーでは直接条件化できない」と記録してください。',
                '入力が曖昧すぎて条件を1つも作れない場合はconditionsを空にし、clarificationQuestionsを1〜3件返してください。',
                `METRIC_CATALOG=${metricCatalog()}`,
                `PRESET_CATALOG=${presetCatalog()}`,
              ].join('\n'),
            }],
          },
          { role: 'user', content: [{ type: 'input_text', text: normalizedQuery }] },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'stockboard_screener_conditions',
            strict: false,
            schema: {
              type: 'object',
              properties: {
                conditions: {
                  type: 'array', maxItems: 12,
                  items: {
                    type: 'object',
                    properties: {
                      metric: { type: 'string', enum: SCREENING_METRICS.map((metric) => metric.key) },
                      operator: { type: 'string', enum: ['gte', 'gt', 'lte', 'lt', 'eq', 'between', 'in', 'has_data'] },
                      value: {
                        anyOf: [
                          { type: 'number' }, { type: 'string' }, { type: 'boolean' }, { type: 'null' },
                          { type: 'array', items: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'boolean' }] } },
                        ],
                      },
                      valueTo: { anyOf: [{ type: 'number' }, { type: 'null' }] },
                    },
                    required: ['metric', 'operator'],
                    additionalProperties: false,
                  },
                },
                assumptions: {
                  type: 'array', maxItems: 8,
                  items: {
                    type: 'object',
                    properties: {
                      term: { type: 'string' },
                      interpretation: { type: 'string' },
                      conditionMetrics: { type: 'array', maxItems: 6, items: { type: 'string', enum: SCREENING_METRICS.map((metric) => metric.key) } },
                    },
                    required: ['term', 'interpretation', 'conditionMetrics'],
                    additionalProperties: false,
                  },
                },
                unsupportedConcepts: {
                  type: 'array', maxItems: 6,
                  items: {
                    type: 'object',
                    properties: { text: { type: 'string' }, reason: { type: 'string' } },
                    required: ['text', 'reason'],
                    additionalProperties: false,
                  },
                },
                clarificationQuestions: { type: 'array', maxItems: 3, items: { type: 'string' } },
              },
              required: ['conditions', 'assumptions', 'unsupportedConcepts', 'clarificationQuestions'],
              additionalProperties: false,
            },
          },
        },
      }),
    })
    if (!response.ok) return fallbackProposal(normalizedQuery, startedAt)
    const output = extractOutputText(await response.json())
    if (!output) return fallbackProposal(normalizedQuery, startedAt)
    let raw: RawNaturalLanguageInterpretation
    try {
      raw = JSON.parse(output) as RawNaturalLanguageInterpretation
    } catch {
      return fallbackProposal(normalizedQuery, startedAt)
    }
    const proposal = normalizeNaturalLanguageInterpretation({
      query: normalizedQuery, raw, source: 'openai', model: config.model, elapsedMs: Date.now() - startedAt,
    })
    if (proposal.conditions.length === 0 && proposal.validationErrors.length > 0 && proposal.unsupportedConcepts.length === 0 && proposal.clarificationQuestions.length === 0) {
      return fallbackProposal(normalizedQuery, startedAt)
    }
    return proposal
  } catch {
    return fallbackProposal(normalizedQuery, startedAt)
  }
}
