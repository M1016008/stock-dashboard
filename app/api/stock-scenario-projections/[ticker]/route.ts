import { NextRequest, NextResponse } from 'next/server'
import {
  buildStockScenarioProjection,
  defaultProjectionHorizon,
  normalizeProjectionInterval,
  type ProjectionResponse,
} from '@/lib/stock-scenarios/projections'
import { getAssistantOpenAIConfig } from '@/lib/assistant/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

type RouteContext = {
  params: Promise<{ ticker: string }>
}

type NarrativeStatus = {
  attempted: boolean
  used: boolean
  model: string | null
  reason?: string
}

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value ?? '')
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), max)
}

function extractOutputText(payload: unknown): string | null {
  const root = payload as { output_text?: unknown; output?: Array<{ content?: Array<{ text?: unknown }> }> }
  if (typeof root.output_text === 'string') return root.output_text
  const parts: string[] = []
  for (const item of root.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') parts.push(content.text)
    }
  }
  return parts.join('\n').trim() || null
}

function parseNarrativeJson(text: string): Record<string, string> {
  try {
    const parsed = JSON.parse(text) as { narratives?: Array<{ id?: string; narrative?: string }> }
    const map: Record<string, string> = {}
    for (const item of parsed.narratives ?? []) {
      if (item.id && item.narrative) map[item.id] = item.narrative
    }
    return map
  } catch {
    return {}
  }
}

async function withLlmNarratives(
  projection: ProjectionResponse,
  enabled: boolean,
): Promise<{ projection: ProjectionResponse; status: NarrativeStatus }> {
  const config = getAssistantOpenAIConfig()
  if (!enabled) {
    return { projection, status: { attempted: false, used: false, model: config.model, reason: 'disabled_by_query' } }
  }
  if (!config.apiKey || !config.model) {
    return { projection, status: { attempted: false, used: false, model: null, reason: config.reason ?? 'not_configured' } }
  }

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(4500),
      body: JSON.stringify({
        model: config.model,
        store: false,
        max_output_tokens: 700,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: [
                  'あなたはStockBoardのシナリオ説明だけを整えるアシスタントです。',
                  '価格、スコア、順位、方向、失効条件を変更してはいけません。',
                  '投資助言や断定予測ではなく、データとスタッツからの観察メモとして短く説明してください。',
                  '出力はJSONのみ。形式: {"narratives":[{"id":"...","narrative":"..."}]}',
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
                  ticker: projection.ticker,
                  interval: projection.interval,
                  horizonDays: projection.horizonDays,
                  baseDate: projection.baseDate,
                  basePrice: projection.basePrice,
                  statusLabel: projection.statusLabel,
                  scenarios: projection.scenarios.map((scenario) => ({
                    id: scenario.id,
                    label: scenario.label,
                    direction: scenario.direction,
                    score: scenario.score,
                    targetPrice: scenario.targetPrice,
                    stopPrice: scenario.stopPrice,
                    thesis: scenario.thesis,
                    invalidation: scenario.invalidation,
                    evidence: scenario.evidence,
                  })),
                }),
              },
            ],
          },
        ],
      }),
    })
    if (!response.ok) {
      return { projection, status: { attempted: true, used: false, model: config.model, reason: `http_${response.status}` } }
    }
    const payload = await response.json()
    const text = extractOutputText(payload)
    if (!text) return { projection, status: { attempted: true, used: false, model: config.model, reason: 'empty_response' } }
    const narratives = parseNarrativeJson(text)
    if (Object.keys(narratives).length === 0) {
      return { projection, status: { attempted: true, used: false, model: config.model, reason: 'parse_failed' } }
    }
    return {
      projection: {
        ...projection,
        scenarios: projection.scenarios.map((scenario) => ({
          ...scenario,
          narrative: narratives[scenario.id] ?? scenario.narrative,
        })),
      },
      status: { attempted: true, used: true, model: config.model },
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { projection, status: { attempted: true, used: false, model: config.model, reason } }
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { ticker } = await context.params
    const interval = normalizeProjectionInterval(request.nextUrl.searchParams.get('interval'))
    const defaultHorizon = defaultProjectionHorizon(interval)
    const horizonDays = parsePositiveInt(request.nextUrl.searchParams.get('horizonDays'), defaultHorizon, 180)
    const limit = parsePositiveInt(request.nextUrl.searchParams.get('limit'), 8, 8)
    const llmEnabled = request.nextUrl.searchParams.get('llm') !== '0' && process.env.SCENARIO_PROJECTION_LLM_ENABLED !== '0'
    const projection = await buildStockScenarioProjection({ ticker, interval, horizonDays, limit })
    if (!projection) {
      return NextResponse.json({ ok: true, ticker, interval, horizonDays, scenarios: [], message: '価格データがありません。' })
    }
    const enriched = await withLlmNarratives(projection, llmEnabled)
    return NextResponse.json({
      ...enriched.projection,
      llmNarrative: enriched.status,
    })
  } catch (error) {
    console.error('stock scenario projections API error:', error)
    return NextResponse.json(
      { ok: false, error: 'stock_scenario_projections_failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
