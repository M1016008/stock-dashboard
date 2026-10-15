import { NextRequest, NextResponse } from 'next/server'
import {
  SAVED_TRIGGER_CONTRACT_VERSION,
  SavedTriggerValidationError,
  type SavedTriggerDetailResponse,
  type SavedTriggerListResponse,
} from '@/lib/trigger-definition'
import {
  createSavedTriggerDefinition,
  listSavedTriggerDefinitions,
} from '@/lib/server/saved-trigger-definitions'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET() {
  try {
    const response: SavedTriggerListResponse = {
      contractVersion: SAVED_TRIGGER_CONTRACT_VERSION,
      definitions: await listSavedTriggerDefinitions('US'),
    }
    return NextResponse.json(response, { headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' } })
  } catch (error) {
    console.error('[us/trigger-discovery/saved:list]', error)
    return NextResponse.json({ error: 'saved_trigger_list_failed', message: '保存済みTriggerを取得できませんでした。' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>
    const response: SavedTriggerDetailResponse = {
      contractVersion: SAVED_TRIGGER_CONTRACT_VERSION,
      definition: await createSavedTriggerDefinition({
        market: 'US',
        name: body.name,
        evaluationConfig: body.evaluationConfig,
        viewConfig: body.viewConfig,
      }),
    }
    return NextResponse.json(response, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'invalid_request', message: 'JSON形式が正しくありません。' }, { status: 400 })
    }
    if (error instanceof SavedTriggerValidationError) {
      return NextResponse.json({ error: 'invalid_saved_trigger', message: error.message }, { status: 400 })
    }
    console.error('[us/trigger-discovery/saved:create]', error)
    return NextResponse.json({ error: 'saved_trigger_create_failed', message: 'Trigger条件を保存できませんでした。' }, { status: 500 })
  }
}
