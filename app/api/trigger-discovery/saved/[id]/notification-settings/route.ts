import { NextRequest, NextResponse } from 'next/server'
import { SavedTriggerNotFoundError } from '@/lib/server/saved-trigger-definitions'
import {
  getTriggerNotificationSettings,
  updateTriggerNotificationSettings,
} from '@/lib/server/trigger-notification-settings'
import { SavedTriggerValidationError } from '@/lib/trigger-definition'
import {
  TRIGGER_NOTIFICATION_CONTRACT_VERSION,
  TriggerNotificationValidationError,
  type TriggerNotificationSettingsResponse,
} from '@/lib/trigger-notification'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = { params: Promise<{ id: string }> }

function errorResponse(error: unknown): NextResponse {
  if (error instanceof TriggerNotificationValidationError || error instanceof SavedTriggerValidationError) {
    return NextResponse.json({ error: 'invalid_notification_settings', message: error.message }, { status: 400 })
  }
  if (error instanceof SavedTriggerNotFoundError) {
    return NextResponse.json({ error: 'saved_trigger_not_found', message: error.message }, { status: 404 })
  }
  console.error('[trigger-discovery/notification-settings]', error)
  return NextResponse.json({
    error: 'notification_settings_failed',
    message: '通知設定を処理できませんでした。',
  }, { status: 500 })
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    const response: TriggerNotificationSettingsResponse = {
      contractVersion: TRIGGER_NOTIFICATION_CONTRACT_VERSION,
      settings: await getTriggerNotificationSettings(id),
    }
    return NextResponse.json(response, { headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' } })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    const response: TriggerNotificationSettingsResponse = {
      contractVersion: TRIGGER_NOTIFICATION_CONTRACT_VERSION,
      settings: await updateTriggerNotificationSettings(id, await request.json()),
    }
    return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'invalid_request', message: 'JSON形式が正しくありません。' }, { status: 400 })
    }
    return errorResponse(error)
  }
}
