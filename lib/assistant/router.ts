import type {
  AssistantChatResponse,
  AssistantConversationMessage,
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
  'scan_weekly_bearish_ma_breaks',
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

function shortTextList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
    .slice(0, maxItems)
}

function buildClarificationPlan(intent: string, questions: string[], interpretedConditions: string[] = []): AssistantPlan {
  return {
    intent,
    responseType: 'clarify',
    clarificationQuestions: questions.slice(0, 3),
    interpretedConditions,
    toolCalls: [],
  }
}

function isWeeklyBearishMaBreakRequest(message: string): boolean {
  const hasWeekly = /週足|週\s*足|weekly/i.test(message)
  const hasBearishCandle = /陰線|弱含み|弱い|下落|悪化|売り|ショート|下方向/.test(message)
  const hasMa5 = /(5|５)\s*週|週\s*(5|５)|5w|ma5/i.test(message)
  const hasMa10 = /(10|１０)\s*週|週\s*(10|１０)|10w|ma10/i.test(message)
  const hasBreak = /割り込|割れ|下抜|下回|上から下|下へ割/.test(message)
  return hasWeekly && hasBearishCandle && hasMa5 && hasMa10 && hasBreak
}

function buildWeeklyBearishMaBreakPlan(message: string, context: AssistantPageContext): AssistantPlan | null {
  if (!isWeeklyBearishMaBreakRequest(message)) return null
  const universe = /日経\s*225|nikkei|n225/i.test(message) || context.universe === 'nikkei225' ? 'nikkei225' : null
  const minAvgVolume = volumeThresholdFromText(message) ?? 1_000_000
  const limit = numberFromText(message, [/([0-9]{1,2})\s*件/]) ?? 20
  return {
    intent: '週足の陰線が5週線・10週線を上から下へ割り込む下落候補を、専用スキャンで抽出します。',
    responseType: 'results',
    interpretedConditions: [
      '日本株',
      '週足',
      '陰線',
      '5週移動平均線を上から下へ割り込み',
      '10週移動平均線を上から下へ割り込み',
      `20日平均出来高 ${Math.round(minAvgVolume).toLocaleString()}以上`,
      'PMS/PFSと物理ML下落候補を優先',
      ...(universe ? ['日経225'] : []),
    ],
    toolCalls: [{
      tool: 'scan_weekly_bearish_ma_breaks',
      direction: 'down',
      universe,
      minAvgVolume,
      limit,
      horizonDays: /60/.test(message) ? 60 : 20,
    }],
  }
}

function fallbackPlan(message: string, context: AssistantPageContext): AssistantPlan {
  const weeklyBearishPlan = buildWeeklyBearishMaBreakPlan(message, context)
  if (weeklyBearishPlan) return weeklyBearishPlan

  const lower = message.toLowerCase()
  const contextTicker = tickerFromContext(context)
  const explicitTicker = normalizeTicker(message.match(/\b([0-9]{4}|[0-9]{3}A|[A-Z]{1,5})\b/i)?.[1])
  const ticker = explicitTicker ?? contextTicker
  const wantsSimilar = /似た|類似|同じ形|近い/.test(message)
  const wantsEarnings = /決算|発表/.test(message)
  const wantsDown = /下落|悪化|警戒|空売り|ショート|売り/.test(message)
  const wantsUp = /上昇|好転|買い|強い|押し目|初動|動き出し|勢い/.test(message)
  const wantsSearch = /探して|検索|どこ|銘柄/.test(message)
  const wantsMomentum = /PMS|PFS|PES|物理|初動|動き出し|勢い|モメンタム/i.test(message)
  const wantsShortTerm = /短期|強気優勢|好転候補|下落警戒/.test(message)
  const universe = /日経\s*225|nikkei|n225/i.test(message) || context.universe === 'nikkei225' ? 'nikkei225' : null
  const marginType = /貸借/.test(message) ? '貸借' : /信用/.test(message) ? '信用' : null
  const minAvgVolume = volumeThresholdFromText(message)
  const limit = numberFromText(message, [/([0-9]{1,2})\s*件/]) ?? 10
  const calls: AssistantPlannedToolCall[] = []
  const interpretedConditions: string[] = []

  if (
    !explicitTicker &&
    /良さそう|おすすめ|有望|何かない|いい銘柄|候補を出して|探して/.test(message) &&
    !wantsUp &&
    !wantsDown &&
    !wantsEarnings &&
    !wantsMomentum &&
    !wantsShortTerm
  ) {
    return buildClarificationPlan(
      '銘柄候補を出すには、まず探し方を少しだけ具体化した方がデータに基づいた結果になります。',
      [
        '上昇候補、下落警戒、初動、決算前、どの観点で探しますか？',
        '対象は全市場、日経225、貸借銘柄、特定業種のどれにしますか？',
        '短期なら20営業日、中期なら60営業日のどちらを重視しますか？',
      ],
    )
  }

  if (ticker && wantsSimilar) calls.push({ tool: 'get_ml_similars', ticker, limit })
  if (ticker && !wantsSimilar && !wantsEarnings && !wantsSearch) calls.push({ tool: 'get_stock_overview', ticker })
  if (wantsEarnings) calls.push({ tool: 'get_earnings_candidates', daysAhead: 14, universe, marginType, minAvgVolume, limit, sort: 'earnings_date' })
  if (wantsDown || wantsUp || wantsMomentum || wantsShortTerm || /スクリーナ|候補|抽出|条件/.test(message)) {
    const direction = wantsDown ? 'down' : wantsUp ? 'up' : 'neutral'
    if (universe) interpretedConditions.push('日経225')
    if (marginType) interpretedConditions.push(marginType)
    if (minAvgVolume) interpretedConditions.push(`平均出来高 ${Math.round(minAvgVolume).toLocaleString()}以上`)
    if (wantsMomentum) interpretedConditions.push('PMS/PFSを重視')
    calls.push({
      tool: 'screen_jp_stocks',
      direction,
      universe,
      marginType,
      minAvgVolume,
      pfsMin: wantsMomentum && !wantsDown ? 0 : null,
      pmsTrend: wantsMomentum && !wantsDown ? 'rising' : null,
      limit,
      horizonDays: /60/.test(message) ? 60 : /40/.test(message) ? 40 : 20,
      sort: wantsMomentum ? 'pfs' : wantsShortTerm ? 'short_term' : wantsDown || wantsUp ? 'ml' : 'volume',
    })
  }
  if (ticker && calls.length === 0) calls.push({ tool: 'search_stocks', query: ticker, limit: 8 })
  if (calls.length === 0) calls.push({ tool: 'search_stocks', query: message.slice(0, 32), limit: 8 })

  return {
    intent: lower.includes('us') ? 'US株は初期MVPでは日本株中心の読み取りにフォールバックします。' : '自然文から読み取り専用ツールを選択しました。',
    responseType: 'results',
    interpretedConditions,
    toolCalls: calls.slice(0, 4),
  }
}

function enforceSpecializedPlan(message: string, context: AssistantPageContext, plan: AssistantPlan): AssistantPlan {
  const weeklyBearishPlan = buildWeeklyBearishMaBreakPlan(message, context)
  if (!weeklyBearishPlan) return plan
  if (plan.toolCalls.some((call) => call.tool === 'scan_weekly_bearish_ma_breaks')) {
    return {
      ...plan,
      responseType: 'results',
      interpretedConditions: Array.from(new Set([
        ...(weeklyBearishPlan.interpretedConditions ?? []),
        ...(plan.interpretedConditions ?? []),
      ])).slice(0, 8),
    }
  }
  return weeklyBearishPlan
}

function normalizePlan(value: unknown, fallback: AssistantPlan): AssistantPlan {
  if (!value || typeof value !== 'object') return fallback
  const raw = value as Partial<AssistantPlan>
  const toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls : []
  const responseType = raw.responseType === 'clarify' ? 'clarify' : 'results'
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
      pmsTrend: call.pmsTrend === 'rising' || call.pmsTrend === 'falling' ? call.pmsTrend : null,
    } satisfies AssistantPlannedToolCall))
  return {
    intent: typeof raw.intent === 'string' && raw.intent.trim() ? raw.intent : fallback.intent,
    responseType: responseType === 'clarify' ? 'clarify' : 'results',
    clarificationQuestions: shortTextList(raw.clarificationQuestions, 3),
    interpretedConditions: shortTextList(raw.interpretedConditions, 8),
    toolCalls: responseType === 'clarify' ? [] : normalized.length > 0 ? normalized : fallback.toolCalls,
  }
}

async function planWithOpenAI(message: string, context: AssistantPageContext, history: AssistantConversationMessage[], fallback: AssistantPlan): Promise<{ plan: AssistantPlan; source: AssistantSource; model: string | null; openai: AssistantOpenAIStatus }> {
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
                  'ユーザーの自然文から、登録済みツールを最大4つ選びます。結果は必ずStockBoardのDB/API取得結果を根拠にします。',
                  '条件が曖昧で候補抽出の軸が決まらない場合は responseType=clarify とし、ツールを呼ばず、1〜3個だけ確認質問を返してください。',
                  '抽象語は具体条件へ翻訳します。例: 初動=PFS/PMS上昇とステージ好転、勢い=PMS/PFS重視、弱い=下落警戒またはPMS低下。',
                  '週足の陰線が5週移動平均線・10週移動平均線を上から下へ割り込む条件は、必ず scan_weekly_bearish_ma_breaks を使ってください。screen_jp_stocks で代替しないでください。',
                  '十分に条件がある場合は responseType=results とし、interpretedConditions に解釈した条件を短く入れてください。',
                  'DB更新、管理画面操作、発注、バッチ実行は絶対に選ばないでください。',
                  '日本株中心の初期MVPです。US株/コモディティは明示された場合、未対応であることが分かる形で日本株ツールに無理に混ぜないでください。',
                  'DBにない事実や未取得の数値は推測しないでください。',
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
                text: JSON.stringify({ message, pageContext: context, recentConversation: history }),
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
                responseType: { type: 'string', enum: ['clarify', 'results'] },
                clarificationQuestions: {
                  type: 'array',
                  maxItems: 3,
                  items: { type: 'string' },
                },
                interpretedConditions: {
                  type: 'array',
                  maxItems: 8,
                  items: { type: 'string' },
                },
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
                      marketSegment: { type: ['string', 'null'] },
                      minAvgVolume: { type: ['number', 'null'] },
                      pmsMin: { type: ['number', 'null'] },
                      pfsMin: { type: ['number', 'null'] },
                      pesMin: { type: ['number', 'null'] },
                      pmsTrend: { type: ['string', 'null'], enum: ['rising', 'falling', null] },
                      shortTermCheck: { type: ['string', 'null'] },
                      stageCode: { type: ['string', 'null'] },
                      sector17: { type: ['string', 'null'] },
                      sort: { type: ['string', 'null'], enum: ['ml', 'volume', 'change', 'earnings_date', 'pms', 'pfs', 'short_term', null] },
                    },
                    required: ['tool'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['intent', 'responseType', 'toolCalls'],
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

function clarificationMessage(plan: AssistantPlan): string {
  const lead = plan.intent || '条件を少し具体化すると、DBに基づいた候補を出しやすくなります。'
  const questions = plan.clarificationQuestions ?? []
  if (questions.length === 0) return lead
  return `${lead} ${questions.join(' ')}`
}

export async function runAssistantChat(message: string, context: AssistantPageContext, history: AssistantConversationMessage[] = []): Promise<AssistantChatResponse> {
  const trimmed = message.trim()
  const fallback = fallbackPlan(trimmed, context)
  const deterministicPlan = buildWeeklyBearishMaBreakPlan(trimmed, context)
  if (deterministicPlan) {
    const config = getAssistantOpenAIConfig()
    const openai = assistantOpenAIStatusFromConfig(config)
    const results: AssistantToolResult[] = []
    for (const call of deterministicPlan.toolCalls) {
      results.push(await runAssistantTool(call))
    }
    return {
      responseType: 'results',
      message: describeResults(results),
      source: 'fallback',
      model: config.model,
      openai,
      context,
      interpretedConditions: deterministicPlan.interpretedConditions ?? [],
      clarificationQuestions: [],
      toolsUsed: Array.from(new Set(results.map((result) => result.tool))),
      sections: results,
      actions: buildNavigateActions(results),
      followups: followupsForResults(results),
    }
  }
  const { plan: rawPlan, source, model, openai } = await planWithOpenAI(trimmed, context, history, fallback)
  const plan = enforceSpecializedPlan(trimmed, context, rawPlan)

  if (plan.responseType === 'clarify') {
    const questions = plan.clarificationQuestions ?? []
    return {
      responseType: 'clarify',
      message: clarificationMessage(plan),
      source,
      model,
      openai,
      context,
      interpretedConditions: plan.interpretedConditions ?? [],
      clarificationQuestions: questions,
      toolsUsed: [],
      sections: [],
      actions: [],
      followups: questions.length > 0
        ? questions
        : ['上昇候補で探して', '下落警戒で探して', '初動重視で探して'],
    }
  }

  const results: AssistantToolResult[] = []
  for (const call of plan.toolCalls) {
    results.push(await runAssistantTool(call))
  }
  const actions = buildNavigateActions(results)
  return {
    responseType: 'results',
    message: describeResults(results),
    source,
    model,
    openai,
    context,
    interpretedConditions: plan.interpretedConditions ?? [],
    clarificationQuestions: [],
    toolsUsed: Array.from(new Set(results.map((result) => result.tool))),
    sections: results,
    actions,
    followups: followupsForResults(results),
  }
}
