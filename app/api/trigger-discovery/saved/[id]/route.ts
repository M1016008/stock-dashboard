import { NextRequest, NextResponse } from 'next/server'
import {
  SAVED_TRIGGER_CONTRACT_VERSION,
  SavedTriggerValidationError,
  type SavedTriggerDetailResponse,
} from '@/lib/trigger-definition'
import {
  SavedTriggerNotFoundError,
  archiveSavedTriggerDefinition,
  getSavedTriggerDefinition,
  updateSavedTriggerDefinition,
} from '@/lib/server/saved-trigger-definitions'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = { params: Promise<{ id: string }> }

function errorResponse(error: unknown, action: string): NextResponse {
  if (error instanceof SavedTriggerValidationError) {
    return NextResponse.json({ error: 'invalid_saved_trigger', message: error.message }, { status: 400 })
  }
  if (error instanceof SavedTriggerNotFoundError) {
    return NextResponse.json({ error: 'saved_trigger_not_found', message: error.message }, { status: 404 })
  }
  console.error(`[trigger-discovery/saved:${action}]`, error)
  return NextResponse.json({
    error: `saved_trigger_${action}_failed`,
    message: '保存済みTriggerを処理できませんでした。',
  }, { status: 500 })
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const startedAt = performance.now()
  try {
    const { id } = await context.params
    const response: SavedTriggerDetailResponse = {
      contractVersion: SAVED_TRIGGER_CONTRACT_VERSION,
      definition: await getSavedTriggerDefinition(id),
    }
    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'private, max-age=0, must-revalidate',
        'Server-Timing': `saved-trigger-read;dur=${(performance.now() - startedAt).toFixed(3)}`,
      },
    })
  } catch (error) {
    return errorResponse(error, 'read')
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const startedAt = performance.now()
  try {
    const { id } = await context.params
    const body = await request.json() as Record<string, unknown>
    const response: SavedTriggerDetailResponse = {
      contractVersion: SAVED_TRIGGER_CONTRACT_VERSION,
      definition: await updateSavedTriggerDefinition(id, {
        name: body.name,
        evaluationConfig: body.evaluationConfig,
        viewConfig: body.viewConfig,
      }),
    }
    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'no-store',
        'Server-Timing': `saved-trigger-update;dur=${(performance.now() - startedAt).toFixed(3)}`,
      },
    })
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'invalid_request', message: 'JSON形式が正しくありません。' }, { status: 400 })
    }
    return errorResponse(error, 'update')
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const startedAt = performance.now()
  try {
    const { id } = await context.params
    await archiveSavedTriggerDefinition(id)
    return NextResponse.json({
      contractVersion: SAVED_TRIGGER_CONTRACT_VERSION,
      id,
      archived: true,
    }, {
      headers: {
        'Cache-Control': 'no-store',
        'Server-Timing': `saved-trigger-archive;dur=${(performance.now() - startedAt).toFixed(3)}`,
      },
    })
  } catch (error) {
    return errorResponse(error, 'archive')
  }
}
