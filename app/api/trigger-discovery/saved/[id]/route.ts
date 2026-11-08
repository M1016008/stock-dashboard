import { savedTriggerDetailHandlers } from '@/lib/server/trigger-discovery-routes'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const handlers = savedTriggerDetailHandlers('JP')

export const GET = handlers.GET
export const PATCH = handlers.PATCH
export const DELETE = handlers.DELETE
