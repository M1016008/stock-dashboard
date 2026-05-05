// app/api/alert/notify/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { sendAlertMail, testMailConnection } from '@/lib/gmail-notify'
import type { Alert } from '@/types/alert'

export const dynamic = 'force-dynamic'

interface NotifyBody {
  alerts: Alert[]
  to: string
  type?: 'REALTIME' | 'DAILY_SUMMARY'
}

export async function GET() {
  // 接続テスト
  const ok = await testMailConnection()
  return NextResponse.json({
    configured: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
    connectionOk: ok,
  })
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as NotifyBody
    if (!body.alerts || !Array.isArray(body.alerts) || body.alerts.length === 0) {
      return NextResponse.json({ error: 'alerts is required (non-empty array)' }, { status: 400 })
    }
    if (!body.to) {
      return NextResponse.json({ error: 'to (email) is required' }, { status: 400 })
    }

    await sendAlertMail({
      to: body.to,
      alerts: body.alerts,
      type: body.type ?? 'REALTIME',
    })

    return NextResponse.json({ ok: true, sent: body.alerts.length })
  } catch (error) {
    console.error('Notify API error:', error)
    return NextResponse.json(
      { error: 'Failed to send notification', message: (error as Error).message },
      { status: 500 },
    )
  }
}
