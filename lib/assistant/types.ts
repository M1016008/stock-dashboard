export type AssistantToolName =
  | 'search_stocks'
  | 'get_stock_overview'
  | 'screen_jp_stocks'
  | 'get_ml_similars'
  | 'get_earnings_candidates'

export type AssistantSource = 'openai' | 'fallback'

export type AssistantResponseType = 'clarify' | 'results'

export type AssistantConversationRole = 'user' | 'assistant'

export interface AssistantConversationMessage {
  role: AssistantConversationRole
  content: string
}

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
  marketSegment?: string | null
  minAvgVolume?: number | null
  pmsMin?: number | null
  pfsMin?: number | null
  pesMin?: number | null
  pmsTrend?: 'rising' | 'falling' | null
  shortTermCheck?: string | null
  stageCode?: string | null
  sector17?: string | null
  sort?: 'ml' | 'volume' | 'change' | 'earnings_date' | 'pms' | 'pfs' | 'short_term' | null
}

export interface AssistantPlan {
  intent: string
  responseType?: AssistantResponseType
  clarificationQuestions?: string[]
  interpretedConditions?: string[]
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
  physicalMomentumScore?: number | null
  physicalForceScore?: number | null
  physicalEnergyScore?: number | null
  shortTermCheckLabel?: string | null
  shortTermCheckScore?: number | null
  mlEvidenceSummary?: string | null
  modelEvidence?: AssistantModelEvidence[]
  direction?: string | null
  reason?: string | null
}

export interface AssistantModelEvidence {
  direction: 'up' | 'down'
  horizonDays: number
  evaluationDate?: string | null
  sampleCount?: number | null
  baselineHitRate?: number | null
  top60HitRate?: number | null
  top60AdverseRate?: number | null
  top60AvgDirectionalReturnPct?: number | null
  liftTop60VsBaseline?: number | null
  split?: string | null
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
  responseType: AssistantResponseType
  message: string
  source: AssistantSource
  model: string | null
  openai: AssistantOpenAIStatus
  context: AssistantPageContext
  interpretedConditions: string[]
  clarificationQuestions: string[]
  toolsUsed: AssistantToolName[]
  sections: AssistantToolResult[]
  actions: AssistantAction[]
  followups: string[]
}
