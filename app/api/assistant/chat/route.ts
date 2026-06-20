import { NextRequest, NextResponse } from 'next/server'
import { runAssistantChat } from '@/lib/assistant/router'
import type { AssistantConversationMessage, AssistantPageContext } from '@/lib/assistant/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 20

type RateBucket = {
  count: number
  resetAt: number
}

const globalForAssistantRateLimit = globalThis as typeof globalThis & {
  stockboardAssistantRateLimit?: Map<string, RateBucket>
}

function rateLimitStore() {
  if (!globalForAssistantRateLimit.stockboardAssistantRateLimit) {
    globalForAssistantRateLimit.stockboardAssistantRateLimit = new Map()
  }
  return globalForAssistantRateLimit.stockboardAssistantRateLimit
}

function clientKey(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const realIp = request.headers.get('x-real-ip')?.trim()
  return forwarded || realIp || 'local'
}

function checkRateLimit(request: NextRequest): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now()
  const store = rateLimitStore()
  const key = clientKey(request)
  const bucket = store.get(key)
  if (!bucket || bucket.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return { allowed: true }
  }
  if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    }
  }
  bucket.count += 1
  return { allowed: true }
}

function normalizeContext(value: unknown): AssistantPageContext {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const market = raw.market === 'JP' || raw.market === 'US' || raw.market === 'COMMODITY' ? raw.market : null
  return {
    pathname: typeof raw.pathname === 'string' ? raw.pathname.slice(0, 240) : undefined,
    search: typeof raw.search === 'string' ? raw.search.slice(0, 500) : undefined,
    pageTitle: typeof raw.pageTitle === 'string' ? raw.pageTitle.slice(0, 120) : undefined,
    ticker: typeof raw.ticker === 'string' ? raw.ticker.slice(0, 16) : null,
    market,
    universe: typeof raw.universe === 'string' ? raw.universe.slice(0, 40) : null,
  }
}

function normalizeHistory(value: unknown): AssistantConversationMessage[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item): AssistantConversationMessage | null => {
      if (!item || typeof item !== 'object') return null
      const raw = item as Record<string, unknown>
      const role = raw.role === 'user' || raw.role === 'assistant' ? raw.role : null
      const content = typeof raw.content === 'string' ? raw.content.trim().slice(0, 800) : ''
      if (!role || !content) return null
      return { role, content }
    })
    .filter((item): item is AssistantConversationMessage => item !== null)
    .slice(-8)
}

export async function POST(request: NextRequest) {
  try {
    const rate = checkRateLimit(request)
    if (!rate.allowed) {
      return NextResponse.json(
        {
          error: 'rate_limited',
          message: `AIアシスタントへの送信が短時間に集中しています。${rate.retryAfterSeconds ?? 60}秒後に再試行してください。`,
        },
        {
          status: 429,
          headers: { 'Retry-After': String(rate.retryAfterSeconds ?? 60) },
        },
      )
    }
    const body = await request.json().catch(() => null) as { message?: unknown; context?: unknown; history?: unknown } | null
    const message = typeof body?.message === 'string' ? body.message.trim() : ''
    if (!message) {
      return NextResponse.json({ error: 'message_required', message: '質問または指示を入力してください。' }, { status: 400 })
    }
    if (message.length > 1200) {
      return NextResponse.json({ error: 'message_too_long', message: '入力は1200文字以内にしてください。' }, { status: 400 })
    }
    const response = await runAssistantChat(message, normalizeContext(body?.context), normalizeHistory(body?.history))
    return NextResponse.json(response)
  } catch (error) {
    console.error('assistant chat error:', error)
    return NextResponse.json(
      { error: 'assistant_failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
