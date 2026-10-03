import { NextRequest, NextResponse } from 'next/server'
import { getAssistantOpenAIConfig, ASSISTANT_REQUEST_TIMEOUT_MS } from '@/lib/assistant/config'
import { assistantOpenAIStatusFromConfig } from '@/lib/assistant/config'
import type { AssistantConversationMessage, AssistantOpenAIStatus, AssistantSource } from '@/lib/assistant/types'
import {
  buildStockScenarioProjection,
  type ProjectionResponse,
  type ScenarioInterval,
} from '@/lib/stock-scenarios/projections'
import { findTicker } from '@/lib/master/tickers'
import { normalizeMarket, normalizeTickerForMarket, type MarketCode } from '@/lib/markets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const STOCK_CHAT_HISTORY_LIMIT = 8

type StockChatBody = {
  ticker?: unknown
  market?: unknown
  name?: unknown
  message?: unknown
  analysisDate?: unknown
  history?: unknown
}

type StockChatProjectionSummary = {
  interval: ScenarioInterval
  horizonDays: number
  baseDate: string
  basePrice: number
  statusLabel: string
  sourceDates: ProjectionResponse['sourceDates']
  stats: ProjectionResponse['stats']
  scenarios: Array<{
    id: string
    label: string
    direction: string
    score: number
    relativeWeightPct: number
    targetPrice: number | null
    stopPrice: number | null
    invalidation: string
    evidence: string[]
    scoreBreakdown: ProjectionResponse['scenarios'][number]['scoreBreakdown']
  }>
}

type StockChatResponse = {
  ok: true
  message: string
  source: AssistantSource
  model: string | null
  openai: AssistantOpenAIStatus
  context: {
    ticker: string
    market: MarketCode
    name: string | null
    analysisDate: string | null
    projections: StockChatProjectionSummary[]
  }
  followups: string[]
}

function normalizeTicker(value: unknown, market: MarketCode): string | null {
  if (typeof value !== 'string') return null
  const ticker = normalizeTickerForMarket(value, market)
  return /^[0-9A-Z]{1,8}$/.test(ticker) ? ticker : null
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null
}

function normalizeHistory(value: unknown): AssistantConversationMessage[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item): AssistantConversationMessage | null => {
      if (!item || typeof item !== 'object') return null
      const raw = item as Record<string, unknown>
      const role = raw.role === 'user' || raw.role === 'assistant' ? raw.role : null
      const content = typeof raw.content === 'string' ? raw.content.trim().slice(0, 900) : ''
      if (!role || !content) return null
      return { role, content }
    })
    .filter((item): item is AssistantConversationMessage => item !== null)
    .slice(-STOCK_CHAT_HISTORY_LIMIT)
}

function extractOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as { output_text?: unknown; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }
  if (typeof root.output_text === 'string') return root.output_text.trim()
  const parts: string[] = []
  for (const item of root.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') parts.push(content.text)
    }
  }
  return parts.join('\n').trim() || null
}

function projectionSummary(projection: ProjectionResponse): StockChatProjectionSummary {
  return {
    interval: projection.interval,
    horizonDays: projection.horizonDays,
    baseDate: projection.baseDate,
    basePrice: projection.basePrice,
    statusLabel: projection.statusLabel,
    sourceDates: projection.sourceDates,
    stats: projection.stats,
    scenarios: projection.scenarios.slice(0, 4).map((scenario) => ({
      id: scenario.id,
      label: scenario.label,
      direction: scenario.direction,
      score: scenario.score,
      relativeWeightPct: scenario.relativeWeightPct,
      targetPrice: scenario.targetPrice,
      stopPrice: scenario.stopPrice,
      invalidation: scenario.invalidation,
      evidence: scenario.evidence.slice(0, 5),
      scoreBreakdown: scenario.scoreBreakdown,
    })),
  }
}

async function loadProjectionContext(ticker: string, market: MarketCode, analysisDate: string | null): Promise<StockChatProjectionSummary[]> {
  const projectionInputs: Array<{ interval: ScenarioInterval; horizonDays: number }> = [
    { interval: 'D', horizonDays: 5 },
    { interval: '2D', horizonDays: 10 },
    { interval: 'W', horizonDays: 20 },
    { interval: '2W', horizonDays: 40 },
    { interval: 'M', horizonDays: 60 },
    { interval: '2M', horizonDays: 120 },
  ]
  const projections = await Promise.all(
    projectionInputs.map((input) => (
      buildStockScenarioProjection({
        ticker,
        market,
        interval: input.interval,
        horizonDays: input.horizonDays,
        limit: 6,
        asOfDate: analysisDate,
      })
    )),
  )
  return projections
    .filter((projection): projection is ProjectionResponse => projection !== null)
    .map(projectionSummary)
}

function directionLabel(direction: string): string {
  if (direction === 'up') return '上昇'
  if (direction === 'down') return '下落'
  return '横ばい'
}

function formatPrice(value: number | null | undefined, market: MarketCode): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (market === 'US') return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  return `${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}円`
}

function localAnswer(input: {
  ticker: string
  market: MarketCode
  name: string | null
  analysisDate: string | null
  question: string
  projections: StockChatProjectionSummary[]
}): string {
  const primary = input.projections[0]
  if (!primary || primary.scenarios.length === 0) {
    return [
      `結論: ${input.ticker}のシナリオ説明に必要な価格・物理特徴量が不足しています。`,
      '根拠: シナリオ生成APIで有効な候補が返っていません。',
      '確認点: 価格データ、物理特徴量、PMS/PFS/PES、物理ML候補の鮮度を確認してください。',
    ].join('\n')
  }
  const top = primary.scenarios[0]
  const parts = top.scoreBreakdown
    .slice(0, 4)
    .map((part) => `${part.label} ${part.value}/${part.max}`)
    .join('、')
  const stats = primary.stats
  return [
    `結論: ${input.analysisDate ? `${input.analysisDate}時点では` : '現時点では'}、最上位は「${top.label}」です。方向は${directionLabel(top.direction)}、スコアは${top.score}/100です。`,
    `根拠: 物理状態は${primary.statusLabel}、PMS ${stats.pms ?? '-'} / PFS ${stats.pfs ?? '-'} / PES ${stats.pes ?? '-'}。スコア内訳は${parts || '未算出'}です。`,
    `シナリオ: 目標目処は${formatPrice(top.targetPrice, input.market)}、撤退/失効条件は「${top.invalidation}」。`,
    `注意点: これは${primary.baseDate}までの価格、物理モメンタム、MA状態、物理ML候補、過去検証からの読み取りです。将来の値動きを断定するものではありません。`,
    `次に見るべき点: ${top.evidence.slice(0, 3).join(' / ') || 'MA付近の反応、出来高、PFSの変化'}。`,
  ].join('\n')
}

async function answerWithOpenAI(input: {
  ticker: string
  market: MarketCode
  name: string | null
  analysisDate: string | null
  question: string
  history: AssistantConversationMessage[]
  projections: StockChatProjectionSummary[]
}): Promise<{ message: string; source: AssistantSource; model: string | null; openai: AssistantOpenAIStatus }> {
  const config = getAssistantOpenAIConfig()
  const baseStatus = assistantOpenAIStatusFromConfig(config)
  if (!config.apiKey || !config.model) {
    return {
      message: localAnswer(input),
      source: 'fallback',
      model: null,
      openai: baseStatus,
    }
  }

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(ASSISTANT_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: config.model,
        store: false,
        max_output_tokens: 900,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: [
                  'あなたはStockBoardの個別銘柄ページ内AIです。',
                  '回答は渡された銘柄データ、シナリオ、物理状態、PMS/PFS/PES、MA状態、物理ML候補、過去検証だけを根拠にしてください。',
                  'DBにない事実、ニュース、外部情報、未来価格を推測しないでください。',
                  '投資助言や断定予測ではなく、データとスタッツからの解釈として説明してください。',
                  '形式は日本語で、結論、根拠、注意点、見るべきライン/条件、次の確認ポイントを短く出してください。',
                  '過去日付が指定されている場合、その日付時点までのデータで見た当時のシナリオとして説明してください。',
                ].join('\n'),
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify({
                  ticker: input.ticker,
                  market: input.market,
                  name: input.name,
                  analysisDate: input.analysisDate,
                  question: input.question,
                  recentConversation: input.history,
                  projections: input.projections,
                }),
              },
            ],
          },
        ],
      }),
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      return {
        message: localAnswer(input),
        source: 'fallback',
        model: config.model,
        openai: { ...baseStatus, attempted: true, used: false, model: config.model, reason: 'api_error', statusCode: response.status },
      }
    }
    const text = extractOutputText(payload)
    if (!text) {
      return {
        message: localAnswer(input),
        source: 'fallback',
        model: config.model,
        openai: { ...baseStatus, attempted: true, used: false, model: config.model, reason: 'invalid_response' },
      }
    }
    return {
      message: text,
      source: 'openai',
      model: config.model,
      openai: { ...baseStatus, attempted: true, used: true, model: config.model },
    }
  } catch {
    return {
      message: localAnswer(input),
      source: 'fallback',
      model: config.model,
      openai: { ...baseStatus, attempted: true, used: false, model: config.model, reason: 'request_failed' },
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as StockChatBody | null
    const market = normalizeMarket(typeof body?.market === 'string' ? body.market : null)
    const ticker = normalizeTicker(body?.ticker, market)
    const question = typeof body?.message === 'string' ? body.message.trim() : ''
    if (!ticker) {
      return NextResponse.json({ error: 'ticker_required', message: '銘柄コードが必要です。' }, { status: 400 })
    }
    if (!question) {
      return NextResponse.json({ error: 'message_required', message: '質問を入力してください。' }, { status: 400 })
    }
    if (question.length > 1200) {
      return NextResponse.json({ error: 'message_too_long', message: '入力は1200文字以内にしてください。' }, { status: 400 })
    }

    const analysisDate = normalizeDate(body?.analysisDate)
    const fallbackName = market === 'JP' ? findTicker(ticker)?.name ?? null : null
    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : fallbackName
    const history = normalizeHistory(body?.history)
    const projections = await loadProjectionContext(ticker, market, analysisDate)
    const answered = await answerWithOpenAI({ ticker, market, name, analysisDate, question, history, projections })

    const response: StockChatResponse = {
      ok: true,
      message: answered.message,
      source: answered.source,
      model: answered.model,
      openai: answered.openai,
      context: {
        ticker,
        market,
        name,
        analysisDate,
        projections,
      },
      followups: [
        'このシナリオが崩れる条件を教えて',
        '短期と中期で見方が違う点を教えて',
        '下落シナリオが優勢になる条件を教えて',
      ],
    }
    return NextResponse.json(response)
  } catch (error) {
    console.error('stock chat assistant error:', error)
    return NextResponse.json(
      { error: 'stock_chat_failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
