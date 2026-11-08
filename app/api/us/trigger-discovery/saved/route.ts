import { savedTriggerCollectionHandlers } from '@/lib/server/trigger-discovery-routes'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const handlers = savedTriggerCollectionHandlers('US')

export const GET = handlers.GET
export const POST = handlers.POST
