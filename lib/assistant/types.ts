export type AssistantToolName =
  | 'search_stocks'
  | 'get_stock_overview'
  | 'screen_jp_stocks'
  | 'get_ml_similars'
  | 'get_earnings_candidates'

export type AssistantSource = 'openai' | 'fallback'

export type AssistantOpenAIStatusReason =
  | 'disabled'
  | 'missing_api_key'
  | 'placeholder_api_key'
  | 'api_error'
  | 'invalid_response'
  | 'parse_error'
  | 'request_failed'

export interface AssistantOpenAIStatus {
  enabled: boolean
  configured: boolean
  attempted: boolean
  used: boolean
  model: string | null
  reason?: AssistantOpenAIStatusReason
  statusCode?: number
}

export interface AssistantPageContext {
  pathname?: string
  search?: string
  pageTitle?: string
  ticker?: string | null
  market?: 'JP' | 'US' | 'COMMODITY' | null
  universe?: string | null
}

export interface AssistantPlannedToolCall {
  tool: AssistantToolName
  query?: string | null
  ticker?: string | null
  direction?: 'up' | 'down' | 'neutral' | null
  universe?: 'nikkei225' | null
  limit?: number | null
  horizonDays?: number | null
  daysAhead?: number | null
  marginType?: string | null
  minAvgVolume?: number | null
  stageCode?: string | null
  sector17?: string | null
  sort?: 'ml' | 'volume' | 'change' | 'earnings_date' | null
}

export interface AssistantPlan {
  intent: string
  toolCalls: AssistantPlannedToolCall[]
}

export interface AssistantResultRow {
  ticker?: string
  name?: string | null
  href?: string
  date?: string | null
  price?: number | null
  changePct?: number | null
  volume?: number | null
  avgVolume30d?: number | null
  stageCode?: string | null
  sector17Name?: string | null
  sector33Name?: string | null
  marketSegment?: string | null
  marginType?: string | null
  rank?: number | null
  score?: number | null
  direction?: string | null
  reason?: string | null
}

export interface AssistantToolResult {
  tool: AssistantToolName
  title: string
  summary: string
  href?: string
  rows: AssistantResultRow[]
  meta?: Record<string, unknown>
}

export interface AssistantAction {
  type: 'navigate'
  label: string
  href: string
}

export interface AssistantChatResponse {
  message: string
  source: AssistantSource
  model: string | null
  openai: AssistantOpenAIStatus
  context: AssistantPageContext
  toolsUsed: AssistantToolName[]
  sections: AssistantToolResult[]
  actions: AssistantAction[]
  followups: string[]
}
