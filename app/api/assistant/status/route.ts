import { NextResponse } from 'next/server'
import { getAssistantOpenAIConfig } from '@/lib/assistant/config'

export const dynamic = 'force-dynamic'

export async function GET() {
  const config = getAssistantOpenAIConfig()
  return NextResponse.json({
    enabled: config.enabled,
    configured: config.configured,
    model: config.configured ? config.model : null,
    reason: config.reason,
  })
}
