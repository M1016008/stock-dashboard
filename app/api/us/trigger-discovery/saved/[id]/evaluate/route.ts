import { savedTriggerEvaluateHandlers } from '@/lib/server/trigger-discovery-routes'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 120

const handlers = savedTriggerEvaluateHandlers('US')

export const POST = handlers.POST
