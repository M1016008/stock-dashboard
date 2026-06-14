import type {
  AssistantChatResponse,
  AssistantPageContext,
  AssistantPlan,
  AssistantOpenAIStatus,
  AssistantPlannedToolCall,
  AssistantSource,
  AssistantToolName,
  AssistantToolResult,
} from '@/lib/assistant/types'
import {
  ASSISTANT_MAX_OUTPUT_TOKENS,
  ASSISTANT_REQUEST_TIMEOUT_MS,
  assistantOpenAIStatusFromConfig,
  getAssistantOpenAIConfig,
} from '@/lib/assistant/config'
import {
  assistantToolDescriptions,
  buildNavigateActions,
  describeResults,
  runAssistantTool,
} from '@/lib/assistant/tools'

const TOOL_NAMES: AssistantToolName[] = [
  'search_stocks',
  'get_stock_overview',
  'screen_jp_stocks',
  'get_ml_similars',
  'get_earnings_candidates',
]

function extractOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as { output_text?: unknown; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }
  if (typeof root.output_text === 'string') return root.output_text
  for (const item of root.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') return content.text
    }
  }
  return null
}

function normalizeTicker(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const ticker = value.trim().toUpperCase().replace(/\.T$/i, '')
  return /^[0-9A-Z]{1,8}$/.test(ticker) ? ticker : null
}

function tickerFromContext(context: AssistantPageContext): string | null {
  const explicit = normalizeTicker(context.ticker)
  if (explicit) return explicit
  const match = context.pathname?.match(/^\/stock\/([^/?#]+)/)
  return normalizeTicker(match?.[1])
}

function numberFromText(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      const value = Number(match[1].replace(/,/g, ''))
      if (Number.isFinite(value)) return value
    }
  }
  return null
}

function volumeThresholdFromText(text: string): number | null {
  const match = text.match(/(?:平均出来高|出来高)[^\d０-９]{0,12}([0-9,]+)\s*(万株|万|株|以上)/)
  if (!match?.[1]) return null
  const value = Number(match[1].replace(/,/g, ''))
  if (!Number.isFinite(value)) return null
  return match[2]?.startsWith('万') ? value * 10000 : value
}

function fallbackPlan(message: string, context: AssistantPageContext): AssistantPlan {
  const lower = message.toLowerCase()
  const contextTicker = tickerFromContext(context)
  const ticker = normalizeTicker(message.match(/\b([0-9]{4}|[0-9]{3}A|[A-Z]{1,5})\b/i)?.[1]) ?? contextTicker
  const wantsSimilar = /似た|類似|同じ形|近い/.test(message)
  const wantsEarnings = /決算|発表/.test(message)
  const wantsDown = /下落|悪化|警戒|空売り|ショート|売り/.test(message)
  const wantsUp = /上昇|好転|買い|強い|押し目/.test(message)
  const wantsSearch = /探して|検索|どこ|銘柄/.test(message)
  const universe = /日経\s*225|nikkei|n225/i.test(message) || context.universe === 'nikkei225' ? 'nikkei225' : null
  const marginType = /貸借/.test(message) ? '貸借' : /信用/.test(message) ? '信用' : null
  const minAvgVolume = volumeThresholdFromText(message)
  const limit = numberFromText(message, [/([0-9]{1,2})\s*件/]) ?? 10
  const calls: AssistantPlannedToolCall[] = []

  if (ticker && wantsSimilar) calls.push({ tool: 'get_ml_similars', ticker, limit })
  if (ticker && !wantsSimilar && !wantsEarnings && !wantsSearch) calls.push({ tool: 'get_stock_overview', ticker })
  if (wantsEarnings) calls.push({ tool: 'get_earnings_candidates', daysAhead: 14, universe, marginType, minAvgVolume, limit, sort: 'earnings_date' })
  if (wantsDown || wantsUp || /スクリーナ|候補|抽出|条件/.test(message)) {
    calls.push({
      tool: 'screen_jp_stocks',
      direction: wantsDown ? 'down' : wantsUp ? 'up' : 'neutral',
      universe,
      marginType,
      minAvgVolume,
      limit,
      horizonDays: /60/.test(message) ? 60 : /40/.test(message) ? 40 : 20,
      sort: wantsDown || wantsUp ? 'ml' : 'volume',
    })
  }
  if (ticker && calls.length === 0) calls.push({ tool: 'search_stocks', query: ticker, limit: 8 })
  if (calls.length === 0) calls.push({ tool: 'search_stocks', query: message.slice(0, 32), limit: 8 })

  return {
    intent: lower.includes('us') ? 'US株は初期MVPでは日本株中心の読み取りにフォールバックします。' : '自然文から読み取り専用ツールを選択しました。',
    toolCalls: calls.slice(0, 4),
  }
}

function normalizePlan(value: unknown, fallback: AssistantPlan): AssistantPlan {
  if (!value || typeof value !== 'object') return fallback
  const raw = value as Partial<AssistantPlan>
  const toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls : []
  const normalized = toolCalls
    .filter((call): call is AssistantPlannedToolCall => {
      if (!call || typeof call !== 'object') return false
      return TOOL_NAMES.includes((call as AssistantPlannedToolCall).tool)
    })
    .slice(0, 4)
    .map((call) => ({
      ...call,
      limit: call.limit == null ? null : Math.min(30, Math.max(1, Number(call.limit))),
      ticker: normalizeTicker(call.ticker) ?? call.ticker ?? null,
      universe: call.universe === 'nikkei225' ? 'nikkei225' : null,
      direction: (call.direction === 'down' || call.direction === 'neutral' || call.direction === 'up')
        ? call.direction
        : null,
    } satisfies AssistantPlannedToolCall))
  return {
    intent: typeof raw.intent === 'string' && raw.intent.trim() ? raw.intent : fallback.intent,
    toolCalls: normalized.length > 0 ? normalized : fallback.toolCalls,
  }
}

async function planWithOpenAI(message: string, context: AssistantPageContext, fallback: AssistantPlan): Promise<{ plan: AssistantPlan; source: AssistantSource; model: string | null; openai: AssistantOpenAIStatus }> {
  const config = getAssistantOpenAIConfig()
  if (!config.apiKey || !config.model) {
    return {
      plan: fallback,
      source: 'fallback',
      model: null,
      openai: assistantOpenAIStatusFromConfig(config),
    }
  }

  const { apiKey, model } = config
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: ASSISTANT_MAX_OUTPUT_TOKENS,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: [
                  'あなたはStockBoardの読み取り専用AIルーターです。',
                  'ユーザーの自然文から、登録済みツールを最大4つ選びます。',
                  'DB更新、管理画面操作、発注、バッチ実行は絶対に選ばないでください。',
                  '日本株中心の初期MVPです。US株/コモディティは明示された場合でも、まず検索や日本株ツールに限定して安全に返します。',
                  assistantToolDescriptions,
                ].join('\n'),
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify({ message, pageContext: context }),
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'stockboard_assistant_plan',
            strict: false,
            schema: {
              type: 'object',
              properties: {
                intent: { type: 'string' },
                toolCalls: {
                  type: 'array',
                  maxItems: 4,
                  items: {
                    type: 'object',
                    properties: {
                      tool: { type: 'string', enum: TOOL_NAMES },
                      query: { type: ['string', 'null'] },
                      ticker: { type: ['string', 'null'] },
                      direction: { type: ['string', 'null'], enum: ['up', 'down', 'neutral', null] },
                      universe: { type: ['string', 'null'], enum: ['nikkei225', null] },
                      limit: { type: ['number', 'null'] },
                      horizonDays: { type: ['number', 'null'] },
                      daysAhead: { type: ['number', 'null'] },
                      marginType: { type: ['string', 'null'] },
                      minAvgVolume: { type: ['number', 'null'] },
                      stageCode: { type: ['string', 'null'] },
                      sector17: { type: ['string', 'null'] },
                      sort: { type: ['string', 'null'], enum: ['ml', 'volume', 'change', 'earnings_date', null] },
                    },
                    required: ['tool'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['intent', 'toolCalls'],
              additionalProperties: false,
            },
          },
        },
      }),
      signal: AbortSignal.timeout(ASSISTANT_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      return {
        plan: fallback,
        source: 'fallback',
        model,
        openai: { enabled: true, configured: true, attempted: true, used: false, model, reason: 'api_error', statusCode: response.status },
      }
    }
    const text = extractOutputText(await response.json())
    if (!text) {
      return {
        plan: fallback,
        source: 'fallback',
        model,
        openai: { enabled: true, configured: true, attempted: true, used: false, model, reason: 'invalid_response' },
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        plan: fallback,
        source: 'fallback',
        model,
        openai: { enabled: true, configured: true, attempted: true, used: false, model, reason: 'parse_error' },
      }
    }
    return {
      plan: normalizePlan(parsed, fallback),
      source: 'openai',
      model,
      openai: { enabled: true, configured: true, attempted: true, used: true, model },
    }
  } catch {
    return {
      plan: fallback,
      source: 'fallback',
      model,
      openai: { enabled: true, configured: true, attempted: true, used: false, model, reason: 'request_failed' },
    }
  }
}

function followupsForResults(results: AssistantToolResult[]): string[] {
  const base = [
    '日経225だけに絞って',
    '貸借銘柄だけにして',
    '下落警戒候補も見せて',
    '出来高が多い順にして',
  ]
  if (results.some((result) => result.tool === 'get_stock_overview')) {
    return ['この銘柄に似た銘柄を探して', 'この銘柄の下落リスクを見て', ...base.slice(0, 2)]
  }
  if (results.some((result) => result.tool === 'get_earnings_candidates')) {
    return ['決算前で上昇候補だけにして', '平均出来高30万株以上にして', ...base.slice(0, 2)]
  }
  return base
}

export async function runAssistantChat(message: string, context: AssistantPageContext): Promise<AssistantChatResponse> {
  const trimmed = message.trim()
  const fallback = fallbackPlan(trimmed, context)
  const { plan, source, model, openai } = await planWithOpenAI(trimmed, context, fallback)
  const results: AssistantToolResult[] = []
  for (const call of plan.toolCalls) {
    results.push(await runAssistantTool(call))
  }
  const actions = buildNavigateActions(results)
  return {
    message: describeResults(results),
    source,
    model,
    openai,
    context,
    toolsUsed: Array.from(new Set(results.map((result) => result.tool))),
    sections: results,
    actions,
    followups: followupsForResults(results),
  }
}
