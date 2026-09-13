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
  const startedAt = performance.now()
  try {
    const response: SavedTriggerListResponse = {
      contractVersion: SAVED_TRIGGER_CONTRACT_VERSION,
      definitions: await listSavedTriggerDefinitions(),
    }
    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'private, max-age=0, must-revalidate',
        'Server-Timing': `saved-trigger-list;dur=${(performance.now() - startedAt).toFixed(3)}`,
      },
    })
  } catch (error) {
    console.error('[trigger-discovery/saved:list]', error)
    return NextResponse.json({
      error: 'saved_trigger_list_failed',
      message: '保存済みTriggerを取得できませんでした。',
    }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const startedAt = performance.now()
  try {
    const body = await request.json() as Record<string, unknown>
    const response: SavedTriggerDetailResponse = {
      contractVersion: SAVED_TRIGGER_CONTRACT_VERSION,
      definition: await createSavedTriggerDefinition({
        name: body.name,
        evaluationConfig: body.evaluationConfig,
        viewConfig: body.viewConfig,
      }),
    }
    return NextResponse.json(response, {
      status: 201,
      headers: {
        'Cache-Control': 'no-store',
        'Server-Timing': `saved-trigger-create;dur=${(performance.now() - startedAt).toFixed(3)}`,
      },
    })
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'invalid_request', message: 'JSON形式が正しくありません。' }, { status: 400 })
    }
    if (error instanceof SavedTriggerValidationError) {
      return NextResponse.json({ error: 'invalid_saved_trigger', message: error.message }, { status: 400 })
    }
    console.error('[trigger-discovery/saved:create]', error)
    return NextResponse.json({
      error: 'saved_trigger_create_failed',
      message: 'Trigger条件を保存できませんでした。',
    }, { status: 500 })
  }
}
