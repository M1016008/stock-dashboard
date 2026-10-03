import { NextRequest, NextResponse } from 'next/server'
import { interpretScreenerNaturalLanguage } from '@/lib/server/screener-natural-language'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 20
type RateBucket = { count: number; resetAt: number }
const globalForRateLimit = globalThis as typeof globalThis & { screenerInterpretRateLimit?: Map<string, RateBucket> }

function rateLimitStore(): Map<string, RateBucket> {
  if (!globalForRateLimit.screenerInterpretRateLimit) globalForRateLimit.screenerInterpretRateLimit = new Map()
  return globalForRateLimit.screenerInterpretRateLimit
}

function checkRateLimit(request: NextRequest): { allowed: boolean; retryAfter: number } {
  const key = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip')?.trim() || 'local'
  const now = Date.now()
  const bucket = rateLimitStore().get(key)
  if (!bucket || bucket.resetAt <= now) {
    rateLimitStore().set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return { allowed: true, retryAfter: 0 }
  }
  if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) }
  bucket.count += 1
  return { allowed: true, retryAfter: 0 }
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  try {
    const rate = checkRateLimit(request)
    if (!rate.allowed) return NextResponse.json({ error: 'rate_limited', message: `${rate.retryAfter}秒後に再試行してください。` }, { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } })
    const body = await request.json().catch(() => null) as { query?: unknown } | null
    const query = typeof body?.query === 'string' ? body.query.trim() : ''
    if (!query) return NextResponse.json({ error: 'query_required', message: '探したい銘柄の条件を入力してください。' }, { status: 400 })
    if (query.length > 500) return NextResponse.json({ error: 'query_too_long', message: '入力は500文字以内にしてください。' }, { status: 400 })
    const proposal = await interpretScreenerNaturalLanguage(query)
    return NextResponse.json(proposal, {
      headers: {
        'Cache-Control': 'private, max-age=0, must-revalidate',
        'Server-Timing': `screener-interpret;dur=${Date.now() - startedAt}`,
      },
    })
  } catch (error) {
    console.error('[integrated-screener-interpret]', error)
    return NextResponse.json({ error: 'interpret_failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
